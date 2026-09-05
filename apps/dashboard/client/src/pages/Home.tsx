/**
 * Home Page - Main application layout
 * Design: Fluid Glass Workspace - Glassmorphism + Spatial Design
 * Layout: Left sidebar (conversation history) + Center chat area
 * Background: Subtle gradient with generated hero image overlay
 */
import { useState, useCallback } from "react";
import Sidebar from "@/components/Sidebar";
import ChatArea from "@/components/ChatArea";
import SettingsDialog from "@/components/SettingsDialog";
import { useKeyboardShortcuts } from "@/hooks/useKeyboardShortcuts";
import { useConversation } from "@/contexts/ConversationContext";
import { useIsMobile } from "@/hooks/useMobile";
import { Button } from "@/components/ui/button";
import { CloudOff, Loader2, RefreshCw, X } from "lucide-react";
import type { ResponseLogicTaskContext } from "@/lib/frontmind-api";
import type { KnowledgeBaseProgressDto } from "@shared/knowledge-base-progress";

export default function Home({
  embedded = false,
  fixedAgentProfile,
  syncKnowledgeBaseSnapshot = false,
  composerPrefill,
  hideSidebar = false,
  hidePortalNavigation = false,
  showKnowledgeBaseStarter = true,
  showAccountMenu = true,
  showSettings = true,
  standardWelcomeVariant = "simple",
  responseLogicContext,
  knowledgeBaseProgress,
}: {
  embedded?: boolean;
  fixedAgentProfile?: string;
  syncKnowledgeBaseSnapshot?: boolean;
  composerPrefill?: string;
  hideSidebar?: boolean;
  hidePortalNavigation?: boolean;
  showKnowledgeBaseStarter?: boolean;
  showAccountMenu?: boolean;
  showSettings?: boolean;
  standardWelcomeVariant?: "simple" | "workflow";
  responseLogicContext?: ResponseLogicTaskContext;
  knowledgeBaseProgress?: KnowledgeBaseProgressDto | null;
} = {}) {
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const {
    createConversation,
    hydrated,
    loading,
    syncError,
    refreshConversations,
    clearSyncError,
  } = useConversation();
  const isMobile = useIsMobile();

  useKeyboardShortcuts({
    onNewChat: useCallback(() => {
      if (hydrated && !hideSidebar) createConversation();
    }, [createConversation, hideSidebar, hydrated]),
    onSettings: useCallback(() => setSettingsOpen(true), []),
    onToggleSidebar: useCallback(() => {
      if (!isMobile && !hideSidebar) setSidebarCollapsed((p) => !p);
    }, [hideSidebar, isMobile]),
  });

  if (!hydrated) {
    return (
      <div
        className={`flex items-center justify-center bg-background p-4 ${
          embedded ? "h-full w-full" : "h-[100dvh] w-screen"
        }`}
      >
        <div className="glass-card w-full max-w-sm rounded-2xl p-7 text-center">
          {loading ? (
            <Loader2 className="mx-auto h-7 w-7 animate-spin text-primary" />
          ) : (
            <CloudOff className="mx-auto h-8 w-8 text-destructive" />
          )}
          <h1 className="mt-4 text-lg font-semibold">
            {loading
              ? hideSidebar
                ? "正在加载知识库工作台"
                : "正在加载云端会话"
              : hideSidebar
                ? "知识库工作台尚未加载"
                : "云端会话尚未加载"}
          </h1>
          <p className="mt-2 break-words text-sm text-muted-foreground">
            {loading
              ? hideSidebar
                ? "请稍候，正在恢复当前知识库任务。"
                : "请稍候，加载完成前不会创建仅保存在本机的会话。"
              : syncError || "请检查网络或数据库连接后重试。"}
          </p>
          {!loading && (
            <Button
              className="mt-5"
              variant="outline"
              onClick={() => void refreshConversations()}
            >
              <RefreshCw className="h-4 w-4" />
              重新加载
            </Button>
          )}
        </div>
      </div>
    );
  }

  return (
    <div
      className={`flex overflow-hidden relative bg-background ${
        embedded ? "h-full w-full" : "h-[100dvh] w-screen"
      }`}
    >
      {/* Premium calm workspace background */}
      <div
        className="absolute inset-0 pointer-events-none"
        style={{
          background: `radial-gradient(900px circle at 22% 12%, oklch(0.93 0.018 90 / 55%) 0%, transparent 54%),
                       radial-gradient(760px circle at 85% 8%, oklch(0.86 0.035 178 / 28%) 0%, transparent 48%),
                       linear-gradient(180deg, oklch(0.988 0.006 83) 0%, oklch(0.965 0.011 83) 100%)`,
        }}
      />

      {syncError && (
        <div className="absolute left-1/2 top-3 z-[70] flex w-[min(92vw,560px)] -translate-x-1/2 items-center gap-2 rounded-xl border border-amber-300/70 bg-amber-50/95 px-3 py-2 text-xs text-amber-950 shadow-lg backdrop-blur">
          <CloudOff className="h-4 w-4 shrink-0" />
          <span className="min-w-0 flex-1 truncate">
            会话同步失败：{syncError}
          </span>
          <Button
            size="sm"
            variant="ghost"
            className="h-7 px-2"
            onClick={() => void refreshConversations()}
          >
            重试
          </Button>
          <button
            type="button"
            aria-label="关闭同步提示"
            className="rounded p-1 hover:bg-amber-100"
            onClick={clearSyncError}
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </div>
      )}

      {/* Sidebar */}
      {!hideSidebar && (
        <Sidebar
          collapsed={sidebarCollapsed}
          onToggle={() => setSidebarCollapsed((p) => !p)}
          onOpenSettings={() => setSettingsOpen(true)}
          embedded={embedded}
          hidePortalNavigation={hidePortalNavigation}
          showAccountMenu={showAccountMenu}
          showSettings={showSettings}
        />
      )}

      {/* Main content */}
      <main className="flex-1 flex flex-col relative z-10">
        <ChatArea
          fixedAgentProfile={fixedAgentProfile}
          syncKnowledgeBaseSnapshot={syncKnowledgeBaseSnapshot}
          composerPrefill={composerPrefill}
          responseLogicContext={responseLogicContext}
          knowledgeBaseProgress={knowledgeBaseProgress}
          showKnowledgeBaseStarter={showKnowledgeBaseStarter}
          standardWelcomeVariant={standardWelcomeVariant}
          reserveOuterMobileNav={!showAccountMenu}
        />
      </main>

      {/* Settings dialog */}
      {showSettings && (
        <SettingsDialog open={settingsOpen} onOpenChange={setSettingsOpen} />
      )}
    </div>
  );
}
