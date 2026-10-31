import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import iconv from "iconv-lite";
import { decodeCsv, normalizeCode, parseTradesCsv } from "@/lib/domain/trades";
import { buildEpisodes, validateTrades } from "@/lib/domain/position";
import type { Bar, Trade } from "@/lib/domain/types";

const withIds = (ts: Omit<Trade, "id">[]): Trade[] => ts.map((t, i) => ({ ...t, id: `t${i}` }));

describe("CSV 解码和解析", () => {
  it("GBK 编码的券商导出能正确解码", () => {
    const text = "成交日期,成交时间,证券代码,证券名称,操作,成交均价,成交数量,佣金,印花税,过户费\n20260622,14:41:05,603986,兆易创新,证券买入,686.5,600,102.98,0,4.12\n";
    const { text: decoded, encoding } = decodeCsv(new Uint8Array(iconv.encode(text, "gbk")));
    expect(encoding).toBe("gbk");
    const { trades, issues } = parseTradesCsv(decoded);
    expect(issues).toEqual([]);
    expect(trades[0]).toMatchObject({ code: "603986.SH", side: "buy", price: 686.5, qty: 600, fee: 107.1, timeKnown: true });
  });

  it("带 BOM 的 UTF-8 和示例组合能解析", () => {
    const bytes = new Uint8Array([0xef, 0xbb, 0xbf, ...readFileSync("demo/demo-trades.csv")]);
    const { text, encoding } = decodeCsv(bytes);
    expect(encoding).toBe("utf-8");
    const { trades, issues } = parseTradesCsv(text);
    expect(issues).toEqual([]);
    expect(trades).toHaveLength(21);
    expect(trades.find((t) => t.code === "601919.SH" && t.side === "buy")?.planTarget).toBe(15);
  });

  it("缺列、坏值逐行报错，不中断其他行", () => {
    const { trades, issues } = parseTradesCsv("成交时间,证券代码,买卖方向,成交价格,成交数量\n2026-06-22 14:41,603986,买入,abc,600\n2026-06-23,600519,卖出,1400,100\n");
    expect(trades).toHaveLength(1);
    expect(issues.map((i) => i.code)).toEqual(["bad_value", "time_unknown"]);
    expect(parseTradesCsv("证券代码,成交价格\n600519,1\n").issues[0].code).toBe("missing_column");
  });

  it("代码补全交易所后缀", () => {
    expect(normalizeCode("600519")).toBe("600519.SH");
    expect(normalizeCode("688256")).toBe("688256.SH");
    expect(normalizeCode("300750")).toBe("300750.SZ");
    expect(normalizeCode("sz002594")).toBe("002594.SZ");
    expect(normalizeCode("920001")).toBe("920001.BJ");
    expect(normalizeCode("12345")).toBeNull();
  });
});

const bar = (date: string, low: number, high: number): Bar => ({ date, open: low, high, low, close: high, volume: 0, turnover: 0 });

describe("成交校验", () => {
  const ctx = {
    tradingDays: new Set(["2026-06-18", "2026-06-22"]),
    bars: new Map([["688256.SH", new Map([["2026-06-18", bar("2026-06-18", 1313.2, 1540)]])]]),
  };
  const base = { rowNo: 2, timeKnown: true, code: "688256.SH", name: null, side: "buy" as const, fee: 0, reason: null, planStop: null, planTarget: null };

  it("非交易日、价格越界、科创板手数、交易时段分别报出", () => {
    const { trades } = { trades: withIds([
      { ...base, ts: Date.UTC(2026, 5, 19, 2, 0), price: 1500, qty: 200 }, // 06-19 端午节
      { ...base, ts: Date.UTC(2026, 5, 18, 6, 30), price: 1600, qty: 200 },
      { ...base, ts: Date.UTC(2026, 5, 18, 6, 30), price: 1500, qty: 100 },
      { ...base, ts: Date.UTC(2026, 5, 18, 4, 0), price: 1500, qty: 200 }, // 12:00 午休
    ]) };
    const codes = validateTrades(trades, ctx).map((i) => `${i.tradeId}:${i.code}`);
    expect(codes).toEqual(["t0:not_trading_day", "t1:price_out_of_range", "t2:lot_size", "t3:outside_session"]);
  });

  it("缺行情时给警告而不是假装通过", () => {
    const issues = validateTrades(withIds([{ ...base, code: "600519.SH", ts: Date.UTC(2026, 5, 22, 2, 0), price: 1, qty: 100 }]), ctx);
    expect(issues[0]).toMatchObject({ code: "bars_unavailable", severity: "warning" });
  });
});

describe("持仓段", () => {
  const t = (side: "buy" | "sell", iso: string, price: number, qty: number, code = "300502.SZ"): Omit<Trade, "id"> => ({
    rowNo: 2, ts: Date.parse(iso + "+08:00"), timeKnown: true, code, name: null, side, price, qty, fee: 0, reason: null, planStop: null, planTarget: null,
  });

  it("持有期间送转和分红：股数增加、分红计入收益（新易盛 06-11 除权）", () => {
    const trades = withIds([t("buy", "2026-06-09T13:20", 780, 300), t("sell", "2026-06-18T14:40", 580, 420)]);
    const actions = new Map([["300502.SZ", [{ exDate: "2026-06-11", cashPerShare: 1, bonusPerShare: 0.4 }]]]);
    const { episodes, issues } = buildEpisodes(trades, actions);
    expect(issues).toEqual([]);
    const ep = episodes[0];
    expect(ep.corpEvents[0]).toMatchObject({ sharesBefore: 300, bonusShares: 120, cashReceived: 300 });
    expect(ep.realizedPnl).toBe(420 * 580 + 300 - 300 * 780);
    expect(ep.returnPct).toBeGreaterThan(0); // 不复权价格从 780 到 580，但实际是赚的
  });

  it("不计送转时卖出超过持仓会被指出", () => {
    const trades = withIds([t("buy", "2026-06-09T13:20", 780, 300), t("sell", "2026-06-18T14:40", 580, 420)]);
    const { issues } = buildEpisodes(trades, new Map());
    expect(issues[0].code).toBe("sell_exceeds_position");
  });

  it("清仓后再买入算新的持仓段；没卖完的是未平仓段", () => {
    const trades = withIds([
      t("buy", "2026-06-18T14:30", 1500, 200, "688256.SH"),
      t("sell", "2026-06-22T10:00", 1465, 200, "688256.SH"),
      t("buy", "2026-06-24T13:30", 1440, 200, "688256.SH"),
    ]);
    const { episodes } = buildEpisodes(trades, new Map());
    expect(episodes).toHaveLength(2);
    expect(episodes[0].returnPct).toBeCloseTo(((1465 - 1500) / 1500) * 100, 2);
    expect(episodes[1].closeTs).toBeNull();
    expect(episodes[1].id).toBe("688256.SH-202606241330");
  });

  it("没有持仓就卖出", () => {
    const { issues } = buildEpisodes(withIds([t("sell", "2026-06-18T14:40", 580, 100)]), new Map());
    expect(issues[0].code).toBe("sell_without_position");
  });
});
