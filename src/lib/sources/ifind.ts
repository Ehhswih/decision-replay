// iFinD MCP 客户端（streamable HTTP 上的 JSON-RPC）。只做协议和解析，缓存和额度在 ifind-api.ts。

import { normalizeDate } from "@/lib/time";
import type { SourceResult } from "./types";

export interface IfindConfig {
  url: string | undefined;
  auth: string | undefined;
  fetchImpl?: typeof fetch;
}

let session: { id: string | null; url: string } | null = null;

async function rpc(cfg: IfindConfig, payload: object, sessionId: string | null) {
  const res = await (cfg.fetchImpl ?? fetch)(cfg.url as string, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      Authorization: cfg.auth as string,
      ...(sessionId ? { "Mcp-Session-Id": sessionId } : {}),
    },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(30_000),
    cache: "no-store",
  });
  const text = await res.text();
  let body: unknown = null;
  if ((res.headers.get("content-type") ?? "").includes("text/event-stream")) {
    for (const line of text.split(/\r?\n/)) {
      if (!line.startsWith("data:")) continue;
      try {
        body = JSON.parse(line.slice(5));
      } catch {
        /* 跳过非 JSON 的事件行 */
      }
    }
  } else if (text) {
    try {
      body = JSON.parse(text);
    } catch {
      body = text;
    }
  }
  return { status: res.status, sessionId: res.headers.get("mcp-session-id") ?? sessionId, body };
}

async function ensureSession(cfg: IfindConfig, force = false) {
  if (session && session.url === cfg.url && !force) return session.id;
  const init = await rpc(
    cfg,
    { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "decision-replay", version: "0.1" } } },
    null,
  );
  if (init.status >= 400) throw new Error(`initialize 失败：HTTP ${init.status}`);
  await rpc(cfg, { jsonrpc: "2.0", method: "notifications/initialized" }, init.sessionId);
  session = { id: init.sessionId, url: cfg.url as string };
  return session.id;
}

export interface IfindDoc {
  title: string;
  content: string;
  date: string | null;
  url: string | null;
  /** 片段是 iFinD 用 AI 生成的解读，而不是原文 */
  aiGenerated: boolean;
}

/**
 * 解析 tools/call 的返回。成功时 code=1（扶摇是 0，两边约定不同），
 * data 可能是 JSON 字符串，也可能再包一层 { data: "..." }。
 */
export function parseToolResult(body: unknown): { ok: true; docs: IfindDoc[] } | { ok: false; message: string; quota: boolean } {
  const result = (body as { result?: { content?: { text?: string }[]; isError?: boolean }; error?: { message?: string } })?.result;
  const rpcError = (body as { error?: { message?: string } })?.error;
  if (rpcError) return { ok: false, message: rpcError.message ?? "JSON-RPC 错误", quota: /额度|次数|quota/i.test(rpcError.message ?? "") };
  const text = (result?.content ?? []).map((c) => c.text ?? "").join("");
  if (!text) return { ok: false, message: "返回内容为空", quota: false };
  let outer: { code?: number; msg?: string; data?: unknown };
  try {
    outer = JSON.parse(text);
  } catch {
    return { ok: false, message: text.slice(0, 200), quota: /额度|次数/.test(text) };
  }
  if (result?.isError || outer.code !== 1) {
    const msg = outer.msg ?? text.slice(0, 200);
    return { ok: false, message: msg, quota: /额度|次数|quota/i.test(msg) };
  }
  let data: unknown = outer.data;
  if (data && typeof data === "object" && !Array.isArray(data) && "data" in data) data = (data as { data: unknown }).data;
  if (typeof data === "string") {
    try {
      data = JSON.parse(data);
    } catch {
      return { ok: false, message: "data 字段不是合法 JSON", quota: false };
    }
  }
  if (!Array.isArray(data)) return { ok: true, docs: [] };
  const docs = data.map((x: Record<string, string>) => {
    const content = x["资讯内容"] ?? x["公告片段内容"] ?? "";
    return {
      title: x["资讯标题"] ?? x["公告标题"] ?? "",
      content,
      date: normalizeDate(String(x["日期"] ?? "")),
      url: x["URL"] ?? null,
      aiGenerated: /^\s*(根据提供的材料|根据材料|以下是对)/.test(content),
    };
  });
  return { ok: true, docs };
}

export async function ifindCallTool(cfg: IfindConfig, name: string, args: Record<string, unknown>): Promise<SourceResult<IfindDoc[]>> {
  const started = Date.now();
  const meta = { source: "ifind" as const, endpoint: `tools/call:${name}`, params: args, fetchedAt: started, fromCache: false, latencyMs: null as number | null, attempts: 1 };
  if (!cfg.url || !cfg.auth) return { status: "failed", data: null, error: { kind: "config", message: "服务端没有配置 iFinD MCP" }, meta };
  try {
    let sid = await ensureSession(cfg);
    let r = await rpc(cfg, { jsonrpc: "2.0", id: Date.now(), method: "tools/call", params: { name, arguments: args } }, sid);
    if (r.status === 404 || r.status === 400) {
      // 会话过期：重建一次
      sid = await ensureSession(cfg, true);
      meta.attempts = 2;
      r = await rpc(cfg, { jsonrpc: "2.0", id: Date.now(), method: "tools/call", params: { name, arguments: args } }, sid);
    }
    meta.latencyMs = Date.now() - started;
    meta.fetchedAt = Date.now();
    if (r.status === 401 || r.status === 403) return { status: "failed", data: null, error: { kind: "auth", code: r.status, message: "iFinD 密钥无效或已过期" }, meta };
    if (r.status === 429) return { status: "failed", data: null, error: { kind: "rate_limit", code: 429, message: "iFinD 请求过于频繁" }, meta };
    if (r.status >= 500) return { status: "failed", data: null, error: { kind: "upstream", code: r.status, message: `iFinD 服务异常 HTTP ${r.status}` }, meta };
    const parsed = parseToolResult(r.body);
    if (!parsed.ok) return { status: "failed", data: null, error: { kind: parsed.quota ? "quota" : "upstream", message: parsed.message }, meta };
    return { status: parsed.docs.length ? "ok" : "empty", data: parsed.docs, meta };
  } catch (e) {
    meta.latencyMs = Date.now() - started;
    const timeout = e instanceof Error && (e.name === "TimeoutError" || e.name === "AbortError");
    const cause = e instanceof Error && e.cause instanceof Error ? `（${e.cause.message}）` : "";
    return { status: "failed", data: null, error: { kind: timeout ? "timeout" : "network", message: (e instanceof Error ? e.message : String(e)) + cause }, meta };
  }
}

/** 网络错误时重建会话再试一次 */
export async function ifindCallToolWithRetry(cfg: IfindConfig, name: string, args: Record<string, unknown>) {
  const first = await ifindCallTool(cfg, name, args);
  if (first.status !== "failed" || (first.error?.kind !== "network" && first.error?.kind !== "timeout")) return first;
  session = null;
  await new Promise((r) => setTimeout(r, 1000));
  const second = await ifindCallTool(cfg, name, args);
  second.meta.attempts = 2;
  return second;
}
