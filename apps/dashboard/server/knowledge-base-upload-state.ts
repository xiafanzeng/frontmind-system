import type { ConversationTurn, KnowledgeBaseBuild } from "../drizzle/schema";
import { knowledgeBaseBrowserUpload } from "../shared/knowledge-base-upload-status";
import { sanitizeFrontMindPublicText } from "../shared/frontmind-public-brand";
import {
  knowledgeBaseRunPhase,
  knowledgeBaseUploadCreateAttempt,
  type KnowledgeBaseUploadStatusDto,
} from "../shared/knowledge-base-upload-state";

export function uploadMetadataVersion(
  metadata: Record<string, any>,
  now: Date,
) {
  return {
    uploadStatusVersion:
      Math.max(0, Number(metadata.uploadStatusVersion) || 0) + 1,
    uploadBusinessActivityAt: now.getTime(),
  };
}
export function projectKnowledgeBaseUploadStatus(
  turn: ConversationTurn,
  build: KnowledgeBaseBuild,
  now = Date.now(),
): KnowledgeBaseUploadStatusDto {
  const m = (turn.metadata ?? {}) as Record<string, any>;
  const manifest =
    m.recovery?.clientAttachmentManifest ??
    m.recovery?.attachmentManifest ??
    [];
  const staged = m.clientStagedAttachments ?? [];
  const stopped =
    m.uploadControl?.state === "stopped" ||
    m.browserUpload?.status === "cancelled";
  const phase = knowledgeBaseRunPhase({
    buildStatus: build.status,
    turnStatus: turn.status,
    upstreamTaskId: turn.upstreamTaskId,
    metadata: m,
  });
  const files: KnowledgeBaseUploadStatusDto["files"] = manifest.map(
    (item: any, index: number) => {
      const saved = staged.find(
        (entry: any) =>
          entry.index === index &&
          (!item.itemId || entry.itemId === item.itemId),
      );
      return {
        itemId: item.itemId ?? `legacy-${index + 1}`,
        ordinal: index + 1,
        filename: item.filename,
        sizeBytes: item.sizeBytes,
        mimeType: item.mimeType,
        lastModified: item.lastModified ?? 0,
        ...(item.sha256 ? { sha256: item.sha256 } : {}),
        status: saved ? "confirmed" : "missing",
        ...(saved
          ? { resourceId: saved.file_id }
          : { missingReason: "需要选择并上传此文件" }),
      };
    },
  );
  const confirmed = files.filter((f) => f.status === "confirmed");
  const createAttemptState = knowledgeBaseUploadCreateAttempt({
    upstreamTaskId: turn.upstreamTaskId,
    metadata: m,
  });
  const terminal = [
    "failed",
    "cancelled",
    "reset_required",
    "published",
  ].includes(phase);
  const canUpload =
    m.awaitingClientAttachments === true &&
    turn.status === "queued" &&
    createAttemptState === "not_sent" &&
    !m.preparedDispatch &&
    !m.leaseOwnerHash &&
    build.activeTurnId === turn.id &&
    !m.uploadError;
  const ready = canUpload && !stopped && files.length === confirmed.length;
  const dispatchState =
    turn.status === "completed"
      ? "completed"
      : turn.status === "failed" || turn.status === "cancelled" || m.uploadError
        ? "failed"
        : turn.upstreamTaskId
          ? "bound"
          : createAttemptState !== "not_sent" ||
              m.preparedDispatch ||
              m.leaseOwnerHash ||
              m.dispatchState === "recovering"
            ? "recovering"
            : "reserved";
  const dispatchRecoveryAction =
    terminal || stopped
      ? "none"
      : turn.upstreamTaskId
        ? "observe"
        : ["sending", "unknown", "acknowledged"].includes(createAttemptState)
          ? "confirm_dispatch"
          : ready
            ? "safe_dispatch"
            : dispatchState === "recovering"
              ? "observe"
              : "none";
  const reservationState =
    turn.status === "completed"
      ? "completed"
      : terminal && !stopped
        ? "terminal"
        : turn.upstreamTaskId
          ? "bound"
          : m.awaitingClientAttachments === true
            ? "awaiting_attachments"
            : "pending";
  return {
    buildId: build.id,
    conversationId: build.conversationId,
    turnId: turn.id,
    generation: turn.buildGeneration!,
    resetRevision: Number(m.sourceResetRevision ?? 0),
    enterpriseProjectId: build.enterpriseProjectId,
    operationKey: turn.operationKey,
    dispatchState,
    createAttemptState,
    upstreamTaskId: turn.upstreamTaskId,
    dispatchRecoveryAction,
    reservation: {
      state: reservationState,
      turnId: turn.id,
      clientRequestId: turn.clientRequestId!,
      sourceResetRevision: Number(m.sourceResetRevision ?? 0),
      ...(m.uploadAttemptId ? { uploadAttemptId: m.uploadAttemptId } : {}),
      uploadStatusVersion: Number(m.uploadStatusVersion ?? 0),
      generation: turn.buildGeneration!,
      revision: turn.expectedRevision!,
      leafId: turn.expectedLeafId,
      stagedAttachmentCount: confirmed.length,
      expectedAttachmentCount: files.length,
      requiresUpload:
        reservationState === "awaiting_attachments" &&
        confirmed.length < files.length,
    },
    clientRequestId: turn.clientRequestId!,
    stateEpoch: build.stateEpoch,
    uploadStatusVersion: Number(m.uploadStatusVersion ?? 0),
    uploadAttemptId: m.uploadAttemptId ?? null,
    runPhase: phase,
    controlState: stopped ? "stopped" : "active",
    files,
    totalFiles: files.length,
    totalBytes: files.reduce((s, f) => s + f.sizeBytes, 0),
    confirmedFiles: confirmed.length,
    confirmedBytes: confirmed.reduce((s, f) => s + f.sizeBytes, 0),
    readyToDispatch: ready,
    allowedActions: canUpload
      ? stopped
        ? ["resume"]
        : ready
          ? ["stop", "dispatch"]
          : ["stop", "upload"]
      : [],
    connection: knowledgeBaseBrowserUpload(m.browserUpload, now) ?? null,
    error: m.uploadError
      ? {
          code: String(m.uploadError.code),
          message: String(m.uploadError.message),
        }
      : turn.status === "failed"
        ? {
            code: turn.errorCode || "UPLOAD_TURN_FAILED",
            message: turn.errorMessage
              ? sanitizeFrontMindPublicText(turn.errorMessage)
              : "本轮任务失败，请查看任务原因并按提示处理",
          }
        : null,
    lastBusinessActivityAt:
      Number(m.uploadBusinessActivityAt) || turn.createdAt?.getTime() || null,
  };
}
