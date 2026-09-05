import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getResumePollDelay, useResumePolling } from "./useResumePolling";

const mocks = vi.hoisted(() => ({
  hydrated: false,
  conversations: [] as any[],
  retrieveTask: vi.fn(),
  fetchKnowledgeBaseProgress: vi.fn(),
  projectTaskOutputMessages: vi.fn(),
  updateStatus: vi.fn(),
  updateAssistantMessages: vi.fn(),
  addMessage: vi.fn(),
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
