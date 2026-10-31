import { cn } from "@/lib/utils";
import { TIMING_TEXT, type TimingKey } from "@/lib/labels";

const STYLE: Record<TimingKey, string> = {
  ex_ante: "text-exante border-exante/40 bg-exante/8",
  ex_post: "text-expost border-expost/40 bg-expost/10",
  uncertain: "text-uncertain border-uncertain/60 border-dashed",
};

export function TimingBadge({ timing, className }: { timing: TimingKey; className?: string }) {
  return <span className={cn("inline-flex items-center rounded border px-1.5 py-px text-[11px] leading-4 whitespace-nowrap", STYLE[timing], className)}>{TIMING_TEXT[timing]}</span>;
}

export function Tag({ children, tone = "neutral", className }: { children: React.ReactNode; tone?: "neutral" | "warn" | "danger" | "ok" | "info"; className?: string }) {
  const t = {
    neutral: "text-muted-foreground border-border",
    warn: "text-expost border-expost/40",
    danger: "text-destructive border-destructive/40",
    ok: "text-down border-down/40",
    info: "text-exante border-exante/40",
  }[tone];
  return <span className={cn("inline-flex items-center rounded border px-1.5 py-px text-[11px] leading-4 whitespace-nowrap", t, className)}>{children}</span>;
}
