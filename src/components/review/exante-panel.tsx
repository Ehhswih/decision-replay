"use client";

import { Tag } from "@/components/timing-badge";
import { ClaimList, EvidenceChips, Section } from "./claims";
import { OUTCOME_TEXT, fmtDateTime } from "@/lib/labels";
import type { Evidence } from "@/lib/domain/evidence";
import { isB8Negative, type BiasResult } from "@/lib/domain/biases";
import type { ExAnteView } from "@/lib/ai/review";
import type { EpisodeTrade } from "@/lib/domain/types";

const CHECK_TEXT = { supported: "有证据支持", contradicted: "和证据矛盾", unverifiable: "无法核实" } as const;
const CHECK_TONE = { supported: "ok", contradicted: "danger", unverifiable: "neutral" } as const;

/** 回到当时：只看决策时刻之前能知道的东西 */
export function ExAntePanel({
  trade,
  plan,
  view,
  biases,
  evidence,
  onOpen,
  aiState,
}: {
  trade: EpisodeTrade;
  /** 买入时写的止损和目标（卖出决策要对照它） */
  plan: EpisodeTrade | null;
  view: ExAnteView | undefined;
  biases: BiasResult[];
  evidence: Map<string, Evidence>;
  onOpen: (e: Evidence) => void;
  aiState: React.ReactNode;
}) {
  const isSell = trade.side === "sell";
  // 卖出时的信号只用卖出那一刻已知的数据；卖出后的走势（事后代价）在这里不显示
  const signals = biases.filter((b) => b.tradeId === trade.id && (isSell ? ["B3", "B6", "B7"] : ["B1", "B2"]).includes(b.ruleId));
  // 和 B8 用同一个口径：只列规则认定的负面信息，AI 顺带提到的正面标题新闻、10 天以外的旧消息不列
  const ignoredNegatives = (view?.negativesCheck ?? []).filter(
    (n, i, all) => !n.addressed && n.relevant !== false && isB8Negative(evidence.get(n.evidenceId), trade.ts) && all.findIndex((x) => x.evidenceId === n.evidenceId) === i,
  );
  const planSource = isSell ? plan : trade;
  const planText = planSource
    ? [planSource.planStop != null ? `止损 ${planSource.planStop}%` : null, planSource.planTarget != null ? `目标 +${planSource.planTarget}%` : null].filter(Boolean).join("，")
    : "";
  return (
    <div className="space-y-4">
      <Section title={`${fmtDateTime(trade.ts)} ${isSell ? "卖出时" : "下单时"}`} aside={<span className="text-xs text-muted-foreground num">{isSell ? "卖出" : "买入"} {trade.qty} 股 @ {trade.price}</span>}>
        <dl className="grid sm:grid-cols-[5rem_1fr] gap-x-3 gap-y-1.5 text-sm">
          <dt className="text-muted-foreground">当时理由</dt>
          <dd>{trade.reason ?? <span className="text-muted-foreground">没有记录</span>}</dd>
          <dt className="text-muted-foreground">{isSell ? "买入时的计划" : "计划"}</dt>
          <dd>{planText || <span className="text-muted-foreground">没有写止损或目标</span>}</dd>
          {!trade.timeKnown && (
            <>
              <dt className="text-muted-foreground">时刻</dt>
              <dd className="text-expost">只有日期，按 09:30 处理，当天盘中的信息都算作事后</dd>
            </>
          )}
        </dl>
        {signals.length > 0 && (
          <ul className="mt-4 pt-3 border-t border-border space-y-1.5 text-sm">
            {signals.map((b) => (
              <li key={b.ruleId} className="flex flex-wrap items-center gap-1.5">
                <Tag tone={b.outcome === "hit" ? "danger" : b.outcome === "not_hit" ? "ok" : "neutral"}>
                  {b.name}：{OUTCOME_TEXT[b.outcome]}
                </Tag>
                <span className="text-muted-foreground">{b.finding}</span>
                <EvidenceChips ids={b.evidenceIds} evidence={evidence} decisionTs={trade.ts} onOpen={onOpen} />
              </li>
            ))}
          </ul>
        )}
      </Section>

      {isSell ? (
        <Section title="卖出时能看到什么">
          <p className="text-sm text-muted-foreground leading-relaxed">
            AI 的当时视角只针对买入决策生成。卖出这一刻，上面的信号都由程序用卖出前已知的数据算出；右侧「当时可知」一栏是卖出前已经公开的全部证据，卖出之后的走势和事件仍然遮住，点「揭晓结果」再看。
          </p>
        </Section>
      ) : !view ? (
        <Section title="当时能看到什么">{aiState}</Section>
      ) : (
        <>
          <Section
            title="当时能看到什么"
            aside={
              <span className="text-xs text-muted-foreground">
                模型只拿到 {view.packSize} 条当时可知的证据，股票名和日期已匿名
              </span>
            }
          >
            {view.summary && <p className="text-sm leading-relaxed mb-4">{view.summary}</p>}
            <div className="grid md:grid-cols-2 gap-5">
              <div>
                <h3 className="text-[13px] font-medium mb-2">支持当时理由的证据</h3>
                <ClaimList claims={view.supporting} evidence={evidence} decisionTs={trade.ts} onOpen={onOpen} showType={false} />
              </div>
              <div>
                <h3 className="text-[13px] font-medium mb-2">当时已经存在的风险信号</h3>
                <ClaimList claims={view.warnings} evidence={evidence} decisionTs={trade.ts} onOpen={onOpen} showType={false} empty="没有找到当时可知的风险信号" />
              </div>
            </div>
          </Section>

          <Section title="逐条核对当时的理由">
            {view.reasonCheck.length ? (
              <ul className="space-y-2.5">
                {view.reasonCheck.map((r, i) => (
                  <li key={i} className="text-sm leading-relaxed">
                    <span className="mr-1.5">「{r.claim}」</span>
                    <Tag tone={CHECK_TONE[r.status]} className="mr-1.5">
                      {CHECK_TEXT[r.status]}
                    </Tag>
                    <span className="text-muted-foreground mr-1.5">{r.text}</span>
                    <EvidenceChips ids={r.evidenceIds} evidence={evidence} decisionTs={trade.ts} onOpen={onOpen} />
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-sm text-muted-foreground">理由里没有可以核对的具体说法</p>
            )}
            {ignoredNegatives.length > 0 && (
              <div className="mt-4 pt-3 border-t border-border">
                <h3 className="text-[13px] font-medium mb-2">当时可知、和买入逻辑相关、但理由里没提到的负面信息</h3>
                <ul className="space-y-1.5 text-sm">
                  {ignoredNegatives.map((n) => (
                    <li key={n.evidenceId} className="flex flex-wrap gap-1.5 items-baseline">
                      <EvidenceChips ids={[n.evidenceId]} evidence={evidence} decisionTs={trade.ts} onOpen={onOpen} />
                      <span>{evidence.get(n.evidenceId)?.title}</span>
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </Section>
        </>
      )}
    </div>
  );
}
