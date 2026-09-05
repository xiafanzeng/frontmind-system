import { describe, expect, it, vi } from "vitest";
import type { KnowledgeBaseObservationDto } from "@/lib/knowledge-progress";
import {
  knowledgeBasePresentationMessagePublicId,
  knowledgeBaseUserMessagePublicId,
} from "@shared/knowledge-base-message";
import {
  applyKnowledgeBaseObservation,
  currentKnowledgeBasePresentationReady,
  mergeKnowledgeBaseHydration,
  mergeServerOwnedKnowledgeBaseMessages,
  type Conversation,
} from "./ConversationContext";

function presentationKey(revision: number) {
  return revision.toString(16).padStart(64, "0");
}

function presentationMessageId(revision: number) {
  return knowledgeBasePresentationMessagePublicId(presentationKey(revision));
}

function progress(revision: number, leafId: string) {
  return {
    build: {
      id: "build",
      conversationId: "conversation",
      companyName: "FrontMind",
      status: "confirming" as const,
      revision,
      currentLeafId: leafId,
      protocolError: null,
      updatedAt: revision,
    },
    summary: {
      total: 3,
      handled: revision,
      confirmed: revision,
      directPrefilled: 0,
      pending: 1,
      current: 1,
      needsVerification: 0,
      overallPercent: revision * 10,
    },
    branches: [],
    packageAllowed: false,
  };
}

function observation(
  epoch: number,
  turnId: string,
  revision: number,
  leafId: string,
  body: string | null,
): KnowledgeBaseObservationDto {
  const currentProgress = progress(revision, leafId);
  return {
    stateEpoch: epoch,
    generation: 1,
    authoritativeTaskId: `task-${turnId}`,
    activeTurn: {
      id: turnId,
      clientRequestId: `request-${turnId}`,
      operationKey: `operation-${turnId}`,
      operationType: "confirm",
      status: "completed",
      buildGeneration: 1,
      expectedRevision: revision,
      expectedLeafId: leafId,
      startedAt: 1,
      completedAt: 2,
      updatedAt: 2,
    },
    interaction: {
      progress: currentProgress,
      interactionState: "awaiting_input",
      canReply: true,
      canPublish: false,
      lockReason: null,
    },
    approvedPresentation: body
      ? {
          turnId,
          clientRequestId: `request-${turnId}`,
          presentationKey: presentationKey(revision),
          revision,
          leafId,
          visibleMarkdown: body,
          contentSha256: `sha-${turnId}`,
          imageState: "no_eligible_asset",
          resources: [],
        }
      : null,
    package: null,
    notice: null,
    conversationVersion: epoch,
  };
}

function conversation(): Conversation {
  return {
    id: "conversation",
    title: "企业知识库构建",
    status: "running",
    taskId: "task-old",
    createdAt: 1,
    updatedAt: 1,
    messages: [
      {
        id: "user-turn-1",
        role: "user",
        content: "确认",
        timestamp: 1,
        knowledgeBase: {
          kind: "pending_user",
          clientRequestId: "request-turn-1",
        },
      },
    ],
  };
}

describe("authoritative KB observation reducer", () => {
  it("keeps awaiting_input locked when the server has not approved a body", () => {
    const next = applyKnowledgeBaseObservation(
      conversation(),
      observation(1, "turn-1", 1, "1.2", null),
    );

    expect(next.status).toBe("running");
    expect(next.knowledgeBase?.canReply).toBe(false);
    expect(currentKnowledgeBasePresentationReady(next, 1, "1.2")).toBe(false);
    expect(next.messages).toHaveLength(1);
    expect(next.messages[0]).toMatchObject({
      id: knowledgeBaseUserMessagePublicId("turn-1"),
      knowledgeBase: {
        turnId: "turn-1",
        serverOwned: true,
      },
    });
  });

  it("renders and unlocks an approved body after the successful reservation is released", () => {
    const released = {
      ...observation(2, "turn-1", 1, "1.2", "## 1.2\n已批准正文"),
      activeTurn: null,
      approvedPresentation: {
        ...observation(2, "turn-1", 1, "1.2", "## 1.2\n已批准正文")
          .approvedPresentation!,
        requestMessageSequence: 12,
        messageSequence: 13,
      },
    };
    const next = applyKnowledgeBaseObservation(conversation(), released);

    expect(next.status).toBe("awaiting_input");
    expect(next.knowledgeBase?.activeTurnId).toBeNull();
    expect(next.knowledgeBase?.presentationTurnId).toBe("turn-1");
    expect(next.knowledgeBase?.canReply).toBe(true);
    expect(currentKnowledgeBasePresentationReady(next, 1, "1.2")).toBe(true);
    expect(next.messages.at(-1)?.content).toContain("已批准正文");
    expect(next.messages.map((message) => message.id)).toEqual([
      knowledgeBaseUserMessagePublicId("turn-1"),
      presentationMessageId(1),
    ]);
    expect(next.messages.map((message) => message.serverSequence)).toEqual([
      12, 13,
    ]);
    expect(
      next.messages.every((message) => message.knowledgeBase?.serverOwned),
    ).toBe(true);
  });

  it("keeps a network-unknown pending request unbound when only the old presentation is observed", () => {
    const releasedOld = {
      ...observation(2, "turn-1", 1, "1.2", "## 1.2\n旧的已批准正文"),
      activeTurn: null,
    };
    const current = applyKnowledgeBaseObservation(conversation(), releasedOld);
    const withUnknownRequest: Conversation = {
      ...current,
      messages: [
        ...current.messages,
        {
          id: "optimistic-request-2",
          role: "user",
          content: "确认",
          timestamp: 3,
          knowledgeBase: {
            kind: "pending_user",
            clientRequestId: "request-turn-2",
            serverOwned: false,
          },
        },
      ],
    };

    const next = applyKnowledgeBaseObservation(withUnknownRequest, releasedOld);
    const pending = next.messages.find(
      (message) => message.knowledgeBase?.clientRequestId === "request-turn-2",
    );

    expect(pending).toMatchObject({
      id: "optimistic-request-2",
      knowledgeBase: {
        clientRequestId: "request-turn-2",
        serverOwned: false,
      },
    });
    expect(pending?.knowledgeBase?.turnId).toBeUndefined();
    expect(
      next.messages.findIndex(
        (message) =>
          message.knowledgeBase?.presentationKey === presentationKey(1),
      ),
    ).toBeLessThan(
      next.messages.findIndex(
        (message) =>
          message.knowledgeBase?.clientRequestId === "request-turn-2",
      ),
    );
    expect(next.messages.at(-1)?.id).toBe("optimistic-request-2");
  });

  it("places a newly observed durable presentation before a newer optimistic request in the first render", () => {
    const dateNow = vi.spyOn(Date, "now").mockReturnValue(100);
    try {
      const withOnlyNewerOptimisticRequest: Conversation = {
        ...conversation(),
        messages: [
          {
            // This ID sorts before the canonical presentation ID on purpose.
            // Neither lexical order nor an equal browser timestamp may defeat
            // the durable database sequence.
            id: "a-newer-optimistic-request",
            role: "user",
            content: "确认",
            timestamp: 100,
            knowledgeBase: {
              kind: "pending_user",
              clientRequestId: "request-newer",
              serverOwned: false,
            },
          },
        ],
      };
      const releasedOlderPresentation = {
        ...observation(2, "turn-older", 1, "1.2", "## 1.2\n已批准正文"),
        activeTurn: null,
        approvedPresentation: {
          ...observation(2, "turn-older", 1, "1.2", "## 1.2\n已批准正文")
            .approvedPresentation!,
          requestMessageSequence: 2,
          messageSequence: 3,
        },
      };

      const next = applyKnowledgeBaseObservation(
        withOnlyNewerOptimisticRequest,
        releasedOlderPresentation,
      );

      expect(next.messages.map((message) => message.id)).toEqual([
        presentationMessageId(1),
        "a-newer-optimistic-request",
      ]);
      expect(next.messages[0]).toMatchObject({
        serverSequence: 3,
        knowledgeBase: { kind: "presentation", serverOwned: true },
      });
      expect(next.messages[1]).toMatchObject({
        timestamp: 100,
        knowledgeBase: {
          clientRequestId: "request-newer",
          serverOwned: false,
        },
      });
    } finally {
      dateNow.mockRestore();
    }
  });

  it("does not bind a newer pending request when an older active turn arrives late", () => {
    const withNewPending = conversation();
    withNewPending.messages.push({
      id: "optimistic-request-2",
      role: "user",
      content: "确认",
      timestamp: 2,
      knowledgeBase: {
        kind: "pending_user",
        clientRequestId: "request-turn-2",
        serverOwned: false,
      },
    });

    const next = applyKnowledgeBaseObservation(
      withNewPending,
      observation(2, "turn-1", 1, "1.2", "## 1.2\n旧轮正文"),
    );
    const newerPending = next.messages.find(
      (message) => message.knowledgeBase?.clientRequestId === "request-turn-2",
    );

    expect(newerPending?.knowledgeBase?.serverOwned).not.toBe(true);
    expect(newerPending?.knowledgeBase?.turnId).toBeUndefined();
    expect(
      next.messages.find(
        (message) =>
          message.knowledgeBase?.clientRequestId === "request-turn-1",
      )?.knowledgeBase?.turnId,
    ).toBe("turn-1");
  });

  it("binds an accepted new turn without moving the previous approved presentation onto it", () => {
    const releasedOld = {
      ...observation(2, "turn-1", 1, "1.2", "## 1.2\n旧的已批准正文"),
      activeTurn: null,
    };
    const current = applyKnowledgeBaseObservation(conversation(), releasedOld);
    const withNewPending: Conversation = {
      ...current,
      messages: [
        ...current.messages,
        {
          id: "optimistic-request-2",
          role: "user",
          content: "确认",
          timestamp: 3,
          knowledgeBase: {
            kind: "pending_user",
            clientRequestId: "request-turn-2",
            serverOwned: false,
          },
        },
      ],
    };
    const acceptedTurn = observation(3, "turn-2", 1, "1.2", null);
    const executing = {
      ...releasedOld,
      stateEpoch: 3,
      activeTurn: acceptedTurn.activeTurn,
      interaction: {
        ...releasedOld.interaction,
        interactionState: "executing" as const,
        canReply: false,
      },
    };

    const next = applyKnowledgeBaseObservation(withNewPending, executing);
    const newUserIndex = next.messages.findIndex(
      (message) => message.knowledgeBase?.clientRequestId === "request-turn-2",
    );
    const oldPresentationIndex = next.messages.findIndex(
      (message) =>
        message.knowledgeBase?.presentationKey === presentationKey(1),
    );

    expect(next.messages[newUserIndex]?.knowledgeBase).toMatchObject({
      turnId: "turn-2",
      serverOwned: true,
    });
    expect(oldPresentationIndex).toBeLessThan(newUserIndex);
    expect(next.messages[oldPresentationIndex]?.knowledgeBase?.turnId).toBe(
      "turn-1",
    );
  });

  it("rejects an old turn arriving after a newer approved presentation", () => {
    const firstUser = conversation();
    firstUser.messages.push({
      id: "user-turn-2",
      role: "user",
      content: "确认",
      timestamp: 2,
      knowledgeBase: {
        kind: "pending_user",
        clientRequestId: "request-turn-2",
      },
    });
    const current = applyKnowledgeBaseObservation(
      firstUser,
      observation(2, "turn-2", 2, "1.3", "## 1.3\n新正文"),
    );
    const stale = applyKnowledgeBaseObservation(
      current,
      observation(1, "turn-1", 1, "1.2", "## 1.2\n旧正文"),
    );

    expect(stale).toBe(current);
    expect(stale.messages.at(-1)?.content).toContain("新正文");
    expect(stale.messages.at(-1)?.content).not.toContain("旧正文");
  });

  it("deduplicates a repeated notice without creating assistant error bubbles", () => {
    const failed = {
      ...observation(3, "turn-1", 1, "1.2", null),
      interaction: {
        ...observation(3, "turn-1", 1, "1.2", null).interaction,
        interactionState: "failed" as const,
        canReply: false,
      },
      notice: {
        key: "kb:turn-1:invalid-protocol",
        code: "INVALID_PROTOCOL",
        severity: "error" as const,
        message: "本轮协议不完整，请重试。",
        retryable: true,
        turnId: "turn-1",
        createdAt: 3,
      },
    };
    const once = applyKnowledgeBaseObservation(conversation(), failed);
    const twice = applyKnowledgeBaseObservation(once, failed);

    expect(twice.knowledgeBase?.notice?.errorKey).toBe(
      "kb:turn-1:invalid-protocol",
    );
    expect(twice.knowledgeBase?.notice?.retryable).toBe(true);
    expect(twice.status).toBe("error");
    expect(twice.knowledgeBase?.interactionState).toBe("failed");
    expect(twice.knowledgeBase?.revision).toBe(1);
    expect(twice.knowledgeBase?.leafId).toBe("1.2");
    expect(
      twice.messages.filter((message) => message.role === "assistant"),
    ).toHaveLength(0);
  });

  it("does not let a stale hydration response erase an approved node", () => {
    const local = applyKnowledgeBaseObservation(
      conversation(),
      observation(2, "turn-1", 1, "1.2", "## 1.2\n已批准正文"),
    );
    const remote = {
      ...conversation(),
      status: "running" as const,
      messages: [conversation().messages[0]],
      updatedAt: local.updatedAt + 1,
    };

    const merged = mergeKnowledgeBaseHydration(local, remote);
    expect(merged.status).toBe("awaiting_input");
    expect(merged.messages.at(-1)?.content).toContain("已批准正文");
    expect(merged.knowledgeBase?.stateEpoch).toBe(2);
  });

  it("keeps prior immutable history when hydration carries a newer KB epoch", () => {
    const local = applyKnowledgeBaseObservation(
      conversation(),
      observation(2, "turn-1", 1, "1.2", "## 1.2\n第一节点"),
    );
    const remote = applyKnowledgeBaseObservation(
      {
        ...conversation(),
        messages: [],
      },
      observation(3, "turn-2", 2, "1.3", "## 1.3\n第二节点"),
    );

    const merged = mergeKnowledgeBaseHydration(local, remote);
    expect(merged.knowledgeBase?.stateEpoch).toBe(3);
    expect(merged.messages.map((message) => message.id)).toEqual([
      knowledgeBaseUserMessagePublicId("turn-1"),
      presentationMessageId(1),
      presentationMessageId(2),
    ]);
    expect(
      merged.messages.map((message) => message.content).join("\n"),
    ).toContain("第一节点");
    expect(
      merged.messages.map((message) => message.content).join("\n"),
    ).toContain("第二节点");
  });

  it("keeps each approved node before the later confirmation that advances it", () => {
    const history: Conversation["messages"] = [
      {
        id: knowledgeBaseUserMessagePublicId("turn-start"),
        role: "user",
        content: "开始构建",
        timestamp: 1,
        knowledgeBase: {
          kind: "pending_user",
          turnId: "turn-start",
          generation: 1,
          revision: 0,
          serverOwned: true,
        },
      },
      {
        id: presentationMessageId(0),
        role: "assistant",
        content: "## 1.1\n第一节点",
        timestamp: 2,
        knowledgeBase: {
          kind: "presentation",
          turnId: "turn-start",
          presentationKey: presentationKey(0),
          generation: 1,
          revision: 0,
          leafId: "1.1",
          serverOwned: true,
        },
      },
      {
        id: knowledgeBaseUserMessagePublicId("turn-confirm-1"),
        role: "user",
        content: "确认",
        timestamp: 3,
        knowledgeBase: {
          kind: "pending_user",
          turnId: "turn-confirm-1",
          generation: 1,
          revision: 0,
          leafId: "1.1",
          serverOwned: true,
        },
      },
      {
        id: presentationMessageId(1),
        role: "assistant",
        content: "## 1.2\n第二节点",
        timestamp: 4,
        knowledgeBase: {
          kind: "presentation",
          turnId: "turn-confirm-1",
          presentationKey: presentationKey(1),
          generation: 1,
          revision: 1,
          leafId: "1.2",
          serverOwned: true,
        },
      },
      {
        id: knowledgeBaseUserMessagePublicId("turn-confirm-2"),
        role: "user",
        content: "确认",
        timestamp: 5,
        knowledgeBase: {
          kind: "pending_user",
          turnId: "turn-confirm-2",
          generation: 1,
          revision: 1,
          leafId: "1.2",
          serverOwned: true,
        },
      },
      {
        id: presentationMessageId(2),
        role: "assistant",
        content: "## 1.3\n第三节点",
        timestamp: 6,
        knowledgeBase: {
          kind: "presentation",
          turnId: "turn-confirm-2",
          presentationKey: presentationKey(2),
          generation: 1,
          revision: 2,
          leafId: "1.3",
          serverOwned: true,
        },
      },
    ];

    const merged = mergeServerOwnedKnowledgeBaseMessages([], history);

    expect(merged.map((message) => message.content)).toEqual([
      "开始构建",
      "## 1.1\n第一节点",
      "确认",
      "## 1.2\n第二节点",
      "确认",
      "## 1.3\n第三节点",
    ]);
  });

  it("uses canonical server sequence even when cached timestamps disagree", () => {
    const remotePresentation: Conversation["messages"][number] = {
      id: presentationMessageId(1),
      serverSequence: 3,
      role: "assistant",
      content: "## 1.2\n服务器正文",
      timestamp: 10,
      knowledgeBase: {
        kind: "presentation",
        turnId: "turn-confirm-1",
        presentationKey: presentationKey(1),
        generation: 1,
        revision: 1,
        leafId: "1.2",
        serverOwned: true,
      },
    };
    const cachedPresentation = {
      ...remotePresentation,
      serverSequence: undefined,
      content: "## 1.2\n浏览器旧缓存",
      timestamp: 9_999,
    };
    const confirmation: Conversation["messages"][number] = {
      id: knowledgeBaseUserMessagePublicId("turn-confirm-2"),
      serverSequence: 4,
      role: "user",
      content: "确认",
      timestamp: 1,
      knowledgeBase: {
        kind: "pending_user",
        turnId: "turn-confirm-2",
        generation: 1,
        revision: 1,
        leafId: "1.2",
        serverOwned: true,
      },
    };

    const merged = mergeServerOwnedKnowledgeBaseMessages(
      [cachedPresentation],
      [confirmation, remotePresentation],
    );

    expect(merged.map((message) => message.serverSequence)).toEqual([3, 4]);
    expect(merged[0]?.content).toContain("服务器正文");
  });

  it("keeps uploaded file chips by exact fileId when the authoritative turn replaces the optimistic request", () => {
    const uploadedAttachment = {
      id: "optimistic-attachment",
      type: "file" as const,
      name: "企业事实确认表.pdf",
      fileId: "customer-file-1",
    };
    const optimistic: Conversation["messages"][number] = {
      id: "optimistic-user-message",
      role: "user",
      content: "请参考这份资料",
      attachments: [uploadedAttachment],
      timestamp: 10,
      knowledgeBase: {
        kind: "pending_user",
        clientRequestId: "request-turn-upload",
      },
    };
    const authoritative: Conversation["messages"][number] = {
      id: knowledgeBaseUserMessagePublicId("turn-upload"),
      serverSequence: 4,
      role: "user",
      content: "请参考这份资料",
      attachments: [
        {
          id: "canonical-attachment",
          type: "file",
          name: "企业事实确认表.pdf",
          fileId: "customer-file-1",
        },
      ],
      timestamp: 20,
      knowledgeBase: {
        schemaVersion: 1,
        kind: "pending_user",
        clientRequestId: "request-turn-upload",
        turnId: "turn-upload",
        generation: 1,
        revision: 1,
        leafId: "1.2",
        serverOwned: true,
      },
    };

    const merged = mergeServerOwnedKnowledgeBaseMessages(
      [optimistic],
      [authoritative],
    );

    expect(merged).toHaveLength(1);
    expect(merged[0]).toMatchObject({
      id: knowledgeBaseUserMessagePublicId("turn-upload"),
      serverSequence: 4,
      attachments: [
        {
          id: "canonical-attachment",
          type: "file",
          name: "企业事实确认表.pdf",
          fileId: "customer-file-1",
        },
      ],
      knowledgeBase: { serverOwned: true, turnId: "turn-upload" },
    });
  });

  it("keeps browser payloads only on the matching authoritative file ID", () => {
    const localFile = new File(["local-pdf"], "企业事实确认表.pdf", {
      type: "application/pdf",
    });
    const optimistic: Conversation["messages"][number] = {
      id: "optimistic-user-message",
      role: "user",
      content: "请参考这份资料",
      attachments: [
        {
          id: "optimistic-attachment",
          type: "file",
          name: "企业事实确认表.pdf",
          fileId: "customer-file-1",
          file: localFile,
          blobUrl: "blob:customer-file-1",
          base64: "data:application/pdf;base64,bG9jYWwtcGRm",
        },
      ],
      timestamp: 10,
      knowledgeBase: {
        kind: "pending_user",
        clientRequestId: "request-turn-upload",
      },
    };
    const authoritative: Conversation["messages"][number] = {
      id: knowledgeBaseUserMessagePublicId("turn-upload"),
      serverSequence: 4,
      role: "user",
      content: "请参考这份资料",
      attachments: [
        {
          id: "canonical-attachment",
          type: "file",
          name: "企业事实确认表（规范名）.pdf",
          fileId: "customer-file-1",
        },
      ],
      timestamp: 20,
      knowledgeBase: {
        schemaVersion: 1,
        kind: "pending_user",
        clientRequestId: "request-turn-upload",
        turnId: "turn-upload",
        generation: 1,
        revision: 1,
        leafId: "1.2",
        serverOwned: true,
      },
    };

    const [merged] = mergeServerOwnedKnowledgeBaseMessages(
      [optimistic],
      [authoritative],
    );

    expect(merged?.attachments?.[0]).toMatchObject({
      id: "canonical-attachment",
      name: "企业事实确认表（规范名）.pdf",
      fileId: "customer-file-1",
      file: localFile,
      blobUrl: "blob:customer-file-1",
      base64: "data:application/pdf;base64,bG9jYWwtcGRm",
    });
  });

  it("does not copy browser payloads across mismatched authoritative file IDs", () => {
    const optimistic: Conversation["messages"][number] = {
      id: "optimistic-user-message",
      role: "user",
      content: "请参考这份资料",
      attachments: [
        {
          id: "same-chip-id",
          type: "file",
          name: "同名.pdf",
          fileId: "customer-file-a",
          file: new File(["a"], "同名.pdf"),
          blobUrl: "blob:customer-file-a",
          base64: "data:application/pdf;base64,YQ==",
        },
      ],
      timestamp: 10,
      knowledgeBase: {
        kind: "pending_user",
        clientRequestId: "request-turn-upload",
      },
    };
    const authoritative: Conversation["messages"][number] = {
      id: knowledgeBaseUserMessagePublicId("turn-upload"),
      serverSequence: 4,
      role: "user",
      content: "请参考这份资料",
      attachments: [
        {
          id: "same-chip-id",
          type: "file",
          name: "同名.pdf",
          fileId: "customer-file-b",
        },
      ],
      timestamp: 20,
      knowledgeBase: {
        kind: "pending_user",
        clientRequestId: "request-turn-upload",
        turnId: "turn-upload",
        serverOwned: true,
      },
    };

    const [merged] = mergeServerOwnedKnowledgeBaseMessages(
      [optimistic],
      [authoritative],
    );

    expect(merged?.attachments?.[0]).toEqual({
      id: "same-chip-id",
      type: "file",
      name: "同名.pdf",
      fileId: "customer-file-b",
    });
  });

  it("preserves server-owned history even before client KB state is restored", () => {
    const approved = applyKnowledgeBaseObservation(
      conversation(),
      observation(2, "turn-1", 1, "1.2", "## 1.2\n已批准正文"),
    );
    const localWithoutState = { ...approved, knowledgeBase: undefined };
    const staleRemote = {
      ...conversation(),
      messages: [],
      deletedMessageIds: [presentationMessageId(1)],
      updatedAt: approved.updatedAt + 1,
    };

    const merged = mergeKnowledgeBaseHydration(localWithoutState, staleRemote);
    expect(merged.messages.map((message) => message.id)).toEqual([
      knowledgeBaseUserMessagePublicId("turn-1"),
      presentationMessageId(1),
    ]);
    expect(merged.deletedMessageIds ?? []).not.toContain(
      presentationMessageId(1),
    );
  });

  it("does not replace a server-owned presentation with the same-id stale copy", () => {
    const approved = applyKnowledgeBaseObservation(
      conversation(),
      observation(2, "turn-1", 1, "1.2", "## 1.2\n已批准正文"),
    );
    const presentation = approved.messages.at(-1)!;
    const merged = mergeServerOwnedKnowledgeBaseMessages(
      [presentation],
      [
        {
          ...presentation,
          content: "旧正文",
          knowledgeBase: undefined,
          timestamp: presentation.timestamp + 10,
        },
      ],
    );

    expect(merged).toHaveLength(1);
    expect(merged[0]?.content).toContain("已批准正文");
    expect(merged[0]?.knowledgeBase?.serverOwned).toBe(true);
  });

  it("rejects an older observation using durable presentation metadata as the floor", () => {
    const current = applyKnowledgeBaseObservation(
      conversation(),
      observation(3, "turn-3", 3, "1.4", "## 1.4\n当前正文"),
    );
    const rehydratedWithoutState = { ...current, knowledgeBase: undefined };
    const stale = applyKnowledgeBaseObservation(
      rehydratedWithoutState,
      observation(2, "turn-2", 2, "1.3", "## 1.3\n旧正文"),
    );

    expect(stale).toBe(rehydratedWithoutState);
    expect(stale.messages.at(-1)?.content).toContain("当前正文");
  });
});
