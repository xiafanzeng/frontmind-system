import { and, desc, eq, inArray, isNull } from "drizzle-orm";

import {
  conversationTurns,
  siteBuilds,
  siteOperations,
  siteProjects,
} from "../../drizzle/schema";
import { reserveSiteOpsQuota } from "./quota-service";
import {
  existingTaskOnlyBoundFallback,
  existingTaskOnlyRecoveryState,
} from "./manus-provider";

const RECOVERABLE_PUBLIC_ERROR_CODE = "FRONTMIND_BUILD_SERVICE_UNAVAILABLE";
const RECOVERABLE_PROVIDER_SYNC_CODE =
  "FRONTMIND_BUILD_RECONCILIATION_REQUIRED";

export class SiteOpsBuildReconciliationError extends Error {
  constructor(public readonly code: string) {
    super(code);
    this.name = "SiteOpsBuildReconciliationError";
  }
}

type ReconciliationBuild = Pick<
  typeof siteBuilds.$inferSelect,
  | "id"
  | "projectId"
  | "userId"
  | "knowledgeSnapshotId"
  | "parentBuildId"
  | "quotaPeriodId"
  | "quotaState"
  | "ordinal"
  | "contractLocalAssetId"
  | "contractHash"
  | "sourceLocalAssetId"
  | "sourceHash"
  | "distLocalAssetId"
  | "distHash"
  | "qaLocalAssetId"
  | "provenanceLocalAssetId"
  | "upstreamManusTaskId"
  | "status"
  | "errorCode"
  | "createdAt"
>;

type ReconciliationOperation = Pick<
  typeof siteOperations.$inferSelect,
  | "id"
  | "projectId"
  | "userId"
  | "conversationTurnId"
  | "buildId"
  | "kind"
  | "status"
  | "provider"
  | "providerTaskId"
  | "result"
  | "errorCode"
>;

type ReconciliationProject = Pick<
  typeof siteProjects.$inferSelect,
  | "id"
  | "userId"
  | "currentKnowledgeSnapshotId"
  | "currentBuildId"
  | "currentTaskStartedAt"
  | "status"
  | "revision"
>;

type ReconciliationTurn = Pick<
  typeof conversationTurns.$inferSelect,
  "id" | "userId" | "expectedRevision"
>;

export type ExistingManusBuildReconciliationSnapshot = {
  build: ReconciliationBuild;
  operation: ReconciliationOperation;
  project: ReconciliationProject;
  turn: ReconciliationTurn;
  latestBuildId: string;
  latestBuildOrdinal: number;
  latestBuildOperationId: string;
};

export type PreparedExistingManusBuildReconciliation = {
  buildId: string;
  operationId: string;
  projectId: string;
  userId: number;
  taskId: string;
  quotaPeriodId: string;
  knowledgeSnapshotId: string;
  previousProjectRevision: number;
  previousProjectStatus: "failed" | "attention_required";
  previousBuildStatus: "failed" | "attention_required";
  previousOperationStatus: "failed" | "attention_required";
  expectedCurrentBuildId: string | null;
  recoveryState: Record<string, unknown>;
  recoveryErrorCode:
    | typeof RECOVERABLE_PUBLIC_ERROR_CODE
    | typeof RECOVERABLE_PROVIDER_SYNC_CODE;
  boundFallback: {
    contract: { id: string; sha256: string };
    source: { id: string; sha256: string };
    dist: { id: string; sha256: string };
    qa: { id: string };
    provenance: { id: string };
  } | null;
};

function reject(code: string): never {
  throw new SiteOpsBuildReconciliationError(code);
}

function hasBoundArtifact(build: ReconciliationBuild) {
  return [
    build.contractLocalAssetId,
    build.contractHash,
    build.sourceLocalAssetId,
    build.sourceHash,
    build.distLocalAssetId,
    build.distHash,
    build.qaLocalAssetId,
    build.provenanceLocalAssetId,
  ].some((value) => value !== null);
}

function buildMatchesBoundFallback(
  build: ReconciliationBuild,
  fallback: NonNullable<
    PreparedExistingManusBuildReconciliation["boundFallback"]
  >,
) {
  return (
    build.parentBuildId === null &&
    build.contractLocalAssetId === fallback.contract.id &&
    build.contractHash === fallback.contract.sha256 &&
    build.sourceLocalAssetId === fallback.source.id &&
    build.sourceHash === fallback.source.sha256 &&
    build.distLocalAssetId === fallback.dist.id &&
    build.distHash === fallback.dist.sha256 &&
    build.qaLocalAssetId === fallback.qa.id &&
    build.provenanceLocalAssetId === fallback.provenance.id
  );
}

/**
 * Validate every incident-specific coordinate before a write is attempted.
 * Keeping this pure makes the operator command's refusal cases deterministic
 * and independently testable without production credentials.
 */
export function prepareExistingManusBuildReconciliation(
  snapshot: ExistingManusBuildReconciliationSnapshot,
): PreparedExistingManusBuildReconciliation {
  const { build, operation, project, turn } = snapshot;

  if (operation.kind !== "site_build" && operation.kind !== "build_revision") {
    reject("SITEOPS_RECONCILE_BUILD_OPERATION_KIND_INVALID");
  }
  if (
    operation.provider !== "manus" ||
    operation.buildId !== build.id ||
    operation.projectId !== build.projectId ||
    operation.userId !== build.userId
  ) {
    reject("SITEOPS_RECONCILE_BUILD_OPERATION_COORDINATE_MISMATCH");
  }
  if (
    !operation.providerTaskId ||
    !build.upstreamManusTaskId ||
    operation.providerTaskId !== build.upstreamManusTaskId
  ) {
    reject("SITEOPS_RECONCILE_PROVIDER_TASK_MISMATCH");
  }

  let recoveryState: Record<string, unknown>;
  try {
    recoveryState = existingTaskOnlyRecoveryState({
      result: operation.result,
      taskId: operation.providerTaskId,
    });
  } catch {
    reject("SITEOPS_RECONCILE_NATIVE_REPAIR_STATE_REQUIRED");
  }
  const boundFallbackMarker = existingTaskOnlyBoundFallback(recoveryState);
  const boundFallback = boundFallbackMarker?.artifactBindings ?? null;
  const genericFailure =
    operation.status === "failed" &&
    build.status === "failed" &&
    project.status === "failed" &&
    operation.errorCode === RECOVERABLE_PUBLIC_ERROR_CODE &&
    build.errorCode === RECOVERABLE_PUBLIC_ERROR_CODE;
  const fallbackAttention =
    operation.status === "attention_required" &&
    build.status === "attention_required" &&
    project.status === "attention_required" &&
    operation.errorCode === RECOVERABLE_PROVIDER_SYNC_CODE &&
    build.errorCode === RECOVERABLE_PROVIDER_SYNC_CODE;
  if (boundFallback ? !fallbackAttention : !genericFailure) {
    reject("SITEOPS_RECONCILE_RECOVERABLE_TERMINAL_REQUIRED");
  }
  if (boundFallback) {
    if (
      boundFallbackMarker?.buildId !== build.id ||
      boundFallbackMarker.taskId !== operation.providerTaskId ||
      boundFallbackMarker.operationToken !==
        `siteops-native-fallback:${operation.id}`
    ) {
      reject("SITEOPS_RECONCILE_FALLBACK_COORDINATE_MISMATCH");
    }
    if (!buildMatchesBoundFallback(build, boundFallback)) {
      reject("SITEOPS_RECONCILE_FALLBACK_ARTIFACT_MISMATCH");
    }
  } else if (hasBoundArtifact(build)) {
    reject("SITEOPS_RECONCILE_BUILD_ALREADY_HAS_ARTIFACTS");
  }
  if (
    snapshot.latestBuildId !== build.id ||
    snapshot.latestBuildOrdinal !== build.ordinal ||
    snapshot.latestBuildOperationId !== operation.id
  ) {
    reject("SITEOPS_RECONCILE_NEWER_BUILD_OR_OPERATION_EXISTS");
  }
  if (
    project.id !== build.projectId ||
    project.userId !== build.userId ||
    project.currentKnowledgeSnapshotId !== build.knowledgeSnapshotId ||
    build.createdAt.getTime() < project.currentTaskStartedAt.getTime()
  ) {
    reject("SITEOPS_RECONCILE_PROJECT_COORDINATE_CHANGED");
  }
  const expectedCurrentBuildId = build.parentBuildId ?? build.id;
  if (project.currentBuildId !== expectedCurrentBuildId) {
    reject("SITEOPS_RECONCILE_PROJECT_HEAD_CHANGED");
  }
  if (
    !operation.conversationTurnId ||
    turn.id !== operation.conversationTurnId ||
    turn.userId !== build.userId ||
    turn.expectedRevision === null ||
    project.revision !== turn.expectedRevision + 2
  ) {
    reject("SITEOPS_RECONCILE_PROJECT_REVISION_CHANGED");
  }
  if (build.quotaState !== "released" || !build.quotaPeriodId) {
    reject("SITEOPS_RECONCILE_RELEASED_QUOTA_REQUIRED");
  }

  return {
    buildId: build.id,
    operationId: operation.id,
    projectId: project.id,
    userId: build.userId,
    taskId: operation.providerTaskId,
    quotaPeriodId: build.quotaPeriodId,
    knowledgeSnapshotId: build.knowledgeSnapshotId,
    previousProjectRevision: project.revision,
    previousProjectStatus: project.status as "failed" | "attention_required",
    previousBuildStatus: build.status as "failed" | "attention_required",
    previousOperationStatus: operation.status as
      | "failed"
      | "attention_required",
    expectedCurrentBuildId,
    recoveryState,
    recoveryErrorCode: boundFallback
      ? RECOVERABLE_PROVIDER_SYNC_CODE
      : RECOVERABLE_PUBLIC_ERROR_CODE,
    boundFallback,
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

async function loadReconciliationSnapshotForUpdate(tx: any, buildId: string) {
  const buildRows = await tx
    .select()
    .from(siteBuilds)
    .where(eq(siteBuilds.id, buildId))
    .limit(1)
    .for("update");
  const build = buildRows[0] as typeof siteBuilds.$inferSelect | undefined;
  if (!build) reject("SITEOPS_RECONCILE_BUILD_NOT_FOUND");

  const operationRows = await tx
    .select()
    .from(siteOperations)
    .where(
      and(
        eq(siteOperations.buildId, build.id),
        eq(siteOperations.provider, "manus"),
        inArray(siteOperations.kind, ["site_build", "build_revision"]),
      ),
    )
    .orderBy(desc(siteOperations.createdAt), desc(siteOperations.id))
    .limit(1)
    .for("update");
  const operation = operationRows[0] as
    | typeof siteOperations.$inferSelect
    | undefined;
  if (!operation) reject("SITEOPS_RECONCILE_BUILD_OPERATION_NOT_FOUND");

  const projectRows = await tx
    .select()
    .from(siteProjects)
    .where(eq(siteProjects.id, build.projectId))
    .limit(1)
    .for("update");
  const project = projectRows[0] as
    | typeof siteProjects.$inferSelect
    | undefined;
  if (!project) reject("SITEOPS_RECONCILE_PROJECT_NOT_FOUND");

  if (!operation.conversationTurnId) {
    reject("SITEOPS_RECONCILE_CONVERSATION_TURN_REQUIRED");
  }
  const turnRows = await tx
    .select()
    .from(conversationTurns)
    .where(eq(conversationTurns.id, operation.conversationTurnId))
    .limit(1)
    .for("update");
  const turn = turnRows[0] as typeof conversationTurns.$inferSelect | undefined;
  if (!turn) reject("SITEOPS_RECONCILE_CONVERSATION_TURN_NOT_FOUND");

  const latestBuildRows = await tx
    .select({ id: siteBuilds.id, ordinal: siteBuilds.ordinal })
    .from(siteBuilds)
    .where(eq(siteBuilds.projectId, build.projectId))
    .orderBy(desc(siteBuilds.ordinal), desc(siteBuilds.id))
    .limit(1)
    .for("update");
  const latestOperationRows = await tx
    .select({ id: siteOperations.id })
    .from(siteOperations)
    .where(
      and(
        eq(siteOperations.projectId, build.projectId),
        inArray(siteOperations.kind, ["site_build", "build_revision"]),
      ),
    )
    .orderBy(desc(siteOperations.createdAt), desc(siteOperations.id))
    .limit(1)
    .for("update");
  const latestBuild = latestBuildRows[0];
  const latestOperation = latestOperationRows[0];
  if (!latestBuild || !latestOperation) {
    reject("SITEOPS_RECONCILE_LATEST_BUILD_COORDINATES_MISSING");
  }

  return {
    build,
    operation,
    project,
    turn,
    latestBuildId: latestBuild.id,
    latestBuildOrdinal: latestBuild.ordinal,
    latestBuildOperationId: latestOperation.id,
  } satisfies ExistingManusBuildReconciliationSnapshot;
}

export type ExistingManusBuildReconciliationResult = {
  buildId: string;
  operationId: string;
  projectId: string;
  taskId: string;
  previousOperationStatus: "failed" | "attention_required";
  nextOperationStatus: "running";
  quotaState: "reserved";
  existingTaskOnly: true;
};

export function parseExistingManusBuildReconciliationArgs(args: string[]) {
  let buildId: string | null = null;
  let existingTaskOnly = false;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--build" && buildId === null) {
      buildId = args[index + 1] ?? null;
      index += 1;
      continue;
    }
    if (arg === "--existing-task-only" && !existingTaskOnly) {
      existingTaskOnly = true;
      continue;
    }
    reject("SITEOPS_RECONCILE_ARGUMENTS_INVALID");
  }
  if (
    !buildId ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(
      buildId,
    ) ||
    !existingTaskOnly
  ) {
    reject("SITEOPS_RECONCILE_ARGUMENTS_INVALID");
  }
  return { buildId, existingTaskOnly: true as const };
}

/**
 * Restore one failed native repair operation without making a provider call.
 * The worker is constrained by the persisted `existingTaskOnly` bit, so its
 * next provider interaction can only be GET detail/listMessages/file reads.
 */
export async function reconcileExistingManusBuild(
  db: any,
  input: { buildId: string; now?: Date },
): Promise<ExistingManusBuildReconciliationResult> {
  return await db.transaction(async (tx: any) => {
    const prepared = prepareExistingManusBuildReconciliation(
      await loadReconciliationSnapshotForUpdate(tx, input.buildId),
    );
    const now = input.now ?? new Date();

    const selectedQuotaPeriod = await reserveSiteOpsQuota(tx, {
      userId: prepared.userId,
      quotaPool: "website_content_publish",
      quotaPeriodIds: [prepared.quotaPeriodId],
    });
    if (selectedQuotaPeriod !== prepared.quotaPeriodId) {
      reject("SITEOPS_RECONCILE_QUOTA_PERIOD_CHANGED");
    }

    const operationUpdate = await tx
      .update(siteOperations)
      .set({
        // A lease-free running row is the worker's existing-operation recovery
        // form: claimOne immediately acquires it without allocating a new row.
        status: "running",
        result: prepared.recoveryState,
        errorCode: null,
        errorMessage: null,
        leaseOwner: null,
        leaseExpiresAt: null,
        completedAt: null,
        updatedAt: now,
      })
      .where(
        and(
          eq(siteOperations.id, prepared.operationId),
          eq(siteOperations.projectId, prepared.projectId),
          eq(siteOperations.buildId, prepared.buildId),
          eq(siteOperations.status, prepared.previousOperationStatus),
          eq(siteOperations.provider, "manus"),
          eq(siteOperations.providerTaskId, prepared.taskId),
          eq(siteOperations.errorCode, prepared.recoveryErrorCode),
          isNull(siteOperations.leaseOwner),
          isNull(siteOperations.leaseExpiresAt),
        ),
      );
    if (affectedRows(operationUpdate) !== 1) {
      reject("SITEOPS_RECONCILE_OPERATION_CAS_CONFLICT");
    }

    const artifactCoordinates = prepared.boundFallback
      ? [
          eq(
            siteBuilds.contractLocalAssetId,
            prepared.boundFallback.contract.id,
          ),
          eq(siteBuilds.contractHash, prepared.boundFallback.contract.sha256),
          eq(siteBuilds.sourceLocalAssetId, prepared.boundFallback.source.id),
          eq(siteBuilds.sourceHash, prepared.boundFallback.source.sha256),
          eq(siteBuilds.distLocalAssetId, prepared.boundFallback.dist.id),
          eq(siteBuilds.distHash, prepared.boundFallback.dist.sha256),
          eq(siteBuilds.qaLocalAssetId, prepared.boundFallback.qa.id),
          eq(
            siteBuilds.provenanceLocalAssetId,
            prepared.boundFallback.provenance.id,
          ),
        ]
      : [
          isNull(siteBuilds.contractLocalAssetId),
          isNull(siteBuilds.contractHash),
          isNull(siteBuilds.sourceLocalAssetId),
          isNull(siteBuilds.sourceHash),
          isNull(siteBuilds.distLocalAssetId),
          isNull(siteBuilds.distHash),
          isNull(siteBuilds.qaLocalAssetId),
          isNull(siteBuilds.provenanceLocalAssetId),
        ];
    const buildUpdate = await tx
      .update(siteBuilds)
      .set({
        status: prepared.boundFallback ? "qa_running" : "building",
        quotaState: "reserved",
        errorCode: null,
        errorMessage: null,
        updatedAt: now,
      })
      .where(
        and(
          eq(siteBuilds.id, prepared.buildId),
          eq(siteBuilds.projectId, prepared.projectId),
          eq(siteBuilds.status, prepared.previousBuildStatus),
          eq(siteBuilds.quotaState, "released"),
          eq(siteBuilds.quotaPeriodId, prepared.quotaPeriodId),
          eq(siteBuilds.upstreamManusTaskId, prepared.taskId),
          eq(siteBuilds.errorCode, prepared.recoveryErrorCode),
          ...artifactCoordinates,
        ),
      );
    if (affectedRows(buildUpdate) !== 1) {
      reject("SITEOPS_RECONCILE_BUILD_CAS_CONFLICT");
    }

    const projectUpdate = await tx
      .update(siteProjects)
      .set({ status: "building", updatedAt: now })
      .where(
        and(
          eq(siteProjects.id, prepared.projectId),
          eq(siteProjects.userId, prepared.userId),
          eq(siteProjects.status, prepared.previousProjectStatus),
          eq(siteProjects.revision, prepared.previousProjectRevision),
          nullableCoordinate(
            siteProjects.currentBuildId,
            prepared.expectedCurrentBuildId,
          ),
          eq(
            siteProjects.currentKnowledgeSnapshotId,
            prepared.knowledgeSnapshotId,
          ),
        ),
      );
    if (affectedRows(projectUpdate) !== 1) {
      reject("SITEOPS_RECONCILE_PROJECT_CAS_CONFLICT");
    }

    console.info("[siteops] existing Manus build restored for reconciliation", {
      event: "siteops_existing_manus_build_reconcile_restored",
      buildId: prepared.buildId,
      operationId: prepared.operationId,
      projectId: prepared.projectId,
      taskId: prepared.taskId,
      existingTaskOnly: true,
    });

    return {
      buildId: prepared.buildId,
      operationId: prepared.operationId,
      projectId: prepared.projectId,
      taskId: prepared.taskId,
      previousOperationStatus: prepared.previousOperationStatus,
      nextOperationStatus: "running",
      quotaState: "reserved",
      existingTaskOnly: true,
    };
  });
}
