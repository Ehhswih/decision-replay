// 止损和目标按写下的时间生效：某个时刻的计划，是那之前最近一次写了止损（目标）的买入。
// 后来加仓时才写的计划，不能拿去评价之前的卖出。

import type { Trade } from "./types";

export interface PlanAt {
  stop: number | null;
  /** 写下这条止损的那笔买入的时间；之前的行情不按这条止损核对 */
  stopSince: number | null;
  target: number | null;
  targetSince: number | null;
}

export function planAt(trades: Pick<Trade, "side" | "ts" | "planStop" | "planTarget">[], ts: number): PlanAt {
  const buys = trades.filter((t) => t.side === "buy" && t.ts <= ts).reverse();
  const s = buys.find((t) => t.planStop != null);
  const g = buys.find((t) => t.planTarget != null);
  return { stop: s?.planStop ?? null, stopSince: s?.ts ?? null, target: g?.planTarget ?? null, targetSince: g?.ts ?? null };
}
