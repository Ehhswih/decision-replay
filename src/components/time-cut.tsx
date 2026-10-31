import { cn } from "@/lib/utils";

/** 产品标志：左半边是"当时"（实心靛蓝），右半边是"事后"（琥珀斜纹幕布），中间是决策时刻 */
export function TimeCut({ className }: { className?: string }) {
  return (
    <span aria-hidden className={cn("relative inline-flex shrink-0 overflow-hidden rounded-[5px] ring-1 ring-border", className)}>
      <span className="w-1/2 bg-exante" />
      <span className="w-1/2 bg-expost/15 hatch" />
      <span className="absolute inset-y-0 left-1/2 w-px -translate-x-1/2 bg-card" />
    </span>
  );
}
