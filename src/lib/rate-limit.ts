import "server-only";

// 进程内的简单限流：线上地址是公开的，防止决策前检查和复盘生成被刷，耗光数据源和模型额度。
const hits = new Map<string, number[]>();

export function clientKey(req: Request): string {
  return req.headers.get("x-forwarded-for")?.split(",")[0].trim() || req.headers.get("x-real-ip") || "local";
}

/** 每个 key 在 windowMs 内最多 limit 次；超过返回需要等待的秒数 */
export function rateLimit(key: string, limit: number, windowMs: number): { ok: true } | { ok: false; retryAfter: number } {
  const now = Date.now();
  const list = (hits.get(key) ?? []).filter((t) => now - t < windowMs);
  if (list.length >= limit) {
    hits.set(key, list);
    return { ok: false, retryAfter: Math.ceil((windowMs - (now - list[0])) / 1000) };
  }
  list.push(now);
  hits.set(key, list);
  return { ok: true };
}
