import type { KnowledgeBaseBrowserUpload } from "./knowledge-base-upload-status";
import type {
  KnowledgeBaseDispatchState,
  KnowledgeBaseObservationDto,
} from "./knowledge-base-progress";
export type KnowledgeBaseUploadCreateAttemptState =
  | "not_sent"
  | "sending"
  | "acknowledged"
  | "rejected"
  | "unknown";
export type KnowledgeBaseRunPhase =
  | "reserved"
  | "uploading"
  | "staging"
  | "dispatching"
  | "researching"
  | "normalizing"
  | "published"
  | "failed"
  | "cancelled"
  | "reset_required";
export type KnowledgeBaseUploadStatusDto = {
  buildId: string;
  conversationId: string;
  turnId: string;
  generation: number;
  resetRevision: number;
  clientRequestId: string;
  stateEpoch: number;
  uploadStatusVersion: number;
  uploadAttemptId: string | null;
  runPhase: KnowledgeBaseRunPhase;
  controlState: "active" | "stopped";
  totalFiles: number;
  totalBytes: number;
  confirmedFiles: number;
  confirmedBytes: number;
  files: Array<{
    itemId: string;
    ordinal: number;
    filename: string;
    sizeBytes: number;
    mimeType: string;
    lastModified: number;
    sha256?: string;
    status: "missing" | "retained" | "confirmed";
    missingReason?: string;
    resourceId?: string;
  }>;
  readyToDispatch: boolean;
  allowedActions: Array<"stop" | "resume" | "upload" | "dispatch">;
  connection: KnowledgeBaseBrowserUpload | null;
  error: { code: string; message: string } | null;
  lastBusinessActivityAt: number | null;
  enterpriseProjectId?: string | null;
  operationKey?: string | null;
  dispatchState?: KnowledgeBaseDispatchState;
  createAttemptState?: KnowledgeBaseUploadCreateAttemptState;
  upstreamTaskId?: string | null;
  /** Only safe_dispatch grants an original, proven unsent request another dispatch attempt. */
  dispatchRecoveryAction?:
    | "safe_dispatch"
    | "observe"
    | "confirm_dispatch"
    | "none";
  knowledgeObservation?: KnowledgeBaseObservationDto | null;
  reservation?: {
    state:
      | "awaiting_attachments"
      | "pending"
      | "bound"
      | "completed"
      | "terminal";
    turnId: string;
    clientRequestId: string;
    sourceResetRevision: number;
    uploadAttemptId?: string;
    uploadStatusVersion: number;
    generation: number;
    revision: number;
    leafId: string | null;
    stagedAttachmentCount: number;
    expectedAttachmentCount: number;
    requiresUpload: boolean;
  };
};
const resultProcessingStages = new Set([
  "download",
  "archive_safety",
  "manifest_parse",
  "component_projection",
  "canonical_validation",
  "activation",
  "presentation",
]);

/** Only locally persisted result bytes/processing prove that research has ended. */
export function knowledgeBaseHasNormalizingResult(
  metadata: Record<string, any>,
) {
  const completion = metadata.materializedCompletion;
  return Boolean(
    (typeof completion?.storageKey === "string" &&
      completion.storageKey &&
      /^[a-f0-9]{64}$/u.test(completion.candidateArchiveSha256 ?? "")) ||
      resultProcessingStages.has(metadata.resultProcessingStage) ||
      resultProcessingStages.has(
        metadata.materializedResultDiagnostics?.resultProcessingStage,
      ),
  );
}

/** Legacy send markers are evidence of an unknown send, never proof of no send. */
export function knowledgeBaseUploadCreateAttempt(input: {
  upstreamTaskId?: string | null;
  metadata?: Record<string, any>;
}): KnowledgeBaseUploadCreateAttemptState {
  if (input.upstreamTaskId) return "acknowledged";
  const m = input.metadata ?? {};
  if (
    ["sending", "acknowledged", "rejected", "unknown"].includes(
      m.createAttemptState,
    )
  )
    return m.createAttemptState;
  if (
    m.outcomeUnknownAt ||
    m.dispatchingAt ||
    ["sending", "outcome_unknown", "unknown"].includes(m.providerAttemptState)
  )
    return "unknown";
  return "not_sent";
}
/** Project real durable state; presence of a conversation or heartbeat never proves model execution. */
export function knowledgeBaseRunPhase(input: {
  buildStatus?: string;
  operationState?: string;
  turnStatus?: string;
  upstreamTaskId?: string | null;
  metadata?: Record<string, any>;
}): KnowledgeBaseRunPhase {
  const m = input.metadata ?? {};
  if (m.uploadError) return "failed";
  if (
    input.operationState === "reset_required" ||
    input.buildStatus === "superseded" ||
    input.buildStatus === "reset"
  )
    return "reset_required";
  if (input.turnStatus === "failed" || m.uploadError) return "failed";
  if (
    input.turnStatus === "cancelled" ||
    m.uploadControl?.state === "stopped" ||
    m.browserUpload?.status === "cancelled"
  )
    return "cancelled";
  if (input.turnStatus === "completed") return "published";
  if (
    input.operationState === "normalizing" ||
    knowledgeBaseHasNormalizingResult(m)
  )
    return "normalizing";
  if (input.upstreamTaskId) return "researching";
  const createAttemptState = knowledgeBaseUploadCreateAttempt(input);
  if (["sending", "unknown", "acknowledged"].includes(createAttemptState))
    return "dispatching";
  if (createAttemptState === "rejected") return "failed";
  if (m.preparedDispatch || m.leaseOwnerHash) return "dispatching";
  if (m.awaitingClientAttachments === true) {
    const count = Number(m.userAttachmentCount ?? 0),
      staged = Array.isArray(m.clientStagedAttachments)
        ? m.clientStagedAttachments.length
        : 0;
    if (count > 0 && staged >= count) return "staging";
    return staged > 0 || Number(m.browserUpload?.uploadedBytes) > 0
      ? "uploading"
      : "reserved";
  }
  if (
    input.buildStatus === "published" ||
    (!input.turnStatus && input.operationState === "completed")
  )
    return "published";
  if (input.buildStatus === "ready_to_publish") return "normalizing";
  if (input.buildStatus === "failed" || input.buildStatus === "protocol_error")
    return "failed";
  return "reserved";
}
