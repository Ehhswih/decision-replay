"use client";

import { useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Tag } from "@/components/timing-badge";
import { fmtDateTime } from "@/lib/labels";
import type { DecisionNote } from "@/lib/records";

const planText = (stop: number | null, target: number | null) => [stop != null ? `止损 ${stop}%` : "", target != null ? `目标 +${target}%` : ""].filter(Boolean).join("，");

/** 决策前检查存下的记录。补充理由会新增版本，原来写的保留不动 */
export function DecisionNotes({ notes, onChange }: { notes: DecisionNote[]; onChange: (notes: DecisionNote[]) => void }) {
  const [editing, setEditing] = useState<string | null>(null);
  const [reason, setReason] = useState("");
  const [stop, setStop] = useState("");
  const [target, setTarget] = useState("");

  if (!notes.length) return null;

  const startEdit = (n: DecisionNote) => {
    const last = n.versions[n.versions.length - 1];
    setEditing(n.rootId);
    setReason(last.reason);
    setStop(last.planStop?.toString() ?? "");
    setTarget(last.planTarget?.toString() ?? "");
  };

  const saveVersion = async (rootId: string) => {
    const r = await fetch(`/api/notes/${encodeURIComponent(rootId)}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ reason, planStop: stop ? Number(stop) : null, planTarget: target ? Number(target) : null }),
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) return toast.error(j.error ?? "保存失败");
    onChange(j.notes ?? []);
    setEditing(null);
    toast.success(`已存为第 ${j.version} 版，原来的版本保留`);
  };

  const purge = async () => {
    if (!window.confirm("删除你保存的全部决策记录和揭晓前写下的判断？删除后不能恢复。")) return;
    const j = await fetch("/api/notes", { method: "DELETE" }).then((x) => x.json());
    onChange([]);
    toast.success(`已删除 ${j.deleted} 条`);
  };

  return (
    <section className="panel p-5">
      <div className="flex flex-wrap items-baseline justify-between gap-2 mb-1">
        <h2 className="text-[15px] font-semibold">我的决策记录</h2>
        <Button variant="ghost" size="sm" className="text-destructive" onClick={purge}>
          删除全部记录
        </Button>
      </div>
      <p className="text-xs text-muted-foreground mb-4">导入成交后，成交前 7 天内保存的同一只股票、同方向的记录，会作为当时的理由出现在复盘的「回到当时」里。补充理由会新增一个版本，原来写的不会被改。</p>
      <ul className="space-y-4">
        {notes.map((n) => {
          const first = n.versions[0];
          const last = n.versions[n.versions.length - 1];
          const triggered = n.snapshot?.checks.filter((c) => c.status === "triggered") ?? [];
          return (
            <li key={n.rootId} className="text-sm border-t border-border pt-3 first:border-t-0 first:pt-0">
              <div className="flex flex-wrap items-center gap-1.5">
                <span className="font-medium">
                  {n.name ?? n.code} <span className="text-muted-foreground font-normal num">{n.code}</span>
                </span>
                <Tag>{n.side === "buy" ? "买入" : "卖出"}</Tag>
                <span className="text-xs text-muted-foreground num">{fmtDateTime(first.createdAt)} 保存</span>
                {n.versions.length > 1 && <Tag tone="info">共 {n.versions.length} 版</Tag>}
              </div>
              <p className="mt-1 leading-relaxed">{last.reason}</p>
              {planText(last.planStop, last.planTarget) && <p className="text-muted-foreground">{planText(last.planStop, last.planTarget)}</p>}
              <p className="text-xs text-muted-foreground mt-1">
                保存时的检查（行情截至 {n.snapshot?.asOf ?? "未知"}）：{triggered.length ? `触发 ${triggered.length} 条：${triggered.map((c) => c.text).join("；")}` : "没有触发的检查"}
              </p>
              {n.versions.length > 1 && (
                <details className="mt-2">
                  <summary className="text-xs text-exante cursor-pointer">查看全部版本</summary>
                  <ol className="mt-2 space-y-2">
                    {n.versions.map((v) => (
                      <li key={v.id} className="border-l-2 border-border pl-3">
                        <p className="text-xs text-muted-foreground num">
                          第 {v.version} 版 · {fmtDateTime(v.createdAt)}
                          {v.version === 1 && " · 原始记录"}
                        </p>
                        <p>{v.reason}</p>
                        {planText(v.planStop, v.planTarget) && <p className="text-muted-foreground">{planText(v.planStop, v.planTarget)}</p>}
                      </li>
                    ))}
                  </ol>
                </details>
              )}
              {editing === n.rootId ? (
                <div className="mt-3 space-y-2">
                  <Textarea value={reason} onChange={(e) => setReason(e.target.value)} rows={3} maxLength={1000} aria-label="补充后的理由" />
                  <div className="grid grid-cols-2 gap-2 max-w-xs">
                    <Input inputMode="decimal" value={stop} onChange={(e) => setStop(e.target.value.replace(/[^\d.]/g, ""))} placeholder="止损 %" aria-label="止损百分比" />
                    <Input inputMode="decimal" value={target} onChange={(e) => setTarget(e.target.value.replace(/[^\d.]/g, ""))} placeholder="目标 %" aria-label="目标百分比" />
                  </div>
                  <div className="flex gap-2">
                    <Button size="sm" onClick={() => saveVersion(n.rootId)} disabled={!reason.trim()}>
                      存为新版本
                    </Button>
                    <Button size="sm" variant="ghost" onClick={() => setEditing(null)}>
                      取消
                    </Button>
                  </div>
                </div>
              ) : (
                <Button size="sm" variant="outline" className="mt-2" onClick={() => startEdit(n)}>
                  补充理由
                </Button>
              )}
            </li>
          );
        })}
      </ul>
    </section>
  );
}
