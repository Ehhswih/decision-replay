import { connection } from "next/server";
import { analyzeWorkspace } from "@/lib/pipeline";
import { currentWorkspace } from "@/lib/workspace";

export async function GET() {
  await connection();
  const ws = await currentWorkspace();
  const a = await analyzeWorkspace(ws.id);
  return Response.json({ workspace: ws, ...a });
}
