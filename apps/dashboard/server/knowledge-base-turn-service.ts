import { createHash, randomUUID } from "node:crypto";

import { and, asc, desc, eq, inArray, isNull, lte, or, sql } from "drizzle-orm";

import {
  apiCredentials,
  conversations,
  conversationTurns,
  knowledgeBaseBuilds,
  knowledgeBaseConversationRetentionTombstones,
  knowledgeBaseConversationTombstones,
  upstreamResources,
  userUsageOwners,
  type ConversationTurn,
  type KnowledgeBaseBuild,
} from "../drizzle/schema";
import type {
  KnowledgeBaseOperationType,
  KnowledgeBaseTurnStatus,
} from "../shared/knowledge-base-progress";
import { knowledgeBaseOperationTypes } from "../shared/knowledge-base-progress";
import { AuthServiceError } from "./auth-service";
import {
  markKnowledgeBaseConversationAwaitingInputInTransaction,
  markKnowledgeBaseConversationFailedInTransaction,
  persistKnowledgeBaseUserMessageInTransaction,
} from "./knowledge-base-conversation-messages";
import { getDb } from "./db";

/** Longer than every configured 120s upstream create/upload timeout. */
const DEFAULT_LEASE_MS = 300_000;
const MAX_ATTACHMENT_COUNT = 100;
const MAX_ATTACHMENT_ID_LENGTH = 512;
const MAX_RECOVERY_METADATA_DEPTH = 20;
const SECRET_KEY_PATTERN =
  /(?:^|[_-])(api[_-]?key|authorization|credential|password|secret|token)(?:$|[_-])/i;

type KnowledgeBaseTurnMetadata = Record<string, unknown> & {
  leaseOwnerHash?: string;
  attachmentsFrozen?: boolean;
  expectedAttachmentCount?: number;
  userAttachmentCount?: number;
  awaitingClientAttachments?: boolean;
  /** Safe tombstone for a browser upload rejected before any upstream POST. */
  unpreparedCancellation?: boolean;
  cancelledOperationKey?: string;
  /** The former browser reservation was atomically adopted by upload-first. */
  legacyUploadFirstTakeover?: boolean;
  clientAttachmentManifestHash?: string;
  clientStagedAttachments?: Array<{
    index: number;
    file_id: string;
    filename: string;
  }>;
  recovery?: Record<string, unknown>;
  dispatchingAt?: string;
  outcomeUnknownAt?: string;
  outcomeUnknownCode?: string;
  preparedDispatch?: KnowledgeBasePreparedDispatch;
  generatedAttachmentReservations?: Record<
    string,
    KnowledgeBaseGeneratedAttachmentReservation
  >;
};

export type KnowledgeBaseGeneratedAttachmentRole = "skill" | "prefill";

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
  status: "reserved" | "completed";
  upstreamFileId?: string;
  reservedAt: string;
  completedAt?: string;
}

export interface KnowledgeBaseGeneratedAttachmentClaim {
  state: "reserved" | "completed";
  idempotencyKey: string;
  requestHash: string;
  upstreamFileId: string | null;
}

export interface KnowledgeBasePreparedDispatch {
  schemaVersion: 1;
  baseUrl: string;
  requestBody: {
    prompt: string;
    agentProfile: string;
    taskMode: "agent";
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
  | "CONFLICT"
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
  attachmentFileIds: string[];
  attachmentsFrozen: boolean;
  awaitingClientAttachments: boolean;
  expectedUserAttachmentCount: number;
  stagedUserAttachmentCount: number;
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
   * The exact logical request, excluding credentials. It is hashed and never
   * persisted verbatim. Array order is significant.
   */
  requestPayload: unknown;
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
  now?: Date;
  leaseMs?: number;
}

export interface KnowledgeBaseStartBuildReservation {
  build: KnowledgeBaseBuild;
  createdBuild: boolean;
  reservation: KnowledgeBaseTurnReservation;
}

export interface ReserveKnowledgeBaseRetryTurnInput {
  userId: number;
  conversationId: string;
  clientRequestId: string;
  expectedGeneration: number;
  expectedRevision: number;
  expectedLeafId: string | null;
  now?: Date;
  leaseMs?: number;
}

export interface KnowledgeBaseRetryReservation {
  reservation: KnowledgeBaseTurnReservation;
  recoveryMetadata: Record<string, unknown>;
  preparedDispatch: KnowledgeBasePreparedDispatch | null;
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
}) {
  if (input.role !== "skill" && input.role !== "prefill") {
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
  const requestHash = hashKnowledgeBaseTurnRequest({
    protocol: "frontmind.knowledge-base.generated-attachment-request.v1",
    role: input.role,
    attachmentIndex: input.attachmentIndex,
    filename,
    mimeType,
    sizeBytes: input.sizeBytes,
    contentSha256: input.contentSha256,
  });
  return { ...input, filename, mimeType, requestHash };
}

function generatedAttachmentReservations(
  metadata: KnowledgeBaseTurnMetadata,
): Record<string, KnowledgeBaseGeneratedAttachmentReservation> {
  const value = metadata.generatedAttachmentReservations;
  return value && typeof value === "object" && !Array.isArray(value)
    ? { ...value }
    : {};
}

function retryAuthorityRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
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
      if (!Array.isArray(recovery.attachmentManifest)) return null;
      return {
        userMessage: recovery.userMessage,
        attachmentManifest: recovery.attachmentManifest,
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

/**
 * Performs the complete, credential-free integrity check shared by retry and
 * the production invariant audit. A failed row is retry authority only when
 * its logical request, operation slot, frozen upload ledger and exact POST
 * body can all be recomputed from durable state.
 */
export function inspectKnowledgeBaseRetryAuthority(
  source: ConversationTurn,
  build: KnowledgeBaseBuild,
): KnowledgeBaseRetryAuthority | null {
  try {
    const metadata = metadataOf(source);
    const recovery = retryAuthorityRecord(metadata.recovery);
    const preparedDispatch = metadata.preparedDispatch;
    const operationType = source.operationType as KnowledgeBaseOperationType;
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
      metadata.attachmentsFrozen !== true ||
      !Array.isArray(source.attachmentFileIds) ||
      !recovery ||
      recovery.conversationId !== build.conversationId ||
      !preparedDispatch ||
      preparedDispatch.schemaVersion !== 1
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
    if (
      recovery.skillVersion !== build.skillVersion ||
      (recovery.skillContentHash ?? null) !== (build.skillContentHash ?? null)
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

    const expectedAttachmentCount = Number(metadata.expectedAttachmentCount);
    const userAttachmentCount = Number(metadata.userAttachmentCount);
    if (
      !Number.isSafeInteger(expectedAttachmentCount) ||
      expectedAttachmentCount < 0 ||
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
      requestBody.taskMode !== "agent" ||
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
          requestBody.taskId !== expectedParentTaskId))
    ) {
      return null;
    }

    const retryOfTurnId =
      operationType === "retry" ? String(recovery.retryOfTurnId || "") : null;
    const expectedOperationKey = createKnowledgeBaseOperationKey({
      buildId: source.buildId,
      buildGeneration: source.buildGeneration,
      operationType,
      expectedRevision: source.expectedRevision,
      expectedLeafId: source.expectedLeafId,
      ...(operationType === "retry" ? { retryOfTurnId } : {}),
    });
    if (
      source.operationKey !== expectedOperationKey ||
      source.upstreamIdempotencyKeyHash !==
        hashKnowledgeBaseUpstreamIdempotencyKey(
          createKnowledgeBaseUpstreamIdempotencyKey(expectedOperationKey),
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
    row.metadata && typeof row.metadata === "object" ? row.metadata : {}
  ) as KnowledgeBaseTurnMetadata;
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
    attachmentFileIds: [...(row.attachmentFileIds ?? [])],
    attachmentsFrozen: metadata.attachmentsFrozen === true,
    awaitingClientAttachments: metadata.awaitingClientAttachments === true,
    expectedUserAttachmentCount: Number(metadata.userAttachmentCount ?? 0),
    stagedUserAttachmentCount: Array.isArray(metadata.clientStagedAttachments)
      ? metadata.clientStagedAttachments.length
      : 0,
    leaseExpiresAt: row.leaseExpiresAt,
    startedAt: row.startedAt,
    completedAt: row.completedAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
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
 * the customer or to the customer's current usage owner. Locking the owner
 * slot makes a request that resolved owner A before a concurrent A -> B
 * reassignment fail closed instead of creating a new A-bound reservation
 * after the reassignment commits.
 *
 * Historical retry/recovery does not use this check: its authority is the
 * already-persisted active turn and is verified by the KB-only resolver in
 * auth-service.
 */
async function lockCurrentKnowledgeBaseCredentialAuthority(
  tx: any,
  userId: number,
  credential: { id: string; userId: number; status: string } | null | undefined,
) {
  if (!credential || credential.status !== "active") return false;
  if (credential.userId === userId) return true;
  const owner = (
    await tx
      .select({ deliveryAdminId: userUsageOwners.deliveryAdminId })
      .from(userUsageOwners)
      .where(eq(userUsageOwners.userId, userId))
      .limit(1)
      .for("update")
  )[0];
  return owner?.deliveryAdminId === credential.userId;
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
    (userAttachmentCount < 1 || input.clientAttachmentManifest === undefined)
  ) {
    throw new KnowledgeBaseTurnReservationError(
      "INVALID_REQUEST",
      "Deferred dispatch requires a non-empty customer attachment manifest",
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
    metadataOf(byClient).unpreparedCancellation === true &&
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
        "CONFLICT",
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
    await tx
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
    recovery: sanitizeKnowledgeBaseRecoveryMetadata(input.recoveryMetadata),
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
) {
  return {
    ...payload,
    companyName: build.companyName,
    companyWebsite: build.companyWebsite || "",
    skillVersion: build.skillVersion,
    skillContentHash: build.skillContentHash,
  };
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
  const conversationId = normalizeRequiredId(
    input.conversationId,
    "conversationId",
    191,
  );
  const companyName = normalizeRequiredId(
    input.companyName,
    "companyName",
    255,
  );
  const skillName = normalizeRequiredId(input.skillName, "skillName", 128);
  const skillVersion = normalizeRequiredId(
    input.skillVersion,
    "skillVersion",
    64,
  );
  const skillContentHash = input.skillContentHash
    ? normalizeRequiredId(input.skillContentHash, "skillContentHash", 64)
    : null;
  const companyWebsite = String(input.companyWebsite || "").trim() || null;
  const now = input.now ?? new Date();
  const db = executor ?? (await requireDb());

  return db.transaction(async (tx: any) => {
    // Global mutation lock order is credential -> current owner slot -> active
    // reset tombstone -> retained reset tombstone -> build -> turn. Do this
    // before the build insert so an old browser tab can never resurrect a
    // conversation after an approved reset.
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
        companyName,
        companyWebsite,
        skillName,
        skillVersion,
        skillContentHash,
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

    const requestPayload = pinnedStartPayload(build, input.requestPayload);
    const recoveryMetadata = pinnedStartPayload(build, input.recoveryMetadata);
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
        now,
        leaseMs: input.leaseMs,
      },
      tx,
    );
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

function retrySourceTurnId(turn: ConversationTurn) {
  const recovery = metadataOf(turn).recovery;
  const value = recovery?.retryOfTurnId;
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

async function loadTurnByIdForUpdate(tx: any, turnId: string) {
  return (
    await tx
      .select()
      .from(conversationTurns)
      .where(eq(conversationTurns.id, turnId))
      .limit(1)
      .for("update")
  )[0] as ConversationTurn | undefined;
}

async function loadTurnById(tx: any, turnId: string) {
  return (
    await tx
      .select()
      .from(conversationTurns)
      .where(eq(conversationTurns.id, turnId))
      .limit(1)
  )[0] as ConversationTurn | undefined;
}

function assertRetrySource(
  source: ConversationTurn,
  build: KnowledgeBaseBuild,
) {
  const authority = inspectKnowledgeBaseRetryAuthority(source, build);
  if (!authority) {
    throw new KnowledgeBaseTurnReservationError(
      "CONFLICT",
      "The failed active turn is not a complete, safely retryable reservation",
    );
  }
  return authority;
}

/**
 * Atomically replaces one failed active turn with a new retry operation. The
 * previous task id is intentionally never copied; only frozen file ids,
 * original intent and the original successful parent task are inherited.
 */
export async function reserveKnowledgeBaseRetryTurn(
  input: ReserveKnowledgeBaseRetryTurnInput,
  executor?: any,
): Promise<KnowledgeBaseRetryReservation> {
  assertInteger(input.userId, "userId", 1);
  assertInteger(input.expectedGeneration, "expectedGeneration", 1);
  assertInteger(input.expectedRevision, "expectedRevision", 0);
  const conversationId = normalizeRequiredId(
    input.conversationId,
    "conversationId",
    191,
  );
  const clientRequestId = normalizeRequiredId(
    input.clientRequestId,
    "clientRequestId",
    128,
  );
  const expectedLeafId = normalizeOptionalLeafId(input.expectedLeafId);
  const db = executor ?? (await requireDb());
  return db.transaction(async (tx: any) => {
    // Discover the candidate historical credential without taking row locks,
    // then acquire the global credential -> build -> turn order. Every
    // coordinate is re-read and revalidated under the later locks, so this
    // optimistic discovery cannot grant authority by itself.
    const preliminaryBuild = (
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
    )[0] as KnowledgeBaseBuild | undefined;
    const preliminaryActive = preliminaryBuild?.activeTurnId
      ? await loadTurnById(tx, preliminaryBuild.activeTurnId)
      : undefined;
    let preliminarySource = preliminaryActive;
    if (
      preliminaryBuild &&
      preliminaryActive &&
      preliminaryBuild.status !== "protocol_error" &&
      preliminaryActive.operationType === "retry"
    ) {
      const sourceId = retrySourceTurnId(preliminaryActive);
      preliminarySource = sourceId
        ? (await loadTurnById(tx, sourceId)) || preliminaryActive
        : preliminaryActive;
    }
    if (!preliminarySource?.apiCredentialId) {
      throw new KnowledgeBaseTurnReservationError(
        "CONFLICT",
        "Knowledge-base retry has no pinned historical credential",
      );
    }
    const pinnedCredential = await lockKnowledgeBaseReservationCredential(
      tx,
      preliminarySource.apiCredentialId,
    );
    assertKnowledgeBaseReservationCredentialAvailable(
      preliminarySource.apiCredentialId,
      pinnedCredential,
      { allowRetired: true },
    );
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
        "Knowledge-base build was not found",
      );
    }
    if (
      build.generation !== input.expectedGeneration ||
      build.revision !== input.expectedRevision ||
      (build.currentLeafId ?? null) !== expectedLeafId
    ) {
      throw new KnowledgeBaseTurnReservationError(
        "CONFLICT",
        "Knowledge-base retry coordinates are stale",
      );
    }
    if (!build.activeTurnId) {
      throw new KnowledgeBaseTurnReservationError(
        "CONFLICT",
        "Knowledge-base build has no failed active turn",
      );
    }
    const active = await loadTurnByIdForUpdate(tx, build.activeTurnId);
    if (!active) {
      throw new KnowledgeBaseTurnReservationError(
        "CONFLICT",
        "Knowledge-base active turn was not found",
      );
    }

    let source = active;
    if (build.status !== "protocol_error") {
      if (
        active.operationType !== "retry" ||
        (active.status !== "queued" && active.status !== "running")
      ) {
        throw new KnowledgeBaseTurnReservationError(
          "CONFLICT",
          "Knowledge-base build has no retryable protocol error",
        );
      }
      const sourceId = retrySourceTurnId(active);
      source = sourceId
        ? (await loadTurnByIdForUpdate(tx, sourceId)) || active
        : active;
    }
    const sourceState = assertRetrySource(source, build);
    if (source.apiCredentialId !== preliminarySource.apiCredentialId) {
      throw new KnowledgeBaseTurnReservationError(
        "CONFLICT",
        "Knowledge-base retry authority changed while acquiring its credential lock",
      );
    }
    const recoveryMetadata = {
      ...sourceState.recovery,
      retryOfTurnId: source.id,
      originalOperationKey: source.operationKey,
      originalRequestHash: source.requestHash,
      retryBaseUrl: sourceState.preparedDispatch.baseUrl,
      retryAgentProfile: sourceState.preparedDispatch.requestBody.agentProfile,
      retryAttachments: sourceState.preparedDispatch.requestBody.attachments,
      retryParentTaskId:
        sourceState.preparedDispatch.requestBody.taskId || null,
    };
    const reservation = await reserveKnowledgeBaseTurnInTransaction(
      {
        userId: input.userId,
        buildId: build.id,
        clientRequestId,
        operationType: "retry",
        expectedGeneration: build.generation,
        expectedRevision: build.revision,
        expectedLeafId: build.currentLeafId,
        requestPayload: {
          retryOfTurnId: source.id,
          originalRequestHash: source.requestHash,
        },
        apiCredentialId: source.apiCredentialId,
        userText:
          sourceState.recovery.kind === "turn"
            ? String(sourceState.recovery.userMessage || "")
            : "开始构建企业知识库",
        expectedAttachmentCount: source.attachmentFileIds.length,
        userAttachmentCount: Array.isArray(sourceState.recovery.attachments)
          ? sourceState.recovery.attachments.length
          : 0,
        attachmentFileIds: source.attachmentFileIds,
        recoveryMetadata,
        replacesTurnId: source.id,
        now: input.now,
        leaseMs: input.leaseMs,
      },
      tx,
    );
    const reservedRow = await loadTurnByIdForUpdate(tx, reservation.turn.id);
    const reservedMetadata = reservedRow ? metadataOf(reservedRow) : {};
    return {
      reservation,
      recoveryMetadata: sanitizeKnowledgeBaseRecoveryMetadata(
        reservedMetadata.recovery || recoveryMetadata,
      ),
      preparedDispatch: reservedMetadata.preparedDispatch || null,
    };
  });
}

async function lockedOwnedTurn(
  tx: any,
  input: { userId: number; turnId: string },
) {
  const rows = await tx
    .select()
    .from(conversationTurns)
    .where(
      and(
        eq(
          conversationTurns.id,
          normalizeRequiredId(input.turnId, "turnId", 36),
        ),
        eq(conversationTurns.userId, input.userId),
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
  return turn;
}

function normalizeDeferredUserAttachments(
  values: ReadonlyArray<{ file_id: string; filename: string }>,
) {
  if (values.length > MAX_ATTACHMENT_COUNT) {
    throw new KnowledgeBaseTurnReservationError(
      "INVALID_REQUEST",
      `Too many customer attachments (maximum ${MAX_ATTACHMENT_COUNT})`,
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
  index: number;
  attachment: { file_id: string; filename: string };
  now?: Date;
};

type ClaimKnowledgeBaseDeferredTurnDispatchInput = {
  userId: number;
  buildId: string;
  turnId: string;
  clientRequestId: string;
  clientAttachmentManifest: unknown;
  now?: Date;
  leaseMs?: number;
};

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
  const turn = await lockedOwnedTurn(tx, input);
  await assertActiveBuild(tx, turn);
  if (turn.buildId !== normalizeRequiredId(input.buildId, "buildId", 36)) {
    throw new KnowledgeBaseTurnReservationError(
      "CONFLICT",
      "The attachment reservation belongs to another knowledge-base build",
    );
  }
  const metadata = metadataOf(turn);
  if (
    turn.clientRequestId !== clientRequestId ||
    metadata.clientAttachmentManifestHash !== manifestHash
  ) {
    throw new KnowledgeBaseTurnReservationError(
      "CONFLICT",
      "The uploaded file does not match its logical turn reservation",
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
  const staged = Array.isArray(metadata.clientStagedAttachments)
    ? [...metadata.clientStagedAttachments]
    : [];
  const prior = staged[input.index];
  if (prior) {
    if (
      prior.index !== input.index ||
      prior.file_id !== attachment.file_id ||
      prior.filename !== attachment.filename
    ) {
      throw new KnowledgeBaseTurnReservationError(
        "CONFLICT",
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
  staged.push({ index: input.index, ...attachment });
  const recovery = sanitizeKnowledgeBaseRecoveryMetadata({
    ...(metadata.recovery || {}),
    attachments: staged.map(({ file_id, filename }) => ({
      file_id,
      filename,
    })),
    attachmentManifest: input.clientAttachmentManifest,
  });
  const now = input.now ?? new Date();
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
  const turn = await lockedOwnedTurn(tx, input);
  await assertActiveBuild(tx, turn);
  if (turn.buildId !== normalizeRequiredId(input.buildId, "buildId", 36)) {
    throw new KnowledgeBaseTurnReservationError(
      "CONFLICT",
      "The attachment dispatch belongs to another knowledge-base build",
    );
  }
  const metadata = metadataOf(turn);
  if (
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
    userAttachmentCount < 1 ||
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

  const recovery = sanitizeKnowledgeBaseRecoveryMetadata({
    ...(metadata.recovery || {}),
    attachments,
    attachmentManifest: input.clientAttachmentManifest,
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

async function assertActiveBuild(tx: any, turn: ConversationTurn) {
  if (!turn.buildId || turn.buildGeneration === null) {
    throw new KnowledgeBaseTurnReservationError(
      "CONFLICT",
      "Knowledge-base turn is not bound to a build generation",
    );
  }
  const rows = await tx
    .select()
    .from(knowledgeBaseBuilds)
    .where(eq(knowledgeBaseBuilds.id, turn.buildId))
    .limit(1)
    .for("update");
  const build = rows[0] as KnowledgeBaseBuild | undefined;
  if (
    !build ||
    build.userId !== turn.userId ||
    build.generation !== turn.buildGeneration ||
    build.activeTurnId !== turn.id
  ) {
    throw new KnowledgeBaseTurnReservationError(
      "CONFLICT",
      "Knowledge-base turn is no longer authoritative",
    );
  }
  return build;
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
    now?: Date;
  },
  executor?: any,
): Promise<KnowledgeBaseGeneratedAttachmentClaim> {
  const normalized = normalizeGeneratedAttachmentInput(input);
  const db = executor ?? (await requireDb());
  return db.transaction(async (tx: any) => {
    const turn = await lockedOwnedTurn(tx, input);
    assertLease(turn, input.leaseToken);
    await assertActiveBuild(tx, turn);
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
    const idempotencyKey = createKnowledgeBaseGeneratedAttachmentIdempotencyKey(
      {
        operationKey: String(turn.operationKey || ""),
        role: normalized.role,
        attachmentIndex: normalized.attachmentIndex,
        requestHash: normalized.requestHash,
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
        (existing.status === "completed" && !existing.upstreamFileId)
      ) {
        throw new KnowledgeBaseTurnReservationError(
          "CONFLICT",
          "Generated attachment reservation does not match its frozen request",
        );
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
 * Bind the provider file id, ordered attachment ledger and cleanup ownership in
 * one transaction before uploading bytes. A crash after this commit is safely
 * recoverable by looking up a fresh signed upload URL for the same file id.
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
  if (input.role !== "skill" && input.role !== "prefill") {
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
    const turn = await lockedOwnedTurn(tx, input);
    assertLease(turn, input.leaseToken);
    await assertActiveBuild(tx, turn);
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
    const nextIds = [...(turn.attachmentFileIds ?? [])];
    if (nextIds.length < input.attachmentIndex) {
      throw new KnowledgeBaseTurnReservationError(
        "CONFLICT",
        "Generated attachment completion would create an upload-ledger gap",
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
      nextIds.length > expectedCount ||
      (metadata.attachmentsFrozen === true &&
        (turn.attachmentFileIds ?? []).join("\0") !== nextIds.join("\0"))
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
      status: "completed",
      upstreamFileId,
      completedAt: reservation.completedAt || now.toISOString(),
    };
    const nextMetadata: KnowledgeBaseTurnMetadata = {
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
          reservation.status !== "completed" ||
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
    const turn = await lockedOwnedTurn(tx, input);
    assertLease(turn, input.leaseToken);
    await assertActiveBuild(tx, turn);
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
    const turn = await lockedOwnedTurn(tx, input);
    assertLease(turn, input.leaseToken);
    await assertActiveBuild(tx, turn);
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
    const turn = await lockedOwnedTurn(tx, input);
    assertLease(turn, input.leaseToken);
    await assertActiveBuild(tx, turn);
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
      taskMode: "agent",
      attachments,
      ...(parentTaskId ? { taskId: parentTaskId } : {}),
    };
    const bodySha256 = hashKnowledgeBaseTurnRequest(requestBody);
    if (metadata.preparedDispatch) {
      if (
        metadata.preparedDispatch.bodySha256 !== bodySha256 ||
        metadata.preparedDispatch.baseUrl !== normalizedBaseUrl
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
      schemaVersion: 1,
      baseUrl: normalizedBaseUrl,
      requestBody,
      bodySha256,
      preparedAt: now.toISOString(),
    };
    const nextMetadata: KnowledgeBaseTurnMetadata = {
      ...metadata,
      preparedDispatch,
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

/** Mark the reservation running immediately before the idempotent HTTP POST. */
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
    const turn = await lockedOwnedTurn(tx, input);
    assertLease(turn, input.leaseToken);
    await assertActiveBuild(tx, turn);
    const metadata = metadataOf(turn);
    if (metadata.attachmentsFrozen !== true) {
      throw new KnowledgeBaseTurnReservationError(
        "CONFLICT",
        "Attachments must be frozen before task dispatch",
      );
    }
    const now = input.now ?? new Date();
    const leaseMs = input.leaseMs ?? DEFAULT_LEASE_MS;
    assertInteger(leaseMs, "leaseMs", 1_000);
    const leaseExpiresAt = new Date(now.getTime() + leaseMs);
    const nextMetadata: KnowledgeBaseTurnMetadata = {
      ...metadata,
      dispatchingAt: now.toISOString(),
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

/** Bind the provider task without accepting any client-supplied build task id. */
export async function bindKnowledgeBaseTurnUpstreamTask(
  input: {
    userId: number;
    turnId: string;
    leaseToken: string;
    upstreamTaskId: string;
    now?: Date;
  },
  executor?: any,
) {
  const db = executor ?? (await requireDb());
  const upstreamTaskId = normalizeRequiredId(
    input.upstreamTaskId,
    "upstreamTaskId",
    255,
  );
  return db.transaction(async (tx: any) => {
    const turn = await lockedOwnedTurn(tx, input);
    assertLease(turn, input.leaseToken);
    const build = await assertActiveBuild(tx, turn);
    if (metadataOf(turn).attachmentsFrozen !== true) {
      throw new KnowledgeBaseTurnReservationError(
        "CONFLICT",
        "Attachments must be frozen before binding an upstream task",
      );
    }
    if (turn.upstreamTaskId && turn.upstreamTaskId !== upstreamTaskId) {
      throw new KnowledgeBaseTurnReservationError(
        "CONFLICT",
        "Turn is already bound to a different upstream task",
      );
    }
    const now = input.now ?? new Date();
    await tx
      .update(conversationTurns)
      .set({
        status: "running",
        upstreamTaskId,
        startedAt: turn.startedAt ?? now,
        errorCode: null,
        errorMessage: null,
        updatedAt: now,
      })
      .where(eq(conversationTurns.id, turn.id));
    if (build.upstreamTaskId !== upstreamTaskId) {
      await tx
        .update(knowledgeBaseBuilds)
        .set({
          upstreamTaskId,
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
    }
    return turnRecord({
      ...turn,
      status: "running",
      upstreamTaskId,
      startedAt: turn.startedAt ?? now,
      errorCode: null,
      errorMessage: null,
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
    now?: Date;
    recoveryDelayMs?: number;
  },
  executor?: any,
) {
  const db = executor ?? (await requireDb());
  return db.transaction(async (tx: any) => {
    const turn = await lockedOwnedTurn(tx, input);
    assertLease(turn, input.leaseToken);
    await assertActiveBuild(tx, turn);
    const now = input.now ?? new Date();
    const recoveryDelayMs = input.recoveryDelayMs ?? 30_000;
    assertInteger(recoveryDelayMs, "recoveryDelayMs", 1_000);
    const leaseExpiresAt = new Date(now.getTime() + recoveryDelayMs);
    const metadata: KnowledgeBaseTurnMetadata = {
      ...metadataOf(turn),
      outcomeUnknownAt: now.toISOString(),
      outcomeUnknownCode: String(
        input.code || "UPSTREAM_OUTCOME_UNKNOWN",
      ).slice(0, 128),
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
  const db = executor ?? (await requireDb());
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
    const turn = await lockedOwnedTurn(tx, input);
    const metadata = metadataOf(turn);
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
    const build = await assertActiveBuild(tx, turn);
    if (
      (input.clientRequestId &&
        turn.clientRequestId !== input.clientRequestId) ||
      (input.leaseToken &&
        metadata.leaseOwnerHash !== leaseOwnerHash(input.leaseToken)) ||
      (!input.leaseToken && metadata.awaitingClientAttachments !== true) ||
      (turn.status !== "queued" && turn.status !== "running") ||
      turn.upstreamTaskId ||
      metadata.preparedDispatch ||
      build.status !== "confirming"
    ) {
      throw new KnowledgeBaseTurnReservationError(
        "CONFLICT",
        "Only an unprepared active upload turn can be cancelled",
      );
    }
    const now = input.now ?? new Date();
    const {
      leaseOwnerHash: _leaseOwnerHash,
      outcomeUnknownAt: _outcomeUnknownAt,
      outcomeUnknownCode: _outcomeUnknownCode,
      ...metadataWithoutLease
    } = metadata;
    const cancelledOperationKey = String(turn.operationKey);
    const tombstoneOperationKey = createHash("sha256")
      .update(
        `frontmind-kb-unprepared-cancellation:${turn.id}:${cancelledOperationKey}`,
        "utf8",
      )
      .digest("hex");
    const nextMetadata: KnowledgeBaseTurnMetadata = {
      ...metadataWithoutLease,
      awaitingClientAttachments: false,
      unpreparedCancellation: true,
      cancelledOperationKey,
    };
    await tx
      .update(knowledgeBaseBuilds)
      .set({
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
      authoritativeTaskId: build.upstreamTaskId,
      updatedAt: now,
    });
    return turnRecord({
      ...turn,
      operationKey: tombstoneOperationKey,
      upstreamIdempotencyKeyHash: hashKnowledgeBaseUpstreamIdempotencyKey(
        createKnowledgeBaseUpstreamIdempotencyKey(tombstoneOperationKey),
      ),
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
 * Settles a provider rejection which proves that no usable task was created.
 *
 * Unlike an ambiguous timeout, a deterministic HTTP rejection (or a 2xx
 * response without a task id) must not keep an active reservation recoverable
 * forever. The failed turn remains the authoritative retry source, including
 * its frozen attachments and prepared request body, while the build exposes
 * one stable retryable notice.
 */
export async function failKnowledgeBaseTurnDeterministically(
  input: {
    userId: number;
    turnId: string;
    leaseToken: string;
    code: string;
    message: string;
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
    const turn = await lockedOwnedTurn(tx, input);
    const metadata = metadataOf(turn);
    if (metadata.leaseOwnerHash !== leaseOwnerHash(input.leaseToken)) {
      throw new KnowledgeBaseTurnReservationError(
        "LEASE_LOST",
        "Knowledge-base turn lease is owned by another worker",
        1_000,
      );
    }
    const build = await assertActiveBuild(tx, turn);

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
        metadata: settledMetadata,
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
        metadata: settledMetadata,
        updatedAt: now,
      }),
      deduplicated: false,
    };
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
    const turn = await lockedOwnedTurn(tx, input);
    assertLease(turn, input.leaseToken);
    await assertActiveBuild(tx, turn);
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
  input: { now?: Date; limit?: number } = {},
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
        inArray(conversationTurns.status, ["queued", "running"]),
        or(
          isNull(conversationTurns.leaseExpiresAt),
          lte(conversationTurns.leaseExpiresAt, now),
        ),
        sql`COALESCE(JSON_UNQUOTE(JSON_EXTRACT(${conversationTurns.metadata}, '$.awaitingClientAttachments')), 'false') <> 'true'`,
        inArray(knowledgeBaseBuilds.status, [
          "researching",
          "confirming",
          "protocol_error",
        ]),
      ),
    )
    .orderBy(asc(conversationTurns.leaseExpiresAt), asc(conversationTurns.id))
    .limit(Math.min(limit, 200)) as Promise<KnowledgeBaseRecoveryCandidate[]>;
}

/**
 * Atomically takes over one expired reservation. Multiple workers may scan;
 * only one receives a claim after the row-lock recheck.
 */
export async function claimKnowledgeBaseTurnForRecovery(
  input: { turnId: string; now?: Date; leaseMs?: number },
  executor?: any,
): Promise<KnowledgeBaseRecoveryClaim | null> {
  const db = executor ?? (await requireDb());
  const turnId = normalizeRequiredId(input.turnId, "turnId", 36);
  const now = input.now ?? new Date();
  const leaseMs = input.leaseMs ?? DEFAULT_LEASE_MS;
  assertInteger(leaseMs, "leaseMs", 1_000);
  return db.transaction(async (tx: any) => {
    const rows = await tx
      .select()
      .from(conversationTurns)
      .where(eq(conversationTurns.id, turnId))
      .limit(1)
      .for("update");
    const turn = rows[0] as ConversationTurn | undefined;
    if (
      !turn ||
      (turn.status !== "queued" && turn.status !== "running") ||
      metadataOf(turn).awaitingClientAttachments === true ||
      (turn.leaseExpiresAt && turn.leaseExpiresAt.getTime() > now.getTime())
    ) {
      return null;
    }
    await assertActiveBuild(tx, turn);
    const leaseToken = randomUUID();
    const leaseExpiresAt = new Date(now.getTime() + leaseMs);
    const metadata: KnowledgeBaseTurnMetadata = {
      ...metadataOf(turn),
      leaseOwnerHash: leaseOwnerHash(leaseToken),
    };
    await tx
      .update(conversationTurns)
      .set({ metadata, leaseExpiresAt, updatedAt: now })
      .where(eq(conversationTurns.id, turn.id));
    return {
      turn: turnRecord({
        ...turn,
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
