import { connection } from "next/server";
import { analyzeWorkspace, buildEvidenceSet } from "@/lib/pipeline";
import { currentWorkspace } from "@/lib/workspace";

export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }) {
  await connection();
  const { id } = await ctx.params;
  const ws = await currentWorkspace();
  const a = await analyzeWorkspace(ws.id);
  const ep = a.episodes.find((e) => e.id === decodeURIComponent(id));
  if (!ep) return Response.json({ error: "找不到这个持仓段" }, { status: 404 });
  const force = new URL(req.url).searchParams.get("refresh") === "1";
  return Response.json(await buildEvidenceSet(ws.id, ep, force));
}
