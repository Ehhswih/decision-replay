import { connection } from "next/server";
import { cookies } from "next/headers";
import { randomUUID } from "node:crypto";
import { decodeCsv, parseTradesCsv } from "@/lib/domain/trades";
import { saveTrades } from "@/lib/pipeline";
import { isVisitorWorkspace, WS_COOKIE } from "@/lib/workspace";

const MAX_BYTES = 512 * 1024;
const MAX_ROWS = 500;

/** 上传成交 CSV：新建一个只属于当前访客的工作区 */
export async function POST(req: Request) {
  await connection();
  const form = await req.formData().catch(() => null);
  const file = form?.get("file");
  if (!(file instanceof File)) return Response.json({ ok: false, issues: [{ severity: "error", code: "no_file", message: "没有收到文件" }] }, { status: 400 });
  if (file.size > MAX_BYTES) return Response.json({ ok: false, issues: [{ severity: "error", code: "too_large", message: "文件超过 512KB，请拆分后导入" }] }, { status: 400 });

  const { text, encoding } = decodeCsv(new Uint8Array(await file.arrayBuffer()));
  const { trades, issues } = parseTradesCsv(text);
  if (!trades.length) return Response.json({ ok: false, encoding, issues: issues.length ? issues : [{ severity: "error", code: "empty", message: "文件里没有可识别的成交" }] }, { status: 400 });
  if (trades.length > MAX_ROWS) return Response.json({ ok: false, encoding, issues: [{ severity: "error", code: "too_many", message: `一次最多导入 ${MAX_ROWS} 笔成交` }] }, { status: 400 });

  const jar = await cookies();
  // 只沿用服务端发过的工作区 id；伪造成 "demo" 等值时另开一个，示例组合不会被覆盖
  const prev = jar.get(WS_COOKIE)?.value;
  const ws = isVisitorWorkspace(prev) ? prev : randomUUID();
  saveTrades(ws, trades);
  jar.set(WS_COOKIE, ws, { httpOnly: true, sameSite: "lax", maxAge: 60 * 60 * 24 * 30, path: "/" });
  return Response.json({ ok: true, encoding, imported: trades.length, issues });
}
