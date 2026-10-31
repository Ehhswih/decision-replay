import "server-only";
import { atShTime, shDate } from "@/lib/time";
import type { Bar, CorpAction } from "@/lib/domain/types";
import { cached } from "./cache";
import { fuyaoRequest } from "./fuyao";
import type { SourceResult } from "./types";

const HOUR = 3600_000;

function call<T>(endpoint: string, params: Record<string, string | number>, ttlMs: number | null, timeoutMs?: number) {
  return cached<T>("fuyao", endpoint, params, ttlMs, () =>
    fuyaoRequest<T>(endpoint, params, { apiKey: process.env.FUYAO_API_KEY, timeoutMs }),
  );
}

/** 窗口结束在今天之前的历史数据不会再变，永久缓存；含今天的缓存 30 分钟 */
function ttlFor(endDate: string) {
  return endDate < shDate(Date.now()) ? null : 0.5 * HOUR;
}

function mapResult<A, B>(r: SourceResult<A>, f: (a: A) => B, isEmpty: (b: B) => boolean): SourceResult<B> {
  if (r.data == null) return { ...r, data: null } as SourceResult<B>;
  const data = f(r.data);
  return { ...r, data, status: r.status === "ok" && isEmpty(data) ? "empty" : r.status };
}

type RawBar = { date_ms: number; open_price: number; high_price: number; low_price: number; close_price: number; volume: number; turnover: number };
const toBars = (d: { item?: RawBar[] }): Bar[] =>
  (d.item ?? []).map((b) => ({
    date: shDate(b.date_ms),
    open: b.open_price,
    high: b.high_price,
    low: b.low_price,
    close: b.close_price,
    volume: b.volume,
    turnover: b.turnover,
  }));

export type Adjust = "none" | "forward" | "backward";

export async function dailyBars(code: string, start: string, end: string, adjust: Adjust = "none") {
  const r = await call<{ item?: RawBar[] }>(
    "/api/a-share/prices/historical",
    { thscode: code, interval: "1d", start: atShTime(start), end: atShTime(end, 23, 59), adjust },
    ttlFor(end),
  );
  return mapResult(r, toBars, (b) => b.length === 0);
}

export async function indexBars(code: string, start: string, end: string) {
  const r = await call<{ item?: RawBar[] }>(
    "/api/a-share-index/prices/historical",
    { thscode: code, interval: "1d", start: atShTime(start), end: atShTime(end, 23, 59) },
    ttlFor(end),
  );
  return mapResult(r, toBars, (b) => b.length === 0);
}

export async function tradingDays(start: string, end: string) {
  const r = await call<{ item?: { date: string }[] }>(
    "/api/a-share/calendar/trading-days",
    { start_date: start.replaceAll("-", ""), end_date: end.replaceAll("-", "") },
    12 * HOUR,
  );
  return mapResult(
    r,
    (d) => (d.item ?? []).map((x) => `${x.date.slice(0, 4)}-${x.date.slice(4, 6)}-${x.date.slice(6, 8)}`),
    (l) => l.length === 0,
  );
}

export async function corpActions(code: string) {
  const r = await call<{ item?: { ex_date_ms: number; dividend_per_share: number; per_share_bonus: number }[] }>(
    "/api/a-share/corporate-actions/adjustment-factors",
    { thscode: code },
    12 * HOUR,
  );
  // 没有除权记录是正常情况，不算 empty
  return mapResult<typeof r extends SourceResult<infer A> ? A : never, CorpAction[]>(
    r,
    (d) => (d.item ?? []).map((x) => ({ exDate: shDate(x.ex_date_ms), cashPerShare: x.dividend_per_share, bonusPerShare: x.per_share_bonus })),
    () => false,
  );
}

export interface IncomeStatement {
  fiscalYear: number;
  fiscalPeriod: string;
  reportDate: string | null;
  periodEnd: string;
  /** 营业收入（年初至报告期末累计，元） */
  operatingIncome: number | null;
  /** 归母净利润（年初至报告期末累计，元） */
  parentNetProfit: number | null;
  basicEps: number | null;
}

export async function incomeStatements(code: string) {
  const r = await call<{ item?: Record<string, number | string | null>[] }>(
    "/api/a-share/financials/income-statements",
    { thscode: code, period: "quarterly", limit: 8 },
    12 * HOUR,
  );
  return mapResult(
    r,
    (d): IncomeStatement[] =>
      (d.item ?? []).map((x) => ({
        fiscalYear: Number(x.fiscal_year),
        fiscalPeriod: String(x.fiscal_period),
        reportDate: x.report_date_ms ? shDate(Number(x.report_date_ms)) : null,
        periodEnd: shDate(Number(x.period_end_ms)),
        operatingIncome: x.operating_income == null ? null : Number(x.operating_income),
        parentNetProfit: x.parent_holder_net_profit == null ? null : Number(x.parent_holder_net_profit),
        basicEps: x.basic_eps == null ? null : Number(x.basic_eps),
      })),
    (l) => l.length === 0,
  );
}

export async function industryOf(code: string) {
  const r = await call<{ item?: { index_list?: { thscode: string; name: string; type: string }[] }[] }>(
    "/api/a-share-index/constituents/ths-index-list-by-stock",
    { thscode: code, type: "industry" },
    24 * HOUR,
  );
  return mapResult(
    r,
    (d) => (d.item?.[0]?.index_list ?? []).map((x) => ({ code: x.thscode, name: x.name })),
    (l) => l.length === 0,
  );
}

export interface NewsItem {
  id: string;
  type: number | null;
  title: string;
  source: string | null;
  summary: string | null;
  publishTs: number | null;
  url: string;
}

type NewsPage = { items?: { id: string; type: number | null; title: string; source: string | null; summary: string | null; publish_time_ms: number | null; jump_url: string }[]; has_more?: boolean; offset?: string };

/**
 * 个股新闻只能从最新一条往前翻页，没有日期筛选。翻到早于 since 为止，最多 maxPages 页。
 * 返回 [since, until] 内的条目，以及是否真的翻到了 since（没翻到就说明结果不完整）。
 */
export async function stockNews(code: string, since: number, until: number, maxPages = 40) {
  const items: NewsItem[] = [];
  let offset = "first";
  let reachedSince = false;
  let last: SourceResult<NewsPage> | null = null;
  const untilDate = shDate(until);
  for (let page = 0; page < maxPages; page++) {
    // 翻页位置会随新新闻变化，所以单页只短期缓存；整段结果另外由证据层缓存
    last = await call<NewsPage>("/api/news/stock/timeline-list", { thscode: code, offset, size: 100 }, untilDate < shDate(Date.now()) ? 6 * HOUR : 0.5 * HOUR);
    if (last.status === "failed" || !last.data) break;
    for (const n of last.data.items ?? []) {
      items.push({ id: n.id, type: n.type, title: n.title, source: n.source, summary: n.summary, publishTs: n.publish_time_ms, url: n.jump_url });
    }
    const times = (last.data.items ?? []).map((n) => n.publish_time_ms).filter((x): x is number => x != null);
    if (times.length && Math.min(...times) < since) {
      reachedSince = true;
      break;
    }
    if (!last.data.has_more || !last.data.offset) {
      reachedSince = true;
      break;
    }
    offset = last.data.offset;
  }
  const within = items.filter((n) => n.publishTs != null && n.publishTs >= since && n.publishTs <= until);
  const status = last?.status === "failed" && !items.length ? "failed" : within.length ? "ok" : "empty";
  return { status, data: within, complete: reachedSince, error: last?.error, meta: last?.meta } as const;
}

export interface Anomaly {
  id: string;
  tag: string;
  tagCode: string;
  keywords: string[];
  content: string;
  publishTs: number | null;
  url: string | null;
}

export async function anomalies(code: string, begin: string, end: string) {
  const r = await call<{ items?: Record<string, unknown>[]; was_truncated?: boolean }>(
    "/api/news/anomaly/analysis",
    { begin_date: begin, end_date: end, thscode: code },
    ttlFor(end),
  );
  return mapResult(
    r,
    (d) => ({
      truncated: Boolean(d.was_truncated),
      items: (d.items ?? []).map(
        (x): Anomaly => ({
          id: String(x.analysis_id),
          tag: String(x.tag_name ?? ""),
          tagCode: String(x.tag_code ?? ""),
          keywords: (x.key_word_list as string[] | null) ?? [],
          content: String(x.analysis_content ?? ""),
          publishTs: typeof x.first_publish_time === "number" ? x.first_publish_time : null,
          url: (x.link_url as string | null) ?? null,
        }),
      ),
    }),
    (v) => v.items.length === 0,
  );
}

export async function hotRank(code: string, start: string, end: string) {
  const r = await call<{ item?: { date: string; rank: number }[] }>(
    "/api/a-share/special-data/hot-stock-rank-trend",
    { thscode: code, start_date: start, end_date: end },
    ttlFor(end),
  );
  return mapResult(r, (d) => (d.item ?? []).map((x) => ({ date: x.date, rank: x.rank })), (l) => l.length === 0);
}

export interface DragonTigerEntry {
  code: string;
  name: string;
  change: number | null;
  netValue: number | null;
}

export async function dragonTiger(date: string) {
  const r = await call<{ trade_date?: string; stock_items?: { thscode: string; name: string; change: number | null; net_value: number | null }[] }>(
    "/api/a-share/special-data/dragon-tiger-list",
    { date, board_type: "all" },
    ttlFor(date),
  );
  return mapResult(
    r,
    (d) => (d.stock_items ?? []).map((x): DragonTigerEntry => ({ code: x.thscode, name: x.name, change: x.change, netValue: x.net_value })),
    (l) => l.length === 0,
  );
}

/** 名称或代码检索 A 股，返回唯一的 thscode 和名称 */
export async function searchTicker(q: string) {
  const r = await call<{ item?: { thscode: string; name: string; asset_type: string }[] }>("/api/meta/tickers/search", { q, limit: 10 }, 24 * HOUR, 5000);
  return mapResult(
    r,
    (d) => (d.item ?? []).filter((x) => /\.(SH|SZ|BJ)$/.test(x.thscode) && /a-share|stock/i.test(x.asset_type)).map((x) => ({ code: x.thscode, name: x.name })),
    (l) => l.length === 0,
  );
}
