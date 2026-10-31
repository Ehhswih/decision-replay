import { connection } from "next/server";
import { visitorId } from "@/lib/checklist";
import { runPrecheck } from "@/lib/precheck";
import { currentWorkspace } from "@/lib/workspace";

export async function POST(req: Request) {
  await connection();
  const body = (await req.json().catch(() => null)) as { query?: string; side?: string; reason?: string; planStop?: number | null; planTarget?: number | null } | null;
  if (!body?.query?.trim()) return Response.json({ error: "请输入股票代码或名称" }, { status: 400 });
  const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? Math.abs(v) : null);
  const ws = await currentWorkspace();
  const r = await runPrecheck(
    { query: body.query.trim(), side: body.side === "sell" ? "sell" : "buy", reason: body.reason ?? "", planStop: num(body.planStop), planTarget: num(body.planTarget) },
    ws.id,
    await visitorId(false),
  );
  return Response.json(r, { status: "error" in r ? 404 : 200 });
}
