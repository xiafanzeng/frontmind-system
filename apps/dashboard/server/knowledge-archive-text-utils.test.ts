import { describe, expect, it } from "vitest";

import {
  effectiveKnowledgeArchiveCharacterCount,
  knowledgeArchiveContainsSourceInventoryHeading,
  knowledgeArchiveContainsSourceInventoryTable,
  knowledgeArchiveFormalText,
  knowledgeArchiveHeadingIsSourceInventory,
} from "./knowledge-archive-text-utils";

describe("knowledge archive formal text", () => {
  it("uses the same NFKC character model as the bundled Skill validator", () => {
    expect(effectiveKnowledgeArchiveCharacterCount("ﬃ㍿中文")).toBe(9);
  });

  it.each([
    ["不同来源模型", "统一 API 网关"],
    ["社区活力来源", "独立开发者"],
    ["拓展收入来源", "商业模型公司"],
  ])("counts a business table containing %s", (businessPhrase, label) => {
    const markdown = [
      "| 类型 | 平台价值 |",
      "| --- | --- |",
      `| ${label} | ${businessPhrase} |`,
    ].join("\n");

    expect(knowledgeArchiveContainsSourceInventoryTable(markdown)).toBe(false);
    expect(knowledgeArchiveFormalText(markdown)).toContain(businessPhrase);
    expect(
      effectiveKnowledgeArchiveCharacterCount(
        knowledgeArchiveFormalText(markdown),
      ),
    ).toBeGreaterThan(0);
  });

  it.each(["来源", "数据来源", "证据链接", "Source URL", "References"])(
    "excludes a source inventory table with the %s header",
    (header) => {
      const markdown = [
        `| 事实 | ${header} |`,
        "| --- | --- |",
        "| 企业成立时间 | https://official.example/facts |",
      ].join("\n");

      expect(knowledgeArchiveContainsSourceInventoryTable(markdown)).toBe(true);
      expect(knowledgeArchiveFormalText(markdown)).not.toContain(
        "企业成立时间",
      );
    },
  );

  it.each(["收入来源", "社区活力来源", "不同来源模型"])(
    "keeps the business section heading %s",
    (heading) => {
      const markdown = `## ${heading}\n\n应保留的业务正文`;

      expect(knowledgeArchiveHeadingIsSourceInventory(heading)).toBe(false);
      expect(knowledgeArchiveContainsSourceInventoryHeading(markdown)).toBe(
        false,
      );
      expect(knowledgeArchiveFormalText(markdown)).toContain(
        "应保留的业务正文",
      );
    },
  );

  it.each([
    "来源",
    "Acme 来源索引",
    "原始来源",
    "References",
    "Asset Inventory",
  ])("excludes the explicit source section heading %s", (heading) => {
    const markdown = `## ${heading}\n\n不应计入的来源正文\n\n## 正文\n\n应保留`;

    expect(knowledgeArchiveHeadingIsSourceInventory(heading)).toBe(true);
    expect(knowledgeArchiveContainsSourceInventoryHeading(markdown)).toBe(true);
    expect(knowledgeArchiveFormalText(markdown)).not.toContain(
      "不应计入的来源正文",
    );
    expect(knowledgeArchiveFormalText(markdown)).toContain("应保留");
  });
});
