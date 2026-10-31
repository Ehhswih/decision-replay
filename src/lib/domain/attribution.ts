// 归因的规则版：过程好坏 × 结果好坏，以及问题归类（看错了 / 没做好 / 不可预见）。
// AI 之后可以补充理由，但不能推翻这里基于数字的判断，只能在"判断"类问题上给出更细的解释。

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
  /** 规则认为可能"不可预见"的事后事件，供 AI 写叙述时引用 */
  expostEvents: string[];
}

export const PROCESS_LABEL: Record<ProcessGrade, string> = { good: "过程合理", mixed: "过程有瑕疵", poor: "过程有明显问题" };
export const OUTCOME_LABEL: Record<OutcomeGrade, string> = { gain: "结果盈利", loss: "结果亏损", open: "尚未平仓" };
export const ERROR_LABEL: Record<ErrorType, string> = {
  judgment: "看错了",
  execution: "没做好",
  unforeseeable: "不可预见",
  none: "没有明显问题",
  undetermined: "暂无法归类",
};

const BEHAVIOR_RULES = new Set(["B1", "B2", "B3", "B6"]);
/** 追涨和追热点是同一种买入时机问题，恐慌卖出和锚定成本价是同一种卖出问题，同组只算一次 */
const BEHAVIOR_GROUP: Record<string, string> = { B1: "entry", B2: "entry", B3: "exit", B6: "exit" };

export function attribute(ep: Episode, items: Evidence[], biases: BiasResult[]): Attribution {
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
  if (b7?.outcome === "not_hit") points.push({ text: "按计划执行了退出", evidenceIds: b7.evidenceIds });
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
  // 选择性关注只有在 AI 确认命中后才挡住"不可预见"
  const exanteNeg = own.find((b) => b.ruleId === "B8" && b.outcome === "hit");

  let errorType: ErrorType;
  let errorReason: Point;
  if (outcome === "open") {
    errorType = "undetermined";
    errorReason = { text: "持仓还没结束，暂不归类", evidenceIds: [] };
  } else if (b7?.outcome === "hit") {
    errorType = "execution";
    errorReason = { text: "有计划但没按计划执行", evidenceIds: b7.evidenceIds };
  } else if (outcome === "loss" && process === "good" && expost.length && !exanteNeg) {
    errorType = "unforeseeable";
    errorReason = {
      text: `过程合理，亏损主要来自买入之后才出现的事件：${expost.slice(0, 2).map((e) => e.title).join("；")}`,
      evidenceIds: expost.slice(0, 3).map((e) => e.id),
    };
  } else if (outcome === "loss") {
    errorType = "judgment";
    errorReason = { text: "亏损不能归到执行或突发事件上，更可能是买入时的判断有问题（具体哪条假设不成立由复盘叙述说明）", evidenceIds: buys.map((t) => `trade:${t.id}`) };
  } else {
    errorType = "none";
    errorReason = {
      text: process === "poor" ? "这次赚钱了，但过程有明显问题：结果好不代表方法对" : "结果盈利，过程没有明显问题",
      evidenceIds: points.flatMap((p) => p.evidenceIds).slice(0, 6),
    };
  }

  return { process, outcome, quadrant, processPoints: points, errorType, errorReason, expostEvents: expost.slice(0, 5).map((e) => e.id) };
}
