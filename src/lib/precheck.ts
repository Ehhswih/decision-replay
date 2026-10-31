import "server-only";
import { DAY_MS, addDays, shDate } from "@/lib/time";
import { normalizeCode } from "@/lib/domain/trades";
import { ADVICE_NOTICE, isAdviceQuestion } from "@/lib/domain/compliance";
import { toneOf } from "@/lib/domain/evidence";
import * as fy from "@/lib/sources/fuyao-api";
import { searchNotice } from "@/lib/sources/ifind-api";
import { listItems, type ChecklistItem } from "@/lib/checklist";
import { getReview, type LessonTrigger } from "@/lib/ai/review";
import { analyzeWorkspace } from "@/lib/pipeline";

export interface PrecheckInput {
  query: string;
  side: "buy" | "sell";
  reason: string;
  planStop: number | null;
  planTarget: number | null;
}

export interface Fact {
  id: string;
  title: string;
  detail?: string;
  source: string;
  time: string;
  tone?: "positive" | "negative" | "neutral";
  url?: string | null;
}

export interface CheckResult {
  id: string;
  text: string;
  trigger: LessonTrigger;
  /** clear 只在数据取全、确实没命中时给出；数据源失败时是 unknown，不适用时是 na */
  status: "triggered" | "clear" | "manual" | "unknown" | "na";
  detail: string;
  factIds: string[];
  fromChecklist: boolean;
}

export interface PrecheckResult {
  code: string;
  name: string | null;
  asOf: string | null;
  adviceNotice: string | null;
  facts: Fact[];
  checks: CheckResult[];
  related: { text: string; trigger: string; episodeId: string; episodeName: string | null; date: string }[];
  sourceErrors: string[];
}

const DEFAULT_CHECKS: { text: string; trigger: LessonTrigger }[] = [
  { text: "买入前看 5 日涨幅：超过 15% 时，先写下这次为什么不算追高", trigger: "chase" },
  { text: "热股榜前 20 或刚上龙虎榜时，先写下不看热度时的买入理由", trigger: "hot" },
  { text: "下单前写好止损和目标", trigger: "plan" },
  { text: "把近 10 天的负面公告和新闻过一遍，在理由里写明怎么看", trigger: "attention" },
  { text: "同一只股票 10 个交易日内第三次交易前，先复查前两次的结果", trigger: "overtrade" },
  { text: "连续下跌后想卖时，先对照买入时写的止损线", trigger: "panic" },
];

/**
 * 决策前检查：把用户自己的清单逐条套到这只股票当前可知的事实上。
 * 只给出"哪条检查被触发、依据是什么"，不判断能不能买卖。
 */
export async function runPrecheck(input: PrecheckInput, workspace: string, visitor: string | null): Promise<PrecheckResult | { error: string }> {
  let code = normalizeCode(input.query);
  let name: string | null = null;
  // 输入已经是代码时不等检索结果（标的检索偶尔要十几秒），名称拿到了再用
  const searching = fy.searchTicker(code ?? input.query.trim());
  if (!code) {
    const found = await searching;
    if (found.data?.length) {
      code = found.data[0].code;
      name = found.data[0].name;
    }
  }
  if (!code) return { error: `没有找到「${input.query}」对应的 A 股，请输入 6 位代码或完整名称` };

  const today = shDate(Date.now());
  const facts: Fact[] = [];
  const sourceErrors: string[] = [];

  const [adj, hot, cal, an, news, a] = await Promise.all([
    fy.dailyBars(code, addDays(today, -45), today, "forward"),
    fy.hotRank(code, addDays(today, -10), today),
    fy.tradingDays(addDays(today, -15), today),
    fy.anomalies(code, addDays(today, -10), today),
    fy.stockNews(code, Date.now() - 10 * DAY_MS, Date.now(), 5),
    analyzeWorkspace(workspace),
  ]);
  if (!name) name = a.trades.find((t) => t.code === code && t.name)?.name ?? (await searching).data?.find((x) => x.code === code)?.name ?? null;
  if (adj.status === "failed") sourceErrors.push(`日 K 获取失败：${adj.error?.message}`);
  const bars = adj.data ?? [];
  const last = bars[bars.length - 1];
  let runup5: number | null = null;
  let newHigh = false;
  if (bars.length >= 21) {
    runup5 = (last.close / bars[bars.length - 6].close - 1) * 100;
    const prevMax = Math.max(...bars.slice(-21, -1).map((b) => b.close));
    newHigh = last.close >= prevMax;
    facts.push({ id: "runup5", title: `最近 5 个交易日涨跌幅 ${runup5 >= 0 ? "+" : ""}${runup5.toFixed(1)}%`, detail: `${bars[bars.length - 6].date} 收盘 → ${last.date} 收盘（前复权）`, source: "扶摇日 K", time: last.date });
    facts.push({ id: "high20", title: newHigh ? "最新收盘创近 20 日新高" : `最新收盘为近 20 日最高收盘的 ${((last.close / prevMax) * 100).toFixed(1)}%`, source: "扶摇日 K", time: last.date });
  }
  let drop3: number | null = null;
  if (bars.length >= 4) drop3 = (last.close / bars[bars.length - 4].close - 1) * 100;

  if (hot.status === "failed") sourceErrors.push(`热股排名获取失败：${hot.error?.message}`);
  const latestRank = (hot.data ?? []).filter((x) => x.date < today).at(-1);
  if (latestRank) facts.push({ id: "hot", title: `${latestRank.date} 热股排名第 ${latestRank.rank} 名`, source: "扶摇热股榜", time: latestRank.date });

  const days = cal.data ?? [];
  const lhbDates = days.filter((x) => x < today).slice(-3);
  const lhb = await Promise.all(lhbDates.map((d) => fy.dragonTiger(d)));
  const lhbHits = lhbDates.filter((d, i) => lhb[i].data?.some((x) => x.code === code));
  // 交易日历或任何一天的龙虎榜没取到，都不能说"没上龙虎榜"
  const lhbFailedDates = lhbDates.filter((_, i) => lhb[i].status === "failed");
  const lhbFailed = cal.status === "failed" || lhbDates.length < 3 || lhbFailedDates.length > 0;
  if (cal.status === "failed") sourceErrors.push(`交易日历获取失败：${cal.error?.message}`);
  else if (lhbDates.length < 3) sourceErrors.push("交易日历返回的近期交易日不足 3 天，龙虎榜没有查全");
  if (lhbFailedDates.length) sourceErrors.push(`龙虎榜获取失败：${lhbFailedDates.join("、")}`);
  if (lhbHits.length) facts.push({ id: "lhb", title: `最近 3 个交易日上过龙虎榜：${lhbHits.join("、")}`, source: "扶摇龙虎榜", time: lhbHits[0] });

  const negatives: Fact[] = [];
  if (an.status === "failed") sourceErrors.push(`异动解读获取失败：${an.error?.message}`);
  if (news.status === "failed") sourceErrors.push(`个股新闻获取失败：${news.error?.message}`);
  for (const a of an.data?.items ?? []) {
    const f: Fact = { id: `anomaly:${a.id}`, title: `异动「${a.tag}」：${a.keywords.join("、")}`, detail: "同花顺 AI 生成的异动解读", source: "扶摇异动解读", time: a.publishTs ? shDate(a.publishTs) : "", tone: /跌/.test(a.tag) ? "negative" : /涨/.test(a.tag) ? "positive" : "neutral", url: a.url };
    facts.push(f);
    if (f.tone === "negative") negatives.push(f);
  }
  for (const n of news.data.filter((x) => toneOf(x.title) === "negative").slice(0, 6)) {
    const f: Fact = { id: `news:${n.id}`, title: n.title, detail: n.source ?? undefined, source: "扶摇个股新闻", time: n.publishTs ? shDate(n.publishTs) : "", tone: "negative", url: n.url };
    facts.push(f);
    negatives.push(f);
  }
  const nt = await searchNotice(`${name ?? code} 公告`, addDays(today, -10), today, 6);
  if (nt.status === "failed") sourceErrors.push(`公告获取失败：${nt.error?.message}`);
  // iFinD 检索会把同一份公告的多个片段分开返回，按标题去重
  const seenNotice = new Set<string>();
  for (const [i, d] of (nt.data ?? []).entries()) {
    if (!d.date || d.date < addDays(today, -10) || seenNotice.has(d.title)) continue;
    seenNotice.add(d.title);
    const f: Fact = { id: `notice:${i}`, title: d.title, source: "iFinD 公告", time: d.date, tone: toneOf(`${d.title} ${d.content}`) };
    facts.push(f);
    if (f.tone === "negative") negatives.push(f);
  }
  // 没取到、只取到一部分、用的是旧缓存，都不能说"没有负面信息"
  const gapOf = (label: string, status: string, partial: string) =>
    status === "failed" ? `${label}没有取到` : status === "stale" ? `${label}这次没取到、用的是之前缓存的数据` : partial ? `${label}${partial}` : "";
  const attentionGaps = [
    gapOf("异动解读", an.status, an.data?.truncated ? "只返回了一部分" : ""),
    gapOf("个股新闻", news.status, news.complete ? "" : "没有翻完近 10 天"),
    gapOf("公告", nt.status, ""),
  ].filter(Boolean);
  for (const g of attentionGaps) if (!/没有取到$/.test(g)) sourceErrors.push(g);

  // 本工作区里这只股票最近的成交
  const recentTrades = a.trades.filter((t) => t.code === code && t.ts >= Date.now() - 14 * DAY_MS);

  const items: (ChecklistItem | (typeof DEFAULT_CHECKS)[number] & { id: string })[] = visitor ? listItems(visitor).filter((x) => x.enabled) : [];
  const fromChecklist = items.length > 0;
  const list = fromChecklist ? items : DEFAULT_CHECKS.map((d, i) => ({ ...d, id: `default-${i}` }));

  const checks: CheckResult[] = list.map((it) => {
    const base = { id: it.id, text: it.text, trigger: it.trigger, fromChecklist };
    switch (it.trigger) {
      case "chase":
        if (runup5 == null) return { ...base, status: "unknown", detail: "行情不足，无法计算", factIds: [] };
        return runup5 >= 15 || (newHigh && runup5 >= 8)
          ? { ...base, status: "triggered", detail: `最近 5 日 ${runup5.toFixed(1)}%${newHigh ? "，且创 20 日新高" : ""}`, factIds: ["runup5", "high20"] }
          : { ...base, status: "clear", detail: `最近 5 日 ${runup5.toFixed(1)}%`, factIds: ["runup5"] };
      case "hot": {
        const rankHit = !!latestRank && latestRank.rank <= 20;
        const parts = [
          latestRank ? `热股第 ${latestRank.rank} 名` : hot.status === "failed" ? "热股排名没有取到" : "近期不在热股榜",
          lhbHits.length ? `近 3 日上过龙虎榜（${lhbHits.join("、")}）` : lhbFailed ? "龙虎榜没有取全" : "近 3 日没上龙虎榜",
        ];
        // 有一项命中就算触发；两项都取到且都没命中才算未触发，否则无法判断
        if (rankHit || lhbHits.length) return { ...base, status: "triggered", detail: parts.join("，"), factIds: ["hot", "lhb"] };
        if (hot.status === "failed" || lhbFailed) return { ...base, status: "unknown", detail: `${parts.join("，")}，无法判断`, factIds: latestRank ? ["hot"] : [] };
        return { ...base, status: "clear", detail: parts.join("，"), factIds: ["hot"] };
      }
      case "plan":
        if (input.side === "sell") return { ...base, status: "manual", detail: "卖出时对照买入时写的止损和目标", factIds: [] };
        return input.planStop != null || input.planTarget != null
          ? { ...base, status: "clear", detail: [input.planStop != null ? `止损 ${input.planStop}%` : "", input.planTarget != null ? `目标 +${input.planTarget}%` : ""].filter(Boolean).join("，"), factIds: [] }
          : { ...base, status: "triggered", detail: "还没有写止损或目标", factIds: [] };
      case "attention":
        if (negatives.length)
          return { ...base, status: "triggered", detail: `近 10 天有 ${negatives.length} 条负面信息，理由里需要写明怎么看${attentionGaps.length ? `（${attentionGaps.join("，")}，可能还有遗漏）` : ""}`, factIds: negatives.map((n) => n.id) };
        if (attentionGaps.length) return { ...base, status: "unknown", detail: `${attentionGaps.join("，")}，无法确认近 10 天有没有负面信息`, factIds: [] };
        return { ...base, status: "clear", detail: "近 10 天的异动、新闻和公告里没有找到负面信息（按标题关键词筛选，可能有遗漏）", factIds: [] };
      case "overtrade":
        return recentTrades.length >= 2
          ? { ...base, status: "triggered", detail: `近两周已经交易 ${recentTrades.length} 次`, factIds: [] }
          : { ...base, status: "clear", detail: `近两周交易 ${recentTrades.length} 次`, factIds: [] };
      case "panic":
        if (input.side === "buy") return { ...base, status: "na", detail: "买入时不适用", factIds: [] };
        if (drop3 == null) return { ...base, status: "unknown", detail: "行情不足，无法计算", factIds: [] };
        return { ...base, status: drop3 <= -10 ? "triggered" : "clear", detail: `最近 3 日 ${drop3.toFixed(1)}%`, factIds: [] };
      default:
        return { ...base, status: "manual", detail: "需要自己对照检查", factIds: [] };
    }
  });

  // 历史复盘里相关的教训：同一只股票，或者同一类问题
  const triggered = new Set(checks.filter((c) => c.status === "triggered").map((c) => c.trigger));
  const related: PrecheckResult["related"] = [];
  for (const ep of a.episodes) {
    const r = getReview(workspace, ep.id);
    if (r.status !== "done" || !r.review) continue;
    for (const l of r.review.lessons) {
      if (ep.code === code || triggered.has(l.trigger)) related.push({ text: l.text, trigger: l.trigger, episodeId: ep.id, episodeName: ep.name, date: shDate(ep.openTs) });
    }
  }

  return {
    code,
    name,
    asOf: last?.date ?? null,
    adviceNotice: isAdviceQuestion(`${input.query} ${input.reason}`) ? ADVICE_NOTICE : null,
    facts,
    checks,
    related: related.slice(0, 8),
    sourceErrors,
  };
}
