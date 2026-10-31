"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Tag } from "@/components/timing-badge";
import { DecisionNotes } from "@/components/decision-notes";
import { TRIGGER_TEXT } from "@/lib/labels";
import type { PrecheckResult } from "@/lib/precheck";
import type { DecisionNote } from "@/lib/records";

const BAR = { triggered: "border-destructive/60", clear: "border-down/50", manual: "border-border", unknown: "border-expost/60", na: "border-border" } as const;

const STATUS = {
  triggered: { text: "触发", tone: "danger" },
  clear: { text: "未触发", tone: "ok" },
  manual: { text: "自己对照", tone: "neutral" },
  unknown: { text: "无法判断", tone: "warn" },
  na: { text: "不适用", tone: "neutral" },
} as const;

export default function PrecheckPage() {
  const [query, setQuery] = useState("");
  const [side, setSide] = useState<"buy" | "sell">("buy");
  const [reason, setReason] = useState("");
  const [stop, setStop] = useState("");
  const [target, setTarget] = useState("");
  const [busy, setBusy] = useState(false);
  const [res, setRes] = useState<PrecheckResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  // 检查时填的内容：保存记录时用它，而不是之后又改过的表单
  const [ran, setRan] = useState<{ side: "buy" | "sell"; reason: string; planStop: number | null; planTarget: number | null } | null>(null);
  const [saved, setSaved] = useState(false);
  const [notes, setNotes] = useState<DecisionNote[]>([]);
  const [prejudgments, setPrejudgments] = useState(0);

  useEffect(() => {
    fetch("/api/notes")
      .then((r) => r.json())
      .then((j) => {
        setNotes(j.notes ?? []);
        setPrejudgments(j.prejudgments ?? 0);
      })
      .catch(() => {});
  }, []);

  const run = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    setRes(null);
    setSaved(false);
    const input = { side, reason: reason.trim(), planStop: stop ? Number(stop) : null, planTarget: target ? Number(target) : null };
    try {
      const r = await fetch("/api/precheck", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ query, ...input }),
      });
      const j = await r.json();
      if (j.error) setError(j.error);
      else {
        setRes(j);
        setRan(input);
      }
    } catch {
      setError("检查失败，请检查网络后重试");
    } finally {
      setBusy(false);
    }
  };

  const saveNote = async () => {
    if (!res || !ran) return;
    const r = await fetch("/api/notes", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        code: res.code,
        name: res.name,
        ...ran,
        snapshot: {
          asOf: res.asOf,
          checks: res.checks.map((c) => ({ text: c.text, status: c.status, detail: c.detail })),
          facts: res.facts.map((f) => ({ title: f.title, source: f.source, time: f.time })),
          sourceErrors: res.sourceErrors,
        },
      }),
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) return toast.error(j.error ?? "保存失败");
    setNotes(j.notes ?? []);
    setSaved(true);
    toast.success("已保存为决策记录");
  };

  const triggered = res?.checks.filter((c) => c.status === "triggered") ?? [];
  const factById = new Map((res?.facts ?? []).map((f) => [f.id, f]));

  return (
    <div className="grid lg:grid-cols-[380px_minmax(0,1fr)] gap-6 items-start">
      <form onSubmit={run} className="panel p-5 space-y-4 lg:sticky lg:top-20">
        <div>
          <h1 className="text-[1.5rem] font-semibold tracking-tight">决策前检查</h1>
          <p className="text-sm text-muted-foreground mt-1">下单前，把自己的清单逐条套到这只股票现在的数据上。这里只告诉你哪条检查被触发、依据是什么，不判断能不能买卖。</p>
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="q">股票</Label>
          <Input id="q" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="6 位代码或名称，例如 300750 或 宁德时代" required />
        </div>
        <div className="space-y-1.5">
          <span className="text-sm font-medium">打算</span>
          <div className="grid grid-cols-2 gap-1 p-1 rounded-lg bg-muted" role="radiogroup" aria-label="打算买入还是卖出">
            {(["buy", "sell"] as const).map((s) => (
              <button
                type="button"
                key={s}
                role="radio"
                aria-checked={side === s}
                onClick={() => setSide(s)}
                className={`rounded-md px-3 py-1.5 text-sm transition-colors ${side === s ? "bg-card shadow-sm font-medium" : "text-muted-foreground hover:text-foreground"}`}
              >
                {s === "buy" ? "买入" : "卖出"}
              </button>
            ))}
          </div>
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="reason">理由</Label>
          <Textarea id="reason" value={reason} onChange={(e) => setReason(e.target.value)} rows={3} placeholder="写下你为什么想做这笔交易" />
        </div>
        <div className="grid grid-cols-2 gap-3">
          <div className="space-y-1.5">
            <Label htmlFor="stop">止损（%）</Label>
            <Input id="stop" inputMode="decimal" value={stop} onChange={(e) => setStop(e.target.value.replace(/[^\d.]/g, ""))} placeholder="例如 8" />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="target">目标（%）</Label>
            <Input id="target" inputMode="decimal" value={target} onChange={(e) => setTarget(e.target.value.replace(/[^\d.]/g, ""))} placeholder="例如 15" />
          </div>
        </div>
        <Button type="submit" className="w-full h-10 rounded-full" disabled={busy || !query.trim()}>
          {busy ? "正在取最新行情和公告……" : "开始检查"}
        </Button>
        {error && <p className="text-sm text-destructive">{error}</p>}
      </form>

      <div className="space-y-4 min-w-0">
        {!res && !busy && (
          <div className="rounded-xl border border-dashed border-border bg-card/60 p-8 text-sm leading-relaxed text-muted-foreground">
            填好股票和打算，点「开始检查」。会用到最近 20 个交易日的行情、热股排名、龙虎榜，近 10 天的异动、新闻和公告，以及
            <Link href="/checklist" className="text-exante underline underline-offset-2 mx-1">
              我的清单
            </Link>
            里启用的条目；清单为空时用一组默认检查。
          </div>
        )}
        {busy && <p className="text-sm text-muted-foreground">正在检查，通常需要 5–15 秒……</p>}
        {res && (
          <>
            {res.adviceNotice && <div className="rounded-xl bg-exante/8 ring-1 ring-inset ring-exante/25 p-4 text-sm">{res.adviceNotice}</div>}
            <section className="panel p-5">
              <div className="flex flex-wrap items-baseline justify-between gap-2 mb-3">
                <h2 className="text-lg font-semibold tracking-tight">
                  {res.name ?? res.code} <span className="text-sm text-muted-foreground font-normal num">{res.code}</span>
                </h2>
                <span className="text-xs text-muted-foreground">数据截至 {res.asOf ?? "未知"}，全部是现在已经公开的信息</span>
              </div>
              <p className="text-sm mb-4">
                {res.checks.length} 条检查里有 <span className="figure text-lg font-semibold">{triggered.length}</span> 条被触发
                {!res.checks[0]?.fromChecklist && <span className="text-muted-foreground">（清单为空，用的是默认检查）</span>}。
              </p>
              <ul className="space-y-3">
                {[...res.checks].sort((a, b) => (a.status === "triggered" ? -1 : 0) - (b.status === "triggered" ? -1 : 0)).map((c) => (
                  <li key={c.id} className={`text-sm border-l-2 pl-3.5 ${BAR[c.status]}`}>
                    <div className="flex flex-wrap items-center gap-1.5">
                      <Tag tone={STATUS[c.status].tone}>{STATUS[c.status].text}</Tag>
                      <Tag>{TRIGGER_TEXT[c.trigger]}</Tag>
                      <span>{c.text}</span>
                    </div>
                    <p className="text-muted-foreground mt-1 pl-1">{c.detail}</p>
                    {c.factIds.filter((id) => factById.has(id)).length > 0 && (
                      <ul className="mt-1 pl-1 space-y-0.5 text-xs text-muted-foreground">
                        {c.factIds
                          .map((id) => factById.get(id))
                          .filter((f): f is NonNullable<typeof f> => !!f)
                          .slice(0, 5)
                          .map((f) => (
                            <li key={f.id}>
                              {f.time} {f.title}（{f.source}）
                            </li>
                          ))}
                      </ul>
                    )}
                  </li>
                ))}
              </ul>
            </section>

            <section className="panel p-5 flex flex-col sm:flex-row sm:items-center gap-3 justify-between">
              <p className="text-sm text-muted-foreground">
                {ran?.reason ? "把这次的理由、计划和上面的检查结果原样存下来，之后复盘时可以对照当时是怎么想的。" : "这次检查没有写理由。写上理由再检查一次，才能存为决策记录。"}
              </p>
              <Button size="sm" variant={saved ? "outline" : "default"} onClick={saveNote} disabled={saved || !ran?.reason}>
                {saved ? "已保存" : "保存为决策记录"}
              </Button>
            </section>

            {res.related.length > 0 && (
              <section className="panel p-5">
                <h2 className="text-[15px] font-semibold tracking-tight mb-3">你以前复盘过的相关教训</h2>
                <ul className="space-y-2 text-sm">
                  {res.related.map((r, i) => (
                    <li key={i}>
                      <Tag className="mr-1.5">{TRIGGER_TEXT[r.trigger] ?? r.trigger}</Tag>
                      {r.text}
                      <Link href={`/decisions/${encodeURIComponent(r.episodeId)}`} className="text-xs text-exante ml-2 hover:underline">
                        {r.episodeName} {r.date}
                      </Link>
                    </li>
                  ))}
                </ul>
              </section>
            )}

            <section className="panel p-5">
              <h2 className="text-[15px] font-semibold tracking-tight mb-3">现在能看到的事实</h2>
              {res.facts.length ? (
                <ul className="space-y-1.5 text-sm">
                  {res.facts.map((f) => (
                    <li key={f.id} className="flex flex-wrap gap-x-2">
                      <span className="text-muted-foreground num">{f.time}</span>
                      <span className={f.tone === "negative" ? "text-down" : ""}>{f.title}</span>
                      <span className="text-xs text-muted-foreground">{f.source}</span>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="text-sm text-muted-foreground">没有取到数据。</p>
              )}
              {res.sourceErrors.length > 0 && (
                <ul className="mt-3 text-xs text-expost space-y-0.5">
                  {res.sourceErrors.map((e, i) => (
                    <li key={i}>{e}</li>
                  ))}
                </ul>
              )}
            </section>
          </>
        )}
        <DecisionNotes
          notes={notes}
          prejudgments={prejudgments}
          onChange={(n) => {
            setNotes(n);
            if (!n.length) setPrejudgments(0);
          }}
        />
      </div>
    </div>
  );
}
