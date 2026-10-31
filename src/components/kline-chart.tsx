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
  cutoffTs,
  onEventClick,
}: {
  raw: Bar[];
  adj: Bar[];
  trades: ChartTrade[];
  events: ChartEvent[];
  decisionDate: string;
  /** 回到当时：决策时刻。只画这一刻之前已经收盘的 K 线；为 null 时显示完整行情 */
  cutoffTs: number | null;
  onEventClick?: (id: string) => void;
}) {
  const box = useRef<HTMLDivElement>(null);
  const chart = useRef<echarts.ECharts | null>(null);
  const [cover, setCover] = useState<{ left: number; width: number } | null>(null);
  const then = cutoffTs != null;

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
    // 当时视角用不复权价格：前复权会用到决策之后的除权信息
    const bars = then ? raw : adj;
    const dates = bars.map((b) => b.date);
    // 第 D 日的 K 线在 D 日 15:00 收盘后才完整；盘中决策时当天那根也不画
    const visible = (date: string) => !then || Date.parse(`${date}T15:00:00+08:00`) <= (cutoffTs as number);
    const shown = bars.filter((b) => visible(b.date));
    const rawClose = new Map(raw.map((b) => [b.date, b.close]));
    const factor = new Map(adj.map((b) => [b.date, rawClose.get(b.date) ? b.close / (rawClose.get(b.date) as number) : 1]));
    const priceOf = (t: ChartTrade) => (then ? t.price : t.price * (factor.get(t.date) ?? 1));
    const visTrades = trades.filter((t) => dates.includes(t.date));
    const lastHigh = shown.length ? shown[shown.length - 1].high : Math.max(0, ...visTrades.map(priceOf));
    const highOf = (date: string) => shown.find((b) => b.date === date)?.high ?? lastHigh;

    // 同一天多个事件往上错开
    const stack = new Map<string, number>();
    const eventPoints = events
      .filter((e) => dates.includes(e.date))
      .map((e) => {
        const n = stack.get(e.date) ?? 0;
        stack.set(e.date, n + 1);
        return { value: [e.date, highOf(e.date) * (1.035 + n * 0.03)] as [string, number], id: e.id, title: e.title, kindLabel: e.kindLabel, tone: e.tone };
      });

    // 纵轴只按当时可见的数据定范围，不让后来的高低点透出来
    const ys = [...shown.flatMap((b) => [b.low, b.high]), ...visTrades.map(priceOf), ...eventPoints.map((p) => p.value[1])];
    const yMax = ys.length ? Math.max(...ys) * 1.03 : undefined;
    const yMin = ys.length ? Math.min(...ys) * 0.95 : undefined;

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
              const note = then ? "不复权" : `前复权${rawClose.get(p.name) ? `；不复权收盘 ${rawClose.get(p.name)}` : ""}`;
              return `${p.name}<br/>开 ${d[1].toFixed(2)} 收 ${d[2].toFixed(2)}<br/>低 ${d[3].toFixed(2)} 高 ${d[4].toFixed(2)}<br/><span style="color:${MUTED}">${note}</span>`;
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
          min: yMin,
          max: yMax,
          splitLine: { lineStyle: { color: "#e9ebe6" } },
          axisLabel: { color: MUTED, fontSize: 11, showMaxLabel: false, showMinLabel: false, formatter: (v: number) => String(Math.round(v * 100) / 100) },
        },
        dataZoom: [{ type: "inside" }, { type: "slider", height: 18, bottom: 8, showDataShadow: false, borderColor: "#dcdfd8", textStyle: { color: MUTED, fontSize: 10 } }],
        series: [
          {
            type: "candlestick",
            name: "K线",
            data: bars.map((b) => (visible(b.date) ? [b.open, b.close, b.low, b.high] : "-")),
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
            // 标记按成交价定位（当时已知），不用当天的最高最低价
            data: visTrades.map((t) => ({
              value: [t.date, t.side === "buy" ? priceOf(t) * 0.97 : priceOf(t) * 1.03],
              title: t.label,
              kindLabel: t.side === "buy" ? "买入" : "卖出",
              symbolRotate: t.side === "buy" ? 0 : 180,
              itemStyle: { color: t.side === "buy" ? UP : DOWN },
              label: { show: true, formatter: t.side === "buy" ? "买" : "卖", position: t.side === "buy" ? "bottom" : "top", color: t.side === "buy" ? UP : DOWN, fontSize: 11 },
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
      // 幕布从第一根还没收盘的 K 线开始（盘中决策时包括当天）
      const idx = dates.findIndex((d) => !visible(d));
      if (!then || idx === -1) return setCover(null);
      const x = c.convertToPixel({ xAxisIndex: 0 }, idx) as number;
      const prev = idx > 0 ? (c.convertToPixel({ xAxisIndex: 0 }, idx - 1) as number) : x;
      const left = Math.max(GRID.left, (x + prev) / 2);
      const right = c.getWidth() - GRID.right;
      setCover(left < right ? { left, width: right - left } : null);
    };
    place();
    c.off("datazoom");
    c.on("datazoom", place);
    c.off("finished");
    c.on("finished", place);
  }, [raw, adj, trades, events, decisionDate, cutoffTs, then, onEventClick]);

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
