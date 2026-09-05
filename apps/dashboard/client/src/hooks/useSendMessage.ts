/**
 * Enhanced useSendMessage Hook with retry mechanism and streaming support
 * Features: Safe retry for uploads/polling, streaming responses,
 *           upload progress tracking, race-condition-free sequential polling,
 *           identity-aware output reconciliation for multi-turn conversations,
 *           per-message model override (agentProfile parameter),
 *           credit event bus emission on task completion for real-time refresh.
 */
import { useCallback, useRef, useState } from "react";
import {
  createTask,
  createResponseLogicTask,
  createKnowledgeBaseTurnTask,
  retrieveTask,
  uploadFile,
  fileToBase64,
  creditEventBus,
  sanitizeBrandText,
  type ContentItem,
  type KnowledgeBaseAttachmentManifestItem,
  type Message,
  type ResponseLogicTaskContext,
  type TaskResponse,
} from "@/lib/frontmind-api";
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
  sha256UploadFile,
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

export {
  collectAssistantOutputIds,
  outputForKnowledgePresentation,
  sliceNewOutput,
} from "@/lib/task-output-projection";

const MAX_RETRIES = 3;
const INITIAL_RETRY_DELAY = 1000; // 1 second
const MAX_RETRY_DELAY = 10000; // 10 seconds

export function getTaskPollDelay(elapsedMs: number) {
  if (elapsedMs < 5 * 60 * 1000) return 3_000;
  if (elapsedMs < 30 * 60 * 1000) return 10_000;
  return 30_000;
}

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

export function useSendMessage() {
  const {
    state,
    activeConversation,
    addMessage,
    updateStatus,
    updateAssistantMessages,
    updateTitle,
    createConversation,
    registerKnowledgeBaseConversation,
    wakeKnowledgeBaseConversation,
    commitKnowledgeBaseObservation,
    rollbackPendingKnowledgeBaseTurn,
  } = useConversation();

  // Use a ref to track whether polling should continue.
  const pollingActiveRef = useRef(false);
  const pollingTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const sendInFlightRef = useRef(false);
  const activeConvRef = useRef(activeConversation);
  activeConvRef.current = activeConversation;

  // Store context functions in refs so polling closures always use the latest versions
  const updateStatusRef = useRef(updateStatus);
  updateStatusRef.current = updateStatus;
  const updateAssistantMessagesRef = useRef(updateAssistantMessages);
  updateAssistantMessagesRef.current = updateAssistantMessages;
  const addMessageRef = useRef(addMessage);
  addMessageRef.current = addMessage;

  const [isRetrying, setIsRetrying] = useState(false);
  const [retryCount, setRetryCount] = useState(0);
  const [uploadProgress, setUploadProgress] = useState<UploadProgress | null>(
    null,
  );

  const stopPolling = useCallback(() => {
    pollingActiveRef.current = false;
    if (pollingTimeoutRef.current) {
      clearTimeout(pollingTimeoutRef.current);
      pollingTimeoutRef.current = null;
    }
  }, []);

  /**
   * Sequential polling: waits for each request to finish before scheduling the next.
   */
  const startPolling = useCallback(
    (
      taskId: string,
      convId: string,
      responseStartedAt: number,
      retryConfig: RetryConfig,
      baselineOutputLength: number,
      historicalOutputIds: readonly string[],
      modelName?: string,
    ) => {
      // Stop any existing polling first
      stopPolling();
      pollingActiveRef.current = true;

      let pollCount = 0;
      let lastNewOutputLen = 0;
      let completionHandled = false;
      let consecutiveErrors = 0;
      const MAX_CONSECUTIVE_ERRORS = 10;

      const pollOnce = async () => {
        if (!pollingActiveRef.current || completionHandled) return;

        try {
          pollCount++;

          const updated = await withRetry(() => retrieveTask(taskId), {
            ...retryConfig,
            maxRetries: 2,
          });

          if (!pollingActiveRef.current || completionHandled) return;

          // Ordinary-chat polling is intentionally isolated from the KB
          // coordinator and may continue rendering raw task output.
          // Slice only NEW output items
          if (updated.output && updated.output.length > 0) {
            const newOutput = sliceNewOutput(
              updated.output,
              baselineOutputLength,
              historicalOutputIds,
            );

            if (newOutput.length > 0) {
              try {
                const assistantMsgs = projectTaskOutputMessages({
                  output: updated.output,
                  baselineOutputLength,
                  historicalOutputIds,
                  responseStartedAt,
                  modelName,
                  knowledgeBase: false,
                });
                if (assistantMsgs.length > 0) {
                  updateAssistantMessagesRef.current(convId, assistantMsgs);
                }
              } catch (parseErr) {
                console.error(
                  "[Polling] Error parsing output messages:",
                  parseErr,
                );
              }
              if (newOutput.length !== lastNewOutputLen) {
                console.log(
                  `[Polling] New output items: ${newOutput.length}, ` +
                    `total output: ${updated.output.length}, baseline: ${baselineOutputLength}`,
                );
                lastNewOutputLen = newOutput.length;
              }
            }
          }

          // Normalize status
          const normalizedStatus =
            updated.status === "failed" ? "error" : updated.status;

          updateStatusRef.current(convId, normalizedStatus as any, {
            taskId: updated.id,
            taskUrl: updated.metadata?.task_url,
          });

          if (normalizedStatus === "completed" && !completionHandled) {
            completionHandled = true;
            stopPolling();
            const completedAt = Date.now();
            const elapsedSec = (completedAt - responseStartedAt) / 1000;

            const totalOutputLength = updated.output?.length || 0;

            updateStatusRef.current(convId, "completed", {
              completedAt,
              lastKnownOutputLength: totalOutputLength,
            });

            // Final parse of output — this is the authoritative final set.
            // The regular polling section above already parsed the same output,
            // but we do it once more here to ensure we have the complete set
            // and to attach elapsedTime to the last message.
            if (updated.output && updated.output.length > 0) {
              const newOutput = sliceNewOutput(
                updated.output,
                baselineOutputLength,
                historicalOutputIds,
              );

              if (newOutput.length > 0) {
                try {
                  const finalMsgs = projectTaskOutputMessages({
                    output: updated.output,
                    baselineOutputLength,
                    historicalOutputIds,
                    responseStartedAt,
                    modelName,
                    knowledgeBase: false,
                  });
                  if (finalMsgs.length > 0) {
                    finalMsgs[finalMsgs.length - 1].elapsedTime = elapsedSec;
                    updateAssistantMessagesRef.current(convId, finalMsgs);
                  }
                } catch (parseErr) {
                  console.error(
                    "[Polling] Error parsing final output messages:",
                    parseErr,
                  );
                }
              }
            }

            toast.success("任务已完成", {
              description: `本次处理耗时 ${elapsedSec.toFixed(1)}s，结果已同步到当前内容流程。`,
              duration: 3200,
            });

            // Emit credit refresh event on task completion
            creditEventBus.emit();
            return;
          }

          if (normalizedStatus === "error" && !completionHandled) {
            completionHandled = true;
            stopPolling();
            const completedAt = Date.now();

            const totalOutputLength = updated.output?.length || 0;

            updateStatusRef.current(convId, "error", {
              completedAt,
              lastKnownOutputLength: totalOutputLength,
            });
            const errorMsg = updated.error?.message || "任务执行出错";
            const failureAdvice = getFailureAdvice(errorMsg);
            const displayError = getFailureDisplayMessage(errorMsg);
            toast.error("任务执行失败", {
              description: failureAdvice,
            });
            addMessageRef.current(convId, {
              id: `msg-err-${Date.now()}`,
              role: "assistant",
              content: `❌ 错误: ${displayError}\n\n${failureAdvice}`,
              timestamp: Date.now(),
            });

            // Emit credit refresh event even on error (credits may have been consumed)
            creditEventBus.emit();
            return;
          }

          consecutiveErrors = 0;
        } catch (err: any) {
          console.error("Polling error:", err);
          consecutiveErrors++;

          if (!pollingActiveRef.current || completionHandled) return;

          if (pollCount > 3 && err.message?.includes("404")) {
            stopPolling();
            updateStatusRef.current(convId, "error", {
              completedAt: Date.now(),
            });
            toast.error("任务不存在或已被删除");
            creditEventBus.emit();
            return;
          }

          if (consecutiveErrors >= MAX_CONSECUTIVE_ERRORS) {
            stopPolling();
            const completedAt = Date.now();
            updateStatusRef.current(convId, "error", { completedAt });
            toast.error("连续多次请求失败，已停止轮询");
            return;
          }
        }

        if (pollingActiveRef.current && !completionHandled) {
          pollingTimeoutRef.current = setTimeout(
            pollOnce,
            getTaskPollDelay(Date.now() - responseStartedAt),
          );
        }
      };

      pollingTimeoutRef.current = setTimeout(
        pollOnce,
        getTaskPollDelay(Date.now() - responseStartedAt),
      );
    },
    [stopPolling],
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
        knowledgeBaseExpectedRevision?: number;
        knowledgeBaseExpectedLeafId?: string;
        responseLogicContext?: ResponseLogicTaskContext;
      },
    ) => {
      if (sendInFlightRef.current) {
        toast.info("上一条消息正在发送，请稍候");
        return false;
      }

      sendInFlightRef.current = true;

      try {
        const isKnowledgeBaseSubmission =
          options?.syncKnowledgeBaseSnapshot === true;
        if (
          !isKnowledgeBaseSubmission &&
          !(await requireCurrentFrontMindBuild(text))
        ) {
          toast.info("检测到新版本，正在刷新后继续");
          return false;
        }
        const retryConfig = options?.retryConfig || defaultRetryConfig;
        const agentProfile = options?.agentProfile;

        // Ensure we have an active conversation
        let convId = activeConvRef.current?.id;
        let conv = activeConvRef.current;

        if (!convId) {
          convId = createConversation();
          conv = null;
        }

        const resumableKnowledgeBaseClientRequestId =
          options?.syncKnowledgeBaseSnapshot &&
          conv?.knowledgeBase?.notice?.code ===
            "KNOWLEDGE_BASE_ATTACHMENTS_REQUIRED"
            ? conv.knowledgeBase.activeClientRequestId
            : null;
        const resumingLegacyKnowledgeBaseAttachmentTurn = Boolean(
          resumableKnowledgeBaseClientRequestId,
        );
        const resumedKnowledgeBaseMessage =
          resumingLegacyKnowledgeBaseAttachmentTurn
            ? conv?.messages.find(
                (message) =>
                  message.role === "user" &&
                  message.knowledgeBase?.clientRequestId ===
                    resumableKnowledgeBaseClientRequestId,
              )
            : undefined;
        const knowledgeBaseSubmissionText =
          resumedKnowledgeBaseMessage?.content || text;
        const knowledgeBaseClientRequestId = options?.syncKnowledgeBaseSnapshot
          ? resumableKnowledgeBaseClientRequestId ||
            (typeof crypto !== "undefined" && "randomUUID" in crypto
              ? crypto.randomUUID()
              : `kb-turn-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`)
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
        const contentItems: ContentItem[] = [];
        const attachments: Attachment[] = [];

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
        if (knowledgeBaseSubmissionText.trim()) {
          contentItems.push({
            type: "input_text",
            text: knowledgeBaseSubmissionText.trim(),
          });
        }

        let preparedUploads: PreparedUploadFiles;
        try {
          preparedUploads = options?.syncKnowledgeBaseSnapshot
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

        if (preparedUploads.didZipLargeImages) {
          contentItems.push({ type: "input_text", text: ZIP_REFERENCE_PROMPT });
          toast.info("超高像素图片已无损打包为 ZIP", {
            description:
              "原图像素和文件内容不会被压缩或重编码，将作为文件附件发送。",
            duration: 5000,
          });
        }

        let knowledgeBaseAttachmentManifest:
          | KnowledgeBaseAttachmentManifestItem[]
          | undefined;
        if (
          options?.syncKnowledgeBaseSnapshot &&
          preparedUploads.files.length > 0
        ) {
          try {
            // Hash the browser bytes once. Knowledge-base uploads are captured
            // by the Dashboard during the same proxy upload, so the server can
            // compare this manifest without a timed remote read-back window.
            knowledgeBaseAttachmentManifest = await Promise.all(
              preparedUploads.files.map(async ({ file }) => ({
                filename: normalizedKnowledgeBaseUploadFilename(file.name),
                sizeBytes: file.size,
                mimeType: normalizedKnowledgeBaseUploadMimeType(file),
                lastModified: Math.max(0, Number(file.lastModified || 0)),
                sha256: await sha256UploadFile(file),
              })),
            );
          } catch (error) {
            toast.error("附件读取失败", {
              description:
                error instanceof Error
                  ? error.message
                  : "请重新选择文件后重试。",
            });
            return false;
          }
        }

        // Process files with progress tracking. All attachments are sent as files,
        // including images, to avoid the direct oversized image visual path.
        const totalFiles = preparedUploads.files.length;
        if (totalFiles > 0) {
          setUploadProgress({
            currentFileIndex: 0,
            totalFiles,
            currentFileName: preparedUploads.files[0].file.name,
            currentFilePercent: 0,
            overallPercent: 0,
            conversationId: convId,
          });
        }

        for (let i = 0; i < preparedUploads.files.length; i++) {
          const prepared = preparedUploads.files[i];
          const file = prepared.file;
          const knowledgeBaseFilename = options?.syncKnowledgeBaseSnapshot
            ? normalizedKnowledgeBaseUploadFilename(file.name)
            : undefined;

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

          if (isLargeFile) {
            fileBlobUrl = URL.createObjectURL(file);
          } else if (!isImageFile) {
            fileBase64 = await fileToBase64(file);
          }

          try {
            console.log("[SendMessage] Uploading file attachment", {
              filename: file.name,
              size: file.size,
              generatedFromImages: prepared.generatedFromImages?.map(
                (image) => image.name,
              ),
            });

            const result = await uploadFile(
              file,
              (percent) => {
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
              },
              retryConfig,
              {
                // Every chat upload is retained through the authenticated
                // Dashboard proxy so it remains reopenable for its retention
                // window, regardless of which agent entry created it.
                captureLocalCopy: true,
                ...(options?.syncKnowledgeBaseSnapshot
                  ? {
                      captureFilename: knowledgeBaseFilename!,
                    }
                  : {}),
              },
            );

            console.log("[SendMessage] Uploaded file attachment", {
              filename: result.filename,
              fileId: result.fileId,
            });

            contentItems.push({
              type: "input_file",
              file_id: result.fileId,
              filename: knowledgeBaseFilename || result.filename,
              mime_type: file.type || "application/octet-stream",
            });
            attachments.push({
              id: `att-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
              type: "file",
              name: file.name,
              fileId: result.fileId,
              base64: fileBase64,
              blobUrl: fileBlobUrl,
              file,
              expiresAt: result.expiresAt,
              expired: false,
            });
          } catch (uploadErr: any) {
            // The attachment never reached ConversationContext, so its normal
            // lifecycle cleanup cannot see this optimistic URL.
            if (fileBlobUrl) URL.revokeObjectURL(fileBlobUrl);
            for (const uploadedAttachment of attachments) {
              if (uploadedAttachment.blobUrl) {
                URL.revokeObjectURL(uploadedAttachment.blobUrl);
              }
            }
            console.warn(
              `File upload failed for "${file.name}":`,
              uploadErr.message,
            );
            // A terminal upload failure must release the composer immediately.
            // uploadFile already performs its bounded retries; keeping progress
            // here would leave the UI permanently disabled after those retries.
            setUploadProgress(null);
            if (uploadErr?.knowledgeObservation) {
              commitKnowledgeBaseObservation(
                convId,
                uploadErr.knowledgeObservation,
              );
              wakeKnowledgeBaseConversation(convId);
            }
            toast.error(`文件 "${file.name}" 上传失败`, {
              description: uploadErr?.message || "请稍后重试。",
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

        if (contentItems.length === 0) {
          return false;
        }

        // Add user message to conversation
        const userMessage: LocalMessage = {
          id: `msg-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
          role: "user",
          content: knowledgeBaseSubmissionText.trim(),
          attachments: attachments.length > 0 ? attachments : undefined,
          timestamp: Date.now(),
          ...(knowledgeBaseClientRequestId
            ? {
                knowledgeBase: {
                  kind: "pending_user" as const,
                  clientRequestId: knowledgeBaseClientRequestId,
                },
              }
            : {}),
        };

        if (!resumingLegacyKnowledgeBaseAttachmentTurn) {
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
            agentProfile?: string;
          } = {};

          if (conv?.previousResponseId) {
            taskOptions.previousResponseId = conv.previousResponseId;
          }

          // Pass per-message model override
          if (agentProfile) {
            taskOptions.agentProfile = agentProfile;
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
            // Lock the normal processing UI before waiting for the HTTP
            // response. The POST is replay-safe by clientRequestId, so start
            // the authoritative coordinator alongside it instead of showing
            // request latency as an unknown/recovery failure.
            updateStatus(convId, "running", {
              startedAt: responseStartedAt,
            });
            const responsePromise = createKnowledgeBaseTurnTask(input, {
              conversationId: convId,
              clientRequestId: knowledgeBaseClientRequestId!,
              expectedGeneration: options?.knowledgeBaseExpectedGeneration,
              expectedRevision: options?.knowledgeBaseExpectedRevision,
              expectedLeafId: options?.knowledgeBaseExpectedLeafId,
              ...(knowledgeBaseAttachmentManifest
                ? {
                    attachmentManifest: knowledgeBaseAttachmentManifest,
                    ...(resumingLegacyKnowledgeBaseAttachmentTurn
                      ? {
                          legacyAttachmentTakeover: {
                            attachmentManifest: knowledgeBaseAttachmentManifest,
                          },
                        }
                      : {}),
                  }
                : {}),
            });
            wakeKnowledgeBaseConversation(convId);
            response = await responsePromise;

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

          setRetryCount(0);
          setIsRetrying(false);

          if (isKnowledgeBaseSubmission) {
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
            toast.success("本轮已提交", {
              description: "FrontMind 正在生成并校验当前知识节点。",
              duration: 3200,
            });
            return true;
          }

          const effectiveStatus = response.status;
          const totalInitialOutputLength = response.output?.length || 0;
          const initialStatusIsTerminal =
            effectiveStatus === "completed" || effectiveStatus === "error";

          updateStatus(convId, effectiveStatus as any, {
            taskId: response.id,
            taskUrl: response.metadata?.task_url,
            previousResponseId: response.id,
            startedAt: responseStartedAt,
            ...(initialStatusIsTerminal
              ? { lastKnownOutputLength: totalInitialOutputLength }
              : {}),
          });

          toast.success("任务已创建", {
            description:
              "FrontMind 已开始处理，结果会自动出现在当前内容流程中。",
            duration: 3200,
          });

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

          // Ordinary chat keeps its local sequential poller. Knowledge-base
          // sends returned above and are owned exclusively by the provider coordinator.
          if (effectiveStatus === "running" || effectiveStatus === "pending") {
            startPolling(
              response.id,
              convId,
              responseStartedAt,
              retryConfig,
              baselineOutputLength,
              historicalOutputIds,
              agentProfile,
            );
          }

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
        } catch (err: any) {
          if (options?.syncKnowledgeBaseSnapshot) {
            const status = Number(err?.status || 0);
            const code = String(err?.code || "");
            const requestOutcomeUnknown =
              !status ||
              status === 408 ||
              status === 425 ||
              status === 429 ||
              status >= 500 ||
              code === "IDEMPOTENCY_PENDING";
            const deterministicFailure =
              !requestOutcomeUnknown && status !== 409;
            if (
              (status === 409 || deterministicFailure) &&
              knowledgeBaseClientRequestId
            ) {
              rollbackPendingKnowledgeBaseTurn(
                convId,
                knowledgeBaseClientRequestId,
              );
            }
            if (err?.knowledgeObservation) {
              commitKnowledgeBaseObservation(convId, err.knowledgeObservation);
            }
            if (
              (status === 409 || deterministicFailure) &&
              !err?.knowledgeObservation
            ) {
              updateStatus(convId, conv?.status ?? "awaiting_input");
            }
            if (requestOutcomeUnknown) {
              updateStatus(convId, "running", {
                startedAt: responseStartedAt,
              });
            }
            if (!deterministicFailure || err?.knowledgeObservation) {
              wakeKnowledgeBaseConversation(convId);
            }
            if (status === 409) {
              toast.info("当前节点已更新", {
                description: "已同步服务端最新节点，请按当前内容继续。",
              });
            } else if (deterministicFailure) {
              toast.error("本轮未能提交", {
                description: err?.message || "请检查当前内容后重新提交。",
              });
            } else {
              // A disconnected browser response does not mean the accepted
              // durable turn failed. Keep the user on the normal processing
              // path while the coordinator observes the same request id. The
              // composer must clear this already-submitted text/attachment set
              // so it cannot be repeated against the next leaf.
              toast.info("本轮已提交", {
                description: "正在处理当前节点，请稍候。",
              });
              return true;
            }
            return false;
          }
          updateStatus(convId, "error", {
            startedAt: responseStartedAt,
            completedAt: Date.now(),
          });
          const errorMsg = err.message || "请求失败";
          const failureAdvice = getFailureAdvice(errorMsg);
          const displayError = getFailureDisplayMessage(errorMsg);
          toast.error("发送失败", { description: failureAdvice });
          addMessage(convId, {
            id: `msg-err-${Date.now()}`,
            role: "assistant",
            content: `❌ 错误: ${displayError}\n\n${failureAdvice}`,
            timestamp: Date.now(),
          });
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
      updateStatus,
      updateAssistantMessages,
      updateTitle,
      createConversation,
      stopPolling,
      startPolling,
      registerKnowledgeBaseConversation,
      wakeKnowledgeBaseConversation,
      commitKnowledgeBaseObservation,
      rollbackPendingKnowledgeBaseTurn,
    ],
  );

  // Retry last message
  const retryLastMessage = useCallback(async () => {
    const conv = activeConvRef.current;
    if (!conv || conv.messages.length === 0) return;

    setIsRetrying(true);
    setRetryCount((c) => c + 1);

    const lastUserMsg = [...conv.messages]
      .reverse()
      .find((m) => m.role === "user");
    if (!lastUserMsg) return;

    const files =
      (lastUserMsg.attachments?.map((a) => a.file).filter(Boolean) as File[]) ||
      [];

    toast.info("正在重试上次请求...");

    try {
      await sendMessage(lastUserMsg.content, files);
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
  };
}
