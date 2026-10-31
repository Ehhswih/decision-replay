import "server-only";
import { randomUUID } from "node:crypto";
import { db } from "@/lib/db";

// 用户自己留下的记录：揭晓前的判断、决策前检查存下的决策记录。
// 两者都按访客保存（和清单一样，看示例组合的人也能留），写下之后不改原文：
// 判断不能修改，决策记录补充理由时新增版本。

export type Verdict = "sufficient" | "gaps" | "insufficient";
export const VERDICTS: Verdict[] = ["sufficient", "gaps", "insufficient"];

export interface Prejudgment {
  tradeId: string;
  verdict: Verdict;
  worry: string | null;
  /** 写下之前已经打开过揭晓视图：参考价值有限 */
  afterReveal: boolean;
  createdAt: number;
}

type PjRow = { trade_id: string; verdict: string; worry: string | null; after_reveal: number; created_at: number };

export function listPrejudgments(visitor: string, workspace: string, episodeId: string): Prejudgment[] {
  const rows = db()
    .prepare("SELECT trade_id, verdict, worry, after_reveal, created_at FROM prejudgments WHERE visitor = ? AND workspace = ? AND episode_id = ?")
    .all(visitor, workspace, episodeId) as PjRow[];
  return rows.map((r) => ({ tradeId: r.trade_id, verdict: r.verdict as Verdict, worry: r.worry, afterReveal: !!r.after_reveal, createdAt: r.created_at }));
}

/** 每笔成交只能写一次；已经写过时返回 false */
export function addPrejudgment(visitor: string, workspace: string, episodeId: string, p: { tradeId: string; verdict: Verdict; worry: string | null; afterReveal: boolean }): boolean {
  const r = db()
    .prepare("INSERT OR IGNORE INTO prejudgments (visitor, workspace, episode_id, trade_id, verdict, worry, after_reveal, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
    .run(visitor, workspace, episodeId, p.tradeId, p.verdict, p.worry?.slice(0, 200) || null, p.afterReveal ? 1 : 0, Date.now());
  return Number(r.changes) > 0;
}

export interface NoteSnapshot {
  asOf: string | null;
  checks: { text: string; status: string; detail: string }[];
  facts: { title: string; source: string; time: string }[];
  sourceErrors: string[];
}

export interface NoteVersion {
  id: string;
  version: number;
  reason: string;
  planStop: number | null;
  planTarget: number | null;
  createdAt: number;
}

export interface DecisionNote {
  rootId: string;
  code: string;
  name: string | null;
  side: "buy" | "sell";
  /** 第一版保存时的检查结果和事实，之后的版本只补充理由和计划 */
  snapshot: NoteSnapshot | null;
  versions: NoteVersion[];
}

type NoteRow = {
  id: string;
  root_id: string;
  version: number;
  code: string;
  name: string | null;
  side: string;
  reason: string;
  plan_stop: number | null;
  plan_target: number | null;
  snapshot: string | null;
  created_at: number;
};

export function listNotes(visitor: string): DecisionNote[] {
  const rows = db().prepare("SELECT * FROM decision_notes WHERE visitor = ? ORDER BY created_at DESC LIMIT 500").all(visitor) as NoteRow[];
  const byRoot = new Map<string, DecisionNote>();
  for (const r of [...rows].reverse()) {
    let n = byRoot.get(r.root_id);
    if (!n) {
      n = { rootId: r.root_id, code: r.code, name: r.name, side: r.side === "sell" ? "sell" : "buy", snapshot: null, versions: [] };
      byRoot.set(r.root_id, n);
    }
    if (r.version === 1 && r.snapshot) n.snapshot = JSON.parse(r.snapshot) as NoteSnapshot;
    n.versions.push({ id: r.id, version: r.version, reason: r.reason, planStop: r.plan_stop, planTarget: r.plan_target, createdAt: r.created_at });
  }
  // 最近有改动的排在前面
  return [...byRoot.values()].sort((a, b) => b.versions[b.versions.length - 1].createdAt - a.versions[a.versions.length - 1].createdAt);
}

const MAX_NOTES = 200;

export function addNote(
  visitor: string,
  n: { code: string; name: string | null; side: "buy" | "sell"; reason: string; planStop: number | null; planTarget: number | null; snapshot: NoteSnapshot },
): string | null {
  const count = (db().prepare("SELECT COUNT(DISTINCT root_id) AS c FROM decision_notes WHERE visitor = ?").get(visitor) as { c: number }).c;
  if (count >= MAX_NOTES) return null;
  const id = randomUUID().slice(0, 12);
  db()
    .prepare("INSERT INTO decision_notes (id, root_id, version, visitor, code, name, side, reason, plan_stop, plan_target, snapshot, created_at) VALUES (?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
    .run(id, id, visitor, n.code, n.name, n.side, n.reason.slice(0, 1000), n.planStop, n.planTarget, JSON.stringify(n.snapshot), Date.now());
  return id;
}

/** 补充理由：新增一个版本，原来的版本原样保留 */
export function addNoteVersion(visitor: string, rootId: string, v: { reason: string; planStop: number | null; planTarget: number | null }): number | null {
  const last = db().prepare("SELECT * FROM decision_notes WHERE visitor = ? AND root_id = ? ORDER BY version DESC LIMIT 1").get(visitor, rootId) as NoteRow | undefined;
  if (!last || last.version >= 20) return null;
  db()
    .prepare("INSERT INTO decision_notes (id, root_id, version, visitor, code, name, side, reason, plan_stop, plan_target, snapshot, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?)")
    .run(randomUUID().slice(0, 12), rootId, last.version + 1, visitor, last.code, last.name, last.side, v.reason.slice(0, 1000), v.planStop, v.planTarget, Date.now());
  return last.version + 1;
}

/** 删除这个访客留下的所有判断和决策记录 */
export function purgeVisitorRecords(visitor: string): number {
  const a = db().prepare("DELETE FROM prejudgments WHERE visitor = ?").run(visitor).changes;
  const b = db().prepare("DELETE FROM decision_notes WHERE visitor = ?").run(visitor).changes;
  return Number(a) + Number(b);
}
