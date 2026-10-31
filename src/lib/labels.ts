// 界面用的中文标签（客户端和服务端都能用，不依赖任何服务端模块）

export const KIND_LABEL: Record<string, string> = {
  trade: "成交",
  computed: "计算指标",
  financial: "财报",
  news: "新闻",
  notice: "公告",
  anomaly: "异动解读",
  hot_rank: "热股排名",
  dragon_tiger: "龙虎榜",
  industry: "行业归属",
  corporate_action: "除权除息",
};

export const TIMING_TEXT = { ex_ante: "当时可知", ex_post: "事后才知", uncertain: "时序不确定" } as const;
export type TimingKey = keyof typeof TIMING_TEXT;

export const OUTCOME_TEXT = { hit: "命中", not_hit: "未命中", undetermined: "无法判定" } as const;

export const CLAIM_TYPE_TEXT = { fact: "事实", inference: "推断", uncertain: "不确定" } as const;
export const CONFIDENCE_TEXT = { high: "置信度高", mid: "置信度中", low: "置信度低" } as const;

export const ERROR_TYPE_TEXT: Record<string, string> = {
  judgment: "看错了",
  execution: "没做好",
  unforeseeable: "不可预见",
  none: "没有明显问题",
  undetermined: "暂无法归类",
};

export const TRIGGER_TEXT: Record<string, string> = {
  chase: "追涨",
  hot: "追热点",
  panic: "恐慌卖出",
  anchor: "锚定成本",
  plan: "执行计划",
  overtrade: "过度交易",
  disposition: "处置效应",
  attention: "选择性关注",
  other: "其他",
};

export const STATUS_TEXT: Record<string, string> = {
  ok: "正常",
  empty: "未获取到",
  stale: "用了缓存",
  failed: "获取失败",
  skipped: "跳过",
  partial: "部分缺失",
  missing: "缺失",
  conflict: "冲突",
};

export function pct(v: number | null | undefined, digits = 2) {
  if (v == null || Number.isNaN(v)) return "—";
  return `${v > 0 ? "+" : ""}${v.toFixed(digits)}%`;
}

/** A 股习惯：红涨绿跌 */
export function pctClass(v: number | null | undefined) {
  if (v == null || v === 0) return "text-muted-foreground";
  return v > 0 ? "text-up" : "text-down";
}

export function fmtDate(ms: number | null | undefined) {
  if (ms == null) return "—";
  return new Date(ms + 8 * 3600_000).toISOString().slice(0, 10);
}

export function fmtDateTime(ms: number | null | undefined) {
  if (ms == null) return "—";
  return new Date(ms + 8 * 3600_000).toISOString().slice(0, 16).replace("T", " ");
}

/** 和服务端 pit.classify 相同的规则，前端切换决策点时用 */
export function timingOf(e: { availableAt: number | null; precision: "ms" | "day"; nonPit?: boolean }, t: number): TimingKey {
  if (e.nonPit || e.availableAt == null) return "uncertain";
  if (e.precision === "ms") return e.availableAt <= t ? "ex_ante" : "ex_post";
  const a = fmtDate(e.availableAt);
  const d = fmtDate(t);
  return a < d ? "ex_ante" : a === d ? "uncertain" : "ex_post";
}

/** 组合层面规则对应的清单条目（和服务端规则模板一致） */
export const PORTFOLIO_LESSONS: Record<string, { text: string; trigger: string }> = {
  B4: { text: "亏损持仓超过原定持有期时，强制复查一次买入逻辑是否还成立", trigger: "disposition" },
  B5: { text: "同一只股票 10 个交易日内准备第三次交易前，先复查前两次的结果和手续费", trigger: "overtrade" },
};
