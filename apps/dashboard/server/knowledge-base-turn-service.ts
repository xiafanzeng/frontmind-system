import { createHash, createHmac, randomUUID } from "node:crypto";

import {
  and,
  asc,
  desc,
  eq,
  gt,
  inArray,
  isNotNull,
  isNull,
  lte,
  or,
  sql,
} from "drizzle-orm";

import {
  apiCredentials,
  conversations,
  conversationTurns,
  knowledgeBaseSnapshots,
  knowledgeBaseBuildNodes,
  knowledgeBaseBuilds,
  knowledgeBaseConversationRetentionTombstones,
  knowledgeBaseConversationTombstones,
  knowledgeBaseResetStates,
  localAssets,
  messages,
  providerFileLeases,
  upstreamResources,
  type ConversationTurn,
  type KnowledgeBaseBuild,
  type UpstreamResource,
} from "../drizzle/schema";
import type {
  KnowledgeBaseDispatchState,
  KnowledgeBaseFailureClass,
  KnowledgeBaseMaterializedResultFailureCode,
  KnowledgeBaseOperationType,
  KnowledgeBaseRecoveryAction,
  KnowledgeBaseTurnStatus,
} from "../shared/knowledge-base-progress";
import {
  isKnowledgeBaseMaterializedResultFailureCode,
  knowledgeBaseOperationTypes,
  KNOWLEDGE_BASE_MATERIALIZED_RESULT_RESET_MESSAGE,
} from "../shared/knowledge-base-progress";
import { AuthServiceError } from "./auth-service";
import {
  classifyProviderValidationCoordinate,
  safeProviderRequestReference,
} from "./provider-diagnostic-safety";
import {
  markKnowledgeBaseConversationAwaitingInputInTransaction,
  markKnowledgeBaseConversationFailedInTransaction,
  persistKnowledgeBaseUserMessageInTransaction,
} from "./knowledge-base-conversation-messages";
import { getDb } from "./db";
import type { KnowledgeBaseTreePolicyVersion } from "./knowledge-base-progress";
import {
  knowledgeBaseNewBuildPolicyBinding,
  KNOWLEDGE_BASE_MATERIALIZED_V5_SKILL_CONTENT_HASH,
} from "./knowledge-base-tree-policy-rollout";
import { normalizeKnowledgeBaseCustomerMarkdownImages } from "./knowledge-base-markdown-normalization";
import {
  canonicalKnowledgeBaseMarkdown,
  knowledgeBaseMarkdownSha256,
} from "./knowledge-base-package-validation";
import {
  persistKnowledgeBaseBuildSource,
  readKnowledgeBaseLocalSource,
} from "./knowledge-base-local-source-store";
import { readStoredPresalesFile } from "./presales-file-store";
import { knowledgeBaseLocalAssetIdentity } from "./knowledge-base-local-asset-upload";
import { readKnowledgeBasePinnedSkillArchiveAttachment } from "./knowledge-base-skill-runtime";
import {
  matchesAuthoritativeKnowledgeBaseMessageTuple,
  parsedKnowledgeBaseMessageMetadata,
} from "./knowledge-base-authoritative-message";
import {
  KNOWLEDGE_BASE_MATERIALIZED_CANDIDATE_STABILITY_MS,
  KNOWLEDGE_BASE_MATERIALIZED_COMPLETION_CONTRACT_VERSION,
  KNOWLEDGE_BASE_MATERIALIZED_COMPLETION_POLL_MS,
  KNOWLEDGE_BASE_MATERIALIZED_NATURAL_STOP_WINDOW_MS,
  KNOWLEDGE_BASE_MATERIALIZED_STOP_OUTCOME_UNKNOWN_WINDOW_MS,
  KNOWLEDGE_BASE_MATERIALIZED_STOP_SETTLE_WINDOW_MS,
} from "./knowledge-base-materialized-completion-contract";
import {
  canonicalizeKnowledgeBaseCompanyName,
  canonicalizeKnowledgeBaseWebsiteLines,
  KnowledgeBaseCompanyIdentityNormalizationError,
} from "./knowledge-base-company-identity";

/** Longer than every configured 120s upstream create/upload timeout. */
const DEFAULT_LEASE_MS = 300_000;
/** A stopped malformed result must settle or become explicit attention. */
const MANUS_V2_FORMAT_REPAIR_DEADLINE_MS = 120_000;
const MATERIALIZED_RESULT_READ_WINDOW_MS = 10 * 60_000;
const MATERIALIZED_RESULT_READ_BACKOFF_MS = [
  15_000, 30_000, 60_000, 120_000,
] as const;
/** Healthy reads without any machine-contract result must not run forever. */
const MATERIALIZED_RUNNING_PROGRESS_WINDOW_MS = 15 * 60_000;
// 99 customer uploads plus Skill, instructions and optional prefill input.
const MAX_ATTACHMENT_COUNT = 102;
const MAX_USER_ATTACHMENT_COUNT = 99;
const MAX_ATTACHMENT_ID_LENGTH = 512;
const MAX_RECOVERY_METADATA_DEPTH = 20;
const SECRET_KEY_PATTERN =
  /(?:^|[_-])(api[_-]?key|authorization|credential|password|secret|token)(?:$|[_-])/i;

export type KnowledgeBaseMaterializedResultRead = {
  firstObservedAt: string;
  attempt: number;
  nextRetryAt?: string;
  lastErrorKind?: string;
};

export type KnowledgeBaseMaterializedCompletionStopAttemptState =
  | "sending"
  | "acknowledged"
  | "outcome_unknown"
  | "rejected";

/**
 * Durable, migration-free result terminalization ledger. It contains only a
 * hash-addressed local candidate and bounded lifecycle timestamps; Provider
 * URLs, response text and raw request identifiers are deliberately absent.
 */
export type KnowledgeBaseMaterializedCompletionLedger = {
  schemaVersion: 1;
  lastStatus?: string;
  statusFirstObservedAt?: string;
  statusDeadlineAt?: string;
  listMessages404FirstObservedAt?: string;
  nextRetryAt?: string;
  /** Milliseconds observed in active running segments; pauses never reset it. */
  activeRunningMs?: number;
  /** Last observation used to advance the current running segment. */
  runningObservedAt?: string;
  candidateEventIdHash?: string;
  storageKey?: string;
  candidateArchiveSha256?: string;
  sizeBytes?: number;
  firstObservedAt?: string;
  lastObservedAt?: string;
  stableAt?: string;
  naturalStopDeadlineAt?: string;
  stopAttemptState?: KnowledgeBaseMaterializedCompletionStopAttemptState;
  stopAttemptedAt?: string;
  stopRequestRefHash?: string;
  stopSettleDeadlineAt?: string;
};

export type KnowledgeBaseMaterializedResultDiagnostic = {
  descriptorHash: string;
  archiveSha: string;
  resultProcessingStage:
    | "descriptor_search"
    | "download"
    | "archive_safety"
    | "manifest_parse"
    | "component_projection"
    | "canonical_validation"
    | "activation"
    | "presentation";
  firstTypedFailureCode?: string;
  deterministicFailure?: true;
  normalizationAttemptId: string;
  normalizationStartedAt: string;
  firstObservedAt: string;
  lastObservedAt: string;
};

/**
 * Migration-free, bounded result diagnostics. The containing turn already
 * binds the exact Provider task, so entries need only hash the descriptor and
 * downloaded bytes. URLs, file ids, response text and archive content are
 * deliberately absent.
 */
export type KnowledgeBaseMaterializedResultDiagnosticsLedger = {
  schemaVersion: 1;
  descriptorHash?: string;
  archiveSha?: string;
  resultProcessingStage?: KnowledgeBaseMaterializedResultDiagnostic["resultProcessingStage"];
  firstTypedFailureCode?: string;
  candidates: KnowledgeBaseMaterializedResultDiagnostic[];
};

type KnowledgeBaseTurnMetadata = Record<string, unknown> & {
  leaseOwnerHash?: string;
  attachmentsFrozen?: boolean;
  expectedAttachmentCount?: number;
  userAttachmentCount?: number;
  awaitingClientAttachments?: boolean;
  /** Reset epoch captured before a new start reservation is allowed to exist. */
  sourceResetRevision?: number;
  /** Safe tombstone for a browser upload rejected before any upstream POST. */
  unpreparedCancellation?: boolean;
  /** Safe tombstone for a generated-file failure proven to precede Provider dispatch. */
  localPreproviderRelease?: boolean;
  /** A customer-authorized generation cutover abandoned this rejected canonical send. */
  localCanonicalRehydrateAbandoned?: boolean;
  releasedOperationTombstone?: {
    schemaVersion: 1;
    kind: "failed_confirm_preprovider_release";
    operationKey: string;
    releasedAt: string;
  };
  localRehydrateRequired?: {
    schemaVersion: 1;
    reason: "generated_attachment_invalid_preprovider";
    buildId: string;
    generation: number;
    revision: number;
    leafId: string;
    presentationKey: string;
    sourceTurnId: string;
    releasedAt: string;
  };
  /** Safe tombstone for a manual Logo turn rejected after provider acknowledgement. */
  acknowledgedManualLogoCancellation?: boolean;
  /** Hash of the lease authority that committed the acknowledged cancellation. */
  acknowledgedManualLogoCancellationAuthorityHash?: string;
  /** Safe tombstone for a manual Logo turn rejected before any task id existed. */
  unacknowledgedManualLogoCancellation?: boolean;
  /** Hash of the lease authority that committed the pre-ack cancellation. */
  unacknowledgedManualLogoCancellationAuthorityHash?: string;
  cancelledOperationKey?: string;
  /** The former browser reservation was atomically adopted by upload-first. */
  legacyUploadFirstTakeover?: boolean;
  clientAttachmentManifestHash?: string;
  /** Hash of the browser-visible intent, excluding mutable server derivations. */
  clientIntentHash?: string;
  /** Presentation the customer actually saw before creating this operation. */
  expectedPresentationKey?: string;
  clientStagedAttachments?: Array<{
    index: number;
    file_id: string;
    filename: string;
    /** Exact server-proved managed intent which produced this file receipt. */
    managedIntentId?: string;
    itemId?: string;
    mimeType?: string;
    sizeBytes?: number;
    contentSha256?: string;
    localStorageKey?: string;
  }>;
  recovery?: Record<string, unknown>;
  dispatchingAt?: string;
  outcomeUnknownAt?: string;
  outcomeUnknownCode?: string;
  /** Durable at-most-once authority for the undocumented provider create API. */
  createAttemptState?: KnowledgeBaseCreateAttemptState;
  createAttemptUpdatedAt?: string;
  traceId?: string;
  /**
   * Recovery cutover fence for reset-created materialized v5 operations.
   * Historical rows deliberately have no value and may only project
   * RESET_REQUIRED; they must never be upgraded in place or touch Provider.
   */
  materializedRecoveryContractVersion?: 1;
  /** Birth-only capability fence for bounded completion terminalization. */
  materializedCompletionContractVersion?: 2;
  providerReasonCategory?: string;
  providerRequestRef?: string;
  /** Safe provider validation coordinates; never response prose or payload. */
  providerField?: string;
  providerPath?: string;
  providerRequestShape?: {
    promptUtf8Bytes: number;
    titleUtf8Bytes?: number;
    attachmentCount: number;
    agentProfile?: string | null;
    hasAgentProfile: boolean;
    hasStructuredOutputSchema: boolean;
    structuredOutputSchemaUtf8Bytes?: number;
    structuredOutputSchemaSha256?: string | null;
    compatibilityMode: "standard" | "minimal_v2_create";
  };
  /** Manus v2 operation ledger. Stored here to avoid a duplicate side table. */
  providerProtocol?: "legacy_v1" | "manus_v2";
  providerMethod?: "task.create" | "task.sendMessage";
  providerAttemptState?:
    | "not_sent"
    | "sending"
    | "acknowledged"
    | "rejected"
    | "outcome_unknown"
    | "output_pending"
    | "accepted"
    | "result_rejected";
  /** Bounded, lease-fenced reads of one terminal materialized task result. */
  materializedResultRead?: KnowledgeBaseMaterializedResultRead;
  /** Bounded, lease-fenced running-result candidate and task.stop ledger. */
  materializedCompletion?: KnowledgeBaseMaterializedCompletionLedger;
  /** Bounded hash-only archive normalization diagnostics and replay fence. */
  materializedResultDiagnostics?: KnowledgeBaseMaterializedResultDiagnosticsLedger;
  operationToken?: string;
  frozenProviderRequestHash?: string;
  /**
   * Explicit, provider-declared rejections of this exact frozen v2 request.
   * This never counts transport loss or a malformed/ambiguous response.
   */
  providerRejectionCount?: number;
  baselineEventId?: string;
  lastSeenEventIds?: string[];
  manusRequestId?: string;
  /** Exact provider event that proved the hidden legacy handoff was accepted. */
  anchorAcknowledgement?: {
    eventId: string;
    schemaVersion: 1;
    operationToken: string;
    turnId: string;
    generation: number;
    baseRevision: number;
    handoffAccepted: true;
  };
  /** Provider wait/repair side effects, all fenced by the current turn lease. */
  manusV2Lifecycle?: {
    waitingEventId?: string;
    waitingEventType?: string;
    waitingStatusEventId?: string;
    waitingAction?: "ask_user_continue" | "confirm_safe" | "attention_required";
    waitingAttemptState?: "sending" | "acknowledged" | "outcome_unknown";
    waitingRequestHash?: string;
    waitingRequestId?: string;
    waitingContinuationToken?: string;
    attentionCode?: string;
    formatRepairAttempt?: 1;
    formatRepairToken?: string;
    formatRepairRequestHash?: string;
    formatRepairAttemptState?: "sending" | "acknowledged" | "outcome_unknown";
    formatRepairRequestId?: string;
    formatRepairStartedAt?: string;
    formatRepairDeadlineAt?: string;
    errorRecoveryAttempt?: 1;
    errorRecoveryToken?: string;
    errorRecoveryRequestHash?: string;
    errorRecoveryAttemptState?:
      | "sending"
      | "acknowledged"
      | "outcome_unknown"
      | "retry_wait"
      | "rejected";
    errorRecoveryRequestId?: string;
    errorRecoveryAcknowledgedAt?: string;
    errorRecoveryRejectionCount?: number;
    errorRecoveryNextRetryAt?: string;
  };
  terminalAnchorObservation?: {
    schemaVersion: 1;
    terminalEventHash: string;
    firstObservedAt: string;
    lastObservedAt: string;
    taskId: string;
    generation: number;
    revision: number;
    leafId: string | null;
    operationToken: string;
    recoveryToken: string;
    recoveryRequestId: string;
  };
  localSettlement?: {
    schemaVersion: 1;
    kind: "terminal_anchor_without_ack";
    settledAt: string;
    snapshotSha256: string;
    presentationKey: string;
    terminalEventHash: string;
    recoveryRequestIdSha256: string;
  };
  supersedesTurnId?: string;
  supersededByTurnId?: string;
  repairKind?: string;
  preparedDispatch?: KnowledgeBasePreparedDispatch;
  dispatchState?: KnowledgeBaseDispatchState;
  failureClass?: KnowledgeBaseFailureClass | null;
  recoveryAction?: KnowledgeBaseRecoveryAction | null;
  canRegenerate?: boolean;
  /** Public lifecycle stage for a terminal failure before task.create. */
  failureStage?:
    | "local_upload"
    | "provider_file_registration"
    | "task_create"
    | "result_processing";
  /** Safe typed cause retained behind the public RESET_REQUIRED code. */
  preCreateFailureCauseCode?: string;
  attachmentRepair?: {
    clientRequestId: string;
    requestHash: string;
    sourceErrorCode: string | null;
    replacedAt: string;
  };
  generatedAttachmentReservations?: Record<
    string,
    KnowledgeBaseGeneratedAttachmentReservation
  >;
  /**
   * Manus v2 files are operation-local capabilities derived from immutable
   * Dashboard bytes. A mapping may be recorded item-by-item, but the turn's
   * attachment ledger is replaced only after every ordered item is ready.
   */
  manusV2AttachmentMappings?: Record<
    string,
    KnowledgeBaseManusV2AttachmentMapping
  >;
  /**
   * Crash-safe provider file lifecycle. `creating` is committed before the
   * side-effecting file.upload POST; the provider id is committed before PUT.
   * Attempts never enter the task attachment ledger themselves.
   */
  manusV2AttachmentAttempts?: Record<
    string,
    KnowledgeBaseManusV2AttachmentAttempt
  >;
  /**
   * A v2 file record/PUT may already exist even though its acknowledgement was
   * lost. Freeze that ambiguity per source slot so recovery never manufactures
   * another provider file. This is build-local attention; source bytes remain
   * durable and accepted content remains readable.
   */
  manusV2AttachmentUnknownAttempts?: Record<
    string,
    KnowledgeBaseManusV2AttachmentUnknownAttempt
  >;
};

export type KnowledgeBaseExplicitRecoveryAction =
  | "retry_compatible_create"
  | "create_new_canonical_from_snapshot"
  | "stopped";

export type KnowledgeBaseExplicitRecoveryCoordinate = {
  schemaVersion: 1;
  action: KnowledgeBaseExplicitRecoveryAction;
  sourceTurnId: string;
  sourceGeneration: number;
  sourceStateEpoch: number;
  sourceRevision: number;
  sourceLeafId: string | null;
  sourcePresentationKey: string | null;
  sourceCredentialIdSha256: string | null;
  recoveryStateSha256: string;
  normalizedAt: string;
};

export type KnowledgeBaseGeneratedAttachmentRole =
  | "skill"
  | "prefill"
  | "instructions"
  | "working_set"
  | "finalization";

export interface KnowledgeBaseGeneratedAttachmentReservation {
  schemaVersion: 1;
  role: KnowledgeBaseGeneratedAttachmentRole;
  attachmentIndex: number;
  requestHash: string;
  idempotencyKeyHash: string;
  filename: string;
  mimeType: string;
  sizeBytes: number;
  contentSha256: string;
  /** Dashboard-owned immutable bytes; never a provider URL or file id. */
  localStorageKey?: string;
  /**
   * `candidate_created` is intentionally not part of the task attachment
   * ledger. Only `ready` files have passed provider readiness/content proof.
   * `completed` remains readable for historical rows.
   */
  status: "reserved" | "candidate_created" | "ready" | "completed";
  upstreamFileId?: string;
  reservedAt: string;
  candidateCreatedAt?: string;
  readyAt?: string;
  completedAt?: string;
  replacementCount?: number;
}

export type KnowledgeBaseManusV2ProviderMimeDisposition =
  | "exact"
  | "generic"
  | "missing"
  | "invalid"
  | "different";

export interface KnowledgeBaseManusV2AttachmentMimeEvidence {
  expectedContentType: string;
  providerContentType: string | null;
  disposition: KnowledgeBaseManusV2ProviderMimeDisposition;
  observedAt: string;
}

export interface KnowledgeBaseManusV2AttachmentMapping {
  schemaVersion: 1;
  providerProtocol: "manus_v2";
  /** g{buildGeneration}:{attachmentIndex}:{sha256}:{sizeBytes} */
  mappingKey: string;
  buildGeneration: number;
  attachmentIndex: number;
  sourceFileId: string;
  localStorageKey: string;
  contentSha256: string;
  sizeBytes: number;
  filename: string;
  mimeType: string;
  upstreamFileId: string;
  status: "ready";
  expiresAt: number;
  providerGeneration: number;
  verifiedAt: string;
  /** Provider MIME is diagnostic; canonical MIME remains `mimeType`. */
  mimeEvidence?: KnowledgeBaseManusV2AttachmentMimeEvidence;
}

export type KnowledgeBaseManusV2AttachmentAttemptState =
  | "creating"
  | "create_retry_wait"
  | "create_rejected"
  | "create_outcome_unknown"
  | "candidate_created"
  | "put_sending"
  | "put_retry_wait"
  | "put_accepted"
  | "put_outcome_unknown"
  | "unusable";

export interface KnowledgeBaseManusV2AttachmentAttempt {
  schemaVersion: 1;
  mappingKey: string;
  buildGeneration: number;
  attachmentIndex: number;
  sourceFileId: string;
  localStorageKey: string;
  contentSha256: string;
  sizeBytes: number;
  filename: string;
  mimeType: string;
  providerGeneration: number;
  state: KnowledgeBaseManusV2AttachmentAttemptState;
  upstreamFileId: string | null;
  /** Provider epoch seconds. */
  uploadExpiresAt: number | null;
  /**
   * AES-GCM sealed signed PUT capability. It is never returned by an API or
   * written to logs; authenticated data binds it to this exact turn, slot,
   * provider generation and file id.
   */
  uploadCapability?: {
    schemaVersion: 1;
    encryptionVersion: 1;
    ciphertext: string;
    iv: string;
    authTag: string;
  } | null;
  code: string | null;
  rejectionCount?: number;
  nextRetryAt?: string | null;
  /** Present only when a monotonic lifecycle transition observed MIME. */
  mimeEvidence?: KnowledgeBaseManusV2AttachmentMimeEvidence;
  recordedAt: string;
}

export interface KnowledgeBaseManusV2AttachmentUnknownAttempt {
  schemaVersion: 1;
  mappingKey: string;
  buildGeneration: number;
  attachmentIndex: number;
  sourceFileId: string;
  localStorageKey: string;
  contentSha256: string;
  sizeBytes: number;
  filename: string;
  mimeType: string;
  providerGeneration: number;
  state: "outcome_unknown";
  code: string;
  recordedAt: string;
}

export interface KnowledgeBaseGeneratedAttachmentClaim {
  state: "reserved" | "candidate_created" | "ready" | "completed";
  idempotencyKey: string;
  requestHash: string;
  upstreamFileId: string | null;
}

export type KnowledgeBaseCreateAttemptState =
  | "not_sent"
  | "sending"
  | "acknowledged"
  | "rejected"
  | "unknown";

export interface KnowledgeBasePreparedDispatch {
  /** Schema 1 bodies retain deprecated taskMode for exact replay compatibility. */
  schemaVersion: 1 | 2;
  baseUrl: string;
  requestBody: {
    prompt: string;
    agentProfile: string;
    taskMode?: "agent";
    attachments: Array<{ file_id: string; filename: string }>;
    taskId?: string;
  };
  bodySha256: string;
  preparedAt: string;
}

export type KnowledgeBaseTurnReservationErrorCode =
  | "INVALID_REQUEST"
  | "BUILD_NOT_FOUND"
  | "CONVERSATION_RESET"
  | "RESET_REQUIRED"
  | "KNOWLEDGE_BASE_RESET_REVISION_CHANGED"
  | "CONFLICT"
  | "STALE_KNOWLEDGE_BASE_PRESENTATION"
  | "KNOWLEDGE_BASE_REQUEST_REPLAY_MISMATCH"
  | "KNOWLEDGE_BASE_LOGO_UPLOAD_INVALID"
  | "KNOWLEDGE_BASE_LOGO_UPLOAD_CONFLICT"
  | "IDEMPOTENCY_PENDING"
  | "RESERVATION_NOT_FOUND"
  | "LEASE_LOST"
  | "TERMINAL";

export class KnowledgeBaseTurnReservationError extends Error {
  constructor(
    public readonly code: KnowledgeBaseTurnReservationErrorCode,
    message: string,
    public readonly retryAfterMs?: number,
  ) {
    super(message);
    this.name = "KnowledgeBaseTurnReservationError";
  }
}

export interface KnowledgeBaseTurnIdentity {
  buildId: string;
  buildGeneration: number;
  operationKey: string;
  operationType: KnowledgeBaseOperationType;
  expectedRevision: number;
  expectedLeafId: string | null;
  requestHash: string;
  apiCredentialId: string | null;
}

export interface KnowledgeBaseTurnRecord {
  id: string;
  userId: number;
  conversationId: string;
  clientRequestId: string;
  apiCredentialId: string | null;
  buildId: string;
  buildGeneration: number;
  operationKey: string;
  operationType: KnowledgeBaseOperationType;
  expectedRevision: number;
  expectedLeafId: string | null;
  requestHash: string;
  status: KnowledgeBaseTurnStatus;
  upstreamTaskId: string | null;
  dispatchState: KnowledgeBaseDispatchState;
  failureClass: KnowledgeBaseFailureClass | null;
  recoveryAction: KnowledgeBaseRecoveryAction | null;
  canRegenerate: boolean;
  createAttemptState?: KnowledgeBaseCreateAttemptState;
  traceId?: string | null;
  materializedRecoveryContractVersion: 1 | null;
  materializedCompletionContractVersion: 2 | null;
  providerProtocol: "legacy_v1" | "manus_v2";
  providerMethod: "task.create" | "task.sendMessage" | null;
  providerAttemptState: string | null;
  materializedResultRead?: KnowledgeBaseMaterializedResultRead | null;
  materializedCompletion?: KnowledgeBaseMaterializedCompletionLedger | null;
  materializedResultDiagnostics?: KnowledgeBaseMaterializedResultDiagnosticsLedger | null;
  operationToken: string;
  manusV2Lifecycle: NonNullable<KnowledgeBaseTurnMetadata["manusV2Lifecycle"]>;
  attachmentFileIds: string[];
  attachmentsFrozen: boolean;
  awaitingClientAttachments: boolean;
  /** Reset epoch frozen when a browser-backed start/revise batch was reserved. */
  sourceResetRevision?: number;
  expectedUserAttachmentCount: number;
  stagedUserAttachmentCount: number;
  generatedAttachmentReservations: Record<
    string,
    KnowledgeBaseGeneratedAttachmentReservation
  >;
  manusV2AttachmentMappings: Record<
    string,
    KnowledgeBaseManusV2AttachmentMapping
  >;
  manusV2AttachmentAttempts: Record<
    string,
    KnowledgeBaseManusV2AttachmentAttempt
  >;
  manusV2AttachmentUnknownAttempts: Record<
    string,
    KnowledgeBaseManusV2AttachmentUnknownAttempt
  >;
  leaseExpiresAt: Date | null;
  startedAt: Date | null;
  completedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export type KnowledgeBaseTurnReservation =
  | {
      state: "acquired";
      turn: KnowledgeBaseTurnRecord;
      leaseToken: string;
      leaseExpiresAt: Date;
      upstreamIdempotencyKey: string;
      /** Present when legacy takeover canonicalized durable recovery data. */
      recoveryMetadata?: Record<string, unknown>;
    }
  | {
      state: "awaiting_attachments";
      turn: KnowledgeBaseTurnRecord;
    }
  | {
      state: "pending";
      turn: KnowledgeBaseTurnRecord;
      retryAfterMs: number;
    }
  | {
      state: "bound";
      turn: KnowledgeBaseTurnRecord;
      upstreamTaskId: string;
    }
  | {
      state: "completed";
      turn: KnowledgeBaseTurnRecord;
      upstreamTaskId: string | null;
    }
  | {
      state: "terminal";
      turn: KnowledgeBaseTurnRecord;
    };

export interface ReserveKnowledgeBaseTurnInput {
  userId: number;
  buildId: string;
  clientRequestId: string;
  operationType: KnowledgeBaseOperationType;
  expectedGeneration: number;
  expectedRevision: number;
  expectedLeafId: string | null;
  /**
   * Immutable identity of the approved presentation being answered. Optional
   * only for pre-rollout callers and non-presentation maintenance operations.
   */
  expectedPresentationKey?: string;
  /**
   * The exact logical request, excluding credentials. It is hashed and never
   * persisted verbatim. Array order is significant.
   */
  requestPayload: unknown;
  /**
   * Browser-visible request identity used by route-level replay detection.
   * It deliberately excludes current task, credential, Logo gate and Skill
   * selection because those values can change after the turn commits.
   */
  clientIntent?: unknown;
  /**
   * Distinguishes repeated externally acknowledged attempts at one coordinate.
   * Manual Logo submissions use clientRequestId so replacement bytes never
   * reuse a provider idempotency key from a rejected Logo task.
   */
  operationInstanceId?: string;
  apiCredentialId?: string | null;
  userText?: string;
  /** Customer-supplied files only; excludes generated Skill/prefill files. */
  userAttachmentCount?: number;
  expectedAttachmentCount?: number;
  /** Pass only when every upstream file id is already known. */
  attachmentFileIds?: readonly string[];
  /**
   * Minimal replay data for the recovery worker. Secret-shaped keys are
   * recursively removed before persistence.
   */
  recoveryMetadata?: Record<string, unknown>;
  /**
   * Two-phase browser flow: commit the logical turn before the browser uploads
   * customer files. The manifest is hashed into both the request identity and
   * durable metadata; no worker lease is granted until those files are bound.
   */
  deferDispatchUntilAttachments?: boolean;
  clientAttachmentManifest?: unknown;
  /** Required for every browser-backed materialized start/revise reservation. */
  sourceResetRevision?: number;
  /** Resume after browser File objects were lost; original body remains pinned. */
  resumeDeferredReservation?: boolean;
  /**
   * Adopt a pre-rollout awaitingClientAttachments row after the replacement
   * bytes have completed their normal signed PUT.
   */
  resumeLegacyAttachmentTakeover?: boolean;
  /** Required for retry reservations; identifies the failed active turn. */
  replacesTurnId?: string | null;
  now?: Date;
  leaseMs?: number;
}

export interface ReserveKnowledgeBaseStartBuildInput {
  userId: number;
  conversationId: string;
  clientRequestId: string;
  companyName: string;
  companyWebsite?: string;
  skillName: string;
  skillVersion: string;
  skillContentHash?: string | null;
  skillArchiveSha256?: string | null;
  skillArchiveBytes?: number | null;
  skillArchiveStorageKey?: string | null;
  /** Policy selected together with the immutable Skill before `/start`. */
  treePolicyVersion?: KnowledgeBaseTreePolicyVersion;
  apiCredentialId?: string | null;
  userText?: string;
  userAttachmentCount?: number;
  expectedAttachmentCount: number;
  /**
   * Start-specific intent. Build-owned identity and Skill fields are replaced
   * with the values committed in the same transaction before hashing.
   */
  requestPayload: Record<string, unknown>;
  recoveryMetadata: Record<string, unknown>;
  /**
   * Account-owned active snapshot selected by the start API for optional
   * prefill. SiteOps task lineage does not constrain knowledge-base reuse.
   */
  prefillSnapshotId?: string | null;
  /**
   * Start-before-upload flow. The build and logical start turn are committed
   * before any browser bytes or provider resources exist. The ordered browser
   * manifest is the immutable identity later used by attachment stage and
   * dispatch.
   */
  deferDispatchUntilAttachments?: boolean;
  clientAttachmentManifest?: unknown;
  /** Browser-observed reset epoch. A stale tab may not cross this fence. */
  expectedResetRevision: number;
  now?: Date;
  leaseMs?: number;
}

export interface KnowledgeBaseStartBuildReservation {
  build: KnowledgeBaseBuild;
  createdBuild: boolean;
  reservation: KnowledgeBaseTurnReservation;
}

export interface KnowledgeBaseRecoveryCandidate {
  turnId: string;
  userId: number;
  buildId: string;
  buildGeneration: number;
  leaseExpiresAt: Date | null;
}

export interface KnowledgeBaseRecoveryClaim {
  turn: KnowledgeBaseTurnRecord;
  leaseToken: string;
  leaseExpiresAt: Date;
  upstreamIdempotencyKey: string;
  recoveryMetadata: Record<string, unknown>;
  preparedDispatch: KnowledgeBasePreparedDispatch | null;
}

export type KnowledgeBaseDeferredDispatchClaim =
  | ({ state: "acquired" } & KnowledgeBaseRecoveryClaim)
  | Exclude<KnowledgeBaseTurnReservation, { state: "acquired" }>;

export type KnowledgeBaseTurnReplayReceipt = Exclude<
  KnowledgeBaseTurnReservation,
  { state: "acquired" }
>;

export interface InspectKnowledgeBaseTurnReplayInput {
  userId: number;
  /** Public Dashboard conversation id. */
  conversationId: string;
  clientRequestId: string;
  /** Browser-visible intent only; see ReserveKnowledgeBaseTurnInput. */
  clientIntent: unknown;
  /** Optional fallback coordinates for a remounted tab with a new request id. */
  expectedGeneration?: number;
  expectedRevision?: number;
  expectedLeafId?: string | null;
  now?: Date;
}

export interface InspectKnowledgeBaseLegacyStartReplayInput {
  userId: number;
  /** Public Dashboard conversation id. */
  conversationId: string;
  clientRequestId: string;
  /** Enterprise identity already resolved from the current workspace. */
  companyName: string;
  companyWebsite: string;
  operatorNotes: string;
  attachments: ReadonlyArray<{ file_id: string; filename: string }>;
  now?: Date;
}

export interface InspectKnowledgeBaseDeferredAttachmentReplayInput {
  userId: number;
  /** Public Dashboard conversation id. */
  conversationId: string;
  turnId: string;
  clientRequestId: string;
  clientAttachmentManifest: unknown;
  expectedResetRevision: number;
  index: number;
  attachment: { file_id: string; filename: string };
  now?: Date;
}

export interface InspectKnowledgeBaseDeferredDispatchReplayInput {
  userId: number;
  /** Public Dashboard conversation id. */
  conversationId: string;
  turnId: string;
  clientRequestId: string;
  clientAttachmentManifest: unknown;
  expectedResetRevision: number;
  now?: Date;
}

export interface InspectKnowledgeBaseLegacyDeferredReservationReplayInput {
  userId: number;
  /** Public Dashboard conversation id. */
  conversationId: string;
  clientRequestId: string;
  clientAttachmentManifest: unknown;
  operationType: KnowledgeBaseOperationType;
  expectedGeneration: number;
  expectedRevision: number;
  expectedLeafId: string | null;
  expectedPresentationKey?: string;
  now?: Date;
}

export interface InspectKnowledgeBaseLegacyAttachmentTakeoverReplayInput {
  userId: number;
  /** Public Dashboard conversation id. */
  conversationId: string;
  clientRequestId: string;
  clientAttachmentManifest: unknown;
  attachments: ReadonlyArray<{ file_id: string; filename: string }>;
  operationType: KnowledgeBaseOperationType;
  expectedGeneration: number;
  expectedRevision: number;
  expectedLeafId: string | null;
  expectedPresentationKey?: string;
  now?: Date;
}

type ReservationReplayDecision =
  | { state: "conflict" }
  | { state: "pending"; retryAfterMs: number }
  | { state: "bound"; upstreamTaskId: string }
  | { state: "completed" }
  | { state: "terminal" }
  | { state: "expired" };

async function requireDb() {
  const db = await getDb();
  if (!db) {
    throw new AuthServiceError(
      "DATABASE_UNAVAILABLE",
      "Database is not configured",
    );
  }
  return db;
}

/**
 * Resolve and, for historical rows, atomically backfill the build's durable
 * physical Skill pin before any provider file/task side effect is allowed.
 */
export async function ensureKnowledgeBaseBuildSkillArchivePin(
  input: {
    userId: number;
    buildId: string;
    generation: number;
  },
  executor?: any,
) {
  assertInteger(input.userId, "userId", 1);
  assertInteger(input.generation, "generation", 1);
  const buildId = normalizeRequiredId(input.buildId, "buildId", 36);
  const db = executor ?? (await requireDb());
  return db.transaction(async (tx: any) => {
    const build = (
      await tx
        .select()
        .from(knowledgeBaseBuilds)
        .where(
          and(
            eq(knowledgeBaseBuilds.id, buildId),
            eq(knowledgeBaseBuilds.userId, input.userId),
          ),
        )
        .limit(1)
        .for("update")
    )[0] as KnowledgeBaseBuild | undefined;
    if (!build || build.generation !== input.generation) {
      throw new KnowledgeBaseTurnReservationError(
        "CONFLICT",
        "Knowledge-base build identity changed before Skill pin verification",
      );
    }
    const archive = await readKnowledgeBasePinnedSkillArchiveAttachment({
      version: String(build.skillVersion || "4"),
      contentHash: build.skillContentHash || undefined,
      physicalSha256: build.skillArchiveSha256,
      archiveBytes: build.skillArchiveBytes,
      storageKey: build.skillArchiveStorageKey,
    });
    if (
      build.skillArchiveSha256 !== archive.physicalSha256 ||
      build.skillArchiveBytes !== archive.archiveBytes ||
      build.skillArchiveStorageKey !== archive.storageKey
    ) {
      await tx
        .update(knowledgeBaseBuilds)
        .set({
          skillArchiveSha256: archive.physicalSha256,
          skillArchiveBytes: archive.archiveBytes,
          skillArchiveStorageKey: archive.storageKey,
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(knowledgeBaseBuilds.id, build.id),
            eq(knowledgeBaseBuilds.userId, input.userId),
            eq(knowledgeBaseBuilds.generation, input.generation),
          ),
        );
    }
    return archive;
  });
}

function assertInteger(value: number, name: string, minimum: number) {
  if (!Number.isInteger(value) || value < minimum) {
    throw new KnowledgeBaseTurnReservationError(
      "INVALID_REQUEST",
      `${name} is invalid`,
    );
  }
}

function normalizeRequiredId(value: string, name: string, maxLength: number) {
  const normalized = String(value || "").trim();
  if (!normalized || normalized.length > maxLength) {
    throw new KnowledgeBaseTurnReservationError(
      "INVALID_REQUEST",
      `${name} is invalid`,
    );
  }
  return normalized;
}

function normalizeOptionalLeafId(value: string | null) {
  if (value === null) return null;
  return normalizeRequiredId(value, "expectedLeafId", 191);
}

function normalizeAttachmentFileIds(values: readonly string[]) {
  if (values.length > MAX_ATTACHMENT_COUNT) {
    throw new KnowledgeBaseTurnReservationError(
      "INVALID_REQUEST",
      `Too many attachment file ids (maximum ${MAX_ATTACHMENT_COUNT})`,
    );
  }
  const normalized = values.map((value) =>
    normalizeRequiredId(value, "attachmentFileId", MAX_ATTACHMENT_ID_LENGTH),
  );
  if (new Set(normalized).size !== normalized.length) {
    throw new KnowledgeBaseTurnReservationError(
      "INVALID_REQUEST",
      "Attachment file ids must be unique",
    );
  }
  return normalized;
}

function canonicalJson(
  value: unknown,
  seen: WeakSet<object> = new WeakSet<object>(),
): string {
  if (value === null) return "null";
  if (typeof value === "string" || typeof value === "boolean") {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new KnowledgeBaseTurnReservationError(
        "INVALID_REQUEST",
        "Request payload contains a non-finite number",
      );
    }
    return JSON.stringify(value);
  }
  if (value instanceof Date) return JSON.stringify(value.toISOString());
  if (typeof value !== "object") {
    throw new KnowledgeBaseTurnReservationError(
      "INVALID_REQUEST",
      "Request payload must be JSON-compatible",
    );
  }
  if (seen.has(value)) {
    throw new KnowledgeBaseTurnReservationError(
      "INVALID_REQUEST",
      "Request payload must not contain circular references",
    );
  }
  seen.add(value);
  try {
    if (Array.isArray(value)) {
      return `[${value.map((item) => canonicalJson(item, seen)).join(",")}]`;
    }
    const record = value as Record<string, unknown>;
    const entries = Object.keys(record)
      .filter((key) => record[key] !== undefined)
      .sort()
      .map(
        (key) => `${JSON.stringify(key)}:${canonicalJson(record[key], seen)}`,
      );
    return `{${entries.join(",")}}`;
  } finally {
    seen.delete(value);
  }
}

function sha256(value: string) {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

export function hashKnowledgeBaseTurnRequest(payload: unknown) {
  return sha256(canonicalJson(payload));
}

/**
 * A logical slot deliberately excludes clientRequestId, customer action and
 * body. Consequently two tabs racing confirm vs revise for the same node
 * collide on one row; requestHash then decides whether the loser is a replay
 * or conflict. A retry is keyed by the failed turn it replaces: concurrent
 * clicks coalesce, while a later failed retry produces a genuinely new slot.
 */
export function createKnowledgeBaseOperationKey(input: {
  buildId: string;
  buildGeneration: number;
  operationType: KnowledgeBaseOperationType;
  expectedRevision: number;
  expectedLeafId: string | null;
  retryOfTurnId?: string | null;
  operationInstanceId?: string;
}) {
  const phase =
    input.operationType === "start"
      ? "start"
      : input.operationType === "retry"
        ? "retry"
        : input.operationType === "legacy_reconcile"
          ? "legacy-reconcile"
          : "turn";
  const digest = hashKnowledgeBaseTurnRequest({
    protocol: "frontmind.knowledge-base.operation.v2",
    buildId: normalizeRequiredId(input.buildId, "buildId", 36),
    generation: input.buildGeneration,
    phase,
    revision: input.expectedRevision,
    leafId: input.expectedLeafId,
    ...(input.operationInstanceId
      ? {
          instanceId: normalizeRequiredId(
            input.operationInstanceId,
            "operationInstanceId",
            128,
          ),
        }
      : {}),
    ...(input.operationType === "retry"
      ? {
          retryOfTurnId: normalizeRequiredId(
            input.retryOfTurnId || "",
            "retryOfTurnId",
            36,
          ),
        }
      : {}),
  });
  return `kbv2_${digest}`;
}

export function createKnowledgeBaseUpstreamIdempotencyKey(
  operationKey: string,
) {
  return `frontmind-kb-v2:${normalizeRequiredId(operationKey, "operationKey", 128)}`;
}

export function hashKnowledgeBaseUpstreamIdempotencyKey(
  idempotencyKey: string,
) {
  return sha256(idempotencyKey);
}

export function createKnowledgeBaseGeneratedAttachmentIdempotencyKey(input: {
  operationKey: string;
  role: KnowledgeBaseGeneratedAttachmentRole;
  attachmentIndex: number;
  requestHash: string;
  replacementCount?: number;
}) {
  assertInteger(input.attachmentIndex, "attachmentIndex", 0);
  if (!/^[a-f0-9]{64}$/u.test(input.requestHash)) {
    throw new KnowledgeBaseTurnReservationError(
      "INVALID_REQUEST",
      "Generated attachment request hash is invalid",
    );
  }
  const digest = hashKnowledgeBaseTurnRequest({
    protocol: "frontmind.knowledge-base.generated-attachment.v1",
    operationKey: normalizeRequiredId(input.operationKey, "operationKey", 128),
    role: input.role,
    attachmentIndex: input.attachmentIndex,
    requestHash: input.requestHash,
    replacementCount: input.replacementCount ?? 0,
  });
  return `frontmind-kb-file-v1:${digest}`;
}

function generatedAttachmentSlot(
  role: KnowledgeBaseGeneratedAttachmentRole,
  attachmentIndex: number,
) {
  return `${role}:${attachmentIndex}`;
}

function normalizeGeneratedAttachmentInput(input: {
  role: KnowledgeBaseGeneratedAttachmentRole;
  attachmentIndex: number;
  filename: string;
  mimeType: string;
  sizeBytes: number;
  contentSha256: string;
  localStorageKey?: string;
}) {
  if (
    input.role !== "skill" &&
    input.role !== "prefill" &&
    input.role !== "instructions" &&
    input.role !== "working_set" &&
    input.role !== "finalization"
  ) {
    throw new KnowledgeBaseTurnReservationError(
      "INVALID_REQUEST",
      "Generated attachment role is invalid",
    );
  }
  assertInteger(input.attachmentIndex, "attachmentIndex", 0);
  const filename = normalizeRequiredId(
    String(input.filename || "").replace(/[\\/\0]/gu, "_"),
    "generated attachment filename",
    512,
  );
  const mimeType = normalizeRequiredId(
    String(input.mimeType || "application/octet-stream")
      .replace(/[\r\n]/gu, "")
      .trim(),
    "generated attachment mime type",
    255,
  );
  assertInteger(input.sizeBytes, "generated attachment size", 1);
  if (!/^[a-f0-9]{64}$/u.test(input.contentSha256)) {
    throw new KnowledgeBaseTurnReservationError(
      "INVALID_REQUEST",
      "Generated attachment content hash is invalid",
    );
  }
  const localStorageKey = input.localStorageKey
    ? normalizeRequiredId(input.localStorageKey, "localStorageKey", 1_024)
    : undefined;
  if (
    localStorageKey &&
    (localStorageKey.startsWith("/") ||
      localStorageKey.includes("\\") ||
      localStorageKey
        .split("/")
        .some((part) => !part || part === "." || part === ".."))
  ) {
    throw new KnowledgeBaseTurnReservationError(
      "INVALID_REQUEST",
      "Generated attachment local storage key is invalid",
    );
  }
  const requestHash = hashKnowledgeBaseTurnRequest({
    protocol: "frontmind.knowledge-base.generated-attachment-request.v1",
    role: input.role,
    attachmentIndex: input.attachmentIndex,
    filename,
    mimeType,
    sizeBytes: input.sizeBytes,
    contentSha256: input.contentSha256,
  });
  return { ...input, filename, mimeType, localStorageKey, requestHash };
}

function generatedAttachmentReservations(
  metadata: KnowledgeBaseTurnMetadata,
): Record<string, KnowledgeBaseGeneratedAttachmentReservation> {
  const value = metadata.generatedAttachmentReservations;
  return value && typeof value === "object" && !Array.isArray(value)
    ? { ...value }
    : {};
}

function manusV2AttachmentMappings(
  metadata: KnowledgeBaseTurnMetadata,
): Record<string, KnowledgeBaseManusV2AttachmentMapping> {
  const value = metadata.manusV2AttachmentMappings;
  return value && typeof value === "object" && !Array.isArray(value)
    ? { ...value }
    : {};
}

function manusV2AttachmentAttempts(
  metadata: KnowledgeBaseTurnMetadata,
): Record<string, KnowledgeBaseManusV2AttachmentAttempt> {
  const value = metadata.manusV2AttachmentAttempts;
  return value && typeof value === "object" && !Array.isArray(value)
    ? { ...value }
    : {};
}

function manusV2AttachmentUnknownAttempts(
  metadata: KnowledgeBaseTurnMetadata,
): Record<string, KnowledgeBaseManusV2AttachmentUnknownAttempt> {
  const value = metadata.manusV2AttachmentUnknownAttempts;
  return value && typeof value === "object" && !Array.isArray(value)
    ? { ...value }
    : {};
}

function hasInlineEligibleGeneratedCreateRejection(
  metadata: KnowledgeBaseTurnMetadata,
) {
  const reservations = Object.values(generatedAttachmentReservations(metadata));
  const attempts = Object.values(manusV2AttachmentAttempts(metadata));
  const prepared = metadata.preparedDispatch as
    | KnowledgeBasePreparedDispatch
    | undefined;
  const matches = attempts.filter((attempt) => {
    const preparedSource =
      prepared?.requestBody.attachments[attempt.attachmentIndex];
    if (
      attempt.state !== "create_rejected" ||
      attempt.upstreamFileId !== null ||
      attempt.sizeBytes < 1 ||
      attempt.sizeBytes > 20 * 1024 * 1024 ||
      preparedSource?.file_id !== attempt.sourceFileId ||
      preparedSource.filename !== attempt.filename
    ) {
      return false;
    }
    const reservationMatches = reservations.filter(
      (reservation) =>
        (reservation.role === "skill" || reservation.role === "instructions") &&
        reservation.attachmentIndex === attempt.attachmentIndex &&
        reservation.filename === attempt.filename &&
        reservation.contentSha256 === attempt.contentSha256 &&
        reservation.sizeBytes === attempt.sizeBytes,
    );
    return reservationMatches.length === 1;
  });
  return matches.length === 1;
}

function retryAuthorityRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

export function knowledgeBaseMaterializedRecoveryContractVersion(build: {
  executionMode?: string | null;
  skillVersion?: string | null;
  providerProtocol?: string | null;
  contentVersion?: number | null;
  handoffProvenance?: unknown;
}) {
  if (
    build.executionMode !== "materialized_bundle_v1" ||
    build.skillVersion !== "5" ||
    build.providerProtocol !== "manus_v2" ||
    typeof build.contentVersion !== "number"
  ) {
    return null;
  }
  const provenance = retryAuthorityRecord(build.handoffProvenance);
  return provenance?.materializedRecoveryContractVersion === 1 ? 1 : null;
}

export function knowledgeBaseMaterializedCompletionContractVersion(build: {
  executionMode?: string | null;
  skillVersion?: string | null;
  providerProtocol?: string | null;
  contentVersion?: number | null;
  handoffProvenance?: unknown;
}) {
  if (
    build.executionMode !== "materialized_bundle_v1" ||
    build.skillVersion !== "5" ||
    build.providerProtocol !== "manus_v2" ||
    typeof build.contentVersion !== "number"
  ) {
    return null;
  }
  const provenance = retryAuthorityRecord(build.handoffProvenance);
  return provenance?.materializedCompletionContractVersion ===
    KNOWLEDGE_BASE_MATERIALIZED_COMPLETION_CONTRACT_VERSION
    ? KNOWLEDGE_BASE_MATERIALIZED_COMPLETION_CONTRACT_VERSION
    : null;
}

function retryAuthorityRequestPayload(input: {
  operationType: KnowledgeBaseOperationType;
  recovery: Record<string, unknown>;
}) {
  const { operationType, recovery } = input;
  if (operationType === "start") {
    if (!Array.isArray(recovery.attachments)) return null;
    return {
      companyName: recovery.companyName,
      companyWebsite: recovery.companyWebsite,
      operatorNotes: recovery.operatorNotes,
      attachments: recovery.attachments,
      skillVersion: recovery.skillVersion,
      skillContentHash: recovery.skillContentHash,
      prefillSnapshotId: recovery.prefillSnapshotId,
    };
  }
  if (
    operationType === "confirm" ||
    operationType === "direct_prefill" ||
    operationType === "revise"
  ) {
    if (recovery.deferredClientAttachments === true) {
      const clientAttachmentManifest = Array.isArray(
        recovery.clientAttachmentManifest,
      )
        ? recovery.clientAttachmentManifest
        : Array.isArray(recovery.attachmentManifest)
          ? recovery.attachmentManifest
          : null;
      if (!clientAttachmentManifest) return null;
      return {
        userMessage: recovery.userMessage,
        // `attachmentManifest` becomes the authoritative server-digest ledger
        // after staging. Request identity must remain bound to the exact client
        // manifest accepted by the original reservation.
        attachmentManifest: clientAttachmentManifest,
        skillVersion: recovery.skillVersion,
        skillContentHash: recovery.skillContentHash,
      };
    }
    if (!Array.isArray(recovery.attachments)) return null;
    return {
      userMessage: recovery.userMessage,
      attachments: recovery.attachments,
      skillVersion: recovery.skillVersion,
      skillContentHash: recovery.skillContentHash,
    };
  }
  if (operationType === "retry") {
    if (
      typeof recovery.retryOfTurnId !== "string" ||
      typeof recovery.originalRequestHash !== "string"
    ) {
      return null;
    }
    return {
      retryOfTurnId: recovery.retryOfTurnId,
      originalRequestHash: recovery.originalRequestHash,
    };
  }
  return null;
}

export type KnowledgeBaseRetryAuthority = {
  recovery: Record<string, unknown>;
  preparedDispatch: KnowledgeBasePreparedDispatch;
};

type KnowledgeBaseFailedTurnAuthorityPolicy =
  | "retry"
  | "terminal_rejected"
  | "legacy_protocol_terminal"
  | "legacy_failed_not_sent_handoff";

function isDeterministicTaskCreateRejectionCode(value: unknown) {
  const code = String(value || "");
  if (/^UPSTREAM_CREATE_[0-9]{1,6}$/u.test(code)) return true;
  const statusMatch = /^UPSTREAM_CREATE_HTTP_(4[0-9]{2})$/u.exec(code);
  if (!statusMatch) return false;
  const status = Number(statusMatch[1]);
  return status !== 408 && status !== 425 && status !== 429;
}

function isLegacyProtocolFailureObservation(
  value: unknown,
  completedAt: Date | null,
  dispatchingAt: unknown,
) {
  const observation = retryAuthorityRecord(value);
  if (!observation || !(completedAt instanceof Date)) return false;
  if (
    typeof dispatchingAt !== "string" ||
    typeof observation.observationKeyHash !== "string" ||
    typeof observation.count !== "number" ||
    !Number.isSafeInteger(observation.count) ||
    typeof observation.firstObservedAt !== "string" ||
    typeof observation.lastObservedAt !== "string"
  ) {
    return false;
  }
  const completedAtMs = completedAt.getTime();
  const dispatchingAtValue = dispatchingAt;
  const dispatchingAtMs = Date.parse(dispatchingAtValue);
  const observationKeyHash = observation.observationKeyHash;
  const count = observation.count;
  const firstObservedAt = observation.firstObservedAt;
  const lastObservedAt = observation.lastObservedAt;
  const firstObservedAtMs = Date.parse(firstObservedAt);
  const lastObservedAtMs = Date.parse(lastObservedAt);
  return Boolean(
    Number.isFinite(completedAtMs) &&
      Number.isFinite(dispatchingAtMs) &&
      new Date(dispatchingAtMs).toISOString() === dispatchingAtValue &&
      /^[a-f0-9]{64}$/u.test(observationKeyHash) &&
      count === 3 &&
      Number.isFinite(firstObservedAtMs) &&
      Number.isFinite(lastObservedAtMs) &&
      new Date(firstObservedAtMs).toISOString() === firstObservedAt &&
      new Date(lastObservedAtMs).toISOString() === lastObservedAt &&
      dispatchingAtMs <= firstObservedAtMs &&
      lastObservedAtMs - firstObservedAtMs >= 10_000 &&
      lastObservedAtMs <= completedAtMs &&
      completedAtMs - lastObservedAtMs <= 1_000,
  );
}

/**
 * Performs the complete, credential-free integrity check shared by retry and
 * the production invariant audit. A failed row is retry authority only when
 * its logical request, operation slot, frozen upload ledger and exact POST
 * body can all be recomputed from durable state.
 */
function inspectKnowledgeBaseFailedTurnAuthority(
  source: ConversationTurn,
  build: KnowledgeBaseBuild,
  policy: KnowledgeBaseFailedTurnAuthorityPolicy,
): KnowledgeBaseRetryAuthority | null {
  try {
    const metadata = metadataOf(source);
    const recovery = retryAuthorityRecord(metadata.recovery);
    const preparedDispatch = metadata.preparedDispatch;
    const operationType = source.operationType as KnowledgeBaseOperationType;
    const createAttemptState = knowledgeBaseCreateAttemptState(
      source,
      metadata,
    );
    const storedCreateAttemptState =
      storedKnowledgeBaseCreateAttemptState(metadata);
    const retryPolicyValid =
      policy === "retry" &&
      metadata.failureClass === "terminal_requires_regeneration" &&
      metadata.recoveryAction === "regenerate_turn" &&
      metadata.canRegenerate === true &&
      (createAttemptState === "not_sent" ||
        createAttemptState === "acknowledged");
    const legacyTerminalRejection =
      storedCreateAttemptState === null &&
      typeof metadata.dispatchingAt === "string" &&
      metadata.dispatchingAt.length > 0 &&
      isDeterministicTaskCreateRejectionCode(source.errorCode);
    const terminalPolicyValid =
      policy === "terminal_rejected" &&
      !source.upstreamTaskId &&
      metadata.dispatchState === "failed" &&
      (metadata.failureClass === "terminal_nonregenerable" ||
        (legacyTerminalRejection &&
          metadata.failureClass === "requires_user_fix")) &&
      metadata.recoveryAction === "contact_support" &&
      metadata.canRegenerate === false &&
      metadata.awaitingClientAttachments !== true &&
      isDeterministicTaskCreateRejectionCode(source.errorCode) &&
      (storedCreateAttemptState === "rejected" || legacyTerminalRejection);
    const legacyProtocolTerminalPolicyValid =
      policy === "legacy_protocol_terminal" &&
      build.status === "protocol_error" &&
      build.protocolErrorCode === "PROGRESS_PROTOCOL_INVALID" &&
      source.errorCode === "PROGRESS_PROTOCOL_INVALID" &&
      source.id === build.activeTurnId &&
      typeof source.upstreamTaskId === "string" &&
      source.upstreamTaskId.length > 0 &&
      source.upstreamTaskId === build.upstreamTaskId &&
      source.completedAt instanceof Date &&
      Number.isFinite(source.completedAt.getTime()) &&
      source.leaseExpiresAt === null &&
      metadata.dispatchState === undefined &&
      metadata.failureClass === undefined &&
      metadata.recoveryAction === undefined &&
      metadata.canRegenerate === undefined &&
      metadata.createAttemptState === undefined &&
      metadata.awaitingClientAttachments !== true &&
      isLegacyProtocolFailureObservation(
        recovery?.protocolFailureObservation,
        source.completedAt,
        metadata.dispatchingAt,
      );
    const legacyFailedNotSentHandoffPolicyValid =
      policy === "legacy_failed_not_sent_handoff" &&
      build.providerProtocol === "legacy_v1" &&
      !build.canonicalTaskId &&
      source.id === build.activeTurnId &&
      !source.upstreamTaskId &&
      storedCreateAttemptState === "not_sent" &&
      metadata.providerAttemptState === "not_sent" &&
      metadata.dispatchingAt === undefined &&
      metadata.outcomeUnknownAt === undefined &&
      metadata.awaitingClientAttachments !== true &&
      metadata.dispatchState === "failed" &&
      metadata.failureClass !== "requires_user_fix" &&
      metadata.recoveryAction !== "top_up" &&
      metadata.recoveryAction !== "update_credential" &&
      metadata.recoveryAction !== "fix_attachments" &&
      metadata.recoveryAction !== "reupload_logo" &&
      Object.keys(generatedAttachmentReservations(metadata)).length === 0 &&
      Object.keys(manusV2AttachmentMappings(metadata)).length === 0 &&
      source.leaseExpiresAt === null;
    if (
      source.status !== "failed" ||
      source.userId !== build.userId ||
      source.conversationId !==
        knowledgeBaseConversationStorageId(
          build.userId,
          build.conversationId,
        ) ||
      source.buildId !== build.id ||
      source.buildGeneration !== build.generation ||
      source.expectedRevision !== build.revision ||
      (source.expectedLeafId ?? null) !== (build.currentLeafId ?? null) ||
      !source.apiCredentialId ||
      !source.operationKey ||
      !knowledgeBaseOperationTypes.includes(operationType) ||
      operationType === "legacy_reconcile" ||
      !source.requestHash ||
      !source.upstreamIdempotencyKeyHash ||
      (!retryPolicyValid &&
        !terminalPolicyValid &&
        !legacyProtocolTerminalPolicyValid &&
        !legacyFailedNotSentHandoffPolicyValid) ||
      metadata.attachmentsFrozen !== true ||
      !Array.isArray(source.attachmentFileIds) ||
      !recovery ||
      recovery.conversationId !== build.conversationId ||
      !preparedDispatch ||
      (legacyProtocolTerminalPolicyValid
        ? preparedDispatch.schemaVersion !== 1
        : preparedDispatch.schemaVersion !== 1 &&
          preparedDispatch.schemaVersion !== 2)
    ) {
      return null;
    }

    const recoveryKind = recovery.kind;
    if (
      (operationType === "start" && recoveryKind !== "start") ||
      (operationType !== "start" &&
        operationType !== "retry" &&
        recoveryKind !== "turn") ||
      (operationType === "retry" &&
        recoveryKind !== "start" &&
        recoveryKind !== "turn")
    ) {
      return null;
    }
    const finalDeliverySkillUpgrade =
      recovery.kind === "turn" &&
      recovery.finalPackageRequired === true &&
      knowledgeBaseRetryRequiresFreshFinalDelivery({
        ...build,
        operationType,
        finalPackageRequired: recovery.finalPackageRequired === true,
      }) &&
      recovery.skillVersion === "4" &&
      typeof recovery.skillContentHash === "string" &&
      /^[a-f0-9]{64}$/u.test(recovery.skillContentHash);
    if (
      recovery.skillVersion !== build.skillVersion ||
      (!finalDeliverySkillUpgrade &&
        (recovery.skillContentHash ?? null) !==
          (build.skillContentHash ?? null))
    ) {
      return null;
    }
    if (
      recoveryKind === "start" &&
      (recovery.companyName !== build.companyName ||
        recovery.companyWebsite !== (build.companyWebsite || ""))
    ) {
      return null;
    }

    const expectedAttachmentCount = metadata.expectedAttachmentCount;
    const userAttachmentCount = metadata.userAttachmentCount;
    if (
      typeof expectedAttachmentCount !== "number" ||
      !Number.isSafeInteger(expectedAttachmentCount) ||
      expectedAttachmentCount < 0 ||
      typeof userAttachmentCount !== "number" ||
      !Number.isSafeInteger(userAttachmentCount) ||
      userAttachmentCount < 0 ||
      userAttachmentCount > expectedAttachmentCount ||
      source.attachmentFileIds.length !== expectedAttachmentCount
    ) {
      return null;
    }

    const requestBody = retryAuthorityRecord(preparedDispatch.requestBody);
    const preparedAttachments = Array.isArray(requestBody?.attachments)
      ? requestBody.attachments
      : null;
    if (
      !requestBody ||
      (preparedDispatch.schemaVersion === 1
        ? requestBody.taskMode !== "agent"
        : requestBody.taskMode !== undefined) ||
      typeof requestBody.prompt !== "string" ||
      !requestBody.prompt ||
      typeof requestBody.agentProfile !== "string" ||
      !requestBody.agentProfile ||
      !preparedAttachments ||
      preparedAttachments.length !== source.attachmentFileIds.length ||
      preparedAttachments.some((attachment, index) => {
        const value = retryAuthorityRecord(attachment);
        return (
          !value ||
          typeof value.file_id !== "string" ||
          typeof value.filename !== "string" ||
          value.file_id !== source.attachmentFileIds[index]
        );
      }) ||
      preparedDispatch.bodySha256 !==
        hashKnowledgeBaseTurnRequest(preparedDispatch.requestBody) ||
      typeof preparedDispatch.preparedAt !== "string" ||
      !Number.isFinite(Date.parse(preparedDispatch.preparedAt))
    ) {
      return null;
    }

    const parsedBaseUrl = new URL(preparedDispatch.baseUrl);
    if (
      (parsedBaseUrl.protocol !== "https:" &&
        parsedBaseUrl.protocol !== "http:") ||
      parsedBaseUrl.username ||
      parsedBaseUrl.password ||
      parsedBaseUrl.search ||
      parsedBaseUrl.hash ||
      parsedBaseUrl.toString().replace(/\/$/, "") !== preparedDispatch.baseUrl
    ) {
      return null;
    }

    const expectedParentTaskId =
      operationType === "retry"
        ? (recovery.retryParentTaskId ?? recovery.parentTaskId)
        : recovery.parentTaskId;
    if (
      (recoveryKind === "start" && requestBody.taskId !== undefined) ||
      (recoveryKind === "turn" &&
        (typeof expectedParentTaskId !== "string" ||
          !expectedParentTaskId ||
          (preparedDispatch.schemaVersion === 1
            ? requestBody.taskId !== expectedParentTaskId
            : requestBody.taskId !== undefined)))
    ) {
      return null;
    }

    const retryOfTurnId =
      operationType === "retry" ? String(recovery.retryOfTurnId || "") : null;
    const legacyOperationKey = createKnowledgeBaseOperationKey({
      buildId: source.buildId,
      buildGeneration: source.buildGeneration,
      operationType,
      expectedRevision: source.expectedRevision,
      expectedLeafId: source.expectedLeafId,
      ...(operationType === "retry" ? { retryOfTurnId } : {}),
    });
    const expectedOperationKey =
      recovery.manualLogoSubmission === true && operationType !== "retry"
        ? createKnowledgeBaseOperationKey({
            buildId: source.buildId,
            buildGeneration: source.buildGeneration,
            operationType,
            expectedRevision: source.expectedRevision,
            expectedLeafId: source.expectedLeafId,
            operationInstanceId: source.clientRequestId,
          })
        : legacyOperationKey;
    if (
      (source.operationKey !== expectedOperationKey &&
        source.operationKey !== legacyOperationKey) ||
      source.upstreamIdempotencyKeyHash !==
        hashKnowledgeBaseUpstreamIdempotencyKey(
          createKnowledgeBaseUpstreamIdempotencyKey(source.operationKey),
        )
    ) {
      return null;
    }

    const requestPayload = retryAuthorityRequestPayload({
      operationType,
      recovery,
    });
    if (!requestPayload) return null;
    const expectedRequestHash = hashKnowledgeBaseTurnRequest({
      operationType,
      generation: source.buildGeneration,
      revision: source.expectedRevision,
      leafId: source.expectedLeafId,
      expectedAttachmentCount,
      userAttachmentCount,
      payload: requestPayload,
    });
    if (source.requestHash !== expectedRequestHash) return null;

    return { recovery, preparedDispatch };
  } catch {
    return null;
  }
}

export function inspectKnowledgeBaseRetryAuthority(
  source: ConversationTurn,
  build: KnowledgeBaseBuild,
) {
  return inspectKnowledgeBaseFailedTurnAuthority(source, build, "retry");
}

/**
 * Validates the same frozen request, attachment ledger and body hashes as
 * retry authority without granting a retry. This is solely structural
 * authority for retaining a terminal Task Create rejection as the failed
 * build's active history.
 */
export function inspectKnowledgeBaseTerminalTaskCreateRejectionAuthority(
  source: ConversationTurn,
  build: KnowledgeBaseBuild,
) {
  return inspectKnowledgeBaseFailedTurnAuthority(
    source,
    build,
    "terminal_rejected",
  );
}

/**
 * Recognizes the exact terminal protocol-failure history written before
 * dispatch failure metadata existed. This deliberately returns only a
 * boolean: it is authority to retain read-only history, never authority to
 * replay a provider request or mutate the failed build.
 */
export function inspectKnowledgeBaseLegacyProtocolTerminalHistoryAuthority(
  source: ConversationTurn,
  build: KnowledgeBaseBuild,
) {
  return Boolean(
    inspectKnowledgeBaseFailedTurnAuthority(
      source,
      build,
      "legacy_protocol_terminal",
    ),
  );
}

/**
 * Full structural proof used only to migrate a failed legacy operation whose
 * provider boundary was never crossed. This grants authority to create one
 * hidden v2 business replacement; it never grants authority for `sending`,
 * outcome-unknown, rejected, or acknowledged history.
 */
export function inspectKnowledgeBaseFailedNotSentLegacyHandoffAuthority(
  source: ConversationTurn,
  build: KnowledgeBaseBuild,
) {
  return inspectKnowledgeBaseFailedTurnAuthority(
    source,
    build,
    "legacy_failed_not_sent_handoff",
  );
}

export type KnowledgeBaseFailedNotSentLegacyHandoffResult =
  | {
      state: "reserved";
      sourceTurnId: string;
      replacementTurnId: string;
      buildId: string;
    }
  | {
      state: "already_reserved";
      sourceTurnId: string;
      replacementTurnId: string;
      buildId: string;
    }
  | {
      state: "attention_required";
      sourceTurnId: string;
      replacementTurnId: null;
      buildId: string;
      code: string;
    }
  | { state: "stale"; sourceTurnId: string; replacementTurnId: null };

type KnowledgeBaseFailedNotSentLocalSourceProof = {
  index: number;
  fileId: string;
  filename: string;
  mimeType: string;
  sizeBytes: number;
  contentSha256: string;
  localStorageKey: string;
};

const KNOWLEDGE_BASE_FAILED_NOT_SENT_SOURCE_MAX_BYTES = 100 * 1024 * 1024;
const KNOWLEDGE_BASE_SHA256_PATTERN = /^[a-f0-9]{64}$/u;

async function readKnowledgeBaseStoredFileBytes(input: {
  fileId: string;
  sizeBytes: number;
  contentSha256: string;
}) {
  const stored = await readStoredPresalesFile(input.fileId);
  if (
    !stored ||
    stored.sizeBytes !== input.sizeBytes ||
    (stored.recordedSizeBytes !== null &&
      stored.recordedSizeBytes !== input.sizeBytes) ||
    (stored.sha256 &&
      stored.sha256.trim().toLowerCase() !== input.contentSha256)
  ) {
    throw new Error("RETAINED_SOURCE_DESCRIPTOR_MISMATCH");
  }
  const chunks: Buffer[] = [];
  const hash = createHash("sha256");
  let total = 0;
  for await (const chunk of stored.createReadStream()) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += bytes.length;
    if (
      total > input.sizeBytes ||
      total > KNOWLEDGE_BASE_FAILED_NOT_SENT_SOURCE_MAX_BYTES
    ) {
      throw new Error("RETAINED_SOURCE_SIZE_MISMATCH");
    }
    hash.update(bytes);
    chunks.push(bytes);
  }
  if (total !== input.sizeBytes || hash.digest("hex") !== input.contentSha256) {
    throw new Error("RETAINED_SOURCE_INTEGRITY_MISMATCH");
  }
  return Buffer.concat(chunks, total);
}

async function proveKnowledgeBaseFailedNotSentLocalSources(input: {
  userId: number;
  build: KnowledgeBaseBuild;
  source: ConversationTurn;
  authority: KnowledgeBaseRetryAuthority;
  executor: any;
}) {
  const recovery = input.authority.recovery;
  const rawAttachments = Array.isArray(recovery.attachments)
    ? recovery.attachments
    : [];
  const rawManifest = Array.isArray(recovery.attachmentManifest)
    ? recovery.attachmentManifest
    : [];
  const rawProofs = Array.isArray(recovery.attachmentSourceProofs)
    ? recovery.attachmentSourceProofs
    : [];
  const userAttachmentCount = Number(
    metadataOf(input.source).userAttachmentCount ?? 0,
  );
  const generatedAttachmentCount =
    recovery.kind === "start"
      ? 2 + (recovery.includePrefill === true ? 1 : 0)
      : 2;
  const expectedAttachmentCount = Number(
    metadataOf(input.source).expectedAttachmentCount,
  );
  if (recovery.includePrefill === true) {
    const prefillSnapshotId = String(recovery.prefillSnapshotId || "").trim();
    const snapshot = prefillSnapshotId
      ? (
          await input.executor
            .select({ id: knowledgeBaseSnapshots.id })
            .from(knowledgeBaseSnapshots)
            .where(
              and(
                eq(knowledgeBaseSnapshots.id, prefillSnapshotId),
                eq(knowledgeBaseSnapshots.userId, input.userId),
              ),
            )
            .limit(1)
        )[0]
      : null;
    if (!snapshot) throw new Error("PREFILL_SOURCE_UNAVAILABLE");
  }
  if (
    !Number.isSafeInteger(userAttachmentCount) ||
    userAttachmentCount < 0 ||
    !Number.isSafeInteger(expectedAttachmentCount) ||
    expectedAttachmentCount !==
      userAttachmentCount + generatedAttachmentCount ||
    rawAttachments.length !== userAttachmentCount ||
    (userAttachmentCount > 0 && rawManifest.length !== userAttachmentCount)
  ) {
    throw new Error("SOURCE_LEDGER_INCOMPLETE");
  }

  const localProofs: KnowledgeBaseFailedNotSentLocalSourceProof[] = [];
  for (let index = 0; index < userAttachmentCount; index += 1) {
    const attachment = retryAuthorityRecord(rawAttachments[index]);
    const descriptor = retryAuthorityRecord(rawManifest[index]);
    const proofCandidates = rawProofs
      .map(retryAuthorityRecord)
      .filter((candidate): candidate is Record<string, unknown> =>
        Boolean(
          candidate &&
            String(candidate.fileId || "") ===
              String(attachment?.file_id || ""),
        ),
      );
    if (!attachment || !descriptor || proofCandidates.length > 1) {
      throw new Error("SOURCE_LEDGER_INCOMPLETE");
    }
    const fileId = String(attachment.file_id || "").trim();
    const filename = String(attachment.filename || "").trim();
    const manifestFilename = String(descriptor.filename || "").trim();
    const proof = proofCandidates[0] || null;
    const sizeBytes = Number(proof?.sizeBytes ?? descriptor.sizeBytes);
    const contentSha256 = String(
      proof?.contentSha256 ?? descriptor.sha256 ?? "",
    )
      .trim()
      .toLowerCase();
    const mimeType = String(
      proof?.mimeType ?? descriptor.mimeType ?? "application/octet-stream",
    ).trim();
    const storageKey = String(proof?.localStorageKey || "").trim();
    if (
      !fileId ||
      !filename ||
      manifestFilename !== filename ||
      !Number.isSafeInteger(sizeBytes) ||
      sizeBytes < 1 ||
      sizeBytes > KNOWLEDGE_BASE_FAILED_NOT_SENT_SOURCE_MAX_BYTES ||
      !KNOWLEDGE_BASE_SHA256_PATTERN.test(contentSha256) ||
      !mimeType
    ) {
      throw new Error("SOURCE_DESCRIPTOR_INVALID");
    }
    const bytes = storageKey
      ? await readKnowledgeBaseLocalSource({
          storageKey,
          contentSha256,
          sizeBytes,
        })
      : await readKnowledgeBaseStoredFileBytes({
          fileId,
          sizeBytes,
          contentSha256,
        });
    const installed = await persistKnowledgeBaseBuildSource({
      userId: input.userId,
      buildId: input.build.id,
      generation: input.build.generation,
      bytes,
    });
    localProofs.push({
      index,
      fileId,
      filename,
      mimeType,
      sizeBytes: installed.sizeBytes,
      contentSha256: installed.contentSha256,
      localStorageKey: installed.storageKey,
    });
  }

  const skill = await ensureKnowledgeBaseBuildSkillArchivePin(
    {
      userId: input.userId,
      buildId: input.build.id,
      generation: input.build.generation,
    },
    input.executor,
  );
  await persistKnowledgeBaseBuildSource({
    userId: input.userId,
    buildId: input.build.id,
    generation: input.build.generation,
    bytes: skill.bytes,
  });
  return localProofs;
}

function failedNotSentHandoffAttentionCode(error: unknown) {
  const reason = error instanceof Error ? error.message : "UNKNOWN";
  return /SKILL/u.test(reason)
    ? "LEGACY_FAILED_NOT_SENT_SKILL_UNAVAILABLE"
    : "LEGACY_FAILED_NOT_SENT_SOURCE_UNAVAILABLE";
}

function existingFailedNotSentReplacement(input: {
  build: KnowledgeBaseBuild;
  source: ConversationTurn | undefined;
}) {
  const metadata = input.source ? metadataOf(input.source) : {};
  const replacementTurnId =
    input.source?.status === "cancelled" &&
    metadata.supersededReason === "legacy_failed_not_sent_handoff" &&
    typeof metadata.supersededByTurnId === "string"
      ? metadata.supersededByTurnId
      : null;
  return replacementTurnId && replacementTurnId === input.build.activeTurnId
    ? replacementTurnId
    : null;
}

function isKnowledgeBaseFailedNotSentLegacyCandidate(input: {
  build: KnowledgeBaseBuild;
  source: ConversationTurn;
}) {
  const { build, source } = input;
  const metadata = metadataOf(source);
  return Boolean(
    build.providerProtocol === "legacy_v1" &&
      !build.canonicalTaskId &&
      build.activeTurnId === source.id &&
      source.userId === build.userId &&
      source.buildId === build.id &&
      source.buildGeneration === build.generation &&
      source.expectedRevision === build.revision &&
      (source.expectedLeafId ?? null) === (build.currentLeafId ?? null) &&
      source.status === "failed" &&
      !source.upstreamTaskId &&
      storedKnowledgeBaseCreateAttemptState(metadata) === "not_sent" &&
      metadata.providerAttemptState === "not_sent" &&
      metadata.dispatchingAt === undefined &&
      metadata.outcomeUnknownAt === undefined &&
      source.leaseExpiresAt === null,
  );
}

/**
 * Converts one failed, provably-never-sent legacy business turn into a hidden
 * replacement. Local byte proof happens before the transaction. The locked
 * recheck is the only authority to cancel the source and install the new
 * operation, so two migration workers can never create two replacements.
 *
 * No message or billing row is written: the original customer message remains
 * the visible intent and the replacement is only an internal operation ledger.
 */
export async function reserveKnowledgeBaseFailedNotSentLegacyHandoff(
  input: {
    userId: number;
    buildId: string;
    sourceTurnId: string;
    expectedGeneration: number;
    expectedStateEpoch: number;
    expectedRevision: number;
    expectedLeafId: string | null;
    replacementCredentialId?: string | null;
    now?: Date;
  },
  executor?: any,
  dependencies: {
    proveLocalSources?: typeof proveKnowledgeBaseFailedNotSentLocalSources;
  } = {},
): Promise<KnowledgeBaseFailedNotSentLegacyHandoffResult> {
  assertInteger(input.userId, "userId", 1);
  assertInteger(input.expectedGeneration, "expectedGeneration", 1);
  assertInteger(input.expectedStateEpoch, "expectedStateEpoch", 0);
  assertInteger(input.expectedRevision, "expectedRevision", 0);
  const buildId = normalizeRequiredId(input.buildId, "buildId", 36);
  const sourceTurnId = normalizeRequiredId(
    input.sourceTurnId,
    "sourceTurnId",
    36,
  );
  const expectedLeafId = normalizeOptionalLeafId(input.expectedLeafId);
  const replacementCredentialId = input.replacementCredentialId
    ? normalizeRequiredId(
        input.replacementCredentialId,
        "replacementCredentialId",
        36,
      )
    : null;
  const db = executor ?? (await requireDb());
  const preliminaryBuild = (
    await db
      .select()
      .from(knowledgeBaseBuilds)
      .where(
        and(
          eq(knowledgeBaseBuilds.id, buildId),
          eq(knowledgeBaseBuilds.userId, input.userId),
        ),
      )
      .limit(1)
  )[0] as KnowledgeBaseBuild | undefined;
  const preliminarySource = preliminaryBuild
    ? ((
        await db
          .select()
          .from(conversationTurns)
          .where(
            and(
              eq(conversationTurns.id, sourceTurnId),
              eq(conversationTurns.userId, input.userId),
              eq(conversationTurns.buildId, buildId),
            ),
          )
          .limit(1)
      )[0] as ConversationTurn | undefined)
    : undefined;
  if (!preliminaryBuild || !preliminarySource) {
    return { state: "stale", sourceTurnId, replacementTurnId: null };
  }
  const preliminaryReplacement = existingFailedNotSentReplacement({
    build: preliminaryBuild,
    source: preliminarySource,
  });
  if (preliminaryReplacement) {
    return {
      state: "already_reserved",
      sourceTurnId,
      replacementTurnId: preliminaryReplacement,
      buildId,
    };
  }
  const preliminaryAuthority =
    inspectKnowledgeBaseFailedNotSentLegacyHandoffAuthority(
      preliminarySource,
      preliminaryBuild,
    );
  let localProofs: KnowledgeBaseFailedNotSentLocalSourceProof[];
  try {
    if (!preliminaryAuthority) throw new Error("AUTHORITY_NOT_PROVEN");
    localProofs = await (
      dependencies.proveLocalSources ??
      proveKnowledgeBaseFailedNotSentLocalSources
    )({
      userId: input.userId,
      build: preliminaryBuild,
      source: preliminarySource,
      authority: preliminaryAuthority,
      executor: db,
    });
  } catch (error) {
    const code = failedNotSentHandoffAttentionCode(error);
    return db.transaction(async (tx: any) => {
      const build = (
        await tx
          .select()
          .from(knowledgeBaseBuilds)
          .where(
            and(
              eq(knowledgeBaseBuilds.id, buildId),
              eq(knowledgeBaseBuilds.userId, input.userId),
            ),
          )
          .limit(1)
          .for("update")
      )[0] as KnowledgeBaseBuild | undefined;
      const source = (
        await tx
          .select()
          .from(conversationTurns)
          .where(eq(conversationTurns.id, sourceTurnId))
          .limit(1)
          .for("update")
      )[0] as ConversationTurn | undefined;
      const existingReplacement = build
        ? existingFailedNotSentReplacement({ build, source })
        : null;
      if (build && existingReplacement) {
        return {
          state: "already_reserved" as const,
          sourceTurnId,
          replacementTurnId: existingReplacement,
          buildId,
        };
      }
      if (
        !build ||
        !source ||
        build.activeTurnId !== sourceTurnId ||
        !isKnowledgeBaseFailedNotSentLegacyCandidate({ build, source })
      ) {
        return { state: "stale", sourceTurnId, replacementTurnId: null };
      }
      const now = input.now ?? new Date();
      if (
        build.canonicalTaskState !== "attention_required" ||
        build.protocolErrorCode !== code
      ) {
        await tx
          .update(knowledgeBaseBuilds)
          .set({
            canonicalTaskState: "attention_required",
            protocolErrorCode: code,
            protocolError:
              "The failed legacy operation has no provider side effect, but its immutable local input proof is unavailable; accepted content remains visible.",
            stateEpoch: build.stateEpoch + 1,
            updatedAt: now,
          })
          .where(
            and(
              eq(knowledgeBaseBuilds.id, build.id),
              eq(knowledgeBaseBuilds.generation, build.generation),
              eq(knowledgeBaseBuilds.activeTurnId, source.id),
            ),
          );
      }
      return {
        state: "attention_required" as const,
        sourceTurnId,
        replacementTurnId: null,
        buildId,
        code,
      };
    });
  }

  return db.transaction(async (tx: any) => {
    const credentialIds = Array.from(
      new Set(
        [preliminarySource.apiCredentialId, replacementCredentialId].filter(
          (value): value is string => Boolean(value),
        ),
      ),
    ).sort();
    const lockedCredentials = (await tx
      .select()
      .from(apiCredentials)
      .where(inArray(apiCredentials.id, credentialIds))
      .limit(credentialIds.length)
      .for("update")) as Array<{
      id: string;
      userId: number;
      status: string;
    }>;
    const credentialsById = new Map(
      lockedCredentials.map((candidate) => [candidate.id, candidate]),
    );
    const credential = preliminarySource.apiCredentialId
      ? credentialsById.get(preliminarySource.apiCredentialId)
      : undefined;
    const credentialUnavailable =
      !preliminarySource.apiCredentialId ||
      !credential ||
      credential.id !== preliminarySource.apiCredentialId ||
      credential.status === "deleted";
    const build = (
      await tx
        .select()
        .from(knowledgeBaseBuilds)
        .where(
          and(
            eq(knowledgeBaseBuilds.id, buildId),
            eq(knowledgeBaseBuilds.userId, input.userId),
          ),
        )
        .limit(1)
        .for("update")
    )[0] as KnowledgeBaseBuild | undefined;
    if (!build) {
      return { state: "stale", sourceTurnId, replacementTurnId: null };
    }
    if (build.executionMode === "legacy_conversational") {
      throw new KnowledgeBaseTurnReservationError(
        "RESET_REQUIRED",
        "旧知识库构建不再续跑；请批准重置并重新上传资料",
      );
    }
    if (build.activeTurnId !== sourceTurnId) {
      const source = (
        await tx
          .select()
          .from(conversationTurns)
          .where(eq(conversationTurns.id, sourceTurnId))
          .limit(1)
          .for("update")
      )[0] as ConversationTurn | undefined;
      const replacementTurnId = existingFailedNotSentReplacement({
        build,
        source,
      });
      if (replacementTurnId && replacementTurnId === build.activeTurnId) {
        return {
          state: "already_reserved",
          sourceTurnId,
          replacementTurnId,
          buildId,
        };
      }
      return { state: "stale", sourceTurnId, replacementTurnId: null };
    }
    const source = (
      await tx
        .select()
        .from(conversationTurns)
        .where(eq(conversationTurns.id, sourceTurnId))
        .limit(1)
        .for("update")
    )[0] as ConversationTurn | undefined;
    const authority = source
      ? inspectKnowledgeBaseFailedNotSentLegacyHandoffAuthority(source, build)
      : null;
    if (
      !source ||
      !authority ||
      build.generation !== input.expectedGeneration ||
      build.stateEpoch !== input.expectedStateEpoch ||
      build.revision !== input.expectedRevision ||
      (build.currentLeafId ?? null) !== expectedLeafId ||
      source.apiCredentialId !== preliminarySource.apiCredentialId
    ) {
      return { state: "stale", sourceTurnId, replacementTurnId: null };
    }
    let selectedCredentialId = preliminarySource.apiCredentialId;
    let targetGeneration = build.generation;
    if (credentialUnavailable && replacementCredentialId) {
      const replacementCredential = credentialsById.get(
        replacementCredentialId,
      );
      if (
        replacementCredentialId === preliminarySource.apiCredentialId ||
        !replacementCredential ||
        replacementCredential.status !== "active" ||
        !(await lockCurrentKnowledgeBaseCredentialAuthority(
          tx,
          input.userId,
          replacementCredential,
        ))
      ) {
        return { state: "stale", sourceTurnId, replacementTurnId: null };
      }
      selectedCredentialId = replacementCredentialId;
      targetGeneration = build.generation + 1;
    } else if (credentialUnavailable) {
      const code = "LEGACY_FAILED_NOT_SENT_CREDENTIAL_UNAVAILABLE";
      const now = input.now ?? new Date();
      if (
        build.canonicalTaskState !== "attention_required" ||
        build.protocolErrorCode !== code
      ) {
        await tx
          .update(knowledgeBaseBuilds)
          .set({
            canonicalTaskState: "attention_required",
            protocolErrorCode: code,
            protocolError:
              "The failed legacy operation was never sent, but its pinned credential is permanently unavailable; accepted content remains visible.",
            stateEpoch: build.stateEpoch + 1,
            updatedAt: now,
          })
          .where(
            and(
              eq(knowledgeBaseBuilds.id, build.id),
              eq(knowledgeBaseBuilds.generation, build.generation),
              eq(knowledgeBaseBuilds.activeTurnId, source.id),
            ),
          );
      }
      return {
        state: "attention_required",
        sourceTurnId,
        replacementTurnId: null,
        buildId,
        code,
      };
    }
    const sourceMetadata = metadataOf(source);
    const recovery = sanitizeKnowledgeBaseRecoveryMetadata({
      ...authority.recovery,
      attachmentSourceProofs: localProofs,
      capturedClientAttachments: true,
      deferredClientAttachments: false,
      skillVersion: build.skillVersion,
      skillContentHash: build.skillContentHash,
      instructionsAttachmentRequired: true,
    });
    const now = input.now ?? new Date();
    const replacementTurnId = randomUUID();
    const operationType = source.operationType as KnowledgeBaseOperationType;
    const operationKey = createKnowledgeBaseOperationKey({
      buildId: build.id,
      buildGeneration: targetGeneration,
      operationType,
      expectedRevision: build.revision,
      expectedLeafId: build.currentLeafId,
      operationInstanceId: `legacy-failed-not-sent:${source.id}`,
    });
    const requestHash = hashKnowledgeBaseTurnRequest({
      protocol: "frontmind.knowledge-base.legacy-failed-not-sent-handoff.v1",
      supersedesTurnId: source.id,
      originalRequestHash: source.requestHash,
      operationType,
      generation: targetGeneration,
      revision: build.revision,
      leafId: build.currentLeafId,
      recovery,
    });
    const replacementMetadata: KnowledgeBaseTurnMetadata = {
      attachmentsFrozen: false,
      expectedAttachmentCount: Number(sourceMetadata.expectedAttachmentCount),
      userAttachmentCount: Number(sourceMetadata.userAttachmentCount),
      awaitingClientAttachments: false,
      recovery,
      createAttemptState: "not_sent",
      createAttemptUpdatedAt: now.toISOString(),
      providerProtocol: "legacy_v1",
      providerAttemptState: "not_sent",
      operationToken: operationKey,
      dispatchState: "reserved",
      failureClass: null,
      recoveryAction: "wait",
      canRegenerate: false,
      repairKind: "legacy_failed_not_sent_handoff",
      supersedesTurnId: source.id,
      hiddenReplacement: true,
      chargeDisposition: "reuse_original_no_charge",
      generatedAttachmentReservations: {},
      manusV2AttachmentMappings: {},
      ...(targetGeneration > build.generation
        ? {
            sourceGeneration: build.generation,
            receiptSourceGeneration: build.generation,
            credentialRebound: true,
          }
        : {}),
    };
    const sourceUpdated = await tx
      .update(conversationTurns)
      .set({
        status: "cancelled",
        completedAt: source.completedAt ?? now,
        leaseExpiresAt: null,
        metadata: {
          ...sourceMetadata,
          supersededByTurnId: replacementTurnId,
          supersededAt: now.toISOString(),
          supersededReason: "legacy_failed_not_sent_handoff",
        },
        updatedAt: now,
      })
      .where(
        and(
          eq(conversationTurns.id, source.id),
          eq(conversationTurns.status, "failed"),
          eq(conversationTurns.buildGeneration, build.generation),
          isNull(conversationTurns.upstreamTaskId),
        ),
      );
    if (sourceUpdated[0]?.affectedRows !== 1) {
      throw new KnowledgeBaseTurnReservationError(
        "CONFLICT",
        "The failed legacy source turn changed before replacement",
      );
    }
    await tx.insert(conversationTurns).values({
      id: replacementTurnId,
      conversationId: source.conversationId,
      userId: source.userId,
      apiCredentialId: selectedCredentialId,
      clientRequestId: `kb-migrate-${replacementTurnId}`,
      buildId: build.id,
      buildGeneration: targetGeneration,
      operationKey,
      operationType,
      expectedRevision: build.revision,
      expectedLeafId: build.currentLeafId,
      requestHash,
      upstreamIdempotencyKeyHash: hashKnowledgeBaseUpstreamIdempotencyKey(
        createKnowledgeBaseUpstreamIdempotencyKey(operationKey),
      ),
      attachmentFileIds: [],
      metadata: replacementMetadata,
      leaseExpiresAt: null,
      model: null,
      status: "queued",
      upstreamTaskId: null,
      errorCode: null,
      errorMessage: null,
      startedAt: null,
      completedAt: null,
      createdAt: now,
      updatedAt: now,
    });
    const buildUpdated = await tx
      .update(knowledgeBaseBuilds)
      .set({
        activeTurnId: replacementTurnId,
        canonicalTaskState: "unbound",
        protocolErrorCode: null,
        protocolError: null,
        status:
          recovery.kind === "start"
            ? ("researching" as const)
            : ("confirming" as const),
        generation: targetGeneration,
        ...(targetGeneration > build.generation
          ? {
              handoffProvenance: {
                schemaVersion: 1,
                sourceProtocol: "legacy_v1",
                sourceGeneration: build.generation,
                targetGeneration,
                receiptSourceGeneration: build.generation,
                pendingTurnId: replacementTurnId,
                credentialMode: "current_rebind",
                cutoverAt: now.toISOString(),
              },
            }
          : {}),
        stateEpoch: build.stateEpoch + 1,
        recoveryLeaseOwnerHash: null,
        recoveryLeaseExpiresAt: null,
        awaitingResponseSince: now,
        updatedAt: now,
      })
      .where(
        and(
          eq(knowledgeBaseBuilds.id, build.id),
          eq(knowledgeBaseBuilds.userId, input.userId),
          eq(knowledgeBaseBuilds.generation, build.generation),
          eq(knowledgeBaseBuilds.stateEpoch, input.expectedStateEpoch),
          eq(knowledgeBaseBuilds.activeTurnId, source.id),
          eq(knowledgeBaseBuilds.providerProtocol, "legacy_v1"),
          isNull(knowledgeBaseBuilds.canonicalTaskId),
        ),
      );
    if (buildUpdated[0]?.affectedRows !== 1) {
      throw new KnowledgeBaseTurnReservationError(
        "CONFLICT",
        "The legacy build writer fence changed before replacement",
      );
    }
    const conversation = (
      await tx
        .select()
        .from(conversations)
        .where(
          and(
            eq(conversations.id, source.conversationId),
            eq(conversations.userId, input.userId),
          ),
        )
        .limit(1)
        .for("update")
    )[0];
    if (
      !conversation ||
      conversation.projectAssignmentId !== null ||
      conversation.deletedAt
    ) {
      throw new KnowledgeBaseTurnReservationError(
        "CONFLICT",
        "The knowledge-base conversation is unavailable for migration",
      );
    }
    await tx
      .update(conversations)
      .set({
        apiCredentialId: selectedCredentialId,
        status: "running",
        version: conversation.version + 1,
        completedAt: null,
        updatedAt: now,
      })
      .where(
        and(
          eq(conversations.id, conversation.id),
          eq(conversations.userId, input.userId),
          eq(conversations.version, conversation.version),
        ),
      );
    return {
      state: "reserved",
      sourceTurnId,
      replacementTurnId,
      buildId,
    };
  });
}

export function knowledgeBaseConversationStorageId(
  userId: number,
  publicConversationId: string,
) {
  assertInteger(userId, "userId", 1);
  const publicId = normalizeRequiredId(
    publicConversationId,
    "conversationId",
    191,
  );
  const persistedId = `u${userId}:${publicId}`;
  if (persistedId.length > 191) {
    throw new KnowledgeBaseTurnReservationError(
      "INVALID_REQUEST",
      "Conversation id is too long for durable storage",
    );
  }
  return persistedId;
}

export function sanitizeKnowledgeBaseRecoveryMetadata(
  value: Record<string, unknown> | undefined,
) {
  const visit = (current: unknown, depth: number): unknown => {
    if (depth > MAX_RECOVERY_METADATA_DEPTH) return "[depth-limit]";
    if (
      current === null ||
      typeof current === "string" ||
      typeof current === "boolean"
    ) {
      return current;
    }
    if (typeof current === "number") {
      return Number.isFinite(current) ? current : null;
    }
    if (current instanceof Date) return current.toISOString();
    if (Array.isArray(current)) {
      return current.map((item) => visit(item, depth + 1));
    }
    if (!current || typeof current !== "object") return undefined;
    return Object.fromEntries(
      Object.entries(current as Record<string, unknown>)
        .filter(([key]) => !SECRET_KEY_PATTERN.test(key))
        .map(([key, item]) => [key, visit(item, depth + 1)])
        .filter(([, item]) => item !== undefined),
    );
  };
  return (visit(value ?? {}, 0) ?? {}) as Record<string, unknown>;
}

function metadataOf(row: Pick<ConversationTurn, "metadata">) {
  return (
    row.metadata &&
    typeof row.metadata === "object" &&
    !Array.isArray(row.metadata)
      ? row.metadata
      : {}
  ) as KnowledgeBaseTurnMetadata;
}

function safeKnowledgeBaseTraceId(value: unknown) {
  if (typeof value !== "string") return null;
  const normalized = value.trim();
  return /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/iu.test(
    normalized,
  )
    ? normalized
    : null;
}

function storedKnowledgeBaseCreateAttemptState(
  metadata: KnowledgeBaseTurnMetadata,
): KnowledgeBaseCreateAttemptState | null {
  const value = metadata.createAttemptState;
  if (typeof value !== "string") return null;
  return [
    "not_sent",
    "sending",
    "acknowledged",
    "rejected",
    "unknown",
  ].includes(value)
    ? (value as KnowledgeBaseCreateAttemptState)
    : null;
}

/**
 * Legacy rows did not persist an explicit create state. Once dispatchingAt or
 * outcomeUnknownAt exists, fail closed: a request may already have crossed
 * the provider boundary and must never be POSTed again based on an
 * undocumented Idempotency-Key header.
 */
function knowledgeBaseCreateAttemptState(
  row: Pick<ConversationTurn, "upstreamTaskId">,
  metadata: KnowledgeBaseTurnMetadata,
): KnowledgeBaseCreateAttemptState {
  if (row.upstreamTaskId) return "acknowledged";
  const stored = storedKnowledgeBaseCreateAttemptState(metadata);
  if (stored) return stored;
  if (metadata.outcomeUnknownAt || metadata.dispatchingAt) return "unknown";
  return "not_sent";
}

function releasedOperationTombstone(metadata: KnowledgeBaseTurnMetadata) {
  return (
    metadata.unpreparedCancellation === true ||
    metadata.localPreproviderRelease === true ||
    metadata.localCanonicalRehydrateAbandoned === true ||
    metadata.acknowledgedManualLogoCancellation === true ||
    metadata.unacknowledgedManualLogoCancellation === true
  );
}

function leaseOwnerHash(leaseToken: string) {
  return sha256(normalizeRequiredId(leaseToken, "leaseToken", 128));
}

function turnRecord(row: ConversationTurn): KnowledgeBaseTurnRecord {
  if (
    !row.buildId ||
    row.buildGeneration === null ||
    !row.operationKey ||
    !row.operationType ||
    row.expectedRevision === null ||
    !row.requestHash
  ) {
    throw new KnowledgeBaseTurnReservationError(
      "CONFLICT",
      "Knowledge-base turn reservation is incomplete",
    );
  }
  const metadata = metadataOf(row);
  const dispatchAuthority = knowledgeBaseTurnDispatchAuthority(row);
  const expectedUserAttachmentCount =
    typeof metadata.userAttachmentCount === "number" &&
    Number.isSafeInteger(metadata.userAttachmentCount) &&
    metadata.userAttachmentCount >= 0
      ? metadata.userAttachmentCount
      : 0;
  return {
    id: row.id,
    userId: row.userId,
    conversationId: row.conversationId,
    clientRequestId: row.clientRequestId,
    apiCredentialId: row.apiCredentialId,
    buildId: row.buildId,
    buildGeneration: row.buildGeneration,
    operationKey: row.operationKey,
    operationType: row.operationType as KnowledgeBaseOperationType,
    expectedRevision: row.expectedRevision,
    expectedLeafId: row.expectedLeafId,
    requestHash: row.requestHash,
    status: row.status,
    upstreamTaskId: row.upstreamTaskId,
    ...dispatchAuthority,
    createAttemptState: knowledgeBaseCreateAttemptState(row, metadata),
    traceId: safeKnowledgeBaseTraceId(metadata.traceId),
    materializedRecoveryContractVersion:
      metadata.materializedRecoveryContractVersion === 1 ? 1 : null,
    materializedCompletionContractVersion:
      metadata.materializedCompletionContractVersion ===
      KNOWLEDGE_BASE_MATERIALIZED_COMPLETION_CONTRACT_VERSION
        ? KNOWLEDGE_BASE_MATERIALIZED_COMPLETION_CONTRACT_VERSION
        : null,
    providerProtocol:
      metadata.providerProtocol === "manus_v2" ? "manus_v2" : "legacy_v1",
    providerMethod:
      metadata.providerMethod === "task.create" ||
      metadata.providerMethod === "task.sendMessage"
        ? metadata.providerMethod
        : null,
    providerAttemptState:
      typeof metadata.providerAttemptState === "string"
        ? metadata.providerAttemptState
        : null,
    materializedResultRead: metadata.materializedResultRead
      ? { ...metadata.materializedResultRead }
      : null,
    materializedCompletion: metadata.materializedCompletion
      ? { ...metadata.materializedCompletion }
      : null,
    materializedResultDiagnostics: metadata.materializedResultDiagnostics
      ? materializedResultDiagnosticsLedger(metadata)
      : null,
    operationToken:
      typeof metadata.operationToken === "string" && metadata.operationToken
        ? metadata.operationToken
        : String(row.operationKey),
    manusV2Lifecycle: metadata.manusV2Lifecycle
      ? { ...metadata.manusV2Lifecycle }
      : {},
    attachmentFileIds: [...(row.attachmentFileIds ?? [])],
    attachmentsFrozen: metadata.attachmentsFrozen === true,
    awaitingClientAttachments: metadata.awaitingClientAttachments === true,
    ...(Number.isSafeInteger(metadata.sourceResetRevision) &&
    Number(metadata.sourceResetRevision) >= 0
      ? { sourceResetRevision: Number(metadata.sourceResetRevision) }
      : {}),
    expectedUserAttachmentCount,
    stagedUserAttachmentCount: Array.isArray(metadata.clientStagedAttachments)
      ? metadata.clientStagedAttachments.length
      : 0,
    generatedAttachmentReservations: generatedAttachmentReservations(metadata),
    manusV2AttachmentMappings: manusV2AttachmentMappings(metadata),
    manusV2AttachmentAttempts: manusV2AttachmentAttempts(metadata),
    manusV2AttachmentUnknownAttempts:
      manusV2AttachmentUnknownAttempts(metadata),
    leaseExpiresAt: row.leaseExpiresAt,
    startedAt: row.startedAt,
    completedAt: row.completedAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function isKnowledgeBaseFailureClass(
  value: unknown,
): value is KnowledgeBaseFailureClass {
  return (
    typeof value === "string" &&
    [
      "recoverable_same_turn",
      "requires_user_fix",
      "terminal_requires_regeneration",
      "terminal_nonregenerable",
    ].includes(value)
  );
}

function isKnowledgeBaseRecoveryAction(
  value: unknown,
): value is KnowledgeBaseRecoveryAction {
  return (
    typeof value === "string" &&
    [
      "wait",
      "awaiting_input",
      "reconcile",
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
    ].includes(value)
  );
}

/** Derive a complete public receipt from durable row state and metadata. */
export function knowledgeBaseTurnDispatchAuthority(
  row: Pick<
    ConversationTurn,
    "status" | "upstreamTaskId" | "metadata" | "errorCode"
  >,
): {
  dispatchState: KnowledgeBaseDispatchState;
  failureClass: KnowledgeBaseFailureClass | null;
  recoveryAction: KnowledgeBaseRecoveryAction | null;
  canRegenerate: boolean;
} {
  const metadata = metadataOf(row as ConversationTurn);
  if (row.status === "completed") {
    return {
      dispatchState: "completed",
      failureClass: null,
      recoveryAction: null,
      canRegenerate: false,
    };
  }
  if (row.status === "failed" || row.status === "cancelled") {
    const storedFailureClass = isKnowledgeBaseFailureClass(
      metadata.failureClass,
    )
      ? metadata.failureClass
      : null;
    const storedAction = isKnowledgeBaseRecoveryAction(metadata.recoveryAction)
      ? metadata.recoveryAction
      : null;
    const storedCanRegenerate = metadata.canRegenerate;
    const regenerativeAuthorityIsExact =
      storedFailureClass === "terminal_requires_regeneration" &&
      storedAction === "regenerate_turn" &&
      storedCanRegenerate === true;
    const nonRegenerativeAuthorityIsExact =
      storedCanRegenerate === false &&
      ((storedFailureClass === "recoverable_same_turn" &&
        (storedAction === "reconcile" ||
          storedAction === "wait" ||
          storedAction === "awaiting_input")) ||
        (storedFailureClass === "requires_user_fix" &&
          [
            "top_up",
            "update_credential",
            "fix_attachments",
            "reupload_logo",
            "approve_reset",
            "create_new_canonical_from_snapshot",
            "contact_support",
          ].includes(storedAction || "")) ||
        (storedFailureClass === "terminal_nonregenerable" &&
          storedAction === "contact_support"));
    if (!regenerativeAuthorityIsExact && !nonRegenerativeAuthorityIsExact) {
      return {
        dispatchState: "failed",
        failureClass: "terminal_nonregenerable",
        recoveryAction: "contact_support",
        canRegenerate: false,
      };
    }
    return {
      dispatchState: "failed",
      failureClass: storedFailureClass,
      recoveryAction: storedAction,
      canRegenerate: regenerativeAuthorityIsExact,
    };
  }
  if (row.upstreamTaskId) {
    return {
      dispatchState: "bound",
      failureClass: null,
      recoveryAction: "wait",
      canRegenerate: false,
    };
  }
  const recovering =
    metadata.dispatchState === "recovering" ||
    Boolean(metadata.dispatchingAt) ||
    Boolean(metadata.outcomeUnknownAt) ||
    Boolean(metadata.preparedDispatch);
  return {
    dispatchState: recovering ? "recovering" : "reserved",
    failureClass: recovering ? "recoverable_same_turn" : null,
    recoveryAction: recovering ? "reconcile" : "wait",
    canRegenerate: false,
  };
}

export function evaluateKnowledgeBaseTurnReplay(
  row: Pick<
    ConversationTurn,
    | "buildId"
    | "buildGeneration"
    | "operationKey"
    | "operationType"
    | "expectedRevision"
    | "expectedLeafId"
    | "requestHash"
    | "apiCredentialId"
    | "status"
    | "upstreamTaskId"
    | "leaseExpiresAt"
  >,
  identity: KnowledgeBaseTurnIdentity,
  now = new Date(),
): ReservationReplayDecision {
  if (
    row.buildId !== identity.buildId ||
    row.buildGeneration !== identity.buildGeneration ||
    row.operationKey !== identity.operationKey ||
    row.operationType !== identity.operationType ||
    row.expectedRevision !== identity.expectedRevision ||
    (row.expectedLeafId ?? null) !== identity.expectedLeafId ||
    row.requestHash !== identity.requestHash ||
    (row.apiCredentialId ?? null) !== identity.apiCredentialId
  ) {
    return { state: "conflict" };
  }
  if (row.status === "completed") return { state: "completed" };
  if (row.status === "failed" || row.status === "cancelled") {
    return { state: "terminal" };
  }
  if (row.upstreamTaskId) {
    return { state: "bound", upstreamTaskId: row.upstreamTaskId };
  }
  const remainingMs = (row.leaseExpiresAt?.getTime() ?? 0) - now.getTime();
  return remainingMs > 0
    ? {
        state: "pending",
        retryAfterMs: Math.max(250, Math.min(remainingMs, 5_000)),
      }
    : { state: "expired" };
}

function assertOperationMatchesBuild(
  build: KnowledgeBaseBuild,
  input: ReserveKnowledgeBaseTurnInput,
) {
  if (build.generation !== input.expectedGeneration) {
    throw new KnowledgeBaseTurnReservationError(
      "CONFLICT",
      "Knowledge-base generation has advanced",
    );
  }
  if (build.revision !== input.expectedRevision) {
    throw new KnowledgeBaseTurnReservationError(
      "CONFLICT",
      "Knowledge-base revision has advanced",
    );
  }
  if ((build.currentLeafId ?? null) !== input.expectedLeafId) {
    throw new KnowledgeBaseTurnReservationError(
      "CONFLICT",
      "Knowledge-base current leaf has changed",
    );
  }
  if (
    input.expectedPresentationKey !== undefined &&
    (build.currentPresentationKey ?? null) !== input.expectedPresentationKey
  ) {
    throw new KnowledgeBaseTurnReservationError(
      "STALE_KNOWLEDGE_BASE_PRESENTATION",
      "Knowledge-base presentation has changed",
    );
  }
  if (build.status === "ready_to_publish" || build.status === "published") {
    throw new KnowledgeBaseTurnReservationError(
      "TERMINAL",
      "Knowledge-base build no longer accepts turns",
    );
  }
  if (input.operationType === "start") {
    if (build.status !== "researching" || build.revision !== 0) {
      throw new KnowledgeBaseTurnReservationError(
        "CONFLICT",
        "Knowledge-base start slot is no longer current",
      );
    }
    return;
  }
  if (input.operationType === "retry") {
    if (build.status !== "protocol_error") {
      throw new KnowledgeBaseTurnReservationError(
        "CONFLICT",
        "Knowledge-base retry is only available for a settled protocol error",
      );
    }
    // A failed first manifest legitimately has no current leaf yet. The
    // failed active turn check below still pins generation/revision/null leaf.
    return;
  }
  if (
    input.operationType !== "legacy_reconcile" &&
    build.status !== "confirming"
  ) {
    throw new KnowledgeBaseTurnReservationError(
      "CONFLICT",
      "Knowledge-base build is not accepting a customer reply",
    );
  }
  if (!input.expectedLeafId) {
    throw new KnowledgeBaseTurnReservationError(
      "CONFLICT",
      "Knowledge-base build has no current leaf",
    );
  }
}

async function ensureConversation(
  tx: any,
  build: KnowledgeBaseBuild,
  apiCredentialId: string | null,
  now: Date,
) {
  const id = knowledgeBaseConversationStorageId(
    build.userId,
    build.conversationId,
  );
  await tx
    .insert(conversations)
    .values({
      id,
      userId: build.userId,
      apiCredentialId,
      projectAssignmentId: null,
      title: `知识库 · ${build.companyName}`.slice(0, 255),
      status: "running",
      deletedMessageIds: [],
      version: 1,
      startedAt: now,
      createdAt: now,
      updatedAt: now,
    })
    .onDuplicateKeyUpdate({
      // Do not mutate a pre-existing conversation on a duplicate-key race.
      set: { id },
    });
  const rows = await tx
    .select()
    .from(conversations)
    .where(eq(conversations.id, id))
    .limit(1)
    .for("update");
  const conversation = rows[0];
  if (
    !conversation ||
    conversation.userId !== build.userId ||
    conversation.projectAssignmentId !== null ||
    conversation.deletedAt
  ) {
    throw new KnowledgeBaseTurnReservationError(
      "CONFLICT",
      "Conversation id belongs to another workspace or was deleted",
    );
  }
  return id;
}

async function lockExistingKnowledgeBaseConversation(
  tx: any,
  build: KnowledgeBaseBuild,
) {
  const id = knowledgeBaseConversationStorageId(
    build.userId,
    build.conversationId,
  );
  const conversation = (
    await tx
      .select({
        id: conversations.id,
        userId: conversations.userId,
        projectAssignmentId: conversations.projectAssignmentId,
        status: conversations.status,
        deletedAt: conversations.deletedAt,
      })
      .from(conversations)
      .where(eq(conversations.id, id))
      .limit(1)
      .for("update")
  )[0] as
    | {
        id: string;
        userId: number;
        projectAssignmentId: string | null;
        status: string;
        deletedAt: Date | null;
      }
    | undefined;
  return conversation;
}

function acquiredResult(
  row: ConversationTurn,
  leaseToken: string,
  leaseExpiresAt: Date,
): Extract<KnowledgeBaseTurnReservation, { state: "acquired" }> {
  return {
    state: "acquired",
    turn: turnRecord({
      ...row,
      leaseExpiresAt,
      metadata: {
        ...metadataOf(row),
        leaseOwnerHash: leaseOwnerHash(leaseToken),
      },
    }),
    leaseToken,
    leaseExpiresAt,
    upstreamIdempotencyKey: createKnowledgeBaseUpstreamIdempotencyKey(
      String(row.operationKey),
    ),
  };
}

function existingResult(
  row: ConversationTurn,
  decision: Exclude<
    ReservationReplayDecision,
    { state: "conflict" | "expired" }
  >,
): KnowledgeBaseTurnReservation {
  const turn = turnRecord(row);
  switch (decision.state) {
    case "pending":
      return { state: "pending", turn, retryAfterMs: decision.retryAfterMs };
    case "bound":
      return {
        state: "bound",
        turn,
        upstreamTaskId: decision.upstreamTaskId,
      };
    case "completed":
      return { state: "completed", turn, upstreamTaskId: row.upstreamTaskId };
    case "terminal":
      return { state: "terminal", turn };
  }
}

/**
 * Convert a durable turn into a passive receipt. Unlike reservation replay,
 * this function never takes over an expired lease: HTTP replay must observe
 * the original operation and leave recovery as its sole dispatcher.
 */
function passiveExistingResult(
  row: ConversationTurn,
  now: Date,
): KnowledgeBaseTurnReplayReceipt {
  if (row.status === "completed") {
    return {
      state: "completed",
      turn: turnRecord(row),
      upstreamTaskId: row.upstreamTaskId,
    };
  }
  if (row.status === "failed" || row.status === "cancelled") {
    return { state: "terminal", turn: turnRecord(row) };
  }
  if (row.upstreamTaskId) {
    return {
      state: "bound",
      turn: turnRecord(row),
      upstreamTaskId: row.upstreamTaskId,
    };
  }
  if (metadataOf(row).awaitingClientAttachments === true) {
    return { state: "awaiting_attachments", turn: turnRecord(row) };
  }
  const remainingMs = (row.leaseExpiresAt?.getTime() ?? 0) - now.getTime();
  return {
    state: "pending",
    turn: turnRecord(row),
    retryAfterMs:
      remainingMs > 0 ? Math.max(250, Math.min(remainingMs, 5_000)) : 1_000,
  };
}

/**
 * Read-only, state-independent replay lookup for an HTTP request whose first
 * response may have been lost. A matching receipt is returned before routes
 * inspect mutable Logo/finalization/Skill state. Different content under the
 * same client request id is a stable conflict.
 */
export async function inspectKnowledgeBaseTurnReplay(
  input: InspectKnowledgeBaseTurnReplayInput,
  executor?: any,
): Promise<KnowledgeBaseTurnReplayReceipt | null> {
  assertInteger(input.userId, "userId", 1);
  const conversationId = knowledgeBaseConversationStorageId(
    input.userId,
    input.conversationId,
  );
  const clientRequestId = normalizeRequiredId(
    input.clientRequestId,
    "clientRequestId",
    128,
  );
  const clientIntentHash = hashKnowledgeBaseTurnRequest(input.clientIntent);
  const expectedGeneration = input.expectedGeneration;
  const expectedRevision = input.expectedRevision;
  const expectedLeafId =
    input.expectedLeafId === undefined
      ? undefined
      : normalizeOptionalLeafId(input.expectedLeafId);
  if (expectedGeneration !== undefined) {
    assertInteger(expectedGeneration, "expectedGeneration", 1);
  }
  if (expectedRevision !== undefined) {
    assertInteger(expectedRevision, "expectedRevision", 0);
  }
  const now = input.now ?? new Date();
  const db = executor ?? (await requireDb());
  return db.transaction(async (tx: any) => {
    const rows = await tx
      .select()
      .from(conversationTurns)
      .where(
        and(
          eq(conversationTurns.userId, input.userId),
          eq(conversationTurns.conversationId, conversationId),
          eq(conversationTurns.clientRequestId, clientRequestId),
        ),
      )
      .limit(1);
    const row = rows[0] as ConversationTurn | undefined;
    if (row && metadataOf(row).clientIntentHash !== clientIntentHash) {
      throw new KnowledgeBaseTurnReservationError(
        "KNOWLEDGE_BASE_REQUEST_REPLAY_MISMATCH",
        "The client request id was already used for different content",
      );
    }
    if (row) return passiveExistingResult(row, now);

    if (
      expectedGeneration === undefined ||
      expectedRevision === undefined ||
      expectedLeafId === undefined
    ) {
      return null;
    }
    const coordinateRows = await tx
      .select()
      .from(conversationTurns)
      .where(
        and(
          eq(conversationTurns.userId, input.userId),
          eq(conversationTurns.conversationId, conversationId),
          eq(conversationTurns.buildGeneration, expectedGeneration),
          eq(conversationTurns.expectedRevision, expectedRevision),
          expectedLeafId === null
            ? isNull(conversationTurns.expectedLeafId)
            : eq(conversationTurns.expectedLeafId, expectedLeafId),
          sql`JSON_UNQUOTE(JSON_EXTRACT(${conversationTurns.metadata}, '$.clientIntentHash')) = ${clientIntentHash}`,
          sql`COALESCE(JSON_UNQUOTE(JSON_EXTRACT(${conversationTurns.metadata}, '$.unpreparedCancellation')), 'false') <> 'true'`,
          sql`COALESCE(JSON_UNQUOTE(JSON_EXTRACT(${conversationTurns.metadata}, '$.acknowledgedManualLogoCancellation')), 'false') <> 'true'`,
          sql`COALESCE(JSON_UNQUOTE(JSON_EXTRACT(${conversationTurns.metadata}, '$.unacknowledgedManualLogoCancellation')), 'false') <> 'true'`,
        ),
      )
      .orderBy(desc(conversationTurns.createdAt))
      .limit(1);
    const operationWinner = coordinateRows[0] as ConversationTurn | undefined;
    return operationWinner &&
      !releasedOperationTombstone(metadataOf(operationWinner))
      ? passiveExistingResult(operationWinner, now)
      : null;
  });
}

/**
 * Read-only compatibility lookup for a pre-clientIntentHash `/start` receipt.
 *
 * Historical schema-v1 starts can have fewer generated attachments than the
 * current start contract, so their requestHash cannot be recomputed from the
 * current expected attachment count. They are replayable only when the full
 * legacy protocol-terminal history is structurally valid and every
 * browser-authoritative start field still matches the frozen recovery body.
 */
export async function inspectKnowledgeBaseLegacyStartReplay(
  input: InspectKnowledgeBaseLegacyStartReplayInput,
  executor?: any,
): Promise<KnowledgeBaseTurnReplayReceipt | null> {
  assertInteger(input.userId, "userId", 1);
  const publicConversationId = normalizeRequiredId(
    input.conversationId,
    "conversationId",
    191,
  );
  const conversationId = knowledgeBaseConversationStorageId(
    input.userId,
    publicConversationId,
  );
  const clientRequestId = normalizeRequiredId(
    input.clientRequestId,
    "clientRequestId",
    128,
  );
  const companyName = normalizeRequiredId(
    input.companyName,
    "companyName",
    255,
  );
  const companyWebsite = String(input.companyWebsite || "").trim();
  const operatorNotes = String(input.operatorNotes || "").trim();
  const attachments = input.attachments.map((attachment) => ({
    file_id: normalizeRequiredId(
      attachment.file_id,
      "attachmentFileId",
      MAX_ATTACHMENT_ID_LENGTH,
    ),
    filename: normalizeRequiredId(
      attachment.filename,
      "attachment filename",
      512,
    ),
  }));
  if (
    attachments.length > MAX_USER_ATTACHMENT_COUNT ||
    new Set(attachments.map((attachment) => attachment.file_id)).size !==
      attachments.length
  ) {
    throw new KnowledgeBaseTurnReservationError(
      "INVALID_REQUEST",
      "Knowledge-base start attachments are invalid",
    );
  }
  const now = input.now ?? new Date();
  const db = executor ?? (await requireDb());
  return db.transaction(async (tx: any) => {
    const row = (
      await tx
        .select()
        .from(conversationTurns)
        .where(
          and(
            eq(conversationTurns.userId, input.userId),
            eq(conversationTurns.conversationId, conversationId),
            eq(conversationTurns.clientRequestId, clientRequestId),
          ),
        )
        .limit(1)
    )[0] as ConversationTurn | undefined;
    if (!row || row.operationType !== "start" || !row.buildId) return null;
    const build = (
      await tx
        .select()
        .from(knowledgeBaseBuilds)
        .where(
          and(
            eq(knowledgeBaseBuilds.id, row.buildId),
            eq(knowledgeBaseBuilds.userId, input.userId),
          ),
        )
        .limit(1)
    )[0] as KnowledgeBaseBuild | undefined;
    if (
      !build ||
      !inspectKnowledgeBaseLegacyProtocolTerminalHistoryAuthority(row, build) ||
      inspectKnowledgeBaseRetryAuthority(row, build) !== null
    ) {
      return null;
    }
    const recovery = retryAuthorityRecord(metadataOf(row).recovery);
    const recoveredAttachments = Array.isArray(recovery?.attachments)
      ? recovery.attachments
      : null;
    const browserFieldsMatch =
      recovery?.kind === "start" &&
      recovery.conversationId === publicConversationId &&
      recovery.companyName === companyName &&
      recovery.companyWebsite === companyWebsite &&
      recovery.operatorNotes === operatorNotes &&
      recoveredAttachments?.length === attachments.length &&
      recoveredAttachments.every((value, index) => {
        const recovered = retryAuthorityRecord(value);
        return (
          recovered?.file_id === attachments[index]?.file_id &&
          recovered?.filename === attachments[index]?.filename
        );
      });
    if (!browserFieldsMatch) {
      throw new KnowledgeBaseTurnReservationError(
        "KNOWLEDGE_BASE_REQUEST_REPLAY_MISMATCH",
        "The client request id was already used for different content",
      );
    }
    return passiveExistingResult(row, now);
  });
}

/**
 * Read-only replay lookup for a completed browser attachment-stage request.
 * The staged ledger remains durable after the final file claims a worker
 * lease, so a lost HTTP response can be replayed without consulting mutable
 * Logo/build gates. The live reset fence remains mandatory.
 */
export async function inspectKnowledgeBaseDeferredAttachmentReplay(
  input: InspectKnowledgeBaseDeferredAttachmentReplayInput,
  executor?: any,
): Promise<KnowledgeBaseTurnReplayReceipt | null> {
  assertInteger(input.userId, "userId", 1);
  assertInteger(input.index, "attachment index", 0);
  assertInteger(input.expectedResetRevision, "expectedResetRevision", 0);
  const conversationId = knowledgeBaseConversationStorageId(
    input.userId,
    input.conversationId,
  );
  const turnId = normalizeRequiredId(input.turnId, "turnId", 36);
  const clientRequestId = normalizeRequiredId(
    input.clientRequestId,
    "clientRequestId",
    128,
  );
  const manifestHash = hashKnowledgeBaseTurnRequest(
    input.clientAttachmentManifest,
  );
  const attachment = normalizeDeferredUserAttachments([input.attachment])[0]!;
  const now = input.now ?? new Date();
  const db = executor ?? (await requireDb());
  return db.transaction(async (tx: any) => {
    const rows = await tx
      .select()
      .from(conversationTurns)
      .where(
        and(
          eq(conversationTurns.id, turnId),
          eq(conversationTurns.userId, input.userId),
          eq(conversationTurns.conversationId, conversationId),
        ),
      )
      .limit(1);
    const row = rows[0] as ConversationTurn | undefined;
    if (!row) return null;
    const metadata = metadataOf(row);
    await assertDeferredResetRevisionInTransaction({
      tx,
      turn: row,
      metadata,
      expectedResetRevision: input.expectedResetRevision,
    });
    if (
      row.clientRequestId !== clientRequestId ||
      metadata.clientAttachmentManifestHash !== manifestHash
    ) {
      throw new KnowledgeBaseTurnReservationError(
        "KNOWLEDGE_BASE_REQUEST_REPLAY_MISMATCH",
        "The attachment request does not match its logical turn reservation",
      );
    }
    const staged = Array.isArray(metadata.clientStagedAttachments)
      ? metadata.clientStagedAttachments
      : [];
    const prior = staged[input.index];
    if (!prior) return null;
    if (
      prior.index !== input.index ||
      prior.file_id !== attachment.file_id ||
      prior.filename !== attachment.filename
    ) {
      throw new KnowledgeBaseTurnReservationError(
        "KNOWLEDGE_BASE_REQUEST_REPLAY_MISMATCH",
        "A different file is already staged at this manifest index",
      );
    }
    return passiveExistingResult(row, now);
  });
}

/**
 * Read-only dispatch receipt lookup. A reservation which is still awaiting
 * browser files is not yet a dispatch replay; every later state is durable and
 * can be returned after the live reset fence, before mutable build/task gates.
 */
export async function inspectKnowledgeBaseDeferredDispatchReplay(
  input: InspectKnowledgeBaseDeferredDispatchReplayInput,
  executor?: any,
): Promise<KnowledgeBaseTurnReplayReceipt | null> {
  assertInteger(input.userId, "userId", 1);
  assertInteger(input.expectedResetRevision, "expectedResetRevision", 0);
  const conversationId = knowledgeBaseConversationStorageId(
    input.userId,
    input.conversationId,
  );
  const turnId = normalizeRequiredId(input.turnId, "turnId", 36);
  const clientRequestId = normalizeRequiredId(
    input.clientRequestId,
    "clientRequestId",
    128,
  );
  const manifestHash = hashKnowledgeBaseTurnRequest(
    input.clientAttachmentManifest,
  );
  const now = input.now ?? new Date();
  const db = executor ?? (await requireDb());
  return db.transaction(async (tx: any) => {
    const row = (
      await tx
        .select()
        .from(conversationTurns)
        .where(
          and(
            eq(conversationTurns.id, turnId),
            eq(conversationTurns.userId, input.userId),
            eq(conversationTurns.conversationId, conversationId),
          ),
        )
        .limit(1)
    )[0] as ConversationTurn | undefined;
    if (!row) return null;
    const metadata = metadataOf(row);
    await assertDeferredResetRevisionInTransaction({
      tx,
      turn: row,
      metadata,
      expectedResetRevision: input.expectedResetRevision,
    });
    if (
      row.clientRequestId !== clientRequestId ||
      metadata.clientAttachmentManifestHash !== manifestHash
    ) {
      throw new KnowledgeBaseTurnReservationError(
        "KNOWLEDGE_BASE_REQUEST_REPLAY_MISMATCH",
        "The attachment dispatch does not match its logical turn reservation",
      );
    }
    if (
      metadata.awaitingClientAttachments === true &&
      row.status !== "completed" &&
      row.status !== "failed" &&
      row.status !== "cancelled" &&
      !row.upstreamTaskId
    ) {
      return null;
    }
    return passiveExistingResult(row, now);
  });
}

/**
 * A rollout-only `/turn/reserve` resume never changes customer intent. The
 * original client id, coordinate and manifest hash are therefore sufficient
 * immutable authority to return its existing receipt without current gates.
 */
export async function inspectKnowledgeBaseLegacyDeferredReservationReplay(
  input: InspectKnowledgeBaseLegacyDeferredReservationReplayInput,
  executor?: any,
): Promise<KnowledgeBaseTurnReplayReceipt | null> {
  assertInteger(input.userId, "userId", 1);
  assertInteger(input.expectedGeneration, "expectedGeneration", 1);
  assertInteger(input.expectedRevision, "expectedRevision", 0);
  if (!knowledgeBaseOperationTypes.includes(input.operationType)) {
    throw new KnowledgeBaseTurnReservationError(
      "INVALID_REQUEST",
      "Knowledge-base operation type is invalid",
    );
  }
  const conversationId = knowledgeBaseConversationStorageId(
    input.userId,
    input.conversationId,
  );
  const clientRequestId = normalizeRequiredId(
    input.clientRequestId,
    "clientRequestId",
    128,
  );
  const expectedLeafId = normalizeOptionalLeafId(input.expectedLeafId);
  const expectedPresentationKey =
    input.expectedPresentationKey === undefined
      ? undefined
      : normalizeRequiredId(
          input.expectedPresentationKey,
          "expectedPresentationKey",
          191,
        );
  const manifestHash = hashKnowledgeBaseTurnRequest(
    input.clientAttachmentManifest,
  );
  const now = input.now ?? new Date();
  const db = executor ?? (await requireDb());
  return db.transaction(async (tx: any) => {
    const row = (
      await tx
        .select()
        .from(conversationTurns)
        .where(
          and(
            eq(conversationTurns.userId, input.userId),
            eq(conversationTurns.conversationId, conversationId),
            eq(conversationTurns.clientRequestId, clientRequestId),
          ),
        )
        .limit(1)
    )[0] as ConversationTurn | undefined;
    if (!row) return null;
    const metadata = metadataOf(row);
    if (
      row.buildGeneration !== input.expectedGeneration ||
      row.expectedRevision !== input.expectedRevision ||
      (row.expectedLeafId ?? null) !== expectedLeafId ||
      row.operationType !== input.operationType ||
      metadata.clientAttachmentManifestHash !== manifestHash ||
      (metadata.expectedPresentationKey !== undefined &&
        metadata.expectedPresentationKey !== expectedPresentationKey)
    ) {
      throw new KnowledgeBaseTurnReservationError(
        "KNOWLEDGE_BASE_REQUEST_REPLAY_MISMATCH",
        "The deferred reservation resume does not match its immutable turn",
      );
    }
    return passiveExistingResult(row, now);
  });
}

/**
 * The first upload-first legacy request must still perform the atomic takeover.
 * Only a row already marked as taken over, with the exact frozen file ledger,
 * is a replay which may bypass current Logo/finalization/Skill checks.
 */
export async function inspectKnowledgeBaseLegacyAttachmentTakeoverReplay(
  input: InspectKnowledgeBaseLegacyAttachmentTakeoverReplayInput,
  executor?: any,
): Promise<KnowledgeBaseTurnReplayReceipt | null> {
  assertInteger(input.userId, "userId", 1);
  assertInteger(input.expectedGeneration, "expectedGeneration", 1);
  assertInteger(input.expectedRevision, "expectedRevision", 0);
  if (!knowledgeBaseOperationTypes.includes(input.operationType)) {
    throw new KnowledgeBaseTurnReservationError(
      "INVALID_REQUEST",
      "Knowledge-base operation type is invalid",
    );
  }
  const conversationId = knowledgeBaseConversationStorageId(
    input.userId,
    input.conversationId,
  );
  const clientRequestId = normalizeRequiredId(
    input.clientRequestId,
    "clientRequestId",
    128,
  );
  const expectedLeafId = normalizeOptionalLeafId(input.expectedLeafId);
  const expectedPresentationKey =
    input.expectedPresentationKey === undefined
      ? undefined
      : normalizeRequiredId(
          input.expectedPresentationKey,
          "expectedPresentationKey",
          191,
        );
  const manifestHash = hashKnowledgeBaseTurnRequest(
    input.clientAttachmentManifest,
  );
  const attachments = normalizeDeferredUserAttachments(input.attachments);
  const now = input.now ?? new Date();
  const db = executor ?? (await requireDb());
  return db.transaction(async (tx: any) => {
    const row = (
      await tx
        .select()
        .from(conversationTurns)
        .where(
          and(
            eq(conversationTurns.userId, input.userId),
            eq(conversationTurns.conversationId, conversationId),
            eq(conversationTurns.clientRequestId, clientRequestId),
          ),
        )
        .limit(1)
    )[0] as ConversationTurn | undefined;
    if (!row) return null;
    const metadata = metadataOf(row);
    if (metadata.legacyUploadFirstTakeover !== true) return null;
    const recovery = retryAuthorityRecord(metadata.recovery);
    const recoveredAttachments = Array.isArray(recovery?.attachments)
      ? recovery.attachments
      : [];
    const clientAttachmentManifest = Array.isArray(
      recovery?.clientAttachmentManifest,
    )
      ? recovery.clientAttachmentManifest
      : Array.isArray(recovery?.attachmentManifest)
        ? recovery.attachmentManifest
        : null;
    const immutableMatch =
      recovery?.kind === "turn" &&
      recovery.conversationId === input.conversationId &&
      row.buildGeneration === input.expectedGeneration &&
      row.expectedRevision === input.expectedRevision &&
      (row.expectedLeafId ?? null) === expectedLeafId &&
      row.operationType === input.operationType &&
      metadata.clientAttachmentManifestHash === manifestHash &&
      (metadata.expectedPresentationKey === undefined ||
        metadata.expectedPresentationKey === expectedPresentationKey) &&
      clientAttachmentManifest !== null &&
      hashKnowledgeBaseTurnRequest(clientAttachmentManifest) === manifestHash &&
      recoveredAttachments.length === attachments.length &&
      Number(metadata.userAttachmentCount) === attachments.length &&
      recoveredAttachments.every((value, index) => {
        const record = retryAuthorityRecord(value);
        return (
          record?.file_id === attachments[index]?.file_id &&
          record?.filename === attachments[index]?.filename
        );
      });
    if (!immutableMatch) {
      throw new KnowledgeBaseTurnReservationError(
        "KNOWLEDGE_BASE_REQUEST_REPLAY_MISMATCH",
        "The legacy attachment takeover was replayed with different content",
      );
    }
    return passiveExistingResult(row, now);
  });
}

/**
 * Creates the durable turn before any attachment upload or upstream POST.
 * Unknown network outcomes remain reserved until recovery with the original
 * upstream idempotency key. The only release path is a proven browser-upload
 * rejection before a request body or upstream task exists; that path retains
 * a cancelled tombstone and moves it off the canonical operation slot.
 */
export async function reserveKnowledgeBaseTurn(
  input: ReserveKnowledgeBaseTurnInput,
  executor?: any,
): Promise<KnowledgeBaseTurnReservation> {
  const db = executor ?? (await requireDb());
  return db.transaction((tx: any) =>
    reserveKnowledgeBaseTurnInTransaction(input, tx),
  );
}

async function lockKnowledgeBaseReservationCredential(
  tx: any,
  credentialId: string | null,
) {
  if (!credentialId) return null;
  return (
    await tx
      .select()
      .from(apiCredentials)
      .where(eq(apiCredentials.id, credentialId))
      .limit(1)
      .for("update")
  )[0] as { id: string; userId: number; status: string } | undefined;
}

/**
 * A brand-new operation may use only a credential that currently belongs to
 * the customer. Delivery ownership remains an authorization/reporting
 * relationship and never supplies a customer's model credential.
 *
 * Historical retry/recovery does not use this check: its authority is the
 * already-persisted active turn and is verified by the KB-only resolver in
 * auth-service.
 */
async function lockCurrentKnowledgeBaseCredentialAuthority(
  _tx: any,
  userId: number,
  credential: { id: string; userId: number; status: string } | null | undefined,
) {
  if (!credential || credential.status !== "active") return false;
  return credential.userId === userId;
}

function assertKnowledgeBaseReservationCredentialAvailable(
  credentialId: string | null,
  credential: { id: string; status: string } | null | undefined,
  options: { allowRetired?: boolean } = {},
) {
  if (!credentialId) return;
  if (
    !credential ||
    credential.id !== credentialId ||
    credential.status === "deleted" ||
    (!options.allowRetired && credential.status !== "active")
  ) {
    throw new KnowledgeBaseTurnReservationError(
      "CONFLICT",
      "The API credential pinned to this knowledge-base operation is no longer available",
    );
  }
}

async function reserveKnowledgeBaseTurnInTransaction(
  input: ReserveKnowledgeBaseTurnInput,
  tx: any,
): Promise<KnowledgeBaseTurnReservation> {
  assertInteger(input.userId, "userId", 1);
  const buildId = normalizeRequiredId(input.buildId, "buildId", 36);
  const clientRequestId = normalizeRequiredId(
    input.clientRequestId,
    "clientRequestId",
    128,
  );
  assertInteger(input.expectedGeneration, "expectedGeneration", 1);
  assertInteger(input.expectedRevision, "expectedRevision", 0);
  const expectedLeafId = normalizeOptionalLeafId(input.expectedLeafId);
  const expectedPresentationKey =
    input.expectedPresentationKey === undefined
      ? undefined
      : normalizeRequiredId(
          input.expectedPresentationKey,
          "expectedPresentationKey",
          191,
        );
  const clientIntentHash =
    input.clientIntent === undefined
      ? null
      : hashKnowledgeBaseTurnRequest(input.clientIntent);
  const replacesTurnId = input.replacesTurnId
    ? normalizeRequiredId(input.replacesTurnId, "replacesTurnId", 36)
    : null;
  if (input.operationType === "retry" ? !replacesTurnId : replacesTurnId) {
    throw new KnowledgeBaseTurnReservationError(
      "INVALID_REQUEST",
      input.operationType === "retry"
        ? "Retry reservations require the failed turn being replaced"
        : "Only retry reservations may replace a failed turn",
    );
  }
  const expectedAttachmentCount = input.expectedAttachmentCount ?? 0;
  assertInteger(expectedAttachmentCount, "expectedAttachmentCount", 0);
  if (expectedAttachmentCount > MAX_ATTACHMENT_COUNT) {
    throw new KnowledgeBaseTurnReservationError(
      "INVALID_REQUEST",
      `Too many attachments (maximum ${MAX_ATTACHMENT_COUNT})`,
    );
  }
  const userAttachmentCount =
    input.userAttachmentCount ?? expectedAttachmentCount;
  assertInteger(userAttachmentCount, "userAttachmentCount", 0);
  if (userAttachmentCount > MAX_USER_ATTACHMENT_COUNT) {
    throw new KnowledgeBaseTurnReservationError(
      "INVALID_REQUEST",
      `Too many customer attachments (maximum ${MAX_USER_ATTACHMENT_COUNT})`,
    );
  }
  if (userAttachmentCount > expectedAttachmentCount) {
    throw new KnowledgeBaseTurnReservationError(
      "INVALID_REQUEST",
      "Customer attachment count exceeds the reserved attachment count",
    );
  }
  const deferredClientAttachments =
    input.deferDispatchUntilAttachments === true;
  if (
    deferredClientAttachments &&
    input.clientAttachmentManifest === undefined
  ) {
    throw new KnowledgeBaseTurnReservationError(
      "INVALID_REQUEST",
      "Deferred dispatch requires a customer attachment manifest",
    );
  }
  const resetFencedDeferredOperation =
    deferredClientAttachments &&
    (input.operationType === "start" || input.operationType === "revise");
  if (
    resetFencedDeferredOperation &&
    (!Number.isSafeInteger(input.sourceResetRevision) ||
      Number(input.sourceResetRevision) < 0)
  ) {
    throw new KnowledgeBaseTurnReservationError(
      "INVALID_REQUEST",
      "Deferred start/revise dispatch requires the current reset revision",
    );
  }
  const clientAttachmentManifestHash =
    input.clientAttachmentManifest === undefined
      ? null
      : hashKnowledgeBaseTurnRequest(input.clientAttachmentManifest);
  const attachmentFileIds = normalizeAttachmentFileIds(
    input.attachmentFileIds ?? [],
  );
  if (
    input.attachmentFileIds !== undefined &&
    attachmentFileIds.length !== expectedAttachmentCount
  ) {
    throw new KnowledgeBaseTurnReservationError(
      "INVALID_REQUEST",
      "Frozen attachment ids do not match the expected attachment count",
    );
  }
  const requestHash = hashKnowledgeBaseTurnRequest({
    operationType: input.operationType,
    generation: input.expectedGeneration,
    revision: input.expectedRevision,
    leafId: expectedLeafId,
    expectedAttachmentCount,
    userAttachmentCount,
    payload: input.requestPayload,
  });
  const operationKey = createKnowledgeBaseOperationKey({
    buildId,
    buildGeneration: input.expectedGeneration,
    operationType: input.operationType,
    expectedRevision: input.expectedRevision,
    expectedLeafId,
    retryOfTurnId: replacesTurnId,
    operationInstanceId: input.operationInstanceId,
  });
  const upstreamIdempotencyKey =
    createKnowledgeBaseUpstreamIdempotencyKey(operationKey);
  const identity: KnowledgeBaseTurnIdentity = {
    buildId,
    buildGeneration: input.expectedGeneration,
    operationKey,
    operationType: input.operationType,
    expectedRevision: input.expectedRevision,
    expectedLeafId,
    requestHash,
    apiCredentialId: input.apiCredentialId ?? null,
  };
  const now = input.now ?? new Date();
  const leaseMs = input.leaseMs ?? DEFAULT_LEASE_MS;
  assertInteger(leaseMs, "leaseMs", 1_000);
  const leaseExpiresAt = new Date(now.getTime() + leaseMs);
  // Credential -> build is the global lock order shared with credential
  // revocation. A turn can therefore never be inserted after deletion has
  // checked for active references, nor can deletion cryptoshred a credential
  // after a new active turn has committed.
  const pinnedCredential = await lockKnowledgeBaseReservationCredential(
    tx,
    identity.apiCredentialId,
  );
  const hasCurrentCredentialAuthority =
    input.operationType !== "retry" && identity.apiCredentialId
      ? await lockCurrentKnowledgeBaseCredentialAuthority(
          tx,
          input.userId,
          pinnedCredential,
        )
      : null;
  if (resetFencedDeferredOperation) {
    const resetState = (
      await tx
        .select({ revision: knowledgeBaseResetStates.revision })
        .from(knowledgeBaseResetStates)
        .where(eq(knowledgeBaseResetStates.userId, input.userId))
        .limit(1)
        .for("update")
    )[0];
    if (resetState?.revision !== input.sourceResetRevision) {
      throw new KnowledgeBaseTurnReservationError(
        "KNOWLEDGE_BASE_RESET_REVISION_CHANGED",
        "知识库已完成重置，请清空旧资料后重新开始",
      );
    }
  }
  const buildRows = await tx
    .select()
    .from(knowledgeBaseBuilds)
    .where(
      and(
        eq(knowledgeBaseBuilds.id, buildId),
        eq(knowledgeBaseBuilds.userId, input.userId),
      ),
    )
    .limit(1)
    .for("update");
  const build = buildRows[0] as KnowledgeBaseBuild | undefined;
  if (!build) {
    throw new KnowledgeBaseTurnReservationError(
      "BUILD_NOT_FOUND",
      "Knowledge-base build was not found",
    );
  }
  if (
    knowledgeBaseMaterializedRecoveryContractVersion(build) !== 1 ||
    knowledgeBaseMaterializedCompletionContractVersion(build) !==
      KNOWLEDGE_BASE_MATERIALIZED_COMPLETION_CONTRACT_VERSION
  ) {
    // A turn may inherit dispatch authority only from the immutable birth
    // provenance of a reset-created materialized build. Never create, replay,
    // or take over a turn on an older row and never upgrade that row here.
    throw new KnowledgeBaseTurnReservationError(
      "RESET_REQUIRED",
      "旧知识库构建不再续跑；请批准重置并重新上传资料",
    );
  }
  const conversationId = await ensureConversation(
    tx,
    build,
    identity.apiCredentialId,
    now,
  );
  const clientRows = await tx
    .select()
    .from(conversationTurns)
    .where(
      and(
        eq(conversationTurns.conversationId, conversationId),
        eq(conversationTurns.clientRequestId, clientRequestId),
      ),
    )
    .limit(1)
    .for("update");
  const operationRows = await tx
    .select()
    .from(conversationTurns)
    .where(eq(conversationTurns.operationKey, operationKey))
    .limit(1)
    .for("update");
  const byClient = clientRows[0] as ConversationTurn | undefined;
  const byOperation = operationRows[0] as ConversationTurn | undefined;
  if (
    byClient?.status === "cancelled" &&
    releasedOperationTombstone(metadataOf(byClient)) &&
    (!byOperation || byOperation.id !== byClient.id)
  ) {
    // The cancelled row deliberately moved off the canonical operation slot
    // so a new clientRequestId can upload a replacement. A delayed replay of
    // the old browser request remains terminal and must not conflict with or
    // seize the new active operation.
    return existingResult(byClient, { state: "terminal" });
  }
  if (byClient && byOperation && byClient.id !== byOperation.id) {
    throw new KnowledgeBaseTurnReservationError(
      "CONFLICT",
      "Client request id and operation slot refer to different turns",
    );
  }
  const existing = byClient ?? byOperation;
  if (existing) {
    if (
      input.operationType === "start" &&
      existing.clientRequestId !== clientRequestId
    ) {
      throw new KnowledgeBaseTurnReservationError(
        "CONFLICT",
        "Knowledge-base start request id was already used by another request",
      );
    }
    const existingMetadata = metadataOf(existing);
    if (clientIntentHash) {
      if (existingMetadata.clientIntentHash !== clientIntentHash) {
        throw new KnowledgeBaseTurnReservationError(
          "KNOWLEDGE_BASE_REQUEST_REPLAY_MISMATCH",
          "The client request id was already used for different content",
        );
      }
      return passiveExistingResult(existing, now);
    }
    if (
      !deferredClientAttachments &&
      input.resumeLegacyAttachmentTakeover === true &&
      (existingMetadata.awaitingClientAttachments === true ||
        existingMetadata.legacyUploadFirstTakeover === true)
    ) {
      const existingRecovery = retryAuthorityRecord(existingMetadata.recovery);
      const rawIncomingRecovery = sanitizeKnowledgeBaseRecoveryMetadata(
        input.recoveryMetadata,
      );
      const incomingAttachmentsValue = rawIncomingRecovery.attachments;
      const incomingAttachments = Array.isArray(incomingAttachmentsValue)
        ? normalizeDeferredUserAttachments(
            incomingAttachmentsValue.map((value) => {
              const record = retryAuthorityRecord(value);
              return {
                file_id: String(record?.file_id || ""),
                filename: String(record?.filename || ""),
              };
            }),
          )
        : [];
      const legacyManifest = Array.isArray(existingRecovery?.attachmentManifest)
        ? existingRecovery.attachmentManifest
        : [];
      const incomingManifest = Array.isArray(input.clientAttachmentManifest)
        ? input.clientAttachmentManifest
        : [];
      const legacyManifestHash = hashKnowledgeBaseTurnRequest(legacyManifest);
      const incomingManifestHash =
        hashKnowledgeBaseTurnRequest(incomingManifest);
      const canonicalRecovery = sanitizeKnowledgeBaseRecoveryMetadata({
        ...rawIncomingRecovery,
        // A browser may have lost its local pending message. The durable
        // reservation remains the sole authority for the logical user intent.
        userMessage: existingRecovery?.userMessage,
        conversationId: existingRecovery?.conversationId,
        parentTaskId: existingRecovery?.parentTaskId,
        skillVersion: existingRecovery?.skillVersion,
        skillContentHash: existingRecovery?.skillContentHash,
        attachments: incomingAttachments,
        attachmentManifest: legacyManifest,
        deferredClientAttachments: false,
      });
      const legacyStaged = Array.isArray(
        existingMetadata.clientStagedAttachments,
      )
        ? existingMetadata.clientStagedAttachments
        : [];
      const legacyExpectedAttachmentCount = Number(
        existingMetadata.expectedAttachmentCount,
      );
      const legacyUserAttachmentCount = Number(
        existingMetadata.userAttachmentCount,
      );
      const takeoverRequestPayload = retryAuthorityRequestPayload({
        operationType: input.operationType,
        recovery: canonicalRecovery,
      });
      const canonicalRequestHash = takeoverRequestPayload
        ? hashKnowledgeBaseTurnRequest({
            operationType: input.operationType,
            generation: input.expectedGeneration,
            revision: input.expectedRevision,
            leafId: expectedLeafId,
            expectedAttachmentCount,
            userAttachmentCount,
            payload: takeoverRequestPayload,
          })
        : null;
      const canonicalIdentity: KnowledgeBaseTurnIdentity = {
        ...identity,
        requestHash: canonicalRequestHash || identity.requestHash,
      };
      const legacyAttachmentLedgerIsValid =
        legacyStaged.length === (existing.attachmentFileIds ?? []).length &&
        legacyStaged.every(
          (attachment, index) =>
            attachment.index === index &&
            attachment.file_id === existing.attachmentFileIds[index],
        );
      const sameTurnIdentity =
        existing.userId === input.userId &&
        build.userId === input.userId &&
        build.id === buildId &&
        existing.clientRequestId === clientRequestId &&
        existing.buildId === canonicalIdentity.buildId &&
        existing.buildGeneration === canonicalIdentity.buildGeneration &&
        existing.operationKey === canonicalIdentity.operationKey &&
        existing.operationType === canonicalIdentity.operationType &&
        existing.expectedRevision === canonicalIdentity.expectedRevision &&
        (existing.expectedLeafId ?? null) ===
          canonicalIdentity.expectedLeafId &&
        (existing.apiCredentialId ?? null) ===
          canonicalIdentity.apiCredentialId;
      const samePinnedIntent =
        existingRecovery?.kind === "turn" &&
        rawIncomingRecovery.kind === "turn" &&
        existingRecovery.conversationId === canonicalRecovery.conversationId &&
        existingRecovery.parentTaskId === canonicalRecovery.parentTaskId &&
        existingRecovery.userMessage === canonicalRecovery.userMessage &&
        existingRecovery.skillVersion === rawIncomingRecovery.skillVersion &&
        (existingRecovery.skillContentHash ?? null) ===
          (rawIncomingRecovery.skillContentHash ?? null) &&
        legacyExpectedAttachmentCount === expectedAttachmentCount &&
        legacyUserAttachmentCount === userAttachmentCount &&
        incomingAttachments.length === userAttachmentCount &&
        legacyManifest.length === userAttachmentCount &&
        incomingManifest.length === userAttachmentCount &&
        existingMetadata.clientAttachmentManifestHash === legacyManifestHash &&
        incomingManifestHash === legacyManifestHash &&
        legacyManifest.every((value, index) => {
          const record = retryAuthorityRecord(value);
          return record?.filename === incomingAttachments[index]?.filename;
        }) &&
        Boolean(canonicalRequestHash);

      if (!sameTurnIdentity || !samePinnedIntent) {
        throw new KnowledgeBaseTurnReservationError(
          "CONFLICT",
          "The uploaded files cannot take over this deferred attachment turn",
        );
      }

      if (existingMetadata.legacyUploadFirstTakeover === true) {
        const replayDecision = evaluateKnowledgeBaseTurnReplay(
          existing,
          canonicalIdentity,
          now,
        );
        if (replayDecision.state === "conflict") {
          throw new KnowledgeBaseTurnReservationError(
            "CONFLICT",
            "The legacy attachment takeover was replayed with different content",
          );
        }
        if (replayDecision.state !== "expired") {
          return existingResult(existing, replayDecision);
        }
        assertKnowledgeBaseReservationCredentialAvailable(
          canonicalIdentity.apiCredentialId,
          pinnedCredential,
          { allowRetired: true },
        );
        const replayLeaseToken = randomUUID();
        const replayMetadata: KnowledgeBaseTurnMetadata = {
          ...existingMetadata,
          leaseOwnerHash: leaseOwnerHash(replayLeaseToken),
          recovery: canonicalRecovery,
        };
        await tx
          .update(conversationTurns)
          .set({
            metadata: replayMetadata,
            leaseExpiresAt,
            updatedAt: now,
          })
          .where(eq(conversationTurns.id, existing.id));
        return {
          ...acquiredResult(
            {
              ...existing,
              metadata: replayMetadata,
              leaseExpiresAt,
              updatedAt: now,
            },
            replayLeaseToken,
            leaseExpiresAt,
          ),
          recoveryMetadata: canonicalRecovery,
        };
      }

      const sameActiveLegacyScope =
        build.generation === input.expectedGeneration &&
        build.revision === input.expectedRevision &&
        (build.currentLeafId ?? null) === expectedLeafId &&
        build.status === "confirming" &&
        build.activeTurnId === existing.id &&
        build.conversationId === existingRecovery?.conversationId &&
        String(build.upstreamTaskId || "") ===
          String(existingRecovery?.parentTaskId || "");
      const safelyUnstarted =
        existing.status === "queued" &&
        !existing.upstreamTaskId &&
        !existing.leaseExpiresAt &&
        existingMetadata.attachmentsFrozen !== true &&
        !existingMetadata.preparedDispatch &&
        Object.keys(generatedAttachmentReservations(existingMetadata))
          .length === 0 &&
        Boolean(existing.operationKey) &&
        existing.upstreamIdempotencyKeyHash ===
          hashKnowledgeBaseUpstreamIdempotencyKey(
            createKnowledgeBaseUpstreamIdempotencyKey(
              String(existing.operationKey),
            ),
          ) &&
        legacyAttachmentLedgerIsValid;

      if (!sameActiveLegacyScope || !safelyUnstarted) {
        throw new KnowledgeBaseTurnReservationError(
          "CONFLICT",
          "The uploaded files cannot take over this deferred attachment turn",
        );
      }
      assertKnowledgeBaseReservationCredentialAvailable(
        identity.apiCredentialId,
        pinnedCredential,
        { allowRetired: true },
      );

      const leaseToken = randomUUID();
      const {
        clientStagedAttachments: _legacyStagedAttachments,
        ...metadataWithoutBrowserReservation
      } = existingMetadata;
      const nextMetadata: KnowledgeBaseTurnMetadata = {
        ...metadataWithoutBrowserReservation,
        attachmentsFrozen: false,
        expectedAttachmentCount,
        userAttachmentCount,
        awaitingClientAttachments: false,
        legacyUploadFirstTakeover: true,
        leaseOwnerHash: leaseOwnerHash(leaseToken),
        recovery: canonicalRecovery,
      };
      const takenOverTurn = {
        ...existing,
        requestHash: canonicalIdentity.requestHash,
        attachmentFileIds: [],
        metadata: nextMetadata,
        leaseExpiresAt,
        updatedAt: now,
      } satisfies ConversationTurn;
      await tx
        .update(conversationTurns)
        .set({
          requestHash: canonicalIdentity.requestHash,
          attachmentFileIds: [],
          metadata: nextMetadata,
          leaseExpiresAt,
          updatedAt: now,
        })
        .where(eq(conversationTurns.id, existing.id));
      await tx
        .update(knowledgeBaseBuilds)
        .set({
          stateEpoch: build.stateEpoch + 1,
          awaitingResponseSince: now,
          lastTurnUserText: String(canonicalRecovery.userMessage ?? "").slice(
            0,
            2_000_000,
          ),
          lastTurnAttachmentCount: userAttachmentCount,
          updatedAt: now,
        })
        .where(
          and(
            eq(knowledgeBaseBuilds.id, build.id),
            eq(knowledgeBaseBuilds.userId, input.userId),
            eq(knowledgeBaseBuilds.generation, input.expectedGeneration),
            eq(knowledgeBaseBuilds.activeTurnId, existing.id),
          ),
        );
      return {
        ...acquiredResult(takenOverTurn, leaseToken, leaseExpiresAt),
        recoveryMetadata: canonicalRecovery,
      };
    }
    if (
      deferredClientAttachments &&
      input.resumeDeferredReservation === true &&
      !String(input.userText ?? "").trim() &&
      existing.clientRequestId === clientRequestId &&
      existingMetadata.awaitingClientAttachments === true &&
      existingMetadata.clientAttachmentManifestHash ===
        clientAttachmentManifestHash &&
      existing.buildId === identity.buildId &&
      existing.buildGeneration === identity.buildGeneration &&
      existing.operationType === identity.operationType &&
      existing.expectedRevision === identity.expectedRevision &&
      (existing.expectedLeafId ?? null) === identity.expectedLeafId &&
      (existing.apiCredentialId ?? null) === identity.apiCredentialId
    ) {
      return { state: "awaiting_attachments", turn: turnRecord(existing) };
    }
    const decision = evaluateKnowledgeBaseTurnReplay(existing, identity, now);
    if (decision.state === "conflict") {
      throw new KnowledgeBaseTurnReservationError(
        input.operationType === "start" &&
        existing.clientRequestId === clientRequestId
          ? "KNOWLEDGE_BASE_REQUEST_REPLAY_MISMATCH"
          : "CONFLICT",
        "The request id or knowledge-base operation slot was already used for different content",
      );
    }
    if (deferredClientAttachments) {
      if (
        existingMetadata.clientAttachmentManifestHash !==
        clientAttachmentManifestHash
      ) {
        throw new KnowledgeBaseTurnReservationError(
          "CONFLICT",
          "The reserved customer attachment manifest does not match this request",
        );
      }
      if (existingMetadata.awaitingClientAttachments === true) {
        return { state: "awaiting_attachments", turn: turnRecord(existing) };
      }
      // Once uploaded file ids have been bound, `/turn/reserve` is only an
      // observation/replay endpoint. It must never seize a new worker lease or
      // recreate an upstream task; `/turn/dispatch` and the recovery worker own
      // that durable continuation.
      if (decision.state === "expired") {
        return {
          state: "pending",
          turn: turnRecord(existing),
          retryAfterMs: 1_000,
        };
      }
    }
    if (decision.state !== "expired") {
      return existingResult(existing, decision);
    }
    assertKnowledgeBaseReservationCredentialAvailable(
      identity.apiCredentialId,
      pinnedCredential,
      { allowRetired: true },
    );
    const leaseToken = randomUUID();
    const metadata = {
      ...metadataOf(existing),
      leaseOwnerHash: leaseOwnerHash(leaseToken),
    } satisfies KnowledgeBaseTurnMetadata;
    const turnUpdated = await tx
      .update(conversationTurns)
      .set({ metadata, leaseExpiresAt, updatedAt: now })
      .where(eq(conversationTurns.id, existing.id));
    return acquiredResult(
      { ...existing, metadata, leaseExpiresAt, updatedAt: now },
      leaseToken,
      leaseExpiresAt,
    );
  }

  if (input.resumeLegacyAttachmentTakeover === true) {
    throw new KnowledgeBaseTurnReservationError(
      "CONFLICT",
      "The legacy attachment reservation no longer exists",
    );
  }

  if (
    build.recoveryLeaseExpiresAt &&
    build.recoveryLeaseExpiresAt.getTime() > now.getTime()
  ) {
    throw new KnowledgeBaseTurnReservationError(
      "IDEMPOTENCY_PENDING",
      "Knowledge-base recovery currently owns this build",
      Math.max(
        250,
        Math.min(5_000, build.recoveryLeaseExpiresAt.getTime() - now.getTime()),
      ),
    );
  }
  assertOperationMatchesBuild(build, {
    ...input,
    buildId,
    expectedLeafId,
    expectedPresentationKey,
  });
  if (build.activeTurnId) {
    const activeRows = await tx
      .select()
      .from(conversationTurns)
      .where(eq(conversationTurns.id, build.activeTurnId))
      .limit(1)
      .for("update");
    const active = activeRows[0] as ConversationTurn | undefined;
    const maySupersedeSettledProtocolError =
      input.operationType === "retry" &&
      build.status === "protocol_error" &&
      active?.id === replacesTurnId &&
      active.status === "failed" &&
      active.buildId === build.id &&
      active.buildGeneration === build.generation &&
      (active.apiCredentialId ?? null) === identity.apiCredentialId &&
      active.expectedRevision === build.revision &&
      (active.expectedLeafId ?? null) === (build.currentLeafId ?? null);
    if (!active || !maySupersedeSettledProtocolError) {
      throw new KnowledgeBaseTurnReservationError(
        "IDEMPOTENCY_PENDING",
        "Another turn is already active for this build",
        1_000,
      );
    }
  }

  if (input.operationType === "retry") {
    assertKnowledgeBaseReservationCredentialAvailable(
      identity.apiCredentialId,
      pinnedCredential,
      { allowRetired: true },
    );
  } else if (hasCurrentCredentialAuthority === false) {
    throw new KnowledgeBaseTurnReservationError(
      "CONFLICT",
      "The API credential selected for this new knowledge-base operation is no longer authorized for the account",
    );
  }
  const id = randomUUID();
  const leaseToken = randomUUID();
  const attachmentsFrozen =
    input.attachmentFileIds !== undefined || expectedAttachmentCount === 0;
  const sanitizedRecovery = sanitizeKnowledgeBaseRecoveryMetadata(
    input.recoveryMetadata,
  );
  const traceId = safeKnowledgeBaseTraceId(sanitizedRecovery.traceId);
  const metadata: KnowledgeBaseTurnMetadata = {
    ...(deferredClientAttachments
      ? {}
      : { leaseOwnerHash: leaseOwnerHash(leaseToken) }),
    attachmentsFrozen,
    expectedAttachmentCount,
    userAttachmentCount,
    ...(deferredClientAttachments
      ? {
          awaitingClientAttachments: true,
          clientAttachmentManifestHash: clientAttachmentManifestHash!,
          clientStagedAttachments: [],
        }
      : clientAttachmentManifestHash
        ? { clientAttachmentManifestHash }
        : {}),
    ...(clientIntentHash ? { clientIntentHash } : {}),
    ...(input.sourceResetRevision !== undefined
      ? { sourceResetRevision: input.sourceResetRevision }
      : {}),
    ...(expectedPresentationKey ? { expectedPresentationKey } : {}),
    recovery: sanitizedRecovery,
    ...(traceId ? { traceId } : {}),
    ...(knowledgeBaseMaterializedRecoveryContractVersion(build) === 1
      ? { materializedRecoveryContractVersion: 1 as const }
      : {}),
    ...(knowledgeBaseMaterializedCompletionContractVersion(build) ===
    KNOWLEDGE_BASE_MATERIALIZED_COMPLETION_CONTRACT_VERSION
      ? {
          materializedCompletionContractVersion:
            KNOWLEDGE_BASE_MATERIALIZED_COMPLETION_CONTRACT_VERSION,
        }
      : {}),
    createAttemptState: "not_sent",
    createAttemptUpdatedAt: now.toISOString(),
    // Persist the protocol authority at reservation time. Recovery must never
    // infer a v2 turn from an in-memory dispatch mutation after a crash.
    providerProtocol:
      build.providerProtocol === "manus_v2" ? "manus_v2" : "legacy_v1",
    providerAttemptState: "not_sent",
    operationToken: operationKey,
    dispatchState: "reserved",
    failureClass: null,
    recoveryAction: "wait",
    canRegenerate: false,
  };
  const row: ConversationTurn = {
    id,
    conversationId,
    userId: input.userId,
    apiCredentialId: identity.apiCredentialId,
    clientRequestId,
    buildId,
    buildGeneration: input.expectedGeneration,
    operationKey,
    operationType: input.operationType,
    expectedRevision: input.expectedRevision,
    expectedLeafId,
    requestHash,
    upstreamIdempotencyKeyHash: hashKnowledgeBaseUpstreamIdempotencyKey(
      upstreamIdempotencyKey,
    ),
    attachmentFileIds,
    metadata,
    leaseExpiresAt: deferredClientAttachments ? null : leaseExpiresAt,
    model: null,
    status: "queued",
    upstreamTaskId: null,
    errorCode: null,
    errorMessage: null,
    startedAt: null,
    completedAt: null,
    createdAt: now,
    updatedAt: now,
  };
  await tx.insert(conversationTurns).values(row);
  await persistKnowledgeBaseUserMessageInTransaction({
    tx,
    userId: input.userId,
    conversationId,
    turnId: id,
    buildId,
    generation: input.expectedGeneration,
    operationKey,
    clientRequestId,
    revision: input.expectedRevision,
    leafId: expectedLeafId,
    content:
      input.operationType === "retry"
        ? "重试本轮"
        : String(input.userText ?? ""),
    sentAt: now,
  });
  await tx
    .update(knowledgeBaseBuilds)
    .set({
      activeTurnId: id,
      recoveryLeaseOwnerHash: null,
      recoveryLeaseExpiresAt: null,
      stateEpoch: build.stateEpoch + 1,
      ...(input.operationType === "retry"
        ? {
            status: (input.recoveryMetadata?.kind === "start"
              ? "researching"
              : "confirming") as KnowledgeBaseBuild["status"],
            upstreamTaskId: null,
            protocolErrorCode: null,
            protocolError: null,
          }
        : {}),
      awaitingResponseSince: now,
      lastTurnUserText: String(input.userText ?? "").slice(0, 2_000_000),
      lastTurnAttachmentCount: userAttachmentCount,
      updatedAt: now,
    })
    .where(
      and(
        eq(knowledgeBaseBuilds.id, build.id),
        eq(knowledgeBaseBuilds.userId, input.userId),
        eq(knowledgeBaseBuilds.generation, input.expectedGeneration),
      ),
    );
  return deferredClientAttachments
    ? { state: "awaiting_attachments", turn: turnRecord(row) }
    : acquiredResult(row, leaseToken, leaseExpiresAt);
}

function pinnedStartPayload(
  build: KnowledgeBaseBuild,
  payload: Record<string, unknown>,
  researchWebsites: readonly string[],
) {
  return {
    ...payload,
    companyName: build.companyName,
    companyWebsite: build.companyWebsite || "",
    researchWebsites: [...researchWebsites],
    skillVersion: build.skillVersion,
    skillContentHash: build.skillContentHash,
    skillArchiveSha256: build.skillArchiveSha256,
    skillArchiveBytes: build.skillArchiveBytes,
    skillArchiveStorageKey: build.skillArchiveStorageKey,
  };
}

function normalizeKnowledgeBaseStartPrefillSnapshotId(
  value: unknown,
  name: string,
) {
  if (value === undefined || value === null || value === "") return null;
  const raw = String(value);
  const normalized = normalizeRequiredId(raw, name, 36);
  if (normalized !== raw) {
    throw new KnowledgeBaseTurnReservationError(
      "INVALID_REQUEST",
      `${name} is not canonical`,
    );
  }
  return normalized;
}

function knowledgeBaseStartPrefillSnapshotId(
  input: ReserveKnowledgeBaseStartBuildInput,
) {
  const declarations: Array<string | null> = [];
  if (Object.prototype.hasOwnProperty.call(input, "prefillSnapshotId")) {
    declarations.push(
      normalizeKnowledgeBaseStartPrefillSnapshotId(
        input.prefillSnapshotId,
        "prefillSnapshotId",
      ),
    );
  }
  if (
    Object.prototype.hasOwnProperty.call(
      input.requestPayload,
      "prefillSnapshotId",
    )
  ) {
    declarations.push(
      normalizeKnowledgeBaseStartPrefillSnapshotId(
        input.requestPayload.prefillSnapshotId,
        "requestPayload.prefillSnapshotId",
      ),
    );
  }
  if (
    Object.prototype.hasOwnProperty.call(
      input.recoveryMetadata,
      "prefillSnapshotId",
    )
  ) {
    declarations.push(
      normalizeKnowledgeBaseStartPrefillSnapshotId(
        input.recoveryMetadata.prefillSnapshotId,
        "recoveryMetadata.prefillSnapshotId",
      ),
    );
  }
  if (new Set(declarations).size > 1) {
    throw new KnowledgeBaseTurnReservationError(
      "INVALID_REQUEST",
      "Knowledge-base start prefill snapshot identity is inconsistent",
    );
  }
  return declarations[0] ?? null;
}

function normalizeKnowledgeBaseStartAttachmentIdentities(
  value: unknown,
  name: string,
) {
  if (value === undefined) return [];
  if (!Array.isArray(value)) {
    throw new KnowledgeBaseTurnReservationError(
      "INVALID_REQUEST",
      `${name} is invalid`,
    );
  }
  const attachments = value.map((entry) => {
    const record = retryAuthorityRecord(entry);
    if (!record) {
      throw new KnowledgeBaseTurnReservationError(
        "INVALID_REQUEST",
        `${name} is invalid`,
      );
    }
    const rawFileId = String(record.file_id || "");
    const fileId = normalizeRequiredId(
      rawFileId,
      "attachmentFileId",
      MAX_ATTACHMENT_ID_LENGTH,
    );
    if (fileId !== rawFileId) {
      throw new KnowledgeBaseTurnReservationError(
        "INVALID_REQUEST",
        `${name} contains a non-canonical attachment file id`,
      );
    }
    return {
      file_id: fileId,
      filename: String(record.filename || ""),
    };
  });
  normalizeAttachmentFileIds(
    attachments.map((attachment) => attachment.file_id),
  );
  return attachments;
}

function knowledgeBaseStartAttachmentFileIds(
  input: ReserveKnowledgeBaseStartBuildInput,
) {
  const requestAttachments = normalizeKnowledgeBaseStartAttachmentIdentities(
    input.requestPayload.attachments,
    "requestPayload.attachments",
  );
  const recoveryAttachments = normalizeKnowledgeBaseStartAttachmentIdentities(
    input.recoveryMetadata.attachments,
    "recoveryMetadata.attachments",
  );
  if (
    hashKnowledgeBaseTurnRequest(requestAttachments) !==
    hashKnowledgeBaseTurnRequest(recoveryAttachments)
  ) {
    throw new KnowledgeBaseTurnReservationError(
      "INVALID_REQUEST",
      "Knowledge-base start attachment metadata is inconsistent",
    );
  }
  const userAttachmentCount =
    input.userAttachmentCount ?? requestAttachments.length;
  assertInteger(userAttachmentCount, "userAttachmentCount", 0);
  if (input.deferDispatchUntilAttachments === true) {
    if (requestAttachments.length !== 0 || recoveryAttachments.length !== 0) {
      throw new KnowledgeBaseTurnReservationError(
        "INVALID_REQUEST",
        "Deferred knowledge-base start cannot bind provider files before upload",
      );
    }
    if (!Array.isArray(input.clientAttachmentManifest)) {
      throw new KnowledgeBaseTurnReservationError(
        "INVALID_REQUEST",
        "Deferred knowledge-base start requires an attachment manifest",
      );
    }
    if (input.clientAttachmentManifest.length !== userAttachmentCount) {
      throw new KnowledgeBaseTurnReservationError(
        "INVALID_REQUEST",
        "Deferred knowledge-base start manifest count is inconsistent",
      );
    }
    return [];
  }
  if (userAttachmentCount !== requestAttachments.length) {
    throw new KnowledgeBaseTurnReservationError(
      "INVALID_REQUEST",
      "Knowledge-base start attachment count is inconsistent",
    );
  }
  return requestAttachments.map((attachment) => attachment.file_id);
}

async function lockKnowledgeBaseStartAttachments(input: {
  tx: any;
  userId: number;
  apiCredentialId: string | null;
  conversationId: string;
  attachmentFileIds: readonly string[];
}) {
  if (input.attachmentFileIds.length === 0) return [];
  if (!input.apiCredentialId) {
    throw new KnowledgeBaseTurnReservationError(
      "CONFLICT",
      "Knowledge-base start attachments require an available API credential",
    );
  }
  const rows = (await input.tx
    .select()
    .from(upstreamResources)
    .where(
      and(
        eq(upstreamResources.kind, "file"),
        inArray(upstreamResources.upstreamId, input.attachmentFileIds),
      ),
    )
    .limit(input.attachmentFileIds.length)
    .for("update")) as UpstreamResource[];
  const byFileId = new Map(
    rows.map((resource) => [resource.upstreamId, resource] as const),
  );
  const orderedResources = input.attachmentFileIds.map((fileId) =>
    byFileId.get(fileId),
  );
  const invalid = orderedResources.some(
    (resource) =>
      !resource ||
      resource.userId !== input.userId ||
      (resource.projectAssignmentId ?? null) !== null ||
      resource.apiCredentialId !== input.apiCredentialId ||
      resource.kind !== "file" ||
      Boolean(resource.contentDeletedAt) ||
      !(
        resource.conversationId === null ||
        resource.conversationId === input.conversationId
      ),
  );
  if (invalid) {
    throw new KnowledgeBaseTurnReservationError(
      "CONFLICT",
      "One or more knowledge-base start attachments are unavailable, owned by another workspace, or already bound",
    );
  }
  return orderedResources as UpstreamResource[];
}

async function bindKnowledgeBaseStartAttachments(input: {
  tx: any;
  userId: number;
  apiCredentialId: string | null;
  conversationId: string;
  resources: readonly UpstreamResource[];
}) {
  if (input.resources.length === 0) return;
  if (!input.apiCredentialId) {
    throw new KnowledgeBaseTurnReservationError(
      "CONFLICT",
      "Knowledge-base start attachment credential was lost",
    );
  }
  await input.tx
    .update(upstreamResources)
    .set({ conversationId: input.conversationId })
    .where(
      and(
        inArray(
          upstreamResources.id,
          input.resources.map((resource) => resource.id),
        ),
        eq(upstreamResources.userId, input.userId),
        isNull(upstreamResources.projectAssignmentId),
        eq(upstreamResources.apiCredentialId, input.apiCredentialId),
        eq(upstreamResources.kind, "file"),
        isNull(upstreamResources.contentDeletedAt),
        or(
          isNull(upstreamResources.conversationId),
          eq(upstreamResources.conversationId, input.conversationId),
        ),
      ),
    );
  const reboundRows = (await input.tx
    .select()
    .from(upstreamResources)
    .where(
      inArray(
        upstreamResources.id,
        input.resources.map((resource) => resource.id),
      ),
    )
    .limit(input.resources.length)) as UpstreamResource[];
  const reboundById = new Map(
    reboundRows.map((resource) => [resource.id, resource] as const),
  );
  if (
    input.resources.some(
      (resource) =>
        reboundById.get(resource.id)?.conversationId !== input.conversationId,
    )
  ) {
    throw new KnowledgeBaseTurnReservationError(
      "CONFLICT",
      "Knowledge-base start attachments could not be bound atomically",
    );
  }
}

/**
 * The only entry point for a new build. The build, internal conversation and
 * first start turn commit together; any failure rolls all three back.
 */
export async function reserveKnowledgeBaseStartBuild(
  input: ReserveKnowledgeBaseStartBuildInput,
  executor?: any,
): Promise<KnowledgeBaseStartBuildReservation> {
  assertInteger(input.userId, "userId", 1);
  assertInteger(input.expectedResetRevision, "expectedResetRevision", 0);
  const conversationId = normalizeRequiredId(
    input.conversationId,
    "conversationId",
    191,
  );
  let companyName: string;
  let companyWebsite: string | null;
  let researchWebsites: string[];
  try {
    companyName = canonicalizeKnowledgeBaseCompanyName(input.companyName);
    const websites = canonicalizeKnowledgeBaseWebsiteLines(
      input.companyWebsite,
    );
    companyWebsite = websites.primary;
    researchWebsites = websites.researchWebsites;
  } catch (error) {
    if (error instanceof KnowledgeBaseCompanyIdentityNormalizationError) {
      throw new KnowledgeBaseTurnReservationError(
        "INVALID_REQUEST",
        error.message,
      );
    }
    throw error;
  }
  const skillName = normalizeRequiredId(input.skillName, "skillName", 128);
  const skillVersion = normalizeRequiredId(
    input.skillVersion,
    "skillVersion",
    64,
  );
  const skillContentHash = input.skillContentHash
    ? normalizeRequiredId(input.skillContentHash, "skillContentHash", 64)
    : null;
  const skillArchiveSha256 = input.skillArchiveSha256
    ? normalizeRequiredId(input.skillArchiveSha256, "skillArchiveSha256", 64)
    : null;
  if (skillArchiveSha256 && !/^[a-f0-9]{64}$/u.test(skillArchiveSha256)) {
    throw new KnowledgeBaseTurnReservationError(
      "INVALID_REQUEST",
      "The pinned Skill physical SHA-256 is invalid",
    );
  }
  const skillArchiveBytes = input.skillArchiveBytes ?? null;
  if (
    skillArchiveBytes !== null &&
    (!Number.isSafeInteger(skillArchiveBytes) || skillArchiveBytes <= 0)
  ) {
    throw new KnowledgeBaseTurnReservationError(
      "INVALID_REQUEST",
      "The pinned Skill archive size is invalid",
    );
  }
  const skillArchiveStorageKey = input.skillArchiveStorageKey
    ? normalizeRequiredId(
        input.skillArchiveStorageKey,
        "skillArchiveStorageKey",
        1_024,
      )
    : null;
  const policyBinding = knowledgeBaseNewBuildPolicyBinding();
  if (
    input.treePolicyVersion !== undefined &&
    input.treePolicyVersion !== policyBinding.treePolicyVersion
  ) {
    throw new KnowledgeBaseTurnReservationError(
      "INVALID_REQUEST",
      "All new knowledge-base builds require the materialized v5 tree policy",
    );
  }
  const providerProtocol = "manus_v2" as const;
  if (
    skillVersion !== policyBinding.skillVersion ||
    skillContentHash !== policyBinding.skillContentHash
  ) {
    throw new KnowledgeBaseTurnReservationError(
      "INVALID_REQUEST",
      "The new knowledge-base policy and immutable Skill binding do not match",
    );
  }
  const pinnedSkillArchive =
    await readKnowledgeBasePinnedSkillArchiveAttachment({
      version: skillVersion,
      contentHash: skillContentHash,
      physicalSha256: skillArchiveSha256,
      archiveBytes: skillArchiveBytes,
      storageKey: skillArchiveStorageKey,
    });
  if (
    (skillArchiveSha256 ||
      skillArchiveBytes !== null ||
      skillArchiveStorageKey) &&
    (skillArchiveSha256 !== pinnedSkillArchive.physicalSha256 ||
      skillArchiveBytes !== pinnedSkillArchive.archiveBytes ||
      skillArchiveStorageKey !== pinnedSkillArchive.storageKey)
  ) {
    throw new KnowledgeBaseTurnReservationError(
      "INVALID_REQUEST",
      "The new build Skill physical pin is not a controlled durable archive",
    );
  }
  const now = input.now ?? new Date();
  const prefillSnapshotId = knowledgeBaseStartPrefillSnapshotId(input);
  const startAttachmentFileIds = knowledgeBaseStartAttachmentFileIds(input);
  const storedConversationId = knowledgeBaseConversationStorageId(
    input.userId,
    conversationId,
  );
  const db = executor ?? (await requireDb());

  return db.transaction(async (tx: any) => {
    // Global mutation lock order is credential -> current owner slot ->
    // knowledge reset state -> start attachment ownership -> active reset
    // tombstone -> retained reset tombstone -> build -> turn. Locking every
    // requested upload here closes the discard/start race across processes
    // and database replicas.
    const pinnedCredential = await lockKnowledgeBaseReservationCredential(
      tx,
      input.apiCredentialId ?? null,
    );
    if (input.apiCredentialId) {
      if (
        !(await lockCurrentKnowledgeBaseCredentialAuthority(
          tx,
          input.userId,
          pinnedCredential,
        ))
      ) {
        throw new KnowledgeBaseTurnReservationError(
          "CONFLICT",
          "The API credential selected for this new knowledge-base build is no longer authorized for the account",
        );
      }
    }
    // The reset row is the shared epoch authority for every browser tab. The
    // same row is updated by approval before old builds are removed, so a
    // delayed start request can never recreate state from an older revision.
    await tx
      .insert(knowledgeBaseResetStates)
      .values({
        userId: input.userId,
        revision: 0,
        updatedAt: now,
      })
      .onDuplicateKeyUpdate({
        set: { userId: input.userId },
      });
    const resetState = (
      await tx
        .select({ revision: knowledgeBaseResetStates.revision })
        .from(knowledgeBaseResetStates)
        .where(eq(knowledgeBaseResetStates.userId, input.userId))
        .limit(1)
        .for("update")
    )[0];
    if (resetState?.revision !== input.expectedResetRevision) {
      throw new KnowledgeBaseTurnReservationError(
        "KNOWLEDGE_BASE_RESET_REVISION_CHANGED",
        "知识库已完成重置，请清空旧资料后重新开始",
      );
    }
    const recoveryIncludesPrefill =
      input.recoveryMetadata.includePrefill === true;
    if (recoveryIncludesPrefill !== Boolean(prefillSnapshotId)) {
      throw new KnowledgeBaseTurnReservationError(
        "INVALID_REQUEST",
        "Knowledge-base start prefill attachment ledger is inconsistent",
      );
    }
    if (input.deferDispatchUntilAttachments === true) {
      const expectedGeneratedAttachmentCount =
        (input.userAttachmentCount ?? 0) + 2 + (prefillSnapshotId ? 1 : 0);
      if (input.expectedAttachmentCount !== expectedGeneratedAttachmentCount) {
        throw new KnowledgeBaseTurnReservationError(
          "INVALID_REQUEST",
          "Knowledge-base start generated attachment count is inconsistent",
        );
      }
    }
    if (prefillSnapshotId) {
      const snapshotRows = (await tx
        .select({
          id: knowledgeBaseSnapshots.id,
          userId: knowledgeBaseSnapshots.userId,
        })
        .from(knowledgeBaseSnapshots)
        .where(eq(knowledgeBaseSnapshots.id, prefillSnapshotId))
        .limit(1)) as Array<{
        id: string;
        userId: number;
      }>;
      const snapshot = snapshotRows[0];
      if (
        !snapshot ||
        snapshot.id !== prefillSnapshotId ||
        snapshot.userId !== input.userId
      ) {
        throw new KnowledgeBaseTurnReservationError(
          "KNOWLEDGE_BASE_RESET_REVISION_CHANGED",
          "知识库已完成重置，请从本轮全新资料重新开始",
        );
      }
    }
    const startAttachmentResources = await lockKnowledgeBaseStartAttachments({
      tx,
      userId: input.userId,
      apiCredentialId: input.apiCredentialId ?? null,
      conversationId: storedConversationId,
      attachmentFileIds: startAttachmentFileIds,
    });
    const resetTombstone = (
      await tx
        .select({ id: knowledgeBaseConversationTombstones.id })
        .from(knowledgeBaseConversationTombstones)
        .where(
          and(
            eq(knowledgeBaseConversationTombstones.userId, input.userId),
            eq(
              knowledgeBaseConversationTombstones.publicConversationId,
              conversationId,
            ),
          ),
        )
        .limit(1)
        .for("update")
    )[0];
    const retainedResetTombstone = resetTombstone
      ? null
      : (
          await tx
            .select({ id: knowledgeBaseConversationRetentionTombstones.id })
            .from(knowledgeBaseConversationRetentionTombstones)
            .where(
              and(
                eq(
                  knowledgeBaseConversationRetentionTombstones.userId,
                  input.userId,
                ),
                eq(
                  knowledgeBaseConversationRetentionTombstones.publicConversationId,
                  conversationId,
                ),
              ),
            )
            .limit(1)
            .for("update")
        )[0];
    if (resetTombstone || retainedResetTombstone) {
      throw new KnowledgeBaseTurnReservationError(
        "CONVERSATION_RESET",
        "该知识库会话已被重置，请使用新会话重新构建",
      );
    }
    const candidateBuildId = randomUUID();
    await tx
      .insert(knowledgeBaseBuilds)
      .values({
        id: candidateBuildId,
        userId: input.userId,
        conversationId,
        siteOpsKnowledgeInputEpochId: null,
        companyName,
        companyWebsite,
        skillName,
        skillVersion,
        skillContentHash,
        skillArchiveSha256: pinnedSkillArchive.physicalSha256,
        skillArchiveBytes: pinnedSkillArchive.archiveBytes,
        skillArchiveStorageKey: pinnedSkillArchive.storageKey,
        treePolicyVersion: policyBinding.treePolicyVersion,
        executionMode: "materialized_bundle_v1",
        contentVersion: 0,
        providerProtocol,
        handoffProvenance: {
          materializedRecoveryContractVersion: 1,
          materializedCompletionContractVersion:
            KNOWLEDGE_BASE_MATERIALIZED_COMPLETION_CONTRACT_VERSION,
          sourceResetRevision: input.expectedResetRevision,
          authorizedAt: now.toISOString(),
        },
        canonicalTaskState: "unbound",
        status: "researching",
        generation: 1,
        stateEpoch: 0,
        revision: 0,
        currentLeafId: null,
        awaitingResponseSince: now,
        createdAt: now,
        updatedAt: now,
      })
      .onDuplicateKeyUpdate({
        // A racing `/start` must reuse the winner without touching its pinned
        // identity or protocol version. This same-value assignment only
        // converts the unique-key race into a locked read below.
        set: { conversationId },
      });
    const build = (
      await tx
        .select()
        .from(knowledgeBaseBuilds)
        .where(
          and(
            eq(knowledgeBaseBuilds.userId, input.userId),
            eq(knowledgeBaseBuilds.conversationId, conversationId),
          ),
        )
        .limit(1)
        .for("update")
    )[0] as KnowledgeBaseBuild | undefined;
    if (!build) {
      throw new KnowledgeBaseTurnReservationError(
        "BUILD_NOT_FOUND",
        "Knowledge-base build could not be reserved",
      );
    }
    if (
      build.executionMode !== "materialized_bundle_v1" ||
      build.skillVersion !== "5" ||
      build.skillContentHash !==
        KNOWLEDGE_BASE_MATERIALIZED_V5_SKILL_CONTENT_HASH ||
      build.providerProtocol !== "manus_v2" ||
      knowledgeBaseMaterializedRecoveryContractVersion(build) !== 1 ||
      knowledgeBaseMaterializedCompletionContractVersion(build) !==
        KNOWLEDGE_BASE_MATERIALIZED_COMPLETION_CONTRACT_VERSION
    ) {
      throw new KnowledgeBaseTurnReservationError(
        "RESET_REQUIRED",
        "旧知识库构建不再续跑；请批准重置并重新上传资料",
      );
    }
    if (
      build.companyName !== companyName ||
      (build.companyWebsite || null) !== companyWebsite
    ) {
      throw new KnowledgeBaseTurnReservationError(
        "CONFLICT",
        "Knowledge-base start enterprise identity does not match the frozen build",
      );
    }
    // A retention worker may have held the build unique-key gap while this
    // transaction was waiting to insert. Recheck after acquiring the build row
    // lock so a pre-check from a stale browser cannot win after the old
    // conversation and build were atomically retired.
    const postLockRetentionTombstone = (
      await tx
        .select({ id: knowledgeBaseConversationRetentionTombstones.id })
        .from(knowledgeBaseConversationRetentionTombstones)
        .where(
          and(
            eq(
              knowledgeBaseConversationRetentionTombstones.userId,
              input.userId,
            ),
            eq(
              knowledgeBaseConversationRetentionTombstones.publicConversationId,
              conversationId,
            ),
          ),
        )
        .limit(1)
        .for("update")
    )[0];
    if (postLockRetentionTombstone) {
      throw new KnowledgeBaseTurnReservationError(
        "CONVERSATION_RESET",
        "该知识库会话已过期，请使用新会话重新构建",
      );
    }
    const createdBuild = build.id === candidateBuildId;

    const requestPayload = pinnedStartPayload(
      build,
      input.requestPayload,
      researchWebsites,
    );
    const recoveryMetadata = pinnedStartPayload(
      build,
      {
        ...input.recoveryMetadata,
        sourceResetRevision: input.expectedResetRevision,
      },
      researchWebsites,
    );
    const reservation = await reserveKnowledgeBaseTurnInTransaction(
      {
        userId: input.userId,
        buildId: build.id,
        clientRequestId: input.clientRequestId,
        operationType: "start",
        expectedGeneration: build.generation,
        // A /start replay always addresses the original generation start
        // reservation, even after its manifest has advanced the build to the
        // first leaf. Using the current leaf here would create a second logical
        // start slot instead of proving that the original request is identical.
        expectedRevision: 0,
        expectedLeafId: null,
        requestPayload,
        apiCredentialId: input.apiCredentialId,
        userText: input.userText,
        userAttachmentCount: input.userAttachmentCount,
        expectedAttachmentCount: input.expectedAttachmentCount,
        recoveryMetadata,
        deferDispatchUntilAttachments:
          input.deferDispatchUntilAttachments === true,
        clientAttachmentManifest: input.clientAttachmentManifest,
        sourceResetRevision: input.expectedResetRevision,
        now,
        leaseMs: input.leaseMs,
      },
      tx,
    );
    if (reservation.turn.conversationId !== storedConversationId) {
      throw new KnowledgeBaseTurnReservationError(
        "CONFLICT",
        "Knowledge-base start reservation belongs to another conversation",
      );
    }
    await bindKnowledgeBaseStartAttachments({
      tx,
      userId: input.userId,
      apiCredentialId: input.apiCredentialId ?? null,
      conversationId: storedConversationId,
      resources: startAttachmentResources,
    });
    const committedBuild = (
      await tx
        .select()
        .from(knowledgeBaseBuilds)
        .where(
          and(
            eq(knowledgeBaseBuilds.id, build.id),
            eq(knowledgeBaseBuilds.userId, input.userId),
          ),
        )
        .limit(1)
        .for("update")
    )[0] as KnowledgeBaseBuild | undefined;
    if (!committedBuild) {
      throw new KnowledgeBaseTurnReservationError(
        "BUILD_NOT_FOUND",
        "Knowledge-base build reservation was lost",
      );
    }
    return { build: committedBuild, createdBuild, reservation };
  });
}

export function knowledgeBaseRetryRequiresFreshFinalDelivery(input: {
  skillVersion: string;
  currentLeafId: string | null;
  totalNodeCount: number;
  confirmedCount: number;
  directPrefilledCount: number;
  operationType: KnowledgeBaseOperationType;
  finalPackageRequired?: boolean;
}) {
  const retriesFinalAction =
    input.operationType === "confirm" ||
    input.operationType === "direct_prefill" ||
    (input.operationType === "retry" && input.finalPackageRequired === true);
  return Boolean(
    input.skillVersion === "4" &&
      input.currentLeafId &&
      input.totalNodeCount > 0 &&
      retriesFinalAction &&
      input.confirmedCount + input.directPrefilledCount + 1 ===
        input.totalNodeCount,
  );
}

/** Lock one active turn using the global build-then-turn mutation order. */
async function lockedOwnedTurnAndBuild(
  tx: any,
  input: { userId?: number; turnId: string },
  options: { allowInactiveTurn?: boolean } = {},
) {
  const turnId = normalizeRequiredId(input.turnId, "turnId", 36);
  const preliminaryRows = await tx
    .select({
      id: conversationTurns.id,
      userId: conversationTurns.userId,
      buildId: conversationTurns.buildId,
    })
    .from(conversationTurns)
    .where(
      and(
        eq(conversationTurns.id, turnId),
        ...(input.userId === undefined
          ? []
          : [eq(conversationTurns.userId, input.userId)]),
      ),
    )
    .limit(1);
  const preliminary = preliminaryRows[0] as
    | { id: string; userId: number; buildId: string | null }
    | undefined;
  if (!preliminary?.buildId) {
    throw new KnowledgeBaseTurnReservationError(
      "RESERVATION_NOT_FOUND",
      "Knowledge-base turn reservation was not found",
    );
  }

  const buildRows = await tx
    .select()
    .from(knowledgeBaseBuilds)
    .where(eq(knowledgeBaseBuilds.id, preliminary.buildId))
    .limit(1)
    .for("update");
  const build = buildRows[0] as KnowledgeBaseBuild | undefined;

  const rows = await tx
    .select()
    .from(conversationTurns)
    .where(
      and(
        eq(conversationTurns.id, turnId),
        ...(input.userId === undefined
          ? []
          : [eq(conversationTurns.userId, input.userId)]),
      ),
    )
    .limit(1)
    .for("update");
  const turn = rows[0] as ConversationTurn | undefined;
  if (!turn) {
    throw new KnowledgeBaseTurnReservationError(
      "RESERVATION_NOT_FOUND",
      "Knowledge-base turn reservation was not found",
    );
  }
  if (
    !build ||
    build.id !== turn.buildId ||
    build.userId !== turn.userId ||
    build.generation !== turn.buildGeneration ||
    (!options.allowInactiveTurn && build.activeTurnId !== turn.id)
  ) {
    throw new KnowledgeBaseTurnReservationError(
      "CONFLICT",
      "Knowledge-base turn is no longer authoritative",
    );
  }
  return { turn, build };
}

function normalizeDeferredUserAttachments(
  values: ReadonlyArray<{ file_id: string; filename: string }>,
) {
  if (values.length > MAX_USER_ATTACHMENT_COUNT) {
    throw new KnowledgeBaseTurnReservationError(
      "INVALID_REQUEST",
      `Too many customer attachments (maximum ${MAX_USER_ATTACHMENT_COUNT})`,
    );
  }
  const normalized = values.map((value) => ({
    file_id: normalizeRequiredId(
      value.file_id,
      "customer attachment file id",
      MAX_ATTACHMENT_ID_LENGTH,
    ),
    filename: normalizeRequiredId(
      String(value.filename || "").replace(/[\\/\0]/g, "_"),
      "customer attachment filename",
      512,
    ),
  }));
  normalizeAttachmentFileIds(normalized.map((value) => value.file_id));
  return normalized;
}

type StageKnowledgeBaseDeferredTurnAttachmentInput = {
  userId: number;
  buildId: string;
  turnId: string;
  clientRequestId: string;
  clientAttachmentManifest: unknown;
  /** Required for browser-backed materialized start/revise reservations. */
  expectedResetRevision: number;
  index: number;
  attachment: { file_id: string; filename: string };
  /**
   * Server-owned retained-byte proof. Browser routes must supply it; it is
   * optional only for legacy/internal callers which are independently fenced.
   */
  managedUploadProof?: {
    intentId: string;
    itemId: string;
    mimeType: string;
    sizeBytes: number;
    contentSha256: string;
    localStorageKey?: string;
  };
  /**
   * When present, retain these already-verified bytes while the live reset
   * row and deferred turn coordinate are locked by the staging transaction.
   */
  managedUploadBytes?: Buffer;
  projectAssignmentId?: string | null;
  now?: Date;
};

type ClaimKnowledgeBaseDeferredTurnDispatchInput = {
  userId: number;
  buildId: string;
  turnId: string;
  clientRequestId: string;
  clientAttachmentManifest: unknown;
  /** Required for browser-backed materialized start/revise reservations. */
  expectedResetRevision: number;
  now?: Date;
  leaseMs?: number;
};

async function assertDeferredResetRevisionInTransaction(input: {
  tx: any;
  turn: ConversationTurn;
  metadata: KnowledgeBaseTurnMetadata;
  expectedResetRevision?: number;
}) {
  assertDeferredResetRevisionCoordinate(input);
  if (
    input.turn.operationType !== "start" &&
    input.turn.operationType !== "revise"
  ) {
    return;
  }
  const state = (
    await input.tx
      .select({ revision: knowledgeBaseResetStates.revision })
      .from(knowledgeBaseResetStates)
      .where(eq(knowledgeBaseResetStates.userId, input.turn.userId))
      .limit(1)
      .for("update")
  )[0];
  if (state?.revision !== input.expectedResetRevision) {
    throw new KnowledgeBaseTurnReservationError(
      "KNOWLEDGE_BASE_RESET_REVISION_CHANGED",
      "知识库已完成重置，请清空旧资料后重新开始",
    );
  }
}

function assertDeferredResetRevisionCoordinate(input: {
  turn: ConversationTurn;
  metadata: KnowledgeBaseTurnMetadata;
  expectedResetRevision?: number;
}) {
  if (
    input.turn.operationType !== "start" &&
    input.turn.operationType !== "revise"
  ) {
    return;
  }
  if (
    !Number.isSafeInteger(input.expectedResetRevision) ||
    Number(input.expectedResetRevision) < 0 ||
    input.metadata.sourceResetRevision !== input.expectedResetRevision
  ) {
    throw new KnowledgeBaseTurnReservationError(
      "KNOWLEDGE_BASE_RESET_REVISION_CHANGED",
      "知识库已完成重置，请清空旧资料后重新开始",
    );
  }
}

export type KnowledgeBaseLocalUploadCoordinateAssertion = {
  userId: number;
  projectAssignmentId: string | null;
  conversationId: string;
  turnId: string;
  clientRequestId: string;
  itemId: string;
  expectedResetRevision: number;
  ordinal: number;
  filename: string;
  mimeType: string;
  sizeBytes: number;
  /** Optional digest declared by legacy clients. */
  contentSha256?: string;
  /** Digest calculated while Dashboard consumed the complete request body. */
  authoritativeContentSha256?: string;
};

export type KnowledgeBaseDeferredAttachmentReservationSnapshot = {
  buildId: string;
  turn: KnowledgeBaseTurnRecord;
  /**
   * The customer-only manifest frozen at reserve time. Generated Skill,
   * prefill and instruction attachments intentionally do not appear here.
   */
  clientAttachmentManifest: unknown[];
};

/**
 * Read the exact active browser-upload reservation without acquiring a worker
 * lease. The snapshot is deliberately customer-only so recovery never treats
 * generated attachments as missing browser files.
 */
export async function inspectKnowledgeBaseDeferredAttachmentReservation(
  input: {
    userId: number;
    conversationId: string;
    turnId: string;
    clientRequestId: string;
    expectedResetRevision: number;
  },
  executor?: any,
): Promise<KnowledgeBaseDeferredAttachmentReservationSnapshot> {
  assertInteger(input.userId, "userId", 1);
  assertInteger(input.expectedResetRevision, "expectedResetRevision", 0);
  const expectedConversationId = knowledgeBaseConversationStorageId(
    input.userId,
    input.conversationId,
  );
  const turnId = normalizeRequiredId(input.turnId, "turnId", 36);
  const clientRequestId = normalizeRequiredId(
    input.clientRequestId,
    "clientRequestId",
    128,
  );
  const db = executor ?? (await requireDb());
  return db.transaction(async (tx: any) => {
    const { turn, build } = await lockedOwnedTurnAndBuild(tx, {
      userId: input.userId,
      turnId,
    });
    const metadata = metadataOf(turn);
    await assertDeferredResetRevisionInTransaction({
      tx,
      turn,
      metadata,
      expectedResetRevision: input.expectedResetRevision,
    });
    const recovery =
      metadata.recovery &&
      typeof metadata.recovery === "object" &&
      !Array.isArray(metadata.recovery)
        ? metadata.recovery
        : {};
    const clientAttachmentManifest = Array.isArray(
      recovery.clientAttachmentManifest,
    )
      ? recovery.clientAttachmentManifest
      : Array.isArray(recovery.attachmentManifest)
        ? recovery.attachmentManifest
        : null;
    const userAttachmentCount = Number(metadata.userAttachmentCount);
    const staged = Array.isArray(metadata.clientStagedAttachments)
      ? metadata.clientStagedAttachments
      : [];
    if (
      turn.conversationId !== expectedConversationId ||
      build.conversationId !== input.conversationId ||
      turn.clientRequestId !== clientRequestId ||
      (turn.operationType !== "start" && turn.operationType !== "revise") ||
      turn.status !== "queued" ||
      Boolean(turn.upstreamTaskId) ||
      metadata.awaitingClientAttachments !== true ||
      metadata.attachmentsFrozen === true ||
      Boolean(metadata.preparedDispatch) ||
      storedKnowledgeBaseCreateAttemptState(metadata) !== "not_sent" ||
      (metadata.providerAttemptState !== undefined &&
        metadata.providerAttemptState !== "not_sent") ||
      Boolean(metadata.dispatchingAt || metadata.outcomeUnknownAt) ||
      !Number.isSafeInteger(userAttachmentCount) ||
      userAttachmentCount < 1 ||
      !clientAttachmentManifest ||
      clientAttachmentManifest.length !== userAttachmentCount ||
      metadata.clientAttachmentManifestHash !==
        hashKnowledgeBaseTurnRequest(clientAttachmentManifest) ||
      staged.length > userAttachmentCount ||
      staged.some((attachment, index) => attachment.index !== index)
    ) {
      throw new KnowledgeBaseTurnReservationError(
        "CONFLICT",
        "Only an active unprepared customer upload reservation can be resumed",
      );
    }
    return {
      buildId: build.id,
      turn: turnRecord(turn),
      clientAttachmentManifest: clientAttachmentManifest.map((entry) =>
        entry && typeof entry === "object" && !Array.isArray(entry)
          ? { ...(entry as Record<string, unknown>) }
          : entry,
      ),
    };
  });
}

/**
 * Proves that a private local-upload coordinate still names the authenticated
 * account's active, un-dispatched start/revise reservation and the exact frozen
 * manifest slot. Callers intentionally run this once before consuming the
 * request stream and once more immediately before committing its staged bytes.
 */
export async function assertKnowledgeBaseLocalUploadCoordinate(
  input: KnowledgeBaseLocalUploadCoordinateAssertion,
  executor?: any,
) {
  assertInteger(input.userId, "userId", 1);
  assertInteger(input.expectedResetRevision, "expectedResetRevision", 0);
  assertInteger(input.ordinal, "attachment ordinal", 1);
  assertInteger(input.sizeBytes, "attachment size", 1);
  if (input.sizeBytes > 100 * 1024 * 1024) {
    throw new KnowledgeBaseTurnReservationError(
      "INVALID_REQUEST",
      "Attachment size exceeds the local upload limit",
    );
  }
  const conversationId = knowledgeBaseConversationStorageId(
    input.userId,
    input.conversationId,
  );
  const turnId = normalizeRequiredId(input.turnId, "turnId", 36);
  const clientRequestId = normalizeRequiredId(
    input.clientRequestId,
    "clientRequestId",
    128,
  );
  const itemId = normalizeRequiredId(input.itemId, "itemId", 191);
  const filename = normalizeRequiredId(input.filename, "filename", 512);
  const mimeType = normalizeRequiredId(input.mimeType, "mimeType", 255);
  const contentSha256 = String(input.contentSha256 || "")
    .trim()
    .toLowerCase();
  const authoritativeContentSha256 = String(
    input.authoritativeContentSha256 || "",
  )
    .trim()
    .toLowerCase();
  if (
    (contentSha256 && !KNOWLEDGE_BASE_SHA256_PATTERN.test(contentSha256)) ||
    (authoritativeContentSha256 &&
      !KNOWLEDGE_BASE_SHA256_PATTERN.test(authoritativeContentSha256)) ||
    (contentSha256 &&
      authoritativeContentSha256 &&
      contentSha256 !== authoritativeContentSha256)
  ) {
    throw new KnowledgeBaseTurnReservationError(
      "INVALID_REQUEST",
      "Attachment content hash is invalid",
    );
  }

  const db = executor ?? (await requireDb());
  return db.transaction(async (tx: any) => {
    const { turn, build } = await lockedOwnedTurnAndBuild(tx, {
      userId: input.userId,
      turnId,
    });
    const metadata = metadataOf(turn);
    await assertDeferredResetRevisionInTransaction({
      tx,
      turn,
      metadata,
      expectedResetRevision: input.expectedResetRevision,
    });
    const ownedConversation = (
      await tx
        .select()
        .from(conversations)
        .where(
          and(
            eq(conversations.id, conversationId),
            eq(conversations.userId, input.userId),
          ),
        )
        .limit(1)
    )[0];
    if (
      turn.conversationId !== conversationId ||
      build.conversationId !== input.conversationId ||
      !ownedConversation ||
      ownedConversation.deletedAt ||
      ownedConversation.projectAssignmentId !== input.projectAssignmentId ||
      turn.clientRequestId !== clientRequestId ||
      (turn.operationType !== "start" && turn.operationType !== "revise") ||
      turn.status !== "queued" ||
      Boolean(turn.upstreamTaskId) ||
      metadata.awaitingClientAttachments !== true ||
      storedKnowledgeBaseCreateAttemptState(metadata) !== "not_sent"
    ) {
      throw new KnowledgeBaseTurnReservationError(
        "CONFLICT",
        "The upload coordinate no longer owns an active deferred reservation",
      );
    }

    const expectedCount = Number(metadata.userAttachmentCount);
    const recovery =
      metadata.recovery &&
      typeof metadata.recovery === "object" &&
      !Array.isArray(metadata.recovery)
        ? metadata.recovery
        : {};
    const authoritativeManifest = Array.isArray(recovery.attachmentManifest)
      ? recovery.attachmentManifest
      : [];
    const clientManifest = Array.isArray(recovery.clientAttachmentManifest)
      ? recovery.clientAttachmentManifest
      : authoritativeManifest;
    if (
      !Number.isSafeInteger(expectedCount) ||
      expectedCount < 1 ||
      authoritativeManifest.length !== expectedCount ||
      clientManifest.length !== expectedCount ||
      input.ordinal > expectedCount ||
      metadata.clientAttachmentManifestHash !==
        hashKnowledgeBaseTurnRequest(clientManifest)
    ) {
      throw new KnowledgeBaseTurnReservationError(
        "CONFLICT",
        "The upload coordinate does not match the frozen attachment manifest",
      );
    }
    const rawEntry = clientManifest[input.ordinal - 1];
    const entry =
      rawEntry && typeof rawEntry === "object" && !Array.isArray(rawEntry)
        ? (rawEntry as Record<string, unknown>)
        : null;
    if (
      !entry ||
      entry.itemId !== itemId ||
      entry.ordinal !== input.ordinal ||
      entry.total !== expectedCount ||
      entry.filename !== filename ||
      entry.mimeType !== mimeType ||
      entry.sizeBytes !== input.sizeBytes ||
      (String(entry.sha256 || "").trim() &&
        String(entry.sha256 || "").toLowerCase() !== contentSha256) ||
      (String(entry.sha256 || "").trim() && !contentSha256) ||
      (authoritativeContentSha256 &&
        String(entry.sha256 || "").trim() &&
        String(entry.sha256 || "").toLowerCase() !== authoritativeContentSha256)
    ) {
      throw new KnowledgeBaseTurnReservationError(
        "CONFLICT",
        "The uploaded file does not match its reserved manifest item",
      );
    }
    const staged = Array.isArray(metadata.clientStagedAttachments)
      ? metadata.clientStagedAttachments
      : [];
    if (staged.length >= input.ordinal) {
      throw new KnowledgeBaseTurnReservationError(
        "CONFLICT",
        "The reserved manifest item is already staged",
      );
    }
    return { buildId: build.id, turnId: turn.id };
  });
}

function authoritativeDeferredAttachmentManifest(input: {
  clientAttachmentManifest: unknown;
  stagedAttachments: ReadonlyArray<{
    index: number;
    filename: string;
    mimeType?: string;
    sizeBytes?: number;
    contentSha256?: string;
  }>;
  requireComplete?: boolean;
}) {
  if (!Array.isArray(input.clientAttachmentManifest)) {
    throw new KnowledgeBaseTurnReservationError(
      "CONFLICT",
      "The reserved customer attachment manifest is missing",
    );
  }
  return input.clientAttachmentManifest.map((rawEntry, index) => {
    const entry =
      rawEntry && typeof rawEntry === "object" && !Array.isArray(rawEntry)
        ? (rawEntry as Record<string, unknown>)
        : null;
    const staged = input.stagedAttachments[index];
    if (!entry) {
      throw new KnowledgeBaseTurnReservationError(
        "CONFLICT",
        "The reserved customer attachment manifest is invalid",
      );
    }
    if (!staged) {
      if (input.requireComplete) {
        throw new KnowledgeBaseTurnReservationError(
          "CONFLICT",
          "The authoritative customer attachment ledger is incomplete",
        );
      }
      return { ...entry };
    }
    const contentSha256 = String(staged.contentSha256 || entry.sha256 || "")
      .trim()
      .toLowerCase();
    if (
      staged.index !== index ||
      staged.filename !== entry.filename ||
      (staged.mimeType !== undefined && staged.mimeType !== entry.mimeType) ||
      (staged.sizeBytes !== undefined &&
        staged.sizeBytes !== entry.sizeBytes) ||
      !KNOWLEDGE_BASE_SHA256_PATTERN.test(contentSha256)
    ) {
      throw new KnowledgeBaseTurnReservationError(
        "CONFLICT",
        "The authoritative customer attachment proof is invalid",
      );
    }
    return {
      ...entry,
      sizeBytes: staged.sizeBytes ?? entry.sizeBytes,
      sha256: contentSha256,
    };
  });
}

async function stageKnowledgeBaseDeferredTurnAttachmentInTransaction(
  input: StageKnowledgeBaseDeferredTurnAttachmentInput,
  tx: any,
) {
  assertInteger(input.userId, "userId", 1);
  assertInteger(input.index, "attachment index", 0);
  const clientRequestId = normalizeRequiredId(
    input.clientRequestId,
    "clientRequestId",
    128,
  );
  const manifestHash = hashKnowledgeBaseTurnRequest(
    input.clientAttachmentManifest,
  );
  const attachment = normalizeDeferredUserAttachments([input.attachment])[0]!;
  const { turn, build } = await lockedOwnedTurnAndBuild(tx, input);
  if (turn.buildId !== normalizeRequiredId(input.buildId, "buildId", 36)) {
    throw new KnowledgeBaseTurnReservationError(
      "CONFLICT",
      "The attachment reservation belongs to another knowledge-base build",
    );
  }
  const metadata = metadataOf(turn);
  await assertDeferredResetRevisionInTransaction({
    tx,
    turn,
    metadata,
    expectedResetRevision: input.expectedResetRevision,
  });
  if (
    turn.status === "completed" ||
    turn.status === "failed" ||
    turn.status === "cancelled"
  ) {
    throw new KnowledgeBaseTurnReservationError(
      "TERMINAL",
      "Knowledge-base turn is already terminal",
    );
  }
  if (
    (turn.operationType !== "start" && turn.operationType !== "revise") ||
    turn.status !== "queued" ||
    Boolean(turn.upstreamTaskId) ||
    storedKnowledgeBaseCreateAttemptState(metadata) !== "not_sent" ||
    turn.clientRequestId !== clientRequestId ||
    metadata.clientAttachmentManifestHash !== manifestHash
  ) {
    throw new KnowledgeBaseTurnReservationError(
      "CONFLICT",
      "The uploaded file does not match its logical turn reservation",
    );
  }
  const expectedCount = Number(metadata.userAttachmentCount ?? 0);
  if (
    !Number.isSafeInteger(expectedCount) ||
    expectedCount < 1 ||
    input.index >= expectedCount
  ) {
    throw new KnowledgeBaseTurnReservationError(
      "CONFLICT",
      "Uploaded file index exceeds the reserved attachment manifest",
    );
  }
  const rawManifestItem = Array.isArray(input.clientAttachmentManifest)
    ? input.clientAttachmentManifest[input.index]
    : null;
  const manifestItem =
    rawManifestItem &&
    typeof rawManifestItem === "object" &&
    !Array.isArray(rawManifestItem)
      ? (rawManifestItem as Record<string, unknown>)
      : null;
  const managedContentSha256 = String(
    input.managedUploadProof?.contentSha256 || "",
  )
    .trim()
    .toLowerCase();
  const frozenContentSha256 = String(manifestItem?.sha256 || "")
    .trim()
    .toLowerCase();
  const expectedLocalAssetId = input.managedUploadProof
    ? knowledgeBaseLocalAssetIdentity({
        userId: turn.userId,
        projectAssignmentId: input.projectAssignmentId ?? null,
        coordinate: {
          conversationId: build.conversationId,
          turnId: turn.id,
          clientRequestId,
          itemId: input.managedUploadProof.itemId,
          expectedResetRevision: input.expectedResetRevision,
          ...(frozenContentSha256
            ? { contentSha256: frozenContentSha256 }
            : {}),
          ordinal: input.index + 1,
        },
        sizeBytes: input.managedUploadProof.sizeBytes,
        authoritativeContentSha256: managedContentSha256 || undefined,
      }).localAssetId
    : null;
  if (
    input.managedUploadProof &&
    (!Array.isArray(input.clientAttachmentManifest) ||
      input.clientAttachmentManifest.length !== expectedCount ||
      !manifestItem ||
      manifestItem.itemId !== input.managedUploadProof.itemId ||
      manifestItem.ordinal !== input.index + 1 ||
      manifestItem.total !== expectedCount ||
      manifestItem.filename !== attachment.filename ||
      manifestItem.mimeType !== input.managedUploadProof.mimeType ||
      manifestItem.sizeBytes !== input.managedUploadProof.sizeBytes ||
      !KNOWLEDGE_BASE_SHA256_PATTERN.test(managedContentSha256) ||
      (frozenContentSha256 &&
        !KNOWLEDGE_BASE_SHA256_PATTERN.test(frozenContentSha256)) ||
      (frozenContentSha256 && frozenContentSha256 !== managedContentSha256) ||
      attachment.file_id !== expectedLocalAssetId ||
      input.managedUploadProof.intentId !==
        `local-asset:${expectedLocalAssetId}`)
  ) {
    throw new KnowledgeBaseTurnReservationError(
      "CONFLICT",
      "The uploaded local asset does not match its frozen manifest coordinate",
    );
  }
  const localAsset = input.managedUploadProof
    ? (
        await tx
          .select()
          .from(localAssets)
          .where(
            and(
              eq(localAssets.id, attachment.file_id),
              eq(localAssets.scope, "managed_user"),
              eq(localAssets.accountUserId, turn.userId),
              isNull(localAssets.presalesProjectId),
            ),
          )
          .limit(1)
          .for("update")
      )[0]
    : null;
  const legacyResource = !input.managedUploadProof
    ? ((
        await tx
          .select()
          .from(upstreamResources)
          .where(
            and(
              eq(upstreamResources.kind, "file"),
              eq(upstreamResources.upstreamId, attachment.file_id),
            ),
          )
          .limit(1)
          .for("update")
      )[0] as UpstreamResource | undefined)
    : undefined;
  if (input.managedUploadProof) {
    if (
      !localAsset ||
      localAsset.id !== expectedLocalAssetId ||
      localAsset.scope !== "managed_user" ||
      localAsset.accountUserId !== turn.userId ||
      localAsset.presalesProjectId !== null ||
      localAsset.sizeBytes !== input.managedUploadProof.sizeBytes ||
      localAsset.contentSha256.toLowerCase() !== managedContentSha256
    ) {
      throw new KnowledgeBaseTurnReservationError(
        "CONFLICT",
        "The uploaded local asset is not owned by this knowledge-base account",
      );
    }
    if (
      input.managedUploadBytes !== undefined &&
      !Buffer.isBuffer(input.managedUploadBytes)
    ) {
      throw new KnowledgeBaseTurnReservationError(
        "CONFLICT",
        "The retained upload bytes are invalid",
      );
    }
  } else if (
    !legacyResource ||
    legacyResource.userId !== turn.userId ||
    legacyResource.apiCredentialId !== turn.apiCredentialId ||
    legacyResource.projectAssignmentId !==
      (input.projectAssignmentId ?? null) ||
    Boolean(legacyResource.contentDeletedAt) ||
    !(
      legacyResource.conversationId === null ||
      legacyResource.conversationId === turn.conversationId
    )
  ) {
    throw new KnowledgeBaseTurnReservationError(
      "CONFLICT",
      "The uploaded file is not owned by the start reservation credential",
    );
  }
  let managedUploadProof = input.managedUploadProof;
  const staged = Array.isArray(metadata.clientStagedAttachments)
    ? [...metadata.clientStagedAttachments]
    : [];
  const prior = staged[input.index];
  if (prior) {
    if (
      prior.index !== input.index ||
      prior.file_id !== attachment.file_id ||
      prior.filename !== attachment.filename ||
      (managedUploadProof !== undefined &&
        (prior.managedIntentId !== managedUploadProof.intentId ||
          prior.itemId !== managedUploadProof.itemId ||
          prior.mimeType !== managedUploadProof.mimeType ||
          prior.sizeBytes !== managedUploadProof.sizeBytes ||
          prior.contentSha256 !== managedUploadProof.contentSha256 ||
          (managedUploadProof.localStorageKey !== undefined &&
            prior.localStorageKey !== managedUploadProof.localStorageKey)))
    ) {
      throw new KnowledgeBaseTurnReservationError(
        "KNOWLEDGE_BASE_REQUEST_REPLAY_MISMATCH",
        "A different file is already staged at this manifest index",
      );
    }
    return turnRecord(turn);
  }
  if (
    metadata.awaitingClientAttachments !== true ||
    input.index !== staged.length ||
    staged.some((item) => item.file_id === attachment.file_id)
  ) {
    throw new KnowledgeBaseTurnReservationError(
      "CONFLICT",
      "Customer files must be staged once in manifest order",
    );
  }
  if (managedUploadProof && input.managedUploadBytes !== undefined) {
    const retained = await persistKnowledgeBaseBuildSource({
      userId: input.userId,
      buildId: build.id,
      generation: build.generation,
      bytes: input.managedUploadBytes,
    });
    if (
      retained.contentSha256 !== managedUploadProof.contentSha256 ||
      retained.sizeBytes !== managedUploadProof.sizeBytes
    ) {
      throw new KnowledgeBaseTurnReservationError(
        "CONFLICT",
        "Dashboard knowledge-base retained source does not match its upload proof",
      );
    }
    managedUploadProof = {
      ...managedUploadProof,
      localStorageKey: retained.storageKey,
    };
  }
  if (managedUploadProof && !managedUploadProof.localStorageKey) {
    throw new KnowledgeBaseTurnReservationError(
      "CONFLICT",
      "The retained upload source is missing",
    );
  }
  staged.push({
    index: input.index,
    ...attachment,
    ...(managedUploadProof
      ? {
          managedIntentId: normalizeRequiredId(
            managedUploadProof.intentId,
            "managed upload intent id",
            255,
          ),
          itemId: normalizeRequiredId(
            managedUploadProof.itemId,
            "managed upload item id",
            255,
          ),
          mimeType: normalizeRequiredId(
            managedUploadProof.mimeType,
            "managed upload mime type",
            255,
          ),
          sizeBytes: managedUploadProof.sizeBytes,
          contentSha256: normalizeRequiredId(
            managedUploadProof.contentSha256,
            "managed upload content hash",
            64,
          ),
          localStorageKey: normalizeRequiredId(
            managedUploadProof.localStorageKey!,
            "managed upload local storage key",
            1_024,
          ),
        }
      : {}),
  });
  const authoritativeAttachmentManifest =
    authoritativeDeferredAttachmentManifest({
      clientAttachmentManifest: input.clientAttachmentManifest,
      stagedAttachments: staged,
    });
  const recovery = sanitizeKnowledgeBaseRecoveryMetadata({
    ...(metadata.recovery || {}),
    attachments: staged.map(({ file_id, filename }) => ({
      file_id,
      filename,
    })),
    clientAttachmentManifest: input.clientAttachmentManifest,
    attachmentManifest: authoritativeAttachmentManifest,
    attachmentSourceProofs: staged.map((item) => ({
      index: item.index,
      fileId: item.file_id,
      filename: item.filename,
      ...(item.managedIntentId
        ? { managedIntentId: item.managedIntentId }
        : {}),
      ...(item.itemId ? { itemId: item.itemId } : {}),
      ...(item.mimeType ? { mimeType: item.mimeType } : {}),
      ...(item.sizeBytes !== undefined ? { sizeBytes: item.sizeBytes } : {}),
      ...(item.contentSha256 ? { contentSha256: item.contentSha256 } : {}),
      ...(item.localStorageKey
        ? { localStorageKey: item.localStorageKey }
        : {}),
    })),
  });
  const now = input.now ?? new Date();
  if (legacyResource?.conversationId === null) {
    await tx
      .update(upstreamResources)
      .set({ conversationId: turn.conversationId })
      .where(eq(upstreamResources.id, legacyResource.id));
  }
  const nextMetadata: KnowledgeBaseTurnMetadata = {
    ...metadata,
    clientStagedAttachments: staged,
    recovery,
  };
  await tx
    .update(conversationTurns)
    .set({
      attachmentFileIds: staged.map((item) => item.file_id),
      metadata: nextMetadata,
      updatedAt: now,
    })
    .where(eq(conversationTurns.id, turn.id));
  return turnRecord({
    ...turn,
    attachmentFileIds: staged.map((item) => item.file_id),
    metadata: nextMetadata,
    updatedAt: now,
  });
}

/** Append one successfully uploaded customer file to the reservation ledger. */
export async function stageKnowledgeBaseDeferredTurnAttachment(
  input: StageKnowledgeBaseDeferredTurnAttachmentInput,
  executor?: any,
) {
  const db = executor ?? (await requireDb());
  return db.transaction((tx: any) =>
    stageKnowledgeBaseDeferredTurnAttachmentInTransaction(input, tx),
  );
}

/**
 * Binds browser-uploaded files to an already committed logical turn and only
 * then grants the worker lease. Replays with the same manifest/files coalesce;
 * replacements are rejected before any generated Skill upload or upstream
 * task creation can occur.
 */
async function claimKnowledgeBaseDeferredTurnDispatchInTransaction(
  input: ClaimKnowledgeBaseDeferredTurnDispatchInput,
  tx: any,
): Promise<KnowledgeBaseDeferredDispatchClaim> {
  assertInteger(input.userId, "userId", 1);
  const clientRequestId = normalizeRequiredId(
    input.clientRequestId,
    "clientRequestId",
    128,
  );
  const manifestHash = hashKnowledgeBaseTurnRequest(
    input.clientAttachmentManifest,
  );
  const now = input.now ?? new Date();
  const leaseMs = input.leaseMs ?? DEFAULT_LEASE_MS;
  assertInteger(leaseMs, "leaseMs", 1_000);
  const { turn } = await lockedOwnedTurnAndBuild(tx, input);
  if (turn.buildId !== normalizeRequiredId(input.buildId, "buildId", 36)) {
    throw new KnowledgeBaseTurnReservationError(
      "CONFLICT",
      "The attachment dispatch belongs to another knowledge-base build",
    );
  }
  const metadata = metadataOf(turn);
  await assertDeferredResetRevisionInTransaction({
    tx,
    turn,
    metadata,
    expectedResetRevision: input.expectedResetRevision,
  });
  if (
    (turn.operationType !== "start" && turn.operationType !== "revise") ||
    turn.clientRequestId !== clientRequestId ||
    !metadata.clientAttachmentManifestHash ||
    metadata.clientAttachmentManifestHash !== manifestHash
  ) {
    throw new KnowledgeBaseTurnReservationError(
      "CONFLICT",
      "The attachment dispatch does not match its logical turn reservation",
    );
  }
  const userAttachmentCount = Number(metadata.userAttachmentCount ?? 0);
  const stagedAttachments = Array.isArray(metadata.clientStagedAttachments)
    ? metadata.clientStagedAttachments
    : [];
  const attachments = stagedAttachments.map(({ file_id, filename }) => ({
    file_id,
    filename,
  }));
  if (
    !Number.isSafeInteger(userAttachmentCount) ||
    userAttachmentCount < 0 ||
    attachments.length !== userAttachmentCount ||
    stagedAttachments.some((item, index) => item.index !== index) ||
    turn.attachmentFileIds.length < attachments.length ||
    turn.attachmentFileIds.length > attachments.length + 1 ||
    attachments.some(
      (attachment, index) =>
        turn.attachmentFileIds[index] !== attachment.file_id,
    ) ||
    (metadata.awaitingClientAttachments === true &&
      turn.attachmentFileIds.length !== attachments.length)
  ) {
    throw new KnowledgeBaseTurnReservationError(
      "CONFLICT",
      "Uploaded customer files do not match the reserved attachment count",
    );
  }

  if (turn.status === "completed") {
    return {
      state: "completed",
      turn: turnRecord(turn),
      upstreamTaskId: turn.upstreamTaskId,
    };
  }
  if (turn.status === "failed" || turn.status === "cancelled") {
    return { state: "terminal", turn: turnRecord(turn) };
  }
  if (turn.upstreamTaskId) {
    return {
      state: "bound",
      turn: turnRecord(turn),
      upstreamTaskId: turn.upstreamTaskId,
    };
  }

  const authoritativeAttachmentManifest =
    authoritativeDeferredAttachmentManifest({
      clientAttachmentManifest: input.clientAttachmentManifest,
      stagedAttachments,
      requireComplete: true,
    });
  const recovery = sanitizeKnowledgeBaseRecoveryMetadata({
    ...(metadata.recovery || {}),
    attachments,
    clientAttachmentManifest: input.clientAttachmentManifest,
    attachmentManifest: authoritativeAttachmentManifest,
  });
  if (metadata.awaitingClientAttachments !== true) {
    const existingAttachments = Array.isArray(metadata.recovery?.attachments)
      ? metadata.recovery.attachments
      : [];
    if (
      hashKnowledgeBaseTurnRequest(existingAttachments) !==
      hashKnowledgeBaseTurnRequest(attachments)
    ) {
      throw new KnowledgeBaseTurnReservationError(
        "CONFLICT",
        "Customer attachment ids are already bound to different files",
      );
    }
    const remainingMs = (turn.leaseExpiresAt?.getTime() ?? 0) - now.getTime();
    if (remainingMs > 0) {
      return {
        state: "pending",
        turn: turnRecord(turn),
        retryAfterMs: Math.max(250, Math.min(remainingMs, 5_000)),
      };
    }
  }

  const leaseToken = randomUUID();
  const leaseExpiresAt = new Date(now.getTime() + leaseMs);
  const nextMetadata: KnowledgeBaseTurnMetadata = {
    ...metadata,
    awaitingClientAttachments: false,
    leaseOwnerHash: leaseOwnerHash(leaseToken),
    recovery,
  };
  await tx
    .update(conversationTurns)
    .set({
      metadata: nextMetadata,
      leaseExpiresAt,
      updatedAt: now,
    })
    .where(eq(conversationTurns.id, turn.id));
  const claimedTurn = turnRecord({
    ...turn,
    metadata: nextMetadata,
    leaseExpiresAt,
    updatedAt: now,
  });
  return {
    state: "acquired",
    turn: claimedTurn,
    leaseToken,
    leaseExpiresAt,
    upstreamIdempotencyKey: createKnowledgeBaseUpstreamIdempotencyKey(
      String(turn.operationKey),
    ),
    recoveryMetadata: recovery,
    preparedDispatch: nextMetadata.preparedDispatch ?? null,
  };
}

export async function claimKnowledgeBaseDeferredTurnDispatch(
  input: ClaimKnowledgeBaseDeferredTurnDispatchInput,
  executor?: any,
): Promise<KnowledgeBaseDeferredDispatchClaim> {
  const db = executor ?? (await requireDb());
  return db.transaction((tx: any) =>
    claimKnowledgeBaseDeferredTurnDispatchInTransaction(input, tx),
  );
}

/**
 * Stages one browser-uploaded file and, when it completes the manifest,
 * grants the worker lease in the same transaction. This closes the crash gap
 * where a complete attachment ledger could otherwise remain awaiting forever.
 */
export async function stageAndClaimKnowledgeBaseDeferredTurnAttachment(
  input: StageKnowledgeBaseDeferredTurnAttachmentInput & { leaseMs?: number },
  executor?: any,
): Promise<KnowledgeBaseDeferredDispatchClaim> {
  const db = executor ?? (await requireDb());
  const now = input.now ?? new Date();
  return db.transaction(async (tx: any) => {
    const turn = await stageKnowledgeBaseDeferredTurnAttachmentInTransaction(
      { ...input, now },
      tx,
    );
    if (turn.stagedUserAttachmentCount < turn.expectedUserAttachmentCount) {
      return { state: "awaiting_attachments", turn };
    }
    return claimKnowledgeBaseDeferredTurnDispatchInTransaction(
      { ...input, now },
      tx,
    );
  });
}

function assertLease(turn: ConversationTurn, leaseToken: string) {
  if (metadataOf(turn).leaseOwnerHash !== leaseOwnerHash(leaseToken)) {
    throw new KnowledgeBaseTurnReservationError(
      "LEASE_LOST",
      "Knowledge-base turn lease is owned by another worker",
      1_000,
    );
  }
  if (
    turn.status === "completed" ||
    turn.status === "failed" ||
    turn.status === "cancelled"
  ) {
    throw new KnowledgeBaseTurnReservationError(
      "TERMINAL",
      "Knowledge-base turn is already terminal",
    );
  }
}

/**
 * Persist the generated-file operation before the first provider POST. The
 * actual provider key is deterministically re-derived and only its hash is
 * stored, so a restart can retry the same operation without persisting a
 * bearer-like capability.
 */
export async function reserveKnowledgeBaseGeneratedAttachment(
  input: {
    userId: number;
    turnId: string;
    leaseToken: string;
    role: KnowledgeBaseGeneratedAttachmentRole;
    attachmentIndex: number;
    filename: string;
    mimeType: string;
    sizeBytes: number;
    contentSha256: string;
    localStorageKey?: string;
    now?: Date;
  },
  executor?: any,
): Promise<KnowledgeBaseGeneratedAttachmentClaim> {
  const normalized = normalizeGeneratedAttachmentInput(input);
  const db = executor ?? (await requireDb());
  return db.transaction(async (tx: any) => {
    const { turn } = await lockedOwnedTurnAndBuild(tx, input);
    assertLease(turn, input.leaseToken);
    const metadata = metadataOf(turn);
    const expectedCount = Number(metadata.expectedAttachmentCount ?? 0);
    if (
      !Number.isSafeInteger(expectedCount) ||
      normalized.attachmentIndex >= expectedCount ||
      metadata.attachmentsFrozen === true
    ) {
      throw new KnowledgeBaseTurnReservationError(
        "CONFLICT",
        "Generated attachment slot is not writable for this turn",
      );
    }
    const existingIds = [...(turn.attachmentFileIds ?? [])];
    if (existingIds.length < normalized.attachmentIndex) {
      throw new KnowledgeBaseTurnReservationError(
        "CONFLICT",
        "Generated attachments must be reserved in upload-ledger order",
      );
    }
    const slot = generatedAttachmentSlot(
      normalized.role,
      normalized.attachmentIndex,
    );
    const reservations = generatedAttachmentReservations(metadata);
    const existing = reservations[slot];
    const replacementCount = Number(existing?.replacementCount ?? 0);
    const idempotencyKey = createKnowledgeBaseGeneratedAttachmentIdempotencyKey(
      {
        operationKey: String(turn.operationKey || ""),
        role: normalized.role,
        attachmentIndex: normalized.attachmentIndex,
        requestHash: normalized.requestHash,
        replacementCount,
      },
    );
    const idempotencyKeyHash =
      hashKnowledgeBaseUpstreamIdempotencyKey(idempotencyKey);
    if (existing) {
      if (
        existing.schemaVersion !== 1 ||
        existing.role !== normalized.role ||
        existing.attachmentIndex !== normalized.attachmentIndex ||
        existing.requestHash !== normalized.requestHash ||
        existing.idempotencyKeyHash !== idempotencyKeyHash ||
        existing.filename !== normalized.filename ||
        existing.mimeType !== normalized.mimeType ||
        existing.sizeBytes !== normalized.sizeBytes ||
        existing.contentSha256 !== normalized.contentSha256 ||
        (["candidate_created", "ready", "completed"].includes(
          existing.status,
        ) &&
          !existing.upstreamFileId)
      ) {
        throw new KnowledgeBaseTurnReservationError(
          "CONFLICT",
          "Generated attachment reservation does not match its frozen request",
        );
      }
      if (
        normalized.localStorageKey &&
        existing.localStorageKey !== normalized.localStorageKey
      ) {
        if (existing.localStorageKey) {
          throw new KnowledgeBaseTurnReservationError(
            "CONFLICT",
            "Generated attachment reservation has a different local source",
          );
        }
        reservations[slot] = {
          ...existing,
          localStorageKey: normalized.localStorageKey,
        };
        const now = input.now ?? new Date();
        await tx
          .update(conversationTurns)
          .set({
            metadata: {
              ...metadata,
              generatedAttachmentReservations: reservations,
            },
            updatedAt: now,
          })
          .where(eq(conversationTurns.id, turn.id));
      }
      return {
        state: existing.status,
        idempotencyKey,
        requestHash: normalized.requestHash,
        upstreamFileId: existing.upstreamFileId || null,
      };
    }
    if (existingIds.length > normalized.attachmentIndex) {
      throw new KnowledgeBaseTurnReservationError(
        "CONFLICT",
        "Generated attachment file id exists without its durable reservation",
      );
    }
    const now = input.now ?? new Date();
    reservations[slot] = {
      schemaVersion: 1,
      role: normalized.role,
      attachmentIndex: normalized.attachmentIndex,
      requestHash: normalized.requestHash,
      idempotencyKeyHash,
      filename: normalized.filename,
      mimeType: normalized.mimeType,
      sizeBytes: normalized.sizeBytes,
      contentSha256: normalized.contentSha256,
      ...(normalized.localStorageKey
        ? { localStorageKey: normalized.localStorageKey }
        : {}),
      status: "reserved",
      reservedAt: now.toISOString(),
    };
    const nextMetadata: KnowledgeBaseTurnMetadata = {
      ...metadata,
      generatedAttachmentReservations: reservations,
    };
    await tx
      .update(conversationTurns)
      .set({ metadata: nextMetadata, updatedAt: now })
      .where(eq(conversationTurns.id, turn.id));
    return {
      state: "reserved",
      idempotencyKey,
      requestHash: normalized.requestHash,
      upstreamFileId: null,
    };
  });
}

/**
 * Persist a provider candidate before byte upload. The candidate remains out
 * of `attachmentFileIds` until `promoteKnowledgeBaseGeneratedAttachmentReady`
 * proves readiness and atomically promotes it into the task ledger.
 */
export async function completeKnowledgeBaseGeneratedAttachment(
  input: {
    userId: number;
    turnId: string;
    leaseToken: string;
    role: KnowledgeBaseGeneratedAttachmentRole;
    attachmentIndex: number;
    requestHash: string;
    upstreamFileId: string;
    now?: Date;
  },
  executor?: any,
) {
  if (
    input.role !== "skill" &&
    input.role !== "prefill" &&
    input.role !== "instructions" &&
    input.role !== "working_set" &&
    input.role !== "finalization"
  ) {
    throw new KnowledgeBaseTurnReservationError(
      "INVALID_REQUEST",
      "Generated attachment role is invalid",
    );
  }
  assertInteger(input.attachmentIndex, "attachmentIndex", 0);
  const upstreamFileId = normalizeRequiredId(
    input.upstreamFileId,
    "generated attachment file id",
    MAX_ATTACHMENT_ID_LENGTH,
  );
  if (!/^[a-f0-9]{64}$/u.test(input.requestHash)) {
    throw new KnowledgeBaseTurnReservationError(
      "INVALID_REQUEST",
      "Generated attachment request hash is invalid",
    );
  }
  const db = executor ?? (await requireDb());
  return db.transaction(async (tx: any) => {
    const { turn } = await lockedOwnedTurnAndBuild(tx, input);
    assertLease(turn, input.leaseToken);
    if (!turn.apiCredentialId) {
      throw new KnowledgeBaseTurnReservationError(
        "CONFLICT",
        "Generated attachment turn has no pinned API credential",
      );
    }
    const metadata = metadataOf(turn);
    const reservations = generatedAttachmentReservations(metadata);
    const slot = generatedAttachmentSlot(input.role, input.attachmentIndex);
    const reservation = reservations[slot];
    if (
      !reservation ||
      reservation.schemaVersion !== 1 ||
      reservation.role !== input.role ||
      reservation.attachmentIndex !== input.attachmentIndex ||
      reservation.requestHash !== input.requestHash ||
      (reservation.status === "completed" &&
        reservation.upstreamFileId !== upstreamFileId)
    ) {
      throw new KnowledgeBaseTurnReservationError(
        "CONFLICT",
        "Generated attachment completion does not match its reservation",
      );
    }
    const existingIds = [...(turn.attachmentFileIds ?? [])];
    if (existingIds.length < input.attachmentIndex) {
      throw new KnowledgeBaseTurnReservationError(
        "CONFLICT",
        "Generated attachment candidate would create an upload-ledger gap",
      );
    }
    if (
      existingIds.length > input.attachmentIndex &&
      existingIds[input.attachmentIndex] !== upstreamFileId
    ) {
      throw new KnowledgeBaseTurnReservationError(
        "CONFLICT",
        "Generated attachment slot is already bound to a different file",
      );
    }
    const expectedCount = Number(metadata.expectedAttachmentCount ?? 0);
    if (
      !Number.isSafeInteger(expectedCount) ||
      input.attachmentIndex >= expectedCount ||
      (metadata.attachmentsFrozen === true &&
        existingIds[input.attachmentIndex] !== upstreamFileId)
    ) {
      throw new KnowledgeBaseTurnReservationError(
        "CONFLICT",
        "Generated attachment completion exceeds the frozen turn ledger",
      );
    }

    const existingResource = (
      await tx
        .select()
        .from(upstreamResources)
        .where(
          and(
            eq(upstreamResources.kind, "file"),
            eq(upstreamResources.upstreamId, upstreamFileId),
          ),
        )
        .limit(1)
        .for("update")
    )[0];
    if (
      existingResource &&
      (existingResource.userId !== turn.userId ||
        existingResource.apiCredentialId !== turn.apiCredentialId ||
        existingResource.projectAssignmentId !== null)
    ) {
      throw new KnowledgeBaseTurnReservationError(
        "CONFLICT",
        "Generated attachment file is owned by another account or credential",
      );
    }
    if (!existingResource) {
      await tx.insert(upstreamResources).values({
        id: randomUUID(),
        userId: turn.userId,
        apiCredentialId: turn.apiCredentialId,
        projectAssignmentId: null,
        kind: "file",
        upstreamId: upstreamFileId,
        conversationId: turn.conversationId,
        createdAt: input.now ?? new Date(),
      });
    }

    const now = input.now ?? new Date();
    reservations[slot] = {
      ...reservation,
      status:
        reservation.status === "ready" || reservation.status === "completed"
          ? reservation.status
          : "candidate_created",
      upstreamFileId,
      candidateCreatedAt:
        reservation.candidateCreatedAt ||
        reservation.completedAt ||
        now.toISOString(),
    };
    const nextMetadata: KnowledgeBaseTurnMetadata = {
      ...metadata,
      generatedAttachmentReservations: reservations,
    };
    await tx
      .update(conversationTurns)
      .set({
        metadata: nextMetadata,
        updatedAt: now,
      })
      .where(eq(conversationTurns.id, turn.id));
    return turnRecord({
      ...turn,
      attachmentFileIds: existingIds,
      metadata: nextMetadata,
      updatedAt: now,
    });
  });
}

/** Promote a provider-proven candidate into the ordered task attachment ledger. */
export async function promoteKnowledgeBaseGeneratedAttachmentReady(
  input: {
    userId: number;
    turnId: string;
    leaseToken: string;
    role: KnowledgeBaseGeneratedAttachmentRole;
    attachmentIndex: number;
    requestHash: string;
    upstreamFileId: string;
    now?: Date;
  },
  executor?: any,
) {
  const upstreamFileId = normalizeRequiredId(
    input.upstreamFileId,
    "generated attachment file id",
    MAX_ATTACHMENT_ID_LENGTH,
  );
  const db = executor ?? (await requireDb());
  return db.transaction(async (tx: any) => {
    const { turn } = await lockedOwnedTurnAndBuild(tx, input);
    assertLease(turn, input.leaseToken);
    const metadata = metadataOf(turn);
    if (metadata.attachmentsFrozen === true) {
      throw new KnowledgeBaseTurnReservationError(
        "CONFLICT",
        "Generated attachment ledger is already frozen",
      );
    }
    const reservations = generatedAttachmentReservations(metadata);
    const slot = generatedAttachmentSlot(input.role, input.attachmentIndex);
    const reservation = reservations[slot];
    if (
      !reservation ||
      reservation.requestHash !== input.requestHash ||
      reservation.upstreamFileId !== upstreamFileId ||
      !["candidate_created", "ready", "completed"].includes(reservation.status)
    ) {
      throw new KnowledgeBaseTurnReservationError(
        "CONFLICT",
        "Generated attachment readiness does not match its candidate",
      );
    }
    const nextIds = [...(turn.attachmentFileIds ?? [])];
    if (nextIds.length < input.attachmentIndex) {
      throw new KnowledgeBaseTurnReservationError(
        "CONFLICT",
        "Generated attachment readiness would create an upload-ledger gap",
      );
    }
    if (nextIds.length === input.attachmentIndex) {
      if (nextIds.includes(upstreamFileId)) {
        throw new KnowledgeBaseTurnReservationError(
          "CONFLICT",
          "Generated attachment file id is already used by another slot",
        );
      }
      nextIds.push(upstreamFileId);
    } else if (nextIds[input.attachmentIndex] !== upstreamFileId) {
      throw new KnowledgeBaseTurnReservationError(
        "CONFLICT",
        "Generated attachment slot is already bound to a different file",
      );
    }
    const expectedCount = Number(metadata.expectedAttachmentCount ?? 0);
    if (
      !Number.isSafeInteger(expectedCount) ||
      nextIds.length > expectedCount
    ) {
      throw new KnowledgeBaseTurnReservationError(
        "CONFLICT",
        "Generated attachment readiness exceeds the turn ledger",
      );
    }
    const now = input.now ?? new Date();
    reservations[slot] = {
      ...reservation,
      status: "ready",
      readyAt:
        reservation.readyAt || reservation.completedAt || now.toISOString(),
      completedAt: reservation.completedAt || now.toISOString(),
    };
    const nextMetadata = {
      ...metadata,
      generatedAttachmentReservations: reservations,
    };
    await tx
      .update(conversationTurns)
      .set({
        attachmentFileIds: nextIds,
        metadata: nextMetadata,
        updatedAt: now,
      })
      .where(eq(conversationTurns.id, turn.id));
    return turnRecord({
      ...turn,
      attachmentFileIds: nextIds,
      metadata: nextMetadata,
      updatedAt: now,
    });
  });
}

/**
 * Retire one definitely unusable provider candidate before task dispatch.
 * This is bounded to one replacement and can never rewrite a frozen body.
 */
export async function replaceUnusableKnowledgeBaseGeneratedAttachment(
  input: {
    userId: number;
    turnId: string;
    leaseToken: string;
    role: KnowledgeBaseGeneratedAttachmentRole;
    attachmentIndex: number;
    requestHash: string;
    upstreamFileId: string;
    now?: Date;
  },
  executor?: any,
) {
  const db = executor ?? (await requireDb());
  return db.transaction(async (tx: any) => {
    const { turn } = await lockedOwnedTurnAndBuild(tx, input);
    assertLease(turn, input.leaseToken);
    const metadata = metadataOf(turn);
    if (metadata.attachmentsFrozen === true || metadata.preparedDispatch) {
      throw new KnowledgeBaseTurnReservationError(
        "CONFLICT",
        "A frozen generated attachment cannot be replaced",
      );
    }
    const reservations = generatedAttachmentReservations(metadata);
    const slot = generatedAttachmentSlot(input.role, input.attachmentIndex);
    const reservation = reservations[slot];
    const replacementCount = Number(reservation?.replacementCount ?? 0);
    if (
      !reservation ||
      reservation.requestHash !== input.requestHash ||
      reservation.upstreamFileId !== input.upstreamFileId ||
      replacementCount >= 1
    ) {
      throw new KnowledgeBaseTurnReservationError(
        "CONFLICT",
        "Generated attachment replacement authority is unavailable",
      );
    }
    const nextIds = [...(turn.attachmentFileIds ?? [])];
    if (nextIds[input.attachmentIndex] === input.upstreamFileId) {
      if (nextIds.length !== input.attachmentIndex + 1) {
        throw new KnowledgeBaseTurnReservationError(
          "CONFLICT",
          "Generated attachment replacement would reorder the ledger",
        );
      }
      nextIds.pop();
    }
    const idempotencyKey = createKnowledgeBaseGeneratedAttachmentIdempotencyKey(
      {
        operationKey: String(turn.operationKey || ""),
        role: input.role,
        attachmentIndex: input.attachmentIndex,
        requestHash: input.requestHash,
        replacementCount: replacementCount + 1,
      },
    );
    const now = input.now ?? new Date();
    reservations[slot] = {
      ...reservation,
      status: "reserved",
      replacementCount: replacementCount + 1,
      idempotencyKeyHash:
        hashKnowledgeBaseUpstreamIdempotencyKey(idempotencyKey),
      upstreamFileId: undefined,
      candidateCreatedAt: undefined,
      readyAt: undefined,
      completedAt: undefined,
    };
    const nextMetadata = {
      ...metadata,
      generatedAttachmentReservations: reservations,
    };
    await tx
      .update(conversationTurns)
      .set({
        attachmentFileIds: nextIds,
        metadata: nextMetadata,
        updatedAt: now,
      })
      .where(eq(conversationTurns.id, turn.id));
    return {
      idempotencyKey,
      turn: turnRecord({
        ...turn,
        attachmentFileIds: nextIds,
        metadata: nextMetadata,
        updatedAt: now,
      }),
    };
  });
}

function normalizeManusV2AttachmentMimeEvidence(
  value: KnowledgeBaseManusV2AttachmentMimeEvidence,
) {
  const evidence = { ...value };
  const dispositions: readonly KnowledgeBaseManusV2ProviderMimeDisposition[] = [
    "exact",
    "generic",
    "missing",
    "invalid",
    "different",
  ];
  const mediaTypePattern = /^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/u;
  const nullProviderDisposition =
    evidence.disposition === "missing" || evidence.disposition === "invalid";
  if (
    !evidence ||
    typeof evidence !== "object" ||
    typeof evidence.expectedContentType !== "string" ||
    evidence.expectedContentType.length < 1 ||
    evidence.expectedContentType.length > 255 ||
    !mediaTypePattern.test(evidence.expectedContentType) ||
    (evidence.providerContentType !== null &&
      (typeof evidence.providerContentType !== "string" ||
        evidence.providerContentType.length < 1 ||
        evidence.providerContentType.length > 255 ||
        !mediaTypePattern.test(evidence.providerContentType))) ||
    !dispositions.includes(evidence.disposition) ||
    !Number.isFinite(Date.parse(evidence.observedAt)) ||
    (evidence.disposition === "exact" &&
      evidence.providerContentType !== evidence.expectedContentType) ||
    nullProviderDisposition !== (evidence.providerContentType === null) ||
    (evidence.disposition === "generic" &&
      ![
        "application/octet-stream",
        "binary/octet-stream",
        "application/zip",
      ].includes(String(evidence.providerContentType || ""))) ||
    (evidence.disposition === "different" &&
      (evidence.providerContentType === null ||
        evidence.providerContentType === evidence.expectedContentType))
  ) {
    throw new KnowledgeBaseTurnReservationError(
      "INVALID_REQUEST",
      "Manus v2 attachment MIME evidence is invalid",
    );
  }
  return evidence;
}

function normalizeManusV2AttachmentMapping(
  value: KnowledgeBaseManusV2AttachmentMapping,
) {
  const mapping = { ...value };
  if (
    mapping.schemaVersion !== 1 ||
    mapping.providerProtocol !== "manus_v2" ||
    mapping.status !== "ready"
  ) {
    throw new KnowledgeBaseTurnReservationError(
      "INVALID_REQUEST",
      "Manus v2 attachment mapping is not ready",
    );
  }
  if (mapping.mimeEvidence !== undefined) {
    mapping.mimeEvidence = normalizeManusV2AttachmentMimeEvidence(
      mapping.mimeEvidence,
    );
  }
  assertInteger(mapping.buildGeneration, "buildGeneration", 1);
  assertInteger(mapping.attachmentIndex, "attachmentIndex", 0);
  assertInteger(mapping.sizeBytes, "sizeBytes", 1);
  assertInteger(mapping.expiresAt, "expiresAt", 1);
  assertInteger(mapping.providerGeneration, "providerGeneration", 1);
  if (mapping.providerGeneration > 2) {
    throw new KnowledgeBaseTurnReservationError(
      "INVALID_REQUEST",
      "Manus v2 attachment replacement limit is exceeded",
    );
  }
  mapping.sourceFileId = normalizeRequiredId(
    mapping.sourceFileId,
    "sourceFileId",
    MAX_ATTACHMENT_ID_LENGTH,
  );
  mapping.upstreamFileId = normalizeRequiredId(
    mapping.upstreamFileId,
    "upstreamFileId",
    MAX_ATTACHMENT_ID_LENGTH,
  );
  mapping.filename = normalizeRequiredId(
    String(mapping.filename || "").replace(/[\\/\0]/gu, "_"),
    "filename",
    512,
  );
  mapping.mimeType = normalizeRequiredId(
    String(mapping.mimeType || "application/octet-stream")
      .replace(/[\r\n]/gu, "")
      .trim(),
    "mimeType",
    255,
  );
  mapping.localStorageKey = normalizeRequiredId(
    mapping.localStorageKey,
    "localStorageKey",
    1_024,
  );
  if (
    mapping.localStorageKey.startsWith("/") ||
    mapping.localStorageKey.includes("\\") ||
    mapping.localStorageKey
      .split("/")
      .some((part) => !part || part === "." || part === "..") ||
    !/^[a-f0-9]{64}$/u.test(mapping.contentSha256) ||
    !Number.isFinite(Date.parse(mapping.verifiedAt))
  ) {
    throw new KnowledgeBaseTurnReservationError(
      "INVALID_REQUEST",
      "Manus v2 attachment mapping proof is invalid",
    );
  }
  const expectedKey = `g${mapping.buildGeneration}:${mapping.attachmentIndex}:${mapping.contentSha256}:${mapping.sizeBytes}`;
  if (mapping.mappingKey !== expectedKey) {
    throw new KnowledgeBaseTurnReservationError(
      "INVALID_REQUEST",
      "Manus v2 attachment mapping key is invalid",
    );
  }
  return mapping;
}

function normalizeManusV2AttachmentAttempt(
  value: KnowledgeBaseManusV2AttachmentAttempt,
) {
  const attempt = { ...value };
  const states: readonly KnowledgeBaseManusV2AttachmentAttemptState[] = [
    "creating",
    "create_retry_wait",
    "create_rejected",
    "create_outcome_unknown",
    "candidate_created",
    "put_sending",
    "put_retry_wait",
    "put_accepted",
    "put_outcome_unknown",
    "unusable",
  ];
  if (attempt.schemaVersion !== 1 || !states.includes(attempt.state)) {
    throw new KnowledgeBaseTurnReservationError(
      "INVALID_REQUEST",
      "Manus v2 attachment attempt is invalid",
    );
  }
  assertInteger(attempt.buildGeneration, "buildGeneration", 1);
  assertInteger(attempt.attachmentIndex, "attachmentIndex", 0);
  assertInteger(attempt.sizeBytes, "sizeBytes", 1);
  assertInteger(attempt.providerGeneration, "providerGeneration", 1);
  if (attempt.providerGeneration > 2) {
    throw new KnowledgeBaseTurnReservationError(
      "INVALID_REQUEST",
      "Manus v2 attachment replacement limit is exceeded",
    );
  }
  attempt.sourceFileId = normalizeRequiredId(
    attempt.sourceFileId,
    "sourceFileId",
    MAX_ATTACHMENT_ID_LENGTH,
  );
  attempt.filename = normalizeRequiredId(
    String(attempt.filename || "").replace(/[\\/\0]/gu, "_"),
    "filename",
    512,
  );
  attempt.mimeType = normalizeRequiredId(
    String(attempt.mimeType || "application/octet-stream")
      .replace(/[\r\n]/gu, "")
      .trim(),
    "mimeType",
    255,
  );
  attempt.localStorageKey = normalizeRequiredId(
    attempt.localStorageKey,
    "localStorageKey",
    1_024,
  );
  attempt.upstreamFileId = attempt.upstreamFileId
    ? normalizeRequiredId(
        attempt.upstreamFileId,
        "upstreamFileId",
        MAX_ATTACHMENT_ID_LENGTH,
      )
    : null;
  attempt.code = attempt.code
    ? normalizeRequiredId(attempt.code, "code", 128)
    : null;
  if (attempt.rejectionCount !== undefined) {
    assertInteger(attempt.rejectionCount, "rejectionCount", 1);
  }
  if (
    attempt.nextRetryAt !== undefined &&
    attempt.nextRetryAt !== null &&
    !Number.isFinite(Date.parse(attempt.nextRetryAt))
  ) {
    throw new KnowledgeBaseTurnReservationError(
      "INVALID_REQUEST",
      "Manus v2 attachment retry deadline is invalid",
    );
  }
  if (attempt.mimeEvidence !== undefined) {
    attempt.mimeEvidence = normalizeManusV2AttachmentMimeEvidence(
      attempt.mimeEvidence,
    );
  }
  if (attempt.uploadExpiresAt !== null) {
    assertInteger(attempt.uploadExpiresAt, "uploadExpiresAt", 1);
  }
  if (
    attempt.uploadCapability !== undefined &&
    attempt.uploadCapability !== null
  ) {
    const capability = attempt.uploadCapability;
    if (
      capability.schemaVersion !== 1 ||
      capability.encryptionVersion !== 1 ||
      typeof capability.ciphertext !== "string" ||
      capability.ciphertext.length < 1 ||
      capability.ciphertext.length > 16_384 ||
      !/^[A-Za-z0-9+/]+={0,2}$/u.test(capability.ciphertext) ||
      typeof capability.iv !== "string" ||
      capability.iv.length !== 16 ||
      !/^[A-Za-z0-9+/]+={0,2}$/u.test(capability.iv) ||
      typeof capability.authTag !== "string" ||
      capability.authTag.length !== 24 ||
      !/^[A-Za-z0-9+/]+={0,2}$/u.test(capability.authTag)
    ) {
      throw new KnowledgeBaseTurnReservationError(
        "INVALID_REQUEST",
        "Manus v2 attachment upload capability is invalid",
      );
    }
  }
  const requiresProviderId = ![
    "creating",
    "create_retry_wait",
    "create_rejected",
    "create_outcome_unknown",
  ].includes(attempt.state);
  const forbidsProviderId = [
    "creating",
    "create_retry_wait",
    "create_rejected",
    "create_outcome_unknown",
  ].includes(attempt.state);
  if (
    (requiresProviderId &&
      (!attempt.upstreamFileId || attempt.uploadExpiresAt === null)) ||
    (forbidsProviderId &&
      (attempt.upstreamFileId !== null || attempt.uploadExpiresAt !== null)) ||
    attempt.localStorageKey.startsWith("/") ||
    attempt.localStorageKey.includes("\\") ||
    attempt.localStorageKey
      .split("/")
      .some((part) => !part || part === "." || part === "..") ||
    !/^[a-f0-9]{64}$/u.test(attempt.contentSha256) ||
    !Number.isFinite(Date.parse(attempt.recordedAt))
  ) {
    throw new KnowledgeBaseTurnReservationError(
      "INVALID_REQUEST",
      "Manus v2 attachment attempt proof is invalid",
    );
  }
  const expectedKey = `g${attempt.buildGeneration}:${attempt.attachmentIndex}:${attempt.contentSha256}:${attempt.sizeBytes}`;
  if (attempt.mappingKey !== expectedKey) {
    throw new KnowledgeBaseTurnReservationError(
      "INVALID_REQUEST",
      "Manus v2 attachment attempt key is invalid",
    );
  }
  return attempt;
}

function isAllowedManusV2AttachmentAttemptTransition(
  previous: KnowledgeBaseManusV2AttachmentAttempt | undefined,
  next: KnowledgeBaseManusV2AttachmentAttempt,
) {
  if (!previous) {
    return next.providerGeneration === 1 && next.state === "creating";
  }
  const immutableMatches =
    previous.mappingKey === next.mappingKey &&
    previous.buildGeneration === next.buildGeneration &&
    previous.attachmentIndex === next.attachmentIndex &&
    previous.sourceFileId === next.sourceFileId &&
    previous.localStorageKey === next.localStorageKey &&
    previous.contentSha256 === next.contentSha256 &&
    previous.sizeBytes === next.sizeBytes &&
    previous.filename === next.filename &&
    previous.mimeType === next.mimeType;
  if (!immutableMatches) return false;
  if (previous.state === "creating" && next.state === "candidate_created") {
    return (
      next.providerGeneration === previous.providerGeneration &&
      previous.upstreamFileId === null &&
      previous.uploadExpiresAt === null &&
      Boolean(next.upstreamFileId) &&
      next.uploadExpiresAt !== null
    );
  }
  if (next.providerGeneration === previous.providerGeneration + 1) {
    return (
      (previous.state === "unusable" ||
        previous.state === "create_rejected" ||
        previous.state === "create_outcome_unknown") &&
      previous.providerGeneration < 2 &&
      next.state === "creating" &&
      next.upstreamFileId === null &&
      next.uploadExpiresAt === null
    );
  }
  if (next.providerGeneration !== previous.providerGeneration) return false;
  if (previous.state === next.state) {
    const equivalent = { ...previous, recordedAt: next.recordedAt };
    return (
      hashKnowledgeBaseTurnRequest(equivalent) ===
      hashKnowledgeBaseTurnRequest(next)
    );
  }
  if (
    previous.upstreamFileId &&
    next.upstreamFileId !== previous.upstreamFileId
  ) {
    return false;
  }
  if (
    previous.uploadExpiresAt !== null &&
    next.uploadExpiresAt !== previous.uploadExpiresAt
  ) {
    return false;
  }
  const previousCapabilityHash = hashKnowledgeBaseTurnRequest(
    previous.uploadCapability ?? null,
  );
  const nextCapabilityHash = hashKnowledgeBaseTurnRequest(
    next.uploadCapability ?? null,
  );
  const capabilityMayBeCleared = [
    "put_accepted",
    "put_outcome_unknown",
    "unusable",
  ].includes(next.state);
  if (
    previous.uploadCapability &&
    previousCapabilityHash !== nextCapabilityHash &&
    !(capabilityMayBeCleared && !next.uploadCapability)
  ) {
    return false;
  }
  if (!previous.uploadCapability && next.uploadCapability) {
    if (
      !(previous.state === "creating" && next.state === "candidate_created")
    ) {
      return false;
    }
  }
  if (
    previous.state === "create_retry_wait" &&
    next.state === "creating" &&
    (next.rejectionCount !== previous.rejectionCount ||
      (next.nextRetryAt !== undefined && next.nextRetryAt !== null))
  ) {
    return false;
  }
  if (
    previous.state === "put_retry_wait" &&
    next.state === "put_sending" &&
    (next.rejectionCount !== previous.rejectionCount ||
      (next.nextRetryAt !== undefined && next.nextRetryAt !== null))
  ) {
    return false;
  }
  const transitions: Record<
    KnowledgeBaseManusV2AttachmentAttemptState,
    readonly KnowledgeBaseManusV2AttachmentAttemptState[]
  > = {
    creating: [
      "create_retry_wait",
      "create_rejected",
      "create_outcome_unknown",
      "candidate_created",
    ],
    create_retry_wait: ["creating", "create_rejected"],
    create_rejected: [],
    create_outcome_unknown: [],
    candidate_created: ["put_sending", "unusable"],
    put_sending: [
      "put_retry_wait",
      "put_accepted",
      "put_outcome_unknown",
      "unusable",
    ],
    put_retry_wait: ["put_sending", "unusable"],
    put_accepted: ["unusable"],
    put_outcome_unknown: ["put_accepted", "unusable"],
    unusable: [],
  };
  return transitions[previous.state].includes(next.state);
}

/**
 * Journal one provider file lifecycle boundary under the turn lease. The
 * first `creating` row is the durable at-most-once fence for file.upload;
 * provider identity is then immutable within a generation.
 */
export async function persistKnowledgeBaseManusV2AttachmentAttempt(
  input: {
    userId: number;
    turnId: string;
    leaseToken: string;
    attempt: KnowledgeBaseManusV2AttachmentAttempt;
    now?: Date;
  },
  executor?: any,
) {
  const normalized = normalizeManusV2AttachmentAttempt(input.attempt);
  const db = executor ?? (await requireDb());
  return db.transaction(async (tx: any) => {
    const { turn, build } = await lockedOwnedTurnAndBuild(tx, input);
    assertLease(turn, input.leaseToken);
    const metadata = metadataOf(turn);
    const prepared = metadata.preparedDispatch as
      | KnowledgeBasePreparedDispatch
      | undefined;
    const expected =
      prepared?.requestBody.attachments[normalized.attachmentIndex];
    if (
      build.providerProtocol !== "manus_v2" ||
      metadata.providerProtocol !== "manus_v2" ||
      metadata.attachmentsFrozen !== true ||
      knowledgeBaseCreateAttemptState(turn, metadata) !== "not_sent" ||
      build.generation !== normalized.buildGeneration ||
      turn.buildGeneration !== normalized.buildGeneration ||
      !turn.apiCredentialId ||
      !expected ||
      expected.file_id !== normalized.sourceFileId ||
      expected.filename !== normalized.filename
    ) {
      throw new KnowledgeBaseTurnReservationError(
        "CONFLICT",
        "The turn cannot record this Manus v2 file attempt",
      );
    }
    const attempts = manusV2AttachmentAttempts(metadata);
    const previous = attempts[normalized.mappingKey];
    const mappings = manusV2AttachmentMappings(metadata);
    const legacyReady = mappings[normalized.mappingKey];
    const bootstrapsLegacyReady =
      !previous &&
      normalized.state === "unusable" &&
      Boolean(legacyReady) &&
      legacyReady?.providerGeneration === normalized.providerGeneration &&
      legacyReady?.upstreamFileId === normalized.upstreamFileId &&
      legacyReady?.buildGeneration === normalized.buildGeneration &&
      legacyReady?.attachmentIndex === normalized.attachmentIndex &&
      legacyReady?.sourceFileId === normalized.sourceFileId &&
      legacyReady?.localStorageKey === normalized.localStorageKey &&
      legacyReady?.contentSha256 === normalized.contentSha256 &&
      legacyReady?.sizeBytes === normalized.sizeBytes &&
      legacyReady?.filename === normalized.filename &&
      legacyReady?.mimeType === normalized.mimeType;
    if (
      !bootstrapsLegacyReady &&
      !isAllowedManusV2AttachmentAttemptTransition(previous, normalized)
    ) {
      throw new KnowledgeBaseTurnReservationError(
        "CONFLICT",
        "The Manus v2 file attempt transition is not authorized",
      );
    }
    if (normalized.upstreamFileId) {
      const resource = (
        await tx
          .select()
          .from(upstreamResources)
          .where(
            and(
              eq(upstreamResources.kind, "file"),
              eq(upstreamResources.upstreamId, normalized.upstreamFileId),
            ),
          )
          .limit(1)
          .for("update")
      )[0];
      if (
        resource &&
        (resource.userId !== turn.userId ||
          resource.apiCredentialId !== turn.apiCredentialId ||
          resource.projectAssignmentId !== null)
      ) {
        throw new KnowledgeBaseTurnReservationError(
          "CONFLICT",
          "The Manus v2 file is owned by another account or credential",
        );
      }
      if (!resource) {
        await tx.insert(upstreamResources).values({
          id: randomUUID(),
          userId: turn.userId,
          apiCredentialId: turn.apiCredentialId,
          projectAssignmentId: null,
          kind: "file",
          upstreamId: normalized.upstreamFileId,
          conversationId: turn.conversationId,
          createdAt: input.now ?? new Date(),
        });
      }
    }
    const now = input.now ?? new Date();
    const nextMetadata: KnowledgeBaseTurnMetadata = {
      ...metadata,
      manusV2AttachmentAttempts: {
        ...attempts,
        [normalized.mappingKey]: normalized,
      },
    };
    await tx
      .update(conversationTurns)
      .set({ metadata: nextMetadata, updatedAt: now })
      .where(eq(conversationTurns.id, turn.id));
    return normalized;
  });
}

/** Refresh attachment metadata written while an in-memory recovery claim ran. */
export async function loadKnowledgeBaseManusV2AttachmentLedger(
  input: {
    userId: number;
    turnId: string;
    leaseToken: string;
  },
  executor?: any,
) {
  const db = executor ?? (await requireDb());
  return db.transaction(async (tx: any) => {
    const { turn, build } = await lockedOwnedTurnAndBuild(tx, input);
    assertLease(turn, input.leaseToken);
    const metadata = metadataOf(turn);
    if (
      build.providerProtocol !== "manus_v2" ||
      metadata.providerProtocol !== "manus_v2"
    ) {
      throw new KnowledgeBaseTurnReservationError(
        "CONFLICT",
        "The attachment ledger does not belong to a Manus v2 build",
      );
    }
    return {
      turn: turnRecord(turn),
      preparedDispatch: metadata.preparedDispatch ?? null,
    };
  });
}

/**
 * Persist one provider-proven v2 file without exposing it to dispatch. This
 * item ledger survives later uploads or response loss; the ordered turn
 * attachment ledger remains unchanged until finalization below.
 */
export async function persistKnowledgeBaseManusV2AttachmentMapping(
  input: {
    userId: number;
    turnId: string;
    leaseToken: string;
    mapping: KnowledgeBaseManusV2AttachmentMapping;
    now?: Date;
  },
  executor?: any,
) {
  const normalized = normalizeManusV2AttachmentMapping(input.mapping);
  const db = executor ?? (await requireDb());
  return db.transaction(async (tx: any) => {
    const { turn, build } = await lockedOwnedTurnAndBuild(tx, input);
    assertLease(turn, input.leaseToken);
    const metadata = metadataOf(turn);
    if (
      build.providerProtocol !== "manus_v2" ||
      metadata.providerProtocol !== "manus_v2" ||
      turn.buildGeneration !== normalized.buildGeneration ||
      build.generation !== normalized.buildGeneration ||
      metadata.attachmentsFrozen !== true ||
      !metadata.preparedDispatch ||
      knowledgeBaseCreateAttemptState(turn, metadata) !== "not_sent" ||
      !turn.apiCredentialId
    ) {
      throw new KnowledgeBaseTurnReservationError(
        "CONFLICT",
        "The turn cannot accept a Manus v2 attachment mapping",
      );
    }
    const prepared = metadata.preparedDispatch as KnowledgeBasePreparedDispatch;
    const expected =
      prepared.requestBody.attachments[normalized.attachmentIndex];
    if (
      !expected ||
      expected.file_id !== normalized.sourceFileId ||
      expected.filename !== normalized.filename
    ) {
      throw new KnowledgeBaseTurnReservationError(
        "CONFLICT",
        "The Manus v2 attachment does not match its frozen source slot",
      );
    }
    const mappings = manusV2AttachmentMappings(metadata);
    const existing = mappings[normalized.mappingKey];
    const attempt = manusV2AttachmentAttempts(metadata)[normalized.mappingKey];
    if (
      attempt &&
      (attempt.providerGeneration !== normalized.providerGeneration ||
        attempt.upstreamFileId !== normalized.upstreamFileId ||
        !["put_accepted", "put_outcome_unknown"].includes(attempt.state))
    ) {
      throw new KnowledgeBaseTurnReservationError(
        "CONFLICT",
        "The Manus v2 attachment mapping lacks a ready candidate attempt",
      );
    }
    if (
      existing &&
      (existing.attachmentIndex !== normalized.attachmentIndex ||
        existing.sourceFileId !== normalized.sourceFileId ||
        existing.localStorageKey !== normalized.localStorageKey ||
        existing.contentSha256 !== normalized.contentSha256 ||
        existing.sizeBytes !== normalized.sizeBytes ||
        existing.filename !== normalized.filename ||
        existing.mimeType !== normalized.mimeType ||
        (existing.upstreamFileId !== normalized.upstreamFileId &&
          normalized.providerGeneration !== existing.providerGeneration + 1) ||
        (existing.upstreamFileId === normalized.upstreamFileId &&
          normalized.providerGeneration !== existing.providerGeneration))
    ) {
      throw new KnowledgeBaseTurnReservationError(
        "CONFLICT",
        "The Manus v2 attachment mapping cannot be rewritten",
      );
    }
    const resource = (
      await tx
        .select()
        .from(upstreamResources)
        .where(
          and(
            eq(upstreamResources.kind, "file"),
            eq(upstreamResources.upstreamId, normalized.upstreamFileId),
          ),
        )
        .limit(1)
        .for("update")
    )[0];
    if (
      resource &&
      (resource.userId !== turn.userId ||
        resource.apiCredentialId !== turn.apiCredentialId ||
        resource.projectAssignmentId !== null)
    ) {
      throw new KnowledgeBaseTurnReservationError(
        "CONFLICT",
        "The Manus v2 file is owned by another account or credential",
      );
    }
    const now = input.now ?? new Date();
    if (!resource) {
      await tx.insert(upstreamResources).values({
        id: randomUUID(),
        userId: turn.userId,
        apiCredentialId: turn.apiCredentialId,
        projectAssignmentId: null,
        kind: "file",
        upstreamId: normalized.upstreamFileId,
        conversationId: turn.conversationId,
        createdAt: now,
      });
    }
    if (
      normalized.sourceFileId.startsWith("asset_") &&
      normalized.sourceFileId.length <= 36
    ) {
      const credential = (
        await tx
          .select({ version: apiCredentials.version })
          .from(apiCredentials)
          .where(eq(apiCredentials.id, turn.apiCredentialId))
          .limit(1)
      )[0];
      if (!credential) {
        throw new KnowledgeBaseTurnReservationError(
          "CONFLICT",
          "The frozen credential version for this local asset is unavailable",
        );
      }
      await tx
        .insert(providerFileLeases)
        .values({
          id: randomUUID(),
          localAssetId: normalized.sourceFileId,
          apiCredentialId: turn.apiCredentialId,
          credentialVersion: credential.version,
          providerFileId: normalized.upstreamFileId,
          providerRequestId: null,
          uploadState: "uploaded",
          uploadedBytes: normalized.sizeBytes,
          expiresAt: new Date(normalized.expiresAt * 1_000),
        })
        .onDuplicateKeyUpdate({
          set: {
            apiCredentialId: turn.apiCredentialId,
            credentialVersion: credential.version,
            uploadState: "uploaded",
            uploadedBytes: normalized.sizeBytes,
            expiresAt: new Date(normalized.expiresAt * 1_000),
          },
        });
    }
    mappings[normalized.mappingKey] = normalized;
    const nextMetadata = {
      ...metadata,
      manusV2AttachmentMappings: mappings,
    };
    await tx
      .update(conversationTurns)
      .set({ metadata: nextMetadata, updatedAt: now })
      .where(eq(conversationTurns.id, turn.id));
    return turnRecord({ ...turn, metadata: nextMetadata, updatedAt: now });
  });
}

function normalizeManusV2AttachmentUnknownAttempt(
  value: KnowledgeBaseManusV2AttachmentUnknownAttempt,
) {
  const normalized = { ...value };
  if (
    normalized.schemaVersion !== 1 ||
    normalized.state !== "outcome_unknown"
  ) {
    throw new KnowledgeBaseTurnReservationError(
      "INVALID_REQUEST",
      "Manus v2 attachment unknown attempt is invalid",
    );
  }
  assertInteger(normalized.buildGeneration, "buildGeneration", 1);
  assertInteger(normalized.attachmentIndex, "attachmentIndex", 0);
  assertInteger(normalized.sizeBytes, "sizeBytes", 1);
  assertInteger(normalized.providerGeneration, "providerGeneration", 1);
  if (normalized.providerGeneration > 2) {
    throw new KnowledgeBaseTurnReservationError(
      "INVALID_REQUEST",
      "Manus v2 attachment replacement limit is exceeded",
    );
  }
  normalized.sourceFileId = normalizeRequiredId(
    normalized.sourceFileId,
    "sourceFileId",
    MAX_ATTACHMENT_ID_LENGTH,
  );
  normalized.filename = normalizeRequiredId(
    String(normalized.filename || "").replace(/[\\/\0]/gu, "_"),
    "filename",
    512,
  );
  normalized.mimeType = normalizeRequiredId(
    String(normalized.mimeType || "application/octet-stream")
      .replace(/[\r\n]/gu, "")
      .trim(),
    "mimeType",
    255,
  );
  normalized.localStorageKey = normalizeRequiredId(
    normalized.localStorageKey,
    "localStorageKey",
    1_024,
  );
  normalized.code = normalizeRequiredId(normalized.code, "code", 128);
  if (
    normalized.localStorageKey.startsWith("/") ||
    normalized.localStorageKey.includes("\\") ||
    normalized.localStorageKey
      .split("/")
      .some((part) => !part || part === "." || part === "..") ||
    !/^[a-f0-9]{64}$/u.test(normalized.contentSha256) ||
    !Number.isFinite(Date.parse(normalized.recordedAt))
  ) {
    throw new KnowledgeBaseTurnReservationError(
      "INVALID_REQUEST",
      "Manus v2 attachment unknown attempt proof is invalid",
    );
  }
  const expectedKey = `g${normalized.buildGeneration}:${normalized.attachmentIndex}:${normalized.contentSha256}:${normalized.sizeBytes}`;
  if (normalized.mappingKey !== expectedKey) {
    throw new KnowledgeBaseTurnReservationError(
      "INVALID_REQUEST",
      "Manus v2 attachment unknown attempt key is invalid",
    );
  }
  return normalized;
}

/**
 * Persist an ambiguous provider file side effect before unwinding recovery.
 * No provider id is invented and no attachment is promoted. Future workers
 * observe this slot tombstone and stay read-only instead of calling
 * `file.upload` again.
 */
export async function persistKnowledgeBaseManusV2AttachmentOutcomeUnknown(
  input: {
    userId: number;
    turnId: string;
    leaseToken: string;
    attempt: KnowledgeBaseManusV2AttachmentUnknownAttempt;
    now?: Date;
  },
  executor?: any,
) {
  const normalized = normalizeManusV2AttachmentUnknownAttempt(input.attempt);
  const db = executor ?? (await requireDb());
  return db.transaction(async (tx: any) => {
    const { turn, build } = await lockedOwnedTurnAndBuild(tx, input);
    assertLease(turn, input.leaseToken);
    const metadata = metadataOf(turn);
    const prepared = metadata.preparedDispatch as
      | KnowledgeBasePreparedDispatch
      | undefined;
    const expected =
      prepared?.requestBody.attachments[normalized.attachmentIndex];
    if (
      build.providerProtocol !== "manus_v2" ||
      metadata.providerProtocol !== "manus_v2" ||
      metadata.attachmentsFrozen !== true ||
      knowledgeBaseCreateAttemptState(turn, metadata) !== "not_sent" ||
      build.generation !== normalized.buildGeneration ||
      turn.buildGeneration !== normalized.buildGeneration ||
      !expected ||
      expected.file_id !== normalized.sourceFileId ||
      expected.filename !== normalized.filename
    ) {
      throw new KnowledgeBaseTurnReservationError(
        "CONFLICT",
        "The turn cannot record an ambiguous Manus v2 file side effect",
      );
    }
    const attempts = manusV2AttachmentUnknownAttempts(metadata);
    const existing = attempts[normalized.mappingKey];
    if (
      existing &&
      hashKnowledgeBaseTurnRequest(existing) !==
        hashKnowledgeBaseTurnRequest(normalized)
    ) {
      throw new KnowledgeBaseTurnReservationError(
        "CONFLICT",
        "The ambiguous Manus v2 file attempt cannot be rewritten",
      );
    }
    const now = input.now ?? new Date();
    const nextMetadata: KnowledgeBaseTurnMetadata = {
      ...metadata,
      manusV2AttachmentUnknownAttempts: {
        ...attempts,
        [normalized.mappingKey]: existing ?? normalized,
      },
      dispatchState: "recovering",
      failureClass: "recoverable_same_turn",
      recoveryAction: "wait",
      canRegenerate: false,
    };
    await tx
      .update(conversationTurns)
      .set({
        status: "running",
        errorCode: normalized.code,
        errorMessage: null,
        leaseExpiresAt: new Date(now.getTime() + DEFAULT_LEASE_MS),
        metadata: nextMetadata,
        updatedAt: now,
      })
      .where(eq(conversationTurns.id, turn.id));
    await tx
      .update(knowledgeBaseBuilds)
      .set({
        canonicalTaskState: "attention_required",
        protocolErrorCode: normalized.code,
        protocolError: null,
        stateEpoch: build.stateEpoch + 1,
        updatedAt: now,
      })
      .where(eq(knowledgeBaseBuilds.id, build.id));
    return existing ?? normalized;
  });
}

/**
 * Atomically promote an entirely provider-proven mapping set. Until this
 * commit succeeds `attachmentFileIds` remains the frozen source/v1 ledger;
 * afterwards it contains exclusively ordered ready Manus v2 file ids.
 */
export async function finalizeKnowledgeBaseManusV2AttachmentMappings(
  input: {
    userId: number;
    turnId: string;
    leaseToken: string;
    mappings: readonly KnowledgeBaseManusV2AttachmentMapping[];
    minimumUsableSeconds?: number;
    now?: Date;
  },
  executor?: any,
) {
  const normalized = input.mappings.map(normalizeManusV2AttachmentMapping);
  const db = executor ?? (await requireDb());
  return db.transaction(async (tx: any) => {
    const { turn, build } = await lockedOwnedTurnAndBuild(tx, input);
    assertLease(turn, input.leaseToken);
    const metadata = metadataOf(turn);
    const prepared = metadata.preparedDispatch as
      | KnowledgeBasePreparedDispatch
      | undefined;
    const minimumUsableSeconds = input.minimumUsableSeconds ?? 15 * 60;
    assertInteger(minimumUsableSeconds, "minimumUsableSeconds", 1);
    if (
      build.providerProtocol !== "manus_v2" ||
      metadata.providerProtocol !== "manus_v2" ||
      metadata.attachmentsFrozen !== true ||
      !prepared ||
      knowledgeBaseCreateAttemptState(turn, metadata) !== "not_sent" ||
      normalized.length !== prepared.requestBody.attachments.length ||
      normalized.length !== Number(metadata.expectedAttachmentCount)
    ) {
      throw new KnowledgeBaseTurnReservationError(
        "CONFLICT",
        "The complete Manus v2 attachment mapping is unavailable",
      );
    }
    const now = input.now ?? new Date();
    const minimumExpiry =
      Math.floor(now.getTime() / 1_000) + minimumUsableSeconds;
    const persisted = manusV2AttachmentMappings(metadata);
    const targetIds: string[] = [];
    const sourceIds = prepared.requestBody.attachments.map(
      (attachment) => attachment.file_id,
    );
    const seenIds = new Set<string>();
    for (let index = 0; index < normalized.length; index += 1) {
      const mapping = normalized[index]!;
      const source = prepared.requestBody.attachments[index]!;
      const stored = persisted[mapping.mappingKey];
      if (
        mapping.buildGeneration !== turn.buildGeneration ||
        mapping.attachmentIndex !== index ||
        mapping.sourceFileId !== source.file_id ||
        mapping.filename !== source.filename ||
        mapping.expiresAt < minimumExpiry ||
        !stored ||
        hashKnowledgeBaseTurnRequest(stored) !==
          hashKnowledgeBaseTurnRequest(mapping) ||
        seenIds.has(mapping.upstreamFileId)
      ) {
        throw new KnowledgeBaseTurnReservationError(
          "CONFLICT",
          "A Manus v2 attachment mapping failed its final proof",
        );
      }
      seenIds.add(mapping.upstreamFileId);
      targetIds.push(mapping.upstreamFileId);
    }
    const currentIds = [...(turn.attachmentFileIds ?? [])];
    const current = currentIds.join("\0");
    if (current !== sourceIds.join("\0") && current !== targetIds.join("\0")) {
      throw new KnowledgeBaseTurnReservationError(
        "CONFLICT",
        "The frozen attachment ledger changed before Manus v2 promotion",
      );
    }
    const nextMetadata = {
      ...metadata,
      manusV2AttachmentMappings: persisted,
      manusV2SourceAttachmentFileIds: sourceIds,
      manusV2AttachmentMappingsFinalizedAt:
        typeof metadata.manusV2AttachmentMappingsFinalizedAt === "string"
          ? metadata.manusV2AttachmentMappingsFinalizedAt
          : now.toISOString(),
    };
    await tx
      .update(conversationTurns)
      .set({
        attachmentFileIds: targetIds,
        metadata: nextMetadata,
        updatedAt: now,
      })
      .where(eq(conversationTurns.id, turn.id));
    return turnRecord({
      ...turn,
      attachmentFileIds: targetIds,
      metadata: nextMetadata,
      updatedAt: now,
    });
  });
}

/**
 * Finds a previously uploaded Skill file that is safe to attach to another
 * turn in the same live build generation.
 *
 * A generated-attachment reservation becomes `completed` as soon as the
 * provider file id and ownership ledger are durable, before the signed PUT
 * finishes. Reuse therefore also requires a completed, upstream-bound source
 * turn whose frozen dispatch body references that exact file id. This keeps a
 * half-uploaded file from a crashed current turn from becoming a build-wide
 * cache entry.
 */
export async function findReusableKnowledgeBaseSkillFileId(
  input: {
    userId: number;
    buildId: string;
    apiCredentialId: string;
    contentSha256: string;
  },
  executor?: any,
): Promise<string | null> {
  assertInteger(input.userId, "userId", 1);
  const buildId = normalizeRequiredId(input.buildId, "buildId", 36);
  const apiCredentialId = normalizeRequiredId(
    input.apiCredentialId,
    "apiCredentialId",
    36,
  );
  const contentSha256 = String(input.contentSha256 || "").trim();
  if (!/^[a-f0-9]{64}$/u.test(contentSha256)) {
    throw new KnowledgeBaseTurnReservationError(
      "INVALID_REQUEST",
      "Reusable Skill content hash is invalid",
    );
  }

  const db = executor ?? (await requireDb());
  return db.transaction(async (tx: any) => {
    const build = (
      await tx
        .select()
        .from(knowledgeBaseBuilds)
        .where(
          and(
            eq(knowledgeBaseBuilds.id, buildId),
            eq(knowledgeBaseBuilds.userId, input.userId),
          ),
        )
        .limit(1)
    )[0] as KnowledgeBaseBuild | undefined;
    if (
      !build ||
      build.id !== buildId ||
      build.userId !== input.userId ||
      !Number.isSafeInteger(build.generation)
    ) {
      return null;
    }

    const rows = (await tx
      .select()
      .from(conversationTurns)
      .where(
        and(
          eq(conversationTurns.userId, input.userId),
          eq(conversationTurns.buildId, buildId),
          eq(conversationTurns.buildGeneration, build.generation),
          eq(conversationTurns.apiCredentialId, apiCredentialId),
          eq(conversationTurns.status, "completed"),
        ),
      )
      .orderBy(desc(conversationTurns.createdAt), desc(conversationTurns.id))
      .limit(100)) as ConversationTurn[];

    const candidates: Array<{ fileId: string }> = [];
    for (const candidate of rows) {
      // Re-check every ownership discriminator in application code as a
      // fail-closed guard against malformed legacy rows and permissive mocks.
      if (
        candidate.userId !== input.userId ||
        candidate.buildId !== buildId ||
        candidate.buildGeneration !== build.generation ||
        candidate.apiCredentialId !== apiCredentialId ||
        candidate.status !== "completed" ||
        !String(candidate.upstreamTaskId || "").trim()
      ) {
        continue;
      }
      const metadata = metadataOf(candidate);
      const preparedDispatch = retryAuthorityRecord(metadata.preparedDispatch);
      const requestBody = retryAuthorityRecord(preparedDispatch?.requestBody);
      const preparedAttachments = requestBody?.attachments;
      if (
        metadata.attachmentsFrozen !== true ||
        !Array.isArray(candidate.attachmentFileIds) ||
        !Array.isArray(preparedAttachments)
      ) {
        continue;
      }

      for (const reservationValue of Object.values(
        generatedAttachmentReservations(metadata),
      )) {
        const reservation = retryAuthorityRecord(reservationValue);
        if (!reservation) continue;
        const fileId = String(reservation.upstreamFileId || "").trim();
        const attachmentIndex = Number(reservation.attachmentIndex);
        if (
          reservation.schemaVersion !== 1 ||
          reservation.role !== "skill" ||
          !["ready", "completed"].includes(String(reservation.status)) ||
          reservation.contentSha256 !== contentSha256 ||
          !Number.isSafeInteger(attachmentIndex) ||
          attachmentIndex < 0 ||
          !fileId ||
          fileId.length > MAX_ATTACHMENT_ID_LENGTH ||
          candidate.attachmentFileIds[attachmentIndex] !== fileId ||
          !preparedAttachments.some((attachment) => {
            const record = retryAuthorityRecord(attachment);
            return record?.file_id === fileId;
          })
        ) {
          continue;
        }
        candidates.push({ fileId });
      }
    }
    if (candidates.length === 0) return null;

    const fileIds = [
      ...new Set(candidates.map((candidate) => candidate.fileId)),
    ];
    const resources = await tx
      .select()
      .from(upstreamResources)
      .where(
        and(
          eq(upstreamResources.userId, input.userId),
          eq(upstreamResources.apiCredentialId, apiCredentialId),
          eq(upstreamResources.kind, "file"),
          isNull(upstreamResources.projectAssignmentId),
          inArray(upstreamResources.upstreamId, fileIds),
        ),
      )
      .limit(fileIds.length);
    const ownedFileIds = new Set(
      resources
        .filter(
          (resource: any) =>
            resource.userId === input.userId &&
            resource.apiCredentialId === apiCredentialId &&
            resource.kind === "file" &&
            resource.projectAssignmentId === null &&
            fileIds.includes(String(resource.upstreamId || "")),
        )
        .map((resource: any) => String(resource.upstreamId)),
    );
    return (
      candidates.find((candidate) => ownedFileIds.has(candidate.fileId))
        ?.fileId ?? null
    );
  });
}

function assertAttachmentPrefix(existing: string[], next: string[]) {
  if (
    next.length < existing.length ||
    existing.some((value, index) => value !== next[index])
  ) {
    throw new KnowledgeBaseTurnReservationError(
      "CONFLICT",
      "Uploaded attachment ids cannot be replaced, reordered or removed",
    );
  }
}

/** Persist an ordered, monotonically-growing upload ledger after each file. */
export async function stageKnowledgeBaseTurnAttachments(
  input: {
    userId: number;
    turnId: string;
    leaseToken: string;
    attachmentFileIds: readonly string[];
    now?: Date;
  },
  executor?: any,
) {
  const db = executor ?? (await requireDb());
  const nextIds = normalizeAttachmentFileIds(input.attachmentFileIds);
  return db.transaction(async (tx: any) => {
    const { turn } = await lockedOwnedTurnAndBuild(tx, input);
    assertLease(turn, input.leaseToken);
    const metadata = metadataOf(turn);
    const existing = [...(turn.attachmentFileIds ?? [])];
    assertAttachmentPrefix(existing, nextIds);
    const expectedCount = Number(metadata.expectedAttachmentCount ?? 0);
    if (nextIds.length > expectedCount) {
      throw new KnowledgeBaseTurnReservationError(
        "CONFLICT",
        "Uploaded attachment ids exceed the reserved attachment count",
      );
    }
    if (
      metadata.attachmentsFrozen &&
      existing.join("\0") !== nextIds.join("\0")
    ) {
      throw new KnowledgeBaseTurnReservationError(
        "CONFLICT",
        "Attachment ids are already frozen",
      );
    }
    const now = input.now ?? new Date();
    await tx
      .update(conversationTurns)
      .set({ attachmentFileIds: nextIds, updatedAt: now })
      .where(eq(conversationTurns.id, turn.id));
    return turnRecord({ ...turn, attachmentFileIds: nextIds, updatedAt: now });
  });
}

/** Freeze the full upload ledger before the upstream task may be dispatched. */
export async function freezeKnowledgeBaseTurnAttachments(
  input: {
    userId: number;
    turnId: string;
    leaseToken: string;
    attachmentFileIds: readonly string[];
    now?: Date;
  },
  executor?: any,
) {
  const db = executor ?? (await requireDb());
  const nextIds = normalizeAttachmentFileIds(input.attachmentFileIds);
  return db.transaction(async (tx: any) => {
    const { turn } = await lockedOwnedTurnAndBuild(tx, input);
    assertLease(turn, input.leaseToken);
    const metadata = metadataOf(turn);
    const existing = [...(turn.attachmentFileIds ?? [])];
    assertAttachmentPrefix(existing, nextIds);
    const expectedCount = Number(metadata.expectedAttachmentCount ?? 0);
    if (nextIds.length !== expectedCount) {
      throw new KnowledgeBaseTurnReservationError(
        "CONFLICT",
        "Cannot freeze an incomplete attachment upload ledger",
      );
    }
    if (
      metadata.attachmentsFrozen &&
      existing.join("\0") !== nextIds.join("\0")
    ) {
      throw new KnowledgeBaseTurnReservationError(
        "CONFLICT",
        "Attachment ids are already frozen",
      );
    }
    const now = input.now ?? new Date();
    const nextMetadata: KnowledgeBaseTurnMetadata = {
      ...metadata,
      attachmentsFrozen: true,
    };
    await tx
      .update(conversationTurns)
      .set({
        attachmentFileIds: nextIds,
        metadata: nextMetadata,
        updatedAt: now,
      })
      .where(eq(conversationTurns.id, turn.id));
    return turnRecord({
      ...turn,
      attachmentFileIds: nextIds,
      metadata: nextMetadata,
      updatedAt: now,
    });
  });
}

function normalizePreparedAttachment(value: {
  file_id: string;
  filename: string;
}) {
  return {
    file_id: normalizeRequiredId(
      value.file_id,
      "prepared attachment file id",
      MAX_ATTACHMENT_ID_LENGTH,
    ),
    filename: normalizeRequiredId(
      String(value.filename || "").replace(/[\\/\0]/g, "_"),
      "prepared attachment filename",
      512,
    ),
  };
}

/**
 * Freezes the exact credential-free upstream POST body before dispatch. A
 * recovery worker reads these bytes semantically unchanged; it never rebuilds
 * a prompt using newer application code.
 */
export async function prepareKnowledgeBaseTurnDispatch(
  input: {
    userId: number;
    turnId: string;
    leaseToken: string;
    baseUrl: string;
    prompt: string;
    agentProfile: string;
    attachments: ReadonlyArray<{ file_id: string; filename: string }>;
    parentTaskId?: string;
    now?: Date;
    leaseMs?: number;
  },
  executor?: any,
): Promise<KnowledgeBasePreparedDispatch> {
  const db = executor ?? (await requireDb());
  const attachments = input.attachments.map(normalizePreparedAttachment);
  const prompt = String(input.prompt || "");
  if (!prompt || prompt.length > 2_000_000) {
    throw new KnowledgeBaseTurnReservationError(
      "INVALID_REQUEST",
      "Prepared knowledge-base prompt is invalid",
    );
  }
  const agentProfile = normalizeRequiredId(
    input.agentProfile,
    "agentProfile",
    128,
  );
  const baseUrl = normalizeRequiredId(input.baseUrl, "baseUrl", 2_048);
  let parsedBaseUrl: URL;
  try {
    parsedBaseUrl = new URL(baseUrl);
  } catch {
    throw new KnowledgeBaseTurnReservationError(
      "INVALID_REQUEST",
      "Prepared upstream base URL is invalid",
    );
  }
  if (
    (parsedBaseUrl.protocol !== "https:" &&
      parsedBaseUrl.protocol !== "http:") ||
    parsedBaseUrl.username ||
    parsedBaseUrl.password ||
    parsedBaseUrl.search ||
    parsedBaseUrl.hash
  ) {
    throw new KnowledgeBaseTurnReservationError(
      "INVALID_REQUEST",
      "Prepared upstream base URL is unsafe",
    );
  }
  const normalizedBaseUrl = parsedBaseUrl.toString().replace(/\/$/, "");
  const parentTaskId = input.parentTaskId
    ? normalizeRequiredId(input.parentTaskId, "parentTaskId", 255)
    : undefined;

  return db.transaction(async (tx: any) => {
    const { turn } = await lockedOwnedTurnAndBuild(tx, input);
    assertLease(turn, input.leaseToken);
    const metadata = metadataOf(turn);
    if (metadata.attachmentsFrozen !== true) {
      throw new KnowledgeBaseTurnReservationError(
        "CONFLICT",
        "Attachments must be frozen before preparing task dispatch",
      );
    }
    const frozenIds = turn.attachmentFileIds ?? [];
    if (
      frozenIds.length !== attachments.length ||
      frozenIds.some((fileId, index) => fileId !== attachments[index]?.file_id)
    ) {
      throw new KnowledgeBaseTurnReservationError(
        "CONFLICT",
        "Prepared task attachments do not match the frozen upload ledger",
      );
    }
    const requestBody: KnowledgeBasePreparedDispatch["requestBody"] = {
      prompt,
      agentProfile,
      attachments,
    };
    const bodySha256 = hashKnowledgeBaseTurnRequest(requestBody);
    if (metadata.preparedDispatch) {
      const existingBody = metadata.preparedDispatch.requestBody;
      if (
        metadata.preparedDispatch.baseUrl !== normalizedBaseUrl ||
        existingBody.prompt !== prompt ||
        existingBody.agentProfile !== agentProfile ||
        (metadata.preparedDispatch.schemaVersion === 1
          ? (existingBody.taskId ?? undefined) !== parentTaskId
          : existingBody.taskId !== undefined) ||
        existingBody.attachments.length !== attachments.length ||
        existingBody.attachments.some(
          (attachment, index) =>
            attachment.file_id !== attachments[index]?.file_id ||
            attachment.filename !== attachments[index]?.filename,
        )
      ) {
        throw new KnowledgeBaseTurnReservationError(
          "CONFLICT",
          "Knowledge-base dispatch was already prepared with different bytes",
        );
      }
      return metadata.preparedDispatch;
    }
    const now = input.now ?? new Date();
    const leaseMs = input.leaseMs ?? DEFAULT_LEASE_MS;
    assertInteger(leaseMs, "leaseMs", 1_000);
    const preparedDispatch: KnowledgeBasePreparedDispatch = {
      schemaVersion: 2,
      baseUrl: normalizedBaseUrl,
      requestBody,
      bodySha256,
      preparedAt: now.toISOString(),
    };
    const nextMetadata: KnowledgeBaseTurnMetadata = {
      ...metadata,
      preparedDispatch,
      createAttemptState:
        knowledgeBaseCreateAttemptState(turn, metadata) === "not_sent"
          ? "not_sent"
          : knowledgeBaseCreateAttemptState(turn, metadata),
      createAttemptUpdatedAt:
        metadata.createAttemptUpdatedAt || now.toISOString(),
    };
    await tx
      .update(conversationTurns)
      .set({
        metadata: nextMetadata,
        leaseExpiresAt: new Date(now.getTime() + leaseMs),
        updatedAt: now,
      })
      .where(eq(conversationTurns.id, turn.id));
    return preparedDispatch;
  });
}

/**
 * Atomically consumes the one provider-create permission for this turn.
 * Provider task creation has no documented idempotency contract, so any
 * state other than not_sent fails closed and can never produce another POST.
 */
export async function markKnowledgeBaseTurnDispatching(
  input: {
    userId: number;
    turnId: string;
    leaseToken: string;
    now?: Date;
    leaseMs?: number;
  },
  executor?: any,
) {
  const db = executor ?? (await requireDb());
  return db.transaction(async (tx: any) => {
    const { turn } = await lockedOwnedTurnAndBuild(tx, input);
    assertLease(turn, input.leaseToken);
    const metadata = metadataOf(turn);
    if (metadata.attachmentsFrozen !== true) {
      throw new KnowledgeBaseTurnReservationError(
        "CONFLICT",
        "Attachments must be frozen before task dispatch",
      );
    }
    const createAttemptState = knowledgeBaseCreateAttemptState(turn, metadata);
    if (createAttemptState !== "not_sent") {
      throw new KnowledgeBaseTurnReservationError(
        "IDEMPOTENCY_PENDING",
        `Provider task create is already ${createAttemptState}`,
        30_000,
      );
    }
    const now = input.now ?? new Date();
    const leaseMs = input.leaseMs ?? DEFAULT_LEASE_MS;
    assertInteger(leaseMs, "leaseMs", 1_000);
    const leaseExpiresAt = new Date(now.getTime() + leaseMs);
    const nextMetadata: KnowledgeBaseTurnMetadata = {
      ...metadata,
      dispatchingAt: now.toISOString(),
      createAttemptState: "sending",
      createAttemptUpdatedAt: now.toISOString(),
      dispatchState: "recovering",
      failureClass: "recoverable_same_turn",
      recoveryAction: "reconcile",
      canRegenerate: false,
    };
    await tx
      .update(conversationTurns)
      .set({
        status: "running",
        startedAt: turn.startedAt ?? now,
        leaseExpiresAt,
        metadata: nextMetadata,
        updatedAt: now,
      })
      .where(eq(conversationTurns.id, turn.id));
    return {
      turn: turnRecord({
        ...turn,
        status: "running",
        startedAt: turn.startedAt ?? now,
        leaseExpiresAt,
        metadata: nextMetadata,
        updatedAt: now,
      }),
      leaseExpiresAt,
      upstreamIdempotencyKey: createKnowledgeBaseUpstreamIdempotencyKey(
        String(turn.operationKey),
      ),
    };
  });
}

export type KnowledgeBaseManusV2DispatchAuthority = {
  method: "task.create" | "task.sendMessage";
  canonicalTaskId: string | null;
  operationToken: string;
  title: string;
};

/**
 * Atomically cuts one not-yet-sent legacy operation over to a self-contained
 * v2 handoff. The snapshot itself is rebuilt from durable accepted state; only
 * its safe digest/provenance is stored on the build.
 */
export async function activateKnowledgeBaseManusV2Handoff(
  input: {
    userId: number;
    turnId: string;
    leaseToken: string;
    expectedGeneration: number;
    expectedRevision: number;
    expectedLeafId: string | null;
    snapshotSha256: string;
    legacyTaskIdSha256?: string | null;
    now?: Date;
  },
  executor?: any,
) {
  const db = executor ?? (await requireDb());
  const snapshotSha256 = normalizeRequiredId(
    input.snapshotSha256,
    "snapshotSha256",
    64,
  );
  if (!/^[a-f0-9]{64}$/u.test(snapshotSha256)) {
    throw new KnowledgeBaseTurnReservationError(
      "INVALID_REQUEST",
      "The Manus v2 handoff snapshot digest is invalid",
    );
  }
  const legacyTaskIdSha256 = input.legacyTaskIdSha256
    ? normalizeRequiredId(input.legacyTaskIdSha256, "legacyTaskIdSha256", 64)
    : null;
  if (legacyTaskIdSha256 && !/^[a-f0-9]{64}$/u.test(legacyTaskIdSha256)) {
    throw new KnowledgeBaseTurnReservationError(
      "INVALID_REQUEST",
      "The legacy task provenance digest is invalid",
    );
  }
  return db.transaction(async (tx: any) => {
    const { turn, build } = await lockedOwnedTurnAndBuild(tx, input);
    assertLease(turn, input.leaseToken);
    const metadata = metadataOf(turn);
    const existingSnapshotSha =
      build.handoffProvenance &&
      typeof build.handoffProvenance === "object" &&
      !Array.isArray(build.handoffProvenance) &&
      typeof build.handoffProvenance.snapshotSha256 === "string"
        ? build.handoffProvenance.snapshotSha256
        : null;
    if (build.providerProtocol === "manus_v2") {
      if (
        existingSnapshotSha !== snapshotSha256 ||
        metadata.providerProtocol !== "manus_v2"
      ) {
        throw new KnowledgeBaseTurnReservationError(
          "CONFLICT",
          "The Manus v2 handoff changed during recovery",
        );
      }
      return { migrated: false, snapshotSha256 };
    }
    if (
      build.providerProtocol !== "legacy_v1" ||
      build.canonicalTaskId ||
      build.generation !== input.expectedGeneration ||
      build.revision !== input.expectedRevision ||
      (build.currentLeafId ?? null) !== (input.expectedLeafId ?? null) ||
      build.activeTurnId !== turn.id ||
      turn.buildGeneration !== input.expectedGeneration ||
      turn.expectedRevision !== input.expectedRevision ||
      (turn.expectedLeafId ?? null) !== (input.expectedLeafId ?? null) ||
      knowledgeBaseCreateAttemptState(turn, metadata) !== "not_sent"
    ) {
      throw new KnowledgeBaseTurnReservationError(
        "CONFLICT",
        "The legacy build is not at the frozen v2 handoff coordinate",
      );
    }
    const now = input.now ?? new Date();
    const handoffProvenance = {
      schemaVersion: 1,
      sourceProtocol: "legacy_v1",
      snapshotSha256,
      ...(legacyTaskIdSha256 ? { legacyTaskIdSha256 } : {}),
      generation: build.generation,
      revision: build.revision,
      leafId: build.currentLeafId,
      pendingTurnId: turn.id,
      cutoverAt: now.toISOString(),
    };
    const buildUpdate = await tx
      .update(knowledgeBaseBuilds)
      .set({
        providerProtocol: "manus_v2",
        canonicalTaskState: "unbound",
        canonicalTaskId: null,
        canonicalTaskGeneration: null,
        canonicalCredentialId: null,
        canonicalTaskUrl: null,
        canonicalTaskCreatedAt: null,
        handoffProvenance,
        stateEpoch: build.stateEpoch + 1,
        updatedAt: now,
      })
      .where(
        and(
          eq(knowledgeBaseBuilds.id, build.id),
          eq(knowledgeBaseBuilds.userId, input.userId),
          eq(knowledgeBaseBuilds.generation, input.expectedGeneration),
          eq(knowledgeBaseBuilds.revision, input.expectedRevision),
          eq(knowledgeBaseBuilds.providerProtocol, "legacy_v1"),
          isNull(knowledgeBaseBuilds.canonicalTaskId),
        ),
      );
    if (!buildUpdate[0]?.affectedRows) {
      throw new KnowledgeBaseTurnReservationError(
        "CONFLICT",
        "The legacy writer changed during Manus v2 handoff",
      );
    }
    await tx
      .update(conversationTurns)
      .set({
        metadata: {
          ...metadata,
          providerProtocol: "manus_v2",
          providerAttemptState: "not_sent",
          operationToken: String(turn.operationKey),
          repairKind: "legacy_handoff",
        } satisfies KnowledgeBaseTurnMetadata,
        updatedAt: now,
      })
      .where(eq(conversationTurns.id, turn.id));
    return { migrated: true, snapshotSha256 };
  });
}

export async function settleKnowledgeBaseManusV2ExplicitRejection(
  input: {
    userId: number;
    turnId: string;
    leaseToken: string;
    code: string;
    retryable: boolean;
    /** Safe provider classification; never includes response bodies or keys. */
    providerCode?: string;
    providerStatus?: number | null;
    providerRequestRef?: string | null;
    providerField?: string | null;
    providerPath?: string | null;
    providerRequestShape?: KnowledgeBaseTurnMetadata["providerRequestShape"];
    /** undefined means Manus did not supply Retry-After. */
    recoveryDelayMs?: number;
    now?: Date;
  },
  executor?: any,
) {
  const db = executor ?? (await requireDb());
  return db.transaction(async (tx: any) => {
    const { turn, build } = await lockedOwnedTurnAndBuild(tx, input);
    assertLease(turn, input.leaseToken);
    const metadata = metadataOf(turn);
    const frozenHash = metadata.frozenProviderRequestHash;
    if (
      build.executionMode !== "materialized_bundle_v1" ||
      build.skillVersion !== "5" ||
      build.skillContentHash !==
        KNOWLEDGE_BASE_MATERIALIZED_V5_SKILL_CONTENT_HASH ||
      build.providerProtocol !== "manus_v2" ||
      metadata.providerProtocol !== "manus_v2" ||
      metadata.providerMethod !== "task.create" ||
      metadata.providerAttemptState !== "sending" ||
      knowledgeBaseCreateAttemptState(turn, metadata) !== "sending" ||
      typeof metadata.operationToken !== "string" ||
      !/^[a-f0-9]{64}$/u.test(String(frozenHash || "")) ||
      build.generation !== turn.buildGeneration ||
      turn.upstreamTaskId !== null ||
      build.canonicalTaskId !== null
    ) {
      throw new KnowledgeBaseTurnReservationError(
        "CONFLICT",
        "Only an explicit rejection of the current frozen Manus v2 request can settle",
      );
    }
    const now = input.now ?? new Date();
    const code = normalizeRequiredId(input.code, "code", 128);
    const previousCount = Number.isSafeInteger(metadata.providerRejectionCount)
      ? Math.max(0, Number(metadata.providerRejectionCount))
      : 0;
    const nextCount = previousCount + 1;
    const providerCode = safeProviderDiagnostic(input.providerCode);
    const providerRequestRef =
      safeProviderRequestReference(input.providerRequestRef) ?? undefined;
    const providerField =
      classifyProviderValidationCoordinate(input.providerField) ?? undefined;
    const providerPath =
      classifyProviderValidationCoordinate(input.providerPath) ?? undefined;
    const providerStatus = Number.isSafeInteger(input.providerStatus)
      ? Number(input.providerStatus)
      : null;
    const nextMetadata: KnowledgeBaseTurnMetadata = {
      ...metadata,
      providerRejectionCount: nextCount,
      ...(providerCode ? { providerReasonCategory: providerCode } : {}),
      ...(providerRequestRef ? { providerRequestRef } : {}),
      ...(providerField ? { providerField } : {}),
      ...(providerPath ? { providerPath } : {}),
      ...(input.providerRequestShape
        ? { providerRequestShape: input.providerRequestShape }
        : {}),
      ...(providerStatus !== null
        ? { providerRejectionStatus: providerStatus }
        : {}),
      createAttemptState: "rejected",
      createAttemptUpdatedAt: now.toISOString(),
      providerAttemptState: "rejected",
      dispatchState: "failed",
      failureClass: "requires_user_fix",
      recoveryAction: "approve_reset",
      canRegenerate: false,
      manusV2Lifecycle: {
        ...(metadata.manusV2Lifecycle || {}),
        attentionCode: "RESET_REQUIRED",
      },
    };
    delete nextMetadata.leaseOwnerHash;
    const customerMessage = "上游任务创建被拒绝；请批准重置并重新上传资料";
    await tx
      .update(conversationTurns)
      .set({
        status: "failed",
        errorCode: "RESET_REQUIRED",
        errorMessage: customerMessage,
        completedAt: turn.completedAt ?? now,
        leaseExpiresAt: null,
        metadata: nextMetadata,
        updatedAt: now,
      })
      .where(eq(conversationTurns.id, turn.id));
    await tx
      .update(knowledgeBaseBuilds)
      .set({
        status: "protocol_error",
        activeTurnId: null,
        canonicalTaskState: "attention_required",
        protocolErrorCode: "RESET_REQUIRED",
        protocolError: customerMessage,
        stateEpoch: build.stateEpoch + 1,
        recoveryLeaseOwnerHash: null,
        recoveryLeaseExpiresAt: null,
        awaitingResponseSince: null,
        updatedAt: now,
      })
      .where(eq(knowledgeBaseBuilds.id, build.id));
    await markKnowledgeBaseConversationFailedInTransaction({
      tx,
      userId: input.userId,
      conversationId: turn.conversationId,
      authoritativeTaskId: null,
      failedAt: now,
    });
    return { retryScheduled: false as const, attempt: nextCount, delayMs: 0 };
  });
}

/**
 * Atomically grants the one task.create permission for a fresh materialized
 * operation. Existing task identities are never rebound or continued.
 */
export async function beginKnowledgeBaseManusV2Dispatch(
  input: {
    userId: number;
    turnId: string;
    leaseToken: string;
    frozenProviderRequestHash: string;
    expectedMethod?: "task.create";
    now?: Date;
    leaseMs?: number;
  },
  executor?: any,
): Promise<KnowledgeBaseManusV2DispatchAuthority> {
  const db = executor ?? (await requireDb());
  const frozenProviderRequestHash = normalizeRequiredId(
    input.frozenProviderRequestHash,
    "frozenProviderRequestHash",
    64,
  );
  if (!/^[a-f0-9]{64}$/u.test(frozenProviderRequestHash)) {
    throw new KnowledgeBaseTurnReservationError(
      "INVALID_REQUEST",
      "Frozen Manus v2 request hash is invalid",
    );
  }
  return db.transaction(async (tx: any) => {
    const { turn, build } = await lockedOwnedTurnAndBuild(tx, input);
    assertLease(turn, input.leaseToken);
    const metadata = metadataOf(turn);
    if (
      build.executionMode !== "materialized_bundle_v1" ||
      build.skillVersion !== "5" ||
      build.skillContentHash !==
        KNOWLEDGE_BASE_MATERIALIZED_V5_SKILL_CONTENT_HASH ||
      build.providerProtocol !== "manus_v2" ||
      metadata.attachmentsFrozen !== true ||
      build.generation !== turn.buildGeneration ||
      metadata.materializedRecoveryContractVersion !== 1 ||
      knowledgeBaseMaterializedRecoveryContractVersion(build) !== 1 ||
      metadata.materializedCompletionContractVersion !==
        KNOWLEDGE_BASE_MATERIALIZED_COMPLETION_CONTRACT_VERSION ||
      knowledgeBaseMaterializedCompletionContractVersion(build) !==
        KNOWLEDGE_BASE_MATERIALIZED_COMPLETION_CONTRACT_VERSION
    ) {
      throw new KnowledgeBaseTurnReservationError(
        "RESET_REQUIRED",
        "旧知识库构建不再续跑；请批准重置并重新上传资料",
      );
    }
    if (turn.apiCredentialId === null) {
      throw new KnowledgeBaseTurnReservationError(
        "CONFLICT",
        "The materialized turn has no frozen credential",
      );
    }
    const existingState = knowledgeBaseCreateAttemptState(turn, metadata);
    if (existingState !== "not_sent") {
      throw new KnowledgeBaseTurnReservationError(
        "IDEMPOTENCY_PENDING",
        `Manus v2 operation is already ${existingState}`,
        30_000,
      );
    }
    const method = "task.create" as const;
    if (input.expectedMethod && input.expectedMethod !== "task.create") {
      throw new KnowledgeBaseTurnReservationError(
        "CONFLICT",
        "The knowledge-base dispatch method changed before authorization",
      );
    }
    if (build.canonicalTaskId !== null) {
      throw new KnowledgeBaseTurnReservationError(
        "RESET_REQUIRED",
        "旧会话任务锚点不可用于全新物化任务；请批准重置",
      );
    }
    const operationToken = normalizeRequiredId(
      String(turn.operationKey || ""),
      "operationToken",
      128,
    );
    const title = `FrontMind KB ${build.id} g${build.generation} ${turn.id}`;
    const now = input.now ?? new Date();
    const leaseMs = input.leaseMs ?? DEFAULT_LEASE_MS;
    assertInteger(leaseMs, "leaseMs", 1_000);
    const leaseExpiresAt = new Date(now.getTime() + leaseMs);
    const nextMetadata: KnowledgeBaseTurnMetadata = {
      ...metadata,
      dispatchingAt: now.toISOString(),
      createAttemptState: "sending",
      createAttemptUpdatedAt: now.toISOString(),
      providerProtocol: "manus_v2",
      providerMethod: method,
      providerAttemptState: "sending",
      operationToken,
      frozenProviderRequestHash,
      dispatchState: "recovering",
      failureClass: "recoverable_same_turn",
      recoveryAction: "reconcile",
      canRegenerate: false,
    };
    await tx
      .update(conversationTurns)
      .set({
        status: "running",
        startedAt: turn.startedAt ?? now,
        leaseExpiresAt,
        metadata: nextMetadata,
        updatedAt: now,
      })
      .where(eq(conversationTurns.id, turn.id));
    return { method, canonicalTaskId: null, operationToken, title };
  });
}

/** Bind the one fresh materialized task.create acknowledgement. */
export async function bindKnowledgeBaseManusV2Submission(
  input: {
    userId: number;
    turnId: string;
    leaseToken: string;
    method: "task.create";
    taskId: string;
    taskUrl?: string | null;
    manusRequestId?: string | null;
    now?: Date;
  },
  executor?: any,
) {
  const db = executor ?? (await requireDb());
  const taskId = normalizeRequiredId(input.taskId, "taskId", 255);
  return db.transaction(async (tx: any) => {
    const { turn, build } = await lockedOwnedTurnAndBuild(tx, input);
    assertLease(turn, input.leaseToken);
    const metadata = metadataOf(turn);
    if (
      build.executionMode !== "materialized_bundle_v1" ||
      build.skillVersion !== "5" ||
      build.skillContentHash !==
        KNOWLEDGE_BASE_MATERIALIZED_V5_SKILL_CONTENT_HASH ||
      build.providerProtocol !== "manus_v2" ||
      metadata.providerProtocol !== "manus_v2" ||
      metadata.providerMethod !== "task.create" ||
      input.method !== "task.create" ||
      metadata.providerAttemptState !== "sending" ||
      metadata.materializedRecoveryContractVersion !== 1 ||
      metadata.materializedCompletionContractVersion !==
        KNOWLEDGE_BASE_MATERIALIZED_COMPLETION_CONTRACT_VERSION ||
      build.canonicalTaskId !== null
    ) {
      throw new KnowledgeBaseTurnReservationError(
        "CONFLICT",
        "The Manus v2 acknowledgement does not match its operation ledger",
      );
    }
    const now = input.now ?? new Date();
    const apiCredentialId = turn.apiCredentialId
      ? normalizeRequiredId(turn.apiCredentialId, "apiCredentialId", 36)
      : null;
    if (!apiCredentialId) {
      throw new KnowledgeBaseTurnReservationError(
        "CONFLICT",
        "The materialized task credential changed before acknowledgement",
      );
    }
    const conversationRows = await tx
      .select({
        id: conversations.id,
        userId: conversations.userId,
        projectAssignmentId: conversations.projectAssignmentId,
      })
      .from(conversations)
      .where(eq(conversations.id, turn.conversationId))
      .limit(1)
      .for("update");
    const conversation = conversationRows[0] as
      | {
          id: string;
          userId: number;
          projectAssignmentId: string | null;
        }
      | undefined;
    if (
      !conversation ||
      conversation.userId !== turn.userId ||
      conversation.id !== turn.conversationId
    ) {
      throw new KnowledgeBaseTurnReservationError(
        "CONFLICT",
        "The canonical Manus task conversation ownership changed",
      );
    }
    const existingTaskOwnership = await tx
      .select({ id: upstreamResources.id })
      .from(upstreamResources)
      .where(
        and(
          eq(upstreamResources.kind, "task"),
          eq(upstreamResources.upstreamId, taskId),
        ),
      )
      .limit(1)
      .for("update");
    if (existingTaskOwnership[0]) {
      throw new KnowledgeBaseTurnReservationError(
        "CONFLICT",
        "The acknowledged Manus task is already owned by another writer",
      );
    }
    // This insert and the build anchor below commit in the same transaction.
    // The existing (kind, upstreamId) unique index is the database-level
    // writer fence during the additive 0061 rollout; a racing insert rolls
    // the entire binding back instead of leaving an unowned canonical task.
    await tx.insert(upstreamResources).values({
      id: randomUUID(),
      userId: turn.userId,
      apiCredentialId,
      projectAssignmentId: conversation.projectAssignmentId,
      kind: "task",
      upstreamId: taskId,
      conversationId: conversation.id,
      createdAt: now,
      uploadedAt: null,
      contentExpiresAt: null,
      contentDeletedAt: null,
    });
    const nextMetadata: KnowledgeBaseTurnMetadata = {
      ...metadata,
      createAttemptState: "acknowledged",
      createAttemptUpdatedAt: now.toISOString(),
      providerAttemptState: "output_pending",
      ...(input.manusRequestId
        ? {
            manusRequestId: normalizeRequiredId(
              input.manusRequestId,
              "manusRequestId",
              512,
            ),
          }
        : {}),
      dispatchState: "bound",
      failureClass: null,
      recoveryAction: "wait",
      canRegenerate: false,
    };
    await tx
      .update(conversationTurns)
      .set({
        status: "running",
        upstreamTaskId: taskId,
        startedAt: turn.startedAt ?? now,
        errorCode: null,
        errorMessage: null,
        metadata: nextMetadata,
        updatedAt: now,
      })
      .where(eq(conversationTurns.id, turn.id));
    await tx
      .update(knowledgeBaseBuilds)
      .set({
        // Audit pointer only. Activation clears it; it is never continuation
        // authority for a later task.
        upstreamTaskId: taskId,
        stateEpoch: build.stateEpoch + 1,
        updatedAt: now,
      })
      .where(
        and(
          eq(knowledgeBaseBuilds.id, build.id),
          eq(knowledgeBaseBuilds.generation, build.generation),
          eq(knowledgeBaseBuilds.activeTurnId, turn.id),
        ),
      );
    return turnRecord({
      ...turn,
      status: "running",
      upstreamTaskId: taskId,
      startedAt: turn.startedAt ?? now,
      errorCode: null,
      errorMessage: null,
      metadata: nextMetadata,
      updatedAt: now,
    });
  });
}

export async function markKnowledgeBaseManusV2OutcomeUnknown(
  input: {
    userId: number;
    turnId: string;
    leaseToken: string;
    code: string;
    now?: Date;
    recoveryDelayMs?: number;
  },
  executor?: any,
) {
  const db = executor ?? (await requireDb());
  return db.transaction(async (tx: any) => {
    const { turn, build } = await lockedOwnedTurnAndBuild(tx, input);
    assertLease(turn, input.leaseToken);
    const metadata = metadataOf(turn);
    if (metadata.providerProtocol !== "manus_v2") {
      throw new KnowledgeBaseTurnReservationError(
        "CONFLICT",
        "Only Manus v2 submissions use canonical reconciliation",
      );
    }
    const normalizedCode = normalizeRequiredId(input.code, "code", 128);
    if (
      metadata.createAttemptState === "unknown" &&
      turn.upstreamTaskId === null &&
      metadata.providerAttemptState === "outcome_unknown" &&
      metadata.outcomeUnknownCode === normalizedCode
    ) {
      // Exact handler replay after an uncertain persistence response is a
      // read-only success. It does not renew the lease or write the ledger a
      // second time; the next expired sweep owns reset settlement.
      return { deduplicated: true };
    }
    // This mutation belongs exclusively to the task.create side-effect
    // boundary. Once a task identity has been bound (or the durable create
    // acknowledgement has advanced), result download/normalization/CAS
    // failures must never rewrite the create ledger back to unknown.
    if (
      metadata.createAttemptState !== "sending" ||
      turn.upstreamTaskId !== null ||
      metadata.providerAttemptState !== "sending"
    ) {
      throw new KnowledgeBaseTurnReservationError(
        "CONFLICT",
        "Only an unacknowledged in-flight task.create may become outcome unknown",
      );
    }
    const now = input.now ?? new Date();
    const recoveryDelayMs = input.recoveryDelayMs ?? 30_000;
    const leaseExpiresAt = new Date(now.getTime() + recoveryDelayMs);
    const nextMetadata: KnowledgeBaseTurnMetadata = {
      ...metadata,
      createAttemptState: "unknown",
      createAttemptUpdatedAt: now.toISOString(),
      providerAttemptState: "outcome_unknown",
      outcomeUnknownAt: now.toISOString(),
      outcomeUnknownCode: normalizedCode,
      dispatchState: "recovering",
      failureClass: "recoverable_same_turn",
      recoveryAction: "reconcile",
      canRegenerate: false,
    };
    await tx
      .update(conversationTurns)
      .set({
        status: "running",
        leaseExpiresAt,
        errorCode: nextMetadata.outcomeUnknownCode,
        errorMessage: null,
        metadata: nextMetadata,
        updatedAt: now,
      })
      .where(eq(conversationTurns.id, turn.id));
    await tx
      .update(knowledgeBaseBuilds)
      .set({ canonicalTaskState: "reconciling", updatedAt: now })
      .where(eq(knowledgeBaseBuilds.id, build.id));
    return { deduplicated: false };
  });
}

function safeProviderDiagnostic(value: unknown, maxLength = 128) {
  const normalized = String(value || "").trim();
  return normalized &&
    normalized.length <= maxLength &&
    /^[A-Z0-9._:-]+$/iu.test(normalized)
    ? normalized
    : undefined;
}

/**
 * Defer a pre-create reservation while provider files are still processing.
 * The create permission remains not_sent, so the recovery worker may safely
 * re-check the same frozen attachment ledger after the short lease expires.
 */
export async function deferKnowledgeBaseTurnBeforeCreate(
  input: {
    userId: number;
    turnId: string;
    leaseToken: string;
    code?: string;
    recoveryDelayMs?: number;
    traceId?: string;
    now?: Date;
  },
  executor?: any,
) {
  const db = executor ?? (await requireDb());
  return db.transaction(async (tx: any) => {
    const { turn } = await lockedOwnedTurnAndBuild(tx, input);
    assertLease(turn, input.leaseToken);
    const currentMetadata = metadataOf(turn);
    if (knowledgeBaseCreateAttemptState(turn, currentMetadata) !== "not_sent") {
      throw new KnowledgeBaseTurnReservationError(
        "CONFLICT",
        "Attachments can only defer a task before provider create",
      );
    }
    const now = input.now ?? new Date();
    const recoveryDelayMs = input.recoveryDelayMs ?? 5_000;
    assertInteger(recoveryDelayMs, "recoveryDelayMs", 1_000);
    const leaseExpiresAt = new Date(now.getTime() + recoveryDelayMs);
    const code = String(
      input.code || "KNOWLEDGE_BASE_ATTACHMENTS_PROCESSING",
    ).slice(0, 128);
    const traceId = safeKnowledgeBaseTraceId(
      input.traceId || currentMetadata.traceId,
    );
    const metadata: KnowledgeBaseTurnMetadata = {
      ...currentMetadata,
      createAttemptState: "not_sent",
      createAttemptUpdatedAt:
        currentMetadata.createAttemptUpdatedAt || now.toISOString(),
      ...(traceId ? { traceId } : {}),
      dispatchState: "recovering",
      failureClass: "recoverable_same_turn",
      recoveryAction: "reconcile",
      canRegenerate: false,
    };
    await tx
      .update(conversationTurns)
      .set({
        status: "running",
        errorCode: code,
        errorMessage: null,
        leaseExpiresAt,
        metadata,
        updatedAt: now,
      })
      .where(eq(conversationTurns.id, turn.id));
    return turnRecord({
      ...turn,
      status: "running",
      errorCode: code,
      errorMessage: null,
      leaseExpiresAt,
      metadata,
      updatedAt: now,
    });
  });
}

/**
 * Records only a coarse error code. It intentionally keeps the row active and
 * leased; callers must never release/delete a reservation on timeout.
 */
export async function markKnowledgeBaseTurnOutcomeUnknown(
  input: {
    userId: number;
    turnId: string;
    leaseToken: string;
    code?: string;
    traceId?: string;
    reasonCategory?: string;
    providerRequestRef?: string;
    now?: Date;
    recoveryDelayMs?: number;
  },
  executor?: any,
) {
  const db = executor ?? (await requireDb());
  return db.transaction(async (tx: any) => {
    const { turn } = await lockedOwnedTurnAndBuild(tx, input);
    assertLease(turn, input.leaseToken);
    const now = input.now ?? new Date();
    const recoveryDelayMs = input.recoveryDelayMs ?? 30_000;
    assertInteger(recoveryDelayMs, "recoveryDelayMs", 1_000);
    const leaseExpiresAt = new Date(now.getTime() + recoveryDelayMs);
    const currentMetadata = metadataOf(turn);
    const currentAttempt = knowledgeBaseCreateAttemptState(
      turn,
      currentMetadata,
    );
    const traceId = safeKnowledgeBaseTraceId(
      input.traceId || currentMetadata.traceId,
    );
    const reasonCategory = safeProviderDiagnostic(input.reasonCategory);
    const providerRequestRef = safeProviderDiagnostic(input.providerRequestRef);
    const metadata: KnowledgeBaseTurnMetadata = {
      ...currentMetadata,
      outcomeUnknownAt: now.toISOString(),
      outcomeUnknownCode: String(
        input.code || "UPSTREAM_OUTCOME_UNKNOWN",
      ).slice(0, 128),
      createAttemptState:
        currentAttempt === "sending" ? "unknown" : currentAttempt,
      createAttemptUpdatedAt: now.toISOString(),
      ...(traceId ? { traceId } : {}),
      ...(reasonCategory ? { providerReasonCategory: reasonCategory } : {}),
      ...(providerRequestRef ? { providerRequestRef } : {}),
      dispatchState: "recovering",
      failureClass: "recoverable_same_turn",
      recoveryAction: "reconcile",
      canRegenerate: false,
    };
    await tx
      .update(conversationTurns)
      .set({
        status: "running",
        leaseExpiresAt,
        metadata,
        updatedAt: now,
      })
      .where(eq(conversationTurns.id, turn.id));
    return turnRecord({
      ...turn,
      status: "running",
      leaseExpiresAt,
      metadata,
      updatedAt: now,
    });
  });
}

/**
 * Release a browser-upload turn that was rejected before any upstream request
 * was prepared. This is intentionally narrower than deterministic failure:
 * the build returns to the same authoritative leaf without a protocol-error
 * retry that would require a prepared request body.
 */
async function cancelUnpreparedKnowledgeBaseTurnInternal(
  input: {
    userId: number;
    conversationId?: string;
    turnId: string;
    clientRequestId?: string;
    leaseToken?: string;
    expectedResetRevision?: number;
    strictStartCancellation?: boolean;
    strictRevisionCancellation?: boolean;
    code: string;
    message: string;
    now?: Date;
  },
  executor?: any,
) {
  const db = executor ?? (await requireDb());
  const strictStartCancellation = input.strictStartCancellation === true;
  const strictRevisionCancellation = input.strictRevisionCancellation === true;
  const expectedConversationId = input.conversationId
    ? knowledgeBaseConversationStorageId(input.userId, input.conversationId)
    : null;
  const code = normalizeRequiredId(input.code, "cancellation code", 128);
  const message = String(input.message || "")
    .trim()
    .slice(0, 10_000);
  if (!message) {
    throw new KnowledgeBaseTurnReservationError(
      "INVALID_REQUEST",
      "Cancellation message is required",
    );
  }
  return db.transaction(async (tx: any) => {
    const { turn, build } = await lockedOwnedTurnAndBuild(tx, input, {
      allowInactiveTurn: true,
    });
    const metadata = metadataOf(turn);
    if (
      expectedConversationId &&
      turn.conversationId !== expectedConversationId
    ) {
      throw new KnowledgeBaseTurnReservationError(
        "CONFLICT",
        "The upload turn belongs to another conversation",
      );
    }
    if (strictStartCancellation && turn.operationType !== "start") {
      throw new KnowledgeBaseTurnReservationError(
        "CONFLICT",
        "Only an incomplete start operation can be cancelled",
      );
    }
    if (strictRevisionCancellation && turn.operationType !== "revise") {
      throw new KnowledgeBaseTurnReservationError(
        "CONFLICT",
        "Only an incomplete revision upload can be cancelled",
      );
    }
    if (
      turn.status === "cancelled" &&
      metadata.unpreparedCancellation === true
    ) {
      if (
        (!input.clientRequestId ||
          turn.clientRequestId === input.clientRequestId) &&
        turn.errorCode === code &&
        turn.errorMessage === message
      ) {
        return turnRecord(turn);
      }
      throw new KnowledgeBaseTurnReservationError(
        "CONFLICT",
        "The upload turn was already cancelled by another request",
      );
    }
    if (
      (input.clientRequestId &&
        turn.clientRequestId !== input.clientRequestId) ||
      (input.leaseToken &&
        metadata.leaseOwnerHash !== leaseOwnerHash(input.leaseToken)) ||
      (!input.leaseToken && metadata.awaitingClientAttachments !== true) ||
      build.activeTurnId !== turn.id ||
      (turn.status !== "queued" && turn.status !== "running") ||
      turn.upstreamTaskId ||
      metadata.preparedDispatch ||
      (strictStartCancellation && metadata.attachmentsFrozen === true) ||
      (strictStartCancellation &&
        metadata.frozenProviderRequestHash !== undefined) ||
      (strictStartCancellation &&
        Object.keys(generatedAttachmentReservations(metadata)).length > 0) ||
      (strictStartCancellation &&
        Object.keys(manusV2AttachmentMappings(metadata)).length > 0) ||
      (strictStartCancellation &&
        Object.keys(manusV2AttachmentAttempts(metadata)).length > 0) ||
      (strictStartCancellation &&
        Object.keys(manusV2AttachmentUnknownAttempts(metadata)).length > 0) ||
      knowledgeBaseCreateAttemptState(turn, metadata) !== "not_sent" ||
      (metadata.providerAttemptState !== undefined &&
        metadata.providerAttemptState !== "not_sent") ||
      Boolean(metadata.dispatchingAt || metadata.outcomeUnknownAt) ||
      (strictStartCancellation
        ? build.status !== "researching" ||
          build.revision !== 0 ||
          build.currentLeafId !== null ||
          build.upstreamTaskId !== null
        : !(
            build.status === "confirming" ||
            (turn.operationType === "start" &&
              build.status === "researching" &&
              build.revision === 0 &&
              build.currentLeafId === null &&
              build.upstreamTaskId === null)
          ))
    ) {
      throw new KnowledgeBaseTurnReservationError(
        "CONFLICT",
        "Only an unprepared active upload turn can be cancelled",
      );
    }
    if (
      turn.operationType === "start" ||
      (strictRevisionCancellation && turn.operationType === "revise")
    ) {
      await assertDeferredResetRevisionInTransaction({
        tx,
        turn,
        metadata,
        expectedResetRevision: input.expectedResetRevision,
      });
    }
    const now = input.now ?? new Date();
    let strictStartConversation: typeof conversations.$inferSelect | null =
      null;
    if (strictStartCancellation) {
      const buildTurns = (await tx
        .select()
        .from(conversationTurns)
        .where(
          and(
            eq(conversationTurns.userId, input.userId),
            eq(conversationTurns.buildId, build.id),
          ),
        )
        .limit(2)
        .for("update")) as ConversationTurn[];
      const buildNodes = await tx
        .select({ id: knowledgeBaseBuildNodes.id })
        .from(knowledgeBaseBuildNodes)
        .where(eq(knowledgeBaseBuildNodes.buildId, build.id))
        .limit(1)
        .for("update");
      const conversation = (
        await tx
          .select()
          .from(conversations)
          .where(
            and(
              eq(conversations.id, turn.conversationId),
              eq(conversations.userId, input.userId),
            ),
          )
          .limit(1)
          .for("update")
      )[0] as typeof conversations.$inferSelect | undefined;
      const conversationMessages = await tx
        .select()
        .from(messages)
        .where(
          and(
            eq(messages.userId, input.userId),
            eq(messages.conversationId, turn.conversationId),
          ),
        )
        .limit(2)
        .for("update");
      const onlyMessage = conversationMessages[0];
      const onlyMessageMetadata = onlyMessage
        ? parsedKnowledgeBaseMessageMetadata(onlyMessage.metadata)
        : undefined;
      const pristineBuild =
        buildTurns.length === 1 &&
        buildTurns[0]?.id === turn.id &&
        buildNodes.length === 0 &&
        (build.totalNodeCount ?? 0) === 0 &&
        (build.confirmedCount ?? 0) === 0 &&
        (build.directPrefilledCount ?? 0) === 0 &&
        (build.needsVerificationCount ?? 0) === 0 &&
        !build.currentPresentationKey &&
        !build.lastAppliedOperationKey &&
        !build.canonicalTaskId &&
        !build.canonicalTaskGeneration &&
        !build.canonicalCredentialId &&
        (!build.canonicalTaskState || build.canonicalTaskState === "unbound") &&
        (!build.handoffProvenance ||
          knowledgeBaseMaterializedRecoveryContractVersion(build) === 1) &&
        !build.initialResearchCoverage &&
        !build.publishedSnapshotId &&
        !build.contentCompletedAt &&
        !build.packageTaskId &&
        !build.packageOutputItemId &&
        !build.packageFileId &&
        !build.packageDescriptorHash &&
        !build.packageStorageKey &&
        !build.packageArchiveSha256 &&
        !build.packageSizeBytes &&
        (!build.packageStatus || build.packageStatus === "not_started") &&
        (build.packageAttemptCount ?? 0) === 0 &&
        !build.completedAt &&
        !build.publishedAt &&
        (build.lastOutputLength ?? 0) === 0 &&
        (!Array.isArray(build.lastOutputItemIds) ||
          build.lastOutputItemIds.length === 0);
      const pristineConversation =
        conversation?.id === turn.conversationId &&
        conversation.projectAssignmentId === null &&
        conversation.deletedAt === null &&
        conversation.status === "running" &&
        !conversation.upstreamTaskId &&
        !conversation.previousResponseId &&
        (conversation.lastKnownOutputLength ?? 0) === 0 &&
        conversationMessages.length === 1 &&
        onlyMessage?.deletedAt == null &&
        onlyMessageMetadata?.kind === "pending_user" &&
        matchesAuthoritativeKnowledgeBaseMessageTuple({
          message: onlyMessage,
          knowledgeBase: onlyMessageMetadata,
          turn,
          build,
          publicConversationId: build.conversationId,
        });
      if (!pristineBuild || !pristineConversation) {
        throw new KnowledgeBaseTurnReservationError(
          "CONFLICT",
          "Only a pristine, zero-result start batch can be retired",
        );
      }
      strictStartConversation = conversation;
    }
    const {
      leaseOwnerHash: _leaseOwnerHash,
      outcomeUnknownAt: _outcomeUnknownAt,
      outcomeUnknownCode: _outcomeUnknownCode,
      ...metadataWithoutLease
    } = metadata;
    const stagedAttachments = Array.isArray(metadata.clientStagedAttachments)
      ? metadata.clientStagedAttachments
      : [];
    const stagedAttachmentFileIds = strictStartCancellation
      ? stagedAttachments.map((attachment) =>
          String(attachment.file_id || "").trim(),
        )
      : [];
    if (strictStartCancellation) {
      const recovery = metadata.recovery || {};
      const recoveryAttachments = Array.isArray(recovery.attachments)
        ? recovery.attachments
        : [];
      const sourceProofs = Array.isArray(recovery.attachmentSourceProofs)
        ? recovery.attachmentSourceProofs
        : [];
      const ledgerMatches =
        turn.attachmentFileIds.length === stagedAttachments.length &&
        recoveryAttachments.length === stagedAttachments.length &&
        sourceProofs.length === stagedAttachments.length &&
        stagedAttachments.every((staged, index) => {
          const attachment = recoveryAttachments[index] as
            | Record<string, unknown>
            | undefined;
          const proof = sourceProofs[index] as
            | Record<string, unknown>
            | undefined;
          return (
            staged.index === index &&
            Boolean(stagedAttachmentFileIds[index]) &&
            turn.attachmentFileIds[index] === staged.file_id &&
            attachment?.file_id === staged.file_id &&
            attachment?.filename === staged.filename &&
            proof?.index === index &&
            proof?.fileId === staged.file_id &&
            proof?.filename === staged.filename &&
            (staged.managedIntentId === undefined ||
              proof.managedIntentId === staged.managedIntentId)
          );
        }) &&
        new Set(stagedAttachmentFileIds).size ===
          stagedAttachmentFileIds.length;
      if (!ledgerMatches) {
        throw new KnowledgeBaseTurnReservationError(
          "CONFLICT",
          "The staged start ledger no longer matches its recovery authority",
        );
      }
    }
    if (strictStartCancellation && stagedAttachmentFileIds.length > 0) {
      if (!turn.apiCredentialId) {
        throw new KnowledgeBaseTurnReservationError(
          "CONFLICT",
          "The staged start files have no credential authority",
        );
      }
      const stagedCredentialId = turn.apiCredentialId;
      const stagedResources = (await tx
        .select()
        .from(upstreamResources)
        .where(
          and(
            eq(upstreamResources.userId, input.userId),
            eq(upstreamResources.apiCredentialId, stagedCredentialId),
            eq(upstreamResources.kind, "file"),
            eq(upstreamResources.conversationId, turn.conversationId),
            inArray(upstreamResources.upstreamId, stagedAttachmentFileIds),
          ),
        )
        .limit(stagedAttachmentFileIds.length)
        .for("update")) as UpstreamResource[];
      const foundFileIds = new Set(
        stagedResources.map((resource) => resource.upstreamId),
      );
      if (
        foundFileIds.size !== stagedAttachmentFileIds.length ||
        stagedAttachmentFileIds.some((fileId) => !foundFileIds.has(fileId)) ||
        stagedResources.some(
          (resource) =>
            resource.userId !== input.userId ||
            resource.apiCredentialId !== stagedCredentialId ||
            resource.kind !== "file" ||
            resource.conversationId !== turn.conversationId ||
            Boolean(resource.contentDeletedAt),
        )
      ) {
        throw new KnowledgeBaseTurnReservationError(
          "CONFLICT",
          "The staged start files are no longer exclusively bound to this batch",
        );
      }
    }
    const nextMetadataBase = { ...metadataWithoutLease };
    if (strictStartCancellation) {
      delete nextMetadataBase.clientStagedAttachments;
      nextMetadataBase.recovery = sanitizeKnowledgeBaseRecoveryMetadata({
        ...(metadataWithoutLease.recovery || {}),
        attachments: [],
        attachmentSourceProofs: [],
      });
    }
    const cancelledOperationKey = String(turn.operationKey);
    const tombstoneOperationKey = createHash("sha256")
      .update(
        `frontmind-kb-unprepared-cancellation:${turn.id}:${cancelledOperationKey}`,
        "utf8",
      )
      .digest("hex");
    const nextMetadata: KnowledgeBaseTurnMetadata = {
      ...nextMetadataBase,
      awaitingClientAttachments: false,
      unpreparedCancellation: true,
      cancelledOperationKey,
      dispatchState: "failed",
      failureClass: "requires_user_fix",
      recoveryAction: code.includes("LOGO")
        ? "reupload_logo"
        : "fix_attachments",
      canRegenerate: false,
    };
    const cancelledRecord = turnRecord({
      ...turn,
      operationKey: tombstoneOperationKey,
      upstreamIdempotencyKeyHash: hashKnowledgeBaseUpstreamIdempotencyKey(
        createKnowledgeBaseUpstreamIdempotencyKey(tombstoneOperationKey),
      ),
      status: "cancelled",
      ...(strictStartCancellation ? { attachmentFileIds: [] } : {}),
      errorCode: code,
      errorMessage: message,
      completedAt: now,
      leaseExpiresAt: null,
      metadata: nextMetadata,
      updatedAt: now,
    });
    if (strictStartCancellation) {
      const nextResetRevision = Number(input.expectedResetRevision) + 1;
      const resetUpdate = await tx
        .update(knowledgeBaseResetStates)
        .set({ revision: nextResetRevision, updatedAt: now })
        .where(
          and(
            eq(knowledgeBaseResetStates.userId, input.userId),
            eq(
              knowledgeBaseResetStates.revision,
              Number(input.expectedResetRevision),
            ),
          ),
        );
      const affectedRows = Number(
        Array.isArray(resetUpdate)
          ? (resetUpdate[0] as { affectedRows?: unknown } | undefined)
              ?.affectedRows
          : (resetUpdate as { affectedRows?: unknown } | undefined)
              ?.affectedRows,
      );
      if (affectedRows !== 1) {
        throw new KnowledgeBaseTurnReservationError(
          "KNOWLEDGE_BASE_RESET_REVISION_CHANGED",
          "知识库已完成重置，请清空旧资料后重新开始",
        );
      }
      if (stagedAttachmentFileIds.length > 0) {
        const stagedCredentialId = turn.apiCredentialId!;
        await tx
          .update(upstreamResources)
          .set({ conversationId: null })
          .where(
            and(
              eq(upstreamResources.userId, input.userId),
              eq(upstreamResources.apiCredentialId, stagedCredentialId),
              eq(upstreamResources.kind, "file"),
              eq(upstreamResources.conversationId, turn.conversationId),
              inArray(upstreamResources.upstreamId, stagedAttachmentFileIds),
            ),
          );
      }
      await tx
        .insert(knowledgeBaseConversationRetentionTombstones)
        .values({
          id: randomUUID(),
          userId: input.userId,
          publicConversationId: build.conversationId,
          resetAt: now,
          createdAt: now,
        })
        .onDuplicateKeyUpdate({
          set: {
            id: sql`${knowledgeBaseConversationRetentionTombstones.id}`,
          },
        });
      await tx
        .delete(knowledgeBaseBuilds)
        .where(
          and(
            eq(knowledgeBaseBuilds.id, build.id),
            eq(knowledgeBaseBuilds.userId, input.userId),
            eq(knowledgeBaseBuilds.generation, build.generation),
            eq(knowledgeBaseBuilds.activeTurnId, turn.id),
          ),
        );
      await tx
        .delete(conversations)
        .where(
          and(
            eq(conversations.id, strictStartConversation!.id),
            eq(conversations.userId, input.userId),
            eq(conversations.version, strictStartConversation!.version),
          ),
        );
      return {
        ...cancelledRecord,
        cancelled: true as const,
        resetRevision: nextResetRevision,
        idempotent: false,
      };
    }
    await tx
      .update(knowledgeBaseBuilds)
      .set({
        status: turn.operationType === "start" ? "researching" : "confirming",
        stateEpoch: build.stateEpoch + 1,
        activeTurnId: null,
        awaitingResponseSince: null,
        protocolErrorCode: null,
        protocolError: null,
        updatedAt: now,
      })
      .where(
        and(
          eq(knowledgeBaseBuilds.id, build.id),
          eq(knowledgeBaseBuilds.userId, input.userId),
          eq(knowledgeBaseBuilds.generation, build.generation),
          eq(knowledgeBaseBuilds.activeTurnId, turn.id),
        ),
      );
    await tx
      .update(conversationTurns)
      .set({
        operationKey: tombstoneOperationKey,
        upstreamIdempotencyKeyHash: hashKnowledgeBaseUpstreamIdempotencyKey(
          createKnowledgeBaseUpstreamIdempotencyKey(tombstoneOperationKey),
        ),
        status: "cancelled",
        ...(strictStartCancellation ? { attachmentFileIds: [] } : {}),
        errorCode: code,
        errorMessage: message,
        completedAt: now,
        leaseExpiresAt: null,
        metadata: nextMetadata,
        updatedAt: now,
      })
      .where(eq(conversationTurns.id, turn.id));
    if (strictStartCancellation && stagedAttachmentFileIds.length > 0) {
      const stagedCredentialId = turn.apiCredentialId!;
      await tx
        .update(upstreamResources)
        .set({ conversationId: null })
        .where(
          and(
            eq(upstreamResources.userId, input.userId),
            eq(upstreamResources.apiCredentialId, stagedCredentialId),
            eq(upstreamResources.kind, "file"),
            eq(upstreamResources.conversationId, turn.conversationId),
            inArray(upstreamResources.upstreamId, stagedAttachmentFileIds),
          ),
        );
    }
    if (turn.operationType === "start") {
      await tx
        .update(messages)
        .set({ deletedAt: now, updatedAt: now })
        .where(
          and(
            eq(messages.userId, input.userId),
            eq(messages.conversationId, turn.conversationId),
            eq(messages.turnId, turn.id),
          ),
        );
      const conversation = (
        await tx
          .select()
          .from(conversations)
          .where(
            and(
              eq(conversations.id, turn.conversationId),
              eq(conversations.userId, input.userId),
            ),
          )
          .limit(1)
          .for("update")
      )[0];
      if (conversation) {
        await tx
          .update(conversations)
          .set({
            status: "idle",
            upstreamTaskId: null,
            previousResponseId: null,
            version: conversation.version + 1,
            completedAt: null,
            updatedAt: now,
          })
          .where(eq(conversations.id, conversation.id));
      }
    } else {
      await markKnowledgeBaseConversationAwaitingInputInTransaction({
        tx,
        userId: input.userId,
        conversationId: turn.conversationId,
        authoritativeTaskId: build.upstreamTaskId,
        updatedAt: now,
      });
    }
    return cancelledRecord;
  });
}

export async function cancelUnpreparedKnowledgeBaseTurn(
  input: {
    userId: number;
    turnId: string;
    clientRequestId?: string;
    leaseToken?: string;
    code: string;
    message: string;
    now?: Date;
  },
  executor?: any,
) {
  return cancelUnpreparedKnowledgeBaseTurnInternal(input, executor);
}

/**
 * Customer-visible release for a revise batch whose browser files have not
 * crossed the Provider boundary. This preserves the authoritative leaf and
 * Working Set while returning the conversation to awaiting input.
 */
export async function cancelIncompleteKnowledgeBaseRevision(
  input: {
    userId: number;
    conversationId: string;
    turnId: string;
    clientRequestId: string;
    expectedResetRevision: number;
    now?: Date;
  },
  executor?: any,
) {
  return cancelUnpreparedKnowledgeBaseTurnInternal(
    {
      ...input,
      strictRevisionCancellation: true,
      code: "KNOWLEDGE_BASE_REVISION_UPLOAD_CANCELLED",
      message: "客户已放弃本轮补充资料，可从当前知识节点继续",
    },
    executor,
  );
}

/**
 * Customer-visible cancellation for an incomplete first-build batch. Internal
 * Logo/user-attachment cancellation keeps using cancelUnpreparedKnowledgeBaseTurn;
 * this wrapper prevents that broader helper from becoming an HTTP authority.
 */
export async function cancelIncompleteKnowledgeBaseStart(
  input: {
    userId: number;
    conversationId: string;
    turnId: string;
    clientRequestId: string;
    expectedResetRevision: number;
    now?: Date;
  },
  executor?: any,
) {
  try {
    return await cancelUnpreparedKnowledgeBaseTurnInternal(
      {
        ...input,
        strictStartCancellation: true,
        code: "KNOWLEDGE_BASE_START_BATCH_CANCELLED",
        message: "客户已取消未完成的资料批次，可重新选择资料开始构建",
      },
      executor,
    );
  } catch (error) {
    if (
      !(error instanceof KnowledgeBaseTurnReservationError) ||
      error.code !== "RESERVATION_NOT_FOUND"
    ) {
      throw error;
    }
    const db = executor ?? (await requireDb());
    return db.transaction(async (tx: any) => {
      const tombstone = (
        await tx
          .select({ id: knowledgeBaseConversationRetentionTombstones.id })
          .from(knowledgeBaseConversationRetentionTombstones)
          .where(
            and(
              eq(
                knowledgeBaseConversationRetentionTombstones.userId,
                input.userId,
              ),
              eq(
                knowledgeBaseConversationRetentionTombstones.publicConversationId,
                input.conversationId,
              ),
            ),
          )
          .limit(1)
          .for("update")
      )[0];
      if (!tombstone) throw error;
      const state = (
        await tx
          .select({ revision: knowledgeBaseResetStates.revision })
          .from(knowledgeBaseResetStates)
          .where(eq(knowledgeBaseResetStates.userId, input.userId))
          .limit(1)
          .for("update")
      )[0];
      const currentRevision = Number(state?.revision);
      const cancelledRevision = input.expectedResetRevision + 1;
      if (!Number.isSafeInteger(currentRevision)) throw error;
      if (currentRevision < cancelledRevision) {
        throw new KnowledgeBaseTurnReservationError(
          "RESERVATION_NOT_FOUND",
          "Knowledge-base turn reservation was not found",
        );
      }
      return {
        cancelled: true as const,
        resetRevision: cancelledRevision,
        idempotent: true,
      };
    });
  }
}

export async function rejectUnacknowledgedKnowledgeBaseManualLogoTurn(
  input: {
    userId: number;
    buildId: string;
    buildGeneration: number;
    turnId: string;
    clientRequestId: string;
    leaseToken: string;
    code: string;
    message: string;
    now?: Date;
  },
  executor?: any,
) {
  const db = executor ?? (await requireDb());
  const buildId = normalizeRequiredId(input.buildId, "buildId", 36);
  assertInteger(input.buildGeneration, "buildGeneration", 1);
  const code = normalizeRequiredId(input.code, "cancellation code", 128);
  const message = String(input.message || "")
    .trim()
    .slice(0, 10_000);
  if (!message) {
    throw new KnowledgeBaseTurnReservationError(
      "INVALID_REQUEST",
      "Cancellation message is required",
    );
  }
  return db.transaction(async (tx: any) => {
    const build = (
      await tx
        .select()
        .from(knowledgeBaseBuilds)
        .where(
          and(
            eq(knowledgeBaseBuilds.id, buildId),
            eq(knowledgeBaseBuilds.userId, input.userId),
            eq(knowledgeBaseBuilds.generation, input.buildGeneration),
          ),
        )
        .limit(1)
        .for("update")
    )[0] as KnowledgeBaseBuild | undefined;
    const turn = (
      await tx
        .select()
        .from(conversationTurns)
        .where(
          and(
            eq(conversationTurns.id, input.turnId),
            eq(conversationTurns.userId, input.userId),
            eq(conversationTurns.buildId, buildId),
            eq(conversationTurns.buildGeneration, input.buildGeneration),
          ),
        )
        .limit(1)
        .for("update")
    )[0] as ConversationTurn | undefined;
    if (!build || !turn) {
      throw new KnowledgeBaseTurnReservationError(
        "RESERVATION_NOT_FOUND",
        "The unacknowledged manual Logo turn was not found",
      );
    }
    const metadata = metadataOf(turn);
    if (
      turn.status === "cancelled" &&
      metadata.unacknowledgedManualLogoCancellation === true
    ) {
      if (
        turn.clientRequestId === input.clientRequestId &&
        turn.errorCode === code &&
        turn.errorMessage === message &&
        metadata.unacknowledgedManualLogoCancellationAuthorityHash ===
          leaseOwnerHash(input.leaseToken)
      ) {
        return turnRecord(turn);
      }
      throw new KnowledgeBaseTurnReservationError(
        "CONFLICT",
        "The unacknowledged manual Logo turn was already cancelled by another request",
      );
    }

    const recovery = retryAuthorityRecord(metadata.recovery);
    const stagedUpload = retryAuthorityRecord(recovery?.officialLogoUpload);
    const preparedDispatch = metadata.preparedDispatch;
    const parentTaskId = normalizeRequiredId(
      String(recovery?.parentTaskId || ""),
      "manual Logo parentTaskId",
      255,
    );
    if (
      turn.clientRequestId !== input.clientRequestId ||
      build.activeTurnId !== turn.id ||
      metadata.leaseOwnerHash !== leaseOwnerHash(input.leaseToken) ||
      recovery?.kind !== "turn" ||
      recovery?.manualLogoSubmission !== true ||
      !stagedUpload ||
      stagedUpload.verified !== false ||
      metadata.attachmentsFrozen !== true ||
      !preparedDispatch ||
      (preparedDispatch.schemaVersion === 1
        ? preparedDispatch.requestBody.taskId !== parentTaskId
        : preparedDispatch.requestBody.taskId !== undefined) ||
      (turn.status !== "queued" && turn.status !== "running") ||
      Boolean(turn.upstreamTaskId) ||
      build.upstreamTaskId !== parentTaskId ||
      build.skillVersion !== "4" ||
      build.status !== "confirming" ||
      build.revision !== turn.expectedRevision ||
      (build.currentLeafId ?? null) !== (turn.expectedLeafId ?? null) ||
      (typeof metadata.expectedPresentationKey === "string" &&
        build.currentPresentationKey !== metadata.expectedPresentationKey) ||
      build.confirmedCount !== 0 ||
      build.directPrefilledCount !== 0
    ) {
      throw new KnowledgeBaseTurnReservationError(
        "CONFLICT",
        "Only an unacknowledged active manual Logo turn can be cancelled",
      );
    }

    const now = input.now ?? new Date();
    const {
      leaseOwnerHash: _leaseOwnerHash,
      dispatchingAt: _dispatchingAt,
      outcomeUnknownAt: _outcomeUnknownAt,
      outcomeUnknownCode: _outcomeUnknownCode,
      ...metadataWithoutLease
    } = metadata;
    const cancelledOperationKey = normalizeRequiredId(
      String(turn.operationKey || ""),
      "manual Logo operationKey",
      128,
    );
    const tombstoneOperationKey = createHash("sha256")
      .update(
        `frontmind-kb-unacknowledged-manual-logo-cancellation:${turn.id}:${cancelledOperationKey}`,
        "utf8",
      )
      .digest("hex");
    const nextMetadata: KnowledgeBaseTurnMetadata = {
      ...metadataWithoutLease,
      createAttemptState: "rejected",
      createAttemptUpdatedAt: now.toISOString(),
      unacknowledgedManualLogoCancellation: true,
      unacknowledgedManualLogoCancellationAuthorityHash:
        metadata.leaseOwnerHash,
      cancelledOperationKey,
    };
    const tombstoneIdempotencyKeyHash = hashKnowledgeBaseUpstreamIdempotencyKey(
      createKnowledgeBaseUpstreamIdempotencyKey(tombstoneOperationKey),
    );

    await tx
      .update(knowledgeBaseBuilds)
      .set({
        upstreamTaskId: parentTaskId,
        status: "confirming",
        stateEpoch: build.stateEpoch + 1,
        activeTurnId: null,
        awaitingResponseSince: null,
        protocolErrorCode: null,
        protocolError: null,
        updatedAt: now,
      })
      .where(
        and(
          eq(knowledgeBaseBuilds.id, build.id),
          eq(knowledgeBaseBuilds.userId, input.userId),
          eq(knowledgeBaseBuilds.generation, build.generation),
          eq(knowledgeBaseBuilds.activeTurnId, turn.id),
          eq(knowledgeBaseBuilds.upstreamTaskId, parentTaskId),
        ),
      );
    await tx
      .update(conversationTurns)
      .set({
        operationKey: tombstoneOperationKey,
        upstreamIdempotencyKeyHash: tombstoneIdempotencyKeyHash,
        status: "cancelled",
        errorCode: code,
        errorMessage: message,
        completedAt: now,
        leaseExpiresAt: null,
        metadata: nextMetadata,
        updatedAt: now,
      })
      .where(eq(conversationTurns.id, turn.id));
    await markKnowledgeBaseConversationAwaitingInputInTransaction({
      tx,
      userId: input.userId,
      conversationId: turn.conversationId,
      authoritativeTaskId: parentTaskId,
      updatedAt: now,
    });
    return turnRecord({
      ...turn,
      operationKey: tombstoneOperationKey,
      upstreamIdempotencyKeyHash: tombstoneIdempotencyKeyHash,
      status: "cancelled",
      errorCode: code,
      errorMessage: message,
      completedAt: now,
      leaseExpiresAt: null,
      metadata: nextMetadata,
      updatedAt: now,
    });
  });
}

/**
 * Reject a manual Logo continuation after the provider returned a real task id
 * but before the uploaded bytes were promoted into the build Logo slot. The
 * child task remains on the cancelled turn for audit; the build resumes from
 * its exact parent task and unchanged first-leaf presentation.
 */
export async function rejectAcknowledgedKnowledgeBaseManualLogoTurn(
  input: {
    userId: number;
    buildId: string;
    buildGeneration: number;
    turnId: string;
    clientRequestId: string;
    leaseToken: string;
    code:
      | "KNOWLEDGE_BASE_LOGO_UPLOAD_INVALID"
      | "KNOWLEDGE_BASE_LOGO_UPLOAD_CONFLICT";
    message: string;
    now?: Date;
  },
  executor?: any,
) {
  const db = executor ?? (await requireDb());
  const buildId = normalizeRequiredId(input.buildId, "buildId", 36);
  assertInteger(input.buildGeneration, "buildGeneration", 1);
  const code = normalizeRequiredId(input.code, "cancellation code", 128);
  const message = String(input.message || "")
    .trim()
    .slice(0, 10_000);
  if (!message) {
    throw new KnowledgeBaseTurnReservationError(
      "INVALID_REQUEST",
      "Cancellation message is required",
    );
  }
  return db.transaction(async (tx: any) => {
    // Keep the same build -> turn lock order used by reservation. A new Logo
    // request can race this rollback without deadlocking or clearing a newer
    // authoritative turn.
    const build = (
      await tx
        .select()
        .from(knowledgeBaseBuilds)
        .where(
          and(
            eq(knowledgeBaseBuilds.id, buildId),
            eq(knowledgeBaseBuilds.userId, input.userId),
            eq(knowledgeBaseBuilds.generation, input.buildGeneration),
          ),
        )
        .limit(1)
        .for("update")
    )[0] as KnowledgeBaseBuild | undefined;
    const turn = (
      await tx
        .select()
        .from(conversationTurns)
        .where(
          and(
            eq(conversationTurns.id, input.turnId),
            eq(conversationTurns.userId, input.userId),
            eq(conversationTurns.buildId, buildId),
            eq(conversationTurns.buildGeneration, input.buildGeneration),
          ),
        )
        .limit(1)
        .for("update")
    )[0] as ConversationTurn | undefined;
    if (!build || !turn) {
      throw new KnowledgeBaseTurnReservationError(
        "RESERVATION_NOT_FOUND",
        "The acknowledged manual Logo turn was not found",
      );
    }
    const metadata = metadataOf(turn);
    if (
      turn.status === "cancelled" &&
      metadata.acknowledgedManualLogoCancellation === true
    ) {
      if (
        turn.clientRequestId === input.clientRequestId &&
        turn.errorCode === code &&
        turn.errorMessage === message &&
        metadata.acknowledgedManualLogoCancellationAuthorityHash ===
          leaseOwnerHash(input.leaseToken)
      ) {
        return turnRecord(turn);
      }
      throw new KnowledgeBaseTurnReservationError(
        "CONFLICT",
        "The acknowledged manual Logo turn was already cancelled by another request",
      );
    }

    const recovery = retryAuthorityRecord(metadata.recovery);
    const promotedUpload = retryAuthorityRecord(recovery?.officialLogoUpload);
    const preparedDispatch = metadata.preparedDispatch;
    const parentTaskId = normalizeRequiredId(
      String(recovery?.parentTaskId || ""),
      "manual Logo parentTaskId",
      255,
    );
    if (
      turn.clientRequestId !== input.clientRequestId ||
      build.activeTurnId !== turn.id ||
      metadata.leaseOwnerHash !== leaseOwnerHash(input.leaseToken) ||
      recovery?.kind !== "turn" ||
      recovery?.manualLogoSubmission !== true ||
      !promotedUpload ||
      promotedUpload.verified !== false ||
      metadata.attachmentsFrozen !== true ||
      !preparedDispatch ||
      preparedDispatch.requestBody.taskId !== parentTaskId ||
      turn.status !== "running" ||
      !turn.upstreamTaskId ||
      parentTaskId === turn.upstreamTaskId ||
      build.upstreamTaskId !== turn.upstreamTaskId ||
      build.skillVersion !== "4" ||
      build.status !== "confirming" ||
      build.revision !== turn.expectedRevision ||
      (build.currentLeafId ?? null) !== (turn.expectedLeafId ?? null) ||
      (typeof metadata.expectedPresentationKey === "string" &&
        build.currentPresentationKey !== metadata.expectedPresentationKey) ||
      build.confirmedCount !== 0 ||
      build.directPrefilledCount !== 0
    ) {
      throw new KnowledgeBaseTurnReservationError(
        "CONFLICT",
        "Only an acknowledged active manual Logo turn can be cancelled",
      );
    }

    const now = input.now ?? new Date();
    const {
      leaseOwnerHash: _leaseOwnerHash,
      dispatchingAt: _dispatchingAt,
      outcomeUnknownAt: _outcomeUnknownAt,
      outcomeUnknownCode: _outcomeUnknownCode,
      ...metadataWithoutLease
    } = metadata;
    const cancelledOperationKey = normalizeRequiredId(
      String(turn.operationKey || ""),
      "manual Logo operationKey",
      128,
    );
    const tombstoneOperationKey = createHash("sha256")
      .update(
        `frontmind-kb-acknowledged-manual-logo-cancellation:${turn.id}:${cancelledOperationKey}`,
        "utf8",
      )
      .digest("hex");
    const nextMetadata: KnowledgeBaseTurnMetadata = {
      ...metadataWithoutLease,
      acknowledgedManualLogoCancellation: true,
      acknowledgedManualLogoCancellationAuthorityHash: metadata.leaseOwnerHash,
      cancelledOperationKey,
    };
    const tombstoneIdempotencyKeyHash = hashKnowledgeBaseUpstreamIdempotencyKey(
      createKnowledgeBaseUpstreamIdempotencyKey(tombstoneOperationKey),
    );

    await tx
      .update(knowledgeBaseBuilds)
      .set({
        upstreamTaskId: parentTaskId,
        status: "confirming",
        stateEpoch: build.stateEpoch + 1,
        activeTurnId: null,
        awaitingResponseSince: null,
        protocolErrorCode: null,
        protocolError: null,
        updatedAt: now,
      })
      .where(
        and(
          eq(knowledgeBaseBuilds.id, build.id),
          eq(knowledgeBaseBuilds.userId, input.userId),
          eq(knowledgeBaseBuilds.generation, build.generation),
          eq(knowledgeBaseBuilds.activeTurnId, turn.id),
          eq(knowledgeBaseBuilds.upstreamTaskId, turn.upstreamTaskId),
        ),
      );
    await tx
      .update(conversationTurns)
      .set({
        operationKey: tombstoneOperationKey,
        upstreamIdempotencyKeyHash: tombstoneIdempotencyKeyHash,
        status: "cancelled",
        errorCode: code,
        errorMessage: message,
        completedAt: now,
        leaseExpiresAt: null,
        metadata: nextMetadata,
        updatedAt: now,
      })
      .where(eq(conversationTurns.id, turn.id));
    await markKnowledgeBaseConversationAwaitingInputInTransaction({
      tx,
      userId: input.userId,
      conversationId: turn.conversationId,
      authoritativeTaskId: parentTaskId,
      updatedAt: now,
    });
    return turnRecord({
      ...turn,
      operationKey: tombstoneOperationKey,
      upstreamIdempotencyKeyHash: tombstoneIdempotencyKeyHash,
      status: "cancelled",
      errorCode: code,
      errorMessage: message,
      completedAt: now,
      leaseExpiresAt: null,
      metadata: nextMetadata,
      updatedAt: now,
    });
  });
}

function materializedResultSettlementIsExact(input: {
  turn: ConversationTurn;
  build: KnowledgeBaseBuild;
  metadata: KnowledgeBaseTurnMetadata;
  code: KnowledgeBaseMaterializedResultFailureCode;
}) {
  const { turn, build, metadata, code } = input;
  return (
    turn.status === "failed" &&
    turn.errorCode === code &&
    turn.leaseExpiresAt === null &&
    build.status === "protocol_error" &&
    build.activeTurnId === null &&
    build.canonicalTaskState === "attention_required" &&
    build.protocolErrorCode === code &&
    metadata.providerAttemptState === "result_rejected" &&
    metadata.dispatchState === "failed" &&
    metadata.failureClass === "requires_user_fix" &&
    metadata.recoveryAction === "approve_reset" &&
    metadata.canRegenerate === false
  );
}

function assertMaterializedResultPendingAuthority(input: {
  turn: ConversationTurn;
  build: KnowledgeBaseBuild;
  metadata: KnowledgeBaseTurnMetadata;
}) {
  const { turn, build, metadata } = input;
  const taskId = turn.upstreamTaskId;
  if (
    build.activeTurnId !== turn.id ||
    build.executionMode !== "materialized_bundle_v1" ||
    build.skillVersion !== "5" ||
    build.providerProtocol !== "manus_v2" ||
    (build.status !== "researching" && build.status !== "confirming") ||
    !taskId ||
    build.upstreamTaskId !== taskId ||
    (build.canonicalTaskId !== null && build.canonicalTaskId !== taskId) ||
    metadata.materializedRecoveryContractVersion !== 1 ||
    metadata.providerProtocol !== "manus_v2" ||
    metadata.createAttemptState !== "acknowledged" ||
    metadata.providerAttemptState !== "output_pending"
  ) {
    throw new KnowledgeBaseTurnReservationError(
      "CONFLICT",
      "Only the active materialized result reader may settle this turn",
    );
  }
}

function assertMaterializedCompletionV2Authority(input: {
  turn: ConversationTurn;
  build: KnowledgeBaseBuild;
  metadata: KnowledgeBaseTurnMetadata;
}) {
  assertMaterializedResultPendingAuthority(input);
  if (
    knowledgeBaseMaterializedCompletionContractVersion(input.build) !==
      KNOWLEDGE_BASE_MATERIALIZED_COMPLETION_CONTRACT_VERSION ||
    input.metadata.materializedCompletionContractVersion !==
      KNOWLEDGE_BASE_MATERIALIZED_COMPLETION_CONTRACT_VERSION
  ) {
    throw new KnowledgeBaseTurnReservationError(
      "CONFLICT",
      "Historical materialized tasks cannot use completion terminalization",
    );
  }
}

function completionLedger(
  metadata: KnowledgeBaseTurnMetadata,
): KnowledgeBaseMaterializedCompletionLedger {
  const value = metadata.materializedCompletion;
  return value?.schemaVersion === 1 ? { ...value } : { schemaVersion: 1 };
}

const MAX_MATERIALIZED_RESULT_DIAGNOSTIC_CANDIDATES = 16;

function materializedResultDiagnosticsLedger(
  metadata: KnowledgeBaseTurnMetadata,
): KnowledgeBaseMaterializedResultDiagnosticsLedger {
  const value = metadata.materializedResultDiagnostics;
  return value?.schemaVersion === 1 && Array.isArray(value.candidates)
    ? {
        ...value,
        candidates: value.candidates
          .filter(
            (
              candidate,
            ): candidate is KnowledgeBaseMaterializedResultDiagnostic =>
              Boolean(
                candidate &&
                  typeof candidate === "object" &&
                  /^[a-f0-9]{64}$/u.test(candidate.descriptorHash) &&
                  /^[a-f0-9]{64}$/u.test(candidate.archiveSha),
              ),
          )
          .slice(-MAX_MATERIALIZED_RESULT_DIAGNOSTIC_CANDIDATES)
          .map((candidate) => ({ ...candidate })),
      }
    : { schemaVersion: 1, candidates: [] };
}

/**
 * Observe one exact-task archive after download and optionally freeze its
 * first deterministic normalization failure. A committed deterministic entry
 * is a cross-sweep replay fence: callers must skip the normalizer for that
 * same descriptor+byte tuple, while remaining free to inspect other ZIPs.
 */
export async function observeKnowledgeBaseMaterializedResultDiagnostic(
  input: {
    userId: number;
    turnId: string;
    leaseToken: string;
    taskId: string;
    descriptorHash: string;
    archiveSha: string;
    resultProcessingStage: KnowledgeBaseMaterializedResultDiagnostic["resultProcessingStage"];
    firstTypedFailureCode?: string;
    deterministicFailure?: boolean;
    now?: Date;
  },
  executor?: any,
): Promise<{
  skipNormalization: boolean;
  diagnostic: KnowledgeBaseMaterializedResultDiagnostic;
}> {
  const taskId = normalizeRequiredId(input.taskId, "taskId", 255);
  const descriptorHash = normalizeRequiredId(
    input.descriptorHash,
    "descriptorHash",
    64,
  ).toLowerCase();
  const archiveSha = normalizeRequiredId(
    input.archiveSha,
    "archiveSha",
    64,
  ).toLowerCase();
  if (
    !/^[a-f0-9]{64}$/u.test(descriptorHash) ||
    !/^[a-f0-9]{64}$/u.test(archiveSha)
  ) {
    throw new KnowledgeBaseTurnReservationError(
      "INVALID_REQUEST",
      "Materialized result diagnostic hashes are invalid",
    );
  }
  const firstTypedFailureCode = input.firstTypedFailureCode
    ? normalizeRequiredId(
        input.firstTypedFailureCode,
        "firstTypedFailureCode",
        128,
      )
    : undefined;
  if (input.deterministicFailure && !firstTypedFailureCode) {
    throw new KnowledgeBaseTurnReservationError(
      "INVALID_REQUEST",
      "A deterministic result diagnostic requires a typed failure code",
    );
  }
  const db = executor ?? (await requireDb());
  return db.transaction(async (tx: any) => {
    const { turn, build } = await lockedOwnedTurnAndBuild(tx, input);
    assertLease(turn, input.leaseToken);
    const metadata = metadataOf(turn);
    assertMaterializedResultPendingAuthority({ turn, build, metadata });
    if (turn.upstreamTaskId !== taskId) {
      throw new KnowledgeBaseTurnReservationError(
        "CONFLICT",
        "Materialized result diagnostic task does not match the bound task",
      );
    }
    const now = input.now ?? new Date();
    const ledger = materializedResultDiagnosticsLedger(metadata);
    const matchIndex = ledger.candidates.findIndex(
      (candidate) =>
        candidate.descriptorHash === descriptorHash &&
        candidate.archiveSha === archiveSha,
    );
    const existing =
      matchIndex >= 0 ? ledger.candidates[matchIndex] : undefined;
    const normalizationAttemptId = sha256(
      [turn.id, taskId, descriptorHash, archiveSha, input.leaseToken].join(
        "\0",
      ),
    );
    const interruptedAttempt = Boolean(
      existing &&
        !existing.deterministicFailure &&
        existing.normalizationAttemptId !== normalizationAttemptId,
    );
    const effectiveFailureCode =
      existing?.firstTypedFailureCode ||
      (interruptedAttempt
        ? "KNOWLEDGE_BASE_RESULT_PROCESSING_INTERRUPTED"
        : firstTypedFailureCode);
    const resultProcessingStage = existing?.deterministicFailure
      ? existing.resultProcessingStage
      : interruptedAttempt
        ? existing?.resultProcessingStage || "canonical_validation"
        : input.resultProcessingStage;
    const diagnostic: KnowledgeBaseMaterializedResultDiagnostic = {
      descriptorHash,
      archiveSha,
      resultProcessingStage,
      ...(effectiveFailureCode
        ? {
            firstTypedFailureCode: effectiveFailureCode,
          }
        : {}),
      ...(existing?.deterministicFailure ||
      input.deterministicFailure ||
      interruptedAttempt
        ? { deterministicFailure: true as const }
        : {}),
      normalizationAttemptId:
        existing?.deterministicFailure || interruptedAttempt
          ? existing?.normalizationAttemptId || normalizationAttemptId
          : normalizationAttemptId,
      normalizationStartedAt:
        existing?.normalizationStartedAt || now.toISOString(),
      firstObservedAt: existing?.firstObservedAt || now.toISOString(),
      lastObservedAt: now.toISOString(),
    };
    const candidates = [...ledger.candidates];
    if (matchIndex >= 0) candidates.splice(matchIndex, 1);
    candidates.push(diagnostic);
    const bounded = candidates.slice(
      -MAX_MATERIALIZED_RESULT_DIAGNOSTIC_CANDIDATES,
    );
    const next: KnowledgeBaseMaterializedResultDiagnosticsLedger = {
      schemaVersion: 1,
      descriptorHash,
      archiveSha,
      resultProcessingStage,
      ...(ledger.firstTypedFailureCode || effectiveFailureCode
        ? {
            firstTypedFailureCode:
              ledger.firstTypedFailureCode || effectiveFailureCode,
          }
        : {}),
      candidates: bounded,
    };
    const updated = await tx
      .update(conversationTurns)
      .set({
        metadata: { ...metadata, materializedResultDiagnostics: next },
        updatedAt: now,
      })
      .where(
        and(
          eq(conversationTurns.id, turn.id),
          eq(conversationTurns.userId, input.userId),
          eq(conversationTurns.buildId, build.id),
          eq(conversationTurns.buildGeneration, build.generation),
          inArray(conversationTurns.status, ["queued", "running"]),
        ),
      );
    if (!updated[0]?.affectedRows) {
      throw new KnowledgeBaseTurnReservationError(
        "CONFLICT",
        "Materialized result diagnostic lost its active turn fence",
      );
    }
    return {
      skipNormalization:
        existing?.deterministicFailure === true || interruptedAttempt,
      diagnostic,
    };
  });
}

function advanceMaterializedActiveRunningClock(input: {
  ledger: KnowledgeBaseMaterializedCompletionLedger;
  turn: ConversationTurn;
  now: Date;
  isRunning: boolean;
}): KnowledgeBaseMaterializedCompletionLedger {
  const { ledger, turn, now, isRunning } = input;
  const {
    runningObservedAt: _runningObservedAt,
    activeRunningMs: _activeRunningMs,
    ...retained
  } = ledger;
  const priorActiveRunningMs =
    Number.isSafeInteger(ledger.activeRunningMs) &&
    Number(ledger.activeRunningMs) >= 0
      ? Number(ledger.activeRunningMs)
      : 0;
  let activeRunningMs = priorActiveRunningMs;
  if (ledger.lastStatus === "running") {
    const observedMs = Date.parse(
      ledger.runningObservedAt ||
        ledger.lastObservedAt ||
        ledger.statusFirstObservedAt ||
        "",
    );
    const fallbackStartedMs = turn.startedAt?.getTime() ?? Number.NaN;
    const segmentObservedMs = Number.isFinite(observedMs)
      ? observedMs
      : fallbackStartedMs;
    if (Number.isFinite(segmentObservedMs)) {
      activeRunningMs = Math.min(
        Number.MAX_SAFE_INTEGER,
        activeRunningMs + Math.max(0, now.getTime() - segmentObservedMs),
      );
    }
  } else if (ledger.lastStatus === undefined && isRunning) {
    const startedMs = turn.startedAt?.getTime() ?? Number.NaN;
    if (Number.isFinite(startedMs)) {
      activeRunningMs = Math.min(
        Number.MAX_SAFE_INTEGER,
        activeRunningMs + Math.max(0, now.getTime() - startedMs),
      );
    }
  }
  return {
    ...retained,
    schemaVersion: 1,
    activeRunningMs,
    ...(isRunning ? { runningObservedAt: now.toISOString() } : {}),
  };
}

function completionLedgerWithoutCandidate(
  ledger: KnowledgeBaseMaterializedCompletionLedger,
): KnowledgeBaseMaterializedCompletionLedger {
  const {
    candidateEventIdHash: _candidateEventIdHash,
    storageKey: _storageKey,
    candidateArchiveSha256: _candidateArchiveSha256,
    sizeBytes: _sizeBytes,
    firstObservedAt: _firstObservedAt,
    lastObservedAt: _lastObservedAt,
    stableAt: _stableAt,
    naturalStopDeadlineAt: _naturalStopDeadlineAt,
    stopAttemptState: _stopAttemptState,
    stopAttemptedAt: _stopAttemptedAt,
    stopRequestRefHash: _stopRequestRefHash,
    stopSettleDeadlineAt: _stopSettleDeadlineAt,
    ...retained
  } = ledger;
  return retained;
}

function completionPollAt(now: Date, deadlineAt?: string) {
  const deadlineMs = Date.parse(deadlineAt || "");
  const nextMs = Number.isFinite(deadlineMs)
    ? Math.min(
        now.getTime() + KNOWLEDGE_BASE_MATERIALIZED_COMPLETION_POLL_MS,
        deadlineMs,
      )
    : now.getTime() + KNOWLEDGE_BASE_MATERIALIZED_COMPLETION_POLL_MS;
  return new Date(Math.max(now.getTime() + 1_000, nextMs));
}

export type KnowledgeBaseMaterializedCompletionCandidateDisposition =
  | "stabilizing"
  | "natural_stop_wait"
  | "stop_due"
  | "stop_pending"
  | "stop_settle_expired";

/**
 * Stage one fully validated running-result candidate under the active turn
 * writer fence. Descriptor identities may rotate, but a different canonical
 * byte hash or storage tuple resets stability; only canonical-equivalent
 * content can advance to bounded task.stop.
 */
export async function observeKnowledgeBaseMaterializedCompletionCandidate(
  input: {
    userId: number;
    turnId: string;
    leaseToken: string;
    candidateEventIdHash: string;
    storageKey: string;
    candidateArchiveSha256: string;
    sizeBytes: number;
    providerStatus?: string;
    now?: Date;
  },
  executor?: any,
): Promise<{
  disposition: KnowledgeBaseMaterializedCompletionCandidateDisposition;
  ledger: KnowledgeBaseMaterializedCompletionLedger;
  deduplicated: boolean;
}> {
  const candidateEventIdHash = normalizeRequiredId(
    input.candidateEventIdHash,
    "candidateEventIdHash",
    64,
  );
  const storageKey = normalizeRequiredId(input.storageKey, "storageKey", 1024);
  const candidateArchiveSha256 = normalizeRequiredId(
    input.candidateArchiveSha256,
    "candidateArchiveSha256",
    64,
  );
  if (
    !/^[a-f0-9]{64}$/u.test(candidateEventIdHash) ||
    !/^[a-f0-9]{64}$/u.test(candidateArchiveSha256) ||
    !Number.isSafeInteger(input.sizeBytes) ||
    input.sizeBytes < 1 ||
    input.sizeBytes > 100 * 1024 * 1024
  ) {
    throw new KnowledgeBaseTurnReservationError(
      "INVALID_REQUEST",
      "Materialized completion candidate proof is invalid",
    );
  }
  const db = executor ?? (await requireDb());
  return db.transaction(async (tx: any) => {
    const { turn, build } = await lockedOwnedTurnAndBuild(tx, input);
    assertLease(turn, input.leaseToken);
    const metadata = metadataOf(turn);
    assertMaterializedCompletionV2Authority({ turn, build, metadata });
    const now = input.now ?? new Date();
    const stored = completionLedger(metadata);
    const sameCandidate =
      stored.storageKey === storageKey &&
      stored.candidateArchiveSha256 === candidateArchiveSha256 &&
      stored.sizeBytes === input.sizeBytes;
    if (stored.stopAttemptState && !sameCandidate) {
      throw new KnowledgeBaseTurnReservationError(
        "CONFLICT",
        "A task.stop candidate cannot be replaced or re-staged",
      );
    }
    const providerStatus =
      safeProviderDiagnostic(input.providerStatus, 64) || "running";
    const clocked = advanceMaterializedActiveRunningClock({
      ledger: stored,
      turn,
      now,
      isRunning: providerStatus === "running",
    });
    const firstObservedAt = sameCandidate
      ? stored.firstObservedAt || now.toISOString()
      : now.toISOString();
    const firstObservedMs = Date.parse(firstObservedAt);
    let stableAt = sameCandidate ? stored.stableAt : undefined;
    let naturalStopDeadlineAt = sameCandidate
      ? stored.naturalStopDeadlineAt
      : undefined;
    if (
      !stableAt &&
      Number.isFinite(firstObservedMs) &&
      now.getTime() - firstObservedMs >=
        KNOWLEDGE_BASE_MATERIALIZED_CANDIDATE_STABILITY_MS
    ) {
      stableAt = now.toISOString();
      naturalStopDeadlineAt = new Date(
        now.getTime() + KNOWLEDGE_BASE_MATERIALIZED_NATURAL_STOP_WINDOW_MS,
      ).toISOString();
    }
    const ledger: KnowledgeBaseMaterializedCompletionLedger = {
      ...(sameCandidate ? clocked : completionLedgerWithoutCandidate(clocked)),
      schemaVersion: 1,
      lastStatus: providerStatus,
      candidateEventIdHash,
      storageKey,
      candidateArchiveSha256,
      sizeBytes: input.sizeBytes,
      firstObservedAt,
      lastObservedAt: now.toISOString(),
      ...(stableAt ? { stableAt } : {}),
      ...(naturalStopDeadlineAt ? { naturalStopDeadlineAt } : {}),
    };
    const settleDeadlineMs = Date.parse(ledger.stopSettleDeadlineAt || "");
    const naturalDeadlineMs = Date.parse(ledger.naturalStopDeadlineAt || "");
    const disposition: KnowledgeBaseMaterializedCompletionCandidateDisposition =
      ledger.stopAttemptState
        ? Number.isFinite(settleDeadlineMs) && now.getTime() >= settleDeadlineMs
          ? "stop_settle_expired"
          : "stop_pending"
        : !ledger.stableAt
          ? "stabilizing"
          : Number.isFinite(naturalDeadlineMs) &&
              now.getTime() >= naturalDeadlineMs
            ? "stop_due"
            : "natural_stop_wait";
    const nextDeadline =
      disposition === "stabilizing"
        ? new Date(
            firstObservedMs +
              KNOWLEDGE_BASE_MATERIALIZED_CANDIDATE_STABILITY_MS,
          ).toISOString()
        : disposition === "natural_stop_wait"
          ? ledger.naturalStopDeadlineAt
          : disposition === "stop_pending"
            ? ledger.stopSettleDeadlineAt
            : undefined;
    ledger.nextRetryAt = completionPollAt(now, nextDeadline).toISOString();
    const updatedMetadata: KnowledgeBaseTurnMetadata = {
      ...metadata,
      materializedCompletion: ledger,
      dispatchState: "recovering",
      failureClass: "recoverable_same_turn",
      recoveryAction: "wait",
      canRegenerate: false,
    };
    await tx
      .update(conversationTurns)
      .set({
        metadata: updatedMetadata,
        leaseExpiresAt: new Date(ledger.nextRetryAt),
        updatedAt: now,
      })
      .where(
        and(
          eq(conversationTurns.id, turn.id),
          eq(conversationTurns.userId, input.userId),
          eq(conversationTurns.buildId, build.id),
          eq(conversationTurns.buildGeneration, build.generation),
          inArray(conversationTurns.status, ["queued", "running"]),
        ),
      );
    return { disposition, ledger, deduplicated: sameCandidate };
  });
}

export type KnowledgeBaseMaterializedProviderStatus =
  | "running"
  | "waiting"
  | "quota_error"
  | "error"
  | "unknown"
  | "list_messages_404";

/**
 * Persist an explicit no-candidate Provider state with a hard deadline. Error
 * states not proven to be an exact quota type settle immediately; waiting and
 * quota interruption retain the same task for at most 24 hours.
 */
export async function deferKnowledgeBaseMaterializedProviderStatus(
  input: {
    userId: number;
    turnId: string;
    leaseToken: string;
    status: KnowledgeBaseMaterializedProviderStatus;
    resetCandidate?: boolean;
    now?: Date;
  },
  executor?: any,
): Promise<
  | {
      state: "deferred";
      retryAfterMs: number;
      ledger: KnowledgeBaseMaterializedCompletionLedger;
    }
  | { state: "unavailable"; turn: KnowledgeBaseTurnRecord }
> {
  const db = executor ?? (await requireDb());
  return db.transaction(async (tx: any) => {
    const { turn, build } = await lockedOwnedTurnAndBuild(tx, input);
    assertLease(turn, input.leaseToken);
    const metadata = metadataOf(turn);
    assertMaterializedCompletionV2Authority({ turn, build, metadata });
    const now = input.now ?? new Date();
    const original = completionLedger(metadata);
    if (input.resetCandidate && original.stopAttemptState) {
      throw new KnowledgeBaseTurnReservationError(
        "CONFLICT",
        "A task.stop candidate cannot be cleared by provider status",
      );
    }
    const stored = input.resetCandidate
      ? completionLedgerWithoutCandidate(original)
      : original;
    if (input.status === "error") {
      const settled =
        await settleLockedKnowledgeBaseMaterializedProviderAttention({
          tx,
          userId: input.userId,
          turn,
          build,
          metadata,
          now,
        });
      return { state: "unavailable", turn: settled };
    }
    const clocked = advanceMaterializedActiveRunningClock({
      ledger: stored,
      turn,
      now,
      isRunning: input.status === "running",
    });
    if (
      input.status === "running" &&
      Number(clocked.activeRunningMs) >= MATERIALIZED_RUNNING_PROGRESS_WINDOW_MS
    ) {
      const settled =
        await settleLockedKnowledgeBaseMaterializedResultForApprovedReset({
          tx,
          userId: input.userId,
          turn,
          build,
          metadata: {
            ...metadata,
            materializedCompletion: {
              ...clocked,
              schemaVersion: 1,
              lastStatus: "running",
              statusFirstObservedAt:
                stored.statusFirstObservedAt ||
                turn.startedAt?.toISOString() ||
                now.toISOString(),
              lastObservedAt: now.toISOString(),
            },
          },
          code: "KNOWLEDGE_BASE_MATERIALIZED_RESULT_UNAVAILABLE",
          now,
        });
      return { state: "unavailable", turn: settled };
    }
    const priorStatus = stored.lastStatus;
    const sameInterruptionClass =
      (priorStatus === "waiting" || priorStatus === "quota_error") &&
      (input.status === "waiting" || input.status === "quota_error");
    const sameStatus = priorStatus === input.status || sameInterruptionClass;
    const firstObservedAt = sameStatus
      ? stored.statusFirstObservedAt || now.toISOString()
      : input.status === "running" &&
          !priorStatus &&
          turn.startedAt instanceof Date &&
          Number.isFinite(turn.startedAt.getTime())
        ? turn.startedAt.toISOString()
        : now.toISOString();
    const firstObservedMs = Date.parse(firstObservedAt);
    const durationMs =
      input.status === "running"
        ? null
        : input.status === "list_messages_404" || input.status === "unknown"
          ? 10 * 60_000
          : input.status === "waiting" || input.status === "quota_error"
            ? 24 * 60 * 60_000
            : 10 * 60_000;
    const deadlineMs =
      durationMs === null ? null : firstObservedMs + durationMs;
    if (
      !Number.isFinite(firstObservedMs) ||
      (deadlineMs !== null &&
        (!Number.isFinite(deadlineMs) || now.getTime() >= deadlineMs))
    ) {
      const settled =
        await settleLockedKnowledgeBaseMaterializedResultForApprovedReset({
          tx,
          userId: input.userId,
          turn,
          build,
          metadata,
          code: "KNOWLEDGE_BASE_MATERIALIZED_RESULT_UNAVAILABLE",
          now,
        });
      return { state: "unavailable", turn: settled };
    }
    const nextRetryAt = completionPollAt(
      now,
      deadlineMs === null ? undefined : new Date(deadlineMs).toISOString(),
    );
    const { statusDeadlineAt: _statusDeadlineAt, ...clockedWithoutDeadline } =
      clocked;
    const ledger: KnowledgeBaseMaterializedCompletionLedger = {
      ...clockedWithoutDeadline,
      schemaVersion: 1,
      lastStatus: input.status,
      statusFirstObservedAt: firstObservedAt,
      ...(deadlineMs === null
        ? {}
        : { statusDeadlineAt: new Date(deadlineMs).toISOString() }),
      ...(input.status === "list_messages_404"
        ? { listMessages404FirstObservedAt: firstObservedAt }
        : {}),
      nextRetryAt: nextRetryAt.toISOString(),
    };
    await tx
      .update(conversationTurns)
      .set({
        metadata: {
          ...metadata,
          materializedCompletion: ledger,
          dispatchState: "recovering",
          failureClass: "recoverable_same_turn",
          recoveryAction:
            input.status === "quota_error"
              ? "top_up"
              : input.status === "waiting"
                ? "awaiting_input"
                : "wait",
          canRegenerate: false,
        },
        leaseExpiresAt: nextRetryAt,
        updatedAt: now,
      })
      .where(
        and(
          eq(conversationTurns.id, turn.id),
          eq(conversationTurns.userId, input.userId),
          eq(conversationTurns.buildId, build.id),
          eq(conversationTurns.buildGeneration, build.generation),
          inArray(conversationTurns.status, ["queued", "running"]),
        ),
      );
    return {
      state: "deferred",
      retryAfterMs: nextRetryAt.getTime() - now.getTime(),
      ledger,
    };
  });
}

/** Atomically spend the one allowed task.stop attempt for this candidate. */
export async function beginKnowledgeBaseMaterializedCompletionStop(
  input: {
    userId: number;
    turnId: string;
    leaseToken: string;
    now?: Date;
  },
  executor?: any,
): Promise<{
  send: boolean;
  ledger: KnowledgeBaseMaterializedCompletionLedger;
}> {
  const db = executor ?? (await requireDb());
  return db.transaction(async (tx: any) => {
    const { turn, build } = await lockedOwnedTurnAndBuild(tx, input);
    assertLease(turn, input.leaseToken);
    const metadata = metadataOf(turn);
    assertMaterializedCompletionV2Authority({ turn, build, metadata });
    const now = input.now ?? new Date();
    const ledger = completionLedger(metadata);
    if (ledger.stopAttemptState) return { send: false, ledger };
    const naturalDeadlineMs = Date.parse(ledger.naturalStopDeadlineAt || "");
    if (
      !ledger.stableAt ||
      !ledger.candidateEventIdHash ||
      !ledger.storageKey ||
      !ledger.candidateArchiveSha256 ||
      !ledger.sizeBytes ||
      !Number.isFinite(naturalDeadlineMs) ||
      now.getTime() < naturalDeadlineMs
    ) {
      throw new KnowledgeBaseTurnReservationError(
        "CONFLICT",
        "Materialized completion candidate is not eligible for task.stop",
      );
    }
    const stopSettleDeadlineAt = new Date(
      now.getTime() + KNOWLEDGE_BASE_MATERIALIZED_STOP_SETTLE_WINDOW_MS,
    ).toISOString();
    const next: KnowledgeBaseMaterializedCompletionLedger = {
      ...ledger,
      stopAttemptState: "sending",
      stopAttemptedAt: now.toISOString(),
      stopSettleDeadlineAt,
      nextRetryAt: completionPollAt(now, stopSettleDeadlineAt).toISOString(),
    };
    await tx
      .update(conversationTurns)
      .set({
        metadata: { ...metadata, materializedCompletion: next },
        leaseExpiresAt: new Date(next.nextRetryAt!),
        updatedAt: now,
      })
      .where(eq(conversationTurns.id, turn.id));
    return { send: true, ledger: next };
  });
}

export async function settleKnowledgeBaseMaterializedCompletionStopAttempt(
  input: {
    userId: number;
    turnId: string;
    leaseToken: string;
    state: "acknowledged" | "outcome_unknown" | "rejected";
    requestRef?: string | null;
    now?: Date;
  },
  executor?: any,
) {
  const db = executor ?? (await requireDb());
  return db.transaction(async (tx: any) => {
    const { turn, build } = await lockedOwnedTurnAndBuild(tx, input);
    assertLease(turn, input.leaseToken);
    const metadata = metadataOf(turn);
    assertMaterializedCompletionV2Authority({ turn, build, metadata });
    const now = input.now ?? new Date();
    const ledger = completionLedger(metadata);
    if (ledger.stopAttemptState && ledger.stopAttemptState !== "sending") {
      return { ledger, deduplicated: true };
    }
    if (ledger.stopAttemptState !== "sending") {
      throw new KnowledgeBaseTurnReservationError(
        "CONFLICT",
        "No materialized task.stop attempt is in flight",
      );
    }
    const requestRef = safeProviderDiagnostic(input.requestRef, 512);
    const attemptedAtMs = Date.parse(ledger.stopAttemptedAt || "");
    if (!Number.isFinite(attemptedAtMs)) {
      throw new KnowledgeBaseTurnReservationError(
        "CONFLICT",
        "Materialized task.stop attempt timestamp is invalid",
      );
    }
    const stopSettleDeadlineAt =
      input.state === "outcome_unknown"
        ? new Date(
            attemptedAtMs +
              KNOWLEDGE_BASE_MATERIALIZED_STOP_OUTCOME_UNKNOWN_WINDOW_MS,
          ).toISOString()
        : ledger.stopSettleDeadlineAt;
    const next: KnowledgeBaseMaterializedCompletionLedger = {
      ...ledger,
      stopAttemptState: input.state,
      ...(stopSettleDeadlineAt ? { stopSettleDeadlineAt } : {}),
      ...(requestRef ? { stopRequestRefHash: sha256(requestRef) } : {}),
      nextRetryAt: completionPollAt(now, stopSettleDeadlineAt).toISOString(),
    };
    await tx
      .update(conversationTurns)
      .set({
        metadata: { ...metadata, materializedCompletion: next },
        leaseExpiresAt: new Date(next.nextRetryAt!),
        updatedAt: now,
      })
      .where(eq(conversationTurns.id, turn.id));
    return { ledger: next, deduplicated: false };
  });
}

const KNOWLEDGE_BASE_MATERIALIZED_PROVIDER_ATTENTION =
  "KNOWLEDGE_BASE_MATERIALIZED_PROVIDER_ATTENTION";
const KNOWLEDGE_BASE_MATERIALIZED_PROVIDER_ATTENTION_MESSAGE =
  "原任务执行发生错误，系统不会自动重发；请联系支持处理。已完成内容不受影响。";

async function settleLockedKnowledgeBaseMaterializedProviderAttention(input: {
  tx: any;
  userId: number;
  turn: ConversationTurn;
  build: KnowledgeBaseBuild;
  metadata: KnowledgeBaseTurnMetadata;
  now: Date;
}) {
  return settleLockedKnowledgeBaseMaterializedResultForApprovedReset({
    ...input,
    code: KNOWLEDGE_BASE_MATERIALIZED_PROVIDER_ATTENTION,
    settlement: "provider_attention",
  });
}

async function settleLockedKnowledgeBaseMaterializedResultForApprovedReset(input: {
  tx: any;
  userId: number;
  turn: ConversationTurn;
  build: KnowledgeBaseBuild;
  metadata: KnowledgeBaseTurnMetadata;
  code:
    | KnowledgeBaseMaterializedResultFailureCode
    | typeof KNOWLEDGE_BASE_MATERIALIZED_PROVIDER_ATTENTION;
  settlement?: "result_reset" | "provider_attention";
  now: Date;
}) {
  const { tx, turn, build, metadata, code, now } = input;
  const providerAttention = input.settlement === "provider_attention";
  const customerMessage = providerAttention
    ? KNOWLEDGE_BASE_MATERIALIZED_PROVIDER_ATTENTION_MESSAGE
    : KNOWLEDGE_BASE_MATERIALIZED_RESULT_RESET_MESSAGE;
  assertMaterializedResultPendingAuthority({ turn, build, metadata });
  const resultRead = metadata.materializedResultRead;
  const terminalResultRead = resultRead
    ? (({ nextRetryAt: _nextRetryAt, ...retained }) => retained)(resultRead)
    : null;
  const completion = metadata.materializedCompletion;
  const terminalCompletion = completion
    ? (({ nextRetryAt: _nextRetryAt, ...retained }) => retained)(completion)
    : null;
  const failedMetadata: KnowledgeBaseTurnMetadata = {
    ...metadata,
    providerAttemptState: providerAttention
      ? "output_pending"
      : "result_rejected",
    dispatchState: "failed",
    failureClass: providerAttention
      ? "terminal_nonregenerable"
      : "requires_user_fix",
    recoveryAction: providerAttention ? "contact_support" : "approve_reset",
    canRegenerate: false,
    manusV2Lifecycle: {
      ...(metadata.manusV2Lifecycle || {}),
      attentionCode: code,
    },
    ...(terminalResultRead
      ? {
          materializedResultRead: terminalResultRead,
        }
      : {}),
    ...(terminalCompletion
      ? {
          materializedCompletion: terminalCompletion,
        }
      : {}),
  };
  const buildUpdated = await tx
    .update(knowledgeBaseBuilds)
    .set({
      status: "protocol_error",
      activeTurnId: null,
      canonicalTaskState: "attention_required",
      protocolErrorCode: code,
      protocolError: customerMessage,
      stateEpoch: build.stateEpoch + 1,
      recoveryLeaseOwnerHash: null,
      recoveryLeaseExpiresAt: null,
      awaitingResponseSince: null,
      updatedAt: now,
    })
    .where(
      and(
        eq(knowledgeBaseBuilds.id, build.id),
        eq(knowledgeBaseBuilds.userId, input.userId),
        eq(knowledgeBaseBuilds.generation, build.generation),
        eq(knowledgeBaseBuilds.stateEpoch, build.stateEpoch),
        eq(knowledgeBaseBuilds.activeTurnId, turn.id),
      ),
    );
  if (!buildUpdated[0]?.affectedRows) {
    throw new KnowledgeBaseTurnReservationError(
      "CONFLICT",
      "The materialized result lost its writer fence before settlement",
    );
  }
  const turnUpdated = await tx
    .update(conversationTurns)
    .set({
      status: "failed",
      errorCode: code,
      errorMessage: customerMessage,
      completedAt: turn.completedAt ?? now,
      leaseExpiresAt: null,
      metadata: failedMetadata,
      updatedAt: now,
    })
    .where(
      and(
        eq(conversationTurns.id, turn.id),
        eq(conversationTurns.userId, input.userId),
        eq(conversationTurns.buildId, build.id),
        eq(conversationTurns.buildGeneration, build.generation),
        inArray(conversationTurns.status, ["queued", "running"]),
      ),
    );
  if (!turnUpdated[0]?.affectedRows) {
    throw new KnowledgeBaseTurnReservationError(
      "CONFLICT",
      "The materialized result turn changed before settlement",
    );
  }
  await markKnowledgeBaseConversationFailedInTransaction({
    tx,
    userId: input.userId,
    conversationId: turn.conversationId,
    authoritativeTaskId:
      turn.upstreamTaskId || build.canonicalTaskId || build.upstreamTaskId,
    failedAt: now,
  });
  return turnRecord({
    ...turn,
    status: "failed",
    errorCode: code,
    errorMessage: customerMessage,
    completedAt: turn.completedAt ?? now,
    leaseExpiresAt: null,
    metadata: failedMetadata,
    updatedAt: now,
  });
}

/**
 * Reject one terminal materialized archive without weakening its contract or
 * creating a replacement task. The exact replay is idempotent even after the
 * writer fence has been released.
 */
export async function failKnowledgeBaseMaterializedResultForApprovedReset(
  input: {
    userId: number;
    turnId: string;
    leaseToken: string;
    code: KnowledgeBaseMaterializedResultFailureCode;
    now?: Date;
  },
  executor?: any,
): Promise<{ turn: KnowledgeBaseTurnRecord; deduplicated: boolean }> {
  if (!isKnowledgeBaseMaterializedResultFailureCode(input.code)) {
    throw new KnowledgeBaseTurnReservationError(
      "INVALID_REQUEST",
      "Unsupported materialized result failure code",
    );
  }
  const db = executor ?? (await requireDb());
  return db.transaction(async (tx: any) => {
    const { turn, build } = await lockedOwnedTurnAndBuild(tx, input, {
      allowInactiveTurn: true,
    });
    const metadata = metadataOf(turn);
    if (metadata.leaseOwnerHash !== leaseOwnerHash(input.leaseToken)) {
      throw new KnowledgeBaseTurnReservationError(
        "LEASE_LOST",
        "Knowledge-base turn lease is owned by another worker",
        1_000,
      );
    }
    if (
      materializedResultSettlementIsExact({
        turn,
        build,
        metadata,
        code: input.code,
      })
    ) {
      return { turn: turnRecord(turn), deduplicated: true };
    }
    assertLease(turn, input.leaseToken);
    const settledTurn =
      await settleLockedKnowledgeBaseMaterializedResultForApprovedReset({
        tx,
        userId: input.userId,
        turn,
        build,
        metadata,
        code: input.code,
        now: input.now ?? new Date(),
      });
    return { turn: settledTurn, deduplicated: false };
  });
}

export type KnowledgeBaseMaterializedResultReadDisposition =
  | {
      state: "deferred";
      firstObservedAt: string;
      attempt: number;
      nextRetryAt: string;
      retryAfterMs: number;
      deduplicated: boolean;
    }
  | {
      state: "unavailable";
      turn: KnowledgeBaseTurnRecord;
      deduplicated: boolean;
    };

/**
 * Lease-fenced retry schedule for transient reads of one stopped Manus result.
 * The original task remains the sole provider task; at ten minutes the same
 * transaction converts it to the approved-reset terminal state.
 */
export async function deferKnowledgeBaseMaterializedResultRead(
  input: {
    userId: number;
    turnId: string;
    leaseToken: string;
    lastErrorKind: string;
    now?: Date;
  },
  executor?: any,
): Promise<KnowledgeBaseMaterializedResultReadDisposition> {
  const lastErrorKind = safeProviderDiagnostic(input.lastErrorKind, 128);
  if (!lastErrorKind) {
    throw new KnowledgeBaseTurnReservationError(
      "INVALID_REQUEST",
      "A safe materialized result read error kind is required",
    );
  }
  const db = executor ?? (await requireDb());
  return db.transaction(async (tx: any) => {
    const { turn, build } = await lockedOwnedTurnAndBuild(tx, input, {
      allowInactiveTurn: true,
    });
    const metadata = metadataOf(turn);
    if (metadata.leaseOwnerHash !== leaseOwnerHash(input.leaseToken)) {
      throw new KnowledgeBaseTurnReservationError(
        "LEASE_LOST",
        "Knowledge-base turn lease is owned by another worker",
        1_000,
      );
    }
    if (
      materializedResultSettlementIsExact({
        turn,
        build,
        metadata,
        code: "KNOWLEDGE_BASE_MATERIALIZED_RESULT_UNAVAILABLE",
      })
    ) {
      return {
        state: "unavailable",
        turn: turnRecord(turn),
        deduplicated: true,
      };
    }
    assertLease(turn, input.leaseToken);
    assertMaterializedResultPendingAuthority({ turn, build, metadata });
    const now = input.now ?? new Date();
    const stored = metadata.materializedResultRead;
    const storedFirstObservedMs = stored
      ? Date.parse(stored.firstObservedAt)
      : Number.NaN;
    const firstObservedAt = stored ? stored.firstObservedAt : now.toISOString();
    const firstObservedMs = stored ? storedFirstObservedMs : now.getTime();
    const existingRetryAt = Date.parse(stored?.nextRetryAt || "");
    if (
      stored &&
      Number.isFinite(existingRetryAt) &&
      existingRetryAt > now.getTime()
    ) {
      return {
        state: "deferred",
        firstObservedAt,
        attempt: stored.attempt,
        nextRetryAt: stored.nextRetryAt!,
        retryAfterMs: existingRetryAt - now.getTime(),
        deduplicated: true,
      };
    }
    const deadlineAt = firstObservedMs + MATERIALIZED_RESULT_READ_WINDOW_MS;
    if (!Number.isFinite(firstObservedMs) || now.getTime() >= deadlineAt) {
      const settledTurn =
        await settleLockedKnowledgeBaseMaterializedResultForApprovedReset({
          tx,
          userId: input.userId,
          turn,
          build,
          metadata: {
            ...metadata,
            materializedResultRead: {
              firstObservedAt: Number.isFinite(firstObservedMs)
                ? firstObservedAt
                : now.toISOString(),
              attempt:
                Number.isSafeInteger(stored?.attempt) && stored!.attempt >= 0
                  ? stored!.attempt
                  : 0,
              lastErrorKind,
            },
          },
          code: "KNOWLEDGE_BASE_MATERIALIZED_RESULT_UNAVAILABLE",
          now,
        });
      return { state: "unavailable", turn: settledTurn, deduplicated: false };
    }
    const priorAttempt =
      Number.isSafeInteger(stored?.attempt) && stored!.attempt >= 0
        ? stored!.attempt
        : 0;
    const attempt = priorAttempt + 1;
    const delayMs =
      MATERIALIZED_RESULT_READ_BACKOFF_MS[
        Math.min(attempt - 1, MATERIALIZED_RESULT_READ_BACKOFF_MS.length - 1)
      ];
    const nextRetryMs = Math.min(now.getTime() + delayMs, deadlineAt);
    const nextRetryAt = new Date(nextRetryMs).toISOString();
    const materializedResultRead: KnowledgeBaseMaterializedResultRead = {
      firstObservedAt,
      attempt,
      nextRetryAt,
      lastErrorKind,
    };
    await tx
      .update(conversationTurns)
      .set({
        metadata: {
          ...metadata,
          providerAttemptState: "output_pending",
          dispatchState: "recovering",
          failureClass: "recoverable_same_turn",
          recoveryAction: "wait",
          canRegenerate: false,
          materializedResultRead,
        },
        leaseExpiresAt: new Date(nextRetryMs),
        updatedAt: now,
      })
      .where(
        and(
          eq(conversationTurns.id, turn.id),
          eq(conversationTurns.userId, input.userId),
          eq(conversationTurns.buildId, build.id),
          eq(conversationTurns.buildGeneration, build.generation),
          inArray(conversationTurns.status, ["queued", "running"]),
        ),
      );
    return {
      state: "deferred",
      firstObservedAt,
      attempt,
      nextRetryAt,
      retryAfterMs: nextRetryMs - now.getTime(),
      deduplicated: false,
    };
  });
}

/**
 * Settles a provider rejection which proves that no usable task was created.
 *
 * Unlike an ambiguous timeout or a 2xx response without a task id, a proven
 * provider rejection must not keep an active reservation recoverable forever.
 * The failed turn remains the authoritative recovery source, including its
 * frozen attachments and prepared request body, while the build exposes one
 * stable action-specific notice.
 */
export async function failKnowledgeBaseTurnDeterministically(
  input: {
    userId: number;
    turnId: string;
    leaseToken: string;
    code: string;
    message: string;
    failureClass?: KnowledgeBaseFailureClass;
    recoveryAction?: KnowledgeBaseRecoveryAction;
    canRegenerate?: boolean;
    createAttemptRejected?: boolean;
    reasonCategory?: string;
    providerRequestRef?: string;
    now?: Date;
  },
  executor?: any,
) {
  const db = executor ?? (await requireDb());
  const code = normalizeRequiredId(input.code, "failure code", 128);
  const message = String(input.message || "")
    .trim()
    .slice(0, 10_000);
  if (!message) {
    throw new KnowledgeBaseTurnReservationError(
      "INVALID_REQUEST",
      "Deterministic failure message is required",
    );
  }
  return db.transaction(async (tx: any) => {
    const { turn, build } = await lockedOwnedTurnAndBuild(tx, input);
    const metadata = metadataOf(turn);
    if (metadata.leaseOwnerHash !== leaseOwnerHash(input.leaseToken)) {
      throw new KnowledgeBaseTurnReservationError(
        "LEASE_LOST",
        "Knowledge-base turn lease is owned by another worker",
        1_000,
      );
    }

    // A lost HTTP response from this persistence call may cause its exact
    // handler to run twice. Do not advance stateEpoch or conversation.version
    // again; this keeps the public notice key stable and deduplicated.
    if (
      turn.status === "failed" &&
      turn.errorCode === code &&
      build.status === "protocol_error" &&
      build.protocolErrorCode === code
    ) {
      return { turn: turnRecord(turn), deduplicated: true };
    }
    assertLease(turn, input.leaseToken);
    if (build.status === "ready_to_publish" || build.status === "published") {
      throw new KnowledgeBaseTurnReservationError(
        "TERMINAL",
        "Knowledge-base build no longer accepts failures",
      );
    }

    const now = input.now ?? new Date();
    const {
      outcomeUnknownAt: _outcomeUnknownAt,
      outcomeUnknownCode: _outcomeUnknownCode,
      ...settledMetadata
    } = metadata;
    const failureClass =
      input.failureClass ??
      (turn.upstreamTaskId
        ? "terminal_requires_regeneration"
        : "requires_user_fix");
    const recoveryAction =
      input.recoveryAction ??
      (failureClass === "terminal_requires_regeneration"
        ? "regenerate_turn"
        : failureClass === "requires_user_fix"
          ? "contact_support"
          : "contact_support");
    const currentAttempt = knowledgeBaseCreateAttemptState(turn, metadata);
    if (
      input.createAttemptRejected === true &&
      currentAttempt !== "sending" &&
      currentAttempt !== "rejected"
    ) {
      throw new KnowledgeBaseTurnReservationError(
        "CONFLICT",
        "Provider rejection does not match the durable create attempt",
      );
    }
    const reasonCategory = safeProviderDiagnostic(input.reasonCategory);
    const providerRequestRef = safeProviderDiagnostic(input.providerRequestRef);
    const failedMetadata: KnowledgeBaseTurnMetadata = {
      ...settledMetadata,
      ...(input.createAttemptRejected === true
        ? {
            createAttemptState: "rejected" as const,
            createAttemptUpdatedAt: now.toISOString(),
          }
        : {}),
      ...(reasonCategory ? { providerReasonCategory: reasonCategory } : {}),
      ...(providerRequestRef ? { providerRequestRef } : {}),
      dispatchState: "failed",
      failureClass,
      recoveryAction,
      canRegenerate:
        failureClass === "terminal_requires_regeneration" &&
        input.canRegenerate !== false,
    };
    await tx
      .update(knowledgeBaseBuilds)
      .set({
        status: "protocol_error",
        stateEpoch: build.stateEpoch + 1,
        protocolErrorCode: code,
        protocolError: message,
        awaitingResponseSince: null,
        updatedAt: now,
      })
      .where(
        and(
          eq(knowledgeBaseBuilds.id, build.id),
          eq(knowledgeBaseBuilds.userId, input.userId),
          eq(knowledgeBaseBuilds.generation, build.generation),
          eq(knowledgeBaseBuilds.activeTurnId, turn.id),
        ),
      );
    await tx
      .update(conversationTurns)
      .set({
        status: "failed",
        errorCode: code,
        errorMessage: message,
        completedAt: now,
        leaseExpiresAt: null,
        metadata: failedMetadata,
        updatedAt: now,
      })
      .where(eq(conversationTurns.id, turn.id));
    await markKnowledgeBaseConversationFailedInTransaction({
      tx,
      userId: input.userId,
      conversationId: turn.conversationId,
      authoritativeTaskId: turn.upstreamTaskId || build.upstreamTaskId,
      failedAt: now,
    });
    return {
      turn: turnRecord({
        ...turn,
        status: "failed",
        errorCode: code,
        errorMessage: message,
        completedAt: now,
        leaseExpiresAt: null,
        metadata: failedMetadata,
        updatedAt: now,
      }),
      deduplicated: false,
    };
  });
}

/**
 * Terminalize one fresh materialized-v5 operation before task.create.
 *
 * This boundary is intentionally narrower than the generic deterministic
 * failure path: a provider task may not exist, task.create must still be
 * durably `not_sent`, and the current turn must own the build. The build and
 * turn are settled in one transaction so a failed turn can never remain the
 * active pointer or be projected as a stopped Provider task.
 */
export async function settleKnowledgeBasePreCreateFailureForApprovedReset(
  input: {
    userId: number;
    turnId: string;
    leaseToken: string;
    code: string;
    message: string;
    failureStage?: "local_upload" | "provider_file_registration";
    now?: Date;
  },
  executor?: any,
) {
  const db = executor ?? (await requireDb());
  const causeCode = normalizeRequiredId(input.code, "failure code", 128);
  const causeMessage = String(input.message || "")
    .trim()
    .slice(0, 10_000);
  if (!causeMessage) {
    throw new KnowledgeBaseTurnReservationError(
      "INVALID_REQUEST",
      "Pre-create failure message is required",
    );
  }
  return db.transaction(async (tx: any) => {
    const { turn, build } = await lockedOwnedTurnAndBuild(tx, input, {
      allowInactiveTurn: true,
    });
    const metadata = metadataOf(turn);
    const isExactSettlement =
      turn.status === "failed" &&
      turn.errorCode === "RESET_REQUIRED" &&
      turn.upstreamTaskId === null &&
      metadata.failureStage ===
        (input.failureStage ?? "provider_file_registration") &&
      metadata.preCreateFailureCauseCode === causeCode &&
      metadata.createAttemptState === "not_sent" &&
      metadata.providerAttemptState === "not_sent" &&
      build.status === "protocol_error" &&
      build.activeTurnId === null &&
      build.canonicalTaskState === "attention_required" &&
      build.protocolErrorCode === "RESET_REQUIRED";
    if (isExactSettlement) {
      return { turn: turnRecord(turn), deduplicated: true };
    }
    if (metadata.leaseOwnerHash !== leaseOwnerHash(input.leaseToken)) {
      throw new KnowledgeBaseTurnReservationError(
        "LEASE_LOST",
        "Knowledge-base turn lease is owned by another worker",
        1_000,
      );
    }
    assertLease(turn, input.leaseToken);
    if (
      build.activeTurnId !== turn.id ||
      build.generation !== turn.buildGeneration ||
      build.canonicalTaskId !== null ||
      build.upstreamTaskId !== null ||
      turn.upstreamTaskId !== null ||
      (turn.status !== "queued" && turn.status !== "running") ||
      knowledgeBaseCreateAttemptState(turn, metadata) !== "not_sent" ||
      metadata.providerAttemptState !== "not_sent" ||
      metadata.dispatchingAt !== undefined ||
      metadata.outcomeUnknownAt !== undefined
    ) {
      throw new KnowledgeBaseTurnReservationError(
        "CONFLICT",
        "Pre-create reset settlement lost its fresh not-sent authority",
      );
    }
    if (
      build.executionMode !== "materialized_bundle_v1" ||
      build.skillVersion !== "5" ||
      build.skillContentHash !==
        KNOWLEDGE_BASE_MATERIALIZED_V5_SKILL_CONTENT_HASH ||
      build.providerProtocol !== "manus_v2" ||
      metadata.materializedRecoveryContractVersion !== 1 ||
      metadata.materializedCompletionContractVersion !==
        KNOWLEDGE_BASE_MATERIALIZED_COMPLETION_CONTRACT_VERSION ||
      metadata.providerProtocol !== "manus_v2"
    ) {
      // Old contracts remain reset-only history and use their existing
      // terminal path. Returning null is an explicit classification, not a
      // reason to upgrade or reconstruct them in place.
      return null;
    }

    const now = input.now ?? new Date();
    const failureStage = input.failureStage ?? "provider_file_registration";
    const customerMessage =
      failureStage === "local_upload"
        ? "知识库任务未创建；本地资料校验未完成。请批准重置后重新上传资料。"
        : "知识库任务未创建；云端附件登记未完成。请批准重置后重新上传资料。";
    const nextMetadata: KnowledgeBaseTurnMetadata = {
      ...metadata,
      createAttemptState: "not_sent",
      createAttemptUpdatedAt: now.toISOString(),
      providerAttemptState: "not_sent",
      dispatchState: "failed",
      failureClass: "requires_user_fix",
      recoveryAction: "approve_reset",
      canRegenerate: false,
      failureStage,
      preCreateFailureCauseCode: causeCode,
      manusV2Lifecycle: {
        ...(metadata.manusV2Lifecycle || {}),
        attentionCode: "RESET_REQUIRED",
      },
    };
    delete nextMetadata.leaseOwnerHash;
    const buildUpdated = await tx
      .update(knowledgeBaseBuilds)
      .set({
        status: "protocol_error",
        activeTurnId: null,
        canonicalTaskState: "attention_required",
        protocolErrorCode: "RESET_REQUIRED",
        protocolError: customerMessage,
        stateEpoch: build.stateEpoch + 1,
        recoveryLeaseOwnerHash: null,
        recoveryLeaseExpiresAt: null,
        awaitingResponseSince: null,
        updatedAt: now,
      })
      .where(
        and(
          eq(knowledgeBaseBuilds.id, build.id),
          eq(knowledgeBaseBuilds.userId, input.userId),
          eq(knowledgeBaseBuilds.generation, build.generation),
          eq(knowledgeBaseBuilds.stateEpoch, build.stateEpoch),
          eq(knowledgeBaseBuilds.activeTurnId, turn.id),
          isNull(knowledgeBaseBuilds.canonicalTaskId),
          isNull(knowledgeBaseBuilds.upstreamTaskId),
        ),
      );
    if (!buildUpdated[0]?.affectedRows) {
      throw new KnowledgeBaseTurnReservationError(
        "CONFLICT",
        "Pre-create reset settlement lost the build writer fence",
      );
    }
    const turnUpdated = await tx
      .update(conversationTurns)
      .set({
        status: "failed",
        errorCode: "RESET_REQUIRED",
        errorMessage: customerMessage,
        completedAt: turn.completedAt ?? now,
        leaseExpiresAt: null,
        metadata: nextMetadata,
        updatedAt: now,
      })
      .where(
        and(
          eq(conversationTurns.id, turn.id),
          eq(conversationTurns.userId, input.userId),
          eq(conversationTurns.buildId, build.id),
          eq(conversationTurns.buildGeneration, build.generation),
          inArray(conversationTurns.status, ["queued", "running"]),
          isNull(conversationTurns.upstreamTaskId),
        ),
      );
    if (!turnUpdated[0]?.affectedRows) {
      throw new KnowledgeBaseTurnReservationError(
        "CONFLICT",
        "Pre-create reset settlement lost the turn writer fence",
      );
    }
    await markKnowledgeBaseConversationFailedInTransaction({
      tx,
      userId: input.userId,
      conversationId: turn.conversationId,
      authoritativeTaskId: null,
      failedAt: now,
    });
    return {
      turn: turnRecord({
        ...turn,
        status: "failed",
        errorCode: "RESET_REQUIRED",
        errorMessage: customerMessage,
        completedAt: turn.completedAt ?? now,
        leaseExpiresAt: null,
        metadata: nextMetadata,
        updatedAt: now,
      }),
      deduplicated: false,
    };
  });
}

/**
 * Pause an unbound Manus v2 reservation whose credential can no longer be
 * resolved before task.create. A frozen prepared request remains exact; a
 * pristine pre-prepare reservation is allowed to rebuild from its durable
 * recovery metadata after the customer binds the current active credential.
 *
 * This deliberately rejects partial attachment/preparation ledgers,
 * sendMessage, acknowledged/ambiguous attempts and bound builds: those states
 * require different reconciliation and must never be converted into a safe
 * pre-create retry.
 */
export async function pauseKnowledgeBasePreCreateCredentialUnavailable(
  input: {
    userId: number;
    turnId: string;
    leaseToken: string;
    now?: Date;
  },
  executor?: any,
): Promise<KnowledgeBaseTurnRecord | null> {
  const db = executor ?? (await requireDb());
  return db.transaction(async (tx: any) => {
    const { turn, build } = await lockedOwnedTurnAndBuild(tx, input);
    assertLease(turn, input.leaseToken);
    const metadata = metadataOf(turn);
    const frozenPreparedCreate =
      metadata.providerMethod === "task.create" &&
      metadata.attachmentsFrozen === true &&
      Boolean(metadata.preparedDispatch);
    const pristinePreprepareCreate =
      metadata.providerMethod === undefined &&
      metadata.attachmentsFrozen !== true &&
      metadata.preparedDispatch === undefined &&
      metadata.frozenProviderRequestHash === undefined &&
      turn.attachmentFileIds.length === 0 &&
      Object.keys(generatedAttachmentReservations(metadata)).length === 0 &&
      Object.keys(manusV2AttachmentMappings(metadata)).length === 0 &&
      Object.keys(manusV2AttachmentAttempts(metadata)).length === 0 &&
      Object.keys(manusV2AttachmentUnknownAttempts(metadata)).length === 0;
    if (
      (turn.status !== "queued" && turn.status !== "running") ||
      turn.upstreamTaskId !== null ||
      build.activeTurnId !== turn.id ||
      build.generation !== turn.buildGeneration ||
      build.providerProtocol !== "manus_v2" ||
      build.canonicalTaskId !== null ||
      build.upstreamTaskId !== null ||
      metadata.providerProtocol !== "manus_v2" ||
      metadata.providerAttemptState !== "not_sent" ||
      storedKnowledgeBaseCreateAttemptState(metadata) !== "not_sent" ||
      metadata.dispatchingAt !== undefined ||
      metadata.outcomeUnknownAt !== undefined ||
      metadata.awaitingClientAttachments === true ||
      !metadata.recovery ||
      (!frozenPreparedCreate && !pristinePreprepareCreate)
    ) {
      return null;
    }

    const now = input.now ?? new Date();
    const code = "UPSTREAM_CREDENTIAL_UNAVAILABLE";
    const message =
      "本轮绑定的 FrontMind API 凭证已不可用；已完成内容和本轮请求均已保留，请更新凭证后继续同一轮次";
    const nextMetadata: KnowledgeBaseTurnMetadata = {
      ...metadata,
      dispatchState: "failed",
      failureClass: "requires_user_fix",
      recoveryAction: "update_credential",
      canRegenerate: false,
    };
    await tx
      .update(knowledgeBaseBuilds)
      .set({
        status: "protocol_error",
        stateEpoch: build.stateEpoch + 1,
        protocolErrorCode: code,
        protocolError: message,
        awaitingResponseSince: null,
        updatedAt: now,
      })
      .where(
        and(
          eq(knowledgeBaseBuilds.id, build.id),
          eq(knowledgeBaseBuilds.userId, input.userId),
          eq(knowledgeBaseBuilds.generation, build.generation),
          eq(knowledgeBaseBuilds.activeTurnId, turn.id),
          isNull(knowledgeBaseBuilds.canonicalTaskId),
          isNull(knowledgeBaseBuilds.upstreamTaskId),
        ),
      );
    await tx
      .update(conversationTurns)
      .set({
        status: "failed",
        errorCode: code,
        errorMessage: message,
        completedAt: now,
        leaseExpiresAt: null,
        metadata: nextMetadata,
        updatedAt: now,
      })
      .where(eq(conversationTurns.id, turn.id));
    await markKnowledgeBaseConversationFailedInTransaction({
      tx,
      userId: input.userId,
      conversationId: turn.conversationId,
      authoritativeTaskId: null,
      failedAt: now,
    });
    return turnRecord({
      ...turn,
      status: "failed",
      errorCode: code,
      errorMessage: message,
      completedAt: now,
      leaseExpiresAt: null,
      metadata: nextMetadata,
      updatedAt: now,
    });
  });
}

export async function renewKnowledgeBaseTurnLease(
  input: {
    userId: number;
    turnId: string;
    leaseToken: string;
    now?: Date;
    leaseMs?: number;
  },
  executor?: any,
) {
  const db = executor ?? (await requireDb());
  return db.transaction(async (tx: any) => {
    const { turn } = await lockedOwnedTurnAndBuild(tx, input);
    assertLease(turn, input.leaseToken);
    const now = input.now ?? new Date();
    const leaseMs = input.leaseMs ?? DEFAULT_LEASE_MS;
    assertInteger(leaseMs, "leaseMs", 1_000);
    const leaseExpiresAt = new Date(now.getTime() + leaseMs);
    await tx
      .update(conversationTurns)
      .set({ leaseExpiresAt, updatedAt: now })
      .where(eq(conversationTurns.id, turn.id));
    return leaseExpiresAt;
  });
}

/** Cheap scan; claimKnowledgeBaseTurnForRecovery performs the locked recheck. */
export async function findRecoverableKnowledgeBaseTurnIds(
  input: {
    now?: Date;
    limit?: number;
  } = {},
  executor?: any,
): Promise<KnowledgeBaseRecoveryCandidate[]> {
  const db = executor ?? (await requireDb());
  const now = input.now ?? new Date();
  const limit = input.limit ?? 50;
  assertInteger(limit, "limit", 1);
  return db
    .select({
      turnId: conversationTurns.id,
      userId: conversationTurns.userId,
      buildId: conversationTurns.buildId,
      buildGeneration: conversationTurns.buildGeneration,
      leaseExpiresAt: conversationTurns.leaseExpiresAt,
    })
    .from(conversationTurns)
    .innerJoin(
      knowledgeBaseBuilds,
      and(
        eq(knowledgeBaseBuilds.id, conversationTurns.buildId),
        eq(knowledgeBaseBuilds.generation, conversationTurns.buildGeneration),
        eq(knowledgeBaseBuilds.activeTurnId, conversationTurns.id),
      ),
    )
    .where(
      and(
        eq(knowledgeBaseBuilds.executionMode, "materialized_bundle_v1"),
        eq(knowledgeBaseBuilds.skillVersion, "5"),
        eq(
          knowledgeBaseBuilds.skillContentHash,
          KNOWLEDGE_BASE_MATERIALIZED_V5_SKILL_CONTENT_HASH,
        ),
        eq(knowledgeBaseBuilds.providerProtocol, "manus_v2"),
        isNotNull(knowledgeBaseBuilds.contentVersion),
        inArray(knowledgeBaseBuilds.status, ["researching", "confirming"]),
        inArray(conversationTurns.status, ["queued", "running"]),
        or(
          isNull(conversationTurns.leaseExpiresAt),
          lte(conversationTurns.leaseExpiresAt, now),
        ),
        sql`JSON_EXTRACT(${conversationTurns.metadata}, '$.materializedRecoveryContractVersion') = 1`,
        sql`JSON_EXTRACT(${conversationTurns.metadata}, '$.materializedCompletionContractVersion') = ${KNOWLEDGE_BASE_MATERIALIZED_COMPLETION_CONTRACT_VERSION}`,
        sql`COALESCE(JSON_UNQUOTE(JSON_EXTRACT(${conversationTurns.metadata}, '$.providerProtocol')), '') = 'manus_v2'`,
        sql`COALESCE(JSON_UNQUOTE(JSON_EXTRACT(${conversationTurns.metadata}, '$.providerMethod')), '') IN ('', 'task.create')`,
        sql`COALESCE(JSON_UNQUOTE(JSON_EXTRACT(${conversationTurns.metadata}, '$.repairKind')), '') = ''`,
        sql`COALESCE(JSON_UNQUOTE(JSON_EXTRACT(${conversationTurns.metadata}, '$.awaitingClientAttachments')), 'false') <> 'true'`,
        sql`COALESCE(JSON_UNQUOTE(JSON_EXTRACT(${conversationTurns.metadata}, '$.manusV2Lifecycle.attentionCode')), '') = ''`,
      ),
    )

    .orderBy(asc(conversationTurns.leaseExpiresAt), asc(conversationTurns.id))
    .limit(Math.min(limit, 200));
}

async function settleLockedMaterializedCreateOutcomeUnknownForReset(input: {
  tx: any;
  turn: ConversationTurn;
  build: KnowledgeBaseBuild;
  metadata: KnowledgeBaseTurnMetadata;
  now: Date;
}) {
  const { tx, turn, build, metadata, now } = input;
  if (
    build.activeTurnId !== turn.id ||
    build.executionMode !== "materialized_bundle_v1" ||
    build.skillVersion !== "5" ||
    build.providerProtocol !== "manus_v2" ||
    turn.upstreamTaskId !== null ||
    metadata.materializedRecoveryContractVersion !== 1 ||
    metadata.providerProtocol !== "manus_v2" ||
    knowledgeBaseCreateAttemptState(turn, metadata) !== "unknown" ||
    metadata.providerAttemptState !== "outcome_unknown"
  ) {
    throw new KnowledgeBaseTurnReservationError(
      "CONFLICT",
      "Create outcome-unknown reset settlement lost its durable authority",
    );
  }
  const nextMetadata: KnowledgeBaseTurnMetadata = {
    ...metadata,
    createAttemptState: "unknown",
    providerAttemptState: "outcome_unknown",
    dispatchState: "failed",
    failureClass: "requires_user_fix",
    recoveryAction: "approve_reset",
    canRegenerate: false,
    manusV2Lifecycle: {
      ...(metadata.manusV2Lifecycle || {}),
      attentionCode: "RESET_REQUIRED",
    },
  };
  delete nextMetadata.leaseOwnerHash;
  const customerMessage = "上游任务创建结果不确定；请批准重置并重新上传资料";
  const buildUpdated = await tx
    .update(knowledgeBaseBuilds)
    .set({
      status: "protocol_error",
      activeTurnId: null,
      canonicalTaskState: "attention_required",
      protocolErrorCode: "RESET_REQUIRED",
      protocolError: customerMessage,
      stateEpoch: build.stateEpoch + 1,
      recoveryLeaseOwnerHash: null,
      recoveryLeaseExpiresAt: null,
      awaitingResponseSince: null,
      updatedAt: now,
    })
    .where(
      and(
        eq(knowledgeBaseBuilds.id, build.id),
        eq(knowledgeBaseBuilds.userId, turn.userId),
        eq(knowledgeBaseBuilds.generation, build.generation),
        eq(knowledgeBaseBuilds.stateEpoch, build.stateEpoch),
        eq(knowledgeBaseBuilds.activeTurnId, turn.id),
      ),
    );
  if (!buildUpdated[0]?.affectedRows) {
    throw new KnowledgeBaseTurnReservationError(
      "CONFLICT",
      "Create outcome-unknown reset settlement lost the build writer fence",
    );
  }
  const turnUpdated = await tx
    .update(conversationTurns)
    .set({
      status: "failed",
      errorCode: "RESET_REQUIRED",
      errorMessage: customerMessage,
      completedAt: turn.completedAt ?? now,
      leaseExpiresAt: null,
      metadata: nextMetadata,
      updatedAt: now,
    })
    .where(
      and(
        eq(conversationTurns.id, turn.id),
        eq(conversationTurns.userId, turn.userId),
        eq(conversationTurns.buildId, build.id),
        eq(conversationTurns.buildGeneration, build.generation),
        inArray(conversationTurns.status, ["queued", "running"]),
      ),
    );
  if (!turnUpdated[0]?.affectedRows) {
    throw new KnowledgeBaseTurnReservationError(
      "CONFLICT",
      "Create outcome-unknown reset settlement lost the turn writer fence",
    );
  }
  await markKnowledgeBaseConversationFailedInTransaction({
    tx,
    userId: turn.userId,
    conversationId: turn.conversationId,
    authoritativeTaskId: null,
    failedAt: now,
  });
}

/**
 * Atomically takes over one expired reservation. Multiple workers may scan;
 * only one receives a claim after the row-lock recheck.
 */
export async function claimKnowledgeBaseTurnForRecovery(
  input: {
    turnId: string;
    now?: Date;
    leaseMs?: number;
  },
  executor?: any,
): Promise<KnowledgeBaseRecoveryClaim | null> {
  const db = executor ?? (await requireDb());
  const turnId = normalizeRequiredId(input.turnId, "turnId", 36);
  const now = input.now ?? new Date();
  const leaseMs = input.leaseMs ?? DEFAULT_LEASE_MS;
  assertInteger(leaseMs, "leaseMs", 1_000);
  return db.transaction(async (tx: any) => {
    let turn: ConversationTurn;
    let build: KnowledgeBaseBuild;
    try {
      ({ turn, build } = await lockedOwnedTurnAndBuild(tx, { turnId }));
    } catch (error) {
      if (
        error instanceof KnowledgeBaseTurnReservationError &&
        (error.code === "RESERVATION_NOT_FOUND" || error.code === "CONFLICT")
      ) {
        return null;
      }
      throw error;
    }
    const currentMetadata = metadataOf(turn);
    const currentRecovery =
      currentMetadata.recovery &&
      typeof currentMetadata.recovery === "object" &&
      !Array.isArray(currentMetadata.recovery)
        ? (currentMetadata.recovery as Record<string, unknown>)
        : null;
    const retiredHistoricalRecovery = Boolean(
      currentRecovery?.localRehydrateAuthority === "local_rehydrate_unbound" ||
        currentMetadata.providerMethod === "task.sendMessage" ||
        String(currentMetadata.repairKind || "") !== "" ||
        turn.errorCode === "KNOWLEDGE_BASE_LOCAL_REHYDRATE_AUTHORITY_INVALID" ||
        turn.errorCode ===
          "KNOWLEDGE_BASE_MANUS_V2_ATTACHMENT_SOURCE_UNAVAILABLE",
    );
    if (
      build.executionMode !== "materialized_bundle_v1" ||
      build.skillVersion !== "5" ||
      build.skillContentHash !==
        KNOWLEDGE_BASE_MATERIALIZED_V5_SKILL_CONTENT_HASH ||
      build.providerProtocol !== "manus_v2" ||
      build.contentVersion === null ||
      currentMetadata.materializedRecoveryContractVersion !== 1 ||
      knowledgeBaseMaterializedRecoveryContractVersion(build) !== 1 ||
      currentMetadata.materializedCompletionContractVersion !==
        KNOWLEDGE_BASE_MATERIALIZED_COMPLETION_CONTRACT_VERSION ||
      knowledgeBaseMaterializedCompletionContractVersion(build) !==
        KNOWLEDGE_BASE_MATERIALIZED_COMPLETION_CONTRACT_VERSION ||
      retiredHistoricalRecovery
    ) {
      // Reset-only cutover: old rows are readable history, not dispatch
      // authority. Mark the build once under the existing build -> turn locks
      // so the cheap scanner excludes it on every later pass. No Provider
      // lease, upload, handoff, rehydrate, poll, or create is allowed here.
      if (
        currentMetadata.manusV2Lifecycle?.attentionCode !== "RESET_REQUIRED" ||
        turn.status !== "failed" ||
        currentMetadata.failureClass !== "requires_user_fix" ||
        currentMetadata.recoveryAction !== "approve_reset" ||
        build.status !== "protocol_error" ||
        build.canonicalTaskState !== "attention_required" ||
        build.protocolErrorCode !== "RESET_REQUIRED"
      ) {
        const nextMetadata: KnowledgeBaseTurnMetadata = {
          ...currentMetadata,
          manusV2Lifecycle: {
            ...(currentMetadata.manusV2Lifecycle || {}),
            attentionCode: "RESET_REQUIRED",
          },
          dispatchState: "failed",
          failureClass: "requires_user_fix",
          recoveryAction: "approve_reset",
          canRegenerate: false,
        };
        await tx
          .update(conversationTurns)
          .set({
            status: "failed",
            errorCode: "RESET_REQUIRED",
            errorMessage: null,
            completedAt: turn.completedAt ?? now,
            leaseExpiresAt: null,
            metadata: nextMetadata,
            updatedAt: now,
          })
          .where(eq(conversationTurns.id, turn.id));
        await tx
          .update(knowledgeBaseBuilds)
          .set({
            status: "protocol_error",
            canonicalTaskState: "attention_required",
            protocolErrorCode: "RESET_REQUIRED",
            protocolError: null,
            stateEpoch: build.stateEpoch + 1,
            updatedAt: now,
          })
          .where(eq(knowledgeBaseBuilds.id, build.id));
      }
      return null;
    }
    const createAttemptState = knowledgeBaseCreateAttemptState(
      turn,
      currentMetadata,
    );
    if (
      createAttemptState === "unknown" &&
      currentMetadata.providerProtocol === "manus_v2" &&
      currentMetadata.providerAttemptState === "outcome_unknown" &&
      turn.upstreamTaskId === null
    ) {
      // No task identity exists to read safely, and task.create may have
      // crossed the Provider boundary. The first sweep persisted that fact;
      // this next expired sweep settles reset atomically before granting a
      // lease, so dispatch can neither resend nor re-enter the create-only
      // outcome-unknown mutation.
      await settleLockedMaterializedCreateOutcomeUnknownForReset({
        tx,
        turn,
        build,
        metadata: currentMetadata,
        now,
      });
      return null;
    }
    if (
      (turn.status !== "queued" && turn.status !== "running") ||
      currentMetadata.awaitingClientAttachments === true ||
      currentMetadata.providerAttemptState === "rejected" ||
      Boolean(currentMetadata.manusV2Lifecycle?.attentionCode) ||
      (createAttemptState === "unknown" &&
        !(
          currentMetadata.providerProtocol === "manus_v2" &&
          currentMetadata.providerAttemptState === "outcome_unknown"
        )) ||
      (turn.leaseExpiresAt && turn.leaseExpiresAt.getTime() > now.getTime())
    ) {
      return null;
    }
    const leaseToken = randomUUID();
    const leaseExpiresAt = new Date(now.getTime() + leaseMs);
    let metadata: KnowledgeBaseTurnMetadata = {
      ...currentMetadata,
      leaseOwnerHash: leaseOwnerHash(leaseToken),
    };
    if (
      currentMetadata.providerProtocol === "manus_v2" &&
      currentMetadata.providerAttemptState === "outcome_unknown" &&
      turn.upstreamTaskId
    ) {
      metadata = {
        ...metadata,
        // A durable exact task id permits read-only result settlement. This
        // branch cannot manufacture an acknowledgement for an unbound create.
        createAttemptState: "acknowledged",
        providerAttemptState: "output_pending",
        dispatchState: "recovering",
      };
    }
    await tx
      .update(conversationTurns)
      .set({
        status: turn.status,
        errorCode: turn.errorCode,
        errorMessage: turn.errorMessage,
        completedAt: turn.completedAt,
        metadata,
        leaseExpiresAt,
        updatedAt: now,
      })
      .where(eq(conversationTurns.id, turn.id));
    return {
      turn: turnRecord({
        ...turn,
        status: turn.status,
        errorCode: turn.errorCode,
        errorMessage: turn.errorMessage,
        completedAt: turn.completedAt,
        metadata,
        leaseExpiresAt,
        updatedAt: now,
      }),
      leaseToken,
      leaseExpiresAt,
      upstreamIdempotencyKey: createKnowledgeBaseUpstreamIdempotencyKey(
        String(turn.operationKey),
      ),
      recoveryMetadata: sanitizeKnowledgeBaseRecoveryMetadata(
        metadata.recovery,
      ),
      preparedDispatch: metadata.preparedDispatch ?? null,
    };
  });
}
