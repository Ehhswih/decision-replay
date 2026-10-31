import { describe, expect, it } from "vitest";
import { checkClaim, cleanText, detectLeakage, numbersSupported, type CheckContext } from "@/lib/ai/validate";
import { filterText, isAdviceQuestion, REDACTED } from "@/lib/domain/compliance";
import type { Evidence } from "@/lib/domain/evidence";

const t = Date.parse("2026-06-22T14:41:00+08:00");
const ev = (id: string, availableAt: number, title: string, value?: number): Evidence => ({
  id, kind: "computed", title, value, source: "程序计算", eventTime: availableAt, availableAt, precision: "ms", fetchedAt: null, status: "ok",
});
const items = [
  ev("calc:runup5:b", t, "买入前 5 个交易日涨跌幅 +42.6%", 42.6),
  ev("anomaly:late", t + 8 * 86_400_000, "异动「大跌」：公司提示回落风险"),
];
const ctx = (exAnteAt?: number): CheckContext => ({
  evidence: new Map(items.map((e) => [e.id, e])),
  exAnteAt,
  textOf: (e) => `${e.title} ${e.value ?? ""}`,
  log: [],
  stage: "test",
});

describe("AI 结论校验", () => {
  it("引用和数字都对的结论保留", () => {
    const c = ctx(t);
    expect(checkClaim({ text: "买入前 5 个交易日已上涨 42.6%", evidence_ids: ["calc:runup5:b"] }, c)).toMatchObject({ evidenceIds: ["calc:runup5:b"], type: "fact" });
    expect(c.log).toEqual([]);
  });

  it("没有引用、引用不存在、数字对不上：整条丢掉并记日志", () => {
    const c = ctx();
    expect(checkClaim({ text: "股价短期过热", evidence_ids: [] }, c)).toBeNull();
    expect(checkClaim({ text: "股价短期过热", evidence_ids: ["news:none"] }, c)).toBeNull();
    expect(checkClaim({ text: "买入前已上涨 52.6%", evidence_ids: ["calc:runup5:b"] }, c)).toBeNull();
    expect(c.log.map((l) => l.reason)).toEqual(["没有引用任何证据", "引用的证据不存在：news:none", "数字在引用的证据里找不到：52.6"]);
  });

  it("当时视角引用了决策之后才出现的证据：丢掉", () => {
    const c = ctx(t);
    expect(checkClaim({ text: "公司已经提示回落风险", evidence_ids: ["anomaly:late"] }, c)).toBeNull();
    expect(c.log[0].reason).toContain("决策时不可知");
  });

  it("数字核对允许四舍五入，小计数词放行", () => {
    expect(numbersSupported("亏损 41.7%", ["持仓段收益 -41.67%"]).ok).toBe(true);
    expect(numbersSupported("前 3 条新闻里", ["无关"]).ok).toBe(true);
    expect(numbersSupported("亏损 48%", ["持仓段收益 -41.67%"]).ok).toBe(false);
  });

  it("合规过滤：建议和预测整句替换", () => {
    const r = filterText("买入时已经连续大涨。建议投资者逢低买入。后市将继续上涨！");
    expect(r.hits.map((h) => h.reason)).toEqual(["买卖或持仓建议", "涨跌预测"]);
    expect(r.text).toBe(`买入时已经连续大涨。${REDACTED}${REDACTED}`);
    expect(filterText("下次买入前先写好止损").hits).toEqual([]);
    expect(isAdviceQuestion("宁德时代现在能不能买")).toBe(true);
    expect(isAdviceQuestion("我追涨的毛病怎么改")).toBe(false);
  });

  it("后见之明泄漏检测", () => {
    expect(detectLeakage("当时市场已经担心公司提示回落风险", ["公司提示回落风险", "长鑫科技上市"])).toEqual(["公司提示回落风险"]);
    expect(detectLeakage("存储芯片涨价预期强", ["公司提示回落风险"])).toEqual([]);
  });
});

import { makeAnonymizer } from "@/lib/ai/pack";

describe("当时视角匿名化", () => {
  it("股票名、代码、日期都换掉，换回时只恢复名称", () => {
    const a = makeAnonymizer("兆易创新", "603986.SH", "2026-06-22");
    expect(a.text("兆易创新(603986)：6月18日涨停，2026-06-15 大涨；据2026年6月20日公告")).toBe("标的A(标的A)：D-4涨停，D-7 大涨；据D-2公告");
    expect(a.text("兆易提示风险")).toBe("标的A提示风险");
    expect(a.restore("标的A 买入前已大涨")).toBe("兆易创新 买入前已大涨");
    expect(makeAnonymizer("中国中免", "601888.SH", "2026-06-22").text("中国中免和中国平安")).toBe("标的A和中国平安");
  });
});

describe("数字核对的边界", () => {
  it("月日写法不当成数字；叙述里对不上的句子被删掉", () => {
    expect(numbersSupported("止损线 7-06 被跌破，6月22日买入", ["无关"]).ok).toBe(true);
    const c: CheckContext = { evidence: new Map(), log: [], stage: "t", textOf: () => "", packTexts: ["持仓段收益 -41.67%"] };
    expect(cleanText("这笔亏了 41.67%。行业跌了 30%。", c)).toBe("这笔亏了 41.67%。");
    expect(c.log[0].reason).toContain("30");
  });

  it("输入里本来就有的词不算泄漏", () => {
    expect(detectLeakage("主力资金净流出", ["主力资金净流出"], "D-17 异动：主力资金净流出 25.56 亿元")).toEqual([]);
  });
});

describe("合规过滤的边界", () => {
  it("用户计划里的目标价不拦，给出具体价格的目标价要拦", () => {
    expect(filterText("下单前把目标价、止盈条件写在同一行").hits).toEqual([]);
    expect(filterText("证据中没有目标价测算").hits).toEqual([]);
    expect(filterText("目标价 180 元").hits[0].reason).toBe("目标价");
    expect(filterText("机构给予目标价").hits[0].reason).toBe("目标价");
  });

  it("报告期写法不当成数字", () => {
    expect(numbersSupported("只有2026Q1与2025年报数据", ["无关"]).ok).toBe(true);
  });
});

import { resolveB8 } from "@/lib/ai/b8";
import type { BiasResult } from "@/lib/domain/biases";

describe("选择性关注（B8）定论", () => {
  const b: BiasResult = { ruleId: "B8", name: "选择性关注", rule: "", scope: "trade", outcome: "undetermined", tradeId: "t", finding: "", evidenceIds: [], alternatives: [], confidence: "low", needsAi: true };
  const e = (id: string, kind: Evidence["kind"], important = false): Evidence => ({ id, kind, title: id, source: "扶摇", eventTime: 0, availableAt: 0, precision: "ms", fetchedAt: null, status: "ok", important });
  const map = new Map([e("n1", "news"), e("n2", "news"), e("a1", "anomaly"), e("x1", "notice")].map((x) => [x.id, x]));

  it("没提到公告或异动才算命中；只漏了普通新闻判无法判定；都回应了算未命中", () => {
    expect(resolveB8(b, [{ evidenceId: "a1", addressed: false }, { evidenceId: "n1", addressed: false }], map)).toMatchObject({ outcome: "hit", evidenceIds: ["a1"], confidence: "low" });
    expect(resolveB8(b, [{ evidenceId: "n1", addressed: false }, { evidenceId: "n2", addressed: false }], map).outcome).toBe("undetermined");
    expect(resolveB8(b, [{ evidenceId: "x1", addressed: true }], map).outcome).toBe("not_hit");
    expect(resolveB8(b, [{ evidenceId: "a1", addressed: false }, { evidenceId: "x1", addressed: false }], map).confidence).toBe("mid");
  });
});

describe("B8 相关性", () => {
  it("和买入逻辑无关的负面异动没提到，不算忽略", () => {
    const b: BiasResult = { ruleId: "B8", name: "选择性关注", rule: "", scope: "trade", outcome: "undetermined", tradeId: "t", finding: "", evidenceIds: [], alternatives: [], confidence: "low", needsAi: true };
    const a1: Evidence = { id: "a1", kind: "anomaly", title: "板块集体下跌", source: "扶摇", eventTime: 0, availableAt: 0, precision: "ms", fetchedAt: null, status: "ok" };
    expect(resolveB8(b, [{ evidenceId: "a1", addressed: false, relevant: false }], new Map([["a1", a1]])).outcome).toBe("undetermined");
  });
});
