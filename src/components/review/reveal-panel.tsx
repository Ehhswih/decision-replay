"use client";

import { Button } from "@/components/ui/button";
import { Tag } from "@/components/timing-badge";
import { ClaimList, EvidenceChips, Section } from "./claims";
import { ERROR_TYPE_TEXT, OUTCOME_TEXT, TRIGGER_TEXT, fmtDateTime } from "@/lib/labels";
import type { Evidence } from "@/lib/domain/evidence";
import type { BiasResult } from "@/lib/domain/biases";
import type { Attribution } from "@/lib/domain/attribution";
import type { ReviewDoc } from "@/lib/ai/review";

const OUTCOME_ORDER = { hit: 0, undetermined: 1, not_hit: 2 } as const;

function Quadrant({ a }: { a: Attribution }) {
  const cell = (process: string, outcome: string, label: string) => {
    const on = (a.process === "good" ? "good" : a.process === "poor" ? "poor" : "mixed") === process && a.outcome === outcome;
    return (
      <div className={`rounded px-2 py-2 text-center text-xs border ${on ? "border-foreground bg-foreground text-background font-medium" : "border-border text-muted-foreground"}`}>{label}</div>
    );
  };
  if (a.outcome === "open") return <p className="text-sm">{a.quadrant}</p>;
  return (
    <div className="grid grid-cols-[3.5rem_1fr_1fr] gap-1.5 items-center text-xs">
      <span />
      <span className="text-center text-muted-foreground">结果好</span>
      <span className="text-center text-muted-foreground">结果差</span>
      <span className="text-muted-foreground">过程好</span>
      {cell("good", "gain", "该做的做到了")}
      {cell("good", "loss", "过程对，运气差")}
      <span className="text-muted-foreground">过程一般</span>
      {cell("mixed", "gain", "有瑕疵但赚了")}
      {cell("mixed", "loss", "有瑕疵且亏了")}
      <span className="text-muted-foreground">过程差</span>
      {cell("poor", "gain", "赚了不代表方法对")}
      {cell("poor", "loss", "过程和结果都差")}
    </div>
  );
}

export function RevealPanel({
  review,
  biases,
  attribution,
  evidence,
  decisionTs,
  onOpen,
  onAddLesson,
  addedLessons,
  aiState,
}: {
  review: ReviewDoc | null;
  biases: BiasResult[];
  attribution: Attribution;
  evidence: Map<string, Evidence>;
  decisionTs: number;
  onOpen: (e: Evidence) => void;
  onAddLesson: (l: ReviewDoc["lessons"][number]) => void;
  addedLessons: Set<string>;
  aiState: React.ReactNode;
}) {
  const notes = new Map((review?.expost?.biasNotes ?? []).map((n) => [n.ruleId, n]));
  const sorted = [...biases].sort((x, y) => OUTCOME_ORDER[x.outcome] - OUTCOME_ORDER[y.outcome]);
  const hits = sorted.filter((b) => b.outcome === "hit");
  const others = sorted.filter((b) => b.outcome !== "hit");

  return (
    <div className="space-y-4">
      <Section title="过程和结果">
        <div className="grid xl:grid-cols-[minmax(0,20rem)_1fr] gap-5 items-start">
          <Quadrant a={attribution} />
          <div className="text-sm space-y-2">
            <p>
              <span className="text-muted-foreground mr-2">问题归类</span>
              <span className="font-semibold">{ERROR_TYPE_TEXT[attribution.errorType]}</span>
            </p>
            <p className="leading-relaxed">
              {attribution.errorReason.text} <EvidenceChips ids={attribution.errorReason.evidenceIds} evidence={evidence} decisionTs={decisionTs} onOpen={onOpen} />
            </p>
            <ul className="text-muted-foreground space-y-1 pt-1">
              {attribution.processPoints.map((p, i) => (
                <li key={i}>· {p.text}</li>
              ))}
            </ul>
          </div>
        </div>
      </Section>

      {!review?.expost ? (
        <Section title="复盘叙述">{aiState}</Section>
      ) : (
        <>
          <Section title="复盘叙述" aside={<span className="text-xs text-muted-foreground">由 {review.model} 生成，已经过引用、数字和合规校验</span>}>
            <p className="text-sm leading-7">{review.expost.narrative}</p>
          </Section>
          <Section title="结果是怎么来的">
            <ClaimList claims={review.expost.facts} evidence={evidence} decisionTs={decisionTs} onOpen={onOpen} />
            {review.expost.failedAssumption && (
              <div className="mt-4 pt-3 border-t border-border text-sm">
                <span className="text-muted-foreground mr-2">没有成立的假设</span>
                {review.expost.failedAssumption.text} <EvidenceChips ids={review.expost.failedAssumption.evidenceIds} evidence={evidence} decisionTs={decisionTs} onOpen={onOpen} />
              </div>
            )}
          </Section>
        </>
      )}

      <Section title="行为偏差" aside={<span className="text-xs text-muted-foreground">规则判定：命中是事实，是不是偏差是推断</span>}>
        {hits.length === 0 && <p className="text-sm text-muted-foreground mb-3">这次没有命中任何偏差规则。</p>}
        <ul className="space-y-4">
          {hits.map((b, i) => (
            <li key={`${b.ruleId}-${i}`} className="text-sm">
              <div className="flex flex-wrap items-center gap-1.5 mb-1">
                <span className="font-medium">{b.name}</span>
                <Tag tone="danger">命中</Tag>
                {b.ruleId === "B8" && <Tag>AI 核对，{b.confidence === "mid" ? "置信度中" : "置信度低"}</Tag>}
                {b.tradeId && evidence.get(`trade:${b.tradeId}`) && <span className="text-xs text-muted-foreground num">{fmtDateTime(evidence.get(`trade:${b.tradeId}`)!.eventTime)}</span>}
              </div>
              <p className="leading-relaxed">
                {b.finding} <EvidenceChips ids={b.evidenceIds} evidence={evidence} decisionTs={decisionTs} onOpen={onOpen} />
              </p>
              {notes.get(b.ruleId)?.explanation && <p className="leading-relaxed mt-1">{notes.get(b.ruleId)!.explanation}</p>}
              <p className="text-muted-foreground mt-1">
                也可能是：{notes.get(b.ruleId)?.alternative || b.alternatives.join("；")}
              </p>
              {b.cost && (
                <p className="text-expost mt-1">
                  {b.cost.text} <EvidenceChips ids={b.cost.evidenceIds} evidence={evidence} decisionTs={decisionTs} onOpen={onOpen} />
                </p>
              )}
              <p className="text-xs text-muted-foreground mt-1">规则：{b.rule}</p>
            </li>
          ))}
        </ul>
        {others.length > 0 && (
          <details className="mt-4 text-sm">
            <summary className="cursor-pointer text-muted-foreground">未命中或无法判定的规则 {others.length} 条</summary>
            <ul className="mt-2 space-y-1.5">
              {others.map((b, i) => (
                <li key={`${b.ruleId}-o-${i}`} className="flex flex-wrap gap-1.5 items-baseline">
                  <span>{b.name}</span>
                  <Tag tone={b.outcome === "not_hit" ? "ok" : "neutral"}>{OUTCOME_TEXT[b.outcome]}</Tag>
                  <span className="text-muted-foreground">{b.finding}</span>
                </li>
              ))}
            </ul>
          </details>
        )}
      </Section>

      <Section title="影响结论的不确定因素">
        <ul className="space-y-1.5 text-sm">
          {(review?.expost?.uncertainties ?? []).map((u, i) => (
            <li key={`ai-${i}`} className="leading-relaxed">
              {u.text} <EvidenceChips ids={u.evidenceIds} evidence={evidence} decisionTs={decisionTs} onOpen={onOpen} />
            </li>
          ))}
          {(review?.dataUncertainties ?? []).map((u, i) => (
            <li key={`d-${i}`} className="leading-relaxed text-muted-foreground">
              {u.text} <EvidenceChips ids={u.evidenceIds} evidence={evidence} decisionTs={decisionTs} onOpen={onOpen} />
            </li>
          ))}
          {!review && <li className="text-muted-foreground">生成复盘后列出数据缺失、时序不确定等情况。</li>}
        </ul>
      </Section>

      <Section title="下次可以做什么" aside={<span className="text-xs text-muted-foreground">是检查动作，不是买卖建议</span>}>
        {review?.lessons.length ? (
          <ul className="space-y-3">
            {review.lessons.map((l) => (
              <li key={l.id} className="flex flex-col sm:flex-row sm:items-start gap-2 sm:gap-4 text-sm">
                <div className="flex-1 leading-relaxed">
                  <Tag className="mr-1.5">{TRIGGER_TEXT[l.trigger]}</Tag>
                  {l.text} <EvidenceChips ids={l.evidenceIds} evidence={evidence} decisionTs={decisionTs} onOpen={onOpen} />
                  {l.source === "rule" && <span className="text-xs text-muted-foreground ml-1">（规则模板）</span>}
                </div>
                <Button size="sm" variant={addedLessons.has(l.id) ? "secondary" : "default"} disabled={addedLessons.has(l.id)} onClick={() => onAddLesson(l)} className="shrink-0">
                  {addedLessons.has(l.id) ? "已加入清单" : "加入我的清单"}
                </Button>
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-sm text-muted-foreground">生成复盘后会在这里给出教训。</p>
        )}
      </Section>

      {review && (
        <details className="rounded-lg border border-border bg-card p-4 text-sm">
          <summary className="cursor-pointer">
            AI 输出校验：丢弃或修改了 {review.validationLog.length} 处
            <span className="text-muted-foreground ml-2 text-xs">
              {review.usage.calls} 次模型调用，用时 {(review.usage.latencyMs / 1000).toFixed(0)} 秒，生成于 {fmtDateTime(review.generatedAt)}
            </span>
          </summary>
          {review.fallbackReason && <p className="mt-2 text-expost">{review.fallbackReason}</p>}
          {review.exAnteErrors.map((e, i) => (
            <p key={i} className="mt-2 text-expost">
              {e}
            </p>
          ))}
          <ul className="mt-3 space-y-2">
            {review.validationLog.map((l, i) => (
              <li key={i} className="text-[13px]">
                <span className="text-muted-foreground">{l.stage}｜</span>
                <span className="text-destructive">{l.reason}</span>
                <div className="text-muted-foreground line-through decoration-muted-foreground/40">{l.text}</div>
              </li>
            ))}
            {!review.validationLog.length && <li className="text-muted-foreground">这次输出全部通过了校验。</li>}
          </ul>
        </details>
      )}
    </div>
  );
}
