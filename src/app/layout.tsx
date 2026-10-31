import type { Metadata, Viewport } from "next";
import { Suspense } from "react";
import { ThemeProvider } from "next-themes";
import { Toaster } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import { SiteHeader } from "@/components/site-header";
import { TimeCut } from "@/components/time-cut";
import "./globals.css";

export const metadata: Metadata = {
  title: "决策回放",
  description: "复盘历史投资决策：分清当时可知和事后才知，把教训变成下次下单前的检查清单",
};

export const viewport: Viewport = {
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#f3f5f8" },
    { media: "(prefers-color-scheme: dark)", color: "#0b111c" },
  ],
};

// 只用系统字体：构建时不需要访问 Google Fonts（国内服务器连不上）
export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="zh-CN" className="h-full antialiased" suppressHydrationWarning>
      <body className="min-h-full flex flex-col">
        <ThemeProvider attribute="class" defaultTheme="system" enableSystem disableTransitionOnChange>
          <TooltipProvider>
            <Suspense fallback={<div className="h-[6.25rem] sm:h-15 border-b border-border bg-card/80" />}>
              <SiteHeader />
            </Suspense>
            <main className="flex-1 w-full max-w-[1280px] mx-auto px-4 sm:px-6 py-6 sm:py-8">{children}</main>
            <footer className="border-t border-border text-xs text-muted-foreground">
              <div className="max-w-[1280px] mx-auto px-4 sm:px-6 py-5 flex flex-col sm:flex-row sm:items-center gap-3 sm:gap-6">
                <span className="flex items-center gap-2 text-foreground">
                  <TimeCut className="size-4" />
                  决策回放
                </span>
                <span>用于复盘学习，不构成任何投资建议，不预测涨跌。</span>
                <span className="sm:ml-auto">行情和资讯来自同花顺扶摇金融数据 API 与 iFinD MCP，复盘叙述由 DeepSeek 生成并经程序校验。</span>
              </div>
            </footer>
          </TooltipProvider>
          <Toaster position="top-center" />
        </ThemeProvider>
      </body>
    </html>
  );
}
