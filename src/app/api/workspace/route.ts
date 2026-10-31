import { connection } from "next/server";
import { cookies } from "next/headers";
import { currentWorkspace, WS_COOKIE } from "@/lib/workspace";

export async function GET() {
  await connection();
  return Response.json(await currentWorkspace());
}

/** 回到示例组合（不删除已导入的数据，只是不再使用） */
export async function DELETE() {
  await connection();
  (await cookies()).delete(WS_COOKIE);
  return Response.json({ ok: true });
}
