import { describe, expect, it } from "vitest";

import {
  extractKnowledgeBaseProtocolObjects,
  stripKnowledgeBaseProtocolPayloads,
  stripKnowledgeBaseReferenceAppendix,
} from "../shared/knowledge-base-output";

describe("stripKnowledgeBaseReferenceAppendix", () => {
  it.each(["**参考资料**", "## 参考资料", "References", "### Sources"])(
    "removes the standalone %s appendix and everything after it",
    (heading) => {
      expect(
        stripKnowledgeBaseReferenceAppendix(
          [
            "## 中文名称、英文品牌与视觉识别",
            "",
            "硅基流动的英文品牌名称为 SiliconFlow。",
            "",
            heading,
            "[1] https://siliconflow.cn/",
            '<!-- FRONTMIND_KB_PROGRESS {"revision":0} -->',
          ].join("\n"),
        ),
      ).toBe(
        [
          "## 中文名称、英文品牌与视觉识别",
          "",
          "硅基流动的英文品牌名称为 SiliconFlow。",
        ].join("\n"),
      );
    },
  );

  it("does not truncate an ordinary sentence that mentions reference material", () => {
    const text = "企业提供的参考资料包括产品手册与品牌规范。";
    expect(stripKnowledgeBaseReferenceAppendix(text)).toBe(text);
  });
});

describe("knowledge-base protocol output compatibility", () => {
  it("extracts and removes balanced bare JSON protocol objects", () => {
    const text = [
      "节点正文包含普通 {括号}。",
      '{"kind":"frontmind.knowledge-base.manifest","schemaVersion":1,"leaves":[{"id":"1.1","title":"企业定位"}]}',
      '{"kind":"frontmind.workflow-state","schemaVersion":1,"currentLeafId":"1.1"}',
      "正文结尾。",
    ].join("\n");

    expect(
      extractKnowledgeBaseProtocolObjects(text).map((value) => value.kind),
    ).toEqual([
      "frontmind.knowledge-base.manifest",
      "frontmind.workflow-state",
    ]);
    expect(stripKnowledgeBaseProtocolPayloads(text)).toContain(
      "节点正文包含普通 {括号}。",
    );
    expect(stripKnowledgeBaseProtocolPayloads(text)).toContain("正文结尾。");
    expect(stripKnowledgeBaseProtocolPayloads(text)).not.toContain(
      "frontmind.",
    );
  });

  it("removes the legacy SOCRATIC_KB_STATE comment returned by a real task", () => {
    const text = [
      "## 1.1 企业定位",
      "",
      "FrontMind 超前智能面向 AI 原生时代提供企业级服务。",
      "",
      "<!--SOCRATIC_KB_STATE",
      '{"revision":0,"stage":"leaf_confirmation","knowledgeTree":{"branches":9,"leaves":52}}',
      "SOCRATIC_KB_STATE-->",
    ].join("\n");

    expect(stripKnowledgeBaseProtocolPayloads(text)).toBe(
      "## 1.1 企业定位\n\nFrontMind 超前智能面向 AI 原生时代提供企业级服务。\n\n",
    );
  });
});
