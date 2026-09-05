import { describe, expect, it } from "vitest";

import { siteOpsSendMessageInputSchema } from "./siteops";

const base = {
  conversationId: "siteops:revision",
  clientRequestId: "revision-request-0001",
  text: "把这张图片加入产品页，并保留当前预览的其他内容。",
  expectedProjectRevision: 1,
};

describe("SiteOps revision message attachments", () => {
  it("accepts at most eight unique public opaque asset ids", () => {
    const localAssetIds = Array.from(
      { length: 8 },
      (_, index) => `asset_revision_${index}`,
    );
    expect(
      siteOpsSendMessageInputSchema.parse({ ...base, localAssetIds })
        .localAssetIds,
    ).toEqual(localAssetIds);
    expect(() =>
      siteOpsSendMessageInputSchema.parse({
        ...base,
        localAssetIds: [...localAssetIds, "asset_revision_8"],
      }),
    ).toThrow();
    expect(() =>
      siteOpsSendMessageInputSchema.parse({
        ...base,
        localAssetIds: ["asset_duplicate", "asset_duplicate"],
      }),
    ).toThrow();
  });

  it("rejects database UUIDs and overlong opaque ids", () => {
    expect(() =>
      siteOpsSendMessageInputSchema.parse({
        ...base,
        localAssetIds: ["00000000-0000-4000-8000-000000000001"],
      }),
    ).toThrow();
    expect(() =>
      siteOpsSendMessageInputSchema.parse({
        ...base,
        localAssetIds: [`asset_${"a".repeat(186)}`],
      }),
    ).toThrow();
  });

  it("keeps customer revision text capped at twenty thousand characters", () => {
    expect(
      siteOpsSendMessageInputSchema.parse({
        ...base,
        text: "a".repeat(20_000),
        localAssetIds: [],
      }).text,
    ).toHaveLength(20_000);
    expect(() =>
      siteOpsSendMessageInputSchema.parse({
        ...base,
        text: "a".repeat(20_001),
        localAssetIds: [],
      }),
    ).toThrow();
  });
});
