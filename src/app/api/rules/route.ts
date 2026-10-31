import { connection } from "next/server";
import { rulesForWorkspace } from "@/lib/rules-review";
import { getReview } from "@/lib/ai/review";
import { currentWorkspace } from "@/lib/workspace";

export async function GET() {
  await connection();
  const ws = await currentWorkspace();
  const r = await rulesForWorkspace(ws.id);
  const episodes = r.episodes.map((e) => {
    const rv = getReview(ws.id, e.episode.id);
    // 有 AI 复盘时用复盘里更新过的偏差和归因（B8 由 AI 核对定论）
    return rv.review ? { ...e, biases: rv.review.biases, attribution: rv.review.attribution, reviewStatus: rv.status, lessons: rv.review.lessons.length } : { ...e, reviewStatus: rv.status, lessons: 0 };
  });
  return Response.json({ workspace: ws, episodes, portfolio: r.portfolio, issues: r.issues, sources: r.sources });
}
