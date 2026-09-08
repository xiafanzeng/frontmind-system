import { describe, expect, it } from "vitest";
import {
  CONTENT_PRODUCTION_PATTERNS,
  contentProductionArtifactName,
  contentProductionArtifactUrl,
  contentProductionPublicText,
  contentProductionTaskTitle,
  projectContentProductionMarkdown,
} from "./content-production-public";
import { contentProductionActionSchema } from "./content-production";

describe("content production Chinese presentation", () => {
  it("keeps all six native pattern values while presenting distinct business names", () => {
    expect(CONTENT_PRODUCTION_PATTERNS.map(([, label]) => label)).toEqual([
      "单一对象推荐",
      "多对象推荐与选择指南",
      "场景解决方案",
      "事件报道",
      "指定对象对比",
      "口碑与可信度评估",
    ]);
    for (const [selectedPattern] of CONTENT_PRODUCTION_PATTERNS)
      expect(
        contentProductionActionSchema.parse({
          kind: "confirm_pattern",
          revision: 7,
          selectedPattern,
        }),
      ).toMatchObject({ selectedPattern, revision: 7 });
    expect(
      contentProductionActionSchema.safeParse({
        kind: "confirm_pattern",
        revision: 7,
        selectedPattern: "单一对象推荐",
      }).success,
    ).toBe(false);
  });

  it("translates a complete review without changing quotations, code, source links or identifiers", () => {
    const protectedParts = [
      "> 来源原文：Reference Pack 与 P0、P01。",
      "“P0 是这个产品的型号”",
      "`--pattern P02 --example-route A`",
      '```json\n{"selected_pattern_id":"P02","p0_route":"create"}\n```',
      "[P01 原文](https://example.com/P01?Reference%20Pack=yes)",
      "![P0](https://example.com/P0.png)",
      "/mnt/session/work/frontmind/p0_blueprint.json",
      "p0_title_map.json",
    ];
    const source =
      "# P0 品牌文章蓝图确认\n\nReference Pack 已完成。\n\nP01 · 单主体品类或服务推荐\n\n" +
      protectedParts.join("\n\n");
    const output = projectContentProductionMarkdown(source);
    expect(output).toContain("# 品牌深度文章写作方案确认");
    expect(output).toContain("品牌资料包 已完成");
    expect(output).toContain("单一对象推荐");
    for (const part of protectedParts) expect(output).toContain(part);
    expect(projectContentProductionMarkdown(output)).toBe(output);
  });

  it("localizes only owned artifact links, keeping project scope and external sources intact", () => {
    const url =
      "/api/frontmind/v2/artifacts/artifact_123/content?enterpriseProjectId=project-a";
    const output = projectContentProductionMarkdown(
      `[p0.docx](${url})\n\n[P0 原文](https://source.test/P0)`,
    );
    expect(output).toBe(
      `[品牌深度文章.docx](${url}&presentation=zh)\n\n[P0 原文](https://source.test/P0)`,
    );
    expect(contentProductionArtifactUrl(url)).toContain(
      "enterpriseProjectId=project-a&presentation=zh",
    );
    expect(
      contentProductionArtifactUrl(
        "https://source.test/api/frontmind/v2/artifacts/a/content",
      ),
    ).toBe("https://source.test/api/frontmind/v2/artifacts/a/content");
  });

  it("keeps uploaded file identities and user-edited titles while naming known generated files", () => {
    expect(contentProductionArtifactName("Reference_Pack_v3.zip")).toBe(
      "品牌资料包_v3.zip",
    );
    expect(contentProductionArtifactName("p0_title_map.json")).toBe(
      "品牌文章标题方案.json",
    );
    expect(contentProductionArtifactName("用户的 P0 参数表.xlsx")).toBe(
      "用户的 P0 参数表.xlsx",
    );
    expect(contentProductionArtifactName("P01-data.csv")).toBe("P01-data.csv");
    expect(contentProductionArtifactName("review_customer_input.md")).toBe(
      "review_customer_input.md",
    );
    expect(contentProductionTaskTitle("P0 · 创建或导入 P0")).toBe(
      "P0 · 制作品牌深度文章",
    );
    expect(contentProductionTaskTitle("用户自定义 P0 项目")).toBe(
      "用户自定义 P0 项目",
    );
  });

  it("explains example choices without invented rankings or changing their native meaning", () => {
    expect(
      contentProductionPublicText("方案 A：Top20 例文；方案 B：AI 答案"),
    ).toBe("参考例文的文风：参考例文；参考 AI 答案的文风：AI 答案");
    expect(
      contentProductionPublicText("P00 用于 P0 品牌文章，P01–P06 用于问题文章"),
    ).toBe("品牌深度文章 用于 品牌深度文章，六种问题文章类型 用于问题文章");
  });
});
