import { createHash, randomUUID } from "node:crypto";
import {
  and,
  asc,
  count,
  eq,
  gt,
  inArray,
  lte,
  ne,
  or,
  sql,
} from "drizzle-orm";
import { createDatabase, type Database } from "./client.js";
import { publisherImageCapabilityEvidenceBlocker } from "./publisher-capability.js";
import { publisherPriceToTenThousandths } from "./publisher-money.js";
import { RepositoryError } from "./repository-error.js";
import {
  derivePublisherBatchFundsStatus,
  settlePublisherItemMoney,
} from "./publisher-settlement.js";
import {
  auditLogs,
  mediaPublishingItemPriceSnapshots,
  publisherArticleAssets,
  publisherArticleVersionAssets,
  publisherArticleVersions,
  publisherArticles,
  publisherBatches,
  publisherDocxImports,
  publisherItems,
  publisherJobs,
  publisherLiveWhitelist,
  publisherMediaCapabilities,
  publisherMediaLogoAssets,
  publisherMediaLogoResolutions,
  publisherMediaResources,
  publisherMediaSyncRuns,
  publisherMediaSyncStaging,
  publisherObjectLeases,
  publisherReconciliationCandidates,
  publisherRuntimeState,
  publisherSubmissionAttempts,
  publisherSubmissionGate,
} from "./schema.js";

type Transaction = Parameters<Parameters<Database["transaction"]>[0]>[0];
type PublicationMode = "mock" | "test" | "live";
type KolResourceInput = {
  id: number;
  name: string;
  platform?: string;
  taxonomy?: string;
  mediaType?: string;
  kind: "news" | "self_media";
  area?: string;
  caseUrl?: string;
  titleLimit?: number;
  price?: string;
  successRate?: string;
  includeRate?: string;
  pcWeight?: string;
  mobileWeight?: string;
  includeType?: string;
  publishTime?: string;
  linkType?: string;
  entryUrl?: string;
  entryLevel?: string;
  logo?: string;
  icon?: string;
  remark?: string;
  description?: string;
  recommended?: boolean;
  authenticated?: boolean;
  festivalPublishable?: boolean;
  fanCount?: bigint;
  likeCount?: bigint;
  publishCount?: bigint;
  isSelfMedia: boolean;
  raw: Readonly<Record<string, unknown>>;
};
type KolOrderInput = {
  orderId: string;
  resourceId: number;
  title: string;
  status: "processing" | "success" | "failed" | "unknown";
  reportedPrice?: string;
  manuscriptId?: string;
  publishedUrl?: string;
  failureReason?: string;
  raw: Readonly<Record<string, unknown>>;
};
type DocxReportInput = {
  fileName: string;
  sourceSha256: string;
  suggestedTitle: string;
  canonicalHtml: string;
  plainText: string;
  contentHash: string;
  containsImages: boolean;
  images: ReadonlyArray<{
    assetId: string;
    storageKey?: string;
    capability?: string;
    sha256: string;
    mimeType: "image/jpeg" | "image/png";
    width: number;
    height: number;
    sizeBytes: number;
  }>;
  warnings: readonly unknown[];
  blockingIssues: readonly unknown[];
  stats: unknown;
};

const CATALOG_SYNC_GATE_ID = "kol-catalog-sync";

export function createPublisherWorkerRepository({
  env,
}: {
  env: NodeJS.ProcessEnv;
}) {
  const databaseUrl = env.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error(
      "DATABASE_URL is required by the publisher worker repository",
    );
  }
  const { db } = createDatabase(databaseUrl, {
    connectionLimit: Number(env.PUBLISHER_WORKER_DB_POOL_SIZE ?? 4),
  });
  return new PublisherWorkerRepository(db);
}

export class PublisherWorkerRepository {
  constructor(private readonly db: Database) {}

  async leasePublisherJobs(input: {
    workerId: string;
    now: Date;
    limit: number;
    leaseMs: number;
    allowedTypes?: readonly (typeof publisherJobs.$inferSelect)["type"][];
  }) {
    if (input.allowedTypes?.length === 0) return [];
    return this.db.transaction(async (tx) => {
      const candidates = await tx
        .select()
        .from(publisherJobs)
        .where(
          and(
            or(
              and(
                inArray(publisherJobs.status, ["ready", "retry_wait"]),
                lte(publisherJobs.availableAt, input.now),
              ),
              and(
                eq(publisherJobs.status, "leased"),
                lte(publisherJobs.leaseExpiresAt, input.now),
              ),
            ),
            sql`${publisherJobs.attempts} < ${publisherJobs.maxAttempts}`,
            input.allowedTypes
              ? inArray(publisherJobs.type, [...input.allowedTypes])
              : undefined,
          ),
        )
        .orderBy(
          sql`case
            when ${publisherJobs.type} in ('submit_publication_item', 'poll_publication_item', 'reconcile_publication_unknown') then 0
            when ${publisherJobs.type} = 'sync_kol_catalog' then 1
            when ${publisherJobs.type} = 'archive_publisher_media_logo' then 3
            else 2
          end`,
          asc(publisherJobs.availableAt),
          asc(publisherJobs.createdAt),
        )
        .limit(Math.min(Math.max(input.limit, 1), 100))
        .for("update", { skipLocked: true });
      if (!candidates.length) return [];
      const leasedUntil = new Date(input.now.getTime() + input.leaseMs);
      await tx
        .update(publisherJobs)
        .set({
          status: "leased",
          leaseOwner: input.workerId,
          leaseExpiresAt: leasedUntil,
        })
        .where(
          inArray(
            publisherJobs.id,
            candidates.map(({ id }) => id),
          ),
        );
      return candidates.map((job) => ({
        id: job.id,
        type: job.type,
        payload: job.payload,
        attemptCount: job.attempts,
        maxAttempts: job.maxAttempts,
        leasedUntil,
      }));
    });
  }

  async renewPublisherJobLease(
    jobId: string,
    workerId: string,
    leasedUntil: Date,
  ) {
    await this.db
      .update(publisherJobs)
      .set({ leaseExpiresAt: leasedUntil })
      .where(leasedPublisherJob(jobId, workerId));
  }

  async completePublisherJob(
    jobId: string,
    workerId: string,
    completedAt: Date,
  ) {
    await this.db
      .update(publisherJobs)
      .set({
        status: "succeeded",
        completedAt,
        leaseOwner: null,
        leaseExpiresAt: null,
      })
      .where(leasedPublisherJob(jobId, workerId));
  }

  async deferPublisherJob(
    jobId: string,
    workerId: string,
    availableAt: Date,
    reason: string,
  ) {
    await this.db
      .update(publisherJobs)
      .set({
        status: "retry_wait",
        availableAt,
        leaseOwner: null,
        leaseExpiresAt: null,
        lastErrorCode: "DEFERRED",
        lastErrorMessage: truncate(reason, 4_000),
      })
      .where(leasedPublisherJob(jobId, workerId));
  }

  async retryPublisherJob(input: {
    jobId: string;
    workerId: string;
    availableAt: Date;
    error: string;
  }) {
    await this.db
      .update(publisherJobs)
      .set({
        status: "retry_wait",
        availableAt: input.availableAt,
        leaseOwner: null,
        leaseExpiresAt: null,
        attempts: sql`${publisherJobs.attempts} + 1`,
        lastErrorCode: "RETRYABLE",
        lastErrorMessage: truncate(input.error, 4_000),
      })
      .where(leasedPublisherJob(input.jobId, input.workerId));
  }

  async deadLetterPublisherJob(input: {
    jobId: string;
    workerId: string;
    failedAt: Date;
    error: string;
  }) {
    return this.db.transaction(async (tx) => {
      const [job] = await tx
        .select()
        .from(publisherJobs)
        .where(leasedPublisherJob(input.jobId, input.workerId))
        .for("update")
        .limit(1);
      if (!job) return;
      await tx
        .update(publisherJobs)
        .set({
          status: "dead",
          completedAt: input.failedAt,
          leaseOwner: null,
          leaseExpiresAt: null,
          attempts: sql`${publisherJobs.attempts} + 1`,
          lastErrorCode: "DEAD_LETTER",
          lastErrorMessage: truncate(input.error, 4_000),
        })
        .where(eq(publisherJobs.id, job.id));
      const itemId = payloadString(job.payload, "itemId");
      if (!itemId) return;
      const [item] = await tx
        .select()
        .from(publisherItems)
        .where(eq(publisherItems.id, itemId))
        .for("update")
        .limit(1);
      if (!item || terminalItem(item.status)) return;
      if (
        item.status === "processing" ||
        item.status === "submission_unknown" ||
        item.status === "auth_blocked" ||
        item.status === "action_required"
      ) {
        // A committed acceptance always creates its poll job in the same
        // transaction. Never reinterpret an accepted or already reconciled
        // item as unsent merely because the submit job later dead-lettered.
        return;
      }
      if (item.status === "submitting") {
        await tx
          .update(publisherItems)
          .set({
            status: "submission_unknown",
            actionRequiredReason:
              "Submission worker exhausted retries after POST may have started",
          })
          .where(eq(publisherItems.id, item.id));
        await settlePublisherItemMoney(tx, {
          itemId: item.id,
          settlement: "frozen",
          settledAt: input.failedAt,
          reason: "Submission outcome is unknown",
        });
      } else {
        await tx
          .update(publisherItems)
          .set({
            status: "action_required",
            actionRequiredReason: truncate(input.error, 4_000),
          })
          .where(eq(publisherItems.id, item.id));
        await settlePublisherItemMoney(tx, {
          itemId: item.id,
          settlement: "released",
          settledAt: input.failedAt,
          reason: "Publisher job ended before provider submission",
        });
      }
      await refreshBatchState(tx, item.batchId, input.failedAt);
    });
  }

  async enqueuePublisherMaintenanceJobs(at: Date) {
    const slot = publisherCatalogSyncSlot(at);
    await this.db
      .insert(publisherJobs)
      .values({
        id: randomUUID(),
        type: "sync_kol_catalog",
        enterpriseProjectId: null,
        deterministicKey: `publisher:catalog:${slot}`,
        aggregateId: slot,
        payload: {},
        availableAt: at,
        maxAttempts: 8,
      })
      .onDuplicateKeyUpdate({
        set: { deterministicKey: sql`${publisherJobs.deterministicKey}` },
      });
  }

  async recoverExpiredPublisherSubmissions(at: Date, limit: number) {
    const expired = await this.db
      .select({ jobId: publisherJobs.id, itemId: publisherJobs.aggregateId })
      .from(publisherJobs)
      .where(
        and(
          eq(publisherJobs.type, "submit_publication_item"),
          eq(publisherJobs.status, "leased"),
          lte(publisherJobs.leaseExpiresAt, at),
        ),
      )
      .orderBy(asc(publisherJobs.leaseExpiresAt))
      .limit(Math.min(Math.max(limit, 1), 100));
    let recovered = 0;
    for (const candidate of expired) {
      const changed = await this.db.transaction(async (tx) => {
        const [job] = await tx
          .select()
          .from(publisherJobs)
          .where(
            and(
              eq(publisherJobs.id, candidate.jobId),
              eq(publisherJobs.status, "leased"),
              lte(publisherJobs.leaseExpiresAt, at),
            ),
          )
          .for("update")
          .limit(1);
        const [item] = await tx
          .select()
          .from(publisherItems)
          .where(eq(publisherItems.id, candidate.itemId))
          .for("update")
          .limit(1);
        if (!job || !item) return false;
        if (item.status === "submitting") {
          await tx
            .update(publisherItems)
            .set({
              status: "submission_unknown",
              actionRequiredReason:
                "Worker lease expired during provider submission",
            })
            .where(eq(publisherItems.id, item.id));
          await settlePublisherItemMoney(tx, {
            itemId: item.id,
            settlement: "frozen",
            settledAt: at,
            reason: "Worker lease expired during provider submission",
          });
          await enqueueJob(tx, {
            type: "reconcile_publication_unknown",
            key: `publisher:reconcile:${item.id}:${item.attemptCount}`,
            aggregateId: item.id,
            enterpriseProjectId: item.enterpriseProjectId,
            payload: { itemId: item.id },
            at,
          });
          await refreshBatchState(tx, item.batchId, at);
          await tx
            .update(publisherJobs)
            .set({
              status: "succeeded",
              completedAt: at,
              leaseOwner: null,
              leaseExpiresAt: null,
              lastErrorCode: "SUBMISSION_UNKNOWN_RECOVERED",
            })
            .where(eq(publisherJobs.id, job.id));
          return true;
        }
        await tx
          .update(publisherJobs)
          .set({
            status: "retry_wait",
            availableAt: at,
            leaseOwner: null,
            leaseExpiresAt: null,
          })
          .where(eq(publisherJobs.id, job.id));
        return true;
      });
      if (changed) recovered += 1;
    }
    return recovered;
  }

  async claimExpiredPublisherObjectLeases(input: {
    now: Date;
    claimUntil: Date;
    limit: number;
  }) {
    if (input.claimUntil <= input.now) {
      throw new RepositoryError(
        "INVALID_STATE",
        "Publisher object cleanup claim must expire in the future",
      );
    }
    return this.db.transaction(async (tx) => {
      const expired = await tx
        .select()
        .from(publisherObjectLeases)
        .where(lte(publisherObjectLeases.expiresAt, input.now))
        .orderBy(
          asc(publisherObjectLeases.expiresAt),
          asc(publisherObjectLeases.id),
        )
        .limit(Math.min(Math.max(input.limit, 1), 100))
        .for("update", { skipLocked: true });
      if (!expired.length) return [];
      const storageKeys = [
        ...new Set(expired.map(({ storageKey }) => storageKey)),
      ];
      const docxReferences = await tx
        .select({ storageKey: publisherDocxImports.sourceObjectKey })
        .from(publisherDocxImports)
        .where(inArray(publisherDocxImports.sourceObjectKey, storageKeys));
      const assetReferences = await tx
        .select({ storageKey: publisherArticleAssets.storageKey })
        .from(publisherArticleAssets)
        .where(inArray(publisherArticleAssets.storageKey, storageKeys));
      const liveLeases = await tx
        .select({ storageKey: publisherObjectLeases.storageKey })
        .from(publisherObjectLeases)
        .where(
          and(
            inArray(publisherObjectLeases.storageKey, storageKeys),
            gt(publisherObjectLeases.expiresAt, input.now),
          ),
        );
      const protectedKeys = new Set([
        ...docxReferences.map(({ storageKey }) => storageKey),
        ...assetReferences.map(({ storageKey }) => storageKey),
        ...liveLeases.map(({ storageKey }) => storageKey),
      ]);
      const claimedKeys = new Set<string>();
      const candidates: Array<{ leaseId: string; storageKey: string }> = [];
      for (const lease of expired) {
        if (
          protectedKeys.has(lease.storageKey) ||
          claimedKeys.has(lease.storageKey)
        ) {
          // A durable reference or another live upload protects shared SHA
          // keys. The expired lease itself has no further cleanup purpose.
          await tx
            .delete(publisherObjectLeases)
            .where(eq(publisherObjectLeases.id, lease.id));
          continue;
        }
        await tx
          .update(publisherObjectLeases)
          .set({ expiresAt: input.claimUntil })
          .where(eq(publisherObjectLeases.id, lease.id));
        claimedKeys.add(lease.storageKey);
        candidates.push({ leaseId: lease.id, storageKey: lease.storageKey });
      }
      return candidates;
    });
  }

  async completePublisherObjectLeaseCleanup(input: {
    leaseId: string;
    storageKey: string;
    completedAt: Date;
  }) {
    void input.completedAt;
    await this.db
      .delete(publisherObjectLeases)
      .where(
        and(
          eq(publisherObjectLeases.id, input.leaseId),
          eq(publisherObjectLeases.storageKey, input.storageKey),
        ),
      );
  }

  async confirmPublisherObjectLeaseCleanup(input: {
    leaseId: string;
    storageKey: string;
    now: Date;
  }) {
    return this.db.transaction(async (tx) => {
      const [lease] = await tx
        .select()
        .from(publisherObjectLeases)
        .where(
          and(
            eq(publisherObjectLeases.id, input.leaseId),
            eq(publisherObjectLeases.storageKey, input.storageKey),
          ),
        )
        .for("update")
        .limit(1);
      if (!lease) return false;
      const [docxReference] = await tx
        .select({ id: publisherDocxImports.id })
        .from(publisherDocxImports)
        .where(eq(publisherDocxImports.sourceObjectKey, input.storageKey))
        .limit(1);
      const [assetReference] = await tx
        .select({ id: publisherArticleAssets.id })
        .from(publisherArticleAssets)
        .where(eq(publisherArticleAssets.storageKey, input.storageKey))
        .limit(1);
      const [otherLiveLease] = await tx
        .select({ id: publisherObjectLeases.id })
        .from(publisherObjectLeases)
        .where(
          and(
            eq(publisherObjectLeases.storageKey, input.storageKey),
            ne(publisherObjectLeases.id, input.leaseId),
            gt(publisherObjectLeases.expiresAt, input.now),
          ),
        )
        .limit(1);
      if (docxReference || assetReference || otherLiveLease) {
        await tx
          .delete(publisherObjectLeases)
          .where(eq(publisherObjectLeases.id, input.leaseId));
        return false;
      }
      return true;
    });
  }

  async preparePublisherSubmission(input: {
    itemId: string;
    workerId: string;
    now: Date;
    leaseExpiresAt: Date;
    minimumIntervalMs: number;
    runtime: {
      mode: PublicationMode;
      realEnabled: boolean;
      publishEnabled: boolean;
      imageEnabled: boolean;
    };
  }) {
    return this.db.transaction(async (tx) => {
      const [row] = await tx
        .select({
          item: publisherItems,
          batch: publisherBatches,
          version: publisherArticleVersions,
          resource: publisherMediaResources,
          snapshot: mediaPublishingItemPriceSnapshots,
        })
        .from(publisherItems)
        .innerJoin(
          publisherBatches,
          eq(publisherBatches.id, publisherItems.batchId),
        )
        .innerJoin(
          publisherArticleVersions,
          eq(publisherArticleVersions.id, publisherBatches.articleVersionId),
        )
        .innerJoin(
          publisherMediaResources,
          eq(publisherMediaResources.id, publisherItems.mediaResourceId),
        )
        .innerJoin(
          mediaPublishingItemPriceSnapshots,
          eq(mediaPublishingItemPriceSnapshots.itemId, publisherItems.id),
        )
        .where(eq(publisherItems.id, input.itemId))
        .for("update")
        .limit(1);
      if (!row || terminalItem(row.item.status))
        return { status: "terminal" as const };
      if (
        row.item.ownerId !== row.batch.ownerId ||
        row.item.ownerId !== row.version.ownerId ||
        row.item.enterpriseProjectId !== row.batch.enterpriseProjectId ||
        row.item.enterpriseProjectId !== row.version.enterpriseProjectId
      )
        throw new RepositoryError(
          "INVALID_STATE",
          "Publication project provenance mismatch",
        );
      if (row.item.status !== "queued") {
        return { status: "terminal" as const };
      }
      const [runtime] = await tx
        .select()
        .from(publisherRuntimeState)
        .where(eq(publisherRuntimeState.id, "kol"))
        .for("update")
        .limit(1);
      if (runtime?.emergencyStop) {
        return {
          status: "deferred" as const,
          reason: "emergency_stop" as const,
          retryAt: new Date(input.now.getTime() + 60_000),
        };
      }
      const blocker = await submissionBlocker(tx, row, runtime, input);
      if (blocker) {
        await tx
          .update(publisherItems)
          .set({ status: "auth_blocked", actionRequiredReason: blocker })
          .where(eq(publisherItems.id, row.item.id));
        await settlePublisherItemMoney(tx, {
          itemId: row.item.id,
          settlement: "released",
          settledAt: input.now,
          reason: `Submission blocked before POST: ${blocker}`,
        });
        await refreshBatchState(tx, row.item.batchId, input.now);
        return { status: "blocked" as const, reason: blocker };
      }
      await tx
        .insert(publisherSubmissionGate)
        .values({ id: "kol", nextAllowedAt: new Date(0) })
        .onDuplicateKeyUpdate({
          set: { id: sql`${publisherSubmissionGate.id}` },
        });
      const [gate] = await tx
        .select()
        .from(publisherSubmissionGate)
        .where(eq(publisherSubmissionGate.id, "kol"))
        .for("update")
        .limit(1);
      if (!gate)
        throw new RepositoryError(
          "INVALID_STATE",
          "Submission gate is missing",
        );
      if (
        gate.leaseOwner &&
        gate.leaseOwner !== input.workerId &&
        gate.leaseExpiresAt &&
        gate.leaseExpiresAt > input.now
      ) {
        return {
          status: "deferred" as const,
          reason: "submission_concurrency" as const,
          retryAt: gate.leaseExpiresAt,
        };
      }
      if (gate.nextAllowedAt > input.now) {
        return {
          status: "deferred" as const,
          reason: "rate_limit" as const,
          retryAt: gate.nextAllowedAt,
        };
      }
      const attemptId = randomUUID();
      const attemptNumber = row.item.attemptCount + 1;
      const requestHash = hashJson({
        itemId: row.item.id,
        submissionKey: row.item.submissionKey,
        resourceId: row.item.externalResourceId,
        title: row.item.submissionTitle,
        articleContentHash: row.version.contentHash,
      });
      await tx.insert(publisherSubmissionAttempts).values({
        id: attemptId,
        ownerId: row.item.ownerId,
        itemId: row.item.id,
        attemptNumber,
        startedAt: input.now,
        requestHash,
      });
      await tx
        .update(publisherItems)
        .set({ status: "submitting", attemptCount: attemptNumber, requestHash })
        .where(eq(publisherItems.id, row.item.id));
      await tx
        .update(publisherSubmissionGate)
        .set({
          leaseOwner: input.workerId,
          leaseExpiresAt: input.leaseExpiresAt,
          nextAllowedAt: new Date(
            input.now.getTime() + input.minimumIntervalMs,
          ),
        })
        .where(eq(publisherSubmissionGate.id, "kol"));
      const resourceId = Number(row.item.externalResourceId);
      if (!Number.isSafeInteger(resourceId) || resourceId <= 0) {
        throw new RepositoryError(
          "INVALID_STATE",
          "Provider resource ID is invalid",
        );
      }
      return {
        status: "ready" as const,
        attemptId,
        item: {
          itemId: row.item.id,
          batchId: row.batch.id,
          mode: row.batch.mode,
          resourceId,
          title: row.item.submissionTitle,
          canonicalHtml: row.version.canonicalHtml,
          articleContentHash: row.version.contentHash,
          containsImages: row.version.containsImages,
        },
      };
    });
  }

  async markPublisherSubmissionAccepted(input: {
    itemId: string;
    attemptId: string;
    providerOrderId: string;
    providerPaidAt?: string | number;
    providerRaw: unknown;
    acceptedAt: Date;
    nextPollAt: Date;
  }) {
    await this.db.transaction(async (tx) => {
      const item = await lockAttemptItem(tx, input.itemId, input.attemptId);
      if (!item || item.status === "processing") return;
      if (item.status !== "submitting") {
        throw new RepositoryError(
          "CONFLICT",
          "Publisher item is not submitting",
        );
      }
      await tx
        .update(publisherSubmissionAttempts)
        .set({
          completedAt: input.acceptedAt,
          result: "succeeded",
          responseRedacted: jsonRecord({
            providerPaidAt: input.providerPaidAt,
            response: input.providerRaw,
          }),
        })
        .where(eq(publisherSubmissionAttempts.id, input.attemptId));
      await tx
        .update(publisherItems)
        .set({
          status: "processing",
          externalOrderId: input.providerOrderId,
          submittedAt: input.acceptedAt,
          nextPollAt: input.nextPollAt,
        })
        .where(eq(publisherItems.id, input.itemId));
      await enqueueJob(tx, {
        type: "poll_publication_item",
        key: `publisher:poll:${input.itemId}:1`,
        aggregateId: input.itemId,
        enterpriseProjectId: item.enterpriseProjectId,
        payload: { itemId: input.itemId },
        at: input.nextPollAt,
      });
      await releaseSubmissionGate(tx);
      await refreshBatchState(tx, item.batchId, input.acceptedAt);
    });
  }

  async markPublisherSubmissionRejected(input: {
    itemId: string;
    attemptId: string;
    reason: string;
    providerRaw?: unknown;
    settledAt: Date;
  }) {
    await this.finishKnownSubmission({
      ...input,
      status: "failed",
      result: "business_rejected",
      settlement: "released",
    });
  }

  async markPublisherSubmissionUnknown(input: {
    itemId: string;
    attemptId: string;
    reason: string;
    providerRaw?: unknown;
    observedAt: Date;
    blockCredentialGate: boolean;
  }) {
    await this.db.transaction(async (tx) => {
      const item = await lockAttemptItem(tx, input.itemId, input.attemptId);
      if (!item) return;
      if (input.blockCredentialGate) {
        await tx
          .insert(publisherRuntimeState)
          .values({
            id: "kol",
            credentialStatus: "auth_blocked",
            credentialFailedAt: input.observedAt,
          })
          .onDuplicateKeyUpdate({
            set: {
              credentialStatus: "auth_blocked",
              credentialFailedAt: input.observedAt,
            },
          });
      }
      if (item.status === "submission_unknown") return;
      await tx
        .update(publisherSubmissionAttempts)
        .set({
          completedAt: input.observedAt,
          result: "submission_unknown",
          responseRedacted: jsonRecord(input.providerRaw),
          errorCode: truncate(input.reason, 64),
        })
        .where(eq(publisherSubmissionAttempts.id, input.attemptId));
      await tx
        .update(publisherItems)
        .set({
          status: "submission_unknown",
          actionRequiredReason: truncate(input.reason, 4_000),
        })
        .where(eq(publisherItems.id, input.itemId));
      await settlePublisherItemMoney(tx, {
        itemId: input.itemId,
        settlement: "frozen",
        settledAt: input.observedAt,
        reason: "Provider submission outcome is unknown",
      });
      await enqueueJob(tx, {
        type: "reconcile_publication_unknown",
        key: `publisher:reconcile:${input.itemId}:${item.attemptCount}`,
        aggregateId: input.itemId,
        enterpriseProjectId: item.enterpriseProjectId,
        payload: { itemId: input.itemId },
        at: input.observedAt,
      });
      await releaseSubmissionGate(tx);
      await refreshBatchState(tx, item.batchId, input.observedAt);
    });
  }

  async markPublisherSubmissionBlocked(input: {
    itemId: string;
    attemptId: string;
    status: "auth_blocked" | "action_required";
    reason: string;
    observedAt: Date;
  }) {
    await this.finishKnownSubmission({
      itemId: input.itemId,
      attemptId: input.attemptId,
      reason: input.reason,
      settledAt: input.observedAt,
      status: input.status,
      result: "auth_blocked",
      settlement: "released",
    });
  }

  async getPublisherItemForPolling(itemId: string) {
    const [item] = await this.db
      .select()
      .from(publisherItems)
      .where(eq(publisherItems.id, itemId))
      .limit(1);
    if (!item?.externalOrderId || !item.submittedAt) return undefined;
    return {
      itemId: item.id,
      status: item.status,
      providerOrderId: item.externalOrderId,
      submittedAt: item.submittedAt,
    };
  }

  async applyPublisherOrderObservation(input: {
    itemId: string;
    providerOrderId: string;
    providerStatus: "processing" | "success" | "failed" | "unknown";
    publishedUrl?: string;
    failureReason?: string;
    actionRequiredReason?: string;
    reportedPrice?: string;
    manuscriptId?: string;
    providerRaw: unknown;
    observedAt: Date;
    nextPollAt?: Date;
  }) {
    await this.db.transaction(async (tx) => {
      const [item] = await tx
        .select()
        .from(publisherItems)
        .where(eq(publisherItems.id, input.itemId))
        .for("update")
        .limit(1);
      if (!item)
        throw new RepositoryError("NOT_FOUND", "Publisher item not found");
      if (item.externalOrderId !== input.providerOrderId) {
        throw new RepositoryError(
          "CONFLICT",
          "Provider order does not match item",
        );
      }
      let reportedPrice: bigint | null = null;
      if (input.reportedPrice !== undefined) {
        try {
          reportedPrice = publisherPriceToTenThousandths(input.reportedPrice);
        } catch {
          reportedPrice = null;
        }
      }
      const [priceSnapshot] = await tx
        .select({
          amount: mediaPublishingItemPriceSnapshots.amountTenThousandths,
        })
        .from(mediaPublishingItemPriceSnapshots)
        .where(eq(mediaPublishingItemPriceSnapshots.itemId, item.id))
        .limit(1);
      await insertProviderObservationAudit(
        tx,
        item,
        input.providerRaw,
        input.observedAt,
      );
      if (
        priceSnapshot &&
        publisherReportedPriceMismatch(reportedPrice, priceSnapshot.amount) &&
        item.reportedOrderPriceTenThousandths !== reportedPrice
      ) {
        await insertProviderPriceMismatchAudit(tx, {
          item,
          customerPrice: priceSnapshot.amount,
          reportedPrice: reportedPrice!,
          observedAt: input.observedAt,
        });
      }
      if (terminalItem(item.status)) return;
      if (
        (input.providerStatus === "processing" ||
          input.providerStatus === "unknown") &&
        !input.nextPollAt
      ) {
        throw new RepositoryError(
          "INVALID_STATE",
          "Non-terminal provider observations require a next authoritative poll",
        );
      }
      if (input.providerStatus === "processing") {
        const nextStatus = publisherStatusForProcessingObservation(item.status);
        await tx
          .update(publisherItems)
          .set({
            status: nextStatus,
            actionRequiredReason:
              nextStatus === "action_required"
                ? item.actionRequiredReason
                : null,
            lastPolledAt: input.observedAt,
            nextPollAt: input.nextPollAt ?? null,
            reportedOrderPriceTenThousandths: reportedPrice,
            externalManuscriptId:
              input.manuscriptId ?? item.externalManuscriptId,
          })
          .where(eq(publisherItems.id, item.id));
        return;
      }
      if (input.providerStatus === "success" && input.publishedUrl) {
        await tx
          .update(publisherItems)
          .set({
            status: "success",
            publishedUrl: input.publishedUrl,
            reportedOrderPriceTenThousandths: reportedPrice,
            externalManuscriptId: input.manuscriptId ?? null,
            lastPolledAt: input.observedAt,
            nextPollAt: null,
            completedAt: input.observedAt,
          })
          .where(eq(publisherItems.id, item.id));
        await settlePublisherItemMoney(tx, {
          itemId: item.id,
          settlement: "consumed",
          settledAt: input.observedAt,
          reason: "Provider confirmed publication with a final URL",
        });
      } else if (input.providerStatus === "failed") {
        await tx
          .update(publisherItems)
          .set({
            status: "failed",
            failureReason: truncate(
              input.failureReason ?? "Provider rejected publication",
              4_000,
            ),
            reportedOrderPriceTenThousandths: reportedPrice,
            lastPolledAt: input.observedAt,
            nextPollAt: null,
            completedAt: input.observedAt,
          })
          .where(eq(publisherItems.id, item.id));
        await settlePublisherItemMoney(tx, {
          itemId: item.id,
          settlement: "released",
          settledAt: input.observedAt,
          reason: "Provider confirmed publication failure",
        });
      } else {
        await tx
          .update(publisherItems)
          .set({
            status: "action_required",
            actionRequiredReason: truncate(
              input.actionRequiredReason ??
                (input.providerStatus === "success"
                  ? "Provider reported success without a final URL"
                  : "Provider order status requires reconciliation"),
              4_000,
            ),
            reportedOrderPriceTenThousandths: reportedPrice,
            lastPolledAt: input.observedAt,
            nextPollAt: input.nextPollAt ?? null,
          })
          .where(eq(publisherItems.id, item.id));
        await settlePublisherItemMoney(tx, {
          itemId: item.id,
          settlement: "frozen",
          settledAt: input.observedAt,
          reason: "Provider result requires reconciliation",
        });
      }
      await refreshBatchState(tx, item.batchId, input.observedAt);
    });
  }

  async beginKolCatalogSync(input: {
    runId: string;
    leaseToken?: string;
    startedAt: Date;
    leaseExpiresAt?: Date;
  }) {
    const leaseToken = catalogSyncLeaseToken(input.runId, input.leaseToken);
    const leaseExpiresAt =
      input.leaseExpiresAt ?? new Date(input.startedAt.getTime() + 5 * 60_000);
    if (
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(
        input.runId,
      ) ||
      !Number.isFinite(input.startedAt.getTime()) ||
      !Number.isFinite(leaseExpiresAt.getTime()) ||
      leaseExpiresAt <= input.startedAt
    ) {
      throw new RepositoryError("INVALID_STATE", "Invalid catalog sync run");
    }
    return this.db.transaction(async (tx) => {
      await tx
        .insert(publisherSubmissionGate)
        .values({ id: CATALOG_SYNC_GATE_ID, nextAllowedAt: new Date(0) })
        .onDuplicateKeyUpdate({
          set: { id: sql`${publisherSubmissionGate.id}` },
        });
      const [gate] = await tx
        .select()
        .from(publisherSubmissionGate)
        .where(eq(publisherSubmissionGate.id, CATALOG_SYNC_GATE_ID))
        .for("update")
        .limit(1);
      if (!gate) {
        throw new RepositoryError(
          "INVALID_STATE",
          "Catalog synchronization gate is missing",
        );
      }
      if (
        gate.leaseOwner &&
        gate.leaseOwner !== leaseToken &&
        gate.leaseExpiresAt &&
        gate.leaseExpiresAt > input.startedAt
      ) {
        return {
          alreadyComplete: false,
          acquired: false,
          retryAt: gate.leaseExpiresAt,
        };
      }
      const supersededRunId = catalogSyncRunIdFromLeaseToken(gate.leaseOwner);
      if (
        gate.leaseOwner &&
        gate.leaseOwner !== leaseToken &&
        supersededRunId &&
        supersededRunId !== input.runId
      ) {
        const reason =
          "Catalog synchronization lease expired and was superseded";
        await tx
          .update(publisherMediaSyncRuns)
          .set({
            status: "failed",
            completedAt: input.startedAt,
            recordsChanged: 0,
            stopReason: reason,
            error: { message: reason },
            isComplete: false,
          })
          .where(
            and(
              eq(publisherMediaSyncRuns.id, supersededRunId),
              eq(publisherMediaSyncRuns.status, "running"),
            ),
          );
      }
      await tx
        .update(publisherSubmissionGate)
        .set({ leaseOwner: leaseToken, leaseExpiresAt })
        .where(eq(publisherSubmissionGate.id, CATALOG_SYNC_GATE_ID));

      const [existing] = await tx
        .select({ status: publisherMediaSyncRuns.status })
        .from(publisherMediaSyncRuns)
        .where(eq(publisherMediaSyncRuns.id, input.runId))
        .for("update")
        .limit(1);
      if (!existing) {
        await tx.insert(publisherMediaSyncRuns).values({
          id: input.runId,
          catalogRevision: sha256(`publisher:catalog:pending:${input.runId}`),
          status: "running",
          startedAt: input.startedAt,
        });
        return { alreadyComplete: false, acquired: true };
      }
      if (existing.status === "success" || existing.status === "partial") {
        await tx
          .update(publisherSubmissionGate)
          .set({ leaseOwner: null, leaseExpiresAt: null })
          .where(
            and(
              eq(publisherSubmissionGate.id, CATALOG_SYNC_GATE_ID),
              eq(publisherSubmissionGate.leaseOwner, leaseToken),
            ),
          );
        return { alreadyComplete: true, acquired: false };
      }
      // A leased job can be retried after a process interruption. Restart the
      // page stream from a clean staging set so counters and duplicate evidence
      // remain deterministic rather than accumulating across attempts.
      await tx
        .delete(publisherMediaSyncStaging)
        .where(eq(publisherMediaSyncStaging.runId, input.runId));
      await tx
        .update(publisherMediaSyncRuns)
        .set({
          catalogRevision: sha256(`publisher:catalog:pending:${input.runId}`),
          status: "running",
          startedAt: input.startedAt,
          completedAt: null,
          pagesFetched: 0,
          pagesExpected: 0,
          recordsSeen: 0,
          newsRecords: 0,
          selfMediaRecords: 0,
          invalidRecords: 0,
          duplicateRecords: 0,
          crossKindDuplicateRecords: 0,
          recordsChanged: 0,
          stopReason: null,
          error: null,
          isComplete: false,
        })
        .where(eq(publisherMediaSyncRuns.id, input.runId));
      return { alreadyComplete: false, acquired: true };
    });
  }

  async failKolCatalogSync(input: {
    runId: string;
    leaseToken?: string;
    failedAt: Date;
    pagesFetched: number;
    recordsSeen: number;
    reason: string;
  }) {
    if (
      !Number.isFinite(input.failedAt.getTime()) ||
      !Number.isSafeInteger(input.pagesFetched) ||
      input.pagesFetched < 0 ||
      !Number.isSafeInteger(input.recordsSeen) ||
      input.recordsSeen < 0
    ) {
      throw new RepositoryError(
        "INVALID_STATE",
        "Invalid catalog sync failure evidence",
      );
    }
    const leaseToken = catalogSyncLeaseToken(input.runId, input.leaseToken);
    const reason = truncate(input.reason.trim() || "Catalog sync failed", 240);
    await this.db.transaction(async (tx) => {
      const [gate] = await tx
        .select({ leaseOwner: publisherSubmissionGate.leaseOwner })
        .from(publisherSubmissionGate)
        .where(eq(publisherSubmissionGate.id, CATALOG_SYNC_GATE_ID))
        .for("update")
        .limit(1);
      // A timed-out executor may report an error after a newer executor has
      // taken over the same durable job. Its token must not fail the new run or
      // release the new owner's lease.
      if (gate?.leaseOwner !== leaseToken) return;
      await tx
        .update(publisherMediaSyncRuns)
        .set({
          status: "failed",
          completedAt: input.failedAt,
          pagesFetched: input.pagesFetched,
          recordsSeen: input.recordsSeen,
          recordsChanged: 0,
          stopReason: reason,
          error: { message: reason },
          isComplete: false,
        })
        .where(
          and(
            eq(publisherMediaSyncRuns.id, input.runId),
            eq(publisherMediaSyncRuns.status, "running"),
          ),
        );
      await tx
        .update(publisherSubmissionGate)
        .set({ leaseOwner: null, leaseExpiresAt: null })
        .where(
          and(
            eq(publisherSubmissionGate.id, CATALOG_SYNC_GATE_ID),
            eq(publisherSubmissionGate.leaseOwner, leaseToken),
          ),
        );
    });
  }

  async cleanupExpiredKolCatalogSyncStaging(input: {
    completedBefore: Date;
    limit: number;
  }) {
    if (
      !Number.isFinite(input.completedBefore.getTime()) ||
      !Number.isSafeInteger(input.limit) ||
      input.limit < 1 ||
      input.limit > 5_000
    ) {
      throw new RepositoryError(
        "INVALID_STATE",
        "Invalid catalog staging cleanup request",
      );
    }
    const candidates = await this.db
      .select({
        runId: publisherMediaSyncStaging.runId,
        externalResourceId: publisherMediaSyncStaging.externalResourceId,
      })
      .from(publisherMediaSyncStaging)
      .innerJoin(
        publisherMediaSyncRuns,
        eq(publisherMediaSyncRuns.id, publisherMediaSyncStaging.runId),
      )
      .where(
        or(
          eq(publisherMediaSyncRuns.status, "success"),
          and(
            inArray(publisherMediaSyncRuns.status, ["partial", "failed"]),
            lte(publisherMediaSyncRuns.completedAt, input.completedBefore),
          ),
        ),
      )
      .orderBy(
        asc(publisherMediaSyncStaging.stagedAt),
        asc(publisherMediaSyncStaging.runId),
        asc(publisherMediaSyncStaging.externalResourceId),
      )
      .limit(input.limit);
    if (!candidates.length) return 0;

    await this.db.transaction(async (tx) => {
      const byRun = new Map<string, string[]>();
      for (const candidate of candidates) {
        const values = byRun.get(candidate.runId) ?? [];
        values.push(candidate.externalResourceId);
        byRun.set(candidate.runId, values);
      }
      for (const [runId, externalResourceIds] of byRun) {
        await tx
          .delete(publisherMediaSyncStaging)
          .where(
            and(
              eq(publisherMediaSyncStaging.runId, runId),
              inArray(
                publisherMediaSyncStaging.externalResourceId,
                externalResourceIds,
              ),
            ),
          );
      }
    });
    return candidates.length;
  }

  async stageKolCatalogPage(input: {
    runId: string;
    leaseToken?: string;
    page: number;
    expectedLastPage: number;
    resources: readonly KolResourceInput[];
    stagedAt: Date;
    leaseExpiresAt?: Date;
  }) {
    const leaseToken = catalogSyncLeaseToken(input.runId, input.leaseToken);
    const leaseExpiresAt =
      input.leaseExpiresAt ?? new Date(input.stagedAt.getTime() + 5 * 60_000);
    if (
      !Number.isSafeInteger(input.page) ||
      input.page < 1 ||
      !Number.isSafeInteger(input.expectedLastPage) ||
      input.expectedLastPage < input.page ||
      !Number.isFinite(input.stagedAt.getTime()) ||
      !Number.isFinite(leaseExpiresAt.getTime()) ||
      leaseExpiresAt <= input.stagedAt
    ) {
      throw new RepositoryError(
        "INVALID_STATE",
        "Invalid catalog page evidence",
      );
    }

    const firstByExternalId = new Map<
      string,
      NonNullable<ReturnType<typeof normalizeCatalogResource>>
    >();
    let newsRecords = 0;
    let selfMediaRecords = 0;
    let invalidRecords = 0;
    let duplicateRecords = 0;
    let crossKindDuplicateRecords = 0;
    for (const rawResource of input.resources) {
      const resource = normalizeCatalogResource(rawResource);
      if (!resource) {
        invalidRecords += 1;
        continue;
      }
      if (resource.mediaKind === "news") newsRecords += 1;
      else selfMediaRecords += 1;
      const previous = firstByExternalId.get(resource.externalResourceId);
      if (previous) {
        duplicateRecords += 1;
        if (previous.mediaKind !== resource.mediaKind) {
          crossKindDuplicateRecords += 1;
        }
        continue;
      }
      firstByExternalId.set(resource.externalResourceId, resource);
    }

    return this.db.transaction(async (tx) => {
      const [gate] = await tx
        .select()
        .from(publisherSubmissionGate)
        .where(eq(publisherSubmissionGate.id, CATALOG_SYNC_GATE_ID))
        .for("update")
        .limit(1);
      if (
        gate?.leaseOwner !== leaseToken ||
        !gate.leaseExpiresAt ||
        gate.leaseExpiresAt <= input.stagedAt
      ) {
        throw new RepositoryError(
          "CONFLICT",
          "Catalog synchronization lease is no longer owned by this executor",
        );
      }
      const [run] = await tx
        .select()
        .from(publisherMediaSyncRuns)
        .where(eq(publisherMediaSyncRuns.id, input.runId))
        .for("update")
        .limit(1);
      if (!run) {
        throw new RepositoryError("NOT_FOUND", "Catalog sync run not found");
      }
      if (run.status !== "running") {
        throw new RepositoryError(
          "CONFLICT",
          "Catalog sync run is no longer active",
        );
      }
      if (
        input.page !== run.pagesFetched + 1 ||
        (run.pagesExpected !== 0 &&
          run.pagesExpected !== input.expectedLastPage)
      ) {
        throw new RepositoryError(
          "INVALID_STATE",
          "Catalog pages were not staged in one complete stable sequence",
        );
      }

      const stagedByExternalId = new Map<
        string,
        { mediaKind: "news" | "self_media" | null }
      >();
      const externalIds = [...firstByExternalId.keys()];
      for (let offset = 0; offset < externalIds.length; offset += 500) {
        const chunk = externalIds.slice(offset, offset + 500);
        if (!chunk.length) continue;
        const rows = await tx
          .select({
            externalResourceId: publisherMediaSyncStaging.externalResourceId,
            mediaKind: publisherMediaSyncStaging.mediaKind,
          })
          .from(publisherMediaSyncStaging)
          .where(
            and(
              eq(publisherMediaSyncStaging.runId, input.runId),
              inArray(publisherMediaSyncStaging.externalResourceId, chunk),
            ),
          )
          .for("update");
        for (const row of rows) {
          stagedByExternalId.set(row.externalResourceId, {
            mediaKind: row.mediaKind,
          });
        }
      }

      const newResources = [];
      for (const resource of firstByExternalId.values()) {
        const previous = stagedByExternalId.get(resource.externalResourceId);
        if (previous) {
          duplicateRecords += 1;
          if (previous.mediaKind !== resource.mediaKind) {
            crossKindDuplicateRecords += 1;
          }
          continue;
        }
        newResources.push(resource);
      }
      for (let offset = 0; offset < newResources.length; offset += 500) {
        await tx.insert(publisherMediaSyncStaging).values(
          newResources.slice(offset, offset + 500).map((resource) => ({
            runId: input.runId,
            externalResourceId: resource.externalResourceId,
            page: input.page,
            name: resource.name,
            mediaKind: resource.mediaKind,
            platform: resource.platform,
            taxonomy: resource.taxonomy,
            mediaType: resource.mediaType,
            area: resource.area,
            caseUrl: resource.caseUrl,
            titleLimit: resource.titleLimit,
            priceTenThousandths: resource.priceTenThousandths,
            successRateBasisPoints: resource.successRateBasisPoints,
            includeRateBasisPoints: resource.includeRateBasisPoints,
            pcWeight: resource.pcWeight,
            mobileWeight: resource.mobileWeight,
            includeType: resource.includeType,
            publishSpeed: resource.publishSpeed,
            entryUrl: resource.entryUrl,
            entryLevel: resource.entryLevel,
            linkType: resource.linkType,
            providerLogoUrl: resource.providerLogoUrl,
            providerIconUrl: resource.providerIconUrl,
            logoCandidateHash: resource.logoCandidateHash,
            remark: resource.remark,
            description: resource.description,
            recommended: resource.recommended,
            authenticated: resource.authenticated,
            festivalPublishable: resource.festivalPublishable,
            fanCount: resource.fanCount,
            likeCount: resource.likeCount,
            publishCount: resource.publishCount,
            rawPayload: resource.rawPayload,
            payloadHash: resource.payloadHash,
            stagedAt: input.stagedAt,
          })),
        );
      }
      await tx
        .update(publisherMediaSyncRuns)
        .set({
          pagesFetched: input.page,
          pagesExpected: input.expectedLastPage,
          recordsSeen: sql`${publisherMediaSyncRuns.recordsSeen} + ${input.resources.length}`,
          newsRecords: sql`${publisherMediaSyncRuns.newsRecords} + ${newsRecords}`,
          selfMediaRecords: sql`${publisherMediaSyncRuns.selfMediaRecords} + ${selfMediaRecords}`,
          invalidRecords: sql`${publisherMediaSyncRuns.invalidRecords} + ${invalidRecords}`,
          duplicateRecords: sql`${publisherMediaSyncRuns.duplicateRecords} + ${duplicateRecords}`,
          crossKindDuplicateRecords: sql`${publisherMediaSyncRuns.crossKindDuplicateRecords} + ${crossKindDuplicateRecords}`,
        })
        .where(eq(publisherMediaSyncRuns.id, input.runId));
      await tx
        .update(publisherSubmissionGate)
        .set({ leaseExpiresAt })
        .where(
          and(
            eq(publisherSubmissionGate.id, CATALOG_SYNC_GATE_ID),
            eq(publisherSubmissionGate.leaseOwner, leaseToken),
          ),
        );
      return {
        invalidRecords,
        duplicateRecords,
        crossKindDuplicateRecords,
      };
    });
  }

  async finalizeKolCatalogSync(input: {
    runId: string;
    leaseToken?: string;
    expectedLastPage: number;
    syncedAt: Date;
    leaseExpiresAt?: Date;
  }) {
    const leaseToken = catalogSyncLeaseToken(input.runId, input.leaseToken);
    const leaseExpiresAt =
      input.leaseExpiresAt ?? new Date(input.syncedAt.getTime() + 5 * 60_000);
    if (
      !Number.isSafeInteger(input.expectedLastPage) ||
      input.expectedLastPage < 1 ||
      !Number.isFinite(input.syncedAt.getTime()) ||
      !Number.isFinite(leaseExpiresAt.getTime()) ||
      leaseExpiresAt <= input.syncedAt
    ) {
      throw new RepositoryError(
        "INVALID_STATE",
        "Invalid catalog finalization evidence",
      );
    }
    await this.db.transaction(async (tx) => {
      const [gate] = await tx
        .select()
        .from(publisherSubmissionGate)
        .where(eq(publisherSubmissionGate.id, CATALOG_SYNC_GATE_ID))
        .for("update")
        .limit(1);
      if (
        gate?.leaseOwner !== leaseToken ||
        !gate.leaseExpiresAt ||
        gate.leaseExpiresAt <= input.syncedAt
      ) {
        throw new RepositoryError(
          "CONFLICT",
          "Catalog synchronization lease is no longer owned by this executor",
        );
      }
      await tx
        .update(publisherSubmissionGate)
        .set({ leaseExpiresAt })
        .where(
          and(
            eq(publisherSubmissionGate.id, CATALOG_SYNC_GATE_ID),
            eq(publisherSubmissionGate.leaseOwner, leaseToken),
          ),
        );
    });
    const [run] = await this.db
      .select()
      .from(publisherMediaSyncRuns)
      .where(eq(publisherMediaSyncRuns.id, input.runId))
      .limit(1);
    if (!run) {
      throw new RepositoryError("NOT_FOUND", "Catalog sync run not found");
    }
    if (run.status === "success" || run.status === "partial") {
      await this.db
        .update(publisherSubmissionGate)
        .set({ leaseOwner: null, leaseExpiresAt: null })
        .where(
          and(
            eq(publisherSubmissionGate.id, CATALOG_SYNC_GATE_ID),
            eq(publisherSubmissionGate.leaseOwner, leaseToken),
          ),
        );
      return;
    }
    if (run.status !== "running") {
      throw new RepositoryError(
        "CONFLICT",
        "Catalog sync run is no longer active",
      );
    }
    const [staged] = await this.db
      .select({
        records: count(),
        positiveNews:
          sql<number>`sum(case when ${publisherMediaSyncStaging.mediaKind} = 'news' and ${publisherMediaSyncStaging.priceTenThousandths} > 0 then 1 else 0 end)`.mapWith(
            Number,
          ),
        positiveSelfMedia:
          sql<number>`sum(case when ${publisherMediaSyncStaging.mediaKind} = 'self_media' and ${publisherMediaSyncStaging.priceTenThousandths} > 0 then 1 else 0 end)`.mapWith(
            Number,
          ),
      })
      .from(publisherMediaSyncStaging)
      .where(eq(publisherMediaSyncStaging.runId, input.runId));
    const stagedRecords = staged?.records ?? 0;
    const expectedUniqueRecords =
      run.newsRecords + run.selfMediaRecords - run.duplicateRecords;
    // Unavailable individual rows are excluded by staging and reconciled in
    // invalidRecords below; they must not hide the remaining complete catalog.
    const incompleteReason =
      run.pagesExpected !== input.expectedLastPage ||
      run.pagesFetched !== input.expectedLastPage
        ? "Catalog pagination was incomplete"
        : run.recordsSeen !==
              run.newsRecords + run.selfMediaRecords + run.invalidRecords ||
            stagedRecords !== expectedUniqueRecords
          ? "Catalog staging counters did not reconcile"
          : run.crossKindDuplicateRecords > 0
            ? "Catalog contains one resource id in multiple media categories"
            : stagedRecords === 0
              ? "Catalog sync returned no priced resources"
              : (staged?.positiveNews ?? 0) === 0 ||
                  (staged?.positiveSelfMedia ?? 0) === 0
                ? "Catalog does not contain positive-price news and self-media resources"
                : null;
    const revision = await this.catalogRevisionForStaging(input.runId);
    if (incompleteReason) {
      await this.db.transaction(async (tx) => {
        const [gate] = await tx
          .select({ leaseOwner: publisherSubmissionGate.leaseOwner })
          .from(publisherSubmissionGate)
          .where(eq(publisherSubmissionGate.id, CATALOG_SYNC_GATE_ID))
          .for("update")
          .limit(1);
        if (gate?.leaseOwner !== leaseToken) {
          throw new RepositoryError(
            "CONFLICT",
            "Catalog synchronization lease is no longer owned by this executor",
          );
        }
        const [lockedRun] = await tx
          .select({ status: publisherMediaSyncRuns.status })
          .from(publisherMediaSyncRuns)
          .where(eq(publisherMediaSyncRuns.id, input.runId))
          .for("update")
          .limit(1);
        if (lockedRun?.status !== "running") {
          throw new RepositoryError(
            "CONFLICT",
            "Catalog sync run is no longer active",
          );
        }
        await tx
          .update(publisherMediaSyncRuns)
          .set({
            status: "partial",
            catalogRevision: revision,
            completedAt: input.syncedAt,
            recordsChanged: 0,
            isComplete: false,
            stopReason: incompleteReason,
          })
          .where(eq(publisherMediaSyncRuns.id, input.runId));
        await tx
          .update(publisherSubmissionGate)
          .set({ leaseOwner: null, leaseExpiresAt: null })
          .where(
            and(
              eq(publisherSubmissionGate.id, CATALOG_SYNC_GATE_ID),
              eq(publisherSubmissionGate.leaseOwner, leaseToken),
            ),
          );
      });
      return;
    }

    // Staging is fully validated before this transaction. Activation uses
    // set-based statements so the catalog lock is held for a bounded number of
    // database round trips instead of one update per media row.
    await this.db.transaction(async (tx) => {
      const [gate] = await tx
        .select({ leaseOwner: publisherSubmissionGate.leaseOwner })
        .from(publisherSubmissionGate)
        .where(eq(publisherSubmissionGate.id, CATALOG_SYNC_GATE_ID))
        .for("update")
        .limit(1);
      if (gate?.leaseOwner !== leaseToken) {
        throw new RepositoryError(
          "CONFLICT",
          "Catalog synchronization lease is no longer owned by this executor",
        );
      }
      const [lockedRun] = await tx
        .select()
        .from(publisherMediaSyncRuns)
        .where(eq(publisherMediaSyncRuns.id, input.runId))
        .for("update")
        .limit(1);
      if (!lockedRun || lockedRun.status !== "running") {
        throw new RepositoryError(
          "CONFLICT",
          "Catalog sync run is no longer active",
        );
      }
      await tx
        .insert(publisherRuntimeState)
        .values({ id: "kol" })
        .onDuplicateKeyUpdate({
          set: { id: sql`${publisherRuntimeState.id}` },
        });
      await tx
        .select()
        .from(publisherRuntimeState)
        .where(eq(publisherRuntimeState.id, "kol"))
        .for("update")
        .limit(1);
      await tx.execute(sql`
        insert into publisher_media_resources (
          id, external_resource_id, catalog_revision, name, media_kind,
          platform, taxonomy, media_type, area, case_url, title_limit,
          price_ten_thousandths, success_rate_basis_points,
          include_rate_basis_points, pc_weight, mobile_weight, include_type,
          publish_speed, entry_url, entry_level, link_type, logo_url,
          provider_icon_url, logo_candidate_hash, logo_archive_status,
          logo_checked_at, remark, description, recommended, authenticated,
          festival_publishable, fan_count, like_count, publish_count,
          raw_payload, payload_hash, is_active, consecutive_misses,
          last_seen_complete_run_id, last_seen_at, inactive_at
        )
        select
          uuid(), s.external_resource_id, ${revision}, s.name, s.media_kind,
          s.platform, s.taxonomy, s.media_type, s.area, s.case_url,
          s.title_limit, s.price_ten_thousandths,
          s.success_rate_basis_points, s.include_rate_basis_points,
          s.pc_weight, s.mobile_weight, s.include_type, s.publish_speed,
          s.entry_url, s.entry_level, s.link_type, s.logo_url,
          s.provider_icon_url, s.logo_candidate_hash,
          if(s.logo_candidate_hash is null, 'missing', 'pending'),
          if(s.logo_candidate_hash is null, ${input.syncedAt}, null),
          s.remark, s.description, s.recommended, s.authenticated,
          s.festival_publishable, s.fan_count, s.like_count, s.publish_count,
          s.raw_payload, s.payload_hash, true, 0, ${input.runId},
          ${input.syncedAt}, null
        from publisher_media_sync_staging s
        where s.run_id = ${input.runId}
        on duplicate key update
          logo_archive_status = case
            when not (publisher_media_resources.logo_candidate_hash <=> values(logo_candidate_hash))
              then if(values(logo_candidate_hash) is null, 'missing', 'pending')
            when values(logo_candidate_hash) is not null
              and publisher_media_resources.logo_archive_status <> 'archived'
              then 'pending'
            else publisher_media_resources.logo_archive_status
          end,
          logo_source_kind = if(
            not (publisher_media_resources.logo_candidate_hash <=> values(logo_candidate_hash)),
            null, publisher_media_resources.logo_source_kind
          ),
          logo_source_url = if(
            not (publisher_media_resources.logo_candidate_hash <=> values(logo_candidate_hash)),
            null, publisher_media_resources.logo_source_url
          ),
          logo_object_key = if(
            not (publisher_media_resources.logo_candidate_hash <=> values(logo_candidate_hash)),
            null, publisher_media_resources.logo_object_key
          ),
          logo_content_type = if(
            not (publisher_media_resources.logo_candidate_hash <=> values(logo_candidate_hash)),
            null, publisher_media_resources.logo_content_type
          ),
          logo_size_bytes = if(
            not (publisher_media_resources.logo_candidate_hash <=> values(logo_candidate_hash)),
            null, publisher_media_resources.logo_size_bytes
          ),
          logo_sha256 = if(
            not (publisher_media_resources.logo_candidate_hash <=> values(logo_candidate_hash)),
            null, publisher_media_resources.logo_sha256
          ),
          logo_checked_at = case
            when not (publisher_media_resources.logo_candidate_hash <=> values(logo_candidate_hash))
              then if(values(logo_candidate_hash) is null, ${input.syncedAt}, null)
            else publisher_media_resources.logo_checked_at
          end,
          logo_archive_error = if(
            values(logo_candidate_hash) is not null
              and publisher_media_resources.logo_archive_status <> 'archived',
            null, publisher_media_resources.logo_archive_error
          ),
          logo_review_audit = if(
            values(logo_candidate_hash) is not null
              and publisher_media_resources.logo_archive_status <> 'archived',
            null, publisher_media_resources.logo_review_audit
          ),
          catalog_revision = values(catalog_revision),
          name = values(name), media_kind = values(media_kind),
          platform = values(platform), taxonomy = values(taxonomy),
          media_type = values(media_type), area = values(area),
          case_url = values(case_url), title_limit = values(title_limit),
          price_ten_thousandths = values(price_ten_thousandths),
          success_rate_basis_points = values(success_rate_basis_points),
          include_rate_basis_points = values(include_rate_basis_points),
          pc_weight = values(pc_weight), mobile_weight = values(mobile_weight),
          include_type = values(include_type), publish_speed = values(publish_speed),
          entry_url = values(entry_url), entry_level = values(entry_level),
          link_type = values(link_type), logo_url = values(logo_url),
          provider_icon_url = values(provider_icon_url),
          remark = values(remark), description = values(description),
          recommended = values(recommended), authenticated = values(authenticated),
          festival_publishable = values(festival_publishable),
          fan_count = values(fan_count), like_count = values(like_count),
          publish_count = values(publish_count), raw_payload = values(raw_payload),
          payload_hash = values(payload_hash), is_active = true,
          consecutive_misses = 0,
          last_seen_complete_run_id = values(last_seen_complete_run_id),
          last_seen_at = values(last_seen_at), inactive_at = null,
          logo_candidate_hash = values(logo_candidate_hash)
      `);
      await tx.execute(sql`
        update publisher_media_resources r
        left join publisher_media_sync_staging s
          on s.run_id = ${input.runId}
          and s.external_resource_id = r.external_resource_id
        set
          r.is_active = if(r.consecutive_misses + 1 < 2, true, false),
          r.inactive_at = if(r.consecutive_misses + 1 >= 2, ${input.syncedAt}, null),
          r.consecutive_misses = r.consecutive_misses + 1
        where s.external_resource_id is null
      `);
      await tx.execute(sql`
        update publisher_media_logo_resolutions resolution
        inner join publisher_media_resources resource
          on resource.id = resolution.media_resource_id
          and resource.last_seen_complete_run_id = ${input.runId}
        set
          resolution.status = 'failed',
          resolution.source_kind = null,
          resolution.logo_sha256 = null,
          resolution.error_code = 'logo_candidate_superseded',
          resolution.review_audit = null,
          resolution.checked_at = ${input.syncedAt}
        where resolution.status = 'pending'
          and resolution.candidate_hash <> resource.logo_candidate_hash
      `);
      await tx.execute(sql`
        update publisher_media_logo_resolutions resolution
        inner join publisher_media_resources resource
          on resource.id = resolution.media_resource_id
          and resource.last_seen_complete_run_id = ${input.runId}
        set
          resolution.status = resource.logo_archive_status,
          resolution.source_kind = resource.logo_source_kind,
          resolution.logo_sha256 = resource.logo_sha256,
          resolution.error_code = resource.logo_archive_error,
          resolution.review_audit = resource.logo_review_audit,
          resolution.checked_at = resource.logo_checked_at
        where resolution.status = 'pending'
          and resolution.candidate_hash = resource.logo_candidate_hash
          and resource.logo_archive_status <> 'pending'
      `);
      await tx.execute(sql`
        insert into publisher_media_logo_resolutions (
          id, sync_run_id, media_resource_id, candidate_hash, status,
          source_kind, logo_sha256, error_code, review_audit, checked_at
        )
        select
          uuid(), ${input.runId}, r.id, r.logo_candidate_hash,
          case
            when r.logo_archive_status = 'archived'
              and r.logo_source_kind in ('site_favicon', 'generated_fallback')
              then 'pending'
            else r.logo_archive_status
          end,
          r.logo_source_kind, r.logo_sha256,
          r.logo_archive_error, r.logo_review_audit, r.logo_checked_at
        from publisher_media_resources r
        where r.last_seen_complete_run_id = ${input.runId}
          and r.logo_candidate_hash is not null
        on duplicate key update
          candidate_hash = values(candidate_hash),
          status = values(status),
          source_kind = values(source_kind),
          logo_sha256 = values(logo_sha256),
          error_code = values(error_code),
          review_audit = values(review_audit),
          checked_at = values(checked_at)
      `);
      await tx.execute(sql`
        insert into publisher_jobs (
          id, type, deterministic_key, aggregate_id, payload,
          available_at, max_attempts
        )
        select
          uuid(), 'archive_publisher_media_logo',
          concat('publisher:media-logo:', r.id, ':', r.logo_candidate_hash, ':', ${input.runId}),
          r.id,
          json_object(
            'mediaResourceId', r.id,
            'candidateHash', r.logo_candidate_hash,
            'syncRunId', ${input.runId}
          ),
          ${input.syncedAt}, 3
        from publisher_media_resources r
        where r.last_seen_complete_run_id = ${input.runId}
          and r.logo_candidate_hash is not null
          and (
            r.logo_archive_status = 'pending'
            or (
              r.logo_archive_status = 'archived'
              and r.logo_source_kind in ('site_favicon', 'generated_fallback')
            )
          )
        on duplicate key update deterministic_key = values(deterministic_key)
      `);
      await tx
        .update(publisherMediaSyncRuns)
        .set({
          status: "success",
          catalogRevision: revision,
          completedAt: input.syncedAt,
          recordsChanged: stagedRecords,
          isComplete: true,
          stopReason: null,
        })
        .where(eq(publisherMediaSyncRuns.id, input.runId));
      await tx
        .update(publisherRuntimeState)
        .set({
          activeCatalogRevision: revision,
          catalogSyncedAt: input.syncedAt,
          catalogKindComplete: true,
          credentialStatus: "healthy",
          credentialVerifiedAt: input.syncedAt,
          credentialFailedAt: null,
        })
        .where(eq(publisherRuntimeState.id, "kol"));
      await tx
        .delete(publisherMediaSyncStaging)
        .where(eq(publisherMediaSyncStaging.runId, input.runId));
      await tx
        .update(publisherSubmissionGate)
        .set({ leaseOwner: null, leaseExpiresAt: null })
        .where(
          and(
            eq(publisherSubmissionGate.id, CATALOG_SYNC_GATE_ID),
            eq(publisherSubmissionGate.leaseOwner, leaseToken),
          ),
        );
    });
  }

  /** Compatibility helper for repository integration fixtures. */
  async applyKolCatalogSync(input: {
    runId: string;
    resources: readonly KolResourceInput[];
    syncedAt: Date;
    pagesFetched?: number;
  }) {
    const leaseToken = catalogSyncLeaseToken(input.runId);
    await this.stageKolCatalogPage({
      runId: input.runId,
      leaseToken,
      page: 1,
      expectedLastPage: 1,
      resources: input.resources,
      stagedAt: input.syncedAt,
      leaseExpiresAt: new Date(input.syncedAt.getTime() + 5 * 60_000),
    });
    await this.finalizeKolCatalogSync({
      runId: input.runId,
      leaseToken,
      expectedLastPage: 1,
      syncedAt: input.syncedAt,
      leaseExpiresAt: new Date(input.syncedAt.getTime() + 5 * 60_000),
    });
  }

  private async catalogRevisionForStaging(runId: string) {
    const digest = createHash("sha256");
    let cursor = "";
    while (true) {
      const rows = await this.db
        .select({
          externalResourceId: publisherMediaSyncStaging.externalResourceId,
          payloadHash: publisherMediaSyncStaging.payloadHash,
        })
        .from(publisherMediaSyncStaging)
        .where(
          and(
            eq(publisherMediaSyncStaging.runId, runId),
            gt(publisherMediaSyncStaging.externalResourceId, cursor),
          ),
        )
        .orderBy(asc(publisherMediaSyncStaging.externalResourceId))
        .limit(500);
      for (const row of rows) {
        digest.update(
          `${row.externalResourceId.length}:${row.externalResourceId}:${row.payloadHash};`,
        );
      }
      if (rows.length < 500) break;
      cursor = rows.at(-1)?.externalResourceId ?? cursor;
    }
    return digest.digest("hex");
  }

  async getKolMediaLogoCandidate(mediaResourceId: string) {
    const [resource] = await this.db
      .select({
        mediaResourceId: publisherMediaResources.id,
        externalResourceId: publisherMediaResources.externalResourceId,
        catalogRevision: publisherMediaResources.catalogRevision,
        syncRunId: publisherMediaResources.lastSeenCompleteRunId,
        candidateHash: publisherMediaResources.logoCandidateHash,
        name: publisherMediaResources.name,
        platform: publisherMediaResources.platform,
        area: publisherMediaResources.area,
        caseUrl: publisherMediaResources.caseUrl,
        entryUrl: publisherMediaResources.entryUrl,
        providerLogoUrl: publisherMediaResources.providerLogoUrl,
        providerIconUrl: publisherMediaResources.providerIconUrl,
        archiveStatus: publisherMediaResources.logoArchiveStatus,
        sourceKind: publisherMediaResources.logoSourceKind,
        reviewAudit: publisherMediaResources.logoReviewAudit,
      })
      .from(publisherMediaResources)
      .where(eq(publisherMediaResources.id, mediaResourceId))
      .limit(1);
    if (
      !resource?.candidateHash ||
      !resource.syncRunId ||
      (resource.archiveStatus === "archived" &&
        resource.sourceKind !== "site_favicon" &&
        resource.sourceKind !== "generated_fallback")
    ) {
      return undefined;
    }
    const plan = publisherMediaLogoCandidatePlan(resource);
    return {
      mediaResourceId: resource.mediaResourceId,
      externalResourceId: resource.externalResourceId,
      catalogRevision: resource.catalogRevision,
      syncRunId: resource.syncRunId,
      candidateHash: resource.candidateHash,
      mediaName: resource.name,
      platform: resource.platform,
      area: resource.area,
      archiveStatus: resource.archiveStatus,
      sourceKind: resource.sourceKind,
      ...(resource.reviewAudit ? { reviewAudit: resource.reviewAudit } : {}),
      trustedDomains: plan.trustedDomains,
      candidates: plan.candidates,
    };
  }

  async completeKolMediaLogoArchive(input: {
    mediaResourceId: string;
    syncRunId: string;
    catalogRevision: string;
    candidateHash: string;
    sourceKind:
      | "logo"
      | "icon"
      | "site_favicon"
      | "web_search_verified"
      | "manual_verified"
      | "generated_fallback";
    sourceUrl: string;
    objectKey: string;
    contentType: "image/jpeg" | "image/png";
    sizeBytes: number;
    sha256: string;
    checkedAt: Date;
    reviewAudit?: {
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
  }) {
    if (
      !/^[a-f0-9]{64}$/u.test(input.candidateHash) ||
      !/^[a-f0-9]{64}$/u.test(input.sha256) ||
      !input.objectKey.startsWith("publisher/media-logos/") ||
      !Number.isSafeInteger(input.sizeBytes) ||
      input.sizeBytes < 1 ||
      input.sizeBytes > 2 * 1_024 * 1_024 ||
      !Number.isFinite(input.checkedAt.getTime())
    ) {
      throw new RepositoryError("INVALID_STATE", "Invalid archived media logo");
    }
    await this.db.transaction(async (tx) => {
      const [resource] = await tx
        .select({ id: publisherMediaResources.id })
        .from(publisherMediaResources)
        .where(
          and(
            eq(publisherMediaResources.id, input.mediaResourceId),
            eq(publisherMediaResources.logoCandidateHash, input.candidateHash),
            eq(publisherMediaResources.catalogRevision, input.catalogRevision),
            eq(publisherMediaResources.lastSeenCompleteRunId, input.syncRunId),
          ),
        )
        .for("update")
        .limit(1);
      if (!resource) return;
      await tx
        .insert(publisherMediaLogoAssets)
        .values({
          mediaResourceId: input.mediaResourceId,
          sha256: input.sha256,
          sourceKind: input.sourceKind,
          objectKey: input.objectKey,
          contentType: input.contentType,
          sizeBytes: BigInt(input.sizeBytes),
          catalogRevision: input.catalogRevision,
          reviewAudit: input.reviewAudit ?? null,
          archivedAt: input.checkedAt,
        })
        .onDuplicateKeyUpdate({
          set: { objectKey: sql`${publisherMediaLogoAssets.objectKey}` },
        });
      await tx
        .update(publisherMediaResources)
        .set({
          logoArchiveStatus: "archived",
          logoSourceKind: input.sourceKind,
          logoSourceUrl: input.sourceUrl,
          logoObjectKey: input.objectKey,
          logoContentType: input.contentType,
          logoSizeBytes: BigInt(input.sizeBytes),
          logoSha256: input.sha256,
          logoCheckedAt: input.checkedAt,
          logoArchiveError: null,
          logoReviewAudit: input.reviewAudit ?? null,
        })
        .where(eq(publisherMediaResources.id, input.mediaResourceId));
      await tx
        .update(publisherMediaLogoResolutions)
        .set({
          status: "archived",
          sourceKind: input.sourceKind,
          logoSha256: input.sha256,
          errorCode: null,
          reviewAudit: input.reviewAudit ?? null,
          checkedAt: input.checkedAt,
        })
        .where(
          and(
            eq(
              publisherMediaLogoResolutions.mediaResourceId,
              input.mediaResourceId,
            ),
            eq(
              publisherMediaLogoResolutions.candidateHash,
              input.candidateHash,
            ),
            eq(publisherMediaLogoResolutions.status, "pending"),
          ),
        );
      await tx
        .insert(publisherMediaLogoResolutions)
        .values({
          id: randomUUID(),
          syncRunId: input.syncRunId,
          mediaResourceId: input.mediaResourceId,
          candidateHash: input.candidateHash,
          status: "archived",
          sourceKind: input.sourceKind,
          logoSha256: input.sha256,
          errorCode: null,
          reviewAudit: input.reviewAudit ?? null,
          checkedAt: input.checkedAt,
        })
        .onDuplicateKeyUpdate({
          set: {
            candidateHash: input.candidateHash,
            status: "archived",
            sourceKind: input.sourceKind,
            logoSha256: input.sha256,
            errorCode: null,
            reviewAudit: input.reviewAudit ?? null,
            checkedAt: input.checkedAt,
          },
        });
    });
  }

  async carryForwardKolMediaLogoArchive(input: {
    mediaResourceId: string;
    syncRunId: string;
    candidateHash: string;
    checkedAt: Date;
  }) {
    if (
      !/^[a-f0-9]{64}$/u.test(input.candidateHash) ||
      !Number.isFinite(input.checkedAt.getTime())
    ) {
      throw new RepositoryError(
        "INVALID_STATE",
        "Invalid carried media logo resolution",
      );
    }
    await this.db.transaction(async (tx) => {
      const [resource] = await tx
        .select({
          archiveStatus: publisherMediaResources.logoArchiveStatus,
          sourceKind: publisherMediaResources.logoSourceKind,
          logoSha256: publisherMediaResources.logoSha256,
          errorCode: publisherMediaResources.logoArchiveError,
          reviewAudit: publisherMediaResources.logoReviewAudit,
        })
        .from(publisherMediaResources)
        .where(
          and(
            eq(publisherMediaResources.id, input.mediaResourceId),
            eq(publisherMediaResources.lastSeenCompleteRunId, input.syncRunId),
            eq(publisherMediaResources.logoCandidateHash, input.candidateHash),
          ),
        )
        .for("update")
        .limit(1);
      if (
        resource?.archiveStatus !== "archived" ||
        (resource.sourceKind !== "site_favicon" &&
          resource.sourceKind !== "generated_fallback") ||
        !resource.logoSha256
      ) {
        return;
      }
      await tx
        .update(publisherMediaLogoResolutions)
        .set({
          status: "archived",
          sourceKind: resource.sourceKind,
          logoSha256: resource.logoSha256,
          errorCode: resource.errorCode,
          reviewAudit: resource.reviewAudit,
          checkedAt: input.checkedAt,
        })
        .where(
          and(
            eq(publisherMediaLogoResolutions.syncRunId, input.syncRunId),
            eq(
              publisherMediaLogoResolutions.mediaResourceId,
              input.mediaResourceId,
            ),
            eq(
              publisherMediaLogoResolutions.candidateHash,
              input.candidateHash,
            ),
            eq(publisherMediaLogoResolutions.status, "pending"),
          ),
        );
    });
  }

  async failKolMediaLogoArchive(input: {
    mediaResourceId: string;
    syncRunId: string;
    candidateHash: string;
    errorCode: string;
    checkedAt: Date;
  }) {
    return this.recordKolMediaLogoFallback({
      ...input,
      status: "failed",
    });
  }

  async recordKolMediaLogoFallback(input: {
    mediaResourceId: string;
    syncRunId: string;
    candidateHash: string;
    status: "pending_review" | "missing" | "failed";
    errorCode: string;
    checkedAt: Date;
    reviewAudit?: {
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
  }) {
    if (
      !/^[a-f0-9]{64}$/u.test(input.candidateHash) ||
      !/^[a-z0-9_]{2,120}$/u.test(input.errorCode) ||
      !Number.isFinite(input.checkedAt.getTime())
    ) {
      throw new RepositoryError("INVALID_STATE", "Invalid media logo failure");
    }
    await this.db.transaction(async (tx) => {
      await tx
        .update(publisherMediaResources)
        .set({
          logoArchiveStatus: input.status,
          logoSourceKind: null,
          logoSourceUrl: null,
          logoObjectKey: null,
          logoContentType: null,
          logoSizeBytes: null,
          logoSha256: null,
          logoCheckedAt: input.checkedAt,
          logoArchiveError: input.errorCode,
          logoReviewAudit: input.reviewAudit ?? null,
        })
        .where(
          and(
            eq(publisherMediaResources.id, input.mediaResourceId),
            eq(publisherMediaResources.logoCandidateHash, input.candidateHash),
            eq(publisherMediaResources.lastSeenCompleteRunId, input.syncRunId),
          ),
        );
      await tx
        .update(publisherMediaLogoResolutions)
        .set({
          status: input.status,
          sourceKind: null,
          logoSha256: null,
          errorCode: input.errorCode,
          reviewAudit: input.reviewAudit ?? null,
          checkedAt: input.checkedAt,
        })
        .where(
          and(
            eq(
              publisherMediaLogoResolutions.mediaResourceId,
              input.mediaResourceId,
            ),
            eq(
              publisherMediaLogoResolutions.candidateHash,
              input.candidateHash,
            ),
            eq(publisherMediaLogoResolutions.status, "pending"),
          ),
        );
      await tx
        .insert(publisherMediaLogoResolutions)
        .values({
          id: randomUUID(),
          syncRunId: input.syncRunId,
          mediaResourceId: input.mediaResourceId,
          candidateHash: input.candidateHash,
          status: input.status,
          sourceKind: null,
          logoSha256: null,
          errorCode: input.errorCode,
          reviewAudit: input.reviewAudit ?? null,
          checkedAt: input.checkedAt,
        })
        .onDuplicateKeyUpdate({
          set: {
            candidateHash: input.candidateHash,
            status: input.status,
            sourceKind: null,
            logoSha256: null,
            errorCode: input.errorCode,
            reviewAudit: input.reviewAudit ?? null,
            checkedAt: input.checkedAt,
          },
        });
    });
  }

  async markKolCredentialAuthBlocked(input: { failedAt: Date }) {
    await this.db
      .insert(publisherRuntimeState)
      .values({
        id: "kol",
        credentialStatus: "auth_blocked",
        credentialFailedAt: input.failedAt,
      })
      .onDuplicateKeyUpdate({
        set: {
          credentialStatus: "auth_blocked",
          credentialFailedAt: input.failedAt,
        },
      });
  }

  async leasePublisherDocxImportImages(input: {
    importId: string;
    ownerId: string;
    storageKeys: readonly string[];
    leasedAt: Date;
    expiresAt: Date;
  }) {
    const storageKeys = [...new Set(input.storageKeys)];
    const expectedPrefix = `publisher-assets/${sha256(input.ownerId).slice(0, 24)}/`;
    if (
      storageKeys.length > 50 ||
      !Number.isFinite(input.leasedAt.getTime()) ||
      !Number.isFinite(input.expiresAt.getTime()) ||
      input.expiresAt <= input.leasedAt ||
      storageKeys.some(
        (storageKey) =>
          !storageKey.startsWith(expectedPrefix) || storageKey.length > 1_024,
      )
    ) {
      throw new RepositoryError(
        "INVALID_STATE",
        "Invalid DOCX image object leases",
      );
    }
    if (!storageKeys.length) return;
    await this.db.transaction(async (tx) => {
      const [record] = await tx
        .select({
          status: publisherDocxImports.status,
          enterpriseProjectId: publisherDocxImports.enterpriseProjectId,
        })
        .from(publisherDocxImports)
        .where(
          and(
            eq(publisherDocxImports.id, input.importId),
            eq(publisherDocxImports.ownerId, input.ownerId),
          ),
        )
        .for("update")
        .limit(1);
      if (!record) {
        throw new RepositoryError("NOT_FOUND", "DOCX import not found");
      }
      if (["ready", "rejected", "failed"].includes(record.status)) {
        throw new RepositoryError(
          "CONFLICT",
          "DOCX import no longer accepts image objects",
        );
      }
      const operationId = publisherDocxImageLeaseOperationId(input.importId);
      for (let offset = 0; offset < storageKeys.length; offset += 25) {
        await tx
          .insert(publisherObjectLeases)
          .values(
            storageKeys.slice(offset, offset + 25).map((storageKey) => ({
              id: randomUUID(),
              ownerId: input.ownerId,
              enterpriseProjectId: record.enterpriseProjectId,
              operationId,
              storageKey,
              storageKeyHash: sha256(storageKey),
              kind: "docx_import_image",
              expiresAt: input.expiresAt,
            })),
          )
          .onDuplicateKeyUpdate({
            set: { expiresAt: input.expiresAt },
          });
      }
    });
  }

  async getPublisherDocxImport(importId: string) {
    const [record] = await this.db
      .select()
      .from(publisherDocxImports)
      .where(eq(publisherDocxImports.id, importId))
      .limit(1);
    if (!record) return undefined;
    return {
      importId: record.id,
      ownerId: record.ownerId,
      status: record.status,
      objectKey: record.sourceObjectKey,
      fileName: record.sourceFilename,
      contentType: record.mimeType,
    };
  }

  async completePublisherDocxImport(input: {
    importId: string;
    ownerId: string;
    report: DocxReportInput;
    completedAt: Date;
  }) {
    await this.db.transaction(async (tx) => {
      const [record] = await tx
        .select()
        .from(publisherDocxImports)
        .where(
          and(
            eq(publisherDocxImports.id, input.importId),
            eq(publisherDocxImports.ownerId, input.ownerId),
          ),
        )
        .for("update")
        .limit(1);
      if (!record)
        throw new RepositoryError("NOT_FOUND", "DOCX import not found");
      if (record.status === "ready") {
        await tx
          .delete(publisherObjectLeases)
          .where(
            and(
              eq(publisherObjectLeases.ownerId, input.ownerId),
              eq(
                publisherObjectLeases.operationId,
                publisherDocxImageLeaseOperationId(record.id),
              ),
            ),
          );
        return;
      }
      if (input.report.blockingIssues.length) {
        await tx
          .update(publisherDocxImports)
          .set({
            status: "rejected",
            importReport: jsonRecord(input.report.stats),
            warnings: input.report.warnings.map(jsonRecord),
            blockingIssues: input.report.blockingIssues.map(jsonRecord),
          })
          .where(eq(publisherDocxImports.id, record.id));
        return;
      }
      if (
        input.report.sourceSha256 !== record.sha256 ||
        sha256(input.report.canonicalHtml) !== input.report.contentHash
      ) {
        throw new RepositoryError(
          "INVALID_STATE",
          "DOCX import hashes do not match",
        );
      }
      const articleId = record.articleId ?? randomUUID();
      const versionId = randomUUID();
      const workingName = truncate(
        input.report.suggestedTitle.trim() || input.report.fileName,
        180,
      );
      if (!record.articleId) {
        await tx.insert(publisherArticles).values({
          enterpriseProjectId: record.enterpriseProjectId,
          id: articleId,
          ownerId: input.ownerId,
          workingName,
          suggestedTitle: truncate(input.report.suggestedTitle, 200) || null,
          status: "ready",
          currentVersionId: versionId,
          revision: 1,
          editorJson: { type: "doc", importedHtml: input.report.canonicalHtml },
          canonicalHtml: input.report.canonicalHtml,
          plainText: input.report.plainText,
          contentHash: input.report.contentHash,
          containsImages: input.report.containsImages,
        });
      }
      await tx.insert(publisherArticleVersions).values({
        enterpriseProjectId: record.enterpriseProjectId,
        id: versionId,
        ownerId: input.ownerId,
        articleId,
        version: 1,
        editorJson: { type: "doc", importedHtml: input.report.canonicalHtml },
        canonicalHtml: input.report.canonicalHtml,
        plainText: input.report.plainText,
        contentHash: input.report.contentHash,
        containsImages: input.report.containsImages,
        sourceImportId: record.id,
        freezeIdempotencyKey: `publisher:import:${record.id}`,
        createdBy: input.ownerId,
      });
      for (const [index, image] of input.report.images.entries()) {
        if (!image.storageKey) {
          throw new RepositoryError(
            "INVALID_STATE",
            "Imported image storage key is missing",
          );
        }
        await tx.insert(publisherArticleAssets).values({
          enterpriseProjectId: record.enterpriseProjectId,
          id: image.assetId,
          ownerId: input.ownerId,
          articleId,
          sha256: image.sha256,
          mimeType: image.mimeType,
          width: image.width,
          height: image.height,
          sizeBytes: image.sizeBytes,
          storageKey: image.storageKey,
          storageKeyHash: sha256(image.storageKey),
          sourceImportId: record.id,
          isFrozen: true,
          publicCapabilityDigest: image.capability
            ? sha256(image.capability)
            : null,
          publicCapabilityCreatedAt: image.capability
            ? input.completedAt
            : null,
        });
        await tx.insert(publisherArticleVersionAssets).values({
          enterpriseProjectId: record.enterpriseProjectId,
          ownerId: input.ownerId,
          articleVersionId: versionId,
          assetId: image.assetId,
          sortOrder: index,
        });
      }
      await tx
        .update(publisherDocxImports)
        .set({
          articleId,
          detectedTitle: input.report.suggestedTitle,
          status: "ready",
          importReport: jsonRecord(input.report.stats),
          warnings: input.report.warnings.map(jsonRecord),
          blockingIssues: [],
        })
        .where(eq(publisherDocxImports.id, record.id));
      await tx
        .delete(publisherObjectLeases)
        .where(
          and(
            eq(publisherObjectLeases.ownerId, input.ownerId),
            eq(
              publisherObjectLeases.operationId,
              publisherDocxImageLeaseOperationId(record.id),
            ),
          ),
        );
    });
  }

  async failPublisherDocxImport(input: {
    importId: string;
    reason: string;
    failedAt: Date;
  }) {
    const [record] = await this.db
      .select()
      .from(publisherDocxImports)
      .where(eq(publisherDocxImports.id, input.importId))
      .limit(1);
    if (!record || record.status === "ready") return;
    await this.db
      .update(publisherDocxImports)
      .set({
        status: "failed",
        blockingIssues: [
          ...record.blockingIssues,
          {
            code: "IMPORT_FAILED",
            message: truncate(input.reason, 500),
            failedAt: input.failedAt.toISOString(),
          },
        ],
      })
      .where(eq(publisherDocxImports.id, record.id));
  }

  async recordPublisherReconciliationCandidates(input: {
    itemId: string;
    orders: readonly KolOrderInput[];
    observedAt: Date;
  }) {
    for (const order of input.orders) {
      const evidence = jsonRecord({
        observedAt: input.observedAt,
        resourceId: order.resourceId,
        title: order.title,
        status: order.status,
        reportedPrice: order.reportedPrice,
        manuscriptId: order.manuscriptId,
        publishedUrl: order.publishedUrl,
        failureReason: order.failureReason,
      });
      await this.db
        .insert(publisherReconciliationCandidates)
        .values({
          id: randomUUID(),
          itemId: input.itemId,
          externalOrderId: order.orderId,
          confidenceBasisPoints: 5_000,
          evidence,
        })
        .onDuplicateKeyUpdate({ set: { evidence } });
    }
  }

  async getPublisherAssetPurgeCandidate(assetId: string) {
    const [asset] = await this.db
      .select()
      .from(publisherArticleAssets)
      .where(
        and(
          eq(publisherArticleAssets.id, assetId),
          eq(publisherArticleAssets.isFrozen, false),
        ),
      )
      .limit(1);
    if (!asset) return undefined;
    const [reference] = await this.db
      .select({ assetId: publisherArticleVersionAssets.assetId })
      .from(publisherArticleVersionAssets)
      .where(eq(publisherArticleVersionAssets.assetId, assetId))
      .limit(1);
    if (reference) return undefined;
    return { assetId, objectKeys: [asset.storageKey] };
  }

  async finalizePublisherAssetPurge(assetId: string, _purgedAt: Date) {
    await this.db.transaction(async (tx) => {
      const [asset] = await tx
        .select()
        .from(publisherArticleAssets)
        .where(eq(publisherArticleAssets.id, assetId))
        .for("update")
        .limit(1);
      if (!asset || asset.isFrozen) return;
      const [reference] = await tx
        .select({ assetId: publisherArticleVersionAssets.assetId })
        .from(publisherArticleVersionAssets)
        .where(eq(publisherArticleVersionAssets.assetId, assetId))
        .limit(1);
      if (!reference) {
        await tx
          .delete(publisherArticleAssets)
          .where(eq(publisherArticleAssets.id, assetId));
      }
    });
  }

  private async finishKnownSubmission(input: {
    itemId: string;
    attemptId: string;
    reason: string;
    providerRaw?: unknown;
    settledAt: Date;
    status: "failed" | "auth_blocked" | "action_required";
    result: "business_rejected" | "auth_blocked";
    settlement: "released";
  }) {
    await this.db.transaction(async (tx) => {
      const item = await lockAttemptItem(tx, input.itemId, input.attemptId);
      if (!item || item.status === input.status) return;
      await tx
        .update(publisherSubmissionAttempts)
        .set({
          completedAt: input.settledAt,
          result: input.result,
          responseRedacted: jsonRecord(input.providerRaw),
          errorCode: truncate(input.reason, 64),
        })
        .where(eq(publisherSubmissionAttempts.id, input.attemptId));
      await tx
        .update(publisherItems)
        .set({
          status: input.status,
          failureReason:
            input.status === "failed" ? truncate(input.reason, 4_000) : null,
          actionRequiredReason:
            input.status === "failed" ? null : truncate(input.reason, 4_000),
          completedAt: input.settledAt,
        })
        .where(eq(publisherItems.id, input.itemId));
      await settlePublisherItemMoney(tx, {
        itemId: input.itemId,
        settlement: input.settlement,
        settledAt: input.settledAt,
        reason: input.reason,
      });
      if (input.status === "auth_blocked") {
        await tx
          .insert(publisherRuntimeState)
          .values({
            id: "kol",
            credentialStatus: "auth_blocked",
            credentialFailedAt: input.settledAt,
          })
          .onDuplicateKeyUpdate({
            set: {
              credentialStatus: "auth_blocked",
              credentialFailedAt: input.settledAt,
            },
          });
      }
      await releaseSubmissionGate(tx);
      await refreshBatchState(tx, item.batchId, input.settledAt);
    });
  }
}

async function submissionBlocker(
  tx: Transaction,
  row: {
    item: typeof publisherItems.$inferSelect;
    batch: typeof publisherBatches.$inferSelect;
    version: typeof publisherArticleVersions.$inferSelect;
    resource: typeof publisherMediaResources.$inferSelect;
    snapshot: typeof mediaPublishingItemPriceSnapshots.$inferSelect;
  },
  runtime: typeof publisherRuntimeState.$inferSelect | undefined,
  input: {
    now: Date;
    runtime: {
      mode: PublicationMode;
      realEnabled: boolean;
      publishEnabled: boolean;
      imageEnabled: boolean;
    };
  },
) {
  const runtimeGateBlocker = publisherRealRuntimeGateBlocker({
    batchMode: row.batch.mode,
    environmentMode: input.runtime.mode,
    environmentRealEnabled: input.runtime.realEnabled,
    environmentPublishEnabled: input.runtime.publishEnabled,
    databaseRuntime: runtime,
  });
  if (runtimeGateBlocker) return runtimeGateBlocker;
  if (row.version.contentHash !== row.item.articleContentHash)
    return "Article hash changed";
  if (!row.resource.isActive) return "Media resource is inactive";
  if (
    !row.resource.mediaKind ||
    (row.item.mediaKindSnapshot !== "unknown" &&
      row.item.mediaKindSnapshot !== row.resource.mediaKind) ||
    row.resource.catalogRevision !== row.snapshot.catalogRevision ||
    row.resource.priceTenThousandths !== row.snapshot.amountTenThousandths ||
    row.resource.payloadHash !== row.snapshot.providerPayloadHash
  ) {
    return "Media catalog or price changed";
  }
  if (row.batch.mode !== "mock") {
    if (row.version.containsImages && !input.runtime.imageEnabled) {
      return "Real image publishing environment gate is closed";
    }
  }
  if (row.batch.mode === "live") {
    if (!runtime) return "LIVE runtime gate is closed";
    if (!runtime.catalogKindComplete) return "Dual-media catalog is incomplete";
    if (
      !runtime.catalogSyncedAt ||
      input.now.getTime() - runtime.catalogSyncedAt.getTime() > 12 * 60 * 60_000
    ) {
      return "Media catalog is stale";
    }
    const [whitelist] = await tx
      .select()
      .from(publisherLiveWhitelist)
      .where(eq(publisherLiveWhitelist.mediaResourceId, row.resource.id))
      .limit(1);
    if (!whitelist) return "Media resource is not LIVE-whitelisted";
    if (!runtime.imagePublishEnabled) {
      const batchItems = await tx
        .select({ id: publisherItems.id })
        .from(publisherItems)
        .where(eq(publisherItems.batchId, row.batch.id))
        .limit(2);
      const matchingActiveResources = await tx
        .select({ id: publisherMediaResources.id })
        .from(publisherMediaResources)
        .where(
          and(
            eq(publisherMediaResources.name, "博客园（可发GEO）"),
            eq(publisherMediaResources.isActive, true),
          ),
        )
        .limit(2);
      const canaryBlocker = publisherLiveCanaryBlocker({
        runtimeImagePublishEnabled: false,
        batchItemCount: batchItems.length,
        matchingActiveResourceCount: matchingActiveResources.length,
        resourceName: row.resource.name,
        totalTenThousandths: row.batch.quotedTotalTenThousandths,
        containsImages: row.version.containsImages,
        whitelistImageAllowed: whitelist.imageAllowed,
      });
      if (canaryBlocker) return canaryBlocker;
    }
  }
  if (row.batch.mode !== "mock" && row.version.containsImages) {
    if (row.batch.mode === "test" && !runtime?.imagePublishEnabled) {
      return "TEST image publishing is disabled";
    }
    const [whitelist] =
      row.batch.mode === "live"
        ? await tx
            .select()
            .from(publisherLiveWhitelist)
            .where(eq(publisherLiveWhitelist.mediaResourceId, row.resource.id))
            .limit(1)
        : [];
    if (row.batch.mode === "live" && !whitelist?.imageAllowed) {
      return "LIVE image publishing is disabled";
    }
    const [capability] = await tx
      .select({
        imageSupport: publisherMediaCapabilities.imageSupport,
        evidenceUrl: publisherMediaCapabilities.evidenceUrl,
        verifiedAt: publisherMediaCapabilities.verifiedAt,
      })
      .from(publisherMediaCapabilities)
      .where(eq(publisherMediaCapabilities.mediaResourceId, row.resource.id))
      .limit(1);
    const capabilityBlocker =
      publisherImageCapabilityEvidenceBlocker(capability);
    if (capabilityBlocker) return capabilityBlocker;
    const assets = await tx
      .select({
        isFrozen: publisherArticleAssets.isFrozen,
        publicCapabilityDigest: publisherArticleAssets.publicCapabilityDigest,
        publicCapabilityCreatedAt:
          publisherArticleAssets.publicCapabilityCreatedAt,
        mimeType: publisherArticleAssets.mimeType,
      })
      .from(publisherArticleVersionAssets)
      .innerJoin(
        publisherArticleAssets,
        and(
          eq(publisherArticleAssets.id, publisherArticleVersionAssets.assetId),
          eq(
            publisherArticleAssets.ownerId,
            publisherArticleVersionAssets.ownerId,
          ),
        ),
      )
      .where(
        and(
          eq(publisherArticleVersionAssets.articleVersionId, row.version.id),
          eq(publisherArticleVersionAssets.ownerId, row.version.ownerId),
        ),
      );
    const evidenceBlocker = publisherLiveImageEvidenceBlocker({
      containsImages: true,
      imageSupport: capability?.imageSupport,
      assets,
    });
    if (evidenceBlocker) return evidenceBlocker;
  }
  return null;
}

export function publisherRealRuntimeGateBlocker(input: {
  batchMode: PublicationMode;
  environmentMode: PublicationMode;
  environmentRealEnabled: boolean;
  environmentPublishEnabled: boolean;
  databaseRuntime:
    | Pick<
        typeof publisherRuntimeState.$inferSelect,
        | "featureEnabled"
        | "publishEnabled"
        | "emergencyStop"
        | "mode"
        | "credentialStatus"
      >
    | undefined;
}): string | null {
  if (input.batchMode !== input.environmentMode) return "Runtime mode changed";
  if (input.batchMode === "mock") return null;
  if (!input.environmentRealEnabled || !input.environmentPublishEnabled) {
    return "Real provider publishing is disabled";
  }
  const runtime = input.databaseRuntime;
  if (
    !runtime?.featureEnabled ||
    !runtime.publishEnabled ||
    runtime.emergencyStop ||
    runtime.mode !== input.batchMode ||
    runtime.credentialStatus !== "healthy"
  ) {
    return "TEST/LIVE database runtime gate is closed";
  }
  return null;
}

export function publisherLiveCanaryBlocker(input: {
  runtimeImagePublishEnabled: boolean;
  batchItemCount: number;
  matchingActiveResourceCount: number;
  resourceName: string;
  totalTenThousandths: bigint;
  containsImages: boolean;
  whitelistImageAllowed: boolean;
}): string | null {
  if (input.runtimeImagePublishEnabled) return null;
  if (
    input.batchItemCount !== 1 ||
    input.matchingActiveResourceCount !== 1 ||
    input.resourceName !== "博客园（可发GEO）" ||
    input.totalTenThousandths > 100_000n ||
    !input.containsImages ||
    !input.whitelistImageAllowed
  ) {
    return "LIVE image canary constraints are not satisfied";
  }
  return null;
}

export function publisherLiveImageEvidenceBlocker(input: {
  containsImages: boolean;
  imageSupport?: "unknown" | "verified" | "unsupported";
  assets: ReadonlyArray<{
    isFrozen: boolean;
    publicCapabilityDigest: string | null;
    publicCapabilityCreatedAt: Date | null;
    mimeType: string;
  }>;
}): string | null {
  if (!input.containsImages) return null;
  if (input.imageSupport !== "verified") {
    return "Media image capability is not verified";
  }
  if (input.assets.length === 0) {
    return "Frozen article version has no image asset evidence";
  }
  const invalidAsset = input.assets.some(
    (asset) =>
      !asset.isFrozen ||
      !asset.publicCapabilityCreatedAt ||
      !asset.publicCapabilityDigest ||
      !/^[a-f0-9]{64}$/u.test(asset.publicCapabilityDigest) ||
      (asset.mimeType !== "image/jpeg" && asset.mimeType !== "image/png"),
  );
  return invalidAsset
    ? "Frozen article version has incomplete public image evidence"
    : null;
}

async function lockAttemptItem(
  tx: Transaction,
  itemId: string,
  attemptId: string,
) {
  const [attempt] = await tx
    .select()
    .from(publisherSubmissionAttempts)
    .where(
      and(
        eq(publisherSubmissionAttempts.id, attemptId),
        eq(publisherSubmissionAttempts.itemId, itemId),
      ),
    )
    .for("update")
    .limit(1);
  if (!attempt)
    throw new RepositoryError("NOT_FOUND", "Submission attempt not found");
  const [item] = await tx
    .select()
    .from(publisherItems)
    .where(eq(publisherItems.id, itemId))
    .for("update")
    .limit(1);
  return item;
}

async function refreshBatchState(tx: Transaction, batchId: string, at: Date) {
  const items = await tx
    .select({
      status: publisherItems.status,
      fundsStatus: publisherItems.fundsStatus,
    })
    .from(publisherItems)
    .where(eq(publisherItems.batchId, batchId));
  if (!items.length) return;
  const allFinal = items.every(
    ({ status }) => status === "success" || status === "failed",
  );
  const successes = items.filter(({ status }) => status === "success").length;
  const needsAction = items.some(({ status }) =>
    ["auth_blocked", "submission_unknown", "action_required"].includes(status),
  );
  const status = needsAction
    ? "action_required"
    : !allFinal
      ? "processing"
      : successes === items.length
        ? "success"
        : successes === 0
          ? "failed"
          : "partial_success";
  const fundsStatus = derivePublisherBatchFundsStatus(
    items.map(({ fundsStatus }) => fundsStatus),
  );
  await tx
    .update(publisherBatches)
    .set({
      status,
      fundsStatus,
      completedAt: allFinal && !needsAction ? at : null,
    })
    .where(eq(publisherBatches.id, batchId));
}

async function releaseSubmissionGate(tx: Transaction) {
  await tx
    .update(publisherSubmissionGate)
    .set({ leaseOwner: null, leaseExpiresAt: null })
    .where(eq(publisherSubmissionGate.id, "kol"));
}

async function enqueueJob(
  tx: Transaction,
  input: {
    type: typeof publisherJobs.$inferInsert.type;
    key: string;
    aggregateId: string;
    enterpriseProjectId?: string | null;
    payload: Record<string, unknown>;
    at: Date;
  },
) {
  await tx
    .insert(publisherJobs)
    .values({
      id: randomUUID(),
      type: input.type,
      deterministicKey: input.key,
      aggregateId: input.aggregateId,
      enterpriseProjectId: input.enterpriseProjectId ?? null,
      payload: input.payload,
      availableAt: input.at,
    })
    .onDuplicateKeyUpdate({
      set: { deterministicKey: sql`${publisherJobs.deterministicKey}` },
    });
}

async function insertProviderObservationAudit(
  tx: Transaction,
  item: typeof publisherItems.$inferSelect,
  providerRaw: unknown,
  observedAt: Date,
) {
  await tx.insert(auditLogs).values({
    id: randomUUID(),
    actorRole: null,
    action: "publisher.order_observed",
    targetType: "publication_item",
    targetIdHash: sha256(item.id),
    ownerId: item.ownerId,
    metadata: {
      observedAt: observedAt.toISOString(),
      response: jsonValue(providerRaw),
    },
  });
}

async function insertProviderPriceMismatchAudit(
  tx: Transaction,
  input: {
    item: typeof publisherItems.$inferSelect;
    customerPrice: bigint;
    reportedPrice: bigint;
    observedAt: Date;
  },
) {
  await tx.insert(auditLogs).values({
    id: randomUUID(),
    actorRole: null,
    action: "publisher.provider_price_mismatch_detected",
    targetType: "publication_item",
    targetIdHash: sha256(input.item.id),
    ownerId: input.item.ownerId,
    metadata: {
      observedAt: input.observedAt.toISOString(),
      providerOrderId: input.item.externalOrderId,
      customerPriceTenThousandths: input.customerPrice.toString(),
      providerReportedPriceTenThousandths: input.reportedPrice.toString(),
      settlementRule: "customer_snapshot",
    },
  });
}

export function publisherReportedPriceMismatch(
  reportedPrice: bigint | null,
  customerPrice: bigint,
) {
  return reportedPrice !== null && reportedPrice !== customerPrice;
}

export function publisherStatusForProcessingObservation(
  currentStatus: typeof publisherItems.$inferSelect.status,
): "processing" | "action_required" {
  return currentStatus === "action_required" ? "action_required" : "processing";
}

function normalizeCatalogResource(resource: KolResourceInput) {
  if (
    !Number.isSafeInteger(resource.id) ||
    resource.id <= 0 ||
    !resource.name.trim() ||
    (resource.kind !== "news" && resource.kind !== "self_media") ||
    resource.isSelfMedia !== (resource.kind === "self_media")
  ) {
    return null;
  }
  if (resource.price === undefined) return null;
  let priceTenThousandths: bigint;
  try {
    priceTenThousandths = publisherPriceToTenThousandths(resource.price);
  } catch {
    return null;
  }
  if (priceTenThousandths <= 0n) return null;
  const logoPlan = publisherMediaLogoCandidatePlan({
    name: resource.name,
    platform: resource.platform,
    area: resource.area,
    caseUrl: resource.caseUrl,
    entryUrl: resource.entryUrl,
    providerLogoUrl: resource.logo,
    providerIconUrl: resource.icon,
  });
  const rawPayload = jsonRecord({
    id: resource.id,
    name: resource.name.trim(),
    platform: resource.platform,
    taxonomy: resource.taxonomy,
    mediaType: resource.mediaType,
    mediaKind: resource.kind,
    area: resource.area,
    caseUrl: resource.caseUrl,
    titleLimit: resource.titleLimit,
    price: resource.price,
    successRate: resource.successRate,
    includeRate: resource.includeRate,
    pcWeight: resource.pcWeight,
    mobileWeight: resource.mobileWeight,
    includeType: resource.includeType,
    publishTime: resource.publishTime,
    linkType: resource.linkType,
    entryUrl: resource.entryUrl,
    entryLevel: resource.entryLevel,
    logo: resource.logo,
    icon: resource.icon,
    remark: resource.remark,
    description: resource.description,
    recommended: resource.recommended,
    authenticated: resource.authenticated,
    festivalPublishable: resource.festivalPublishable,
    fanCount: resource.fanCount?.toString(),
    likeCount: resource.likeCount?.toString(),
    publishCount: resource.publishCount?.toString(),
    isSelfMedia: resource.isSelfMedia,
  });
  return {
    externalResourceId: String(resource.id),
    name: resource.name.trim(),
    mediaKind: resource.kind,
    platform: resource.platform?.trim() || null,
    taxonomy: resource.taxonomy?.trim() || null,
    mediaType: resource.mediaType?.trim() || null,
    area: resource.area?.trim() || null,
    caseUrl: resource.caseUrl?.trim() || null,
    titleLimit: resource.titleLimit ?? null,
    priceTenThousandths,
    successRateBasisPoints: parsePercentBasisPoints(resource.successRate),
    includeRateBasisPoints: parsePercentBasisPoints(resource.includeRate),
    pcWeight: parseNonnegativeInteger(resource.pcWeight),
    mobileWeight: parseNonnegativeInteger(resource.mobileWeight),
    includeType: resource.includeType?.trim() || null,
    publishSpeed: resource.publishTime?.trim() || null,
    entryUrl: resource.entryUrl?.trim() || null,
    entryLevel: resource.entryLevel?.trim() || null,
    linkType: resource.linkType?.trim() || null,
    providerLogoUrl: resource.logo?.trim() || null,
    providerIconUrl: resource.icon?.trim() || null,
    // The plan also hashes the search identity. Every valid catalog row gets a
    // deterministic resolution job, even when KOL omitted both image fields.
    logoCandidateHash: logoPlan.candidateHash,
    remark: resource.remark?.trim() || null,
    description: resource.description?.trim() || null,
    recommended: resource.recommended ?? null,
    authenticated: resource.authenticated ?? null,
    festivalPublishable: resource.festivalPublishable ?? null,
    fanCount: resource.fanCount ?? null,
    likeCount: resource.likeCount ?? null,
    publishCount: resource.publishCount ?? null,
    rawPayload,
    payloadHash: hashJson(rawPayload),
  };
}

export type PublisherMediaLogoCandidate = {
  kind: "logo" | "icon" | "site_favicon";
  url: string;
};

/**
 * Builds the server-only logo resolution plan from fields already accepted
 * into the KOL catalog. No URL in this plan crosses the customer DTO boundary;
 * every fetch still passes through the object-store SSRF/media guard.
 */
export function publisherMediaLogoCandidatePlan(input: {
  name: string;
  platform?: string | null;
  area?: string | null;
  caseUrl?: string | null;
  entryUrl?: string | null;
  providerLogoUrl?: string | null;
  providerIconUrl?: string | null;
}): {
  candidateHash: string;
  candidates: PublisherMediaLogoCandidate[];
  trustedDomains: string[];
} {
  const candidates: PublisherMediaLogoCandidate[] = [];
  const seenCandidateUrls = new Set<string>();
  const pushCandidate = (
    kind: PublisherMediaLogoCandidate["kind"],
    value: string | null | undefined,
  ) => {
    const url = safeHttpUrl(value);
    if (!url || seenCandidateUrls.has(url)) return;
    seenCandidateUrls.add(url);
    candidates.push({ kind, url });
  };
  pushCandidate("logo", input.providerLogoUrl);
  pushCandidate("icon", input.providerIconUrl);

  const trustedDomains: string[] = [];
  const seenDomains = new Set<string>();
  for (const value of [input.caseUrl, input.entryUrl]) {
    const url = safeHttpUrl(value);
    if (!url) continue;
    const parsed = new URL(url);
    const domain = normalizeLogoDomain(parsed.hostname);
    if (!domain || sharedPublisherPlatformDomain(domain)) continue;
    if (!seenDomains.has(domain)) {
      seenDomains.add(domain);
      trustedDomains.push(domain);
    }
    pushCandidate(
      "site_favicon",
      new URL("/favicon.ico", parsed.origin).toString(),
    );
  }

  return {
    candidates,
    trustedDomains,
    candidateHash: hashJson({
      version: 2,
      candidates,
      search: {
        name: input.name.trim(),
        platform: input.platform?.trim() || null,
        area: input.area?.trim() || null,
        trustedDomains,
      },
    }),
  };
}

function safeHttpUrl(value: string | null | undefined): string | null {
  if (!value?.trim() || value.length > 2_048) return null;
  try {
    const parsed = new URL(value.trim());
    if (
      (parsed.protocol !== "http:" && parsed.protocol !== "https:") ||
      parsed.username ||
      parsed.password
    ) {
      return null;
    }
    parsed.hash = "";
    return parsed.toString();
  } catch {
    return null;
  }
}

function normalizeLogoDomain(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/\.$/u, "")
    .replace(/^www\./u, "");
}

function sharedPublisherPlatformDomain(domain: string): boolean {
  const sharedRoots = [
    "baidu.com",
    "bilibili.com",
    "douyin.com",
    "kuaishou.com",
    "qq.com",
    "sohu.com",
    "toutiao.com",
    "weibo.com",
    "weixin.qq.com",
    "xiaohongshu.com",
    "zhihu.com",
  ];
  return sharedRoots.some(
    (root) => domain === root || domain.endsWith(`.${root}`),
  );
}

function parseNonnegativeInteger(value: string | undefined) {
  if (!value || !/^\d+$/u.test(value.trim())) return null;
  const parsed = Number(value.trim());
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null;
}

function parsePercentBasisPoints(value: string | undefined) {
  if (!value) return null;
  const normalized = value.trim().replace(/%$/u, "");
  if (!/^\d+(?:\.\d{1,2})?$/u.test(normalized)) return null;
  const [whole = "0", fraction = ""] = normalized.split(".");
  const basisPoints = Number(whole) * 100 + Number(fraction.padEnd(2, "0"));
  return basisPoints >= 0 && basisPoints <= 10_000 ? basisPoints : null;
}

function leasedPublisherJob(jobId: string, workerId: string) {
  return and(
    eq(publisherJobs.id, jobId),
    eq(publisherJobs.status, "leased"),
    eq(publisherJobs.leaseOwner, workerId),
  );
}

function terminalItem(status: typeof publisherItems.$inferSelect.status) {
  return status === "success" || status === "failed";
}

function payloadString(payload: unknown, key: string) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload))
    return null;
  const value = (payload as Record<string, unknown>)[key];
  return typeof value === "string" && value ? value : null;
}

function jsonValue(value: unknown): unknown {
  if (
    value === null ||
    ["string", "number", "boolean"].includes(typeof value)
  ) {
    return value;
  }
  if (typeof value === "bigint") return value.toString();
  if (Array.isArray(value)) return value.map(jsonValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([, item]) => item !== undefined)
        .map(([key, item]) => [key, jsonValue(item)]),
    );
  }
  return String(value ?? "");
}

function jsonRecord(value: unknown): Record<string, unknown> {
  const normalized = jsonValue(value);
  return normalized &&
    typeof normalized === "object" &&
    !Array.isArray(normalized)
    ? (normalized as Record<string, unknown>)
    : { value: normalized };
}

function hashJson(value: unknown) {
  return sha256(stableJson(jsonValue(value)));
}

function stableJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  return `{${Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`)
    .join(",")}}`;
}

function sha256(value: string) {
  return createHash("sha256").update(value).digest("hex");
}

function catalogSyncLeaseToken(runId: string, value?: string) {
  const token = value?.trim() || `${runId}:compat`;
  if (
    token.length < 43 ||
    token.length > 128 ||
    !token.startsWith(`${runId}:`) ||
    !/^[a-z0-9:._-]+$/iu.test(token)
  ) {
    throw new RepositoryError(
      "INVALID_STATE",
      "Invalid catalog synchronization lease token",
    );
  }
  return token;
}

function catalogSyncRunIdFromLeaseToken(value: string | null) {
  const candidate = value?.slice(0, 36) ?? "";
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(
    candidate,
  ) && value?.[36] === ":"
    ? candidate
    : null;
}

function truncate(value: string, maximum: number) {
  return value.length <= maximum ? value : value.slice(0, maximum);
}

export function publisherCatalogSyncSlot(at: Date) {
  const shanghai = new Date(at.getTime() + 8 * 60 * 60_000);
  const hour = shanghai.getUTCHours();
  let slot: "02" | "10" | "18";
  if (hour < 2) {
    // At startup before the first daily window, catch up the most recent
    // completed window instead of running today's 02:00 sync early.
    shanghai.setUTCDate(shanghai.getUTCDate() - 1);
    slot = "18";
  } else {
    slot = hour >= 18 ? "18" : hour >= 10 ? "10" : "02";
  }
  const year = shanghai.getUTCFullYear();
  const month = String(shanghai.getUTCMonth() + 1).padStart(2, "0");
  const day = String(shanghai.getUTCDate()).padStart(2, "0");
  return `${year}-${month}-${day}:${slot}`;
}

export function publisherDocxImageLeaseOperationId(importId: string) {
  return `publisher:docx-images:${importId}`;
}
