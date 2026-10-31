import "server-only";
import { attribute, type Attribution } from "@/lib/domain/attribution";
import { episodeBiases, portfolioBiases, type BiasResult } from "@/lib/domain/biases";
import type { Episode, Issue } from "@/lib/domain/types";
import { analyzeWorkspace, buildEvidenceSet, type EvidenceSet, type SourceStatus } from "@/lib/pipeline";

export interface EpisodeRules {
  episode: Episode;
  biases: BiasResult[];
  attribution: Attribution;
}

export interface PortfolioRules {
  episodes: EpisodeRules[];
  portfolio: BiasResult[];
  issues: Issue[];
  sources: SourceStatus[];
  sets: Map<string, EvidenceSet>;
}

/** 规则版复盘：整个组合一起算，因为处置效应和过度交易要跨持仓段看 */
export async function rulesForWorkspace(workspace: string): Promise<PortfolioRules> {
  const a = await analyzeWorkspace(workspace);
  // 每个持仓段要调十几次数据源（热门股新闻还要翻很多页），3 个一组并行，兼顾速度和数据源限流
  const sets = new Map<string, EvidenceSet>();
  const queue = [...a.episodes];
  await Promise.all(
    Array.from({ length: Math.min(3, queue.length) }, async () => {
      for (let ep = queue.shift(); ep; ep = queue.shift()) sets.set(ep.id, await buildEvidenceSet(workspace, ep));
    }),
  );

  const perEpisode = a.episodes.map((ep) => ({ ep, biases: episodeBiases(ep, sets.get(ep.id)!.items) }));
  const portfolio = portfolioBiases(
    a.episodes.map((ep) => {
      const set = sets.get(ep.id)!;
      const hold = set.items.find((e) => e.id === `calc:hold:${ep.id}`);
      return { episode: ep, holdDays: hold?.value ?? null, tradingDays: set.series.raw.map((b) => b.date) };
    }),
  );

  const episodes = perEpisode.map(({ ep, biases }) => {
    // 处置效应是组合层面的结论，单独展示；过度交易针对具体股票，挂到相关持仓段上
    const related = portfolio.filter((p) => p.outcome === "hit" && p.ruleId !== "B4" && p.episodeIds?.includes(ep.id));
    const all = [...biases, ...related];
    return { episode: ep, biases: all, attribution: attribute(ep, sets.get(ep.id)!.items, all) };
  });
  return { episodes, portfolio, issues: a.issues, sources: a.sources, sets };
}
