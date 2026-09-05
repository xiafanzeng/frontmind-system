/**
 * Enhanced useSendMessage Hook with retry mechanism and streaming support
 * Features: Safe retry for uploads, streaming responses,
 *           upload progress tracking, durable handoff to global polling,
 *           identity-aware output reconciliation for multi-turn conversations,
 *           per-message model override (agentProfile parameter),
 *           credit event bus emission on task completion for real-time refresh.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import {
  createTask,
  createResponseLogicTask,
  createKnowledgeBaseTurnTask,
  reserveKnowledgeBaseTurnWithAttachments,
  stageKnowledgeBaseTurnAttachment,
  uploadChatLocalAsset,
  uploadKnowledgeBaseLocalAsset,
  fileToBase64,
  creditEventBus,
  sanitizeBrandText,
  buildPromptText,
  RESPONSE_LOGIC_RESET_REQUIRED_MESSAGE_ID_PREFIX,
  type ContentItem,
  type GeneralAgentModelProfile,
  type KnowledgeBaseAttachmentManifestItem,
  type Message,
  type ResponseLogicTaskContext,
  type ResponseLogicTaskStartFailure,
  type TaskResponse,
  type UploadRetentionReceipt,
} from "@/lib/frontmind-api";
import type { GeneralChatDispatchMetadata } from "@shared/frontmind-general-chat-dispatch";
import {
  GENERAL_CHAT_PARTIAL_RESULT_ERROR_CODE,
  GENERAL_CHAT_PARTIAL_RESULT_MESSAGE,
  generalChatTerminalMessagePublicId,
} from "@shared/frontmind-general-chat-terminal";
import {
  useConversation,
  type Attachment,
  type LocalMessage,
} from "@/contexts/ConversationContext";
import {
  prepareUploadFiles,
  ZIP_REFERENCE_PROMPT,
  isImageUpload,
  normalizedKnowledgeBaseUploadFilename,
  normalizedKnowledgeBaseUploadMimeType,
  assertChatAttachmentSizes,
  type PreparedUploadFiles,
} from "@/lib/attachment-files";
import { requireCurrentFrontMindBuild } from "@/lib/build-version";
import {
  collectAssistantOutputIds,
  projectTaskOutputMessages,
  sliceNewOutput,
} from "@/lib/task-output-projection";
import { toast } from "sonner";
import { knowledgeBaseObservationAcknowledgesClientRequest } from "@/lib/knowledge-base-coordinator";
import type { KnowledgeBaseObservationDto } from "@/lib/knowledge-progress";

export {
  collectAssistantOutputIds,
  outputForKnowledgePresentation,
  sliceNewOutput,
} from "@/lib/task-output-projection";

const MAX_RETRIES = 3;
const INITIAL_RETRY_DELAY = 1000; // 1 second
const MAX_RETRY_DELAY = 10000; // 10 seconds

interface RetryConfig {
  maxRetries: number;
  initialDelay: number;
  maxDelay: number;
}

const defaultRetryConfig: RetryConfig = {
  maxRetries: MAX_RETRIES,
  initialDelay: INITIAL_RETRY_DELAY,
  maxDelay: MAX_RETRY_DELAY,
};

// Exponential backoff with jitter
function calculateBackoff(attempt: number, config: RetryConfig): number {
  const exponentialDelay = config.initialDelay * Math.pow(2, attempt);
  const jitter = Math.random() * 0.3 * exponentialDelay;
  return Math.min(exponentialDelay + jitter, config.maxDelay);
}

// Retry wrapper for retry-safe API calls. Do not use for POST /v1/tasks.
async function withRetry<T>(
  fn: () => Promise<T>,
  config: RetryConfig = defaultRetryConfig,
): Promise<T> {
  let lastError: Error | null = null;

  for (let attempt = 0; attempt <= config.maxRetries; attempt++) {
    try {
      return await fn();
    } catch (error: any) {
      lastError = error;

      // Don't retry on certain errors
      if (
        error.message?.includes("401") ||
        error.message?.includes("403") ||
        error.message?.includes("404") ||
        error.message?.includes("authentication") ||
        error.message?.includes("not found")
      ) {
        throw error;
      }

      if (attempt < config.maxRetries) {
        const delay = calculateBackoff(attempt, config);
        console.log(
          `Retrying in ${Math.round(delay)}ms (attempt ${attempt + 1}/${config.maxRetries})`,
        );
        await new Promise((resolve) => setTimeout(resolve, delay));
      }
    }
  }

  throw lastError || new Error("重试次数已达上限");
}

export type FailureKind = "quota" | "attachment" | "auth" | "busy" | "unknown";

export function classifyFailure(errorMsg: string): FailureKind {
  if (/quota|credit|balance|insufficient|积分|额度|余额|点数/i.test(errorMsg)) {
    return "quota";
  }
  if (
    /ATTACHMENT_FORBIDDEN|附件不属于当前账号|上传资料与当前(?:账号|知识库任务|应答逻辑任务)不匹配/i.test(
      errorMsg,
    )
  ) {
    return "attachment";
  }
  if (
    /401|403|unauthorized|forbidden|authentication|authenticate|api[\s_-]*key|apikey|密钥|鉴权|认证/i.test(
      errorMsg,
    )
  ) {
    return "auth";
  }
  if (
    /server is temporarily overloaded|temporarily overloaded|overloaded|server busy|too busy|503|504|timeout|timed out|超时|响应过慢|ECONNABORTED|ETIMEDOUT/i.test(
      errorMsg,
    )
  ) {
    return "busy";
  }
  return "unknown";
}

function getFailureAdvice(errorMsg: string) {
  const failureKind = classifyFailure(errorMsg);

  if (failureKind === "quota") {
    return "当前服务资源可能不足，请联系负责管理员处理。";
  }
  if (failureKind === "attachment") {
    return "多个账号可以共享服务连接，但历史任务与附件仍绑定原服务凭证。密钥轮换后无法继续该历史任务，请新建对话；如仍需附件，请在新对话中重新添加。";
  }
  if (failureKind === "auth") {
    return "当前服务连接配置异常，请联系负责管理员处理。";
  }
  if (failureKind === "busy") {
    return "服务暂时繁忙，或本次附件任务较重。请稍后手动重试；如果反复失败，可以把原图手动压缩为 ZIP 后再发送。";
  }
  return "请求未完成，请稍后手动重试。";
}

function getFailureDisplayMessage(errorMsg: string) {
  return classifyFailure(errorMsg) === "attachment"
    ? "历史任务的附件与当前服务凭证不兼容。"
    : errorMsg;
}

function generalChatTaskError(response: TaskResponse) {
  return response.error;
}

function generalChatTaskErrorCode(response: TaskResponse) {
  const error = generalChatTaskError(response);
  if (error?.partialResult === true) {
    return GENERAL_CHAT_PARTIAL_RESULT_ERROR_CODE;
  }
  return error?.code?.trim() || "TASK_FAILED";
}

function generalChatDispatchErrorCode(error: unknown) {
  const candidate = error as { code?: unknown; status?: unknown } | null;
  if (
    typeof candidate?.code === "string" &&
    /^[A-Z0-9_:-]{1,128}$/u.test(candidate.code)
  ) {
    return candidate.code;
  }
  const status = Number(candidate?.status);
  if (Number.isInteger(status) && status >= 400 && status <= 599) {
    return `HTTP_${status}`;
  }
  const message = error instanceof Error ? error.message : String(error);
  return `DISPATCH_${classifyFailure(message).toUpperCase()}`;
}

export function readResponseLogicTaskStartFailure(
  error: unknown,
): ResponseLogicTaskStartFailure | null {
  if (!error || typeof error !== "object") return null;
  const candidate = error as Partial<ResponseLogicTaskStartFailure>;
  if (
    typeof candidate.code !== "string" ||
    typeof candidate.message !== "string" ||
    typeof candidate.retryable !== "boolean" ||
    typeof candidate.resetRequired !== "boolean" ||
    ![
      "validation",
      "file_upload_intent",
      "file_upload_content",
      "file_confirmation",
      "task_create",
      "task_message",
      "task_binding",
      "upstream",
      "dashboard_transport",
      "response",
    ].includes(candidate.stage as string)
  ) {
    return null;
  }
  return {
    code: candidate.code,
    message: candidate.message,
    retryable: candidate.retryable,
    resetRequired: candidate.resetRequired,
    stage: candidate.stage as ResponseLogicTaskStartFailure["stage"],
    ...(typeof candidate.incidentId === "string"
      ? { incidentId: candidate.incidentId }
      : {}),
    ...(typeof candidate.retryAfterMs === "number"
      ? { retryAfterMs: candidate.retryAfterMs }
      : {}),
    ...(typeof candidate.status === "number"
      ? { status: candidate.status }
      : {}),
  };
}

export function responseLogicStartFailureMessage(
  failure: ResponseLogicTaskStartFailure,
) {
  const title = failure.resetRequired ? "任务创建结果无法确认" : "任务尚未创建";
  const recovery = failure.resetRequired
    ? "请先申请重置；批准后系统会使用全新会话、全新资料和全新任务重新开始。"
    : failure.retryable
      ? "当前输入和附件已保留，可以稍后直接重新发送。"
      : "请根据页面提示处理后重新发送。";
  const incident = failure.incidentId
    ? `\n\n故障编号：${failure.incidentId}`
    : "";
  return {
    title,
    description: `${failure.message} ${recovery}`,
    assistantMessage: `❌ ${title}\n\n${failure.message}\n\n${recovery}${incident}`,
  };
}

/** Upload progress info exposed to UI */
export interface UploadProgress {
  /** Current durable attachment phase after bytes reach object storage. */
  phase?: "uploading" | "verifying";
  /** Index of the file currently being uploaded (0-based) */
  currentFileIndex: number;
  /** Total number of files to upload */
  totalFiles: number;
  /** Name of the file currently being uploaded */
  currentFileName: string;
  /** Upload percent of the current file (0-100) */
  currentFilePercent: number;
  /** Overall percent across all files (0-100) */
  overallPercent: number;
  /** The conversation ID this upload belongs to */
  conversationId?: string;
}

export type KnowledgeBaseAttachmentAttempt = {
  conversationId: string;
  clientRequestId: string;
  turnId?: string;
  submissionKind: "start" | "revise";
  originalMessageEnvelope: unknown;
  files: Array<{
    file: File;
    itemId: string;
    ordinal: number;
    sha256?: string;
    manifestItem: KnowledgeBaseAttachmentManifestItem;
    stagedReceipt?: UploadRetentionReceipt;
    /** Dashboard rediscovered and staged the deterministic local asset. */
    stagedByResume?: boolean;
  }>;
  generation: number;
  stateEpoch: number;
  resetRevision: number;
  expectedContentVersion?: number;
  expectedRevision?: number;
  expectedLeafId?: string;
  expectedPresentationKey?: string;
  phase:
    | "hashing"
    | "reserving"
    | "uploading"
    | "staging"
    | "dispatching"
    | "reconciling_dispatch"
    | "failed_retryable"
    | "accepted";
  activeOrdinal?: number;
  progressPercent?: number;
  lastError?: string;
};

type FrozenKnowledgeBaseAttemptEnvelope = {
  text: string;
  options: {
    agentProfile?: string;
    syncKnowledgeBaseSnapshot: true;
    knowledgeBaseExpectedGeneration?: number;
    knowledgeBaseExpectedResetRevision?: number;
    knowledgeBaseExpectedStateEpoch?: number;
    knowledgeBaseExpectedContentVersion?: number;
    knowledgeBaseExpectedRevision?: number;
    knowledgeBaseExpectedLeafId?: string;
    knowledgeBaseExpectedPresentationKey?: string;
    submissionKind?: "message" | "logo";
  };
};

type FrozenGeneralChatDispatchEnvelope = {
  messageId: string;
  inputSignature: string;
  contentItems: ContentItem[];
  attachments: Attachment[];
  preparedUploads: PreparedUploadFiles;
  dispatch: GeneralChatDispatchMetadata;
};

type DurableGeneralChatRetry = {
  message: LocalMessage;
  dispatch: GeneralChatDispatchMetadata;
};

function normalizedGeneralAgentProfile(
  value: string | undefined,
): GeneralAgentModelProfile {
  return value === "frontmind-lite" ||
    value === "frontmind-base" ||
    value === "frontmind-pro"
    ? value
    : "frontmind-pro";
}

function contentItemsForDurableGeneralChatRetry(
  retry: DurableGeneralChatRetry,
): ContentItem[] {
  const attachmentByFileId = new Map(
    (retry.message.attachments ?? []).flatMap((attachment) =>
      attachment.fileId ? [[attachment.fileId, attachment] as const] : [],
    ),
  );
  return [
    { type: "input_text", text: retry.dispatch.providerPrompt },
    ...retry.dispatch.localAssetIds.map((fileId) => {
      const attachment = attachmentByFileId.get(fileId);
      return {
        type: "input_file" as const,
        file_id: fileId,
        filename: attachment?.name ?? "file",
      };
    }),
  ];
}

export function useSendMessage() {
  const {
    state,
    activeConversation,
    addMessage,
    settleGeneralChatDispatch,
    updateStatus,
    updateAssistantMessages,
    updateTitle,
    createConversation,
    registerKnowledgeBaseConversation,
    wakeKnowledgeBaseConversation,
    commitKnowledgeBaseObservation,
    rollbackPendingKnowledgeBaseTurn,
    flushConversation,
  } = useConversation();

  const sendInFlightRef = useRef(false);
  const activeConvRef = useRef(activeConversation);
  activeConvRef.current = activeConversation;
  const stateRef = useRef(state);
  stateRef.current = state;
  const terminalMessageIdsRef = useRef(new Set<string>());
  const pendingGeneralChatDispatchRef = useRef(
    new Map<string, FrozenGeneralChatDispatchEnvelope>(),
  );

  const [isRetrying, setIsRetrying] = useState(false);
  const [retryCount, setRetryCount] = useState(0);
  const [uploadProgress, setUploadProgress] = useState<UploadProgress | null>(
    null,
  );
  const [knowledgeBaseAttachmentAttempt, setKnowledgeBaseAttachmentAttempt] =
    useState<KnowledgeBaseAttachmentAttempt | null>(null);
  const knowledgeBaseAttachmentAttemptRef =
    useRef<KnowledgeBaseAttachmentAttempt | null>(null);
  const resumeKnowledgeBaseAttachmentAttemptRef =
    useRef<KnowledgeBaseAttachmentAttempt | null>(null);
  // A PUT may succeed before stage returns. Keep that exact receipt so a
  // continuation replays stage with the same file id instead of uploading the
  // browser bytes again. This map is page-memory only.
  const uploadedKnowledgeBaseReceiptsRef = useRef(
    new Map<string, UploadRetentionReceipt>(),
  );

  const replaceKnowledgeBaseAttachmentAttempt = useCallback(
    (attempt: KnowledgeBaseAttachmentAttempt | null) => {
      knowledgeBaseAttachmentAttemptRef.current = attempt;
      setKnowledgeBaseAttachmentAttempt(attempt);
      if (!attempt) uploadedKnowledgeBaseReceiptsRef.current.clear();
    },
    [],
  );

  const updateKnowledgeBaseAttachmentAttempt = useCallback(
    (
      update: (
        current: KnowledgeBaseAttachmentAttempt,
      ) => KnowledgeBaseAttachmentAttempt,
    ) => {
      const current = knowledgeBaseAttachmentAttemptRef.current;
      if (!current) return;
      replaceKnowledgeBaseAttachmentAttempt(update(current));
    },
    [replaceKnowledgeBaseAttachmentAttempt],
  );

  const discardKnowledgeBaseAttachmentAttempt = useCallback(() => {
    resumeKnowledgeBaseAttachmentAttemptRef.current = null;
    replaceKnowledgeBaseAttachmentAttempt(null);
  }, [replaceKnowledgeBaseAttachmentAttempt]);

  // Kept as a compatibility no-op for callers compiled against the old Hook
  // surface. Ordinary running tasks are polled exclusively by useResumePolling.
  const stopPolling = useCallback(() => {}, []);

  const addGeneralChatTerminalMessage = useCallback(
    (input: {
      conversationId: string;
      taskId: string;
      errorCode: string;
      content: string;
      timestamp?: number;
    }) => {
      const messageId = generalChatTerminalMessagePublicId(input);
      const conversation = stateRef.current.conversations.find(
        ({ id }) => id === input.conversationId,
      );
      if (
        terminalMessageIdsRef.current.has(messageId) ||
        conversation?.messages.some((message) => message.id === messageId)
      ) {
        return false;
      }
      terminalMessageIdsRef.current.add(messageId);
      addMessage(input.conversationId, {
        id: messageId,
        role: "assistant",
        content: input.content,
        timestamp: input.timestamp ?? Date.now(),
      });
      return true;
    },
    [addMessage],
  );

  useEffect(() => {
    const attempt = knowledgeBaseAttachmentAttemptRef.current;
    if (!attempt) return;
    const active = activeConversation;
    if (active && active.id !== attempt.conversationId) {
      discardKnowledgeBaseAttachmentAttempt();
      return;
    }
    if (!active) return;
    const knowledgeBase = active.knowledgeBase;
    const hasAuthoritativeGeneration = Boolean(
      knowledgeBase?.initialized ||
        (Number.isSafeInteger(knowledgeBase?.generation) &&
          Number(knowledgeBase?.generation) > 0),
    );
    if (
      (hasAuthoritativeGeneration &&
        knowledgeBase?.generation !== attempt.generation) ||
      (knowledgeBase?.activeTurnResetRevision !== undefined &&
        knowledgeBase.activeTurnResetRevision !== attempt.resetRevision)
    ) {
      discardKnowledgeBaseAttachmentAttempt();
      return;
    }
    if (
      !attempt.turnId &&
      knowledgeBase?.activeClientRequestId === attempt.clientRequestId &&
      knowledgeBase.activeTurnId
    ) {
      updateKnowledgeBaseAttachmentAttempt((current) => ({
        ...current,
        turnId: knowledgeBase.activeTurnId!,
      }));
    }
    const releasedRequestAccepted =
      !knowledgeBase?.activeTurnId &&
      active.messages.some(
        (message) =>
          message.knowledgeBase?.clientRequestId === attempt.clientRequestId &&
          message.knowledgeBase.serverOwned === true,
      );
    const matchingActiveTurn =
      knowledgeBase?.activeClientRequestId === attempt.clientRequestId &&
      (!attempt.turnId || knowledgeBase.activeTurnId === attempt.turnId);
    if (
      (attempt.phase === "dispatching" ||
        attempt.phase === "reconciling_dispatch") &&
      (releasedRequestAccepted ||
        (matchingActiveTurn &&
          knowledgeBase.activeTurnAwaitingClientAttachments !== true))
    ) {
      replaceKnowledgeBaseAttachmentAttempt({
        ...attempt,
        phase: "accepted",
      });
      replaceKnowledgeBaseAttachmentAttempt(null);
    }
  }, [
    activeConversation,
    discardKnowledgeBaseAttachmentAttempt,
    replaceKnowledgeBaseAttachmentAttempt,
    updateKnowledgeBaseAttachmentAttempt,
  ]);

  useEffect(
    () => () => {
      knowledgeBaseAttachmentAttemptRef.current = null;
      resumeKnowledgeBaseAttachmentAttemptRef.current = null;
      uploadedKnowledgeBaseReceiptsRef.current.clear();
    },
    [],
  );

  /**
   * Send a message with optional per-message model override.
   */
  const sendMessage = useCallback(
    async (
      text: string,
      files: File[],
      options?: {
        retryConfig?: RetryConfig;
        agentProfile?: string;
        syncKnowledgeBaseSnapshot?: boolean;
        knowledgeBaseExpectedGeneration?: number;
        knowledgeBaseExpectedResetRevision?: number;
        knowledgeBaseExpectedStateEpoch?: number;
        knowledgeBaseExpectedContentVersion?: number;
        knowledgeBaseExpectedRevision?: number;
        knowledgeBaseExpectedLeafId?: string;
        knowledgeBaseExpectedPresentationKey?: string;
        submissionKind?: "message" | "logo";
        responseLogicContext?: ResponseLogicTaskContext;
        /** Internal: reconstructed from a persisted pending user message. */
        generalChatRetry?: DurableGeneralChatRetry;
      },
    ) => {
      if (sendInFlightRef.current) {
        toast.info("上一条消息正在发送，请稍候");
        return false;
      }

      sendInFlightRef.current = true;
      const requestedResumeAttempt =
        resumeKnowledgeBaseAttachmentAttemptRef.current;
      resumeKnowledgeBaseAttachmentAttemptRef.current = null;

      try {
        const isKnowledgeBaseSubmission =
          options?.syncKnowledgeBaseSnapshot === true;
        const durableGeneralChatRetry =
          !isKnowledgeBaseSubmission && !options?.responseLogicContext
            ? options?.generalChatRetry
            : undefined;
        if (
          !isKnowledgeBaseSubmission &&
          !(await requireCurrentFrontMindBuild(text))
        ) {
          toast.info("检测到新版本，正在刷新后继续");
          return false;
        }
        const retryConfig = options?.retryConfig || defaultRetryConfig;
        const agentProfile =
          durableGeneralChatRetry?.message.modelName ?? options?.agentProfile;

        // Ensure we have an active conversation
        let convId = activeConvRef.current?.id;
        let conv = activeConvRef.current;

        if (!convId) {
          convId = createConversation();
          conv = null;
        }

        const resumedKnowledgeBaseAttachmentAttempt =
          requestedResumeAttempt?.conversationId === convId &&
          options?.syncKnowledgeBaseSnapshot === true
            ? requestedResumeAttempt
            : null;

        const knowledgeBaseSubmissionText = text;
        const generalChatInputSignature = JSON.stringify({
          text: text.trim(),
          files: files.map((file) => ({
            name: file.name,
            size: file.size,
            type: file.type,
            lastModified: file.lastModified,
          })),
        });
        const pendingGeneralChatDispatch =
          !isKnowledgeBaseSubmission && !options?.responseLogicContext
            ? pendingGeneralChatDispatchRef.current.get(convId)
            : undefined;
        const durableGeneralChatEnvelope = durableGeneralChatRetry
          ? {
              messageId: durableGeneralChatRetry.dispatch.clientRequestId,
              inputSignature: generalChatInputSignature,
              contentItems: contentItemsForDurableGeneralChatRetry(
                durableGeneralChatRetry,
              ),
              attachments: (
                durableGeneralChatRetry.message.attachments ?? []
              ).map((attachment) => ({ ...attachment })),
              preparedUploads: {
                files: [],
                didZipLargeImages: false,
                zippedImages: [],
              },
              dispatch: durableGeneralChatRetry.dispatch,
            }
          : undefined;
        const reusableGeneralChatEnvelope =
          durableGeneralChatEnvelope ??
          (pendingGeneralChatDispatch?.inputSignature ===
          generalChatInputSignature
            ? pendingGeneralChatDispatch
            : undefined);
        const knowledgeBaseClientRequestId = options?.syncKnowledgeBaseSnapshot
          ? (resumedKnowledgeBaseAttachmentAttempt?.clientRequestId ??
            (typeof crypto !== "undefined" && "randomUUID" in crypto
              ? crypto.randomUUID()
              : `kb-turn-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`))
          : undefined;
        if (options?.syncKnowledgeBaseSnapshot) {
          registerKnowledgeBaseConversation(convId);
        }

        const baselineOutputLength = conv?.lastKnownOutputLength || 0;
        const historicalOutputIds = collectAssistantOutputIds(conv?.messages);
        const isMultiTurn = !!conv?.previousResponseId;

        if (isMultiTurn) {
          console.log(
            `[Multi-turn] Starting turn with baselineOutputLength=${baselineOutputLength}, ` +
              `previousResponseId=${conv?.previousResponseId?.slice(0, 12)}`,
          );
        }

        // Build content items
        const contentItems: ContentItem[] = reusableGeneralChatEnvelope
          ? reusableGeneralChatEnvelope.contentItems.map((item) => ({
              ...item,
            }))
          : [];
        const attachments: Attachment[] = reusableGeneralChatEnvelope
          ? reusableGeneralChatEnvelope.attachments.map((attachment) => ({
              ...attachment,
            }))
          : [];

        try {
          // This guard is intentionally repeated after preparation below. The
          // composer provides early feedback, while this hook is the shared
          // enforcement point for every chat entry and programmatic caller.
          assertChatAttachmentSizes(files);
        } catch (error) {
          toast.error("文件过大", {
            description:
              error instanceof Error
                ? error.message
                : "单个文件不能超过 100 MB",
          });
          return false;
        }

        // Add text
        if (
          !reusableGeneralChatEnvelope &&
          knowledgeBaseSubmissionText.trim()
        ) {
          contentItems.push({
            type: "input_text",
            text: knowledgeBaseSubmissionText.trim(),
          });
        }

        let preparedUploads: PreparedUploadFiles;
        try {
          preparedUploads = reusableGeneralChatEnvelope
            ? reusableGeneralChatEnvelope.preparedUploads
            : resumedKnowledgeBaseAttachmentAttempt
              ? {
                  files: [...resumedKnowledgeBaseAttachmentAttempt.files]
                    .sort((left, right) => left.ordinal - right.ordinal)
                    .map(({ file }) => ({ file })),
                  didZipLargeImages: false,
                  zippedImages: [],
                }
              : options?.syncKnowledgeBaseSnapshot
                ? {
                    files: files.map((file) => ({ file })),
                    didZipLargeImages: false,
                    zippedImages: [],
                  }
                : await prepareUploadFiles(files);
        } catch (err: any) {
          toast.error("图片 ZIP 打包失败", {
            description:
              err?.message || "请手动将原图压缩为 ZIP 后通过上传文件发送。",
          });
          return false;
        }

        try {
          // Image preparation can replace multiple source images with a ZIP;
          // the generated upload must obey the same per-file contract.
          assertChatAttachmentSizes(
            preparedUploads.files.map(({ file }) => file),
          );
        } catch (error) {
          toast.error("文件过大", {
            description:
              error instanceof Error
                ? error.message
                : "单个文件不能超过 100 MB",
          });
          return false;
        }

        if (!reusableGeneralChatEnvelope && preparedUploads.didZipLargeImages) {
          contentItems.push({ type: "input_text", text: ZIP_REFERENCE_PROMPT });
          toast.info("超高像素图片已无损打包为 ZIP", {
            description:
              "原图像素和文件内容不会被压缩或重编码，将作为文件附件发送。",
            duration: 5000,
          });
        }

        const reservingKnowledgeBaseAttachmentTurn = Boolean(
          options?.syncKnowledgeBaseSnapshot &&
            options.submissionKind !== "logo" &&
            preparedUploads.files.length > 0,
        );
        const knowledgeBaseUploadBatchId = reservingKnowledgeBaseAttachmentTurn
          ? knowledgeBaseClientRequestId
          : undefined;
        let knowledgeBaseAttachmentManifest:
          | KnowledgeBaseAttachmentManifestItem[]
          | undefined;
        if (
          options?.syncKnowledgeBaseSnapshot &&
          options.submissionKind !== "logo" &&
          preparedUploads.files.length > 0
        ) {
          // Reserve from immutable browser metadata. Dashboard computes and
          // binds size/SHA-256 while streaming the actual upload bytes.
          knowledgeBaseAttachmentManifest =
            resumedKnowledgeBaseAttachmentAttempt?.files.map(
              ({ manifestItem }) => manifestItem,
            ) ??
            preparedUploads.files.map(({ file }, index) => ({
              filename: normalizedKnowledgeBaseUploadFilename(file.name),
              sizeBytes: file.size,
              mimeType: normalizedKnowledgeBaseUploadMimeType(file),
              lastModified: Math.max(0, Number(file.lastModified || 0)),
              ...(knowledgeBaseUploadBatchId
                ? {
                    itemId: `${knowledgeBaseUploadBatchId}:${index + 1}`,
                    ordinal: index + 1,
                    total: preparedUploads.files.length,
                  }
                : {}),
            }));
        }

        if (
          reservingKnowledgeBaseAttachmentTurn &&
          knowledgeBaseAttachmentManifest
        ) {
          const resetRevision = options?.knowledgeBaseExpectedResetRevision;
          const coordinateIsComplete =
            Number.isSafeInteger(resetRevision) &&
            Number(resetRevision) >= 0 &&
            Number.isSafeInteger(options?.knowledgeBaseExpectedGeneration) &&
            Number(options?.knowledgeBaseExpectedGeneration) >= 1 &&
            Number.isSafeInteger(options?.knowledgeBaseExpectedRevision) &&
            Number(options?.knowledgeBaseExpectedRevision) >= 0 &&
            typeof options?.knowledgeBaseExpectedLeafId === "string" &&
            options.knowledgeBaseExpectedLeafId.trim().length > 0 &&
            knowledgeBaseAttachmentManifest.length ===
              preparedUploads.files.length &&
            knowledgeBaseAttachmentManifest.every((item, index) => {
              const file = preparedUploads.files[index]?.file;
              return Boolean(
                file &&
                  item.itemId &&
                  item.ordinal === index + 1 &&
                  item.total === preparedUploads.files.length &&
                  item.filename ===
                    normalizedKnowledgeBaseUploadFilename(file.name) &&
                  item.mimeType ===
                    normalizedKnowledgeBaseUploadMimeType(file) &&
                  item.sizeBytes === file.size &&
                  item.lastModified ===
                    Math.max(0, Number(file.lastModified || 0)),
              );
            });
          if (!coordinateIsComplete) {
            toast.error("知识库附件坐标不完整", {
              description: "请刷新后重新选择资料；本轮尚未创建上传预约。",
            });
            return false;
          }
        }

        if (
          reservingKnowledgeBaseAttachmentTurn &&
          knowledgeBaseAttachmentManifest
        ) {
          const frozenGeneration = Number(
            options?.knowledgeBaseExpectedGeneration,
          );
          const frozenResetRevision = Number(
            options?.knowledgeBaseExpectedResetRevision,
          );
          const frozenStateEpoch =
            Number.isSafeInteger(options?.knowledgeBaseExpectedStateEpoch) &&
            Number(options?.knowledgeBaseExpectedStateEpoch) >= 0
              ? Number(options?.knowledgeBaseExpectedStateEpoch)
              : 0;
          // The starter has no initialized Working Set yet; every later
          // browser-backed submission is a revise even when revision/content
          // version happen to be zero during the first-leaf Logo window.
          const frozenSubmissionKind: "start" | "revise" =
            conv?.knowledgeBase?.initialized === true ? "revise" : "start";
          const attempt = resumedKnowledgeBaseAttachmentAttempt ?? {
            conversationId: convId,
            clientRequestId: knowledgeBaseClientRequestId!,
            submissionKind: frozenSubmissionKind,
            originalMessageEnvelope: Object.freeze({
              text: knowledgeBaseSubmissionText,
              options: Object.freeze({
                agentProfile,
                syncKnowledgeBaseSnapshot: true as const,
                knowledgeBaseExpectedGeneration:
                  options?.knowledgeBaseExpectedGeneration,
                knowledgeBaseExpectedResetRevision:
                  options?.knowledgeBaseExpectedResetRevision,
                knowledgeBaseExpectedStateEpoch:
                  options?.knowledgeBaseExpectedStateEpoch,
                knowledgeBaseExpectedContentVersion:
                  options?.knowledgeBaseExpectedContentVersion,
                knowledgeBaseExpectedRevision:
                  options?.knowledgeBaseExpectedRevision,
                knowledgeBaseExpectedLeafId:
                  options?.knowledgeBaseExpectedLeafId,
                knowledgeBaseExpectedPresentationKey:
                  options?.knowledgeBaseExpectedPresentationKey,
                submissionKind: options?.submissionKind,
              }),
            } satisfies FrozenKnowledgeBaseAttemptEnvelope),
            files: preparedUploads.files.map(({ file }, index) => ({
              file,
              itemId: knowledgeBaseAttachmentManifest![index]!.itemId!,
              ordinal: index + 1,
              manifestItem: knowledgeBaseAttachmentManifest![index]!,
            })),
            generation: frozenGeneration,
            stateEpoch: frozenStateEpoch,
            resetRevision: frozenResetRevision,
            expectedContentVersion:
              options?.knowledgeBaseExpectedContentVersion,
            expectedRevision: options?.knowledgeBaseExpectedRevision,
            expectedLeafId: options?.knowledgeBaseExpectedLeafId,
            expectedPresentationKey:
              options?.knowledgeBaseExpectedPresentationKey,
            phase: "reserving" as const,
          };
          replaceKnowledgeBaseAttachmentAttempt({
            ...attempt,
            phase: "reserving",
            lastError: undefined,
          });
        }

        let knowledgeBaseAttachmentReservation:
          | {
              turnId: string;
              sourceResetRevision: number;
              attachmentManifest: KnowledgeBaseAttachmentManifestItem[];
            }
          | undefined;
        if (
          reservingKnowledgeBaseAttachmentTurn &&
          knowledgeBaseAttachmentManifest
        ) {
          try {
            const reserved = resumedKnowledgeBaseAttachmentAttempt?.turnId
              ? {
                  reservation: {
                    turnId: resumedKnowledgeBaseAttachmentAttempt.turnId,
                    sourceResetRevision:
                      resumedKnowledgeBaseAttachmentAttempt.resetRevision,
                  },
                }
              : await reserveKnowledgeBaseTurnWithAttachments(
                  [
                    {
                      role: "user",
                      // Freeze the pre-upload prompt. Later input_file additions
                      // belong only to the local pending bubble and dispatch log.
                      content: [...contentItems],
                    },
                  ],
                  {
                    conversationId: convId,
                    clientRequestId: knowledgeBaseClientRequestId!,
                    expectedResetRevision:
                      options!.knowledgeBaseExpectedResetRevision!,
                    expectedGeneration:
                      options!.knowledgeBaseExpectedGeneration!,
                    expectedRevision: options!.knowledgeBaseExpectedRevision!,
                    expectedLeafId: options!.knowledgeBaseExpectedLeafId!,
                    expectedPresentationKey:
                      options?.knowledgeBaseExpectedPresentationKey,
                    attachmentManifest: knowledgeBaseAttachmentManifest,
                  },
                );
            knowledgeBaseAttachmentReservation = {
              turnId: reserved.reservation.turnId,
              sourceResetRevision: reserved.reservation.sourceResetRevision,
              attachmentManifest: knowledgeBaseAttachmentManifest,
            };
            updateKnowledgeBaseAttachmentAttempt((current) => ({
              ...current,
              turnId: reserved.reservation.turnId,
              phase: "uploading",
            }));
            if (
              "knowledgeObservation" in reserved &&
              reserved.knowledgeObservation
            ) {
              commitKnowledgeBaseObservation(
                convId,
                reserved.knowledgeObservation,
              );
            }
          } catch (reservationError: any) {
            if (reservationError?.knowledgeObservation) {
              commitKnowledgeBaseObservation(
                convId,
                reservationError.knowledgeObservation,
              );
            }
            updateKnowledgeBaseAttachmentAttempt((current) => ({
              ...current,
              phase: "failed_retryable",
              lastError: sanitizeBrandText(
                reservationError?.message || "本轮附件预约失败",
              ),
            }));
            toast.error("本轮附件预约失败", {
              description: sanitizeBrandText(
                `${reservationError?.message || "请同步知识库状态后重试。"} 可继续使用当前资料重试同一预约。`,
              ),
            });
            return false;
          }
        }

        // Process files with progress tracking. All attachments are sent as files,
        // including images, to avoid the direct oversized image visual path.
        const totalFiles = preparedUploads.files.length;
        if (totalFiles > 0 && !reusableGeneralChatEnvelope) {
          setUploadProgress({
            currentFileIndex: 0,
            totalFiles,
            currentFileName: preparedUploads.files[0].file.name,
            currentFilePercent: 0,
            overallPercent: 0,
            conversationId: convId,
          });
        }

        for (
          let i = 0;
          i < (reusableGeneralChatEnvelope ? 0 : preparedUploads.files.length);
          i++
        ) {
          const prepared = preparedUploads.files[i];
          const file = prepared.file;
          const attemptFile =
            knowledgeBaseAttachmentAttemptRef.current?.files[i];
          const knowledgeBaseFilename = options?.syncKnowledgeBaseSnapshot
            ? normalizedKnowledgeBaseUploadFilename(file.name)
            : undefined;

          if (knowledgeBaseAttachmentReservation) {
            updateKnowledgeBaseAttachmentAttempt((current) => ({
              ...current,
              phase:
                attemptFile?.stagedReceipt || attemptFile?.stagedByResume
                  ? "staging"
                  : "uploading",
              activeOrdinal: i + 1,
              progressPercent: Math.round((i / totalFiles) * 100),
            }));
          }

          setUploadProgress({
            currentFileIndex: i,
            totalFiles,
            currentFileName: file.name,
            currentFilePercent: 0,
            overallPercent: Math.round((i / totalFiles) * 100),
            conversationId: convId,
          });

          // For files: use blob URL for large files (>1MB) to avoid localStorage overflow,
          // and base64 only for small non-image files that can be persisted.
          const FILE_SIZE_THRESHOLD = 1 * 1024 * 1024; // 1MB
          const isLargeFile = file.size > FILE_SIZE_THRESHOLD;
          const isImageFile = isImageUpload(file);
          let fileBase64: string | undefined;
          let fileBlobUrl: string | undefined;

          // A knowledge-base browser File is owned exclusively by the
          // page-memory attempt until the matching request is accepted. Do not
          // duplicate those bytes into the conversation attachment payload,
          // where they could outlive the attempt or enter persistence code.
          if (!knowledgeBaseAttachmentReservation) {
            if (isLargeFile) {
              fileBlobUrl = URL.createObjectURL(file);
            } else if (!isImageFile) {
              fileBase64 = await fileToBase64(file);
            }
          }

          try {
            if (knowledgeBaseAttachmentReservation) {
              console.log("[SendMessage] Preparing knowledge-base attachment", {
                ordinal: i + 1,
                attachmentCount: totalFiles,
                declaredBytes: file.size,
              });
            } else {
              console.log("[SendMessage] Uploading file attachment", {
                filename: file.name,
                size: file.size,
                generatedFromImages: prepared.generatedFromImages?.map(
                  (image) => image.name,
                ),
              });
            }

            const uploadProgressHandler = (percent: number) => {
              setUploadProgress({
                currentFileIndex: i,
                totalFiles,
                currentFileName: file.name,
                currentFilePercent: percent,
                overallPercent: Math.round(
                  ((i + percent / 100) / totalFiles) * 100,
                ),
                conversationId: convId,
              });
              if (knowledgeBaseAttachmentReservation) {
                updateKnowledgeBaseAttachmentAttempt((current) => ({
                  ...current,
                  phase: "uploading",
                  activeOrdinal: i + 1,
                  progressPercent: Math.round(
                    ((i + percent / 100) / totalFiles) * 100,
                  ),
                }));
              }
            };
            const retainedReceipt = attemptFile?.itemId
              ? uploadedKnowledgeBaseReceiptsRef.current.get(attemptFile.itemId)
              : undefined;
            const result =
              (attemptFile?.stagedByResume
                ? ({
                    fileId: "",
                    sizeBytes: file.size,
                    uploadedAt: Date.now(),
                    expiresAt: Date.now(),
                    replayed: true,
                    recovered: true,
                    alreadyStaged: true as const,
                    filename: knowledgeBaseFilename!,
                  } as const)
                : attemptFile?.stagedReceipt) ??
              retainedReceipt ??
              (options?.syncKnowledgeBaseSnapshot
                ? await uploadKnowledgeBaseLocalAsset(
                    file,
                    uploadProgressHandler,
                    retryConfig,
                    {
                      captureLocalCopy: true,
                      captureFilename: knowledgeBaseFilename!,
                      ...(knowledgeBaseAttachmentReservation &&
                      knowledgeBaseUploadBatchId
                        ? {
                            batchId: knowledgeBaseUploadBatchId,
                            batchOrdinal: i + 1,
                            batchTotal: totalFiles,
                            itemId:
                              knowledgeBaseAttachmentManifest?.[i]?.itemId,
                            ...(knowledgeBaseAttachmentManifest?.[i]?.sha256
                              ? {
                                  contentSha256:
                                    knowledgeBaseAttachmentManifest[i]!.sha256,
                                }
                              : {}),
                            resumeScope: {
                              kind: "knowledge_base" as const,
                              operationType: "revise" as const,
                              conversationId: convId,
                              turnId: knowledgeBaseAttachmentReservation.turnId,
                              clientRequestId: knowledgeBaseClientRequestId!,
                              expectedResetRevision:
                                knowledgeBaseAttachmentReservation.sourceResetRevision,
                            },
                          }
                        : {}),
                    },
                  )
                : await uploadChatLocalAsset(file, uploadProgressHandler));
            const attachmentAlreadyStaged =
              "alreadyStaged" in result && result.alreadyStaged === true;
            const resumedKnowledgeObservation = attachmentAlreadyStaged
              ? (
                  result as {
                    knowledgeObservation?: KnowledgeBaseObservationDto;
                  }
                ).knowledgeObservation
              : undefined;
            if (resumedKnowledgeObservation) {
              commitKnowledgeBaseObservation(
                convId,
                resumedKnowledgeObservation,
              );
            }

            if (
              knowledgeBaseAttachmentReservation &&
              attemptFile?.itemId &&
              !attemptFile.stagedReceipt &&
              !attachmentAlreadyStaged
            ) {
              uploadedKnowledgeBaseReceiptsRef.current.set(
                attemptFile.itemId,
                result as UploadRetentionReceipt,
              );
            }

            if (knowledgeBaseAttachmentReservation) {
              console.log("[SendMessage] Knowledge-base attachment retained", {
                ordinal: i + 1,
                attachmentCount: totalFiles,
                declaredBytes: file.size,
              });
            } else {
              console.log("[SendMessage] Uploaded file attachment", {
                filename: "filename" in result ? result.filename : file.name,
                fileId: result.fileId,
              });
            }

            if (
              knowledgeBaseAttachmentReservation &&
              knowledgeBaseAttachmentManifest &&
              !attemptFile?.stagedReceipt &&
              !attachmentAlreadyStaged
            ) {
              updateKnowledgeBaseAttachmentAttempt((current) => ({
                ...current,
                phase: "staging",
                activeOrdinal: i + 1,
              }));
              await stageKnowledgeBaseTurnAttachment({
                conversationId: convId,
                turnId: knowledgeBaseAttachmentReservation.turnId,
                clientRequestId: knowledgeBaseClientRequestId!,
                expectedResetRevision:
                  knowledgeBaseAttachmentReservation.sourceResetRevision,
                attachmentManifest: knowledgeBaseAttachmentManifest,
                index: i,
                attachment: {
                  file_id: result.fileId,
                  filename: knowledgeBaseFilename!,
                },
              });
              updateKnowledgeBaseAttachmentAttempt((current) => ({
                ...current,
                files: current.files.map((candidate) =>
                  candidate.ordinal === i + 1
                    ? {
                        ...candidate,
                        stagedReceipt: result as UploadRetentionReceipt,
                      }
                    : candidate,
                ),
                phase: "uploading",
                progressPercent: Math.round(((i + 1) / totalFiles) * 100),
              }));
            }
            if (attachmentAlreadyStaged) {
              updateKnowledgeBaseAttachmentAttempt((current) => ({
                ...current,
                files: current.files.map((candidate) =>
                  candidate.ordinal === i + 1
                    ? { ...candidate, stagedByResume: true }
                    : candidate,
                ),
                phase: "uploading",
                progressPercent: Math.round(((i + 1) / totalFiles) * 100),
              }));
            } else {
              contentItems.push({
                type: "input_file",
                file_id: result.fileId,
                filename:
                  knowledgeBaseFilename ||
                  ("filename" in result ? result.filename : file.name),
                mime_type: file.type || "application/octet-stream",
              });
              attachments.push({
                id: `att-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
                type: "file",
                name: file.name,
                fileId: result.fileId,
                ...(!knowledgeBaseAttachmentReservation
                  ? {
                      base64: fileBase64,
                      blobUrl: fileBlobUrl,
                      file,
                    }
                  : {}),
                expiresAt: result.expiresAt,
                expired: false,
              });
            }
          } catch (uploadErr: any) {
            // The attachment never reached ConversationContext, so its normal
            // lifecycle cleanup cannot see this optimistic URL.
            if (fileBlobUrl) URL.revokeObjectURL(fileBlobUrl);
            for (const uploadedAttachment of attachments) {
              if (uploadedAttachment.blobUrl) {
                URL.revokeObjectURL(uploadedAttachment.blobUrl);
              }
            }
            if (knowledgeBaseAttachmentReservation) {
              console.warn("[SendMessage] Knowledge-base attachment failed", {
                ordinal: i + 1,
                attachmentCount: totalFiles,
                declaredBytes: file.size,
                stage: knowledgeBaseAttachmentAttemptRef.current?.phase,
              });
            } else {
              console.warn(
                `File upload failed for "${file.name}":`,
                sanitizeBrandText(uploadErr?.message || "上传失败"),
              );
            }
            // A terminal upload failure must release the composer immediately.
            // The local ingress already applies its bounded request contract;
            // keeping progress here would leave the UI permanently disabled.
            setUploadProgress(null);
            if (uploadErr?.knowledgeObservation) {
              commitKnowledgeBaseObservation(
                convId,
                uploadErr.knowledgeObservation,
              );
            }
            if (knowledgeBaseAttachmentReservation) {
              updateKnowledgeBaseAttachmentAttempt((current) => ({
                ...current,
                phase: "failed_retryable",
                activeOrdinal: i + 1,
                lastError: sanitizeBrandText(
                  uploadErr?.message || "上传未完成",
                ),
              }));
            }
            toast.error(`文件 "${file.name}" 上传失败`, {
              description: sanitizeBrandText(
                knowledgeBaseAttachmentReservation
                  ? `${uploadErr?.message || "上传未完成"}。本轮任务尚未派发；可继续上传当前资料，或放弃本轮返回当前节点。`
                  : uploadErr?.message || "请稍后重试。",
              ),
            });
            return false;
          }

          setUploadProgress({
            currentFileIndex: i,
            totalFiles,
            currentFileName: file.name,
            currentFilePercent: 100,
            overallPercent: Math.round(((i + 1) / totalFiles) * 100),
            conversationId: convId,
          });
        }

        // Clear upload progress
        setUploadProgress(null);

        if (knowledgeBaseAttachmentReservation) {
          updateKnowledgeBaseAttachmentAttempt((current) => ({
            ...current,
            phase: "dispatching",
            activeOrdinal: undefined,
            progressPercent: 100,
            lastError: undefined,
          }));
        }

        if (contentItems.length === 0 && !knowledgeBaseAttachmentReservation) {
          return false;
        }

        // Add user message to conversation
        const reuseGeneralChatMessageId =
          reusableGeneralChatEnvelope?.messageId;
        const ordinaryOriginalLocalTaskId =
          reusableGeneralChatEnvelope !== undefined
            ? reusableGeneralChatEnvelope.dispatch.localTaskId
            : (conv?.previousResponseId ?? conv?.taskId ?? null);
        const generalChatDispatch =
          !isKnowledgeBaseSubmission && !options?.responseLogicContext
            ? (reusableGeneralChatEnvelope?.dispatch ?? {
                schemaVersion: 1 as const,
                kind: "pending_user" as const,
                clientRequestId:
                  reuseGeneralChatMessageId ??
                  `msg-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
                providerPrompt: buildPromptText([
                  { role: "user", content: contentItems },
                ]),
                localAssetIds: [
                  ...new Set(
                    contentItems.flatMap((item) =>
                      item.type === "input_file" && item.file_id
                        ? [item.file_id]
                        : [],
                    ),
                  ),
                ].sort(),
                localTaskId: ordinaryOriginalLocalTaskId,
                modelProfile:
                  ordinaryOriginalLocalTaskId === null
                    ? normalizedGeneralAgentProfile(agentProfile)
                    : null,
              })
            : undefined;
        const userMessage: LocalMessage = {
          id:
            generalChatDispatch?.clientRequestId ??
            reuseGeneralChatMessageId ??
            `msg-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
          role: "user",
          content:
            durableGeneralChatRetry?.message.content ??
            knowledgeBaseSubmissionText.trim(),
          attachments: attachments.length > 0 ? attachments : undefined,
          timestamp: durableGeneralChatRetry?.message.timestamp ?? Date.now(),
          ...(!isKnowledgeBaseSubmission && agentProfile
            ? { modelName: agentProfile }
            : {}),
          ...(knowledgeBaseClientRequestId
            ? {
                knowledgeBase: {
                  kind: "pending_user" as const,
                  clientRequestId: knowledgeBaseClientRequestId,
                },
              }
            : {}),
          ...(generalChatDispatch ? { generalChatDispatch } : {}),
        };

        const pendingMessageAlreadyExists = Boolean(
          reuseGeneralChatMessageId ||
            activeConvRef.current?.messages.some(
              (message) =>
                message.role === "user" &&
                (message.id === userMessage.id ||
                  (knowledgeBaseClientRequestId &&
                    message.knowledgeBase?.clientRequestId ===
                      knowledgeBaseClientRequestId)),
            ),
        );
        if (!isKnowledgeBaseSubmission && !options?.responseLogicContext) {
          pendingGeneralChatDispatchRef.current.set(
            convId,
            reusableGeneralChatEnvelope ?? {
              messageId: userMessage.id,
              inputSignature: generalChatInputSignature,
              contentItems: contentItems.map((item) => ({ ...item })),
              attachments: attachments.map((attachment) => ({ ...attachment })),
              preparedUploads,
              dispatch: generalChatDispatch!,
            },
          );
          // Mark the identity domain before the first user/attachment snapshot.
          updateStatus(convId, conv?.status ?? "idle", {
            executionKind: "general_chat_v2",
          });
        }
        if (!pendingMessageAlreadyExists) {
          addMessage(convId, userMessage);
        }

        // Update title if this is the first message
        if (!conv || conv.messages.length === 0) {
          const raw = knowledgeBaseSubmissionText.trim();
          const title =
            (raw ? raw.slice(0, 10) + (raw.length > 10 ? "..." : "") : null) ||
            (files.length > 0
              ? `文件: ${files[0].name.slice(0, 6)}`
              : "新内容流程");
          updateTitle(convId, title);
        }

        if (!isKnowledgeBaseSubmission && !options?.responseLogicContext) {
          const snapshotAcknowledged = await flushConversation(convId);
          if (!snapshotAcknowledged) {
            toast.error("会话尚未同步", {
              description: "消息和附件已保留。请重试，请勿重复发送。",
            });
            return false;
          }
        }

        const responseStartedAt = Date.now();

        try {
          const input: Message[] = [
            {
              role: "user",
              content: contentItems,
            },
          ];

          const taskOptions: {
            previousResponseId?: string;
            taskId?: string;
            conversationId: string;
            clientRequestId: string;
            modelProfile?:
              | "frontmind-lite"
              | "frontmind-base"
              | "frontmind-pro";
          } = {
            conversationId: convId,
            clientRequestId: userMessage.id,
          };

          if (generalChatDispatch?.localTaskId) {
            taskOptions.previousResponseId = generalChatDispatch.localTaskId;
          }

          // A general-Agent model is selected only when a new local task is
          // created. Continuations keep the immutable server-side operation
          // profile and never send a model override.
          if (generalChatDispatch?.modelProfile) {
            taskOptions.modelProfile = generalChatDispatch.modelProfile;
          }

          console.log("[SendMessage] Creating task", {
            attachmentCount: contentItems.filter(
              (item) => item.type === "input_file" && item.file_id,
            ).length,
            zippedImages: preparedUploads.zippedImages.map(
              (image) => image.name,
            ),
          });

          // Ordinary task creation remains single-shot because POST /v1/tasks is
          // non-idempotent. The knowledge-base route owns its bounded replay by
          // the same durable clientRequestId and exact request body.
          let response: TaskResponse;
          if (isKnowledgeBaseSubmission) {
            response = await createKnowledgeBaseTurnTask(input, {
              conversationId: convId,
              clientRequestId: knowledgeBaseClientRequestId!,
              expectedGeneration: options?.knowledgeBaseExpectedGeneration,
              expectedResetRevision:
                knowledgeBaseAttachmentReservation?.sourceResetRevision ??
                options?.knowledgeBaseExpectedResetRevision,
              expectedStateEpoch: options?.knowledgeBaseExpectedStateEpoch,
              expectedContentVersion:
                options?.knowledgeBaseExpectedContentVersion,
              expectedRevision: options?.knowledgeBaseExpectedRevision,
              expectedLeafId: options?.knowledgeBaseExpectedLeafId,
              expectedPresentationKey:
                options?.knowledgeBaseExpectedPresentationKey,
              submissionKind: options?.submissionKind ?? "message",
              ...(knowledgeBaseAttachmentReservation
                ? {
                    attachmentReservation: knowledgeBaseAttachmentReservation,
                  }
                : knowledgeBaseAttachmentManifest
                  ? { attachmentManifest: knowledgeBaseAttachmentManifest }
                  : {}),
            });

            // Version freshness is non-authoritative. Run its bounded,
            // fail-open check only after the durable turn POST is acknowledged
            // so a slow version.json/CDN (or a reload) cannot delay or cancel
            // confirmation receipt.
            // The turn is already durably accepted. A later version mismatch
            // may reload to the authoritative observation, but must not restore
            // the submitted "确认" or supplement as a draft on the next node.
            void requireCurrentFrontMindBuild();
          } else if (options?.responseLogicContext) {
            response = await createResponseLogicTask(input, {
              ...options.responseLogicContext,
              conversationId: convId,
              ...(isMultiTurn && conv?.previousResponseId
                ? { taskId: conv.previousResponseId }
                : {}),
            });
          } else {
            response = await createTask(input, taskOptions);
          }

          if (!isKnowledgeBaseSubmission && !options?.responseLogicContext) {
            // Any task DTO proves Dashboard owns this request, including a
            // terminal failure DTO. Transport/outcome-unknown errors never
            // reach this branch and retain the durable pending marker.
            settleGeneralChatDispatch(convId, userMessage.id);
            pendingGeneralChatDispatchRef.current.delete(convId);
          }

          setRetryCount(0);
          setIsRetrying(false);

          if (isKnowledgeBaseSubmission) {
            if (
              response.adoptedClientRequestId &&
              response.adoptedClientRequestId !== knowledgeBaseClientRequestId
            ) {
              rollbackPendingKnowledgeBaseTurn(
                convId,
                knowledgeBaseClientRequestId!,
              );
            }
            if (response.knowledgeObservation) {
              commitKnowledgeBaseObservation(
                convId,
                response.knowledgeObservation,
              );
            } else {
              // Compatibility during the server rollout: stay locked until the
              // coordinator obtains a complete authoritative observation.
              updateStatus(convId, "running", {
                taskId: response.id,
                previousResponseId: response.id,
                startedAt: responseStartedAt,
              });
            }
            wakeKnowledgeBaseConversation(convId);
            if (knowledgeBaseAttachmentReservation) {
              replaceKnowledgeBaseAttachmentAttempt({
                ...(knowledgeBaseAttachmentAttemptRef.current ??
                  resumedKnowledgeBaseAttachmentAttempt!),
                phase: "accepted",
              });
              replaceKnowledgeBaseAttachmentAttempt(null);
            }
            toast.success("本轮已提交", {
              description:
                options.submissionKind === "logo"
                  ? "FrontMind 已接收 Logo，正在重新呈现当前知识节点。"
                  : "FrontMind 正在生成并校验当前知识节点。",
              duration: 3200,
            });
            return true;
          }

          if (options?.responseLogicContext) {
            // Provider task IDs for response logic belong exclusively to the
            // dedicated authenticated status route. Never project or poll
            // them through the ordinary Dashboard-local /v2 task contract.
            if (!response.operationRevision) {
              throw new Error("应答逻辑任务缺少轮次标识，请重新提交");
            }
            updateStatus(convId, "running", {
              taskId: response.id,
              previousResponseId: response.id,
              executionKind: "response_logic",
              startedAt: responseStartedAt,
            });
            try {
              options.responseLogicContext.onTaskStarted?.({
                questionId: options.responseLogicContext.questionId,
                conversationId: convId,
                taskId: response.id,
                operationRevision: response.operationRevision,
                startedAt: responseStartedAt,
              });
            } catch (callbackError) {
              console.warn(
                "[ResponseLogic] dedicated poller handoff deferred",
                callbackError,
              );
            }
            toast.success("任务已创建", {
              description: "FrontMind 正在生成并校验应答逻辑。",
              duration: 3200,
            });
            return true;
          }

          const effectiveStatus =
            response.status === "failed" ? "error" : response.status;
          const totalInitialOutputLength = response.output?.length || 0;
          const initialStatusIsTerminal =
            effectiveStatus === "completed" || effectiveStatus === "error";

          updateStatus(convId, effectiveStatus as any, {
            ...(response.clearTaskPointer
              ? { clearTaskPointer: true }
              : {
                  taskId: response.id,
                  previousResponseId: response.id,
                }),
            startedAt: responseStartedAt,
            ...(initialStatusIsTerminal
              ? { lastKnownOutputLength: totalInitialOutputLength }
              : {}),
          });

          if (effectiveStatus === "running" || effectiveStatus === "pending") {
            toast.success("任务已创建", {
              description:
                "FrontMind 已开始处理，结果会自动出现在当前内容流程中。",
              duration: 3200,
            });
          }

          // Ordinary tasks may render running output. Knowledge-base text is
          // shown only after the server validates the exact revision/leaf pair.
          if (response.output && response.output.length > 0) {
            const newOutput = sliceNewOutput(
              response.output,
              baselineOutputLength,
              historicalOutputIds,
            );

            console.log(
              `[SendMessage] Initial response: total output=${response.output.length}, ` +
                `baseline=${baselineOutputLength}, new=${newOutput.length}, status=${response.status}`,
            );

            try {
              const assistantMsgs = projectTaskOutputMessages({
                output: response.output,
                baselineOutputLength,
                historicalOutputIds,
                responseStartedAt,
                modelName: agentProfile,
                knowledgeBase: false,
              });
              if (assistantMsgs.length > 0) {
                updateAssistantMessages(convId, assistantMsgs);
              }
            } catch (parseErr) {
              console.error(
                "[SendMessage] Error parsing initial output:",
                parseErr,
              );
            }
          } else if (isMultiTurn && effectiveStatus === "completed") {
            updateStatus(convId, "completed", {
              lastKnownOutputLength: baselineOutputLength,
            });
          }

          // A running ordinary task is now handed off through persisted
          // conversation state. useResumePolling is the only continuing poll
          // owner across send, focus, refresh, and hydration.

          if (effectiveStatus === "completed") {
            const completedAt = Date.now();
            const elapsedSec = (completedAt - responseStartedAt) / 1000;

            const totalOutputLength = response.output?.length || 0;

            updateStatus(convId, "completed", {
              completedAt,
              startedAt: responseStartedAt,
              lastKnownOutputLength: totalOutputLength,
            });

            if (response.output && response.output.length > 0) {
              try {
                const finalMsgs = projectTaskOutputMessages({
                  output: response.output,
                  baselineOutputLength,
                  historicalOutputIds,
                  responseStartedAt,
                  modelName: agentProfile,
                  knowledgeBase: false,
                });
                if (finalMsgs.length > 0) {
                  finalMsgs[finalMsgs.length - 1].elapsedTime = elapsedSec;
                  updateAssistantMessages(convId, finalMsgs);
                }
              } catch (parseErr) {
                console.error(
                  "[SendMessage] Error parsing completed output:",
                  parseErr,
                );
              }
            }

            toast.success("任务已完成", {
              description: "结果已同步到当前内容流程。",
              duration: 3200,
            });

            // Emit credit refresh event on immediate completion
            creditEventBus.emit();
          }

          if (effectiveStatus === "error") {
            const completedAt = Date.now();
            const error = generalChatTaskError(response);
            const partialResult = error?.partialResult === true;
            const errorMsg = error?.message || "任务执行出错";
            const failureAdvice = getFailureAdvice(errorMsg);
            const displayError = getFailureDisplayMessage(errorMsg);

            updateStatus(convId, "error", {
              completedAt,
              startedAt: responseStartedAt,
              lastKnownOutputLength: totalInitialOutputLength,
              ...(response.clearTaskPointer
                ? { clearTaskPointer: true }
                : { taskId: response.id, previousResponseId: response.id }),
            });
            const terminalNoticeAdded = addGeneralChatTerminalMessage({
              conversationId: convId,
              taskId: response.id,
              errorCode: generalChatTaskErrorCode(response),
              content: partialResult
                ? GENERAL_CHAT_PARTIAL_RESULT_MESSAGE
                : `❌ 错误: ${displayError}\n\n${failureAdvice}`,
              timestamp: completedAt,
            });
            if (terminalNoticeAdded && partialResult) {
              toast.warning("任务未完整结束", {
                description: "部分结果已保留。",
              });
            } else if (terminalNoticeAdded) {
              toast.error("任务执行失败", {
                description: failureAdvice,
              });
            }
            creditEventBus.emit();
          }
        } catch (err: any) {
          const responseLogicFailure = options?.responseLogicContext
            ? readResponseLogicTaskStartFailure(err)
            : null;
          if (options?.responseLogicContext && responseLogicFailure) {
            const continuationTaskId =
              isMultiTurn && conv?.previousResponseId
                ? conv.previousResponseId
                : undefined;
            // A failed initial start has no task to poll. A failed continuation
            // may retain its completed historical task solely so a proven-safe
            // retry can call /turn again; reset-required failures discard it.
            updateStatus(convId, "error", {
              ...(!continuationTaskId || responseLogicFailure.resetRequired
                ? { clearTaskPointer: true }
                : {}),
              executionKind: "response_logic",
              startedAt: responseStartedAt,
              completedAt: Date.now(),
            });
            try {
              options.responseLogicContext.onTaskStartFailed?.({
                ...responseLogicFailure,
                questionId: options.responseLogicContext.questionId,
                conversationId: convId,
                ...(continuationTaskId ? { continuationTaskId } : {}),
              });
            } catch (callbackError) {
              console.warn(
                "[ResponseLogic] start failure handoff deferred",
                callbackError,
              );
            }
            const presentation =
              responseLogicStartFailureMessage(responseLogicFailure);
            toast.error(presentation.title, {
              description: presentation.description,
            });
            addMessage(convId, {
              id: responseLogicFailure.resetRequired
                ? `${RESPONSE_LOGIC_RESET_REQUIRED_MESSAGE_ID_PREFIX}${Date.now()}`
                : `msg-response-logic-start-error-${Date.now()}`,
              role: "assistant",
              content: presentation.assistantMessage,
              timestamp: Date.now(),
            });
            return false;
          }
          if (options?.syncKnowledgeBaseSnapshot) {
            const status = Number(err?.status || 0);
            const isLogoSubmission = options.submissionKind === "logo";
            const statuslessDispatchFailure =
              status === 0 &&
              (err instanceof TypeError ||
                err?.name === "TypeError" ||
                err?.name === "AbortError");
            const requestOutcomeUnknown =
              statuslessDispatchFailure ||
              status === 408 ||
              status === 429 ||
              status >= 500;
            const acknowledgedObservation =
              requestOutcomeUnknown &&
              err?.knowledgeObservation &&
              knowledgeBaseObservationAcknowledgesClientRequest(
                err.knowledgeObservation,
                knowledgeBaseClientRequestId,
                {
                  allowActiveTurn: false,
                },
              )
                ? err.knowledgeObservation
                : null;
            if (acknowledgedObservation) {
              // The durable observation outranks the transport status. A proxy
              // can fail after the reservation commits; never restore that
              // accepted answer as a draft against the next presentation.
              commitKnowledgeBaseObservation(convId, acknowledgedObservation);
              wakeKnowledgeBaseConversation(convId);
              if (knowledgeBaseAttachmentReservation) {
                replaceKnowledgeBaseAttachmentAttempt(null);
              }
              toast.success("本轮已提交", {
                description: isLogoSubmission
                  ? "FrontMind 已接收 Logo，正在重新呈现当前知识节点。"
                  : "FrontMind 正在生成并校验当前知识节点。",
                duration: 3200,
              });
              return true;
            }
            const pendingAcknowledgedObservation =
              requestOutcomeUnknown &&
              err?.knowledgeObservation &&
              knowledgeBaseObservationAcknowledgesClientRequest(
                err.knowledgeObservation,
                knowledgeBaseClientRequestId,
                { allowActiveTurn: true },
              )
                ? err.knowledgeObservation
                : null;
            if (pendingAcknowledgedObservation) {
              const activeTurnStillAwaitsFiles =
                pendingAcknowledgedObservation.activeTurn
                  ?.awaitingClientAttachments ??
                pendingAcknowledgedObservation.activeTurn
                  ?.requiresAttachmentReselection ??
                false;
              commitKnowledgeBaseObservation(
                convId,
                pendingAcknowledgedObservation,
              );
              wakeKnowledgeBaseConversation(convId);
              if (
                knowledgeBaseAttachmentReservation &&
                activeTurnStillAwaitsFiles
              ) {
                updateKnowledgeBaseAttachmentAttempt((current) => ({
                  ...current,
                  phase: "reconciling_dispatch",
                  lastError: "本轮提交结果暂时无法确认",
                }));
                toast.info("正在核对本轮是否已受理", {
                  description:
                    "服务端仍在等待本轮附件派发；当前资料已保留，不会创建第二个任务。",
                });
                return false;
              }
              if (knowledgeBaseAttachmentReservation) {
                replaceKnowledgeBaseAttachmentAttempt(null);
              }
              toast.info("本轮已提交", {
                description: isLogoSubmission
                  ? "FrontMind 已接收 Logo，正在重新呈现当前知识节点。"
                  : "正在处理当前节点，请稍候。",
              });
              return true;
            }
            const deterministicFailure = !requestOutcomeUnknown;
            if (deterministicFailure && knowledgeBaseClientRequestId) {
              rollbackPendingKnowledgeBaseTurn(
                convId,
                knowledgeBaseClientRequestId,
              );
            }
            if (err?.knowledgeObservation) {
              commitKnowledgeBaseObservation(convId, err.knowledgeObservation);
            }
            if (deterministicFailure && !err?.knowledgeObservation) {
              updateStatus(convId, conv?.status ?? "awaiting_input");
            }
            if (requestOutcomeUnknown) {
              if (knowledgeBaseAttachmentReservation) {
                updateKnowledgeBaseAttachmentAttempt((current) => ({
                  ...current,
                  phase: "reconciling_dispatch",
                  lastError: sanitizeBrandText(
                    err?.message || "本轮提交结果暂时无法确认",
                  ),
                }));
              }
              updateStatus(convId, "running", {
                startedAt: responseStartedAt,
              });
              wakeKnowledgeBaseConversation(convId);
            }
            if (deterministicFailure) {
              if (knowledgeBaseAttachmentReservation) {
                updateKnowledgeBaseAttachmentAttempt((current) => ({
                  ...current,
                  phase: "failed_retryable",
                  lastError: sanitizeBrandText(err?.message || "本轮未能提交"),
                }));
              }
              toast.error("本轮未能提交", {
                description: sanitizeBrandText(
                  err?.message || "请检查当前内容后重新提交。",
                ),
              });
            } else {
              if (!isLogoSubmission) {
                if (knowledgeBaseAttachmentReservation) {
                  toast.info("正在核对本轮是否已受理", {
                    description:
                      "网络响应中断，当前资料仍保留；系统只会核对同一请求，不会创建第二个任务。",
                  });
                  return false;
                }
                // Text-only confirmations preserve their established
                // optimistic bubble while the coordinator reconciles the
                // same request id. There is no browser File to retain.
                toast.info("本轮已提交", {
                  description: "正在处理当前节点，请稍候。",
                });
                return true;
              }
              // A disconnected browser response is outcome-unknown: the POST
              // may never have reached Dashboard. Keep reconciliation active,
              // but do not claim acceptance or clear the selected Logo until
              // a matching durable observation proves the reservation exists.
              toast.info("正在确认提交结果", {
                description:
                  "网络响应中断，已保留所选 Logo；系统正在按同一请求继续核对。",
              });
              return false;
            }
            return false;
          }
          if (
            !isKnowledgeBaseSubmission &&
            !options?.responseLogicContext &&
            err?.dispatchSettled === true
          ) {
            settleGeneralChatDispatch(convId, userMessage.id);
            pendingGeneralChatDispatchRef.current.delete(convId);
          }
          updateStatus(convId, "error", {
            startedAt: responseStartedAt,
            completedAt: Date.now(),
          });
          const errorMsg = err.message || "请求失败";
          const failureAdvice = getFailureAdvice(errorMsg);
          const displayError = getFailureDisplayMessage(errorMsg);
          const terminalNoticeAdded = addGeneralChatTerminalMessage({
            conversationId: convId,
            taskId:
              generalChatDispatch?.localTaskId ??
              conv?.taskId ??
              `request:${userMessage.id}`,
            errorCode: generalChatDispatchErrorCode(err),
            content: `❌ 错误: ${displayError}\n\n${failureAdvice}`,
            timestamp: Date.now(),
          });
          if (terminalNoticeAdded) {
            toast.error("发送失败", { description: failureAdvice });
          }
          return false;
        }
        return true;
      } finally {
        setUploadProgress(null);
        sendInFlightRef.current = false;
      }
    },
    [
      addMessage,
      settleGeneralChatDispatch,
      updateStatus,
      updateAssistantMessages,
      updateTitle,
      createConversation,
      addGeneralChatTerminalMessage,
      registerKnowledgeBaseConversation,
      wakeKnowledgeBaseConversation,
      commitKnowledgeBaseObservation,
      rollbackPendingKnowledgeBaseTurn,
      flushConversation,
      replaceKnowledgeBaseAttachmentAttempt,
      updateKnowledgeBaseAttachmentAttempt,
    ],
  );

  const continueKnowledgeBaseAttachmentAttempt = useCallback(async () => {
    const attempt = knowledgeBaseAttachmentAttemptRef.current;
    if (!attempt || attempt.phase !== "failed_retryable") return false;
    const envelope = attempt.originalMessageEnvelope as
      | FrozenKnowledgeBaseAttemptEnvelope
      | undefined;
    if (!envelope?.options?.syncKnowledgeBaseSnapshot) return false;
    updateKnowledgeBaseAttachmentAttempt((current) => ({
      ...current,
      phase: "reserving",
      lastError: undefined,
    }));
    resumeKnowledgeBaseAttachmentAttemptRef.current = attempt;
    return sendMessage(
      envelope.text,
      [...attempt.files]
        .sort((left, right) => left.ordinal - right.ordinal)
        .map(({ file }) => file),
      envelope.options,
    );
  }, [sendMessage, updateKnowledgeBaseAttachmentAttempt]);

  // Retry last message
  const retryLastMessage = useCallback(async () => {
    const conv = activeConvRef.current;
    if (!conv || conv.messages.length === 0) return;

    setIsRetrying(true);
    setRetryCount((c) => c + 1);

    const pendingUserMsg = [...conv.messages]
      .reverse()
      .find(
        (message) =>
          message.role === "user" && Boolean(message.generalChatDispatch),
      );
    const lastUserMsg =
      pendingUserMsg ??
      [...conv.messages].reverse().find((message) => message.role === "user");
    if (!lastUserMsg) {
      setIsRetrying(false);
      return;
    }

    const files =
      (lastUserMsg.attachments?.map((a) => a.file).filter(Boolean) as File[]) ||
      [];

    toast.info("正在重试上次请求...");

    try {
      await sendMessage(lastUserMsg.content, pendingUserMsg ? [] : files, {
        ...(lastUserMsg.modelName
          ? { agentProfile: lastUserMsg.modelName }
          : {}),
        ...(pendingUserMsg?.generalChatDispatch
          ? {
              generalChatRetry: {
                message: pendingUserMsg,
                dispatch: pendingUserMsg.generalChatDispatch,
              },
            }
          : {}),
      });
    } finally {
      setIsRetrying(false);
    }
  }, [sendMessage]);

  return {
    sendMessage,
    stopPolling,
    isRetrying,
    retryCount,
    retryLastMessage,
    uploadProgress,
    knowledgeBaseAttachmentAttempt,
    continueKnowledgeBaseAttachmentAttempt,
    discardKnowledgeBaseAttachmentAttempt,
  };
}
