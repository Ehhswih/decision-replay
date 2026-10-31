"use client";

import { useMemo, useState } from "react";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import { Tag } from "@/components/timing-badge";
import { KIND_LABEL, STATUS_TEXT, TIMING_TEXT, fmtDate, timingOf, type TimingKey } from "@/lib/labels";
import { cn } from "@/lib/utils";
import type { Evidence } from "@/lib/domain/evidence";
import type { SourceStatus } from "@/lib/pipeline";

const KINDS = ["computed", "trade", "financial", "notice", "anomaly", "news", "hot_rank", "dragon_tiger", "corporate_action", "industry"];

export function EvidenceList({
  items,
  decisionTs,
  locked,
  onOpen,
  sources,
}: {
  items: Evidence[];
  decisionTs: number;
  /** 回到当时模式下，"事后才知"一栏锁住 */
  locked: boolean;
  onOpen: (e: Evidence) => void;
  sources: SourceStatus[];
}) {
  const [tab, setTab] = useState<TimingKey>("ex_ante");
  const [kind, setKind] = useState<string | null>(null);
  const [importantOnly, setImportantOnly] = useState(true);

  const grouped = useMemo(() => {
    const g: Record<TimingKey, Evidence[]> = { ex_ante: [], ex_post: [], uncertain: [] };
    for (const e of items) g[timingOf(e, decisionTs)].push(e);
    for (const k of Object.keys(g) as TimingKey[]) g[k].sort((a, b) => (b.availableAt ?? 0) - (a.availableAt ?? 0));
    return g;
  }, [items, decisionTs]);

  const visible = grouped[tab].filter((e) => (!kind || e.kind === kind) && (!importantOnly || e.kind !== "news" || e.important));
  const failing = sources.filter((s) => s.status !== "ok" || s.note);

  return (
    <div className="panel flex flex-col max-h-[calc(100vh-7rem)] overflow-hidden">
      <div className="p-3 border-b border-border space-y-3">
        <div className="grid grid-cols-3 gap-1 p-1 rounded-lg bg-muted text-[13px]" role="tablist" aria-label="按时点筛选证据">
          {(Object.keys(TIMING_TEXT) as TimingKey[]).map((k) => (
            <button
              key={k}
              role="tab"
              aria-selected={tab === k}
              onClick={() => setTab(k)}
              className={cn(
                "rounded-md px-2 py-1.5 transition-colors focus-visible:outline-2 focus-visible:outline-ring",
                tab === k
                  ? cn("bg-card shadow-sm font-medium", k === "ex_ante" ? "text-exante" : k === "ex_post" ? "text-expost" : "text-foreground")
                  : "text-muted-foreground hover:text-foreground",
              )}
            >
              {TIMING_TEXT[k]} {!(k === "ex_post" && locked) && <span className="num text-xs opacity-80">{grouped[k].length}</span>}
            </button>
          ))}
        </div>
        <div className="flex flex-wrap gap-1">
          <button onClick={() => setKind(null)} className={cn("text-[11px] px-2 py-0.5 rounded-full ring-1 ring-inset transition-colors", !kind ? "bg-primary text-primary-foreground ring-primary" : "ring-border text-muted-foreground hover:text-foreground")}>
            全部
          </button>
          {KINDS.filter((k) => grouped[tab].some((e) => e.kind === k)).map((k) => (
            <button key={k} onClick={() => setKind(kind === k ? null : k)} className={cn("text-[11px] px-2 py-0.5 rounded-full ring-1 ring-inset transition-colors", kind === k ? "bg-primary text-primary-foreground ring-primary" : "ring-border text-muted-foreground hover:text-foreground")}>
              {KIND_LABEL[k]}
            </button>
          ))}
        </div>
        <div className="flex items-center gap-2">
          <Switch id="important" checked={importantOnly} onCheckedChange={setImportantOnly} />
          <Label htmlFor="important" className="text-xs text-muted-foreground font-normal">
            新闻只看重要的（研报、业绩、公告类标题）
          </Label>
        </div>
      </div>

      <div className="relative flex-1 overflow-y-auto">
        {tab === "ex_post" && locked ? (
          <div className="curtain h-full min-h-48 flex items-center justify-center p-6 text-center text-sm text-muted-foreground">
            这里是决策之后才出现的信息，条数也先不显示。
            <br />
            点上方「揭晓结果」再看。
          </div>
        ) : visible.length ? (
          <ul className="divide-y divide-border">
            {visible.slice(0, 200).map((e) => (
              <li key={e.id}>
                <button type="button" onClick={() => onOpen(e)} className="w-full text-left px-3.5 py-2.5 hover:bg-muted/60 focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring">
                  <div className="flex items-center gap-1.5 mb-1 text-[11px] text-muted-foreground">
                    <span className="num">{e.availableAt ? fmtDate(e.availableAt) : "时间未知"}</span>
                    <Tag>{KIND_LABEL[e.kind] ?? e.kind}</Tag>
                    {e.status !== "ok" && <Tag tone="warn">{STATUS_TEXT[e.status]}</Tag>}
                    {e.thirdPartyAi && <Tag tone="warn">AI 摘要</Tag>}
                    {e.tone === "negative" && <span className="text-down ml-auto">负面</span>}
                  </div>
                  <div className="text-[13px] leading-snug line-clamp-2">{e.title}</div>
                </button>
              </li>
            ))}
            {visible.length > 200 && <li className="px-3 py-2 text-xs text-muted-foreground">还有 {visible.length - 200} 条，用上面的类型筛选缩小范围</li>}
          </ul>
        ) : (
          <p className="p-4 text-sm text-muted-foreground">这一栏没有符合筛选条件的证据。</p>
        )}
      </div>

      {failing.length > 0 && (
        <details className="border-t border-border p-3 text-xs">
          <summary className="cursor-pointer text-muted-foreground">数据源提示 {failing.length} 条</summary>
          <ul className="mt-2 space-y-1.5">
            {failing.map((s) => (
              <li key={s.key}>
                <span className={s.status === "failed" ? "text-destructive" : "text-expost"}>{s.label}：{STATUS_TEXT[s.status] ?? s.status}</span>
                {s.note && <span className="text-muted-foreground">。{s.note}</span>}
                {s.error && <span className="text-muted-foreground">（{s.error.message}）</span>}
              </li>
            ))}
          </ul>
        </details>
      )}
    </div>
  );
}
