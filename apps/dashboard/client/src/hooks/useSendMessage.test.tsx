import { describe, it, expect, beforeEach, vi } from "vitest";
import { renderHook, act, waitFor } from "@testing-library/react";
import { toast } from "sonner";
import {
  GENERAL_CHAT_PARTIAL_RESULT_ERROR_CODE,
  GENERAL_CHAT_PARTIAL_RESULT_MESSAGE,
  generalChatTerminalMessagePublicId,
} from "@shared/frontmind-general-chat-terminal";
import {
  useSendMessage,
  classifyFailure,
  outputForKnowledgePresentation,
  readResponseLogicTaskStartFailure,
  responseLogicStartFailureMessage,
  sliceNewOutput,
} from "../hooks/useSendMessage";

const mocks = vi.hoisted(() => ({
  createTask: vi.fn(),
  createKnowledgeBaseTurnTask: vi.fn(),
  reserveKnowledgeBaseTurnWithAttachments: vi.fn(),
  stageKnowledgeBaseTurnAttachment: vi.fn(),
  createResponseLogicTask: vi.fn(),
  retrieveTask: vi.fn(),
  reconcileKnowledgeBaseProgress: vi.fn(),
  uploadChatLocalAsset: vi.fn(),
  providerV1UploadFile: vi.fn(),
  uploadFile: vi.fn(),
  fileToBase64: vi.fn(),
  creditEmit: vi.fn(),
  addMessage: vi.fn(),
  settleGeneralChatDispatch: vi.fn(),
  updateStatus: vi.fn(),
  updateAssistantMessages: vi.fn(),
  updateTitle: vi.fn(),
  createConversation: vi.fn(),
  registerKnowledgeBaseConversation: vi.fn(),
  wakeKnowledgeBaseConversation: vi.fn(),
  commitKnowledgeBaseObservation: vi.fn(),
  rollbackPendingKnowledgeBaseTurn: vi.fn(),
  flushConversation: vi.fn(),
  parseOutputMessages: vi.fn(),
  sanitizeKnowledgeBaseOutputMessages: vi.fn((messages: any[]) => messages),
  useConversation: vi.fn(),
  prepareUploadFiles: vi.fn(),
  isImageUpload: vi.fn(),
  normalizedKnowledgeBaseUploadFilename: vi.fn(),
  normalizedKnowledgeBaseUploadMimeType: vi.fn(),
  sha256UploadFile: vi.fn(),
  assertChatAttachmentSizes: vi.fn(),
  requireCurrentFrontMindBuild: vi.fn(),
}));

vi.mock("@/lib/frontmind-api", () => ({
  RESPONSE_LOGIC_RESET_REQUIRED_MESSAGE_ID_PREFIX:
    "msg-response-logic-reset-required-",
  createTask: mocks.createTask,
  createKnowledgeBaseTurnTask: mocks.createKnowledgeBaseTurnTask,
  reserveKnowledgeBaseTurnWithAttachments:
    mocks.reserveKnowledgeBaseTurnWithAttachments,
  stageKnowledgeBaseTurnAttachment: mocks.stageKnowledgeBaseTurnAttachment,
  createResponseLogicTask: mocks.createResponseLogicTask,
  retrieveTask: mocks.retrieveTask,
  uploadChatLocalAsset: mocks.uploadChatLocalAsset,
  uploadKnowledgeBaseLocalAsset: mocks.uploadFile,
  uploadFile: mocks.providerV1UploadFile,
  fileToBase64: mocks.fileToBase64,
  creditEventBus: {
    emit: mocks.creditEmit,
  },
  sanitizeBrandText: (value: string) => value.replace(/Manus/gi, "FrontMind"),
  buildPromptText: (input: any[]) =>
    input
      .flatMap((message) =>
        typeof message.content === "string"
          ? [message.content]
          : message.content.flatMap((item: any) =>
              item.type === "input_text" && item.text ? [item.text] : [],
            ),
      )
      .join("\n"),
}));

vi.mock("@/lib/attachment-files", () => ({
  prepareUploadFiles: mocks.prepareUploadFiles,
  isImageUpload: mocks.isImageUpload,
  normalizedKnowledgeBaseUploadFilename:
    mocks.normalizedKnowledgeBaseUploadFilename,
  normalizedKnowledgeBaseUploadMimeType:
    mocks.normalizedKnowledgeBaseUploadMimeType,
  sha256UploadFile: mocks.sha256UploadFile,
  assertChatAttachmentSizes: mocks.assertChatAttachmentSizes,
  ZIP_REFERENCE_PROMPT:
    "附件 ZIP 中包含用户上传的原始参考图片，请解压后读取图片内容作为参考。",
}));

vi.mock("@/contexts/ConversationContext", () => ({
  useConversation: mocks.useConversation,
  parseOutputMessages: mocks.parseOutputMessages,
  sanitizeKnowledgeBaseOutputMessages:
    mocks.sanitizeKnowledgeBaseOutputMessages,
}));

vi.mock("@/lib/knowledge-progress", () => ({
  reconcileKnowledgeBaseProgress: mocks.reconcileKnowledgeBaseProgress,
}));

vi.mock("@/lib/build-version", () => ({
  requireCurrentFrontMindBuild: mocks.requireCurrentFrontMindBuild,
}));

function mockConversationContext(overrides = {}) {
  return {
    state: { conversations: [] },
    activeConversation: null,
    addMessage: mocks.addMessage,
    settleGeneralChatDispatch: mocks.settleGeneralChatDispatch,
    updateStatus: mocks.updateStatus,
    updateAssistantMessages: mocks.updateAssistantMessages,
    updateTitle: mocks.updateTitle,
    createConversation: mocks.createConversation,
    registerKnowledgeBaseConversation: mocks.registerKnowledgeBaseConversation,
    wakeKnowledgeBaseConversation: mocks.wakeKnowledgeBaseConversation,
    commitKnowledgeBaseObservation: mocks.commitKnowledgeBaseObservation,
    rollbackPendingKnowledgeBaseTurn: mocks.rollbackPendingKnowledgeBaseTurn,
    flushConversation: mocks.flushConversation,
    ...overrides,
  };
}

function mockPreparedFiles(files: File[], didZipLargeImages = false) {
  mocks.prepareUploadFiles.mockResolvedValue({
    files: files.map((file) => ({ file })),
    didZipLargeImages,
    zippedImages: didZipLargeImages
      ? [
          {
            name: "large.png",
            width: 12000,
            height: 3000,
            pixels: 36_000_000,
            size: 1024,
          },
        ]
      : [],
  });
}

describe("sliceNewOutput", () => {
  const output = (id: string) => ({
    id,
    type: "message",
    role: "assistant" as const,
    content: [{ type: "output_text", text: id }],
  });

  it("slices a cumulative 5 → 6 response by its stable historical prefix", () => {
    const historicalIds = ["old-1", "old-2", "old-3", "old-4", "old-5"];
    const result = sliceNewOutput(
      [...historicalIds.map(output), output("new-1")],
      5,
      historicalIds,
    );

    expect(result.map((item) => item.id)).toEqual(["new-1"]);
  });

  it("keeps a non-cumulative 5 → 1 current-turn response", () => {
    const historicalIds = ["old-1", "old-2", "old-3", "old-4", "old-5"];
    const result = sliceNewOutput([output("new-1")], 5, historicalIds);

    expect(result.map((item) => item.id)).toEqual(["new-1"]);
  });

  it("deduplicates repeated items by stable output ID", () => {
    const result = sliceNewOutput([output("new-1"), output("new-1")], 5, [
      "old-1",
    ]);

    expect(result.map((item) => item.id)).toEqual(["new-1"]);
  });
});

describe("outputForKnowledgePresentation", () => {
  it("recovers the latest protocol turn when stable output IDs are reused", () => {
    const old = {
      id: "reused-output",
      type: "message",
      role: "assistant" as const,
      content: [
        {
          type: "output_text",
          text: '节点 2.3\n<!-- FRONTMIND_KB_PRESENTATION {"kind":"frontmind.knowledge-base.presentation","schemaVersion":1,"revision":3,"leafId":"2.3"} -->',
        },
      ],
    };
    const current = {
      ...old,
      content: [
        {
          type: "output_text",
          text: '节点 2.4\n<!-- FRONTMIND_KB_PRESENTATION {"kind":"frontmind.knowledge-base.presentation","schemaVersion":1,"revision":4,"leafId":"2.4"} -->',
        },
      ],
    };
    const image = {
      id: "leaf-image",
      type: "output_image",
      image_url: "/v1/files/leaf-image",
    };

    expect(
      outputForKnowledgePresentation([old, current, image], [], {
        revision: 4,
        leafId: "2.4",
      }),
    ).toEqual([current]);
  });
});

describe("useSendMessage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.createTask.mockResolvedValue({
      id: "test-task-id",
      status: "completed",
      output: [],
    });
    mocks.sha256UploadFile.mockImplementation(async (file: File) =>
      file.name === "facts.pdf" ? "a".repeat(64) : "b".repeat(64),
    );
    mocks.assertChatAttachmentSizes.mockImplementation(() => undefined);
    mocks.requireCurrentFrontMindBuild.mockResolvedValue(true);
    mocks.createKnowledgeBaseTurnTask.mockResolvedValue({
      id: "test-kb-task-id",
      status: "running",
      output: [],
      knowledgeInteraction: {
        interactionState: "executing",
        canReply: false,
        canPublish: false,
        lockReason: "任务仍在执行",
      },
    });
    mocks.stageKnowledgeBaseTurnAttachment.mockResolvedValue({
      reservation: { stagedAttachmentCount: 1 },
    });
    mocks.reserveKnowledgeBaseTurnWithAttachments.mockImplementation(
      async (_input: unknown, context: any) => ({
        reservation: {
          state: "awaiting_attachments",
          turnId: "reserved-turn-1",
          clientRequestId: context.clientRequestId,
          sourceResetRevision: context.expectedResetRevision,
          generation: context.expectedGeneration,
          revision: context.expectedRevision,
          leafId: context.expectedLeafId,
          stagedAttachmentCount: 0,
          expectedAttachmentCount: context.attachmentManifest.length,
          requiresUpload: true,
        },
      }),
    );
    mocks.retrieveTask.mockResolvedValue({
      id: "test-task-id",
      status: "completed",
      output: [],
    });
    mocks.reconcileKnowledgeBaseProgress.mockResolvedValue({
      progress: null,
      interactionState: "executing",
      canReply: false,
      canPublish: false,
      lockReason: "任务仍在执行",
    });
    mocks.uploadFile.mockImplementation(async (file: File) => ({
      fileId: `file-${file.name}`,
      filename: file.name,
      uploadedAt: 1_000,
      expiresAt: 2_593_000_000,
    }));
    mocks.uploadChatLocalAsset.mockImplementation(async (file: File) => ({
      fileId: `asset_${file.name.replace(/[^a-z0-9]/gi, "").slice(0, 30)}`,
      filename: file.name,
      expiresAt: 2_593_000_000,
    }));
    mocks.fileToBase64.mockResolvedValue("data:text/plain;base64,dGVzdA==");
    mocks.isImageUpload.mockReturnValue(false);
    mocks.normalizedKnowledgeBaseUploadFilename.mockImplementation(
      (filename: string) => filename,
    );
    mocks.normalizedKnowledgeBaseUploadMimeType.mockImplementation(
      (file: File) => file.type || "application/octet-stream",
    );
    mocks.createConversation.mockReturnValue("test-conv-id");
    mocks.flushConversation.mockResolvedValue(true);
    mocks.parseOutputMessages.mockReturnValue([]);
    mocks.useConversation.mockReturnValue(mockConversationContext());
    mocks.prepareUploadFiles.mockImplementation(async (files: File[]) => ({
      files: files.map((file) => ({ file })),
      didZipLargeImages: false,
      zippedImages: [],
    }));
  });

  it("should return sendMessage function", () => {
    const { result } = renderHook(() => useSendMessage());
    expect(typeof result.current.sendMessage).toBe("function");
  });

  it("should return stopPolling function", () => {
    const { result } = renderHook(() => useSendMessage());
    expect(typeof result.current.stopPolling).toBe("function");
  });

  it("should return retry state", () => {
    const { result } = renderHook(() => useSendMessage());
    expect(result.current.isRetrying).toBe(false);
    expect(result.current.retryCount).toBe(0);
  });

  it("should return uploadProgress as null initially", () => {
    const { result } = renderHook(() => useSendMessage());
    expect(result.current.uploadProgress).toBeNull();
  });

  it("hands a running ordinary task to the global poll owner without retrieving locally", async () => {
    vi.useFakeTimers();
    try {
      mocks.createTask.mockResolvedValueOnce({
        id: "running-task",
        status: "running",
        output: [],
      });
      const { result, unmount } = renderHook(() => useSendMessage());

      await act(async () => {
        await result.current.sendMessage("继续处理", []);
        await vi.advanceTimersByTimeAsync(60_000);
      });

      expect(mocks.updateStatus).toHaveBeenCalledWith(
        "test-conv-id",
        "running",
        expect.objectContaining({ taskId: "running-task" }),
      );
      expect(mocks.retrieveTask).not.toHaveBeenCalled();
      unmount();
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps immediate partial output and emits one deterministic terminal notice", async () => {
    mocks.createTask.mockResolvedValue({
      id: "partial-task",
      status: "error",
      output: [
        {
          id: "partial-output",
          type: "message",
          role: "assistant",
          content: [{ type: "output_text", text: "已生成的部分结果" }],
        },
      ],
      error: {
        code: "PROVIDER_ERROR",
        message: "任务未完整结束",
        partialResult: true,
      },
    });
    mocks.parseOutputMessages.mockReturnValue([
      {
        id: "partial-output",
        role: "assistant",
        content: "已生成的部分结果",
        timestamp: 2,
      },
    ]);
    const { result } = renderHook(() => useSendMessage());

    await act(async () => {
      await result.current.sendMessage("生成图片", []);
      await result.current.sendMessage("再次读取同一终态", []);
    });

    const expectedId = generalChatTerminalMessagePublicId({
      conversationId: "test-conv-id",
      taskId: "partial-task",
      errorCode: GENERAL_CHAT_PARTIAL_RESULT_ERROR_CODE,
    });
    const terminalMessages = mocks.addMessage.mock.calls.filter(
      ([, message]) => message.id === expectedId,
    );
    expect(terminalMessages).toEqual([
      [
        "test-conv-id",
        expect.objectContaining({
          id: expectedId,
          content: GENERAL_CHAT_PARTIAL_RESULT_MESSAGE,
        }),
      ],
    ]);
    expect(mocks.updateAssistantMessages).toHaveBeenCalled();
    expect(mocks.retrieveTask).not.toHaveBeenCalled();
    expect(toast.warning).toHaveBeenCalledTimes(1);
  });

  it("ignores stale error metadata on an immediate completed DTO", async () => {
    mocks.createTask.mockResolvedValueOnce({
      id: "completed-task",
      status: "completed",
      output: [],
      error: {
        code: "STALE_ERROR",
        message: "不应展示",
        partialResult: true,
      },
    });
    const { result } = renderHook(() => useSendMessage());

    await act(async () => {
      await result.current.sendMessage("已完成", []);
    });

    expect(
      mocks.addMessage.mock.calls.some(([, message]) =>
        message.id.startsWith("msg-general-chat-terminal-"),
      ),
    ).toBe(false);
    expect(mocks.updateStatus).toHaveBeenCalledWith(
      "test-conv-id",
      "completed",
      expect.objectContaining({ completedAt: expect.any(Number) }),
    );
  });

  it("does not dispatch an ordinary task until the conversation snapshot is acknowledged", async () => {
    mocks.flushConversation.mockResolvedValueOnce(false);
    mocks.useConversation.mockReturnValue(
      mockConversationContext({
        activeConversation: {
          id: "ordinary-ack",
          title: "新内容流程",
          messages: [],
          status: "idle",
          createdAt: 1,
          updatedAt: 1,
        },
      }),
    );
    const { result } = renderHook(() => useSendMessage());

    let sent = true;
    await act(async () => {
      sent = await result.current.sendMessage("先保存再派发", []);
    });

    expect(sent).toBe(false);
    expect(mocks.flushConversation).toHaveBeenCalledWith("ordinary-ack");
    expect(mocks.updateStatus).toHaveBeenCalledWith("ordinary-ack", "idle", {
      executionKind: "general_chat_v2",
    });
    expect(mocks.createTask).not.toHaveBeenCalled();
  });

  it("reuses the same user message id when a blocked snapshot is retried", async () => {
    mocks.flushConversation
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(true);
    mocks.useConversation.mockReturnValue(
      mockConversationContext({
        activeConversation: {
          id: "ordinary-retry",
          title: "新内容流程",
          messages: [],
          status: "idle",
          createdAt: 1,
          updatedAt: 1,
        },
      }),
    );
    const { result } = renderHook(() => useSendMessage());

    await act(async () => {
      await result.current.sendMessage("同一请求", []);
      await result.current.sendMessage("同一请求", []);
    });

    expect(mocks.addMessage).toHaveBeenCalledTimes(1);
    const messageId = mocks.addMessage.mock.calls[0]![1].id;
    expect(mocks.createTask).toHaveBeenCalledTimes(1);
    expect(mocks.createTask.mock.calls[0]![1]).toMatchObject({
      conversationId: "ordinary-retry",
      clientRequestId: messageId,
    });
  });

  it("retains the pending dispatch when a 422 error has no settlement evidence", async () => {
    mocks.createTask.mockRejectedValue(
      Object.assign(new Error("请求未结算"), {
        status: 422,
        code: "VALIDATION_FAILED",
        retryable: false,
      }),
    );
    mocks.useConversation.mockReturnValue(
      mockConversationContext({
        activeConversation: {
          id: "ordinary-unsettled-422",
          title: "新内容流程",
          messages: [],
          status: "idle",
          createdAt: 1,
          updatedAt: 1,
        },
      }),
    );
    const { result } = renderHook(() => useSendMessage());

    await act(async () => {
      await result.current.sendMessage("保留同一请求", []);
      await result.current.sendMessage("保留同一请求", []);
    });

    expect(mocks.createTask).toHaveBeenCalledTimes(2);
    expect(mocks.createTask.mock.calls[1]![1].clientRequestId).toBe(
      mocks.createTask.mock.calls[0]![1].clientRequestId,
    );
    expect(
      mocks.addMessage.mock.calls.filter(
        ([, message]) => message.role === "user",
      ),
    ).toHaveLength(1);
    expect(mocks.settleGeneralChatDispatch).not.toHaveBeenCalled();
  });

  it("settles the pending dispatch only when the error explicitly proves it", async () => {
    mocks.createTask.mockRejectedValueOnce(
      Object.assign(new Error("请求已被明确拒绝"), {
        status: 422,
        code: "SEND_REJECTED",
        retryable: false,
        dispatchSettled: true,
      }),
    );
    mocks.useConversation.mockReturnValue(
      mockConversationContext({
        activeConversation: {
          id: "ordinary-settled-422",
          title: "新内容流程",
          messages: [],
          status: "idle",
          createdAt: 1,
          updatedAt: 1,
        },
      }),
    );
    const { result } = renderHook(() => useSendMessage());

    await act(async () => {
      await result.current.sendMessage("明确拒绝", []);
    });

    const userMessage = mocks.addMessage.mock.calls.find(
      ([, message]) => message.role === "user",
    )?.[1];
    expect(mocks.settleGeneralChatDispatch).toHaveBeenCalledWith(
      "ordinary-settled-422",
      userMessage.id,
    );
  });

  it("reuses the frozen PNG asset envelope after snapshot ACK fails", async () => {
    const png = new File([new Uint8Array([137, 80, 78, 71])], "proof.png", {
      type: "image/png",
      lastModified: 1_725_000_000_000,
    });
    mocks.isImageUpload.mockReturnValue(true);
    let uploadAttempt = 0;
    mocks.uploadChatLocalAsset.mockImplementation(async () => {
      uploadAttempt += 1;
      return {
        fileId: uploadAttempt === 1 ? "asset_png_first" : "asset_png_forked",
        filename: "proof.png",
        expiresAt: 2_593_000_000,
      };
    });
    mocks.flushConversation
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(true);
    mocks.useConversation.mockReturnValue(
      mockConversationContext({
        activeConversation: {
          id: "ordinary-png-retry",
          title: "新内容流程",
          messages: [],
          status: "idle",
          createdAt: 1,
          updatedAt: 1,
        },
      }),
    );
    const { result } = renderHook(() => useSendMessage());

    await act(async () => {
      await result.current.sendMessage("分析这张图", [png]);
      await result.current.sendMessage("分析这张图", [png]);
    });

    expect(mocks.uploadChatLocalAsset).toHaveBeenCalledTimes(1);
    expect(mocks.prepareUploadFiles).toHaveBeenCalledTimes(1);
    expect(mocks.addMessage).toHaveBeenCalledTimes(1);
    const persistedMessage = mocks.addMessage.mock.calls[0]![1];
    expect(persistedMessage.attachments).toEqual([
      expect.objectContaining({ fileId: "asset_png_first", name: "proof.png" }),
    ]);
    expect(mocks.flushConversation).toHaveBeenCalledTimes(2);
    expect(mocks.createTask).toHaveBeenCalledTimes(1);
    expect(mocks.createTask.mock.calls[0]![1]).toMatchObject({
      conversationId: "ordinary-png-retry",
      clientRequestId: persistedMessage.id,
    });
    expect(mocks.createTask.mock.calls[0]![0]).toEqual([
      {
        role: "user",
        content: [
          { type: "input_text", text: "分析这张图" },
          expect.objectContaining({
            type: "input_file",
            file_id: "asset_png_first",
            filename: "proof.png",
            mime_type: "image/png",
          }),
        ],
      },
    ]);
  });

  it("uses a new request identity after a terminal create DTO", async () => {
    const png = new File([new Uint8Array([137, 80, 78, 71])], "retry.png", {
      type: "image/png",
      lastModified: 1_725_000_000_001,
    });
    mocks.isImageUpload.mockReturnValue(true);
    mocks.uploadChatLocalAsset.mockResolvedValue({
      fileId: "asset_retry_png",
      filename: "retry.png",
      expiresAt: 2_593_000_000,
    });
    mocks.createTask
      .mockResolvedValueOnce({
        id: "same-local-task",
        status: "error",
        output: [],
        error: { code: "CREATE_PREPARATION_FAILED" },
      })
      .mockResolvedValueOnce({
        id: "same-local-task",
        status: "completed",
        output: [],
      });
    mocks.useConversation.mockReturnValue(
      mockConversationContext({
        activeConversation: {
          id: "ordinary-create-retry",
          title: "新内容流程",
          messages: [],
          status: "idle",
          createdAt: 1,
          updatedAt: 1,
        },
      }),
    );
    const { result } = renderHook(() => useSendMessage());

    await act(async () => {
      await result.current.sendMessage("重试首轮", [png]);
      await result.current.sendMessage("重试首轮", [png]);
    });

    expect(mocks.uploadChatLocalAsset).toHaveBeenCalledTimes(2);
    expect(
      mocks.addMessage.mock.calls.filter(
        ([, message]) => message.role === "user",
      ),
    ).toHaveLength(2);
    expect(
      mocks.addMessage.mock.calls.filter(([, message]) =>
        message.id.startsWith("msg-general-chat-terminal-"),
      ),
    ).toHaveLength(1);
    expect(mocks.createTask).toHaveBeenCalledTimes(2);
    const firstOptions = mocks.createTask.mock.calls[0]![1];
    const secondOptions = mocks.createTask.mock.calls[1]![1];
    expect(secondOptions.clientRequestId).not.toBe(
      firstOptions.clientRequestId,
    );
    expect(mocks.settleGeneralChatDispatch).toHaveBeenCalledWith(
      "ordinary-create-retry",
      firstOptions.clientRequestId,
    );
    expect(mocks.createTask.mock.calls[1]![0][0].content).toContainEqual(
      expect.objectContaining({ file_id: "asset_retry_png" }),
    );
  });

  it("clears stale task pointers for a terminal DTO without a reusable task", async () => {
    const staleTaskId = "33333333-3333-4333-8333-333333333333";
    mocks.createTask.mockResolvedValueOnce({
      id: staleTaskId,
      status: "error",
      output: [],
      clearTaskPointer: true,
      error: { code: "CREATE_PREPARATION_FAILED" },
    });
    mocks.useConversation.mockReturnValue(
      mockConversationContext({
        activeConversation: {
          id: "ordinary-terminal-no-task",
          title: "继续处理",
          messages: [],
          taskId: staleTaskId,
          previousResponseId: staleTaskId,
          status: "completed",
          createdAt: 1,
          updatedAt: 1,
        },
      }),
    );
    const { result } = renderHook(() => useSendMessage());

    await act(async () => {
      await result.current.sendMessage("重新准备", []);
    });

    const terminalStatus = mocks.updateStatus.mock.calls.find(
      ([conversationId, status]) =>
        conversationId === "ordinary-terminal-no-task" && status === "error",
    )?.[2];
    expect(terminalStatus).toMatchObject({ clearTaskPointer: true });
    expect(terminalStatus).not.toHaveProperty("taskId");
    expect(terminalStatus).not.toHaveProperty("previousResponseId");
  });

  it("replays a remounted first-create PNG from durable metadata without uploading or changing identity", async () => {
    const messageId = "msg-remounted-create";
    const pendingMessage = {
      id: messageId,
      role: "user" as const,
      content: "分析这张图",
      timestamp: 1_725_000_000_000,
      modelName: "frontmind-base",
      attachments: [
        {
          id: "attachment-remounted",
          type: "image" as const,
          name: "proof.png",
          fileId: "asset_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        },
      ],
      generalChatDispatch: {
        schemaVersion: 1 as const,
        kind: "pending_user" as const,
        clientRequestId: messageId,
        providerPrompt: "分析这张图",
        localAssetIds: ["asset_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"],
        localTaskId: null,
        modelProfile: "frontmind-base" as const,
      },
    };
    mocks.createTask
      .mockRejectedValueOnce(
        Object.assign(new Error("outcome unknown"), { status: 409 }),
      )
      .mockResolvedValueOnce({
        id: "11111111-1111-4111-8111-111111111111",
        status: "running",
        output: [],
      });
    mocks.useConversation.mockReturnValue(
      mockConversationContext({
        activeConversation: {
          id: "remounted-create",
          title: "分析这张图",
          messages: [pendingMessage],
          status: "idle",
          createdAt: 1,
          updatedAt: 1,
        },
      }),
    );
    const { result } = renderHook(() => useSendMessage());

    await act(async () => {
      await result.current.retryLastMessage();
      await result.current.retryLastMessage();
    });

    expect(mocks.uploadChatLocalAsset).not.toHaveBeenCalled();
    expect(mocks.prepareUploadFiles).not.toHaveBeenCalled();
    expect(
      mocks.addMessage.mock.calls.filter(
        ([, message]) => message.role === "user",
      ),
    ).toHaveLength(0);
    expect(mocks.createTask).toHaveBeenCalledTimes(2);
    for (const [input, taskOptions] of mocks.createTask.mock.calls) {
      expect(taskOptions).toMatchObject({
        conversationId: "remounted-create",
        clientRequestId: messageId,
        modelProfile: "frontmind-base",
      });
      expect(taskOptions.previousResponseId).toBeUndefined();
      expect(input).toEqual([
        {
          role: "user",
          content: [
            { type: "input_text", text: "分析这张图" },
            {
              type: "input_file",
              file_id: "asset_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
              filename: "proof.png",
            },
          ],
        },
      ]);
    }
  });

  it("replays a remounted continuation against its frozen local task", async () => {
    const localTaskId = "22222222-2222-4222-8222-222222222222";
    const pendingMessage = {
      id: "msg-remounted-continuation",
      role: "user" as const,
      content: "继续完善",
      timestamp: 1_725_000_000_100,
      generalChatDispatch: {
        schemaVersion: 1 as const,
        kind: "pending_user" as const,
        clientRequestId: "msg-remounted-continuation",
        providerPrompt: "继续完善",
        localAssetIds: [] as string[],
        localTaskId,
        modelProfile: null,
      },
    };
    mocks.useConversation.mockReturnValue(
      mockConversationContext({
        activeConversation: {
          id: "remounted-continuation",
          title: "继续完善",
          messages: [pendingMessage],
          taskId: localTaskId,
          previousResponseId: localTaskId,
          status: "completed",
          createdAt: 1,
          updatedAt: 1,
        },
      }),
    );
    const { result } = renderHook(() => useSendMessage());

    await act(async () => {
      await result.current.retryLastMessage();
    });

    expect(mocks.createTask).toHaveBeenCalledTimes(1);
    expect(mocks.createTask.mock.calls[0]![1]).toMatchObject({
      conversationId: "remounted-continuation",
      clientRequestId: "msg-remounted-continuation",
      previousResponseId: localTaskId,
    });
    expect(mocks.createTask.mock.calls[0]![1].modelProfile).toBeUndefined();
    expect(mocks.uploadChatLocalAsset).not.toHaveBeenCalled();
  });

  it("hands response-logic tasks to the dedicated poller without ordinary projection", async () => {
    mocks.createResponseLogicTask.mockResolvedValueOnce({
      id: "provider-response-task",
      operationRevision: 4,
      status: "running",
      output: [{ id: "raw-provider-output" }],
    });
    const onTaskStarted = vi.fn();
    const { result } = renderHook(() => useSendMessage());

    await act(async () => {
      await result.current.sendMessage("生成应答逻辑", [], {
        responseLogicContext: {
          questionId: "question-1",
          groupId: "group-1",
          groupTitle: "行业排名",
          question: "如何选择测评机构？",
          intent: "核验资质",
          summary: "形成可核验口径",
          draft: {
            concern: "",
            conclusion: "",
            facts: "",
            pending: "",
            boundaries: "",
            references: "",
            images: [],
            attachments: [],
          },
          onTaskStarted,
        },
      });
    });

    expect(mocks.createResponseLogicTask).toHaveBeenCalledTimes(1);
    expect(mocks.updateStatus).toHaveBeenCalledWith(
      "test-conv-id",
      "running",
      expect.objectContaining({
        taskId: "provider-response-task",
        previousResponseId: "provider-response-task",
        executionKind: "response_logic",
      }),
    );
    expect(onTaskStarted).toHaveBeenCalledWith(
      expect.objectContaining({
        questionId: "question-1",
        conversationId: "test-conv-id",
        taskId: "provider-response-task",
        operationRevision: 4,
      }),
    );
    expect(mocks.retrieveTask).not.toHaveBeenCalled();
    expect(mocks.updateAssistantMessages).not.toHaveBeenCalled();
  });

  it("keeps a retryable response-logic start failure taskless and preserves its envelope", async () => {
    const failure = {
      code: "RESPONSE_LOGIC_UPSTREAM_UNAVAILABLE",
      message: "上游服务暂时不可用，任务尚未创建，请稍后重试",
      retryable: true,
      resetRequired: false,
      stage: "file_upload_intent",
      incidentId: "incident-safe-retry",
      retryAfterMs: 1_500,
      status: 503,
    } as const;
    mocks.createResponseLogicTask.mockRejectedValueOnce(failure);
    const onTaskStarted = vi.fn();
    const onTaskStartFailed = vi.fn();
    const { result } = renderHook(() => useSendMessage());

    let sent = true;
    await act(async () => {
      sent = await result.current.sendMessage("生成应答逻辑", [], {
        responseLogicContext: {
          questionId: "question-1",
          groupId: "group-1",
          groupTitle: "行业排名",
          question: "如何选择测评机构？",
          intent: "核验资质",
          summary: "形成可核验口径",
          draft: {
            concern: "",
            conclusion: "",
            facts: "",
            pending: "",
            boundaries: "",
            references: "",
            images: [],
            attachments: [],
          },
          onTaskStarted,
          onTaskStartFailed,
        },
      });
    });

    expect(sent).toBe(false);
    expect(onTaskStarted).not.toHaveBeenCalled();
    expect(onTaskStartFailed).toHaveBeenCalledWith(
      expect.objectContaining({
        ...failure,
        questionId: "question-1",
        conversationId: "test-conv-id",
      }),
    );
    expect(mocks.updateStatus).toHaveBeenCalledWith(
      "test-conv-id",
      "error",
      expect.objectContaining({
        clearTaskPointer: true,
        executionKind: "response_logic",
      }),
    );
    expect(mocks.retrieveTask).not.toHaveBeenCalled();
    expect(mocks.addMessage).toHaveBeenLastCalledWith(
      "test-conv-id",
      expect.objectContaining({
        role: "assistant",
        content: expect.stringContaining("任务尚未创建"),
      }),
    );
    expect(
      readResponseLogicTaskStartFailure({ ...failure, stage: "arbitrary" }),
    ).toBeNull();
    expect(
      responseLogicStartFailureMessage(failure).assistantMessage,
    ).toContain("故障编号：incident-safe-retry");
  });

  it("requires a reset for an ambiguous response-logic start and never hands it to a poller", async () => {
    mocks.createResponseLogicTask.mockRejectedValueOnce({
      code: "RESPONSE_LOGIC_START_OUTCOME_UNKNOWN",
      message: "附件处理结果无法确认，请申请重置后重新开始",
      retryable: false,
      resetRequired: true,
      stage: "file_confirmation",
      incidentId: "incident-unknown",
      status: 502,
    });
    const onTaskStarted = vi.fn();
    const onTaskStartFailed = vi.fn();
    const { result } = renderHook(() => useSendMessage());

    await act(async () => {
      await result.current.sendMessage("生成应答逻辑", [], {
        responseLogicContext: {
          questionId: "question-1",
          groupId: "group-1",
          groupTitle: "行业排名",
          question: "如何选择测评机构？",
          intent: "核验资质",
          summary: "形成可核验口径",
          draft: {
            concern: "",
            conclusion: "",
            facts: "",
            pending: "",
            boundaries: "",
            references: "",
            images: [],
            attachments: [],
          },
          onTaskStarted,
          onTaskStartFailed,
        },
      });
    });

    expect(onTaskStarted).not.toHaveBeenCalled();
    expect(onTaskStartFailed).toHaveBeenCalledWith(
      expect.objectContaining({ resetRequired: true }),
    );
    expect(mocks.retrieveTask).not.toHaveBeenCalled();
    expect(mocks.addMessage).toHaveBeenLastCalledWith(
      "test-conv-id",
      expect.objectContaining({
        id: expect.stringMatching(/^msg-response-logic-reset-required-/u),
        content: expect.stringContaining("请先申请重置"),
      }),
    );
  });

  it("treats a post-dispatch binding failure as reset-required and never polls", async () => {
    mocks.createResponseLogicTask.mockRejectedValueOnce({
      code: "RESPONSE_LOGIC_TASK_BINDING_PENDING",
      message: "上游任务已创建，但本地绑定未完成；请申请重置后重新开始",
      retryable: false,
      resetRequired: true,
      stage: "task_binding",
      incidentId: "incident-binding",
      status: 502,
    });
    const onTaskStartFailed = vi.fn();
    const { result } = renderHook(() => useSendMessage());

    await act(async () => {
      await result.current.sendMessage("生成应答逻辑", [], {
        responseLogicContext: {
          questionId: "question-1",
          groupId: "group-1",
          groupTitle: "行业排名",
          question: "如何选择测评机构？",
          intent: "核验资质",
          summary: "形成可核验口径",
          draft: {
            concern: "",
            conclusion: "",
            facts: "",
            pending: "",
            boundaries: "",
            references: "",
            images: [],
            attachments: [],
          },
          onTaskStarted: vi.fn(),
          onTaskStartFailed,
        },
      });
    });

    expect(onTaskStartFailed).toHaveBeenCalledWith(
      expect.objectContaining({
        code: "RESPONSE_LOGIC_TASK_BINDING_PENDING",
        stage: "task_binding",
        resetRequired: true,
      }),
    );
    expect(mocks.updateStatus).toHaveBeenCalledWith(
      "test-conv-id",
      "error",
      expect.objectContaining({ clearTaskPointer: true }),
    );
    expect(mocks.retrieveTask).not.toHaveBeenCalled();
    expect(mocks.addMessage).toHaveBeenLastCalledWith(
      "test-conv-id",
      expect.objectContaining({
        content: expect.stringContaining("请先申请重置"),
      }),
    );
  });

  it("hands an async knowledge confirmation to the authoritative coordinator without reading raw output", async () => {
    const observation = {
      stateEpoch: 2,
      generation: 1,
      authoritativeTaskId: "test-kb-task-id",
      activeTurn: {
        id: "turn-2",
        clientRequestId: "request-2",
        operationKey: "operation-2",
        operationType: "confirm",
        status: "completed",
        buildGeneration: 1,
        expectedRevision: 0,
        expectedLeafId: "1.1",
        startedAt: 1,
        completedAt: 2,
        updatedAt: 2,
      },
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
      conversationVersion: 2,
    };
    mocks.createKnowledgeBaseTurnTask.mockResolvedValueOnce({
      id: "test-kb-task-id",
      status: "running",
      output: [{ id: "raw-output-must-not-render" }],
      knowledgeObservation: observation,
    });

    const { result } = renderHook(() => useSendMessage());
    await act(async () => {
      await result.current.sendMessage("确认", [], {
        syncKnowledgeBaseSnapshot: true,
        knowledgeBaseExpectedRevision: 0,
        knowledgeBaseExpectedLeafId: "1.1",
      });
    });
    expect(mocks.commitKnowledgeBaseObservation).toHaveBeenCalledWith(
      "test-conv-id",
      observation,
    );
    expect(mocks.wakeKnowledgeBaseConversation).toHaveBeenCalledWith(
      "test-conv-id",
    );
    expect(mocks.retrieveTask).not.toHaveBeenCalled();
    expect(mocks.updateAssistantMessages).not.toHaveBeenCalled();
  });

  it("dispatches a knowledge confirmation without waiting for the version freshness check", async () => {
    mocks.requireCurrentFrontMindBuild.mockReturnValueOnce(
      new Promise<boolean>(() => undefined),
    );

    const { result } = renderHook(() => useSendMessage());
    let submitted = false;
    await act(async () => {
      submitted = await result.current.sendMessage("确认", [], {
        syncKnowledgeBaseSnapshot: true,
        knowledgeBaseExpectedRevision: 0,
        knowledgeBaseExpectedLeafId: "1.1",
      });
    });

    expect(submitted).toBe(true);
    expect(mocks.createKnowledgeBaseTurnTask).toHaveBeenCalledTimes(1);
    expect(
      mocks.createKnowledgeBaseTurnTask.mock.invocationCallOrder[0],
    ).toBeLessThan(
      mocks.requireCurrentFrontMindBuild.mock.invocationCallOrder[0],
    );
  });

  it("does not enter running or wake reconciliation before the turn POST is accepted", async () => {
    let resolveTurn!: (value: any) => void;
    mocks.createKnowledgeBaseTurnTask.mockReturnValueOnce(
      new Promise((resolve) => {
        resolveTurn = resolve;
      }),
    );

    const { result } = renderHook(() => useSendMessage());
    let submission!: Promise<boolean>;
    act(() => {
      submission = result.current.sendMessage("确认", [], {
        syncKnowledgeBaseSnapshot: true,
        knowledgeBaseExpectedRevision: 0,
        knowledgeBaseExpectedLeafId: "1.1",
      });
    });
    await act(async () => {
      await Promise.resolve();
    });

    expect(mocks.updateStatus).not.toHaveBeenCalledWith(
      "test-conv-id",
      "running",
      expect.anything(),
    );
    expect(mocks.wakeKnowledgeBaseConversation).not.toHaveBeenCalled();
    expect(mocks.createKnowledgeBaseTurnTask).toHaveBeenCalledTimes(1);

    resolveTurn({
      id: "test-kb-task-id",
      status: "running",
      output: [],
    });
    await act(async () => {
      await submission;
    });
    expect(mocks.updateStatus).toHaveBeenCalledWith(
      "test-conv-id",
      "running",
      expect.objectContaining({ taskId: "test-kb-task-id" }),
    );
    expect(mocks.wakeKnowledgeBaseConversation).toHaveBeenCalledWith(
      "test-conv-id",
    );
  });

  it("keeps the Logo gate local until a real upstream task is acknowledged", async () => {
    const logo = new File(["logo"], "logo.png", { type: "image/png" });
    mockPreparedFiles([logo]);
    let resolveTurn!: (value: any) => void;
    mocks.createKnowledgeBaseTurnTask.mockReturnValueOnce(
      new Promise((resolve) => {
        resolveTurn = resolve;
      }),
    );

    const { result } = renderHook(() => useSendMessage());
    let submission!: Promise<boolean>;
    act(() => {
      submission = result.current.sendMessage("", [logo], {
        syncKnowledgeBaseSnapshot: true,
        submissionKind: "logo",
        knowledgeBaseExpectedGeneration: 1,
        knowledgeBaseExpectedRevision: 0,
        knowledgeBaseExpectedLeafId: "1.1",
      });
    });
    await waitFor(() =>
      expect(mocks.createKnowledgeBaseTurnTask).toHaveBeenCalledTimes(1),
    );

    expect(mocks.createKnowledgeBaseTurnTask).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        submissionKind: "logo",
      }),
    );
    expect(
      mocks.createKnowledgeBaseTurnTask.mock.calls[0]![1],
    ).not.toHaveProperty("attachmentManifest");
    expect(mocks.uploadFile).toHaveBeenCalledTimes(1);
    expect(mocks.providerV1UploadFile).not.toHaveBeenCalled();
    expect(mocks.sha256UploadFile).not.toHaveBeenCalled();
    expect(mocks.updateStatus).not.toHaveBeenCalledWith(
      "test-conv-id",
      "running",
      expect.anything(),
    );
    expect(mocks.wakeKnowledgeBaseConversation).not.toHaveBeenCalled();

    resolveTurn({ id: "frontmind-logo-task", status: "running", output: [] });
    await act(async () => {
      await submission;
    });
    expect(mocks.updateStatus).toHaveBeenCalledWith(
      "test-conv-id",
      "running",
      expect.objectContaining({ taskId: "frontmind-logo-task" }),
    );
    expect(mocks.wakeKnowledgeBaseConversation).toHaveBeenCalledWith(
      "test-conv-id",
    );
  });

  it("keeps an explicit 425 Logo response as a deterministic failure", async () => {
    const logo = new File(["logo"], "logo.png", { type: "image/png" });
    mockPreparedFiles([logo]);
    mocks.createKnowledgeBaseTurnTask.mockImplementationOnce(
      async (_input: unknown, context: any) => {
        throw Object.assign(new Error("Logo 提交未获 Manus 任务确认"), {
          status: 425,
          code: "IDEMPOTENCY_PENDING",
          knowledgeObservation: {
            authoritativeTaskId: "previous-parent-task",
            activeTurn: { clientRequestId: context.clientRequestId },
            approvedPresentation: null,
            completedTurn: null,
          },
        });
      },
    );

    const { result } = renderHook(() => useSendMessage());
    let submitted = true;
    await act(async () => {
      submitted = await result.current.sendMessage("", [logo], {
        syncKnowledgeBaseSnapshot: true,
        submissionKind: "logo",
        knowledgeBaseExpectedGeneration: 1,
        knowledgeBaseExpectedRevision: 0,
        knowledgeBaseExpectedLeafId: "1.1",
      });
    });

    expect(submitted).toBe(false);
    expect(mocks.rollbackPendingKnowledgeBaseTurn).toHaveBeenCalledWith(
      "test-conv-id",
      expect.any(String),
    );
    expect(mocks.commitKnowledgeBaseObservation).toHaveBeenCalledWith(
      "test-conv-id",
      expect.objectContaining({
        activeTurn: expect.objectContaining({
          clientRequestId: expect.any(String),
        }),
      }),
    );
    expect(mocks.updateStatus).not.toHaveBeenCalledWith(
      "test-conv-id",
      "running",
      expect.anything(),
    );
    expect(mocks.wakeKnowledgeBaseConversation).not.toHaveBeenCalled();
    expect(toast.error).toHaveBeenCalledWith("本轮未能提交", expect.anything());
  });

  it.each([
    [
      "425 receipt before activeTurn projection",
      Object.assign(new Error("预约已创建，状态仍在投影"), {
        status: 425,
        code: "PROJECTION_PENDING",
        knowledgeObservation: {
          activeTurn: null,
          approvedPresentation: null,
          completedTurn: null,
        },
      }),
    ],
    [
      "IDEMPOTENCY_PENDING receipt without an observation",
      Object.assign(new Error("同一预约仍在处理中"), {
        status: 409,
        code: "IDEMPOTENCY_PENDING",
      }),
    ],
  ])(
    "does not treat an explicit Dashboard %s as accepted",
    async (_label, error) => {
      const logo = new File(["logo"], "logo.png", { type: "image/png" });
      mockPreparedFiles([logo]);
      mocks.createKnowledgeBaseTurnTask.mockRejectedValueOnce(error);

      const { result } = renderHook(() => useSendMessage());
      let submitted = false;
      await act(async () => {
        submitted = await result.current.sendMessage("", [logo], {
          syncKnowledgeBaseSnapshot: true,
          submissionKind: "logo",
          knowledgeBaseExpectedGeneration: 1,
          knowledgeBaseExpectedRevision: 0,
          knowledgeBaseExpectedLeafId: "1.1",
        });
      });

      expect(submitted).toBe(false);
      expect(mocks.rollbackPendingKnowledgeBaseTurn).toHaveBeenCalledWith(
        "test-conv-id",
        expect.any(String),
      );
      if ((error as any).knowledgeObservation) {
        expect(mocks.commitKnowledgeBaseObservation).toHaveBeenCalledWith(
          "test-conv-id",
          (error as any).knowledgeObservation,
        );
      }
      expect(mocks.updateStatus).not.toHaveBeenCalledWith(
        "test-conv-id",
        "running",
        expect.anything(),
      );
      expect(mocks.wakeKnowledgeBaseConversation).not.toHaveBeenCalled();
      expect(toast.error).toHaveBeenCalledWith(
        "本轮未能提交",
        expect.anything(),
      );
    },
  );

  it("accepts a missing-task-id Logo response when its observation acknowledges the request", async () => {
    const logo = new File(["logo"], "logo.png", { type: "image/png" });
    mockPreparedFiles([logo]);
    mocks.createKnowledgeBaseTurnTask.mockImplementationOnce(
      async (_input: unknown, context: any) => {
        throw Object.assign(new Error("真实任务编号暂缺"), {
          status: 502,
          code: "KNOWLEDGE_BASE_LOGO_TASK_ID_MISSING",
          knowledgeObservation: {
            activeTurn: { clientRequestId: context.clientRequestId },
            approvedPresentation: null,
            completedTurn: null,
          },
        });
      },
    );

    const { result } = renderHook(() => useSendMessage());
    let submitted = false;
    await act(async () => {
      submitted = await result.current.sendMessage("", [logo], {
        syncKnowledgeBaseSnapshot: true,
        submissionKind: "logo",
        knowledgeBaseExpectedGeneration: 1,
        knowledgeBaseExpectedRevision: 0,
        knowledgeBaseExpectedLeafId: "1.1",
      });
    });

    expect(submitted).toBe(true);
    expect(mocks.rollbackPendingKnowledgeBaseTurn).not.toHaveBeenCalled();
    expect(mocks.commitKnowledgeBaseObservation).toHaveBeenCalledWith(
      "test-conv-id",
      expect.objectContaining({
        activeTurn: expect.objectContaining({
          clientRequestId: expect.any(String),
        }),
      }),
    );
    expect(toast.error).not.toHaveBeenCalled();
  });

  it.each([
    ["network", new TypeError("Failed to fetch")],
    [
      "5xx",
      Object.assign(new Error("上游服务暂时不可用"), {
        status: 503,
        code: "TEMPORARILY_UNAVAILABLE",
      }),
    ],
  ])(
    "keeps an unacknowledged Logo %s result and its attachment in reconciliation",
    async (_label, error) => {
      const logo = new File(["logo"], "logo.png", { type: "image/png" });
      mockPreparedFiles([logo]);
      mocks.createKnowledgeBaseTurnTask.mockRejectedValueOnce(error);

      const { result } = renderHook(() => useSendMessage());
      let submitted = false;
      await act(async () => {
        submitted = await result.current.sendMessage("", [logo], {
          syncKnowledgeBaseSnapshot: true,
          submissionKind: "logo",
          knowledgeBaseExpectedGeneration: 1,
          knowledgeBaseExpectedRevision: 0,
          knowledgeBaseExpectedLeafId: "1.1",
        });
      });

      expect(submitted).toBe(false);
      expect(mocks.rollbackPendingKnowledgeBaseTurn).not.toHaveBeenCalled();
      expect(mocks.updateStatus).toHaveBeenCalledWith(
        "test-conv-id",
        "running",
        expect.objectContaining({ startedAt: expect.any(Number) }),
      );
      expect(mocks.wakeKnowledgeBaseConversation).toHaveBeenCalledWith(
        "test-conv-id",
      );
      expect(toast.info).toHaveBeenCalledWith("正在确认提交结果", {
        description:
          "网络响应中断，已保留所选 Logo；系统正在按同一请求继续核对。",
      });
      expect(toast.error).not.toHaveBeenCalled();
    },
  );

  it("rolls back a definitively invalid Logo and sanitizes its visible error", async () => {
    const logo = new File(["invalid"], "invalid.png", { type: "image/png" });
    mockPreparedFiles([logo]);
    mocks.createKnowledgeBaseTurnTask.mockImplementationOnce(
      async (_input: unknown, context: any) => {
        throw Object.assign(new Error("Manus 拒绝了无效 Logo"), {
          status: 422,
          code: "KNOWLEDGE_BASE_LOGO_UPLOAD_INVALID",
          knowledgeObservation: {
            activeTurn: { clientRequestId: context.clientRequestId },
            approvedPresentation: null,
            completedTurn: null,
            interaction: {
              interactionState: "awaiting_input",
              canReply: true,
              canPublish: false,
              lockReason: null,
              progress: null,
            },
          },
        });
      },
    );

    const { result } = renderHook(() => useSendMessage());
    let submitted = true;
    await act(async () => {
      submitted = await result.current.sendMessage("", [logo], {
        syncKnowledgeBaseSnapshot: true,
        submissionKind: "logo",
        knowledgeBaseExpectedGeneration: 1,
        knowledgeBaseExpectedRevision: 0,
        knowledgeBaseExpectedLeafId: "1.1",
      });
    });

    expect(submitted).toBe(false);
    expect(mocks.rollbackPendingKnowledgeBaseTurn).toHaveBeenCalledWith(
      "test-conv-id",
      expect.any(String),
    );
    expect(mocks.updateStatus).not.toHaveBeenCalled();
    expect(mocks.commitKnowledgeBaseObservation).toHaveBeenCalledWith(
      "test-conv-id",
      expect.objectContaining({
        interaction: expect.objectContaining({
          interactionState: "awaiting_input",
        }),
      }),
    );
    expect(toast.error).toHaveBeenCalledWith("本轮未能提交", {
      description: "FrontMind 拒绝了无效 Logo",
    });
    expect(toast.info).not.toHaveBeenCalledWith(
      "本轮已提交",
      expect.anything(),
    );
  });

  it("does not overrule an explicit Logo 4xx with a final observation", async () => {
    const logo = new File(["logo"], "logo.png", { type: "image/png" });
    mockPreparedFiles([logo]);
    mocks.createKnowledgeBaseTurnTask.mockImplementationOnce(
      async (_input: unknown, context: any) => {
        throw Object.assign(new Error("代理响应失败"), {
          status: 422,
          code: "KNOWLEDGE_BASE_TURN_FAILED",
          knowledgeObservation: {
            activeTurn: null,
            approvedPresentation: {
              clientRequestId: context.clientRequestId,
            },
            completedTurn: null,
          },
        });
      },
    );

    const { result } = renderHook(() => useSendMessage());
    let submitted = false;
    await act(async () => {
      submitted = await result.current.sendMessage("", [logo], {
        syncKnowledgeBaseSnapshot: true,
        submissionKind: "logo",
        knowledgeBaseExpectedGeneration: 1,
        knowledgeBaseExpectedRevision: 0,
        knowledgeBaseExpectedLeafId: "1.1",
      });
    });

    expect(submitted).toBe(false);
    expect(mocks.rollbackPendingKnowledgeBaseTurn).toHaveBeenCalledWith(
      "test-conv-id",
      expect.any(String),
    );
    expect(mocks.commitKnowledgeBaseObservation).toHaveBeenCalledWith(
      "test-conv-id",
      expect.objectContaining({
        approvedPresentation: expect.objectContaining({
          clientRequestId: expect.any(String),
        }),
      }),
    );
    expect(mocks.wakeKnowledgeBaseConversation).not.toHaveBeenCalled();
    expect(toast.error).toHaveBeenCalledWith("本轮未能提交", expect.anything());
  });

  it("rolls back and reports a definitive Logo coordinate conflict", async () => {
    const logo = new File(["logo"], "logo.png", { type: "image/png" });
    mockPreparedFiles([logo]);
    mocks.createKnowledgeBaseTurnTask.mockRejectedValueOnce(
      Object.assign(new Error("当前节点坐标已更新，请重新选择"), {
        status: 409,
        code: "KNOWLEDGE_BASE_LOGO_UPLOAD_CONFLICT",
      }),
    );

    const { result } = renderHook(() => useSendMessage());
    let submitted = true;
    await act(async () => {
      submitted = await result.current.sendMessage("", [logo], {
        syncKnowledgeBaseSnapshot: true,
        submissionKind: "logo",
        knowledgeBaseExpectedGeneration: 1,
        knowledgeBaseExpectedRevision: 0,
        knowledgeBaseExpectedLeafId: "1.1",
      });
    });

    expect(submitted).toBe(false);
    expect(mocks.rollbackPendingKnowledgeBaseTurn).toHaveBeenCalledWith(
      "test-conv-id",
      expect.any(String),
    );
    expect(toast.error).toHaveBeenCalledWith("本轮未能提交", {
      description: "当前节点坐标已更新，请重新选择",
    });
    expect(toast.info).not.toHaveBeenCalledWith(
      "本轮已提交",
      expect.anything(),
    );
  });

  it("rolls back a deterministically rejected knowledge confirmation instead of pretending to recover it", async () => {
    mocks.createKnowledgeBaseTurnTask.mockRejectedValueOnce(
      Object.assign(new Error("当前知识节点版本无效"), {
        status: 422,
        code: "INVALID_KNOWLEDGE_BASE_REVISION",
      }),
    );

    const { result } = renderHook(() => useSendMessage());
    await act(async () => {
      await result.current.sendMessage("确认", [], {
        syncKnowledgeBaseSnapshot: true,
        knowledgeBaseExpectedRevision: 0,
        knowledgeBaseExpectedLeafId: "1.1",
      });
    });

    expect(mocks.rollbackPendingKnowledgeBaseTurn).toHaveBeenCalledWith(
      "test-conv-id",
      expect.any(String),
    );
    expect(mocks.wakeKnowledgeBaseConversation).not.toHaveBeenCalled();
  });

  it.each(["approvedPresentation", "completedTurn"] as const)(
    "keeps a deterministic HTTP error failed when %s acknowledges the request",
    async (acknowledgementField) => {
      mocks.createKnowledgeBaseTurnTask.mockImplementationOnce(
        async (_input: unknown, context: any) => {
          throw Object.assign(new Error("代理响应失败"), {
            status: 422,
            code: "KNOWLEDGE_BASE_TURN_FAILED",
            knowledgeObservation: {
              [acknowledgementField]: {
                clientRequestId: context.clientRequestId,
              },
            },
          });
        },
      );

      const { result } = renderHook(() => useSendMessage());
      let submitted = false;
      await act(async () => {
        submitted = await result.current.sendMessage("确认", [], {
          syncKnowledgeBaseSnapshot: true,
          knowledgeBaseExpectedGeneration: 1,
          knowledgeBaseExpectedRevision: 0,
          knowledgeBaseExpectedLeafId: "1.1",
          knowledgeBaseExpectedPresentationKey: "presentation-1",
        });
      });

      expect(submitted).toBe(false);
      expect(mocks.rollbackPendingKnowledgeBaseTurn).toHaveBeenCalledWith(
        "test-conv-id",
        expect.any(String),
      );
      expect(mocks.commitKnowledgeBaseObservation).toHaveBeenCalledWith(
        "test-conv-id",
        expect.objectContaining({
          [acknowledgementField]: expect.objectContaining({
            clientRequestId: expect.any(String),
          }),
        }),
      );
      expect(mocks.wakeKnowledgeBaseConversation).not.toHaveBeenCalled();
      expect(toast.error).toHaveBeenCalledWith(
        "本轮未能提交",
        expect.anything(),
      );
    },
  );

  it("does not adopt a legacy attachment turn when a fresh request is rejected", async () => {
    const file = new File(["a"], "a.txt", {
      type: "text/plain",
      lastModified: 10,
    });
    mockPreparedFiles([file]);
    mocks.useConversation.mockReturnValue(
      mockConversationContext({
        activeConversation: {
          id: "conversation-resume",
          title: "企业知识库构建",
          status: "running",
          messages: [
            {
              id: "existing-pending",
              role: "user",
              content: "请结合原附件修订",
              timestamp: 1,
              knowledgeBase: {
                kind: "pending_user",
                clientRequestId: "original-request",
                turnId: "reserved-turn",
              },
            },
          ],
          knowledgeBase: {
            activeClientRequestId: "original-request",
            notice: { code: "KNOWLEDGE_BASE_ATTACHMENTS_REQUIRED" },
          },
          lastKnownOutputLength: 0,
        },
      }),
    );
    const oldObservation = {
      activeTurn: { clientRequestId: "original-request" },
      approvedPresentation: null,
      completedTurn: null,
    };
    mocks.createKnowledgeBaseTurnTask.mockRejectedValueOnce(
      Object.assign(new Error("上传的 Logo 不符合要求"), {
        status: 422,
        code: "KNOWLEDGE_BASE_LOGO_UPLOAD_INVALID",
        knowledgeObservation: oldObservation,
      }),
    );

    const { result } = renderHook(() => useSendMessage());
    let submitted = true;
    await act(async () => {
      submitted = await result.current.sendMessage("", [file], {
        syncKnowledgeBaseSnapshot: true,
        knowledgeBaseExpectedResetRevision: 4,
        knowledgeBaseExpectedGeneration: 3,
        knowledgeBaseExpectedRevision: 7,
        knowledgeBaseExpectedLeafId: "2.1",
      });
    });

    expect(submitted).toBe(false);
    const freshClientRequestId =
      mocks.reserveKnowledgeBaseTurnWithAttachments.mock.calls[0]![1]
        .clientRequestId;
    expect(freshClientRequestId).not.toBe("original-request");
    expect(mocks.rollbackPendingKnowledgeBaseTurn).toHaveBeenCalledWith(
      "conversation-resume",
      freshClientRequestId,
    );
    expect(mocks.commitKnowledgeBaseObservation).toHaveBeenCalledWith(
      "conversation-resume",
      oldObservation,
    );
    expect(toast.success).not.toHaveBeenCalledWith(
      "本轮已提交",
      expect.anything(),
    );
    expect(toast.error).toHaveBeenCalledWith(
      "本轮未能提交",
      expect.objectContaining({ description: "上传的 Logo 不符合要求" }),
    );
  });

  it("removes a remounted tab's optimistic alias when the operation winner is adopted", async () => {
    mocks.createKnowledgeBaseTurnTask.mockResolvedValueOnce({
      id: "winner-task",
      status: "running",
      output: [],
      adoptedClientRequestId: "winner-request",
    });
    const { result } = renderHook(() => useSendMessage());
    await act(async () => {
      await result.current.sendMessage("确认", [], {
        syncKnowledgeBaseSnapshot: true,
        knowledgeBaseExpectedGeneration: 1,
        knowledgeBaseExpectedRevision: 0,
        knowledgeBaseExpectedLeafId: "1.1",
        knowledgeBaseExpectedPresentationKey: "presentation-1",
      });
    });
    expect(mocks.rollbackPendingKnowledgeBaseTurn).toHaveBeenCalledWith(
      "test-conv-id",
      expect.any(String),
    );
  });

  it("keeps a disconnected accepted confirmation on the normal processing path", async () => {
    mocks.createKnowledgeBaseTurnTask.mockRejectedValueOnce(
      new TypeError("Failed to fetch"),
    );

    const { result } = renderHook(() => useSendMessage());
    let submitted = false;
    await act(async () => {
      submitted = await result.current.sendMessage("确认", [], {
        syncKnowledgeBaseSnapshot: true,
        knowledgeBaseExpectedRevision: 0,
        knowledgeBaseExpectedLeafId: "1.1",
      });
    });

    expect(submitted).toBe(true);
    expect(mocks.rollbackPendingKnowledgeBaseTurn).not.toHaveBeenCalled();
    expect(mocks.updateStatus).toHaveBeenCalledWith(
      "test-conv-id",
      "running",
      expect.objectContaining({ startedAt: expect.any(Number) }),
    );
    expect(mocks.wakeKnowledgeBaseConversation).toHaveBeenCalledWith(
      "test-conv-id",
    );
    expect(toast.info).toHaveBeenCalledWith("本轮已提交", {
      description: "正在处理当前节点，请稍候。",
    });
  });

  it("reserves, uploads, stages and dispatches one knowledge attachment in order", async () => {
    const file = new File(["facts"], "facts.pdf", {
      type: "application/pdf",
      lastModified: 1_700_000_000_000,
    });
    mockPreparedFiles([file]);
    const { result } = renderHook(() => useSendMessage());
    await act(async () => {
      await result.current.sendMessage("请结合附件修订", [file], {
        syncKnowledgeBaseSnapshot: true,
        knowledgeBaseExpectedResetRevision: 4,
        knowledgeBaseExpectedGeneration: 3,
        knowledgeBaseExpectedRevision: 7,
        knowledgeBaseExpectedLeafId: "2.1",
      });
    });

    expect(mocks.reserveKnowledgeBaseTurnWithAttachments).toHaveBeenCalledTimes(
      1,
    );
    const reservationManifest =
      mocks.reserveKnowledgeBaseTurnWithAttachments.mock.calls[0]![1]
        .attachmentManifest;
    expect(mocks.reserveKnowledgeBaseTurnWithAttachments).toHaveBeenCalledWith(
      [
        {
          role: "user",
          content: [{ type: "input_text", text: "请结合附件修订" }],
        },
      ],
      expect.objectContaining({
        conversationId: "test-conv-id",
        clientRequestId: expect.any(String),
        expectedGeneration: 3,
        expectedRevision: 7,
        expectedLeafId: "2.1",
        attachmentManifest: [
          {
            filename: "facts.pdf",
            sizeBytes: 5,
            mimeType: "application/pdf",
            lastModified: 1_700_000_000_000,
            itemId: expect.any(String),
            ordinal: 1,
            total: 1,
          },
        ],
      }),
    );
    const uploadOptions = mocks.uploadFile.mock.calls[0]![3];
    expect(uploadOptions).toEqual(
      expect.objectContaining({
        captureLocalCopy: true,
        captureFilename: "facts.pdf",
        batchId: expect.any(String),
        batchOrdinal: 1,
        batchTotal: 1,
        itemId: reservationManifest[0].itemId,
        resumeScope: {
          kind: "knowledge_base",
          operationType: "revise",
          conversationId: "test-conv-id",
          turnId: "reserved-turn-1",
          clientRequestId:
            mocks.reserveKnowledgeBaseTurnWithAttachments.mock.calls[0]![1]
              .clientRequestId,
          expectedResetRevision: 4,
        },
      }),
    );
    expect(reservationManifest[0]).not.toHaveProperty("sha256");
    expect(uploadOptions).not.toHaveProperty("contentSha256");
    expect(mocks.sha256UploadFile).not.toHaveBeenCalled();
    expect(uploadOptions.batchId).toBe(
      String(reservationManifest[0].itemId).split(":1")[0],
    );
    expect(mocks.stageKnowledgeBaseTurnAttachment).toHaveBeenCalledWith({
      conversationId: "test-conv-id",
      turnId: "reserved-turn-1",
      clientRequestId:
        mocks.reserveKnowledgeBaseTurnWithAttachments.mock.calls[0]![1]
          .clientRequestId,
      expectedResetRevision: 4,
      attachmentManifest: reservationManifest,
      index: 0,
      attachment: { file_id: "file-facts.pdf", filename: "facts.pdf" },
    });
    expect(
      mocks.reserveKnowledgeBaseTurnWithAttachments.mock.invocationCallOrder[0],
    ).toBeLessThan(mocks.uploadFile.mock.invocationCallOrder[0]);
    expect(mocks.uploadFile.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.stageKnowledgeBaseTurnAttachment.mock.invocationCallOrder[0],
    );
    expect(mocks.providerV1UploadFile).not.toHaveBeenCalled();
    expect(
      mocks.stageKnowledgeBaseTurnAttachment.mock.invocationCallOrder[0],
    ).toBeLessThan(
      mocks.createKnowledgeBaseTurnTask.mock.invocationCallOrder[0],
    );
    expect(mocks.createKnowledgeBaseTurnTask).toHaveBeenCalledWith(
      [
        {
          role: "user",
          content: expect.arrayContaining([
            expect.objectContaining({ type: "input_text" }),
            expect.objectContaining({
              type: "input_file",
              file_id: "file-facts.pdf",
              filename: "facts.pdf",
            }),
          ]),
        },
      ],
      expect.objectContaining({
        attachmentReservation: {
          turnId: "reserved-turn-1",
          sourceResetRevision: 4,
          attachmentManifest: reservationManifest,
        },
      }),
    );
    const pendingMessages = mocks.addMessage.mock.calls.filter(
      ([, message]) => message.knowledgeBase?.kind === "pending_user",
    );
    expect(pendingMessages).toHaveLength(1);
    expect(pendingMessages[0]?.[1]).toMatchObject({
      knowledgeBase: {
        clientRequestId: expect.any(String),
      },
    });
    expect(pendingMessages[0]?.[1].attachments?.[0]).toEqual(
      expect.objectContaining({
        fileId: "file-facts.pdf",
        name: "facts.pdf",
      }),
    );
    expect(pendingMessages[0]?.[1].attachments?.[0]?.file).toBeUndefined();
    expect(pendingMessages[0]?.[1].attachments?.[0]?.base64).toBeUndefined();
    expect(pendingMessages[0]?.[1].attachments?.[0]?.blobUrl).toBeUndefined();
    expect(mocks.fileToBase64).not.toHaveBeenCalled();
    expect(mocks.uploadFile.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.addMessage.mock.invocationCallOrder[0],
    );
  });

  it("skips empty receipt projection and duplicate staging when upload retry resumes an already staged ordinal", async () => {
    const file = new File(["facts"], "facts.pdf", {
      type: "application/pdf",
      lastModified: 1_700_000_000_000,
    });
    const knowledgeObservation = {
      generation: 3,
      stateEpoch: 8,
      interaction: { interactionState: "queued" },
    };
    mockPreparedFiles([file]);
    mocks.uploadFile.mockResolvedValueOnce({
      fileId: "",
      filename: "facts.pdf",
      sizeBytes: file.size,
      uploadedAt: 1_000,
      expiresAt: 1_000,
      replayed: true,
      recovered: true,
      alreadyStaged: true,
      knowledgeObservation,
    });
    const { result } = renderHook(() => useSendMessage());

    await act(async () => {
      await result.current.sendMessage("请结合附件修订", [file], {
        syncKnowledgeBaseSnapshot: true,
        knowledgeBaseExpectedResetRevision: 4,
        knowledgeBaseExpectedGeneration: 3,
        knowledgeBaseExpectedRevision: 7,
        knowledgeBaseExpectedLeafId: "2.1",
      });
    });

    expect(mocks.stageKnowledgeBaseTurnAttachment).not.toHaveBeenCalled();
    expect(mocks.commitKnowledgeBaseObservation).toHaveBeenCalledWith(
      "test-conv-id",
      knowledgeObservation,
    );
    expect(mocks.createKnowledgeBaseTurnTask).toHaveBeenCalledWith(
      [
        {
          role: "user",
          content: [{ type: "input_text", text: "请结合附件修订" }],
        },
      ],
      expect.objectContaining({
        attachmentReservation: expect.objectContaining({
          turnId: "reserved-turn-1",
        }),
      }),
    );
    const pendingMessages = mocks.addMessage.mock.calls.filter(
      ([, message]) => message.knowledgeBase?.kind === "pending_user",
    );
    expect(pendingMessages).toHaveLength(1);
    expect(pendingMessages[0]?.[1].attachments).toBeUndefined();
  });

  it("uses one frozen reservation and stages every attachment before one dispatch", async () => {
    const first = new File(["a"], "a.txt", {
      type: "text/plain",
      lastModified: 10,
    });
    const second = new File(["b"], "b.txt", {
      type: "text/plain",
      lastModified: 20,
    });
    mockPreparedFiles([first, second]);
    const { result } = renderHook(() => useSendMessage());
    await act(async () => {
      await result.current.sendMessage("", [first, second], {
        syncKnowledgeBaseSnapshot: true,
        knowledgeBaseExpectedResetRevision: 4,
        knowledgeBaseExpectedGeneration: 3,
        knowledgeBaseExpectedRevision: 7,
        knowledgeBaseExpectedLeafId: "2.1",
      });
    });

    expect(mocks.uploadFile).toHaveBeenCalledTimes(2);
    expect(mocks.reserveKnowledgeBaseTurnWithAttachments).toHaveBeenCalledTimes(
      1,
    );
    expect(mocks.stageKnowledgeBaseTurnAttachment).toHaveBeenCalledTimes(2);
    const reservationContext =
      mocks.reserveKnowledgeBaseTurnWithAttachments.mock.calls[0]![1];
    const reservationManifest = reservationContext.attachmentManifest;
    expect(reservationManifest).toEqual([
      expect.objectContaining({
        filename: "a.txt",
        ordinal: 1,
        total: 2,
        itemId: expect.any(String),
      }),
      expect.objectContaining({
        filename: "b.txt",
        ordinal: 2,
        total: 2,
        itemId: expect.any(String),
      }),
    ]);
    const firstUploadOptions = mocks.uploadFile.mock.calls[0]![3];
    const secondUploadOptions = mocks.uploadFile.mock.calls[1]![3];
    expect(firstUploadOptions).toEqual(
      expect.objectContaining({
        batchId: expect.any(String),
        batchOrdinal: 1,
        batchTotal: 2,
        itemId: reservationManifest[0].itemId,
        resumeScope: expect.objectContaining({
          turnId: "reserved-turn-1",
          clientRequestId: reservationContext.clientRequestId,
          expectedResetRevision: 4,
        }),
      }),
    );
    expect(secondUploadOptions).toEqual(
      expect.objectContaining({
        batchId: firstUploadOptions.batchId,
        batchOrdinal: 2,
        batchTotal: 2,
        itemId: reservationManifest[1].itemId,
        resumeScope: firstUploadOptions.resumeScope,
      }),
    );
    expect(mocks.stageKnowledgeBaseTurnAttachment.mock.calls).toEqual([
      [
        expect.objectContaining({
          attachmentManifest: reservationManifest,
          index: 0,
          attachment: { file_id: "file-a.txt", filename: "a.txt" },
        }),
      ],
      [
        expect.objectContaining({
          attachmentManifest: reservationManifest,
          index: 1,
          attachment: { file_id: "file-b.txt", filename: "b.txt" },
        }),
      ],
    ]);
    expect(
      mocks.reserveKnowledgeBaseTurnWithAttachments.mock.invocationCallOrder[0],
    ).toBeLessThan(mocks.uploadFile.mock.invocationCallOrder[0]);
    expect(mocks.uploadFile.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.stageKnowledgeBaseTurnAttachment.mock.invocationCallOrder[0],
    );
    expect(
      mocks.stageKnowledgeBaseTurnAttachment.mock.invocationCallOrder[0],
    ).toBeLessThan(mocks.uploadFile.mock.invocationCallOrder[1]);
    expect(mocks.uploadFile.mock.invocationCallOrder[1]).toBeLessThan(
      mocks.stageKnowledgeBaseTurnAttachment.mock.invocationCallOrder[1],
    );
    expect(
      mocks.stageKnowledgeBaseTurnAttachment.mock.invocationCallOrder[1],
    ).toBeLessThan(
      mocks.createKnowledgeBaseTurnTask.mock.invocationCallOrder[0],
    );
    expect(mocks.createKnowledgeBaseTurnTask).toHaveBeenCalledWith(
      [
        {
          role: "user",
          content: [
            expect.objectContaining({ file_id: "file-a.txt" }),
            expect.objectContaining({ file_id: "file-b.txt" }),
          ],
        },
      ],
      expect.objectContaining({
        attachmentReservation: {
          turnId: "reserved-turn-1",
          sourceResetRevision: 4,
          attachmentManifest: reservationManifest,
        },
      }),
    );
    expect(mocks.createKnowledgeBaseTurnTask).toHaveBeenCalledTimes(1);
  });

  it("uses one normalized filename for capture, manifest and the knowledge turn body", async () => {
    const file = new File(["image"], `${"a".repeat(159)}😀tail.png`, {
      type: "image/png",
      lastModified: 30,
    });
    const normalized = `${"a".repeat(159)}😀`;
    mockPreparedFiles([file]);
    mocks.normalizedKnowledgeBaseUploadFilename.mockReturnValue(normalized);

    const { result } = renderHook(() => useSendMessage());
    await act(async () => {
      await result.current.sendMessage("补充图片", [file], {
        syncKnowledgeBaseSnapshot: true,
        knowledgeBaseExpectedResetRevision: 4,
        knowledgeBaseExpectedGeneration: 3,
        knowledgeBaseExpectedRevision: 7,
        knowledgeBaseExpectedLeafId: "2.1",
      });
    });

    expect(mocks.uploadFile).toHaveBeenCalledWith(
      file,
      expect.any(Function),
      expect.any(Object),
      expect.objectContaining({
        captureLocalCopy: true,
        captureFilename: normalized,
        batchId: expect.any(String),
        batchOrdinal: 1,
        batchTotal: 1,
        itemId: expect.any(String),
        resumeScope: expect.objectContaining({
          kind: "knowledge_base",
          conversationId: "test-conv-id",
          turnId: "reserved-turn-1",
        }),
      }),
    );
    expect(mocks.createKnowledgeBaseTurnTask).toHaveBeenCalledWith(
      [
        {
          role: "user",
          content: expect.arrayContaining([
            expect.objectContaining({
              type: "input_file",
              filename: normalized,
            }),
          ]),
        },
      ],
      expect.objectContaining({
        attachmentReservation: {
          turnId: "reserved-turn-1",
          sourceResetRevision: 4,
          attachmentManifest: [
            expect.objectContaining({ filename: normalized }),
          ],
        },
      }),
    );
  });

  it("does not send browser bytes or add a user bubble when attachment reservation fails", async () => {
    const file = new File(["facts"], "facts.pdf", {
      type: "application/pdf",
      lastModified: 40,
    });
    mockPreparedFiles([file]);
    mocks.reserveKnowledgeBaseTurnWithAttachments.mockRejectedValueOnce(
      new Error("reservation unavailable"),
    );

    const { result } = renderHook(() => useSendMessage());
    let submitted = true;
    await act(async () => {
      submitted = await result.current.sendMessage("请结合附件修订", [file], {
        syncKnowledgeBaseSnapshot: true,
        knowledgeBaseExpectedResetRevision: 4,
        knowledgeBaseExpectedGeneration: 3,
        knowledgeBaseExpectedRevision: 7,
        knowledgeBaseExpectedLeafId: "2.1",
      });
    });

    expect(submitted).toBe(false);
    expect(mocks.reserveKnowledgeBaseTurnWithAttachments).toHaveBeenCalledTimes(
      1,
    );
    expect(mocks.uploadFile).not.toHaveBeenCalled();
    expect(mocks.stageKnowledgeBaseTurnAttachment).not.toHaveBeenCalled();
    expect(mocks.createKnowledgeBaseTurnTask).not.toHaveBeenCalled();
    expect(mocks.addMessage).not.toHaveBeenCalled();
  });

  it("does not dispatch or duplicate the user bubble when staging fails", async () => {
    const file = new File(["facts"], "facts.pdf", {
      type: "application/pdf",
      lastModified: 50,
    });
    mockPreparedFiles([file]);
    mocks.stageKnowledgeBaseTurnAttachment.mockRejectedValueOnce(
      new Error("stage unavailable"),
    );

    const { result } = renderHook(() => useSendMessage());
    let submitted = true;
    await act(async () => {
      submitted = await result.current.sendMessage("请结合附件修订", [file], {
        syncKnowledgeBaseSnapshot: true,
        knowledgeBaseExpectedResetRevision: 4,
        knowledgeBaseExpectedGeneration: 3,
        knowledgeBaseExpectedRevision: 7,
        knowledgeBaseExpectedLeafId: "2.1",
      });
    });

    expect(submitted).toBe(false);
    expect(mocks.reserveKnowledgeBaseTurnWithAttachments).toHaveBeenCalledTimes(
      1,
    );
    expect(mocks.uploadFile).toHaveBeenCalledTimes(1);
    expect(mocks.stageKnowledgeBaseTurnAttachment).toHaveBeenCalledTimes(1);
    expect(mocks.createKnowledgeBaseTurnTask).not.toHaveBeenCalled();
    expect(mocks.addMessage).not.toHaveBeenCalled();
    expect(mocks.wakeKnowledgeBaseConversation).not.toHaveBeenCalled();
    expect(result.current.knowledgeBaseAttachmentAttempt).toMatchObject({
      submissionKind: "start",
      generation: 3,
      resetRevision: 4,
    });
    expect(
      Number.isFinite(
        result.current.knowledgeBaseAttachmentAttempt?.generation ?? NaN,
      ),
    ).toBe(true);
    expect(
      Number.isFinite(
        result.current.knowledgeBaseAttachmentAttempt?.resetRevision ?? NaN,
      ),
    ).toBe(true);
  });

  it("retries a lost reservation response with the same frozen request and body", async () => {
    const file = new File(["facts"], "facts.pdf", {
      type: "application/pdf",
      lastModified: 45,
    });
    mockPreparedFiles([file]);
    mocks.reserveKnowledgeBaseTurnWithAttachments.mockRejectedValueOnce(
      new TypeError("Failed to fetch"),
    );

    const { result } = renderHook(() => useSendMessage());
    await act(async () => {
      await result.current.sendMessage("请结合附件修订", [file], {
        syncKnowledgeBaseSnapshot: true,
        knowledgeBaseExpectedResetRevision: 4,
        knowledgeBaseExpectedGeneration: 3,
        knowledgeBaseExpectedStateEpoch: 8,
        knowledgeBaseExpectedRevision: 7,
        knowledgeBaseExpectedLeafId: "2.1",
      });
    });

    const failedAttempt = result.current.knowledgeBaseAttachmentAttempt;
    expect(failedAttempt).toMatchObject({ phase: "failed_retryable" });
    expect(failedAttempt?.turnId).toBeUndefined();
    const firstInput =
      mocks.reserveKnowledgeBaseTurnWithAttachments.mock.calls[0]![0];
    const firstContext =
      mocks.reserveKnowledgeBaseTurnWithAttachments.mock.calls[0]![1];

    await act(async () => {
      await result.current.continueKnowledgeBaseAttachmentAttempt();
    });

    expect(mocks.reserveKnowledgeBaseTurnWithAttachments).toHaveBeenCalledTimes(
      2,
    );
    expect(
      mocks.reserveKnowledgeBaseTurnWithAttachments.mock.calls[1]![0],
    ).toEqual(firstInput);
    expect(
      mocks.reserveKnowledgeBaseTurnWithAttachments.mock.calls[1]![1],
    ).toEqual(firstContext);
    expect(firstContext.clientRequestId).toBe(failedAttempt?.clientRequestId);
    expect(mocks.uploadFile).toHaveBeenCalledTimes(1);
    expect(mocks.stageKnowledgeBaseTurnAttachment).toHaveBeenCalledTimes(1);
    expect(mocks.createKnowledgeBaseTurnTask).toHaveBeenCalledTimes(1);
  });

  it("classifies an attachment attempt as revise from an initialized active Working Set", async () => {
    const file = new File(["facts"], "facts.pdf", {
      type: "application/pdf",
      lastModified: 50,
    });
    mockPreparedFiles([file]);
    mocks.stageKnowledgeBaseTurnAttachment.mockRejectedValueOnce(
      new Error("stage unavailable"),
    );
    mocks.useConversation.mockReturnValue(
      mockConversationContext({
        activeConversation: {
          id: "test-conv-id",
          status: "awaiting_input",
          messages: [],
          lastKnownOutputLength: 0,
          knowledgeBase: {
            initialized: true,
            generation: 3,
            stateEpoch: 8,
            contentVersion: 7,
          },
        },
      }),
    );

    const { result } = renderHook(() => useSendMessage());
    await act(async () => {
      await result.current.sendMessage("请结合附件修订", [file], {
        syncKnowledgeBaseSnapshot: true,
        knowledgeBaseExpectedResetRevision: 4,
        knowledgeBaseExpectedGeneration: 3,
        knowledgeBaseExpectedStateEpoch: 8,
        knowledgeBaseExpectedContentVersion: 7,
        knowledgeBaseExpectedRevision: 7,
        knowledgeBaseExpectedLeafId: "2.1",
      });
    });

    expect(result.current.knowledgeBaseAttachmentAttempt).toMatchObject({
      submissionKind: "revise",
      generation: 3,
      stateEpoch: 8,
      resetRevision: 4,
      expectedContentVersion: 7,
    });
  });

  it("continues a failed stage with the same reservation and provider-free local receipt", async () => {
    const file = new File(["facts"], "facts.pdf", {
      type: "application/pdf",
      lastModified: 51,
    });
    mockPreparedFiles([file]);
    mocks.stageKnowledgeBaseTurnAttachment.mockRejectedValueOnce(
      new Error("stage unavailable"),
    );

    const { result } = renderHook(() => useSendMessage());
    await act(async () => {
      await result.current.sendMessage("请结合附件修订", [file], {
        syncKnowledgeBaseSnapshot: true,
        knowledgeBaseExpectedResetRevision: 4,
        knowledgeBaseExpectedGeneration: 3,
        knowledgeBaseExpectedStateEpoch: 8,
        knowledgeBaseExpectedContentVersion: 7,
        knowledgeBaseExpectedRevision: 7,
        knowledgeBaseExpectedLeafId: "2.1",
        knowledgeBaseExpectedPresentationKey: "presentation-7",
      });
    });

    const failedAttempt = result.current.knowledgeBaseAttachmentAttempt;
    expect(failedAttempt).toMatchObject({
      phase: "failed_retryable",
      turnId: "reserved-turn-1",
      generation: 3,
      stateEpoch: 8,
      resetRevision: 4,
      expectedContentVersion: 7,
      expectedRevision: 7,
      expectedLeafId: "2.1",
      expectedPresentationKey: "presentation-7",
    });
    expect(failedAttempt?.files[0]?.file).toBe(file);
    const frozenRequestId = failedAttempt?.clientRequestId;
    const frozenItemId = failedAttempt?.files[0]?.itemId;

    await act(async () => {
      await result.current.continueKnowledgeBaseAttachmentAttempt();
    });

    expect(mocks.reserveKnowledgeBaseTurnWithAttachments).toHaveBeenCalledTimes(
      1,
    );
    expect(mocks.uploadFile).toHaveBeenCalledTimes(1);
    expect(mocks.stageKnowledgeBaseTurnAttachment).toHaveBeenCalledTimes(2);
    expect(
      mocks.stageKnowledgeBaseTurnAttachment.mock.calls[1]?.[0],
    ).toMatchObject({
      turnId: "reserved-turn-1",
      clientRequestId: frozenRequestId,
      attachmentManifest: [expect.objectContaining({ itemId: frozenItemId })],
      attachment: { file_id: "file-facts.pdf", filename: "facts.pdf" },
    });
    expect(mocks.createKnowledgeBaseTurnTask).toHaveBeenCalledTimes(1);
    expect(mocks.createKnowledgeBaseTurnTask.mock.calls[0]?.[1]).toMatchObject({
      clientRequestId: frozenRequestId,
      attachmentReservation: { turnId: "reserved-turn-1" },
    });
    expect(mocks.addMessage).toHaveBeenCalledTimes(1);
    expect(result.current.knowledgeBaseAttachmentAttempt).toBeNull();
  });

  it("reuses completed stage receipts and resumes only the first unfinished item", async () => {
    const first = new File(["a"], "a.txt", {
      type: "text/plain",
      lastModified: 10,
    });
    const second = new File(["b"], "b.txt", {
      type: "text/plain",
      lastModified: 20,
    });
    mockPreparedFiles([first, second]);
    mocks.uploadFile
      .mockImplementationOnce(async () => ({
        fileId: "file-a.txt",
        filename: "a.txt",
        sizeBytes: 1,
        uploadedAt: 1_000,
        expiresAt: 2_593_000_000,
        replayed: false,
        recovered: false,
      }))
      .mockRejectedValueOnce(new Error("second upload interrupted"));

    const { result } = renderHook(() => useSendMessage());
    await act(async () => {
      await result.current.sendMessage("补充资料", [first, second], {
        syncKnowledgeBaseSnapshot: true,
        knowledgeBaseExpectedResetRevision: 4,
        knowledgeBaseExpectedGeneration: 3,
        knowledgeBaseExpectedStateEpoch: 8,
        knowledgeBaseExpectedRevision: 7,
        knowledgeBaseExpectedLeafId: "2.1",
      });
    });

    expect(
      result.current.knowledgeBaseAttachmentAttempt?.files[0],
    ).toMatchObject({ stagedReceipt: { fileId: "file-a.txt" } });
    expect(
      result.current.knowledgeBaseAttachmentAttempt?.files[1]?.stagedReceipt,
    ).toBeUndefined();

    await act(async () => {
      await result.current.continueKnowledgeBaseAttachmentAttempt();
    });

    expect(mocks.reserveKnowledgeBaseTurnWithAttachments).toHaveBeenCalledTimes(
      1,
    );
    expect(mocks.uploadFile).toHaveBeenCalledTimes(3);
    expect(mocks.uploadFile.mock.calls[2]?.[0]).toBe(second);
    expect(mocks.stageKnowledgeBaseTurnAttachment).toHaveBeenCalledTimes(2);
    expect(
      mocks.stageKnowledgeBaseTurnAttachment.mock.calls[1]?.[0],
    ).toMatchObject({ index: 1, attachment: { file_id: "file-b.txt" } });
    expect(mocks.createKnowledgeBaseTurnTask).toHaveBeenCalledTimes(1);
  });

  it("keeps Files while a dispatch response is unknown and never exposes it as a retryable upload", async () => {
    const file = new File(["facts"], "facts.pdf", {
      type: "application/pdf",
      lastModified: 52,
    });
    mockPreparedFiles([file]);
    mocks.createKnowledgeBaseTurnTask.mockRejectedValueOnce(
      new TypeError("Failed to fetch"),
    );

    const { result } = renderHook(() => useSendMessage());
    let submitted = true;
    await act(async () => {
      submitted = await result.current.sendMessage("请结合附件修订", [file], {
        syncKnowledgeBaseSnapshot: true,
        knowledgeBaseExpectedResetRevision: 4,
        knowledgeBaseExpectedGeneration: 3,
        knowledgeBaseExpectedStateEpoch: 8,
        knowledgeBaseExpectedRevision: 7,
        knowledgeBaseExpectedLeafId: "2.1",
      });
    });

    expect(submitted).toBe(false);
    expect(result.current.knowledgeBaseAttachmentAttempt).toMatchObject({
      phase: "reconciling_dispatch",
      turnId: "reserved-turn-1",
    });
    expect(result.current.knowledgeBaseAttachmentAttempt?.files[0]?.file).toBe(
      file,
    );
    await act(async () => {
      expect(
        await result.current.continueKnowledgeBaseAttachmentAttempt(),
      ).toBe(false);
    });
    expect(mocks.createKnowledgeBaseTurnTask).toHaveBeenCalledTimes(1);
    expect(mocks.rollbackPendingKnowledgeBaseTurn).not.toHaveBeenCalled();
  });

  it("does not mistake an awaiting reservation observation for accepted dispatch", async () => {
    const file = new File(["facts"], "facts.pdf", {
      type: "application/pdf",
      lastModified: 57,
    });
    mockPreparedFiles([file]);
    mocks.createKnowledgeBaseTurnTask.mockImplementationOnce(
      async (_input: unknown, context: any) => {
        throw Object.assign(new TypeError("Failed to fetch"), {
          knowledgeObservation: {
            stateEpoch: 8,
            generation: 3,
            authoritativeTaskId: null,
            activeTurn: {
              id: "reserved-turn-1",
              clientRequestId: context.clientRequestId,
              operationKey: "operation-upload",
              operationType: "revise",
              status: "pending",
              buildGeneration: 3,
              expectedRevision: 7,
              expectedLeafId: "2.1",
              startedAt: null,
              completedAt: null,
              updatedAt: 8,
              resetRevision: 4,
              awaitingClientAttachments: true,
              requiresAttachmentReselection: true,
              stagedAttachmentCount: 1,
              expectedAttachmentCount: 1,
            },
            interaction: {
              progress: null,
              interactionState: "queued",
              canReply: false,
              canPublish: false,
              lockReason: "正在等待附件派发",
            },
            approvedPresentation: null,
            package: null,
            notice: null,
            conversationVersion: 8,
          },
        });
      },
    );

    const { result } = renderHook(() => useSendMessage());
    let submitted = true;
    await act(async () => {
      submitted = await result.current.sendMessage("请结合附件修订", [file], {
        syncKnowledgeBaseSnapshot: true,
        knowledgeBaseExpectedResetRevision: 4,
        knowledgeBaseExpectedGeneration: 3,
        knowledgeBaseExpectedStateEpoch: 8,
        knowledgeBaseExpectedRevision: 7,
        knowledgeBaseExpectedLeafId: "2.1",
      });
    });

    expect(submitted).toBe(false);
    expect(mocks.commitKnowledgeBaseObservation).toHaveBeenCalledTimes(1);
    expect(result.current.knowledgeBaseAttachmentAttempt).toMatchObject({
      phase: "reconciling_dispatch",
      turnId: "reserved-turn-1",
    });
    expect(result.current.knowledgeBaseAttachmentAttempt?.files[0]?.file).toBe(
      file,
    );
    expect(mocks.createKnowledgeBaseTurnTask).toHaveBeenCalledTimes(1);
  });

  it("releases a reconciling attempt only after the matching request is durably active", async () => {
    const file = new File(["facts"], "facts.pdf", {
      type: "application/pdf",
      lastModified: 56,
    });
    mockPreparedFiles([file]);
    mocks.createKnowledgeBaseTurnTask.mockRejectedValueOnce(
      new TypeError("Failed to fetch"),
    );
    const activeConversation = {
      id: "test-conv-id",
      status: "running",
      messages: [] as any[],
      lastKnownOutputLength: 0,
      knowledgeBase: {
        initialized: true,
        generation: 3,
        stateEpoch: 8,
        activeTurnId: null as string | null,
        activeClientRequestId: null as string | null,
        activeTurnResetRevision: 4,
        activeTurnAwaitingClientAttachments: true,
      },
    };
    mocks.useConversation.mockReturnValue(
      mockConversationContext({ activeConversation }),
    );

    const hook = renderHook(() => useSendMessage());
    await act(async () => {
      await hook.result.current.sendMessage("补充资料", [file], {
        syncKnowledgeBaseSnapshot: true,
        knowledgeBaseExpectedResetRevision: 4,
        knowledgeBaseExpectedGeneration: 3,
        knowledgeBaseExpectedStateEpoch: 8,
        knowledgeBaseExpectedRevision: 7,
        knowledgeBaseExpectedLeafId: "2.1",
      });
    });
    const attempt = hook.result.current.knowledgeBaseAttachmentAttempt;
    expect(attempt?.phase).toBe("reconciling_dispatch");

    mocks.useConversation.mockReturnValue(
      mockConversationContext({
        activeConversation: {
          ...activeConversation,
          knowledgeBase: {
            ...activeConversation.knowledgeBase,
            activeClientRequestId: attempt!.clientRequestId,
            activeTurnId: attempt!.turnId!,
            activeTurnAwaitingClientAttachments: false,
          },
        },
      }),
    );
    hook.rerender();

    await waitFor(() =>
      expect(hook.result.current.knowledgeBaseAttachmentAttempt).toBeNull(),
    );
  });

  it("does not restore a File attempt after unmount or persist it in browser storage", async () => {
    const file = new File(["facts"], "facts.pdf", {
      type: "application/pdf",
      lastModified: 53,
    });
    mockPreparedFiles([file]);
    mocks.stageKnowledgeBaseTurnAttachment.mockRejectedValueOnce(
      new Error("stage unavailable"),
    );
    const storageSpy = vi.spyOn(Storage.prototype, "setItem");

    const first = renderHook(() => useSendMessage());
    await act(async () => {
      await first.result.current.sendMessage("补充资料", [file], {
        syncKnowledgeBaseSnapshot: true,
        knowledgeBaseExpectedResetRevision: 4,
        knowledgeBaseExpectedGeneration: 3,
        knowledgeBaseExpectedStateEpoch: 8,
        knowledgeBaseExpectedRevision: 7,
        knowledgeBaseExpectedLeafId: "2.1",
      });
    });
    expect(
      first.result.current.knowledgeBaseAttachmentAttempt?.files[0]?.file,
    ).toBe(file);
    expect(storageSpy).not.toHaveBeenCalled();
    first.unmount();

    const second = renderHook(() => useSendMessage());
    expect(second.result.current.knowledgeBaseAttachmentAttempt).toBeNull();
    second.unmount();
    storageSpy.mockRestore();
  });

  it("clears a page-memory attempt when the active conversation changes", async () => {
    const file = new File(["facts"], "facts.pdf", {
      type: "application/pdf",
      lastModified: 54,
    });
    mockPreparedFiles([file]);
    mocks.stageKnowledgeBaseTurnAttachment.mockRejectedValueOnce(
      new Error("stage unavailable"),
    );
    mocks.useConversation.mockReturnValue(
      mockConversationContext({
        activeConversation: {
          id: "test-conv-id",
          status: "running",
          messages: [],
          lastKnownOutputLength: 0,
          knowledgeBase: {
            initialized: true,
            generation: 3,
            stateEpoch: 8,
          },
        },
      }),
    );

    const hook = renderHook(() => useSendMessage());
    await act(async () => {
      await hook.result.current.sendMessage("补充资料", [file], {
        syncKnowledgeBaseSnapshot: true,
        knowledgeBaseExpectedResetRevision: 4,
        knowledgeBaseExpectedGeneration: 3,
        knowledgeBaseExpectedStateEpoch: 8,
        knowledgeBaseExpectedRevision: 7,
        knowledgeBaseExpectedLeafId: "2.1",
      });
    });
    expect(hook.result.current.knowledgeBaseAttachmentAttempt).not.toBeNull();

    mocks.useConversation.mockReturnValue(
      mockConversationContext({
        activeConversation: {
          id: "another-conversation",
          status: "awaiting_input",
          messages: [],
        },
      }),
    );
    hook.rerender();
    await waitFor(() =>
      expect(hook.result.current.knowledgeBaseAttachmentAttempt).toBeNull(),
    );
  });

  it("clears a page-memory attempt when the reset revision changes", async () => {
    const file = new File(["facts"], "facts.pdf", {
      type: "application/pdf",
      lastModified: 55,
    });
    mockPreparedFiles([file]);
    mocks.stageKnowledgeBaseTurnAttachment.mockRejectedValueOnce(
      new Error("stage unavailable"),
    );
    const activeConversation = {
      id: "test-conv-id",
      status: "running",
      messages: [],
      lastKnownOutputLength: 0,
      knowledgeBase: {
        initialized: true,
        generation: 3,
        stateEpoch: 8,
        activeTurnResetRevision: 4,
      },
    };
    mocks.useConversation.mockReturnValue(
      mockConversationContext({ activeConversation }),
    );

    const hook = renderHook(() => useSendMessage());
    await act(async () => {
      await hook.result.current.sendMessage("补充资料", [file], {
        syncKnowledgeBaseSnapshot: true,
        knowledgeBaseExpectedResetRevision: 4,
        knowledgeBaseExpectedGeneration: 3,
        knowledgeBaseExpectedStateEpoch: 8,
        knowledgeBaseExpectedRevision: 7,
        knowledgeBaseExpectedLeafId: "2.1",
      });
    });
    expect(hook.result.current.knowledgeBaseAttachmentAttempt).not.toBeNull();

    mocks.useConversation.mockReturnValue(
      mockConversationContext({
        activeConversation: {
          ...activeConversation,
          knowledgeBase: {
            ...activeConversation.knowledgeBase,
            activeTurnResetRevision: 5,
          },
        },
      }),
    );
    hook.rerender();
    await waitFor(() =>
      expect(hook.result.current.knowledgeBaseAttachmentAttempt).toBeNull(),
    );
  });

  it("stores ordinary-agent uploads as local assets", async () => {
    const file = new File(["report"], "report.pdf", {
      type: "application/pdf",
    });
    mockPreparedFiles([file]);

    const { result } = renderHook(() => useSendMessage());
    await act(async () => {
      await result.current.sendMessage("请阅读", [file]);
    });

    expect(mocks.uploadChatLocalAsset).toHaveBeenCalledWith(
      file,
      expect.any(Function),
    );
    expect(mocks.uploadFile).not.toHaveBeenCalled();
  });

  it("rejects an oversized attachment before preparation or upload", async () => {
    const file = new File(["x"], "oversized.pdf", {
      type: "application/pdf",
    });
    mocks.assertChatAttachmentSizes.mockImplementationOnce(() => {
      throw new Error("文件“oversized.pdf”不能超过 100 MB");
    });

    const { result } = renderHook(() => useSendMessage());
    let sent = true;
    await act(async () => {
      sent = await result.current.sendMessage("请阅读", [file]);
    });

    expect(sent).toBe(false);
    expect(mocks.prepareUploadFiles).not.toHaveBeenCalled();
    expect(mocks.uploadChatLocalAsset).not.toHaveBeenCalled();
    expect(mocks.uploadFile).not.toHaveBeenCalled();
    expect(mocks.createTask).not.toHaveBeenCalled();
  });

  it("starts a fresh reservation instead of taking over an old attachment turn", async () => {
    const file = new File(["a"], "a.txt", {
      type: "text/plain",
      lastModified: 10,
    });
    mockPreparedFiles([file]);
    mocks.useConversation.mockReturnValue(
      mockConversationContext({
        activeConversation: {
          id: "conversation-resume",
          title: "企业知识库构建",
          status: "running",
          messages: [
            {
              id: "existing-pending",
              role: "user",
              content: "请结合原附件修订",
              timestamp: 1,
              knowledgeBase: {
                kind: "pending_user",
                clientRequestId: "original-request",
                turnId: "reserved-turn",
              },
            },
          ],
          knowledgeBase: {
            activeClientRequestId: "original-request",
            notice: { code: "KNOWLEDGE_BASE_ATTACHMENTS_REQUIRED" },
          },
          lastKnownOutputLength: 0,
        },
      }),
    );
    const { result } = renderHook(() => useSendMessage());
    await act(async () => {
      await result.current.sendMessage("", [file], {
        syncKnowledgeBaseSnapshot: true,
        knowledgeBaseExpectedResetRevision: 4,
        knowledgeBaseExpectedGeneration: 3,
        knowledgeBaseExpectedRevision: 7,
        knowledgeBaseExpectedLeafId: "2.1",
      });
    });

    expect(
      mocks.reserveKnowledgeBaseTurnWithAttachments,
    ).toHaveBeenCalledOnce();
    expect(mocks.stageKnowledgeBaseTurnAttachment).toHaveBeenCalledOnce();
    expect(mocks.uploadFile).toHaveBeenCalledTimes(1);
    expect(mocks.addMessage).toHaveBeenCalledOnce();
    expect(mocks.createKnowledgeBaseTurnTask.mock.calls[0][0]).toEqual([
      {
        role: "user",
        content: [
          expect.objectContaining({
            type: "input_file",
            file_id: "file-a.txt",
            filename: "a.txt",
          }),
        ],
      },
    ]);
    const dispatchContext = mocks.createKnowledgeBaseTurnTask.mock.calls[0][1];
    expect(dispatchContext.clientRequestId).not.toBe("original-request");
    expect(dispatchContext).not.toHaveProperty("legacyAttachmentTakeover");
    expect(dispatchContext).toMatchObject({
      expectedResetRevision: 4,
      attachmentReservation: {
        turnId: "reserved-turn-1",
        sourceResetRevision: 4,
      },
    });
  });

  it("fails before reserve when a legacy notice has no current reset revision", async () => {
    const file = new File(["a"], "a.txt", {
      type: "text/plain",
      lastModified: 10,
    });
    mockPreparedFiles([file]);
    mocks.useConversation.mockReturnValue(
      mockConversationContext({
        activeConversation: {
          id: "conversation-resume",
          title: "企业知识库构建",
          status: "running",
          messages: [],
          knowledgeBase: {
            activeClientRequestId: "original-request",
            notice: { code: "KNOWLEDGE_BASE_ATTACHMENTS_REQUIRED" },
          },
          lastKnownOutputLength: 0,
        },
      }),
    );

    const { result } = renderHook(() => useSendMessage());
    await act(async () => {
      await result.current.sendMessage("", [file], {
        syncKnowledgeBaseSnapshot: true,
        knowledgeBaseExpectedGeneration: 3,
        knowledgeBaseExpectedRevision: 7,
        knowledgeBaseExpectedLeafId: "2.1",
      });
    });

    expect(
      mocks.reserveKnowledgeBaseTurnWithAttachments,
    ).not.toHaveBeenCalled();
    expect(mocks.uploadFile).not.toHaveBeenCalled();
    expect(mocks.addMessage).not.toHaveBeenCalled();
    expect(mocks.createKnowledgeBaseTurnTask).not.toHaveBeenCalled();
    expect(result.current.knowledgeBaseAttachmentAttempt).toBeNull();
    expect(toast.error).toHaveBeenCalledWith("知识库附件坐标不完整", {
      description: "请刷新后重新选择资料；本轮尚未创建上传预约。",
    });
  });

  it("does not retry createTask when upstream is overloaded", async () => {
    mocks.createTask.mockRejectedValueOnce(
      new Error("server is temporarily overloaded, please try again later"),
    );

    const { result } = renderHook(() => useSendMessage());

    await act(async () => {
      await result.current.sendMessage("hello", []);
    });

    expect(mocks.createTask).toHaveBeenCalledTimes(1);
    expect(mocks.retrieveTask).not.toHaveBeenCalled();

    const assistantError = mocks.addMessage.mock.calls.find(
      ([, message]) => message.role === "assistant",
    )?.[1];
    expect(assistantError?.content).toContain("服务暂时繁忙");
    expect(assistantError?.content).not.toContain("API Key 是否正确");
  });

  it("requires a new conversation when rotated credentials cannot continue an attachment task", async () => {
    mocks.createTask.mockRejectedValueOnce(
      new Error("附件不属于当前账号或使用了不同的 API Key，请重新上传该附件"),
    );

    const { result } = renderHook(() => useSendMessage());

    await act(async () => {
      await result.current.sendMessage("continue with attachment", []);
    });

    const assistantError = mocks.addMessage.mock.calls.find(
      ([, message]) => message.role === "assistant",
    )?.[1];
    expect(assistantError?.content).toContain("多个账号可以共享服务连接");
    expect(assistantError?.content).toContain("历史任务与附件仍绑定原服务凭证");
    expect(assistantError?.content).toContain("请新建对话");
    expect(assistantError?.content).not.toContain("当前账号重新上传");
    expect(assistantError?.content).not.toContain("请重新上传该附件");
    expect(assistantError?.content).not.toContain(
      "检查设置中的 API Key 是否正确",
    );
  });

  it("does not retry createTask or start polling after timeout", async () => {
    mocks.createTask.mockRejectedValueOnce(
      new Error("请求超时 (300s)，API 服务器响应过慢。可尝试重新发送。"),
    );

    const { result } = renderHook(() => useSendMessage());

    await act(async () => {
      await result.current.sendMessage("hello", []);
    });

    expect(mocks.createTask).toHaveBeenCalledTimes(1);
    expect(mocks.retrieveTask).not.toHaveBeenCalled();
    expect(mocks.updateStatus).toHaveBeenLastCalledWith(
      "test-conv-id",
      "error",
      expect.objectContaining({
        startedAt: expect.any(Number),
        completedAt: expect.any(Number),
      }),
    );
  });

  it("guards concurrent sends so only one task is created", async () => {
    let resolveTask!: (value: {
      id: string;
      status: "completed";
      output: never[];
    }) => void;
    const pendingTask = new Promise<{
      id: string;
      status: "completed";
      output: never[];
    }>((resolve) => {
      resolveTask = resolve;
    });
    mocks.createTask.mockReturnValueOnce(pendingTask);

    const { result } = renderHook(() => useSendMessage());
    let firstSend!: Promise<boolean>;
    let secondSend!: Promise<boolean>;

    await act(async () => {
      firstSend = result.current.sendMessage("first", []);
      secondSend = result.current.sendMessage("second", []);
      await Promise.resolve();
    });

    expect(mocks.createTask).toHaveBeenCalledTimes(1);

    await act(async () => {
      resolveTask({ id: "test-task-id", status: "completed", output: [] });
      await firstSend;
      await secondSend;
    });

    const userMessages = mocks.addMessage.mock.calls.filter(
      ([, message]) => message.role === "user",
    );
    expect(userMessages).toHaveLength(1);
  });

  it("uploads image files as input_file without base64 or input_image", async () => {
    const originalImage = new File(["image-bytes"], "original.png", {
      type: "image/png",
    });
    mockPreparedFiles([originalImage]);
    mocks.isImageUpload.mockReturnValue(true);

    const { result } = renderHook(() => useSendMessage());

    await act(async () => {
      await result.current.sendMessage("with image", [originalImage]);
    });

    expect(mocks.fileToBase64).not.toHaveBeenCalled();
    expect(mocks.uploadChatLocalAsset).toHaveBeenCalledTimes(1);
    expect(mocks.uploadChatLocalAsset.mock.calls[0][0]).toBe(originalImage);
    expect(mocks.uploadFile).not.toHaveBeenCalled();

    const input = mocks.createTask.mock.calls[0][0][0].content;
    expect(input).toContainEqual(
      expect.objectContaining({
        type: "input_file",
        file_id: "asset_originalpng",
        filename: "original.png",
        mime_type: "image/png",
      }),
    );
    expect(input.some((item: any) => item.type === "input_image")).toBe(false);
  });

  it("adds the ZIP reference prompt when oversized images were packed", async () => {
    const zipFile = new File(
      ["zip-bytes"],
      "frontmind-original-images-20260706.zip",
      {
        type: "application/zip",
      },
    );
    mocks.prepareUploadFiles.mockResolvedValueOnce({
      files: [{ file: zipFile, generatedFromImages: [{ name: "large.png" }] }],
      didZipLargeImages: true,
      zippedImages: [
        {
          name: "large.png",
          width: 12000,
          height: 3000,
          pixels: 36_000_000,
          size: 1024,
        },
      ],
    });

    const { result } = renderHook(() => useSendMessage());

    await act(async () => {
      await result.current.sendMessage("with zip", [
        new File(["x"], "large.png", { type: "image/png" }),
      ]);
    });

    expect(mocks.uploadChatLocalAsset.mock.calls[0][0]).toBe(zipFile);
    const input = mocks.createTask.mock.calls[0][0][0].content;
    expect(input).toContainEqual({
      type: "input_text",
      text: "附件 ZIP 中包含用户上传的原始参考图片，请解压后读取图片内容作为参考。",
    });
    expect(input).toContainEqual(
      expect.objectContaining({
        type: "input_file",
        file_id: "asset_frontmindoriginalimages2026070",
        filename: "frontmind-original-images-20260706.zip",
        mime_type: "application/zip",
      }),
    );
    const persistedMessage = mocks.addMessage.mock.calls.find(
      ([, message]) => message.role === "user",
    )?.[1];
    expect(persistedMessage.generalChatDispatch).toMatchObject({
      providerPrompt:
        "with zip\n附件 ZIP 中包含用户上传的原始参考图片，请解压后读取图片内容作为参考。",
      localAssetIds: ["asset_frontmindoriginalimages2026070"],
      localTaskId: null,
      modelProfile: "frontmind-pro",
    });
  });

  it("does not create a task when file upload fails", async () => {
    const file = new File(["image-bytes"], "original.png", {
      type: "image/png",
    });
    mockPreparedFiles([file]);
    mocks.isImageUpload.mockReturnValue(true);
    mocks.uploadChatLocalAsset.mockRejectedValue(
      new Error("Manus upload failed"),
    );

    const { result } = renderHook(() => useSendMessage());

    await act(async () => {
      await result.current.sendMessage("with image", [file], {
        retryConfig: { maxRetries: 0, initialDelay: 0, maxDelay: 0 },
      });
    });

    expect(mocks.createTask).not.toHaveBeenCalled();
    expect(mocks.uploadFile).not.toHaveBeenCalled();
    expect(mocks.fileToBase64).not.toHaveBeenCalled();
    expect(result.current.uploadProgress).toBeNull();
    expect(toast.error).toHaveBeenCalledWith('文件 "original.png" 上传失败', {
      description: "FrontMind upload failed",
    });
  });

  it("does not create a task when ZIP preparation fails", async () => {
    mocks.prepareUploadFiles.mockRejectedValueOnce(new Error("zip failed"));

    const { result } = renderHook(() => useSendMessage());

    await act(async () => {
      await result.current.sendMessage("with image", [
        new File(["x"], "large.png", { type: "image/png" }),
      ]);
    });

    expect(mocks.uploadFile).not.toHaveBeenCalled();
    expect(mocks.createTask).not.toHaveBeenCalled();
  });

  it("classifies busy errors separately from API key errors", () => {
    expect(classifyFailure("server is temporarily overloaded")).toBe("busy");
    expect(classifyFailure("API Error 504")).toBe("busy");
    expect(classifyFailure("请求超时 (300s)")).toBe("busy");
    expect(classifyFailure("401 unauthorized")).toBe("auth");
  });
});
