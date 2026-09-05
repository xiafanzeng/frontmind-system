import { createHash, randomUUID } from "node:crypto";
import { and, desc, eq, inArray, isNull, like, lt, max, or } from "drizzle-orm";
import {
  deliveryTickets,
  localAssets,
  messages,
  siteBuilds,
  siteDeployments,
  siteOperations,
  siteProjects,
  socialPackages,
  websiteStyleSampleBatches,
  websiteStyleSamples,
  workspaceSiteProfiles,
} from "../../drizzle/schema";
import { visualSearchOperationInputSchema } from "../../shared/siteops-workflow";
import {
  SITEOPS_VISUAL_CANDIDATE_MAX_PAGES,
  SITEOPS_VISUAL_CANDIDATE_MAX_TOTAL,
  SITEOPS_VISUAL_CANDIDATE_PAGE_SIZE,
} from "../../shared/siteops";
import { getDb } from "../db";
import { finalizePendingTwentyFirstCredentialRevocations } from "../twenty-first-service";
import { runtimeErrorForLog } from "../_core/runtime-error-log";
import {
  getSiteOpsProviderHandler,
  type SiteOpsProviderResult,
} from "./providers";
import { siteOpsQuotaStateForProviderResult } from "./quota-service";
import { publicSiteOpsProviderResult } from "./public-errors";
import {
  activateOneDeferredApprovedSiteOpsReset,
  advanceApprovedSiteOpsResetAfterDnsRollback,
  finalizeApprovedSiteOpsReset,
  parseApprovedResetUnpublishInput,
  siteOpsRebuildResetFencesExternalOperation,
} from "./rebuild-ticket";
import {
  approvedResetHasNoUnresolvedExternalExposure,
  parseApprovedResetSafeNoExposureProof,
} from "./esa-provider";
import {
  siteOpsTrustedFallbackPreviewFromResult,
  type SiteOpsTrustedFallbackPreview,
} from "./trusted-fallback";
import {
  formalBuildArtifactStagingSchema,
  type FormalBuildArtifactStaging,
} from "./build-artifact-checkpoint";

const DEFAULT_LEASE_MS = 2 * 60_000;
const DEFAULT_TIMEOUT_MS = 90_000;
const VISUAL_SEARCH_LEASE_MS = 15 * 60_000;
const VISUAL_SEARCH_TIMEOUT_MS = 12 * 60_000;
const BUILD_LEASE_MS = 12 * 60_000;
const BUILD_TIMEOUT_MS = 10 * 60_000;
const DEFAULT_BATCH = 4;

type Claimed = typeof siteOperations.$inferSelect & { leaseOwner: string };

const BUILD_ARTIFACT_KINDS = [
  "contract",
  "source",
  "dist",
  "qa",
  "provenance",
] as const;

type BuildArtifactKind = (typeof BUILD_ARTIFACT_KINDS)[number];
type BuildArtifactBinding = {
  id: string;
  sha256: string;
  bytes: number;
  mimeType: "application/json" | "application/zip";
};
type BuildArtifactBindings = Record<BuildArtifactKind, BuildArtifactBinding>;

const BUILD_ARTIFACT_MIME: Record<
  BuildArtifactKind,
  BuildArtifactBinding["mimeType"]
> = {
  contract: "application/json",
  source: "application/zip",
  dist: "application/zip",
  qa: "application/zip",
  provenance: "application/json",
};

const BUILD_ARTIFACT_STORAGE_KIND: Record<BuildArtifactKind, string> = {
  contract: "site-contract",
  source: "site-source",
  dist: "site-dist",
  qa: "site-qa",
  provenance: "site-provenance",
};

function workerArtifactError(code: string) {
  return Object.assign(new Error(code), { code });
}

function affectedRows(result: unknown) {
  return Number(
    (Array.isArray(result)
      ? (result[0] as { affectedRows?: unknown } | undefined)?.affectedRows
      : (result as { affectedRows?: unknown } | undefined)?.affectedRows) ?? 0,
  );
}

export function parseSiteOpsBuildArtifactBindings(
  value: unknown,
): BuildArtifactBindings {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw workerArtifactError("SITEOPS_BUILD_ARTIFACT_BINDINGS_MISSING");
  }
  const record = value as Record<string, unknown>;
  const result = {} as BuildArtifactBindings;
  const ids = new Set<string>();
  for (const kind of BUILD_ARTIFACT_KINDS) {
    const raw = record[kind];
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      throw workerArtifactError("SITEOPS_BUILD_ARTIFACT_BINDINGS_INVALID");
    }
    const binding = raw as Record<string, unknown>;
    const id = typeof binding.id === "string" ? binding.id : "";
    const sha256 =
      typeof binding.sha256 === "string"
        ? binding.sha256.trim().toLowerCase()
        : "";
    const bytes = Number(binding.bytes);
    const mimeType = binding.mimeType;
    if (
      !/^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/iu.test(
        id,
      ) ||
      !/^[a-f0-9]{64}$/u.test(sha256) ||
      !Number.isSafeInteger(bytes) ||
      bytes < 1 ||
      mimeType !== BUILD_ARTIFACT_MIME[kind] ||
      ids.has(id)
    ) {
      throw workerArtifactError("SITEOPS_BUILD_ARTIFACT_BINDINGS_INVALID");
    }
    ids.add(id);
    result[kind] = {
      id,
      sha256,
      bytes,
      mimeType: BUILD_ARTIFACT_MIME[kind],
    };
  }
  if (
    Object.keys(record).some(
      (key) => !BUILD_ARTIFACT_KINDS.includes(key as BuildArtifactKind),
    )
  ) {
    throw workerArtifactError("SITEOPS_BUILD_ARTIFACT_BINDINGS_INVALID");
  }
  return result;
}

export function siteOpsBuildArtifactProjection(input: {
  bindings: BuildArtifactBindings;
  rows: Array<{
    id: string;
    scope: string;
    accountUserId: number | null;
    presalesProjectId: string | null;
    mimeType: string;
    sizeBytes: number;
    contentSha256: string;
    storageKey: string;
  }>;
  userId: number;
  projectId: string;
}) {
  const rows = new Map(input.rows.map((row) => [row.id, row]));
  for (const kind of BUILD_ARTIFACT_KINDS) {
    const binding = input.bindings[kind];
    const row = rows.get(binding.id);
    if (
      !row ||
      row.scope !== "managed_user" ||
      row.accountUserId !== input.userId ||
      row.presalesProjectId !== null ||
      row.mimeType !== binding.mimeType ||
      row.sizeBytes !== binding.bytes ||
      row.contentSha256.toLowerCase() !== binding.sha256 ||
      row.storageKey !==
        `siteops:${input.projectId}:${BUILD_ARTIFACT_STORAGE_KIND[kind]}:${binding.id}`
    ) {
      throw workerArtifactError("SITEOPS_BUILD_ARTIFACT_VERIFICATION_FAILED");
    }
  }
  return {
    contractLocalAssetId: input.bindings.contract.id,
    contractHash: input.bindings.contract.sha256,
    sourceLocalAssetId: input.bindings.source.id,
    sourceHash: input.bindings.source.sha256,
    distLocalAssetId: input.bindings.dist.id,
    distHash: input.bindings.dist.sha256,
    qaLocalAssetId: input.bindings.qa.id,
    provenanceLocalAssetId: input.bindings.provenance.id,
  } as const;
}

export function exclusiveSiteOpsLiveHeadProjection(
  target: "global_excluding_cn" | "mainland_cn",
  deploymentId: string,
) {
  return {
    globalLiveDeploymentId:
      target === "global_excluding_cn" ? deploymentId : null,
    mainlandLiveDeploymentId: target === "mainland_cn" ? deploymentId : null,
  } as const;
}

export function siteOpsWorkerMayClaimStatus(status: string) {
  return status === "queued" || status === "running";
}

const APPROVED_RESET_AUTO_RECOVERY_CODES = new Set([
  "ESA_RUNTIME_DISABLED",
  "ESA_INSTANCE_NOT_CONFIGURED",
  "ESA_SERVICE_IDENTITY_NOT_CONFIGURED",
  "DATABASE_UNAVAILABLE",
  "PROVIDER_NOT_CONFIGURED",
]);

function pendingApprovedResetTicketNote(value: string | null | undefined) {
  if (!value) return null;
  try {
    const parsed = JSON.parse(value) as Record<string, unknown>;
    const allowedKeys = new Set([
      "schemaVersion",
      "kind",
      "projectId",
      "sourceBuildId",
      "knowledgeSnapshotId",
      "resetIntent",
      "resetOperationId",
      "resetApprovedAt",
      "resetExpectedProjectRevision",
      "minimumKnowledgeSnapshotVersion",
      "resetAppliedAt",
      "resetAppliedProjectRevision",
      "freshRootApplied",
      "unpublishOperationId",
      "resetEpochDecoupled",
      "frozenReset",
      "externalCleanupCompletedAt",
    ]);
    if (
      Object.keys(parsed).some((key) => !allowedKeys.has(key)) ||
      parsed.schemaVersion !== 4 ||
      parsed.kind !== "frontmind.siteops-rebuild.v1" ||
      typeof parsed.projectId !== "string" ||
      (parsed.sourceBuildId !== null &&
        typeof parsed.sourceBuildId !== "string") ||
      (parsed.knowledgeSnapshotId !== null &&
        typeof parsed.knowledgeSnapshotId !== "string") ||
      parsed.resetIntent !== "approved_reset_unpublish" ||
      typeof parsed.resetOperationId !== "string" ||
      typeof parsed.resetApprovedAt !== "string" ||
      !Number.isInteger(parsed.resetExpectedProjectRevision) ||
      Number(parsed.resetExpectedProjectRevision) < 1 ||
      !Number.isInteger(parsed.minimumKnowledgeSnapshotVersion) ||
      Number(parsed.minimumKnowledgeSnapshotVersion) < 1 ||
      (parsed.resetEpochDecoupled === true &&
        (typeof parsed.resetAppliedAt !== "string" ||
          !Number.isInteger(parsed.resetAppliedProjectRevision) ||
          Number(parsed.resetAppliedProjectRevision) < 1 ||
          parsed.freshRootApplied !== true ||
          parsed.unpublishOperationId !== parsed.resetOperationId ||
          !parseApprovedResetUnpublishInput(parsed.frozenReset) ||
          parsed.externalCleanupCompletedAt !== undefined))
    ) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

export function siteOpsApprovedResetMayAutoRecover(
  operation: typeof siteOperations.$inferSelect,
) {
  return Boolean(
    operation.kind === "rollback" &&
      operation.provider === "aliyun_esa" &&
      operation.status === "attention_required" &&
      typeof operation.errorCode === "string" &&
      APPROVED_RESET_AUTO_RECOVERY_CODES.has(operation.errorCode) &&
      operation.result === null &&
      operation.providerOperationId === null &&
      operation.providerTaskId === null &&
      parseApprovedResetUnpublishInput(operation.input),
  );
}

export function siteOpsWorkerExecutionPolicy(kind: string) {
  const isBuild = kind === "site_build" || kind === "build_revision";
  const isVisualSearch = kind === "visual_search";
  return {
    leaseMs: isBuild
      ? BUILD_LEASE_MS
      : isVisualSearch
        ? VISUAL_SEARCH_LEASE_MS
        : DEFAULT_LEASE_MS,
    timeoutMs: isBuild
      ? BUILD_TIMEOUT_MS
      : isVisualSearch
        ? VISUAL_SEARCH_TIMEOUT_MS
        : DEFAULT_TIMEOUT_MS,
  } as const;
}

export function terminalSiteOpsOperationProjection(
  locked: Pick<Claimed, "result" | "providerOperationId" | "providerTaskId">,
  result: SiteOpsProviderResult,
) {
  return {
    result: result.result ?? locked.result,
    providerOperationId:
      result.providerOperationId ?? locked.providerOperationId,
    providerTaskId: result.providerTaskId ?? locked.providerTaskId,
  };
}

export function siteOpsVisualOperationCoordinates(input: {
  operationInput: unknown;
  completePublishedPages: number;
}) {
  const parsed = visualSearchOperationInputSchema.safeParse(
    input.operationInput,
  );
  if (parsed.success && "schemaVersion" in parsed.data) {
    return {
      mode: parsed.data.mode,
      page: parsed.data.page,
      admissionRevision: parsed.data.admissionRevision,
    } as const;
  }
  return {
    mode:
      input.completePublishedPages > 0
        ? ("supplemental" as const)
        : ("initial" as const),
    page: Math.max(
      1,
      Math.min(
        SITEOPS_VISUAL_CANDIDATE_MAX_PAGES,
        input.completePublishedPages + 1,
      ),
    ) as 1 | 2 | 3,
    admissionRevision: null,
  } as const;
}

export function siteOpsSupplementalVisualFailureMayRecover(input: {
  mode: "initial" | "supplemental";
  completePublishedPages: number;
  projectStatus: string;
  projectRevision: number;
  admissionRevision: number | null;
  hasActiveVisualOperation: boolean;
  hasActiveBuild: boolean;
  errorCode: string;
}) {
  return (
    input.mode === "supplemental" &&
    input.completePublishedPages > 0 &&
    [
      "awaiting_visual_selection",
      "visual_searching",
      "failed",
      "attention_required",
    ].includes(input.projectStatus) &&
    (input.admissionRevision === null ||
      input.projectRevision === input.admissionRevision) &&
    !input.hasActiveVisualOperation &&
    !input.hasActiveBuild &&
    input.errorCode !== "VISUAL_SEARCH_SUPERSEDED"
  );
}

export function siteOpsInitialVisualSupersededMayStaySilent(input: {
  mode: "initial" | "supplemental";
  projectStatus: string;
  projectRevision: number;
  admissionRevision: number | null;
}) {
  if (input.mode !== "initial") return false;
  return (
    input.projectStatus !== "visual_searching" ||
    (input.admissionRevision !== null &&
      input.projectRevision !== input.admissionRevision)
  );
}

export function unexpectedSiteOpsProviderFailure(): SiteOpsProviderResult {
  return failureResult(
    "attention_required",
    "PROVIDER_ERROR",
    "外部服务操作未能安全完成，请根据错误码和任务编号联系处理。",
  );
}

export function knownSiteOpsBuildFailure(
  error: unknown,
): SiteOpsProviderResult | null {
  if (!error || typeof error !== "object") return null;
  const code = String((error as { code?: unknown }).code ?? "").trim();
  if (!/^FRONTMIND_BUILD_[A-Z_]+$/u.test(code)) return null;
  const requestedStatus = String((error as { status?: unknown }).status ?? "");
  const status =
    requestedStatus === "attention_required" ||
    code === "FRONTMIND_BUILD_CONFIGURATION_ERROR"
      ? "attention_required"
      : "failed";
  return {
    status,
    code,
    message:
      error instanceof Error && error.message.trim()
        ? error.message
        : "本次没有生成可安全展示的版本；可申请重置，批准后可从当前企业知识库重新开始。",
  };
}

type PublicBuildStage = "design_compiling" | "content_building" | "qa_running";

type ProviderBuildStatus =
  | "design_compiling"
  | "contract_ready"
  | "building"
  | "qa_running"
  | "preview_ready"
  | "approved";

function publicBuildStage(status: ProviderBuildStatus) {
  if (status === "design_compiling") return "design_compiling" as const;
  if (status === "contract_ready" || status === "building") {
    return "content_building" as const;
  }
  if (status === "qa_running") return "qa_running" as const;
  return null;
}

const PUBLIC_BUILD_STAGE_LABELS: Record<PublicBuildStage, string> = {
  design_compiling: "设计合同生成",
  content_building: "页面内容生成",
  qa_running: "质量校验",
};

export async function appendBuildTimelineEvent(
  tx: any,
  input: {
    operation: Claimed;
    buildStatus: ProviderBuildStatus;
    now: Date;
  },
) {
  if (!input.operation.buildId) return;
  const stage = publicBuildStage(input.buildStatus);
  if (!stage) return;
  const projectRows = await tx
    .select({
      conversationId: siteProjects.conversationId,
      revision: siteProjects.revision,
    })
    .from(siteProjects)
    .where(eq(siteProjects.id, input.operation.projectId))
    .limit(1);
  const project = projectRows[0];
  if (!project) return;
  const existingRows = await tx
    .select({ metadata: messages.metadata })
    .from(messages)
    .where(eq(messages.conversationId, project.conversationId))
    .orderBy(desc(messages.sequence))
    .limit(500);
  const duplicate = existingRows.some((row: { metadata: unknown }) => {
    const metadata = (row.metadata ?? {}) as Record<string, unknown>;
    const siteOps = (metadata.siteOps ?? {}) as Record<string, unknown>;
    const payload = (siteOps.payload ?? {}) as Record<string, unknown>;
    return (
      siteOps.subjectId === input.operation.id &&
      (payload.visibility === "timeline" || payload.timelineOnly === true) &&
      payload.stage === stage &&
      payload.buildId === input.operation.buildId
    );
  });
  if (duplicate) return;
  const sequenceRows = await tx
    .select({ sequence: max(messages.sequence) })
    .from(messages)
    .where(eq(messages.conversationId, project.conversationId));
  await tx.insert(messages).values({
    id: randomUUID(),
    conversationId: project.conversationId,
    userId: input.operation.userId,
    role: "assistant",
    content: PUBLIC_BUILD_STAGE_LABELS[stage],
    sequence: Number(sequenceRows[0]?.sequence ?? 0) + 1,
    metadata: {
      siteOps: {
        kind: "build_progress",
        subjectId: input.operation.id,
        revision: project.revision,
        status: "active",
        payload: {
          visibility: "timeline",
          timelineOnly: true,
          stage,
          buildId: input.operation.buildId,
          occurredAt: input.now.toISOString(),
        },
      },
    },
  });
}

async function claimOne(db: any): Promise<Claimed | null> {
  return db.transaction(async (tx: any) => {
    const now = new Date();
    const rows = await tx
      .select()
      .from(siteOperations)
      .where(
        or(
          eq(siteOperations.status, "queued"),
          and(
            eq(siteOperations.status, "running"),
            or(
              isNull(siteOperations.leaseExpiresAt),
              lt(siteOperations.leaseExpiresAt, now),
            ),
          ),
        ),
      )
      .orderBy(siteOperations.createdAt)
      .limit(1)
      .for("update", { skipLocked: true });
    const operation = rows[0];
    if (!operation || !siteOpsWorkerMayClaimStatus(operation.status)) {
      return null;
    }
    const leaseOwner = randomUUID();
    const executionPolicy = siteOpsWorkerExecutionPolicy(operation.kind);
    const leaseExpiresAt = new Date(now.getTime() + executionPolicy.leaseMs);
    await tx
      .update(siteOperations)
      .set({
        status: "running",
        leaseOwner,
        leaseExpiresAt,
        attempt: operation.attempt + 1,
        startedAt: operation.startedAt ?? now,
        updatedAt: now,
      })
      .where(
        and(
          eq(siteOperations.id, operation.id),
          eq(siteOperations.status, operation.status),
        ),
      );
    return {
      ...operation,
      status: "running",
      leaseOwner,
      leaseExpiresAt,
    };
  });
}

async function requeueOneSafeApprovedReset(db: any) {
  const candidates = await db
    .select()
    .from(siteOperations)
    .where(
      and(
        eq(siteOperations.kind, "rollback"),
        eq(siteOperations.provider, "aliyun_esa"),
        eq(siteOperations.status, "attention_required"),
        inArray(
          siteOperations.errorCode,
          Array.from(APPROVED_RESET_AUTO_RECOVERY_CODES),
        ),
        isNull(siteOperations.result),
        isNull(siteOperations.providerOperationId),
        isNull(siteOperations.providerTaskId),
      ),
    )
    .orderBy(siteOperations.updatedAt)
    // Scan a bounded but wide window. A four-row window allowed a handful of
    // genuinely exposed projects to starve every later safe no-exposure reset
    // forever because those blocked rows never leave attention_required.
    .limit(128);
  for (const candidate of candidates) {
    if (!siteOpsApprovedResetMayAutoRecover(candidate)) continue;
    const recoveryErrorCode = candidate.errorCode;
    const requeued = await db.transaction(async (tx: any) => {
      const operationRows = await tx
        .select()
        .from(siteOperations)
        .where(eq(siteOperations.id, candidate.id))
        .limit(1)
        .for("update");
      const operation = operationRows[0];
      if (!operation || !siteOpsApprovedResetMayAutoRecover(operation)) {
        return false;
      }
      const reset = parseApprovedResetUnpublishInput(operation.input);
      if (!reset) return false;
      const ticketRows = await tx
        .select()
        .from(deliveryTickets)
        .where(
          and(
            eq(deliveryTickets.id, reset.rebuildTicketId),
            eq(deliveryTickets.userId, operation.userId),
            eq(deliveryTickets.operation, "site_rebuild"),
          ),
        )
        .limit(1)
        .for("update");
      const ticket = ticketRows[0];
      const note = pendingApprovedResetTicketNote(ticket?.internalNote);
      if (
        !ticket ||
        !["scheduled", "in_progress"].includes(ticket.status) ||
        !note ||
        note.projectId !== operation.projectId ||
        note.resetOperationId !== operation.id ||
        note.resetExpectedProjectRevision !== reset.expectedProjectRevision
      ) {
        return false;
      }
      let safe: Awaited<
        ReturnType<typeof approvedResetHasNoUnresolvedExternalExposure>
      > = null;
      try {
        safe = await approvedResetHasNoUnresolvedExternalExposure({
          db: tx,
          operation,
          reset,
          // A residual hostname alone is not a control-plane mutation
          // boundary. Requeueing is safe because the disabled-runtime
          // provider performs only the pinned 404/410 marker check.
          allowCanonicalHostname: true,
          allowMigration0065RevisionDrift: true,
        });
      } catch (error) {
        const code =
          error && typeof error === "object"
            ? (error as { code?: unknown }).code
            : null;
        if (code !== "SITEOPS_RESET_INVALIDATED") throw error;
        // The helper validates the frozen project coordinates before any
        // provider call. Persist that terminal classification on the same
        // operation so the ticket projection can leave "处理中" without ever
        // invoking ESA or creating a replacement operation.
        const invalidatedUpdate = await tx
          .update(siteOperations)
          .set({
            status: "failed",
            errorCode: "SITEOPS_RESET_INVALIDATED",
            errorMessage: "官网重置坐标已变化，未执行外部下线操作。",
            leaseOwner: null,
            leaseExpiresAt: null,
            completedAt: new Date(),
            updatedAt: new Date(),
          })
          .where(
            and(
              eq(siteOperations.id, operation.id),
              eq(siteOperations.status, "attention_required"),
              eq(siteOperations.errorCode, operation.errorCode!),
              eq(siteOperations.attempt, operation.attempt),
              isNull(siteOperations.result),
              isNull(siteOperations.providerOperationId),
              isNull(siteOperations.providerTaskId),
            ),
          );
        if (affectedRows(invalidatedUpdate) !== 1) return false;
        return false;
      }
      if (!safe) return false;
      const updated = await tx
        .update(siteOperations)
        .set({
          status: "queued",
          leaseOwner: null,
          leaseExpiresAt: null,
          errorCode: null,
          errorMessage: null,
          completedAt: null,
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(siteOperations.id, operation.id),
            eq(siteOperations.status, "attention_required"),
            eq(siteOperations.errorCode, operation.errorCode!),
            eq(siteOperations.attempt, operation.attempt),
            isNull(siteOperations.result),
            isNull(siteOperations.providerOperationId),
            isNull(siteOperations.providerTaskId),
          ),
        );
      return affectedRows(updated) === 1;
    });
    if (requeued) {
      console.info("[SiteOpsWorker] approved_reset_requeued", {
        event: "siteops_approved_reset_requeued",
        operationId: candidate.id,
        projectId: candidate.projectId,
        errorCode: recoveryErrorCode,
      });
      return true;
    }
  }
  return false;
}

function failureResult<
  TStatus extends "failed" | "attention_required" | "outcome_unknown",
>(
  status: TStatus,
  code: string,
  message: string,
): { status: TStatus; code: string; message: string } {
  return { status, code, message };
}

function isAliyunExternalWriteOperation(input: {
  kind: string;
  provider: string | null;
}) {
  return (
    (input.provider === "aliyun_esa" &&
      ["deploy", "rollback", "dns_apply"].includes(input.kind)) ||
    (input.provider === "aliyun_alidns" &&
      ["domain_sync", "dns_apply", "dns_rollback"].includes(input.kind))
  );
}

export function siteOpsExternalOperationPredatesResetEpoch(input: {
  operation: Pick<
    Claimed,
    "id" | "projectId" | "kind" | "provider" | "input" | "createdAt"
  >;
  currentTaskStartedAt: Date;
  projectRevision?: number;
  pendingResetNotes?: Array<string | null>;
}) {
  const exactResetFence =
    input.projectRevision !== undefined &&
    input.pendingResetNotes?.some((note) =>
      siteOpsRebuildResetFencesExternalOperation(note, {
        projectId: input.operation.projectId,
        operationId: input.operation.id,
        projectRevision: input.projectRevision!,
        currentTaskStartedAt: input.currentTaskStartedAt,
      }),
    );
  return Boolean(
    isAliyunExternalWriteOperation(input.operation) &&
      !approvedResetFromOperationInput(input.operation.input) &&
      (input.operation.createdAt.getTime() <
        input.currentTaskStartedAt.getTime() ||
        exactResetFence),
  );
}

async function operationPredatesCurrentResetEpoch(tx: any, operation: Claimed) {
  if (
    !isAliyunExternalWriteOperation(operation) ||
    approvedResetFromOperationInput(operation.input)
  ) {
    return false;
  }
  const projectRows = await tx
    .select({
      revision: siteProjects.revision,
      currentTaskStartedAt: siteProjects.currentTaskStartedAt,
    })
    .from(siteProjects)
    .where(
      and(
        eq(siteProjects.id, operation.projectId),
        eq(siteProjects.userId, operation.userId),
      ),
    )
    .limit(1);
  const project = projectRows[0];
  const resetEpoch = project?.currentTaskStartedAt;
  if (!resetEpoch) return false;
  if (operation.createdAt.getTime() < resetEpoch.getTime()) return true;
  if (operation.createdAt.getTime() !== resetEpoch.getTime()) return false;
  const pendingTicketRows = await tx
    .select({ internalNote: deliveryTickets.internalNote })
    .from(deliveryTickets)
    .where(
      and(
        eq(deliveryTickets.userId, operation.userId),
        eq(deliveryTickets.operation, "site_rebuild"),
        inArray(deliveryTickets.status, ["scheduled", "in_progress"]),
        like(deliveryTickets.internalNote, `%${operation.id}%`),
      ),
    )
    .orderBy(desc(deliveryTickets.updatedAt))
    .limit(8);
  return Boolean(
    project &&
      siteOpsExternalOperationPredatesResetEpoch({
        operation,
        currentTaskStartedAt: resetEpoch,
        projectRevision: project.revision,
        pendingResetNotes: pendingTicketRows.map(
          (ticket: { internalNote: string | null }) => ticket.internalNote,
        ),
      }),
  );
}

async function assertClaimLeaseActive(db: any, operation: Claimed) {
  const rows = await db
    .select({
      id: siteOperations.id,
      leaseExpiresAt: siteOperations.leaseExpiresAt,
    })
    .from(siteOperations)
    .where(
      and(
        eq(siteOperations.id, operation.id),
        eq(siteOperations.status, "running"),
        eq(siteOperations.leaseOwner, operation.leaseOwner),
      ),
    )
    .limit(1);
  if (!rows[0] || rows[0].leaseExpiresAt === null) {
    throw new Error("SITEOPS_OPERATION_LEASE_LOST");
  }
  if (rows[0].leaseExpiresAt.getTime() <= Date.now()) {
    throw new Error("SITEOPS_OPERATION_LEASE_EXPIRED");
  }
}

async function invokeProvider(db: any, operation: Claimed) {
  if (approvedResetFromOperationInput(operation.input)) {
    const activeProviderRows = await db
      .select({ id: siteOperations.id })
      .from(siteOperations)
      .where(
        and(
          eq(siteOperations.projectId, operation.projectId),
          inArray(siteOperations.provider, ["aliyun_esa", "aliyun_alidns"]),
          inArray(siteOperations.status, [
            "queued",
            "running",
            "outcome_unknown",
          ]),
        ),
      )
      .limit(20);
    if (
      activeProviderRows.some((row: { id: string }) => row.id !== operation.id)
    ) {
      return {
        status: "pending" as const,
        result: operation.result ?? undefined,
        nextPollMs: 15_000,
      };
    }
  }
  const handler = getSiteOpsProviderHandler(operation.provider);
  if (!handler) {
    return failureResult(
      "attention_required",
      "PROVIDER_NOT_CONFIGURED",
      `${operation.provider ?? "SiteOps"} 适配器尚未配置；未伪造外部成功结果。`,
    );
  }
  const controller = new AbortController();
  const executionPolicy = siteOpsWorkerExecutionPolicy(operation.kind);
  const timeout = setTimeout(
    () => controller.abort(),
    executionPolicy.timeoutMs,
  );
  timeout.unref?.();
  try {
    await assertClaimLeaseActive(db, operation);
    return await handler({
      operation,
      signal: controller.signal,
      assertLeaseActive: () => assertClaimLeaseActive(db, operation),
    });
  } catch (error) {
    if (controller.signal.aborted) {
      if (operation.kind === "visual_search") {
        return failureResult(
          "failed",
          "VISUAL_SEARCH_TIMEOUT",
          "视觉候选生成已超时，请稍后重试。",
        );
      }
      return failureResult(
        "outcome_unknown",
        "PROVIDER_TIMEOUT",
        "外部操作超时，结果未知；系统只会查询对账，不会盲目重发。",
      );
    }
    console.error("[SiteOpsWorker] provider_failed", {
      operationId: operation.id,
      projectId: operation.projectId,
      provider: operation.provider,
      error: runtimeErrorForLog(error),
    });
    return (
      knownSiteOpsBuildFailure(error) ?? unexpectedSiteOpsProviderFailure()
    );
  } finally {
    clearTimeout(timeout);
  }
}

function approvedResetFromOperationInput(value: unknown) {
  const direct = parseApprovedResetUnpublishInput(value);
  if (direct) return direct;
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return parseApprovedResetUnpublishInput(
    (value as Record<string, unknown>).approvedReset,
  );
}

export function siteOpsDeterministicSuccessorId(
  parentId: string,
  stage: string,
) {
  const bytes = createHash("sha256")
    .update("frontmind.siteops-successor.v1\0", "utf8")
    .update(parentId, "utf8")
    .update("\0", "utf8")
    .update(stage, "utf8")
    .digest()
    .subarray(0, 16);
  bytes[6] = (bytes[6] & 0x0f) | 0x50;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

async function enqueueSuccessor(
  tx: any,
  parent: Claimed,
  input: {
    stage: string;
    kind: "dns_apply" | "dns_rollback" | "rollback";
    provider: "aliyun_alidns" | "aliyun_esa";
    payload: Record<string, unknown>;
  },
) {
  const id = siteOpsDeterministicSuccessorId(parent.id, input.stage);
  const existing = await tx
    .select({ id: siteOperations.id })
    .from(siteOperations)
    .where(
      and(
        eq(siteOperations.projectId, parent.projectId),
        eq(siteOperations.clientRequestId, id),
      ),
    )
    .limit(1);
  if (existing[0]) return existing[0].id;
  const inputHash = createHash("sha256")
    .update(JSON.stringify(input.payload), "utf8")
    .digest("hex");
  const now = new Date();
  await tx.insert(siteOperations).values({
    id,
    projectId: parent.projectId,
    userId: parent.userId,
    conversationTurnId: parent.conversationTurnId,
    buildId: null,
    kind: input.kind,
    status: "queued",
    clientRequestId: id,
    inputHash,
    input: input.payload,
    provider: input.provider,
    attempt: 0,
    createdAt: now,
    updatedAt: now,
  });
  return id;
}

export async function enqueueAutomaticDomainSuccessor(
  tx: any,
  operation: Claimed,
  result: Extract<SiteOpsProviderResult, { status: "succeeded" }>,
  now: Date,
) {
  const operationInput =
    operation.input && typeof operation.input === "object"
      ? (operation.input as Record<string, unknown>)
      : {};
  const resultData = result.result ?? {};
  const connectionId = String(operationInput.connectionId ?? "");
  const domain = String(resultData.domain ?? operationInput.domain ?? "");
  const domainRevision = Number(
    resultData.domainRevision ??
      resultData.revision ??
      operationInput.domainRevision,
  );
  if (
    operation.kind === "domain_sync" &&
    operation.provider === "aliyun_alidns" &&
    connectionId &&
    domain &&
    Number.isInteger(domainRevision) &&
    domainRevision > 0
  ) {
    await enqueueSuccessor(tx, operation, {
      stage: "domain-sync:esa-prepare",
      kind: "dns_apply",
      provider: "aliyun_esa",
      payload: {
        prepareDomainBinding: true,
        domain,
        domainRevision,
        connectionId,
      },
    });
    return;
  }
  if (
    operation.kind === "dns_apply" &&
    operation.provider === "aliyun_esa" &&
    ["esa_site_verification_dns_ready", "esa_cname_ready"].includes(
      String(resultData.phase ?? ""),
    ) &&
    connectionId &&
    Number.isInteger(domainRevision) &&
    domainRevision > 0
  ) {
    await enqueueSuccessor(tx, operation, {
      stage: `${String(resultData.phase)}:dns-plan`,
      kind: "dns_apply",
      provider: "aliyun_alidns",
      payload: {
        connectionId,
        domainRevision,
        dnsIntent: "plan",
      },
    });
    return;
  }
  if (
    operation.kind === "dns_apply" &&
    operation.provider === "aliyun_alidns" &&
    operationInput.dnsIntent === "plan" &&
    resultData.canApply === true &&
    connectionId &&
    Number.isInteger(domainRevision) &&
    domainRevision > 0 &&
    typeof resultData.planHash === "string" &&
    typeof resultData.providerSnapshotHash === "string"
  ) {
    await enqueueSuccessor(tx, operation, {
      stage: "dns-plan:apply",
      kind: "dns_apply",
      provider: "aliyun_alidns",
      payload: {
        connectionId,
        domainRevision,
        dnsIntent: "apply",
        planOperationId: operation.id,
        planHash: resultData.planHash,
        providerSnapshotHash: resultData.providerSnapshotHash,
      },
    });
    return;
  }
  if (
    operation.kind === "dns_apply" &&
    operation.provider === "aliyun_alidns" &&
    operationInput.dnsIntent === "apply" &&
    connectionId
  ) {
    const profileRows = await tx
      .select({
        domain: workspaceSiteProfiles.normalizedAsciiDomain,
        revision: workspaceSiteProfiles.domainRevision,
        dnsStatus: workspaceSiteProfiles.dnsStatus,
      })
      .from(workspaceSiteProfiles)
      .where(eq(workspaceSiteProfiles.userId, operation.userId))
      .limit(1);
    const profile = profileRows[0];
    if (
      profile?.dnsStatus === "pending_esa_binding" &&
      profile.domain &&
      profile.revision === domainRevision
    ) {
      await enqueueSuccessor(tx, operation, {
        stage: "dns-apply:esa-followup",
        kind: "dns_apply",
        provider: "aliyun_esa",
        payload: {
          prepareDomainBinding: true,
          domain: profile.domain,
          domainRevision: profile.revision,
          connectionId,
        },
      });
    }
    return;
  }
  const approvedReset = approvedResetFromOperationInput(operation.input);
  if (
    operation.kind === "dns_rollback" &&
    operation.provider === "aliyun_alidns" &&
    operationInput.dnsIntent === "rollback" &&
    approvedReset
  ) {
    const successorId = await enqueueSuccessor(tx, operation, {
      stage: "approved-reset:esa-unpublish",
      kind: "rollback",
      provider: "aliyun_esa",
      payload: approvedReset,
    });
    await advanceApprovedSiteOpsResetAfterDnsRollback(tx, {
      operation,
      successorOperationId: successorId,
      now,
    });
  }
}

function stagedBuildCheckpointResult(
  operation: Claimed,
): SiteOpsProviderResult | null {
  if (
    operation.provider !== "manus" ||
    !operation.buildId ||
    !["site_build", "build_revision"].includes(operation.kind) ||
    !operation.result ||
    typeof operation.result !== "object" ||
    Array.isArray(operation.result)
  ) {
    return null;
  }
  const checkpoint = operation.result as Record<string, unknown>;
  const attention = (): SiteOpsProviderResult => ({
    status: "attention_required",
    code: "FRONTMIND_BUILD_ARTIFACT_CHECKPOINT_INVALID",
    message: "官网产物恢复坐标未通过一致性校验，已保留任务与产物等待处理。",
    providerTaskId: operation.providerTaskId ?? undefined,
    result: checkpoint,
  });
  const formalDeclared = checkpoint.artifactStaging !== undefined;
  const fallbackDeclared = checkpoint.fallbackPreview !== undefined;
  const fallback = fallbackDeclared
    ? siteOpsTrustedFallbackPreviewFromResult(checkpoint)
    : null;
  if (fallbackDeclared && !fallback) return attention();

  if (!formalDeclared) {
    if (fallback?.status === "staged") {
      // Finalize owns the existing fallback_bind transaction. Feed it the
      // durable pending marker directly without a provider read.
      return {
        status: "pending",
        providerTaskId: fallback.taskId ?? undefined,
        buildStatus: "qa_running",
        nextPollMs: 10_000,
        result: checkpoint,
      };
    }
    // A bound fallback keeps reconciling the same provider task; the provider
    // may later return a formal result. A legacy/no-marker state also remains
    // on the ordinary provider path.
    return null;
  }
  if (fallback?.status === "staged") return attention();
  if (checkpoint.buildCheckpoint !== "artifacts_staged") return attention();
  const parsed = formalBuildArtifactStagingSchema.safeParse(
    checkpoint.artifactStaging,
  );
  const staging = parsed.success ? parsed.data : null;
  const expectedTaskId = operation.providerTaskId;
  const expectedAttempt = staging?.nativeRepairAttempt;
  const expectedOperationToken =
    expectedAttempt === undefined
      ? null
      : `siteops-native-source:${operation.id}:${expectedAttempt}`;
  const leaseExpiresAt = operation.leaseExpiresAt?.getTime() ?? Number.NaN;
  if (
    !staging ||
    checkpoint.schemaVersion !== 2 ||
    checkpoint.buildPhase !== "persisting_preview" ||
    checkpoint.taskId !== staging.taskId ||
    checkpoint.nativeRepairAttempt !== staging.nativeRepairAttempt ||
    staging.projectId !== operation.projectId ||
    staging.buildId !== operation.buildId ||
    !expectedTaskId ||
    staging.taskId !== expectedTaskId ||
    staging.operationToken !== expectedOperationToken ||
    Date.parse(staging.expiresAt) <= Date.now() ||
    operation.status !== "running" ||
    !operation.leaseOwner ||
    !Number.isFinite(leaseExpiresAt) ||
    leaseExpiresAt <= Date.now()
  ) {
    return attention();
  }
  const bindings = staging.artifactBindings;
  return {
    status: "succeeded",
    providerTaskId: staging.taskId,
    projectStatus: "preview_ready",
    buildStatus: "preview_ready",
    result: {
      buildId: staging.buildId,
      buildCheckpoint: "artifacts_staged",
      buildCheckpoints: [
        "receipt_validated",
        "archive_downloaded",
        "archive_validated",
        "compile_started",
        "artifacts_staged",
      ],
      specHash: staging.specHash,
      distHash: staging.distHash,
      buildDelivery: staging.buildDelivery,
      qaSummary: staging.qaSummary,
      artifactIds: Object.fromEntries(
        BUILD_ARTIFACT_KINDS.map((kind) => [kind, bindings[kind].id]),
      ),
      artifactBindings: bindings,
      artifactStaging: staging,
      ...(fallback?.status === "bound" ? { fallbackPreview: fallback } : {}),
      artifactCheckpointResume: true,
    },
    message: "FrontMind 静态官网已完成构建和 QA，可以在私有预览中检查并批准。",
  };
}

function fallbackMarkerFromOperationResult(result: unknown) {
  return siteOpsTrustedFallbackPreviewFromResult(result);
}

function fallbackMarkerMatchesOperation(input: {
  marker: SiteOpsTrustedFallbackPreview;
  operation: Claimed;
  buildId: string;
  taskId: string | null;
}) {
  const allowedOperationTokens = new Set([
    `siteops-native-fallback:${input.operation.id}`,
    `siteops-content-baseline:${input.operation.id}`,
  ]);
  return (
    input.marker.buildId === input.buildId &&
    (input.marker.taskId === null || input.marker.taskId === input.taskId) &&
    allowedOperationTokens.has(input.marker.operationToken)
  );
}

type BuildArtifactVerification = {
  projection: ReturnType<typeof siteOpsBuildArtifactProjection>;
  mode: "initial" | "fallback_bind" | "formal_upgrade";
};

async function verifiedBuildArtifactProjection(
  tx: any,
  operation: Claimed,
  result: Extract<SiteOpsProviderResult, { status: "succeeded" | "pending" }>,
): Promise<BuildArtifactVerification | null> {
  if (
    !operation.buildId ||
    !["site_build", "build_revision"].includes(operation.kind)
  ) {
    return null;
  }
  const buildRows = await tx
    .select()
    .from(siteBuilds)
    .where(
      and(
        eq(siteBuilds.id, operation.buildId),
        eq(siteBuilds.projectId, operation.projectId),
        eq(siteBuilds.userId, operation.userId),
      ),
    )
    .limit(1)
    .for("update");
  const build = buildRows[0];
  const rawArtifactStaging = result.result?.artifactStaging;
  const parsedArtifactStaging = rawArtifactStaging
    ? formalBuildArtifactStagingSchema.safeParse(rawArtifactStaging)
    : null;
  if (parsedArtifactStaging && !parsedArtifactStaging.success) {
    throw workerArtifactError("SITEOPS_BUILD_ARTIFACT_CHECKPOINT_INVALID");
  }
  const artifactStaging: FormalBuildArtifactStaging | null =
    parsedArtifactStaging?.success ? parsedArtifactStaging.data : null;
  const pendingFallback =
    result.status === "pending"
      ? fallbackMarkerFromOperationResult(result.result)
      : null;
  const boundFallback = fallbackMarkerFromOperationResult(operation.result);
  const fallbackBind = pendingFallback?.status === "staged";
  const formalUpgrade =
    result.status === "succeeded" && boundFallback?.status === "bound";
  if (!build || build.status !== "qa_running") {
    throw workerArtifactError("SITEOPS_BUILD_ARTIFACT_BINDING_CONFLICT");
  }
  if (
    artifactStaging &&
    (artifactStaging.projectId !== operation.projectId ||
      artifactStaging.buildId !== operation.buildId ||
      artifactStaging.knowledgeSnapshotId !== build.knowledgeSnapshotId ||
      artifactStaging.taskId !== operation.providerTaskId ||
      artifactStaging.taskId !== build.upstreamManusTaskId ||
      artifactStaging.taskId !== result.providerTaskId ||
      artifactStaging.operationToken !==
        `siteops-native-source:${operation.id}:${artifactStaging.nativeRepairAttempt}` ||
      Date.parse(artifactStaging.expiresAt) <= Date.now())
  ) {
    throw workerArtifactError("SITEOPS_BUILD_ARTIFACT_CHECKPOINT_INVALID");
  }
  if (
    build.upstreamManusTaskId !==
    (result.providerTaskId ?? operation.providerTaskId)
  ) {
    throw workerArtifactError("SITEOPS_BUILD_ARTIFACT_BINDING_CONFLICT");
  }
  const expectedTaskId = result.providerTaskId ?? operation.providerTaskId;
  if (
    (pendingFallback &&
      !fallbackMarkerMatchesOperation({
        marker: pendingFallback,
        operation,
        buildId: build.id,
        taskId: expectedTaskId,
      })) ||
    (boundFallback &&
      !fallbackMarkerMatchesOperation({
        marker: boundFallback,
        operation,
        buildId: build.id,
        taskId: expectedTaskId,
      }))
  ) {
    throw workerArtifactError("SITEOPS_BUILD_ARTIFACT_BINDING_CONFLICT");
  }
  if (fallbackBind || formalUpgrade) {
    const projectRows = await tx
      .select()
      .from(siteProjects)
      .where(eq(siteProjects.id, operation.projectId))
      .limit(1)
      .for("update");
    const project = projectRows[0];
    if (
      !project ||
      project.currentBuildId !== build.id ||
      project.currentKnowledgeSnapshotId !== build.knowledgeSnapshotId ||
      project.status !== "building" ||
      build.parentBuildId !== null
    ) {
      throw workerArtifactError("SITEOPS_BUILD_ARTIFACT_BINDING_CONFLICT");
    }
  }
  const allCurrentNull =
    build.contractLocalAssetId === null &&
    build.sourceLocalAssetId === null &&
    build.distLocalAssetId === null &&
    build.qaLocalAssetId === null &&
    build.provenanceLocalAssetId === null;
  if (fallbackBind) {
    if (
      build.parentBuildId !== null ||
      build.quotaState !== "reserved" ||
      !allCurrentNull
    ) {
      throw workerArtifactError("SITEOPS_BUILD_ARTIFACT_BINDING_CONFLICT");
    }
  } else if (formalUpgrade) {
    const fallback = boundFallback!.artifactBindings;
    const fallbackMatches =
      build.contractLocalAssetId === fallback.contract.id &&
      build.contractHash === fallback.contract.sha256 &&
      build.sourceLocalAssetId === fallback.source.id &&
      build.sourceHash === fallback.source.sha256 &&
      build.distLocalAssetId === fallback.dist.id &&
      build.distHash === fallback.dist.sha256 &&
      build.qaLocalAssetId === fallback.qa.id &&
      build.provenanceLocalAssetId === fallback.provenance.id;
    const delivery = result.result?.buildDelivery as
      | Record<string, unknown>
      | undefined;
    const expectedFormalRenderMode = boundFallback!.operationToken.startsWith(
      "siteops-content-baseline:",
    )
      ? "content_patch"
      : "twenty_first_native";
    if (!fallbackMatches || delivery?.renderMode !== expectedFormalRenderMode) {
      throw workerArtifactError("SITEOPS_BUILD_ARTIFACT_BINDING_CONFLICT");
    }
  } else if (!allCurrentNull) {
    throw workerArtifactError("SITEOPS_BUILD_ARTIFACT_BINDING_CONFLICT");
  }
  const bindings = fallbackBind
    ? pendingFallback!.artifactBindings
    : parseSiteOpsBuildArtifactBindings(result.result?.artifactBindings);
  if (
    artifactStaging &&
    BUILD_ARTIFACT_KINDS.some((kind) => {
      const staged = artifactStaging.artifactBindings[kind];
      const binding = bindings[kind];
      return (
        staged.id !== binding.id ||
        staged.sha256 !== binding.sha256 ||
        staged.bytes !== binding.bytes ||
        staged.mimeType !== binding.mimeType
      );
    })
  ) {
    throw workerArtifactError("SITEOPS_BUILD_ARTIFACT_CHECKPOINT_INVALID");
  }
  const ids = BUILD_ARTIFACT_KINDS.map((kind) => bindings[kind].id);
  const rows = await tx
    .select({
      id: localAssets.id,
      scope: localAssets.scope,
      accountUserId: localAssets.accountUserId,
      presalesProjectId: localAssets.presalesProjectId,
      mimeType: localAssets.mimeType,
      sizeBytes: localAssets.sizeBytes,
      contentSha256: localAssets.contentSha256,
      storageKey: localAssets.storageKey,
    })
    .from(localAssets)
    .where(
      and(
        inArray(localAssets.id, ids),
        eq(localAssets.scope, "managed_user"),
        eq(localAssets.accountUserId, operation.userId),
      ),
    );
  return {
    projection: siteOpsBuildArtifactProjection({
      bindings,
      rows,
      userId: operation.userId,
      projectId: operation.projectId,
    }),
    mode: fallbackBind
      ? "fallback_bind"
      : formalUpgrade
        ? "formal_upgrade"
        : "initial",
  };
}

async function finalize(
  db: any,
  operation: Claimed,
  providerResult: SiteOpsProviderResult,
) {
  return db.transaction(async (tx: any) => {
    const lockedRows = await tx
      .select()
      .from(siteOperations)
      .where(eq(siteOperations.id, operation.id))
      .limit(1)
      .for("update");
    const locked = lockedRows[0];
    if (
      !locked ||
      locked.status !== "running" ||
      locked.leaseOwner !== operation.leaseOwner
    ) {
      return providerResult.status;
    }
    const publicResult = publicSiteOpsProviderResult(
      locked.provider,
      providerResult,
    );
    let finalizedResult: SiteOpsProviderResult = publicResult;
    let buildArtifactVerification: BuildArtifactVerification | null = null;
    const pendingFallbackMarker =
      finalizedResult.status === "pending"
        ? fallbackMarkerFromOperationResult(finalizedResult.result)
        : null;
    if (
      (finalizedResult.status === "succeeded" ||
        pendingFallbackMarker?.status === "staged") &&
      ["site_build", "build_revision"].includes(locked.kind)
    ) {
      try {
        buildArtifactVerification = await verifiedBuildArtifactProjection(
          tx,
          locked,
          finalizedResult as Extract<
            SiteOpsProviderResult,
            { status: "succeeded" | "pending" }
          >,
        );
      } catch (error) {
        const internalCode =
          typeof (error as { code?: unknown })?.code === "string"
            ? String((error as { code: string }).code)
            : "";
        if (!/^SITEOPS_BUILD_ARTIFACT_[A-Z0-9_]+$/u.test(internalCode)) {
          // Database/driver failures are not artifact verdicts. Let the
          // transaction roll back so the same leased operation can be safely
          // reclaimed instead of overwriting its task and staged coordinates.
          throw error;
        }
        console.error("[SiteOpsWorker] build_artifact_binding_failed", {
          event: "siteops_build_artifact_binding_failed",
          operationId: locked.id,
          projectId: locked.projectId,
          buildId: locked.buildId,
          internalCode,
        });
        const returnedFallback = fallbackMarkerFromOperationResult(
          finalizedResult.result,
        );
        const lockedFallback = fallbackMarkerFromOperationResult(locked.result);
        const retainedFallback = returnedFallback ?? lockedFallback;
        const retainedResult = returnedFallback
          ? finalizedResult.result
          : lockedFallback
            ? locked.result
            : null;
        finalizedResult = retainedFallback
          ? {
              status: "attention_required",
              code:
                retainedFallback.status === "bound"
                  ? "FRONTMIND_BUILD_RECONCILIATION_REQUIRED"
                  : "FRONTMIND_BUILD_REQUIRES_ATTENTION",
              message:
                retainedFallback.status === "bound"
                  ? "正式结果未能安全替换基础预览；基础预览与原任务坐标已保留，可由运营恢复读取。"
                  : "基础预览产物未能完整绑定；同一任务与已暂存产物坐标已保留，等待运营处理。",
              providerTaskId:
                providerResult.providerTaskId ??
                locked.providerTaskId ??
                undefined,
              result: retainedResult as Record<string, unknown>,
            }
          : {
              status: "attention_required",
              code: "BUILD_ARTIFACT_BINDING_FAILED",
              message:
                "官网产物恢复坐标未通过一致性校验，已保留任务与产物等待处理。",
              providerTaskId:
                providerResult.providerTaskId ??
                locked.providerTaskId ??
                undefined,
              result:
                locked.result &&
                typeof locked.result === "object" &&
                !Array.isArray(locked.result)
                  ? locked.result
                  : finalizedResult.result,
            };
      }
    }
    if (
      finalizedResult.status === "succeeded" &&
      buildArtifactVerification &&
      ["site_build", "build_revision"].includes(locked.kind)
    ) {
      const boundResult = { ...(finalizedResult.result ?? {}) };
      delete boundResult.buildPhase;
      const priorCheckpoints = Array.isArray(boundResult.buildCheckpoints)
        ? boundResult.buildCheckpoints.filter(
            (value): value is string => typeof value === "string",
          )
        : [];
      finalizedResult = {
        ...finalizedResult,
        buildStatus: "approved",
        projectStatus: "approved",
        message: "官网已完成，可以打开预览。",
        // Artifact verification and all five build-column bindings occur in
        // this same transaction. Publish the final checkpoint only here.
        result: {
          ...boundResult,
          buildCheckpoint: "preview_ready",
          // `artifacts_bound` cannot be committed as a separate externally
          // visible state without splitting the all-five binding transaction.
          // Persist both audit edges in the final operation result instead.
          buildCheckpoints: [
            ...new Set([
              ...priorCheckpoints,
              "artifacts_bound",
              "preview_ready",
            ]),
          ],
        },
      };
    }
    const result = finalizedResult;
    const now = new Date();
    if (buildArtifactVerification?.mode === "formal_upgrade") {
      const replacedFallback = fallbackMarkerFromOperationResult(locked.result);
      if (replacedFallback?.status !== "bound") {
        throw workerArtifactError("SITEOPS_BUILD_ARTIFACT_BINDING_CONFLICT");
      }
      await tx
        .update(localAssets)
        .set({
          retainUntil: new Date(now.getTime() + 24 * 60 * 60 * 1_000),
          updatedAt: now,
        })
        .where(
          inArray(
            localAssets.id,
            BUILD_ARTIFACT_KINDS.map(
              (kind) => replacedFallback.artifactBindings[kind].id,
            ),
          ),
        );
    }
    if (result.status === "pending") {
      const nextPollMs = Math.max(
        2_000,
        Math.min(result.nextPollMs ?? 10_000, 5 * 60_000),
      );
      let durablePendingResult = result.result;
      if (buildArtifactVerification?.mode === "fallback_bind") {
        const state =
          result.result &&
          typeof result.result === "object" &&
          !Array.isArray(result.result)
            ? result.result
            : null;
        const marker = state ? fallbackMarkerFromOperationResult(state) : null;
        if (!state || marker?.status !== "staged" || !locked.buildId) {
          throw workerArtifactError("SITEOPS_BUILD_ARTIFACT_BINDING_CONFLICT");
        }
        durablePendingResult = {
          ...state,
          fallbackPreview: {
            ...(state.fallbackPreview as Record<string, unknown>),
            status: "bound",
          },
        };
        const fallbackBound = await tx
          .update(siteBuilds)
          .set({
            ...buildArtifactVerification.projection,
            status: "qa_running",
            quotaState: "reserved",
            updatedAt: now,
          })
          .where(
            and(
              eq(siteBuilds.id, locked.buildId),
              eq(siteBuilds.projectId, locked.projectId),
              eq(siteBuilds.userId, locked.userId),
              isNull(siteBuilds.parentBuildId),
              eq(siteBuilds.status, "qa_running"),
              eq(siteBuilds.quotaState, "reserved"),
              isNull(siteBuilds.contractLocalAssetId),
              isNull(siteBuilds.sourceLocalAssetId),
              isNull(siteBuilds.distLocalAssetId),
              isNull(siteBuilds.qaLocalAssetId),
              isNull(siteBuilds.provenanceLocalAssetId),
            ),
          );
        if (affectedRows(fallbackBound) !== 1) {
          throw workerArtifactError("SITEOPS_BUILD_ARTIFACT_BINDING_CONFLICT");
        }
      }
      const pendingUpdate = await tx
        .update(siteOperations)
        .set({
          // A running row with a future lease is the existing operation's
          // durable poll schedule. It cannot be mistaken for a new side effect.
          status: "running",
          result: durablePendingResult,
          providerOperationId:
            result.providerOperationId ?? locked.providerOperationId,
          providerTaskId: result.providerTaskId ?? locked.providerTaskId,
          leaseOwner: null,
          leaseExpiresAt: new Date(now.getTime() + nextPollMs),
          updatedAt: now,
        })
        .where(
          and(
            eq(siteOperations.id, locked.id),
            eq(siteOperations.leaseOwner, operation.leaseOwner),
          ),
        );
      if (affectedRows(pendingUpdate) !== 1) {
        throw new Error("SITEOPS_OPERATION_LEASE_LOST");
      }
      if (await operationPredatesCurrentResetEpoch(tx, locked as Claimed)) {
        // The provider may finish read-only reconciliation for the old
        // external boundary, but it must not move the newly-created local
        // reset epoch back to an old build/status while still pending.
        return result.status;
      }
      if (locked.buildId && result.buildStatus) {
        await appendBuildTimelineEvent(tx, {
          operation: locked as Claimed,
          buildStatus: result.buildStatus,
          now,
        });
        await tx
          .update(siteBuilds)
          .set({ status: result.buildStatus, updatedAt: now })
          .where(eq(siteBuilds.id, locked.buildId));
      }
      if (result.projectStatus) {
        await tx
          .update(siteProjects)
          .set({ status: result.projectStatus, updatedAt: now })
          .where(eq(siteProjects.id, locked.projectId));
      }
      return result.status;
    }
    if (result.status === "outcome_unknown") {
      if (approvedResetFromOperationInput(locked.input)) {
        // An approved reset that crossed a provider mutation boundary must
        // stop here. Repeatedly converting the terminal uncertainty back to
        // `running` would execute unbounded read-only polls forever. A later
        // operator reconciliation may reuse this exact operation and its
        // persisted boundary, but must never create or replay a delete.
        const terminalUnknownUpdate = await tx
          .update(siteOperations)
          .set({
            status: "outcome_unknown",
            result: result.result ?? locked.result,
            providerOperationId:
              result.providerOperationId ?? locked.providerOperationId,
            providerTaskId: result.providerTaskId ?? locked.providerTaskId,
            errorCode: result.code,
            errorMessage: result.message,
            leaseOwner: null,
            leaseExpiresAt: null,
            completedAt: now,
            updatedAt: now,
          })
          .where(
            and(
              eq(siteOperations.id, locked.id),
              eq(siteOperations.leaseOwner, operation.leaseOwner),
            ),
          );
        if (affectedRows(terminalUnknownUpdate) !== 1) {
          throw new Error("SITEOPS_RESET_OPERATION_CAS_CONFLICT");
        }
        return result.status;
      }
      // A timeout after a provider mutation is not a terminal failure. Keep
      // the original reservation and let the same provider handler enter its
      // read-only reconciliation branch on the next lease; never create a
      // replacement operation or repeat the side effect.
      await tx
        .update(siteOperations)
        .set({
          status: "running",
          result: result.result ?? locked.result,
          providerOperationId:
            result.providerOperationId ?? locked.providerOperationId,
          providerTaskId: result.providerTaskId ?? locked.providerTaskId,
          errorCode: result.code,
          errorMessage: result.message,
          leaseOwner: null,
          leaseExpiresAt: new Date(now.getTime() + 15_000),
          updatedAt: now,
        })
        .where(
          and(
            eq(siteOperations.id, locked.id),
            eq(siteOperations.leaseOwner, operation.leaseOwner),
          ),
        );
      return result.status;
    }
    const approvedReset = parseApprovedResetUnpublishInput(locked.input);
    if (approvedReset) {
      let resetResult: Exclude<SiteOpsProviderResult, { status: "pending" }> =
        result;
      if (result.status === "succeeded") {
        const safeNoExposureProof = parseApprovedResetSafeNoExposureProof(
          result.result?.safeNoExposureProof,
        );
        const resetFinalization = await finalizeApprovedSiteOpsReset(tx, {
          operation: locked,
          now,
          safeNoExposureProof: safeNoExposureProof ?? undefined,
        });
        if (resetFinalization.status !== "applied") {
          resetResult = failureResult(
            "failed",
            "SITEOPS_RESET_INVALIDATED",
            "官网重置坐标已变化，系统未清除当前流程。",
          );
        } else {
          // Persist the permanent fresh-root floor on the immutable reset
          // operation as well as the delivery ticket. Terminal tickets may be
          // removed by retention, while this audit result remains the trusted
          // source that prevents an old knowledge snapshot from reappearing.
          resetResult = {
            ...result,
            result: resetFinalization.operationResult,
          };
        }
      }
      const resetTerminalUpdate = await tx
        .update(siteOperations)
        .set({
          status: resetResult.status,
          ...terminalSiteOpsOperationProjection(locked, resetResult),
          errorCode:
            resetResult.status === "succeeded" ? null : resetResult.code,
          errorMessage:
            resetResult.status === "succeeded" ? null : resetResult.message,
          leaseOwner: null,
          leaseExpiresAt: null,
          completedAt: now,
          updatedAt: now,
        })
        .where(
          and(
            eq(siteOperations.id, locked.id),
            eq(siteOperations.leaseOwner, operation.leaseOwner),
          ),
        );
      if (affectedRows(resetTerminalUpdate) !== 1) {
        throw new Error("SITEOPS_RESET_OPERATION_CAS_CONFLICT");
      }
      // This operation has no site_deployments reservation. Its project and
      // ticket writes are owned exclusively by finalizeApprovedSiteOpsReset.
      return resetResult.status;
    }
    const terminalStatus = result.status;
    const preservedTerminalState = terminalSiteOpsOperationProjection(
      locked,
      result,
    );
    const terminalUpdate = await tx
      .update(siteOperations)
      .set({
        status: terminalStatus,
        ...preservedTerminalState,
        errorCode: result.status === "succeeded" ? null : result.code,
        errorMessage: result.status === "succeeded" ? null : result.message,
        leaseOwner: null,
        leaseExpiresAt: null,
        completedAt: now,
        updatedAt: now,
      })
      .where(
        and(
          eq(siteOperations.id, locked.id),
          eq(siteOperations.leaseOwner, operation.leaseOwner),
        ),
      );
    void terminalUpdate;

    if (await operationPredatesCurrentResetEpoch(tx, locked as Claimed)) {
      // Approval freezes this old Aliyun operation in the reset ticket. Its
      // terminal evidence is retained for deferred cleanup activation, while
      // automatic publish/DNS successors and every project/head write are
      // fenced from the new epoch.
      return result.status;
    }

    if (result.status === "succeeded") {
      await enqueueAutomaticDomainSuccessor(tx, locked, result, now);
    }

    if (locked.kind === "visual_search") {
      const projectRows = await tx
        .select()
        .from(siteProjects)
        .where(eq(siteProjects.id, locked.projectId))
        .limit(1)
        .for("update");
      const project = projectRows[0];
      if (!project) return result.status;

      const publishedRows = await tx
        .select({ id: websiteStyleSampleBatches.id })
        .from(websiteStyleSampleBatches)
        .where(
          and(
            eq(websiteStyleSampleBatches.siteProjectId, locked.projectId),
            eq(websiteStyleSampleBatches.userId, locked.userId),
            eq(websiteStyleSampleBatches.sourceKind, "siteops_21st"),
            eq(websiteStyleSampleBatches.status, "published"),
          ),
        )
        .limit(SITEOPS_VISUAL_CANDIDATE_MAX_PAGES)
        .for("update");
      const publishedIds = publishedRows.map((row: { id: string }) => row.id);
      const sampleRows =
        publishedIds.length > 0
          ? await tx
              .select({ batchId: websiteStyleSamples.batchId })
              .from(websiteStyleSamples)
              .where(inArray(websiteStyleSamples.batchId, publishedIds))
              .limit(SITEOPS_VISUAL_CANDIDATE_MAX_TOTAL)
          : [];
      const samplesPerBatch = new Map<string, number>();
      for (const row of sampleRows as Array<{ batchId: string }>) {
        samplesPerBatch.set(
          row.batchId,
          (samplesPerBatch.get(row.batchId) ?? 0) + 1,
        );
      }
      const completePublishedPages = publishedIds.filter(
        (id: string) =>
          samplesPerBatch.get(id) === SITEOPS_VISUAL_CANDIDATE_PAGE_SIZE,
      ).length;
      const coordinates = siteOpsVisualOperationCoordinates({
        operationInput: locked.input,
        completePublishedPages,
      });

      if (result.status === "succeeded") {
        console.info("[SiteOpsWorker] visual_search_finalized", {
          event: "siteops_visual_search_finalized",
          operationId: locked.id,
          projectId: locked.projectId,
          mode: coordinates.mode,
          page: coordinates.page,
          operationStatus: result.status,
        });
        // The visual provider commits the complete board, success message and
        // project revision atomically. The worker owns only the terminal
        // operation row and must not repeat those writes.
        return result.status;
      }

      const activeVisualRows = await tx
        .select({ id: siteOperations.id })
        .from(siteOperations)
        .where(
          and(
            eq(siteOperations.projectId, locked.projectId),
            eq(siteOperations.userId, locked.userId),
            eq(siteOperations.kind, "visual_search"),
            inArray(siteOperations.status, [
              "queued",
              "running",
              "outcome_unknown",
            ]),
          ),
        )
        .limit(1)
        .for("update");
      const activeBuildRows = await tx
        .select({ id: siteBuilds.id })
        .from(siteBuilds)
        .where(
          and(
            eq(siteBuilds.projectId, locked.projectId),
            eq(siteBuilds.userId, locked.userId),
            inArray(siteBuilds.status, [
              "preparing",
              "visual_searching",
              "awaiting_visual_selection",
              "design_compiling",
              "contract_ready",
              "building",
              "qa_running",
            ]),
          ),
        )
        .limit(1)
        .for("update");
      const recoverable = siteOpsSupplementalVisualFailureMayRecover({
        mode: coordinates.mode,
        completePublishedPages,
        projectStatus: project.status,
        projectRevision: project.revision,
        admissionRevision: coordinates.admissionRevision,
        hasActiveVisualOperation: activeVisualRows.length > 0,
        hasActiveBuild: activeBuildRows.length > 0,
        errorCode: result.code,
      });
      console.warn("[SiteOpsWorker] visual_search_terminal", {
        event: "siteops_visual_search_terminal",
        operationId: locked.id,
        projectId: locked.projectId,
        mode: coordinates.mode,
        page: coordinates.page,
        operationStatus: result.status,
        errorCode: result.code,
        completePublishedPages,
        recoverable,
      });
      if (recoverable) {
        const sequenceRows = await tx
          .select({ sequence: max(messages.sequence) })
          .from(messages)
          .where(eq(messages.conversationId, project.conversationId));
        await tx.insert(messages).values({
          id: randomUUID(),
          conversationId: project.conversationId,
          userId: project.userId,
          role: "assistant",
          content: "本次未能生成完整的新一组，当前候选仍可选择，也可稍后重试。",
          sequence: Number(sequenceRows[0]?.sequence ?? 0) + 1,
          metadata: {
            siteOps: {
              kind: "build_progress",
              subjectId: locked.id,
              revision: project.revision,
              status: "active",
              payload: {
                operationKind: "visual_search",
                operationStatus: result.status,
                errorCode: result.code,
                page: coordinates.page,
                retryable: true,
              },
            },
          },
        });
        await tx
          .update(siteProjects)
          .set({
            status: "awaiting_visual_selection",
            updatedAt: now,
          })
          .where(
            and(
              eq(siteProjects.id, project.id),
              eq(siteProjects.revision, project.revision),
            ),
          );
        return result.status;
      }
      const initialSupersededMayStaySilent =
        result.code === "VISUAL_SEARCH_SUPERSEDED" &&
        siteOpsInitialVisualSupersededMayStaySilent({
          mode: coordinates.mode,
          projectStatus: project.status,
          projectRevision: project.revision,
          admissionRevision: coordinates.admissionRevision,
        });
      if (
        coordinates.mode === "supplemental" ||
        initialSupersededMayStaySilent
      ) {
        // A stale or otherwise unrecoverable supplemental result may finalize
        // its own operation, but it must never regress a newer project state.
        // An initial superseded result is silent only after the project has
        // observably advanced; otherwise the generic failure path below must
        // release the project from visual_searching.
        return result.status;
      }
    }

    const unsuccessful = result.status !== "succeeded";
    const terminalFallback =
      fallbackMarkerFromOperationResult(result.result) ??
      fallbackMarkerFromOperationResult(locked.result);
    if (locked.buildId) {
      await tx
        .update(siteBuilds)
        .set({
          status: unsuccessful
            ? result.status === "failed"
              ? "failed"
              : "attention_required"
            : result.buildStatus,
          ...(!unsuccessful && buildArtifactVerification
            ? buildArtifactVerification.projection
            : {}),
          errorCode: unsuccessful ? result.code : null,
          errorMessage: unsuccessful ? result.message : null,
          approvedAt:
            !unsuccessful && result.buildStatus === "approved" ? now : null,
          ...(["site_build", "build_revision"].includes(locked.kind)
            ? {
                quotaState:
                  result.status === "attention_required" && terminalFallback
                    ? "released"
                    : siteOpsQuotaStateForProviderResult(result.status),
              }
            : {}),
          updatedAt: now,
        })
        .where(eq(siteBuilds.id, locked.buildId));
    }
    await tx
      .update(socialPackages)
      .set({
        status: unsuccessful
          ? result.status === "failed"
            ? "failed"
            : "attention_required"
          : (result.socialPackageStatus ?? "ready"),
        errorCode: unsuccessful ? result.code : null,
        errorMessage: unsuccessful ? result.message : null,
        quotaState: siteOpsQuotaStateForProviderResult(result.status),
        updatedAt: now,
      })
      .where(eq(socialPackages.operationId, locked.id));
    if (unsuccessful || result.projectStatus !== "live") {
      await tx
        .update(siteDeployments)
        .set({
          status: unsuccessful
            ? result.status === "failed"
              ? "failed"
              : "attention_required"
            : "verifying",
          errorCode: unsuccessful ? result.code : null,
          errorMessage: unsuccessful ? result.message : null,
          updatedAt: now,
        })
        .where(eq(siteDeployments.operationId, locked.id));
    }
    const projectRows = await tx
      .select()
      .from(siteProjects)
      .where(eq(siteProjects.id, locked.projectId))
      .limit(1)
      .for("update");
    const project = projectRows[0];
    if (!project) return result.status;
    let liveHeadConflict = false;
    if (!unsuccessful && result.projectStatus === "live") {
      const deploymentRows = await tx
        .select()
        .from(siteDeployments)
        .where(eq(siteDeployments.operationId, locked.id))
        .limit(1)
        .for("update");
      const deployment = deploymentRows[0];
      if (!deployment) {
        liveHeadConflict = true;
      } else {
        const currentHead =
          deployment.target === "mainland_cn"
            ? project.mainlandLiveDeploymentId
            : project.globalLiveDeploymentId;
        if ((deployment.expectedHeadDeploymentId ?? null) !== currentHead) {
          liveHeadConflict = true;
          await tx
            .update(siteOperations)
            .set({
              status: "attention_required",
              errorCode: "LIVE_HEAD_CONFLICT",
              errorMessage:
                "线上版本在发布期间发生变化；已部署版本未被切换为 FrontMind live head。",
              updatedAt: now,
            })
            .where(eq(siteOperations.id, locked.id));
          await tx
            .update(siteDeployments)
            .set({
              status: "attention_required",
              errorCode: "LIVE_HEAD_CONFLICT",
              errorMessage:
                "线上版本在发布期间发生变化；已部署版本未被切换为 FrontMind live head。",
              updatedAt: now,
            })
            .where(eq(siteDeployments.id, deployment.id));
        } else {
          const otherHead =
            deployment.target === "mainland_cn"
              ? project.globalLiveDeploymentId
              : project.mainlandLiveDeploymentId;
          if (currentHead) {
            await tx
              .update(siteDeployments)
              .set({ status: "superseded", updatedAt: now })
              .where(
                and(
                  eq(siteDeployments.id, currentHead),
                  eq(siteDeployments.projectId, project.id),
                  eq(siteDeployments.target, deployment.target),
                  eq(siteDeployments.status, "active"),
                ),
              );
          }
          if (otherHead && otherHead !== currentHead) {
            await tx
              .update(siteDeployments)
              .set({ status: "superseded", updatedAt: now })
              .where(
                and(
                  eq(siteDeployments.id, otherHead),
                  eq(siteDeployments.projectId, project.id),
                  eq(siteDeployments.status, "active"),
                ),
              );
          }
          await tx
            .update(siteDeployments)
            .set({
              status: "active",
              errorCode: null,
              errorMessage: null,
              activatedAt: now,
              updatedAt: now,
            })
            .where(eq(siteDeployments.id, deployment.id));
          await tx
            .update(siteProjects)
            .set({
              ...exclusiveSiteOpsLiveHeadProjection(
                deployment.target,
                deployment.id,
              ),
              currentBuildId: deployment.buildId,
              updatedAt: now,
            })
            .where(eq(siteProjects.id, project.id));
        }
      }
    }
    const messageText = liveHeadConflict
      ? "ESA 已返回验证结果，但线上 head 在发布期间发生变化；系统未覆盖较新的线上版本，请人工核对。"
      : result.status === "succeeded"
        ? result.message
        : result.message || "该操作需要人工处理。";
    if (messageText) {
      const sequenceRows = await tx
        .select({ sequence: max(messages.sequence) })
        .from(messages)
        .where(eq(messages.conversationId, project.conversationId));
      await tx.insert(messages).values({
        id: randomUUID(),
        conversationId: project.conversationId,
        userId: project.userId,
        role: "assistant",
        content: messageText,
        sequence: Number(sequenceRows[0]?.sequence ?? 0) + 1,
        metadata: {
          siteOps: {
            kind:
              locked.kind === "deploy" || locked.kind === "rollback"
                ? "release_status"
                : locked.kind === "social_package"
                  ? "social_package"
                  : locked.kind.startsWith("domain_") ||
                      locked.kind.startsWith("dns_")
                    ? "domain_status"
                    : "build_progress",
            subjectId: locked.id,
            revision: project.revision + 1,
            status: unsuccessful || liveHeadConflict ? "active" : "resolved",
            payload: {
              operationKind: locked.kind,
              operationStatus: liveHeadConflict
                ? "attention_required"
                : result.status,
              errorCode: liveHeadConflict
                ? "LIVE_HEAD_CONFLICT"
                : unsuccessful
                  ? result.code
                  : undefined,
            },
          },
        },
      });
    }
    await tx
      .update(siteProjects)
      .set({
        ...(!unsuccessful && result.buildStatus === "approved" && locked.buildId
          ? { currentBuildId: locked.buildId }
          : {}),
        status: liveHeadConflict
          ? "attention_required"
          : unsuccessful
            ? result.status === "failed"
              ? "failed"
              : "attention_required"
            : result.projectStatus,
        revision: project.revision + 1,
        updatedAt: now,
      })
      .where(eq(siteProjects.id, project.id));
    return liveHeadConflict ? "attention_required" : result.status;
  });
}

export async function runSiteOpsWorkerSweep(options?: { max?: number }) {
  const db = await getDb();
  if (!db || process.env.FRONTMIND_SITEOPS_ENABLED?.trim() === "0") {
    return {
      claimed: 0,
      succeeded: 0,
      deferred: 0,
      attentionRequired: 0,
      failed: 0,
    };
  }
  const limit = Math.max(1, Math.min(options?.max ?? DEFAULT_BATCH, 20));
  const summary = {
    claimed: 0,
    succeeded: 0,
    deferred: 0,
    attentionRequired: 0,
    failed: 0,
  };
  await activateOneDeferredApprovedSiteOpsReset(db);
  await requeueOneSafeApprovedReset(db);
  for (let index = 0; index < limit; index += 1) {
    const operation = await claimOne(db);
    if (!operation) break;
    summary.claimed += 1;
    const result =
      stagedBuildCheckpointResult(operation) ??
      (await invokeProvider(db, operation));
    const finalizedStatus = await finalize(db, operation, result);
    if (finalizedStatus === "pending") summary.deferred += 1;
    else if (finalizedStatus === "succeeded") summary.succeeded += 1;
    else if (finalizedStatus === "failed") summary.failed += 1;
    else summary.attentionRequired += 1;
  }
  await finalizePendingTwentyFirstCredentialRevocations().catch((error) => {
    console.error(
      "[SiteOpsWorker] twenty_first_revocation_finalize_failed",
      runtimeErrorForLog(error),
    );
  });
  return summary;
}

let scheduler: NodeJS.Timeout | null = null;
let sweep: Promise<unknown> | null = null;

export function startSiteOpsWorkerScheduler(options?: { intervalMs?: number }) {
  if (scheduler || process.env.FRONTMIND_SITEOPS_ENABLED?.trim() === "0")
    return;
  const run = () => {
    if (sweep) return;
    sweep = runSiteOpsWorkerSweep()
      .catch((error) => {
        console.error(
          "[SiteOpsWorker] sweep_failed",
          runtimeErrorForLog(error),
        );
      })
      .finally(() => {
        sweep = null;
      });
  };
  run();
  scheduler = setInterval(run, Math.max(10_000, options?.intervalMs ?? 30_000));
  scheduler.unref?.();
}

export async function stopSiteOpsWorkerScheduler() {
  if (scheduler) clearInterval(scheduler);
  scheduler = null;
  await sweep;
}
