"use client";

import { Tag, TimingBadge } from "@/components/timing-badge";
import { CLAIM_TYPE_TEXT, CONFIDENCE_TEXT, KIND_LABEL, fmtDate, timingOf } from "@/lib/labels";
import type { Evidence } from "@/lib/domain/evidence";
import type { Claim } from "@/lib/ai/validate";

export function EvidenceChips({ ids, evidence, decisionTs, onOpen }: { ids: string[]; evidence: Map<string, Evidence>; decisionTs: number; onOpen: (e: Evidence) => void }) {
  const list = ids.map((id) => evidence.get(id)).filter((e): e is Evidence => !!e);
  if (!list.length) return null;
  return (
    <span className="inline-flex flex-wrap gap-1 align-middle">
      {list.map((e) => {
        const t = timingOf(e, decisionTs);
        return (
          <button
            key={e.id}
            type="button"
            onClick={() => onOpen(e)}
            title={e.title}
            className={`num text-[11px] leading-4 px-1.5 py-px rounded-md transition-colors focus-visible:outline-2 focus-visible:outline-ring ${
              t === "ex_ante"
                ? "text-exante bg-exante/8 hover:bg-exante/16"
                : t === "ex_post"
                  ? "text-expost bg-expost/10 hover:bg-expost/18"
                  : "text-uncertain outline-1 outline-dashed outline-uncertain/60 -outline-offset-1 hover:bg-muted"
            }`}
          >
            {KIND_LABEL[e.kind] ?? e.kind}
            {e.availableAt ? ` ${fmtDate(e.availableAt).slice(5)}` : ""}
          </button>
        );
      })}
    </span>
  );
}

const TYPE_TONE = { fact: "neutral", inference: "info", uncertain: "warn" } as const;

export function ClaimList({
  claims,
  evidence,
  decisionTs,
  onOpen,
  showType = true,
  empty = "没有通过校验的结论",
}: {
  claims: Claim[];
  evidence: Map<string, Evidence>;
  decisionTs: number;
  onOpen: (e: Evidence) => void;
  showType?: boolean;
  empty?: string;
}) {
  if (!claims.length) return <p className="text-sm text-muted-foreground">{empty}</p>;
  return (
    <ul className="space-y-2.5">
      {claims.map((c, i) => (
        <li key={i} className="text-sm leading-relaxed">
          {showType && (
            <span className="mr-1.5 inline-flex gap-1 align-middle">
              <Tag tone={TYPE_TONE[c.type]}>{CLAIM_TYPE_TEXT[c.type]}</Tag>
              {c.type !== "fact" && <Tag>{CONFIDENCE_TEXT[c.confidence]}</Tag>}
            </span>
          )}
          <span className="mr-1.5">{c.text}</span>
          <EvidenceChips ids={c.evidenceIds} evidence={evidence} decisionTs={decisionTs} onOpen={onOpen} />
        </li>
      ))}
    </ul>
  );
}

export function Section({ title, aside, children, className }: { title: string; aside?: React.ReactNode; children: React.ReactNode; className?: string }) {
  return (
    <section className={`panel p-4 sm:p-5 ${className ?? ""}`}>
      <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1 mb-3.5">
        <h2 className="text-[15px] font-semibold tracking-tight">{title}</h2>
        {aside}
      </div>
      {children}
    </section>
  );
}

export { TimingBadge };
