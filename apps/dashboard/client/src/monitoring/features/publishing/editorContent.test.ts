import { describe, expect, it } from "vitest";

import {
  publisherCanonicalHtmlToEditorHtml,
  publisherHtmlToPlainText,
  sanitizePublisherEditorHtml,
} from "./editorContent";
import type { ArticleImage } from "./types";

const image: ArticleImage = {
  id: "asset-1",
  fileName: "evidence.png",
  altText: "新的替代文本",
  width: 1200,
  height: 675,
  sourceUrl:
    "https://frontmind.test/api/publisher/public-assets/asset-1/capability",
  previewUrl: "blob:http://localhost/private-preview",
  previewUrlIsObject: true,
};

describe("publisher editor content boundary", () => {
  it("keeps owned images, synchronizes alt text and strips external images", () => {
    const html = [
      '<h2 onclick="alert(1)" style="color:red">可信标题</h2>',
      `<img src="${image.sourceUrl}" data-asset-id="${image.id}" alt="旧文本" srcset="https://other.invalid/x 2x">`,
      '<img src="https://tracker.invalid/pixel.gif" data-asset-id="unknown" alt="跟踪图">',
      "<script>alert(1)</script>",
    ].join("");

    expect(sanitizePublisherEditorHtml(html, [image])).toBe(
      `<h2>可信标题</h2><img src="${image.sourceUrl}" data-asset-id="${image.id}" alt="新的替代文本">`,
    );
  });

  it("uses the private Blob only for editing and restores the canonical source on save", () => {
    const canonical = `<p>正文</p><img src="${image.sourceUrl}" data-asset-id="${image.id}" alt="新的替代文本">`;
    const editorHtml = publisherCanonicalHtmlToEditorHtml(canonical, [image]);

    expect(editorHtml).toContain('src="blob:http://localhost/private-preview"');
    expect(editorHtml).not.toContain(image.sourceUrl);
    expect(sanitizePublisherEditorHtml(editorHtml, [image])).toBe(canonical);
  });

  it("derives stable plain text from rich block structure", () => {
    expect(
      publisherHtmlToPlainText(
        "<h2>标题</h2><p><strong>第一段</strong></p><ul><li><p>要点一</p></li><li><p>要点二</p></li></ul>",
      ),
    ).toBe("标题\n\n第一段\n\n要点一\n\n要点二");
  });
});
