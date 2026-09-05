/**
 * ChatArea Component - Main chat interface
 * Design: Glassmorphism cards, fluid animations, spacious layout.
 * Features: Message display, file/image attachments, status indicators,
 *           local PDF.js reader, inline Markdown reader, HTML file preview.
 */
import React, { useRef, useEffect, useState, useCallback } from "react";
import {
  useConversation,
  type Attachment,
  type KnowledgeBaseClientNotice,
  type LocalMessage,
} from "@/contexts/ConversationContext";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Badge } from "@/components/ui/badge";
import { motion, AnimatePresence } from "framer-motion";
import {
  ExternalLink,
  FileText,
  Download,
  Clock,
  CheckCircle2,
  AlertCircle,
  Loader2,
  Bot,
  MessageSquareText,
  User,
  Sparkles,
  Copy,
  Trash2,
  MoreHorizontal,
  X,
  BookOpen,
  UploadCloud,
} from "lucide-react";
import { cn, copyToClipboard } from "@/lib/utils";
import {
  creditEventBus,
  deliveryProjectHeaders,
  getModelDisplayName,
  sanitizeBrandText,
  uploadFile,
  type OutputMessage,
  type ResponseLogicTaskContext,
} from "@/lib/frontmind-api";
import ChatInput from "./ChatInput";
import type { KnowledgeBaseProgressDto } from "@shared/knowledge-base-progress";
import { KNOWLEDGE_COLLECTION_STATUS_COPY } from "@shared/knowledge-base-copy";
import MarkdownRenderer from "./MarkdownRenderer";
import ImagePreview from "./ImagePreview";
import FilePreview from "./FilePreview";
import MessageActions from "./MessageActions";
import { toast } from "sonner";
import TypingIndicator, { PulsingDot } from "./TypingIndicator";
import IntermediateSteps from "./IntermediateSteps";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import type { KnowledgeBaseInteractionDto } from "@shared/knowledge-base-progress";
import { trpc } from "@/lib/trpc";
import {
  knowledgeBaseObservationFromPayload,
  reconcileKnowledgeBaseObservation,
  retryKnowledgeBaseTurn,
  type KnowledgeBaseObservationDto,
} from "@/lib/knowledge-progress";
import {
  assertChatAttachmentSizes,
  chatAttachmentSizeError,
  normalizedKnowledgeBaseUploadFilename,
} from "@/lib/attachment-files";
import { isAttachmentExpired } from "@/lib/attachment-expiry";

export const KNOWLEDGE_BASE_FOUNDATION_COPY =
  "企业知识库是品牌事实与产品信息的统一底稿，也是构建 AI 专用友好官网、生成内容与准确回答客户问题的基础。";

export function runningAssistantStatusText(syncKnowledgeBaseSnapshot: boolean) {
  return syncKnowledgeBaseSnapshot
    ? KNOWLEDGE_COLLECTION_STATUS_COPY
    : "FrontMind AI 正在处理...";
}

export const KNOWLEDGE_BASE_PACKAGE_REBIND_NOTICE_CODE =
  "PACKAGE_REBIND_REQUIRED";
export const KNOWLEDGE_BASE_INTERNAL_ATTACHMENT_NOTICE_CODE =
  "KNOWLEDGE_BASE_ATTACHMENTS_REQUIRED";

export function shouldRenderKnowledgeBaseNotice(
  notice: Pick<KnowledgeBaseClientNotice, "code">,
) {
  return notice.code !== KNOWLEDGE_BASE_INTERNAL_ATTACHMENT_NOTICE_CODE;
}

export function knowledgeBaseNoticeRecoveryMode(
  notice: Pick<KnowledgeBaseClientNotice, "code">,
) {
  return notice.code === KNOWLEDGE_BASE_PACKAGE_REBIND_NOTICE_CODE
    ? ("reconcile" as const)
    : ("new_turn" as const);
}

export function knowledgeBaseNoticeRetryLabel(
  notice: Pick<KnowledgeBaseClientNotice, "code">,
) {
  return knowledgeBaseNoticeRecoveryMode(notice) === "reconcile"
    ? "重新绑定成品"
    : "重试本轮";
}

export function knowledgeBasePackageRebindResolved(
  observation: KnowledgeBaseObservationDto,
) {
  return (
    observation.notice?.code !== KNOWLEDGE_BASE_PACKAGE_REBIND_NOTICE_CODE &&
    observation.interaction.interactionState === "ready_to_publish" &&
    Boolean(observation.package)
  );
}

/**
 * PACKAGE_REBIND_REQUIRED is repaired by rereading the existing authoritative
 * task. It must never reserve a new turn or submit another billable request.
 */
export async function recoverKnowledgeBaseNotice(
  input: {
    conversationId: string;
    notice: Pick<KnowledgeBaseClientNotice, "code">;
    clientRequestId: string;
    expectedGeneration: number;
    expectedRevision: number;
    expectedLeafId: string | null;
  },
  dependencies: {
    reconcile?: typeof reconcileKnowledgeBaseObservation;
    retry?: typeof retryKnowledgeBaseTurn;
  } = {},
): Promise<KnowledgeBaseObservationDto> {
  if (knowledgeBaseNoticeRecoveryMode(input.notice) === "reconcile") {
    return (dependencies.reconcile ?? reconcileKnowledgeBaseObservation)({
      conversationId: input.conversationId,
    });
  }
  return (dependencies.retry ?? retryKnowledgeBaseTurn)({
    conversationId: input.conversationId,
    clientRequestId: input.clientRequestId,
    expectedGeneration: input.expectedGeneration,
    expectedRevision: input.expectedRevision,
    expectedLeafId: input.expectedLeafId,
  });
}

const EMPTY_STATE_IMG =
  "https://d2xsxph8kpxj0f.cloudfront.net/310519663465762565/ZiWzJwHCXtKB4GziVKqKt6/fm-logo_cde8eb94.png";

const PdfDocumentViewer = React.lazy(() => import("./PdfDocumentViewer"));

type ReportTaskStatus =
  | "idle"
  | "running"
  | "pending"
  | "completed"
  | "error"
  | "failed";

interface OneClickTaskStartResponse {
  visibleMessage?: string;
  startedAt?: number;
  progress?: KnowledgeBaseProgressDto;
  interaction?: KnowledgeBaseInteractionDto;
  observation?: KnowledgeBaseObservationDto;
  task?: {
    id: string;
    status: ReportTaskStatus;
    taskUrl?: string;
    title?: string;
    output?: OutputMessage[];
  };
}

interface DeepReportStartInput {
  companyName: string;
  companyWebsite?: string;
  operatorNotes?: string;
  agentProfile?: string;
  files: File[];
}

type KnowledgeBaseStartRequestError = Error & {
  status?: number;
  code?: string;
  reservationCreated?: boolean;
  observation?: KnowledgeBaseObservationDto;
};

export async function readKnowledgeBaseStartRequestError(
  response: Response,
): Promise<KnowledgeBaseStartRequestError> {
  try {
    const data = await response.json();
    const errorNode =
      data?.error && typeof data.error === "object" ? data.error : null;
    const message =
      (typeof data.error === "string" ? data.error : data.error?.message) ||
      data.message ||
      `请求失败 (${response.status})`;
    const error = new Error(message) as KnowledgeBaseStartRequestError;
    error.status = response.status;
    error.code =
      String(errorNode?.code || data?.code || "").trim() || undefined;
    if (typeof data?.reservationCreated === "boolean") {
      error.reservationCreated = data.reservationCreated;
    }
    if (data?.observation) {
      try {
        error.observation = knowledgeBaseObservationFromPayload(data);
      } catch {
        // The HTTP error remains actionable even if an optional observation is malformed.
      }
    }
    return error;
  } catch {
    const error = new Error(
      `请求失败 (${response.status})`,
    ) as KnowledgeBaseStartRequestError;
    error.status = response.status;
    return error;
  }
}

export function shouldRecoverKnowledgeBaseStartFailure(
  requestDispatched: boolean,
  error: Pick<
    KnowledgeBaseStartRequestError,
    "status" | "code" | "reservationCreated"
  >,
) {
  if (!requestDispatched) return false;
  if (error.reservationCreated === true) return true;
  if (error.reservationCreated === false) return false;
  if (error.code === "KNOWLEDGE_BASE_ROLLOUT_PENDING") return false;
  const status = Number(error.status || 0);
  return !status || status === 408 || status === 429 || status >= 500;
}

/**
 * Filter out "等待用户输入" text from assistant messages (req 8)
 */
function filterWaitingText(content: string): string {
  if (!content || typeof content !== "string") return content || "";
  try {
    return content
      .replace(/^等待用户输入[。.…]*$/gm, "")
      .replace(/等待用户输入[。.…]*/g, "")
      .trim();
  } catch (e) {
    console.error("[filterWaitingText] Error:", e);
    return content;
  }
}

/**
 * Fetch a file URL with auth headers and return a blob URL.
 * Works for both /api/frontmind/v1/files/ URLs, proxy-download URLs, and external URLs.
 *
 * The server proxy now handles:
 * - /v1/files/:id → fetches metadata, then downloads binary from S3
 * - /proxy-download?url=... → proxies binary from external URLs
 * So this function should receive proper binary content.
 */
function buildProxyDownloadUrl(
  fileUrl: string,
  fileName?: string,
  asDownload = false,
): string | null {
  try {
    const parsed = new URL(fileUrl, window.location.origin);
    if (parsed.pathname.endsWith("/api/frontmind/proxy-download")) {
      if (fileName)
        parsed.searchParams.set("filename", sanitizeBrandText(fileName));
      if (asDownload) parsed.searchParams.set("download", "1");
      return `${parsed.pathname}${parsed.search}`;
    }
    if (/^https?:\/\//i.test(fileUrl)) {
      const params = new URLSearchParams({ url: fileUrl });
      if (fileName) params.set("filename", sanitizeBrandText(fileName));
      if (asDownload) params.set("download", "1");
      return `/api/frontmind/proxy-download?${params.toString()}`;
    }
  } catch {
    // Ignore malformed URLs and keep the normal proxy path.
  }
  return null;
}

function nativeDownload(url: string, fileName: string) {
  const a = document.createElement("a");
  a.href = url;
  a.download = fileName;
  a.rel = "noopener";
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
}

/**
 * Fetch a file URL with auth headers and return a blob URL.
 * External signed URLs are normalized to the same-origin proxy so file content
 * and response headers can be sanitized before the browser renders or downloads them.
 */
async function fetchWithAuth(
  fileUrl: string,
  fileName?: string,
): Promise<string> {
  const normalizedUrl =
    buildProxyDownloadUrl(fileUrl, fileName, false) || fileUrl;

  const response = await fetch(normalizedUrl, {
    credentials: "include",
    headers: deliveryProjectHeaders(),
  });

  if (!response.ok) {
    throw new Error(`文件读取失败（HTTP ${response.status}）`);
  }

  // Safety check: if we got JSON instead of binary, it might be metadata
  const contentType = response.headers.get("content-type") || "";
  if (
    contentType.includes("application/json") &&
    normalizedUrl.includes("/v1/files/")
  ) {
    // upload_url is a PUT-only capability. Treat metadata here as a server
    // contract failure; never turn it into an unauthenticated GET fallback.
    await response.body?.cancel().catch(() => undefined);
    throw new Error("服务返回了文件信息，但未返回文件内容");
  }

  const blob = await response.blob();
  return URL.createObjectURL(blob);
}

export default function ChatArea({
  fixedAgentProfile,
  syncKnowledgeBaseSnapshot = false,
  composerPrefill,
  responseLogicContext,
  showKnowledgeBaseStarter = true,
  standardWelcomeVariant = "simple",
  reserveOuterMobileNav = false,
  knowledgeBaseProgress,
}: {
  fixedAgentProfile?: string;
  syncKnowledgeBaseSnapshot?: boolean;
  composerPrefill?: string;
  responseLogicContext?: ResponseLogicTaskContext;
  showKnowledgeBaseStarter?: boolean;
  standardWelcomeVariant?: "simple" | "workflow";
  reserveOuterMobileNav?: boolean;
  knowledgeBaseProgress?: KnowledgeBaseProgressDto | null;
}) {
  const {
    activeConversation,
    deleteConversation,
    deleteMessage,
    addMessage,
    updateStatus,
    updateTitle,
    registerKnowledgeBaseConversation,
    wakeKnowledgeBaseConversation,
    commitKnowledgeBaseObservation,
    settleKnowledgeBaseStartFailure,
    discardConversationLocally,
  } = useConversation();
  const dashboardQuery = trpc.workspace.dashboard.useQuery(undefined, {
    enabled: !responseLogicContext && showKnowledgeBaseStarter,
    retry: false,
    refetchOnWindowFocus: true,
    staleTime: 30_000,
  });
  const bottomRef = useRef<HTMLDivElement>(null);

  const [, setTick] = useState(0);
  const [retryingKnowledgeBase, setRetryingKnowledgeBase] = useState(false);

  const status = activeConversation?.status;
  const startedAt = activeConversation?.startedAt;
  const completedAt = activeConversation?.completedAt;

  useEffect(() => {
    if (!syncKnowledgeBaseSnapshot || !activeConversation?.id) return;
    registerKnowledgeBaseConversation(activeConversation.id);
    if (activeConversation.taskId || knowledgeBaseProgress) {
      wakeKnowledgeBaseConversation(activeConversation.id);
    }
  }, [
    activeConversation?.id,
    activeConversation?.taskId,
    knowledgeBaseProgress,
    registerKnowledgeBaseConversation,
    syncKnowledgeBaseSnapshot,
    wakeKnowledgeBaseConversation,
  ]);

  // Auto-scroll to bottom when new messages arrive
  useEffect(() => {
    const timer = setTimeout(() => {
      bottomRef.current?.scrollIntoView({ behavior: "smooth" });
    }, 100);
    return () => clearTimeout(timer);
  }, [activeConversation?.messages?.length, status]);

  // Force re-render every second when running to update elapsed time
  useEffect(() => {
    if ((status === "running" || status === "pending") && startedAt) {
      const timer = setInterval(() => setTick((t) => t + 1), 1000);
      return () => clearInterval(timer);
    }
  }, [status, startedAt]);

  const startKnowledgeBase = useCallback(
    async ({
      companyName,
      companyWebsite,
      operatorNotes,
      files,
    }: DeepReportStartInput) => {
      if (!activeConversation) return;

      const selectedAgentProfile = "frontmind-pro";

      const conversationId = activeConversation.id;
      const responseStartedAt = Date.now();
      const clientRequestId =
        typeof crypto !== "undefined" && "randomUUID" in crypto
          ? crypto.randomUUID()
          : `kb-start-${responseStartedAt}-${Math.random().toString(36).slice(2, 10)}`;
      let requestDispatched = false;

      try {
        assertChatAttachmentSizes(files);
        const uploadedAttachments: Array<{
          file_id: string;
          filename: string;
        }> = [];
        const messageAttachments: Attachment[] = [];
        for (const file of files) {
          const uploaded = await uploadFile(file, undefined, undefined, {
            captureLocalCopy: true,
            captureFilename: normalizedKnowledgeBaseUploadFilename(file.name),
          });
          uploadedAttachments.push({
            file_id: uploaded.fileId,
            filename: uploaded.filename,
          });
          messageAttachments.push({
            id: `att-${responseStartedAt}-${messageAttachments.length + 1}`,
            type: "file",
            name: file.name,
            fileId: uploaded.fileId,
            file,
            expiresAt: uploaded.expiresAt,
            expired: false,
          });
        }

        registerKnowledgeBaseConversation(conversationId);

        addMessage(conversationId, {
          id: `msg-kb-start-${responseStartedAt}`,
          role: "user",
          content: "开始构建企业知识库",
          ...(messageAttachments.length > 0
            ? { attachments: messageAttachments }
            : {}),
          timestamp: responseStartedAt,
          knowledgeBase: {
            kind: "pending_user",
            clientRequestId,
          },
        });
        updateTitle(conversationId, "企业知识库构建");

        requestDispatched = true;
        const response = await fetch("/api/knowledge-base/start", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          credentials: "include",
          body: JSON.stringify({
            conversationId,
            clientRequestId,
            companyName,
            companyWebsite,
            operatorNotes,
            agentProfile: selectedAgentProfile,
            attachments: uploadedAttachments,
          }),
        });

        if (!response.ok) {
          throw await readKnowledgeBaseStartRequestError(response);
        }

        const data = (await response.json()) as OneClickTaskStartResponse;
        if (!data.observation && !data.task?.id) {
          throw new Error("任务创建失败：未返回任务 ID");
        }

        const taskStartedAt = data.startedAt || responseStartedAt;
        if (data.observation) {
          commitKnowledgeBaseObservation(
            conversationId,
            knowledgeBaseObservationFromPayload(data),
          );
        } else {
          // Compatibility while the server fleet rolls forward. Never project
          // data.task.output for KB; the coordinator will obtain the approved DTO.
          updateStatus(conversationId, "running", {
            taskId: data.task!.id,
            taskUrl: data.task!.taskUrl,
            previousResponseId: data.task!.id,
            startedAt: taskStartedAt,
          });
        }
        wakeKnowledgeBaseConversation(conversationId);

        toast.success("已开始构建企业知识库", {
          description:
            "系统会先完成研究并建立真实知识树，随后按叶子节点逐项确认。",
          duration: 3200,
        });

        creditEventBus.emit();
      } catch (error: any) {
        const errorMessage = error?.message || "启动失败";
        if (errorMessage.includes("不能超过 100 MB")) {
          toast.error("文件过大", { description: errorMessage });
        } else if (error?.observation) {
          settleKnowledgeBaseStartFailure(conversationId, clientRequestId);
          commitKnowledgeBaseObservation(conversationId, error.observation);
          wakeKnowledgeBaseConversation(conversationId);
          toast.error("启动结果已确认", { description: errorMessage });
        } else if (
          !shouldRecoverKnowledgeBaseStartFailure(requestDispatched, error)
        ) {
          settleKnowledgeBaseStartFailure(conversationId, clientRequestId);
          if (error?.code === "CONVERSATION_RESET") {
            discardConversationLocally(conversationId);
          }
          toast.error("启动失败", { description: errorMessage });
        } else {
          updateStatus(conversationId, "running", {
            startedAt: responseStartedAt,
          });
          wakeKnowledgeBaseConversation(conversationId);
          toast.warning("正在恢复启动结果", {
            description:
              "请求结果暂时未知，系统正在核对服务端是否已受理，不会重复创建知识库任务。",
          });
        }
      }
    },
    [
      activeConversation,
      addMessage,
      commitKnowledgeBaseObservation,
      discardConversationLocally,
      registerKnowledgeBaseConversation,
      settleKnowledgeBaseStartFailure,
      updateStatus,
      updateTitle,
      wakeKnowledgeBaseConversation,
    ],
  );

  const retryCurrentKnowledgeBaseTurn = useCallback(async () => {
    const conversation = activeConversation;
    const knowledgeBase = conversation?.knowledgeBase;
    if (
      !conversation ||
      !knowledgeBase?.notice?.retryable ||
      knowledgeBase.revision === null ||
      retryingKnowledgeBase
    ) {
      return;
    }
    setRetryingKnowledgeBase(true);
    const clientRequestId =
      typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
        ? crypto.randomUUID()
        : `kb-retry-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const recoveryMode = knowledgeBaseNoticeRecoveryMode(knowledgeBase.notice);
    try {
      const observation = await recoverKnowledgeBaseNotice({
        conversationId: conversation.id,
        notice: knowledgeBase.notice,
        clientRequestId,
        expectedGeneration: knowledgeBase.generation,
        expectedRevision: knowledgeBase.revision,
        expectedLeafId: knowledgeBase.leafId,
      });
      commitKnowledgeBaseObservation(conversation.id, observation);
      wakeKnowledgeBaseConversation(conversation.id);
      if (recoveryMode === "reconcile") {
        if (!knowledgeBasePackageRebindResolved(observation)) {
          toast.warning("知识库成品仍在等待重新绑定", {
            description:
              observation.notice?.message ||
              "原任务的完整 ZIP 或访问凭证尚未就绪，系统会继续恢复。",
          });
          return;
        }
        toast.success("知识库成品已重新绑定", {
          description: "已复用原权威任务完成校验，没有创建新的模型任务。",
        });
      } else {
        toast.success("已重新发起当前节点", {
          description: "本次使用新的幂等操作，不会复用上一条失败任务。",
        });
      }
    } catch (error) {
      const status = Number((error as { status?: unknown })?.status || 0);
      if (!status || status === 408 || status === 429 || status >= 500) {
        wakeKnowledgeBaseConversation(conversation.id);
        toast.warning("正在恢复重试结果", {
          description:
            "网络结果暂时未知，系统会恢复同一操作，不会重复创建任务。",
        });
      } else {
        toast.error(
          recoveryMode === "reconcile"
            ? "重新绑定知识库成品失败"
            : "重试当前节点失败",
          {
            description:
              error instanceof Error ? error.message : "请刷新权威状态后再试",
          },
        );
      }
    } finally {
      setRetryingKnowledgeBase(false);
    }
  }, [
    activeConversation,
    commitKnowledgeBaseObservation,
    retryingKnowledgeBase,
    wakeKnowledgeBaseConversation,
  ]);

  if (!activeConversation) {
    return <EmptyState />;
  }

  const { messages } = activeConversation;

  const sanitizedTitle = activeConversation.title
    ? sanitizeBrandText(activeConversation.title)
    : activeConversation.title;
  const activeTask = status === "running" || status === "pending";
  const executionDuration =
    startedAt && (activeTask || completedAt)
      ? Math.max(
          0,
          ((activeTask ? Date.now() : completedAt!) - startedAt) / 1000,
        )
      : null;
  const executionModel =
    fixedAgentProfile ||
    [...messages]
      .reverse()
      .find((message) => message.role === "assistant" && message.modelName)
      ?.modelName;

  return (
    <div className="flex-1 flex flex-col h-full relative">
      {/* Header bar */}
      <div className="flex items-center justify-between gap-4 border-b border-border/60 bg-background/85 px-4 py-3 sm:px-6 backdrop-blur-xl">
        <div
          className={`min-w-0 sm:pl-0 ${
            reserveOuterMobileNav ? "pl-20" : "pl-10"
          }`}
        >
          <div className="flex min-w-0 items-center gap-3">
            <h2 className="max-w-[400px] truncate text-sm font-semibold text-foreground/80">
              {sanitizedTitle}
            </h2>
            <StatusBadge
              status={status || "idle"}
              knowledgeBase={syncKnowledgeBaseSnapshot}
            />
          </div>
          {(executionModel || startedAt) && (
            <div
              className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground/70"
              aria-label="任务执行信息"
            >
              {executionModel && (
                <span className="inline-flex items-center gap-1">
                  <Bot className="h-3 w-3" />
                  {getModelDisplayName(executionModel)}
                </span>
              )}
              {startedAt && (
                <span>
                  开始{" "}
                  {new Date(startedAt).toLocaleTimeString("zh-CN", {
                    hour: "2-digit",
                    minute: "2-digit",
                    second: "2-digit",
                  })}
                </span>
              )}
              {completedAt && !activeTask && (
                <span>
                  完成{" "}
                  {new Date(completedAt).toLocaleTimeString("zh-CN", {
                    hour: "2-digit",
                    minute: "2-digit",
                    second: "2-digit",
                  })}
                </span>
              )}
              {executionDuration !== null && (
                <span className="inline-flex items-center gap-1 font-mono">
                  <Clock className="h-3 w-3" />
                  {formatExecutionDuration(executionDuration)}
                </span>
              )}
            </div>
          )}
        </div>
      </div>

      {/* Messages area */}
      <div className="flex-1 overflow-y-auto custom-scrollbar">
        <div className="max-w-4xl mx-auto px-3 py-6 space-y-6 sm:px-5 sm:py-8 sm:space-y-7">
          {messages.length === 0 &&
            status === "idle" &&
            (responseLogicContext ? (
              <ResponseLogicConversationHint
                question={responseLogicContext.question}
              />
            ) : showKnowledgeBaseStarter ? (
              <EmptyConversationHint
                onStartKnowledgeBase={startKnowledgeBase}
                companyName={
                  dashboardQuery.data?.enterpriseName ||
                  dashboardQuery.data?.payload?.brandName ||
                  ""
                }
                companyConfigured={Boolean(
                  (
                    dashboardQuery.data?.enterpriseName ||
                    dashboardQuery.data?.payload?.brandName ||
                    ""
                  ).trim(),
                )}
                companyLoading={dashboardQuery.isLoading}
              />
            ) : (
              <StandardConversationHint variant={standardWelcomeVariant} />
            ))}

          <AnimatePresence initial={false}>
            {messages.map((msg) => (
              <MessageBubble
                key={msg.id}
                message={msg}
                isRunning={status === "running" || status === "pending"}
                suppressKnowledgeArtifacts={syncKnowledgeBaseSnapshot}
                onDelete={
                  syncKnowledgeBaseSnapshot
                    ? undefined
                    : () => {
                        if (activeConversation) {
                          deleteMessage(activeConversation.id, msg.id);
                        }
                      }
                }
              />
            ))}
          </AnimatePresence>

          {syncKnowledgeBaseSnapshot &&
            activeConversation.knowledgeBase?.notice &&
            shouldRenderKnowledgeBaseNotice(
              activeConversation.knowledgeBase.notice,
            ) && (
              <div
                className={cn(
                  "rounded-xl border px-4 py-3 text-sm",
                  activeConversation.knowledgeBase.notice.severity === "error"
                    ? "border-red-200 bg-red-50 text-red-800"
                    : activeConversation.knowledgeBase.notice.severity ===
                        "warning"
                      ? "border-amber-200 bg-amber-50 text-amber-800"
                      : "border-blue-200 bg-blue-50 text-blue-800",
                )}
                data-testid="knowledge-base-notice"
                data-error-key={
                  activeConversation.knowledgeBase.notice.errorKey
                }
              >
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <span>{activeConversation.knowledgeBase.notice.message}</span>
                  {activeConversation.knowledgeBase.notice.retryable && (
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      disabled={retryingKnowledgeBase}
                      onClick={() => void retryCurrentKnowledgeBaseTurn()}
                    >
                      {retryingKnowledgeBase && (
                        <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
                      )}
                      {knowledgeBaseNoticeRetryLabel(
                        activeConversation.knowledgeBase.notice,
                      )}
                    </Button>
                  )}
                </div>
              </div>
            )}

          {/* Typing indicator when running */}
          {(status === "running" || status === "pending") &&
            (() => {
              let lastUserIdx = -1;
              for (let i = messages.length - 1; i >= 0; i--) {
                if (messages[i].role === "user") {
                  lastUserIdx = i;
                  break;
                }
              }
              const recentAssistantMsgs = messages
                .slice(lastUserIdx + 1)
                .filter((m) => m.role === "assistant");
              const hasStepsOrContent = recentAssistantMsgs.some(
                (m) =>
                  (m.stepGroups && m.stepGroups.length > 0) ||
                  (m.content && m.content.trim() !== ""),
              );
              return !hasStepsOrContent;
            })() && (
              <TypingIndicator
                text={runningAssistantStatusText(syncKnowledgeBaseSnapshot)}
              />
            )}

          <div ref={bottomRef} />
        </div>
      </div>

      {/* Input area */}
      <ChatInput
        fixedAgentProfile={fixedAgentProfile}
        syncKnowledgeBaseSnapshot={syncKnowledgeBaseSnapshot}
        composerPrefill={composerPrefill}
        responseLogicContext={responseLogicContext}
        knowledgeBaseProgress={knowledgeBaseProgress}
      />
    </div>
  );
}

function EmptyState() {
  const { createConversation } = useConversation();

  return (
    <div className="flex-1 flex flex-col items-center justify-center px-6">
      <motion.div
        initial={{ opacity: 0, scale: 0.95 }}
        animate={{ opacity: 1, scale: 1 }}
        transition={{ type: "spring", stiffness: 200, damping: 20 }}
        className="text-center max-w-xl"
      >
        <img
          src={EMPTY_STATE_IMG}
          alt="FrontMind AI"
          className="w-24 h-24 mx-auto mb-7 object-contain drop-shadow-sm rounded-2xl"
        />
        <h2 className="text-2xl font-bold text-foreground/80 mb-2 tracking-tight">
          FrontMind 内容制作智能体
        </h2>
        <p className="text-sm text-muted-foreground mb-8 leading-relaxed max-w-sm mx-auto">
          面向客户交付的智能内容生产工作台，支持文本、图片、文件输入与多智能体编排。
        </p>
        <button
          onClick={() => createConversation()}
          className="inline-flex items-center gap-2 px-6 py-3 rounded-xl bg-primary text-primary-foreground font-medium text-sm hover:opacity-90 transition-all shadow-lg glow-indigo active:scale-[0.98]"
        >
          <Sparkles className="w-4 h-4" />
          创建内容制作流程
        </button>
      </motion.div>
    </div>
  );
}

function ResponseLogicConversationHint({ question }: { question: string }) {
  return (
    <motion.div
      initial={{ opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
      className="mx-auto max-w-xl py-10 text-center"
    >
      <span className="mx-auto grid h-12 w-12 place-items-center rounded-2xl bg-primary/10 text-primary">
        <MessageSquareText className="h-5 w-5" />
      </span>
      <h3 className="mt-4 text-lg font-semibold text-foreground/80">
        当前应答问题
      </h3>
      <p className="mt-2 text-sm font-medium leading-7 text-foreground/75">
        {question}
      </p>
      <p className="mx-auto mt-2 max-w-md text-xs leading-6 text-muted-foreground">
        输入企业口径或上传资料后，智能体会结合最新知识库生成可核验的应答逻辑。
      </p>
    </motion.div>
  );
}

function StandardConversationHint({
  variant,
}: {
  variant: "simple" | "workflow";
}) {
  if (variant === "workflow") {
    return (
      <motion.div
        initial={{ opacity: 0, y: 10 }}
        animate={{ opacity: 1, y: 0 }}
        className="mx-auto max-w-xl space-y-7 py-10 text-center"
      >
        <div>
          <span className="mx-auto grid h-12 w-12 place-items-center rounded-2xl bg-primary/10 text-primary">
            <Sparkles className="h-5 w-5" />
          </span>
          <h3 className="mt-4 text-lg font-semibold text-foreground/80">
            内容制作智能体编排工作流
          </h3>
          <p className="mx-auto mt-2 max-w-lg text-sm leading-6 text-muted-foreground">
            以研究、分析与交付为核心的专业内容生产引擎
          </p>
        </div>
        <div className="flex flex-wrap justify-center gap-4">
          <FeatureBadge
            icon={<FileText className="h-3.5 w-3.5" />}
            text="资料输入"
          />
          <FeatureBadge
            icon={<Sparkles className="h-3.5 w-3.5" />}
            text="智能分析"
          />
          <FeatureBadge
            icon={<Download className="h-3.5 w-3.5" />}
            text="报告交付"
          />
        </div>
      </motion.div>
    );
  }

  return (
    <motion.div
      initial={{ opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
      className="mx-auto max-w-xl py-14 text-center"
    >
      <span className="mx-auto grid h-12 w-12 place-items-center rounded-2xl bg-primary/10 text-primary">
        <Sparkles className="h-5 w-5" />
      </span>
      <h3 className="mt-4 text-lg font-semibold text-foreground/80">
        有什么需要我协助？
      </h3>
      <p className="mx-auto mt-2 max-w-md text-sm leading-6 text-muted-foreground">
        直接输入任务或上传文件即可开始。
      </p>
    </motion.div>
  );
}

export function EmptyConversationHint({
  onStartKnowledgeBase,
  companyName,
  companyConfigured,
  companyLoading,
}: {
  onStartKnowledgeBase: (input: DeepReportStartInput) => Promise<void>;
  companyName: string;
  companyConfigured: boolean;
  companyLoading: boolean;
}) {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [companyWebsite, setCompanyWebsite] = useState("");
  const [operatorNotes, setOperatorNotes] = useState("");
  const [files, setFiles] = useState<File[]>([]);
  const [isDragging, setIsDragging] = useState(false);
  const [isStarting, setIsStarting] = useState(false);

  const addFiles = useCallback((fileList: FileList | File[]) => {
    const incoming = Array.from(fileList).filter((file) => {
      const sizeError = chatAttachmentSizeError(file);
      if (!sizeError) return true;
      toast.error("文件过大", { description: sizeError });
      return false;
    });
    setFiles((current) => {
      const seen = new Set(
        current.map((file) => `${file.name}:${file.size}:${file.lastModified}`),
      );
      const next = [...current];
      for (const file of incoming) {
        const key = `${file.name}:${file.size}:${file.lastModified}`;
        if (!seen.has(key)) {
          seen.add(key);
          next.push(file);
        }
      }
      return next;
    });
  }, []);

  const resetDialog = useCallback(() => {
    setCompanyWebsite("");
    setOperatorNotes("");
    setFiles([]);
    setIsDragging(false);
    setIsStarting(false);
    if (fileInputRef.current) {
      fileInputRef.current.value = "";
    }
  }, []);

  const removeFile = useCallback((index: number) => {
    setFiles((current) =>
      current.filter((_, fileIndex) => fileIndex !== index),
    );
  }, []);

  const handleStart = useCallback(async () => {
    const normalizedCompanyName = companyName.trim();
    if (!companyConfigured || !normalizedCompanyName) {
      toast.error("请联系管理员配置当前账号的企业名称");
      return;
    }

    setIsStarting(true);
    try {
      const payload = {
        companyName: normalizedCompanyName,
        companyWebsite: companyWebsite.trim(),
        agentProfile: "frontmind-pro",
        operatorNotes: operatorNotes.trim(),
        files,
      };
      await onStartKnowledgeBase(payload);
      setDialogOpen(false);
      resetDialog();
    } finally {
      setIsStarting(false);
    }
  }, [
    companyName,
    companyConfigured,
    companyWebsite,
    files,
    onStartKnowledgeBase,
    operatorNotes,
    resetDialog,
  ]);

  return (
    <>
      <motion.div
        initial={{ opacity: 0, y: 10 }}
        animate={{ opacity: 1, y: 0 }}
        className="flex min-h-[420px] flex-col items-center justify-center px-4 py-10 text-center"
      >
        <div className="mx-auto flex max-w-xl flex-col items-center">
          <span className="grid h-12 w-12 place-items-center rounded-2xl bg-primary/10 text-primary">
            <BookOpen className="h-5 w-5" />
          </span>
          <p className="mt-5 text-base leading-7 text-foreground/75">
            {KNOWLEDGE_BASE_FOUNDATION_COPY}
          </p>
          <div className="mt-6">
            <Button
              type="button"
              onClick={() => setDialogOpen(true)}
              className="h-11 rounded-xl px-5 gap-2 shadow-sm"
            >
              <BookOpen className="w-4 h-4" />
              构建企业知识库
            </Button>
          </div>
          <div className="mt-8 flex flex-wrap justify-center gap-4">
            <FeatureBadge
              icon={<FileText className="w-3.5 h-3.5" />}
              text="资料输入"
            />
            <FeatureBadge
              icon={<Sparkles className="w-3.5 h-3.5" />}
              text="智能分析"
            />
            <FeatureBadge
              icon={<Download className="w-3.5 h-3.5" />}
              text="报告交付"
            />
          </div>
        </div>
      </motion.div>

      <Dialog
        open={dialogOpen}
        onOpenChange={(open) => {
          if (isStarting) return;
          setDialogOpen(open);
          if (!open) resetDialog();
        }}
      >
        <DialogContent className="w-[calc(100vw-1rem)] sm:max-w-[560px] max-h-[calc(100dvh-1rem)] overflow-y-auto p-4 sm:p-6">
          <DialogTitle>构建企业知识库</DialogTitle>
          <DialogDescription>
            系统会深度采集官网全站，并检索全网企业情报与图文来源，逐项核验后构建知识库。
          </DialogDescription>

          <div className="space-y-5 py-2">
            <div className="space-y-2">
              <label className="text-sm font-medium text-foreground/80">
                当前账号绑定企业
              </label>
              <Input
                value={companyName}
                readOnly
                placeholder={companyLoading ? "正在读取企业信息…" : "尚未配置"}
                disabled={isStarting || companyLoading}
              />
              {!companyLoading && !companyConfigured && (
                <p className="text-xs leading-5 text-amber-700">
                  请联系管理员配置当前账号的企业名称后，再开始构建知识库。
                </p>
              )}
            </div>

            <div className="space-y-2">
              <label className="text-sm font-medium text-foreground/80">
                企业官网入口
              </label>
              <Textarea
                value={companyWebsite}
                onChange={(event) => setCompanyWebsite(event.target.value)}
                placeholder="填写一个或多个企业官网，每行一个，例如 https://www.example.com"
                disabled={isStarting}
                className="min-h-20 resize-none"
              />
              <p className="text-xs leading-5 text-muted-foreground">
                官网用于全站采集；系统还会自动检索全网公开信息，无需逐个填写外部来源。
              </p>
            </div>

            <div className="space-y-2">
              <label className="text-sm font-medium text-foreground/80">
                备注
              </label>
              <Textarea
                value={operatorNotes}
                onChange={(event) => setOperatorNotes(event.target.value)}
                placeholder="填写知识库范围、重点产品、目标用途或需要避开的内容"
                disabled={isStarting}
                className="min-h-24 resize-none"
              />
            </div>

            <div className="space-y-2">
              <label className="text-sm font-medium text-foreground/80">
                企业宣传册
              </label>
              <div
                role="button"
                tabIndex={0}
                onClick={() => fileInputRef.current?.click()}
                onKeyDown={(event) => {
                  if (event.key === "Enter" || event.key === " ") {
                    event.preventDefault();
                    fileInputRef.current?.click();
                  }
                }}
                onDragOver={(event) => {
                  event.preventDefault();
                  if (!isStarting) setIsDragging(true);
                }}
                onDragLeave={() => setIsDragging(false)}
                onDrop={(event) => {
                  event.preventDefault();
                  setIsDragging(false);
                  if (!isStarting && event.dataTransfer.files.length > 0) {
                    addFiles(event.dataTransfer.files);
                  }
                }}
                className={cn(
                  "flex min-h-[132px] cursor-pointer flex-col items-center justify-center rounded-xl border border-dashed bg-card/70 px-4 py-5 text-center transition-colors",
                  isDragging
                    ? "border-primary/70 bg-primary/5"
                    : "border-border hover:border-primary/40 hover:bg-muted/40",
                  isStarting && "cursor-not-allowed opacity-60",
                )}
              >
                <UploadCloud className="mb-3 h-6 w-6 text-primary" />
                <div className="text-sm font-medium text-foreground/80">
                  拖入企业宣传册，或点击选择文件
                </div>
                <div className="mt-1 text-xs text-muted-foreground">
                  支持宣传册、产品目录、PPT、图片、PDF、Word 等企业资料
                </div>
                <input
                  ref={fileInputRef}
                  type="file"
                  multiple
                  className="sr-only"
                  disabled={isStarting}
                  onChange={(event) => {
                    if (event.target.files) addFiles(event.target.files);
                  }}
                />
              </div>

              {files.length > 0 && (
                <div className="space-y-2 rounded-xl border border-border/70 bg-muted/20 p-3">
                  {files.map((file, index) => (
                    <div
                      key={`${file.name}-${file.size}-${file.lastModified}`}
                      className="flex items-center justify-between gap-3 rounded-lg bg-background/80 px-3 py-2 text-sm"
                    >
                      <div className="min-w-0">
                        <div className="truncate text-foreground/80">
                          {file.name}
                        </div>
                        <div className="text-xs text-muted-foreground">
                          {(file.size / 1024 / 1024).toFixed(2)} MB
                        </div>
                      </div>
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon"
                        className="h-7 w-7 shrink-0"
                        disabled={isStarting}
                        onClick={(event) => {
                          event.stopPropagation();
                          removeFile(index);
                        }}
                      >
                        <X className="h-3.5 w-3.5" />
                      </Button>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>

          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => {
                setDialogOpen(false);
                resetDialog();
              }}
              disabled={isStarting}
            >
              取消
            </Button>
            <Button
              type="button"
              onClick={() => void handleStart()}
              disabled={
                isStarting ||
                companyLoading ||
                !companyConfigured ||
                !companyName.trim()
              }
              className="gap-2"
            >
              {isStarting ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <BookOpen className="h-4 w-4" />
              )}
              开始构建
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

function FeatureBadge({ icon, text }: { icon: React.ReactNode; text: string }) {
  return (
    <div className="flex items-center gap-2 px-3.5 py-2 rounded-full bg-card/80 border border-border/70 text-xs text-muted-foreground shadow-sm">
      {icon}
      {text}
    </div>
  );
}

/**
 * Inline Markdown File Reader - opens .md files in a resizable dialog overlay.
 */
function MarkdownFileReader({
  fileUrl,
  fileName,
  isOpen,
  onClose,
}: {
  fileUrl: string;
  fileName: string;
  isOpen: boolean;
  onClose: () => void;
}) {
  const [content, setContent] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [isDownloading, setIsDownloading] = useState(false);
  const [size, setSize] = useState({ width: 720, height: 560 });
  const displayFileName = sanitizeBrandText(fileName);
  const resizingRef = useRef(false);
  const startRef = useRef({ x: 0, y: 0, w: 0, h: 0 });

  useEffect(() => {
    if (isOpen && fileUrl) {
      setLoading(true);
      setError(null);
      setContent(null);

      // Fetch through the same-origin proxy when the source is an external signed URL.
      const displayName = sanitizeBrandText(fileName);
      const normalizedUrl =
        buildProxyDownloadUrl(fileUrl, displayName, false) || fileUrl;

      fetch(normalizedUrl, {
        credentials: "include",
        headers: deliveryProjectHeaders(),
      })
        .then(async (res) => {
          if (!res.ok) {
            throw new Error(`HTTP ${res.status}`);
          }
          const ct = res.headers.get("content-type") || "";
          if (
            ct.includes("application/json") &&
            fileUrl.includes("/v1/files/")
          ) {
            await res.body?.cancel().catch(() => undefined);
            throw new Error("服务返回了文件信息，但未返回文件内容");
          }
          return res.text();
        })
        .then((text) => {
          // FIX #4: Sanitize FrontMind references in file content before display
          setContent(sanitizeBrandText(text));
          setLoading(false);
        })
        .catch((err) => {
          setError(err.message || "加载失败");
          setLoading(false);
        });
    }
  }, [isOpen, fileUrl, fileName]);

  const handleDownload = useCallback(async () => {
    setIsDownloading(true);
    try {
      if (content) {
        const downloadName = sanitizeBrandText(fileName);
        const blob = new Blob([content], {
          type: "text/markdown;charset=utf-8",
        });
        const url = URL.createObjectURL(blob);
        nativeDownload(url, downloadName);
        URL.revokeObjectURL(url);
      } else {
        const downloadName = sanitizeBrandText(fileName);
        const proxiedUrl = buildProxyDownloadUrl(fileUrl, downloadName, true);
        if (proxiedUrl) {
          const blobUrl = await fetchWithAuth(proxiedUrl, downloadName);
          nativeDownload(blobUrl, downloadName);
          URL.revokeObjectURL(blobUrl);
          return;
        }
        const blobUrl = await fetchWithAuth(fileUrl, downloadName);
        nativeDownload(blobUrl, downloadName);
        URL.revokeObjectURL(blobUrl);
      }
    } catch (err) {
      console.error("Download failed:", err);
    } finally {
      setIsDownloading(false);
    }
  }, [content, fileUrl, fileName]);

  const onResizeMouseDown = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      resizingRef.current = true;
      startRef.current = {
        x: e.clientX,
        y: e.clientY,
        w: size.width,
        h: size.height,
      };

      const onMouseMove = (ev: MouseEvent) => {
        if (!resizingRef.current) return;
        const dw = ev.clientX - startRef.current.x;
        const dh = ev.clientY - startRef.current.y;
        setSize({
          width: Math.max(
            400,
            Math.min(window.innerWidth * 0.95, startRef.current.w + dw),
          ),
          height: Math.max(
            300,
            Math.min(window.innerHeight * 0.95, startRef.current.h + dh),
          ),
        });
      };

      const onMouseUp = () => {
        resizingRef.current = false;
        document.removeEventListener("mousemove", onMouseMove);
        document.removeEventListener("mouseup", onMouseUp);
      };

      document.addEventListener("mousemove", onMouseMove);
      document.addEventListener("mouseup", onMouseUp);
    },
    [size],
  );

  return (
    <Dialog open={isOpen} onOpenChange={(open) => !open && onClose()}>
      <DialogContent
        showCloseButton={false}
        className="p-0 flex flex-col overflow-hidden"
        style={{
          width: size.width,
          height: size.height,
          maxWidth: "95vw",
          maxHeight: "95vh",
        }}
      >
        <DialogTitle className="sr-only">{displayFileName}</DialogTitle>

        {/* Header */}
        <div className="flex items-center justify-between px-6 py-3 border-b border-border/30 flex-shrink-0">
          <div className="flex items-center gap-2">
            <BookOpen className="w-4 h-4 text-primary" />
            <span className="text-sm font-medium text-foreground/80 truncate max-w-[400px]">
              {displayFileName}
            </span>
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={handleDownload}
              disabled={isDownloading}
              className="inline-flex items-center gap-1 px-2 py-1 text-xs rounded-md hover:bg-muted transition-colors text-muted-foreground hover:text-foreground disabled:opacity-50"
            >
              {isDownloading ? (
                <Loader2 className="w-3.5 h-3.5 animate-spin" />
              ) : (
                <Download className="w-3.5 h-3.5" />
              )}
              下载
            </button>
            <Button
              variant="ghost"
              size="icon"
              onClick={onClose}
              className="w-8 h-8"
            >
              <X className="w-4 h-4" />
            </Button>
          </div>
        </div>

        {/* Content */}
        <div className="flex-1 overflow-y-auto custom-scrollbar px-8 py-6">
          {loading && (
            <div className="flex items-center justify-center py-12">
              <Loader2 className="w-6 h-6 animate-spin text-primary" />
              <span className="ml-2 text-sm text-muted-foreground">
                加载中...
              </span>
            </div>
          )}
          {error && (
            <div className="flex items-center justify-center py-12 text-destructive">
              <AlertCircle className="w-5 h-5 mr-2" />
              <span className="text-sm">加载失败: {error}</span>
            </div>
          )}
          {content !== null && !loading && (
            <div className="max-w-3xl mx-auto">
              <MarkdownRenderer
                content={content}
                className="prose prose-sm max-w-none prose-p:my-2 prose-headings:my-3 prose-pre:my-3 prose-ul:my-2 prose-ol:my-2"
              />
            </div>
          )}
        </div>

        {/* Resize handle */}
        <div
          onMouseDown={onResizeMouseDown}
          className="absolute bottom-0 right-0 w-4 h-4 cursor-se-resize"
          style={{ touchAction: "none" }}
        >
          <svg
            width="16"
            height="16"
            viewBox="0 0 16 16"
            className="text-muted-foreground/40"
          >
            <path d="M14 14L8 14L14 8Z" fill="currentColor" />
            <path d="M14 14L11 14L14 11Z" fill="currentColor" opacity="0.5" />
          </svg>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function PdfViewer({
  fileUrl,
  fileName,
  isPdf,
  isOpen,
  onClose,
}: {
  fileUrl: string;
  fileName: string;
  isPdf: boolean;
  isOpen: boolean;
  onClose: () => void;
}) {
  if (isPdf) {
    return (
      <Dialog open={isOpen} onOpenChange={(open) => !open && onClose()}>
        <DialogContent
          showCloseButton={false}
          className="p-0 flex flex-col overflow-hidden"
          style={{
            width: 1100,
            height: 760,
            maxWidth: "96vw",
            maxHeight: "96vh",
          }}
        >
          <DialogTitle className="sr-only">
            {sanitizeBrandText(fileName)}
          </DialogTitle>
          <React.Suspense
            fallback={
              <div className="flex h-full items-center justify-center gap-2 text-sm text-muted-foreground">
                <Loader2 className="h-5 w-5 animate-spin" />
                正在启动 PDF 阅读器…
              </div>
            }
          >
            <PdfDocumentViewer
              fileName={fileName}
              source={{ kind: "external", url: fileUrl }}
              onClose={onClose}
            />
          </React.Suspense>
        </DialogContent>
      </Dialog>
    );
  }

  return (
    <HtmlFileViewer
      fileUrl={fileUrl}
      fileName={fileName}
      isOpen={isOpen}
      onClose={onClose}
    />
  );
}

/**
 * HTML remains isolated in a maximally restricted iframe. PDF files use the
 * PDF.js canvas viewer above and never enter an iframe.
 */
function HtmlFileViewer({
  fileUrl,
  fileName,
  isOpen,
  onClose,
}: {
  fileUrl: string;
  fileName: string;
  isOpen: boolean;
  onClose: () => void;
}) {
  const [isDownloading, setIsDownloading] = useState(false);
  const [blobUrl, setBlobUrl] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [size, setSize] = useState({ width: 800, height: 640 });
  const displayFileName = sanitizeBrandText(fileName);
  const resizingRef = useRef(false);
  const startRef = useRef({ x: 0, y: 0, w: 0, h: 0 });

  // Load blob URL when dialog opens
  useEffect(() => {
    if (isOpen && fileUrl) {
      setLoading(true);
      setError(null);
      setBlobUrl(null);

      // If it's already a blob URL, use directly
      if (fileUrl.startsWith("blob:")) {
        setBlobUrl(fileUrl);
        setLoading(false);
        return;
      }

      // Convert an HTML data URL to a blob URL for sandboxed iframe rendering.
      if (fileUrl.startsWith("data:")) {
        try {
          const parts = fileUrl.split(",");
          const mimeMatch = parts[0]?.match(/:(.*?);/);
          const mime = mimeMatch ? mimeMatch[1] : "application/octet-stream";
          const binaryStr = atob(parts[1]);
          const bytes = new Uint8Array(binaryStr.length);
          for (let k = 0; k < binaryStr.length; k++) {
            bytes[k] = binaryStr.charCodeAt(k);
          }
          const blob = new Blob([bytes], { type: mime });
          setBlobUrl(URL.createObjectURL(blob));
        } catch (e) {
          console.error("Failed to convert data URL to blob:", e);
          setError("文件格式转换失败");
        }
        setLoading(false);
        return;
      }

      // Fetch with auth headers and create a sanitized blob URL through the proxy.
      const displayName = sanitizeBrandText(fileName);
      fetchWithAuth(fileUrl, displayName)
        .then((url) => {
          setBlobUrl(url);
          setLoading(false);
        })
        .catch((err) => {
          console.error("Failed to load file for preview:", err);
          setError(err.message);
          setLoading(false);
        });
    }

    return () => {
      if (
        blobUrl &&
        blobUrl.startsWith("blob:") &&
        !fileUrl.startsWith("blob:")
      ) {
        URL.revokeObjectURL(blobUrl);
      }
    };
  }, [isOpen, fileUrl]);

  const handleDownload = useCallback(async () => {
    setIsDownloading(true);
    try {
      // If we already have a blobUrl from preview, use it directly. Blob/data
      // URLs use the download attribute; external fallback URLs use native HTTPS.
      if (blobUrl) {
        nativeDownload(blobUrl, sanitizeBrandText(fileName));
      } else if (fileUrl.startsWith("blob:") || fileUrl.startsWith("data:")) {
        nativeDownload(fileUrl, sanitizeBrandText(fileName));
      } else {
        const downloadName = sanitizeBrandText(fileName);
        const proxiedUrl = buildProxyDownloadUrl(fileUrl, downloadName, true);
        if (proxiedUrl) {
          nativeDownload(proxiedUrl, downloadName);
          return;
        }
        const downloadBlobUrl = await fetchWithAuth(fileUrl, downloadName);
        nativeDownload(downloadBlobUrl, downloadName);
        URL.revokeObjectURL(downloadBlobUrl);
      }
    } catch (err) {
      console.error("Download failed:", err);
    } finally {
      setIsDownloading(false);
    }
  }, [fileUrl, fileName, blobUrl]);

  const onResizeMouseDown = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      resizingRef.current = true;
      startRef.current = {
        x: e.clientX,
        y: e.clientY,
        w: size.width,
        h: size.height,
      };

      const onMouseMove = (ev: MouseEvent) => {
        if (!resizingRef.current) return;
        const dw = ev.clientX - startRef.current.x;
        const dh = ev.clientY - startRef.current.y;
        setSize({
          width: Math.max(
            400,
            Math.min(window.innerWidth * 0.95, startRef.current.w + dw),
          ),
          height: Math.max(
            300,
            Math.min(window.innerHeight * 0.95, startRef.current.h + dh),
          ),
        });
      };

      const onMouseUp = () => {
        resizingRef.current = false;
        document.removeEventListener("mousemove", onMouseMove);
        document.removeEventListener("mouseup", onMouseUp);
      };

      document.addEventListener("mousemove", onMouseMove);
      document.addEventListener("mouseup", onMouseUp);
    },
    [size],
  );

  return (
    <Dialog open={isOpen} onOpenChange={(open) => !open && onClose()}>
      <DialogContent
        showCloseButton={false}
        className="p-0 flex flex-col overflow-hidden"
        style={{
          width: size.width,
          height: size.height,
          maxWidth: "95vw",
          maxHeight: "95vh",
        }}
      >
        <DialogTitle className="sr-only">{displayFileName}</DialogTitle>

        {/* Header */}
        <div className="flex items-center justify-between px-6 py-3 border-b border-border/30 flex-shrink-0">
          <div className="flex items-center gap-2">
            <FileText className="w-4 h-4 text-primary" />
            <span className="text-sm font-medium text-foreground/80 truncate max-w-[400px]">
              {displayFileName}
            </span>
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={handleDownload}
              disabled={isDownloading}
              className="inline-flex items-center gap-1 px-2 py-1 text-xs rounded-md hover:bg-muted transition-colors text-muted-foreground hover:text-foreground disabled:opacity-50"
            >
              {isDownloading ? (
                <Loader2 className="w-3.5 h-3.5 animate-spin" />
              ) : (
                <Download className="w-3.5 h-3.5" />
              )}
              下载
            </button>
            <Button
              variant="ghost"
              size="icon"
              onClick={onClose}
              className="w-8 h-8"
            >
              <X className="w-4 h-4" />
            </Button>
          </div>
        </div>

        {/* File viewer */}
        <div className="flex-1 overflow-hidden bg-muted/20">
          {loading ? (
            <div className="flex items-center justify-center h-full">
              <Loader2 className="w-8 h-8 animate-spin text-primary/50" />
              <span className="ml-2 text-sm text-muted-foreground">
                加载文件中...
              </span>
            </div>
          ) : error ? (
            <div className="flex flex-col items-center justify-center h-full gap-3">
              <FileText className="w-12 h-12 text-muted-foreground/30" />
              <p className="text-sm text-muted-foreground">文件加载失败</p>
              <p className="text-xs text-muted-foreground/60">{error}</p>
              <Button onClick={handleDownload} variant="outline" size="sm">
                <Download className="w-4 h-4 mr-1" />
                直接下载
              </Button>
            </div>
          ) : blobUrl ? (
            <iframe
              src={blobUrl}
              title={displayFileName}
              className="w-full h-full border-0"
              style={{ minHeight: "100%" }}
              sandbox=""
            />
          ) : null}
        </div>

        {/* Resize handle */}
        <div
          onMouseDown={onResizeMouseDown}
          className="absolute bottom-0 right-0 w-4 h-4 cursor-se-resize"
          style={{ touchAction: "none" }}
        >
          <svg
            width="16"
            height="16"
            viewBox="0 0 16 16"
            className="text-muted-foreground/40"
          >
            <path d="M14 14L8 14L14 8Z" fill="currentColor" />
            <path d="M14 14L11 14L14 11Z" fill="currentColor" opacity="0.5" />
          </svg>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function UserAttachmentImage({ attachment }: { attachment: Attachment }) {
  const [localUrl, setLocalUrl] = useState<string | null>(null);

  useEffect(() => {
    if (attachment.base64 || attachment.blobUrl || !attachment.file) {
      setLocalUrl(null);
      return;
    }
    const nextUrl = URL.createObjectURL(attachment.file);
    setLocalUrl(nextUrl);
    return () => URL.revokeObjectURL(nextUrl);
  }, [attachment.base64, attachment.blobUrl, attachment.file]);

  const source = attachment.base64 || attachment.blobUrl || localUrl || "";

  if (!source && !attachment.fileId) return null;
  return (
    <ImagePreview
      {...(source ? { src: source } : { fileId: attachment.fileId! })}
      alt={sanitizeBrandText(attachment.name)}
      className="max-w-[200px] max-h-[200px]"
      expiresAt={attachment.expiresAt}
      expired={attachment.expired}
    />
  );
}

function MessageBubble({
  message,
  isRunning,
  suppressKnowledgeArtifacts,
  onDelete,
}: {
  message: LocalMessage;
  isRunning?: boolean;
  suppressKnowledgeArtifacts?: boolean;
  onDelete?: () => void;
}) {
  const isUser = message.role === "user";
  const [mdReaderOpen, setMdReaderOpen] = useState(false);
  const [mdReaderFile, setMdReaderFile] = useState<{
    url: string;
    name: string;
  } | null>(null);
  const [pdfViewerOpen, setPdfViewerOpen] = useState(false);
  const [pdfViewerFile, setPdfViewerFile] = useState<{
    url: string;
    name: string;
    isPdf: boolean;
  } | null>(null);
  const [copied, setCopied] = useState(false);
  const visibleOutputFiles = suppressKnowledgeArtifacts
    ? message.outputFiles?.filter((file) => {
        const filename = file.fileName.toLowerCase();
        const mimeType = file.mimeType.toLowerCase();
        return (
          !filename.endsWith(".zip") &&
          !filename.endsWith(".html") &&
          !filename.endsWith(".htm") &&
          !mimeType.includes("zip") &&
          !mimeType.includes("html")
        );
      })
    : message.outputFiles;

  const openMdReader = useCallback((url: string, name: string) => {
    setMdReaderFile({ url, name });
    setMdReaderOpen(true);
  }, []);

  const openPdfViewer = useCallback(
    (url: string, name: string, isPdf: boolean) => {
      setPdfViewerFile({ url, name, isPdf });
      setPdfViewerOpen(true);
    },
    [],
  );

  // Calculate running elapsed time for this specific response
  const getRunningElapsed = () => {
    if (
      !isUser &&
      isRunning &&
      message.responseStartedAt &&
      !message.elapsedTime
    ) {
      const elapsed = (Date.now() - message.responseStartedAt) / 1000;
      if (elapsed >= 0) {
        if (elapsed < 60) return `${elapsed.toFixed(1)}s`;
        const mins = Math.floor(elapsed / 60);
        const secs = (elapsed % 60).toFixed(0);
        return `${mins}m ${secs}s`;
      }
    }
    return null;
  };

  const getCompletedElapsed = () => {
    if (message.elapsedTime != null && message.elapsedTime >= 0) {
      const elapsed = message.elapsedTime;
      if (elapsed < 60) return `${elapsed.toFixed(1)}s`;
      const mins = Math.floor(elapsed / 60);
      const secs = (elapsed % 60).toFixed(0);
      return `${mins}m ${secs}s`;
    }
    return null;
  };

  const runningElapsed = getRunningElapsed();
  const completedElapsed = getCompletedElapsed();
  const elapsedDisplay = completedElapsed || runningElapsed;

  // Check file types
  const isMdFile = (fileName: string) => {
    const ext = fileName.split(".").pop()?.toLowerCase();
    return ext === "md" || ext === "markdown";
  };

  const isPdfFile = (fileName: string, mimeType?: string) => {
    if (mimeType?.includes("pdf")) return true;
    const ext = fileName.split(".").pop()?.toLowerCase();
    return ext === "pdf";
  };

  const isHtmlFile = (fileName: string, mimeType?: string) => {
    if (mimeType?.includes("html")) return true;
    const ext = fileName.split(".").pop()?.toLowerCase();
    return ext === "html" || ext === "htm";
  };

  // Filter "等待用户输入" from content (req 8)
  const displayContent = isUser
    ? message.content
    : filterWaitingText(message.content);

  // Apply FrontMind brand sanitization for assistant messages
  const sanitizedContent =
    !isUser && displayContent
      ? sanitizeBrandText(displayContent)
      : displayContent;

  // Sanitize step groups labels and descriptions
  const sanitizedStepGroups =
    !isUser && message.stepGroups
      ? message.stepGroups.map((group) => ({
          ...group,
          title: sanitizeBrandText(group.title),
          description: group.description
            ? sanitizeBrandText(group.description)
            : undefined,
          steps: group.steps.map((step) => ({
            ...step,
            label: sanitizeBrandText(step.label),
            description: step.description
              ? sanitizeBrandText(step.description)
              : undefined,
          })),
        }))
      : message.stepGroups;

  // Copy handler - uses sanitizedContent for assistant messages
  const handleCopyMessage = () => {
    const contentToCopy = isUser ? displayContent : sanitizedContent;
    if (!contentToCopy) return;
    void copyToClipboard(contentToCopy).then((ok) => {
      if (ok) {
        setCopied(true);
        setTimeout(() => setCopied(false), 2000);
      } else {
        toast.error("复制失败");
      }
    });
  };

  return (
    <>
      <MessageActions message={message} onDelete={onDelete}>
        <motion.div
          initial={{ opacity: 0, y: 12 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ type: "spring", stiffness: 400, damping: 30 }}
          className={cn("flex items-start gap-3", isUser && "flex-row-reverse")}
        >
          {/* Avatar */}
          <div
            className={cn(
              "flex flex-col items-center flex-shrink-0 gap-0.5",
              isUser && "items-center",
            )}
          >
            <div
              className={cn(
                "w-8 h-8 rounded-full flex items-center justify-center mt-0.5",
                isUser
                  ? "bg-accent/15 text-accent"
                  : "bg-primary/10 text-primary",
              )}
            >
              {isUser ? (
                <User className="w-4 h-4" />
              ) : (
                <Bot className="w-4 h-4" />
              )}
            </div>
          </div>

          {/* Message content */}
          <div
            className={cn(
              "max-w-[92%] space-y-2 sm:max-w-[80%]",
              isUser ? "items-end" : "items-start",
            )}
          >
            {/* Intermediate steps (assistant only) */}
            {!isUser &&
              sanitizedStepGroups &&
              sanitizedStepGroups.length > 0 && (
                <IntermediateSteps
                  stepGroups={sanitizedStepGroups}
                  isRunning={isRunning && !message.elapsedTime}
                />
              )}

            {/* Attachments (user) - with PDF/HTML inline viewer support */}
            {message.attachments && message.attachments.length > 0 && (
              <div
                className={cn(
                  "flex flex-wrap gap-2 mb-1",
                  isUser && "justify-end",
                )}
              >
                {message.attachments.map((att) => (
                  <div key={att.id}>
                    {att.type === "image" && !isAttachmentExpired(att) ? (
                      <UserAttachmentImage attachment={att} />
                    ) : (
                      // PDF, HTML and every other user file share one source
                      // resolver. In particular, local PDFs reach
                      // PdfDocumentViewer through sourceFile instead of being
                      // forced through the remote preparation endpoint.
                      <FilePreview file={att} />
                    )}
                  </div>
                ))}
              </div>
            )}

            {/* Text content */}
            {displayContent && displayContent.trim() !== "" && (
              <div
                className={cn(
                  "rounded-3xl px-4.5 py-3 text-[14px] leading-relaxed",
                  isUser
                    ? "bg-primary text-primary-foreground rounded-tr-md shadow-sm"
                    : "bg-card/80 border border-border/70 rounded-tl-md text-foreground shadow-sm",
                )}
              >
                {isUser ? (
                  <p className="whitespace-pre-wrap break-words">
                    {displayContent}
                  </p>
                ) : (
                  <MarkdownRenderer
                    content={sanitizedContent}
                    className="prose prose-sm max-w-none prose-p:my-1.5 prose-headings:my-2 prose-pre:my-2 prose-ul:my-1 prose-ol:my-1"
                  />
                )}
              </div>
            )}

            {/* Inline images (from API output) */}
            {message.inlineImages && message.inlineImages.length > 0 && (
              <div className="flex flex-wrap gap-2 mt-1">
                {message.inlineImages.map((img, i) => (
                  <ImagePreview
                    key={i}
                    src={img.src}
                    alt={sanitizeBrandText(img.alt || "image")}
                    className="max-w-[300px]"
                  />
                ))}
              </div>
            )}

            {/* Output files (assistant) - with PDF/HTML inline viewer and MD reader */}
            {visibleOutputFiles && visibleOutputFiles.length > 0 && (
              <div className="space-y-1.5 mt-1">
                {visibleOutputFiles.map((file, i) => {
                  const displayOutputFileName = sanitizeBrandText(
                    file.fileName,
                  );
                  const isMarkdown = isMdFile(displayOutputFileName);
                  const isPdf = isPdfFile(displayOutputFileName, file.mimeType);
                  const isHtml = isHtmlFile(
                    displayOutputFileName,
                    file.mimeType,
                  );
                  return (
                    <div
                      key={i}
                      onClick={(e) => {
                        if (isMarkdown) {
                          e.preventDefault();
                          openMdReader(file.fileUrl, displayOutputFileName);
                        } else if (isPdf || isHtml) {
                          e.preventDefault();
                          openPdfViewer(
                            file.fileUrl,
                            displayOutputFileName,
                            isPdf,
                          );
                        }
                      }}
                      className="cursor-pointer"
                    >
                      {isMarkdown ? (
                        <div className="flex items-center gap-2.5 px-3 py-2.5 rounded-2xl bg-card/80 hover:bg-secondary/70 transition-all group border border-border/70 shadow-sm">
                          <div className="w-8 h-8 rounded-lg bg-primary/10 flex items-center justify-center flex-shrink-0">
                            <BookOpen className="w-4 h-4 text-primary/60" />
                          </div>
                          <div className="flex-1 overflow-hidden">
                            <p className="text-xs font-medium text-foreground/70 truncate">
                              {displayOutputFileName}
                            </p>
                            <p className="text-xs text-muted-foreground/50">
                              点击在页面内阅读
                            </p>
                          </div>
                          <BookOpen className="w-4 h-4 text-muted-foreground opacity-0 group-hover:opacity-100 transition-opacity" />
                        </div>
                      ) : isPdf || isHtml ? (
                        <div className="flex items-center gap-2.5 px-3 py-2.5 rounded-2xl bg-card/80 hover:bg-secondary/70 transition-all group border border-border/70 shadow-sm">
                          <div className="w-8 h-8 rounded-lg bg-red-500/10 flex items-center justify-center flex-shrink-0">
                            <FileText className="w-4 h-4 text-red-500/60" />
                          </div>
                          <div className="flex-1 overflow-hidden">
                            <p className="text-xs font-medium text-foreground/70 truncate">
                              {displayOutputFileName}
                            </p>
                            <p className="text-xs text-muted-foreground/50">
                              {isPdf ? "点击查看 PDF" : "点击查看 HTML"}
                            </p>
                          </div>
                          <BookOpen className="w-4 h-4 text-muted-foreground opacity-0 group-hover:opacity-100 transition-opacity" />
                        </div>
                      ) : (
                        <div
                          onClick={async (e) => {
                            e.stopPropagation();
                            try {
                              const downloadName = displayOutputFileName;
                              const proxiedUrl = buildProxyDownloadUrl(
                                file.fileUrl,
                                downloadName,
                                true,
                              );
                              if (proxiedUrl) {
                                nativeDownload(proxiedUrl, downloadName);
                                return;
                              }
                              const blobUrl = await fetchWithAuth(
                                file.fileUrl,
                                downloadName,
                              );
                              nativeDownload(blobUrl, downloadName);
                              URL.revokeObjectURL(blobUrl);
                            } catch (err) {
                              console.error("Download failed:", err);
                            }
                          }}
                          className="flex items-center gap-2.5 px-3 py-2.5 rounded-2xl bg-card/80 hover:bg-secondary/70 transition-all group border border-border/70 cursor-pointer shadow-sm"
                        >
                          <div className="w-8 h-8 rounded-lg bg-primary/10 flex items-center justify-center flex-shrink-0">
                            <FileText className="w-4 h-4 text-primary/60" />
                          </div>
                          <div className="flex-1 overflow-hidden">
                            <p className="text-xs font-medium text-foreground/70 truncate">
                              {displayOutputFileName}
                            </p>
                            <p className="text-xs text-muted-foreground/50">
                              {file.mimeType}
                            </p>
                          </div>
                          <Download className="w-4 h-4 text-muted-foreground opacity-0 group-hover:opacity-100 transition-opacity" />
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            )}

            {/* Timestamp, elapsed time, and copy button */}
            {!(message.isStepsPlaceholder && !displayContent?.trim()) && (
              <div
                className={cn(
                  "flex items-center gap-2 mt-1 px-1",
                  isUser ? "justify-end" : "justify-start",
                )}
              >
                <p className="text-xs text-muted-foreground/40">
                  {new Date(message.timestamp).toLocaleTimeString("zh-CN", {
                    hour: "2-digit",
                    minute: "2-digit",
                  })}
                </p>
                {!isUser && elapsedDisplay && (
                  <span className="text-xs font-mono text-muted-foreground/50 flex items-center gap-0.5">
                    <Clock className="w-2.5 h-2.5" />
                    {elapsedDisplay}
                  </span>
                )}
                {/* Copy button for assistant messages */}
                {!isUser && displayContent && displayContent.trim() !== "" && (
                  <button
                    type="button"
                    onClick={handleCopyMessage}
                    className={cn(
                      "ml-1 inline-flex items-center gap-1 rounded-md bg-transparent px-2 py-0.5 text-xs font-medium transition-all duration-200 hover:bg-transparent active:scale-95",
                      copied
                        ? "text-emerald-600 dark:text-emerald-400"
                        : "text-muted-foreground hover:text-primary",
                    )}
                    title="复制内容"
                  >
                    {copied ? (
                      <>
                        <CheckCircle2 className="w-3 h-3" />
                        已复制
                      </>
                    ) : (
                      <>
                        <Copy className="w-3 h-3" />
                        复制
                      </>
                    )}
                  </button>
                )}
              </div>
            )}
          </div>
        </motion.div>
      </MessageActions>

      {/* Markdown file reader dialog */}
      {mdReaderFile && (
        <MarkdownFileReader
          fileUrl={mdReaderFile.url}
          fileName={mdReaderFile.name}
          isOpen={mdReaderOpen}
          onClose={() => {
            setMdReaderOpen(false);
            setMdReaderFile(null);
          }}
        />
      )}

      {/* PDF/HTML viewer dialog */}
      {pdfViewerFile && (
        <PdfViewer
          fileUrl={pdfViewerFile.url}
          fileName={pdfViewerFile.name}
          isPdf={pdfViewerFile.isPdf}
          isOpen={pdfViewerOpen}
          onClose={() => {
            setPdfViewerOpen(false);
            setPdfViewerFile(null);
          }}
        />
      )}
    </>
  );
}

/**
 * StatusBadge — simplified: removed "已完成" icon display per req 4
 */
function StatusBadge({
  status,
  knowledgeBase = false,
}: {
  status: string;
  knowledgeBase?: boolean;
}) {
  const config: Record<
    string,
    { icon: React.ReactNode; label: string; className: string }
  > = {
    idle: {
      icon: <Clock className="w-3 h-3" />,
      label: "就绪",
      className: "bg-muted/60 text-muted-foreground border-border/30",
    },
    running: {
      icon: <Loader2 className="w-3 h-3 animate-spin" />,
      label: "处理中",
      className: "bg-amber-50 text-amber-600 border-amber-200/60",
    },
    pending: {
      icon: <Loader2 className="w-3 h-3 animate-spin" />,
      label: "排队中",
      className: "bg-blue-50 text-blue-600 border-blue-200/60",
    },
    awaiting_input: {
      icon: <Clock className="w-3 h-3" />,
      label: knowledgeBase ? "待确认" : "等待回复",
      className: "bg-violet-50 text-violet-700 border-violet-200/60",
    },
    completed: {
      icon: <CheckCircle2 className="w-3 h-3" />,
      label: "已完成",
      className: "bg-emerald-50 text-emerald-700 border-emerald-200/60",
    },
    error: {
      icon: <AlertCircle className="w-3 h-3" />,
      label: "错误",
      className: "bg-red-50 text-red-600 border-red-200/60",
    },
    failed: {
      icon: <AlertCircle className="w-3 h-3" />,
      label: "失败",
      className: "bg-red-50 text-red-600 border-red-200/60",
    },
  };

  const c = config[status] || config.idle;

  return (
    <Badge
      variant="outline"
      className={cn("gap-1 text-xs font-medium py-0.5", c.className)}
    >
      {c.icon}
      {c.label}
    </Badge>
  );
}

function formatExecutionDuration(seconds: number) {
  if (seconds < 60) return `${seconds.toFixed(1)}s`;
  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = Math.floor(seconds % 60);
  return `${minutes}m ${remainingSeconds}s`;
}
