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
  const url = new URL(req.url);
  const set = await buildEvidenceSet(ws.id, ep, url.searchParams.get("refresh") === "1");
  if (url.searchParams.get("slim") !== "1") return Response.json(set);
  // 页面用的精简版：不重要的新闻只保留标题，正文截短
  const items = set.items.map((e) => (e.kind === "news" && !e.important ? { ...e, detail: undefined } : e.detail && e.detail.length > 300 ? { ...e, detail: e.detail.slice(0, 300) + "…" } : e));
  return Response.json({ ...set, items });
}
