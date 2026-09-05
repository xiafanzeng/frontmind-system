import { createHash, randomUUID } from "node:crypto";
import { Readable } from "node:stream";

import { and, desc, eq, inArray, type SQL } from "drizzle-orm";
import { z } from "zod";

import {
  agentEvents,
  agentOperations,
  agentTasks,
  artifacts,
  localAssets,
  userDashboardContents,
  users,
} from "../drizzle/schema";
import {
  brandQuestionUniverseStartInputSchema,
  BrandQuestionUniverseValidationError,
  type BrandQuestionUniversePayload,
} from "../shared/brand-question-universe";
import { dashboardPayloadSchema } from "../shared/dashboard";
import {
  getApiCredentialStatus,
  getDecryptedCredentialForAccountById,
  getDecryptedCredentialForUser,
  recordUpstreamResource,
  type AuthenticatedUser,
  type DecryptedCredential,
} from "./auth-service";
import { getLatestAuthenticatedKnowledgeSnapshot } from "./authenticated-knowledge-service";
import {
  BRAND_QUESTION_UNIVERSE_ADAPTER_FILENAME,
  BRAND_QUESTION_UNIVERSE_KNOWLEDGE_FILENAME,
  BRAND_QUESTION_UNIVERSE_MAX_KNOWLEDGE_BYTES,
  BRAND_QUESTION_UNIVERSE_MAX_KNOWLEDGE_DOCUMENTS,
  BRAND_QUESTION_UNIVERSE_UPSTREAM_FILENAME,
  BRAND_QUESTION_UNIVERSE_WIRE_SCHEMA,
  brandQuestionUniverseDashboardTable,
  brandQuestionUniversePublishDecision,
  buildAndVerifyBrandQuestionUniverseWorkbook,
  buildBrandQuestionUniverseAdapterArchive,
  buildBrandQuestionUniverseKnowledgeArchive,
  buildBrandQuestionUniversePrompt,
  classifyBrandQuestionUniverseKnowledgeDocuments,
  keywordTablesAreAutomaticallyManaged,
  keywordTablesFingerprint,
  loadBrandQuestionUniverseUpstreamArchive,
  parseBrandQuestionUniverseStructuredValue,
  type BrandQuestionUniverseRuntimeContext,
} from "./brand-question-universe-runtime";
import {
  DashboardRevisionConflictError,
  getDashboardWorkspace,
  getKnowledgeSnapshotById,
  updateDashboardWorkspace,
} from "./dashboard-service";
import { getDb } from "./db";
import {
  classifyManusV2StructuredResultEnvelope,
  latestManusV2TaskState,
  ManusV2ApiError,
  ManusV2Client,
  manusV2EventOperationToken,
  manusV2EventsContainOperationToken,
  orderManusV2EventsByProviderRank,
  type ManusV2MessageEvent,
} from "./manus-v2-client";
import { assertServiceCapability } from "./service-entitlement";
import { getUpstreamBaseUrl } from "./upstream-config";
import { assertUpstreamPromptBudget } from "./upstream-prompt-budget";
import { sealLocalAssetStorageIdentity } from "./local-asset-storage-key";
import {
  readStoredPresalesFile,
  removeStoredPresalesFile,
  stagePresalesFileContent,
} from "./presales-file-store";

export const BRAND_QUESTION_UNIVERSE_OPERATION_TYPE = "brand_question_universe";
export const BRAND_QUESTION_UNIVERSE_CONTRACT_REVISION = 1;
export const BRAND_QUESTION_UNIVERSE_MAX_REPAIRS = 3;

const CONTEXT_EVENT_ID = "local:brand-question-universe:context";
const CREATE_RECONCILE_GRACE_MS = 2 * 60_000;
const RESULT_GRACE_MS = 2 * 60_000;
const MAX_CACHED_STRUCTURED_BYTES = 512 * 1024;
const ACTIVE_OPERATION_STATUSES = [
  "queued",
  "running",
  "result_pending",
  "attention_required",
] as const;
const TERMINAL_PROVIDER_STATES = new Set([
  "stopped",
  "completed",
  "succeeded",
  "success",
  "finished",
  "done",
]);
const schemaHash = createHash("sha256")
  .update(JSON.stringify(BRAND_QUESTION_UNIVERSE_WIRE_SCHEMA), "utf8")
  .digest("hex");

type OperationStatus = (typeof agentOperations.$inferSelect)["status"];
type OwnedOperation = {
  operation: typeof agentOperations.$inferSelect;
  task: typeof agentTasks.$inferSelect;
};

const operationContextSchema = z
  .object({
    schemaVersion: z.literal(1),
    kind: z.literal("brand_question_universe_context"),
    clientRequestId: z.string().uuid(),
    operationToken: z.string().min(16).max(128),
    knowledgeSnapshotId: z.string().uuid(),
    knowledgeSnapshotVersion: z.number().int().positive(),
    knowledgeArchiveHash: z.string().regex(/^[a-f0-9]{64}$/u),
    expectedDashboardRevision: z.number().int().nonnegative(),
    baselineKeywordTablesFingerprint: z.string().regex(/^[a-f0-9]{64}$/u),
    brandName: z.string().trim().min(1).max(240),
    inputHashes: z
      .object({
        upstream: z.string().regex(/^[a-f0-9]{64}$/u),
        adapter: z.string().regex(/^[a-f0-9]{64}$/u),
        knowledge: z.string().regex(/^[a-f0-9]{64}$/u),
      })
      .strict(),
    firstDispatchState: z
      .enum(["send_ready", "send_unknown", "sent"])
      // Rows created before this field existed must be reconciled by reads,
      // never treated as proof that the provider mutation was not attempted.
      .default("send_unknown"),
    firstDispatchReservedAtMs: z
      .number()
      .int()
      .nonnegative()
      .nullable()
      .default(null),
    repairAttempts: z.number().int().min(0).max(3),
    repairState: z.enum(["none", "send_ready", "send_unknown", "pending"]),
    repairToken: z.string().max(128).nullable(),
    repairReservedAtMs: z.number().int().nonnegative().nullable(),
    repairErrors: z.array(z.string().max(128)).max(80),
    lastRejectedEventId: z.string().max(512).nullable(),
    resultArtifacts: z
      .object({
        json: z
          .object({
            artifactId: z.string().regex(/^artifact_[a-f0-9]{64}$/u),
            localAssetId: z.string().uuid(),
            sha256: z.string().regex(/^[a-f0-9]{64}$/u),
            sizeBytes: z.number().int().positive(),
          })
          .strict(),
        xlsx: z
          .object({
            artifactId: z.string().regex(/^artifact_[a-f0-9]{64}$/u),
            localAssetId: z.string().uuid(),
            sha256: z.string().regex(/^[a-f0-9]{64}$/u),
            sizeBytes: z.number().int().positive(),
          })
          .strict(),
      })
      .strict()
      .nullable(),
    workbookSha256: z
      .string()
      .regex(/^[a-f0-9]{64}$/u)
      .nullable(),
    tableId: z.string().max(160).nullable(),
    publicationOutcome: z
      .enum([
        "published",
        "already_published",
        "engineer_won",
        "newer_auto_won",
        "snapshot_superseded",
      ])
      .nullable(),
    publishedDashboardRevision: z.number().int().nonnegative().nullable(),
  })
  .strict();

type OperationContext = z.infer<typeof operationContextSchema>;
type ResultArtifactCoordinate = NonNullable<
  OperationContext["resultArtifacts"]
>["json"];

export function brandQuestionUniverseStatusFencesStart(
  status: OperationStatus,
) {
  return (ACTIVE_OPERATION_STATUSES as readonly OperationStatus[]).includes(
    status,
  );
}

export function brandQuestionUniverseFirstDispatchAction(input: {
  providerTaskId: string | null;
  state: OperationContext["firstDispatchState"];
}) {
  if (input.providerTaskId) return "continue" as const;
  if (input.state === "send_ready") return "dispatch" as const;
  if (input.state === "send_unknown") return "reconcile" as const;
  return "inconsistent" as const;
}

export function brandQuestionUniverseCreateFailureDisposition(input: {
  createClaimed: boolean;
  createAcknowledged: boolean;
  providerError: boolean;
  outcomeUnknown: boolean;
}) {
  if (!input.createClaimed) return "failed" as const;
  if (input.createAcknowledged) return "reconcile" as const;
  if (!input.providerError || input.outcomeUnknown) return "reconcile" as const;
  return "failed" as const;
}

export class BrandQuestionUniverseServiceError extends Error {
  constructor(
    readonly code: string,
    readonly statusCode: number,
    message: string,
  ) {
    super(message);
    this.name = "BrandQuestionUniverseServiceError";
  }
}

type KnowledgeClassification = ReturnType<
  typeof classifyBrandQuestionUniverseKnowledgeDocuments
>;

export type BrandQuestionUniverseKnowledgeReadiness =
  | { ready: true; acceptedDocuments: number; acceptedBytes: number }
  | {
      ready: false;
      reason: "safe_knowledge_required" | "knowledge_scope_exceeded";
      acceptedDocuments: number;
      acceptedBytes: number;
    };

/**
 * Lightweight eligibility contract shared by observe and start. Building the
 * deterministic ZIP remains a start-only operation.
 */
export function brandQuestionUniverseKnowledgeReadiness(
  classification: Pick<KnowledgeClassification, "accepted" | "acceptedBytes">,
): BrandQuestionUniverseKnowledgeReadiness {
  const acceptedDocuments = classification.accepted.length;
  if (acceptedDocuments === 0) {
    return {
      ready: false,
      reason: "safe_knowledge_required",
      acceptedDocuments,
      acceptedBytes: classification.acceptedBytes,
    };
  }
  if (
    acceptedDocuments > BRAND_QUESTION_UNIVERSE_MAX_KNOWLEDGE_DOCUMENTS ||
    classification.acceptedBytes > BRAND_QUESTION_UNIVERSE_MAX_KNOWLEDGE_BYTES
  ) {
    return {
      ready: false,
      reason: "knowledge_scope_exceeded",
      acceptedDocuments,
      acceptedBytes: classification.acceptedBytes,
    };
  }
  return {
    ready: true,
    acceptedDocuments,
    acceptedBytes: classification.acceptedBytes,
  };
}

function knowledgeReadinessError(
  readiness: Exclude<BrandQuestionUniverseKnowledgeReadiness, { ready: true }>,
) {
  return readiness.reason === "safe_knowledge_required"
    ? new BrandQuestionUniverseServiceError(
        "SAFE_KNOWLEDGE_REQUIRED",
        412,
        "当前认证知识库没有可用于词库生成的公开内容。",
      )
    : new BrandQuestionUniverseServiceError(
        "KNOWLEDGE_SCOPE_EXCEEDED",
        412,
        "当前知识库超过自动处理范围，请联系 FrontMind 协助。",
      );
}

type PreparationStage =
  | "upstream_workflow"
  | "frontmind_adapter"
  | "safe_knowledge_archive";

function errorCodeForPreparation(error: unknown) {
  return error instanceof Error ? error.message : "";
}

function isKnownWorkflowPreparationFailure(error: unknown) {
  const filesystemCode =
    error && typeof error === "object" && "code" in error
      ? (error as { code?: unknown }).code
      : null;
  if (filesystemCode === "ENOENT") return true;
  return new Set([
    "BRAND_QUESTION_UNIVERSE_WORKFLOW_MISSING",
    "BRAND_QUESTION_UNIVERSE_UPSTREAM_INTEGRITY_FAILED",
    "BRAND_QUESTION_UNIVERSE_ADAPTER_MANIFEST_INVALID",
    "BRAND_QUESTION_UNIVERSE_ADAPTER_INTEGRITY_FAILED",
  ]).has(errorCodeForPreparation(error));
}

export function brandQuestionUniversePreparationServiceError(
  stage: PreparationStage,
  error: unknown,
) {
  if (error instanceof BrandQuestionUniverseServiceError) return error;
  if (
    (stage === "upstream_workflow" || stage === "frontmind_adapter") &&
    isKnownWorkflowPreparationFailure(error)
  ) {
    return new BrandQuestionUniverseServiceError(
      "WORKFLOW_UNAVAILABLE",
      503,
      "品牌全域词库服务暂时不可用。",
    );
  }
  const code = errorCodeForPreparation(error);
  if (code === "BRAND_QUESTION_UNIVERSE_SAFE_KNOWLEDGE_EMPTY") {
    return knowledgeReadinessError({
      ready: false,
      reason: "safe_knowledge_required",
      acceptedDocuments: 0,
      acceptedBytes: 0,
    });
  }
  if (
    code === "BRAND_QUESTION_UNIVERSE_KNOWLEDGE_DOCUMENT_LIMIT" ||
    code === "BRAND_QUESTION_UNIVERSE_KNOWLEDGE_TOO_LARGE"
  ) {
    return knowledgeReadinessError({
      ready: false,
      reason: "knowledge_scope_exceeded",
      acceptedDocuments: 0,
      acceptedBytes: 0,
    });
  }
  return null;
}

function preparationErrorClass(error: unknown) {
  if (error instanceof Error && error.name.trim()) return error.name;
  return typeof error;
}

function logUnknownPreparationError(input: {
  actorId: number;
  knowledgeSnapshotId: string;
  stage: PreparationStage;
  error: unknown;
  classification: KnowledgeClassification;
}) {
  console.error("[BrandQuestionUniverse] start_failed", {
    event: "brand_question_universe_start_failed",
    userId: input.actorId,
    knowledgeSnapshotId: input.knowledgeSnapshotId,
    stage: input.stage,
    errorClass: preparationErrorClass(input.error),
    totalDocuments: input.classification.totalDocuments,
    acceptedDocuments: input.classification.accepted.length,
    rejectedByReason: input.classification.rejectedByReason,
  });
}

async function prepareBrandQuestionUniverseArchives(input: {
  actorId: number;
  runtimeContext: BrandQuestionUniverseRuntimeContext;
  classification: KnowledgeClassification;
}): Promise<PreparedArchives> {
  let stage: PreparationStage = "upstream_workflow";
  try {
    const upstream = await loadBrandQuestionUniverseUpstreamArchive();
    stage = "frontmind_adapter";
    const adapter = await buildBrandQuestionUniverseAdapterArchive();
    stage = "safe_knowledge_archive";
    const knowledge = await buildBrandQuestionUniverseKnowledgeArchive(
      input.runtimeContext,
    );
    return { upstream, adapter, knowledge };
  } catch (error) {
    const serviceError = brandQuestionUniversePreparationServiceError(
      stage,
      error,
    );
    if (serviceError) throw serviceError;
    logUnknownPreparationError({
      actorId: input.actorId,
      knowledgeSnapshotId: input.runtimeContext.snapshot.id,
      stage,
      error,
      classification: input.classification,
    });
    throw new BrandQuestionUniverseServiceError(
      "INPUT_PREPARATION_FAILED",
      500,
      "请求暂时无法完成，请稍后重试。",
    );
  }
}

function digest(value: unknown) {
  return createHash("sha256")
    .update(JSON.stringify(value), "utf8")
    .digest("hex");
}

function operationIdempotencyKeyHash(userId: number, clientRequestId: string) {
  return digest([
    BRAND_QUESTION_UNIVERSE_OPERATION_TYPE,
    userId,
    clientRequestId,
  ]);
}

export function brandQuestionUniverseFrozenRequestHash(
  context: Pick<
    OperationContext,
    "knowledgeSnapshotId" | "expectedDashboardRevision" | "inputHashes"
  >,
) {
  return digest({
    knowledgeSnapshotId: context.knowledgeSnapshotId,
    expectedDashboardRevision: context.expectedDashboardRevision,
    inputHashes: context.inputHashes,
  });
}

function deterministicUuid(input: string) {
  const hash = createHash("sha256").update(input, "utf8").digest("hex");
  return `${hash.slice(0, 8)}-${hash.slice(8, 12)}-4${hash.slice(13, 16)}-a${hash.slice(17, 20)}-${hash.slice(20, 32)}`;
}

async function persistStoredBody(input: {
  id: string;
  filename: string;
  mimeType: string;
  bytes: Buffer;
  sha256: string;
  maxBytes: number;
}) {
  const existing = await readStoredPresalesFile(input.id);
  if (existing) {
    if (
      existing.sizeBytes !== input.bytes.byteLength ||
      (existing.sha256 && existing.sha256 !== input.sha256)
    ) {
      throw new Error("BRAND_QUESTION_UNIVERSE_ARTIFACT_BODY_CONFLICT");
    }
    return;
  }
  const staged = await stagePresalesFileContent({
    fileId: input.id,
    stream: Readable.from(input.bytes),
    maxBytes: input.maxBytes,
  });
  try {
    if (
      staged.sizeBytes !== input.bytes.byteLength ||
      staged.sha256 !== input.sha256
    ) {
      throw new Error("BRAND_QUESTION_UNIVERSE_ARTIFACT_STAGE_MISMATCH");
    }
    await staged.commit({
      filename: input.filename,
      mimeType: input.mimeType,
    });
  } catch (error) {
    await staged.discard().catch(() => undefined);
    throw error;
  }
}

async function persistImmutableResultArtifact(input: {
  owned: OwnedOperation;
  sourceEventId: string;
  attachmentIndex: number;
  kind: "json" | "xlsx";
  filename: string;
  mimeType: string;
  bytes: Buffer;
  maxBytes: number;
}): Promise<ResultArtifactCoordinate> {
  if (input.bytes.byteLength < 1 || input.bytes.byteLength > input.maxBytes) {
    throw new Error("BRAND_QUESTION_UNIVERSE_ARTIFACT_SIZE_INVALID");
  }
  const db = await requireDb();
  const sha256 = createHash("sha256").update(input.bytes).digest("hex");
  const artifactId = `artifact_${sha256}`;
  const localAssetId = deterministicUuid(
    `${input.owned.operation.id}:${input.kind}:${sha256}`,
  );
  const artifactStorageKey = `brand-question-universe:${artifactId}`;
  const localStorageKey = `brand-question-universe:${input.owned.operation.id}:${input.kind}:${localAssetId}`;

  await persistStoredBody({
    id: artifactId,
    filename: input.filename,
    mimeType: input.mimeType,
    bytes: input.bytes,
    sha256,
    maxBytes: input.maxBytes,
  });
  await db
    .insert(artifacts)
    .values({
      id: artifactId,
      operationId: input.owned.operation.id,
      taskId: input.owned.task.id,
      sourceEventId: input.sourceEventId,
      attachmentIndex: input.attachmentIndex,
      filename: input.filename,
      mimeType: input.mimeType,
      sizeBytes: input.bytes.byteLength,
      contentSha256: sha256,
      storageKey: artifactStorageKey,
      validationState: "valid",
      refCount: 1,
    })
    .onDuplicateKeyUpdate({
      set: { validationState: "valid" },
    });
  const artifact = (
    await db
      .select()
      .from(artifacts)
      .where(eq(artifacts.id, artifactId))
      .limit(1)
  )[0];
  if (
    !artifact ||
    artifact.contentSha256 !== sha256 ||
    artifact.sizeBytes !== input.bytes.byteLength ||
    artifact.mimeType !== input.mimeType
  ) {
    throw new Error("BRAND_QUESTION_UNIVERSE_ARTIFACT_IDENTITY_CONFLICT");
  }

  const existingLocal = (
    await db
      .select()
      .from(localAssets)
      .where(eq(localAssets.id, localAssetId))
      .limit(1)
  )[0];
  if (existingLocal) {
    if (
      existingLocal.scope !== "managed_user" ||
      existingLocal.accountUserId !== input.owned.operation.accountUserId ||
      existingLocal.contentSha256 !== sha256 ||
      existingLocal.sizeBytes !== input.bytes.byteLength ||
      existingLocal.mimeType !== input.mimeType ||
      existingLocal.storageKey !== localStorageKey
    ) {
      throw new Error("BRAND_QUESTION_UNIVERSE_LOCAL_ASSET_CONFLICT");
    }
  }
  await persistStoredBody({
    id: localAssetId,
    filename: input.filename,
    mimeType: input.mimeType,
    bytes: input.bytes,
    sha256,
    maxBytes: input.maxBytes,
  });
  if (!existingLocal) {
    try {
      await db.insert(localAssets).values(
        sealLocalAssetStorageIdentity({
          id: localAssetId,
          scope: "managed_user" as const,
          accountUserId: input.owned.operation.accountUserId,
          presalesProjectId: null,
          filename: input.filename,
          mimeType: input.mimeType,
          sizeBytes: input.bytes.byteLength,
          contentSha256: sha256,
          storageKey: localStorageKey,
          refCount: 1,
          retainUntil: null,
        }),
      );
    } catch (error) {
      const raced = (
        await db
          .select()
          .from(localAssets)
          .where(eq(localAssets.id, localAssetId))
          .limit(1)
      )[0];
      if (
        !raced ||
        raced.accountUserId !== input.owned.operation.accountUserId ||
        raced.contentSha256 !== sha256 ||
        raced.sizeBytes !== input.bytes.byteLength ||
        raced.storageKey !== localStorageKey
      ) {
        await removeStoredPresalesFile(localAssetId).catch(() => undefined);
        throw error;
      }
    }
  }
  return {
    artifactId,
    localAssetId,
    sha256,
    sizeBytes: input.bytes.byteLength,
  };
}

async function requireDb() {
  const db = await getDb();
  if (!db) {
    throw new BrandQuestionUniverseServiceError(
      "DATABASE_UNAVAILABLE",
      503,
      "品牌全域词库服务暂时不可用。",
    );
  }
  return db;
}

function assertCustomer(actor: AuthenticatedUser) {
  if (actor.role !== "user") {
    throw new BrandQuestionUniverseServiceError(
      "CUSTOMER_ONLY",
      403,
      "只有当前客户账号可以抓取品牌全域词库。",
    );
  }
}

async function authenticatedSnapshot(userId: number) {
  const portal = await assertServiceCapability(userId, "globalKeywords");
  if (!portal.service.validFrom) return null;
  return getLatestAuthenticatedKnowledgeSnapshot({
    userId,
    notBefore: new Date(portal.service.validFrom),
  });
}

async function validPersonalCredential(userId: number) {
  const [status, credential] = await Promise.all([
    getApiCredentialStatus(userId),
    getDecryptedCredentialForUser(userId),
  ]);
  if (
    status.status !== "active" ||
    !status.verifiedAt ||
    !credential ||
    credential.status !== "active" ||
    credential.version !== status.version ||
    !credential.verifiedAt
  ) {
    return null;
  }
  return credential;
}

async function findLatestOperation(userId: number, activeOnly = false) {
  const db = await requireDb();
  const conditions: SQL[] = [
    eq(agentOperations.scope, "managed_user"),
    eq(agentOperations.accountUserId, userId),
    eq(agentOperations.operationType, BRAND_QUESTION_UNIVERSE_OPERATION_TYPE),
    eq(agentOperations.contractName, BRAND_QUESTION_UNIVERSE_OPERATION_TYPE),
    eq(
      agentOperations.contractRevision,
      BRAND_QUESTION_UNIVERSE_CONTRACT_REVISION,
    ),
  ];
  if (activeOnly) {
    conditions.push(
      inArray(agentOperations.status, [...ACTIVE_OPERATION_STATUSES]),
    );
  }
  return (
    await db
      .select({ operation: agentOperations, task: agentTasks })
      .from(agentOperations)
      .innerJoin(agentTasks, eq(agentTasks.operationId, agentOperations.id))
      .where(and(...conditions))
      .orderBy(desc(agentOperations.createdAt), desc(agentOperations.id))
      .limit(1)
  )[0] as OwnedOperation | undefined;
}

async function findOperationByClientRequest(
  userId: number,
  clientRequestId: string,
) {
  const db = await requireDb();
  return (
    await db
      .select({ operation: agentOperations, task: agentTasks })
      .from(agentOperations)
      .innerJoin(agentTasks, eq(agentTasks.operationId, agentOperations.id))
      .where(
        and(
          eq(agentOperations.scope, "managed_user"),
          eq(agentOperations.accountUserId, userId),
          eq(
            agentOperations.idempotencyKeyHash,
            operationIdempotencyKeyHash(userId, clientRequestId),
          ),
        ),
      )
      .limit(1)
  )[0] as OwnedOperation | undefined;
}

async function findOperationById(operationId: string) {
  const db = await requireDb();
  return (
    await db
      .select({ operation: agentOperations, task: agentTasks })
      .from(agentOperations)
      .innerJoin(agentTasks, eq(agentTasks.operationId, agentOperations.id))
      .where(eq(agentOperations.id, operationId))
      .limit(1)
  )[0] as OwnedOperation | undefined;
}

async function readOperationContext(taskId: string) {
  const db = await requireDb();
  const row = (
    await db
      .select({ payload: agentEvents.normalizedPayload })
      .from(agentEvents)
      .where(
        and(
          eq(agentEvents.taskId, taskId),
          eq(agentEvents.providerEventId, CONTEXT_EVENT_ID),
        ),
      )
      .limit(1)
  )[0];
  if (!row) {
    throw new BrandQuestionUniverseServiceError(
      "OPERATION_CONTEXT_MISSING",
      409,
      "词库任务上下文不完整，请重新抓取。",
    );
  }
  const parsed = operationContextSchema.safeParse(row.payload);
  if (!parsed.success) {
    throw new BrandQuestionUniverseServiceError(
      "OPERATION_CONTEXT_INVALID",
      409,
      "词库任务上下文不完整，请重新抓取。",
    );
  }
  return parsed.data;
}

export function brandQuestionUniverseReplayMatches(input: {
  operation: Pick<
    OwnedOperation["operation"],
    "operationType" | "contractName" | "contractRevision" | "requestHash"
  >;
  context: OperationContext;
  value: z.infer<typeof brandQuestionUniverseStartInputSchema>;
}) {
  return (
    input.operation.operationType === BRAND_QUESTION_UNIVERSE_OPERATION_TYPE &&
    input.operation.contractName === BRAND_QUESTION_UNIVERSE_OPERATION_TYPE &&
    input.operation.contractRevision ===
      BRAND_QUESTION_UNIVERSE_CONTRACT_REVISION &&
    input.context.clientRequestId === input.value.clientRequestId &&
    input.context.knowledgeSnapshotId === input.value.knowledgeSnapshotId &&
    input.context.expectedDashboardRevision ===
      input.value.expectedDashboardRevision &&
    input.operation.requestHash ===
      brandQuestionUniverseFrozenRequestHash(input.context)
  );
}

function assertIdempotentReplay(input: {
  owned: OwnedOperation;
  context: OperationContext;
  value: z.infer<typeof brandQuestionUniverseStartInputSchema>;
}) {
  const sameFrozenRequest = brandQuestionUniverseReplayMatches({
    operation: input.owned.operation,
    context: input.context,
    value: input.value,
  });
  if (!sameFrozenRequest) {
    throw new BrandQuestionUniverseServiceError(
      "IDEMPOTENCY_CONFLICT",
      409,
      "本次抓取请求标识已用于其他参数。",
    );
  }
}

async function mutateOperationContext(
  taskId: string,
  mutate: (context: OperationContext) => OperationContext,
) {
  const db = await requireDb();
  return db.transaction(async (tx) => {
    const row = (
      await tx
        .select({ payload: agentEvents.normalizedPayload })
        .from(agentEvents)
        .where(
          and(
            eq(agentEvents.taskId, taskId),
            eq(agentEvents.providerEventId, CONTEXT_EVENT_ID),
          ),
        )
        .limit(1)
        .for("update")
    )[0];
    const current = operationContextSchema.parse(row?.payload);
    const next = operationContextSchema.parse(mutate(current));
    await tx
      .update(agentEvents)
      .set({ normalizedPayload: next })
      .where(
        and(
          eq(agentEvents.taskId, taskId),
          eq(agentEvents.providerEventId, CONTEXT_EVENT_ID),
        ),
      );
    return next;
  });
}

async function updateOperationState(input: {
  operationId: string;
  taskId: string;
  status: OperationStatus;
  providerState: string;
  errorCode?: string | null;
  providerTaskId?: string;
  providerRequestId?: string | null;
  resultDeadlineAt?: Date | null;
}) {
  const db = await requireDb();
  await db.transaction(async (tx) => {
    await tx
      .update(agentOperations)
      .set({ status: input.status, errorCode: input.errorCode ?? null })
      .where(eq(agentOperations.id, input.operationId));
    await tx
      .update(agentTasks)
      .set({
        providerState: input.providerState,
        lastMessageSyncAt: new Date(),
        ...(input.providerTaskId
          ? { providerTaskId: input.providerTaskId }
          : {}),
        ...(input.providerRequestId !== undefined
          ? { providerRequestId: input.providerRequestId }
          : {}),
        ...(input.resultDeadlineAt !== undefined
          ? { resultDeadlineAt: input.resultDeadlineAt }
          : {}),
      })
      .where(eq(agentTasks.id, input.taskId));
  });
}

function clientFor(credential: DecryptedCredential, userId: number) {
  return new ManusV2Client({
    baseUrl: getUpstreamBaseUrl(),
    apiKey: credential.apiKey,
    rateLimitScope: `managed-user:${userId}`,
  });
}

function operationMarker(operationToken: string) {
  return `FRONTMIND_MANUS_V2_OPERATION_CONTRACT=${JSON.stringify({
    operationToken,
    contract: BRAND_QUESTION_UNIVERSE_OPERATION_TYPE,
    revision: BRAND_QUESTION_UNIVERSE_CONTRACT_REVISION,
  })}`;
}

function promptWithMarker(prompt: string, operationToken: string) {
  return assertUpstreamPromptBudget(
    `${prompt}\n\n# FrontMind operation contract\n${operationMarker(operationToken)}`,
  );
}

type PreparedArchives = {
  upstream: Awaited<
    ReturnType<typeof loadBrandQuestionUniverseUpstreamArchive>
  >;
  adapter: Awaited<ReturnType<typeof buildBrandQuestionUniverseAdapterArchive>>;
  knowledge: Awaited<
    ReturnType<typeof buildBrandQuestionUniverseKnowledgeArchive>
  >;
};

async function rebuildReservedArchives(
  owned: OwnedOperation,
  context: OperationContext,
): Promise<PreparedArchives> {
  const snapshot = await getKnowledgeSnapshotById({
    userId: owned.operation.accountUserId!,
    snapshotId: context.knowledgeSnapshotId,
  });
  if (
    !snapshot ||
    snapshot.version !== context.knowledgeSnapshotVersion ||
    snapshot.archiveHash !== context.knowledgeArchiveHash
  ) {
    throw new BrandQuestionUniverseServiceError(
      "FROZEN_INPUT_UNAVAILABLE",
      409,
      "词库任务的冻结知识输入不可用，需要人工检查。",
    );
  }
  const runtimeContext: BrandQuestionUniverseRuntimeContext = {
    operationToken: context.operationToken,
    brandName: context.brandName,
    snapshot: {
      id: snapshot.id,
      version: snapshot.version,
      archiveHash: snapshot.archiveHash,
      sourceFileName: snapshot.sourceFileName,
      documents: snapshot.documents,
    },
  };
  const [upstream, adapter, knowledge] = await Promise.all([
    loadBrandQuestionUniverseUpstreamArchive(),
    buildBrandQuestionUniverseAdapterArchive(),
    buildBrandQuestionUniverseKnowledgeArchive(runtimeContext),
  ]);
  const archives = { upstream, adapter, knowledge };
  if (
    upstream.contentHash !== context.inputHashes.upstream ||
    adapter.contentHash !== context.inputHashes.adapter ||
    knowledge.contentHash !== context.inputHashes.knowledge
  ) {
    throw new BrandQuestionUniverseServiceError(
      "FROZEN_INPUT_MISMATCH",
      409,
      "词库任务的冻结工作流输入不一致，需要人工检查。",
    );
  }
  return archives;
}

async function reserveOperation(input: {
  actor: AuthenticatedUser;
  credential: DecryptedCredential;
  value: z.infer<typeof brandQuestionUniverseStartInputSchema>;
  context: OperationContext;
  requestHash: string;
}) {
  const db = await requireDb();
  const idempotencyKeyHash = operationIdempotencyKeyHash(
    input.actor.id,
    input.value.clientRequestId,
  );
  const operationId = input.context.operationToken.split(":").at(-1)!;
  const taskId = randomUUID();
  const title = `FrontMind brand question universe ${operationId}`;

  const reservation = await db.transaction(async (tx) => {
    const lockedUser = (
      await tx
        .select({ id: users.id })
        .from(users)
        .where(eq(users.id, input.actor.id))
        .limit(1)
        .for("update")
    )[0];
    if (!lockedUser) {
      throw new BrandQuestionUniverseServiceError(
        "USER_NOT_FOUND",
        404,
        "当前账号不存在。",
      );
    }
    const existing = (
      await tx
        .select({ operation: agentOperations, task: agentTasks })
        .from(agentOperations)
        .innerJoin(agentTasks, eq(agentTasks.operationId, agentOperations.id))
        .where(
          and(
            eq(agentOperations.scope, "managed_user"),
            eq(agentOperations.idempotencyKeyHash, idempotencyKeyHash),
          ),
        )
        .limit(1)
    )[0];
    if (existing) {
      if (
        existing.operation.accountUserId !== input.actor.id ||
        existing.operation.requestHash !== input.requestHash
      ) {
        throw new BrandQuestionUniverseServiceError(
          "IDEMPOTENCY_CONFLICT",
          409,
          "本次抓取请求标识已用于其他参数。",
        );
      }
      return { operationId: existing.operation.id, acquired: false as const };
    }

    const dashboard = (
      await tx
        .select({
          revision: userDashboardContents.revision,
          payload: userDashboardContents.payload,
        })
        .from(userDashboardContents)
        .where(eq(userDashboardContents.userId, input.actor.id))
        .limit(1)
    )[0];
    const revision = dashboard?.revision ?? 0;
    const keywordTables = dashboard
      ? dashboardPayloadSchema.parse(dashboard.payload).keywordTables
      : [];
    if (revision !== input.value.expectedDashboardRevision) {
      throw new BrandQuestionUniverseServiceError(
        "DASHBOARD_REVISION_CONFLICT",
        409,
        "企业看板已更新，请刷新后重新抓取。",
      );
    }
    if (!keywordTablesAreAutomaticallyManaged(keywordTables)) {
      throw new BrandQuestionUniverseServiceError(
        "ENGINEER_VERSION_PRESENT",
        409,
        "工程师正式词库已发布，自动抓取不会覆盖该版本。",
      );
    }
    const active = (
      await tx
        .select({ id: agentOperations.id })
        .from(agentOperations)
        .where(
          and(
            eq(agentOperations.scope, "managed_user"),
            eq(agentOperations.accountUserId, input.actor.id),
            eq(
              agentOperations.operationType,
              BRAND_QUESTION_UNIVERSE_OPERATION_TYPE,
            ),
            inArray(agentOperations.status, [...ACTIVE_OPERATION_STATUSES]),
          ),
        )
        .limit(1)
    )[0];
    if (active) {
      throw new BrandQuestionUniverseServiceError(
        "OPERATION_ACTIVE",
        409,
        "品牌全域词库正在抓取，请等待当前任务完成。",
      );
    }

    await tx.insert(agentOperations).values({
      id: operationId,
      scope: "managed_user",
      accountUserId: input.actor.id,
      presalesProjectId: null,
      operationType: BRAND_QUESTION_UNIVERSE_OPERATION_TYPE,
      idempotencyKeyHash,
      requestHash: input.requestHash,
      contractName: BRAND_QUESTION_UNIVERSE_OPERATION_TYPE,
      contractRevision: BRAND_QUESTION_UNIVERSE_CONTRACT_REVISION,
      schemaHash,
      apiCredentialId: input.credential.id,
      credentialVersion: input.credential.version,
      publicProfile: input.credential.agentProfile,
      upstreamModel: input.credential.upstreamModel,
      status: "queued",
    });
    await tx.insert(agentTasks).values({
      id: taskId,
      operationId,
      providerTaskId: null,
      providerRequestId: null,
      createMarker: input.context.operationToken,
      title,
      providerState: "queued",
    });
    await tx.insert(agentEvents).values({
      id: randomUUID(),
      taskId,
      providerEventId: CONTEXT_EVENT_ID,
      eventType: "local_context",
      providerTimestampMs: Date.now(),
      normalizedPayload: input.context,
    });
    return { operationId, acquired: true as const };
  });
  const owned = await findOperationById(reservation.operationId);
  if (!owned) {
    throw new BrandQuestionUniverseServiceError(
      "OPERATION_RESERVATION_LOST",
      409,
      "词库任务未能完成预留，请重试。",
    );
  }
  return { ...owned, acquired: reservation.acquired };
}

async function dispatchOperation(input: {
  owned: OwnedOperation;
  credential: DecryptedCredential;
  context: OperationContext;
  archives: PreparedArchives;
}) {
  const { owned, credential, context } = input;
  if (context.firstDispatchState !== "send_ready") return;
  const client = clientFor(credential, owned.operation.accountUserId!);
  let createClaimed = false;
  let createAcknowledged: {
    taskId: string;
    requestId?: string | null;
  } | null = null;
  try {
    const attachments = [];
    for (const source of [
      {
        filename: BRAND_QUESTION_UNIVERSE_UPSTREAM_FILENAME,
        archive: input.archives.upstream,
      },
      {
        filename: BRAND_QUESTION_UNIVERSE_ADAPTER_FILENAME,
        archive: input.archives.adapter,
      },
      {
        filename: BRAND_QUESTION_UNIVERSE_KNOWLEDGE_FILENAME,
        archive: input.archives.knowledge,
      },
    ]) {
      const uploaded = await client.uploadFile({
        filename: source.filename,
        bytes: source.archive.bytes,
        contentType: "application/zip",
        observer: {
          onCandidateCreated: async ({ fileId }) => {
            await recordUpstreamResource({
              userId: owned.operation.accountUserId!,
              apiCredentialId: credential.id,
              kind: "file",
              upstreamId: fileId,
            });
          },
        },
      });
      attachments.push({
        file_id: uploaded.fileId,
        filename: source.filename,
      });
    }

    const createPrompt = promptWithMarker(
      buildBrandQuestionUniversePrompt({
        operationToken: context.operationToken,
        brandName: context.brandName,
        snapshot: {
          id: context.knowledgeSnapshotId,
          version: context.knowledgeSnapshotVersion,
          archiveHash: context.knowledgeArchiveHash,
          sourceFileName: "customer-safe-snapshot.zip",
          documents: [],
        },
      }),
      context.operationToken,
    );

    // Uploading immutable inputs is retryable. Claim only immediately before
    // the task-create mutation: after this CAS, crashes and ambiguous responses
    // are reconciled by reads and must never POST the task again.
    await mutateOperationContext(owned.task.id, (current) => {
      if (current.firstDispatchState !== "send_ready") return current;
      createClaimed = true;
      return {
        ...current,
        firstDispatchState: "send_unknown",
        firstDispatchReservedAtMs: Date.now(),
      };
    });
    if (!createClaimed) return;
    const created = await client.createTask({
      prompt: createPrompt,
      attachments,
      title: owned.task.title,
      agentProfile: owned.operation.upstreamModel,
      locale: "zh-CN",
      interactiveMode: false,
      structuredOutputSchema: BRAND_QUESTION_UNIVERSE_WIRE_SCHEMA,
    });
    createAcknowledged = created;
    await recordUpstreamResource({
      userId: owned.operation.accountUserId!,
      apiCredentialId: credential.id,
      kind: "task",
      upstreamId: created.taskId,
    });
    await updateOperationState({
      operationId: owned.operation.id,
      taskId: owned.task.id,
      status: "running",
      providerState: "running",
      providerTaskId: created.taskId,
      providerRequestId: created.requestId,
      errorCode: null,
    });
    await mutateOperationContext(owned.task.id, (current) => ({
      ...current,
      firstDispatchState: "sent",
    }));
  } catch (error) {
    const disposition = brandQuestionUniverseCreateFailureDisposition({
      createClaimed,
      createAcknowledged: Boolean(createAcknowledged),
      providerError: error instanceof ManusV2ApiError,
      outcomeUnknown:
        error instanceof ManusV2ApiError && error.outcomeUnknown === true,
    });
    if (disposition === "reconcile") {
      // A task-create response or its outcome may already exist. Local
      // bookkeeping failures must never turn that external side effect into a
      // retryable terminal failure. Bind the known task when possible;
      // otherwise keep the durable send_unknown fence for marker reconciliation.
      try {
        const reconciled = createAcknowledged
          ? {
              unique: {
                id: createAcknowledged.taskId,
                status: "running" as const,
              },
              matches: [{ id: createAcknowledged.taskId }],
            }
          : await client.findCreatedTask({
              title: owned.task.title,
              operationToken: context.operationToken,
              createdAfterSeconds:
                Math.floor(owned.operation.createdAt.getTime() / 1_000) - 60,
              createdBeforeSeconds: Math.floor(Date.now() / 1_000) + 60,
            });
        if (reconciled.unique) {
          await recordUpstreamResource({
            userId: owned.operation.accountUserId!,
            apiCredentialId: credential.id,
            kind: "task",
            upstreamId: reconciled.unique.id,
          });
          await updateOperationState({
            operationId: owned.operation.id,
            taskId: owned.task.id,
            status: "running",
            providerState: reconciled.unique.status ?? "running",
            providerTaskId: reconciled.unique.id,
            providerRequestId:
              createAcknowledged?.requestId ??
              (error instanceof ManusV2ApiError
                ? error.providerRequestId
                : null),
            errorCode: null,
          });
          await mutateOperationContext(owned.task.id, (current) => ({
            ...current,
            firstDispatchState: "sent",
          }));
          return;
        }
        if (reconciled.matches.length > 1) {
          await updateOperationState({
            operationId: owned.operation.id,
            taskId: owned.task.id,
            status: "attention_required",
            providerState: "attention_required",
            errorCode: "CREATE_RECONCILE_CONFLICT",
          });
          return;
        }
      } catch {
        // The worker repeats this exact marker reconciliation. Never issue a
        // second create when provider or local persistence is unavailable.
      }
      try {
        const refreshed = await findOperationById(owned.operation.id);
        if (refreshed?.task.providerTaskId) return;
        await updateOperationState({
          operationId: owned.operation.id,
          taskId: owned.task.id,
          status: "result_pending",
          providerState: "create_outcome_unknown",
          providerRequestId:
            createAcknowledged?.requestId ??
            (error instanceof ManusV2ApiError ? error.providerRequestId : null),
          errorCode: null,
        });
      } catch {
        // A still-queued row with send_unknown remains worker-owned and fenced.
      }
      return;
    }
    await updateOperationState({
      operationId: owned.operation.id,
      taskId: owned.task.id,
      status: "failed",
      providerState: "failed",
      errorCode:
        error instanceof ManusV2ApiError ? error.code : "TASK_CREATE_FAILED",
    });
    throw new BrandQuestionUniverseServiceError(
      "TASK_CREATE_FAILED",
      502,
      "品牌全域词库任务暂时无法启动，请稍后重试。",
    );
  }
}

async function persistProviderEvents(
  taskId: string,
  events: readonly ManusV2MessageEvent[],
) {
  const db = await requireDb();
  for (const event of events) {
    const normalizedPayload: Record<string, unknown> = {
      kind: "brand_question_universe_provider_event",
      type: event.type,
    };
    if (
      Number.isSafeInteger(event.providerOriginalRank) &&
      Number(event.providerOriginalRank) >= 0
    ) {
      normalizedPayload.providerOriginalRank = event.providerOriginalRank;
    }
    const token = manusV2EventOperationToken(event);
    if (token) normalizedPayload.operationToken = token;
    if (event.type === "structured_output_result") {
      const classified = classifyManusV2StructuredResultEnvelope(
        event.structured_output_result,
      );
      normalizedPayload.structuredKind = classified.kind;
      if (classified.kind === "accepted") {
        const serialized = JSON.stringify(classified.value);
        if (
          Buffer.byteLength(serialized, "utf8") <= MAX_CACHED_STRUCTURED_BYTES
        ) {
          normalizedPayload.structuredValue = classified.value;
        } else {
          normalizedPayload.structuredKind = "oversized";
        }
      }
    }
    if (event.type === "status_update") {
      const status = event.status_update;
      if (status && typeof status === "object" && !Array.isArray(status)) {
        const agentState = (status as Record<string, unknown>).agent_status;
        if (typeof agentState === "string") {
          normalizedPayload.agentState = agentState;
        }
      }
    }
    await db
      .insert(agentEvents)
      .values({
        id: randomUUID(),
        taskId,
        providerEventId: event.id,
        eventType: event.type,
        providerTimestampMs: event.timestamp,
        normalizedPayload,
      })
      .onDuplicateKeyUpdate({
        set: {
          eventType: event.type,
          providerTimestampMs: event.timestamp,
          normalizedPayload,
        },
      });
  }
}

async function cachedProviderEvents(taskId: string) {
  const db = await requireDb();
  const rows = await db
    .select()
    .from(agentEvents)
    .where(eq(agentEvents.taskId, taskId))
    .orderBy(agentEvents.providerTimestampMs, agentEvents.id);
  return rows.flatMap<ManusV2MessageEvent>((row, index) => {
    const payload = row.normalizedPayload;
    if (payload.kind !== "brand_question_universe_provider_event") return [];
    const event: ManusV2MessageEvent = {
      id: row.providerEventId,
      type: String(payload.type ?? row.eventType),
      timestamp: row.providerTimestampMs,
      providerOriginalRank:
        typeof payload.providerOriginalRank === "number"
          ? payload.providerOriginalRank
          : index,
    };
    if (typeof payload.operationToken === "string") {
      event.user_message = {
        content: operationMarker(payload.operationToken),
      };
    }
    if (payload.structuredValue !== undefined) {
      event.structured_output_result = {
        success: true,
        value: payload.structuredValue,
      };
    } else if (payload.structuredKind === "rejected") {
      event.structured_output_result = { success: false };
    }
    if (typeof payload.agentState === "string") {
      event.status_update = { agent_status: payload.agentState };
    }
    return [event];
  });
}

function mergeProviderEvents(
  cached: readonly ManusV2MessageEvent[],
  live: readonly ManusV2MessageEvent[],
) {
  const events = new Map<string, ManusV2MessageEvent>();
  for (const event of cached) events.set(event.id, event);
  for (const event of live) events.set(event.id, event);
  return orderManusV2EventsByProviderRank(
    [...events.values()],
    "oldest_first",
  ).map((event, providerOriginalRank) => ({
    ...event,
    providerOriginalRank,
  }));
}

function eventsForRound(
  events: readonly ManusV2MessageEvent[],
  operationToken: string,
) {
  let markerIndex = -1;
  events.forEach((event, index) => {
    if (manusV2EventOperationToken(event) === operationToken)
      markerIndex = index;
  });
  return markerIndex < 0 ? null : events.slice(markerIndex + 1);
}

function validationCodes(error: unknown) {
  if (error instanceof BrandQuestionUniverseValidationError) {
    return error.codes;
  }
  if (error instanceof SyntaxError) return ["PAYLOAD_JSON_INVALID"];
  return ["WIRE_INVALID"];
}

function structuredRoundResult(
  events: readonly ManusV2MessageEvent[],
  operationToken: string,
):
  | { kind: "valid"; payload: BrandQuestionUniversePayload; eventId: string }
  | { kind: "invalid"; codes: string[]; eventId: string | null }
  | { kind: "missing" } {
  const candidates = [...events]
    .filter((event) => event.type === "structured_output_result")
    .reverse();
  const latest = candidates[0];
  if (!latest) return { kind: "missing" };
  const classified = classifyManusV2StructuredResultEnvelope(
    latest.structured_output_result,
  );
  if (classified.kind !== "accepted") {
    return {
      kind: "invalid",
      codes: [classified.code],
      eventId: latest.id,
    };
  }
  try {
    return {
      kind: "valid",
      payload: parseBrandQuestionUniverseStructuredValue(
        classified.value,
        operationToken,
      ),
      eventId: latest.id,
    };
  } catch (error) {
    return {
      kind: "invalid",
      codes: validationCodes(error),
      eventId: latest.id,
    };
  }
}

async function scheduleRepair(input: {
  owned: OwnedOperation;
  codes: string[];
  rejectedEventId: string | null;
}) {
  let exhausted = false;
  const next = await mutateOperationContext(input.owned.task.id, (current) => {
    if (
      current.repairState === "send_ready" ||
      current.repairState === "send_unknown"
    ) {
      return current;
    }
    const nextAttempt = current.repairAttempts + 1;
    if (nextAttempt > BRAND_QUESTION_UNIVERSE_MAX_REPAIRS) {
      exhausted = true;
      return current;
    }
    return {
      ...current,
      repairAttempts: nextAttempt,
      repairState: "send_ready",
      repairToken: `brand-question-universe-repair:${input.owned.operation.id}:${nextAttempt}`,
      repairReservedAtMs: Date.now(),
      repairErrors: [...new Set(input.codes)].slice(0, 80),
      lastRejectedEventId: input.rejectedEventId,
    };
  });
  if (exhausted) {
    await updateOperationState({
      operationId: input.owned.operation.id,
      taskId: input.owned.task.id,
      status: "failed",
      providerState: "failed",
      errorCode: "BRAND_QUESTION_UNIVERSE_OUTPUT_INVALID",
    });
  }
  return { context: next, exhausted };
}

async function dispatchPendingRepair(input: {
  owned: OwnedOperation;
  context: OperationContext;
  credential: DecryptedCredential;
}) {
  if (!input.owned.task.providerTaskId || !input.context.repairToken) return;
  let claimed = false;
  const claimedContext = await mutateOperationContext(
    input.owned.task.id,
    (current) => {
      if (
        current.repairState !== "send_ready" ||
        current.repairToken !== input.context.repairToken
      ) {
        return current;
      }
      claimed = true;
      return { ...current, repairState: "send_unknown" };
    },
  );
  if (!claimed || !claimedContext.repairToken) return;
  const prompt = [
    "继续同一个品牌全域词库任务。上一次结果未通过 Dashboard 严格合同。",
    `这是第 ${claimedContext.repairAttempts}/3 次修复。`,
    `只修复这些稳定错误码：${claimedContext.repairErrors.join(",") || "STRUCTURED_OUTPUT_MISSING"}。`,
    `payload.operationToken 必须仍为原始值 ${claimedContext.operationToken}。`,
    "重新返回完整 160 行。只通过 structured output 的 payload JSON 字符串返回结果。",
  ].join("\n");
  try {
    await clientFor(
      input.credential,
      input.owned.operation.accountUserId!,
    ).sendMessage({
      taskId: input.owned.task.providerTaskId,
      prompt: promptWithMarker(prompt, claimedContext.repairToken),
      structuredOutputSchema: BRAND_QUESTION_UNIVERSE_WIRE_SCHEMA,
    });
    await mutateOperationContext(input.owned.task.id, (current) =>
      current.repairToken === claimedContext.repairToken
        ? { ...current, repairState: "pending" }
        : current,
    );
    await updateOperationState({
      operationId: input.owned.operation.id,
      taskId: input.owned.task.id,
      status: "running",
      providerState: "running",
      errorCode: null,
      resultDeadlineAt: null,
    });
  } catch (error) {
    if (error instanceof ManusV2ApiError && error.outcomeUnknown) {
      await updateOperationState({
        operationId: input.owned.operation.id,
        taskId: input.owned.task.id,
        status: "result_pending",
        providerState: "repair_send_unknown",
        errorCode: null,
      });
      return;
    }
    if (error instanceof ManusV2ApiError && error.retryable) {
      await mutateOperationContext(input.owned.task.id, (current) =>
        current.repairToken === claimedContext.repairToken
          ? { ...current, repairState: "send_ready" }
          : current,
      );
      await updateOperationState({
        operationId: input.owned.operation.id,
        taskId: input.owned.task.id,
        status: "result_pending",
        providerState: "repair_retry_ready",
        errorCode: null,
      });
      return;
    }
    await updateOperationState({
      operationId: input.owned.operation.id,
      taskId: input.owned.task.id,
      status: "failed",
      providerState: "failed",
      errorCode: "REPAIR_SEND_FAILED",
    });
  }
}

async function completeOperation(input: {
  owned: OwnedOperation;
  outcome: NonNullable<OperationContext["publicationOutcome"]>;
  resultArtifacts: NonNullable<OperationContext["resultArtifacts"]>;
  workbookSha256: string;
  tableId: string;
  dashboardRevision: number | null;
}) {
  await mutateOperationContext(input.owned.task.id, (current) => ({
    ...current,
    resultArtifacts: input.resultArtifacts,
    workbookSha256: input.workbookSha256,
    tableId: input.tableId,
    publicationOutcome: input.outcome,
    publishedDashboardRevision: input.dashboardRevision,
  }));
  await updateOperationState({
    operationId: input.owned.operation.id,
    taskId: input.owned.task.id,
    status: "succeeded",
    providerState: "succeeded",
    errorCode: null,
    resultDeadlineAt: null,
  });
}

async function publishPayload(input: {
  owned: OwnedOperation;
  context: OperationContext;
  payload: BrandQuestionUniversePayload;
  sourceEventId: string;
}) {
  const jsonBytes = Buffer.from(
    `${JSON.stringify(input.payload, null, 2)}\n`,
    "utf8",
  );
  const workbook = await buildAndVerifyBrandQuestionUniverseWorkbook(
    input.payload,
  );
  const artifactStem = `brand-question-universe-${input.context.knowledgeSnapshotId}`;
  const [jsonArtifact, xlsxArtifact] = await Promise.all([
    persistImmutableResultArtifact({
      owned: input.owned,
      sourceEventId: input.sourceEventId,
      attachmentIndex: 0,
      kind: "json",
      filename: `${artifactStem}.json`,
      mimeType: "application/json",
      bytes: jsonBytes,
      maxBytes: 2 * 1024 * 1024,
    }),
    persistImmutableResultArtifact({
      owned: input.owned,
      sourceEventId: input.sourceEventId,
      attachmentIndex: 1,
      kind: "xlsx",
      filename: `${artifactStem}.xlsx`,
      mimeType:
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      bytes: workbook.bytes,
      maxBytes: 16 * 1024 * 1024,
    }),
  ]);
  const resultArtifacts = { json: jsonArtifact, xlsx: xlsxArtifact };
  if (xlsxArtifact.sha256 !== workbook.sha256) {
    throw new Error("BRAND_QUESTION_UNIVERSE_WORKBOOK_HASH_MISMATCH");
  }
  const table = brandQuestionUniverseDashboardTable(
    input.payload,
    input.context.knowledgeSnapshotId,
  );
  const currentSnapshot = await authenticatedSnapshot(
    input.owned.operation.accountUserId!,
  );
  if (currentSnapshot?.id !== input.context.knowledgeSnapshotId) {
    await completeOperation({
      owned: input.owned,
      outcome: "snapshot_superseded",
      resultArtifacts,
      workbookSha256: workbook.sha256,
      tableId: table.id,
      dashboardRevision: null,
    });
    return;
  }
  const workspace = await getDashboardWorkspace(
    input.owned.operation.accountUserId!,
  );
  const decision = brandQuestionUniversePublishDecision({
    current: workspace.payload.keywordTables,
    baselineFingerprint: input.context.baselineKeywordTablesFingerprint,
    proposed: table,
  });
  if (decision !== "publish") {
    await completeOperation({
      owned: input.owned,
      outcome: decision,
      resultArtifacts,
      workbookSha256: workbook.sha256,
      tableId: table.id,
      dashboardRevision: workspace.revision,
    });
    return;
  }
  try {
    const published = await updateDashboardWorkspace({
      userId: input.owned.operation.accountUserId!,
      actorUserId: input.owned.operation.accountUserId!,
      payload: dashboardPayloadSchema.parse({
        ...workspace.payload,
        keywordTables: [table],
      }),
      sourceName: `brand-question-universe-${input.context.knowledgeSnapshotId}.xlsx`,
      reason: "客户使用个人 AI 凭据抓取品牌全域词库",
      expectedRevision: workspace.revision,
    });
    await completeOperation({
      owned: input.owned,
      outcome: "published",
      resultArtifacts,
      workbookSha256: workbook.sha256,
      tableId: table.id,
      dashboardRevision: published.revision,
    });
  } catch (error) {
    if (!(error instanceof DashboardRevisionConflictError)) throw error;
    const raced = await getDashboardWorkspace(
      input.owned.operation.accountUserId!,
    );
    const racedDecision = brandQuestionUniversePublishDecision({
      current: raced.payload.keywordTables,
      baselineFingerprint: input.context.baselineKeywordTablesFingerprint,
      proposed: table,
    });
    if (racedDecision === "publish") {
      await updateOperationState({
        operationId: input.owned.operation.id,
        taskId: input.owned.task.id,
        status: "result_pending",
        providerState: "publish_pending",
        errorCode: null,
      });
      return;
    }
    await completeOperation({
      owned: input.owned,
      outcome: racedDecision,
      resultArtifacts,
      workbookSha256: workbook.sha256,
      tableId: table.id,
      dashboardRevision: raced.revision,
    });
  }
}

async function reconcileUnknownCreate(input: {
  owned: OwnedOperation;
  context: OperationContext;
  credential: DecryptedCredential;
}) {
  if (input.owned.task.providerTaskId) return input.owned;
  if (input.context.firstDispatchState !== "send_unknown") {
    return input.owned;
  }
  const client = clientFor(
    input.credential,
    input.owned.operation.accountUserId!,
  );
  const reconciled = await client.findCreatedTask({
    title: input.owned.task.title,
    operationToken: input.context.operationToken,
    createdAfterSeconds:
      Math.floor(input.owned.operation.createdAt.getTime() / 1_000) - 60,
    createdBeforeSeconds: Math.floor(Date.now() / 1_000) + 60,
  });
  if (reconciled.matches.length > 1) {
    await updateOperationState({
      operationId: input.owned.operation.id,
      taskId: input.owned.task.id,
      status: "attention_required",
      providerState: "attention_required",
      errorCode: "CREATE_RECONCILE_CONFLICT",
    });
  } else if (reconciled.unique) {
    await recordUpstreamResource({
      userId: input.owned.operation.accountUserId!,
      apiCredentialId: input.credential.id,
      kind: "task",
      upstreamId: reconciled.unique.id,
    });
    await updateOperationState({
      operationId: input.owned.operation.id,
      taskId: input.owned.task.id,
      status: "running",
      providerState: reconciled.unique.status ?? "running",
      providerTaskId: reconciled.unique.id,
      errorCode: null,
    });
    await mutateOperationContext(input.owned.task.id, (current) => ({
      ...current,
      firstDispatchState: "sent",
    }));
  } else if (
    Date.now() -
      (input.context.firstDispatchReservedAtMs ??
        input.owned.operation.createdAt.getTime()) >=
    CREATE_RECONCILE_GRACE_MS
  ) {
    await updateOperationState({
      operationId: input.owned.operation.id,
      taskId: input.owned.task.id,
      status: "attention_required",
      providerState: "attention_required",
      errorCode: "CREATE_OUTCOME_UNKNOWN",
    });
  }
  return (await findOperationById(input.owned.operation.id)) ?? input.owned;
}

async function reconcileOperation(initial: OwnedOperation) {
  let owned = initial;
  let context = await readOperationContext(owned.task.id);
  const credential = await getDecryptedCredentialForAccountById(
    owned.operation.accountUserId!,
    owned.operation.apiCredentialId,
  );
  if (
    !credential ||
    credential.version !== owned.operation.credentialVersion ||
    credential.agentProfile !== owned.operation.publicProfile ||
    credential.upstreamModel !== owned.operation.upstreamModel
  ) {
    await updateOperationState({
      operationId: owned.operation.id,
      taskId: owned.task.id,
      status: "attention_required",
      providerState: "attention_required",
      errorCode: "TASK_CREDENTIAL_UNAVAILABLE",
    });
    return (await findOperationById(owned.operation.id)) ?? owned;
  }
  let firstDispatchAction = brandQuestionUniverseFirstDispatchAction({
    providerTaskId: owned.task.providerTaskId,
    state: context.firstDispatchState,
  });
  if (firstDispatchAction === "dispatch") {
    try {
      await dispatchOperation({
        owned,
        credential,
        context,
        archives: await rebuildReservedArchives(owned, context),
      });
    } catch (error) {
      const refreshed = await findOperationById(owned.operation.id);
      if (refreshed?.operation.status === "failed") return refreshed;
      await updateOperationState({
        operationId: owned.operation.id,
        taskId: owned.task.id,
        status: "attention_required",
        providerState: "attention_required",
        errorCode:
          error instanceof BrandQuestionUniverseServiceError
            ? error.code
            : "FROZEN_INPUT_UNAVAILABLE",
      });
    }
    owned = (await findOperationById(owned.operation.id)) ?? owned;
    context = await readOperationContext(owned.task.id);
    firstDispatchAction = brandQuestionUniverseFirstDispatchAction({
      providerTaskId: owned.task.providerTaskId,
      state: context.firstDispatchState,
    });
  }
  if (firstDispatchAction === "reconcile") {
    owned = await reconcileUnknownCreate({ owned, context, credential });
  }
  if (!owned.task.providerTaskId) return owned;
  if (context.firstDispatchState !== "sent") {
    context = await mutateOperationContext(owned.task.id, (current) => ({
      ...current,
      firstDispatchState: "sent",
    }));
  }

  let liveEvents: ManusV2MessageEvent[] = [];
  let detailState: string | null = null;
  try {
    const client = clientFor(credential, owned.operation.accountUserId!);
    liveEvents = await client.listAllMessages({
      taskId: owned.task.providerTaskId,
      order: "asc",
    });
    await persistProviderEvents(owned.task.id, liveEvents);
    detailState = (await client.taskDetail(owned.task.providerTaskId)).status;
  } catch {
    // A prior successful sync remains usable. Observation never creates a
    // replacement task merely because one provider read was unavailable.
  }
  const events = mergeProviderEvents(
    await cachedProviderEvents(owned.task.id),
    liveEvents,
  );
  const state = latestManusV2TaskState(events) ?? detailState ?? "running";
  if (["error", "failed", "cancelled"].includes(state)) {
    await updateOperationState({
      operationId: owned.operation.id,
      taskId: owned.task.id,
      status: state === "cancelled" ? "cancelled" : "failed",
      providerState: state,
      errorCode: "PROVIDER_TASK_FAILED",
    });
    return (await findOperationById(owned.operation.id)) ?? owned;
  }

  context = await readOperationContext(owned.task.id);
  if (context.repairState === "send_ready") {
    await dispatchPendingRepair({ owned, context, credential });
    return (await findOperationById(owned.operation.id)) ?? owned;
  }
  if (context.repairState === "send_unknown") {
    if (
      context.repairToken &&
      manusV2EventsContainOperationToken(events, context.repairToken)
    ) {
      context = await mutateOperationContext(owned.task.id, (current) =>
        current.repairToken === context.repairToken
          ? { ...current, repairState: "pending" }
          : current,
      );
    } else if (
      context.repairReservedAtMs &&
      Date.now() - context.repairReservedAtMs >= RESULT_GRACE_MS
    ) {
      await updateOperationState({
        operationId: owned.operation.id,
        taskId: owned.task.id,
        status: "attention_required",
        providerState: "attention_required",
        errorCode: "REPAIR_SEND_OUTCOME_UNKNOWN",
      });
    } else {
      await updateOperationState({
        operationId: owned.operation.id,
        taskId: owned.task.id,
        status: "result_pending",
        providerState: "repair_send_unknown",
        errorCode: null,
      });
    }
    return (await findOperationById(owned.operation.id)) ?? owned;
  }

  const roundToken =
    context.repairState === "pending" && context.repairToken
      ? context.repairToken
      : context.operationToken;
  const round = eventsForRound(events, roundToken);
  if (!round) {
    await updateOperationState({
      operationId: owned.operation.id,
      taskId: owned.task.id,
      status: "result_pending",
      providerState: state,
      errorCode: null,
    });
    return (await findOperationById(owned.operation.id)) ?? owned;
  }
  if (!TERMINAL_PROVIDER_STATES.has(state)) {
    await updateOperationState({
      operationId: owned.operation.id,
      taskId: owned.task.id,
      status: "running",
      providerState: state,
      errorCode: null,
    });
    return (await findOperationById(owned.operation.id)) ?? owned;
  }

  const result = structuredRoundResult(round, context.operationToken);
  if (result.kind === "valid") {
    try {
      await publishPayload({
        owned,
        context,
        payload: result.payload,
        sourceEventId: result.eventId,
      });
    } catch {
      await updateOperationState({
        operationId: owned.operation.id,
        taskId: owned.task.id,
        status: "failed",
        providerState: "failed",
        errorCode: "WORKBOOK_OR_PUBLISH_FAILED",
      });
    }
    return (await findOperationById(owned.operation.id)) ?? owned;
  }
  if (result.kind === "missing") {
    const deadline = owned.task.resultDeadlineAt;
    if (!deadline || Date.now() < deadline.getTime()) {
      await updateOperationState({
        operationId: owned.operation.id,
        taskId: owned.task.id,
        status: "result_pending",
        providerState: state,
        errorCode: null,
        resultDeadlineAt: deadline ?? new Date(Date.now() + RESULT_GRACE_MS),
      });
      return (await findOperationById(owned.operation.id)) ?? owned;
    }
  }
  const repair = await scheduleRepair({
    owned,
    codes:
      result.kind === "invalid" ? result.codes : ["STRUCTURED_OUTPUT_MISSING"],
    rejectedEventId: result.kind === "invalid" ? result.eventId : null,
  });
  if (!repair.exhausted) {
    await dispatchPendingRepair({
      owned,
      context: repair.context,
      credential,
    });
  }
  return (await findOperationById(owned.operation.id)) ?? owned;
}

export function projectBrandQuestionUniversePublicOperation(input: {
  status: OperationStatus;
  repairAttempts: number;
  publicationOutcome: OperationContext["publicationOutcome"];
  startedAt: number;
  updatedAt: number;
}) {
  return {
    status: input.status,
    repairAttempts: input.repairAttempts,
    publicationOutcome: input.publicationOutcome,
    startedAt: input.startedAt,
    updatedAt: input.updatedAt,
  };
}

function publicOperation(
  owned: OwnedOperation | undefined,
  context: OperationContext | null,
) {
  if (!owned) return null;
  return projectBrandQuestionUniversePublicOperation({
    status: owned.operation.status,
    repairAttempts: context?.repairAttempts ?? 0,
    publicationOutcome: context?.publicationOutcome ?? null,
    startedAt: owned.operation.createdAt.getTime(),
    updatedAt: owned.operation.updatedAt.getTime(),
  });
}

export async function observeBrandQuestionUniverse(actor: AuthenticatedUser) {
  assertCustomer(actor);
  let active = await findLatestOperation(actor.id, true);
  if (active) active = await reconcileOperation(active);
  const [snapshot, workspace, credential, latest] = await Promise.all([
    authenticatedSnapshot(actor.id),
    getDashboardWorkspace(actor.id),
    validPersonalCredential(actor.id),
    findLatestOperation(actor.id),
  ]);
  const operation = active ?? latest;
  const context = operation
    ? await readOperationContext(operation.task.id).catch(() => null)
    : null;
  const operationActive = Boolean(
    operation &&
      brandQuestionUniverseStatusFencesStart(operation.operation.status),
  );
  const engineerVersionPresent = !keywordTablesAreAutomaticallyManaged(
    workspace.payload.keywordTables,
  );
  const knowledgeReadiness = snapshot
    ? brandQuestionUniverseKnowledgeReadiness(
        classifyBrandQuestionUniverseKnowledgeDocuments(snapshot.documents),
      )
    : null;
  const reason = operationActive
    ? "operation_active"
    : !snapshot
      ? "knowledge_required"
      : !credential
        ? "credential_required"
        : engineerVersionPresent
          ? "engineer_version"
          : knowledgeReadiness && !knowledgeReadiness.ready
            ? knowledgeReadiness.reason
            : "ready";
  return {
    canStart: reason === "ready",
    reason,
    knowledgeSnapshotId: snapshot?.id ?? null,
    knowledgeVersion: snapshot?.version ?? null,
    dashboardRevision: workspace.revision,
    credentialReady: Boolean(credential),
    engineerVersionPresent,
    operation: publicOperation(operation, context),
  } as const;
}

export async function startBrandQuestionUniverse(input: {
  actor: AuthenticatedUser;
  value: z.infer<typeof brandQuestionUniverseStartInputSchema>;
}) {
  assertCustomer(input.actor);
  const value = brandQuestionUniverseStartInputSchema.parse(input.value);
  const replay = await findOperationByClientRequest(
    input.actor.id,
    value.clientRequestId,
  );
  if (replay) {
    assertIdempotentReplay({
      owned: replay,
      context: await readOperationContext(replay.task.id),
      value,
    });
    return observeBrandQuestionUniverse(input.actor);
  }
  const [snapshot, workspace, credential] = await Promise.all([
    authenticatedSnapshot(input.actor.id),
    getDashboardWorkspace(input.actor.id),
    validPersonalCredential(input.actor.id),
  ]);
  if (!snapshot || snapshot.id !== value.knowledgeSnapshotId) {
    throw new BrandQuestionUniverseServiceError(
      "KNOWLEDGE_SNAPSHOT_NOT_READY",
      412,
      "请先完成并发布当前认证知识库，再抓取品牌全域词库。",
    );
  }
  if (!credential) {
    throw new BrandQuestionUniverseServiceError(
      "CUSTOMER_CREDENTIAL_REQUIRED",
      412,
      "请先配置并验证当前客户账号的个人网站 AI 凭据。",
    );
  }
  if (workspace.revision !== value.expectedDashboardRevision) {
    throw new BrandQuestionUniverseServiceError(
      "DASHBOARD_REVISION_CONFLICT",
      409,
      "企业看板已更新，请刷新后重新抓取。",
    );
  }
  if (!keywordTablesAreAutomaticallyManaged(workspace.payload.keywordTables)) {
    throw new BrandQuestionUniverseServiceError(
      "ENGINEER_VERSION_PRESENT",
      409,
      "工程师正式词库已发布，自动抓取不会覆盖该版本。",
    );
  }
  if (!snapshot.archiveHash) {
    throw new BrandQuestionUniverseServiceError(
      "KNOWLEDGE_ARCHIVE_HASH_REQUIRED",
      412,
      "当前知识库缺少认证归档哈希，请重新发布知识库。",
    );
  }
  const classification = classifyBrandQuestionUniverseKnowledgeDocuments(
    snapshot.documents,
  );
  const knowledgeReadiness =
    brandQuestionUniverseKnowledgeReadiness(classification);
  if (!knowledgeReadiness.ready) {
    throw knowledgeReadinessError(knowledgeReadiness);
  }
  const operationId = deterministicUuid(
    `${BRAND_QUESTION_UNIVERSE_OPERATION_TYPE}:${input.actor.id}:${value.clientRequestId}`,
  );
  const operationToken = `brand-question-universe:${operationId}`;
  const runtimeContext: BrandQuestionUniverseRuntimeContext = {
    operationToken,
    brandName: workspace.payload.brandName.trim(),
    snapshot: {
      id: snapshot.id,
      version: snapshot.version,
      archiveHash: snapshot.archiveHash,
      sourceFileName: snapshot.sourceFileName,
      documents: snapshot.documents,
    },
  };
  const { upstream, adapter, knowledge } =
    await prepareBrandQuestionUniverseArchives({
      actorId: input.actor.id,
      runtimeContext,
      classification,
    });
  const context = operationContextSchema.parse({
    schemaVersion: 1,
    kind: "brand_question_universe_context",
    clientRequestId: value.clientRequestId,
    operationToken,
    knowledgeSnapshotId: snapshot.id,
    knowledgeSnapshotVersion: snapshot.version,
    knowledgeArchiveHash: snapshot.archiveHash,
    expectedDashboardRevision: value.expectedDashboardRevision,
    baselineKeywordTablesFingerprint: keywordTablesFingerprint(
      workspace.payload.keywordTables,
    ),
    brandName: runtimeContext.brandName,
    inputHashes: {
      upstream: upstream.contentHash,
      adapter: adapter.contentHash,
      knowledge: knowledge.contentHash,
    },
    firstDispatchState: "send_ready",
    firstDispatchReservedAtMs: null,
    repairAttempts: 0,
    repairState: "none",
    repairToken: null,
    repairReservedAtMs: null,
    repairErrors: [],
    lastRejectedEventId: null,
    resultArtifacts: null,
    workbookSha256: null,
    tableId: null,
    publicationOutcome: null,
    publishedDashboardRevision: null,
  });
  const requestHash = brandQuestionUniverseFrozenRequestHash(context);
  const reserved = await reserveOperation({
    actor: input.actor,
    credential,
    value,
    context,
    requestHash,
  });
  if (reserved.acquired) {
    await dispatchOperation({
      owned: reserved,
      credential,
      context,
      archives: { upstream, adapter, knowledge },
    });
  }
  return observeBrandQuestionUniverse(input.actor);
}

/**
 * Reconciles durable managed-user operations without needing an open browser.
 * Provider reads may run on more than one replica; repair sends and Dashboard
 * publication remain fenced by the context-row claim and revision CAS.
 */
export async function runBrandQuestionUniverseWorkerSweep(options?: {
  max?: number;
}) {
  const db = await getDb();
  if (!db) return { reconciled: 0, failed: 0 };
  const limit = Math.max(1, Math.min(options?.max ?? 10, 20));
  const candidates = await db
    .select({ operation: agentOperations, task: agentTasks })
    .from(agentOperations)
    .innerJoin(agentTasks, eq(agentTasks.operationId, agentOperations.id))
    .where(
      and(
        eq(agentOperations.scope, "managed_user"),
        eq(
          agentOperations.operationType,
          BRAND_QUESTION_UNIVERSE_OPERATION_TYPE,
        ),
        eq(
          agentOperations.contractName,
          BRAND_QUESTION_UNIVERSE_OPERATION_TYPE,
        ),
        eq(
          agentOperations.contractRevision,
          BRAND_QUESTION_UNIVERSE_CONTRACT_REVISION,
        ),
        inArray(agentOperations.status, [...ACTIVE_OPERATION_STATUSES]),
      ),
    )
    .orderBy(agentOperations.createdAt, agentOperations.id)
    .limit(limit);
  let reconciled = 0;
  let failed = 0;
  for (const candidate of candidates) {
    try {
      await reconcileOperation(candidate as OwnedOperation);
      reconciled += 1;
    } catch {
      // Transient provider/database failures stay retryable. A sweep never
      // invents a terminal operation state without a durable outcome.
      failed += 1;
    }
  }
  return { reconciled, failed };
}
