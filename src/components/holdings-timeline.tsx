"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import { ERROR_TYPE_TEXT, fmtDate, pct, quadrantText } from "@/lib/labels";
import { cn } from "@/lib/utils";
import type { Attribution } from "@/lib/domain/attribution";
import type { Episode } from "@/lib/domain/types";

type Row = { episode: Episode; attribution: Attribution; holdDays: number | null };

const DAY = 86_400_000;

/**
 * 持仓时间轴：每个持仓段一条，放在同一条时间轴上，能看出哪些持仓重叠、哪段拿得久。
 * 颜色按 A 股习惯红盈绿亏；红绿在色盲下区分度不够，所以每条都直接标上带正负号的收益。
 */
export function HoldingsTimeline({ rows, hrefOf }: { rows: Row[]; hrefOf: (r: Row) => string }) {
  const [hover, setHover] = useState<string | null>(null);
  const [now] = useState(() => Date.now());
  const { start, end, months, sorted } = useMemo(() => {
    const sorted = [...rows].sort((a, b) => a.episode.openTs - b.episode.openTs);
    const start = Math.min(...rows.map((r) => r.episode.openTs));
    const end = Math.max(...rows.map((r) => r.episode.closeTs ?? now));
    // 月份刻度：每月 1 日；起点所在的月份标在最左边
    const d = new Date(start);
    const months: { ts: number; label: string; edge?: boolean }[] = [{ ts: start - DAY, label: `${d.getMonth() + 1} 月`, edge: true }];
    d.setDate(1);
    d.setHours(0, 0, 0, 0);
    for (d.setMonth(d.getMonth() + 1); d.getTime() < end; d.setMonth(d.getMonth() + 1)) {
      months.push({ ts: d.getTime(), label: `${d.getMonth() + 1} 月` });
    }
    return { start: start - DAY, end: end + DAY, months, sorted };
  }, [rows, now]);

  if (!rows.length) return null;
  const x = (ts: number) => ((ts - start) / (end - start)) * 100;
  const span = `${fmtDate(start + DAY)} 至 ${fmtDate(end - DAY)}`;

  return (
    <section className="panel p-4 sm:p-5" aria-label="持仓时间轴">
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 mb-4">
        <h2 className="text-[15px] font-semibold tracking-tight">持仓时间轴</h2>
        <div className="flex items-center gap-3 text-xs text-muted-foreground">
          <span className="inline-flex items-center gap-1.5">
            <span className="w-3 h-2 rounded-sm bg-up" />
            盈利
          </span>
          <span className="inline-flex items-center gap-1.5">
            <span className="w-3 h-2 rounded-sm bg-down" />
            亏损
          </span>
          <span className="inline-flex items-center gap-1.5">
            <span className="size-2 rounded-full bg-card ring-2 ring-foreground/60" />
            成交
          </span>
          <span className="num hidden sm:inline">{span}</span>
        </div>
      </div>

      <div className="max-h-[440px] overflow-y-auto -mx-1 px-1">
        <div className="relative">
          {/* 月份网格线 */}
          <div aria-hidden className="absolute inset-y-0 left-[5.25rem] sm:left-[8.25rem] right-[3.75rem] sm:right-16">
            {months
              .filter((m) => !m.edge)
              .map((m) => (
                <div key={m.ts} className="absolute inset-y-0 border-l border-dashed border-border" style={{ left: `${x(m.ts)}%` }} />
              ))}
          </div>
          <ul className="relative space-y-1">
            {sorted.map((r) => {
              const e = r.episode;
              const open = e.closeTs == null;
              const left = x(e.openTs);
              const width = Math.max(x(e.closeTs ?? now) - left, 0.8);
              const gain = (e.returnPct ?? 0) > 0;
              const on = hover === e.id;
              return (
                <li key={e.id}>
                  <Link
                    href={hrefOf(r)}
                    onMouseEnter={() => setHover(e.id)}
                    onMouseLeave={() => setHover(null)}
                    onFocus={() => setHover(e.id)}
                    onBlur={() => setHover(null)}
                    className={cn("group grid grid-cols-[4.5rem_1fr_3rem] sm:grid-cols-[7.5rem_1fr_3.25rem] items-center gap-2 rounded-md px-1 py-1 focus-visible:outline-2 focus-visible:outline-ring", on && "bg-muted")}
                    aria-label={`${e.name ?? e.code}，${fmtDate(e.openTs)} 至 ${open ? "持有中" : fmtDate(e.closeTs)}，收益 ${pct(e.returnPct)}，${ERROR_TYPE_TEXT[r.attribution.errorType]}`}
                  >
                    <span className="text-[13px] truncate">
                      {e.name ?? e.code}
                      <span className="text-[11px] text-muted-foreground num ml-1 hidden sm:inline">{e.code.slice(0, 6)}</span>
                    </span>
                    <span className="relative h-5">
                      <span
                        className={cn(
                          "absolute top-1/2 -translate-y-1/2 h-2.5 rounded-[4px] transition-[height] duration-150",
                          open ? "bg-muted-foreground/30 hatch" : gain ? "bg-up/85" : "bg-down/85",
                          on && "h-3.5",
                        )}
                        style={{ left: `${left}%`, width: `${width}%` }}
                      />
                      {e.trades.map((t) => (
                        <span
                          key={t.id}
                          aria-hidden
                          className="absolute top-1/2 -translate-y-1/2 -translate-x-1/2 size-[7px] rounded-full bg-card ring-2 ring-foreground/55"
                          style={{ left: `${x(t.ts)}%` }}
                        />
                      ))}
                      {on && (
                        <span
                          role="tooltip"
                          className="absolute z-10 bottom-full mb-1.5 w-max max-w-[260px] rounded-lg bg-popover text-popover-foreground ring-1 ring-border shadow-lg px-3 py-2 text-xs leading-5 pointer-events-none"
                          style={{ left: `min(${left}%, calc(100% - 260px))` }}
                        >
                          <span className="block font-medium text-[13px]">{e.name ?? e.code}</span>
                          <span className="block num text-muted-foreground">
                            {fmtDate(e.openTs)} 至 {open ? "持有中" : fmtDate(e.closeTs)}
                            {r.holdDays != null && `，${r.holdDays} 个交易日`}
                          </span>
                          <span className="block">
                            收益 <span className="num font-medium">{pct(e.returnPct)}</span>，{e.trades.length} 笔成交
                          </span>
                          <span className="block text-muted-foreground">{quadrantText(r.attribution.quadrant)}，{ERROR_TYPE_TEXT[r.attribution.errorType]}</span>
                        </span>
                      )}
                    </span>
                    <span className="num text-xs text-right text-muted-foreground group-hover:text-foreground">{open ? "持有中" : pct(e.returnPct, 1)}</span>
                  </Link>
                </li>
              );
            })}
          </ul>
          <div aria-hidden className="relative ml-[5.25rem] sm:ml-[8.25rem] mr-[3.75rem] sm:mr-16 h-5 mt-1">
            {months.map((m) => (
              <span key={m.ts} className={cn("absolute text-[11px] text-muted-foreground", !m.edge && "-translate-x-1/2")} style={{ left: `${x(m.ts)}%` }}>
                {m.label}
              </span>
            ))}
          </div>
        </div>
      </div>
    </section>
  );
}
