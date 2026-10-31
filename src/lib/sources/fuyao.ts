// 扶摇 REST 客户端：只负责一次请求的重试、超时和错误映射，不碰缓存和数据库，方便单测。

import type { ErrorKind, SourceResult } from "./types";

const BASE = "https://fuyao.aicubes.cn";

export interface RequestOptions {
  apiKey: string | undefined;
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  timeoutMs?: number;
}

/** 扶摇的业务码和 HTTP 状态 → 错误类型、是否值得重试 */
export function mapFuyaoError(httpStatus: number, code: number | undefined): { kind: ErrorKind; retryable: boolean } {
  if (httpStatus === 429 || code === 4001) return { kind: "rate_limit", retryable: true };
  switch (code) {
    case 2001:
      return { kind: "auth", retryable: false };
    case 2003:
      return { kind: "permission", retryable: false };
    case 1001:
    case 1002:
    case 1003:
    case 1004:
      return { kind: "bad_param", retryable: false };
    case 3001:
      return { kind: "not_found", retryable: false };
    case 3002:
      return { kind: "not_ready", retryable: false };
    case 3004:
      return { kind: "unsupported", retryable: false };
    case 5001:
    case 5002:
    case 5003:
      return { kind: "upstream", retryable: true };
  }
  if (httpStatus >= 500) return { kind: "upstream", retryable: true };
  return { kind: "parse", retryable: false };
}

const RETRY_DELAYS: Partial<Record<ErrorKind, number[]>> = {
  rate_limit: [1000, 2000, 4000],
  upstream: [500, 1500],
  timeout: [500, 1500],
  network: [500, 1500],
};

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export async function fuyaoRequest<T = unknown>(
  endpoint: string,
  params: Record<string, string | number>,
  opts: RequestOptions,
): Promise<SourceResult<T>> {
  const started = Date.now();
  const meta = { source: "fuyao" as const, endpoint, params, fetchedAt: started, fromCache: false, latencyMs: null as number | null, attempts: 0 };
  if (!opts.apiKey) {
    return { status: "failed", data: null, error: { kind: "config", message: "服务端没有配置 FUYAO_API_KEY" }, meta };
  }
  const fetchImpl = opts.fetchImpl ?? fetch;
  const sleep = opts.sleep ?? defaultSleep;
  const url = `${BASE}${endpoint}?${new URLSearchParams(Object.entries(params).map(([k, v]) => [k, String(v)]))}`;

  let lastError: { kind: ErrorKind; code?: number; message: string } = { kind: "network", message: "未发起请求" };
  for (let attempt = 0; ; attempt++) {
    meta.attempts = attempt + 1;
    let retryable = false;
    try {
      const res = await fetchImpl(url, {
        headers: { "X-api-key": opts.apiKey },
        signal: AbortSignal.timeout(opts.timeoutMs ?? 15_000),
        cache: "no-store",
      });
      const body = (await res.json().catch(() => null)) as { code?: number; message?: string; data?: unknown } | null;
      if (res.ok && body?.code === 0) {
        meta.latencyMs = Date.now() - started;
        meta.fetchedAt = Date.now();
        return { status: "ok", data: (body.data ?? null) as T, meta };
      }
      const mapped = mapFuyaoError(res.status, body?.code);
      retryable = mapped.retryable;
      lastError = { kind: mapped.kind, code: body?.code ?? res.status, message: body?.message ?? `HTTP ${res.status}` };
    } catch (e) {
      const isTimeout = e instanceof Error && (e.name === "TimeoutError" || e.name === "AbortError");
      lastError = { kind: isTimeout ? "timeout" : "network", message: e instanceof Error ? e.message : String(e) };
      retryable = true;
    }
    const delays = RETRY_DELAYS[lastError.kind] ?? [];
    if (!retryable || attempt >= delays.length) break;
    await sleep(delays[attempt]);
  }
  meta.latencyMs = Date.now() - started;
  return { status: "failed", data: null, error: lastError, meta };
}
