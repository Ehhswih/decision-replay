// 合规过滤：拦截买卖建议、仓位建议、收益承诺和对未来涨跌的判断（docs/design.md 第 8 节）。

const PATTERNS: { re: RegExp; reason: string }[] = [
  { re: /建议(?:你|您|用户|投资者)?(?:可以|适当|逢低|逢高|继续|尽快|考虑)?(?:买入|卖出|加仓|减仓|清仓|持有|抄底|止盈|建仓|补仓|离场|入场|上车)/, reason: "买卖或持仓建议" },
  { re: /(?:可以|应该|应当|不妨|值得)(?:逢低|逢高|适当)?(?:买入|卖出|加仓|减仓|清仓|抄底|建仓|补仓)/, reason: "买卖建议" },
  { re: /目标价|目标位(?:为|是|看)|上看\s*\d/, reason: "目标价" },
  { re: /必涨|必跌|稳赚|保本|稳赢|翻倍|包赚|无风险/, reason: "收益承诺" },
  { re: /仓位(?:控制在|保持在|建议|降到|提到)?\s*[一二三四五六七八九十\d]+\s*成|满仓|梭哈|重仓(?:买|持有)/, reason: "仓位建议" },
  { re: /(?:未来|后市|接下来|明天|下周|短期内|中长期)(?:将|会|有望|大概率|可能会)(?:继续)?(?:上涨|下跌|反弹|回调|走高|走低|突破|见顶|见底)/, reason: "涨跌预测" },
  { re: /(?:预计|预期|看好|看空)(?:股价|该股|标的)(?:将|会)?(?:上涨|下跌|反弹)/, reason: "涨跌预测" },
];

export interface ComplianceHit {
  original: string;
  reason: string;
}

export const REDACTED = "（此处原有涉及操作建议或涨跌预测的表述，已按合规要求移除）";

/** 按句子过滤：命中的句子整句替换成提示语 */
export function filterText(text: string): { text: string; hits: ComplianceHit[] } {
  const hits: ComplianceHit[] = [];
  const sentences = text.split(/(?<=[。！？；!?;\n])/);
  const out = sentences.map((s) => {
    const p = PATTERNS.find((x) => x.re.test(s));
    if (!p) return s;
    hits.push({ original: s.trim(), reason: p.reason });
    return REDACTED;
  });
  return { text: out.join(""), hits };
}

/** 用户输入里是不是在问"能不能买 / 会不会涨" */
export function isAdviceQuestion(text: string): boolean {
  return /(能不能|该不该|要不要|可不可以|值不值得|适不适合)(买|卖|入|加仓|减仓|抄底|上车|持有)|会不会(涨|跌)|(还能|会)涨吗|什么时候(买|卖)|买点|卖点/.test(text);
}

export const ADVICE_NOTICE =
  "决策回放只帮你回看过去的决策、整理自己的检查清单，不判断现在能不能买卖，也不预测涨跌。可以对照下面的历史教训和清单，自己做决定。";
