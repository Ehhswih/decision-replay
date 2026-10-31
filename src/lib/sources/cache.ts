import "server-only";
import { db } from "@/lib/db";
import type { SourceName, SourceResult } from "./types";

function stableKey(source: SourceName, endpoint: string, params: Record<string, unknown>) {
  const sorted = Object.keys(params)
    .sort()
    .map((k) => [k, params[k]]);
  return `${source}:${endpoint}:${JSON.stringify(sorted)}`;
}

function log(r: SourceResult<unknown>, fromCache: boolean) {
  db()
    .prepare(
      "INSERT INTO call_log (source, endpoint, params, status, code, message, latency_ms, from_cache, at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
    )
    .run(
      r.meta.source,
      r.meta.endpoint,
      JSON.stringify(r.meta.params),
      r.status,
      r.error?.code == null ? null : String(r.error.code),
      r.error?.message ?? null,
      r.meta.latencyMs,
      fromCache ? 1 : 0,
      Date.now(),
    );
}

/**
 * 带缓存的调用。ttlMs 为 null 表示永久有效（已经收盘的历史数据不会再变）。
 * 只缓存成功的结果；这次调用失败但有旧缓存时，返回旧数据并标记为 stale。
 */
export async function cached<T>(
  source: SourceName,
  endpoint: string,
  params: Record<string, unknown>,
  ttlMs: number | null,
  run: () => Promise<SourceResult<T>>,
): Promise<SourceResult<T>> {
  const key = stableKey(source, endpoint, params);
  const row = db().prepare("SELECT payload, fetched_at FROM cache WHERE key = ?").get(key) as
    | { payload: string; fetched_at: number }
    | undefined;
  const fresh = row && (ttlMs == null || row.fetched_at + ttlMs > Date.now());
  if (row && fresh) {
    const hit: SourceResult<T> = JSON.parse(row.payload);
    hit.meta = { ...hit.meta, fromCache: true, fetchedAt: row.fetched_at };
    log(hit, true);
    return hit;
  }

  const live = await run();
  log(live, false);
  if (live.status === "ok" || live.status === "empty") {
    db()
      .prepare("INSERT OR REPLACE INTO cache (key, source, endpoint, params, payload, fetched_at) VALUES (?, ?, ?, ?, ?, ?)")
      .run(key, source, endpoint, JSON.stringify(params), JSON.stringify(live), live.meta.fetchedAt);
    return live;
  }
  if (row) {
    const old: SourceResult<T> = JSON.parse(row.payload);
    return { ...old, status: "stale", error: live.error, meta: { ...old.meta, fromCache: true, fetchedAt: row.fetched_at } };
  }
  return live;
}

/** iFinD 实际调用次数（不含缓存命中），用来控制免费额度 */
export function ifindLiveCalls(): number {
  const r = db()
    .prepare("SELECT COUNT(*) AS n FROM call_log WHERE source = 'ifind' AND from_cache = 0 AND endpoint LIKE 'tools/call:%'")
    .get() as { n: number };
  return r.n;
}
