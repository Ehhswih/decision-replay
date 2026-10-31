// 校验 AI 输出：引用必须存在且时点合规、数字必须能在引用里找到、过合规过滤。
// 不合格的结论整条丢掉，并写进 validationLog，界面上能看到丢了什么、为什么。

import { classify } from "@/lib/domain/pit";
import { filterText } from "@/lib/domain/compliance";
import type { Evidence } from "@/lib/domain/evidence";

export interface RawClaim {
  text?: unknown;
  evidence_ids?: unknown;
  type?: unknown;
  confidence?: unknown;
}

export interface Claim {
  text: string;
  evidenceIds: string[];
  type: "fact" | "inference" | "uncertain";
  confidence: "high" | "mid" | "low";
}

export interface LogEntry {
  stage: string;
  text: string;
  reason: string;
}

export interface CheckContext {
  evidence: Map<string, Evidence>;
  /** 当时视角：引用的证据必须在这个时刻之前可知 */
  exAnteAt?: number;
  /** 引用证据的可读文本（匿名化后的版本），用来核对数字 */
  textOf: (e: Evidence) => string;
  /** 不需要引用也可以出现的数字来源（这次决策本身的成交记录） */
  alwaysSources?: string[];
  /** 整个证据包的文本，用来核对没有引用字段的叙述 */
  packTexts?: string[];
  log: LogEntry[];
  stage: string;
}

const NUM = /-?\d+(?:\.\d+)?/g;
// 日期和报告期写法（2026-06-22、D-3、7-06、6月22日、2026年、2026Q1）不参与数字核对
const DATE = /20\d{2}-\d{2}-\d{2}|D[+-]\d+|(?<![\d.])\d{1,2}-\d{1,2}(?![\d.])|\d{1,2}月\d{1,2}日|(?:20\d{2})?[Qq][1-4]|20\d{2}年/g;

function numbersIn(s: string): number[] {
  return (s.replace(DATE, " ").match(NUM) ?? []).map(Number);
}

/** 句子里的数字是否都能在引用证据里找到（允许四舍五入差异）；小的计数词（3 条、5 个交易日）放行 */
export function numbersSupported(text: string, sources: string[]): { ok: boolean; missing: number[] } {
  const pool = sources.flatMap(numbersIn);
  const cleaned = text.replace(DATE, " ");
  const missing: number[] = [];
  const re = /(-?\d+(?:\.\d+)?)(\s*)(个交易日|个|条|次|笔|天|日|只|段|名|期|年|月|%|％|亿元|亿|万元|万|元|股|倍|个百分点)?/g;
  for (const m of cleaned.matchAll(re)) {
    const n = Number(m[1]);
    const unit = m[3] ?? "";
    if (Number.isInteger(n) && Math.abs(n) <= 20 && /个交易日|个|条|次|笔|天|日|只|段|期/.test(unit)) continue;
    if (/年|月/.test(unit) && Number.isInteger(n)) continue;
    const ok = pool.some((p) => Math.abs(p - n) <= Math.max(0.051, Math.abs(n) * 0.005) || Math.abs(Math.abs(p) - Math.abs(n)) <= 0.051);
    if (!ok) missing.push(n);
  }
  return { ok: missing.length === 0, missing };
}

const asType = (v: unknown): Claim["type"] => (v === "inference" || v === "uncertain" ? v : "fact");
const asConf = (v: unknown): Claim["confidence"] => (v === "high" || v === "low" ? v : "mid");

/** 校验一条结论；不合格返回 null 并记日志 */
export function checkClaim(raw: RawClaim, ctx: CheckContext, opts: { checkNumbers?: boolean } = {}): Claim | null {
  const text = typeof raw.text === "string" ? raw.text.trim() : "";
  if (!text) return null;
  const ids = Array.isArray(raw.evidence_ids) ? raw.evidence_ids.filter((x): x is string => typeof x === "string") : [];
  const drop = (reason: string) => {
    ctx.log.push({ stage: ctx.stage, text, reason });
    return null;
  };
  if (!ids.length) return drop("没有引用任何证据");
  const unknown = ids.filter((id) => !ctx.evidence.has(id));
  if (unknown.length === ids.length) return drop(`引用的证据不存在：${unknown.join("、")}`);
  const valid = ids.filter((id) => ctx.evidence.has(id));
  if (ctx.exAnteAt != null) {
    const late = valid.filter((id) => classify(ctx.evidence.get(id)!, ctx.exAnteAt!) !== "ex_ante");
    if (late.length) return drop(`当时视角引用了决策时不可知的证据：${late.join("、")}`);
  }
  if (opts.checkNumbers !== false) {
    const nums = numbersSupported(text, [...valid.map((id) => ctx.textOf(ctx.evidence.get(id)!)), ...(ctx.alwaysSources ?? [])]);
    if (!nums.ok) return drop(`数字在引用的证据里找不到：${nums.missing.join("、")}`);
  }
  const filtered = filterText(text);
  for (const h of filtered.hits) ctx.log.push({ stage: ctx.stage, text: h.original, reason: `合规过滤：${h.reason}` });
  if (filtered.hits.length && filtered.text.replace(/（此处原有[^）]*）/g, "").trim().length < 4) return null;
  return { text: filtered.text, evidenceIds: valid, type: asType(raw.type), confidence: asConf(raw.confidence) };
}

export function checkClaims(list: unknown, ctx: CheckContext): Claim[] {
  if (!Array.isArray(list)) return [];
  return list.map((x) => checkClaim(x as RawClaim, ctx)).filter((x): x is Claim => !!x);
}

/** 不带引用的自由文本（叙述、解释）：按句核对数字（对照整个证据包），再过合规过滤 */
export function cleanText(v: unknown, ctx: CheckContext): string {
  if (typeof v !== "string") return "";
  let text = v.trim();
  if (ctx.packTexts) {
    const pool = [...ctx.packTexts, ...(ctx.alwaysSources ?? [])];
    text = text
      .split(/(?<=[。！？；!?;])/)
      .filter((s) => {
        const r = numbersSupported(s, pool);
        if (!r.ok) ctx.log.push({ stage: ctx.stage, text: s.trim(), reason: `叙述里的数字在证据包里找不到：${r.missing.join("、")}，已删去这句` });
        return r.ok;
      })
      .join("");
  }
  const f = filterText(text);
  for (const h of f.hits) ctx.log.push({ stage: ctx.stage, text: h.original, reason: `合规过滤：${h.reason}` });
  return f.text;
}

/**
 * 后见之明泄漏检测：当时视角的输出里，出现了只在决策之后才出现的关键词。
 * 关键词取自决策后才发布的异动关键词和公告标题。
 */
export function detectLeakage(outputText: string, expostTerms: string[], inputText = ""): string[] {
  // 输入的证据包里本来就有的词不算泄漏：模型是从输入里读到的
  const uniq = [...new Set(expostTerms.map((t) => t.trim()).filter((t) => t.length >= 4 && !inputText.includes(t)))];
  return uniq.filter((t) => outputText.includes(t));
}
