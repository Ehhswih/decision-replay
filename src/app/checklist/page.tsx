"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { Tag } from "@/components/timing-badge";
import { TRIGGER_TEXT, fmtDate } from "@/lib/labels";
import type { ChecklistItem } from "@/lib/checklist";

export default function ChecklistPage() {
  const [items, setItems] = useState<ChecklistItem[] | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [newText, setNewText] = useState("");

  useEffect(() => {
    fetch("/api/checklist")
      .then((r) => r.json())
      .then((j) => setItems(j.items ?? []));
  }, []);

  const patch = async (id: string, body: object) => {
    const r = await fetch(`/api/checklist/${id}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    const j = await r.json();
    if (j.items) setItems(j.items);
  };
  const remove = async (id: string) => {
    const r = await fetch(`/api/checklist/${id}`, { method: "DELETE" });
    const j = await r.json();
    if (j.items) {
      setItems(j.items);
      toast("已删除这一条");
    }
  };
  const add = async () => {
    if (!newText.trim()) return;
    const r = await fetch("/api/checklist", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ text: newText, trigger: "other" }) });
    const j = await r.json();
    if (j.items) {
      setItems(j.items);
      setNewText("");
    }
  };

  return (
    <div className="space-y-6 max-w-3xl">
      <div>
        <h1 className="text-[1.75rem] font-semibold tracking-tight">我的清单</h1>
        <p className="text-sm text-muted-foreground mt-1">
          从复盘里带出来的检查动作。启用的条目会在「决策前检查」里逐条套到你要交易的股票上；带类型的条目（追涨、追热点等）能自动核对数据，其余需要你自己对照。
        </p>
      </div>

      {items === null ? (
        <p className="text-muted-foreground">正在读取……</p>
      ) : items.length === 0 ? (
        <div className="rounded-xl border border-dashed border-border bg-card p-8 text-center text-sm">
          <p className="text-muted-foreground mb-3">清单还是空的。打开一笔复盘，在「下次可以做什么」里把认可的教训加进来。</p>
          <Link href="/decisions" className="text-exante underline underline-offset-2">
            去我的决策
          </Link>
        </div>
      ) : (
        <ul className="panel divide-y divide-border">
          {items.map((it) => (
            <li key={it.id} className="p-4 flex gap-4 items-start">
              <Switch checked={it.enabled} onCheckedChange={(v) => patch(it.id, { enabled: v })} aria-label={it.enabled ? "停用这一条" : "启用这一条"} className="mt-0.5" />
              <div className="flex-1 min-w-0 space-y-1.5">
                {editing === it.id ? (
                  <div className="space-y-2">
                    <Textarea value={draft} onChange={(e) => setDraft(e.target.value)} rows={3} autoFocus />
                    <div className="flex gap-2">
                      <Button
                        size="sm"
                        onClick={async () => {
                          await patch(it.id, { text: draft });
                          setEditing(null);
                        }}
                      >
                        保存
                      </Button>
                      <Button size="sm" variant="ghost" onClick={() => setEditing(null)}>
                        取消
                      </Button>
                    </div>
                  </div>
                ) : (
                  <p className={`text-sm leading-relaxed ${it.enabled ? "" : "text-muted-foreground line-through"}`}>{it.text}</p>
                )}
                <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                  <Tag>{TRIGGER_TEXT[it.trigger]}</Tag>
                  <span>加入于 {fmtDate(it.createdAt)}</span>
                  {it.sourceEpisodeId && (
                    <Link href={`/decisions/${encodeURIComponent(it.sourceEpisodeId)}`} className="text-exante hover:underline">
                      来自这次复盘
                    </Link>
                  )}
                </div>
              </div>
              {editing !== it.id && (
                <div className="flex gap-1 shrink-0">
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => {
                      setEditing(it.id);
                      setDraft(it.text);
                    }}
                  >
                    编辑
                  </Button>
                  <Button size="sm" variant="ghost" className="text-destructive" onClick={() => remove(it.id)}>
                    删除
                  </Button>
                </div>
              )}
            </li>
          ))}
        </ul>
      )}

      <div className="panel p-4 space-y-2">
        <label htmlFor="new-item" className="text-sm font-medium">
          自己写一条
        </label>
        <Textarea id="new-item" value={newText} onChange={(e) => setNewText(e.target.value)} rows={2} placeholder="例如：财报发布前一周不新开仓" />
        <Button size="sm" onClick={add} disabled={!newText.trim()}>
          加入清单
        </Button>
      </div>
    </div>
  );
}
