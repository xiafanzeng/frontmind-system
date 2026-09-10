import { assertMonitoringEnterpriseProjectActive } from "./enterprise-lifecycle.js";
import {
  monitoringProjectOwnerPredicate,
  monitoringEnterpriseProjectIdForOwner,
} from "./enterprise-scope.js";
import { createHash, randomUUID } from "node:crypto";
import type {
  PublicationMode,
  PublisherBatchListInput,
  PublisherMediaListInput,
  PublisherPreflightOutput,
  PublisherRefreshDraftMediaInput,
  PublisherSaveDraftInput,
  PublisherSaveDraftTitlesInput,
  PublisherTitleMode,
  PublisherSubmitInput,
} from "@frontmind/monitoring-contracts";
import { publisherCanonicalImageReferences } from "@frontmind/monitoring-publisher/canonical-html";
import {
  and,
  asc,
  count,
  desc,
  eq,
  gt,
  getTableColumns,
  gte,
  inArray,
  isNotNull,
  isNull,
  like,
  lt,
  lte,
  or,
  sql,
} from "drizzle-orm";
import type { Database } from "./client.js";
import { publisherImageCapabilityEvidenceBlocker } from "./publisher-capability.js";
import {
  publisherAvailableMoney,
  publisherMoneyFromApiString,
  publisherMoneyToApiString,
  reservePublisherMoney,
} from "./publisher-money.js";
import { RepositoryError } from "./repository-error.js";
import {
  derivePublisherBatchFundsStatus,
  reactivatePublisherItemReservation,
  settlePublisherItemMoney,
} from "./publisher-settlement.js";
import {
  auditLogs,
  mediaPublishingBankTransferReviews,
  mediaPublishingItemPriceSnapshots,
  mediaPublishingItemSettlements,
  mediaPublishingLedger,
  mediaPublishingReservations,
  mediaPublishingTopupOrders,
  mediaPublishingTopupReceipts,
  mediaPublishingWallets,
  paymentOrderRoutes,
  paymentReceiptClaims,
  publisherArticleAssets,
  publisherArticleVersionAssets,
  publisherArticleVersions,
  publisherArticles,
  publisherBatches,
  publisherDocxImports,
  publisherDraftItems,
  publisherDrafts,
  publisherItems,
  publisherJobs,
  publisherLiveWhitelist,
  publisherMediaCapabilities,
  publisherMediaLogoAssets,
  publisherMediaLogoResolutions,
  publisherMediaResources,
  publisherObjectLeases,
  publisherPreflights,
  publisherMediaSyncRuns,
  publisherReconciliationCandidates,
  publisherRuntimeState,
  publisherSubmissionAttempts,
  users,
} from "./schema.js";

type Transaction = Parameters<Parameters<Database["transaction"]>[0]>[0];
type RealPublicationMode = Exclude<PublicationMode, "mock">;
type PublisherExecutionOptions =
  | Date
  | {
      now?: Date;
      requiredMode?: RealPublicationMode;
    };

const PREFLIGHT_WINDOW_MS = 5 * 60_000;
const CATALOG_STALE_MS = 12 * 60 * 60_000;
const PUBLISHER_IMAGE_CANARY_MEDIA_NAME = "博客园（可发GEO）";
const PUBLISHER_IMAGE_CANARY_MAX_TEN_THOUSANDTHS = 100_000n;

export class PublishingRepository {
  constructor(public readonly db: Database) {}
  private mediaFacetsCache = new Map<
    string,
    {
      expiresAt: number;
      value: ReturnType<PublishingRepository["loadPublisherMediaFacets"]>;
    }
  >();

  async ensureMediaPublishingWallet(ownerId: string) {
    await this.db
      .insert(mediaPublishingWallets)
      .values({ userId: ownerId })
      .onDuplicateKeyUpdate({
        set: { userId: sql`${mediaPublishingWallets.userId}` },
      });
  }

  async createPublisherObjectLease(
    ownerId: string,
    input: {
      operationId: string;
      storageKey: string;
      kind: "docx_import" | "article_asset";
      expiresAt: Date;
    },
  ) {
    const enterpriseProjectId = monitoringEnterpriseProjectIdForOwner(ownerId);
    if (
      !input.operationId.trim() ||
      input.operationId.length > 191 ||
      !input.storageKey.trim() ||
      input.storageKey.length > 1_024 ||
      !Number.isFinite(input.expiresAt.getTime())
    ) {
      throw new RepositoryError(
        "INVALID_STATE",
        "Invalid publisher object lease",
      );
    }
    const [owner] = await this.db
      .select({ id: users.id })
      .from(users)
      .where(eq(users.id, ownerId))
      .limit(1);
    if (!owner) throw new RepositoryError("NOT_FOUND", "User not found");
    const scopedOperationId = enterpriseProjectId
      ? `enterprise:${enterpriseProjectId}:${sha256(input.operationId)}`
      : input.operationId;
    const id = randomUUID();
    await this.db
      .insert(publisherObjectLeases)
      .values({
        id,
        ownerId,
        enterpriseProjectId,
        operationId: scopedOperationId,
        storageKey: input.storageKey,
        storageKeyHash: sha256(input.storageKey),
        kind: input.kind,
        expiresAt: input.expiresAt,
      })
      .onDuplicateKeyUpdate({ set: { expiresAt: input.expiresAt } });
    const [lease] = await this.db
      .select({ id: publisherObjectLeases.id })
      .from(publisherObjectLeases)
      .where(
        and(
          monitoringProjectOwnerPredicate(publisherObjectLeases, ownerId),
          eq(publisherObjectLeases.operationId, scopedOperationId),
          eq(publisherObjectLeases.storageKey, input.storageKey),
        ),
      )
      .limit(1);
    if (!lease)
      throw new RepositoryError(
        "INVALID_STATE",
        "Object lease was not created",
      );
    return lease.id;
  }

  async releasePublisherObjectLease(ownerId: string, leaseId: string) {
    await this.db
      .delete(publisherObjectLeases)
      .where(
        and(
          eq(publisherObjectLeases.id, leaseId),
          monitoringProjectOwnerPredicate(publisherObjectLeases, ownerId),
        ),
      );
  }

  async getOwnedPublisherArticleAsset(
    ownerId: string,
    articleId: string,
    assetId: string,
  ) {
    const [asset] = await this.db
      .select({
        id: publisherArticleAssets.id,
        storageKey: publisherArticleAssets.storageKey,
        mimeType: publisherArticleAssets.mimeType,
        sizeBytes: publisherArticleAssets.sizeBytes,
        sha256: publisherArticleAssets.sha256,
      })
      .from(publisherArticleAssets)
      .innerJoin(
        publisherArticles,
        and(
          eq(publisherArticles.id, publisherArticleAssets.articleId),
          eq(publisherArticles.ownerId, publisherArticleAssets.ownerId),
          sql`${publisherArticles.enterpriseProjectId} <=> ${publisherArticleAssets.enterpriseProjectId}`,
        ),
      )
      .where(
        and(
          eq(publisherArticleAssets.id, assetId),
          eq(publisherArticleAssets.articleId, articleId),
          monitoringProjectOwnerPredicate(publisherArticleAssets, ownerId),
        ),
      )
      .limit(1);
    if (!asset)
      throw new RepositoryError("NOT_FOUND", "Article asset not found");
    return asset;
  }

  async getMediaPublishingBillingSummary(ownerId: string) {
    await this.ensureMediaPublishingWallet(ownerId);
    const [wallet] = await this.db
      .select()
      .from(mediaPublishingWallets)
      .where(eq(mediaPublishingWallets.userId, ownerId))
      .limit(1);
    if (!wallet) throw new RepositoryError("NOT_FOUND", "Wallet not found");
    return mediaPublishingBillingSummary(wallet);
  }

  async listMediaPublishingLedger(ownerId: string, limit = 100) {
    const rows = await this.db
      .select()
      .from(mediaPublishingLedger)
      .where(eq(mediaPublishingLedger.ownerId, ownerId))
      .orderBy(
        desc(mediaPublishingLedger.createdAt),
        desc(mediaPublishingLedger.id),
      )
      .limit(Math.min(Math.max(limit, 1), 100));
    return rows.map((row) => ({
      ...row,
      balanceDeltaTenThousandths: publisherMoneyToApiString(
        row.balanceDeltaTenThousandths,
      ),
      reservedDeltaTenThousandths: publisherMoneyToApiString(
        row.reservedDeltaTenThousandths,
      ),
      frozenDeltaTenThousandths: publisherMoneyToApiString(
        row.frozenDeltaTenThousandths,
      ),
      balanceAfterTenThousandths: publisherMoneyToApiString(
        row.balanceAfterTenThousandths,
      ),
      reservedAfterTenThousandths: publisherMoneyToApiString(
        row.reservedAfterTenThousandths,
      ),
      frozenAfterTenThousandths: publisherMoneyToApiString(
        row.frozenAfterTenThousandths,
      ),
    }));
  }

  async createPublisherArticle(ownerId: string, workingName: string) {
    const enterpriseProjectId = monitoringEnterpriseProjectIdForOwner(ownerId);
    const normalized = workingName.trim();
    if (!normalized || normalized.length > 180) {
      throw new RepositoryError("INVALID_STATE", "Invalid article name");
    }
    const id = randomUUID();
    await this.db.transaction(async (tx) => {
      await assertMonitoringEnterpriseProjectActive(tx, enterpriseProjectId, ownerId);
      await tx.insert(publisherArticles).values({
        id, ownerId, workingName: normalized, enterpriseProjectId,
      });
    });
    return this.getPublisherArticle(ownerId, id);
  }

  async createDocxImport(
    ownerId: string,
    input: {
      originalName: string;
      size: number;
      sha256: string;
      objectKey: string;
      contentType?: string;
      parserVersion?: string;
      expiresAt?: Date;
    },
  ) {
    const enterpriseProjectId = monitoringEnterpriseProjectIdForOwner(ownerId);
    if (
      !input.originalName.trim() ||
      input.originalName.length > 255 ||
      !Number.isSafeInteger(input.size) ||
      input.size < 1 ||
      input.size > 20 * 1024 * 1024 ||
      !/^[a-f0-9]{64}$/u.test(input.sha256) ||
      !input.objectKey ||
      input.objectKey.length > 1_024
    ) {
      throw new RepositoryError(
        "INVALID_STATE",
        "Invalid DOCX import metadata",
      );
    }
    return this.db.transaction(async (tx) => {
      await assertMonitoringEnterpriseProjectActive(tx, monitoringEnterpriseProjectIdForOwner(ownerId), ownerId);
      const [owner] = await tx
        .select({ id: users.id })
        .from(users)
        .where(eq(users.id, ownerId))
        .limit(1);
      if (!owner) throw new RepositoryError("NOT_FOUND", "User not found");
      const id = randomUUID();
      const now = new Date();
      await tx.insert(publisherDocxImports).values({
        id,
        ownerId,
        enterpriseProjectId,
        sourceFilename: input.originalName.trim(),
        sourceObjectKey: input.objectKey,
        sizeBytes: input.size,
        sha256: input.sha256,
        mimeType:
          input.contentType ??
          "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        parserVersion: input.parserVersion ?? "publisher-v1",
        status: "uploaded",
        warnings: [],
        blockingIssues: [],
        expiresAt:
          input.expiresAt ?? new Date(now.getTime() + 7 * 24 * 60 * 60_000),
      });
      await tx.insert(publisherJobs).values({
        id: randomUUID(),
        enterpriseProjectId,
        type: "import_docx",
        deterministicKey: `publisher:import:${id}`,
        aggregateId: id,
        payload: { importId: id },
        availableAt: now,
      });
      return {
        id,
        ownerId,
        articleId: null,
        sourceFilename: input.originalName.trim(),
        sizeBytes: input.size,
        status: "uploaded" as const,
        jobStatus: "queued" as const,
        warnings: [],
        blockers: [],
        createdAt: now,
        updatedAt: now,
      };
    });
  }

  async failDocxImport(ownerId: string, importId: string, reason: string) {
    return this.db.transaction(async (tx) => {
      const [record] = await tx
        .select()
        .from(publisherDocxImports)
        .where(
          and(
            eq(publisherDocxImports.id, importId),
            monitoringProjectOwnerPredicate(publisherDocxImports, ownerId),
          ),
        )
        .for("update")
        .limit(1);
      if (!record)
        throw new RepositoryError("NOT_FOUND", "DOCX import not found");
      if (record.status === "ready") {
        throw new RepositoryError(
          "INVALID_STATE",
          "Completed import cannot fail",
        );
      }
      await tx
        .update(publisherDocxImports)
        .set({
          status: "failed",
          blockingIssues: [
            ...record.blockingIssues,
            { code: "IMPORT_FAILED", message: reason.slice(0, 500) },
          ],
        })
        .where(
          and(
            eq(publisherDocxImports.id, importId),
            monitoringProjectOwnerPredicate(publisherDocxImports, ownerId),
          ),
        );
      return { id: importId, status: "failed" as const };
    });
  }

  async getPublisherDocxImport(ownerId: string, importId: string) {
    const [record] = await this.db
      .select({
        id: publisherDocxImports.id,
        articleId: publisherDocxImports.articleId,
        sourceFilename: publisherDocxImports.sourceFilename,
        sizeBytes: publisherDocxImports.sizeBytes,
        status: publisherDocxImports.status,
        detectedTitle: publisherDocxImports.detectedTitle,
        warnings: publisherDocxImports.warnings,
        blockers: publisherDocxImports.blockingIssues,
        createdAt: publisherDocxImports.createdAt,
        updatedAt: publisherDocxImports.updatedAt,
      })
      .from(publisherDocxImports)
      .where(
        and(
          eq(publisherDocxImports.id, importId),
          monitoringProjectOwnerPredicate(publisherDocxImports, ownerId),
        ),
      )
      .limit(1);
    if (!record)
      throw new RepositoryError("NOT_FOUND", "DOCX import not found");
    return record;
  }

  async listPublisherDocxImports(
    ownerId: string,
    input: { cursor?: string; limit?: number } = {},
  ) {
    const conditions = [
      monitoringProjectOwnerPredicate(publisherDocxImports, ownerId),
    ];
    if (input.cursor)
      conditions.push(gt(publisherDocxImports.id, input.cursor));
    const limit = Math.min(Math.max(input.limit ?? 20, 1), 100);
    const rows = await this.db
      .select({
        id: publisherDocxImports.id,
        articleId: publisherDocxImports.articleId,
        sourceFilename: publisherDocxImports.sourceFilename,
        sizeBytes: publisherDocxImports.sizeBytes,
        status: publisherDocxImports.status,
        detectedTitle: publisherDocxImports.detectedTitle,
        warnings: publisherDocxImports.warnings,
        blockers: publisherDocxImports.blockingIssues,
        createdAt: publisherDocxImports.createdAt,
        updatedAt: publisherDocxImports.updatedAt,
      })
      .from(publisherDocxImports)
      .where(and(...conditions))
      .orderBy(asc(publisherDocxImports.id))
      .limit(limit + 1);
    return rows;
  }

  async createArticleAsset(
    ownerId: string,
    articleId: string,
    input: {
      sha256: string;
      objectKey: string;
      contentType: "image/jpeg" | "image/png";
      width: number;
      height: number;
      size: number;
      altText?: string | null;
      capability: string;
      sourceImportId?: string | null;
    },
  ) {
    if (
      !/^[a-f0-9]{64}$/u.test(input.sha256) ||
      input.capability.length < 32 ||
      input.capability.length > 256 ||
      !Number.isSafeInteger(input.width) ||
      !Number.isSafeInteger(input.height) ||
      input.width < 1 ||
      input.height < 1 ||
      input.width * input.height > 40_000_000 ||
      input.width > 2_560 ||
      input.height > 2_560 ||
      !Number.isSafeInteger(input.size) ||
      input.size < 1 ||
      input.size > 10 * 1024 * 1024
    ) {
      throw new RepositoryError(
        "INVALID_STATE",
        "Invalid article asset metadata",
      );
    }
    return this.db.transaction(async (tx) => {
      await assertMonitoringEnterpriseProjectActive(tx, monitoringEnterpriseProjectIdForOwner(ownerId), ownerId);
      await lockOwnedArticle(tx, ownerId, articleId);
      const [existing] = await tx
        .select()
        .from(publisherArticleAssets)
        .where(
          and(
            eq(publisherArticleAssets.articleId, articleId),
            monitoringProjectOwnerPredicate(publisherArticleAssets, ownerId),
            eq(publisherArticleAssets.sha256, input.sha256),
          ),
        )
        .limit(1);
      if (existing) return existing;
      const id = randomUUID();
      await tx.insert(publisherArticleAssets).values({
        id,
        ownerId,
        articleId,
        sha256: input.sha256,
        mimeType: input.contentType,
        width: input.width,
        height: input.height,
        sizeBytes: input.size,
        storageKey: input.objectKey,
        storageKeyHash: sha256(input.objectKey),
        altText: input.altText?.trim() || null,
        sourceImportId: input.sourceImportId ?? null,
        publicCapabilityDigest: sha256(input.capability),
        publicCapabilityCreatedAt: new Date(),
      });
      const [created] = await tx
        .select()
        .from(publisherArticleAssets)
        .where(eq(publisherArticleAssets.id, id))
        .limit(1);
      if (!created)
        throw new RepositoryError("INVALID_STATE", "Asset was not created");
      return created;
    });
  }

  async attachPublisherVersionAssets(
    ownerId: string,
    articleVersionId: string,
    assetIds: readonly string[],
  ) {
    return this.db.transaction(async (tx) => {
      await assertMonitoringEnterpriseProjectActive(tx, monitoringEnterpriseProjectIdForOwner(ownerId), ownerId);
      const [version] = await tx
        .select()
        .from(publisherArticleVersions)
        .where(
          and(
            eq(publisherArticleVersions.id, articleVersionId),
            monitoringProjectOwnerPredicate(publisherArticleVersions, ownerId),
          ),
        )
        .limit(1);
      if (!version)
        throw new RepositoryError("NOT_FOUND", "Article version not found");
      const uniqueIds = [...new Set(assetIds)];
      const assets = uniqueIds.length
        ? await tx
            .select()
            .from(publisherArticleAssets)
            .where(
              and(
                monitoringProjectOwnerPredicate(
                  publisherArticleAssets,
                  ownerId,
                ),
                inArray(publisherArticleAssets.id, uniqueIds),
              ),
            )
        : [];
      if (
        assets.length !== uniqueIds.length ||
        assets.some((asset) => asset.articleId !== version.articleId)
      ) {
        throw new RepositoryError(
          "FORBIDDEN",
          "Asset does not belong to article",
        );
      }
      if (assets.length) {
        await tx.insert(publisherArticleVersionAssets).values(
          assets.map((asset, index) => ({
            ownerId,
            articleVersionId,
            assetId: asset.id,
            sortOrder: index,
          })),
        );
        await tx
          .update(publisherArticleAssets)
          .set({ isFrozen: true })
          .where(
            and(
              monitoringProjectOwnerPredicate(publisherArticleAssets, ownerId),
              inArray(publisherArticleAssets.id, uniqueIds),
            ),
          );
      }
      return { attached: assets.length };
    });
  }

  async listPublisherArticleAssets(ownerId: string, articleId: string) {
    await this.getPublisherArticle(ownerId, articleId);
    return this.db
      .select({
        id: publisherArticleAssets.id,
        articleId: publisherArticleAssets.articleId,
        sha256: publisherArticleAssets.sha256,
        mimeType: publisherArticleAssets.mimeType,
        width: publisherArticleAssets.width,
        height: publisherArticleAssets.height,
        sizeBytes: publisherArticleAssets.sizeBytes,
        altText: publisherArticleAssets.altText,
        isFrozen: publisherArticleAssets.isFrozen,
        createdAt: publisherArticleAssets.createdAt,
      })
      .from(publisherArticleAssets)
      .where(
        and(
          monitoringProjectOwnerPredicate(publisherArticleAssets, ownerId),
          eq(publisherArticleAssets.articleId, articleId),
        ),
      )
      .orderBy(asc(publisherArticleAssets.createdAt));
  }

  async getPublicPublisherAsset(assetId: string, capability: string) {
    if (capability.length < 32 || capability.length > 256) return null;
    const [asset] = await this.db
      .select({
        id: publisherArticleAssets.id,
        storageKey: publisherArticleAssets.storageKey,
        mimeType: publisherArticleAssets.mimeType,
        sizeBytes: publisherArticleAssets.sizeBytes,
        sha256: publisherArticleAssets.sha256,
      })
      .from(publisherArticleAssets)
      .innerJoin(
        publisherArticleVersionAssets,
        and(
          eq(publisherArticleVersionAssets.assetId, publisherArticleAssets.id),
          eq(
            publisherArticleVersionAssets.ownerId,
            publisherArticleAssets.ownerId,
          ),
          sql`${publisherArticleVersionAssets.enterpriseProjectId} <=> ${publisherArticleAssets.enterpriseProjectId}`,
        ),
      )
      .innerJoin(
        publisherArticleVersions,
        and(
          eq(
            publisherArticleVersions.id,
            publisherArticleVersionAssets.articleVersionId,
          ),
          eq(publisherArticleVersions.ownerId, publisherArticleAssets.ownerId),
          eq(
            publisherArticleVersions.articleId,
            publisherArticleAssets.articleId,
          ),
          sql`${publisherArticleVersions.enterpriseProjectId} <=> ${publisherArticleAssets.enterpriseProjectId}`,
        ),
      )
      .where(
        and(
          eq(publisherArticleAssets.id, assetId),
          eq(publisherArticleAssets.isFrozen, true),
          eq(publisherArticleAssets.publicCapabilityDigest, sha256(capability)),
        ),
      )
      .limit(1);
    return asset ?? null;
  }

  async listBatchCsvRows(ownerId: string, batchId: string) {
    const [batch] = await this.db
      .select({ id: publisherBatches.id })
      .from(publisherBatches)
      .where(
        and(
          eq(publisherBatches.id, batchId),
          monitoringProjectOwnerPredicate(publisherBatches, ownerId),
        ),
      )
      .limit(1);
    if (!batch)
      throw new RepositoryError("NOT_FOUND", "Publication batch not found");
    const rows = await this.db
      .select({
        item: publisherItems,
        price: mediaPublishingItemPriceSnapshots.amountTenThousandths,
      })
      .from(publisherItems)
      .innerJoin(
        mediaPublishingItemPriceSnapshots,
        and(
          eq(mediaPublishingItemPriceSnapshots.itemId, publisherItems.id),
          eq(mediaPublishingItemPriceSnapshots.ownerId, ownerId),
        ),
      )
      .where(
        and(
          eq(publisherItems.batchId, batchId),
          monitoringProjectOwnerPredicate(publisherItems, ownerId),
        ),
      )
      .orderBy(asc(publisherItems.id));
    return rows.map(({ item, price }) => ({
      itemId: item.id,
      mediaName: item.mediaNameSnapshot,
      mediaKind: item.mediaKindSnapshot,
      submissionTitle: item.submissionTitle,
      publicationStatus: item.status,
      fundsStatus: item.fundsStatus,
      priceTenThousandths: price.toString(),
      publishedUrl: item.publishedUrl,
      failureReason: item.failureReason,
      submittedAt: item.submittedAt,
      completedAt: item.completedAt,
    }));
  }

  async listPublisherArticles(
    ownerId: string,
    input: {
      query?: string;
      status?: "draft" | "ready" | "archived";
      cursor?: string;
      limit?: number;
    },
  ) {
    const conditions = [
      monitoringProjectOwnerPredicate(publisherArticles, ownerId),
    ];
    if (input.query) {
      conditions.push(
        like(
          publisherArticles.workingName,
          `%${escapeLike(input.query.trim())}%`,
        ),
      );
    }
    if (input.status)
      conditions.push(eq(publisherArticles.status, input.status));
    if (input.cursor) conditions.push(gt(publisherArticles.id, input.cursor));
    const limit = Math.min(Math.max(input.limit ?? 20, 1), 100);
    return this.db
      .select({
        ...getTableColumns(publisherArticles),
        currentVersion: publisherArticleVersions.version,
      })
      .from(publisherArticles)
      .leftJoin(
        publisherArticleVersions,
        and(
          eq(publisherArticleVersions.id, publisherArticles.currentVersionId),
          eq(publisherArticleVersions.articleId, publisherArticles.id),
          monitoringProjectOwnerPredicate(publisherArticleVersions, ownerId),
        ),
      )
      .where(and(...conditions))
      .orderBy(asc(publisherArticles.id))
      .limit(limit + 1);
  }

  async getPublisherArticle(ownerId: string, articleId: string) {
    const [article] = await this.db
      .select()
      .from(publisherArticles)
      .where(
        and(
          eq(publisherArticles.id, articleId),
          monitoringProjectOwnerPredicate(publisherArticles, ownerId),
        ),
      )
      .limit(1);
    if (!article) throw new RepositoryError("NOT_FOUND", "Article not found");
    return article;
  }

  async savePublisherArticle(
    ownerId: string,
    input: {
      articleId: string;
      expectedRevision: number;
      workingName: string;
      suggestedTitle?: string | null;
      editorJson: Record<string, unknown>;
      canonicalHtml: string;
      plainText: string;
      containsImages?: boolean;
    },
  ) {
    return this.db.transaction(async (tx) => {
      await assertMonitoringEnterpriseProjectActive(tx, monitoringEnterpriseProjectIdForOwner(ownerId), ownerId);
      const article = await lockOwnedArticle(tx, ownerId, input.articleId);
      if (article.revision !== input.expectedRevision) {
        throw new RepositoryError("CONFLICT", "Article revision has changed");
      }
      const workingName = input.workingName.trim();
      if (!workingName || workingName.length > 180) {
        throw new RepositoryError("INVALID_STATE", "Invalid article name");
      }
      const contentHash = sha256(input.canonicalHtml);
      await tx
        .update(publisherArticles)
        .set({
          workingName,
          suggestedTitle: input.suggestedTitle?.trim() || null,
          editorJson: input.editorJson,
          canonicalHtml: input.canonicalHtml,
          plainText: input.plainText,
          contentHash,
          containsImages: input.containsImages ?? false,
          revision: article.revision + 1,
          status: "draft",
        })
        .where(
          and(
            eq(publisherArticles.id, input.articleId),
            monitoringProjectOwnerPredicate(publisherArticles, ownerId),
          ),
        );
      return { revision: article.revision + 1, contentHash };
    });
  }

  async freezePublisherArticle(
    ownerId: string,
    input: {
      articleId: string;
      expectedRevision: number;
      idempotencyKey: string;
      actorId?: string | null;
    },
  ) {
    const projectId = monitoringEnterpriseProjectIdForOwner(ownerId);
    const scopedKey = projectId
      ? `enterprise:${projectId}:${sha256(input.idempotencyKey)}`
      : input.idempotencyKey;
    return this.db.transaction(async (tx) => {
      await assertMonitoringEnterpriseProjectActive(tx, monitoringEnterpriseProjectIdForOwner(ownerId), ownerId);
      const [replay] = await tx
        .select()
        .from(publisherArticleVersions)
        .where(
          and(
            monitoringProjectOwnerPredicate(publisherArticleVersions, ownerId),
            inArray(publisherArticleVersions.freezeIdempotencyKey, [
              ...new Set([scopedKey, input.idempotencyKey]),
            ]),
          ),
        )
        .limit(1);
      if (replay) {
        if (replay.articleId !== input.articleId) {
          throw new RepositoryError(
            "CONFLICT",
            "Freeze idempotency key is already bound to another article",
          );
        }
        return replay;
      }
      const article = await lockOwnedArticle(tx, ownerId, input.articleId);
      if (article.revision !== input.expectedRevision) {
        throw new RepositoryError("CONFLICT", "Article revision has changed");
      }
      if (
        !article.editorJson ||
        !article.canonicalHtml ||
        !article.plainText ||
        !article.contentHash
      ) {
        throw new RepositoryError(
          "INVALID_STATE",
          "Article has no content to freeze",
        );
      }
      const [latest] = await tx
        .select({ version: publisherArticleVersions.version })
        .from(publisherArticleVersions)
        .where(
          and(
            eq(publisherArticleVersions.articleId, article.id),
            monitoringProjectOwnerPredicate(publisherArticleVersions, ownerId),
          ),
        )
        .orderBy(desc(publisherArticleVersions.version))
        .limit(1);
      const version = (latest?.version ?? 0) + 1;
      const versionId = randomUUID();
      await tx.insert(publisherArticleVersions).values({
        id: versionId,
        ownerId,
        articleId: article.id,
        version,
        editorJson: article.editorJson,
        canonicalHtml: article.canonicalHtml,
        plainText: article.plainText,
        contentHash: article.contentHash,
        containsImages: article.containsImages,
        freezeIdempotencyKey: scopedKey,
        createdBy: input.actorId ?? ownerId,
      });
      const referencedAssetIds = [
        ...new Set(
          publisherCanonicalImageReferences(article.canonicalHtml).map(
            ({ assetId }) => assetId,
          ),
        ),
      ];
      const assets = referencedAssetIds.length
        ? await tx
            .select({ id: publisherArticleAssets.id })
            .from(publisherArticleAssets)
            .where(
              and(
                monitoringProjectOwnerPredicate(
                  publisherArticleAssets,
                  ownerId,
                ),
                eq(publisherArticleAssets.articleId, article.id),
                inArray(publisherArticleAssets.id, referencedAssetIds),
              ),
            )
        : [];
      if (assets.length !== referencedAssetIds.length) {
        throw new RepositoryError(
          "INVALID_STATE",
          "Article references an unavailable image asset",
        );
      }
      const assetsById = new Map(assets.map((asset) => [asset.id, asset]));
      const orderedAssets = referencedAssetIds.map((id) => assetsById.get(id)!);
      if (orderedAssets.length) {
        await tx.insert(publisherArticleVersionAssets).values(
          orderedAssets.map((asset, index) => ({
            ownerId,
            articleVersionId: versionId,
            assetId: asset.id,
            sortOrder: index,
          })),
        );
        await tx
          .update(publisherArticleAssets)
          .set({ isFrozen: true })
          .where(
            and(
              monitoringProjectOwnerPredicate(publisherArticleAssets, ownerId),
              inArray(
                publisherArticleAssets.id,
                orderedAssets.map(({ id }) => id),
              ),
            ),
          );
      }
      await tx
        .update(publisherArticles)
        .set({ currentVersionId: versionId, status: "ready" })
        .where(
          and(
            eq(publisherArticles.id, article.id),
            monitoringProjectOwnerPredicate(publisherArticles, ownerId),
          ),
        );
      return {
        id: versionId,
        ownerId,
        articleId: article.id,
        version,
        editorJson: article.editorJson,
        canonicalHtml: article.canonicalHtml,
        plainText: article.plainText,
        contentHash: article.contentHash,
        containsImages: article.containsImages,
        sourceImportId: null,
        freezeIdempotencyKey: input.idempotencyKey,
        createdBy: input.actorId ?? ownerId,
        createdAt: new Date(),
      };
    });
  }

  async listPublisherMedia(input: Partial<PublisherMediaListInput> = {}) {
    const conditions = [isNotNull(publisherMediaResources.mediaKind)];
    if (!input.includeInactive) {
      conditions.push(eq(publisherMediaResources.isActive, true));
    }
    if (input.kind)
      conditions.push(eq(publisherMediaResources.mediaKind, input.kind));
    if (input.query) {
      conditions.push(
        or(
          like(publisherMediaResources.name, `%${escapeLike(input.query)}%`),
          like(
            publisherMediaResources.externalResourceId,
            `%${escapeLike(input.query)}%`,
          ),
          like(
            publisherMediaResources.platform,
            `%${escapeLike(input.query)}%`,
          ),
        )!,
      );
    }
    if (input.batchQuery?.length) {
      const terms = [...new Set(input.batchQuery.map((term) => term.trim()))];
      conditions.push(
        or(
          ...terms.flatMap((term) => [
            eq(publisherMediaResources.externalResourceId, term),
            like(publisherMediaResources.name, `%${escapeLike(term)}%`),
          ]),
        )!,
      );
    }
    if (input.platform)
      conditions.push(eq(publisherMediaResources.platform, input.platform));
    if (input.taxonomy)
      conditions.push(eq(publisherMediaResources.taxonomy, input.taxonomy));
    if (input.mediaType)
      conditions.push(eq(publisherMediaResources.mediaType, input.mediaType));
    if (input.area)
      conditions.push(eq(publisherMediaResources.area, input.area));
    if (input.recommended !== undefined)
      conditions.push(
        eq(publisherMediaResources.recommended, input.recommended),
      );
    if (input.includeType)
      conditions.push(
        eq(publisherMediaResources.includeType, input.includeType),
      );
    if (input.publishSpeed)
      conditions.push(
        eq(publisherMediaResources.publishSpeed, input.publishSpeed),
      );
    const entryLevel = input.entryLevel ?? input.entryType;
    if (entryLevel)
      conditions.push(eq(publisherMediaResources.entryLevel, entryLevel));
    if (input.linkType)
      conditions.push(eq(publisherMediaResources.linkType, input.linkType));
    if (input.minimumPcWeight !== undefined)
      conditions.push(
        gte(publisherMediaResources.pcWeight, input.minimumPcWeight),
      );
    if (input.minimumIncludeRate !== undefined)
      conditions.push(
        gte(
          publisherMediaResources.includeRateBasisPoints,
          Math.round(input.minimumIncludeRate * 100),
        ),
      );
    if (input.minimumSuccessRate !== undefined) {
      conditions.push(
        gte(
          publisherMediaResources.successRateBasisPoints,
          Math.round(input.minimumSuccessRate * 100),
        ),
      );
    }
    if (input.minimumPriceTenThousandths !== undefined) {
      conditions.push(
        gte(
          publisherMediaResources.priceTenThousandths,
          publisherMoneyFromApiString(input.minimumPriceTenThousandths),
        ),
      );
    }
    if (input.maximumPriceTenThousandths !== undefined) {
      conditions.push(
        lte(
          publisherMediaResources.priceTenThousandths,
          publisherMoneyFromApiString(input.maximumPriceTenThousandths),
        ),
      );
    }
    if (input.imageSupport) {
      conditions.push(
        sql`COALESCE(${publisherMediaCapabilities.imageSupport}, 'unknown') = ${input.imageSupport}`,
      );
    }
    if (input.authenticated !== undefined)
      conditions.push(
        eq(publisherMediaResources.authenticated, input.authenticated),
      );
    if (input.festivalPublishable !== undefined)
      conditions.push(
        eq(
          publisherMediaResources.festivalPublishable,
          input.festivalPublishable,
        ),
      );
    const pageSize = Math.min(
      Math.max(input.pageSize ?? input.limit ?? 20, 1),
      100,
    );
    const page = Math.max(input.page ?? 1, 1);
    const legacyCursorMode =
      input.page === undefined && input.pageSize === undefined;
    const [{ total = 0 } = { total: 0 }] = await this.db
      .select({ total: count() })
      .from(publisherMediaResources)
      .leftJoin(
        publisherMediaCapabilities,
        eq(
          publisherMediaCapabilities.mediaResourceId,
          publisherMediaResources.id,
        ),
      )
      .where(and(...conditions));
    const pageConditions = input.cursor
      ? [...conditions, gt(publisherMediaResources.id, input.cursor)]
      : conditions;
    const ordering = legacyCursorMode
      ? ([asc(publisherMediaResources.id)] as const)
      : publisherMediaOrdering(input.sort);
    const rows = await this.db
      .select({
        resource: publisherMediaResources,
        imageSupport: publisherMediaCapabilities.imageSupport,
      })
      .from(publisherMediaResources)
      .leftJoin(
        publisherMediaCapabilities,
        eq(
          publisherMediaCapabilities.mediaResourceId,
          publisherMediaResources.id,
        ),
      )
      .where(and(...pageConditions))
      .orderBy(...ordering)
      .limit(legacyCursorMode ? pageSize + 1 : pageSize)
      .offset(legacyCursorMode ? 0 : (page - 1) * pageSize);
    const pageRows = rows.slice(0, pageSize);
    return {
      items: pageRows.map(({ resource, imageSupport }) =>
        customerMediaDto(resource, imageSupport ?? "unknown"),
      ),
      total: Number(total),
      page,
      pageSize,
      hasMore: legacyCursorMode
        ? rows.length > pageSize
        : page * pageSize < Number(total),
      legacyCursorMode,
    };
  }

  async getPublisherMediaFacets(input: Partial<PublisherMediaListInput> = {}) {
    const runtime = await this.getPublisherRuntimeState();
    const key = JSON.stringify([
      runtime?.activeCatalogRevision,
      runtime?.catalogSyncedAt,
      input.kind ?? "all",
    ]);
    const cached = this.mediaFacetsCache.get(key);
    if (cached && cached.expiresAt > Date.now()) return cached.value;
    if (this.mediaFacetsCache.size >= 3) this.mediaFacetsCache.clear();
    const value = this.loadPublisherMediaFacets(input);
    const entry = { expiresAt: Date.now() + 60_000, value };
    this.mediaFacetsCache.set(key, entry);
    try {
      return await value;
    } catch (error) {
      if (this.mediaFacetsCache.get(key) === entry)
        this.mediaFacetsCache.delete(key);
      throw error;
    }
  }

  private async loadPublisherMediaFacets(
    input: Partial<PublisherMediaListInput> = {},
  ) {
    const conditions = [
      input.includeInactive
        ? isNotNull(publisherMediaResources.mediaKind)
        : eq(publisherMediaResources.isActive, true),
      isNotNull(publisherMediaResources.mediaKind),
    ];
    if (input.kind)
      conditions.push(eq(publisherMediaResources.mediaKind, input.kind));
    if (input.query) {
      conditions.push(
        or(
          like(publisherMediaResources.name, `%${escapeLike(input.query)}%`),
          like(
            publisherMediaResources.externalResourceId,
            `%${escapeLike(input.query)}%`,
          ),
          like(
            publisherMediaResources.platform,
            `%${escapeLike(input.query)}%`,
          ),
        )!,
      );
    }
    if (input.batchQuery?.length) {
      const terms = [...new Set(input.batchQuery.map((term) => term.trim()))];
      conditions.push(
        or(
          ...terms.flatMap((term) => [
            eq(publisherMediaResources.externalResourceId, term),
            like(publisherMediaResources.name, `%${escapeLike(term)}%`),
          ]),
        )!,
      );
    }
    if (input.platform)
      conditions.push(eq(publisherMediaResources.platform, input.platform));
    if (input.taxonomy)
      conditions.push(eq(publisherMediaResources.taxonomy, input.taxonomy));
    if (input.mediaType)
      conditions.push(eq(publisherMediaResources.mediaType, input.mediaType));
    if (input.area)
      conditions.push(eq(publisherMediaResources.area, input.area));
    if (input.recommended !== undefined)
      conditions.push(
        eq(publisherMediaResources.recommended, input.recommended),
      );
    if (input.includeType)
      conditions.push(
        eq(publisherMediaResources.includeType, input.includeType),
      );
    if (input.publishSpeed)
      conditions.push(
        eq(publisherMediaResources.publishSpeed, input.publishSpeed),
      );
    const entryLevel = input.entryLevel ?? input.entryType;
    if (entryLevel)
      conditions.push(eq(publisherMediaResources.entryLevel, entryLevel));
    if (input.linkType)
      conditions.push(eq(publisherMediaResources.linkType, input.linkType));
    if (input.minimumPcWeight !== undefined)
      conditions.push(
        gte(publisherMediaResources.pcWeight, input.minimumPcWeight),
      );
    if (input.minimumIncludeRate !== undefined)
      conditions.push(
        gte(
          publisherMediaResources.includeRateBasisPoints,
          Math.round(input.minimumIncludeRate * 100),
        ),
      );
    if (input.minimumSuccessRate !== undefined)
      conditions.push(
        gte(
          publisherMediaResources.successRateBasisPoints,
          Math.round(input.minimumSuccessRate * 100),
        ),
      );
    if (input.minimumPriceTenThousandths !== undefined)
      conditions.push(
        gte(
          publisherMediaResources.priceTenThousandths,
          publisherMoneyFromApiString(input.minimumPriceTenThousandths),
        ),
      );
    if (input.maximumPriceTenThousandths !== undefined)
      conditions.push(
        lte(
          publisherMediaResources.priceTenThousandths,
          publisherMoneyFromApiString(input.maximumPriceTenThousandths),
        ),
      );
    if (input.imageSupport)
      conditions.push(
        eq(publisherMediaCapabilities.imageSupport, input.imageSupport),
      );
    if (input.authenticated !== undefined)
      conditions.push(
        eq(publisherMediaResources.authenticated, input.authenticated),
      );
    if (input.festivalPublishable !== undefined)
      conditions.push(
        eq(
          publisherMediaResources.festivalPublishable,
          input.festivalPublishable,
        ),
      );
    const where = and(...conditions);
    const facet = async (
      column:
        | typeof publisherMediaResources.platform
        | typeof publisherMediaResources.taxonomy
        | typeof publisherMediaResources.mediaType
        | typeof publisherMediaResources.area
        | typeof publisherMediaResources.includeType
        | typeof publisherMediaResources.publishSpeed
        | typeof publisherMediaResources.entryLevel
        | typeof publisherMediaResources.linkType,
    ) => {
      const rows = await this.db
        .select({ value: column, total: count() })
        .from(publisherMediaResources)
        .where(and(where, isNotNull(column)))
        .groupBy(column)
        .orderBy(desc(count()), asc(column));
      return rows
        .filter((row): row is typeof row & { value: string } =>
          Boolean(row.value),
        )
        .map((row) => ({ value: row.value, count: Number(row.total) }));
    };
    const imageSupportValue = sql<string>`COALESCE(${publisherMediaCapabilities.imageSupport}, 'unknown')`;
    const [
      kindRows,
      priceRows,
      platforms,
      taxonomies,
      mediaTypes,
      areas,
      includeTypes,
      publishSpeeds,
      entryLevels,
      linkTypes,
      imageSupportRows,
      advancedCountRows,
    ] = await Promise.all([
      this.db
        .select({ value: publisherMediaResources.mediaKind, total: count() })
        .from(publisherMediaResources)
        .where(
          and(
            eq(publisherMediaResources.isActive, true),
            isNotNull(publisherMediaResources.mediaKind),
          ),
        )
        .groupBy(publisherMediaResources.mediaKind),
      this.db
        .select({
          minimum: sql<
            bigint | null
          >`MIN(${publisherMediaResources.priceTenThousandths})`,
          maximum: sql<
            bigint | null
          >`MAX(${publisherMediaResources.priceTenThousandths})`,
        })
        .from(publisherMediaResources)
        .where(where),
      facet(publisherMediaResources.platform),
      facet(publisherMediaResources.taxonomy),
      facet(publisherMediaResources.mediaType),
      facet(publisherMediaResources.area),
      facet(publisherMediaResources.includeType),
      facet(publisherMediaResources.publishSpeed),
      facet(publisherMediaResources.entryLevel),
      facet(publisherMediaResources.linkType),
      this.db
        .select({ value: imageSupportValue, total: count() })
        .from(publisherMediaResources)
        .leftJoin(
          publisherMediaCapabilities,
          eq(
            publisherMediaCapabilities.mediaResourceId,
            publisherMediaResources.id,
          ),
        )
        .where(where)
        .groupBy(imageSupportValue)
        .orderBy(asc(imageSupportValue)),
      this.db
        .select({
          pcWeight1: sql<number>`COALESCE(SUM(CASE WHEN ${publisherMediaResources.pcWeight} >= 1 THEN 1 ELSE 0 END), 0)`,
          pcWeight2: sql<number>`COALESCE(SUM(CASE WHEN ${publisherMediaResources.pcWeight} >= 2 THEN 1 ELSE 0 END), 0)`,
          pcWeight3: sql<number>`COALESCE(SUM(CASE WHEN ${publisherMediaResources.pcWeight} >= 3 THEN 1 ELSE 0 END), 0)`,
          pcWeight4: sql<number>`COALESCE(SUM(CASE WHEN ${publisherMediaResources.pcWeight} >= 4 THEN 1 ELSE 0 END), 0)`,
          pcWeight5: sql<number>`COALESCE(SUM(CASE WHEN ${publisherMediaResources.pcWeight} >= 5 THEN 1 ELSE 0 END), 0)`,
          includeRate60: sql<number>`COALESCE(SUM(CASE WHEN ${publisherMediaResources.includeRateBasisPoints} >= 6000 THEN 1 ELSE 0 END), 0)`,
          includeRate70: sql<number>`COALESCE(SUM(CASE WHEN ${publisherMediaResources.includeRateBasisPoints} >= 7000 THEN 1 ELSE 0 END), 0)`,
          includeRate80: sql<number>`COALESCE(SUM(CASE WHEN ${publisherMediaResources.includeRateBasisPoints} >= 8000 THEN 1 ELSE 0 END), 0)`,
          includeRate90: sql<number>`COALESCE(SUM(CASE WHEN ${publisherMediaResources.includeRateBasisPoints} >= 9000 THEN 1 ELSE 0 END), 0)`,
          successRate80: sql<number>`COALESCE(SUM(CASE WHEN ${publisherMediaResources.successRateBasisPoints} >= 8000 THEN 1 ELSE 0 END), 0)`,
          successRate85: sql<number>`COALESCE(SUM(CASE WHEN ${publisherMediaResources.successRateBasisPoints} >= 8500 THEN 1 ELSE 0 END), 0)`,
          successRate90: sql<number>`COALESCE(SUM(CASE WHEN ${publisherMediaResources.successRateBasisPoints} >= 9000 THEN 1 ELSE 0 END), 0)`,
          successRate95: sql<number>`COALESCE(SUM(CASE WHEN ${publisherMediaResources.successRateBasisPoints} >= 9500 THEN 1 ELSE 0 END), 0)`,
          recommendedTrue: sql<number>`COALESCE(SUM(CASE WHEN ${publisherMediaResources.recommended} = TRUE THEN 1 ELSE 0 END), 0)`,
          recommendedFalse: sql<number>`COALESCE(SUM(CASE WHEN ${publisherMediaResources.recommended} = FALSE THEN 1 ELSE 0 END), 0)`,
          authenticatedTrue: sql<number>`COALESCE(SUM(CASE WHEN ${publisherMediaResources.authenticated} = TRUE THEN 1 ELSE 0 END), 0)`,
          authenticatedFalse: sql<number>`COALESCE(SUM(CASE WHEN ${publisherMediaResources.authenticated} = FALSE THEN 1 ELSE 0 END), 0)`,
          festivalTrue: sql<number>`COALESCE(SUM(CASE WHEN ${publisherMediaResources.festivalPublishable} = TRUE THEN 1 ELSE 0 END), 0)`,
          festivalFalse: sql<number>`COALESCE(SUM(CASE WHEN ${publisherMediaResources.festivalPublishable} = FALSE THEN 1 ELSE 0 END), 0)`,
        })
        .from(publisherMediaResources)
        .where(where),
    ]);
    const countByKind = new Map(
      kindRows.map((row) => [row.value, Number(row.total)]),
    );
    const prices = priceRows[0];
    const advancedCounts = advancedCountRows[0];
    const countedOptions = (
      values: ReadonlyArray<readonly [string, unknown]>,
    ) =>
      values
        .map(([value, total]) => ({ value, count: Number(total ?? 0) }))
        .filter(({ count: total }) => total > 0);
    return {
      kindCounts: {
        news: countByKind.get("news") ?? 0,
        selfMedia: countByKind.get("self_media") ?? 0,
      },
      platforms,
      taxonomies,
      mediaTypes,
      areas,
      includeTypes,
      publishSpeeds,
      entryTypes: entryLevels,
      entryLevels,
      linkTypes,
      imageSupports: imageSupportRows.map((row) => ({
        value: row.value,
        count: Number(row.total),
      })),
      pcWeightThresholds: countedOptions([
        ["1", advancedCounts?.pcWeight1],
        ["2", advancedCounts?.pcWeight2],
        ["3", advancedCounts?.pcWeight3],
        ["4", advancedCounts?.pcWeight4],
        ["5", advancedCounts?.pcWeight5],
      ]),
      includeRateThresholds: countedOptions([
        ["60", advancedCounts?.includeRate60],
        ["70", advancedCounts?.includeRate70],
        ["80", advancedCounts?.includeRate80],
        ["90", advancedCounts?.includeRate90],
      ]),
      successRateThresholds: countedOptions([
        ["80", advancedCounts?.successRate80],
        ["85", advancedCounts?.successRate85],
        ["90", advancedCounts?.successRate90],
        ["95", advancedCounts?.successRate95],
      ]),
      recommendedOptions: countedOptions([
        ["true", advancedCounts?.recommendedTrue],
        ["false", advancedCounts?.recommendedFalse],
      ]),
      authenticatedOptions: countedOptions([
        ["true", advancedCounts?.authenticatedTrue],
        ["false", advancedCounts?.authenticatedFalse],
      ]),
      festivalPublishableOptions: countedOptions([
        ["true", advancedCounts?.festivalTrue],
        ["false", advancedCounts?.festivalFalse],
      ]),
      minimumPriceTenThousandths:
        prices?.minimum === null || prices?.minimum === undefined
          ? null
          : String(prices.minimum),
      maximumPriceTenThousandths:
        prices?.maximum === null || prices?.maximum === undefined
          ? null
          : String(prices.maximum),
    };
  }

  async getPublisherMediaLogo(mediaResourceId: string, sha256: string) {
    if (!/^[a-f0-9]{64}$/u.test(sha256)) return undefined;
    const [asset] = await this.db
      .select({
        objectKey: publisherMediaLogoAssets.objectKey,
        contentType: publisherMediaLogoAssets.contentType,
        sizeBytes: publisherMediaLogoAssets.sizeBytes,
        sha256: publisherMediaLogoAssets.sha256,
      })
      .from(publisherMediaLogoAssets)
      .where(
        and(
          eq(publisherMediaLogoAssets.mediaResourceId, mediaResourceId),
          eq(publisherMediaLogoAssets.sha256, sha256),
        ),
      )
      .limit(1);
    if (
      !asset ||
      (asset.contentType !== "image/jpeg" && asset.contentType !== "image/png")
    ) {
      return undefined;
    }
    const contentType: "image/jpeg" | "image/png" = asset.contentType;
    return {
      objectKey: asset.objectKey,
      contentType,
      sizeBytes: asset.sizeBytes,
      sha256: asset.sha256,
    };
  }

  async listPublisherArticleVersions(ownerId: string, articleId: string) {
    await this.getPublisherArticle(ownerId, articleId);
    return this.db
      .select({
        id: publisherArticleVersions.id,
        articleId: publisherArticleVersions.articleId,
        version: publisherArticleVersions.version,
        contentHash: publisherArticleVersions.contentHash,
        containsImages: publisherArticleVersions.containsImages,
        createdAt: publisherArticleVersions.createdAt,
      })
      .from(publisherArticleVersions)
      .where(
        and(
          monitoringProjectOwnerPredicate(publisherArticleVersions, ownerId),
          eq(publisherArticleVersions.articleId, articleId),
        ),
      )
      .orderBy(desc(publisherArticleVersions.version));
  }

  async getPublisherArticleVersion(ownerId: string, articleVersionId: string) {
    const [version] = await this.db
      .select({
        id: publisherArticleVersions.id,
        articleId: publisherArticleVersions.articleId,
        version: publisherArticleVersions.version,
        contentHash: publisherArticleVersions.contentHash,
        containsImages: publisherArticleVersions.containsImages,
        createdAt: publisherArticleVersions.createdAt,
      })
      .from(publisherArticleVersions)
      .where(
        and(
          eq(publisherArticleVersions.id, articleVersionId),
          monitoringProjectOwnerPredicate(publisherArticleVersions, ownerId),
        ),
      )
      .limit(1);
    if (!version) {
      throw new RepositoryError("NOT_FOUND", "Article version not found");
    }
    return version;
  }

  async getPublisherDraft(ownerId: string, draftId: string) {
    const [draft] = await this.db
      .select()
      .from(publisherDrafts)
      .where(
        and(
          eq(publisherDrafts.id, draftId),
          monitoringProjectOwnerPredicate(publisherDrafts, ownerId),
        ),
      )
      .limit(1);
    if (!draft) throw new RepositoryError("NOT_FOUND", "Draft not found");
    const selections = await this.db
      .select({
        draftItem: publisherDraftItems,
        resource: publisherMediaResources,
        imageSupport: publisherMediaCapabilities.imageSupport,
      })
      .from(publisherDraftItems)
      .innerJoin(
        publisherMediaResources,
        eq(publisherMediaResources.id, publisherDraftItems.mediaResourceId),
      )
      .leftJoin(
        publisherMediaCapabilities,
        eq(
          publisherMediaCapabilities.mediaResourceId,
          publisherMediaResources.id,
        ),
      )
      .where(
        and(
          eq(publisherDraftItems.draftId, draftId),
          monitoringProjectOwnerPredicate(publisherDraftItems, ownerId),
        ),
      )
      .orderBy(asc(publisherDraftItems.id));
    return {
      ...draft,
      items: selections.map(({ draftItem, resource, imageSupport }) => ({
        id: draftItem.id,
        submissionTitle: draftItem.submissionTitle,
        selectedPriceTenThousandths:
          draftItem.selectedPriceTenThousandths.toString(),
        selectedCatalogRevision: draftItem.selectedCatalogRevision,
        mediaResource: draftMediaSnapshot(
          draftItem,
          resource,
          imageSupport ?? "unknown",
        ),
      })),
    };
  }

  async listPublisherBatches(
    ownerId: string,
    input: Partial<PublisherBatchListInput> & { activeOnly?: boolean } = {},
  ) {
    const conditions = [
      monitoringProjectOwnerPredicate(publisherBatches, ownerId),
    ];
    if (input.status)
      conditions.push(eq(publisherBatches.status, input.status));
    if (input.from)
      conditions.push(gte(publisherBatches.createdAt, input.from));
    if (input.to) conditions.push(lt(publisherBatches.createdAt, input.to));
    if (input.kind) {
      conditions.push(
        sql`EXISTS (
          SELECT 1 FROM ${publisherItems}
          WHERE ${publisherItems.batchId} = ${publisherBatches.id}
            AND ${monitoringProjectOwnerPredicate(publisherItems, ownerId)}
            AND ${publisherItems.mediaKindSnapshot} = ${input.kind}
        )`,
      );
    }
    if (input.query) {
      const query = `%${escapeLike(input.query.trim())}%`;
      conditions.push(
        sql`(
          ${publisherBatches.id} LIKE ${query}
          OR EXISTS (
            SELECT 1 FROM ${publisherArticleVersions}
            INNER JOIN ${publisherArticles}
              ON ${publisherArticles.id} = ${publisherArticleVersions.articleId}
              AND ${monitoringProjectOwnerPredicate(publisherArticles, ownerId)}
            WHERE ${publisherArticleVersions.id} = ${publisherBatches.articleVersionId}
              AND ${monitoringProjectOwnerPredicate(publisherArticleVersions, ownerId)}
              AND COALESCE(
                NULLIF(NULLIF(TRIM(JSON_UNQUOTE(JSON_EXTRACT(${publisherBatches.preflightSnapshot}, '$.articleSuggestedTitle'))), ''), 'null'),
                NULLIF(NULLIF(TRIM(JSON_UNQUOTE(JSON_EXTRACT(${publisherBatches.preflightSnapshot}, '$.articleWorkingName'))), ''), 'null'),
                ${publisherArticles.suggestedTitle},
                ${publisherArticles.workingName}
              ) LIKE ${query}
          )
          OR EXISTS (
            SELECT 1 FROM ${publisherItems}
            WHERE ${publisherItems.batchId} = ${publisherBatches.id}
              AND ${monitoringProjectOwnerPredicate(publisherItems, ownerId)}
              AND (
                ${publisherItems.mediaNameSnapshot} LIKE ${query}
                OR ${publisherItems.submissionTitle} LIKE ${query}
              )
          )
        )`,
      );
    }
    const pageSize = Math.min(
      Math.max(input.pageSize ?? input.limit ?? 20, 1),
      100,
    );
    const page = Math.max(input.page ?? 1, 1);
    const legacyCursorMode =
      input.page === undefined && input.pageSize === undefined;
    if (input.activeOnly)
      conditions.push(
        inArray(publisherBatches.status, ["queued", "processing"]),
      );
    const [{ total = 0 } = { total: 0 }] = await this.db
      .select({ total: count() })
      .from(publisherBatches)
      .where(and(...conditions));
    const pageConditions = input.cursor
      ? [...conditions, gt(publisherBatches.id, input.cursor)]
      : conditions;
    const rows = await this.db
      .select({
        batch: publisherBatches,
        articleWorkingName: publisherArticles.workingName,
        articleSuggestedTitle: publisherArticles.suggestedTitle,
        articleVersion: publisherArticleVersions.version,
        articleContentHash: publisherArticleVersions.contentHash,
      })
      .from(publisherBatches)
      .innerJoin(
        publisherArticleVersions,
        and(
          eq(publisherArticleVersions.id, publisherBatches.articleVersionId),
          monitoringProjectOwnerPredicate(publisherArticleVersions, ownerId),
        ),
      )
      .innerJoin(
        publisherArticles,
        and(
          eq(publisherArticles.id, publisherArticleVersions.articleId),
          monitoringProjectOwnerPredicate(publisherArticles, ownerId),
        ),
      )
      .where(and(...pageConditions))
      .orderBy(
        legacyCursorMode
          ? asc(publisherBatches.id)
          : desc(publisherBatches.createdAt),
        legacyCursorMode ? asc(publisherBatches.id) : desc(publisherBatches.id),
      )
      .limit(legacyCursorMode ? pageSize + 1 : pageSize)
      .offset(legacyCursorMode ? 0 : (page - 1) * pageSize);
    const pageRows = rows.slice(0, pageSize);
    const summaryItems = pageRows.length
      ? await this.db
          .select({
            batchId: publisherItems.batchId,
            mediaKind: publisherItems.mediaKindSnapshot,
            status: publisherItems.status,
            fundsStatus: publisherItems.fundsStatus,
            priceTenThousandths:
              mediaPublishingItemPriceSnapshots.amountTenThousandths,
          })
          .from(publisherItems)
          .innerJoin(
            mediaPublishingItemPriceSnapshots,
            and(
              eq(mediaPublishingItemPriceSnapshots.itemId, publisherItems.id),
              eq(mediaPublishingItemPriceSnapshots.ownerId, ownerId),
            ),
          )
          .where(
            and(
              monitoringProjectOwnerPredicate(publisherItems, ownerId),
              inArray(
                publisherItems.batchId,
                pageRows.map(({ batch }) => batch.id),
              ),
            ),
          )
      : [];
    const itemsByBatch = new Map<string, typeof summaryItems>();
    for (const item of summaryItems) {
      const items = itemsByBatch.get(item.batchId) ?? [];
      items.push(item);
      itemsByBatch.set(item.batchId, items);
    }
    return {
      items: pageRows.map((row) =>
        batchDto(row.batch, {
          article: {
            workingName:
              snapshotString(
                row.batch.preflightSnapshot,
                "articleWorkingName",
              ) ?? row.articleWorkingName,
            suggestedTitle: snapshotNullableString(
              row.batch.preflightSnapshot,
              "articleSuggestedTitle",
              row.articleSuggestedTitle,
            ),
            version: snapshotNullableNumber(
              row.batch.preflightSnapshot,
              "articleVersion",
              row.articleVersion,
            )!,
            contentHash: row.articleContentHash,
          },
          items: itemsByBatch.get(row.batch.id) ?? [],
        }),
      ),
      total: Number(total),
      page,
      pageSize,
      hasMore: legacyCursorMode
        ? rows.length > pageSize
        : page * pageSize < Number(total),
      legacyCursorMode,
    };
  }

  async getPublisherBatch(ownerId: string, batchId: string) {
    const [row] = await this.db
      .select({
        batch: publisherBatches,
        articleWorkingName: publisherArticles.workingName,
        articleSuggestedTitle: publisherArticles.suggestedTitle,
        articleVersion: publisherArticleVersions.version,
        articleContentHash: publisherArticleVersions.contentHash,
      })
      .from(publisherBatches)
      .innerJoin(
        publisherArticleVersions,
        and(
          eq(publisherArticleVersions.id, publisherBatches.articleVersionId),
          monitoringProjectOwnerPredicate(publisherArticleVersions, ownerId),
        ),
      )
      .innerJoin(
        publisherArticles,
        and(
          eq(publisherArticles.id, publisherArticleVersions.articleId),
          monitoringProjectOwnerPredicate(publisherArticles, ownerId),
        ),
      )
      .where(
        and(
          eq(publisherBatches.id, batchId),
          monitoringProjectOwnerPredicate(publisherBatches, ownerId),
        ),
      )
      .limit(1);
    if (!row)
      throw new RepositoryError("NOT_FOUND", "Publication batch not found");
    const items = await this.db
      .select({
        item: publisherItems,
        price: mediaPublishingItemPriceSnapshots,
      })
      .from(publisherItems)
      .innerJoin(
        mediaPublishingItemPriceSnapshots,
        eq(mediaPublishingItemPriceSnapshots.itemId, publisherItems.id),
      )
      .where(
        and(
          eq(publisherItems.batchId, batchId),
          monitoringProjectOwnerPredicate(publisherItems, ownerId),
        ),
      )
      .orderBy(asc(publisherItems.id));
    return {
      ...batchDto(row.batch, {
        article: {
          workingName:
            snapshotString(row.batch.preflightSnapshot, "articleWorkingName") ??
            row.articleWorkingName,
          suggestedTitle: snapshotNullableString(
            row.batch.preflightSnapshot,
            "articleSuggestedTitle",
            row.articleSuggestedTitle,
          ),
          version: snapshotNullableNumber(
            row.batch.preflightSnapshot,
            "articleVersion",
            row.articleVersion,
          )!,
          contentHash: row.articleContentHash,
        },
        items: items.map(({ item, price }) => ({
          mediaKind: item.mediaKindSnapshot,
          status: item.status,
          fundsStatus: item.fundsStatus,
          priceTenThousandths: price.amountTenThousandths,
        })),
      }),
      items: items.map(({ item, price }) => ({
        id: item.id,
        mediaName: item.mediaNameSnapshot,
        mediaKind: item.mediaKindSnapshot,
        platform: snapshotString(item.mediaMetadataSnapshot, "platform"),
        taxonomy: snapshotString(item.mediaMetadataSnapshot, "taxonomy"),
        area: snapshotString(item.mediaMetadataSnapshot, "area"),
        logoUrl: publisherMediaLogoSnapshotPath(
          snapshotNullableString(item.mediaMetadataSnapshot, "logoUrl", null),
        ),
        logoSource:
          snapshotPublisherMediaLogoSource(item.mediaMetadataSnapshot) ??
          "generated_fallback",
        logoResolutionStatus: snapshotPublisherMediaLogoResolutionStatus(
          item.mediaMetadataSnapshot,
          "missing",
        ),
        submissionTitle: item.submissionTitle,
        status: item.status,
        fundsStatus: item.fundsStatus,
        priceTenThousandths: price.amountTenThousandths.toString(),
        publishedUrl: item.publishedUrl,
        failureReason: item.failureReason,
        actionRequiredReason: item.actionRequiredReason,
        submittedAt: item.submittedAt,
        completedAt: item.completedAt,
      })),
    };
  }

  async getPublisherDashboard(ownerId: string) {
    const wallet = await this.getMediaPublishingBillingSummary(ownerId);
    const [runtime] = await this.db
      .select()
      .from(publisherRuntimeState)
      .where(eq(publisherRuntimeState.id, "kol"))
      .limit(1);
    const resumableDraftCondition = and(
      monitoringProjectOwnerPredicate(publisherDrafts, ownerId),
      inArray(publisherDrafts.status, ["draft", "ready"]),
    );
    const [[resumableDraftTotal], drafts] = await Promise.all([
      this.db
        .select({ count: count() })
        .from(publisherDrafts)
        .where(resumableDraftCondition),
      this.db
        .select({
          id: publisherDrafts.id,
          status: publisherDrafts.status,
          updatedAt: publisherDrafts.updatedAt,
          articleWorkingName: publisherArticles.workingName,
          articleSuggestedTitle: publisherArticles.suggestedTitle,
          articleVersion: publisherArticleVersions.version,
        })
        .from(publisherDrafts)
        .innerJoin(
          publisherArticleVersions,
          and(
            eq(publisherArticleVersions.id, publisherDrafts.articleVersionId),
            monitoringProjectOwnerPredicate(publisherArticleVersions, ownerId),
          ),
        )
        .innerJoin(
          publisherArticles,
          and(
            eq(publisherArticles.id, publisherArticleVersions.articleId),
            monitoringProjectOwnerPredicate(publisherArticles, ownerId),
          ),
        )
        .where(resumableDraftCondition)
        .orderBy(desc(publisherDrafts.updatedAt), desc(publisherDrafts.id))
        .limit(3),
    ]);
    const recent = await this.listPublisherBatches(ownerId, {
      page: 1,
      pageSize: 5,
    });
    const [actionRequired] = await this.db
      .select({ count: sql<number>`COUNT(*)` })
      .from(publisherBatches)
      .where(
        and(
          monitoringProjectOwnerPredicate(publisherBatches, ownerId),
          eq(publisherBatches.status, "action_required"),
        ),
      );
    // Lightweight covering-index counts; the overview never loads catalog facets.
    const [kindRows, [articleTotal], articles, processing] = await Promise.all([
      this.db
        .select({ kind: publisherMediaResources.mediaKind, total: count() })
        .from(publisherMediaResources)
        .where(
          and(
            eq(publisherMediaResources.isActive, true),
            isNotNull(publisherMediaResources.mediaKind),
          ),
        )
        .groupBy(publisherMediaResources.mediaKind),
      this.db
        .select({ total: count() })
        .from(publisherArticles)
        .where(monitoringProjectOwnerPredicate(publisherArticles, ownerId)),
      this.db
        .select({
          id: publisherArticles.id,
          workingName: publisherArticles.workingName,
          suggestedTitle: publisherArticles.suggestedTitle,
          status: publisherArticles.status,
          currentVersionId: publisherArticles.currentVersionId,
          currentVersion: publisherArticleVersions.version,
          containsImages: publisherArticles.containsImages,
          revision: publisherArticles.revision,
          updatedAt: publisherArticles.updatedAt,
          createdAt: publisherArticles.createdAt,
        })
        .from(publisherArticles)
        .leftJoin(
          publisherArticleVersions,
          and(
            eq(publisherArticleVersions.id, publisherArticles.currentVersionId),
            eq(publisherArticleVersions.articleId, publisherArticles.id),
            monitoringProjectOwnerPredicate(publisherArticleVersions, ownerId),
          ),
        )
        .where(
          and(
            monitoringProjectOwnerPredicate(publisherArticles, ownerId),
            inArray(publisherArticles.status, ["draft", "ready"]),
          ),
        )
        .orderBy(desc(publisherArticles.updatedAt), desc(publisherArticles.id))
        .limit(3),
      this.listPublisherBatches(ownerId, {
        page: 1,
        pageSize: 3,
        activeOnly: true,
      }),
    ]);
    const now = new Date();
    return {
      catalogCounts: {
        news: Number(kindRows.find((row) => row.kind === "news")?.total ?? 0),
        selfMedia: Number(
          kindRows.find((row) => row.kind === "self_media")?.total ?? 0,
        ),
      },
      articleCount: Number(articleTotal?.total ?? 0),
      resumableArticles: articles,
      processingBatchCount: processing.total,
      processingBatches: processing.items,
      catalogRevision: runtime?.activeCatalogRevision ?? null,
      catalogSyncedAt: runtime?.catalogSyncedAt ?? null,
      catalogStale:
        !runtime?.catalogSyncedAt ||
        now.getTime() - runtime.catalogSyncedAt.getTime() > CATALOG_STALE_MS,
      kindComplete: runtime?.catalogKindComplete ?? false,
      wallet: {
        availableTenThousandths: wallet.availableTenThousandths,
        reservedTenThousandths: wallet.reservedTenThousandths,
        frozenTenThousandths: wallet.frozenTenThousandths,
      },
      resumableDraftCount: Number(resumableDraftTotal?.count ?? 0),
      resumableDrafts: drafts.map((draft) => ({
        id: draft.id,
        articleTitle:
          draft.articleSuggestedTitle?.trim() || draft.articleWorkingName,
        articleVersion: draft.articleVersion,
        status: draft.status as "draft" | "ready",
        updatedAt: draft.updatedAt,
      })),
      actionRequiredCount: Number(actionRequired?.count ?? 0),
      recentBatches: recent.items,
    };
  }

  async getPublisherRuntimeState() {
    const [runtime] = await this.db
      .select()
      .from(publisherRuntimeState)
      .where(eq(publisherRuntimeState.id, "kol"))
      .limit(1);
    return runtime ?? null;
  }

  async updatePublisherRuntimeState(
    input: Partial<{
      mode: PublicationMode;
      featureEnabled: boolean;
      publishEnabled: boolean;
      imagePublishEnabled: boolean;
      webhookEnabled: boolean;
      emergencyStop: boolean;
      changedBy: string | null;
    }>,
  ) {
    return this.db.transaction(async (tx) => {
      const [current] = await tx
        .select()
        .from(publisherRuntimeState)
        .where(eq(publisherRuntimeState.id, "kol"))
        .for("update")
        .limit(1);
      if (
        input.imagePublishEnabled === true &&
        current?.imagePublishEnabled !== true
      ) {
        const blocker = await completedPublisherImageCanaryBlocker(tx);
        if (blocker) throw new RepositoryError("INVALID_STATE", blocker);
      }
      await tx
        .insert(publisherRuntimeState)
        .values({ id: "kol", ...input })
        .onDuplicateKeyUpdate({ set: input });
      const [updated] = await tx
        .select()
        .from(publisherRuntimeState)
        .where(eq(publisherRuntimeState.id, "kol"))
        .limit(1);
      return updated ?? null;
    });
  }

  async requestPublisherCatalogSync(actorId: string, requestedAt = new Date()) {
    const syncRunId = randomUUID();
    await this.db.transaction(async (tx) => {
      await tx.insert(publisherJobs).values({
        id: randomUUID(),
        type: "sync_kol_catalog",
        enterpriseProjectId: null,
        deterministicKey: `publisher:catalog:admin-request:${syncRunId}`,
        aggregateId: syncRunId,
        payload: { requestedBy: actorId, syncRunId },
        availableAt: requestedAt,
        maxAttempts: 8,
      });
      await tx.insert(auditLogs).values({
        id: randomUUID(),
        actorId,
        actorRole: "admin",
        action: "admin.publisher_catalog_sync_requested",
        targetType: "publisher_catalog",
        metadata: { requestedAt: requestedAt.toISOString(), syncRunId },
      });
    });
    return { syncRunId };
  }

  async listPublisherMediaSyncRuns(limit = 50) {
    const runs = await this.db
      .select()
      .from(publisherMediaSyncRuns)
      .orderBy(desc(publisherMediaSyncRuns.startedAt))
      .limit(Math.min(Math.max(limit, 1), 100));
    if (!runs.length) return [];
    // Audit URLs and timestamps vary per media. Count the one required flag
    // without making the full JSON document a high-cardinality grouping key.
    const logoProgress = await this.db
      .select({
        runId: publisherMediaLogoResolutions.syncRunId,
        status: publisherMediaLogoResolutions.status,
        sourceKind: publisherMediaLogoResolutions.sourceKind,
        unverifiedTotal:
          sql<number>`sum(case when JSON_UNQUOTE(JSON_EXTRACT(${publisherMediaLogoResolutions.reviewAudit}, '$.verification')) = 'unverified' then 1 else 0 end)`.mapWith(
            Number,
          ),
        total: count(),
      })
      .from(publisherMediaLogoResolutions)
      .where(
        inArray(
          publisherMediaLogoResolutions.syncRunId,
          runs.map(({ id }) => id),
        ),
      )
      .groupBy(
        publisherMediaLogoResolutions.syncRunId,
        publisherMediaLogoResolutions.status,
        publisherMediaLogoResolutions.sourceKind,
      );
    type LogoProgress = {
      total: number;
      logoPending: number;
      logoArchived: number;
      logoFailed: number;
      logoProviderArchived: number;
      logoIconArchived: number;
      logoSiteFaviconArchived: number;
      logoWebSearchVerifiedArchived: number;
      logoManualVerifiedArchived: number;
      logoPendingReview: number;
      logoGeneratedFallback: number;
      logoMissing: number;
      logoRealMissing: number;
    };
    const logoByRun = new Map<string, LogoProgress>();
    for (const progress of logoProgress) {
      if (!progress.runId) continue;
      const summary = logoByRun.get(progress.runId) ?? {
        total: 0,
        logoPending: 0,
        logoArchived: 0,
        logoFailed: 0,
        logoProviderArchived: 0,
        logoIconArchived: 0,
        logoSiteFaviconArchived: 0,
        logoWebSearchVerifiedArchived: 0,
        logoManualVerifiedArchived: 0,
        logoPendingReview: 0,
        logoGeneratedFallback: 0,
        logoMissing: 0,
        logoRealMissing: 0,
      };
      summary.total += progress.total;
      if (progress.status === "archived") {
        summary.logoArchived += progress.total;
        if (progress.sourceKind === "logo") {
          summary.logoProviderArchived += progress.total;
        } else if (progress.sourceKind === "icon") {
          summary.logoIconArchived += progress.total;
        } else if (progress.sourceKind === "site_favicon") {
          summary.logoSiteFaviconArchived += progress.total;
        } else if (progress.sourceKind === "web_search_verified") {
          summary.logoWebSearchVerifiedArchived += progress.total;
        } else if (progress.sourceKind === "manual_verified") {
          summary.logoManualVerifiedArchived += progress.total;
        } else if (progress.sourceKind === "generated_fallback") {
          summary.logoGeneratedFallback += progress.total;
        }
      }
      if (progress.status === "pending") summary.logoPending += progress.total;
      if (progress.status === "pending_review") {
        summary.logoPendingReview += progress.total;
      }
      if (
        progress.status === "archived" &&
        progress.sourceKind !== "manual_verified"
      ) {
        summary.logoPendingReview += progress.unverifiedTotal;
      }
      if (progress.status === "failed") summary.logoFailed += progress.total;
      if (progress.status === "missing") summary.logoMissing += progress.total;
      logoByRun.set(progress.runId, summary);
    }
    return runs.map((run) => {
      const progress = logoByRun.get(run.id) ?? {
        total: 0,
        logoPending: 0,
        logoArchived: 0,
        logoFailed: 0,
        logoProviderArchived: 0,
        logoIconArchived: 0,
        logoSiteFaviconArchived: 0,
        logoWebSearchVerifiedArchived: 0,
        logoManualVerifiedArchived: 0,
        logoPendingReview: 0,
        logoGeneratedFallback: 0,
        logoMissing: 0,
        logoRealMissing: 0,
      };
      const realLogoCoverage = publisherRealLogoCoverage(progress);
      return {
        ...run,
        ...progress,
        // A site favicon improves recognition but is not proof of the media's
        // own logo, so it remains part of the real-logo gap.
        logoRealMissing: realLogoCoverage.logoRealMissing,
        logoRealCoverageBasisPoints:
          realLogoCoverage.logoRealCoverageBasisPoints,
      };
    });
  }

  async listPublisherMediaCapabilities(limit = 100) {
    return this.db
      .select({
        mediaResourceId: publisherMediaResources.id,
        externalResourceId: publisherMediaResources.externalResourceId,
        mediaName: publisherMediaResources.name,
        priceTenThousandths: publisherMediaResources.priceTenThousandths,
        liveWhitelistMediaResourceId: publisherLiveWhitelist.mediaResourceId,
        liveImageAllowed: publisherLiveWhitelist.imageAllowed,
        imageSupport: publisherMediaCapabilities.imageSupport,
        contentProfile: publisherMediaCapabilities.contentProfile,
        evidenceUrl: publisherMediaCapabilities.evidenceUrl,
        verifiedAt: publisherMediaCapabilities.verifiedAt,
        verifiedBy: publisherMediaCapabilities.verifiedBy,
        notes: publisherMediaCapabilities.notes,
        updatedAt: publisherMediaCapabilities.updatedAt,
      })
      .from(publisherMediaResources)
      .leftJoin(
        publisherMediaCapabilities,
        eq(
          publisherMediaCapabilities.mediaResourceId,
          publisherMediaResources.id,
        ),
      )
      .leftJoin(
        publisherLiveWhitelist,
        eq(publisherLiveWhitelist.mediaResourceId, publisherMediaResources.id),
      )
      .where(eq(publisherMediaResources.isActive, true))
      .orderBy(
        asc(publisherMediaCapabilities.verifiedAt),
        asc(publisherMediaResources.name),
      )
      .limit(Math.min(Math.max(limit, 1), 100));
  }

  /**
   * Freezes an administrator-verified upload as the current media logo. The
   * caller must normalize and privately store the bytes before invoking this
   * method. The audit record deliberately stores no upstream/provider secret.
   */
  async setPublisherMediaManualLogo(input: {
    mediaResourceId: string;
    actorId: string;
    objectKey: string;
    contentType: "image/jpeg" | "image/png";
    sizeBytes: number;
    sha256: string;
    reason: string;
    verifiedAt?: Date;
  }) {
    const verifiedAt = input.verifiedAt ?? new Date();
    if (
      !input.objectKey.startsWith("publisher/media-logos/") ||
      !/^[a-f0-9]{64}$/u.test(input.sha256) ||
      !Number.isSafeInteger(input.sizeBytes) ||
      input.sizeBytes < 1 ||
      input.sizeBytes > 2 * 1_024 * 1_024 ||
      !input.reason.trim() ||
      input.reason.trim().length > 240 ||
      !Number.isFinite(verifiedAt.getTime())
    ) {
      throw new RepositoryError("INVALID_STATE", "Invalid manual media logo");
    }
    return this.db.transaction(async (tx) => {
      const [resource] = await tx
        .select()
        .from(publisherMediaResources)
        .where(eq(publisherMediaResources.id, input.mediaResourceId))
        .for("update")
        .limit(1);
      if (!resource || !resource.lastSeenCompleteRunId) {
        throw new RepositoryError("NOT_FOUND", "Media resource not found");
      }
      await tx
        .insert(publisherMediaLogoAssets)
        .values({
          mediaResourceId: resource.id,
          sha256: input.sha256,
          sourceKind: "manual_verified",
          objectKey: input.objectKey,
          contentType: input.contentType,
          sizeBytes: BigInt(input.sizeBytes),
          catalogRevision: resource.catalogRevision,
          reviewAudit: null,
          archivedAt: verifiedAt,
        })
        .onDuplicateKeyUpdate({
          set: {
            sourceKind: "manual_verified",
            objectKey: input.objectKey,
            contentType: input.contentType,
            sizeBytes: BigInt(input.sizeBytes),
            catalogRevision: resource.catalogRevision,
            archivedAt: verifiedAt,
          },
        });
      await tx
        .update(publisherMediaResources)
        .set({
          logoArchiveStatus: "archived",
          logoSourceKind: "manual_verified",
          logoSourceUrl: null,
          logoObjectKey: input.objectKey,
          logoContentType: input.contentType,
          logoSizeBytes: BigInt(input.sizeBytes),
          logoSha256: input.sha256,
          logoCheckedAt: verifiedAt,
          logoArchiveError: null,
          logoReviewAudit: null,
        })
        .where(eq(publisherMediaResources.id, resource.id));
      await tx
        .update(publisherMediaLogoResolutions)
        .set({
          status: "archived",
          sourceKind: "manual_verified",
          logoSha256: input.sha256,
          errorCode: null,
          reviewAudit: null,
          checkedAt: verifiedAt,
        })
        .where(
          and(
            eq(
              publisherMediaLogoResolutions.syncRunId,
              resource.lastSeenCompleteRunId,
            ),
            eq(publisherMediaLogoResolutions.mediaResourceId, resource.id),
          ),
        );
      await tx.insert(auditLogs).values({
        id: randomUUID(),
        actorId: input.actorId,
        actorRole: "admin",
        action: "admin.publisher_media_logo_uploaded",
        targetType: "publisher_media",
        targetIdHash: sha256(resource.id),
        metadata: {
          reason: input.reason.trim(),
          logoSha256: input.sha256,
          catalogRevision: resource.catalogRevision,
          verifiedAt: verifiedAt.toISOString(),
        },
      });
      return {
        mediaResourceId: resource.id,
        logoUrl: `/api/monitoring/publisher/media-logos/${encodeURIComponent(resource.id)}/${input.sha256}`,
        logoSource: "manual_verified" as const,
        logoResolutionStatus: "archived" as const,
      };
    });
  }

  async setPublisherMediaCapability(input: {
    mediaResourceId: string;
    imageSupport: "unknown" | "verified" | "unsupported";
    contentProfile: string;
    evidenceUrl?: string | null;
    notes?: string | null;
    verifiedBy: string;
    verifiedAt?: Date;
  }) {
    const id = randomUUID();
    const verifiedAt = input.verifiedAt ?? new Date();
    if (!Number.isFinite(verifiedAt.getTime())) {
      throw new RepositoryError(
        "INVALID_STATE",
        "Capability verification timestamp is invalid",
      );
    }
    if (input.imageSupport === "verified") {
      const blocker = publisherImageCapabilityEvidenceBlocker({
        imageSupport: input.imageSupport,
        evidenceUrl: input.evidenceUrl,
        verifiedAt,
      });
      if (blocker) throw new RepositoryError("INVALID_STATE", blocker);
    }
    await this.db
      .insert(publisherMediaCapabilities)
      .values({
        id,
        mediaResourceId: input.mediaResourceId,
        imageSupport: input.imageSupport,
        contentProfile: truncateText(input.contentProfile, 64),
        evidenceUrl: input.evidenceUrl ?? null,
        notes: input.notes ?? null,
        verifiedBy: input.verifiedBy,
        verifiedAt,
      })
      .onDuplicateKeyUpdate({
        set: {
          imageSupport: input.imageSupport,
          contentProfile: truncateText(input.contentProfile, 64),
          evidenceUrl: input.evidenceUrl ?? null,
          notes: input.notes ?? null,
          verifiedBy: input.verifiedBy,
          verifiedAt,
        },
      });
  }

  async setPublisherLiveWhitelist(input: {
    mediaResourceId: string;
    enabled: boolean;
    imageAllowed: boolean;
    reason: string;
    actorId: string;
    changedAt?: Date;
  }) {
    const changedAt = input.changedAt ?? new Date();
    await this.db.transaction(async (tx) => {
      if (input.enabled) {
        const blocker = await publisherCanaryWhitelistBlocker(tx, input);
        if (blocker) throw new RepositoryError("INVALID_STATE", blocker);
      }
      if (input.enabled) {
        await tx
          .insert(publisherLiveWhitelist)
          .values({
            mediaResourceId: input.mediaResourceId,
            imageAllowed: input.imageAllowed,
            reason: truncateText(input.reason, 240),
            enabledBy: input.actorId,
            enabledAt: changedAt,
          })
          .onDuplicateKeyUpdate({
            set: {
              imageAllowed: input.imageAllowed,
              reason: truncateText(input.reason, 240),
              enabledBy: input.actorId,
              enabledAt: changedAt,
            },
          });
      } else {
        await tx
          .delete(publisherLiveWhitelist)
          .where(
            eq(publisherLiveWhitelist.mediaResourceId, input.mediaResourceId),
          );
      }
      await tx.insert(auditLogs).values({
        id: randomUUID(),
        actorId: input.actorId,
        actorRole: "admin",
        action: input.enabled
          ? "admin.publisher_live_media_enabled"
          : "admin.publisher_live_media_disabled",
        targetType: "publisher_media",
        targetIdHash: sha256(input.mediaResourceId),
        metadata: {
          imageAllowed: input.imageAllowed,
          reason: input.reason,
          changedAt: changedAt.toISOString(),
        },
      });
    });
  }

  async listPublisherUnknownItems(limit = 100) {
    return this.db
      .select({
        item: publisherItems,
        batch: publisherBatches,
        price: mediaPublishingItemPriceSnapshots,
        username: users.username,
      })
      .from(publisherItems)
      .innerJoin(
        publisherBatches,
        eq(publisherItems.batchId, publisherBatches.id),
      )
      .innerJoin(
        mediaPublishingItemPriceSnapshots,
        eq(mediaPublishingItemPriceSnapshots.itemId, publisherItems.id),
      )
      .innerJoin(users, eq(publisherItems.ownerId, users.id))
      .where(
        inArray(publisherItems.status, [
          "submission_unknown",
          "action_required",
        ]),
      )
      .orderBy(asc(publisherItems.updatedAt))
      .limit(Math.min(Math.max(limit, 1), 100));
  }

  async listPublisherReconciliationCandidates(itemId: string) {
    return this.db
      .select()
      .from(publisherReconciliationCandidates)
      .where(eq(publisherReconciliationCandidates.itemId, itemId))
      .orderBy(desc(publisherReconciliationCandidates.confidenceBasisPoints));
  }

  async bindPublisherReconciliationCandidate(input: {
    itemId: string;
    candidateId: string;
    actorId: string;
    reason: string;
    boundAt?: Date;
  }) {
    const boundAt = input.boundAt ?? new Date();
    await this.db.transaction(async (tx) => {
      const [item] = await tx
        .select()
        .from(publisherItems)
        .where(eq(publisherItems.id, input.itemId))
        .for("update")
        .limit(1);
      const [candidate] = await tx
        .select()
        .from(publisherReconciliationCandidates)
        .where(
          and(
            eq(publisherReconciliationCandidates.id, input.candidateId),
            eq(publisherReconciliationCandidates.itemId, input.itemId),
          ),
        )
        .for("update")
        .limit(1);
      if (!item || !candidate) {
        throw new RepositoryError(
          "NOT_FOUND",
          "Reconciliation candidate not found",
        );
      }
      if (
        item.status !== "submission_unknown" &&
        item.status !== "action_required"
      ) {
        throw new RepositoryError(
          "CONFLICT",
          "Item no longer needs reconciliation",
        );
      }
      // UNKNOWN has no accepted-response timestamp. Recover the polling clock
      // from the durable send attempt, never from the later admin binding time.
      const [attempt] = item.submittedAt
        ? []
        : await tx
            .select({ startedAt: publisherSubmissionAttempts.startedAt })
            .from(publisherSubmissionAttempts)
            .where(
              and(
                eq(publisherSubmissionAttempts.itemId, item.id),
                eq(publisherSubmissionAttempts.ownerId, item.ownerId),
                eq(
                  publisherSubmissionAttempts.attemptNumber,
                  item.attemptCount,
                ),
              ),
            )
            .limit(1);
      const submittedAt = item.submittedAt ?? attempt?.startedAt;
      if (!submittedAt || !Number.isFinite(submittedAt.getTime())) {
        throw new RepositoryError(
          "CONFLICT",
          "Submission time evidence is missing; the order cannot be bound",
        );
      }
      await tx
        .update(publisherItems)
        .set({
          status: "processing",
          externalOrderId: candidate.externalOrderId,
          submittedAt,
          actionRequiredReason: null,
          nextPollAt: boundAt,
        })
        .where(eq(publisherItems.id, item.id));
      await tx
        .update(publisherReconciliationCandidates)
        .set({ boundAt, boundBy: input.actorId })
        .where(eq(publisherReconciliationCandidates.id, candidate.id));
      await tx.insert(publisherJobs).values({
        id: randomUUID(),
        type: "poll_publication_item",
        deterministicKey: `publisher:poll-bound:${item.id}:${candidate.externalOrderId}`,
        aggregateId: item.id,
        enterpriseProjectId: item.enterpriseProjectId,
        payload: { itemId: item.id },
        availableAt: boundAt,
      });
      await tx.insert(auditLogs).values({
        id: randomUUID(),
        actorId: input.actorId,
        actorRole: "admin",
        action: "admin.publisher_unknown_bound",
        targetType: "publication_item",
        targetIdHash: sha256(item.id),
        ownerId: item.ownerId,
        metadata: {
          candidateId: candidate.id,
          externalOrderId: candidate.externalOrderId,
          reason: input.reason,
        },
      });
    });
  }

  async authorizePublisherResubmit(input: {
    itemId: string;
    actorId: string;
    reason: string;
    authorizedAt?: Date;
  }) {
    const authorizedAt = input.authorizedAt ?? new Date();
    await this.db.transaction(async (tx) => {
      const [item] = await tx
        .select()
        .from(publisherItems)
        .where(eq(publisherItems.id, input.itemId))
        .for("update")
        .limit(1);
      if (!item)
        throw new RepositoryError("NOT_FOUND", "Publication item not found");
      if (item.status !== "submission_unknown" || item.externalOrderId) {
        throw new RepositoryError(
          "CONFLICT",
          "Only an unbound UNKNOWN item can be resubmitted",
        );
      }
      const [boundCandidate] = await tx
        .select({ id: publisherReconciliationCandidates.id })
        .from(publisherReconciliationCandidates)
        .where(
          and(
            eq(publisherReconciliationCandidates.itemId, item.id),
            sql`${publisherReconciliationCandidates.boundAt} IS NOT NULL`,
          ),
        )
        .limit(1);
      if (boundCandidate) {
        throw new RepositoryError(
          "CONFLICT",
          "Item is already bound to an order",
        );
      }
      await reactivatePublisherItemReservation(tx, {
        itemId: item.id,
        actorId: input.actorId,
        authorizedAt,
        reason: input.reason,
      });
      await tx
        .update(publisherItems)
        .set({
          status: "queued",
          actionRequiredReason: null,
          requestHash: null,
          nextPollAt: null,
        })
        .where(eq(publisherItems.id, item.id));
      await tx.insert(publisherJobs).values({
        id: randomUUID(),
        type: "submit_publication_item",
        deterministicKey: `publisher:resubmit:${item.id}:${item.attemptCount + 1}`,
        aggregateId: item.id,
        enterpriseProjectId: item.enterpriseProjectId,
        payload: { itemId: item.id },
        availableAt: authorizedAt,
      });
      await tx.insert(auditLogs).values({
        id: randomUUID(),
        actorId: input.actorId,
        actorRole: "admin",
        action: "admin.publisher_unknown_resubmit_authorized",
        targetType: "publication_item",
        targetIdHash: sha256(item.id),
        ownerId: item.ownerId,
        metadata: {
          reason: input.reason,
          attemptNumber: item.attemptCount + 1,
        },
      });
    });
  }

  async savePublisherDraft(
    ownerId: string,
    input: Omit<PublisherSaveDraftInput, "titleMode"> & {
      titleMode?: PublisherTitleMode;
    },
  ) {
    return this.db.transaction(async (tx) => {
      await assertMonitoringEnterpriseProjectActive(tx, monitoringEnterpriseProjectIdForOwner(ownerId), ownerId);
      // The existing audit receipt and draft commit together. Serialize creates
      // for this owner so a lost response or a double click can only make one
      // draft, without changing the draft schema or bypassing project scope.
      let createReceipt: { id: string; requestHash: string } | undefined;
      if (!input.draftId && input.idempotencyKey) {
        const projectId = monitoringEnterpriseProjectIdForOwner(ownerId);
        const hash = sha256(
          JSON.stringify([
            "publisher.draft.create",
            ownerId,
            projectId,
            input.idempotencyKey,
          ]),
        );
        const id = `${hash.slice(0, 8)}-${hash.slice(8, 12)}-5${hash.slice(13, 16)}-a${hash.slice(17, 20)}-${hash.slice(20, 32)}`;
        const requestHash = sha256(
          JSON.stringify({
            articleVersionId: input.articleVersionId,
            expectedRevision: input.expectedRevision,
            titleMode: input.titleMode ?? null,
            sharedTitle: input.sharedTitle?.trim() || null,
            items: [...input.items].sort((a, b) =>
              a.mediaResourceId.localeCompare(b.mediaResourceId),
            ),
          }),
        );
        await tx
          .select({ id: users.id })
          .from(users)
          .where(eq(users.id, ownerId))
          .for("update")
          .limit(1);
        const [receipt] = await tx
          .select()
          .from(auditLogs)
          .where(and(eq(auditLogs.id, id), eq(auditLogs.ownerId, ownerId)))
          .limit(1);
        if (receipt) {
          if (
            receipt.action !== "publisher.draft_created" ||
            receipt.metadata?.requestHash !== requestHash ||
            typeof receipt.metadata?.draftId !== "string"
          )
            throw new RepositoryError(
              "CONFLICT",
              "Draft idempotency key is already bound to another request",
            );
          const [replay] = await tx
            .select()
            .from(publisherDrafts)
            .where(
              and(
                eq(publisherDrafts.id, receipt.metadata.draftId),
                monitoringProjectOwnerPredicate(publisherDrafts, ownerId),
              ),
            )
            .limit(1);
          if (!replay)
            throw new RepositoryError("NOT_FOUND", "Draft not found");
          return { id: replay.id, revision: replay.revision };
        }
        createReceipt = { id, requestHash };
      }
      const uniqueMediaIds = new Set(
        input.items.map((item) => item.mediaResourceId),
      );
      if (
        uniqueMediaIds.size !== input.items.length ||
        input.items.length > 20
      ) {
        throw new RepositoryError(
          "INVALID_STATE",
          "A draft allows at most twenty distinct media resources",
        );
      }
      const [version] = await tx
        .select()
        .from(publisherArticleVersions)
        .where(
          and(
            eq(publisherArticleVersions.id, input.articleVersionId),
            monitoringProjectOwnerPredicate(publisherArticleVersions, ownerId),
          ),
        )
        .limit(1);
      if (!version)
        throw new RepositoryError("NOT_FOUND", "Article version not found");
      const resources = uniqueMediaIds.size
        ? await tx
            .select({
              resource: publisherMediaResources,
              imageSupport: publisherMediaCapabilities.imageSupport,
            })
            .from(publisherMediaResources)
            .leftJoin(
              publisherMediaCapabilities,
              eq(
                publisherMediaCapabilities.mediaResourceId,
                publisherMediaResources.id,
              ),
            )
            .where(inArray(publisherMediaResources.id, [...uniqueMediaIds]))
        : [];
      if (
        resources.length !== uniqueMediaIds.size ||
        resources.some(
          ({ resource }) =>
            !resource.isActive ||
            !resource.mediaKind ||
            resource.priceTenThousandths <= 0n,
        )
      ) {
        throw new RepositoryError(
          "INVALID_STATE",
          "Selected media is unavailable",
        );
      }
      const resourceById = new Map(
        resources.map((row) => [row.resource.id, row]),
      );
      let draftId = input.draftId;
      let nextRevision = 1;
      let previousTitleByMedia = new Map<string, string>();
      let previousItemByMedia = new Map<
        string,
        typeof publisherDraftItems.$inferSelect
      >();
      let titleMode: PublisherTitleMode;
      let sharedTitle: string | null;
      if (draftId) {
        const [draft] = await tx
          .select()
          .from(publisherDrafts)
          .where(
            and(
              eq(publisherDrafts.id, draftId),
              monitoringProjectOwnerPredicate(publisherDrafts, ownerId),
            ),
          )
          .for("update")
          .limit(1);
        if (!draft) throw new RepositoryError("NOT_FOUND", "Draft not found");
        if (draft.revision !== input.expectedRevision) {
          throw new RepositoryError("CONFLICT", "Draft revision has changed");
        }
        if (draft.status === "submitted" || draft.status === "archived") {
          throw new RepositoryError("INVALID_STATE", "Draft cannot be changed");
        }
        titleMode = input.titleMode ?? draft.titleMode;
        sharedTitle =
          input.sharedTitle === undefined
            ? draft.sharedTitle
            : input.sharedTitle?.trim() || null;
        const previousItems = await tx
          .select()
          .from(publisherDraftItems)
          .where(
            and(
              eq(publisherDraftItems.draftId, draftId),
              monitoringProjectOwnerPredicate(publisherDraftItems, ownerId),
            ),
          );
        previousTitleByMedia = new Map(
          previousItems.map((item) => [
            item.mediaResourceId,
            item.submissionTitle,
          ]),
        );
        previousItemByMedia = new Map(
          previousItems.map((item) => [item.mediaResourceId, item]),
        );
        nextRevision = draft.revision + 1;
        await tx
          .delete(publisherDraftItems)
          .where(
            and(
              eq(publisherDraftItems.draftId, draftId),
              monitoringProjectOwnerPredicate(publisherDraftItems, ownerId),
            ),
          );
        await tx
          .update(publisherDrafts)
          .set({
            articleVersionId: input.articleVersionId,
            revision: nextRevision,
            titleMode,
            sharedTitle,
            status: "draft",
          })
          .where(
            and(
              eq(publisherDrafts.id, draftId),
              monitoringProjectOwnerPredicate(publisherDrafts, ownerId),
            ),
          );
      } else {
        if (input.expectedRevision !== 0) {
          throw new RepositoryError(
            "CONFLICT",
            "A new draft starts at revision zero",
          );
        }
        titleMode =
          input.titleMode ??
          (input.items.some((item) => item.submissionTitle?.trim())
            ? "per_media"
            : "single");
        sharedTitle = input.sharedTitle?.trim() || null;
        draftId = randomUUID();
        await tx.insert(publisherDrafts).values({
          id: draftId,
          ownerId,
          articleVersionId: input.articleVersionId,
          revision: nextRevision,
          titleMode,
          sharedTitle,
          status: "draft",
        });
      }
      const selectedAt = new Date();
      const values = input.items.map((item) => {
        const selected = resourceById.get(item.mediaResourceId);
        if (!selected)
          throw new RepositoryError("INVALID_STATE", "Media disappeared");
        const resource = selected.resource;
        const previousItem = previousItemByMedia.get(item.mediaResourceId);
        const submissionTitle =
          titleMode === "single" && sharedTitle
            ? sharedTitle
            : item.submissionTitle?.trim() ||
              previousTitleByMedia.get(item.mediaResourceId) ||
              "";
        const selectedTitleLimit = previousItem
          ? (snapshotNullableNumber(
              previousItem.mediaSnapshot,
              "titleLimit",
              null,
            ) ?? 200)
          : (resource.titleLimit ?? 200);
        if (unicodeLength(submissionTitle) > selectedTitleLimit) {
          throw new RepositoryError("INVALID_STATE", "Media title is invalid");
        }
        return {
          id: previousItem?.id ?? randomUUID(),
          ownerId,
          draftId,
          mediaResourceId: resource.id,
          externalResourceId:
            previousItem?.externalResourceId ?? resource.externalResourceId,
          submissionTitle,
          selectedPriceTenThousandths:
            previousItem?.selectedPriceTenThousandths ??
            resource.priceTenThousandths,
          selectedCatalogRevision:
            previousItem?.selectedCatalogRevision ?? resource.catalogRevision,
          mediaKindSnapshot:
            previousItem?.mediaKindSnapshot ?? resource.mediaKind!,
          mediaSnapshot: previousItem?.mediaSnapshot ?? {
            ...customerSafeMediaSnapshot(resource),
            imageSupport: selected.imageSupport ?? "unknown",
          },
          selectedAt: previousItem?.selectedAt ?? selectedAt,
        };
      });
      if (values.length) await tx.insert(publisherDraftItems).values(values);
      const ready =
        values.length > 0 &&
        values.every((item) => item.submissionTitle) &&
        (titleMode === "per_media" ||
          Boolean(
            sharedTitle &&
              values.every((item) => item.submissionTitle === sharedTitle),
          ));
      await tx
        .update(publisherDrafts)
        .set({ status: ready ? "ready" : "draft" })
        .where(
          and(
            eq(publisherDrafts.id, draftId),
            monitoringProjectOwnerPredicate(publisherDrafts, ownerId),
          ),
        );
      if (createReceipt)
        await tx.insert(auditLogs).values({
          id: createReceipt.id,
          actorId: ownerId,
          ownerId,
          action: "publisher.draft_created",
          targetType: "publication_draft",
          targetIdHash: sha256(draftId),
          metadata: { requestHash: createReceipt.requestHash, draftId },
        });
      return { id: draftId, revision: nextRevision };
    });
  }

  async refreshPublisherDraftMedia(
    ownerId: string,
    input: PublisherRefreshDraftMediaInput,
  ) {
    return this.db.transaction(async (tx) => {
      await assertMonitoringEnterpriseProjectActive(tx, monitoringEnterpriseProjectIdForOwner(ownerId), ownerId);
      const [draft] = await tx
        .select()
        .from(publisherDrafts)
        .where(
          and(
            eq(publisherDrafts.id, input.draftId),
            monitoringProjectOwnerPredicate(publisherDrafts, ownerId),
          ),
        )
        .for("update")
        .limit(1);
      if (!draft) throw new RepositoryError("NOT_FOUND", "Draft not found");
      if (draft.revision !== input.expectedRevision) {
        throw new RepositoryError("CONFLICT", "Draft revision has changed");
      }
      if (draft.status === "submitted" || draft.status === "archived") {
        throw new RepositoryError("INVALID_STATE", "Draft cannot be changed");
      }

      const selections = await tx
        .select({
          draftItem: publisherDraftItems,
          resource: publisherMediaResources,
          imageSupport: publisherMediaCapabilities.imageSupport,
        })
        .from(publisherDraftItems)
        .innerJoin(
          publisherMediaResources,
          eq(publisherMediaResources.id, publisherDraftItems.mediaResourceId),
        )
        .leftJoin(
          publisherMediaCapabilities,
          eq(
            publisherMediaCapabilities.mediaResourceId,
            publisherMediaResources.id,
          ),
        )
        .where(
          and(
            eq(publisherDraftItems.draftId, input.draftId),
            monitoringProjectOwnerPredicate(publisherDraftItems, ownerId),
          ),
        );
      if (
        selections.length < 1 ||
        selections.length > 20 ||
        selections.some(
          ({ resource }) =>
            !resource.isActive ||
            !resource.mediaKind ||
            resource.priceTenThousandths <= 0n,
        )
      ) {
        throw new RepositoryError(
          "INVALID_STATE",
          "All selected media must be active before accepting catalog changes",
        );
      }

      const refreshedAt = new Date();
      for (const { draftItem, resource, imageSupport } of selections) {
        await tx
          .update(publisherDraftItems)
          .set({
            externalResourceId: resource.externalResourceId,
            selectedPriceTenThousandths: resource.priceTenThousandths,
            selectedCatalogRevision: resource.catalogRevision,
            mediaKindSnapshot: resource.mediaKind!,
            mediaSnapshot: {
              ...customerSafeMediaSnapshot(resource),
              imageSupport: imageSupport ?? "unknown",
            },
            selectedAt: refreshedAt,
          })
          .where(
            and(
              eq(publisherDraftItems.id, draftItem.id),
              monitoringProjectOwnerPredicate(publisherDraftItems, ownerId),
            ),
          );
      }

      const titlesValid = selections.every(
        ({ draftItem, resource }) =>
          Boolean(draftItem.submissionTitle.trim()) &&
          unicodeLength(draftItem.submissionTitle) <=
            (resource.titleLimit ?? 200),
      );
      const singleTitleValid =
        draft.titleMode !== "single" ||
        Boolean(
          draft.sharedTitle?.trim() &&
            selections.every(
              ({ draftItem }) =>
                draftItem.submissionTitle === draft.sharedTitle,
            ),
        );
      const revision = draft.revision + 1;
      await tx
        .update(publisherDrafts)
        .set({
          revision,
          status: titlesValid && singleTitleValid ? "ready" : "draft",
        })
        .where(
          and(
            eq(publisherDrafts.id, input.draftId),
            monitoringProjectOwnerPredicate(publisherDrafts, ownerId),
          ),
        );
      return { id: input.draftId, revision };
    });
  }

  async savePublisherDraftTitles(
    ownerId: string,
    input: PublisherSaveDraftTitlesInput,
  ) {
    return this.db.transaction(async (tx) => {
      await assertMonitoringEnterpriseProjectActive(tx, monitoringEnterpriseProjectIdForOwner(ownerId), ownerId);
      const [draft] = await tx
        .select()
        .from(publisherDrafts)
        .where(
          and(
            eq(publisherDrafts.id, input.draftId),
            monitoringProjectOwnerPredicate(publisherDrafts, ownerId),
          ),
        )
        .for("update")
        .limit(1);
      if (!draft) throw new RepositoryError("NOT_FOUND", "Draft not found");
      if (draft.revision !== input.expectedRevision)
        throw new RepositoryError("CONFLICT", "Draft revision has changed");
      if (draft.status === "submitted" || draft.status === "archived")
        throw new RepositoryError("INVALID_STATE", "Draft cannot be changed");
      const items = await tx
        .select({
          id: publisherDraftItems.id,
          mediaResourceId: publisherDraftItems.mediaResourceId,
          mediaSnapshot: publisherDraftItems.mediaSnapshot,
        })
        .from(publisherDraftItems)
        .where(
          and(
            eq(publisherDraftItems.draftId, input.draftId),
            monitoringProjectOwnerPredicate(publisherDraftItems, ownerId),
          ),
        );
      if (!items.length)
        throw new RepositoryError(
          "INVALID_STATE",
          "Select at least one media resource before saving titles",
        );
      const supplied = new Map(
        (input.titles ?? []).map((title) => [
          title.mediaResourceId,
          title.submissionTitle.trim(),
        ]),
      );
      if (
        input.titleMode === "per_media" &&
        (supplied.size !== items.length ||
          items.some((item) => !supplied.has(item.mediaResourceId)))
      ) {
        throw new RepositoryError(
          "INVALID_STATE",
          "Every selected media resource requires exactly one title",
        );
      }
      const sharedTitle = input.sharedTitle?.trim() || null;
      for (const item of items) {
        const title =
          input.titleMode === "single"
            ? sharedTitle!
            : supplied.get(item.mediaResourceId)!;
        const frozenTitleLimit =
          snapshotNullableNumber(item.mediaSnapshot, "titleLimit", null) ?? 200;
        if (!title || unicodeLength(title) > frozenTitleLimit) {
          throw new RepositoryError(
            "INVALID_STATE",
            "One or more media titles exceed their limit",
          );
        }
        await tx
          .update(publisherDraftItems)
          .set({ submissionTitle: title })
          .where(
            and(
              eq(publisherDraftItems.id, item.id),
              monitoringProjectOwnerPredicate(publisherDraftItems, ownerId),
            ),
          );
      }
      const revision = draft.revision + 1;
      await tx
        .update(publisherDrafts)
        .set({
          titleMode: input.titleMode,
          sharedTitle: input.titleMode === "single" ? sharedTitle : null,
          status: "ready",
          revision,
        })
        .where(
          and(
            eq(publisherDrafts.id, input.draftId),
            monitoringProjectOwnerPredicate(publisherDrafts, ownerId),
          ),
        );
      return { id: input.draftId, revision };
    });
  }

  async preflightPublisherDraft(
    ownerId: string,
    draftId: string,
    expectedDraftRevision: number,
    options: PublisherExecutionOptions = new Date(),
  ): Promise<PublisherPreflightOutput> {
    const { now, requiredMode } = publisherExecutionOptions(options);
    await this.ensureMediaPublishingWallet(ownerId);
    return this.db.transaction(async (tx) => {
      await assertMonitoringEnterpriseProjectActive(tx, monitoringEnterpriseProjectIdForOwner(ownerId), ownerId);
      const preflightRevision = randomUUID();
      const expiresAt = new Date(now.getTime() + PREFLIGHT_WINDOW_MS);
      const preflight = await computePreflight(
        tx,
        ownerId,
        draftId,
        expectedDraftRevision,
        now,
        false,
        { preflightRevision, expiresAt },
        requiredMode,
      );
      await tx.insert(publisherPreflights).values({
        id: preflightRevision,
        ownerId,
        draftId,
        draftRevision: expectedDraftRevision,
        quoteFingerprint: preflight.quoteFingerprint,
        snapshotHash: publisherPreflightSnapshotHash(preflight),
        mode: preflight.mode,
        expiresAt,
      });
      return preflight;
    });
  }

  async submitPublisherDraft(
    ownerId: string,
    input: PublisherSubmitInput,
    options: PublisherExecutionOptions = new Date(),
  ) {
    const { now, requiredMode } = publisherExecutionOptions(options);
    const projectId = monitoringEnterpriseProjectIdForOwner(ownerId);
    const scopedKey = projectId
      ? `enterprise:${projectId}:${sha256(input.idempotencyKey)}`
      : input.idempotencyKey;
    return this.db.transaction(async (tx) => {
      await assertMonitoringEnterpriseProjectActive(tx, projectId, ownerId);
      await ensureAndLockPublisherWallet(tx, ownerId);
      const [replay] = await tx
        .select()
        .from(publisherBatches)
        .where(
          and(
            monitoringProjectOwnerPredicate(publisherBatches, ownerId),
            inArray(publisherBatches.idempotencyKey, [
              ...new Set([scopedKey, input.idempotencyKey]),
            ]),
          ),
        )
        .limit(1);
      if (replay) {
        if (
          (requiredMode !== undefined && replay.mode !== requiredMode) ||
          replay.draftId !== input.draftId ||
          replay.quoteFingerprint !== input.quoteFingerprint ||
          (replay.mode === "live" && input.liveConfirmationAccepted !== true)
        ) {
          throw new RepositoryError(
            "CONFLICT",
            "Submission idempotency key is already bound to another quote",
          );
        }
        return publisherBatchSubmitResult(replay);
      }

      const [issuedPreflight] = await tx
        .select()
        .from(publisherPreflights)
        .where(
          and(
            eq(publisherPreflights.id, input.preflightRevision),
            monitoringProjectOwnerPredicate(publisherPreflights, ownerId),
          ),
        )
        .for("update")
        .limit(1);
      const tokenBlocker = publisherPreflightTokenBlocker({
        preflight: issuedPreflight,
        ownerId,
        draftId: input.draftId,
        draftRevision: input.expectedDraftRevision,
        quoteFingerprint: input.quoteFingerprint,
        now,
      });
      if (tokenBlocker) {
        throw new RepositoryError("CONFLICT", tokenBlocker);
      }
      const preflight = await computePreflight(
        tx,
        ownerId,
        input.draftId,
        input.expectedDraftRevision,
        now,
        true,
        {
          preflightRevision: issuedPreflight!.id,
          expiresAt: issuedPreflight!.expiresAt,
        },
        requiredMode,
      );
      if (
        preflight.preflightRevision !== input.preflightRevision ||
        preflight.quoteFingerprint !== input.quoteFingerprint ||
        preflight.mode !== issuedPreflight!.mode ||
        publisherPreflightSnapshotHash(preflight) !==
          issuedPreflight!.snapshotHash
      ) {
        throw new RepositoryError("CONFLICT", "Preflight or price has changed");
      }
      if (
        preflight.blockers.length > 0 ||
        preflight.items.some((item) => item.blockers.length > 0) ||
        !preflight.sufficientFunds
      ) {
        throw new RepositoryError(
          preflight.sufficientFunds ? "INVALID_STATE" : "BALANCE_INSUFFICIENT",
          preflight.sufficientFunds
            ? "Publishing preflight is blocked"
            : "Media publishing balance is insufficient",
        );
      }
      if (
        preflight.mode === "live" &&
        input.liveConfirmationAccepted !== true
      ) {
        throw new RepositoryError(
          "INVALID_STATE",
          "LIVE confirmation is required",
        );
      }
      await tx
        .update(publisherPreflights)
        .set({ consumedAt: now })
        .where(
          and(
            eq(publisherPreflights.id, issuedPreflight!.id),
            monitoringProjectOwnerPredicate(publisherPreflights, ownerId),
            isNull(publisherPreflights.consumedAt),
          ),
        );
      const total = publisherMoneyFromApiString(preflight.totalTenThousandths);
      const [wallet] = await tx
        .select()
        .from(mediaPublishingWallets)
        .where(eq(mediaPublishingWallets.userId, ownerId))
        .for("update")
        .limit(1);
      if (!wallet)
        throw new RepositoryError("INVALID_STATE", "Wallet is missing");
      let nextWallet;
      try {
        nextWallet = reservePublisherMoney(wallet, total);
      } catch {
        throw new RepositoryError(
          "BALANCE_INSUFFICIENT",
          "Media publishing balance is insufficient",
        );
      }
      const [draft] = await tx
        .select()
        .from(publisherDrafts)
        .where(
          and(
            eq(publisherDrafts.id, input.draftId),
            monitoringProjectOwnerPredicate(publisherDrafts, ownerId),
          ),
        )
        .for("update")
        .limit(1);
      if (
        !draft ||
        draft.revision !== input.expectedDraftRevision ||
        draft.status !== "ready"
      ) {
        throw new RepositoryError("CONFLICT", "Draft revision has changed");
      }
      const selectedItems = await loadDraftSelections(
        tx,
        ownerId,
        input.draftId,
      );
      const batchId = randomUUID();
      const reservationId = randomUUID();
      await tx.insert(publisherBatches).values({
        id: batchId,
        ownerId,
        draftId: draft.id,
        articleVersionId: draft.articleVersionId,
        status: "queued",
        fundsStatus: "reserved",
        mode: preflight.mode,
        quotedTotalTenThousandths: total,
        quoteFingerprint: preflight.quoteFingerprint,
        preflightRevision: preflight.preflightRevision,
        preflightSnapshot: preflight,
        idempotencyKey: scopedKey,
        liveConfirmationAccepted: input.liveConfirmationAccepted === true,
        titleMode: draft.titleMode,
        confirmedAt: now,
        createdAt: now,
      });
      await tx.insert(mediaPublishingReservations).values({
        id: reservationId,
        ownerId,
        batchId,
        totalTenThousandths: total,
      });
      const preflightByMedia = new Map(
        preflight.items.map((item) => [item.mediaResourceId, item]),
      );
      for (const selected of selectedItems) {
        const itemId = randomUUID();
        const price = selected.resource.priceTenThousandths;
        const submissionKey = sha256(
          stableJson({ batchId, mediaResourceId: selected.resource.id }),
        );
        const itemPreflight = preflightByMedia.get(selected.resource.id);
        if (!itemPreflight) {
          throw new RepositoryError("CONFLICT", "Preflight item has changed");
        }
        await tx.insert(publisherItems).values({
          id: itemId,
          ownerId,
          batchId,
          mediaResourceId: selected.resource.id,
          externalResourceId: selected.resource.externalResourceId,
          mediaNameSnapshot: selected.resource.name,
          mediaKindSnapshot: selected.resource.mediaKind ?? "unknown",
          mediaMetadataSnapshot: customerSafeMediaSnapshot(selected.resource),
          submissionTitle: selected.draftItem.submissionTitle,
          articleContentHash: preflight.articleContentHash,
          catalogRevision: preflight.catalogRevision,
          preflightBlockers: itemPreflight.blockers,
          preflightWarnings: itemPreflight.warnings,
          submissionKey,
          status: "queued",
          fundsStatus: "reserved",
        });
        await tx.insert(mediaPublishingItemPriceSnapshots).values({
          itemId,
          ownerId,
          mediaResourceId: selected.resource.id,
          catalogRevision: selected.resource.catalogRevision,
          externalResourceId: selected.resource.externalResourceId,
          amountTenThousandths: price,
          providerPayloadHash: selected.resource.payloadHash,
        });
        await tx.insert(mediaPublishingItemSettlements).values({
          itemId,
          ownerId,
          reservationId,
          amountTenThousandths: price,
          status: "reserved",
        });
        await tx.insert(publisherJobs).values({
          id: randomUUID(),
          type: "submit_publication_item",
          enterpriseProjectId: projectId,
          deterministicKey: `publisher:submit:${itemId}:1`,
          aggregateId: itemId,
          payload: { itemId },
          availableAt: now,
        });
      }
      await tx
        .update(mediaPublishingWallets)
        .set({ reservedTenThousandths: nextWallet.reservedTenThousandths })
        .where(eq(mediaPublishingWallets.userId, ownerId));
      await tx.insert(mediaPublishingLedger).values({
        id: randomUUID(),
        ownerId,
        type: "reserve",
        balanceDeltaTenThousandths: 0n,
        reservedDeltaTenThousandths: total,
        frozenDeltaTenThousandths: 0n,
        balanceAfterTenThousandths: nextWallet.balanceTenThousandths,
        reservedAfterTenThousandths: nextWallet.reservedTenThousandths,
        frozenAfterTenThousandths: nextWallet.frozenTenThousandths,
        idempotencyKey: `publisher:reserve:${batchId}`,
        reservationId,
        referenceType: "publication_batch",
        referenceId: batchId,
        reason: "Media publication submitted",
      });
      await tx
        .update(publisherDrafts)
        .set({ status: "submitted" })
        .where(
          and(
            eq(publisherDrafts.id, draft.id),
            monitoringProjectOwnerPredicate(publisherDrafts, ownerId),
            eq(publisherDrafts.status, "ready"),
          ),
        );
      return {
        batchId,
        status: "queued" as const,
        fundsStatus: "reserved" as const,
        mode: preflight.mode,
        totalTenThousandths: publisherMoneyToApiString(total),
        createdAt: now,
      };
    });
  }

  async settlePublisherItem(input: {
    itemId: string;
    settlement: "frozen" | "consumed" | "released";
    settledAt: Date;
    reason: string;
  }) {
    return this.db.transaction(async (tx) => {
      const changed = await settlePublisherItemMoney(tx, input);
      const [item] = await tx
        .select({ batchId: publisherItems.batchId })
        .from(publisherItems)
        .where(eq(publisherItems.id, input.itemId))
        .limit(1);
      if (item) await refreshPublisherBatchState(tx, item.batchId);
      return changed;
    });
  }

  async createMediaPublishingTopupOrder(input: {
    ownerId: string;
    providerOrderId: string;
    paymentMethod: "alipay" | "wxpay" | "bank_transfer";
    amountTenThousandths: string;
    idempotencyKey: string;
    callbackTokenDigest: string;
    checkoutExpiresAt: Date;
  }) {
    const amount = publisherMoneyFromApiString(input.amountTenThousandths);
    assertMediaPublishingTopup(input, amount);
    return this.db.transaction(async (tx) => {
      await ensureAndLockPublisherWallet(tx, input.ownerId);
      const [replay] = await tx
        .select()
        .from(mediaPublishingTopupOrders)
        .where(
          and(
            eq(mediaPublishingTopupOrders.ownerId, input.ownerId),
            eq(mediaPublishingTopupOrders.idempotencyKey, input.idempotencyKey),
          ),
        )
        .limit(1);
      if (replay) return mediaPublishingTopupDto(replay);
      const id = randomUUID();
      await tx.insert(mediaPublishingTopupOrders).values({
        id,
        providerOrderId: input.providerOrderId,
        ownerId: input.ownerId,
        idempotencyKey: input.idempotencyKey,
        paymentMethod: input.paymentMethod,
        amountTenThousandths: amount,
        callbackTokenDigest: input.callbackTokenDigest,
        checkoutExpiresAt: input.checkoutExpiresAt,
      });
      await tx.insert(paymentOrderRoutes).values({
        id: randomUUID(),
        providerOrderId: input.providerOrderId,
        walletScope: "media_publishing",
        mediaPublishingOrderId: id,
      });
      const [created] = await tx
        .select()
        .from(mediaPublishingTopupOrders)
        .where(eq(mediaPublishingTopupOrders.id, id))
        .limit(1);
      if (!created)
        throw new RepositoryError("INVALID_STATE", "Top-up was not created");
      return mediaPublishingTopupDto(created);
    });
  }

  async getMediaPublishingTopupOrder(ownerId: string, orderId: string) {
    const [order] = await this.db
      .select()
      .from(mediaPublishingTopupOrders)
      .where(
        and(
          eq(mediaPublishingTopupOrders.id, orderId),
          eq(mediaPublishingTopupOrders.ownerId, ownerId),
        ),
      )
      .limit(1);
    if (!order)
      throw new RepositoryError("NOT_FOUND", "Top-up order not found");
    return mediaPublishingTopupDto(order);
  }

  async getMediaPublishingTopupOrderByProviderOrderId(providerOrderId: string) {
    const [order] = await this.db
      .select()
      .from(mediaPublishingTopupOrders)
      .where(eq(mediaPublishingTopupOrders.providerOrderId, providerOrderId))
      .limit(1);
    return order
      ? {
          ...order,
          userId: order.ownerId,
          method: order.paymentMethod,
          currency: "CNY" as const,
        }
      : null;
  }

  async listMediaPublishingTopupOrders(
    ownerId: string,
    limit = 100,
    observedAt = new Date(),
  ) {
    return this.db.transaction(async (tx) => {
      await tx
        .update(mediaPublishingTopupOrders)
        .set({ state: "expired" })
        .where(
          and(
            eq(mediaPublishingTopupOrders.ownerId, ownerId),
            eq(mediaPublishingTopupOrders.state, "pending"),
            lte(mediaPublishingTopupOrders.checkoutExpiresAt, observedAt),
          ),
        );
      const orders = await tx
        .select()
        .from(mediaPublishingTopupOrders)
        .where(eq(mediaPublishingTopupOrders.ownerId, ownerId))
        .orderBy(desc(mediaPublishingTopupOrders.createdAt))
        .limit(Math.min(Math.max(limit, 1), 100));
      return orders.map(mediaPublishingTopupDto);
    });
  }

  async expireMediaPublishingTopupOrderIfNeeded(
    ownerId: string,
    orderId: string,
    observedAt: Date,
  ) {
    return this.db.transaction(async (tx) => {
      const [order] = await tx
        .select()
        .from(mediaPublishingTopupOrders)
        .where(
          and(
            eq(mediaPublishingTopupOrders.id, orderId),
            eq(mediaPublishingTopupOrders.ownerId, ownerId),
          ),
        )
        .for("update")
        .limit(1);
      if (!order)
        throw new RepositoryError("NOT_FOUND", "Top-up order not found");
      if (
        order.state === "pending" &&
        order.checkoutExpiresAt.getTime() <= observedAt.getTime()
      ) {
        await tx
          .update(mediaPublishingTopupOrders)
          .set({ state: "expired" })
          .where(eq(mediaPublishingTopupOrders.id, order.id));
        return mediaPublishingTopupDto({ ...order, state: "expired" });
      }
      return mediaPublishingTopupDto(order);
    });
  }

  async switchMediaPublishingTopupPaymentMethod(input: {
    ownerId: string;
    orderId: string;
    expectedPaymentMethod: "alipay" | "wxpay" | "bank_transfer";
    paymentMethod: "alipay" | "wxpay" | "bank_transfer";
    providerOrderId: string;
    idempotencyKey: string;
    callbackTokenDigest: string;
    checkoutExpiresAt: Date;
  }) {
    if (input.paymentMethod === input.expectedPaymentMethod) {
      throw new RepositoryError(
        "INVALID_STATE",
        "Replacement payment method must be different",
      );
    }
    assertMediaPublishingTopup(input, 100_000n);
    return this.db.transaction(async (tx) => {
      const [order] = await tx
        .select()
        .from(mediaPublishingTopupOrders)
        .where(
          and(
            eq(mediaPublishingTopupOrders.id, input.orderId),
            eq(mediaPublishingTopupOrders.ownerId, input.ownerId),
          ),
        )
        .for("update")
        .limit(1);
      if (!order)
        throw new RepositoryError("NOT_FOUND", "Top-up order not found");
      const [replay] = await tx
        .select()
        .from(mediaPublishingTopupOrders)
        .where(
          and(
            eq(mediaPublishingTopupOrders.ownerId, input.ownerId),
            eq(mediaPublishingTopupOrders.idempotencyKey, input.idempotencyKey),
          ),
        )
        .for("update")
        .limit(1);
      if (replay) {
        if (
          replay.replacesOrderId !== order.id ||
          replay.paymentMethod !== input.paymentMethod ||
          replay.providerOrderId !== input.providerOrderId
        ) {
          throw new RepositoryError(
            "CONFLICT",
            "Replacement idempotency key is already used",
          );
        }
        return mediaPublishingTopupDto(replay);
      }
      if (
        order.state !== "pending" ||
        order.paymentMethod !== input.expectedPaymentMethod
      ) {
        throw new RepositoryError(
          "CONFLICT",
          "Top-up order cannot change payment method",
        );
      }
      const replacementId = randomUUID();
      await tx.insert(mediaPublishingTopupOrders).values({
        id: replacementId,
        providerOrderId: input.providerOrderId,
        replacesOrderId: order.id,
        ownerId: input.ownerId,
        idempotencyKey: input.idempotencyKey,
        paymentMethod: input.paymentMethod,
        amountTenThousandths: order.amountTenThousandths,
        callbackTokenDigest: input.callbackTokenDigest,
        checkoutExpiresAt: input.checkoutExpiresAt,
      });
      await tx.insert(paymentOrderRoutes).values({
        id: randomUUID(),
        providerOrderId: input.providerOrderId,
        walletScope: "media_publishing",
        mediaPublishingOrderId: replacementId,
      });
      await tx
        .update(mediaPublishingTopupOrders)
        .set({ state: "cancelled" })
        .where(eq(mediaPublishingTopupOrders.id, order.id));
      const [replacement] = await tx
        .select()
        .from(mediaPublishingTopupOrders)
        .where(eq(mediaPublishingTopupOrders.id, replacementId))
        .limit(1);
      if (!replacement) {
        throw new RepositoryError(
          "INVALID_STATE",
          "Replacement order was not created",
        );
      }
      return mediaPublishingTopupDto(replacement);
    });
  }

  async submitMediaPublishingBankTransferReview(input: {
    ownerId: string;
    orderId: string;
    payerName: string;
    transferredAt: Date;
    remittanceReference: string;
    evidenceObjectKey?: string;
    submittedAt?: Date;
  }) {
    const submittedAt = input.submittedAt ?? new Date();
    const payerName = input.payerName.trim();
    const reference = input.remittanceReference.trim();
    if (
      payerName.length < 2 ||
      payerName.length > 120 ||
      reference.length < 3 ||
      reference.length > 191 ||
      !Number.isFinite(input.transferredAt.getTime()) ||
      input.transferredAt.getTime() > submittedAt.getTime() + 5 * 60_000
    ) {
      throw new RepositoryError(
        "INVALID_STATE",
        "Invalid bank transfer evidence",
      );
    }
    return this.db.transaction(async (tx) => {
      const [order] = await tx
        .select()
        .from(mediaPublishingTopupOrders)
        .where(
          and(
            eq(mediaPublishingTopupOrders.id, input.orderId),
            eq(mediaPublishingTopupOrders.ownerId, input.ownerId),
          ),
        )
        .for("update")
        .limit(1);
      if (!order)
        throw new RepositoryError("NOT_FOUND", "Top-up order not found");
      if (
        order.paymentMethod !== "bank_transfer" ||
        !["pending", "review_required"].includes(order.state)
      ) {
        throw new RepositoryError(
          "CONFLICT",
          "Top-up order cannot enter bank review",
        );
      }
      const [existing] = await tx
        .select()
        .from(mediaPublishingBankTransferReviews)
        .where(eq(mediaPublishingBankTransferReviews.orderId, order.id))
        .for("update")
        .limit(1);
      if (existing) return existing;
      const review = {
        id: randomUUID(),
        orderId: order.id,
        payerName,
        transferredAt: input.transferredAt,
        remittanceReference: reference,
        evidenceObjectKey: input.evidenceObjectKey ?? null,
        submittedAt,
      };
      await tx.insert(mediaPublishingBankTransferReviews).values(review);
      await tx
        .update(mediaPublishingTopupOrders)
        .set({ state: "review_required" })
        .where(eq(mediaPublishingTopupOrders.id, order.id));
      return { ...review, status: "pending" as const };
    });
  }

  async listPendingMediaPublishingBankTransferReviews(limit = 100) {
    return this.db
      .select({
        review: mediaPublishingBankTransferReviews,
        order: mediaPublishingTopupOrders,
        username: users.username,
      })
      .from(mediaPublishingBankTransferReviews)
      .innerJoin(
        mediaPublishingTopupOrders,
        eq(
          mediaPublishingBankTransferReviews.orderId,
          mediaPublishingTopupOrders.id,
        ),
      )
      .innerJoin(users, eq(mediaPublishingTopupOrders.ownerId, users.id))
      .where(eq(mediaPublishingBankTransferReviews.status, "pending"))
      .orderBy(asc(mediaPublishingBankTransferReviews.submittedAt))
      .limit(Math.min(Math.max(limit, 1), 100));
  }

  async reviewMediaPublishingBankTransfer(input: {
    reviewId: string;
    decision: "approve" | "reject";
    reason: string;
    providerTradeNo?: string;
    reviewedBy: string;
    reviewedAt?: Date;
  }) {
    const reason = input.reason.trim();
    const providerTradeNo = input.providerTradeNo?.trim();
    if (
      reason.length < 3 ||
      reason.length > 240 ||
      (input.decision === "approve" &&
        (!providerTradeNo || providerTradeNo.length > 191))
    ) {
      throw new RepositoryError(
        "INVALID_STATE",
        "Invalid bank review decision",
      );
    }
    return this.db.transaction(async (tx) => {
      const [review] = await tx
        .select()
        .from(mediaPublishingBankTransferReviews)
        .where(eq(mediaPublishingBankTransferReviews.id, input.reviewId))
        .for("update")
        .limit(1);
      if (!review)
        throw new RepositoryError("NOT_FOUND", "Bank review not found");
      const [order] = await tx
        .select()
        .from(mediaPublishingTopupOrders)
        .where(eq(mediaPublishingTopupOrders.id, review.orderId))
        .for("update")
        .limit(1);
      if (!order)
        throw new RepositoryError("INVALID_STATE", "Top-up order is missing");
      if (review.status !== "pending") {
        const replayStatus =
          input.decision === "approve" ? "approved" : "rejected";
        if (review.status === replayStatus && review.reviewReason === reason)
          return review;
        throw new RepositoryError("CONFLICT", "Bank review is already settled");
      }
      const reviewedAt = input.reviewedAt ?? new Date();
      if (input.decision === "reject") {
        await tx
          .update(mediaPublishingBankTransferReviews)
          .set({
            status: "rejected",
            reviewReason: reason,
            reviewedBy: input.reviewedBy,
            reviewedAt,
          })
          .where(eq(mediaPublishingBankTransferReviews.id, review.id));
        await tx
          .update(mediaPublishingTopupOrders)
          .set({ state: "rejected" })
          .where(eq(mediaPublishingTopupOrders.id, order.id));
        return {
          ...review,
          status: "rejected" as const,
          reviewReason: reason,
          reviewedAt,
        };
      }
      const payloadDigest = sha256(`bank:${review.id}:${providerTradeNo}`);
      await tx.insert(paymentReceiptClaims).values({
        id: randomUUID(),
        provider: "bank",
        providerTradeNo: providerTradeNo!,
        providerOrderId: order.providerOrderId,
        walletScope: "media_publishing",
        payloadDigest,
        status: "credited",
        claimedAt: reviewedAt,
        completedAt: reviewedAt,
      });
      await tx.insert(mediaPublishingTopupReceipts).values({
        id: randomUUID(),
        orderId: order.id,
        provider: "bank",
        providerTradeNo: providerTradeNo!,
        amountTenThousandths: order.amountTenThousandths,
        paidAt: reviewedAt,
        payloadDigest,
        receivedAt: reviewedAt,
      });
      const [wallet] = await tx
        .select()
        .from(mediaPublishingWallets)
        .where(eq(mediaPublishingWallets.userId, order.ownerId))
        .for("update")
        .limit(1);
      if (!wallet)
        throw new RepositoryError("INVALID_STATE", "Wallet is missing");
      const nextBalance =
        wallet.balanceTenThousandths + order.amountTenThousandths;
      await tx
        .update(mediaPublishingWallets)
        .set({ balanceTenThousandths: nextBalance })
        .where(eq(mediaPublishingWallets.userId, order.ownerId));
      await tx
        .update(mediaPublishingTopupOrders)
        .set({ state: "credited", paidAt: reviewedAt, creditedAt: reviewedAt })
        .where(eq(mediaPublishingTopupOrders.id, order.id));
      await tx
        .update(mediaPublishingBankTransferReviews)
        .set({
          status: "approved",
          reviewReason: reason,
          reviewedBy: input.reviewedBy,
          reviewedAt,
        })
        .where(eq(mediaPublishingBankTransferReviews.id, review.id));
      await tx.insert(mediaPublishingLedger).values({
        id: randomUUID(),
        ownerId: order.ownerId,
        type: "topup",
        balanceDeltaTenThousandths: order.amountTenThousandths,
        reservedDeltaTenThousandths: 0n,
        frozenDeltaTenThousandths: 0n,
        balanceAfterTenThousandths: nextBalance,
        reservedAfterTenThousandths: wallet.reservedTenThousandths,
        frozenAfterTenThousandths: wallet.frozenTenThousandths,
        idempotencyKey: `publisher:topup:${order.id}`,
        actorId: input.reviewedBy,
        referenceType: "media_publishing_topup",
        referenceId: order.id,
        reason: "Media publishing bank transfer approved",
      });
      return {
        ...review,
        status: "approved" as const,
        reviewReason: reason,
        reviewedAt,
      };
    });
  }

  async listAdminMediaPublishingBillingUsers(limit = 100) {
    const rows = await this.db
      .select({
        id: users.id,
        username: users.username,
        role: users.role,
        status: users.status,
        lastLoginAt: users.lastLoginAt,
        createdAt: users.createdAt,
        balance: mediaPublishingWallets.balanceTenThousandths,
        reserved: mediaPublishingWallets.reservedTenThousandths,
        frozen: mediaPublishingWallets.frozenTenThousandths,
        spent: mediaPublishingWallets.spentTenThousandths,
      })
      .from(users)
      .leftJoin(
        mediaPublishingWallets,
        eq(users.id, mediaPublishingWallets.userId),
      )
      .orderBy(desc(users.createdAt))
      .limit(limit);
    return rows.map((row) => {
      const balance = row.balance ?? 0n;
      const reserved = row.reserved ?? 0n;
      const frozen = row.frozen ?? 0n;
      return {
        id: row.id,
        username: row.username,
        role: row.role,
        status: row.status,
        lastLoginAt: row.lastLoginAt,
        createdAt: row.createdAt,
        walletScope: "media_publishing" as const,
        currency: "CNY" as const,
        scale: 4 as const,
        balanceTenThousandths: publisherMoneyToApiString(balance),
        reservedTenThousandths: publisherMoneyToApiString(reserved),
        frozenTenThousandths: publisherMoneyToApiString(frozen),
        spentTenThousandths: publisherMoneyToApiString(row.spent ?? 0n),
        availableTenThousandths: publisherMoneyToApiString(
          balance - reserved - frozen,
        ),
      };
    });
  }

  async adjustMediaPublishingMoney(input: {
    ownerId: string;
    publicationItemId: string;
    amountTenThousandths: string;
    reason: string;
    idempotencyKey: string;
    actorId: string;
  }) {
    const amount = publisherMoneyFromApiString(input.amountTenThousandths);
    const reason = input.reason.trim();
    if (amount <= 0n || reason.length < 3 || reason.length > 240) {
      throw new RepositoryError(
        "INVALID_STATE",
        "Invalid customer compensation",
      );
    }
    return this.db.transaction(async (tx) => {
      const [publicationItem] = await tx
        .select({
          id: publisherItems.id,
          ownerId: publisherItems.ownerId,
          fundsStatus: publisherItems.fundsStatus,
          settlementStatus: mediaPublishingItemSettlements.status,
        })
        .from(publisherItems)
        .innerJoin(
          mediaPublishingItemSettlements,
          and(
            eq(mediaPublishingItemSettlements.itemId, publisherItems.id),
            eq(mediaPublishingItemSettlements.ownerId, publisherItems.ownerId),
          ),
        )
        .where(
          and(
            eq(publisherItems.id, input.publicationItemId),
            monitoringProjectOwnerPredicate(publisherItems, input.ownerId),
          ),
        )
        .for("update")
        .limit(1);
      if (!publicationItem) {
        throw new RepositoryError(
          "NOT_FOUND",
          "Consumed publication item not found",
        );
      }
      if (
        publicationItem.fundsStatus !== "consumed" ||
        publicationItem.settlementStatus !== "consumed"
      ) {
        throw new RepositoryError(
          "INVALID_STATE",
          "Customer compensation requires a consumed publication item",
        );
      }
      const key = `publisher:admin-adjust:${input.idempotencyKey}`;
      const [existing] = await tx
        .select()
        .from(mediaPublishingLedger)
        .where(eq(mediaPublishingLedger.idempotencyKey, key))
        .limit(1);
      if (existing) {
        if (
          existing.ownerId !== input.ownerId ||
          existing.balanceDeltaTenThousandths !== amount ||
          existing.reason !== reason ||
          existing.itemId !== input.publicationItemId ||
          existing.referenceType !== "publication_item" ||
          existing.referenceId !== input.publicationItemId
        ) {
          throw new RepositoryError(
            "CONFLICT",
            "Adjustment idempotency key is already used",
          );
        }
        const wallet = await ensureAndLockPublisherWallet(tx, input.ownerId);
        return mediaPublishingBillingSummary(wallet);
      }
      const wallet = await ensureAndLockPublisherWallet(tx, input.ownerId);
      const nextBalance = wallet.balanceTenThousandths + amount;
      await tx
        .update(mediaPublishingWallets)
        .set({ balanceTenThousandths: nextBalance })
        .where(eq(mediaPublishingWallets.userId, input.ownerId));
      await tx.insert(mediaPublishingLedger).values({
        id: randomUUID(),
        ownerId: input.ownerId,
        type: "admin_adjustment",
        balanceDeltaTenThousandths: amount,
        reservedDeltaTenThousandths: 0n,
        frozenDeltaTenThousandths: 0n,
        balanceAfterTenThousandths: nextBalance,
        reservedAfterTenThousandths: wallet.reservedTenThousandths,
        frozenAfterTenThousandths: wallet.frozenTenThousandths,
        idempotencyKey: key,
        itemId: input.publicationItemId,
        actorId: input.actorId,
        referenceType: "publication_item",
        referenceId: input.publicationItemId,
        reason,
      });
      await tx.insert(auditLogs).values({
        id: randomUUID(),
        actorId: input.actorId,
        actorRole: "admin",
        action: "admin.publisher_customer_compensated",
        targetType: "publication_item",
        targetIdHash: sha256(input.publicationItemId),
        ownerId: input.ownerId,
        metadata: {
          publicationItemId: input.publicationItemId,
          amountTenThousandths: amount.toString(),
          reason,
        },
      });
      return mediaPublishingBillingSummary({
        ...wallet,
        balanceTenThousandths: nextBalance,
      });
    });
  }

  async resolvePaymentOrderRoute(providerOrderId: string) {
    const [route] = await this.db
      .select()
      .from(paymentOrderRoutes)
      .where(eq(paymentOrderRoutes.providerOrderId, providerOrderId))
      .limit(1);
    return route ?? null;
  }

  async recordMediaPublishingTopupReceiptAndCredit(input: {
    providerOrderId: string;
    provider: "zpay" | "bank";
    providerTradeNo: string;
    amountTenThousandths: string | bigint;
    paidAt: Date;
    payloadDigest: string;
    receivedAt: Date;
  }) {
    const amount = publisherMoneyFromApiString(
      input.amountTenThousandths.toString(),
    );
    if (
      amount <= 0n ||
      amount % 100n !== 0n ||
      input.providerTradeNo.trim() !== input.providerTradeNo ||
      input.providerTradeNo.length < 1 ||
      input.providerTradeNo.length > 191 ||
      !/^[a-f0-9]{64}$/u.test(input.payloadDigest) ||
      !Number.isFinite(input.paidAt.getTime()) ||
      !Number.isFinite(input.receivedAt.getTime())
    ) {
      throw new RepositoryError("INVALID_STATE", "Invalid payment receipt");
    }
    return this.db.transaction(async (tx) => {
      const [order] = await tx
        .select()
        .from(mediaPublishingTopupOrders)
        .where(
          eq(mediaPublishingTopupOrders.providerOrderId, input.providerOrderId),
        )
        .for("update")
        .limit(1);
      if (!order)
        throw new RepositoryError("NOT_FOUND", "Top-up order not found");
      if (
        (input.provider === "zpay" &&
          order.paymentMethod === "bank_transfer") ||
        (input.provider === "bank" && order.paymentMethod !== "bank_transfer")
      ) {
        throw new RepositoryError(
          "CONFLICT",
          "Payment receipt method does not match the order",
        );
      }
      const [existingClaim] = await tx
        .select()
        .from(paymentReceiptClaims)
        .where(
          and(
            eq(paymentReceiptClaims.provider, input.provider),
            eq(paymentReceiptClaims.providerTradeNo, input.providerTradeNo),
          ),
        )
        .limit(1);
      if (existingClaim) {
        if (
          existingClaim.providerOrderId !== input.providerOrderId ||
          existingClaim.payloadDigest !== input.payloadDigest ||
          existingClaim.walletScope !== "media_publishing"
        ) {
          throw new RepositoryError(
            "CONFLICT",
            "Payment receipt is already claimed by another order",
          );
        }
        return {
          outcome: "replayed" as const,
          orderId: order.id,
          orderState:
            order.state === "credited"
              ? ("credited" as const)
              : ("review_required" as const),
          providerTradeNo: input.providerTradeNo,
        };
      }
      const [existingOrderReceipt] = await tx
        .select()
        .from(mediaPublishingTopupReceipts)
        .where(eq(mediaPublishingTopupReceipts.orderId, order.id))
        .limit(1);
      if (existingOrderReceipt) {
        if (
          existingOrderReceipt.provider !== input.provider ||
          existingOrderReceipt.providerTradeNo !== input.providerTradeNo ||
          existingOrderReceipt.amountTenThousandths !== amount
        ) {
          throw new RepositoryError(
            "CONFLICT",
            "Top-up order already has another receipt",
          );
        }
        return {
          outcome: "replayed" as const,
          orderId: order.id,
          orderState:
            order.state === "credited"
              ? ("credited" as const)
              : ("review_required" as const),
          providerTradeNo: existingOrderReceipt.providerTradeNo,
        };
      }
      const claimId = randomUUID();
      const creditable =
        order.state === "pending" &&
        input.paidAt <= order.checkoutExpiresAt &&
        order.amountTenThousandths === amount;
      await tx.insert(paymentReceiptClaims).values({
        id: claimId,
        provider: input.provider,
        providerTradeNo: input.providerTradeNo,
        providerOrderId: input.providerOrderId,
        walletScope: "media_publishing",
        payloadDigest: input.payloadDigest,
        status: creditable ? "credited" : "review_required",
        claimedAt: input.receivedAt,
        completedAt: creditable ? input.receivedAt : null,
      });
      await tx.insert(mediaPublishingTopupReceipts).values({
        id: randomUUID(),
        orderId: order.id,
        provider: input.provider,
        providerTradeNo: input.providerTradeNo,
        amountTenThousandths: amount,
        paidAt: input.paidAt,
        payloadDigest: input.payloadDigest,
        receivedAt: input.receivedAt,
      });
      if (!creditable) {
        await tx
          .update(mediaPublishingTopupOrders)
          .set({ state: "review_required", paidAt: input.paidAt })
          .where(eq(mediaPublishingTopupOrders.id, order.id));
        return {
          outcome: "recorded" as const,
          orderId: order.id,
          orderState: "review_required" as const,
          providerTradeNo: input.providerTradeNo,
        };
      }
      const [wallet] = await tx
        .select()
        .from(mediaPublishingWallets)
        .where(eq(mediaPublishingWallets.userId, order.ownerId))
        .for("update")
        .limit(1);
      if (!wallet)
        throw new RepositoryError("INVALID_STATE", "Wallet is missing");
      const nextBalance = wallet.balanceTenThousandths + amount;
      await tx
        .update(mediaPublishingWallets)
        .set({ balanceTenThousandths: nextBalance })
        .where(eq(mediaPublishingWallets.userId, order.ownerId));
      await tx
        .update(mediaPublishingTopupOrders)
        .set({
          state: "credited",
          paidAt: input.paidAt,
          creditedAt: input.receivedAt,
        })
        .where(eq(mediaPublishingTopupOrders.id, order.id));
      await tx.insert(mediaPublishingLedger).values({
        id: randomUUID(),
        ownerId: order.ownerId,
        type: "topup",
        balanceDeltaTenThousandths: amount,
        reservedDeltaTenThousandths: 0n,
        frozenDeltaTenThousandths: 0n,
        balanceAfterTenThousandths: nextBalance,
        reservedAfterTenThousandths: wallet.reservedTenThousandths,
        frozenAfterTenThousandths: wallet.frozenTenThousandths,
        idempotencyKey: `publisher:topup:${order.id}`,
        referenceType: "media_publishing_topup",
        referenceId: order.id,
        reason: "Media publishing wallet top-up credited",
      });
      return {
        outcome: "recorded" as const,
        orderId: order.id,
        orderState: "credited" as const,
        providerTradeNo: input.providerTradeNo,
      };
    });
  }
}

async function computePreflight(
  tx: Transaction,
  ownerId: string,
  draftId: string,
  expectedDraftRevision: number,
  now: Date,
  lock: boolean,
  issuance: {
    preflightRevision: string;
    expiresAt: Date;
  },
  requiredMode?: RealPublicationMode,
): Promise<PublisherPreflightOutput> {
  const draftQuery = tx
    .select()
    .from(publisherDrafts)
    .where(
      and(
        eq(publisherDrafts.id, draftId),
        monitoringProjectOwnerPredicate(publisherDrafts, ownerId),
      ),
    );
  const drafts = lock
    ? await draftQuery.for("update").limit(1)
    : await draftQuery.limit(1);
  const draft = drafts[0];
  if (!draft) throw new RepositoryError("NOT_FOUND", "Draft not found");
  if (draft.revision !== expectedDraftRevision || draft.status !== "ready") {
    throw new RepositoryError("CONFLICT", "Draft revision has changed");
  }
  const [version] = await tx
    .select()
    .from(publisherArticleVersions)
    .where(
      and(
        eq(publisherArticleVersions.id, draft.articleVersionId),
        monitoringProjectOwnerPredicate(publisherArticleVersions, ownerId),
      ),
    )
    .limit(1);
  if (!version)
    throw new RepositoryError("INVALID_STATE", "Article version is missing");
  const [article] = await tx
    .select({
      workingName: publisherArticles.workingName,
      suggestedTitle: publisherArticles.suggestedTitle,
    })
    .from(publisherArticles)
    .where(
      and(
        eq(publisherArticles.id, version.articleId),
        monitoringProjectOwnerPredicate(publisherArticles, ownerId),
      ),
    )
    .limit(1);
  if (!article)
    throw new RepositoryError("INVALID_STATE", "Article is missing");
  const selections = await loadDraftSelections(tx, ownerId, draftId);
  if (selections.length < 1 || selections.length > 20) {
    throw new RepositoryError(
      "INVALID_STATE",
      "Draft must select one to twenty media resources",
    );
  }
  if (selections.some(({ resource }) => !resource.mediaKind)) {
    throw new RepositoryError(
      "INVALID_STATE",
      "Draft contains media without a verified media kind",
    );
  }
  const [runtime] = await tx
    .select()
    .from(publisherRuntimeState)
    .where(eq(publisherRuntimeState.id, "kol"))
    .limit(1);
  const mode: PublicationMode = runtime?.mode ?? "mock";
  if (requiredMode !== undefined && mode !== requiredMode) {
    throw new RepositoryError(
      "INVALID_STATE",
      "Publisher runtime must remain in the required TEST or LIVE mode",
    );
  }
  const catalogRevision =
    runtime?.activeCatalogRevision ??
    selections[0]?.resource.catalogRevision ??
    "unavailable";
  const catalogSyncedAt = runtime?.catalogSyncedAt ?? null;
  const catalogStale =
    mode !== "mock" &&
    (!catalogSyncedAt ||
      now.getTime() - catalogSyncedAt.getTime() > CATALOG_STALE_MS);
  const globalBlockers: Array<{ code: string; message: string }> = [];
  if (!runtime?.featureEnabled) {
    globalBlockers.push({
      code: "FEATURE_DISABLED",
      message: "Media publishing customer access is disabled",
    });
  }
  if (mode !== "mock") {
    if (publisherCatalogKindIsIncomplete(mode, runtime?.catalogKindComplete)) {
      globalBlockers.push({
        code: "CATALOG_KIND_INCOMPLETE",
        message: "Dual-media catalog has not completed a verified sync",
      });
    }
    if (!runtime?.publishEnabled) {
      globalBlockers.push({
        code: "PUBLISH_DISABLED",
        message: "Provider publishing is disabled",
      });
    }
    if (runtime?.emergencyStop) {
      globalBlockers.push({
        code: "EMERGENCY_STOP",
        message: "Publishing is paused",
      });
    }
    if (runtime?.credentialStatus !== "healthy") {
      globalBlockers.push({
        code: "CREDENTIAL_UNHEALTHY",
        message: "Provider credentials are unavailable",
      });
    }
  }
  if (catalogStale) {
    globalBlockers.push({
      code: "CATALOG_STALE",
      message: "Media catalog is stale",
    });
  }
  const whitelist =
    mode === "live"
      ? await tx
          .select()
          .from(publisherLiveWhitelist)
          .where(
            inArray(
              publisherLiveWhitelist.mediaResourceId,
              selections.map(({ resource }) => resource.id),
            ),
          )
      : [];
  const whitelistByMedia = new Map(
    whitelist.map((entry) => [entry.mediaResourceId, entry]),
  );
  const total = selections.reduce(
    (sum, { resource }) => sum + resource.priceTenThousandths,
    0n,
  );
  const matchingCanaryResources =
    mode === "live" && !runtime?.imagePublishEnabled
      ? await tx
          .select({ id: publisherMediaResources.id })
          .from(publisherMediaResources)
          .where(
            and(
              eq(
                publisherMediaResources.name,
                PUBLISHER_IMAGE_CANARY_MEDIA_NAME,
              ),
              eq(publisherMediaResources.isActive, true),
            ),
          )
          .limit(2)
      : [];
  const versionImageAssets =
    mode !== "mock" && version.containsImages
      ? await loadPublisherVersionImageEvidence(tx, version.id, ownerId)
      : [];
  const versionImageEvidenceBlocker = publisherFrozenImageEvidenceBlocker({
    containsImages: mode !== "mock" && version.containsImages,
    assets: versionImageAssets,
  });
  const items = selections.map(
    ({
      draftItem,
      resource,
      imageSupport,
      capabilityEvidenceUrl,
      capabilityVerifiedAt,
    }) => {
      const blockers: Array<{
        code: string;
        message: string;
        itemId: string;
      }> = [];
      if (!resource.isActive) {
        blockers.push({
          code: "MEDIA_INACTIVE",
          message: "Media is unavailable",
          itemId: draftItem.id,
        });
      }
      if (resource.priceTenThousandths <= 0n) {
        blockers.push({
          code: "PRICE_INVALID",
          message: "Media has no valid positive customer price",
          itemId: draftItem.id,
        });
      }
      if (
        !publisherCatalogResourceRevisionIsPublishable({
          activeCatalogRevision: catalogRevision,
          resourceCatalogRevision: resource.catalogRevision,
          resourceIsActive: resource.isActive,
          consecutiveMisses: resource.consecutiveMisses,
        })
      ) {
        blockers.push({
          code: "CATALOG_CHANGED",
          message: "Media catalog has changed",
          itemId: draftItem.id,
        });
      }
      if (
        draftItem.selectedPriceTenThousandths !== resource.priceTenThousandths
      ) {
        blockers.push({
          code: "PRICE_CHANGED",
          message: "Media price has changed",
          itemId: draftItem.id,
        });
      }
      if (
        draftItem.mediaKindSnapshot === "unknown" ||
        draftItem.mediaKindSnapshot !== resource.mediaKind
      ) {
        blockers.push({
          code: "MEDIA_KIND_CHANGED",
          message: "Media category has changed; refresh the selected media",
          itemId: draftItem.id,
        });
      }
      if (publisherDraftMediaIdentityChanged(draftItem, resource)) {
        blockers.push({
          code: "MEDIA_METADATA_CHANGED",
          message:
            "Media identity or publishing rules have changed; refresh the selected media",
          itemId: draftItem.id,
        });
      }
      const selectedImageSupport = snapshotImageSupport(
        draftItem.mediaSnapshot,
      );
      if (
        selectedImageSupport !== null &&
        selectedImageSupport !== imageSupport
      ) {
        blockers.push({
          code: "MEDIA_CAPABILITY_CHANGED",
          message:
            "Media image capability has changed; refresh the selected media",
          itemId: draftItem.id,
        });
      }
      if (
        !draftItem.submissionTitle.trim() ||
        unicodeLength(draftItem.submissionTitle) > (resource.titleLimit ?? 200)
      ) {
        blockers.push({
          code: "TITLE_INVALID",
          message: "Media title is invalid",
          itemId: draftItem.id,
        });
      }
      const liveEntry = whitelistByMedia.get(resource.id);
      const canaryBlocker =
        mode === "live" &&
        version.containsImages &&
        !runtime?.imagePublishEnabled
          ? publisherLiveImageCanaryBlocker({
              batchItemCount: selections.length,
              matchingActiveResourceCount: matchingCanaryResources.length,
              resourceName: resource.name,
              totalTenThousandths: total,
              containsImages: version.containsImages,
              whitelistImageAllowed: liveEntry?.imageAllowed === true,
            })
          : null;
      if (canaryBlocker) {
        blockers.push({
          code: "LIVE_IMAGE_CANARY_REQUIRED",
          message: canaryBlocker,
          itemId: draftItem.id,
        });
      }
      if (mode !== "mock" && version.containsImages) {
        const capabilityBlocker = publisherImageCapabilityEvidenceBlocker({
          imageSupport,
          evidenceUrl: capabilityEvidenceUrl,
          verifiedAt: capabilityVerifiedAt,
        });
        if (capabilityBlocker) {
          blockers.push({
            code: "IMAGE_UNVERIFIED",
            message: capabilityBlocker,
            itemId: draftItem.id,
          });
        }
        if (versionImageEvidenceBlocker) {
          blockers.push({
            code: "IMAGE_ASSET_EVIDENCE_INVALID",
            message: versionImageEvidenceBlocker,
            itemId: draftItem.id,
          });
        }
        if (
          !runtime?.imagePublishEnabled &&
          !(mode === "live" && canaryBlocker === null)
        ) {
          blockers.push({
            code: "IMAGE_PUBLISH_DISABLED",
            message: "TEST/LIVE image publishing is disabled",
            itemId: draftItem.id,
          });
        }
      }
      if (mode === "live" && version.containsImages && !liveEntry) {
        blockers.push({
          code: "MEDIA_NOT_WHITELISTED",
          message: "Media is not enabled for LIVE",
          itemId: draftItem.id,
        });
      }
      if (
        mode === "live" &&
        version.containsImages &&
        !liveEntry?.imageAllowed
      ) {
        blockers.push({
          code: "LIVE_IMAGES_DISABLED",
          message: "LIVE image publishing is disabled",
          itemId: draftItem.id,
        });
      }
      return {
        draftItemId: draftItem.id,
        mediaResourceId: resource.id,
        mediaName: resource.name,
        mediaKind: resource.mediaKind!,
        submissionTitle: draftItem.submissionTitle,
        priceTenThousandths: publisherMoneyToApiString(
          resource.priceTenThousandths,
        ),
        imageSupport,
        warnings: [],
        blockers,
      };
    },
  );
  const [wallet] = await tx
    .select()
    .from(mediaPublishingWallets)
    .where(eq(mediaPublishingWallets.userId, ownerId))
    .limit(1);
  const available = wallet ? publisherAvailableMoney(wallet) : 0n;
  const fingerprint = sha256(
    stableJson({
      ownerId,
      articleVersionId: version.id,
      articleContentHash: version.contentHash,
      titleMode: draft.titleMode,
      catalogRevision,
      items: selections
        .map(({ draftItem, resource }) => ({
          mediaResourceId: resource.id,
          externalResourceId: resource.externalResourceId,
          mediaKind: resource.mediaKind,
          title: draftItem.submissionTitle,
          priceTenThousandths: resource.priceTenThousandths.toString(),
        }))
        .sort((left, right) =>
          left.mediaResourceId.localeCompare(right.mediaResourceId),
        ),
    }),
  );
  return {
    preflightRevision: issuance.preflightRevision,
    quoteFingerprint: fingerprint,
    mode,
    articleVersionId: version.id,
    articleWorkingName: article.workingName,
    articleSuggestedTitle: article.suggestedTitle,
    articleVersion: version.version,
    articleContentHash: version.contentHash,
    articleCanonicalHtml: version.canonicalHtml,
    articlePlainText: version.plainText,
    titleMode: draft.titleMode,
    catalogRevision,
    items,
    warnings: [],
    blockers: globalBlockers,
    totalTenThousandths: publisherMoneyToApiString(total),
    kindCounts: {
      news: selections.filter(({ resource }) => resource.mediaKind === "news")
        .length,
      selfMedia: selections.filter(
        ({ resource }) => resource.mediaKind === "self_media",
      ).length,
    },
    availableTenThousandths: publisherMoneyToApiString(available),
    availableAfterReservationTenThousandths: publisherMoneyToApiString(
      available - total,
    ),
    sufficientFunds: available >= total,
    requiresLiveConfirmation: mode === "live",
    expiresAt: issuance.expiresAt,
  };
}

function publisherExecutionOptions(options: PublisherExecutionOptions): {
  now: Date;
  requiredMode?: RealPublicationMode;
} {
  if (options instanceof Date) return { now: options };
  return {
    now: options.now ?? new Date(),
    ...(options.requiredMode ? { requiredMode: options.requiredMode } : {}),
  };
}

export function publisherLiveImageCanaryBlocker(input: {
  batchItemCount: number;
  matchingActiveResourceCount: number;
  resourceName: string;
  totalTenThousandths: bigint;
  containsImages: boolean;
  whitelistImageAllowed: boolean;
}): string | null {
  if (!input.containsImages) return null;
  if (
    input.batchItemCount !== 1 ||
    input.matchingActiveResourceCount !== 1 ||
    input.resourceName !== PUBLISHER_IMAGE_CANARY_MEDIA_NAME ||
    input.totalTenThousandths > PUBLISHER_IMAGE_CANARY_MAX_TEN_THOUSANDTHS ||
    !input.containsImages ||
    !input.whitelistImageAllowed
  ) {
    return "LIVE image canary constraints are not satisfied";
  }
  return null;
}

export function publisherFrozenImageEvidenceBlocker(input: {
  containsImages: boolean;
  assets: ReadonlyArray<{
    isFrozen: boolean;
    publicCapabilityDigest: string | null;
    publicCapabilityCreatedAt: Date | null;
    mimeType: string;
  }>;
}): string | null {
  if (!input.containsImages) return null;
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

async function publisherCanaryWhitelistBlocker(
  tx: Transaction,
  input: {
    mediaResourceId: string;
    imageAllowed: boolean;
  },
): Promise<string | null> {
  const [runtime] = await tx
    .select()
    .from(publisherRuntimeState)
    .where(eq(publisherRuntimeState.id, "kol"))
    .for("update")
    .limit(1);
  if (runtime?.mode !== "live" || runtime.imagePublishEnabled) return null;
  if (!input.imageAllowed) {
    return "The image canary whitelist must permit images";
  }
  const matchingResources = await tx
    .select({
      id: publisherMediaResources.id,
      priceTenThousandths: publisherMediaResources.priceTenThousandths,
    })
    .from(publisherMediaResources)
    .where(
      and(
        eq(publisherMediaResources.name, PUBLISHER_IMAGE_CANARY_MEDIA_NAME),
        eq(publisherMediaResources.isActive, true),
      ),
    )
    .limit(2);
  const target = matchingResources[0];
  if (
    matchingResources.length !== 1 ||
    target?.id !== input.mediaResourceId ||
    target.priceTenThousandths > PUBLISHER_IMAGE_CANARY_MAX_TEN_THOUSANDTHS
  ) {
    return "Only the unique in-budget image canary media may be whitelisted";
  }
  const [capability] = await tx
    .select({
      imageSupport: publisherMediaCapabilities.imageSupport,
      evidenceUrl: publisherMediaCapabilities.evidenceUrl,
      verifiedAt: publisherMediaCapabilities.verifiedAt,
    })
    .from(publisherMediaCapabilities)
    .where(
      eq(publisherMediaCapabilities.mediaResourceId, input.mediaResourceId),
    )
    .limit(1);
  return publisherImageCapabilityEvidenceBlocker(capability);
}

async function completedPublisherImageCanaryBlocker(
  tx: Transaction,
): Promise<string | null> {
  const matchingResources = await tx
    .select({ id: publisherMediaResources.id })
    .from(publisherMediaResources)
    .where(
      and(
        eq(publisherMediaResources.name, PUBLISHER_IMAGE_CANARY_MEDIA_NAME),
        eq(publisherMediaResources.isActive, true),
      ),
    )
    .limit(2);
  if (matchingResources.length !== 1) {
    return "The LIVE image canary media is not uniquely available";
  }
  const targetId = matchingResources[0]!.id;
  const [capability] = await tx
    .select({
      imageSupport: publisherMediaCapabilities.imageSupport,
      evidenceUrl: publisherMediaCapabilities.evidenceUrl,
      verifiedAt: publisherMediaCapabilities.verifiedAt,
    })
    .from(publisherMediaCapabilities)
    .where(eq(publisherMediaCapabilities.mediaResourceId, targetId))
    .limit(1);
  const capabilityBlocker = publisherImageCapabilityEvidenceBlocker(capability);
  if (capabilityBlocker) return capabilityBlocker;
  const [whitelist] = await tx
    .select({ imageAllowed: publisherLiveWhitelist.imageAllowed })
    .from(publisherLiveWhitelist)
    .where(eq(publisherLiveWhitelist.mediaResourceId, targetId))
    .limit(1);
  if (!whitelist?.imageAllowed) {
    return "The LIVE image canary media is not image-whitelisted";
  }
  const candidates = await tx
    .select({
      itemId: publisherItems.id,
      batchId: publisherItems.batchId,
      ownerId: publisherItems.ownerId,
      versionId: publisherArticleVersions.id,
      publishedUrl: publisherItems.publishedUrl,
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
      mediaPublishingItemPriceSnapshots,
      eq(mediaPublishingItemPriceSnapshots.itemId, publisherItems.id),
    )
    .where(
      and(
        eq(publisherItems.mediaResourceId, targetId),
        eq(publisherItems.status, "success"),
        eq(publisherItems.fundsStatus, "consumed"),
        eq(publisherBatches.mode, "live"),
        eq(publisherBatches.status, "success"),
        eq(publisherArticleVersions.containsImages, true),
        lte(
          mediaPublishingItemPriceSnapshots.amountTenThousandths,
          PUBLISHER_IMAGE_CANARY_MAX_TEN_THOUSANDTHS,
        ),
      ),
    )
    .orderBy(desc(publisherItems.completedAt))
    .limit(20);
  for (const candidate of candidates) {
    if (!isSafeHttpsPublicationUrl(candidate.publishedUrl)) continue;
    const batchItems = await tx
      .select({ id: publisherItems.id })
      .from(publisherItems)
      .where(eq(publisherItems.batchId, candidate.batchId))
      .limit(2);
    if (batchItems.length !== 1) continue;
    const assets = await loadPublisherVersionImageEvidence(
      tx,
      candidate.versionId,
      candidate.ownerId,
      false,
    );
    if (
      !publisherFrozenImageEvidenceBlocker({
        containsImages: true,
        assets,
      })
    ) {
      return null;
    }
  }
  return "A successful consumed LIVE image canary is required before opening image publishing";
}

function isSafeHttpsPublicationUrl(value: string | null): boolean {
  if (!value) return false;
  try {
    const url = new URL(value);
    return (
      url.protocol === "https:" &&
      Boolean(url.hostname) &&
      !url.username &&
      !url.password
    );
  } catch {
    return false;
  }
}

function loadPublisherVersionImageEvidence(
  tx: Transaction,
  versionId: string,
  ownerId: string,
  scopeToProject = true,
) {
  return tx
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
        sql`${publisherArticleAssets.enterpriseProjectId} <=> ${publisherArticleVersionAssets.enterpriseProjectId}`,
      ),
    )
    .where(
      and(
        eq(publisherArticleVersionAssets.articleVersionId, versionId),
        scopeToProject
          ? monitoringProjectOwnerPredicate(
              publisherArticleVersionAssets,
              ownerId,
            )
          : eq(publisherArticleVersionAssets.ownerId, ownerId),
      ),
    );
}

async function loadDraftSelections(
  tx: Transaction,
  ownerId: string,
  draftId: string,
) {
  return tx
    .select({
      draftItem: publisherDraftItems,
      resource: publisherMediaResources,
      imageSupport: publisherMediaCapabilities.imageSupport,
      capabilityEvidenceUrl: publisherMediaCapabilities.evidenceUrl,
      capabilityVerifiedAt: publisherMediaCapabilities.verifiedAt,
    })
    .from(publisherDraftItems)
    .innerJoin(
      publisherMediaResources,
      eq(publisherMediaResources.id, publisherDraftItems.mediaResourceId),
    )
    .leftJoin(
      publisherMediaCapabilities,
      eq(
        publisherMediaCapabilities.mediaResourceId,
        publisherMediaResources.id,
      ),
    )
    .where(
      and(
        eq(publisherDraftItems.draftId, draftId),
        monitoringProjectOwnerPredicate(publisherDraftItems, ownerId),
      ),
    )
    .orderBy(asc(publisherDraftItems.id))
    .then((rows) =>
      rows.map((row) => ({
        ...row,
        imageSupport: row.imageSupport ?? ("unknown" as const),
      })),
    );
}

async function ensureAndLockPublisherWallet(tx: Transaction, ownerId: string) {
  const [user] = await tx
    .select({ id: users.id })
    .from(users)
    .where(eq(users.id, ownerId))
    .limit(1);
  if (!user) throw new RepositoryError("NOT_FOUND", "User not found");
  await tx
    .insert(mediaPublishingWallets)
    .values({ userId: ownerId })
    .onDuplicateKeyUpdate({
      set: { userId: sql`${mediaPublishingWallets.userId}` },
    });
  const [wallet] = await tx
    .select()
    .from(mediaPublishingWallets)
    .where(eq(mediaPublishingWallets.userId, ownerId))
    .for("update")
    .limit(1);
  if (!wallet) throw new RepositoryError("INVALID_STATE", "Wallet is missing");
  return wallet;
}

async function lockOwnedArticle(
  tx: Transaction,
  ownerId: string,
  articleId: string,
) {
  const [article] = await tx
    .select()
    .from(publisherArticles)
    .where(
      and(
        eq(publisherArticles.id, articleId),
        monitoringProjectOwnerPredicate(publisherArticles, ownerId),
      ),
    )
    .for("update")
    .limit(1);
  if (!article) throw new RepositoryError("NOT_FOUND", "Article not found");
  return article;
}

async function refreshPublisherBatchState(tx: Transaction, batchId: string) {
  const items = await tx
    .select({
      status: publisherItems.status,
      fundsStatus: publisherItems.fundsStatus,
    })
    .from(publisherItems)
    .where(eq(publisherItems.batchId, batchId));
  if (items.length === 0) return;
  const allFinal = items.every(
    (item) => item.status === "success" || item.status === "failed",
  );
  const successes = items.filter((item) => item.status === "success").length;
  const actionRequired = items.some(
    (item) =>
      item.status === "submission_unknown" ||
      item.status === "action_required" ||
      item.status === "auth_blocked",
  );
  const status = actionRequired
    ? "action_required"
    : !allFinal
      ? "processing"
      : successes === items.length
        ? "success"
        : successes === 0
          ? "failed"
          : "partial_success";
  const fundsStatus = derivePublisherBatchFundsStatus(
    items.map((item) => item.fundsStatus),
  );
  await tx
    .update(publisherBatches)
    .set({
      status,
      fundsStatus,
      completedAt: allFinal && !actionRequired ? new Date() : null,
    })
    .where(eq(publisherBatches.id, batchId));
}

function mediaPublishingBillingSummary(
  wallet: typeof mediaPublishingWallets.$inferSelect,
) {
  return {
    userId: wallet.userId,
    walletScope: "media_publishing" as const,
    currency: "CNY" as const,
    scale: 4 as const,
    balanceTenThousandths: publisherMoneyToApiString(
      wallet.balanceTenThousandths,
    ),
    reservedTenThousandths: publisherMoneyToApiString(
      wallet.reservedTenThousandths,
    ),
    frozenTenThousandths: publisherMoneyToApiString(
      wallet.frozenTenThousandths,
    ),
    spentTenThousandths: publisherMoneyToApiString(wallet.spentTenThousandths),
    availableTenThousandths: publisherMoneyToApiString(
      publisherAvailableMoney(wallet),
    ),
  };
}

function publisherBatchSubmitResult(
  batch: typeof publisherBatches.$inferSelect,
) {
  return {
    batchId: batch.id,
    status: batch.status,
    fundsStatus: batch.fundsStatus,
    mode: batch.mode,
    totalTenThousandths: publisherMoneyToApiString(
      batch.quotedTotalTenThousandths,
    ),
    createdAt: batch.createdAt,
  };
}

function batchDto(
  batch: typeof publisherBatches.$inferSelect,
  details: {
    article: {
      workingName: string;
      suggestedTitle: string | null;
      version: number;
      contentHash: string;
    };
    items: ReadonlyArray<{
      mediaKind: "news" | "self_media" | "unknown";
      status: typeof publisherItems.$inferSelect.status;
      fundsStatus: typeof publisherItems.$inferSelect.fundsStatus;
      priceTenThousandths: bigint;
    }>;
  },
) {
  const fundsTotal = (
    fundsStatus: typeof publisherItems.$inferSelect.fundsStatus,
  ) =>
    details.items
      .filter((item) => item.fundsStatus === fundsStatus)
      .reduce((total, item) => total + item.priceTenThousandths, 0n)
      .toString();
  return {
    id: batch.id,
    draftId: batch.draftId,
    articleVersionId: batch.articleVersionId,
    status: batch.status,
    mode: batch.mode,
    fundsStatus: batch.fundsStatus,
    quotedTotalTenThousandths: batch.quotedTotalTenThousandths.toString(),
    titleMode: batch.titleMode,
    article: details.article,
    kindCounts: {
      news: details.items.filter((item) => item.mediaKind === "news").length,
      selfMedia: details.items.filter((item) => item.mediaKind === "self_media")
        .length,
      unknown: details.items.filter((item) => item.mediaKind === "unknown")
        .length,
    },
    itemCount: details.items.length,
    successCount: details.items.filter((item) => item.status === "success")
      .length,
    failedCount: details.items.filter((item) => item.status === "failed")
      .length,
    unknownCount: details.items.filter((item) =>
      ["auth_blocked", "submission_unknown", "action_required"].includes(
        item.status,
      ),
    ).length,
    consumedTenThousandths: fundsTotal("consumed"),
    releasedTenThousandths: fundsTotal("released"),
    frozenTenThousandths: fundsTotal("frozen"),
    reservedTenThousandths: fundsTotal("reserved"),
    completedAt: batch.completedAt,
    createdAt: batch.createdAt,
    updatedAt: batch.updatedAt,
  };
}

function snapshotString(
  snapshot: Record<string, unknown>,
  key: string,
): string | null {
  const value = snapshot[key];
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function mediaPublishingTopupDto(
  order: typeof mediaPublishingTopupOrders.$inferSelect,
) {
  return {
    ...order,
    walletScope: "media_publishing" as const,
    scale: 4 as const,
    amountTenThousandths: publisherMoneyToApiString(order.amountTenThousandths),
  };
}

function assertMediaPublishingTopup(
  input: {
    providerOrderId: string;
    idempotencyKey: string;
    callbackTokenDigest: string;
    checkoutExpiresAt: Date;
  },
  amount: bigint,
) {
  if (amount < 100_000n || amount > 500_000_000n || amount % 100n !== 0n) {
    throw new RepositoryError("INVALID_STATE", "Invalid top-up amount");
  }
  if (!/^[1-9]\d{0,31}$/u.test(input.providerOrderId)) {
    throw new RepositoryError("INVALID_STATE", "Invalid provider order ID");
  }
  if (input.idempotencyKey.length < 8 || input.idempotencyKey.length > 128) {
    throw new RepositoryError("INVALID_STATE", "Invalid idempotency key");
  }
  if (!/^[a-f0-9]{64}$/u.test(input.callbackTokenDigest)) {
    throw new RepositoryError("INVALID_STATE", "Invalid callback digest");
  }
  if (!Number.isFinite(input.checkoutExpiresAt.getTime())) {
    throw new RepositoryError("INVALID_STATE", "Invalid checkout expiry");
  }
}

export function publisherPreflightTokenBlocker(input: {
  preflight:
    | {
        ownerId: string;
        draftId: string;
        draftRevision: number;
        quoteFingerprint: string;
        expiresAt: Date;
        consumedAt: Date | null;
      }
    | undefined;
  ownerId: string;
  draftId: string;
  draftRevision: number;
  quoteFingerprint: string;
  now: Date;
}): string | null {
  const preflight = input.preflight;
  if (
    !preflight ||
    preflight.ownerId !== input.ownerId ||
    preflight.draftId !== input.draftId ||
    preflight.draftRevision !== input.draftRevision ||
    preflight.quoteFingerprint !== input.quoteFingerprint ||
    preflight.consumedAt !== null ||
    !Number.isFinite(preflight.expiresAt.getTime()) ||
    preflight.expiresAt.getTime() <= input.now.getTime()
  ) {
    return "Preflight is invalid, expired, or already consumed";
  }
  return null;
}

export function publisherCatalogKindIsIncomplete(
  mode: PublicationMode,
  catalogKindComplete: boolean | null | undefined,
): boolean {
  return mode !== "mock" && catalogKindComplete !== true;
}

export function publisherCatalogResourceRevisionIsPublishable(input: {
  activeCatalogRevision: string;
  resourceCatalogRevision: string;
  resourceIsActive: boolean;
  consecutiveMisses: number;
}): boolean {
  return (
    input.resourceCatalogRevision === input.activeCatalogRevision ||
    (input.resourceIsActive && input.consecutiveMisses === 1)
  );
}

export function publisherRealLogoCoverage(input: {
  total: number;
  logoProviderArchived: number;
  logoIconArchived: number;
  logoWebSearchVerifiedArchived: number;
  logoManualVerifiedArchived: number;
  logoSiteFaviconArchived: number;
  logoGeneratedFallback: number;
}): {
  logoRealCount: number;
  logoRealMissing: number;
  logoRealCoverageBasisPoints: number;
} {
  // Site favicons and generated marks are display fallbacks, never proof of a
  // media brand Logo. They therefore remain in `logoRealMissing`.
  const logoRealCount = Math.min(
    Math.max(
      input.logoProviderArchived +
        input.logoIconArchived +
        input.logoWebSearchVerifiedArchived +
        input.logoManualVerifiedArchived,
      0,
    ),
    Math.max(input.total, 0),
  );
  const total = Math.max(input.total, 0);
  return {
    logoRealCount,
    logoRealMissing: Math.max(total - logoRealCount, 0),
    logoRealCoverageBasisPoints:
      total > 0 ? Math.round((logoRealCount * 10_000) / total) : 0,
  };
}

function publisherPreflightSnapshotHash(
  preflight: PublisherPreflightOutput,
): string {
  return sha256(
    stableJson({
      ...preflight,
      expiresAt: preflight.expiresAt.toISOString(),
    }),
  );
}

function customerSafeMediaSnapshot(
  resource: typeof publisherMediaResources.$inferSelect,
) {
  return {
    id: resource.id,
    externalResourceId: resource.externalResourceId,
    catalogRevision: resource.catalogRevision,
    name: resource.name,
    kind: resource.mediaKind ?? "unknown",
    platform: resource.platform,
    taxonomy: resource.taxonomy,
    mediaType: resource.mediaType,
    area: resource.area,
    titleLimit: resource.titleLimit,
    priceTenThousandths: resource.priceTenThousandths.toString(),
    successRateBasisPoints: resource.successRateBasisPoints,
    includeRateBasisPoints: resource.includeRateBasisPoints,
    pcWeight: resource.pcWeight,
    mobileWeight: resource.mobileWeight,
    includeType: resource.includeType,
    publishSpeed: resource.publishSpeed,
    entryType: resource.entryLevel,
    entryUrl: resource.entryUrl,
    entryLevel: resource.entryLevel,
    linkType: resource.linkType,
    caseUrl: resource.caseUrl,
    logoUrl: publisherMediaLogoAccessPath(resource),
    logoSource: publisherMediaLogoDisplaySource(resource),
    logoResolutionStatus: resource.logoArchiveStatus,
    remark: resource.remark,
    description: resource.description,
    recommended: resource.recommended,
    ...publisherMediaEditorialMetadata(resource.rawPayload),
    authenticated: resource.authenticated,
    festivalPublishable: resource.festivalPublishable,
    fanCount: resource.fanCount?.toString() ?? null,
    likeCount: resource.likeCount?.toString() ?? null,
    publishCount: resource.publishCount?.toString() ?? null,
  };
}

/** Explicit customer fields only: never serialize the provider raw object. */
export function publisherMediaEditorialMetadata(
  raw: Record<string, unknown> | null | undefined,
) {
  const tags = (key: string) =>
    [
      ...new Set(
        (Array.isArray(raw?.[key]) ? (raw[key] as unknown[]) : [])
          .filter((value): value is string => typeof value === "string")
          .map((value) => value.trim().slice(0, 120))
          .filter(Boolean),
      ),
    ].slice(0, 30);
  const text = (key: string) =>
    typeof raw?.[key] === "string"
      ? (raw[key] as string).trim().slice(0, 10_000) || null
      : null;
  return {
    recommendationTags: tags("recommendationTags"),
    platformRecommendationTags: tags("platformRecommendationTags"),
    recommendationRemark: text("recommendationRemark"),
    authenticationType: text("authenticationType"),
    authenticationDescription: text("authenticationDescription"),
  };
}

function publisherMediaLogoAccessPath(
  resource: typeof publisherMediaResources.$inferSelect,
): string | null {
  if (
    resource.logoArchiveStatus !== "archived" ||
    !resource.logoObjectKey ||
    !resource.logoSha256 ||
    !/^[a-f0-9]{64}$/u.test(resource.logoSha256)
  ) {
    return null;
  }
  return `/api/monitoring/publisher/media-logos/${encodeURIComponent(resource.id)}/${resource.logoSha256}`;
}

function publisherMediaLogoDisplaySource(
  resource: typeof publisherMediaResources.$inferSelect,
):
  | "provider_logo"
  | "provider_icon"
  | "site_favicon"
  | "web_search_verified"
  | "manual_verified"
  | "generated_fallback" {
  if (resource.logoArchiveStatus !== "archived") return "generated_fallback";
  if (resource.logoSourceKind === "logo") return "provider_logo";
  if (resource.logoSourceKind === "icon") return "provider_icon";
  if (resource.logoSourceKind === "site_favicon") return "site_favicon";
  if (resource.logoSourceKind === "web_search_verified") {
    return "web_search_verified";
  }
  if (resource.logoSourceKind === "manual_verified") return "manual_verified";
  return "generated_fallback";
}

function publisherMediaLogoSnapshotPath(value: string | null): string | null {
  return value &&
    /^\/api\/publisher\/media-logos\/[0-9a-f-]{36}\/[a-f0-9]{64}$/u.test(value)
    ? value
    : null;
}

function snapshotPublisherMediaLogoSource(
  snapshot: Record<string, unknown>,
):
  | "provider_logo"
  | "provider_icon"
  | "site_favicon"
  | "web_search_verified"
  | "manual_verified"
  | "generated_fallback"
  | null {
  const value = snapshot.logoSource;
  return value === "provider_logo" ||
    value === "provider_icon" ||
    value === "site_favicon" ||
    value === "web_search_verified" ||
    value === "manual_verified" ||
    value === "generated_fallback"
    ? value
    : null;
}

function snapshotPublisherMediaLogoResolutionStatus(
  snapshot: Record<string, unknown>,
  fallback: "pending" | "archived" | "pending_review" | "missing" | "failed",
): "pending" | "archived" | "pending_review" | "missing" | "failed" {
  const value = snapshot.logoResolutionStatus;
  return value === "pending" ||
    value === "archived" ||
    value === "pending_review" ||
    value === "missing" ||
    value === "failed"
    ? value
    : fallback;
}

function customerMediaDto(
  resource: typeof publisherMediaResources.$inferSelect,
  imageSupport: "unknown" | "verified" | "unsupported",
) {
  if (!resource.mediaKind) {
    throw new RepositoryError(
      "INVALID_STATE",
      "Media resource has no verified media kind",
    );
  }
  return {
    ...customerSafeMediaSnapshot(resource),
    kind: resource.mediaKind,
    imageSupport,
    isActive: resource.isActive,
    updatedAt: resource.updatedAt,
  };
}

function draftMediaSnapshot(
  draftItem: typeof publisherDraftItems.$inferSelect,
  current: typeof publisherMediaResources.$inferSelect,
  imageSupport: "unknown" | "verified" | "unsupported",
) {
  const snapshot = draftItem.mediaSnapshot;
  const hasFrozenLogoState =
    "logoUrl" in snapshot ||
    "logoSource" in snapshot ||
    "logoResolutionStatus" in snapshot;
  const frozenLogoUrl = publisherMediaLogoSnapshotPath(
    snapshotNullableString(snapshot, "logoUrl", null),
  );
  const frozenLogoSource = snapshotPublisherMediaLogoSource(snapshot);
  return {
    id: current.id,
    externalResourceId:
      snapshotString(snapshot, "externalResourceId") ??
      draftItem.externalResourceId,
    catalogRevision: draftItem.selectedCatalogRevision,
    name: snapshotString(snapshot, "name") ?? current.name,
    kind: draftItem.mediaKindSnapshot,
    platform: snapshotNullableString(snapshot, "platform", current.platform),
    taxonomy: snapshotNullableString(snapshot, "taxonomy", current.taxonomy),
    mediaType: snapshotNullableString(snapshot, "mediaType", current.mediaType),
    area: snapshotNullableString(snapshot, "area", current.area),
    titleLimit: snapshotNullableNumber(
      snapshot,
      "titleLimit",
      current.titleLimit,
    ),
    priceTenThousandths: draftItem.selectedPriceTenThousandths.toString(),
    successRateBasisPoints: snapshotNullableNumber(
      snapshot,
      "successRateBasisPoints",
      current.successRateBasisPoints,
    ),
    includeRateBasisPoints: snapshotNullableNumber(
      snapshot,
      "includeRateBasisPoints",
      current.includeRateBasisPoints,
    ),
    pcWeight: snapshotNullableNumber(snapshot, "pcWeight", current.pcWeight),
    mobileWeight: snapshotNullableNumber(
      snapshot,
      "mobileWeight",
      current.mobileWeight,
    ),
    includeType: snapshotNullableString(
      snapshot,
      "includeType",
      current.includeType,
    ),
    publishSpeed: snapshotNullableString(
      snapshot,
      "publishSpeed",
      current.publishSpeed,
    ),
    entryType: snapshotNullableString(
      snapshot,
      "entryType",
      current.entryLevel,
    ),
    entryUrl: snapshotNullableString(snapshot, "entryUrl", current.entryUrl),
    entryLevel: snapshotNullableString(
      snapshot,
      "entryLevel",
      current.entryLevel,
    ),
    linkType: snapshotNullableString(snapshot, "linkType", current.linkType),
    caseUrl: snapshotNullableString(snapshot, "caseUrl", current.caseUrl),
    logoUrl: hasFrozenLogoState
      ? frozenLogoUrl
      : publisherMediaLogoAccessPath(current),
    logoSource:
      (hasFrozenLogoState ? frozenLogoSource : null) ??
      (hasFrozenLogoState
        ? "generated_fallback"
        : publisherMediaLogoDisplaySource(current)),
    logoResolutionStatus: snapshotPublisherMediaLogoResolutionStatus(
      snapshot,
      hasFrozenLogoState ? "missing" : current.logoArchiveStatus,
    ),
    remark: snapshotNullableString(snapshot, "remark", current.remark),
    description: snapshotNullableString(
      snapshot,
      "description",
      current.description,
    ),
    recommended: snapshotNullableBoolean(
      snapshot,
      "recommended",
      current.recommended,
    ),
    ...publisherMediaEditorialMetadata(snapshot),
    authenticated: snapshotNullableBoolean(
      snapshot,
      "authenticated",
      current.authenticated,
    ),
    festivalPublishable: snapshotNullableBoolean(
      snapshot,
      "festivalPublishable",
      current.festivalPublishable,
    ),
    fanCount: snapshotNullableBigintString(
      snapshot,
      "fanCount",
      current.fanCount,
    ),
    likeCount: snapshotNullableBigintString(
      snapshot,
      "likeCount",
      current.likeCount,
    ),
    publishCount: snapshotNullableBigintString(
      snapshot,
      "publishCount",
      current.publishCount,
    ),
    imageSupport: snapshotImageSupport(snapshot) ?? imageSupport,
    isActive: current.isActive,
    updatedAt: current.updatedAt,
  };
}

function publisherDraftMediaIdentityChanged(
  draftItem: typeof publisherDraftItems.$inferSelect,
  current: typeof publisherMediaResources.$inferSelect,
): boolean {
  const snapshot = draftItem.mediaSnapshot;
  const comparisons: Array<[string, string | number | null]> = [
    ["externalResourceId", current.externalResourceId],
    ["name", current.name],
    ["platform", current.platform],
    ["taxonomy", current.taxonomy],
    ["mediaType", current.mediaType],
    ["titleLimit", current.titleLimit],
  ];
  return comparisons.some(([key, value]) => {
    if (!(key in snapshot)) return false;
    return snapshot[key] !== value;
  });
}

function snapshotNullableString(
  snapshot: Record<string, unknown>,
  key: string,
  fallback: string | null,
): string | null {
  if (!(key in snapshot)) return fallback;
  const value = snapshot[key];
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function snapshotNullableNumber(
  snapshot: Record<string, unknown>,
  key: string,
  fallback: number | null,
): number | null {
  if (!(key in snapshot)) return fallback;
  const value = snapshot[key];
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function snapshotNullableBoolean(
  snapshot: Record<string, unknown>,
  key: string,
  fallback: boolean | null,
): boolean | null {
  if (!(key in snapshot)) return fallback;
  return typeof snapshot[key] === "boolean" ? snapshot[key] : null;
}

function snapshotNullableBigintString(
  snapshot: Record<string, unknown>,
  key: string,
  fallback: bigint | null,
): string | null {
  if (!(key in snapshot)) return fallback?.toString() ?? null;
  const value = snapshot[key];
  return typeof value === "string" && /^\d+$/u.test(value) ? value : null;
}

function snapshotImageSupport(
  snapshot: Record<string, unknown>,
): "unknown" | "verified" | "unsupported" | null {
  const value = snapshot.imageSupport;
  return value === "unknown" || value === "verified" || value === "unsupported"
    ? value
    : null;
}

function publisherMediaOrdering(
  sort:
    | "recommended"
    | "price_asc"
    | "price_desc"
    | "success_desc"
    | "include_desc"
    | "weight_desc"
    | "updated_desc"
    | undefined,
) {
  switch (sort) {
    case "price_asc":
      return [
        asc(publisherMediaResources.priceTenThousandths),
        asc(publisherMediaResources.externalResourceId),
        asc(publisherMediaResources.id),
      ] as const;
    case "price_desc":
      return [
        desc(publisherMediaResources.priceTenThousandths),
        asc(publisherMediaResources.externalResourceId),
        asc(publisherMediaResources.id),
      ] as const;
    case "success_desc":
      return [
        desc(publisherMediaResources.successRateBasisPoints),
        asc(publisherMediaResources.externalResourceId),
        asc(publisherMediaResources.id),
      ] as const;
    case "include_desc":
      return [
        desc(publisherMediaResources.includeRateBasisPoints),
        asc(publisherMediaResources.externalResourceId),
        asc(publisherMediaResources.id),
      ] as const;
    case "weight_desc":
      return [
        desc(publisherMediaResources.pcWeight),
        asc(publisherMediaResources.externalResourceId),
        asc(publisherMediaResources.id),
      ] as const;
    case "updated_desc":
      return [
        desc(publisherMediaResources.updatedAt),
        asc(publisherMediaResources.externalResourceId),
        asc(publisherMediaResources.id),
      ] as const;
    default:
      return [
        desc(publisherMediaResources.recommended),
        desc(publisherMediaResources.successRateBasisPoints),
        asc(publisherMediaResources.priceTenThousandths),
        asc(publisherMediaResources.externalResourceId),
        asc(publisherMediaResources.id),
      ] as const;
  }
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function stableJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  return `{${Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`)
    .join(",")}}`;
}

function unicodeLength(value: string): number {
  return Array.from(value).length;
}

function escapeLike(value: string): string {
  return value
    .replaceAll("\\", "\\\\")
    .replaceAll("%", "\\%")
    .replaceAll("_", "\\_");
}

function truncateText(value: string, maximum: number): string {
  const normalized = value.trim();
  return normalized.length <= maximum
    ? normalized
    : normalized.slice(0, maximum);
}
