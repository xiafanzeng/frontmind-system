import { createHash, randomUUID } from "node:crypto";
import { and, asc, eq, gte, inArray, isNull, like, max, or } from "drizzle-orm";
import { z } from "zod";
import {
  deliveryProjectAssignments,
  deliveryTicketEvents,
  deliveryTickets,
  messages,
  serviceQuotaPeriods,
  siteBuilds,
  siteDeployments,
  siteDnsRecords,
  siteOperations,
  siteProjects,
  siteProviderConnections,
  socialPackages,
  users,
  visualCandidatePoolPages,
  visualCandidatePools,
  websiteStyleSampleBatches,
  workspaceSiteProfiles,
} from "../../drizzle/schema";

const REBUILD_TARGET_PREFIX = "/siteops/builds/";
const REBUILD_PROJECT_TARGET_PREFIX = "/siteops/projects/";
const REBUILD_NOTE_KIND = "frontmind.siteops-rebuild.v1";
export const APPROVED_RESET_UNPUBLISH = "approved_reset_unpublish";
const ACTIVE_TICKET_STATUSES = [
  "submitted",
  "needs_information",
  "scheduled",
  "in_progress",
] as const;
const RESET_PRE_MUTATION_RETRY_CODES = new Set([
  "ESA_RUNTIME_DISABLED",
  "ESA_INSTANCE_NOT_CONFIGURED",
  "ESA_SERVICE_IDENTITY_NOT_CONFIGURED",
  "DATABASE_UNAVAILABLE",
  "PROVIDER_NOT_CONFIGURED",
  "ALIYUN_REAUTHORIZATION_REQUIRED",
]);
const ACTIVE_SITE_OPERATION_STATUSES = [
  "queued",
  "running",
  "outcome_unknown",
] as const;
const RESET_RETIRABLE_GENERATION_STATUSES = [
  ...ACTIVE_SITE_OPERATION_STATUSES,
  "attention_required",
  "failed",
] as const;

const MYSQL_TIMESTAMP_SECOND_MS = 1_000;

/**
 * SiteOps reset epochs are persisted in MySQL TIMESTAMP(0) columns. Keep the
 * JSON coordinate at that same precision so a value written and read back is
 * stable instead of depending on an in-memory millisecond remainder.
 */
export function siteOpsResetEpochAtDatabasePrecision(value: Date) {
  return new Date(
    Math.floor(value.getTime() / MYSQL_TIMESTAMP_SECOND_MS) *
      MYSQL_TIMESTAMP_SECOND_MS,
  );
}

function resetEpochSecond(value: Date | string) {
  const timestamp =
    value instanceof Date ? value.getTime() : new Date(value).getTime();
  return Number.isFinite(timestamp)
    ? Math.floor(timestamp / MYSQL_TIMESTAMP_SECOND_MS)
    : null;
}

function resetEpochsMatch(left: Date | string, right: Date | string) {
  const leftSecond = resetEpochSecond(left);
  return leftSecond !== null && leftSecond === resetEpochSecond(right);
}

function localResetRetirableOperation(input: {
  kind: string;
  provider: string | null;
}) {
  return (
    (input.kind === "visual_search" && input.provider === "21st") ||
    ((input.kind === "site_build" ||
      input.kind === "build_revision" ||
      input.kind === "social_package") &&
      input.provider === "manus")
  );
}

function knownAliyunWriteOperation(input: {
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

type SiteOpsRebuildNoteV1 = {
  schemaVersion: 1;
  kind: typeof REBUILD_NOTE_KIND;
  projectId: string;
  sourceBuildId: string;
  knowledgeSnapshotId: string;
};

type SiteOpsRebuildNoteV2 = Omit<SiteOpsRebuildNoteV1, "schemaVersion"> & {
  schemaVersion: 2;
  resetAppliedAt: string;
  resetAppliedProjectRevision: number;
};

type SiteOpsRebuildNoteV3 = {
  schemaVersion: 3;
  kind: typeof REBUILD_NOTE_KIND;
  projectId: string;
  sourceBuildId: string | null;
  knowledgeSnapshotId: string | null;
  resetAppliedAt?: string;
  resetAppliedProjectRevision?: number;
};

type SiteOpsRebuildNoteV4 = {
  schemaVersion: 4;
  kind: typeof REBUILD_NOTE_KIND;
  projectId: string;
  sourceBuildId: string | null;
  knowledgeSnapshotId: string | null;
  resetIntent: typeof APPROVED_RESET_UNPUBLISH;
  resetOperationId: string;
  resetApprovedAt: string;
  resetExpectedProjectRevision: number;
  minimumKnowledgeSnapshotVersion: number;
  resetAppliedAt?: string;
  resetAppliedProjectRevision?: number;
  freshRootApplied?: true;
  unpublishOperationId?: string;
  /**
   * New approvals apply the local reset epoch before external exposure is
   * removed. Older V4 notes omit this marker and retain their original
   * all-at-once completion semantics.
   */
  resetEpochDecoupled?: true;
  frozenReset?: ApprovedResetUnpublishInput;
  externalCleanupCompletedAt?: string;
};

/**
 * An approval that cannot yet freeze an external reset coordinate. V5 keeps
 * the approval durable while either an existing Aliyun write reconciles or
 * required domain access is restored. The worker later snapshots the latest
 * live head/domain and atomically upgrades this note to V4.
 */
type SiteOpsRebuildNoteV5 = {
  schemaVersion: 5;
  kind: typeof REBUILD_NOTE_KIND;
  projectId: string;
  sourceBuildId: string | null;
  knowledgeSnapshotId: string | null;
  resetIntent: typeof APPROVED_RESET_UNPUBLISH;
  resetApprovedAt: string;
  minimumKnowledgeSnapshotVersion: number;
  resetActivationState:
    | "awaiting_external_reconciliation"
    | "awaiting_external_access";
  awaitingExternalOperationIds: string[];
  resetEpochDecoupled?: true;
  resetAppliedAt?: string;
  resetAppliedProjectRevision?: number;
  freshRootApplied?: true;
  frozenReset?: ApprovedResetUnpublishInput;
};

const completedFreshRootResetOperationResultV2Schema = z
  .object({
    schemaVersion: z.literal(2),
    intent: z.literal(APPROVED_RESET_UNPUBLISH),
    stage: z.literal("exposure_removed"),
    resetOperationId: z.string().uuid(),
    projectId: z.string().uuid(),
    freshRootApplied: z.literal(true),
    minimumKnowledgeSnapshotVersion: z.number().int().positive(),
    resetAppliedProjectRevision: z.number().int().positive(),
  })
  .strict();

function completedFreshRootResetOperationProjection(input: {
  operationId: string;
  projectId: string;
  minimumKnowledgeSnapshotVersion: number;
  resetAppliedProjectRevision: number;
}) {
  return completedFreshRootResetOperationResultV2Schema.parse({
    schemaVersion: 2,
    intent: APPROVED_RESET_UNPUBLISH,
    stage: "exposure_removed",
    resetOperationId: input.operationId,
    projectId: input.projectId,
    freshRootApplied: true,
    minimumKnowledgeSnapshotVersion: input.minimumKnowledgeSnapshotVersion,
    resetAppliedProjectRevision: input.resetAppliedProjectRevision,
  });
}

type SiteOpsRebuildNote =
  | SiteOpsRebuildNoteV1
  | SiteOpsRebuildNoteV2
  | SiteOpsRebuildNoteV3
  | SiteOpsRebuildNoteV4
  | SiteOpsRebuildNoteV5;

export const approvedResetUnpublishInputSchema = z
  .object({
    schemaVersion: z.literal(1),
    intent: z.literal(APPROVED_RESET_UNPUBLISH),
    rebuildTicketId: z.string().uuid(),
    expectedProjectRevision: z.number().int().positive(),
    expectedCurrentBuildId: z.string().uuid().nullable(),
    expectedKnowledgeSnapshotId: z.string().uuid().nullable(),
    expectedGlobalLiveDeploymentId: z.string().uuid().nullable(),
    expectedMainlandLiveDeploymentId: z.string().uuid().nullable(),
    expectedCanonicalHostname: z.string().trim().min(1).max(255).nullable(),
    resetAppliedProjectRevision: z.number().int().positive().optional(),
    resetEpochStartedAt: z
      .string()
      .datetime({ offset: true })
      .transform((value) =>
        siteOpsResetEpochAtDatabasePrecision(new Date(value)).toISOString(),
      )
      .optional(),
  })
  .strict()
  .superRefine((value, context) => {
    if (
      (value.resetAppliedProjectRevision === undefined) !==
      (value.resetEpochStartedAt === undefined)
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          "resetAppliedProjectRevision and resetEpochStartedAt must be provided together",
      });
    }
  });

export type ApprovedResetUnpublishInput = z.infer<
  typeof approvedResetUnpublishInputSchema
>;

export function parseApprovedResetUnpublishInput(value: unknown) {
  const parsed = approvedResetUnpublishInputSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

function parseApprovedResetFromOperationInput(value: unknown) {
  const direct = parseApprovedResetUnpublishInput(value);
  if (direct) return direct;
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return parseApprovedResetUnpublishInput(
    (value as Record<string, unknown>).approvedReset,
  );
}

function approvedResetInputsEqual(
  left: ApprovedResetUnpublishInput,
  right: ApprovedResetUnpublishInput,
) {
  return (
    left.rebuildTicketId === right.rebuildTicketId &&
    left.expectedProjectRevision === right.expectedProjectRevision &&
    left.expectedCurrentBuildId === right.expectedCurrentBuildId &&
    left.expectedKnowledgeSnapshotId === right.expectedKnowledgeSnapshotId &&
    left.expectedGlobalLiveDeploymentId ===
      right.expectedGlobalLiveDeploymentId &&
    left.expectedMainlandLiveDeploymentId ===
      right.expectedMainlandLiveDeploymentId &&
    left.expectedCanonicalHostname === right.expectedCanonicalHostname &&
    left.resetAppliedProjectRevision === right.resetAppliedProjectRevision &&
    left.resetEpochStartedAt === right.resetEpochStartedAt
  );
}

export function approvedResetUnpublishProjectMatches(
  input: ApprovedResetUnpublishInput,
  project: Pick<
    typeof siteProjects.$inferSelect,
    | "revision"
    | "currentBuildId"
    | "currentKnowledgeSnapshotId"
    | "globalLiveDeploymentId"
    | "mainlandLiveDeploymentId"
    | "canonicalHostname"
    | "currentTaskStartedAt"
  >,
) {
  if (approvedResetUnpublishFreshEpochMatches(input, project)) return true;
  return (
    project.revision === input.expectedProjectRevision &&
    approvedResetUnpublishNonRevisionCoordinatesMatch(input, project)
  );
}

export function approvedResetUnpublishNonRevisionCoordinatesMatch(
  input: ApprovedResetUnpublishInput,
  project: Pick<
    typeof siteProjects.$inferSelect,
    | "currentBuildId"
    | "currentKnowledgeSnapshotId"
    | "globalLiveDeploymentId"
    | "mainlandLiveDeploymentId"
    | "canonicalHostname"
  >,
) {
  return (
    project.currentBuildId === input.expectedCurrentBuildId &&
    project.currentKnowledgeSnapshotId === input.expectedKnowledgeSnapshotId &&
    project.globalLiveDeploymentId === input.expectedGlobalLiveDeploymentId &&
    project.mainlandLiveDeploymentId ===
      input.expectedMainlandLiveDeploymentId &&
    project.canonicalHostname === input.expectedCanonicalHostname
  );
}

/**
 * A decoupled reset intentionally clears the old build/live-head coordinates
 * before provider cleanup completes. The immutable epoch timestamp is the
 * fence: later local builds may advance the revision and current build, while
 * an old provider result can only reconcile the external coordinates frozen
 * in the reset input.
 */
export function approvedResetUnpublishFreshEpochMatches(
  input: ApprovedResetUnpublishInput,
  project: Pick<
    typeof siteProjects.$inferSelect,
    "revision" | "currentTaskStartedAt"
  >,
) {
  if (
    input.resetAppliedProjectRevision === undefined ||
    input.resetEpochStartedAt === undefined
  ) {
    return false;
  }
  return (
    project.revision >= input.resetAppliedProjectRevision &&
    resetEpochsMatch(project.currentTaskStartedAt, input.resetEpochStartedAt)
  );
}

/**
 * Exact fence for an Aliyun write that was already running when a decoupled
 * reset was approved. Timestamp ordering alone cannot distinguish two rows
 * created within one TIMESTAMP(0) second, so V5 freezes the old operation IDs
 * and this check also binds them to the reset revision and epoch.
 */
export function siteOpsRebuildResetFencesExternalOperation(
  value: string | null | undefined,
  input: {
    projectId: string;
    operationId: string;
    projectRevision: number;
    currentTaskStartedAt: Date;
  },
) {
  const note = parseSiteOpsRebuildNote(value);
  if (
    !note ||
    note.schemaVersion !== 5 ||
    note.resetEpochDecoupled !== true ||
    note.freshRootApplied !== true ||
    note.projectId !== input.projectId ||
    !note.frozenReset ||
    !note.awaitingExternalOperationIds.includes(input.operationId) ||
    note.resetAppliedProjectRevision === undefined ||
    input.projectRevision < note.resetAppliedProjectRevision
  ) {
    return false;
  }
  return (
    note.frozenReset.resetAppliedProjectRevision ===
      note.resetAppliedProjectRevision &&
    resetEpochsMatch(
      input.currentTaskStartedAt,
      note.frozenReset.resetEpochStartedAt!,
    )
  );
}

function parseSiteOpsRebuildNote(
  value: string | null | undefined,
): SiteOpsRebuildNote | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(value) as Record<string, unknown>;
    if (
      parsed.kind !== REBUILD_NOTE_KIND ||
      ![1, 2, 3, 4, 5].includes(Number(parsed.schemaVersion)) ||
      typeof parsed.projectId !== "string" ||
      (typeof parsed.sourceBuildId !== "string" &&
        !(
          [3, 4, 5].includes(Number(parsed.schemaVersion)) &&
          parsed.sourceBuildId === null
        )) ||
      (typeof parsed.knowledgeSnapshotId !== "string" &&
        !(
          [3, 4, 5].includes(Number(parsed.schemaVersion)) &&
          parsed.knowledgeSnapshotId === null
        ))
    ) {
      return null;
    }
    if (parsed.schemaVersion === 2) {
      if (
        typeof parsed.resetAppliedAt !== "string" ||
        !Number.isInteger(parsed.resetAppliedProjectRevision) ||
        Number(parsed.resetAppliedProjectRevision) < 1
      ) {
        return null;
      }
      return parsed as SiteOpsRebuildNoteV2;
    }
    if (parsed.schemaVersion === 3) {
      const hasResetTimestamp = typeof parsed.resetAppliedAt === "string";
      const hasResetRevision =
        Number.isInteger(parsed.resetAppliedProjectRevision) &&
        Number(parsed.resetAppliedProjectRevision) > 0;
      if (hasResetTimestamp !== hasResetRevision) return null;
      return parsed as SiteOpsRebuildNoteV3;
    }
    if (parsed.schemaVersion === 4) {
      const hasResetTimestamp = typeof parsed.resetAppliedAt === "string";
      const hasResetRevision =
        Number.isInteger(parsed.resetAppliedProjectRevision) &&
        Number(parsed.resetAppliedProjectRevision) > 0;
      const decoupled = parsed.resetEpochDecoupled === true;
      const frozenReset = parseApprovedResetUnpublishInput(parsed.frozenReset);
      const externalCleanupTimestampValid =
        parsed.externalCleanupCompletedAt === undefined ||
        typeof parsed.externalCleanupCompletedAt === "string";
      if (
        parsed.resetIntent !== APPROVED_RESET_UNPUBLISH ||
        typeof parsed.resetOperationId !== "string" ||
        !z.string().uuid().safeParse(parsed.resetOperationId).success ||
        typeof parsed.resetApprovedAt !== "string" ||
        !Number.isInteger(parsed.resetExpectedProjectRevision) ||
        Number(parsed.resetExpectedProjectRevision) < 1 ||
        !Number.isInteger(parsed.minimumKnowledgeSnapshotVersion) ||
        Number(parsed.minimumKnowledgeSnapshotVersion) < 1 ||
        hasResetTimestamp !== hasResetRevision ||
        !externalCleanupTimestampValid ||
        (decoupled
          ? !hasResetTimestamp ||
            parsed.freshRootApplied !== true ||
            parsed.unpublishOperationId !== parsed.resetOperationId ||
            !frozenReset ||
            frozenReset.expectedProjectRevision !==
              parsed.resetExpectedProjectRevision ||
            frozenReset.resetAppliedProjectRevision !==
              parsed.resetAppliedProjectRevision ||
            !resetEpochsMatch(
              frozenReset.resetEpochStartedAt!,
              String(parsed.resetAppliedAt),
            )
          : parsed.frozenReset !== undefined ||
            parsed.externalCleanupCompletedAt !== undefined ||
            (hasResetTimestamp
              ? parsed.freshRootApplied !== true ||
                parsed.unpublishOperationId !== parsed.resetOperationId
              : parsed.freshRootApplied !== undefined ||
                parsed.unpublishOperationId !== undefined))
      ) {
        return null;
      }
      return {
        ...parsed,
        ...(decoupled
          ? {
              frozenReset: frozenReset!,
              resetAppliedAt: siteOpsResetEpochAtDatabasePrecision(
                new Date(String(parsed.resetAppliedAt)),
              ).toISOString(),
            }
          : {}),
      } as SiteOpsRebuildNoteV4;
    }
    if (parsed.schemaVersion === 5) {
      const awaitingExternalOperationIds = Array.isArray(
        parsed.awaitingExternalOperationIds,
      )
        ? parsed.awaitingExternalOperationIds
        : [];
      const decoupled = parsed.resetEpochDecoupled === true;
      const frozenReset = parseApprovedResetUnpublishInput(parsed.frozenReset);
      const hasResetTimestamp = typeof parsed.resetAppliedAt === "string";
      const hasResetRevision =
        Number.isInteger(parsed.resetAppliedProjectRevision) &&
        Number(parsed.resetAppliedProjectRevision) > 0;
      if (
        parsed.resetIntent !== APPROVED_RESET_UNPUBLISH ||
        typeof parsed.resetApprovedAt !== "string" ||
        !Number.isInteger(parsed.minimumKnowledgeSnapshotVersion) ||
        Number(parsed.minimumKnowledgeSnapshotVersion) < 1 ||
        ![
          "awaiting_external_reconciliation",
          "awaiting_external_access",
        ].includes(String(parsed.resetActivationState)) ||
        (parsed.resetActivationState === "awaiting_external_reconciliation" &&
          awaitingExternalOperationIds.length < 1) ||
        (parsed.resetActivationState === "awaiting_external_access" &&
          awaitingExternalOperationIds.length !== 0) ||
        awaitingExternalOperationIds.length > 64 ||
        awaitingExternalOperationIds.some(
          (operationId) =>
            typeof operationId !== "string" ||
            !z.string().uuid().safeParse(operationId).success,
        ) ||
        new Set(awaitingExternalOperationIds).size !==
          awaitingExternalOperationIds.length ||
        (decoupled
          ? !hasResetTimestamp ||
            !hasResetRevision ||
            parsed.freshRootApplied !== true ||
            !frozenReset ||
            frozenReset.resetAppliedProjectRevision !==
              parsed.resetAppliedProjectRevision ||
            !resetEpochsMatch(
              frozenReset.resetEpochStartedAt!,
              String(parsed.resetAppliedAt),
            )
          : hasResetTimestamp ||
            hasResetRevision ||
            parsed.freshRootApplied !== undefined ||
            parsed.frozenReset !== undefined)
      ) {
        return null;
      }
      return {
        ...parsed,
        ...(decoupled
          ? {
              frozenReset: frozenReset!,
              resetAppliedAt: siteOpsResetEpochAtDatabasePrecision(
                new Date(String(parsed.resetAppliedAt)),
              ).toISOString(),
            }
          : {}),
      } as SiteOpsRebuildNoteV5;
    }
    return parsed as SiteOpsRebuildNoteV1;
  } catch {
    return null;
  }
}

export function siteOpsRebuildResetApplied(value: string | null | undefined) {
  const note = parseSiteOpsRebuildNote(value);
  return Boolean(
    note &&
      (note.schemaVersion === 2 ||
        ((note.schemaVersion === 3 || note.schemaVersion === 4) &&
          note.resetAppliedAt) ||
        (note.schemaVersion === 5 &&
          note.resetEpochDecoupled === true &&
          note.resetAppliedAt)),
  );
}

export function siteOpsRebuildResetPending(value: string | null | undefined) {
  const note = parseSiteOpsRebuildNote(value);
  return Boolean(
    note &&
      ((note.schemaVersion === 4 &&
        (note.resetEpochDecoupled === true
          ? !note.externalCleanupCompletedAt
          : !note.resetAppliedAt)) ||
        note.schemaVersion === 5),
  );
}

export type SiteOpsRebuildResetState =
  | "queued"
  | "reconciling"
  | "blocked"
  | "completed"
  | "invalidated";

export type SiteOpsRebuildResetIssue =
  | "esa_runtime_required"
  | "external_outcome_unknown"
  | "project_coordinates_changed";

export type SiteOpsRebuildResetProjection = {
  siteRebuildResetState: SiteOpsRebuildResetState | null;
  siteRebuildResetIssue: SiteOpsRebuildResetIssue | null;
  siteRebuildCanRecheck: boolean;
};

const EMPTY_SITEOPS_REBUILD_RESET_PROJECTION = {
  siteRebuildResetState: null,
  siteRebuildResetIssue: null,
  siteRebuildCanRecheck: false,
} as const satisfies SiteOpsRebuildResetProjection;

const RESET_RUNTIME_REQUIRED_CODES = new Set([
  "ESA_RUNTIME_DISABLED",
  "ESA_INSTANCE_NOT_CONFIGURED",
  "ESA_SERVICE_IDENTITY_NOT_CONFIGURED",
  "PROVIDER_NOT_CONFIGURED",
]);

export function siteOpsRebuildResetOperationId(
  value: string | null | undefined,
) {
  const note = parseSiteOpsRebuildNote(value);
  return note?.schemaVersion === 4 ? note.resetOperationId : null;
}

/**
 * Projects only a small, customer-safe reset control state. V5 exposes only
 * its durable queued approval; once upgraded, the exact V4 ticket coordinate
 * and pinned operation must agree before any provider status is trusted. Raw
 * provider errors and identifiers are never returned.
 */
export function projectSiteOpsRebuildReset(input: {
  ticketId: string;
  userId: number;
  internalNote: string | null | undefined;
  operation:
    | Pick<
        typeof siteOperations.$inferSelect,
        | "id"
        | "projectId"
        | "userId"
        | "kind"
        | "provider"
        | "status"
        | "input"
        | "result"
        | "errorCode"
        | "attempt"
        | "providerOperationId"
        | "providerTaskId"
      >
    | null
    | undefined;
}): SiteOpsRebuildResetProjection {
  const note = parseSiteOpsRebuildNote(input.internalNote);
  if (!note) {
    return EMPTY_SITEOPS_REBUILD_RESET_PROJECTION;
  }
  if (note.schemaVersion === 5) {
    return {
      siteRebuildResetState: "queued",
      siteRebuildResetIssue: null,
      siteRebuildCanRecheck: false,
    };
  }
  if (note.schemaVersion !== 4) return EMPTY_SITEOPS_REBUILD_RESET_PROJECTION;
  const operation = input.operation;
  const reset = operation
    ? parseApprovedResetFromOperationInput(operation.input)
    : null;
  const operationShapeValid = Boolean(
    operation &&
      operation.id === note.resetOperationId &&
      operation.projectId === note.projectId &&
      operation.userId === input.userId &&
      ((operation.kind === "rollback" && operation.provider === "aliyun_esa") ||
        (operation.kind === "dns_rollback" &&
          operation.provider === "aliyun_alidns")) &&
      reset &&
      reset.rebuildTicketId === input.ticketId &&
      reset.expectedProjectRevision === note.resetExpectedProjectRevision,
  );
  if (!operation || !reset || !operationShapeValid) {
    return {
      siteRebuildResetState: "invalidated",
      siteRebuildResetIssue: "project_coordinates_changed",
      siteRebuildCanRecheck: false,
    };
  }
  if (operation.errorCode === "SITEOPS_RESET_INVALIDATED") {
    return {
      siteRebuildResetState: "invalidated",
      siteRebuildResetIssue: "project_coordinates_changed",
      siteRebuildCanRecheck: false,
    };
  }
  const legacyResetCompleted = Boolean(
    note.resetAppliedAt &&
      note.resetAppliedProjectRevision &&
      note.resetEpochDecoupled !== true &&
      note.freshRootApplied === true &&
      note.unpublishOperationId === operation.id,
  );
  const decoupledResetCompleted = Boolean(
    note.resetEpochDecoupled === true &&
      note.externalCleanupCompletedAt &&
      note.resetAppliedAt &&
      note.resetAppliedProjectRevision &&
      note.freshRootApplied === true &&
      note.unpublishOperationId === operation.id,
  );
  const completionResult =
    completedFreshRootResetOperationResultV2Schema.safeParse(operation.result);
  const completionResultValid = Boolean(
    completionResult.success &&
      completionResult.data.resetOperationId === operation.id &&
      completionResult.data.projectId === note.projectId &&
      completionResult.data.minimumKnowledgeSnapshotVersion ===
        note.minimumKnowledgeSnapshotVersion &&
      completionResult.data.resetAppliedProjectRevision ===
        note.resetAppliedProjectRevision,
  );
  if (legacyResetCompleted || decoupledResetCompleted) {
    return operation.status === "succeeded" && completionResultValid
      ? {
          siteRebuildResetState: "completed",
          siteRebuildResetIssue: null,
          siteRebuildCanRecheck: false,
        }
      : {
          siteRebuildResetState: "invalidated",
          siteRebuildResetIssue: "project_coordinates_changed",
          siteRebuildCanRecheck: false,
        };
  }
  switch (operation.status) {
    case "queued":
      return {
        siteRebuildResetState: "queued",
        siteRebuildResetIssue: null,
        siteRebuildCanRecheck: false,
      };
    case "running":
    case "succeeded":
      return {
        siteRebuildResetState: "reconciling",
        siteRebuildResetIssue: null,
        siteRebuildCanRecheck: false,
      };
    case "outcome_unknown":
      return {
        siteRebuildResetState: "blocked",
        siteRebuildResetIssue: "external_outcome_unknown",
        siteRebuildCanRecheck: Boolean(
          operation.result != null ||
            operation.providerOperationId != null ||
            operation.providerTaskId != null,
        ),
      };
    case "failed":
    case "attention_required": {
      const errorCode = operation.errorCode ?? "";
      const safePreMutationRetry = Boolean(
        RESET_PRE_MUTATION_RETRY_CODES.has(errorCode) &&
          operation.result == null &&
          operation.providerOperationId == null &&
          operation.providerTaskId == null &&
          Number.isInteger(operation.attempt) &&
          operation.attempt >= 0 &&
          operation.attempt < 3,
      );
      return {
        siteRebuildResetState: "blocked",
        siteRebuildResetIssue: RESET_RUNTIME_REQUIRED_CODES.has(errorCode)
          ? "esa_runtime_required"
          : "external_outcome_unknown",
        siteRebuildCanRecheck: safePreMutationRetry,
      };
    }
    case "cancelled":
    default:
      return {
        siteRebuildResetState: "invalidated",
        siteRebuildResetIssue: "project_coordinates_changed",
        siteRebuildCanRecheck: false,
      };
  }
}

export function siteOpsRebuildMinimumSnapshotVersion(
  value: string | null | undefined,
) {
  const note = parseSiteOpsRebuildNote(value);
  return note?.schemaVersion === 4 || note?.schemaVersion === 5
    ? note.minimumKnowledgeSnapshotVersion
    : null;
}

export function siteOpsRebuildAcceptedForCurrentCycle(input: {
  internalNote: string | null | undefined;
  currentBuildId: string | null;
}) {
  const note = parseSiteOpsRebuildNote(input.internalNote);
  return Boolean(
    note &&
      siteOpsRebuildResetApplied(input.internalNote) &&
      note.sourceBuildId === input.currentBuildId,
  );
}

export function siteOpsRebuildRequestDisposition(input: {
  hasWorkflowProgress: boolean;
  ticketStatus: string | null;
  resetApplied: boolean;
}) {
  if (!input.hasWorkflowProgress) return "unavailable" as const;
  if (!input.ticketStatus) return "create" as const;
  if (input.ticketStatus === "in_progress" && input.resetApplied) {
    return "resubmit" as const;
  }
  return "pending" as const;
}

export class SiteOpsRebuildTicketError extends Error {
  constructor(
    public readonly code:
      | "BUILD_NOT_READY"
      | "DELIVERY_OWNER_NOT_ASSIGNED"
      | "ENTITLEMENT_NOT_FOUND"
      | "EXTERNAL_ACCESS_REQUIRED"
      | "IN_FLIGHT_OPERATION"
      | "INVALID_TICKET"
      | "TICKET_ALREADY_OPEN",
    message: string,
  ) {
    super(message);
    this.name = "SiteOpsRebuildTicketError";
  }
}

export function siteOpsRebuildDedupeKey(buildId: string) {
  return `site-rebuild:${buildId}`;
}

export function siteOpsRebuildProjectDedupeKey(projectId: string) {
  return `site-rebuild-project:${projectId}`;
}

export function siteOpsRebuildDeliveryClientRequestId(input: {
  userId: number;
  projectId: string;
  clientRequestId: string;
}) {
  const bytes = createHash("sha256")
    .update("frontmind.siteops-rebuild.delivery-request.v1\0", "utf8")
    .update(String(input.userId), "utf8")
    .update("\0", "utf8")
    .update(input.projectId.trim(), "utf8")
    .update("\0", "utf8")
    .update(input.clientRequestId.trim(), "utf8")
    .digest()
    .subarray(0, 16);
  bytes[6] = (bytes[6] & 0x0f) | 0x50;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export function siteOpsRebuildTargetPage(buildId: string) {
  return `${REBUILD_TARGET_PREFIX}${buildId}`;
}

export function siteOpsRebuildProjectTargetPage(projectId: string) {
  return `${REBUILD_PROJECT_TARGET_PREFIX}${projectId}`;
}

export function siteOpsRebuildProjectId(targetPage: string | null | undefined) {
  const value = targetPage?.trim() ?? "";
  const projectId = value.startsWith(REBUILD_PROJECT_TARGET_PREFIX)
    ? value.slice(REBUILD_PROJECT_TARGET_PREFIX.length)
    : "";
  return /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/iu.test(
    projectId,
  )
    ? projectId
    : null;
}

export function siteOpsRebuildResubmissionProjection(input: {
  projectId: string;
  internalNote: string | null | undefined;
}) {
  const note = parseSiteOpsRebuildNote(input.internalNote);
  if (
    !note ||
    note.schemaVersion === 1 ||
    note.schemaVersion === 5 ||
    !note.resetAppliedAt ||
    !note.resetAppliedProjectRevision
  ) {
    return null;
  }
  const projectScopedNote: SiteOpsRebuildNoteV3 | SiteOpsRebuildNoteV4 =
    note.schemaVersion === 4
      ? { ...note, projectId: input.projectId }
      : {
          schemaVersion: 3,
          kind: REBUILD_NOTE_KIND,
          projectId: input.projectId,
          sourceBuildId: note.sourceBuildId,
          knowledgeSnapshotId: note.knowledgeSnapshotId,
          resetAppliedAt: note.resetAppliedAt,
          resetAppliedProjectRevision: note.resetAppliedProjectRevision,
        };
  return {
    targetPage: siteOpsRebuildProjectTargetPage(input.projectId),
    technicalDedupeKey: siteOpsRebuildProjectDedupeKey(input.projectId),
    internalNote: JSON.stringify(projectScopedNote),
  };
}

export function siteOpsRebuildBuildId(targetPage: string | null | undefined) {
  const value = targetPage?.trim() ?? "";
  const buildId = value.startsWith(REBUILD_TARGET_PREFIX)
    ? value.slice(REBUILD_TARGET_PREFIX.length)
    : "";
  return /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/iu.test(
    buildId,
  )
    ? buildId
    : null;
}

function buildHasCompletePreview(
  build: typeof siteBuilds.$inferSelect | null | undefined,
) {
  return Boolean(
    build &&
      ["preview_ready", "approved"].includes(build.status) &&
      build.contractLocalAssetId &&
      build.sourceLocalAssetId &&
      build.distLocalAssetId &&
      build.qaLocalAssetId &&
      build.provenanceLocalAssetId,
  );
}

export async function loadSiteOpsRebuildRequest(
  executor: any,
  input: {
    userId: number;
    projectId: string;
    currentBuildId: string | null;
    hasWorkflowProgress?: boolean;
  },
) {
  const ticketDedupePredicate = input.currentBuildId
    ? or(
        eq(
          deliveryTickets.technicalDedupeKey,
          siteOpsRebuildDedupeKey(input.currentBuildId),
        ),
        eq(
          deliveryTickets.technicalDedupeKey,
          siteOpsRebuildProjectDedupeKey(input.projectId),
        ),
      )
    : eq(
        deliveryTickets.technicalDedupeKey,
        siteOpsRebuildProjectDedupeKey(input.projectId),
      );
  const [buildRows, ticketRows] = await Promise.all([
    input.currentBuildId
      ? executor
          .select()
          .from(siteBuilds)
          .where(
            and(
              eq(siteBuilds.id, input.currentBuildId),
              eq(siteBuilds.projectId, input.projectId),
              eq(siteBuilds.userId, input.userId),
            ),
          )
          .limit(1)
      : Promise.resolve([]),
    executor
      .select({
        id: deliveryTickets.id,
        status: deliveryTickets.status,
        internalNote: deliveryTickets.internalNote,
      })
      .from(deliveryTickets)
      .where(
        and(
          eq(deliveryTickets.userId, input.userId),
          eq(deliveryTickets.operation, "site_rebuild"),
          ticketDedupePredicate,
          inArray(deliveryTickets.status, ACTIVE_TICKET_STATUSES),
        ),
      )
      .orderBy(asc(deliveryTickets.createdAt))
      .limit(1),
  ]);
  const ticket = ticketRows[0];
  const activeNote = parseSiteOpsRebuildNote(ticket?.internalNote);
  const resetApplied = siteOpsRebuildResetApplied(ticket?.internalNote);
  const disposition = siteOpsRebuildRequestDisposition({
    hasWorkflowProgress:
      input.hasWorkflowProgress ??
      Boolean(input.currentBuildId || buildRows[0] || ticket),
    ticketStatus: ticket?.status ?? null,
    resetApplied,
  });
  return {
    allowed: disposition === "create" || disposition === "resubmit",
    ticketId: ticket?.id ?? null,
    status: ticket?.status ?? null,
    resetApplied,
    resetPending: siteOpsRebuildResetPending(ticket?.internalNote),
    // Kept in the public projection for older clients only. Snapshot floors
    // are no longer a SiteOps runtime boundary.
    minimumKnowledgeSnapshotVersion: null,
    resetSourceBuildId: activeNote?.sourceBuildId ?? null,
    acceptedForCurrentCycle: siteOpsRebuildAcceptedForCurrentCycle({
      // Only an active ticket may authorize work in its exact build cycle.
      internalNote: ticket?.internalNote,
      currentBuildId: input.currentBuildId,
    }),
  };
}

export async function createSiteOpsRebuildTicket(
  tx: any,
  input: {
    userId: number;
    projectId: string;
    currentBuildId: string | null;
    clientRequestId: string;
    reason?: string;
    quotaPeriodIds: string[];
    now: Date;
  },
) {
  const projectRows = await tx
    .select()
    .from(siteProjects)
    .where(
      and(
        eq(siteProjects.id, input.projectId),
        eq(siteProjects.userId, input.userId),
      ),
    )
    .limit(1)
    .for("update");
  const project = projectRows[0];
  if (!project || project.currentBuildId !== input.currentBuildId) {
    throw new SiteOpsRebuildTicketError(
      "BUILD_NOT_READY",
      "当前官网版本已变化，请刷新后重试。",
    );
  }
  if (
    !project.currentBuildId &&
    !project.currentKnowledgeSnapshotId &&
    project.status === "draft"
  ) {
    throw new SiteOpsRebuildTicketError(
      "BUILD_NOT_READY",
      "当前尚未开始建站流程，无需提交重置需求。",
    );
  }
  const buildRows = input.currentBuildId
    ? await tx
        .select()
        .from(siteBuilds)
        .where(
          and(
            eq(siteBuilds.id, input.currentBuildId),
            eq(siteBuilds.projectId, input.projectId),
            eq(siteBuilds.userId, input.userId),
          ),
        )
        .limit(1)
        .for("update")
    : [];
  const build = buildRows[0];
  if (input.currentBuildId && !build) {
    throw new SiteOpsRebuildTicketError(
      "BUILD_NOT_READY",
      "当前建站版本已变化，请刷新后重试。",
    );
  }
  const completedSourceBuild = buildHasCompletePreview(build) ? build : null;
  const technicalDedupeKey = completedSourceBuild
    ? siteOpsRebuildDedupeKey(completedSourceBuild.id)
    : siteOpsRebuildProjectDedupeKey(project.id);
  const activeDedupeKeys = Array.from(
    new Set([
      technicalDedupeKey,
      siteOpsRebuildProjectDedupeKey(project.id),
      ...(input.currentBuildId
        ? [siteOpsRebuildDedupeKey(input.currentBuildId)]
        : []),
    ]),
  );
  const openRows = await tx
    .select({
      id: deliveryTickets.id,
      status: deliveryTickets.status,
      internalNote: deliveryTickets.internalNote,
      revision: deliveryTickets.revision,
    })
    .from(deliveryTickets)
    .where(
      and(
        eq(deliveryTickets.userId, input.userId),
        inArray(deliveryTickets.technicalDedupeKey, activeDedupeKeys),
        inArray(deliveryTickets.status, ACTIVE_TICKET_STATUSES),
      ),
    )
    .limit(1)
    .for("update");
  const openTicket = openRows[0];
  const openTicketDisposition = siteOpsRebuildRequestDisposition({
    hasWorkflowProgress: true,
    ticketStatus: openTicket?.status ?? null,
    resetApplied: siteOpsRebuildResetApplied(openTicket?.internalNote),
  });
  if (openTicket && openTicketDisposition !== "resubmit") {
    throw new SiteOpsRebuildTicketError(
      "TICKET_ALREADY_OPEN",
      "当前官网版本已有一张重制工单。",
    );
  }
  if (input.quotaPeriodIds.length === 0) {
    throw new SiteOpsRebuildTicketError(
      "ENTITLEMENT_NOT_FOUND",
      "当前服务权益无法创建重制工单。",
    );
  }
  const periodRows = await tx
    .select()
    .from(serviceQuotaPeriods)
    .where(
      and(
        eq(serviceQuotaPeriods.userId, input.userId),
        inArray(serviceQuotaPeriods.id, input.quotaPeriodIds),
      ),
    )
    .orderBy(asc(serviceQuotaPeriods.startsAt))
    .limit(1);
  const period = periodRows[0];
  if (!period) {
    throw new SiteOpsRebuildTicketError(
      "ENTITLEMENT_NOT_FOUND",
      "当前服务权益无法创建重制工单。",
    );
  }
  const ownerRows = await tx
    .select({
      projectAssignmentId: deliveryProjectAssignments.id,
      memberId: deliveryProjectAssignments.engineerUserId,
    })
    .from(deliveryProjectAssignments)
    .innerJoin(users, eq(users.id, deliveryProjectAssignments.engineerUserId))
    .where(
      and(
        eq(deliveryProjectAssignments.customerUserId, input.userId),
        eq(deliveryProjectAssignments.roleType, "ai_operations_engineer"),
        eq(users.role, "delivery_member"),
        eq(users.engineerRoleType, "ai_operations_engineer"),
        eq(users.isActive, true),
      ),
    )
    .limit(1)
    .for("update");
  const owner = ownerRows[0];
  if (!owner?.memberId) {
    throw new SiteOpsRebuildTicketError(
      "DELIVERY_OWNER_NOT_ASSIGNED",
      "当前业务尚未配置 AI 运营负责人。",
    );
  }
  const ticketId = randomUUID();
  const reason = input.reason?.trim().slice(0, 4_000) || "希望重新制作官网。";
  const deliveryClientRequestId = siteOpsRebuildDeliveryClientRequestId({
    userId: input.userId,
    projectId: input.projectId,
    clientRequestId: input.clientRequestId,
  });
  if (openTicket) {
    const resubmission = siteOpsRebuildResubmissionProjection({
      projectId: project.id,
      internalNote: openTicket.internalNote,
    });
    if (!resubmission) {
      throw new SiteOpsRebuildTicketError(
        "INVALID_TICKET",
        "官网重制工单缺少有效的重置记录。",
      );
    }
    const message = "客户再次提交官网重制需求，等待 FrontMind 通过重置。";
    await tx
      .update(deliveryTickets)
      .set({
        status: "submitted",
        ...resubmission,
        description: reason,
        publicSummary: message,
        resolvedAt: null,
        revision: openTicket.revision + 1,
        updatedByUserId: input.userId,
        updatedAt: input.now,
      })
      .where(
        and(
          eq(deliveryTickets.id, openTicket.id),
          eq(deliveryTickets.revision, openTicket.revision),
        ),
      );
    await tx.insert(deliveryTicketEvents).values({
      id: randomUUID(),
      ticketId: openTicket.id,
      userId: input.userId,
      actorUserId: input.userId,
      actorRole: "user",
      kind: "status_change",
      visibility: "customer",
      clientRequestId: deliveryClientRequestId,
      message: reason,
      fromStatus: openTicket.status,
      toStatus: "submitted",
      createdAt: input.now,
    });
    return {
      ticketId: openTicket.id,
      buildId: completedSourceBuild?.id ?? input.currentBuildId,
      resubmitted: true,
    };
  }
  await tx.insert(deliveryTickets).values({
    id: ticketId,
    isWorkflowContainer: false,
    userId: input.userId,
    contractId: period.contractId,
    quotaPeriodId: period.id,
    type: "website_operation",
    quotaPool: null,
    quotaState: "consumed",
    ordinal: 0,
    clientRequestId: deliveryClientRequestId,
    category: "site_rebuild",
    topic: "官网重制",
    title: "官网重制需求",
    description: reason,
    targetPage: completedSourceBuild
      ? siteOpsRebuildTargetPage(completedSourceBuild.id)
      : siteOpsRebuildProjectTargetPage(project.id),
    knowledgeSnapshotId:
      project.currentKnowledgeSnapshotId ??
      completedSourceBuild?.knowledgeSnapshotId ??
      null,
    workflowDomain: "ai_operations_engineer",
    operation: "site_rebuild",
    assignedProjectAssignmentId: owner.projectAssignmentId,
    assignedMemberId: owner.memberId,
    technicalDedupeKey,
    internalNote: JSON.stringify({
      schemaVersion: 3,
      kind: REBUILD_NOTE_KIND,
      projectId: project.id,
      sourceBuildId: completedSourceBuild?.id ?? null,
      knowledgeSnapshotId:
        project.currentKnowledgeSnapshotId ??
        completedSourceBuild?.knowledgeSnapshotId ??
        null,
    }),
    materialUrls: [],
    status: "submitted",
    publicSummary: "官网重制需求已提交，等待 FrontMind 受理。",
    createdByUserId: input.userId,
    updatedByUserId: input.userId,
    createdAt: input.now,
    updatedAt: input.now,
  });
  await tx.insert(deliveryTicketEvents).values({
    id: randomUUID(),
    ticketId,
    userId: input.userId,
    actorUserId: input.userId,
    actorRole: "user",
    kind: "created",
    visibility: "customer",
    clientRequestId: deliveryClientRequestId,
    message: reason,
    toStatus: "submitted",
    createdAt: input.now,
  });
  return {
    ticketId,
    buildId: completedSourceBuild?.id ?? input.currentBuildId,
    resubmitted: false,
  };
}

async function queueApprovedResetFromLatestCoordinates(
  tx: any,
  input: {
    ticketId: string;
    project: typeof siteProjects.$inferSelect;
    sourceBuildId: string | null;
    knowledgeSnapshotId: string | null;
    resetApprovedAt: string;
    minimumKnowledgeSnapshotVersion: number;
    frozenReset?: ApprovedResetUnpublishInput;
    resetAppliedProjectRevision?: number;
    resetAppliedAt?: string;
    now: Date;
  },
) {
  const resetOperationId = randomUUID();
  const resetInput = input.frozenReset
    ? approvedResetUnpublishInputSchema.parse(input.frozenReset)
    : approvedResetUnpublishInputSchema.parse({
        schemaVersion: 1,
        intent: APPROVED_RESET_UNPUBLISH,
        rebuildTicketId: input.ticketId,
        expectedProjectRevision: input.project.revision,
        expectedCurrentBuildId: input.project.currentBuildId ?? null,
        expectedKnowledgeSnapshotId:
          input.project.currentKnowledgeSnapshotId ?? null,
        expectedGlobalLiveDeploymentId:
          input.project.globalLiveDeploymentId ?? null,
        expectedMainlandLiveDeploymentId:
          input.project.mainlandLiveDeploymentId ?? null,
        expectedCanonicalHostname: input.project.canonicalHostname ?? null,
      });
  const profileRows = await tx
    .select({ domainRevision: workspaceSiteProfiles.domainRevision })
    .from(workspaceSiteProfiles)
    .where(eq(workspaceSiteProfiles.userId, input.project.userId))
    .limit(1);
  const currentDomainRevision = profileRows[0]?.domainRevision ?? null;
  const rollbackRows = currentDomainRevision
    ? await tx
        .select({ id: siteDnsRecords.id })
        .from(siteDnsRecords)
        .where(
          and(
            eq(siteDnsRecords.projectId, input.project.id),
            eq(siteDnsRecords.userId, input.project.userId),
            eq(siteDnsRecords.domainRevision, currentDomainRevision),
          ),
        )
        .limit(1)
    : [];
  const connectionRows =
    rollbackRows.length > 0
      ? await tx
          .select({ id: siteProviderConnections.id })
          .from(siteProviderConnections)
          .where(
            and(
              eq(siteProviderConnections.projectId, input.project.id),
              eq(siteProviderConnections.userId, input.project.userId),
              eq(siteProviderConnections.provider, "aliyun_cn"),
              eq(siteProviderConnections.status, "active"),
            ),
          )
          .limit(1)
      : [];
  if (rollbackRows.length > 0 && !connectionRows[0]) {
    throw new SiteOpsRebuildTicketError(
      "EXTERNAL_ACCESS_REQUIRED",
      "官网重置已获批准，等待恢复外部域名访问后继续安全下线。",
    );
  }
  const resetOperationInput = connectionRows[0]
    ? {
        connectionId: connectionRows[0].id,
        domainRevision: currentDomainRevision!,
        dnsIntent: "rollback" as const,
        approvedReset: resetInput,
      }
    : resetInput;
  const resetOperationKind = connectionRows[0]
    ? ("dns_rollback" as const)
    : ("rollback" as const);
  const resetOperationProvider = connectionRows[0]
    ? ("aliyun_alidns" as const)
    : ("aliyun_esa" as const);
  const resetInputHash = createHash("sha256")
    .update(JSON.stringify(resetOperationInput), "utf8")
    .digest("hex");
  await tx.insert(siteOperations).values({
    id: resetOperationId,
    projectId: input.project.id,
    userId: input.project.userId,
    conversationTurnId: null,
    buildId: input.sourceBuildId,
    kind: resetOperationKind,
    status: "queued",
    clientRequestId: `site-rebuild-unpublish:${input.ticketId}:${resetInput.expectedProjectRevision}`,
    inputHash: resetInputHash,
    input: resetOperationInput,
    provider: resetOperationProvider,
    attempt: 0,
    createdAt: input.now,
    updatedAt: input.now,
  });
  const upgradedNote: SiteOpsRebuildNoteV4 = {
    schemaVersion: 4,
    kind: REBUILD_NOTE_KIND,
    projectId: input.project.id,
    sourceBuildId: input.sourceBuildId,
    knowledgeSnapshotId: input.knowledgeSnapshotId,
    resetIntent: APPROVED_RESET_UNPUBLISH,
    resetOperationId,
    resetApprovedAt: input.resetApprovedAt,
    resetExpectedProjectRevision: input.project.revision,
    minimumKnowledgeSnapshotVersion: input.minimumKnowledgeSnapshotVersion,
    ...(input.frozenReset &&
    input.resetAppliedProjectRevision !== undefined &&
    input.resetAppliedAt
      ? {
          resetExpectedProjectRevision: resetInput.expectedProjectRevision,
          resetEpochDecoupled: true as const,
          frozenReset: resetInput,
          resetAppliedAt: input.resetAppliedAt,
          resetAppliedProjectRevision: input.resetAppliedProjectRevision,
          freshRootApplied: true as const,
          unpublishOperationId: resetOperationId,
        }
      : {}),
  };
  return { resetOperationId, upgradedNote };
}

async function applyFreshLocalResetEpoch(
  tx: any,
  input: {
    ticketId: string;
    project: typeof siteProjects.$inferSelect;
    expectedRevision: number;
    knowledgeInputEpochId: string;
    resetEpochStartedAt: Date;
    now: Date;
  },
) {
  const nextRevision = input.expectedRevision + 1;
  const sequenceRows = await tx
    .select({ sequence: max(messages.sequence) })
    .from(messages)
    .where(eq(messages.conversationId, input.project.conversationId));
  const projectUpdate = await tx
    .update(siteProjects)
    .set({
      currentKnowledgeSnapshotId: input.project.currentKnowledgeSnapshotId,
      currentBuildId: null,
      globalLiveDeploymentId: null,
      mainlandLiveDeploymentId: null,
      canonicalHostname: null,
      knowledgeInputEpochId: input.knowledgeInputEpochId,
      currentTaskStartedAt: input.resetEpochStartedAt,
      minimumKnowledgeSnapshotVersion: null,
      brief: null,
      status: "draft",
      revision: nextRevision,
      updatedAt: input.now,
    })
    .where(
      and(
        eq(siteProjects.id, input.project.id),
        eq(siteProjects.userId, input.project.userId),
        eq(siteProjects.revision, input.expectedRevision),
        nullableCoordinate(
          siteProjects.currentBuildId,
          input.project.currentBuildId,
        ),
        nullableCoordinate(
          siteProjects.currentKnowledgeSnapshotId,
          input.project.currentKnowledgeSnapshotId,
        ),
        nullableCoordinate(
          siteProjects.globalLiveDeploymentId,
          input.project.globalLiveDeploymentId,
        ),
        nullableCoordinate(
          siteProjects.mainlandLiveDeploymentId,
          input.project.mainlandLiveDeploymentId,
        ),
        nullableCoordinate(
          siteProjects.canonicalHostname,
          input.project.canonicalHostname,
        ),
      ),
    );
  if (affectedRows(projectUpdate) !== 1) {
    throw new SiteOpsRebuildTicketError(
      "IN_FLIGHT_OPERATION",
      "建站项目在重置批准期间已变化，请刷新后重试。",
    );
  }

  await tx
    .update(siteBuilds)
    .set({
      status: "cancelled",
      errorCode: "SITEOPS_RESET_APPROVED",
      errorMessage: "官网重置已获批准，旧生成任务已停止。",
      updatedAt: input.now,
    })
    .where(
      and(
        eq(siteBuilds.projectId, input.project.id),
        eq(siteBuilds.userId, input.project.userId),
        inArray(siteBuilds.status, [
          "preparing",
          "visual_searching",
          "awaiting_visual_selection",
          "design_compiling",
          "contract_ready",
          "building",
          "qa_running",
          "failed",
          "attention_required",
        ]),
      ),
    );
  await tx
    .update(siteBuilds)
    .set({ status: "superseded", updatedAt: input.now })
    .where(
      and(
        eq(siteBuilds.projectId, input.project.id),
        eq(siteBuilds.userId, input.project.userId),
        inArray(siteBuilds.status, ["preview_ready", "approved"]),
      ),
    );
  await tx
    .update(siteBuilds)
    .set({ quotaState: "released", updatedAt: input.now })
    .where(
      and(
        eq(siteBuilds.projectId, input.project.id),
        eq(siteBuilds.userId, input.project.userId),
        eq(siteBuilds.quotaState, "reserved"),
      ),
    );

  const candidatePoolRows = await tx
    .select({ id: visualCandidatePools.id })
    .from(visualCandidatePools)
    .where(
      and(
        eq(visualCandidatePools.projectId, input.project.id),
        eq(visualCandidatePools.userId, input.project.userId),
        inArray(visualCandidatePools.status, ["active", "selected"]),
      ),
    )
    .for("update");
  const candidatePoolIds = candidatePoolRows.map(
    (pool: { id: string }) => pool.id,
  );
  if (candidatePoolIds.length > 0) {
    await tx
      .update(visualCandidatePoolPages)
      .set({ status: "superseded", updatedAt: input.now })
      .where(
        and(
          inArray(visualCandidatePoolPages.poolId, candidatePoolIds),
          inArray(visualCandidatePoolPages.status, [
            "reserved",
            "published",
            "selected",
          ]),
        ),
      );
    await tx
      .update(visualCandidatePools)
      .set({ status: "superseded", updatedAt: input.now })
      .where(
        and(
          inArray(visualCandidatePools.id, candidatePoolIds),
          inArray(visualCandidatePools.status, ["active", "selected"]),
        ),
      );
  }
  await tx
    .update(websiteStyleSampleBatches)
    .set({ status: "superseded", updatedAt: input.now })
    .where(
      and(
        eq(websiteStyleSampleBatches.siteProjectId, input.project.id),
        eq(websiteStyleSampleBatches.userId, input.project.userId),
        eq(websiteStyleSampleBatches.sourceKind, "siteops_21st"),
        inArray(websiteStyleSampleBatches.status, ["published", "selected"]),
      ),
    );

  await tx
    .update(messages)
    .set({ deletedAt: input.now, updatedAt: input.now })
    .where(
      and(
        eq(messages.conversationId, input.project.conversationId),
        eq(messages.userId, input.project.userId),
        isNull(messages.deletedAt),
      ),
    );
  await tx.insert(messages).values({
    id: randomUUID(),
    conversationId: input.project.conversationId,
    userId: input.project.userId,
    role: "assistant",
    content: "重置已批准，可从当前知识库重新开始",
    sequence: Number(sequenceRows[0]?.sequence ?? 0) + 1,
    metadata: {
      siteOps: {
        kind: "brief_question",
        subjectId: input.ticketId,
        revision: nextRevision,
        status: "active",
        payload: {
          rebuildTicketId: input.ticketId,
          requested: "reuse_current_knowledge",
          reset: true,
          freshRootApplied: true,
          unpublishCompleted: false,
        },
      },
    },
  });
  return nextRevision;
}

export async function approveSiteOpsRebuildTicket(
  tx: any,
  input: {
    ticket: typeof deliveryTickets.$inferSelect;
    actorUserId: number;
    now: Date;
    reapply?: boolean;
    allowPendingRetry?: boolean;
  },
) {
  if (input.ticket.operation !== "site_rebuild") return null;
  const existingNote = parseSiteOpsRebuildNote(input.ticket.internalNote);
  const targetBuildId = siteOpsRebuildBuildId(input.ticket.targetPage);
  const targetProjectId = siteOpsRebuildProjectId(input.ticket.targetPage);
  if (
    !existingNote ||
    ([3, 4, 5].includes(existingNote.schemaVersion)
      ? targetProjectId !== existingNote.projectId &&
        targetBuildId !== existingNote.sourceBuildId
      : targetBuildId !== existingNote.sourceBuildId)
  ) {
    throw new SiteOpsRebuildTicketError(
      "INVALID_TICKET",
      "官网重制工单缺少有效的项目或原版本坐标。",
    );
  }
  const projectRows = await tx
    .select()
    .from(siteProjects)
    .where(
      and(
        eq(siteProjects.id, existingNote.projectId),
        eq(siteProjects.userId, input.ticket.userId),
      ),
    )
    .limit(1)
    .for("update");
  const project = projectRows[0];
  if (!project) {
    throw new SiteOpsRebuildTicketError(
      "BUILD_NOT_READY",
      "当前建站项目已变化或不再满足重制条件。",
    );
  }
  const currentBuildRows = project.currentBuildId
    ? await tx
        .select()
        .from(siteBuilds)
        .where(
          and(
            eq(siteBuilds.id, project.currentBuildId),
            eq(siteBuilds.projectId, project.id),
            eq(siteBuilds.userId, input.ticket.userId),
          ),
        )
        .limit(1)
        .for("update")
    : [];
  const currentBuild = currentBuildRows[0];
  if (project.currentBuildId && !currentBuild) {
    throw new SiteOpsRebuildTicketError(
      "BUILD_NOT_READY",
      "当前建站版本已变化，请刷新后重试。",
    );
  }
  if (existingNote.schemaVersion !== 3) {
    if (existingNote.schemaVersion === 4 || existingNote.schemaVersion === 5) {
      // V4/V5 are already project-scoped. V4 carries the immutable reset
      // coordinate; V5 carries the earlier approval while an existing Aliyun
      // write finishes read-only reconciliation.
    } else if (
      !currentBuild ||
      currentBuild.id !== existingNote.sourceBuildId ||
      currentBuild.knowledgeSnapshotId !== existingNote.knowledgeSnapshotId ||
      !buildHasCompletePreview(currentBuild)
    ) {
      throw new SiteOpsRebuildTicketError(
        "BUILD_NOT_READY",
        "原官网版本已变化或不再满足重制条件。",
      );
    }
  }
  if (existingNote.schemaVersion === 5) {
    return {
      projectId: project.id,
      sourceBuildId: existingNote.sourceBuildId,
      resetApplied: true as const,
      resetPending: true as const,
      resetOperationId: null,
      resetAppliedProjectRevision:
        existingNote.resetAppliedProjectRevision ?? project.revision,
      pendingReplay: true as const,
      internalNote: JSON.stringify(existingNote),
    };
  }
  if (
    existingNote.schemaVersion === 4 &&
    (existingNote.resetEpochDecoupled === true
      ? !existingNote.externalCleanupCompletedAt
      : !existingNote.resetAppliedAt) &&
    !input.reapply
  ) {
    const resetOperationRows = await tx
      .select()
      .from(siteOperations)
      .where(
        and(
          eq(siteOperations.id, existingNote.resetOperationId),
          eq(siteOperations.projectId, project.id),
          eq(siteOperations.userId, project.userId),
        ),
      )
      .limit(1)
      .for("update");
    const resetOperation = resetOperationRows[0];
    const resetInput = resetOperation
      ? parseApprovedResetFromOperationInput(resetOperation.input)
      : null;
    const resetOperationShapeValid = Boolean(
      resetOperation &&
        ((resetOperation.kind === "rollback" &&
          resetOperation.provider === "aliyun_esa") ||
          (resetOperation.kind === "dns_rollback" &&
            resetOperation.provider === "aliyun_alidns")),
    );
    if (
      !resetOperation ||
      resetOperation.id !== existingNote.resetOperationId ||
      resetOperation.projectId !== project.id ||
      resetOperation.userId !== project.userId ||
      !resetOperationShapeValid ||
      !resetInput ||
      resetInput.rebuildTicketId !== input.ticket.id ||
      resetInput.expectedProjectRevision !==
        existingNote.resetExpectedProjectRevision
    ) {
      throw new SiteOpsRebuildTicketError(
        "INVALID_TICKET",
        "官网重置下线任务坐标不一致，不能重放或重新排队。",
      );
    }
    const pendingResult = {
      projectId: project.id,
      sourceBuildId: existingNote.sourceBuildId,
      resetApplied: true as const,
      resetPending: true as const,
      resetOperationId: existingNote.resetOperationId,
      resetAppliedProjectRevision:
        existingNote.resetAppliedProjectRevision ??
        existingNote.resetExpectedProjectRevision,
      internalNote: JSON.stringify(existingNote),
    };
    if (["queued", "running"].includes(resetOperation.status)) {
      return { ...pendingResult, pendingReplay: true as const };
    }
    if (resetOperation.status === "outcome_unknown") {
      if (!input.allowPendingRetry) {
        throw new SiteOpsRebuildTicketError(
          "INVALID_TICKET",
          "需求已被更新，请刷新后重试。",
        );
      }
      const hasMutationBoundary =
        resetOperation.result != null ||
        resetOperation.providerOperationId != null ||
        resetOperation.providerTaskId != null;
      if (!hasMutationBoundary) {
        throw new SiteOpsRebuildTicketError(
          "INVALID_TICKET",
          "官网重置下线任务缺少可核对的外部变更边界，不能盲目重新执行。",
        );
      }
      const reconciliationUpdate = await tx
        .update(siteOperations)
        .set({
          status: "queued",
          leaseOwner: null,
          leaseExpiresAt: null,
          completedAt: null,
          updatedAt: input.now,
        })
        .where(
          and(
            eq(siteOperations.id, existingNote.resetOperationId),
            eq(siteOperations.projectId, project.id),
            eq(siteOperations.userId, project.userId),
            eq(siteOperations.kind, resetOperation.kind),
            eq(siteOperations.provider, resetOperation.provider),
            eq(siteOperations.status, "outcome_unknown"),
          ),
        );
      if (affectedRows(reconciliationUpdate) !== 1) {
        throw new SiteOpsRebuildTicketError(
          "IN_FLIGHT_OPERATION",
          "官网重置下线任务已变化，未重新排队，请刷新后重试。",
        );
      }
      return { ...pendingResult, resetRequeued: true as const };
    }
    if (!["failed", "attention_required"].includes(resetOperation.status)) {
      throw new SiteOpsRebuildTicketError(
        "INVALID_TICKET",
        "官网重置下线任务已结束且不能安全重试。",
      );
    }
    if (!input.allowPendingRetry) {
      throw new SiteOpsRebuildTicketError(
        "INVALID_TICKET",
        "需求已被更新，请刷新后重试。",
      );
    }
    const retryErrorCode = resetOperation.errorCode;
    const hasMutationBoundary =
      resetOperation.result != null ||
      resetOperation.providerOperationId != null ||
      resetOperation.providerTaskId != null;
    const attempt = Number(resetOperation.attempt ?? 0);
    if (
      typeof retryErrorCode !== "string" ||
      !RESET_PRE_MUTATION_RETRY_CODES.has(retryErrorCode) ||
      hasMutationBoundary ||
      !Number.isInteger(attempt) ||
      attempt < 0 ||
      attempt >= 3
    ) {
      throw new SiteOpsRebuildTicketError(
        "INVALID_TICKET",
        "官网重置下线任务已失败，因已触达外部变更边界、错误不可重试或重试次数已用尽，不能盲目重新执行。",
      );
    }
    const retryUpdate = await tx
      .update(siteOperations)
      .set({
        status: "queued",
        leaseOwner: null,
        leaseExpiresAt: null,
        errorCode: null,
        errorMessage: null,
        completedAt: null,
        updatedAt: input.now,
      })
      .where(
        and(
          eq(siteOperations.id, existingNote.resetOperationId),
          eq(siteOperations.projectId, project.id),
          eq(siteOperations.userId, project.userId),
          eq(siteOperations.kind, resetOperation.kind),
          eq(siteOperations.provider, resetOperation.provider),
          eq(siteOperations.status, resetOperation.status),
          eq(siteOperations.errorCode, retryErrorCode),
          eq(siteOperations.attempt, attempt),
          isNull(siteOperations.result),
          isNull(siteOperations.providerOperationId),
          isNull(siteOperations.providerTaskId),
        ),
      );
    if (affectedRows(retryUpdate) !== 1) {
      throw new SiteOpsRebuildTicketError(
        "IN_FLIGHT_OPERATION",
        "官网重置下线任务已变化，未重新排队，请刷新后重试。",
      );
    }
    return { ...pendingResult, resetRequeued: true as const };
  }
  if (siteOpsRebuildResetApplied(input.ticket.internalNote) && !input.reapply) {
    if (
      existingNote.schemaVersion === 1 ||
      !existingNote.resetAppliedProjectRevision
    ) {
      throw new SiteOpsRebuildTicketError(
        "INVALID_TICKET",
        "官网重制工单缺少有效的重置记录。",
      );
    }
    return {
      projectId: project.id,
      sourceBuildId: existingNote.sourceBuildId,
      resetApplied: true as const,
      resetAppliedProjectRevision: existingNote.resetAppliedProjectRevision,
      internalNote: JSON.stringify(existingNote),
    };
  }
  const activeOperationRows = await tx
    .select({
      id: siteOperations.id,
      kind: siteOperations.kind,
      provider: siteOperations.provider,
      status: siteOperations.status,
      attempt: siteOperations.attempt,
      result: siteOperations.result,
      providerOperationId: siteOperations.providerOperationId,
      providerTaskId: siteOperations.providerTaskId,
    })
    .from(siteOperations)
    .where(
      and(
        eq(siteOperations.projectId, project.id),
        gte(siteOperations.createdAt, project.currentTaskStartedAt),
        inArray(siteOperations.status, RESET_RETIRABLE_GENERATION_STATUSES),
      ),
    )
    .for("update");
  const now = input.now;
  const resetEpochStartedAt = siteOpsResetEpochAtDatabasePrecision(now);
  const resetEpochStartedAtIso = resetEpochStartedAt.toISOString();
  const knowledgeInputEpochId = randomUUID();
  const frozenProject = { ...project };
  const resetAppliedProjectRevision = project.revision + 1;
  const frozenReset = approvedResetUnpublishInputSchema.parse({
    schemaVersion: 1,
    intent: APPROVED_RESET_UNPUBLISH,
    rebuildTicketId: input.ticket.id,
    expectedProjectRevision: project.revision,
    expectedCurrentBuildId: project.currentBuildId ?? null,
    expectedKnowledgeSnapshotId: project.currentKnowledgeSnapshotId ?? null,
    expectedGlobalLiveDeploymentId: project.globalLiveDeploymentId ?? null,
    expectedMainlandLiveDeploymentId: project.mainlandLiveDeploymentId ?? null,
    expectedCanonicalHostname: project.canonicalHostname ?? null,
    resetAppliedProjectRevision,
    resetEpochStartedAt: resetEpochStartedAtIso,
  });
  const typedActiveOperationRows = activeOperationRows as Array<{
    id: string;
    kind: string;
    provider: string | null;
    status: string;
    attempt: number;
    result: unknown;
    providerOperationId: string | null;
    providerTaskId: string | null;
  }>;
  const localCancelableRows = typedActiveOperationRows.filter((row) =>
    localResetRetirableOperation(row),
  );
  const cancelableIds = new Set(localCancelableRows.map((row) => row.id));
  const externalReconciliationRows = typedActiveOperationRows.filter(
    (row) =>
      !cancelableIds.has(row.id) &&
      ACTIVE_SITE_OPERATION_STATUSES.includes(row.status as never) &&
      knownAliyunWriteOperation(row),
  );
  const externalReconciliationIds = new Set(
    externalReconciliationRows.map((row) => row.id),
  );
  const blockedOperationRows = typedActiveOperationRows.filter(
    (row) =>
      ACTIVE_SITE_OPERATION_STATUSES.includes(row.status as never) &&
      !cancelableIds.has(row.id) &&
      !externalReconciliationIds.has(row.id),
  );
  if (blockedOperationRows.length > 0) {
    throw new SiteOpsRebuildTicketError(
      "IN_FLIGHT_OPERATION",
      "当前仍有已开始的生成、发布或 DNS 操作，需按原任务完成只读对账后再批准重置。",
    );
  }
  const localOperationIds = localCancelableRows.map(
    (row: { id: string }) => row.id,
  );
  if (localOperationIds.length > 0) {
    const cancelled = await tx
      .update(siteOperations)
      .set({
        status: "cancelled",
        leaseOwner: null,
        leaseExpiresAt: null,
        errorCode: "SITEOPS_RESET_APPROVED",
        errorMessage: "官网重置已获批准，旧生成任务已停止。",
        completedAt: now,
        updatedAt: now,
      })
      .where(
        and(
          inArray(siteOperations.id, localOperationIds),
          inArray(siteOperations.status, RESET_RETIRABLE_GENERATION_STATUSES),
          or(
            and(
              eq(siteOperations.kind, "visual_search"),
              eq(siteOperations.provider, "21st"),
            ),
            and(
              inArray(siteOperations.kind, [
                "site_build",
                "build_revision",
                "social_package",
              ]),
              eq(siteOperations.provider, "manus"),
            ),
          ),
        ),
      );
    if (affectedRows(cancelled) !== localOperationIds.length) {
      throw new SiteOpsRebuildTicketError(
        "IN_FLIGHT_OPERATION",
        "旧生成任务状态已变化，未启动重置，请刷新后重试。",
      );
    }
    await tx
      .update(socialPackages)
      .set({
        status: "cancelled",
        errorCode: "SITEOPS_RESET_APPROVED",
        errorMessage: "官网重置已获批准，旧生成任务已停止。",
        updatedAt: now,
      })
      .where(
        and(
          inArray(socialPackages.operationId, localOperationIds),
          inArray(socialPackages.status, ["queued", "building"]),
        ),
      );
    await tx
      .update(socialPackages)
      .set({ quotaState: "released", updatedAt: now })
      .where(
        and(
          inArray(socialPackages.operationId, localOperationIds),
          eq(socialPackages.quotaState, "reserved"),
        ),
      );
  }
  // V4/V5 keep this positive coordinate only for compatibility with already
  // persisted tickets and provider results. It is not a knowledge freshness
  // floor: SiteOps resets preserve the account's current active snapshot.
  const minimumKnowledgeSnapshotVersion = 1;
  const preservedBuildId = project.currentBuildId ?? existingNote.sourceBuildId;
  await applyFreshLocalResetEpoch(tx, {
    ticketId: input.ticket.id,
    project: frozenProject as typeof siteProjects.$inferSelect,
    expectedRevision: frozenProject.revision,
    knowledgeInputEpochId,
    resetEpochStartedAt,
    now,
  });
  if (externalReconciliationRows.length > 0) {
    const deferredNote: SiteOpsRebuildNoteV5 = {
      schemaVersion: 5,
      kind: REBUILD_NOTE_KIND,
      projectId: project.id,
      sourceBuildId: preservedBuildId,
      knowledgeSnapshotId:
        project.currentKnowledgeSnapshotId ??
        currentBuild?.knowledgeSnapshotId ??
        existingNote.knowledgeSnapshotId,
      resetIntent: APPROVED_RESET_UNPUBLISH,
      resetApprovedAt: now.toISOString(),
      minimumKnowledgeSnapshotVersion,
      resetActivationState: "awaiting_external_reconciliation",
      awaitingExternalOperationIds: externalReconciliationRows.map(
        (row) => row.id,
      ),
      resetEpochDecoupled: true,
      resetAppliedAt: resetEpochStartedAtIso,
      resetAppliedProjectRevision,
      freshRootApplied: true,
      frozenReset,
    };
    return {
      projectId: project.id,
      sourceBuildId: preservedBuildId,
      resetApplied: true as const,
      resetPending: true as const,
      resetOperationId: null,
      resetAppliedProjectRevision,
      internalNote: JSON.stringify(deferredNote),
    };
  }
  let queuedReset: Awaited<
    ReturnType<typeof queueApprovedResetFromLatestCoordinates>
  >;
  try {
    queuedReset = await queueApprovedResetFromLatestCoordinates(tx, {
      ticketId: input.ticket.id,
      project: frozenProject as typeof siteProjects.$inferSelect,
      sourceBuildId: preservedBuildId,
      knowledgeSnapshotId:
        project.currentKnowledgeSnapshotId ??
        currentBuild?.knowledgeSnapshotId ??
        existingNote.knowledgeSnapshotId,
      resetApprovedAt: now.toISOString(),
      minimumKnowledgeSnapshotVersion,
      frozenReset,
      resetAppliedProjectRevision,
      resetAppliedAt: resetEpochStartedAtIso,
      now,
    });
  } catch (error) {
    if (
      !(error instanceof SiteOpsRebuildTicketError) ||
      error.code !== "EXTERNAL_ACCESS_REQUIRED"
    ) {
      throw error;
    }
    const deferredNote: SiteOpsRebuildNoteV5 = {
      schemaVersion: 5,
      kind: REBUILD_NOTE_KIND,
      projectId: project.id,
      sourceBuildId: preservedBuildId,
      knowledgeSnapshotId:
        project.currentKnowledgeSnapshotId ??
        currentBuild?.knowledgeSnapshotId ??
        existingNote.knowledgeSnapshotId,
      resetIntent: APPROVED_RESET_UNPUBLISH,
      resetApprovedAt: now.toISOString(),
      minimumKnowledgeSnapshotVersion,
      resetActivationState: "awaiting_external_access",
      awaitingExternalOperationIds: [],
      resetEpochDecoupled: true,
      resetAppliedAt: resetEpochStartedAtIso,
      resetAppliedProjectRevision,
      freshRootApplied: true,
      frozenReset,
    };
    return {
      projectId: project.id,
      sourceBuildId: preservedBuildId,
      resetApplied: true as const,
      resetPending: true as const,
      resetOperationId: null,
      resetAppliedProjectRevision,
      internalNote: JSON.stringify(deferredNote),
    };
  }
  const { resetOperationId, upgradedNote } = queuedReset;
  return {
    projectId: project.id,
    sourceBuildId: preservedBuildId,
    resetApplied: true as const,
    resetPending: true as const,
    resetOperationId,
    // Compatibility for the delivery approval response. The durable V4 note
    // does not claim completion until the worker stores resetAppliedAt.
    resetAppliedProjectRevision,
    internalNote: JSON.stringify(upgradedNote),
  };
}

function affectedRows(result: unknown) {
  return Number(
    (Array.isArray(result)
      ? (result[0] as { affectedRows?: unknown } | undefined)?.affectedRows
      : (result as { affectedRows?: unknown } | undefined)?.affectedRows) ?? 0,
  );
}

function nullableCoordinate(column: any, value: string | null) {
  return value === null ? isNull(column) : eq(column, value);
}

export async function activateDeferredApprovedSiteOpsReset(
  tx: any,
  input: { ticketId: string; now: Date },
) {
  const ticketRows = await tx
    .select()
    .from(deliveryTickets)
    .where(
      and(
        eq(deliveryTickets.id, input.ticketId),
        eq(deliveryTickets.operation, "site_rebuild"),
      ),
    )
    .limit(1)
    .for("update");
  const ticket = ticketRows[0];
  const note = parseSiteOpsRebuildNote(ticket?.internalNote);
  if (
    !ticket ||
    !["scheduled", "in_progress"].includes(ticket.status) ||
    !note ||
    note.schemaVersion !== 5
  ) {
    return { status: "not_applicable" as const };
  }
  const projectRows = await tx
    .select()
    .from(siteProjects)
    .where(
      and(
        eq(siteProjects.id, note.projectId),
        eq(siteProjects.userId, ticket.userId),
      ),
    )
    .limit(1)
    .for("update");
  const project = projectRows[0];
  if (!project) return { status: "blocked" as const };
  const decoupledReset =
    note.resetEpochDecoupled === true && note.frozenReset
      ? note.frozenReset
      : null;
  if (
    decoupledReset &&
    !approvedResetUnpublishFreshEpochMatches(decoupledReset, project)
  ) {
    return { status: "blocked" as const };
  }

  const reconciledOperationRows = (
    note.awaitingExternalOperationIds.length > 0
      ? await tx
          .select({
            id: siteOperations.id,
            projectId: siteOperations.projectId,
            userId: siteOperations.userId,
            kind: siteOperations.kind,
            provider: siteOperations.provider,
            status: siteOperations.status,
            completedAt: siteOperations.completedAt,
          })
          .from(siteOperations)
          .where(inArray(siteOperations.id, note.awaitingExternalOperationIds))
          .for("update")
      : []
  ) as Array<{
    id: string;
    projectId: string;
    userId: number;
    kind: string;
    provider: string | null;
    status: string;
    completedAt: Date | null;
  }>;
  const reconciledById = new Map(
    reconciledOperationRows.map((operation) => [operation.id, operation]),
  );
  const originalBoundaryValid = note.awaitingExternalOperationIds.every(
    (operationId) => {
      const operation = reconciledById.get(operationId);
      return Boolean(
        operation &&
          operation.projectId === project.id &&
          operation.userId === project.userId &&
          knownAliyunWriteOperation(operation),
      );
    },
  );
  if (!originalBoundaryValid) return { status: "blocked" as const };
  if (
    reconciledOperationRows.some((operation) =>
      ACTIVE_SITE_OPERATION_STATUSES.includes(operation.status as never),
    )
  ) {
    return { status: "awaiting_external_reconciliation" as const };
  }

  if (!decoupledReset) {
    // Legacy V5 approvals did not create an independent local epoch. Keep the
    // historical all-operation gate for those notes only.
    const activeOperationRows = (await tx
      .select({
        id: siteOperations.id,
        kind: siteOperations.kind,
        provider: siteOperations.provider,
        status: siteOperations.status,
      })
      .from(siteOperations)
      .where(
        and(
          eq(siteOperations.projectId, project.id),
          inArray(siteOperations.status, ACTIVE_SITE_OPERATION_STATUSES),
        ),
      )
      .for("update")) as Array<{
      id: string;
      kind: string;
      provider: string | null;
      status: string;
    }>;
    if (
      activeOperationRows.some(
        (operation) => !knownAliyunWriteOperation(operation),
      )
    ) {
      return { status: "blocked" as const };
    }
    if (activeOperationRows.length > 0) {
      return { status: "awaiting_external_reconciliation" as const };
    }
  }
  const sourceBuildId = decoupledReset
    ? note.sourceBuildId
    : (project.currentBuildId ?? note.sourceBuildId);
  let queuedReset: Awaited<
    ReturnType<typeof queueApprovedResetFromLatestCoordinates>
  >;
  try {
    queuedReset = await queueApprovedResetFromLatestCoordinates(tx, {
      ticketId: ticket.id,
      project,
      sourceBuildId,
      knowledgeSnapshotId:
        decoupledReset?.expectedKnowledgeSnapshotId ??
        project.currentKnowledgeSnapshotId ??
        note.knowledgeSnapshotId,
      resetApprovedAt: note.resetApprovedAt,
      minimumKnowledgeSnapshotVersion: note.minimumKnowledgeSnapshotVersion,
      ...(decoupledReset
        ? {
            frozenReset: decoupledReset,
            resetAppliedProjectRevision: note.resetAppliedProjectRevision,
            resetAppliedAt: note.resetAppliedAt,
          }
        : {}),
      now: input.now,
    });
  } catch (error) {
    if (
      !(error instanceof SiteOpsRebuildTicketError) ||
      error.code !== "EXTERNAL_ACCESS_REQUIRED"
    ) {
      throw error;
    }
    const accessNote: SiteOpsRebuildNoteV5 = {
      ...note,
      resetActivationState: "awaiting_external_access",
      awaitingExternalOperationIds: [],
    };
    if (note.resetActivationState !== "awaiting_external_access") {
      const accessUpdate = await tx
        .update(deliveryTickets)
        .set({
          internalNote: JSON.stringify(accessNote),
          revision: ticket.revision + 1,
          publicSummary:
            "官网重置已获批准，等待恢复外部域名访问后继续安全下线。",
          updatedAt: input.now,
        })
        .where(
          and(
            eq(deliveryTickets.id, ticket.id),
            eq(deliveryTickets.revision, ticket.revision),
          ),
        );
      if (affectedRows(accessUpdate) !== 1) {
        throw new Error("SITEOPS_DEFERRED_RESET_ACTIVATION_CAS_CONFLICT");
      }
    }
    return { status: "awaiting_external_access" as const };
  }
  const { resetOperationId, upgradedNote } = queuedReset;
  const updated = await tx
    .update(deliveryTickets)
    .set({
      internalNote: JSON.stringify(upgradedNote),
      revision: ticket.revision + 1,
      publicSummary:
        "官网重置已获批准，原发布或 DNS 操作已完成对账，正在安全下线旧官网。",
      updatedAt: input.now,
    })
    .where(
      and(
        eq(deliveryTickets.id, ticket.id),
        eq(deliveryTickets.revision, ticket.revision),
      ),
    );
  if (affectedRows(updated) !== 1) {
    throw new Error("SITEOPS_DEFERRED_RESET_ACTIVATION_CAS_CONFLICT");
  }
  return {
    status: "activated" as const,
    resetOperationId,
    resetExpectedProjectRevision:
      decoupledReset?.expectedProjectRevision ?? project.revision,
    internalNote: JSON.stringify(upgradedNote),
  };
}

export async function activateOneDeferredApprovedSiteOpsReset(
  db: any,
  now = new Date(),
) {
  const candidates = await db
    .select({
      id: deliveryTickets.id,
      internalNote: deliveryTickets.internalNote,
    })
    .from(deliveryTickets)
    .where(
      and(
        eq(deliveryTickets.operation, "site_rebuild"),
        inArray(deliveryTickets.status, ["scheduled", "in_progress"]),
        like(deliveryTickets.internalNote, '%"schemaVersion":5%'),
      ),
    )
    .orderBy(deliveryTickets.updatedAt)
    .limit(128);
  for (const candidate of candidates) {
    if (parseSiteOpsRebuildNote(candidate.internalNote)?.schemaVersion !== 5) {
      continue;
    }
    try {
      const result = await db.transaction((tx: any) =>
        activateDeferredApprovedSiteOpsReset(tx, {
          ticketId: candidate.id,
          now,
        }),
      );
      if (result.status === "activated") return result;
    } catch (error) {
      if (!(error instanceof SiteOpsRebuildTicketError)) throw error;
      // A missing active DNS credential is recoverable configuration state.
      // Keep the durable approval pending; never recreate or cancel the
      // provider operation merely because activation could not proceed yet.
    }
  }
  return { status: "idle" as const };
}

export async function advanceApprovedSiteOpsResetAfterDnsRollback(
  tx: any,
  input: {
    operation: typeof siteOperations.$inferSelect;
    successorOperationId: string;
    now: Date;
  },
) {
  const reset = parseApprovedResetFromOperationInput(input.operation.input);
  if (
    input.operation.kind !== "dns_rollback" ||
    input.operation.provider !== "aliyun_alidns" ||
    !reset
  ) {
    throw new Error("SITEOPS_RESET_DNS_SUCCESSOR_INVALID");
  }
  const ticketRows = await tx
    .select()
    .from(deliveryTickets)
    .where(
      and(
        eq(deliveryTickets.id, reset.rebuildTicketId),
        eq(deliveryTickets.userId, input.operation.userId),
        eq(deliveryTickets.operation, "site_rebuild"),
      ),
    )
    .limit(1)
    .for("update");
  const ticket = ticketRows[0];
  const note = parseSiteOpsRebuildNote(ticket?.internalNote);
  if (
    !ticket ||
    !note ||
    note.schemaVersion !== 4 ||
    note.projectId !== input.operation.projectId ||
    note.resetOperationId !== input.operation.id ||
    note.resetExpectedProjectRevision !== reset.expectedProjectRevision ||
    note.resetAppliedAt
  ) {
    throw new Error("SITEOPS_RESET_DNS_SUCCESSOR_INVALID");
  }
  const nextNote: SiteOpsRebuildNoteV4 = {
    ...note,
    resetOperationId: input.successorOperationId,
  };
  const updated = await tx
    .update(deliveryTickets)
    .set({
      internalNote: JSON.stringify(nextNote),
      revision: ticket.revision + 1,
      updatedAt: input.now,
    })
    .where(
      and(
        eq(deliveryTickets.id, ticket.id),
        eq(deliveryTickets.revision, ticket.revision),
      ),
    );
  if (affectedRows(updated) !== 1) {
    throw new Error("SITEOPS_RESET_DNS_SUCCESSOR_CAS_CONFLICT");
  }
}

/**
 * Completes an approved reset only after ESA has read-only reconciled the
 * related-record and Routine deletions. All customer workflow coordinates are
 * cleared in the same transaction; immutable builds, deployments and ticket
 * events remain as audit history.
 */
type ApprovedResetFinalizationSafeNoExposureProof = {
  schemaVersion: 1;
  classification: "safe_no_exposure";
  source: "exact_coordinates" | "migration_0065_revision_only";
  resetOperationId: string;
  projectId: string;
  expectedProjectRevision: number;
  observedProjectRevision: number;
  observedProjectUpdatedAt: string;
};

function approvedResetFinalizationObservedRevision(input: {
  operation: typeof siteOperations.$inferSelect;
  reset: ApprovedResetUnpublishInput;
  project: typeof siteProjects.$inferSelect;
  safeNoExposureProof?: ApprovedResetFinalizationSafeNoExposureProof;
}) {
  // Preserve the established exact-coordinate path verbatim. It may finalize
  // after a safe provider reconciliation has populated operation.result; the
  // one-time migration proof is relevant only when revision matching fails.
  if (approvedResetUnpublishProjectMatches(input.reset, input.project)) {
    return input.project.revision;
  }
  const proof = input.safeNoExposureProof;
  if (!proof || proof.source !== "migration_0065_revision_only") return null;
  const allowedKeys = new Set([
    "schemaVersion",
    "classification",
    "source",
    "resetOperationId",
    "projectId",
    "expectedProjectRevision",
    "observedProjectRevision",
    "observedProjectUpdatedAt",
  ]);
  if (
    Object.keys(proof).some((key) => !allowedKeys.has(key)) ||
    proof.schemaVersion !== 1 ||
    proof.classification !== "safe_no_exposure" ||
    proof.resetOperationId !== input.operation.id ||
    proof.projectId !== input.project.id ||
    proof.expectedProjectRevision !== input.reset.expectedProjectRevision ||
    proof.observedProjectRevision !== input.project.revision ||
    proof.observedProjectUpdatedAt !== input.project.updatedAt.toISOString() ||
    input.operation.result !== null ||
    input.operation.providerOperationId !== null ||
    input.operation.providerTaskId !== null ||
    !approvedResetUnpublishNonRevisionCoordinatesMatch(
      input.reset,
      input.project,
    )
  ) {
    return null;
  }
  if (
    proof.observedProjectRevision !==
    input.reset.expectedProjectRevision + 1
  ) {
    return null;
  }
  return proof.observedProjectRevision;
}

export async function finalizeApprovedSiteOpsReset(
  tx: any,
  input: {
    operation: typeof siteOperations.$inferSelect;
    now: Date;
    safeNoExposureProof?: ApprovedResetFinalizationSafeNoExposureProof;
  },
) {
  const reset = parseApprovedResetUnpublishInput(input.operation.input);
  if (
    input.operation.kind !== "rollback" ||
    input.operation.provider !== "aliyun_esa" ||
    !reset
  ) {
    return { status: "not_applicable" as const };
  }
  const projectRows = await tx
    .select()
    .from(siteProjects)
    .where(
      and(
        eq(siteProjects.id, input.operation.projectId),
        eq(siteProjects.userId, input.operation.userId),
      ),
    )
    .limit(1)
    .for("update");
  const project = projectRows[0];
  if (!project) {
    return { status: "invalidated" as const };
  }
  const observedProjectRevision = approvedResetFinalizationObservedRevision({
    operation: input.operation,
    reset,
    project,
    safeNoExposureProof: input.safeNoExposureProof,
  });
  if (observedProjectRevision === null) {
    return { status: "invalidated" as const };
  }
  const ticketRows = await tx
    .select()
    .from(deliveryTickets)
    .where(
      and(
        eq(deliveryTickets.id, reset.rebuildTicketId),
        eq(deliveryTickets.userId, input.operation.userId),
        eq(deliveryTickets.operation, "site_rebuild"),
      ),
    )
    .limit(1)
    .for("update");
  const ticket = ticketRows[0];
  const note = parseSiteOpsRebuildNote(ticket?.internalNote);
  if (
    !ticket ||
    !note ||
    note.schemaVersion !== 4 ||
    note.projectId !== project.id ||
    note.resetOperationId !== input.operation.id ||
    note.resetExpectedProjectRevision !== reset.expectedProjectRevision
  ) {
    return { status: "invalidated" as const };
  }
  if (
    note.resetAppliedAt &&
    note.resetAppliedProjectRevision &&
    (note.resetEpochDecoupled !== true || note.externalCleanupCompletedAt)
  ) {
    return {
      status: "applied" as const,
      projectRevision: note.resetAppliedProjectRevision,
      internalNote: JSON.stringify(note),
      operationResult: completedFreshRootResetOperationProjection({
        operationId: input.operation.id,
        projectId: project.id,
        minimumKnowledgeSnapshotVersion: note.minimumKnowledgeSnapshotVersion,
        resetAppliedProjectRevision: note.resetAppliedProjectRevision,
      }),
    };
  }

  if (note.resetEpochDecoupled === true) {
    if (
      !note.resetAppliedAt ||
      !note.resetAppliedProjectRevision ||
      note.freshRootApplied !== true ||
      note.unpublishOperationId !== input.operation.id ||
      !note.frozenReset ||
      !approvedResetInputsEqual(note.frozenReset, reset) ||
      !approvedResetUnpublishFreshEpochMatches(reset, project)
    ) {
      return { status: "invalidated" as const };
    }

    const profileRows = await tx
      .select({ revision: workspaceSiteProfiles.revision })
      .from(workspaceSiteProfiles)
      .where(eq(workspaceSiteProfiles.userId, project.userId))
      .limit(1)
      .for("update");
    if (profileRows[0]) {
      await tx
        .update(workspaceSiteProfiles)
        .set({
          domain: null,
          normalizedAsciiDomain: null,
          unicodeDisplayDomain: null,
          providerAccountUid: null,
          domainOwnershipStatus: null,
          dnsStatus: null,
          domainStatus: "not_started",
          domainVerifiedAt: null,
          siteMode: "unknown",
          icpDomainRevision: null,
          icpProvince: null,
          icpNumber: null,
          icpStatus: "not_submitted",
          icpVerifiedAt: null,
          revision: profileRows[0].revision + 1,
          updatedAt: input.now,
        })
        .where(eq(workspaceSiteProfiles.userId, project.userId));
    }
    await tx
      .delete(siteDnsRecords)
      .where(
        and(
          eq(siteDnsRecords.projectId, project.id),
          eq(siteDnsRecords.userId, project.userId),
        ),
      );

    const previousHeadIdList = [
      reset.expectedGlobalLiveDeploymentId,
      reset.expectedMainlandLiveDeploymentId,
    ].filter((value): value is string => Boolean(value));
    const previousHeadIds = new Set(previousHeadIdList);
    const deploymentRows =
      previousHeadIdList.length === 0
        ? []
        : await tx
            .select({
              id: siteDeployments.id,
              status: siteDeployments.status,
              verification: siteDeployments.verification,
            })
            .from(siteDeployments)
            .where(
              and(
                eq(siteDeployments.projectId, project.id),
                eq(siteDeployments.userId, project.userId),
                inArray(siteDeployments.id, previousHeadIdList),
              ),
            )
            .for("update");
    for (const deployment of deploymentRows) {
      // The query is intentionally scoped to the frozen old live heads. Keep
      // this defensive check as a second fence for adapters/test doubles that
      // do not enforce the SQL predicate themselves.
      if (!previousHeadIds.has(deployment.id)) continue;
      await tx
        .update(siteDeployments)
        .set({
          status: "superseded",
          verification: {
            ...(deployment.verification ?? {}),
            resetInvalidated: true,
            resetInvalidatedAt: input.now.toISOString(),
            resetOperationId: input.operation.id,
            resetAppliedProjectRevision: note.resetAppliedProjectRevision,
          },
          updatedAt: input.now,
        })
        .where(
          and(
            eq(siteDeployments.id, deployment.id),
            eq(siteDeployments.projectId, project.id),
            eq(siteDeployments.userId, project.userId),
          ),
        );
    }

    const sequenceRows = await tx
      .select({ sequence: max(messages.sequence) })
      .from(messages)
      .where(eq(messages.conversationId, project.conversationId));
    await tx.insert(messages).values({
      id: randomUUID(),
      conversationId: project.conversationId,
      userId: project.userId,
      role: "assistant",
      content: "旧官网的外部发布与 DNS 下线确认已完成。",
      sequence: Number(sequenceRows[0]?.sequence ?? 0) + 1,
      metadata: {
        siteOps: {
          kind: "domain_status",
          subjectId: input.operation.id,
          revision: project.revision,
          status: "resolved",
          payload: {
            rebuildTicketId: ticket.id,
            reset: true,
            freshRootApplied: true,
            unpublishCompleted: true,
          },
        },
      },
    });

    const appliedNote: SiteOpsRebuildNoteV4 = {
      ...note,
      externalCleanupCompletedAt: input.now.toISOString(),
    };
    const priorTicketStatus = ticket.status;
    const ticketUpdate = await tx
      .update(deliveryTickets)
      .set({
        status: "completed",
        publicSummary:
          "旧网站已安全下线，旧建站流程已清空；企业知识库保持不变，可创建全新官网任务。",
        internalNote: JSON.stringify(appliedNote),
        quotaState: "consumed",
        technicalDedupeKey: null,
        resolvedAt: input.now,
        revision: ticket.revision + 1,
        updatedAt: input.now,
      })
      .where(
        and(
          eq(deliveryTickets.id, ticket.id),
          eq(deliveryTickets.revision, ticket.revision),
        ),
      );
    if (affectedRows(ticketUpdate) !== 1) {
      throw new Error("SITEOPS_RESET_TICKET_CAS_CONFLICT");
    }
    await tx.insert(deliveryTicketEvents).values({
      id: randomUUID(),
      ticketId: ticket.id,
      userId: ticket.userId,
      actorUserId: null,
      actorRole: "system",
      kind: "delivery_result",
      visibility: "customer",
      message:
        "旧网站已安全下线，旧建站流程已清空；企业知识库保持不变，可创建全新官网任务。",
      fromStatus: priorTicketStatus,
      toStatus: "completed",
      actorContext: {
        projectAssignmentId: ticket.assignedProjectAssignmentId!,
        customerUserId: ticket.userId,
        roleType: "ai_operations_engineer",
      },
      createdAt: input.now,
    });
    return {
      status: "applied" as const,
      projectRevision: note.resetAppliedProjectRevision,
      internalNote: JSON.stringify(appliedNote),
      operationResult: completedFreshRootResetOperationProjection({
        operationId: input.operation.id,
        projectId: project.id,
        minimumKnowledgeSnapshotVersion:
          appliedNote.minimumKnowledgeSnapshotVersion,
        resetAppliedProjectRevision: note.resetAppliedProjectRevision,
      }),
    };
  }

  const nextRevision = project.revision + 1;
  const sequenceRows = await tx
    .select({ sequence: max(messages.sequence) })
    .from(messages)
    .where(eq(messages.conversationId, project.conversationId));
  const projectUpdate = await tx
    .update(siteProjects)
    .set({
      currentKnowledgeSnapshotId: project.currentKnowledgeSnapshotId,
      currentBuildId: null,
      globalLiveDeploymentId: null,
      mainlandLiveDeploymentId: null,
      canonicalHostname: null,
      currentTaskStartedAt: siteOpsResetEpochAtDatabasePrecision(input.now),
      minimumKnowledgeSnapshotVersion: null,
      brief: null,
      status: "draft",
      revision: nextRevision,
      updatedAt: input.now,
    })
    .where(
      and(
        eq(siteProjects.id, project.id),
        eq(siteProjects.userId, project.userId),
        eq(siteProjects.revision, observedProjectRevision),
        nullableCoordinate(
          siteProjects.currentBuildId,
          reset.expectedCurrentBuildId,
        ),
        nullableCoordinate(
          siteProjects.currentKnowledgeSnapshotId,
          reset.expectedKnowledgeSnapshotId,
        ),
        nullableCoordinate(
          siteProjects.globalLiveDeploymentId,
          reset.expectedGlobalLiveDeploymentId,
        ),
        nullableCoordinate(
          siteProjects.mainlandLiveDeploymentId,
          reset.expectedMainlandLiveDeploymentId,
        ),
        nullableCoordinate(
          siteProjects.canonicalHostname,
          reset.expectedCanonicalHostname,
        ),
      ),
    );
  if (affectedRows(projectUpdate) !== 1) {
    return { status: "invalidated" as const };
  }

  const profileRows = await tx
    .select({ revision: workspaceSiteProfiles.revision })
    .from(workspaceSiteProfiles)
    .where(eq(workspaceSiteProfiles.userId, project.userId))
    .limit(1)
    .for("update");
  if (profileRows[0]) {
    await tx
      .update(workspaceSiteProfiles)
      .set({
        domain: null,
        normalizedAsciiDomain: null,
        unicodeDisplayDomain: null,
        providerAccountUid: null,
        domainOwnershipStatus: null,
        dnsStatus: null,
        domainStatus: "not_started",
        domainVerifiedAt: null,
        siteMode: "unknown",
        icpDomainRevision: null,
        icpProvince: null,
        icpNumber: null,
        icpStatus: "not_submitted",
        icpVerifiedAt: null,
        revision: profileRows[0].revision + 1,
        updatedAt: input.now,
      })
      .where(eq(workspaceSiteProfiles.userId, project.userId));
  }
  await tx
    .delete(siteDnsRecords)
    .where(
      and(
        eq(siteDnsRecords.projectId, project.id),
        eq(siteDnsRecords.userId, project.userId),
      ),
    );

  await tx
    .update(siteBuilds)
    .set({ status: "cancelled", updatedAt: input.now })
    .where(
      and(
        eq(siteBuilds.projectId, project.id),
        eq(siteBuilds.userId, project.userId),
        inArray(siteBuilds.status, [
          "preparing",
          "visual_searching",
          "awaiting_visual_selection",
          "design_compiling",
          "contract_ready",
          "building",
          "qa_running",
          "failed",
          "attention_required",
        ]),
      ),
    );
  await tx
    .update(siteBuilds)
    .set({ status: "superseded", updatedAt: input.now })
    .where(
      and(
        eq(siteBuilds.projectId, project.id),
        eq(siteBuilds.userId, project.userId),
        inArray(siteBuilds.status, ["preview_ready", "approved"]),
      ),
    );
  await tx
    .update(siteBuilds)
    .set({ quotaState: "released", updatedAt: input.now })
    .where(
      and(
        eq(siteBuilds.projectId, project.id),
        eq(siteBuilds.userId, project.userId),
        eq(siteBuilds.quotaState, "reserved"),
      ),
    );

  await tx
    .update(messages)
    .set({ deletedAt: input.now, updatedAt: input.now })
    .where(
      and(
        eq(messages.conversationId, project.conversationId),
        eq(messages.userId, project.userId),
        isNull(messages.deletedAt),
      ),
    );
  const candidatePoolRows = await tx
    .select({ id: visualCandidatePools.id })
    .from(visualCandidatePools)
    .where(
      and(
        eq(visualCandidatePools.projectId, project.id),
        eq(visualCandidatePools.userId, project.userId),
        inArray(visualCandidatePools.status, ["active", "selected"]),
      ),
    )
    .for("update");
  const candidatePoolIds = candidatePoolRows.map(
    (pool: { id: string }) => pool.id,
  );
  if (candidatePoolIds.length > 0) {
    await tx
      .update(visualCandidatePoolPages)
      .set({ status: "superseded", updatedAt: input.now })
      .where(
        and(
          inArray(visualCandidatePoolPages.poolId, candidatePoolIds),
          inArray(visualCandidatePoolPages.status, [
            "reserved",
            "published",
            "selected",
          ]),
        ),
      );
    await tx
      .update(visualCandidatePools)
      .set({ status: "superseded", updatedAt: input.now })
      .where(
        and(
          inArray(visualCandidatePools.id, candidatePoolIds),
          inArray(visualCandidatePools.status, ["active", "selected"]),
        ),
      );
  }
  await tx
    .update(websiteStyleSampleBatches)
    .set({ status: "superseded", updatedAt: input.now })
    .where(
      and(
        eq(websiteStyleSampleBatches.siteProjectId, project.id),
        eq(websiteStyleSampleBatches.userId, project.userId),
        eq(websiteStyleSampleBatches.sourceKind, "siteops_21st"),
        inArray(websiteStyleSampleBatches.status, ["published", "selected"]),
      ),
    );
  const previousHeads = [
    reset.expectedGlobalLiveDeploymentId,
    reset.expectedMainlandLiveDeploymentId,
  ].filter((value): value is string => Boolean(value));
  const previousHeadIds = new Set(previousHeads);
  const deploymentRows = await tx
    .select({
      id: siteDeployments.id,
      status: siteDeployments.status,
      verification: siteDeployments.verification,
    })
    .from(siteDeployments)
    .where(
      and(
        eq(siteDeployments.projectId, project.id),
        eq(siteDeployments.userId, project.userId),
      ),
    )
    .for("update");
  for (const deployment of deploymentRows) {
    await tx
      .update(siteDeployments)
      .set({
        status: previousHeadIds.has(deployment.id)
          ? "superseded"
          : deployment.status,
        verification: {
          ...(deployment.verification ?? {}),
          resetInvalidated: true,
          resetInvalidatedAt: input.now.toISOString(),
          resetOperationId: input.operation.id,
        },
        updatedAt: input.now,
      })
      .where(eq(siteDeployments.id, deployment.id));
  }
  await tx.insert(messages).values({
    id: randomUUID(),
    conversationId: project.conversationId,
    userId: project.userId,
    role: "assistant",
    content:
      "旧官网已下线，官网重置已完成。企业知识库保持不变，可从知识库开始全新的建站任务。",
    sequence: Number(sequenceRows[0]?.sequence ?? 0) + 1,
    metadata: {
      siteOps: {
        kind: "brief_question",
        subjectId: ticket.id,
        revision: nextRevision,
        status: "active",
        payload: {
          rebuildTicketId: ticket.id,
          requested: "reuse_current_knowledge",
          reset: true,
          unpublishCompleted: true,
        },
      },
    },
  });
  const appliedNote: SiteOpsRebuildNoteV4 = {
    ...note,
    resetAppliedAt: input.now.toISOString(),
    resetAppliedProjectRevision: nextRevision,
    freshRootApplied: true,
    unpublishOperationId: input.operation.id,
  };
  const priorTicketStatus = ticket.status;
  const ticketUpdate = await tx
    .update(deliveryTickets)
    .set({
      status: "completed",
      publicSummary:
        "旧网站已安全下线，旧建站流程已清空；企业知识库保持不变，可创建全新官网任务。",
      internalNote: JSON.stringify(appliedNote),
      quotaState: "consumed",
      technicalDedupeKey: null,
      resolvedAt: input.now,
      revision: ticket.revision + 1,
      updatedAt: input.now,
    })
    .where(
      and(
        eq(deliveryTickets.id, ticket.id),
        eq(deliveryTickets.revision, ticket.revision),
      ),
    );
  if (affectedRows(ticketUpdate) !== 1) {
    throw new Error("SITEOPS_RESET_TICKET_CAS_CONFLICT");
  }
  await tx.insert(deliveryTicketEvents).values({
    id: randomUUID(),
    ticketId: ticket.id,
    userId: ticket.userId,
    actorUserId: null,
    actorRole: "system",
    kind: "delivery_result",
    visibility: "customer",
    message:
      "旧网站已安全下线，旧建站流程已清空；企业知识库保持不变，可创建全新官网任务。",
    fromStatus: priorTicketStatus,
    toStatus: "completed",
    actorContext: {
      projectAssignmentId: ticket.assignedProjectAssignmentId!,
      customerUserId: ticket.userId,
      roleType: "ai_operations_engineer",
    },
    createdAt: input.now,
  });
  return {
    status: "applied" as const,
    projectRevision: nextRevision,
    internalNote: JSON.stringify(appliedNote),
    operationResult: completedFreshRootResetOperationProjection({
      operationId: input.operation.id,
      projectId: project.id,
      minimumKnowledgeSnapshotVersion:
        appliedNote.minimumKnowledgeSnapshotVersion,
      resetAppliedProjectRevision: nextRevision,
    }),
  };
}
