"use client";

import { useEffect, useRef, useState } from "react";
import * as echarts from "echarts/core";
import { CandlestickChart, ScatterChart } from "echarts/charts";
import { GridComponent, TooltipComponent, MarkLineComponent, DataZoomComponent } from "echarts/components";
import { CanvasRenderer } from "echarts/renderers";
import type { Bar } from "@/lib/domain/types";

echarts.use([CandlestickChart, ScatterChart, GridComponent, TooltipComponent, MarkLineComponent, DataZoomComponent, CanvasRenderer]);

const UP = "#d9363e";
const DOWN = "#16915a";
const INK = "#1d2430";
const MUTED = "#5f6878";
const GRID = { left: 56, right: 16, top: 28, bottom: 52 };

export interface ChartTrade {
  id: string;
  date: string;
  side: "buy" | "sell";
  price: number;
  qty: number;
  label: string;
}

export interface ChartEvent {
  id: string;
  date: string;
  title: string;
  kindLabel: string;
  tone?: "positive" | "negative" | "neutral";
}

export function KlineChart({
  raw,
  adj,
  trades,
  events,
  decisionDate,
  curtain,
  onEventClick,
}: {
  raw: Bar[];
  adj: Bar[];
  trades: ChartTrade[];
  events: ChartEvent[];
  decisionDate: string;
  curtain: boolean;
  onEventClick?: (id: string) => void;
}) {
  const box = useRef<HTMLDivElement>(null);
  const chart = useRef<echarts.ECharts | null>(null);
  const [cover, setCover] = useState<{ left: number; width: number } | null>(null);

  useEffect(() => {
    if (!box.current) return;
    chart.current = echarts.init(box.current);
    const ro = new ResizeObserver(() => chart.current?.resize());
    ro.observe(box.current);
    return () => {
      ro.disconnect();
      chart.current?.dispose();
    };
  }, []);

  useEffect(() => {
    const c = chart.current;
    if (!c || !adj.length) return;
    const dates = adj.map((b) => b.date);
    const factor = new Map(adj.map((b) => [b.date, raw.find((r) => r.date === b.date)?.close ? b.close / (raw.find((r) => r.date === b.date) as Bar).close : 1]));
    const highOf = new Map(adj.map((b) => [b.date, b.high]));
    const lowOf = new Map(adj.map((b) => [b.date, b.low]));
    const top = Math.max(...adj.map((b) => b.high));

    // 同一天多个事件往上错开
    const stack = new Map<string, number>();
    const eventPoints = events
      .filter((e) => dates.includes(e.date))
      .map((e) => {
        const n = stack.get(e.date) ?? 0;
        stack.set(e.date, n + 1);
        return { value: [e.date, (highOf.get(e.date) as number) * (1.035 + n * 0.03)], id: e.id, title: e.title, kindLabel: e.kindLabel, tone: e.tone };
      });

    c.setOption(
      {
        animation: false,
        grid: GRID,
        tooltip: {
          trigger: "item",
          confine: true,
          backgroundColor: "#ffffff",
          borderColor: "#dcdfd8",
          textStyle: { color: INK, fontSize: 12 },
          extraCssText: "max-width:320px;white-space:normal;",
          formatter: (p: { seriesType: string; data: unknown; name: string }) => {
            if (p.seriesType === "candlestick") {
              const d = p.data as number[];
              const r = raw.find((b) => b.date === p.name);
              return `${p.name}<br/>开 ${d[1].toFixed(2)} 收 ${d[2].toFixed(2)}<br/>低 ${d[3].toFixed(2)} 高 ${d[4].toFixed(2)}<br/><span style="color:${MUTED}">前复权${r ? `；不复权收盘 ${r.close}` : ""}</span>`;
            }
            const d = p.data as { title: string; kindLabel?: string; value: [string, number] };
            return `${d.value[0]}${d.kindLabel ? ` · ${d.kindLabel}` : ""}<br/>${d.title}`;
          },
        },
        xAxis: {
          type: "category",
          data: dates,
          boundaryGap: true,
          axisLine: { lineStyle: { color: "#cfd3cb" } },
          axisLabel: { color: MUTED, fontSize: 11 },
        },
        yAxis: {
          scale: true,
          max: Math.ceil(top * (1.06 + Math.max(0, ...stack.values()) * 0.03)),
          splitLine: { lineStyle: { color: "#e9ebe6" } },
          axisLabel: { color: MUTED, fontSize: 11, showMaxLabel: false },
        },
        dataZoom: [{ type: "inside" }, { type: "slider", height: 18, bottom: 8, borderColor: "#dcdfd8", textStyle: { color: MUTED, fontSize: 10 } }],
        series: [
          {
            type: "candlestick",
            name: "K线",
            data: adj.map((b) => [b.open, b.close, b.low, b.high]),
            itemStyle: { color: UP, color0: DOWN, borderColor: UP, borderColor0: DOWN },
            markLine: {
              symbol: "none",
              silent: true,
              label: { formatter: "决策时刻", color: "#3b4fb8", fontSize: 11 },
              lineStyle: { color: "#3b4fb8", width: 1.5, type: "solid" },
              data: [{ xAxis: decisionDate }],
            },
          },
          {
            type: "scatter",
            name: "成交",
            symbol: "path://M0,10 L5,0 L10,10 Z",
            symbolSize: 12,
            z: 5,
            data: trades
              .filter((t) => dates.includes(t.date))
              .map((t) => ({
                value: [t.date, t.side === "buy" ? (lowOf.get(t.date) as number) * 0.975 : (highOf.get(t.date) as number) * 1.0],
                title: t.label,
                kindLabel: t.side === "buy" ? "买入" : "卖出",
                symbolRotate: t.side === "buy" ? 0 : 180,
                itemStyle: { color: t.side === "buy" ? UP : DOWN },
                label: { show: true, formatter: t.side === "buy" ? "买" : "卖", position: t.side === "buy" ? "bottom" : "top", color: t.side === "buy" ? UP : DOWN, fontSize: 11 },
                _adjPrice: t.price * (factor.get(t.date) ?? 1),
              })),
          },
          {
            type: "scatter",
            name: "事件",
            symbol: "circle",
            symbolSize: 9,
            z: 4,
            data: eventPoints.map((p) => ({
              ...p,
              itemStyle: { color: p.tone === "negative" ? DOWN : p.tone === "positive" ? UP : "#8a8f98", borderColor: "#fff", borderWidth: 1 },
            })),
          },
        ],
      },
      true,
    );

    c.off("click");
    c.on("click", (p) => {
      const d = p.data as { id?: string } | undefined;
      if (p.seriesName === "事件" && d?.id) onEventClick?.(d.id);
    });

    const place = () => {
      const idx = dates.findIndex((d) => d > decisionDate);
      if (!curtain || idx === -1) return setCover(null);
      const x = c.convertToPixel({ xAxisIndex: 0 }, idx) as number;
      const prev = c.convertToPixel({ xAxisIndex: 0 }, Math.max(0, idx - 1)) as number;
      const left = (x + prev) / 2;
      const right = c.getWidth() - GRID.right;
      setCover(left < right ? { left, width: right - left } : null);
    };
    place();
    c.off("datazoom");
    c.on("datazoom", place);
    c.off("finished");
    c.on("finished", place);
  }, [raw, adj, trades, events, decisionDate, curtain, onEventClick]);

  return (
    <div className="relative">
      <div ref={box} className="w-full h-[340px] sm:h-[400px]" role="img" aria-label={`K 线图，决策日 ${decisionDate}`} />
      {cover && (
        <div
          className="absolute curtain border-l-2 border-exante flex items-center justify-center pointer-events-none"
          style={{ left: cover.left, width: cover.width, top: GRID.top, bottom: GRID.bottom }}
        >
          <span className="text-xs text-muted-foreground bg-card/90 px-2 py-1 rounded border border-border">决策之后的行情和事件已遮住</span>
        </div>
      )}
    </div>
  );
}
