import { describe, expect, it } from "vitest";

import { toKnowledgeBasePublicPayload } from "./knowledge-base-public-projection";

describe("knowledge-base customer public projection", () => {
  it("removes raw protocol failures, provider urls and internal notice codes", () => {
    const payload = toKnowledgeBasePublicPayload({
      progress: {
        build: {
          status: "protocol_error",
          protocolError:
            "Manus 明确拒绝了当前请求；系统不会自动重发，请联系支持处理",
        },
      },
      observation: {
        canonicalTaskUrl: "https://open.manus.ai/task/private-task-id",
        interaction: {
          lockReason: "Manus 明确拒绝了当前请求",
        },
        notice: {
          key: "build:MANUS_V2_TASK_ERROR",
          code: "MANUS_V2_TASK_ERROR",
          message: "系统正在恢复当前操作。Manus 明确拒绝了当前请求。",
          severity: "warning",
          retryable: false,
          failureClass: "terminal_nonregenerable",
          recoveryAction: "contact_support",
          turnId: "provider-turn-id",
          createdAt: 1_753_200_000_000,
        },
      },
    });

    expect(payload.progress.build.protocolError).toBeNull();
    expect(payload.observation.canonicalTaskUrl).toBeNull();
    expect(payload.observation.interaction.lockReason).toBe(
      "FrontMind 明确拒绝了当前请求",
    );
    expect(payload.observation.notice).toMatchObject({
      code: "FRONTMIND_KB_STOPPED",
      message: "本轮已停止，不会自动重发。已完成内容不受影响。",
      turnId: null,
    });
    expect(payload.observation.notice.key).toBe(
      "frontmind-kb:FRONTMIND_KB_STOPPED:contact_support:1753200000000",
    );
    expect(payload.observation.notice).not.toHaveProperty("traceId");
    expect(JSON.stringify(payload)).not.toMatch(/manus/iu);
    expect(JSON.stringify(payload)).not.toContain("系统正在恢复当前操作");
  });

  it("maps actionable historical notices to a provider-neutral action", () => {
    const payload = toKnowledgeBasePublicPayload({
      notice: {
        key: "MANUS_V2_LOCAL_REHYDRATE_REJECTED",
        code: "MANUS_V2_LOCAL_REHYDRATE_REJECTED",
        message: "raw provider notice",
        recoveryAction: "create_new_canonical_from_snapshot",
        failureClass: "requires_user_fix",
        retryable: true,
        createdAt: 1,
      },
    });

    expect(payload.notice).toMatchObject({
      code: "FRONTMIND_KB_NEW_GENERATION_REQUIRED",
      message: "需要你确认后创建新的知识库任务。已完成内容不受影响。",
    });
    expect(JSON.stringify(payload)).not.toMatch(/manus/iu);
  });

  it.each([
    [
      "wait",
      "FRONTMIND_KB_IN_PROGRESS",
      "当前任务仍在处理中，请稍后刷新。已完成内容不受影响。",
    ],
    [
      "awaiting_input",
      "FRONTMIND_KB_INPUT_REQUIRED",
      "原任务正在等待确认或输入，请完成所需操作后继续。已完成内容不受影响。",
    ],
    [
      "reconcile",
      "FRONTMIND_KB_STATUS_PENDING",
      "系统正在读取当前任务状态，请稍后刷新。已完成内容不受影响。",
    ],
    [
      "retry_request",
      "FRONTMIND_KB_RETRY_AVAILABLE",
      "需要你确认后继续本轮。已完成内容不受影响。",
    ],
    [
      "start_new_generation",
      "FRONTMIND_KB_NEW_GENERATION_REQUIRED",
      "需要你确认后创建新的知识库任务。已完成内容不受影响。",
    ],
    [
      "stopped",
      "FRONTMIND_KB_STOPPED",
      "本轮已停止，不会自动重发。已完成内容不受影响。",
    ],
    [
      "top_up",
      "FRONTMIND_KB_RETRY_AVAILABLE",
      "需要补充可用额度后继续本轮。已完成内容不受影响。",
    ],
    [
      "update_credential",
      "FRONTMIND_KB_RETRY_AVAILABLE",
      "需要更新连接凭证后继续本轮。已完成内容不受影响。",
    ],
    [
      "fix_attachments",
      "FRONTMIND_KB_RESELECT_FILES",
      "需要重新选择所需文件后继续。已完成内容不受影响。",
    ],
    [
      "reupload_logo",
      "FRONTMIND_KB_RESELECT_FILES",
      "需要重新选择所需文件后继续。已完成内容不受影响。",
    ],
    [
      "approve_reset",
      "FRONTMIND_KB_RESET_REQUIRED",
      "任务已结束，但知识库文件未通过完整性校验。系统不会自动重试；请申请重置后重新上传资料。",
    ],
    [
      "regenerate_turn",
      "FRONTMIND_KB_NEW_GENERATION_REQUIRED",
      "需要你确认后创建新的知识库任务。已完成内容不受影响。",
    ],
    [
      "resume_start_from_retained_sources",
      "FRONTMIND_KB_NEW_GENERATION_REQUIRED",
      "需要你确认后使用已保留资料重新开始。已完成内容不受影响。",
    ],
    [
      "reselect_start_sources",
      "FRONTMIND_KB_RESELECT_FILES",
      "需要重新选择所需文件后继续。已完成内容不受影响。",
    ],
    [
      "create_new_canonical_from_snapshot",
      "FRONTMIND_KB_NEW_GENERATION_REQUIRED",
      "需要你确认后创建新的知识库任务。已完成内容不受影响。",
    ],
    [
      "contact_support",
      "FRONTMIND_KB_STOPPED",
      "本轮已停止，不会自动重发。已完成内容不受影响。",
    ],
  ] as const)(
    "maps %s to an explicit customer-safe state",
    (recoveryAction, code, message) => {
      const payload = toKnowledgeBasePublicPayload({
        notice: {
          key: "private-key",
          code: "PRIVATE_CODE",
          message: "private message",
          recoveryAction,
          createdAt: 7,
        },
      });

      expect(payload.notice).toMatchObject({ recoveryAction, code, message });
      expect(payload.notice).not.toHaveProperty("traceId");
      expect(JSON.stringify(payload)).not.toMatch(/(?:supportId|排查编号)/iu);
    },
  );

  it("fails a new or malformed recovery action closed without a customer trace", () => {
    const payload = toKnowledgeBasePublicPayload({
      notice: {
        key: "private-key",
        code: "PRIVATE_CODE",
        message: "private message",
        recoveryAction: "future_unreviewed_action",
        traceId: "internal-trace",
        createdAt: 9,
      },
    });

    expect(payload.notice).toMatchObject({
      recoveryAction: "contact_support",
      code: "FRONTMIND_KB_STOPPED",
      message: "本轮已停止，不会自动重发。已完成内容不受影响。",
    });
    expect(payload.notice).not.toHaveProperty("traceId");
  });

  it("keeps an ISO creation time in the safe notice key", () => {
    const payload = toKnowledgeBasePublicPayload({
      notice: {
        recoveryAction: "approve_reset",
        createdAt: "2026-08-15T13:45:10.123Z",
      },
    });

    expect(payload.notice.key).toBe(
      "frontmind-kb:FRONTMIND_KB_RESET_REQUIRED:approve_reset:2026-08-15T13:45:10.123Z",
    );
  });

  it("projects a materialized non-quota provider failure as explicit contact-support attention", () => {
    const payload = toKnowledgeBasePublicPayload({
      notice: {
        code: "KNOWLEDGE_BASE_MATERIALIZED_PROVIDER_ATTENTION",
        message: "private provider failure",
        recoveryAction: "contact_support",
        failureClass: "terminal_nonregenerable",
        retryable: false,
        createdAt: 11,
      },
    });

    expect(payload.notice).toMatchObject({
      code: "FRONTMIND_KB_ATTENTION_REQUIRED",
      message:
        "原任务执行发生错误，系统不会自动重发；请联系支持处理。已完成内容不受影响。",
      recoveryAction: "contact_support",
      retryable: false,
    });
    expect(JSON.stringify(payload)).not.toMatch(
      /(?:文件|完整性|重置|KNOWLEDGE_BASE_MATERIALIZED_PROVIDER_ATTENTION)/u,
    );
  });

  it("publishes only the opaque explicit token and provider-neutral action", () => {
    const payload = toKnowledgeBasePublicPayload({
      notice: {
        key: "private-source-turn",
        code: "MANUS_V2_CREATE_REJECTED",
        message: "raw provider notice",
        recoveryAction: "retry_request",
        recoveryToken: "a".repeat(64),
        sourceTurnId: "private-source-turn",
        credentialId: "private-credential",
        retryable: true,
        createdAt: 1,
      },
    });

    expect(payload.notice).toMatchObject({
      code: "FRONTMIND_KB_RETRY_AVAILABLE",
      recoveryAction: "retry_request",
      recoveryToken: "a".repeat(64),
      turnId: null,
    });
    expect(payload.notice).not.toHaveProperty("sourceTurnId");
    expect(payload.notice).not.toHaveProperty("credentialId");
  });

  it("maps internal upstream error codes to the public FrontMind code", () => {
    const payload = toKnowledgeBasePublicPayload({
      error: {
        code: "UPSTREAM_TASK_READ_FAILED",
        message: "读取知识库任务结果失败，正在自动重试",
      },
    });

    expect(payload.error.code).toBe("FRONTMIND_KB_RETRY_AVAILABLE");
    expect(JSON.stringify(payload)).not.toMatch(/upstream/iu);
  });

  it("projects an incomplete fresh start as reset-only instead of file recovery", () => {
    const payload = toKnowledgeBasePublicPayload({
      notice: {
        key: "private-fresh-start",
        code: "KNOWLEDGE_BASE_START_INCOMPLETE",
        message: "private",
        recoveryAction: "approve_reset",
        retryable: false,
        createdAt: 1,
      },
    });

    expect(payload.notice).toMatchObject({
      code: "FRONTMIND_KB_RESET_REQUIRED",
      message: "本次分析任务尚未创建；请申请重置后重新选择全部资料。",
      recoveryAction: "approve_reset",
      retryable: false,
    });
  });

  it("projects an incomplete middle-node upload without claiming the analysis never started", () => {
    const payload = toKnowledgeBasePublicPayload({
      notice: {
        key: "private-revision-upload",
        code: "KNOWLEDGE_BASE_REVISION_UPLOAD_INCOMPLETE",
        message: "private",
        recoveryAction: "approve_reset",
        retryable: false,
        createdAt: 1,
      },
    });

    expect(payload.notice).toMatchObject({
      code: "FRONTMIND_KB_RESET_REQUIRED",
      message:
        "本轮补充资料尚未完成，任务尚未派发；请申请重置后重新上传全部资料。",
      recoveryAction: "approve_reset",
      retryable: false,
    });
    expect(payload.notice.message).not.toContain("分析任务尚未创建");
  });

  it("preserves the server-owned pre-create reset copy and customer-only attachment count", () => {
    const payload = toKnowledgeBasePublicPayload({
      taskCreationState: "not_attempted",
      failureStage: "provider_file_registration",
      retainedCustomerAttachmentCount: 9,
      generatedSystemAttachmentCount: 2,
      settledAt: 1_755_446_677_000,
      notice: {
        key: "private-pre-create-reset",
        code: "FRONTMIND_KB_RESET_REQUIRED",
        message:
          "知识库任务未创建。9/9 份客户资料已保留，但云端附件登记未完成。请批准重置后重新上传资料。",
        attachmentCount: 9,
        recoveryAction: "approve_reset",
        retryable: false,
        createdAt: 1_755_446_677_000,
      },
    });

    expect(payload).toMatchObject({
      taskCreationState: "not_attempted",
      failureStage: "provider_file_registration",
      retainedCustomerAttachmentCount: 9,
      generatedSystemAttachmentCount: 2,
      settledAt: 1_755_446_677_000,
      notice: {
        code: "FRONTMIND_KB_RESET_REQUIRED",
        message:
          "知识库任务未创建。9/9 份客户资料已保留，但云端附件登记未完成。请批准重置后重新上传资料。",
        attachmentCount: 9,
      },
    });
  });

  it("drops customer support coordinates recursively at the root and every nested level", () => {
    const payload = toKnowledgeBasePublicPayload({
      traceId: "root-trace",
      supportId: "root-support",
      result: {
        traceId: "nested-trace",
        supportId: "nested-support",
        items: [
          {
            traceId: "array-trace",
            supportId: "array-support",
            value: "safe",
          },
        ],
      },
    });

    expect(payload).toEqual({
      result: {
        items: [{ value: "safe" }],
      },
    });
    expect(JSON.stringify(payload)).not.toMatch(/(?:traceId|supportId)/u);
  });
});
