"use client";

import { useState } from "react";
import { cn } from "@/lib/utils";

// 首页演示：示例组合里兆易创新 2026-06-22 那笔买入。曲线是示意，下面列的事实来自真实复盘结果。
const PRE = "0,170 30,165 60,172 90,160 120,163 150,150 180,152 210,140 240,118 265,92 285,70 300,58";
const POST = "300,58 318,74 336,96 352,118 370,140 388,158 405,170 422,166 440,178 458,190 476,186 494,198 512,192 530,200 560,196";
const CUT = (300 / 560) * 100;

export function ReplayDemo() {
  const [revealed, setRevealed] = useState(false);
  return (
    <figure className="panel p-4 sm:p-5" aria-label="回到当时与揭晓结果的演示">
      <div className="flex flex-wrap items-center justify-between gap-3 mb-3">
        <figcaption className="text-sm">
          <span className="font-medium">兆易创新</span>
          <span className="text-muted-foreground num ml-2">2026-06-22 买入</span>
        </figcaption>
        <div className="inline-flex rounded-full bg-muted p-0.5 text-xs" role="group" aria-label="切换视角">
          <button
            type="button"
            aria-pressed={!revealed}
            onClick={() => setRevealed(false)}
            className={cn("px-3 py-1 rounded-full transition-colors", !revealed ? "bg-card text-exante font-medium shadow-sm" : "text-muted-foreground hover:text-foreground")}
          >
            回到当时
          </button>
          <button
            type="button"
            aria-pressed={revealed}
            onClick={() => setRevealed(true)}
            className={cn("px-3 py-1 rounded-full transition-colors", revealed ? "bg-card text-expost font-medium shadow-sm" : "text-muted-foreground hover:text-foreground")}
          >
            揭晓结果
          </button>
        </div>
      </div>

      <div className="relative rounded-lg overflow-hidden bg-background/60 ring-1 ring-border">
        <svg viewBox="0 0 560 230" className="block w-full h-auto" aria-hidden>
          <defs>
            <linearGradient id="pre-fill" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="var(--exante)" stopOpacity="0.18" />
              <stop offset="100%" stopColor="var(--exante)" stopOpacity="0" />
            </linearGradient>
          </defs>
          {[50, 95, 140, 185].map((y) => (
            <line key={y} x1="0" x2="560" y1={y} y2={y} stroke="var(--grid-line)" strokeWidth="1" />
          ))}
          <polygon points={`${PRE} 300,230 0,230`} fill="url(#pre-fill)" />
          <polyline points={PRE} fill="none" stroke="var(--foreground)" strokeWidth="2" strokeLinejoin="round" />
          <line x1="300" x2="560" y1="112" y2="112" stroke="var(--down)" strokeWidth="1" strokeDasharray="4 4" opacity="0.8" />
          <text x="548" y="106" textAnchor="end" fontSize="11" fill="var(--down)">
            止损线 −8%
          </text>
          <polyline points={POST} fill="none" stroke="var(--expost)" strokeWidth="2" strokeLinejoin="round" />
          <path d="M507,182 L517,182 L512,192 Z" fill="var(--down)" />
          <text x="512" y="176" textAnchor="middle" fontSize="11" fill="var(--down)">
            卖
          </text>
          <line x1="300" x2="300" y1="0" y2="230" stroke="var(--exante)" strokeWidth="2" />
          <path d="M295,72 L305,72 L300,62 Z" fill="var(--up)" />
          <text x="292" y="18" textAnchor="end" fontSize="11" fill="var(--exante)">
            下单时刻
          </text>
        </svg>
        <div
          className={cn(
            "absolute inset-y-0 right-0 curtain border-l-2 border-exante flex items-center justify-center transition-transform duration-700 ease-[cubic-bezier(.7,0,.2,1)]",
            revealed && "translate-x-full",
          )}
          style={{ left: `${CUT}%` }}
        >
          <span className="text-xs text-muted-foreground bg-card/90 px-2 py-1 rounded-md ring-1 ring-border">下单之后的走势先遮住</span>
        </div>
      </div>
      <p className="mt-1.5 text-[11px] text-muted-foreground">曲线是示意，下面的事实来自示例组合的真实复盘。</p>

      <div className="grid grid-cols-2 gap-3 mt-3 text-[13px] leading-relaxed">
        <div className="rounded-lg bg-exante/6 ring-1 ring-inset ring-exante/20 p-3">
          <div className="text-exante font-medium mb-1">下单前就能看到</div>
          <ul className="space-y-1">
            <li>买入前 5 个交易日已涨 42.6%</li>
            <li>公司刚发过股票交易异常波动公告</li>
          </ul>
        </div>
        <div className={cn("relative rounded-lg p-3 ring-1 ring-inset overflow-hidden", revealed ? "bg-expost/8 ring-expost/25" : "ring-border")}>
          <div className={cn("transition-opacity duration-500", revealed ? "opacity-100" : "opacity-0")} aria-hidden={!revealed}>
            <div className="text-expost font-medium mb-1">下单之后才发生</div>
            <ul className="space-y-1">
              <li>7 月 6 日收盘跌破止损线</li>
              <li>又拖了 10 个交易日才卖出，归为“没做好”</li>
            </ul>
          </div>
          {!revealed && <div className="absolute inset-0 curtain flex items-center justify-center text-xs text-muted-foreground">揭晓后显示</div>}
        </div>
      </div>
    </figure>
  );
}
