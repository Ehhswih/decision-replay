"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";
import { cn } from "@/lib/utils";

const NAV = [
  { href: "/decisions", label: "我的决策" },
  { href: "/checklist", label: "我的清单" },
  { href: "/precheck", label: "决策前检查" },
  { href: "/status", label: "数据状态" },
];

export function SiteHeader() {
  const path = usePathname();
  const [ws, setWs] = useState<{ isDemo: boolean } | null>(null);
  useEffect(() => {
    fetch("/api/workspace")
      .then((r) => r.json())
      .then(setWs)
      .catch(() => setWs(null));
  }, [path]);

  return (
    <header className="border-b border-border bg-card">
      <div className="max-w-[1280px] mx-auto px-4 sm:px-6 h-14 flex items-center gap-6">
        <Link href="/" className="flex items-center gap-2 shrink-0" aria-label="决策回放首页">
          <span aria-hidden className="relative inline-block w-5 h-5">
            <span className="absolute inset-y-0 left-0 w-1/2 bg-exante rounded-l-sm" />
            <span className="absolute inset-y-0 right-0 w-1/2 rounded-r-sm curtain border border-border" />
          </span>
          <span className="font-semibold tracking-wide">决策回放</span>
        </Link>
        <nav className="flex items-center gap-1 overflow-x-auto text-sm">
          {NAV.map((n) => (
            <Link
              key={n.href}
              href={n.href}
              className={cn(
                "px-3 py-1.5 rounded-md whitespace-nowrap transition-colors hover:bg-muted focus-visible:outline-2 focus-visible:outline-ring",
                path.startsWith(n.href) ? "bg-muted font-medium" : "text-muted-foreground",
              )}
            >
              {n.label}
            </Link>
          ))}
        </nav>
        <div className="ml-auto hidden sm:block text-xs">
          {ws && (
            <Link href="/" className="px-2 py-1 rounded border border-border text-muted-foreground hover:bg-muted">
              {ws.isDemo ? "正在看示例组合（构造数据）" : "正在看我导入的交易"}
            </Link>
          )}
        </div>
      </div>
    </header>
  );
}
