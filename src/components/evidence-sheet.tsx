"use client";

import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { TimingBadge, Tag } from "@/components/timing-badge";
import { KIND_LABEL, STATUS_TEXT, fmtDateTime, timingOf } from "@/lib/labels";
import type { Evidence } from "@/lib/domain/evidence";

export function EvidenceSheet({ evidence, decisionTs, onClose }: { evidence: Evidence | null; decisionTs: number; onClose: () => void }) {
  const e = evidence;
  // 链接来自外部数据，只允许 http/https
  const url = e?.url && /^https?:\/\//i.test(e.url) ? e.url : null;
  return (
    <Sheet open={!!e} onOpenChange={(o) => !o && onClose()}>
      <SheetContent className="w-full sm:max-w-lg overflow-y-auto">
        {e && (
          <>
            <SheetHeader>
              <div className="flex flex-wrap gap-1.5">
                <Tag>{KIND_LABEL[e.kind] ?? e.kind}</Tag>
                <TimingBadge timing={timingOf(e, decisionTs)} />
                {e.status !== "ok" && <Tag tone="warn">{STATUS_TEXT[e.status] ?? e.status}</Tag>}
                {e.thirdPartyAi && <Tag tone="warn">数据商 AI 生成</Tag>}
              </div>
              <SheetTitle className="text-base leading-snug">{e.title}</SheetTitle>
              <SheetDescription className="sr-only">证据详情</SheetDescription>
            </SheetHeader>
            <div className="px-4 pb-6 space-y-4 text-sm">
              {e.detail && <p className="leading-relaxed whitespace-pre-wrap">{e.detail}</p>}
              <dl className="grid grid-cols-[6.5rem_1fr] gap-x-3 gap-y-2 text-[13px]">
                <Row k="来源" v={e.source} />
                {e.endpoint && <Row k="接口" v={<code className="text-xs break-all">{e.endpoint}</code>} />}
                {e.field && <Row k="字段" v={<code className="text-xs break-all">{e.field}</code>} />}
                {e.value != null && <Row k="数值" v={<span className="num">{e.value} {e.unit ?? ""}</span>} />}
                {e.caliber && <Row k="口径" v={e.caliber} />}
                <Row k="事件时间" v={fmtDateTime(e.eventTime)} />
                <Row
                  k="可知时间"
                  v={
                    e.nonPit ? "非时点数据（只有当前值）" : e.availableAt == null ? "未知" : `${fmtDateTime(e.availableAt)}${e.precision === "day" ? "（只精确到日期）" : ""}`
                  }
                />
                <Row k="决策时刻" v={fmtDateTime(decisionTs)} />
                {e.fetchedAt && <Row k="抓取时间" v={fmtDateTime(e.fetchedAt)} />}
                {e.inputs?.length ? <Row k="计算用到" v={<span className="text-xs break-all">{e.inputs.join("，")}</span>} /> : null}
              </dl>
              {url && (
                <a href={url} target="_blank" rel="noreferrer noopener" className="inline-block text-exante underline underline-offset-2 text-[13px]">
                  查看原文
                </a>
              )}
            </div>
          </>
        )}
      </SheetContent>
    </Sheet>
  );
}

function Row({ k, v }: { k: string; v: React.ReactNode }) {
  return (
    <>
      <dt className="text-muted-foreground">{k}</dt>
      <dd>{v}</dd>
    </>
  );
}
