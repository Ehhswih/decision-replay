"use client";

import { useEffect, useState } from "react";
import { Tag } from "@/components/timing-badge";
import { STATUS_TEXT, fmtDateTime } from "@/lib/labels";
import type { SourceStatus } from "@/lib/pipeline";

type Status = {
  workspace: { isDemo: boolean };
  sources: SourceStatus[];
  summary: { source: string; status: string; from_cache: number; n: number; avg_ms: number | null }[];
  recent: { source: string; endpoint: string; status: string; code: string | null; message: string | null; latency_ms: number | null; at: number }[];
  cache: { source: string; n: number; oldest: number; newest: number }[];
  reviews: { status: string; n: number }[];
  ifind: { used: number; limit: number; remaining: number };
  config: { fuyao: boolean; deepseek: boolean; model: string; ifind: boolean };
};

const SOURCE_NAME: Record<string, string> = { fuyao: "扶摇", ifind: "iFinD" };

export default function StatusPage() {
  const [s, setS] = useState<Status | null>(null);
  useEffect(() => {
    fetch("/api/status")
      .then((r) => r.json())
      .then(setS);
  }, []);
  if (!s) return <p className="text-muted-foreground">正在读取……</p>;

  const live = s.summary.filter((x) => !x.from_cache);
  const cached = s.summary.filter((x) => x.from_cache).reduce((a, x) => a + x.n, 0);

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-[1.75rem] font-semibold tracking-tight">数据状态</h1>
        <p className="text-sm text-muted-foreground mt-1">每一次外部调用都有记录。数据没取到、过期或被降级时，复盘页面会在「数据源提示」和「不确定因素」里写明，不会当成正常数据。</p>
      </div>

      <div className="grid sm:grid-cols-2 lg:grid-cols-4 gap-4">
        {[
          ["扶摇金融数据", s.config.fuyao, "行情、财报、新闻、异动、热榜、龙虎榜"],
          ["iFinD MCP", s.config.ifind, `公告检索；已用 ${s.ifind.used} / ${s.ifind.limit} 次`],
          ["DeepSeek", s.config.deepseek, `模型 ${s.config.model}`],
          ["本地缓存", true, `${s.cache.reduce((a, c) => a + c.n, 0)} 条；24 小时内命中 ${cached} 次`],
        ].map(([name, ok, note]) => (
          <div key={name as string} className="panel p-4">
            <div className="flex items-center justify-between">
              <span className="font-medium text-sm">{name}</span>
              <Tag tone={ok ? "ok" : "danger"}>{ok ? "已配置" : "未配置"}</Tag>
            </div>
            <p className="text-xs text-muted-foreground mt-2">{note}</p>
          </div>
        ))}
      </div>

      <section className="panel p-5">
        <h2 className="text-[15px] font-semibold tracking-tight mb-3">当前组合用到的数据源</h2>
        <ul className="grid md:grid-cols-2 gap-x-6 gap-y-1.5 text-sm">
          {s.sources.map((x) => (
            <li key={x.key} className="flex flex-wrap items-center gap-2">
              <Tag tone={x.status === "ok" ? "ok" : x.status === "failed" ? "danger" : "warn"}>{STATUS_TEXT[x.status] ?? x.status}</Tag>
              <span>{x.label}</span>
              {x.fromCache && <span className="text-xs text-muted-foreground">缓存于 {fmtDateTime(x.fetchedAt)}</span>}
              {x.error && <span className="text-xs text-destructive">{x.error.message}</span>}
            </li>
          ))}
        </ul>
      </section>

      <section className="panel p-5">
        <h2 className="text-[15px] font-semibold tracking-tight mb-3">最近 24 小时的实际调用</h2>
        <div className="flex flex-wrap gap-3 text-sm mb-4">
          {live.map((x) => (
            <span key={x.source + x.status} className="rounded border border-border px-2 py-1">
              {SOURCE_NAME[x.source] ?? x.source} · {STATUS_TEXT[x.status] ?? x.status} <span className="num font-medium">{x.n}</span> 次
              {x.avg_ms != null && <span className="text-muted-foreground num">，平均 {x.avg_ms} ms</span>}
            </span>
          ))}
          {!live.length && <span className="text-muted-foreground">没有实际调用（全部命中缓存）</span>}
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-xs">
            <thead className="text-left text-muted-foreground">
              <tr>
                <th className="py-1.5 pr-3 font-normal">时间</th>
                <th className="py-1.5 pr-3 font-normal">来源</th>
                <th className="py-1.5 pr-3 font-normal">接口</th>
                <th className="py-1.5 pr-3 font-normal">结果</th>
                <th className="py-1.5 pr-3 font-normal text-right">耗时</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {s.recent.map((r, i) => (
                <tr key={i}>
                  <td className="py-1.5 pr-3 num whitespace-nowrap">{fmtDateTime(r.at)}</td>
                  <td className="py-1.5 pr-3">{SOURCE_NAME[r.source] ?? r.source}</td>
                  <td className="py-1.5 pr-3 break-all">{r.endpoint}</td>
                  <td className={`py-1.5 pr-3 ${r.status === "failed" ? "text-destructive" : ""}`}>
                    {STATUS_TEXT[r.status] ?? r.status}
                    {r.message ? `：${r.message}` : ""}
                  </td>
                  <td className="py-1.5 pr-3 num text-right">{r.latency_ms ?? "—"} ms</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}
