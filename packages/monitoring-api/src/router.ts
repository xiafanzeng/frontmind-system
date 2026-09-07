import { accountActivityInputSchema, accountActivityOutputSchema } from "@frontmind/monitoring-contracts";
import {
  adminBankTransferOutputSchema,
  adminBillingAdjustmentInputSchema,
  adminBillingUserOutputSchema,
  adminAuditOutputSchema,
  adminCreateUserInputSchema,
  adminOperationDetailOutputSchema,
  adminOperationsListInputSchema,
  adminOperationsListOutputSchema,
  adminOverviewOutputSchema,
  adminProviderCostOutputSchema,
  adminResetPasswordInputSchema,
  adminRunListOutputSchema,
  adminSetUserStatusInputSchema,
  adminUserListOutputSchema,
  adminUserViewSchema,
  authMeOutputSchema,
  auditListInputSchema,
  approveBankTransferInputSchema,
  bankTransferReviewOutputSchema,
  booleanResultOutputSchemas,
  billingLedgerEntryOutputSchema,
  billingMonitorQuoteInputSchema,
  billingMonitorQuoteOutputSchema,
  billingQuoteInputSchema,
  billingQuoteOutputSchema,
  billingSummaryOutputSchema,
  changePasswordInputSchema,
  createTopupOrderInputSchema,
  createTopupOrderOutputSchema,
  deletedMonitorOutputSchema,
  deletedProjectOutputSchema,
  deletedRunOutputSchema,
  idSchema,
  listInputSchema,
  mediaPublishingAdminAdjustmentInputSchema,
  mediaPublishingAdminBankReviewInputSchema,
  mediaPublishingAdminBankReviewOutputSchema,
  mediaPublishingAdminUserOutputSchema,
  mediaPublishingBankTransferReviewOutputSchema,
  mediaPublishingBillingSummaryOutputSchema,
  mediaPublishingCreateTopupOrderInputSchema,
  mediaPublishingCreateTopupOrderOutputSchema,
  mediaPublishingLedgerEntryOutputSchema,
  mediaPublishingSubmitBankTransferReviewInputSchema,
  mediaPublishingSwitchTopupPaymentMethodInputSchema,
  mediaPublishingTopupListInputSchema,
  mediaPublishingTopupListOutputSchema,
  mediaPublishingTopupOrderOutputSchema,
  mediaPublishingTopupStatusInputSchema,
  mediaPublishingTopupStatusOutputSchema,
  monitoringAnalysisInputSchema,
  monitoringAnalysisOutputSchema,
  monitoringAnswerDetailOutputSchema,
  monitoringAnswerGetInputSchema,
  monitoringAnswersListInputSchema,
  monitoringAnswersListOutputSchema,
  monitoringScopeSchema,
  monitoringSummaryOutputSchema,
  monitorCreateInputSchema,
  monitorDetailOutputSchema,
  monitorListOutputSchema,
  monitorMutationOutputSchema,
  monitorUpdateInputSchema,
  paymentMethodsOutputSchema,
  platformAcceptanceBatchOutputSchema,
  platformAcceptanceGetInputSchema,
  platformAcceptanceListInputSchema,
  platformAcceptancePlanInputSchema,
  platformAcceptancePlanOutputSchema,
  platformAcceptanceStartInputSchema,
  platformCapabilityInputSchema,
  platformOutputSchema,
  pricingOutputSchema,
  projectBrandUpdateInputSchema,
  projectCreateInputSchema,
  projectOutputSchema,
  projectUpdateInputSchema,
  publisherAdminEmergencyStopInputSchema,
  publisherAdminCapabilityOutputSchema,
  publisherAdminCatalogRunOutputSchema,
  publisherAdminCatalogSyncRequestOutputSchema,
  publisherAdminLiveWhitelistInputSchema,
  publisherAdminMediaCapabilityInputSchema,
  publisherAdminReconciliationCandidateOutputSchema,
  publisherAdminRuntimeUpdateInputSchema,
  publisherAdminUnknownItemOutputSchema,
  publisherAdminUnknownBindInputSchema,
  publisherAdminUnknownResubmitInputSchema,
  publisherArticleAssetOutputSchema,
  publisherArticleAssetsInputSchema,
  publisherArticleListInputSchema,
  publisherArticleListOutputSchema,
  publisherArticleOutputSchema,
  publisherArticleVersionOutputSchema,
  publisherBatchInputSchema,
  publisherBatchListInputSchema,
  publisherBatchListOutputSchema,
  publisherBatchOutputSchema,
  publisherCreateArticleInputSchema,
  publisherDashboardOutputSchema,
  publisherDocxImportOutputSchema,
  publisherDraftInputSchema,
  publisherDraftOutputSchema,
  publisherFreezeArticleInputSchema,
  publisherImportListInputSchema,
  publisherImportListOutputSchema,
  publisherImportStatusInputSchema,
  publisherMediaListInputSchema,
  publisherMediaListOutputSchema,
  publisherMediaFacetsInputSchema,
  publisherMediaFacetsOutputSchema,
  publisherPreflightInputSchema,
  publisherPreflightOutputSchema,
  publisherRefreshDraftMediaInputSchema,
  publisherRuntimeOutputSchema,
  publisherSaveArticleInputSchema,
  publisherSaveDraftInputSchema,
  publisherSaveDraftTitlesInputSchema,
  publisherSubmitInputSchema,
  publisherSubmitOutputSchema,
  rejectBankTransferInputSchema,
  regionOutputSchema,
  runCreationResultOutputSchema,
  runDetailOutputSchema,
  runListOutputSchema,
  runNowInputSchema,
  runRecordOutputSchema,
  submitBankTransferReviewInputSchema,
  submitBankTransferReviewOutputSchema,
  switchTopupPaymentMethodInputSchema,
  switchTopupPaymentMethodOutputSchema,
  topupOrderOutputSchema,
  topupStatusInputSchema,
  topupStatusOutputSchema,
} from "@frontmind/monitoring-contracts";
import { RepositoryError, type PublishingRepository } from "@frontmind/monitoring-db";
import {
  PaymentError,
  paymentMethodStateForAuthenticatedUser,
  type BankTransferReviewRecord,
  type PaymentMethod,
} from "@frontmind/monitoring-payment";
import {
  canonicalizePublisherHtml,
  publisherCanonicalImageReferences,
} from "@frontmind/monitoring-publisher";
import { initTRPC, TRPCError } from "@trpc/server";
import { z } from "zod";
import type { ApiContext } from "./context.js";
import {
  TOPUP_CHECKOUT_TTL_MS,
  createBankTransferService,
  createCheckoutForOrder,
  createZpaySettlementService,
  isPaymentMethodConfigured,
  newTopupIdentity,
} from "./payment.js";
import { derivePublisherAssetCapability } from "./publisher-service.js";

const t = initTRPC.context<ApiContext>().create();

const requireUser = t.middleware(({ ctx, next }) => {
  if (!ctx.user)
    throw new TRPCError({
      code: "UNAUTHORIZED",
      message: "Authentication required",
    });
  return next({ ctx: { ...ctx, user: ctx.user } });
});

const requireCustomer = t.middleware(({ ctx, next }) => {
  if (!ctx.user)
    throw new TRPCError({
      code: "UNAUTHORIZED",
      message: "Authentication required",
    });
  return next({ ctx: { ...ctx, user: ctx.user } });
});

const requireAdmin = t.middleware(({ ctx, next }) => {
  if (!ctx.user)
    throw new TRPCError({
      code: "UNAUTHORIZED",
      message: "Authentication required",
    });
  if (ctx.user.role !== "admin")
    throw new TRPCError({
      code: "FORBIDDEN",
      message: "Administrator role required",
    });
  return next({ ctx: { ...ctx, user: ctx.user } });
});

const requirePublisherCustomer = t.middleware(async ({ ctx, next }) => {
  if (!ctx.user) {
    throw new TRPCError({
      code: "UNAUTHORIZED",
      message: "Authentication required",
    });
  }
  const publishingRepository = ctx.publishingRepository;
  if (!ctx.config.PUBLISHER_FEATURE_ENABLED || !publishingRepository) {
    throw new TRPCError({
      code: "NOT_FOUND",
      message: "Media publishing is not enabled",
    });
  }
  const runtime = await publishingRepository.getPublisherRuntimeState();
  if (!runtime?.featureEnabled) {
    throw new TRPCError({
      code: "NOT_FOUND",
      message: "Media publishing is not enabled",
    });
  }
  return next({
    ctx: {
      ...ctx,
      user: ctx.user,
      publishingRepository,
    },
  });
});

const requirePublisherAdmin = t.middleware(({ ctx, next }) => {
  if (!ctx.user) {
    throw new TRPCError({
      code: "UNAUTHORIZED",
      message: "Authentication required",
    });
  }
  if (ctx.user.role !== "admin") {
    throw new TRPCError({
      code: "FORBIDDEN",
      message: "Administrator role required",
    });
  }
  const publishingRepository = ctx.publishingRepository;
  if (!publishingRepository) {
    throw new TRPCError({
      code: "NOT_FOUND",
      message: "Media publishing is not enabled",
    });
  }
  return next({
    ctx: {
      ...ctx,
      user: ctx.user,
      publishingRepository,
    },
  });
});

const authenticatedProcedure = t.procedure.use(requireUser);
const customerProcedure = t.procedure.use(requireCustomer);
const adminProcedure = t.procedure.use(requireAdmin);
const publisherCustomerProcedure = t.procedure.use(requirePublisherCustomer);
const publisherAdminProcedure = t.procedure.use(requirePublisherAdmin);

const publisherRouter = t.router({
  dashboard: publisherCustomerProcedure
    .output(publisherDashboardOutputSchema)
    .query(({ ctx }) =>
      translateRepositoryErrors(() =>
        ctx.publishingRepository.getPublisherDashboard(ctx.user.id),
      ),
    ),
  articles: t.router({
    list: publisherCustomerProcedure
      .input(publisherArticleListInputSchema)
      .output(publisherArticleListOutputSchema)
      .query(({ ctx, input }) =>
        translateRepositoryErrors(async () => {
          const rows = await ctx.publishingRepository.listPublisherArticles(
            ctx.user.id,
            input,
          );
          const hasMore = rows.length > input.limit;
          const page = rows.slice(0, input.limit);
          return {
            items: await Promise.all(
              page.map((article) =>
                publicPublisherArticleSummary(
                  ctx.publishingRepository,
                  ctx.user.id,
                  article,
                ),
              ),
            ),
            nextCursor: hasMore ? (page.at(-1)?.id ?? null) : null,
          };
        }),
      ),
    create: publisherCustomerProcedure
      .input(publisherCreateArticleInputSchema)
      .output(publisherArticleOutputSchema)
      .mutation(({ ctx, input }) =>
        translateRepositoryErrors(async () => {
          const created = await ctx.publishingRepository.createPublisherArticle(
            ctx.user.id,
            input.workingName,
          );
          return publicPublisherArticle(
            ctx.publishingRepository,
            ctx.user.id,
            created,
          );
        }),
      ),
    get: publisherCustomerProcedure
      .input(publisherArticleAssetsInputSchema)
      .output(publisherArticleOutputSchema)
      .query(({ ctx, input }) =>
        translateRepositoryErrors(async () =>
          publicPublisherArticle(
            ctx.publishingRepository,
            ctx.user.id,
            await ctx.publishingRepository.getPublisherArticle(
              ctx.user.id,
              input.articleId,
            ),
          ),
        ),
      ),
    save: publisherCustomerProcedure
      .input(publisherSaveArticleInputSchema)
      .output(publisherArticleOutputSchema)
      .mutation(({ ctx, input }) =>
        translateRepositoryErrors(async () => {
          if (
            !input.editorJson ||
            typeof input.editorJson !== "object" ||
            Array.isArray(input.editorJson)
          ) {
            throw new RepositoryError(
              "INVALID_STATE",
              "Article editor state must be an object",
            );
          }
          const [article, assets] = await Promise.all([
            ctx.publishingRepository.getPublisherArticle(
              ctx.user.id,
              input.articleId,
            ),
            ctx.publishingRepository.listPublisherArticleAssets(
              ctx.user.id,
              input.articleId,
            ),
          ]);
          const allowedImageSourcesByAssetId = new Map(
            assets.map((asset) => [
              asset.id,
              new Set([
                new URL(
                  `/api/monitoring/publisher/public-assets/${asset.id}/${derivePublisherAssetCapability(
                    {
                      secret: ctx.config.SESSION_SECRET,
                      ownerId: ctx.user.id,
                      articleId: input.articleId,
                      assetSha256: asset.sha256,
                    },
                  )}`,
                  ctx.config.PUBLIC_ORIGIN,
                ).toString(),
              ]),
            ]),
          );
          await Promise.all(
            publisherCanonicalImageReferences(article.canonicalHtml ?? "").map(
              async ({ assetId, source }) => {
                const sources = allowedImageSourcesByAssetId.get(assetId);
                if (!sources) return;
                const capability = publisherAssetCapabilityFromExactUrl(
                  source,
                  assetId,
                  ctx.config.PUBLIC_ORIGIN,
                );
                if (!capability) return;
                const trusted =
                  await ctx.publishingRepository.getPublicPublisherAsset(
                    assetId,
                    capability,
                  );
                if (trusted?.id === assetId) sources.add(source);
              },
            ),
          );
          const canonical = canonicalizePublisherHtml(input.canonicalHtml, {
            allowedAssetIds: assets.map(({ id }) => id),
            allowedImageSourcesByAssetId,
          });
          if (canonical.blockingIssues.length) {
            throw new RepositoryError(
              "INVALID_STATE",
              canonical.blockingIssues[0]?.message ??
                "Article content failed security validation",
            );
          }
          await ctx.publishingRepository.savePublisherArticle(ctx.user.id, {
            articleId: input.articleId,
            expectedRevision: input.expectedRevision,
            workingName: input.workingName,
            suggestedTitle: input.suggestedTitle,
            editorJson: input.editorJson as Record<string, unknown>,
            canonicalHtml: canonical.canonicalHtml,
            plainText: canonical.plainText,
            containsImages: canonical.containsImages,
          });
          return publicPublisherArticle(
            ctx.publishingRepository,
            ctx.user.id,
            await ctx.publishingRepository.getPublisherArticle(
              ctx.user.id,
              input.articleId,
            ),
          );
        }),
      ),
    freeze: publisherCustomerProcedure
      .input(publisherFreezeArticleInputSchema)
      .output(publisherArticleVersionOutputSchema)
      .mutation(({ ctx, input }) =>
        translateRepositoryErrors(() =>
          ctx.publishingRepository.freezePublisherArticle(ctx.user.id, {
            ...input,
            actorId: ctx.user.id,
          }),
        ),
      ),
    versions: publisherCustomerProcedure
      .input(publisherArticleAssetsInputSchema)
      .output(z.array(publisherArticleVersionOutputSchema))
      .query(({ ctx, input }) =>
        translateRepositoryErrors(() =>
          ctx.publishingRepository.listPublisherArticleVersions(
            ctx.user.id,
            input.articleId,
          ),
        ),
      ),
    assets: publisherCustomerProcedure
      .input(publisherArticleAssetsInputSchema)
      .output(z.array(publisherArticleAssetOutputSchema))
      .query(({ ctx, input }) =>
        translateRepositoryErrors(async () =>
          (
            await ctx.publishingRepository.listPublisherArticleAssets(
              ctx.user.id,
              input.articleId,
            )
          ).map((asset) => ({
            ...asset,
            mimeType: publisherAssetMimeType(asset.mimeType),
          })),
        ),
      ),
  }),
  imports: t.router({
    list: publisherCustomerProcedure
      .input(publisherImportListInputSchema)
      .output(publisherImportListOutputSchema)
      .query(({ ctx, input }) =>
        translateRepositoryErrors(async () => {
          const rows = await ctx.publishingRepository.listPublisherDocxImports(
            ctx.user.id,
            input,
          );
          const hasMore = rows.length > input.limit;
          const page = rows.slice(0, input.limit);
          return {
            items: page.map(publicPublisherImport),
            nextCursor: hasMore ? (page.at(-1)?.id ?? null) : null,
          };
        }),
      ),
    get: publisherCustomerProcedure
      .input(publisherImportStatusInputSchema)
      .output(publisherDocxImportOutputSchema)
      .query(({ ctx, input }) =>
        translateRepositoryErrors(async () =>
          publicPublisherImport(
            await ctx.publishingRepository.getPublisherDocxImport(
              ctx.user.id,
              input.importId,
            ),
          ),
        ),
      ),
  }),
  media: t.router({
    list: publisherCustomerProcedure
      .input(publisherMediaListInputSchema)
      .output(publisherMediaListOutputSchema)
      .query(({ ctx, input }) =>
        translateRepositoryErrors(async () => {
          const result =
            await ctx.publishingRepository.listPublisherMedia(input);
          const runtime =
            await ctx.publishingRepository.getPublisherRuntimeState();
          const syncedAt = runtime?.catalogSyncedAt ?? null;
          return {
            ...result,
            nextCursor:
              result.legacyCursorMode && result.hasMore
                ? (result.items.at(-1)?.id ?? null)
                : null,
            catalogRevision: runtime?.activeCatalogRevision ?? null,
            catalogSyncedAt: syncedAt,
            catalogStale:
              !syncedAt || Date.now() - syncedAt.getTime() > 12 * 60 * 60_000,
            kindComplete: runtime?.catalogKindComplete ?? false,
          };
        }),
      ),
    facets: publisherCustomerProcedure
      .input(publisherMediaFacetsInputSchema)
      .output(publisherMediaFacetsOutputSchema)
      .query(({ ctx, input }) =>
        translateRepositoryErrors(async () => {
          const [facets, runtime] = await Promise.all([
            ctx.publishingRepository.getPublisherMediaFacets(input ?? {}),
            ctx.publishingRepository.getPublisherRuntimeState(),
          ]);
          return {
            ...facets,
            catalogRevision: runtime?.activeCatalogRevision ?? null,
            catalogSyncedAt: runtime?.catalogSyncedAt ?? null,
            kindComplete: runtime?.catalogKindComplete ?? false,
          };
        }),
      ),
  }),
  drafts: t.router({
    get: publisherCustomerProcedure
      .input(publisherDraftInputSchema)
      .output(publisherDraftOutputSchema)
      .query(({ ctx, input }) =>
        translateRepositoryErrors(() =>
          ctx.publishingRepository.getPublisherDraft(
            ctx.user.id,
            input.draftId,
          ),
        ),
      ),
    save: publisherCustomerProcedure
      .input(publisherSaveDraftInputSchema)
      .output(publisherDraftOutputSchema)
      .mutation(({ ctx, input }) =>
        translateRepositoryErrors(async () => {
          const saved = await ctx.publishingRepository.savePublisherDraft(
            ctx.user.id,
            input,
          );
          return ctx.publishingRepository.getPublisherDraft(
            ctx.user.id,
            saved.id,
          );
        }),
      ),
    saveTitles: publisherCustomerProcedure
      .input(publisherSaveDraftTitlesInputSchema)
      .output(publisherDraftOutputSchema)
      .mutation(({ ctx, input }) =>
        translateRepositoryErrors(async () => {
          const saved = await ctx.publishingRepository.savePublisherDraftTitles(
            ctx.user.id,
            input,
          );
          return ctx.publishingRepository.getPublisherDraft(
            ctx.user.id,
            saved.id,
          );
        }),
      ),
    refreshMedia: publisherCustomerProcedure
      .input(publisherRefreshDraftMediaInputSchema)
      .output(publisherDraftOutputSchema)
      .mutation(({ ctx, input }) =>
        translateRepositoryErrors(async () => {
          const refreshed =
            await ctx.publishingRepository.refreshPublisherDraftMedia(
              ctx.user.id,
              input,
            );
          return ctx.publishingRepository.getPublisherDraft(
            ctx.user.id,
            refreshed.id,
          );
        }),
      ),
    preflight: publisherCustomerProcedure
      .input(publisherPreflightInputSchema)
      .output(publisherPreflightOutputSchema)
      .mutation(({ ctx, input }) =>
        translateRepositoryErrors(async () => {
          const runtime =
            await ctx.publishingRepository.getPublisherRuntimeState();
          const requiredMode = requirePublisherServerRuntimeMode(runtime);
          const preflight =
            await ctx.publishingRepository.preflightPublisherDraft(
              ctx.user.id,
              input.draftId,
              input.expectedDraftRevision,
              { requiredMode },
            );
          const containsImages =
            preflight.mode !== "mock"
              ? (
                  await ctx.publishingRepository.getPublisherArticleVersion(
                    ctx.user.id,
                    preflight.articleVersionId,
                  )
                ).containsImages
              : false;
          return {
            ...preflight,
            blockers: mergePublisherGateBlockers(
              preflight.blockers,
              publisherEnvironmentGateBlockers(
                ctx,
                preflight.mode,
                containsImages,
              ),
            ),
          };
        }),
      ),
    submit: publisherCustomerProcedure
      .input(publisherSubmitInputSchema)
      .output(publisherSubmitOutputSchema)
      .mutation(({ ctx, input }) =>
        translateRepositoryErrors(async () => {
          const runtime =
            await ctx.publishingRepository.getPublisherRuntimeState();
          const mode = requirePublisherServerRuntimeMode(runtime);
          const draft = await ctx.publishingRepository.getPublisherDraft(
            ctx.user.id,
            input.draftId,
          );
          const version =
            await ctx.publishingRepository.getPublisherArticleVersion(
              ctx.user.id,
              draft.articleVersionId,
            );
          const containsImages = version.containsImages;
          const blockers = [
            ...publisherEnvironmentGateBlockers(ctx, mode, containsImages),
            ...publisherDatabaseGateBlockers(runtime, mode),
          ];
          if (blockers.length > 0) {
            throw new TRPCError({
              code: "PRECONDITION_FAILED",
              message: blockers.map(({ message }) => message).join("; "),
            });
          }
          return ctx.publishingRepository.submitPublisherDraft(
            ctx.user.id,
            input,
            { requiredMode: mode },
          );
        }),
      ),
  }),
  batches: t.router({
    list: publisherCustomerProcedure
      .input(publisherBatchListInputSchema)
      .output(publisherBatchListOutputSchema)
      .query(({ ctx, input }) =>
        translateRepositoryErrors(async () => {
          const result = await ctx.publishingRepository.listPublisherBatches(
            ctx.user.id,
            input,
          );
          return {
            ...result,
            nextCursor:
              result.legacyCursorMode && result.hasMore
                ? (result.items.at(-1)?.id ?? null)
                : null,
          };
        }),
      ),
    get: publisherCustomerProcedure
      .input(publisherBatchInputSchema)
      .output(publisherBatchOutputSchema)
      .query(({ ctx, input }) =>
        translateRepositoryErrors(() =>
          ctx.publishingRepository.getPublisherBatch(
            ctx.user.id,
            input.batchId,
          ),
        ),
      ),
  }),
});

const mediaPublishingBillingRouter = t.router({
  summary: publisherCustomerProcedure
    .output(mediaPublishingBillingSummaryOutputSchema)
    .query(({ ctx }) =>
      translateRepositoryErrors(() =>
        ctx.publishingRepository.getMediaPublishingBillingSummary(ctx.user.id),
      ),
    ),
  methods: publisherCustomerProcedure
    .output(paymentMethodsOutputSchema)
    .query(({ ctx }) =>
      paymentMethodStateForAuthenticatedUser(ctx.paymentConfiguration),
    ),
  ledger: publisherCustomerProcedure
    .input(listInputSchema.optional())
    .output(z.array(mediaPublishingLedgerEntryOutputSchema))
    .query(({ ctx, input }) =>
      translateRepositoryErrors(() =>
        ctx.publishingRepository.listMediaPublishingLedger(
          ctx.user.id,
          input?.limit ?? 100,
        ),
      ),
    ),
  topups: t.router({
    list: publisherCustomerProcedure
      .input(mediaPublishingTopupListInputSchema)
      .output(mediaPublishingTopupListOutputSchema)
      .query(async ({ ctx, input }) => ({
        items: (
          await translateRepositoryErrors(() =>
            ctx.publishingRepository.listMediaPublishingTopupOrders(
              ctx.user.id,
              input.limit,
              ctx.paymentNow?.() ?? new Date(),
            ),
          )
        ).map(publicMediaPublishingTopupOrder),
      })),
    create: publisherCustomerProcedure
      .input(mediaPublishingCreateTopupOrderInputSchema)
      .output(mediaPublishingCreateTopupOrderOutputSchema)
      .mutation(({ ctx, input }) =>
        translateFinancialErrors(async () => {
          assertPaymentMethodConfigured(
            ctx.paymentConfiguration,
            input.paymentMethod,
          );
          const observedAt = ctx.paymentNow?.() ?? new Date();
          const identity = newTopupIdentity({
            sessionSecret: ctx.config.SESSION_SECRET,
            userId: ctx.user.id,
            idempotencyKey: `media-publishing:${input.idempotencyKey}`,
          });
          const persistedOrder =
            await ctx.publishingRepository.createMediaPublishingTopupOrder({
              ownerId: ctx.user.id,
              providerOrderId: identity.providerOrderId,
              paymentMethod: input.paymentMethod,
              amountTenThousandths: input.amountTenThousandths,
              idempotencyKey: input.idempotencyKey,
              callbackTokenDigest: identity.callbackTokenDigest,
              checkoutExpiresAt: new Date(
                observedAt.getTime() + TOPUP_CHECKOUT_TTL_MS,
              ),
            });
          const order = publicMediaPublishingTopupOrder(persistedOrder);
          return {
            order,
            checkout: createCheckoutForOrder({
              configuration: ctx.paymentConfiguration,
              sessionSecret: ctx.config.SESSION_SECRET,
              userId: ctx.user.id,
              order,
              observedAt,
            }),
          };
        }),
      ),
    status: publisherCustomerProcedure
      .input(mediaPublishingTopupStatusInputSchema)
      .output(mediaPublishingTopupStatusOutputSchema)
      .query(({ ctx, input }) =>
        translateFinancialErrors(async () => {
          const observedAt = ctx.paymentNow?.() ?? new Date();
          let order =
            await ctx.publishingRepository.expireMediaPublishingTopupOrderIfNeeded(
              ctx.user.id,
              input.orderId,
              observedAt,
            );
          let reconciliation:
            | "not_applicable"
            | "unavailable"
            | "pending"
            | "credited"
            | "review_required" = "not_applicable";
          if (
            (order.paymentMethod === "alipay" ||
              order.paymentMethod === "wxpay") &&
            order.state !== "rejected"
          ) {
            const settlement = createZpaySettlementService({
              configuration: ctx.paymentConfiguration,
              repository: ctx.repository,
              publishingRepository: ctx.publishingRepository,
              ...(ctx.paymentFetchImpl
                ? { fetchImpl: ctx.paymentFetchImpl }
                : {}),
              ...(ctx.paymentNow ? { now: ctx.paymentNow } : {}),
            });
            if (!settlement) reconciliation = "unavailable";
            else {
              reconciliation = (
                await settlement.reconcileProviderOrder(order.providerOrderId)
              ).status;
              order =
                await ctx.publishingRepository.getMediaPublishingTopupOrder(
                  ctx.user.id,
                  input.orderId,
                );
            }
          }
          return {
            order: publicMediaPublishingTopupOrder(order),
            reconciliation,
          };
        }),
      ),
    switchMethod: publisherCustomerProcedure
      .input(mediaPublishingSwitchTopupPaymentMethodInputSchema)
      .output(mediaPublishingCreateTopupOrderOutputSchema)
      .mutation(({ ctx, input }) =>
        translateFinancialErrors(async () => {
          assertPaymentMethodConfigured(
            ctx.paymentConfiguration,
            input.paymentMethod,
          );
          const observedAt = ctx.paymentNow?.() ?? new Date();
          const existing =
            await ctx.publishingRepository.expireMediaPublishingTopupOrderIfNeeded(
              ctx.user.id,
              input.orderId,
              observedAt,
            );
          if (input.paymentMethod === input.expectedPaymentMethod) {
            if (
              existing.state !== "pending" ||
              existing.paymentMethod !== input.expectedPaymentMethod
            ) {
              throw new PaymentError(
                "当前充值订单不能恢复支付",
                "PAYMENT_ORDER_STATE_INVALID",
                409,
              );
            }
            const order = publicMediaPublishingTopupOrder(existing);
            return {
              order,
              checkout: createCheckoutForOrder({
                configuration: ctx.paymentConfiguration,
                sessionSecret: ctx.config.SESSION_SECRET,
                userId: ctx.user.id,
                order,
                observedAt,
              }),
            };
          }
          const idempotencyKey = `topup-switch:${input.orderId}:${input.paymentMethod}`;
          const identity = newTopupIdentity({
            sessionSecret: ctx.config.SESSION_SECRET,
            userId: ctx.user.id,
            idempotencyKey: `media-publishing:${idempotencyKey}`,
          });
          const persistedOrder =
            await ctx.publishingRepository.switchMediaPublishingTopupPaymentMethod(
              {
                ownerId: ctx.user.id,
                orderId: input.orderId,
                expectedPaymentMethod: input.expectedPaymentMethod,
                paymentMethod: input.paymentMethod,
                providerOrderId: identity.providerOrderId,
                idempotencyKey,
                callbackTokenDigest: identity.callbackTokenDigest,
                checkoutExpiresAt: new Date(
                  observedAt.getTime() + TOPUP_CHECKOUT_TTL_MS,
                ),
              },
            );
          const order = publicMediaPublishingTopupOrder(persistedOrder);
          return {
            order,
            checkout: createCheckoutForOrder({
              configuration: ctx.paymentConfiguration,
              sessionSecret: ctx.config.SESSION_SECRET,
              userId: ctx.user.id,
              order,
              observedAt,
            }),
          };
        }),
      ),
    submitBankTransfer: publisherCustomerProcedure
      .input(mediaPublishingSubmitBankTransferReviewInputSchema)
      .output(
        z.object({
          review: mediaPublishingBankTransferReviewOutputSchema,
          order: mediaPublishingTopupOrderOutputSchema,
        }),
      )
      .mutation(({ ctx, input }) =>
        translateFinancialErrors(async () => {
          assertPaymentMethodConfigured(
            ctx.paymentConfiguration,
            "bank_transfer",
          );
          const review =
            await ctx.publishingRepository.submitMediaPublishingBankTransferReview(
              {
                ownerId: ctx.user.id,
                ...input,
                submittedAt: ctx.paymentNow?.() ?? new Date(),
              },
            );
          return {
            review: publicMediaPublishingBankReview(review),
            order: publicMediaPublishingTopupOrder(
              await ctx.publishingRepository.getMediaPublishingTopupOrder(
                ctx.user.id,
                input.orderId,
              ),
            ),
          };
        }),
      ),
  }),
});

const publisherAdminRouter = t.router({
  runtime: publisherAdminProcedure
    .output(publisherRuntimeOutputSchema)
    .query(({ ctx }) => publicPublisherRuntime(ctx)),
  updateRuntime: publisherAdminProcedure
    .input(publisherAdminRuntimeUpdateInputSchema)
    .output(publisherRuntimeOutputSchema)
    .mutation(async ({ ctx, input }) => {
      await translateRepositoryErrors(() =>
        ctx.publishingRepository.updatePublisherRuntimeState({
          ...input,
          changedBy: ctx.user.id,
        }),
      );
      await ctx.repository.writeAudit(
        ctx.audit,
        "admin.publisher_runtime_updated",
        "publisher_runtime",
        "kol",
        null,
        input,
      );
      return publicPublisherRuntime(ctx);
    }),
  emergencyStop: publisherAdminProcedure
    .input(publisherAdminEmergencyStopInputSchema)
    .output(publisherRuntimeOutputSchema)
    .mutation(async ({ ctx, input }) => {
      await translateRepositoryErrors(() =>
        ctx.publishingRepository.updatePublisherRuntimeState({
          emergencyStop: input.enabled,
          changedBy: ctx.user.id,
        }),
      );
      await ctx.repository.writeAudit(
        ctx.audit,
        input.enabled
          ? "admin.publisher_emergency_stop_enabled"
          : "admin.publisher_emergency_stop_disabled",
        "publisher_runtime",
        "kol",
        null,
        { reason: input.reason },
      );
      return publicPublisherRuntime(ctx);
    }),
  requestCatalogSync: publisherAdminProcedure
    .output(publisherAdminCatalogSyncRequestOutputSchema)
    .mutation(async ({ ctx }) => {
      const result = await translateRepositoryErrors(() =>
        ctx.publishingRepository.requestPublisherCatalogSync(ctx.user.id),
      );
      return { queued: true, syncRunId: result.syncRunId };
    }),
  catalogRuns: publisherAdminProcedure
    .input(listInputSchema.optional())
    .output(z.array(publisherAdminCatalogRunOutputSchema))
    .query(async ({ ctx, input }) => {
      const runs = await ctx.publishingRepository.listPublisherMediaSyncRuns(
        input?.limit ?? 50,
      );
      return runs.map((run) => ({
        id: run.id,
        catalogRevision: run.catalogRevision,
        status: run.status,
        startedAt: run.startedAt,
        completedAt: run.completedAt,
        pagesFetched: run.pagesFetched,
        pagesExpected: run.pagesExpected,
        recordsSeen: run.recordsSeen,
        newsRecords: run.newsRecords,
        selfMediaRecords: run.selfMediaRecords,
        invalidRecords: run.invalidRecords,
        duplicateRecords: run.duplicateRecords,
        crossKindDuplicateRecords: run.crossKindDuplicateRecords,
        recordsChanged: run.recordsChanged,
        logoPending: run.logoPending,
        logoArchived: run.logoArchived,
        logoFailed: run.logoFailed,
        logoProviderArchived: run.logoProviderArchived,
        logoIconArchived: run.logoIconArchived,
        logoSiteFaviconArchived: run.logoSiteFaviconArchived,
        logoWebSearchVerifiedArchived: run.logoWebSearchVerifiedArchived,
        logoManualVerifiedArchived: run.logoManualVerifiedArchived,
        logoPendingReview: run.logoPendingReview,
        logoGeneratedFallback: run.logoGeneratedFallback,
        logoMissing: run.logoMissing,
        logoRealMissing: run.logoRealMissing,
        logoRealCoverageBasisPoints: run.logoRealCoverageBasisPoints,
        stopReason: run.stopReason,
        isComplete: run.isComplete,
      }));
    }),
  capabilities: publisherAdminProcedure
    .input(listInputSchema.optional())
    .output(z.array(publisherAdminCapabilityOutputSchema))
    .query(async ({ ctx, input }) => {
      const rows =
        await ctx.publishingRepository.listPublisherMediaCapabilities(
          input?.limit ?? 100,
        );
      return rows.map((row) => ({
        mediaResourceId: row.mediaResourceId,
        externalResourceId: row.externalResourceId,
        mediaName: row.mediaName,
        priceTenThousandths: row.priceTenThousandths.toString(),
        liveWhitelisted: Boolean(row.liveWhitelistMediaResourceId),
        liveImageAllowed: row.liveImageAllowed === true,
        imageSupport: row.imageSupport ?? "unknown",
        contentProfile: row.contentProfile ?? "unknown",
        evidenceUrl: row.evidenceUrl,
        verifiedAt: row.verifiedAt,
        verifiedBy: row.verifiedBy,
        notes: row.notes,
        updatedAt: row.updatedAt,
      }));
    }),
  setCapability: publisherAdminProcedure
    .input(publisherAdminMediaCapabilityInputSchema)
    .output(booleanResultOutputSchemas.updated)
    .mutation(async ({ ctx, input }) => {
      await translateRepositoryErrors(() =>
        ctx.publishingRepository.setPublisherMediaCapability({
          ...input,
          verifiedBy: ctx.user.id,
        }),
      );
      await ctx.repository.writeAudit(
        ctx.audit,
        "admin.publisher_media_capability_verified",
        "publisher_media",
        input.mediaResourceId,
        null,
        { imageSupport: input.imageSupport, evidenceUrl: input.evidenceUrl },
      );
      return { updated: true };
    }),
  setLiveWhitelist: publisherAdminProcedure
    .input(publisherAdminLiveWhitelistInputSchema)
    .output(booleanResultOutputSchemas.updated)
    .mutation(async ({ ctx, input }) => {
      await translateRepositoryErrors(() =>
        ctx.publishingRepository.setPublisherLiveWhitelist({
          ...input,
          actorId: ctx.user.id,
        }),
      );
      return { updated: true };
    }),
  unknownItems: publisherAdminProcedure
    .input(listInputSchema.optional())
    .output(z.array(publisherAdminUnknownItemOutputSchema))
    .query(async ({ ctx, input }) => {
      const rows = await ctx.publishingRepository.listPublisherUnknownItems(
        input?.limit ?? 100,
      );
      return Promise.all(
        rows.map(async ({ item, price, username }) => ({
          itemId: item.id,
          batchId: item.batchId,
          ownerUsername: username,
          mediaName: item.mediaNameSnapshot,
          submissionTitle: item.submissionTitle,
          status:
            item.status === "submission_unknown"
              ? ("submission_unknown" as const)
              : ("action_required" as const),
          fundsStatus: item.fundsStatus,
          priceTenThousandths: price.amountTenThousandths.toString(),
          actionRequiredReason: item.actionRequiredReason,
          updatedAt: item.updatedAt,
          candidates: (
            await ctx.publishingRepository.listPublisherReconciliationCandidates(
              item.id,
            )
          ).map(publicPublisherReconciliationCandidate),
        })),
      );
    }),
  reconciliationCandidates: publisherAdminProcedure
    .input(z.object({ itemId: idSchema }))
    .output(z.array(publisherAdminReconciliationCandidateOutputSchema))
    .query(async ({ ctx, input }) =>
      (
        await ctx.publishingRepository.listPublisherReconciliationCandidates(
          input.itemId,
        )
      ).map(publicPublisherReconciliationCandidate),
    ),
  bindUnknown: publisherAdminProcedure
    .input(publisherAdminUnknownBindInputSchema)
    .output(booleanResultOutputSchemas.updated)
    .mutation(async ({ ctx, input }) => {
      await translateRepositoryErrors(() =>
        ctx.publishingRepository.bindPublisherReconciliationCandidate({
          ...input,
          actorId: ctx.user.id,
        }),
      );
      return { updated: true };
    }),
  authorizeResubmit: publisherAdminProcedure
    .input(publisherAdminUnknownResubmitInputSchema)
    .output(booleanResultOutputSchemas.updated)
    .mutation(async ({ ctx, input }) => {
      await translateRepositoryErrors(() =>
        ctx.publishingRepository.authorizePublisherResubmit({
          ...input,
          actorId: ctx.user.id,
        }),
      );
      return { updated: true };
    }),
  billing: t.router({
    users: publisherAdminProcedure
      .input(listInputSchema.optional())
      .output(z.array(mediaPublishingAdminUserOutputSchema))
      .query(async ({ ctx, input }) => {
        await ctx.auth.syncAccounts?.();
        return translateRepositoryErrors(() =>
          ctx.publishingRepository.listAdminMediaPublishingBillingUsers(input?.limit ?? 100),
        );
      }),
    pendingBankReviews: publisherAdminProcedure
      .input(listInputSchema.optional())
      .output(z.array(mediaPublishingAdminBankReviewOutputSchema))
      .query(async ({ ctx, input }) =>
        (
          await ctx.publishingRepository.listPendingMediaPublishingBankTransferReviews(
            input?.limit ?? 100,
          )
        ).map((row) => ({
          review: publicMediaPublishingBankReview(row.review),
          order: publicMediaPublishingTopupOrder(row.order),
          username: row.username,
        })),
      ),
    reviewBankTransfer: publisherAdminProcedure
      .input(mediaPublishingAdminBankReviewInputSchema)
      .output(mediaPublishingBankTransferReviewOutputSchema)
      .mutation(({ ctx, input }) =>
        translateFinancialErrors(async () =>
          publicMediaPublishingBankReview(
            await ctx.publishingRepository.reviewMediaPublishingBankTransfer({
              ...input,
              reviewedBy: ctx.user.id,
              reviewedAt: ctx.paymentNow?.() ?? new Date(),
            }),
          ),
        ),
      ),
    adjust: publisherAdminProcedure
      .input(mediaPublishingAdminAdjustmentInputSchema)
      .output(mediaPublishingBillingSummaryOutputSchema)
      .mutation(({ ctx, input }) =>
        translateRepositoryErrors(() =>
          ctx.publishingRepository.adjustMediaPublishingMoney({
            ownerId: input.userId,
            publicationItemId: input.publicationItemId,
            amountTenThousandths: input.amountTenThousandths,
            reason: input.reason,
            idempotencyKey: input.idempotencyKey,
            actorId: ctx.user.id,
          }),
        ),
      ),
  }),
});

export const appRouter = t.router({
  publisher: publisherRouter,
  mediaPublishing: t.router({ billing: mediaPublishingBillingRouter }),
  publisherAdmin: publisherAdminRouter,
  auth: t.router({
    me: authenticatedProcedure
      .output(authMeOutputSchema)
      .query(async ({ ctx }) => {
        const publisherRuntime =
          ctx.config.PUBLISHER_FEATURE_ENABLED === true &&
          ctx.publishingRepository
            ? await ctx.publishingRepository.getPublisherRuntimeState()
            : null;
        return {
          user: ctx.user,
          billing: await ctx.repository.getBillingSummary(ctx.user.id),
          features: {
            mediaPublishing: publisherRuntime?.featureEnabled === true,
          },
        };
      }),
    changePassword: authenticatedProcedure
      .input(changePasswordInputSchema)
      .output(booleanResultOutputSchemas.passwordChanged)
      .mutation(() => {
        throw new TRPCError({ code: "BAD_REQUEST", message: "请在看板账号设置中修改密码" });
      }),
  }),

  projects: t.router({
    list: customerProcedure
      .output(z.array(projectOutputSchema))
      .query(({ ctx }) => ctx.repository.listProjects(ctx.user.id)),
    listDeleted: customerProcedure
      .output(z.array(deletedProjectOutputSchema))
      .query(({ ctx }) => ctx.repository.listDeletedProjects(ctx.user.id)),
    get: customerProcedure
      .input(z.object({ projectId: idSchema }))
      .output(projectOutputSchema)
      .query(({ ctx, input }) =>
        ctx.repository.getProject(ctx.user.id, input.projectId),
      ),
    create: customerProcedure
      .input(projectCreateInputSchema)
      .output(projectOutputSchema)
      .mutation(({ ctx, input }) =>
        translateRepositoryErrors(() =>
          ctx.repository.createProject(ctx.user.id, input, ctx.audit),
        ),
      ),
    updateBrand: customerProcedure
      .input(projectBrandUpdateInputSchema)
      .output(projectOutputSchema)
      .mutation(({ ctx, input }) =>
        translateRepositoryErrors(() =>
          ctx.repository.updateProjectBrand(ctx.user.id, input, ctx.audit),
        ),
      ),
    update: customerProcedure
      .input(projectUpdateInputSchema)
      .output(projectOutputSchema)
      .mutation(({ ctx, input }) =>
        translateRepositoryErrors(() =>
          ctx.repository.updateProjectBrand(ctx.user.id, input, ctx.audit),
        ),
      ),
    remove: customerProcedure
      .input(z.object({ projectId: idSchema }))
      .output(booleanResultOutputSchemas.deleted)
      .mutation(async ({ ctx, input }) => {
        await translateRepositoryErrors(() =>
          ctx.repository.softDeleteProject(
            ctx.user.id,
            input.projectId,
            ctx.audit,
          ),
        );
        return { deleted: true };
      }),
    restore: customerProcedure
      .input(z.object({ projectId: idSchema }))
      .output(booleanResultOutputSchemas.projectRestored)
      .mutation(async ({ ctx, input }) => {
        await translateRepositoryErrors(() =>
          ctx.repository.restoreProject(
            ctx.user.id,
            input.projectId,
            ctx.audit,
          ),
        );
        return { restored: true, schedulesPaused: true };
      }),
  }),

  platforms: t.router({
    list: customerProcedure
      .output(z.array(platformOutputSchema))
      .query(({ ctx }) => ctx.repository.listPlatforms(false)),
  }),

  regions: t.router({
    list: customerProcedure
      .input(
        z
          .object({ scope: z.enum(["domestic", "overseas"]).optional() })
          .optional(),
      )
      .output(z.array(regionOutputSchema))
      .query(({ ctx, input }) => ctx.repository.listRegions(input?.scope)),
  }),

  billing: t.router({
    activity: customerProcedure.input(accountActivityInputSchema.optional()).output(z.array(accountActivityOutputSchema))
      .query(({ctx,input})=>translateRepositoryErrors(()=>ctx.repository.listAccountActivity(ctx.user.id,input))),

    summary: customerProcedure
      .output(billingSummaryOutputSchema)
      .query(({ ctx }) =>
        translateRepositoryErrors(() =>
          ctx.repository.getBillingSummary(ctx.user.id),
        ),
      ),
    pricing: customerProcedure
      .output(pricingOutputSchema)
      .query(({ ctx }) =>
        translateRepositoryErrors(() => ctx.repository.getActivePricing()),
      ),
    quote: customerProcedure
      .input(billingQuoteInputSchema)
      .output(billingQuoteOutputSchema)
      .mutation(({ ctx, input }) =>
        translateRepositoryErrors(() => ctx.repository.quoteBilling(input)),
      ),
    quoteMonitor: customerProcedure
      .input(billingMonitorQuoteInputSchema)
      .output(billingMonitorQuoteOutputSchema)
      .query(({ ctx, input }) =>
        translateRepositoryErrors(async () => {
          const monitor = await ctx.repository.getMonitor(
            ctx.user.id,
            input.monitorId,
          );
          const quantity =
            monitor.questions.length * monitor.version.repetitions;
          const [quote, summary] = await Promise.all([
            ctx.repository.quoteBilling({
              items: monitor.platforms.map((platform) => ({
                platformId: platform.platformId,
                mode: platform.mode,
                screenshot: screenshotPolicy(platform.screenshot),
                regionCode:
                  platform.clientType === "mobile" ? null : platform.regionCode,
                quantity,
              })),
            }),
            ctx.repository.getBillingSummary(ctx.user.id),
          ]);
          return {
            monitorId: input.monitorId,
            pricingVersionId: quote.pricingVersionId,
            currency: quote.currency,
            scale: quote.scale,
            totalAmountTenThousandths: quote.totalAmountTenThousandths,
            availableTenThousandths: summary.availableTenThousandths,
            sufficient:
              BigInt(summary.availableTenThousandths) >=
              BigInt(quote.totalAmountTenThousandths),
          };
        }),
      ),
    methods: customerProcedure
      .output(paymentMethodsOutputSchema)
      .query(({ ctx }) =>
        paymentMethodStateForAuthenticatedUser(ctx.paymentConfiguration),
      ),
    ledger: customerProcedure
      .input(listInputSchema.optional())
      .output(z.array(billingLedgerEntryOutputSchema))
      .query(({ ctx, input }) =>
        translateRepositoryErrors(() =>
          ctx.repository.listBillingLedger(ctx.user.id, input?.limit ?? 100),
        ),
      ),
    topups: t.router({
      list: customerProcedure
        .input(listInputSchema.optional())
        .output(z.array(topupOrderOutputSchema))
        .query(({ ctx, input }) =>
          translateRepositoryErrors(() =>
            ctx.repository.listTopupOrders(
              ctx.user.id,
              input?.limit ?? 100,
              ctx.paymentNow?.() ?? new Date(),
            ),
          ),
        ),
      create: customerProcedure
        .input(createTopupOrderInputSchema)
        .output(createTopupOrderOutputSchema)
        .mutation(async ({ ctx, input }) =>
          translateFinancialErrors(async () => {
            assertPaymentMethodConfigured(
              ctx.paymentConfiguration,
              input.paymentMethod,
            );
            const observedAt = ctx.paymentNow?.() ?? new Date();
            const identity = newTopupIdentity({
              sessionSecret: ctx.config.SESSION_SECRET,
              userId: ctx.user.id,
              idempotencyKey: input.idempotencyKey,
            });
            const order = await ctx.repository.createTopupOrder({
              userId: ctx.user.id,
              providerOrderId: identity.providerOrderId,
              paymentMethod: input.paymentMethod,
              amountTenThousandths: input.amountTenThousandths,
              idempotencyKey: input.idempotencyKey,
              callbackTokenDigest: identity.callbackTokenDigest,
              checkoutExpiresAt: new Date(
                observedAt.getTime() + TOPUP_CHECKOUT_TTL_MS,
              ),
            });
            return {
              order,
              checkout: createCheckoutForOrder({
                configuration: ctx.paymentConfiguration,
                sessionSecret: ctx.config.SESSION_SECRET,
                userId: ctx.user.id,
                order,
                observedAt,
              }),
            };
          }),
        ),
      status: customerProcedure
        .input(topupStatusInputSchema)
        .output(topupStatusOutputSchema)
        .query(async ({ ctx, input }) =>
          translateFinancialErrors(async () => {
            const observedAt = ctx.paymentNow?.() ?? new Date();
            let order = await ctx.repository.expireTopupOrderIfNeeded(
              ctx.user.id,
              input.orderId,
              observedAt,
            );
            let reconciliation:
              | "not_applicable"
              | "unavailable"
              | "pending"
              | "credited"
              | "review_required" = "not_applicable";
            if (
              (order.paymentMethod === "alipay" ||
                order.paymentMethod === "wxpay") &&
              order.state !== "rejected"
            ) {
              const settlement = createZpaySettlementService({
                configuration: ctx.paymentConfiguration,
                repository: ctx.repository,
                ...(ctx.paymentFetchImpl
                  ? { fetchImpl: ctx.paymentFetchImpl }
                  : {}),
                ...(ctx.paymentNow ? { now: ctx.paymentNow } : {}),
              });
              if (!settlement) {
                reconciliation = "unavailable";
              } else {
                const result = await settlement.reconcileProviderOrder(
                  order.providerOrderId,
                );
                reconciliation = result.status;
                order = await ctx.repository.getTopupOrder(
                  ctx.user.id,
                  input.orderId,
                );
              }
            }
            return { order, reconciliation };
          }),
        ),
      switchMethod: customerProcedure
        .input(switchTopupPaymentMethodInputSchema)
        .output(switchTopupPaymentMethodOutputSchema)
        .mutation(async ({ ctx, input }) =>
          translateFinancialErrors(async () => {
            assertPaymentMethodConfigured(
              ctx.paymentConfiguration,
              input.paymentMethod,
            );
            const observedAt = ctx.paymentNow?.() ?? new Date();
            const existing = await ctx.repository.expireTopupOrderIfNeeded(
              ctx.user.id,
              input.orderId,
              observedAt,
            );
            if (input.paymentMethod === input.expectedPaymentMethod) {
              if (
                existing.state !== "pending" ||
                existing.paymentMethod !== input.expectedPaymentMethod
              ) {
                throw new PaymentError(
                  "当前充值订单不能恢复支付",
                  "PAYMENT_ORDER_STATE_INVALID",
                  409,
                );
              }
              return {
                order: existing,
                checkout: createCheckoutForOrder({
                  configuration: ctx.paymentConfiguration,
                  sessionSecret: ctx.config.SESSION_SECRET,
                  userId: ctx.user.id,
                  order: existing,
                  observedAt,
                }),
              };
            }
            const replacementIdempotencyKey = `topup-switch:${input.orderId}:${input.paymentMethod}`;
            const identity = newTopupIdentity({
              sessionSecret: ctx.config.SESSION_SECRET,
              userId: ctx.user.id,
              idempotencyKey: replacementIdempotencyKey,
            });
            const order = await ctx.repository.switchTopupPaymentMethod({
              userId: ctx.user.id,
              orderId: input.orderId,
              expectedPaymentMethod: input.expectedPaymentMethod,
              paymentMethod: input.paymentMethod,
              providerOrderId: identity.providerOrderId,
              idempotencyKey: replacementIdempotencyKey,
              callbackTokenDigest: identity.callbackTokenDigest,
              checkoutExpiresAt: new Date(
                observedAt.getTime() + TOPUP_CHECKOUT_TTL_MS,
              ),
            });
            return {
              order,
              checkout: createCheckoutForOrder({
                configuration: ctx.paymentConfiguration,
                sessionSecret: ctx.config.SESSION_SECRET,
                userId: ctx.user.id,
                order,
                observedAt,
              }),
            };
          }),
        ),
      submitBankTransfer: customerProcedure
        .input(submitBankTransferReviewInputSchema)
        .output(submitBankTransferReviewOutputSchema)
        .mutation(async ({ ctx, input }) =>
          translateFinancialErrors(async () => {
            assertPaymentMethodConfigured(
              ctx.paymentConfiguration,
              "bank_transfer",
            );
            const submittedAt = ctx.paymentNow?.() ?? new Date();
            const service = createBankTransferService({
              repository: ctx.repository,
              audit: ctx.audit,
            });
            const review = await service.submit({
              orderId: input.orderId,
              userId: ctx.user.id,
              payerName: input.payerName,
              transferredAt: input.transferredAt,
              remittanceReference: input.remittanceReference,
              ...(input.evidenceObjectKey
                ? { evidenceObjectKey: input.evidenceObjectKey }
                : {}),
              idempotencyKey: `bank-submit:${input.orderId}`,
              submittedAt,
            });
            const order = await ctx.repository.getTopupOrder(
              ctx.user.id,
              input.orderId,
            );
            return { review: publicBankReview(review), order };
          }),
        ),
    }),
  }),

  monitors: t.router({
    list: customerProcedure
      .input(z.object({ projectId: idSchema.optional() }).optional())
      .output(z.array(monitorListOutputSchema))
      .query(({ ctx, input }) =>
        ctx.repository.listMonitors(ctx.user.id, input?.projectId),
      ),
    listDeleted: customerProcedure
      .output(z.array(deletedMonitorOutputSchema))
      .query(({ ctx }) => ctx.repository.listDeletedMonitors(ctx.user.id)),
    get: customerProcedure
      .input(z.object({ monitorId: idSchema }))
      .output(monitorDetailOutputSchema)
      .query(({ ctx, input }) =>
        translateRepositoryErrors(() =>
          ctx.repository.getMonitor(ctx.user.id, input.monitorId),
        ),
      ),
    create: customerProcedure
      .input(monitorCreateInputSchema)
      .output(monitorMutationOutputSchema)
      .mutation(async ({ ctx, input }) => {
        if (input.runImmediately && !input.idempotencyKey)
          throw new TRPCError({
            code: "BAD_REQUEST",
            message: "Immediate runs require an idempotency key",
          });
        return translateRepositoryErrors(async () => {
          if (input.runImmediately && input.idempotencyKey) {
            return ctx.repository.createMonitorAndRun(
              ctx.user.id,
              input.projectId,
              input.configuration,
              input.idempotencyKey,
              ctx.audit,
            );
          }
          const monitor = await ctx.repository.createMonitor(
            ctx.user.id,
            input.projectId,
            input.configuration,
            ctx.audit,
          );
          return { ...monitor, run: null };
        });
      }),
    update: customerProcedure
      .input(monitorUpdateInputSchema)
      .output(monitorMutationOutputSchema)
      .mutation(async ({ ctx, input }) => {
        if (input.runImmediately && !input.idempotencyKey)
          throw new TRPCError({
            code: "BAD_REQUEST",
            message: "Immediate runs require an idempotency key",
          });
        return translateRepositoryErrors(async () => {
          if (input.runImmediately && input.idempotencyKey) {
            return ctx.repository.updateMonitorAndRun(
              ctx.user.id,
              input.monitorId,
              input.configuration,
              input.idempotencyKey,
              ctx.audit,
            );
          }
          const monitor = await ctx.repository.updateMonitor(
            ctx.user.id,
            input.monitorId,
            input.configuration,
            ctx.audit,
          );
          return { ...monitor, run: null };
        });
      }),
    pause: customerProcedure
      .input(z.object({ monitorId: idSchema }))
      .output(booleanResultOutputSchemas.monitorPaused)
      .mutation(async ({ ctx, input }) => {
        await translateRepositoryErrors(() =>
          ctx.repository.setMonitorPaused(
            ctx.user.id,
            input.monitorId,
            true,
            ctx.audit,
          ),
        );
        return { paused: true };
      }),
    resume: customerProcedure
      .input(z.object({ monitorId: idSchema }))
      .output(booleanResultOutputSchemas.monitorPaused)
      .mutation(async ({ ctx, input }) => {
        await translateRepositoryErrors(() =>
          ctx.repository.setMonitorPaused(
            ctx.user.id,
            input.monitorId,
            false,
            ctx.audit,
          ),
        );
        return { paused: false };
      }),
    remove: customerProcedure
      .input(z.object({ monitorId: idSchema }))
      .output(booleanResultOutputSchemas.deleted)
      .mutation(async ({ ctx, input }) => {
        await translateRepositoryErrors(() =>
          ctx.repository.softDeleteMonitor(
            ctx.user.id,
            input.monitorId,
            ctx.audit,
          ),
        );
        return { deleted: true };
      }),
    restore: customerProcedure
      .input(z.object({ monitorId: idSchema }))
      .output(booleanResultOutputSchemas.monitorRestored)
      .mutation(async ({ ctx, input }) => {
        await translateRepositoryErrors(() =>
          ctx.repository.restoreMonitor(
            ctx.user.id,
            input.monitorId,
            ctx.audit,
          ),
        );
        return { restored: true, schedulePaused: true };
      }),
    runNow: customerProcedure
      .input(runNowInputSchema)
      .output(runCreationResultOutputSchema)
      .mutation(({ ctx, input }) =>
        translateRepositoryErrors(() =>
          ctx.repository.createRun(
            ctx.user.id,
            input.monitorId,
            input.idempotencyKey,
          ),
        ),
      ),
  }),

  monitoring: t.router({
    summary: customerProcedure
      .input(monitoringScopeSchema)
      .output(monitoringSummaryOutputSchema)
      .query(({ ctx, input }) =>
        translateRepositoryErrors(() =>
          ctx.repository.getMonitoringSummary(ctx.user.id, input),
        ),
      ),
    answers: t.router({
      list: customerProcedure
        .input(monitoringAnswersListInputSchema)
        .output(monitoringAnswersListOutputSchema)
        .query(({ ctx, input }) =>
          translateRepositoryErrors(() =>
            ctx.repository.listMonitoringAnswers(ctx.user.id, input),
          ),
        ),
      get: customerProcedure
        .input(monitoringAnswerGetInputSchema)
        .output(monitoringAnswerDetailOutputSchema)
        .query(({ ctx, input }) =>
          translateRepositoryErrors(() =>
            ctx.repository.getMonitoringAnswer(
              ctx.user.id,
              input.monitorId,
              input.answerId,
              input.subject,
            ),
          ),
        ),
    }),
    analysis: customerProcedure
      .input(monitoringAnalysisInputSchema)
      .output(monitoringAnalysisOutputSchema)
      .query(({ ctx, input }) =>
        translateRepositoryErrors(() =>
          ctx.repository.getMonitoringAnalysis(ctx.user.id, input),
        ),
      ),
  }),

  runs: t.router({
    list: customerProcedure
      .input(
        z.object({
          monitorId: idSchema,
          limit: z.number().int().min(1).max(100).default(30),
        }),
      )
      .output(z.array(runListOutputSchema))
      .query(({ ctx, input }) =>
        ctx.repository.listRuns(ctx.user.id, input.monitorId, input.limit),
      ),
    listDeleted: customerProcedure
      .input(listInputSchema.optional())
      .output(z.array(deletedRunOutputSchema))
      .query(({ ctx, input }) =>
        ctx.repository.listDeletedRuns(ctx.user.id, input?.limit ?? 100),
      ),
    get: customerProcedure
      .input(z.object({ runId: idSchema }))
      .output(runDetailOutputSchema)
      .query(({ ctx, input }) =>
        translateRepositoryErrors(() =>
          ctx.repository.getRun(ctx.user.id, input.runId),
        ),
      ),
    cancel: customerProcedure
      .input(z.object({ runId: idSchema }))
      .output(runRecordOutputSchema)
      .mutation(async ({ ctx, input }) => {
        const run = await translateRepositoryErrors(() =>
          ctx.repository.cancelRun(ctx.user.id, input.runId, ctx.audit),
        );
        if (!run)
          throw new TRPCError({
            code: "INTERNAL_SERVER_ERROR",
            message: "Cancelled run could not be read back",
          });
        return run;
      }),
    remove: customerProcedure
      .input(z.object({ runId: idSchema }))
      .output(booleanResultOutputSchemas.deleted)
      .mutation(async ({ ctx, input }) => {
        await translateRepositoryErrors(() =>
          ctx.repository.softDeleteRun(ctx.user.id, input.runId, ctx.audit),
        );
        return { deleted: true };
      }),
    restore: customerProcedure
      .input(z.object({ runId: idSchema }))
      .output(booleanResultOutputSchemas.restored)
      .mutation(async ({ ctx, input }) => {
        await translateRepositoryErrors(() =>
          ctx.repository.restoreRun(ctx.user.id, input.runId, ctx.audit),
        );
        return { restored: true };
      }),
  }),

  admin: t.router({
    overview: adminProcedure
      .output(adminOverviewOutputSchema)
      .query(({ ctx }) => ctx.repository.getAdminOverview()),
    users: t.router({
      list: adminProcedure
        .input(listInputSchema.optional())
        .output(z.array(adminUserListOutputSchema))
        .query(async ({ ctx, input }) => {
          await ctx.auth.syncAccounts?.();
          return ctx.repository.listUsers(input?.limit ?? 100);
        }),
      create: adminProcedure
        .input(adminCreateUserInputSchema)
        .output(adminUserViewSchema)
        .mutation(() => {
          throw new TRPCError({ code: "BAD_REQUEST", message: "请在系统管理员的用户管理中管理统一账号" });
        }),
      setStatus: adminProcedure
        .input(adminSetUserStatusInputSchema)
        .output(booleanResultOutputSchemas.updated)
        .mutation(() => {
          throw new TRPCError({ code: "BAD_REQUEST", message: "请在系统管理员的用户管理中管理统一账号" });
        }),
      resetPassword: adminProcedure
        .input(adminResetPasswordInputSchema)
        .output(booleanResultOutputSchemas.reset)
        .mutation(() => {
          throw new TRPCError({ code: "BAD_REQUEST", message: "请在系统管理员的用户管理中管理统一账号" });
        }),
    }),
    billing: t.router({
      users: adminProcedure
        .input(listInputSchema.optional())
        .output(z.array(adminBillingUserOutputSchema))
        .query(async ({ ctx, input }) => {
          await ctx.auth.syncAccounts?.();
          return translateRepositoryErrors(() => ctx.repository.listAdminBillingUsers(input?.limit ?? 100));
        }),
      adjustBalance: adminProcedure
        .input(adminBillingAdjustmentInputSchema)
        .output(billingSummaryOutputSchema)
        .mutation(({ ctx, input }) =>
          translateRepositoryErrors(() =>
            ctx.repository.adjustMoney(input, ctx.audit),
          ),
        ),
      bankTransfers: adminProcedure
        .input(listInputSchema.optional())
        .output(z.array(adminBankTransferOutputSchema))
        .query(async ({ ctx, input }) => {
          const rows = await ctx.repository.listPendingBankTransferReviews(
            input?.limit ?? 100,
          );
          return rows.map((row) => ({
            review: publicBankReview(row.review),
            order: publicTopupOrder(row.order),
            username: row.username,
          }));
        }),
      approve: adminProcedure
        .input(approveBankTransferInputSchema)
        .output(bankTransferReviewOutputSchema)
        .mutation(({ ctx, input }) =>
          translateFinancialErrors(async () => {
            const reviewedAt = ctx.paymentNow?.() ?? new Date();
            const review = await createBankTransferService({
              repository: ctx.repository,
              audit: ctx.audit,
            }).review({
              reviewId: input.reviewId,
              reviewerUserId: ctx.user.id,
              decision: "approve",
              reviewReason: input.reason,
              providerTradeNo: input.providerTradeNo,
              idempotencyKey: `bank-review:approve:${input.reviewId}`,
              reviewedAt,
            });
            return publicBankReview(review);
          }),
        ),
      reject: adminProcedure
        .input(rejectBankTransferInputSchema)
        .output(bankTransferReviewOutputSchema)
        .mutation(({ ctx, input }) =>
          translateFinancialErrors(async () => {
            const reviewedAt = ctx.paymentNow?.() ?? new Date();
            const review = await createBankTransferService({
              repository: ctx.repository,
              audit: ctx.audit,
            }).review({
              reviewId: input.reviewId,
              reviewerUserId: ctx.user.id,
              decision: "reject",
              reviewReason: input.reason,
              idempotencyKey: `bank-review:reject:${input.reviewId}`,
              reviewedAt,
            });
            return publicBankReview(review);
          }),
        ),
    }),
    platforms: t.router({
      list: adminProcedure
        .output(z.array(platformOutputSchema))
        .query(({ ctx }) => ctx.repository.listPlatforms(true)),
      sync: adminProcedure
        .output(booleanResultOutputSchemas.queued)
        .mutation(async ({ ctx }) => {
          await ctx.repository.enqueueProviderCatalogSync(ctx.audit);
          return { queued: true };
        }),
      acceptance: t.router({
        plan: adminProcedure
          .input(platformAcceptancePlanInputSchema)
          .output(platformAcceptancePlanOutputSchema)
          .query(({ ctx, input }) =>
            translateRepositoryErrors(() =>
              ctx.repository.planPlatformAcceptance(input),
            ),
          ),
        start: adminProcedure
          .input(platformAcceptanceStartInputSchema)
          .output(platformAcceptanceBatchOutputSchema)
          .mutation(({ ctx, input }) => {
            const configuredBudget =
              ctx.config.MONITORING_ACCEPTANCE_MAX_TEN_THOUSANDTHS;
            if (configuredBudget <= 0n) {
              throw new TRPCError({
                code: "PRECONDITION_FAILED",
                message:
                  "MONITORING_ACCEPTANCE_MAX_TEN_THOUSANDTHS must be set before paid probes can start",
              });
            }
            if (
              BigInt(input.confirmedTotalAmountTenThousandths) >
              configuredBudget
            ) {
              throw new TRPCError({
                code: "PRECONDITION_FAILED",
                message:
                  "Confirmed acceptance quote exceeds the configured budget ceiling",
              });
            }
            return translateRepositoryErrors(() =>
              ctx.repository.startPlatformAcceptanceBatch(input, ctx.audit),
            );
          }),
        list: adminProcedure
          .input(platformAcceptanceListInputSchema.optional())
          .output(z.array(platformAcceptanceBatchOutputSchema))
          .query(({ ctx, input }) =>
            translateRepositoryErrors(() =>
              ctx.repository.listPlatformAcceptanceBatches(input?.limit ?? 30),
            ),
          ),
        get: adminProcedure
          .input(platformAcceptanceGetInputSchema)
          .output(platformAcceptanceBatchOutputSchema)
          .query(({ ctx, input }) =>
            translateRepositoryErrors(() =>
              ctx.repository.getPlatformAcceptanceBatch(input.batchId),
            ),
          ),
      }),
      upsert: adminProcedure
        .input(platformCapabilityInputSchema)
        .output(idSchema)
        .mutation(({ ctx, input }) =>
          translateRepositoryErrors(() =>
            ctx.repository.upsertPlatform(input, ctx.audit),
          ),
        ),
    }),
    providerCosts: t.router({
      list: adminProcedure
        .input(listInputSchema.optional())
        .output(z.array(adminProviderCostOutputSchema))
        .query(({ ctx, input }) =>
          ctx.repository.listProviderCosts(input?.limit ?? 100),
        ),
    }),
    operations: t.router({
      list: adminProcedure
        .input(adminOperationsListInputSchema.optional())
        .output(adminOperationsListOutputSchema)
        .query(({ ctx, input }) =>
          ctx.repository.listAdminOperations(input ?? { limit: 30 }),
        ),
      get: adminProcedure
        .input(z.object({ runId: idSchema }))
        .output(adminOperationDetailOutputSchema)
        .query(({ ctx, input }) =>
          translateRepositoryErrors(() =>
            ctx.repository.getRunExecutionForAdmin(input.runId),
          ),
        ),
    }),
    runs: t.router({
      list: adminProcedure
        .input(listInputSchema.optional())
        .output(z.array(adminRunListOutputSchema))
        .query(({ ctx, input }) =>
          ctx.repository.listAllRuns(input?.limit ?? 100),
        ),
      getAudit: adminProcedure
        .input(z.object({ runId: idSchema }))
        .output(runDetailOutputSchema)
        .query(({ ctx, input }) =>
          translateRepositoryErrors(() =>
            ctx.repository.getRunForAdmin(input.runId, ctx.audit),
          ),
        ),
    }),
    audit: t.router({
      list: adminProcedure
        .input(auditListInputSchema.optional())
        .output(z.array(adminAuditOutputSchema))
        .query(({ ctx, input }) =>
          ctx.repository.listAudit(
            input?.limit ?? 100,
            input?.actorId,
            input?.action,
            input?.cursor,
            input?.from,
            input?.to,
            input?.domain,
          ),
        ),
    }),
  }),
});

export type AppRouter = typeof appRouter;

async function publicPublisherArticleSummary(
  repository: PublishingRepository,
  ownerId: string,
  article: {
    id: string;
    workingName: string;
    suggestedTitle: string | null;
    status: "draft" | "ready" | "archived";
    currentVersionId: string | null;
    containsImages: boolean;
    revision: number;
    updatedAt: Date;
    createdAt: Date;
  },
) {
  const versions = article.currentVersionId
    ? await repository.listPublisherArticleVersions(ownerId, article.id)
    : [];
  const currentVersion = versions.find(
    ({ id }) => id === article.currentVersionId,
  );
  return {
    id: article.id,
    workingName: article.workingName,
    suggestedTitle: article.suggestedTitle,
    status: article.status,
    currentVersionId: article.currentVersionId,
    currentVersion: currentVersion?.version ?? null,
    containsImages: article.containsImages,
    revision: article.revision,
    updatedAt: article.updatedAt,
    createdAt: article.createdAt,
  };
}

async function publicPublisherArticle(
  repository: PublishingRepository,
  ownerId: string,
  article: Parameters<typeof publicPublisherArticleSummary>[2] & {
    editorJson: unknown;
    canonicalHtml: string | null;
    plainText: string | null;
    contentHash: string | null;
  },
) {
  return {
    ...(await publicPublisherArticleSummary(repository, ownerId, article)),
    editorJson: article.editorJson,
    canonicalHtml: article.canonicalHtml,
    plainText: article.plainText,
    contentHash: article.contentHash,
  };
}

function publisherAssetMimeType(value: string): "image/jpeg" | "image/png" {
  if (value === "image/jpeg" || value === "image/png") return value;
  throw new RepositoryError(
    "INVALID_STATE",
    "Stored publisher asset has an invalid MIME type",
  );
}

function publisherAssetCapabilityFromExactUrl(
  source: string,
  assetId: string,
  publicOrigin: string,
): string | null {
  try {
    const url = new URL(source);
    const origin = new URL(publicOrigin);
    if (
      url.origin !== origin.origin ||
      url.username ||
      url.password ||
      url.search ||
      url.hash
    ) {
      return null;
    }
    const prefix = `/api/monitoring/publisher/public-assets/${encodeURIComponent(assetId)}/`;
    if (!url.pathname.startsWith(prefix)) return null;
    const encodedCapability = url.pathname.slice(prefix.length);
    if (!encodedCapability || encodedCapability.includes("/")) return null;
    const capability = decodeURIComponent(encodedCapability);
    if (capability.length < 32 || capability.length > 256) return null;
    const expected = new URL(
      `${prefix}${encodeURIComponent(capability)}`,
      origin,
    ).toString();
    return expected === url.toString() ? capability : null;
  } catch {
    return null;
  }
}

function publicPublisherImport(record: {
  id: string;
  articleId: string | null;
  sourceFilename: string;
  sizeBytes: number;
  status:
    "uploaded" | "validating" | "parsing" | "ready" | "rejected" | "failed";
  warnings: readonly Record<string, unknown>[];
  blockers: readonly Record<string, unknown>[];
  createdAt: Date;
  updatedAt: Date;
}) {
  return {
    id: record.id,
    articleId: record.articleId,
    sourceFilename: record.sourceFilename,
    sizeBytes: record.sizeBytes,
    status: record.status,
    warnings: publicPublisherIssues(record.warnings),
    blockers: publicPublisherIssues(record.blockers),
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  };
}

function publicPublisherIssues(values: readonly Record<string, unknown>[]) {
  return values.flatMap((value) => {
    if (typeof value.code !== "string" || typeof value.message !== "string") {
      return [];
    }
    return [
      {
        code: value.code.slice(0, 64),
        message: value.message.slice(0, 500),
        ...(typeof value.itemId === "string" ? { itemId: value.itemId } : {}),
        ...(typeof value.field === "string" ? { field: value.field } : {}),
      },
    ];
  });
}

type PublisherGateBlocker = {
  code: string;
  message: string;
  itemId?: string | null;
  field?: string | null;
};

function requirePublisherServerRuntimeMode(
  runtime: { mode?: "mock" | "test" | "live" | null } | null | undefined,
): "test" | "live" {
  if (runtime?.mode === "test" || runtime?.mode === "live") {
    return runtime.mode;
  }
  throw new TRPCError({
    code: "PRECONDITION_FAILED",
    message:
      "Server-backed media publishing requires database runtime mode TEST or LIVE; Mock publishing is available only in Preview",
  });
}

function publisherEnvironmentGateBlockers(
  ctx: Pick<ApiContext, "config">,
  mode: "mock" | "test" | "live",
  containsImages: boolean,
): PublisherGateBlocker[] {
  if (mode === "mock") return [];
  const blockers: PublisherGateBlocker[] = [];
  if (ctx.config.PUBLISHER_REAL_ENABLED !== true) {
    blockers.push({
      code: "ENV_REAL_DISABLED",
      message: "Real provider access is disabled by the API environment",
    });
  }
  if (ctx.config.PUBLISHER_PUBLISH_ENABLED !== true) {
    blockers.push({
      code: "ENV_PUBLISH_DISABLED",
      message: "Provider order creation is disabled by the API environment",
    });
  }
  if (containsImages) {
    if (ctx.config.PUBLISHER_IMAGE_ENABLED !== true) {
      blockers.push({
        code: "ENV_IMAGE_DISABLED",
        message:
          "TEST/LIVE image publishing is disabled by the API environment",
      });
    }
    if (ctx.config.PUBLISHER_PUBLIC_ASSETS_ENABLED !== true) {
      blockers.push({
        code: "PUBLIC_ASSETS_DISABLED",
        message: "Frozen public image assets are disabled",
      });
    }
  }
  return blockers;
}

function publisherDatabaseGateBlockers(
  runtime:
    | {
        featureEnabled: boolean;
        publishEnabled: boolean;
        emergencyStop: boolean;
      }
    | null
    | undefined,
  mode: "mock" | "test" | "live",
): PublisherGateBlocker[] {
  const blockers: PublisherGateBlocker[] = [];
  if (!runtime?.featureEnabled) {
    blockers.push({
      code: "FEATURE_DISABLED",
      message: "Media publishing customer access is disabled",
    });
  }
  if (mode === "mock") return blockers;
  if (!runtime?.publishEnabled) {
    blockers.push({
      code: "PUBLISH_DISABLED",
      message: "Provider publishing is disabled by the database gate",
    });
  }
  if (runtime?.emergencyStop) {
    blockers.push({
      code: "EMERGENCY_STOP",
      message: "Publishing is paused",
    });
  }
  return blockers;
}

function mergePublisherGateBlockers(
  current: readonly PublisherGateBlocker[],
  environment: readonly PublisherGateBlocker[],
): PublisherGateBlocker[] {
  const codes = new Set(current.map(({ code }) => code));
  return [...current, ...environment.filter(({ code }) => !codes.has(code))];
}

async function publicPublisherRuntime(ctx: ApiContext) {
  const repository = ctx.publishingRepository;
  if (!repository) {
    throw new TRPCError({
      code: "NOT_FOUND",
      message: "Media publishing is not enabled",
    });
  }
  const runtime = await repository.getPublisherRuntimeState();
  const environmentEnabled = ctx.config.PUBLISHER_FEATURE_ENABLED === true;
  const databaseFeatureEnabled = runtime?.featureEnabled ?? false;
  return {
    mode: runtime?.mode ?? ("mock" as const),
    environmentEnabled,
    environmentRealEnabled: ctx.config.PUBLISHER_REAL_ENABLED === true,
    environmentPublishEnabled: ctx.config.PUBLISHER_PUBLISH_ENABLED === true,
    environmentImageEnabled: ctx.config.PUBLISHER_IMAGE_ENABLED === true,
    environmentPublicAssetsEnabled:
      ctx.config.PUBLISHER_PUBLIC_ASSETS_ENABLED === true,
    environmentWebhookEnabled: ctx.config.KOL_WEBHOOK_ENABLED === true,
    databaseFeatureEnabled,
    featureEnabled: environmentEnabled && databaseFeatureEnabled,
    publishEnabled: runtime?.publishEnabled ?? false,
    imagePublishEnabled: runtime?.imagePublishEnabled ?? false,
    webhookEnabled:
      ctx.config.KOL_WEBHOOK_ENABLED && (runtime?.webhookEnabled ?? false),
    emergencyStop: runtime?.emergencyStop ?? false,
    credentialStatus: runtime?.credentialStatus ?? ("unconfigured" as const),
    credentialVerifiedAt: runtime?.credentialVerifiedAt ?? null,
    credentialFailedAt: runtime?.credentialFailedAt ?? null,
    catalogRevision: runtime?.activeCatalogRevision ?? null,
    catalogSyncedAt: runtime?.catalogSyncedAt ?? null,
  };
}

function publicPublisherReconciliationCandidate(candidate: {
  id: string;
  itemId: string;
  externalOrderId: string;
  confidenceBasisPoints: number;
  evidence: Record<string, unknown>;
  boundAt: Date | null;
  rejectedAt: Date | null;
  createdAt: Date;
}) {
  return {
    id: candidate.id,
    itemId: candidate.itemId,
    externalOrderId: candidate.externalOrderId,
    confidenceBasisPoints: candidate.confidenceBasisPoints,
    evidence: candidate.evidence,
    boundAt: candidate.boundAt,
    rejectedAt: candidate.rejectedAt,
    createdAt: candidate.createdAt,
  };
}

function publicMediaPublishingBankReview(review: {
  id: string;
  orderId: string;
  status: "pending" | "approved" | "rejected";
  payerName: string;
  transferredAt: Date;
  remittanceReference: string;
  evidenceObjectKey?: string | null;
  submittedAt: Date;
  reviewedBy?: string | null;
  reviewReason?: string | null;
  reviewedAt?: Date | null;
}) {
  return {
    id: review.id,
    orderId: review.orderId,
    status: review.status,
    payerName: review.payerName,
    transferredAt: review.transferredAt,
    remittanceReference: review.remittanceReference,
    evidenceSubmitted: Boolean(review.evidenceObjectKey),
    submittedAt: review.submittedAt,
    reviewedBy: review.reviewedBy ?? null,
    reviewReason: review.reviewReason ?? null,
    reviewedAt: review.reviewedAt ?? null,
  };
}

function publicMediaPublishingTopupOrder(order: {
  id: string;
  providerOrderId: string;
  paymentMethod: "alipay" | "wxpay" | "bank_transfer";
  amountTenThousandths: bigint | string;
  currency: string;
  state: z.infer<typeof mediaPublishingTopupOrderOutputSchema>["state"];
  checkoutExpiresAt: Date;
  paidAt: Date | null;
  creditedAt: Date | null;
  createdAt: Date;
}) {
  return {
    id: order.id,
    providerOrderId: order.providerOrderId,
    walletScope: "media_publishing" as const,
    paymentMethod: order.paymentMethod,
    amountTenThousandths: String(order.amountTenThousandths),
    currency: "CNY" as const,
    scale: 4 as const,
    state: order.state,
    checkoutExpiresAt: order.checkoutExpiresAt,
    paidAt: order.paidAt,
    creditedAt: order.creditedAt,
    createdAt: order.createdAt,
  };
}

function assertPaymentMethodConfigured(
  configuration: ApiContext["paymentConfiguration"],
  method: PaymentMethod,
) {
  if (!isPaymentMethodConfigured(configuration, method)) {
    throw new PaymentError(
      method === "bank_transfer" ? "对公转账暂未配置" : "在线支付暂未配置",
      "PAYMENT_PROVIDER_DISABLED",
      503,
    );
  }
}

function screenshotPolicy(value: number): 0 | 1 | 2 {
  if (value !== 0 && value !== 1 && value !== 2) {
    throw new RepositoryError(
      "INVALID_STATE",
      "Monitor contains an invalid screenshot policy",
    );
  }
  return value;
}

function publicTopupOrder(order: {
  id: string;
  providerOrderId: string;
  paymentMethod: PaymentMethod;
  amountTenThousandths: bigint | string;
  currency: string;
  state: z.infer<typeof topupOrderOutputSchema>["state"];
  checkoutExpiresAt: Date;
  paidAt: Date | null;
  creditedAt: Date | null;
  createdAt: Date;
}): z.infer<typeof topupOrderOutputSchema> {
  if (order.currency !== "CNY") {
    throw new PaymentError(
      "充值订单币种无效",
      "PAYMENT_ORDER_STATE_INVALID",
      409,
    );
  }
  return {
    id: order.id,
    providerOrderId: order.providerOrderId,
    paymentMethod: order.paymentMethod,
    amountTenThousandths: String(order.amountTenThousandths),
    currency: "CNY",
    scale: 4,
    state: order.state,
    checkoutExpiresAt: order.checkoutExpiresAt,
    paidAt: order.paidAt,
    creditedAt: order.creditedAt,
    createdAt: order.createdAt,
  };
}

function publicBankReview(
  review:
    | BankTransferReviewRecord
    | {
        id: string;
        orderId: string;
        status: "pending" | "approved" | "rejected";
        payerName: string;
        transferredAt: Date;
        remittanceReference: string;
        evidenceObjectKey?: string | null;
        submittedAt: Date;
        reviewedBy?: string | null;
        reviewReason?: string | null;
        reviewedAt?: Date | null;
      },
): z.infer<typeof bankTransferReviewOutputSchema> {
  return {
    id: review.id,
    orderId: review.orderId,
    status: review.status,
    payerName: review.payerName,
    transferredAt: review.transferredAt,
    remittanceReference: review.remittanceReference,
    evidenceSubmitted: Boolean(review.evidenceObjectKey),
    submittedAt: review.submittedAt,
    reviewedBy: review.reviewedBy ?? null,
    reviewReason: review.reviewReason ?? null,
    reviewedAt: review.reviewedAt ?? null,
  };
}

async function translateFinancialErrors<T>(
  operation: () => Promise<T>,
): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    if (error instanceof RepositoryError) {
      throw repositoryTrpcError(error);
    }
    if (error instanceof PaymentError) {
      const code =
        error.status === 404
          ? "NOT_FOUND"
          : error.status === 409
            ? "CONFLICT"
            : error.status === 502
              ? "BAD_GATEWAY"
              : error.status >= 500
                ? "SERVICE_UNAVAILABLE"
                : "BAD_REQUEST";
      throw new TRPCError({ code, message: error.message, cause: error });
    }
    throw error;
  }
}

function repositoryTrpcError(error: RepositoryError): TRPCError {
  const code = {
    NOT_FOUND: "NOT_FOUND",
    FORBIDDEN: "FORBIDDEN",
    CONFLICT: "CONFLICT",
    QUOTA_EXCEEDED: "PRECONDITION_FAILED",
    BALANCE_INSUFFICIENT: "PRECONDITION_FAILED",
    INVALID_STATE: "BAD_REQUEST",
  }[error.code] as
    | "NOT_FOUND"
    | "FORBIDDEN"
    | "CONFLICT"
    | "PRECONDITION_FAILED"
    | "BAD_REQUEST";
  return new TRPCError({ code, message: error.message, cause: error });
}

async function translateRepositoryErrors<T>(
  operation: () => Promise<T>,
): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    if (!(error instanceof RepositoryError)) throw error;
    throw repositoryTrpcError(error);
  }
}
