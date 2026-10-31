import { connection } from "next/server";
import { chatJson } from "@/lib/ai/deepseek";
import { exAntePack, packText } from "@/lib/ai/pack";
import { EX_ANTE_SYSTEM, exAnteUser } from "@/lib/ai/prompts";
import { expostTerms } from "@/lib/ai/review";
import { checkClaims, detectLeakage, type LogEntry } from "@/lib/ai/validate";
import { rulesForWorkspace } from "@/lib/rules-review";
import { currentWorkspace } from "@/lib/workspace";

/**
 * 后见之明泄漏对照实验（只在开发环境开放）：
 * 同一笔买入、同一份证据，分别匿名和不匿名各生成一次当时视角，
 * 统计输出里出现的"决策后才有的信息"和被时点校验丢掉的结论数。
 */
export async function GET(req: Request) {
  await connection();
  if (process.env.NODE_ENV === "production" && !process.env.ENABLE_DEBUG) return new Response("Not found", { status: 404 });
  const url = new URL(req.url);
  const episodeId = url.searchParams.get("episode") ?? "";
  const ws = await currentWorkspace();
  const rules = await rulesForWorkspace(ws.id);
  const er = rules.episodes.find((x) => x.episode.id === episodeId);
  const set = rules.sets.get(episodeId);
  if (!er || !set) return Response.json({ error: "找不到这个持仓段" }, { status: 404 });
  const t = er.episode.trades.find((x) => x.side === "buy")!;
  const evidence = new Map(set.items.map((e) => [e.id, e]));
  const name = er.episode.name ?? "";

  const run = async (anonymize: boolean) => {
    const { pack, anon, decisionTime } = exAntePack(er.episode, set.items, t, anonymize);
    const identity = (s: string) => s;
    // 不匿名时去掉提示词里关于匿名化的那句，其余完全相同
    const system = anonymize
      ? EX_ANTE_SYSTEM
      : EX_ANTE_SYSTEM.replace("股票名称已替换为\"标的A\"，日期已替换为相对决策日的天数（D-3 表示决策日之前 3 天）。不要猜测标的A是哪家公司，也", "");
    const r = await chatJson<Record<string, unknown>>(
      system,
      exAnteUser({ decisionTime, reason: t.reason && anon ? anon.text(t.reason) : t.reason, plan: "", pack, negativeIds: [] }),
    );
    if (!r.ok) return { error: r.message };
    const raw = JSON.stringify(r.data);
    const log: LogEntry[] = [];
    const texts = new Map(pack.map((p) => [p.id, packText(p)]));
    const ctx = { evidence, exAnteAt: t.ts, log, stage: anonymize ? "匿名" : "不匿名", textOf: (e: { id: string; title: string }) => texts.get(e.id) ?? e.title };
    const kept = [...checkClaims(r.data.supporting, ctx as never), ...checkClaims(r.data.warnings, ctx as never)];
    return {
      anonymized: anonymize,
      packSize: pack.length,
      leakage: detectLeakage(raw, expostTerms(set.items, t.ts, anon ? anon.text : identity), pack.map(packText).join(" ")),
      mentionsRealName: anonymize && name ? raw.includes(name) : null,
      keptClaims: kept.length,
      droppedClaims: log.length,
      dropped: log,
      summary: r.data.summary,
    };
  };

  return Response.json({ episode: episodeId, decision: t.id, anonymized: await run(true), plain: await run(false) });
}
