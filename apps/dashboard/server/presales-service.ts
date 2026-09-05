import { createHash, randomBytes, randomUUID } from "node:crypto";
import { and, desc, eq, gte, inArray, lt, ne, sql } from "drizzle-orm";

import {
  agentOperations,
  agentTasks,
  presalesApiCredentials,
  apiUsagePolicies,
  apiUsageSnapshots,
  apiUsageTaskLedger,
  presalesOutputUrls,
  presalesMonitorRuns,
  presalesTaskRequests,
  presalesUpstreamResources,
  providerFileLeases,
  websiteProjectAttributions,
  websiteProjectDeletionTombstones,
  type PresalesApiCredential,
  type PresalesTaskRequest,
  type PresalesUpstreamResource,
} from "../drizzle/schema";
import {
  AuthServiceError,
  decryptCredentialSecret,
  encryptCredentialSecret,
  getApiKeyFingerprint,
  validateUpstreamApiKey,
} from "./auth-service";
import { getDb } from "./db";
import { getUpstreamBaseUrl } from "./upstream-config";
import {
  claimUsageCredentialCoverage,
  hasCompleteExpectedTaskSet,
  loadTerminalUsageTaskProofs,
  loadUsageCoverage,
  isUsageTaskTerminal,
  markUsageCredentialCoverage,
  readWebsiteUsageLedger,
  recordUsageLedgerEntries,
  selectPhysicalCredentialRows,
  usageCoverageSupportsRetiredCredential,
} from "./api-usage-ledger";
import { usagePageReachedCutoff } from "./upstream-task-usage";
import { getManusRollingCreditUsage } from "./manus-usage-service";
import { ManusV2Client } from "./manus-v2-client";
import { FILE_CONTENT_RETENTION_MS } from "./file-content-retention";
import { hasPresalesFileCreateReservationsForCredentials } from "./presales-file-store";
import {
  assertWebsiteProjectPhysicalDeleteEnabled,
  lockActiveWebsiteProjectLifecycle,
  WebsiteProjectInactiveError,
} from "./website-project-lifecycle";

const PRESALES_CREDENTIAL_SLOT = "website";
export const PRESALES_REVOKABLE_STATUSES = ["active"] as const;
const CREDIT_USAGE_LOOKBACK_DAYS = 30;
const CREDIT_USAGE_PAGE_LIMIT = 100;
const CREDIT_USAGE_MAX_PAGES = 100;
const PRESALES_TASK_LEASE_MS = 3 * 60 * 1000;

/**
 * Drizzle wraps mysql2 failures in DrizzleQueryError and keeps the native
 * driver error under `cause`. Idempotent reservations must recognize the
 * bounded cause chain so a normal duplicate-key replay reaches the existing
 * row instead of being reported as an upstream failure.
 */
export function isPresalesDuplicateEntryError(error: unknown) {
  const visited = new Set<unknown>();
  let current = error;
  for (let depth = 0; depth < 8; depth += 1) {
    if (!current || typeof current !== "object" || visited.has(current)) break;
    visited.add(current);
    const candidate = current as {
      code?: unknown;
      errno?: unknown;
      cause?: unknown;
    };
    if (candidate.code === "ER_DUP_ENTRY" || candidate.errno === 1062) {
      return true;
    }
    current = candidate.cause;
  }
  return false;
}

export type PresalesFileContentSource = "user_upload" | "assistant_output";

export type ReservedPresalesFileUpload = PresalesUpstreamResource & {
  kind: "file";
  contentSource: "user_upload";
  uploadReservedAt: Date;
  contentDeletedAt: null;
};

export type CompletedPresalesFileUpload = ReservedPresalesFileUpload & {
  uploadedAt: Date;
  contentExpiresAt: Date;
};

export type DeletedPresalesFileContent = PresalesUpstreamResource & {
  kind: "file";
  contentSource: "user_upload";
  contentDeletedAt: Date;
};

function validatePresalesResourceContentSource(
  kind: "task" | "file",
  value: unknown,
): PresalesFileContentSource | null {
  if (value === undefined || value === null) return null;
  if (
    kind !== "file" ||
    (value !== "user_upload" && value !== "assistant_output")
  ) {
    throw new AuthServiceError(
      "CONFLICT",
      "Presales resource content source is invalid",
    );
  }
  return value;
}

export type PresalesCredentialStatus = {
  configured: boolean;
  fingerprint: string | null;
  status: "active" | "retired" | "invalid" | null;
  version: number | null;
  verifiedAt: number | null;
  updatedAt: number | null;
};

export type DecryptedPresalesCredential = {
  id: string;
  version: number;
  apiKey: string;
  fingerprint: string;
  status: "active" | "retired";
  verifiedAt: Date | null;
  retiredAt: Date | null;
};

export type PresalesCreditUsageTask = {
  id: string;
  title: string;
  creditUsage: number;
  createdAt: number | null;
  businessOwnerName: string | null;
};

export type WebsiteApiKeyUsage = {
  windowDays: number;
  keyTotalUsed: number;
  websiteUsed: number;
  recentWebsiteTasks: PresalesCreditUsageTask[];
  fetchedAt: number;
  complete: boolean;
  attributionComplete: boolean;
};

export type WebsiteApiKeyUsageSnapshot = {
  windowDays: 30;
  rollingWebsiteUsed: number;
  usageObservedAt: number | null;
  keyPoolTotalUsed: number | null;
  keyLastSuccessfulAt: number | null;
  keyLastAttemptAt: number | null;
  keyHealth:
    | "connected"
    | "invalid_or_revoked"
    | "sync_error"
    | "unconfigured"
    | "pending";
  keyPoolStale: boolean;
  recentWebsiteTasks: PresalesCreditUsageTask[];
};

type WebsiteUsageOwnershipRow = {
  upstreamTaskId: string | null;
  apiCredentialId: string;
  createdAt: Date;
  status?: string | null;
};

type WebsiteTaskProjectRow = {
  upstreamTaskId: string | null;
  projectId: string | null;
};

/** Builds the bounded recent-task attribution projection without changing the
 * usage ledger's role as the sole authority for credits and timestamps. */
export function projectPresalesTaskBusinessOwners(input: {
  taskIds: readonly string[];
  agentTaskRows: readonly WebsiteTaskProjectRow[];
  monitorRows: readonly WebsiteTaskProjectRow[];
  attributionRows: readonly {
    projectId: string;
    businessOwnerName: string;
  }[];
}) {
  const requested = new Set(input.taskIds);
  const projectByTask = new Map<string, string>();
  for (const row of [...input.agentTaskRows, ...input.monitorRows]) {
    const taskId = row.upstreamTaskId?.trim();
    const projectId = row.projectId?.trim();
    if (!taskId || !projectId || !requested.has(taskId)) continue;
    projectByTask.set(taskId, projectId);
  }
  const ownerByProject = new Map(
    input.attributionRows.map((row) => [row.projectId, row.businessOwnerName]),
  );
  return new Map(
    input.taskIds.map((taskId) => [
      taskId,
      ownerByProject.get(projectByTask.get(taskId) ?? "") ?? null,
    ]),
  );
}

/**
 * Projects every durable Website task authority into the usage scanner. New
 * Presales v2 operations live in agent_operations/agent_tasks rather than the
 * retired proxy tables, so omitting that lane would silently classify all new
 * Website spend as third-party usage.
 */
export function projectWebsiteUsageOwnership(input: {
  resourceRows: readonly WebsiteUsageOwnershipRow[];
  ownedRows: readonly WebsiteUsageOwnershipRow[];
  monitorRows: readonly WebsiteUsageOwnershipRow[];
  agentTaskRows: readonly WebsiteUsageOwnershipRow[];
}) {
  const firstPartyRows = [
    ...input.resourceRows,
    ...input.ownedRows,
    ...input.monitorRows,
    ...input.agentTaskRows,
  ];
  const websiteTaskIds = new Set(
    firstPartyRows
      .map((row) => row.upstreamTaskId?.trim())
      .filter((id): id is string => Boolean(id)),
  );
  const unsettledCredentialIds = new Set<string>();
  for (const row of input.ownedRows) {
    if (row.status === "pending")
      unsettledCredentialIds.add(row.apiCredentialId);
  }
  const terminalMonitorStates = new Set([
    "completed",
    "partial_review_required",
    "remote_failed",
    "shape_mismatch",
  ]);
  for (const row of input.monitorRows) {
    if (!row.status || !terminalMonitorStates.has(row.status)) {
      unsettledCredentialIds.add(row.apiCredentialId);
    }
  }
  const terminalAgentStates = new Set([
    "succeeded",
    "failed",
    "cancelled",
  ]);
  for (const row of input.agentTaskRows) {
    if (!row.status || !terminalAgentStates.has(row.status)) {
      unsettledCredentialIds.add(row.apiCredentialId);
    }
  }
  return { firstPartyRows, websiteTaskIds, unsettledCredentialIds };
}

export type PresalesTaskReservation =
  | {
      state: "acquired";
      reservationId: string;
      attemptId: string;
      keyHash: string;
      leaseExpiresAt: Date;
    }
  | {
      state: "completed";
      upstreamTaskId: string;
    };

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

function presalesCredentialAad(credentialId: string) {
  return `frontmind-presales-api-credential:v1:${PRESALES_CREDENTIAL_SLOT}:${credentialId}`;
}

export function encryptPresalesApiKey(credentialId: string, apiKey: string) {
  return encryptCredentialSecret(presalesCredentialAad(credentialId), apiKey);
}

export function decryptPresalesApiKey(
  credential: Pick<
    PresalesApiCredential,
    | "id"
    | "encryptionVersion"
    | "encryptedKey"
    | "encryptionIv"
    | "encryptionAuthTag"
  >,
) {
  return decryptCredentialSecret(
    presalesCredentialAad(credential.id),
    credential,
  );
}

function toCredentialStatus(
  credential?: PresalesApiCredential | null,
): PresalesCredentialStatus {
  const isVisible = Boolean(credential && credential.status !== "deleted");
  const status =
    !credential || credential.status === "deleted"
      ? null
      : credential.validationStatus === "invalid"
        ? "invalid"
        : credential.status;
  return {
    configured: Boolean(credential && credential.status === "active"),
    fingerprint: isVisible ? (credential?.fingerprint ?? null) : null,
    status,
    version: isVisible ? (credential?.version ?? null) : null,
    verifiedAt: isVisible ? (credential?.verifiedAt?.getTime() ?? null) : null,
    updatedAt: isVisible ? (credential?.updatedAt?.getTime() ?? null) : null,
  };
}

export async function getPresalesCredentialStatus() {
  const db = await requireDb();
  const rows = await db
    .select()
    .from(presalesApiCredentials)
    .where(
      and(
        eq(presalesApiCredentials.slot, PRESALES_CREDENTIAL_SLOT),
        ne(presalesApiCredentials.status, "deleted"),
      ),
    )
    .orderBy(desc(presalesApiCredentials.version))
    .limit(1);
  return toCredentialStatus(rows[0]);
}

export async function replacePresalesApiCredential(
  actorUserId: number,
  apiKey: string,
  validator: (apiKey: string) => Promise<void> = validateUpstreamApiKey,
) {
  await validator(apiKey);
  const db = await requireDb();
  const existingRows = await db
    .select()
    .from(presalesApiCredentials)
    .where(
      and(
        eq(presalesApiCredentials.slot, PRESALES_CREDENTIAL_SLOT),
        eq(presalesApiCredentials.status, "active"),
      ),
    )
    .orderBy(desc(presalesApiCredentials.version))
    .limit(1);
  const existing = existingRows[0];
  const credentialId = randomUUID();
  const encrypted = encryptPresalesApiKey(credentialId, apiKey);
  const fingerprint = getApiKeyFingerprint(apiKey);
  const now = new Date();

  const inserted = await db.transaction(async (tx) => {
    const latest = await tx
      .select()
      .from(presalesApiCredentials)
      .where(eq(presalesApiCredentials.slot, PRESALES_CREDENTIAL_SLOT))
      .orderBy(desc(presalesApiCredentials.version))
      .limit(1)
      .for("update");
    if ((latest[0]?.id ?? null) !== (existing?.id ?? null)) {
      throw new AuthServiceError(
        "CONFLICT",
        "官网 API Key 状态已变化，请刷新后重试。",
      );
    }
    const nextVersion = (latest[0]?.version ?? 0) + 1;

    await tx
      .update(presalesApiCredentials)
      .set({ status: "retired", retiredAt: now })
      .where(
        and(
          eq(presalesApiCredentials.slot, PRESALES_CREDENTIAL_SLOT),
          eq(presalesApiCredentials.status, "active"),
        ),
      );

    const credential = {
      id: credentialId,
      slot: PRESALES_CREDENTIAL_SLOT,
      version: nextVersion,
      ...encrypted,
      fingerprint,
      status: "active" as const,
      validationStatus: "verified" as const,
      createdByUserId: actorUserId,
      verifiedAt: now,
      retiredAt: null,
      deletedAt: null,
      createdAt: now,
      updatedAt: now,
    };
    await tx.insert(presalesApiCredentials).values(credential);
    return credential;
  });

  return toCredentialStatus(inserted);
}

/**
 * Administrator reads are local-only. The daily/manual synchronizer updates
 * the task ledger and current-Key pool snapshot; a revoked Key therefore never
 * hides the rolling Website total already observed locally.
 */
export async function getPresalesCreditUsageSnapshot(
  now = Date.now(),
): Promise<WebsiteApiKeyUsageSnapshot> {
  const db = await requireDb();
  const cutoffMs = now - 30 * 24 * 60 * 60 * 1_000;
  const [credentialRows, policyRows, ledgerRows, recentRows] =
    await Promise.all([
      db
        .select()
        .from(presalesApiCredentials)
        .where(
          and(
            eq(presalesApiCredentials.slot, PRESALES_CREDENTIAL_SLOT),
            eq(presalesApiCredentials.status, "active"),
          ),
        )
        .orderBy(desc(presalesApiCredentials.version))
        .limit(1),
      db
        .select()
        .from(apiUsagePolicies)
        .where(eq(apiUsagePolicies.policyKey, "website_frontend"))
        .limit(1),
      db
        .select({
          used: sql<number>`COALESCE(SUM(CASE WHEN ${apiUsageTaskLedger.isFirstParty} = 1 THEN ${apiUsageTaskLedger.creditUsage} ELSE 0 END), 0)`,
          observedAt: sql<Date | null>`MAX(${apiUsageTaskLedger.observedAt})`,
        })
        .from(apiUsageTaskLedger)
        .where(
          and(
            eq(apiUsageTaskLedger.scope, "website_frontend"),
            gte(apiUsageTaskLedger.taskCreatedAtMs, cutoffMs),
            lt(apiUsageTaskLedger.taskCreatedAtMs, now),
          ),
        ),
      db
        .select({
          id: apiUsageTaskLedger.upstreamTaskId,
          creditUsage: apiUsageTaskLedger.creditUsage,
          createdAt: apiUsageTaskLedger.taskCreatedAtMs,
        })
        .from(apiUsageTaskLedger)
        .where(
          and(
            eq(apiUsageTaskLedger.scope, "website_frontend"),
            eq(apiUsageTaskLedger.isFirstParty, true),
            gte(apiUsageTaskLedger.taskCreatedAtMs, cutoffMs),
            lt(apiUsageTaskLedger.taskCreatedAtMs, now),
          ),
        )
        .orderBy(desc(apiUsageTaskLedger.taskCreatedAtMs))
        .limit(50),
    ]);
  const credential = credentialRows[0];
  const policy = policyRows[0];
  const snapshots = policy
    ? await db
        .select()
        .from(apiUsageSnapshots)
        .where(eq(apiUsageSnapshots.policyId, policy.id))
        .limit(1)
    : [];
  const snapshot = snapshots[0];
  const recentTaskIds = recentRows.map((row) => row.id);
  const [recentAgentTaskRows, recentMonitorRows] =
    recentTaskIds.length > 0
      ? await Promise.all([
          db
            .select({
              upstreamTaskId: agentTasks.providerTaskId,
              projectId: agentOperations.presalesProjectId,
            })
            .from(agentTasks)
            .innerJoin(
              agentOperations,
              eq(agentTasks.operationId, agentOperations.id),
            )
            .where(
              and(
                eq(agentOperations.scope, "website_frontend"),
                inArray(agentTasks.providerTaskId, recentTaskIds),
              ),
            ),
          db
            .select({
              upstreamTaskId: presalesMonitorRuns.upstreamTaskId,
              projectId: presalesMonitorRuns.projectId,
            })
            .from(presalesMonitorRuns)
            .where(inArray(presalesMonitorRuns.upstreamTaskId, recentTaskIds)),
        ])
      : [[], []];
  const recentProjectIds = [
    ...new Set(
      [...recentAgentTaskRows, ...recentMonitorRows]
        .map((row) => row.projectId?.trim())
        .filter((projectId): projectId is string => Boolean(projectId)),
    ),
  ];
  const attributionRows =
    recentProjectIds.length > 0
      ? await db
          .select({
            projectId: websiteProjectAttributions.projectId,
            businessOwnerName: websiteProjectAttributions.businessOwnerName,
          })
          .from(websiteProjectAttributions)
          .where(
            inArray(websiteProjectAttributions.projectId, recentProjectIds),
          )
      : [];
  const businessOwnerByTask = projectPresalesTaskBusinessOwners({
    taskIds: recentTaskIds,
    agentTaskRows: recentAgentTaskRows,
    monitorRows: recentMonitorRows,
    attributionRows,
  });
  const snapshotMatchesCredential = Boolean(
    credential &&
      snapshot &&
      snapshot.credentialFingerprint === credential.fingerprint,
  );
  const keyLastSuccessfulAt = snapshotMatchesCredential
    ? (snapshot?.fetchedAt?.getTime() ?? null)
    : null;
  const keyHealth: WebsiteApiKeyUsageSnapshot["keyHealth"] = !credential
    ? "unconfigured"
    : !snapshotMatchesCredential
      ? "pending"
      : snapshot!.syncStatus === "ok"
        ? "connected"
        : snapshot!.syncStatus === "pending"
          ? "pending"
          : snapshot!.syncStatus === "unconfigured"
            ? "unconfigured"
            : snapshot!.errorCode === "INVALID_CREDENTIAL" ||
                snapshot!.errorCode === "invalid_or_revoked"
              ? "invalid_or_revoked"
              : "sync_error";
  const observedAt = ledgerRows[0]?.observedAt;
  return {
    windowDays: 30,
    rollingWebsiteUsed: Math.max(0, Number(ledgerRows[0]?.used) || 0),
    usageObservedAt:
      observedAt instanceof Date
        ? observedAt.getTime()
        : Number.isFinite(Number(observedAt))
          ? Number(observedAt)
          : null,
    keyPoolTotalUsed: snapshotMatchesCredential && keyLastSuccessfulAt !== null
      ? Math.max(0, Number(snapshot!.used) || 0)
      : null,
    keyLastSuccessfulAt,
    keyLastAttemptAt: snapshotMatchesCredential
      ? (snapshot!.updatedAt?.getTime() ?? null)
      : null,
    keyHealth,
    keyPoolStale:
      keyLastSuccessfulAt === null ||
      now - keyLastSuccessfulAt > 26 * 60 * 60 * 1_000,
    recentWebsiteTasks: recentRows.map((row) => ({
      id: row.id,
      title: row.id,
      creditUsage: Math.max(0, Number(row.creditUsage) || 0),
      createdAt: Number(row.createdAt),
      businessOwnerName: businessOwnerByTask.get(row.id) ?? null,
    })),
  };
}

export async function deletePresalesApiCredential(executor?: any) {
  const db = executor ?? (await requireDb());
  const now = new Date();
  const remove = async (tx: any) => {
    const activeRows = await tx
      .select({ id: presalesApiCredentials.id })
      .from(presalesApiCredentials)
      .where(
        and(
          eq(presalesApiCredentials.slot, PRESALES_CREDENTIAL_SLOT),
          eq(presalesApiCredentials.status, "active"),
        ),
      )
      .for("update");
    if (activeRows.length === 0) return;
    const activeIds = activeRows.map((row: any) => row.id);
    const [
      resources,
      taskRequests,
      monitorRuns,
      activeAgentOperations,
      activeProviderFileLeases,
    ] = await Promise.all([
      tx
        .select({ id: presalesUpstreamResources.id })
        .from(presalesUpstreamResources)
        .where(inArray(presalesUpstreamResources.apiCredentialId, activeIds))
        .limit(1)
        .for("update"),
      tx
        .select({ id: presalesTaskRequests.id })
        .from(presalesTaskRequests)
        .where(inArray(presalesTaskRequests.apiCredentialId, activeIds))
        .limit(1)
        .for("update"),
      tx
        .select({ id: presalesMonitorRuns.id })
        .from(presalesMonitorRuns)
        .where(inArray(presalesMonitorRuns.apiCredentialId, activeIds))
        .limit(1)
        .for("update"),
      tx
        .select({ id: agentOperations.id })
        .from(agentOperations)
        .where(
          and(
            eq(agentOperations.scope, "website_frontend"),
            inArray(agentOperations.apiCredentialId, activeIds),
            inArray(agentOperations.status, [
              "queued",
              "running",
              "result_pending",
              "attention_required",
            ]),
          ),
        )
        .limit(1)
        .for("update"),
      tx
        .select({ id: providerFileLeases.id })
        .from(providerFileLeases)
        .where(
          and(
            inArray(providerFileLeases.apiCredentialId, activeIds),
            inArray(providerFileLeases.uploadState, [
              "reserved",
              "uploading",
              "outcome_unknown",
            ]),
          ),
        )
        .limit(1)
        .for("update"),
    ]);
    const fileCreateReservations =
      await hasPresalesFileCreateReservationsForCredentials(new Set(activeIds));
    if (
      resources[0] ||
      taskRequests[0] ||
      monitorRuns[0] ||
      activeAgentOperations[0] ||
      activeProviderFileLeases[0] ||
      fileCreateReservations
    ) {
      throw new AuthServiceError(
        "CONFLICT",
        "当前官网 API Key 仍绑定任务、文件或监控运行，无法安全撤销；请改用替换，系统会保留旧版本供恢复和历史用量追踪。",
      );
    }
    await tx
      .update(presalesApiCredentials)
      .set({
        status: "deleted",
        validationStatus: "unverified",
        deletedAt: now,
        encryptedKey: randomBytes(32).toString("base64"),
        encryptionIv: randomBytes(12).toString("base64"),
        encryptionAuthTag: randomBytes(16).toString("base64"),
      })
      .where(
        and(
          eq(presalesApiCredentials.slot, PRESALES_CREDENTIAL_SLOT),
          eq(presalesApiCredentials.status, "active"),
          inArray(presalesApiCredentials.id, activeIds),
        ),
      );
  };
  if (executor) await remove(db);
  else await db.transaction(remove);
}

function toDecryptedCredential(
  credential: PresalesApiCredential,
): DecryptedPresalesCredential {
  if (credential.status === "deleted") {
    throw new AuthServiceError(
      "NOT_FOUND",
      "Presales API credential not found",
    );
  }
  return {
    id: credential.id,
    version: credential.version,
    apiKey: decryptPresalesApiKey(credential),
    fingerprint: credential.fingerprint,
    status: credential.status,
    verifiedAt: credential.verifiedAt,
    retiredAt: credential.retiredAt,
  };
}

export async function getActivePresalesCredential() {
  const db = await requireDb();
  const rows = await db
    .select()
    .from(presalesApiCredentials)
    .where(
      and(
        eq(presalesApiCredentials.slot, PRESALES_CREDENTIAL_SLOT),
        eq(presalesApiCredentials.status, "active"),
      ),
    )
    .orderBy(desc(presalesApiCredentials.version))
    .limit(1);
  return rows[0] ? toDecryptedCredential(rows[0]) : null;
}

/**
 * Resolve the immutable credential version bound to a durable presales run.
 * Retired credentials remain usable for their existing resources; deleted
 * credentials fail closed because their ciphertext has been cryptoshredded.
 */
export async function getPresalesCredentialById(credentialId: string) {
  const db = await requireDb();
  const rows = await db
    .select()
    .from(presalesApiCredentials)
    .where(
      and(
        eq(presalesApiCredentials.id, credentialId),
        ne(presalesApiCredentials.status, "deleted"),
      ),
    )
    .limit(1);
  return rows[0] ? toDecryptedCredential(rows[0]) : null;
}

export async function testPresalesApiCredential(apiKey?: string) {
  const credential = apiKey ? null : await getActivePresalesCredential();
  const value = apiKey ?? credential?.apiKey;
  if (!value) {
    throw new AuthServiceError("NOT_FOUND", "请先配置售前 API Key");
  }
  await validateUpstreamApiKey(value);
  return { ok: true } as const;
}

export async function getPresalesCredentialForResource(
  kind: "task" | "file",
  upstreamId: string,
): Promise<
  (DecryptedPresalesCredential & { resource: PresalesUpstreamResource }) | null
> {
  const db = await requireDb();
  const rows = await db
    .select({
      resource: presalesUpstreamResources,
      credential: presalesApiCredentials,
    })
    .from(presalesUpstreamResources)
    .innerJoin(
      presalesApiCredentials,
      eq(presalesUpstreamResources.apiCredentialId, presalesApiCredentials.id),
    )
    .where(
      and(
        eq(presalesUpstreamResources.kind, kind),
        eq(presalesUpstreamResources.upstreamId, upstreamId),
        ne(presalesApiCredentials.status, "deleted"),
      ),
    )
    .limit(1);
  const row = rows[0];
  if (!row || row.credential.status === "deleted") return null;
  return {
    ...toDecryptedCredential(row.credential),
    resource: row.resource,
  };
}

function validPresalesRetentionNow(value: Date | undefined) {
  const now = value ?? new Date();
  if (!Number.isFinite(now.getTime())) {
    throw new AuthServiceError(
      "CONFLICT",
      "Presales file retention timestamp is invalid",
    );
  }
  return now;
}

function assertReservedPresalesFileUpload(
  resource: PresalesUpstreamResource | undefined,
  now: Date,
): ReservedPresalesFileUpload {
  if (!resource) {
    throw new AuthServiceError("NOT_FOUND", "Presales file resource not found");
  }
  if (resource.contentSource === "assistant_output") {
    throw new AuthServiceError(
      "CONFLICT",
      "Assistant output cannot be used as a user-upload destination",
    );
  }
  if (resource.contentDeletedAt) {
    throw new AuthServiceError(
      "CONFLICT",
      "Presales file content has already been deleted",
    );
  }
  if (resource.contentSource !== "user_upload") {
    throw new AuthServiceError(
      "CONFLICT",
      "Presales file upload retention could not be reserved",
    );
  }
  if (!resource.uploadReservedAt) {
    throw new AuthServiceError(
      "DATABASE_UNAVAILABLE",
      "Presales file upload reservation is incomplete",
    );
  }
  const reservationAtMs = resource.uploadReservedAt.getTime();
  const reservationDeadlineMs = reservationAtMs + FILE_CONTENT_RETENTION_MS;
  if (
    !Number.isFinite(reservationAtMs) ||
    !Number.isFinite(reservationDeadlineMs)
  ) {
    throw new AuthServiceError(
      "DATABASE_UNAVAILABLE",
      "Presales file upload reservation is invalid",
    );
  }
  if (reservationDeadlineMs <= now.getTime()) {
    throw new AuthServiceError(
      "CONFLICT",
      "Presales file upload retention has expired",
    );
  }
  const hasUploadedAt = resource.uploadedAt !== null;
  const hasContentExpiresAt = resource.contentExpiresAt !== null;
  if (hasUploadedAt !== hasContentExpiresAt) {
    throw new AuthServiceError(
      "DATABASE_UNAVAILABLE",
      "Presales file upload state is invalid",
    );
  }
  if (resource.uploadedAt && resource.contentExpiresAt) {
    const uploadedAtMs = resource.uploadedAt.getTime();
    const contentExpiresAtMs = resource.contentExpiresAt.getTime();
    if (
      !Number.isFinite(uploadedAtMs) ||
      !Number.isFinite(contentExpiresAtMs) ||
      uploadedAtMs !== reservationAtMs ||
      contentExpiresAtMs !== reservationDeadlineMs
    ) {
      throw new AuthServiceError(
        "DATABASE_UNAVAILABLE",
        "Presales file upload retention is invalid",
      );
    }
  }
  return resource as ReservedPresalesFileUpload;
}

/**
 * Reserves the immutable upload origin before the upstream PUT. A reservation
 * alone is deliberately unreadable: uploadedAt/contentExpiresAt remain null
 * until finalizePresalesFileUploadRetention observes a successful 2xx PUT.
 */
export async function reservePresalesFileUploadRetention(
  input: {
    fileId: string;
    apiCredentialId: string;
    now?: Date;
  },
  executor?: any,
) {
  const db = executor ?? (await requireDb());
  const now = validPresalesRetentionNow(input.now);
  const locator = and(
    eq(presalesUpstreamResources.kind, "file"),
    eq(presalesUpstreamResources.upstreamId, input.fileId),
    eq(presalesUpstreamResources.apiCredentialId, input.apiCredentialId),
  );
  const binding = await db
    .select({ projectId: presalesUpstreamResources.projectId })
    .from(presalesUpstreamResources)
    .where(locator)
    .limit(1);
  const write = async (tx: any) => {
    if (binding[0]?.projectId) {
      await assertPresalesProjectActive(tx, binding[0].projectId);
    }
    await tx
      .update(presalesUpstreamResources)
      .set({
        uploadReservedAt: sql`COALESCE(${presalesUpstreamResources.uploadReservedAt}, ${now})`,
      })
      .where(
        and(
          locator,
          eq(presalesUpstreamResources.contentSource, "user_upload"),
          sql`${presalesUpstreamResources.contentDeletedAt} IS NULL`,
          sql`(
          (
            ${presalesUpstreamResources.uploadReservedAt} IS NULL
            AND ${presalesUpstreamResources.uploadedAt} IS NULL
            AND ${presalesUpstreamResources.contentExpiresAt} IS NULL
          )
          OR
          (
            ${presalesUpstreamResources.uploadReservedAt} IS NOT NULL
            AND ${presalesUpstreamResources.uploadedAt} IS NULL
            AND ${presalesUpstreamResources.contentExpiresAt} IS NULL
            AND DATE_ADD(${presalesUpstreamResources.uploadReservedAt}, INTERVAL 30 DAY) > ${now}
          )
          OR
          (
            ${presalesUpstreamResources.uploadedAt} = ${presalesUpstreamResources.uploadReservedAt}
            AND ${presalesUpstreamResources.contentExpiresAt} = DATE_ADD(${presalesUpstreamResources.uploadReservedAt}, INTERVAL 30 DAY)
            AND ${presalesUpstreamResources.contentExpiresAt} > ${now}
          )
          )`,
        ),
      );
    const rows = await tx
      .select()
      .from(presalesUpstreamResources)
      .where(locator)
      .limit(1);
    if (rows[0]?.projectId && rows[0].projectId !== binding[0]?.projectId) {
      throw new AuthServiceError(
        "IDEMPOTENCY_PENDING",
        "文件项目归属刚刚更新，请重试上传",
        1_000,
      );
    }
    return assertReservedPresalesFileUpload(
      rows[0] as PresalesUpstreamResource | undefined,
      now,
    );
  };
  return executor ? write(db) : db.transaction(write);
}

/**
 * Completes the immutable lifecycle only after the external PUT returned 2xx.
 * Retries reuse the reservation; neither timestamp can move.
 */
export async function finalizePresalesFileUploadRetention(
  input: {
    fileId: string;
    apiCredentialId: string;
    now?: Date;
  },
  executor?: any,
) {
  const db = executor ?? (await requireDb());
  const now = validPresalesRetentionNow(input.now);
  const locator = and(
    eq(presalesUpstreamResources.kind, "file"),
    eq(presalesUpstreamResources.upstreamId, input.fileId),
    eq(presalesUpstreamResources.apiCredentialId, input.apiCredentialId),
  );
  const binding = await db
    .select({ projectId: presalesUpstreamResources.projectId })
    .from(presalesUpstreamResources)
    .where(locator)
    .limit(1);
  const write = async (tx: any) => {
    if (binding[0]?.projectId) {
      await assertPresalesProjectActive(tx, binding[0].projectId);
    }
    await tx
      .update(presalesUpstreamResources)
      .set({
        uploadedAt: sql`COALESCE(${presalesUpstreamResources.uploadedAt}, ${presalesUpstreamResources.uploadReservedAt})`,
        contentExpiresAt: sql`COALESCE(${presalesUpstreamResources.contentExpiresAt}, DATE_ADD(${presalesUpstreamResources.uploadReservedAt}, INTERVAL 30 DAY))`,
      })
      .where(
        and(
          locator,
          eq(presalesUpstreamResources.contentSource, "user_upload"),
          sql`${presalesUpstreamResources.contentDeletedAt} IS NULL`,
          sql`${presalesUpstreamResources.uploadReservedAt} IS NOT NULL`,
          sql`DATE_ADD(${presalesUpstreamResources.uploadReservedAt}, INTERVAL 30 DAY) > ${now}`,
          sql`(
          (${presalesUpstreamResources.uploadedAt} IS NULL AND ${presalesUpstreamResources.contentExpiresAt} IS NULL)
          OR
          (
            ${presalesUpstreamResources.uploadedAt} = ${presalesUpstreamResources.uploadReservedAt}
            AND ${presalesUpstreamResources.contentExpiresAt} = DATE_ADD(${presalesUpstreamResources.uploadReservedAt}, INTERVAL 30 DAY)
          )
          )`,
        ),
      );
    const rows = await tx
      .select()
      .from(presalesUpstreamResources)
      .where(locator)
      .limit(1);
    if (rows[0]?.projectId && rows[0].projectId !== binding[0]?.projectId) {
      throw new AuthServiceError(
        "IDEMPOTENCY_PENDING",
        "文件项目归属刚刚更新，请重试上传确认",
        1_000,
      );
    }
    const resource = assertReservedPresalesFileUpload(
      rows[0] as PresalesUpstreamResource | undefined,
      now,
    );
    if (!resource.uploadedAt || !resource.contentExpiresAt) {
      throw new AuthServiceError(
        "DATABASE_UNAVAILABLE",
        "Presales file upload was not finalized",
      );
    }
    return resource as CompletedPresalesFileUpload;
  };
  return executor ? write(db) : db.transaction(write);
}

/** Records physical removal without ever moving the first deletion time. */
export async function markPresalesFileContentDeleted(
  input: {
    fileId: string;
    apiCredentialId?: string;
    now?: Date;
  },
  executor?: any,
) {
  const db = executor ?? (await requireDb());
  const now = validPresalesRetentionNow(input.now);
  const locator = and(
    eq(presalesUpstreamResources.kind, "file"),
    eq(presalesUpstreamResources.upstreamId, input.fileId),
    input.apiCredentialId
      ? eq(presalesUpstreamResources.apiCredentialId, input.apiCredentialId)
      : undefined,
  );
  await db
    .update(presalesUpstreamResources)
    .set({
      contentDeletedAt: sql`COALESCE(${presalesUpstreamResources.contentDeletedAt}, ${now})`,
    })
    .where(
      and(locator, eq(presalesUpstreamResources.contentSource, "user_upload")),
    );
  const rows = await db
    .select()
    .from(presalesUpstreamResources)
    .where(locator)
    .limit(1);
  const resource = rows[0] as PresalesUpstreamResource | undefined;
  if (!resource) {
    throw new AuthServiceError("NOT_FOUND", "Presales file resource not found");
  }
  if (resource.contentSource !== "user_upload") {
    throw new AuthServiceError(
      "CONFLICT",
      "Only user-upload content can be marked deleted",
    );
  }
  if (!resource.contentDeletedAt) {
    throw new AuthServiceError(
      "DATABASE_UNAVAILABLE",
      "Presales file deletion was not recorded",
    );
  }
  return resource as DeletedPresalesFileContent;
}

type PresalesResourceCredential = DecryptedPresalesCredential & {
  resource: PresalesUpstreamResource;
};

type PresalesTaskCredentialResolverOptions = {
  getActive?: () => Promise<DecryptedPresalesCredential | null>;
  getForFile?: (fileId: string) => Promise<PresalesResourceCredential | null>;
};

/**
 * Every new task is created with the current credential. Attachments from a
 * retired credential must be copied under the current credential first. This
 * prevents a rotation between ZIP and Skill preparation from either mixing
 * upstream accounts or silently creating a new task with a retired key.
 */
export async function resolvePresalesTaskCredentialForFiles(
  fileIds: string[],
  options: PresalesTaskCredentialResolverOptions = {},
) {
  const active = await (options.getActive ?? getActivePresalesCredential)();
  if (!active) return null;

  const uniqueFileIds = [...new Set(fileIds)];
  if (uniqueFileIds.length === 0) return active;

  const getForFile =
    options.getForFile ??
    ((fileId: string) => getPresalesCredentialForResource("file", fileId));
  const credentials = await Promise.all(uniqueFileIds.map(getForFile));
  if (credentials.some((credential) => !credential)) {
    throw new AuthServiceError(
      "NOT_FOUND",
      "附件不存在，或对应的售前 API Key 已被撤销",
    );
  }

  const resolved = credentials as PresalesResourceCredential[];
  if (resolved.some((credential) => credential.id !== active.id)) {
    throw new AuthServiceError(
      "CONFLICT",
      "附件不属于当前售前 API Key 版本，请在当前版本下重新准备附件",
    );
  }
  return active;
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value) ?? "null";
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
  }
  const record = value as Record<string, unknown>;
  const entries = Object.keys(record)
    .filter((key) => record[key] !== undefined)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`);
  return `{${entries.join(",")}}`;
}

export function hashPresalesIdempotencyKey(idempotencyKey: string) {
  return createHash("sha256").update(idempotencyKey, "utf8").digest("hex");
}

export function hashPresalesTaskPayload(payload: unknown) {
  return createHash("sha256")
    .update(canonicalJson(payload), "utf8")
    .digest("hex");
}

function isPresalesProjectDeletionSignal(error: unknown) {
  return (
    error instanceof WebsiteProjectInactiveError ||
    (error instanceof AuthServiceError && error.code === "PROJECT_DELETED")
  );
}

async function assertPresalesProjectActive(tx: any, projectId: string) {
  try {
    await lockActiveWebsiteProjectLifecycle(tx, projectId);
  } catch (error) {
    if (!(error instanceof WebsiteProjectInactiveError)) throw error;
    throw new AuthServiceError(
      "PROJECT_DELETED",
      "项目已进入永久删除流程，不能再创建任务",
    );
  }
}

export async function withPresalesProjectFileCreateGuard<T>(
  projectId: string,
  apiCredentialId: string,
  operation: (tx: any) => Promise<T>,
  executor?: any,
): Promise<T> {
  const db = executor ?? (await requireDb());
  return db.transaction(async (tx: any) => {
    await assertPresalesProjectActive(tx, projectId);
    const credential = await tx
      .select({ id: presalesApiCredentials.id })
      .from(presalesApiCredentials)
      .where(
        and(
          eq(presalesApiCredentials.id, apiCredentialId),
          ne(presalesApiCredentials.status, "deleted"),
        ),
      )
      .limit(1)
      .for("update");
    if (!credential[0]) {
      throw new AuthServiceError(
        "NOT_FOUND",
        "Presales API credential not found",
      );
    }
    return operation(tx);
  });
}

type PresalesTaskReservationDecision =
  | { state: "conflict" }
  | { state: "completed" }
  | { state: "pending"; retryAfterMs: number }
  | { state: "expired" };

export function evaluatePresalesTaskReservation(
  row: Pick<
    PresalesTaskRequest,
    | "requestHash"
    | "apiCredentialId"
    | "credentialVersion"
    | "status"
    | "leaseExpiresAt"
  > & { projectId?: string | null },
  input: {
    requestHash: string;
    compatibleRequestHashes?: readonly string[];
    projectId?: string;
    apiCredentialId: string;
    credentialVersion: number;
  },
  now = new Date(),
): PresalesTaskReservationDecision {
  const compatibleHashes = new Set([
    input.requestHash,
    ...(input.compatibleRequestHashes ?? []),
  ]);
  const upgradesLegacyProjectBinding =
    row.projectId === null &&
    Boolean(input.projectId) &&
    row.requestHash !== input.requestHash &&
    compatibleHashes.has(row.requestHash);
  if (
    !compatibleHashes.has(row.requestHash) ||
    ((row.projectId ?? null) !== (input.projectId ?? null) &&
      !upgradesLegacyProjectBinding) ||
    row.apiCredentialId !== input.apiCredentialId ||
    row.credentialVersion !== input.credentialVersion
  ) {
    return { state: "conflict" };
  }
  if (row.status === "completed") return { state: "completed" };
  const remainingMs = row.leaseExpiresAt.getTime() - now.getTime();
  return remainingMs > 0
    ? {
        state: "pending",
        retryAfterMs: Math.max(1_000, Math.min(remainingMs, 5_000)),
      }
    : { state: "expired" };
}

function completedReservation(
  row: PresalesTaskRequest,
): PresalesTaskReservation {
  const upstreamTaskId = String(row.upstreamTaskId ?? "");
  if (!upstreamTaskId) {
    throw new AuthServiceError(
      "DATABASE_UNAVAILABLE",
      "Completed task reservation is missing its upstream task id",
    );
  }
  return {
    state: "completed",
    upstreamTaskId,
  };
}

export async function acquirePresalesTaskReservation(
  input: {
    idempotencyKey: string;
    requestHash: string;
    compatibleRequestHashes?: readonly string[];
    projectId?: string;
    apiCredentialId: string;
    credentialVersion: number;
    now?: Date;
    leaseMs?: number;
  },
  executor?: any,
): Promise<PresalesTaskReservation> {
  const db = executor ?? (await requireDb());
  const keyHash = hashPresalesIdempotencyKey(input.idempotencyKey);
  const now = input.now ?? new Date();
  const leaseMs = input.leaseMs ?? PRESALES_TASK_LEASE_MS;

  for (let retry = 0; retry < 3; retry += 1) {
    const reservationId = randomUUID();
    const attemptId = randomUUID();
    const leaseExpiresAt = new Date(now.getTime() + leaseMs);
    const row = {
      id: reservationId,
      projectId: input.projectId ?? null,
      keyHash,
      requestHash: input.requestHash,
      apiCredentialId: input.apiCredentialId,
      credentialVersion: input.credentialVersion,
      status: "pending" as const,
      attemptId,
      leaseExpiresAt,
      upstreamTaskId: null,
      completedAt: null,
      createdAt: now,
      updatedAt: now,
    };
    try {
      if (input.projectId) {
        await db.transaction(async (tx: any) => {
          await assertPresalesProjectActive(tx, input.projectId!);
          await tx.insert(presalesTaskRequests).values(row);
        });
      } else {
        await db.insert(presalesTaskRequests).values(row);
      }
      return {
        state: "acquired",
        reservationId,
        attemptId,
        keyHash,
        leaseExpiresAt,
      };
    } catch (error) {
      if (isPresalesProjectDeletionSignal(error)) {
        throw new AuthServiceError(
          "PROJECT_DELETED",
          "项目已进入永久删除流程，不能再创建任务",
        );
      }
      if (!isPresalesDuplicateEntryError(error)) throw error;
    }

    const existing = await db.transaction(async (tx: any) => {
      if (input.projectId) {
        await assertPresalesProjectActive(tx, input.projectId);
      }
      const rows = await tx
        .select()
        .from(presalesTaskRequests)
        .where(eq(presalesTaskRequests.keyHash, keyHash))
        .limit(1)
        .for("update");
      let current = rows[0] as PresalesTaskRequest | undefined;
      if (!current) return null;
      const decision = evaluatePresalesTaskReservation(current, input, now);
      if (decision.state === "conflict") {
        throw new AuthServiceError(
          "CONFLICT",
          "该幂等键已用于不同的任务请求或 API Key 版本",
        );
      }
      if (
        current.projectId === null &&
        input.projectId &&
        current.requestHash !== input.requestHash &&
        (input.compatibleRequestHashes ?? []).includes(current.requestHash)
      ) {
        await tx
          .update(presalesTaskRequests)
          .set({ projectId: input.projectId, updatedAt: now })
          .where(eq(presalesTaskRequests.id, current.id));
        if (current.upstreamTaskId) {
          const taskResources = await tx
            .select({
              id: presalesUpstreamResources.id,
              projectId: presalesUpstreamResources.projectId,
            })
            .from(presalesUpstreamResources)
            .where(
              and(
                eq(presalesUpstreamResources.kind, "task"),
                eq(
                  presalesUpstreamResources.upstreamId,
                  current.upstreamTaskId,
                ),
                eq(
                  presalesUpstreamResources.apiCredentialId,
                  current.apiCredentialId,
                ),
              ),
            )
            .limit(1)
            .for("update");
          if (
            taskResources[0]?.projectId &&
            taskResources[0].projectId !== input.projectId
          ) {
            throw new AuthServiceError(
              "CONFLICT",
              "Upstream task belongs to a different project",
            );
          }
          if (taskResources[0] && !taskResources[0].projectId) {
            await tx
              .update(presalesUpstreamResources)
              .set({ projectId: input.projectId })
              .where(eq(presalesUpstreamResources.id, taskResources[0].id));
          }
        }
        current = { ...current, projectId: input.projectId, updatedAt: now };
      }
      if (decision.state === "completed") return completedReservation(current);
      if (decision.state === "pending") {
        throw new AuthServiceError(
          "IDEMPOTENCY_PENDING",
          "相同任务正在创建中，请稍后重试",
          decision.retryAfterMs,
        );
      }

      await tx
        .update(presalesTaskRequests)
        .set({ attemptId, leaseExpiresAt, updatedAt: now })
        .where(eq(presalesTaskRequests.id, current.id));
      return {
        state: "acquired",
        reservationId: current.id,
        attemptId,
        keyHash,
        leaseExpiresAt,
      } satisfies PresalesTaskReservation;
    });
    if (existing) return existing;
  }

  throw new AuthServiceError(
    "IDEMPOTENCY_PENDING",
    "任务幂等预留正在更新，请稍后重试",
    1_000,
  );
}

/**
 * Resolves the immutable website project binding captured when the presales
 * task was created. Legacy tasks have no projectId and are deliberately not
 * eligible for the provisioning-v2 knowledge import path.
 */
export async function getPresalesTaskProjectBinding(
  taskId: string,
  executor?: any,
) {
  const db = executor ?? (await requireDb());
  const rows = await db
    .select({
      projectId: presalesTaskRequests.projectId,
      apiCredentialId: presalesTaskRequests.apiCredentialId,
      credentialVersion: presalesTaskRequests.credentialVersion,
      status: presalesTaskRequests.status,
      upstreamTaskId: presalesTaskRequests.upstreamTaskId,
    })
    .from(presalesTaskRequests)
    .where(eq(presalesTaskRequests.upstreamTaskId, taskId))
    .limit(1);
  const row = rows[0];
  if (
    !row ||
    row.status !== "completed" ||
    row.upstreamTaskId !== taskId ||
    !row.projectId
  ) {
    return null;
  }
  return {
    projectId: row.projectId,
    apiCredentialId: row.apiCredentialId,
    credentialVersion: row.credentialVersion,
    taskId,
  };
}

export type DeletedPresalesTaskEvidence = {
  deleted: boolean;
  fileIds: string[];
};

export async function readPresalesTaskEvidenceFileIds(
  input: { taskId: string; apiCredentialId: string },
  executor?: any,
) {
  const db = executor ?? (await requireDb());
  const rows = await db
    .select({ fileId: presalesUpstreamResources.upstreamId })
    .from(presalesUpstreamResources)
    .where(
      and(
        eq(presalesUpstreamResources.kind, "file"),
        eq(presalesUpstreamResources.parentTaskId, input.taskId),
        eq(presalesUpstreamResources.apiCredentialId, input.apiCredentialId),
      ),
    );
  return rows.map((row: { fileId: string }) => row.fileId);
}

export async function readPresalesProjectFileTargets(
  projectId: string,
  executor?: any,
) {
  const db = executor ?? (await requireDb());
  return db
    .select({
      fileId: presalesUpstreamResources.upstreamId,
      apiCredentialId: presalesUpstreamResources.apiCredentialId,
    })
    .from(presalesUpstreamResources)
    .where(
      and(
        eq(presalesUpstreamResources.projectId, projectId),
        eq(presalesUpstreamResources.kind, "file"),
      ),
    );
}

export async function countPresalesProjectPendingFileUploads(
  projectId: string,
  input: { now?: Date; graceMs: number },
  executor?: any,
) {
  const db = executor ?? (await requireDb());
  const now = input.now ?? new Date();
  const rows = await db
    .select({
      uploadReservedAt: presalesUpstreamResources.uploadReservedAt,
      uploadedAt: presalesUpstreamResources.uploadedAt,
    })
    .from(presalesUpstreamResources)
    .where(
      and(
        eq(presalesUpstreamResources.projectId, projectId),
        eq(presalesUpstreamResources.kind, "file"),
        eq(presalesUpstreamResources.contentSource, "user_upload"),
      ),
    );
  return rows.filter(
    (row: { uploadReservedAt: Date | null; uploadedAt: Date | null }) =>
      row.uploadReservedAt &&
      !row.uploadedAt &&
      row.uploadReservedAt.getTime() + input.graceMs > now.getTime(),
  ).length;
}

export async function deletePresalesFileEvidence(
  input: { fileId: string; apiCredentialId: string },
  executor?: any,
) {
  const db = executor ?? (await requireDb());
  await db
    .delete(presalesUpstreamResources)
    .where(
      and(
        eq(presalesUpstreamResources.kind, "file"),
        eq(presalesUpstreamResources.upstreamId, input.fileId),
        eq(presalesUpstreamResources.apiCredentialId, input.apiCredentialId),
      ),
    );
}

/**
 * Persists a known assistant-output file as a project purge target before an
 * immediate best-effort DELETE. This is used only after the project fence has
 * closed and the parent task can no longer accept ordinary output evidence.
 */
export async function retainPresalesProjectFilePurgeTarget(
  input: {
    projectId: string;
    fileId: string;
    apiCredentialId: string;
  },
  executor?: any,
) {
  const db = executor ?? (await requireDb());
  await db.transaction(async (tx: any) => {
    const lifecycle = await tx
      .select({ status: websiteProjectDeletionTombstones.status })
      .from(websiteProjectDeletionTombstones)
      .where(eq(websiteProjectDeletionTombstones.projectId, input.projectId))
      .limit(1)
      .for("update");
    if (!lifecycle[0] || lifecycle[0].status === "active") {
      throw new AuthServiceError(
        "CONFLICT",
        "Project output cleanup target requires a closed deletion fence",
      );
    }
    const existing = await tx
      .select()
      .from(presalesUpstreamResources)
      .where(
        and(
          eq(presalesUpstreamResources.kind, "file"),
          eq(presalesUpstreamResources.upstreamId, input.fileId),
        ),
      )
      .limit(1)
      .for("update");
    if (existing[0]) {
      if (
        existing[0].apiCredentialId !== input.apiCredentialId ||
        (existing[0].projectId && existing[0].projectId !== input.projectId)
      ) {
        throw new AuthServiceError(
          "CONFLICT",
          "Output cleanup target belongs to another project or credential",
        );
      }
      if (!existing[0].projectId) {
        await tx
          .update(presalesUpstreamResources)
          .set({ projectId: input.projectId })
          .where(eq(presalesUpstreamResources.id, existing[0].id));
      }
      return;
    }
    await tx.insert(presalesUpstreamResources).values({
      id: randomUUID(),
      projectId: input.projectId,
      apiCredentialId: input.apiCredentialId,
      kind: "file",
      upstreamId: input.fileId,
      parentTaskId: null,
      contentSource: "assistant_output",
      uploadReservedAt: null,
      uploadedAt: null,
      contentExpiresAt: null,
      contentDeletedAt: null,
      createdAt: new Date(),
    });
  });
}

/**
 * Physically removes every local ownership/idempotency/evidence mapping for a
 * task after the upstream task has been deleted (or confirmed absent). The
 * credential row is intentionally retained because other resources can share
 * it, and payment/provisioning ledgers live outside the presales tables.
 */
export async function deletePresalesTaskEvidence(
  input: {
    taskId: string;
    apiCredentialId: string;
    deletedFileIds?: readonly string[];
  },
  executor?: any,
): Promise<DeletedPresalesTaskEvidence> {
  const db = executor ?? (await requireDb());
  return db.transaction(async (tx: any) => {
    const taskRows = await tx
      .select({ id: presalesUpstreamResources.id })
      .from(presalesUpstreamResources)
      .where(
        and(
          eq(presalesUpstreamResources.kind, "task"),
          eq(presalesUpstreamResources.upstreamId, input.taskId),
          eq(presalesUpstreamResources.apiCredentialId, input.apiCredentialId),
        ),
      )
      .limit(1)
      .for("update");

    const fileRows = await tx
      .select({ fileId: presalesUpstreamResources.upstreamId })
      .from(presalesUpstreamResources)
      .where(
        and(
          eq(presalesUpstreamResources.kind, "file"),
          eq(presalesUpstreamResources.parentTaskId, input.taskId),
          eq(presalesUpstreamResources.apiCredentialId, input.apiCredentialId),
        ),
      );

    if (input.deletedFileIds) {
      const deletedFileIds = new Set(input.deletedFileIds);
      if (
        fileRows.some(
          (row: { fileId: string }) => !deletedFileIds.has(row.fileId),
        )
      ) {
        throw new AuthServiceError(
          "IDEMPOTENCY_PENDING",
          "任务删除期间发现新的输出文件，请重试项目删除",
          1_000,
        );
      }
    }

    await tx
      .delete(presalesOutputUrls)
      .where(
        and(
          eq(presalesOutputUrls.parentTaskId, input.taskId),
          eq(presalesOutputUrls.apiCredentialId, input.apiCredentialId),
        ),
      );
    await tx
      .delete(presalesTaskRequests)
      .where(
        and(
          eq(presalesTaskRequests.upstreamTaskId, input.taskId),
          eq(presalesTaskRequests.apiCredentialId, input.apiCredentialId),
        ),
      );
    await tx
      .delete(presalesUpstreamResources)
      .where(
        and(
          eq(presalesUpstreamResources.kind, "file"),
          eq(presalesUpstreamResources.parentTaskId, input.taskId),
          eq(presalesUpstreamResources.apiCredentialId, input.apiCredentialId),
        ),
      );
    await tx
      .delete(presalesUpstreamResources)
      .where(
        and(
          eq(presalesUpstreamResources.kind, "task"),
          eq(presalesUpstreamResources.upstreamId, input.taskId),
          eq(presalesUpstreamResources.apiCredentialId, input.apiCredentialId),
        ),
      );

    return {
      deleted: Boolean(taskRows[0]),
      fileIds: fileRows.map((row: { fileId: string }) => row.fileId),
    };
  });
}

export type PresalesProjectTaskPurgeSnapshot = {
  projectId: string;
  pendingReservations: number;
  tasks: Array<{ taskId: string; apiCredentialId: string }>;
};

/** Enumerates every durable project task target after deletion has begun. */
export async function readPresalesProjectTaskPurgeSnapshot(
  projectId: string,
  executor?: any,
  now = new Date(),
): Promise<PresalesProjectTaskPurgeSnapshot> {
  assertWebsiteProjectPhysicalDeleteEnabled();
  const db = executor ?? (await requireDb());
  return db.transaction(async (tx: any) => {
    const tombstones = await tx
      .select({ status: websiteProjectDeletionTombstones.status })
      .from(websiteProjectDeletionTombstones)
      .where(eq(websiteProjectDeletionTombstones.projectId, projectId))
      .limit(1)
      .for("update");
    if (!tombstones[0] || tombstones[0].status === "active") {
      throw new AuthServiceError("CONFLICT", "项目尚未进入永久删除流程");
    }
    const rows = await tx
      .select({
        id: presalesTaskRequests.id,
        status: presalesTaskRequests.status,
        leaseExpiresAt: presalesTaskRequests.leaseExpiresAt,
        upstreamTaskId: presalesTaskRequests.upstreamTaskId,
        apiCredentialId: presalesTaskRequests.apiCredentialId,
      })
      .from(presalesTaskRequests)
      .where(eq(presalesTaskRequests.projectId, projectId))
      .for("update");
    const expiredReservations = rows.filter(
      (row: {
        status: string;
        upstreamTaskId: string | null;
        leaseExpiresAt: Date;
      }) =>
        (row.status !== "completed" || !row.upstreamTaskId) &&
        row.leaseExpiresAt.getTime() <= now.getTime(),
    );
    if (expiredReservations.length > 0) {
      await tx.delete(presalesTaskRequests).where(
        inArray(
          presalesTaskRequests.id,
          expiredReservations.map((row: { id: string }) => row.id),
        ),
      );
    }
    const expiredIds = new Set(
      expiredReservations.map((row: { id: string }) => row.id),
    );
    const tasks = new Map<
      string,
      { taskId: string; apiCredentialId: string }
    >();
    let pendingReservations = 0;
    for (const row of rows) {
      if (expiredIds.has(row.id)) continue;
      const taskId = String(row.upstreamTaskId ?? "");
      if (row.status !== "completed" || !taskId) {
        pendingReservations += 1;
        continue;
      }
      tasks.set(taskId, { taskId, apiCredentialId: row.apiCredentialId });
    }
    return {
      projectId,
      pendingReservations,
      tasks: [...tasks.values()],
    };
  });
}

/** Marks the compact tombstone complete only when no local task can reappear. */
export async function completePresalesProjectTaskPurge(
  projectId: string,
  executor?: any,
) {
  assertWebsiteProjectPhysicalDeleteEnabled();
  const db = executor ?? (await requireDb());
  return db.transaction(async (tx: any) => {
    const tombstones = await tx
      .select({
        projectId: websiteProjectDeletionTombstones.projectId,
        status: websiteProjectDeletionTombstones.status,
      })
      .from(websiteProjectDeletionTombstones)
      .where(eq(websiteProjectDeletionTombstones.projectId, projectId))
      .limit(1)
      .for("update");
    if (!tombstones[0] || tombstones[0].status === "active") {
      throw new AuthServiceError("CONFLICT", "项目尚未进入永久删除流程");
    }
    const remaining = await tx
      .select({
        status: presalesTaskRequests.status,
        upstreamTaskId: presalesTaskRequests.upstreamTaskId,
      })
      .from(presalesTaskRequests)
      .where(eq(presalesTaskRequests.projectId, projectId));
    if (remaining.length > 0) {
      return {
        completed: false as const,
        pendingReservations: remaining.filter(
          (row: { status: string; upstreamTaskId: string | null }) =>
            row.status !== "completed" || !row.upstreamTaskId,
        ).length,
        remainingTasks: remaining.filter(
          (row: { status: string; upstreamTaskId: string | null }) =>
            row.status === "completed" && Boolean(row.upstreamTaskId),
        ).length,
      };
    }
    const remainingResources = await tx
      .select({ id: presalesUpstreamResources.id })
      .from(presalesUpstreamResources)
      .where(eq(presalesUpstreamResources.projectId, projectId));
    if (remainingResources.length > 0) {
      return {
        completed: false as const,
        pendingReservations: 0,
        remainingTasks: remainingResources.length,
      };
    }
    const remainingMonitors = await tx
      .select({ id: presalesMonitorRuns.id })
      .from(presalesMonitorRuns)
      .where(eq(presalesMonitorRuns.projectId, projectId));
    if (remainingMonitors.length > 0) {
      return {
        completed: false as const,
        pendingReservations: remainingMonitors.length,
        remainingTasks: 0,
      };
    }
    if (tombstones[0].status !== "deleted") {
      await tx
        .update(websiteProjectDeletionTombstones)
        .set({
          status: "deleted",
          completedAt: new Date(),
        })
        .where(eq(websiteProjectDeletionTombstones.projectId, projectId));
    }
    return {
      completed: true as const,
      pendingReservations: 0,
      remainingTasks: 0,
    };
  });
}

export async function releasePresalesTaskReservation(
  input: { reservationId: string; attemptId: string },
  executor?: any,
) {
  const db = executor ?? (await requireDb());
  await db.transaction(async (tx: any) => {
    const rows = await tx
      .select()
      .from(presalesTaskRequests)
      .where(eq(presalesTaskRequests.id, input.reservationId))
      .limit(1)
      .for("update");
    const row = rows[0] as PresalesTaskRequest | undefined;
    if (!row || row.status !== "pending" || row.attemptId !== input.attemptId) {
      return;
    }
    await tx
      .delete(presalesTaskRequests)
      .where(eq(presalesTaskRequests.id, row.id));
  });
}

export async function completePresalesTaskReservation(
  input: {
    reservationId: string;
    attemptId: string;
    apiCredentialId: string;
    upstreamTaskId: string;
    attachmentFileIds?: readonly string[];
  },
  executor?: any,
) {
  const db = executor ?? (await requireDb());
  const bindings = await db
    .select({ projectId: presalesTaskRequests.projectId })
    .from(presalesTaskRequests)
    .where(eq(presalesTaskRequests.id, input.reservationId))
    .limit(1);
  if (!bindings[0]) {
    throw new AuthServiceError("NOT_FOUND", "Task reservation not found");
  }
  await db.transaction(async (tx: any) => {
    if (bindings[0].projectId) {
      await assertPresalesProjectActive(tx, bindings[0].projectId);
    }
    const requests = await tx
      .select()
      .from(presalesTaskRequests)
      .where(eq(presalesTaskRequests.id, input.reservationId))
      .limit(1)
      .for("update");
    const request = requests[0] as PresalesTaskRequest | undefined;
    if (!request) {
      throw new AuthServiceError("NOT_FOUND", "Task reservation not found");
    }
    if ((request.projectId ?? null) !== (bindings[0].projectId ?? null)) {
      throw new AuthServiceError(
        "IDEMPOTENCY_PENDING",
        "任务项目归属刚刚更新，请重试完成确认",
        1_000,
      );
    }
    if (request.apiCredentialId !== input.apiCredentialId) {
      throw new AuthServiceError(
        "CONFLICT",
        "Task reservation belongs to a different presales credential version",
      );
    }
    if (
      request.status === "completed" &&
      request.upstreamTaskId !== input.upstreamTaskId
    ) {
      throw new AuthServiceError(
        "CONFLICT",
        "Task reservation already completed",
      );
    }
    if (
      request.status !== "completed" &&
      request.attemptId !== input.attemptId
    ) {
      throw new AuthServiceError(
        "IDEMPOTENCY_PENDING",
        "Task reservation lease is owned by another request",
        1_000,
      );
    }

    const resources = await tx
      .select()
      .from(presalesUpstreamResources)
      .where(
        and(
          eq(presalesUpstreamResources.kind, "task"),
          eq(presalesUpstreamResources.upstreamId, input.upstreamTaskId),
        ),
      )
      .limit(1)
      .for("update");
    const resource = resources[0] as PresalesUpstreamResource | undefined;
    if (resource && resource.apiCredentialId !== input.apiCredentialId) {
      throw new AuthServiceError(
        "CONFLICT",
        "Upstream task belongs to a different presales credential version",
      );
    }
    if (!resource) {
      await tx.insert(presalesUpstreamResources).values({
        id: randomUUID(),
        projectId: request.projectId,
        apiCredentialId: input.apiCredentialId,
        kind: "task",
        upstreamId: input.upstreamTaskId,
        parentTaskId: null,
        createdAt: new Date(),
      });
    } else if (
      resource.projectId &&
      request.projectId &&
      resource.projectId !== request.projectId
    ) {
      throw new AuthServiceError(
        "CONFLICT",
        "Upstream task belongs to a different project",
      );
    } else if (!resource.projectId && request.projectId) {
      await tx
        .update(presalesUpstreamResources)
        .set({ projectId: request.projectId })
        .where(eq(presalesUpstreamResources.id, resource.id));
    }

    for (const fileId of new Set(input.attachmentFileIds ?? [])) {
      const fileRows = await tx
        .select({
          id: presalesUpstreamResources.id,
          projectId: presalesUpstreamResources.projectId,
        })
        .from(presalesUpstreamResources)
        .where(
          and(
            eq(presalesUpstreamResources.kind, "file"),
            eq(presalesUpstreamResources.upstreamId, fileId),
            eq(
              presalesUpstreamResources.apiCredentialId,
              input.apiCredentialId,
            ),
          ),
        )
        .limit(1)
        .for("update");
      const file = fileRows[0];
      if (!file) {
        throw new AuthServiceError(
          "NOT_FOUND",
          "Task attachment is no longer available",
        );
      }
      if (
        file.projectId &&
        request.projectId &&
        file.projectId !== request.projectId
      ) {
        throw new AuthServiceError(
          "CONFLICT",
          "Task attachment belongs to a different project",
        );
      }
      if (!file.projectId && request.projectId) {
        await tx
          .update(presalesUpstreamResources)
          .set({ projectId: request.projectId })
          .where(eq(presalesUpstreamResources.id, file.id));
      }
    }

    if (request.status === "completed") return;

    const completedAt = new Date();
    await tx
      .update(presalesTaskRequests)
      .set({
        status: "completed",
        upstreamTaskId: input.upstreamTaskId,
        completedAt,
        leaseExpiresAt: completedAt,
        updatedAt: completedAt,
      })
      .where(eq(presalesTaskRequests.id, request.id));
  });
}

/**
 * Keeps a known upstream task discoverable when task creation won a race with
 * project deletion but immediate upstream compensation failed. Unlike normal
 * completion this does not bind attachment rows or create output evidence; the
 * project purge enumerates the completed request and retries DELETE by ID.
 */
export async function retainPresalesTaskPurgeTarget(
  input: {
    reservationId: string;
    attemptId: string;
    apiCredentialId: string;
    upstreamTaskId: string;
  },
  executor?: any,
) {
  const db = executor ?? (await requireDb());
  const bindings = await db
    .select({ projectId: presalesTaskRequests.projectId })
    .from(presalesTaskRequests)
    .where(eq(presalesTaskRequests.id, input.reservationId))
    .limit(1);
  if (!bindings[0]) {
    throw new AuthServiceError("NOT_FOUND", "Task reservation not found");
  }
  if (!bindings[0].projectId) {
    throw new AuthServiceError(
      "CONFLICT",
      "Task cleanup target requires a project deletion fence",
    );
  }
  await db.transaction(async (tx: any) => {
    const lifecycle = await tx
      .select({ status: websiteProjectDeletionTombstones.status })
      .from(websiteProjectDeletionTombstones)
      .where(
        eq(websiteProjectDeletionTombstones.projectId, bindings[0].projectId),
      )
      .limit(1)
      .for("update");
    if (!lifecycle[0] || lifecycle[0].status === "active") {
      throw new AuthServiceError(
        "CONFLICT",
        "Task cleanup target requires a closed deletion fence",
      );
    }
    const rows = await tx
      .select()
      .from(presalesTaskRequests)
      .where(eq(presalesTaskRequests.id, input.reservationId))
      .limit(1)
      .for("update");
    const request = rows[0] as PresalesTaskRequest | undefined;
    if (!request) {
      throw new AuthServiceError("NOT_FOUND", "Task reservation not found");
    }
    if (request.projectId !== bindings[0].projectId) {
      throw new AuthServiceError(
        "IDEMPOTENCY_PENDING",
        "任务项目归属刚刚更新，请重试清理登记",
        1_000,
      );
    }
    if (
      request.apiCredentialId !== input.apiCredentialId ||
      (request.status !== "completed" && request.attemptId !== input.attemptId)
    ) {
      throw new AuthServiceError(
        "CONFLICT",
        "Task reservation belongs to another task creation attempt",
      );
    }
    if (
      request.upstreamTaskId &&
      request.upstreamTaskId !== input.upstreamTaskId
    ) {
      throw new AuthServiceError(
        "CONFLICT",
        "Task reservation already tracks another upstream task",
      );
    }
    const completedAt = new Date();
    await tx
      .update(presalesTaskRequests)
      .set({
        status: "completed",
        upstreamTaskId: input.upstreamTaskId,
        completedAt,
        leaseExpiresAt: completedAt,
        updatedAt: completedAt,
      })
      .where(eq(presalesTaskRequests.id, request.id));
  });
}

type PresalesUpstreamResourceInput = {
  projectId?: string | null;
  apiCredentialId: string;
  kind: "task" | "file";
  upstreamId: string;
  parentTaskId?: string | null;
  contentSource?: PresalesFileContentSource | null;
  verifiedAssistantOutput?: boolean;
};

async function recordPresalesUpstreamResourceUnlocked(
  input: PresalesUpstreamResourceInput,
  db: any,
) {
  const contentSource = validatePresalesResourceContentSource(
    input.kind,
    input.contentSource,
  );
  const existing = await db
    .select()
    .from(presalesUpstreamResources)
    .where(
      and(
        eq(presalesUpstreamResources.kind, input.kind),
        eq(presalesUpstreamResources.upstreamId, input.upstreamId),
      ),
    )
    .limit(1);
  if (existing[0]) {
    if (
      input.projectId &&
      existing[0].projectId &&
      existing[0].projectId !== input.projectId
    ) {
      throw new AuthServiceError(
        "CONFLICT",
        "Upstream resource belongs to a different project",
      );
    }
    if (existing[0].apiCredentialId !== input.apiCredentialId) {
      throw new AuthServiceError(
        "CONFLICT",
        "Upstream resource belongs to a different presales credential version",
      );
    }
    if (
      input.parentTaskId &&
      existing[0].parentTaskId &&
      existing[0].parentTaskId !== input.parentTaskId
    ) {
      throw new AuthServiceError(
        "CONFLICT",
        "Upstream file is already bound to a different presales task",
      );
    }
    if (
      contentSource &&
      existing[0].contentSource &&
      existing[0].contentSource !== contentSource &&
      !(
        existing[0].contentSource === "user_upload" &&
        contentSource === "assistant_output"
      )
    ) {
      throw new AuthServiceError(
        "CONFLICT",
        "Upstream file already has a different content source",
      );
    }
    const updates: Partial<PresalesUpstreamResource> = {};
    const mayUpgradeHistoricalAssistantOutput =
      input.verifiedAssistantOutput === true &&
      input.kind === "file" &&
      contentSource === "assistant_output" &&
      Boolean(input.parentTaskId) &&
      existing[0].parentTaskId === input.parentTaskId &&
      existing[0].contentSource === null &&
      existing[0].uploadReservedAt === null &&
      existing[0].uploadedAt === null &&
      existing[0].contentExpiresAt === null &&
      existing[0].contentDeletedAt === null;
    const ambiguousHistoricalFile =
      input.verifiedAssistantOutput === true &&
      input.kind === "file" &&
      contentSource === "assistant_output" &&
      existing[0].contentSource === null &&
      existing[0].parentTaskId === null;
    if (!existing[0].projectId && input.projectId) {
      updates.projectId = input.projectId;
    }
    if (
      !existing[0].parentTaskId &&
      input.parentTaskId &&
      !ambiguousHistoricalFile
    ) {
      updates.parentTaskId = input.parentTaskId;
    }
    // Pre-provenance output rows were already bound to the exact task that
    // exposed them. Re-observing that same typed output under the same API-key
    // version can safely classify those rows without a bulk data migration.
    // Unbound historical files remain unknown so echoed user uploads stay
    // fail-closed across repeated retrievals.
    if (mayUpgradeHistoricalAssistantOutput) {
      updates.contentSource = "assistant_output";
    }
    if (Object.keys(updates).length > 0) {
      await db
        .update(presalesUpstreamResources)
        .set(updates)
        .where(eq(presalesUpstreamResources.id, existing[0].id));
      return { ...existing[0], ...updates };
    }
    return existing[0];
  }

  const credential = await db
    .select({ id: presalesApiCredentials.id })
    .from(presalesApiCredentials)
    .where(
      and(
        eq(presalesApiCredentials.id, input.apiCredentialId),
        ne(presalesApiCredentials.status, "deleted"),
      ),
    )
    .limit(1);
  if (!credential[0]) {
    throw new AuthServiceError(
      "NOT_FOUND",
      "Presales API credential not found",
    );
  }

  const resource: PresalesUpstreamResource = {
    id: randomUUID(),
    projectId: input.projectId ?? null,
    apiCredentialId: input.apiCredentialId,
    kind: input.kind,
    upstreamId: input.upstreamId,
    parentTaskId: input.parentTaskId ?? null,
    contentSource,
    uploadReservedAt: null,
    uploadedAt: null,
    contentExpiresAt: null,
    contentDeletedAt: null,
    createdAt: new Date(),
  };
  try {
    await db.insert(presalesUpstreamResources).values(resource);
    return resource;
  } catch (error) {
    if (!isPresalesDuplicateEntryError(error)) throw error;
    const raced = await db
      .select()
      .from(presalesUpstreamResources)
      .where(
        and(
          eq(presalesUpstreamResources.kind, input.kind),
          eq(presalesUpstreamResources.upstreamId, input.upstreamId),
          eq(presalesUpstreamResources.apiCredentialId, input.apiCredentialId),
        ),
      )
      .limit(1);
    if (raced[0]) return recordPresalesUpstreamResourceUnlocked(input, db);
    throw new AuthServiceError("CONFLICT", "Upstream resource already exists");
  }
}

export async function recordPresalesUpstreamResource(
  input: PresalesUpstreamResourceInput,
  executor?: any,
) {
  const db = executor ?? (await requireDb());
  if (!input.parentTaskId && !input.projectId) {
    return recordPresalesUpstreamResourceUnlocked(input, db);
  }
  let guardedProjectId = input.projectId ?? null;
  if (input.parentTaskId && !guardedProjectId) {
    const parentBinding = await db
      .select({ projectId: presalesUpstreamResources.projectId })
      .from(presalesUpstreamResources)
      .where(
        and(
          eq(presalesUpstreamResources.kind, "task"),
          eq(presalesUpstreamResources.upstreamId, input.parentTaskId),
          eq(presalesUpstreamResources.apiCredentialId, input.apiCredentialId),
        ),
      )
      .limit(1);
    guardedProjectId = parentBinding[0]?.projectId ?? null;
  }
  return db.transaction(async (tx: any) => {
    if (guardedProjectId) {
      await assertPresalesProjectActive(tx, guardedProjectId);
    }
    if (!input.parentTaskId) {
      return recordPresalesUpstreamResourceUnlocked(input, tx);
    }
    const parent = await tx
      .select({
        id: presalesUpstreamResources.id,
        projectId: presalesUpstreamResources.projectId,
      })
      .from(presalesUpstreamResources)
      .where(
        and(
          eq(presalesUpstreamResources.kind, "task"),
          eq(presalesUpstreamResources.upstreamId, input.parentTaskId!),
          eq(presalesUpstreamResources.apiCredentialId, input.apiCredentialId),
        ),
      )
      .limit(1)
      .for("update");
    if (!parent[0]) {
      throw new AuthServiceError(
        "PROJECT_DELETED",
        "任务已进入永久删除流程，不能再登记输出文件",
      );
    }
    if (
      input.projectId &&
      parent[0].projectId &&
      input.projectId !== parent[0].projectId
    ) {
      throw new AuthServiceError(
        "CONFLICT",
        "Output file belongs to a different project",
      );
    }
    const currentProjectId = input.projectId ?? parent[0].projectId;
    if (currentProjectId && currentProjectId !== guardedProjectId) {
      throw new AuthServiceError(
        "IDEMPOTENCY_PENDING",
        "任务项目归属刚刚更新，请重试输出登记",
        1_000,
      );
    }
    return recordPresalesUpstreamResourceUnlocked(
      { ...input, projectId: currentProjectId },
      tx,
    );
  });
}

export function hashPresalesOutputUrl(url: string) {
  return createHash("sha256").update(url, "utf8").digest("hex");
}

export async function syncPresalesOutputUrlGrants(
  input: {
    apiCredentialId: string;
    parentTaskId: string;
    urls: Array<{ url: string; hostname: string }>;
  },
  executor?: any,
) {
  const db = executor ?? (await requireDb());
  const uniqueUrls = [
    ...new Map(input.urls.map((item) => [item.url, item])).values(),
  ];
  const taskBinding = await db
    .select({ projectId: presalesUpstreamResources.projectId })
    .from(presalesUpstreamResources)
    .where(
      and(
        eq(presalesUpstreamResources.kind, "task"),
        eq(presalesUpstreamResources.upstreamId, input.parentTaskId),
        eq(presalesUpstreamResources.apiCredentialId, input.apiCredentialId),
      ),
    )
    .limit(1);
  const guardedProjectId = taskBinding[0]?.projectId ?? null;
  await db.transaction(async (tx: any) => {
    if (guardedProjectId) {
      await assertPresalesProjectActive(tx, guardedProjectId);
    }
    const task = await tx
      .select({
        id: presalesUpstreamResources.id,
        projectId: presalesUpstreamResources.projectId,
      })
      .from(presalesUpstreamResources)
      .where(
        and(
          eq(presalesUpstreamResources.kind, "task"),
          eq(presalesUpstreamResources.upstreamId, input.parentTaskId),
          eq(presalesUpstreamResources.apiCredentialId, input.apiCredentialId),
        ),
      )
      .limit(1)
      .for("update");
    if (!task[0]) {
      throw new AuthServiceError(
        "PROJECT_DELETED",
        "任务已进入永久删除流程，不能再登记输出地址",
      );
    }
    if (task[0].projectId && task[0].projectId !== guardedProjectId) {
      throw new AuthServiceError(
        "IDEMPOTENCY_PENDING",
        "任务项目归属刚刚更新，请重试输出地址登记",
        1_000,
      );
    }

    await tx
      .delete(presalesOutputUrls)
      .where(
        and(
          eq(presalesOutputUrls.apiCredentialId, input.apiCredentialId),
          eq(presalesOutputUrls.parentTaskId, input.parentTaskId),
        ),
      );
    if (uniqueUrls.length > 0) {
      await tx.insert(presalesOutputUrls).values(
        uniqueUrls.map((item) => ({
          id: randomUUID(),
          apiCredentialId: input.apiCredentialId,
          parentTaskId: input.parentTaskId,
          urlHash: hashPresalesOutputUrl(item.url),
          hostname: item.hostname.slice(0, 255),
          createdAt: new Date(),
        })),
      );
    }
  });
}

export async function hasPresalesOutputUrlGrant(input: {
  apiCredentialId: string;
  parentTaskId: string;
  url: string;
}) {
  const db = await requireDb();
  const rows = await db
    .select({ id: presalesOutputUrls.id })
    .from(presalesOutputUrls)
    .where(
      and(
        eq(presalesOutputUrls.apiCredentialId, input.apiCredentialId),
        eq(presalesOutputUrls.parentTaskId, input.parentTaskId),
        eq(presalesOutputUrls.urlHash, hashPresalesOutputUrl(input.url)),
      ),
    )
    .limit(1);
  return Boolean(rows[0]);
}

function parseCreatedAt(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value > 1_000_000_000_000 ? value : value * 1000;
  }
  if (typeof value !== "string" || !value.trim()) return null;
  const numeric = Number(value);
  if (Number.isFinite(numeric)) {
    return numeric > 1_000_000_000_000 ? numeric : numeric * 1000;
  }
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function taskCreditUsage(task: any) {
  const value = Number(task?.credit_usage ?? task?.metadata?.credit_usage ?? 0);
  return Number.isFinite(value) && value >= 0 ? value : null;
}

export function aggregatePresalesCreditUsagePage(input: {
  tasks: any[];
  websiteTaskIds: ReadonlySet<string>;
  cutoffMs: number;
  endExclusive: number;
  seenTaskIds: Set<string>;
}) {
  let keyTotalUsed = 0;
  let websiteUsed = 0;
  let reachedCutoff = false;
  let complete = true;
  let datedTaskCount = 0;
  let expiredTaskCount = 0;
  const recentWebsiteTasks: PresalesCreditUsageTask[] = [];
  for (const task of input.tasks) {
    const id = String(task?.id ?? task?.task_id ?? "");
    if (!id) {
      complete = false;
      continue;
    }
    if (input.seenTaskIds.has(id)) continue;
    input.seenTaskIds.add(id);
    const createdAt = parseCreatedAt(task?.created_at);
    if (createdAt === null) {
      complete = false;
      continue;
    }
    datedTaskCount += 1;
    if (createdAt < input.cutoffMs) {
      expiredTaskCount += 1;
      continue;
    }
    if (createdAt >= input.endExclusive) continue;
    const creditUsage = taskCreditUsage(task);
    if (creditUsage === null) {
      complete = false;
      continue;
    }
    if (creditUsage === 0) continue;
    keyTotalUsed += creditUsage;
    if (!input.websiteTaskIds.has(id)) continue;
    websiteUsed += creditUsage;
    recentWebsiteTasks.push({
      id,
      title: String(
        task?.metadata?.task_title ??
          task?.task_title ??
          task?.instructions?.slice?.(0, 40) ??
          id.slice(0, 12),
      ),
      creditUsage,
      createdAt,
      businessOwnerName: null,
    });
  }
  reachedCutoff = usagePageReachedCutoff({
    complete,
    datedTaskCount,
    expiredTaskCount,
  });
  return {
    keyTotalUsed,
    websiteUsed,
    recentWebsiteTasks,
    reachedCutoff,
    complete,
  };
}

export async function getPresalesCreditUsage(
  windowDays = CREDIT_USAGE_LOOKBACK_DAYS,
  now = Date.now(),
): Promise<WebsiteApiKeyUsage> {
  const normalizedWindowDays =
    Number.isInteger(windowDays) && windowDays > 0 && windowDays <= 365
      ? windowDays
      : CREDIT_USAGE_LOOKBACK_DAYS;
  const db = await requireDb();
  const credentialRows = await db
    .select()
    .from(presalesApiCredentials)
    .where(
      and(
        eq(presalesApiCredentials.slot, PRESALES_CREDENTIAL_SLOT),
        inArray(presalesApiCredentials.status, ["active", "retired"]),
      ),
    )
    .orderBy(desc(presalesApiCredentials.version));
  if (credentialRows.length === 0) {
    return {
      windowDays: normalizedWindowDays,
      keyTotalUsed: 0,
      websiteUsed: 0,
      recentWebsiteTasks: [] as PresalesCreditUsageTask[],
      fetchedAt: now,
      complete: true,
      attributionComplete: true,
    };
  }

  const credentialIds = credentialRows.map((credential) => credential.id);
  const credentialByFingerprint = new Map<
    string,
    ReturnType<typeof toDecryptedCredential>
  >();
  for (const credentialRow of selectPhysicalCredentialRows(credentialRows)) {
    if (!credentialByFingerprint.has(credentialRow.fingerprint)) {
      credentialByFingerprint.set(
        credentialRow.fingerprint,
        toDecryptedCredential(credentialRow),
      );
    }
  }
  const credentials = [...credentialByFingerprint.values()];
  const currentCredential =
    credentials.find((credential) => credential.status === "active") ??
    credentials[0]!;
  const coverageByFingerprint = await loadUsageCoverage({
    executor: db,
    scope: "website_frontend",
    fingerprints: credentials.map((credential) => credential.fingerprint),
  });
  const usageNow = now;
  const cutoffMs = usageNow - normalizedWindowDays * 24 * 60 * 60 * 1000;
  const authoritativePoolUsage = await getManusRollingCreditUsage({
    apiKey: currentCredential.apiKey,
    startAt: cutoffMs,
    endAt: usageNow,
  });
  const terminalProofsByFingerprint = await loadTerminalUsageTaskProofs({
    executor: db,
    scope: "website_frontend",
    fingerprints: credentials.map((credential) => credential.fingerprint),
    startAt: cutoffMs,
    endAt: usageNow,
  });
  const [resourceRows, ownedRows, monitorRows, agentTaskRows] =
    await Promise.all([
      db
        .select({
          upstreamTaskId: presalesUpstreamResources.upstreamId,
          apiCredentialId: presalesUpstreamResources.apiCredentialId,
          createdAt: presalesUpstreamResources.createdAt,
        })
        .from(presalesUpstreamResources)
        .where(
          and(
            inArray(presalesUpstreamResources.apiCredentialId, credentialIds),
            eq(presalesUpstreamResources.kind, "task"),
            gte(presalesUpstreamResources.createdAt, new Date(cutoffMs)),
          ),
        ),
      db
        .select({
          upstreamTaskId: presalesTaskRequests.upstreamTaskId,
          apiCredentialId: presalesTaskRequests.apiCredentialId,
          createdAt: presalesTaskRequests.createdAt,
          status: presalesTaskRequests.status,
        })
        .from(presalesTaskRequests)
        .where(
          and(
            inArray(presalesTaskRequests.apiCredentialId, credentialIds),
            gte(presalesTaskRequests.createdAt, new Date(cutoffMs)),
          ),
        ),
      db
        .select({
          upstreamTaskId: presalesMonitorRuns.upstreamTaskId,
          apiCredentialId: presalesMonitorRuns.apiCredentialId,
          createdAt: presalesMonitorRuns.createdAt,
          status: presalesMonitorRuns.status,
        })
        .from(presalesMonitorRuns)
        .where(
          and(
            inArray(presalesMonitorRuns.apiCredentialId, credentialIds),
            gte(presalesMonitorRuns.createdAt, new Date(cutoffMs)),
          ),
        ),
      db
        .select({
          upstreamTaskId: agentTasks.providerTaskId,
          apiCredentialId: agentOperations.apiCredentialId,
          createdAt: agentOperations.createdAt,
          status: agentOperations.status,
        })
        .from(agentTasks)
        .innerJoin(
          agentOperations,
          eq(agentTasks.operationId, agentOperations.id),
        )
        .where(
          and(
            eq(agentOperations.scope, "website_frontend"),
            inArray(agentOperations.apiCredentialId, credentialIds),
            gte(agentOperations.createdAt, new Date(cutoffMs)),
          ),
        ),
    ]);
  const { firstPartyRows, websiteTaskIds, unsettledCredentialIds } =
    projectWebsiteUsageOwnership({
      resourceRows,
      ownedRows,
      monitorRows,
      agentTaskRows,
    });
  const fingerprintByCredentialId = new Map(
    credentialRows.map((credential) => [credential.id, credential.fingerprint]),
  );
  const expectedTaskIdsByFingerprint = new Map<string, Set<string>>();
  for (const row of firstPartyRows) {
    const taskId = row.upstreamTaskId?.trim();
    if (!taskId || row.createdAt.getTime() < cutoffMs) continue;
    const fingerprint = fingerprintByCredentialId.get(row.apiCredentialId);
    if (!fingerprint) continue;
    const expected = expectedTaskIdsByFingerprint.get(fingerprint) ?? new Set();
    expected.add(taskId);
    expectedTaskIdsByFingerprint.set(fingerprint, expected);
  }
  const unsettledFingerprints = new Set<string>();
  for (const credentialId of unsettledCredentialIds) {
    const fingerprint = fingerprintByCredentialId.get(credentialId);
    if (fingerprint) unsettledFingerprints.add(fingerprint);
  }
  const recentWebsiteTasks: PresalesCreditUsageTask[] = [];
  const seen = new Set<string>();
  let websiteUsed = 0;
  let attributionComplete = true;
  for (const credential of credentials) {
    if (
      credential.status === "retired" &&
      credential.retiredAt &&
      credential.retiredAt.getTime() <= cutoffMs &&
      !unsettledFingerprints.has(credential.fingerprint) &&
      !expectedTaskIdsByFingerprint.get(credential.fingerprint)?.size
    ) {
      continue;
    }
    const existingCoverage = coverageByFingerprint.get(credential.fingerprint);
    if (
      credential.status === "retired" &&
      !unsettledFingerprints.has(credential.fingerprint) &&
      usageCoverageSupportsRetiredCredential({
        coverage: existingCoverage,
        periodStartMs: cutoffMs,
        credentialRetiredAtMs: credential.retiredAt?.getTime() ?? null,
      })
    ) {
      continue;
    }
    const scanToken = await claimUsageCredentialCoverage({
      executor: db,
      scope: "website_frontend",
      credentialFingerprint: credential.fingerprint,
      coveredFromMs: cutoffMs,
      scanStartedAtMs: usageNow,
      credentialRetiredAtMs: credential.retiredAt?.getTime() ?? null,
    });
    let after: string | undefined;
    let credentialComplete = true;
    let allFirstPartyTasksSettled = !unsettledFingerprints.has(
      credential.fingerprint,
    );
    const seenForCredential = new Set<string>();
    const seenCursors = new Set<string>();
    const usageClient = new ManusV2Client({
      baseUrl: getUpstreamBaseUrl(),
      apiKey: credential.apiKey,
      rateLimitScope: "website-managed-provider",
    });
    for (let page = 0; page < CREDIT_USAGE_MAX_PAGES; page += 1) {
      let payload: Awaited<ReturnType<ManusV2Client["listTasksPage"]>>;
      try {
        payload = await usageClient.listTasksPage({
          limit: CREDIT_USAGE_PAGE_LIMIT,
          order: "desc",
          cursor: after,
        });
      } catch {
        if (credential.status === "retired") {
          credentialComplete = usageCoverageSupportsRetiredCredential({
            coverage: coverageByFingerprint.get(credential.fingerprint),
            periodStartMs: cutoffMs,
            credentialRetiredAtMs: credential.retiredAt?.getTime() ?? null,
          });
          break;
        }
        credentialComplete = false;
        break;
      }
      const tasks = payload.data;
      if (tasks.length === 0) {
        if (payload.has_more) credentialComplete = false;
        break;
      }
      for (const task of tasks) {
        const taskId = String(task?.id ?? task?.task_id ?? "");
        if (taskId) seenForCredential.add(taskId);
      }

      const pageUsage = aggregatePresalesCreditUsagePage({
        tasks,
        websiteTaskIds,
        cutoffMs,
        endExclusive: usageNow,
        seenTaskIds: seen,
      });
      websiteUsed += pageUsage.websiteUsed;
      recentWebsiteTasks.push(...pageUsage.recentWebsiteTasks);
      if (!pageUsage.complete) attributionComplete = false;
      for (const task of tasks) {
        const taskId = String(task?.id ?? task?.task_id ?? "");
        if (
          taskId &&
          websiteTaskIds.has(taskId) &&
          !isUsageTaskTerminal(task)
        ) {
          allFirstPartyTasksSettled = false;
        }
      }
      const ledgerWrite = await recordUsageLedgerEntries({
        executor: db,
        scope: "website_frontend",
        credentialFingerprint: credential.fingerprint,
        apiCredentialId: credential.id,
        observedAt: new Date(usageNow),
        entries: tasks.flatMap((task: any) => {
          const taskId = String(task?.id ?? task?.task_id ?? "");
          const createdAt = parseCreatedAt(task?.created_at);
          const creditUsage = taskCreditUsage(task);
          return taskId && createdAt !== null && creditUsage !== null
            ? [
                {
                  upstreamTaskId: taskId,
                  accountUserId: null,
                  isFirstParty: websiteTaskIds.has(taskId),
                  taskCreatedAtMs: createdAt,
                  creditUsage,
                  isTerminal: isUsageTaskTerminal(task),
                },
              ]
            : [];
        }),
      });
      if (!ledgerWrite.complete) credentialComplete = false;
      if (!pageUsage.complete) credentialComplete = false;
      if (pageUsage.reachedCutoff) break;

      after =
        payload.next_cursor ??
        (String(tasks[tasks.length - 1]?.id ?? "") || undefined);
      if (payload.has_more && !after) {
        credentialComplete = false;
        break;
      }
      if (after && seenCursors.has(after)) {
        credentialComplete = false;
        break;
      }
      if (after) seenCursors.add(after);
      if (page === CREDIT_USAGE_MAX_PAGES - 1 && payload.has_more && after) {
        credentialComplete = false;
      }
      if (!payload.has_more || !after) break;
    }
    const expectedTaskIds =
      expectedTaskIdsByFingerprint.get(credential.fingerprint) ?? new Set();
    if (
      !hasCompleteExpectedTaskSet(
        expectedTaskIds,
        seenForCredential,
        terminalProofsByFingerprint.get(credential.fingerprint),
      )
    ) {
      credentialComplete = false;
    }
    if (credentialComplete) {
      const finalized = await markUsageCredentialCoverage({
        executor: db,
        scope: "website_frontend",
        credentialFingerprint: credential.fingerprint,
        coveredFromMs: cutoffMs,
        fullScanAtMs: usageNow,
        credentialRetiredAtMs: credential.retiredAt?.getTime() ?? null,
        allTasksSettled: allFirstPartyTasksSettled,
        scanToken,
      });
      if (!finalized) credentialComplete = false;
    }
    if (!credentialComplete) {
      attributionComplete = false;
    }
  }

  const currentFingerprint =
    credentialRows.find((credential) => credential.status === "active")
      ?.fingerprint ?? credentials[0]!.fingerprint;
  const ledgerUsage = await readWebsiteUsageLedger({
    executor: db,
    currentFingerprint,
    startAt: cutoffMs,
    endAt: usageNow,
  });

  return {
    windowDays: normalizedWindowDays,
    keyTotalUsed: authoritativePoolUsage.totalUsed,
    websiteUsed: ledgerUsage.websiteUsed,
    recentWebsiteTasks,
    fetchedAt: usageNow,
    complete: authoritativePoolUsage.complete,
    attributionComplete,
  };
}
