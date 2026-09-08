export const KNOWLEDGE_COLLECTION_STATUS_COPY =
  "FrontMind 正在按业务分支进行资料采集。此阶段无需逐项确认，完成后将直接生成可核验知识库。";

export const KNOWLEDGE_DRAFT_READY_COPY =
  "修改已保存，点击更新知识库生成并启用新版本。";

export const KNOWLEDGE_UPDATE_PREPARING_COPY =
  "正在生成 ZIP 并更新知识库；生成期间，当前正式版本继续可用。";

export const KNOWLEDGE_UPDATE_ATTENTION_COPY =
  "知识库更新暂未完成，修改已保存；当前正式版本继续可用，请重试更新。";

export const KNOWLEDGE_UPDATE_COMPLETE_COPY =
  "当前知识库已更新，后续新任务将使用此版本。";

export const HISTORICAL_KNOWLEDGE_COPY_REWRITES = [
  { from: "知识库内容已完成。下载包正在准备中。", to: KNOWLEDGE_DRAFT_READY_COPY },
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
