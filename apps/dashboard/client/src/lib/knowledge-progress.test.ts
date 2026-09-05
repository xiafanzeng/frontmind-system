import { afterEach, describe, expect, it, vi } from "vitest";
import { DELIVERY_PROJECT_ASSIGNMENT_STORAGE_KEY } from "./delivery-project";

import {
  executeKnowledgeBaseRecovery,
  isKnowledgeBaseProgressCoordinateOlder,
  knowledgeBaseObservationFromPayload,
  readKnowledgeBaseProgressEventDetail,
  reconcileKnowledgeBaseObservation,
  replaceKnowledgeBaseTurnAttachments,
  repairKnowledgeBaseLogoProvenance,
} from "./knowledge-progress";

afterEach(() => {
  vi.unstubAllGlobals();
  sessionStorage.clear();
});

describe("reconcileKnowledgeBaseObservation", () => {
  it("preserves the accepted same-turn resume receipt from the reconcile envelope", async () => {
    const observation = {
      stateEpoch: 4,
      generation: 2,
      authoritativeTaskId: null,
      activeTurn: { id: "turn-1", status: "running" },
      interaction: {
        progress: null,
        interactionState: "processing",
        canReply: false,
        canPublish: false,
      },
      approvedPresentation: null,
      package: null,
      notice: null,
      conversationVersion: 4,
    };
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValue(
          new Response(
            JSON.stringify({ observation, accepted: true, resumed: true }),
            { status: 202, headers: { "Content-Type": "application/json" } },
          ),
        ),
    );

    await expect(
      reconcileKnowledgeBaseObservation({ conversationId: "conversation-1" }),
    ).resolves.toMatchObject({ accepted: true, resumed: true });
  });

  it("orders progress coordinates by generation and then state epoch", () => {
    expect(
      isKnowledgeBaseProgressCoordinateOlder(
        { generation: 2, stateEpoch: 99 },
        { generation: 3, stateEpoch: 1 },
      ),
    ).toBe(true);
    expect(
      isKnowledgeBaseProgressCoordinateOlder(
        { generation: 3, stateEpoch: 8 },
        { generation: 3, stateEpoch: 9 },
      ),
    ).toBe(true);
    expect(
      isKnowledgeBaseProgressCoordinateOlder(
        { generation: 4, stateEpoch: 0 },
        { generation: 3, stateEpoch: 99 },
      ),
    ).toBe(false);
  });

  it("keeps generation coordinates on current progress events and accepts legacy projections", () => {
    const progress = { build: { id: "build-1" } } as any;
    expect(
      readKnowledgeBaseProgressEventDetail({
        progress,
        generation: 3,
        stateEpoch: 9,
      }),
    ).toEqual({ progress, generation: 3, stateEpoch: 9 });
    expect(readKnowledgeBaseProgressEventDetail(progress)).toEqual({
      progress,
      generation: -1,
      stateEpoch: -1,
    });
  });

  it("preserves an explicit unbound authority instead of adopting a placeholder task id", () => {
    const observation = knowledgeBaseObservationFromPayload({
      task: { id: "turn-placeholder", status: "running" },
      observation: {
        stateEpoch: 4,
        generation: 2,
        authoritativeTaskId: null,
        activeTurn: { id: "turn-placeholder", status: "queued" },
        interaction: {
          progress: null,
          interactionState: "queued",
          canReply: false,
          canPublish: false,
          lockReason: null,
        },
        approvedPresentation: null,
        package: null,
        notice: null,
        conversationVersion: 4,
      },
    });

    expect(observation.authoritativeTaskId).toBeNull();
  });

  it("preserves a valid display receipt sequence and rejects malformed values", () => {
    const payload = {
      observation: {
        stateEpoch: 4,
        generation: 2,
        displaySequence: 17,
        authoritativeTaskId: null,
        activeTurn: null,
        interaction: {
          progress: null,
          interactionState: "ready_to_publish",
          canReply: false,
          canPublish: true,
          lockReason: null,
        },
        approvedPresentation: null,
        package: null,
        notice: null,
        conversationVersion: 4,
      },
    };

    expect(knowledgeBaseObservationFromPayload(payload).displaySequence).toBe(
      17,
    );
    expect(() =>
      knowledgeBaseObservationFromPayload({
        observation: { ...payload.observation, displaySequence: "17" },
      }),
    ).toThrow("无效的 displaySequence");
    expect(() =>
      knowledgeBaseObservationFromPayload({
        observation: { ...payload.observation, displaySequence: -1 },
      }),
    ).toThrow("无效的 displaySequence");
  });

  it("preserves validated repair status without trusting arbitrary server strings", () => {
    const base = {
      stateEpoch: 4,
      generation: 2,
      authoritativeTaskId: "canonical-task",
      activeTurn: null,
      interaction: {
        progress: null,
        interactionState: "running",
        canReply: false,
        canPublish: false,
        lockReason: null,
      },
      approvedPresentation: null,
      package: null,
      notice: null,
      conversationVersion: 4,
    };
    expect(
      knowledgeBaseObservationFromPayload({
        observation: {
          ...base,
          syncState: "attention_required",
          processingPhase: "waiting_provider",
          contentState: "completed",
          packageState: "preparing",
          publicationState: "draft",
          contentCompletedAt: 17,
        },
      }),
    ).toMatchObject({
      syncState: "attention_required",
      processingPhase: "waiting_provider",
      contentState: "completed",
      packageState: "preparing",
      publicationState: "draft",
      contentCompletedAt: 17,
    });
    expect(
      knowledgeBaseObservationFromPayload({
        observation: {
          ...base,
          syncState: "provider-secret-state",
          processingPhase: "unsafe-side-effect",
          contentState: "secret-content",
          packageState: "secret-package",
          publicationState: "secret-publication",
          contentCompletedAt: "17",
        },
      }),
    ).not.toMatchObject({
      syncState: expect.anything(),
      processingPhase: expect.anything(),
      contentState: expect.anything(),
      packageState: expect.anything(),
      publicationState: expect.anything(),
      contentCompletedAt: expect.anything(),
    });
  });

  it("accepts additive business state from either the observation or nested progress", () => {
    const base = {
      stateEpoch: 4,
      generation: 2,
      authoritativeTaskId: "canonical-task",
      activeTurn: null,
      interaction: {
        progress: null,
        interactionState: "running",
        canReply: false,
        canPublish: false,
        lockReason: null,
      },
      approvedPresentation: null,
      package: null,
      notice: null,
      conversationVersion: 4,
    };
    const nestedProgress = {
      build: { id: "build-v5" },
      contentAvailability: "partial",
      operationState: "normalizing",
      resetAllowed: false,
      warningCodes: [
        "OPTIONAL_BINARY_EVIDENCE_SKIPPED",
        "OPTIONAL_BINARY_EVIDENCE_SKIPPED",
      ],
      taskCreationState: "not_attempted",
      failureStage: "provider_file_registration",
      retainedCustomerAttachmentCount: 9,
      generatedSystemAttachmentCount: 2,
      settledAt: 1_787_000_000_000,
    } as any;

    expect(
      knowledgeBaseObservationFromPayload({
        observation: { ...base, progress: nestedProgress },
      }),
    ).toMatchObject({
      contentAvailability: "partial",
      operationState: "normalizing",
      resetAllowed: false,
      warningCodes: ["OPTIONAL_BINARY_EVIDENCE_SKIPPED"],
      taskCreationState: "not_attempted",
      failureStage: "provider_file_registration",
      retainedCustomerAttachmentCount: 9,
      generatedSystemAttachmentCount: 2,
      settledAt: 1_787_000_000_000,
    });
    expect(
      knowledgeBaseObservationFromPayload({
        observation: {
          ...base,
          progress: nestedProgress,
          operationState: "reset_required",
          resetAllowed: true,
          taskCreationState: "acknowledged",
          failureStage: "result_processing",
          retainedCustomerAttachmentCount: 7,
        },
      }),
    ).toMatchObject({
      operationState: "reset_required",
      resetAllowed: true,
      taskCreationState: "acknowledged",
      failureStage: "result_processing",
      retainedCustomerAttachmentCount: 7,
    });
  });

  it("recovers a durable failed projection after reconcile returns 422", async () => {
    const failedObservation = {
      stateEpoch: 3,
      generation: 1,
      authoritativeTaskId: "task-1",
      activeTurn: null,
      interaction: {
        progress: null,
        interactionState: "failed",
        canReply: false,
        canPublish: false,
        lockReason: "PROGRESS_PROTOCOL_INVALID",
      },
      approvedPresentation: null,
      package: null,
      notice: {
        key: "kb:task-1:protocol-error",
        code: "PROGRESS_PROTOCOL_INVALID",
        severity: "error",
        message: "知识库资源校验未通过，本轮内容尚未更新",
        retryable: true,
        turnId: "turn-1",
        createdAt: 3,
      },
      conversationVersion: 3,
    };
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            error: {
              code: "PROGRESS_PROTOCOL_INVALID",
              message: "知识库资源校验未通过，本轮内容尚未更新",
            },
          }),
          { status: 422, headers: { "Content-Type": "application/json" } },
        ),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ observation: failedObservation }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      );
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      reconcileKnowledgeBaseObservation({ conversationId: "conversation-1" }),
    ).resolves.toMatchObject({
      stateEpoch: 3,
      interaction: { interactionState: "failed" },
      notice: { code: "PROGRESS_PROTOCOL_INVALID", retryable: true },
    });
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      "/api/knowledge-base/progress/conversation-1",
      { credentials: "include", headers: {}, signal: undefined },
    );
  });

  it("carries the selected delivery project through reconcile and projection recovery", async () => {
    sessionStorage.setItem(
      DELIVERY_PROJECT_ASSIGNMENT_STORAGE_KEY,
      "delivery-project-7",
    );
    const failedObservation = {
      stateEpoch: 3,
      generation: 1,
      authoritativeTaskId: null,
      activeTurn: null,
      interaction: {
        progress: null,
        interactionState: "failed",
        canReply: false,
        canPublish: false,
        lockReason: "PROGRESS_PROTOCOL_INVALID",
      },
      approvedPresentation: null,
      package: null,
      notice: null,
      conversationVersion: 3,
    };
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response("{}", { status: 422 }))
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ observation: failedObservation }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      );
    vi.stubGlobal("fetch", fetchMock);

    await reconcileKnowledgeBaseObservation({
      conversationId: "conversation-project",
    });

    const projectHeaders = {
      "x-delivery-project-assignment-id": "delivery-project-7",
    };
    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      "/api/knowledge-base/progress/reconcile",
      expect.objectContaining({
        headers: {
          ...projectHeaders,
          "Content-Type": "application/json",
        },
      }),
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      "/api/knowledge-base/progress/conversation-project",
      {
        credentials: "include",
        headers: projectHeaders,
        signal: undefined,
      },
    );
  });
});

describe("executeKnowledgeBaseRecovery", () => {
  it("posts the opaque token and stable client request id", async () => {
    const observation = {
      stateEpoch: 10,
      generation: 4,
      authoritativeTaskId: null,
      activeTurn: null,
      interaction: {
        progress: null,
        interactionState: "executing",
        canReply: false,
        canPublish: false,
        lockReason: "FrontMind 正在完成当前操作",
      },
      approvedPresentation: null,
      package: null,
      notice: null,
      conversationVersion: 5,
    };
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          disposition: "accepted",
          accepted: true,
          resumed: true,
          observation,
        }),
        { status: 202, headers: { "Content-Type": "application/json" } },
      ),
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      executeKnowledgeBaseRecovery({
        conversationId: "conversation-1",
        recoveryToken: "a".repeat(64),
        clientRequestId: "stable-request-1",
      }),
    ).resolves.toMatchObject({ accepted: true, resumed: true });
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/knowledge-base/recovery/execute",
      expect.objectContaining({
        method: "POST",
        credentials: "include",
        body: JSON.stringify({
          conversationId: "conversation-1",
          recoveryToken: "a".repeat(64),
          clientRequestId: "stable-request-1",
        }),
      }),
    );
  });
});

describe("repairKnowledgeBaseLogoProvenance", () => {
  const observation = {
    stateEpoch: 8,
    generation: 1,
    authoritativeTaskId: "task-1",
    activeTurn: null,
    interaction: {
      progress: null,
      interactionState: "failed",
      canReply: false,
      canPublish: false,
      lockReason: "FINAL_PACKAGE_INVALID",
    },
    approvedPresentation: null,
    package: null,
    notice: {
      key: "kb:final-retry",
      code: "FINAL_PACKAGE_INVALID",
      severity: "error",
      message: "请重试本轮",
      retryable: true,
      turnId: "turn-50",
      createdAt: 8,
    },
    conversationVersion: 8,
  };
  const input = {
    conversationId: "conversation-1",
    clientRequestId: "logo-repair-1",
    expectedGeneration: 1,
    expectedRevision: 50,
    expectedLeafId: "7.5",
    attachmentManifest: [
      {
        filename: "official-logo.png",
        sizeBytes: 9556,
        mimeType: "image/png",
        lastModified: 123,
        sha256: "a".repeat(64),
      },
    ] as [
      {
        filename: string;
        sizeBytes: number;
        mimeType: string;
        lastModified: number;
        sha256: string;
      },
    ],
    attachment: {
      file_id: "file-logo-1",
      filename: "official-logo.png",
    },
  };

  it("posts the exact captured file and one-item browser manifest", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ repaired: true, observation }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      repairKnowledgeBaseLogoProvenance(input),
    ).resolves.toMatchObject({
      stateEpoch: 8,
      notice: { code: "FINAL_PACKAGE_INVALID", retryable: true },
    });
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/knowledge-base/logo-provenance/repair",
      {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(input),
      },
    );
  });

  it("preserves the byte-mismatch error code for explicit UI guidance", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            error: {
              code: "KNOWLEDGE_BASE_LOGO_REPAIR_UPLOAD_INVALID",
              message: "Logo bytes do not match",
            },
          }),
          { status: 422, headers: { "Content-Type": "application/json" } },
        ),
      ),
    );

    await expect(
      repairKnowledgeBaseLogoProvenance(input),
    ).rejects.toMatchObject({
      message: "Logo bytes do not match",
      status: 422,
      code: "KNOWLEDGE_BASE_LOGO_REPAIR_UPLOAD_INVALID",
    });
  });
});

describe("replaceKnowledgeBaseTurnAttachments", () => {
  it("sends the replacement manifest to the dedicated same-turn continuation endpoint", async () => {
    const observation = {
      stateEpoch: 9,
      generation: 2,
      authoritativeTaskId: null,
      activeTurn: { id: "turn-413", status: "running" },
      interaction: {
        progress: null,
        interactionState: "executing",
        canReply: false,
        canPublish: false,
        lockReason: null,
      },
      approvedPresentation: null,
      package: null,
      notice: null,
      conversationVersion: 5,
    };
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ observation }), {
        status: 202,
        headers: { "Content-Type": "application/json" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const input = {
      conversationId: "conversation-1",
      clientRequestId: "attachment-repair-1",
      expectedGeneration: 2,
      expectedRevision: 4,
      expectedLeafId: "1.4",
      attachmentManifest: [
        {
          filename: "smaller.pdf",
          sizeBytes: 100,
          mimeType: "application/pdf",
          lastModified: 1,
          sha256: "a".repeat(64),
        },
      ],
      attachments: [{ file_id: "file-smaller", filename: "smaller.pdf" }],
    };

    await expect(
      replaceKnowledgeBaseTurnAttachments(input),
    ).resolves.toMatchObject({ activeTurn: { id: "turn-413" } });
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/knowledge-base/turn/replace-attachments",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify(input),
      }),
    );
  });
});
