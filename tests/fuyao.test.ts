import { describe, expect, it, vi } from "vitest";
import { fuyaoRequest, mapFuyaoError } from "@/lib/sources/fuyao";

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const noSleep = async (ms: number) => void ms;

describe("扶摇错误映射", () => {
  it("业务码映射到错误类型", () => {
    expect(mapFuyaoError(200, 2001)).toEqual({ kind: "auth", retryable: false });
    expect(mapFuyaoError(200, 3002)).toEqual({ kind: "not_ready", retryable: false });
    expect(mapFuyaoError(429, undefined)).toEqual({ kind: "rate_limit", retryable: true });
    expect(mapFuyaoError(200, 5002)).toEqual({ kind: "upstream", retryable: true });
  });
});

describe("扶摇请求", () => {
  it("HTTP 200 但 code 不为 0 不能当成功", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(json({ code: 2001, message: "invalid api key", data: null }));
    const r = await fuyaoRequest("/x", {}, { apiKey: "k", fetchImpl, sleep: noSleep });
    expect(r.status).toBe("failed");
    expect(r.error).toMatchObject({ kind: "auth", code: 2001 });
    expect(fetchImpl).toHaveBeenCalledTimes(1); // 鉴权错误不重试
  });

  it("限流后退避重试，最终成功", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(json({ code: 4001, message: "rate limited" }))
      .mockResolvedValueOnce(new Response("Too Many Requests", { status: 429 }))
      .mockResolvedValueOnce(json({ code: 0, message: "success", data: { item: [1] } }));
    const sleep = vi.fn(noSleep);
    const r = await fuyaoRequest("/x", {}, { apiKey: "k", fetchImpl, sleep });
    expect(r.status).toBe("ok");
    expect(r.meta.attempts).toBe(3);
    expect(sleep.mock.calls.map((c) => c[0])).toEqual([1000, 2000]);
  });

  it("上游持续超时：有界重试后返回失败", async () => {
    const fetchImpl = vi.fn().mockImplementation(async () => json({ code: 5002, message: "upstream timeout" }));
    const r = await fuyaoRequest("/x", {}, { apiKey: "k", fetchImpl, sleep: noSleep });
    expect(r.status).toBe("failed");
    expect(r.error?.kind).toBe("upstream");
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });

  it("网络异常会重试", async () => {
    const fetchImpl = vi.fn().mockRejectedValueOnce(new TypeError("fetch failed")).mockResolvedValueOnce(json({ code: 0, data: {} }));
    const r = await fuyaoRequest("/x", {}, { apiKey: "k", fetchImpl, sleep: noSleep });
    expect(r.status).toBe("ok");
  });

  it("没配置 Key 时直接失败，不发请求", async () => {
    const fetchImpl = vi.fn();
    const r = await fuyaoRequest("/x", {}, { apiKey: undefined, fetchImpl });
    expect(r.error?.kind).toBe("config");
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
