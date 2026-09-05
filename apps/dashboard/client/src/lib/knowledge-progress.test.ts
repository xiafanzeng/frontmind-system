import { afterEach, describe, expect, it, vi } from "vitest";

import {
  knowledgeBaseObservationFromPayload,
  reconcileKnowledgeBaseObservation,
} from "./knowledge-progress";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("reconcileKnowledgeBaseObservation", () => {
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
      { credentials: "include", signal: undefined },
    );
  });
});
