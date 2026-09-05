import { describe, expect, it } from "vitest";

import {
  assertWebsiteContentTemplatePublishHash,
  websiteContentTemplateFileHash,
} from "./website-content-template-api";

describe("website content template upload hash contract", () => {
  it("requires publish to reuse the exact bytes that passed preview", () => {
    const previewed = Buffer.from(
      '{"format":"frontmind.website-content-template.v1"}',
      "utf8",
    );
    const previewedHash = websiteContentTemplateFileHash(previewed);

    expect(() =>
      assertWebsiteContentTemplatePublishHash(previewedHash, previewedHash),
    ).not.toThrow();
    expect(() =>
      assertWebsiteContentTemplatePublishHash(undefined, previewedHash),
    ).toThrow("必须先预检同一份");
    expect(() =>
      assertWebsiteContentTemplatePublishHash(
        websiteContentTemplateFileHash(
          Buffer.from(
            '{"format":"frontmind.website-content-template.v1","changed":true}',
            "utf8",
          ),
        ),
        previewedHash,
      ),
    ).toThrow("文件内容在预检后发生变化");
  });
});
