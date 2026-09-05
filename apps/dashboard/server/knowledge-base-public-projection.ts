import {
  containsPrivateProviderBrand,
  sanitizeFrontMindPublicText,
} from "../shared/frontmind-public-brand";
import {
  knowledgeBaseRecoveryActions,
  type KnowledgeBaseRecoveryAction,
} from "../shared/knowledge-base-progress";

type PublicJson =
  | null
  | boolean
  | number
  | string
  | PublicJson[]
  | {
      [key: string]: PublicJson;
    };

function publicRecoveryAction(value: unknown): KnowledgeBaseRecoveryAction {
  return knowledgeBaseRecoveryActions.includes(
    value as KnowledgeBaseRecoveryAction,
  )
    ? (value as KnowledgeBaseRecoveryAction)
    : "contact_support";
}

function publicRecoveryCopy(action: KnowledgeBaseRecoveryAction): {
  code: string;
  message: string;
} {
  switch (action) {
    case "wait":
      return {
        code: "FRONTMIND_KB_IN_PROGRESS",
        message: "当前任务仍在处理中，请稍后刷新。已完成内容不受影响。",
      };
    case "awaiting_input":
      return {
        code: "FRONTMIND_KB_INPUT_REQUIRED",
        message:
          "原任务正在等待确认或输入，请完成所需操作后继续。已完成内容不受影响。",
      };
    case "reconcile":
      return {
        code: "FRONTMIND_KB_STATUS_PENDING",
        message: "系统正在读取当前任务状态，请稍后刷新。已完成内容不受影响。",
      };
    case "retry_request":
      return {
        code: "FRONTMIND_KB_RETRY_AVAILABLE",
        message: "需要你确认后继续本轮。已完成内容不受影响。",
      };
    case "start_new_generation":
      return {
        code: "FRONTMIND_KB_NEW_GENERATION_REQUIRED",
        message: "需要你确认后创建新的知识库任务。已完成内容不受影响。",
      };
    case "stopped":
    case "contact_support":
      return {
        code: "FRONTMIND_KB_STOPPED",
        message: "本轮已停止，不会自动重发。已完成内容不受影响。",
      };
    case "top_up":
      return {
        code: "FRONTMIND_KB_RETRY_AVAILABLE",
        message: "需要补充可用额度后继续本轮。已完成内容不受影响。",
      };
    case "update_credential":
      return {
        code: "FRONTMIND_KB_RETRY_AVAILABLE",
        message: "需要更新连接凭证后继续本轮。已完成内容不受影响。",
      };
    case "fix_attachments":
    case "reupload_logo":
    case "reselect_start_sources":
      return {
        code: "FRONTMIND_KB_RESELECT_FILES",
        message: "需要重新选择所需文件后继续。已完成内容不受影响。",
      };
    case "approve_reset":
      return {
        code: "FRONTMIND_KB_RESET_REQUIRED",
        message:
          "任务已结束，但知识库文件未通过完整性校验。系统不会自动重试；请申请重置后重新上传资料。",
      };
    case "regenerate_turn":
    case "create_new_canonical_from_snapshot":
      return {
        code: "FRONTMIND_KB_NEW_GENERATION_REQUIRED",
        message: "需要你确认后创建新的知识库任务。已完成内容不受影响。",
      };
    case "resume_start_from_retained_sources":
      return {
        code: "FRONTMIND_KB_NEW_GENERATION_REQUIRED",
        message: "需要你确认后使用已保留资料重新开始。已完成内容不受影响。",
      };
    default: {
      const exhaustive: never = action;
      return exhaustive;
    }
  }
}

function publicNoticeCreatedAt(value: unknown) {
  if (typeof value === "number" && Number.isFinite(value) && value >= 0) {
    return String(Math.trunc(value));
  }
  if (typeof value !== "string") return "unknown";
  const normalized = value.trim();
  if (/^\d{1,16}$/u.test(normalized)) return normalized;
  const parsed = Date.parse(normalized);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : "unknown";
}

function publicNotice(value: Record<string, unknown>): Record<string, unknown> {
  const action = publicRecoveryAction(value.recoveryAction);
  const copy =
    action === "approve_reset" &&
    value.code === "KNOWLEDGE_BASE_START_INCOMPLETE"
      ? {
          code: "FRONTMIND_KB_RESET_REQUIRED",
          message: "本次分析任务尚未创建；请申请重置后重新选择全部资料。",
        }
      : action === "approve_reset" &&
          value.code === "KNOWLEDGE_BASE_REVISION_UPLOAD_INCOMPLETE"
        ? {
            code: "FRONTMIND_KB_RESET_REQUIRED",
            message:
              "本轮补充资料尚未完成，任务尚未派发；请申请重置后重新上传全部资料。",
          }
        : action === "contact_support" &&
            value.code === "KNOWLEDGE_BASE_MATERIALIZED_PROVIDER_ATTENTION"
          ? {
              code: "FRONTMIND_KB_ATTENTION_REQUIRED",
              message:
                "原任务执行发生错误，系统不会自动重发；请联系支持处理。已完成内容不受影响。",
            }
          : action === "approve_reset" &&
              value.code === "FRONTMIND_KB_RESET_REQUIRED" &&
              typeof value.message === "string" &&
              value.message.includes("知识库任务未创建")
            ? {
                code: "FRONTMIND_KB_RESET_REQUIRED",
                message: sanitizeFrontMindPublicText(value.message),
              }
            : publicRecoveryCopy(action);
  const createdAt = publicNoticeCreatedAt(value.createdAt);
  return {
    key: ["frontmind-kb", copy.code, action, createdAt].join(":"),
    code: copy.code,
    severity: value.severity ?? "warning",
    message: copy.message,
    retryable: value.retryable === true,
    failureClass: value.failureClass ?? null,
    recoveryAction: action,
    recoveryToken: value.recoveryToken ?? null,
    canRegenerate: value.canRegenerate === true,
    attachmentCount: value.attachmentCount ?? null,
    turnId: null,
    createdAt: value.createdAt ?? null,
  };
}

function project(value: unknown, key = ""): PublicJson {
  if (value === null || value === undefined) return null;
  if (typeof value === "string") return sanitizeFrontMindPublicText(value);
  if (typeof value === "number" || typeof value === "boolean") return value;
  if (Array.isArray(value)) return value.map((item) => project(item));
  if (typeof value !== "object") return sanitizeFrontMindPublicText(value);

  const source = value as Record<string, unknown>;
  const normalized = key === "notice" ? publicNotice(source) : source;
  const result: Record<string, PublicJson> = {};
  for (const [entryKey, entryValue] of Object.entries(normalized)) {
    if (entryKey === "traceId" || entryKey === "supportId") {
      continue;
    }
    if (entryKey === "protocolError" || entryKey === "canonicalTaskUrl") {
      result[entryKey] = null;
      continue;
    }
    if (entryKey === "code") {
      if (containsPrivateProviderBrand(entryValue)) {
        result[entryKey] = "FRONTMIND_KB_STOPPED";
        continue;
      }
      if (typeof entryValue === "string" && /^UPSTREAM_/u.test(entryValue)) {
        result[entryKey] = "FRONTMIND_KB_RETRY_AVAILABLE";
        continue;
      }
    }
    if (entryKey === "recoveryToken") {
      result[entryKey] =
        typeof entryValue === "string" && /^[a-f0-9]{64}$/u.test(entryValue)
          ? entryValue
          : null;
      continue;
    }
    result[entryKey] = project(entryValue, entryKey);
  }
  return result;
}

/** The single final transform for every authenticated customer KB response. */
export function toKnowledgeBasePublicPayload<T>(value: T): T {
  return project(value) as T;
}
