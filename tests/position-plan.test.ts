// 持仓成本、计划生效时间、止损核对和过度交易判定的边界情况
import { describe, expect, it } from "vitest";
import { adjustedCostPath, drawdownBefore, type Series } from "@/lib/domain/evidence";
import { planAt } from "@/lib/domain/plan";
import { portfolioBiases, type EpisodeSummary } from "@/lib/domain/biases";
import { buildEpisodes } from "@/lib/domain/position";
import { exAntePack, realIds } from "@/lib/ai/pack";
import type { Evidence } from "@/lib/domain/evidence";
import type { Bar, Episode, EpisodeTrade, Trade } from "@/lib/domain/types";

const at = (date: string, time = "10:00") => Date.parse(`${date}T${time}:00+08:00`);
const bar = (date: string, close: number): Bar => ({ date, open: close, high: close * 1.05, low: close * 0.95, close, volume: 1, turnover: 1 });

function trade(id: string, side: "buy" | "sell", date: string, price: number, qty: number, extra: Partial<EpisodeTrade> = {}): EpisodeTrade {
  return { id, rowNo: 2, ts: at(date), timeKnown: true, code: "600001.SH", name: "测试股份", side, price, qty, fee: 0, reason: null, planStop: null, planTarget: null, positionAfter: 0, ...extra };
}

function episode(trades: EpisodeTrade[]): Episode {
  return { id: "ep", code: "600001.SH", name: "测试股份", openTs: trades[0].ts, closeTs: null, trades, corpEvents: [], buyCost: 0, sellProceeds: 0, dividends: 0, fees: 0, realizedPnl: null, returnPct: null, maxPosition: 0 };
}

describe("持仓成本", () => {
  it("10 送 10 之后再减仓、加仓：复权股数跟着价格一起调整，均价是 55 不是 60", () => {
    // 6-03 除权（10 送 10），前复权把之前的价格减半
    const raw = [bar("2026-06-01", 100), bar("2026-06-03", 50), bar("2026-06-04", 60), bar("2026-06-05", 55)];
    const series: Series = { raw, adj: raw.map((b) => (b.date < "2026-06-03" ? { ...b, close: b.close / 2 } : b)) };
    const ep = episode([
      trade("b1", "buy", "2026-06-01", 100, 100),
      trade("s1", "sell", "2026-06-03", 50, 100), // 送转后持有 200 股，卖掉一半
      trade("b2", "buy", "2026-06-04", 60, 100),
    ]);
    const path = adjustedCostPath(ep, series)!;
    expect(path.map((p) => +p.avgCost.toFixed(4))).toEqual([50, 50, 55]);
  });
});

describe("计划按写下的时间生效", () => {
  // 6-01 买 200 股，没写计划；6-02 收盘跌 10%；6-04 减仓；6-05 加仓时才写止损 8%
  const raw = [bar("2026-06-01", 100), bar("2026-06-02", 90), bar("2026-06-03", 92), bar("2026-06-04", 91), bar("2026-06-05", 90), bar("2026-06-08", 86), bar("2026-06-09", 87)];
  const series: Series = { raw, adj: raw };
  const trades = [
    trade("b1", "buy", "2026-06-01", 100, 200),
    trade("s1", "sell", "2026-06-04", 91, 100),
    trade("b2", "buy", "2026-06-05", 90, 100, { planStop: 8 }),
    trade("s2", "sell", "2026-06-09", 87, 200),
  ];
  const ep = episode(trades);

  it("减仓时还没写计划：这笔减仓没有可对照的止损", () => {
    expect(planAt(trades, trades[1].ts)).toMatchObject({ stop: null, target: null });
  });

  it("清仓时对照 6-05 写下的止损，只从那之后核对，6-02 的下跌不算跌破", () => {
    const plan = planAt(trades, trades[3].ts);
    expect(plan).toMatchObject({ stop: 8, stopSince: trades[2].ts });
    const withSince = drawdownBefore(ep, series, trades[3].ts, plan.stop, null, { stop: plan.stopSince });
    // 加仓后均价 95，6-08 收盘 86，跌了 9.5%
    expect(withSince?.stopBreach?.date).toBe("2026-06-08");
    const ignoringTime = drawdownBefore(ep, series, trades[3].ts, plan.stop);
    expect(ignoringTime?.stopBreach?.date).toBe("2026-06-02");
  });

  it("后来写的计划更新了止损：以卖出前最近一次写下的为准", () => {
    const t = [trade("b1", "buy", "2026-06-01", 100, 100, { planStop: 8 }), trade("b2", "buy", "2026-06-05", 90, 100, { planStop: 5, planTarget: 20 })];
    expect(planAt(t, at("2026-06-03"))).toMatchObject({ stop: 8, target: null });
    expect(planAt(t, at("2026-06-08"))).toMatchObject({ stop: 5, target: 20 });
  });
});

describe("止损核对包括买入当天", () => {
  it("盘中 100 元买入、当天收盘 90 元，之后涨回来：最大浮亏 -10%，止损线在买入当天就被跌破", () => {
    const raw = [bar("2026-06-01", 90), bar("2026-06-02", 101), bar("2026-06-03", 102)];
    const ep = episode([trade("b", "buy", "2026-06-01", 100, 100, { planStop: 8 })]);
    const dd = drawdownBefore(ep, { raw, adj: raw }, at("2026-06-04"), 8);
    expect(dd?.worst).toMatchObject({ date: "2026-06-01" });
    expect(dd?.worst?.pct).toBeCloseTo(-10);
    expect(dd?.stopBreach?.date).toBe("2026-06-01");
  });
});

describe("过度交易需要交易日数据", () => {
  const summary = (id: string, date: string, tradingDays: string[]): EpisodeSummary => ({
    episode: { ...episode([trade(id, "buy", date, 10, 100)]), id },
    holdDays: 1,
    tradingDays,
  });

  it("行情缺失、交易日序列为空：1 月、4 月、7 月各一笔，不能判成 10 个交易日内交易过多", () => {
    const s = [summary("a", "2026-01-12", []), summary("b", "2026-04-13", []), summary("c", "2026-07-13", [])];
    const b5 = portfolioBiases(s).find((r) => r.ruleId === "B5")!;
    expect(b5.outcome).toBe("undetermined");
    expect(b5.finding).toContain("无法判定");
  });

  it("交易日数据齐全时照常判定", () => {
    const days: string[] = [];
    for (let t = Date.UTC(2026, 0, 5); t <= Date.UTC(2026, 6, 31); t += 86_400_000) if (new Date(t).getUTCDay() % 6) days.push(new Date(t).toISOString().slice(0, 10));
    const s = [summary("a", "2026-01-12", days), summary("b", "2026-04-13", days), summary("c", "2026-07-13", days)];
    expect(portfolioBiases(s).find((r) => r.ruleId === "B5")!.outcome).toBe("not_hit");
  });
});

describe("除权除息数据缺失", () => {
  const t = (side: "buy" | "sell", date: string, price: number): Trade => ({ id: side, rowNo: 2, ts: at(date), timeKnown: true, code: "600001.SH", name: "测试股份", side, price, qty: 100, fee: 0, reason: null, planStop: null, planTarget: null });

  it("10 元买、每股分红 1 元、9 元卖：取到分红时收益 0%；没取到时标记为可能漏了分红", () => {
    const trades = [t("buy", "2026-06-01", 10), t("sell", "2026-06-10", 9)];
    const known = buildEpisodes(trades, new Map([["600001.SH", [{ exDate: "2026-06-05", cashPerShare: 1, bonusPerShare: 0 }]]])).episodes[0];
    expect(known.returnPct).toBe(0);
    expect(known.actionsMissing).toBeUndefined();
    const unknown = buildEpisodes(trades, new Map(), new Set(["600001.SH"])).episodes[0];
    expect(unknown.returnPct).toBe(-10);
    expect(unknown.actionsMissing).toBe(true);
  });
});

describe("给模型的证据 id", () => {
  it("匿名化时换成临时编号，模型输出里的编号能换回真实 id", () => {
    const b = trade("b", "buy", "2026-06-01", 100, 100);
    const fin: Evidence = { id: "fin:600001.SH:2026Q1", kind: "financial", title: "2026 年一季报披露（2026-04-28）", source: "扶摇", eventTime: at("2026-04-28", "00:00"), availableAt: at("2026-04-29", "00:00"), precision: "day", fetchedAt: null, status: "ok" };
    const tradeEv: Evidence = { id: "trade:b", kind: "trade", title: "买入 100 股", source: "用户导入", eventTime: b.ts, availableAt: b.ts, precision: "ms", fetchedAt: null, status: "ok" };
    const { pack, forModel, alias, real } = exAntePack(episode([b]), [tradeEv, fin], b, true);
    expect(forModel.map((p) => p.id).every((id) => /^E\d+$/.test(id))).toBe(true);
    expect(JSON.stringify(forModel)).not.toMatch(/600001|2026/);
    const finAlias = alias("fin:600001.SH:2026Q1");
    const out = realIds({ warnings: [{ text: "x", evidence_ids: [finAlias, "E999"] }], negatives_check: [{ evidence_id: finAlias.toLowerCase() }] }, real) as {
      warnings: { evidence_ids: string[] }[];
      negatives_check: { evidence_id: string }[];
    };
    expect(out.warnings[0].evidence_ids).toEqual(["fin:600001.SH:2026Q1", "E999"]);
    expect(out.negatives_check[0].evidence_id).toBe("fin:600001.SH:2026Q1");
    expect(pack.map((p) => p.id)).toContain("fin:600001.SH:2026Q1");
  });
});
