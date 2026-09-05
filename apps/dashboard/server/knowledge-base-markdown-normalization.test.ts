import { describe, expect, it } from "vitest";

import { normalizeKnowledgeBaseCustomerMarkdownImages } from "./knowledge-base-markdown-normalization";

describe("knowledge-base customer Markdown image normalization", () => {
  it("keeps the Furuili customer text while removing its redundant Logo marker", () => {
    const incidentBody = [
      "## 企业身份 / 一句话定位",
      "孚锐利面向乳制品企业提供设备、软件与服务。",
      "![孚锐利官方 Logo](furuili_official_logo.png)",
      "### 待核验边界",
      "具体交付范围仍需以合同与项目资料核验。",
    ].join("\n\n");

    const normalized =
      normalizeKnowledgeBaseCustomerMarkdownImages(incidentBody);

    expect(normalized.removedImageCount).toBe(1);
    expect(normalized.markdown).not.toContain("![孚锐利官方 Logo]");
    expect(normalized.markdown).toContain(
      "孚锐利面向乳制品企业提供设备、软件与服务。",
    );
    expect(normalized.markdown).toContain(
      "具体交付范围仍需以合同与项目资料核验。",
    );
    expect(
      normalizeKnowledgeBaseCustomerMarkdownImages(normalized.markdown),
    ).toEqual({ markdown: normalized.markdown, removedImageCount: 0 });
  });

  it("removes AST image nodes, HTML img tags and bare data images only", () => {
    const body = [
      "前文保留。",
      "![diagram][asset]",
      "[asset]: https://cdn.example.test/diagram.png",
      '<div>说明<img alt="图" src="https://cdn.example.test/a.png">保留</div>',
      "data:image/png;base64,AAAA",
      "后文保留。",
    ].join("\n\n");

    const normalized = normalizeKnowledgeBaseCustomerMarkdownImages(body);

    expect(normalized.markdown).not.toContain("![diagram][asset]");
    expect(normalized.markdown).not.toContain("<img");
    expect(normalized.markdown).not.toContain("data:image/");
    expect(normalized.markdown).toContain("[asset]: https://cdn.example.test");
    expect(normalized.markdown).toContain("<div>说明保留</div>");
    expect(normalized.markdown).toContain("前文保留。");
    expect(normalized.markdown).toContain("后文保留。");
  });

  it("does not reinterpret fenced protocol bytes as customer image syntax", () => {
    const protocolFixture = [
      "```json",
      '{"kind":"frontmind.knowledge-base.presentation","note":"![not-customer](logo.png)"}',
      "```",
    ].join("\n");

    expect(
      normalizeKnowledgeBaseCustomerMarkdownImages(protocolFixture),
    ).toEqual({ markdown: protocolFixture, removedImageCount: 0 });
  });
});
