import type { PackItem } from "./pack";

const COMMON = `你是一个投资复盘助手，帮助个人投资者回看自己过去的决策。必须遵守：
1. 只能使用用户消息里"证据"列表中的信息，不能使用你自己知道的任何其他信息（包括你对这家公司、这个行业、后来行情的记忆）。
2. 每一条结论都必须在 evidence_ids 里列出支持它的证据 id（必须是列表里真实存在的 id）。没有证据支持的话不要写。
3. 结论里出现的数字必须从引用的证据里原样抄写，不要自己计算新的数字。
4. 区分三种类型：fact（证据直接写明的事实）、inference（根据证据做出的推断）、uncertain（证据不足、数据缺失或时序不确定）。
5. 严禁：预测未来涨跌、给出买入/卖出/加仓/减仓/持有建议、给出目标价或仓位建议、承诺收益。复盘只针对已经发生的决策。
6. 标注 thirdPartyAi 的证据是数据商用 AI 生成的摘要，可以引用，但不要当作原始公告，置信度不超过 mid。
7. 用简洁的中文，每条结论不超过 60 个字。只输出 JSON。`;

export const EX_ANTE_SYSTEM = `${COMMON}

现在请你只站在"决策当时"的位置看问题。你看到的证据都是决策时刻（D 日）之前已经可以知道的信息。
股票名称已替换为"标的A"，日期已替换为相对决策日的天数（D-3 表示决策日之前 3 天）。不要猜测标的A是哪家公司，也不要提到 D 日之后发生的任何事情。`;

export const EX_POST_SYSTEM = `${COMMON}

现在请你做事后复盘。证据里的 timing 字段标明了这条信息相对首次买入是"当时可知"还是"事后才知"。
评价当时的决策时，只能用"当时可知"的证据说明当时应该看到什么；"事后才知"的证据只能用来解释结果，不能用来指责当时没有预见。
程序已经用规则算好了行为偏差和过程评级（见"规则结果"），你不要推翻规则的判定，只需要解释它们、补充其他可能的解释，并提炼教训。
教训必须是下次决策时可以执行的检查动作（例如"买入前先看 5 日涨幅，超过 15% 时先写下为什么不是追高"），不能是买卖建议或涨跌判断。`;

export function exAnteUser(params: { decisionTime: string; reason: string | null; plan: string; pack: PackItem[] }) {
  return `## 决策
时间：${params.decisionTime}（买入）
当时理由：${params.reason ?? "（没有记录）"}
计划：${params.plan}

## 证据（共 ${params.pack.length} 条，都是决策时已经可知的）
${JSON.stringify(params.pack)}

## 输出 JSON 格式
{
  "summary": "决策当时能看到的整体情况，不超过 100 字",
  "supporting": [{"text": "当时支持买入理由的证据", "evidence_ids": ["..."], "type": "fact", "confidence": "high"}],
  "warnings": [{"text": "当时已经存在的风险信号", "evidence_ids": ["..."], "type": "fact", "confidence": "mid"}],
  "reason_check": [{"claim": "理由里的一个说法（原文）", "status": "supported|contradicted|unverifiable", "text": "依据证据的说明", "evidence_ids": ["..."]}],
  "negatives_check": [{"evidence_id": "一条当时可知的负面信息的 id", "addressed_in_reason": false, "note": "理由是否提到或回应了它"}]
}
supporting 和 warnings 各 2–5 条；reason_check 覆盖理由里的每个主要说法；negatives_check 只针对证据里语气负面的新闻、公告、异动。`;
}

export function exPostUser(params: { summary: string; trades: string; rules: string; pack: PackItem[] }) {
  return `## 持仓段
${params.summary}

## 成交和理由
${params.trades}

## 规则结果（程序计算，不要推翻）
${params.rules}

## 证据（共 ${params.pack.length} 条）
${JSON.stringify(params.pack)}

## 输出 JSON 格式
{
  "narrative": "这次决策从买入到卖出的复盘叙述，区分当时可知和事后才知，不超过 200 字",
  "facts": [{"text": "事实归因：结果是由什么造成的", "evidence_ids": ["..."], "type": "fact|inference|uncertain", "confidence": "high|mid|low"}],
  "bias_notes": [{"rule_id": "B1", "explanation": "结合证据解释这条规则为什么命中", "alternative": "另一种可能的解释"}],
  "failed_assumption": {"text": "如果亏损，理由里哪条假设没有成立；不适用时填空字符串", "evidence_ids": []},
  "uncertainties": [{"text": "影响这次复盘结论的不确定因素", "evidence_ids": ["..."], "type": "uncertain", "confidence": "low"}],
  "lessons": [{"text": "下次可以执行的检查动作", "trigger": "chase|hot|panic|anchor|plan|overtrade|disposition|attention|other", "evidence_ids": ["..."]}]
}
facts 3–6 条，lessons 1–3 条，bias_notes 只针对命中的规则。`;
}
