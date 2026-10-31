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

import { cleanCode, nonStockKind } from "@/lib/domain/trades";
import { parseShDateTime } from "@/lib/time";

// tests/fixtures 下的两份交割单由 scripts/make-realistic-trades.mjs 用真实行情生成：
// 同一批成交分别按同花顺、东方财富的导出格式写出，夹着转账、分红、申购、逆回购、ETF、分笔成交
describe("接近真实的交割单", () => {
  const load = (f: string) => parseTradesCsv(decodeCsv(new Uint8Array(readFileSync(`tests/fixtures/${f}`))).text);
  const ths = load("realistic-ths.csv");
  const em = load("realistic-eastmoney.csv");

  it("非买卖记录和非股票品种跳过并说明原因，不算错误", () => {
    for (const r of [ths, em]) {
      expect(r.issues.filter((i) => i.severity === "error")).toEqual([]);
      const skipped = r.issues.filter((i) => i.code === "skipped").map((i) => i.message).join("\n");
      for (const k of ["银行转证券", "新股申购", "申购配号", "ETF 或基金", "证券转银行"]) expect(skipped).toContain(k);
      expect(r.trades.every((t) => /^(60|68|00|30)\d{4}\.(SH|SZ)$/.test(t.code))).toBe(true);
    }
    // 同花顺把逆回购记成“卖出 204001”，不能当成深市股票的卖出
    expect(ths.issues.find((i) => i.code === "skipped" && i.message.includes("逆回购"))).toBeTruthy();
  });

  it("同一委托的分笔成交合并成一笔，两种格式解析出同样的成交", () => {
    expect(ths.issues.some((i) => i.code === "fills_merged")).toBe(true);
    const key = (t: (typeof ths.trades)[number]) => `${t.ts}|${t.code}|${t.side}|${t.qty}|${t.price.toFixed(2)}`;
    expect(em.trades.map(key)).toEqual(ths.trades.map(key));
    // 同一笔委托只留一行
    const orders = new Set(ths.trades.map((t) => `${t.ts}|${t.code}|${t.side}`));
    expect(orders.size).toBe(ths.trades.length);
  });

  it("东方财富：标题行、=\"代码\"、丢了前导 0 的时间、负数卖出数量都能识别", () => {
    expect(em.trades.length).toBeGreaterThan(40);
    expect(em.trades.every((t) => t.qty > 0 && t.timeKnown)).toBe(true);
  });

  it("备注里写的止损读成计划止损", () => {
    const withStop = ths.trades.filter((t) => t.planStop != null);
    expect(withStop.length).toBeGreaterThan(0);
    expect(withStop.every((t) => /止损\d+%/.test(t.reason ?? ""))).toBe(true);
    expect(ths.issues.some((i) => i.code === "plan_from_note")).toBe(true);
  });
});

describe("交割单里的各种写法", () => {
  it("代码：=\"002594\"、'002594、2594、600519.0", () => {
    expect(cleanCode('="002594"')).toBe("002594");
    expect(cleanCode("'002594")).toBe("002594");
    expect(cleanCode("2594")).toBe("002594");
    expect(cleanCode("600519.0")).toBe("600519");
  });

  it("逆回购、ETF、可转债、B 股、申购代码都不是股票", () => {
    expect(nonStockKind("204001", "GC001")).toBe("逆回购");
    expect(nonStockKind("131810")).toBe("逆回购");
    expect(nonStockKind("510300")).toBe("ETF 或基金");
    expect(nonStockKind("159915")).toBe("ETF 或基金");
    expect(nonStockKind("113050", "南银转债")).toBe("债券或可转债");
    expect(nonStockKind("128136")).toBe("债券或可转债");
    expect(nonStockKind("900901")).toBe("B 股");
    expect(nonStockKind("787518")).toBe("新股申购");
    for (const c of ["600519", "688981", "000333", "300750", "002594", "830799", "920001"]) expect(nonStockKind(c)).toBeNull();
  });

  it("时间：93122 是 09:31:22", () => {
    expect(parseShDateTime("20260430 94150")).toEqual(parseShDateTime("2026-04-30 09:41"));
    expect(parseShDateTime("20260430 103122")).toEqual(parseShDateTime("2026-04-30 10:31"));
  });

  it("没有合同编号时，同一分钟同一只同方向的成交也合并；费用相加、价格按量加权", () => {
    const { trades, issues } = parseTradesCsv(
      "成交时间,证券代码,买卖方向,成交价格,成交数量,手续费\n2026-06-22 14:41,603986,买入,686.0,400,7\n2026-06-22 14:41,603986,买入,687.5,200,5\n2026-06-22 14:52,603986,买入,690,100,5\n",
    );
    expect(trades).toHaveLength(2);
    expect(trades[0]).toMatchObject({ qty: 600, fee: 12, price: 686.5 });
    expect(issues.find((i) => i.code === "fills_merged")?.message).toContain("第 2、3 行");
  });

  it("成交数量为 0 的行（撤单、申购占位）跳过", () => {
    const { trades, issues } = parseTradesCsv("成交时间,证券代码,买卖方向,成交价格,成交数量\n2026-06-22 14:41,603986,买入,686,0\n2026-06-23 10:00,603986,买入,690,100\n");
    expect(trades).toHaveLength(1);
    expect(issues.some((i) => i.code === "skipped")).toBe(true);
  });
});
