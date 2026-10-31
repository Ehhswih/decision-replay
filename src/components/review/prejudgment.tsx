"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Tag } from "@/components/timing-badge";
import { Section } from "./claims";
import { ERROR_TYPE_TEXT, fmtDateTime, quadrantText } from "@/lib/labels";
import { cn } from "@/lib/utils";
import type { Evidence } from "@/lib/domain/evidence";
import type { BiasResult } from "@/lib/domain/biases";
import type { Attribution } from "@/lib/domain/attribution";
import type { ExAnteView } from "@/lib/ai/review";
import type { EpisodeTrade } from "@/lib/domain/types";
import type { DecisionNote, Prejudgment, Verdict } from "@/lib/records";

export const VERDICT_TEXT: Record<Verdict, string> = { sufficient: "理由充分", gaps: "理由有缺口", insufficient: "理由不充分" };
const VERDICT_TONE = { sufficient: "ok", gaps: "warn", insufficient: "danger" } as const;

/** 回到当时：揭晓之前先写下自己对这笔决策的判断 */
export function PrejudgmentForm({
  trade,
  existing,
  revealedBefore,
  onSubmit,
  onSkip,
}: {
  trade: EpisodeTrade;
  existing: Prejudgment | undefined;
  /** 这个持仓段已经打开过揭晓视图 */
  revealedBefore: boolean;
  onSubmit: (verdict: Verdict, worry: string) => Promise<void>;
  onSkip: () => void;
}) {
  const [verdict, setVerdict] = useState<Verdict | null>(null);
  const [worry, setWorry] = useState("");
  const [busy, setBusy] = useState(false);

  if (existing) {
    return (
      <Section title="你在揭晓前的判断" aside={<span className="text-xs text-muted-foreground num">{fmtDateTime(existing.createdAt)} 写下，不能修改</span>}>
        <div className="text-sm space-y-1.5">
          <p className="flex flex-wrap items-center gap-2">
            <Tag tone={VERDICT_TONE[existing.verdict]}>{VERDICT_TEXT[existing.verdict]}</Tag>
            {existing.afterReveal && <Tag tone="neutral">揭晓后才写</Tag>}
          </p>
          <p>
            <span className="text-muted-foreground mr-2">最该担心的</span>
            {existing.worry ?? <span className="text-muted-foreground">没有写</span>}
          </p>
        </div>
        <Button size="sm" className="mt-3" onClick={onSkip}>
          揭晓结果，前后对照
        </Button>
      </Section>
    );
  }

  const submit = async () => {
    if (!verdict) return;
    setBusy(true);
    try {
      await onSubmit(verdict, worry);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Section title="揭晓之前，先写下你的判断">
      <p className="text-sm text-muted-foreground leading-relaxed mb-3">
        看完上面当时能看到的信息，你觉得这笔{trade.side === "sell" ? "卖出" : "买入"}的理由站得住吗？写下之后不能修改，揭晓后会和规则、AI 的结论并排对照。
        {revealedBefore && <span className="text-expost"> 你已经看过这个持仓段的揭晓结果，现在写下的判断会标注为「揭晓后才写」。</span>}
      </p>
      <div className="flex flex-wrap gap-2 mb-3" role="radiogroup" aria-label="理由是否充分">
        {(Object.keys(VERDICT_TEXT) as Verdict[]).map((v) => (
          <button
            key={v}
            type="button"
            role="radio"
            aria-checked={verdict === v}
            onClick={() => setVerdict(v)}
            className={cn("px-3 py-1.5 rounded-md border text-sm", verdict === v ? "border-exante bg-exante/8 text-exante font-medium" : "border-border text-muted-foreground hover:bg-muted")}
          >
            {VERDICT_TEXT[v]}
          </button>
        ))}
      </div>
      <Label htmlFor={`worry-${trade.id}`} className="text-[13px]">
        当时最该担心什么（可选）
      </Label>
      <Textarea id={`worry-${trade.id}`} value={worry} onChange={(e) => setWorry(e.target.value)} maxLength={200} rows={2} className="mt-1.5" placeholder="比如：涨得太急、风险提示公告、没有写止损" />
      <div className="flex flex-wrap gap-2 mt-3">
        <Button size="sm" onClick={submit} disabled={!verdict || busy}>
          {busy ? "保存中……" : "保存，然后揭晓"}
        </Button>
        <Button size="sm" variant="ghost" onClick={onSkip}>
          跳过，直接揭晓
        </Button>
      </div>
    </Section>
  );
}

/** 揭晓后：自己事前的判断和规则、AI 的结论并排 */
export function BeforeAfter({
  pj,
  trade,
  biases,
  attribution,
  view,
  evidence,
}: {
  pj: Prejudgment;
  trade: EpisodeTrade;
  biases: BiasResult[];
  attribution: Attribution;
  view: ExAnteView | undefined;
  evidence: Map<string, Evidence>;
}) {
  const hits = biases.filter((b) => b.outcome === "hit" && b.tradeId === trade.id);
  const contradicted = view?.reasonCheck.filter((r) => r.status === "contradicted").length ?? 0;
  const unverifiable = view?.reasonCheck.filter((r) => r.status === "unverifiable").length ?? 0;
  // 同一条公告可能同时来自扶摇和 iFinD，按标题去重
  const later = [...new Set(attribution.expostEvents.map((id) => evidence.get(id)?.title).filter((x): x is string => !!x))].slice(0, 3);
  // 只摆事实对照，不给判断打分
  const hint =
    pj.verdict === "sufficient" && (hits.length > 0 || contradicted > 0)
      ? `你判断理由充分，规则在这笔决策上命中了 ${hits.length} 条${contradicted ? `，AI 核对出 ${contradicted} 处和当时证据矛盾` : ""}`
      : pj.verdict !== "sufficient" && hits.length === 0 && contradicted === 0
        ? "你认为理由有问题，但规则和 AI 都没在这笔决策上发现问题：缺口可能在规则覆盖不到的地方，值得记下来"
        : null;

  return (
    <Section title="揭晓前后对照" aside={<span className="text-xs text-muted-foreground num">{fmtDateTime(trade.ts)} 这笔{trade.side === "sell" ? "卖出" : "买入"}</span>}>
      <div className="grid md:grid-cols-2 gap-4 text-sm">
        <div className="rounded-md border border-exante/40 p-3 space-y-1.5">
          <h3 className="text-[13px] font-medium text-exante">揭晓前（你）</h3>
          <p className="flex flex-wrap gap-1.5">
            <Tag tone={VERDICT_TONE[pj.verdict]}>{VERDICT_TEXT[pj.verdict]}</Tag>
            {pj.afterReveal && <Tag tone="neutral">揭晓后才写</Tag>}
          </p>
          <p>
            <span className="text-muted-foreground mr-2">最该担心的</span>
            {pj.worry ?? <span className="text-muted-foreground">没有写</span>}
          </p>
        </div>
        <div className="rounded-md border border-expost/40 p-3 space-y-1.5">
          <h3 className="text-[13px] font-medium text-expost">揭晓后（规则和 AI）</h3>
          <p>
            <span className="text-muted-foreground mr-2">整段</span>
            {quadrantText(attribution.quadrant)}，{ERROR_TYPE_TEXT[attribution.errorType]}
          </p>
          <p>
            <span className="text-muted-foreground mr-2">这笔命中的规则</span>
            {hits.length ? hits.map((h) => h.name).join("、") : "没有"}
          </p>
          {view && (
            <p>
              <span className="text-muted-foreground mr-2">AI 核对理由</span>
              {contradicted || unverifiable ? `${contradicted} 处和证据矛盾，${unverifiable} 处无法核实` : "没有发现矛盾"}
              {view.warnings.length > 0 && `；当时已有 ${view.warnings.length} 条风险信号`}
            </p>
          )}
          <p>
            <span className="text-muted-foreground mr-2">后来出现的负面事件</span>
            {later.length ? later.join("；") : "没有"}
          </p>
        </div>
      </div>
      {hint && <p className="text-sm mt-3 leading-relaxed">{hint}</p>}
    </Section>
  );
}

/** 决策前检查存下的记录里，和这笔成交对得上的（同一只股票、同方向、成交前 7 天内保存） */
export function matchNotes(notes: DecisionNote[], trade: EpisodeTrade): DecisionNote[] {
  return notes.filter((n) => n.code === trade.code && n.side === trade.side && n.versions[0].createdAt <= trade.ts && n.versions[0].createdAt >= trade.ts - 7 * 86_400_000);
}

/** 成交前保存的决策记录：成交之前写的版本算当时的理由，之后补充的版本是事后写的 */
export function LinkedNotes({ notes, trade, revealed }: { notes: DecisionNote[]; trade: EpisodeTrade; revealed: boolean }) {
  if (!notes.length) return null;
  return (
    <Section title="下单前保存的决策记录" aside={<span className="text-xs text-muted-foreground">来自「决策前检查」</span>}>
      <ul className="space-y-3 text-sm">
        {notes.map((n) => {
          const before = n.versions.filter((v) => v.createdAt <= trade.ts);
          const after = n.versions.filter((v) => v.createdAt > trade.ts);
          return (
            <li key={n.rootId} className="space-y-1.5">
              {(revealed ? n.versions : before).map((v) => (
                <div key={v.id} className={cn("border-l-2 pl-3", v.createdAt <= trade.ts ? "border-exante" : "border-expost")}>
                  <p className="text-xs text-muted-foreground num">
                    第 {v.version} 版，{fmtDateTime(v.createdAt)}，{v.createdAt <= trade.ts ? "成交前写的" : "成交后补充，不算当时的理由"}
                  </p>
                  <p className="leading-relaxed">{v.reason}</p>
                  {(v.planStop != null || v.planTarget != null) && (
                    <p className="text-muted-foreground">{[v.planStop != null ? `止损 ${v.planStop}%` : "", v.planTarget != null ? `目标 +${v.planTarget}%` : ""].filter(Boolean).join("，")}</p>
                  )}
                </div>
              ))}
              {v1Checks(n)}
              {!revealed && after.length > 0 && <p className="text-xs text-muted-foreground">成交后还补充过 {after.length} 次，揭晓后可以看到。</p>}
            </li>
          );
        })}
      </ul>
    </Section>
  );
}

function v1Checks(n: DecisionNote) {
  const triggered = n.snapshot?.checks.filter((c) => c.status === "triggered") ?? [];
  if (!n.snapshot) return null;
  return (
    <p className="text-xs text-muted-foreground">
      保存时的检查（行情截至 {n.snapshot.asOf ?? "未知"}）：{triggered.length ? `触发 ${triggered.length} 条：${triggered.map((c) => c.text).join("；")}` : "没有触发的检查"}
    </p>
  );
}
