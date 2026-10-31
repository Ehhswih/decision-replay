import "server-only";

export type LlmResult<T> =
  | { ok: true; data: T; latencyMs: number; model: string; usage: { prompt: number; completion: number; reasoning: number } }
  | { ok: false; kind: "config" | "timeout" | "network" | "api" | "parse" | "empty"; message: string; latencyMs: number };

/**
 * 调 DeepSeek（OpenAI 兼容接口），要求 JSON 输出。
 * deepseek-flash 是推理模型，会先消耗思考 token，max_tokens 要留够，否则正文为空。
 */
export async function chatJson<T>(system: string, user: string, opts: { maxTokens?: number; timeoutMs?: number } = {}): Promise<LlmResult<T>> {
  // 偶发的 JSON 不完整、空输出、网络抖动，重试一次通常就好；仍失败时由调用方降级
  const first = await chatJsonOnce<T>(system, user, opts);
  if (first.ok || !["parse", "empty", "network", "timeout"].includes(first.kind)) return first;
  const second = await chatJsonOnce<T>(system, user, opts);
  if (!second.ok) return { ...second, message: `重试后仍失败：${second.message}（第一次：${first.message.slice(0, 60)}）`, latencyMs: first.latencyMs + second.latencyMs };
  return { ...second, latencyMs: first.latencyMs + second.latencyMs };
}

async function chatJsonOnce<T>(system: string, user: string, opts: { maxTokens?: number; timeoutMs?: number }): Promise<LlmResult<T>> {
  const started = Date.now();
  const key = process.env.DEEPSEEK_API_KEY;
  const model = process.env.DEEPSEEK_MODEL || "deepseek-flash";
  if (!key) return { ok: false, kind: "config", message: "服务端没有配置 DEEPSEEK_API_KEY", latencyMs: 0 };
  let res: Response;
  try {
    res = await fetch("https://api.deepseek.com/chat/completions", {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model,
        messages: [
          { role: "system", content: system },
          { role: "user", content: user },
        ],
        response_format: { type: "json_object" },
        temperature: 0.2,
        max_tokens: opts.maxTokens ?? 8000,
      }),
      signal: AbortSignal.timeout(opts.timeoutMs ?? 150_000),
      cache: "no-store",
    });
  } catch (e) {
    const timeout = e instanceof Error && (e.name === "TimeoutError" || e.name === "AbortError");
    return { ok: false, kind: timeout ? "timeout" : "network", message: e instanceof Error ? e.message : String(e), latencyMs: Date.now() - started };
  }
  const body = (await res.json().catch(() => null)) as {
    choices?: { message?: { content?: string }; finish_reason?: string }[];
    usage?: { prompt_tokens?: number; completion_tokens?: number; completion_tokens_details?: { reasoning_tokens?: number } };
    error?: { message?: string };
  } | null;
  const latencyMs = Date.now() - started;
  if (!res.ok) return { ok: false, kind: "api", message: body?.error?.message ?? `HTTP ${res.status}`, latencyMs };
  const content = body?.choices?.[0]?.message?.content ?? "";
  if (!content.trim()) {
    return { ok: false, kind: "empty", message: `模型没有返回正文（finish_reason=${body?.choices?.[0]?.finish_reason ?? "?"}，可能是思考过程用完了 max_tokens）`, latencyMs };
  }
  try {
    return {
      ok: true,
      data: JSON.parse(content) as T,
      latencyMs,
      model,
      usage: {
        prompt: body?.usage?.prompt_tokens ?? 0,
        completion: body?.usage?.completion_tokens ?? 0,
        reasoning: body?.usage?.completion_tokens_details?.reasoning_tokens ?? 0,
      },
    };
  } catch {
    return { ok: false, kind: "parse", message: `模型输出不是合法 JSON：${content.slice(0, 120)}`, latencyMs };
  }
}
