import { connection } from "next/server";
import { visitorId } from "@/lib/checklist";
import { normalizeCode } from "@/lib/domain/trades";
import { addNote, countPrejudgments, listNotes, purgeVisitorRecords, type NoteSnapshot } from "@/lib/records";
import { clientKey, rateLimit } from "@/lib/rate-limit";

const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? Math.abs(v) : null);
const str = (v: unknown, max: number) => (typeof v === "string" ? v.slice(0, max) : "");

export async function GET() {
  await connection();
  const v = await visitorId(false);
  return Response.json({ notes: v ? listNotes(v) : [], prejudgments: v ? countPrejudgments(v) : 0 });
}

/** 把一次决策前检查存为决策记录：保存时的理由、计划和检查结果原样留档 */
export async function POST(req: Request) {
  await connection();
  const rl = rateLimit(`notes:${clientKey(req)}`, 30, 3600_000);
  if (!rl.ok) return Response.json({ error: `保存太频繁了，请 ${rl.retryAfter} 秒后再试` }, { status: 429 });
  const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
  const code = normalizeCode(str(body?.code, 20));
  const reason = str(body?.reason, 1000).trim();
  if (!code) return Response.json({ error: "缺少股票代码" }, { status: 400 });
  if (!reason) return Response.json({ error: "先写下这次的理由再保存" }, { status: 400 });
  const s = (body?.snapshot ?? {}) as Partial<Record<keyof NoteSnapshot, unknown>>;
  const list = <T,>(x: unknown, max: number, f: (o: Record<string, unknown>) => T): T[] => (Array.isArray(x) ? x.slice(0, max).map((o) => f((o ?? {}) as Record<string, unknown>)) : []);
  const snapshot: NoteSnapshot = {
    asOf: str(s.asOf, 20) || null,
    checks: list(s.checks, 20, (o) => ({ text: str(o.text, 300), status: str(o.status, 20), detail: str(o.detail, 300) })),
    facts: list(s.facts, 40, (o) => ({ title: str(o.title, 300), source: str(o.source, 40), time: str(o.time, 20) })),
    sourceErrors: list(s.sourceErrors, 10, (o) => String(o).slice(0, 200)),
  };
  const v = (await visitorId(true)) as string;
  const id = addNote(v, { code, name: str(body?.name, 40) || null, side: body?.side === "sell" ? "sell" : "buy", reason, planStop: num(body?.planStop), planTarget: num(body?.planTarget), snapshot });
  if (!id) return Response.json({ error: "记录已经满 200 条，请先删除一些" }, { status: 400 });
  return Response.json({ id, notes: listNotes(v) });
}

/** 删除这个访客的全部决策记录和揭晓前判断 */
export async function DELETE() {
  await connection();
  const v = await visitorId(false);
  return Response.json({ deleted: v ? purgeVisitorRecords(v) : 0, notes: [] });
}
