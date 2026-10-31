import "server-only";
import { cookies } from "next/headers";
import { DEMO_WORKSPACE, ensureDemo } from "@/lib/pipeline";
import { maybeCleanup } from "@/lib/retention";

export const WS_COOKIE = "dr_ws";

/** 访客工作区的 id 都是服务端生成的 UUID；cookie 里的其他值（包括示例组合的 "demo"）一律不认 */
export function isVisitorWorkspace(ws: string | undefined): ws is string {
  return !!ws && ws !== DEMO_WORKSPACE && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(ws);
}

/** 当前访客的工作区：没导入过自己的数据就用只读的示例组合 */
export async function currentWorkspace(): Promise<{ id: string; isDemo: boolean }> {
  maybeCleanup();
  const ws = (await cookies()).get(WS_COOKIE)?.value;
  if (isVisitorWorkspace(ws)) return { id: ws, isDemo: false };
  ensureDemo();
  return { id: DEMO_WORKSPACE, isDemo: true };
}
