import { describe, expect, it } from "vitest";

import {
  normalizeKnowledgeBaseAttachmentFilename,
  normalizeKnowledgeBaseAttachmentMimeType,
} from "./knowledge-base-attachment";

describe("knowledge-base attachment normalization", () => {
  it("sanitizes controls and truncates by Unicode code point", () => {
    expect(
      normalizeKnowledgeBaseAttachmentFilename("  客户/补充\u0001😀.jpg  "),
    ).toBe("客户_补充_😀.jpg");

    const normalized = normalizeKnowledgeBaseAttachmentFilename(
      `${"a".repeat(159)}😀tail.jpg`,
    );
    expect(Array.from(normalized)).toHaveLength(160);
    expect(normalized.endsWith("😀")).toBe(true);
    expect(normalized).not.toMatch(/[\uD800-\uDFFF]$/u);
    expect(normalizeKnowledgeBaseAttachmentFilename("bad\uD83Dname.png")).toBe(
      "bad_name.png",
    );
  });

  it("canonicalizes image MIME aliases and trusts a supported extension fallback", () => {
    expect(
      normalizeKnowledgeBaseAttachmentMimeType("proof.JPG", "image/pjpeg"),
    ).toBe("image/jpeg");
    expect(
      normalizeKnowledgeBaseAttachmentMimeType(
        "proof.svg",
        "application/octet-stream",
      ),
    ).toBe("image/svg+xml");
    expect(
      normalizeKnowledgeBaseAttachmentMimeType("proof.bin", "image/vendor"),
    ).toBe("application/octet-stream");
  });
});
