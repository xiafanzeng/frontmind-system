/** Tenant-owned execution evidence, including thinking text returned by the provider.
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
  coverage: "complete" | "pending" | "unavailable";
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

/** Only explicit thinking text is accepted; arbitrary provider objects are never serialized. */
export function generalThinkingText(
  value: GeneralThinkingText,
): GeneralThinkingText {
  const publicSummary =
    typeof value.publicSummary === "string" && value.publicSummary.trim()
      ? value.publicSummary.trim().slice(0, 8000)
      : undefined;
  if (typeof value.thinkingText !== "string" || !value.thinkingText.trim())
    return publicSummary ? { publicSummary } : {};
  return {
    ...(publicSummary ? { publicSummary } : {}),
    thinkingText: value.thinkingText,
    thinkingSource: value.thinkingSource === "stream" ? "stream" : "event",
    thinkingComplete: value.thinkingComplete !== false,
  };
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
