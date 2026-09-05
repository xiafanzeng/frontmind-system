import React from "react";
import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { knowledgeBaseUserMessagePublicId } from "@shared/knowledge-base-message";
import { generalChatTerminalMessagePublicId } from "@shared/frontmind-general-chat-terminal";
import {
  ConversationProvider,
  appendOrUpsertConversationMessage,
  applyKnowledgeBaseObservation,
  conversationSyncErrorMessage,
  currentKnowledgeBaseReplySnapshot,
  mergeKnowledgeBaseHydration,
  mergeDirtyConversationHydration,
  mergeServerOwnedKnowledgeBaseMessages,
  parseOutputMessages,
  prepareConversationForCloud,
  remoteMissingLocalConversations,
  sanitizeKnowledgeBaseCustomerMarkdown,
  sanitizeKnowledgeBaseOutputMessages,
  useConversation,
  type Conversation,
} from "./ConversationContext";

describe("general-chat terminal message upsert", () => {
  it("atomically replaces the same deterministic notice and leaves ordinary duplicate repair unchanged", () => {
    const terminalId = generalChatTerminalMessagePublicId({
      conversationId: "conversation-1",
      taskId: "task-1",
      errorCode: "PARTIAL_RESULT_PRESERVED",
    });
    const first = {
      id: terminalId,
      role: "assistant" as const,
      content: "旧提示",
      timestamp: 1,
    };
    const next = appendOrUpsertConversationMessage([first], {
      ...first,
      content: "部分结果已保留",
      timestamp: 2,
    });
    expect(next).toEqual([
      expect.objectContaining({
        id: terminalId,
        content: "部分结果已保留",
        timestamp: 2,
      }),
    ]);

    const ordinary = appendOrUpsertConversationMessage(
      [{ ...first, id: "ordinary" }],
      { ...first, id: "ordinary", content: "第二条" },
    );
    expect(ordinary.map(({ id }) => id)).toEqual(["ordinary", "ordinary~2"]);
  });
});

describe("conversation sync errors", () => {
  it("promises preservation for both transport and business write failures", () => {
    expect(conversationSyncErrorMessage(new TypeError("Failed to fetch"))).toBe(
      "会话尚未同步，消息和附件已保留。请重试，请勿重复发送。",
    );
    expect(conversationSyncErrorMessage(new Error("保存被拒绝"))).toBe(
      "会话尚未同步，消息和附件已保留。请重试，请勿重复发送。",
    );
  });
});

describe("dirty hydration fencing", () => {
  const conversation = (id: string): Conversation => ({
    id,
    title: id,
    messages: [],
    status: "idle",
    createdAt: 1,
    updatedAt: 1,
  });

  it("preserves remote-missing dirty conversations on a later refresh", () => {
    const local = [conversation("clean"), conversation("dirty")];
    expect(
      remoteMissingLocalConversations(
        local,
        new Set<string>(),
        false,
        (id) => id === "dirty",
      ).map(({ id }) => id),
    ).toEqual(["dirty"]);
  });

  it("preserves every optimistic conversation during initial hydration", () => {
    const local = [conversation("already-remote"), conversation("new-local")];
    expect(
      remoteMissingLocalConversations(
        local,
        new Set(["already-remote"]),
        true,
        () => false,
      ).map(({ id }) => id),
    ).toEqual(["new-local"]);
  });
});

describe("knowledge-base attachment payload reconciliation", () => {
  function pendingUserMessage(input: {
    id: string;
    serverOwned: boolean;
    attachments?: Conversation["messages"][number]["attachments"];
  }): Conversation["messages"][number] {
    return {
      id: input.id,
      role: "user",
      content: "上传资料",
      timestamp: input.serverOwned ? 2 : 1,
      attachments: input.attachments,
      knowledgeBase: {
        kind: "pending_user",
        clientRequestId: "request-attachment",
        ...(input.serverOwned
          ? { turnId: "turn-attachment", serverOwned: true }
          : { serverOwned: false }),
      },
    };
  }

  it("reattaches browser bytes only for an exact opaque fileId match", () => {
    const localFile = new File(["local"], "same.pdf", {
      type: "application/pdf",
    });
    const [merged] = mergeServerOwnedKnowledgeBaseMessages(
      [
        pendingUserMessage({
          id: "optimistic",
          serverOwned: false,
          attachments: [
            {
              id: "optimistic-attachment",
              type: "file",
              name: "same.pdf",
              fileId: " folder/%2F?# ",
              file: localFile,
              blobUrl: "blob:exact",
            },
          ],
        }),
      ],
      [
        pendingUserMessage({
          id: "canonical",
          serverOwned: true,
          attachments: [
            {
              id: "canonical-attachment",
              type: "file",
              name: "server-name.pdf",
              fileId: " folder/%2F?# ",
            },
          ],
        }),
      ],
    );

    expect(merged.attachments?.[0]).toMatchObject({
      id: "canonical-attachment",
      fileId: " folder/%2F?# ",
      file: localFile,
      blobUrl: "blob:exact",
    });
  });

  it("never copies payloads when the authoritative attachment is absent or has no exact fileId", () => {
    const localFile = new File(["local"], "same.pdf", {
      type: "application/pdf",
    });
    const optimistic = pendingUserMessage({
      id: "optimistic",
      serverOwned: false,
      attachments: [
        {
          id: "same-id",
          type: "file",
          name: "same.pdf",
          fileId: "local-file-id",
          file: localFile,
          blobUrl: "blob:wrong",
        },
      ],
    });

    const [withoutAttachments] = mergeServerOwnedKnowledgeBaseMessages(
      [optimistic],
      [pendingUserMessage({ id: "canonical-empty", serverOwned: true })],
    );
    expect(withoutAttachments.attachments).toBeUndefined();

    const [withoutFileId] = mergeServerOwnedKnowledgeBaseMessages(
      [optimistic],
      [
        pendingUserMessage({
          id: "canonical-no-file-id",
          serverOwned: true,
          attachments: [{ id: "same-id", type: "file", name: "same.pdf" }],
        }),
      ],
    );
    expect(withoutFileId.attachments?.[0]?.file).toBeUndefined();
    expect(withoutFileId.attachments?.[0]?.blobUrl).toBeUndefined();

    const [differentFileId] = mergeServerOwnedKnowledgeBaseMessages(
      [optimistic],
      [
        pendingUserMessage({
          id: "canonical-other-file",
          serverOwned: true,
          attachments: [
            {
              id: "same-id",
              type: "file",
              name: "same.pdf",
              fileId: "different-file-id",
            },
          ],
        }),
      ],
    );
    expect(differentFileId.attachments?.[0]?.file).toBeUndefined();
    expect(differentFileId.attachments?.[0]?.blobUrl).toBeUndefined();
  });
});

const mocks = vi.hoisted(() => ({
  auth: {
    user: { id: 1 },
    loading: false,
  } as { user: { id: number } | null; loading: boolean },
  listInput: vi.fn(),
  listRefetch: vi.fn(),
  syncSnapshot: vi.fn(),
  deleteConversation: vi.fn(),
}));

vi.mock("@/_core/hooks/useAuth", () => ({
  useAuth: () => mocks.auth,
}));

vi.mock("@/lib/trpc", () => ({
  trpc: {
    conversation: {
      list: {
        useQuery: (input: unknown) => {
          mocks.listInput(input);
          return { refetch: mocks.listRefetch };
        },
      },
      syncSnapshot: {
        useMutation: () => ({ mutateAsync: mocks.syncSnapshot }),
      },
      delete: {
        useMutation: () => ({ mutateAsync: mocks.deleteConversation }),
      },
    },
  },
}));

function conversation(id: string): Conversation {
  return {
    id,
    title: `Conversation ${id}`,
    messages: [],
    status: "idle",
    createdAt: 100,
    updatedAt: 200,
  };
}

function wrapper({ children }: { children: React.ReactNode }) {
  return <ConversationProvider>{children}</ConversationProvider>;
}

describe("knowledge-base reply snapshots", () => {
  it("returns all reply coordinates from one rendered presentation", () => {
    const value: Conversation = {
      ...conversation("reply-snapshot"),
      status: "awaiting_input",
      messages: [
        {
          id: "presentation",
          role: "assistant",
          content: "## 当前节点\n正文",
          timestamp: 1,
          knowledgeBase: {
            kind: "presentation",
            turnId: "turn-7",
            presentationKey: "presentation-7",
            generation: 3,
            revision: 7,
            leafId: "1.8",
            serverOwned: true,
          },
        },
      ],
      knowledgeBase: {
        initialized: true,
        generation: 3,
        stateEpoch: 9,
        activeTurnId: null,
        activeClientRequestId: null,
        presentationTurnId: "turn-7",
        interactionState: "awaiting_input",
        canReply: true,
        presentationKey: "presentation-7",
        revision: 7,
        leafId: "1.8",
        notice: null,
      },
    };
    expect(currentKnowledgeBaseReplySnapshot(value)).toEqual({
      generation: 3,
      stateEpoch: 9,
      revision: 7,
      contentVersion: 0,
      leafId: "1.8",
      presentationKey: "presentation-7",
      presentationTurnId: "turn-7",
    });
  });

  it("clears stale task pointers when the authoritative id is explicitly null", () => {
    const next = applyKnowledgeBaseObservation(
      {
        ...conversation("released-kb-task"),
        taskId: "stale-task",
        previousResponseId: "stale-task",
      },
      {
        generation: 1,
        stateEpoch: 1,
        authoritativeTaskId: null,
        activeTurn: null,
        completedTurn: null,
        approvedPresentation: null,
        progress: null,
        notice: null,
        interaction: {
          interactionState: "executing",
          canReply: false,
          canPublish: false,
          lockReason: "任务仍在执行",
          progress: null,
        },
      } as any,
    );
    expect(next.taskId).toBeUndefined();
    expect(next.previousResponseId).toBeUndefined();
  });

  it("commits the server-owned pre-create business projection without inferring from the notice", () => {
    const progress = {
      build: { id: "build-precreate", revision: 0, currentLeafId: null },
      contentAvailability: "none",
      operationState: "reset_required",
      resetAllowed: true,
      taskCreationState: "not_attempted",
      failureStage: "provider_file_registration",
      retainedCustomerAttachmentCount: 9,
      generatedSystemAttachmentCount: 2,
      settledAt: 1_787_000_000_000,
    } as any;
    const next = applyKnowledgeBaseObservation(
      conversation("precreate-failure"),
      {
        generation: 1,
        stateEpoch: 2,
        authoritativeTaskId: null,
        activeTurn: null,
        completedTurn: null,
        approvedPresentation: null,
        progress,
        notice: {
          key: "safe-notice",
          code: "RESET_REQUIRED",
          severity: "warning",
          message: "请申请重置",
          retryable: false,
          recoveryAction: "approve_reset",
          attachmentCount: 11,
          turnId: "turn-precreate",
          createdAt: 1,
        },
        interaction: {
          interactionState: "failed",
          canReply: false,
          canPublish: false,
          lockReason: "RESET_REQUIRED",
          progress,
        },
      } as any,
    );

    expect(next.knowledgeBase).toMatchObject({
      contentAvailability: "none",
      operationState: "reset_required",
      resetAllowed: true,
      taskCreationState: "not_attempted",
      failureStage: "provider_file_registration",
      retainedCustomerAttachmentCount: 9,
      generatedSystemAttachmentCount: 2,
      settledAt: 1_787_000_000_000,
    });
    expect(next.knowledgeBase?.notice?.severity).toBe("warning");
    expect(next.knowledgeBase?.notice?.attachmentCount).toBe(11);
  });

  it("applies an equivalent observation to repair optimistic running state", () => {
    const progress = {
      build: {
        id: "build-1",
        revision: 1,
        currentLeafId: "1.2",
      },
    } as any;
    const next = applyKnowledgeBaseObservation(
      {
        ...conversation("equivalent-observation"),
        status: "running",
        messages: [
          {
            id: "optimistic-confirmation",
            role: "user",
            content: "确认",
            timestamp: 1,
            knowledgeBase: {
              kind: "pending_user",
              clientRequestId: "request-confirm",
              serverOwned: false,
            },
          },
        ],
        knowledgeBase: {
          initialized: true,
          generation: 2,
          stateEpoch: 9,
          activeTurnId: null,
          activeClientRequestId: null,
          interactionState: "executing",
          canReply: false,
          presentationKey: "a".repeat(64),
          presentationTurnId: null,
          revision: 1,
          leafId: "1.2",
          notice: null,
        },
      },
      {
        generation: 2,
        stateEpoch: 9,
        authoritativeTaskId: "task-completed",
        activeTurn: null,
        completedTurn: null,
        progress,
        approvedPresentation: {
          turnId: "turn-confirm",
          clientRequestId: "request-confirm",
          presentationKey: "a".repeat(64),
          revision: 1,
          leafId: "1.2",
          visibleMarkdown: "## 当前节点\n已批准正文",
          contentSha256: "a".repeat(64),
          imageState: "attached",
          resources: [],
        },
        notice: null,
        interaction: {
          interactionState: "awaiting_input",
          canReply: true,
          canPublish: false,
          lockReason: null,
          progress,
        },
      } as any,
    );

    expect(next.status).toBe("awaiting_input");
    expect(next.knowledgeBase).toMatchObject({
      generation: 2,
      stateEpoch: 9,
      interactionState: "awaiting_input",
      canReply: true,
    });
    expect(next.messages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: expect.stringContaining("turn-confirm"),
          knowledgeBase: expect.objectContaining({
            turnId: "turn-confirm",
            serverOwned: true,
          }),
        }),
        expect.objectContaining({
          role: "assistant",
          content: "## 当前节点\n已批准正文",
        }),
      ]),
    );
  });
});

describe("ConversationProvider cloud hydration", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.auth.user = { id: 1 };
    mocks.auth.loading = false;
    mocks.listRefetch.mockResolvedValue({ data: [conversation("account-1")] });
    mocks.syncSnapshot.mockResolvedValue(conversation("synced"));
    mocks.deleteConversation.mockResolvedValue({ success: true });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("accepts a higher durable KB revision even when its display sequence is lower", () => {
    const state = (revision: number, stateEpoch: number) => ({
      initialized: true,
      generation: 1,
      stateEpoch,
      revision,
      leafId: `leaf-${revision}`,
      presentationKey: `presentation-${revision}`,
      presentationTurnId: `turn-${revision}`,
      activeTurnId: null,
      activeClientRequestId: null,
      interactionState: "awaiting_input" as const,
      canReply: true,
      displaySequence: revision === 7 ? 70 : 1,
      notice: null,
    });
    const local: Conversation = {
      ...conversation("higher-revision-hydration"),
      status: "running",
      knowledgeBase: state(7, 7),
    };
    const remote: Conversation = {
      ...conversation("higher-revision-hydration"),
      status: "awaiting_input",
      knowledgeBase: state(8, 8),
    };

    expect(mergeKnowledgeBaseHydration(local, remote)).toMatchObject({
      status: "awaiting_input",
      knowledgeBase: { revision: 8, stateEpoch: 8, displaySequence: 1 },
    });
  });

  it("hydrates conversations from the database", async () => {
    const { result } = renderHook(() => useConversation(), { wrapper });

    expect(result.current.loading).toBe(true);
    await waitFor(() => expect(result.current.hydrated).toBe(true));
    expect(result.current.state.conversations.map((item) => item.id)).toEqual([
      "account-1",
    ]);
  });

  it("settles a failed initial list read and can explicitly retry it", async () => {
    mocks.listRefetch.mockRejectedValueOnce(new TypeError("Failed to fetch"));
    const { result } = renderHook(() => useConversation(), { wrapper });

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.hydrated).toBe(false);
    expect(result.current.loading).toBe(false);
    expect(result.current.syncError).toBe(
      "会话尚未同步，消息和附件已保留。请重试，请勿重复发送。",
    );
    expect(result.current.state.conversations).toEqual([]);

    await act(async () => {
      await result.current.refreshConversations();
    });
    await waitFor(() => expect(result.current.syncError).toBeNull());
    expect(result.current.state.conversations.map((item) => item.id)).toEqual([
      "account-1",
    ]);
  });

  it("gives an invalidated initial hydration a finite retryable outcome", async () => {
    let resolveInitial: ((value: { data: Conversation[] }) => void) | undefined;
    mocks.listRefetch.mockReturnValueOnce(
      new Promise((resolve) => {
        resolveInitial = resolve;
      }),
    );
    const { result } = renderHook(() => useConversation(), { wrapper });

    expect(result.current.hydrated).toBe(false);
    act(() => result.current.discardConversationLocally("stale-local"));
    await act(async () => {
      resolveInitial?.({ data: [conversation("stale-remote")] });
      await Promise.resolve();
    });

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.hydrated).toBe(false);
    expect(result.current.loading).toBe(false);
    expect(result.current.syncError).toContain("请重新读取");
    expect(result.current.state.conversations).toEqual([]);
  });

  it("clears a released response-logic task pointer so the next turn can start fresh", async () => {
    mocks.listRefetch.mockResolvedValue({
      data: [
        {
          ...conversation("response-logic-released"),
          status: "completed",
          taskId: "task-gone",
          taskUrl: "https://tasks.example/task-gone",
          previousResponseId: "task-gone",
        },
      ],
    });
    const { result } = renderHook(() => useConversation(), { wrapper });
    await waitFor(() => expect(result.current.hydrated).toBe(true));

    act(() => {
      result.current.updateStatus("response-logic-released", "error", {
        clearTaskPointer: true,
        completedAt: Date.now(),
      });
    });

    const released = result.current.state.conversations.find(
      (item) => item.id === "response-logic-released",
    );
    expect(released?.taskId).toBeUndefined();
    expect(released?.taskUrl).toBeUndefined();
    expect(released?.previousResponseId).toBeUndefined();
  });

  it("revokes and removes an attachment blob only after it expires", async () => {
    const revokeObjectURL = vi.fn();
    Object.defineProperty(URL, "revokeObjectURL", {
      configurable: true,
      value: revokeObjectURL,
    });
    const { result } = renderHook(() => useConversation(), { wrapper });
    await waitFor(() => expect(result.current.hydrated).toBe(true));

    let conversationId = "";
    act(() => {
      conversationId = result.current.createConversation();
      result.current.addMessage(conversationId, {
        id: "live-message",
        role: "user",
        content: "live",
        timestamp: Date.now(),
        attachments: [
          {
            id: "live-attachment",
            type: "file",
            name: "live.pdf",
            fileId: "live-file",
            blobUrl: "blob:live-file",
            expiresAt: Date.now() + 60_000,
          },
        ],
      });
    });

    const liveAttachment = result.current.state.conversations.find(
      (item) => item.id === conversationId,
    )?.messages[0]?.attachments?.[0];
    expect(liveAttachment?.blobUrl).toBe("blob:live-file");
    expect(revokeObjectURL).not.toHaveBeenCalled();

    act(() => {
      result.current.addMessage(conversationId, {
        id: "expired-message",
        role: "user",
        content: "expired",
        timestamp: Date.now(),
        attachments: [
          {
            id: "expired-attachment",
            type: "file",
            name: "expired.pdf",
            fileId: "expired-file",
            blobUrl: "blob:expired-file",
            expiresAt: Date.now() - 1,
          },
        ],
      });
    });

    const attachment = result.current.state.conversations.find(
      (item) => item.id === conversationId,
    )?.messages[1]?.attachments?.[0];
    expect(attachment).toMatchObject({
      fileId: "expired-file",
      expired: true,
    });
    expect(attachment?.blobUrl).toBeUndefined();
    expect(revokeObjectURL).toHaveBeenCalledWith("blob:expired-file");
  });

  it("keeps scheduling through the browser timer ceiling until the 30-day hard deadline", async () => {
    const revokeObjectURL = vi.fn();
    Object.defineProperty(URL, "revokeObjectURL", {
      configurable: true,
      value: revokeObjectURL,
    });
    const { result } = renderHook(() => useConversation(), { wrapper });
    await waitFor(() => expect(result.current.hydrated).toBe(true));

    const uploadedAt = Date.parse("2026-08-04T00:00:00.000Z");
    const retentionMs = 30 * 24 * 60 * 60 * 1_000;
    const browserTimerCeilingMs = 2_147_000_000;
    vi.useFakeTimers();
    vi.setSystemTime(uploadedAt);

    let conversationId = "";
    act(() => {
      conversationId = result.current.createConversation();
      result.current.addMessage(conversationId, {
        id: "thirty-day-message",
        role: "user",
        content: "hard deadline",
        timestamp: uploadedAt,
        attachments: [
          {
            id: "thirty-day-attachment",
            type: "file",
            name: "retained.pdf",
            fileId: "retained-file",
            file: new File(["pdf"], "retained.pdf"),
            blobUrl: "blob:retained-file",
            expiresAt: uploadedAt + retentionMs,
          },
        ],
      });
    });

    await act(async () => {
      await vi.advanceTimersByTimeAsync(browserTimerCeilingMs);
    });
    expect(revokeObjectURL).not.toHaveBeenCalled();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(
        retentionMs - browserTimerCeilingMs - 1,
      );
    });
    expect(revokeObjectURL).not.toHaveBeenCalled();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
    });
    const attachment = result.current.state.conversations.find(
      (item) => item.id === conversationId,
    )?.messages[0]?.attachments?.[0];
    expect(attachment).toMatchObject({
      fileId: "retained-file",
      expired: true,
    });
    expect(attachment?.file).toBeUndefined();
    expect(attachment?.blobUrl).toBeUndefined();
    expect(revokeObjectURL).toHaveBeenCalledWith("blob:retained-file");
  });

  it("rechecks attachment hard deadlines when the tab regains focus", async () => {
    const revokeObjectURL = vi.fn();
    Object.defineProperty(URL, "revokeObjectURL", {
      configurable: true,
      value: revokeObjectURL,
    });
    const { result } = renderHook(() => useConversation(), { wrapper });
    await waitFor(() => expect(result.current.hydrated).toBe(true));

    const uploadedAt = Date.parse("2026-08-04T00:00:00.000Z");
    vi.useFakeTimers();
    vi.setSystemTime(uploadedAt);
    let conversationId = "";
    act(() => {
      conversationId = result.current.createConversation();
      result.current.addMessage(conversationId, {
        id: "focus-message",
        role: "user",
        content: "focus expiry",
        timestamp: uploadedAt,
        attachments: [
          {
            id: "focus-attachment",
            type: "file",
            name: "focus.pdf",
            fileId: "focus-file",
            blobUrl: "blob:focus-file",
            expiresAt: uploadedAt + 1_000,
          },
        ],
      });
    });

    vi.setSystemTime(uploadedAt + 1_001);
    mocks.listRefetch.mockImplementationOnce(() => new Promise(() => {}));
    await act(async () => {
      window.dispatchEvent(new Event("focus"));
      await Promise.resolve();
      await Promise.resolve();
    });

    const attachment = result.current.state.conversations.find(
      (item) => item.id === conversationId,
    )?.messages[0]?.attachments?.[0];
    expect(attachment?.expired).toBe(true);
    expect(attachment?.blobUrl).toBeUndefined();
    expect(revokeObjectURL).toHaveBeenCalledWith("blob:focus-file");
  });

  it("single-flights creation of the same blank knowledge-base conversation", async () => {
    const { result } = renderHook(() => useConversation(), { wrapper });
    await waitFor(() => expect(result.current.hydrated).toBe(true));
    mocks.syncSnapshot.mockClear();

    let firstId = "";
    let secondId = "";
    act(() => {
      firstId = result.current.createConversation({
        title: "企业知识库构建",
        reuseEmpty: true,
      });
      secondId = result.current.createConversation({
        title: "企业知识库构建",
        reuseEmpty: true,
      });
    });

    expect(secondId).toBe(firstId);
    expect(
      result.current.state.conversations.filter(
        (item) => item.title === "企业知识库构建",
      ),
    ).toHaveLength(1);
    await waitFor(() => expect(mocks.syncSnapshot).toHaveBeenCalledTimes(1));
  });

  it("collapses an optimistic request and its canonical server turn on first hydration", async () => {
    const canonicalId = knowledgeBaseUserMessagePublicId("turn-1");
    mocks.listRefetch.mockResolvedValueOnce({
      data: [
        {
          ...conversation("knowledge-base"),
          messages: [
            {
              id: "optimistic-request",
              role: "user",
              content: "确认",
              timestamp: 90,
              knowledgeBase: {
                kind: "pending_user",
                clientRequestId: "request-1",
                serverOwned: false,
              },
            },
            {
              id: canonicalId,
              role: "user",
              content: "确认",
              timestamp: 100,
              knowledgeBase: {
                kind: "pending_user",
                clientRequestId: "request-1",
                turnId: "turn-1",
                serverOwned: true,
              },
            },
          ],
        },
      ],
    });

    const { result } = renderHook(() => useConversation(), { wrapper });
    await waitFor(() => expect(result.current.hydrated).toBe(true));

    expect(result.current.state.conversations[0]?.messages).toHaveLength(1);
    expect(result.current.state.conversations[0]?.messages[0]?.id).toBe(
      canonicalId,
    );
    expect(
      result.current.state.conversations[0]?.messages[0]?.knowledgeBase
        ?.serverOwned,
    ).toBe(true);
  });

  it("clears conversations immediately when the user logs out", async () => {
    const { result, rerender } = renderHook(() => useConversation(), {
      wrapper,
    });
    await waitFor(() => expect(result.current.hydrated).toBe(true));

    mocks.auth.user = null;
    rerender();

    await waitFor(() => expect(result.current.hydrated).toBe(false));
    expect(result.current.state.conversations).toEqual([]);
    expect(result.current.activeConversation).toBeNull();
  });

  it("does not expose the previous account while a new account hydrates", async () => {
    const { result, rerender } = renderHook(() => useConversation(), {
      wrapper,
    });
    await waitFor(() => expect(result.current.hydrated).toBe(true));

    let resolveSecondAccount:
      | ((value: { data: Conversation[] }) => void)
      | undefined;
    mocks.listRefetch.mockReturnValueOnce(
      new Promise((resolve) => {
        resolveSecondAccount = resolve;
      }),
    );
    mocks.auth.user = { id: 2 };
    rerender();

    await waitFor(() => expect(result.current.hydrated).toBe(false));
    expect(result.current.state.conversations).toEqual([]);

    resolveSecondAccount?.({ data: [conversation("account-2")] });
    await waitFor(() => expect(result.current.hydrated).toBe(true));
    expect(result.current.state.conversations.map((item) => item.id)).toEqual([
      "account-2",
    ]);
  });

  it("scopes engineer conversation reads and writes to the project assignment", async () => {
    const projectWrapper = ({ children }: { children: React.ReactNode }) => (
      <ConversationProvider projectAssignmentId="project-assignment-1">
        {children}
      </ConversationProvider>
    );
    const { result } = renderHook(() => useConversation(), {
      wrapper: projectWrapper,
    });

    await waitFor(() => expect(result.current.hydrated).toBe(true));
    expect(mocks.listInput).toHaveBeenCalledWith({
      projectAssignmentId: "project-assignment-1",
    });

    act(() => {
      result.current.createConversation();
    });
    await waitFor(() =>
      expect(mocks.syncSnapshot).toHaveBeenCalledWith(
        expect.objectContaining({
          projectAssignmentId: "project-assignment-1",
          conversation: expect.any(Object),
        }),
      ),
    );
  });

  it("does not delete or overwrite a hydrated server-owned KB turn", async () => {
    const protectedConversation: Conversation = {
      ...conversation("knowledge-base"),
      status: "awaiting_input",
      messages: [
        {
          id: "turn-1",
          role: "user",
          content: "确认",
          timestamp: 100,
          knowledgeBase: {
            kind: "pending_user",
            clientRequestId: "request-1",
            turnId: "turn-1",
            serverOwned: true,
          },
        },
        {
          id: "presentation-1",
          role: "assistant",
          content: "## 1.2\n已批准正文",
          timestamp: 110,
          knowledgeBase: {
            kind: "presentation",
            turnId: "turn-1",
            presentationKey: "presentation-1",
            generation: 1,
            revision: 1,
            leafId: "1.2",
            serverOwned: true,
          },
        },
      ],
    };
    mocks.listRefetch.mockResolvedValueOnce({
      data: [protectedConversation],
    });
    const { result } = renderHook(() => useConversation(), { wrapper });
    await waitFor(() => expect(result.current.hydrated).toBe(true));

    act(() => {
      result.current.deleteMessage("knowledge-base", "presentation-1");
      result.current.updateAssistantMessages("knowledge-base", [
        {
          id: "stale-raw-output",
          role: "assistant",
          content: "旧上游投影",
          timestamp: 120,
        },
      ]);
      result.current.deleteConversation("knowledge-base");
    });

    const current = result.current.state.conversations.find(
      (item) => item.id === "knowledge-base",
    );
    expect(current?.messages.map((message) => message.id)).toEqual([
      "turn-1",
      "presentation-1",
    ]);
    expect(current?.deletedMessageIds ?? []).not.toContain("presentation-1");
    expect(mocks.deleteConversation).not.toHaveBeenCalled();
  });

  it("does not delete or tombstone a pending ordinary-chat user message", async () => {
    const pendingConversation: Conversation = {
      ...conversation("pending-general-chat-delete"),
      executionKind: "general_chat_v2",
      messages: [
        {
          id: "pending-user",
          role: "user",
          content: "尚未确认的请求",
          timestamp: 100,
          generalChatDispatch: {
            schemaVersion: 1,
            kind: "pending_user",
            clientRequestId: "pending-user",
            providerPrompt: "尚未确认的 Provider 请求",
            localAssetIds: [],
            localTaskId: null,
            modelProfile: "frontmind-base",
          },
        },
        {
          id: "settled-user",
          role: "user",
          content: "已确认的普通消息",
          timestamp: 90,
        },
      ],
    };
    mocks.listRefetch.mockResolvedValueOnce({ data: [pendingConversation] });
    const { result } = renderHook(() => useConversation(), { wrapper });
    await waitFor(() => expect(result.current.hydrated).toBe(true));

    act(() => {
      result.current.deleteMessage(
        "pending-general-chat-delete",
        "pending-user",
      );
    });

    let current = result.current.state.conversations.find(
      (item) => item.id === "pending-general-chat-delete",
    );
    expect(current?.messages.map((message) => message.id)).toEqual([
      "settled-user",
      "pending-user",
    ]);
    expect(current?.deletedMessageIds ?? []).not.toContain("pending-user");

    act(() => {
      result.current.deleteMessage(
        "pending-general-chat-delete",
        "settled-user",
      );
    });

    current = result.current.state.conversations.find(
      (item) => item.id === "pending-general-chat-delete",
    );
    expect(current?.messages.map((message) => message.id)).toEqual([
      "pending-user",
    ]);
    expect(current?.deletedMessageIds).toContain("settled-user");
  });

  it("hides an empty current-turn projection, preserves its terminal notice, and restores the same ID once", async () => {
    const terminalId = generalChatTerminalMessagePublicId({
      conversationId: "projection-recovery",
      taskId: "task-1",
      errorCode: "PARTIAL_RESULT_PRESERVED",
    });
    const projection = {
      id: "projection-1",
      upstreamOutputId: "event-row-1",
      role: "assistant" as const,
      content: "可恢复结果",
      timestamp: 2,
      generalChat: {
        schemaVersion: 1 as const,
        kind: "assistant_projection" as const,
        turnId: "turn-1",
        agentTaskId: "task-1",
        providerEventId: "provider-event-1",
        serverOwned: true as const,
      },
    };
    mocks.listRefetch.mockResolvedValueOnce({
      data: [
        {
          ...conversation("projection-recovery"),
          executionKind: "general_chat_v2",
          taskId: "task-1",
          messages: [
            {
              id: "user-1",
              role: "user",
              content: "当前轮",
              timestamp: 1,
            },
            projection,
            {
              id: terminalId,
              role: "assistant",
              content: "部分结果已保留",
              timestamp: 3,
            },
          ],
        },
      ],
    });
    const { result } = renderHook(() => useConversation(), { wrapper });
    await waitFor(() => expect(result.current.hydrated).toBe(true));
    mocks.syncSnapshot.mockClear();

    act(() => {
      result.current.updateAssistantMessages("projection-recovery", []);
    });
    expect(
      result.current.state.conversations
        .find((item) => item.id === "projection-recovery")
        ?.messages.map((message) => message.id),
    ).toEqual(["user-1", terminalId]);

    act(() => {
      result.current.updateAssistantMessages("projection-recovery", [
        projection,
      ]);
      result.current.updateAssistantMessages("projection-recovery", [
        projection,
      ]);
    });
    expect(
      result.current.state.conversations
        .find((item) => item.id === "projection-recovery")
        ?.messages.map((message) => message.id),
    ).toEqual(["user-1", "projection-1", terminalId]);
    expect(mocks.syncSnapshot).not.toHaveBeenCalled();
  });

  it("keeps twenty identical general-chat projections referentially stable and never re-syncs them", async () => {
    const projection = {
      id: "canonical-message-1",
      upstreamOutputId: "event-row-1",
      role: "assistant" as const,
      content: "稳定的处理中消息",
      timestamp: 2,
      serverSequence: 7,
      generalChat: {
        schemaVersion: 1 as const,
        kind: "assistant_projection" as const,
        turnId: "turn-1",
        agentTaskId: "task-1",
        providerEventId: "provider-event-1",
        serverOwned: true as const,
      },
    };
    mocks.listRefetch.mockResolvedValueOnce({
      data: [
        {
          ...conversation("stable-general-chat"),
          executionKind: "general_chat_v2",
          status: "running",
          taskId: "task-1",
          startedAt: 1,
          messages: [
            { id: "user-1", role: "user", content: "开始", timestamp: 1 },
            projection,
          ],
        },
      ],
    });
    const { result } = renderHook(() => useConversation(), { wrapper });
    await waitFor(() => expect(result.current.hydrated).toBe(true));
    const initialConversation = result.current.state.conversations[0];
    const initialProjection = initialConversation.messages[1];
    mocks.syncSnapshot.mockClear();

    act(() => {
      for (let index = 0; index < 20; index += 1) {
        result.current.updateAssistantMessages("stable-general-chat", [
          {
            ...projection,
            id: `transient-${index}`,
            timestamp: 10_000 + index,
          },
        ]);
        result.current.updateStatus("stable-general-chat", "running", {
          taskId: "task-1",
          startedAt: 1,
        });
      }
    });

    const current = result.current.state.conversations[0];
    expect(current).toBe(initialConversation);
    expect(current.messages[1]).toBe(initialProjection);
    expect(current.messages[1]).toMatchObject({
      id: "canonical-message-1",
      timestamp: 2,
    });
    expect(mocks.syncSnapshot).not.toHaveBeenCalled();
  });

  it("removes and revives a deterministic terminal notice without a tombstone", async () => {
    const terminalId = generalChatTerminalMessagePublicId({
      conversationId: "terminal-recovery",
      taskId: "task-1",
      errorCode: "PARTIAL_RESULT_PRESERVED",
    });
    mocks.listRefetch.mockResolvedValueOnce({
      data: [
        {
          ...conversation("terminal-recovery"),
          deletedMessageIds: [terminalId],
          messages: [],
        },
      ],
    });
    const { result } = renderHook(() => useConversation(), { wrapper });
    await waitFor(() => expect(result.current.hydrated).toBe(true));

    const notice = {
      id: terminalId,
      role: "assistant" as const,
      content: "部分结果已保留",
      timestamp: 1,
    };
    act(() => result.current.addMessage("terminal-recovery", notice));
    let current = result.current.state.conversations.find(
      (item) => item.id === "terminal-recovery",
    );
    expect(current?.messages.map((message) => message.id)).toEqual([
      terminalId,
    ]);
    expect(current?.deletedMessageIds ?? []).not.toContain(terminalId);

    act(() => result.current.deleteMessage("terminal-recovery", terminalId));
    current = result.current.state.conversations.find(
      (item) => item.id === "terminal-recovery",
    );
    expect(current?.messages).toEqual([]);
    expect(current?.deletedMessageIds ?? []).not.toContain(terminalId);

    act(() => result.current.addMessage("terminal-recovery", notice));
    current = result.current.state.conversations.find(
      (item) => item.id === "terminal-recovery",
    );
    expect(current?.messages.map((message) => message.id)).toEqual([
      terminalId,
    ]);
  });

  it("keeps a reset-discarded conversation out of a late and subsequent cloud hydration", async () => {
    const stale = {
      ...conversation("reset-discarded"),
      title: "企业知识库构建",
      status: "awaiting_input" as const,
      knowledgeBase: {
        initialized: true,
        generation: 1,
        stateEpoch: 2,
        activeTurnId: null,
        activeClientRequestId: null,
        presentationTurnId: "turn-old",
        interactionState: "awaiting_input" as const,
        canReply: true,
        presentationKey: "presentation-old",
        revision: 1,
        leafId: "1.1",
        notice: null,
      },
    };
    mocks.listRefetch.mockResolvedValue({ data: [stale] });
    const { result } = renderHook(() => useConversation(), { wrapper });
    await waitFor(() => expect(result.current.hydrated).toBe(true));

    act(() => result.current.discardConversationLocally("reset-discarded"));
    expect(result.current.state.conversations).toEqual([]);

    await act(async () => {
      await result.current.refreshConversationsAfterDiscard();
    });

    expect(result.current.state.conversations).toEqual([]);
  });

  it("retires two inactive blank KB conversations, preserves ordinary chat, and creates one fresh KB", async () => {
    const blankKbOne = {
      ...conversation("kb-old-1"),
      title: "企业知识库构建",
    };
    const blankKbTwo = {
      ...conversation("kb-old-2"),
      title: "企业知识库构建",
    };
    const ordinary = conversation("ordinary-chat");
    mocks.listRefetch.mockResolvedValueOnce({
      data: [blankKbOne, ordinary, blankKbTwo],
    });
    const { result } = renderHook(() => useConversation(), { wrapper });
    await waitFor(() => expect(result.current.hydrated).toBe(true));

    let freshConversationId = "";
    act(() => {
      result.current.discardKnowledgeBaseConversationsLocally();
      freshConversationId = result.current.createConversation({
        title: "企业知识库构建",
        reuseEmpty: false,
      });
    });

    expect(
      result.current.state.conversations.map((candidate) => candidate.id),
    ).toEqual([freshConversationId, "ordinary-chat"]);
    expect(
      result.current.state.conversations.filter(
        (candidate) => candidate.title === "企业知识库构建",
      ),
    ).toHaveLength(1);
    expect(result.current.isKnowledgeBaseConversation("kb-old-1")).toBe(false);
    expect(result.current.isKnowledgeBaseConversation("kb-old-2")).toBe(false);
  });

  it("atomically settles an unaccepted KB start without leaving task identity", async () => {
    mocks.listRefetch.mockResolvedValueOnce({
      data: [conversation("knowledge-base-start")],
    });
    const { result } = renderHook(() => useConversation(), { wrapper });
    await waitFor(() => expect(result.current.hydrated).toBe(true));

    act(() => {
      result.current.registerKnowledgeBaseConversation("knowledge-base-start");
      result.current.addMessage("knowledge-base-start", {
        id: "optimistic-start",
        role: "user",
        content: "开始构建企业知识库",
        timestamp: 1,
        knowledgeBase: {
          kind: "pending_user",
          clientRequestId: "request-start",
        },
      });
      result.current.updateStatus("knowledge-base-start", "running", {
        taskId: "stale-task",
        taskUrl: "https://tasks.example.test/stale-task",
        previousResponseId: "stale-task",
        startedAt: 10,
      });
      result.current.settleKnowledgeBaseStartFailure(
        "knowledge-base-start",
        "request-start",
      );
    });

    const settled = result.current.state.conversations.find(
      (item) => item.id === "knowledge-base-start",
    );
    expect(settled).toMatchObject({ status: "idle", messages: [] });
    expect(settled?.taskId).toBeUndefined();
    expect(settled?.taskUrl).toBeUndefined();
    expect(settled?.previousResponseId).toBeUndefined();
    expect(settled?.startedAt).toBeUndefined();
    expect(settled?.completedAt).toBeUndefined();
  });

  it("does not settle a start after the same request became server-owned", async () => {
    mocks.listRefetch.mockResolvedValueOnce({
      data: [conversation("accepted-knowledge-base-start")],
    });
    const { result } = renderHook(() => useConversation(), { wrapper });
    await waitFor(() => expect(result.current.hydrated).toBe(true));

    act(() => {
      result.current.addMessage("accepted-knowledge-base-start", {
        id: "optimistic-start",
        role: "user",
        content: "开始构建企业知识库",
        timestamp: 1,
        knowledgeBase: {
          kind: "pending_user",
          clientRequestId: "accepted-request",
        },
      });
      result.current.addMessage("accepted-knowledge-base-start", {
        id: "canonical-start",
        role: "user",
        content: "开始构建企业知识库",
        timestamp: 2,
        knowledgeBase: {
          kind: "pending_user",
          clientRequestId: "accepted-request",
          turnId: "turn-1",
          serverOwned: true,
        },
      });
      result.current.updateStatus("accepted-knowledge-base-start", "running", {
        taskId: "accepted-task",
        startedAt: 10,
      });
      result.current.settleKnowledgeBaseStartFailure(
        "accepted-knowledge-base-start",
        "accepted-request",
      );
    });

    const accepted = result.current.state.conversations.find(
      (item) => item.id === "accepted-knowledge-base-start",
    );
    expect(accepted?.status).toBe("running");
    expect(accepted?.taskId).toBe("accepted-task");
    expect(
      accepted?.messages.some(
        (message) => message.knowledgeBase?.serverOwned === true,
      ),
    ).toBe(true);
  });
});

describe("prepareConversationForCloud", () => {
  it("keeps the browser-owned ordinary dispatch envelope in the cloud snapshot", () => {
    const clean = prepareConversationForCloud({
      ...conversation("pending-general-chat"),
      executionKind: "general_chat_v2",
      messages: [
        {
          id: "msg-pending-general-chat",
          role: "user",
          content: "界面展示正文",
          timestamp: 1,
          attachments: [
            {
              id: "attachment-pending-general-chat",
              type: "image",
              name: "proof.png",
              fileId: "asset_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
            },
          ],
          generalChatDispatch: {
            schemaVersion: 1,
            kind: "pending_user",
            clientRequestId: "msg-pending-general-chat",
            providerPrompt: "精确 Provider 正文",
            localAssetIds: ["asset_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"],
            localTaskId: null,
            modelProfile: "frontmind-base",
          },
        },
      ],
    });

    expect(clean.messages[0]?.generalChatDispatch).toEqual({
      schemaVersion: 1,
      kind: "pending_user",
      clientRequestId: "msg-pending-general-chat",
      providerPrompt: "精确 Provider 正文",
      localAssetIds: ["asset_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"],
      localTaskId: null,
      modelProfile: "frontmind-base",
    });
  });

  it("excludes server-owned ordinary assistant projections from browser snapshots", () => {
    const clean = prepareConversationForCloud({
      ...conversation("server-owned-general-chat"),
      executionKind: "general_chat_v2",
      messages: [
        {
          id: "user-1",
          role: "user",
          content: "你好",
          timestamp: 1,
        },
        {
          id: "assistant-event-1",
          upstreamOutputId: "event-1",
          role: "assistant",
          content: "服务端结果",
          timestamp: 2,
          generalChat: {
            schemaVersion: 1,
            kind: "assistant_projection",
            turnId: "turn-1",
            agentTaskId: "task-1",
            providerEventId: "event-1",
            serverOwned: true,
          },
        },
      ],
    });

    expect(clean.messages.map((message) => message.id)).toEqual(["user-1"]);
    expect(clean.executionKind).toBe("general_chat_v2");
  });

  it("keeps dirty ordinary messages and deduplicates a server projection by output id", () => {
    const local: Conversation = {
      ...conversation("dirty-general-chat"),
      executionKind: "general_chat_v2",
      messages: [
        { id: "user-local", role: "user", content: "未确认", timestamp: 2 },
        {
          id: "optimistic-output",
          upstreamOutputId: "provider-event-1",
          role: "assistant",
          content: "轮询结果",
          timestamp: 3,
        },
      ],
    };
    const remote: Conversation = {
      ...conversation("dirty-general-chat"),
      messages: [
        { id: "user-remote", role: "user", content: "旧消息", timestamp: 1 },
        {
          id: "durable-output",
          upstreamOutputId: "provider-event-1",
          role: "assistant",
          content: "持久结果",
          timestamp: 3,
          generalChat: {
            schemaVersion: 1,
            kind: "assistant_projection",
            turnId: "turn-1",
            agentTaskId: "task-1",
            providerEventId: "provider-event-1",
            serverOwned: true,
          },
        },
      ],
    };

    const merged = mergeDirtyConversationHydration(local, remote);
    expect(merged.messages.map((message) => message.id)).toEqual([
      "user-local",
      "durable-output",
      "user-remote",
    ]);
    expect(merged.messages[1]?.content).toBe("持久结果");
  });

  it("self-heals reused assistant and attachment IDs before cloud sync", () => {
    const clean = prepareConversationForCloud({
      ...conversation("duplicate-output"),
      messages: [
        {
          id: "confirm-1",
          role: "user",
          content: "确认",
          timestamp: 1,
        },
        {
          id: "provider-output",
          upstreamOutputId: "provider-output",
          role: "assistant",
          content: "节点 2.3",
          timestamp: 2,
          attachments: [
            { id: "asset", type: "image", name: "one.webp", fileId: "one" },
          ],
        },
        {
          id: "confirm-2",
          role: "user",
          content: "确认",
          timestamp: 3,
        },
        {
          id: "provider-output",
          upstreamOutputId: "provider-output",
          role: "assistant",
          content: "节点 2.4",
          timestamp: 4,
          attachments: [
            { id: "asset", type: "image", name: "two.webp", fileId: "two" },
          ],
        },
      ],
    });

    expect(clean.messages.map((item) => item.id)).toEqual([
      "confirm-1",
      "provider-output",
      "confirm-2",
      "provider-output~2",
    ]);
    expect(
      clean.messages
        .flatMap((item) => item.attachments ?? [])
        .map((item) => item.id),
    ).toEqual(["asset", "asset~2"]);
  });

  it("removes browser-only payloads and keeps file metadata", () => {
    const clean = prepareConversationForCloud({
      ...conversation("one"),
      apiKeyFingerprint: "fingerprint",
      taskUrl: "https://provider.example/task/private",
      messages: [
        {
          id: "message",
          role: "assistant",
          content: "result",
          timestamp: 1,
          attachments: [
            {
              id: "file",
              type: "file",
              name: "report.pdf",
              fileId: "upstream-file",
              base64: "secret",
              blobUrl: "blob:secret",
              file: new File(["secret"], "report.pdf"),
              expiresAt: 2_592_000_001,
              expired: false,
            },
          ],
          inlineImages: [
            { src: "data:image/png;base64,secret" },
            { src: "/api/frontmind/v1/files/image" },
          ],
        },
      ],
    });

    expect(clean.apiKeyFingerprint).toBeUndefined();
    expect(clean.taskUrl).toBeUndefined();
    expect(clean.messages[0].attachments).toEqual([
      {
        id: "file",
        type: "file",
        name: "report.pdf",
        fileId: "upstream-file",
        expiresAt: 2_592_000_001,
        expired: false,
      },
    ]);
    expect(clean.messages[0].inlineImages).toEqual([
      { src: "/api/frontmind/v1/files/image" },
    ]);
  });

  it("omits server-owned KB messages and pending ghosts from browser snapshots", () => {
    const clean = prepareConversationForCloud({
      ...conversation("knowledge-base-metadata"),
      deletedMessageIds: ["presentation-1", "ordinary-deleted"],
      messages: [
        {
          id: "presentation-1",
          role: "assistant",
          content: "## 1.2\n已批准正文",
          timestamp: 10,
          knowledgeBase: {
            kind: "presentation",
            turnId: "turn-1",
            presentationKey: "presentation-1",
            generation: 1,
            revision: 1,
            leafId: "1.2",
            serverOwned: true,
          },
        },
        {
          id: "pending-without-turn",
          role: "user",
          content: "确认",
          timestamp: 11,
          knowledgeBase: {
            kind: "pending_user",
            clientRequestId: "request-without-turn",
            serverOwned: false,
          },
        },
        {
          id: "ordinary-browser-message",
          role: "user",
          content: "普通消息",
          timestamp: 12,
        },
      ],
    });

    expect(clean.messages.map((message) => message.id)).toEqual([
      "ordinary-browser-message",
    ]);
    expect(clean.deletedMessageIds).toEqual(["ordinary-deleted"]);
  });
});

describe("parseOutputMessages file IDs", () => {
  it("uses the canonical durable message identity, time, sequence, and projection metadata", () => {
    const generalChat = {
      schemaVersion: 1 as const,
      kind: "assistant_projection" as const,
      turnId: "turn-1",
      agentTaskId: "task-1",
      providerEventId: "provider-event-1",
      serverOwned: true as const,
    };
    const messages = parseOutputMessages([
      {
        id: "event-row-1",
        message_id: "canonical-message-1",
        sent_at_ms: 1_725_000_000_123,
        server_sequence: 9,
        general_chat: generalChat,
        role: "assistant",
        type: "message",
        content: [{ type: "output_text", text: "稳定正文" }],
      },
    ]);

    expect(messages).toEqual([
      expect.objectContaining({
        id: "canonical-message-1",
        upstreamOutputId: "event-row-1",
        timestamp: 1_725_000_000_123,
        serverSequence: 9,
        generalChat,
      }),
    ]);
  });

  it.each([
    {
      type: "output_message",
      content: [{ type: "output_text", text: "output_message 正文" }],
      expected: "output_message 正文",
    },
    {
      type: "output_text",
      text: "top-level text 正文",
      expected: "top-level text 正文",
    },
    {
      type: "text",
      output_text: { value: "top-level output_text 正文" },
      expected: "top-level output_text 正文",
    },
    {
      type: "output_message",
      content: [
        {
          type: "output_text",
          output_text: { value: "nested output_text 正文" },
        },
      ],
      expected: "nested output_text 正文",
    },
  ])("renders typed assistant $type records as messages", (record) => {
    const messages = parseOutputMessages([
      {
        id: `assistant-${record.type}`,
        role: "assistant",
        ...record,
      },
    ]);

    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({
      upstreamOutputId: `assistant-${record.type}`,
      role: "assistant",
      content: record.expected,
    });
  });

  it("renders snake-case PDF and camel-case image IDs through protected URLs", () => {
    const messages = parseOutputMessages([
      {
        id: "assistant-files",
        type: "message",
        role: "assistant",
        content: [
          {
            type: "output_file",
            file_id: "file/pdf 1",
            file_name: "report.pdf",
            mime_type: "application/pdf",
          },
          {
            type: "output_image",
            fileId: "image/图 1",
            fileName: "chart.png",
            mimeType: "image/png",
          },
        ],
      },
    ]);

    expect(messages).toHaveLength(1);
    expect(messages[0].outputFiles).toEqual([
      {
        fileUrl: "/api/frontmind/v1/files/file%2Fpdf%201",
        fileName: "report.pdf",
        mimeType: "application/pdf",
      },
    ]);
    expect(messages[0].inlineImages).toEqual([
      {
        src: "/api/frontmind/v1/files/image%2F%E5%9B%BE%201",
        alt: "chart.png",
      },
    ]);
  });

  it("renders image_url content and top-level output images without MIME metadata", () => {
    const messages = parseOutputMessages([
      {
        id: "assistant-image-url",
        type: "message",
        role: "assistant",
        content: [
          {
            type: "output_image",
            image_url: "https://files.example.test/leaf-hero.webp",
            filename: "leaf-hero.webp",
          },
        ],
      },
      {
        id: "standalone-image",
        type: "output_image",
        imageUrl: "/v1/files/asset%202",
        name: "asset-2.png",
      },
    ]);

    expect(messages).toHaveLength(2);
    expect(messages[0]).toMatchObject({
      upstreamOutputId: "assistant-image-url",
      inlineImages: [
        {
          src: expect.stringContaining("/api/frontmind/proxy-download?url="),
          alt: "leaf-hero.webp",
        },
      ],
    });
    expect(messages[1]).toMatchObject({
      upstreamOutputId: "standalone-image",
      inlineImages: [
        {
          src: "/api/frontmind/v1/files/asset%202",
          alt: "asset-2.png",
        },
      ],
    });
  });
});

describe("knowledge-base image delivery boundary", () => {
  const blockedHotlink =
    "https://omo-oss-image.thefastimg.com/portal-saas/example/cms/image/example.jpg";

  it("replaces only the retired collection-status sentence", () => {
    expect(
      sanitizeKnowledgeBaseCustomerMarkdown(
        "FrontMind 正在按业务分支进行广度优先、深度受控的资料采集。此阶段无需逐项确认，完成后将直接生成可核验知识库。\n\n正文保留广度与深度。",
      ),
    ).toBe(
      "FrontMind 正在按业务分支进行资料采集。此阶段无需逐项确认，完成后将直接生成可核验知识库。\n\n正文保留广度与深度。",
    );
  });

  it("removes remote hotlinks from customer markdown while retaining the caption", () => {
    expect(
      sanitizeKnowledgeBaseCustomerMarkdown(
        `产品如下：\n\n![产品界面](${blockedHotlink})\n\n原图：${blockedHotlink}`,
      ),
    ).toBe("产品如下：\n\n配图：产品界面\n\n原图：");
  });

  it("shows only the node body when the model appends references and protocol data", () => {
    expect(
      sanitizeKnowledgeBaseCustomerMarkdown(
        [
          "## 中文名称、英文品牌与视觉识别",
          "",
          "硅基流动的英文品牌名称为 SiliconFlow。",
          "",
          "**参考资料**",
          "[1] https://siliconflow.cn/",
          '<!-- FRONTMIND_KB_PROGRESS {"revision":0} -->',
        ].join("\n"),
      ),
    ).toBe(
      [
        "## 中文名称、英文品牌与视觉识别",
        "",
        "硅基流动的英文品牌名称为 SiliconFlow。",
      ].join("\n"),
    );
  });

  it("removes bare knowledge-base protocol objects from customer markdown", () => {
    expect(
      sanitizeKnowledgeBaseCustomerMarkdown(
        [
          "## 企业定位",
          "",
          "硅基流动是 AI 基础设施平台。",
          "",
          JSON.stringify({
            kind: "frontmind.knowledge-base.presentation",
            revision: 1,
            leafId: "1.1",
          }),
          JSON.stringify({
            kind: "frontmind.workflow-state",
            currentLeafId: "1.1",
          }),
        ].join("\n"),
      ),
    ).toBe("## 企业定位\n\n硅基流动是 AI 基础设施平台。");
  });

  it("keeps only controlled image sources in knowledge-base messages", () => {
    const [message] = sanitizeKnowledgeBaseOutputMessages([
      {
        id: "knowledge-images",
        role: "assistant",
        content: `![官网热链](${blockedHotlink})`,
        timestamp: 1,
        inlineImages: [
          { src: blockedHotlink, alt: "hotlink" },
          {
            src: "/api/frontmind/v1/files/image-id",
            alt: "managed output",
          },
          {
            src: "/api/dashboard/knowledge/assets/snapshot/logo.webp",
            alt: "packaged asset",
          },
        ],
      },
    ]);

    expect(message.content).toBe("配图：官网热链");
    expect(message.inlineImages).toEqual([
      {
        src: "/api/frontmind/v1/files/image-id",
        alt: "managed output",
      },
      {
        src: "/api/dashboard/knowledge/assets/snapshot/logo.webp",
        alt: "packaged asset",
      },
    ]);
  });
});
