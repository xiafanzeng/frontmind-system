import { KnowledgeBaseArtifactBindingError } from "./knowledge-base-artifact-binding-service";

export class KnowledgeBaseLocalPreparationError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "KnowledgeBaseLocalPreparationError";
  }
}

export function knowledgeBaseArtifactFailureNotice(error: unknown) {
  if (
    error instanceof KnowledgeBaseArtifactBindingError &&
    error.code === "PACKAGE_INVALID"
  ) {
    const reason = error.message
      .replace(/[\u0000-\u001f\u007f]+/gu, " ")
      .trim()
      .slice(0, 600);
    return {
      code: "FINAL_PACKAGE_INVALID",
      message: `最终知识库 ZIP 不符合 Dashboard v4 归档合同：${reason || "结构或素材不完整"}。本轮未推进；请重试本轮，系统会重新提供权威正文与全部素材，并要求生成端通过同一校验器后再交付。`,
    } as const;
  }
  return {
    code: "PROGRESS_PROTOCOL_INVALID",
    message: "知识库资源校验未通过，本轮内容尚未更新",
  } as const;
}

export function classifyKnowledgeBaseOpenRecoveryFailure(
  status:
    | "researching"
    | "confirming"
    | "ready_to_publish"
    | "published"
    | "protocol_error"
    | "failed",
  protocolErrorCode?: string | null,
) {
  return status === "ready_to_publish" ||
    (status === "protocol_error" &&
      protocolErrorCode === "PACKAGE_REBIND_REQUIRED")
    ? ("package_rebind_required" as const)
    : ("fatal" as const);
}

export class KnowledgeBaseOpenRecoveryLeaseError extends Error {
  readonly code = "KNOWLEDGE_BASE_OPEN_RECOVERY_LEASE_LOST";

  constructor(
    message = "Knowledge-base open recovery lease was lost",
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "KnowledgeBaseOpenRecoveryLeaseError";
  }
}

export const KNOWLEDGE_BASE_AGENT_PROFILE = "frontmind-pro" as const;
export const KNOWLEDGE_BASE_UPSTREAM_CREATE_TIMEOUT_MS = 120_000;

export class KnowledgeBaseAttachmentsProcessingError extends Error {
  readonly code = "KNOWLEDGE_BASE_ATTACHMENTS_PROCESSING";

  constructor(
    public readonly readyCount: number,
    public readonly pendingCount: number,
    public readonly retryAfterMs = 5_000,
    public readonly traceId?: string,
    options?: ErrorOptions,
  ) {
    super("Knowledge-base attachments are still processing upstream", options);
    this.name = "KnowledgeBaseAttachmentsProcessingError";
  }
}

/**
 * Local rollout pause before the first Manus v2 task.create. No provider
 * request has been attempted, so the durable turn may be retried only after an
 * operator explicitly enables the relevant writer or migration authority.
 */
export class KnowledgeBaseManusV2RolloutDeferredError extends Error {
  readonly code = "KNOWLEDGE_BASE_MANUS_V2_ROLLOUT_DISABLED";

  constructor() {
    super("The first Manus v2 task create is disabled by rollout policy");
    this.name = "KnowledgeBaseManusV2RolloutDeferredError";
  }
}

export type KnowledgeBaseUpstreamCreateFailureClass =
  | "deterministic"
  | "retriable"
  | "unknown";

/** Classify whether an upstream create was rejected or may have been accepted. */
export function classifyKnowledgeBaseUpstreamCreateFailure(input: {
  status?: unknown;
  code?: unknown;
  missingTaskId?: boolean;
  transportError?: boolean;
}): KnowledgeBaseUpstreamCreateFailureClass {
  // A successful HTTP response without a readable id may have created the
  // task while returning a partial body. There is no documented provider
  // idempotency or lookup authority, so fail closed as unknown and never POST
  // this logical turn again.
  if (input.missingTaskId) return "unknown";
  if (input.transportError) return "unknown";
  const status = Number(input.status);
  if (!Number.isInteger(status) || status <= 0) return "unknown";
  const code = String(input.code || "")
    .trim()
    .toUpperCase();
  // The provider task-create endpoint has no documented idempotency contract.
  // A timeout, throttle, or 5xx response may therefore hide an accepted task;
  // retaining the same logical turn is safe, but issuing another POST is not.
  return code === "IDEMPOTENCY_PENDING" ||
    status === 408 ||
    status === 425 ||
    status === 429 ||
    status >= 500
    ? "unknown"
    : "deterministic";
}

export type KnowledgeBaseProviderReasonCategory =
  | "ATTACHMENT_NOT_READY"
  | "ATTACHMENT_INVALID"
  | "PAYLOAD_INVALID"
  | "PROFILE_INVALID"
  | "CREDENTIAL_REJECTED"
  | "QUOTA_REJECTED"
  | "UPSTREAM_UNAVAILABLE"
  | "UNKNOWN_INVALID_ARGUMENT"
  | "UNKNOWN_PROVIDER_REJECTION"
  | "TASK_ID_MISSING"
  | "TRANSPORT_UNKNOWN";

export class KnowledgeBaseUpstreamCreateError extends Error {
  constructor(
    public readonly failureClass: KnowledgeBaseUpstreamCreateFailureClass,
    public readonly failureCode: string,
    public readonly status?: number,
    public readonly reasonCategory?: KnowledgeBaseProviderReasonCategory,
    public readonly providerRequestRef?: string,
    public readonly traceId?: string,
  ) {
    super("Knowledge-base upstream task creation failed");
    this.name = "KnowledgeBaseUpstreamCreateError";
  }
}
