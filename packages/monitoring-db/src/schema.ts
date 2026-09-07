import { currentMonitoringEnterpriseProjectId } from "./enterprise-scope.js";
import { sql } from "drizzle-orm";
import type { KeywordEvaluation } from "@frontmind/monitoring-contracts";
import {
  type AnyMySqlColumn,
  bigint,
  boolean,
  datetime,
  decimal,
  foreignKey,
  index,
  int,
  json,
  longtext,
  mysqlEnum,
  mysqlTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  varchar,
} from "drizzle-orm/mysql-core";

export const roles = ["user", "admin"] as const;
export const userStatuses = ["active", "disabled"] as const;
export const monitorStatuses = [
  "draft",
  "active",
  "paused",
  "deleted",
] as const;
export const scheduleTypes = ["none", "daily", "weekly"] as const;
export const runTriggers = ["manual", "scheduled", "catch_up"] as const;
export const runStatuses = [
  "queued",
  "waiting_quota",
  "running",
  "completed",
  "partial_completed",
  "failed",
  "review_required",
  "cancelled",
] as const;
export const attemptStatuses = [
  "queued",
  "submitting",
  "submission_unknown",
  "accepted",
  "processing",
  "completed",
  "failed",
  "stopped",
  "error",
  "cancelled_before_submit",
  "review_required",
] as const;
export const clientTypes = ["web", "mobile"] as const;
export const providerModes = ["search", "reasoning_search"] as const;
export const platformPricingClasses = ["domestic", "overseas"] as const;
export const platformAcceptanceStatuses = [
  "pending",
  "running",
  "passed",
  "failed",
  "unsupported",
  "stale",
] as const;
export const platformAcceptanceDimensions = [
  "search_default",
  "reasoning_search",
  "screenshot_mention",
  "screenshot_all",
  "region_default",
  "region_domestic",
  "region_overseas",
  "mobile_no_region",
] as const;
export const sentiments = [
  "positive",
  "neutral",
  "negative",
  "unknown",
] as const;
export const quotaSettlements = ["reserved", "consumed", "released"] as const;
export const quotaEntryTypes = [
  "grant",
  "adjust",
  "reserve",
  "consume",
  "release",
] as const;
export const pricingVersionStatuses = ["active", "retired"] as const;
export const moneyReservationStatuses = ["active", "settled"] as const;
export const moneySettlementStatuses = [
  "reserved",
  "consumed",
  "released",
] as const;
export const moneyLedgerEntryTypes = [
  "topup",
  "admin_adjustment",
  "reserve",
  "consume",
  "release",
] as const;
export const topupPaymentMethods = [
  "alipay",
  "wxpay",
  "bank_transfer",
] as const;
export const topupOrderStates = [
  "pending",
  "review_required",
  "paid",
  "credited",
  "expired",
  "cancelled",
  "rejected",
] as const;
export const topupReceiptProviders = ["zpay", "bank"] as const;
export const bankTransferReviewStatuses = [
  "pending",
  "approved",
  "rejected",
] as const;
export const jobStatuses = [
  "ready",
  "leased",
  "retry_wait",
  "succeeded",
  "dead",
] as const;
export const jobTypes = [
  "submit_attempt",
  "stop_attempt",
  "poll_attempt",
  "fetch_result",
  "archive_media",
  "schedule_catch_up",
  "dispatch_occurrences",
  "purge_soft_deleted",
  "reconcile_billing",
  "sync_provider_catalog",
] as const;

export const publicationModes = ["mock", "test", "live"] as const;
export const publisherArticleStatuses = ["draft", "ready", "archived"] as const;
export const publisherImportStatuses = [
  "uploaded",
  "validating",
  "parsing",
  "ready",
  "rejected",
  "failed",
] as const;
export const publisherImageSupportStatuses = [
  "unknown",
  "verified",
  "unsupported",
] as const;
export const publisherMediaKinds = ["news", "self_media"] as const;
export const publisherHistoricalMediaKinds = [
  "news",
  "self_media",
  "unknown",
] as const;
export const publisherTitleModes = ["single", "per_media"] as const;
export const publisherMediaSyncStatuses = [
  "running",
  "success",
  "partial",
  "failed",
] as const;
export const publisherMediaLogoArchiveStatuses = [
  "pending",
  "archived",
  "pending_review",
  "missing",
  "failed",
] as const;
export const publisherMediaLogoSourceKinds = [
  "logo",
  "icon",
  "site_favicon",
  "web_search_verified",
  "manual_verified",
  "generated_fallback",
] as const;
export type PublisherMediaLogoReviewAudit = {
  searchProvider: string;
  queryHash: string;
  candidateImageUrl: string;
  pageUrl: string;
  evidenceUrl: string | null;
  officialDomain: string | null;
  matchedName: string;
  verification: "unverified" | "case_domain" | "official_registry";
  observedAt: string;
};
export const publisherDraftStatuses = [
  "draft",
  "ready",
  "submitted",
  "archived",
] as const;
export const publisherBatchStatuses = [
  "queued",
  "processing",
  "success",
  "failed",
  "partial_success",
  "action_required",
] as const;
export const publisherItemStatuses = [
  "queued",
  "submitting",
  "processing",
  "success",
  "failed",
  "auth_blocked",
  "submission_unknown",
  "action_required",
] as const;
export const publisherFundsStatuses = [
  "reserved",
  "frozen",
  "consumed",
  "released",
] as const;
export const publisherJobTypes = [
  "import_docx",
  "sync_kol_catalog",
  "archive_publisher_media_logo",
  "submit_publication_item",
  "poll_publication_item",
  "reconcile_publication_unknown",
  "purge_publisher_assets",
] as const;
export const publisherJobStatuses = [
  "ready",
  "leased",
  "retry_wait",
  "paused",
  "succeeded",
  "dead",
] as const;
export const publisherAttemptResults = [
  "succeeded",
  "business_rejected",
  "auth_blocked",
  "submission_unknown",
] as const;
export const publisherCredentialStatuses = [
  "unconfigured",
  "healthy",
  "auth_blocked",
  "unknown",
] as const;
export const publisherWebhookSignatureStatuses = [
  "not_configured",
  "verified",
  "invalid",
] as const;
export const publisherWebhookEventStatuses = [
  "received",
  "queued",
  "processed",
  "unmatched",
  "rejected",
] as const;
export const mediaPublishingReservationStatuses = [
  "active",
  "settled",
] as const;
export const mediaPublishingLedgerEntryTypes = [
  "topup",
  "admin_adjustment",
  "reserve",
  "freeze",
  "consume",
  "release",
] as const;
export const walletScopes = ["monitoring", "media_publishing"] as const;

const id = (name: string) => varchar(name, { length: 36 });
const createdAt = () =>
  timestamp("created_at", { mode: "date", fsp: 3 }).notNull().defaultNow();
const updatedAt = () =>
  timestamp("updated_at", { mode: "date", fsp: 3 })
    .notNull()
    .defaultNow()
    .onUpdateNow();

export const users = mysqlTable(
  "monitoring_users",
  {
    id: id("id").primaryKey(),
    username: varchar("username", { length: 64 }).notNull(),
    passwordHash: varchar("password_hash", { length: 255 }).notNull(),
    role: mysqlEnum("role", roles).notNull().default("user"),
    status: mysqlEnum("status", userStatuses).notNull().default("active"),
    sessionVersion: int("session_version", { unsigned: true })
      .notNull()
      .default(1),
    passwordChangedAt: datetime("password_changed_at", {
      mode: "date",
      fsp: 3,
    }).notNull(),
    lastLoginAt: datetime("last_login_at", { mode: "date", fsp: 3 }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    uniqueIndex("users_username_uq").on(table.username),
    index("users_status_idx").on(table.status),
  ],
);

export const sessions = mysqlTable(
  "monitoring_sessions",
  {
    id: id("id").primaryKey(),
    userId: id("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    tokenHash: varchar("token_hash", { length: 64 }).notNull(),
    sessionVersion: int("session_version", { unsigned: true }).notNull(),
    expiresAt: datetime("expires_at", { mode: "date", fsp: 3 }).notNull(),
    revokedAt: datetime("revoked_at", { mode: "date", fsp: 3 }),
    lastSeenAt: datetime("last_seen_at", { mode: "date", fsp: 3 }).notNull(),
    ipHash: varchar("ip_hash", { length: 64 }),
    userAgent: varchar("user_agent", { length: 512 }),
    createdAt: createdAt(),
  },
  (table) => [
    uniqueIndex("sessions_token_hash_uq").on(table.tokenHash),
    index("sessions_user_active_idx").on(
      table.userId,
      table.revokedAt,
      table.expiresAt,
    ),
  ],
);

export const projects = mysqlTable(
  "projects",
  {
    enterpriseProjectId: id("enterprise_project_id"),
    id: id("id").primaryKey(),
    ownerId: id("owner_id")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    name: varchar("name", { length: 120 }).notNull(),
    timezone: varchar("timezone", { length: 64 })
      .notNull()
      .default("Asia/Shanghai"),
    currentBrandVersionId: id("current_brand_version_id"),
    deletedAt: datetime("deleted_at", { mode: "date", fsp: 3 }),
    purgeAfter: datetime("purge_after", { mode: "date", fsp: 3 }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    index("projects_owner_created_idx").on(table.ownerId, table.createdAt),
    index("projects_enterprise_scope_idx").on(
      table.ownerId,
      table.enterpriseProjectId,
    ),
    index("projects_purge_idx").on(table.purgeAfter),
  ],
);

export const projectBrandVersions = mysqlTable(
  "project_brand_versions",
  {
    id: id("id").primaryKey(),
    projectId: id("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    version: int("version", { unsigned: true }).notNull(),
    mainBrand: varchar("main_brand", { length: 120 }).notNull(),
    aliases: json("aliases").$type<string[]>().notNull(),
    competitors: json("competitors")
      .$type<Array<{ name: string; aliases: string[] }>>()
      .notNull(),
    createdBy: id("created_by")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    createdAt: createdAt(),
  },
  (table) => [
    uniqueIndex("project_brand_versions_project_version_uq").on(
      table.projectId,
      table.version,
    ),
  ],
);

export const projectQuestions = mysqlTable(
  "project_questions",
  {
    id: id("id").primaryKey(),
    projectId: id("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    normalizedHash: varchar("normalized_hash", { length: 64 }).notNull(),
    question: text("question").notNull(),
    createdBy: id("created_by")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    createdAt: createdAt(),
  },
  (table) => [
    uniqueIndex("project_questions_project_hash_uq").on(
      table.projectId,
      table.normalizedHash,
    ),
  ],
);

export const platformCatalog = mysqlTable(
  "platform_catalog",
  {
    id: id("id").primaryKey(),
    providerCode: varchar("provider_code", { length: 64 }).notNull(),
    displayName: varchar("display_name", { length: 100 }).notNull(),
    clientType: mysqlEnum("client_type", clientTypes).notNull(),
    pricingClass: mysqlEnum("pricing_class", platformPricingClasses),
    enabled: boolean("enabled").notNull().default(false),
    verified: boolean("verified").notNull().default(false),
    supportsReasoning: boolean("supports_reasoning").notNull().default(false),
    supportsScreenshot: boolean("supports_screenshot").notNull().default(false),
    supportsDomesticRegion: boolean("supports_domestic_region")
      .notNull()
      .default(false),
    supportsOverseasRegion: boolean("supports_overseas_region")
      .notNull()
      .default(false),
    acceptanceRequired: boolean("acceptance_required").notNull().default(false),
    providerMetadata:
      json("provider_metadata").$type<Record<string, unknown>>(),
    acceptanceFingerprint: varchar("acceptance_fingerprint", { length: 64 }),
    discoveredAt: datetime("discovered_at", { mode: "date", fsp: 3 }).notNull(),
    verifiedAt: datetime("verified_at", { mode: "date", fsp: 3 }),
    updatedBy: id("updated_by").references(() => users.id, {
      onDelete: "set null",
    }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    uniqueIndex("platform_catalog_provider_client_uq").on(
      table.providerCode,
      table.clientType,
    ),
    index("platform_catalog_enabled_idx").on(table.enabled, table.verified),
  ],
);

export const monitors = mysqlTable(
  "monitors",
  {
    id: id("id").primaryKey(),
    ownerId: id("owner_id")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    projectId: id("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    name: varchar("name", { length: 120 }).notNull(),
    status: mysqlEnum("status", monitorStatuses).notNull().default("draft"),
    activeVersionId: id("active_version_id"),
    scheduleType: mysqlEnum("schedule_type", scheduleTypes)
      .notNull()
      .default("none"),
    scheduleTimezone: varchar("schedule_timezone", { length: 64 })
      .notNull()
      .default("Asia/Shanghai"),
    scheduleLocalTime: varchar("schedule_local_time", { length: 5 })
      .notNull()
      .default("09:00"),
    scheduleWeekday: int("schedule_weekday", { unsigned: true }),
    nextRunAt: datetime("next_run_at", { mode: "date", fsp: 3 }),
    lastScheduledFor: datetime("last_scheduled_for", { mode: "date", fsp: 3 }),
    deletedAt: datetime("deleted_at", { mode: "date", fsp: 3 }),
    purgeAfter: datetime("purge_after", { mode: "date", fsp: 3 }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    index("monitors_owner_project_idx").on(
      table.ownerId,
      table.projectId,
      table.createdAt,
    ),
    index("monitors_due_idx").on(table.status, table.nextRunAt),
    index("monitors_purge_idx").on(table.purgeAfter),
  ],
);

export const monitorVersions = mysqlTable(
  "monitor_versions",
  {
    id: id("id").primaryKey(),
    monitorId: id("monitor_id")
      .notNull()
      .references(() => monitors.id, { onDelete: "cascade" }),
    projectBrandVersionId: id("project_brand_version_id")
      .notNull()
      .references(() => projectBrandVersions.id, { onDelete: "restrict" }),
    version: int("version", { unsigned: true }).notNull(),
    name: varchar("name", { length: 120 }).notNull(),
    brandAliases: json("brand_aliases").$type<string[]>().notNull(),
    competitors: json("competitors")
      .$type<Array<{ name: string; aliases: string[] }>>()
      .notNull(),
    repetitions: int("repetitions", { unsigned: true }).notNull(),
    expectedAttempts: int("expected_attempts", { unsigned: true }).notNull(),
    configurationHash: varchar("configuration_hash", { length: 64 }).notNull(),
    createdBy: id("created_by")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    createdAt: createdAt(),
  },
  (table) => [
    uniqueIndex("monitor_versions_monitor_version_uq").on(
      table.monitorId,
      table.version,
    ),
    index("monitor_versions_hash_idx").on(table.configurationHash),
  ],
);

export const monitorQuestions = mysqlTable(
  "monitor_questions",
  {
    monitorVersionId: id("monitor_version_id")
      .notNull()
      .references(() => monitorVersions.id, { onDelete: "cascade" }),
    ordinal: int("ordinal", { unsigned: true }).notNull(),
    questionId: id("question_id")
      .notNull()
      .references(() => projectQuestions.id, { onDelete: "restrict" }),
    questionSnapshot: text("question_snapshot").notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.monitorVersionId, table.ordinal] }),
    uniqueIndex("monitor_questions_version_question_uq").on(
      table.monitorVersionId,
      table.questionId,
    ),
  ],
);

export const monitorPlatforms = mysqlTable(
  "monitor_platforms",
  {
    monitorVersionId: id("monitor_version_id")
      .notNull()
      .references(() => monitorVersions.id, { onDelete: "cascade" }),
    ordinal: int("ordinal", { unsigned: true }).notNull(),
    platformId: id("platform_id")
      .notNull()
      .references(() => platformCatalog.id, { onDelete: "restrict" }),
    providerCodeSnapshot: varchar("provider_code_snapshot", {
      length: 64,
    }).notNull(),
    clientType: mysqlEnum("client_type", clientTypes).notNull(),
    mode: mysqlEnum("mode", providerModes).notNull(),
    screenshot: int("screenshot", { unsigned: true }).notNull().default(1),
    regionCode: varchar("region_code", { length: 64 }),
  },
  (table) => [
    primaryKey({ columns: [table.monitorVersionId, table.ordinal] }),
    uniqueIndex("monitor_platforms_version_platform_uq").on(
      table.monitorVersionId,
      table.platformId,
    ),
  ],
);

export const scheduleOccurrences = mysqlTable(
  "schedule_occurrences",
  {
    id: id("id").primaryKey(),
    monitorId: id("monitor_id")
      .notNull()
      .references(() => monitors.id, { onDelete: "cascade" }),
    monitorVersionId: id("monitor_version_id")
      .notNull()
      .references(() => monitorVersions.id, { onDelete: "restrict" }),
    scheduledFor: datetime("scheduled_for", { mode: "date", fsp: 3 }).notNull(),
    trigger: mysqlEnum("trigger", ["scheduled", "catch_up"] as const).notNull(),
    runId: id("run_id"),
    waitingForQuotaAt: datetime("waiting_for_quota_at", {
      mode: "date",
      fsp: 3,
    }),
    createdAt: createdAt(),
  },
  (table) => [
    uniqueIndex("schedule_occurrences_monitor_time_uq").on(
      table.monitorId,
      table.scheduledFor,
    ),
    index("schedule_occurrences_time_idx").on(table.scheduledFor),
    index("schedule_occurrences_quota_idx").on(
      table.waitingForQuotaAt,
      table.scheduledFor,
    ),
  ],
);

export const runs = mysqlTable(
  "runs",
  {
    id: id("id").primaryKey(),
    ownerId: id("owner_id")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    projectId: id("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "restrict" }),
    projectBrandVersionId: id("project_brand_version_id")
      .notNull()
      .references(() => projectBrandVersions.id, { onDelete: "restrict" }),
    monitorId: id("monitor_id")
      .notNull()
      .references(() => monitors.id, { onDelete: "restrict" }),
    monitorVersionId: id("monitor_version_id")
      .notNull()
      .references(() => monitorVersions.id, { onDelete: "restrict" }),
    scheduleOccurrenceId: id("schedule_occurrence_id").references(
      () => scheduleOccurrences.id,
      { onDelete: "set null" },
    ),
    trigger: mysqlEnum("trigger", runTriggers).notNull(),
    status: mysqlEnum("status", runStatuses).notNull().default("queued"),
    idempotencyKey: varchar("idempotency_key", { length: 128 }).notNull(),
    expectedAttempts: int("expected_attempts", { unsigned: true }).notNull(),
    completedAttempts: int("completed_attempts", { unsigned: true })
      .notNull()
      .default(0),
    failedAttempts: int("failed_attempts", { unsigned: true })
      .notNull()
      .default(0),
    stoppedAttempts: int("stopped_attempts", { unsigned: true })
      .notNull()
      .default(0),
    submittedAttempts: int("submitted_attempts", { unsigned: true })
      .notNull()
      .default(0),
    startedAt: datetime("started_at", { mode: "date", fsp: 3 }),
    completedAt: datetime("completed_at", { mode: "date", fsp: 3 }),
    cancelRequestedAt: datetime("cancel_requested_at", {
      mode: "date",
      fsp: 3,
    }),
    deletedAt: datetime("deleted_at", { mode: "date", fsp: 3 }),
    purgeAfter: datetime("purge_after", { mode: "date", fsp: 3 }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    uniqueIndex("runs_owner_idempotency_uq").on(
      table.ownerId,
      table.idempotencyKey,
    ),
    uniqueIndex("runs_occurrence_uq").on(table.scheduleOccurrenceId),
    index("runs_owner_monitor_created_idx").on(
      table.ownerId,
      table.monitorId,
      table.createdAt,
    ),
    index("runs_owner_monitor_created_id_idx").on(
      table.ownerId,
      table.monitorId,
      table.createdAt,
      table.id,
    ),
    index("runs_monitor_active_idx").on(
      table.monitorId,
      table.status,
      table.createdAt,
    ),
    index("runs_purge_idx").on(table.purgeAfter),
  ],
);

export type RunModelMetric = {
  platformId: string;
  providerCode: string;
  clientType: (typeof clientTypes)[number];
  mode: (typeof providerModes)[number];
  effectiveAnswers: number;
  brandMentionedAnswers: number;
  mentionPositionSum: number;
  mentionPositionCount: number;
  citationCount: number;
  positiveCount: number;
  neutralCount: number;
  negativeCount: number;
  unknownCount: number;
};

export type RunCompetitorMetric = {
  name: string;
  appearances: number;
  positionSum: number;
  positionCount: number;
};

/**
 * Dashboard-only aggregates. The worker updates this row in the same
 * transaction as the authoritative attempt result, so dashboard reads never
 * need to touch attempt_results (which owns the LONGTEXT answer payload).
 */
export const runMetrics = mysqlTable("run_metrics", {
  runId: id("run_id")
    .primaryKey()
    .references(() => runs.id, { onDelete: "cascade" }),
  effectiveAnswers: int("effective_answers", { unsigned: true })
    .notNull()
    .default(0),
  brandMentionedAnswers: int("brand_mentioned_answers", { unsigned: true })
    .notNull()
    .default(0),
  mentionPositionSum: bigint("mention_position_sum", {
    mode: "number",
    unsigned: true,
  })
    .notNull()
    .default(0),
  mentionPositionCount: int("mention_position_count", { unsigned: true })
    .notNull()
    .default(0),
  citationCount: int("citation_count", { unsigned: true }).notNull().default(0),
  uniqueDomainCount: int("unique_domain_count", { unsigned: true })
    .notNull()
    .default(0),
  positiveCount: int("positive_count", { unsigned: true }).notNull().default(0),
  neutralCount: int("neutral_count", { unsigned: true }).notNull().default(0),
  negativeCount: int("negative_count", { unsigned: true }).notNull().default(0),
  unknownCount: int("unknown_count", { unsigned: true }).notNull().default(0),
  modelMetrics: json("model_metrics").$type<RunModelMetric[]>().notNull(),
  competitorMetrics: json("competitor_metrics")
    .$type<RunCompetitorMetric[]>()
    .notNull(),
  updatedAt: updatedAt(),
});

/** Exact ref-counts make unique-domain aggregation revision-safe. */
export const runMetricDomains = mysqlTable(
  "run_metric_domains",
  {
    runId: id("run_id")
      .notNull()
      .references(() => runs.id, { onDelete: "cascade" }),
    domain: varchar("domain", { length: 255 }).notNull(),
    referenceCount: int("reference_count", { unsigned: true }).notNull(),
  },
  (table) => [primaryKey({ columns: [table.runId, table.domain] })],
);

export const attempts = mysqlTable(
  "attempts",
  {
    id: id("id").primaryKey(),
    runId: id("run_id")
      .notNull()
      .references(() => runs.id, { onDelete: "cascade" }),
    ownerId: id("owner_id")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    monitorQuestionOrdinal: int("monitor_question_ordinal", {
      unsigned: true,
    }).notNull(),
    monitorPlatformOrdinal: int("monitor_platform_ordinal", {
      unsigned: true,
    }).notNull(),
    repetition: int("repetition", { unsigned: true }).notNull(),
    question: text("question").notNull(),
    platformId: id("platform_id")
      .notNull()
      .references(() => platformCatalog.id, { onDelete: "restrict" }),
    providerCode: varchar("provider_code", { length: 64 }).notNull(),
    clientType: mysqlEnum("client_type", clientTypes).notNull(),
    mode: mysqlEnum("mode", providerModes).notNull(),
    screenshot: int("screenshot", { unsigned: true }).notNull(),
    regionCode: varchar("region_code", { length: 64 }),
    status: mysqlEnum("status", attemptStatuses).notNull().default("queued"),
    consumerTaskId: varchar("consumer_task_id", { length: 64 }).notNull(),
    providerTaskId: varchar("provider_task_id", { length: 128 }),
    providerSubTaskId: varchar("provider_sub_task_id", { length: 128 }),
    quotaSettlement: mysqlEnum("quota_settlement", quotaSettlements)
      .notNull()
      .default("reserved"),
    errorCode: varchar("error_code", { length: 64 }),
    errorMessage: text("error_message"),
    providerCreatedAtRaw: bigint("provider_created_at_raw", { mode: "number" }),
    providerUpdatedAtRaw: bigint("provider_updated_at_raw", { mode: "number" }),
    nextPollAt: datetime("next_poll_at", { mode: "date", fsp: 3 }),
    stopRequestedAt: datetime("stop_requested_at", { mode: "date", fsp: 3 }),
    stopAccepted: boolean("stop_accepted"),
    submittedAt: datetime("submitted_at", { mode: "date", fsp: 3 }),
    terminalAt: datetime("terminal_at", { mode: "date", fsp: 3 }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    uniqueIndex("attempts_run_slot_uq").on(
      table.runId,
      table.monitorQuestionOrdinal,
      table.monitorPlatformOrdinal,
      table.repetition,
    ),
    uniqueIndex("attempts_consumer_task_uq").on(table.consumerTaskId),
    index("attempts_provider_task_idx").on(table.providerTaskId),
    index("attempts_run_status_idx").on(table.runId, table.status),
  ],
);

export const resultRevisions = mysqlTable(
  "result_revisions",
  {
    id: id("id").primaryKey(),
    attemptId: id("attempt_id")
      .notNull()
      .references(() => attempts.id, { onDelete: "cascade" }),
    revision: int("revision", { unsigned: true }).notNull(),
    contentHash: varchar("content_hash", { length: 64 }).notNull(),
    normalizedPayload: json("normalized_payload")
      .$type<Record<string, unknown>>()
      .notNull(),
    rawObjectKey: varchar("raw_object_key", { length: 1_024 }),
    providerUpdatedAtRaw: bigint("provider_updated_at_raw", { mode: "number" }),
    createdAt: createdAt(),
  },
  (table) => [
    uniqueIndex("result_revisions_attempt_revision_uq").on(
      table.attemptId,
      table.revision,
    ),
    uniqueIndex("result_revisions_attempt_hash_uq").on(
      table.attemptId,
      table.contentHash,
    ),
  ],
);

export const attemptResults = mysqlTable(
  "attempt_results",
  {
    attemptId: id("attempt_id")
      .primaryKey()
      .references(() => attempts.id, { onDelete: "cascade" }),
    currentRevisionId: id("current_revision_id")
      .notNull()
      .references(() => resultRevisions.id, { onDelete: "restrict" }),
    revision: int("revision", { unsigned: true }).notNull(),
    contentHash: varchar("content_hash", { length: 64 }).notNull(),
    answerMarkdown: longtext("answer_markdown").notNull(),
    reasoningMarkdown: longtext("reasoning_markdown"),
    searchKeywords: json("search_keywords").$type<string[]>().notNull(),
    sentiment: mysqlEnum("sentiment", sentiments).notNull().default("unknown"),
    brandMentioned: boolean("brand_mentioned").notNull().default(false),
    mentionPosition: int("mention_position", { unsigned: true }),
    competitorRankings: json("competitor_rankings")
      .$type<Array<Record<string, unknown>>>()
      .notNull(),
    keywordEvaluations: json("keyword_evaluations")
      .$type<KeywordEvaluation[]>()
      .notNull(),
    categoryRanking: json("category_ranking").$type<Record<string, unknown>>(),
    providerAmount: decimal("provider_amount", { precision: 14, scale: 4 }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    index("attempt_results_sentiment_idx").on(table.sentiment),
    index("attempt_results_mention_idx").on(table.brandMentioned),
  ],
);

export const resultSources = mysqlTable(
  "result_sources",
  {
    id: id("id").primaryKey(),
    revisionId: id("revision_id")
      .notNull()
      .references(() => resultRevisions.id, { onDelete: "cascade" }),
    ordinal: int("ordinal", { unsigned: true }).notNull(),
    providerPosition: int("provider_position", { unsigned: true }),
    url: text("url").notNull(),
    canonicalUrlHash: varchar("canonical_url_hash", { length: 64 }).notNull(),
    title: text("title").notNull(),
    domain: varchar("domain", { length: 255 }).notNull(),
    citedText: text("cited_text"),
    createdAt: createdAt(),
  },
  (table) => [
    uniqueIndex("result_sources_revision_ordinal_uq").on(
      table.revisionId,
      table.ordinal,
    ),
    index("result_sources_domain_idx").on(table.domain),
  ],
);

/**
 * Every provider-discovered source for one immutable result revision.
 *
 * `result_sources` deliberately remains citation-only so older API binaries
 * and all citation metrics keep their existing meaning during rolling
 * deploys. Provider icon URLs are retained for future server-side archival,
 * but are never exposed through the public API.
 */
export const resultDiscoveredSources = mysqlTable(
  "result_discovered_sources",
  {
    id: id("id").primaryKey(),
    revisionId: id("revision_id")
      .notNull()
      .references(() => resultRevisions.id, { onDelete: "cascade" }),
    ordinal: int("ordinal", { unsigned: true }).notNull(),
    providerPosition: int("provider_position", { unsigned: true }),
    url: text("url").notNull(),
    canonicalUrlHash: varchar("canonical_url_hash", { length: 64 }).notNull(),
    title: text("title").notNull(),
    domain: varchar("domain", { length: 255 }).notNull(),
    siteName: varchar("site_name", { length: 255 }),
    summary: text("summary"),
    publishedAt: varchar("published_at", { length: 10 }),
    providerIconUrl: text("provider_icon_url"),
    isCited: boolean("is_cited").notNull().default(false),
    createdAt: createdAt(),
  },
  (table) => [
    uniqueIndex("result_discovered_sources_revision_ordinal_uq").on(
      table.revisionId,
      table.ordinal,
    ),
    uniqueIndex("result_discovered_sources_revision_url_uq").on(
      table.revisionId,
      table.canonicalUrlHash,
    ),
    index("result_discovered_sources_revision_cited_idx").on(
      table.revisionId,
      table.isCited,
    ),
    index("result_discovered_sources_domain_idx").on(table.domain),
  ],
);

export const resultMedia = mysqlTable(
  "result_media",
  {
    id: id("id").primaryKey(),
    revisionId: id("revision_id")
      .notNull()
      .references(() => resultRevisions.id, { onDelete: "cascade" }),
    type: mysqlEnum("type", [
      "screenshot",
      "image",
      "video",
      "goods",
      "raw_response",
    ] as const).notNull(),
    ordinal: int("ordinal", { unsigned: true }).notNull(),
    sourceUrl: text("source_url"),
    objectKey: varchar("object_key", { length: 1_024 }),
    thumbnailObjectKey: varchar("thumbnail_object_key", { length: 1_024 }),
    contentHash: varchar("content_hash", { length: 64 }),
    mimeType: varchar("mime_type", { length: 128 }),
    sizeBytes: bigint("size_bytes", { mode: "number", unsigned: true }),
    archiveStatus: mysqlEnum("archive_status", [
      "pending",
      "archived",
      "failed",
      "not_applicable",
    ] as const)
      .notNull()
      .default("pending"),
    archiveError: text("archive_error"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    uniqueIndex("result_media_revision_type_ordinal_uq").on(
      table.revisionId,
      table.type,
      table.ordinal,
    ),
    index("result_media_archive_idx").on(table.archiveStatus, table.createdAt),
  ],
);

/**
 * A paid provider-capability probe is planned and confirmed as one immutable
 * batch. The question is retained for local audit, while customer-facing
 * platform capability is derived only from the checks below.
 */
export const platformAcceptanceBatches = mysqlTable(
  "platform_acceptance_batches",
  {
    id: id("id").primaryKey(),
    ownerId: id("owner_id")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    projectId: id("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "restrict" }),
    requestedBy: id("requested_by")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    planFingerprint: varchar("plan_fingerprint", { length: 64 }).notNull(),
    questionHash: varchar("question_hash", { length: 64 }).notNull(),
    questionSnapshot: text("question_snapshot").notNull(),
    status: mysqlEnum("status", platformAcceptanceStatuses)
      .notNull()
      .default("pending"),
    attemptCount: int("attempt_count", { unsigned: true }).notNull(),
    totalAmountTenThousandths: bigint("total_amount_ten_thousandths", {
      mode: "bigint",
      unsigned: true,
    }).notNull(),
    idempotencyKey: varchar("idempotency_key", { length: 128 }).notNull(),
    startedAt: datetime("started_at", { mode: "date", fsp: 3 }),
    completedAt: datetime("completed_at", { mode: "date", fsp: 3 }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    uniqueIndex("platform_acceptance_request_uq").on(
      table.requestedBy,
      table.idempotencyKey,
    ),
    index("platform_acceptance_owner_created_idx").on(
      table.ownerId,
      table.createdAt,
    ),
    index("platform_acceptance_status_created_idx").on(
      table.status,
      table.createdAt,
    ),
  ],
);

export const platformAcceptanceChecks = mysqlTable(
  "platform_acceptance_checks",
  {
    id: id("id").primaryKey(),
    batchId: id("batch_id").notNull(),
    platformId: id("platform_id")
      .notNull()
      .references(() => platformCatalog.id, { onDelete: "restrict" }),
    providerCodeSnapshot: varchar("provider_code_snapshot", {
      length: 64,
    }).notNull(),
    displayNameSnapshot: varchar("display_name_snapshot", {
      length: 100,
    }).notNull(),
    clientType: mysqlEnum("client_type", clientTypes).notNull(),
    platformFingerprint: varchar("platform_fingerprint", {
      length: 64,
    }).notNull(),
    dimension: mysqlEnum("dimension", platformAcceptanceDimensions).notNull(),
    mode: mysqlEnum("mode", providerModes).notNull(),
    screenshot: int("screenshot", { unsigned: true }).notNull(),
    regionCode: varchar("region_code", { length: 64 }),
    status: mysqlEnum("status", platformAcceptanceStatuses)
      .notNull()
      .default("pending"),
    runId: id("run_id").references(() => runs.id, { onDelete: "set null" }),
    attemptId: id("attempt_id").references(() => attempts.id, {
      onDelete: "set null",
    }),
    resultHash: varchar("result_hash", { length: 64 }),
    screenshotHash: varchar("screenshot_hash", { length: 64 }),
    errorCode: varchar("error_code", { length: 64 }),
    errorSummary: varchar("error_summary", { length: 240 }),
    startedAt: datetime("started_at", { mode: "date", fsp: 3 }),
    completedAt: datetime("completed_at", { mode: "date", fsp: 3 }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    foreignKey({
      name: "platform_acceptance_checks_batch_fk",
      columns: [table.batchId],
      foreignColumns: [platformAcceptanceBatches.id],
    }).onDelete("cascade"),
    uniqueIndex("platform_acceptance_batch_dimension_uq").on(
      table.batchId,
      table.platformId,
      table.dimension,
    ),
    uniqueIndex("platform_acceptance_attempt_uq").on(table.attemptId),
    index("platform_acceptance_platform_evidence_idx").on(
      table.platformId,
      table.platformFingerprint,
      table.dimension,
      table.status,
    ),
    index("platform_acceptance_batch_status_idx").on(
      table.batchId,
      table.status,
    ),
  ],
);

export const quotaWallets = mysqlTable("quota_wallets", {
  userId: id("user_id")
    .primaryKey()
    .references(() => users.id, { onDelete: "cascade" }),
  grantedUnits: bigint("granted_units", { mode: "number", unsigned: true })
    .notNull()
    .default(0),
  consumedUnits: bigint("consumed_units", { mode: "number", unsigned: true })
    .notNull()
    .default(0),
  reservedUnits: bigint("reserved_units", { mode: "number", unsigned: true })
    .notNull()
    .default(0),
  updatedAt: updatedAt(),
});

export const quotaReservations = mysqlTable(
  "quota_reservations",
  {
    id: id("id").primaryKey(),
    userId: id("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    runId: id("run_id")
      .notNull()
      .references(() => runs.id, { onDelete: "restrict" }),
    totalUnits: int("total_units", { unsigned: true }).notNull(),
    consumedUnits: int("consumed_units", { unsigned: true })
      .notNull()
      .default(0),
    releasedUnits: int("released_units", { unsigned: true })
      .notNull()
      .default(0),
    status: mysqlEnum("status", ["active", "settled"] as const)
      .notNull()
      .default("active"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    uniqueIndex("quota_reservations_run_uq").on(table.runId),
    index("quota_reservations_user_status_idx").on(table.userId, table.status),
  ],
);

export const quotaLedger = mysqlTable(
  "quota_ledger",
  {
    id: id("id").primaryKey(),
    userId: id("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    type: mysqlEnum("type", quotaEntryTypes).notNull(),
    units: bigint("units", { mode: "number" }).notNull(),
    idempotencyKey: varchar("idempotency_key", { length: 160 }).notNull(),
    reservationId: id("reservation_id").references(() => quotaReservations.id, {
      onDelete: "restrict",
    }),
    attemptId: id("attempt_id").references(() => attempts.id, {
      onDelete: "restrict",
    }),
    actorId: id("actor_id").references(() => users.id, {
      onDelete: "set null",
    }),
    reason: varchar("reason", { length: 240 }),
    metadata: json("metadata").$type<Record<string, unknown>>(),
    createdAt: createdAt(),
  },
  (table) => [
    uniqueIndex("quota_ledger_idempotency_uq").on(table.idempotencyKey),
    index("quota_ledger_user_created_idx").on(table.userId, table.createdAt),
  ],
);

export const jobs = mysqlTable(
  "jobs",
  {
    id: id("id").primaryKey(),
    type: mysqlEnum("type", jobTypes).notNull(),
    status: mysqlEnum("status", jobStatuses).notNull().default("ready"),
    dedupeKey: varchar("dedupe_key", { length: 191 }).notNull(),
    payload: json("payload").$type<Record<string, unknown>>().notNull(),
    availableAt: datetime("available_at", { mode: "date", fsp: 3 }).notNull(),
    leaseOwner: varchar("lease_owner", { length: 128 }),
    leaseExpiresAt: datetime("lease_expires_at", { mode: "date", fsp: 3 }),
    attempts: int("attempts", { unsigned: true }).notNull().default(0),
    maxAttempts: int("max_attempts", { unsigned: true }).notNull().default(20),
    lastErrorCode: varchar("last_error_code", { length: 64 }),
    lastErrorMessage: text("last_error_message"),
    completedAt: datetime("completed_at", { mode: "date", fsp: 3 }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    uniqueIndex("jobs_dedupe_uq").on(table.dedupeKey),
    index("jobs_claim_idx").on(
      table.status,
      table.availableAt,
      table.leaseExpiresAt,
    ),
  ],
);

export const providerCosts = mysqlTable(
  "provider_costs",
  {
    id: id("id").primaryKey(),
    attemptId: id("attempt_id").references(() => attempts.id, {
      onDelete: "restrict",
    }),
    providerTaskId: varchar("provider_task_id", { length: 128 }).notNull(),
    amount: decimal("amount", { precision: 14, scale: 4 }).notNull(),
    currency: varchar("currency", { length: 3 }).notNull().default("CNY"),
    providerRecordId: varchar("provider_record_id", { length: 128 }),
    occurredAt: datetime("occurred_at", { mode: "date", fsp: 3 }).notNull(),
    rawMetadata: json("raw_metadata").$type<Record<string, unknown>>(),
    reconciledAt: datetime("reconciled_at", { mode: "date", fsp: 3 }),
    createdAt: createdAt(),
  },
  (table) => [
    uniqueIndex("provider_costs_record_uq").on(table.providerRecordId),
    index("provider_costs_task_idx").on(table.providerTaskId),
  ],
);

/**
 * Customer funds are stored in integer 1/10,000 CNY units. These tables are
 * deliberately separate from the dormant integer-attempt quota tables above.
 */
export const moneyWallets = mysqlTable("unified_money_wallets", {
  userId: id("user_id")
    .primaryKey()
    .references(() => users.id, { onDelete: "cascade" }),
  currency: varchar("currency", { length: 3 }).notNull().default("CNY"),
  balanceTenThousandths: bigint("balance_ten_thousandths", {
    mode: "bigint",
  })
    .notNull()
    .default(sql`0`),
  reservedTenThousandths: bigint("reserved_ten_thousandths", {
    mode: "bigint",
    unsigned: true,
  })
    .notNull()
    .default(sql`0`),
  frozenTenThousandths: bigint("frozen_ten_thousandths", {
    mode: "bigint",
    unsigned: true,
  })
    .notNull()
    .default(sql`0`),
  aiCostRemainderNanos: bigint("ai_cost_remainder_nanos", {
    mode: "bigint",
    unsigned: true,
  })
    .notNull()
    .default(sql`0`),
  spentTenThousandths: bigint("spent_ten_thousandths", {
    mode: "bigint",
    unsigned: true,
  })
    .notNull()
    .default(sql`0`),
  updatedAt: updatedAt(),
});

export const pricingVersions = mysqlTable(
  "pricing_versions",
  {
    id: id("id").primaryKey(),
    code: varchar("code", { length: 100 }).notNull(),
    status: mysqlEnum("status", pricingVersionStatuses)
      .notNull()
      .default("active"),
    currency: varchar("currency", { length: 3 }).notNull().default("CNY"),
    sourceUrl: text("source_url").notNull(),
    effectiveFrom: datetime("effective_from", {
      mode: "date",
      fsp: 3,
    }).notNull(),
    retiredAt: datetime("retired_at", { mode: "date", fsp: 3 }),
    createdBy: id("created_by").references(() => users.id, {
      onDelete: "set null",
    }),
    createdAt: createdAt(),
  },
  (table) => [
    uniqueIndex("pricing_versions_code_uq").on(table.code),
    index("pricing_versions_status_effective_idx").on(
      table.status,
      table.effectiveFrom,
    ),
  ],
);

export const pricingItems = mysqlTable(
  "pricing_items",
  {
    id: id("id").primaryKey(),
    pricingVersionId: id("pricing_version_id")
      .notNull()
      .references(() => pricingVersions.id, { onDelete: "restrict" }),
    pricingClass: mysqlEnum("pricing_class", platformPricingClasses).notNull(),
    mode: mysqlEnum("mode", providerModes).notNull(),
    screenshotEnabled: boolean("screenshot_enabled").notNull(),
    amountTenThousandths: bigint("amount_ten_thousandths", {
      mode: "bigint",
      unsigned: true,
    }).notNull(),
    createdAt: createdAt(),
  },
  (table) => [
    uniqueIndex("pricing_items_version_dimensions_uq").on(
      table.pricingVersionId,
      table.pricingClass,
      table.mode,
      table.screenshotEnabled,
    ),
  ],
);

export const moneyReservations = mysqlTable(
  "money_reservations",
  {
    id: id("id").primaryKey(),
    userId: id("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    runId: id("run_id").references(() => runs.id, {
      onDelete: "set null",
    }),
    totalTenThousandths: bigint("total_ten_thousandths", {
      mode: "bigint",
      unsigned: true,
    }).notNull(),
    consumedTenThousandths: bigint("consumed_ten_thousandths", {
      mode: "bigint",
      unsigned: true,
    })
      .notNull()
      .default(sql`0`),
    releasedTenThousandths: bigint("released_ten_thousandths", {
      mode: "bigint",
      unsigned: true,
    })
      .notNull()
      .default(sql`0`),
    status: mysqlEnum("status", moneyReservationStatuses)
      .notNull()
      .default("active"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    uniqueIndex("money_reservations_run_uq").on(table.runId),
    index("money_reservations_user_status_idx").on(table.userId, table.status),
  ],
);

/** Immutable quote copied onto each provider attempt before submission. */
export const attemptPriceSnapshots = mysqlTable(
  "attempt_price_snapshots",
  {
    attemptId: id("attempt_id")
      .primaryKey()
      .references(() => attempts.id, { onDelete: "cascade" }),
    pricingVersionId: id("pricing_version_id")
      .notNull()
      .references(() => pricingVersions.id, { onDelete: "restrict" }),
    pricingItemId: id("pricing_item_id")
      .notNull()
      .references(() => pricingItems.id, { onDelete: "restrict" }),
    pricingClass: mysqlEnum("pricing_class", platformPricingClasses).notNull(),
    mode: mysqlEnum("mode", providerModes).notNull(),
    screenshotEnabled: boolean("screenshot_enabled").notNull(),
    amountTenThousandths: bigint("amount_ten_thousandths", {
      mode: "bigint",
      unsigned: true,
    }).notNull(),
    currency: varchar("currency", { length: 3 }).notNull().default("CNY"),
    createdAt: createdAt(),
  },
  (table) => [
    index("attempt_price_snapshots_version_idx").on(table.pricingVersionId),
  ],
);

export const attemptMoneySettlements = mysqlTable(
  "attempt_money_settlements",
  {
    attemptId: id("attempt_id")
      .primaryKey()
      .references(() => attempts.id, { onDelete: "cascade" }),
    reservationId: id("reservation_id")
      .notNull()
      .references(() => moneyReservations.id, { onDelete: "restrict" }),
    status: mysqlEnum("status", moneySettlementStatuses)
      .notNull()
      .default("reserved"),
    settledTenThousandths: bigint("settled_ten_thousandths", {
      mode: "bigint",
      unsigned: true,
    })
      .notNull()
      .default(sql`0`),
    settledAt: datetime("settled_at", { mode: "date", fsp: 3 }),
    updatedAt: updatedAt(),
  },
  (table) => [
    index("attempt_money_settlements_reservation_idx").on(table.reservationId),
  ],
);

export const moneyLedger = mysqlTable(
  "money_ledger",
  {
    id: id("id").primaryKey(),
    userId: id("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    type: mysqlEnum("type", moneyLedgerEntryTypes).notNull(),
    balanceDeltaTenThousandths: bigint("balance_delta_ten_thousandths", {
      mode: "bigint",
    }).notNull(),
    reservedDeltaTenThousandths: bigint("reserved_delta_ten_thousandths", {
      mode: "bigint",
    }).notNull(),
    balanceAfterTenThousandths: bigint("balance_after_ten_thousandths", {
      mode: "bigint",
    }).notNull(),
    reservedAfterTenThousandths: bigint("reserved_after_ten_thousandths", {
      mode: "bigint",
      unsigned: true,
    }).notNull(),
    idempotencyKey: varchar("idempotency_key", { length: 191 }).notNull(),
    reservationId: id("reservation_id").references(() => moneyReservations.id, {
      onDelete: "set null",
    }),
    attemptId: id("attempt_id").references(() => attempts.id, {
      onDelete: "set null",
    }),
    actorId: id("actor_id").references(() => users.id, {
      onDelete: "set null",
    }),
    referenceType: varchar("reference_type", { length: 40 }),
    referenceId: varchar("reference_id", { length: 128 }),
    reason: varchar("reason", { length: 240 }).notNull(),
    metadata: json("metadata").$type<Record<string, unknown>>(),
    createdAt: createdAt(),
  },
  (table) => [
    uniqueIndex("money_ledger_idempotency_uq").on(table.idempotencyKey),
    index("money_ledger_user_created_idx").on(table.userId, table.createdAt),
    index("money_ledger_reference_idx").on(
      table.referenceType,
      table.referenceId,
    ),
  ],
);

export const topupOrders = mysqlTable(
  "topup_orders",
  {
    id: id("id").primaryKey(),
    providerOrderId: varchar("provider_order_id", { length: 128 }).notNull(),
    replacesOrderId: id("replaces_order_id").references(
      (): AnyMySqlColumn => topupOrders.id,
      { onDelete: "restrict" },
    ),
    userId: id("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    idempotencyKey: varchar("idempotency_key", { length: 128 }).notNull(),
    paymentMethod: mysqlEnum("payment_method", topupPaymentMethods).notNull(),
    amountTenThousandths: bigint("amount_ten_thousandths", {
      mode: "bigint",
      unsigned: true,
    }).notNull(),
    currency: varchar("currency", { length: 3 }).notNull().default("CNY"),
    state: mysqlEnum("state", topupOrderStates).notNull().default("pending"),
    callbackTokenDigest: varchar("callback_token_digest", {
      length: 64,
    }).notNull(),
    checkoutExpiresAt: datetime("checkout_expires_at", {
      mode: "date",
      fsp: 3,
    }).notNull(),
    paidAt: datetime("paid_at", { mode: "date", fsp: 3 }),
    creditedAt: datetime("credited_at", { mode: "date", fsp: 3 }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    uniqueIndex("topup_orders_provider_order_uq").on(table.providerOrderId),
    uniqueIndex("topup_orders_replaces_order_uq").on(table.replacesOrderId),
    uniqueIndex("topup_orders_user_idempotency_uq").on(
      table.userId,
      table.idempotencyKey,
    ),
    index("topup_orders_user_created_idx").on(table.userId, table.createdAt),
    index("topup_orders_state_expiry_idx").on(
      table.state,
      table.checkoutExpiresAt,
    ),
  ],
);

export const topupReceipts = mysqlTable(
  "topup_receipts",
  {
    id: id("id").primaryKey(),
    orderId: id("order_id")
      .notNull()
      .references(() => topupOrders.id, { onDelete: "restrict" }),
    provider: mysqlEnum("provider", topupReceiptProviders).notNull(),
    providerTradeNo: varchar("provider_trade_no", { length: 191 }).notNull(),
    amountTenThousandths: bigint("amount_ten_thousandths", {
      mode: "bigint",
      unsigned: true,
    }).notNull(),
    paidAt: datetime("paid_at", { mode: "date", fsp: 3 }).notNull(),
    payloadDigest: varchar("payload_digest", { length: 64 }).notNull(),
    receivedAt: datetime("received_at", { mode: "date", fsp: 3 }).notNull(),
    createdAt: createdAt(),
  },
  (table) => [
    uniqueIndex("topup_receipts_order_uq").on(table.orderId),
    uniqueIndex("topup_receipts_provider_trade_uq").on(
      table.provider,
      table.providerTradeNo,
    ),
  ],
);

export const bankTransferReviews = mysqlTable(
  "bank_transfer_reviews",
  {
    id: id("id").primaryKey(),
    orderId: id("order_id")
      .notNull()
      .references(() => topupOrders.id, { onDelete: "restrict" }),
    status: mysqlEnum("status", bankTransferReviewStatuses)
      .notNull()
      .default("pending"),
    remittanceReference: varchar("remittance_reference", {
      length: 191,
    }).notNull(),
    payerName: varchar("payer_name", { length: 120 }).notNull(),
    transferredAt: datetime("transferred_at", {
      mode: "date",
      fsp: 3,
    }).notNull(),
    evidenceObjectKey: varchar("evidence_object_key", { length: 1_024 }),
    submittedAt: datetime("submitted_at", {
      mode: "date",
      fsp: 3,
    }).notNull(),
    reviewedBy: id("reviewed_by").references(() => users.id, {
      onDelete: "set null",
    }),
    reviewReason: varchar("review_reason", { length: 240 }),
    reviewedAt: datetime("reviewed_at", { mode: "date", fsp: 3 }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    uniqueIndex("bank_transfer_reviews_order_uq").on(table.orderId),
    index("bank_transfer_reviews_status_submitted_idx").on(
      table.status,
      table.submittedAt,
    ),
  ],
);

export const auditLogs = mysqlTable(
  "audit_logs",
  {
    id: id("id").primaryKey(),
    actorId: id("actor_id").references(() => users.id, {
      onDelete: "set null",
    }),
    actorRole: mysqlEnum("actor_role", roles),
    action: varchar("action", { length: 120 }).notNull(),
    targetType: varchar("target_type", { length: 64 }).notNull(),
    targetIdHash: varchar("target_id_hash", { length: 64 }),
    ownerId: id("owner_id").references(() => users.id, {
      onDelete: "set null",
    }),
    ipHash: varchar("ip_hash", { length: 64 }),
    metadata: json("metadata").$type<Record<string, unknown>>(),
    createdAt: createdAt(),
  },
  (table) => [
    index("audit_logs_actor_created_idx").on(table.actorId, table.createdAt),
    index("audit_logs_action_created_idx").on(table.action, table.createdAt),
  ],
);

export const providerTaskTombstones = mysqlTable(
  "provider_task_tombstones",
  {
    providerTaskHash: varchar("provider_task_hash", {
      length: 64,
    }).primaryKey(),
    deletedEntityType: varchar("deleted_entity_type", { length: 32 }).notNull(),
    deletedEntityIdHash: varchar("deleted_entity_id_hash", {
      length: 64,
    }).notNull(),
    expiresAt: datetime("expires_at", { mode: "date", fsp: 3 }).notNull(),
    createdAt: createdAt(),
  },
  (table) => [index("provider_task_tombstones_expiry_idx").on(table.expiresAt)],
);

export const workerHeartbeats = mysqlTable("worker_heartbeats", {
  workerId: varchar("worker_id", { length: 128 }).primaryKey(),
  heartbeatAt: datetime("heartbeat_at", { mode: "date", fsp: 3 }).notNull(),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export const providerDispatchDays = mysqlTable("provider_dispatch_days", {
  dayKey: varchar("day_key", { length: 10 }).primaryKey(),
  dispatched: int("dispatched", { unsigned: true }).notNull().default(0),
  updatedAt: updatedAt(),
});

export const providerDispatchSlots = mysqlTable(
  "provider_dispatch_slots",
  {
    attemptId: id("attempt_id")
      .primaryKey()
      .references(() => attempts.id, { onDelete: "cascade" }),
    dayKey: varchar("day_key", { length: 10 }).notNull(),
    acquiredAt: datetime("acquired_at", { mode: "date", fsp: 3 }).notNull(),
  },
  (table) => [index("provider_dispatch_slots_day_idx").on(table.dayKey)],
);

export const providerSubmissionGate = mysqlTable("provider_submission_gate", {
  id: varchar("id", { length: 32 }).primaryKey(),
  nextAllowedAt: datetime("next_allowed_at", {
    mode: "date",
    fsp: 3,
  }).notNull(),
  updatedAt: updatedAt(),
});

export const providerObservations = mysqlTable(
  "provider_observations",
  {
    id: id("id").primaryKey(),
    attemptId: id("attempt_id")
      .notNull()
      .references(() => attempts.id, { onDelete: "cascade" }),
    type: mysqlEnum("type", [
      "submission",
      "status",
      "stop",
      "failure",
    ] as const).notNull(),
    status: varchar("status", { length: 64 }),
    payload: json("payload").$type<Record<string, unknown>>(),
    observedAt: datetime("observed_at", { mode: "date", fsp: 3 }).notNull(),
    createdAt: createdAt(),
  },
  (table) => [
    index("provider_observations_attempt_idx").on(
      table.attemptId,
      table.observedAt,
    ),
  ],
);

export const providerRegions = mysqlTable(
  "provider_regions",
  {
    code: varchar("code", { length: 64 }).notNull(),
    scope: mysqlEnum("scope", ["domestic", "overseas"] as const).notNull(),
    name: varchar("name", { length: 120 }).notNull(),
    providerMetadata: json("provider_metadata")
      .$type<Record<string, unknown>>()
      .notNull(),
    syncedAt: datetime("synced_at", { mode: "date", fsp: 3 }).notNull(),
  },
  (table) => [primaryKey({ columns: [table.code, table.scope] })],
);

export const providerReconciliationState = mysqlTable(
  "provider_reconciliation_state",
  {
    id: varchar("id", { length: 32 }).primaryKey(),
    cursor: json("cursor")
      .$type<{
        startDate: string;
        endDate: string;
        page: number;
        pageSize: number;
      }>()
      .notNull(),
    balance: json("balance").$type<Record<string, unknown>>(),
    summary: json("summary").$type<Record<string, unknown>>(),
    reconciledAt: datetime("reconciled_at", { mode: "date", fsp: 3 }),
    updatedAt: updatedAt(),
  },
);

export const dailyRunAggregates = mysqlTable(
  "daily_run_aggregates",
  {
    ownerId: id("owner_id")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    monitorId: id("monitor_id")
      .notNull()
      .references(() => monitors.id, { onDelete: "cascade" }),
    monitorVersionId: id("monitor_version_id")
      .notNull()
      .references(() => monitorVersions.id, { onDelete: "restrict" }),
    aggregateDate: datetime("aggregate_date", { mode: "date" }).notNull(),
    totalAnswers: int("total_answers", { unsigned: true }).notNull().default(0),
    brandMentions: int("brand_mentions", { unsigned: true })
      .notNull()
      .default(0),
    citationCount: int("citation_count", { unsigned: true })
      .notNull()
      .default(0),
    uniqueDomainCount: int("unique_domain_count", { unsigned: true })
      .notNull()
      .default(0),
    positiveCount: int("positive_count", { unsigned: true })
      .notNull()
      .default(0),
    neutralCount: int("neutral_count", { unsigned: true }).notNull().default(0),
    negativeCount: int("negative_count", { unsigned: true })
      .notNull()
      .default(0),
    unknownCount: int("unknown_count", { unsigned: true }).notNull().default(0),
    metrics: json("metrics").$type<Record<string, unknown>>().notNull(),
    updatedAt: updatedAt(),
  },
  (table) => [
    primaryKey({
      columns: [table.monitorId, table.monitorVersionId, table.aggregateDate],
    }),
    index("daily_run_aggregates_owner_date_idx").on(
      table.ownerId,
      table.aggregateDate,
    ),
  ],
);

/**
 * Media publishing is an account-scoped product. Every customer-owned row
 * carries owner_id and owner-qualified foreign keys so repository mistakes
 * cannot attach one customer's child row to another customer's aggregate.
 */
export const publisherArticles = mysqlTable(
  "publisher_articles",
  {
    enterpriseProjectId: id("enterprise_project_id").$defaultFn(
      () => currentMonitoringEnterpriseProjectId() ?? sql`NULL`,
    ),
    id: id("id").primaryKey(),
    ownerId: id("owner_id")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    workingName: varchar("working_name", { length: 180 }).notNull(),
    suggestedTitle: varchar("suggested_title", { length: 200 }),
    status: mysqlEnum("status", publisherArticleStatuses)
      .notNull()
      .default("draft"),
    currentVersionId: id("current_version_id"),
    revision: int("revision", { unsigned: true }).notNull().default(0),
    editorJson: json("editor_json").$type<Record<string, unknown>>(),
    canonicalHtml: longtext("canonical_html"),
    plainText: longtext("plain_text"),
    contentHash: varchar("content_hash", { length: 64 }),
    containsImages: boolean("contains_images").notNull().default(false),
    archivedAt: datetime("archived_at", { mode: "date", fsp: 3 }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    index("pub_articles_enterprise_idx").on(
      table.ownerId,
      table.enterpriseProjectId,
    ),
    uniqueIndex("pub_articles_id_owner_uq").on(table.id, table.ownerId),
    uniqueIndex("pub_articles_current_version_uq").on(table.currentVersionId),
    index("pub_articles_owner_updated_idx").on(table.ownerId, table.updatedAt),
    index("pub_articles_owner_status_idx").on(table.ownerId, table.status),
  ],
);

export const publisherDocxImports = mysqlTable(
  "publisher_docx_imports",
  {
    enterpriseProjectId: id("enterprise_project_id").$defaultFn(
      () => currentMonitoringEnterpriseProjectId() ?? sql`NULL`,
    ),
    id: id("id").primaryKey(),
    ownerId: id("owner_id")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    articleId: id("article_id"),
    sourceFilename: varchar("source_filename", { length: 255 }).notNull(),
    sourceObjectKey: varchar("source_object_key", { length: 1_024 }).notNull(),
    sizeBytes: int("size_bytes", { unsigned: true }).notNull(),
    sha256: varchar("sha256", { length: 64 }).notNull(),
    mimeType: varchar("mime_type", { length: 120 }).notNull(),
    parserVersion: varchar("parser_version", { length: 64 }).notNull(),
    status: mysqlEnum("status", publisherImportStatuses)
      .notNull()
      .default("uploaded"),
    detectedTitle: varchar("detected_title", { length: 200 }),
    importReport: json("import_report").$type<Record<string, unknown>>(),
    warnings: json("warnings")
      .$type<Array<Record<string, unknown>>>()
      .notNull(),
    blockingIssues: json("blocking_issues")
      .$type<Array<Record<string, unknown>>>()
      .notNull(),
    expiresAt: datetime("expires_at", { mode: "date", fsp: 3 }).notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    index("pub_docx_imports_enterprise_idx").on(
      table.ownerId,
      table.enterpriseProjectId,
    ),
    uniqueIndex("pub_imports_id_owner_uq").on(table.id, table.ownerId),
    index("pub_imports_owner_status_idx").on(table.ownerId, table.status),
    index("pub_imports_expiry_idx").on(table.expiresAt),
    index("pub_imports_owner_sha_idx").on(table.ownerId, table.sha256),
    foreignKey({
      name: "pub_imports_article_owner_fk",
      columns: [table.articleId, table.ownerId],
      foreignColumns: [publisherArticles.id, publisherArticles.ownerId],
    }).onDelete("restrict"),
  ],
);

export const publisherArticleVersions = mysqlTable(
  "publisher_article_versions",
  {
    enterpriseProjectId: id("enterprise_project_id").$defaultFn(
      () => currentMonitoringEnterpriseProjectId() ?? sql`NULL`,
    ),
    id: id("id").primaryKey(),
    ownerId: id("owner_id")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    articleId: id("article_id").notNull(),
    version: int("version", { unsigned: true }).notNull(),
    editorJson: json("editor_json").$type<Record<string, unknown>>().notNull(),
    canonicalHtml: longtext("canonical_html").notNull(),
    plainText: longtext("plain_text").notNull(),
    contentHash: varchar("content_hash", { length: 64 }).notNull(),
    containsImages: boolean("contains_images").notNull().default(false),
    sourceImportId: id("source_import_id"),
    freezeIdempotencyKey: varchar("freeze_idempotency_key", {
      length: 191,
    }).notNull(),
    createdBy: id("created_by").references(() => users.id, {
      onDelete: "set null",
    }),
    createdAt: createdAt(),
  },
  (table) => [
    index("pub_article_versions_enterprise_idx").on(
      table.ownerId,
      table.enterpriseProjectId,
    ),
    uniqueIndex("pub_versions_id_owner_uq").on(table.id, table.ownerId),
    uniqueIndex("pub_versions_article_number_uq").on(
      table.articleId,
      table.version,
    ),
    uniqueIndex("pub_versions_owner_freeze_key_uq").on(
      table.ownerId,
      table.freezeIdempotencyKey,
    ),
    index("pub_versions_hash_idx").on(table.contentHash),
    foreignKey({
      name: "pub_versions_article_owner_fk",
      columns: [table.articleId, table.ownerId],
      foreignColumns: [publisherArticles.id, publisherArticles.ownerId],
    }).onDelete("cascade"),
    foreignKey({
      name: "pub_versions_import_owner_fk",
      columns: [table.sourceImportId, table.ownerId],
      foreignColumns: [publisherDocxImports.id, publisherDocxImports.ownerId],
    }).onDelete("restrict"),
  ],
);

export const publisherArticleAssets = mysqlTable(
  "publisher_article_assets",
  {
    enterpriseProjectId: id("enterprise_project_id").$defaultFn(
      () => currentMonitoringEnterpriseProjectId() ?? sql`NULL`,
    ),
    id: id("id").primaryKey(),
    ownerId: id("owner_id")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    articleId: id("article_id").notNull(),
    sha256: varchar("sha256", { length: 64 }).notNull(),
    mimeType: varchar("mime_type", { length: 120 }).notNull(),
    width: int("width", { unsigned: true }).notNull(),
    height: int("height", { unsigned: true }).notNull(),
    sizeBytes: int("size_bytes", { unsigned: true }).notNull(),
    storageKey: varchar("storage_key", { length: 1_024 }).notNull(),
    storageKeyHash: varchar("storage_key_hash", { length: 64 }).notNull(),
    altText: varchar("alt_text", { length: 500 }),
    sourceImportId: id("source_import_id"),
    isFrozen: boolean("is_frozen").notNull().default(false),
    publicCapabilityDigest: varchar("public_capability_digest", { length: 64 }),
    publicCapabilityCreatedAt: datetime("public_capability_created_at", {
      mode: "date",
      fsp: 3,
    }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    index("pub_article_assets_enterprise_idx").on(
      table.ownerId,
      table.enterpriseProjectId,
    ),
    uniqueIndex("pub_assets_id_owner_uq").on(table.id, table.ownerId),
    uniqueIndex("pub_assets_article_sha_uq").on(table.articleId, table.sha256),
    uniqueIndex("pub_assets_capability_uq").on(table.publicCapabilityDigest),
    index("pub_assets_storage_key_idx").on(table.storageKeyHash),
    foreignKey({
      name: "pub_assets_article_owner_fk",
      columns: [table.articleId, table.ownerId],
      foreignColumns: [publisherArticles.id, publisherArticles.ownerId],
    }).onDelete("cascade"),
    foreignKey({
      name: "pub_assets_import_owner_fk",
      columns: [table.sourceImportId, table.ownerId],
      foreignColumns: [publisherDocxImports.id, publisherDocxImports.ownerId],
    }).onDelete("restrict"),
  ],
);

export const publisherArticleVersionAssets = mysqlTable(
  "publisher_article_version_assets",
  {
    enterpriseProjectId: id("enterprise_project_id").$defaultFn(
      () => currentMonitoringEnterpriseProjectId() ?? sql`NULL`,
    ),
    ownerId: id("owner_id")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    articleVersionId: id("article_version_id").notNull(),
    assetId: id("asset_id").notNull(),
    sortOrder: int("sort_order", { unsigned: true }).notNull().default(0),
    createdAt: createdAt(),
  },
  (table) => [
    index("pub_article_version_assets_enterprise_idx").on(
      table.ownerId,
      table.enterpriseProjectId,
    ),
    primaryKey({ columns: [table.articleVersionId, table.assetId] }),
    index("pub_version_assets_owner_idx").on(table.ownerId),
    foreignKey({
      name: "pub_version_assets_version_owner_fk",
      columns: [table.articleVersionId, table.ownerId],
      foreignColumns: [
        publisherArticleVersions.id,
        publisherArticleVersions.ownerId,
      ],
    }).onDelete("cascade"),
    foreignKey({
      name: "pub_version_assets_asset_owner_fk",
      columns: [table.assetId, table.ownerId],
      foreignColumns: [
        publisherArticleAssets.id,
        publisherArticleAssets.ownerId,
      ],
    }).onDelete("restrict"),
  ],
);

export const publisherObjectLeases = mysqlTable(
  "publisher_object_leases",
  {
    enterpriseProjectId: id("enterprise_project_id").$defaultFn(
      () => currentMonitoringEnterpriseProjectId() ?? sql`NULL`,
    ),
    id: id("id").primaryKey(),
    ownerId: id("owner_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    operationId: varchar("operation_id", { length: 191 }).notNull(),
    storageKey: varchar("storage_key", { length: 1_024 }).notNull(),
    storageKeyHash: varchar("storage_key_hash", { length: 64 }).notNull(),
    kind: varchar("kind", { length: 64 }).notNull(),
    expiresAt: datetime("expires_at", { mode: "date", fsp: 3 }).notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    index("pub_object_leases_enterprise_idx").on(
      table.ownerId,
      table.enterpriseProjectId,
    ),
    uniqueIndex("pub_object_leases_operation_key_uq").on(
      table.ownerId,
      table.operationId,
      table.storageKeyHash,
    ),
    index("pub_object_leases_expiry_idx").on(table.expiresAt),
    index("pub_object_leases_storage_expiry_idx").on(
      table.storageKeyHash,
      table.expiresAt,
    ),
  ],
);

export const publisherMediaSyncRuns = mysqlTable(
  "publisher_media_sync_runs",
  {
    id: id("id").primaryKey(),
    catalogRevision: varchar("catalog_revision", { length: 64 }).notNull(),
    status: mysqlEnum("status", publisherMediaSyncStatuses)
      .notNull()
      .default("running"),
    startedBy: id("started_by").references(() => users.id, {
      onDelete: "set null",
    }),
    startedAt: datetime("started_at", { mode: "date", fsp: 3 }).notNull(),
    completedAt: datetime("completed_at", { mode: "date", fsp: 3 }),
    pagesFetched: int("pages_fetched", { unsigned: true }).notNull().default(0),
    pagesExpected: int("pages_expected", { unsigned: true })
      .notNull()
      .default(0),
    recordsSeen: int("records_seen", { unsigned: true }).notNull().default(0),
    newsRecords: int("news_records", { unsigned: true }).notNull().default(0),
    selfMediaRecords: int("self_media_records", { unsigned: true })
      .notNull()
      .default(0),
    invalidRecords: int("invalid_records", { unsigned: true })
      .notNull()
      .default(0),
    duplicateRecords: int("duplicate_records", { unsigned: true })
      .notNull()
      .default(0),
    crossKindDuplicateRecords: int("cross_kind_duplicate_records", {
      unsigned: true,
    })
      .notNull()
      .default(0),
    recordsChanged: int("records_changed", { unsigned: true })
      .notNull()
      .default(0),
    stopReason: varchar("stop_reason", { length: 240 }),
    error: json("error").$type<Record<string, unknown>>(),
    isComplete: boolean("is_complete").notNull().default(false),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    index("pub_media_sync_revision_idx").on(table.catalogRevision),
    index("pub_media_sync_status_started_idx").on(
      table.status,
      table.startedAt,
    ),
  ],
);

export const publisherMediaResources = mysqlTable(
  "publisher_media_resources",
  {
    id: id("id").primaryKey(),
    externalResourceId: varchar("external_resource_id", {
      length: 128,
    }).notNull(),
    catalogRevision: varchar("catalog_revision", { length: 64 }).notNull(),
    name: varchar("name", { length: 255 }).notNull(),
    mediaKind: mysqlEnum("media_kind", publisherMediaKinds),
    platform: varchar("platform", { length: 120 }),
    taxonomy: varchar("taxonomy", { length: 120 }),
    mediaType: varchar("media_type", { length: 120 }),
    area: varchar("area", { length: 120 }),
    caseUrl: text("case_url"),
    titleLimit: int("title_limit", { unsigned: true }),
    priceTenThousandths: bigint("price_ten_thousandths", {
      mode: "bigint",
      unsigned: true,
    }).notNull(),
    successRateBasisPoints: int("success_rate_basis_points", {
      unsigned: true,
    }),
    includeRateBasisPoints: int("include_rate_basis_points", {
      unsigned: true,
    }),
    pcWeight: int("pc_weight", { unsigned: true }),
    mobileWeight: int("mobile_weight", { unsigned: true }),
    includeType: varchar("include_type", { length: 120 }),
    publishSpeed: varchar("publish_speed", { length: 120 }),
    entryUrl: text("entry_url"),
    entryLevel: varchar("entry_level", { length: 120 }),
    linkType: varchar("link_type", { length: 120 }),
    providerLogoUrl: text("logo_url"),
    providerIconUrl: text("provider_icon_url"),
    logoCandidateHash: varchar("logo_candidate_hash", { length: 64 }).notNull(),
    logoArchiveStatus: mysqlEnum(
      "logo_archive_status",
      publisherMediaLogoArchiveStatuses,
    )
      .notNull()
      .default("missing"),
    logoSourceKind: mysqlEnum(
      "logo_source_kind",
      publisherMediaLogoSourceKinds,
    ),
    logoSourceUrl: text("logo_source_url"),
    logoObjectKey: varchar("logo_object_key", { length: 1_024 }),
    logoContentType: varchar("logo_content_type", { length: 120 }),
    logoSizeBytes: bigint("logo_size_bytes", {
      mode: "bigint",
      unsigned: true,
    }),
    logoSha256: varchar("logo_sha256", { length: 64 }),
    logoCheckedAt: datetime("logo_checked_at", { mode: "date", fsp: 3 }),
    logoArchiveError: varchar("logo_archive_error", { length: 120 }),
    logoReviewAudit:
      json("logo_review_audit").$type<PublisherMediaLogoReviewAudit>(),
    remark: text("remark"),
    description: text("description"),
    recommended: boolean("recommended"),
    authenticated: boolean("authenticated"),
    festivalPublishable: boolean("festival_publishable"),
    fanCount: bigint("fan_count", { mode: "bigint", unsigned: true }),
    likeCount: bigint("like_count", { mode: "bigint", unsigned: true }),
    publishCount: bigint("publish_count", { mode: "bigint", unsigned: true }),
    rawPayload: json("raw_payload").$type<Record<string, unknown>>().notNull(),
    payloadHash: varchar("payload_hash", { length: 64 }).notNull(),
    isActive: boolean("is_active").notNull().default(true),
    consecutiveMisses: int("consecutive_misses", { unsigned: true })
      .notNull()
      .default(0),
    lastSeenCompleteRunId: id("last_seen_complete_run_id").references(
      () => publisherMediaSyncRuns.id,
      { onDelete: "set null" },
    ),
    lastSeenAt: datetime("last_seen_at", { mode: "date", fsp: 3 }).notNull(),
    inactiveAt: datetime("inactive_at", { mode: "date", fsp: 3 }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    uniqueIndex("pub_media_external_id_uq").on(table.externalResourceId),
    index("pub_media_active_name_idx").on(table.isActive, table.name),
    index("pub_media_platform_taxonomy_idx").on(table.platform, table.taxonomy),
    index("pub_media_area_idx").on(table.area),
    index("pub_media_active_price_idx").on(
      table.isActive,
      table.priceTenThousandths,
    ),
    index("pub_media_active_kind_price_id_idx").on(
      table.isActive,
      table.mediaKind,
      table.priceTenThousandths,
      table.id,
    ),
    index("pub_media_active_kind_platform_tax_idx").on(
      table.isActive,
      table.mediaKind,
      table.platform,
      table.taxonomy,
      table.id,
    ),
    index("pub_media_active_kind_area_id_idx").on(
      table.isActive,
      table.mediaKind,
      table.area,
      table.id,
    ),
    index("pub_media_logo_archive_idx").on(
      table.logoArchiveStatus,
      table.updatedAt,
    ),
  ],
);

export const publisherMediaLogoAssets = mysqlTable(
  "publisher_media_logo_assets",
  {
    mediaResourceId: id("media_resource_id").notNull(),
    sha256: varchar("sha256", { length: 64 }).notNull(),
    sourceKind: mysqlEnum(
      "source_kind",
      publisherMediaLogoSourceKinds,
    ).notNull(),
    objectKey: varchar("object_key", { length: 1_024 }).notNull(),
    contentType: varchar("content_type", { length: 120 }).notNull(),
    sizeBytes: bigint("size_bytes", {
      mode: "bigint",
      unsigned: true,
    }).notNull(),
    catalogRevision: varchar("catalog_revision", { length: 64 }).notNull(),
    reviewAudit: json("review_audit").$type<PublisherMediaLogoReviewAudit>(),
    archivedAt: datetime("archived_at", { mode: "date", fsp: 3 }).notNull(),
    createdAt: createdAt(),
  },
  (table) => [
    foreignKey({
      name: "pub_media_logo_assets_media_fk",
      columns: [table.mediaResourceId],
      foreignColumns: [publisherMediaResources.id],
    }).onDelete("cascade"),
    primaryKey({ columns: [table.mediaResourceId, table.sha256] }),
    index("pub_media_logo_asset_sha_idx").on(table.sha256),
  ],
);

export const publisherMediaLogoResolutions = mysqlTable(
  "publisher_media_logo_resolutions",
  {
    id: id("id").primaryKey(),
    syncRunId: id("sync_run_id").notNull(),
    mediaResourceId: id("media_resource_id").notNull(),
    candidateHash: varchar("candidate_hash", { length: 64 }).notNull(),
    status: mysqlEnum("status", publisherMediaLogoArchiveStatuses).notNull(),
    sourceKind: mysqlEnum("source_kind", publisherMediaLogoSourceKinds),
    logoSha256: varchar("logo_sha256", { length: 64 }),
    errorCode: varchar("error_code", { length: 120 }),
    reviewAudit: json("review_audit").$type<PublisherMediaLogoReviewAudit>(),
    checkedAt: datetime("checked_at", { mode: "date", fsp: 3 }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    foreignKey({
      name: "pub_media_logo_resolutions_run_fk",
      columns: [table.syncRunId],
      foreignColumns: [publisherMediaSyncRuns.id],
    }).onDelete("cascade"),
    foreignKey({
      name: "pub_media_logo_resolutions_media_fk",
      columns: [table.mediaResourceId],
      foreignColumns: [publisherMediaResources.id],
    }).onDelete("cascade"),
    uniqueIndex("pub_media_logo_resolution_run_media_uq").on(
      table.syncRunId,
      table.mediaResourceId,
    ),
    index("pub_media_logo_resolution_run_status_idx").on(
      table.syncRunId,
      table.status,
      table.sourceKind,
    ),
  ],
);

export const publisherMediaSyncStaging = mysqlTable(
  "publisher_media_sync_staging",
  {
    runId: id("run_id")
      .notNull()
      .references(() => publisherMediaSyncRuns.id, { onDelete: "cascade" }),
    externalResourceId: varchar("external_resource_id", {
      length: 128,
    }).notNull(),
    page: int("page", { unsigned: true }).notNull(),
    name: varchar("name", { length: 255 }).notNull(),
    mediaKind: mysqlEnum("media_kind", publisherMediaKinds),
    platform: varchar("platform", { length: 120 }),
    taxonomy: varchar("taxonomy", { length: 120 }),
    mediaType: varchar("media_type", { length: 120 }),
    area: varchar("area", { length: 120 }),
    caseUrl: text("case_url"),
    titleLimit: int("title_limit", { unsigned: true }),
    priceTenThousandths: bigint("price_ten_thousandths", {
      mode: "bigint",
      unsigned: true,
    }).notNull(),
    successRateBasisPoints: int("success_rate_basis_points", {
      unsigned: true,
    }),
    includeRateBasisPoints: int("include_rate_basis_points", {
      unsigned: true,
    }),
    pcWeight: int("pc_weight", { unsigned: true }),
    mobileWeight: int("mobile_weight", { unsigned: true }),
    includeType: varchar("include_type", { length: 120 }),
    publishSpeed: varchar("publish_speed", { length: 120 }),
    entryUrl: text("entry_url"),
    entryLevel: varchar("entry_level", { length: 120 }),
    linkType: varchar("link_type", { length: 120 }),
    providerLogoUrl: text("logo_url"),
    providerIconUrl: text("provider_icon_url"),
    logoCandidateHash: varchar("logo_candidate_hash", { length: 64 }).notNull(),
    remark: text("remark"),
    description: text("description"),
    recommended: boolean("recommended"),
    authenticated: boolean("authenticated"),
    festivalPublishable: boolean("festival_publishable"),
    fanCount: bigint("fan_count", { mode: "bigint", unsigned: true }),
    likeCount: bigint("like_count", { mode: "bigint", unsigned: true }),
    publishCount: bigint("publish_count", { mode: "bigint", unsigned: true }),
    rawPayload: json("raw_payload").$type<Record<string, unknown>>().notNull(),
    payloadHash: varchar("payload_hash", { length: 64 }).notNull(),
    stagedAt: datetime("staged_at", { mode: "date", fsp: 3 }).notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.runId, table.externalResourceId] }),
    index("pub_media_staging_run_page_idx").on(table.runId, table.page),
  ],
);

export const publisherMediaCapabilities = mysqlTable(
  "publisher_media_capabilities",
  {
    id: id("id").primaryKey(),
    mediaResourceId: id("media_resource_id")
      .notNull()
      .references(() => publisherMediaResources.id, { onDelete: "cascade" }),
    imageSupport: mysqlEnum("image_support", publisherImageSupportStatuses)
      .notNull()
      .default("unknown"),
    contentProfile: varchar("content_profile", { length: 64 })
      .notNull()
      .default("unknown"),
    verifiedMediaType: varchar("verified_media_type", { length: 120 }),
    evidenceUrl: text("evidence_url"),
    verifiedAt: datetime("verified_at", { mode: "date", fsp: 3 }),
    verifiedBy: id("verified_by").references(() => users.id, {
      onDelete: "set null",
    }),
    notes: text("notes"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    uniqueIndex("pub_media_capability_resource_uq").on(table.mediaResourceId),
    index("pub_media_capability_image_idx").on(table.imageSupport),
  ],
);

export const publisherRuntimeState = mysqlTable("publisher_runtime_state", {
  id: varchar("id", { length: 32 }).primaryKey(),
  mode: mysqlEnum("mode", publicationModes).notNull().default("mock"),
  featureEnabled: boolean("feature_enabled").notNull().default(false),
  publishEnabled: boolean("publish_enabled").notNull().default(false),
  imagePublishEnabled: boolean("image_publish_enabled")
    .notNull()
    .default(false),
  webhookEnabled: boolean("webhook_enabled").notNull().default(false),
  emergencyStop: boolean("emergency_stop").notNull().default(false),
  credentialStatus: mysqlEnum("credential_status", publisherCredentialStatuses)
    .notNull()
    .default("unconfigured"),
  credentialVerifiedAt: datetime("credential_verified_at", {
    mode: "date",
    fsp: 3,
  }),
  credentialFailedAt: datetime("credential_failed_at", {
    mode: "date",
    fsp: 3,
  }),
  activeCatalogRevision: varchar("active_catalog_revision", { length: 64 }),
  catalogSyncedAt: datetime("catalog_synced_at", { mode: "date", fsp: 3 }),
  catalogKindComplete: boolean("catalog_kind_complete")
    .notNull()
    .default(false),
  changedBy: id("changed_by").references(() => users.id, {
    onDelete: "set null",
  }),
  updatedAt: updatedAt(),
});

export const publisherLiveWhitelist = mysqlTable("publisher_live_whitelist", {
  mediaResourceId: id("media_resource_id")
    .primaryKey()
    .references(() => publisherMediaResources.id, { onDelete: "cascade" }),
  imageAllowed: boolean("image_allowed").notNull().default(false),
  reason: varchar("reason", { length: 240 }).notNull(),
  enabledBy: id("enabled_by").references(() => users.id, {
    onDelete: "set null",
  }),
  enabledAt: datetime("enabled_at", { mode: "date", fsp: 3 }).notNull(),
  updatedAt: updatedAt(),
});

export const publisherDrafts = mysqlTable(
  "publisher_drafts",
  {
    enterpriseProjectId: id("enterprise_project_id").$defaultFn(
      () => currentMonitoringEnterpriseProjectId() ?? sql`NULL`,
    ),
    id: id("id").primaryKey(),
    ownerId: id("owner_id")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    articleVersionId: id("article_version_id").notNull(),
    status: mysqlEnum("status", publisherDraftStatuses)
      .notNull()
      .default("draft"),
    revision: int("revision", { unsigned: true }).notNull().default(0),
    titleMode: mysqlEnum("title_mode", publisherTitleModes)
      .notNull()
      .default("per_media"),
    sharedTitle: varchar("shared_title", { length: 200 }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    index("pub_drafts_enterprise_idx").on(
      table.ownerId,
      table.enterpriseProjectId,
    ),
    uniqueIndex("pub_drafts_id_owner_uq").on(table.id, table.ownerId),
    index("pub_drafts_owner_updated_idx").on(table.ownerId, table.updatedAt),
    foreignKey({
      name: "pub_drafts_version_owner_fk",
      columns: [table.articleVersionId, table.ownerId],
      foreignColumns: [
        publisherArticleVersions.id,
        publisherArticleVersions.ownerId,
      ],
    }).onDelete("restrict"),
  ],
);

export const publisherPreflights = mysqlTable(
  "publisher_preflights",
  {
    enterpriseProjectId: id("enterprise_project_id").$defaultFn(
      () => currentMonitoringEnterpriseProjectId() ?? sql`NULL`,
    ),
    id: id("id").primaryKey(),
    ownerId: id("owner_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    draftId: id("draft_id").notNull(),
    draftRevision: int("draft_revision", { unsigned: true }).notNull(),
    quoteFingerprint: varchar("quote_fingerprint", { length: 64 }).notNull(),
    snapshotHash: varchar("snapshot_hash", { length: 64 }).notNull(),
    mode: mysqlEnum("mode", publicationModes).notNull(),
    expiresAt: datetime("expires_at", { mode: "date", fsp: 3 }).notNull(),
    consumedAt: datetime("consumed_at", { mode: "date", fsp: 3 }),
    createdAt: createdAt(),
  },
  (table) => [
    index("pub_preflights_enterprise_idx").on(
      table.ownerId,
      table.enterpriseProjectId,
    ),
    uniqueIndex("pub_preflights_id_owner_uq").on(table.id, table.ownerId),
    index("pub_preflights_owner_expiry_idx").on(table.ownerId, table.expiresAt),
    foreignKey({
      name: "pub_preflights_draft_owner_fk",
      columns: [table.draftId, table.ownerId],
      foreignColumns: [publisherDrafts.id, publisherDrafts.ownerId],
    }).onDelete("cascade"),
  ],
);

export const publisherDraftItems = mysqlTable(
  "publisher_draft_items",
  {
    enterpriseProjectId: id("enterprise_project_id").$defaultFn(
      () => currentMonitoringEnterpriseProjectId() ?? sql`NULL`,
    ),
    id: id("id").primaryKey(),
    ownerId: id("owner_id")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    draftId: id("draft_id").notNull(),
    mediaResourceId: id("media_resource_id")
      .notNull()
      .references(() => publisherMediaResources.id, { onDelete: "restrict" }),
    externalResourceId: varchar("external_resource_id", {
      length: 128,
    }).notNull(),
    submissionTitle: varchar("submission_title", { length: 200 }).notNull(),
    selectedPriceTenThousandths: bigint("selected_price_ten_thousandths", {
      mode: "bigint",
      unsigned: true,
    }).notNull(),
    selectedCatalogRevision: varchar("selected_catalog_revision", {
      length: 64,
    }).notNull(),
    mediaKindSnapshot: mysqlEnum(
      "media_kind_snapshot",
      publisherHistoricalMediaKinds,
    )
      .notNull()
      .default("unknown"),
    mediaSnapshot: json("media_snapshot")
      .$type<Record<string, unknown>>()
      .notNull(),
    selectedAt: datetime("selected_at", { mode: "date", fsp: 3 }).notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    index("pub_draft_items_enterprise_idx").on(
      table.ownerId,
      table.enterpriseProjectId,
    ),
    uniqueIndex("pub_draft_items_id_owner_uq").on(table.id, table.ownerId),
    uniqueIndex("pub_draft_items_draft_media_uq").on(
      table.draftId,
      table.mediaResourceId,
    ),
    index("pub_draft_items_media_idx").on(table.mediaResourceId),
    foreignKey({
      name: "pub_draft_items_draft_owner_fk",
      columns: [table.draftId, table.ownerId],
      foreignColumns: [publisherDrafts.id, publisherDrafts.ownerId],
    }).onDelete("cascade"),
  ],
);

export const publisherBatches = mysqlTable(
  "publisher_batches",
  {
    enterpriseProjectId: id("enterprise_project_id").$defaultFn(
      () => currentMonitoringEnterpriseProjectId() ?? sql`NULL`,
    ),
    id: id("id").primaryKey(),
    ownerId: id("owner_id")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    draftId: id("draft_id").notNull(),
    articleVersionId: id("article_version_id").notNull(),
    status: mysqlEnum("status", publisherBatchStatuses)
      .notNull()
      .default("queued"),
    fundsStatus: mysqlEnum("funds_status", publisherFundsStatuses)
      .notNull()
      .default("reserved"),
    mode: mysqlEnum("mode", publicationModes).notNull(),
    quotedTotalTenThousandths: bigint("quoted_total_ten_thousandths", {
      mode: "bigint",
      unsigned: true,
    }).notNull(),
    quoteFingerprint: varchar("quote_fingerprint", { length: 64 }).notNull(),
    preflightRevision: varchar("preflight_revision", { length: 128 }).notNull(),
    preflightSnapshot: json("preflight_snapshot")
      .$type<Record<string, unknown>>()
      .notNull(),
    idempotencyKey: varchar("idempotency_key", { length: 191 }).notNull(),
    liveConfirmationAccepted: boolean("live_confirmation_accepted")
      .notNull()
      .default(false),
    titleMode: mysqlEnum("title_mode", publisherTitleModes)
      .notNull()
      .default("per_media"),
    confirmedAt: datetime("confirmed_at", { mode: "date", fsp: 3 }),
    completedAt: datetime("completed_at", { mode: "date", fsp: 3 }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    index("pub_batches_enterprise_idx").on(
      table.ownerId,
      table.enterpriseProjectId,
    ),
    uniqueIndex("pub_batches_id_owner_uq").on(table.id, table.ownerId),
    uniqueIndex("pub_batches_owner_idempotency_uq").on(
      table.ownerId,
      table.idempotencyKey,
    ),
    uniqueIndex("pub_batches_owner_draft_uq").on(table.ownerId, table.draftId),
    index("pub_batches_owner_created_idx").on(table.ownerId, table.createdAt),
    index("pub_batches_status_updated_idx").on(table.status, table.updatedAt),
    foreignKey({
      name: "pub_batches_draft_owner_fk",
      columns: [table.draftId, table.ownerId],
      foreignColumns: [publisherDrafts.id, publisherDrafts.ownerId],
    }).onDelete("restrict"),
    foreignKey({
      name: "pub_batches_version_owner_fk",
      columns: [table.articleVersionId, table.ownerId],
      foreignColumns: [
        publisherArticleVersions.id,
        publisherArticleVersions.ownerId,
      ],
    }).onDelete("restrict"),
  ],
);

export const publisherItems = mysqlTable(
  "publisher_items",
  {
    enterpriseProjectId: id("enterprise_project_id").$defaultFn(
      () => currentMonitoringEnterpriseProjectId() ?? sql`NULL`,
    ),
    id: id("id").primaryKey(),
    ownerId: id("owner_id")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    batchId: id("batch_id").notNull(),
    mediaResourceId: id("media_resource_id")
      .notNull()
      .references(() => publisherMediaResources.id, { onDelete: "restrict" }),
    externalResourceId: varchar("external_resource_id", {
      length: 128,
    }).notNull(),
    mediaNameSnapshot: varchar("media_name_snapshot", {
      length: 255,
    }).notNull(),
    mediaKindSnapshot: mysqlEnum(
      "media_kind_snapshot",
      publisherHistoricalMediaKinds,
    )
      .notNull()
      .default("unknown"),
    mediaMetadataSnapshot: json("media_metadata_snapshot")
      .$type<Record<string, unknown>>()
      .notNull(),
    submissionTitle: varchar("submission_title", { length: 200 }).notNull(),
    articleContentHash: varchar("article_content_hash", {
      length: 64,
    }).notNull(),
    catalogRevision: varchar("catalog_revision", { length: 64 }).notNull(),
    preflightBlockers: json("preflight_blockers")
      .$type<Array<Record<string, unknown>>>()
      .notNull(),
    preflightWarnings: json("preflight_warnings")
      .$type<Array<Record<string, unknown>>>()
      .notNull(),
    submissionKey: varchar("submission_key", { length: 191 }).notNull(),
    requestHash: varchar("request_hash", { length: 64 }),
    status: mysqlEnum("status", publisherItemStatuses)
      .notNull()
      .default("queued"),
    fundsStatus: mysqlEnum("funds_status", publisherFundsStatuses)
      .notNull()
      .default("reserved"),
    externalOrderId: varchar("external_order_id", { length: 191 }),
    externalManuscriptId: varchar("external_manuscript_id", { length: 191 }),
    reportedOrderPriceTenThousandths: bigint(
      "reported_order_price_ten_thousandths",
      { mode: "bigint", unsigned: true },
    ),
    publishedUrl: text("published_url"),
    failureReason: text("failure_reason"),
    actionRequiredReason: text("action_required_reason"),
    attemptCount: int("attempt_count", { unsigned: true }).notNull().default(0),
    submittedAt: datetime("submitted_at", { mode: "date", fsp: 3 }),
    completedAt: datetime("completed_at", { mode: "date", fsp: 3 }),
    lastPolledAt: datetime("last_polled_at", { mode: "date", fsp: 3 }),
    nextPollAt: datetime("next_poll_at", { mode: "date", fsp: 3 }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    index("pub_items_enterprise_idx").on(
      table.ownerId,
      table.enterpriseProjectId,
    ),
    uniqueIndex("pub_items_id_owner_uq").on(table.id, table.ownerId),
    uniqueIndex("pub_items_submission_key_uq").on(table.submissionKey),
    uniqueIndex("pub_items_batch_media_uq").on(
      table.batchId,
      table.mediaResourceId,
    ),
    uniqueIndex("pub_items_external_order_uq").on(table.externalOrderId),
    index("pub_items_status_next_poll_idx").on(table.status, table.nextPollAt),
    index("pub_items_batch_status_idx").on(table.batchId, table.status),
    foreignKey({
      name: "pub_items_batch_owner_fk",
      columns: [table.batchId, table.ownerId],
      foreignColumns: [publisherBatches.id, publisherBatches.ownerId],
    }).onDelete("cascade"),
  ],
);

export const publisherSubmissionAttempts = mysqlTable(
  "publisher_submission_attempts",
  {
    id: id("id").primaryKey(),
    ownerId: id("owner_id")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    itemId: id("item_id").notNull(),
    attemptNumber: int("attempt_number", { unsigned: true }).notNull(),
    startedAt: datetime("started_at", { mode: "date", fsp: 3 }).notNull(),
    completedAt: datetime("completed_at", { mode: "date", fsp: 3 }),
    result: mysqlEnum("result", publisherAttemptResults),
    requestHash: varchar("request_hash", { length: 64 }).notNull(),
    httpStatus: int("http_status", { unsigned: true }),
    responseRedacted:
      json("response_redacted").$type<Record<string, unknown>>(),
    errorCode: varchar("error_code", { length: 64 }),
    createdAt: createdAt(),
  },
  (table) => [
    uniqueIndex("pub_attempts_item_number_uq").on(
      table.itemId,
      table.attemptNumber,
    ),
    index("pub_attempts_started_idx").on(table.startedAt),
    foreignKey({
      name: "pub_attempts_item_owner_fk",
      columns: [table.itemId, table.ownerId],
      foreignColumns: [publisherItems.id, publisherItems.ownerId],
    }).onDelete("cascade"),
  ],
);

export const publisherReconciliationCandidates = mysqlTable(
  "publisher_reconciliation_candidates",
  {
    id: id("id").primaryKey(),
    itemId: id("item_id")
      .notNull()
      .references(() => publisherItems.id, { onDelete: "cascade" }),
    externalOrderId: varchar("external_order_id", { length: 191 }).notNull(),
    confidenceBasisPoints: int("confidence_basis_points", {
      unsigned: true,
    }).notNull(),
    evidence: json("evidence").$type<Record<string, unknown>>().notNull(),
    boundAt: datetime("bound_at", { mode: "date", fsp: 3 }),
    boundBy: id("bound_by").references(() => users.id, {
      onDelete: "set null",
    }),
    rejectedAt: datetime("rejected_at", { mode: "date", fsp: 3 }),
    rejectedBy: id("rejected_by").references(() => users.id, {
      onDelete: "set null",
    }),
    createdAt: createdAt(),
  },
  (table) => [
    uniqueIndex("pub_reconcile_item_order_uq").on(
      table.itemId,
      table.externalOrderId,
    ),
    index("pub_reconcile_unresolved_idx").on(table.boundAt, table.rejectedAt),
  ],
);

export const publisherJobs = mysqlTable(
  "publisher_jobs",
  {
    enterpriseProjectId: id("enterprise_project_id").$defaultFn(
      () => currentMonitoringEnterpriseProjectId() ?? sql`NULL`,
    ),
    id: id("id").primaryKey(),
    type: mysqlEnum("type", publisherJobTypes).notNull(),
    status: mysqlEnum("status", publisherJobStatuses)
      .notNull()
      .default("ready"),
    deterministicKey: varchar("deterministic_key", { length: 191 }).notNull(),
    aggregateId: varchar("aggregate_id", { length: 191 }).notNull(),
    payload: json("payload").$type<Record<string, unknown>>().notNull(),
    availableAt: datetime("available_at", { mode: "date", fsp: 3 }).notNull(),
    leaseOwner: varchar("lease_owner", { length: 128 }),
    leaseExpiresAt: datetime("lease_expires_at", { mode: "date", fsp: 3 }),
    attempts: int("attempts", { unsigned: true }).notNull().default(0),
    maxAttempts: int("max_attempts", { unsigned: true }).notNull().default(20),
    lastErrorCode: varchar("last_error_code", { length: 64 }),
    lastErrorMessage: text("last_error_message"),
    completedAt: datetime("completed_at", { mode: "date", fsp: 3 }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    uniqueIndex("pub_jobs_deterministic_key_uq").on(table.deterministicKey),
    index("pub_jobs_claim_idx").on(
      table.status,
      table.availableAt,
      table.leaseExpiresAt,
    ),
    index("pub_jobs_type_aggregate_idx").on(table.type, table.aggregateId),
  ],
);

export const publisherSubmissionGate = mysqlTable(
  "publisher_submission_gate",
  {
    id: varchar("id", { length: 32 }).primaryKey(),
    leaseOwner: varchar("lease_owner", { length: 128 }),
    leaseExpiresAt: datetime("lease_expires_at", { mode: "date", fsp: 3 }),
    nextAllowedAt: datetime("next_allowed_at", {
      mode: "date",
      fsp: 3,
    }).notNull(),
    updatedAt: updatedAt(),
  },
  (table) => [index("pub_submission_gate_lease_idx").on(table.leaseExpiresAt)],
);

export const publisherWebhookEvents = mysqlTable(
  "publisher_webhook_events",
  {
    id: id("id").primaryKey(),
    provider: varchar("provider", { length: 64 }).notNull().default("kol"),
    payloadHash: varchar("payload_hash", { length: 64 }).notNull(),
    rawPayload: json("raw_payload").$type<Record<string, unknown>>().notNull(),
    signatureStatus: mysqlEnum(
      "signature_status",
      publisherWebhookSignatureStatuses,
    )
      .notNull()
      .default("not_configured"),
    status: mysqlEnum("status", publisherWebhookEventStatuses)
      .notNull()
      .default("received"),
    receivedAt: datetime("received_at", { mode: "date", fsp: 3 }).notNull(),
    processedAt: datetime("processed_at", { mode: "date", fsp: 3 }),
    error: text("error"),
    createdAt: createdAt(),
  },
  (table) => [
    uniqueIndex("pub_webhooks_provider_hash_uq").on(
      table.provider,
      table.payloadHash,
    ),
    index("pub_webhooks_status_received_idx").on(
      table.status,
      table.receivedAt,
    ),
  ],
);

export const publisherWebhookItems = mysqlTable(
  "publisher_webhook_items",
  {
    id: id("id").primaryKey(),
    eventId: id("event_id")
      .notNull()
      .references(() => publisherWebhookEvents.id, { onDelete: "cascade" }),
    externalOrderId: varchar("external_order_id", { length: 191 }),
    itemId: id("item_id").references(() => publisherItems.id, {
      onDelete: "set null",
    }),
    rawItem: json("raw_item").$type<Record<string, unknown>>().notNull(),
    status: mysqlEnum("status", ["matched", "unmatched", "queued"] as const)
      .notNull()
      .default("unmatched"),
    createdAt: createdAt(),
  },
  (table) => [
    index("pub_webhook_items_event_idx").on(table.eventId),
    index("pub_webhook_items_order_idx").on(table.externalOrderId),
  ],
);

/** Both domains lock the same account. Legacy wallet tables remain migration evidence. */
export const mediaPublishingWallets = moneyWallets;

export const mediaPublishingReservations = mysqlTable(
  "media_publishing_reservations",
  {
    id: id("id").primaryKey(),
    ownerId: id("owner_id")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    batchId: id("batch_id").notNull(),
    totalTenThousandths: bigint("total_ten_thousandths", {
      mode: "bigint",
      unsigned: true,
    }).notNull(),
    consumedTenThousandths: bigint("consumed_ten_thousandths", {
      mode: "bigint",
      unsigned: true,
    })
      .notNull()
      .default(sql`0`),
    releasedTenThousandths: bigint("released_ten_thousandths", {
      mode: "bigint",
      unsigned: true,
    })
      .notNull()
      .default(sql`0`),
    frozenTenThousandths: bigint("frozen_ten_thousandths", {
      mode: "bigint",
      unsigned: true,
    })
      .notNull()
      .default(sql`0`),
    status: mysqlEnum("status", mediaPublishingReservationStatuses)
      .notNull()
      .default("active"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    uniqueIndex("media_pub_reservations_id_owner_uq").on(
      table.id,
      table.ownerId,
    ),
    uniqueIndex("media_pub_reservations_batch_uq").on(table.batchId),
    index("media_pub_reservations_owner_status_idx").on(
      table.ownerId,
      table.status,
    ),
    foreignKey({
      name: "media_pub_reservations_batch_owner_fk",
      columns: [table.batchId, table.ownerId],
      foreignColumns: [publisherBatches.id, publisherBatches.ownerId],
    }).onDelete("restrict"),
  ],
);

export const mediaPublishingItemPriceSnapshots = mysqlTable(
  "media_publishing_item_price_snapshots",
  {
    itemId: id("item_id").primaryKey(),
    ownerId: id("owner_id")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    mediaResourceId: id("media_resource_id")
      .notNull()
      .references(() => publisherMediaResources.id, { onDelete: "restrict" }),
    catalogRevision: varchar("catalog_revision", { length: 64 }).notNull(),
    externalResourceId: varchar("external_resource_id", {
      length: 128,
    }).notNull(),
    amountTenThousandths: bigint("amount_ten_thousandths", {
      mode: "bigint",
      unsigned: true,
    }).notNull(),
    currency: varchar("currency", { length: 3 }).notNull().default("CNY"),
    providerPayloadHash: varchar("provider_payload_hash", {
      length: 64,
    }).notNull(),
    createdAt: createdAt(),
  },
  (table) => [
    index("media_pub_price_owner_idx").on(table.ownerId),
    foreignKey({
      name: "media_pub_price_item_owner_fk",
      columns: [table.itemId, table.ownerId],
      foreignColumns: [publisherItems.id, publisherItems.ownerId],
    }).onDelete("cascade"),
  ],
);

export const mediaPublishingItemSettlements = mysqlTable(
  "media_publishing_item_settlements",
  {
    itemId: id("item_id").primaryKey(),
    ownerId: id("owner_id")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    reservationId: id("reservation_id").notNull(),
    status: mysqlEnum("status", publisherFundsStatuses)
      .notNull()
      .default("reserved"),
    amountTenThousandths: bigint("amount_ten_thousandths", {
      mode: "bigint",
      unsigned: true,
    }).notNull(),
    settledAt: datetime("settled_at", { mode: "date", fsp: 3 }),
    updatedAt: updatedAt(),
  },
  (table) => [
    index("media_pub_settlements_reservation_idx").on(table.reservationId),
    index("media_pub_settlements_owner_status_idx").on(
      table.ownerId,
      table.status,
    ),
    foreignKey({
      name: "media_pub_settlements_item_owner_fk",
      columns: [table.itemId, table.ownerId],
      foreignColumns: [publisherItems.id, publisherItems.ownerId],
    }).onDelete("cascade"),
    foreignKey({
      name: "media_pub_settlements_reservation_owner_fk",
      columns: [table.reservationId, table.ownerId],
      foreignColumns: [
        mediaPublishingReservations.id,
        mediaPublishingReservations.ownerId,
      ],
    }).onDelete("restrict"),
  ],
);

export const mediaPublishingLedger = mysqlTable(
  "media_publishing_ledger",
  {
    id: id("id").primaryKey(),
    ownerId: id("owner_id")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    type: mysqlEnum("type", mediaPublishingLedgerEntryTypes).notNull(),
    balanceDeltaTenThousandths: bigint("balance_delta_ten_thousandths", {
      mode: "bigint",
    }).notNull(),
    reservedDeltaTenThousandths: bigint("reserved_delta_ten_thousandths", {
      mode: "bigint",
    }).notNull(),
    frozenDeltaTenThousandths: bigint("frozen_delta_ten_thousandths", {
      mode: "bigint",
    }).notNull(),
    balanceAfterTenThousandths: bigint("balance_after_ten_thousandths", {
      mode: "bigint",
    }).notNull(),
    reservedAfterTenThousandths: bigint("reserved_after_ten_thousandths", {
      mode: "bigint",
      unsigned: true,
    }).notNull(),
    frozenAfterTenThousandths: bigint("frozen_after_ten_thousandths", {
      mode: "bigint",
      unsigned: true,
    }).notNull(),
    idempotencyKey: varchar("idempotency_key", { length: 191 }).notNull(),
    reservationId: id("reservation_id").references(
      () => mediaPublishingReservations.id,
      { onDelete: "set null" },
    ),
    itemId: id("item_id").references(() => publisherItems.id, {
      onDelete: "set null",
    }),
    actorId: id("actor_id").references(() => users.id, {
      onDelete: "set null",
    }),
    referenceType: varchar("reference_type", { length: 40 }),
    referenceId: varchar("reference_id", { length: 128 }),
    reason: varchar("reason", { length: 240 }).notNull(),
    metadata: json("metadata").$type<Record<string, unknown>>(),
    createdAt: createdAt(),
  },
  (table) => [
    uniqueIndex("media_pub_ledger_idempotency_uq").on(table.idempotencyKey),
    index("media_pub_ledger_owner_created_idx").on(
      table.ownerId,
      table.createdAt,
    ),
    index("media_pub_ledger_reference_idx").on(
      table.referenceType,
      table.referenceId,
    ),
  ],
);

export const mediaPublishingTopupOrders = mysqlTable(
  "media_publishing_topup_orders",
  {
    id: id("id").primaryKey(),
    providerOrderId: varchar("provider_order_id", { length: 128 }).notNull(),
    replacesOrderId: id("replaces_order_id").references(
      (): AnyMySqlColumn => mediaPublishingTopupOrders.id,
      { onDelete: "restrict" },
    ),
    ownerId: id("owner_id")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    idempotencyKey: varchar("idempotency_key", { length: 128 }).notNull(),
    paymentMethod: mysqlEnum("payment_method", topupPaymentMethods).notNull(),
    amountTenThousandths: bigint("amount_ten_thousandths", {
      mode: "bigint",
      unsigned: true,
    }).notNull(),
    currency: varchar("currency", { length: 3 }).notNull().default("CNY"),
    state: mysqlEnum("state", topupOrderStates).notNull().default("pending"),
    callbackTokenDigest: varchar("callback_token_digest", {
      length: 64,
    }).notNull(),
    checkoutExpiresAt: datetime("checkout_expires_at", {
      mode: "date",
      fsp: 3,
    }).notNull(),
    paidAt: datetime("paid_at", { mode: "date", fsp: 3 }),
    creditedAt: datetime("credited_at", { mode: "date", fsp: 3 }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    uniqueIndex("media_pub_topup_provider_order_uq").on(table.providerOrderId),
    uniqueIndex("media_pub_topup_replaces_order_uq").on(table.replacesOrderId),
    uniqueIndex("media_pub_topup_owner_idempotency_uq").on(
      table.ownerId,
      table.idempotencyKey,
    ),
    index("media_pub_topup_owner_created_idx").on(
      table.ownerId,
      table.createdAt,
    ),
    index("media_pub_topup_state_expiry_idx").on(
      table.state,
      table.checkoutExpiresAt,
    ),
  ],
);

export const mediaPublishingTopupReceipts = mysqlTable(
  "media_publishing_topup_receipts",
  {
    id: id("id").primaryKey(),
    orderId: id("order_id")
      .notNull()
      .references(() => mediaPublishingTopupOrders.id, {
        onDelete: "restrict",
      }),
    provider: mysqlEnum("provider", topupReceiptProviders).notNull(),
    providerTradeNo: varchar("provider_trade_no", { length: 191 }).notNull(),
    amountTenThousandths: bigint("amount_ten_thousandths", {
      mode: "bigint",
      unsigned: true,
    }).notNull(),
    paidAt: datetime("paid_at", { mode: "date", fsp: 3 }).notNull(),
    payloadDigest: varchar("payload_digest", { length: 64 }).notNull(),
    receivedAt: datetime("received_at", { mode: "date", fsp: 3 }).notNull(),
    createdAt: createdAt(),
  },
  (table) => [
    uniqueIndex("media_pub_receipts_order_uq").on(table.orderId),
    uniqueIndex("media_pub_receipts_provider_trade_uq").on(
      table.provider,
      table.providerTradeNo,
    ),
  ],
);

export const mediaPublishingBankTransferReviews = mysqlTable(
  "media_publishing_bank_transfer_reviews",
  {
    id: id("id").primaryKey(),
    orderId: id("order_id")
      .notNull()
      .references(() => mediaPublishingTopupOrders.id, {
        onDelete: "restrict",
      }),
    status: mysqlEnum("status", bankTransferReviewStatuses)
      .notNull()
      .default("pending"),
    remittanceReference: varchar("remittance_reference", {
      length: 191,
    }).notNull(),
    payerName: varchar("payer_name", { length: 120 }).notNull(),
    transferredAt: datetime("transferred_at", {
      mode: "date",
      fsp: 3,
    }).notNull(),
    evidenceObjectKey: varchar("evidence_object_key", { length: 1_024 }),
    submittedAt: datetime("submitted_at", {
      mode: "date",
      fsp: 3,
    }).notNull(),
    reviewedBy: id("reviewed_by").references(() => users.id, {
      onDelete: "set null",
    }),
    reviewReason: varchar("review_reason", { length: 240 }),
    reviewedAt: datetime("reviewed_at", { mode: "date", fsp: 3 }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    uniqueIndex("media_pub_bank_reviews_order_uq").on(table.orderId),
    index("media_pub_bank_reviews_status_idx").on(
      table.status,
      table.submittedAt,
    ),
  ],
);

/**
 * The generic callback route is intentionally separate from either order
 * table. Old binaries cannot see media-publishing orders and therefore cannot
 * accidentally credit the monitoring wallet during a rollback.
 */
export const paymentOrderRoutes = mysqlTable(
  "payment_order_routes",
  {
    id: id("id").primaryKey(),
    providerOrderId: varchar("provider_order_id", { length: 128 }).notNull(),
    walletScope: mysqlEnum("wallet_scope", walletScopes).notNull(),
    monitoringOrderId: id("monitoring_order_id").references(
      () => topupOrders.id,
      { onDelete: "restrict" },
    ),
    mediaPublishingOrderId: id("media_publishing_order_id").references(
      () => mediaPublishingTopupOrders.id,
      { onDelete: "restrict" },
    ),
    createdAt: createdAt(),
  },
  (table) => [
    uniqueIndex("payment_order_routes_provider_order_uq").on(
      table.providerOrderId,
    ),
    uniqueIndex("payment_order_routes_monitoring_order_uq").on(
      table.monitoringOrderId,
    ),
    uniqueIndex("payment_order_routes_media_order_uq").on(
      table.mediaPublishingOrderId,
    ),
  ],
);

export const paymentReceiptClaims = mysqlTable(
  "payment_receipt_claims",
  {
    id: id("id").primaryKey(),
    provider: mysqlEnum("provider", topupReceiptProviders).notNull(),
    providerTradeNo: varchar("provider_trade_no", { length: 191 }).notNull(),
    providerOrderId: varchar("provider_order_id", { length: 128 }).notNull(),
    walletScope: mysqlEnum("wallet_scope", walletScopes).notNull(),
    payloadDigest: varchar("payload_digest", { length: 64 }).notNull(),
    status: mysqlEnum("status", [
      "received",
      "credited",
      "review_required",
      "rejected",
    ] as const)
      .notNull()
      .default("received"),
    claimedAt: datetime("claimed_at", { mode: "date", fsp: 3 }).notNull(),
    completedAt: datetime("completed_at", { mode: "date", fsp: 3 }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    uniqueIndex("payment_receipt_claims_provider_trade_uq").on(
      table.provider,
      table.providerTradeNo,
    ),
    index("payment_receipt_claims_order_idx").on(table.providerOrderId),
  ],
);

export const schema = {
  users,
  sessions,
  projects,
  projectBrandVersions,
  projectQuestions,
  platformCatalog,
  monitors,
  monitorVersions,
  monitorQuestions,
  monitorPlatforms,
  scheduleOccurrences,
  runs,
  attempts,
  resultRevisions,
  attemptResults,
  resultSources,
  resultDiscoveredSources,
  resultMedia,
  quotaWallets,
  quotaReservations,
  quotaLedger,
  jobs,
  providerCosts,
  moneyWallets,
  pricingVersions,
  pricingItems,
  moneyReservations,
  attemptPriceSnapshots,
  attemptMoneySettlements,
  moneyLedger,
  topupOrders,
  topupReceipts,
  bankTransferReviews,
  auditLogs,
  providerTaskTombstones,
  workerHeartbeats,
  providerDispatchDays,
  providerDispatchSlots,
  providerSubmissionGate,
  providerObservations,
  providerRegions,
  providerReconciliationState,
  dailyRunAggregates,
  publisherArticles,
  publisherDocxImports,
  publisherArticleVersions,
  publisherArticleAssets,
  publisherArticleVersionAssets,
  publisherObjectLeases,
  publisherMediaSyncRuns,
  publisherMediaResources,
  publisherMediaSyncStaging,
  publisherMediaCapabilities,
  publisherRuntimeState,
  publisherLiveWhitelist,
  publisherDrafts,
  publisherDraftItems,
  publisherBatches,
  publisherItems,
  publisherSubmissionAttempts,
  publisherReconciliationCandidates,
  publisherJobs,
  publisherSubmissionGate,
  publisherWebhookEvents,
  publisherWebhookItems,
  mediaPublishingWallets,
  mediaPublishingReservations,
  mediaPublishingItemPriceSnapshots,
  mediaPublishingItemSettlements,
  mediaPublishingLedger,
  mediaPublishingTopupOrders,
  mediaPublishingTopupReceipts,
  mediaPublishingBankTransferReviews,
  paymentOrderRoutes,
  paymentReceiptClaims,
};

export type Schema = typeof schema;

export const availableQuotaSql = (table: typeof quotaWallets) =>
  sql<number>`${table.grantedUnits} - ${table.consumedUnits} - ${table.reservedUnits}`;

export const availableMoneySql = (table: typeof moneyWallets) =>
  sql<bigint>`${table.balanceTenThousandths} - ${table.reservedTenThousandths}`;
