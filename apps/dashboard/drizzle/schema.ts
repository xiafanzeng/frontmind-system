import { sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  check,
  foreignKey,
  index,
  int,
  json,
  longtext,
  mysqlEnum,
  mysqlTable,
  text,
  timestamp,
  uniqueIndex,
  varchar,
} from "drizzle-orm/mysql-core";
import type {
  ConfirmedResponseLogic,
  ResponseLogicDraft,
} from "../shared/response-logic";
import type { ManualServiceContractProfile } from "../shared/manual-service-order";

export type WorkspaceQuestionEvidenceRecord = {
  documentPath: string;
  excerpt: string;
  relevance: string;
};

/**
 * Internal FrontMind accounts. Legacy OAuth columns remain nullable so an
 * existing deployment can migrate before its users are converted to local
 * username/password accounts.
 */
export const users = mysqlTable(
  "users",
  {
    id: int("id").autoincrement().primaryKey(),
    openId: varchar("openId", { length: 64 }).unique(),
    username: varchar("username", { length: 64 }).unique(),
    passwordHash: varchar("passwordHash", { length: 255 }),
    displayName: varchar("displayName", { length: 128 }),
    // Legacy profile fields retained for a safe additive migration.
    name: text("name"),
    email: varchar("email", { length: 320 }),
    loginMethod: varchar("loginMethod", { length: 64 }),
    role: mysqlEnum("role", ["user", "admin", "delivery_member"])
      .default("user")
      .notNull(),
    adminAccessLevel: mysqlEnum("adminAccessLevel", [
      "system_admin",
      "delivery_admin",
    ]),
    engineerRoleType: mysqlEnum("engineerRoleType", [
      "ai_operations_engineer",
      "monitoring_optimization_engineer",
      "content_distribution_engineer",
    ]),
    marketEdition: mysqlEnum("marketEdition", ["domestic", "overseas"])
      .default("domestic")
      .notNull(),
    isActive: boolean("isActive").default(true).notNull(),
    passwordChangedAt: timestamp("passwordChangedAt"),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
    updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
    lastSignedIn: timestamp("lastSignedIn"),
  },
  (table) => [
    index("users_active_role_idx").on(table.isActive, table.role),
    check(
      "users_engineer_role_consistency_ck",
      sql`(
        (${table.role} = 'delivery_member' AND ${table.engineerRoleType} IS NOT NULL)
        OR
        (${table.role} <> 'delivery_member' AND ${table.engineerRoleType} IS NULL)
      )`,
    ),
  ],
);

/** Only a SHA-256 hash of the opaque browser token is persisted. */
export const sessions = mysqlTable(
  "sessions",
  {
    id: varchar("id", { length: 36 }).primaryKey(),
    userId: int("userId")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    tokenHash: varchar("tokenHash", { length: 64 }).notNull().unique(),
    expiresAt: timestamp("expiresAt").notNull(),
    lastSeenAt: timestamp("lastSeenAt").defaultNow().notNull(),
    revokedAt: timestamp("revokedAt"),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
  },
  (table) => [
    index("sessions_user_expires_idx").on(table.userId, table.expiresAt),
    index("sessions_token_active_idx").on(table.tokenHash, table.revokedAt),
  ],
);

/**
 * One-time activation links issued when a system administrator creates a
 * customer account. Only the SHA-256 token hash is persisted.
 */
export const userPasswordSetupTokens = mysqlTable(
  "user_password_setup_tokens",
  {
    id: varchar("id", { length: 36 }).primaryKey(),
    userId: int("userId")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    tokenHash: varchar("tokenHash", { length: 64 }).notNull().unique(),
    expiresAt: timestamp("expiresAt").notNull(),
    consumedAt: timestamp("consumedAt"),
    createdByUserId: int("createdByUserId").references(() => users.id, {
      onDelete: "set null",
    }),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
    updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
  },
  (table) => [
    index("user_password_setup_tokens_user_expires_idx").on(
      table.userId,
      table.expiresAt,
    ),
    index("user_password_setup_tokens_hash_consumed_idx").on(
      table.tokenHash,
      table.consumedAt,
    ),
  ],
);

/**
 * Versioned upstream credentials. encryptedKey is AES-256-GCM ciphertext;
 * iv and authTag are stored separately and are never returned to a browser.
 */
export const apiCredentials = mysqlTable(
  "api_credentials",
  {
    id: varchar("id", { length: 36 }).primaryKey(),
    userId: int("userId")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    version: int("version").notNull(),
    encryptionVersion: int("encryptionVersion").default(1).notNull(),
    encryptedKey: text("encryptedKey").notNull(),
    encryptionIv: varchar("encryptionIv", { length: 32 }).notNull(),
    encryptionAuthTag: varchar("encryptionAuthTag", { length: 32 }).notNull(),
    fingerprint: varchar("fingerprint", { length: 32 }).notNull(),
    status: mysqlEnum("status", ["active", "retired", "deleted"])
      .default("active")
      .notNull(),
    validationStatus: mysqlEnum("validationStatus", [
      "unverified",
      "verified",
      "invalid",
    ])
      .default("unverified")
      .notNull(),
    verifiedAt: timestamp("verifiedAt"),
    retiredAt: timestamp("retiredAt"),
    deletedAt: timestamp("deletedAt"),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
    updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
  },
  (table) => [
    uniqueIndex("api_credentials_user_version_uq").on(
      table.userId,
      table.version,
    ),
    index("api_credentials_user_status_idx").on(table.userId, table.status),
  ],
);

/**
 * Service-wide API credentials used exclusively by the website presales
 * experience.  This is intentionally separate from apiCredentials: there is
 * one logical `website` slot, while immutable credential versions keep
 * already-created upstream resources usable after a key rotation.
 */
export const presalesApiCredentials = mysqlTable(
  "presales_api_credentials",
  {
    id: varchar("id", { length: 36 }).primaryKey(),
    slot: varchar("slot", { length: 32 }).default("website").notNull(),
    version: int("version").notNull(),
    encryptionVersion: int("encryptionVersion").default(1).notNull(),
    encryptedKey: text("encryptedKey").notNull(),
    encryptionIv: varchar("encryptionIv", { length: 32 }).notNull(),
    encryptionAuthTag: varchar("encryptionAuthTag", { length: 32 }).notNull(),
    fingerprint: varchar("fingerprint", { length: 32 }).notNull(),
    status: mysqlEnum("status", ["active", "retired", "deleted"])
      .default("active")
      .notNull(),
    validationStatus: mysqlEnum("validationStatus", [
      "unverified",
      "verified",
      "invalid",
    ])
      .default("unverified")
      .notNull(),
    createdByUserId: int("createdByUserId").references(() => users.id, {
      onDelete: "set null",
    }),
    verifiedAt: timestamp("verifiedAt"),
    retiredAt: timestamp("retiredAt"),
    deletedAt: timestamp("deletedAt"),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
    updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
  },
  (table) => [
    uniqueIndex("presales_api_credentials_slot_version_uq").on(
      table.slot,
      table.version,
    ),
    index("presales_api_credentials_slot_status_idx").on(
      table.slot,
      table.status,
    ),
  ],
);

/**
 * Credit limits are assigned to the website scope or to an individual managed
 * account. Multiple managed accounts may intentionally share the same upstream
 * API Key while retaining independent account budgets.
 */
export const apiUsagePolicies = mysqlTable(
  "api_usage_policies",
  {
    id: varchar("id", { length: 36 }).primaryKey(),
    policyKey: varchar("policyKey", { length: 96 }).notNull().unique(),
    scope: mysqlEnum("scope", ["website_frontend", "managed_user"]).notNull(),
    workspaceUserId: int("workspaceUserId").references(() => users.id, {
      onDelete: "cascade",
    }),
    limit: int("limit", { unsigned: true }).default(230_000).notNull(),
    warningRatioBasisPoints: int("warningRatioBasisPoints", { unsigned: true })
      .default(8_000)
      .notNull(),
    windowDays: int("windowDays", { unsigned: true }).default(30).notNull(),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
    updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
  },
  (table) => [
    index("api_usage_policies_scope_user_idx").on(
      table.scope,
      table.workspaceUserId,
    ),
  ],
);

/**
 * Dashboard reads are snapshot-only. Upstream task APIs are queried by the
 * scheduler/sync job, never serially while rendering the administrator home.
 */
export const apiUsageSnapshots = mysqlTable(
  "api_usage_snapshots",
  {
    id: varchar("id", { length: 36 }).primaryKey(),
    policyId: varchar("policyId", { length: 36 })
      .notNull()
      .references(() => apiUsagePolicies.id, { onDelete: "cascade" }),
    credentialFingerprint: varchar("credentialFingerprint", { length: 32 }),
    /** Whole shared Key pool usage observed upstream for the active period. */
    used: int("used", { unsigned: true }).default(0).notNull(),
    /** Usage attributed by the local ownership ledger to this policy's user. */
    accountUsed: int("accountUsed", { unsigned: true }).default(0).notNull(),
    windowStartedAt: timestamp("windowStartedAt").notNull(),
    fetchedAt: timestamp("fetchedAt"),
    syncStatus: mysqlEnum("syncStatus", [
      "pending",
      "ok",
      "error",
      "unconfigured",
    ])
      .default("pending")
      .notNull(),
    errorCode: varchar("errorCode", { length: 64 }),
    /** Monotonic cross-process claim for one policy refresh. */
    syncGeneration: int("syncGeneration", { unsigned: true })
      .default(0)
      .notNull(),
    /** Only the holder of the latest token may finalize a refresh. */
    syncToken: varchar("syncToken", { length: 36 }),
    syncStartedAt: timestamp("syncStartedAt"),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
    updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
  },
  (table) => [
    uniqueIndex("api_usage_snapshots_policy_uq").on(table.policyId),
    index("api_usage_snapshots_status_fetched_idx").on(
      table.syncStatus,
      table.fetchedAt,
    ),
    index("api_usage_snapshots_sync_claim_idx").on(
      table.syncToken,
      table.syncStartedAt,
    ),
  ],
);

/** Immutable task-level usage facts retained across API Key rotations. */
export const apiUsageTaskLedger = mysqlTable(
  "api_usage_task_ledger",
  {
    id: varchar("id", { length: 36 }).primaryKey(),
    scope: mysqlEnum("scope", ["managed_user", "website_frontend"]).notNull(),
    upstreamTaskId: varchar("upstreamTaskId", { length: 255 }).notNull(),
    credentialFingerprint: varchar("credentialFingerprint", {
      length: 32,
    }).notNull(),
    apiCredentialId: varchar("apiCredentialId", { length: 36 }),
    accountUserId: int("accountUserId").references(() => users.id, {
      onDelete: "set null",
    }),
    isFirstParty: boolean("isFirstParty").default(false).notNull(),
    taskCreatedAtMs: bigint("taskCreatedAtMs", {
      mode: "number",
      unsigned: true,
    }).notNull(),
    creditUsage: bigint("creditUsage", { mode: "number", unsigned: true })
      .default(0)
      .notNull(),
    isTerminal: boolean("isTerminal").default(false).notNull(),
    observedAt: timestamp("observedAt").notNull(),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
    updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
  },
  (table) => [
    uniqueIndex("api_usage_task_ledger_scope_task_uq").on(
      table.scope,
      table.upstreamTaskId,
    ),
    index("api_usage_task_ledger_account_time_idx").on(
      table.accountUserId,
      table.taskCreatedAtMs,
    ),
    index("api_usage_task_ledger_pool_time_idx").on(
      table.scope,
      table.credentialFingerprint,
      table.taskCreatedAtMs,
    ),
  ],
);

/** Proves that one physical Key was fully scanned before it became unusable. */
export const apiUsageCredentialCoverage = mysqlTable(
  "api_usage_credential_coverage",
  {
    id: varchar("id", { length: 36 }).primaryKey(),
    scope: mysqlEnum("scope", ["managed_user", "website_frontend"]).notNull(),
    credentialFingerprint: varchar("credentialFingerprint", {
      length: 32,
    }).notNull(),
    coveredFromMs: bigint("coveredFromMs", {
      mode: "number",
      unsigned: true,
    }).notNull(),
    fullScanAtMs: bigint("fullScanAtMs", {
      mode: "number",
      unsigned: true,
    }).notNull(),
    credentialRetiredAtMs: bigint("credentialRetiredAtMs", {
      mode: "number",
      unsigned: true,
    }),
    allTasksSettled: boolean("allTasksSettled").default(false).notNull(),
    scanGeneration: int("scanGeneration", { unsigned: true })
      .default(0)
      .notNull(),
    scanToken: varchar("scanToken", { length: 36 }),
    scanStartedAtMs: bigint("scanStartedAtMs", {
      mode: "number",
      unsigned: true,
    }),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
    updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
  },
  (table) => [
    uniqueIndex("api_usage_credential_coverage_scope_fp_uq").on(
      table.scope,
      table.credentialFingerprint,
    ),
    index("api_usage_credential_coverage_scan_idx").on(
      table.scope,
      table.fullScanAtMs,
    ),
    index("api_usage_credential_coverage_claim_idx").on(
      table.scanToken,
      table.scanStartedAtMs,
    ),
  ],
);

/** Ownership boundary for every task/file reachable through the presales API. */
export const presalesUpstreamResources = mysqlTable(
  "presales_upstream_resources",
  {
    id: varchar("id", { length: 36 }).primaryKey(),
    apiCredentialId: varchar("apiCredentialId", { length: 36 }).notNull(),
    kind: mysqlEnum("kind", ["task", "file"]).notNull(),
    upstreamId: varchar("upstreamId", { length: 255 }).notNull(),
    parentTaskId: varchar("parentTaskId", { length: 255 }),
    /**
     * Explicit provenance for file bytes. Legacy rows remain null until an
     * authenticated upload or task-output path can classify them safely.
     */
    contentSource: mysqlEnum("contentSource", [
      "user_upload",
      "assistant_output",
    ]),
    uploadReservedAt: timestamp("uploadReservedAt"),
    uploadedAt: timestamp("uploadedAt"),
    contentExpiresAt: timestamp("contentExpiresAt"),
    contentDeletedAt: timestamp("contentDeletedAt"),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
  },
  (table) => [
    foreignKey({
      name: "presales_resources_credential_fk",
      columns: [table.apiCredentialId],
      foreignColumns: [presalesApiCredentials.id],
    }).onDelete("restrict"),
    uniqueIndex("presales_upstream_resources_kind_id_uq").on(
      table.kind,
      table.upstreamId,
    ),
    index("presales_upstream_resources_parent_task_idx").on(table.parentTaskId),
    index("presales_upstream_resources_content_expiry_idx").on(
      table.kind,
      table.contentSource,
      table.uploadReservedAt,
      table.contentExpiresAt,
      table.contentDeletedAt,
      table.id,
    ),
  ],
);

/**
 * Hash-only grants for external URLs emitted by trusted upstream output-file
 * records. Signed query strings are never persisted in plaintext.
 */
export const presalesOutputUrls = mysqlTable(
  "presales_output_urls",
  {
    id: varchar("id", { length: 36 }).primaryKey(),
    apiCredentialId: varchar("apiCredentialId", { length: 36 }).notNull(),
    parentTaskId: varchar("parentTaskId", { length: 255 }).notNull(),
    urlHash: varchar("urlHash", { length: 64 }).notNull(),
    hostname: varchar("hostname", { length: 255 }).notNull(),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
  },
  (table) => [
    foreignKey({
      name: "presales_output_credential_fk",
      columns: [table.apiCredentialId],
      foreignColumns: [presalesApiCredentials.id],
    }).onDelete("restrict"),
    uniqueIndex("presales_output_urls_task_hash_uq").on(
      table.parentTaskId,
      table.urlHash,
    ),
    index("presales_output_urls_credential_task_idx").on(
      table.apiCredentialId,
      table.parentTaskId,
    ),
  ],
);

/**
 * Cross-process task creation reservations. Only SHA-256 hashes of caller
 * idempotency keys are stored; a short lease permits safe recovery after a
 * worker exits while a request is pending.
 */
export const presalesTaskRequests = mysqlTable(
  "presales_task_requests",
  {
    id: varchar("id", { length: 36 }).primaryKey(),
    projectId: varchar("projectId", { length: 80 }),
    keyHash: varchar("keyHash", { length: 64 }).notNull(),
    requestHash: varchar("requestHash", { length: 64 }).notNull(),
    apiCredentialId: varchar("apiCredentialId", { length: 36 }).notNull(),
    credentialVersion: int("credentialVersion").notNull(),
    status: mysqlEnum("status", ["pending", "completed"])
      .default("pending")
      .notNull(),
    attemptId: varchar("attemptId", { length: 36 }).notNull(),
    leaseExpiresAt: timestamp("leaseExpiresAt").notNull(),
    upstreamTaskId: varchar("upstreamTaskId", { length: 255 }),
    completedAt: timestamp("completedAt"),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
    updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
  },
  (table) => [
    foreignKey({
      name: "presales_task_request_credential_fk",
      columns: [table.apiCredentialId],
      foreignColumns: [presalesApiCredentials.id],
    }).onDelete("restrict"),
    uniqueIndex("presales_task_requests_key_uq").on(table.keyHash),
    index("presales_task_requests_credential_status_idx").on(
      table.apiCredentialId,
      table.status,
    ),
    index("presales_task_requests_project_idx").on(table.projectId),
  ],
);

/**
 * Durable, billable answer-monitoring runs created by the website gateway.
 *
 * The idempotency key is stored only as a SHA-256 digest.  A run row is written
 * before the remote POST and is never recycled after an ambiguous submission,
 * which prevents a browser retry from creating a second paid batch.  Poll
 * leases and nextPollAt provide a cross-process 300-second polling gate.
 */
export const presalesMonitorRuns = mysqlTable(
  "presales_monitor_runs",
  {
    id: varchar("id", { length: 36 }).primaryKey(),
    idempotencyKeyHash: varchar("idempotencyKeyHash", { length: 64 })
      .notNull()
      .unique(),
    requestHash: varchar("requestHash", { length: 64 }).notNull(),
    apiCredentialId: varchar("apiCredentialId", { length: 36 }).notNull(),
    credentialVersion: int("credentialVersion").notNull(),
    question: text("question").notNull(),
    platforms: json("platforms").$type<string[]>().notNull(),
    expectedItems: int("expectedItems").notNull(),
    status: mysqlEnum("status", [
      "submission_in_progress",
      "submission_unknown",
      "submitted",
      "polling",
      "completed",
      "partial_review_required",
      "remote_failed",
      "shape_mismatch",
    ])
      .default("submission_in_progress")
      .notNull(),
    upstreamTaskId: varchar("upstreamTaskId", { length: 128 }),
    submitTotalItems: int("submitTotalItems"),
    initialSubtaskIds: json("initialSubtaskIds").$type<string[]>(),
    subtaskScopes:
      json("subtaskScopes").$type<
        Record<string, { platform: string; runIndex: number }>
      >(),
    remoteStatus: varchar("remoteStatus", { length: 64 }),
    completedItems: int("completedItems").default(0).notNull(),
    failedItems: int("failedItems").default(0).notNull(),
    totalItems: int("totalItems"),
    checkpoint: json("checkpoint").$type<Record<string, unknown>>(),
    finalResult: json("finalResult").$type<Record<string, unknown>>(),
    shapeMismatch: boolean("shapeMismatch").default(false).notNull(),
    terminalSnapshotHash: varchar("terminalSnapshotHash", { length: 64 }),
    terminalStableCount: int("terminalStableCount").default(0).notNull(),
    lastError: text("lastError"),
    nextPollAt: timestamp("nextPollAt"),
    lastPollStartedAt: timestamp("lastPollStartedAt"),
    pollLeaseId: varchar("pollLeaseId", { length: 36 }),
    pollLeaseExpiresAt: timestamp("pollLeaseExpiresAt"),
    submittedAt: timestamp("submittedAt"),
    completedAt: timestamp("completedAt"),
    deletedAt: timestamp("deletedAt"),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
    updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
  },
  (table) => [
    index("presales_monitor_credential_status_idx").on(
      table.apiCredentialId,
      table.status,
    ),
    index("presales_monitor_poll_idx").on(table.status, table.nextPollAt),
  ],
);

/**
 * Append-only, hash-bound evidence for successful website payments. The
 * browser authorization itself is never stored: only its SHA-256 digest is
 * retained, and there is deliberately no update timestamp or mutable status.
 */
export const websitePaymentReceipts = mysqlTable(
  "website_payment_receipts",
  {
    orderId: varchar("orderId", { length: 128 }).primaryKey(),
    schemaVersion: int("schemaVersion", { unsigned: true })
      .default(1)
      .notNull(),
    tradeNo: varchar("tradeNo", { length: 128 }).notNull().unique(),
    amountFen: int("amountFen", { unsigned: true }).notNull(),
    paidAt: timestamp("paidAt", { fsp: 3 }).notNull(),
    purchaseType: mysqlEnum("purchaseType", [
      "monitoring",
      "service",
    ]).notNull(),
    scopeHash: varchar("scopeHash", { length: 64 }).notNull(),
    authorizationDigest: varchar("authorizationDigest", {
      length: 64,
    }).notNull(),
    reviewRequired: boolean("reviewRequired").notNull(),
    createdAt: timestamp("createdAt", { fsp: 3 })
      .default(sql`CURRENT_TIMESTAMP(3)`)
      .notNull(),
  },
  (table) => [
    index("website_payment_receipts_scope_idx").on(
      table.scopeHash,
      table.authorizationDigest,
    ),
    check(
      "website_payment_receipts_schema_version_ck",
      sql`${table.schemaVersion} = 1`,
    ),
    check(
      "website_payment_receipts_amount_ck",
      sql`${table.amountFen} > 0 AND ${table.amountFen} <= 10000000`,
    ),
    check(
      "website_payment_receipts_scope_hash_ck",
      sql`${table.scopeHash} REGEXP '^[a-f0-9]{64}$'`,
    ),
    check(
      "website_payment_receipts_authorization_digest_ck",
      sql`${table.authorizationDigest} REGEXP '^[a-f0-9]{64}$'`,
    ),
  ],
);

/**
 * Mutable, durable lifecycle registry for every website checkout. DELETE
 * decisions query this table by stable projectId, so protection survives
 * Website restarts, multiple instances, and replayed older project tokens.
 * The payment authorization and browser session are never persisted: the
 * Website first enforces openOwnedProject, then this internal API authenticates
 * the Website with the provisioning service token.
 */
export const websiteProjectOrders = mysqlTable(
  "website_project_orders",
  {
    orderId: varchar("orderId", { length: 128 }).primaryKey(),
    schemaVersion: int("schemaVersion", { unsigned: true })
      .default(1)
      .notNull(),
    projectId: varchar("projectId", { length: 80 }).notNull(),
    purchaseType: mysqlEnum("purchaseType", [
      "monitoring",
      "service",
    ]).notNull(),
    amountFen: int("amountFen", { unsigned: true }).notNull(),
    authorizationDigest: varchar("authorizationDigest", {
      length: 64,
    })
      .notNull()
      .unique(),
    state: mysqlEnum("state", [
      "pending",
      "paid",
      "fulfilling",
      "fulfilled",
      "review_required",
      "terminal_failed",
      "closed",
    ]).notNull(),
    checkoutExpiresAt: timestamp("checkoutExpiresAt", { fsp: 3 }).notNull(),
    paidAt: timestamp("paidAt", { fsp: 3 }),
    fulfilledAt: timestamp("fulfilledAt", { fsp: 3 }),
    lastEventAt: timestamp("lastEventAt", { fsp: 3 }).notNull(),
    revision: int("revision", { unsigned: true }).default(1).notNull(),
    // drizzle-kit 0.31 renders onUpdateNow without the column fsp, so migration
    // 0032 must keep its ON UPDATE clause pinned to CURRENT_TIMESTAMP(3).
    createdAt: timestamp("createdAt", { fsp: 3 })
      .default(sql`CURRENT_TIMESTAMP(3)`)
      .notNull(),
    updatedAt: timestamp("updatedAt", { fsp: 3 })
      .default(sql`CURRENT_TIMESTAMP(3)`)
      .onUpdateNow()
      .notNull(),
  },
  (table) => [
    index("website_project_orders_project_state_idx").on(
      table.projectId,
      table.state,
    ),
    check(
      "website_project_orders_schema_version_ck",
      sql`${table.schemaVersion} = 1`,
    ),
    check(
      "website_project_orders_amount_ck",
      sql`${table.amountFen} > 0 AND ${table.amountFen} <= 10000000`,
    ),
    check(
      "website_project_orders_authorization_digest_ck",
      sql`${table.authorizationDigest} REGEXP '^[a-f0-9]{64}$'`,
    ),
    check("website_project_orders_revision_ck", sql`${table.revision} > 0`),
    check(
      "website_project_orders_paid_state_ck",
      sql`${table.state} IN ('pending', 'closed') OR ${table.paidAt} IS NOT NULL`,
    ),
    check(
      "website_project_orders_fulfilled_state_ck",
      sql`(${table.state} = 'fulfilled' AND ${table.fulfilledAt} IS NOT NULL) OR (${table.state} <> 'fulfilled' AND ${table.fulfilledAt} IS NULL)`,
    ),
    check(
      "website_project_orders_fulfilled_time_ck",
      sql`${table.fulfilledAt} IS NULL OR (${table.paidAt} IS NOT NULL AND ${table.fulfilledAt} >= ${table.paidAt})`,
    ),
  ],
);

/**
 * Durable audit and idempotency boundary for website-paid account
 * provisioning. The caller's idempotency key is stored only as SHA-256 and
 * the request hash is an HMAC produced by the Agent service. Passwords and
 * service tokens are never persisted in this table.
 */
export const websiteUserProvisions = mysqlTable(
  "website_user_provisions",
  {
    id: varchar("id", { length: 36 }).primaryKey(),
    schemaVersion: int("schemaVersion", { unsigned: true })
      .default(1)
      .notNull(),
    idempotencyKeyHash: varchar("idempotencyKeyHash", { length: 64 })
      .notNull()
      .unique(),
    requestHash: varchar("requestHash", { length: 64 }).notNull(),
    projectId: varchar("projectId", { length: 80 }).notNull(),
    companyName: varchar("companyName", { length: 200 }).notNull(),
    orderId: varchar("orderId", { length: 64 }).notNull().unique(),
    tradeNo: varchar("tradeNo", { length: 128 }).notNull().unique(),
    amountFen: int("amountFen", { unsigned: true }).notNull(),
    paidAt: timestamp("paidAt").notNull(),
    serviceCategory: mysqlEnum("serviceCategory", [
      "product_scenario",
      "reputation",
      "competitor_comparison",
    ]).notNull(),
    planCode: mysqlEnum("planCode", ["basic", "advanced", "luxury"]),
    questionId: varchar("questionId", { length: 80 }).notNull(),
    question: text("question").notNull(),
    contractId: varchar("contractId", { length: 128 }).unique(),
    contractTemplateVersion: varchar("contractTemplateVersion", {
      length: 64,
    }).notNull(),
    contractDocumentSha256: varchar("contractDocumentSha256", {
      length: 64,
    }).notNull(),
    contractEvidence: json("contractEvidence").$type<Record<string, unknown>>(),
    contractConfirmationStatus: mysqlEnum("contractConfirmationStatus", [
      "confirmed",
      "pending_confirmation",
      "rejected",
    ])
      .default("confirmed")
      .notNull(),
    contractSignedAt: timestamp("contractSignedAt"),
    signatoryId: varchar("signatoryId", { length: 128 }),
    requestedUsername: varchar("requestedUsername", { length: 64 }).notNull(),
    requestedDisplayName: varchar("requestedDisplayName", {
      length: 128,
    }).notNull(),
    accountMode: mysqlEnum("accountMode", ["create", "bind_existing"])
      .default("create")
      .notNull(),
    purchaseIntentId: varchar("purchaseIntentId", { length: 36 }).references(
      () => purchaseIntents.id,
      { onDelete: "set null" },
    ),
    userId: int("userId").references(() => users.id, {
      onDelete: "set null",
    }),
    status: mysqlEnum("status", [
      "pending_confirmation",
      "pending",
      "completed",
      "failed",
    ])
      .default("pending")
      .notNull(),
    accountSetupTokenHash: varchar("accountSetupTokenHash", {
      length: 64,
    }).unique(),
    accountSetupTokenExpiresAt: timestamp("accountSetupTokenExpiresAt"),
    accountSetupTokenConsumedAt: timestamp("accountSetupTokenConsumedAt"),
    lastError: text("lastError"),
    completedAt: timestamp("completedAt"),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
    updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
  },
  (table) => [
    index("website_user_provisions_project_idx").on(table.projectId),
    index("website_user_provisions_user_idx").on(table.userId),
    index("website_user_provisions_status_idx").on(table.status),
    index("website_user_provisions_purchase_intent_idx").on(
      table.purchaseIntentId,
    ),
  ],
);

/**
 * Durable, signing-first order boundary for website purchases that require a
 * system administrator to initiate an external signature before payment.
 *
 * The browser only receives the opaque id. External signing and storage URLs
 * are never treated as evidence: the signed artifact identifiers and SHA-256
 * digests are recorded separately, and the v2 provisioning ledger is created
 * only after the website service has submitted a verified payment receipt.
 */
export const websiteManualServiceOrders = mysqlTable(
  "website_manual_service_orders",
  {
    id: varchar("id", { length: 36 }).primaryKey(),
    schemaVersion: int("schemaVersion", { unsigned: true })
      .default(1)
      .notNull(),
    idempotencyKeyHash: varchar("idempotencyKeyHash", { length: 64 })
      .notNull()
      .unique(),
    requestHash: varchar("requestHash", { length: 64 }).notNull(),
    projectId: varchar("projectId", { length: 80 }).notNull(),
    companyName: varchar("companyName", { length: 200 }).notNull(),
    contractProfile: json("contractProfile")
      .$type<ManualServiceContractProfile>()
      .notNull(),
    serviceCategory: mysqlEnum("serviceCategory", [
      "product_scenario",
      "reputation",
      "competitor_comparison",
    ]).notNull(),
    planCode: mysqlEnum("planCode", ["basic"]).default("basic").notNull(),
    serviceDays: int("serviceDays", { unsigned: true }).default(30).notNull(),
    questionId: varchar("questionId", { length: 80 }).notNull(),
    question: text("question").notNull(),
    amountFen: int("amountFen", { unsigned: true }),
    contractTemplateVersion: varchar("contractTemplateVersion", {
      length: 64,
    }).notNull(),
    externalContractId: varchar("externalContractId", {
      length: 128,
    }).unique(),
    signingUrl: varchar("signingUrl", { length: 2048 }),
    signedPdfFileId: varchar("signedPdfFileId", { length: 255 }).unique(),
    signedPdfFilename: varchar("signedPdfFilename", { length: 512 }),
    signedPdfSha256: varchar("signedPdfSha256", { length: 64 }),
    evidenceReportFileId: varchar("evidenceReportFileId", {
      length: 255,
    }),
    evidenceReportFilename: varchar("evidenceReportFilename", { length: 512 }),
    evidenceReportSha256: varchar("evidenceReportSha256", { length: 64 }),
    signedAt: timestamp("signedAt"),
    signatoryId: varchar("signatoryId", { length: 128 }),
    signatureNote: text("signatureNote"),
    contractAuthorizationMode: mysqlEnum("contractAuthorizationMode", [
      "external_wechat",
    ]),
    contractAuthorizationEventReference: varchar(
      "contractAuthorizationEventReference",
      { length: 128 },
    ).unique("manual_orders_contract_auth_event_uq"),
    contractAuthorizedAt: timestamp("contractAuthorizedAt"),
    paymentIdempotencyKeyHash: varchar("paymentIdempotencyKeyHash", {
      length: 64,
    }).unique(),
    paymentRequestHash: varchar("paymentRequestHash", { length: 64 }),
    paymentOrderId: varchar("paymentOrderId", { length: 64 }).unique(),
    paymentTradeNo: varchar("paymentTradeNo", { length: 128 }).unique(),
    paidAt: timestamp("paidAt"),
    accountSetupIdempotencyKeyHash: varchar("accountSetupIdempotencyKeyHash", {
      length: 64,
    }).unique(),
    accountSetupRequestHash: varchar("accountSetupRequestHash", { length: 64 }),
    accountMode: mysqlEnum("accountMode", ["create", "bind_existing"]),
    requestedUsername: varchar("requestedUsername", { length: 64 }),
    requestedDisplayName: varchar("requestedDisplayName", { length: 128 }),
    requestedPasswordHash: varchar("requestedPasswordHash", { length: 255 }),
    provisioningReference: varchar("provisioningReference", {
      length: 128,
    }).unique(),
    status: mysqlEnum("status", [
      "pending_admin",
      "signature_required",
      "payment_required",
      "account_setup_required",
      "activation_required",
      "active",
      "rejected",
      "failed",
    ])
      .default("pending_admin")
      .notNull(),
    preparedByUserId: int("preparedByUserId").references(() => users.id, {
      onDelete: "set null",
    }),
    signedByUserId: int("signedByUserId").references(() => users.id, {
      onDelete: "set null",
    }),
    activatedByUserId: int("activatedByUserId").references(() => users.id, {
      onDelete: "set null",
    }),
    rejectedByUserId: int("rejectedByUserId").references(() => users.id, {
      onDelete: "set null",
    }),
    preparedAt: timestamp("preparedAt"),
    accountSetupAt: timestamp("accountSetupAt"),
    activatedAt: timestamp("activatedAt"),
    rejectedAt: timestamp("rejectedAt"),
    lastError: text("lastError"),
    revision: int("revision", { unsigned: true }).default(1).notNull(),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
    updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
  },
  (table) => [
    index("manual_service_orders_project_idx").on(table.projectId),
    index("manual_service_orders_status_created_idx").on(
      table.status,
      table.createdAt,
    ),
    index("manual_service_orders_payment_idx").on(
      table.paymentOrderId,
      table.paymentTradeNo,
    ),
  ],
);

/**
 * Versioned service contracts for a user workspace.
 *
 * Expiration is derived from endsAt at read time; rows are never rewritten to
 * an "expired" state by a background job. A replacement contract supersedes
 * the previous row and increments the per-user revision.
 */
export const serviceContracts = mysqlTable(
  "service_contracts",
  {
    id: varchar("id", { length: 36 }).primaryKey(),
    userId: int("userId")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    planCode: mysqlEnum("planCode", ["basic", "advanced", "luxury"]).notNull(),
    planVersion: int("planVersion", { unsigned: true }).default(1).notNull(),
    status: mysqlEnum("status", [
      "pending_confirmation",
      "scheduled",
      "active",
      "suspended",
      "cancelled",
      "superseded",
    ])
      .default("active")
      .notNull(),
    startsAt: timestamp("startsAt").notNull(),
    endsAt: timestamp("endsAt").notNull(),
    source: mysqlEnum("source", ["website", "offline", "admin"])
      .default("admin")
      .notNull(),
    amountFen: int("amountFen", { unsigned: true }),
    currency: varchar("currency", { length: 3 }).default("CNY").notNull(),
    prepaidMonths: int("prepaidMonths", { unsigned: true }),
    orderReference: varchar("orderReference", { length: 128 }),
    externalContractReference: varchar("externalContractReference", {
      length: 128,
    }),
    signedAt: timestamp("signedAt"),
    signatoryId: varchar("signatoryId", { length: 128 }),
    signingEvidence: json("signingEvidence").$type<Record<string, unknown>>(),
    replacesContractIds: json("replacesContractIds")
      .$type<string[]>()
      .default([])
      .notNull(),
    sourceReference: varchar("sourceReference", { length: 191 }),
    revision: int("revision", { unsigned: true }).default(1).notNull(),
    createdByUserId: int("createdByUserId").references(() => users.id, {
      onDelete: "set null",
    }),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
    updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
  },
  (table) => [
    uniqueIndex("service_contracts_user_revision_uq").on(
      table.userId,
      table.revision,
    ),
    index("service_contracts_user_status_ends_idx").on(
      table.userId,
      table.status,
      table.endsAt,
    ),
    index("service_contracts_source_reference_idx").on(
      table.source,
      table.sourceReference,
    ),
    index("service_contracts_order_reference_idx").on(
      table.source,
      table.orderReference,
    ),
  ],
);

/**
 * Immutable quota snapshots generated from the purchased plan terms.
 * Luxury contracts receive three monthly periods for one quarterly prepay;
 * advanced and basic contracts receive one period for their complete term.
 */
export const serviceQuotaPeriods = mysqlTable(
  "service_quota_periods",
  {
    id: varchar("id", { length: 36 }).primaryKey(),
    contractId: varchar("contractId", { length: 36 })
      .notNull()
      .references(() => serviceContracts.id, { onDelete: "cascade" }),
    userId: int("userId")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    ordinal: int("ordinal", { unsigned: true }).notNull(),
    startsAt: timestamp("startsAt").notNull(),
    endsAt: timestamp("endsAt").notNull(),
    industryLimit: int("industryLimit", { unsigned: true })
      .default(0)
      .notNull(),
    competitorComparisonLimit: int("competitorComparisonLimit", {
      unsigned: true,
    })
      .default(0)
      .notNull(),
    reputationLimit: int("reputationLimit", { unsigned: true })
      .default(0)
      .notNull(),
    productScenarioLimit: int("productScenarioLimit", { unsigned: true })
      .default(0)
      .notNull(),
    totalQuestionLimit: int("totalQuestionLimit", { unsigned: true })
      .default(0)
      .notNull(),
    contentAssetPublishLimit: int("contentAssetPublishLimit", {
      unsigned: true,
    })
      .default(0)
      .notNull(),
    websiteContentPublishLimit: int("websiteContentPublishLimit", {
      unsigned: true,
    })
      .default(0)
      .notNull(),
    archivedContentAssetPublishUsed: int("archivedContentAssetPublishUsed", {
      unsigned: true,
    })
      .default(0)
      .notNull(),
    archivedWebsiteContentPublishUsed: int(
      "archivedWebsiteContentPublishUsed",
      { unsigned: true },
    )
      .default(0)
      .notNull(),
    revision: int("revision", { unsigned: true }).default(1).notNull(),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
    updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
  },
  (table) => [
    uniqueIndex("service_quota_periods_contract_ordinal_uq").on(
      table.contractId,
      table.ordinal,
    ),
    index("service_quota_periods_user_window_idx").on(
      table.userId,
      table.startsAt,
      table.endsAt,
    ),
  ],
);

/**
 * User-submitted delivery requests. Quota is consumed at submission time and
 * is scoped to the immutable service quota period so later plan changes do not
 * rewrite delivery history.
 */
export const deliveryTickets = mysqlTable(
  "delivery_tickets",
  {
    id: varchar("id", { length: 36 }).primaryKey(),
    userId: int("userId")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    contractId: varchar("contractId", { length: 36 })
      .notNull()
      .references(() => serviceContracts.id, { onDelete: "restrict" }),
    quotaPeriodId: varchar("quotaPeriodId", { length: 36 })
      .notNull()
      .references(() => serviceQuotaPeriods.id, { onDelete: "restrict" }),
    type: mysqlEnum("type", [
      "content_asset",
      "website_operation",
      "knowledge_base",
    ]).notNull(),
    quotaPool: mysqlEnum("quotaPool", [
      "content_asset_publish",
      "website_content_publish",
    ]),
    ordinal: int("ordinal", { unsigned: true }).notNull(),
    clientRequestId: varchar("clientRequestId", { length: 36 }).notNull(),
    category: varchar("category", { length: 64 }),
    topic: varchar("topic", { length: 512 }),
    title: varchar("title", { length: 512 }),
    description: text("description"),
    preferredMedia: varchar("preferredMedia", { length: 32 }),
    icpProvince: varchar("icpProvince", { length: 64 }),
    icpDeclarations: json("icpDeclarations").$type<
      | {
          icpNumber: string;
        }
      | {
          domainHolderInformation: string;
          websiteInformation: string;
          aliyunAppVerificationCompleted: true;
        }
    >(),
    targetPage: text("targetPage"),
    knowledgeSnapshotId: varchar("knowledgeSnapshotId", { length: 36 }),
    workflowDomain: mysqlEnum("workflowDomain", [
      "ai_operations_engineer",
      "monitoring_optimization_engineer",
      "content_distribution_engineer",
    ]),
    operation: varchar("operation", { length: 64 }),
    assignedProjectAssignmentId: varchar("assignedProjectAssignmentId", {
      length: 36,
    }),
    assignedMemberId: int("assignedMemberId").references(() => users.id, {
      onDelete: "set null",
    }),
    sourceQuestionId: varchar("sourceQuestionId", { length: 191 }),
    monitoringBatchKey: varchar("monitoringBatchKey", { length: 191 }),
    responseLogicRevision: int("responseLogicRevision"),
    contentAssetIds: json("contentAssetIds")
      .$type<string[]>()
      .default([])
      .notNull(),
    technicalDedupeKey: varchar("technicalDedupeKey", { length: 64 }),
    materialUrls: json("materialUrls").$type<string[]>().default([]).notNull(),
    priority: mysqlEnum("priority", ["low", "normal", "high", "urgent"])
      .default("normal")
      .notNull(),
    status: mysqlEnum("status", [
      "submitted",
      "needs_information",
      "scheduled",
      "in_progress",
      "completed",
      "rejected",
      "cancelled",
    ])
      .default("submitted")
      .notNull(),
    quotaState: mysqlEnum("quotaState", ["reserved", "consumed", "released"])
      .default("reserved")
      .notNull(),
    internalNote: text("internalNote"),
    publicSummary: text("publicSummary"),
    deliveryLinks: json("deliveryLinks")
      .$type<Array<{ label: string; url: string }>>()
      .default([])
      .notNull(),
    revision: int("revision", { unsigned: true }).default(1).notNull(),
    createdByUserId: int("createdByUserId").references(() => users.id, {
      onDelete: "set null",
    }),
    updatedByUserId: int("updatedByUserId").references(() => users.id, {
      onDelete: "set null",
    }),
    resolvedAt: timestamp("resolvedAt"),
    scheduledAt: timestamp("scheduledAt"),
    quotaReleasedAt: timestamp("quotaReleasedAt"),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
    updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
  },
  (table) => [
    uniqueIndex("delivery_tickets_period_pool_ordinal_uq").on(
      table.quotaPeriodId,
      table.quotaPool,
      table.ordinal,
    ),
    uniqueIndex("delivery_tickets_user_request_uq").on(
      table.userId,
      table.clientRequestId,
    ),
    uniqueIndex("delivery_tickets_user_technical_dedupe_uq").on(
      table.userId,
      table.technicalDedupeKey,
    ),
    index("delivery_tickets_user_created_idx").on(
      table.userId,
      table.createdAt,
    ),
    index("delivery_tickets_period_pool_state_idx").on(
      table.quotaPeriodId,
      table.quotaPool,
      table.quotaState,
    ),
    index("delivery_tickets_status_updated_idx").on(
      table.status,
      table.updatedAt,
    ),
    index("delivery_tickets_status_resolved_id_idx").on(
      table.status,
      table.resolvedAt,
      table.id,
    ),
    index("delivery_tickets_user_updated_id_idx").on(
      table.userId,
      table.updatedAt,
      table.id,
    ),
    index("delivery_tickets_user_period_updated_id_idx").on(
      table.userId,
      table.quotaPeriodId,
      table.updatedAt,
      table.id,
    ),
    index("delivery_tickets_type_status_updated_id_idx").on(
      table.type,
      table.status,
      table.updatedAt,
      table.id,
    ),
    index("delivery_tickets_role_member_status_idx").on(
      table.workflowDomain,
      table.assignedMemberId,
      table.status,
    ),
    index("delivery_tickets_member_status_resolved_id_idx").on(
      table.assignedMemberId,
      table.status,
      table.resolvedAt,
      table.id,
    ),
    foreignKey({
      name: "delivery_tickets_project_assignment_fk",
      columns: [table.assignedProjectAssignmentId],
      foreignColumns: [deliveryProjectAssignments.id],
    }).onDelete("set null"),
  ],
);

/**
 * Compact workflow facts retained after verbose delivery tickets expire.
 * One row per customer and operation preserves gates without retaining ticket
 * messages, attachments, or duplicated presentation fields.
 */
export const deliveryWorkflowMilestones = mysqlTable(
  "delivery_workflow_milestones",
  {
    id: varchar("id", { length: 36 }).primaryKey(),
    userId: int("userId")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    operation: varchar("operation", { length: 64 }).notNull(),
    contentAssetIds: json("contentAssetIds")
      .$type<string[]>()
      .default([])
      .notNull(),
    completedAt: timestamp("completedAt").notNull(),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
    updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
  },
  (table) => [
    uniqueIndex("delivery_workflow_milestones_user_operation_uq").on(
      table.userId,
      table.operation,
    ),
    index("delivery_workflow_milestones_operation_idx").on(table.operation),
  ],
);

/** Customer-visible thread and internal delivery notes for a ticket. */
export const deliveryTicketEvents = mysqlTable(
  "delivery_ticket_events",
  {
    id: varchar("id", { length: 36 }).primaryKey(),
    ticketId: varchar("ticketId", { length: 36 })
      .notNull()
      .references(() => deliveryTickets.id, { onDelete: "cascade" }),
    userId: int("userId")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    actorUserId: int("actorUserId").references(() => users.id, {
      onDelete: "set null",
    }),
    actorRole: mysqlEnum("actorRole", [
      "user",
      "admin",
      "delivery_member",
      "system",
    ]).notNull(),
    actorContext: json("actorContext").$type<{
      projectAssignmentId: string;
      customerUserId: number;
      roleType:
        | "ai_operations_engineer"
        | "monitoring_optimization_engineer"
        | "content_distribution_engineer"
        | "knowledge_base_engineer"
        | "website_operations_engineer";
      sourceTicketId?: string;
      assignedProjectAssignmentId?: string;
      assignedMemberId?: number;
    }>(),
    kind: mysqlEnum("kind", [
      "created",
      "message",
      "status_change",
      "attachment",
      "delivery_result",
    ]).notNull(),
    visibility: mysqlEnum("visibility", ["customer", "internal"])
      .default("customer")
      .notNull(),
    clientRequestId: varchar("clientRequestId", { length: 36 }),
    message: text("message"),
    fromStatus: mysqlEnum("fromStatus", [
      "submitted",
      "needs_information",
      "scheduled",
      "in_progress",
      "completed",
      "rejected",
      "cancelled",
    ]),
    toStatus: mysqlEnum("toStatus", [
      "submitted",
      "needs_information",
      "scheduled",
      "in_progress",
      "completed",
      "rejected",
      "cancelled",
    ]),
    operationResult: json("operationResult").$type<{
      platform: string;
      targetUrl: string;
      executedAt: number;
      resultStatus: "success" | "failed" | "pending_confirmation";
      platformMessage?: string;
      screenshotFileId?: string;
    }>(),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex("delivery_ticket_events_actor_request_uq").on(
      table.actorUserId,
      table.clientRequestId,
    ),
    index("delivery_ticket_events_ticket_created_idx").on(
      table.ticketId,
      table.createdAt,
    ),
    index("delivery_ticket_events_user_created_idx").on(
      table.userId,
      table.createdAt,
    ),
  ],
);

/** Durable metadata for user inputs and administrator deliverables. */
export const deliveryTicketAttachments = mysqlTable(
  "delivery_ticket_attachments",
  {
    id: varchar("id", { length: 36 }).primaryKey(),
    ticketId: varchar("ticketId", { length: 36 })
      .notNull()
      .references(() => deliveryTickets.id, { onDelete: "cascade" }),
    eventId: varchar("eventId", { length: 36 }).references(
      () => deliveryTicketEvents.id,
      { onDelete: "set null" },
    ),
    workspaceUserId: int("workspaceUserId")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    ownerUserId: int("ownerUserId")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    kind: mysqlEnum("kind", ["input", "deliverable"])
      .default("input")
      .notNull(),
    upstreamFileId: varchar("upstreamFileId", { length: 255 }),
    filename: varchar("filename", { length: 512 }).notNull(),
    mimeType: varchar("mimeType", { length: 255 }),
    sizeBytes: int("sizeBytes", { unsigned: true }),
    sha256: varchar("sha256", { length: 64 }),
    purpose: varchar("purpose", { length: 160 }),
    authorization: mysqlEnum("authorization", [
      "owned",
      "licensed",
      "public",
      "authorization_pending",
    ]),
    copyrightNote: text("copyrightNote"),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex("delivery_ticket_attachments_event_file_kind_uq").on(
      table.eventId,
      table.upstreamFileId,
      table.kind,
    ),
    index("delivery_ticket_attachments_ticket_created_idx").on(
      table.ticketId,
      table.createdAt,
    ),
    index("delivery_ticket_attachments_owner_file_idx").on(
      table.ownerUserId,
      table.upstreamFileId,
    ),
  ],
);

/** Records which delivery administrator originally created an engineer. */
export const deliveryMemberOrigins = mysqlTable(
  "delivery_member_origins",
  {
    engineerUserId: int("engineerUserId")
      .primaryKey()
      .references(() => users.id, { onDelete: "cascade" }),
    createdByAdminId: int("createdByAdminId").references(() => users.id, {
      onDelete: "set null",
    }),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
  },
  (table) => [
    index("delivery_member_origins_admin_idx").on(table.createdByAdminId),
  ],
);

/** One durable website-style approval workflow per customer workspace. */
export const websiteStyleWorkflows = mysqlTable(
  "website_style_workflows",
  {
    userId: int("userId")
      .primaryKey()
      .references(() => users.id, { onDelete: "cascade" }),
    status: mysqlEnum("status", [
      "waiting_samples",
      "awaiting_selection",
      "revision_requested",
      "confirmed",
      "legacy_confirmed",
    ])
      .default("waiting_samples")
      .notNull(),
    currentBatchId: varchar("currentBatchId", { length: 36 }),
    selectedSampleId: varchar("selectedSampleId", { length: 36 }),
    selectedByUserId: int("selectedByUserId").references(() => users.id, {
      onDelete: "set null",
    }),
    selectedAt: timestamp("selectedAt"),
    revision: int("revision", { unsigned: true }).default(1).notNull(),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
    updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
  },
  (table) => [index("website_style_workflows_status_idx").on(table.status)],
);

/** Engineer-published batches of exactly three website style samples. */
export const websiteStyleSampleBatches = mysqlTable(
  "website_style_sample_batches",
  {
    id: varchar("id", { length: 36 }).primaryKey(),
    userId: int("userId")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    ticketId: varchar("ticketId", { length: 36 })
      .notNull()
      .references(() => deliveryTickets.id, { onDelete: "cascade" }),
    ordinal: int("ordinal", { unsigned: true }).notNull(),
    status: mysqlEnum("status", [
      "published",
      "revision_requested",
      "selected",
      "superseded",
    ])
      .default("published")
      .notNull(),
    engineerNote: text("engineerNote"),
    publishedByUserId: int("publishedByUserId").references(() => users.id, {
      onDelete: "set null",
    }),
    publishedAt: timestamp("publishedAt").notNull(),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
    updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
  },
  (table) => [
    uniqueIndex("website_style_batches_user_ordinal_uq").on(
      table.userId,
      table.ordinal,
    ),
    index("website_style_batches_ticket_status_idx").on(
      table.ticketId,
      table.status,
    ),
  ],
);

/** The customer-visible images within one website-style sample batch. */
export const websiteStyleSamples = mysqlTable(
  "website_style_samples",
  {
    id: varchar("id", { length: 36 }).primaryKey(),
    batchId: varchar("batchId", { length: 36 })
      .notNull()
      .references(() => websiteStyleSampleBatches.id, {
        onDelete: "cascade",
      }),
    attachmentId: varchar("attachmentId", { length: 36 }).notNull(),
    label: varchar("label", { length: 160 }).notNull(),
    note: text("note"),
    sortOrder: int("sortOrder", { unsigned: true }).notNull(),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex("website_style_samples_batch_order_uq").on(
      table.batchId,
      table.sortOrder,
    ),
    uniqueIndex("website_style_samples_batch_attachment_uq").on(
      table.batchId,
      table.attachmentId,
    ),
    foreignKey({
      name: "website_style_samples_attachment_fk",
      columns: [table.attachmentId],
      foreignColumns: [deliveryTicketAttachments.id],
    }).onDelete("restrict"),
  ],
);

/** Administrator-owned website identity shown in the customer workspace. */
export const workspaceSiteProfiles = mysqlTable(
  "workspace_site_profiles",
  {
    userId: int("userId")
      .primaryKey()
      .references(() => users.id, { onDelete: "cascade" }),
    domain: varchar("domain", { length: 255 }),
    siteMode: mysqlEnum("siteMode", ["managed", "external", "unknown"])
      .default("unknown")
      .notNull(),
    domainStatus: mysqlEnum("domainStatus", [
      "not_started",
      "pending",
      "completed",
    ])
      .default("not_started")
      .notNull(),
    domainVerifiedAt: timestamp("domainVerifiedAt"),
    icpProvince: varchar("icpProvince", { length: 64 }),
    icpNumber: varchar("icpNumber", { length: 128 }),
    icpStatus: mysqlEnum("icpStatus", [
      "not_submitted",
      "preparing",
      "submitted",
      "approved",
      "rejected",
      "not_required",
    ])
      .default("not_submitted")
      .notNull(),
    icpVerifiedAt: timestamp("icpVerifiedAt"),
    revision: int("revision", { unsigned: true }).default(1).notNull(),
    updatedByUserId: int("updatedByUserId").references(() => users.id, {
      onDelete: "set null",
    }),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
    updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
  },
  (table) => [
    index("workspace_site_profiles_domain_idx").on(table.domain),
    index("workspace_site_profiles_workflow_idx").on(
      table.domainStatus,
      table.icpStatus,
    ),
  ],
);

/** Administrator-maintained, customer-visible website health checks. */
export const workspaceSiteChecks = mysqlTable(
  "workspace_site_checks",
  {
    id: varchar("id", { length: 36 }).primaryKey(),
    userId: int("userId")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    key: varchar("key", { length: 64 }).notNull(),
    label: varchar("label", { length: 160 }).notNull(),
    status: mysqlEnum("status", [
      "not_checked",
      "pending",
      "passed",
      "warning",
      "failed",
      "not_applicable",
    ])
      .default("not_checked")
      .notNull(),
    summary: text("summary"),
    evidence: text("evidence"),
    source: text("source"),
    checkedAt: timestamp("checkedAt"),
    revision: int("revision", { unsigned: true }).default(1).notNull(),
    updatedByUserId: int("updatedByUserId").references(() => users.id, {
      onDelete: "set null",
    }),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
    updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
  },
  (table) => [
    uniqueIndex("workspace_site_checks_user_key_uq").on(
      table.userId,
      table.key,
    ),
    index("workspace_site_checks_user_status_idx").on(
      table.userId,
      table.status,
    ),
  ],
);

/** Durable redirect-file preflight boundary; applying it is an atomic action. */
export const deliveryRedirectPreviews = mysqlTable(
  "delivery_redirect_previews",
  {
    id: varchar("id", { length: 36 }).primaryKey(),
    userId: int("userId")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    ownerUserId: int("ownerUserId")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    upstreamFileId: varchar("upstreamFileId", { length: 255 }).notNull(),
    filename: varchar("filename", { length: 512 }).notNull(),
    fileHash: varchar("fileHash", { length: 64 }).notNull(),
    rows: json("rows")
      .$type<
        Array<{
          row: number;
          sourceUrl: string;
          targetUrl: string;
          statusCode: number;
        }>
      >()
      .default([])
      .notNull(),
    errors: json("errors")
      .$type<Array<{ row: number; message: string }>>()
      .default([])
      .notNull(),
    total: int("total", { unsigned: true }).default(0).notNull(),
    validCount: int("validCount", { unsigned: true }).default(0).notNull(),
    errorCount: int("errorCount", { unsigned: true }).default(0).notNull(),
    status: mysqlEnum("status", ["previewed", "applied", "expired"])
      .default("previewed")
      .notNull(),
    appliedTicketId: varchar("appliedTicketId", { length: 36 }).references(
      () => deliveryTickets.id,
      { onDelete: "set null" },
    ),
    createdByUserId: int("createdByUserId").references(() => users.id, {
      onDelete: "set null",
    }),
    expiresAt: timestamp("expiresAt").notNull(),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
    appliedAt: timestamp("appliedAt"),
  },
  (table) => [
    uniqueIndex("delivery_redirect_previews_user_hash_uq").on(
      table.userId,
      table.fileHash,
    ),
    index("delivery_redirect_previews_user_created_idx").on(
      table.userId,
      table.createdAt,
    ),
    index("delivery_redirect_previews_status_expires_idx").on(
      table.status,
      table.expiresAt,
    ),
  ],
);

/**
 * Immutable, period-bound progress report publications. The legacy
 * user_dashboard_contents.optimizationReport field remains a compatibility
 * projection, while this table is the source of truth for workflow completion
 * and historical report access.
 */
export const serviceProgressReports = mysqlTable(
  "service_progress_reports",
  {
    id: varchar("id", { length: 36 }).primaryKey(),
    userId: int("userId")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    contractId: varchar("contractId", { length: 36 })
      .notNull()
      .references(() => serviceContracts.id, { onDelete: "cascade" }),
    quotaPeriodId: varchar("quotaPeriodId", { length: 36 })
      .notNull()
      .references(() => serviceQuotaPeriods.id, { onDelete: "cascade" }),
    payload: json("payload").$type<Record<string, unknown>>().notNull(),
    sourceName: varchar("sourceName", { length: 512 }),
    revision: int("revision", { unsigned: true }).default(1).notNull(),
    publishedByUserId: int("publishedByUserId").references(() => users.id, {
      onDelete: "set null",
    }),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
    updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
  },
  (table) => [
    uniqueIndex("service_progress_reports_period_revision_uq").on(
      table.quotaPeriodId,
      table.revision,
    ),
    index("service_progress_reports_user_period_created_idx").on(
      table.userId,
      table.quotaPeriodId,
      table.createdAt,
    ),
    index("service_progress_reports_contract_idx").on(table.contractId),
  ],
);

/**
 * Candidate and selected questions for one quota period. Generated candidate
 * refreshes archive only replaceable model rows; selected and locked rows are
 * durable history.
 */
export const workspaceQuestions = mysqlTable(
  "workspace_questions",
  {
    id: varchar("id", { length: 36 }).primaryKey(),
    userId: int("userId")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    contractId: varchar("contractId", { length: 36 })
      .notNull()
      .references(() => serviceContracts.id, { onDelete: "cascade" }),
    quotaPeriodId: varchar("quotaPeriodId", { length: 36 })
      .notNull()
      .references(() => serviceQuotaPeriods.id, { onDelete: "cascade" }),
    externalQuestionId: varchar("externalQuestionId", { length: 191 }),
    sourceQuestionId: varchar("sourceQuestionId", { length: 36 }),
    candidateKey: varchar("candidateKey", { length: 191 }),
    category: mysqlEnum("category", [
      "industry",
      "competitor_comparison",
      "reputation",
      "product_scenario",
    ]).notNull(),
    question: text("question").notNull(),
    intent: text("intent"),
    intentRevision: int("intentRevision", { unsigned: true })
      .default(1)
      .notNull(),
    intentConfirmedRevision: int("intentConfirmedRevision", {
      unsigned: true,
    }),
    intentConfirmedAt: timestamp("intentConfirmedAt"),
    intentConfirmedByUserId: int("intentConfirmedByUserId").references(
      () => users.id,
      { onDelete: "set null" },
    ),
    rationale: text("rationale"),
    evidence: json("evidence")
      .$type<WorkspaceQuestionEvidenceRecord[]>()
      .default([])
      .notNull(),
    risks: json("risks").$type<string[]>().default([]).notNull(),
    source: mysqlEnum("source", [
      "model",
      "website",
      "offline",
      "admin",
      "user",
    ])
      .default("model")
      .notNull(),
    status: mysqlEnum("status", ["candidate", "selected", "archived"])
      .default("candidate")
      .notNull(),
    selectionApprovalStatus: mysqlEnum("selectionApprovalStatus", [
      "not_requested",
      "pending",
      "approved",
    ])
      .default("not_requested")
      .notNull(),
    selectionRequestedAt: timestamp("selectionRequestedAt"),
    selectionRequestedByUserId: int("selectionRequestedByUserId").references(
      () => users.id,
      { onDelete: "set null" },
    ),
    selectionApprovedAt: timestamp("selectionApprovedAt"),
    selectionApprovedByUserId: int("selectionApprovedByUserId").references(
      () => users.id,
      { onDelete: "set null" },
    ),
    locked: boolean("locked").default(false).notNull(),
    sourceTaskId: varchar("sourceTaskId", { length: 255 }),
    knowledgeSnapshotId: varchar("knowledgeSnapshotId", {
      length: 36,
    }).references(() => knowledgeBaseSnapshots.id, { onDelete: "set null" }),
    ordinal: int("ordinal", { unsigned: true }).default(0).notNull(),
    revision: int("revision", { unsigned: true }).default(1).notNull(),
    selectedAt: timestamp("selectedAt"),
    archivedAt: timestamp("archivedAt"),
    createdByUserId: int("createdByUserId").references(() => users.id, {
      onDelete: "set null",
    }),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
    updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
  },
  (table) => [
    uniqueIndex("workspace_questions_generation_key_uq").on(
      table.quotaPeriodId,
      table.sourceTaskId,
      table.candidateKey,
    ),
    index("workspace_questions_user_period_status_idx").on(
      table.userId,
      table.quotaPeriodId,
      table.status,
    ),
    index("workspace_questions_user_category_status_idx").on(
      table.userId,
      table.category,
      table.status,
    ),
    index("workspace_questions_user_approval_status_idx").on(
      table.userId,
      table.selectionApprovalStatus,
      table.updatedAt,
    ),
    index("workspace_questions_external_idx").on(
      table.userId,
      table.externalQuestionId,
    ),
    index("workspace_questions_source_question_idx").on(
      table.userId,
      table.sourceQuestionId,
    ),
  ],
);

/**
 * Idempotent service-to-service knowledge imports. Only hashes of external
 * idempotency keys are stored; a completed receipt points at the published
 * immutable snapshot.
 */
export const knowledgeImportReceipts = mysqlTable(
  "knowledge_import_receipts",
  {
    id: varchar("id", { length: 36 }).primaryKey(),
    userId: int("userId")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    source: mysqlEnum("source", ["website", "offline", "admin"])
      .default("website")
      .notNull(),
    projectId: varchar("projectId", { length: 80 }),
    companyName: varchar("companyName", { length: 200 }),
    taskId: varchar("taskId", { length: 255 }),
    fileId: varchar("fileId", { length: 255 }),
    outputItemId: varchar("outputItemId", { length: 255 }),
    descriptorHash: varchar("descriptorHash", { length: 64 }),
    sourceReference: varchar("sourceReference", { length: 191 }),
    idempotencyKeyHash: varchar("idempotencyKeyHash", { length: 64 })
      .notNull()
      .unique(),
    artifactHash: varchar("artifactHash", { length: 64 }).notNull(),
    sourceFileName: varchar("sourceFileName", { length: 512 }).notNull(),
    status: mysqlEnum("status", [
      "pending",
      "processing",
      "completed",
      "failed",
    ])
      .default("pending")
      .notNull(),
    snapshotId: varchar("snapshotId", { length: 36 }).references(
      () => knowledgeBaseSnapshots.id,
      { onDelete: "set null" },
    ),
    attemptCount: int("attemptCount", { unsigned: true }).default(0).notNull(),
    errorCode: varchar("errorCode", { length: 128 }),
    errorMessage: text("errorMessage"),
    revision: int("revision", { unsigned: true }).default(1).notNull(),
    completedAt: timestamp("completedAt"),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
    updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
  },
  (table) => [
    uniqueIndex("knowledge_import_receipts_user_artifact_uq").on(
      table.userId,
      table.artifactHash,
    ),
    uniqueIndex("knowledge_import_receipts_project_descriptor_uq").on(
      table.projectId,
      table.taskId,
      table.outputItemId,
      table.descriptorHash,
    ),
    index("knowledge_import_receipts_user_status_idx").on(
      table.userId,
      table.status,
    ),
    index("knowledge_import_receipts_project_task_idx").on(
      table.projectId,
      table.taskId,
    ),
  ],
);

/**
 * Short-lived, hash-only purchase and upgrade hand-offs to the website.
 * The browser receives the opaque token; the database retains only its hash.
 */
export const purchaseIntents = mysqlTable(
  "purchase_intents",
  {
    id: varchar("id", { length: 36 }).primaryKey(),
    userId: int("userId")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    sourceContractId: varchar("sourceContractId", {
      length: 36,
    }).references(() => serviceContracts.id, { onDelete: "set null" }),
    resultingContractId: varchar("resultingContractId", {
      length: 36,
    }).references(() => serviceContracts.id, { onDelete: "set null" }),
    targetPlanCode: mysqlEnum("targetPlanCode", [
      "basic",
      "advanced",
      "luxury",
    ]).notNull(),
    kind: mysqlEnum("kind", [
      "new_purchase",
      "repeat_basic",
      "upgrade",
      "renewal",
    ]).notNull(),
    status: mysqlEnum("status", ["pending", "consumed", "cancelled"])
      .default("pending")
      .notNull(),
    tokenHash: varchar("tokenHash", { length: 64 }).notNull().unique(),
    externalOrderId: varchar("externalOrderId", { length: 128 }),
    revision: int("revision", { unsigned: true }).default(1).notNull(),
    expiresAt: timestamp("expiresAt").notNull(),
    consumedAt: timestamp("consumedAt"),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
    updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
  },
  (table) => [
    index("purchase_intents_user_status_expires_idx").on(
      table.userId,
      table.status,
      table.expiresAt,
    ),
    index("purchase_intents_external_order_idx").on(table.externalOrderId),
  ],
);

/**
 * Legacy API Key ownership rows retained for migration compatibility.
 * New credential assignments no longer write to this table because one
 * upstream API Key may be shared by multiple FrontMind users.
 */
export const apiKeyOwnership = mysqlTable(
  "api_key_ownership",
  {
    fingerprint: varchar("fingerprint", { length: 32 }).primaryKey(),
    userId: int("userId")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
  },
  (table) => [index("api_key_ownership_user_idx").on(table.userId)],
);

/** A user can be managed by several administrators, and vice versa. */
export const userAdminAssignments = mysqlTable(
  "user_admin_assignments",
  {
    id: int("id").autoincrement().primaryKey(),
    userId: int("userId")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    adminId: int("adminId")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    assignedByUserId: int("assignedByUserId").references(() => users.id, {
      onDelete: "set null",
    }),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex("user_admin_assignments_user_admin_uq").on(
      table.userId,
      table.adminId,
    ),
    index("user_admin_assignments_admin_idx").on(table.adminId),
  ],
);

/** Exactly one project engineer per customer workspace and role domain. */
export const deliveryProjectAssignments = mysqlTable(
  "delivery_project_assignments",
  {
    id: varchar("id", { length: 36 }).primaryKey(),
    customerUserId: int("customerUserId")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    roleType: mysqlEnum("roleType", [
      "ai_operations_engineer",
      "monitoring_optimization_engineer",
      "content_distribution_engineer",
    ]).notNull(),
    engineerUserId: int("engineerUserId").references(() => users.id, {
      onDelete: "set null",
    }),
    revision: int("revision", { unsigned: true }).default(1).notNull(),
    assignedByUserId: int("assignedByUserId").references(() => users.id, {
      onDelete: "set null",
    }),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
    updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
  },
  (table) => [
    uniqueIndex("delivery_project_assignments_customer_type_uq").on(
      table.customerUserId,
      table.roleType,
    ),
    index("delivery_project_assignments_engineer_type_idx").on(
      table.engineerUserId,
      table.roleType,
    ),
  ],
);

/**
 * One administrator is the primary delivery owner for each customer. Customer
 * accounts normally use their own credential; this relationship remains a
 * legacy credential fallback for accounts that have not yet been upgraded.
 */
export const userUsageOwners = mysqlTable(
  "user_usage_owners",
  {
    userId: int("userId")
      .primaryKey()
      .references(() => users.id, { onDelete: "cascade" }),
    deliveryAdminId: int("deliveryAdminId")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    revision: int("revision", { unsigned: true }).default(1).notNull(),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
    updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
  },
  (table) => [
    index("user_usage_owners_delivery_admin_idx").on(table.deliveryAdminId),
  ],
);

/**
 * Append-only administrator audit trail. Target identifiers deliberately do
 * not cascade with business rows so an account or credential deletion cannot
 * erase the evidence explaining who performed it.
 */
export const workspaceAuditEvents = mysqlTable(
  "workspace_audit_events",
  {
    id: varchar("id", { length: 36 }).primaryKey(),
    actorUserId: int("actorUserId").references(() => users.id, {
      onDelete: "set null",
    }),
    actorUsername: varchar("actorUsername", { length: 64 }),
    actorAccessLevel: mysqlEnum("actorAccessLevel", [
      "system_admin",
      "delivery_admin",
    ]),
    action: varchar("action", { length: 128 }).notNull(),
    targetType: varchar("targetType", { length: 64 }).notNull(),
    targetId: varchar("targetId", { length: 191 }).notNull(),
    workspaceUserId: int("workspaceUserId"),
    reason: text("reason"),
    metadata: json("metadata")
      .$type<Record<string, unknown>>()
      .default({})
      .notNull(),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
  },
  (table) => [
    index("workspace_audit_events_actor_created_idx").on(
      table.actorUserId,
      table.createdAt,
    ),
    index("workspace_audit_events_workspace_created_idx").on(
      table.workspaceUserId,
      table.createdAt,
    ),
    index("workspace_audit_events_action_created_idx").on(
      table.action,
      table.createdAt,
    ),
    index("workspace_audit_events_target_idx").on(
      table.targetType,
      table.targetId,
    ),
  ],
);

/**
 * Durable one-time nonces for administrator dashboard import preflights.
 * The signed browser token carries the same binding; this row makes
 * consumption atomic across application instances and prevents replay.
 */
export const dashboardImportPreflights = mysqlTable(
  "dashboard_import_preflights",
  {
    id: varchar("id", { length: 36 }).primaryKey(),
    actorUserId: int("actorUserId")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    workspaceUserId: int("workspaceUserId")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    module: varchar("module", { length: 64 }).notNull(),
    dashboardRevision: int("dashboardRevision", { unsigned: true }).notNull(),
    fileHash: varchar("fileHash", { length: 64 }).notNull(),
    sectionId: varchar("sectionId", { length: 80 }),
    targetBatchKey: varchar("targetBatchKey", { length: 191 }),
    expiresAt: timestamp("expiresAt").notNull(),
    consumedAt: timestamp("consumedAt"),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
  },
  (table) => [
    index("dashboard_import_preflights_actor_expires_idx").on(
      table.actorUserId,
      table.expiresAt,
    ),
    index("dashboard_import_preflights_workspace_expires_idx").on(
      table.workspaceUserId,
      table.expiresAt,
    ),
    index("dashboard_import_preflights_consumed_expires_idx").on(
      table.consumedAt,
      table.expiresAt,
    ),
  ],
);

/** Standardized dashboard content published to a user by their administrators. */
export const userDashboardContents = mysqlTable(
  "user_dashboard_contents",
  {
    userId: int("userId")
      .primaryKey()
      .references(() => users.id, { onDelete: "cascade" }),
    payload: json("payload").$type<Record<string, unknown>>().notNull(),
    sourceName: varchar("sourceName", { length: 512 }),
    enterpriseIdentityBoundAt: timestamp("enterpriseIdentityBoundAt"),
    revision: int("revision", { unsigned: true }).default(1).notNull(),
    updatedByUserId: int("updatedByUserId").references(() => users.id, {
      onDelete: "set null",
    }),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
    updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
  },
  (table) => [index("user_dashboard_contents_updated_idx").on(table.updatedAt)],
);

/**
 * Immutable publication history for administrator-managed workspace content.
 * user_dashboard_contents remains the compatibility projection consumed by
 * the user portal; each successful publish or rollback appends one revision.
 */
export const workspaceContentRevisions = mysqlTable(
  "workspace_content_revisions",
  {
    id: varchar("id", { length: 36 }).primaryKey(),
    userId: int("userId")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    module: varchar("module", { length: 64 }).default("dashboard").notNull(),
    revision: int("revision", { unsigned: true }).notNull(),
    payload: json("payload").$type<Record<string, unknown>>().notNull(),
    sourceName: varchar("sourceName", { length: 512 }),
    enterpriseIdentityBoundAt: timestamp("enterpriseIdentityBoundAt"),
    publicationKind: mysqlEnum("publicationKind", [
      "publish",
      "rollback",
      "migration",
    ])
      .default("publish")
      .notNull(),
    rolledBackFromRevision: int("rolledBackFromRevision", { unsigned: true }),
    publishedByUserId: int("publishedByUserId").references(() => users.id, {
      onDelete: "set null",
    }),
    reason: text("reason"),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex("workspace_content_revisions_user_module_revision_uq").on(
      table.userId,
      table.module,
      table.revision,
    ),
    index("workspace_content_revisions_user_module_created_idx").on(
      table.userId,
      table.module,
      table.createdAt,
    ),
    index("workspace_content_revisions_publisher_idx").on(
      table.publishedByUserId,
    ),
  ],
);

/**
 * One administrator-managed import batch for a user's question-monitoring
 * workspace. New batches are bound to one contract/quota period so prior
 * monitoring remains historical and cannot complete a renewed service cycle.
 * Legacy rows may retain a null period until they are safely classified.
 */
export const monitoringBatches = mysqlTable(
  "monitoring_batches",
  {
    id: varchar("id", { length: 36 }).primaryKey(),
    userId: int("userId")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    contractId: varchar("contractId", { length: 36 }).references(
      () => serviceContracts.id,
      { onDelete: "cascade" },
    ),
    quotaPeriodId: varchar("quotaPeriodId", { length: 36 }).references(
      () => serviceQuotaPeriods.id,
      { onDelete: "cascade" },
    ),
    batchKey: varchar("batchKey", { length: 191 }).notNull(),
    sourceName: varchar("sourceName", { length: 512 }).notNull(),
    collectedAt: timestamp("collectedAt").notNull(),
    sampleCount: int("sampleCount", { unsigned: true }).default(0).notNull(),
    citationCount: int("citationCount", { unsigned: true })
      .default(0)
      .notNull(),
    revision: int("revision", { unsigned: true }).default(1).notNull(),
    importedByUserId: int("importedByUserId").references(() => users.id, {
      onDelete: "set null",
    }),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
    updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
  },
  (table) => [
    uniqueIndex("monitoring_batches_user_period_key_uq").on(
      table.userId,
      table.quotaPeriodId,
      table.batchKey,
    ),
    index("monitoring_batches_contract_period_idx").on(
      table.contractId,
      table.quotaPeriodId,
    ),
    index("monitoring_batches_user_collected_idx").on(
      table.userId,
      table.collectedAt,
    ),
  ],
);

/** A single model answer captured for one configured tenant question. */
export const monitoringSamples = mysqlTable(
  "monitoring_samples",
  {
    id: varchar("id", { length: 36 }).primaryKey(),
    userId: int("userId")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    batchId: varchar("batchId", { length: 36 })
      .notNull()
      .references(() => monitoringBatches.id, { onDelete: "cascade" }),
    sourceRecordId: varchar("sourceRecordId", { length: 191 }).notNull(),
    questionId: varchar("questionId", { length: 191 }).notNull(),
    question: text("question").notNull(),
    platform: varchar("platform", { length: 128 }).notNull(),
    answerNo: int("answerNo", { unsigned: true }).default(1).notNull(),
    content: longtext("content").notNull(),
    citationCount: int("citationCount", { unsigned: true })
      .default(0)
      .notNull(),
    monitorRank: int("monitorRank", { unsigned: true }),
    screenshotUrl: text("screenshotUrl"),
    collectedAt: timestamp("collectedAt").notNull(),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex("monitoring_samples_user_batch_source_uq").on(
      table.userId,
      table.batchId,
      table.sourceRecordId,
    ),
    index("monitoring_samples_user_question_collected_idx").on(
      table.userId,
      table.questionId,
      table.collectedAt,
    ),
    index("monitoring_samples_user_batch_idx").on(table.userId, table.batchId),
    index("monitoring_samples_user_platform_idx").on(
      table.userId,
      table.platform,
    ),
  ],
);

/**
 * Normalized citation evidence. A citation can stand alone (for an exported
 * citation ledger) or point to the captured answer that emitted it.
 */
export const monitoringCitationRecords = mysqlTable(
  "monitoring_citation_records",
  {
    id: varchar("id", { length: 36 }).primaryKey(),
    userId: int("userId")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    batchId: varchar("batchId", { length: 36 })
      .notNull()
      .references(() => monitoringBatches.id, { onDelete: "cascade" }),
    sampleId: varchar("sampleId", { length: 36 }).references(
      () => monitoringSamples.id,
      { onDelete: "set null" },
    ),
    sourceRecordId: varchar("sourceRecordId", { length: 191 }).notNull(),
    questionId: varchar("questionId", { length: 191 }).notNull(),
    question: text("question").notNull(),
    model: varchar("model", { length: 128 }).notNull(),
    title: text("title").notNull(),
    url: text("url").notNull(),
    media: varchar("media", { length: 255 }).notNull(),
    domain: varchar("domain", { length: 255 }).notNull(),
    publishedAt: timestamp("publishedAt"),
    collectedAt: timestamp("collectedAt").notNull(),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex("monitoring_citations_user_batch_source_uq").on(
      table.userId,
      table.batchId,
      table.sourceRecordId,
    ),
    index("monitoring_citations_user_question_collected_idx").on(
      table.userId,
      table.questionId,
      table.collectedAt,
    ),
    index("monitoring_citations_user_batch_idx").on(
      table.userId,
      table.batchId,
    ),
    index("monitoring_citations_user_model_idx").on(table.userId, table.model),
    index("monitoring_citations_user_media_idx").on(table.userId, table.media),
    index("monitoring_citations_user_domain_idx").on(
      table.userId,
      table.domain,
    ),
    index("monitoring_citations_sample_idx").on(table.sampleId),
  ],
);

export type KnowledgeDocumentRecord = {
  id?: string;
  path: string;
  title: string;
  content: string;
  kind?: "overview" | "leaf" | "evidence" | "report" | "index" | "other";
  branchId?: string;
  branchTitle?: string;
  order?: number;
  evidenceStatus?:
    | "verified_first_party"
    | "verified_authoritative"
    | "supported_third_party"
    | "inferred"
    | "needs_verification"
    | "not_applicable";
  sourceIds?: string[];
  assetIds?: string[];
  customerVisible?: boolean;
};

export type KnowledgeAssetRecord = {
  id?: string;
  key: string;
  path: string;
  mimeType: string;
  size: number;
  sha256?: string;
  width?: number;
  height?: number;
  caption?: string;
  alt?: string;
  branchId?: string;
  documentIds?: string[];
  sourcePageUrl?: string;
  sourceAssetUrl?: string;
  sourceDocumentPath?: string;
  sourceKind?:
    | "official_web"
    | "official_document"
    | "official_logo_upload"
    | "user_upload";
  sourceUploadIndex?: number;
  sourceUploadFileId?: string;
  sourceUploadSha256?: string;
  sourceUploadFilename?: string;
  sourceUploadMimeType?: string;
  sourceUploadSizeBytes?: number;
  ownership?: "first_party" | "third_party" | "unknown";
};

/** Immutable versions of the final knowledge-base archive shown on the dashboard. */
export const knowledgeBaseSnapshots = mysqlTable(
  "knowledge_base_snapshots",
  {
    id: varchar("id", { length: 36 }).primaryKey(),
    userId: int("userId")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    version: int("version").notNull(),
    sourceFileName: varchar("sourceFileName", { length: 512 }).notNull(),
    sourceConversationId: varchar("sourceConversationId", { length: 191 }),
    sourceBuildId: varchar("sourceBuildId", { length: 36 }),
    sourceBuildRevision: int("sourceBuildRevision"),
    sourceTaskId: varchar("sourceTaskId", { length: 255 }),
    sourceArtifactHash: varchar("sourceArtifactHash", { length: 64 }),
    archiveHash: varchar("archiveHash", { length: 64 }),
    maintenanceTicketId: varchar("maintenanceTicketId", { length: 36 }),
    documents: json("documents").$type<KnowledgeDocumentRecord[]>().notNull(),
    assets: json("assets").$type<KnowledgeAssetRecord[]>().notNull(),
    documentCount: int("documentCount").default(0).notNull(),
    imageCount: int("imageCount").default(0).notNull(),
    characterCount: int("characterCount").default(0).notNull(),
    totalBytes: int("totalBytes", { unsigned: true }).default(0).notNull(),
    status: mysqlEnum("status", ["active", "archived"])
      .default("active")
      .notNull(),
    createdByUserId: int("createdByUserId").references(() => users.id, {
      onDelete: "set null",
    }),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex("knowledge_base_snapshots_user_version_uq").on(
      table.userId,
      table.version,
    ),
    index("knowledge_base_snapshots_user_status_idx").on(
      table.userId,
      table.status,
    ),
    uniqueIndex("knowledge_base_snapshots_source_artifact_uq").on(
      table.userId,
      table.sourceBuildId,
      table.sourceBuildRevision,
      table.sourceArtifactHash,
    ),
  ],
);

/**
 * Durable progress ledger for the Socratic knowledge-base builder.
 *
 * conversationId is the browser-visible conversation id. Conversations are
 * persisted asynchronously with a user-prefixed internal id, so the build
 * keeps an explicit user boundary instead of racing that persistence queue.
 */
export const knowledgeBaseBuilds = mysqlTable(
  "knowledge_base_builds",
  {
    id: varchar("id", { length: 36 }).primaryKey(),
    userId: int("userId")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    conversationId: varchar("conversationId", { length: 191 }).notNull(),
    companyName: varchar("companyName", { length: 255 }).notNull(),
    companyWebsite: text("companyWebsite"),
    upstreamTaskId: varchar("upstreamTaskId", { length: 255 }),
    skillName: varchar("skillName", { length: 128 })
      .default("socratic-kb-builder")
      .notNull(),
    skillVersion: varchar("skillVersion", { length: 64 })
      .default("1")
      .notNull(),
    skillContentHash: varchar("skillContentHash", { length: 64 }),
    status: mysqlEnum("status", [
      "researching",
      "confirming",
      "ready_to_publish",
      "published",
      "protocol_error",
      "failed",
    ])
      .default("researching")
      .notNull(),
    /**
     * Monotonic build identity. Resetting/restarting a build increments the
     * generation so a delayed task from an older run can be ignored safely.
     */
    generation: int("generation", { unsigned: true }).default(1).notNull(),
    /** Monotonic version for atomic server-approved UI observations. */
    stateEpoch: int("stateEpoch", { unsigned: true }).default(0).notNull(),
    activeTurnId: varchar("activeTurnId", { length: 36 }),
    /** Cross-process claim for legacy/open builds which have no active turn. */
    recoveryLeaseOwnerHash: varchar("recoveryLeaseOwnerHash", { length: 64 }),
    recoveryLeaseExpiresAt: timestamp("recoveryLeaseExpiresAt"),
    lastAppliedOperationKey: varchar("lastAppliedOperationKey", {
      length: 128,
    }),
    currentPresentationKey: varchar("currentPresentationKey", {
      length: 191,
    }),
    revision: int("revision").default(0).notNull(),
    currentLeafId: varchar("currentLeafId", { length: 191 }),
    totalNodeCount: int("totalNodeCount").default(0).notNull(),
    confirmedCount: int("confirmedCount").default(0).notNull(),
    directPrefilledCount: int("directPrefilledCount").default(0).notNull(),
    needsVerificationCount: int("needsVerificationCount").default(0).notNull(),
    lastReconciledHash: varchar("lastReconciledHash", { length: 64 }),
    lastOutputLength: int("lastOutputLength").default(0).notNull(),
    lastOutputItemIds: json("lastOutputItemIds")
      .$type<string[]>()
      .default([])
      .notNull(),
    lastTurnUserText: longtext("lastTurnUserText"),
    lastTurnAttachmentCount: int("lastTurnAttachmentCount")
      .default(0)
      .notNull(),
    awaitingResponseSince: timestamp("awaitingResponseSince"),
    packageRevision: int("packageRevision"),
    packageTaskId: varchar("packageTaskId", { length: 255 }),
    packageOutputItemId: varchar("packageOutputItemId", { length: 255 }),
    packageFileId: varchar("packageFileId", { length: 255 }),
    packageFilename: varchar("packageFilename", { length: 512 }),
    packageDescriptorHash: varchar("packageDescriptorHash", { length: 64 }),
    /** Immutable, Dashboard-owned copy of the first-node official logo. */
    logoStorageKey: varchar("logoStorageKey", { length: 1024 }),
    logoSha256: varchar("logoSha256", { length: 64 }),
    logoBytes: int("logoBytes", { unsigned: true }),
    logoFilename: varchar("logoFilename", { length: 512 }),
    logoMimeType: varchar("logoMimeType", { length: 255 }),
    /** Immutable, Dashboard-owned copy of the validated final archive. */
    packageStorageKey: varchar("packageStorageKey", { length: 1024 }),
    packageArchiveSha256: varchar("packageArchiveSha256", { length: 64 }),
    packageSizeBytes: int("packageSizeBytes", { unsigned: true }),
    protocolErrorCode: varchar("protocolErrorCode", { length: 128 }),
    protocolError: text("protocolError"),
    publishedSnapshotId: varchar("publishedSnapshotId", {
      length: 36,
    }).references(() => knowledgeBaseSnapshots.id, { onDelete: "set null" }),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
    updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
    completedAt: timestamp("completedAt"),
    publishedAt: timestamp("publishedAt"),
  },
  (table) => [
    uniqueIndex("knowledge_base_builds_user_conversation_uq").on(
      table.userId,
      table.conversationId,
    ),
    index("knowledge_base_builds_user_status_idx").on(
      table.userId,
      table.status,
    ),
    index("knowledge_base_builds_task_idx").on(table.upstreamTaskId),
    index("knowledge_base_builds_active_turn_idx").on(table.activeTurnId),
    index("knowledge_base_builds_recovery_lease_idx").on(
      table.status,
      table.recoveryLeaseExpiresAt,
    ),
  ],
);

/** Every row is one real leaf and can only advance in ordinal order. */
export const knowledgeBaseBuildNodes = mysqlTable(
  "knowledge_base_build_nodes",
  {
    id: varchar("id", { length: 36 }).primaryKey(),
    buildId: varchar("buildId", { length: 36 })
      .notNull()
      .references(() => knowledgeBaseBuilds.id, { onDelete: "cascade" }),
    leafId: varchar("leafId", { length: 191 }).notNull(),
    branchId: varchar("branchId", { length: 128 }).notNull(),
    branchTitle: varchar("branchTitle", { length: 255 }).notNull(),
    title: varchar("title", { length: 512 }).notNull(),
    ordinal: int("ordinal").notNull(),
    status: mysqlEnum("status", [
      "pending",
      "current",
      "confirmed",
      "direct_prefilled",
      "needs_verification",
    ])
      .default("pending")
      .notNull(),
    transitionReason: text("transitionReason"),
    contentMarkdown: longtext("contentMarkdown"),
    lastUserInput: longtext("lastUserInput"),
    sourceUrls: json("sourceUrls").$type<string[]>().default([]).notNull(),
    imageUrls: json("imageUrls").$type<string[]>().default([]).notNull(),
    lastTaskId: varchar("lastTaskId", { length: 255 }),
    sourceTurnId: varchar("sourceTurnId", { length: 36 }),
    presentationKey: varchar("presentationKey", { length: 191 }),
    contentSha256: varchar("contentSha256", { length: 64 }),
    lastResponseAt: timestamp("lastResponseAt"),
    confirmedAt: timestamp("confirmedAt"),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
    updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
  },
  (table) => [
    uniqueIndex("knowledge_base_build_nodes_leaf_uq").on(
      table.buildId,
      table.leafId,
    ),
    uniqueIndex("knowledge_base_build_nodes_ordinal_uq").on(
      table.buildId,
      table.ordinal,
    ),
    index("knowledge_base_build_nodes_status_idx").on(
      table.buildId,
      table.status,
    ),
    index("knowledge_base_build_nodes_source_turn_idx").on(table.sourceTurnId),
  ],
);

/** User-requested, role-approved destructive reset of one workspace KB. */
export const knowledgeBaseResetRequests = mysqlTable(
  "knowledge_base_reset_requests",
  {
    id: varchar("id", { length: 36 }).primaryKey(),
    ticketId: varchar("ticketId", { length: 36 })
      .notNull()
      .references(() => deliveryTickets.id, { onDelete: "restrict" }),
    userId: int("userId")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    assignedProjectAssignmentId: varchar("assignedProjectAssignmentId", {
      length: 36,
    }),
    assignedMemberId: int("assignedMemberId").references(() => users.id, {
      onDelete: "set null",
    }),
    activeKey: varchar("activeKey", { length: 191 }),
    reasonCode: mysqlEnum("reasonCode", [
      "stuck",
      "upload_error",
      "build_error",
      "enterprise_materials",
      "other",
    ]).notNull(),
    reasonNote: text("reasonNote"),
    status: mysqlEnum("status", ["pending", "approved", "rejected"])
      .default("pending")
      .notNull(),
    decisionNote: text("decisionNote"),
    decidedByUserId: int("decidedByUserId").references(() => users.id, {
      onDelete: "set null",
    }),
    cleanupSummary: json("cleanupSummary").$type<{
      builds: number;
      snapshots: number;
      conversations: number;
      attachments: number;
      importReceipts: number;
    }>(),
    decidedAt: timestamp("decidedAt"),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
    updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
  },
  (table) => [
    uniqueIndex("knowledge_base_reset_requests_ticket_uq").on(table.ticketId),
    uniqueIndex("knowledge_base_reset_requests_active_key_uq").on(
      table.activeKey,
    ),
    index("knowledge_base_reset_requests_user_status_idx").on(
      table.userId,
      table.status,
    ),
    index("knowledge_base_reset_requests_member_status_idx").on(
      table.assignedMemberId,
      table.status,
    ),
    foreignKey({
      name: "kb_reset_project_assignment_fk",
      columns: [table.assignedProjectAssignmentId],
      foreignColumns: [deliveryProjectAssignments.id],
    }).onDelete("set null"),
  ],
);

/** Monotonic KB reset revision used by open browser tabs to discard old state. */
export const knowledgeBaseResetStates = mysqlTable(
  "knowledge_base_reset_states",
  {
    userId: int("userId")
      .primaryKey()
      .references(() => users.id, { onDelete: "cascade" }),
    revision: int("revision", { unsigned: true }).default(0).notNull(),
    updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
  },
);

/** Prevents an asynchronously persisted browser snapshot from resurrecting KB chat. */
export const knowledgeBaseConversationTombstones = mysqlTable(
  "knowledge_base_conversation_tombstones",
  {
    id: varchar("id", { length: 36 }).primaryKey(),
    userId: int("userId")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    publicConversationId: varchar("publicConversationId", {
      length: 191,
    }).notNull(),
    resetRequestId: varchar("resetRequestId", { length: 36 })
      .notNull()
      .references(() => knowledgeBaseResetRequests.id, {
        onDelete: "cascade",
      }),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex("kb_conversation_tombstones_user_conversation_uq").on(
      table.userId,
      table.publicConversationId,
    ),
  ],
);

/**
 * Compact reset tombstones that outlive the verbose reset ticket. They keep
 * stale browser tabs from recreating a knowledge-base conversation after the
 * ticket and its request details have passed the retention window.
 */
export const knowledgeBaseConversationRetentionTombstones = mysqlTable(
  "knowledge_base_conversation_retention_tombstones",
  {
    id: varchar("id", { length: 36 }).primaryKey(),
    userId: int("userId").notNull(),
    publicConversationId: varchar("publicConversationId", {
      length: 191,
    }).notNull(),
    resetAt: timestamp("resetAt").notNull(),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
  },
  (table) => [
    foreignKey({
      name: "kb_retention_tombstones_user_fk",
      columns: [table.userId],
      foreignColumns: [users.id],
    }).onDelete("cascade"),
    uniqueIndex("kb_retention_tombstones_user_conversation_uq").on(
      table.userId,
      table.publicConversationId,
    ),
  ],
);

/** Retry queue for deletion of KB-only local assets and upstream resources. */
export const knowledgeBaseResetCleanupJobs = mysqlTable(
  "knowledge_base_reset_cleanup_jobs",
  {
    id: varchar("id", { length: 36 }).primaryKey(),
    resetRequestId: varchar("resetRequestId", { length: 36 }),
    userId: int("userId").notNull(),
    apiCredentialId: varchar("apiCredentialId", { length: 36 }),
    kind: mysqlEnum("kind", ["task", "file", "local_asset"]).notNull(),
    /**
     * Full local storage key. Local keys can exceed the upstream identifier
     * limit, so `upstreamId` stores their SHA-256 queue identity while this
     * column preserves the lossless path used by the cleanup worker.
     */
    localAssetKey: text("localAssetKey"),
    upstreamId: varchar("upstreamId", { length: 255 }).notNull(),
    status: mysqlEnum("status", ["pending", "completed", "failed"])
      .default("pending")
      .notNull(),
    attemptCount: int("attemptCount", { unsigned: true }).default(0).notNull(),
    lastError: text("lastError"),
    completedAt: timestamp("completedAt"),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
    updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
  },
  (table) => [
    foreignKey({
      name: "kb_reset_cleanup_request_fk",
      columns: [table.resetRequestId],
      foreignColumns: [knowledgeBaseResetRequests.id],
    }).onDelete("set null"),
    foreignKey({
      name: "kb_reset_cleanup_user_fk",
      columns: [table.userId],
      foreignColumns: [users.id],
    }).onDelete("cascade"),
    foreignKey({
      name: "kb_reset_cleanup_credential_fk",
      columns: [table.apiCredentialId],
      foreignColumns: [apiCredentials.id],
    }).onDelete("set null"),
    uniqueIndex("kb_reset_cleanup_request_resource_uq").on(
      table.resetRequestId,
      table.kind,
      table.upstreamId,
    ),
    index("kb_reset_cleanup_status_attempt_idx").on(
      table.status,
      table.attemptCount,
    ),
  ],
);

/**
 * One durable draft and latest confirmed version per monitored question.
 * Conversation IDs use the public browser ID because conversation snapshots
 * are persisted asynchronously with a user-specific storage prefix.
 */
export const responseLogicEntries = mysqlTable(
  "response_logic_entries",
  {
    id: varchar("id", { length: 36 }).primaryKey(),
    userId: int("userId")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    questionId: varchar("questionId", { length: 191 }).notNull(),
    groupId: varchar("groupId", { length: 128 }).notNull(),
    groupTitle: varchar("groupTitle", { length: 255 }).notNull(),
    question: text("question").notNull(),
    intent: text("intent").notNull(),
    summary: text("summary").notNull(),
    conversationId: varchar("conversationId", { length: 191 }),
    lastTaskId: varchar("lastTaskId", { length: 255 }),
    skillName: varchar("skillName", { length: 128 })
      .default("response-logic-builder")
      .notNull(),
    skillVersion: varchar("skillVersion", { length: 64 })
      .default("1")
      .notNull(),
    skillContentHash: varchar("skillContentHash", { length: 64 }),
    draft: json("draft").$type<ResponseLogicDraft>().notNull(),
    confirmed: json("confirmed").$type<ConfirmedResponseLogic>(),
    version: int("version").default(0).notNull(),
    revision: int("revision", { unsigned: true }).default(1).notNull(),
    status: mysqlEnum("status", ["draft", "confirmed"])
      .default("draft")
      .notNull(),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
    updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
  },
  (table) => [
    uniqueIndex("response_logic_entries_user_question_uq").on(
      table.userId,
      table.questionId,
    ),
    index("response_logic_entries_user_status_idx").on(
      table.userId,
      table.status,
    ),
    uniqueIndex("response_logic_entries_user_conversation_uq").on(
      table.userId,
      table.conversationId,
    ),
  ],
);

export const conversations = mysqlTable(
  "conversations",
  {
    // Client-generated IDs are retained during the one-time local import.
    id: varchar("id", { length: 191 }).primaryKey(),
    userId: int("userId")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    apiCredentialId: varchar("apiCredentialId", { length: 36 }).references(
      () => apiCredentials.id,
      { onDelete: "set null" },
    ),
    projectAssignmentId: varchar("projectAssignmentId", { length: 36 }),
    title: varchar("title", { length: 255 }).notNull(),
    status: mysqlEnum("status", [
      "idle",
      "running",
      "pending",
      "awaiting_input",
      "completed",
      "error",
      "failed",
      "archived",
    ])
      .default("idle")
      .notNull(),
    upstreamTaskId: varchar("upstreamTaskId", { length: 255 }),
    previousResponseId: varchar("previousResponseId", { length: 255 }),
    taskUrl: text("taskUrl"),
    lastKnownOutputLength: int("lastKnownOutputLength").default(0).notNull(),
    deletedMessageIds: json("deletedMessageIds")
      .$type<string[]>()
      .default([])
      .notNull(),
    version: int("version").default(1).notNull(),
    startedAt: timestamp("startedAt"),
    completedAt: timestamp("completedAt"),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
    updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
    deletedAt: timestamp("deletedAt"),
  },
  (table) => [
    index("conversations_user_updated_idx").on(table.userId, table.updatedAt),
    index("conversations_user_status_idx").on(table.userId, table.status),
    index("conversations_user_project_updated_idx").on(
      table.userId,
      table.projectAssignmentId,
      table.updatedAt,
    ),
    index("conversations_updated_idx").on(table.updatedAt, table.id),
    index("conversations_upstream_task_idx").on(table.upstreamTaskId),
    foreignKey({
      name: "conversations_project_assignment_fk",
      columns: [table.projectAssignmentId],
      foreignColumns: [deliveryProjectAssignments.id],
    }).onDelete("cascade"),
  ],
);

export const conversationTurns = mysqlTable(
  "conversation_turns",
  {
    id: varchar("id", { length: 36 }).primaryKey(),
    conversationId: varchar("conversationId", { length: 191 })
      .notNull()
      .references(() => conversations.id, { onDelete: "cascade" }),
    userId: int("userId")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    apiCredentialId: varchar("apiCredentialId", { length: 36 }).references(
      () => apiCredentials.id,
      { onDelete: "set null" },
    ),
    clientRequestId: varchar("clientRequestId", { length: 128 }).notNull(),
    buildId: varchar("buildId", { length: 36 }).references(
      () => knowledgeBaseBuilds.id,
      { onDelete: "set null" },
    ),
    buildGeneration: int("buildGeneration", { unsigned: true }),
    /**
     * Stable logical-operation identity. It is nullable for legacy turns and
     * globally unique for newly reserved knowledge-base turns.
     */
    operationKey: varchar("operationKey", { length: 128 }),
    operationType: varchar("operationType", { length: 32 }),
    expectedRevision: int("expectedRevision"),
    expectedLeafId: varchar("expectedLeafId", { length: 191 }),
    requestHash: varchar("requestHash", { length: 64 }),
    upstreamIdempotencyKeyHash: varchar("upstreamIdempotencyKeyHash", {
      length: 64,
    }),
    attachmentFileIds: json("attachmentFileIds")
      .$type<string[]>()
      .default([])
      .notNull(),
    metadata: json("metadata")
      .$type<Record<string, unknown>>()
      .default({})
      .notNull(),
    leaseExpiresAt: timestamp("leaseExpiresAt"),
    model: varchar("model", { length: 128 }),
    status: mysqlEnum("status", [
      "queued",
      "running",
      "completed",
      "failed",
      "cancelled",
    ])
      .default("queued")
      .notNull(),
    upstreamTaskId: varchar("upstreamTaskId", { length: 255 }),
    errorCode: varchar("errorCode", { length: 128 }),
    errorMessage: text("errorMessage"),
    startedAt: timestamp("startedAt"),
    completedAt: timestamp("completedAt"),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
    updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
  },
  (table) => [
    uniqueIndex("conversation_turns_client_request_uq").on(
      table.conversationId,
      table.clientRequestId,
    ),
    uniqueIndex("conversation_turns_operation_key_uq").on(table.operationKey),
    index("conversation_turns_user_status_idx").on(table.userId, table.status),
    index("conversation_turns_upstream_task_idx").on(table.upstreamTaskId),
    index("conversation_turns_build_generation_idx").on(
      table.buildId,
      table.buildGeneration,
    ),
    index("conversation_turns_lease_idx").on(
      table.status,
      table.leaseExpiresAt,
    ),
  ],
);

export type MessageMetadata = {
  upstreamOutputId?: string;
  outputFiles?: Array<{ fileUrl: string; fileName: string; mimeType: string }>;
  inlineImages?: Array<{ src: string; alt?: string }>;
  elapsedTime?: number;
  responseStartedAt?: number;
  intermediateSteps?: unknown[];
  stepGroups?: unknown[];
  isStepsPlaceholder?: boolean;
  modelName?: string;
  [key: string]: unknown;
};

export const messages = mysqlTable(
  "messages",
  {
    id: varchar("id", { length: 191 }).primaryKey(),
    conversationId: varchar("conversationId", { length: 191 })
      .notNull()
      .references(() => conversations.id, { onDelete: "cascade" }),
    turnId: varchar("turnId", { length: 36 }).references(
      () => conversationTurns.id,
      { onDelete: "set null" },
    ),
    userId: int("userId")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    role: mysqlEnum("role", ["user", "assistant", "system", "tool"]).notNull(),
    content: longtext("content").notNull(),
    sequence: int("sequence").notNull(),
    metadata: json("metadata").$type<MessageMetadata>(),
    sentAt: timestamp("sentAt").defaultNow().notNull(),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
    updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
    deletedAt: timestamp("deletedAt"),
  },
  (table) => [
    uniqueIndex("messages_conversation_sequence_uq").on(
      table.conversationId,
      table.sequence,
    ),
    index("messages_user_conversation_idx").on(
      table.userId,
      table.conversationId,
    ),
    index("messages_turn_idx").on(table.turnId),
  ],
);

export const attachments = mysqlTable(
  "attachments",
  {
    id: varchar("id", { length: 191 }).primaryKey(),
    userId: int("userId")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    conversationId: varchar("conversationId", { length: 191 })
      .notNull()
      .references(() => conversations.id, { onDelete: "cascade" }),
    messageId: varchar("messageId", { length: 191 })
      .notNull()
      .references(() => messages.id, { onDelete: "cascade" }),
    apiCredentialId: varchar("apiCredentialId", { length: 36 }).references(
      () => apiCredentials.id,
      { onDelete: "set null" },
    ),
    kind: mysqlEnum("kind", ["file", "image"]).default("file").notNull(),
    fileName: varchar("fileName", { length: 512 }).notNull(),
    mimeType: varchar("mimeType", { length: 255 }),
    sizeBytes: int("sizeBytes", { unsigned: true }),
    upstreamFileId: varchar("upstreamFileId", { length: 255 }),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
    deletedAt: timestamp("deletedAt"),
  },
  (table) => [
    index("attachments_user_file_idx").on(table.userId, table.upstreamFileId),
    index("attachments_message_idx").on(table.messageId),
  ],
);

/** Security ownership ledger for all upstream task and file identifiers. */
export const upstreamResources = mysqlTable(
  "upstream_resources",
  {
    id: varchar("id", { length: 36 }).primaryKey(),
    userId: int("userId")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    apiCredentialId: varchar("apiCredentialId", { length: 36 })
      .notNull()
      .references(() => apiCredentials.id, { onDelete: "restrict" }),
    projectAssignmentId: varchar("projectAssignmentId", { length: 36 }),
    kind: mysqlEnum("kind", ["task", "file"]).notNull(),
    upstreamId: varchar("upstreamId", { length: 255 }).notNull(),
    conversationId: varchar("conversationId", { length: 191 }).references(
      () => conversations.id,
      { onDelete: "set null" },
    ),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
    /**
     * Immutable content-retention clock for user-uploaded files. Task rows and
     * assistant/external files leave these fields null. Conversation snapshots
     * must never refresh this clock.
     */
    uploadedAt: timestamp("uploadedAt"),
    contentExpiresAt: timestamp("contentExpiresAt"),
    contentDeletedAt: timestamp("contentDeletedAt"),
  },
  (table) => [
    uniqueIndex("upstream_resources_kind_id_uq").on(
      table.kind,
      table.upstreamId,
    ),
    index("upstream_resources_user_kind_id_idx").on(
      table.userId,
      table.kind,
      table.upstreamId,
    ),
    index("upstream_resources_user_project_idx").on(
      table.userId,
      table.projectAssignmentId,
    ),
    index("upstream_resources_content_expiry_idx").on(
      table.kind,
      table.contentExpiresAt,
      table.contentDeletedAt,
      table.id,
    ),
    index("upstream_resources_conversation_kind_idx").on(
      table.conversationId,
      table.kind,
    ),
    foreignKey({
      name: "upstream_resources_project_assignment_fk",
      columns: [table.projectAssignmentId],
      foreignColumns: [deliveryProjectAssignments.id],
    }).onDelete("cascade"),
  ],
);

export type User = typeof users.$inferSelect;
export type InsertUser = typeof users.$inferInsert;
export type Session = typeof sessions.$inferSelect;
export type InsertSession = typeof sessions.$inferInsert;
export type UserPasswordSetupToken =
  typeof userPasswordSetupTokens.$inferSelect;
export type InsertUserPasswordSetupToken =
  typeof userPasswordSetupTokens.$inferInsert;
export type ApiCredential = typeof apiCredentials.$inferSelect;
export type InsertApiCredential = typeof apiCredentials.$inferInsert;
export type PresalesApiCredential = typeof presalesApiCredentials.$inferSelect;
export type InsertPresalesApiCredential =
  typeof presalesApiCredentials.$inferInsert;
export type ApiUsagePolicy = typeof apiUsagePolicies.$inferSelect;
export type InsertApiUsagePolicy = typeof apiUsagePolicies.$inferInsert;
export type ApiUsageSnapshot = typeof apiUsageSnapshots.$inferSelect;
export type InsertApiUsageSnapshot = typeof apiUsageSnapshots.$inferInsert;
export type PresalesUpstreamResource =
  typeof presalesUpstreamResources.$inferSelect;
export type InsertPresalesUpstreamResource =
  typeof presalesUpstreamResources.$inferInsert;
export type PresalesOutputUrl = typeof presalesOutputUrls.$inferSelect;
export type InsertPresalesOutputUrl = typeof presalesOutputUrls.$inferInsert;
export type PresalesTaskRequest = typeof presalesTaskRequests.$inferSelect;
export type InsertPresalesTaskRequest =
  typeof presalesTaskRequests.$inferInsert;
export type PresalesMonitorRun = typeof presalesMonitorRuns.$inferSelect;
export type InsertPresalesMonitorRun = typeof presalesMonitorRuns.$inferInsert;
export type WebsitePaymentReceipt = typeof websitePaymentReceipts.$inferSelect;
export type InsertWebsitePaymentReceipt =
  typeof websitePaymentReceipts.$inferInsert;
export type WebsiteProjectOrder = typeof websiteProjectOrders.$inferSelect;
export type InsertWebsiteProjectOrder =
  typeof websiteProjectOrders.$inferInsert;
export type WebsiteUserProvision = typeof websiteUserProvisions.$inferSelect;
export type InsertWebsiteUserProvision =
  typeof websiteUserProvisions.$inferInsert;
export type ServiceContract = typeof serviceContracts.$inferSelect;
export type InsertServiceContract = typeof serviceContracts.$inferInsert;
export type ServiceQuotaPeriod = typeof serviceQuotaPeriods.$inferSelect;
export type InsertServiceQuotaPeriod = typeof serviceQuotaPeriods.$inferInsert;
export type DeliveryTicket = typeof deliveryTickets.$inferSelect;
export type InsertDeliveryTicket = typeof deliveryTickets.$inferInsert;
export type DeliveryWorkflowMilestone =
  typeof deliveryWorkflowMilestones.$inferSelect;
export type InsertDeliveryWorkflowMilestone =
  typeof deliveryWorkflowMilestones.$inferInsert;
export type DeliveryTicketEvent = typeof deliveryTicketEvents.$inferSelect;
export type InsertDeliveryTicketEvent =
  typeof deliveryTicketEvents.$inferInsert;
export type DeliveryTicketAttachment =
  typeof deliveryTicketAttachments.$inferSelect;
export type InsertDeliveryTicketAttachment =
  typeof deliveryTicketAttachments.$inferInsert;
export type WorkspaceSiteProfile = typeof workspaceSiteProfiles.$inferSelect;
export type InsertWorkspaceSiteProfile =
  typeof workspaceSiteProfiles.$inferInsert;
export type WorkspaceSiteCheck = typeof workspaceSiteChecks.$inferSelect;
export type InsertWorkspaceSiteCheck = typeof workspaceSiteChecks.$inferInsert;
export type DeliveryRedirectPreview =
  typeof deliveryRedirectPreviews.$inferSelect;
export type InsertDeliveryRedirectPreview =
  typeof deliveryRedirectPreviews.$inferInsert;
export type ServiceProgressReport = typeof serviceProgressReports.$inferSelect;
export type InsertServiceProgressReport =
  typeof serviceProgressReports.$inferInsert;
export type WorkspaceQuestion = typeof workspaceQuestions.$inferSelect;
export type InsertWorkspaceQuestion = typeof workspaceQuestions.$inferInsert;
export type KnowledgeImportReceipt =
  typeof knowledgeImportReceipts.$inferSelect;
export type InsertKnowledgeImportReceipt =
  typeof knowledgeImportReceipts.$inferInsert;
export type PurchaseIntent = typeof purchaseIntents.$inferSelect;
export type InsertPurchaseIntent = typeof purchaseIntents.$inferInsert;
export type ApiKeyOwnership = typeof apiKeyOwnership.$inferSelect;
export type InsertApiKeyOwnership = typeof apiKeyOwnership.$inferInsert;
export type UserAdminAssignment = typeof userAdminAssignments.$inferSelect;
export type InsertUserAdminAssignment =
  typeof userAdminAssignments.$inferInsert;
export type DeliveryProjectAssignment =
  typeof deliveryProjectAssignments.$inferSelect;
export type InsertDeliveryProjectAssignment =
  typeof deliveryProjectAssignments.$inferInsert;
export type UserUsageOwner = typeof userUsageOwners.$inferSelect;
export type InsertUserUsageOwner = typeof userUsageOwners.$inferInsert;
export type WorkspaceAuditEvent = typeof workspaceAuditEvents.$inferSelect;
export type InsertWorkspaceAuditEvent =
  typeof workspaceAuditEvents.$inferInsert;
export type DashboardImportPreflight =
  typeof dashboardImportPreflights.$inferSelect;
export type InsertDashboardImportPreflight =
  typeof dashboardImportPreflights.$inferInsert;
export type UserDashboardContent = typeof userDashboardContents.$inferSelect;
export type InsertUserDashboardContent =
  typeof userDashboardContents.$inferInsert;
export type WorkspaceContentRevision =
  typeof workspaceContentRevisions.$inferSelect;
export type InsertWorkspaceContentRevision =
  typeof workspaceContentRevisions.$inferInsert;
export type KnowledgeBaseSnapshot = typeof knowledgeBaseSnapshots.$inferSelect;
export type InsertKnowledgeBaseSnapshot =
  typeof knowledgeBaseSnapshots.$inferInsert;
export type KnowledgeBaseBuild = typeof knowledgeBaseBuilds.$inferSelect;
export type InsertKnowledgeBaseBuild = typeof knowledgeBaseBuilds.$inferInsert;
export type KnowledgeBaseBuildNode =
  typeof knowledgeBaseBuildNodes.$inferSelect;
export type InsertKnowledgeBaseBuildNode =
  typeof knowledgeBaseBuildNodes.$inferInsert;
export type KnowledgeBaseResetRequest =
  typeof knowledgeBaseResetRequests.$inferSelect;
export type InsertKnowledgeBaseResetRequest =
  typeof knowledgeBaseResetRequests.$inferInsert;
export type KnowledgeBaseResetState =
  typeof knowledgeBaseResetStates.$inferSelect;
export type KnowledgeBaseConversationTombstone =
  typeof knowledgeBaseConversationTombstones.$inferSelect;
export type KnowledgeBaseConversationRetentionTombstone =
  typeof knowledgeBaseConversationRetentionTombstones.$inferSelect;
export type KnowledgeBaseResetCleanupJob =
  typeof knowledgeBaseResetCleanupJobs.$inferSelect;
export type ResponseLogicEntry = typeof responseLogicEntries.$inferSelect;
export type InsertResponseLogicEntry = typeof responseLogicEntries.$inferInsert;
export type Conversation = typeof conversations.$inferSelect;
export type InsertConversation = typeof conversations.$inferInsert;
export type ConversationTurn = typeof conversationTurns.$inferSelect;
export type InsertConversationTurn = typeof conversationTurns.$inferInsert;
export type Message = typeof messages.$inferSelect;
export type InsertMessage = typeof messages.$inferInsert;
export type Attachment = typeof attachments.$inferSelect;
export type InsertAttachment = typeof attachments.$inferInsert;
export type UpstreamResource = typeof upstreamResources.$inferSelect;
export type InsertUpstreamResource = typeof upstreamResources.$inferInsert;
