"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { Button, buttonVariants } from "@/components/ui/button";
import { TimingBadge } from "@/components/timing-badge";
import { ReplayDemo } from "@/components/replay-demo";
import type { TimingKey } from "@/lib/labels";

type ImportIssue = { severity: string; message: string; rowNo?: number };

const STEPS = [
  ["导入成交", "按股票切成持仓段，核对成交价是否落在当天行情区间内、是否交易日。"],
  ["回到当时", "只看下单前可知的证据：支持理由的、已经存在的风险、理由里没提到的负面信息。"],
  ["揭晓结果", "用规则判定追涨、偏离计划等行为，区分看错了、没做好和可能受事后事件影响，证据不够时写暂无法归类；每条结论都能点回原始数据。"],
  ["带走清单", "把教训加入清单，下次在「决策前检查」里逐条对照这只股票当下的数据。"],
];

const TIMINGS: [TimingKey, string][] = [
  ["ex_ante", "下单时已经公开的行情、财报、公告和新闻。评价当时的决定只用这些。"],
  ["ex_post", "下单之后才出现的信息。只用来解释结果，不用来指责当时没看到。"],
  ["uncertain", "和下单同一天发布、只精确到日期，或者只有当前值的数据，分不清先后。"],
];

export default function Home() {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [issues, setIssues] = useState<ImportIssue[]>([]);
  const [ws, setWs] = useState<{ isDemo: boolean; retentionDays: number } | null>(null);

  useEffect(() => {
    fetch("/api/workspace")
      .then((r) => r.json())
      .then(setWs)
      .catch(() => setWs(null));
  }, []);

  const purge = async () => {
    if (!window.confirm("删除你导入的成交和生成的复盘？删除后不能恢复。清单不受影响。")) return;
    const r = await fetch("/api/workspace?purge=1", { method: "DELETE" }).then((x) => x.json());
    toast.success(`已删除 ${r.purged} 笔成交和相关复盘`);
    setWs({ isDemo: true, retentionDays: ws?.retentionDays ?? 7 });
  };

  const useDemo = async () => {
    await fetch("/api/workspace", { method: "DELETE" });
    router.push("/decisions");
  };

  const upload = async (file: File) => {
    setBusy(true);
    setIssues([]);
    const form = new FormData();
    form.append("file", file);
    try {
      const r = await fetch("/api/import", { method: "POST", body: form });
      const j = (await r.json()) as { ok: boolean; imported?: number; encoding?: string; issues: ImportIssue[] };
      setIssues(j.issues ?? []);
      if (j.ok) {
        // 解析阶段的说明（跳过的记录、合并的分笔成交）带到「我的决策」页显示
        try {
          sessionStorage.setItem("dr_import_issues", JSON.stringify(j.issues ?? []));
        } catch {}
        toast.success(`已导入 ${j.imported} 笔成交`, { description: j.encoding === "gbk" ? "按 GBK 编码读取" : undefined });
        router.push("/decisions");
      }
    } catch {
      setIssues([{ severity: "error", message: "上传失败，请检查网络后重试" }]);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-16 sm:space-y-20 py-2 sm:py-6">
      <section className="grid lg:grid-cols-[minmax(0,1fr)_520px] gap-10 lg:gap-14 items-center">
        <div className="space-y-6">
          <h1 className="text-[2rem] sm:text-5xl font-semibold leading-[1.15] tracking-tight">
            复盘一笔交易，
            <br />
            先回到你下单的那一刻
          </h1>
          <p className="text-[15px] sm:text-base leading-7 sm:leading-8 text-muted-foreground max-w-xl">
            复盘时最容易犯的错，是拿后来才知道的事去评价当时的决定。决策回放把你的成交、当时写下的理由、行情和公告对齐到一条时间线上，先只给你看下单前已经公开的信息，再揭晓后来发生了什么，最后把教训变成下次下单前要过的检查清单。
          </p>
          <div className="flex flex-wrap gap-3">
            <Button size="lg" className="h-11 px-5 rounded-full text-[15px]" onClick={useDemo}>
              看示例组合
            </Button>
            <label
              className={buttonVariants({
                size: "lg",
                variant: "outline",
                className: "h-11 px-5 rounded-full text-[15px] bg-card cursor-pointer focus-within:outline-2 focus-within:outline-ring",
              })}
            >
              {busy ? "正在导入……" : "导入我的成交 CSV"}
              <input
                type="file"
                accept=".csv,text/csv,.txt"
                className="sr-only"
                disabled={busy}
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  if (f) upload(f);
                  e.target.value = "";
                }}
              />
            </label>
          </div>
          {ws && !ws.isDemo && (
            <div className="panel p-3 text-sm flex flex-wrap items-center gap-3">
              <span>你正在看自己导入的成交。导入的数据在服务器上保留 {ws.retentionDays} 天，之后自动删除。</span>
              <Button size="sm" variant="ghost" onClick={() => router.push("/decisions")}>
                查看复盘
              </Button>
              <Button size="sm" variant="ghost" className="text-destructive" onClick={purge}>
                删除我导入的数据
              </Button>
            </div>
          )}
          <p className="text-xs leading-relaxed text-muted-foreground max-w-xl">
            支持券商导出的交割单（CSV，UTF-8 或 GBK），同花顺、东方财富等常见列名会自动识别；转账、分红、申购、逆回购、ETF 等不是股票买卖的记录自动跳过，同一委托的分笔成交合并成一笔。
            <a href="/trades-template.csv" download className="text-exante underline underline-offset-2 mx-1">
              下载模板
            </a>
            或
            <a href="/sample-delivery-ths.csv" download="示例交割单-同花顺格式.csv" className="text-exante underline underline-offset-2 mx-1">
              下载一份示例交割单
            </a>
            （模拟一位散户 7 个月的 62 笔交易，价格来自真实行情）。
            数据只用于你自己的复盘，不需要登录，导入的成交 7 天后自动删除，也可以随时手动删除。
          </p>
          {issues.length > 0 && (
            <ul className="text-sm space-y-1 panel p-3">
              {issues.slice(0, 10).map((i, k) => (
                <li key={k} className={i.severity === "error" ? "text-destructive" : i.severity === "info" ? "text-muted-foreground" : "text-expost"}>
                  {i.rowNo ? `第 ${i.rowNo} 行：` : ""}
                  {i.message}
                </li>
              ))}
            </ul>
          )}
        </div>

        <ReplayDemo />
      </section>

      <section>
        <h2 className="text-xl font-semibold tracking-tight mb-6">一次复盘的流程</h2>
        <ol className="grid sm:grid-cols-2 lg:grid-cols-4 gap-x-6 gap-y-8 text-sm">
          {STEPS.map(([t, d], i) => (
            <li key={t}>
              <div className="flex items-center gap-3 mb-3">
                <span
                  className={`figure size-8 shrink-0 rounded-full inline-flex items-center justify-center text-sm font-semibold ring-1 ring-inset ${
                    i === 1 ? "bg-exante text-on-accent ring-exante" : i === 2 ? "bg-expost text-on-accent ring-expost" : "bg-card ring-border"
                  }`}
                >
                  {i + 1}
                </span>
                <span className="font-semibold text-[15px] shrink-0">{t}</span>
                {i < STEPS.length - 1 && <span aria-hidden className="hidden lg:block flex-1 h-px bg-border" />}
              </div>
              <p className="text-muted-foreground leading-6 pr-2">{d}</p>
            </li>
          ))}
        </ol>
        <p className="text-sm text-muted-foreground mt-8">
          已经复盘过？去 <Link href="/precheck" className="text-exante underline underline-offset-2">决策前检查</Link> 用自己的清单过一遍下一笔交易。
        </p>
      </section>

      <section aria-label="三种时点标签" className="grid md:grid-cols-3 gap-px rounded-xl overflow-hidden ring-1 ring-border bg-border">
        {TIMINGS.map(([k, d]) => (
          <div key={k} className="bg-card p-5">
            <TimingBadge timing={k} />
            <p className="text-sm text-muted-foreground leading-6 mt-2.5">{d}</p>
          </div>
        ))}
      </section>
    </div>
  );
}
