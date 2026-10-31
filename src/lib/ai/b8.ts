// B8 选择性关注：用当时视角里 AI 的核对结果定论。
// 只把"重要"的负面信息算进去（公告、异动解读、标题含业绩/减持/风险等的新闻），
// 普通新闻、以及和买入逻辑无直接关系的负面信息（板块下跌、市场情绪）没提到不算忽略——
// 任何 10 天窗口里都能找到几条语气负面的信息，否则这条规则会失去区分度（第一版在示例组合上命中 8/10）。

import type { BiasResult } from "@/lib/domain/biases";
import type { Evidence } from "@/lib/domain/evidence";

export interface NegativeCheck {
  evidenceId: string;
  addressed: boolean;
  note?: string;
  /** AI 判断这条负面信息是否直接动摇买入逻辑；缺省视为相关 */
  relevant?: boolean;
}

export function isMaterial(e: Evidence | undefined): boolean {
  if (!e) return false;
  return e.kind === "notice" || e.kind === "anomaly" || (e.kind === "news" && !!e.important);
}

export function resolveB8(b: BiasResult, checks: NegativeCheck[], evidence: Map<string, Evidence>): BiasResult {
  const checked = checks.filter((x) => ["news", "notice", "anomaly"].includes(evidence.get(x.evidenceId)?.kind ?? ""));
  if (!checked.length) return b;
  const ignored = checked.filter((x) => !x.addressed);
  // AI 自己说"无法判断"的不算相关；同一标题只算一次
  const unsure = (x: NegativeCheck) => /无法判断|不可见|看不到|无法确认|不确定/.test(x.note ?? "");
  const seen = new Set<string>();
  const material = ignored.filter((x) => {
    const e = evidence.get(x.evidenceId);
    if (!isMaterial(e) || x.relevant === false || unsure(x) || seen.has(e!.title)) return false;
    seen.add(e!.title);
    return true;
  });
  const titles = (l: NegativeCheck[]) => l.slice(0, 2).map((x) => evidence.get(x.evidenceId)?.title).join("；");
  if (!ignored.length) {
    return { ...b, outcome: "not_hit", needsAi: false, confidence: "low", evidenceIds: checked.map((x) => x.evidenceId), finding: `买入前的 ${checked.length} 条负面信息在理由里都有回应` };
  }
  if (!material.length) {
    return {
      ...b,
      outcome: "undetermined",
      needsAi: false,
      confidence: "low",
      evidenceIds: ignored.map((x) => x.evidenceId),
      finding: `理由没有提到 ${ignored.length} 条负面信息（${titles(ignored)}），但它们是一般新闻或和买入逻辑无直接关系，不判定为忽略`,
    };
  }
  return {
    ...b,
    outcome: "hit",
    needsAi: false,
    confidence: material.length >= 2 ? "mid" : "low",
    evidenceIds: material.map((x) => x.evidenceId),
    finding: `理由没有提到 ${material.length} 条当时可知的重要负面信息：${titles(material)}`,
  };
}
