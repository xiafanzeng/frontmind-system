import { OPERATOR_MODULES } from "@/dashboard/operator-navigation";
import KnowledgeBaseManagedUploadRecovery from "./KnowledgeBaseManagedUploadRecovery";
import { finalReplyIds } from "@/lib/final-reply";
import {
  useKnowledgeBaseUploadBatch,
  useKnowledgeBaseUploadField,
} from "@/lib/knowledge-base-upload-manager";
import {
  conversationInlineSlots,
  type ConversationInlineBlock,
} from "@/lib/conversation-inline-blocks";
import { GeneralAgentWelcome } from "./GeneralAgentWelcome";
import { useChatReadingPosition } from "@/hooks/useChatReadingPosition";
export {
  scrollChatViewportToBottom,
  isChatViewportNearBottom,
} from "@/hooks/useChatReadingPosition";
import {
  projectContentProductionMarkdown,
  contentProductionArtifactName,
  contentProductionArtifactUrl,
} from "@shared/content-production-public";
import { GeneralExecutionActivity } from "./GeneralExecutionActivity";
import { ExecutionDivider } from "./ExecutionDuration";
import { conversationExecutionTimings } from "@/lib/execution-duration";
import { generalExecutionSlots } from "@/lib/general-execution-display";
import { projectFrontMindIdentityMessages } from "@shared/frontmind-general-identity";
import type { ContentProductionInput } from "@shared/content-production";
/**
 * ChatArea Component - Main chat interface
 * Design: Glassmorphism cards, fluid animations, spacious layout.
 * Features: Message display, file/image attachments, status indicators,
 *           local PDF.js reader, inline Markdown reader, HTML file preview.
 */
import React, {
  useRef,
  useEffect,
  useState,
  useCallback,
  useMemo,
} from "react";
import {
  useConversation,
  type Attachment,
  type KnowledgeBaseClientNotice,
  type KnowledgeBaseClientState,
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
import { captureWorkspaceRestOperation } from "@/lib/workspace-rest-scope";
import {
  creditEventBus,
  cancelKnowledgeBaseStartReservation,
  deliveryProjectHeaders,
  discardManagedUploadIntent,
  discardUnboundUpload,
  getModelDisplayName,
  reserveKnowledgeBaseStart,
  sanitizeBrandText,
  stageKnowledgeBaseTurnAttachment,
  uploadKnowledgeBaseLocalAsset,
  type FileUploadRecordEvent,
  type KnowledgeBaseAttachmentManifestItem,
  type ManagedUploadHandle,
  type OutputMessage,
  type ResponseLogicTaskContext,
  type UploadRecoveryAction,
  type UploadFileOptions,
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
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Progress } from "@/components/ui/progress";
import { Textarea } from "@/components/ui/textarea";
import type { KnowledgeBaseInteractionDto } from "@shared/knowledge-base-progress";
import { trpc } from "@/lib/trpc";
import {
  KNOWLEDGE_BASE_LOGO_PROVENANCE_REQUIRED_NOTICE_CODE,
  requestKnowledgeBaseReset,
  executeKnowledgeBaseRecovery,
  knowledgeBaseObservationFromPayload,
  reconcileKnowledgeBaseObservation,
  recoverKnowledgeBaseCanonicalFromSnapshot,
  retryKnowledgeBaseTurn,
  type KnowledgeBaseObservationDto,
} from "@/lib/knowledge-progress";
import KnowledgeBaseLogoProvenanceRepair from "./KnowledgeBaseLogoProvenanceRepair";
import KnowledgeBaseAttachmentRepair from "./KnowledgeBaseAttachmentRepair";
import {
  assertChatAttachmentSizes,
  chatAttachmentSizeError,
  normalizedKnowledgeBaseUploadFilename,
  normalizedKnowledgeBaseUploadMimeType,
} from "@/lib/attachment-files";
import { isAttachmentExpired } from "@/lib/attachment-expiry";
import { useWorkspaceDraftGuard } from "@/lib/workspace-navigation-guard";
import { WorkflowQuestion } from "@/dashboard/workflow/Workflow";

export const KNOWLEDGE_BASE_FOUNDATION_COPY =
  "企业知识库是品牌事实与产品信息的统一底稿，也是构建 AI 专用友好官网、生成内容与准确回答客户问题的基础。";

export function runningAssistantStatusText(
  syncKnowledgeBaseSnapshot: boolean,
  processingPhase?: string | null,
  runPhase?: string | null,
) {
  if (syncKnowledgeBaseSnapshot && processingPhase === "uploading") {
    return "正在上传资料，完成后自动开始调研与整理";
  }
  return syncKnowledgeBaseSnapshot
    ? runPhase === "researching"
      ? KNOWLEDGE_COLLECTION_STATUS_COPY
      : runPhase === "normalizing"
        ? "正在整理、校验并生成知识库"
        : "正在读取当前知识库状态"
    : "FrontMind AI 正在处理...";
}

export function isKnowledgeBaseTaskVisiblyRunning(input: {
  status: string | undefined;
  syncKnowledgeBaseSnapshot: boolean;
  interactionState?: string | null;
  noticeSeverity?: string | null;
  processingPhase?: string | null;
  runPhase?: string | null;
}) {
  const taskIsRunning =
    input.status === "running" || input.status === "pending";
  if (!taskIsRunning) return false;
  if (!input.syncKnowledgeBaseSnapshot) return true;
  if (
    !input.runPhase ||
    !["researching", "normalizing"].includes(input.runPhase)
  )
    return false;
  return (
    input.interactionState !== "failed" && input.noticeSeverity !== "error"
  );
}

export const KNOWLEDGE_BASE_PACKAGE_REBIND_NOTICE_CODE =
  "PACKAGE_REBIND_REQUIRED";
export const KNOWLEDGE_BASE_INTERNAL_ATTACHMENT_NOTICE_CODE =
  "KNOWLEDGE_BASE_ATTACHMENTS_REQUIRED";
export const KNOWLEDGE_BASE_REBUILD_REQUIRED_NOTICE_CODE = "UPSTREAM_CREATE_3";
export const KNOWLEDGE_BASE_NEW_BUILD_EVENT =
  "frontmind:new-knowledge-base-build";
const KNOWLEDGE_BASE_TRACE_ID_PATTERN =
  /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/iu;
const KNOWLEDGE_BASE_PRECREATE_ATTACHMENT_REPAIR_CODES = new Set([
  "KNOWLEDGE_BASE_CLIENT_ATTACHMENT_INVALID",
  "KNOWLEDGE_BASE_USER_ATTACHMENT_INVALID",
]);

function safeKnowledgeBaseTraceId(value: unknown) {
  const normalized = String(value || "").trim();
  return KNOWLEDGE_BASE_TRACE_ID_PATTERN.test(normalized)
    ? normalized
    : undefined;
}

export function knowledgeBaseExplicitRecoveryRequest(
  current: { recoveryToken: string; clientRequestId: string } | null,
  recoveryToken: string,
  createClientRequestId: () => string,
) {
  return current?.recoveryToken === recoveryToken
    ? current
    : { recoveryToken, clientRequestId: createClientRequestId() };
}

export function shouldRenderKnowledgeBaseNotice(
  _notice: Pick<KnowledgeBaseClientNotice, "code">,
) {
  return true;
}

export function knowledgeBaseTaskWasNotCreated(
  knowledgeBase:
    | Pick<KnowledgeBaseClientState, "taskCreationState" | "failureStage">
    | null
    | undefined,
) {
  return Boolean(
    knowledgeBase?.taskCreationState === "not_attempted" &&
      (knowledgeBase.failureStage === "local_upload" ||
        knowledgeBase.failureStage === "provider_file_registration"),
  );
}

export function knowledgeBaseNoticeRecoveryMode(
  notice: Pick<
    KnowledgeBaseClientNotice,
    "code" | "recoveryAction" | "recoveryToken" | "canRegenerate"
  >,
) {
  if (notice.code === KNOWLEDGE_BASE_LOGO_PROVENANCE_REQUIRED_NOTICE_CODE)
    return "logo_repair" as const;
  if (
    notice.code === KNOWLEDGE_BASE_PACKAGE_REBIND_NOTICE_CODE ||
      notice.code === KNOWLEDGE_BASE_INTERNAL_ATTACHMENT_NOTICE_CODE ||
      notice.code === KNOWLEDGE_BASE_REBUILD_REQUIRED_NOTICE_CODE ||
    [
      "approve_reset",
      "resume_start_from_retained_sources",
      "reselect_start_sources",
      "retry_request",
      "start_new_generation",
      "create_new_canonical_from_snapshot",
      "regenerate_turn",
    ].includes(notice.recoveryAction ?? "")
  ) {
    return "reset" as const;
  }
  if (
    ["reconcile", "update_credential", "top_up"].includes(
      notice.recoveryAction ?? "",
    )
  )
    return "reconcile" as const;
  return "none" as const;
}

export function knowledgeBaseNoticeRetryLabel(
  notice: Pick<
    KnowledgeBaseClientNotice,
    "code" | "recoveryAction" | "recoveryToken" | "canRegenerate"
  >,
) {
  const mode = knowledgeBaseNoticeRecoveryMode(notice);
  return mode === "reset"
    ? "重置知识库"
    : mode === "logo_repair"
      ? "重新上传 Logo 原图"
      : mode === "reconcile"
        ? notice.recoveryAction === "top_up"
          ? "补充额度后继续"
          : "检查当前任务状态"
        : "";
}

export function knowledgeBaseNoticeHasRecoveryAction(
  notice: Pick<
    KnowledgeBaseClientNotice,
    "code" | "recoveryAction" | "recoveryToken" | "canRegenerate"
  >,
) {
  return knowledgeBaseNoticeRecoveryMode(notice) !== "none";
}

export function knowledgeBaseReconcileResultRequiresConfirmation(
  observation: Pick<KnowledgeBaseObservationDto, "notice">,
) {
  return Boolean(
    observation.notice &&
      knowledgeBaseNoticeRecoveryMode({
        ...observation.notice,
        recoveryToken: observation.notice.recoveryToken ?? undefined,
      }) === "reset",
  );
}

export function knowledgeBaseReconcileResultIsStopped(
  observation: Pick<KnowledgeBaseObservationDto, "notice" | "operationState">,
) {
  return Boolean(
    observation.operationState === undefined &&
      observation.notice &&
      (observation.notice.code === "FRONTMIND_KB_STOPPED" ||
        observation.notice.recoveryAction === "stopped"),
  );
}

export function knowledgeBaseReconcileResultChangedCoordinate(
  observation: Pick<KnowledgeBaseObservationDto, "generation" | "stateEpoch">,
  expected: { generation: number; stateEpoch: number },
) {
  return (
    observation.generation !== expected.generation ||
    observation.stateEpoch !== expected.stateEpoch
  );
}

export function knowledgeBaseNoticeRequiresLogoProvenanceRepair(
  notice: Pick<KnowledgeBaseClientNotice, "code">,
) {
  return notice.code === KNOWLEDGE_BASE_LOGO_PROVENANCE_REQUIRED_NOTICE_CODE;
}

export function knowledgeBaseNoticeRequiresAttachmentRepair(
  notice: Pick<KnowledgeBaseClientNotice, "code" | "recoveryAction">,
) {
  return (
    notice.recoveryAction === "fix_attachments" &&
    KNOWLEDGE_BASE_PRECREATE_ATTACHMENT_REPAIR_CODES.has(notice.code || "")
  );
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

export function knowledgeBaseSameTurnRecoveryAccepted(
  observation: KnowledgeBaseObservationDto,
) {
  return observation.accepted === true && observation.resumed === true;
}

/** Legacy reconstruction is deliberately unavailable; only current status can be reread. */
export async function recoverKnowledgeBaseNotice(
  input: {
    conversationId: string;
    notice: Pick<
      KnowledgeBaseClientNotice,
      "code" | "recoveryAction" | "recoveryToken" | "canRegenerate"
    >;
    clientRequestId: string;
    expectedGeneration: number;
    expectedStateEpoch: number;
    expectedRevision: number;
    expectedLeafId: string | null;
    expectedPresentationKey?: string | null;
  },
  dependencies: {
    reconcile?: typeof reconcileKnowledgeBaseObservation;
    retry?: typeof retryKnowledgeBaseTurn;
    execute?: typeof executeKnowledgeBaseRecovery;
  } = {},
): Promise<KnowledgeBaseObservationDto> {
  const mode = knowledgeBaseNoticeRecoveryMode(input.notice);
  if (mode === "reconcile")
    return (dependencies.reconcile ?? reconcileKnowledgeBaseObservation)({
      conversationId: input.conversationId,
    });
  if (mode === "logo_repair")
    throw new Error("请通过专用入口重新上传当前知识库使用的同一张 Logo 原图");
  throw new Error("旧知识库任务已停止支持，请批准重置后重新上传完整资料。");
}

const EMPTY_STATE_IMG = "/assets/frontmind-mark.svg";

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
  reservationCreated?: boolean;
  traceId?: string;
  attachmentCount?: number;
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

type KnowledgeBaseStarterUploadStage =
  | "queued"
  | "creating_intent"
  | "uploading_to_dashboard"
  | "sealed"
  | "creating_cloud_record"
  | "uploading_to_cloud"
  | "waiting_cloud_ready"
  | "creating_record"
  | "recovering"
  | "uploading"
  | "server_processing"
  | "uploaded"
  | "failed"
  | "cancelled";

type KnowledgeBaseStarterBatchPhase =
  | "ready"
  | "uploading"
  | "starting"
  | "recovering"
  | "completed"
  | "failed";

type KnowledgeBaseStarterUploadReceipt = {
  fileId: string;
  filename: string;
  sizeBytes?: number;
  contentSha256?: string;
  uploadedAt?: number;
  dashboardReadyAt?: number;
  providerReadyAt?: number;
  expiresAt?: number;
  traceId?: string;
};

type KnowledgeBaseStarterFileUpdate = {
  stage: KnowledgeBaseStarterUploadStage;
  itemId?: string;
  intentId?: string;
  fileId?: string;
  loadedBytes?: number;
  dashboardReceivedBytes?: number;
  totalBytes?: number;
  receipt?: KnowledgeBaseStarterUploadReceipt;
  uploadHandle?: ManagedUploadHandle;
  clearFileRecord?: boolean;
  error?: string;
  errorCode?: string;
  retryable?: boolean;
  recoveryAction?: UploadRecoveryAction;
  recreateRequired?: boolean;
  traceId?: string;
  attempt?: number;
};

export type KnowledgeBaseStarterStartOutcome =
  | { status: "accepted" }
  | { status: "recovering" };

export type KnowledgeBaseStarterLifecycle = {
  signal: AbortSignal;
  clientRequestId: string;
  /** Reset epoch frozen when this starter batch begins. */
  expectedResetRevision: number;
  startedAt: number;
  uploadedReceipts: ReadonlyMap<string, KnowledgeBaseStarterUploadReceipt>;
  fileRecordIds: ReadonlyMap<string, string>;
  uploadHandles: ReadonlyMap<string, ManagedUploadHandle>;
  fileAttempts: ReadonlyMap<string, number>;
  transferredBytes: ReadonlyMap<string, number>;
  dashboardReceivedBytes?: ReadonlyMap<string, number>;
  /** Stable row identities aligned with the `files` payload array. */
  fileItemIds?: readonly string[];
  /** Durable start coordinate created before the first browser upload. */
  reservation?: {
    uploadAttemptId?: string;
    conversationId: string;
    turnId: string;
    clientRequestId: string;
    expectedResetRevision: number;
  };
  attachmentManifest?: import("@/lib/frontmind-api").KnowledgeBaseAttachmentManifestItem[];
  startPrepared: boolean;
  onStartPrepared: (prepared: boolean) => void;
  onReservation?: (
    reservation: NonNullable<KnowledgeBaseStarterLifecycle["reservation"]>,
  ) => void;
  onBatchPhase: (phase: KnowledgeBaseStarterBatchPhase) => void;
  onFileUpdate: (
    itemId: string,
    file: File,
    update: KnowledgeBaseStarterFileUpdate,
  ) => void;
};

function uploadErrorMessage(error: unknown) {
  const message = error instanceof Error ? error.message : "";
  if (
    /Dashboard|provider|reservation|upstream|canonical|堆栈|上游/iu.test(
      message,
    )
  ) {
    return "资料暂时无法完成上传，请检查并继续；已保存的文件会保留。";
  }
  return message ? sanitizeBrandText(message) : "文件上传失败，请稍后重试";
}

function uploadWasCancelled(error: unknown, signal: AbortSignal) {
  return (
    signal.aborted ||
    (error as { cancelled?: unknown } | null)?.cancelled === true ||
    (error as { name?: unknown } | null)?.name === "AbortError"
  );
}

function uploadFileRecordId(event: FileUploadRecordEvent) {
  return event.fileId;
}

export async function buildKnowledgeBaseStarterAttachmentManifest(
  files: readonly File[],
  itemIds: readonly string[],
  signal: AbortSignal,
): Promise<KnowledgeBaseAttachmentManifestItem[]> {
  if (files.length !== itemIds.length) {
    throw new Error("知识库附件坐标不完整，请重新选择资料");
  }
  const manifest: KnowledgeBaseAttachmentManifestItem[] = [];
  // Reserve from immutable browser metadata only. Dashboard computes the
  // authoritative digest while streaming each upload into managed storage.
  for (const [index, file] of files.entries()) {
    if (signal.aborted) {
      throw new DOMException("上传已停止", "AbortError");
    }
    manifest.push({
      itemId: itemIds[index],
      ordinal: index + 1,
      total: files.length,
      filename: normalizedKnowledgeBaseUploadFilename(file.name),
      sizeBytes: file.size,
      mimeType: normalizedKnowledgeBaseUploadMimeType(file),
      lastModified: Math.max(0, Number(file.lastModified || 0)),
    });
  }
  return manifest;
}

type KnowledgeBaseStarterUploadImplementation = (
  file: File,
  onProgress?: (percent: number) => void,
  retryConfig?: {
    maxRetries: number;
    initialDelay: number;
    maxDelay: number;
  },
  options?: UploadFileOptions,
) => Promise<{
  fileId: string;
  filename: string;
  sizeBytes?: number;
  contentSha256?: string;
  uploadedAt?: number;
  dashboardReadyAt?: number;
  providerReadyAt?: number;
  expiresAt?: number;
  replayed?: boolean;
  recovered?: boolean;
  traceId?: string;
}>;

export async function uploadKnowledgeBaseStarterFiles(
  files: File[],
  incomingLifecycle: KnowledgeBaseStarterLifecycle,
  responseStartedAt: number,
  uploadImplementation: KnowledgeBaseStarterUploadImplementation = uploadKnowledgeBaseLocalAsset,
) {
  const operation = captureWorkspaceRestOperation(
    incomingLifecycle.signal,
    undefined,
    { detached: true },
  );
  const lifecycle = { ...incomingLifecycle, signal: operation.signal };
  operation.assertActive();
  const receipts = new Map(lifecycle.uploadedReceipts);
  const uploadedAttachments: Array<{
    file_id: string;
    filename: string;
  }> = [];
  const messageAttachments: Attachment[] = [];

  for (const [fileIndex, file] of files.entries()) {
    if (lifecycle.signal.aborted) {
      throw new DOMException("上传已停止", "AbortError");
    }
    const itemId =
      lifecycle.fileItemIds?.[fileIndex] ||
      `${lifecycle.clientRequestId}:${fileIndex + 1}`;
    let receipt = receipts.get(itemId);
    if (!receipt) {
      if (lifecycle.signal.aborted) {
        throw new DOMException("上传已停止", "AbortError");
      }

      const existingFileId = lifecycle.fileRecordIds.get(itemId);
      const existingUploadHandle = lifecycle.uploadHandles.get(itemId);
      const recoveryFileId = existingUploadHandle?.fileId || existingFileId;
      let currentFileId = recoveryFileId;
      let currentUploadHandle = existingUploadHandle;
      const attempt = (lifecycle.fileAttempts.get(itemId) ?? 0) + 1;
      let transferredBytes = 0;
      let transferCompleted = false;
      lifecycle.onFileUpdate(itemId, file, {
        stage:
          existingUploadHandle || recoveryFileId
            ? "recovering"
            : "creating_intent",
        ...(existingUploadHandle?.itemId
          ? { itemId: existingUploadHandle.itemId }
          : {}),
        ...(existingUploadHandle?.intentId
          ? { intentId: existingUploadHandle.intentId }
          : {}),
        ...(recoveryFileId ? { fileId: recoveryFileId } : {}),
        ...(existingUploadHandle ? { uploadHandle: existingUploadHandle } : {}),
        loadedBytes: transferredBytes,
        totalBytes: file.size,
        attempt,
      });

      try {
        const uploadOptions: UploadFileOptions = {
          captureLocalCopy: true,
          captureFilename: normalizedKnowledgeBaseUploadFilename(file.name),
          batchId: lifecycle.clientRequestId,
          batchOrdinal: fileIndex + 1,
          batchTotal: files.length,
          itemId,
          ...(lifecycle.attachmentManifest?.[fileIndex]?.sha256
            ? {
                contentSha256: lifecycle.attachmentManifest[fileIndex]!.sha256,
              }
            : {}),
          ...(lifecycle.reservation
            ? {
                resumeScope: {
                  kind: "knowledge_base" as const,
                  conversationId: lifecycle.reservation.conversationId,
                  turnId: lifecycle.reservation.turnId,
                  clientRequestId: lifecycle.reservation.clientRequestId,
                  expectedResetRevision:
                    lifecycle.reservation.expectedResetRevision,
                  uploadAttemptId: lifecycle.reservation.uploadAttemptId,
                },
              }
            : {}),
          signal: lifecycle.signal,
          ...(existingUploadHandle
            ? { existingUploadHandle }
            : existingFileId
              ? { existingFileId }
              : {}),
          onFileRecord: (event) => {
            if (lifecycle.signal.aborted) return;
            const fileId = uploadFileRecordId(event);
            if (fileId) currentFileId = fileId;
            if (event.uploadHandle) currentUploadHandle = event.uploadHandle;
            lifecycle.onFileUpdate(itemId, file, {
              stage: event.intentId ? "creating_intent" : "creating_record",
              ...(event.itemId ? { itemId: event.itemId } : {}),
              ...(event.intentId ? { intentId: event.intentId } : {}),
              ...(fileId ? { fileId } : {}),
              ...(event.uploadHandle
                ? { uploadHandle: event.uploadHandle }
                : {}),
              loadedBytes: transferredBytes,
              totalBytes: file.size,
              attempt,
            });
          },
          onFileRecordDiscarded: () => {
            if (lifecycle.signal.aborted) return;
            currentFileId = undefined;
            lifecycle.onFileUpdate(itemId, file, {
              stage: "creating_record",
              clearFileRecord: true,
              loadedBytes: transferredBytes,
              totalBytes: file.size,
              attempt,
            });
          },
          onStage: (event) => {
            if (lifecycle.signal.aborted || transferCompleted) return;
            if (typeof event.loadedBytes === "number") {
              transferredBytes = Math.min(
                file.size,
                Math.max(0, event.loadedBytes),
              );
            }
            const traceId = safeKnowledgeBaseTraceId(event.traceId);
            lifecycle.onFileUpdate(itemId, file, {
              stage: event.stage,
              ...(event.itemId ? { itemId: event.itemId } : {}),
              ...(event.intentId ? { intentId: event.intentId } : {}),
              ...(event.fileId ? { fileId: event.fileId } : {}),
              loadedBytes: transferredBytes,
              ...(typeof event.dashboardReceivedBytes === "number"
                ? {
                    dashboardReceivedBytes: Math.min(
                      file.size,
                      Math.max(0, event.dashboardReceivedBytes),
                    ),
                  }
                : {}),
              totalBytes:
                typeof event.totalBytes === "number"
                  ? event.totalBytes
                  : file.size,
              ...(traceId ? { traceId } : {}),
              attempt: attempt + (event.attempt ?? 1) - 1,
            });
          },
        };
        let uploaded: Awaited<
          ReturnType<KnowledgeBaseStarterUploadImplementation>
        >;
        try {
          uploaded = await uploadImplementation(
            file,
            undefined,
            undefined,
            uploadOptions,
          );
        } catch (firstError) {
          const code = String(
            (firstError as { code?: unknown } | null)?.code || "",
          );
          const frozen = lifecycle.attachmentManifest?.[fileIndex];
          const retryHandle = currentUploadHandle;
          const sameFile = Boolean(
            frozen &&
              frozen.filename ===
                normalizedKnowledgeBaseUploadFilename(file.name) &&
              frozen.sizeBytes === file.size &&
              frozen.mimeType === normalizedKnowledgeBaseUploadMimeType(file) &&
              frozen.lastModified ===
                Math.max(0, Number(file.lastModified || 0)),
          );
          const canRetrySameIntent = Boolean(
            [
              "UPLOAD_BROWSER_BODY_INCOMPLETE",
              "UPLOAD_BROWSER_BODY_REQUIRED",
            ].includes(code) &&
              sameFile &&
              retryHandle?.intentId &&
              retryHandle.ticket &&
              retryHandle.expiresAt > Date.now() &&
              lifecycle.reservation &&
              lifecycle.expectedResetRevision ===
                lifecycle.reservation.expectedResetRevision &&
              !lifecycle.signal.aborted,
          );
          if (!canRetrySameIntent) throw firstError;
          lifecycle.onFileUpdate(itemId, file, {
            stage: "recovering",
            itemId: retryHandle!.itemId,
            intentId: retryHandle!.intentId,
            uploadHandle: retryHandle,
            loadedBytes: transferredBytes,
            totalBytes: file.size,
            attempt,
          });
          uploaded = await uploadImplementation(file, undefined, undefined, {
            ...uploadOptions,
            existingFileId: undefined,
            existingUploadHandle: retryHandle,
          });
        }
        if (lifecycle.signal.aborted) {
          throw new DOMException("上传已停止", "AbortError");
        }
        transferCompleted = true;
        receipt = {
          fileId: uploaded.fileId,
          filename: uploaded.filename,
          sizeBytes: uploaded.sizeBytes,
          contentSha256: uploaded.contentSha256,
          uploadedAt: uploaded.uploadedAt,
          dashboardReadyAt: uploaded.dashboardReadyAt,
          providerReadyAt: uploaded.providerReadyAt,
          expiresAt: uploaded.expiresAt,
          traceId: safeKnowledgeBaseTraceId(uploaded.traceId),
        };
        receipts.set(itemId, receipt);
        if (!lifecycle.signal.aborted) {
          lifecycle.onFileUpdate(itemId, file, {
            stage: "server_processing",
            fileId: receipt.fileId,
            loadedBytes: file.size,
            dashboardReceivedBytes: file.size,
            totalBytes: file.size,
            receipt,
            traceId: receipt.traceId,
            attempt,
          });
        }
      } catch (error) {
        const rawStructuredFileId = (error as { fileId?: unknown } | null)
          ?.fileId;
        const structuredFileId = currentUploadHandle?.intentId
          ? undefined
          : typeof rawStructuredFileId === "string" &&
              rawStructuredFileId.trim()
            ? rawStructuredFileId
            : undefined;
        const structuredRetryable = (error as { retryable?: unknown } | null)
          ?.retryable;
        const structuredRecoveryAction = (
          error as { recoveryAction?: UploadRecoveryAction } | null
        )?.recoveryAction;
        const structuredRecreateRequired =
          (error as { recreateRequired?: unknown } | null)?.recreateRequired ===
          true;
        const recoveryAction =
          structuredRecreateRequired &&
          structuredRecoveryAction !== "discard_and_recreate"
            ? "check_status"
            : structuredRecoveryAction;
        if (!lifecycle.signal.aborted) {
          lifecycle.onFileUpdate(itemId, file, {
            stage: uploadWasCancelled(error, lifecycle.signal)
              ? "cancelled"
              : "failed",
            ...(structuredFileId !== undefined
              ? { fileId: structuredFileId }
              : currentFileId
                ? { fileId: currentFileId }
                : {}),
            loadedBytes: transferredBytes,
            totalBytes: file.size,
            error: uploadErrorMessage(error),
            errorCode:
              String((error as { code?: unknown } | null)?.code || "").trim() ||
              undefined,
            retryable:
              typeof structuredRetryable === "boolean"
                ? structuredRetryable
                : undefined,
            recoveryAction,
            recreateRequired:
              structuredRecreateRequired &&
              structuredRecoveryAction === "discard_and_recreate",
            traceId: safeKnowledgeBaseTraceId(
              (error as { traceId?: unknown } | null)?.traceId,
            ),
            attempt,
          });
        }
        throw error;
      }
    }

    if (lifecycle.reservation && lifecycle.attachmentManifest) {
      if (lifecycle.signal.aborted) {
        throw new DOMException("上传已停止", "AbortError");
      }
      await stageKnowledgeBaseTurnAttachment({
        ...lifecycle.reservation,
        attachmentManifest: lifecycle.attachmentManifest,
        index: fileIndex,
        signal: lifecycle.signal,
        attachment: {
          file_id: receipt.fileId,
          filename: receipt.filename,
        },
      });
      if (lifecycle.signal.aborted) {
        throw new DOMException("上传已停止", "AbortError");
      }
    }

    lifecycle.onFileUpdate(itemId, file, {
      stage: "uploaded",
      fileId: receipt.fileId,
      loadedBytes: file.size,
      dashboardReceivedBytes: file.size,
      totalBytes: file.size,
      receipt,
    });

    uploadedAttachments.push({
      file_id: receipt.fileId,
      filename: receipt.filename,
    });
    messageAttachments.push({
      id: `att-${responseStartedAt}-${messageAttachments.length + 1}`,
      type: "file",
      name: file.name,
      fileId: receipt.fileId,
      file,
      expiresAt: receipt.expiresAt,
      expired: false,
    });
  }

  return { uploadedAttachments, messageAttachments };
}

export function projectKnowledgeBaseStarterRequest(input: {
  lifecycle: KnowledgeBaseStarterLifecycle;
  conversationId: string;
  responseStartedAt: number;
  messageAttachments: Attachment[];
  registerConversation: (conversationId: string) => void;
  addConversationMessage: (
    conversationId: string,
    message: LocalMessage,
  ) => void;
  updateConversationTitle: (conversationId: string, title: string) => void;
}) {
  if (input.lifecycle.startPrepared) return false;

  input.registerConversation(input.conversationId);
  input.addConversationMessage(input.conversationId, {
    id: `msg-kb-start-${input.responseStartedAt}`,
    role: "user",
    content: "开始构建企业知识库",
    ...(input.messageAttachments.length > 0
      ? { attachments: input.messageAttachments }
      : {}),
    timestamp: input.responseStartedAt,
    knowledgeBase: {
      kind: "pending_user",
      clientRequestId: input.lifecycle.clientRequestId,
    },
  });
  input.updateConversationTitle(input.conversationId, "企业知识库构建");
  input.lifecycle.onStartPrepared(true);
  return true;
}

type KnowledgeBaseStartRequestError = Error & {
  status?: number;
  code?: string;
  traceId?: string;
  attachmentCount?: number;
  reservationCreated?: boolean;
  observation?: KnowledgeBaseObservationDto;
};

export const KNOWLEDGE_BASE_START_TIMEOUT_MS = 120_000;

function knowledgeBaseStartTimeoutError(): KnowledgeBaseStartRequestError {
  const error = new Error(
    "启动请求等待超时，系统将继续确认服务端是否已受理",
  ) as KnowledgeBaseStartRequestError;
  error.status = 408;
  error.code = "KNOWLEDGE_BASE_START_TIMEOUT";
  return error;
}

export async function fetchKnowledgeBaseStartRequest(
  init: RequestInit,
  options: {
    signal: AbortSignal;
    timeoutMs?: number;
    fetchImplementation?: typeof fetch;
    endpoint?: string;
    onRequestStarted?: () => void;
  },
) {
  const operation = captureWorkspaceRestOperation(options.signal, undefined, {
    detached: true,
  });
  const signal = operation.signal;
  if (signal.aborted) {
    throw new DOMException("上传已停止", "AbortError");
  }

  const controller = new AbortController();
  const abortFromLifecycle = () => controller.abort();
  signal.addEventListener("abort", abortFromLifecycle, { once: true });
  if (signal.aborted) controller.abort();
  if (controller.signal.aborted) {
    signal.removeEventListener("abort", abortFromLifecycle);
    throw new DOMException("上传已停止", "AbortError");
  }
  const timeoutMs = options.timeoutMs ?? KNOWLEDGE_BASE_START_TIMEOUT_MS;
  let timedOut = false;
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<Response>((_resolve, reject) => {
    timeoutId = setTimeout(() => {
      timedOut = true;
      controller.abort();
      reject(knowledgeBaseStartTimeoutError());
    }, timeoutMs);
  });

  try {
    if (controller.signal.aborted) {
      throw new DOMException("上传已停止", "AbortError");
    }
    options.onRequestStarted?.();
    const response = await Promise.race([
      (options.fetchImplementation ?? fetch)(
        options.endpoint ?? "/api/knowledge-base/start/reserve",
        {
          ...init,
          headers: operation.headers(
            Object.fromEntries(new Headers(init.headers).entries()),
          ),
          signal: controller.signal,
        },
      ),
      timeout,
    ]);
    operation.assertActive();
    return response;
  } catch (error) {
    if (timedOut) throw knowledgeBaseStartTimeoutError();
    throw error;
  } finally {
    if (timeoutId !== undefined) clearTimeout(timeoutId);
    signal.removeEventListener("abort", abortFromLifecycle);
  }
}

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
    const code = String(errorNode?.code || data?.code || "").trim();
    const traceId = String(errorNode?.traceId || data?.traceId || "").trim();
    error.code = /^[A-Z0-9_:-]{1,128}$/u.test(code) ? code : undefined;
    error.traceId = safeKnowledgeBaseTraceId(traceId);
    const attachmentCount = Number(
      errorNode?.attachmentCount ?? data?.attachmentCount,
    );
    if (
      Number.isSafeInteger(attachmentCount) &&
      attachmentCount >= 0 &&
      attachmentCount <= 1_000
    ) {
      error.attachmentCount = attachmentCount;
    }
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
  dispatchAttempted: boolean,
  error: Pick<
    KnowledgeBaseStartRequestError,
    "status" | "code" | "reservationCreated"
  >,
) {
  if (!dispatchAttempted) return false;
  // A reset epoch mismatch is a definitive rejection of these browser bytes.
  // It must never enter the network-unknown recovery branch or project an old
  // pending start into the freshly reset conversation.
  if (error.code === "KNOWLEDGE_BASE_RESET_REVISION_CHANGED") return false;
  if (error.reservationCreated === false) return false;
  if (error.code === "KNOWLEDGE_BASE_ROLLOUT_PENDING") return false;
  const status = Number(error.status || 0);
  // A reserve receipt embedded in an explicit 4xx does not acknowledge the
  // final dispatch. Only a sent request with a transport/timeout/transient
  // response can have an unknown dispatch outcome.
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
 * Dashboard-owned artifact URLs are served locally; explicit external URLs
 * are routed through the authenticated proxy-download boundary.
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
  purpose,
  contentProduction,
  composerPrefill,
  responseLogicContext,
  messageProjection,
  inlineBlocks,
  conversationFooter,
  showKnowledgeBaseStarter = true,
  standardWelcomeVariant = "simple",
  reserveOuterMobileNav = false,
  knowledgeBaseProgress,
  knowledgeBaseResetRevision,
  operatorWorkspace = false,
  knowledgeEditingBlocked = false,
  onComposerDirtyChange,
  knowledgeBaseAccountId,
  onKnowledgeBaseBatchCancelled,
}: {
  fixedAgentProfile?: string;
  syncKnowledgeBaseSnapshot?: boolean;
  purpose?: "enterprise_qa" | "content_production";
  contentProduction?: ContentProductionInput;
  composerPrefill?: string;
  responseLogicContext?: ResponseLogicTaskContext;
  messageProjection?: (message: LocalMessage) => LocalMessage;
  inlineBlocks?: ConversationInlineBlock[];
  conversationFooter?: React.ReactNode;
  showKnowledgeBaseStarter?: boolean;
  standardWelcomeVariant?: "simple" | "workflow" | "enterprise_qa";
  reserveOuterMobileNav?: boolean;
  knowledgeBaseProgress?: KnowledgeBaseProgressDto | null;
  knowledgeBaseResetRevision?: number;
  operatorWorkspace?: boolean;
  knowledgeEditingBlocked?: boolean;
  onComposerDirtyChange?: (dirty: boolean) => void;
  knowledgeBaseAccountId?: number;
  onKnowledgeBaseBatchCancelled?: (
    conversationId: string,
    resetRevision: number,
  ) => void | Promise<void>;
}) {
  const {
    activeConversation,
    workbenchScopeKey,
    createConversation,
    setActive,
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
    refreshConversationsAfterDiscard,
  } = useConversation();
  const dashboardQuery = trpc.workspace.dashboard.useQuery(undefined, {
    enabled: !responseLogicContext && showKnowledgeBaseStarter,
    retry: false,
    refetchOnWindowFocus: true,
    staleTime: 30_000,
  });
  const messagesViewportRef = useRef<HTMLDivElement>(null);
  const explicitRecoveryRequestRef = useRef<{
    recoveryToken: string;
    clientRequestId: string;
  } | null>(null);

  const [retryingKnowledgeBase, setRetryingKnowledgeBase] = useState(false);
  const [expandedExecutionGroups, setExpandedExecutionGroups] = useState<
    Set<string>
  >(() => new Set());
  const toggleExecutionGroup = useCallback(
    (id: string) =>
      setExpandedExecutionGroups((previous) => {
        const next = new Set(previous);
        if (next.has(id)) next.delete(id);
        else next.add(id);
        return next;
      }),
    [],
  );

  const startFreshKnowledgeBaseBuild = useCallback(() => {
    const conversationId = createConversation({
      title: "企业知识库构建",
      reuseEmpty: false,
    });
    setActive(conversationId);
    window.dispatchEvent(
      new CustomEvent(KNOWLEDGE_BASE_NEW_BUILD_EVENT, {
        detail: { conversationId },
      }),
    );
    toast.info("已新建知识库构建", {
      description: "上一轮及其附件保持只读；请为新一轮重新选择资料。",
    });
  }, [createConversation, setActive]);

  const discardCancelledKnowledgeBaseStart = useCallback(
    async (conversationId: string, resetRevision: number) => {
      if (onKnowledgeBaseBatchCancelled) {
        await onKnowledgeBaseBatchCancelled(conversationId, resetRevision);
        return;
      }
      discardConversationLocally(conversationId);
      const nextConversationId = createConversation({
        title: "企业知识库构建",
        reuseEmpty: false,
      });
      setActive(nextConversationId);
      window.dispatchEvent(
        new CustomEvent(KNOWLEDGE_BASE_NEW_BUILD_EVENT, {
          detail: { conversationId: nextConversationId },
        }),
      );
      void refreshConversationsAfterDiscard();
    },
    [
      createConversation,
      discardConversationLocally,
      onKnowledgeBaseBatchCancelled,
      refreshConversationsAfterDiscard,
      setActive,
    ],
  );

  const starterScopeKey = `${workbenchScopeKey ?? "workspace"}:${knowledgeBaseAccountId ?? 0}:${activeConversation?.id ?? "new"}`;
  const starterBatch = useKnowledgeBaseUploadBatch(
    `${starterScopeKey}:${knowledgeBaseResetRevision ?? 0}`,
    `${starterScopeKey}:`,
  );
  const [localBatchStartedAt] = useKnowledgeBaseUploadField<number | null>(
    starterBatch,
    "batchStartedAt",
    null,
  );
  const freshUploadNeedsFiles =
    syncKnowledgeBaseSnapshot &&
    !localBatchStartedAt &&
    activeConversation?.knowledgeBase?.activeTurnOperationType === "start" &&
    activeConversation.knowledgeBase.activeTurnAwaitingClientAttachments;
  const status = activeConversation?.status;
  const startedAt = activeConversation?.startedAt;
  const completedAt = activeConversation?.completedAt;
  const hasKnowledgeBaseProgress = Boolean(knowledgeBaseProgress);
  const displayActiveTask = isKnowledgeBaseTaskVisiblyRunning({
    status,
    syncKnowledgeBaseSnapshot,
    interactionState: activeConversation?.knowledgeBase?.interactionState,
    noticeSeverity: activeConversation?.knowledgeBase?.notice?.severity,
    processingPhase: activeConversation?.knowledgeBase?.processingPhase,
    runPhase: activeConversation?.knowledgeBase?.runPhase,
  });
  const knowledgeBaseDisplayFailed =
    syncKnowledgeBaseSnapshot &&
    (activeConversation?.knowledgeBase?.interactionState === "failed" ||
      activeConversation?.knowledgeBase?.notice?.severity === "error");

  useEffect(() => {
    if (!syncKnowledgeBaseSnapshot || !activeConversation?.id) return;
    registerKnowledgeBaseConversation(activeConversation.id);
    if (activeConversation.taskId || hasKnowledgeBaseProgress) {
      wakeKnowledgeBaseConversation(activeConversation.id);
    }
  }, [
    activeConversation?.id,
    activeConversation?.taskId,
    hasKnowledgeBaseProgress,
    registerKnowledgeBaseConversation,
    syncKnowledgeBaseSnapshot,
    wakeKnowledgeBaseConversation,
  ]);

  const messageScrollKey = activeConversation?.messages
    ?.map(
      (message) =>
        `${message.id}:${message.content?.length ?? 0}:${message.stepGroups?.length ?? 0}:${message.outputFiles?.length ?? 0}:${message.inlineImages?.length ?? 0}`,
    )
    .join("|");

  const { showLatest, returnToLatest } = useChatReadingPosition(
    messagesViewportRef,
    `${workbenchScopeKey ?? "workspace"}:${activeConversation?.id ?? "new"}`,
    `${messageScrollKey}:${status}`,
  );

  const startKnowledgeBase = useCallback(
    async (
      {
        companyName,
        companyWebsite,
        operatorNotes,
        files,
      }: DeepReportStartInput,
      incomingLifecycle: KnowledgeBaseStarterLifecycle,
    ): Promise<KnowledgeBaseStarterStartOutcome> => {
      const operation = captureWorkspaceRestOperation(
        incomingLifecycle.signal,
        undefined,
        { detached: true },
      );
      const lifecycle = { ...incomingLifecycle, signal: operation.signal };
      operation.assertActive();
      if (!activeConversation) {
        throw new Error("当前知识库会话不可用，请刷新后重试");
      }

      const conversationId = activeConversation.id;
      const responseStartedAt = lifecycle.startedAt;
      const clientRequestId = lifecycle.clientRequestId;
      const expectedResetRevision = lifecycle.expectedResetRevision;
      let dispatchAttempted = false;
      let preparedMessageAttachments: Attachment[] = [];

      try {
        assertChatAttachmentSizes(files);
        const itemIds = files.map(
          (_file, index) =>
            lifecycle.fileItemIds?.[index] || `${clientRequestId}:${index + 1}`,
        );
        const attachmentManifest =
          await buildKnowledgeBaseStarterAttachmentManifest(
            files,
            itemIds,
            lifecycle.signal,
          );
        const result = await starterBatch.submit({
          kind: "start",
          conversationId,
          clientRequestId,
          expectedResetRevision,
          companyName,
          companyWebsite,
          operatorNotes,
          manifest: attachmentManifest,
          files: files.map((file, index) => ({
            file,
            itemId: itemIds[index]!,
            ordinal: index + 1,
          })),
          onReservation: (reserved) =>
            lifecycle.onReservation?.({
              conversationId,
              turnId: reserved.reservation.turnId,
              clientRequestId,
              expectedResetRevision,
              uploadAttemptId: reserved.reservation.uploadAttemptId,
            }),
          onObservation: (observation) =>
            commitKnowledgeBaseObservation(conversationId, observation),
          onPhase: (phase) => {
            lifecycle.onBatchPhase(
              phase === "dispatching" ? "starting" : "uploading",
            );
            if (phase === "dispatching") dispatchAttempted = true;
          },
          onFile: (itemId, file, event) =>
            lifecycle.onFileUpdate(itemId, file, event),
        });
        const reserved = result;
        const messageAttachments: Attachment[] = files.map((file, index) => ({
          id: `att-${responseStartedAt}-${index + 1}`,
          type: "file",
          name: file.name,
          fileId: result.receipts.get(itemIds[index]!)?.fileId,
          file,
          expiresAt: result.receipts.get(itemIds[index]!)?.expiresAt,
          expired: false,
        }));
        preparedMessageAttachments = messageAttachments;
        const data = { task: result.response, startedAt: responseStartedAt };
        operation.assertActive();
        const observation = result.response.knowledgeObservation;
        // `/start/reserve` already supplied the durable acknowledgement. The
        // dispatch endpoint need not echo the legacy reservationCreated flag
        // or a provider task id; its 2xx only releases the existing turn.
        const acceptedObservation =
          observation ?? reserved.knowledgeObservation;

        projectKnowledgeBaseStarterRequest({
          lifecycle,
          conversationId,
          responseStartedAt,
          messageAttachments,
          registerConversation: registerKnowledgeBaseConversation,
          addConversationMessage: addMessage,
          updateConversationTitle: updateTitle,
        });

        const taskStartedAt = data.startedAt || responseStartedAt;
        if (acceptedObservation) {
          commitKnowledgeBaseObservation(conversationId, acceptedObservation);
        } else {
          // Compatibility while the server fleet rolls forward. Never project
          // data.task.output for KB; the coordinator will obtain the approved
          // DTO. A durable reservation may be acknowledged before a provider
          // task id exists, so the task fields are optional in this window.
          updateStatus(
            conversationId,
            "running",
            data.task?.id
              ? {
                  taskId: data.task.id,
                  previousResponseId: data.task.id,
                  startedAt: taskStartedAt,
                }
              : { startedAt: taskStartedAt },
          );
        }
        wakeKnowledgeBaseConversation(conversationId);

        toast.success("已开始构建企业知识库", {
          description:
            "资料已上传完成，正在启动知识库调研。调研和整理可能需要 30 分钟左右。",
          duration: 3200,
        });

        creditEventBus.emit();
        lifecycle.onBatchPhase("completed");
        return { status: "accepted" };
      } catch (error: any) {
        const errorMessage = uploadErrorMessage(error);
        const resetRevisionChanged =
          error?.code === "KNOWLEDGE_BASE_RESET_REVISION_CHANGED";
        if (uploadWasCancelled(error, lifecycle.signal)) {
          lifecycle.onBatchPhase("failed");
          toast.info("上传已停止", {
            description: "已完成的文件会保留，继续时只上传未完成资料。",
          });
          throw error;
        } else if (errorMessage.includes("不能超过 100 MB")) {
          lifecycle.onBatchPhase("failed");
          toast.error("文件过大", { description: errorMessage });
          throw error;
        } else if (resetRevisionChanged) {
          lifecycle.onBatchPhase("failed");
          toast.info("知识库已完成重置", {
            description:
              "本次旧资料提交已停止，请在新的空白构建中重新选择资料。",
          });
          throw error;
        } else if (
          !shouldRecoverKnowledgeBaseStartFailure(dispatchAttempted, error)
        ) {
          if (dispatchAttempted) {
            settleKnowledgeBaseStartFailure(conversationId, clientRequestId);
          }
          toast.error(dispatchAttempted ? "启动失败" : "上传失败", {
            description: errorMessage,
          });
          lifecycle.onBatchPhase("failed");
          throw error;
        } else {
          projectKnowledgeBaseStarterRequest({
            lifecycle,
            conversationId,
            responseStartedAt,
            messageAttachments: preparedMessageAttachments,
            registerConversation: registerKnowledgeBaseConversation,
            addConversationMessage: addMessage,
            updateConversationTitle: updateTitle,
          });
          updateStatus(conversationId, "running", {
            startedAt: responseStartedAt,
          });
          wakeKnowledgeBaseConversation(conversationId);
          toast.warning("正在恢复启动结果", {
            description:
              "请求结果暂时未知，系统正在核对服务端是否已受理，不会重复创建知识库任务。",
          });
          lifecycle.onBatchPhase("recovering");
          return { status: "recovering" };
        }
      }
    },
    [
      activeConversation,
      addMessage,
      commitKnowledgeBaseObservation,
      registerKnowledgeBaseConversation,
      settleKnowledgeBaseStartFailure,
      updateStatus,
      updateTitle,
      wakeKnowledgeBaseConversation,
    ],
  );

  const retryCurrentKnowledgeBaseTurn = useCallback(async () => {
    const notice = activeConversation?.knowledgeBase?.notice;
    if (!notice || retryingKnowledgeBase) return;
    if (knowledgeBaseNoticeRecoveryMode(notice) !== "reconcile") {
      requestKnowledgeBaseReset();
      return;
    }
    setRetryingKnowledgeBase(true);
    try {
      const observation = await reconcileKnowledgeBaseObservation({
        conversationId: activeConversation!.id,
      });
      commitKnowledgeBaseObservation(activeConversation!.id, observation);
      wakeKnowledgeBaseConversation(activeConversation!.id);
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : "暂时无法读取任务状态",
      );
    } finally {
      setRetryingKnowledgeBase(false);
    }
  }, [activeConversation, retryingKnowledgeBase]);

  const messages = useMemo(() => {
    const storedRows = activeConversation
      ? messageProjection
        ? activeConversation.messages.map(messageProjection)
        : activeConversation.messages
      : [];
    const preDispatch =
      syncKnowledgeBaseSnapshot &&
      ["reserved", "uploading", "staging"].includes(
        activeConversation?.knowledgeBase?.runPhase ?? "",
      );
    const rows = preDispatch
      ? storedRows.filter(
          (message) =>
            message.knowledgeBase?.turnId !==
              activeConversation?.knowledgeBase?.activeTurnId &&
            message.knowledgeBase?.clientRequestId !==
              activeConversation?.knowledgeBase?.activeClientRequestId,
        )
      : storedRows;
    if (purpose === "content_production")
      return rows.map((message) =>
        message.role === "assistant"
          ? {
              ...message,
              content: projectContentProductionMarkdown(message.content),
              ...(message.outputFiles
                ? {
                    outputFiles: message.outputFiles.map((file) => ({
                      ...file,
                      fileName: contentProductionArtifactName(file.fileName),
                      fileUrl: contentProductionArtifactUrl(file.fileUrl),
                    })),
                  }
                : {}),
            }
          : message,
      );
    return activeConversation?.executionKind === "general_chat_v2" && !purpose
      ? projectFrontMindIdentityMessages(rows)
      : rows;
  }, [
    activeConversation,
    messageProjection,
    purpose,
    syncKnowledgeBaseSnapshot,
  ]);
  const inlineSlots = useMemo(
    () => conversationInlineSlots(messages, inlineBlocks),
    [messages, inlineBlocks],
  );
  const renderInlineBlocks = (blocks: ConversationInlineBlock[] | undefined) =>
    blocks?.map((block) => (
      <div
        key={block.id}
        data-reading-anchor={`business-${block.id}`}
        data-business-block={block.id}
      >
        {block.content}
      </div>
  ));
  const displayedExecution =
    activeConversation?.execution ??
    (syncKnowledgeBaseSnapshot ? knowledgeBaseProgress?.execution : undefined);
  const executionSlots = useMemo(
    () =>
      generalExecutionSlots(
        messages,
        displayedExecution,
        activeConversation?.status === "running" ||
          activeConversation?.status === "pending",
      ),
    [messages, activeConversation, displayedExecution],
  );
  const executionTimings = useMemo(
    () =>
      activeConversation
        ? conversationExecutionTimings(
            { ...activeConversation, execution: displayedExecution },
            messages,
          )
        : new Map(),
    [activeConversation, displayedExecution, messages],
  );
  const copyableReplyIds = useMemo(
    () =>
      finalReplyIds(
        messages,
        activeConversation?.execution,
        status === "running" || status === "pending",
      ),
    [messages, activeConversation?.execution, status],
  );
  const finalAssistantMessageId = useMemo(
    () =>
      [...messages].reverse().find((message) => message.role === "assistant")
        ?.id,
    [messages],
  );

  if (!activeConversation) {
    return <EmptyState enterpriseQa={purpose === "enterprise_qa"} />;
  }

  const sanitizedTitle = activeConversation.title
    ? sanitizeBrandText(activeConversation.title)
    : activeConversation.title;
  const activeTask = displayActiveTask;
  const displayStatus = knowledgeBaseDisplayFailed ? "error" : status;
  const executionModel =
    fixedAgentProfile ||
    [...messages]
      .reverse()
      .find((message) => message.role === "assistant" && message.modelName)
      ?.modelName;
  const knowledgeBaseTaskNotCreated = knowledgeBaseTaskWasNotCreated(
    activeConversation.knowledgeBase,
  );
  const retainedCustomerAttachmentCount =
    activeConversation.knowledgeBase?.retainedCustomerAttachmentCount;
  const knowledgeBaseHasDisplayableContent =
    activeConversation.knowledgeBase?.contentAvailability === "partial" ||
    activeConversation.knowledgeBase?.contentAvailability === "complete";
  const knowledgeBaseNoticeDisplayMessage = knowledgeBaseTaskNotCreated
    ? "附件未能完成任务创建前的登记，请重置后重新上传资料。"
    : activeConversation.knowledgeBase?.operationState === "reset_required"
      ? knowledgeBaseHasDisplayableContent
        ? "本轮需要重置，已完成内容不受影响。"
        : "本轮需要重置，请重置后重新上传资料。"
      : activeConversation.knowledgeBase?.notice?.message;

  const generalConversation =
    operatorWorkspace &&
    standardWelcomeVariant === "simple" &&
    !syncKnowledgeBaseSnapshot &&
    !responseLogicContext &&
    !purpose;
  const welcome =
    generalConversation &&
    messages.length === 0 &&
    inlineSlots.initial.length === 0 &&
    status === "idle";
  return (
    <div
      className={`relative flex h-full min-h-0 min-w-0 flex-1 flex-col overflow-hidden bg-white ${welcome ? "general-agent-welcome" : ""}`}
    >
      {/* The unified workspace supplies one task header and one status area. */}
      {!operatorWorkspace && (
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
                status={displayStatus || "idle"}
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
                    {syncKnowledgeBaseSnapshot ||
                    responseLogicContext ||
                    purpose ||
                    fixedAgentProfile
                      ? "FrontMind Agent"
                      : getModelDisplayName(executionModel)}
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
                {startedAt && (activeTask || completedAt) && (
                  <HeaderExecutionDuration
                    startedAt={startedAt}
                    completedAt={completedAt}
                    active={Boolean(activeTask)}
                  />
                )}
              </div>
            )}
          </div>
        </div>
      )}

      {/* Messages area */}
      <div
        ref={messagesViewportRef}
        className="min-h-0 flex-1 overflow-y-auto bg-white custom-scrollbar"
        data-testid="chat-messages-viewport"
        style={{ overflowAnchor: "none" }}
      >
        <div
          className={
            operatorWorkspace
              ? "workbench-reading-column space-y-7"
              : "max-w-4xl mx-auto px-3 py-6 space-y-6 sm:px-5 sm:py-8 sm:space-y-7"
          }
        >
          {inlineSlots.initial.length ? null : messages.length === 0 &&
          status === "idle" &&
          responseLogicContext ? (
            <ResponseLogicConversationHint
              question={responseLogicContext.question}
            />
          ) : freshUploadNeedsFiles &&
            activeConversation.knowledgeBase?.activeTurnId &&
            activeConversation.knowledgeBase.activeClientRequestId ? (
            <KnowledgeBaseManagedUploadRecovery
              operationType="start"
              conversationId={activeConversation.id}
              turnId={activeConversation.knowledgeBase.activeTurnId}
              clientRequestId={
                activeConversation.knowledgeBase.activeClientRequestId
              }
              expectedResetRevision={
                knowledgeBaseResetRevision ??
                activeConversation.knowledgeBase.activeTurnResetRevision ??
                0
              }
              onObservation={(observation) =>
                commitKnowledgeBaseObservation(
                  activeConversation.id,
                  observation,
                )
              }
              onRecovered={() =>
                wakeKnowledgeBaseConversation(activeConversation.id)
              }
            />
          ) : showKnowledgeBaseStarter ? (
            <EmptyConversationHint
              key={`${knowledgeBaseAccountId ?? 0}:${knowledgeBaseResetRevision ?? 0}:${activeConversation.id}`}
              uploadScopeKey={starterScopeKey}
              onStartKnowledgeBase={startKnowledgeBase}
              onBatchCancelled={(resetRevision) =>
                discardCancelledKnowledgeBaseStart(
                  activeConversation.id,
                  resetRevision,
                )
              }
              eligible={messages.length === 0 && status === "idle"}
              inline={operatorWorkspace}
              onDirtyChange={onComposerDirtyChange}
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
              resetRevision={knowledgeBaseResetRevision ?? 0}
            />
          ) : messages.length === 0 && status === "idle" ? (
            <StandardConversationHint variant={standardWelcomeVariant} />
          ) : null}

          {renderInlineBlocks(inlineSlots.initial)}
          <AnimatePresence initial={false}>
            {messages.map((msg) => (
              <div
                key={msg.id}
                data-reading-anchor={msg.id}
                className={
                  msg.role === "user" ? "general-chat-user-turn" : undefined
                }
              >
                {renderInlineBlocks(inlineSlots.before.get(msg.id))}
                <GeneralExecutionActivity
                  items={executionSlots.before.get(msg.id)}
                  expandedGroups={expandedExecutionGroups}
                  onToggleGroup={toggleExecutionGroup}
                />
                <MessageBubble
                  message={msg}
                  isFinalReply={copyableReplyIds.has(msg.id)}
                  inlineContent={renderInlineBlocks(
                    inlineSlots.after.get(msg.id),
                  )}
                  isRunning={displayActiveTask}
                  generalChatLinks={
                    activeConversation.executionKind === "general_chat_v2"
                  }
                  fixedElapsedTime={
                    status === "completed" &&
                    msg.id === finalAssistantMessageId &&
                    startedAt !== undefined &&
                    completedAt !== undefined
                      ? Math.max(0, (completedAt - startedAt) / 1_000)
                      : undefined
                  }
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
                {msg.role === "user" && (
                  <ExecutionDivider timing={executionTimings.get(msg.id)} />
                )}
                <GeneralExecutionActivity
                  items={executionSlots.after.get(msg.id)}
                  placement="after"
                  expandedGroups={expandedExecutionGroups}
                  onToggleGroup={toggleExecutionGroup}
                />
              </div>
            ))}
          </AnimatePresence>
          {activeConversation.execution?.coverage === "unavailable" && (
              <p className="text-xs text-muted-foreground">
                过程记录暂不可用，已返回的内容仍会保留。
              </p>
            )}

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
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="min-w-0 flex-1">
                    <span>{knowledgeBaseNoticeDisplayMessage}</span>
                    {knowledgeBaseTaskNotCreated &&
                      typeof retainedCustomerAttachmentCount === "number" &&
                      retainedCustomerAttachmentCount > 0 && (
                        <p
                          className="mt-1 text-xs"
                          data-testid="knowledge-base-attachment-retention"
                        >
                          {retainedCustomerAttachmentCount}/
                          {retainedCustomerAttachmentCount}{" "}
                          个附件已保留，知识库任务未创建。
                        </p>
                      )}
                  </div>
                  {operatorWorkspace &&
                  !["reconcile", "none"].includes(
                    knowledgeBaseNoticeRecoveryMode(
                      activeConversation.knowledgeBase.notice,
                    ),
                  ) ? (
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      onClick={requestKnowledgeBaseReset}
                    >
                      重置后重新上传
                    </Button>
                  ) : activeConversation.knowledgeBase.notice.code ===
                    KNOWLEDGE_BASE_REBUILD_REQUIRED_NOTICE_CODE ? (
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      onClick={requestKnowledgeBaseReset}
                    >
                      重置后重新上传
                    </Button>
                  ) : knowledgeBaseNoticeRequiresLogoProvenanceRepair(
                      activeConversation.knowledgeBase.notice,
                    ) ? (
                    activeConversation.knowledgeBase.revision !== null ? (
                      <KnowledgeBaseLogoProvenanceRepair
                        conversationId={activeConversation.id}
                        expectedGeneration={
                          activeConversation.knowledgeBase.generation
                        }
                        expectedRevision={
                          activeConversation.knowledgeBase.revision
                        }
                        expectedLeafId={activeConversation.knowledgeBase.leafId}
                        onObservation={(observation) => {
                          commitKnowledgeBaseObservation(
                            activeConversation.id,
                            observation,
                          );
                          wakeKnowledgeBaseConversation(activeConversation.id);
                        }}
                      />
                    ) : null
                  ) : knowledgeBaseNoticeRequiresAttachmentRepair(
                      activeConversation.knowledgeBase.notice,
                    ) ? (
                    activeConversation.knowledgeBase.revision !== null ? (
                      <KnowledgeBaseAttachmentRepair
                        conversationId={activeConversation.id}
                        expectedGeneration={
                          activeConversation.knowledgeBase.generation
                        }
                        expectedRevision={
                          activeConversation.knowledgeBase.revision
                        }
                        expectedLeafId={activeConversation.knowledgeBase.leafId}
                        onObservation={(observation) => {
                          commitKnowledgeBaseObservation(
                            activeConversation.id,
                            observation,
                          );
                          wakeKnowledgeBaseConversation(activeConversation.id);
                        }}
                      />
                    ) : null
                  ) : knowledgeBaseNoticeHasRecoveryAction(
                      activeConversation.knowledgeBase.notice,
                    ) ? (
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      disabled={retryingKnowledgeBase}
                      onClick={() => {
                        if (
                          knowledgeBaseNoticeRecoveryMode(
                            activeConversation.knowledgeBase!.notice!,
                          ) === "reset"
                        ) {
                          requestKnowledgeBaseReset();
                          return;
                        }
                        void retryCurrentKnowledgeBaseTurn();
                      }}
                    >
                      {retryingKnowledgeBase && (
                        <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
                      )}
                      {knowledgeBaseNoticeRetryLabel(
                        activeConversation.knowledgeBase.notice,
                      )}
                    </Button>
                  ) : null}
                </div>
              </div>
            )}

          {/* Typing indicator when running */}
          {displayActiveTask &&
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
                text={runningAssistantStatusText(
                  syncKnowledgeBaseSnapshot,
                  activeConversation?.knowledgeBase?.processingPhase,
                  activeConversation?.knowledgeBase?.runPhase,
                )}
              />
            )}

          {conversationFooter && (
            <div data-reading-anchor="business-footer">
              {conversationFooter}
            </div>
          )}
          <div aria-hidden="true" />
        </div>
      </div>

      {showLatest && (
        <button
          type="button"
          className="chat-back-to-latest"
          onClick={returnToLatest}
        >
          ↓ 回到最新
        </button>
      )}
      {/* Knowledge intake owns its initial fields; its real conversation starts after submission. */}
      {!(
        operatorWorkspace &&
        showKnowledgeBaseStarter &&
        messages.length === 0 &&
        status === "idle"
      ) && (
        <ChatInput
          welcomeSuggestions={
            welcome ||
            (purpose === "enterprise_qa" &&
            messages.length === 0 &&
            status === "idle"
              ? "enterprise_qa"
              : false)
          }
        fixedAgentProfile={fixedAgentProfile}
        syncKnowledgeBaseSnapshot={syncKnowledgeBaseSnapshot}
        purpose={purpose}
        contentProduction={contentProduction}
        composerPrefill={composerPrefill}
        responseLogicContext={responseLogicContext}
        knowledgeBaseProgress={knowledgeBaseProgress}
        knowledgeBaseResetRevision={knowledgeBaseResetRevision}
        operatorWorkspace={operatorWorkspace}
        knowledgeEditingBlocked={knowledgeEditingBlocked}
        onComposerDirtyChange={onComposerDirtyChange}
        />
      )}
    </div>
  );
}

function EmptyState({ enterpriseQa = false }: { enterpriseQa?: boolean }) {
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
          {enterpriseQa ? "企业问答智能体" : "FrontMind 通用智能体"}
        </h2>
        <p className="text-sm text-muted-foreground mb-8 leading-relaxed max-w-sm mx-auto">
          {enterpriseQa
            ? "基于已发布的企业知识库回答产品、服务和业务问题。"
            : "直接输入任务或上传资料，开始研究、分析和内容制作。"}
        </p>
        <button
          onClick={() => createConversation()}
          className="inline-flex items-center gap-2 px-6 py-3 rounded-xl bg-primary text-primary-foreground font-medium text-sm hover:opacity-90 transition-all shadow-lg glow-indigo active:scale-[0.98]"
        >
          <Sparkles className="w-4 h-4" />
          {enterpriseQa ? "开始企业问答" : "新建会话"}
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
  variant: "simple" | "workflow" | "enterprise_qa";
}) {
  if (variant === "enterprise_qa") {
    return (
      <div className="enterprise-qa-starter w-full py-4">
        <h3 className="text-base font-semibold leading-7">
          你想先了解企业的哪方面？
        </h3>
        <p className="mt-2 text-base leading-7 text-[#595959]">
          回答会参考本会话绑定的已发布知识库；资料未覆盖的内容会明确说明。
        </p>
      </div>
    );
  }
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

  return <GeneralAgentWelcome />;
}

type KnowledgeBaseStarterFileState = {
  stage: KnowledgeBaseStarterUploadStage;
  itemId?: string;
  intentId?: string;
  fileId?: string;
  loadedBytes: number;
  dashboardReceivedBytes?: number;
  totalBytes: number;
  error?: string;
  errorCode?: string;
  retryable?: boolean;
  recoveryAction?: UploadRecoveryAction;
  recreateRequired?: boolean;
  traceId?: string;
  attempt?: number;
  startedAt?: number;
  elapsedMs?: number;
};

function createKnowledgeBaseStarterClientRequestId(startedAt: number) {
  return typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : `kb-start-${startedAt}-${Math.random().toString(36).slice(2, 10)}`;
}

function createKnowledgeBaseStarterItemId(file: File) {
  const suffix =
    typeof crypto !== "undefined" && "randomUUID" in crypto
      ? crypto.randomUUID()
      : `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  return `kb-file-${suffix}-${file.size}`.slice(0, 255);
}

function formatKnowledgeBaseStarterBytes(bytes: number) {
  if (bytes < 1024) return `${Math.max(0, Math.round(bytes))} B`;
  const megabytes = bytes / 1024 / 1024;
  if (megabytes >= 1) return `${megabytes.toFixed(megabytes >= 10 ? 1 : 2)} MB`;
  return `${(bytes / 1024).toFixed(1)} KB`;
}

function formatKnowledgeBaseStarterElapsed(milliseconds: number) {
  const totalSeconds = Math.max(0, Math.floor(milliseconds / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return minutes > 0
    ? `${minutes}分${String(seconds).padStart(2, "0")}秒`
    : `${seconds}秒`;
}

function knowledgeBaseStarterStageCopy(state: KnowledgeBaseStarterFileState) {
  switch (state.stage) {
    case "creating_intent":
      return "正在准备资料上传";
    case "uploading_to_dashboard": {
      const percent = state.totalBytes
        ? Math.min(
            100,
            Math.round((state.loadedBytes / state.totalBytes) * 100),
          )
        : 0;
      return `正在上传资料 ${percent}%`;
    }
    case "sealed":
      return "资料已收到，正在继续处理";
    case "creating_cloud_record":
      return "正在登记资料";
    case "uploading_to_cloud":
      return "正在同步资料";
    case "waiting_cloud_ready":
      return "资料已收到，正在准备";
    case "creating_record":
      return "正在准备资料接收";
    case "recovering":
      return "正在确认资料状态";
    case "uploading": {
      const percent = state.totalBytes
        ? Math.min(
            100,
            Math.round((state.loadedBytes / state.totalBytes) * 100),
          )
        : 0;
      return `正在上传 ${percent}%`;
    }
    case "server_processing":
      return "资料已收到，正在准备";
    case "uploaded":
      return "资料已确认，等待其余文件";
    case "failed":
      return state.error || "上传失败";
    case "cancelled":
      return "已停止，可继续上传";
    default:
      return "等待上传";
  }
}

function knowledgeBaseStarterBatchCopy(phase: KnowledgeBaseStarterBatchPhase) {
  switch (phase) {
    case "uploading":
      return "正在上传资料，完成后将自动开始调研";
    case "starting":
      return "全部资料已确认，正在创建知识库任务";
    case "recovering":
      return "请求结果暂时未知，正在确认是否已启动";
    case "completed":
      return "资料已上传完成，正在启动知识库调研";
    case "failed":
      return "本批次尚未完成，可安全重试";
    default:
      return "准备上传企业资料";
  }
}

function knowledgeBaseStarterRecoveryCopy(
  state: KnowledgeBaseStarterFileState,
) {
  if (state.recoveryAction === "discard_and_recreate") {
    return "继续时将核对已保存资料，再重新上传未完成文件。";
  }
  if (state.recreateRequired) {
    return "继续时将核对已保存资料，再重新上传未完成文件。";
  }
  if (
    state.recoveryAction === "retry_same_file" ||
    state.recoveryAction === "check_status"
  ) {
    return "可以检查并继续上传该文件。";
  }
  if (state.recoveryAction === "refresh_page") {
    return "当前上传凭证无效，请刷新页面后重新选择。";
  }
  if (state.recoveryAction === "contact_admin") {
    return "该文件需要管理员协助处理。";
  }
  if (state.retryable === false) {
    return "无法直接重试；请移除该文件后继续，或取消本批次重新选择。";
  }
  return null;
}

export function formatKnowledgeBaseUploadBytes(bytes: number) {
  if (bytes < 1_000) return `${Math.max(0, Math.round(bytes))} B`;
  if (bytes < 1_000_000) return `${(bytes / 1_000).toFixed(1)} KB`;
  return `${(bytes / 1_000_000).toFixed(1)} MB`;
}

export function EmptyConversationHint({
  uploadScopeKey = "knowledge-starter",
  onStartKnowledgeBase,
  onBatchCancelled,
  eligible = true,
  companyName,
  companyConfigured,
  companyLoading,
  resetRevision = 0,
  inline = false,
  onDirtyChange,
}: {
  uploadScopeKey?: string;
  onStartKnowledgeBase: (
    input: DeepReportStartInput,
    lifecycle: KnowledgeBaseStarterLifecycle,
  ) => Promise<KnowledgeBaseStarterStartOutcome>;
  onBatchCancelled?: (resetRevision: number) => void | Promise<void>;
  eligible?: boolean;
  companyName: string;
  companyConfigured: boolean;
  companyLoading: boolean;
  resetRevision?: number;
  inline?: boolean;
  onDirtyChange?: (dirty: boolean) => void;
}) {
  const uploadBatch = useKnowledgeBaseUploadBatch(
    `${uploadScopeKey}:${resetRevision}`,
    `${uploadScopeKey}:`,
  );
  const fileInputRef = useRef<HTMLInputElement>(null);
  const starterEntryRef = useRef<HTMLDivElement>(null);
  const starterTriggerRef = useRef<HTMLElement | null>(null);
  const [dialogOpen, setDialogOpen] = useKnowledgeBaseUploadField(
    uploadBatch,
    "dialogOpen",
    false,
  );
  const [companyNameDraft, setCompanyNameDraft] = useKnowledgeBaseUploadField(
    uploadBatch,
    "companyNameDraft",
    "",
  );
  const [companyNameTouched, setCompanyNameTouched] =
    useKnowledgeBaseUploadField(uploadBatch, "companyNameTouched", false);
  // The server-configured name only seeds the draft; typed edits win.
  useEffect(() => {
    if (!companyNameTouched) setCompanyNameDraft(companyName);
  }, [companyName, companyNameTouched, setCompanyNameDraft]);
  const effectiveCompanyName = companyNameDraft.trim();
  const [companyWebsite, setCompanyWebsite] = useKnowledgeBaseUploadField(
    uploadBatch,
    "companyWebsite",
    "",
  );
  const [operatorNotes, setOperatorNotes] = useKnowledgeBaseUploadField(
    uploadBatch,
    "operatorNotes",
    "",
  );
  const [fileItems, setFileItems] = useKnowledgeBaseUploadField<
    Array<{ itemId: string; file: File }>
  >(uploadBatch, "fileItems", []);
  const files = useMemo(() => fileItems.map((item) => item.file), [fileItems]);
  const starterDirty =
    eligible &&
    !uploadBatch.read<number | null>("batchStartedAt", null) &&
    Boolean(
      effectiveCompanyName !== companyName.trim() ||
        companyWebsite.trim() ||
        operatorNotes.trim() ||
        files.length,
    );
  useWorkspaceDraftGuard({
    dirty: inline && starterDirty && !uploadBatch.read("batchStartedAt", null),
    label: "知识库资料和补充说明",
  });
  useEffect(() => {
    if (inline) onDirtyChange?.(starterDirty);
  }, [inline, starterDirty, onDirtyChange]);
  useEffect(
    () => () => {
      if (inline) onDirtyChange?.(false);
    },
    [inline, onDirtyChange],
  );
  const [isDragging, setIsDragging] = useKnowledgeBaseUploadField(
    uploadBatch,
    "isDragging",
    false,
  );
  const [isStarting, setIsStarting] = useKnowledgeBaseUploadField(
    uploadBatch,
    "isStarting",
    false,
  );
  const [isDiscarding, setIsDiscarding] = useKnowledgeBaseUploadField(
    uploadBatch,
    "isDiscarding",
    false,
  );
  const [fileStates, setFileStates] = useKnowledgeBaseUploadField<
    Map<string, KnowledgeBaseStarterFileState>
  >(uploadBatch, "fileStates", () => new Map());
  const [uploadedReceipts, setUploadedReceipts] = useKnowledgeBaseUploadField<
    Map<string, KnowledgeBaseStarterUploadReceipt>
  >(uploadBatch, "uploadedReceipts", () => new Map());
  const [fileRecordIds, setFileRecordIds] = useKnowledgeBaseUploadField<
    Map<string, string>
  >(uploadBatch, "fileRecordIds", () => new Map());
  const [uploadHandles, setUploadHandles] = useKnowledgeBaseUploadField<
    Map<string, ManagedUploadHandle>
  >(uploadBatch, "uploadHandles", () => new Map());
  const [batchStartedAt, setBatchStartedAt] = useKnowledgeBaseUploadField<
    number | null
  >(uploadBatch, "batchStartedAt", null);
  const [elapsedAt, setElapsedAt] = useKnowledgeBaseUploadField(
    uploadBatch,
    "elapsedAt",
    () => Date.now(),
  );
  const [batchError, setBatchError] = useKnowledgeBaseUploadField<
    string | null
  >(uploadBatch, "batchError", null);
  const [batchPhase, setBatchPhase] =
    useKnowledgeBaseUploadField<KnowledgeBaseStarterBatchPhase>(
      uploadBatch,
      "batchPhase",
      "ready",
    );
  const [startPrepared, setStartPrepared] = useKnowledgeBaseUploadField(
    uploadBatch,
    "startPrepared",
    false,
  );
  const [startReservation, setStartReservation] =
    useKnowledgeBaseUploadField<NonNullable<
    KnowledgeBaseStarterLifecycle["reservation"]
  > | null>(uploadBatch, "startReservation", null);
  const abortControllerRef = uploadBatch.ref<AbortController | null>(
    "controller",
    null,
  );
  const clientRequestIdRef = uploadBatch.ref<string | null>(
    "clientRequestId",
    null,
  );
  const batchLocked = batchStartedAt !== null;
  const openStarterDialog = useCallback(() => {
    starterTriggerRef.current =
      starterEntryRef.current?.querySelector<HTMLElement>("button") ?? null;
    setDialogOpen(true);
  }, [setDialogOpen]);

  const addFiles = useCallback((fileList: FileList | File[]) => {
    const incoming = Array.from(fileList).filter((file) => {
      const sizeError = chatAttachmentSizeError(file);
      if (!sizeError) return true;
      toast.error("文件过大", { description: sizeError });
      return false;
    });
    const candidates = incoming.map((file) => ({
      itemId: createKnowledgeBaseStarterItemId(file),
      file,
    }));
    setFileItems((current) => {
      const seen = new Set(
        current.map(
          ({ file }) => `${file.name}:${file.size}:${file.lastModified}`,
        ),
      );
      const next = [...current];
      for (const candidate of candidates) {
        const { file } = candidate;
        const key = `${file.name}:${file.size}:${file.lastModified}`;
        if (!seen.has(key)) {
          seen.add(key);
          next.push(candidate);
        }
      }
      return next;
    });
    setFileStates((current) => {
      const next = new Map(current);
      for (const { itemId, file } of candidates) {
        if (!next.has(itemId)) {
          next.set(itemId, {
            stage: "queued",
            loadedBytes: 0,
            totalBytes: file.size,
          });
        }
      }
      return next;
    });
  }, []);

  const resetDialog = useCallback(() => {
    setCompanyWebsite("");
    setOperatorNotes("");
    setFileItems([]);
    setIsDragging(false);
    setIsStarting(false);
    setIsDiscarding(false);
    setFileStates(new Map());
    setUploadedReceipts(new Map());
    setFileRecordIds(new Map());
    setUploadHandles(new Map());
    setBatchStartedAt(null);
    setElapsedAt(Date.now());
    setBatchError(null);
    setBatchPhase("ready");
    setStartPrepared(false);
    setStartReservation(null);
    abortControllerRef.current = null;
    clientRequestIdRef.current = null;
    if (fileInputRef.current) {
      fileInputRef.current.value = "";
    }
  }, []);

  const removeFile = useCallback(
    async (index: number) => {
      const removed = files[index];
      const removedItem = fileItems[index];
      // Once the server freezes a start manifest, removing one local row would
      // leave the operation waiting forever for that exact ordinal. Release
      // the whole reservation before choosing a different file set instead.
      if (
        !removed ||
        !removedItem ||
        isStarting ||
        isDiscarding ||
        startPrepared ||
        startReservation
      )
        return;
      const { itemId } = removedItem;
      const fileId = fileRecordIds.get(itemId);
      const uploadHandle = uploadHandles.get(itemId);
      if (fileId || uploadHandle) {
        setIsDiscarding(true);
        try {
          if (uploadHandle) await discardManagedUploadIntent(uploadHandle);
          else await discardUnboundUpload(fileId!);
        } catch (error) {
          const code = String((error as { code?: unknown } | null)?.code || "");
          toast.warning(
            code === "UPLOAD_IN_PROGRESS"
              ? "文件仍在处理中"
              : "文件暂时无法移除",
            {
              description:
                code === "UPLOAD_IN_PROGRESS"
                  ? "云端仍在登记该文件，请稍后再试。"
                  : uploadErrorMessage(error),
            },
          );
          return;
        } finally {
          setIsDiscarding(false);
        }
      }

      setFileItems((current) =>
        current.filter((item) => item.itemId !== itemId),
      );
      setFileStates((states) => {
        const next = new Map(states);
        next.delete(itemId);
        return next;
      });
      setUploadedReceipts((receipts) => {
        const next = new Map(receipts);
        next.delete(itemId);
        return next;
      });
      setFileRecordIds((records) => {
        const next = new Map(records);
        next.delete(itemId);
        return next;
      });
      setUploadHandles((handles) => {
        const next = new Map(handles);
        next.delete(itemId);
        return next;
      });
    },
    [
      fileItems,
      fileRecordIds,
      files,
      isDiscarding,
      isStarting,
      startPrepared,
      startReservation,
      uploadHandles,
    ],
  );

  const discardBatchAndClose = useCallback(async () => {
    if (isStarting || isDiscarding) return;
    const targets = new Map<
      string,
      { fileId?: string; handle?: ManagedUploadHandle }
    >();
    for (const [itemId, fileId] of fileRecordIds) {
      targets.set(itemId, { fileId });
    }
    // A sealed/processing intent intentionally has no provider fileId yet.
    // Include it independently so closing the dialog cannot orphan local
    // bytes or bypass the intent DELETE contract.
    for (const [itemId, handle] of uploadHandles) {
      targets.set(itemId, { ...targets.get(itemId), handle });
    }
    const records = Array.from(targets.entries());
    setIsDiscarding(true);
    if (startReservation) {
      try {
        const cancelled =
          await cancelKnowledgeBaseStartReservation(startReservation);
        setStartReservation(null);
        await onBatchCancelled?.(cancelled.resetRevision);
        void Promise.allSettled(
          records.map(([, target]) => {
            if (target.handle) {
              return discardManagedUploadIntent(target.handle, {
                deferProviderCleanup: true,
              });
            }
            return discardUnboundUpload(target.fileId!);
          }),
        );
        if (!onBatchCancelled) {
          setIsDiscarding(false);
          setDialogOpen(false);
          resetDialog();
        }
        return;
      } catch (error) {
        const code = String((error as { code?: unknown } | null)?.code || "");
        // A reset or retention tombstone already revoked the old reservation;
        // treating it as released is safe and prevents an old tab from
        // keeping the freshly reset starter UI blocked.
        if (
          ![
            "KNOWLEDGE_BASE_RESET_REVISION_CHANGED",
            "CONVERSATION_RESET",
            "TURN_NOT_FOUND",
            "BUILD_NOT_FOUND",
            "RESERVATION_NOT_FOUND",
          ].includes(code)
        ) {
          toast.warning("本批次暂时无法取消", {
            description: uploadErrorMessage(error),
          });
          setIsDiscarding(false);
          return;
        }
      }
    }

    const results = await Promise.allSettled(
      records.map(([, target]) => {
        if (target.handle) return discardManagedUploadIntent(target.handle);
        return discardUnboundUpload(target.fileId!);
      }),
    );
    const failed: Array<{ itemId: string; error: unknown }> = [];
    const discardedItemIds: string[] = [];
    results.forEach((result, index) => {
      const itemId = records[index][0];
      if (result.status === "fulfilled") discardedItemIds.push(itemId);
      else failed.push({ itemId, error: result.reason });
    });

    if (failed.length > 0) {
      const discarded = new Set(discardedItemIds);
      setFileRecordIds((current) => {
        const next = new Map(current);
        for (const itemId of discarded) next.delete(itemId);
        return next;
      });
      setUploadHandles((current) => {
        const next = new Map(current);
        for (const itemId of discarded) next.delete(itemId);
        return next;
      });
      setUploadedReceipts((current) => {
        const next = new Map(current);
        for (const itemId of discarded) next.delete(itemId);
        return next;
      });
      setFileStates((current) => {
        const next = new Map(current);
        for (const itemId of discarded) {
          const file = fileItems.find((item) => item.itemId === itemId)?.file;
          if (!file) continue;
          next.set(itemId, {
            stage: "queued",
            loadedBytes: 0,
            totalBytes: file.size,
          });
        }
        return next;
      });
      const firstError = failed[0].error;
      const code = String(
        (firstError as { code?: unknown } | null)?.code || "",
      );
      toast.warning(
        code === "UPLOAD_IN_PROGRESS"
          ? "仍有文件正在云端处理"
          : "部分文件暂时无法取消",
        {
          description:
            code === "UPLOAD_IN_PROGRESS"
              ? "请稍后再次点击取消；未清理的上传记录已保留。"
              : uploadErrorMessage(firstError),
        },
      );
      setIsDiscarding(false);
      return;
    }

    setIsDiscarding(false);
    setDialogOpen(false);
    resetDialog();
  }, [
    fileItems,
    fileRecordIds,
    isDiscarding,
    isStarting,
    resetDialog,
    onBatchCancelled,
    startReservation,
    uploadHandles,
  ]);

  useEffect(() => {
    if (!isStarting || batchStartedAt === null) return;
    setElapsedAt(Date.now());
    const timer = setInterval(() => setElapsedAt(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [batchStartedAt, isStarting]);

  const updateFileState = useCallback(
    (itemId: string, file: File, update: KnowledgeBaseStarterFileUpdate) => {
      if (update.clearFileRecord) {
        setFileRecordIds((current) => {
          const next = new Map(current);
          next.delete(itemId);
          return next;
        });
        setUploadHandles((current) => {
          const next = new Map(current);
          next.delete(itemId);
          return next;
        });
      }
      if (update.fileId) {
        setFileRecordIds((current) => {
          const next = new Map(current);
          next.set(itemId, update.fileId!);
          return next;
        });
      }
      if (update.uploadHandle) {
        setUploadHandles((current) => {
          const next = new Map(current);
          next.set(itemId, update.uploadHandle!);
          return next;
        });
      }
      if (update.receipt) {
        setUploadedReceipts((current) => {
          const next = new Map(current);
          next.set(itemId, update.receipt!);
          return next;
        });
      }
      setFileStates((current) => {
        const previous = current.get(itemId) || {
          stage: "queued" as const,
          loadedBytes: 0,
          totalBytes: file.size,
        };
        if (previous.stage === "uploaded" && update.stage !== "uploaded")
          return current;
        const now = Date.now();
        const isActive = [
          "creating_intent",
          "uploading_to_dashboard",
          "sealed",
          "creating_cloud_record",
          "uploading_to_cloud",
          "waiting_cloud_ready",
          "creating_record",
          "recovering",
          "uploading",
          "server_processing",
        ].includes(update.stage);
        const isTerminal = ["uploaded", "failed", "cancelled"].includes(
          update.stage,
        );
        if (typeof update.loadedBytes === "number")
          uploadBatch.noteTransfer(
            itemId,
            update.loadedBytes,
            update.attempt ?? previous.attempt ?? 1,
          );
        const startedAt =
          previous.startedAt ?? (isActive || isTerminal ? now : undefined);
        const next = new Map(current);
        next.set(itemId, {
          ...previous,
          ...update,
          ...(update.clearFileRecord ? { fileId: undefined } : {}),
          loadedBytes:
            typeof update.loadedBytes === "number"
              ? Math.max(0, update.loadedBytes)
              : previous.loadedBytes,
          dashboardReceivedBytes:
            typeof update.dashboardReceivedBytes === "number"
              ? Math.max(
                  previous.dashboardReceivedBytes ?? 0,
                  update.dashboardReceivedBytes,
                )
              : previous.dashboardReceivedBytes,
          totalBytes:
            typeof update.totalBytes === "number" && update.totalBytes > 0
              ? update.totalBytes
              : previous.totalBytes || file.size,
          startedAt,
          elapsedMs:
            isTerminal && startedAt !== undefined
              ? Math.max(0, now - startedAt)
              : previous.elapsedMs,
        });
        return next;
      });
    },
    [],
  );

  const uploadSummary = useMemo(() => {
    const totalBytes = fileItems.reduce(
      (total, { file }) => total + file.size,
      0,
    );
    let transferredBytes = 0;
    let dashboardReceivedBytes = 0;
    let confirmedBytes = 0;
    let confirmedCount = 0;
    for (const { itemId, file } of fileItems) {
      const state = fileStates.get(itemId);
      // Browser transfer and even a provider PUT success are not a confirmed
      // attachment until the managed upload returns its final receipt.
      if (uploadedReceipts.has(itemId) && state?.stage === "uploaded") {
        confirmedCount += 1;
        confirmedBytes += file.size;
      }
      transferredBytes += Math.min(
        file.size,
        uploadedReceipts.has(itemId)
          ? file.size
          : Math.max(0, state?.loadedBytes ?? 0),
      );
      dashboardReceivedBytes += Math.min(
        file.size,
        Math.max(0, state?.dashboardReceivedBytes ?? 0),
      );
    }
    const rawPercent = totalBytes
      ? Math.round((transferredBytes / totalBytes) * 100)
      : 0;
    return {
      totalBytes,
      transferredBytes,
      dashboardReceivedBytes,
      confirmedBytes,
      uploadedCount: confirmedCount,
      percent:
        confirmedCount === files.length && files.length > 0
          ? 100
          : Math.min(100, rawPercent),
    };
  }, [fileItems, fileStates, files.length, uploadedReceipts]);

  const nonRetryableFailedFile = useMemo(
    () =>
      fileItems.find(({ itemId }) => {
        const state = fileStates.get(itemId);
        return (
          state?.stage === "failed" &&
          state.retryable === false &&
          !state.recreateRequired &&
          !["retry_same_file", "check_status", "discard_and_recreate"].includes(
            String(state.recoveryAction),
          )
        );
      })?.file,
    [fileItems, fileStates],
  );
  const hasCloudStatusCheckFailure = useMemo(
    () =>
      fileItems.some(({ itemId }) => {
        const state = fileStates.get(itemId);
        return (
          state?.stage === "failed" && state.recoveryAction === "check_status"
        );
      }),
    [fileItems, fileStates],
  );

  const handleStart = useCallback(async () => {
    if (uploadBatch.disposed || uploadBatch.controller) return;
    const normalizedCompanyName = effectiveCompanyName;
    if (!normalizedCompanyName) {
      toast.error("请先填写本次构建使用的企业名称");
      return;
    }

    const startedAt = batchStartedAt ?? Date.now();
    const clientRequestId =
      clientRequestIdRef.current ||
      createKnowledgeBaseStarterClientRequestId(startedAt);
    clientRequestIdRef.current = clientRequestId;
    setBatchStartedAt(startedAt);
    uploadBatch.write("lastProgressAt", Date.now());
    setElapsedAt(Date.now());
    setBatchError(null);
    setBatchPhase(
      uploadedReceipts.size === files.length ? "starting" : "uploading",
    );
    setFileStates((current) => {
      const next = new Map(current);
      for (const { itemId, file } of fileItems) {
        const state = next.get(itemId);
        if (!state) {
          next.set(itemId, {
            stage: "queued",
            loadedBytes: 0,
            totalBytes: file.size,
          });
        } else if (state.stage === "failed" || state.stage === "cancelled") {
          next.set(itemId, {
            ...state,
            stage: "queued",
            error: undefined,
            errorCode: undefined,
            retryable: undefined,
            recoveryAction: undefined,
            recreateRequired: undefined,
            traceId: undefined,
            startedAt: undefined,
            elapsedMs: undefined,
          });
        }
      }
      return next;
    });

    const { controller, operation } = uploadBatch.beginAttempt();
    abortControllerRef.current = controller;
    setIsStarting(true);
    try {
      if (
        ["stopped", "stopping", "unknown"].includes(
          uploadBatch.read("stopState", "active"),
        )
      ) {
        const resumed = await uploadBatch.resume();
        if (resumed)
          setStartReservation((current) =>
            current
              ? {
                  ...current,
                  uploadAttemptId: resumed.uploadAttemptId ?? undefined,
                }
              : current,
          );
      }
      const payload = {
        companyName: normalizedCompanyName,
        companyWebsite: companyWebsite.trim(),
        agentProfile: "frontmind-pro",
        operatorNotes: operatorNotes.trim(),
        files,
      };
      const outcome = await onStartKnowledgeBase(payload, {
        signal: operation.signal,
        clientRequestId,
        expectedResetRevision: resetRevision,
        startedAt,
        uploadedReceipts: new Map(uploadedReceipts),
        fileRecordIds: new Map(fileRecordIds),
        uploadHandles: new Map(uploadHandles),
        fileAttempts: new Map(
          fileItems.map(({ itemId }) => [
            itemId,
            fileStates.get(itemId)?.attempt ?? 0,
          ]),
        ),
        transferredBytes: new Map(
          fileItems.map(({ itemId }) => [
            itemId,
            fileStates.get(itemId)?.loadedBytes ?? 0,
          ]),
        ),
        dashboardReceivedBytes: new Map(
          fileItems.map(({ itemId }) => [
            itemId,
            fileStates.get(itemId)?.dashboardReceivedBytes ?? 0,
          ]),
        ),
        fileItemIds: fileItems.map(({ itemId }) => itemId),
        startPrepared,
        onStartPrepared: setStartPrepared,
        onReservation: (reservation) => {
          setStartReservation(reservation);
          uploadBatch.startHeartbeat(reservation);
        },
        onBatchPhase: setBatchPhase,
        onFileUpdate: updateFileState,
      });
      if (outcome.status === "accepted" || outcome.status === "recovering") {
        setBatchPhase(
          outcome.status === "accepted" ? "completed" : "recovering",
        );
        setDialogOpen(false);
        resetDialog();
      }
    } catch (error) {
      setElapsedAt(Date.now());
      setBatchPhase("failed");
      setBatchError(
        uploadWasCancelled(error, controller.signal)
          ? uploadBatch.read<string>("stopState", "active") === "stopped"
            ? "上传已停止。已完成的文件会保留，继续时只处理未完成资料。"
            : "已暂停本地传输，正在确认服务端停止状态。"
          : uploadErrorMessage(error),
      );
    } finally {
      if (abortControllerRef.current === controller) {
        abortControllerRef.current = null;
      }
      uploadBatch.finishAttempt(controller);
      setIsStarting(false);
    }
  }, [
    batchStartedAt,
    effectiveCompanyName,
    companyWebsite,
    fileRecordIds,
    fileItems,
    fileStates,
    files,
    onStartKnowledgeBase,
    operatorNotes,
    resetRevision,
    resetDialog,
    startPrepared,
    updateFileState,
    uploadedReceipts,
    uploadHandles,
  ]);

  const stopUpload = useCallback(() => {
    void uploadBatch.stop();
  }, [uploadBatch]);
  const [checking] = useKnowledgeBaseUploadField(
    uploadBatch,
    "checking",
    false,
  );
  const [checkMessage] = useKnowledgeBaseUploadField<string | null>(
    uploadBatch,
    "checkMessage",
    null,
  );
  const [stopState] = useKnowledgeBaseUploadField(
    uploadBatch,
    "stopState",
    "active",
  );
  const lastProgressAt = uploadBatch.read<number>("lastProgressAt", Date.now());
  const stalled =
    isStarting &&
    batchPhase === "uploading" &&
    elapsedAt - lastProgressAt >= 90_000;

  if (!eligible && batchStartedAt === null && !dialogOpen) return null;

  return (
    <>
      {inline ? (
        <div ref={starterEntryRef} hidden={dialogOpen}>
          <WorkflowQuestion
            variant="entry"
            module="brand"
            question="先用哪些资料了解你的企业？"
            description="提供企业官网、宣传册或补充说明，构建后可以逐项审阅知识内容。"
            choices={[
              {
                id: "materials",
                label: "构建企业知识库",
                description: "填写官网与说明，上传企业资料",
              },
            ]}
            onSelect={openStarterDialog}
          />
        </div>
      ) : (
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
                onClick={openStarterDialog}
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
      )}

      <KnowledgeStarterSurface
        open={dialogOpen}
        onOpenChange={(open) => {
          if (open) {
            openStarterDialog();
            return;
          }
          if (isStarting || isDiscarding) return;
          // Closing the V2.3 dialog is a reversible presentation action. Keep
          // the current fields, selected files and upload handles; explicit
          // cancellation below owns discard semantics.
          setDialogOpen(false);
        }}
        onCloseAutoFocus={(event) => {
          const trigger = starterTriggerRef.current;
          if (trigger?.isConnected) {
            event.preventDefault();
            window.requestAnimationFrame(() => {
              if (trigger.isConnected) trigger.focus();
            });
          }
          starterTriggerRef.current = null;
        }}
        footer={
          <>
            <div className="workflow-actions">
              <Button
                type="button"
                variant="operatorOutline"
                onClick={() => {
                  if (isStarting) {
                    stopUpload();
                  } else {
                    void discardBatchAndClose();
                  }
                }}
                disabled={
                  isDiscarding ||
                  (isStarting && uploadSummary.uploadedCount === files.length)
                }
              >
                {isDiscarding
                  ? "正在取消"
                  : isStarting
                    ? uploadSummary.uploadedCount === files.length
                      ? "正在启动"
                      : "停止上传"
                    : startReservation
                      ? "取消本批次并重新选择"
                      : "取消"}
              </Button>
              <Button
                type="button"
                variant="operator"
                onClick={() => void handleStart()}
                disabled={
                  isStarting ||
                  isDiscarding ||
                  !effectiveCompanyName ||
                  Boolean(nonRetryableFailedFile)
                }
                className="gap-2"
              >
                {isStarting ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <BookOpen className="h-4 w-4" />
                )}
                {isStarting
                  ? uploadSummary.uploadedCount === files.length
                    ? "正在启动构建"
                    : "正在上传资料"
                  : batchStartedAt !== null
                    ? nonRetryableFailedFile
                      ? "请先移除失败文件"
                      : hasCloudStatusCheckFailure
                        ? "重新检查云端状态"
                        : uploadSummary.uploadedCount === files.length
                          ? "重试启动"
                          : "重试并继续"
                    : "开始构建"}
              </Button>
            </div>
          </>
        }
      >
          <div className="space-y-5 py-2">
            <div className="space-y-2">
              <label className="text-sm font-medium text-foreground/80">
                当前企业项目
              </label>
              <Input
                value={companyNameDraft}
                maxLength={160}
                onChange={(event) => {
                  setCompanyNameTouched(true);
                  setCompanyNameDraft(event.target.value);
                }}
              placeholder={
                companyLoading
                  ? "正在读取企业信息…"
                  : "输入本次构建使用的企业名称"
              }
                disabled={isStarting || isDiscarding}
              />
              {!companyLoading && !effectiveCompanyName && (
                <p className="text-xs leading-5 text-amber-700">
                  请填写本次知识库构建使用的企业名称。
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
                disabled={isStarting || isDiscarding || batchLocked}
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
                disabled={isStarting || isDiscarding || batchLocked}
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
                onClick={() => {
                  if (!isStarting && !isDiscarding && !batchLocked) {
                    fileInputRef.current?.click();
                  }
                }}
                onKeyDown={(event) => {
                  if (
                    !isStarting &&
                    !isDiscarding &&
                    !batchLocked &&
                    (event.key === "Enter" || event.key === " ")
                  ) {
                    event.preventDefault();
                    fileInputRef.current?.click();
                  }
                }}
                onDragOver={(event) => {
                  event.preventDefault();
                  if (!isStarting && !isDiscarding && !batchLocked) {
                    setIsDragging(true);
                  }
                }}
                onDragLeave={() => setIsDragging(false)}
                onDrop={(event) => {
                  event.preventDefault();
                  setIsDragging(false);
                  if (
                    !isStarting &&
                    !isDiscarding &&
                    !batchLocked &&
                    event.dataTransfer.files.length > 0
                  ) {
                    addFiles(event.dataTransfer.files);
                  }
                }}
                className={cn(
                  "flex min-h-[132px] cursor-pointer flex-col items-center justify-center rounded-xl border border-dashed px-4 py-5 text-center transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/30",
                  isDragging
                    ? "border-primary/70 bg-primary/5"
                    : "border-[#C8CDD5] bg-[#F0F1F3] hover:border-primary/40 hover:bg-[#E8EAED]",
                  (isStarting || isDiscarding || batchLocked) &&
                    "cursor-not-allowed opacity-60",
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
                  disabled={isStarting || isDiscarding || batchLocked}
                  onChange={(event) => {
                    if (event.target.files) addFiles(event.target.files);
                  }}
                />
              </div>

              {files.length > 0 && (
              <details
                open={batchStartedAt === null}
                className="space-y-2 rounded-xl border border-border/70 bg-muted/20 p-3"
              >
                <summary className="cursor-pointer text-sm">
                  文件进度 · 已完成 {uploadSummary.uploadedCount}/{files.length}
                </summary>
                  {fileItems.map(({ itemId, file }, index) => (
                    <div
                      key={itemId}
                      className="flex items-center justify-between gap-3 rounded-lg bg-background/80 px-3 py-2 text-sm"
                    >
                      <div className="min-w-0 flex-1">
                        <div className="truncate text-foreground/80">
                          {file.name}
                        </div>
                        <div className="text-xs text-muted-foreground">
                          {formatKnowledgeBaseUploadBytes(file.size)}
                        </div>
                        {batchStartedAt !== null &&
                          (() => {
                            const state = fileStates.get(itemId) || {
                              stage: "queued" as const,
                              loadedBytes: 0,
                              totalBytes: file.size,
                            };
                            const fileElapsedMs = state.startedAt
                              ? (state.elapsedMs ?? elapsedAt - state.startedAt)
                              : null;
                            return (
                              <>
                                <div
                                  className={cn(
                                    "mt-1 text-xs",
                                    state.stage === "failed"
                                      ? "text-destructive"
                                      : state.stage === "uploaded"
                                        ? "text-emerald-700"
                                        : "text-muted-foreground",
                                  )}
                                >
                                  {knowledgeBaseStarterStageCopy(state)}
                                </div>
                                {state.attempt !== undefined && (
                                  <div className="mt-0.5 text-[11px] tabular-nums text-muted-foreground">
                                    第 {state.attempt} 次尝试
                                  </div>
                                )}
                                {state.stage === "failed" &&
                                  knowledgeBaseStarterRecoveryCopy(state) && (
                                    <div className="mt-0.5 text-[11px] leading-4 text-destructive">
                                      {knowledgeBaseStarterRecoveryCopy(state)}
                                    </div>
                                  )}
                                {fileElapsedMs !== null && (
                                  <div className="mt-0.5 text-[11px] tabular-nums text-muted-foreground">
                                    本次耗时{" "}
                                    {formatKnowledgeBaseStarterElapsed(
                                      fileElapsedMs,
                                    )}
                                  </div>
                                )}
                              </>
                            );
                          })()}
                      </div>
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon"
                        aria-label={`移除 ${file.name}`}
                        className="h-7 w-7 shrink-0"
                        disabled={
                          isStarting ||
                          isDiscarding ||
                          startPrepared ||
                          Boolean(startReservation)
                        }
                        onClick={(event) => {
                          event.stopPropagation();
                          void removeFile(index);
                        }}
                      >
                        <X className="h-3.5 w-3.5" />
                      </Button>
                    </div>
                  ))}
                </details>
              )}

              {batchStartedAt !== null && files.length > 0 && (
                <div
                  aria-label="资料上传进度"
                  className="space-y-3 rounded-xl border border-border/70 bg-background/90 p-4"
                >
                  <div className="flex items-center justify-between gap-3 text-sm">
                    <span className="font-medium text-foreground/80">
                      资料上传进度
                    </span>
                    <span className="tabular-nums text-muted-foreground">
                      {uploadSummary.percent}%
                    </span>
                  </div>
                  <p className="text-xs leading-5 text-muted-foreground">
                  {uploadSummary.percent === 100 &&
                  uploadSummary.uploadedCount < files.length
                    ? "传输完成，等待确认"
                    : knowledgeBaseStarterBatchCopy(batchPhase)}
                </p>
                <p className="text-xs leading-5 text-muted-foreground">
                  上传完成后将自动开始调研与整理，整个过程可能需要 30
                  分钟左右。可以切换到其他页面，上传会在后台继续。
                </p>
                <p className="text-xs tabular-nums text-muted-foreground">
                  已上传{" "}
                  {formatKnowledgeBaseUploadBytes(
                    uploadSummary.transferredBytes,
                  )}{" "}
                  / {formatKnowledgeBaseUploadBytes(uploadSummary.totalBytes)} ·
                  已完成 {uploadSummary.uploadedCount}/{files.length} 个文件
                  </p>
                  <Progress
                    aria-label="总体上传进度"
                    value={uploadSummary.percent}
                  />
                  <div className="flex flex-wrap gap-x-3 gap-y-1 text-xs text-muted-foreground">
                    <span>
                      已用时{" "}
                      {formatKnowledgeBaseStarterElapsed(
                        elapsedAt - batchStartedAt,
                      )}
                    </span>
                  </div>
                {(checking || checkMessage || stalled) && (
                  <p role="status" className="text-xs text-amber-700">
                    {checking
                      ? "正在读取服务端状态…"
                      : checkMessage ||
                        "暂时没有新的服务端进度，已完成文件会保留。"}
                  </p>
                )}
                {(stalled || stopState === "unknown") && !checking && (
                  <Button
                    type="button"
                    variant="operatorOutline"
                    onClick={() =>
                      void uploadBatch.checkStatus().catch(() => undefined)
                    }
                  >
                    重新读取状态
                  </Button>
                )}
                  {batchError && (
                    <div
                      role="alert"
                      className="rounded-lg bg-destructive/10 px-3 py-2 text-xs leading-5 text-destructive"
                    >
                      {batchError}
                    </div>
                  )}
                </div>
              )}
            </div>
          </div>
      </KnowledgeStarterSurface>
    </>
  );
}

function KnowledgeStarterSurface({
  open,
  onOpenChange,
  onCloseAutoFocus,
  children,
  footer,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCloseAutoFocus?: (event: Event) => void;
  children: React.ReactNode;
  footer: React.ReactNode;
}) {
  const description =
    "系统会采集官网与公开资料，并结合上传内容构建可审阅的知识库初稿。";
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        onCloseAutoFocus={onCloseAutoFocus}
        style={
          {
            "--module-accent": OPERATOR_MODULES[0].color,
            "--module-color": OPERATOR_MODULES[0].color,
          } as React.CSSProperties
        }
        className="knowledge-starter-dialog w-[calc(100vw-1rem)] sm:max-w-[600px]"
      >
        <DialogHeader className="border-b border-border/70 px-5 py-4 sm:px-6">
          <DialogTitle>构建企业知识库</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>
        <div className="knowledge-starter-dialog__body">
          <div className="px-5 py-4 sm:px-6">{children}</div>
        </div>
        <DialogFooter className="knowledge-starter-dialog__footer">
          {footer}
        </DialogFooter>
      </DialogContent>
    </Dialog>
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

export function MessageBubble({
  message,
  isFinalReply,
  inlineContent,
  isRunning,
  generalChatLinks,
  fixedElapsedTime,
  suppressKnowledgeArtifacts,
  onDelete,
}: {
  message: LocalMessage;
  isFinalReply?: boolean;
  inlineContent?: React.ReactNode;
  isRunning?: boolean;
  generalChatLinks?: boolean;
  fixedElapsedTime?: number;
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
  const canCopyReply =
    isFinalReply ?? (!isRunning && !message.isStepsPlaceholder);

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

  const handleArtifactDownload = useCallback(
    async (href: string) => {
      const matchingImage = message.inlineImages?.find(
        (image) => image.src === href,
      );
      const matchingFile = visibleOutputFiles?.find(
        (file) => file.fileUrl === href,
      );
      const downloadName = sanitizeBrandText(
        matchingFile?.fileName ||
          matchingImage?.alt ||
          href.split("/").filter(Boolean).at(-2) ||
          "frontmind-artifact",
      );
      try {
        const blobUrl = await fetchWithAuth(href, downloadName);
        nativeDownload(blobUrl, downloadName);
        URL.revokeObjectURL(blobUrl);
      } catch (error) {
        console.error("Artifact download failed:", error);
        toast.error("文件下载失败", {
          description: error instanceof Error ? error.message : "请稍后重试",
        });
      }
    },
    [message.inlineImages, visibleOutputFiles],
  );

  return (
    <>
      <MessageActions
        message={message}
        allowCopy={isUser || canCopyReply}
        onDelete={onDelete}
      >
        <motion.div
          initial={{ opacity: 0, y: 12 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ type: "spring", stiffness: 400, damping: 30 }}
          className={cn("flex items-start gap-3", isUser && "flex-row-reverse")}
        >
          {/* User identity stays visible; assistant messages are intentionally
              text-first and do not carry a robot avatar. */}
          {isUser && (
            <div className="flex flex-shrink-0 flex-col items-center gap-0.5">
              <div className="mt-0.5 flex h-8 w-8 items-center justify-center rounded-full bg-accent/15 text-accent">
                <User className="h-4 w-4" />
              </div>
            </div>
          )}

          {/* Message content */}
          <div
            className={cn(
              "chat-message-content space-y-2",
              isUser
                ? "max-w-[92%] items-end sm:max-w-[80%]"
                : "w-full max-w-none items-start",
              inlineContent ? "w-full !max-w-full" : undefined,
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
                  "text-[16px] leading-relaxed",
                  isUser
                    ? "rounded-2xl rounded-tr-md border border-[#e4e4e7] bg-[#f4f4f5] px-4 py-3 text-foreground"
                    : "chat-message-body px-0 pt-1 text-foreground",
                )}
              >
                {isUser ? (
                  <p className="whitespace-pre-wrap break-words">
                    {displayContent}
                  </p>
                ) : (
                  <MarkdownRenderer
                    content={sanitizedContent}
                    allowCopy={canCopyReply}
                    generalChatLinks={generalChatLinks}
                    onArtifactDownload={handleArtifactDownload}
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

            {inlineContent}

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
                      data-workbench-output-key={`${message.id}:${i}`}
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
                          data-output-download
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

            {/* Keep the reply action beside the content, without time metadata. */}
            {!isUser && displayContent?.trim() && canCopyReply && (
              <div
                className={cn(
                  "chat-message-actions flex items-center justify-start",
                )}
              >
                {/* Copy button for assistant messages */}
                {!isUser && displayContent && displayContent.trim() !== "" && (
                  <button
                    type="button"
                    onClick={handleCopyMessage}
                    className={cn(
                      "inline-flex min-h-7 items-center gap-1 rounded-md bg-transparent px-0 py-1 text-[11px] font-medium transition-all duration-200 hover:bg-transparent active:scale-95",
                      copied
                        ? "text-emerald-600 dark:text-emerald-400"
                        : "text-muted-foreground hover:text-primary",
                    )}
                    title="复制内容"
                  >
                    {copied ? (
                      <>
                        <CheckCircle2 className="w-3.5 h-3.5" />
                        已复制
                      </>
                    ) : (
                      <>
                        <Copy className="w-3.5 h-3.5" />
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

export function HeaderExecutionDuration({
  startedAt,
  completedAt,
  active,
}: {
  startedAt: number;
  completedAt?: number;
  active: boolean;
}) {
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (!active) return;
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, [active, startedAt]);

  const endedAt = active ? now : completedAt;
  if (endedAt === undefined) return null;
  const seconds = Math.max(0, (endedAt - startedAt) / 1_000);
  return (
    <span
      className="inline-flex items-center gap-1 font-mono"
      data-testid="header-execution-duration"
    >
      <Clock className="h-3 w-3" />
      {formatExecutionDuration(seconds)}
    </span>
  );
}

export function formatExecutionDuration(seconds: number) {
  if (seconds < 60) return `${seconds.toFixed(1)}s`;
  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = Math.floor(seconds % 60);
  return `${minutes}m ${remainingSeconds}s`;
}
