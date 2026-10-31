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

async function search(tool: "search_news" | "search_notice", query: string, start: string, end: string, size: number) {
  const params = { query, time_start: start, time_end: end, size };
  const ttl = end < shDate(Date.now()) ? null : 3600_000;
  return cached<IfindDoc[]>("ifind", `tools/call:${tool}`, params, ttl, async (): Promise<SourceResult<IfindDoc[]>> => {
    if (ifindQuota().remaining <= 0) {
      return {
        status: "failed",
        data: null,
        error: { kind: "quota", message: "已达到 iFinD 调用上限，只使用扶摇数据" },
        meta: { source: "ifind", endpoint: `tools/call:${tool}`, params, fetchedAt: Date.now(), fromCache: false, latencyMs: null, attempts: 0 },
      };
    }
    return ifindCallToolWithRetry(config(), tool, params);
  });
}

/** 注意：iFinD 的时间范围不是硬过滤，调用方必须按 date 重新归类 */
export function searchNews(query: string, start: string, end: string, size = 10) {
  return search("search_news", query, start, end, size);
}

export function searchNotice(query: string, start: string, end: string, size = 10) {
  return search("search_notice", query, start, end, size);
}
