import { describe, expect, it } from "vitest";
import { episodeBiases, portfolioBiases, type EpisodeSummary } from "@/lib/domain/biases";
import type { Evidence } from "@/lib/domain/evidence";
import type { Episode, EpisodeTrade } from "@/lib/domain/types";

const T0 = Date.parse("2026-06-22T14:41:00+08:00");

function trade(id: string, side: "buy" | "sell", ts: number, extra: Partial<EpisodeTrade> = {}): EpisodeTrade {
  return { id, rowNo: 2, ts, timeKnown: true, code: "603986.SH", name: "兆易创新", side, price: 100, qty: 100, fee: 5, reason: null, planStop: null, planTarget: null, positionAfter: side === "buy" ? 100 : 0, ...extra };
}

function episode(trades: EpisodeTrade[], returnPct: number | null, id = "ep"): Episode {
  return { id, code: trades[0].code, name: trades[0].name, openTs: trades[0].ts, closeTs: returnPct == null ? null : trades[trades.length - 1].ts, trades, corpEvents: [], buyCost: 0, sellProceeds: 0, dividends: 0, fees: 0, realizedPnl: null, returnPct, maxPosition: 100 };
}

function calc(id: string, value: number, title = id, extra: Partial<Evidence> = {}): Evidence {
  return { id, kind: "computed", title, value, source: "程序计算", eventTime: T0, availableAt: T0, precision: "ms", fetchedAt: null, status: "ok", ...extra };
}

const find = (rs: ReturnType<typeof episodeBiases>, id: string) => rs.find((r) => r.ruleId === id)!;

describe("单个持仓段的规则", () => {
  it("B1 追涨：5 日涨幅过线即命中；没有行情时是无法判定而不是未命中", () => {
    const b = trade("b", "buy", T0);
    const ep = episode([b, trade("s", "sell", T0 + 86_400_000 * 20)], -40);
    expect(find(episodeBiases(ep, [calc("calc:runup5:b", 42.6), calc("calc:high20:b", 109)]), "B1").outcome).toBe("hit");
    expect(find(episodeBiases(ep, [calc("calc:runup5:b", 4), calc("calc:high20:b", 90)]), "B1").outcome).toBe("not_hit");
    expect(find(episodeBiases(ep, []), "B1").outcome).toBe("undetermined");
  });

  it("B3 恐慌卖出：卖出后的走势只作为事后代价展示", () => {
    const s = trade("s", "sell", T0 + 86_400_000 * 20);
    const ep = episode([trade("b", "buy", T0), s], -40);
    const r = find(episodeBiases(ep, [calc("calc:runup3:s", -25.7), calc("calc:after10:s", 12, "卖出后 10 个交易日涨跌幅 +12.0%")]), "B3");
    expect(r.outcome).toBe("hit");
    expect(r.evidenceIds).toEqual(["calc:runup3:s"]);
    expect(r.cost?.text).toContain("事后信息");
  });

  it("B6 锚定成本价：深度浮亏后回本就卖", () => {
    const ep = episode([trade("b", "buy", T0), trade("s", "sell", T0 + 86_400_000 * 30)], -0.8);
    const items = [calc("calc:dd:s", -17.9), calc("calc:vscost:s", -0.7)];
    expect(find(episodeBiases(ep, items), "B6").outcome).toBe("hit");
    expect(find(episodeBiases(ep, [calc("calc:dd:s", -9), calc("calc:vscost:s", -0.7)]), "B6").outcome).toBe("not_hit");
  });

  it("B7 偏离计划：止损没执行、目标没拿到都算；按计划执行不算；没写计划是无法判定", () => {
    const stopBuy = trade("b", "buy", T0, { planStop: 8 });
    const s = trade("s", "sell", T0 + 86_400_000 * 20);
    expect(find(episodeBiases(episode([stopBuy, s], -41), [calc("calc:vscost:s", -41.6)]), "B7").outcome).toBe("hit");
    expect(find(episodeBiases(episode([stopBuy, s], -8.5), [calc("calc:vscost:s", -8.4)]), "B7").outcome).toBe("not_hit");
    const targetBuy = trade("b", "buy", T0, { planTarget: 15 });
    expect(find(episodeBiases(episode([targetBuy, s], 5.5), [calc("calc:vscost:s", 5.6)]), "B7").finding).toContain("比目标少了 9.4");
    expect(find(episodeBiases(episode([trade("b", "buy", T0), s], 1), [calc("calc:vscost:s", 1)]), "B7").outcome).toBe("undetermined");
  });

  it("B8 选择性关注：只看买入前 10 天内、当时可知的负面信息，事后的不算", () => {
    const b = trade("b", "buy", T0);
    const ep = episode([b, trade("s", "sell", T0 + 86_400_000 * 20)], -40);
    const neg = (id: string, at: number): Evidence => ({ id, kind: "anomaly", title: id, source: "扶摇", eventTime: at, availableAt: at, precision: "ms", fetchedAt: null, status: "ok", tone: "negative" });
    const before = find(episodeBiases(ep, [neg("a1", T0 - 86_400_000)]), "B8");
    expect(before).toMatchObject({ outcome: "undetermined", needsAi: true, evidenceIds: ["a1"] });
    expect(find(episodeBiases(ep, [neg("a2", T0 + 86_400_000)]), "B8").outcome).toBe("not_hit");
  });
});

describe("组合层面的规则", () => {
  const day = (d: number) => Date.parse(`2026-06-${String(d).padStart(2, "0")}T10:00:00+08:00`);
  // 2026 年 6 月的交易日：去掉周末和 6/19 端午
  const days = Array.from({ length: 30 }, (_, i) => i + 1)
    .filter((d) => ![6, 7, 13, 14, 19, 20, 21, 27, 28].includes(d))
    .map((d) => `2026-06-${String(d).padStart(2, "0")}`);
  const summary = (id: string, ret: number, hold: number, trades: EpisodeTrade[]): EpisodeSummary => ({ episode: episode(trades, ret, id), holdDays: hold, tradingDays: days });

  it("B4 处置效应：亏损段明显拿得更久", () => {
    const s = [
      summary("e1", -22, 68, [trade("1", "buy", day(1)), trade("2", "sell", day(2))]),
      summary("e2", -41, 20, [trade("3", "buy", day(3)), trade("4", "sell", day(4))]),
      summary("e3", 5.5, 5, [trade("5", "buy", day(5)), trade("6", "sell", day(6))]),
      summary("e4", 10.6, 15, [trade("7", "buy", day(7)), trade("8", "sell", day(8))]),
    ];
    const r = portfolioBiases(s).find((x) => x.ruleId === "B4")!;
    expect(r.outcome).toBe("hit");
    expect(r.finding).toContain("比值 4.40");
    expect(portfolioBiases(s.slice(0, 3)).find((x) => x.ruleId === "B4")!.outcome).toBe("undetermined");
  });

  it("B5 过度交易：同一只股票 10 个交易日内 6 笔", () => {
    const mk = (id: string, side: "buy" | "sell", d: number) => trade(id, side, day(d), { code: "688256.SH", name: "寒武纪" });
    const s = [
      summary("c1", -2, 2, [mk("a", "buy", 18), mk("b", "sell", 22)]),
      summary("c2", 5, 2, [mk("c", "buy", 24), mk("d", "sell", 25)]),
      summary("c3", 1, 2, [mk("e", "buy", 26), mk("f", "sell", 29)]),
    ];
    const r = portfolioBiases(s).find((x) => x.ruleId === "B5")!;
    expect(r.outcome).toBe("hit");
    expect(r.evidenceIds).toHaveLength(6);
  });
});

import { attribute } from "@/lib/domain/attribution";
import type { BiasResult } from "@/lib/domain/biases";

describe("过程、结果和问题归类", () => {
  const bias = (ruleId: BiasResult["ruleId"], outcome: BiasResult["outcome"], evidenceIds: string[] = []): BiasResult =>
    ({ ruleId, name: ruleId, rule: "", scope: "trade", outcome, finding: ruleId, evidenceIds, alternatives: [], confidence: "high" });

  it("有计划、按计划止损、亏损来自买入后的利空：过程好 · 结果差，不可预见", () => {
    const b = trade("b", "buy", T0, { reason: "估值回到中枢", planStop: 8 });
    const ep = episode([b, trade("s", "sell", T0 + 86_400_000 * 4)], -8.5);
    const later: Evidence = { id: "anomaly:x", kind: "anomaly", title: "异动「跌停」：半年度业绩预亏", source: "扶摇", eventTime: T0 + 86_400_000 * 3, availableAt: T0 + 86_400_000 * 3, precision: "ms", fetchedAt: null, status: "ok", tone: "negative", important: true };
    const a = attribute(ep, [later], [bias("B1", "not_hit"), bias("B7", "not_hit"), bias("B8", "not_hit")]);
    expect(a.quadrant).toBe("过程好 · 结果差");
    expect(a.errorType).toBe("unforeseeable");
    expect(a.errorReason.evidenceIds).toEqual(["anomaly:x"]);
  });

  it("止损没执行：没做好", () => {
    const ep = episode([trade("b", "buy", T0, { reason: "追", planStop: 8 }), trade("s", "sell", T0 + 86_400_000 * 20)], -41);
    const a = attribute(ep, [], [bias("B1", "hit"), bias("B7", "hit", ["calc:vscost:s"])]);
    expect(a.process).toBe("poor");
    expect(a.errorType).toBe("execution");
  });

  it("赚了钱但过程有问题：提醒结果好不代表方法对", () => {
    const ep = episode([trade("b", "buy", T0, { reason: "热榜第一" }), trade("s", "sell", T0 + 86_400_000)], 5);
    const a = attribute(ep, [], [bias("B1", "hit"), bias("B2", "hit"), bias("B3", "hit"), bias("B7", "undetermined")]);
    expect(a.quadrant).toBe("过程差 · 结果好");
    expect(a.errorReason.text).toContain("结果好不代表方法对");
  });
});

describe("规则细节", () => {
  it("追涨和追热点同时命中只算一种问题（买入时机），不会因此判成过程差", () => {
    const ep = episode([trade("b", "buy", T0, { reason: "业绩超预期", planStop: 8, planTarget: 10 }), trade("s", "sell", T0 + 86_400_000 * 14)], 10.6);
    const mk = (ruleId: BiasResult["ruleId"], outcome: BiasResult["outcome"]): BiasResult => ({ ruleId, name: ruleId, rule: "", scope: "trade", outcome, finding: "", evidenceIds: [], alternatives: [], confidence: "high" });
    expect(attribute(ep, [], [mk("B1", "hit"), mk("B2", "hit"), mk("B7", "not_hit")]).process).toBe("mixed");
  });

  it("接近 20 日高点但 5 日内没涨，不算追涨", () => {
    const b = trade("b", "buy", T0);
    const ep = episode([b, trade("s", "sell", T0 + 86_400_000)], 1);
    expect(find(episodeBiases(ep, [calc("calc:runup5:b", -2.5), calc("calc:high20:b", 97.5)]), "B1").outcome).toBe("not_hit");
    expect(find(episodeBiases(ep, [calc("calc:runup5:b", 9), calc("calc:high20:b", 101)]), "B1").outcome).toBe("hit");
  });
});
