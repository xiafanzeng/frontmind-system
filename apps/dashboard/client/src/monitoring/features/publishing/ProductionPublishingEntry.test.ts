import { describe, expect, it, vi } from "vitest";

import {
  createProductionPublisherGateway,
  type PublisherTrpcClient,
} from "./ProductionPublishingEntry";
import { PublisherGatewayError } from "./gateway";

const articleId = "10000000-0000-4000-8000-000000000001";
const versionId = "10000000-0000-4000-8000-000000000002";
const mediaId = "10000000-0000-4000-8000-000000000003";
const draftId = "10000000-0000-4000-8000-000000000004";

const date = new Date("2026-08-31T02:00:00.000Z");

const article = {
  id: articleId,
  workingName: "企业知识入口的新变化",
  suggestedTitle: null,
  status: "ready" as const,
  currentVersionId: versionId,
  currentVersion: 2,
  containsImages: false,
  revision: 3,
  updatedAt: date,
  createdAt: date,
  editorJson: { type: "doc" },
  canonicalHtml: "<p>正文</p>",
  plainText: "正文",
  contentHash: "a".repeat(64),
};

const version = {
  id: versionId,
  articleId,
  version: 2,
  contentHash: "a".repeat(64),
  containsImages: false,
  createdAt: date,
};

const media = {
  id: mediaId,
  externalResourceId: "kol-100",
  catalogRevision: "catalog-2",
  name: "博客园（可发GEO）",
  kind: "news" as const,
  platform: "博客园",
  taxonomy: "科技",
  mediaType: "网站",
  area: "全国",
  titleLimit: 50,
  priceTenThousandths: "99000",
  successRateBasisPoints: 9600,
  includeRateBasisPoints: 8800,
  pcWeight: 4,
  mobileWeight: 3,
  includeType: "网页收录",
  publishSpeed: "2 小时",
  entryType: "可带入口",
  entryUrl: null,
  entryLevel: null,
  linkType: "可带链接",
  caseUrl: null,
  logoUrl: null,
  logoSource: "generated_fallback" as const,
  logoResolutionStatus: "missing" as const,
  remark: null,
  description: null,
  recommended: true,
  authenticated: true,
  festivalPublishable: true,
  fanCount: null,
  likeCount: null,
  publishCount: null,
  imageSupport: "verified" as const,
  isActive: true,
  updatedAt: date,
};

const draft = {
  id: draftId,
  articleVersionId: versionId,
  status: "ready" as const,
  revision: 3,
  titleMode: "per_media" as const,
  sharedTitle: null,
  items: [
    {
      id: "10000000-0000-4000-8000-000000000005",
      mediaResource: media,
      submissionTitle: "旧标题",
      selectedPriceTenThousandths: "99000",
      selectedCatalogRevision: "catalog-2",
    },
  ],
  updatedAt: date,
  createdAt: date,
};

function clientWith(overrides: Record<string, unknown> = {}) {
  const base = {
    publisher: {
      articles: {
        list: {
          query: vi.fn(async () => ({ items: [article], nextCursor: null })),
        },
        get: { query: vi.fn(async () => article) },
        assets: { query: vi.fn(async () => []) },
        versions: { query: vi.fn(async () => [version]) },
        save: { mutate: vi.fn(async () => article) },
        freeze: { mutate: vi.fn(async () => version) },
      },
      imports: {
        get: { query: vi.fn() },
      },
      media: {
        facets: {
          query: vi.fn(async () => ({
            kindCounts: { news: 1, selfMedia: 1 },
            platforms: [{ value: "博客园", count: 1 }],
            taxonomies: [{ value: "科技", count: 1 }],
            mediaTypes: [{ value: "网站", count: 1 }],
            areas: [{ value: "全国", count: 1 }],
            includeTypes: [{ value: "网页收录", count: 1 }],
            publishSpeeds: [{ value: "2 小时", count: 1 }],
            entryTypes: [{ value: "可带入口", count: 1 }],
            entryLevels: [{ value: "可带入口", count: 1 }],
            linkTypes: [{ value: "可带链接", count: 1 }],
            imageSupports: [{ value: "verified", count: 1 }],
            pcWeightThresholds: [{ value: "4", count: 1 }],
            includeRateThresholds: [{ value: "80", count: 1 }],
            successRateThresholds: [{ value: "95", count: 1 }],
            recommendedOptions: [{ value: "true", count: 1 }],
            authenticatedOptions: [{ value: "true", count: 1 }],
            festivalPublishableOptions: [{ value: "true", count: 1 }],
            minimumPriceTenThousandths: "99000",
            maximumPriceTenThousandths: "99000",
            catalogRevision: "catalog-2",
            catalogSyncedAt: date,
            kindComplete: true,
          })),
        },
        list: {
          query: vi.fn(async () => ({
            items: [media],
            nextCursor: null,
            catalogRevision: "catalog-2",
            catalogSyncedAt: date,
            catalogStale: false,
            total: 1,
            page: 1,
            pageSize: 10,
            kindComplete: true,
          })),
        },
      },
      drafts: {
        get: { query: vi.fn(async () => draft) },
        save: { mutate: vi.fn(async () => ({ ...draft, revision: 4 })) },
        preflight: { mutate: vi.fn() },
        submit: { mutate: vi.fn() },
      },
      batches: {
        list: { query: vi.fn() },
        get: { query: vi.fn() },
      },
      dashboard: { query: vi.fn() },
    },
    mediaPublishing: {
      billing: { summary: { query: vi.fn() } },
    },
    ...overrides,
  };
  return base as unknown as PublisherTrpcClient;
}

describe("createProductionPublisherGateway", () => {
  it("maps page filters to the owner-scoped cursor API", async () => {
    const client = clientWith();
    const gateway = createProductionPublisherGateway(client);

    const result = await gateway.listMedia({
      query: "博客园",
      channel: "科技",
      region: "全国",
      price: "under_100",
      capability: "image",
      page: 1,
      pageSize: 10,
    });

    expect(client.publisher.media.list.query).toHaveBeenCalledWith(
      {
        query: "博客园",
        includeInactive: true,
        taxonomy: "科技",
        area: "全国",
        imageSupport: "verified",
        maximumPriceTenThousandths: "999999",
        kind: "news",
        page: 1,
        pageSize: 10,
        sort: "recommended",
        limit: 10,
      },
      { signal: undefined },
    );
    expect(result.items[0]).toMatchObject({
      id: mediaId,
      name: "博客园（可发GEO）",
      priceTenThousandths: "99000",
      successRate: 96,
      region: "全国",
      turnaround: "2 小时",
      capability: "image",
    });
  });

  it("maps capability and advanced facet counts into customer labels", async () => {
    const gateway = createProductionPublisherGateway(clientWith());

    const facets = await gateway.getMediaFacets("news");

    expect(facets.imageSupports).toEqual([
      { value: "verified", count: 1, label: "支持图文" },
    ]);
    expect(facets.pcWeightThresholds).toEqual([
      { value: "4", count: 1, label: "4 以上" },
    ]);
    expect(facets.successRateThresholds).toEqual([
      { value: "95", count: 1, label: "95% 以上" },
    ]);
    expect(facets.authenticatedOptions).toEqual([
      { value: "true", count: 1, label: "已认证" },
    ]);
  });

  it("maps resumable drafts and counts all queued or processing batches for the overview", async () => {
    const client = clientWith();
    vi.mocked(client.publisher.dashboard.query).mockResolvedValue({
      catalogRevision: "catalog-2",
      catalogSyncedAt: date.toISOString(),
      catalogStale: false,
      kindComplete: true,
      wallet: {
        availableTenThousandths: "84020000",
        reservedTenThousandths: "0",
        frozenTenThousandths: "0",
      },
      resumableDraftCount: 1,
      resumableDrafts: [
        {
          id: draftId,
          articleTitle: "可恢复投放稿",
          articleVersion: 2,
          status: "ready",
          updatedAt: date.toISOString(),
        },
      ],
      actionRequiredCount: 0,
      recentBatches: [],
    });
    vi.mocked(client.publisher.batches.list.query).mockImplementation(
      async (input) => ({
        items: [],
        nextCursor: null,
        total: input?.status === "queued" ? 1 : 2,
        page: 1,
        pageSize: 3,
      }),
    );
    const gateway = createProductionPublisherGateway(client);

    const dashboard = await gateway.getDashboard();

    expect(dashboard.resumableDrafts).toEqual([
      expect.objectContaining({
        id: draftId,
        articleTitle: "可恢复投放稿",
        status: "ready",
      }),
    ]);
    expect(dashboard.processingBatchCount).toBe(3);
    expect(client.publisher.batches.list.query).toHaveBeenCalledWith(
      expect.objectContaining({ status: "queued", pageSize: 3 }),
      { signal: undefined },
    );
    expect(client.publisher.batches.list.query).toHaveBeenCalledWith(
      expect.objectContaining({ status: "processing", pageSize: 3 }),
      { signal: undefined },
    );
  });

  it("does not invent customer-facing values when optional catalog facts are missing", async () => {
    const client = clientWith();
    vi.mocked(client.publisher.media.list.query).mockResolvedValueOnce({
      items: [
        {
          ...media,
          area: null,
          publishSpeed: null,
          successRateBasisPoints: null,
          updatedAt: date.toISOString(),
        },
      ],
      nextCursor: null,
      catalogRevision: "catalog-2",
      catalogSyncedAt: date.toISOString(),
      catalogStale: false,
      total: 1,
      page: 1,
      pageSize: 10,
      kindComplete: true,
    });
    const gateway = createProductionPublisherGateway(client);

    const result = await gateway.listMedia({
      query: "",
      page: 1,
      pageSize: 10,
    });

    expect(result.items[0]).toMatchObject({
      region: "—",
      turnaround: "—",
    });
    expect(result.items[0]).not.toHaveProperty("successRate");
  });

  it("carries the protected catalog logo path into the media view model", async () => {
    const logoUrl = `/api/monitoring/publisher/media-logos/${mediaId}/${"b".repeat(64)}`;
    const client = clientWith();
    vi.mocked(client.publisher.media.list.query).mockResolvedValueOnce({
      items: [{ ...media, logoUrl, updatedAt: date.toISOString() }],
      nextCursor: null,
      catalogRevision: "catalog-2",
      catalogSyncedAt: date.toISOString(),
      catalogStale: false,
      total: 1,
      page: 1,
      pageSize: 10,
      kindComplete: true,
    });

    const result = await createProductionPublisherGateway(client).listMedia({
      query: "",
      page: 1,
      pageSize: 10,
    });

    expect(result.items[0]?.logoUrl).toBe(logoUrl);
  });

  it("renders a self-contained batch without scanning article versions", async () => {
    const client = clientWith();
    vi.mocked(client.publisher.batches.get.query).mockResolvedValue({
      id: "10000000-0000-4000-8000-000000000006",
      draftId,
      articleVersionId: versionId,
      status: "success",
      mode: "mock",
      fundsStatus: "consumed",
      quotedTotalTenThousandths: "99000",
      titleMode: "single",
      article: {
        workingName: "批次冻结稿件",
        suggestedTitle: "批次自包含标题",
        version: 2,
        contentHash: "c".repeat(64),
      },
      kindCounts: { news: 1, selfMedia: 0, unknown: 0 },
      itemCount: 1,
      successCount: 1,
      failedCount: 0,
      unknownCount: 0,
      consumedTenThousandths: "99000",
      releasedTenThousandths: "0",
      frozenTenThousandths: "0",
      reservedTenThousandths: "0",
      items: [
        {
          id: "10000000-0000-4000-8000-000000000007",
          mediaName: "冻结媒体",
          mediaKind: "news",
          platform: "网页",
          taxonomy: "科技",
          area: "全国",
          submissionTitle: "投稿标题",
          status: "success",
          fundsStatus: "consumed",
          priceTenThousandths: "99000",
          publishedUrl: "https://example.com/published",
          failureReason: null,
          actionRequiredReason: null,
          submittedAt: date.toISOString(),
          completedAt: date.toISOString(),
        },
      ],
      completedAt: date.toISOString(),
      createdAt: date.toISOString(),
      updatedAt: date.toISOString(),
    });
    const gateway = createProductionPublisherGateway(client);

    await expect(
      gateway.getBatch("10000000-0000-4000-8000-000000000006"),
    ).resolves.toMatchObject({
      articleTitle: "批次自包含标题",
      articleVersion: 2,
      articleVersionHash: "c".repeat(64),
    });
    expect(client.publisher.articles.list.query).not.toHaveBeenCalled();
    expect(client.publisher.articles.versions.query).not.toHaveBeenCalled();
  });

  it("uses the loaded draft revision when saving route-derived titles", async () => {
    const client = clientWith();
    const gateway = createProductionPublisherGateway(client);
    await gateway.getDraft(draftId);

    const saved = await gateway.saveDraftTitles(draftId, {
      [mediaId]: "新标题",
    });

    expect(client.publisher.drafts.save.mutate).toHaveBeenCalledWith({
      draftId,
      articleVersionId: versionId,
      expectedRevision: 3,
      titleMode: "per_media",
      items: [{ mediaResourceId: mediaId, submissionTitle: "新标题" }],
    });
    expect(saved.articleVersionHash).toBe("a".repeat(64));
    expect(saved.articleContainsImages).toBe(false);
  });

  it("polls the asynchronous DOCX import before opening the article", async () => {
    const importId = "10000000-0000-4000-8000-000000000006";
    const client = clientWith();
    vi.mocked(client.publisher.imports.get.query)
      .mockResolvedValueOnce({
        id: importId,
        articleId: null,
        sourceFilename: "稿件.docx",
        sizeBytes: 128,
        status: "parsing",
        warnings: [],
        blockers: [],
        createdAt: date.toISOString(),
        updatedAt: date.toISOString(),
      })
      .mockResolvedValueOnce({
        id: importId,
        articleId,
        sourceFilename: "稿件.docx",
        sizeBytes: 128,
        status: "ready",
        warnings: [],
        blockers: [],
        createdAt: date.toISOString(),
        updatedAt: date.toISOString(),
      });
    const fetchMock = vi.fn(
      async () =>
        new Response(JSON.stringify({ importId, status: "queued" }), {
          status: 202,
          headers: { "content-type": "application/json" },
        }),
    );
    const gateway = createProductionPublisherGateway(client, {
      fetch: fetchMock,
      importPollIntervalMs: 0,
    });

    const result = await gateway.importDocx(
      new File(["docx"], "稿件.docx", {
        type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      }),
    );

    expect(result).toEqual({ importId, articleId });
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/monitoring/publisher/docx-imports",
      expect.objectContaining({ method: "POST", credentials: "same-origin" }),
    );
    expect(client.publisher.imports.get.query).toHaveBeenCalledTimes(2);
  });

  it("normalizes tRPC conflicts for the editor", async () => {
    const client = clientWith();
    vi.mocked(client.publisher.articles.get.query).mockRejectedValueOnce({
      message: "Article revision has changed",
      data: { code: "CONFLICT" },
    });
    const gateway = createProductionPublisherGateway(client);

    const error = await gateway
      .getArticle(articleId)
      .catch((reason: unknown) => reason);
    expect(error).toBeInstanceOf(PublisherGatewayError);
    expect((error as PublisherGatewayError).code).toBe("conflict");
  });

  it("sends TipTap HTML and JSON while removing unowned image sources", async () => {
    const client = clientWith();
    const gateway = createProductionPublisherGateway(client);

    await gateway.saveArticle({
      articleId,
      expectedRevision: 3,
      title: "结构化稿件",
      bodyText: "可信标题\n\n正文",
      bodyHtml:
        '<h2>可信标题</h2><p><strong>正文</strong></p><img src="https://tracker.invalid/pixel.png" alt="外部图片">',
      editorJson: {
        type: "doc",
        content: [{ type: "heading", attrs: { level: 2 } }],
      },
      images: [],
    });

    expect(client.publisher.articles.save.mutate).toHaveBeenCalledWith({
      articleId,
      expectedRevision: 3,
      workingName: "结构化稿件",
      suggestedTitle: "结构化稿件",
      editorJson: {
        type: "doc",
        content: [{ type: "heading", attrs: { level: 2 } }],
      },
      canonicalHtml: "<h2>可信标题</h2><p><strong>正文</strong></p>",
      plainText: "可信标题\n\n正文",
    });
  });

  it("uploads through same-origin HTTP and renders through an authenticated Blob preview", async () => {
    const assetId = "10000000-0000-4000-8000-000000000007";
    const publicPath = `https://frontmind.test/api/publisher/public-assets/${assetId}/${"x".repeat(43)}`;
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            assetId,
            contentType: "image/png",
            width: 1200,
            height: 675,
            publicPath,
          }),
          { status: 201, headers: { "content-type": "application/json" } },
        ),
      )
      .mockResolvedValueOnce(
        new Response(new Blob(["safe-image"], { type: "image/png" }), {
          status: 200,
          headers: { "content-type": "image/png" },
        }),
      );
    const originalCreateObjectUrl = URL.createObjectURL;
    Object.defineProperty(URL, "createObjectURL", {
      configurable: true,
      value: vi.fn(() => "blob:http://localhost/private-image"),
    });
    try {
      const gateway = createProductionPublisherGateway(clientWith(), {
        fetch: fetchMock,
      });
      const uploaded = await gateway.uploadArticleImage(
        articleId,
        new File(["image"], "证据图.png", { type: "image/png" }),
        "可核验的证据关系图",
      );

      expect(uploaded).toMatchObject({
        id: assetId,
        fileName: "证据图.png",
        altText: "可核验的证据关系图",
        sourceUrl: publicPath,
        previewUrl: "blob:http://localhost/private-image",
        previewUrlIsObject: true,
      });
      expect(fetchMock.mock.calls[0]?.[0]).toBe(
        `/api/monitoring/publisher/articles/${articleId}/assets`,
      );
      expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({
        method: "POST",
        credentials: "same-origin",
      });
      expect(fetchMock.mock.calls[0]?.[1]?.body).toBeInstanceOf(FormData);
      expect(fetchMock.mock.calls[1]).toEqual([
        `/api/monitoring/publisher/articles/${articleId}/assets`,
        expect.objectContaining({
          method: "POST",
          credentials: "same-origin",
          body: JSON.stringify({ assetId }),
        }),
      ]);
    } finally {
      Object.defineProperty(URL, "createObjectURL", {
        configurable: true,
        value: originalCreateObjectUrl,
      });
    }
  });
});
