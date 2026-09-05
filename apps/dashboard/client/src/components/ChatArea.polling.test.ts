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
  const input = {
    conversationId: "knowledge-conversation",
    clientRequestId: "retry-request",
    expectedGeneration: 3,
    expectedRevision: 8,
    expectedLeafId: null,
  };

  it("renders an old attachment notice as reset-only instead of managed recovery", () => {
    expect(
      shouldRenderKnowledgeBaseNotice({
        code: "KNOWLEDGE_BASE_ATTACHMENTS_REQUIRED",
      }),
    ).toBe(true);
    expect(
      knowledgeBaseNoticeRecoveryMode({
        code: "KNOWLEDGE_BASE_ATTACHMENTS_REQUIRED",
      }),
    ).toBe("reset");
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

  it("never creates a new task from a legacy retryable flag alone", async () => {
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
    ).rejects.toThrow("不允许创建新的 API 任务");

    expect(reconcile).not.toHaveBeenCalled();
    expect(retry).not.toHaveBeenCalled();
    expect(
      knowledgeBaseNoticeRetryLabel({ code: "PROGRESS_PROTOCOL_INVALID" }),
    ).toBe("");
  });

  it("stops an old reconcile click at the new explicit confirmation point", async () => {
    const explicitObservation = {
      notice: {
        code: "FRONTMIND_KB_RETRY_AVAILABLE",
        recoveryAction: "retry_request",
        recoveryToken: "a".repeat(64),
        canRegenerate: false,
      },
      interaction: { progress: null },
    } as any;
    const reconcile = vi.fn().mockResolvedValue(explicitObservation);
    const execute = vi.fn();

    const observation = await recoverKnowledgeBaseNotice(
      {
        ...input,
        notice: {
          code: "UPSTREAM_CREDENTIAL_UNAVAILABLE",
          recoveryAction: "reconcile",
        },
      },
      { reconcile, execute },
    );

    expect(reconcile).toHaveBeenCalledOnce();
    expect(execute).not.toHaveBeenCalled();
    expect(knowledgeBaseReconcileResultRequiresConfirmation(observation)).toBe(
      true,
    );
    expect(knowledgeBaseNoticeRetryLabel(observation.notice!)).toBe(
      "确认后继续本轮",
    );
  });

  it("reports a stopped reconcile result without treating it as unrestored", async () => {
    const stoppedObservation = {
      notice: {
        code: "FRONTMIND_KB_STOPPED",
        recoveryAction: "stopped",
        recoveryToken: "b".repeat(64),
        canRegenerate: false,
      },
      interaction: { progress: null },
    } as any;
    const reconcile = vi.fn().mockResolvedValue(stoppedObservation);
    const execute = vi.fn();

    const observation = await recoverKnowledgeBaseNotice(
      {
        ...input,
        notice: {
          code: "UPSTREAM_CREDENTIAL_UNAVAILABLE",
          recoveryAction: "reconcile",
        },
      },
      { reconcile, execute },
    );

    expect(reconcile).toHaveBeenCalledOnce();
    expect(execute).not.toHaveBeenCalled();
    expect(knowledgeBaseReconcileResultRequiresConfirmation(observation)).toBe(
      false,
    );
    expect(knowledgeBaseReconcileResultIsStopped(observation)).toBe(true);
  });

  it("recognizes a reconcile result that advanced the authoritative coordinate", () => {
    expect(
      knowledgeBaseReconcileResultChangedCoordinate(
        { generation: 2, stateEpoch: 39 },
        { generation: 2, stateEpoch: 38 },
      ),
    ).toBe(true);
    expect(
      knowledgeBaseReconcileResultChangedCoordinate(
        { generation: 3, stateEpoch: 1 },
        { generation: 2, stateEpoch: 38 },
      ),
    ).toBe(true);
    expect(
      knowledgeBaseReconcileResultChangedCoordinate(
        { generation: 2, stateEpoch: 38 },
        { generation: 2, stateEpoch: 38 },
      ),
    ).toBe(false);
  });

  it.each([
    ["retry_request", "确认后继续本轮"],
    ["start_new_generation", "创建新任务继续"],
  ] as const)(
    "routes %s only through the token-bound execute endpoint",
    async (recoveryAction, label) => {
      const observation = { interaction: { progress: null } } as any;
      const reconcile = vi.fn();
      const retry = vi.fn();
      const execute = vi.fn().mockResolvedValue(observation);
      const notice = {
        code: "FRONTMIND_KB_RETRY_AVAILABLE",
        recoveryAction,
        recoveryToken: "a".repeat(64),
        canRegenerate: false,
      };

      await expect(
        recoverKnowledgeBaseNotice(
          { ...input, notice },
          { reconcile, retry, execute },
        ),
      ).resolves.toBe(observation);
      expect(execute).toHaveBeenCalledWith({
        conversationId: "knowledge-conversation",
        recoveryToken: "a".repeat(64),
        clientRequestId: "retry-request",
      });
      expect(reconcile).not.toHaveBeenCalled();
      expect(retry).not.toHaveBeenCalled();
      expect(knowledgeBaseNoticeRecoveryMode(notice)).toBe("explicit_recovery");
      expect(knowledgeBaseNoticeRetryLabel(notice)).toBe(label);
    },
  );

  it("does not expose an executable action without a valid token", () => {
    expect(
      knowledgeBaseNoticeRecoveryMode({
        code: "FRONTMIND_KB_RETRY_AVAILABLE",
        recoveryAction: "retry_request",
        recoveryToken: "invalid",
      }),
    ).toBe("none");
    expect(
      knowledgeBaseNoticeRecoveryMode({
        code: "FRONTMIND_KB_STOPPED",
        recoveryAction: "stopped",
        recoveryToken: "a".repeat(64),
      }),
    ).toBe("none");
  });

  it("routes a rejected materialized result to the reset approval UI", () => {
    const notice = {
      code: "FRONTMIND_KB_RESET_REQUIRED",
      recoveryAction: "approve_reset" as const,
      canRegenerate: false,
    };
    const requested = vi.fn();
    window.addEventListener("frontmind:request-knowledge-reset", requested, {
      once: true,
    });

    expect(knowledgeBaseNoticeRecoveryMode(notice)).toBe("reset");
    expect(knowledgeBaseNoticeRetryLabel(notice)).toBe("申请重置知识库");
    expect(knowledgeBaseNoticeHasRecoveryAction(notice)).toBe(true);
    requestKnowledgeBaseReset();
    expect(requested).toHaveBeenCalledOnce();
  });

  it("reuses one client request id for double-click and response-loss replay", () => {
    const createClientRequestId = vi
      .fn()
      .mockReturnValueOnce("request-one")
      .mockReturnValueOnce("request-two");
    const first = knowledgeBaseExplicitRecoveryRequest(
      null,
      "a".repeat(64),
      createClientRequestId,
    );
    const replay = knowledgeBaseExplicitRecoveryRequest(
      first,
      "a".repeat(64),
      createClientRequestId,
    );
    const changed = knowledgeBaseExplicitRecoveryRequest(
      replay,
      "b".repeat(64),
      createClientRequestId,
    );

    expect(replay).toBe(first);
    expect(replay.clientRequestId).toBe("request-one");
    expect(changed.clientRequestId).toBe("request-two");
    expect(createClientRequestId).toHaveBeenCalledTimes(2);
  });

  it("creates a new task only from the authoritative regeneration contract", async () => {
    const observation = { interaction: { progress: null } } as any;
    const reconcile = vi.fn();
    const retry = vi.fn().mockResolvedValue(observation);

    await expect(
      recoverKnowledgeBaseNotice(
        {
          ...input,
          expectedLeafId: "1.4",
          notice: {
            code: "PROGRESS_PROTOCOL_INVALID",
            recoveryAction: "regenerate_turn",
            canRegenerate: true,
          },
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
      knowledgeBaseNoticeRetryLabel({
        code: "PROGRESS_PROTOCOL_INVALID",
        recoveryAction: "regenerate_turn",
        canRegenerate: true,
      }),
    ).toBe("重新生成本轮（将创建一次新的 API 任务）");
  });

  it("continues the same bound task after a credential update", async () => {
    const observation = {
      accepted: true,
      resumed: true,
      interaction: { progress: null },
    } as any;
    const reconcile = vi.fn().mockResolvedValue(observation);
    const retry = vi.fn();
    const notice = {
      code: "UPSTREAM_CREDENTIAL_REJECTED",
      recoveryAction: "update_credential" as const,
      canRegenerate: false,
    };

    await expect(
      recoverKnowledgeBaseNotice({ ...input, notice }, { reconcile, retry }),
    ).resolves.toBe(observation);
    expect(reconcile).toHaveBeenCalledWith({
      conversationId: "knowledge-conversation",
    });
    expect(retry).not.toHaveBeenCalled();
    expect(knowledgeBaseNoticeRetryLabel(notice)).toBe("更新凭证后继续本轮");
    expect(knowledgeBaseSameTurnRecoveryAccepted(observation)).toBe(true);
    expect(
      knowledgeBasePackageRebindResolved({
        ...observation,
        package: null,
        notice,
      }),
    ).toBe(false);
  });

  it("continues a pre-create quota failure without exposing regeneration", async () => {
    const observation = { interaction: { progress: null } } as any;
    const reconcile = vi.fn().mockResolvedValue(observation);
    const retry = vi.fn();
    const notice = {
      code: "UPSTREAM_CREATE_HTTP_402",
      recoveryAction: "top_up" as const,
      canRegenerate: false,
    };

    await expect(
      recoverKnowledgeBaseNotice({ ...input, notice }, { reconcile, retry }),
    ).resolves.toBe(observation);
    expect(reconcile).toHaveBeenCalledOnce();
    expect(retry).not.toHaveBeenCalled();
    expect(knowledgeBaseNoticeRetryLabel(notice)).toBe("补充额度后继续本轮");
  });

  it("does not report a same-turn recovery as accepted without the resume receipt", () => {
    expect(
      knowledgeBaseSameTurnRecoveryAccepted({
        accepted: true,
        resumed: false,
        interaction: { progress: null },
      } as any),
    ).toBe(false);
  });

  it("routes only a pre-create attachment failure to the replacement entrance", () => {
    const notice = {
      code: "KNOWLEDGE_BASE_USER_ATTACHMENT_INVALID",
      recoveryAction: "fix_attachments" as const,
      canRegenerate: false,
    };
    expect(knowledgeBaseNoticeRequiresAttachmentRepair(notice)).toBe(true);
    expect(
      knowledgeBaseNoticeRecoveryMode({ code: "HTTP_413", ...notice }),
    ).toBe("none");
    expect(
      knowledgeBaseNoticeRetryLabel({ code: "HTTP_413", ...notice }),
    ).not.toContain("重新生成");
    expect(
      knowledgeBaseNoticeRequiresAttachmentRepair({
        code: "UPSTREAM_CREATE_HTTP_413",
        recoveryAction: "fix_attachments",
      }),
    ).toBe(false);
  });

  it("routes missing Logo provenance to the dedicated upload repair instead of retry", () => {
    expect(
      knowledgeBaseNoticeRequiresLogoProvenanceRepair({
        code: "KNOWLEDGE_BASE_LOGO_PROVENANCE_REQUIRED",
      }),
    ).toBe(true);
    expect(
      knowledgeBaseNoticeRecoveryMode({
        code: "KNOWLEDGE_BASE_LOGO_PROVENANCE_REQUIRED",
      }),
    ).toBe("logo_repair");
    expect(
      knowledgeBaseNoticeRetryLabel({
        code: "KNOWLEDGE_BASE_LOGO_PROVENANCE_REQUIRED",
      }),
    ).toBe("重新上传 Logo 原图");
    expect(
      knowledgeBaseNoticeRequiresLogoProvenanceRepair({
        code: "FINAL_PACKAGE_INVALID",
      }),
    ).toBe(false);
  });

  it("never sends Logo provenance recovery through the ordinary retry endpoint", async () => {
    const reconcile = vi.fn();
    const retry = vi.fn();

    await expect(
      recoverKnowledgeBaseNotice(
        {
          ...input,
          notice: { code: "KNOWLEDGE_BASE_LOGO_PROVENANCE_REQUIRED" },
        },
        { reconcile, retry },
      ),
    ).rejects.toThrow("专用入口");

    expect(reconcile).not.toHaveBeenCalled();
    expect(retry).not.toHaveBeenCalled();
  });
});
