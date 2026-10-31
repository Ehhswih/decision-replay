import { connection } from "next/server";
import { cookies } from "next/headers";
import { currentWorkspace, WS_COOKIE } from "@/lib/workspace";
import { purgeWorkspace, RETENTION_DAYS } from "@/lib/retention";

export async function GET() {
  await connection();
  return Response.json({ ...(await currentWorkspace()), retentionDays: RETENTION_DAYS });
}

/** 回到示例组合；?purge=1 同时删除当前工作区导入的成交、证据和复盘 */
export async function DELETE(req: Request) {
  await connection();
  const ws = await currentWorkspace();
  const purged = new URL(req.url).searchParams.get("purge") === "1" && !ws.isDemo ? purgeWorkspace(ws.id) : 0;
  (await cookies()).delete(WS_COOKIE);
  return Response.json({ ok: true, purged });
}
