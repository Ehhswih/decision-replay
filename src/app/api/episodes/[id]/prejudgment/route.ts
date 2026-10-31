import { connection } from "next/server";
import { visitorId } from "@/lib/checklist";
import { loadTrades } from "@/lib/pipeline";
import { addPrejudgment, listPrejudgments, VERDICTS, type Verdict } from "@/lib/records";
import { currentWorkspace } from "@/lib/workspace";
import { clientKey, rateLimit } from "@/lib/rate-limit";

export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  await connection();
  const episodeId = decodeURIComponent((await ctx.params).id);
  const [v, ws] = await Promise.all([visitorId(false), currentWorkspace()]);
  return Response.json({ items: v ? listPrejudgments(v, ws.id, episodeId) : [] });
}

/** 揭晓前写下自己的判断。每笔成交只能写一次，写下后不能修改 */
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  await connection();
  const rl = rateLimit(`prejudgment:${clientKey(req)}`, 60, 3600_000);
  if (!rl.ok) return Response.json({ error: `操作太频繁了，请 ${rl.retryAfter} 秒后再试` }, { status: 429 });
  const episodeId = decodeURIComponent((await ctx.params).id);
  const body = (await req.json().catch(() => null)) as { tradeId?: string; verdict?: string; worry?: string; afterReveal?: boolean } | null;
  const ws = await currentWorkspace();
  if (!body?.tradeId || !loadTrades(ws.id).some((t) => t.id === body.tradeId)) return Response.json({ error: "找不到这笔成交" }, { status: 404 });
  if (!VERDICTS.includes(body.verdict as Verdict)) return Response.json({ error: "请选择理由是否充分" }, { status: 400 });
  const v = (await visitorId(true)) as string;
  const ok = addPrejudgment(v, ws.id, episodeId, { tradeId: body.tradeId, verdict: body.verdict as Verdict, worry: body.worry?.trim() || null, afterReveal: body.afterReveal === true });
  if (!ok) return Response.json({ error: "这笔决策已经写过判断，不能修改" }, { status: 409 });
  return Response.json({ items: listPrejudgments(v, ws.id, episodeId) });
}
