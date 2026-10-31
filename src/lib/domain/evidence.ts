// 证据：复盘里每一条能被引用的事实。这里只放纯函数，取数在 lib/pipeline.ts。

import { shDate, shDateTime } from "@/lib/time";
import { barTiming, classify, dayTiming, derivedTiming, nextDayTiming, type Timed, type Timing } from "./pit";
import type { Bar, Episode, EpisodeTrade } from "./types";

export type EvidenceKind =
  | "trade"
  | "computed"
  | "financial"
  | "news"
  | "notice"
  | "anomaly"
  | "hot_rank"
  | "dragon_tiger"
  | "industry"
  | "corporate_action";

export type EvidenceStatus = "ok" | "partial" | "stale" | "missing" | "failed" | "conflict";

export interface Evidence extends Timed {
  id: string;
  kind: EvidenceKind;
  title: string;
  detail?: string;
  value?: number | null;
  unit?: string;
  /** 口径：复权方式、累计还是单季、公式等 */
  caliber?: string;
  source: "扶摇" | "iFinD" | "程序计算" | "用户导入";
  endpoint?: string;
  field?: string;
  url?: string | null;
  eventTime: number | null;
  fetchedAt: number | null;
  status: EvidenceStatus;
  /** 内容由数据商用 AI 生成（异动解读、部分公告解读） */
  thirdPartyAi?: boolean;
  /** 派生指标用到的输入：证据 id 或 "bar:日期" */
  inputs?: string[];
  /** 关联的决策（成交 id）；空表示属于整个持仓段 */
  tradeId?: string;
  tone?: "positive" | "negative" | "neutral";
  important?: boolean;
}

export interface Series {
  /** 不复权日 K，用来核对成交价和画图 */
  raw: Bar[];
  /** 前复权日 K，用来算收益和止损（除权日前后可比） */
  adj: Bar[];
}

const fmtPct = (x: number) => `${x >= 0 ? "+" : ""}${x.toFixed(1)}%`;

/** 某个日期之前（不含）的最近 n 根 K 线 */
export function barsBefore(bars: Bar[], date: string, n: number): Bar[] {
  const idx = bars.findIndex((b) => b.date >= date);
  const end = idx === -1 ? bars.length : idx;
  return bars.slice(Math.max(0, end - n), end);
}

export function barOn(bars: Bar[], date: string): Bar | undefined {
  return bars.find((b) => b.date === date);
}

/** 成交价换算到前复权口径：同一天的 复权收盘 / 不复权收盘 */
export function adjFactor(series: Series, date: string): number | null {
  const r = barOn(series.raw, date);
  const a = barOn(series.adj, date);
  if (!r || !a || !r.close) return null;
  return a.close / r.close;
}

export function tradeEvidence(t: EpisodeTrade): Evidence {
  const side = t.side === "buy" ? "买入" : "卖出";
  return {
    id: `trade:${t.id}`,
    kind: "trade",
    title: `${shDateTime(t.ts)} ${side} ${t.qty} 股 @ ${t.price}`,
    detail: t.reason ? `当时理由：${t.reason}` : "没有记录当时理由",
    value: t.price,
    unit: "元",
    caliber: "成交价，不复权",
    source: "用户导入",
    field: `第 ${t.rowNo} 行`,
    eventTime: t.ts,
    availableAt: t.ts,
    precision: "ms",
    fetchedAt: null,
    status: "ok",
    tradeId: t.id,
  };
}

/** 买入前 n 个交易日的涨幅：成交价相对第 n 个交易日前收盘价 */
export function runUpBeforeTrade(t: EpisodeTrade, series: Series, n = 5): Evidence | null {
  const date = shDate(t.ts);
  const prev = barsBefore(series.adj, date, n);
  const f = adjFactor(series, date);
  if (prev.length < n || f == null) return null;
  const base = prev[0];
  const pct = ((t.price * f) / base.close - 1) * 100;
  return {
    id: `calc:runup${n}:${t.id}`,
    kind: "computed",
    title: `${t.side === "buy" ? "买入" : "卖出"}前 ${n} 个交易日涨跌幅 ${fmtPct(pct)}`,
    detail: `${base.date} 收盘 ${base.close.toFixed(2)}（前复权）→ 成交价折算 ${(t.price * f).toFixed(2)}`,
    value: +pct.toFixed(2),
    unit: "%",
    caliber: "前复权；成交价 ÷ 第 n 个交易日前的收盘价 − 1",
    source: "程序计算",
    endpoint: "/api/a-share/prices/historical",
    inputs: [`bar:${base.date}`, `trade:${t.id}`],
    eventTime: t.ts,
    ...derivedTiming([barTiming(base.date), { availableAt: t.ts, precision: "ms" }]),
    fetchedAt: null,
    status: "ok",
    tradeId: t.id,
  };
}

/** 成交价相对近 20 日最高收盘价的位置 */
export function nearHigh(t: EpisodeTrade, series: Series, n = 20): Evidence | null {
  const date = shDate(t.ts);
  const prev = barsBefore(series.adj, date, n);
  const f = adjFactor(series, date);
  if (prev.length < n || f == null) return null;
  const top = prev.reduce((a, b) => (b.close > a.close ? b : a));
  const ratio = ((t.price * f) / top.close) * 100;
  return {
    id: `calc:high${n}:${t.id}`,
    kind: "computed",
    title: `成交价为近 ${n} 日最高收盘价的 ${ratio.toFixed(1)}%`,
    detail: `近 ${n} 日最高收盘 ${top.close.toFixed(2)}（${top.date}，前复权）`,
    value: +ratio.toFixed(2),
    unit: "%",
    caliber: "前复权；成交价 ÷ 前 n 个交易日最高收盘价",
    source: "程序计算",
    endpoint: "/api/a-share/prices/historical",
    inputs: [`bar:${prev[0].date}~${prev[prev.length - 1].date}`, `trade:${t.id}`],
    eventTime: t.ts,
    ...derivedTiming([barTiming(prev[prev.length - 1].date), { availableAt: t.ts, precision: "ms" }]),
    fetchedAt: null,
    status: "ok",
    tradeId: t.id,
  };
}

/** 卖出后 n 个交易日的走势：事后信息，只用来展示"代价"，不参与判定 */
export function driftAfterSell(t: EpisodeTrade, series: Series, n = 10): Evidence | null {
  const date = shDate(t.ts);
  const idx = series.adj.findIndex((b) => b.date > date);
  const f = adjFactor(series, date);
  if (idx === -1 || f == null) return null;
  const end = series.adj[Math.min(series.adj.length - 1, idx + n - 1)];
  const days = Math.min(n, series.adj.length - idx);
  const pct = (end.close / (t.price * f) - 1) * 100;
  return {
    id: `calc:after${n}:${t.id}`,
    kind: "computed",
    title: `卖出后 ${days} 个交易日涨跌幅 ${fmtPct(pct)}`,
    detail: `成交价折算 ${(t.price * f).toFixed(2)} → ${end.date} 收盘 ${end.close.toFixed(2)}（前复权）`,
    value: +pct.toFixed(2),
    unit: "%",
    caliber: "前复权；卖出后第 n 个交易日收盘价 ÷ 成交价 − 1",
    source: "程序计算",
    endpoint: "/api/a-share/prices/historical",
    inputs: [`trade:${t.id}`, `bar:${end.date}`],
    eventTime: t.ts,
    ...barTiming(end.date),
    fetchedAt: null,
    status: "ok",
    tradeId: t.id,
  };
}

/**
 * 持仓期间的平均成本（前复权口径），随加减仓更新。
 * 价格乘了复权因子，股数就要除以同一个因子（复权股数），否则送转后再加减仓，新旧股数口径不一致、成本算错
 */
export function adjustedCostPath(ep: Episode, series: Series) {
  let shares = 0;
  let cost = 0;
  const path: { ts: number; avgCost: number }[] = [];
  for (const t of ep.trades) {
    const f = adjFactor(series, shDate(t.ts));
    if (f == null) return null;
    const q = t.qty / f;
    if (t.side === "buy") {
      cost += t.price * t.qty;
      shares += q;
    } else {
      cost -= (cost / shares) * Math.min(q, shares);
      shares -= Math.min(q, shares);
    }
    // 全部卖完后浮点误差可能留下极小的余数，不算持仓
    if (shares > 1e-6) path.push({ ts: t.ts, avgCost: cost / shares });
  }
  return path;
}

/**
 * 截至某个时刻之前（不含当天）：持仓期间的最大浮亏、止损线首次被跌破、目标首次达到（都按收盘价）。
 * 买入当天的收盘也算（盘中买入、收盘时已经持有）。止损和目标只从写下它们的那笔买入之后开始核对
 */
export function drawdownBefore(
  ep: Episode,
  series: Series,
  untilTs: number,
  stopPct: number | null,
  targetPct: number | null = null,
  since: { stop?: number | null; target?: number | null } = {},
) {
  const path = adjustedCostPath(ep, series);
  if (!path?.length) return null;
  const untilDate = shDate(untilTs);
  let worst: { pct: number; date: string } | null = null;
  let stopBreach: { date: string; close: number; line: number } | null = null;
  let targetHit: { date: string; close: number; line: number } | null = null;
  for (const b of series.adj) {
    if (b.date < shDate(ep.openTs) || b.date >= untilDate) continue;
    const ts = barTiming(b.date).availableAt as number;
    const cur = [...path].reverse().find((p) => p.ts <= ts);
    if (!cur) continue;
    const pct = (b.close / cur.avgCost - 1) * 100;
    if (!worst || pct < worst.pct) worst = { pct, date: b.date };
    if (stopPct != null && !stopBreach && ts >= (since.stop ?? 0) && pct <= -stopPct) stopBreach = { date: b.date, close: b.close, line: cur.avgCost * (1 - stopPct / 100) };
    if (targetPct != null && !targetHit && ts >= (since.target ?? 0) && pct >= targetPct) targetHit = { date: b.date, close: b.close, line: cur.avgCost * (1 + targetPct / 100) };
  }
  return { worst, stopBreach, targetHit, lastCost: path[path.length - 1].avgCost };
}

const PERIOD_LABEL: Record<string, string> = { Q1: "一季报", Q2: "半年报", Q3: "三季报", Q4: "年报", FY: "年报" };

/**
 * 法定披露期限：一季报 4/30、半年报 8/31、三季报 10/31、年报次年 4/30。
 * 扶摇对旧报告期给的 report_date 有时是后来重述数据的日期（例如 2024 年年报显示 2026-03-31），
 * 超过期限太多的不能当成首次披露日用。
 */
export function isLikelyOriginalDisclosure(periodEnd: string, reportDate: string): boolean {
  const deadlineMonths: Record<string, number> = { "03": 1, "06": 2, "09": 1, "12": 4 };
  const [y, m] = periodEnd.split("-");
  const add = deadlineMonths[m] ?? 4;
  const dy = +y + Math.floor((+m + add - 1) / 12);
  const dm = ((+m + add - 1) % 12) + 1;
  const deadline = `${dy}-${String(dm).padStart(2, "0")}-${dm === 4 || dm === 6 || dm === 9 || dm === 11 ? 30 : 31}`;
  return reportDate <= addDaysIso(deadline, 15);
}

function addDaysIso(date: string, n: number) {
  const t = Date.parse(date + "T00:00:00Z") + n * 86_400_000;
  return new Date(t).toISOString().slice(0, 10);
}

export function financialEvidence(
  code: string,
  r: { fiscalYear: number; fiscalPeriod: string; reportDate: string | null; periodEnd: string; operatingIncome: number | null; parentNetProfit: number | null; basicEps: number | null },
  fetchedAt: number,
): Evidence {
  const yi = (x: number | null) => (x == null ? "—" : `${(x / 1e8).toFixed(2)} 亿元`);
  return {
    id: `fin:${code}:${r.fiscalYear}${r.fiscalPeriod}`,
    kind: "financial",
    title: `${r.fiscalYear} 年${PERIOD_LABEL[r.fiscalPeriod] ?? r.fiscalPeriod}披露（${r.reportDate ?? "披露日缺失"}）`,
    detail: `营业收入 ${yi(r.operatingIncome)}，归母净利润 ${yi(r.parentNetProfit)}，基本每股收益 ${r.basicEps ?? "—"} 元（报告期末 ${r.periodEnd}）`,
    value: r.operatingIncome,
    unit: "元",
    caliber: "年初至报告期末累计值；营业收入不含金融类子公司利息收入（与“营业总收入”口径不同）",
    source: "扶摇",
    endpoint: "/api/a-share/financials/income-statements",
    field: "operating_income, parent_holder_net_profit, basic_eps, report_date_ms",
    eventTime: r.reportDate ? dayTiming(r.reportDate).availableAt : null,
    ...(r.reportDate ? dayTiming(r.reportDate) : { availableAt: null, precision: "day" as const }),
    fetchedAt,
    status: r.reportDate ? "ok" : "partial",
    important: true,
  };
}

const NEG = /预亏|亏损|下滑|下降|减持|风险|问询|处罚|立案|跌停|暴跌|大跌|回落|下调|终止|违规|爆雷|退市|承压|不及预期|利空/;
const POS = /预增|增长|超预期|上调|增持|回购|中标|订单|涨停|大涨|突破|获批|新高|利好|签约/;
const IMPORTANT = /业绩|预告|预增|预亏|公告|减持|增持|回购|风险|问询|处罚|中标|合同|订单|涨停|跌停|评级|指引|财报|年报|季报|中报/;

export function toneOf(text: string): Evidence["tone"] {
  const n = NEG.test(text), p = POS.test(text);
  if (n && !p) return "negative";
  if (p && !n) return "positive";
  return "neutral";
}

export function newsEvidence(
  n: { id: string; type: number | null; title: string; source: string | null; summary: string | null; publishTs: number | null; url: string },
  fetchedAt: number,
): Evidence {
  const text = `${n.title} ${n.summary ?? ""}`;
  return {
    id: `news:${n.id}`,
    kind: "news",
    title: n.title,
    detail: [n.type === 2 ? "研报" : null, n.source, n.summary?.trim().slice(0, 240)].filter(Boolean).join(" · "),
    source: "扶摇",
    endpoint: "/api/news/stock/timeline-list",
    field: "title, summary, publish_time_ms",
    url: n.url,
    eventTime: n.publishTs,
    availableAt: n.publishTs,
    precision: "ms",
    fetchedAt,
    status: n.publishTs ? "ok" : "partial",
    tone: toneOf(text),
    important: n.type === 2 || IMPORTANT.test(n.title),
  };
}

export function anomalyEvidence(
  a: { id: string; tag: string; tagCode: string; keywords: string[]; content: string; publishTs: number | null; url: string | null },
  fetchedAt: number,
): Evidence {
  return {
    id: `anomaly:${a.id}`,
    kind: "anomaly",
    title: `${a.publishTs ? shDate(a.publishTs) : ""} 异动「${a.tag}」：${a.keywords.join("、")}`,
    detail: a.content.replace(/（免责声明[\s\S]*$/, "").trim().slice(0, 400),
    source: "扶摇",
    endpoint: "/api/news/anomaly/analysis",
    field: "tag_name, key_word_list, analysis_content, first_publish_time",
    url: a.url,
    eventTime: a.publishTs,
    availableAt: a.publishTs,
    precision: "ms",
    fetchedAt,
    status: a.publishTs ? "ok" : "partial",
    thirdPartyAi: true,
    tone: /跌/.test(a.tag) ? "negative" : /涨/.test(a.tag) ? "positive" : "neutral",
    important: true,
  };
}

export function ifindEvidence(
  kind: "news" | "notice",
  d: { title: string; content: string; date: string | null; url: string | null; aiGenerated: boolean },
  fetchedAt: number,
  idx: string,
): Evidence {
  return {
    id: `ifind-${kind}:${idx}`,
    kind,
    title: d.title,
    detail: d.content.slice(0, 400),
    source: "iFinD",
    endpoint: kind === "news" ? "search_news" : "search_notice",
    field: kind === "news" ? "资讯标题, 资讯内容, 日期" : "公告标题, 公告片段内容, 日期",
    url: d.url,
    eventTime: d.date ? dayTiming(d.date).availableAt : null,
    ...(d.date ? dayTiming(d.date) : { availableAt: null, precision: "day" as const }),
    fetchedAt,
    status: d.date ? "ok" : "partial",
    thirdPartyAi: d.aiGenerated,
    tone: toneOf(`${d.title} ${d.content}`),
    important: kind === "notice" || IMPORTANT.test(d.title),
  };
}

export function hotRankEvidence(t: EpisodeTrade, ranks: { date: string; rank: number }[], prevDate: string | null, fetchedAt: number): Evidence {
  const r = prevDate ? ranks.find((x) => x.date === prevDate) : undefined;
  return {
    id: `hot:${t.id}`,
    kind: "hot_rank",
    title: r ? `买入前一交易日（${prevDate}）热股排名第 ${r.rank} 名` : `买入前一交易日热股排名：未获取到`,
    detail: "同花顺热股榜；第 D 天的排名按第二天才可知处理",
    value: r?.rank ?? null,
    unit: "名",
    source: "扶摇",
    endpoint: "/api/a-share/special-data/hot-stock-rank-trend",
    field: "date, rank",
    eventTime: prevDate ? nextDayTiming(prevDate).availableAt : null,
    ...(prevDate ? nextDayTiming(prevDate) : { availableAt: null, precision: "ms" as const }),
    fetchedAt,
    status: r ? "ok" : "missing",
    tradeId: t.id,
  };
}

export function timingOf(e: Timed, t: number): Timing {
  return classify(e, t);
}
