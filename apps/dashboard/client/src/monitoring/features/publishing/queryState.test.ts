import { describe, expect, it } from "vitest";

import {
  DEFAULT_MEDIA_FILTERS,
  parseBatchQuery,
  publisherSubmitIdempotencyKey,
  readMediaRouteState,
  readPublicationRouteState,
  unicodeLength,
  writeMediaRouteState,
} from "./queryState";

describe("publishing route state", () => {
  it("round trips dual-kind filters and the explicit article version", () => {
    const url = writeMediaRouteState(
      "/publishing/media",
      {
        ...DEFAULT_MEDIA_FILTERS,
        kind: "self_media",
        query: "科技",
        area: "华东",
        priceMin: "100",
        sort: "success_desc",
        page: 3,
        pageSize: 50,
      },
      "article-v3",
    );
    const parsed = readMediaRouteState(url.split("?")[1] ?? "");

    expect(parsed.articleVersionId).toBe("article-v3");
    expect(parsed.filters).toMatchObject({
      kind: "self_media",
      query: "科技",
      area: "华东",
      priceMin: "100",
      sort: "success_desc",
      page: 3,
      pageSize: 50,
    });
  });

  it("normalizes invalid enum and paging values", () => {
    expect(
      readMediaRouteState(
        "kind=other&sort=cost&page=0&pageSize=999&priceMin=NaN&priceMax=-2&pcWeight=999",
      ).filters,
    ).toMatchObject({
      kind: "news",
      sort: "recommended",
      page: 1,
      pageSize: 50,
      priceMin: "",
      priceMax: "",
      pcWeight: "",
    });
    expect(
      readPublicationRouteState("status=unknown&from=2026-02-30&to=today"),
    ).toMatchObject({ status: "", from: "", to: "" });
  });

  it("deduplicates at most fifty bulk terms and counts Unicode characters", () => {
    expect(parseBatchQuery("甲\n乙,甲，丙")).toEqual(["甲", "乙", "丙"]);
    expect(
      parseBatchQuery(
        Array.from({ length: 55 }, (_, index) => `媒体${index}`).join("\n"),
      ),
    ).toHaveLength(50);
    expect(unicodeLength("AI😀搜索")).toBe(5);
  });

  it("derives a deterministic submit idempotency key from draft and quote", () => {
    expect(publisherSubmitIdempotencyKey("draft-20", "quote-abcd1234")).toBe(
      "publisher-submit:draft-20:quote-abcd1234",
    );
    expect(publisherSubmitIdempotencyKey("draft-20", "quote-abcd1234")).toBe(
      publisherSubmitIdempotencyKey("draft-20", "quote-abcd1234"),
    );
    expect(
      publisherSubmitIdempotencyKey("draft-21", "quote-abcd1234"),
    ).not.toBe(publisherSubmitIdempotencyKey("draft-20", "quote-abcd1234"));
  });
});
