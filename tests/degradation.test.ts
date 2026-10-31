// 降级集成测试：外部数据源和模型都换成可控的假实现，在临时数据库上跑完整流程，
// 验证数据缺失、接口失败、额度用完、模型故障、模型输出不合规时，系统给出明确的降级结果，不会当作正常。

import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.DATA_DIR = mkdtempSync(join(tmpdir(), "dr-test-"));

type Kind = "ok" | "failed" | "empty" | "partial" | "dividend";
const state: Record<string, Kind> = {};
const llm: { mode: "ok" | "down" | "bad" | "malformed"; calls: number; lastExAnte: string } = { mode: "ok", calls: 0, lastExAnte: "" };
// 当时视角的证据包用临时编号（E1、E2……），按标题找到对应的编号
const aliasOf = (user: string, title: RegExp) => [...user.matchAll(/"id":"([^"]+)","kind":"[^"]+","time":"[^"]*","title":"([^"]*)"/g)].find((m) => title.test(m[2]))?.[1];

const meta = (endpoint: string) => ({ source: "fuyao" as const, endpoint, params: {}, fetchedAt: Date.now(), fromCache: false, latencyMs: 1, attempts: 1 });
const fail = (endpoint: string, kind = "upstream", message = "上游服务超时") => ({ status: "failed" as const, data: null, error: { kind, code: 5002, message }, meta: meta(endpoint) });
const ok = <T,>(endpoint: string, data: T) => ({ status: "ok" as const, data, meta: meta(endpoint) });

// 2026-05-04 起的工作日，收盘价平滑上涨
const DAYS: string[] = [];
for (let t = Date.UTC(2026, 4, 4); t <= Date.UTC(2026, 7, 31); t += 86_400_000) {
  const d = new Date(t);
  if (d.getUTCDay() % 6 !== 0) DAYS.push(d.toISOString().slice(0, 10));
}
const bars = (start: string, end: string) =>
  DAYS.filter((d) => d >= start && d <= end).map((date) => {
    const i = DAYS.indexOf(date);
    const close = 10 + i * 0.05;
    return { date, open: close - 0.02, high: close + 0.1, low: close - 0.1, close, volume: 1, turnover: 1 };
  });

vi.mock("@/lib/sources/fuyao-api", () => ({
  tradingDays: async (s: string, e: string) => (state.calendar === "failed" ? fail("calendar") : ok("calendar", DAYS.filter((d) => d >= s && d <= e))),
  dailyBars: async (_c: string, s: string, e: string) => (state.bars === "failed" ? fail("/api/a-share/prices/historical") : ok("bars", bars(s, e))),
  indexBars: async (_c: string, s: string, e: string) => (state.index === "failed" ? fail("index") : ok("index", bars(s, e))),
  corpActions: async () => (state.actions === "failed" ? fail("actions") : ok("actions", state.actions === "dividend" ? [{ exDate: "2026-07-01", cashPerShare: 1, bonusPerShare: 0 }] : [])),
  industryOf: async () => ok("industry", [{ code: "881273.TI", name: "测试行业" }]),
  incomeStatements: async () => ok("fin", []),
  stockNews: async () =>
    state.news === "failed"
      ? { status: "failed", data: [], complete: false, error: { kind: "network", message: "fetch failed" }, meta: meta("news") }
      : state.news === "partial"
        ? { status: "ok", data: [], complete: false, meta: meta("news") }
        : {
          status: "ok",
          complete: true,
          meta: meta("news"),
          data: [
            { id: "n1", type: 1, title: "公司收到监管问询函，股价承压", source: "测试", summary: null, publishTs: Date.parse("2026-06-19T20:00:00+08:00"), url: "https://example.com/1" },
            { id: "n2", type: 1, title: "半年度业绩预亏公告", source: "测试", summary: null, publishTs: Date.parse("2026-07-05T20:00:00+08:00"), url: "https://example.com/2" },
          ],
        },
  anomalies: async () => (state.anomalies === "empty" ? { status: "empty", data: { truncated: false, items: [] }, meta: meta("anomaly") } : ok("anomaly", { truncated: false, items: [] })),
  hotRank: async () => ok("hot", [{ date: "2026-06-19", rank: 300 }]),
  dragonTiger: async () => (state.lhb === "failed" ? fail("lhb") : ok("lhb", [])),
  searchTicker: async () => ok("search", []),
}));

vi.mock("@/lib/sources/ifind-api", () => ({
  searchNotice: async () =>
    state.ifind === "failed"
      ? { status: "failed", data: null, error: { kind: "quota", message: "已达到 iFinD 调用上限，只使用扶摇数据" }, meta: { ...meta("tools/call:search_notice"), source: "ifind" } }
      : { status: "empty", data: [], meta: { ...meta("tools/call:search_notice"), source: "ifind" } },
  searchNews: async () => ({ status: "empty", data: [], meta: meta("x") }),
  ifindQuota: () => ({ used: 0, limit: 1800, remaining: 1800 }),
}));

vi.mock("@/lib/ai/deepseek", () => ({
  chatJson: async (system: string, user: string) => {
    llm.calls++;
    if (llm.mode === "down") return { ok: false, kind: "network", message: "connect ETIMEDOUT", latencyMs: 5 };
    const ids = [...user.matchAll(/"id":"([^"]+)"/g)].map((m) => m[1]);
    const sell = ids.find((i) => i.startsWith("trade:") && user.includes("卖出"));
    if (system.includes("决策当时")) {
      llm.lastExAnte = user;
      const runupA = aliasOf(user, /^买入前 5 个交易日涨跌幅/);
      const n1 = aliasOf(user, /监管问询函/) ?? "missing";
      if (llm.mode === "malformed") {
        // 结构错误：该是列表的给了对象、字符串、null
        return { ok: true, model: "fake", latencyMs: 5, usage: { prompt: 1, completion: 1, reasoning: 0 }, data: { summary: 42, supporting: null, warnings: "x", reason_check: {}, negatives_check: [null, 1, { evidence_id: n1, addressed_in_reason: false }] } };
      }
      return {
        ok: true,
        model: "fake",
        latencyMs: 5,
        usage: { prompt: 1, completion: 1, reasoning: 0 },
        data:
          llm.mode === "bad"
            ? {
                summary: "建议投资者逢低买入。买入前股价平稳。",
                supporting: [
                  { text: "股价平稳", evidence_ids: [] },
                  { text: "后来公司业绩预亏", evidence_ids: ["news:n2"] },
                ],
                warnings: [{ text: "收到监管问询函", evidence_ids: [n1] }],
                reason_check: [],
                negatives_check: [{ evidence_id: n1, addressed_in_reason: false, relevant: true }],
              }
            : { summary: "买入前股价平稳。", supporting: runupA ? [{ text: "买入前 5 日涨跌幅较小", evidence_ids: [runupA] }] : [], warnings: [], reason_check: [], negatives_check: [] },
      };
    }
    if (llm.mode === "malformed") {
      return { ok: true, model: "fake", latencyMs: 5, usage: { prompt: 1, completion: 1, reasoning: 0 }, data: { narrative: ["x"], facts: {}, bias_notes: 5, failed_assumption: { text: 123 }, uncertainties: "y", lessons: { text: "z" } } };
    }
    return {
      ok: true,
      model: "fake",
      latencyMs: 5,
      usage: { prompt: 1, completion: 1, reasoning: 0 },
      data:
        llm.mode === "bad"
          ? {
              narrative: "这次亏损了 99.9%。后市将继续上涨。",
              facts: [{ text: "卖出价是 88.88 元", evidence_ids: sell ? [sell] : [] }],
              bias_notes: [],
              uncertainties: [],
              lessons: [{ text: "下次建议直接满仓买入", trigger: "plan", evidence_ids: sell ? [sell] : [] }],
            }
          : { narrative: "按计划卖出。", facts: [], bias_notes: [], uncertainties: [], lessons: [] },
    };
  },
}));

const closeOn = (d: string) => +(10 + DAYS.indexOf(d) * 0.05).toFixed(2);
const CSV = `成交时间,证券代码,证券名称,买卖方向,成交价格,成交数量,手续费,当时理由,计划止损(%),计划目标(%)
2026-06-22 10:00,600001,测试股份,买入,${closeOn("2026-06-22")},1000,5,看好业绩,8,
2026-07-10 14:00,600001,测试股份,卖出,${closeOn("2026-07-10")},1000,8,到了心理价位,,
`;

let pipeline: typeof import("@/lib/pipeline");
let review: typeof import("@/lib/ai/review");
let trades: typeof import("@/lib/domain/trades");
let rules: typeof import("@/lib/rules-review");

beforeAll(async () => {
  pipeline = await import("@/lib/pipeline");
  review = await import("@/lib/ai/review");
  trades = await import("@/lib/domain/trades");
  rules = await import("@/lib/rules-review");
});

let n = 0;
async function setup() {
  const ws = `test-ws-${++n}`;
  pipeline.saveTrades(ws, trades.parseTradesCsv(CSV).trades);
  const a = await pipeline.analyzeWorkspace(ws);
  return { ws, a, ep: a.episodes[0] };
}

beforeEach(() => {
  for (const k of Object.keys(state)) delete state[k];
  llm.mode = "ok";
  llm.calls = 0;
});

describe("数据源故障", () => {
  it("一切正常：证据完整、指标算出、证据集被缓存", async () => {
    const { ws, a, ep } = await setup();
    expect(a.issues).toEqual([]);
    const set = await pipeline.buildEvidenceSet(ws, ep);
    expect(set.sources.every((s) => s.status === "ok" || s.status === "empty" || s.note)).toBe(true);
    expect(set.items.some((e) => e.id.startsWith("calc:runup5:"))).toBe(true);
    const again = await pipeline.buildEvidenceSet(ws, ep);
    expect(again.builtAt).toBe(set.builtAt); // 读的是缓存
  });

  it("K 线获取失败：关键数据源标为失败，不算价格指标，规则给出无法判定，证据集不缓存", async () => {
    const { ws, ep } = await setup();
    state.bars = "failed";
    const set = await pipeline.buildEvidenceSet(ws, ep, true);
    const raw = set.sources.find((s) => s.key === "raw")!;
    expect(raw).toMatchObject({ status: "failed", critical: true });
    expect(raw.error?.message).toContain("超时");
    expect(set.items.some((e) => e.kind === "computed" && e.id.startsWith("calc:runup5:"))).toBe(false);

    const r = await rules.rulesForWorkspace(ws);
    const b1 = r.episodes[0].biases.find((b) => b.ruleId === "B1")!;
    expect(b1.outcome).toBe("undetermined"); // 不能当成"未命中"

    state.bars = "ok";
    const healed = await pipeline.buildEvidenceSet(ws, ep);
    expect(healed.items.some((e) => e.id.startsWith("calc:runup5:"))).toBe(true); // 恢复后重新取数，而不是读到坏缓存
  });

  it("新闻失败、异动为空、iFinD 额度用完：复盘照常进行，并在数据源状态里写明", async () => {
    const { ws, ep } = await setup();
    state.news = "failed";
    state.anomalies = "empty";
    state.ifind = "failed";
    const set = await pipeline.buildEvidenceSet(ws, ep, true);
    expect(set.sources.find((s) => s.key === "news")).toMatchObject({ status: "failed" });
    expect(set.sources.find((s) => s.key === "anomalies")?.note).toContain("不代表期间没有异动");
    expect(set.sources.find((s) => s.key === "ifindNotice")?.error?.kind).toBe("quota");
    expect(set.items.some((e) => e.kind === "trade")).toBe(true);
  });

  it("新闻和公告都没取到、也没找到负面信息：选择性关注是无法判定，不是未命中", async () => {
    const { ws } = await setup();
    state.news = "failed";
    state.ifind = "failed";
    const r = await rules.rulesForWorkspace(ws);
    const b8 = r.episodes[0].biases.find((b) => b.ruleId === "B8")!;
    expect(b8.outcome).toBe("undetermined");
    expect(b8.finding).toContain("没有取到");
  });

  it("重新生成复盘时强制刷新证据集，不复用旧缓存", async () => {
    const { ws, ep } = await setup();
    const first = await pipeline.buildEvidenceSet(ws, ep);
    await new Promise((r) => setTimeout(r, 5));
    await review.generateReview(ws, ep.id, () => {}, { refreshEvidence: true });
    const after = await pipeline.buildEvidenceSet(ws, ep);
    expect(after.builtAt).toBeGreaterThan(first.builtAt);
  });

  it("除权除息没取到：明确提示收益可能漏了分红，证据集不算稳定；恢复后按新收益重建，不留旧证据", async () => {
    state.actions = "failed";
    const { ws, a, ep } = await setup();
    expect(ep.actionsMissing).toBe(true);
    expect(a.issues.map((i) => i.code)).toContain("actions_unavailable");
    const bad = await pipeline.buildEvidenceSet(ws, ep);
    expect(bad.sources.find((s) => s.key === "actions")).toMatchObject({ status: "failed" });
    expect(bad.stable).toBe(false);
    expect(bad.items.find((e) => e.id.startsWith("calc:decomp:"))?.status).toBe("partial");

    state.actions = "dividend";
    const healed = (await pipeline.analyzeWorkspace(ws)).episodes[0];
    expect(healed.actionsMissing).toBeUndefined();
    expect(healed.dividends).toBe(1000);
    expect(healed.returnPct!).toBeGreaterThan(ep.returnPct!);
    const rebuilt = await pipeline.buildEvidenceSet(ws, healed);
    expect(rebuilt.builtAt).toBeGreaterThan(bad.builtAt - 1);
    expect(rebuilt.episode.returnPct).toBe(healed.returnPct);
    expect(rebuilt.items.find((e) => e.id.startsWith("calc:decomp:"))?.value).toBe(healed.returnPct);
  });

  it("交易日历失败：校验跳过交易日检查，但其余校验照常", async () => {
    state.calendar = "failed";
    const { a } = await setup();
    expect(a.sources.find((s) => s.key === "calendar")).toMatchObject({ status: "failed", critical: true });
    expect(a.episodes).toHaveLength(1);
  });
});

describe("模型故障和输出校验", () => {
  it("模型调用失败：降级为规则版复盘，写明原因，教训用规则模板", async () => {
    const { ws, ep } = await setup();
    llm.mode = "down";
    const doc = await review.generateReview(ws, ep.id);
    expect(doc.mode).toBe("rules_only");
    expect(doc.fallbackReason).toContain("ETIMEDOUT");
    expect(doc.exAnteErrors[0]).toContain("生成失败");
    expect(doc.biases.length).toBeGreaterThan(0);
    expect(doc.lessons.every((l) => l.source === "rule")).toBe(true);
  });

  it("模型输出不合格：无引用、引用事后证据、编造数字、买卖建议和涨跌预测都被拦下并记录", async () => {
    const { ws, ep } = await setup();
    llm.mode = "bad";
    const doc = await review.generateReview(ws, ep.id);
    const view = doc.exAnte[0];
    expect(view.supporting).toEqual([]); // 一条没引用，一条引用了买入之后才发布的公告
    expect(view.summary).not.toContain("逢低买入");
    expect(doc.expost?.narrative).not.toContain("99.9");
    expect(doc.expost?.narrative).not.toContain("继续上涨");
    expect(doc.expost?.facts).toEqual([]); // 88.88 在证据里找不到
    expect(doc.lessons.every((l) => !l.text.includes("满仓"))).toBe(true);
    const reasons = doc.validationLog.map((l) => l.reason).join("\n");
    expect(reasons).toContain("没有引用任何证据");
    expect(reasons).toContain("决策时不可知");
    expect(reasons).toContain("合规过滤");
    expect(reasons).toContain("88.88");
  });

  it("模型返回的 JSON 结构不对（该是列表的给了对象）：不让整份复盘失败，丢掉坏字段，教训用规则模板兜底", async () => {
    const { ws, ep } = await setup();
    llm.mode = "malformed";
    const doc = await review.generateReview(ws, ep.id);
    expect(doc.exAnte[0]).toMatchObject({ summary: "", supporting: [], warnings: [], reasonCheck: [] });
    expect(doc.exAnte[0].negativesCheck.map((x) => x.evidenceId)).toEqual(["news:n1"]);
    expect(doc.expost).toMatchObject({ narrative: "", facts: [], biasNotes: [], failedAssumption: null, uncertainties: [] });
    expect(doc.lessons.length).toBeGreaterThan(0);
    expect(doc.lessons.every((l) => l.source === "rule")).toBe(true);
  });

  it("当时视角发给模型的证据包里没有股票代码和年份：证据 id 换成临时编号，输出里的编号换回真实 id", async () => {
    const { ws, ep } = await setup();
    const doc = await review.generateReview(ws, ep.id);
    const evidencePart = llm.lastExAnte.split("## 证据")[1].split("## 需要逐条核对")[0];
    expect(evidencePart).not.toMatch(/600001|2026/);
    expect([...evidencePart.matchAll(/"id":"([^"]+)"/g)].every((m) => /^E\d+$/.test(m[1]))).toBe(true);
    expect(doc.exAnte[0].supporting[0]?.evidenceIds[0]).toMatch(/^calc:runup5:/);
  });

  it("B8：理由没提到当时可知、和逻辑相关的问询函（标题含“问询”算重要新闻），判命中，置信度低", async () => {
    const { ws, ep } = await setup();
    llm.mode = "bad";
    const doc = await review.generateReview(ws, ep.id);
    const b8 = doc.biases.find((b) => b.ruleId === "B8")!;
    expect(b8).toMatchObject({ outcome: "hit", confidence: "low", evidenceIds: ["news:n1"] });
  });
});

describe("决策前检查的降级", () => {
  const input = { query: "600001", side: "buy" as const, reason: "看好业绩", planStop: 8, planTarget: null };
  // 假数据的交易日只到 8 月底，把"现在"放到 8 月中，近 3 个交易日才有龙虎榜可查
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-08-20T10:00:00+08:00"));
  });
  afterEach(() => vi.useRealTimers());


  it("龙虎榜没取到：热度检查是无法判断，不显示没上榜", async () => {
    const { runPrecheck } = await import("@/lib/precheck");
    const { ws } = await setup();
    state.lhb = "failed";
    const r = await runPrecheck(input, ws, null);
    if ("error" in r) throw new Error(r.error);
    const hot = r.checks.find((c) => c.trigger === "hot")!;
    expect(hot.status).toBe("unknown");
    expect(hot.detail).not.toContain("没上龙虎榜");
    expect(r.sourceErrors.join("；")).toContain("龙虎榜");
  });

  it("新闻和公告没取到、也没找到负面信息：负面信息检查是无法判断；买入时恐慌卖出检查是不适用", async () => {
    const { runPrecheck } = await import("@/lib/precheck");
    const { ws } = await setup();
    state.news = "failed";
    state.ifind = "failed";
    const r = await runPrecheck(input, ws, null);
    if ("error" in r) throw new Error(r.error);
    expect(r.checks.find((c) => c.trigger === "attention")).toMatchObject({ status: "unknown" });
    expect(r.checks.find((c) => c.trigger === "panic")).toMatchObject({ status: "na" });
  });

  it("新闻没翻完、已取到的部分没有负面信息：负面信息检查是无法判断，并写明缺口", async () => {
    const { runPrecheck } = await import("@/lib/precheck");
    const { ws } = await setup();
    state.news = "partial";
    const r = await runPrecheck(input, ws, null);
    if ("error" in r) throw new Error(r.error);
    const att = r.checks.find((c) => c.trigger === "attention")!;
    expect(att.status).toBe("unknown");
    expect(att.detail).toContain("没有翻完");
    expect(r.sourceErrors.join("；")).toContain("没有翻完");
  });

  it("数据都取到：有负面新闻时触发，热度两项都没命中时才是未触发", async () => {
    const { runPrecheck } = await import("@/lib/precheck");
    const { ws } = await setup();
    const r = await runPrecheck(input, ws, null);
    if ("error" in r) throw new Error(r.error);
    expect(r.checks.find((c) => c.trigger === "attention")).toMatchObject({ status: "triggered" });
    expect(r.checks.find((c) => c.trigger === "hot")).toMatchObject({ status: "clear" });
  });
});

describe("用户数据的保留和删除", () => {
  it("示例组合不能被导入覆盖：伪造成 demo 的工作区 id 不认，直接写示例组合会被拒绝", async () => {
    const { isVisitorWorkspace } = await import("@/lib/workspace");
    const { randomUUID } = await import("node:crypto");
    expect(isVisitorWorkspace("demo")).toBe(false);
    expect(isVisitorWorkspace("demodemo")).toBe(false);
    expect(isVisitorWorkspace(randomUUID())).toBe(true);
    expect(() => pipeline.saveTrades("demo", trades.parseTradesCsv(CSV).trades)).toThrow("只读");
  });

  it("iFinD 的累计用量不会因为清理 30 天前的日志而减少", async () => {
    const { cleanupExpired } = await import("@/lib/retention");
    const { ifindLiveCalls } = await import("@/lib/sources/cache");
    const { db } = await import("@/lib/db");
    const old = Date.now() - 40 * 86_400_000;
    const ins = db().prepare("INSERT INTO call_log (source, endpoint, params, status, code, message, latency_ms, from_cache, at) VALUES (?, ?, '{}', 'ok', NULL, NULL, 1, ?, ?)");
    ins.run("ifind", "tools/call:search_notice", 0, old);
    ins.run("fuyao", "/api/x", 0, old);
    const before = ifindLiveCalls();
    cleanupExpired();
    expect(ifindLiveCalls()).toBe(before);
    expect((db().prepare("SELECT COUNT(*) AS n FROM call_log WHERE source = 'fuyao' AND at = ?").get(old) as { n: number }).n).toBe(0);
  });

  it("一键删除只删当前工作区；示例组合不能删", async () => {
    const { purgeWorkspace } = await import("@/lib/retention");
    const { ws } = await setup();
    expect(pipeline.loadTrades(ws).length).toBe(2);
    expect(purgeWorkspace(ws)).toBe(2);
    expect(pipeline.loadTrades(ws)).toEqual([]);
    expect(purgeWorkspace("demo")).toBe(0);
  });

  it("揭晓前的判断每笔只能写一次；决策记录补充理由时新增版本，原版本保留；可以一键删除", async () => {
    const rec = await import("@/lib/records");
    const { purgeWorkspace } = await import("@/lib/retention");
    const { ws, ep } = await setup();
    const vid = `visitor-${n}`;
    const tradeId = ep.trades[0].id;
    expect(rec.addPrejudgment(vid, ws, ep.id, { tradeId, verdict: "gaps", worry: "涨得太急", afterReveal: false })).toBe(true);
    expect(rec.addPrejudgment(vid, ws, ep.id, { tradeId, verdict: "sufficient", worry: null, afterReveal: false })).toBe(false);
    expect(rec.listPrejudgments(vid, ws, ep.id)).toMatchObject([{ tradeId, verdict: "gaps", worry: "涨得太急" }]);

    const snapshot = { asOf: "2026-08-19", checks: [{ text: "下单前写好止损和目标", status: "clear", detail: "止损 8%" }], facts: [], sourceErrors: [] };
    const root = rec.addNote(vid, { code: "600001.SH", name: "测试股份", side: "buy", reason: "看好业绩", planStop: 8, planTarget: null, snapshot })!;
    expect(rec.addNoteVersion(vid, root, { reason: "看好业绩；补充：订单已确认", planStop: 6, planTarget: 20 })).toBe(2);
    expect(rec.addNoteVersion("someone-else", root, { reason: "x", planStop: null, planTarget: null })).toBeNull();
    const [note] = rec.listNotes(vid);
    expect(note.versions.map((v) => [v.version, v.reason])).toEqual([[1, "看好业绩"], [2, "看好业绩；补充：订单已确认"]]);
    expect(note.snapshot?.checks[0].detail).toBe("止损 8%");

    purgeWorkspace(ws); // 删除导入数据时，这个工作区的判断一起删
    expect(rec.listPrejudgments(vid, ws, ep.id)).toEqual([]);
    expect(rec.purgeVisitorRecords(vid)).toBe(2);
    expect(rec.listNotes(vid)).toEqual([]);
  });

  it("超过 7 天的导入数据自动清理，新导入的保留", async () => {
    const { cleanupExpired } = await import("@/lib/retention");
    const { ws } = await setup();
    const r1 = cleanupExpired(Date.now());
    expect(pipeline.loadTrades(ws).length).toBe(2);
    const r2 = cleanupExpired(Date.now() + 8 * 86_400_000);
    expect(r2.workspaces).toBeGreaterThan(r1.workspaces);
    expect(pipeline.loadTrades(ws)).toEqual([]);
  });
});
