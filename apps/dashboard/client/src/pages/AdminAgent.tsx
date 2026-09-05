import { useState } from "react";
import {
  Clock3,
  Coins,
  FileUp,
  MessageSquare,
  Paperclip,
  Settings,
  Sparkles,
  Trash2,
} from "lucide-react";

import { useAuth } from "@/_core/hooks/useAuth";
import PortalShell from "@/components/PortalShell";
import Home from "@/pages/Home";
import { Button } from "@/components/ui/button";
import { isSystemAdminAccount } from "@/lib/admin-access";
import type { PreviewAdminAccessLevel } from "@/lib/preview-navigation";
import { getAdminNav, getPreviewAdminNav } from "@/pages/AdminDashboard";

type AdminAgentProps = {
  preview?: boolean;
  previewAccessLevel?: PreviewAdminAccessLevel;
};

const previewConversations = [
  {
    id: "preview-conversation-1",
    title: "官网资料核验与整理",
    time: "10:24",
    status: "已完成",
    prompt: "请核验官网最近更新的产品资料，并整理需要补充证据的内容。",
  },
  {
    id: "preview-conversation-2",
    title: "行业信息调研",
    time: "昨天",
    status: "已完成",
    prompt: "汇总本周行业公开信息，并输出一份带来源的简报。",
  },
] as const;

/**
 * Administrator-owned FrontMind Agent.
 *
 * The live variant mounts the same Home workspace used by the real Agent so
 * cloud conversations, tasks, files, model selection and settings continue to
 * use the signed-in administrator's identity. The preview variant is an
 * isolated, read-only adapter and never calls the live conversation APIs.
 */
export default function AdminAgent({
  preview = false,
  previewAccessLevel = "delivery_admin",
}: AdminAgentProps) {
  const previewMode = import.meta.env.DEV && preview;
  const { user } = useAuth();
  const previewSystemAdmin = previewAccessLevel === "system_admin";
  const navItems = previewMode
    ? getPreviewAdminNav(previewSystemAdmin)
    : getAdminNav(isSystemAdminAccount(user));

  return (
    <PortalShell
      mode="fullscreen"
      eyebrow="FrontMind 管理中心 · Agent 与资源"
      title="FrontMind Agent"
      navItems={navItems}
      accountLabel={
        previewMode
          ? `${previewSystemAdmin ? "系统管理员" : "交付管理员"}验收账号`
          : undefined
      }
      roleLabel={
        previewMode
          ? `${previewSystemAdmin ? "系统管理员" : "交付管理员"} · 只读验收预览`
          : undefined
      }
    >
      <AgentViewport>
        {previewMode ? (
          <PreviewAgentWorkspace />
        ) : (
          <Home
            embedded
            hidePortalNavigation
            showKnowledgeBaseStarter={false}
            showAccountMenu={false}
            standardWelcomeVariant="workflow"
          />
        )}
      </AgentViewport>
    </PortalShell>
  );
}

function AgentViewport({ children }: { children: React.ReactNode }) {
  return (
    <section
      aria-label="FrontMind Agent 工作区"
      className="h-full min-h-0 overflow-hidden bg-white"
    >
      {children}
    </section>
  );
}

function PreviewAgentWorkspace() {
  const [activeId, setActiveId] = useState<string>(previewConversations[0].id);
  const activeConversation =
    previewConversations.find((conversation) => conversation.id === activeId) ??
    previewConversations[0];

  return (
    <div className="flex h-full min-h-0 overflow-hidden bg-[#faf8f5]">
      <aside className="hidden w-[272px] shrink-0 flex-col border-r border-[#e4ded8] bg-white/80 md:flex">
        <div className="border-b border-[#e8e2dc] px-4 py-4">
          <div className="flex items-center gap-3">
            <span className="flex h-9 w-9 items-center justify-center rounded-xl bg-[#5b2a86] text-white">
              <Sparkles className="h-4 w-4" />
            </span>
            <div>
              <p className="text-sm font-semibold text-[#211a2d]">
                FrontMind Agent
              </p>
              <p className="mt-0.5 text-xs text-[#8b8492]">只读预览</p>
            </div>
          </div>
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled
            className="mt-4 w-full justify-start gap-2"
          >
            <MessageSquare className="h-4 w-4" />
            新建会话
          </Button>
        </div>

        <div className="min-h-0 flex-1 space-y-1 overflow-y-auto p-2">
          {previewConversations.map((conversation) => (
            <button
              key={conversation.id}
              type="button"
              onClick={() => setActiveId(conversation.id)}
              className={`group w-full rounded-xl px-3 py-3 text-left transition ${
                activeId === conversation.id
                  ? "bg-[#5b2a86]/10 text-[#321b4d]"
                  : "text-[#716a80] hover:bg-[#f3eef6]"
              }`}
            >
              <div className="flex items-start gap-2">
                <MessageSquare className="mt-0.5 h-4 w-4 shrink-0" />
                <div className="min-w-0 flex-1">
                  <p className="truncate text-xs font-medium">
                    {conversation.title}
                  </p>
                  <p className="mt-1 text-xs opacity-55">
                    {conversation.time} · {conversation.status}
                  </p>
                </div>
                <Trash2 className="h-3.5 w-3.5 shrink-0 opacity-25" />
              </div>
            </button>
          ))}
        </div>

        <div className="space-y-2 border-t border-[#e8e2dc] p-3 text-xs text-[#716a80]">
          <div className="flex items-center justify-between rounded-lg bg-[#f6f1f8] px-3 py-2">
            <span className="flex items-center gap-2">
              <Coins className="h-3.5 w-3.5 text-[#8c6412]" />
              可用积分
            </span>
            <strong className="text-[#5b2a86]">128,400</strong>
          </div>
          <div className="flex items-center gap-2 px-3 py-2">
            <Settings className="h-3.5 w-3.5" />
            设置与积分记录
          </div>
        </div>
      </aside>

      <main className="relative flex min-w-0 flex-1 flex-col">
        <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(800px_circle_at_45%_4%,rgba(91,42,134,.08),transparent_55%)]" />
        <header className="relative z-10 flex items-center justify-between gap-3 border-b border-[#e8e2dc] bg-white/75 py-3 pl-20 pr-4 backdrop-blur sm:px-6">
          <div className="min-w-0">
            <p className="truncate text-sm font-semibold text-[#221a33]">
              {activeConversation.title}
            </p>
            <p className="mt-1 flex items-center gap-1 text-xs text-[#857e91]">
              <Clock3 className="h-3 w-3" />
              最近任务耗时 2 分 18 秒
            </p>
          </div>
          <span className="rounded-full border border-[#dcd1e5] bg-white px-3 py-1.5 text-xs font-medium text-[#5b2a86]">
            FrontMind Pro
          </span>
        </header>

        <div className="relative z-10 flex-1 overflow-y-auto px-4 py-8 sm:px-8">
          <div className="mx-auto max-w-3xl space-y-5">
            <div className="flex justify-end">
              <div className="max-w-[86%] rounded-2xl rounded-br-md bg-[#5b2a86] px-4 py-3 text-sm leading-7 text-white shadow-sm">
                {activeConversation.prompt}
              </div>
            </div>
            <div className="flex justify-start">
              <div className="max-w-[90%] rounded-2xl rounded-bl-md border border-[#e4ded8] bg-white px-5 py-4 text-sm leading-7 text-[#4f485c] shadow-sm">
                这是隔离的只读预览。正式页面会使用当前管理员自己的 API Key
                与云端会话，并在这里持续显示任务状态、执行时间、引用结果和可下载文件。
                <div className="mt-4 flex flex-wrap gap-2 text-xs text-[#716a80]">
                  <span className="inline-flex items-center gap-1 rounded-lg bg-[#f3eef6] px-2.5 py-1.5">
                    <FileUp className="h-3.5 w-3.5" />
                    调研简报.md
                  </span>
                  <span className="inline-flex items-center gap-1 rounded-lg bg-[#f3eef6] px-2.5 py-1.5">
                    <Clock3 className="h-3.5 w-3.5" />2 分 18 秒
                  </span>
                </div>
              </div>
            </div>
          </div>
        </div>

        <div className="relative z-10 border-t border-[#e8e2dc] bg-white/90 p-4 sm:px-6">
          <div className="mx-auto flex max-w-3xl items-center gap-2 rounded-2xl border border-[#dcd1e5] bg-[#fbf9fd] p-2">
            <Button
              type="button"
              size="icon"
              variant="ghost"
              disabled
              aria-label="上传文件（预览）"
              className="shrink-0"
            >
              <Paperclip className="h-4 w-4" />
            </Button>
            <div className="min-w-0 flex-1 px-1 text-sm text-[#9a94a8]">
              只读预览不会创建任务或写入会话
            </div>
            <Button type="button" size="sm" disabled>
              发送
            </Button>
          </div>
        </div>
      </main>
    </div>
  );
}
