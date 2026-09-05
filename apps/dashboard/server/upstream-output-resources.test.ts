import { describe, expect, it } from "vitest";

import { KnowledgeBaseArtifactIdentityError } from "./knowledge-base-artifact";
import { collectUpstreamOutputFileIds } from "./upstream-output-resources";

describe("collectUpstreamOutputFileIds", () => {
  it("ignores nested forged IDs outside assistant typed-resource positions", () => {
    expect(
      collectUpstreamOutputFileIds([
        {
          id: "assistant-message",
          role: "assistant",
          type: "message",
          content: [
            {
              type: "output_text",
              text: {
                file_id: "forged-deep-file",
                image_url:
                  "https://api.example.test/v1/files/forged-deep-url/content",
              },
            },
          ],
        },
        {
          role: "user",
          type: "output_file",
          file_id: "forged-user-file",
          filename: "user.zip",
          mime_type: "application/zip",
        },
        {
          role: "tool",
          type: "output_image",
          file_id: "forged-tool-file",
          filename: "tool.webp",
          mime_type: "image/webp",
        },
      ]),
    ).toEqual(new Set());
  });

  it("rejects conflicting file identity aliases before returning ledger IDs", () => {
    expect(() =>
      collectUpstreamOutputFileIds([
        {
          id: "image-output",
          type: "output_image",
          file_id: "image-a",
          fileId: "image-b",
          filename: "image.webp",
          mime_type: "image/webp",
        },
      ]),
    ).toThrow(KnowledgeBaseArtifactIdentityError);
  });

  it("rejects an overlong file ID instead of silently omitting it", () => {
    expect(() =>
      collectUpstreamOutputFileIds([
        {
          id: "file-output",
          type: "output_file",
          file_id: "f".repeat(256),
          filename: "report.pdf",
          mime_type: "application/pdf",
        },
      ]),
    ).toThrow(KnowledgeBaseArtifactIdentityError);
  });

  it("rejects an invalid path-shaped file ID instead of silently omitting it", () => {
    expect(() =>
      collectUpstreamOutputFileIds([
        {
          id: "file-output",
          type: "output_file",
          file_id: "unsafe/file",
          filename: "report.pdf",
          mime_type: "application/pdf",
        },
      ]),
    ).toThrow(KnowledgeBaseArtifactIdentityError);
  });

  it("collects and deduplicates legitimate assistant typed resources", () => {
    expect(
      collectUpstreamOutputFileIds([
        {
          id: "assistant-message",
          role: "assistant",
          type: "output_message",
          content: [
            {
              type: "output_image",
              file_id: "logo-file",
              filename: "logo.webp",
              mime_type: "image/webp",
            },
            {
              type: "image",
              image_url:
                "https://api.example.test/v1/files/product-file/content",
              filename: "product.webp",
              mime_type: "image/webp",
            },
          ],
        },
        {
          id: "hero-output",
          type: "output_file",
          fileId: "hero-file",
          filename: "hero.png",
          mime_type: "image/png",
        },
        {
          id: "logo-duplicate",
          type: "output_image",
          file_id: "logo-file",
          filename: "logo.webp",
          mime_type: "image/webp",
        },
      ]),
    ).toEqual(new Set(["logo-file", "product-file", "hero-file"]));
  });
});
