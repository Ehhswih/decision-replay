"use client";

import Link from "next/link";
import { useParams } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { KlineChart, type ChartEvent, type ChartTrade } from "@/components/kline-chart";
import { EvidenceSheet } from "@/components/evidence-sheet";
import { EvidenceList } from "@/components/review/evidence-list";
import { ExAntePanel } from "@/components/review/exante-panel";
import { RevealPanel } from "@/components/review/reveal-panel";
import { BeforeAfter, LinkedNotes, PrejudgmentForm, matchNotes } from "@/components/review/prejudgment";
import { KIND_LABEL, fmtDate, fmtDateTime, pct, pctClass, timingOf } from "@/lib/labels";
import { cn } from "@/lib/utils";
import type { Evidence } from "@/lib/domain/evidence";
import type { BiasResult } from "@/lib/domain/biases";
import type { Attribution } from "@/lib/domain/attribution";
import type { Episode } from "@/lib/domain/types";
import { planAt } from "@/lib/domain/plan";
import type { EvidenceSet } from "@/lib/pipeline";
import type { ReviewDoc } from "@/lib/ai/review";
import type { DecisionNote, Prejudgment, Verdict } from "@/lib/records";

type RulesEp = { episode: Episode; biases: BiasResult[]; attribution: Attribution };
type ReviewState = { status: "none" | "running" | "done" | "failed"; stage?: string; review?: ReviewDoc; error?: string };

const EVENT_KINDS = new Set(["anomaly", "notice", "financial", "corporate_action"]);

export default function DecisionView() {
  const { id } = useParams<{ id: string }>();
  const episodeId = decodeURIComponent(id);
  const [rules, setRules] = useState<RulesEp | null>(null);
  const [set, setSet] = useState<EvidenceSet | null>(null);
  const [rv, setRv] = useState<ReviewState>({ status: "none" });
  const [error, setError] = useState<string | null>(null);
  // 链接里带 ?view=reveal 时直接打开揭晓视图（数据加载完之前只渲染加载态，不会和服务端渲染不一致）
  const [mode, setMode] = useState<"then" | "reveal">(() => (typeof window !== "undefined" && new URLSearchParams(window.location.search).get("view") === "reveal" ? "reveal" : "then"));
  const [decisionId, setDecisionId] = useState<string | null>(null);
  const [open, setOpen] = useState<Evidence | null>(null);
  const [added, setAdded] = useState<Set<string>>(new Set());
  const [isDemo, setIsDemo] = useState(true);
  const [wsLoaded, setWsLoaded] = useState(false);
  const autoStarted = useRef(false);
  const [pjs, setPjs] = useState<Prejudgment[]>([]);
  const [notes, setNotes] = useState<DecisionNote[]>([]);
  // 这个持仓段是否打开过揭晓视图：之后再写的判断要标注出来
  const revealKey = `dr_revealed:${episodeId}`;
  const [revealedBefore, setRevealedBefore] = useState(() => {
    try {
      if (typeof window !== "undefined" && new URLSearchParams(window.location.search).get("view") === "reveal") localStorage.setItem(revealKey, "1");
      return typeof window !== "undefined" && localStorage.getItem(revealKey) === "1";
    } catch {
      return false;
    }
  });
  const reveal = () => {
    setMode("reveal");
    setRevealedBefore(true);
    try {
      localStorage.setItem(revealKey, "1");
    } catch {}
  };

  useEffect(() => {
    fetch("/api/rules")
      .then((r) => r.json())
      .then((j) => {
        const e = (j.episodes as RulesEp[] | undefined)?.find((x) => x.episode.id === episodeId);
        if (!e) setError("找不到这个持仓段，可能是导入的数据变了");
        else setRules(e);
      })
      .catch(() => setError("读取规则结果失败"));
    fetch(`/api/episodes/${encodeURIComponent(episodeId)}/evidence?slim=1`)
      .then((r) => r.json())
      .then((j) => (j.error ? setError(j.error) : setSet(j)))
      .catch(() => setError("读取证据失败"));
    fetch("/api/workspace")
      .then((r) => r.json())
      .then((w) => {
        setIsDemo(!!w.isDemo);
        setWsLoaded(true);
      })
      .catch(() => {});
    fetch(`/api/episodes/${encodeURIComponent(episodeId)}/prejudgment`)
      .then((r) => r.json())
      .then((j) => setPjs(j.items ?? []))
      .catch(() => {});
    fetch("/api/notes")
      .then((r) => r.json())
      .then((j) => setNotes(j.notes ?? []))
      .catch(() => {});
    fetch("/api/checklist")
      .then((r) => r.json())
      .then((j) => setAdded(new Set((j.items ?? []).map((x: { sourceLessonId: string | null }) => x.sourceLessonId).filter(Boolean))));
  }, [episodeId]);

  const pollReview = useCallback(async () => {
    const r = (await fetch(`/api/episodes/${encodeURIComponent(episodeId)}/review`).then((x) => x.json())) as ReviewState;
    setRv(r);
    return r;
  }, [episodeId]);

  useEffect(() => {
    let stop = false;
    const loop = async () => {
      const r = await pollReview();
      if (!stop && r.status === "running") setTimeout(loop, 2500);
    };
    loop();
    return () => {
      stop = true;
    };
  }, [pollReview]);

  const generate = async (force: boolean) => {
    const before = rv;
    setRv({ status: "running", stage: "排队中" });
    // 限流、网络失败都要把原因显示出来，不能一直停在"排队中"
    const started = await fetch(`/api/episodes/${encodeURIComponent(episodeId)}/review${force ? "?force=1" : ""}`, { method: "POST" })
      .then(async (x) => ({ ok: x.ok, body: (await x.json().catch(() => ({}))) as ReviewState }))
      .catch(() => null);
    if (!started || !started.ok || started.body.status === "failed") {
      const error = started?.body.error ?? (started ? "生成失败，请稍后重试" : "网络连接失败，请检查网络后重试");
      setRv(before.review ? before : { status: "failed", error });
      toast.error(error);
      return;
    }
    let misses = 0;
    const loop = async () => {
      const r = await pollReview().catch(() => null);
      // 查询进度时网络断了：后台还在生成，隔一会儿再查，连续失败 5 次才放弃
      if (!r) {
        if (++misses < 5) setTimeout(loop, 5000);
        else setRv({ status: "failed", error: "查询进度时网络连接失败，刷新页面可以看到最新结果" });
        return;
      }
      misses = 0;
      if (r.status === "running") setTimeout(loop, 2500);
      else if (r.status === "done") toast.success("复盘已生成");
      else if (r.status === "failed") toast.error(r.error ?? "生成失败");
    };
    setTimeout(loop, 1500);
  };

  // 导入的数据：打开一个还没有复盘的持仓段时自动开始生成（示例组合已预生成）
  useEffect(() => {
    if (wsLoaded && !isDemo && rv.status === "none" && set && !autoStarted.current) {
      autoStarted.current = true;
      generate(false);
    }
  });

  const episode = rules?.episode ?? set?.episode ?? null;
  const buys = useMemo(() => episode?.trades.filter((t) => t.side === "buy") ?? [], [episode]);
  // 每笔成交都是一个决策点：买入、加仓、卖出都可以"回到当时"
  const points = useMemo(() => episode?.trades ?? [], [episode]);
  const decision = points.find((t) => t.id === decisionId) ?? buys[0];
  // 卖出时对照的是卖出之前已经写下的计划，之后加仓时才写的不算
  const plan = useMemo(() => {
    const p = planAt(buys, decision?.ts ?? 0);
    return p.stop != null || p.target != null ? { planStop: p.stop, planTarget: p.target } : null;
  }, [buys, decision]);
  const pointLabel = (t: (typeof points)[number]) => (t.side === "sell" ? (t.positionAfter > 0 ? "减仓" : "卖出") : t.id === buys[0]?.id ? "买入" : "加仓");
  const evidence = useMemo(() => new Map((set?.items ?? []).map((e) => [e.id, e])), [set]);
  const review = rv.review ?? null;
  const biases = review?.biases ?? rules?.biases ?? [];
  const attribution = review?.attribution ?? rules?.attribution;
  const decisionTs = decision?.ts ?? 0;
  const curtain = mode === "then";

  const chartTrades: ChartTrade[] = useMemo(
    () =>
      (episode?.trades ?? [])
        .filter((t) => !curtain || t.ts <= decisionTs)
        .map((t) => ({ id: t.id, date: fmtDate(t.ts), side: t.side, price: t.price, qty: t.qty, label: `${fmtDateTime(t.ts)} ${t.side === "buy" ? "买入" : "卖出"} ${t.qty} 股 @ ${t.price}` })),
    [episode, curtain, decisionTs],
  );
  const chartEvents: ChartEvent[] = useMemo(
    () =>
      (set?.items ?? [])
        .filter((e) => EVENT_KINDS.has(e.kind) && e.availableAt != null)
        .filter((e) => !curtain || timingOf(e, decisionTs) !== "ex_post")
        .map((e) => ({ id: e.id, date: fmtDate(e.availableAt), title: e.title, kindLabel: KIND_LABEL[e.kind], tone: e.tone })),
    [set, curtain, decisionTs],
  );
  const openById = useCallback((eid: string) => setOpen(evidence.get(eid) ?? null), [evidence]);

  const addLesson = async (l: ReviewDoc["lessons"][number]) => {
    const r = await fetch("/api/checklist", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ text: l.text, trigger: l.trigger, sourceEpisodeId: episodeId, sourceLessonId: l.id }) });
    if (r.ok) {
      setAdded(new Set([...added, l.id]));
      toast.success("已加入我的清单", { description: "下次在「决策前检查」里会逐条对照" });
    } else toast.error("加入失败");
  };

  const savePj = async (verdict: Verdict, worry: string) => {
    if (!decision) return;
    const r = await fetch(`/api/episodes/${encodeURIComponent(episodeId)}/prejudgment`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ tradeId: decision.id, verdict, worry, afterReveal: revealedBefore }),
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) {
      toast.error(j.error ?? "保存失败");
      return;
    }
    setPjs(j.items ?? []);
    reveal();
    window.scrollTo({ top: 0, behavior: "smooth" });
  };

  if (error) {
    return (
      <div className="space-y-3">
        <p className="text-destructive">{error}</p>
        <Link href="/decisions" className="text-exante underline">
          返回我的决策
        </Link>
      </div>
    );
  }
  if (!episode || !set || !attribution || !decision) {
    return (
      <div className="space-y-4" aria-busy>
        <p className="text-sm text-muted-foreground">正在整理行情、事件和规则结果，第一次打开一个持仓段大约需要 20 秒……</p>
        <div className="grid lg:grid-cols-[minmax(0,1fr)_360px] gap-5">
          <div className="panel h-[440px] animate-pulse" />
          <div className="panel h-[440px] animate-pulse" />
        </div>
      </div>
    );
  }

  const aiState =
    rv.status === "running" ? (
      <p className="text-sm text-muted-foreground">正在生成：{rv.stage ?? "排队中"}（大约 30–60 秒）</p>
    ) : rv.status === "failed" ? (
      <div className="text-sm space-y-2">
        <p className="text-destructive">生成失败：{rv.error}</p>
        <p className="text-muted-foreground">规则判定和证据不受影响，仍然可以查看。</p>
        <Button size="sm" onClick={() => generate(true)}>
          重新生成
        </Button>
      </div>
    ) : (
      <div className="text-sm space-y-2">
        <p className="text-muted-foreground">还没有 AI 复盘。规则判定和证据已经可以查看。</p>
        <Button size="sm" onClick={() => generate(false)}>
          生成复盘
        </Button>
      </div>
    );

  return (
    <div className="space-y-5">
      <div className="space-y-4">
        <div className="flex flex-col lg:flex-row lg:items-end gap-5 justify-between">
          <div className="min-w-0">
            <nav aria-label="位置" className="text-xs text-muted-foreground">
              <Link href="/decisions" className="hover:text-foreground hover:underline underline-offset-2">
                我的决策
              </Link>
              <span className="mx-1.5">/</span>
              <span>{episode.name ?? episode.code}</span>
            </nav>
            <div className="flex flex-wrap items-baseline gap-x-4 gap-y-1 mt-2">
              <h1 className="text-[1.75rem] font-semibold tracking-tight">
                {episode.name ?? episode.code} <span className="text-base font-normal text-muted-foreground num">{episode.code}</span>
              </h1>
              {curtain ? (
                <span className="text-xs text-muted-foreground px-2.5 py-1 rounded-full curtain ring-1 ring-border">收益已遮住</span>
              ) : (
                <>
                  <span className={cn("figure text-2xl font-semibold", pctClass(episode.returnPct))}>{pct(episode.returnPct)}</span>
                  {episode.actionsMissing && <span className="text-xs text-expost">除权除息数据没取到，收益可能漏了分红送转</span>}
                </>
              )}
            </div>
            <p className="text-sm text-muted-foreground mt-1 num">
              {/* 回到当时不透露清仓时间和之后的成交，否则就能推出拿了多久、有没有加仓 */}
              {curtain
                ? `${fmtDate(episode.openTs)} 首次买入，这是第 ${points.findIndex((t) => t.id === decision.id) + 1} 个决策点，之后的成交先遮住`
                : `${fmtDate(episode.openTs)} 首次买入，${episode.closeTs ? `${fmtDate(episode.closeTs)} 清仓` : "尚未清仓"}，共 ${episode.trades.length} 笔成交`}
            </p>
          </div>

          <div className="inline-flex self-start lg:self-auto rounded-full bg-muted p-1 ring-1 ring-border" role="group" aria-label="切换视角">
            <button
              onClick={() => setMode("then")}
              aria-pressed={curtain}
              className={cn("px-5 py-2 rounded-full text-sm transition-colors", curtain ? "bg-exante text-on-accent font-medium shadow-sm" : "text-muted-foreground hover:text-foreground")}
            >
              回到当时
            </button>
            <button
              onClick={reveal}
              aria-pressed={!curtain}
              className={cn("px-5 py-2 rounded-full text-sm transition-colors", !curtain ? "bg-expost text-on-accent font-medium shadow-sm" : "text-muted-foreground hover:text-foreground")}
            >
              揭晓结果
            </button>
          </div>
        </div>

        {points.length > 1 && (
          <div className="flex items-start gap-4 overflow-x-auto pb-1" role="group" aria-label="选择决策点">
            <span className="text-xs text-muted-foreground pt-[1px] shrink-0">决策点</span>
            <ol className="flex items-start min-w-max">
              {points.map((t, i) => {
                const on = t.id === decision.id;
                const past = t.ts <= decisionTs;
                return (
                  <li key={t.id} className="flex items-start">
                    <button
                      onClick={() => setDecisionId(t.id)}
                      aria-current={on ? "step" : undefined}
                      className="group flex flex-col items-center gap-1.5 px-2 rounded-md focus-visible:outline-2 focus-visible:outline-ring"
                    >
                      <span
                        className={cn(
                          "size-3 rounded-full ring-2 transition-transform",
                          on ? "bg-exante ring-exante/30 scale-125" : past ? "bg-exante/60 ring-transparent" : curtain ? "bg-card ring-border" : "bg-expost/70 ring-transparent",
                        )}
                      />
                      <span className={cn("text-xs whitespace-nowrap num", on ? "text-exante font-medium" : "text-muted-foreground group-hover:text-foreground")}>
                        {curtain && !past ? `决策点 ${i + 1}` : `${fmtDate(t.ts).slice(5)} ${pointLabel(t)}`}
                      </span>
                    </button>
                    {i < points.length - 1 && <span aria-hidden className={cn("mt-[5px] h-0.5 w-10 sm:w-16 rounded-full", points[i + 1].ts <= decisionTs ? "bg-exante/50" : "bg-border")} />}
                  </li>
                );
              })}
            </ol>
          </div>
        )}
      </div>

      <div className="grid lg:grid-cols-[minmax(0,1fr)_360px] gap-5 items-start">
        <div className="space-y-4 min-w-0">
          <div className="panel p-3 sm:p-4">
            <KlineChart raw={set.series.raw} adj={set.series.adj} trades={chartTrades} events={chartEvents} decisionDate={fmtDate(decisionTs)} cutoffTs={curtain ? decisionTs : null} onEventClick={openById} />
            <p className="px-1 pt-2 text-xs leading-relaxed text-muted-foreground">
              {curtain ? "回到当时：K 线用不复权价格，只画决策前已经收盘的部分（盘中成交的话，当天那根也不画），纵轴也只按这部分定范围。" : "K 线是前复权价格。"}
              三角是成交，圆点是公告、财报、异动等事件，点一下能看出处。
              {/* 回到当时只提决策日之前的除权，否则等于提前透露后面会分红送转 */}
              {curtain
                ? set.episode.corpEvents.some((e) => e.exDate <= fmtDate(decisionTs)) && " 这之前有过除权除息，不复权价格会跳空。"
                : set.episode.corpEvents.length > 0 && " 持仓期间有除权除息，不复权价格会跳空，收益按复权口径计算。"}
            </p>
          </div>

          {curtain ? (
            <>
              <ExAntePanel trade={decision} plan={plan} view={review?.exAnte.find((v) => v.tradeId === decision.id)} biases={biases} evidence={evidence} onOpen={setOpen} aiState={aiState} />
              <LinkedNotes notes={matchNotes(notes, decision)} trade={decision} revealed={false} />
              <PrejudgmentForm
                key={decision.id}
                trade={decision}
                existing={pjs.find((p) => p.tradeId === decision.id)}
                revealedBefore={revealedBefore}
                onSubmit={savePj}
                onSkip={() => {
                  reveal();
                  window.scrollTo({ top: 0, behavior: "smooth" });
                }}
              />
            </>
          ) : (
            <>
              {pjs.find((p) => p.tradeId === decision.id) && (
                <BeforeAfter
                  pj={pjs.find((p) => p.tradeId === decision.id)!}
                  trade={decision}
                  biases={biases}
                  attribution={attribution}
                  view={review?.exAnte.find((v) => v.tradeId === decision.id)}
                  evidence={evidence}
                />
              )}
              <RevealPanel review={review} biases={biases} attribution={attribution} evidence={evidence} decisionTs={decisionTs} onOpen={setOpen} onAddLesson={addLesson} addedLessons={added} aiState={aiState} />
              <LinkedNotes notes={matchNotes(notes, decision)} trade={decision} revealed />
            </>
          )}

          {review && !isDemo && (
            <div className="text-right">
              <Button variant="ghost" size="sm" onClick={() => generate(true)} disabled={rv.status === "running"}>
                重新生成复盘
              </Button>
            </div>
          )}
        </div>

        <aside className="lg:sticky lg:top-20">
          <EvidenceList items={set.items} decisionTs={decisionTs} locked={curtain} onOpen={setOpen} sources={set.sources} />
        </aside>
      </div>

      <EvidenceSheet evidence={open} decisionTs={decisionTs} onClose={() => setOpen(null)} />
    </div>
  );
}
