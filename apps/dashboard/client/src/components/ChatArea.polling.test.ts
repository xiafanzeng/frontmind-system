import { describe, expect, it, vi } from "vitest";
import {
  KNOWLEDGE_BASE_FOUNDATION_COPY,
  knowledgeBaseExplicitRecoveryRequest,
  knowledgeBaseNoticeHasRecoveryAction,
  knowledgeBaseNoticeRecoveryMode,
  knowledgeBaseNoticeRequiresAttachmentRepair,
  knowledgeBaseNoticeRequiresLogoProvenanceRepair,
  knowledgeBaseNoticeRetryLabel,
  knowledgeBasePackageRebindResolved,
  knowledgeBaseReconcileResultChangedCoordinate,
  knowledgeBaseReconcileResultIsStopped,
  knowledgeBaseReconcileResultRequiresConfirmation,
  knowledgeBaseSameTurnRecoveryAccepted,
  isKnowledgeBaseTaskVisiblyRunning,
  isChatViewportNearBottom,
  readKnowledgeBaseStartRequestError,
  recoverKnowledgeBaseNotice,
  runningAssistantStatusText,
  scrollChatViewportToBottom,
  shouldRenderKnowledgeBaseNotice,
  shouldRecoverKnowledgeBaseStartFailure,
} from "./ChatArea";
import { requestKnowledgeBaseReset } from "@/lib/knowledge-progress";

describe("chat message viewport", () => {
  it("scrolls only the message viewport instead of every scrollable ancestor", () => {
    const scrollTo = vi.fn();

    scrollChatViewportToBottom({
      scrollHeight: 4_800,
      scrollTo,
    } as unknown as Pick<HTMLElement, "scrollHeight" | "scrollTo">);

    expect(scrollTo).toHaveBeenCalledOnce();
    expect(scrollTo).toHaveBeenCalledWith({
      top: 4_800,
      behavior: "auto",
    });
  });

  it("keeps live updates anchored only while the reader is near the bottom", () => {
    expect(
      isChatViewportNearBottom({
        scrollHeight: 4_800,
        clientHeight: 600,
        scrollTop: 4_120,
      }),
    ).toBe(true);
    expect(
      isChatViewportNearBottom({
        scrollHeight: 4_800,
        clientHeight: 600,
        scrollTop: 3_900,
      }),
    ).toBe(false);
  });
});

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

  it("stops the typing indicator and elapsed clock on an authoritative error", () => {
    expect(
      isKnowledgeBaseTaskVisiblyRunning({
        status: "running",
        syncKnowledgeBaseSnapshot: true,
        interactionState: "failed",
      }),
    ).toBe(false);
    expect(
      isKnowledgeBaseTaskVisiblyRunning({
        status: "pending",
        syncKnowledgeBaseSnapshot: true,
        noticeSeverity: "error",
      }),
    ).toBe(false);
    expect(
      isKnowledgeBaseTaskVisiblyRunning({
        status: "running",
        syncKnowledgeBaseSnapshot: false,
        noticeSeverity: "error",
      }),
    ).toBe(true);
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
    ).toBe(false);
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

  it("drops unsafe diagnostic fields from a start error", async () => {
    const error = await readKnowledgeBaseStartRequestError(
      new Response(
        JSON.stringify({
          error: {
            code: "UPSTREAM_CREATE_3 sk-secret",
            traceId: "<provider-raw>",
            message: "启动失败",
            attachmentCount: 1001,
          },
          reservationCreated: false,
        }),
        {
          status: 400,
          headers: { "content-type": "application/json" },
        },
      ),
    );

    expect(error.code).toBeUndefined();
    expect(error.traceId).toBeUndefined();
    expect(error.attachmentCount).toBeUndefined();
  });
});

describe("knowledge-base notice recovery", () => {
  const input = { conversationId: "knowledge-conversation", clientRequestId: "request", expectedGeneration: 3,
    expectedStateEpoch: 1, expectedRevision: 8, expectedLeafId: null };
  it.each(["retry_request", "start_new_generation", "create_new_canonical_from_snapshot", "regenerate_turn", "resume_start_from_retained_sources", "reselect_start_sources", "approve_reset"] as const)("requires a fresh reset for %s, regardless of a legacy token", async recoveryAction => {
    const notice = { recoveryAction, recoveryToken: "a".repeat(64), canRegenerate: true };
    const reconcile = vi.fn(), retry = vi.fn(), execute = vi.fn();
    expect(knowledgeBaseNoticeRecoveryMode(notice)).toBe("reset");
    expect(knowledgeBaseNoticeRetryLabel(notice)).toBe("重置知识库");
    await expect(recoverKnowledgeBaseNotice({ ...input, notice }, { reconcile, retry, execute })).rejects.toThrow("批准重置");
    expect(reconcile).not.toHaveBeenCalled(); expect(retry).not.toHaveBeenCalled(); expect(execute).not.toHaveBeenCalled();
  });
  it.each(["PACKAGE_REBIND_REQUIRED", "KNOWLEDGE_BASE_ATTACHMENTS_REQUIRED", "UPSTREAM_CREATE_3"])("removes the old %s entry point", code => {
    expect(knowledgeBaseNoticeRecoveryMode({ code })).toBe("reset");
    expect(knowledgeBaseNoticeRetryLabel({ code })).toBe("重置知识库");
  });
  it.each(["reconcile", "top_up", "update_credential"] as const)("only rereads the current task for %s", async recoveryAction => {
    const observation = { notice: null, interaction: { progress: null } } as any;
    const reconcile = vi.fn().mockResolvedValue(observation), retry = vi.fn(), execute = vi.fn();
    await expect(recoverKnowledgeBaseNotice({ ...input, notice: { recoveryAction } }, { reconcile, retry, execute })).resolves.toBe(observation);
    expect(reconcile).toHaveBeenCalledOnce(); expect(retry).not.toHaveBeenCalled(); expect(execute).not.toHaveBeenCalled();
  });
  it("requires explicit reset when status returns a retired task", () => {
    expect(knowledgeBaseReconcileResultRequiresConfirmation({ notice: { recoveryAction: "retry_request" } } as any)).toBe(true);
    expect(knowledgeBaseReconcileResultRequiresConfirmation({ notice: null })).toBe(false);
    const requested = vi.fn();
    window.addEventListener("frontmind:request-knowledge-reset", requested, { once: true });
    requestKnowledgeBaseReset(); expect(requested).toHaveBeenCalledOnce();
  });
  it("keeps source-file correction separate from retired task reconstruction", async () => {
    const notice = { code: "KNOWLEDGE_BASE_LOGO_PROVENANCE_REQUIRED" };
    const retry = vi.fn();
    expect(knowledgeBaseNoticeRecoveryMode(notice)).toBe("logo_repair");
    await expect(recoverKnowledgeBaseNotice({ ...input, notice }, { retry })).rejects.toThrow("专用入口");
    expect(retry).not.toHaveBeenCalled();
  });
});
