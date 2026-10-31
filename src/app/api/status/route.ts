import { connection } from "next/server";
import { db } from "@/lib/db";
import { ifindQuota } from "@/lib/sources/ifind-api";
import { analyzeWorkspace } from "@/lib/pipeline";
import { currentWorkspace } from "@/lib/workspace";

export async function GET() {
  await connection();
  const ws = await currentWorkspace();
  const a = await analyzeWorkspace(ws.id);
  const since = Date.now() - 24 * 3600_000;
  const summary = db()
    .prepare(
      "SELECT source, status, from_cache, COUNT(*) AS n, ROUND(AVG(latency_ms)) AS avg_ms FROM call_log WHERE at >= ? GROUP BY source, status, from_cache ORDER BY source, status",
    )
    .all(since);
  const recent = db()
    .prepare("SELECT source, endpoint, status, code, message, latency_ms, from_cache, at FROM call_log WHERE from_cache = 0 ORDER BY id DESC LIMIT 40")
    .all();
  const cache = db().prepare("SELECT source, COUNT(*) AS n, MIN(fetched_at) AS oldest, MAX(fetched_at) AS newest FROM cache GROUP BY source").all();
  const reviews = db().prepare("SELECT status, COUNT(*) AS n FROM reviews WHERE workspace = ? GROUP BY status").all(ws.id);
  return Response.json({
    workspace: ws,
    sources: a.sources,
    issues: a.issues,
    summary,
    recent,
    cache,
    reviews,
    ifind: ifindQuota(),
    config: {
      fuyao: !!process.env.FUYAO_API_KEY,
      deepseek: !!process.env.DEEPSEEK_API_KEY,
      model: process.env.DEEPSEEK_MODEL || "deepseek-flash",
      ifind: !!(process.env.IFIND_MCP_URL && process.env.IFIND_MCP_AUTH),
    },
  });
}
