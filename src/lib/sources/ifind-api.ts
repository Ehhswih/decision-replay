import "server-only";
import { shDate } from "@/lib/time";
import { cached, ifindLiveCalls } from "./cache";
import { ifindCallToolWithRetry, type IfindDoc } from "./ifind";
import type { SourceResult } from "./types";

function config() {
  return { url: process.env.IFIND_MCP_URL, auth: process.env.IFIND_MCP_AUTH };
}

export function ifindQuota() {
  const limit = Number(process.env.IFIND_QUOTA_LIMIT ?? 1800);
  const used = ifindLiveCalls();
  return { used, limit, remaining: Math.max(0, limit - used) };
}

// 熔断：连不上 iFinD 时每次调用都要等十几秒超时，一个组合几十个持仓段会拖上好几分钟。
// 连续 2 次网络失败后暂停调用 10 分钟，这期间直接返回失败（照样标成“未取到”，不当作正常）。
const BREAKER_FAILS = 2;
const BREAKER_MS = 10 * 60_000;
const breaker = { fails: 0, openUntil: 0 };

export function resetIfindBreaker() {
  breaker.fails = 0;
  breaker.openUntil = 0;
}

async function search(tool: "search_news" | "search_notice", query: string, start: string, end: string, size: number) {
  const params = { query, time_start: start, time_end: end, size };
  const ttl = end < shDate(Date.now()) ? null : 3600_000;
  const fail = (kind: "quota" | "network", message: string): SourceResult<IfindDoc[]> => ({
    status: "failed",
    data: null,
    error: { kind, message },
    meta: { source: "ifind", endpoint: `tools/call:${tool}`, params, fetchedAt: Date.now(), fromCache: false, latencyMs: null, attempts: 0 },
  });
  return cached<IfindDoc[]>("ifind", `tools/call:${tool}`, params, ttl, async (): Promise<SourceResult<IfindDoc[]>> => {
    if (ifindQuota().remaining <= 0) return fail("quota", "已达到 iFinD 调用上限，只使用扶摇数据");
    if (Date.now() < breaker.openUntil) return fail("network", "iFinD 连续连接失败，暂停调用 10 分钟，这次没有取公告");
    const r = await ifindCallToolWithRetry(config(), tool, params);
    if (r.status === "failed" && (r.error?.kind === "network" || r.error?.kind === "timeout")) {
      if (++breaker.fails >= BREAKER_FAILS) breaker.openUntil = Date.now() + BREAKER_MS;
    } else breaker.fails = 0;
    return r;
  });
}

/** 注意：iFinD 的时间范围不是硬过滤，调用方必须按 date 重新归类 */
export function searchNews(query: string, start: string, end: string, size = 10) {
  return search("search_news", query, start, end, size);
}

export function searchNotice(query: string, start: string, end: string, size = 10) {
  return search("search_notice", query, start, end, size);
}
