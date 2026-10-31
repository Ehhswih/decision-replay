import { describe, expect, it } from "vitest";
import { rateLimit } from "@/lib/rate-limit";

describe("限流", () => {
  it("窗口内超过次数就拒绝，并给出等待秒数", () => {
    for (let i = 0; i < 3; i++) expect(rateLimit("t1", 3, 60_000).ok).toBe(true);
    const r = rateLimit("t1", 3, 60_000);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.retryAfter).toBeGreaterThan(0);
    expect(rateLimit("t2", 3, 60_000).ok).toBe(true); // 不同访客互不影响
  });
});
