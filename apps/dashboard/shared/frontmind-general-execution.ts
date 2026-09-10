/** Tenant-owned execution evidence with explicit public summaries only.
 * Tool arguments and tool result payloads are not part of this contract. */
export type GeneralThinkingText = {
  /** Explicit provider-designated public summary; private thinkingText is not UI copy. */
  publicSummary?: string;
  thinkingText?: string;
  thinkingSource?: "event" | "stream";
  thinkingComplete?: boolean;
};
export type GeneralToolStatus =
  | "running"
  | "waiting"
  | "completed"
  | "failed"
  | "returned"
  | "unconfirmed";
export type GeneralExecutionActivity =
  | { kind: "tool_use"; label: string; toolKind: "builtin" | "mcp" | "custom" }
  | { kind: "tool_result"; callId: string | null; isError: boolean | null }
  | ({
      kind: "status";
      status:
        | "thinking"
        | "running"
        | "rescheduling"
        | "waiting"
        | "retrying"
        | "error"
        | "ended"
        | "cancelled";
      waitingIds?: string[];
    } & GeneralThinkingText);

export type GeneralExecutionEntry = {
  id: string;
  runId?: string;
  phase?: BusinessExecutionPhase;
  label?: string;
  isCurrent?: boolean;
  finishedAt?: number;
  turnId: string;
  /** Durable sequence of the user message that owns this evidence. */
  userSequence: number;
  userMessageId?: string;
  timestamp: number;
  rank: number;
} & (
  | { kind: "message"; providerEventId: string }
  | {
      kind: "tool";
      label: string;
      status: GeneralToolStatus;
      toolKind?: "builtin" | "mcp" | "custom";
      finishedAt?: number;
      resultOnly?: true;
    }
  | ({
      kind: "status";
      status: Extract<GeneralExecutionActivity, { kind: "status" }>["status"];
    } & GeneralThinkingText)
);

export interface GeneralExecutionDto {
  schemaVersion: 1;
  taskId: string;
  /** Stable business run identity, including preparation before a model task exists. */
  runId?: string;
  phase?: string;
  coverage: "complete" | "partial" | "pending" | "unavailable";
  timeline: GeneralExecutionEntry[];
}

const builtinLabels: Record<string, string> = {
  bash: "执行命令",
  read: "读取文件",
  write: "写入文件",
  edit: "编辑文件",
  grep: "检索文本",
  find: "查找文件",
  ls: "查看目录",
  web_search: "搜索网页",
  web_fetch: "读取网页",
  browser: "浏览网页",
  python: "运行代码",
  code_interpreter: "运行代码",
};
export function generalToolLabel(
  name: unknown,
  kind: "builtin" | "mcp" | "custom",
) {
  return kind === "builtin" &&
    typeof name === "string" &&
    Object.hasOwn(builtinLabels, name)
    ? builtinLabels[name]!
    : kind === "mcp"
      ? "调用扩展工具"
      : "调用工具";
}

/** Private reasoning is never persisted or exposed by execution projections. */
export function generalThinkingText(
  value: GeneralThinkingText,
): GeneralThinkingText {
  const publicSummary =
    typeof value.publicSummary === "string" && value.publicSummary.trim()
      ? value.publicSummary.trim().slice(0, 8000)
      : undefined;
  return publicSummary ? { publicSummary } : {};
}

/** Strict whitelist at both normalization and persisted-data read boundaries. */
export function generalExecutionActivity(
  value: unknown,
): GeneralExecutionActivity | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const item = value as Record<string, unknown>;
  if (item.kind === "tool_use") {
    const labels = [
      ...Object.values(builtinLabels),
      "调用扩展工具",
      "调用工具",
    ];
    return {
      kind: "tool_use",
      label:
        typeof item.label === "string" && labels.includes(item.label)
          ? item.label
          : "调用工具",
      toolKind:
        item.toolKind === "mcp"
          ? "mcp"
          : item.toolKind === "custom"
            ? "custom"
            : "builtin",
    };
  }
  if (item.kind === "tool_result")
    return {
      kind: "tool_result",
      callId:
        typeof item.callId === "string" && item.callId.length <= 512
          ? item.callId
          : null,
      isError: typeof item.isError === "boolean" ? item.isError : null,
    };
  if (
    item.kind === "status" &&
    [
      "thinking",
      "running",
      "rescheduling",
      "waiting",
      "retrying",
      "error",
      "ended",
      "cancelled",
    ].includes(String(item.status))
  ) {
    return {
      kind: "status",
      ...(item.status === "thinking"
        ? generalThinkingText(item as GeneralThinkingText)
        : {}),
      status: item.status as Extract<
        GeneralExecutionActivity,
        { kind: "status" }
      >["status"],
      ...(item.status === "waiting" && Array.isArray(item.waitingIds)
        ? {
            waitingIds: item.waitingIds
              .filter(
                (id): id is string =>
                  typeof id === "string" && id.length <= 512,
              )
              .slice(0, 128),
          }
        : {}),
    };
  }
  return null;
}

export const generalToolStatusText: Record<GeneralToolStatus, string> = {
  running: "执行中",
  waiting: "等待确认",
  completed: "已完成",
  failed: "调用失败",
  returned: "已返回结果",
  unconfirmed: "结果未确认",
};
export const generalExecutionStatusText: Record<
  Extract<GeneralExecutionEntry, { kind: "status" }>["status"],
  string
> = {
  thinking: "正在分析任务…",
  running: "正在执行…",
  rescheduling: "正在恢复执行…",
  waiting: "等待确认",
  retrying: "正在重试…",
  error: "执行遇到问题",
  ended: "本轮已结束",
  cancelled: "本轮已停止",
};

/** Public business phases are an allowlist, never provider payload labels. */
export const businessExecutionLabels = {
  uploading: "上传资料",
  staging: "校验资料",
  dispatching: "准备调研",
  researching: "采集公开资料",
  normalizing: "整理结果",
  published: "生成知识库",
  submitting_question: "提交问题",
  loading_knowledge: "读取知识依据",
  confirming_result: "确认结果",
  saving_result: "保存结果",
  analyzing_question: "分析问题",
  searching_knowledge: "查找企业知识",
  organizing_evidence: "整理依据",
  answering: "生成回答",
  identifying_questions: "识别问题",
  checking_knowledge: "检查知识依据",
  suggesting: "提出优化建议",
  generating_result: "生成结果",
  preparing_requirements: "整理需求",
  searching_materials: "检索资料",
  generating_content: "生成内容",
  checking_content: "校验内容",
  delivering: "准备交付",
  reading_requirements: "读取需求",
  preparing_assets: "准备素材",
  generating_pages: "生成页面",
  checking_pages: "运行检查",
  previewing: "生成预览",
  revising_site: "修订网站",
  deploying_site: "部署网站",
  publishing_site: "发布网站",
  verifying_site: "验证线上网站",
  creating_monitor: "创建监控问题",
  preparing_collection: "准备采集",
  awaiting_collection: "等待采集",
  collection_result: "采集结果",
  collecting: "执行采集",
  organizing_samples: "整理样本",
  reporting: "生成报告",
  importing_samples: "导入监控数据",
  reading_monitor: "读取已有项目或导入批次",
  loading_run: "加载运行",
  showing_samples: "展示样本和引用",
  checking_assets: "校验素材",
  creating_publication: "创建发布批次",
  submitting_publication: "提交发布",
  accepted_publication: "发布已受理",
  awaiting_publication: "等待发布结果",
  showing_publication: "展示发布状态",
} as const;
export type BusinessExecutionPhase = keyof typeof businessExecutionLabels;
export type PublicBusinessEvidence = {
  id: string;
  turnId: string;
  userSequence?: number;
  userMessageId?: string;
  phase: BusinessExecutionPhase;
  status: Extract<GeneralExecutionEntry, { kind: "status" }>["status"];
  timestamp: number;
  rank: number;
  /** Safe business subject (question/platform or media name), never provider diagnostics. */
  subject?: string;
  finishedAt?: number;
};
/** Deterministic hydration: dedupe within the owning turn before any rendering. */
export function orderExecutionTimeline(
  entries: readonly GeneralExecutionEntry[],
) {
  return [
    ...new Map(
      entries.map((entry) => [JSON.stringify([entry.turnId, entry.id]), entry]),
    ).values(),
  ].sort(
    (a, b) =>
      a.userSequence - b.userSequence ||
      a.turnId.localeCompare(b.turnId) ||
      a.rank - b.rank ||
      a.timestamp - b.timestamp,
  );
}
export function projectBusinessExecution(
  runId: string,
  evidence: readonly PublicBusinessEvidence[],
): GeneralExecutionDto {
  const timeline = orderExecutionTimeline(
    evidence
      .filter(
        (event) =>
          Number.isFinite(event.timestamp) &&
          Number.isFinite(event.rank) &&
          Object.hasOwn(businessExecutionLabels, event.phase),
      )
      .map((event) => ({
        id: event.id,
        runId,
        turnId: event.turnId,
        userSequence: event.userSequence ?? 0,
        ...(event.userMessageId ? { userMessageId: event.userMessageId } : {}),
        timestamp: event.timestamp,
        rank: event.rank,
        kind: "status" as const,
        status: event.status,
        phase: event.phase,
        label: businessExecutionLabels[event.phase],
        ...(event.subject?.trim() ? { publicSummary: event.subject.trim().slice(0, 300) } : {}),
        ...(event.finishedAt === undefined
          ? {}
          : { finishedAt: event.finishedAt }),
      })),
  );
  const last = timeline.at(-1);
  for (const item of timeline)
    item.isCurrent =
      item.id === last?.id &&
      !["ended", "error", "cancelled"].includes(
        (item as Extract<GeneralExecutionEntry, { kind: "status" }>).status,
      );
  return {
    schemaVersion: 1,
    taskId: runId,
    runId,
    coverage: timeline.length ? "partial" : "unavailable",
    timeline,
  };
}
