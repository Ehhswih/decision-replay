// B8 选择性关注：用当时视角里 AI 的核对结果定论。
// 只核对规则列出的候选（买入前 10 天内、当时可知、语气负面的新闻、公告、异动）。AI 有时会把标题正面的新闻
// 也放进来（比如投资者互动里有人质疑回购，标题却是"回购计划经股东会审议通过"），或者引用 10 天以外的旧消息，
// 这些不在规则的定义里，不算。
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

/** b 是规则刚算出的 B8 结果：needsAi 时 evidenceIds 就是规则列出的候选负面信息 */
export function resolveB8(b: BiasResult, checks: NegativeCheck[], evidence: Map<string, Evidence>): BiasResult {
  const candidates = new Set(b.needsAi ? b.evidenceIds : []);
  if (!candidates.size) return b;
  // 同一条可能被核对两次，只留第一次
  const ids = new Set<string>();
  const checked = checks.filter((x) => candidates.has(x.evidenceId) && !ids.has(x.evidenceId) && ids.add(x.evidenceId));
  const unchecked = candidates.size - checked.length;
  if (!checked.length) {
    return { ...b, outcome: "undetermined", needsAi: false, confidence: "low", finding: `买入前 10 天内有 ${candidates.size} 条当时可知的负面信息，AI 没有逐条核对，无法判断是否被忽略` };
  }
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
  const rest = unchecked ? `；另外 ${unchecked} 条 AI 没有核对` : "";
  if (material.length) {
    return {
      ...b,
      outcome: "hit",
      needsAi: false,
      confidence: material.length >= 2 ? "mid" : "low",
      evidenceIds: material.map((x) => x.evidenceId),
      finding: `理由没有提到 ${material.length} 条当时可知的重要负面信息：${titles(material)}`,
    };
  }
  if (!ignored.length) {
    return unchecked
      ? { ...b, outcome: "undetermined", needsAi: false, confidence: "low", finding: `核对到的 ${checked.length} 条负面信息在理由里都有回应${rest}，无法判断是否被忽略` }
      : { ...b, outcome: "not_hit", needsAi: false, confidence: "low", evidenceIds: checked.map((x) => x.evidenceId), finding: `买入前的 ${checked.length} 条负面信息在理由里都有回应` };
  }
  return {
    ...b,
    outcome: "undetermined",
    needsAi: false,
    confidence: "low",
    evidenceIds: ignored.map((x) => x.evidenceId),
    finding: `理由没有提到 ${ignored.length} 条负面信息（${titles(ignored)}），但它们是一般新闻或和买入逻辑无直接关系，不判定为忽略${rest}`,
  };
}
