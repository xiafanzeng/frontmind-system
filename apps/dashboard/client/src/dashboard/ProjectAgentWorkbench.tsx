import { Suspense, lazy, useState, type ReactNode } from "react";
import { Check, ChevronDown, MessageSquare, Plus, Trash2 } from "lucide-react";
import {
  ConversationContextProvider,
  ConversationPurposeProvider,
  useConversation,
} from "@/contexts/ConversationContext";
import { AgentWorkbenchShell } from "@/components/AgentWorkbenchShell";
import { Button } from "@/components/ui/button";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { requestWorkspaceNavigation } from "@/lib/workspace-navigation-guard";
import { projectResourceUrl } from "@/lib/enterprise-project";
import { useWorkbenchModule, workbenchStatus } from "./agent-workbench";

const Home = lazy(() => import("@/pages/Home"));
const descriptions: Record<string, string> = {
  brand: "围绕企业事实、产品与品牌定位开展对话，知识库和词库在成果区同步查看。",
  intent: "梳理客户的真实问题，进入优化问题与应答逻辑，逐项确认品牌回答。",
  progress: "分析品牌表现与待改进的问题，打开监控和报告查看数据依据。",
  content: "从选题、内容策略到稿件制作，在这里持续推进内容任务。",
  publishing: "准备发布内容，选择媒体，并在成果区跟进稿件和发布进度。",
  extensions: "使用企业问答、网站管理与内容分析，继续完善品牌的 AI 入口。",
};
function outputUrl(value: string) {
  try {
    const url = new URL(value, window.location.origin);
    return ["http:", "https:"].includes(url.protocol)
      ? projectResourceUrl(value)
      : null;
  } catch {
    return null;
  }
}

function ProjectConversation({
  purpose,
}: {
  purpose: "general" | "enterprise_qa";
}) {
  const module = useWorkbenchModule();
  const {
    state,
    activeConversation,
    createConversation,
    setActive,
    deleteConversation,
    hydrated,
  } = useConversation();
  const taggedConversations = module
    ? state.conversations.filter(
        (conversation) => conversation.workbenchAgentId === module.id,
      )
    : [];
  // Legacy general conversations remain visible until this subagent has its
  // first tagged task; new tasks are always isolated by workbenchAgentId.
  const conversations =
    taggedConversations.length > 0
      ? taggedConversations
      : state.conversations.filter((conversation) => !conversation.workbenchAgentId);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [historyQuery, setHistoryQuery] = useState("");
  const formatTime = (ts: number) => {
    const date = new Date(ts);
    const now = new Date();
    return date.toDateString() === now.toDateString()
      ? date.toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" })
      : date.toLocaleDateString("zh-CN", { month: "short", day: "numeric" });
  };
  const statusLabel: Record<string, string> = {
    running: "执行中",
    pending: "准备中",
    awaiting_input: "等待确认",
    completed: "已完成",
    failed: "失败",
    error: "失败",
    idle: "就绪",
  };
  const visibleConversations = conversations.filter((conversation) =>
    conversation.title.toLocaleLowerCase().includes(historyQuery.trim().toLocaleLowerCase()),
  );
  return (
    <div className="workbench-conversation">
      <div className="workbench-conversation__toolbar">
        <Popover open={historyOpen} onOpenChange={setHistoryOpen}>
          <PopoverTrigger asChild>
            <input
              readOnly
              role="combobox"
              aria-label="当前对话"
              aria-haspopup="listbox"
              aria-expanded={historyOpen}
              value={activeConversation?.title ?? "开始一个新任务"}
              className="workbench-conversation__history-trigger"
            />
          </PopoverTrigger>
          <PopoverContent
            align="start"
            className="workbench-conversation__history-popover"
          >
            <div className="workbench-conversation__history-heading">
              <span>任务历史</span>
              <span>{conversations.length} 个任务</span>
            </div>
            <input
              aria-label="搜索任务"
              className="workbench-conversation__history-search"
              placeholder="搜索任务"
              value={historyQuery}
              onChange={(event) => setHistoryQuery(event.target.value)}
            />
            <div role="listbox" aria-label="任务历史">
              {visibleConversations.map((conversation) => (
                <div
                  key={conversation.id}
                  role="option"
                  aria-selected={conversation.id === activeConversation?.id}
                  className="workbench-conversation__history-item"
                >
                  <button
                    type="button"
                    onClick={() => {
                      requestWorkspaceNavigation(() => setActive(conversation.id));
                      setHistoryOpen(false);
                    }}
                  >
                    <MessageSquare className="size-4" />
                    <span className="workbench-conversation__history-copy">
                      <strong>{conversation.title}</strong>
                      <small>
                        {statusLabel[conversation.status] ?? "就绪"} · {formatTime(conversation.updatedAt)}
                        {(conversation.messages?.length ?? 0) > 0 &&
                          ` · ${conversation.messages?.length ?? 0} 条`}
                      </small>
                    </span>
                    {conversation.id === activeConversation?.id && (
                      <Check className="size-4" aria-label="当前任务" />
                    )}
                  </button>
                  {deleteConversation && (
                    <button
                      type="button"
                      className="workbench-conversation__history-delete"
                      aria-label={`删除任务 ${conversation.title}`}
                      onClick={(event) => {
                        event.stopPropagation();
                        deleteConversation(conversation.id);
                      }}
                    >
                      <Trash2 className="size-3.5" />
                    </button>
                  )}
                </div>
              ))}
              {!visibleConversations.length && (
                <p className="workbench-conversation__history-empty">暂无任务历史</p>
              )}
            </div>
          </PopoverContent>
        </Popover>
        <ChevronDown className="workbench-conversation__history-chevron size-4" aria-hidden="true" />
        <Button
          variant="ghost"
          size="sm"
          disabled={!hydrated}
          onClick={() =>
            requestWorkspaceNavigation(() =>
              createConversation({
                reuseEmpty: false,
                title: module ? `${module.label}任务` : "新任务",
                workbenchAgentId: module?.id,
              }),
            )
          }
        >
          <Plus className="size-3.5" />
          新任务
        </Button>
      </div>
      {module && !activeConversation?.messages.length && (
        <p className="workbench-conversation__intro">
          {descriptions[module.id]}
        </p>
      )}
      <div className="workbench-conversation__chat">
        {module && purpose === "general" ? (
          <div className="workbench-conversation__context-note">
            <strong>当前步骤</strong>
            <p>主工作区中的业务内容会随操作逐步展开。这里保留本子 Agent 的任务上下文。</p>
          </div>
        ) : (
          <Suspense
            fallback={
              <div role="status" className="p-5">
                正在恢复对话…
              </div>
            }
          >
            <Home
              embedded
              hideSidebar
              operatorWorkspace
              hidePortalNavigation
              showKnowledgeBaseStarter={false}
              showAccountMenu={false}
              showSettings={false}
              purpose={purpose === "enterprise_qa" ? "enterprise_qa" : undefined}
              standardWelcomeVariant={
                purpose === "enterprise_qa" ? "enterprise_qa" : "simple"
              }
            />
          </Suspense>
        )}
      </div>
    </div>
  );
}
function ScopedWorkbench({
  projectId,
  purpose,
  children,
}: {
  projectId: string;
  purpose: "general" | "enterprise_qa";
  children?: ReactNode;
}) {
  const module = useWorkbenchModule();
  const { activeConversation } = useConversation();
  const files = (activeConversation?.messages ?? [])
    .filter((message) => message.role === "assistant")
    .flatMap((message) =>
      (message.outputFiles ?? []).map((file) => ({
        ...file,
        messageId: message.id,
      })),
    );
  const uniqueFiles = files.filter(
    (file, index) =>
      files.findIndex((candidate) => candidate.fileUrl === file.fileUrl) ===
      index,
  );
  return (
    <AgentWorkbenchShell
      embedded
      projectId={projectId}
      moduleId={module?.id ?? "general"}
      title={module?.label ?? "通用智能体"}
      resultTitle={module?.resultTitle ?? "任务成果"}
      status={workbenchStatus(activeConversation?.status)}
      showResult={purpose === "enterprise_qa" || Boolean(module)}
      resultKey={`${activeConversation?.id ?? "new"}:${uniqueFiles.map((file) => `${file.messageId}:${file.fileUrl}`).join("|")}`}
      conversation={<ProjectConversation purpose={purpose} />}
      result={
        <>
          <section className="workbench-task-files" aria-label="当前任务成果">
            <h3>
              {activeConversation?.title ?? "当前任务"}{" "}
              <span className="font-normal text-muted-foreground">
                · {workbenchStatus(activeConversation?.status)}
              </span>
            </h3>
            {uniqueFiles.map((file) => {
              const href = outputUrl(file.fileUrl);
              return href ? (
                <a
                  key={file.fileUrl}
                  href={href}
                  target="_blank"
                  rel="noreferrer"
                >
                  {file.fileName}
                </a>
              ) : (
                <p key={file.fileUrl}>{file.fileName}</p>
              );
            })}
            {!uniqueFiles.length && !children && (
              <p className="text-sm text-muted-foreground">
                任务生成的文件将显示在这里。
              </p>
            )}
          </section>
          {children}
        </>
      }
    />
  );
}
export default function ProjectAgentWorkbench({
  projectId,
  purpose = "general",
  children,
}: {
  projectId: string;
  purpose?: "general" | "enterprise_qa";
  children?: ReactNode;
}) {
  const workspace = useConversation();
  // Module editors (for example response logic) need the full project scope.
  // Only the central dialogue and its files use the filtered chat purpose.
  return (
    <ConversationPurposeProvider purpose={purpose}>
      <ScopedWorkbench projectId={projectId} purpose={purpose}>
        {children &&
          (purpose === "enterprise_qa" ? (
            children
          ) : (
            <ConversationContextProvider value={workspace}>
              {children}
            </ConversationContextProvider>
          ))}
      </ScopedWorkbench>
    </ConversationPurposeProvider>
  );
}
