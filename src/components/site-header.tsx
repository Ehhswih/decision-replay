"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";
import { useTheme } from "next-themes";
import { Moon, Sun } from "lucide-react";
import { TimeCut } from "@/components/time-cut";
import { cn } from "@/lib/utils";

const NAV = [
  { href: "/decisions", label: "我的决策" },
  { href: "/checklist", label: "我的清单" },
  { href: "/precheck", label: "决策前检查" },
  { href: "/status", label: "数据状态" },
];

function ThemeToggle() {
  const { resolvedTheme, setTheme } = useTheme();
  const [mounted, setMounted] = useState(false);
  // 主题只在浏览器里才知道，挂载前先占位，避免服务端和客户端渲染不一致
  // eslint-disable-next-line react-hooks/set-state-in-effect
  useEffect(() => setMounted(true), []);
  const dark = mounted && resolvedTheme === "dark";
  return (
    <button
      type="button"
      onClick={() => setTheme(dark ? "light" : "dark")}
      aria-label={dark ? "切换到浅色" : "切换到深色"}
      title={dark ? "切换到浅色" : "切换到深色"}
      className="size-8 inline-flex items-center justify-center rounded-full text-muted-foreground hover:text-foreground hover:bg-muted focus-visible:outline-2 focus-visible:outline-ring"
    >
      {mounted ? dark ? <Sun className="size-4" /> : <Moon className="size-4" /> : <span className="size-4" />}
    </button>
  );
}

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
    <header className="sticky top-0 z-40 border-b border-border bg-card/80 backdrop-blur-md supports-[backdrop-filter]:bg-card/70">
      <div className="max-w-[1280px] mx-auto px-4 sm:px-6 flex flex-wrap sm:flex-nowrap items-center gap-x-8 sm:h-15">
        <Link href="/" className="h-13 sm:h-auto flex items-center gap-2.5 shrink-0 rounded-md focus-visible:outline-2 focus-visible:outline-ring" aria-label="决策回放首页">
          <TimeCut className="size-[22px]" />
          <span className="font-semibold tracking-wide text-[15px]">决策回放</span>
        </Link>
        <nav className="order-last sm:order-none w-full sm:w-auto flex items-center gap-1 overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden text-sm -mx-1 px-1 pb-2.5 sm:pb-0">
          {NAV.map((n) => {
            const on = path.startsWith(n.href);
            return (
              <Link
                key={n.href}
                href={n.href}
                aria-current={on ? "page" : undefined}
                className={cn(
                  "px-2.5 sm:px-3.5 py-1.5 rounded-full whitespace-nowrap transition-colors focus-visible:outline-2 focus-visible:outline-ring",
                  on ? "bg-primary text-primary-foreground font-medium" : "text-muted-foreground hover:text-foreground hover:bg-muted",
                )}
              >
                {n.label}
              </Link>
            );
          })}
        </nav>
        <div className="ml-auto flex items-center gap-2">
          {ws && (
            <Link
              href="/"
              className="hidden md:inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full border border-border text-xs text-muted-foreground hover:text-foreground hover:bg-muted"
            >
              <span className={cn("size-1.5 rounded-full", ws.isDemo ? "bg-expost" : "bg-exante")} />
              {ws.isDemo ? "示例组合（构造数据）" : "我导入的交易"}
            </Link>
          )}
          <ThemeToggle />
        </div>
      </div>
    </header>
  );
}
