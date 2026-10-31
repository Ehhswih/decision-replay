import { connection } from "next/server";
import { rulesForWorkspace } from "@/lib/rules-review";
import { currentWorkspace } from "@/lib/workspace";

export async function GET() {
  await connection();
  const ws = await currentWorkspace();
  const r = await rulesForWorkspace(ws.id);
  return Response.json({ workspace: ws, episodes: r.episodes, portfolio: r.portfolio, issues: r.issues, sources: r.sources });
}
