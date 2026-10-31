import { cn } from "@/lib/utils";
import { TIMING_TEXT, type TimingKey } from "@/lib/labels";

const STYLE: Record<TimingKey, string> = {
  ex_ante: "text-exante bg-exante/10 ring-exante/25",
  ex_post: "text-expost bg-expost/12 ring-expost/30",
  uncertain: "text-uncertain bg-transparent",
};

const BASE = "inline-flex items-center gap-1 rounded-md px-1.5 py-px text-[11px] leading-4 whitespace-nowrap ring-1 ring-inset";

export function TimingBadge({ timing, className }: { timing: TimingKey; className?: string }) {
  return (
    <span className={cn(BASE, STYLE[timing], timing === "uncertain" && "outline-1 outline-dashed outline-uncertain/60 ring-0 -outline-offset-1", className)}>
      {TIMING_TEXT[timing]}
    </span>
  );
}

export function Tag({ children, tone = "neutral", className }: { children: React.ReactNode; tone?: "neutral" | "warn" | "danger" | "ok" | "info"; className?: string }) {
  const t = {
    neutral: "text-muted-foreground bg-muted ring-transparent",
    warn: "text-expost bg-expost/10 ring-expost/25",
    danger: "text-destructive bg-destructive/8 ring-destructive/25",
    ok: "text-down bg-down/10 ring-down/25",
    info: "text-exante bg-exante/10 ring-exante/25",
  }[tone];
  return <span className={cn(BASE, t, className)}>{children}</span>;
}
