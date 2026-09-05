import { act, renderHook } from "@testing-library/react";
import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { toast } from "sonner";
import {
  GENERAL_CHAT_PARTIAL_RESULT_MESSAGE,
  ORDINARY_TERMINAL_REPROBE_WINDOW_MS,
  getResumePollDelay,
  useResumePolling,
} from "./useResumePolling";
import {
  GENERAL_CHAT_PARTIAL_RESULT_ERROR_CODE,
  generalChatTerminalMessagePublicId,
} from "@shared/frontmind-general-chat-terminal";

const mocks = vi.hoisted(() => ({
  hydrated: false,
  conversations: [] as any[],
  retrieveTask: vi.fn(),
  fetchKnowledgeBaseProgress: vi.fn(),
  projectTaskOutputMessages: vi.fn(),
  updateStatus: vi.fn(),
  updateAssistantMessages: vi.fn(),
  addMessage: vi.fn(),
  deleteMessage: vi.fn(),
  isKnowledgeBaseConversation: vi.fn(),
  registerKnowledgeBaseConversation: vi.fn(),
  wakeKnowledgeBaseConversation: vi.fn(),
}));

vi.mock("@/contexts/ConversationContext", () => ({
  useConversation: () => ({
    hydrated: mocks.hydrated,
    state: { conversations: mocks.conversations },
    updateStatus: mocks.updateStatus,
    updateAssistantMessages: mocks.updateAssistantMessages,
    addMessage: mocks.addMessage,
    deleteMessage: mocks.deleteMessage,
    isKnowledgeBaseConversation: mocks.isKnowledgeBaseConversation,
    registerKnowledgeBaseConversation: mocks.registerKnowledgeBaseConversation,
    wakeKnowledgeBaseConversation: mocks.wakeKnowledgeBaseConversation,
  }),
}));

vi.mock("@/lib/frontmind-api", () => ({
  retrieveTask: mocks.retrieveTask,
  creditEventBus: { emit: vi.fn() },
}));

vi.mock("@/lib/knowledge-progress", () => ({
  fetchKnowledgeBaseProgress: mocks.fetchKnowledgeBaseProgress,
}));

vi.mock("@/lib/task-output-projection", () => ({
  collectAssistantOutputIds: () => [],
  projectTaskOutputMessages: mocks.projectTaskOutputMessages,
}));

describe("useResumePolling ordinary-task boundary", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    mocks.hydrated = false;
    mocks.conversations = [
      {
        id: "ordinary",
        title: "Ordinary",
        messages: [],
        status: "running",
        taskId: "task-1",
        createdAt: 1,
        updatedAt: 1,
      },
    ];
    mocks.isKnowledgeBaseConversation.mockReturnValue(false);
    mocks.fetchKnowledgeBaseProgress.mockResolvedValue(null);
    mocks.retrieveTask.mockResolvedValue({
      id: "task-1",
      status: "running",
      output: [],
    });
    mocks.projectTaskOutputMessages.mockReturnValue([]);
  });

  afterEach(() => vi.useRealTimers());

  it("uses bounded recovery backoff", () => {
    expect(getResumePollDelay(0)).toBe(4_000);
    expect(getResumePollDelay(5 * 60 * 1000)).toBe(10_000);
    expect(getResumePollDelay(30 * 60 * 1000)).toBe(30_000);
  });

  it("derives the same terminal public ID as server-side SHA-256", () => {
    const input = {
      conversationId: "conversation-中文",
      taskId: "task-1",
      errorCode: GENERAL_CHAT_PARTIAL_RESULT_ERROR_CODE,
    };
    const digest = createHash("sha256")
      .update(
        `${input.conversationId}\0${input.taskId}\0${input.errorCode}`,
        "utf8",
      )
      .digest("hex")
      .slice(0, 32);
    expect(generalChatTerminalMessagePublicId(input)).toBe(
      `msg-general-chat-terminal-${digest}`,
    );
  });

  it("does not inspect a task before cloud hydration", async () => {
    const { rerender } = renderHook(() => useResumePolling());
    await act(() => vi.advanceTimersByTimeAsync(2_000));
    expect(mocks.retrieveTask).not.toHaveBeenCalled();

    mocks.hydrated = true;
    rerender();
    await act(() => vi.advanceTimersByTimeAsync(1_000));
    expect(mocks.retrieveTask).toHaveBeenCalledWith("task-1");
  });

  it("keeps ordinary chat raw-output projection intact", async () => {
    mocks.hydrated = true;
    mocks.retrieveTask.mockResolvedValue({
      id: "task-1",
      status: "completed",
      output: [{ id: "answer", type: "message" }],
    });
    mocks.projectTaskOutputMessages.mockReturnValue([
      {
        id: "answer",
        role: "assistant",
        content: "普通对话结果",
        timestamp: 2,
      },
    ]);

    renderHook(() => useResumePolling());
    await act(() => vi.advanceTimersByTimeAsync(1_000));

    expect(mocks.projectTaskOutputMessages).toHaveBeenCalledWith(
      expect.objectContaining({ knowledgeBase: false }),
    );
    expect(mocks.updateAssistantMessages).toHaveBeenCalledWith(
      "ordinary",
      expect.arrayContaining([
        expect.objectContaining({ content: "普通对话结果" }),
      ]),
    );
  });

  it("never probes knowledge-base progress for a known general-chat v2 conversation", async () => {
    mocks.hydrated = true;
    mocks.conversations[0] = {
      ...mocks.conversations[0],
      executionKind: "general_chat_v2",
    };

    renderHook(() => useResumePolling());
    await act(() => vi.advanceTimersByTimeAsync(1_000));

    expect(mocks.fetchKnowledgeBaseProgress).not.toHaveBeenCalled();
    expect(mocks.retrieveTask).toHaveBeenCalledWith("task-1");
  });

  it("performs the legacy identity compatibility probe only once after a negative result", async () => {
    mocks.hydrated = true;

    renderHook(() => useResumePolling());
    await act(() => vi.advanceTimersByTimeAsync(1_000));
    await act(() => vi.advanceTimersByTimeAsync(30_000));

    expect(mocks.retrieveTask).toHaveBeenCalledTimes(2);
    expect(mocks.fetchKnowledgeBaseProgress).toHaveBeenCalledTimes(1);
  });

  it("applies an empty authoritative projection so an ambiguous current turn is hidden", async () => {
    mocks.hydrated = true;
    mocks.conversations[0] = {
      ...mocks.conversations[0],
      messages: [
        { id: "user", role: "user", content: "当前轮", timestamp: 1 },
        {
          id: "stale-projection",
          role: "assistant",
          content: "待重新归属",
          timestamp: 2,
        },
      ],
    };
    mocks.retrieveTask.mockResolvedValue({
      id: "task-1",
      status: "running",
      output: [],
    });
    mocks.projectTaskOutputMessages.mockReturnValue([]);

    renderHook(() => useResumePolling());
    await act(() => vi.advanceTimersByTimeAsync(1_000));

    expect(mocks.projectTaskOutputMessages).toHaveBeenCalledWith(
      expect.objectContaining({ output: [] }),
    );
    expect(mocks.updateAssistantMessages).toHaveBeenCalledWith("ordinary", []);
  });

  it("keeps partial output and emits one deterministic notice across focus polling", async () => {
    mocks.hydrated = true;
    mocks.retrieveTask.mockResolvedValue({
      id: "task-1",
      status: "error",
      output: [{ id: "partial-answer", type: "message" }],
      error: {
        code: "PROVIDER_ERROR",
        message: "上游未完整结束",
        partialResult: true,
      },
    });
    mocks.projectTaskOutputMessages.mockReturnValue([
      {
        id: "partial-answer",
        role: "assistant",
        content: "已生成的结果",
        timestamp: 2,
      },
    ]);

    renderHook(() => useResumePolling());
    await act(() => vi.advanceTimersByTimeAsync(1_000));
    await act(async () => window.dispatchEvent(new Event("focus")));

    const expectedId = generalChatTerminalMessagePublicId({
      conversationId: "ordinary",
      taskId: "task-1",
      errorCode: GENERAL_CHAT_PARTIAL_RESULT_ERROR_CODE,
    });
    expect(mocks.updateAssistantMessages).toHaveBeenCalledWith(
      "ordinary",
      expect.arrayContaining([
        expect.objectContaining({ content: "已生成的结果" }),
      ]),
    );
    expect(
      mocks.addMessage.mock.calls.filter(
        ([, message]) => message.id === expectedId,
      ),
    ).toEqual([
      [
        "ordinary",
        expect.objectContaining({
          id: expectedId,
          content: GENERAL_CHAT_PARTIAL_RESULT_MESSAGE,
        }),
      ],
    ]);
    expect(toast.warning).toHaveBeenCalledTimes(1);
  });

  it("does not recreate a hydrated deterministic terminal notice", async () => {
    mocks.hydrated = true;
    const terminalId = generalChatTerminalMessagePublicId({
      conversationId: "ordinary",
      taskId: "task-1",
      errorCode: GENERAL_CHAT_PARTIAL_RESULT_ERROR_CODE,
    });
    mocks.conversations[0] = {
      ...mocks.conversations[0],
      messages: [
        {
          id: terminalId,
          role: "assistant",
          content: GENERAL_CHAT_PARTIAL_RESULT_MESSAGE,
          timestamp: 1,
        },
      ],
    };
    mocks.retrieveTask.mockResolvedValue({
      id: "task-1",
      status: "error",
      output: [{ id: "partial-answer", type: "message" }],
      error: { partialResult: true },
    });

    renderHook(() => useResumePolling());
    await act(() => vi.advanceTimersByTimeAsync(1_000));

    expect(mocks.addMessage).not.toHaveBeenCalled();
  });

  it("keeps the sole GET owner alive when partial error later settles completed", async () => {
    mocks.hydrated = true;
    const startedAt = Date.now();
    mocks.conversations[0] = {
      ...mocks.conversations[0],
      startedAt,
      createdAt: startedAt,
    };
    const terminalId = generalChatTerminalMessagePublicId({
      conversationId: "ordinary",
      taskId: "task-1",
      errorCode: GENERAL_CHAT_PARTIAL_RESULT_ERROR_CODE,
    });
    mocks.retrieveTask
      .mockResolvedValueOnce({
        id: "task-1",
        status: "error",
        output: [{ id: "partial-answer", type: "message" }],
        error: {
          code: "PROVIDER_ERROR",
          message: "上游终态仍在收敛",
          partialResult: true,
        },
      })
      .mockResolvedValueOnce({
        id: "task-1",
        status: "completed",
        output: [{ id: "partial-answer", type: "message" }],
      });

    const { rerender } = renderHook(() => useResumePolling());
    await act(() => vi.advanceTimersByTimeAsync(1_000));
    const firstTerminalAt = mocks.updateStatus.mock.calls.find(
      ([, status]) => status === "error",
    )?.[2]?.completedAt;
    expect(firstTerminalAt).toEqual(expect.any(Number));
    mocks.conversations[0] = {
      ...mocks.conversations[0],
      status: "error",
      completedAt: firstTerminalAt,
      messages: [
        {
          id: terminalId,
          role: "assistant",
          content: GENERAL_CHAT_PARTIAL_RESULT_MESSAGE,
          timestamp: firstTerminalAt,
        },
      ],
    };
    rerender();

    await act(() => vi.advanceTimersByTimeAsync(4_000));

    expect(mocks.retrieveTask).toHaveBeenCalledTimes(2);
    expect(mocks.updateStatus).toHaveBeenCalledWith(
      "ordinary",
      "completed",
      expect.objectContaining({ lastKnownOutputLength: 1 }),
    );
    expect(mocks.deleteMessage).toHaveBeenCalledWith("ordinary", terminalId);
    expect(toast.warning).toHaveBeenCalledTimes(1);
  });

  it("rehydrates a recent terminal task for one bounded recovery probe", async () => {
    mocks.hydrated = true;
    const terminalId = generalChatTerminalMessagePublicId({
      conversationId: "ordinary",
      taskId: "task-1",
      errorCode: GENERAL_CHAT_PARTIAL_RESULT_ERROR_CODE,
    });
    mocks.conversations[0] = {
      ...mocks.conversations[0],
      status: "error",
      completedAt: Date.now() - 1_000,
      messages: [
        {
          id: terminalId,
          role: "assistant",
          content: GENERAL_CHAT_PARTIAL_RESULT_MESSAGE,
          timestamp: Date.now() - 1_000,
        },
      ],
    };
    mocks.retrieveTask.mockResolvedValue({
      id: "task-1",
      status: "completed",
      output: [{ id: "answer", type: "message" }],
    });

    renderHook(() => useResumePolling());
    await act(() => vi.advanceTimersByTimeAsync(1_000));

    expect(mocks.retrieveTask).toHaveBeenCalledTimes(1);
    expect(mocks.deleteMessage).toHaveBeenCalledWith("ordinary", terminalId);
  });

  it("does not re-probe terminal tasks after the bounded window", async () => {
    mocks.hydrated = true;
    mocks.conversations[0] = {
      ...mocks.conversations[0],
      status: "error",
      completedAt: Date.now() - ORDINARY_TERMINAL_REPROBE_WINDOW_MS,
    };

    renderHook(() => useResumePolling());
    await act(() => vi.advanceTimersByTimeAsync(10_000));

    expect(mocks.retrieveTask).not.toHaveBeenCalled();
  });

  it("does not start a second request when focus fires during an active poll", async () => {
    mocks.hydrated = true;
    let resolveTask!: (value: any) => void;
    mocks.retrieveTask.mockReturnValue(
      new Promise((resolve) => {
        resolveTask = resolve;
      }),
    );

    renderHook(() => useResumePolling());
    act(() => vi.advanceTimersByTime(1_000));
    await Promise.resolve();
    await act(async () => window.dispatchEvent(new Event("focus")));
    expect(mocks.retrieveTask).toHaveBeenCalledTimes(1);
    await act(async () => {
      resolveTask({ id: "task-1", status: "running", output: [] });
      await Promise.resolve();
    });
  });

  it("never sends a persisted response-logic task to the ordinary task API", async () => {
    mocks.hydrated = true;
    mocks.conversations[0] = {
      ...mocks.conversations[0],
      executionKind: "response_logic",
      taskId: "provider-response-logic-task",
      previousResponseId: "provider-response-logic-task",
      status: "running",
    };

    renderHook(() => useResumePolling());
    await act(() => vi.advanceTimersByTimeAsync(10_000));

    expect(mocks.retrieveTask).not.toHaveBeenCalled();
    expect(mocks.fetchKnowledgeBaseProgress).not.toHaveBeenCalled();
    expect(mocks.updateStatus).not.toHaveBeenCalledWith(
      "ordinary",
      "error",
      expect.anything(),
    );
  });

  it("hands a discovered knowledge build to the coordinator without retrieving raw output", async () => {
    mocks.hydrated = true;
    mocks.conversations[0] = {
      ...mocks.conversations[0],
      id: "kb-conversation",
      taskId: "kb-task",
    };
    mocks.fetchKnowledgeBaseProgress.mockResolvedValue({
      build: { id: "build", conversationId: "kb-conversation" },
    });

    renderHook(() => useResumePolling());
    await act(() => vi.advanceTimersByTimeAsync(1_000));

    expect(mocks.registerKnowledgeBaseConversation).toHaveBeenCalledWith(
      "kb-conversation",
    );
    expect(mocks.wakeKnowledgeBaseConversation).toHaveBeenCalledWith(
      "kb-conversation",
    );
    expect(mocks.retrieveTask).not.toHaveBeenCalled();
    expect(mocks.projectTaskOutputMessages).not.toHaveBeenCalled();
  });

  it("hands an already registered knowledge build off before any identity probe", async () => {
    mocks.hydrated = true;
    mocks.isKnowledgeBaseConversation.mockReturnValue(true);

    renderHook(() => useResumePolling());
    await act(() => vi.advanceTimersByTimeAsync(1_000));

    expect(mocks.wakeKnowledgeBaseConversation).toHaveBeenCalledWith(
      "ordinary",
    );
    expect(mocks.fetchKnowledgeBaseProgress).not.toHaveBeenCalled();
    expect(mocks.retrieveTask).not.toHaveBeenCalled();
  });
});
