import { describe, expect, it } from "vitest";

import {
  canonicalizeGeneralChatAssistantMarkdown,
  type GeneralChatAssistantArtifactBinding,
} from "./frontmind-general-chat-markdown";

const imageBinding: GeneralChatAssistantArtifactBinding = {
  artifactId: "artifact_image",
  originalUrl: "https://provider.example/signed/card.png?token=secret",
  filename: "huang_guohua_business_card.png",
  mimeType: "image/png",
};

const localImageUrl = "/api/frontmind/v2/artifacts/artifact_image/content";

describe("canonicalizeGeneralChatAssistantMarkdown", () => {
  it.each([
    "/home/ubuntu/huang_guohua_business_card.png",
    "/mnt/data/huang_guohua_business_card.png",
    "/tmp/huang_guohua_business_card.png",
    "/workspace/huang_guohua_business_card.png",
    "/var/tmp/huang_guohua_business_card.png",
    "sandbox:/mnt/data/huang_guohua_business_card.png",
    "file:///home/ubuntu/huang_guohua_business_card.png",
    "./huang_guohua_business_card.png",
    "huang_guohua_business_card.png",
  ])("binds the Provider-local form %s to the localized artifact", (path) => {
    const result = canonicalizeGeneralChatAssistantMarkdown(
      `[下载修改后的名片图片](${path})`,
      [imageBinding],
    );
    expect(result.text).toBe(`[下载修改后的名片图片](${localImageUrl})`);
    expect(result.rewrittenCount).toBe(1);
    expect(result.unresolvedCount).toBe(0);
  });

  it("prefers the exact Provider attachment URL and removes a duplicated image node", () => {
    const download = canonicalizeGeneralChatAssistantMarkdown(
      `[下载](${imageBinding.originalUrl})`,
      [imageBinding],
    );
    const result = canonicalizeGeneralChatAssistantMarkdown(
      `![最终名片](${imageBinding.originalUrl})`,
      [imageBinding],
    );
    expect(download.text).toBe(`[下载](${localImageUrl})`);
    expect(download.matchKinds).toEqual(["exact_attachment_url"]);
    expect(result.text).toBe("");
    expect(result.matchKinds).toEqual(["exact_attachment_url"]);
    expect(result.deduplicatedImageCount).toBe(1);
  });

  it("does not guess when the basename is missing or ambiguous", () => {
    const duplicate = {
      ...imageBinding,
      artifactId: "artifact_duplicate",
      originalUrl: "https://provider.example/other/card.png",
    };
    const ambiguous = canonicalizeGeneralChatAssistantMarkdown(
      "[下载](/home/ubuntu/huang_guohua_business_card.png)",
      [imageBinding, duplicate],
    );
    const missing = canonicalizeGeneralChatAssistantMarkdown(
      "[下载](/mnt/data/missing.png)",
      [imageBinding],
    );
    expect(ambiguous.text).toBe("下载");
    expect(ambiguous.unresolvedCount).toBe(1);
    expect(missing.text).toBe("下载");
    expect(missing.unresolvedCount).toBe(1);
  });

  it("leaves normal public links, anchors, mail and telephone links unchanged", () => {
    const source = [
      "[官网](https://frontmind.net/docs)",
      "[章节](#section)",
      "[邮件](mailto:test@example.com)",
      "[电话](tel:12345)",
    ].join(" ");
    expect(
      canonicalizeGeneralChatAssistantMarkdown(source, [imageBinding]),
    ).toEqual(
      expect.objectContaining({
        text: source,
        rewrittenCount: 0,
        unresolvedCount: 0,
      }),
    );
  });
});
