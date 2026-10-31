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
  const [mode, setMode] = useState<"then" | "reveal">("then");
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
    setRv({ status: "running", stage: "排队中" });
    await fetch(`/api/episodes/${encodeURIComponent(episodeId)}/review${force ? "?force=1" : ""}`, { method: "POST" });
    const loop = async () => {
      const r = await pollReview();
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
  const plan = buys.find((t) => t.planStop != null || t.planTarget != null) ?? null;
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
  if (!episode || !set || !attribution || !decision) return <p className="text-muted-foreground">正在整理行情、事件和规则结果，第一次打开一个持仓段大约需要 20 秒……</p>;

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
      <div className="flex flex-col lg:flex-row lg:items-end gap-4 justify-between">
        <div>
          <Link href="/decisions" className="text-xs text-muted-foreground hover:underline">
            我的决策
          </Link>
          <h1 className="text-2xl font-semibold mt-1">
            {episode.name ?? episode.code} <span className="text-base font-normal text-muted-foreground num">{episode.code}</span>
          </h1>
          <p className="text-sm text-muted-foreground mt-1 num">
            {fmtDate(episode.openTs)} 首次买入，{episode.closeTs ? `${fmtDate(episode.closeTs)} 清仓` : "尚未清仓"}，共 {episode.trades.length} 笔成交
            {curtain ? (
              <span className="ml-2 px-1.5 py-0.5 rounded curtain border border-border">收益已遮住</span>
            ) : (
              <span className={cn("ml-2 font-medium", pctClass(episode.returnPct))}>收益 {pct(episode.returnPct)}</span>
            )}
          </p>
        </div>

        <div className="flex flex-col sm:flex-row gap-3 sm:items-center">
          {points.length > 1 && (
            <div className="flex items-center gap-1 text-xs" role="group" aria-label="选择决策点">
              <span className="text-muted-foreground mr-1">决策点</span>
              {points.map((t) => (
                <button
                  key={t.id}
                  onClick={() => setDecisionId(t.id)}
                  className={cn("px-2 py-1 rounded border num", t.id === decision.id ? "border-exante text-exante bg-exante/8" : "border-border text-muted-foreground hover:bg-muted")}
                >
                  {fmtDate(t.ts).slice(5)} {pointLabel(t)}
                </button>
              ))}
            </div>
          )}
          <div className="inline-flex rounded-lg border border-border bg-card p-1" role="group" aria-label="切换视角">
            <button
              onClick={() => setMode("then")}
              aria-pressed={curtain}
              className={cn("px-4 py-1.5 rounded-md text-sm transition-colors", curtain ? "bg-exante text-white" : "text-muted-foreground hover:bg-muted")}
            >
              回到当时
            </button>
            <button
              onClick={reveal}
              aria-pressed={!curtain}
              className={cn("px-4 py-1.5 rounded-md text-sm transition-colors", !curtain ? "bg-expost text-white" : "text-muted-foreground hover:bg-muted")}
            >
              揭晓结果
            </button>
          </div>
        </div>
      </div>

      <div className="grid lg:grid-cols-[minmax(0,1fr)_360px] gap-5 items-start">
        <div className="space-y-4 min-w-0">
          <div className="rounded-lg border border-border bg-card p-3">
            <KlineChart raw={set.series.raw} adj={set.series.adj} trades={chartTrades} events={chartEvents} decisionDate={fmtDate(decisionTs)} cutoffTs={curtain ? decisionTs : null} onEventClick={openById} />
            <p className="px-2 pt-1 text-xs text-muted-foreground">
              {curtain ? "回到当时：K 线用不复权价格，只画决策时已经收盘的部分（盘中成交时当天那根也不画），纵轴也只按这部分数据定范围。" : "K 线为前复权。"}
              三角是成交，圆点是公告、财报、异动等事件（点击查看出处）。
              {set.episode.corpEvents.length > 0 && " 持仓期间有除权除息，不复权价格会跳空，收益按复权口径计算。"}
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

        <aside className="lg:sticky lg:top-4">
          <EvidenceList items={set.items} decisionTs={decisionTs} locked={curtain} onOpen={setOpen} sources={set.sources} />
        </aside>
      </div>

      <EvidenceSheet evidence={open} decisionTs={decisionTs} onClose={() => setOpen(null)} />
    </div>
  );
}
