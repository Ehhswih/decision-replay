// 时点切分：判断一条信息相对决策时刻 t 是"当时可知""事后才知"还是"时序不确定"。
// 规则见 docs/design.md 第 3 节。

import { DAY_MS, atShTime, marketCloseMs, shDate } from "@/lib/time";

export type Precision = "ms" | "day";
export type Timing = "ex_ante" | "ex_post" | "uncertain";

export interface Timed {
  /** 最早能被投资者知道的时刻；未知时为 null */
  availableAt: number | null;
  precision: Precision;
  /** 非时点数据（例如只有当前的行业归属） */
  nonPit?: boolean;
}

export function classify(item: Timed, t: number): Timing {
  if (item.nonPit || item.availableAt == null) return "uncertain";
  if (item.precision === "ms") return item.availableAt <= t ? "ex_ante" : "ex_post";
  const a = shDate(item.availableAt);
  const d = shDate(t);
  if (a < d) return "ex_ante";
  if (a === d) return "uncertain";
  return "ex_post";
}

export const TIMING_LABEL: Record<Timing, string> = {
  ex_ante: "当时可知",
  ex_post: "事后才知",
  uncertain: "时序不确定",
};

/** 第 D 日日 K：收盘后才完整 */
export function barTiming(date: string): Timed {
  return { availableAt: marketCloseMs(date), precision: "ms" };
}

/** 收盘后才发布的日度数据（热股排名、龙虎榜）：保守按第二天 0 点算 */
export function nextDayTiming(date: string): Timed {
  return { availableAt: atShTime(date) + DAY_MS, precision: "ms" };
}

/** 只精确到天的数据（财报披露日、iFinD 新闻和公告） */
export function dayTiming(date: string): Timed {
  return { availableAt: atShTime(date), precision: "day" };
}

/** 程序算出的指标：取所有输入里最晚的可知时间；任何一个输入不确定，结果也不确定 */
export function derivedTiming(inputs: Timed[]): Timed {
  if (!inputs.length || inputs.some((i) => i.availableAt == null || i.nonPit)) {
    return { availableAt: null, precision: "ms" };
  }
  const latest = inputs.reduce((a, b) => ((b.availableAt as number) > (a.availableAt as number) ? b : a));
  return { availableAt: latest.availableAt, precision: inputs.some((i) => i.precision === "day") ? "day" : "ms" };
}
