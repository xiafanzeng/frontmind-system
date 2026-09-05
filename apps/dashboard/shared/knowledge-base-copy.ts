export const KNOWLEDGE_COLLECTION_STATUS_COPY =
  "FrontMind 正在按业务分支进行资料采集。此阶段无需逐项确认，完成后将直接生成可核验知识库。";

export const HISTORICAL_KNOWLEDGE_COPY_REWRITES = [
  {
    from: "FrontMind 正在按业务分支进行广度优先、深度受控的资料采集。此阶段无需逐项确认，完成后将直接生成可核验知识库。",
    to: KNOWLEDGE_COLLECTION_STATUS_COPY,
  },
] as const;

/** Normalize persisted historical copy; this never selects active UI copy. */
export function normalizeKnowledgeCollectionCopy(value: string) {
  return HISTORICAL_KNOWLEDGE_COPY_REWRITES.reduce(
    (current, rewrite) => current.replaceAll(rewrite.from, rewrite.to),
    value,
  );
}
