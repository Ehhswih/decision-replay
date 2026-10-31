import "server-only";
import { cookies } from "next/headers";
import { DEMO_WORKSPACE, ensureDemo } from "@/lib/pipeline";
import { maybeCleanup } from "@/lib/retention";

export const WS_COOKIE = "dr_ws";

/** 当前访客的工作区：没导入过自己的数据就用只读的示例组合 */
export async function currentWorkspace(): Promise<{ id: string; isDemo: boolean }> {
  maybeCleanup();
  const ws = (await cookies()).get(WS_COOKIE)?.value;
  if (ws && /^[a-z0-9-]{8,40}$/.test(ws)) return { id: ws, isDemo: false };
  ensureDemo();
  return { id: DEMO_WORKSPACE, isDemo: true };
}
