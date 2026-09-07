import { assertMonitoringEnterpriseProjectActive } from "./enterprise-lifecycle.js";
import { currentMonitoringEnterpriseProjectId, monitoringProjectOwnerPredicate, monitoringChildOwnerPredicate } from "./enterprise-scope.js";
import { readAccountActivity, readAccountConsumption } from "./account-billing.js";
import { createHash, randomUUID } from "node:crypto";
import type {
  AdminOperationsListInput,
  BillingQuoteInput,
  CitationProvenance,
  MonitoringAnalysisInput,
  MonitoringAnswersListInput,
  MonitorConfiguration,
  MonitoringScope,
  PlatformAcceptancePlanInput,
  PlatformAcceptanceStartInput,
  ProjectCreateInput,
  RunTrigger,
  Sentiment,
} from "@frontmind/monitoring-contracts";
import { calculateAttemptCount } from "@frontmind/monitoring-contracts";
import { MONEY_CURRENCY, moneyToApiString } from "./billing.js";
import {
  and,
  asc,
  desc,
  eq,
  gt,
  gte,
  inArray,
  isNull,
  lt,
  lte,
  like,
  not,
  or,
  sql,
} from "drizzle-orm";
import type { Database } from "./client.js";
import {
  attempts,
  attemptMoneySettlements,
  attemptPriceSnapshots,
  attemptResults,
  auditLogs,
  jobs,
  monitorPlatforms,
  monitorQuestions,
  monitors,
  monitorVersions,
  moneyLedger,
  moneyReservations,
  moneyWallets,
  paymentReceiptClaims,
  platformCatalog,
  platformAcceptanceBatches,
  platformAcceptanceChecks,
  projectBrandVersions,
  projectQuestions,
  projects,
  providerCosts,
  providerReconciliationState,
  providerRegions,
  providerTaskTombstones,
  pricingItems,
  pricingVersions,
  quotaLedger,
  quotaWallets,
  resultDiscoveredSources,
  resultMedia,
  resultRevisions,
  resultSources,
  runMetrics,
  runs,
  scheduleOccurrences,
  sessions,
  bankTransferReviews,
  topupOrders,
  topupReceipts,
  users,
  workerHeartbeats,
} from "./schema.js";
import { RepositoryError } from "./repository-error.js";
import { settleAttemptMoney } from "./money-settlement.js";
import {
  acceptanceSha256,
  buildPlatformAcceptancePlan,
  platformAcceptanceFingerprint,
  platformAcceptancePlanFingerprint,
} from "./platform-acceptance.js";
import type {
  PlatformAcceptanceCheckPlan,
  PlatformAcceptanceDimension,
  PlatformAcceptanceStatus,
} from "./platform-acceptance-types.js";
export { RepositoryError } from "./repository-error.js";

export type RequestAudit = {
  actorId: string | null;
  actorRole: "user" | "admin" | null;
  ipHash?: string | null;
};

export const monitoringExportSections = [
  "overview",
  "answers",
  "metrics",
  "trends",
  "competitors",
  "citations",
  "sources",
] as const;
export type MonitoringExportSection = (typeof monitoringExportSections)[number];

/**
 * Monitoring aggregation reads are deliberately bounded independently of the
 * HTTP layer. These limits protect every caller (including future jobs and
 * exports) from turning an otherwise valid tenant-scoped query into an
 * unbounded in-process aggregation.
 */
export const MONITORING_FACT_LIMIT = 50_000 as const;
export const MONITORING_EVIDENCE_ROW_LIMIT = 100_000 as const;
export const MONITORING_EVIDENCE_REVISION_BATCH_SIZE = 500 as const;
export const MONITORING_LEGACY_DISCOVERY_FALLBACK_LIMIT = 5_000 as const;
export const MONITORING_ANSWER_EXPORT_ROW_LIMIT = 10_000 as const;
export const MONITORING_ANSWER_EXPORT_PROJECTED_BYTE_LIMIT = 32 * 1_024 * 1_024;
export const MONITORING_ANSWER_EXPORT_CELL_READ_LENGTH = 32_001 as const;
export const MONITORING_ANSWER_EXPORT_ROW_OVERHEAD_BYTES = 512 as const;
// Drizzle 0.45.2 emits invalid MySQL syntax when accessMode is combined with
// WITH CONSISTENT SNAPSHOT. This transaction issues SELECTs only; do not add
// accessMode until the driver emits the required comma between characteristics.
export const MONITORING_ANSWER_EXPORT_TRANSACTION_CONFIG = {
  isolationLevel: "repeatable read",
  withConsistentSnapshot: true,
} as const;

export function assertMonitoringAnswerExportPreflight(
  rowCount: number,
  projectedBytes: number,
) {
  if (
    !Number.isSafeInteger(rowCount) ||
    rowCount < 0 ||
    !Number.isSafeInteger(projectedBytes) ||
    projectedBytes < 0
  ) {
    throw new RepositoryError(
      "INVALID_STATE",
      "Monitoring answer export size could not be measured safely",
    );
  }
  if (rowCount > MONITORING_ANSWER_EXPORT_ROW_LIMIT) {
    throw new RepositoryError(
      "INVALID_STATE",
      `Monitoring answer export exceeds the ${MONITORING_ANSWER_EXPORT_ROW_LIMIT.toLocaleString("en-US")} row limit; narrow the date or dimension filters`,
    );
  }
  if (projectedBytes > MONITORING_ANSWER_EXPORT_PROJECTED_BYTE_LIMIT) {
    throw new RepositoryError(
      "INVALID_STATE",
      "Monitoring answer export exceeds the 32 MiB projected payload limit; narrow the date or dimension filters",
    );
  }
}

export function pollAttemptJobDedupeKey(attemptId: string): string {
  return `poll:${attemptId}`;
}

export const EXECUTION_SERVICE_HEARTBEAT_THRESHOLD_SECONDS = 90 as const;

export function executionServiceHealth(
  lastHeartbeatAt: Date | null,
  observedAt = new Date(),
) {
  if (!lastHeartbeatAt) {
    return {
      status: "never_seen" as const,
      lastHeartbeatAt: null,
      observedAt,
      ageSeconds: null,
      thresholdSeconds: EXECUTION_SERVICE_HEARTBEAT_THRESHOLD_SECONDS,
    };
  }
  const ageMilliseconds = Math.max(
    0,
    observedAt.getTime() - lastHeartbeatAt.getTime(),
  );
  return {
    status:
      ageMilliseconds <= EXECUTION_SERVICE_HEARTBEAT_THRESHOLD_SECONDS * 1_000
        ? ("online" as const)
        : ("offline" as const),
    lastHeartbeatAt,
    observedAt,
    ageSeconds: Math.floor(ageMilliseconds / 1_000),
    thresholdSeconds: EXECUTION_SERVICE_HEARTBEAT_THRESHOLD_SECONDS,
  };
}

export function providerAuthenticationHealth(
  executionServiceStatus: "online" | "offline" | "never_seen",
  verifiedAt: Date | null,
  failedAt: Date | null,
) {
  if (executionServiceStatus !== "online") {
    return { status: "unknown" as const, verifiedAt, failedAt };
  }
  if (failedAt && (!verifiedAt || failedAt > verifiedAt)) {
    return { status: "unhealthy" as const, verifiedAt, failedAt };
  }
  if (verifiedAt) {
    return { status: "healthy" as const, verifiedAt, failedAt };
  }
  return { status: "unknown" as const, verifiedAt, failedAt };
}

export class MonitoringRepository {
  constructor(public readonly db: Database) {}

  async ping() {
    await this.db.execute(sql`SELECT 1`);
  }

  async findUserByUsername(username: string) {
    const [user] = await this.db
      .select()
      .from(users)
      .where(eq(users.username, username))
      .limit(1);
    return user ?? null;
  }

  async findUserById(userId: string) {
    const [user] = await this.db
      .select()
      .from(users)
      .where(eq(users.id, userId))
      .limit(1);
    return user ?? null;
  }

  async createSession(input: {
    userId: string;
    tokenHash: string;
    sessionVersion: number;
    expiresAt: Date;
    ipHash?: string | null;
    userAgent?: string | null;
  }) {
    const sessionId = randomUUID();
    const now = new Date();
    await this.db.transaction(async (tx) => {
      await tx.insert(sessions).values({
        id: sessionId,
        userId: input.userId,
        tokenHash: input.tokenHash,
        sessionVersion: input.sessionVersion,
        expiresAt: input.expiresAt,
        lastSeenAt: now,
        ipHash: input.ipHash ?? null,
        userAgent: input.userAgent?.slice(0, 512) ?? null,
      });
      await tx
        .update(users)
        .set({ lastLoginAt: now })
        .where(eq(users.id, input.userId));
    });
    return sessionId;
  }

  async resolveSession(tokenHash: string, now = new Date()) {
    const [row] = await this.db
      .select({ session: sessions, user: users })
      .from(sessions)
      .innerJoin(users, eq(sessions.userId, users.id))
      .where(
        and(
          eq(sessions.tokenHash, tokenHash),
          isNull(sessions.revokedAt),
          gt(sessions.expiresAt, now),
          eq(users.status, "active"),
          eq(sessions.sessionVersion, users.sessionVersion),
        ),
      )
      .limit(1);
    if (!row) return null;
    if (now.getTime() - row.session.lastSeenAt.getTime() > 5 * 60_000) {
      await this.db
        .update(sessions)
        .set({ lastSeenAt: now })
        .where(eq(sessions.id, row.session.id));
    }
    return row;
  }

  async revokeSession(tokenHash: string) {
    await this.db
      .update(sessions)
      .set({ revokedAt: new Date() })
      .where(
        and(eq(sessions.tokenHash, tokenHash), isNull(sessions.revokedAt)),
      );
  }

  async revokeAllSessions(userId: string) {
    const now = new Date();
    await this.db.transaction(async (tx) => {
      await tx
        .update(users)
        .set({ sessionVersion: sql`${users.sessionVersion} + 1` })
        .where(eq(users.id, userId));
      await tx
        .update(sessions)
        .set({ revokedAt: now })
        .where(and(eq(sessions.userId, userId), isNull(sessions.revokedAt)));
    });
  }

  async updatePassword(
    userId: string,
    passwordHash: string,
    audit: RequestAudit,
  ) {
    const now = new Date();
    await this.db.transaction(async (tx) => {
      const result = await tx
        .update(users)
        .set({
          passwordHash,
          passwordChangedAt: now,
          sessionVersion: sql`${users.sessionVersion} + 1`,
        })
        .where(eq(users.id, userId));
      if (affectedRows(result) !== 1)
        throw new RepositoryError("NOT_FOUND", "User not found");
      await tx
        .update(sessions)
        .set({ revokedAt: now })
        .where(and(eq(sessions.userId, userId), isNull(sessions.revokedAt)));
      await insertAudit(
        tx,
        audit,
        audit.actorId && audit.actorId !== userId
          ? "admin.password_reset"
          : "auth.password_changed",
        "user",
        userId,
        userId,
        {},
      );
    });
  }

  async adminCreateUser(
    input: {
      username: string;
      passwordHash: string;
      role: "user" | "admin";
    },
    audit: RequestAudit,
  ) {
    const userId = randomUUID();
    await this.db.transaction(async (tx) => {
      const [existing] = await tx
        .select({ id: users.id })
        .from(users)
        .where(eq(users.username, input.username))
        .limit(1);
      if (existing)
        throw new RepositoryError("CONFLICT", "Username is already in use");
      await tx.insert(users).values({
        id: userId,
        username: input.username,
        passwordHash: input.passwordHash,
        role: input.role,
        passwordChangedAt: new Date(),
      });
      await tx.insert(moneyWallets).values({ userId });
      await insertAudit(
        tx,
        audit,
        "admin.user_created",
        "user",
        userId,
        userId,
        { username: input.username, role: input.role },
      );
    });
    const [created] = await this.db
      .select({
        id: users.id,
        username: users.username,
        role: users.role,
        status: users.status,
        createdAt: users.createdAt,
      })
      .from(users)
      .where(eq(users.id, userId))
      .limit(1);
    if (!created)
      throw new RepositoryError(
        "INVALID_STATE",
        "Created user could not be read back",
      );
    return created;
  }

  async adminSetUserStatus(
    userId: string,
    status: "active" | "disabled",
    audit: RequestAudit,
  ) {
    const now = new Date();
    await this.db.transaction(async (tx) => {
      const result = await tx
        .update(users)
        .set({
          status,
          ...(status === "disabled"
            ? { sessionVersion: sql`${users.sessionVersion} + 1` }
            : {}),
        })
        .where(eq(users.id, userId));
      if (affectedRows(result) !== 1)
        throw new RepositoryError("NOT_FOUND", "User not found");
      if (status === "disabled") {
        await tx
          .update(sessions)
          .set({ revokedAt: now })
          .where(and(eq(sessions.userId, userId), isNull(sessions.revokedAt)));
      }
      const ownedMonitors = await tx
        .select()
        .from(monitors)
        .where(and(monitoringChildOwnerPredicate(monitors, userId), isNull(monitors.deletedAt)));
      for (const monitor of ownedMonitors) {
        const nextRunAt =
          status === "active" && monitor.status === "active"
            ? computeNextRunAt(
                {
                  type: monitor.scheduleType,
                  timezone: monitor.scheduleTimezone,
                  localTime: monitor.scheduleLocalTime,
                  weekday: monitor.scheduleWeekday,
                },
                now,
              )
            : null;
        await tx
          .update(monitors)
          .set({ lastScheduledFor: now, nextRunAt })
          .where(eq(monitors.id, monitor.id));
      }
      await insertAudit(
        tx,
        audit,
        `admin.user_${status}`,
        "user",
        userId,
        userId,
        {},
      );
    });
  }

  async adjustQuota(
    input: {
      userId: string;
      units: number;
      reason: string;
      idempotencyKey: string;
    },
    audit: RequestAudit,
  ) {
    return this.db.transaction(async (tx) => {
      const [existing] = await tx
        .select()
        .from(quotaLedger)
        .where(eq(quotaLedger.idempotencyKey, `admin:${input.idempotencyKey}`))
        .limit(1);
      if (existing) return this.getQuotaSummary(input.userId);

      const [wallet] = await tx
        .select()
        .from(quotaWallets)
        .where(eq(quotaWallets.userId, input.userId))
        .for("update")
        .limit(1);
      if (!wallet)
        throw new RepositoryError("NOT_FOUND", "Quota wallet not found");
      const nextGranted = wallet.grantedUnits + input.units;
      if (
        nextGranted < wallet.consumedUnits + wallet.reservedUnits ||
        nextGranted < 0
      ) {
        throw new RepositoryError(
          "CONFLICT",
          "Quota cannot be reduced below consumed and reserved units",
        );
      }
      await tx
        .update(quotaWallets)
        .set({ grantedUnits: nextGranted })
        .where(eq(quotaWallets.userId, input.userId));
      await tx.insert(quotaLedger).values({
        id: randomUUID(),
        userId: input.userId,
        type: input.units > 0 ? "grant" : "adjust",
        units: input.units,
        idempotencyKey: `admin:${input.idempotencyKey}`,
        actorId: audit.actorId,
        reason: input.reason,
      });
      await insertAudit(
        tx,
        audit,
        "admin.quota_adjusted",
        "user",
        input.userId,
        input.userId,
        { units: input.units, reason: input.reason },
      );
      return {
        userId: input.userId,
        grantedUnits: nextGranted,
        consumedUnits: wallet.consumedUnits,
        reservedUnits: wallet.reservedUnits,
        availableUnits:
          nextGranted - wallet.consumedUnits - wallet.reservedUnits,
      };
    });
  }

  async getQuotaSummary(userId: string) {
    const [wallet] = await this.db
      .select()
      .from(quotaWallets)
      .where(eq(quotaWallets.userId, userId))
      .limit(1);
    if (!wallet)
      throw new RepositoryError("NOT_FOUND", "Quota wallet not found");
    return {
      userId,
      grantedUnits: wallet.grantedUnits,
      consumedUnits: wallet.consumedUnits,
      reservedUnits: wallet.reservedUnits,
      availableUnits:
        wallet.grantedUnits - wallet.consumedUnits - wallet.reservedUnits,
    };
  }

  async listUsers(limit = 100) {
    return this.db
      .select({
        id: users.id,
        username: users.username,
        role: users.role,
        status: users.status,
        lastLoginAt: users.lastLoginAt,
        createdAt: users.createdAt,
        grantedUnits: quotaWallets.grantedUnits,
        consumedUnits: quotaWallets.consumedUnits,
        reservedUnits: quotaWallets.reservedUnits,
      })
      .from(users)
      .leftJoin(quotaWallets, eq(users.id, quotaWallets.userId))
      .orderBy(desc(users.createdAt))
      .limit(limit);
  }

  async listQuotaLedger(userId: string, limit = 100) {
    const [user] = await this.db
      .select({ id: users.id })
      .from(users)
      .where(eq(users.id, userId))
      .limit(1);
    if (!user) throw new RepositoryError("NOT_FOUND", "User not found");
    return this.db
      .select({
        id: quotaLedger.id,
        type: quotaLedger.type,
        units: quotaLedger.units,
        reason: quotaLedger.reason,
        reservationId: quotaLedger.reservationId,
        attemptId: quotaLedger.attemptId,
        actorId: quotaLedger.actorId,
        metadata: quotaLedger.metadata,
        createdAt: quotaLedger.createdAt,
      })
      .from(quotaLedger)
      .where(eq(quotaLedger.userId, userId))
      .orderBy(desc(quotaLedger.createdAt))
      .limit(limit);
  }

  async getBillingSummary(userId: string) {
    const [wallet] = await this.db
      .select()
      .from(moneyWallets)
      .where(eq(moneyWallets.userId, userId))
      .limit(1);
    if (!wallet)
      throw new RepositoryError("NOT_FOUND", "Money wallet not found");
    return { ...billingSummary(wallet), consumptionBySource: await readAccountConsumption(this.db,userId) };
  }

  async listAccountActivity(userId: string, input: { limit?: number; source?: "monitoring" | "media_publishing" | "ai" } = {}) {
    // Canonical account ownership is resolved server-side; no caller-selected wallet UUID.
    await this.getBillingSummary(userId);
    return readAccountActivity(this.db,userId,input);
  }

  async getActivePricing() {
    const [version] = await this.db
      .select()
      .from(pricingVersions)
      .where(eq(pricingVersions.status, "active"))
      .orderBy(desc(pricingVersions.effectiveFrom))
      .limit(1);
    if (!version)
      throw new RepositoryError("INVALID_STATE", "Active pricing is missing");
    const items = await this.db
      .select()
      .from(pricingItems)
      .where(eq(pricingItems.pricingVersionId, version.id))
      .orderBy(
        asc(pricingItems.pricingClass),
        asc(pricingItems.mode),
        asc(pricingItems.screenshotEnabled),
      );
    if (items.length === 0)
      throw new RepositoryError("INVALID_STATE", "Active pricing is empty");
    return {
      versionId: version.id,
      code: version.code,
      currency: MONEY_CURRENCY,
      scale: 4 as const,
      sourceUrl: version.sourceUrl,
      effectiveFrom: version.effectiveFrom,
      items: items.map((item) => ({
        id: item.id,
        pricingClass: item.pricingClass,
        mode: item.mode,
        screenshotEnabled: item.screenshotEnabled,
        amountTenThousandths: moneyToApiString(item.amountTenThousandths),
      })),
    };
  }

  async quoteBilling(input: BillingQuoteInput) {
    const platformIds = [
      ...new Set(input.items.map((item) => item.platformId)),
    ];
    const platforms = await this.db
      .select({
        id: platformCatalog.id,
        pricingClass: platformCatalog.pricingClass,
        enabled: platformCatalog.enabled,
        verified: platformCatalog.verified,
        acceptanceRequired: platformCatalog.acceptanceRequired,
        acceptanceFingerprint: platformCatalog.acceptanceFingerprint,
        providerCode: platformCatalog.providerCode,
        displayName: platformCatalog.displayName,
        clientType: platformCatalog.clientType,
        supportsReasoning: platformCatalog.supportsReasoning,
        supportsScreenshot: platformCatalog.supportsScreenshot,
        supportsDomesticRegion: platformCatalog.supportsDomesticRegion,
        supportsOverseasRegion: platformCatalog.supportsOverseasRegion,
        providerMetadata: platformCatalog.providerMetadata,
      })
      .from(platformCatalog)
      .where(inArray(platformCatalog.id, platformIds));
    const platformById = new Map(platforms.map((item) => [item.id, item]));
    const acceptanceEvidence =
      platformIds.length > 0
        ? await this.db
            .select({
              platformId: platformAcceptanceChecks.platformId,
              platformFingerprint: platformAcceptanceChecks.platformFingerprint,
              dimension: platformAcceptanceChecks.dimension,
            })
            .from(platformAcceptanceChecks)
            .where(
              and(
                inArray(platformAcceptanceChecks.platformId, platformIds),
                eq(platformAcceptanceChecks.status, "passed"),
              ),
            )
        : [];
    const quoteRegionCodes = uniqueTrimmed(
      input.items.flatMap((item) => (item.regionCode ? [item.regionCode] : [])),
    );
    const quoteRegions =
      quoteRegionCodes.length > 0
        ? await this.db
            .select({
              code: providerRegions.code,
              scope: providerRegions.scope,
            })
            .from(providerRegions)
            .where(inArray(providerRegions.code, quoteRegionCodes))
        : [];
    const quoteRegionScopes = new Map<string, Set<"domestic" | "overseas">>();
    for (const region of quoteRegions) {
      const scopes =
        quoteRegionScopes.get(region.code) ??
        new Set<"domestic" | "overseas">();
      scopes.add(region.scope);
      quoteRegionScopes.set(region.code, scopes);
    }
    const [version] = await this.db
      .select()
      .from(pricingVersions)
      .where(eq(pricingVersions.status, "active"))
      .orderBy(desc(pricingVersions.effectiveFrom))
      .limit(1);
    if (!version)
      throw new RepositoryError("INVALID_STATE", "Active pricing is missing");
    const prices = await this.db
      .select()
      .from(pricingItems)
      .where(eq(pricingItems.pricingVersionId, version.id));
    const priceByDimensions = new Map(
      prices.map((price) => [pricingDimensionsKey(price), price]),
    );
    let total = 0n;
    const items = input.items.map((item) => {
      const platform = platformById.get(item.platformId);
      if (!platform || !platform.enabled || !platform.verified) {
        throw new RepositoryError(
          "INVALID_STATE",
          "Quote contains an unavailable platform",
        );
      }
      const availabilityBlocker = currentPlatformSelectionBlocker({
        platform,
        selection: {
          platformId: item.platformId,
          providerCode: platform.providerCode,
          clientType: platform.clientType,
          mode: item.mode,
          screenshot: item.screenshot,
          regionCode: item.regionCode ?? null,
        },
        acceptanceEvidence,
        regionScopes: item.regionCode
          ? quoteRegionScopes.get(item.regionCode)
          : undefined,
      });
      if (availabilityBlocker) {
        throw new RepositoryError("INVALID_STATE", availabilityBlocker);
      }
      if (!platform.pricingClass) {
        throw new RepositoryError(
          "INVALID_STATE",
          "Platform pricing class has not been confirmed",
        );
      }
      const screenshotEnabled = item.screenshot !== 0;
      const price = priceByDimensions.get(
        pricingDimensionsKey({
          pricingClass: platform.pricingClass,
          mode: item.mode,
          screenshotEnabled,
        }),
      );
      if (!price)
        throw new RepositoryError(
          "INVALID_STATE",
          "No active price matches the requested platform mode",
        );
      const itemTotal = price.amountTenThousandths * BigInt(item.quantity);
      total += itemTotal;
      return {
        platformId: item.platformId,
        pricingClass: platform.pricingClass,
        mode: item.mode,
        screenshotEnabled,
        quantity: item.quantity,
        unitAmountTenThousandths: moneyToApiString(price.amountTenThousandths),
        totalAmountTenThousandths: moneyToApiString(itemTotal),
      };
    });
    return {
      pricingVersionId: version.id,
      currency: MONEY_CURRENCY,
      scale: 4 as const,
      items,
      totalAmountTenThousandths: moneyToApiString(total),
    };
  }

  async listBillingLedger(userId: string, limit = 100) {
    const [wallet] = await this.db
      .select({ userId: moneyWallets.userId })
      .from(moneyWallets)
      .where(eq(moneyWallets.userId, userId))
      .limit(1);
    if (!wallet)
      throw new RepositoryError("NOT_FOUND", "Money wallet not found");
    const entries = await this.db
      .select()
      .from(moneyLedger)
      .where(eq(moneyLedger.userId, userId))
      .orderBy(desc(moneyLedger.createdAt))
      .limit(limit);
    return entries.map(publicMoneyLedgerEntry);
  }

  async listAdminBillingUsers(limit = 100) {
    const rows = await this.db
      .select({
        id: users.id,
        username: users.username,
        role: users.role,
        status: users.status,
        lastLoginAt: users.lastLoginAt,
        createdAt: users.createdAt,
        balance: moneyWallets.balanceTenThousandths,
        reserved: moneyWallets.reservedTenThousandths,
        frozen: moneyWallets.frozenTenThousandths,
        spent: moneyWallets.spentTenThousandths,
      })
      .from(users)
      .leftJoin(moneyWallets, eq(users.id, moneyWallets.userId))
      .orderBy(desc(users.createdAt))
      .limit(limit);
    return rows.map((row) => ({
      ...row,
      currency: MONEY_CURRENCY,
      scale: 4 as const,
      balanceTenThousandths: moneyToApiString(row.balance ?? 0n),
      reservedTenThousandths: moneyToApiString(row.reserved ?? 0n),
      spentTenThousandths: moneyToApiString(row.spent ?? 0n),
      availableTenThousandths: moneyToApiString(
        (row.balance ?? 0n) - (row.reserved ?? 0n) - (row.frozen ?? 0n),
      ),
    }));
  }

  async adjustMoney(
    input: {
      userId: string;
      amountTenThousandths: string | bigint;
      reason: string;
      idempotencyKey: string;
    },
    audit: RequestAudit,
  ) {
    const amount = exactMoney(input.amountTenThousandths);
    const reason = input.reason.trim();
    if (amount === 0n)
      throw new RepositoryError("INVALID_STATE", "Adjustment must be non-zero");
    if (reason.length < 3 || reason.length > 240)
      throw new RepositoryError("INVALID_STATE", "Invalid adjustment reason");
    if (
      input.idempotencyKey.length < 8 ||
      input.idempotencyKey.length > 128 ||
      input.idempotencyKey.trim() !== input.idempotencyKey
    )
      throw new RepositoryError("INVALID_STATE", "Invalid idempotency key");
    return this.db.transaction(async (tx) => {
      const key = `admin-money:${input.idempotencyKey}`;
      const [existing] = await tx
        .select()
        .from(moneyLedger)
        .where(eq(moneyLedger.idempotencyKey, key))
        .limit(1);
      if (existing) {
        if (
          existing.userId !== input.userId ||
          existing.balanceDeltaTenThousandths !== amount ||
          existing.reason !== reason
        ) {
          throw new RepositoryError(
            "CONFLICT",
            "Idempotency key is bound to another money adjustment",
          );
        }
        return billingSummary(await lockMoneyWallet(tx, input.userId));
      }
      const wallet = await lockMoneyWallet(tx, input.userId);
      const nextBalance = wallet.balanceTenThousandths + amount;
      if (amount < 0n && nextBalance < wallet.reservedTenThousandths + wallet.frozenTenThousandths) {
        throw new RepositoryError(
          "CONFLICT",
          "Adjustment cannot reduce available balance below zero",
        );
      }
      await tx
        .update(moneyWallets)
        .set({ balanceTenThousandths: nextBalance })
        .where(eq(moneyWallets.userId, input.userId));
      await insertMoneyLedger(tx, {
        userId: input.userId,
        type: "admin_adjustment",
        balanceDelta: amount,
        reservedDelta: 0n,
        nextBalance,
        nextReserved: wallet.reservedTenThousandths,
        idempotencyKey: key,
        actorId: audit.actorId,
        reason,
        referenceType: "admin_adjustment",
        referenceId: input.idempotencyKey,
      });
      await insertAudit(
        tx,
        audit,
        "admin.balance_adjusted",
        "user",
        input.userId,
        input.userId,
        {
          amountTenThousandths: moneyToApiString(amount),
          reason,
        },
      );
      return billingSummary({
        ...wallet,
        balanceTenThousandths: nextBalance,
      });
    });
  }

  async createTopupOrder(input: {
    userId: string;
    providerOrderId: string;
    paymentMethod: "alipay" | "wxpay" | "bank_transfer";
    amountTenThousandths: string | bigint;
    idempotencyKey: string;
    callbackTokenDigest: string;
    checkoutExpiresAt: Date;
  }) {
    const amount = exactMoney(input.amountTenThousandths);
    assertTopupAmount(amount);
    assertTopupOrderIdentity(input);
    return this.db.transaction(async (tx) => {
      await lockMoneyWallet(tx, input.userId);
      const [existing] = await tx
        .select()
        .from(topupOrders)
        .where(
          and(
            eq(topupOrders.userId, input.userId),
            eq(topupOrders.idempotencyKey, input.idempotencyKey),
          ),
        )
        .for("update")
        .limit(1);
      if (existing) {
        if (
          existing.amountTenThousandths !== amount ||
          existing.paymentMethod !== input.paymentMethod ||
          existing.providerOrderId !== input.providerOrderId ||
          existing.callbackTokenDigest !== input.callbackTokenDigest
        ) {
          throw new RepositoryError(
            "CONFLICT",
            "Idempotency key is bound to another top-up order",
          );
        }
        return publicTopupOrder(existing);
      }
      const orderId = randomUUID();
      await tx.insert(topupOrders).values({
        id: orderId,
        providerOrderId: input.providerOrderId,
        userId: input.userId,
        idempotencyKey: input.idempotencyKey,
        paymentMethod: input.paymentMethod,
        amountTenThousandths: amount,
        callbackTokenDigest: input.callbackTokenDigest,
        checkoutExpiresAt: input.checkoutExpiresAt,
      });
      const [created] = await tx
        .select()
        .from(topupOrders)
        .where(eq(topupOrders.id, orderId))
        .limit(1);
      if (!created)
        throw new RepositoryError(
          "INVALID_STATE",
          "Top-up order was not created",
        );
      return publicTopupOrder(created);
    });
  }

  async switchTopupPaymentMethod(input: {
    userId: string;
    orderId: string;
    expectedPaymentMethod: "alipay" | "wxpay" | "bank_transfer";
    paymentMethod: "alipay" | "wxpay" | "bank_transfer";
    providerOrderId: string;
    idempotencyKey: string;
    callbackTokenDigest: string;
    checkoutExpiresAt: Date;
  }) {
    if (input.paymentMethod === input.expectedPaymentMethod)
      throw new RepositoryError(
        "INVALID_STATE",
        "Replacement payment method must be different",
      );
    assertTopupOrderIdentity(input);
    return this.db.transaction(async (tx) => {
      const [order] = await tx
        .select()
        .from(topupOrders)
        .where(
          and(
            eq(topupOrders.id, input.orderId),
            eq(topupOrders.userId, input.userId),
          ),
        )
        .for("update")
        .limit(1);
      if (!order)
        throw new RepositoryError("NOT_FOUND", "Top-up order not found");
      const [existingReplacement] = await tx
        .select()
        .from(topupOrders)
        .where(
          and(
            eq(topupOrders.userId, input.userId),
            eq(topupOrders.idempotencyKey, input.idempotencyKey),
          ),
        )
        .for("update")
        .limit(1);
      if (existingReplacement) {
        if (
          existingReplacement.replacesOrderId !== order.id ||
          existingReplacement.paymentMethod !== input.paymentMethod ||
          existingReplacement.providerOrderId !== input.providerOrderId ||
          existingReplacement.callbackTokenDigest !==
            input.callbackTokenDigest ||
          existingReplacement.amountTenThousandths !==
            order.amountTenThousandths
        )
          throw new RepositoryError(
            "CONFLICT",
            "Idempotency key is bound to another replacement order",
          );
        return publicTopupOrder(existingReplacement);
      }
      if (order.state !== "pending")
        throw new RepositoryError(
          "CONFLICT",
          "Only pending top-up orders can change payment method",
        );
      if (order.paymentMethod !== input.expectedPaymentMethod)
        throw new RepositoryError(
          "CONFLICT",
          "Top-up payment method changed concurrently",
        );
      const replacementId = randomUUID();
      await tx.insert(topupOrders).values({
        id: replacementId,
        providerOrderId: input.providerOrderId,
        replacesOrderId: order.id,
        userId: input.userId,
        idempotencyKey: input.idempotencyKey,
        paymentMethod: input.paymentMethod,
        amountTenThousandths: order.amountTenThousandths,
        callbackTokenDigest: input.callbackTokenDigest,
        checkoutExpiresAt: input.checkoutExpiresAt,
      });
      await tx
        .update(topupOrders)
        .set({ state: "cancelled" })
        .where(eq(topupOrders.id, order.id));
      const [replacement] = await tx
        .select()
        .from(topupOrders)
        .where(eq(topupOrders.id, replacementId))
        .limit(1);
      if (!replacement)
        throw new RepositoryError(
          "INVALID_STATE",
          "Replacement top-up order was not created",
        );
      return publicTopupOrder(replacement);
    });
  }

  async expireTopupOrderIfNeeded(
    userId: string,
    orderId: string,
    observedAt: Date,
  ) {
    if (!Number.isFinite(observedAt.getTime()))
      throw new RepositoryError("INVALID_STATE", "Invalid observation time");
    return this.db.transaction(async (tx) => {
      const [order] = await tx
        .select()
        .from(topupOrders)
        .where(and(eq(topupOrders.id, orderId), eq(topupOrders.userId, userId)))
        .for("update")
        .limit(1);
      if (!order)
        throw new RepositoryError("NOT_FOUND", "Top-up order not found");
      if (
        order.state === "pending" &&
        order.checkoutExpiresAt.getTime() <= observedAt.getTime()
      ) {
        await tx
          .update(topupOrders)
          .set({ state: "expired" })
          .where(
            and(eq(topupOrders.id, order.id), eq(topupOrders.state, "pending")),
          );
        return publicTopupOrder({ ...order, state: "expired" });
      }
      return publicTopupOrder(order);
    });
  }

  async getTopupOrder(userId: string, orderId: string) {
    const [order] = await this.db
      .select()
      .from(topupOrders)
      .where(and(eq(topupOrders.id, orderId), eq(topupOrders.userId, userId)))
      .limit(1);
    if (!order)
      throw new RepositoryError("NOT_FOUND", "Top-up order not found");
    return publicTopupOrder(order);
  }

  async getTopupOrderByProviderOrderId(providerOrderId: string) {
    const [order] = await this.db
      .select()
      .from(topupOrders)
      .where(eq(topupOrders.providerOrderId, providerOrderId))
      .limit(1);
    return order
      ? {
          ...order,
          method: order.paymentMethod,
          currency: "CNY" as const,
        }
      : null;
  }

  async listTopupOrders(userId: string, limit = 100, observedAt = new Date()) {
    if (!Number.isFinite(observedAt.getTime()))
      throw new RepositoryError("INVALID_STATE", "Invalid observation time");
    return this.db.transaction(async (tx) => {
      await tx
        .update(topupOrders)
        .set({ state: "expired" })
        .where(
          and(
            eq(topupOrders.userId, userId),
            eq(topupOrders.state, "pending"),
            lte(topupOrders.checkoutExpiresAt, observedAt),
          ),
        );
      const orders = await tx
        .select()
        .from(topupOrders)
        .where(eq(topupOrders.userId, userId))
        .orderBy(desc(topupOrders.createdAt))
        .limit(limit);
      return orders.map(publicTopupOrder);
    });
  }

  async recordTopupReceiptAndCredit(input: {
    providerOrderId: string;
    provider: "zpay" | "bank";
    providerTradeNo: string;
    amountTenThousandths: string | bigint;
    paidAt: Date;
    payloadDigest: string;
    receivedAt: Date;
  }): Promise<{
    outcome: "recorded" | "replayed";
    orderId: string;
    orderState: "credited" | "review_required";
    providerTradeNo: string;
  }> {
    const amount = exactMoney(input.amountTenThousandths);
    if (amount <= 0n || amount % 100n !== 0n)
      throw new RepositoryError(
        "INVALID_STATE",
        "Receipt amount must be positive and representable in whole fen",
      );
    if (
      input.providerTradeNo.trim() !== input.providerTradeNo ||
      input.providerTradeNo.length < 1 ||
      input.providerTradeNo.length > 191
    )
      throw new RepositoryError(
        "INVALID_STATE",
        "Invalid provider transaction reference",
      );
    if (!/^[a-f0-9]{64}$/u.test(input.payloadDigest))
      throw new RepositoryError("INVALID_STATE", "Invalid receipt digest");
    if (
      !Number.isFinite(input.paidAt.getTime()) ||
      !Number.isFinite(input.receivedAt.getTime())
    )
      throw new RepositoryError("INVALID_STATE", "Invalid receipt timestamp");
    return this.db.transaction(async (tx) => {
      const [order] = await tx
        .select()
        .from(topupOrders)
        .where(eq(topupOrders.providerOrderId, input.providerOrderId))
        .for("update")
        .limit(1);
      if (!order)
        throw new RepositoryError("NOT_FOUND", "Top-up order not found");
      if (
        (input.provider === "zpay" &&
          order.paymentMethod === "bank_transfer") ||
        (input.provider === "bank" && order.paymentMethod !== "bank_transfer")
      )
        throw new RepositoryError(
          "CONFLICT",
          "Payment receipt method does not match the top-up order",
        );
      const [existingTrade] = await tx
        .select()
        .from(topupReceipts)
        .where(
          and(
            eq(topupReceipts.provider, input.provider),
            eq(topupReceipts.providerTradeNo, input.providerTradeNo),
          ),
        )
        .limit(1);
      const [existingOrderReceipt] = await tx
        .select()
        .from(topupReceipts)
        .where(eq(topupReceipts.orderId, order.id))
        .limit(1);
      const existing = existingTrade ?? existingOrderReceipt;
      if (existing) {
        if (
          existing.orderId !== order.id ||
          existing.amountTenThousandths !== amount ||
          existing.provider !== input.provider ||
          existing.providerTradeNo !== input.providerTradeNo
        ) {
          throw new RepositoryError(
            "CONFLICT",
            "Payment receipt is already bound to another settlement",
          );
        }
        return {
          outcome: "replayed",
          orderId: order.id,
          orderState:
            order.state === "credited" ? "credited" : "review_required",
          providerTradeNo: existing.providerTradeNo,
        };
      }
      await claimMonitoringReceipt(tx, {
        provider: input.provider, providerTradeNo: input.providerTradeNo,
        providerOrderId: order.providerOrderId, payloadDigest: input.payloadDigest,
        receivedAt: input.receivedAt,
      });
      const receiptId = randomUUID();
      await tx.insert(topupReceipts).values({
        id: receiptId,
        orderId: order.id,
        provider: input.provider,
        providerTradeNo: input.providerTradeNo,
        amountTenThousandths: amount,
        paidAt: input.paidAt,
        payloadDigest: input.payloadDigest,
        receivedAt: input.receivedAt,
      });
      const shouldReview =
        amount !== order.amountTenThousandths ||
        ["expired", "cancelled", "rejected", "review_required"].includes(
          order.state,
        );
      if (shouldReview) {
        await tx.update(paymentReceiptClaims).set({status:"review_required"})
          .where(eq(paymentReceiptClaims.providerOrderId,order.providerOrderId));
        await tx
          .update(topupOrders)
          .set({ state: "review_required", paidAt: input.paidAt })
          .where(eq(topupOrders.id, order.id));
        return {
          outcome: "recorded",
          orderId: order.id,
          orderState: "review_required",
          providerTradeNo: input.providerTradeNo,
        };
      }
      await creditTopupOrder(tx, order, receiptId, input.paidAt);
      return {
        outcome: "recorded",
        orderId: order.id,
        orderState: "credited",
        providerTradeNo: input.providerTradeNo,
      };
    });
  }

  async submitBankTransferReview(input: {
    userId: string;
    orderId: string;
    payerName: string;
    transferredAt: Date;
    remittanceReference: string;
    evidenceObjectKey?: string;
    submittedAt?: Date;
  }) {
    const submittedAt = input.submittedAt ?? new Date();
    const payerName = input.payerName.trim();
    const remittanceReference = input.remittanceReference.trim();
    if (payerName.length < 2 || payerName.length > 120)
      throw new RepositoryError("INVALID_STATE", "Invalid payer name");
    if (remittanceReference.length < 3 || remittanceReference.length > 191)
      throw new RepositoryError(
        "INVALID_STATE",
        "Invalid bank transaction reference",
      );
    if (
      !Number.isFinite(input.transferredAt.getTime()) ||
      input.transferredAt.getTime() > submittedAt.getTime() + 5 * 60 * 1_000
    )
      throw new RepositoryError("INVALID_STATE", "Invalid transfer time");
    return this.db.transaction(async (tx) => {
      const [order] = await tx
        .select()
        .from(topupOrders)
        .where(
          and(
            eq(topupOrders.id, input.orderId),
            eq(topupOrders.userId, input.userId),
          ),
        )
        .for("update")
        .limit(1);
      if (!order)
        throw new RepositoryError("NOT_FOUND", "Top-up order not found");
      if (order.paymentMethod !== "bank_transfer")
        throw new RepositoryError(
          "INVALID_STATE",
          "Top-up order is not a bank transfer",
        );
      if (!["pending", "review_required"].includes(order.state))
        throw new RepositoryError(
          "CONFLICT",
          "Top-up order cannot enter bank review",
        );
      const [existing] = await tx
        .select()
        .from(bankTransferReviews)
        .where(eq(bankTransferReviews.orderId, order.id))
        .for("update")
        .limit(1);
      if (existing) {
        if (
          existing.payerName !== payerName ||
          existing.transferredAt.getTime() !== input.transferredAt.getTime() ||
          existing.remittanceReference !== remittanceReference ||
          existing.evidenceObjectKey !== (input.evidenceObjectKey ?? null)
        ) {
          throw new RepositoryError(
            "CONFLICT",
            "Bank transfer review already contains different evidence",
          );
        }
        return existing;
      }
      const review = {
        id: randomUUID(),
        orderId: order.id,
        payerName,
        transferredAt: input.transferredAt,
        remittanceReference,
        evidenceObjectKey: input.evidenceObjectKey ?? null,
        submittedAt,
      };
      await tx.insert(bankTransferReviews).values(review);
      await tx
        .update(topupOrders)
        .set({ state: "review_required" })
        .where(eq(topupOrders.id, order.id));
      return { ...review, status: "pending" as const };
    });
  }

  async listPendingBankTransferReviews(limit = 100) {
    return this.db
      .select({
        review: bankTransferReviews,
        order: topupOrders,
        username: users.username,
      })
      .from(bankTransferReviews)
      .innerJoin(topupOrders, eq(bankTransferReviews.orderId, topupOrders.id))
      .innerJoin(users, eq(topupOrders.userId, users.id))
      .where(eq(bankTransferReviews.status, "pending"))
      .orderBy(asc(bankTransferReviews.submittedAt))
      .limit(limit);
  }

  async reviewBankTransfer(
    input: {
      reviewId: string;
      decision: "approve" | "reject";
      reason: string;
      providerTradeNo?: string;
      reviewedAt?: Date;
    },
    audit: RequestAudit,
  ) {
    const reason = input.reason.trim();
    const providerTradeNo = input.providerTradeNo?.trim();
    if (reason.length < 3 || reason.length > 240)
      throw new RepositoryError("INVALID_STATE", "Invalid bank review reason");
    if (
      input.decision === "approve" &&
      (!providerTradeNo ||
        providerTradeNo.length < 3 ||
        providerTradeNo.length > 191)
    )
      throw new RepositoryError(
        "INVALID_STATE",
        "Approved bank transfer requires a transaction reference",
      );
    return this.db.transaction(async (tx) => {
      const [review] = await tx
        .select()
        .from(bankTransferReviews)
        .where(eq(bankTransferReviews.id, input.reviewId))
        .for("update")
        .limit(1);
      if (!review)
        throw new RepositoryError(
          "NOT_FOUND",
          "Bank transfer review not found",
        );
      const [order] = await tx
        .select()
        .from(topupOrders)
        .where(eq(topupOrders.id, review.orderId))
        .for("update")
        .limit(1);
      if (!order)
        throw new RepositoryError("INVALID_STATE", "Top-up order is missing");
      const targetStatus =
        input.decision === "approve" ? "approved" : "rejected";
      if (review.status !== "pending") {
        if (review.status === targetStatus) {
          if (review.reviewReason !== reason)
            throw new RepositoryError(
              "CONFLICT",
              "Bank review replay contains a different reason",
            );
          if (targetStatus === "approved") {
            const [receipt] = await tx
              .select({ providerTradeNo: topupReceipts.providerTradeNo })
              .from(topupReceipts)
              .where(eq(topupReceipts.orderId, order.id))
              .limit(1);
            if (!receipt || receipt.providerTradeNo !== providerTradeNo)
              throw new RepositoryError(
                "CONFLICT",
                "Bank review replay contains a different transaction reference",
              );
          }
          return review;
        }
        throw new RepositoryError("CONFLICT", "Bank review is already settled");
      }
      const reviewedAt = input.reviewedAt ?? new Date();
      if (input.decision === "approve") {
        await claimMonitoringReceipt(tx, {
          provider: "bank", providerTradeNo: providerTradeNo!,
          providerOrderId: order.providerOrderId,
          payloadDigest: sha256(`bank:${review.id}:${providerTradeNo}`), receivedAt: reviewedAt,
        });
        const receiptId = randomUUID();
        await tx.insert(topupReceipts).values({
          id: receiptId,
          orderId: order.id,
          provider: "bank",
          providerTradeNo: providerTradeNo!,
          amountTenThousandths: order.amountTenThousandths,
          paidAt: reviewedAt,
          payloadDigest: sha256(`bank:${review.id}:${providerTradeNo}`),
          receivedAt: reviewedAt,
        });
        await creditTopupOrder(tx, order, receiptId, reviewedAt);
      } else {
        await tx
          .update(topupOrders)
          .set({ state: "rejected" })
          .where(eq(topupOrders.id, order.id));
      }
      await tx
        .update(bankTransferReviews)
        .set({
          status: targetStatus,
          reviewedBy: audit.actorId,
          reviewReason: reason,
          reviewedAt,
        })
        .where(eq(bankTransferReviews.id, review.id));
      await insertAudit(
        tx,
        audit,
        `admin.bank_transfer_${targetStatus}`,
        "topup_order",
        order.id,
        order.userId,
        { reason },
      );
      return {
        ...review,
        status: targetStatus,
        reviewedBy: audit.actorId,
        reviewReason: reason,
        reviewedAt,
      };
    });
  }

  async createProject(
    ownerId: string,
    input: ProjectCreateInput,
    audit: RequestAudit,
  ) {
    const projectId = randomUUID();
    const brandVersionId = randomUUID();
    await this.db.transaction(async (tx) => {
      await tx.insert(projects).values({
        enterpriseProjectId: currentMonitoringEnterpriseProjectId(),
        id: projectId,
        ownerId,
        name: input.name,
        timezone: input.timezone,
        currentBrandVersionId: brandVersionId,
      });
      await tx.insert(projectBrandVersions).values({
        id: brandVersionId,
        projectId,
        version: 1,
        mainBrand: input.mainBrand,
        aliases: uniqueTrimmed(input.aliases),
        competitors: normalizeCompetitors(input.competitors),
        createdBy: ownerId,
      });
      await insertAudit(
        tx,
        audit,
        "project.created",
        "project",
        projectId,
        ownerId,
        { name: input.name },
      );
    });
    return this.getProject(ownerId, projectId);
  }

  async listProjects(ownerId: string) {
    return this.db
      .select({
        id: projects.id,
        name: projects.name,
        timezone: projects.timezone,
        createdAt: projects.createdAt,
        mainBrand: projectBrandVersions.mainBrand,
        aliases: projectBrandVersions.aliases,
        competitors: projectBrandVersions.competitors,
      })
      .from(projects)
      .innerJoin(
        projectBrandVersions,
        eq(projects.currentBrandVersionId, projectBrandVersions.id),
      )
      .where(and(monitoringProjectOwnerPredicate(projects, ownerId), isNull(projects.deletedAt)))
      .orderBy(asc(projects.createdAt));
  }

  async listDeletedProjects(ownerId: string) {
    return this.db
      .select({
        id: projects.id,
        name: projects.name,
        deletedAt: projects.deletedAt,
        purgeAfter: projects.purgeAfter,
      })
      .from(projects)
      .where(
        and(
          monitoringProjectOwnerPredicate(projects, ownerId),
          sql`${projects.deletedAt} IS NOT NULL`,
        ),
      )
      .orderBy(desc(projects.deletedAt));
  }

  async softDeleteProject(
    ownerId: string,
    projectId: string,
    audit: RequestAudit,
  ) {
    const now = new Date();
    const purgeAfter = new Date(now.getTime() + 30 * 86_400_000);
    await this.db.transaction(async (tx) => {
      const result = await tx
        .update(projects)
        .set({ deletedAt: now, purgeAfter })
        .where(
          and(
            eq(projects.id, projectId),
            monitoringProjectOwnerPredicate(projects, ownerId),
            isNull(projects.deletedAt),
          ),
        );
      if (affectedRows(result) !== 1)
        throw new RepositoryError("NOT_FOUND", "Project not found");
      await tx
        .update(monitors)
        .set({ nextRunAt: null })
        .where(
          and(eq(monitors.projectId, projectId), isNull(monitors.deletedAt)),
        );
      const projectMonitorRows = await tx
        .select({ id: monitors.id })
        .from(monitors)
        .where(
          and(eq(monitors.projectId, projectId), isNull(monitors.deletedAt)),
        );
      if (projectMonitorRows.length > 0) {
        // Deletion is the cancellation boundary for schedule occurrences that
        // have not yet become runs. Bound occurrences remain historical data.
        await tx.delete(scheduleOccurrences).where(
          and(
            inArray(
              scheduleOccurrences.monitorId,
              projectMonitorRows.map((monitor) => monitor.id),
            ),
            isNull(scheduleOccurrences.runId),
          ),
        );
      }
      await tx.insert(jobs).values({
        id: randomUUID(),
        type: "purge_soft_deleted",
        dedupeKey: `purge:project:${projectId}`,
        payload: { entityType: "project", entityId: projectId },
        availableAt: purgeAfter,
      });
      await insertAudit(
        tx,
        audit,
        "project.deleted",
        "project",
        projectId,
        ownerId,
        { purgeAfter: purgeAfter.toISOString() },
      );
    });
  }

  async restoreProject(
    ownerId: string,
    projectId: string,
    audit: RequestAudit,
  ) {
    const now = new Date();
    await this.db.transaction(async (tx) => {
      const [project] = await tx
        .select()
        .from(projects)
        .where(
          and(
            eq(projects.id, projectId),
            monitoringProjectOwnerPredicate(projects, ownerId),
            sql`${projects.deletedAt} IS NOT NULL`,
          ),
        )
        .for("update")
        .limit(1);
      if (!project || (project.purgeAfter && project.purgeAfter <= now))
        throw new RepositoryError("NOT_FOUND", "Restorable project not found");
      await tx
        .update(projects)
        .set({ deletedAt: null, purgeAfter: null })
        .where(eq(projects.id, projectId));
      const ownedMonitors = await tx
        .select({ id: monitors.id })
        .from(monitors)
        .where(
          and(eq(monitors.projectId, projectId), isNull(monitors.deletedAt)),
        );
      if (ownedMonitors.length > 0) {
        const monitorIds = ownedMonitors.map((monitor) => monitor.id);
        await tx
          .update(monitors)
          .set({ status: "paused", nextRunAt: null, lastScheduledFor: now })
          .where(inArray(monitors.id, monitorIds));
        await tx
          .delete(scheduleOccurrences)
          .where(
            and(
              inArray(scheduleOccurrences.monitorId, monitorIds),
              isNull(scheduleOccurrences.runId),
            ),
          );
      }
      // Removing the future purge job allows a restored entity to be deleted
      // again later without colliding with the jobs.dedupe_key constraint.
      await tx
        .delete(jobs)
        .where(eq(jobs.dedupeKey, `purge:project:${projectId}`));
      await insertAudit(
        tx,
        audit,
        "project.restored",
        "project",
        projectId,
        ownerId,
        {},
      );
    });
  }

  async getProject(ownerId: string, projectId: string) {
    const [project] = await this.db
      .select({
        id: projects.id,
        name: projects.name,
        timezone: projects.timezone,
        createdAt: projects.createdAt,
        brandVersionId: projectBrandVersions.id,
        brandVersion: projectBrandVersions.version,
        mainBrand: projectBrandVersions.mainBrand,
        aliases: projectBrandVersions.aliases,
        competitors: projectBrandVersions.competitors,
      })
      .from(projects)
      .innerJoin(
        projectBrandVersions,
        eq(projects.currentBrandVersionId, projectBrandVersions.id),
      )
      .where(
        and(
          eq(projects.id, projectId),
          monitoringProjectOwnerPredicate(projects, ownerId),
          isNull(projects.deletedAt),
        ),
      )
      .limit(1);
    if (!project) throw new RepositoryError("NOT_FOUND", "Project not found");
    return project;
  }

  async updateProjectBrand(
    ownerId: string,
    input: {
      projectId: string;
      name?: string;
      timezone?: string;
      mainBrand: string;
      aliases: string[];
      competitors: Array<{ name: string; aliases: string[] }>;
    },
    audit: RequestAudit,
  ) {
    const versionId = randomUUID();
    await this.db.transaction(async (tx) => {
      const [project] = await tx
        .select()
        .from(projects)
        .where(
          and(
            eq(projects.id, input.projectId),
            monitoringProjectOwnerPredicate(projects, ownerId),
            isNull(projects.deletedAt),
          ),
        )
        .for("update")
        .limit(1);
      if (!project) throw new RepositoryError("NOT_FOUND", "Project not found");
      const [owner] = await tx
        .select({ status: users.status })
        .from(users)
        .where(eq(users.id, ownerId))
        .limit(1);
      if (!owner || owner.status !== "active")
        throw new RepositoryError("INVALID_STATE", "Account is not active");
      const [latest] = await tx
        .select({ version: projectBrandVersions.version })
        .from(projectBrandVersions)
        .where(eq(projectBrandVersions.projectId, input.projectId))
        .orderBy(desc(projectBrandVersions.version))
        .limit(1);
      const version = (latest?.version ?? 0) + 1;
      const aliases = uniqueTrimmed(input.aliases);
      const competitors = normalizeCompetitors(input.competitors);
      await tx.insert(projectBrandVersions).values({
        id: versionId,
        projectId: input.projectId,
        version,
        mainBrand: input.mainBrand,
        aliases,
        competitors,
        createdBy: ownerId,
      });

      // Brand settings are project-scoped. Derive an immutable monitor version
      // for every live monitor so future manual and newly materialized scheduled
      // runs use the new brand snapshot without making the user edit monitors
      // one by one. Existing runs and already materialized occurrences keep
      // their previous monitorVersionId and therefore remain historically exact.
      const projectMonitors = await tx
        .select()
        .from(monitors)
        .where(
          and(
            eq(monitors.projectId, input.projectId),
            monitoringChildOwnerPredicate(monitors, ownerId),
            isNull(monitors.deletedAt),
          ),
        )
        .orderBy(asc(monitors.id))
        .for("update");
      for (const monitor of projectMonitors) {
        if (!monitor.activeVersionId) {
          throw new RepositoryError(
            "INVALID_STATE",
            "Monitor has no active configuration",
          );
        }
        const [activeVersion] = await tx
          .select()
          .from(monitorVersions)
          .where(
            and(
              eq(monitorVersions.id, monitor.activeVersionId),
              eq(monitorVersions.monitorId, monitor.id),
            ),
          )
          .limit(1);
        if (!activeVersion) {
          throw new RepositoryError(
            "INVALID_STATE",
            "Monitor active configuration is invalid",
          );
        }
        const [latestMonitorVersion] = await tx
          .select({ version: monitorVersions.version })
          .from(monitorVersions)
          .where(eq(monitorVersions.monitorId, monitor.id))
          .orderBy(desc(monitorVersions.version))
          .limit(1);
        const monitorVersion = (latestMonitorVersion?.version ?? 0) + 1;
        const newMonitorVersionId = randomUUID();
        const [questions, platforms] = await Promise.all([
          tx
            .select()
            .from(monitorQuestions)
            .where(eq(monitorQuestions.monitorVersionId, activeVersion.id))
            .orderBy(asc(monitorQuestions.ordinal)),
          tx
            .select()
            .from(monitorPlatforms)
            .where(eq(monitorPlatforms.monitorVersionId, activeVersion.id))
            .orderBy(asc(monitorPlatforms.ordinal)),
        ]);
        const configurationSnapshot = {
          name: activeVersion.name,
          brandAliases: aliases,
          competitors,
          questions: questions.map((question) => question.questionSnapshot),
          platforms: platforms.map((platform) => ({
            platformId: platform.platformId,
            providerCode: platform.providerCodeSnapshot,
            clientType: platform.clientType,
            mode: platform.mode,
            screenshot: platform.screenshot,
            regionCode: platform.regionCode,
          })),
          repetitions: activeVersion.repetitions,
          schedule: {
            type: monitor.scheduleType,
            timezone: monitor.scheduleTimezone,
            localTime: monitor.scheduleLocalTime,
            weekday: monitor.scheduleWeekday,
          },
        };
        await tx.insert(monitorVersions).values({
          id: newMonitorVersionId,
          monitorId: monitor.id,
          projectBrandVersionId: versionId,
          version: monitorVersion,
          name: activeVersion.name,
          brandAliases: aliases,
          competitors,
          repetitions: activeVersion.repetitions,
          expectedAttempts: activeVersion.expectedAttempts,
          configurationHash: sha256(stableJson(configurationSnapshot)),
          createdBy: ownerId,
        });
        if (questions.length > 0) {
          await tx.insert(monitorQuestions).values(
            questions.map((question) => ({
              monitorVersionId: newMonitorVersionId,
              ordinal: question.ordinal,
              questionId: question.questionId,
              questionSnapshot: question.questionSnapshot,
            })),
          );
        }
        if (platforms.length > 0) {
          await tx.insert(monitorPlatforms).values(
            platforms.map((platform) => ({
              monitorVersionId: newMonitorVersionId,
              ordinal: platform.ordinal,
              platformId: platform.platformId,
              providerCodeSnapshot: platform.providerCodeSnapshot,
              clientType: platform.clientType,
              mode: platform.mode,
              screenshot: platform.screenshot,
              regionCode: platform.regionCode,
            })),
          );
        }
        await tx
          .update(monitors)
          .set({ activeVersionId: newMonitorVersionId })
          .where(eq(monitors.id, monitor.id));
        await insertAudit(
          tx,
          audit,
          "monitor.version_created",
          "monitor",
          monitor.id,
          ownerId,
          {
            version: monitorVersion,
            expectedAttempts: activeVersion.expectedAttempts,
            reason: "project_brand_updated",
            projectBrandVersion: version,
          },
        );
      }
      await tx
        .update(projects)
        .set({
          currentBrandVersionId: versionId,
          ...(input.name !== undefined ? { name: input.name } : {}),
          ...(input.timezone !== undefined ? { timezone: input.timezone } : {}),
        })
        .where(eq(projects.id, input.projectId));
      await insertAudit(
        tx,
        audit,
        "project.updated",
        "project",
        input.projectId,
        ownerId,
        {
          version,
          propagatedMonitors: projectMonitors.length,
          ...(input.name !== undefined ? { name: input.name } : {}),
          ...(input.timezone !== undefined ? { timezone: input.timezone } : {}),
        },
      );
    });
    return this.getProject(ownerId, input.projectId);
  }

  async listPlatforms(includeAdministrativeFields = false) {
    let rows;
    if (includeAdministrativeFields) {
      rows = await this.db
        .select()
        .from(platformCatalog)
        .orderBy(
          asc(platformCatalog.displayName),
          asc(platformCatalog.clientType),
        );
    } else {
      rows = await this.db
        .select({
          id: platformCatalog.id,
          providerCode: platformCatalog.providerCode,
          displayName: platformCatalog.displayName,
          clientType: platformCatalog.clientType,
          pricingClass: platformCatalog.pricingClass,
          enabled: platformCatalog.enabled,
          verified: platformCatalog.verified,
          supportsReasoning: platformCatalog.supportsReasoning,
          supportsScreenshot: platformCatalog.supportsScreenshot,
          supportsDomesticRegion: platformCatalog.supportsDomesticRegion,
          supportsOverseasRegion: platformCatalog.supportsOverseasRegion,
          acceptanceRequired: platformCatalog.acceptanceRequired,
          acceptanceFingerprint: platformCatalog.acceptanceFingerprint,
          providerMetadata: platformCatalog.providerMetadata,
          discoveredAt: platformCatalog.discoveredAt,
          verifiedAt: platformCatalog.verifiedAt,
        })
        .from(platformCatalog)
        .orderBy(
          asc(platformCatalog.displayName),
          asc(platformCatalog.clientType),
        );
    }
    const acceptance = await this.platformAcceptanceStates(rows);
    return rows.map((row) => ({
      ...row,
      acceptance: acceptance.get(row.id),
    }));
  }

  private async platformAcceptanceStates(
    rows: ReadonlyArray<{
      id: string;
      providerCode: string;
      clientType: "web" | "mobile";
      providerMetadata: Record<string, unknown> | null;
      acceptanceRequired: boolean;
      acceptanceFingerprint: string | null;
      verified: boolean;
      supportsReasoning: boolean;
      supportsScreenshot: boolean;
      supportsDomesticRegion: boolean;
      supportsOverseasRegion: boolean;
    }>,
  ) {
    const result = new Map<
      string,
      {
        catalogFingerprint: string | null;
        searchDefault: PlatformAcceptanceStatus;
        reasoningSearch: PlatformAcceptanceStatus;
        screenshotMention: PlatformAcceptanceStatus;
        screenshotAll: PlatformAcceptanceStatus;
        regionDefault: PlatformAcceptanceStatus;
        regionDomestic: PlatformAcceptanceStatus;
        regionOverseas: PlatformAcceptanceStatus;
        mobileNoRegion: PlatformAcceptanceStatus;
      }
    >();
    if (rows.length === 0) return result;
    const checks = await this.db
      .select()
      .from(platformAcceptanceChecks)
      .where(
        inArray(
          platformAcceptanceChecks.platformId,
          rows.map(({ id }) => id),
        ),
      )
      .orderBy(desc(platformAcceptanceChecks.updatedAt));
    for (const platform of rows) {
      const catalogFingerprint =
        platform.acceptanceFingerprint ??
        platformAcceptanceFingerprint(platform);
      const current = new Map<
        PlatformAcceptanceDimension,
        PlatformAcceptanceStatus
      >();
      for (const check of checks) {
        if (
          check.platformId === platform.id &&
          check.platformFingerprint === catalogFingerprint &&
          !current.has(check.dimension)
        ) {
          current.set(check.dimension, check.status);
        }
      }
      const pendingOrLegacy = (
        legacySupported: boolean,
      ): PlatformAcceptanceStatus => {
        if (platform.acceptanceRequired) return "pending";
        return legacySupported ? "passed" : "unsupported";
      };
      const state = (
        dimension: PlatformAcceptanceDimension,
        legacySupported: boolean,
      ) => current.get(dimension) ?? pendingOrLegacy(legacySupported);
      result.set(platform.id, {
        catalogFingerprint,
        searchDefault: state("search_default", platform.verified),
        reasoningSearch: state("reasoning_search", platform.supportsReasoning),
        screenshotMention: state(
          "screenshot_mention",
          platform.supportsScreenshot,
        ),
        screenshotAll: state("screenshot_all", platform.supportsScreenshot),
        regionDefault: state("region_default", platform.verified),
        regionDomestic: state(
          "region_domestic",
          platform.supportsDomesticRegion,
        ),
        regionOverseas: state(
          "region_overseas",
          platform.supportsOverseasRegion,
        ),
        mobileNoRegion: state("mobile_no_region", platform.verified),
      });
    }
    return result;
  }

  async upsertPlatform(
    input: {
      platformId?: string;
      providerCode: string;
      displayName: string;
      clientType: "web" | "mobile";
      enabled: boolean;
      verified: boolean;
      supportsReasoning: boolean;
      supportsScreenshot: boolean;
      supportsDomesticRegion: boolean;
      supportsOverseasRegion: boolean;
      pricingClass?: "domestic" | "overseas" | null;
    },
    audit: RequestAudit,
  ) {
    const [existing] = await this.db
      .select()
      .from(platformCatalog)
      .where(
        and(
          eq(platformCatalog.providerCode, input.providerCode),
          eq(platformCatalog.clientType, input.clientType),
        ),
      )
      .limit(1);
    const platformId = existing?.id ?? input.platformId ?? randomUUID();
    const now = new Date();
    await this.db.transaction(async (tx) => {
      if (existing) {
        await tx
          .update(platformCatalog)
          .set({
            displayName: input.displayName,
            enabled: input.enabled,
            acceptanceRequired: true,
            ...(input.pricingClass !== undefined
              ? { pricingClass: input.pricingClass }
              : {}),
            updatedBy: audit.actorId,
          })
          .where(eq(platformCatalog.id, platformId));
      } else {
        await tx.insert(platformCatalog).values({
          id: platformId,
          providerCode: input.providerCode,
          displayName: input.displayName,
          clientType: input.clientType,
          enabled: input.enabled,
          pricingClass: input.pricingClass ?? null,
          discoveredAt: now,
          acceptanceRequired: true,
          verified: false,
          supportsReasoning: false,
          supportsScreenshot: false,
          supportsDomesticRegion: false,
          supportsOverseasRegion: false,
          verifiedAt: null,
          updatedBy: audit.actorId,
        });
      }
      await insertAudit(
        tx,
        audit,
        "admin.platform_upserted",
        "platform",
        platformId,
        null,
        {
          providerCode: input.providerCode,
          enabled: input.enabled,
          requestedVerified: input.verified,
          verificationSource: "acceptance_required",
        },
      );
    });
    return platformId;
  }

  private async preparePlatformAcceptancePlan(
    input: PlatformAcceptancePlanInput,
  ) {
    const [project] = await this.db
      .select({ id: projects.id })
      .from(projects)
      .where(
        and(
          eq(projects.id, input.projectId),
          monitoringProjectOwnerPredicate(projects, input.ownerId),
          isNull(projects.deletedAt),
        ),
      )
      .limit(1);
    if (!project) {
      throw new RepositoryError(
        "NOT_FOUND",
        "Acceptance test project does not belong to the selected customer",
      );
    }
    const selectedIds = input.platformIds
      ? [...new Set(input.platformIds)]
      : null;
    const platformRows = selectedIds
      ? await this.db
          .select()
          .from(platformCatalog)
          .where(inArray(platformCatalog.id, selectedIds))
      : await this.db
          .select()
          .from(platformCatalog)
          .where(eq(platformCatalog.acceptanceRequired, true));
    if (
      platformRows.length === 0 ||
      (selectedIds && platformRows.length !== selectedIds.length)
    ) {
      throw new RepositoryError(
        "INVALID_STATE",
        "The acceptance plan contains a missing platform",
      );
    }
    const [pricingVersion] = await this.db
      .select({ id: pricingVersions.id })
      .from(pricingVersions)
      .where(eq(pricingVersions.status, "active"))
      .orderBy(desc(pricingVersions.effectiveFrom))
      .limit(1);
    if (!pricingVersion) {
      throw new RepositoryError("INVALID_STATE", "Active pricing is missing");
    }
    const prices = await this.db
      .select({
        pricingClass: pricingItems.pricingClass,
        mode: pricingItems.mode,
        screenshotEnabled: pricingItems.screenshotEnabled,
        amountTenThousandths: pricingItems.amountTenThousandths,
      })
      .from(pricingItems)
      .where(eq(pricingItems.pricingVersionId, pricingVersion.id));
    const regions = await this.db
      .select({ code: providerRegions.code, scope: providerRegions.scope })
      .from(providerRegions)
      .orderBy(asc(providerRegions.name), asc(providerRegions.code));
    const domesticRegionCode =
      input.domesticRegionCode ??
      regions.find(({ scope }) => scope === "domestic")?.code ??
      null;
    const overseasRegionCode =
      input.overseasRegionCode ??
      regions.find(({ scope }) => scope === "overseas")?.code ??
      null;
    if (
      input.domesticRegionCode &&
      !regions.some(
        ({ code, scope }) =>
          code === input.domesticRegionCode && scope === "domestic",
      )
    ) {
      throw new RepositoryError(
        "INVALID_STATE",
        "The selected domestic region is not in the synchronized provider catalog",
      );
    }
    if (
      input.overseasRegionCode &&
      !regions.some(
        ({ code, scope }) =>
          code === input.overseasRegionCode && scope === "overseas",
      )
    ) {
      throw new RepositoryError(
        "INVALID_STATE",
        "The selected overseas region is not in the synchronized provider catalog",
      );
    }
    if (
      platformRows.some(({ clientType }) => clientType === "web") &&
      (!domesticRegionCode || !overseasRegionCode)
    ) {
      throw new RepositoryError(
        "INVALID_STATE",
        "Both domestic and overseas region catalogs must be synchronized before testing web models",
      );
    }
    let checks: PlatformAcceptanceCheckPlan[];
    try {
      checks = buildPlatformAcceptancePlan({
        platforms: platformRows,
        prices,
        domesticRegionCode,
        overseasRegionCode,
      });
    } catch (error) {
      throw new RepositoryError(
        "INVALID_STATE",
        error instanceof Error ? error.message : "Acceptance plan is invalid",
      );
    }
    if (checks.length === 0 || checks.length > 500) {
      throw new RepositoryError(
        "INVALID_STATE",
        `An acceptance batch must contain 1-500 attempts; received ${checks.length}`,
      );
    }
    const questionHash = acceptanceSha256(input.question.trim());
    const planFingerprint = platformAcceptancePlanFingerprint({
      ownerId: input.ownerId,
      projectId: input.projectId,
      questionHash,
      checks,
    });
    const totalAmountTenThousandths = checks.reduce(
      (total, check) => total + check.unitAmountTenThousandths,
      0n,
    );
    return {
      planFingerprint,
      questionHash,
      checks,
      totalAmountTenThousandths,
    };
  }

  async planPlatformAcceptance(input: PlatformAcceptancePlanInput) {
    const plan = await this.preparePlatformAcceptancePlan(input);
    return {
      planFingerprint: plan.planFingerprint,
      currency: MONEY_CURRENCY,
      scale: 4 as const,
      attemptCount: plan.checks.length,
      totalAmountTenThousandths: moneyToApiString(
        plan.totalAmountTenThousandths,
      ),
      checks: plan.checks.map((check) => ({
        ...check,
        unitAmountTenThousandths: moneyToApiString(
          check.unitAmountTenThousandths,
        ),
      })),
    };
  }

  async startPlatformAcceptanceBatch(
    input: PlatformAcceptanceStartInput,
    audit: RequestAudit,
  ) {
    const plan = await this.preparePlatformAcceptancePlan(input);
    const requestedBy = audit.actorId;
    if (!requestedBy) {
      throw new RepositoryError(
        "INVALID_STATE",
        "An authenticated administrator is required",
      );
    }
    if (plan.planFingerprint !== input.planFingerprint) {
      throw new RepositoryError(
        "CONFLICT",
        "The platform catalog or pricing changed; review a fresh acceptance quote",
      );
    }
    if (
      plan.totalAmountTenThousandths !==
      BigInt(input.confirmedTotalAmountTenThousandths)
    ) {
      throw new RepositoryError(
        "CONFLICT",
        "The confirmed acceptance budget does not match the current quote",
      );
    }
    const [duplicate] = await this.db
      .select()
      .from(platformAcceptanceBatches)
      .where(
        and(
          eq(platformAcceptanceBatches.requestedBy, requestedBy),
          eq(platformAcceptanceBatches.idempotencyKey, input.idempotencyKey),
        ),
      )
      .limit(1);
    if (duplicate) {
      if (duplicate.planFingerprint !== input.planFingerprint) {
        throw new RepositoryError(
          "CONFLICT",
          "The idempotency key is already bound to another acceptance plan",
        );
      }
      return this.getPlatformAcceptanceBatch(duplicate.id);
    }
    const batchId = randomUUID();
    await this.db.transaction(async (tx) => {
      const [project] = await tx
        .select({
          id: projects.id,
          currentBrandVersionId: projects.currentBrandVersionId,
        })
        .from(projects)
        .where(
          and(
            eq(projects.id, input.projectId),
            monitoringProjectOwnerPredicate(projects, input.ownerId),
            isNull(projects.deletedAt),
          ),
        )
        .for("update")
        .limit(1);
      if (!project?.currentBrandVersionId) {
        throw new RepositoryError("NOT_FOUND", "Test project not found");
      }
      const [brand] = await tx
        .select()
        .from(projectBrandVersions)
        .where(eq(projectBrandVersions.id, project.currentBrandVersionId))
        .limit(1);
      if (!brand) {
        throw new RepositoryError(
          "INVALID_STATE",
          "Test project brand snapshot is missing",
        );
      }
      const startedAt = new Date();
      await tx.insert(platformAcceptanceBatches).values({
        id: batchId,
        ownerId: input.ownerId,
        projectId: input.projectId,
        requestedBy,
        planFingerprint: plan.planFingerprint,
        questionHash: plan.questionHash,
        questionSnapshot: input.question.trim(),
        status: "running",
        attemptCount: plan.checks.length,
        totalAmountTenThousandths: plan.totalAmountTenThousandths,
        idempotencyKey: input.idempotencyKey,
        startedAt,
      });
      const actualAttemptIds: string[] = [];
      for (const [ordinal, check] of plan.checks.entries()) {
        const checkId = randomUUID();
        const monitorId = randomUUID();
        const versionId = randomUUID();
        const configuration: MonitorConfiguration = {
          name: `[能力验收] ${check.displayName} ${check.dimension}`.slice(
            0,
            120,
          ),
          brandAliases: brand.aliases,
          competitors: brand.competitors,
          questions: [input.question.trim()],
          platforms: [
            {
              platformId: check.platformId,
              providerCode: check.providerCode,
              clientType: check.clientType,
              mode: check.mode,
              screenshot: check.screenshot,
              regionCode:
                check.clientType === "mobile" ? null : check.regionCode,
            },
          ],
          repetitions: 1,
          schedule: {
            type: "none",
            timezone: "Asia/Shanghai",
            localTime: "09:00",
            weekday: null,
          },
        };
        await tx.insert(platformAcceptanceChecks).values({
          id: checkId,
          batchId,
          platformId: check.platformId,
          providerCodeSnapshot: check.providerCode,
          displayNameSnapshot: check.displayName,
          clientType: check.clientType,
          platformFingerprint: check.platformFingerprint,
          dimension: check.dimension,
          mode: check.mode,
          screenshot: check.screenshot,
          regionCode: check.regionCode,
          status: "pending",
        });
        await tx.insert(monitors).values({
          id: monitorId,
          ownerId: input.ownerId,
          projectId: input.projectId,
          name: configuration.name,
          status: "paused",
          activeVersionId: versionId,
          scheduleType: "none",
          scheduleTimezone: "Asia/Shanghai",
          scheduleLocalTime: "09:00",
          scheduleWeekday: null,
          nextRunAt: null,
        });
        await tx.insert(monitorVersions).values({
          id: versionId,
          monitorId,
          projectBrandVersionId: project.currentBrandVersionId,
          version: 1,
          name: configuration.name,
          brandAliases: configuration.brandAliases,
          competitors: configuration.competitors,
          repetitions: 1,
          expectedAttempts: 1,
          configurationHash: sha256(stableJson(configuration)),
          createdBy: input.ownerId,
        });
        await insertVersionChildren(
          tx,
          input.projectId,
          input.ownerId,
          versionId,
          configuration,
        );
        const run = await this.createRun(
          input.ownerId,
          monitorId,
          `acceptance:${batchId}:${ordinal}`,
          "manual",
          null,
          versionId,
          tx,
          {
            acceptanceProbeFingerprints: new Map([
              [check.platformId, check.platformFingerprint],
            ]),
          },
        );
        const [attempt] = await tx
          .select({ id: attempts.id })
          .from(attempts)
          .where(eq(attempts.runId, run.run.id))
          .limit(1);
        if (!attempt) {
          throw new RepositoryError(
            "INVALID_STATE",
            "Acceptance attempt was not created",
          );
        }
        actualAttemptIds.push(attempt.id);
        await tx
          .update(platformAcceptanceChecks)
          .set({
            status: "running",
            runId: run.run.id,
            attemptId: attempt.id,
            startedAt,
          })
          .where(eq(platformAcceptanceChecks.id, checkId));
      }
      const actualPrices = await tx
        .select({ amount: attemptPriceSnapshots.amountTenThousandths })
        .from(attemptPriceSnapshots)
        .where(inArray(attemptPriceSnapshots.attemptId, actualAttemptIds));
      const actualTotal = actualPrices.reduce(
        (total, row) => total + row.amount,
        0n,
      );
      if (actualTotal !== plan.totalAmountTenThousandths) {
        throw new RepositoryError(
          "CONFLICT",
          "Pricing changed while the acceptance batch was being created",
        );
      }
      await insertAudit(
        tx,
        audit,
        "admin.platform_acceptance_started",
        "platform_acceptance_batch",
        batchId,
        input.ownerId,
        {
          attemptCount: plan.checks.length,
          totalAmountTenThousandths: moneyToApiString(
            plan.totalAmountTenThousandths,
          ),
          planFingerprint: plan.planFingerprint,
        },
      );
    });
    return this.getPlatformAcceptanceBatch(batchId);
  }

  private async refreshPlatformAcceptanceBatch(batchId: string) {
    const checks = await this.db
      .select()
      .from(platformAcceptanceChecks)
      .where(eq(platformAcceptanceChecks.batchId, batchId))
      .orderBy(asc(platformAcceptanceChecks.createdAt));
    if (checks.length === 0) return;
    const platformIds = [
      ...new Set(checks.map(({ platformId }) => platformId)),
    ];
    const platformRows = await this.db
      .select()
      .from(platformCatalog)
      .where(inArray(platformCatalog.id, platformIds));
    const platformById = new Map(platformRows.map((row) => [row.id, row]));
    const attemptIds = checks.flatMap(({ attemptId }) =>
      attemptId ? [attemptId] : [],
    );
    const attemptRows =
      attemptIds.length > 0
        ? await this.db
            .select({
              id: attempts.id,
              status: attempts.status,
              clientType: attempts.clientType,
              mode: attempts.mode,
              screenshot: attempts.screenshot,
              regionCode: attempts.regionCode,
              errorCode: attempts.errorCode,
              terminalAt: attempts.terminalAt,
              submittedAt: attempts.submittedAt,
            })
            .from(attempts)
            .where(inArray(attempts.id, attemptIds))
        : [];
    const resultRows =
      attemptIds.length > 0
        ? await this.db
            .select({
              attemptId: attemptResults.attemptId,
              currentRevisionId: attemptResults.currentRevisionId,
              contentHash: attemptResults.contentHash,
              answerMarkdown: attemptResults.answerMarkdown,
              reasoningMarkdown: attemptResults.reasoningMarkdown,
              searchKeywords: attemptResults.searchKeywords,
            })
            .from(attemptResults)
            .where(inArray(attemptResults.attemptId, attemptIds))
        : [];
    const revisionIds = resultRows.map(
      ({ currentRevisionId }) => currentRevisionId,
    );
    const screenshotRows =
      revisionIds.length > 0
        ? await this.db
            .select({
              revisionId: resultMedia.revisionId,
              archiveStatus: resultMedia.archiveStatus,
              contentHash: resultMedia.contentHash,
              objectKey: resultMedia.objectKey,
            })
            .from(resultMedia)
            .where(
              and(
                inArray(resultMedia.revisionId, revisionIds),
                eq(resultMedia.type, "screenshot"),
              ),
            )
        : [];
    const attemptById = new Map(attemptRows.map((row) => [row.id, row]));
    const resultByAttempt = new Map(
      resultRows.map((row) => [row.attemptId, row]),
    );
    const screenshotsByRevision = new Map<string, typeof screenshotRows>();
    for (const screenshot of screenshotRows) {
      const group = screenshotsByRevision.get(screenshot.revisionId) ?? [];
      group.push(screenshot);
      screenshotsByRevision.set(screenshot.revisionId, group);
    }
    const terminalFailures = new Set([
      "failed",
      "stopped",
      "error",
      "cancelled_before_submit",
      "review_required",
    ]);
    const now = new Date();
    await this.db.transaction(async (tx) => {
      for (const check of checks) {
        const platform = platformById.get(check.platformId);
        const currentFingerprint = platform
          ? (platform.acceptanceFingerprint ??
            platformAcceptanceFingerprint(platform))
          : null;
        let status: PlatformAcceptanceStatus = check.status;
        let resultHash = check.resultHash;
        let screenshotHash = check.screenshotHash;
        let errorCode = check.errorCode;
        let errorSummary = check.errorSummary;
        let completedAt = check.completedAt;
        if (!platform || currentFingerprint !== check.platformFingerprint) {
          status = "stale";
          errorCode = "CATALOG_CHANGED";
          errorSummary = "Provider model metadata changed after this probe";
          completedAt = completedAt ?? now;
        } else if (check.status !== "unsupported") {
          const attempt = check.attemptId
            ? attemptById.get(check.attemptId)
            : undefined;
          const result = check.attemptId
            ? resultByAttempt.get(check.attemptId)
            : undefined;
          if (!attempt) {
            status = "pending";
          } else if (terminalFailures.has(attempt.status)) {
            status = "failed";
            errorCode = attempt.errorCode ?? "PROBE_FAILED";
            errorSummary = "Provider probe ended without a valid answer";
            completedAt = attempt.terminalAt ?? now;
          } else if (attempt.status !== "completed" || !result) {
            status = "running";
          } else {
            const submittedDimensionsMatch =
              attempt.clientType === check.clientType &&
              attempt.mode === check.mode &&
              attempt.screenshot === check.screenshot &&
              attempt.regionCode === check.regionCode;
            const answerPresent = result.answerMarkdown.trim().length > 0;
            const screenshots =
              screenshotsByRevision.get(result.currentRevisionId) ?? [];
            const archivedScreenshot = screenshots.find(
              (media) =>
                media.archiveStatus === "archived" &&
                Boolean(media.objectKey) &&
                Boolean(media.contentHash),
            );
            const screenshotPending = screenshots.some(
              ({ archiveStatus }) => archiveStatus === "pending",
            );
            let evidencePresent = answerPresent;
            if (check.dimension === "reasoning_search") {
              evidencePresent =
                evidencePresent &&
                (Boolean(result.reasoningMarkdown?.trim()) ||
                  result.searchKeywords.length > 0);
            }
            if (
              check.dimension === "screenshot_mention" ||
              check.dimension === "screenshot_all"
            ) {
              if (screenshotPending && !archivedScreenshot) {
                status = "running";
                resultHash = result.contentHash;
                errorCode = null;
                errorSummary = null;
                await tx
                  .update(platformAcceptanceChecks)
                  .set({ status, resultHash, errorCode, errorSummary })
                  .where(eq(platformAcceptanceChecks.id, check.id));
                continue;
              }
              evidencePresent = evidencePresent && Boolean(archivedScreenshot);
            }
            if (check.dimension === "mobile_no_region") {
              evidencePresent =
                evidencePresent &&
                attempt.clientType === "mobile" &&
                attempt.regionCode === null;
            }
            if (
              check.dimension === "region_default" ||
              check.dimension === "search_default"
            ) {
              evidencePresent = evidencePresent && attempt.regionCode === null;
            }
            status =
              submittedDimensionsMatch && evidencePresent ? "passed" : "failed";
            resultHash = result.contentHash;
            screenshotHash = archivedScreenshot?.contentHash ?? null;
            errorCode = status === "passed" ? null : "EVIDENCE_MISSING";
            errorSummary =
              status === "passed"
                ? null
                : "Authoritative result did not contain the required capability evidence";
            completedAt = attempt.terminalAt ?? now;
          }
        }
        await tx
          .update(platformAcceptanceChecks)
          .set({
            status,
            resultHash,
            screenshotHash,
            errorCode,
            errorSummary,
            completedAt,
          })
          .where(eq(platformAcceptanceChecks.id, check.id));
      }

      const refreshedChecks = await tx
        .select()
        .from(platformAcceptanceChecks)
        .where(inArray(platformAcceptanceChecks.platformId, platformIds))
        .orderBy(desc(platformAcceptanceChecks.completedAt));
      for (const platform of platformRows) {
        if (!platform.acceptanceRequired) continue;
        const fingerprint =
          platform.acceptanceFingerprint ??
          platformAcceptanceFingerprint(platform);
        const passed = new Map<PlatformAcceptanceDimension, Date | null>();
        for (const check of refreshedChecks) {
          if (
            check.platformId === platform.id &&
            check.platformFingerprint === fingerprint &&
            check.status === "passed" &&
            !passed.has(check.dimension)
          ) {
            passed.set(check.dimension, check.completedAt);
          }
        }
        const basePassed = passed.has("search_default");
        const defaultTransportPassed =
          platform.clientType === "mobile"
            ? passed.has("mobile_no_region")
            : passed.has("region_default");
        const verified = basePassed && defaultTransportPassed;
        await tx
          .update(platformCatalog)
          .set({
            verified,
            supportsReasoning: passed.has("reasoning_search"),
            supportsScreenshot:
              passed.has("screenshot_mention") || passed.has("screenshot_all"),
            supportsDomesticRegion: passed.has("region_domestic"),
            supportsOverseasRegion: passed.has("region_overseas"),
            verifiedAt: verified ? (passed.get("search_default") ?? now) : null,
          })
          .where(eq(platformCatalog.id, platform.id));
      }

      const batchChecks = await tx
        .select({
          status: platformAcceptanceChecks.status,
          dimension: platformAcceptanceChecks.dimension,
        })
        .from(platformAcceptanceChecks)
        .where(eq(platformAcceptanceChecks.batchId, batchId));
      let batchStatus: PlatformAcceptanceStatus;
      if (batchChecks.some(({ status }) => status === "stale")) {
        batchStatus = "stale";
      } else if (
        batchChecks.some(
          ({ status }) => status === "pending" || status === "running",
        )
      ) {
        batchStatus = "running";
      } else if (
        batchChecks.some(
          ({ status, dimension }) =>
            status === "failed" ||
            (dimension === "search_default" && status === "unsupported"),
        )
      ) {
        batchStatus = "failed";
      } else {
        batchStatus = "passed";
      }
      await tx
        .update(platformAcceptanceBatches)
        .set({
          status: batchStatus,
          completedAt: batchStatus === "running" ? null : now,
        })
        .where(eq(platformAcceptanceBatches.id, batchId));
    });
  }

  async getPlatformAcceptanceBatch(batchId: string) {
    const [existing] = await this.db
      .select({ id: platformAcceptanceBatches.id })
      .from(platformAcceptanceBatches)
      .where(eq(platformAcceptanceBatches.id, batchId))
      .limit(1);
    if (!existing) {
      throw new RepositoryError(
        "NOT_FOUND",
        "Platform acceptance batch not found",
      );
    }
    await this.refreshPlatformAcceptanceBatch(batchId);
    const [batch, checks] = await Promise.all([
      this.db
        .select()
        .from(platformAcceptanceBatches)
        .where(eq(platformAcceptanceBatches.id, batchId))
        .limit(1),
      this.db
        .select()
        .from(platformAcceptanceChecks)
        .where(eq(platformAcceptanceChecks.batchId, batchId))
        .orderBy(asc(platformAcceptanceChecks.createdAt)),
    ]);
    const row = batch[0];
    if (!row) {
      throw new RepositoryError(
        "NOT_FOUND",
        "Platform acceptance batch not found",
      );
    }
    return {
      ...row,
      totalAmountTenThousandths: moneyToApiString(
        row.totalAmountTenThousandths,
      ),
      checks: checks.map((check) => ({
        id: check.id,
        batchId: check.batchId,
        platformId: check.platformId,
        providerCode: check.providerCodeSnapshot,
        displayName: check.displayNameSnapshot,
        clientType: check.clientType,
        platformFingerprint: check.platformFingerprint,
        dimension: check.dimension,
        mode: check.mode,
        screenshot: (check.screenshot === 0 ||
        check.screenshot === 1 ||
        check.screenshot === 2
          ? check.screenshot
          : 0) as 0 | 1 | 2,
        regionCode: check.regionCode,
        status: check.status,
        runId: check.runId,
        attemptId: check.attemptId,
        resultHash: check.resultHash,
        screenshotHash: check.screenshotHash,
        errorCode: check.errorCode,
        errorSummary: check.errorSummary,
        startedAt: check.startedAt,
        completedAt: check.completedAt,
        createdAt: check.createdAt,
        updatedAt: check.updatedAt,
      })),
    };
  }

  async listPlatformAcceptanceBatches(limit = 30) {
    const rows = await this.db
      .select({ id: platformAcceptanceBatches.id })
      .from(platformAcceptanceBatches)
      .orderBy(desc(platformAcceptanceBatches.createdAt))
      .limit(Math.max(1, Math.min(limit, 100)));
    return Promise.all(
      rows.map(({ id }) => this.getPlatformAcceptanceBatch(id)),
    );
  }

  async createMonitor(
    ownerId: string,
    projectId: string,
    configuration: MonitorConfiguration,
    audit: RequestAudit,
    transaction?: Transaction,
  ) {
    const execute = async (tx: Transaction) => {
      const [project] = await tx
        .select()
        .from(projects)
        .where(
          and(
            eq(projects.id, projectId),
            monitoringProjectOwnerPredicate(projects, ownerId),
            isNull(projects.deletedAt),
          ),
        )
        .for("update")
        .limit(1);
      if (!project?.currentBrandVersionId)
        throw new RepositoryError("NOT_FOUND", "Project not found");
      await assertMonitoringEnterpriseProjectActive(tx, project.enterpriseProjectId, ownerId);
      await validatePlatforms(tx, configuration);

      const monitorId = randomUUID();
      const versionId = randomUUID();
      const expectedAttempts = calculateAttemptCount(
        configuration.questions.length,
        configuration.platforms.length,
        configuration.repetitions,
      );
      if (expectedAttempts > 500)
        throw new RepositoryError(
          "INVALID_STATE",
          "A run may contain at most 500 attempts",
        );
      const nextRunAt = computeNextRunAt(configuration.schedule, new Date());
      await tx.insert(monitors).values({
        id: monitorId,
        ownerId,
        projectId,
        name: configuration.name,
        status: "active",
        activeVersionId: versionId,
        scheduleType: configuration.schedule.type,
        scheduleTimezone: configuration.schedule.timezone,
        scheduleLocalTime: configuration.schedule.localTime,
        scheduleWeekday: configuration.schedule.weekday,
        nextRunAt,
      });
      await tx.insert(monitorVersions).values({
        id: versionId,
        monitorId,
        projectBrandVersionId: project.currentBrandVersionId,
        version: 1,
        name: configuration.name,
        brandAliases: configuration.brandAliases,
        competitors: configuration.competitors,
        repetitions: configuration.repetitions,
        expectedAttempts,
        configurationHash: sha256(stableJson(configuration)),
        createdBy: ownerId,
      });
      await insertVersionChildren(
        tx,
        projectId,
        ownerId,
        versionId,
        configuration,
      );
      await insertAudit(
        tx,
        audit,
        "monitor.created",
        "monitor",
        monitorId,
        ownerId,
        { version: 1, expectedAttempts },
      );
      return { monitorId, versionId, expectedAttempts };
    };
    return transaction ? execute(transaction) : this.db.transaction(execute);
  }

  async updateMonitor(
    ownerId: string,
    monitorId: string,
    configuration: MonitorConfiguration,
    audit: RequestAudit,
    transaction?: Transaction,
  ) {
    const execute = async (tx: Transaction) => {
      const [monitor] = await tx
        .select()
        .from(monitors)
        .where(
          and(
            eq(monitors.id, monitorId),
            monitoringChildOwnerPredicate(monitors, ownerId),
            isNull(monitors.deletedAt),
          ),
        )
        .for("update")
        .limit(1);
      if (!monitor) throw new RepositoryError("NOT_FOUND", "Monitor not found");
      const [project] = await tx
        .select()
        .from(projects)
        .where(
          and(
            eq(projects.id, monitor.projectId),
            monitoringProjectOwnerPredicate(projects, ownerId),
            isNull(projects.deletedAt),
          ),
        )
        .limit(1);
      if (!project?.currentBrandVersionId)
        throw new RepositoryError("NOT_FOUND", "Project not found");
      await assertMonitoringEnterpriseProjectActive(tx, project.enterpriseProjectId, ownerId);
      await validatePlatforms(tx, configuration);
      const [latest] = await tx
        .select({ version: monitorVersions.version })
        .from(monitorVersions)
        .where(eq(monitorVersions.monitorId, monitorId))
        .orderBy(desc(monitorVersions.version))
        .limit(1);
      const version = (latest?.version ?? 0) + 1;
      const versionId = randomUUID();
      const expectedAttempts = calculateAttemptCount(
        configuration.questions.length,
        configuration.platforms.length,
        configuration.repetitions,
      );
      if (expectedAttempts > 500)
        throw new RepositoryError(
          "INVALID_STATE",
          "A run may contain at most 500 attempts",
        );
      await tx.insert(monitorVersions).values({
        id: versionId,
        monitorId,
        projectBrandVersionId: project.currentBrandVersionId,
        version,
        name: configuration.name,
        brandAliases: configuration.brandAliases,
        competitors: configuration.competitors,
        repetitions: configuration.repetitions,
        expectedAttempts,
        configurationHash: sha256(stableJson(configuration)),
        createdBy: ownerId,
      });
      await insertVersionChildren(
        tx,
        monitor.projectId,
        ownerId,
        versionId,
        configuration,
      );
      await tx
        .update(monitors)
        .set({
          name: configuration.name,
          activeVersionId: versionId,
          scheduleType: configuration.schedule.type,
          scheduleTimezone: configuration.schedule.timezone,
          scheduleLocalTime: configuration.schedule.localTime,
          scheduleWeekday: configuration.schedule.weekday,
          nextRunAt:
            monitor.status === "active"
              ? computeNextRunAt(configuration.schedule, new Date())
              : null,
        })
        .where(eq(monitors.id, monitorId));
      await insertAudit(
        tx,
        audit,
        "monitor.version_created",
        "monitor",
        monitorId,
        ownerId,
        { version, expectedAttempts },
      );
      return { monitorId, versionId, version, expectedAttempts };
    };
    return transaction ? execute(transaction) : this.db.transaction(execute);
  }

  async createMonitorAndRun(
    ownerId: string,
    projectId: string,
    configuration: MonitorConfiguration,
    idempotencyKey: string,
    audit: RequestAudit,
  ) {
    return this.db.transaction(async (tx) => {
      // The wallet is the stable per-owner serialization point available before
      // a new monitor has an id. Taking this lock before the replay lookup makes
      // concurrent double submits observe the first committed run instead of
      // creating a second monitor that only fails later on the run unique key.
      await lockMoneyWallet(tx, ownerId);

      const duplicate = await findRunByIdempotencyKey(
        tx,
        ownerId,
        idempotencyKey,
        true,
      );
      if (duplicate) {
        if (duplicate.projectId !== projectId) {
          throw new RepositoryError(
            "CONFLICT",
            "Idempotency key is already bound to another project run",
          );
        }
        return {
          monitorId: duplicate.monitorId,
          versionId: duplicate.monitorVersionId,
          expectedAttempts: duplicate.expectedAttempts,
          run: { run: duplicate, duplicate: true },
        };
      }

      const monitor = await this.createMonitor(
        ownerId,
        projectId,
        configuration,
        audit,
        tx,
      );
      const run = await this.createRun(
        ownerId,
        monitor.monitorId,
        idempotencyKey,
        "manual",
        null,
        monitor.versionId,
        tx,
      );
      return { ...monitor, run };
    });
  }

  async updateMonitorAndRun(
    ownerId: string,
    monitorId: string,
    configuration: MonitorConfiguration,
    idempotencyKey: string,
    audit: RequestAudit,
  ) {
    return this.db.transaction(async (tx) => {
      const [lockedMonitor] = await tx
        .select({ id: monitors.id })
        .from(monitors)
        .where(
          and(
            eq(monitors.id, monitorId),
            monitoringChildOwnerPredicate(monitors, ownerId),
            isNull(monitors.deletedAt),
          ),
        )
        .for("update")
        .limit(1);
      if (!lockedMonitor)
        throw new RepositoryError("NOT_FOUND", "Monitor not found");

      await lockMoneyWallet(tx, ownerId);

      const duplicate = await findRunByIdempotencyKey(
        tx,
        ownerId,
        idempotencyKey,
        true,
      );
      if (duplicate) {
        if (duplicate.monitorId !== monitorId) {
          throw new RepositoryError(
            "CONFLICT",
            "Idempotency key is already bound to another monitor run",
          );
        }
        const [version] = await tx
          .select({ version: monitorVersions.version })
          .from(monitorVersions)
          .where(eq(monitorVersions.id, duplicate.monitorVersionId))
          .limit(1);
        if (!version)
          throw new RepositoryError(
            "INVALID_STATE",
            "Idempotent monitor version is missing",
          );
        return {
          monitorId,
          versionId: duplicate.monitorVersionId,
          version: version.version,
          expectedAttempts: duplicate.expectedAttempts,
          run: { run: duplicate, duplicate: true },
        };
      }

      const monitor = await this.updateMonitor(
        ownerId,
        monitorId,
        configuration,
        audit,
        tx,
      );
      const run = await this.createRun(
        ownerId,
        monitorId,
        idempotencyKey,
        "manual",
        null,
        monitor.versionId,
        tx,
      );
      return { ...monitor, run };
    });
  }

  async listMonitors(ownerId: string, projectId?: string) {
    const conditions = [
      monitoringChildOwnerPredicate(monitors, ownerId),
      isNull(monitors.deletedAt),
      sql`EXISTS (SELECT 1 FROM projects p WHERE p.id = ${monitors.projectId} AND p.owner_id = ${ownerId} AND p.deleted_at IS NULL)`,
    ];
    if (projectId) conditions.push(eq(monitors.projectId, projectId));
    return this.db
      .select({
        id: monitors.id,
        projectId: monitors.projectId,
        name: monitors.name,
        status: monitors.status,
        activeVersionId: monitors.activeVersionId,
        scheduleType: monitors.scheduleType,
        scheduleTimezone: monitors.scheduleTimezone,
        scheduleLocalTime: monitors.scheduleLocalTime,
        scheduleWeekday: monitors.scheduleWeekday,
        nextRunAt: monitors.nextRunAt,
        createdAt: monitors.createdAt,
        activeVersion: monitorVersions.version,
        expectedAttempts: monitorVersions.expectedAttempts,
        repetitions: monitorVersions.repetitions,
        questionsCount: sql<number>`(SELECT COUNT(*) FROM monitor_questions mq WHERE mq.monitor_version_id = ${monitors.activeVersionId})`,
        platformsCount: sql<number>`(SELECT COUNT(*) FROM monitor_platforms mp WHERE mp.monitor_version_id = ${monitors.activeVersionId})`,
        lastRunId: sql<
          string | null
        >`(SELECT r.id FROM runs r WHERE r.monitor_id = ${monitors.id} AND r.deleted_at IS NULL ORDER BY r.created_at DESC LIMIT 1)`,
        lastRunStatus: sql<
          string | null
        >`(SELECT r.status FROM runs r WHERE r.monitor_id = ${monitors.id} AND r.deleted_at IS NULL ORDER BY r.created_at DESC LIMIT 1)`,
        lastRunCompletedAttempts: sql<
          number | null
        >`(SELECT r.completed_attempts FROM runs r WHERE r.monitor_id = ${monitors.id} AND r.deleted_at IS NULL ORDER BY r.created_at DESC LIMIT 1)`,
        lastRunExpectedAttempts: sql<
          number | null
        >`(SELECT r.expected_attempts FROM runs r WHERE r.monitor_id = ${monitors.id} AND r.deleted_at IS NULL ORDER BY r.created_at DESC LIMIT 1)`,
        lastRunCompletedAt: sql<Date | null>`(SELECT r.completed_at FROM runs r WHERE r.monitor_id = ${monitors.id} AND r.deleted_at IS NULL ORDER BY r.created_at DESC LIMIT 1)`,
        waitingQuotaOccurrences: sql<number>`(SELECT COUNT(*) FROM schedule_occurrences so WHERE so.monitor_id = ${monitors.id} AND so.run_id IS NULL AND so.waiting_for_quota_at IS NOT NULL)`,
      })
      .from(monitors)
      .leftJoin(
        monitorVersions,
        eq(monitors.activeVersionId, monitorVersions.id),
      )
      .where(and(...conditions))
      .orderBy(desc(monitors.createdAt));
  }

  async getMonitor(ownerId: string, monitorId: string) {
    const [monitor] = await this.db
      .select()
      .from(monitors)
      .where(
        and(
          eq(monitors.id, monitorId),
          monitoringChildOwnerPredicate(monitors, ownerId),
          isNull(monitors.deletedAt),
          sql`EXISTS (SELECT 1 FROM projects p WHERE p.id = ${monitors.projectId} AND p.owner_id = ${ownerId} AND p.deleted_at IS NULL)`,
        ),
      )
      .limit(1);
    if (!monitor?.activeVersionId)
      throw new RepositoryError("NOT_FOUND", "Monitor not found");
    const [version] = await this.db
      .select()
      .from(monitorVersions)
      .where(eq(monitorVersions.id, monitor.activeVersionId))
      .limit(1);
    if (!version)
      throw new RepositoryError("NOT_FOUND", "Monitor version not found");
    const [questions, platforms] = await Promise.all([
      this.db
        .select()
        .from(monitorQuestions)
        .where(eq(monitorQuestions.monitorVersionId, version.id))
        .orderBy(asc(monitorQuestions.ordinal)),
      this.db
        .select()
        .from(monitorPlatforms)
        .where(eq(monitorPlatforms.monitorVersionId, version.id))
        .orderBy(asc(monitorPlatforms.ordinal)),
    ]);
    return { monitor, version, questions, platforms };
  }

  async setMonitorPaused(
    ownerId: string,
    monitorId: string,
    paused: boolean,
    audit: RequestAudit,
  ) {
    const [monitor] = await this.db
      .select()
      .from(monitors)
      .where(
        and(
          eq(monitors.id, monitorId),
          monitoringChildOwnerPredicate(monitors, ownerId),
          isNull(monitors.deletedAt),
          sql`EXISTS (SELECT 1 FROM projects p WHERE p.id = ${monitors.projectId} AND p.owner_id = ${ownerId} AND p.deleted_at IS NULL)`,
        ),
      )
      .limit(1);
    if (!monitor) throw new RepositoryError("NOT_FOUND", "Monitor not found");
    if (monitor.status === "deleted")
      throw new RepositoryError(
        "INVALID_STATE",
        "Deleted monitor cannot be changed",
      );
    const now = new Date();
    const nextRunAt = paused
      ? null
      : computeNextRunAt(
          {
            type: monitor.scheduleType,
            timezone: monitor.scheduleTimezone,
            localTime: monitor.scheduleLocalTime,
            weekday: monitor.scheduleWeekday,
          },
          now,
        );
    await this.db.transaction(async (tx) => {
      const [project] = await tx.select({ enterpriseProjectId: projects.enterpriseProjectId }).from(projects)
        .where(and(eq(projects.id, monitor.projectId), eq(projects.ownerId, ownerId))).limit(1);
      if (!project) throw new RepositoryError("NOT_FOUND", "Project not found");
      await assertMonitoringEnterpriseProjectActive(tx, project.enterpriseProjectId, ownerId);
      await tx
        .update(monitors)
        .set({
          status: paused ? "paused" : "active",
          nextRunAt,
          lastScheduledFor: now,
        })
        .where(eq(monitors.id, monitorId));
      await insertAudit(
        tx,
        audit,
        paused ? "monitor.paused" : "monitor.resumed",
        "monitor",
        monitorId,
        ownerId,
        {},
      );
    });
  }

  async softDeleteMonitor(
    ownerId: string,
    monitorId: string,
    audit: RequestAudit,
  ) {
    const now = new Date();
    const purgeAfter = new Date(now.getTime() + 30 * 86_400_000);
    await this.db.transaction(async (tx) => {
      const result = await tx
        .update(monitors)
        .set({ status: "deleted", deletedAt: now, purgeAfter, nextRunAt: null })
        .where(
          and(
            eq(monitors.id, monitorId),
            monitoringChildOwnerPredicate(monitors, ownerId),
            isNull(monitors.deletedAt),
          ),
        );
      if (affectedRows(result) !== 1)
        throw new RepositoryError("NOT_FOUND", "Monitor not found");
      await tx
        .delete(scheduleOccurrences)
        .where(
          and(
            eq(scheduleOccurrences.monitorId, monitorId),
            isNull(scheduleOccurrences.runId),
          ),
        );
      await tx.insert(jobs).values({
        id: randomUUID(),
        type: "purge_soft_deleted",
        dedupeKey: `purge:monitor:${monitorId}`,
        payload: { entityType: "monitor", entityId: monitorId },
        availableAt: purgeAfter,
      });
      await insertAudit(
        tx,
        audit,
        "monitor.deleted",
        "monitor",
        monitorId,
        ownerId,
        { purgeAfter: purgeAfter.toISOString() },
      );
    });
  }

  async listDeletedMonitors(ownerId: string) {
    return this.db
      .select({
        id: monitors.id,
        projectId: monitors.projectId,
        name: monitors.name,
        deletedAt: monitors.deletedAt,
        purgeAfter: monitors.purgeAfter,
      })
      .from(monitors)
      .where(
        and(
          monitoringChildOwnerPredicate(monitors, ownerId),
          sql`${monitors.deletedAt} IS NOT NULL`,
        ),
      )
      .orderBy(desc(monitors.deletedAt));
  }

  async restoreMonitor(
    ownerId: string,
    monitorId: string,
    audit: RequestAudit,
  ) {
    const now = new Date();
    await this.db.transaction(async (tx) => {
      const [monitor] = await tx
        .select()
        .from(monitors)
        .where(
          and(
            eq(monitors.id, monitorId),
            monitoringChildOwnerPredicate(monitors, ownerId),
            sql`${monitors.deletedAt} IS NOT NULL`,
          ),
        )
        .for("update")
        .limit(1);
      if (!monitor || (monitor.purgeAfter && monitor.purgeAfter <= now))
        throw new RepositoryError("NOT_FOUND", "Restorable monitor not found");
      const [project] = await tx
        .select({ id: projects.id })
        .from(projects)
        .where(
          and(
            eq(projects.id, monitor.projectId),
            monitoringProjectOwnerPredicate(projects, ownerId),
            isNull(projects.deletedAt),
          ),
        )
        .limit(1);
      if (!project)
        throw new RepositoryError(
          "INVALID_STATE",
          "Restore the parent project first",
        );
      await tx
        .update(monitors)
        .set({
          status: "paused",
          deletedAt: null,
          purgeAfter: null,
          nextRunAt: null,
          lastScheduledFor: now,
        })
        .where(eq(monitors.id, monitorId));
      await tx
        .delete(scheduleOccurrences)
        .where(
          and(
            eq(scheduleOccurrences.monitorId, monitorId),
            isNull(scheduleOccurrences.runId),
          ),
        );
      await tx
        .delete(jobs)
        .where(eq(jobs.dedupeKey, `purge:monitor:${monitorId}`));
      await insertAudit(
        tx,
        audit,
        "monitor.restored",
        "monitor",
        monitorId,
        ownerId,
        {},
      );
    });
  }

  async createRun(
    ownerId: string,
    monitorId: string,
    idempotencyKey: string,
    trigger: RunTrigger = "manual",
    occurrenceId: string | null = null,
    monitorVersionOverrideId: string | null = null,
    transaction?: Transaction,
    platformValidation?: {
      acceptanceProbeFingerprints: ReadonlyMap<string, string>;
    },
  ) {
    const execute = async (tx: Transaction) => {
      // Workers have no request scope: recover the immutable project binding.
      const [admission] = await tx.select({ enterpriseProjectId: projects.enterpriseProjectId })
        .from(monitors).innerJoin(projects, eq(projects.id, monitors.projectId))
        .where(and(eq(monitors.id, monitorId), eq(monitors.ownerId, ownerId), eq(projects.ownerId, ownerId))).limit(1);
      if (!admission) throw new RepositoryError("NOT_FOUND", "Monitor not found");
      await assertMonitoringEnterpriseProjectActive(tx, admission.enterpriseProjectId, ownerId);
      const duplicate = await findRunByIdempotencyKey(
        tx,
        ownerId,
        idempotencyKey,
      );
      if (duplicate) {
        if (duplicate.monitorId !== monitorId) {
          throw new RepositoryError(
            "CONFLICT",
            "Idempotency key is already bound to another monitor run",
          );
        }
        return { run: duplicate, duplicate: true };
      }
      const [monitor] = await tx
        .select()
        .from(monitors)
        .where(
          and(
            eq(monitors.id, monitorId),
            monitoringChildOwnerPredicate(monitors, ownerId),
            isNull(monitors.deletedAt),
          ),
        )
        .for("update")
        .limit(1);
      if (!monitor?.activeVersionId)
        throw new RepositoryError("NOT_FOUND", "Monitor not found");
      if (monitor.status === "paused" && trigger !== "manual")
        throw new RepositoryError(
          "INVALID_STATE",
          "Paused monitor cannot be scheduled",
        );
      const [activeRun] = await tx
        .select({ id: runs.id })
        .from(runs)
        .where(
          and(
            eq(runs.monitorId, monitorId),
            inArray(runs.status, [
              "queued",
              "waiting_quota",
              "running",
              "review_required",
            ]),
            isNull(runs.deletedAt),
          ),
        )
        .orderBy(asc(runs.createdAt))
        .limit(1);
      const versionId = monitorVersionOverrideId ?? monitor.activeVersionId;
      const [version] = await tx
        .select()
        .from(monitorVersions)
        .where(
          and(
            eq(monitorVersions.id, versionId),
            eq(monitorVersions.monitorId, monitor.id),
          ),
        )
        .limit(1);
      if (!version)
        throw new RepositoryError(
          "INVALID_STATE",
          "Monitor has no active configuration",
        );
      const [project] = await tx
        .select()
        .from(projects)
        .where(
          and(
            eq(projects.id, monitor.projectId),
            monitoringProjectOwnerPredicate(projects, ownerId),
            isNull(projects.deletedAt),
          ),
        )
        .limit(1);
      if (!project?.currentBrandVersionId)
        throw new RepositoryError("NOT_FOUND", "Project not found");
      const [brandVersion] = await tx
        .select({ id: projectBrandVersions.id })
        .from(projectBrandVersions)
        .where(
          and(
            eq(projectBrandVersions.id, version.projectBrandVersionId),
            eq(projectBrandVersions.projectId, project.id),
          ),
        )
        .limit(1);
      if (!brandVersion)
        throw new RepositoryError(
          "INVALID_STATE",
          "Monitor configuration brand snapshot is invalid",
        );
      const [owner] = await tx
        .select({ status: users.status })
        .from(users)
        .where(eq(users.id, ownerId))
        .limit(1);
      if (!owner || owner.status !== "active")
        throw new RepositoryError("INVALID_STATE", "Account is not active");

      const wallet = await lockMoneyWallet(tx, ownerId);
      // A concurrent operation can commit the same owner-scoped key while this
      // transaction waits for the wallet lock. Recheck under that lock before
      // reserving quota or inserting attempts.
      const duplicateAfterWalletLock = await findRunByIdempotencyKey(
        tx,
        ownerId,
        idempotencyKey,
        true,
      );
      if (duplicateAfterWalletLock) {
        if (duplicateAfterWalletLock.monitorId !== monitorId) {
          throw new RepositoryError(
            "CONFLICT",
            "Idempotency key is already bound to another monitor run",
          );
        }
        return { run: duplicateAfterWalletLock, duplicate: true };
      }
      const [questionRows, platformRows] = await Promise.all([
        tx
          .select()
          .from(monitorQuestions)
          .where(eq(monitorQuestions.monitorVersionId, version.id))
          .orderBy(asc(monitorQuestions.ordinal)),
        tx
          .select({
            monitorVersionId: monitorPlatforms.monitorVersionId,
            ordinal: monitorPlatforms.ordinal,
            platformId: monitorPlatforms.platformId,
            providerCodeSnapshot: monitorPlatforms.providerCodeSnapshot,
            clientType: monitorPlatforms.clientType,
            mode: monitorPlatforms.mode,
            screenshot: monitorPlatforms.screenshot,
            regionCode: monitorPlatforms.regionCode,
            pricingClass: platformCatalog.pricingClass,
          })
          .from(monitorPlatforms)
          .innerJoin(
            platformCatalog,
            eq(monitorPlatforms.platformId, platformCatalog.id),
          )
          .where(eq(monitorPlatforms.monitorVersionId, version.id))
          .orderBy(asc(monitorPlatforms.ordinal)),
      ]);
      const expected = calculateAttemptCount(
        questionRows.length,
        platformRows.length,
        version.repetitions,
      );
      if (expected !== version.expectedAttempts || expected > 500)
        throw new RepositoryError(
          "INVALID_STATE",
          "Monitor configuration attempt count is inconsistent",
        );
      await validatePlatforms(
        tx,
        {
          platforms: platformRows.map((platform) => ({
            platformId: platform.platformId,
            providerCode: platform.providerCodeSnapshot,
            clientType: platform.clientType,
            mode: platform.mode,
            screenshot: monitoringScreenshotPolicy(platform.screenshot),
            regionCode:
              platform.clientType === "mobile" ? null : platform.regionCode,
          })),
        },
        platformValidation,
      );

      const [pricingVersion] = await tx
        .select()
        .from(pricingVersions)
        .where(eq(pricingVersions.status, "active"))
        .orderBy(desc(pricingVersions.effectiveFrom))
        .limit(1);
      if (!pricingVersion)
        throw new RepositoryError("INVALID_STATE", "Active pricing is missing");
      const activePrices = await tx
        .select()
        .from(pricingItems)
        .where(eq(pricingItems.pricingVersionId, pricingVersion.id));
      const priceByDimensions = new Map(
        activePrices.map((price) => [pricingDimensionsKey(price), price]),
      );
      const priceByPlatformOrdinal = new Map(
        platformRows.map((platform) => {
          if (!platform.pricingClass) {
            throw new RepositoryError(
              "INVALID_STATE",
              `Platform ${platform.providerCodeSnapshot} has no confirmed pricing class`,
            );
          }
          const price = priceByDimensions.get(
            pricingDimensionsKey({
              pricingClass: platform.pricingClass,
              mode: platform.mode,
              screenshotEnabled: platform.screenshot !== 0,
            }),
          );
          if (!price) {
            throw new RepositoryError(
              "INVALID_STATE",
              `Platform ${platform.providerCodeSnapshot} has no active price`,
            );
          }
          return [platform.ordinal, price] as const;
        }),
      );
      const reservedAmount = platformRows.reduce((total, platform) => {
        const price = priceByPlatformOrdinal.get(platform.ordinal);
        if (!price)
          throw new RepositoryError(
            "INVALID_STATE",
            "Attempt price snapshot cannot be created",
          );
        return (
          total +
          price.amountTenThousandths *
            BigInt(questionRows.length * version.repetitions)
        );
      }, 0n);
      const availableAmount =
        wallet.balanceTenThousandths - wallet.reservedTenThousandths - wallet.frozenTenThousandths;
      if (availableAmount < reservedAmount)
        throw new RepositoryError(
          "BALANCE_INSUFFICIENT",
          "Available balance is insufficient",
        );

      const runId = randomUUID();
      const reservationId = randomUUID();
      await tx.insert(runs).values({
        id: runId,
        ownerId,
        projectId: monitor.projectId,
        projectBrandVersionId: version.projectBrandVersionId,
        monitorId,
        monitorVersionId: version.id,
        scheduleOccurrenceId: occurrenceId,
        trigger,
        status: "queued",
        idempotencyKey,
        expectedAttempts: expected,
      });
      const attemptRows: Array<typeof attempts.$inferInsert> = [];
      for (const question of questionRows) {
        for (const platform of platformRows) {
          for (
            let repetition = 1;
            repetition <= version.repetitions;
            repetition += 1
          ) {
            const attemptId = randomUUID();
            attemptRows.push({
              id: attemptId,
              runId,
              ownerId,
              monitorQuestionOrdinal: question.ordinal,
              monitorPlatformOrdinal: platform.ordinal,
              repetition,
              question: question.questionSnapshot,
              platformId: platform.platformId,
              providerCode: platform.providerCodeSnapshot,
              clientType: platform.clientType,
              mode: platform.mode,
              screenshot: platform.screenshot,
              regionCode:
                platform.clientType === "mobile" ? null : platform.regionCode,
              consumerTaskId: `fm${sha256(attemptId).slice(0, 62)}`,
            });
          }
        }
      }
      for (let offset = 0; offset < attemptRows.length; offset += 100) {
        await tx
          .insert(attempts)
          .values(attemptRows.slice(offset, offset + 100));
      }
      const nextReservedAmount = wallet.reservedTenThousandths + reservedAmount;
      await tx
        .update(moneyWallets)
        .set({ reservedTenThousandths: nextReservedAmount })
        .where(eq(moneyWallets.userId, ownerId));
      await tx.insert(moneyReservations).values({
        id: reservationId,
        userId: ownerId,
        runId,
        totalTenThousandths: reservedAmount,
      });
      const priceSnapshots = attemptRows.map((attempt) => {
        const price = priceByPlatformOrdinal.get(
          attempt.monitorPlatformOrdinal,
        );
        if (!price)
          throw new RepositoryError(
            "INVALID_STATE",
            "Attempt price snapshot cannot be created",
          );
        return {
          attemptId: attempt.id,
          pricingVersionId: pricingVersion.id,
          pricingItemId: price.id,
          pricingClass: price.pricingClass,
          mode: price.mode,
          screenshotEnabled: price.screenshotEnabled,
          amountTenThousandths: price.amountTenThousandths,
        };
      });
      const attemptSettlements = attemptRows.map((attempt) => ({
        attemptId: attempt.id,
        reservationId,
      }));
      for (let offset = 0; offset < priceSnapshots.length; offset += 100) {
        await tx
          .insert(attemptPriceSnapshots)
          .values(priceSnapshots.slice(offset, offset + 100));
        await tx
          .insert(attemptMoneySettlements)
          .values(attemptSettlements.slice(offset, offset + 100));
      }
      await insertMoneyLedger(tx, {
        userId: ownerId,
        type: "reserve",
        balanceDelta: 0n,
        reservedDelta: reservedAmount,
        nextBalance: wallet.balanceTenThousandths,
        nextReserved: nextReservedAmount,
        idempotencyKey: `reserve:${runId}`,
        reservationId,
        reason: "Run balance reservation",
        referenceType: "run",
        referenceId: runId,
      });
      if (!activeRun) {
        const submitJobs = attemptRows.map((attempt) => ({
          id: randomUUID(),
          type: "submit_attempt" as const,
          dedupeKey: `submit:${attempt.id}`,
          payload: { attemptId: attempt.id },
          availableAt: new Date(),
        }));
        for (let offset = 0; offset < submitJobs.length; offset += 100) {
          await tx.insert(jobs).values(submitJobs.slice(offset, offset + 100));
        }
      }
      if (occurrenceId) {
        await tx
          .update(scheduleOccurrences)
          .set({ runId, waitingForQuotaAt: null })
          .where(eq(scheduleOccurrences.id, occurrenceId));
      }
      const [created] = await tx
        .select()
        .from(runs)
        .where(eq(runs.id, runId))
        .limit(1);
      if (!created)
        throw new RepositoryError("INVALID_STATE", "Run creation failed");
      return { run: created, duplicate: false };
    };
    return transaction ? execute(transaction) : this.db.transaction(execute);
  }

  async cancelRun(ownerId: string, runId: string, audit: RequestAudit) {
    return this.db.transaction(async (tx) => {
      const [run] = await tx
        .select()
        .from(runs)
        .where(
          and(
            eq(runs.id, runId),
            monitoringChildOwnerPredicate(runs, ownerId),
            isNull(runs.deletedAt),
          ),
        )
        .for("update")
        .limit(1);
      if (!run) throw new RepositoryError("NOT_FOUND", "Run not found");
      if (
        ["completed", "partial_completed", "failed", "cancelled"].includes(
          run.status,
        )
      )
        return run;
      const queued = await tx
        .select({ id: attempts.id })
        .from(attempts)
        .innerJoin(
          attemptMoneySettlements,
          eq(attempts.id, attemptMoneySettlements.attemptId),
        )
        .where(
          and(
            eq(attempts.runId, runId),
            eq(attempts.status, "queued"),
            eq(attemptMoneySettlements.status, "reserved"),
          ),
        )
        .for("update");
      const now = new Date();
      if (queued.length > 0) {
        const ids = queued.map((row) => row.id);
        await tx
          .update(attempts)
          .set({
            status: "cancelled_before_submit",
            terminalAt: now,
          })
          .where(and(inArray(attempts.id, ids), eq(attempts.status, "queued")));
        for (const attempt of queued) {
          await settleAttemptMoney(tx, {
            attemptId: attempt.id,
            settlement: "released",
            settledAt: now,
            reason: "Cancelled before provider submission",
          });
        }
      }
      await tx
        .update(runs)
        .set({ cancelRequestedAt: now })
        .where(eq(runs.id, runId));
      const activeAttempts = await tx
        .select({ id: attempts.id })
        .from(attempts)
        .where(
          and(
            eq(attempts.runId, runId),
            inArray(attempts.status, [
              "submitting",
              "submission_unknown",
              "accepted",
              "processing",
            ]),
          ),
        );
      if (activeAttempts.length > 0) {
        await tx
          .insert(jobs)
          .values(
            activeAttempts.map((attempt) => ({
              id: randomUUID(),
              type: "stop_attempt" as const,
              dedupeKey: `stop:${attempt.id}`,
              payload: { attemptId: attempt.id },
              availableAt: now,
            })),
          )
          .onDuplicateKeyUpdate({ set: { dedupeKey: sql`${jobs.dedupeKey}` } });
      }
      const attemptStates = await tx
        .select({ status: attempts.status })
        .from(attempts)
        .where(eq(attempts.runId, runId));
      const completed = attemptStates.filter(
        (attempt) => attempt.status === "completed",
      ).length;
      const failed = attemptStates.filter(
        (attempt) => attempt.status === "failed" || attempt.status === "error",
      ).length;
      const stopped = attemptStates.filter(
        (attempt) =>
          attempt.status === "stopped" ||
          attempt.status === "cancelled_before_submit",
      ).length;
      if (
        completed + failed + stopped === attemptStates.length &&
        attemptStates.length > 0
      ) {
        await tx
          .update(runs)
          .set({
            status: completed > 0 ? "partial_completed" : "cancelled",
            completedAttempts: completed,
            failedAttempts: failed,
            stoppedAttempts: stopped,
            submittedAttempts: attemptStates.filter(
              (attempt) =>
                !["queued", "cancelled_before_submit"].includes(attempt.status),
            ).length,
            completedAt: now,
          })
          .where(eq(runs.id, runId));
        await enqueueNextSerializedRun(tx, run.monitorId, run.id, now);
      }
      await insertAudit(
        tx,
        audit,
        "run.cancel_requested",
        "run",
        runId,
        ownerId,
        { releasedBeforeSubmit: queued.length },
      );
      const [updated] = await tx
        .select()
        .from(runs)
        .where(eq(runs.id, runId))
        .limit(1);
      return updated;
    });
  }

  async getMonitoringSummary(ownerId: string, scope: MonitoringScope) {
    const resolved = await this.resolveMonitoringReadScope(ownerId, scope);
    const facts = await this.readMonitoringFacts(ownerId, resolved);
    const evidence = await this.readMonitoringEvidence(facts);
    return {
      monitor: {
        id: resolved.monitor.id,
        name: resolved.monitor.name,
        status: resolved.monitor.status,
        activeVersionId: resolved.monitor.activeVersionId,
        activeVersion: resolved.version.version,
      },
      filters: {
        questions: resolved.questions.map((question) => ({
          id: question.questionId,
          ordinal: question.ordinal,
          label: question.questionSnapshot,
        })),
        platforms: resolved.platforms.map((platform) => ({
          id: platform.platformId,
          ordinal: platform.ordinal,
          providerCode: platform.providerCode,
          displayName: platform.displayName,
          clientType: platform.clientType,
          mode: platform.mode,
        })),
        subjects: [
          { kind: "self" as const, label: resolved.brand.mainBrand },
          ...resolved.version.competitors.map((competitor) => ({
            kind: "competitor" as const,
            name: competitor.name,
            label: competitor.name,
          })),
        ],
      },
      metrics: monitoringMetrics(facts, evidence, resolved.subject),
    };
  }

  async listMonitoringAnswers(
    ownerId: string,
    input: MonitoringAnswersListInput,
  ) {
    const resolved = await this.resolveMonitoringReadScope(
      ownerId,
      input.scope,
    );
    const cursor = input.cursor
      ? decodeMonitoringAnswerCursor(input.cursor, resolved.scope)
      : null;
    const conditions = monitoringFactConditions(ownerId, resolved.scope);
    if (cursor) {
      conditions.push(
        or(
          lt(runs.createdAt, cursor.runCreatedAt),
          and(
            eq(runs.createdAt, cursor.runCreatedAt),
            lt(attempts.id, cursor.attemptId),
          ),
        )!,
      );
    }
    const rows = await this.db
      .select({
        answerId: attempts.id,
        runId: runs.id,
        runCreatedAt: runs.createdAt,
        questionId: monitorQuestions.questionId,
        question: attempts.question,
        platformId: attempts.platformId,
        providerCode: attempts.providerCode,
        platformDisplayName: platformCatalog.displayName,
        clientType: attempts.clientType,
        mode: attempts.mode,
        repetition: attempts.repetition,
        status: attempts.status,
        currentRevisionId: attemptResults.currentRevisionId,
        answerPreview: sql<
          string | null
        >`CASE WHEN ${attemptResults.attemptId} IS NULL THEN NULL ELSE LEFT(${attemptResults.answerMarkdown}, 280) END`,
        hasNonEmptyAnswer: sql<number>`CASE WHEN ${attemptResults.attemptId} IS NOT NULL AND CHAR_LENGTH(TRIM(${attemptResults.answerMarkdown})) > 0 THEN 1 ELSE 0 END`,
        sentiment: attemptResults.sentiment,
        brandMentioned: attemptResults.brandMentioned,
        mentionPosition: attemptResults.mentionPosition,
        competitorRankings: attemptResults.competitorRankings,
        monitorCompetitors: monitorVersions.competitors,
        resultUpdatedAt: attemptResults.updatedAt,
        normalizedPayload: resultRevisions.normalizedPayload,
        revisionCreatedAt: resultRevisions.createdAt,
      })
      .from(attempts)
      .innerJoin(runs, eq(attempts.runId, runs.id))
      .innerJoin(monitorVersions, eq(runs.monitorVersionId, monitorVersions.id))
      .innerJoin(
        monitorQuestions,
        and(
          eq(monitorQuestions.monitorVersionId, runs.monitorVersionId),
          eq(monitorQuestions.ordinal, attempts.monitorQuestionOrdinal),
        ),
      )
      .innerJoin(platformCatalog, eq(attempts.platformId, platformCatalog.id))
      .leftJoin(attemptResults, eq(attemptResults.attemptId, attempts.id))
      .leftJoin(
        resultRevisions,
        eq(resultRevisions.id, attemptResults.currentRevisionId),
      )
      .where(and(...conditions))
      .orderBy(desc(runs.createdAt), desc(attempts.id))
      .limit(input.limit + 1);
    const page = rows.slice(0, input.limit);
    const facts = page.map(monitoringListRowAsFact);
    const evidence = await this.readMonitoringEvidence(facts);
    return {
      items: page.map((row, index) => {
        const fact = facts[index]!;
        const subject = monitoringSubjectContribution(fact, resolved.subject);
        const provenance = evidence.provenanceByRevision.get(
          row.currentRevisionId ?? "",
        );
        return {
          answerId: row.answerId,
          runId: row.runId,
          runCreatedAt: row.runCreatedAt,
          questionId: row.questionId,
          question: row.question,
          platform: {
            id: row.platformId,
            providerCode: row.providerCode,
            displayName: row.platformDisplayName,
            clientType: row.clientType,
            mode: row.mode,
          },
          repetition: row.repetition,
          status: row.status,
          result:
            row.currentRevisionId &&
            row.answerPreview !== null &&
            row.sentiment &&
            row.brandMentioned !== null &&
            row.resultUpdatedAt
              ? {
                  answerPreview: row.answerPreview,
                  sentiment: row.sentiment,
                  mentioned: subject.mentioned,
                  position: subject.position,
                  citationProvenance: provenance ?? "unavailable",
                  citationCount:
                    evidence.citationsByRevision.get(row.currentRevisionId)
                      ?.length ?? 0,
                  referenceCount:
                    evidence.referencesByRevision.get(row.currentRevisionId)
                      ?.length ?? 0,
                  screenshotCount:
                    evidence.screenshotCountByRevision.get(
                      row.currentRevisionId,
                    ) ?? 0,
                  updatedAt: row.resultUpdatedAt,
                }
              : null,
        };
      }),
      nextCursor:
        rows.length > input.limit && page.length > 0
          ? encodeMonitoringAnswerCursor(
              resolved.scope,
              page.at(-1)!.runCreatedAt,
              page.at(-1)!.answerId,
            )
          : null,
    };
  }

  async getMonitoringAnswer(
    ownerId: string,
    monitorId: string,
    answerId: string,
    subject: MonitoringScope["subject"] = { kind: "self" },
  ) {
    // Resolving the current version first both enforces tenant ownership and
    // keeps the monitor boundary explicit even though the answer belongs to an
    // immutable historical version.
    const current = await this.getMonitor(ownerId, monitorId);
    let resolvedSubject: ResolvedMonitoringSubject = { kind: "self" };
    if (subject.kind === "competitor") {
      const competitor = current.version.competitors.find(
        (candidate) => candidate.name === subject.name,
      );
      if (!competitor) {
        throw new RepositoryError(
          "INVALID_STATE",
          "Competitor is not in the current monitor configuration",
        );
      }
      resolvedSubject = {
        kind: "competitor",
        name: competitor.name,
        aliases: competitor.aliases,
      };
    }
    const [row] = await this.db
      .select({
        answerId: attempts.id,
        runId: runs.id,
        runCreatedAt: runs.createdAt,
        monitorVersionId: runs.monitorVersionId,
        projectBrandVersionId: runs.projectBrandVersionId,
        questionId: monitorQuestions.questionId,
        question: attempts.question,
        platformId: attempts.platformId,
        providerCode: attempts.providerCode,
        platformDisplayName: platformCatalog.displayName,
        clientType: attempts.clientType,
        mode: attempts.mode,
        repetition: attempts.repetition,
        status: attempts.status,
        currentRevisionId: attemptResults.currentRevisionId,
        answerMarkdown: attemptResults.answerMarkdown,
        reasoningMarkdown: attemptResults.reasoningMarkdown,
        searchKeywords: attemptResults.searchKeywords,
        sentiment: attemptResults.sentiment,
        brandMentioned: attemptResults.brandMentioned,
        mentionPosition: attemptResults.mentionPosition,
        competitorRankings: attemptResults.competitorRankings,
        normalizedPayload: resultRevisions.normalizedPayload,
        revisionCreatedAt: resultRevisions.createdAt,
        resultUpdatedAt: attemptResults.updatedAt,
      })
      .from(attempts)
      .innerJoin(runs, eq(attempts.runId, runs.id))
      .innerJoin(
        monitorQuestions,
        and(
          eq(monitorQuestions.monitorVersionId, runs.monitorVersionId),
          eq(monitorQuestions.ordinal, attempts.monitorQuestionOrdinal),
        ),
      )
      .innerJoin(platformCatalog, eq(attempts.platformId, platformCatalog.id))
      .innerJoin(attemptResults, eq(attemptResults.attemptId, attempts.id))
      .innerJoin(
        resultRevisions,
        eq(resultRevisions.id, attemptResults.currentRevisionId),
      )
      .where(
        and(
          eq(attempts.id, answerId),
          eq(attempts.ownerId, ownerId),
          monitoringChildOwnerPredicate(runs, ownerId),
          eq(runs.monitorId, monitorId),
          isNull(runs.deletedAt),
          sql`EXISTS (SELECT 1 FROM projects p WHERE p.id = ${runs.projectId} AND p.owner_id = ${ownerId} AND p.deleted_at IS NULL)`,
        ),
      )
      .limit(1);
    if (!row)
      throw new RepositoryError("NOT_FOUND", "Monitoring answer not found");
    const [[version], [brand]] = await Promise.all([
      this.db
        .select()
        .from(monitorVersions)
        .where(
          and(
            eq(monitorVersions.id, row.monitorVersionId),
            eq(monitorVersions.monitorId, monitorId),
          ),
        )
        .limit(1),
      this.db
        .select()
        .from(projectBrandVersions)
        .where(eq(projectBrandVersions.id, row.projectBrandVersionId))
        .limit(1),
    ]);
    if (!version || !brand) {
      throw new RepositoryError(
        "NOT_FOUND",
        "Monitoring answer configuration not found",
      );
    }
    const fact = monitoringDetailRowAsFact(row, version.competitors);
    const contribution = monitoringSubjectContribution(fact, resolvedSubject);
    const evidence = await this.readMonitoringEvidence([fact]);
    const revisionId = row.currentRevisionId;
    const provenance =
      evidence.provenanceByRevision.get(revisionId) ?? "unavailable";
    const citations = evidence.citationsByRevision.get(revisionId) ?? [];
    const references = evidence.referencesByRevision.get(revisionId) ?? [];
    const screenshots = await this.db
      .select({
        id: resultMedia.id,
        ordinal: resultMedia.ordinal,
        archiveStatus: resultMedia.archiveStatus,
        thumbnailObjectKey: resultMedia.thumbnailObjectKey,
        mimeType: resultMedia.mimeType,
        sizeBytes: resultMedia.sizeBytes,
      })
      .from(resultMedia)
      .where(
        and(
          eq(resultMedia.revisionId, revisionId),
          eq(resultMedia.type, "screenshot"),
        ),
      )
      .orderBy(asc(resultMedia.ordinal));
    return {
      answerId: row.answerId,
      runId: row.runId,
      runCreatedAt: row.runCreatedAt,
      questionId: row.questionId,
      question: row.question,
      platform: {
        id: row.platformId,
        providerCode: row.providerCode,
        displayName: row.platformDisplayName,
        clientType: row.clientType,
        mode: row.mode,
      },
      repetition: row.repetition,
      status: row.status,
      answerMarkdown: row.answerMarkdown,
      reasoningMarkdown: row.reasoningMarkdown,
      searchKeywords: Array.isArray(row.searchKeywords)
        ? row.searchKeywords.filter(
            (keyword): keyword is string => typeof keyword === "string",
          )
        : [],
      sentiment: row.sentiment,
      mentioned: contribution.mentioned,
      position: contribution.position,
      rankings: normalizedMonitoringRankings({
        mainBrand: brand.mainBrand,
        competitors: version.competitors,
        brandMentioned: row.brandMentioned,
        mentionPosition: row.mentionPosition,
        competitorRankings: row.competitorRankings,
      }),
      citationProvenance: provenance,
      citationList: citations.map((source) => ({
        id: source.id,
        ordinal: source.ordinal,
        providerPosition: source.providerPosition,
        url: source.url,
        title: source.title,
        domain: source.domain,
        siteName: source.siteName,
        summary: source.summary,
        publishedAt: source.publishedAt,
        citedText: source.citedText,
      })),
      referenceList: references.map((source) => ({
        id: source.id,
        ordinal: source.ordinal,
        providerPosition: source.providerPosition,
        url: source.url,
        title: source.title,
        domain: source.domain,
        siteName: source.siteName,
        summary: source.summary,
        publishedAt: source.publishedAt,
        isCited: provenance === "explicit" && source.isCited,
      })),
      archivedScreenshots: screenshots.map((media) => ({
        id: media.id,
        ordinal: media.ordinal,
        archiveStatus: media.archiveStatus,
        accessPath:
          media.archiveStatus === "archived" ? `/api/monitoring/media/${media.id}` : null,
        thumbnailAccessPath:
          media.archiveStatus === "archived" && media.thumbnailObjectKey
            ? `/api/monitoring/media/${media.id}?variant=thumbnail`
            : null,
        mimeType: media.mimeType,
        sizeBytes: media.sizeBytes,
      })),
    };
  }

  async getMonitoringAnalysis(ownerId: string, input: MonitoringAnalysisInput) {
    const resolved = await this.resolveMonitoringReadScope(
      ownerId,
      input.scope,
    );
    const facts = await this.readMonitoringFacts(ownerId, resolved);
    const evidence = await this.readMonitoringEvidence(facts);
    return buildMonitoringAnalysis(input.kind, facts, evidence, resolved);
  }

  async getMonitoringExportData(
    ownerId: string,
    scope: MonitoringScope,
    sections: readonly MonitoringExportSection[],
  ) {
    if (
      sections.length === 0 ||
      sections.some((section) => !monitoringExportSections.includes(section))
    ) {
      throw new RepositoryError(
        "INVALID_STATE",
        "Invalid monitoring export section",
      );
    }
    const resolved = await this.resolveMonitoringReadScope(ownerId, scope);
    const answerRows = sections.includes("answers")
      ? await this.readMonitoringExportAnswers(ownerId, resolved.scope)
      : [];
    const facts = await this.readMonitoringFacts(ownerId, resolved);
    const evidence = await this.readMonitoringEvidence(facts);
    const factsByAttempt = new Map(
      facts.map((fact) => [fact.attemptId, fact] as const),
    );
    const metrics = monitoringMetrics(facts, evidence, resolved.subject);
    const trends = buildMonitoringAnalysis("trends", facts, evidence, resolved);
    const competitors = buildMonitoringAnalysis(
      "competitors",
      facts,
      evidence,
      resolved,
    );
    return {
      monitor: {
        id: resolved.monitor.id,
        name: resolved.monitor.name,
        status: resolved.monitor.status,
        version: resolved.version.version,
        mainBrand: resolved.brand.mainBrand,
        timezone: resolved.projectTimezone,
      },
      scope,
      sections: [...new Set(sections)],
      metrics,
      trends: trends.kind === "trends" ? trends.points : [],
      competitors: competitors.kind === "competitors" ? competitors.items : [],
      answers: answerRows.map((row) => {
        const fact = factsByAttempt.get(row.answerId);
        const contribution = fact
          ? monitoringSubjectContribution(fact, resolved.subject)
          : { mentioned: false, position: null };
        const revisionId = row.currentRevisionId;
        return {
          answerId: row.answerId,
          runId: row.runId,
          runCreatedAt: row.runCreatedAt,
          questionId: row.questionId,
          question: row.question,
          platformId: row.platformId,
          platformDisplayName: row.platformDisplayName,
          clientType: row.clientType,
          mode: row.mode,
          repetition: row.repetition,
          status: row.status,
          answerMarkdown: row.answerMarkdown ?? "",
          reasoningMarkdown: row.reasoningMarkdown,
          searchKeywords: Array.isArray(row.searchKeywords)
            ? row.searchKeywords.filter(
                (keyword): keyword is string => typeof keyword === "string",
              )
            : [],
          sentiment: row.sentiment,
          mentioned: contribution.mentioned,
          position: contribution.position,
          citationProvenance: revisionId
            ? (evidence.provenanceByRevision.get(revisionId) ?? "unavailable")
            : "unavailable",
          citationCount: revisionId
            ? (evidence.citationsByRevision.get(revisionId)?.length ?? 0)
            : 0,
          referenceCount: revisionId
            ? (evidence.referencesByRevision.get(revisionId)?.length ?? 0)
            : 0,
        };
      }),
      citations: facts.filter(isEffectiveMonitoringAnswer).flatMap((fact) =>
        fact.revisionId
          ? (evidence.citationsByRevision.get(fact.revisionId) ?? []).map(
              (source) => ({
                answerId: fact.attemptId,
                runCreatedAt: fact.runCreatedAt,
                ...source,
              }),
            )
          : [],
      ),
      sources: facts.filter(isEffectiveMonitoringAnswer).flatMap((fact) =>
        fact.revisionId
          ? (evidence.referencesByRevision.get(fact.revisionId) ?? []).map(
              (source) => ({
                answerId: fact.attemptId,
                runCreatedAt: fact.runCreatedAt,
                ...source,
                isCited:
                  evidence.provenanceByRevision.get(fact.revisionId!) ===
                    "explicit" && source.isCited,
              }),
            )
          : [],
      ),
      answerCount: facts.filter(isEffectiveMonitoringAnswer).length,
    };
  }

  private async readMonitoringExportAnswers(
    ownerId: string,
    scope: MonitoringScope,
  ) {
    const conditions = monitoringFactConditions(ownerId, scope);
    return this.db.transaction(async (tx) => {
      const boundedAnswers = tx
        .select({
          projectedBytes: sql<number>`(
              ${MONITORING_ANSWER_EXPORT_ROW_OVERHEAD_BYTES}
              + OCTET_LENGTH(LEFT(${attempts.question}, ${MONITORING_ANSWER_EXPORT_CELL_READ_LENGTH}))
              + COALESCE(OCTET_LENGTH(LEFT(${attemptResults.answerMarkdown}, ${MONITORING_ANSWER_EXPORT_CELL_READ_LENGTH})), 0)
              + COALESCE(OCTET_LENGTH(LEFT(${attemptResults.reasoningMarkdown}, ${MONITORING_ANSWER_EXPORT_CELL_READ_LENGTH})), 0)
              + COALESCE(OCTET_LENGTH(CAST(${attemptResults.searchKeywords} AS CHAR CHARACTER SET utf8mb4)), 0)
            )`.as("projected_bytes"),
        })
        .from(attempts)
        .innerJoin(runs, eq(attempts.runId, runs.id))
        .innerJoin(
          monitorQuestions,
          and(
            eq(monitorQuestions.monitorVersionId, runs.monitorVersionId),
            eq(monitorQuestions.ordinal, attempts.monitorQuestionOrdinal),
          ),
        )
        .innerJoin(platformCatalog, eq(attempts.platformId, platformCatalog.id))
        .leftJoin(attemptResults, eq(attemptResults.attemptId, attempts.id))
        .where(and(...conditions))
        .limit(MONITORING_ANSWER_EXPORT_ROW_LIMIT + 1)
        .as("bounded_monitoring_export_answers");
      const [preflight] = await tx
        .select({
          rowCount: sql<number>`COUNT(*)`.mapWith(Number),
          projectedBytes:
            sql<number>`COALESCE(SUM(${boundedAnswers.projectedBytes}), 0)`.mapWith(
              Number,
            ),
        })
        .from(boundedAnswers);
      assertMonitoringAnswerExportPreflight(
        preflight?.rowCount ?? Number.NaN,
        preflight?.projectedBytes ?? Number.NaN,
      );

      const rows = await tx
        .select({
          answerId: attempts.id,
          runId: runs.id,
          runCreatedAt: runs.createdAt,
          questionId: monitorQuestions.questionId,
          question: sql<string>`LEFT(${attempts.question}, ${MONITORING_ANSWER_EXPORT_CELL_READ_LENGTH})`,
          platformId: attempts.platformId,
          platformDisplayName: platformCatalog.displayName,
          clientType: attempts.clientType,
          mode: attempts.mode,
          repetition: attempts.repetition,
          status: attempts.status,
          currentRevisionId: attemptResults.currentRevisionId,
          answerMarkdown: sql<
            string | null
          >`LEFT(${attemptResults.answerMarkdown}, ${MONITORING_ANSWER_EXPORT_CELL_READ_LENGTH})`,
          reasoningMarkdown: sql<
            string | null
          >`LEFT(${attemptResults.reasoningMarkdown}, ${MONITORING_ANSWER_EXPORT_CELL_READ_LENGTH})`,
          searchKeywords: attemptResults.searchKeywords,
          sentiment: attemptResults.sentiment,
        })
        .from(attempts)
        .innerJoin(runs, eq(attempts.runId, runs.id))
        .innerJoin(
          monitorQuestions,
          and(
            eq(monitorQuestions.monitorVersionId, runs.monitorVersionId),
            eq(monitorQuestions.ordinal, attempts.monitorQuestionOrdinal),
          ),
        )
        .innerJoin(platformCatalog, eq(attempts.platformId, platformCatalog.id))
        .leftJoin(attemptResults, eq(attemptResults.attemptId, attempts.id))
        .where(and(...conditions))
        .orderBy(desc(runs.createdAt), desc(attempts.id))
        .limit(MONITORING_ANSWER_EXPORT_ROW_LIMIT + 1);
      if (rows.length > MONITORING_ANSWER_EXPORT_ROW_LIMIT) {
        throw new RepositoryError(
          "INVALID_STATE",
          `Monitoring answer export exceeds the ${MONITORING_ANSWER_EXPORT_ROW_LIMIT.toLocaleString("en-US")} row limit; narrow the date or dimension filters`,
        );
      }
      return rows;
    }, MONITORING_ANSWER_EXPORT_TRANSACTION_CONFIG);
  }

  async resolveMonitoringExportRun(
    ownerId: string,
    monitorId: string,
    runId?: string,
  ) {
    await this.getMonitor(ownerId, monitorId);
    const conditions = [
      monitoringChildOwnerPredicate(runs, ownerId),
      eq(runs.monitorId, monitorId),
      isNull(runs.deletedAt),
      sql`EXISTS (SELECT 1 FROM projects p WHERE p.id = ${runs.projectId} AND p.owner_id = ${ownerId} AND p.deleted_at IS NULL)`,
    ];
    if (runId) conditions.push(eq(runs.id, runId));
    const [run] = await this.db
      .select({ id: runs.id })
      .from(runs)
      .where(and(...conditions))
      .orderBy(desc(runs.createdAt), desc(runs.id))
      .limit(1);
    if (!run)
      throw new RepositoryError("NOT_FOUND", "Monitoring run not found");
    return run.id;
  }

  private async resolveMonitoringReadScope(
    ownerId: string,
    scope: MonitoringScope,
  ): Promise<ResolvedMonitoringScope> {
    const detail = await this.getMonitor(ownerId, scope.monitorId);
    const [[brand], [project], platforms] = await Promise.all([
      this.db
        .select()
        .from(projectBrandVersions)
        .where(
          eq(projectBrandVersions.id, detail.version.projectBrandVersionId),
        )
        .limit(1),
      this.db
        .select({ timezone: projects.timezone })
        .from(projects)
        .where(
          and(
            eq(projects.id, detail.monitor.projectId),
            monitoringProjectOwnerPredicate(projects, ownerId),
            isNull(projects.deletedAt),
          ),
        )
        .limit(1),
      this.db
        .select({
          monitorVersionId: monitorPlatforms.monitorVersionId,
          ordinal: monitorPlatforms.ordinal,
          platformId: monitorPlatforms.platformId,
          providerCode: monitorPlatforms.providerCodeSnapshot,
          clientType: monitorPlatforms.clientType,
          mode: monitorPlatforms.mode,
          displayName: platformCatalog.displayName,
        })
        .from(monitorPlatforms)
        .innerJoin(
          platformCatalog,
          eq(monitorPlatforms.platformId, platformCatalog.id),
        )
        .where(eq(monitorPlatforms.monitorVersionId, detail.version.id))
        .orderBy(asc(monitorPlatforms.ordinal)),
    ]);
    if (!brand || !project)
      throw new RepositoryError(
        "NOT_FOUND",
        "Monitor project or brand configuration not found",
      );
    if (
      scope.questionId &&
      !detail.questions.some(
        (question) => question.questionId === scope.questionId,
      )
    ) {
      throw new RepositoryError(
        "INVALID_STATE",
        "Question is not in the current monitor configuration",
      );
    }
    if (
      scope.platformId &&
      !platforms.some((platform) => platform.platformId === scope.platformId)
    ) {
      throw new RepositoryError(
        "INVALID_STATE",
        "Platform is not in the current monitor configuration",
      );
    }
    const competitorName =
      scope.subject.kind === "competitor" ? scope.subject.name : null;
    const competitor =
      competitorName !== null
        ? detail.version.competitors.find(
            (candidate) => candidate.name === competitorName,
          )
        : null;
    if (scope.subject.kind === "competitor" && !competitor) {
      throw new RepositoryError(
        "INVALID_STATE",
        "Competitor is not in the current monitor configuration",
      );
    }
    return {
      scope,
      monitor: detail.monitor,
      version: detail.version,
      questions: detail.questions,
      platforms,
      brand,
      projectTimezone: project.timezone,
      subject:
        scope.subject.kind === "self"
          ? ({ kind: "self" } as const)
          : ({
              kind: "competitor" as const,
              name: competitor!.name,
              aliases: competitor!.aliases,
            } as const),
    };
  }

  private async readMonitoringFacts(
    ownerId: string,
    resolved: ResolvedMonitoringScope,
  ): Promise<MonitoringFact[]> {
    const conditions = monitoringFactConditions(ownerId, resolved.scope);
    const rows = await this.db
      .select({
        attemptId: attempts.id,
        runId: runs.id,
        runCreatedAt: runs.createdAt,
        questionId: monitorQuestions.questionId,
        platformId: attempts.platformId,
        status: attempts.status,
        revisionId: attemptResults.currentRevisionId,
        hasNonEmptyAnswer: sql<number>`CASE WHEN ${attemptResults.attemptId} IS NOT NULL AND CHAR_LENGTH(TRIM(${attemptResults.answerMarkdown})) > 0 THEN 1 ELSE 0 END`,
        sentiment: attemptResults.sentiment,
        brandMentioned: attemptResults.brandMentioned,
        mentionPosition: attemptResults.mentionPosition,
        competitorRankings: attemptResults.competitorRankings,
        monitorCompetitors: monitorVersions.competitors,
        citationProvenanceHint: sql<
          string | null
        >`JSON_UNQUOTE(JSON_EXTRACT(${resultRevisions.normalizedPayload}, '$.citationProvenance'))`,
        hasLegacyCitationList: sql<number>`CASE WHEN JSON_TYPE(JSON_EXTRACT(${resultRevisions.normalizedPayload}, '$.raw.citationList')) = 'ARRAY' THEN 1 ELSE 0 END`,
        revisionCreatedAt: resultRevisions.createdAt,
      })
      .from(attempts)
      .innerJoin(runs, eq(attempts.runId, runs.id))
      .innerJoin(monitorVersions, eq(runs.monitorVersionId, monitorVersions.id))
      .innerJoin(
        monitorQuestions,
        and(
          eq(monitorQuestions.monitorVersionId, runs.monitorVersionId),
          eq(monitorQuestions.ordinal, attempts.monitorQuestionOrdinal),
        ),
      )
      .leftJoin(attemptResults, eq(attemptResults.attemptId, attempts.id))
      .leftJoin(
        resultRevisions,
        eq(resultRevisions.id, attemptResults.currentRevisionId),
      )
      .where(and(...conditions))
      .limit(MONITORING_FACT_LIMIT + 1);
    if (rows.length > MONITORING_FACT_LIMIT) {
      throw new RepositoryError(
        "INVALID_STATE",
        `Monitoring scope exceeds the ${MONITORING_FACT_LIMIT.toLocaleString("en-US")} attempt aggregation limit; narrow the date or dimension filters`,
      );
    }
    return rows.map((row) => ({
      ...row,
      hasNonEmptyAnswer: Number(row.hasNonEmptyAnswer) === 1,
      citationProvenanceHint: parseCitationProvenanceHint(
        row.citationProvenanceHint,
      ),
      hasLegacyCitationList: Number(row.hasLegacyCitationList) === 1,
    }));
  }

  private async readMonitoringEvidence(
    facts: readonly MonitoringFact[],
  ): Promise<MonitoringEvidence> {
    const revisionIdSet = new Set<string>();
    for (const fact of facts) {
      if (fact.revisionId) revisionIdSet.add(fact.revisionId);
    }
    const revisionIds = [...revisionIdSet];
    if (revisionIds.length === 0) return emptyMonitoringEvidence();
    const sources: MonitoringSourceRow[] = [];
    const discovered: MonitoringDiscoveredRow[] = [];
    const screenshotRows: Array<{ revisionId: string }> = [];
    let evidenceRowCount = 0;
    const acceptRows = <T>(target: T[], rows: readonly T[]) => {
      if (evidenceRowCount + rows.length > MONITORING_EVIDENCE_ROW_LIMIT) {
        throw new RepositoryError(
          "INVALID_STATE",
          `Monitoring scope exceeds the ${MONITORING_EVIDENCE_ROW_LIMIT.toLocaleString("en-US")} evidence row limit; narrow the date or dimension filters`,
        );
      }
      for (const row of rows) target.push(row);
      evidenceRowCount += rows.length;
    };

    for (const batch of chunks(
      revisionIds,
      MONITORING_EVIDENCE_REVISION_BATCH_SIZE,
    )) {
      const remaining = MONITORING_EVIDENCE_ROW_LIMIT - evidenceRowCount;
      const rows = await this.db
        .select({
          id: resultSources.id,
          revisionId: resultSources.revisionId,
          ordinal: resultSources.ordinal,
          providerPosition: resultSources.providerPosition,
          url: resultSources.url,
          title: resultSources.title,
          domain: resultSources.domain,
          citedText: resultSources.citedText,
          createdAt: resultSources.createdAt,
        })
        .from(resultSources)
        .where(inArray(resultSources.revisionId, batch))
        .orderBy(asc(resultSources.revisionId), asc(resultSources.ordinal))
        .limit(remaining + 1);
      acceptRows(sources, rows);
    }
    for (const batch of chunks(
      revisionIds,
      MONITORING_EVIDENCE_REVISION_BATCH_SIZE,
    )) {
      const remaining = MONITORING_EVIDENCE_ROW_LIMIT - evidenceRowCount;
      const rows = await this.db
        .select({
          id: resultDiscoveredSources.id,
          revisionId: resultDiscoveredSources.revisionId,
          ordinal: resultDiscoveredSources.ordinal,
          providerPosition: resultDiscoveredSources.providerPosition,
          url: resultDiscoveredSources.url,
          title: resultDiscoveredSources.title,
          domain: resultDiscoveredSources.domain,
          siteName: resultDiscoveredSources.siteName,
          summary: resultDiscoveredSources.summary,
          publishedAt: resultDiscoveredSources.publishedAt,
          isCited: resultDiscoveredSources.isCited,
          createdAt: resultDiscoveredSources.createdAt,
        })
        .from(resultDiscoveredSources)
        .where(inArray(resultDiscoveredSources.revisionId, batch))
        .orderBy(
          asc(resultDiscoveredSources.revisionId),
          asc(resultDiscoveredSources.ordinal),
        )
        .limit(remaining + 1);
      acceptRows(discovered, rows);
    }
    for (const batch of chunks(
      revisionIds,
      MONITORING_EVIDENCE_REVISION_BATCH_SIZE,
    )) {
      const remaining = MONITORING_EVIDENCE_ROW_LIMIT - evidenceRowCount;
      const rows = await this.db
        .select({ revisionId: resultMedia.revisionId })
        .from(resultMedia)
        .where(
          and(
            inArray(resultMedia.revisionId, batch),
            eq(resultMedia.type, "screenshot"),
            eq(resultMedia.archiveStatus, "archived"),
          ),
        )
        .limit(remaining + 1);
      acceptRows(screenshotRows, rows);
    }

    const persistedDiscoveryRevisionIds = new Set(
      discovered.map((source) => source.revisionId),
    );
    const factByRevision = new Map<string, MonitoringFact>();
    for (const fact of facts) {
      if (fact.revisionId) factByRevision.set(fact.revisionId, fact);
    }
    const legacyFallbackRevisionIds = revisionIds.filter((revisionId) => {
      const fact = factByRevision.get(revisionId);
      return (
        fact !== undefined &&
        fact.citationProvenanceHint === null &&
        !persistedDiscoveryRevisionIds.has(revisionId)
      );
    });
    if (
      legacyFallbackRevisionIds.length >
      MONITORING_LEGACY_DISCOVERY_FALLBACK_LIMIT
    ) {
      throw new RepositoryError(
        "INVALID_STATE",
        `Monitoring scope exceeds the ${MONITORING_LEGACY_DISCOVERY_FALLBACK_LIMIT.toLocaleString("en-US")} legacy evidence fallback limit; narrow the date or dimension filters`,
      );
    }
    const legacyDiscoveryPayloadByRevision = new Map<
      string,
      Record<string, unknown>
    >();
    for (const batch of chunks(
      legacyFallbackRevisionIds,
      MONITORING_EVIDENCE_REVISION_BATCH_SIZE,
    )) {
      const rows = await this.db
        .select({
          revisionId: resultRevisions.id,
          discoveryPayload: sql<Record<string, unknown>>`JSON_OBJECT(
            'allReferences', COALESCE(JSON_EXTRACT(${resultRevisions.normalizedPayload}, '$.allReferences'), JSON_ARRAY()),
            'references', COALESCE(JSON_EXTRACT(${resultRevisions.normalizedPayload}, '$.references'), JSON_ARRAY())
          )`.mapWith(resultRevisions.normalizedPayload),
        })
        .from(resultRevisions)
        .where(inArray(resultRevisions.id, batch))
        .limit(batch.length);
      for (const row of rows) {
        legacyDiscoveryPayloadByRevision.set(
          row.revisionId,
          row.discoveryPayload,
        );
      }
    }
    return buildMonitoringEvidence(
      facts,
      sources,
      discovered,
      screenshotRows,
      legacyDiscoveryPayloadByRevision,
      MONITORING_EVIDENCE_ROW_LIMIT,
    );
  }

  async listRuns(ownerId: string, monitorId: string, limit = 30) {
    const rows = await this.db
      .select({
        run: runs,
        configurationVersion: monitorVersions.version,
        effectiveAnswers: runMetrics.effectiveAnswers,
        brandMentionedAnswers: runMetrics.brandMentionedAnswers,
        averageMentionPosition: sql<
          string | null
        >`CASE WHEN ${runMetrics.mentionPositionCount} IS NULL OR ${runMetrics.mentionPositionCount} = 0 THEN NULL ELSE ${runMetrics.mentionPositionSum} / ${runMetrics.mentionPositionCount} END`,
        citationCount: runMetrics.citationCount,
        uniqueDomainCount: runMetrics.uniqueDomainCount,
        positiveCount: runMetrics.positiveCount,
        neutralCount: runMetrics.neutralCount,
        negativeCount: runMetrics.negativeCount,
        unknownCount: runMetrics.unknownCount,
        modelMetrics: runMetrics.modelMetrics,
        competitorMetrics: runMetrics.competitorMetrics,
      })
      .from(runs)
      .innerJoin(monitorVersions, eq(runs.monitorVersionId, monitorVersions.id))
      .leftJoin(runMetrics, eq(runMetrics.runId, runs.id))
      .where(
        and(
          monitoringChildOwnerPredicate(runs, ownerId),
          eq(runs.monitorId, monitorId),
          isNull(runs.deletedAt),
          sql`EXISTS (SELECT 1 FROM projects p WHERE p.id = ${runs.projectId} AND p.owner_id = ${ownerId} AND p.deleted_at IS NULL)`,
        ),
      )
      .orderBy(desc(runs.createdAt))
      .limit(limit);
    return rows.map(
      ({
        run,
        configurationVersion,
        effectiveAnswers,
        brandMentionedAnswers,
        averageMentionPosition,
        citationCount,
        uniqueDomainCount,
        positiveCount,
        neutralCount,
        negativeCount,
        unknownCount,
        modelMetrics,
        competitorMetrics,
      }) => ({
        ...run,
        configurationVersion,
        metrics: {
          effectiveAnswers: Number(effectiveAnswers ?? 0),
          brandMentionedAnswers: Number(brandMentionedAnswers ?? 0),
          averageMentionPosition:
            averageMentionPosition === null
              ? null
              : Number(averageMentionPosition),
          citationCount: Number(citationCount ?? 0),
          uniqueDomainCount: Number(uniqueDomainCount ?? 0),
          positiveCount: Number(positiveCount ?? 0),
          neutralCount: Number(neutralCount ?? 0),
          negativeCount: Number(negativeCount ?? 0),
          unknownCount: Number(unknownCount ?? 0),
          modelMetrics: modelMetrics ?? [],
          competitorMetrics: competitorMetrics ?? [],
        },
      }),
    );
  }

  async listDeletedRuns(ownerId: string, limit = 100) {
    return this.db
      .select({
        id: runs.id,
        monitorId: runs.monitorId,
        status: runs.status,
        deletedAt: runs.deletedAt,
        purgeAfter: runs.purgeAfter,
        createdAt: runs.createdAt,
      })
      .from(runs)
      .where(and(monitoringChildOwnerPredicate(runs, ownerId), sql`${runs.deletedAt} IS NOT NULL`))
      .orderBy(desc(runs.deletedAt))
      .limit(limit);
  }

  async softDeleteRun(ownerId: string, runId: string, audit: RequestAudit) {
    const now = new Date();
    const purgeAfter = new Date(now.getTime() + 30 * 86_400_000);
    await this.db.transaction(async (tx) => {
      const [run] = await tx
        .select()
        .from(runs)
        .where(
          and(
            eq(runs.id, runId),
            monitoringChildOwnerPredicate(runs, ownerId),
            isNull(runs.deletedAt),
          ),
        )
        .for("update")
        .limit(1);
      if (!run) throw new RepositoryError("NOT_FOUND", "Run not found");
      if (
        ["queued", "waiting_quota", "running", "review_required"].includes(
          run.status,
        )
      ) {
        throw new RepositoryError(
          "INVALID_STATE",
          "Cancel the active run before deleting it",
        );
      }
      await tx
        .update(runs)
        .set({ deletedAt: now, purgeAfter })
        .where(eq(runs.id, runId));
      await tx.insert(jobs).values({
        id: randomUUID(),
        type: "purge_soft_deleted",
        dedupeKey: `purge:run:${runId}`,
        payload: { entityType: "run", entityId: runId },
        availableAt: purgeAfter,
      });
      await insertAudit(tx, audit, "run.deleted", "run", runId, ownerId, {
        purgeAfter: purgeAfter.toISOString(),
      });
    });
  }

  async restoreRun(ownerId: string, runId: string, audit: RequestAudit) {
    const now = new Date();
    await this.db.transaction(async (tx) => {
      const [run] = await tx
        .select()
        .from(runs)
        .where(
          and(
            eq(runs.id, runId),
            monitoringChildOwnerPredicate(runs, ownerId),
            sql`${runs.deletedAt} IS NOT NULL`,
          ),
        )
        .for("update")
        .limit(1);
      if (!run || (run.purgeAfter && run.purgeAfter <= now))
        throw new RepositoryError("NOT_FOUND", "Restorable run not found");
      const [monitor] = await tx
        .select({ id: monitors.id })
        .from(monitors)
        .where(
          and(
            eq(monitors.id, run.monitorId),
            monitoringChildOwnerPredicate(monitors, ownerId),
            isNull(monitors.deletedAt),
          ),
        )
        .limit(1);
      if (!monitor)
        throw new RepositoryError(
          "INVALID_STATE",
          "Restore the parent monitor first",
        );
      await tx
        .update(runs)
        .set({ deletedAt: null, purgeAfter: null })
        .where(eq(runs.id, runId));
      await tx.delete(jobs).where(eq(jobs.dedupeKey, `purge:run:${runId}`));
      await insertAudit(tx, audit, "run.restored", "run", runId, ownerId, {});
    });
  }

  async getRun(ownerId: string, runId: string) {
    const [run] = await this.db
      .select()
      .from(runs)
      .where(
        and(
          eq(runs.id, runId),
          monitoringChildOwnerPredicate(runs, ownerId),
          isNull(runs.deletedAt),
          sql`EXISTS (SELECT 1 FROM projects p WHERE p.id = ${runs.projectId} AND p.owner_id = ${ownerId} AND p.deleted_at IS NULL)`,
        ),
      )
      .limit(1);
    if (!run) throw new RepositoryError("NOT_FOUND", "Run not found");
    const attemptRows = await this.db
      .select({
        attempt: attempts,
        result: attemptResults,
        normalizedPayload: resultRevisions.normalizedPayload,
        revisionCreatedAt: resultRevisions.createdAt,
      })
      .from(attempts)
      .leftJoin(attemptResults, eq(attempts.id, attemptResults.attemptId))
      .leftJoin(
        resultRevisions,
        eq(attemptResults.currentRevisionId, resultRevisions.id),
      )
      .where(eq(attempts.runId, runId))
      .orderBy(
        asc(attempts.monitorQuestionOrdinal),
        asc(attempts.monitorPlatformOrdinal),
        asc(attempts.repetition),
      );
    const revisionIds = attemptRows.flatMap((row) =>
      row.result ? [row.result.currentRevisionId] : [],
    );
    const [sources, persistedDiscoveredSources, mediaRows] =
      revisionIds.length === 0
        ? [[], [], []]
        : await Promise.all([
            this.db
              .select()
              .from(resultSources)
              .where(inArray(resultSources.revisionId, revisionIds))
              .orderBy(asc(resultSources.ordinal)),
            this.db
              .select()
              .from(resultDiscoveredSources)
              .where(inArray(resultDiscoveredSources.revisionId, revisionIds))
              .orderBy(asc(resultDiscoveredSources.ordinal)),
            this.db
              .select()
              .from(resultMedia)
              .where(inArray(resultMedia.revisionId, revisionIds))
              .orderBy(asc(resultMedia.ordinal)),
          ]);
    const sourceRevisionIds = new Set(
      sources.map((source) => source.revisionId),
    );
    const citationProvenanceByRevision = new Map<string, CitationProvenance>();
    for (const row of attemptRows) {
      if (!row.result) continue;
      citationProvenanceByRevision.set(
        row.result.currentRevisionId,
        inferCitationProvenance(
          row.normalizedPayload,
          sourceRevisionIds.has(row.result.currentRevisionId),
        ),
      );
    }
    const persistedRevisionIds = new Set(
      persistedDiscoveredSources.map((source) => source.revisionId),
    );
    const fallbackDiscoveredSources = attemptRows.flatMap((row) => {
      if (
        !row.result ||
        persistedRevisionIds.has(row.result.currentRevisionId)
      ) {
        return [];
      }
      return discoveredSourcesFromNormalizedPayload({
        revisionId: row.result.currentRevisionId,
        payload: row.normalizedPayload,
        citationProvenance:
          citationProvenanceByRevision.get(row.result.currentRevisionId) ??
          "unavailable",
        createdAt: row.revisionCreatedAt ?? row.result.createdAt,
      });
    });
    const discoveredSources = orderDiscoveredSourcesByAttempt(attemptRows, [
      ...persistedDiscoveredSources,
      ...fallbackDiscoveredSources,
    ]);
    const discoveredByCanonicalUrl = new Map(
      discoveredSources.map((source) => [
        `${source.revisionId}:${sha256(canonicalUrl(source.url))}`,
        source,
      ]),
    );
    const [version] = await this.db
      .select()
      .from(monitorVersions)
      .where(eq(monitorVersions.id, run.monitorVersionId))
      .limit(1);
    const [brand] = await this.db
      .select()
      .from(projectBrandVersions)
      .where(eq(projectBrandVersions.id, run.projectBrandVersionId))
      .limit(1);
    if (!version || !brand)
      throw new RepositoryError(
        "NOT_FOUND",
        "Run configuration snapshot not found",
      );
    const [questionRows, platformRows] = await Promise.all([
      this.db
        .select()
        .from(monitorQuestions)
        .where(eq(monitorQuestions.monitorVersionId, version.id))
        .orderBy(asc(monitorQuestions.ordinal)),
      this.db
        .select({
          monitorVersionId: monitorPlatforms.monitorVersionId,
          ordinal: monitorPlatforms.ordinal,
          platformId: monitorPlatforms.platformId,
          providerCodeSnapshot: monitorPlatforms.providerCodeSnapshot,
          clientType: monitorPlatforms.clientType,
          mode: monitorPlatforms.mode,
          screenshot: monitorPlatforms.screenshot,
          regionCode: monitorPlatforms.regionCode,
          displayName: platformCatalog.displayName,
        })
        .from(monitorPlatforms)
        .leftJoin(
          platformCatalog,
          eq(monitorPlatforms.platformId, platformCatalog.id),
        )
        .where(eq(monitorPlatforms.monitorVersionId, version.id))
        .orderBy(asc(monitorPlatforms.ordinal)),
    ]);
    return {
      run,
      attempts: attemptRows.map(({ attempt, result, normalizedPayload }) => ({
        attempt: {
          id: attempt.id,
          monitorQuestionOrdinal: attempt.monitorQuestionOrdinal,
          monitorPlatformOrdinal: attempt.monitorPlatformOrdinal,
          repetition: attempt.repetition,
          question: attempt.question,
          platformId: attempt.platformId,
          providerCode: attempt.providerCode,
          clientType: attempt.clientType,
          mode: attempt.mode,
          screenshot: attempt.screenshot,
          regionCode: attempt.regionCode,
          status: attempt.status,
          errorMessage: attempt.errorMessage,
          submittedAt: attempt.submittedAt,
          terminalAt: attempt.terminalAt,
          createdAt: attempt.createdAt,
          updatedAt: attempt.updatedAt,
        },
        result: result
          ? {
              attemptId: result.attemptId,
              currentRevisionId: result.currentRevisionId,
              revision: result.revision,
              answerMarkdown: result.answerMarkdown,
              reasoningMarkdown: result.reasoningMarkdown,
              searchKeywords: result.searchKeywords,
              sentiment: result.sentiment,
              brandMentioned: result.brandMentioned,
              mentionPosition: result.mentionPosition,
              competitorRankings: result.competitorRankings,
              keywordEvaluations: safeKeywordEvaluations(
                result.keywordEvaluations,
              ),
              citationProvenance:
                citationProvenanceByRevision.get(result.currentRevisionId) ??
                inferCitationProvenance(
                  normalizedPayload,
                  sourceRevisionIds.has(result.currentRevisionId),
                ),
              categoryRanking: result.categoryRanking,
              createdAt: result.createdAt,
              updatedAt: result.updatedAt,
            }
          : null,
      })),
      sources: sources.map((source) => {
        const discovered = discoveredByCanonicalUrl.get(
          `${source.revisionId}:${source.canonicalUrlHash}`,
        );
        const citationProvenance =
          citationProvenanceByRevision.get(source.revisionId) ??
          "legacy_assumed";
        return {
          id: source.id,
          revisionId: source.revisionId,
          ordinal: source.ordinal,
          providerPosition:
            citationProvenance === "legacy_assumed"
              ? null
              : (source.providerPosition ??
                discovered?.providerPosition ??
                null),
          url: source.url,
          title: source.title || discovered?.title || "",
          domain: discovered?.domain || source.domain,
          siteName: discovered?.siteName ?? null,
          summary: discovered?.summary ?? null,
          publishedAt: discovered?.publishedAt ?? null,
          citationProvenance,
          citedText: source.citedText,
          createdAt: source.createdAt,
        };
      }),
      discoveredSources: discoveredSources.map((source) => {
        const citationProvenance =
          citationProvenanceByRevision.get(source.revisionId) ??
          "legacy_assumed";
        return {
          id: source.id,
          revisionId: source.revisionId,
          ordinal: source.ordinal,
          providerPosition:
            citationProvenance === "legacy_assumed"
              ? null
              : (source.providerPosition ?? null),
          url: source.url,
          title: source.title,
          domain: source.domain,
          siteName: source.siteName,
          summary: source.summary,
          publishedAt: source.publishedAt,
          citationProvenance,
          isCited: citationProvenance === "explicit" && source.isCited,
          createdAt: source.createdAt,
        };
      }),
      media: mediaRows.map((media) => ({
        id: media.id,
        revisionId: media.revisionId,
        type: media.type,
        ordinal: media.ordinal,
        mimeType: media.mimeType,
        sizeBytes: media.sizeBytes,
        archiveStatus: media.archiveStatus,
        accessPath:
          media.archiveStatus === "archived"
            ? `/api/monitoring/media/${media.id}`
            : null,
        thumbnailAccessPath:
          media.archiveStatus === "archived" && media.thumbnailObjectKey
            ? `/api/monitoring/media/${media.id}?variant=thumbnail`
            : null,
      })),
      configuration: {
        version,
        brand,
        questions: questionRows,
        platforms: platformRows,
      },
    };
  }

  async getRunExportData(ownerId: string, runId: string) {
    const detail = await this.getRun(ownerId, runId);
    const billing = await this.db
      .select({
        attemptId: attempts.id,
        quotedTenThousandths: attemptPriceSnapshots.amountTenThousandths,
        settlementStatus: attemptMoneySettlements.status,
        settledTenThousandths: attemptMoneySettlements.settledTenThousandths,
        currency: attemptPriceSnapshots.currency,
      })
      .from(attempts)
      .innerJoin(
        attemptPriceSnapshots,
        eq(attemptPriceSnapshots.attemptId, attempts.id),
      )
      .innerJoin(
        attemptMoneySettlements,
        eq(attemptMoneySettlements.attemptId, attempts.id),
      )
      .where(eq(attempts.runId, runId));
    if (billing.some((row) => row.currency !== "CNY"))
      throw new RepositoryError(
        "INVALID_STATE",
        "Run billing snapshot currency is invalid",
      );
    return {
      ...detail,
      version: detail.configuration.version,
      brand: detail.configuration.brand,
      questionRows: detail.configuration.questions,
      platformRows: detail.configuration.platforms,
      billing: billing.map((row) => ({
        attemptId: row.attemptId,
        quotedTenThousandths: row.quotedTenThousandths.toString(),
        settlementStatus: row.settlementStatus,
        settledTenThousandths: row.settledTenThousandths.toString(),
        currency: "CNY" as const,
      })),
    };
  }

  async getRunForAdmin(runId: string, audit: RequestAudit) {
    const [run] = await this.db
      .select()
      .from(runs)
      .where(eq(runs.id, runId))
      .limit(1);
    if (!run) throw new RepositoryError("NOT_FOUND", "Run not found");
    await this.writeAudit(
      audit,
      "admin.content_viewed",
      "run",
      runId,
      run.ownerId,
      {},
    );
    return this.getRun(run.ownerId, runId);
  }

  async getMediaForOwner(ownerId: string, mediaId: string) {
    const [row] = await this.db
      .select({
        media: resultMedia,
        attemptId: attempts.id,
        runId: runs.id,
        ownerId: runs.ownerId,
      })
      .from(resultMedia)
      .innerJoin(
        resultRevisions,
        eq(resultMedia.revisionId, resultRevisions.id),
      )
      .innerJoin(attempts, eq(resultRevisions.attemptId, attempts.id))
      .innerJoin(runs, eq(attempts.runId, runs.id))
      .innerJoin(projects, eq(runs.projectId, projects.id))
      .where(
        and(
          eq(resultMedia.id, mediaId),
          monitoringChildOwnerPredicate(runs, ownerId),
          isNull(runs.deletedAt),
          monitoringProjectOwnerPredicate(projects, ownerId),
          isNull(projects.deletedAt),
        ),
      )
      .limit(1);
    if (!row) throw new RepositoryError("NOT_FOUND", "Media not found");
    return row;
  }

  async getMediaForAdmin(mediaId: string, audit: RequestAudit) {
    const [row] = await this.db
      .select({ ownerId: runs.ownerId })
      .from(resultMedia)
      .innerJoin(
        resultRevisions,
        eq(resultMedia.revisionId, resultRevisions.id),
      )
      .innerJoin(attempts, eq(resultRevisions.attemptId, attempts.id))
      .innerJoin(runs, eq(attempts.runId, runs.id))
      .where(eq(resultMedia.id, mediaId))
      .limit(1);
    if (!row) throw new RepositoryError("NOT_FOUND", "Media not found");
    await this.writeAudit(
      audit,
      "admin.media_viewed",
      "media",
      mediaId,
      row.ownerId,
      {},
    );
    return this.getMediaForOwner(row.ownerId, mediaId);
  }

  async listAllRuns(limit = 100) {
    return this.db
      .select({
        run: runs,
        username: users.username,
        monitorName: monitors.name,
      })
      .from(runs)
      .innerJoin(users, monitoringChildOwnerPredicate(runs, users.id))
      .innerJoin(monitors, eq(runs.monitorId, monitors.id))
      .where(isNull(runs.deletedAt))
      .orderBy(desc(runs.createdAt))
      .limit(limit);
  }

  async listAdminOperations(input: AdminOperationsListInput) {
    const baseConditions = [isNull(runs.deletedAt)];
    if (input.userId) baseConditions.push(monitoringChildOwnerPredicate(runs, input.userId));
    if (input.status) baseConditions.push(eq(runs.status, input.status));
    if (input.from) baseConditions.push(gte(runs.createdAt, input.from));
    if (input.to) baseConditions.push(lte(runs.createdAt, input.to));

    const pageConditions = [...baseConditions];
    if (input.cursor) {
      const [cursorRow] = await this.db
        .select({ id: runs.id, createdAt: runs.createdAt })
        .from(runs)
        .where(and(eq(runs.id, input.cursor), ...baseConditions))
        .limit(1);
      if (!cursorRow) {
        return {
          items: [],
          summary: await this.adminOperationsSummary(baseConditions),
          nextCursor: null,
        };
      }
      const beforeCursor = or(
        lt(runs.createdAt, cursorRow.createdAt),
        and(eq(runs.createdAt, cursorRow.createdAt), lt(runs.id, cursorRow.id)),
      );
      if (beforeCursor) pageConditions.push(beforeCursor);
    }

    const [rows, summary] = await Promise.all([
      this.db
        .select({
          run: runs,
          userId: users.id,
          username: users.username,
          monitorName: monitors.name,
        })
        .from(runs)
        .innerJoin(users, monitoringChildOwnerPredicate(runs, users.id))
        .innerJoin(monitors, eq(runs.monitorId, monitors.id))
        .where(and(...pageConditions))
        .orderBy(desc(runs.createdAt), desc(runs.id))
        .limit(input.limit + 1),
      this.adminOperationsSummary(baseConditions),
    ]);
    const hasMore = rows.length > input.limit;
    const items = hasMore ? rows.slice(0, input.limit) : rows;
    return {
      items,
      summary,
      nextCursor: hasMore ? (items.at(-1)?.run.id ?? null) : null,
    };
  }

  async getRunExecutionForAdmin(runId: string) {
    const [record] = await this.db
      .select({
        run: runs,
        userId: users.id,
        username: users.username,
        monitorName: monitors.name,
      })
      .from(runs)
      .innerJoin(users, monitoringChildOwnerPredicate(runs, users.id))
      .innerJoin(monitors, eq(runs.monitorId, monitors.id))
      .where(and(eq(runs.id, runId), isNull(runs.deletedAt)))
      .limit(1);
    if (!record) throw new RepositoryError("NOT_FOUND", "Run not found");

    const attemptRows = await this.db
      .select({
        id: attempts.id,
        monitorQuestionOrdinal: attempts.monitorQuestionOrdinal,
        monitorPlatformOrdinal: attempts.monitorPlatformOrdinal,
        repetition: attempts.repetition,
        question: attempts.question,
        platformId: attempts.platformId,
        providerCode: attempts.providerCode,
        clientType: attempts.clientType,
        mode: attempts.mode,
        status: attempts.status,
        providerTaskId: attempts.providerTaskId,
        providerSubTaskId: attempts.providerSubTaskId,
        errorCode: attempts.errorCode,
        errorMessage: attempts.errorMessage,
        submittedAt: attempts.submittedAt,
        terminalAt: attempts.terminalAt,
        createdAt: attempts.createdAt,
        updatedAt: attempts.updatedAt,
      })
      .from(attempts)
      .where(eq(attempts.runId, runId))
      .orderBy(
        asc(attempts.monitorQuestionOrdinal),
        asc(attempts.monitorPlatformOrdinal),
        asc(attempts.repetition),
      );
    return { ...record, attempts: attemptRows };
  }

  private async adminOperationsSummary(
    conditions: ReturnType<typeof isNull>[],
  ) {
    const [statusRows, totals] = await Promise.all([
      this.db
        .select({ status: runs.status, count: sql<number>`COUNT(*)` })
        .from(runs)
        .where(and(...conditions))
        .groupBy(runs.status),
      this.db
        .select({
          totalRuns: sql<number>`COUNT(*)`,
          expectedAttempts: sql<number>`COALESCE(SUM(${runs.expectedAttempts}), 0)`,
          submittedAttempts: sql<number>`COALESCE(SUM(${runs.submittedAttempts}), 0)`,
          completedAttempts: sql<number>`COALESCE(SUM(${runs.completedAttempts}), 0)`,
          failedAttempts: sql<number>`COALESCE(SUM(${runs.failedAttempts}), 0)`,
          stoppedAttempts: sql<number>`COALESCE(SUM(${runs.stoppedAttempts}), 0)`,
        })
        .from(runs)
        .where(and(...conditions)),
    ]);
    const total = totals[0];
    return {
      totalRuns: Number(total?.totalRuns ?? 0),
      runsByStatus: Object.fromEntries(
        statusRows.map((row) => [row.status, Number(row.count)]),
      ),
      expectedAttempts: Number(total?.expectedAttempts ?? 0),
      submittedAttempts: Number(total?.submittedAttempts ?? 0),
      completedAttempts: Number(total?.completedAttempts ?? 0),
      failedAttempts: Number(total?.failedAttempts ?? 0),
      stoppedAttempts: Number(total?.stoppedAttempts ?? 0),
    };
  }

  async listRegions(scope?: "domestic" | "overseas") {
    return this.db
      .select()
      .from(providerRegions)
      .where(scope ? eq(providerRegions.scope, scope) : undefined)
      .orderBy(asc(providerRegions.scope), asc(providerRegions.name));
  }

  async enqueueProviderCatalogSync(audit: RequestAudit) {
    const now = new Date();
    await this.db.transaction(async (tx) => {
      await tx
        .insert(jobs)
        .values({
          id: randomUUID(),
          type: "sync_provider_catalog",
          dedupeKey: "admin:sync-provider-catalog",
          payload: { requestedBy: audit.actorId },
          availableAt: now,
        })
        .onDuplicateKeyUpdate({
          set: {
            status: "ready",
            availableAt: now,
            leaseOwner: null,
            leaseExpiresAt: null,
            attempts: 0,
            completedAt: null,
            lastErrorCode: null,
            lastErrorMessage: null,
          },
        });
      await insertAudit(
        tx,
        audit,
        "admin.platform_sync_requested",
        "provider",
        null,
        null,
        {},
      );
    });
  }

  async getAdminOverview(observedAt = new Date()) {
    const [
      jobCounts,
      runCounts,
      costSummary,
      reconciliation,
      heartbeats,
      submissionUnknown,
      mediaArchiveFailures,
      recentDeadJobs,
    ] = await Promise.all([
      this.db
        .select({ status: jobs.status, count: sql<number>`COUNT(*)` })
        .from(jobs)
        .groupBy(jobs.status),
      this.db
        .select({ status: runs.status, count: sql<number>`COUNT(*)` })
        .from(runs)
        .where(isNull(runs.deletedAt))
        .groupBy(runs.status),
      this.db
        .select({
          totalAmount: sql<string>`COALESCE(SUM(${providerCosts.amount}), 0)`,
          unreconciled: sql<number>`SUM(CASE WHEN ${providerCosts.reconciledAt} IS NULL THEN 1 ELSE 0 END)`,
        })
        .from(providerCosts),
      this.db
        .select()
        .from(providerReconciliationState)
        .where(eq(providerReconciliationState.id, "moli"))
        .limit(1),
      this.db
        .select()
        .from(workerHeartbeats)
        .orderBy(desc(workerHeartbeats.heartbeatAt))
        .limit(20),
      this.db
        .select({ count: sql<number>`COUNT(*)` })
        .from(attempts)
        .where(eq(attempts.status, "submission_unknown")),
      this.db
        .select({ count: sql<number>`COUNT(*)` })
        .from(resultMedia)
        .where(eq(resultMedia.archiveStatus, "failed")),
      this.db
        .select({
          id: jobs.id,
          type: jobs.type,
          lastErrorCode: jobs.lastErrorCode,
          lastErrorMessage: jobs.lastErrorMessage,
          updatedAt: jobs.updatedAt,
        })
        .from(jobs)
        .where(eq(jobs.status, "dead"))
        .orderBy(desc(jobs.updatedAt))
        .limit(20),
    ]);
    const [oldestReady] = await this.db
      .select({ availableAt: jobs.availableAt })
      .from(jobs)
      .where(inArray(jobs.status, ["ready", "retry_wait"]))
      .orderBy(asc(jobs.availableAt))
      .limit(1);
    const latestHeartbeatAt = heartbeats[0]?.heartbeatAt ?? null;
    const executionService = executionServiceHealth(
      latestHeartbeatAt,
      observedAt,
    );
    const latestAuthenticationFailureAt = recentDeadJobs.reduce<Date | null>(
      (latest, job) => {
        if (
          !/auth|unauthorized|401|403|token/iu.test(
            `${job.lastErrorCode ?? ""} ${job.lastErrorMessage ?? ""}`,
          )
        ) {
          return latest;
        }
        return !latest || job.updatedAt > latest ? job.updatedAt : latest;
      },
      null,
    );
    const verifiedAt = reconciliation[0]?.reconciledAt ?? null;
    return {
      jobs: Object.fromEntries(
        jobCounts.map((row) => [row.status, Number(row.count)]),
      ),
      runs: Object.fromEntries(
        runCounts.map((row) => [row.status, Number(row.count)]),
      ),
      oldestReadyAt: oldestReady?.availableAt ?? null,
      providerCost: costSummary[0] ?? { totalAmount: "0", unreconciled: 0 },
      provider: reconciliation[0] ?? null,
      workers: heartbeats,
      executionService,
      providerAuthentication: providerAuthenticationHealth(
        executionService.status,
        verifiedAt,
        latestAuthenticationFailureAt,
      ),
      submissionUnknownCount: Number(submissionUnknown[0]?.count ?? 0),
      mediaArchiveFailureCount: Number(mediaArchiveFailures[0]?.count ?? 0),
      recentDeadJobs,
    };
  }

  async listProviderCosts(limit = 100) {
    return this.db
      .select()
      .from(providerCosts)
      .orderBy(desc(providerCosts.occurredAt))
      .limit(limit);
  }

  async enqueueProviderCallback(
    providerTaskId: string,
    _callbackMetadata: Record<string, unknown>,
  ) {
    const providerTaskHash = sha256(providerTaskId);
    const [tombstone] = await this.db
      .select({ hash: providerTaskTombstones.providerTaskHash })
      .from(providerTaskTombstones)
      .where(eq(providerTaskTombstones.providerTaskHash, providerTaskHash))
      .limit(1);
    if (tombstone) return { accepted: false, discarded: true };
    const [attempt] = await this.db
      .select({ id: attempts.id })
      .from(attempts)
      .where(eq(attempts.providerTaskId, providerTaskId))
      .limit(1);
    if (!attempt) return { accepted: false, discarded: true };
    const availableAt = new Date();
    await this.db
      .insert(jobs)
      .values({
        id: randomUUID(),
        type: "poll_attempt",
        dedupeKey: pollAttemptJobDedupeKey(attempt.id),
        payload: { attemptId: attempt.id },
        availableAt,
      })
      .onDuplicateKeyUpdate({
        set: {
          status: "ready",
          availableAt,
          leaseOwner: null,
          leaseExpiresAt: null,
        },
      });
    return { accepted: true, discarded: false };
  }

  async listAudit(
    limit = 100,
    actorId?: string,
    action?: string,
    cursor?: string,
    from?: Date,
    to?: Date,
    domain?: "monitoring" | "media_publishing",
  ) {
    const conditions = [];
    if (actorId) conditions.push(eq(auditLogs.actorId, actorId));
    if (action) conditions.push(eq(auditLogs.action, action));
    if (from) conditions.push(gte(auditLogs.createdAt, from));
    if (to) conditions.push(lte(auditLogs.createdAt, to));
    const mediaPublishingDomain = or(
      like(auditLogs.action, "%publisher%"),
      like(auditLogs.targetType, "publisher%"),
      like(auditLogs.targetType, "publication%"),
      like(auditLogs.targetType, "media_publishing%"),
    );
    if (domain === "media_publishing" && mediaPublishingDomain) {
      conditions.push(mediaPublishingDomain);
    } else if (domain === "monitoring" && mediaPublishingDomain) {
      conditions.push(not(mediaPublishingDomain));
    }

    if (cursor) {
      const [cursorRow] = await this.db
        .select({ id: auditLogs.id, createdAt: auditLogs.createdAt })
        .from(auditLogs)
        .where(and(eq(auditLogs.id, cursor), ...conditions))
        .limit(1);
      if (!cursorRow) return [];

      const beforeCursor = or(
        lt(auditLogs.createdAt, cursorRow.createdAt),
        and(
          eq(auditLogs.createdAt, cursorRow.createdAt),
          lt(auditLogs.id, cursorRow.id),
        ),
      );
      if (beforeCursor) conditions.push(beforeCursor);
    }

    return this.db
      .select()
      .from(auditLogs)
      .where(conditions.length ? and(...conditions) : undefined)
      .orderBy(desc(auditLogs.createdAt), desc(auditLogs.id))
      .limit(limit);
  }

  async writeAudit(
    audit: RequestAudit,
    action: string,
    targetType: string,
    targetId: string | null,
    ownerId: string | null,
    metadata: Record<string, unknown>,
  ) {
    await this.db
      .insert(auditLogs)
      .values(
        auditValues(audit, action, targetType, targetId, ownerId, metadata),
      );
  }
}

type Transaction = Parameters<Parameters<Database["transaction"]>[0]>[0];

type ResolvedMonitoringSubject =
  { kind: "self" } | { kind: "competitor"; name: string; aliases: string[] };

type ResolvedMonitoringScope = {
  scope: MonitoringScope;
  monitor: typeof monitors.$inferSelect;
  version: typeof monitorVersions.$inferSelect;
  questions: Array<typeof monitorQuestions.$inferSelect>;
  platforms: Array<{
    monitorVersionId: string;
    ordinal: number;
    platformId: string;
    providerCode: string;
    clientType: (typeof attempts.$inferSelect)["clientType"];
    mode: (typeof attempts.$inferSelect)["mode"];
    displayName: string;
  }>;
  brand: typeof projectBrandVersions.$inferSelect;
  projectTimezone: string;
  subject: ResolvedMonitoringSubject;
};

type MonitoringFact = {
  attemptId: string;
  runId: string;
  runCreatedAt: Date;
  questionId: string;
  platformId: string;
  status: (typeof attempts.$inferSelect)["status"];
  revisionId: string | null;
  hasNonEmptyAnswer: boolean;
  sentiment: Sentiment | null;
  brandMentioned: boolean | null;
  mentionPosition: number | null;
  competitorRankings: Array<Record<string, unknown>> | null;
  monitorCompetitors: Array<{ name: string; aliases: string[] }>;
  citationProvenanceHint: CitationProvenance | null;
  hasLegacyCitationList: boolean;
  revisionCreatedAt: Date | null;
};

type MonitoringCitation = {
  id: string;
  revisionId: string;
  ordinal: number;
  providerPosition: number | null;
  url: string;
  title: string;
  domain: string;
  siteName: string | null;
  summary: string | null;
  publishedAt: string | null;
  citedText: string | null;
};

type MonitoringReference = Omit<MonitoringCitation, "citedText"> & {
  isCited: boolean;
};

type MonitoringEvidence = {
  provenanceByRevision: Map<string, CitationProvenance>;
  citationsByRevision: Map<string, MonitoringCitation[]>;
  referencesByRevision: Map<string, MonitoringReference[]>;
  screenshotCountByRevision: Map<string, number>;
};

type MonitoringSourceRow = {
  id: string;
  revisionId: string;
  ordinal: number;
  providerPosition: number | null;
  url: string;
  title: string;
  domain: string;
  citedText: string | null;
  createdAt: Date;
};

type MonitoringDiscoveredRow = {
  id: string;
  revisionId: string;
  ordinal: number;
  providerPosition: number | null;
  url: string;
  title: string;
  domain: string;
  siteName: string | null;
  summary: string | null;
  publishedAt: string | null;
  isCited: boolean;
  createdAt: Date;
};

function chunks<T>(values: readonly T[], size: number): T[][] {
  const result: T[][] = [];
  for (let index = 0; index < values.length; index += size) {
    result.push(values.slice(index, index + size));
  }
  return result;
}

function parseCitationProvenanceHint(
  value: unknown,
): CitationProvenance | null {
  return value === "explicit" ||
    value === "legacy_assumed" ||
    value === "unavailable"
    ? value
    : null;
}

function hasLegacyCitationList(payload: Record<string, unknown> | null) {
  const raw = payload?.raw;
  return (
    raw !== null &&
    typeof raw === "object" &&
    !Array.isArray(raw) &&
    Array.isArray((raw as Record<string, unknown>).citationList)
  );
}

function monitoringFactCitationProvenance(
  fact: Pick<
    MonitoringFact,
    "citationProvenanceHint" | "hasLegacyCitationList"
  >,
  hasStoredSources: boolean,
): CitationProvenance {
  if (fact.citationProvenanceHint) return fact.citationProvenanceHint;
  if (fact.hasLegacyCitationList) return "explicit";
  return hasStoredSources ? "legacy_assumed" : "unavailable";
}

function monitoringFactConditions(ownerId: string, scope: MonitoringScope) {
  const conditions = [
    eq(attempts.ownerId, ownerId),
    monitoringChildOwnerPredicate(runs, ownerId),
    eq(runs.monitorId, scope.monitorId),
    isNull(runs.deletedAt),
    gte(runs.createdAt, scope.from),
    lt(runs.createdAt, scope.to),
    sql`EXISTS (SELECT 1 FROM projects p WHERE p.id = ${runs.projectId} AND p.owner_id = ${ownerId} AND p.deleted_at IS NULL)`,
  ];
  if (scope.questionId) {
    conditions.push(eq(monitorQuestions.questionId, scope.questionId));
  }
  if (scope.platformId) {
    conditions.push(eq(attempts.platformId, scope.platformId));
  }
  return conditions;
}

function monitoringScopeFingerprint(scope: MonitoringScope) {
  return sha256(
    stableJson({
      monitorId: scope.monitorId,
      from: scope.from.toISOString(),
      to: scope.to.toISOString(),
      questionId: scope.questionId ?? null,
      platformId: scope.platformId ?? null,
      subject:
        scope.subject.kind === "self"
          ? { kind: "self" }
          : { kind: "competitor", name: scope.subject.name },
    }),
  );
}

export function encodeMonitoringAnswerCursor(
  scope: MonitoringScope,
  runCreatedAt: Date,
  attemptId: string,
) {
  return Buffer.from(
    JSON.stringify({
      version: 1,
      scope: monitoringScopeFingerprint(scope),
      runCreatedAt: runCreatedAt.toISOString(),
      attemptId,
    }),
    "utf8",
  ).toString("base64url");
}

export function decodeMonitoringAnswerCursor(
  value: string,
  scope: MonitoringScope,
) {
  try {
    const parsed = JSON.parse(
      Buffer.from(value, "base64url").toString("utf8"),
    ) as Record<string, unknown>;
    if (
      parsed.version !== 1 ||
      parsed.scope !== monitoringScopeFingerprint(scope) ||
      typeof parsed.runCreatedAt !== "string" ||
      typeof parsed.attemptId !== "string" ||
      !isUuid(parsed.attemptId)
    ) {
      throw new Error("cursor fields are invalid");
    }
    const runCreatedAt = new Date(parsed.runCreatedAt);
    if (
      !Number.isFinite(runCreatedAt.getTime()) ||
      runCreatedAt.toISOString() !== parsed.runCreatedAt
    ) {
      throw new Error("cursor timestamp is invalid");
    }
    return { runCreatedAt, attemptId: parsed.attemptId };
  } catch {
    throw new RepositoryError(
      "INVALID_STATE",
      "Invalid monitoring answer cursor",
    );
  }
}

function isUuid(value: string) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(
    value,
  );
}

function monitoringListRowAsFact(row: {
  answerId: string;
  runId: string;
  runCreatedAt: Date;
  questionId: string;
  platformId: string;
  status: MonitoringFact["status"];
  currentRevisionId: string | null;
  hasNonEmptyAnswer: number | boolean;
  sentiment: Sentiment | null;
  brandMentioned: boolean | null;
  mentionPosition: number | null;
  competitorRankings: Array<Record<string, unknown>> | null;
  monitorCompetitors: Array<{ name: string; aliases: string[] }>;
  normalizedPayload: Record<string, unknown> | null;
  revisionCreatedAt: Date | null;
}): MonitoringFact {
  return {
    attemptId: row.answerId,
    runId: row.runId,
    runCreatedAt: row.runCreatedAt,
    questionId: row.questionId,
    platformId: row.platformId,
    status: row.status,
    revisionId: row.currentRevisionId,
    hasNonEmptyAnswer:
      row.hasNonEmptyAnswer === true || Number(row.hasNonEmptyAnswer) === 1,
    sentiment: row.sentiment,
    brandMentioned: row.brandMentioned,
    mentionPosition: row.mentionPosition,
    competitorRankings: row.competitorRankings,
    monitorCompetitors: row.monitorCompetitors,
    citationProvenanceHint: parseCitationProvenanceHint(
      row.normalizedPayload?.citationProvenance,
    ),
    hasLegacyCitationList: hasLegacyCitationList(row.normalizedPayload),
    revisionCreatedAt: row.revisionCreatedAt,
  };
}

function monitoringDetailRowAsFact(
  row: Omit<
    Parameters<typeof monitoringListRowAsFact>[0],
    "hasNonEmptyAnswer" | "monitorCompetitors"
  > & {
    answerMarkdown: string;
  },
  monitorCompetitors: Array<{ name: string; aliases: string[] }>,
) {
  return monitoringListRowAsFact({
    ...row,
    monitorCompetitors,
    hasNonEmptyAnswer: row.answerMarkdown.trim().length > 0,
  });
}

function emptyMonitoringEvidence(): MonitoringEvidence {
  return {
    provenanceByRevision: new Map(),
    citationsByRevision: new Map(),
    referencesByRevision: new Map(),
    screenshotCountByRevision: new Map(),
  };
}

function groupByRevision<T extends { revisionId: string }>(rows: readonly T[]) {
  const grouped = new Map<string, T[]>();
  for (const row of rows) {
    const group = grouped.get(row.revisionId) ?? [];
    group.push(row);
    grouped.set(row.revisionId, group);
  }
  return grouped;
}

function buildMonitoringEvidence(
  facts: readonly MonitoringFact[],
  sourceRows: readonly MonitoringSourceRow[],
  discoveredRows: readonly MonitoringDiscoveredRow[],
  screenshotRows: ReadonlyArray<{ revisionId: string }>,
  legacyDiscoveryPayloadByRevision: ReadonlyMap<
    string,
    Record<string, unknown>
  > = new Map(),
  evidenceRowLimit = MONITORING_EVIDENCE_ROW_LIMIT,
): MonitoringEvidence {
  let evidenceRowCount =
    sourceRows.length + discoveredRows.length + screenshotRows.length;
  if (evidenceRowCount > evidenceRowLimit) {
    throw new RepositoryError(
      "INVALID_STATE",
      `Monitoring scope exceeds the ${evidenceRowLimit.toLocaleString("en-US")} evidence row limit; narrow the date or dimension filters`,
    );
  }
  const evidence = emptyMonitoringEvidence();
  const sourcesByRevision = groupByRevision(sourceRows);
  const persistedReferencesByRevision = groupByRevision(discoveredRows);
  for (const screenshot of screenshotRows) {
    evidence.screenshotCountByRevision.set(
      screenshot.revisionId,
      (evidence.screenshotCountByRevision.get(screenshot.revisionId) ?? 0) + 1,
    );
  }
  for (const fact of facts) {
    if (!fact.revisionId) continue;
    const revisionId = fact.revisionId;
    const sources = sourcesByRevision.get(revisionId) ?? [];
    const provenance = monitoringFactCitationProvenance(
      fact,
      sources.length > 0,
    );
    evidence.provenanceByRevision.set(revisionId, provenance);
    let references = persistedReferencesByRevision.get(revisionId) ?? [];
    if (references.length === 0) {
      references = discoveredSourcesFromNormalizedPayload({
        revisionId,
        payload: legacyDiscoveryPayloadByRevision.get(revisionId) ?? null,
        citationProvenance: provenance,
        createdAt: fact.revisionCreatedAt ?? fact.runCreatedAt,
      }).map((source) => ({
        id: source.id,
        revisionId: source.revisionId,
        ordinal: source.ordinal,
        providerPosition: source.providerPosition,
        url: source.url,
        title: source.title,
        domain: source.domain,
        siteName: source.siteName,
        summary: source.summary,
        publishedAt: source.publishedAt,
        isCited: source.isCited,
        createdAt: source.createdAt,
      }));
      evidenceRowCount += references.length;
      if (evidenceRowCount > evidenceRowLimit) {
        throw new RepositoryError(
          "INVALID_STATE",
          `Monitoring scope exceeds the ${evidenceRowLimit.toLocaleString("en-US")} evidence row limit; narrow the date or dimension filters`,
        );
      }
    }
    const referencesByUrl = new Map(
      references.map((source) => [canonicalUrl(source.url), source]),
    );
    // Very old rows may have neither persisted discovery rows nor a normalized
    // reference list. Preserve them as unverified discoveries, never citations.
    for (const source of sources) {
      const key = canonicalUrl(source.url);
      if (!referencesByUrl.has(key)) {
        referencesByUrl.set(key, {
          id: source.id,
          revisionId,
          ordinal: source.ordinal,
          providerPosition: source.providerPosition,
          url: source.url,
          title: source.title,
          domain: source.domain,
          siteName: null,
          summary: null,
          publishedAt: null,
          isCited: false,
          createdAt: source.createdAt,
        });
      }
    }
    const explicitUrls = new Set(
      provenance === "explicit"
        ? sources.map((source) => canonicalUrl(source.url))
        : [],
    );
    const safeReferences = [...referencesByUrl.values()]
      .sort((left, right) => left.ordinal - right.ordinal)
      .map((source): MonitoringReference => ({
        id: source.id,
        revisionId,
        ordinal: source.ordinal,
        providerPosition: source.providerPosition,
        url: source.url,
        title: source.title,
        domain: source.domain,
        siteName: source.siteName,
        summary: source.summary,
        publishedAt: source.publishedAt,
        isCited:
          provenance === "explicit" &&
          (source.isCited || explicitUrls.has(canonicalUrl(source.url))),
      }));
    evidence.referencesByRevision.set(revisionId, safeReferences);
    evidence.citationsByRevision.set(
      revisionId,
      provenance === "explicit"
        ? sources.map((source): MonitoringCitation => {
            const discovered = referencesByUrl.get(canonicalUrl(source.url));
            return {
              id: source.id,
              revisionId,
              ordinal: source.ordinal,
              providerPosition:
                source.providerPosition ?? discovered?.providerPosition ?? null,
              url: source.url,
              title: source.title || discovered?.title || "",
              domain: discovered?.domain || source.domain,
              siteName: discovered?.siteName ?? null,
              summary: discovered?.summary ?? null,
              publishedAt: discovered?.publishedAt ?? null,
              citedText: source.citedText,
            };
          })
        : [],
    );
  }
  return evidence;
}

function monitoringMetrics(
  facts: readonly MonitoringFact[],
  evidence: MonitoringEvidence,
  subject: ResolvedMonitoringSubject,
) {
  const answers = facts.filter(isEffectiveMonitoringAnswer);
  const contributions = answers.map((fact) =>
    monitoringSubjectContribution(fact, subject),
  );
  const mentionedAnswers = contributions.filter(
    (contribution) => contribution.mentioned,
  ).length;
  const positions = contributions.flatMap((contribution) =>
    contribution.position === null ? [] : [contribution.position],
  );
  let citationCount = 0;
  let discoveredSourceCount = 0;
  const domains = new Set<string>();
  for (const fact of answers) {
    const revisionId = fact.revisionId!;
    citationCount += evidence.citationsByRevision.get(revisionId)?.length ?? 0;
    const references = evidence.referencesByRevision.get(revisionId) ?? [];
    discoveredSourceCount += references.length;
    for (const reference of references) domains.add(reference.domain);
  }
  const sentiments =
    subject.kind === "self"
      ? {
          positive: answers.filter((fact) => fact.sentiment === "positive")
            .length,
          neutral: answers.filter((fact) => fact.sentiment === "neutral")
            .length,
          negative: answers.filter((fact) => fact.sentiment === "negative")
            .length,
          unknown: answers.filter((fact) => fact.sentiment === "unknown")
            .length,
        }
      : null;
  const positionRates = monitoringPositionRates(positions, answers.length);
  return {
    runs: new Set(facts.map((fact) => fact.runId)).size,
    attempts: facts.length,
    answers: answers.length,
    mentionedAnswers,
    mentionRate:
      answers.length === 0 ? null : mentionedAnswers / answers.length,
    averagePosition:
      positions.length === 0
        ? null
        : positions.reduce((sum, position) => sum + position, 0) /
          positions.length,
    ...positionRates,
    citationCount,
    discoveredSourceCount,
    uniqueDomainCount: domains.size,
    sentiments,
  };
}

export function monitoringPositionRates(
  positions: readonly number[],
  effectiveAnswerCount: number,
) {
  if (effectiveAnswerCount === 0) {
    return { top1Rate: null, top3Rate: null, top10Rate: null };
  }
  return {
    top1Rate:
      positions.filter((position) => position <= 1).length /
      effectiveAnswerCount,
    top3Rate:
      positions.filter((position) => position <= 3).length /
      effectiveAnswerCount,
    top10Rate:
      positions.filter((position) => position <= 10).length /
      effectiveAnswerCount,
  };
}

/** A revision alone is not an effective answer: only completed, non-empty
 * authoritative results may enter customer metrics or their denominators. */
export function isEffectiveMonitoringAnswer(
  fact: Pick<MonitoringFact, "status" | "revisionId" | "hasNonEmptyAnswer">,
) {
  return (
    fact.status === "completed" &&
    fact.revisionId !== null &&
    fact.hasNonEmptyAnswer
  );
}

export function buildMonitoringAnalysis(
  kind: MonitoringAnalysisInput["kind"],
  facts: readonly MonitoringFact[],
  evidence: MonitoringEvidence,
  resolved: ResolvedMonitoringScope,
) {
  if (kind === "metrics") {
    const questions = resolved.scope.questionId
      ? resolved.questions.filter(
          (question) => question.questionId === resolved.scope.questionId,
        )
      : resolved.questions;
    return {
      kind: "metrics" as const,
      metrics: monitoringMetrics(facts, evidence, resolved.subject),
      rows: questions.map((question) => ({
        questionId: question.questionId,
        question: question.questionSnapshot,
        ordinal: question.ordinal,
        metrics: monitoringMetrics(
          facts.filter((fact) => fact.questionId === question.questionId),
          evidence,
          resolved.subject,
        ),
      })),
    };
  }
  if (kind === "trends") {
    const grouped = new Map<string, MonitoringFact[]>();
    for (const fact of facts) {
      const date = monitoringLocalDate(
        fact.runCreatedAt,
        resolved.projectTimezone,
      );
      const group = grouped.get(date) ?? [];
      group.push(fact);
      grouped.set(date, group);
    }
    return {
      kind: "trends" as const,
      granularity: "day" as const,
      points: [...grouped.entries()]
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([date, dayFacts]) => ({
          date,
          metrics: monitoringMetrics(dayFacts, evidence, resolved.subject),
        })),
    };
  }
  if (kind === "competitors") {
    return {
      kind: "competitors" as const,
      items: monitoringCompetitorAnalysisItems(
        facts,
        resolved.version.competitors,
      ),
    };
  }
  if (kind === "citations") {
    const domains = new Map<string, number>();
    let total = 0;
    const contents = new Map<
      string,
      { title: string; url: string; domain: string; count: number }
    >();
    for (const fact of facts.filter(isEffectiveMonitoringAnswer)) {
      if (!fact.revisionId) continue;
      for (const source of evidence.citationsByRevision.get(fact.revisionId) ??
        []) {
        total += 1;
        domains.set(source.domain, (domains.get(source.domain) ?? 0) + 1);
        const key = canonicalUrl(source.url);
        const content = contents.get(key) ?? {
          title: source.title,
          url: source.url,
          domain: source.domain,
          count: 0,
        };
        content.count += 1;
        contents.set(key, content);
      }
    }
    return {
      kind: "citations" as const,
      total,
      items: [...domains.entries()]
        .map(([domain, count]) => ({ domain, count }))
        .sort(
          (left, right) =>
            right.count - left.count || left.domain.localeCompare(right.domain),
        )
        .slice(0, 100),
      contents: [...contents.values()]
        .sort(
          (left, right) =>
            right.count - left.count || left.url.localeCompare(right.url),
        )
        .slice(0, 100),
    };
  }
  const domains = new Map<
    string,
    { discoveredCount: number; citedCount: number }
  >();
  let total = 0;
  let cited = 0;
  const publicationCounts = new Map<
    PublicationTimeBucket,
    { discoveredCount: number; citedCount: number }
  >();
  for (const fact of facts.filter(isEffectiveMonitoringAnswer)) {
    if (!fact.revisionId) continue;
    for (const source of evidence.referencesByRevision.get(fact.revisionId) ??
      []) {
      total += 1;
      const isCited =
        evidence.provenanceByRevision.get(fact.revisionId) === "explicit" &&
        source.isCited;
      cited += Number(isCited);
      const metric = domains.get(source.domain) ?? {
        discoveredCount: 0,
        citedCount: 0,
      };
      metric.discoveredCount += 1;
      metric.citedCount += Number(isCited);
      domains.set(source.domain, metric);
      const bucket = publicationTimeBucket(
        source.publishedAt,
        resolved.scope.to,
        resolved.projectTimezone,
      );
      const publicationMetric = publicationCounts.get(bucket) ?? {
        discoveredCount: 0,
        citedCount: 0,
      };
      publicationMetric.discoveredCount += 1;
      publicationMetric.citedCount += Number(isCited);
      publicationCounts.set(bucket, publicationMetric);
    }
  }
  return {
    kind: "sources" as const,
    total,
    cited,
    publicationTimeBuckets: publicationTimeBuckets.map((bucket) => ({
      bucket,
      discoveredCount: publicationCounts.get(bucket)?.discoveredCount ?? 0,
      citedCount: publicationCounts.get(bucket)?.citedCount ?? 0,
    })),
    items: [...domains.entries()]
      .map(([domain, metric]) => ({ domain, ...metric }))
      .sort(
        (left, right) =>
          right.discoveredCount - left.discoveredCount ||
          left.domain.localeCompare(right.domain),
      )
      .slice(0, 100),
  };
}

function monitoringSubjectContribution(
  fact: MonitoringFact,
  subject: ResolvedMonitoringSubject,
) {
  if (subject.kind === "self") {
    return {
      mentioned: fact.brandMentioned ?? false,
      position: monitoringMentionPosition(
        fact.brandMentioned,
        fact.mentionPosition,
      ),
    };
  }
  const currentNames = new Set(
    [subject.name, ...subject.aliases].map(normalizedBrandName),
  );
  const historicalSubject = fact.monitorCompetitors.find((competitor) =>
    [competitor.name, ...competitor.aliases]
      .map(normalizedBrandName)
      .some((name) => currentNames.has(name)),
  );
  if (!historicalSubject) return { mentioned: false, position: null };
  const names = new Set(
    [historicalSubject.name, ...historicalSubject.aliases].map(
      normalizedBrandName,
    ),
  );
  const matches = safeRankingEntries(fact.competitorRankings).filter((entry) =>
    names.has(normalizedBrandName(entry.name)),
  );
  const positions = matches.flatMap((entry) =>
    !entry.mentioned || entry.position === null ? [] : [entry.position],
  );
  return {
    mentioned: matches.some((entry) => entry.mentioned),
    position: positions.length === 0 ? null : Math.min(...positions),
  };
}

/**
 * Parse and normalize each fact's historical competitor snapshot and ranking
 * entries once. The previous implementation repeated both operations for each
 * current competitor, which made a 50-competitor analysis proportional to
 * competitors × facts × ranking entries.
 */
function monitoringCompetitorAnalysisItems(
  facts: readonly MonitoringFact[],
  competitors: ReadonlyArray<{ name: string; aliases: string[] }>,
) {
  const effectiveAnswers = facts.filter(isEffectiveMonitoringAnswer);
  const answerCount = effectiveAnswers.length;
  const aggregates = competitors.map((competitor) => ({
    name: competitor.name,
    appearances: 0,
    positions: [] as number[],
  }));
  const currentIndexesByName = new Map<string, Set<number>>();
  competitors.forEach((competitor, index) => {
    for (const name of new Set(
      [competitor.name, ...competitor.aliases].map(normalizedBrandName),
    )) {
      const indexes = currentIndexesByName.get(name) ?? new Set<number>();
      indexes.add(index);
      currentIndexesByName.set(name, indexes);
    }
  });

  for (const fact of effectiveAnswers) {
    // Preserve the old `.find()` semantics: if multiple immutable historical
    // competitors overlap a current alias, the first snapshot entry wins.
    const historicalNamesByCurrentIndex = new Map<number, Set<string>>();
    for (const historical of fact.monitorCompetitors) {
      const historicalNames = new Set(
        [historical.name, ...historical.aliases].map(normalizedBrandName),
      );
      const matchingCurrentIndexes = new Set<number>();
      for (const name of historicalNames) {
        for (const index of currentIndexesByName.get(name) ?? []) {
          matchingCurrentIndexes.add(index);
        }
      }
      for (const index of matchingCurrentIndexes) {
        if (!historicalNamesByCurrentIndex.has(index)) {
          historicalNamesByCurrentIndex.set(index, historicalNames);
        }
      }
    }

    const rankingsByName = new Map<
      string,
      Array<{ mentioned: boolean; position: number | null }>
    >();
    for (const entry of safeRankingEntries(fact.competitorRankings)) {
      const name = normalizedBrandName(entry.name);
      const rankings = rankingsByName.get(name) ?? [];
      rankings.push({ mentioned: entry.mentioned, position: entry.position });
      rankingsByName.set(name, rankings);
    }

    for (const [index, historicalNames] of historicalNamesByCurrentIndex) {
      let mentioned = false;
      let position: number | null = null;
      for (const name of historicalNames) {
        for (const entry of rankingsByName.get(name) ?? []) {
          if (!entry.mentioned) continue;
          mentioned = true;
          if (
            entry.position !== null &&
            (position === null || entry.position < position)
          ) {
            position = entry.position;
          }
        }
      }
      if (mentioned) aggregates[index]!.appearances += 1;
      if (position !== null) aggregates[index]!.positions.push(position);
    }
  }

  return aggregates.map((aggregate) => ({
    name: aggregate.name,
    appearances: aggregate.appearances,
    answerCount,
    mentionRate: answerCount === 0 ? null : aggregate.appearances / answerCount,
    averagePosition:
      aggregate.positions.length === 0
        ? null
        : aggregate.positions.reduce((sum, value) => sum + value, 0) /
          aggregate.positions.length,
    highPositionExposure: monitoringPositionRates(
      aggregate.positions,
      answerCount,
    ).top3Rate,
  }));
}

export function monitoringMentionPosition(
  mentioned: boolean | null | undefined,
  position: number | null,
) {
  return mentioned === true ? position : null;
}

function normalizedMonitoringRankings(input: {
  mainBrand: string;
  competitors: Array<{ name: string; aliases: string[] }>;
  brandMentioned: boolean;
  mentionPosition: number | null;
  competitorRankings: Array<Record<string, unknown>>;
}) {
  const fact = {
    brandMentioned: input.brandMentioned,
    mentionPosition: input.mentionPosition,
    competitorRankings: input.competitorRankings,
    monitorCompetitors: input.competitors,
  } as MonitoringFact;
  return [
    {
      subject: { kind: "self" as const, name: input.mainBrand },
      mentioned: input.brandMentioned,
      position: monitoringMentionPosition(
        input.brandMentioned,
        input.mentionPosition,
      ),
    },
    ...input.competitors.map((competitor) => ({
      subject: { kind: "competitor" as const, name: competitor.name },
      ...monitoringSubjectContribution(fact, {
        kind: "competitor",
        name: competitor.name,
        aliases: competitor.aliases,
      }),
    })),
  ];
}

function safeRankingEntries(value: unknown) {
  if (!Array.isArray(value)) return [];
  return value.slice(0, 100).flatMap((entry) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) return [];
    const record = entry as Record<string, unknown>;
    const nestedSubject =
      record.subject &&
      typeof record.subject === "object" &&
      !Array.isArray(record.subject)
        ? (record.subject as Record<string, unknown>)
        : null;
    const name = firstString(
      record.name,
      record.brand,
      record.brandName,
      record.competitorName,
      record.keyword,
      nestedSubject?.name,
    );
    if (!name) return [];
    const rawPosition = firstNumber(
      record.position,
      record.rank,
      record.ranking,
    );
    const position =
      rawPosition !== undefined &&
      Number.isInteger(rawPosition) &&
      rawPosition > 0
        ? rawPosition
        : null;
    const explicitlyMentioned = firstBoolean(
      record.mentioned,
      record.isMentioned,
      record.brandMentioned,
    );
    const mentioned = explicitlyMentioned ?? position !== null;
    return [
      {
        name,
        mentioned,
        position: mentioned ? position : null,
      },
    ];
  });
}

function normalizedBrandName(value: string) {
  return value.normalize("NFKC").trim().toLocaleLowerCase();
}

const publicationTimeBuckets = [
  "last_7_days",
  "last_30_days",
  "last_90_days",
  "older",
  "unknown",
] as const;
type PublicationTimeBucket = (typeof publicationTimeBuckets)[number];

export function publicationTimeBucket(
  publishedAt: string | null,
  rangeEnd: Date,
  timezone = "UTC",
): PublicationTimeBucket {
  if (!publishedAt || !/^\d{4}-\d{2}-\d{2}$/u.test(publishedAt)) {
    return "unknown";
  }
  const published = new Date(`${publishedAt}T00:00:00.000Z`);
  const localRangeEnd = new Date(
    `${monitoringLocalDate(rangeEnd, timezone)}T00:00:00.000Z`,
  );
  if (
    !Number.isFinite(published.getTime()) ||
    !Number.isFinite(localRangeEnd.getTime()) ||
    published > localRangeEnd
  ) {
    return "unknown";
  }
  const ageDays = Math.floor(
    (localRangeEnd.getTime() - published.getTime()) / 86_400_000,
  );
  if (ageDays <= 7) return "last_7_days";
  if (ageDays <= 30) return "last_30_days";
  if (ageDays <= 90) return "last_90_days";
  return "older";
}

function monitoringLocalDate(value: Date, timezone: string) {
  const parts = zonedParts(value, timezone);
  return `${String(parts.year).padStart(4, "0")}-${String(parts.month).padStart(2, "0")}-${String(parts.day).padStart(2, "0")}`;
}

function exactMoney(value: string | bigint): bigint {
  if (typeof value === "bigint") return value;
  if (!/^-?(?:0|[1-9]\d*)$/u.test(value))
    throw new RepositoryError(
      "INVALID_STATE",
      "Money amount must be an integer string",
    );
  return BigInt(value);
}

function assertTopupAmount(amount: bigint) {
  if (amount < 100_000n || amount > 500_000_000n || amount % 100n !== 0n) {
    throw new RepositoryError(
      "INVALID_STATE",
      "Top-up amount must be between CNY 10 and CNY 50,000 in whole fen",
    );
  }
}

function assertTopupOrderIdentity(input: {
  providerOrderId: string;
  idempotencyKey: string;
  callbackTokenDigest: string;
  checkoutExpiresAt: Date;
}) {
  if (!/^[1-9]\d{0,31}$/u.test(input.providerOrderId))
    throw new RepositoryError("INVALID_STATE", "Invalid provider order ID");
  if (
    input.idempotencyKey.length < 8 ||
    input.idempotencyKey.length > 128 ||
    input.idempotencyKey.trim() !== input.idempotencyKey
  )
    throw new RepositoryError("INVALID_STATE", "Invalid idempotency key");
  if (!/^[a-f0-9]{64}$/u.test(input.callbackTokenDigest))
    throw new RepositoryError("INVALID_STATE", "Invalid callback digest");
  if (!Number.isFinite(input.checkoutExpiresAt.getTime()))
    throw new RepositoryError("INVALID_STATE", "Invalid checkout expiry");
}

function billingSummary(wallet: {
  userId: string;
  balanceTenThousandths: bigint;
  reservedTenThousandths: bigint;
  spentTenThousandths: bigint;
  frozenTenThousandths: bigint;
}) {
  return {
    userId: wallet.userId,
    currency: MONEY_CURRENCY,
    scale: 4 as const,
    accountingMode: "unified" as const,
    frozenTenThousandths: moneyToApiString(wallet.frozenTenThousandths),
    balanceTenThousandths: moneyToApiString(wallet.balanceTenThousandths),
    reservedTenThousandths: moneyToApiString(wallet.reservedTenThousandths),
    spentTenThousandths: moneyToApiString(wallet.spentTenThousandths),
    availableTenThousandths: moneyToApiString(
      wallet.balanceTenThousandths - wallet.reservedTenThousandths - wallet.frozenTenThousandths,
    ),
  };
}

function pricingDimensionsKey(input: {
  pricingClass: "domestic" | "overseas";
  mode: "search" | "reasoning_search";
  screenshotEnabled: boolean;
}) {
  return `${input.pricingClass}:${input.mode}:${input.screenshotEnabled ? 1 : 0}`;
}

async function lockMoneyWallet(tx: Transaction, userId: string) {
  const [wallet] = await tx
    .select()
    .from(moneyWallets)
    .where(eq(moneyWallets.userId, userId))
    .for("update")
    .limit(1);
  if (!wallet) throw new RepositoryError("NOT_FOUND", "Money wallet not found");
  return wallet;
}

async function insertMoneyLedger(
  tx: Transaction,
  input: {
    userId: string;
    type: (typeof moneyLedger.$inferInsert)["type"];
    balanceDelta: bigint;
    reservedDelta: bigint;
    nextBalance: bigint;
    nextReserved: bigint;
    idempotencyKey: string;
    reason: string;
    reservationId?: string;
    attemptId?: string;
    actorId?: string | null;
    referenceType?: string;
    referenceId?: string;
    metadata?: Record<string, unknown>;
  },
) {
  await tx.insert(moneyLedger).values({
    id: randomUUID(),
    userId: input.userId,
    type: input.type,
    balanceDeltaTenThousandths: input.balanceDelta,
    reservedDeltaTenThousandths: input.reservedDelta,
    balanceAfterTenThousandths: input.nextBalance,
    reservedAfterTenThousandths: input.nextReserved,
    idempotencyKey: input.idempotencyKey,
    reservationId: input.reservationId,
    attemptId: input.attemptId,
    actorId: input.actorId,
    referenceType: input.referenceType,
    referenceId: input.referenceId,
    reason: input.reason,
    metadata: input.metadata,
  });
}

function publicMoneyLedgerEntry(entry: typeof moneyLedger.$inferSelect) {
  return {
    id: entry.id,
    type: entry.type,
    balanceDeltaTenThousandths: moneyToApiString(
      entry.balanceDeltaTenThousandths,
    ),
    reservedDeltaTenThousandths: moneyToApiString(
      entry.reservedDeltaTenThousandths,
    ),
    balanceAfterTenThousandths: moneyToApiString(
      entry.balanceAfterTenThousandths,
    ),
    reservedAfterTenThousandths: moneyToApiString(
      entry.reservedAfterTenThousandths,
    ),
    reason: entry.reason,
    referenceType: entry.referenceType,
    referenceId: entry.referenceId,
    createdAt: entry.createdAt,
  };
}

function publicTopupOrder(order: typeof topupOrders.$inferSelect) {
  return {
    id: order.id,
    providerOrderId: order.providerOrderId,
    paymentMethod: order.paymentMethod,
    amountTenThousandths: moneyToApiString(order.amountTenThousandths),
    currency: MONEY_CURRENCY,
    scale: 4 as const,
    state: order.state,
    checkoutExpiresAt: order.checkoutExpiresAt,
    paidAt: order.paidAt,
    creditedAt: order.creditedAt,
    createdAt: order.createdAt,
  };
}

async function creditTopupOrder(
  tx: Transaction,
  order: typeof topupOrders.$inferSelect,
  receiptId: string,
  paidAt: Date,
) {
  await tx.update(paymentReceiptClaims).set({ status: "credited", completedAt: paidAt })
    .where(eq(paymentReceiptClaims.providerOrderId, order.providerOrderId));
  const wallet = await lockMoneyWallet(tx, order.userId);
  const nextBalance = wallet.balanceTenThousandths + order.amountTenThousandths;
  await tx
    .update(moneyWallets)
    .set({ balanceTenThousandths: nextBalance })
    .where(eq(moneyWallets.userId, order.userId));
  await insertMoneyLedger(tx, {
    userId: order.userId,
    type: "topup",
    balanceDelta: order.amountTenThousandths,
    reservedDelta: 0n,
    nextBalance,
    nextReserved: wallet.reservedTenThousandths,
    idempotencyKey: `topup:${order.id}`,
    reason: "Top-up payment credited",
    referenceType: "topup_order",
    referenceId: order.id,
    metadata: { receiptId },
  });
  await tx
    .update(topupOrders)
    .set({ state: "credited", paidAt, creditedAt: paidAt })
    .where(eq(topupOrders.id, order.id));
}

async function findRunByIdempotencyKey(
  tx: Transaction,
  ownerId: string,
  idempotencyKey: string,
  forUpdate = false,
) {
  const condition = and(
    monitoringChildOwnerPredicate(runs, ownerId),
    eq(runs.idempotencyKey, idempotencyKey),
  );
  if (forUpdate) {
    const [run] = await tx
      .select()
      .from(runs)
      .where(condition)
      .for("update")
      .limit(1);
    return run ?? null;
  }
  const [run] = await tx.select().from(runs).where(condition).limit(1);
  return run ?? null;
}

async function insertVersionChildren(
  tx: Transaction,
  projectId: string,
  ownerId: string,
  versionId: string,
  configuration: MonitorConfiguration,
) {
  for (const [ordinal, question] of configuration.questions.entries()) {
    const normalizedHash = sha256(question.trim());
    let [row] = await tx
      .select()
      .from(projectQuestions)
      .where(
        and(
          eq(projectQuestions.projectId, projectId),
          eq(projectQuestions.normalizedHash, normalizedHash),
        ),
      )
      .limit(1);
    if (!row) {
      const questionId = randomUUID();
      await tx.insert(projectQuestions).values({
        id: questionId,
        projectId,
        normalizedHash,
        question,
        createdBy: ownerId,
      });
      [row] = await tx
        .select()
        .from(projectQuestions)
        .where(eq(projectQuestions.id, questionId))
        .limit(1);
    }
    if (!row)
      throw new RepositoryError("INVALID_STATE", "Question creation failed");
    await tx.insert(monitorQuestions).values({
      monitorVersionId: versionId,
      ordinal,
      questionId: row.id,
      questionSnapshot: question,
    });
  }
  await tx.insert(monitorPlatforms).values(
    configuration.platforms.map((platform, ordinal) => ({
      monitorVersionId: versionId,
      ordinal,
      platformId: platform.platformId,
      providerCodeSnapshot: platform.providerCode,
      clientType: platform.clientType,
      mode: platform.mode,
      screenshot: platform.screenshot,
      regionCode: platform.clientType === "mobile" ? null : platform.regionCode,
    })),
  );
}

async function validatePlatforms(
  tx: Transaction,
  configuration: Pick<MonitorConfiguration, "platforms">,
  options?: {
    acceptanceProbeFingerprints: ReadonlyMap<string, string>;
  },
) {
  const ids = configuration.platforms.map((platform) => platform.platformId);
  const regionCodes = uniqueTrimmed(
    configuration.platforms.flatMap((platform) =>
      platform.regionCode ? [platform.regionCode] : [],
    ),
  );
  const [rows, regionRows, acceptanceRows] = await Promise.all([
    tx.select().from(platformCatalog).where(inArray(platformCatalog.id, ids)),
    regionCodes.length > 0
      ? tx
          .select()
          .from(providerRegions)
          .where(inArray(providerRegions.code, regionCodes))
      : Promise.resolve([]),
    tx
      .select({
        platformId: platformAcceptanceChecks.platformId,
        platformFingerprint: platformAcceptanceChecks.platformFingerprint,
        dimension: platformAcceptanceChecks.dimension,
      })
      .from(platformAcceptanceChecks)
      .where(
        and(
          inArray(platformAcceptanceChecks.platformId, ids),
          eq(platformAcceptanceChecks.status, "passed"),
        ),
      ),
  ]);
  const byId = new Map(rows.map((row) => [row.id, row]));
  const regionScopes = new Map<string, Set<"domestic" | "overseas">>();
  for (const region of regionRows) {
    const scopes =
      regionScopes.get(region.code) ?? new Set<"domestic" | "overseas">();
    scopes.add(region.scope);
    regionScopes.set(region.code, scopes);
  }
  for (const selected of configuration.platforms) {
    const platform = byId.get(selected.platformId);
    const acceptanceProbeFingerprint = options
      ? options.acceptanceProbeFingerprints.get(selected.platformId)
      : undefined;
    const blocker = currentPlatformSelectionBlocker({
      platform,
      selection: selected,
      acceptanceEvidence: acceptanceRows,
      regionScopes: selected.regionCode
        ? regionScopes.get(selected.regionCode)
        : undefined,
      ...(options ? { acceptanceProbeFingerprint } : {}),
    });
    if (blocker) throw new RepositoryError("INVALID_STATE", blocker);
  }
}

type CurrentPlatform = Pick<
  typeof platformCatalog.$inferSelect,
  | "id"
  | "providerCode"
  | "displayName"
  | "clientType"
  | "enabled"
  | "verified"
  | "supportsReasoning"
  | "supportsScreenshot"
  | "supportsDomesticRegion"
  | "supportsOverseasRegion"
  | "acceptanceRequired"
  | "acceptanceFingerprint"
  | "providerMetadata"
>;

type CurrentPlatformSelection = MonitorConfiguration["platforms"][number];

type CurrentPlatformAcceptanceEvidence = {
  platformId: string;
  platformFingerprint: string;
  dimension: PlatformAcceptanceDimension;
};

/**
 * One fail-closed gate shared by monitor saves, quotes, and every new run.
 * Acceptance probes use a narrowly scoped fingerprint bypass because their
 * purpose is to generate the evidence that ordinary customer runs require.
 */
export function currentPlatformSelectionBlocker(input: {
  platform: CurrentPlatform | undefined;
  selection: CurrentPlatformSelection;
  acceptanceEvidence: readonly CurrentPlatformAcceptanceEvidence[];
  regionScopes?: ReadonlySet<"domestic" | "overseas">;
  acceptanceProbeFingerprint?: string;
}): string | null {
  const { platform, selection } = input;
  if (!platform) {
    return `Platform ${selection.providerCode} is not available`;
  }
  if (
    platform.providerCode !== selection.providerCode ||
    platform.clientType !== selection.clientType
  ) {
    return `Platform ${selection.providerCode} does not match the catalog`;
  }
  if (selection.clientType === "mobile" && selection.regionCode !== null) {
    return "Mobile platforms cannot use a region override";
  }
  const regionResolution = selection.regionCode
    ? singleRegionScope(selection.regionCode, input.regionScopes)
    : { scope: null };
  if (regionResolution.error) return regionResolution.error;
  const selectedRegionScope = regionResolution.scope;

  if (input.acceptanceProbeFingerprint !== undefined) {
    const currentFingerprint =
      platform.acceptanceFingerprint ?? platformAcceptanceFingerprint(platform);
    return currentFingerprint === input.acceptanceProbeFingerprint
      ? null
      : `${platform.displayName} catalog changed after the acceptance quote`;
  }

  if (!platform.enabled || !platform.verified) {
    return `Platform ${selection.providerCode} is not available`;
  }
  if (selection.mode === "reasoning_search" && !platform.supportsReasoning) {
    return `${platform.displayName} does not support reasoning`;
  }
  if (selection.screenshot !== 0 && !platform.supportsScreenshot) {
    return `${platform.displayName} does not support screenshots`;
  }
  if (selectedRegionScope === "domestic" && !platform.supportsDomesticRegion) {
    return `${platform.displayName} does not support the selected region`;
  }
  if (selectedRegionScope === "overseas" && !platform.supportsOverseasRegion) {
    return `${platform.displayName} does not support the selected region`;
  }
  if (!platform.acceptanceRequired) return null;

  const fingerprint =
    platform.acceptanceFingerprint ?? platformAcceptanceFingerprint(platform);
  const evidence = new Set(
    input.acceptanceEvidence.flatMap((check) =>
      check.platformId === platform.id &&
      check.platformFingerprint === fingerprint
        ? [check.dimension]
        : [],
    ),
  );
  const transportDimension: PlatformAcceptanceDimension =
    platform.clientType === "mobile"
      ? "mobile_no_region"
      : selectedRegionScope === "domestic"
        ? "region_domestic"
        : selectedRegionScope === "overseas"
          ? "region_overseas"
          : "region_default";
  const required: PlatformAcceptanceDimension[] = [
    "search_default",
    transportDimension,
  ];
  if (selection.mode === "reasoning_search") required.push("reasoning_search");
  if (selection.screenshot === 1) required.push("screenshot_all");
  if (selection.screenshot === 2) required.push("screenshot_mention");
  const missing = required.find((dimension) => !evidence.has(dimension));
  return missing
    ? `${platform.displayName} option ${missing} is pending current acceptance`
    : null;
}

function singleRegionScope(
  regionCode: string,
  scopes: ReadonlySet<"domestic" | "overseas"> | undefined,
): {
  scope: "domestic" | "overseas" | null;
  error?: string;
} {
  if (!scopes || scopes.size === 0) {
    return { scope: null, error: `Region ${regionCode} is not available` };
  }
  if (scopes.size !== 1) {
    return {
      scope: null,
      error: `Region ${regionCode} has an ambiguous scope`,
    };
  }
  return { scope: scopes.has("domestic") ? "domestic" : "overseas" };
}

function monitoringScreenshotPolicy(value: number): 0 | 1 | 2 {
  if (value === 0 || value === 1 || value === 2) return value;
  throw new RepositoryError(
    "INVALID_STATE",
    "Monitor configuration contains an invalid screenshot policy",
  );
}

async function enqueueNextSerializedRun(
  tx: Transaction,
  monitorId: string,
  completedRunId: string,
  availableAt: Date,
) {
  const [nextRun] = await tx
    .select({ id: runs.id })
    .from(runs)
    .leftJoin(
      scheduleOccurrences,
      eq(runs.scheduleOccurrenceId, scheduleOccurrences.id),
    )
    .where(
      and(
        eq(runs.monitorId, monitorId),
        eq(runs.status, "queued"),
        isNull(runs.deletedAt),
        sql`${runs.id} <> ${completedRunId}`,
      ),
    )
    .orderBy(
      asc(
        sql`COALESCE(${scheduleOccurrences.scheduledFor}, ${runs.createdAt})`,
      ),
      asc(runs.createdAt),
      asc(runs.id),
    )
    .limit(1);
  if (!nextRun) return;
  const queuedAttempts = await tx
    .select({ id: attempts.id })
    .from(attempts)
    .where(and(eq(attempts.runId, nextRun.id), eq(attempts.status, "queued")));
  for (const attempt of queuedAttempts) {
    await tx
      .insert(jobs)
      .values({
        id: randomUUID(),
        type: "submit_attempt",
        dedupeKey: `submit:${attempt.id}`,
        payload: { attemptId: attempt.id },
        availableAt,
      })
      .onDuplicateKeyUpdate({
        set: {
          status: "ready",
          availableAt,
          leaseOwner: null,
          leaseExpiresAt: null,
          completedAt: null,
        },
      });
  }
}

async function insertAudit(
  tx: Transaction,
  audit: RequestAudit,
  action: string,
  targetType: string,
  targetId: string | null,
  ownerId: string | null,
  metadata: Record<string, unknown>,
) {
  await tx
    .insert(auditLogs)
    .values(
      auditValues(audit, action, targetType, targetId, ownerId, metadata),
    );
}

type DiscoveredSourceRow = typeof resultDiscoveredSources.$inferSelect;

function orderDiscoveredSourcesByAttempt(
  attemptRows: ReadonlyArray<{
    result: { currentRevisionId: string } | null;
  }>,
  sources: readonly DiscoveredSourceRow[],
): DiscoveredSourceRow[] {
  const byRevision = new Map<string, DiscoveredSourceRow[]>();
  for (const source of sources) {
    const group = byRevision.get(source.revisionId) ?? [];
    group.push(source);
    byRevision.set(source.revisionId, group);
  }
  for (const group of byRevision.values()) {
    group.sort((left, right) => left.ordinal - right.ordinal);
  }
  return attemptRows.flatMap((row) =>
    row.result ? (byRevision.get(row.result.currentRevisionId) ?? []) : [],
  );
}

function discoveredSourcesFromNormalizedPayload(input: {
  revisionId: string;
  payload: Record<string, unknown> | null;
  citationProvenance: CitationProvenance;
  createdAt: Date;
}): DiscoveredSourceRow[] {
  const allReferences = payloadArray(input.payload, "allReferences");
  const references = payloadArray(input.payload, "references");
  const citedReferences =
    input.citationProvenance === "explicit" ? references : [];
  const citedUrls = new Set(
    citedReferences.flatMap((value) => {
      const reference = safeNormalizedReference(value);
      return reference ? [reference.canonicalUrl] : [];
    }),
  );
  const merged = new Map<
    string,
    ReturnType<typeof safeNormalizedReference> & { isCited: boolean }
  >();
  const accept = (value: unknown, cited: boolean) => {
    const reference = safeNormalizedReference(value);
    if (!reference) return;
    const existing = merged.get(reference.canonicalUrl);
    if (!existing) {
      merged.set(reference.canonicalUrl, {
        ...reference,
        isCited: cited || citedUrls.has(reference.canonicalUrl),
      });
      return;
    }
    const preferredProviderPosition =
      cited && reference.providerPosition !== null
        ? reference.providerPosition
        : existing.providerPosition;
    merged.set(reference.canonicalUrl, {
      ...existing,
      title: existing.title || reference.title,
      siteName: existing.siteName ?? reference.siteName,
      summary: existing.summary ?? reference.summary,
      publishedAt: existing.publishedAt ?? reference.publishedAt,
      providerPosition: preferredProviderPosition ?? reference.providerPosition,
      isCited:
        existing.isCited || cited || citedUrls.has(reference.canonicalUrl),
    });
  };
  for (const value of allReferences) accept(value, false);
  for (const value of references) {
    accept(value, input.citationProvenance === "explicit");
  }

  return [...merged.values()].flatMap((source, ordinal) =>
    source
      ? [
          {
            id: deterministicUuid(
              `discovered-source:${input.revisionId}:${source.canonicalUrl}`,
            ),
            revisionId: input.revisionId,
            ordinal,
            providerPosition: source.providerPosition,
            url: source.url,
            canonicalUrlHash: sha256(source.canonicalUrl),
            title: source.title,
            domain: source.domain.slice(0, 255),
            siteName: source.siteName?.slice(0, 255) ?? null,
            summary: source.summary,
            publishedAt: source.publishedAt,
            providerIconUrl: null,
            isCited: source.isCited,
            createdAt: input.createdAt,
          },
        ]
      : [],
  );
}

export function inferCitationProvenance(
  payload: Record<string, unknown> | null,
  hasStoredSources: boolean,
): CitationProvenance {
  const direct = payload?.citationProvenance;
  if (
    direct === "explicit" ||
    direct === "legacy_assumed" ||
    direct === "unavailable"
  ) {
    return direct;
  }

  // Pre-provenance revisions retained the original provider result under raw.
  // Only an actual citationList array proves that the old normalizer used the
  // explicit list. A malformed field is no stronger than a missing field;
  // otherwise persisted result_sources were legacy fallback assumptions and
  // must not be presented as authoritative citations.
  const raw = payload?.raw;
  if (
    raw &&
    typeof raw === "object" &&
    !Array.isArray(raw) &&
    Array.isArray((raw as Record<string, unknown>).citationList)
  ) {
    return "explicit";
  }
  return hasStoredSources ? "legacy_assumed" : "unavailable";
}

function payloadArray(
  payload: Record<string, unknown> | null,
  key: string,
): unknown[] {
  const value = payload?.[key];
  return Array.isArray(value) ? value : [];
}

function safeNormalizedReference(value: unknown): {
  canonicalUrl: string;
  url: string;
  title: string;
  domain: string;
  siteName: string | null;
  summary: string | null;
  publishedAt: string | null;
  providerPosition: number | null;
} | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const raw =
    record.raw && typeof record.raw === "object" && !Array.isArray(record.raw)
      ? (record.raw as Record<string, unknown>)
      : {};
  const rawUrl = firstString(record.url);
  if (!rawUrl) return null;
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return null;
  }
  if (
    (parsed.protocol !== "https:" && parsed.protocol !== "http:") ||
    parsed.username ||
    parsed.password
  ) {
    return null;
  }
  const url = parsed.toString();
  const publishedAt = firstString(
    record.publishedAt,
    raw.publishTime,
    raw.publishedAt,
    raw.publishDate,
  );
  return {
    canonicalUrl: canonicalUrl(url),
    url,
    title: firstString(record.title, raw.title, raw.name) ?? "",
    domain: parsed.hostname,
    siteName:
      firstString(record.siteName, raw.siteName, raw.site)?.slice(0, 255) ??
      null,
    summary:
      firstString(record.snippet, raw.snippet, raw.summary, raw.description) ??
      null,
    publishedAt:
      publishedAt && /^\d{4}-\d{2}-\d{2}$/u.test(publishedAt)
        ? publishedAt
        : null,
    providerPosition: positiveInteger(
      firstNumber(record.position, raw.position, raw.index),
    ),
  };
}

function firstString(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return undefined;
}

function firstNumber(...values: unknown[]): number | undefined {
  for (const value of values) {
    if (typeof value === "number" && Number.isFinite(value)) return value;
    if (typeof value === "string" && /^-?\d+$/u.test(value.trim())) {
      return Number(value.trim());
    }
  }
  return undefined;
}

function firstBoolean(...values: unknown[]): boolean | undefined {
  return values.find((value): value is boolean => typeof value === "boolean");
}

function positiveInteger(value: number | undefined): number | null {
  return value !== undefined && Number.isInteger(value) && value > 0
    ? value
    : null;
}

function safeKeywordEvaluations(value: unknown): Array<{
  keyword: string;
  nature: "positive" | "neutral" | "negative";
  context: string | null;
}> {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) return [];
    const record = entry as Record<string, unknown>;
    const keyword = firstString(record.keyword);
    const nature = firstString(record.nature)?.toLowerCase();
    if (
      !keyword ||
      (nature !== "positive" && nature !== "neutral" && nature !== "negative")
    ) {
      return [];
    }
    return [
      {
        keyword,
        nature,
        context: firstString(record.context) ?? null,
      },
    ];
  });
}

function canonicalUrl(value: string): string {
  try {
    const parsed = new URL(value);
    parsed.hash = "";
    return parsed.toString();
  } catch {
    return value.trim();
  }
}

function deterministicUuid(material: string): string {
  const hash = sha256(material);
  const variant = ((Number.parseInt(hash[16] ?? "0", 16) & 0x3) | 0x8).toString(
    16,
  );
  return `${hash.slice(0, 8)}-${hash.slice(8, 12)}-5${hash.slice(13, 16)}-${variant}${hash.slice(17, 20)}-${hash.slice(20, 32)}`;
}

function auditValues(
  audit: RequestAudit,
  action: string,
  targetType: string,
  targetId: string | null,
  ownerId: string | null,
  metadata: Record<string, unknown>,
): typeof auditLogs.$inferInsert {
  return {
    id: randomUUID(),
    actorId: audit.actorId,
    actorRole: audit.actorRole,
    action,
    targetType,
    targetIdHash: targetId ? sha256(targetId) : null,
    ownerId,
    ipHash: audit.ipHash ?? null,
    metadata,
  };
}

function affectedRows(result: unknown): number {
  if (
    result &&
    typeof result === "object" &&
    "affectedRows" in result &&
    typeof result.affectedRows === "number"
  )
    return result.affectedRows;
  if (Array.isArray(result)) return affectedRows(result[0]);
  return 0;
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function uniqueTrimmed(values: readonly string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}

function normalizeCompetitors(
  values: ReadonlyArray<{ name: string; aliases: string[] }>,
) {
  const seen = new Set<string>();
  return values.flatMap((competitor) => {
    const name = competitor.name.trim();
    if (!name || seen.has(name)) return [];
    seen.add(name);
    return [{ name, aliases: uniqueTrimmed(competitor.aliases) }];
  });
}

export function computeNextRunAt(
  schedule: {
    type: "none" | "daily" | "weekly";
    timezone: string;
    localTime: string;
    weekday: number | null;
  },
  after: Date,
): Date | null {
  if (schedule.type === "none") return null;
  const [hourText, minuteText] = schedule.localTime.split(":");
  const hour = Number(hourText);
  const minute = Number(minuteText);
  const local = zonedParts(after, schedule.timezone);
  let date = { year: local.year, month: local.month, day: local.day };
  if (schedule.type === "weekly") {
    if (schedule.weekday === null)
      throw new RepositoryError(
        "INVALID_STATE",
        "Weekly schedule requires a weekday",
      );
    const currentWeekday = local.weekday;
    const delta = (schedule.weekday - currentWeekday + 7) % 7;
    date = addCalendarDays(date, delta);
  }
  let candidate = zonedDateTimeToUtc(
    { ...date, hour, minute },
    schedule.timezone,
  );
  if (candidate.getTime() <= after.getTime()) {
    candidate = zonedDateTimeToUtc(
      {
        ...addCalendarDays(date, schedule.type === "daily" ? 1 : 7),
        hour,
        minute,
      },
      schedule.timezone,
    );
  }
  return candidate;
}

function addCalendarDays(
  date: { year: number; month: number; day: number },
  days: number,
) {
  const result = new Date(Date.UTC(date.year, date.month - 1, date.day + days));
  return {
    year: result.getUTCFullYear(),
    month: result.getUTCMonth() + 1,
    day: result.getUTCDate(),
  };
}

function zonedDateTimeToUtc(
  parts: {
    year: number;
    month: number;
    day: number;
    hour: number;
    minute: number;
  },
  timezone: string,
) {
  const target = Date.UTC(
    parts.year,
    parts.month - 1,
    parts.day,
    parts.hour,
    parts.minute,
    0,
    0,
  );
  let guess = target;
  for (let iteration = 0; iteration < 4; iteration += 1) {
    const actual = zonedParts(new Date(guess), timezone);
    const actualAsUtc = Date.UTC(
      actual.year,
      actual.month - 1,
      actual.day,
      actual.hour,
      actual.minute,
      0,
      0,
    );
    const correction = target - actualAsUtc;
    if (correction === 0) break;
    guess += correction;
  }
  return new Date(guess);
}

function zonedParts(value: Date, timezone: string) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
    weekday: "short",
  }).formatToParts(value);
  const get = (type: Intl.DateTimeFormatPartTypes) =>
    Number(parts.find((part) => part.type === type)?.value);
  const weekdayText =
    parts.find((part) => part.type === "weekday")?.value ?? "Mon";
  const weekdays: Record<string, number> = {
    Mon: 1,
    Tue: 2,
    Wed: 3,
    Thu: 4,
    Fri: 5,
    Sat: 6,
    Sun: 7,
  };
  return {
    year: get("year"),
    month: get("month"),
    day: get("day"),
    hour: get("hour"),
    minute: get("minute"),
    weekday: weekdays[weekdayText] ?? 1,
  };
}

async function claimMonitoringReceipt(tx: Transaction, input: {
  provider: "zpay" | "bank"; providerTradeNo: string; providerOrderId: string;
  payloadDigest: string; receivedAt: Date;
}) {
  const [existing] = await tx.select().from(paymentReceiptClaims).where(and(
    eq(paymentReceiptClaims.provider, input.provider),
    eq(paymentReceiptClaims.providerTradeNo, input.providerTradeNo),
  )).limit(1);
  if (existing) {
    if (existing.providerOrderId !== input.providerOrderId || existing.walletScope !== "monitoring")
      throw new RepositoryError("CONFLICT", "Payment receipt is already claimed by another order");
    return;
  }
  // The global unique key also serializes claims made simultaneously in different domains.
  await tx.insert(paymentReceiptClaims).values({ id: randomUUID(), ...input,
    walletScope: "monitoring", status: "received", claimedAt: input.receivedAt,
  });
}
