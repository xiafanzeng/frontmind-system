import { describe, expect, it } from "vitest";

import { knowledgeSnapshotFormalCharacterCount } from "./dashboard-service";

describe("knowledge snapshot formal character count", () => {
  it("counts business tables whose body mentions sources", () => {
    const retainedBusinessTable = [
      "| 类型 | 平台价值 |",
      "| --- | --- |",
      `| 收入来源 | ${"乙".repeat(593)} |`,
      "| 社区活力来源 | 不同来源模型 |",
    ].join("\n");

    expect(
      knowledgeSnapshotFormalCharacterCount([
        {
          content: `${"甲".repeat(55_803)}\n\n${retainedBusinessTable}`,
          customerVisible: true,
        },
      ]),
    ).toBe(56_418);
  });

  it("excludes only a table whose header explicitly declares source fields", () => {
    expect(
      knowledgeSnapshotFormalCharacterCount([
        {
          content: [
            "保留正文",
            "",
            "| 来源链接 | 说明 |",
            "| --- | --- |",
            "| https://example.com | 不计入正文 |",
          ].join("\n"),
          customerVisible: true,
        },
        {
          content: "隐藏内容",
          customerVisible: false,
        },
      ]),
    ).toBe(4);
  });

  it("counts only the marked formal block when a validated v4 shell is present", () => {
    expect(
      knowledgeSnapshotFormalCharacterCount([
        {
          content: [
            "外壳文字",
            "<!-- FRONTMIND_FORMAL_CONTENT_START -->",
            "正",
            "<!-- FRONTMIND_FORMAL_CONTENT_END -->",
            "## 原始来源",
            "不计入的证据文字",
          ].join("\n"),
          customerVisible: true,
        },
      ]),
    ).toBe(1);
  });
});
