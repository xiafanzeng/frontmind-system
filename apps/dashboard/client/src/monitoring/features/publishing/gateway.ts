import type {
  ArticleDetail,
  ArticleImage,
  ArticleImportResult,
  ArticleSaveInput,
  ArticleSummary,
  MediaFilters,
  MediaFacets,
  MediaList,
  PublicationBatch,
  PublicationBatchSummary,
  PublicationDraft,
  PublicationPreflight,
  PublisherSubmitInput,
  PublishingDashboard,
  SaveDraftTitlesInput,
} from "./types";
import type { PublicationListFilters } from "./queryState";

export type PublisherGateway = {
  getDashboard(signal?: AbortSignal): Promise<PublishingDashboard>;
  listArticles(signal?: AbortSignal): Promise<ArticleSummary[]>;
  getArticle(articleId: string, signal?: AbortSignal): Promise<ArticleDetail>;
  importDocx(file: File, signal?: AbortSignal): Promise<ArticleImportResult>;
  uploadArticleImage(
    articleId: string,
    file: File,
    altText: string,
    signal?: AbortSignal,
  ): Promise<ArticleImage>;
  saveArticle(input: ArticleSaveInput): Promise<ArticleDetail>;
  freezeArticle(
    articleId: string,
    expectedRevision: number,
  ): Promise<ArticleDetail>;
  getMediaFacets(
    filters?: MediaFilters,
    signal?: AbortSignal,
  ): Promise<MediaFacets>;
  listMedia(filters: MediaFilters, signal?: AbortSignal): Promise<MediaList>;
  createDraft(
    articleVersionId: string,
    mediaIds: string[],
    idempotencyKey?: string,
  ): Promise<PublicationDraft>;
  getDraft(draftId: string, signal?: AbortSignal): Promise<PublicationDraft>;
  updateDraftMedia(
    draftId: string,
    mediaIds: string[],
    expectedRevision: number,
  ): Promise<PublicationDraft>;
  refreshDraftMedia(
    draftId: string,
    expectedRevision: number,
  ): Promise<PublicationDraft>;
  saveDraftTitles(
    draftId: string,
    input: SaveDraftTitlesInput | Record<string, string>,
  ): Promise<PublicationDraft>;
  preflightDraft(
    draftId: string,
    signal?: AbortSignal,
  ): Promise<PublicationPreflight>;
  submitDraft(input: PublisherSubmitInput): Promise<PublicationBatch>;
  listBatches(
    filters?: PublicationListFilters,
    signal?: AbortSignal,
  ): Promise<{
    items: PublicationBatchSummary[];
    total: number;
    page: number;
    pageSize: number;
  }>;
  getBatch(batchId: string, signal?: AbortSignal): Promise<PublicationBatch>;
  batchCsvUrl(batchId: string): string;
};

/**
 * The server-backed boundary deliberately mirrors the view gateway. App.tsx can
 * bind these calls to tRPC/HTTP without leaking generated router types into
 * this lazy feature chunk.
 */
export type PublisherServerAdapter = PublisherGateway;

export function createServerPublisherGateway(
  adapter: PublisherServerAdapter,
): PublisherGateway {
  return adapter;
}

/** @deprecated Use PublisherServerAdapter. */
export type PublisherProductionAdapter = PublisherServerAdapter;
/** @deprecated Use createServerPublisherGateway. */
export const createProductionPublisherGateway = createServerPublisherGateway;

export class PublisherGatewayError extends Error {
  constructor(
    message: string,
    readonly code:
      | "not_found"
      | "conflict"
      | "stale_preflight"
      | "insufficient_balance"
      | "validation"
      | "unavailable",
  ) {
    super(message);
    this.name = "PublisherGatewayError";
  }
}
