import { connection } from "next/server";
import { visitorId } from "@/lib/checklist";
import { addNoteVersion, listNotes } from "@/lib/records";

const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? Math.abs(v) : null);

/** 补充理由：新增一个版本，原来的版本保留 */
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  await connection();
  const { id } = await ctx.params;
  const v = await visitorId(false);
  if (!v) return Response.json({ error: "找不到这条记录" }, { status: 404 });
  const body = (await req.json().catch(() => null)) as { reason?: unknown; planStop?: unknown; planTarget?: unknown } | null;
  const reason = typeof body?.reason === "string" ? body.reason.trim().slice(0, 1000) : "";
  if (!reason) return Response.json({ error: "补充的理由不能为空" }, { status: 400 });
  const version = addNoteVersion(v, id, { reason, planStop: num(body?.planStop), planTarget: num(body?.planTarget) });
  if (version == null) return Response.json({ error: "找不到这条记录，或者版本太多了" }, { status: 404 });
  return Response.json({ version, notes: listNotes(v) });
}
