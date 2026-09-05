import { useState } from "react";
import { Link } from "wouter";
import { Database, Loader2, ShieldCheck } from "lucide-react";

import { useAuth } from "@/_core/hooks/useAuth";
import EmbeddedKnowledgeBasePanel from "@/components/EmbeddedKnowledgeBasePanel";
import { Button } from "@/components/ui/button";
import { ConversationProvider } from "@/contexts/ConversationContext";

function ProductionAcceptanceWorkspace() {
  const [page, setPage] = useState<"build" | "display">("build");

  return (
    <main className="flex h-[100dvh] min-h-0 flex-col bg-white">
      <header className="flex shrink-0 flex-wrap items-center justify-between gap-3 border-b border-emerald-100 bg-emerald-50/70 px-5 py-3 text-sm">
        <div>
          <div className="flex items-center gap-2 font-semibold text-emerald-800">
            <ShieldCheck className="h-4 w-4" />
            生产契约验收 · 本地数据库与真实 FrontMind API
          </div>
          <p className="mt-1 text-xs text-emerald-900/70">
            使用生产会话、reservation、reconcile、同源资源、发布与下载控制器；无模拟正文或协议放行。
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Button
            size="sm"
            variant={page === "build" ? "default" : "outline"}
            onClick={() => setPage("build")}
          >
            构建与确认
          </Button>
          <Button
            size="sm"
            variant={page === "display" ? "default" : "outline"}
            onClick={() => setPage("display")}
          >
            成品展示
          </Button>
          <Button asChild size="sm" variant="ghost">
            <Link href="/preview/knowledge-base-upstream-probe">
              仅上游诊断
            </Link>
          </Button>
        </div>
      </header>
      <div className="min-h-0 flex-1">
        <EmbeddedKnowledgeBasePanel
          page={page}
          onPageChange={setPage}
          mode="workspace"
          knowledgeEngineerAssigned
        />
      </div>
    </main>
  );
}

export default function KnowledgeBaseProductionAcceptance() {
  const { user, loading } = useAuth();
  if (loading) {
    return (
      <div className="flex min-h-[100dvh] items-center justify-center gap-2 text-sm text-muted-foreground">
        <Loader2 className="h-5 w-5 animate-spin" />
        正在读取本地测试会话…
      </div>
    );
  }
  if (!user || user.role !== "user") {
    return (
      <main className="flex min-h-[100dvh] items-center justify-center bg-slate-50 p-6">
        <section className="max-w-lg rounded-2xl border bg-white p-7 text-center shadow-sm">
          <Database className="mx-auto h-8 w-8 text-emerald-700" />
          <h1 className="mt-4 text-lg font-semibold">需要本地测试用户会话</h1>
          <p className="mt-2 text-sm leading-6 text-slate-600">
            生产契约必须验证 user/build/generation/turn 的数据库归属，不能用无账号探针替代。请先登录本地测试用户并通过一次性输入配置轮换后的测试 Key。
          </p>
          <div className="mt-5 flex justify-center gap-2">
            <Button asChild>
              <Link href="/login">打开本地登录</Link>
            </Button>
            <Button asChild variant="outline">
              <Link href="/preview/knowledge-base-upstream-probe">
                仅检查上游
              </Link>
            </Button>
          </div>
        </section>
      </main>
    );
  }

  return (
    <ConversationProvider>
      <ProductionAcceptanceWorkspace />
    </ConversationProvider>
  );
}
