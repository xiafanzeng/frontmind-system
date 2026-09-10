import { monitoringClientRestOperation } from "../../trpc";
import { projectResourceUrl } from "@/lib/enterprise-project";
import type { AppRouter } from "@frontmind/monitoring-api";
import type { TRPCClient } from "@trpc/client";
import type { inferRouterOutputs } from "@trpc/server";

import { PublisherGatewayError, type PublisherGateway } from "./gateway";
import {
  publisherHtmlToPlainText,
  publisherPlainTextToHtml,
  sanitizePublisherEditorHtml,
} from "./editorContent";
import PublishingRoutes from "./PublishingRoutes";
import { formatPublishingMoney } from "./types";
import type {
  ArticleDetail,
  ArticleImage,
  ArticleStatus,
  ArticleSummary,
  MediaCapability,
  MediaFacets,
  MediaFilters,
  MediaResource,
  PublicationBatch,
  PublicationBatchSummary,
  PublicationDraft,
  PublicationFundStatus,
  PublicationItem,
  PublicationPreflight,
  SaveDraftTitlesInput,
} from "./types";

type ApiOutputs = inferRouterOutputs<AppRouter>;
type ApiArticle = ApiOutputs["publisher"]["articles"]["get"];
type ApiArticleSummary =
  ApiOutputs["publisher"]["articles"]["list"]["items"][number];
type ApiArticleAsset = ApiOutputs["publisher"]["articles"]["assets"][number];
type ApiArticleVersion =
  ApiOutputs["publisher"]["articles"]["versions"][number];
type ApiMedia = ApiOutputs["publisher"]["media"]["list"]["items"][number];
type ApiMediaPage = ApiOutputs["publisher"]["media"]["list"];
type ApiDraft = ApiOutputs["publisher"]["drafts"]["get"];
type ApiDraftMedia = ApiDraft["items"][number]["mediaResource"];
type ApiPreflight = ApiOutputs["publisher"]["drafts"]["preflight"];
type ApiBatch = ApiOutputs["publisher"]["batches"]["get"];
type ApiBatchListItem =
  ApiOutputs["publisher"]["batches"]["list"]["items"][number];

export type PublisherTrpcClient = TRPCClient<AppRouter>;

export type ServerBackedPublisherGatewayOptions = {
  fetch?: typeof globalThis.fetch;
  importPollIntervalMs?: number;
  importTimeoutMs?: number;
};

export type ServerBackedPublishingEntryProps = {
  client: PublisherTrpcClient;
};

/** @deprecated Use ServerBackedPublisherGatewayOptions. */
export type ProductionPublisherGatewayOptions =
  ServerBackedPublisherGatewayOptions;
/** @deprecated Use ServerBackedPublishingEntryProps. */
export type ProductionPublishingEntryProps = ServerBackedPublishingEntryProps;

type ArticleBundle = {
  article: ApiArticle;
  assets: ApiArticleAsset[];
  versions: ApiArticleVersion[];
};

type VersionContext = ArticleBundle & {
  version: ApiArticleVersion;
};

type DateLike = Date | string;

const DEFAULT_IMPORT_POLL_MS = 800;
const DEFAULT_IMPORT_TIMEOUT_MS = 3 * 60_000;

export function createServerBackedPublisherGateway(
  client: PublisherTrpcClient,
  options: ServerBackedPublisherGatewayOptions = {},
): PublisherGateway {
  const rawFetch = options.fetch ?? globalThis.fetch;
  const fetchImpl: typeof globalThis.fetch = (input, init) =>
    monitoringClientRestOperation(client).fetch(input, init, rawFetch);
  const importPollIntervalMs =
    options.importPollIntervalMs ?? DEFAULT_IMPORT_POLL_MS;
  const importTimeoutMs = options.importTimeoutMs ?? DEFAULT_IMPORT_TIMEOUT_MS;
  const draftCache = new Map<string, ApiDraft>();
  const articleCache = new Map<string, ArticleBundle>();
  const versionCache = new Map<string, VersionContext>();
  const mediaCache = new Map<string, ApiMedia>();
  const preflightRevisionCache = new Map<string, number>();

  async function loadArticleSummaries(signal?: AbortSignal) {
    const articles: ApiArticleSummary[] = [];
    let cursor: string | undefined;
    const seenCursors = new Set<string>();
    for (let page = 0; page < 20; page += 1) {
      const result = await client.publisher.articles.list.query(
        { limit: 100, ...(cursor ? { cursor } : {}) },
        { signal },
      );
      articles.push(...result.items);
      if (!result.nextCursor || seenCursors.has(result.nextCursor)) break;
      seenCursors.add(result.nextCursor);
      cursor = result.nextCursor;
    }
    return articles;
  }

  async function loadArticleBundle(
    articleId: string,
    signal?: AbortSignal,
    force = false,
  ): Promise<ArticleBundle> {
    if (!force) {
      const cached = articleCache.get(articleId);
      if (cached) return cached;
    }
    const [article, assets, versions] = await Promise.all([
      client.publisher.articles.get.query({ articleId }, { signal }),
      client.publisher.articles.assets.query({ articleId }, { signal }),
      client.publisher.articles.versions.query({ articleId }, { signal }),
    ]);
    const bundle = { article, assets, versions };
    articleCache.set(articleId, bundle);
    for (const version of versions) {
      versionCache.set(version.id, { ...bundle, version });
    }
    return bundle;
  }

  async function resolveVersion(
    articleVersionId: string,
    signal?: AbortSignal,
  ): Promise<VersionContext> {
    const cached = versionCache.get(articleVersionId);
    if (cached) return cached;

    const articles = await loadArticleSummaries(signal);
    const currentArticle = articles.find(
      (article) => article.currentVersionId === articleVersionId,
    );
    if (currentArticle) {
      const bundle = await loadArticleBundle(currentArticle.id, signal);
      const version = bundle.versions.find(({ id }) => id === articleVersionId);
      if (version) return { ...bundle, version };
    }

    // Historical drafts and batches may point at a version that is no longer
    // current. Walk owner-scoped version lists in small batches so direct URLs
    // remain reload-safe without introducing a browser-visible provider call.
    for (let offset = 0; offset < articles.length; offset += 8) {
      const candidates = articles.slice(offset, offset + 8);
      const lists = await Promise.all(
        candidates.map(async (article) => ({
          article,
          versions: await client.publisher.articles.versions.query(
            { articleId: article.id },
            { signal },
          ),
        })),
      );
      const found = lists.find(({ versions }) =>
        versions.some(({ id }) => id === articleVersionId),
      );
      if (found) {
        const bundle = await loadArticleBundle(found.article.id, signal);
        const version = bundle.versions.find(
          ({ id }) => id === articleVersionId,
        );
        if (version) return { ...bundle, version };
      }
    }
    throw new PublisherGatewayError("没有找到冻结的稿件版本", "not_found");
  }

  async function getRawDraft(draftId: string, signal?: AbortSignal) {
    const draft = await client.publisher.drafts.get.query(
      { draftId },
      { signal },
    );
    draftCache.set(draft.id, draft);
    return draft;
  }

  async function mapDraft(
    draft: ApiDraft,
    signal?: AbortSignal,
  ): Promise<PublicationDraft> {
    const context = await resolveVersion(draft.articleVersionId, signal);
    return {
      id: draft.id,
      articleId: context.article.id,
      articleVersionId: draft.articleVersionId,
      articleTitle: articleTitle(context.article),
      articleVersion: context.version.version,
      articleVersionHash: context.version.contentHash,
      articleContainsImages: context.version.containsImages,
      revision: draft.revision,
      titleMode: draft.titleMode ?? "per_media",
      ...(draft.sharedTitle ? { sharedTitle: draft.sharedTitle } : {}),
      items: draft.items.map((item) => ({
        media: mapMedia(item.mediaResource, {
          priceTenThousandths: item.selectedPriceTenThousandths,
          catalogRevision: item.selectedCatalogRevision,
        }),
        title: item.submissionTitle,
      })),
      updatedAt: toIso(draft.updatedAt),
    };
  }

  function mapBatch(batch: ApiBatch): PublicationBatch {
    const items = batch.items.map((item) => mapPublicationItem(item, batch));
    return buildBatchView(batch, items);
  }

  async function rawMediaPage(
    filters: MediaFilters,
    signal?: AbortSignal,
  ): Promise<ApiMediaPage> {
    const result = await client.publisher.media.list.query(
      mediaInput(filters),
      { signal },
    );
    result.items.forEach((media) => mediaCache.set(media.id, media));
    return result;
  }

  return {
    getDashboard(signal) {
      monitoringClientRestOperation(client);
      return translateGatewayErrors(async () => {
        const dashboard = await client.publisher.dashboard.query(undefined, {
          signal,
        });
        const recentBatches = dashboard.recentBatches.map(mapApiBatchSummary);
        const activeBatches =
          dashboard.processingBatches.map(mapApiBatchSummary);
        const articleViews = dashboard.resumableArticles.map(mapArticleSummary);
        return {
          wallet: {
            availableTenThousandths: dashboard.wallet.availableTenThousandths,
            reservedTenThousandths: dashboard.wallet.reservedTenThousandths,
            frozenTenThousandths: dashboard.wallet.frozenTenThousandths,
          },
          catalog: {
            activeRevision: dashboard.catalogRevision ?? "等待首次完整同步",
            mediaCount:
              dashboard.catalogCounts.news + dashboard.catalogCounts.selfMedia,
            newsCount: dashboard.catalogCounts.news,
            selfMediaCount: dashboard.catalogCounts.selfMedia,
            kindComplete: dashboard.kindComplete,
            lastSyncedAt: toIso(dashboard.catalogSyncedAt),
            stale:
              !dashboard.catalogSyncedAt ||
              Date.now() - new Date(dashboard.catalogSyncedAt).getTime() >
                12 * 60 * 60_000,
          },
          articleCount: dashboard.articleCount,
          actionableItemCount: dashboard.actionRequiredCount,
          resumableDraftCount: dashboard.resumableDraftCount,
          resumableDrafts: (dashboard.resumableDrafts ?? []).map((draft) => ({
            id: draft.id,
            articleTitle: draft.articleTitle,
            articleVersion: draft.articleVersion,
            status: draft.status,
            updatedAt: toIso(draft.updatedAt),
          })),
          processingBatchCount: dashboard.processingBatchCount,
          processingBatches: activeBatches,
          recentBatches,
          resumableArticles: articleViews
            .filter(({ status }) => status === "draft" || status === "frozen")
            .slice(0, Math.max(3, dashboard.resumableDraftCount ? 3 : 0)),
        };
      });
    },

    listArticles(signal) {
      monitoringClientRestOperation(client);
      return translateGatewayErrors(async () =>
        (await loadArticleSummaries(signal))
          .map(mapArticleSummary)
          .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt)),
      );
    },

    getArticle(articleId, signal) {
      monitoringClientRestOperation(client);
      return translateGatewayErrors(async () => {
        const detail = mapArticleDetail(
          await loadArticleBundle(articleId, signal, true),
        );
        return attachPrivateArticlePreviews(detail, fetchImpl, signal);
      });
    },

    importDocx(file, signal) {
      monitoringClientRestOperation(client);
      return translateGatewayErrors(async () => {
        if (!file.name.toLowerCase().endsWith(".docx")) {
          throw new PublisherGatewayError("请选择 DOCX 文件", "validation");
        }
        if (file.size < 1 || file.size > 20 * 1024 * 1024) {
          throw new PublisherGatewayError(
            "DOCX 文件必须为非空且不能超过 20 MiB",
            "validation",
          );
        }
        if (typeof fetchImpl !== "function") {
          throw new PublisherGatewayError(
            "当前环境不能上传文件",
            "unavailable",
          );
        }
        const body = new FormData();
        body.append("file", file);
        const response = await fetchImpl(
          "/api/monitoring/publisher/docx-imports",
          {
            method: "POST",
            headers: {},
            body,
            credentials: "same-origin",
            signal,
          },
        );
        if (!response.ok) throw await publisherHttpError(response);
        const payload: unknown = await response.json();
        const importId = readString(payload, "importId");
        if (!importId) {
          throw new PublisherGatewayError(
            "导入服务返回了无效结果",
            "unavailable",
          );
        }

        const deadline = Date.now() + importTimeoutMs;
        while (Date.now() < deadline) {
          throwIfAborted(signal);
          const status = await client.publisher.imports.get.query(
            { importId },
            { signal },
          );
          if (status.status === "ready") {
            if (!status.articleId) {
              throw new PublisherGatewayError(
                "稿件已解析，但没有生成可编辑文章",
                "unavailable",
              );
            }
            articleCache.delete(status.articleId);
            return { importId, articleId: status.articleId };
          }
          if (status.status === "rejected" || status.status === "failed") {
            const reason = [...status.blockers, ...status.warnings]
              .map(({ message }) => message)
              .filter(Boolean)
              .join("；");
            throw new PublisherGatewayError(
              reason || "DOCX 未通过安全与结构检查",
              "validation",
            );
          }
          await abortableDelay(importPollIntervalMs, signal);
        }
        throw new PublisherGatewayError(
          "DOCX 仍在后台解析，请稍后从稿件页继续",
          "unavailable",
        );
      });
    },

    uploadArticleImage(articleId, file, altText, signal) {
      monitoringClientRestOperation(client);
      return translateGatewayErrors(async () => {
        if (typeof fetchImpl !== "function") {
          throw new PublisherGatewayError(
            "当前环境不能上传图片",
            "unavailable",
          );
        }
        const body = new FormData();
        body.append("file", file);
        if (altText.trim()) body.append("altText", altText.trim());
        const response = await fetchImpl(
          `/api/monitoring/publisher/articles/${encodeURIComponent(articleId)}/assets`,
          {
            method: "POST",
            headers: {},
            body,
            credentials: "same-origin",
            signal,
          },
        );
        if (!response.ok) throw await publisherHttpError(response);
        const payload: unknown = await response.json();
        const assetId = readString(payload, "assetId");
        const contentType = readString(payload, "contentType");
        const publicPath = readString(payload, "publicPath");
        const width = readNumber(payload, "width");
        const height = readNumber(payload, "height");
        if (!assetId || !publicPath || !width || !height) {
          throw new PublisherGatewayError(
            "图片服务返回了无效结果",
            "unavailable",
          );
        }
        const image: ArticleImage = {
          id: assetId,
          fileName:
            file.name ||
            `正文图片.${contentType === "image/png" ? "png" : "jpg"}`,
          altText: altText.trim(),
          width,
          height,
          sourceUrl: publicPath,
        };
        return fetchPrivateArticlePreview(
          image,
          articleId,
          fetchImpl,
          signal,
          true,
        );
      });
    },

    saveArticle(input) {
      monitoringClientRestOperation(client);
      return translateGatewayErrors(async () => {
        const canonicalHtml = sanitizePublisherEditorHtml(
          input.bodyHtml,
          input.images,
        );
        await client.publisher.articles.save.mutate({
          articleId: input.articleId,
          expectedRevision: input.expectedRevision,
          workingName: input.title,
          suggestedTitle: input.title,
          editorJson: input.editorJson,
          canonicalHtml,
          plainText: publisherHtmlToPlainText(canonicalHtml),
        });
        articleCache.delete(input.articleId);
        return mapArticleDetail(
          await loadArticleBundle(input.articleId, undefined, true),
        );
      });
    },

    freezeArticle(articleId, expectedRevision) {
      monitoringClientRestOperation(client);
      return translateGatewayErrors(async () => {
        await client.publisher.articles.freeze.mutate({
          articleId,
          expectedRevision,
          idempotencyKey: `publisher:freeze:${articleId}:${expectedRevision}`,
        });
        articleCache.delete(articleId);
        return mapArticleDetail(
          await loadArticleBundle(articleId, undefined, true),
        );
      });
    },

    getMediaFacets(filters, signal) {
      monitoringClientRestOperation(client);
      return translateGatewayErrors(async () => {
        const mediaApi = client.publisher.media as unknown as {
          facets: {
            query(
              input: Record<string, unknown>,
              options: { signal?: AbortSignal },
            ): Promise<{
              kindCounts: { news: number; selfMedia: number };
              platforms: Array<{ value: string; count: number }>;
              taxonomies: Array<{ value: string; count: number }>;
              mediaTypes: Array<{ value: string; count: number }>;
              areas: Array<{ value: string; count: number }>;
              includeTypes: Array<{ value: string; count: number }>;
              publishSpeeds: Array<{ value: string; count: number }>;
              entryTypes: Array<{ value: string; count: number }>;
              linkTypes: Array<{ value: string; count: number }>;
              imageSupports: Array<{ value: string; count: number }>;
              pcWeightThresholds: Array<{ value: string; count: number }>;
              includeRateThresholds: Array<{ value: string; count: number }>;
              successRateThresholds: Array<{ value: string; count: number }>;
              recommendedOptions: Array<{ value: string; count: number }>;
              authenticatedOptions: Array<{ value: string; count: number }>;
              festivalPublishableOptions: Array<{
                value: string;
                count: number;
              }>;
              catalogRevision: string | null;
              catalogSyncedAt: Date | string | null;
              kindComplete: boolean;
            }>;
          };
        };
        const resolvedFilters: MediaFilters = filters ?? {
          query: "",
          kind: "news",
          page: 1,
          pageSize: 50,
        };
        const result = await mediaApi.facets.query(
          mediaInput(resolvedFilters),
          {
            signal,
          },
        );
        const options = (items: Array<{ value: string; count: number }>) =>
          items.map((item) => ({ ...item, label: item.value }));
        const labeledOptions = (
          items: Array<{ value: string; count: number }>,
          labels: Record<string, string>,
        ) =>
          items.map((item) => ({
            ...item,
            label: labels[item.value] ?? item.value,
          }));
        const mapped: MediaFacets = {
          kinds: {
            news: result.kindCounts.news,
            self_media: result.kindCounts.selfMedia,
          },
          platforms: options(result.platforms),
          taxonomies: options(result.taxonomies),
          mediaTypes: options(result.mediaTypes),
          areas: options(result.areas),
          includeTypes: options(result.includeTypes),
          publishSpeeds: options(result.publishSpeeds),
          entryTypes: options(result.entryTypes),
          linkTypes: options(result.linkTypes),
          imageSupports: labeledOptions(
            result.imageSupports.filter((item) => item.value !== "unknown"),
            {
              verified: "支持图文",
              unsupported: "仅文字",
            },
          ),
          pcWeightThresholds: result.pcWeightThresholds.map((item) => ({
            ...item,
            label: `${item.value} 以上`,
          })),
          includeRateThresholds: result.includeRateThresholds.map((item) => ({
            ...item,
            label: `${item.value}% 以上`,
          })),
          successRateThresholds: result.successRateThresholds.map((item) => ({
            ...item,
            label: `${item.value}% 以上`,
          })),
          recommendedOptions: labeledOptions(result.recommendedOptions, {
            true: "平台推荐",
            false: "非推荐",
          }),
          authenticatedOptions: labeledOptions(result.authenticatedOptions, {
            true: "已认证",
            false: "未认证",
          }),
          festivalPublishableOptions: labeledOptions(
            result.festivalPublishableOptions,
            { true: "节假日可发", false: "节假日不可发" },
          ),
          catalog: {
            activeRevision: result.catalogRevision ?? "等待首次完整同步",
            mediaCount: result.kindCounts.news + result.kindCounts.selfMedia,
            newsCount: result.kindCounts.news,
            selfMediaCount: result.kindCounts.selfMedia,
            kindComplete: result.kindComplete,
            lastSyncedAt: toIso(result.catalogSyncedAt),
            stale:
              !result.catalogSyncedAt ||
              Date.now() - new Date(result.catalogSyncedAt).getTime() >
                12 * 60 * 60_000,
          },
        };
        return mapped;
      });
    },

    listMedia(filters, signal) {
      monitoringClientRestOperation(client);
      return translateGatewayErrors(async () => {
        const result = await rawMediaPage(filters, signal);
        return {
          items: result.items.map((item) => mapMedia(item)),
          total: result.total,
          page: result.page,
          pageSize: result.pageSize,
          catalog: catalogFreshness(result, result.total),
        };
      });
    },

    createDraft(articleVersionId, mediaIds, idempotencyKey) {
      monitoringClientRestOperation(client);
      return translateGatewayErrors(async () => {
        const context = await resolveVersion(articleVersionId);
        const defaultTitle = articleTitle(context.article);
        const saved = await client.publisher.drafts.save.mutate({
          articleVersionId,
          ...(idempotencyKey ? { idempotencyKey } : {}),
          expectedRevision: 0,
          titleMode: "single",
          sharedTitle: defaultTitle,
          items: mediaIds.map((mediaResourceId) => ({
            mediaResourceId,
            submissionTitle: defaultTitle,
          })),
        });
        draftCache.set(saved.id, saved);
        return mapDraft(saved);
      });
    },

    getDraft(draftId, signal) {
      monitoringClientRestOperation(client);
      return translateGatewayErrors(async () =>
        mapDraft(await getRawDraft(draftId, signal), signal),
      );
    },

    updateDraftMedia(draftId, mediaIds, expectedRevision) {
      monitoringClientRestOperation(client);
      return translateGatewayErrors(async () => {
        const draft = draftCache.get(draftId) ?? (await getRawDraft(draftId));
        if (draft.revision !== expectedRevision) {
          throw new PublisherGatewayError(
            "草稿已在其他窗口更新，请刷新后继续",
            "conflict",
          );
        }
        const previous = new Map(
          draft.items.map((item) => [
            item.mediaResource.id,
            item.submissionTitle,
          ]),
        );
        const saved = await client.publisher.drafts.save.mutate({
          draftId,
          articleVersionId: draft.articleVersionId,
          expectedRevision,
          titleMode: draft.titleMode,
          sharedTitle: draft.sharedTitle,
          items: mediaIds.map((mediaResourceId) => ({
            mediaResourceId,
            ...(previous.get(mediaResourceId)
              ? { submissionTitle: previous.get(mediaResourceId)! }
              : {}),
          })),
        });
        draftCache.set(saved.id, saved);
        return mapDraft(saved);
      });
    },

    refreshDraftMedia(draftId, expectedRevision) {
      monitoringClientRestOperation(client);
      return translateGatewayErrors(async () => {
        const saved = await client.publisher.drafts.refreshMedia.mutate({
          draftId,
          expectedRevision,
        });
        draftCache.set(saved.id, saved);
        return mapDraft(saved);
      });
    },

    saveDraftTitles(draftId, input) {
      monitoringClientRestOperation(client);
      return translateGatewayErrors(async () => {
        const draft = draftCache.get(draftId) ?? (await getRawDraft(draftId));
        const modern = isSaveDraftTitlesInput(input) ? input : undefined;
        const titleMode = modern?.mode ?? "per_media";
        const titles: Record<string, string> =
          modern?.titles ?? (input as Record<string, string>);
        const expectedRevision = modern?.expectedRevision ?? draft.revision;
        const draftsApi = client.publisher.drafts as unknown as {
          saveTitles: {
            mutate(value: {
              draftId: string;
              expectedRevision: number;
              titleMode: "single" | "per_media";
              sharedTitle?: string;
              titles?: Array<{
                mediaResourceId: string;
                submissionTitle: string;
              }>;
            }): Promise<ApiDraft>;
          };
        };
        const saveInput = {
          draftId,
          expectedRevision,
          titleMode,
          ...(modern && titleMode === "single" && modern.sharedTitle
            ? { sharedTitle: modern.sharedTitle }
            : {}),
          ...(titleMode === "per_media"
            ? {
                titles: draft.items.map((item) => ({
                  mediaResourceId: item.mediaResource.id,
                  submissionTitle:
                    titles[item.mediaResource.id] ?? item.submissionTitle,
                })),
              }
            : {}),
        };
        const saved = draftsApi.saveTitles
          ? await draftsApi.saveTitles.mutate(saveInput)
          : await client.publisher.drafts.save.mutate({
              draftId,
              articleVersionId: draft.articleVersionId,
              expectedRevision,
              titleMode,
              ...(saveInput.sharedTitle
                ? { sharedTitle: saveInput.sharedTitle }
                : {}),
              items: draft.items.map((item) => ({
                mediaResourceId: item.mediaResource.id,
                submissionTitle:
                  titles[item.mediaResource.id] ?? item.submissionTitle,
              })),
            });
        draftCache.set(saved.id, saved);
        return mapDraft(saved);
      });
    },

    preflightDraft(draftId, signal) {
      monitoringClientRestOperation(client);
      return translateGatewayErrors(async () => {
        const draft =
          draftCache.get(draftId) ?? (await getRawDraft(draftId, signal));
        const [preflight, billing] = await Promise.all([
          client.publisher.drafts.preflight.mutate(
            { draftId, expectedDraftRevision: draft.revision },
            { signal },
          ),
          client.mediaPublishing.billing.summary.query(undefined, { signal }),
        ]);
        preflightRevisionCache.set(
          `${draftId}:${preflight.preflightRevision}`,
          draft.revision,
        );
        return mapPreflight(
          preflight,
          draft,
          await resolveVersion(preflight.articleVersionId, signal),
          billing.reservedTenThousandths,
          billing.frozenTenThousandths,
        );
      });
    },

    submitDraft(input) {
      monitoringClientRestOperation(client);
      return translateGatewayErrors(async () => {
        const expectedDraftRevision =
          preflightRevisionCache.get(
            `${input.draftId}:${input.preflightRevision}`,
          ) ??
          (draftCache.get(input.draftId) ?? (await getRawDraft(input.draftId)))
            .revision;
        const submitted = await client.publisher.drafts.submit.mutate({
          draftId: input.draftId,
          expectedDraftRevision,
          preflightRevision: input.preflightRevision,
          quoteFingerprint: input.quoteFingerprint,
          idempotencyKey: input.idempotencyKey,
          ...(input.acknowledged
            ? { liveConfirmationAccepted: true as const }
            : {}),
        });
        const batch = await client.publisher.batches.get.query({
          batchId: submitted.batchId,
        });
        return mapBatch(batch);
      });
    },

    listBatches(filters, signal) {
      monitoringClientRestOperation(client);
      return translateGatewayErrors(async () => {
        const resolved = filters ?? {
          query: "",
          kind: "",
          status: "",
          from: "",
          to: "",
          page: 1,
          pageSize: 20,
        };
        const listed = await client.publisher.batches.list.query(
          {
            page: resolved.page,
            pageSize: resolved.pageSize,
            limit: resolved.pageSize,
            ...(resolved.query ? { query: resolved.query } : {}),
            ...(resolved.kind ? { kind: resolved.kind } : {}),
            ...(resolved.status
              ? { status: resolved.status as ApiBatchListItem["status"] }
              : {}),
            ...(resolved.from
              ? { from: new Date(`${resolved.from}T00:00:00.000Z`) }
              : {}),
            ...(resolved.to
              ? { to: new Date(`${resolved.to}T23:59:59.999Z`) }
              : {}),
          },
          { signal },
        );
        return {
          items: listed.items.map(mapApiBatchSummary),
          total: listed.total,
          page: listed.page,
          pageSize: listed.pageSize,
        };
      });
    },

    getBatch(batchId, signal) {
      monitoringClientRestOperation(client);
      return translateGatewayErrors(async () =>
        mapBatch(
          await client.publisher.batches.get.query({ batchId }, { signal }),
        ),
      );
    },

    batchCsvUrl(batchId) {
      return projectResourceUrl(
        `/api/monitoring/publisher/batches/${encodeURIComponent(batchId)}.csv`,
      );
    },
  };
}

/** @deprecated Use createServerBackedPublisherGateway. */
export const createProductionPublisherGateway =
  createServerBackedPublisherGateway;

const gatewayCache = new WeakMap<PublisherTrpcClient, PublisherGateway>();

export default function ServerBackedPublishingEntry({
  client,
}: ServerBackedPublishingEntryProps) {
  let gateway = gatewayCache.get(client);
  if (!gateway) {
    gateway = createServerBackedPublisherGateway(client);
    gatewayCache.set(client, gateway);
  }
  return <PublishingRoutes gateway={gateway} />;
}

function mapArticleSummary(article: ApiArticleSummary): ArticleSummary {
  return {
    id: article.id,
    title: articleTitle(article),
    status: articleStatus(article.status),
    currentVersion: article.currentVersion ?? 0,
    ...(article.currentVersionId
      ? { currentVersionId: article.currentVersionId }
      : {}),
    wordCount: 0,
    imageCount: article.containsImages ? 1 : 0,
    updatedAt: toIso(article.updatedAt),
  };
}

function mapArticleDetail(bundle: ArticleBundle): ArticleDetail {
  const { article, assets, versions } = bundle;
  const currentVersion = versions.find(
    ({ id }) => id === article.currentVersionId,
  );
  const attributesByAsset = imageAttributes(article.canonicalHtml);
  const bodyText = article.plainText ?? "";
  return {
    id: article.id,
    title: articleTitle(article),
    status: articleStatus(article.status),
    currentVersion: article.currentVersion ?? currentVersion?.version ?? 0,
    ...(article.currentVersionId
      ? { currentVersionId: article.currentVersionId }
      : {}),
    ...(currentVersion?.contentHash || article.contentHash
      ? {
          currentVersionHash:
            currentVersion?.contentHash ?? article.contentHash!,
        }
      : {}),
    wordCount: nonWhitespaceLength(bodyText),
    imageCount: assets.length,
    updatedAt: toIso(article.updatedAt),
    revision: article.revision,
    bodyText,
    bodyHtml: article.canonicalHtml ?? publisherPlainTextToHtml(bodyText),
    editorJson: isRecord(article.editorJson)
      ? article.editorJson
      : { type: "doc", content: [] },
    images: assets.map((asset, index) => ({
      id: asset.id,
      fileName: `正文图片 ${index + 1}.${asset.mimeType === "image/png" ? "png" : "jpg"}`,
      altText: attributesByAsset.get(asset.id)?.alt ?? asset.altText ?? "",
      width: asset.width,
      height: asset.height,
      ...(attributesByAsset.get(asset.id)?.src
        ? { sourceUrl: attributesByAsset.get(asset.id)!.src }
        : {}),
    })),
    versions: versions.map((version) => ({
      id: version.id,
      version: version.version,
      hash: version.contentHash,
      containsImages: version.containsImages,
      frozen: true,
      createdAt: toIso(version.createdAt),
      createdBy: "当前账号",
    })),
    importChecks: {
      docxSafe: true,
      externalLinkCount: (article.canonicalHtml?.match(/<a\b/giu) ?? []).length,
      structureValid: Boolean(article.canonicalHtml || !bodyText),
    },
  };
}

function articleTitle(article: {
  workingName: string;
  suggestedTitle: string | null;
}) {
  return article.suggestedTitle?.trim() || article.workingName;
}

function articleStatus(status: ApiArticle["status"]): ArticleStatus {
  return status === "draft" ? "draft" : "frozen";
}

function mapMedia(
  media: ApiMedia | ApiDraftMedia,
  snapshot?: { priceTenThousandths: string; catalogRevision: string },
): MediaResource {
  return {
    id: media.id,
    externalResourceId: media.externalResourceId,
    name: media.name,
    shortName: compactMediaName(media.name),
    kind: media.kind,
    platform: media.platform || "—",
    taxonomy: media.taxonomy || "—",
    mediaType: media.mediaType || "",
    channel: media.taxonomy || media.platform || media.mediaType || "综合",
    region: media.area || "—",
    ...(media.caseUrl ? { caseUrl: media.caseUrl } : {}),
    ...(media.logoUrl ? { logoUrl: media.logoUrl } : {}),
    logoSource: media.logoSource ?? "generated_fallback",
    logoResolutionStatus: media.logoResolutionStatus ?? "missing",
    titleLimit: media.titleLimit ?? 200,
    priceTenThousandths:
      snapshot?.priceTenThousandths ?? media.priceTenThousandths,
    turnaround: media.publishSpeed || "—",
    ...(media.successRateBasisPoints === null
      ? {}
      : { successRate: Math.round(media.successRateBasisPoints / 100) }),
    ...(media.includeRateBasisPoints === null
      ? {}
      : { includeRate: Math.round(media.includeRateBasisPoints / 100) }),
    ...(media.includeType ? { includeType: media.includeType } : {}),
    ...(media.entryType ? { entryType: media.entryType } : {}),
    ...(media.linkType ? { linkType: media.linkType } : {}),
    ...(media.pcWeight === null ? {} : { pcWeight: media.pcWeight }),
    ...(media.authenticated === null
      ? {}
      : { authenticated: media.authenticated }),
    ...(media.festivalPublishable === null
      ? {}
      : { festivalAvailable: media.festivalPublishable }),
    ...(media.recommended === null ? {} : { recommended: media.recommended }),
    recommendationTags: media.recommendationTags ?? [],
    platformRecommendationTags: media.platformRecommendationTags ?? [],
    ...(media.recommendationRemark
      ? { recommendationRemark: media.recommendationRemark }
      : {}),
    ...(media.authenticationType
      ? { authenticationType: media.authenticationType }
      : {}),
    ...(media.authenticationDescription
      ? { authenticationDescription: media.authenticationDescription }
      : {}),
    ...(media.remark ? { remark: media.remark } : {}),
    ...(media.fanCount === null ? {} : { followers: Number(media.fanCount) }),
    ...(media.likeCount === null ? {} : { likes: Number(media.likeCount) }),
    ...(media.publishCount === null
      ? {}
      : { publishedCount: Number(media.publishCount) }),
    capability: mediaCapability(media.imageSupport),
    active: media.isActive,
    catalogRevision: snapshot?.catalogRevision ?? media.catalogRevision,
  };
}

function mediaCapability(
  value: (ApiMedia | ApiDraftMedia)["imageSupport"],
): MediaCapability {
  if (value === "verified") return "image";
  if (value === "unsupported") return "text";
  return "image_pending";
}

function compactMediaName(name: string) {
  return (
    Array.from(name.replace(/[\s·（）()_-]+/gu, ""))
      .slice(0, 4)
      .join("") || "媒体"
  );
}

function mapPreflight(
  preflight: ApiPreflight,
  draft: ApiDraft,
  context: VersionContext,
  reservedTenThousandths: string,
  frozenTenThousandths: string,
): PublicationPreflight {
  const draftItems = new Map(
    draft.items.map((item) => [item.mediaResource.id, item]),
  );
  const assets = context.assets;
  const items = preflight.items.map((item) => {
    const draftItem = draftItems.get(item.mediaResourceId);
    const media = draftItem
      ? mapMedia(draftItem.mediaResource, {
          priceTenThousandths: item.priceTenThousandths,
          catalogRevision: preflight.catalogRevision,
        })
      : fallbackMedia(
          item.mediaResourceId,
          item.mediaName,
          item.priceTenThousandths,
        );
    const blockers = item.blockers.map(({ code, message }) => {
      if (code === "PRICE_CHANGED" && draftItem) {
        return `客户单价已由 ${formatPublishingMoney(draftItem.selectedPriceTenThousandths)} 调整为 ${formatPublishingMoney(item.priceTenThousandths)}`;
      }
      if (code === "MEDIA_KIND_CHANGED") {
        return `${message}（当前类别：${item.mediaKind === "self_media" ? "自媒体" : "软文媒体"}）`;
      }
      if (code === "MEDIA_CAPABILITY_CHANGED") {
        return `${message}（当前图文能力：${item.imageSupport}）`;
      }
      if (code === "MEDIA_METADATA_CHANGED") {
        return `${message}（当前媒体：${item.mediaName}）`;
      }
      return message;
    });
    const warnings = item.warnings.map(({ message }) => message);
    return {
      media,
      title: item.submissionTitle,
      priceTenThousandths: item.priceTenThousandths,
      checks: [
        {
          label: "媒体与目录有效",
          passed: !hasIssue(item.blockers, /media|catalog|目录|媒体/iu),
        },
        {
          label: "独立标题有效",
          passed: !hasIssue(item.blockers, /title|标题/iu),
        },
        {
          label: "正文能力匹配",
          passed: !hasIssue(item.blockers, /image|content|图片|正文/iu),
        },
      ],
      blockerCodes: item.blockers.map(({ code }) => code),
      blockers,
      warnings,
    };
  });
  const globalBlockers = preflight.blockers.map(({ message }) => message);
  const globalWarnings = preflight.warnings.map(({ message }) => message);
  const frozenImageAttributes = imageAttributes(preflight.articleCanonicalHtml);
  const frozenImages = assets
    .filter((asset) => frozenImageAttributes.has(asset.id))
    .map((asset) => ({
      id: asset.id,
      altText: frozenImageAttributes.get(asset.id)?.alt ?? asset.altText ?? "",
      ...(frozenImageAttributes.get(asset.id)?.src
        ? { sourceUrl: frozenImageAttributes.get(asset.id)!.src }
        : {}),
    }));
  return {
    revision: preflight.preflightRevision,
    draftRevision: draft.revision,
    quoteFingerprint: preflight.quoteFingerprint,
    mode: preflight.mode,
    expiresAt: toIso(preflight.expiresAt),
    article: {
      id: context.article.id,
      title: articleTitle(context.article),
      version: context.version.version,
      versionId: preflight.articleVersionId,
      hash: preflight.articleContentHash,
      wordCount: nonWhitespaceLength(preflight.articlePlainText),
      imageCount: frozenImages.length,
      bodyHtml: preflight.articleCanonicalHtml,
      images: frozenImages,
    },
    catalogRevision: preflight.catalogRevision,
    titleMode: preflight.titleMode,
    kindCounts: preflight.kindCounts,
    items,
    totalTenThousandths: preflight.totalTenThousandths,
    wallet: {
      availableTenThousandths: preflight.availableTenThousandths,
      reservedTenThousandths,
      frozenTenThousandths,
    },
    availableAfterTenThousandths:
      preflight.availableAfterReservationTenThousandths,
    blockerCodes: [
      ...new Set([
        ...preflight.blockers.map(({ code }) => code),
        ...preflight.items.flatMap((item) =>
          item.blockers.map(({ code }) => code),
        ),
        ...(preflight.sufficientFunds ? [] : ["INSUFFICIENT_BALANCE"]),
      ]),
    ],
    blockers: [
      ...globalBlockers,
      ...(preflight.sufficientFunds ? [] : ["媒体发布钱包可用余额不足"]),
    ],
    warnings: globalWarnings,
    gates: [
      {
        label: "冻结版本与内容哈希一致",
        passed: preflight.articleContentHash === context.version.contentHash,
      },
      {
        label: "媒体目录与价格已重新核验",
        passed: !hasIssue(preflight.blockers, /catalog|price|目录|价格/iu),
      },
      { label: "媒体发布钱包余额充足", passed: preflight.sufficientFunds },
      {
        label: `运行模式由服务端确定：${preflight.mode.toUpperCase()}`,
        passed: true,
      },
    ],
  };
}

function mapPublicationItem(
  item: ApiBatch["items"][number],
  batch: ApiBatch,
): PublicationItem {
  const resultMessage =
    item.failureReason ||
    item.actionRequiredReason ||
    (item.status === "failed" && item.fundsStatus === "released"
      ? "金额已退回可用余额"
      : item.status === "submission_unknown"
        ? "待对账冻结，系统不会自动重投"
        : undefined);
  return {
    id: item.id,
    media: fallbackMedia(item.id, item.mediaName, item.priceTenThousandths, {
      kind: item.mediaKind,
      platform: item.platform,
      taxonomy: item.taxonomy,
      area: item.area,
      logoUrl: item.logoUrl,
      logoSource: item.logoSource,
      logoResolutionStatus: item.logoResolutionStatus ?? "missing",
    }),
    title: item.submissionTitle,
    status: item.status,
    fundStatus: item.fundsStatus,
    priceTenThousandths: item.priceTenThousandths,
    ...(item.publishedUrl ? { resultUrl: item.publishedUrl } : {}),
    ...(resultMessage ? { resultMessage } : {}),
    updatedAt: toIso(item.completedAt ?? item.submittedAt ?? batch.updatedAt),
  };
}

function buildBatchView(
  batch: ApiBatch,
  items: PublicationItem[],
): PublicationBatch {
  const sumByFunds = (status: PublicationFundStatus) =>
    items
      .filter((item) => item.fundStatus === status)
      .reduce((total, item) => total + BigInt(item.priceTenThousandths), 0n)
      .toString();
  return {
    id: batch.id,
    articleTitle:
      batch.article.suggestedTitle?.trim() || batch.article.workingName,
    articleVersion: batch.article.version,
    articleVersionId: batch.articleVersionId,
    articleVersionHash: batch.article.contentHash,
    mode: batch.mode,
    status: batch.status,
    itemCount: items.length,
    successCount: items.filter(({ status }) => status === "success").length,
    failedCount: items.filter(
      ({ status }) => status === "failed" || status === "auth_blocked",
    ).length,
    unknownCount: items.filter(
      ({ status }) =>
        status === "submission_unknown" || status === "action_required",
    ).length,
    newsCount: batch.kindCounts.news,
    selfMediaCount: batch.kindCounts.selfMedia,
    titleMode: batch.titleMode,
    totalTenThousandths: batch.quotedTotalTenThousandths,
    consumedTenThousandths: sumByFunds("consumed"),
    releasedTenThousandths: sumByFunds("released"),
    frozenTenThousandths: sumByFunds("frozen"),
    createdAt: toIso(batch.createdAt),
    items,
  };
}

function mapApiBatchSummary(batch: ApiBatchListItem): PublicationBatchSummary {
  return {
    id: batch.id,
    articleTitle:
      batch.article.suggestedTitle?.trim() || batch.article.workingName,
    articleVersion: batch.article.version,
    mode: batch.mode,
    status: batch.status,
    itemCount: batch.itemCount,
    successCount: batch.successCount,
    failedCount: batch.failedCount,
    unknownCount: batch.unknownCount,
    newsCount: batch.kindCounts.news,
    selfMediaCount: batch.kindCounts.selfMedia,
    titleMode: batch.titleMode,
    totalTenThousandths: batch.quotedTotalTenThousandths,
    consumedTenThousandths: batch.consumedTenThousandths,
    releasedTenThousandths: batch.releasedTenThousandths,
    frozenTenThousandths: batch.frozenTenThousandths,
    createdAt: toIso(batch.createdAt),
  };
}

function fallbackMedia(
  id: string,
  name: string,
  price: string,
  metadata?: {
    kind?: "news" | "self_media" | "unknown";
    platform?: string | null;
    taxonomy?: string | null;
    area?: string | null;
    logoUrl?: string | null;
    logoSource?: MediaResource["logoSource"];
    logoResolutionStatus?: MediaResource["logoResolutionStatus"];
  },
): MediaResource {
  return {
    id,
    externalResourceId: id,
    name,
    shortName: compactMediaName(name),
    kind: metadata?.kind ?? "unknown",
    platform: metadata?.platform ?? "—",
    taxonomy: metadata?.taxonomy ?? "—",
    mediaType:
      metadata?.kind === "self_media"
        ? "自媒体"
        : metadata?.kind === "news"
          ? "软文媒体"
          : "历史媒体",
    channel: metadata?.taxonomy ?? "冻结媒体",
    region: metadata?.area ?? "—",
    ...(metadata?.logoUrl ? { logoUrl: metadata.logoUrl } : {}),
    logoSource: metadata?.logoSource ?? "generated_fallback",
    logoResolutionStatus: metadata?.logoResolutionStatus ?? "missing",
    titleLimit: 200,
    priceTenThousandths: price,
    turnaround: "以媒体审核为准",
    successRate: 0,
    capability: "text",
    active: true,
    catalogRevision: "frozen",
  };
}

function catalogFreshness(
  result: Pick<
    ApiMediaPage,
    "catalogRevision" | "catalogSyncedAt" | "catalogStale" | "kindComplete"
  >,
  mediaCount: number,
) {
  return {
    activeRevision: result.catalogRevision ?? "等待首次完整同步",
    mediaCount,
    kindComplete: result.kindComplete,
    lastSyncedAt: toIso(result.catalogSyncedAt ?? new Date(0)),
    stale: result.catalogStale,
  };
}

function mediaInput(filters: MediaFilters) {
  const batchQuery = filters.batchQuery
    ? parseMediaBatchQuery(filters.batchQuery)
    : [];
  const price =
    filters.price === "under_100"
      ? { maximumPriceTenThousandths: "999999" }
      : filters.price === "100_300"
        ? {
            minimumPriceTenThousandths: "1000000",
            maximumPriceTenThousandths: "3000000",
          }
        : filters.price === "over_300"
          ? { minimumPriceTenThousandths: "3000001" }
          : {};
  const imageSupport: ApiMedia["imageSupport"] | undefined =
    filters.capability === "image"
      ? "verified"
      : filters.capability === "text"
        ? "unsupported"
        : filters.capability === "image_pending"
          ? "unknown"
          : undefined;
  return {
    page: filters.page,
    pageSize: filters.pageSize,
    limit: filters.pageSize,
    kind: filters.kind ?? "news",
    ...(filters.query ? { query: filters.query } : {}),
    ...(batchQuery.length ? { batchQuery } : {}),
    ...(filters.query || batchQuery.length ? { includeInactive: true } : {}),
    ...(filters.platform ? { platform: filters.platform } : {}),
    ...(filters.taxonomy || filters.channel
      ? { taxonomy: filters.taxonomy || filters.channel }
      : {}),
    ...(filters.mediaType ? { mediaType: filters.mediaType } : {}),
    ...(filters.area || filters.region
      ? { area: filters.area || filters.region }
      : {}),
    ...(filters.recommended === "true" ? { recommended: true } : {}),
    ...(filters.includeType ? { includeType: filters.includeType } : {}),
    ...(filters.publishSpeed ? { publishSpeed: filters.publishSpeed } : {}),
    ...(filters.entryType ? { entryType: filters.entryType } : {}),
    ...(filters.linkType ? { linkType: filters.linkType } : {}),
    ...(filters.pcWeight ? { minimumPcWeight: Number(filters.pcWeight) } : {}),
    ...(filters.includeRate
      ? { minimumIncludeRate: Number(filters.includeRate) }
      : {}),
    ...(filters.successRate
      ? { minimumSuccessRate: Number(filters.successRate) }
      : {}),
    ...(filters.authenticated === "true" ? { authenticated: true } : {}),
    ...(filters.festival === "true" ? { festivalPublishable: true } : {}),
    ...(filters.priceMin
      ? {
          minimumPriceTenThousandths: String(
            Math.round(Number(filters.priceMin) * 10_000),
          ),
        }
      : {}),
    ...(filters.priceMax
      ? {
          maximumPriceTenThousandths: String(
            Math.round(Number(filters.priceMax) * 10_000),
          ),
        }
      : {}),
    sort: filters.sort ?? "recommended",
    ...(imageSupport ? { imageSupport } : {}),
    ...price,
  } as const;
}

function parseMediaBatchQuery(value: string) {
  return [
    ...new Set(
      value
        .split(/[\n,，]/u)
        .map((item) => item.trim())
        .filter(Boolean),
    ),
  ].slice(0, 50);
}

function imageAttributes(canonicalHtml: string | null) {
  const values = new Map<string, { alt: string; src: string }>();
  for (const tag of canonicalHtml?.match(/<img\b[^>]*>/giu) ?? []) {
    const id = tag
      .match(/\bdata-asset-id=(?:"([^"]+)"|'([^']+)')/iu)
      ?.slice(1)
      .find(Boolean);
    const alt = tag
      .match(/\balt=(?:"([^"]*)"|'([^']*)')/iu)
      ?.slice(1)
      .find((value) => value !== undefined);
    const src = tag
      .match(/\bsrc=(?:"([^"]*)"|'([^']*)')/iu)
      ?.slice(1)
      .find((value) => value !== undefined);
    if (id && src !== undefined) {
      values.set(id, {
        alt: decodeHtmlAttribute(alt ?? ""),
        src: decodeHtmlAttribute(src),
      });
    }
  }
  return values;
}

function decodeHtmlAttribute(value: string) {
  return value
    .replace(/&quot;/giu, '"')
    .replace(/&#39;|&apos;/giu, "'")
    .replace(/&lt;/giu, "<")
    .replace(/&gt;/giu, ">")
    .replace(/&amp;/giu, "&");
}

function nonWhitespaceLength(value: string) {
  return Array.from(value.replace(/\s/gu, "")).length;
}

function toIso(value: DateLike | null | undefined): string {
  if (!value) return new Date(0).toISOString();
  return value instanceof Date
    ? value.toISOString()
    : new Date(value).toISOString();
}

function hasIssue(
  issues: readonly { code: string; message: string }[],
  pattern: RegExp,
) {
  return issues.some(({ code, message }) => pattern.test(`${code} ${message}`));
}

function readString(value: unknown, key: string) {
  if (!value || typeof value !== "object") return undefined;
  const candidate = (value as Record<string, unknown>)[key];
  return typeof candidate === "string" ? candidate : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function readNumber(value: unknown, key: string) {
  if (!value || typeof value !== "object") return undefined;
  const candidate = (value as Record<string, unknown>)[key];
  return typeof candidate === "number" && Number.isFinite(candidate)
    ? candidate
    : undefined;
}

async function attachPrivateArticlePreviews(
  article: ArticleDetail,
  fetchImpl: typeof globalThis.fetch,
  signal?: AbortSignal,
): Promise<ArticleDetail> {
  if (
    typeof fetchImpl !== "function" ||
    typeof URL.createObjectURL !== "function"
  ) {
    if (article.images.some(({ sourceUrl }) => Boolean(sourceUrl))) {
      throw new PublisherGatewayError(
        "当前浏览器不能安全预览稿件图片",
        "unavailable",
      );
    }
    return article;
  }
  return {
    ...article,
    images: await Promise.all(
      article.images.map((image) =>
        image.sourceUrl
          ? fetchPrivateArticlePreview(
              image,
              article.id,
              fetchImpl,
              signal,
              true,
            )
          : Promise.resolve(image),
      ),
    ),
  };
}

async function fetchPrivateArticlePreview(
  image: ArticleImage,
  articleId: string,
  fetchImpl: typeof globalThis.fetch,
  signal: AbortSignal | undefined,
  required: boolean,
): Promise<ArticleImage> {
  if (typeof URL.createObjectURL !== "function") {
    if (required) {
      throw new PublisherGatewayError(
        "当前浏览器不能预览上传图片",
        "unavailable",
      );
    }
    return image;
  }
  try {
    const response = await fetchImpl(
      `/api/monitoring/publisher/articles/${encodeURIComponent(articleId)}/assets`,
      {
        method: "POST",
        credentials: "same-origin",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ assetId: image.id }),
        signal,
      },
    );
    if (!response.ok) {
      if (required) throw await publisherHttpError(response);
      return image;
    }
    const blob = await response.blob();
    return {
      ...image,
      previewUrl: URL.createObjectURL(blob),
      previewUrlIsObject: true,
    };
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError")
      throw error;
    if (required) throw error;
    return image;
  }
}

function throwIfAborted(signal?: AbortSignal) {
  if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
}

function abortableDelay(milliseconds: number, signal?: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    throwIfAborted(signal);
    const timeout = window.setTimeout(
      () => {
        signal?.removeEventListener("abort", onAbort);
        resolve();
      },
      Math.max(0, milliseconds),
    );
    const onAbort = () => {
      window.clearTimeout(timeout);
      reject(new DOMException("Aborted", "AbortError"));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

async function publisherHttpError(response: Response) {
  let message = `上传失败（HTTP ${response.status}）`;
  try {
    const payload: unknown = await response.json();
    message = readString(payload, "error") || message;
  } catch {
    // A disabled feature can intentionally return an empty 404 response.
  }
  const code =
    response.status === 409
      ? "conflict"
      : response.status === 412
        ? "stale_preflight"
        : response.status === 400 || response.status === 413
          ? "validation"
          : "unavailable";
  return new PublisherGatewayError(message, code);
}

async function translateGatewayErrors<T>(
  operation: () => Promise<T>,
): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    if (error instanceof PublisherGatewayError) throw error;
    if (error instanceof DOMException && error.name === "AbortError")
      throw error;
    const candidate = error as {
      message?: unknown;
      data?: { code?: unknown } | null;
    };
    const message =
      typeof candidate?.message === "string" && candidate.message.trim()
        ? candidate.message
        : "媒体发布服务暂时不可用";
    const rpcCode =
      typeof candidate?.data?.code === "string" ? candidate.data.code : "";
    const normalized = message.toLowerCase();
    if (/balance|funds|余额|资金/iu.test(normalized)) {
      throw new PublisherGatewayError(message, "insufficient_balance");
    }
    if (
      /preflight|quote|catalog|price|预检|报价|目录|价格/iu.test(normalized)
    ) {
      throw new PublisherGatewayError(message, "stale_preflight");
    }
    if (rpcCode === "NOT_FOUND") {
      throw new PublisherGatewayError(
        /not enabled|未启用/iu.test(message) ? "媒体发布功能尚未启用" : message,
        /not enabled|未启用/iu.test(message) ? "unavailable" : "not_found",
      );
    }
    if (rpcCode === "CONFLICT") {
      throw new PublisherGatewayError(message, "conflict");
    }
    if (rpcCode === "BAD_REQUEST" || rpcCode === "PRECONDITION_FAILED") {
      throw new PublisherGatewayError(message, "validation");
    }
    throw new PublisherGatewayError(message, "unavailable");
  }
}

function isSaveDraftTitlesInput(
  value: SaveDraftTitlesInput | Record<string, string>,
): value is SaveDraftTitlesInput {
  return (
    "expectedRevision" in value && typeof value.expectedRevision === "number"
  );
}
