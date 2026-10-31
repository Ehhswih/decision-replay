import "server-only";
import { cookies } from "next/headers";
import { randomUUID } from "node:crypto";
import { db } from "@/lib/db";
import type { LessonTrigger } from "@/lib/ai/review";

export const VISITOR_COOKIE = "dr_vid";

export interface ChecklistItem {
  id: string;
  text: string;
  trigger: LessonTrigger;
  sourceEpisodeId: string | null;
  sourceLessonId: string | null;
  enabled: boolean;
  createdAt: number;
}

/** 清单属于访客而不是工作区：看示例组合的人也能存自己的清单 */
export async function visitorId(create: boolean): Promise<string | null> {
  const jar = await cookies();
  const v = jar.get(VISITOR_COOKIE)?.value;
  if (v && /^[a-z0-9-]{8,40}$/.test(v)) return v;
  if (!create) return null;
  const id = randomUUID();
  jar.set(VISITOR_COOKIE, id, { httpOnly: true, sameSite: "lax", maxAge: 60 * 60 * 24 * 180, path: "/" });
  return id;
}

type Row = { id: string; text: string; rule: string | null; source_episode_id: string | null; source_lesson_id: string | null; enabled: number; created_at: number };

export function listItems(visitor: string): ChecklistItem[] {
  const rows = db().prepare("SELECT * FROM checklist WHERE workspace = ? ORDER BY created_at DESC").all(visitor) as Row[];
  return rows.map((r) => ({
    id: r.id,
    text: r.text,
    trigger: (r.rule ? JSON.parse(r.rule).trigger : "other") as LessonTrigger,
    sourceEpisodeId: r.source_episode_id,
    sourceLessonId: r.source_lesson_id,
    enabled: !!r.enabled,
    createdAt: r.created_at,
  }));
}

export function addItem(visitor: string, item: { text: string; trigger: LessonTrigger; sourceEpisodeId?: string | null; sourceLessonId?: string | null }) {
  if (item.sourceLessonId) {
    const dup = db().prepare("SELECT id FROM checklist WHERE workspace = ? AND source_lesson_id = ?").get(visitor, item.sourceLessonId) as { id: string } | undefined;
    if (dup) return dup.id;
  }
  const id = randomUUID().slice(0, 12);
  db()
    .prepare("INSERT INTO checklist (id, workspace, text, source_episode_id, source_lesson_id, rule, enabled, created_at) VALUES (?, ?, ?, ?, ?, ?, 1, ?)")
    .run(id, visitor, item.text.slice(0, 300), item.sourceEpisodeId ?? null, item.sourceLessonId ?? null, JSON.stringify({ trigger: item.trigger }), Date.now());
  return id;
}

export function updateItem(visitor: string, id: string, patch: { text?: string; enabled?: boolean }) {
  if (patch.text != null) db().prepare("UPDATE checklist SET text = ? WHERE id = ? AND workspace = ?").run(patch.text.slice(0, 300), id, visitor);
  if (patch.enabled != null) db().prepare("UPDATE checklist SET enabled = ? WHERE id = ? AND workspace = ?").run(patch.enabled ? 1 : 0, id, visitor);
}

export function deleteItem(visitor: string, id: string) {
  db().prepare("DELETE FROM checklist WHERE id = ? AND workspace = ?").run(id, visitor);
}
