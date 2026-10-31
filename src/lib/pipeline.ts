import "server-only";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { db } from "@/lib/db";
import { DAY_MS, addDays, shDate } from "@/lib/time";
import { barTiming, dayTiming, derivedTiming } from "@/lib/domain/pit";
import { decodeCsv, parseTradesCsv, type ParsedTrade } from "@/lib/domain/trades";
import { buildEpisodes, validateTrades, type MarketContext } from "@/lib/domain/position";
import {
  adjFactor,
  adjustedCostPath,
  anomalyEvidence,
  barOn,
  isLikelyOriginalDisclosure,
  drawdownBefore,
  driftAfterSell,
  financialEvidence,
  hotRankEvidence,
  ifindEvidence,
  nearHigh,
  newsEvidence,
  runUpBeforeTrade,
  tradeEvidence,
  type Evidence,
  type Series,
} from "@/lib/domain/evidence";
import type { Bar, CorpAction, Episode, Issue, Trade } from "@/lib/domain/types";
import * as fy from "@/lib/sources/fuyao-api";
import { searchNotice } from "@/lib/sources/ifind-api";
import type { FetchStatus, SourceError, SourceResult } from "@/lib/sources/types";

export const DEMO_WORKSPACE = "demo";
/** 证据生成逻辑改了就加 1，旧缓存自动失效 */
const EVIDENCE_VERSION = 2;
const MARKET_INDEX = { code: "000300.SH", name: "沪深300" };

// ---------------- 成交的存取 ----------------

type TradeRow = { id: string; row_no: number; ts: number; time_known: number; code: string; name: string | null; side: "buy" | "sell"; price: number; qty: number; fee: number; reason: string | null; plan_stop: number | null; plan_target: number | null };

export function loadTrades(workspace: string): Trade[] {
  const rows = db().prepare("SELECT * FROM trades WHERE workspace = ? ORDER BY ts, row_no").all(workspace) as TradeRow[];
  return rows.map((r) => ({
    id: r.id,
    rowNo: r.row_no,
    ts: r.ts,
    timeKnown: !!r.time_known,
    code: r.code,
    name: r.name,
    side: r.side,
    price: r.price,
    qty: r.qty,
    fee: r.fee,
    reason: r.reason,
    planStop: r.plan_stop,
    planTarget: r.plan_target,
  }));
}

export function saveTrades(workspace: string, trades: ParsedTrade[]) {
  const conn = db();
  conn.exec("BEGIN");
  try {
    conn.prepare("DELETE FROM trades WHERE workspace = ?").run(workspace);
    conn.prepare("DELETE FROM evidence_sets WHERE workspace = ?").run(workspace);
    conn.prepare("DELETE FROM reviews WHERE workspace = ?").run(workspace);
    const ins = conn.prepare(
      "INSERT INTO trades (id, workspace, row_no, ts, time_known, code, name, side, price, qty, fee, reason, plan_stop, plan_target) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    );
    for (const t of trades) {
      ins.run(randomUUID().slice(0, 8), workspace, t.rowNo, t.ts, t.timeKnown ? 1 : 0, t.code, t.name, t.side, t.price, t.qty, t.fee, t.reason, t.planStop, t.planTarget);
    }
    conn.exec("COMMIT");
  } catch (e) {
    conn.exec("ROLLBACK");
    throw e;
  }
}

/** 示例组合：只读的公共工作区，第一次访问时从 demo/demo-trades.csv 载入 */
export function ensureDemo() {
  const n = db().prepare("SELECT COUNT(*) AS n FROM trades WHERE workspace = ?").get(DEMO_WORKSPACE) as { n: number };
  if (n.n > 0) return;
  const { text } = decodeCsv(readFileSync(join(process.cwd(), "demo", "demo-trades.csv")));
  saveTrades(DEMO_WORKSPACE, parseTradesCsv(text).trades);
}

// ---------------- 数据源状态 ----------------

export interface SourceStatus {
  key: string;
  label: string;
  status: FetchStatus | "skipped";
  critical: boolean;
  error?: SourceError;
  fetchedAt?: number;
  fromCache?: boolean;
  note?: string;
}

function statusOf(key: string, label: string, r: Pick<SourceResult<unknown>, "status" | "error" | "meta"> | null, critical = false, note?: string): SourceStatus {
  if (!r) return { key, label, status: "skipped", critical, note };
  return { key, label, status: r.status, critical, error: r.error, fetchedAt: r.meta?.fetchedAt, fromCache: r.meta?.fromCache, note };
}

// ---------------- 组合分析：持仓段和校验 ----------------

export interface WorkspaceAnalysis {
  trades: Trade[];
  episodes: Episode[];
  issues: Issue[];
  sources: SourceStatus[];
}

export async function analyzeWorkspace(workspace: string): Promise<WorkspaceAnalysis> {
  const trades = loadTrades(workspace);
  if (!trades.length) return { trades, episodes: [], issues: [], sources: [] };
  const today = shDate(Date.now());
  const first = shDate(trades[0].ts);
  const last = shDate(trades[trades.length - 1].ts);
  const codes = [...new Set(trades.map((t) => t.code))];
  const sources: SourceStatus[] = [];

  const cal = await fy.tradingDays(addDays(first, -10), last < today ? last : today);
  sources.push(statusOf("calendar", "交易日历", cal, true));

  const ctx: MarketContext = { tradingDays: cal.data ? new Set(cal.data) : null, bars: new Map() };
  const actions = new Map<string, CorpAction[]>();
  for (const code of codes) {
    const own = trades.filter((t) => t.code === code);
    const b = await fy.dailyBars(code, shDate(own[0].ts), shDate(own[own.length - 1].ts), "none");
    sources.push(statusOf(`bars:${code}`, `${code} 不复权日 K`, b, true));
    if (b.data) ctx.bars.set(code, new Map(b.data.map((x) => [x.date, x])));
    const ca = await fy.corpActions(code);
    sources.push(statusOf(`actions:${code}`, `${code} 除权除息`, ca, false));
    if (ca.data) actions.set(code, ca.data);
  }

  const validation = validateTrades(trades, ctx);
  const { episodes, issues } = buildEpisodes(trades, actions);
  return { trades, episodes, issues: [...validation, ...issues], sources };
}

// ---------------- 单个持仓段的证据 ----------------

export interface EvidenceSet {
  episode: Episode;
  window: { start: string; end: string };
  series: Series & { index: Bar[]; industry: Bar[]; indexName: string; industryName: string | null; industryCode: string | null };
  items: Evidence[];
  sources: SourceStatus[];
  newsComplete: boolean;
  builtAt: number;
  version: number;
}

const pctChange = (bars: Bar[], from: string, to: string) => {
  const a = bars.find((b) => b.date >= from);
  const z = [...bars].reverse().find((b) => b.date <= to);
  return a && z ? { pct: (z.close / a.close - 1) * 100, from: a, to: z } : null;
};

export async function buildEvidenceSet(workspace: string, episode: Episode, force = false): Promise<EvidenceSet> {
  const key = `${workspace}/${episode.id}`;
  if (!force) {
    const row = db().prepare("SELECT json FROM evidence_sets WHERE episode_id = ?").get(key) as { json: string } | undefined;
    if (row) {
      const cachedSet = JSON.parse(row.json) as EvidenceSet;
      if (cachedSet.version === EVIDENCE_VERSION) return cachedSet;
    }
  }

  const today = shDate(Date.now());
  const openDate = shDate(episode.openTs);
  const closeDate = episode.closeTs ? shDate(episode.closeTs) : today;
  const start = addDays(openDate, -45);
  const endRaw = addDays(closeDate, 30);
  const end = endRaw < today ? endRaw : today;
  const sources: SourceStatus[] = [];
  const items: Evidence[] = [];
  const code = episode.code;
  const name = episode.name ?? code;

  const [raw, adj, idx, cal] = await Promise.all([
    fy.dailyBars(code, start, end, "none"),
    fy.dailyBars(code, start, end, "forward"),
    fy.indexBars(MARKET_INDEX.code, start, end),
    fy.tradingDays(start, end),
  ]);
  sources.push(statusOf("raw", "个股日 K（不复权）", raw, true));
  sources.push(statusOf("adj", "个股日 K（前复权）", adj, true));
  sources.push(statusOf("index", `${MARKET_INDEX.name}日 K`, idx));
  sources.push(statusOf("calendar", "交易日历", cal));
  const series: Series = { raw: raw.data ?? [], adj: adj.data ?? [] };
  const days = cal.data ?? series.raw.map((b) => b.date);
  const prevTradingDay = (date: string, n = 1) => {
    const i = days.findIndex((d) => d >= date);
    const at = (i === -1 ? days.length : i) - n;
    return at >= 0 ? days[at] : null;
  };

  const ind = await fy.industryOf(code);
  sources.push(statusOf("industry", "所属行业", ind, false, "只有当前归属，不是当时的"));
  const industry = ind.data?.[0] ?? null;
  let industryBars: Bar[] = [];
  if (industry) {
    const ib = await fy.indexBars(industry.code, start, end);
    sources.push(statusOf("industryBars", `行业指数（${industry.name}）日 K`, ib));
    industryBars = ib.data ?? [];
    items.push({
      id: `industry:${code}`,
      kind: "industry",
      title: `所属同花顺行业：${industry.name}（${industry.code}）`,
      detail: "扶摇只提供当前的行业归属，不能确认买入时是否相同",
      source: "扶摇",
      endpoint: "/api/a-share-index/constituents/ths-index-list-by-stock",
      field: "index_list[type=industry]",
      eventTime: null,
      availableAt: null,
      precision: "day",
      nonPit: true,
      fetchedAt: ind.meta.fetchedAt,
      status: "ok",
    });
  }

  // 成交和围绕每笔成交的指标
  for (const t of episode.trades) {
    items.push(tradeEvidence(t));
    if (!series.adj.length) continue;
    if (t.side === "buy") {
      const r5 = runUpBeforeTrade(t, series, 5);
      const hi = nearHigh(t, series, 20);
      if (r5) items.push(r5);
      if (hi) items.push(hi);
    } else {
      const r3 = runUpBeforeTrade(t, series, 3);
      if (r3) items.push(r3);
      const drift = driftAfterSell(t, series, 10);
      if (drift) items.push(drift);
      const planStop = episode.trades.find((x) => x.side === "buy" && x.planStop != null)?.planStop ?? null;
      const dd = drawdownBefore(episode, series, t.ts, planStop);
      if (dd?.worst) {
        items.push({
          id: `calc:dd:${t.id}`,
          kind: "computed",
          title: `卖出前持仓期间最大浮亏 ${dd.worst.pct.toFixed(1)}%（${dd.worst.date} 收盘）`,
          detail: `按前复权收盘价相对当时平均成本计算，截至卖出前一交易日`,
          value: +dd.worst.pct.toFixed(2),
          unit: "%",
          caliber: "前复权；收盘价 ÷ 当时平均持仓成本 − 1",
          source: "程序计算",
          endpoint: "/api/a-share/prices/historical",
          inputs: [`bar:${dd.worst.date}`],
          eventTime: barTiming(dd.worst.date).availableAt,
          ...barTiming(dd.worst.date),
          fetchedAt: null,
          status: "ok",
          tradeId: t.id,
        });
      }
      if (planStop != null) {
        items.push({
          id: `calc:stop:${t.id}`,
          kind: "computed",
          title: dd?.stopBreach
            ? `计划止损 ${planStop}% 的止损线在 ${dd.stopBreach.date} 被跌破（收盘 ${dd.stopBreach.close.toFixed(2)}，止损线 ${dd.stopBreach.line.toFixed(2)}）`
            : `卖出前没有跌破计划止损 ${planStop}% 的止损线`,
          value: planStop,
          unit: "%",
          caliber: "前复权；止损线 = 当时平均成本 × (1 − 止损幅度)",
          source: "程序计算",
          endpoint: "/api/a-share/prices/historical",
          inputs: dd?.stopBreach ? [`bar:${dd.stopBreach.date}`] : [],
          eventTime: dd?.stopBreach ? barTiming(dd.stopBreach.date).availableAt : t.ts,
          ...(dd?.stopBreach ? barTiming(dd.stopBreach.date) : { availableAt: t.ts, precision: "ms" as const }),
          fetchedAt: null,
          status: dd ? "ok" : "missing",
          tradeId: t.id,
        });
      }
      const costAt = [...(adjustedCostPath(episode, series) ?? [])].reverse().find((p) => p.ts < t.ts);
      const f = adjFactor(series, shDate(t.ts));
      if (costAt && f != null) {
        const pct = ((t.price * f) / costAt.avgCost - 1) * 100;
        items.push({
          id: `calc:vscost:${t.id}`,
          kind: "computed",
          title: `卖出价相对持仓成本 ${pct >= 0 ? "+" : ""}${pct.toFixed(1)}%`,
          detail: `成交价折算 ${(t.price * f).toFixed(2)}，当时平均成本 ${costAt.avgCost.toFixed(2)}（前复权，不含费用）`,
          value: +pct.toFixed(2),
          unit: "%",
          caliber: "前复权；卖出价 ÷ 当时平均持仓成本 − 1，不含手续费和分红",
          source: "程序计算",
          endpoint: "/api/a-share/prices/historical",
          inputs: episode.trades.filter((x) => x.ts <= t.ts).map((x) => `trade:${x.id}`),
          eventTime: t.ts,
          availableAt: t.ts,
          precision: "ms",
          fetchedAt: null,
          status: "ok",
          tradeId: t.id,
        });
      }
    }
  }

  // 持有天数（交易日）
  {
    const holdDays = days.filter((d) => d >= openDate && d <= closeDate).length;
    items.push({
      id: `calc:hold:${episode.id}`,
      kind: "computed",
      title: `${episode.closeTs ? "持有" : "截至今天已持有"} ${holdDays} 个交易日（${openDate} ~ ${closeDate}）`,
      value: holdDays,
      unit: "交易日",
      caliber: "首次买入日到清仓日，两端都算",
      source: "程序计算",
      endpoint: "/api/a-share/calendar/trading-days",
      eventTime: episode.closeTs ?? Date.now(),
      availableAt: episode.closeTs ?? Date.now(),
      precision: "ms",
      fetchedAt: null,
      status: cal.data ? "ok" : "partial",
    });
  }

  // 除权除息
  for (const e of episode.corpEvents) {
    items.push({
      id: `corp:${code}:${e.exDate}`,
      kind: "corporate_action",
      title: `${e.exDate} 除权除息：每股派 ${e.cashPerShare} 元${e.bonusPerShare ? `、送转 ${e.bonusPerShare} 股` : ""}`,
      detail: `当时持有 ${e.sharesBefore} 股，获得 ${e.bonusShares} 股送转、${e.cashReceived} 元分红（税前）。不复权价格在这一天会跳空，不是真实涨跌`,
      source: "扶摇",
      endpoint: "/api/a-share/corporate-actions/adjustment-factors",
      field: "ex_date_ms, dividend_per_share, per_share_bonus",
      eventTime: dayTiming(e.exDate).availableAt,
      ...dayTiming(e.exDate),
      fetchedAt: null,
      status: "ok",
      important: true,
    });
  }

  // 收益拆解（事后）
  if (episode.closeTs && episode.returnPct != null) {
    const mk = pctChange(idx.data ?? [], openDate, closeDate);
    const ik = industry ? pctChange(industryBars, openDate, closeDate) : null;
    const lastBarTiming = barTiming(closeDate);
    const decomp: Evidence = {
      id: `calc:decomp:${episode.id}`,
      kind: "computed",
      title: `持仓段收益 ${episode.returnPct.toFixed(2)}%：${MARKET_INDEX.name} ${mk ? mk.pct.toFixed(2) + "%" : "缺失"}${ik ? `，${industry?.name} ${ik.pct.toFixed(2)}%` : ""}`,
      detail: [
        mk ? `市场：${mk.pct.toFixed(2)}%` : "市场：指数行情缺失",
        mk && ik ? `行业超额：${(ik.pct - mk.pct).toFixed(2)}%` : "行业超额：无法计算",
        ik ? `个股特异：${(episode.returnPct - ik.pct).toFixed(2)}%` : mk ? `个股相对市场：${(episode.returnPct - mk.pct).toFixed(2)}%` : "",
      ]
        .filter(Boolean)
        .join("；"),
      value: episode.returnPct,
      unit: "%",
      caliber: "个股为本持仓段实际收益（含分红送转、扣费）；指数为首次买入日到清仓日的收盘涨跌；行业用当前归属，非时点",
      source: "程序计算",
      endpoint: "/api/a-share-index/prices/historical",
      inputs: [MARKET_INDEX.code, industry?.code ?? ""].filter(Boolean),
      eventTime: episode.closeTs,
      ...derivedTiming([lastBarTiming]),
      fetchedAt: null,
      status: mk ? "ok" : "partial",
    };
    items.push(decomp);
  }

  // 财报
  const fin = await fy.incomeStatements(code);
  let restated = 0;
  for (const r of fin.data ?? []) {
    if (!r.reportDate || r.reportDate < addDays(openDate, -120) || r.reportDate > end) continue;
    if (!isLikelyOriginalDisclosure(r.periodEnd, r.reportDate)) {
      restated++;
      continue;
    }
    items.push(financialEvidence(code, r, fin.meta.fetchedAt));
  }
  sources.push(
    statusOf("financials", "财报（利润表）", fin, false, restated ? `${restated} 期财报的披露日远晚于法定期限，可能是重述数据的日期，不是首次披露日，已排除` : undefined),
  );

  // 新闻：从决策前 10 天到窗口结束
  const news = await fy.stockNews(code, episode.openTs - 10 * DAY_MS, Date.parse(end + "T23:59:59+08:00"));
  sources.push({
    key: "news",
    label: "个股新闻",
    status: news.status,
    critical: false,
    error: news.error,
    fetchedAt: news.meta?.fetchedAt,
    fromCache: news.meta?.fromCache,
    note: news.complete ? undefined : "翻页上限内没翻到决策前 10 天，较早的新闻可能缺失",
  });
  for (const n of news.data) items.push(newsEvidence(n, news.meta?.fetchedAt ?? Date.now()));

  // 异动解读（同花顺 AI 生成）
  const an = await fy.anomalies(code, addDays(openDate, -20), end);
  sources.push(statusOf("anomalies", "异动解读", an, false, an.status === "empty" ? "空列表也可能是数据源降级，不代表期间没有异动" : undefined));
  for (const a of an.data?.items ?? []) items.push(anomalyEvidence(a, an.meta.fetchedAt));

  // 热股排名、龙虎榜：只看买入
  const buys = episode.trades.filter((t) => t.side === "buy");
  const hot = await fy.hotRank(code, addDays(openDate, -10), closeDate);
  sources.push(statusOf("hot", "热股排名", hot));
  for (const t of buys) items.push(hotRankEvidence(t, hot.data ?? [], prevTradingDay(shDate(t.ts)), hot.meta.fetchedAt));

  let lhbFailed: SourceResult<unknown> | null = null;
  for (const t of buys) {
    const dates = [1, 2, 3].map((n) => prevTradingDay(shDate(t.ts), n)).filter((d): d is string => !!d);
    const hits: string[] = [];
    let failed = false;
    for (const d of dates) {
      const l = await fy.dragonTiger(d);
      if (l.status === "failed") {
        failed = true;
        lhbFailed = l;
      }
      if (l.data?.some((x) => x.code === code)) hits.push(d);
    }
    const latest = dates[0];
    items.push({
      id: `lhb:${t.id}`,
      kind: "dragon_tiger",
      title: failed ? "买入前 3 个交易日龙虎榜：部分日期获取失败" : hits.length ? `买入前 3 个交易日上过龙虎榜：${hits.join("、")}` : "买入前 3 个交易日没有上龙虎榜",
      source: "扶摇",
      endpoint: "/api/a-share/special-data/dragon-tiger-list",
      field: "stock_items[].thscode",
      eventTime: latest ? barTiming(latest).availableAt : null,
      ...(latest ? { availableAt: Date.parse(latest + "T00:00:00+08:00") + DAY_MS, precision: "ms" as const } : { availableAt: null, precision: "ms" as const }),
      fetchedAt: Date.now(),
      status: failed ? "partial" : "ok",
      tradeId: t.id,
    });
  }
  sources.push(statusOf("lhb", "龙虎榜", lhbFailed ?? { status: "ok", meta: { fetchedAt: Date.now(), fromCache: true } as SourceResult<unknown>["meta"] }));

  // iFinD 公告检索。返回结果仍按日期重新过滤。
  // 没用 search_news：实测 10 个持仓段返回的新闻全部落在时间窗口外，只会消耗额度（见 docs/data-probe.md）
  const iStart = addDays(openDate, -15);
  const notice = await searchNotice(`${name} 公告`, iStart, closeDate, 10);
  let outOfWindow = 0;
  (notice.data ?? []).forEach((d, i) => {
    if (!d.date || d.date < iStart || d.date > end) {
      outOfWindow++;
      return;
    }
    items.push(ifindEvidence("notice", d, notice.meta.fetchedAt, `${episode.id}:notice:${i}`));
  });
  sources.push(statusOf("ifindNotice", "iFinD 公告检索", notice, false, outOfWindow ? `返回了 ${outOfWindow} 条时间窗口外的结果，已丢弃` : undefined));

  // 成交价和当日行情冲突时，把这笔成交标成 conflict
  for (const t of episode.trades) {
    const b = barOn(series.raw, shDate(t.ts));
    if (b && (t.price < b.low - 0.005 || t.price > b.high + 0.005)) {
      const ev = items.find((x) => x.id === `trade:${t.id}`);
      if (ev) ev.status = "conflict";
    }
  }

  items.sort((a, b) => (a.eventTime ?? 0) - (b.eventTime ?? 0));
  const set: EvidenceSet = {
    episode,
    window: { start, end },
    series: { ...series, index: idx.data ?? [], industry: industryBars, indexName: MARKET_INDEX.name, industryName: industry?.name ?? null, industryCode: industry?.code ?? null },
    items,
    sources,
    newsComplete: news.complete,
    builtAt: Date.now(),
    version: EVIDENCE_VERSION,
  };
  // 关键数据失败时不缓存，下次重试
  if (!sources.some((s) => s.critical && s.status === "failed")) {
    db().prepare("INSERT OR REPLACE INTO evidence_sets (episode_id, workspace, json, built_at) VALUES (?, ?, ?, ?)").run(key, workspace, JSON.stringify(set), set.builtAt);
  }
  return set;
}
