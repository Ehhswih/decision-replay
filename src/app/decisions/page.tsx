"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Tag } from "@/components/timing-badge";
import { HoldingsTimeline } from "@/components/holdings-timeline";
import { ERROR_TYPE_TEXT, PORTFOLIO_LESSONS, fmtDate, pct, pctClass, quadrantText } from "@/lib/labels";
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

/** 分布：一种颜色的细条，长度是段数，数字直接写在旁边 */
function Distribution({ title, items, empty }: { title: string; items: { key: string; label: React.ReactNode; n: number }[]; empty: string }) {
  const max = Math.max(1, ...items.map((i) => i.n));
  return (
    <div>
      <h3 className="text-xs text-muted-foreground mb-2.5">{title}</h3>
      {items.length ? (
        <ul className="space-y-2">
          {items.map((i) => (
            <li key={i.key} className="grid grid-cols-[minmax(0,9rem)_1fr_2.5rem] items-center gap-3 text-[13px]">
              <span className="truncate">{i.label}</span>
              <span className="h-1.5 rounded-full bg-muted overflow-hidden">
                <span className="block h-full rounded-full bg-foreground/70" style={{ width: `${(i.n / max) * 100}%` }} />
              </span>
              <span className="num text-right text-muted-foreground">{i.n} 段</span>
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-[13px] text-muted-foreground">{empty}</p>
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
      rules: [...rules.entries()].sort((a, b) => b[1].n - a[1].n),
    };
  }, [rows]);
  if (!s.closed) return null;
  const money = (v: number) => `${v >= 0 ? "+" : "−"}${Math.abs(v).toLocaleString("zh-CN", { maximumFractionDigits: 0 })}`;
  const kpis: { label: string; value: React.ReactNode; sub: React.ReactNode }[] = [
    {
      label: "已平仓",
      value: (
        <>
          {s.closed}
          <span className="text-base font-normal text-muted-foreground ml-1">段</span>
        </>
      ),
      sub: (
        <>
          盈利 {s.wins}、亏损 {s.losses}，胜率 {((s.wins / s.closed) * 100).toFixed(0)}%
        </>
      ),
    },
    { label: "盈利段平均", value: <span className={pctClass(s.winRet)}>{pct(s.winRet)}</span>, sub: <>平均持有 {s.winHold?.toFixed(1) ?? "—"} 个交易日</> },
    { label: "亏损段平均", value: <span className={pctClass(s.lossRet)}>{pct(s.lossRet)}</span>, sub: <>平均持有 {s.lossHold?.toFixed(1) ?? "—"} 个交易日</> },
    {
      label: "已实现盈亏",
      value: (
        <span className={pctClass(s.pnl)}>
          {money(s.pnl)}
          <span className="text-base font-normal text-muted-foreground ml-1">元</span>
        </span>
      ),
      sub: <>含分红、已扣手续费 {s.fees.toFixed(0)} 元</>,
    },
  ];

  return (
    <section className="panel overflow-hidden" aria-label="这一组决策的总结">
      <dl className="grid grid-cols-2 lg:grid-cols-4 divide-border [&>div]:border-border max-lg:[&>div:nth-child(-n+2)]:border-b lg:divide-x max-lg:[&>div:nth-child(odd)]:border-r">
        {kpis.map((k) => (
          <div key={k.label} className="p-4 sm:p-5">
            <dt className="text-xs text-muted-foreground">{k.label}</dt>
            <dd className="figure text-2xl sm:text-[1.75rem] font-semibold mt-1.5 leading-none">{k.value}</dd>
            <dd className="text-xs text-muted-foreground mt-2 num">{k.sub}</dd>
          </div>
        ))}
      </dl>
      <div className="border-t border-border p-4 sm:p-5 grid md:grid-cols-2 gap-6 md:gap-10">
        <Distribution title="问题归类（已平仓）" items={s.errors.map(([k, n]) => ({ key: k, label: ERROR_TYPE_TEXT[k], n }))} empty="没有已平仓的持仓段" />
        <Distribution
          title="命中最多的规则"
          items={s.rules.map(([id, r]) => ({
            key: id,
            label: (
              <>
                {r.name}
                {r.ai && <span className="text-[11px] text-expost ml-1">AI 判断</span>}
              </>
            ),
            n: r.n,
          }))}
          empty="没有命中任何规则"
        />
      </div>
    </section>
  );
}

export default function DecisionsPage() {
  const router = useRouter();
  const [data, setData] = useState<Data | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [added, setAdded] = useState<Set<string>>(new Set());
  // 导入时解析阶段的说明（只在刚导入的浏览器标签页里有）
  const [parseIssues] = useState<Issue[]>(() => {
    try {
      return typeof window === "undefined" ? [] : (JSON.parse(sessionStorage.getItem("dr_import_issues") ?? "[]") as Issue[]);
    } catch {
      return [];
    }
  });

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
  if (!data) {
    return (
      <div className="space-y-4" aria-busy>
        <p className="text-sm text-muted-foreground">正在按持仓段整理成交、拉取行情和资讯并计算规则结果……第一次打开一个组合大约需要 1 分钟，之后读缓存。</p>
        <div className="panel h-36 animate-pulse" />
        <div className="panel h-64 animate-pulse" />
      </div>
    );
  }

  const portfolioHits = data.portfolio.filter((p) => p.outcome === "hit");
  const allIssues = data.workspace.isDemo ? data.issues : [...parseIssues, ...data.issues];
  const errors = allIssues.filter((i) => i.severity === "error");
  const warnings = allIssues.filter((i) => i.severity === "warning");
  const notices = allIssues.filter((i) => i.severity === "info");
  const href = (r: { episode: Episode }) => `/decisions/${encodeURIComponent(r.episode.id)}`;

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-[1.75rem] font-semibold tracking-tight">我的决策</h1>
          <p className="text-sm text-muted-foreground mt-1.5 max-w-3xl leading-relaxed">
            {data.workspace.isDemo
              ? "示例组合：一位虚构投资者 2026 年 6–9 月的 21 笔成交，股票和行情是真实的。"
              : `你导入的 ${data.episodes.reduce((a, r) => a + r.episode.trades.length, 0)} 笔成交，按持仓段（从买入到清仓）分组。导入的数据保留 7 天。`}
            每一段可以回到当时看下单前知道什么，再揭晓结果。
          </p>
        </div>
        <div className="flex gap-2">
          <Link href="/" className="text-sm px-4 py-2 rounded-full border border-border bg-card hover:bg-muted">
            {data.workspace.isDemo ? "导入我自己的交易" : "重新导入"}
          </Link>
          {!data.workspace.isDemo && (
            <Button variant="ghost" size="sm" className="text-destructive h-9 rounded-full" onClick={purge}>
              删除我导入的数据
            </Button>
          )}
        </div>
      </div>

      {(errors.length > 0 || warnings.length > 0 || notices.length > 0) && (
        <details className="panel p-4 text-sm" open={errors.length > 0}>
          <summary className="cursor-pointer font-medium">
            导入时{errors.length ? `有 ${errors.length} 个错误、` : ""}
            {warnings.length} 个提醒{notices.length ? `，${notices.length} 条处理说明（跳过的非买卖记录、合并的分笔成交等）` : ""}
          </summary>
          <ul className="space-y-1 mt-2 max-h-64 overflow-y-auto">
            {[...errors, ...warnings, ...notices].slice(0, 60).map((i, k) => (
              <li key={k} className={i.severity === "error" ? "text-destructive" : i.severity === "warning" ? "text-expost" : "text-muted-foreground"}>
                {i.rowNo ? `第 ${i.rowNo} 行：` : ""}
                {i.message}
              </li>
            ))}
          </ul>
        </details>
      )}

      <Summary rows={data.episodes} />

      <HoldingsTimeline rows={data.episodes} hrefOf={href} />

      {portfolioHits.length > 0 && (
        <section className="panel p-4 sm:p-5">
          <h2 className="text-[15px] font-semibold tracking-tight mb-3">跨持仓段看到的模式</h2>
          <ul className="divide-y divide-border">
            {portfolioHits.map((p) => {
              const lessonId = `portfolio:${data.workspace.id}:${p.ruleId}`;
              return (
                <li key={p.ruleId + p.finding} className="flex flex-col sm:flex-row sm:items-start gap-2 sm:gap-4 py-3 first:pt-0 last:pb-0 text-sm">
                  <div className="flex-1 leading-relaxed">
                    <Tag tone="danger" className="mr-2">
                      {p.name}
                    </Tag>
                    {p.finding}
                    {PORTFOLIO_LESSONS[p.ruleId] && <div className="text-muted-foreground mt-1">下次：{PORTFOLIO_LESSONS[p.ruleId].text}</div>}
                  </div>
                  {PORTFOLIO_LESSONS[p.ruleId] && (
                    <Button size="sm" variant={added.has(lessonId) ? "secondary" : "default"} disabled={added.has(lessonId)} onClick={() => addPortfolioLesson(p.ruleId)} className="shrink-0 rounded-full px-3">
                      {added.has(lessonId) ? "已加入清单" : "加入我的清单"}
                    </Button>
                  )}
                </li>
              );
            })}
          </ul>
        </section>
      )}

      <section aria-label="持仓段列表" className="space-y-3">
        <h2 className="text-[15px] font-semibold tracking-tight">全部持仓段</h2>
        {/* 手机：卡片 */}
        <ul className="md:hidden space-y-3">
          {data.episodes.map((r) => (
            <li key={r.episode.id}>
              <Link href={href(r)} className="block panel p-4 active:bg-muted focus-visible:outline-2 focus-visible:outline-ring">
                <div className="flex items-baseline justify-between gap-3">
                  <span className="font-medium">
                    {r.episode.name ?? r.episode.code} <span className="text-xs text-muted-foreground num">{r.episode.code}</span>
                  </span>
                  <span className={cn("figure text-lg font-semibold", pctClass(r.episode.returnPct))}>{pct(r.episode.returnPct)}</span>
                </div>
                <div className="text-xs text-muted-foreground num mt-1">
                  {fmtDate(r.episode.openTs)} 至 {r.episode.closeTs ? fmtDate(r.episode.closeTs) : "持有中"}
                  {r.holdDays != null && `，${r.holdDays} 个交易日`}
                </div>
                <div className="text-sm mt-2.5 flex flex-wrap items-center gap-x-2 gap-y-1">
                  <span>{quadrantText(r.attribution.quadrant)}</span>
                  <Tag tone={r.attribution.errorType === "none" ? "ok" : r.attribution.errorType === "undetermined" ? "neutral" : "warn"}>{ERROR_TYPE_TEXT[r.attribution.errorType]}</Tag>
                  <span className={cn("ml-auto text-xs", r.reviewStatus === "done" ? "text-exante" : "text-muted-foreground")}>{REVIEW_TEXT[r.reviewStatus] ?? r.reviewStatus}</span>
                </div>
                <div className="mt-2">
                  <RuleTags row={r} />
                </div>
              </Link>
            </li>
          ))}
        </ul>

        {/* 桌面：表格 */}
        <div className="hidden md:block panel overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="text-left text-xs text-muted-foreground">
              <tr className="border-b border-border">
                <th className="px-4 py-3 font-normal">股票</th>
                <th className="px-4 py-3 font-normal">持仓段</th>
                <th className="px-4 py-3 font-normal text-right">收益</th>
                <th className="px-4 py-3 font-normal">过程和结果</th>
                <th className="px-4 py-3 font-normal">问题归类</th>
                <th className="px-4 py-3 font-normal">命中的规则</th>
                <th className="px-4 py-3 font-normal">复盘</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {data.episodes.map((r) => (
                <tr key={r.episode.id} className="group hover:bg-muted/50 cursor-pointer" onClick={() => router.push(href(r))}>
                  <td className="px-4 py-3.5">
                    <Link href={href(r)} onClick={(e) => e.stopPropagation()} className="font-medium group-hover:underline underline-offset-2 focus-visible:outline-2 focus-visible:outline-ring">
                      {r.episode.name ?? r.episode.code}
                    </Link>
                    <div className="text-xs text-muted-foreground num">{r.episode.code}</div>
                  </td>
                  <td className="px-4 py-3.5 num whitespace-nowrap text-muted-foreground">
                    {fmtDate(r.episode.openTs)} 至 {r.episode.closeTs ? fmtDate(r.episode.closeTs) : "持有中"}
                    {r.holdDays != null && <div className="text-xs">{r.holdDays} 个交易日</div>}
                  </td>
                  <td className={cn("px-4 py-3.5 text-right figure text-[15px] font-semibold", pctClass(r.episode.returnPct))}>{pct(r.episode.returnPct)}</td>
                  <td className="px-4 py-3.5 whitespace-nowrap">{quadrantText(r.attribution.quadrant)}</td>
                  <td className="px-4 py-3.5 whitespace-nowrap">
                    <Tag tone={r.attribution.errorType === "none" ? "ok" : r.attribution.errorType === "undetermined" ? "neutral" : "warn"}>{ERROR_TYPE_TEXT[r.attribution.errorType]}</Tag>
                  </td>
                  <td className="px-4 py-3.5">
                    <RuleTags row={r} />
                  </td>
                  <td className="px-4 py-3.5 whitespace-nowrap">
                    <span className={cn("inline-flex items-center gap-1.5 text-xs", r.reviewStatus === "done" ? "text-exante" : "text-muted-foreground")}>
                      <span className={cn("size-1.5 rounded-full", r.reviewStatus === "done" ? "bg-exante" : r.reviewStatus === "failed" ? "bg-destructive" : "bg-muted-foreground/50")} />
                      {REVIEW_TEXT[r.reviewStatus] ?? r.reviewStatus}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
      {!data.episodes.length && (
        <div className="rounded-xl border border-dashed border-border bg-card p-10 text-center text-sm text-muted-foreground">
          还没有可以复盘的成交。
          <Link href="/" className="text-exante underline mx-1">
            导入交易
          </Link>
          ，或者先看示例组合。
        </div>
      )}
    </div>
  );
}
