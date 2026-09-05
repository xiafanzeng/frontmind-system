import { randomUUID } from "node:crypto";

import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";
import mysql from "mysql2/promise";

import {
  apiCredentials,
  apiUsageCredentialCoverage,
  apiUsagePolicies,
  apiUsageSnapshots,
  deliveryTicketEvents,
  deliveryTickets,
  presalesApiCredentials,
  userAdminAssignments,
  userUsageOwners,
  users,
} from "../drizzle/schema";
import { runtimeErrorForLog } from "./_core/runtime-error-log";
import {
  managedAgentProfileModel,
  normalizeManagedAgentProfile,
  type ManagedAgentProfile,
} from "../shared/manus-agent-profile";
import { readRollingManagedUsageByAccounts } from "./api-usage-ledger";
import {
  acquireActiveApiCredentialDeletionFence,
  AuthServiceError,
  completeActiveApiCredentialDeletionFence,
  deleteActiveApiCredentialInTransaction,
  getApiKeyFingerprint,
  replaceApiCredentialInTransaction,
  rollbackActiveApiCredentialDeletionFence,
  startActiveApiCredentialDeletionFenceHeartbeat,
  validateUpstreamApiKey,
  type AuthenticatedUser,
} from "./auth-service";
import { writeWorkspaceAuditEvent } from "./admin-control-plane-service";
import {
  getShanghaiRollingUsagePeriod,
  getSharedKeyMonthlyCreditUsageForAccounts,
  isSystemAdmin,
} from "./dashboard-service";
import { getDb } from "./db";
import {
  getPresalesCreditUsage,
  getPresalesCreditUsageSnapshot,
} from "./presales-service";
import {
  ManusUsageSyncError,
  type ApiUsageSyncIssueCode,
} from "./manus-usage-service";

export const DEFAULT_API_USAGE_LIMIT = 230_000;
export const DEFAULT_API_USAGE_WARNING_RATIO = 0.8;
export const DEFAULT_API_USAGE_WINDOW_DAYS = 30;
export const API_USAGE_SNAPSHOT_FRESHNESS_MS = 26 * 60 * 60 * 1_000;
// A current-Key group may also scan credentials from an account's history.
// Serialize groups until that historical work is deduplicated by physical
// fingerprint; concurrent groups can otherwise invalidate each other's
// coverage claim and turn a complete total into PARTIAL_TASK_SCAN.
export const API_USAGE_SCAN_CONCURRENCY = 1;
export const API_USAGE_SNAPSHOT_SYNC_LOCK_NAME =
  "frontmind-dashboard:api-usage-snapshot-sync";

export function apiUsageSyncErrorCode(error: unknown): ApiUsageSyncIssueCode {
  if (error instanceof ManusUsageSyncError) return error.code;
  if (error instanceof AuthServiceError) {
    if (error.code === "INVALID_CREDENTIAL") return "CREDENTIAL_REJECTED";
    if (error.code === "RATE_LIMITED") return "RATE_LIMITED";
  }
  if (
    error instanceof Error &&
    (error.name === "AbortError" || error.name === "TimeoutError")
  ) {
    return "TIMEOUT";
  }
  return "UPSTREAM_UNAVAILABLE";
}

const API_USAGE_SYNC_ISSUE_CODES = new Set<ApiUsageSyncIssueCode>([
  "CREDENTIAL_REJECTED",
  "RATE_LIMITED",
  "TIMEOUT",
  "UPSTREAM_UNAVAILABLE",
  "RESPONSE_INVALID",
  "PAGINATION_INVALID",
  "PAGE_DRIFT",
  "PARTIAL_USAGE_SCAN",
]);

export function storedApiUsageSyncIssueCode(
  value: unknown,
): ApiUsageSyncIssueCode | null {
  if (value === "INVALID_CREDENTIAL" || value === "invalid_or_revoked") {
    return "CREDENTIAL_REJECTED";
  }
  const candidate = String(value ?? "") as ApiUsageSyncIssueCode;
  return API_USAGE_SYNC_ISSUE_CODES.has(candidate) ? candidate : null;
}

/**
 * Drizzle wraps mysql2 failures in DrizzleQueryError and preserves the native
 * error under `cause`. Duplicate-key handling must therefore inspect the
 * bounded cause chain instead of assuming `code` exists on the outer error.
 */
export function isDuplicateApiUsageSnapshotError(error: unknown) {
  const visited = new Set<unknown>();
  let current = error;
  for (let depth = 0; depth < 6; depth += 1) {
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

type ApiUsageSnapshotSyncResult = {
  synced: number;
  failed: number;
  retryableFailed?: number;
  finishedAt: number;
  skipped?: "already_running";
};

type ApiUsageSnapshotSyncOptions = {
  includeWebsite?: boolean;
  managedFingerprints?: ReadonlySet<string>;
};

type ApiUsageSnapshotLockConnection = {
  query: (sql: string, values?: unknown[]) => Promise<[any, unknown]>;
  end: () => Promise<void>;
};

let apiUsageSnapshotSyncRunning = false;

export async function runApiUsageSnapshotSyncWithLock(input: {
  databaseUrl?: string;
  createConnection?: (url: string) => Promise<ApiUsageSnapshotLockConnection>;
  sync: () => Promise<ApiUsageSnapshotSyncResult>;
}): Promise<ApiUsageSnapshotSyncResult> {
  if (apiUsageSnapshotSyncRunning) {
    return {
      synced: 0,
      failed: 0,
      finishedAt: Date.now(),
      skipped: "already_running",
    };
  }
  apiUsageSnapshotSyncRunning = true;
  const databaseUrl =
    input.databaseUrl ?? process.env.DATABASE_URL?.trim() ?? "";
  let connection: ApiUsageSnapshotLockConnection | null = null;
  let acquired = false;
  try {
    if (!databaseUrl) return await input.sync();
    const createConnection =
      input.createConnection ??
      ((url: string) =>
        mysql.createConnection(url) as Promise<ApiUsageSnapshotLockConnection>);
    connection = await createConnection(databaseUrl);
    const [rows] = await connection.query("SELECT GET_LOCK(?, 0) AS acquired", [
      API_USAGE_SNAPSHOT_SYNC_LOCK_NAME,
    ]);
    acquired = Number(rows?.[0]?.acquired ?? 0) === 1;
    if (!acquired) {
      return {
        synced: 0,
        failed: 0,
        finishedAt: Date.now(),
        skipped: "already_running",
      };
    }
    return await input.sync();
  } finally {
    try {
      if (connection) {
        if (acquired) {
          await connection
            .query("SELECT RELEASE_LOCK(?) AS released", [
              API_USAGE_SNAPSHOT_SYNC_LOCK_NAME,
            ])
            .catch(() => undefined);
        }
        await connection.end();
      }
    } finally {
      apiUsageSnapshotSyncRunning = false;
    }
  }
}

type ApiUsageScope = "website_frontend" | "managed_user";
type ApiUsageSeverity = "normal" | "warning" | "critical" | "unavailable";
export type ManagedApiKeyTargetKind =
  | "customer"
  | "delivery_admin"
  | "engineer";

export type BulkManagedApiKeyScope =
  | { kind: "all" }
  | { kind: "delivery_admin"; deliveryAdminId: number }
  | { kind: "engineers"; engineerIds: number[] };

export type BulkManagedApiKeyRequestedTarget = {
  userId: number;
  expectedVersion: number;
};

export type BulkManagedApiKeyApplyMode = "unconfigured_only" | "replace_all";

type BulkManagedApiKeyAccount = {
  id: number;
  role: string;
  adminAccessLevel?: string | null;
  isActive?: boolean | null;
};

function managedApiKeyTargetKind(
  account: BulkManagedApiKeyAccount,
): ManagedApiKeyTargetKind | null {
  if (account.role === "user") return "customer";
  if (account.role === "delivery_member") return "engineer";
  if (
    account.role === "admin" &&
    account.adminAccessLevel === "delivery_admin"
  ) {
    return "delivery_admin";
  }
  return null;
}

export function resolveBulkManagedApiKeyTargets(input: {
  scope: BulkManagedApiKeyScope;
  accounts: BulkManagedApiKeyAccount[];
  ownerships: Array<{ userId: number; deliveryAdminId: number }>;
}) {
  const candidates = input.accounts
    .filter((account) => account.isActive !== false)
    .map((account) => ({
      userId: Number(account.id),
      kind: managedApiKeyTargetKind(account),
    }))
    .filter(
      (target): target is { userId: number; kind: ManagedApiKeyTargetKind } =>
        Number.isInteger(target.userId) && target.userId > 0 && !!target.kind,
    );
  const candidateById = new Map(
    candidates.map((target) => [target.userId, target]),
  );

  if (input.scope.kind === "all") {
    return candidates.sort((left, right) => left.userId - right.userId);
  }
  if (input.scope.kind === "delivery_admin") {
    const deliveryAdminId = input.scope.deliveryAdminId;
    const manager = candidateById.get(deliveryAdminId);
    if (manager?.kind !== "delivery_admin") {
      throw new AuthServiceError("NOT_FOUND", "所选交付管理员不存在");
    }
    const customerIds = new Set(
      input.ownerships
        .filter(
          (ownership) => Number(ownership.deliveryAdminId) === deliveryAdminId,
        )
        .map((ownership) => Number(ownership.userId)),
    );
    return candidates
      .filter(
        (target) =>
          target.userId === manager.userId ||
          (target.kind === "customer" && customerIds.has(target.userId)),
      )
      .sort((left, right) => left.userId - right.userId);
  }

  const selectedEngineerIds = new Set(input.scope.engineerIds.map(Number));
  if (
    selectedEngineerIds.size === 0 ||
    [...selectedEngineerIds].some(
      (userId) => candidateById.get(userId)?.kind !== "engineer",
    )
  ) {
    throw new AuthServiceError("NOT_FOUND", "所选工程师不存在");
  }
  return [...selectedEngineerIds]
    .map((userId) => candidateById.get(userId)!)
    .sort((left, right) => left.userId - right.userId);
}

export function assertBulkManagedApiKeyTargetSelection(input: {
  resolvedTargets: Array<{ userId: number; kind: ManagedApiKeyTargetKind }>;
  requestedTargets: BulkManagedApiKeyRequestedTarget[];
}) {
  const requestedById = new Map<number, BulkManagedApiKeyRequestedTarget>();
  for (const target of input.requestedTargets) {
    if (requestedById.has(target.userId)) {
      throw new AuthServiceError("CONFLICT", "批量 Key 范围包含重复账号");
    }
    requestedById.set(target.userId, target);
  }
  const exactSelection =
    requestedById.size === input.resolvedTargets.length &&
    input.resolvedTargets.every((target) => requestedById.has(target.userId));
  if (!exactSelection) {
    throw new AuthServiceError(
      "CONFLICT",
      "批量 Key 范围已变化，请刷新账号列表后重试",
    );
  }
  return input.resolvedTargets.map((target) => ({
    ...target,
    expectedVersion: requestedById.get(target.userId)!.expectedVersion,
  }));
}

export function bulkManagedApiKeyActionTargets<
  T extends { userId: number; kind: ManagedApiKeyTargetKind },
>(input: {
  resolvedTargets: T[];
  latestCredentials: Map<
    number,
    { status: string; fingerprint?: string | null; agentProfile?: unknown }
  >;
  applyMode: BulkManagedApiKeyApplyMode;
  nextFingerprint: string;
  nextAgentProfile?: ManagedAgentProfile;
}) {
  return input.resolvedTargets.filter((target) => {
    const credential = input.latestCredentials.get(target.userId);
    if (input.applyMode === "unconfigured_only") {
      return credential?.status !== "active";
    }
    return (
      credential?.status !== "active" ||
      credential.fingerprint !== input.nextFingerprint ||
      (target.kind === "customer" &&
        normalizeManagedAgentProfile(credential.agentProfile) !==
          normalizeManagedAgentProfile(input.nextAgentProfile))
    );
  });
}

export function assertBulkManagedApiKeyTargetVersions(input: {
  targets: Array<{
    userId: number;
    kind: ManagedApiKeyTargetKind;
    expectedVersion: number;
  }>;
  accounts: Map<number, BulkManagedApiKeyAccount>;
  latestCredentials: Map<number, { version: number; status: string }>;
  applyMode: BulkManagedApiKeyApplyMode;
}) {
  for (const target of input.targets) {
    const credential = input.latestCredentials.get(target.userId);
    if (
      input.applyMode === "unconfigured_only" &&
      credential?.status === "active"
    ) {
      continue;
    }
    assertManagedApiKeyTarget({
      kind: target.kind,
      target: input.accounts.get(target.userId),
      actualVersion: credential?.version ?? 0,
      expectedVersion: target.expectedVersion,
    });
  }
}

async function requireDb() {
  const db = await getDb();
  if (!db) {
    throw new AuthServiceError("DATABASE_UNAVAILABLE", "数据库暂时不可用。");
  }
  return db;
}

export function apiUsageSeverity(input: {
  used: number;
  limit: number;
  warningRatio: number;
  syncStatus: "pending" | "ok" | "error" | "unconfigured";
}): ApiUsageSeverity {
  if (input.syncStatus !== "ok") return "unavailable";
  if (input.limit <= 0 || input.used >= input.limit) return "critical";
  if (input.used >= input.limit * input.warningRatio) return "warning";
  return "normal";
}

export function assertManagedApiKeyTarget(input: {
  kind: ManagedApiKeyTargetKind;
  target?: {
    id: number;
    role: string;
    adminAccessLevel?: string | null;
  } | null;
  actualVersion: number;
  expectedVersion: number;
}) {
  const matches =
    input.kind === "customer"
      ? input.target?.role === "user"
      : input.kind === "engineer"
        ? input.target?.role === "delivery_member"
        : input.kind === "delivery_admin" &&
          input.target?.role === "admin" &&
          input.target?.adminAccessLevel === "delivery_admin";
  if (!matches) {
    throw new AuthServiceError(
      "NOT_FOUND",
      "API Key 管理目标不存在或类型不匹配",
    );
  }
  if (input.actualVersion !== input.expectedVersion) {
    throw new AuthServiceError(
      "CONFLICT",
      "API Key 状态已变化，请刷新后重试；迟到请求不会覆盖较新的 Key",
    );
  }
}

async function loadBulkManagedApiKeyScopeState(input: {
  executor: any;
  scope: BulkManagedApiKeyScope;
  lock?: boolean;
}) {
  const loadAccounts = async (userIds?: number[]) => {
    const query = input.executor
      .select({
        id: users.id,
        role: users.role,
        adminAccessLevel: users.adminAccessLevel,
        isActive: users.isActive,
      })
      .from(users);
    const orderedQuery = userIds
      ? query
          .where(inArray(users.id, userIds))
          .orderBy(
            sql`case when ${users.role} = 'user' then 0 else 1 end`,
            asc(users.id),
          )
      : query.orderBy(
          sql`case when ${users.role} = 'user' then 0 else 1 end`,
          asc(users.id),
        );
    return input.lock ? await orderedQuery.for("update") : await orderedQuery;
  };

  let accounts: BulkManagedApiKeyAccount[];
  let ownerships: Array<{ userId: number; deliveryAdminId: number }> = [];
  if (input.scope.kind === "delivery_admin") {
    const ownershipQuery = input.executor
      .select({
        userId: userUsageOwners.userId,
        deliveryAdminId: userUsageOwners.deliveryAdminId,
      })
      .from(userUsageOwners)
      .where(eq(userUsageOwners.deliveryAdminId, input.scope.deliveryAdminId))
      .orderBy(asc(userUsageOwners.userId));
    const observedOwnerships: Array<{
      userId: number;
      deliveryAdminId: number;
    }> = await ownershipQuery;
    accounts = await loadAccounts([
      ...new Set([
        input.scope.deliveryAdminId,
        ...observedOwnerships.map((ownership) => Number(ownership.userId)),
      ]),
    ]);
    ownerships = input.lock
      ? await ownershipQuery.for("update")
      : observedOwnerships;
    if (input.lock) {
      const observedCustomerIds = observedOwnerships
        .map((ownership) => Number(ownership.userId))
        .sort((left, right) => left - right);
      const lockedCustomerIds = ownerships
        .map((ownership) => Number(ownership.userId))
        .sort((left, right) => left - right);
      if (
        observedCustomerIds.length !== lockedCustomerIds.length ||
        observedCustomerIds.some(
          (userId, index) => userId !== lockedCustomerIds[index],
        )
      ) {
        throw new AuthServiceError(
          "CONFLICT",
          "交付管理员负责范围已变化，请刷新账号列表后重试",
        );
      }
    }
  } else if (input.scope.kind === "engineers") {
    accounts = await loadAccounts([
      ...new Set(input.scope.engineerIds.map(Number)),
    ]);
  } else {
    accounts = await loadAccounts();
  }
  const resolvedTargets = resolveBulkManagedApiKeyTargets({
    scope: input.scope,
    accounts,
    ownerships,
  });
  return { accounts, ownerships, resolvedTargets };
}

function latestManagedCredentialByUser<
  T extends { userId: number; version: number },
>(rows: T[]) {
  const latest = new Map<number, T>();
  for (const row of rows) {
    const userId = Number(row.userId);
    const existing = latest.get(userId);
    if (!existing || Number(row.version) > Number(existing.version)) {
      latest.set(userId, row);
    }
  }
  return latest;
}

export function syncableManagedWorkspaceUserIds(input: {
  workspaceUserIds: number[];
  ownershipRows: Array<{ userId: number; deliveryAdminId: number }>;
  eligibleOwnerIds: number[];
}) {
  const ownerByWorkspaceUser = new Map(
    input.ownershipRows.map((owner) => [
      Number(owner.userId),
      Number(owner.deliveryAdminId),
    ]),
  );
  const eligibleOwnerIds = new Set(input.eligibleOwnerIds.map(Number));
  return input.workspaceUserIds.filter((userId) => {
    const ownerId = ownerByWorkspaceUser.get(userId);
    return ownerId === undefined || eligibleOwnerIds.has(ownerId);
  });
}

export function apiUsageSnapshotCompletionState(input: {
  totalComplete: boolean;
  issueCode?: ApiUsageSyncIssueCode;
}) {
  if (!input.totalComplete) {
    return {
      status: "error" as const,
      errorCode: input.issueCode ?? ("PARTIAL_USAGE_SCAN" as const),
    };
  }
  return {
    status: "ok" as const,
    errorCode: null,
  };
}

export type BulkManagedApiKeyRuntime = {
  requireDatabase: typeof requireDb;
  validateApiKey: typeof validateUpstreamApiKey;
  fingerprintApiKey: typeof getApiKeyFingerprint;
  replaceCredential: typeof replaceApiCredentialInTransaction;
  writeAuditEvent: typeof writeWorkspaceAuditEvent;
  queueRefresh: typeof queueManagedApiUsageFingerprintRefresh;
  now: () => Date;
};

export async function bulkReplaceManagedApiKeyTargets(
  input: {
    actor: AuthenticatedUser;
    scope: BulkManagedApiKeyScope;
    targets: BulkManagedApiKeyRequestedTarget[];
    applyMode: BulkManagedApiKeyApplyMode;
    apiKey: string;
    agentProfile?: ManagedAgentProfile;
    reason?: string;
  },
  runtimeOverrides: Partial<BulkManagedApiKeyRuntime> = {},
) {
  const runtime: BulkManagedApiKeyRuntime = {
    requireDatabase: requireDb,
    validateApiKey: validateUpstreamApiKey,
    fingerprintApiKey: getApiKeyFingerprint,
    replaceCredential: replaceApiCredentialInTransaction,
    writeAuditEvent: writeWorkspaceAuditEvent,
    queueRefresh: queueManagedApiUsageFingerprintRefresh,
    now: () => new Date(),
    ...runtimeOverrides,
  };
  if (!isSystemAdmin(input.actor)) {
    throw new AuthServiceError(
      "INVALID_CREDENTIAL",
      "只有系统管理员可以批量配置账号 API Key。",
    );
  }
  const agentProfile = normalizeManagedAgentProfile(input.agentProfile);
  const db = await runtime.requireDatabase();
  const initialScope = await loadBulkManagedApiKeyScopeState({
    executor: db,
    scope: input.scope,
  });
  const scopeTargetIds = initialScope.resolvedTargets.map(
    (target) => target.userId,
  );
  if (scopeTargetIds.length === 0) {
    throw new AuthServiceError("CONFLICT", "当前批量范围内没有可配置账号");
  }
  const initialCredentialRows = await db
    .select()
    .from(apiCredentials)
    .where(inArray(apiCredentials.userId, scopeTargetIds))
    .orderBy(asc(apiCredentials.userId), desc(apiCredentials.version));
  const initialLatestCredentials = latestManagedCredentialByUser(
    initialCredentialRows,
  );
  const initialScopeTargets = assertBulkManagedApiKeyTargetSelection({
    resolvedTargets: initialScope.resolvedTargets,
    requestedTargets: input.targets,
  });
  const nextFingerprint = runtime.fingerprintApiKey(input.apiKey);
  const initialActionTargets = bulkManagedApiKeyActionTargets({
    resolvedTargets: initialScopeTargets,
    latestCredentials: initialLatestCredentials,
    applyMode: input.applyMode,
    nextFingerprint,
    nextAgentProfile: agentProfile,
  });
  if (initialActionTargets.length > 200) {
    throw new AuthServiceError(
      "CONFLICT",
      "单次批量配置最多支持 200 个实际变更账号，请缩小范围后重试",
    );
  }
  await runtime.validateApiKey(input.apiKey);

  const batchId = randomUUID();
  const replacedAt = runtime.now();
  const result = await db.transaction(async (tx) => {
    const lockedScope = await loadBulkManagedApiKeyScopeState({
      executor: tx,
      scope: input.scope,
      lock: true,
    });
    const accountById = new Map<number, BulkManagedApiKeyAccount>(
      (lockedScope.accounts as BulkManagedApiKeyAccount[]).map((account) => [
        Number(account.id),
        account,
      ]),
    );
    const credentialRows = await tx
      .select()
      .from(apiCredentials)
      .where(
        inArray(
          apiCredentials.userId,
          lockedScope.resolvedTargets.map((target) => target.userId),
        ),
      )
      .orderBy(asc(apiCredentials.userId), desc(apiCredentials.version))
      .for("update");
    const latestCredentials = latestManagedCredentialByUser(credentialRows);
    const lockedScopeTargets = assertBulkManagedApiKeyTargetSelection({
      resolvedTargets: lockedScope.resolvedTargets,
      requestedTargets: input.targets,
    });
    const lockedActionTargets = bulkManagedApiKeyActionTargets({
      resolvedTargets: lockedScopeTargets,
      latestCredentials,
      applyMode: input.applyMode,
      nextFingerprint,
      nextAgentProfile: agentProfile,
    });
    if (lockedActionTargets.length > 200) {
      throw new AuthServiceError(
        "CONFLICT",
        "单次批量配置最多支持 200 个实际变更账号，请缩小范围后重试",
      );
    }
    assertBulkManagedApiKeyTargetVersions({
      targets: lockedActionTargets,
      accounts: accountById,
      latestCredentials,
      applyMode: input.applyMode,
    });

    let updatedCount = 0;
    let unchangedCount = lockedScopeTargets.length - lockedActionTargets.length;
    const versions: Array<{ userId: number; version: number }> = [];
    for (const target of lockedActionTargets) {
      const currentCredential = latestCredentials.get(target.userId);
      if (
        currentCredential?.status === "active" &&
        (input.applyMode === "unconfigured_only" ||
          (currentCredential.fingerprint === nextFingerprint &&
            (target.kind !== "customer" ||
              normalizeManagedAgentProfile(
                (currentCredential as { agentProfile?: unknown }).agentProfile,
              ) === agentProfile)))
      ) {
        unchangedCount += 1;
        versions.push({
          userId: target.userId,
          version: currentCredential.version,
        });
        continue;
      }
      const credential = await runtime.replaceCredential({
        executor: tx,
        userId: target.userId,
        apiKey: input.apiKey,
        agentProfile: target.kind === "customer" ? agentProfile : null,
        now: replacedAt,
      });
      updatedCount += 1;
      versions.push({ userId: target.userId, version: credential.version });
      await runtime.writeAuditEvent(
        {
          actor: input.actor,
          action: "admin.api_credential.bulk_replaced",
          targetType: target.kind,
          targetId: target.userId,
          workspaceUserId: target.kind === "customer" ? target.userId : null,
          reason: input.reason,
          now: replacedAt,
          metadata: {
            batchId,
            scopeKind: input.scope.kind,
            applyMode: input.applyMode,
            previousVersion: currentCredential?.version ?? 0,
            credentialVersion: credential.version,
            ...(target.kind === "customer"
              ? {
                  agentProfile: credential.agentProfile,
                  upstreamModel: credential.upstreamModel,
                }
              : {}),
          },
        },
        tx,
      );
    }
    await runtime.writeAuditEvent(
      {
        actor: input.actor,
        action: "admin.api_credential.bulk_completed",
        targetType: "api_credential_batch",
        targetId: batchId,
        reason: input.reason,
        now: replacedAt,
        metadata: {
          scope: input.scope,
          applyMode: input.applyMode,
          scopeTargetCount: lockedScope.resolvedTargets.length,
          targetCount: lockedActionTargets.length,
          updatedCount,
          unchangedCount,
          ...(lockedScopeTargets.some((target) => target.kind === "customer")
            ? {
                customerAgentProfile: agentProfile,
                customerUpstreamModel: managedAgentProfileModel(agentProfile),
              }
            : {}),
          targetUserIds: lockedActionTargets.map((target) => target.userId),
        },
      },
      tx,
    );
    return {
      batchId,
      scopeTargetCount: lockedScope.resolvedTargets.length,
      targetCount: lockedActionTargets.length,
      updatedCount,
      unchangedCount,
      versions,
    };
  });

  // Do not hold the HTTP mutation open for a second unbounded history scan
  // after the transaction has committed. Queue one deduplicated, targeted
  // refresh for the new physical-Key pool; the queue shares the global named
  // lock and retries after an overlapping full synchronization finishes.
  if (result.updatedCount > 0) {
    runtime.queueRefresh({
      actor: input.actor,
      fingerprint: nextFingerprint,
    });
  }
  return result;
}

export async function replaceManagedApiKeyTarget(input: {
  actor: AuthenticatedUser;
  kind: ManagedApiKeyTargetKind;
  userId: number;
  apiKey: string;
  agentProfile?: ManagedAgentProfile;
  expectedVersion: number;
  reason?: string;
  relatedTicketId?: string;
}) {
  if (!isSystemAdmin(input.actor)) {
    throw new AuthServiceError(
      "INVALID_CREDENTIAL",
      "只有系统管理员可以替换账号 API Key。",
    );
  }
  await validateUpstreamApiKey(input.apiKey);
  const agentProfile = normalizeManagedAgentProfile(input.agentProfile);
  const nextFingerprint = getApiKeyFingerprint(input.apiKey);
  const db = await requireDb();
  const replacement = await db.transaction(async (tx) => {
    const targetRows = await tx
      .select({
        id: users.id,
        role: users.role,
        adminAccessLevel: users.adminAccessLevel,
      })
      .from(users)
      .where(eq(users.id, input.userId))
      .limit(1)
      .for("update");
    const credentialRows = await tx
      .select()
      .from(apiCredentials)
      .where(eq(apiCredentials.userId, input.userId))
      .orderBy(desc(apiCredentials.version))
      .limit(1)
      .for("update");
    const actualVersion = credentialRows[0]?.version ?? 0;
    assertManagedApiKeyTarget({
      kind: input.kind,
      target: targetRows[0],
      actualVersion,
      expectedVersion: input.expectedVersion,
    });
    const relatedTicketRows = input.relatedTicketId
      ? await tx
          .select()
          .from(deliveryTickets)
          .where(eq(deliveryTickets.id, input.relatedTicketId))
          .limit(1)
          .for("update")
      : [];
    const relatedTicket = relatedTicketRows[0];
    if (
      input.relatedTicketId &&
      (!relatedTicket ||
        relatedTicket.credentialTargetUserId !== input.userId ||
        relatedTicket.credentialRequestKind !== "managed_api" ||
        ![
          "submitted",
          "needs_information",
          "scheduled",
          "in_progress",
        ].includes(relatedTicket.status))
    ) {
      throw new AuthServiceError(
        "CONFLICT",
        "关联凭据需求不存在、目标账号不匹配或已经关闭",
      );
    }
    const credential = await replaceApiCredentialInTransaction({
      executor: tx,
      userId: input.userId,
      apiKey: input.apiKey,
      agentProfile: input.kind === "customer" ? agentProfile : null,
    });
    if (relatedTicket) {
      const completedAt = new Date();
      const summary = "目标账号 API Key 已由系统管理员完成配置并通过连接验证。";
      await tx
        .update(deliveryTickets)
        .set({
          status: "completed",
          quotaState: "consumed",
          publicSummary: summary,
          resolvedAt: completedAt,
          technicalDedupeKey: null,
          revision: sql`${deliveryTickets.revision} + 1`,
          updatedByUserId: input.actor.id,
          updatedAt: completedAt,
        })
        .where(eq(deliveryTickets.id, relatedTicket.id));
      await tx.insert(deliveryTicketEvents).values({
        id: randomUUID(),
        ticketId: relatedTicket.id,
        userId: relatedTicket.userId,
        actorUserId: input.actor.id,
        actorRole: "admin",
        kind: "status_change",
        visibility: "customer",
        message: summary,
        fromStatus: relatedTicket.status,
        toStatus: "completed",
        createdAt: completedAt,
      });
    }
    await writeWorkspaceAuditEvent(
      {
        actor: input.actor,
        action: "admin.api_credential.replaced",
        targetType: input.kind,
        targetId: input.userId,
        workspaceUserId: input.kind === "customer" ? input.userId : null,
        reason: input.reason,
        metadata: {
          targetKind: input.kind,
          previousVersion: actualVersion,
          credentialVersion: credential.version,
          configured: credential.configured,
          ...(input.kind === "customer"
            ? {
                agentProfile: credential.agentProfile,
                upstreamModel: credential.upstreamModel,
              }
            : {}),
          relatedTicketId: relatedTicket?.id ?? null,
        },
      },
      tx,
    );
    return { credential };
  });
  queueManagedApiUsageFingerprintRefresh({
    actor: input.actor,
    fingerprint: nextFingerprint,
  });
  return replacement.credential;
}

export async function revokeManagedApiKeyTarget(input: {
  actor: AuthenticatedUser;
  kind: ManagedApiKeyTargetKind;
  userId: number;
  expectedVersion: number;
  reason?: string;
}) {
  if (!isSystemAdmin(input.actor)) {
    throw new AuthServiceError(
      "INVALID_CREDENTIAL",
      "只有系统管理员可以撤销账号 API Key。",
    );
  }
  const fence = await acquireActiveApiCredentialDeletionFence(input.userId);
  if (!fence) {
    throw new AuthServiceError("CONFLICT", "API Key 尚未配置或已被撤销");
  }
  const db = await requireDb();
  const stopFenceHeartbeat =
    startActiveApiCredentialDeletionFenceHeartbeat(fence);
  let transactionCommitted = false;
  try {
    const result = await db.transaction(async (tx) => {
      const targetRows = await tx
        .select({
          id: users.id,
          role: users.role,
          adminAccessLevel: users.adminAccessLevel,
        })
        .from(users)
        .where(eq(users.id, input.userId))
        .limit(1)
        .for("update");
      const credentialRows = await tx
        .select()
        .from(apiCredentials)
        .where(eq(apiCredentials.userId, input.userId))
        .orderBy(desc(apiCredentials.version))
        .limit(1)
        .for("update");
      const latest = credentialRows[0];
      const actualVersion = latest?.version ?? 0;
      assertManagedApiKeyTarget({
        kind: input.kind,
        target: targetRows[0],
        actualVersion,
        expectedVersion: input.expectedVersion,
      });
      if (latest?.status !== "active") {
        throw new AuthServiceError("CONFLICT", "API Key 尚未配置或已被撤销");
      }
      // This keeps the credential lock and all in-flight/recovery dependency
      // checks in the same transaction as the CAS decision.
      const deletion = await deleteActiveApiCredentialInTransaction({
        executor: tx,
        userId: input.userId,
        fenceToken: fence,
      });
      await writeWorkspaceAuditEvent(
        {
          actor: input.actor,
          action: "admin.api_credential.revoked",
          targetType: input.kind,
          targetId: input.userId,
          workspaceUserId: input.kind === "customer" ? input.userId : null,
          reason: input.reason,
          metadata: {
            targetKind: input.kind,
            previousVersion: actualVersion,
            credentialVersion: deletion.version,
            configured: false,
          },
        },
        tx,
      );
      return { success: true as const, version: deletion.version };
    });
    transactionCommitted = true;
    await stopFenceHeartbeat();
    await completeActiveApiCredentialDeletionFence(fence);
    return result;
  } catch (error) {
    await stopFenceHeartbeat().catch(() => undefined);
    if (!transactionCommitted) {
      await rollbackActiveApiCredentialDeletionFence(fence).catch(
        () => undefined,
      );
    }
    throw error;
  }
}

function policyKey(scope: ApiUsageScope, userId?: number | null) {
  return scope === "website_frontend"
    ? "website_frontend"
    : `managed_user:${userId}`;
}

async function accessibleWorkspaceUsers(
  actor: AuthenticatedUser,
  executor: any,
) {
  if (isSystemAdmin(actor)) {
    return executor
      .select({
        id: users.id,
        enterpriseName: users.displayName,
        username: users.username,
        isActive: users.isActive,
      })
      .from(users)
      .where(eq(users.role, "user"));
  }
  return executor
    .select({
      id: users.id,
      enterpriseName: users.displayName,
      username: users.username,
      isActive: users.isActive,
    })
    .from(userAdminAssignments)
    .innerJoin(users, eq(users.id, userAdminAssignments.userId))
    .where(
      and(
        eq(userAdminAssignments.adminId, actor.id),
        eq(users.role, "user"),
        eq(users.isActive, true),
      ),
    );
}

async function accessibleDeliveryAdmins(
  actor: AuthenticatedUser,
  executor: any,
) {
  if (isSystemAdmin(actor)) {
    return executor
      .select({
        id: users.id,
        displayName: users.displayName,
        username: users.username,
        adminAccessLevel: users.adminAccessLevel,
        isActive: users.isActive,
      })
      .from(users)
      .where(eq(users.role, "admin"));
  }
  if (actor.role !== "admin" || actor.adminAccessLevel !== "delivery_admin") {
    return [];
  }
  return [
    {
      id: actor.id,
      displayName: actor.displayName ?? null,
      username: actor.username,
      adminAccessLevel: actor.adminAccessLevel,
      isActive: actor.isActive,
    },
  ];
}

async function accessibleDeliveryEngineers(
  actor: AuthenticatedUser,
  executor: any,
) {
  if (!isSystemAdmin(actor)) return [];
  return executor
    .select({
      id: users.id,
      displayName: users.displayName,
      username: users.username,
      isActive: users.isActive,
    })
    .from(users)
    .where(eq(users.role, "delivery_member"));
}

async function ensureUsagePolicy(input: {
  executor: any;
  scope: ApiUsageScope;
  workspaceUserId?: number | null;
}) {
  const key = policyKey(input.scope, input.workspaceUserId);
  const rows = await input.executor
    .select()
    .from(apiUsagePolicies)
    .where(eq(apiUsagePolicies.policyKey, key))
    .limit(1);
  if (rows[0]) return rows[0];
  const id = randomUUID();
  await input.executor.insert(apiUsagePolicies).values({
    id,
    policyKey: key,
    scope: input.scope,
    workspaceUserId: input.workspaceUserId ?? null,
    limit: DEFAULT_API_USAGE_LIMIT,
    warningRatioBasisPoints: Math.round(
      DEFAULT_API_USAGE_WARNING_RATIO * 10_000,
    ),
    windowDays: DEFAULT_API_USAGE_WINDOW_DAYS,
  });
  const created = await input.executor
    .select()
    .from(apiUsagePolicies)
    .where(eq(apiUsagePolicies.policyKey, key))
    .limit(1);
  return created[0];
}

export function resolveEffectiveUsageCredentials(input: {
  userIds: number[];
  credentialRows: Array<{
    id?: string;
    userId: number;
    version?: number;
    fingerprint: string;
    createdAt?: Date;
  }>;
  ownerRows: Array<{ userId: number; deliveryAdminId: number }>;
}) {
  const activeByOwner = new Map<
    number,
    (typeof input.credentialRows)[number]
  >();
  for (const row of input.credentialRows) {
    if (!activeByOwner.has(Number(row.userId))) {
      activeByOwner.set(Number(row.userId), row);
    }
  }
  const byUser = new Map<number, string>();
  const credentialOwnerByUser = new Map<number, number>();
  const credentialIdByUser = new Map<number, string>();
  const credentialVersionByUser = new Map<number, number>();
  const credentialCreatedAtByUser = new Map<number, number>();
  for (const userId of input.userIds) {
    // Delivery ownership remains a reporting relationship. Every account's
    // runtime and pool status is derived only from its own active Key.
    const credentialOwnerId = userId;
    const credential = activeByOwner.get(credentialOwnerId);
    if (credential) {
      byUser.set(userId, credential.fingerprint);
      credentialOwnerByUser.set(userId, credentialOwnerId);
      if (credential.id) credentialIdByUser.set(userId, credential.id);
      if (credential.version !== undefined) {
        credentialVersionByUser.set(userId, credential.version);
      }
      if (credential.createdAt) {
        credentialCreatedAtByUser.set(userId, credential.createdAt.getTime());
      }
    }
  }
  return {
    byUser,
    credentialOwnerByUser,
    credentialIdByUser,
    credentialVersionByUser,
    credentialCreatedAtByUser,
  };
}

async function usageCredentialFingerprints(input: {
  executor: any;
  userIds: number[];
}) {
  const credentialRows = await input.executor
    .select({
      id: apiCredentials.id,
      userId: apiCredentials.userId,
      version: apiCredentials.version,
      fingerprint: apiCredentials.fingerprint,
      createdAt: apiCredentials.createdAt,
    })
    .from(apiCredentials)
    .where(eq(apiCredentials.status, "active"))
    .orderBy(desc(apiCredentials.createdAt));
  const ownerRows =
    input.userIds.length === 0
      ? []
      : await input.executor
          .select({
            userId: userUsageOwners.userId,
            deliveryAdminId: userUsageOwners.deliveryAdminId,
          })
          .from(userUsageOwners)
          .where(inArray(userUsageOwners.userId, input.userIds));
  const effective = resolveEffectiveUsageCredentials({
    userIds: input.userIds,
    credentialRows,
    ownerRows,
  });
  const websiteRows = await input.executor
    .select({
      id: presalesApiCredentials.id,
      version: presalesApiCredentials.version,
      fingerprint: presalesApiCredentials.fingerprint,
      createdAt: presalesApiCredentials.createdAt,
    })
    .from(presalesApiCredentials)
    .where(
      and(
        eq(presalesApiCredentials.slot, "website"),
        eq(presalesApiCredentials.status, "active"),
      ),
    )
    .orderBy(desc(presalesApiCredentials.createdAt))
    .limit(1);
  const websiteCredential = websiteRows[0] ?? null;
  return {
    ...effective,
    website: websiteCredential?.fingerprint ?? null,
    websiteCredential,
  };
}

export function isRollingUsageSnapshotCurrent(input: {
  snapshot?: {
    credentialFingerprint: string | null;
    windowStartedAt: Date;
    fetchedAt: Date | null;
    updatedAt?: Date | null;
  };
  fingerprint: string | null;
  credentialCreatedAt?: number | null;
  windowDays: number;
  now?: number;
  maxAgeMs?: number;
}) {
  const snapshot = input.snapshot;
  if (!snapshot || snapshot.credentialFingerprint !== input.fingerprint) {
    return false;
  }
  // Freshness is the age of the last successful upstream observation. A
  // failed attempt updates `updatedAt` for keyLastAttemptAt, but it must not
  // manufacture a successful pool reading or clear the stale badge.
  const snapshotAt = snapshot.fetchedAt?.getTime();
  if (!snapshotAt) return false;
  const now = input.now ?? Date.now();
  const maxAgeMs = input.maxAgeMs ?? API_USAGE_SNAPSHOT_FRESHNESS_MS;
  if (snapshotAt > now || now - snapshotAt > maxAgeMs) return false;
  if (
    input.credentialCreatedAt != null &&
    snapshotAt < input.credentialCreatedAt
  ) {
    return false;
  }
  const period = getShanghaiRollingUsagePeriod(input.windowDays, snapshotAt);
  return snapshot.windowStartedAt.getTime() === period.startAt;
}

export function usageCredentialPoolKey(input: {
  fingerprint?: string | null;
  credentialId: string | null;
  credentialVersion: number | null;
  windowDays?: number;
}) {
  const identity = input.fingerprint
    ? `fingerprint:${input.fingerprint}`
    : input.credentialId && input.credentialVersion !== null
      ? `credential:${input.credentialId}:${input.credentialVersion}`
      : null;
  if (!identity) return null;
  return `${identity}${
    input.windowDays === undefined ? "" : `:${input.windowDays}`
  }`;
}

export function latestUsageSnapshotByPolicy<
  T extends {
    policyId: string;
    fetchedAt?: Date | null;
    updatedAt?: Date | null;
    createdAt?: Date | null;
  },
>(snapshots: T[]) {
  const latest = new Map<string, T>();
  for (const snapshot of snapshots) {
    const existing = latest.get(snapshot.policyId);
    const timestamp =
      (
        snapshot.fetchedAt ??
        snapshot.updatedAt ??
        snapshot.createdAt
      )?.getTime() ?? 0;
    const existingTimestamp = existing
      ? ((
          existing.fetchedAt ??
          existing.updatedAt ??
          existing.createdAt
        )?.getTime() ?? 0)
      : -1;
    if (!existing || timestamp >= existingTimestamp) {
      latest.set(snapshot.policyId, snapshot);
    }
  }
  return latest;
}

export function lastSuccessfulUsageSnapshotValue(input: {
  snapshot?: {
    credentialFingerprint: string | null;
    fetchedAt: Date | null;
    used: number;
  } | null;
  fingerprint: string | null;
}) {
  return input.snapshot &&
    input.fingerprint &&
    input.snapshot.credentialFingerprint === input.fingerprint &&
    input.snapshot.fetchedAt
    ? Math.max(0, Number(input.snapshot.used) || 0)
    : null;
}

export function usageKeyPoolStale(input: {
  fingerprint: string | null;
  snapshot?: { fetchedAt: Date | null } | null;
  snapshotCurrent: boolean;
}) {
  return Boolean(
    input.fingerprint && (!input.snapshot?.fetchedAt || !input.snapshotCurrent),
  );
}

export function usageSnapshotUsageValues(input: {
  status: "ok" | "error" | "unconfigured";
  credentialFingerprint: string | null;
  used: number;
  accountUsed: number;
  existing?: {
    credentialFingerprint: string | null;
    used: number;
    accountUsed: number;
  } | null;
}) {
  const preserveLastKnownUsage =
    input.status === "error" &&
    input.existing?.credentialFingerprint === input.credentialFingerprint;
  return {
    used: preserveLastKnownUsage
      ? Number(input.existing?.used ?? 0)
      : Math.max(0, Math.round(input.used)),
    accountUsed: preserveLastKnownUsage
      ? Number(input.existing?.accountUsed ?? 0)
      : Math.max(0, Math.round(input.accountUsed)),
  };
}

export async function getApiUsageAlertOverview(actor: AuthenticatedUser) {
  if (!isSystemAdmin(actor)) {
    throw new AuthServiceError(
      "INVALID_CREDENTIAL",
      "只有系统管理员可以查看 Key 与积分总览。",
    );
  }
  const db = await requireDb();
  const workspaceUsers = await accessibleWorkspaceUsers(actor, db);
  const scopes = [
    ...(isSystemAdmin(actor)
      ? [
          {
            scope: "website_frontend" as const,
            workspaceUserId: null,
            enterpriseName: "官网前台",
          },
        ]
      : []),
    ...workspaceUsers.map((user: any) => ({
      scope: "managed_user" as const,
      workspaceUserId: user.id as number,
      enterpriseName:
        user.enterpriseName?.trim() ||
        user.username?.trim() ||
        `用户 ${user.id}`,
    })),
  ];
  const policies = await Promise.all(
    scopes.map((scope) =>
      ensureUsagePolicy({
        executor: db,
        scope: scope.scope,
        workspaceUserId: scope.workspaceUserId,
      }),
    ),
  );
  const snapshots = policies.length
    ? await db
        .select()
        .from(apiUsageSnapshots)
        .where(
          inArray(
            apiUsageSnapshots.policyId,
            policies.map((policy) => policy.id),
          ),
        )
    : [];
  const snapshotByPolicy = latestUsageSnapshotByPolicy(snapshots);
  const fingerprints = await usageCredentialFingerprints({
    executor: db,
    userIds: workspaceUsers.map((user: any) => user.id),
  });
  const observationNow = Date.now();
  const rollingPeriod = getShanghaiRollingUsagePeriod(
    DEFAULT_API_USAGE_WINDOW_DAYS,
    observationNow,
  );
  const [managedRollingUsage, websiteRollingUsage] = await Promise.all([
    readRollingManagedUsageByAccounts({
      executor: db,
      accountIds: workspaceUsers.map((user: any) => Number(user.id)),
      startAt: rollingPeriod.startAt,
      endAt: rollingPeriod.endAt,
    }),
    getPresalesCreditUsageSnapshot(observationNow),
  ]);
  const items = policies.map((policy, index) => {
    const scope = scopes[index]!;
    const snapshot = snapshotByPolicy.get(policy.id);
    const credentialFingerprint =
      policy.scope === "website_frontend"
        ? fingerprints.website
        : (fingerprints.byUser.get(policy.workspaceUserId!) ?? null);
    const credentialCreatedAt =
      policy.scope === "website_frontend"
        ? (fingerprints.websiteCredential?.createdAt?.getTime() ?? null)
        : (fingerprints.credentialCreatedAtByUser.get(
            policy.workspaceUserId!,
          ) ?? null);
    // A matching snapshot is the last-known reading for the current physical
    // Key. Freshness controls only the stale badge; it must never erase the
    // last successful pool total or turn an old successful read into pending.
    const snapshotMatchesCredential = Boolean(
      snapshot &&
        credentialFingerprint &&
        snapshot.credentialFingerprint === credentialFingerprint,
    );
    const matchingSnapshot = snapshotMatchesCredential ? snapshot : undefined;
    const snapshotCurrent = snapshotMatchesCredential
      ? isRollingUsageSnapshotCurrent({
          snapshot,
          fingerprint: credentialFingerprint,
          credentialCreatedAt,
          windowDays: DEFAULT_API_USAGE_WINDOW_DAYS,
          now: observationNow,
        })
      : false;
    const managedSyncStatus = !credentialFingerprint
      ? "unconfigured"
      : !matchingSnapshot
        ? "pending"
        : matchingSnapshot.syncStatus;
    const syncIssueCode = storedApiUsageSyncIssueCode(
      matchingSnapshot?.errorCode,
    );
    const keyHealth =
      policy.scope === "website_frontend"
        ? websiteRollingUsage.keyHealth
        : managedSyncStatus === "ok"
          ? "connected"
          : managedSyncStatus === "pending"
            ? "pending"
            : managedSyncStatus === "unconfigured"
              ? "unconfigured"
              : syncIssueCode === "CREDENTIAL_REJECTED"
                ? "invalid_or_revoked"
                : "sync_error";
    const keyPoolTotalUsed =
      policy.scope === "website_frontend"
        ? websiteRollingUsage.keyPoolTotalUsed
        : lastSuccessfulUsageSnapshotValue({
            snapshot: matchingSnapshot,
            fingerprint: credentialFingerprint,
          });
    const rollingUsage =
      policy.scope === "website_frontend"
        ? {
            used: websiteRollingUsage.rollingWebsiteUsed,
            observedAt: websiteRollingUsage.usageObservedAt,
          }
        : (managedRollingUsage.get(policy.workspaceUserId!) ?? {
            used: 0,
            observedAt: null,
          });
    const warningRatio = policy.warningRatioBasisPoints / 10_000;
    const percentage =
      keyPoolTotalUsed !== null && policy.limit > 0
        ? Math.min(100, (keyPoolTotalUsed / policy.limit) * 100)
        : 0;
    return {
      id: policy.id,
      scope: policy.scope,
      userId: policy.workspaceUserId,
      enterpriseName: scope.enterpriseName,
      credentialFingerprint,
      keyPoolTotalUsed,
      rolling30DayUsed: rollingUsage.used,
      usageObservedAt: rollingUsage.observedAt,
      keyHealth,
      syncIssueCode,
      keyPoolStale:
        policy.scope === "website_frontend"
          ? websiteRollingUsage.keyPoolStale
          : usageKeyPoolStale({
              fingerprint: credentialFingerprint,
              snapshot: matchingSnapshot,
              snapshotCurrent,
            }),
      keyLastSuccessfulAt:
        policy.scope === "website_frontend"
          ? websiteRollingUsage.keyLastSuccessfulAt
          : (matchingSnapshot?.fetchedAt?.getTime() ?? null),
      keyLastAttemptAt:
        policy.scope === "website_frontend"
          ? websiteRollingUsage.keyLastAttemptAt
          : (matchingSnapshot?.updatedAt?.getTime() ?? null),
      limit: policy.limit,
      warningRatio,
      windowDays: DEFAULT_API_USAGE_WINDOW_DAYS,
      percentage,
      fetchedAt:
        policy.scope === "website_frontend"
          ? websiteRollingUsage.keyLastSuccessfulAt
          : (matchingSnapshot?.fetchedAt?.getTime() ?? null),
      periodStartedAt: matchingSnapshot?.windowStartedAt?.getTime() ?? null,
      severity: apiUsageSeverity({
        used: keyPoolTotalUsed ?? 0,
        limit: policy.limit,
        warningRatio,
        syncStatus:
          keyHealth === "connected"
            ? "ok"
            : keyHealth === "unconfigured"
              ? "unconfigured"
              : keyHealth === "pending"
                ? "pending"
                : "error",
      }),
      errorMessage:
        keyHealth === "sync_error" || keyHealth === "invalid_or_revoked"
          ? "用量暂时无法读取"
          : keyHealth === "unconfigured"
            ? "尚未配置 API Key"
            : null,
    };
  });
  return { items };
}

export async function getAdminApiUsageHierarchy(actor: AuthenticatedUser) {
  if (!isSystemAdmin(actor)) {
    throw new AuthServiceError(
      "INVALID_CREDENTIAL",
      "只有系统管理员可以查看 Key 与积分使用情况。",
    );
  }
  const db = await requireDb();
  const [accessibleManagers, engineers, customers] = await Promise.all([
    accessibleDeliveryAdmins(actor, db),
    accessibleDeliveryEngineers(actor, db),
    accessibleWorkspaceUsers(actor, db),
  ]);
  const managers = isSystemAdmin(actor)
    ? accessibleManagers.filter(
        (manager: any) => manager.adminAccessLevel === "delivery_admin",
      )
    : accessibleManagers;
  const systemAdministrators = accessibleManagers.filter(
    (manager: any) => manager.adminAccessLevel === "system_admin",
  );
  const managerIds = managers.map((manager: any) => Number(manager.id));
  const systemAdministratorIds = systemAdministrators.map((manager: any) =>
    Number(manager.id),
  );
  const engineerIds = engineers.map((engineer: any) => Number(engineer.id));
  const customerIds = customers.map((customer: any) => Number(customer.id));
  const ownerships =
    customerIds.length === 0
      ? []
      : await db
          .select({
            adminId: userUsageOwners.deliveryAdminId,
            userId: userUsageOwners.userId,
          })
          .from(userUsageOwners)
          .where(inArray(userUsageOwners.userId, customerIds));
  const subjectIds = [
    ...new Set([
      ...systemAdministratorIds,
      ...managerIds,
      ...customerIds,
      ...engineerIds,
    ]),
  ];
  const policies = await Promise.all(
    subjectIds.map((subjectId) =>
      ensureUsagePolicy({
        executor: db,
        scope: "managed_user",
        workspaceUserId: subjectId,
      }),
    ),
  );
  const snapshots = policies.length
    ? await db
        .select()
        .from(apiUsageSnapshots)
        .where(
          inArray(
            apiUsageSnapshots.policyId,
            policies.map((policy) => policy.id),
          ),
        )
    : [];
  const snapshotByPolicy = latestUsageSnapshotByPolicy(snapshots);
  const policyByUser = new Map(
    policies.map((policy) => [Number(policy.workspaceUserId), policy]),
  );
  const fingerprints = await usageCredentialFingerprints({
    executor: db,
    userIds: subjectIds,
  });
  const managedCredentialUserIds = [
    ...systemAdministratorIds,
    ...managerIds,
    ...engineerIds,
    ...customerIds,
  ];
  const managedCredentialRows =
    managedCredentialUserIds.length === 0
      ? []
      : await db
          .select()
          .from(apiCredentials)
          .where(inArray(apiCredentials.userId, managedCredentialUserIds))
          .orderBy(desc(apiCredentials.version));
  const latestManagedCredentialById = new Map<
    number,
    (typeof managedCredentialRows)[number]
  >();
  for (const credential of managedCredentialRows) {
    if (!latestManagedCredentialById.has(Number(credential.userId))) {
      latestManagedCredentialById.set(Number(credential.userId), credential);
    }
  }
  const now = Date.now();
  const period = getShanghaiRollingUsagePeriod(
    DEFAULT_API_USAGE_WINDOW_DAYS,
    now,
  );
  const rollingUsageByAccount = await readRollingManagedUsageByAccounts({
    executor: db,
    accountIds: subjectIds,
    startAt: period.startAt,
    endAt: period.endAt,
  });

  const usageFor = (userId: number) => {
    const policy = policyByUser.get(userId);
    const fingerprint = fingerprints.byUser.get(userId) ?? null;
    const snapshot = policy ? snapshotByPolicy.get(policy.id) : undefined;
    const credentialCreatedAt =
      fingerprints.credentialCreatedAtByUser.get(userId) ?? null;
    const snapshotMatchesCredential = Boolean(
      snapshot && fingerprint && snapshot.credentialFingerprint === fingerprint,
    );
    const snapshotCurrent = snapshotMatchesCredential
      ? isRollingUsageSnapshotCurrent({
          snapshot,
          fingerprint,
          credentialCreatedAt,
          windowDays: DEFAULT_API_USAGE_WINDOW_DAYS,
          now,
        })
      : false;
    const syncIssueCode = snapshotMatchesCredential
      ? storedApiUsageSyncIssueCode(snapshot?.errorCode)
      : null;
    const keyHealth = !fingerprint
      ? ("unconfigured" as const)
      : !snapshotMatchesCredential || snapshot?.syncStatus === "pending"
        ? ("pending" as const)
        : snapshot?.syncStatus === "ok"
          ? ("connected" as const)
          : syncIssueCode === "CREDENTIAL_REJECTED"
            ? ("invalid_or_revoked" as const)
            : ("sync_error" as const);
    const rolling = rollingUsageByAccount.get(userId);
    const keyPoolTotalUsed = lastSuccessfulUsageSnapshotValue({
      snapshot,
      fingerprint,
    });
    const limit = Number(policy?.limit ?? DEFAULT_API_USAGE_LIMIT);
    const warningRatio =
      Number(policy?.warningRatioBasisPoints ?? 8_000) / 10_000;
    return {
      fingerprint,
      credentialOwnerId: fingerprints.credentialOwnerByUser.get(userId) ?? null,
      credentialId: fingerprints.credentialIdByUser.get(userId) ?? null,
      credentialVersion:
        fingerprints.credentialVersionByUser.get(userId) ?? null,
      rolling30DayUsed: rolling?.used ?? 0,
      usageObservedAt: rolling?.observedAt ?? null,
      keyPoolTotalUsed,
      keyLastSuccessfulAt: snapshotMatchesCredential
        ? (snapshot?.fetchedAt?.getTime() ?? null)
        : null,
      keyLastAttemptAt: snapshotMatchesCredential
        ? (snapshot?.updatedAt?.getTime() ?? null)
        : null,
      keyHealth,
      syncIssueCode,
      keyPoolStale: usageKeyPoolStale({
        fingerprint,
        snapshot: snapshotMatchesCredential ? snapshot : undefined,
        snapshotCurrent,
      }),
      limit,
      warningRatio,
      fetchedAt: snapshotMatchesCredential
        ? (snapshot?.fetchedAt?.getTime() ?? null)
        : null,
      severity: apiUsageSeverity({
        used: keyPoolTotalUsed ?? 0,
        limit,
        warningRatio,
        syncStatus:
          keyHealth === "connected"
            ? "ok"
            : keyHealth === "unconfigured"
              ? "unconfigured"
              : keyHealth === "pending"
                ? "pending"
                : "error",
      }),
    };
  };
  const customerById = new Map(
    customers.map((customer: any) => [Number(customer.id), customer]),
  );
  const adminById = new Map<
    number,
    { displayName?: string | null; username?: string | null }
  >(accessibleManagers.map((manager: any) => [Number(manager.id), manager]));
  const ownerByCustomerId = new Map(
    ownerships.map((ownership: any) => [
      Number(ownership.userId),
      Number(ownership.adminId),
    ]),
  );

  const customerUsage = customers.map((customer: any) => {
    const customerId = Number(customer.id);
    const usage = usageFor(customerId);
    const latestCredential = latestManagedCredentialById.get(customerId);
    const ownerId = ownerByCustomerId.get(customerId) ?? null;
    const owner = ownerId == null ? null : adminById.get(ownerId);
    const directApiKeyConfigured = latestCredential?.status === "active";
    return {
      userId: customerId,
      enterpriseName:
        customer.enterpriseName?.trim() ||
        customer.username?.trim() ||
        `客户 ${customer.id}`,
      username: customer.username,
      isActive: customer.isActive !== false,
      deliveryAdminId: ownerId,
      deliveryAdminName:
        owner?.displayName?.trim() || owner?.username?.trim() || null,
      apiKeyConfigured: directApiKeyConfigured,
      apiKeyVersion: latestCredential?.version ?? 0,
      agentProfile: normalizeManagedAgentProfile(
        (latestCredential as { agentProfile?: unknown } | undefined)
          ?.agentProfile,
      ),
      usesInheritedKey: false,
      rolling30DayUsed: usage.rolling30DayUsed,
      usageObservedAt: usage.usageObservedAt,
      keyPoolTotalUsed: usage.keyPoolTotalUsed,
      keyLastSuccessfulAt: usage.keyLastSuccessfulAt,
      keyLastAttemptAt: usage.keyLastAttemptAt,
      keyHealth:
        latestCredential?.validationStatus === "invalid" ||
        (!usage.fingerprint && latestCredential)
          ? "invalid_or_revoked"
          : usage.keyHealth,
      syncIssueCode: usage.syncIssueCode,
      keyPoolStale: usage.keyPoolStale,
      fingerprint: usage.fingerprint,
      fetchedAt: usage.fetchedAt,
    };
  });

  const engineerUsage = engineers.map((engineer: any) => {
    const usage = usageFor(Number(engineer.id));
    const latestCredential = latestManagedCredentialById.get(
      Number(engineer.id),
    );
    return {
      engineerId: Number(engineer.id),
      displayName:
        engineer.displayName?.trim() ||
        engineer.username?.trim() ||
        `工程师 ${engineer.id}`,
      username: engineer.username,
      isActive: engineer.isActive !== false,
      apiKeyConfigured: latestCredential?.status === "active",
      apiKeyVersion: latestCredential?.version ?? 0,
      rolling30DayUsed: usage.rolling30DayUsed,
      usageObservedAt: usage.usageObservedAt,
      keyPoolTotalUsed: usage.keyPoolTotalUsed,
      keyLastSuccessfulAt: usage.keyLastSuccessfulAt,
      keyLastAttemptAt: usage.keyLastAttemptAt,
      keyHealth:
        latestCredential?.validationStatus === "invalid" ||
        (!usage.fingerprint && latestCredential)
          ? "invalid_or_revoked"
          : usage.keyHealth,
      syncIssueCode: usage.syncIssueCode,
      keyPoolStale: usage.keyPoolStale,
      fingerprint: usage.fingerprint,
      fetchedAt: usage.fetchedAt,
    };
  });

  return {
    period,
    // System-administrator credentials are retained as historical rows only;
    // they are not a configurable Key target or runtime Agent identity.
    systemAdmins: [],
    customers: customerUsage,
    engineers: engineerUsage,
    managers: managers.map((manager: any) => {
      const managerUsage = usageFor(Number(manager.id));
      const latestManagerCredential = latestManagedCredentialById.get(
        Number(manager.id),
      );
      const managedCustomerRecords = ownerships
        .filter(
          (ownership: any) => Number(ownership.adminId) === Number(manager.id),
        )
        .map((ownership: any) => customerById.get(Number(ownership.userId)))
        .filter(Boolean)
        .map((customer: any) => {
          const usage = usageFor(Number(customer.id));
          return {
            customer,
            usage,
          };
        });
      const managedCustomers = managedCustomerRecords.map(
        ({ customer, usage }) => {
          return {
            userId: Number(customer.id),
            enterpriseName:
              customer.enterpriseName?.trim() ||
              customer.username?.trim() ||
              `用户 ${customer.id}`,
            username: customer.username,
            rolling30DayUsed: usage.rolling30DayUsed,
            usageObservedAt: usage.usageObservedAt,
            fingerprint: usage.fingerprint,
            usesManagerKey: false,
            credentialSource: !usage.fingerprint
              ? ("unconfigured" as const)
              : ("customer" as const),
            keyHealth: usage.keyHealth,
            syncIssueCode: usage.syncIssueCode,
            fetchedAt: usage.fetchedAt,
          };
        },
      );
      // The manager row represents only the manager's current physical Key.
      // A directly configured customer owns a separate pool and must never be
      // added to the manager's Key total.
      const keyPoolTotalUsed = managerUsage.keyPoolTotalUsed;
      const keyPoolLimit = managerUsage.limit;
      const keyPoolWarningRatio = managerUsage.warningRatio;
      return {
        adminId: Number(manager.id),
        displayName:
          manager.displayName?.trim() ||
          manager.username?.trim() ||
          `交付管理员 ${manager.id}`,
        username: manager.username,
        isActive: manager.isActive !== false,
        apiKeyConfigured: latestManagerCredential?.status === "active",
        apiKeyVersion: latestManagerCredential?.version ?? 0,
        keyPool: {
          fingerprint: managerUsage.fingerprint,
          credentialCount: managerUsage.fingerprint ? 1 : 0,
          totalUsed: keyPoolTotalUsed,
          limit: keyPoolLimit,
          warningRatio: keyPoolWarningRatio,
          keyHealth:
            latestManagerCredential?.validationStatus === "invalid" ||
            (!managerUsage.fingerprint && latestManagerCredential)
              ? "invalid_or_revoked"
              : managerUsage.keyHealth,
          syncIssueCode: managerUsage.syncIssueCode,
          keyPoolStale: managerUsage.keyPoolStale,
          keyLastSuccessfulAt: managerUsage.keyLastSuccessfulAt,
          keyLastAttemptAt: managerUsage.keyLastAttemptAt,
          fetchedAt: managerUsage.fetchedAt,
          severity: apiUsageSeverity({
            used: keyPoolTotalUsed ?? 0,
            limit: keyPoolLimit,
            warningRatio: keyPoolWarningRatio,
            syncStatus:
              managerUsage.keyHealth === "connected"
                ? "ok"
                : managerUsage.keyHealth === "unconfigured"
                  ? "unconfigured"
                  : managerUsage.keyHealth === "pending"
                    ? "pending"
                    : "error",
          }),
        },
        rolling30DayUsed: managerUsage.rolling30DayUsed,
        usageObservedAt: managerUsage.usageObservedAt,
        users: managedCustomers,
      };
    }),
  };
}

/** Finalize a claimed snapshot only while its opaque cross-process token wins. */
export async function finalizeApiUsageSnapshotClaim(input: {
  executor: any;
  policy: typeof apiUsagePolicies.$inferSelect;
  credentialFingerprint: string | null;
  used: number;
  accountUsed?: number;
  status: "ok" | "error" | "unconfigured";
  errorCode?: string | null;
  windowStartedAt?: Date;
  now: Date;
  syncToken: string;
}) {
  const existing = await input.executor
    .select()
    .from(apiUsageSnapshots)
    .where(eq(apiUsageSnapshots.policyId, input.policy.id))
    .limit(1);
  const usageValues = usageSnapshotUsageValues({
    status: input.status,
    credentialFingerprint: input.credentialFingerprint,
    used: input.used,
    accountUsed: input.accountUsed ?? input.used,
    existing: existing[0],
  });
  const values = {
    credentialFingerprint: input.credentialFingerprint,
    ...usageValues,
    windowStartedAt:
      input.windowStartedAt ??
      new Date(
        input.now.getTime() -
          DEFAULT_API_USAGE_WINDOW_DAYS * 24 * 60 * 60 * 1_000,
      ),
    // A failed refresh must not erase the last successful pool observation.
    // The sync status and updatedAt still expose the failed attempt separately.
    fetchedAt:
      input.status === "ok" ? input.now : (existing[0]?.fetchedAt ?? null),
    syncStatus: input.status,
    errorCode: input.errorCode?.slice(0, 64) ?? null,
    updatedAt: input.now,
  } as const;
  // The opaque claim token is the complete cross-process CAS identity. Do not
  // also compare the second-precision MySQL TIMESTAMP with the original
  // millisecond Date: MySQL may round that value into the next second and make
  // the rightful claimant silently update zero rows.
  const finalizeConditions = [
    eq(apiUsageSnapshots.policyId, input.policy.id),
    eq(apiUsageSnapshots.syncToken, input.syncToken),
  ];
  const result = await input.executor
    .update(apiUsageSnapshots)
    .set(values)
    .where(and(...finalizeConditions));
  const affectedRows = Number(
    (result as { affectedRows?: unknown } | undefined)?.affectedRows ??
      (result as Array<{ affectedRows?: unknown }> | undefined)?.[0]
        ?.affectedRows ??
      0,
  );
  return affectedRows > 0;
}

export async function claimUsageSnapshotRefresh(input: {
  executor: any;
  policy: Pick<typeof apiUsagePolicies.$inferSelect, "id">;
  now: Date;
}) {
  const syncToken = randomUUID();
  const initial = {
    id: randomUUID(),
    policyId: input.policy.id,
    credentialFingerprint: null,
    used: 0,
    accountUsed: 0,
    windowStartedAt: new Date(
      input.now.getTime() -
        DEFAULT_API_USAGE_WINDOW_DAYS * 24 * 60 * 60 * 1_000,
    ),
    fetchedAt: null,
    syncStatus: "pending" as const,
    errorCode: null,
    syncGeneration: 1,
    syncToken,
    syncStartedAt: input.now,
    createdAt: input.now,
    updatedAt: input.now,
  };
  await input.executor
    .insert(apiUsageSnapshots)
    .values(initial)
    .onDuplicateKeyUpdate({
      set: {
        syncGeneration: sql`${apiUsageSnapshots.syncGeneration} + 1`,
        syncToken,
        syncStartedAt: input.now,
        updatedAt: input.now,
      },
    });
  return syncToken;
}

async function mapWithConcurrency<T>(
  values: readonly T[],
  concurrency: number,
  callback: (value: T) => Promise<void>,
) {
  let cursor = 0;
  await Promise.all(
    Array.from({ length: Math.min(concurrency, values.length) }, async () => {
      while (cursor < values.length) {
        const index = cursor;
        cursor += 1;
        await callback(values[index]!);
      }
    }),
  );
}

type ApiUsageRefreshTimer = { unref?: () => void };

export function createManagedApiUsageRefreshQueue(input: {
  refresh: (
    actor: AuthenticatedUser,
    fingerprints: ReadonlySet<string>,
  ) => Promise<ApiUsageSnapshotSyncResult>;
  retryDelayMs?: number;
  maxRetryDelayMs?: number;
  maxRetryAttempts?: number;
  schedule?: (callback: () => void, delayMs: number) => ApiUsageRefreshTimer;
  onError?: (error: unknown) => void;
}) {
  const pending = new Map<
    string,
    { actor: AuthenticatedUser; retryAttempt: number }
  >();
  const retryDelayMs = input.retryDelayMs ?? 5_000;
  const maxRetryDelayMs = input.maxRetryDelayMs ?? 60_000;
  const maxRetryAttempts = input.maxRetryAttempts ?? 5;
  const schedule =
    input.schedule ??
    ((callback: () => void, delayMs: number) => setTimeout(callback, delayMs));
  let timer: ApiUsageRefreshTimer | null = null;
  let running = false;

  const scheduleDrain = (delayMs: number) => {
    if (timer || running || pending.size === 0) return;
    timer = schedule(() => {
      timer = null;
      void drain();
    }, delayMs);
    timer.unref?.();
  };

  const drain = async () => {
    if (running || pending.size === 0) return;
    running = true;
    const batch = [...pending.entries()];
    pending.clear();
    let retry = false;
    let nextRetryAttempt = 0;
    try {
      const result = await input.refresh(
        batch[0]![1].actor,
        new Set(batch.map(([fingerprint]) => fingerprint)),
      );
      retry =
        result.skipped === "already_running" ||
        Number(result.retryableFailed ?? 0) > 0;
      if (retry) {
        for (const [fingerprint, request] of batch) {
          const retryAttempt = request.retryAttempt + 1;
          nextRetryAttempt = Math.max(nextRetryAttempt, retryAttempt);
          if (retryAttempt > maxRetryAttempts || pending.has(fingerprint)) {
            continue;
          }
          pending.set(fingerprint, { ...request, retryAttempt });
        }
      }
    } catch (error) {
      retry = true;
      for (const [fingerprint, request] of batch) {
        const retryAttempt = request.retryAttempt + 1;
        nextRetryAttempt = Math.max(nextRetryAttempt, retryAttempt);
        if (retryAttempt > maxRetryAttempts || pending.has(fingerprint)) {
          continue;
        }
        pending.set(fingerprint, { ...request, retryAttempt });
      }
      input.onError?.(error);
    } finally {
      running = false;
      const delayMs = retry
        ? Math.min(
            maxRetryDelayMs,
            retryDelayMs * 2 ** Math.max(0, nextRetryAttempt - 1),
          )
        : 0;
      scheduleDrain(delayMs);
    }
  };

  return {
    enqueue(request: { actor: AuthenticatedUser; fingerprint: string }) {
      const fingerprint = request.fingerprint.trim();
      if (!fingerprint) return;
      pending.set(fingerprint, { actor: request.actor, retryAttempt: 0 });
      scheduleDrain(0);
    },
  };
}

async function syncApiUsageSnapshotsUnlocked(
  actor: AuthenticatedUser,
  options: ApiUsageSnapshotSyncOptions = {},
) {
  if (!isSystemAdmin(actor)) {
    throw new AuthServiceError(
      "INVALID_CREDENTIAL",
      "只有系统管理员可以同步 Key 与积分使用情况。",
    );
  }
  const db = await requireDb();
  const [workspaceUsers, allAdministrators, deliveryEngineers] =
    await Promise.all([
      accessibleWorkspaceUsers(actor, db),
      accessibleDeliveryAdmins(actor, db),
      accessibleDeliveryEngineers(actor, db),
    ]);
  const deliveryAdmins = allAdministrators.filter(
    (administrator: any) => administrator.adminAccessLevel === "delivery_admin",
  );
  const systemAdministrators = allAdministrators.filter(
    (administrator: any) => administrator.adminAccessLevel === "system_admin",
  );
  const fingerprints = await usageCredentialFingerprints({
    executor: db,
    userIds: [
      ...workspaceUsers.map((user: any) => user.id),
      ...deliveryAdmins.map((admin: any) => admin.id),
      ...systemAdministrators.map((admin: any) => admin.id),
      ...deliveryEngineers.map((engineer: any) => engineer.id),
    ],
  });
  const now = new Date();
  let synced = 0;
  let failed = 0;
  let retryableFailed = 0;
  if (isSystemAdmin(actor) && options.includeWebsite !== false) {
    const policy = await ensureUsagePolicy({
      executor: db,
      scope: "website_frontend",
      workspaceUserId: null,
    });
    const websiteSyncToken = await claimUsageSnapshotRefresh({
      executor: db,
      policy,
      now,
    });
    if (!fingerprints.website) {
      await finalizeApiUsageSnapshotClaim({
        executor: db,
        policy,
        credentialFingerprint: null,
        used: 0,
        status: "unconfigured",
        now,
        syncToken: websiteSyncToken,
      });
    } else {
      try {
        const usage = await getPresalesCreditUsage(
          DEFAULT_API_USAGE_WINDOW_DAYS,
          now.getTime(),
        );
        const completion = apiUsageSnapshotCompletionState({
          totalComplete: usage.complete,
        });
        const finalized = await finalizeApiUsageSnapshotClaim({
          executor: db,
          policy,
          credentialFingerprint: fingerprints.website,
          used: usage.keyTotalUsed,
          accountUsed: usage.websiteUsed,
          status: completion.status,
          errorCode: completion.errorCode,
          windowStartedAt: new Date(
            getShanghaiRollingUsagePeriod(
              DEFAULT_API_USAGE_WINDOW_DAYS,
              now.getTime(),
            ).startAt,
          ),
          now,
          syncToken: websiteSyncToken,
        });
        if (finalized) {
          synced += 1;
          if (!usage.complete) failed += 1;
        } else {
          failed += 1;
          retryableFailed += 1;
        }
      } catch (error) {
        await finalizeApiUsageSnapshotClaim({
          executor: db,
          policy,
          credentialFingerprint: fingerprints.website,
          used: 0,
          status: "error",
          errorCode: apiUsageSyncErrorCode(error),
          now,
          syncToken: websiteSyncToken,
        });
        failed += 1;
        retryableFailed += 1;
      }
    }
  }
  const deliveryAdminIds: number[] = deliveryAdmins.map((admin: any) =>
    Number(admin.id),
  );
  const systemAdministratorIds: number[] = systemAdministrators.map(
    (administrator: any) => Number(administrator.id),
  );
  const workspaceUserIds: number[] = workspaceUsers.map((user: any) =>
    Number(user.id),
  );
  const deliveryEngineerIds: number[] = deliveryEngineers.map((engineer: any) =>
    Number(engineer.id),
  );
  const allWorkspaceOwnershipRows =
    workspaceUserIds.length === 0
      ? []
      : await db
          .select({
            userId: userUsageOwners.userId,
            deliveryAdminId: userUsageOwners.deliveryAdminId,
          })
          .from(userUsageOwners)
          .where(inArray(userUsageOwners.userId, workspaceUserIds));
  const syncableWorkspaceUserIds = syncableManagedWorkspaceUserIds({
    workspaceUserIds,
    ownershipRows: allWorkspaceOwnershipRows,
    // A customer's usage owner may be either a delivery administrator or a
    // system administrator. Excluding the latter left that customer's policy
    // permanently without a snapshot.
    eligibleOwnerIds: [...deliveryAdminIds, ...systemAdministratorIds],
  });
  const accountIds = [
    ...new Set([
      ...deliveryAdminIds,
      ...systemAdministratorIds,
      ...syncableWorkspaceUserIds,
      ...deliveryEngineerIds,
    ]),
  ];
  const accountIdsByCredential = new Map<
    string,
    {
      fingerprint: string;
      credentialOwnerIds: Set<number>;
      accountIds: number[];
    }
  >();
  const unconfiguredAccountIds: number[] = [];
  for (const accountId of accountIds) {
    const fingerprint = fingerprints.byUser.get(accountId);
    const credentialOwnerId = fingerprints.credentialOwnerByUser.get(accountId);
    if (!fingerprint || !credentialOwnerId) {
      unconfiguredAccountIds.push(accountId);
      continue;
    }
    const poolKey = usageCredentialPoolKey({
      fingerprint,
      credentialId: fingerprints.credentialIdByUser.get(accountId) ?? null,
      credentialVersion:
        fingerprints.credentialVersionByUser.get(accountId) ?? null,
      windowDays: DEFAULT_API_USAGE_WINDOW_DAYS,
    })!;
    const grouped = accountIdsByCredential.get(poolKey) ?? {
      fingerprint,
      credentialOwnerIds: new Set<number>(),
      accountIds: [],
    };
    grouped.credentialOwnerIds.add(credentialOwnerId);
    grouped.accountIds.push(accountId);
    accountIdsByCredential.set(poolKey, grouped);
  }
  const credentialGroups = [...accountIdsByCredential.values()].filter(
    (group) =>
      !options.managedFingerprints ||
      options.managedFingerprints.has(group.fingerprint),
  );
  const selectedUnconfiguredAccountIds = options.managedFingerprints
    ? []
    : unconfiguredAccountIds;
  const selectedAccountIds = [
    ...new Set([
      ...selectedUnconfiguredAccountIds,
      ...credentialGroups.flatMap((group) => group.accountIds),
    ]),
  ];
  const policyEntries = await Promise.all(
    selectedAccountIds.map(async (accountId) => ({
      accountId,
      policy: await ensureUsagePolicy({
        executor: db,
        scope: "managed_user",
        workspaceUserId: accountId,
      }),
    })),
  );
  const policyByAccount = new Map(
    policyEntries.map((entry) => [entry.accountId, entry.policy]),
  );
  await Promise.all(
    selectedUnconfiguredAccountIds.map(async (accountId) => {
      const policy = policyByAccount.get(accountId)!;
      const syncToken = await claimUsageSnapshotRefresh({
        executor: db,
        policy,
        now,
      });
      return finalizeApiUsageSnapshotClaim({
        executor: db,
        policy,
        credentialFingerprint: null,
        used: 0,
        accountUsed: 0,
        status: "unconfigured",
        windowStartedAt: new Date(
          getShanghaiRollingUsagePeriod(
            DEFAULT_API_USAGE_WINDOW_DAYS,
            now.getTime(),
          ).startAt,
        ),
        now,
        syncToken,
      });
    }),
  );
  await mapWithConcurrency(
    credentialGroups,
    API_USAGE_SCAN_CONCURRENCY,
    async ({
      fingerprint,
      credentialOwnerIds,
      accountIds: groupedAccountIds,
    }) => {
      // Claim only the pool that is about to be scanned. With serialized pool
      // scans, claiming every policy up front made later accounts look stuck
      // in "pending" for the duration of unrelated scans.
      const syncTokenByAccount = new Map(
        await Promise.all(
          groupedAccountIds.map(async (accountId) => {
            const policy = policyByAccount.get(accountId)!;
            return [
              accountId,
              await claimUsageSnapshotRefresh({ executor: db, policy, now }),
            ] as const;
          }),
        ),
      );
      try {
        const usage = await getSharedKeyMonthlyCreditUsageForAccounts({
          credentialOwnerIds: [...credentialOwnerIds],
          accountIds: groupedAccountIds,
          poolFingerprint: fingerprint,
          now: now.getTime(),
          windowDays: DEFAULT_API_USAGE_WINDOW_DAYS,
        });
        const completion = apiUsageSnapshotCompletionState({
          totalComplete: usage.complete,
          issueCode: usage.issueCode,
        });
        if (!usage.complete) {
          console.warn("[API usage snapshot] Managed usage scan incomplete", {
            issueCode: completion.errorCode,
            accountCount: groupedAccountIds.length,
          });
        }
        const finalizedClaims = await Promise.all(
          groupedAccountIds.map((accountId) =>
            finalizeApiUsageSnapshotClaim({
              executor: db,
              policy: policyByAccount.get(accountId)!,
              credentialFingerprint: fingerprints.byUser.get(accountId) ?? null,
              used: usage.totalUsed,
              accountUsed: usage.accounts.get(accountId)?.accountUsed ?? 0,
              status: completion.status,
              errorCode: completion.errorCode,
              windowStartedAt: new Date(usage.period.startAt),
              now,
              syncToken: syncTokenByAccount.get(accountId)!,
            }),
          ),
        );
        if (finalizedClaims.every(Boolean)) {
          synced += 1;
          if (!usage.complete) failed += 1;
        } else {
          failed += 1;
          retryableFailed += 1;
        }
      } catch (error) {
        const issueCode = apiUsageSyncErrorCode(error);
        console.warn("[API usage snapshot] Managed usage sync unavailable", {
          issueCode,
          accountCount: groupedAccountIds.length,
        });
        await Promise.all(
          groupedAccountIds.map((accountId) =>
            finalizeApiUsageSnapshotClaim({
              executor: db,
              policy: policyByAccount.get(accountId)!,
              credentialFingerprint: fingerprints.byUser.get(accountId) ?? null,
              used: 0,
              accountUsed: 0,
              status: "error",
              errorCode: issueCode,
              windowStartedAt: new Date(
                getShanghaiRollingUsagePeriod(
                  DEFAULT_API_USAGE_WINDOW_DAYS,
                  now.getTime(),
                ).startAt,
              ),
              now,
              syncToken: syncTokenByAccount.get(accountId)!,
            }),
          ),
        );
        failed += 1;
        retryableFailed += 1;
      }
    },
  );
  return { synced, failed, retryableFailed, finishedAt: Date.now() };
}

export async function syncApiUsageSnapshots(actor: AuthenticatedUser) {
  if (!isSystemAdmin(actor)) {
    throw new AuthServiceError(
      "INVALID_CREDENTIAL",
      "只有系统管理员可以同步 Key 与积分使用情况。",
    );
  }
  return runApiUsageSnapshotSyncWithLock({
    sync: () => syncApiUsageSnapshotsUnlocked(actor),
  });
}

const managedApiUsageRefreshQueue = createManagedApiUsageRefreshQueue({
  refresh: (actor, fingerprints) =>
    runApiUsageSnapshotSyncWithLock({
      sync: () =>
        syncApiUsageSnapshotsUnlocked(actor, {
          includeWebsite: false,
          managedFingerprints: fingerprints,
        }),
    }),
  onError: (error) => {
    console.error(
      "[API usage snapshot] Targeted managed-Key sync failed",
      runtimeErrorForLog(error),
    );
  },
});

function queueManagedApiUsageFingerprintRefresh(input: {
  actor: AuthenticatedUser;
  fingerprint: string;
}) {
  managedApiUsageRefreshQueue.enqueue(input);
}

export async function updateApiUsagePolicy(input: {
  actor: AuthenticatedUser;
  policyId: string;
  limit: number;
  warningRatio: number;
  windowDays: number;
}) {
  if (!isSystemAdmin(input.actor)) {
    throw new AuthServiceError(
      "INVALID_CREDENTIAL",
      "只有系统管理员可以修改 API Key 用量策略。",
    );
  }
  const db = await requireDb();
  const rows = await db
    .select()
    .from(apiUsagePolicies)
    .where(eq(apiUsagePolicies.id, input.policyId))
    .limit(1);
  if (!rows[0]) {
    throw new AuthServiceError("NOT_FOUND", "用量策略不存在。");
  }
  await db
    .update(apiUsagePolicies)
    .set({
      limit: input.limit,
      warningRatioBasisPoints: Math.round(input.warningRatio * 10_000),
      windowDays: DEFAULT_API_USAGE_WINDOW_DAYS,
      updatedAt: new Date(),
    })
    .where(eq(apiUsagePolicies.id, input.policyId));
  return { success: true };
}

export async function startApiUsageSnapshotScheduler() {
  if (process.env.NODE_ENV === "test") return () => undefined;
  const db = await getDb();
  if (!db) {
    console.warn(
      "[API usage snapshot] Scheduler disabled because the database is not configured.",
    );
    return () => undefined;
  }
  const rows = await db
    .select()
    .from(users)
    .where(
      and(
        eq(users.role, "admin"),
        eq(users.adminAccessLevel, "system_admin"),
        eq(users.isActive, true),
      ),
    )
    .limit(1);
  const row = rows[0];
  if (!row?.username) return () => undefined;
  const actor = {
    ...row,
    username: row.username,
    displayName: row.displayName ?? null,
  } as AuthenticatedUser;
  const run = () =>
    syncApiUsageSnapshots(actor).catch((error) => {
      console.error(
        "[API usage snapshot] Scheduled sync failed",
        runtimeErrorForLog(error),
      );
    });
  const initial = setTimeout(run, 10_000);
  initial.unref();
  let stopped = false;
  let dailyTimer: ReturnType<typeof setTimeout> | null = null;
  const scheduleDaily = () => {
    if (stopped) return;
    dailyTimer = setTimeout(async () => {
      await run();
      scheduleDaily();
    }, millisecondsUntilNextShanghaiUsageSync());
    dailyTimer.unref();
  };
  scheduleDaily();
  return () => {
    stopped = true;
    clearTimeout(initial);
    if (dailyTimer) clearTimeout(dailyTimer);
  };
}

/** Asia/Shanghai has no daylight-saving transition, so UTC+08 is stable. */
export function millisecondsUntilNextShanghaiUsageSync(nowMs = Date.now()) {
  const hourMs = 60 * 60 * 1_000;
  const dayMs = 24 * hourMs;
  const shanghaiNow = nowMs + 8 * hourMs;
  const localDayStart = Math.floor(shanghaiNow / dayMs) * dayMs;
  let nextLocal = localDayStart + 3 * hourMs;
  if (nextLocal <= shanghaiNow) nextLocal += dayMs;
  return nextLocal - shanghaiNow;
}
