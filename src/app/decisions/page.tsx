"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Tag } from "@/components/timing-badge";
import { ERROR_TYPE_TEXT, PORTFOLIO_LESSONS, fmtDate, pct, pctClass } from "@/lib/labels";
import { cn } from "@/lib/utils";
import type { BiasResult } from "@/lib/domain/biases";
import type { Attribution } from "@/lib/domain/attribution";
import type { Episode, Issue } from "@/lib/domain/types";

type Row = { episode: Episode; biases: BiasResult[]; attribution: Attribution; reviewStatus: string; lessons: number; holdDays: number | null };
type Data = { workspace: { id: string; isDemo: boolean }; episodes: Row[]; portfolio: BiasResult[]; issues: Issue[] };

const REVIEW_TEXT: Record<string, string> = { done: "已复盘", running: "生成中", failed: "生成失败", none: "未生成" };

const avg = (l: number[]) => (l.length ? l.reduce((a, b) => a + b, 0) / l.length : null);
const hitRules = (r: Row) => [...new Map(r.biases.filter((b) => b.outcome === "hit").map((b) => [b.ruleId, b])).values()];

function RuleTags({ row }: { row: Row }) {
  const hits = hitRules(row);
  if (!hits.length) return <span className="text-xs text-muted-foreground">无</span>;
  return (
    <div className="flex flex-wrap gap-1">
      {hits.map((b) =>
        b.ruleId === "B8" ? (
          <Tag key={b.ruleId} tone="warn">
            {b.name}（AI 判断）
          </Tag>
        ) : (
          <Tag key={b.ruleId} tone="danger">
            {b.name}
          </Tag>
        ),
      )}
    </div>
  );
}

/** 一组决策的总结：胜负、盈亏段的收益和持有时间、问题归类和偏差的分布 */
function Summary({ rows }: { rows: Row[] }) {
  const s = useMemo(() => {
    const closed = rows.filter((r) => r.episode.closeTs != null && r.episode.returnPct != null);
    const wins = closed.filter((r) => (r.episode.returnPct as number) > 0);
    const losses = closed.filter((r) => (r.episode.returnPct as number) < 0);
    const errors = new Map<string, number>();
    for (const r of closed) errors.set(r.attribution.errorType, (errors.get(r.attribution.errorType) ?? 0) + 1);
    const rules = new Map<string, { name: string; n: number; ai: boolean }>();
    for (const r of rows) for (const b of hitRules(r)) rules.set(b.ruleId, { name: b.name, n: (rules.get(b.ruleId)?.n ?? 0) + 1, ai: b.ruleId === "B8" });
    return {
      closed: closed.length,
      wins: wins.length,
      losses: losses.length,
      winRet: avg(wins.map((r) => r.episode.returnPct as number)),
      lossRet: avg(losses.map((r) => r.episode.returnPct as number)),
      winHold: avg(wins.map((r) => r.holdDays).filter((x): x is number => x != null)),
      lossHold: avg(losses.map((r) => r.holdDays).filter((x): x is number => x != null)),
      pnl: closed.reduce((a, r) => a + (r.episode.realizedPnl ?? 0), 0),
      fees: rows.reduce((a, r) => a + r.episode.fees, 0),
      errors: [...errors.entries()].sort((a, b) => b[1] - a[1]),
      rules: [...rules.values()].sort((a, b) => b.n - a.n),
    };
  }, [rows]);
  if (!s.closed) return null;
  const money = (v: number) => `${v >= 0 ? "+" : ""}${v.toLocaleString("zh-CN", { maximumFractionDigits: 0 })} 元`;

  return (
    <section className="rounded-lg border border-border bg-card p-4 sm:p-5">
      <h2 className="text-[15px] font-semibold mb-4">这一组决策的总结</h2>
      <dl className="grid grid-cols-2 lg:grid-cols-4 gap-x-6 gap-y-4 text-sm">
        <div>
          <dt className="text-xs text-muted-foreground">已平仓</dt>
          <dd className="mt-1 num">
            {s.closed} 段：盈利 {s.wins}、亏损 {s.losses}
            <span className="text-muted-foreground">（胜率 {((s.wins / s.closed) * 100).toFixed(0)}%）</span>
          </dd>
        </div>
        <div>
          <dt className="text-xs text-muted-foreground">盈利段平均</dt>
          <dd className="mt-1 num">
            <span className={pctClass(s.winRet)}>{pct(s.winRet)}</span>，持有 {s.winHold?.toFixed(1) ?? "—"} 个交易日
          </dd>
        </div>
        <div>
          <dt className="text-xs text-muted-foreground">亏损段平均</dt>
          <dd className="mt-1 num">
            <span className={pctClass(s.lossRet)}>{pct(s.lossRet)}</span>，持有 {s.lossHold?.toFixed(1) ?? "—"} 个交易日
          </dd>
        </div>
        <div>
          <dt className="text-xs text-muted-foreground">已实现盈亏（含分红、扣费）</dt>
          <dd className={cn("mt-1 num", pctClass(s.pnl))}>
            {money(s.pnl)} <span className="text-muted-foreground">，手续费 {s.fees.toFixed(0)} 元</span>
          </dd>
        </div>
      </dl>
      <div className="mt-4 pt-4 border-t border-border grid md:grid-cols-2 gap-4 text-sm">
        <div>
          <div className="text-xs text-muted-foreground mb-1.5">问题归类</div>
          <div className="flex flex-wrap gap-1.5">
            {s.errors.map(([k, n]) => (
              <Tag key={k}>
                {ERROR_TYPE_TEXT[k]} {n} 段
              </Tag>
            ))}
          </div>
        </div>
        <div>
          <div className="text-xs text-muted-foreground mb-1.5">命中最多的规则</div>
          <div className="flex flex-wrap gap-1.5">
            {s.rules.length ? (
              s.rules.map((r) => (
                <Tag key={r.name} tone={r.ai ? "warn" : "danger"}>
                  {r.name}
                  {r.ai ? "（AI 判断）" : ""} {r.n} 段
                </Tag>
              ))
            ) : (
              <span className="text-muted-foreground">没有命中任何规则</span>
            )}
          </div>
        </div>
      </div>
    </section>
  );
}

export default function DecisionsPage() {
  const router = useRouter();
  const [data, setData] = useState<Data | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [added, setAdded] = useState<Set<string>>(new Set());

  useEffect(() => {
    fetch("/api/rules")
      .then((r) => r.json())
      .then((j) => (j.episodes ? setData(j) : setError(j.error ?? "读取失败")))
      .catch(() => setError("读取失败，请刷新重试"));
    fetch("/api/checklist")
      .then((r) => r.json())
      .then((j) => setAdded(new Set((j.items ?? []).map((x: { sourceLessonId: string | null }) => x.sourceLessonId).filter(Boolean))));
  }, []);

  const addPortfolioLesson = async (ruleId: string) => {
    const l = PORTFOLIO_LESSONS[ruleId];
    const sourceLessonId = `portfolio:${data?.workspace.id}:${ruleId}`;
    const r = await fetch("/api/checklist", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ text: l.text, trigger: l.trigger, sourceLessonId }) });
    if (r.ok) {
      setAdded(new Set([...added, sourceLessonId]));
      toast.success("已加入我的清单");
    }
  };

  const purge = async () => {
    if (!window.confirm("删除你导入的成交和生成的复盘？删除后不能恢复。清单不受影响。")) return;
    const r = await fetch("/api/workspace?purge=1", { method: "DELETE" }).then((x) => x.json());
    toast.success(`已删除 ${r.purged} 笔成交和相关复盘，回到示例组合`);
    router.push("/");
  };

  if (error) return <p className="text-destructive">{error}</p>;
  if (!data) return <p className="text-muted-foreground">正在按持仓段整理成交、拉取行情和资讯并计算规则结果……第一次打开一个组合大约需要 1 分钟，之后读缓存。</p>;

  const portfolioHits = data.portfolio.filter((p) => p.outcome === "hit");
  const errors = data.issues.filter((i) => i.severity === "error");
  const warnings = data.issues.filter((i) => i.severity === "warning");
  const href = (r: Row) => `/decisions/${encodeURIComponent(r.episode.id)}`;

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold">我的决策</h1>
          <p className="text-sm text-muted-foreground mt-1">
            {data.workspace.isDemo ? "示例组合：一位虚构投资者 2026 年 6–9 月的 21 笔成交，股票和行情是真实的。" : "你导入的成交，按持仓段（从买入到清仓）分组。导入的数据保留 7 天。"}
            每一段可以回到当时看下单前知道什么，再揭晓结果。
          </p>
        </div>
        <div className="flex gap-2">
          <Link href="/" className="text-sm px-3 py-1.5 rounded-md border border-border bg-card hover:bg-muted">
            {data.workspace.isDemo ? "导入我自己的交易" : "重新导入"}
          </Link>
          {!data.workspace.isDemo && (
            <Button variant="ghost" size="sm" className="text-destructive" onClick={purge}>
              删除我导入的数据
            </Button>
          )}
        </div>
      </div>

      {(errors.length > 0 || warnings.length > 0) && (
        <section className="rounded-lg border border-expost/40 bg-card p-4 text-sm">
          <h2 className="font-medium mb-2">
            导入的成交有 {errors.length} 个错误、{warnings.length} 个提醒
          </h2>
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

      <Summary rows={data.episodes} />

      {portfolioHits.length > 0 && (
        <section className="rounded-lg border border-border bg-card p-4 sm:p-5">
          <h2 className="text-[15px] font-semibold mb-3">跨持仓段看到的模式</h2>
          <ul className="space-y-3 text-sm">
            {portfolioHits.map((p) => {
              const lessonId = `portfolio:${data.workspace.id}:${p.ruleId}`;
              return (
                <li key={p.ruleId + p.finding} className="flex flex-col sm:flex-row sm:items-start gap-2 sm:gap-4">
                  <div className="flex-1 leading-relaxed">
                    <Tag tone="danger" className="mr-2">
                      {p.name}
                    </Tag>
                    {p.finding}
                    {PORTFOLIO_LESSONS[p.ruleId] && <div className="text-muted-foreground mt-1">下次：{PORTFOLIO_LESSONS[p.ruleId].text}</div>}
                  </div>
                  {PORTFOLIO_LESSONS[p.ruleId] && (
                    <Button size="sm" variant={added.has(lessonId) ? "secondary" : "default"} disabled={added.has(lessonId)} onClick={() => addPortfolioLesson(p.ruleId)} className="shrink-0">
                      {added.has(lessonId) ? "已加入清单" : "加入我的清单"}
                    </Button>
                  )}
                </li>
              );
            })}
          </ul>
        </section>
      )}

      {/* 手机：卡片 */}
      <ul className="md:hidden space-y-3">
        {data.episodes.map((r) => (
          <li key={r.episode.id}>
            <Link href={href(r)} className="block rounded-lg border border-border bg-card p-4 active:bg-muted focus-visible:outline-2 focus-visible:outline-ring">
              <div className="flex items-baseline justify-between gap-3">
                <span className="font-medium">
                  {r.episode.name ?? r.episode.code} <span className="text-xs text-muted-foreground num">{r.episode.code}</span>
                </span>
                <span className={cn("num font-medium", pctClass(r.episode.returnPct))}>{pct(r.episode.returnPct)}</span>
              </div>
              <div className="text-xs text-muted-foreground num mt-1">
                {fmtDate(r.episode.openTs)} → {r.episode.closeTs ? fmtDate(r.episode.closeTs) : "持有中"}
                {r.holdDays != null && `，${r.holdDays} 个交易日`}
              </div>
              <div className="text-sm mt-2">
                {r.attribution.quadrant}，{ERROR_TYPE_TEXT[r.attribution.errorType]}
                <span className={cn("ml-2 text-xs", r.reviewStatus === "done" ? "text-exante" : "text-muted-foreground")}>{REVIEW_TEXT[r.reviewStatus] ?? r.reviewStatus}</span>
              </div>
              <div className="mt-2">
                <RuleTags row={r} />
              </div>
            </Link>
          </li>
        ))}
      </ul>

      {/* 桌面：表格 */}
      <div className="hidden md:block rounded-lg border border-border bg-card overflow-x-auto">
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
            {data.episodes.map((r) => (
              <tr key={r.episode.id} className="hover:bg-muted/50">
                <td className="px-4 py-3">
                  <Link href={href(r)} className="font-medium hover:underline focus-visible:outline-2 focus-visible:outline-ring">
                    {r.episode.name ?? r.episode.code}
                  </Link>
                  <div className="text-xs text-muted-foreground num">{r.episode.code}</div>
                </td>
                <td className="px-4 py-3 num whitespace-nowrap text-muted-foreground">
                  {fmtDate(r.episode.openTs)} → {r.episode.closeTs ? fmtDate(r.episode.closeTs) : "持有中"}
                  {r.holdDays != null && <div className="text-xs">{r.holdDays} 个交易日</div>}
                </td>
                <td className={cn("px-4 py-3 text-right num font-medium", pctClass(r.episode.returnPct))}>{pct(r.episode.returnPct)}</td>
                <td className="px-4 py-3 whitespace-nowrap">{r.attribution.quadrant}</td>
                <td className="px-4 py-3 whitespace-nowrap">{ERROR_TYPE_TEXT[r.attribution.errorType]}</td>
                <td className="px-4 py-3">
                  <RuleTags row={r} />
                </td>
                <td className="px-4 py-3 whitespace-nowrap">
                  <Link href={href(r)} className={cn("text-xs", r.reviewStatus === "done" ? "text-exante" : "text-muted-foreground")}>
                    {REVIEW_TEXT[r.reviewStatus] ?? r.reviewStatus}
                  </Link>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {!data.episodes.length && (
        <div className="rounded-lg border border-dashed border-border bg-card p-8 text-center text-sm text-muted-foreground">
          还没有可以复盘的成交。
          <Link href="/" className="text-exante underline">
            导入交易
          </Link>
          ，或者先看示例组合。
        </div>
      )}
    </div>
  );
}
