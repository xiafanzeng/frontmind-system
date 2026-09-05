import { describe, expect, it } from "vitest";

import {
  KNOWLEDGE_COLLECTION_STATUS_COPY,
  normalizeKnowledgeCollectionCopy,
} from "./knowledge-base-copy";

describe("knowledge-base collection copy", () => {
  it("normalizes historical active-task copy without changing unrelated text", () => {
    const historical =
      "FrontMind 正在按业务分支进行广度优先、深度受控的资料采集。此阶段无需逐项确认，完成后将直接生成可核验知识库。";
    expect(normalizeKnowledgeCollectionCopy(historical)).toBe(
      KNOWLEDGE_COLLECTION_STATUS_COPY,
    );
    expect(normalizeKnowledgeCollectionCopy(`前言\n${historical}\n结尾`)).toBe(
      `前言\n${KNOWLEDGE_COLLECTION_STATUS_COPY}\n结尾`,
    );
    expect(normalizeKnowledgeCollectionCopy("普通历史消息")).toBe(
      "普通历史消息",
    );
  });
});
