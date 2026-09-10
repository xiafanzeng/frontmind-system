import { z } from "zod";
import {
  currencySchema,
  moneyAmountSchema,
  moneyScaleSchema,
  topupCheckoutOutputSchema,
  topupOrderStateSchema,
  topupPaymentMethodSchema,
} from "./billing.js";
import { idSchema, idempotencyKeySchema } from "./monitoring.js";

export const walletScopeSchema = z.enum(["monitoring", "media_publishing"]);
export const publisherNonnegativeMoneyAmountSchema = z
  .string()
  .regex(
    /^(?:0|[1-9]\d*)$/u,
    "Expected non-negative integer 1/10,000 CNY units",
  );
export const publisherPositiveFenCompatibleMoneyAmountSchema =
  publisherNonnegativeMoneyAmountSchema.refine((value) => {
    const amount = BigInt(value);
    return amount >= 100_000n && amount <= 500_000_000n && amount % 100n === 0n;
  }, "Top-up amount must be between CNY 10 and CNY 50,000 in whole fen");
const publisherOptionalSubmissionTitleSchema = z
  .string()
  .trim()
  .refine(
    (value) => Array.from(value).length <= 200,
    "Submission title must contain at most 200 Unicode characters",
  );
const publisherRequiredSubmissionTitleSchema =
  publisherOptionalSubmissionTitleSchema.refine(
    (value) => value.length > 0,
    "Submission title is required",
  );
export const publicationModeSchema = z.enum(["mock", "test", "live"]);
export const publisherArticleStatusSchema = z.enum([
  "draft",
  "ready",
  "archived",
]);
export const publisherImportStatusSchema = z.enum([
  "uploaded",
  "validating",
  "parsing",
  "ready",
  "rejected",
  "failed",
]);
export const publisherImageSupportSchema = z.enum([
  "unknown",
  "verified",
  "unsupported",
]);
export const publisherMediaKindSchema = z.enum(["news", "self_media"]);
export const publisherHistoricalMediaKindSchema = z.enum([
  "news",
  "self_media",
  "unknown",
]);
export const publisherTitleModeSchema = z.enum(["single", "per_media"]);
export const publisherMediaSortSchema = z.enum([
  "recommended",
  "price_asc",
  "price_desc",
  "success_desc",
  "include_desc",
  "weight_desc",
  "updated_desc",
]);
export const publisherMediaSyncStatusSchema = z.enum([
  "running",
  "success",
  "partial",
  "failed",
]);
export const publisherMediaLogoSourceSchema = z.enum([
  "provider_logo",
  "provider_icon",
  "site_favicon",
  "web_search_verified",
  "manual_verified",
  "generated_fallback",
]);
export const publisherMediaLogoResolutionStatusSchema = z.enum([
  "pending",
  "archived",
  "pending_review",
  "missing",
  "failed",
]);
export const publisherDraftStatusSchema = z.enum([
  "draft",
  "ready",
  "submitted",
  "archived",
]);
export const publisherBatchStatusSchema = z.enum([
  "queued",
  "processing",
  "success",
  "failed",
  "partial_success",
  "action_required",
]);
export const publisherItemStatusSchema = z.enum([
  "queued",
  "submitting",
  "processing",
  "success",
  "failed",
  "auth_blocked",
  "submission_unknown",
  "action_required",
]);
export const publisherFundsStatusSchema = z.enum([
  "reserved",
  "frozen",
  "consumed",
  "released",
]);
export const publisherJobTypeSchema = z.enum([
  "import_docx",
  "sync_kol_catalog",
  "archive_publisher_media_logo",
  "submit_publication_item",
  "poll_publication_item",
  "reconcile_publication_unknown",
  "purge_publisher_assets",
]);
export const publisherJobStatusSchema = z.enum([
  "ready",
  "leased",
  "retry_wait",
  "paused",
  "succeeded",
  "dead",
]);

export const publisherIssueSchema = z.object({
  code: z.string().trim().min(1).max(64),
  message: z.string().trim().min(1).max(500),
  itemId: idSchema.nullable().optional(),
  field: z.string().trim().min(1).max(64).nullable().optional(),
});

export const publisherArticleSummaryOutputSchema = z.object({
  id: idSchema,
  workingName: z.string(),
  suggestedTitle: z.string().nullable(),
  status: publisherArticleStatusSchema,
  currentVersionId: idSchema.nullable(),
  currentVersion: z.number().int().positive().nullable(),
  containsImages: z.boolean(),
  revision: z.number().int().nonnegative(),
  updatedAt: z.coerce.date(),
  createdAt: z.coerce.date(),
});

export const publisherCreateArticleInputSchema = z.object({
  workingName: z.string().trim().min(1).max(180),
});

export const publisherArticleListInputSchema = z.object({
  query: z.string().trim().max(120).optional(),
  status: publisherArticleStatusSchema.optional(),
  cursor: z.string().max(256).optional(),
  limit: z.number().int().min(1).max(100).default(20),
});

export const publisherArticleListOutputSchema = z.object({
  items: z.array(publisherArticleSummaryOutputSchema),
  nextCursor: z.string().nullable(),
});

export const publisherArticleOutputSchema =
  publisherArticleSummaryOutputSchema.extend({
    editorJson: z.unknown().nullable(),
    canonicalHtml: z.string().nullable(),
    plainText: z.string().nullable(),
    contentHash: z
      .string()
      .regex(/^[a-f0-9]{64}$/u)
      .nullable(),
  });

export const publisherSaveArticleInputSchema = z.object({
  articleId: idSchema,
  expectedRevision: z.number().int().nonnegative(),
  workingName: z.string().trim().min(1).max(180),
  suggestedTitle: z.string().trim().max(200).nullable().optional(),
  editorJson: z.unknown(),
  canonicalHtml: z.string().max(2_000_000),
  plainText: z.string().max(1_000_000),
});

export const publisherFreezeArticleInputSchema = z.object({
  articleId: idSchema,
  expectedRevision: z.number().int().nonnegative(),
  idempotencyKey: idempotencyKeySchema,
});

export const publisherArticleVersionOutputSchema = z.object({
  id: idSchema,
  articleId: idSchema,
  version: z.number().int().positive(),
  contentHash: z.string().regex(/^[a-f0-9]{64}$/u),
  containsImages: z.boolean(),
  createdAt: z.coerce.date(),
});

export const publisherDocxImportOutputSchema = z.object({
  id: idSchema,
  articleId: idSchema.nullable(),
  sourceFilename: z.string(),
  sizeBytes: z.number().int().nonnegative(),
  status: publisherImportStatusSchema,
  warnings: z.array(publisherIssueSchema),
  blockers: z.array(publisherIssueSchema),
  createdAt: z.coerce.date(),
  updatedAt: z.coerce.date(),
});

export const publisherImportStatusInputSchema = z.object({
  importId: idSchema,
});
export const publisherImportListInputSchema = z.object({
  cursor: idSchema.optional(),
  limit: z.number().int().min(1).max(100).default(20),
});
export const publisherImportListOutputSchema = z.object({
  items: z.array(publisherDocxImportOutputSchema),
  nextCursor: idSchema.nullable(),
});

export const publisherArticleAssetOutputSchema = z.object({
  id: idSchema,
  articleId: idSchema,
  sha256: z.string().regex(/^[a-f0-9]{64}$/u),
  mimeType: z.enum(["image/jpeg", "image/png"]),
  width: z.number().int().positive().max(2_560),
  height: z.number().int().positive().max(2_560),
  sizeBytes: z
    .number()
    .int()
    .positive()
    .max(10 * 1024 * 1024),
  altText: z.string().nullable(),
  isFrozen: z.boolean(),
  createdAt: z.coerce.date(),
});
export const publisherArticleAssetsInputSchema = z.object({
  articleId: idSchema,
});

export const publisherMediaListInputSchema = z
  .object({
    kind: publisherMediaKindSchema.optional(),
    query: z.string().trim().max(120).optional(),
    batchQuery: z.array(z.string().trim().min(1).max(120)).max(50).optional(),
    includeInactive: z.boolean().optional(),
    platform: z.string().trim().max(120).optional(),
    taxonomy: z.string().trim().max(120).optional(),
    mediaType: z.string().trim().max(120).optional(),
    area: z.string().trim().max(120).optional(),
    recommended: z.boolean().optional(),
    includeType: z.string().trim().max(120).optional(),
    publishSpeed: z.string().trim().max(120).optional(),
    entryType: z.string().trim().max(120).optional(),
    entryLevel: z.string().trim().max(120).optional(),
    linkType: z.string().trim().max(120).optional(),
    minimumPcWeight: z.number().int().min(0).max(100).optional(),
    minimumIncludeRate: z.number().min(0).max(100).optional(),
    imageSupport: publisherImageSupportSchema.optional(),
    minimumSuccessRate: z.number().min(0).max(100).optional(),
    authenticated: z.boolean().optional(),
    festivalPublishable: z.boolean().optional(),
    minimumPriceTenThousandths:
      publisherNonnegativeMoneyAmountSchema.optional(),
    maximumPriceTenThousandths:
      publisherNonnegativeMoneyAmountSchema.optional(),
    sort: publisherMediaSortSchema.default("recommended"),
    page: z.number().int().min(1).max(100_000).optional(),
    pageSize: z.number().int().min(1).max(100).optional(),
    cursor: z.string().max(256).optional(),
    limit: z.number().int().min(1).max(100).default(20),
  })
  .superRefine((value, context) => {
    if (
      value.includeInactive === true &&
      !value.query &&
      !value.batchQuery?.length
    ) {
      context.addIssue({
        code: "custom",
        path: ["includeInactive"],
        message: "Inactive media can only be included in an explicit search",
      });
    }
    if (
      value.minimumPriceTenThousandths !== undefined &&
      value.maximumPriceTenThousandths !== undefined &&
      BigInt(value.minimumPriceTenThousandths) >
        BigInt(value.maximumPriceTenThousandths)
    ) {
      context.addIssue({
        code: "custom",
        path: ["maximumPriceTenThousandths"],
        message: "Maximum price must not be lower than minimum price",
      });
    }
  });

const publisherMediaLogoPathSchema = z
  .string()
  .regex(
    /^\/api\/monitoring\/publisher\/media-logos\/[0-9a-f-]{36}\/[a-f0-9]{64}$/u,
  );

export const publisherMediaOutputSchema = z.object({
  id: idSchema,
  externalResourceId: z.string().min(1).max(128),
  catalogRevision: z.string().min(1).max(64),
  name: z.string(),
  kind: publisherMediaKindSchema,
  platform: z.string().nullable(),
  taxonomy: z.string().nullable(),
  mediaType: z.string().nullable(),
  area: z.string().nullable(),
  titleLimit: z.number().int().positive().nullable(),
  priceTenThousandths: publisherNonnegativeMoneyAmountSchema,
  successRateBasisPoints: z.number().int().min(0).max(10_000).nullable(),
  includeRateBasisPoints: z.number().int().min(0).max(10_000).nullable(),
  pcWeight: z.number().int().nonnegative().nullable(),
  mobileWeight: z.number().int().nonnegative().nullable(),
  includeType: z.string().nullable(),
  publishSpeed: z.string().nullable(),
  entryType: z.string().nullable(),
  entryUrl: z.string().nullable(),
  entryLevel: z.string().nullable(),
  linkType: z.string().nullable(),
  caseUrl: z.string().url().nullable(),
  logoUrl: publisherMediaLogoPathSchema.nullable(),
  logoSource: publisherMediaLogoSourceSchema,
  logoResolutionStatus: publisherMediaLogoResolutionStatusSchema,
  remark: z.string().nullable(),
  description: z.string().nullable(),
  recommended: z.boolean().nullable(),
  recommendationTags: z.array(z.string().max(120)).max(30).default([]),
  platformRecommendationTags: z.array(z.string().max(120)).max(30).default([]),
  recommendationRemark: z.string().nullable().default(null),
  authenticationType: z.string().nullable().default(null),
  authenticationDescription: z.string().nullable().default(null),
  authenticated: z.boolean().nullable(),
  festivalPublishable: z.boolean().nullable(),
  fanCount: publisherNonnegativeMoneyAmountSchema.nullable(),
  likeCount: publisherNonnegativeMoneyAmountSchema.nullable(),
  publishCount: publisherNonnegativeMoneyAmountSchema.nullable(),
  imageSupport: publisherImageSupportSchema,
  isActive: z.boolean(),
  updatedAt: z.coerce.date(),
});

export const publisherMediaListOutputSchema = z.object({
  items: z.array(publisherMediaOutputSchema),
  nextCursor: z.string().nullable(),
  total: z.number().int().nonnegative(),
  page: z.number().int().positive(),
  pageSize: z.number().int().positive().max(100),
  catalogRevision: z.string().nullable(),
  catalogSyncedAt: z.coerce.date().nullable(),
  catalogStale: z.boolean(),
  kindComplete: z.boolean(),
});

export const publisherMediaFacetOptionSchema = z.object({
  value: z.string(),
  count: z.number().int().nonnegative(),
});

export const publisherMediaFacetsInputSchema =
  publisherMediaListInputSchema.optional();

export const publisherMediaFacetsOutputSchema = z.object({
  kindCounts: z.object({
    news: z.number().int().nonnegative(),
    selfMedia: z.number().int().nonnegative(),
  }),
  platforms: z.array(publisherMediaFacetOptionSchema),
  taxonomies: z.array(publisherMediaFacetOptionSchema),
  mediaTypes: z.array(publisherMediaFacetOptionSchema),
  areas: z.array(publisherMediaFacetOptionSchema),
  includeTypes: z.array(publisherMediaFacetOptionSchema),
  publishSpeeds: z.array(publisherMediaFacetOptionSchema),
  entryTypes: z.array(publisherMediaFacetOptionSchema),
  entryLevels: z.array(publisherMediaFacetOptionSchema),
  linkTypes: z.array(publisherMediaFacetOptionSchema),
  imageSupports: z.array(publisherMediaFacetOptionSchema),
  pcWeightThresholds: z.array(publisherMediaFacetOptionSchema),
  includeRateThresholds: z.array(publisherMediaFacetOptionSchema),
  successRateThresholds: z.array(publisherMediaFacetOptionSchema),
  recommendedOptions: z.array(publisherMediaFacetOptionSchema),
  authenticatedOptions: z.array(publisherMediaFacetOptionSchema),
  festivalPublishableOptions: z.array(publisherMediaFacetOptionSchema),
  minimumPriceTenThousandths: publisherNonnegativeMoneyAmountSchema.nullable(),
  maximumPriceTenThousandths: publisherNonnegativeMoneyAmountSchema.nullable(),
  catalogRevision: z.string().nullable(),
  catalogSyncedAt: z.coerce.date().nullable(),
  kindComplete: z.boolean(),
});

export const publisherDraftItemInputSchema = z.object({
  mediaResourceId: idSchema,
  submissionTitle: publisherOptionalSubmissionTitleSchema.optional(),
});

export const publisherSaveDraftInputSchema = z
  .object({
    draftId: idSchema.optional(),
    idempotencyKey: idempotencyKeySchema.optional(),
    articleVersionId: idSchema,
    expectedRevision: z.number().int().nonnegative(),
    titleMode: publisherTitleModeSchema.optional(),
    sharedTitle: publisherOptionalSubmissionTitleSchema.nullable().optional(),
    items: z.array(publisherDraftItemInputSchema).max(20),
  })
  .superRefine((value, context) => {
    const mediaIds = value.items.map((item) => item.mediaResourceId);
    if (new Set(mediaIds).size !== mediaIds.length) {
      context.addIssue({
        code: "custom",
        path: ["items"],
        message: "Each media resource may be selected only once",
      });
    }
  });

export const publisherDraftItemOutputSchema = z.object({
  id: idSchema,
  mediaResource: publisherMediaOutputSchema.extend({
    kind: publisherHistoricalMediaKindSchema,
  }),
  submissionTitle: z.string(),
  selectedPriceTenThousandths: publisherNonnegativeMoneyAmountSchema,
  selectedCatalogRevision: z.string(),
});

export const publisherSaveDraftTitlesInputSchema = z
  .object({
    draftId: idSchema,
    expectedRevision: z.number().int().nonnegative(),
    titleMode: publisherTitleModeSchema,
    sharedTitle: publisherOptionalSubmissionTitleSchema.nullable().optional(),
    titles: z
      .array(
        z.object({
          mediaResourceId: idSchema,
          submissionTitle: publisherRequiredSubmissionTitleSchema,
        }),
      )
      .max(20)
      .optional(),
  })
  .superRefine((value, context) => {
    if (value.titleMode === "single" && !value.sharedTitle?.trim()) {
      context.addIssue({
        code: "custom",
        path: ["sharedTitle"],
        message: "Single-title mode requires a shared title",
      });
    }
    if (value.titleMode === "per_media" && !value.titles?.length) {
      context.addIssue({
        code: "custom",
        path: ["titles"],
        message: "Per-media mode requires titles",
      });
    }
    const ids = value.titles?.map((item) => item.mediaResourceId) ?? [];
    if (new Set(ids).size !== ids.length) {
      context.addIssue({
        code: "custom",
        path: ["titles"],
        message: "Each media resource may have only one title",
      });
    }
  });

export const publisherRefreshDraftMediaInputSchema = z.object({
  draftId: idSchema,
  expectedRevision: z.number().int().nonnegative(),
});

export const publisherDraftOutputSchema = z.object({
  id: idSchema,
  articleVersionId: idSchema,
  status: publisherDraftStatusSchema,
  revision: z.number().int().nonnegative(),
  titleMode: publisherTitleModeSchema,
  sharedTitle: z.string().nullable(),
  items: z.array(publisherDraftItemOutputSchema).max(20),
  updatedAt: z.coerce.date(),
  createdAt: z.coerce.date(),
});

export const publisherPreflightInputSchema = z.object({
  draftId: idSchema,
  expectedDraftRevision: z.number().int().nonnegative(),
});

export const publisherPreflightItemOutputSchema = z.object({
  draftItemId: idSchema,
  mediaResourceId: idSchema,
  mediaName: z.string(),
  mediaKind: publisherMediaKindSchema,
  submissionTitle: z.string(),
  priceTenThousandths: publisherNonnegativeMoneyAmountSchema,
  imageSupport: publisherImageSupportSchema,
  warnings: z.array(publisherIssueSchema),
  blockers: z.array(publisherIssueSchema),
});

export const publisherPreflightOutputSchema = z.object({
  preflightRevision: z.string().min(1).max(128),
  quoteFingerprint: z.string().regex(/^[a-f0-9]{64}$/u),
  mode: publicationModeSchema,
  articleVersionId: idSchema,
  articleWorkingName: z.string(),
  articleSuggestedTitle: z.string().nullable(),
  articleVersion: z.number().int().positive(),
  articleContentHash: z.string().regex(/^[a-f0-9]{64}$/u),
  articleCanonicalHtml: z.string(),
  articlePlainText: z.string(),
  titleMode: publisherTitleModeSchema,
  catalogRevision: z.string().min(1).max(64),
  items: z.array(publisherPreflightItemOutputSchema).min(1).max(20),
  warnings: z.array(publisherIssueSchema),
  blockers: z.array(publisherIssueSchema),
  totalTenThousandths: publisherNonnegativeMoneyAmountSchema,
  kindCounts: z.object({
    news: z.number().int().nonnegative(),
    selfMedia: z.number().int().nonnegative(),
  }),
  availableTenThousandths: moneyAmountSchema,
  availableAfterReservationTenThousandths: moneyAmountSchema,
  sufficientFunds: z.boolean(),
  requiresLiveConfirmation: z.boolean(),
  expiresAt: z.coerce.date(),
});

export const publisherSubmitInputSchema = z.object({
  draftId: idSchema,
  expectedDraftRevision: z.number().int().nonnegative(),
  preflightRevision: z.string().min(1).max(128),
  quoteFingerprint: z.string().regex(/^[a-f0-9]{64}$/u),
  idempotencyKey: idempotencyKeySchema,
  liveConfirmationAccepted: z.literal(true).optional(),
});

export const publisherSubmitOutputSchema = z.object({
  batchId: idSchema,
  status: publisherBatchStatusSchema,
  fundsStatus: publisherFundsStatusSchema,
  mode: publicationModeSchema,
  totalTenThousandths: publisherNonnegativeMoneyAmountSchema,
  createdAt: z.coerce.date(),
});

export const publisherBatchListInputSchema = z.object({
  query: z.string().trim().max(120).optional(),
  kind: publisherMediaKindSchema.optional(),
  status: publisherBatchStatusSchema.optional(),
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
  page: z.number().int().min(1).max(100_000).optional(),
  pageSize: z.number().int().min(1).max(100).optional(),
  cursor: z.string().max(256).optional(),
  limit: z.number().int().min(1).max(100).default(20),
});

export const publisherPublicationItemOutputSchema = z.object({
  id: idSchema,
  mediaName: z.string(),
  mediaKind: publisherHistoricalMediaKindSchema,
  platform: z.string().nullable(),
  taxonomy: z.string().nullable(),
  area: z.string().nullable(),
  logoUrl: publisherMediaLogoPathSchema.nullable().optional(),
  logoSource: publisherMediaLogoSourceSchema.optional(),
  logoResolutionStatus: publisherMediaLogoResolutionStatusSchema.optional(),
  submissionTitle: z.string(),
  status: publisherItemStatusSchema,
  fundsStatus: publisherFundsStatusSchema,
  priceTenThousandths: publisherNonnegativeMoneyAmountSchema,
  publishedUrl: z.string().url().nullable(),
  failureReason: z.string().nullable(),
  actionRequiredReason: z.string().nullable(),
  submissionAttempts: z.array(z.object({ id: idSchema, number: z.number().int().positive(), startedAt: z.coerce.date(), completedAt: z.coerce.date().nullable(), result: z.enum(["succeeded", "business_rejected", "auth_blocked", "submission_unknown"]).nullable() })).optional(),
  submittedAt: z.coerce.date().nullable(),
  completedAt: z.coerce.date().nullable(),
});

export const publisherBatchOutputSchema = z.object({
  id: idSchema,
  draftId: idSchema,
  articleVersionId: idSchema,
  status: publisherBatchStatusSchema,
  mode: publicationModeSchema,
  fundsStatus: publisherFundsStatusSchema,
  quotedTotalTenThousandths: publisherNonnegativeMoneyAmountSchema,
  titleMode: publisherTitleModeSchema,
  article: z.object({
    workingName: z.string(),
    suggestedTitle: z.string().nullable(),
    version: z.number().int().positive(),
    contentHash: z.string().regex(/^[a-f0-9]{64}$/u),
  }),
  kindCounts: z.object({
    news: z.number().int().nonnegative(),
    selfMedia: z.number().int().nonnegative(),
    unknown: z.number().int().nonnegative(),
  }),
  itemCount: z.number().int().nonnegative(),
  successCount: z.number().int().nonnegative(),
  failedCount: z.number().int().nonnegative(),
  unknownCount: z.number().int().nonnegative(),
  consumedTenThousandths: publisherNonnegativeMoneyAmountSchema,
  releasedTenThousandths: publisherNonnegativeMoneyAmountSchema,
  frozenTenThousandths: publisherNonnegativeMoneyAmountSchema,
  reservedTenThousandths: publisherNonnegativeMoneyAmountSchema,
  items: z.array(publisherPublicationItemOutputSchema).max(20),
  completedAt: z.coerce.date().nullable(),
  createdAt: z.coerce.date(),
  updatedAt: z.coerce.date(),
});

export const publisherBatchListOutputSchema = z.object({
  items: z.array(publisherBatchOutputSchema.omit({ items: true })),
  nextCursor: z.string().nullable(),
  total: z.number().int().nonnegative(),
  page: z.number().int().positive(),
  pageSize: z.number().int().positive().max(100),
});
export const publisherBatchInputSchema = z.object({ batchId: idSchema });
export const publisherDraftInputSchema = z.object({ draftId: idSchema });

export const publisherDashboardOutputSchema = z.object({
  catalogCounts: z.object({
    news: z.number().int().nonnegative(),
    selfMedia: z.number().int().nonnegative(),
  }),
  articleCount: z.number().int().nonnegative(),
  resumableArticles: z.array(publisherArticleSummaryOutputSchema).max(3),
  processingBatchCount: z.number().int().nonnegative(),
  processingBatches: z
    .array(publisherBatchOutputSchema.omit({ items: true }))
    .max(3),
  catalogRevision: z.string().nullable(),
  catalogSyncedAt: z.coerce.date().nullable(),
  catalogStale: z.boolean(),
  kindComplete: z.boolean(),
  wallet: z.object({
    availableTenThousandths: moneyAmountSchema,
    reservedTenThousandths: publisherNonnegativeMoneyAmountSchema,
    frozenTenThousandths: publisherNonnegativeMoneyAmountSchema,
  }),
  resumableDraftCount: z.number().int().nonnegative(),
  resumableDrafts: z
    .array(
      z.object({
        id: idSchema,
        articleTitle: z.string().trim().min(1).max(200),
        articleVersion: z.number().int().positive(),
        status: z.enum(["draft", "ready"]),
        updatedAt: z.coerce.date(),
      }),
    )
    .max(3)
    .optional(),
  actionRequiredCount: z.number().int().nonnegative(),
  recentBatches: z.array(publisherBatchOutputSchema.omit({ items: true })),
});

export const mediaPublishingBillingSummaryOutputSchema = z.object({
  userId: idSchema,
  walletScope: z.literal("media_publishing"),
  currency: currencySchema,
  scale: moneyScaleSchema,
  balanceTenThousandths: moneyAmountSchema,
  reservedTenThousandths: publisherNonnegativeMoneyAmountSchema,
  frozenTenThousandths: publisherNonnegativeMoneyAmountSchema,
  spentTenThousandths: publisherNonnegativeMoneyAmountSchema,
  availableTenThousandths: moneyAmountSchema,
});

export const mediaPublishingLedgerEntryTypeSchema = z.enum([
  "topup",
  "admin_adjustment",
  "reserve",
  "freeze",
  "consume",
  "release",
]);

export const mediaPublishingLedgerEntryOutputSchema = z.object({
  id: idSchema,
  type: mediaPublishingLedgerEntryTypeSchema,
  balanceDeltaTenThousandths: moneyAmountSchema,
  reservedDeltaTenThousandths: moneyAmountSchema,
  frozenDeltaTenThousandths: moneyAmountSchema,
  balanceAfterTenThousandths: moneyAmountSchema,
  reservedAfterTenThousandths: publisherNonnegativeMoneyAmountSchema,
  frozenAfterTenThousandths: publisherNonnegativeMoneyAmountSchema,
  reason: z.string(),
  referenceType: z.string().nullable(),
  referenceId: z.string().nullable(),
  createdAt: z.coerce.date(),
});

export const mediaPublishingCreateTopupOrderInputSchema = z.object({
  walletScope: z.literal("media_publishing"),
  paymentMethod: topupPaymentMethodSchema,
  amountTenThousandths: publisherPositiveFenCompatibleMoneyAmountSchema,
  idempotencyKey: idempotencyKeySchema,
});

export const mediaPublishingTopupOrderOutputSchema = z.object({
  id: idSchema,
  providerOrderId: z.string(),
  walletScope: z.literal("media_publishing"),
  paymentMethod: topupPaymentMethodSchema,
  amountTenThousandths: publisherPositiveFenCompatibleMoneyAmountSchema,
  currency: currencySchema,
  scale: moneyScaleSchema,
  state: topupOrderStateSchema,
  checkoutExpiresAt: z.coerce.date(),
  paidAt: z.coerce.date().nullable(),
  creditedAt: z.coerce.date().nullable(),
  createdAt: z.coerce.date(),
});

export const mediaPublishingCreateTopupOrderOutputSchema = z.object({
  order: mediaPublishingTopupOrderOutputSchema,
  checkout: topupCheckoutOutputSchema.nullable(),
});

export const mediaPublishingTopupStatusInputSchema = z.object({
  orderId: idSchema,
});
export const mediaPublishingTopupListInputSchema = z.object({
  limit: z.number().int().min(1).max(100).default(100),
});
export const mediaPublishingTopupListOutputSchema = z.object({
  items: z.array(mediaPublishingTopupOrderOutputSchema),
});
export const mediaPublishingTopupStatusOutputSchema = z.object({
  order: mediaPublishingTopupOrderOutputSchema,
  reconciliation: z.enum([
    "not_applicable",
    "unavailable",
    "pending",
    "credited",
    "review_required",
  ]),
});

export const mediaPublishingSwitchTopupPaymentMethodInputSchema = z.object({
  orderId: idSchema,
  expectedPaymentMethod: topupPaymentMethodSchema,
  paymentMethod: topupPaymentMethodSchema,
});

export const mediaPublishingSubmitBankTransferReviewInputSchema = z.object({
  orderId: idSchema,
  payerName: z.string().trim().min(2).max(120),
  transferredAt: z.coerce.date(),
  remittanceReference: z.string().trim().min(3).max(191),
  evidenceObjectKey: z.string().trim().min(1).max(1_024).optional(),
});

export const mediaPublishingBankTransferReviewOutputSchema = z.object({
  id: idSchema,
  orderId: idSchema,
  status: z.enum(["pending", "approved", "rejected"]),
  payerName: z.string(),
  transferredAt: z.coerce.date(),
  remittanceReference: z.string(),
  evidenceSubmitted: z.boolean().optional(),
  submittedAt: z.coerce.date(),
  reviewedBy: idSchema.nullable().optional(),
  reviewReason: z.string().nullable().optional(),
  reviewedAt: z.coerce.date().nullable().optional(),
});

export const mediaPublishingAdminBankReviewInputSchema = z.object({
  reviewId: idSchema,
  decision: z.enum(["approve", "reject"]),
  reason: z.string().trim().min(3).max(240),
  providerTradeNo: z.string().trim().min(3).max(191).optional(),
});

export const mediaPublishingAdminBankReviewOutputSchema = z.object({
  review: mediaPublishingBankTransferReviewOutputSchema,
  order: mediaPublishingTopupOrderOutputSchema,
  username: z.string(),
});

export const mediaPublishingAdminAdjustmentInputSchema = z.object({
  userId: idSchema,
  publicationItemId: idSchema,
  walletScope: z.literal("media_publishing"),
  amountTenThousandths: publisherNonnegativeMoneyAmountSchema.refine(
    (value) => BigInt(value) > 0n,
    "Customer compensation must be positive",
  ),
  reason: z.string().trim().min(3).max(240),
  idempotencyKey: idempotencyKeySchema,
});

export const mediaPublishingAdminUserOutputSchema = z
  .object({
    id: idSchema,
    username: z.string(),
    role: z.enum(["user", "admin"]),
    status: z.enum(["active", "disabled"]),
    lastLoginAt: z.coerce.date().nullable(),
    createdAt: z.coerce.date(),
    walletScope: z.literal("media_publishing"),
    currency: currencySchema,
    scale: moneyScaleSchema,
    balanceTenThousandths: moneyAmountSchema,
    reservedTenThousandths: publisherNonnegativeMoneyAmountSchema,
    frozenTenThousandths: publisherNonnegativeMoneyAmountSchema,
    spentTenThousandths: publisherNonnegativeMoneyAmountSchema,
    availableTenThousandths: moneyAmountSchema,
  })
  .strict();

export const publisherAdminRuntimeUpdateInputSchema = z
  .object({
    mode: publicationModeSchema.optional(),
    featureEnabled: z.boolean().optional(),
    publishEnabled: z.boolean().optional(),
    imagePublishEnabled: z.boolean().optional(),
    webhookEnabled: z.boolean().optional(),
    emergencyStop: z.boolean().optional(),
  })
  .refine(
    (value) => Object.keys(value).length > 0,
    "At least one runtime field is required",
  );

export const publisherAdminUnknownBindInputSchema = z.object({
  itemId: idSchema,
  candidateId: idSchema,
  reason: z.string().trim().min(3).max(240),
});

export const publisherAdminUnknownResubmitInputSchema = z.object({
  itemId: idSchema,
  reason: z.string().trim().min(3).max(240),
});

export const publisherAdminEmergencyStopInputSchema = z.object({
  enabled: z.boolean(),
  reason: z.string().trim().min(3).max(240),
});

export const publisherAdminMediaCapabilityInputSchema = z
  .object({
    mediaResourceId: idSchema,
    imageSupport: publisherImageSupportSchema,
    contentProfile: z.string().trim().min(1).max(64),
    evidenceUrl: z
      .string()
      .url()
      .refine((value) => {
        const url = new URL(value);
        return url.protocol === "https:" && !url.username && !url.password;
      }, "Capability evidence must use HTTPS without embedded credentials")
      .nullable()
      .optional(),
    notes: z.string().trim().max(2_000).nullable().optional(),
  })
  .superRefine((value, context) => {
    if (value.imageSupport === "verified" && !value.evidenceUrl) {
      context.addIssue({
        code: "custom",
        path: ["evidenceUrl"],
        message: "Verified image capability requires HTTPS evidence",
      });
    }
  });

export const publisherAdminLiveWhitelistInputSchema = z.object({
  mediaResourceId: idSchema,
  enabled: z.boolean(),
  imageAllowed: z.boolean(),
  reason: z.string().trim().min(3).max(240),
});

export const publisherRuntimeOutputSchema = z.object({
  mode: publicationModeSchema,
  environmentEnabled: z.boolean(),
  environmentRealEnabled: z.boolean(),
  environmentPublishEnabled: z.boolean(),
  environmentImageEnabled: z.boolean(),
  environmentPublicAssetsEnabled: z.boolean(),
  environmentWebhookEnabled: z.boolean(),
  databaseFeatureEnabled: z.boolean(),
  featureEnabled: z.boolean(),
  publishEnabled: z.boolean(),
  imagePublishEnabled: z.boolean(),
  webhookEnabled: z.boolean(),
  emergencyStop: z.boolean(),
  credentialStatus: z.enum([
    "unconfigured",
    "healthy",
    "auth_blocked",
    "unknown",
  ]),
  credentialVerifiedAt: z.coerce.date().nullable(),
  credentialFailedAt: z.coerce.date().nullable(),
  catalogRevision: z.string().nullable(),
  catalogSyncedAt: z.coerce.date().nullable(),
});

export const publisherAdminCatalogRunOutputSchema = z.object({
  id: idSchema,
  catalogRevision: z.string().min(1).max(64),
  status: publisherMediaSyncStatusSchema,
  startedAt: z.coerce.date(),
  completedAt: z.coerce.date().nullable(),
  pagesFetched: z.number().int().nonnegative(),
  pagesExpected: z.number().int().nonnegative(),
  recordsSeen: z.number().int().nonnegative(),
  newsRecords: z.number().int().nonnegative(),
  selfMediaRecords: z.number().int().nonnegative(),
  invalidRecords: z.number().int().nonnegative(),
  duplicateRecords: z.number().int().nonnegative(),
  crossKindDuplicateRecords: z.number().int().nonnegative(),
  recordsChanged: z.number().int().nonnegative(),
  logoPending: z.number().int().nonnegative(),
  logoArchived: z.number().int().nonnegative(),
  logoFailed: z.number().int().nonnegative(),
  logoProviderArchived: z.number().int().nonnegative(),
  logoIconArchived: z.number().int().nonnegative(),
  logoSiteFaviconArchived: z.number().int().nonnegative(),
  logoWebSearchVerifiedArchived: z.number().int().nonnegative(),
  logoManualVerifiedArchived: z.number().int().nonnegative(),
  logoPendingReview: z.number().int().nonnegative(),
  logoGeneratedFallback: z.number().int().nonnegative(),
  logoMissing: z.number().int().nonnegative(),
  logoRealMissing: z.number().int().nonnegative(),
  logoRealCoverageBasisPoints: z.number().int().min(0).max(10_000),
  stopReason: z.string().nullable(),
  isComplete: z.boolean(),
});

export const publisherAdminCatalogSyncRequestOutputSchema = z.object({
  queued: z.literal(true),
  syncRunId: idSchema,
});

export const publisherAdminCapabilityOutputSchema = z.object({
  mediaResourceId: idSchema,
  externalResourceId: z.string().min(1).max(128),
  mediaName: z.string().min(1).max(255),
  priceTenThousandths: publisherNonnegativeMoneyAmountSchema,
  liveWhitelisted: z.boolean(),
  liveImageAllowed: z.boolean(),
  imageSupport: publisherImageSupportSchema,
  contentProfile: z.string().min(1).max(64),
  evidenceUrl: z.string().url().nullable(),
  verifiedAt: z.coerce.date().nullable(),
  verifiedBy: idSchema.nullable(),
  notes: z.string().nullable(),
  updatedAt: z.coerce.date().nullable(),
});

export const publisherAdminReconciliationCandidateOutputSchema = z.object({
  id: idSchema,
  itemId: idSchema,
  externalOrderId: z.string().min(1).max(191),
  confidenceBasisPoints: z.number().int().min(0).max(10_000),
  evidence: z.record(z.string(), z.unknown()),
  boundAt: z.coerce.date().nullable(),
  rejectedAt: z.coerce.date().nullable(),
  createdAt: z.coerce.date(),
});

export const publisherAdminUnknownItemOutputSchema = z.object({
  itemId: idSchema,
  batchId: idSchema,
  ownerUsername: z.string().min(1),
  mediaName: z.string().min(1).max(255),
  submissionTitle: z.string().min(1).max(200),
  status: z.enum(["submission_unknown", "action_required"]),
  fundsStatus: publisherFundsStatusSchema,
  priceTenThousandths: publisherNonnegativeMoneyAmountSchema,
  actionRequiredReason: z.string().nullable(),
  updatedAt: z.coerce.date(),
  candidates: z.array(publisherAdminReconciliationCandidateOutputSchema),
});

export type WalletScope = z.infer<typeof walletScopeSchema>;
export type PublicationMode = z.infer<typeof publicationModeSchema>;
export type PublisherArticleStatus = z.infer<
  typeof publisherArticleStatusSchema
>;
export type PublisherImportStatus = z.infer<typeof publisherImportStatusSchema>;
export type PublisherImageSupport = z.infer<typeof publisherImageSupportSchema>;
export type PublisherMediaKind = z.infer<typeof publisherMediaKindSchema>;
export type PublisherHistoricalMediaKind = z.infer<
  typeof publisherHistoricalMediaKindSchema
>;
export type PublisherTitleMode = z.infer<typeof publisherTitleModeSchema>;
export type PublisherMediaSort = z.infer<typeof publisherMediaSortSchema>;
export type PublisherDraftStatus = z.infer<typeof publisherDraftStatusSchema>;
export type PublisherBatchStatus = z.infer<typeof publisherBatchStatusSchema>;
export type PublisherItemStatus = z.infer<typeof publisherItemStatusSchema>;
export type PublisherFundsStatus = z.infer<typeof publisherFundsStatusSchema>;
export type PublisherJobType = z.infer<typeof publisherJobTypeSchema>;
export type PublisherJobStatus = z.infer<typeof publisherJobStatusSchema>;
export type PublisherMediaListInput = z.infer<
  typeof publisherMediaListInputSchema
>;
export type PublisherSaveDraftInput = z.infer<
  typeof publisherSaveDraftInputSchema
>;
export type PublisherSaveDraftTitlesInput = z.infer<
  typeof publisherSaveDraftTitlesInputSchema
>;
export type PublisherRefreshDraftMediaInput = z.infer<
  typeof publisherRefreshDraftMediaInputSchema
>;
export type PublisherPreflightInput = z.infer<
  typeof publisherPreflightInputSchema
>;
export type PublisherPreflightOutput = z.infer<
  typeof publisherPreflightOutputSchema
>;
export type PublisherSubmitInput = z.infer<typeof publisherSubmitInputSchema>;
export type PublisherSubmitOutput = z.infer<typeof publisherSubmitOutputSchema>;
export type PublisherBatchOutput = z.infer<typeof publisherBatchOutputSchema>;
export type PublisherBatchListInput = z.infer<
  typeof publisherBatchListInputSchema
>;
export type MediaPublishingBillingSummaryOutput = z.infer<
  typeof mediaPublishingBillingSummaryOutputSchema
>;
export type MediaPublishingCreateTopupOrderInput = z.infer<
  typeof mediaPublishingCreateTopupOrderInputSchema
>;
export type MediaPublishingTopupOrderOutput = z.infer<
  typeof mediaPublishingTopupOrderOutputSchema
>;
export type PublisherAdminRuntimeUpdateInput = z.infer<
  typeof publisherAdminRuntimeUpdateInputSchema
>;
