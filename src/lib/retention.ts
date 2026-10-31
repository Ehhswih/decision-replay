import "server-only";
import { db } from "@/lib/db";

// 用户导入的成交属于个人数据：只保留 7 天，也可以随时一键删除。示例组合不受影响。
export const RETENTION_DAYS = 7;
const DEMO = "demo";

/** 删除一个工作区导入的成交、证据和复盘；示例组合不能删 */
export function purgeWorkspace(workspace: string): number {
  if (workspace === DEMO) return 0;
  const conn = db();
  conn.exec("BEGIN");
  try {
    const n = conn.prepare("DELETE FROM trades WHERE workspace = ?").run(workspace).changes;
    conn.prepare("DELETE FROM evidence_sets WHERE workspace = ?").run(workspace);
    conn.prepare("DELETE FROM reviews WHERE workspace = ?").run(workspace);
    conn.exec("COMMIT");
    return Number(n);
  } catch (e) {
    conn.exec("ROLLBACK");
    throw e;
  }
}

/** 清理超过保留期的导入数据，以及 30 天前的调用日志 */
export function cleanupExpired(now = Date.now()) {
  const cutoff = now - RETENTION_DAYS * 86_400_000;
  const expired = db()
    .prepare("SELECT workspace FROM trades WHERE workspace != ? GROUP BY workspace HAVING MAX(COALESCE(imported_at, 0)) < ?")
    .all(DEMO, cutoff) as { workspace: string }[];
  for (const w of expired) purgeWorkspace(w.workspace);
  const calls = db().prepare("DELETE FROM call_log WHERE at < ?").run(now - 30 * 86_400_000).changes;
  return { workspaces: expired.length, calls: Number(calls) };
}

let lastRun = 0;

/** 每小时最多清理一次，挂在常用请求上，不需要单独的定时任务 */
export function maybeCleanup() {
  if (Date.now() - lastRun < 3600_000) return;
  lastRun = Date.now();
  // 清理失败不能影响正常请求
  try {
    cleanupExpired();
  } catch (e) {
    console.error("清理过期数据失败", e);
  }
}
