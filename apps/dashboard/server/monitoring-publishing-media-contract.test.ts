// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import sharp from "sharp";
import { MySqlDialect } from "drizzle-orm/mysql-core";
import { getTableName } from "drizzle-orm";
import { KolClient } from "../../../packages/monitoring-provider-kol/src/client";
import { kolResourceSchema } from "../../../packages/monitoring-provider-kol/src/schemas";
import { normalizeResource } from "../../../packages/monitoring-provider-kol/src/normalize";
import { normalizeCatalogResource, PublisherWorkerRepository, publisherLiveCanaryBlocker, publisherLiveImageEvidenceBlocker } from "../../../packages/monitoring-db/src/publisher-worker-repository";
import { PublishingRepository, publisherMediaEditorialMetadata, publisherLiveImageCanaryBlocker } from "../../../packages/monitoring-db/src/publisher-repository";
import { normalizePublisherLogo } from "../../../packages/monitoring-publisher/src/logo";
import { normalizePublisherImage } from "../../../packages/monitoring-publisher/src/image";
import { PublisherLogoArchiveCache } from "../../../apps/monitoring-worker/src/publishing/logo-archive-cache";

describe("real catalog metadata", () => {
  it("preserves the supplier's Chinese recommendation flag independently of platform and authentication labels", () => {
    const raw = kolResourceSchema.parse({ id: 87347, name: "腾讯网新闻（账号随机）", is_zimeiti: 2, price: "18.5",
      is_recommend: "是", recommend: ["急速出稿", "周末可发", "GEO排名"], platform_recommend: [],
      auth: "否", festival: "是" });
    const normalized = normalizeResource(raw, new URL("https://api.kol.cn"));
    const stored = normalizeCatalogResource(normalized)!;
    expect(stored).toMatchObject({ recommended: true, authenticated: false, festivalPublishable: true });
    expect(stored.rawPayload.recommended).toBe(true);
    expect(publisherMediaEditorialMetadata(stored.rawPayload)).toMatchObject({
      recommendationTags: ["急速出稿", "周末可发", "GEO排名"], platformRecommendationTags: [],
    });
  });
  it.each(["", null, "官方", "推荐", "未知", " 是 "])("keeps unrecognized boolean %j unknown even when platform tags are present", value => {
    const raw = kolResourceSchema.parse({ id: 41004, name: "平阴新闻", is_zimeiti: 2, price: "18.5",
      is_recommend: value, auth: value, festival: value, platform_recommend: ["官方"] });
    const stored = normalizeCatalogResource(normalizeResource(raw))!;
    expect(stored.recommended).toBeNull();
    expect(stored.authenticated).toBeNull();
    expect(stored.festivalPublishable).toBeNull();
    expect(publisherMediaEditorialMetadata(stored.rawPayload).platformRecommendationTags).toEqual(["官方"]);
  });
  it("preserves provider labels through staging and the explicit customer projection without inventing authentication", () => {
    const raw = kolResourceSchema.parse({ id: 42, name: "媒体甲", is_zimeiti: 1, price: "18.5",
      recommend: ["GEO排名", "GEO排名"], platform_recommend: ["官方"], is_recommend: "",
      auth_type: "机构", auth_description: "供应商说明", token: "must-not-persist", supplier_price: "0.01" });
    const normalized = normalizeResource(raw, new URL("https://api.kol.cn"));
    expect(normalized.authenticated).toBeUndefined();
    const stored = normalizeCatalogResource(normalized)!;
    expect(stored.authenticated).toBeNull();
    expect(publisherMediaEditorialMetadata(stored.rawPayload)).toEqual({
      recommendationTags: ["GEO排名"], platformRecommendationTags: ["官方"], recommendationRemark: null,
      authenticationType: "机构", authenticationDescription: "供应商说明",
    });
    expect(JSON.stringify(stored.rawPayload)).not.toContain("must-not-persist");
    expect(stored.rawPayload).not.toHaveProperty("supplier_price");
  });

  it("uses the same unknown semantics for absent capability rows as catalog counts and DTOs", async () => {
    const where: any[] = [];
    let index = 0;
    const db = { select: () => {
      const result = index++ === 0 ? [{ total: 0 }] : [];
      const query: any = { from: () => query, leftJoin: () => query,
        where: (clause: any) => { where.push(clause); return query; },
        orderBy: () => query, limit: () => query, offset: () => query,
        then: (resolve: any, reject: any) => Promise.resolve(result).then(resolve, reject) };
      return query;
    } };
    await new PublishingRepository(db as never).listPublisherMedia({ imageSupport: "unknown", page: 1 });
    for (const clause of where) {
      const statement = new MySqlDialect().sqlToQuery(clause);
      expect(statement.sql).toMatch(/COALESCE\(.*image_support.*'unknown'\)/u);
      expect(statement.params).toContain("unknown");
    }
  });
});

describe("text publication admission", () => {
  const input = { batchItemCount: 20, matchingActiveResourceCount: 0, resourceName: "普通媒体",
    totalTenThousandths: 50_000_000n, containsImages: false, whitelistImageAllowed: false };
  it("admits ordinary text across twenty media without image approval at both repository and worker boundaries", () => {
    expect(publisherLiveImageCanaryBlocker(input)).toBeNull();
    expect(publisherLiveCanaryBlocker({ ...input, runtimeImagePublishEnabled: false })).toBeNull();
    expect(publisherLiveImageEvidenceBlocker({ containsImages: false, imageSupport: "unknown", assets: [] })).toBeNull();
  });
  it("continues to reject unverified image publication", () => {
    expect(publisherLiveImageCanaryBlocker({ ...input, containsImages: true })).toBeTruthy();
    expect(publisherLiveCanaryBlocker({ ...input, containsImages: true, runtimeImagePublishEnabled: false })).toBeTruthy();
    expect(publisherLiveImageEvidenceBlocker({ containsImages: true, imageSupport: "unknown", assets: [] })).toBeTruthy();
  });
});

describe("provider form submission contract: all HTTP is intercepted", () => {
  const input = { resourceId: 42, title: "A&B + 中文", html: "<p>只发送一次 & 不切换编码</p>" };
  const options = { baseUrl: "https://api.kol.cn", accessToken: "test-only-token", mode: "live" as const, realEnabled: true, publishEnabled: true };
  it("uses the default form encoding and returns the matching order id", async () => {
    const fetcher = vi.fn(async (_url: RequestInfo | URL, request?: RequestInit) => {
      expect(request?.method).toBe("POST");
      expect(new Headers(request?.headers).get("content-type")).toBe("application/x-www-form-urlencoded");
      expect(new Headers(request?.headers).get("user-agent")).toBe("frontmind-publisher-worker/0.1");
      expect(Object.fromEntries(new URLSearchParams(String(request?.body)))).toEqual({ token: "test-only-token", title: input.title, content: input.html, resource_id: "42" });
      expect(request?.redirect).toBe("error");
      return Response.json({ success: true, status: 200, response_data: [{ order_id: "confirmed-order", resource_id: 42, resource_name: "媒体甲" }] });
    });
    const result = await new KolClient({ ...options, fetch: fetcher }).createOrder(input);
    expect(result.orderId).toBe("confirmed-order");
    expect(fetcher).toHaveBeenCalledOnce();
  });
  it.each([401, 429, 500])("does not retry or fall back encoding when POST returns %i", async status => {
    const fetcher = vi.fn(async () => Response.json({ success: false, status }, { status }));
    await expect(new KolClient({ ...options, fetch: fetcher }).createOrder(input)).rejects.toMatchObject({ name: "KolSubmissionUnknownError" });
    expect(fetcher).toHaveBeenCalledOnce();
  });
  it("does not resend a timed-out order and honors an explicitly unknown encoding before HTTP", async () => {
    const fetcher = vi.fn(async () => { throw new TypeError("network lost after send"); });
    await expect(new KolClient({ ...options, fetch: fetcher }).createOrder(input)).rejects.toMatchObject({ name: "KolSubmissionUnknownError" });
    expect(fetcher).toHaveBeenCalledOnce();
    fetcher.mockClear();
    await expect(new KolClient({ ...options, createOrderEncoding: "unknown", fetch: fetcher }).createOrder(input)).rejects.toMatchObject({ code: "invalid_configuration" });
    expect(fetcher).not.toHaveBeenCalled();
  });
  it("queries the accepted order using its id and the same authenticated User-Agent", async () => {
    const fetcher = vi.fn(async (url: RequestInfo | URL, request?: RequestInit) => {
      const endpoint = new URL(String(url));
      expect(endpoint.pathname).toBe("/api/news_order");
      expect(endpoint.searchParams.get("order_id")).toBe("confirmed-order");
      expect(request?.method).toBe("GET");
      expect(new Headers(request?.headers).get("authorization")).toBe("Bearer test-only-token");
      expect(new Headers(request?.headers).get("user-agent")).toBe("frontmind-publisher-worker/0.1");
      return Response.json({ success: true, status: 200, data: [{ id: 9, order_id: "confirmed-order", resource_id: 42,
        status: 1, response_message: "https://media.test/article/9", title: input.title }] });
    });
    expect(await new KolClient({ ...options, fetch: fetcher }).getOrderByOrderId("confirmed-order"))
      .toMatchObject({ orderId: "confirmed-order", status: "success", publishedUrl: "https://media.test/article/9" });
    expect(fetcher).toHaveBeenCalledOnce();
  });
});

describe("private Logo SVG rasterization and URL reuse", () => {
  const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="120" height="80" viewBox="0 0 120 80"><rect width="120" height="80" fill="#ff0000"/></svg>');
  it("produces a correctly sized PNG while ordinary article image uploads still reject SVG", async () => {
    const input = { bytes: svg, sourceMimeType: "image/svg+xml" };
    const result = await normalizePublisherLogo(input);
    expect(result.mimeType).toBe("image/png");
    expect(await sharp(result.bytes).metadata()).toMatchObject({ width: 120, height: 80 });
    await expect(normalizePublisherImage(input)).rejects.toMatchObject({ code: "unsupported_image_format" });
  });
  it("rasterizes legacy static icons after removing the exact standard W3C SVG 1.1 declaration", async () => {
    const source = '<?xml version="1.0" standalone="no"?><!DOCTYPE svg PUBLIC "-//W3C//DTD SVG 1.1//EN" "http://www.w3.org/Graphics/SVG/1.1/DTD/svg11.dtd">' + svg.toString("utf8");
    const result = await normalizePublisherLogo({ bytes: Buffer.from(source), sourceMimeType: "image/svg+xml" });
    expect(result.mimeType).toBe("image/png");
    expect(await sharp(result.bytes).metadata()).toMatchObject({ width: 120, height: 80 });
  });
  it.each([
    '<!DOCTYPE svg [<!ENTITY x SYSTEM "file:///etc/passwd">]><svg/>',
    '<!DOCTYPE svg PUBLIC "-//W3C//DTD SVG 1.1//EN" "http://www.w3.org/Graphics/SVG/1.1/DTD/svg11.dtd" [<!ENTITY x SYSTEM "file:///etc/passwd">]><svg/>',
    '<!DOCTYPE svg PUBLIC "-//W3C//DTD SVG 1.1//EN" "https://example.test/svg11.dtd"><svg/>',
    '<!DOCTYPE svg PUBLIC "-//W3C//DTD SVG 1.1//EN" "http://www.w3.org/Graphics/SVG/1.1/DTD/svg11.dtd"><!ENTITY x SYSTEM "file:///etc/passwd"><svg/>',
    '<svg><use href="https://example.test/x.svg#logo"/></svg>',
    '<svg><use href="&#104;ttps://example.test/x.svg"/></svg>',
    '<svg><rect fill="url(https://example.test/paint)"/></svg>',
    '<svg><rect fill="u\\72l(https://example.test/paint)"/></svg>',
  ])("rejects external or obfuscated references before the rasterizer", async value => {
    await expect(normalizePublisherLogo({ bytes: Buffer.from(value), sourceMimeType: "image/svg+xml" })).rejects.toMatchObject({ code: "unsafe_logo_svg" });
  });
  it("fetches/stores a shared platform image once across concurrent media resolutions", async () => {
    const fetcher = vi.fn(async () => ({ sourceUrl: "https://assets.test/logo.svg", finalUrl: "https://assets.test/logo.svg", body: svg, contentType: "image/svg+xml", size: svg.length, sha256: "unused" }));
    const put = vi.fn(async () => undefined);
    const cache = new PublisherLogoArchiveCache({ put } as never, fetcher);
    const [a, b] = await Promise.all([cache.resolve("https://assets.test/logo.svg"), cache.resolve("https://assets.test/logo.svg")]);
    expect(a).toEqual(b);
    expect(a.contentType).toBe("image/png");
    await cache.resolve("https://assets.test/logo.svg");
    expect(fetcher).toHaveBeenCalledOnce();
    expect(put).toHaveBeenCalledOnce();
    expect(a).not.toHaveProperty("bytes");
  });
});

describe("Logo completion across a concurrent full catalog sync", () => {
  const input = { mediaResourceId: "11111111-1111-5111-8111-111111111111", candidateHash: "a".repeat(64),
    syncRunId: "old-run", catalogRevision: "old-revision", sourceKind: "logo" as const,
    sourceUrl: "https://assets.test/logo.png", objectKey: `publisher/media-logos/${"b".repeat(64)}.png`,
    contentType: "image/png" as const, sizeBytes: 100, sha256: "b".repeat(64), checkedAt: new Date("2026-09-08T00:00:00Z") };
  function fixture(overrides: Record<string, unknown> = {}) {
    const row = { id: input.mediaResourceId, candidateHash: input.candidateHash,
      syncRunId: "current-run", catalogRevision: "current-revision", archiveStatus: "pending", ...overrides };
    const writes: Array<{ table: string; values: Record<string, unknown>; params?: unknown[] }> = [];
    let locked = false;
    let matches = false;
    const dialect = new MySqlDialect();
    const tx = {
      select: () => {
        const query = { from: () => query, where: (clause: any) => {
          // Model equality predicates against the row after the concurrent sync.
          matches = dialect.sqlToQuery(clause).params.every(value => Object.values(row).includes(value));
          return query;
        }, for: (kind: string) => { locked = kind === "update"; return query; },
        limit: async () => matches ? [row] : [] };
        return query;
      },
      insert: (table: any) => ({ values: (values: Record<string, unknown>) => {
        writes.push({ table: getTableName(table), values });
        return { onDuplicateKeyUpdate: async () => undefined };
      } }),
      update: (table: any) => ({ set: (values: Record<string, unknown>) => ({ where: async (clause: any) => {
        writes.push({ table: getTableName(table), values, params: dialect.sqlToQuery(clause).params });
      } }) }),
    };
    return { writes, locked: () => locked,
      repository: new PublisherWorkerRepository({ transaction: async (run: (value: typeof tx) => Promise<void>) => run(tx) } as never) };
  }
  it("completes an unchanged candidate into the current locked catalog and sync run", async () => {
    const subject = fixture();
    await subject.repository.completeKolMediaLogoArchive(input);
    expect(subject.locked()).toBe(true);
    expect(subject.writes.find(row => row.table === "publisher_media_logo_assets")?.values)
      .toMatchObject({ mediaResourceId: input.mediaResourceId, catalogRevision: "current-revision" });
    expect(subject.writes.find(row => row.table === "publisher_media_logo_resolutions" && row.values.syncRunId)?.values)
      .toMatchObject({ syncRunId: "current-run", candidateHash: input.candidateHash, status: "archived" });
    expect(subject.writes.some(row => row.table === "publisher_media_resources" && row.values.logoArchiveStatus === "archived")).toBe(true);
  });
  it("does not attach a downloaded Logo after its media candidate changed", async () => {
    const subject = fixture({ candidateHash: "c".repeat(64) });
    await subject.repository.completeKolMediaLogoArchive(input);
    expect(subject.writes).toEqual([]);
  });
  it("carries a safe existing fallback into the current sync run", async () => {
    const subject = fixture({ archiveStatus: "archived", sourceKind: "generated_fallback", logoSha256: input.sha256 });
    await subject.repository.carryForwardKolMediaLogoArchive(input);
    expect(subject.writes).toHaveLength(1);
    expect(subject.writes[0]?.params).toContain("current-run");
    expect(subject.writes[0]?.params).not.toContain("old-run");
  });
  it("records a current-candidate failure in the new run without erasing a completed duplicate", async () => {
    const pending = fixture();
    await pending.repository.failKolMediaLogoArchive({ ...input, errorCode: "image_decode_failed" });
    expect(pending.writes.find(row => row.values.syncRunId)?.values)
      .toMatchObject({ syncRunId: "current-run", status: "failed" });
    const completed = fixture({ archiveStatus: "archived" });
    await completed.repository.failKolMediaLogoArchive({ ...input, errorCode: "image_decode_failed" });
    expect(completed.writes).toEqual([]);
  });
});
