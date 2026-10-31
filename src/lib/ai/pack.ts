// 给模型的证据包。当时视角只放决策时可知的证据，并做匿名化（股票名、代码换成"标的A"，
// 日期换成相对决策日的 D-n），不让模型凭训练数据里的记忆知道后来发生了什么。

import { DAY_MS, atShTime, shDate } from "@/lib/time";
import { classify, TIMING_LABEL } from "@/lib/domain/pit";
import type { Evidence } from "@/lib/domain/evidence";
import type { Episode, EpisodeTrade } from "@/lib/domain/types";

export interface PackItem {
  id: string;
  kind: string;
  time: string;
  timing?: string;
  title: string;
  detail?: string;
  value?: number | null;
  unit?: string;
  caliber?: string;
  thirdPartyAi?: boolean;
}

const GENERIC = new Set(["中国", "东方", "时代", "科技", "股份", "集团", "国际", "华夏", "中信", "招商", "平安", "长江"]);

export interface Anonymizer {
  text: (s: string) => string;
  /** 把模型输出里的"标的A"换回真实名称，方便用户阅读 */
  restore: (s: string) => string;
}

export function makeAnonymizer(name: string | null, code: string, decisionDate: string): Anonymizer {
  const ticker = code.slice(0, 6);
  const names = [name, name && name.length >= 4 && !GENERIC.has(name.slice(0, 2)) ? name.slice(0, 2) : null].filter((x): x is string => !!x);
  const year = decisionDate.slice(0, 4);
  const rel = (date: string) => {
    const diff = Math.round((atShTime(date) - atShTime(decisionDate)) / DAY_MS);
    return diff === 0 ? "D" : diff > 0 ? `D+${diff}` : `D${diff}`;
  };
  const pad = (n: string) => n.padStart(2, "0");
  return {
    text: (s: string) => {
      let out = s;
      for (const n of names) out = out.split(n).join("标的A");
      out = out.replace(new RegExp(`${ticker}(\\.(SH|SZ|BJ))?`, "g"), "标的A");
      out = out.replace(/(20\d{2})-(\d{2})-(\d{2})/g, (_, y, m, d) => rel(`${y}-${m}-${d}`));
      out = out.replace(/(20\d{2})年(\d{1,2})月(\d{1,2})日/g, (_, y, m, d) => rel(`${y}-${pad(m)}-${pad(d)}`));
      out = out.replace(/(?<!\d)(\d{1,2})月(\d{1,2})日/g, (_, m, d) => rel(`${year}-${pad(m)}-${pad(d)}`));
      return out;
    },
    restore: (s: string) => (name ? s.split("标的A").join(name) : s),
  };
}

function item(e: Evidence, time: string, anon?: Anonymizer, timing?: string): PackItem {
  const f = (s?: string) => (s == null ? undefined : anon ? anon.text(s) : s);
  return {
    id: e.id,
    kind: e.kind,
    time,
    timing,
    title: f(e.title) as string,
    // 程序算出的指标说明里有拆解数字，不截断；新闻、公告等长文本截到 220 字
    detail: f(e.kind === "computed" ? e.detail : e.detail?.slice(0, 220)),
    value: e.value,
    unit: e.unit,
    caliber: e.caliber,
    thirdPartyAi: e.thirdPartyAi || undefined,
  };
}

const KIND_ORDER: Record<string, number> = { trade: 0, computed: 1, financial: 2, notice: 3, anomaly: 4, hot_rank: 5, dragon_tiger: 6, corporate_action: 7, news: 8, industry: 9 };

function pick(list: Evidence[], kinds: string[], n: number, recentFirst = true) {
  const l = list.filter((e) => kinds.includes(e.kind));
  l.sort((a, b) => (recentFirst ? (b.availableAt ?? 0) - (a.availableAt ?? 0) : (a.availableAt ?? 0) - (b.availableAt ?? 0)));
  return l.slice(0, n);
}

/** 当时视角：某笔买入决策时可知的证据 */
export function exAntePack(ep: Episode, items: Evidence[], decision: EpisodeTrade, anonymize = true) {
  const date = shDate(decision.ts);
  const anon = anonymize ? makeAnonymizer(ep.name, ep.code, date) : undefined;
  const known = items.filter((e) => e.id !== `trade:${decision.id}` && classify(e, decision.ts) === "ex_ante");
  const recent = (e: Evidence) => e.availableAt != null && e.availableAt >= decision.ts - 20 * DAY_MS;
  const chosen = [
    ...items.filter((e) => e.id === `trade:${decision.id}`),
    ...known.filter((e) => e.kind === "trade"),
    ...known.filter((e) => e.kind === "computed" && e.tradeId === decision.id),
    ...known.filter((e) => (e.kind === "hot_rank" || e.kind === "dragon_tiger") && e.tradeId === decision.id),
    ...pick(known, ["financial"], 3),
    ...pick(known.filter(recent), ["notice"], 6),
    ...pick(known.filter(recent), ["anomaly"], 8),
    ...pick(known.filter((e) => recent(e) && e.important), ["news"], 15),
    ...known.filter((e) => e.kind === "industry"),
  ];
  const timeOf = (e: Evidence) => (e.availableAt == null ? "时间未知" : anon ? anon.text(shDate(e.availableAt)) : shDate(e.availableAt));
  const pack = dedupe(chosen).map((e) => item(e, timeOf(e), anon));
  return { pack, anon, decisionTime: anon ? "D" : date };
}

/** 事后复盘：整个持仓段，带每条证据相对首次买入的时点标签 */
export function expostPack(ep: Episode, items: Evidence[]) {
  const first = ep.trades[0];
  const chosen = [
    ...items.filter((e) => e.kind === "trade" || e.kind === "computed" || e.kind === "corporate_action" || e.kind === "hot_rank" || e.kind === "dragon_tiger" || e.kind === "industry"),
    ...pick(items, ["financial"], 4),
    ...pick(items, ["notice"], 10, false),
    ...pick(items, ["anomaly"], 14, false),
    ...pick(items.filter((e) => e.important), ["news"], 20, false),
  ];
  return dedupe(chosen)
    .sort((a, b) => (KIND_ORDER[a.kind] ?? 9) - (KIND_ORDER[b.kind] ?? 9) || (a.availableAt ?? 0) - (b.availableAt ?? 0))
    .map((e) => item(e, e.availableAt == null ? "时间未知" : shDate(e.availableAt), undefined, TIMING_LABEL[classify(e, first.ts)]));
}

function dedupe(l: Evidence[]) {
  const seen = new Set<string>();
  return l.filter((e) => (seen.has(e.id) ? false : (seen.add(e.id), true)));
}

/** 证据在包里的可读文本，用来核对模型输出里的数字 */
export function packText(p: PackItem): string {
  return `${p.time} ${p.title} ${p.detail ?? ""} ${p.value ?? ""}`;
}
