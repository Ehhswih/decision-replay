import { connection } from "next/server";
import { rulesForWorkspace } from "@/lib/rules-review";
import { getReview, refreshDerived } from "@/lib/ai/review";
import { currentWorkspace } from "@/lib/workspace";

export async function GET() {
  await connection();
  const ws = await currentWorkspace();
  const r = await rulesForWorkspace(ws.id);
  const episodes = r.episodes.map((e) => {
    const rv = getReview(ws.id, e.episode.id);
    if (!rv.review) return { ...e, reviewStatus: rv.status, lessons: 0 };
    // 有 AI 复盘时，用最新规则 + AI 的核对结果重新算偏差和归因
    const doc = refreshDerived(rv.review, e.episode, r.sets.get(e.episode.id)!.items, e.biases);
    return { ...e, biases: doc.biases, attribution: doc.attribution, reviewStatus: rv.status, lessons: doc.lessons.length };
  });
  return Response.json({ workspace: ws, episodes, portfolio: r.portfolio, issues: r.issues, sources: r.sources });
}
