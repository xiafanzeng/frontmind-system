export const knowledgeBaseLeafStatuses = [
  "pending",
  "current",
  "confirmed",
  "direct_prefilled",
  "needs_verification",
] as const;

export type KnowledgeBaseLeafStatus =
  (typeof knowledgeBaseLeafStatuses)[number];

export const knowledgeBaseBuildStatuses = [
  "researching",
  "confirming",
  "ready_to_publish",
  "published",
  "protocol_error",
  "failed",
] as const;

export type KnowledgeBaseBuildStatus =
  (typeof knowledgeBaseBuildStatuses)[number];

export const knowledgeBaseInteractionStates = [
  "queued",
  "executing",
  "awaiting_input",
  "ready_to_publish",
  "published",
  "failed",
] as const;

export type KnowledgeBaseInteractionState =
  (typeof knowledgeBaseInteractionStates)[number];

export const knowledgeBaseOperationTypes = [
  "start",
  "confirm",
  "direct_prefill",
  "revise",
  "retry",
  "legacy_reconcile",
] as const;

export type KnowledgeBaseOperationType =
  (typeof knowledgeBaseOperationTypes)[number];

export const knowledgeBaseTurnStatuses = [
  "queued",
  "running",
  "completed",
  "failed",
  "cancelled",
] as const;

export type KnowledgeBaseTurnStatus =
  (typeof knowledgeBaseTurnStatuses)[number];

export const knowledgeBaseDispatchStates = [
  "reserved",
  "recovering",
  "bound",
  "completed",
  "failed",
] as const;

export type KnowledgeBaseDispatchState =
  (typeof knowledgeBaseDispatchStates)[number];

export const knowledgeBaseFailureClasses = [
  "recoverable_same_turn",
  "requires_user_fix",
  "terminal_requires_regeneration",
  "terminal_nonregenerable",
] as const;

export type KnowledgeBaseFailureClass =
  (typeof knowledgeBaseFailureClasses)[number];

export const knowledgeBaseRecoveryActions = [
  "wait",
  /** The same Provider task is paused until the customer confirms or inputs. */
  "awaiting_input",
  "reconcile",
  /** Provider-neutral explicit recovery actions backed by a server token. */
  "retry_request",
  "start_new_generation",
  "stopped",
  "top_up",
  "update_credential",
  "fix_attachments",
  "reupload_logo",
  "approve_reset",
  "regenerate_turn",
  "resume_start_from_retained_sources",
  "reselect_start_sources",
  "create_new_canonical_from_snapshot",
  "contact_support",
] as const;

export type KnowledgeBaseRecoveryAction =
  (typeof knowledgeBaseRecoveryActions)[number];

/**
 * A terminal Manus task whose materialized archive cannot become a trusted
 * Dashboard Working Set. These codes are deliberately stable and contain no
 * provider coordinate or validation detail.
 */
export const knowledgeBaseMaterializedResultFailureCodes = [
  "KNOWLEDGE_BASE_MATERIALIZED_CONTRACT_INVALID",
  "KNOWLEDGE_BASE_MATERIALIZED_RESULT_INVALID",
  "KNOWLEDGE_BASE_MATERIALIZED_RESULT_UNAVAILABLE",
  "KNOWLEDGE_BASE_RESULT_PROCESSING_FAILED",
] as const;

export type KnowledgeBaseMaterializedResultFailureCode =
  (typeof knowledgeBaseMaterializedResultFailureCodes)[number];

export function isKnowledgeBaseMaterializedResultFailureCode(
  value: unknown,
): value is KnowledgeBaseMaterializedResultFailureCode {
  return (
    typeof value === "string" &&
    knowledgeBaseMaterializedResultFailureCodes.includes(
      value as KnowledgeBaseMaterializedResultFailureCode,
    )
  );
}

export const KNOWLEDGE_BASE_MATERIALIZED_RESULT_RESET_MESSAGE =
  "FrontMind AI 已完成，但返回的知识库文件未通过完整性校验。系统不会自动重试；请申请重置后重新上传资料。";

export const knowledgeBaseNoticeSeverities = [
  "info",
  "warning",
  "error",
] as const;

export type KnowledgeBaseNoticeSeverity =
  (typeof knowledgeBaseNoticeSeverities)[number];

export type KnowledgeBaseContentState = "building" | "completed";
export type KnowledgeBasePackageState =
  | "not_started"
  | "preparing"
  | "retrying"
  | "ready"
  | "attention_required";
export type KnowledgeBasePublicationState = "draft" | "published";
export type KnowledgeBaseSyncState =
  | "synced"
  | "repairing"
  | "attention_required";
export type KnowledgeBaseContentAvailability = "none" | "partial" | "complete";
export type KnowledgeBaseOperationState =
  | "creating"
  | "waiting_output"
  | "normalizing"
  | "completed"
  | "reset_required";
export type KnowledgeBaseTaskCreationState =
  | "not_attempted"
  | "submitting"
  | "acknowledged"
  | "rejected"
  | "outcome_unknown";
export type KnowledgeBaseFailureStage =
  | "local_upload"
  | "provider_file_registration"
  | "task_create"
  | "result_processing";
export type KnowledgeBaseProcessingPhase =
  | "uploading"
  | "restoring_files"
  | "migrating_task"
  | "waiting_provider"
  | "accepting"
  | "package_preparing";

export interface KnowledgeBaseProgressLeafDto {
  id: string;
  title: string;
  branchId: string;
  branchTitle: string;
  ordinal: number;
  status: KnowledgeBaseLeafStatus;
  /** Present only for a server-approved display-only partial materialization. */
  contentMarkdown?: string;
}

export interface KnowledgeBaseProgressBranchDto {
  id: string;
  title: string;
  total: number;
  handled: number;
  confirmed: number;
  directPrefilled: number;
  pending: number;
  current: number;
  needsVerification: number;
  leaves: KnowledgeBaseProgressLeafDto[];
}

export interface KnowledgeBaseProgressSummaryDto {
  total: number;
  handled: number;
  confirmed: number;
  directPrefilled: number;
  pending: number;
  current: number;
  needsVerification: number;
  overallPercent: number;
}

export interface KnowledgeBaseDepthPolicyDto {
  version: 1 | 2;
  minLeaves: number;
  maxLeaves: number;
  targetMinLeaves: number;
  targetMaxLeaves: number;
}

export interface KnowledgeBaseResearchSummaryDto {
  officialPages: {
    discovered: number;
    attempted: number;
    succeeded: number;
    failed: number;
  };
  publicQueries: number;
  officialDocuments: number;
  uploadsRead: number;
  sourceCount: number;
  productFamilyCount: number;
  coveredDimensionCount: number;
  gapDimensionCount: number;
  stopReason: "coverage_complete" | "source_limited" | "budget_reached";
}

export type KnowledgeBaseResultQualityWarningCode =
  | "RESULT_INCOMPLETE"
  | "ITEM_DROPPED"
  | "EVIDENCE_INCOMPLETE"
  | "AGGREGATE_UNAVAILABLE"
  | "OPTIONAL_ASSET_SKIPPED"
  | "OPTIONAL_BINARY_EVIDENCE_SKIPPED"
  | "MANIFEST_NORMALIZED"
  | "SERVER_COORDINATE_NORMALIZED"
  | "PRESENTATION_NORMALIZED"
  | "COVERAGE_INCOMPLETE";

export interface KnowledgeBaseResultQualityDto {
  completeness: "complete" | "partial";
  stats?: {
    acceptedCount: number;
    expectedCount?: number;
    droppedCount: number;
  };
  warnings?: Array<{
    code: KnowledgeBaseResultQualityWarningCode;
    area?: string;
  }>;
  downstreamEligible?: boolean;
  publishable?: boolean;
}

export interface KnowledgeBaseProgressDto {
  build: {
    id: string;
    conversationId: string;
    companyName: string;
    skillVersion?: string;
    depthPolicy: KnowledgeBaseDepthPolicyDto;
    researchSummary: KnowledgeBaseResearchSummaryDto | null;
    status: KnowledgeBaseBuildStatus;
    revision: number;
    /** Dashboard-owned immutable Working Set version; 0 means legacy/reset-required. */
    contentVersion?: number;
    executionMode?: "legacy_conversational" | "materialized_bundle_v1";
    currentLeafId: string | null;
    /** True while the first knowledge leaf is waiting for an official Logo upload. */
    logoRequired?: boolean;
    /** True while the managed Logo can still be replaced on the first leaf. */
    logoAvailable?: boolean;
    protocolError: string | null;
    awaitingResponseSince?: number | null;
    updatedAt: number;
  };
  summary: KnowledgeBaseProgressSummaryDto;
  branches: KnowledgeBaseProgressBranchDto[];
  /** Server-computed content quality; omitted for historical read-only builds. */
  resultQuality?: KnowledgeBaseResultQualityDto;
  /**
   * Server-owned materialized business state. Provider status is deliberately
   * not part of this projection; older/legacy builds may omit these fields.
   */
  contentAvailability?: KnowledgeBaseContentAvailability;
  operationState?: KnowledgeBaseOperationState;
  resetAllowed?: boolean;
  warningCodes?: string[];
  /** Public task-create boundary; independent from Provider runtime status. */
  taskCreationState?: KnowledgeBaseTaskCreationState;
  /** First customer-relevant stage that made the current operation terminal. */
  failureStage?: KnowledgeBaseFailureStage | null;
  /** Frozen customer files only; generated Skill/instructions are excluded. */
  retainedCustomerAttachmentCount?: number;
  /** Server-generated Skill/instructions attachment count. */
  generatedSystemAttachmentCount?: number;
  /** Server settlement time, never the browser polling time. */
  settledAt?: number | null;
  packageAllowed: boolean;
  /** Additive package phase; older projections may omit it. */
  packageState?: KnowledgeBasePackageState;
}

/**
 * Customer interaction state is intentionally separate from the upstream task
 * execution status. A long-running task can already be waiting for the next
 * customer confirmation while the provider still reports pending/running.
 */
export interface KnowledgeBaseInteractionDto {
  progress: KnowledgeBaseProgressDto | null;
  interactionState: KnowledgeBaseInteractionState;
  canReply: boolean;
  canPublish: boolean;
  lockReason: string | null;
}

/**
 * One durable logical operation. The task id is intentionally not exposed
 * here: authoritativeTaskId on the observation is the only task pointer a
 * client may use for diagnostics, never for state mutation.
 */
export interface KnowledgeBaseActiveTurnDto {
  id: string;
  clientRequestId: string;
  operationKey: string;
  operationType: KnowledgeBaseOperationType;
  status: KnowledgeBaseTurnStatus;
  buildGeneration: number;
  expectedRevision: number | null;
  expectedLeafId: string | null;
  startedAt: number | null;
  completedAt: number | null;
  updatedAt: number;
  /** Durable dispatch/recovery authority. Optional only during fleet rollout. */
  dispatchState?: KnowledgeBaseDispatchState;
  /**
   * Durable provider-create boundary. User-fix routes must require `not_sent`
   * exactly before they may make the same logical turn dispatchable again.
   */
  createAttemptState?:
    | "not_sent"
    | "sending"
    | "acknowledged"
    | "rejected"
    | "unknown";
  upstreamTaskId?: string | null;
  failureClass?: KnowledgeBaseFailureClass | null;
  recoveryAction?: KnowledgeBaseRecoveryAction | null;
  canRegenerate?: boolean;
  /** Reset fence frozen when this browser-backed turn was reserved. */
  resetRevision?: number;
  /** True while this turn is still waiting for one or more browser Files. */
  awaitingClientAttachments?: boolean;
  /** True while the logical turn still awaits one or more browser-backed files. */
  requiresAttachmentReselection?: boolean;
  stagedAttachmentCount?: number;
  expectedAttachmentCount?: number;
  /** Canonical position of the persisted user message in this conversation. */
  messageSequence?: number;
}

/**
 * Durable acknowledgement for the most recently completed logical turn.
 * Unlike activeTurn/presentation this remains available when a fast finalizer
 * has already released the turn and there is no next presentation.
 */
export interface KnowledgeBaseCompletedTurnDto {
  turnId: string;
  clientRequestId: string;
  messageSequence: number;
}

/** A server-owned resource that is safe for the customer UI to render. */
export interface KnowledgeBaseApprovedResourceDto {
  /** Opaque content handle; never an internal asset/file identifier. */
  id: string;
  kind: "logo" | "customer_upload" | "working_set_asset";
  caption: string;
  mimeType: string;
  sizeBytes?: number;
  /** Authenticated same-origin URL containing only an opaque HMAC handle. */
  sameOriginUrl: string;
}

/**
 * Canonical customer-visible node projection produced by the same locked
 * transaction that advances the build. Raw upstream output is not part of
 * this contract.
 */
export interface KnowledgeBaseApprovedPresentationDto {
  turnId: string;
  /**
   * Durable request identity of the turn that produced this presentation.
   * The client must not bind an optimistic user message without this exact
   * match: `turnId` alone cannot prove that a network-unknown POST was
   * accepted by the server.
   */
  clientRequestId: string | null;
  /**
   * Generation that accepted this presentation. Optional while older server
   * projections and cached observations roll forward.
   */
  generation?: number;
  /**
   * Server-owned acceptance time from the immutable assistant message ledger.
   * Optional while older server projections and cached observations roll
   * forward.
   */
  acceptedAt?: number;
  presentationKey: string;
  revision: number;
  leafId: string;
  visibleMarkdown: string;
  contentSha256: string;
  imageState: "attached" | "no_eligible_asset";
  resources: KnowledgeBaseApprovedResourceDto[];
  /** Canonical positions of this turn's request and approved response. */
  requestMessageSequence?: number;
  messageSequence?: number;
}

/** Immutable validated archive exposed through an authenticated download. */
export interface KnowledgeBasePackageDto {
  revision: number;
  outputItemId: string | null;
  fileId: string | null;
  filename: string;
  mimeType: "application/zip";
  sha256: string;
  sizeBytes: number;
  downloadPath: string;
}

/** A deduplicated notice; it never competes with approved assistant content. */
export interface KnowledgeBaseNoticeDto {
  key: string;
  code: string;
  severity: KnowledgeBaseNoticeSeverity;
  message: string;
  retryable: boolean;
  failureClass?: KnowledgeBaseFailureClass | null;
  recoveryAction?: KnowledgeBaseRecoveryAction | null;
  /** Opaque, same-account recovery capability bound to the current state. */
  recoveryToken?: string | null;
  canRegenerate?: boolean;
  /** Internal correlation only; the final customer projection removes it. */
  traceId?: string | null;
  /** Total frozen attachment count relevant to this notice. */
  attachmentCount?: number;
  turnId: string | null;
  createdAt: number;
}

/**
 * Atomic, server-authoritative result returned by start, turn, reconcile and
 * recovery endpoints. Consumers commit this object as one state transition.
 */
export interface KnowledgeBaseObservationDto {
  stateEpoch: number;
  generation: number;
  /** Monotonic display authority backed by messages.sequence. */
  displaySequence?: number;
  syncState?: KnowledgeBaseSyncState;
  /** Server-owned business projection; Provider task status is never exposed as the conclusion. */
  contentAvailability?: KnowledgeBaseContentAvailability;
  operationState?: KnowledgeBaseOperationState;
  resetAllowed?: boolean;
  warningCodes?: string[];
  taskCreationState?: KnowledgeBaseTaskCreationState;
  failureStage?: KnowledgeBaseFailureStage | null;
  retainedCustomerAttachmentCount?: number;
  generatedSystemAttachmentCount?: number;
  settledAt?: number | null;
  processingPhase?: KnowledgeBaseProcessingPhase | null;
  contentState?: KnowledgeBaseContentState;
  packageState?: KnowledgeBasePackageState;
  publicationState?: KnowledgeBasePublicationState;
  contentCompletedAt?: number | null;
  canonicalTaskUrl?: string | null;
  localRestrictions?: string[];
  authoritativeTaskId: string | null;
  activeTurn: KnowledgeBaseActiveTurnDto | null;
  /** Optional while old servers/fixtures roll forward; new projections return null or a value. */
  completedTurn?: KnowledgeBaseCompletedTurnDto | null;
  interaction: KnowledgeBaseInteractionDto;
  approvedPresentation: KnowledgeBaseApprovedPresentationDto | null;
  package: KnowledgeBasePackageDto | null;
  notice: KnowledgeBaseNoticeDto | null;
  conversationVersion: number | null;
}
