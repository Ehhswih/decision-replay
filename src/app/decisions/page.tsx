"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { Tag } from "@/components/timing-badge";
import { ERROR_TYPE_TEXT, fmtDate, pct, pctClass } from "@/lib/labels";
import { cn } from "@/lib/utils";
import type { BiasResult } from "@/lib/domain/biases";
import type { Attribution } from "@/lib/domain/attribution";
import type { Episode, Issue } from "@/lib/domain/types";

type Row = { episode: Episode; biases: BiasResult[]; attribution: Attribution; reviewStatus: string; lessons: number };
type Data = { workspace: { id: string; isDemo: boolean }; episodes: Row[]; portfolio: BiasResult[]; issues: Issue[] };

const REVIEW_TEXT: Record<string, string> = { done: "已复盘", running: "生成中", failed: "生成失败", none: "未生成" };

export default function DecisionsPage() {
  const [data, setData] = useState<Data | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetch("/api/rules")
      .then((r) => r.json())
      .then((j) => (j.episodes ? setData(j) : setError(j.error ?? "读取失败")))
      .catch(() => setError("读取失败，请刷新重试"));
  }, []);

  if (error) return <p className="text-destructive">{error}</p>;
  if (!data) return <p className="text-muted-foreground">正在按持仓段整理成交，并计算规则结果……第一次打开需要拉取行情，大约 30 秒。</p>;

  const portfolioHits = data.portfolio.filter((p) => p.outcome === "hit");
  const errors = data.issues.filter((i) => i.severity === "error");
  const warnings = data.issues.filter((i) => i.severity === "warning");

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold">我的决策</h1>
          <p className="text-sm text-muted-foreground mt-1">
            {data.workspace.isDemo ? "示例组合：一位虚构投资者 2026 年 6–9 月的 21 笔成交，股票和行情是真实的。" : "你导入的成交，按持仓段（从买入到清仓）分组。"}
            每一段可以回到当时看下单前知道什么，再揭晓结果。
          </p>
        </div>
        <Link href="/" className="text-sm px-3 py-1.5 rounded-md border border-border bg-card hover:bg-muted">
          {data.workspace.isDemo ? "导入我自己的交易" : "重新导入或回到示例"}
        </Link>
      </div>

      {(errors.length > 0 || warnings.length > 0) && (
        <section className="rounded-lg border border-expost/40 bg-card p-4 text-sm">
          <h2 className="font-medium mb-2">导入的成交有 {errors.length} 个错误、{warnings.length} 个提醒</h2>
          <ul className="space-y-1">
            {[...errors, ...warnings].slice(0, 12).map((i, k) => (
              <li key={k} className={i.severity === "error" ? "text-destructive" : "text-expost"}>
                {i.rowNo ? `第 ${i.rowNo} 行：` : ""}
                {i.message}
              </li>
            ))}
          </ul>
        </section>
      )}

      {portfolioHits.length > 0 && (
        <section className="rounded-lg border border-border bg-card p-4">
          <h2 className="text-[15px] font-semibold mb-2">跨持仓段看到的模式</h2>
          <ul className="space-y-1.5 text-sm">
            {portfolioHits.map((p) => (
              <li key={p.ruleId + p.finding}>
                <Tag tone="danger" className="mr-2">
                  {p.name}
                </Tag>
                {p.finding}
              </li>
            ))}
          </ul>
        </section>
      )}

      <div className="rounded-lg border border-border bg-card overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="text-left text-xs text-muted-foreground border-b border-border">
            <tr>
              <th className="px-4 py-2.5 font-normal">股票</th>
              <th className="px-4 py-2.5 font-normal">持仓段</th>
              <th className="px-4 py-2.5 font-normal text-right">收益</th>
              <th className="px-4 py-2.5 font-normal">过程 · 结果</th>
              <th className="px-4 py-2.5 font-normal">问题归类</th>
              <th className="px-4 py-2.5 font-normal">命中的规则</th>
              <th className="px-4 py-2.5 font-normal">复盘</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {data.episodes.map((r) => {
              const hits = [...new Map(r.biases.filter((b) => b.outcome === "hit").map((b) => [b.ruleId, b])).values()];
              return (
                <tr key={r.episode.id} className="hover:bg-muted/50">
                  <td className="px-4 py-3">
                    <Link href={`/decisions/${encodeURIComponent(r.episode.id)}`} className="font-medium hover:underline focus-visible:outline-2 focus-visible:outline-ring">
                      {r.episode.name ?? r.episode.code}
                    </Link>
                    <div className="text-xs text-muted-foreground num">{r.episode.code}</div>
                  </td>
                  <td className="px-4 py-3 num whitespace-nowrap text-muted-foreground">
                    {fmtDate(r.episode.openTs)} → {r.episode.closeTs ? fmtDate(r.episode.closeTs) : "持有中"}
                  </td>
                  <td className={cn("px-4 py-3 text-right num font-medium", pctClass(r.episode.returnPct))}>{pct(r.episode.returnPct)}</td>
                  <td className="px-4 py-3 whitespace-nowrap">{r.attribution.quadrant}</td>
                  <td className="px-4 py-3 whitespace-nowrap">{ERROR_TYPE_TEXT[r.attribution.errorType]}</td>
                  <td className="px-4 py-3">
                    <div className="flex flex-wrap gap-1">
                      {hits.length ? hits.map((b) => (b.ruleId === "B8" ? <Tag key={b.ruleId} tone="warn">{b.name}（AI 判断）</Tag> : <Tag key={b.ruleId} tone="danger">{b.name}</Tag>)) : <span className="text-xs text-muted-foreground">无</span>}
                    </div>
                  </td>
                  <td className="px-4 py-3 whitespace-nowrap">
                    <Link href={`/decisions/${encodeURIComponent(r.episode.id)}`} className={cn("text-xs", r.reviewStatus === "done" ? "text-exante" : "text-muted-foreground")}>
                      {REVIEW_TEXT[r.reviewStatus] ?? r.reviewStatus}
                    </Link>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
        {!data.episodes.length && (
          <div className="p-8 text-center text-sm text-muted-foreground">
            还没有可以复盘的成交。<Link href="/" className="text-exante underline">导入交易</Link>，或者先看示例组合。
          </div>
        )}
      </div>
    </div>
  );
}
