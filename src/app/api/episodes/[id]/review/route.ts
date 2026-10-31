import { connection } from "next/server";
import { getReview, startReview } from "@/lib/ai/review";
import { currentWorkspace } from "@/lib/workspace";

export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  await connection();
  const { id } = await ctx.params;
  const ws = await currentWorkspace();
  return Response.json(getReview(ws.id, decodeURIComponent(id)));
}

/** 开始生成（后台运行，前端轮询 GET）。?force=1 重新生成 */
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  await connection();
  const { id } = await ctx.params;
  const ws = await currentWorkspace();
  const force = new URL(req.url).searchParams.get("force") === "1";
  return Response.json(startReview(ws.id, decodeURIComponent(id), force));
}
