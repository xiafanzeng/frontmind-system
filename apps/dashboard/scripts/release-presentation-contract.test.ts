import { describe, expect, it } from "vitest";

import { normalizeReleasePresentation } from "./release-presentation-contract.mjs";

describe("release presentation contract", () => {
  it.each([
    ["development", true],
    ["production", false],
  ] as const)(
    "accepts a complete %s profile",
    (releaseChannel, preventIndexing) => {
      expect(
        normalizeReleasePresentation({
          releaseChannel,
          websiteUrl: "https://website.example.invalid",
          documentTitle: "FrontMind Dashboard",
          preventIndexing,
        }),
      ).toEqual({
        releaseChannel,
        websiteUrl: "https://website.example.invalid",
        documentTitle: "FrontMind Dashboard",
        preventIndexing,
      });
    },
  );

  it("rejects malformed public URLs and incomplete profiles", () => {
    expect(() =>
      normalizeReleasePresentation({
        releaseChannel: "production",
        websiteUrl: "javascript:alert(1)",
        documentTitle: "FrontMind Dashboard",
        preventIndexing: false,
      }),
    ).toThrow("FRONTMIND_WEBSITE_URL_INVALID");
    expect(() => normalizeReleasePresentation({})).toThrow(
      "FRONTMIND_RELEASE_CHANNEL_INVALID",
    );
  });
});
