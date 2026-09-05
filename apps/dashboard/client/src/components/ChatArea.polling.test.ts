import { describe, expect, it, vi } from "vitest";
import {
  KNOWLEDGE_BASE_FOUNDATION_COPY,
  knowledgeBaseNoticeRecoveryMode,
  knowledgeBaseNoticeRetryLabel,
  knowledgeBasePackageRebindResolved,
  readKnowledgeBaseStartRequestError,
  recoverKnowledgeBaseNotice,
  runningAssistantStatusText,
  shouldRenderKnowledgeBaseNotice,
  shouldRecoverKnowledgeBaseStartFailure,
} from "./ChatArea";

describe("knowledge-base starter", () => {
  it("explains why the knowledge base must be built before the first task", () => {
    expect(KNOWLEDGE_BASE_FOUNDATION_COPY).toContain("AI 专用友好官网");
    expect(KNOWLEDGE_BASE_FOUNDATION_COPY).toContain("准确回答客户问题");
  });

  it("shows an explicit Dashboard-owned collection status while awaiting approved content", () => {
    expect(runningAssistantStatusText(true)).toBe(
      "FrontMind 正在按业务分支进行资料采集。此阶段无需逐项确认，完成后将直接生成可核验知识库。",
    );
    expect(runningAssistantStatusText(false)).toBe("FrontMind AI 正在处理...");
  });

  it("uses the durable reservation fact instead of treating every 5xx as accepted", () => {
    expect(
      shouldRecoverKnowledgeBaseStartFailure(true, {
        status: 500,
        reservationCreated: false,
      }),
    ).toBe(false);
    expect(
      shouldRecoverKnowledgeBaseStartFailure(true, {
        status: 409,
        reservationCreated: true,
      }),
    ).toBe(true);
    expect(
      shouldRecoverKnowledgeBaseStartFailure(true, {
        status: 503,
        code: "KNOWLEDGE_BASE_ROLLOUT_PENDING",
      }),
    ).toBe(false);
    expect(shouldRecoverKnowledgeBaseStartFailure(true, { status: 503 })).toBe(
      true,
    );
  });

  it("preserves the server error code and reservation boundary", async () => {
    const error = await readKnowledgeBaseStartRequestError(
      new Response(
        JSON.stringify({
          error: {
            code: "KNOWLEDGE_BASE_START_FAILED",
            message: "启动失败",
          },
          reservationCreated: false,
        }),
        {
          status: 500,
          headers: { "content-type": "application/json" },
        },
      ),
    );

    expect(error).toMatchObject({
      message: "启动失败",
      status: 500,
      code: "KNOWLEDGE_BASE_START_FAILED",
      reservationCreated: false,
    });
  });
});

describe("knowledge-base notice recovery", () => {
  const input = {
    conversationId: "knowledge-conversation",
    clientRequestId: "retry-request",
    expectedGeneration: 3,
    expectedRevision: 8,
    expectedLeafId: null,
  };

  it("keeps the legacy attachment unlock notice internal while rendering real failures", () => {
    expect(
      shouldRenderKnowledgeBaseNotice({
        code: "KNOWLEDGE_BASE_ATTACHMENTS_REQUIRED",
      }),
    ).toBe(false);
    expect(
      shouldRenderKnowledgeBaseNotice({ code: "PROGRESS_PROTOCOL_INVALID" }),
    ).toBe(true);
  });

  it("reconciles PACKAGE_REBIND_REQUIRED against the same task without creating a turn", async () => {
    const observation = { interaction: { progress: null } } as any;
    const reconcile = vi.fn().mockResolvedValue(observation);
    const retry = vi.fn();

    await expect(
      recoverKnowledgeBaseNotice(
        {
          ...input,
          notice: { code: "PACKAGE_REBIND_REQUIRED" },
        },
        { reconcile, retry },
      ),
    ).resolves.toBe(observation);

    expect(reconcile).toHaveBeenCalledWith({
      conversationId: "knowledge-conversation",
    });
    expect(retry).not.toHaveBeenCalled();
    expect(
      knowledgeBaseNoticeRecoveryMode({ code: "PACKAGE_REBIND_REQUIRED" }),
    ).toBe("reconcile");
    expect(
      knowledgeBaseNoticeRetryLabel({ code: "PACKAGE_REBIND_REQUIRED" }),
    ).toBe("重新绑定成品");
    expect(
      knowledgeBasePackageRebindResolved({
        ...observation,
        notice: {
          code: "PACKAGE_REBIND_REQUIRED",
          key: "rebind",
          severity: "error",
          message: "仍在等待 ZIP",
          retryable: true,
          turnId: null,
          createdAt: 1,
        },
        package: null,
      }),
    ).toBe(false);
    expect(
      knowledgeBasePackageRebindResolved({
        ...observation,
        notice: null,
        package: { sha256: "a".repeat(64) },
        interaction: { interactionState: "ready_to_publish" },
      }),
    ).toBe(true);
  });

  it("keeps ordinary retryable protocol failures on the new-turn path", async () => {
    const observation = { interaction: { progress: null } } as any;
    const reconcile = vi.fn();
    const retry = vi.fn().mockResolvedValue(observation);

    await expect(
      recoverKnowledgeBaseNotice(
        {
          ...input,
          expectedLeafId: "1.4",
          notice: { code: "PROGRESS_PROTOCOL_INVALID" },
        },
        { reconcile, retry },
      ),
    ).resolves.toBe(observation);

    expect(reconcile).not.toHaveBeenCalled();
    expect(retry).toHaveBeenCalledWith({
      conversationId: "knowledge-conversation",
      clientRequestId: "retry-request",
      expectedGeneration: 3,
      expectedRevision: 8,
      expectedLeafId: "1.4",
    });
    expect(
      knowledgeBaseNoticeRetryLabel({ code: "PROGRESS_PROTOCOL_INVALID" }),
    ).toBe("重试本轮");
  });
});
