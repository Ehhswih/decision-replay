import "server-only";
import { db } from "@/lib/db";
import { shDate, shDateTime } from "@/lib/time";
import { classify } from "@/lib/domain/pit";
import { attribute, ERROR_LABEL, type Attribution } from "@/lib/domain/attribution";
import type { BiasResult } from "@/lib/domain/biases";
import type { Evidence } from "@/lib/domain/evidence";
import type { Episode, EpisodeTrade } from "@/lib/domain/types";
import { rulesForWorkspace } from "@/lib/rules-review";
import type { EvidenceSet } from "@/lib/pipeline";
import { resolveB8 } from "./b8";
import { chatJson } from "./deepseek";
import { exAntePack, expostPack, packText, type PackItem } from "./pack";
import { EX_ANTE_SYSTEM, EX_POST_SYSTEM, exAnteUser, exPostUser } from "./prompts";
import { checkClaim, checkClaims, cleanText, detectLeakage, type Claim, type CheckContext, type LogEntry } from "./validate";

export interface ExAnteView {
  tradeId: string;
  decisionTs: number;
  anonymized: boolean;
  summary: string;
  supporting: Claim[];
  warnings: Claim[];
  reasonCheck: { claim: string; status: "supported" | "contradicted" | "unverifiable"; text: string; evidenceIds: string[] }[];
  negativesCheck: { evidenceId: string; addressed: boolean; relevant: boolean; note: string }[];
  leakage: string[];
  packSize: number;
}

export type LessonTrigger = "chase" | "hot" | "panic" | "anchor" | "plan" | "overtrade" | "disposition" | "attention" | "other";

export interface Lesson {
  id: string;
  text: string;
  trigger: LessonTrigger;
  evidenceIds: string[];
  source: "ai" | "rule";
}

export interface ReviewDoc {
  episodeId: string;
  generatedAt: number;
  model: string | null;
  mode: "ai" | "rules_only";
  fallbackReason?: string;
  exAnte: ExAnteView[];
  exAnteErrors: string[];
  expost: {
    narrative: string;
    facts: Claim[];
    biasNotes: { ruleId: string; explanation: string; alternative: string }[];
    failedAssumption: Claim | null;
    uncertainties: Claim[];
  } | null;
  lessons: Lesson[];
  biases: BiasResult[];
  attribution: Attribution;
  dataUncertainties: { text: string; evidenceIds: string[] }[];
  validationLog: LogEntry[];
  usage: { calls: number; prompt: number; completion: number; reasoning: number; latencyMs: number };
}

const TEMPLATES: Record<string, { text: string; trigger: LessonTrigger }> = {
  B1: { text: "买入前先看 5 日涨幅：超过 15% 时，先写下这次为什么不算追高", trigger: "chase" },
  B2: { text: "买入热股榜前 20 或刚上龙虎榜的股票前，先写下不看热度时的买入理由", trigger: "hot" },
  B3: { text: "连续下跌后想卖时，先对照买入时写的止损线，再决定是否执行", trigger: "panic" },
  B4: { text: "亏损持仓超过原定持有期时，强制复查一次买入逻辑是否还成立", trigger: "disposition" },
  B5: { text: "同一只股票 10 个交易日内准备第三次交易前，先复查前两次的结果和手续费", trigger: "overtrade" },
  B6: { text: "深度浮亏时提前写下离场条件，不把回到成本价当作卖出理由", trigger: "anchor" },
  B7: { text: "止损线被跌破当天，要么执行，要么写下不执行的理由", trigger: "plan" },
  B8: { text: "买入前把近 10 天的负面公告和新闻过一遍，在理由里写明怎么看", trigger: "attention" },
  NOPLAN: { text: "买入时写下止损和目标，卖出时对照执行", trigger: "plan" },
};

function planText(t: EpisodeTrade) {
  const p = [t.planStop != null ? `止损 ${t.planStop}%` : "", t.planTarget != null ? `目标 +${t.planTarget}%` : ""].filter(Boolean);
  return p.length ? p.join("，") : "（没有记录止损或目标）";
}

/** 资金流向、涨跌幅、板块联动这类通用盘面描述，决策前后都会出现，不算具体的事后事件 */
const GENERIC_TERM = /资金|涨幅|跌幅|板块|回调|超涨|超跌|获利|情绪|跟跌|跟涨|大盘|指数|走弱|走强|市场|行业|调整|集体|普跌|普涨|估值|热度|题材|概念|龙头/;

/** 决策之后才出现的具体事件关键词（异动关键词、公告标题），剔除决策前出现过的和通用描述 */
export function expostTerms(items: Evidence[], t: number, anonymize: (s: string) => string) {
  const before = items.filter((e) => classify(e, t) === "ex_ante").map((e) => `${e.title} ${e.detail ?? ""}`).join(" ");
  const terms: string[] = [];
  for (const e of items) {
    if (classify(e, t) !== "ex_post") continue;
    if (e.kind === "anomaly") terms.push(...(e.title.split("：")[1] ?? "").split("、"));
    if (e.kind === "notice") terms.push(e.title.replace(/^.*?[：:]/, ""));
  }
  return [...new Set(terms.map((x) => x.trim()).filter((x) => x.length >= 4 && !before.includes(x) && !GENERIC_TERM.test(x)))].map(anonymize);
}

function dataUncertainties(set: EvidenceSet, ep: Episode) {
  const out: { text: string; evidenceIds: string[] }[] = [];
  for (const s of set.sources) {
    if (s.status === "failed") out.push({ text: `${s.label}获取失败（${s.error?.message ?? "未知原因"}），相关结论可能不完整`, evidenceIds: [] });
    else if (s.status === "stale") out.push({ text: `${s.label}本次获取失败，使用的是之前缓存的数据`, evidenceIds: [] });
    else if (s.note) out.push({ text: `${s.label}：${s.note}`, evidenceIds: [] });
  }
  for (const t of ep.trades.filter((x) => !x.timeKnown)) out.push({ text: `${shDate(t.ts)} 的成交只有日期没有时刻，按 09:30 处理，当天盘中的信息都算作事后`, evidenceIds: [`trade:${t.id}`] });
  for (const t of ep.trades) {
    const same = set.items.filter((e) => e.precision === "day" && !e.nonPit && classify(e, t.ts) === "uncertain");
    if (same.length) out.push({ text: `有 ${same.length} 条信息和 ${shDateTime(t.ts)} 的成交在同一天发布，只精确到日期，无法确定先后`, evidenceIds: same.slice(0, 5).map((e) => e.id) });
  }
  const ai = set.items.filter((e) => e.thirdPartyAi);
  if (ai.length) out.push({ text: `${ai.length} 条证据是数据商用 AI 生成的摘要（异动解读等），不是原始公告`, evidenceIds: ai.slice(0, 5).map((e) => e.id) });
  return out;
}

function ctxFor(pack: PackItem[], evidence: Map<string, Evidence>, log: LogEntry[], stage: string, exAnteAt?: number, alwaysSources: string[] = []): CheckContext {
  const texts = new Map(pack.map((p) => [p.id, packText(p)]));
  return { evidence, exAnteAt, log, stage, alwaysSources, packTexts: [...texts.values()], textOf: (e) => texts.get(e.id) ?? `${e.title} ${e.detail ?? ""} ${e.value ?? ""}` };
}

type ExAnteOut = { summary?: string; supporting?: unknown; warnings?: unknown; reason_check?: { claim?: string; status?: string; text?: string; evidence_ids?: string[] }[]; negatives_check?: { evidence_id?: string; addressed_in_reason?: boolean; relevant?: boolean; note?: string }[] };
type ExPostOut = { narrative?: string; facts?: unknown; bias_notes?: { rule_id?: string; explanation?: string; alternative?: string }[]; failed_assumption?: { text?: string; evidence_ids?: string[] }; uncertainties?: unknown; lessons?: { text?: string; trigger?: string; evidence_ids?: string[] }[] };

export async function generateReview(
  workspace: string,
  episodeId: string,
  onStage: (s: string) => void = () => {},
  opts: { refreshEvidence?: boolean } = {},
): Promise<ReviewDoc> {
  onStage(opts.refreshEvidence ? "重新取数并整理证据" : "整理证据和规则结果");
  // 重新生成时同时刷新这个持仓段的证据，而不是继续用旧缓存
  const rules = await rulesForWorkspace(workspace, { refreshEpisode: opts.refreshEvidence ? episodeId : undefined });
  const er = rules.episodes.find((x) => x.episode.id === episodeId);
  const set = rules.sets.get(episodeId);
  if (!er || !set) throw new Error("找不到这个持仓段");
  const ep = er.episode;
  const evidence = new Map(set.items.map((e) => [e.id, e]));
  const log: LogEntry[] = [];
  const usage = { calls: 0, prompt: 0, completion: 0, reasoning: 0, latencyMs: 0 };
  let model: string | null = null;
  const biases = er.biases.map((b) => ({ ...b }));

  // 1. 当时视角：每笔买入一次（最多 3 次），匿名化
  const exAnte: ExAnteView[] = [];
  const exAnteErrors: string[] = [];
  const buys = ep.trades.filter((t) => t.side === "buy").slice(0, 3);
  for (const [i, t] of buys.entries()) {
    onStage(`生成当时视角 ${i + 1}/${buys.length}`);
    const { pack, anon, decisionTime } = exAntePack(ep, set.items, t, true);
    // 规则列出的 B8 候选，让 AI 逐条核对，不自己挑
    const b8 = biases.find((b) => b.ruleId === "B8" && b.tradeId === t.id);
    const negativeIds = b8?.needsAi ? b8.evidenceIds.filter((id) => pack.some((p) => p.id === id)) : [];
    const r = await chatJson<ExAnteOut>(EX_ANTE_SYSTEM, exAnteUser({ decisionTime, reason: t.reason ? anon!.text(t.reason) : null, plan: planText(t), pack, negativeIds }));
    usage.calls++;
    usage.latencyMs += r.latencyMs;
    if (!r.ok) {
      exAnteErrors.push(`${shDateTime(t.ts)} 的当时视角生成失败：${r.message}`);
      continue;
    }
    model = r.model;
    usage.prompt += r.usage.prompt;
    usage.completion += r.usage.completion;
    usage.reasoning += r.usage.reasoning;
    const self = pack.find((p) => p.id === `trade:${t.id}`);
    const ctx = ctxFor(pack, evidence, log, `当时视角 ${shDate(t.ts)}`, t.ts, self ? [packText(self)] : []);
    const restore = (c: Claim) => ({ ...c, text: anon!.restore(c.text) });
    const rawText = JSON.stringify(r.data);
    const leakage = detectLeakage(rawText, expostTerms(set.items, t.ts, anon!.text), pack.map(packText).join(" "));
    for (const l of leakage) log.push({ stage: ctx.stage, text: l, reason: "疑似后见之明泄漏：输出里出现了决策之后才有的信息" });
    const inPack = new Set(pack.map((p) => p.id));
    exAnte.push({
      tradeId: t.id,
      decisionTs: t.ts,
      anonymized: true,
      summary: anon!.restore(cleanText(r.data.summary, ctx)),
      supporting: checkClaims(r.data.supporting, ctx).map(restore),
      warnings: checkClaims(r.data.warnings, ctx).map(restore),
      reasonCheck: (r.data.reason_check ?? [])
        .map((x) => {
          const c = checkClaim({ text: x.text, evidence_ids: x.evidence_ids }, ctx);
          const status = x.status === "supported" || x.status === "contradicted" ? x.status : "unverifiable";
          if (!c && status !== "unverifiable") return null;
          return { claim: anon!.restore(String(x.claim ?? "")), status, text: anon!.restore(c?.text ?? cleanText(x.text, ctx)), evidenceIds: c?.evidenceIds ?? [] } as ExAnteView["reasonCheck"][number];
        })
        .filter((x): x is ExAnteView["reasonCheck"][number] => !!x),
      negativesCheck: (r.data.negatives_check ?? [])
        .filter((x) => typeof x.evidence_id === "string" && inPack.has(x.evidence_id))
        .map((x) => ({ evidenceId: x.evidence_id as string, addressed: x.addressed_in_reason === true, relevant: x.relevant !== false, note: anon!.restore(cleanText(x.note, ctx)) })),
      leakage,
      packSize: pack.length,
    });
  }

  // 2. B8 选择性关注：用 AI 的核对结果定论（AI 核对过的负面信息都在当时视角的证据包里，必然当时可知）
  for (const [i, b] of biases.entries()) {
    if (b.ruleId !== "B8" || !b.needsAi || !b.tradeId) continue;
    const view = exAnte.find((v) => v.tradeId === b.tradeId);
    if (view) biases[i] = resolveB8(b, view.negativesCheck, evidence);
  }
  let attribution = attribute(ep, set.items, biases);

  // 3. 事后复盘
  onStage("生成事后复盘");
  const pack = expostPack(ep, set.items);
  const hits = biases.filter((b) => b.outcome === "hit");
  const rulesText = [
    `过程与结果：${attribution.quadrant}；问题归类：${ERROR_LABEL[attribution.errorType]}（${attribution.errorReason.text}）`,
    ...attribution.processPoints.map((p) => `- ${p.text}`),
    ...biases.map((b) => `${b.ruleId} ${b.name}：${b.outcome === "hit" ? "命中" : b.outcome === "not_hit" ? "未命中" : "无法判定"}。${b.finding}`),
  ].join("\n");
  const tradesText = ep.trades.map((t) => `${shDateTime(t.ts)} ${t.side === "buy" ? "买入" : "卖出"} ${t.qty} 股 @ ${t.price}；理由：${t.reason ?? "（没有记录）"}；${t.side === "buy" ? planText(t) : ""}`).join("\n");
  const summary = `${ep.name ?? ep.code}（${ep.code}），${shDate(ep.openTs)} 至 ${ep.closeTs ? shDate(ep.closeTs) : "今天（未平仓）"}，收益 ${ep.returnPct ?? "—"}%`;
  const r = await chatJson<ExPostOut>(EX_POST_SYSTEM, exPostUser({ summary, trades: tradesText, rules: rulesText, pack }));
  usage.calls++;
  usage.latencyMs += r.latencyMs;

  let expost: ReviewDoc["expost"] = null;
  let lessons: Lesson[] = [];
  let fallbackReason: string | undefined;
  if (r.ok) {
    model = r.model;
    usage.prompt += r.usage.prompt;
    usage.completion += r.usage.completion;
    usage.reasoning += r.usage.reasoning;
    // 成交记录和程序算出的规则结果里的数字，模型可以直接引用
    const ctx = ctxFor(pack, evidence, log, "事后复盘", undefined, [...ep.trades.map((t) => `${t.price} ${t.qty}`), rulesText]);
    const hitIds = new Set(hits.map((b) => b.ruleId));
    const fa = r.data.failed_assumption?.text?.trim() ? checkClaim({ text: r.data.failed_assumption.text, evidence_ids: r.data.failed_assumption.evidence_ids, type: "inference" }, ctx) : null;
    expost = {
      narrative: cleanText(r.data.narrative, ctx),
      facts: checkClaims(r.data.facts, ctx),
      biasNotes: (r.data.bias_notes ?? [])
        .filter((x) => typeof x.rule_id === "string" && hitIds.has(x.rule_id as BiasResult["ruleId"]))
        .map((x) => ({ ruleId: x.rule_id as string, explanation: cleanText(x.explanation, ctx), alternative: cleanText(x.alternative, ctx) })),
      failedAssumption: fa ? { ...fa, type: "inference" } : null,
      uncertainties: checkClaims(r.data.uncertainties, ctx).map((c) => ({ ...c, type: "uncertain" as const })),
    };
    // 通过校验的"被推翻的假设"才能把亏损归为看错了
    attribution = attribute(ep, set.items, biases, { failedAssumption: expost.failedAssumption });
    const triggers: LessonTrigger[] = ["chase", "hot", "panic", "anchor", "plan", "overtrade", "disposition", "attention", "other"];
    lessons = (r.data.lessons ?? [])
      .map((x): Lesson | null => {
        // 教训是下次的检查动作，里面的阈值是建议值，不要求在证据里出现
        const c = checkClaim({ text: x.text, evidence_ids: x.evidence_ids }, ctx, { checkNumbers: false });
        if (!c) return null;
        const trigger = triggers.includes(x.trigger as LessonTrigger) ? (x.trigger as LessonTrigger) : "other";
        return { id: "", text: c.text, trigger, evidenceIds: c.evidenceIds, source: "ai" };
      })
      .filter((x): x is Lesson => !!x);
  } else {
    fallbackReason = `事后复盘生成失败：${r.message}。下面只展示程序规则得出的结果。`;
  }

  // 4. AI 没给出合格的教训时，用规则模板兜底
  if (!lessons.length) {
    const keys = hits.map((b) => b.ruleId as string);
    if (!buys.some((t) => t.planStop != null || t.planTarget != null)) keys.push("NOPLAN");
    lessons = [...new Set(keys)].slice(0, 3).map((k) => ({ id: "", ...TEMPLATES[k], evidenceIds: hits.find((b) => b.ruleId === k)?.evidenceIds ?? [], source: "rule" as const }));
  }
  lessons = lessons.map((l, i) => ({ ...l, id: `${episodeId}:L${i + 1}` }));

  return {
    episodeId,
    generatedAt: Date.now(),
    model,
    mode: expost ? "ai" : "rules_only",
    fallbackReason,
    exAnte,
    exAnteErrors,
    expost,
    lessons,
    biases,
    attribution,
    dataUncertainties: dataUncertainties(set, ep),
    validationLog: log,
    usage,
  };
}

// ---------------- 后台任务 ----------------

type Row = { status: string; json: string | null; error: string | null; updated_at: number };

function save(key: string, workspace: string, status: string, json: unknown, error: string | null) {
  db()
    .prepare("INSERT OR REPLACE INTO reviews (episode_id, workspace, status, json, error, updated_at) VALUES (?, ?, ?, ?, ?, ?)")
    .run(key, workspace, status, json == null ? null : JSON.stringify(json), error, Date.now());
}

export function getReview(workspace: string, episodeId: string): { status: "none" | "running" | "done" | "failed"; stage?: string; review?: ReviewDoc; error?: string } {
  const row = db().prepare("SELECT status, json, error, updated_at FROM reviews WHERE episode_id = ?").get(`${workspace}/${episodeId}`) as Row | undefined;
  if (!row) return { status: "none" };
  if (row.status === "running") {
    // 进程重启后遗留的"运行中"超过 5 分钟就当失败
    if (Date.now() - row.updated_at > 5 * 60_000) return { status: "failed", error: "生成中断，请重新生成" };
    return { status: "running", stage: row.json ? JSON.parse(row.json).stage : undefined };
  }
  if (row.status === "done" && row.json) return { status: "done", review: JSON.parse(row.json) };
  return { status: "failed", error: row.error ?? "未知错误" };
}

const running = new Set<string>();

export function startReview(workspace: string, episodeId: string, force = false) {
  const key = `${workspace}/${episodeId}`;
  const cur = getReview(workspace, episodeId);
  if (running.has(key) || (cur.status === "done" && !force)) return cur;
  running.add(key);
  save(key, workspace, "running", { stage: "排队中" }, null);
  void generateReview(workspace, episodeId, (stage) => save(key, workspace, "running", { stage }, null), { refreshEvidence: force })
    .then((doc) => save(key, workspace, "done", doc, null))
    .catch((e) => save(key, workspace, "failed", null, e instanceof Error ? e.message : String(e)))
    .finally(() => running.delete(key));
  return { status: "running" as const, stage: "排队中" };
}

/**
 * 规则逻辑更新后，用已经生成的 AI 核对结果重新计算 B8 和归因，不用重新调模型。
 * baseBiases 是按最新规则算出的结果，AI 部分（当时视角、叙述、教训）原样保留。
 */
export function refreshDerived(doc: ReviewDoc, ep: Episode, items: Evidence[], baseBiases: BiasResult[]): ReviewDoc {
  const evidence = new Map(items.map((e) => [e.id, e]));
  const biases = baseBiases.map((b) => {
    if (b.ruleId !== "B8" || !b.tradeId) return b;
    const view = doc.exAnte.find((v) => v.tradeId === b.tradeId);
    return view ? resolveB8(b, view.negativesCheck, evidence) : b;
  });
  return { ...doc, biases, attribution: attribute(ep, items, biases, { failedAssumption: doc.expost?.failedAssumption ?? null }) };
}
