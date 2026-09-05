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

export const knowledgeBaseNoticeSeverities = [
  "info",
  "warning",
  "error",
] as const;

export type KnowledgeBaseNoticeSeverity =
  (typeof knowledgeBaseNoticeSeverities)[number];

export interface KnowledgeBaseProgressLeafDto {
  id: string;
  title: string;
  branchId: string;
  branchTitle: string;
  ordinal: number;
  status: KnowledgeBaseLeafStatus;
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

export interface KnowledgeBaseProgressDto {
  build: {
    id: string;
    conversationId: string;
    companyName: string;
    skillVersion?: string;
    status: KnowledgeBaseBuildStatus;
    revision: number;
    currentLeafId: string | null;
    /** True while the first knowledge leaf is waiting for an official Logo upload. */
    logoRequired?: boolean;
    protocolError: string | null;
    awaitingResponseSince?: number | null;
    updatedAt: number;
  };
  summary: KnowledgeBaseProgressSummaryDto;
  branches: KnowledgeBaseProgressBranchDto[];
  packageAllowed: boolean;
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
  /** True only while the logical turn exists but browser files are not frozen. */
  requiresAttachmentReselection?: boolean;
  stagedAttachmentCount?: number;
  expectedAttachmentCount?: number;
  /** Canonical position of the persisted user message in this conversation. */
  messageSequence?: number;
}

/** A server-owned resource that is safe for the customer UI to render. */
export interface KnowledgeBaseApprovedResourceDto {
  kind: "logo" | "customer_upload";
  outputItemId: string | null;
  fileId: string | null;
  sameOriginUrl: string;
  filename: string;
  mimeType: string;
  sha256: string;
  sizeBytes: number;
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
  authoritativeTaskId: string | null;
  activeTurn: KnowledgeBaseActiveTurnDto | null;
  interaction: KnowledgeBaseInteractionDto;
  approvedPresentation: KnowledgeBaseApprovedPresentationDto | null;
  package: KnowledgeBasePackageDto | null;
  notice: KnowledgeBaseNoticeDto | null;
  conversationVersion: number | null;
}
