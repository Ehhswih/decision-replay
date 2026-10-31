import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { addDays, normalizeDate, parseShDateTime, shDate, shDateTime } from "@/lib/time";
import { barTiming, classify, dayTiming, derivedTiming, nextDayTiming } from "@/lib/domain/pit";

const at = (s: string) => parseShDateTime(s)!.ms;

// 开发机是 UTC-4。两个时区各跑一遍，结果必须一样
for (const tz of ["Asia/Shanghai", "America/New_York"]) {
  describe(`时点切分（TZ=${tz}）`, () => {
    const original = process.env.TZ;
    beforeAll(() => {
      process.env.TZ = tz;
    });
    afterAll(() => {
      process.env.TZ = original;
    });

    it("成交时间按北京时间解析", () => {
      expect(at("2026-06-22 14:41")).toBe(Date.UTC(2026, 5, 22, 6, 41));
      expect(shDateTime(at("2026-06-22 14:41"))).toBe("2026-06-22 14:41");
      expect(shDate(Date.UTC(2026, 5, 22, 16, 30))).toBe("2026-06-23");
    });

    it("只有日期的成交按 09:30 处理并标记时刻未知", () => {
      const p = parseShDateTime("2026/6/22")!;
      expect(p.timeKnown).toBe(false);
      expect(shDateTime(p.ms)).toBe("2026-06-22 09:30");
    });

    it("盘中成交：当天日 K 算事后，前一天日 K 算当时可知", () => {
      const t = at("2026-06-22 14:41");
      expect(classify(barTiming("2026-06-22"), t)).toBe("ex_post");
      expect(classify(barTiming("2026-06-19"), t)).toBe("ex_ante");
    });

    it("15:00 收盘竞价成交时，当天日 K 算当时可知", () => {
      expect(classify(barTiming("2026-06-22"), at("2026-06-22 15:00"))).toBe("ex_ante");
    });

    it("精确到天的数据：同一天算时序不确定", () => {
      const t = at("2026-04-25 10:00");
      expect(classify(dayTiming("2026-04-25"), t)).toBe("uncertain");
      expect(classify(dayTiming("2026-04-24"), t)).toBe("ex_ante");
      expect(classify(dayTiming("2026-04-26"), t)).toBe("ex_post");
    });

    it("精确到毫秒的新闻：晚一分钟就是事后", () => {
      const t = at("2026-07-01 10:12");
      expect(classify({ availableAt: t - 1, precision: "ms" }, t)).toBe("ex_ante");
      expect(classify({ availableAt: t + 60_000, precision: "ms" }, t)).toBe("ex_post");
    });

    it("热股排名和龙虎榜：第 D 天的数据第二天才算可知", () => {
      expect(classify(nextDayTiming("2026-06-18"), at("2026-06-18 14:30"))).toBe("ex_post");
      expect(classify(nextDayTiming("2026-06-17"), at("2026-06-18 09:31"))).toBe("ex_ante");
    });

    it("非时点数据和缺少可知时间的数据一律时序不确定", () => {
      const t = at("2026-07-01 10:12");
      expect(classify({ availableAt: 0, precision: "ms", nonPit: true }, t)).toBe("uncertain");
      expect(classify({ availableAt: null, precision: "ms" }, t)).toBe("uncertain");
    });

    it("派生指标取输入里最晚的可知时间", () => {
      const t = at("2026-06-22 14:41");
      const d = derivedTiming([barTiming("2026-06-15"), barTiming("2026-06-22")]);
      expect(classify(d, t)).toBe("ex_post");
      expect(classify(derivedTiming([barTiming("2026-06-15"), barTiming("2026-06-18")]), t)).toBe("ex_ante");
      expect(derivedTiming([barTiming("2026-06-15"), { availableAt: 1, precision: "ms", nonPit: true }]).availableAt).toBeNull();
    });
  });
}

describe("日期规范化", () => {
  it("接受常见写法，拒绝不存在的日期", () => {
    expect(normalizeDate("2026-6-3")).toBe("2026-06-03");
    expect(normalizeDate("20260603")).toBe("2026-06-03");
    expect(normalizeDate("2026年6月3日")).toBe("2026-06-03");
    expect(normalizeDate("2026-02-30")).toBeNull();
    expect(addDays("2026-06-30", 1)).toBe("2026-07-01");
  });
});

import { isLikelyOriginalDisclosure } from "@/lib/domain/evidence";

describe("财报披露日是否可信", () => {
  it("法定期限内（含 15 天宽限）算首次披露，远超期限的当作重述日期排除", () => {
    expect(isLikelyOriginalDisclosure("2026-03-31", "2026-04-30")).toBe(true);
    expect(isLikelyOriginalDisclosure("2026-06-30", "2026-08-19")).toBe(true);
    expect(isLikelyOriginalDisclosure("2025-12-31", "2026-03-31")).toBe(true);
    expect(isLikelyOriginalDisclosure("2024-12-31", "2026-03-31")).toBe(false); // 2024 年报显示 2026 年披露
    expect(isLikelyOriginalDisclosure("2025-03-31", "2026-04-30")).toBe(false); // 2025 一季报显示 2026 年披露
  });
});
