import type { Metadata } from "next";
import { Suspense } from "react";
import { Toaster } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import { SiteHeader } from "@/components/site-header";
import "./globals.css";

export const metadata: Metadata = {
  title: "决策回放",
  description: "复盘历史投资决策：分清当时可知和事后才知，沉淀成下一次决策的检查清单",
};

// 只用系统字体：构建时不需要访问 Google Fonts（国内服务器连不上）
export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="zh-CN" className="h-full antialiased">
      <body className="min-h-full flex flex-col">
        <TooltipProvider>
          <Suspense fallback={<div className="h-14 border-b border-border bg-card" />}>
            <SiteHeader />
          </Suspense>
          <main className="flex-1 w-full max-w-[1280px] mx-auto px-4 sm:px-6 py-6">{children}</main>
          <footer className="border-t border-border text-xs text-muted-foreground">
            <div className="max-w-[1280px] mx-auto px-4 sm:px-6 py-4 flex flex-wrap gap-x-6 gap-y-1">
              <span>本产品用于复盘学习，不构成任何投资建议，不预测涨跌。</span>
              <span>行情和资讯来自同花顺扶摇金融数据 API 与 iFinD MCP，复盘叙述由 DeepSeek 生成并经程序校验。</span>
            </div>
          </footer>
        </TooltipProvider>
        <Toaster position="top-center" />
      </body>
    </html>
  );
}
