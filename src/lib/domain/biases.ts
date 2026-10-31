// 行为偏差规则（docs/design.md 第 5 节）。只用证据里程序算好的数字判定：
// 规则命中是事实，"属于偏差"是推断；数据不够时输出"无法判定"，不能输出"未命中"。

import { addDays, shDate } from "@/lib/time";
import { classify } from "./pit";
import { planAt } from "./plan";
import type { Evidence } from "./evidence";
import type { Episode, EpisodeTrade } from "./types";

export type BiasId = "B1" | "B2" | "B3" | "B4" | "B5" | "B6" | "B7" | "B8";
export type BiasOutcome = "hit" | "not_hit" | "undetermined";

export interface BiasResult {
  ruleId: BiasId;
  name: string;
  scope: "trade" | "episode" | "portfolio";
  outcome: BiasOutcome;
  tradeId?: string;
  episodeIds?: string[];
  /** 数据显示了什么（事实） */
  finding: string;
  /** 规则和阈值 */
  rule: string;
  evidenceIds: string[];
  /** 事后信息：只用来显示代价，不参与判定 */
  cost?: { text: string; evidenceIds: string[] };
  alternatives: string[];
  confidence: "high" | "mid" | "low";
  /** 需要 AI 读理由文本才能定论（B8） */
  needsAi?: boolean;
}

export const BIAS_META: Record<BiasId, { name: string; rule: string; alternatives: string[] }> = {
  B1: {
    name: "追涨",
    rule: "买入前 5 个交易日涨幅 ≥ 15%，或买入价创近 20 日收盘新高且 5 日涨幅 ≥ 8%",
    alternatives: ["可能是有意的趋势或突破策略，追高本身是策略的一部分", "可能有当时可知、但没写进理由的基本面信息"],
  },
  B2: {
    name: "追热点",
    rule: "买入前一交易日热股排名进前 20，或买入前 3 个交易日上过龙虎榜",
    alternatives: ["热度高也可能来自真实的基本面变化", "可能是有意的短线交易风格"],
  },
  B3: {
    name: "恐慌卖出",
    rule: "卖出前 3 个交易日跌幅 ≥ 10%",
    alternatives: ["可能是在执行事先设定的止损", "可能出现了改变判断的新信息"],
  },
  B4: {
    name: "处置效应",
    rule: "已平仓的亏损段平均持有天数 ≥ 盈利段的 1.5 倍（至少 4 段已平仓，盈亏各至少 1 段）",
    alternatives: ["样本少，可能是巧合", "亏损单可能本来就是按长线计划持有的"],
  },
  B5: {
    name: "过度交易",
    rule: "同一只股票 10 个交易日内买卖 ≥ 3 次",
    alternatives: ["可能是有计划的波段策略", "手续费占比低时影响有限"],
  },
  B6: {
    name: "锚定成本价",
    rule: "卖出前持仓最大浮亏 ≥ 15%，之后在成本价 ±2% 以内卖出",
    alternatives: ["可能是判断已经变化，只是恰好在成本附近离场", "可能有资金使用上的安排"],
  },
  B7: {
    name: "偏离计划",
    rule: "写了止损或目标时分开核对：收盘跌破止损线后超过 1 个交易日才卖；目标达到后回吐、卖出时比目标少 3 个百分点以上；没到目标就提前卖出、少赚 3 个百分点以上",
    alternatives: ["计划可能因为新信息而合理调整，但调整没有被记录下来"],
  },
  B8: {
    name: "选择性关注",
    rule: "买入前 10 天内有当时可知的负面信息，理由里没有提到",
    alternatives: ["可能考虑过，只是没写下来", "负面信息可能和这次的买入逻辑无关"],
  },
};

const byId = (items: Evidence[]) => new Map(items.map((e) => [e.id, e]));

/** B8 的候选：买入前 10 天内、当时可知、语气负面的新闻、公告、异动 */
export function isB8Negative(e: Evidence | undefined, decisionTs: number): boolean {
  return (
    !!e &&
    e.tone === "negative" &&
    (e.kind === "news" || e.kind === "notice" || e.kind === "anomaly") &&
    e.availableAt != null &&
    e.availableAt >= decisionTs - 10 * 86_400_000 &&
    classify(e, decisionTs) === "ex_ante"
  );
}

function result(ruleId: BiasId, scope: BiasResult["scope"], partial: Omit<BiasResult, "ruleId" | "name" | "rule" | "alternatives" | "scope">): BiasResult {
  const m = BIAS_META[ruleId];
  return { ruleId, name: m.name, rule: m.rule, alternatives: m.alternatives, scope, ...partial };
}

/**
 * 单个持仓段内的规则：B1 B2 B3 B6 B7 B8。
 * attentionGaps：没取到的新闻、异动、公告数据源。有缺口时找不到负面信息只能算"无法判定"
 */
export function episodeBiases(ep: Episode, items: Evidence[], attentionGaps: string[] = []): BiasResult[] {
  const ev = byId(items);
  const out: BiasResult[] = [];
  const buys = ep.trades.filter((t) => t.side === "buy");
  const sells = ep.trades.filter((t) => t.side === "sell");

  for (const t of buys) {
    // B1 追涨
    const r5 = ev.get(`calc:runup5:${t.id}`);
    const hi = ev.get(`calc:high20:${t.id}`);
    if (!r5 && !hi) {
      out.push(result("B1", "trade", { outcome: "undetermined", tradeId: t.id, finding: "买入前的行情不足 20 个交易日，无法判定", evidenceIds: [], confidence: "low" }));
    } else {
      const hitR5 = r5?.value != null && r5.value >= 15;
      const hitHi = hi?.value != null && hi.value >= 100 && r5?.value != null && r5.value >= 8;
      out.push(
        result("B1", "trade", {
          outcome: hitR5 || hitHi ? "hit" : "not_hit",
          tradeId: t.id,
          finding: [r5?.title, hi?.title].filter(Boolean).join("；"),
          evidenceIds: [r5?.id, hi?.id].filter((x): x is string => !!x),
          confidence: "high",
        }),
      );
    }

    // B2 追热点
    const hot = ev.get(`hot:${t.id}`);
    const lhb = ev.get(`lhb:${t.id}`);
    const hotHit = hot?.status === "ok" && hot.value != null && hot.value <= 20;
    const lhbHit = lhb?.status === "ok" && /上过龙虎榜/.test(lhb.title);
    const hotKnown = hot?.status === "ok";
    const lhbKnown = lhb?.status === "ok";
    out.push(
      result("B2", "trade", {
        outcome: hotHit || lhbHit ? "hit" : hotKnown && lhbKnown ? "not_hit" : "undetermined",
        tradeId: t.id,
        finding: [hot?.title, lhb?.title].filter(Boolean).join("；") || "热股排名和龙虎榜都没有取到",
        evidenceIds: [hot?.id, lhb?.id].filter((x): x is string => !!x),
        confidence: hotKnown && lhbKnown ? "high" : "mid",
      }),
    );

    // B8 选择性关注：规则先列出买入前 10 天内当时可知的负面信息，是否"没提到"交给 AI 判断
    const negatives = items.filter((e) => isB8Negative(e, t.ts));
    const gap = !negatives.length && attentionGaps.length > 0;
    out.push(
      result("B8", "trade", {
        outcome: negatives.length || gap ? "undetermined" : "not_hit",
        tradeId: t.id,
        finding: negatives.length
          ? `买入前 10 天内有 ${negatives.length} 条当时可知的负面信息，需要对照理由判断是否被忽略`
          : gap
            ? `${attentionGaps.join("、")}没有取到，无法确认买入前 10 天有没有负面信息`
            : "买入前 10 天内没有找到当时可知的负面信息",
        evidenceIds: negatives.slice(0, 12).map((e) => e.id),
        confidence: "low",
        needsAi: negatives.length > 0,
      }),
    );
  }

  for (const t of sells) {
    // B3 恐慌卖出
    const r3 = ev.get(`calc:runup3:${t.id}`);
    const after = ev.get(`calc:after10:${t.id}`);
    out.push(
      result("B3", "trade", {
        outcome: r3?.value == null ? "undetermined" : r3.value <= -10 ? "hit" : "not_hit",
        tradeId: t.id,
        finding: r3?.title ?? "卖出前的行情不足，无法判定",
        evidenceIds: r3 ? [r3.id] : [],
        cost: after ? { text: `（事后信息）${after.title}`, evidenceIds: [after.id] } : undefined,
        confidence: r3 ? "high" : "low",
      }),
    );

    // B6 锚定成本价：只看清仓的那笔
    if (t.positionAfter === 0) {
      const dd = ev.get(`calc:dd:${t.id}`);
      const vs = ev.get(`calc:vscost:${t.id}`);
      const known = dd?.value != null && vs?.value != null;
      const hit = known && (dd!.value as number) <= -15 && Math.abs(vs!.value as number) <= 2;
      out.push(
        result("B6", "episode", {
          outcome: known ? (hit ? "hit" : "not_hit") : "undetermined",
          tradeId: t.id,
          finding: [dd?.title, vs?.title].filter(Boolean).join("；") || "缺少持仓期间的行情，无法判定",
          evidenceIds: [dd?.id, vs?.id].filter((x): x is string => !!x),
          cost: after ? { text: `（事后信息）${after.title}`, evidenceIds: [after.id] } : undefined,
          confidence: known ? "high" : "low",
        }),
      );
    }
  }

  // B7 偏离计划：持有过程中的违规和最后的退出价分开看。
  // 跌破止损线后拖着不卖、到了目标又回吐，即使最后回本也算偏离；没发现偏离不等于证明执行到位
  const closing = sells.find((t) => t.positionAfter === 0);
  // 清仓时有效的计划（之前最近一次写下的止损和目标）
  const { stop, target } = planAt(buys, closing?.ts ?? Infinity);
  if (stop == null && target == null) {
    out.push(
      result("B7", "episode", {
        outcome: "undetermined",
        finding: "买入时没有记录止损或目标，无法核对是否按计划执行",
        evidenceIds: buys.map((t) => `trade:${t.id}`),
        confidence: "high",
      }),
    );
  } else if (closing) {
    const vs = ev.get(`calc:vscost:${closing.id}`);
    const stopEv = ev.get(`calc:stop:${closing.id}`);
    const targetEv = ev.get(`calc:target:${closing.id}`);
    // 止损线被跌破之后的第一笔卖出：看跌破后拖了几个交易日
    const lagEv = sells.map((t) => ev.get(`calc:stoplag:${t.id}`)).find((e) => e?.value != null);
    const pct = vs?.value ?? null;
    const sign = (x: number) => `${x >= 0 ? "+" : ""}${x.toFixed(1)}%`;
    const stopKnown = stop == null || stopEv?.status === "ok";
    const targetKnown = target == null || targetEv?.status === "ok";
    const violations: string[] = [];
    const notes: string[] = [];

    if (stop != null && stopKnown) {
      if (lagEv && (lagEv.value as number) >= 2) {
        violations.push(`${lagEv.title}（计划止损 ${stop}%）`);
        if (pct != null && pct > -stop) notes.push(`最后卖出时相对成本 ${sign(pct)}，价格回来了不代表当时执行了计划`);
      } else if (lagEv) {
        notes.push(lagEv.title);
        if (pct != null && -pct - stop > 3) notes.push(`卖出价比止损线多亏 ${(-pct - stop).toFixed(1)} 个百分点，来自跌破当天之后的跳空或连续下跌，不算没执行`);
      } else if (stopEv) {
        notes.push(stopEv.title);
        // 之前的收盘都在止损线上方，卖出价却在线下：是当天跌破、当天卖出
        if (pct != null && pct < -stop) notes.push(`卖出当天才跌破止损线、当天就卖了，卖出价比止损线多亏 ${(-pct - stop).toFixed(1)} 个百分点（盘中急跌或跳空），不算拖延`);
      }
    } else if (stop != null && pct != null && pct < 0 && -pct - stop > 3) {
      // 缺少持仓期间的行情时，只能用最后的卖出价兜底
      violations.push(`计划止损 ${stop}%，实际卖出时相对成本 ${pct.toFixed(1)}%，多亏了 ${(-pct - stop).toFixed(1)} 个百分点`);
    }
    if (target != null && targetKnown && pct != null) {
      if (targetEv?.value != null && target - pct > 3) {
        violations.push(`${targetEv.title}，卖出时相对成本只剩 ${sign(pct)}，比目标少了 ${(target - pct).toFixed(1)} 个百分点`);
      } else if (targetEv?.value == null && pct > 0 && target - pct > 3) {
        violations.push(`计划目标 +${target}%，还没到目标就在 ${sign(pct)} 卖出，比目标少了 ${(target - pct).toFixed(1)} 个百分点`);
      } else if (targetEv) notes.push(targetEv.title);
    }

    const evidenceIds = [vs?.id, stopEv?.id, lagEv?.id, targetEv?.id, ...buys.map((t) => `trade:${t.id}`)].filter((x): x is string => !!x);
    if (violations.length) {
      out.push(result("B7", "episode", { outcome: "hit", tradeId: closing.id, finding: [...violations, ...notes].join("；"), evidenceIds, confidence: "high" }));
    } else if (pct == null || !stopKnown || !targetKnown) {
      out.push(
        result("B7", "episode", {
          outcome: "undetermined",
          tradeId: closing.id,
          finding: pct == null ? "缺少卖出价相对成本的计算，无法核对" : "缺少持仓期间的行情，无法确认中途有没有跌破止损线或达到目标",
          evidenceIds,
          confidence: "low",
        }),
      );
    } else {
      const plan = [stop != null ? `止损 ${stop}%` : "", target != null ? `目标 +${target}%` : ""].filter(Boolean).join("、");
      out.push(
        result("B7", "episode", {
          outcome: "not_hit",
          tradeId: closing.id,
          finding: [`没有发现违反计划（${plan}）的情况，卖出时相对成本 ${sign(pct)}`, ...notes].join("；"),
          evidenceIds,
          // 只说明规则没查到问题，不等于证明执行到位
          confidence: "mid",
        }),
      );
    }
  }
  return out;
}

export interface EpisodeSummary {
  episode: Episode;
  holdDays: number | null;
  /** 这只股票的交易日序列（用来算 10 个交易日窗口） */
  tradingDays: string[];
}

/** 组合层面的规则：B4 处置效应、B5 过度交易 */
export function portfolioBiases(summaries: EpisodeSummary[]): BiasResult[] {
  const out: BiasResult[] = [];
  const closed = summaries.filter((s) => s.episode.closeTs != null && s.episode.returnPct != null && s.holdDays != null);
  const losers = closed.filter((s) => (s.episode.returnPct as number) < 0);
  const winners = closed.filter((s) => (s.episode.returnPct as number) > 0);
  const avg = (l: EpisodeSummary[]) => l.reduce((a, s) => a + (s.holdDays as number), 0) / l.length;
  if (closed.length < 4 || !losers.length || !winners.length) {
    out.push(
      result("B4", "portfolio", {
        outcome: "undetermined",
        finding: `已平仓 ${closed.length} 段（亏损 ${losers.length}、盈利 ${winners.length}），样本不够`,
        evidenceIds: closed.map((s) => `calc:hold:${s.episode.id}`),
        episodeIds: closed.map((s) => s.episode.id),
        confidence: "low",
      }),
    );
  } else {
    const l = avg(losers), w = avg(winners);
    const ratio = l / w;
    out.push(
      result("B4", "portfolio", {
        outcome: ratio >= 1.5 ? "hit" : "not_hit",
        finding: `亏损段 ${losers.length} 段平均持有 ${l.toFixed(1)} 个交易日，盈利段 ${winners.length} 段平均 ${w.toFixed(1)} 个交易日，比值 ${ratio.toFixed(2)}`,
        evidenceIds: closed.map((s) => `calc:hold:${s.episode.id}`),
        episodeIds: closed.map((s) => s.episode.id),
        confidence: closed.length >= 8 ? "high" : "mid",
      }),
    );
  }

  // B5：同一只股票所有成交，看任意 10 个交易日窗口里的笔数
  const byCode = new Map<string, EpisodeSummary[]>();
  for (const s of summaries) byCode.set(s.episode.code, [...(byCode.get(s.episode.code) ?? []), s]);
  const unknownCodes: string[] = [];
  for (const [code, list] of byCode) {
    const trades: EpisodeTrade[] = list.flatMap((s) => s.episode.trades).sort((a, b) => a.ts - b.ts);
    const days = [...new Set(list.flatMap((s) => s.tradingDays))].sort();
    // 交易日序列来自行情。行情缺失时序列盖不住成交日期，间隔算不出来，不能硬判。
    // 只放过最后几天：盘中成交时当天的日 K 还没有
    const daySet = new Set(days);
    const lastDay = days[days.length - 1];
    const covered = days.length > 0 && trades.every((t) => daySet.has(shDate(t.ts)) || (shDate(t.ts) > lastDay && shDate(t.ts) <= addDays(lastDay, 10)));
    if (trades.length >= 3 && !covered) {
      unknownCodes.push(list[0].episode.name ?? code);
      continue;
    }
    const dayIdx = (ts: number) => {
      const i = days.findIndex((d) => d >= shDate(ts));
      return i === -1 ? days.length : i;
    };
    let best: EpisodeTrade[] = [];
    for (let i = 0; i < trades.length; i++) {
      const win = trades.filter((t) => t.ts >= trades[i].ts && dayIdx(t.ts) - dayIdx(trades[i].ts) < 10);
      if (win.length > best.length) best = win;
    }
    if (best.length >= 3) {
      const fees = best.reduce((a, t) => a + t.fee, 0);
      out.push(
        result("B5", "portfolio", {
          outcome: "hit",
          finding: `${list[0].episode.name ?? code} 在 ${shDate(best[0].ts)} 到 ${shDate(best[best.length - 1].ts)} 之间买卖 ${best.length} 次，手续费合计 ${fees.toFixed(2)} 元`,
          evidenceIds: best.map((t) => `trade:${t.id}`),
          episodeIds: list.map((s) => s.episode.id),
          confidence: "high",
        }),
      );
    }
  }
  if (!out.some((r) => r.ruleId === "B5")) {
    out.push(
      unknownCodes.length
        ? result("B5", "portfolio", { outcome: "undetermined", finding: `${unknownCodes.join("、")} 缺少成交期间的交易日数据，算不出成交间隔，无法判定`, evidenceIds: [], confidence: "low" })
        : result("B5", "portfolio", { outcome: "not_hit", finding: "没有股票在 10 个交易日内买卖 3 次及以上", evidenceIds: [], confidence: "high" }),
    );
  }
  return out;
}
