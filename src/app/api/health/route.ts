import { connection } from "next/server";
import { db } from "@/lib/db";

export async function GET() {
  await connection();
  const row = db().prepare("SELECT sqlite_version() AS v, COUNT(*) AS n FROM call_log").get() as {
    v: string;
    n: number;
  };
  return Response.json({ ok: true, sqlite: row.v, calls: row.n, now: Date.now() });
}
