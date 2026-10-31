// 归因的规则版：过程好坏 × 结果好坏，以及问题归类（看错了 / 没做好 / 可能受事后事件影响 / 暂无法归类）。
// 亏损本身不能证明判断错了：只有找到"理由里的假设 + 和它相反的证据"才归为看错了，证据不够就暂不归类。
// AI 可以提供被推翻的假设，但不能推翻这里基于数字的判断。

import { classify } from "./pit";
import type { BiasResult } from "./biases";
import type { Evidence } from "./evidence";
import type { Episode } from "./types";

export type ProcessGrade = "good" | "mixed" | "poor";
export type OutcomeGrade = "gain" | "loss" | "open";
export type ErrorType = "judgment" | "execution" | "unforeseeable" | "none" | "undetermined";

export interface Point {
  text: string;
  evidenceIds: string[];
}

export interface Attribution {
  process: ProcessGrade;
  outcome: OutcomeGrade;
  quadrant: string;
  processPoints: Point[];
  errorType: ErrorType;
  errorReason: Point;
  /** 持仓期间出现、买入时还不知道的负面事件：只是可能相关的影响因素，供 AI 写叙述时引用 */
  expostEvents: string[];
}

export const PROCESS_LABEL: Record<ProcessGrade, string> = { good: "过程合理", mixed: "过程有瑕疵", poor: "过程有明显问题" };
export const OUTCOME_LABEL: Record<OutcomeGrade, string> = { gain: "结果盈利", loss: "结果亏损", open: "尚未平仓" };
export const ERROR_LABEL: Record<ErrorType, string> = {
  judgment: "看错了",
  execution: "没做好",
  unforeseeable: "可能受事后事件影响",
  none: "没有明显问题",
  undetermined: "暂无法归类",
};

const BEHAVIOR_RULES = new Set(["B1", "B2", "B3", "B6"]);
const CONTRARY_KINDS = new Set<Evidence["kind"]>(["news", "notice", "anomaly", "financial"]);
/** 追涨和追热点是同一种买入时机问题，恐慌卖出和锚定成本价是同一种卖出问题，同组只算一次 */
const BEHAVIOR_GROUP: Record<string, string> = { B1: "entry", B2: "entry", B3: "exit", B6: "exit" };

export function attribute(
  ep: Episode,
  items: Evidence[],
  biases: BiasResult[],
  opts: { failedAssumption?: Point | null } = {},
): Attribution {
  const buys = ep.trades.filter((t) => t.side === "buy");
  const own = biases.filter((b) => !b.episodeIds || b.episodeIds.includes(ep.id));
  const hits = own.filter((b) => b.outcome === "hit" && BEHAVIOR_RULES.has(b.ruleId));
  const b7 = own.find((b) => b.ruleId === "B7");
  const hasReason = buys.every((t) => !!t.reason?.trim());
  const hasPlan = buys.some((t) => t.planStop != null || t.planTarget != null);
  const points: Point[] = [];

  points.push(
    hasReason
      ? { text: "每笔买入都记录了当时的理由", evidenceIds: buys.map((t) => `trade:${t.id}`) }
      : { text: "有买入没有记录理由，事后无法核对当时的判断", evidenceIds: buys.filter((t) => !t.reason).map((t) => `trade:${t.id}`) },
  );
  points.push(
    hasPlan
      ? { text: "买入时写了止损或目标", evidenceIds: buys.filter((t) => t.planStop != null || t.planTarget != null).map((t) => `trade:${t.id}`) }
      : { text: "买入时没有写退出计划（止损或目标）", evidenceIds: buys.map((t) => `trade:${t.id}`) },
  );
  if (b7?.outcome === "hit") points.push({ text: `没有按计划执行：${b7.finding}`, evidenceIds: b7.evidenceIds });
  if (b7?.outcome === "not_hit") points.push({ text: "规则没有发现偏离计划的情况（不等于证明执行到位）", evidenceIds: b7.evidenceIds });
  for (const h of hits) points.push({ text: `命中「${h.name}」规则：${h.finding}`, evidenceIds: h.evidenceIds });

  let process: ProcessGrade;
  const groups = new Set(hits.map((h) => BEHAVIOR_GROUP[h.ruleId]));
  if (b7?.outcome === "hit" || groups.size >= 2 || !hasReason) process = "poor";
  else if (hasPlan && b7?.outcome === "not_hit" && hits.length === 0) process = "good";
  else process = "mixed";

  const outcome: OutcomeGrade = ep.closeTs == null || ep.returnPct == null ? "open" : ep.returnPct > 0 ? "gain" : "loss";
  const quadrant = outcome === "open" ? `${PROCESS_LABEL[process]} · 尚未平仓` : `${process === "good" ? "过程好" : process === "mixed" ? "过程一般" : "过程差"} · ${outcome === "gain" ? "结果好" : "结果差"}`;

  // 持仓期间出现的、买入时不知道的负面事件
  const firstBuy = buys[0]?.ts ?? ep.openTs;
  const priority = (e: Evidence) => (e.kind === "notice" ? 0 : e.kind === "anomaly" ? 1 : 2);
  const expost = items.filter(
    (e) =>
      e.tone === "negative" &&
      e.important &&
      (e.kind === "anomaly" || e.kind === "notice" || e.kind === "news") &&
      e.availableAt != null &&
      classify(e, firstBuy) === "ex_post" &&
      (ep.closeTs == null || e.availableAt <= ep.closeTs),
  ).sort((x, y) => priority(x) - priority(y) || (x.availableAt as number) - (y.availableAt as number));
  // 选择性关注是 AI 判断：只有至少 2 条重要且相关的负面信息被忽略（置信度"中"）时，才挡住"可能受事后事件影响"
  const exanteNeg = own.find((b) => b.ruleId === "B8" && b.outcome === "hit" && b.confidence === "mid");
  // "看错了"要有被推翻的假设和相反的证据。相反证据得是事件或基本面（新闻、公告、异动、财报），
  // 只引用成交记录或价格跌幅等于"因为亏了所以看错了"，不算
  const fa = opts.failedAssumption;
  const byId = new Map(items.map((e) => [e.id, e]));
  const contrary = (id: string) => {
    const e = byId.get(id);
    return !!e && CONTRARY_KINDS.has(e.kind) && e.tone !== "positive";
  };
  // 没有记录理由就没有可以被推翻的假设；AI 自己都说“不足以确认”的也不算
  const hedged = (t: string) => /不足以|无法确认|无法核对|不能确认|不能确定|难以确认|无法判断|尚不能/.test(t);
  const failed = fa?.text.trim() && !hedged(fa.text) && buys.some((t) => !!t.reason?.trim()) && fa.evidenceIds.some(contrary) ? fa : null;
  // 相反的证据买入时已经能看到，就不是"事后才出现的意外"，优先归为看错了
  const failedExAnte = !!failed && failed.evidenceIds.some((id) => contrary(id) && classify(byId.get(id)!, firstBuy) === "ex_ante");

  let errorType: ErrorType;
  let errorReason: Point;
  if (outcome === "open") {
    errorType = "undetermined";
    errorReason = { text: "持仓还没结束，暂不归类", evidenceIds: [] };
  } else if (b7?.outcome === "hit") {
    errorType = "execution";
    errorReason = { text: "有计划但没按计划执行", evidenceIds: b7.evidenceIds };
  } else if (outcome === "loss" && failed && failedExAnte) {
    errorType = "judgment";
    errorReason = { text: `买入理由里的假设被证据否定，相反的证据买入时已经能看到：${failed.text}`, evidenceIds: failed.evidenceIds };
  } else if (outcome === "loss" && process === "good" && expost.length && !exanteNeg) {
    errorType = "unforeseeable";
    errorReason = {
      text: `过程没有发现明显问题；持仓期间出现了买入时还不知道的负面事件，可能与亏损有关，但不能证明是主因：${expost.slice(0, 2).map((e) => e.title).join("；")}`,
      evidenceIds: expost.slice(0, 3).map((e) => e.id),
    };
  } else if (outcome === "loss" && failed) {
    errorType = "judgment";
    errorReason = { text: `买入理由里的假设被证据否定：${failed.text}`, evidenceIds: failed.evidenceIds };
  } else if (outcome === "loss") {
    errorType = "undetermined";
    errorReason = {
      text: `亏损不能归到执行问题上，现有证据也找不到理由里哪条假设被推翻，暂不归类${expost.length ? `。持仓期间出现过买入时不知道的负面事件（${expost.slice(0, 2).map((e) => e.title).join("；")}），可能相关，但不能据此认定` : ""}`,
      evidenceIds: expost.slice(0, 3).map((e) => e.id),
    };
  } else {
    errorType = "none";
    errorReason = {
      text: process === "poor" ? "这次赚钱了，但过程有明显问题：结果好不代表方法对" : "结果盈利，过程没有明显问题",
      evidenceIds: points.flatMap((p) => p.evidenceIds).slice(0, 6),
    };
  }

  return { process, outcome, quadrant, processPoints: points, errorType, errorReason, expostEvents: expost.slice(0, 5).map((e) => e.id) };
}
