import { connection } from "next/server";
import { getReview, refreshDerived, startReview } from "@/lib/ai/review";
import { rulesForWorkspace } from "@/lib/rules-review";
import { currentWorkspace } from "@/lib/workspace";
import { clientKey, rateLimit } from "@/lib/rate-limit";

export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  await connection();
  const { id } = await ctx.params;
  const episodeId = decodeURIComponent(id);
  const ws = await currentWorkspace();
  const r = getReview(ws.id, episodeId);
  if (!r.review) return Response.json(r);
  // 复盘生成后规则逻辑可能更新过：按最新规则重算偏差和归因（AI 输出原样保留）
  const rules = await rulesForWorkspace(ws.id);
  const er = rules.episodes.find((x) => x.episode.id === episodeId);
  const set = rules.sets.get(episodeId);
  return Response.json(er && set ? { ...r, review: refreshDerived(r.review, er.episode, set.items, er.biases) } : r);
}

/** 开始生成（后台运行，前端轮询 GET）。?force=1 重新生成 */
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  await connection();
  const { id } = await ctx.params;
  const ws = await currentWorkspace();
  const episodeId = decodeURIComponent(id);
  const existing = getReview(ws.id, episodeId);
  // 运维用：带 ADMIN_TOKEN 时可以重新生成示例组合（部署后预生成）
  const admin = !!process.env.ADMIN_TOKEN && req.headers.get("x-admin-token") === process.env.ADMIN_TOKEN;
  // 示例组合是所有访客共用的只读数据：已经生成过就不允许访客重新生成
  if (ws.isDemo && existing.status === "done" && !admin) return Response.json(existing);
  if (!admin) {
    const rl = rateLimit(`review:${clientKey(req)}`, 15, 3600_000);
    if (!rl.ok) return Response.json({ status: "failed", error: `生成太频繁了，请 ${rl.retryAfter} 秒后再试（每小时最多 15 次）` }, { status: 429 });
  }
  const force = (admin || !ws.isDemo) && new URL(req.url).searchParams.get("force") === "1";
  return Response.json(startReview(ws.id, episodeId, force));
}
