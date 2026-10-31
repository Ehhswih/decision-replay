"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { toast } from "sonner";
import { Button, buttonVariants } from "@/components/ui/button";
import { TimingBadge } from "@/components/timing-badge";

type ImportIssue = { severity: string; message: string; rowNo?: number };

export default function Home() {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [issues, setIssues] = useState<ImportIssue[]>([]);

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
    <div className="space-y-12 py-4">
      <section className="grid lg:grid-cols-[minmax(0,1fr)_420px] gap-10 items-center">
        <div className="space-y-5">
          <h1 className="text-3xl sm:text-4xl font-semibold leading-tight">
            复盘一笔交易，
            <br />
            先回到你下单的那一刻
          </h1>
          <p className="text-[15px] leading-7 text-muted-foreground max-w-xl">
            复盘时最容易犯的错，是拿后来才知道的事去评价当时的决定。决策回放把你的成交、当时写下的理由、行情和公告对齐到一条时间线上，
            先只给你看下单前已经公开的信息，再揭晓后来发生了什么，最后把教训变成下次下单前要过的检查清单。
          </p>
          <div className="flex flex-wrap gap-3">
            <Button size="lg" onClick={useDemo}>
              看示例组合
            </Button>
            <label className={buttonVariants({ size: "lg", variant: "outline", className: "cursor-pointer focus-within:outline-2 focus-within:outline-ring" })}>
                {busy ? "正在导入……" : "导入我的成交 CSV"}
                <input
                  type="file"
                  accept=".csv,text/csv"
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
          <p className="text-xs text-muted-foreground">
            支持券商导出的 CSV（UTF-8 或 GBK），常见列名会自动识别。
            <a href="/trades-template.csv" download className="text-exante underline underline-offset-2 ml-1">
              下载模板
            </a>
            。数据只用于你自己的复盘，不需要登录。
          </p>
          {issues.length > 0 && (
            <ul className="text-sm space-y-1 rounded-md border border-border bg-card p-3">
              {issues.slice(0, 10).map((i, k) => (
                <li key={k} className={i.severity === "error" ? "text-destructive" : "text-expost"}>
                  {i.rowNo ? `第 ${i.rowNo} 行：` : ""}
                  {i.message}
                </li>
              ))}
            </ul>
          )}
        </div>

        <figure className="rounded-lg border border-border bg-card p-5" aria-label="时点标签说明">
          <div className="relative h-24 rounded-md overflow-hidden border border-border">
            <svg viewBox="0 0 400 96" className="absolute inset-0 w-full h-full" aria-hidden>
              <polyline fill="none" stroke="#d9363e" strokeWidth="2" points="0,70 30,66 60,60 90,62 120,48 150,40 180,30 200,22 230,40 260,58 290,72 320,80 350,74 400,68" />
            </svg>
            <div className="absolute inset-y-0 left-1/2 w-0.5 bg-exante" />
            <div className="absolute inset-y-0 left-1/2 right-0 curtain" />
            <span className="absolute left-2 top-1.5 text-[11px] text-exante">下单前</span>
            <span className="absolute left-[calc(50%+8px)] top-1.5 text-[11px] text-muted-foreground">下单后（先遮住）</span>
          </div>
          <dl className="mt-4 space-y-3 text-sm">
            <div className="flex gap-3">
              <dt className="shrink-0">
                <TimingBadge timing="ex_ante" />
              </dt>
              <dd className="text-muted-foreground">下单时已经公开的行情、财报、公告和新闻。评价当时的决定只用这些。</dd>
            </div>
            <div className="flex gap-3">
              <dt className="shrink-0">
                <TimingBadge timing="ex_post" />
              </dt>
              <dd className="text-muted-foreground">下单之后才出现的信息。只用来解释结果，不用来指责当时没看到。</dd>
            </div>
            <div className="flex gap-3">
              <dt className="shrink-0">
                <TimingBadge timing="uncertain" />
              </dt>
              <dd className="text-muted-foreground">和下单同一天发布、只精确到日期，或者只有当前值的数据，分不清先后。</dd>
            </div>
          </dl>
        </figure>
      </section>

      <section>
        <h2 className="text-lg font-semibold mb-4">一次复盘的流程</h2>
        <ol className="grid sm:grid-cols-2 lg:grid-cols-4 gap-4 text-sm">
          {[
            ["导入成交", "按股票切成持仓段，核对成交价是否落在当天行情区间内、是否交易日。"],
            ["回到当时", "只看下单前可知的证据：支持理由的、已经存在的风险、理由里没提到的负面信息。"],
            ["揭晓结果", "用规则判定追涨、偏离计划等行为，区分看错了、没做好和不可预见，每条结论都能点回原始数据。"],
            ["带走清单", "把教训加入清单，下次在「决策前检查」里逐条对照这只股票当下的数据。"],
          ].map(([t, d], i) => (
            <li key={t} className="rounded-lg border border-border bg-card p-4">
              <div className="flex items-baseline gap-2 mb-1.5">
                <span className="text-xs text-muted-foreground num">{i + 1}</span>
                <span className="font-medium">{t}</span>
              </div>
              <p className="text-muted-foreground leading-6">{d}</p>
            </li>
          ))}
        </ol>
        <p className="text-sm text-muted-foreground mt-4">
          已经复盘过？去 <Link href="/precheck" className="text-exante underline underline-offset-2">决策前检查</Link> 用自己的清单过一遍下一笔交易。
        </p>
      </section>
    </div>
  );
}
