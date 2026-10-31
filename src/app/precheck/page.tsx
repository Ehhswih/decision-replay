"use client";

import Link from "next/link";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Tag } from "@/components/timing-badge";
import { TRIGGER_TEXT } from "@/lib/labels";
import type { PrecheckResult } from "@/lib/precheck";

const STATUS = {
  triggered: { text: "触发", tone: "danger" },
  clear: { text: "未触发", tone: "ok" },
  manual: { text: "自己对照", tone: "neutral" },
  unknown: { text: "数据不足", tone: "warn" },
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

  const run = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    setRes(null);
    try {
      const r = await fetch("/api/precheck", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ query, side, reason, planStop: stop ? Number(stop) : null, planTarget: target ? Number(target) : null }),
      });
      const j = await r.json();
      if (j.error) setError(j.error);
      else setRes(j);
    } catch {
      setError("检查失败，请检查网络后重试");
    } finally {
      setBusy(false);
    }
  };

  const triggered = res?.checks.filter((c) => c.status === "triggered") ?? [];
  const factById = new Map((res?.facts ?? []).map((f) => [f.id, f]));

  return (
    <div className="grid lg:grid-cols-[380px_minmax(0,1fr)] gap-6 items-start">
      <form onSubmit={run} className="rounded-lg border border-border bg-card p-5 space-y-4 lg:sticky lg:top-4">
        <div>
          <h1 className="text-xl font-semibold">决策前检查</h1>
          <p className="text-sm text-muted-foreground mt-1">下单前，把自己的清单逐条套到这只股票现在的数据上。这里只告诉你哪条检查被触发、依据是什么，不判断能不能买卖。</p>
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="q">股票</Label>
          <Input id="q" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="6 位代码或名称，例如 300750 或 宁德时代" required />
        </div>
        <div className="space-y-1.5">
          <span className="text-sm font-medium">打算</span>
          <div className="grid grid-cols-2 gap-2" role="radiogroup">
            {(["buy", "sell"] as const).map((s) => (
              <button
                type="button"
                key={s}
                role="radio"
                aria-checked={side === s}
                onClick={() => setSide(s)}
                className={`rounded-md border px-3 py-1.5 text-sm ${side === s ? "border-foreground font-medium" : "border-border text-muted-foreground"}`}
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
        <Button type="submit" className="w-full" disabled={busy || !query.trim()}>
          {busy ? "正在取最新行情和公告……" : "开始检查"}
        </Button>
        {error && <p className="text-sm text-destructive">{error}</p>}
      </form>

      <div className="space-y-4 min-w-0">
        {!res && !busy && (
          <div className="rounded-lg border border-dashed border-border bg-card p-8 text-sm text-muted-foreground">
            填好左边再检查。会用到：最近 20 个交易日行情、热股排名、龙虎榜、近 10 天的异动、新闻和公告，以及
            <Link href="/checklist" className="text-exante underline underline-offset-2 mx-1">
              我的清单
            </Link>
            里启用的条目；清单为空时用一组默认检查。
          </div>
        )}
        {busy && <p className="text-sm text-muted-foreground">正在检查，通常需要 5–15 秒……</p>}
        {res && (
          <>
            {res.adviceNotice && <div className="rounded-lg border border-exante/40 bg-exante/8 p-4 text-sm">{res.adviceNotice}</div>}
            <section className="rounded-lg border border-border bg-card p-5">
              <div className="flex flex-wrap items-baseline justify-between gap-2 mb-3">
                <h2 className="text-[15px] font-semibold">
                  {res.name ?? res.code} <span className="text-muted-foreground font-normal num">{res.code}</span>
                </h2>
                <span className="text-xs text-muted-foreground">数据截至 {res.asOf ?? "未知"}，全部是现在已经公开的信息</span>
              </div>
              <p className="text-sm mb-4">
                {res.checks.length} 条检查里有 <span className="font-semibold">{triggered.length}</span> 条被触发
                {!res.checks[0]?.fromChecklist && <span className="text-muted-foreground">（清单为空，用的是默认检查）</span>}。
              </p>
              <ul className="space-y-3">
                {[...res.checks].sort((a, b) => (a.status === "triggered" ? -1 : 0) - (b.status === "triggered" ? -1 : 0)).map((c) => (
                  <li key={c.id} className="text-sm">
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

            {res.related.length > 0 && (
              <section className="rounded-lg border border-border bg-card p-5">
                <h2 className="text-[15px] font-semibold mb-3">你以前复盘过的相关教训</h2>
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

            <section className="rounded-lg border border-border bg-card p-5">
              <h2 className="text-[15px] font-semibold mb-3">现在能看到的事实</h2>
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
      </div>
    </div>
  );
}
