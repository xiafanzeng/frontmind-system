import { describe, it, expect, beforeEach, vi } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { toast } from "sonner";
import {
  useSendMessage,
  classifyFailure,
  getTaskPollDelay,
  outputForKnowledgePresentation,
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
  uploadFile: vi.fn(),
  fileToBase64: vi.fn(),
  creditEmit: vi.fn(),
  addMessage: vi.fn(),
  updateStatus: vi.fn(),
  updateAssistantMessages: vi.fn(),
  updateTitle: vi.fn(),
  createConversation: vi.fn(),
  registerKnowledgeBaseConversation: vi.fn(),
  wakeKnowledgeBaseConversation: vi.fn(),
  commitKnowledgeBaseObservation: vi.fn(),
  rollbackPendingKnowledgeBaseTurn: vi.fn(),
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
  createTask: mocks.createTask,
  createKnowledgeBaseTurnTask: mocks.createKnowledgeBaseTurnTask,
  reserveKnowledgeBaseTurnWithAttachments:
    mocks.reserveKnowledgeBaseTurnWithAttachments,
  stageKnowledgeBaseTurnAttachment: mocks.stageKnowledgeBaseTurnAttachment,
  createResponseLogicTask: mocks.createResponseLogicTask,
  retrieveTask: mocks.retrieveTask,
  uploadFile: mocks.uploadFile,
  fileToBase64: mocks.fileToBase64,
  creditEventBus: {
    emit: mocks.creditEmit,
  },
  sanitizeBrandText: (value: string) => value.replace(/Manus/gi, "FrontMind"),
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
    updateStatus: mocks.updateStatus,
    updateAssistantMessages: mocks.updateAssistantMessages,
    updateTitle: mocks.updateTitle,
    createConversation: mocks.createConversation,
    registerKnowledgeBaseConversation: mocks.registerKnowledgeBaseConversation,
    wakeKnowledgeBaseConversation: mocks.wakeKnowledgeBaseConversation,
    commitKnowledgeBaseObservation: mocks.commitKnowledgeBaseObservation,
    rollbackPendingKnowledgeBaseTurn: mocks.rollbackPendingKnowledgeBaseTurn,
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

describe("long-running task polling", () => {
  it("backs off to 30 seconds without a one-hour terminal cutoff", () => {
    expect(getTaskPollDelay(0)).toBe(3_000);
    expect(getTaskPollDelay(5 * 60 * 1000)).toBe(10_000);
    expect(getTaskPollDelay(30 * 60 * 1000)).toBe(30_000);
    expect(getTaskPollDelay(8 * 60 * 60 * 1000)).toBe(30_000);
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
    mocks.fileToBase64.mockResolvedValue("data:text/plain;base64,dGVzdA==");
    mocks.isImageUpload.mockReturnValue(false);
    mocks.normalizedKnowledgeBaseUploadFilename.mockImplementation(
      (filename: string) => filename,
    );
    mocks.normalizedKnowledgeBaseUploadMimeType.mockImplementation(
      (file: File) => file.type || "application/octet-stream",
    );
    mocks.createConversation.mockReturnValue("test-conv-id");
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

  it("enters normal processing and wakes reconciliation while the turn POST is pending", async () => {
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

    expect(mocks.updateStatus).toHaveBeenCalledWith(
      "test-conv-id",
      "running",
      expect.objectContaining({ startedAt: expect.any(Number) }),
    );
    expect(mocks.wakeKnowledgeBaseConversation).toHaveBeenCalledWith(
      "test-conv-id",
    );
    expect(mocks.createKnowledgeBaseTurnTask).toHaveBeenCalledTimes(1);
    expect(mocks.updateStatus.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.createKnowledgeBaseTurnTask.mock.invocationCallOrder[0],
    );
    expect(
      mocks.createKnowledgeBaseTurnTask.mock.invocationCallOrder[0],
    ).toBeLessThan(
      mocks.wakeKnowledgeBaseConversation.mock.invocationCallOrder[0],
    );

    resolveTurn({
      id: "test-kb-task-id",
      status: "running",
      output: [],
    });
    await act(async () => {
      await submission;
    });
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
    expect(mocks.wakeKnowledgeBaseConversation).toHaveBeenCalledTimes(1);
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

  it("uploads the file completely before submitting the knowledge turn", async () => {
    const file = new File(["facts"], "facts.pdf", {
      type: "application/pdf",
      lastModified: 1_700_000_000_000,
    });
    mockPreparedFiles([file]);
    const { result } = renderHook(() => useSendMessage());
    await act(async () => {
      await result.current.sendMessage("请结合附件修订", [file], {
        syncKnowledgeBaseSnapshot: true,
        knowledgeBaseExpectedGeneration: 3,
        knowledgeBaseExpectedRevision: 7,
        knowledgeBaseExpectedLeafId: "2.1",
      });
    });

    expect(
      mocks.reserveKnowledgeBaseTurnWithAttachments,
    ).not.toHaveBeenCalled();
    expect(mocks.stageKnowledgeBaseTurnAttachment).not.toHaveBeenCalled();
    expect(mocks.uploadFile.mock.invocationCallOrder[0]).toBeLessThan(
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
      expect.not.objectContaining({ attachmentReservation: expect.anything() }),
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
    expect(mocks.uploadFile.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.addMessage.mock.invocationCallOrder[0],
    );
  });

  it("uploads every attachment and submits them together exactly once", async () => {
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
        knowledgeBaseExpectedGeneration: 3,
        knowledgeBaseExpectedRevision: 7,
        knowledgeBaseExpectedLeafId: "2.1",
      });
    });

    expect(mocks.uploadFile).toHaveBeenCalledTimes(2);
    expect(
      mocks.reserveKnowledgeBaseTurnWithAttachments,
    ).not.toHaveBeenCalled();
    expect(mocks.stageKnowledgeBaseTurnAttachment).not.toHaveBeenCalled();
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
      expect.not.objectContaining({ attachmentReservation: expect.anything() }),
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
        knowledgeBaseExpectedGeneration: 3,
        knowledgeBaseExpectedRevision: 7,
        knowledgeBaseExpectedLeafId: "2.1",
      });
    });

    expect(mocks.uploadFile).toHaveBeenCalledWith(
      file,
      expect.any(Function),
      expect.any(Object),
      { captureLocalCopy: true, captureFilename: normalized },
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
        expectedGeneration: 3,
        attachmentManifest: [expect.objectContaining({ filename: normalized })],
      }),
    );
  });

  it("captures local copies for ordinary agent uploads", async () => {
    const file = new File(["report"], "report.pdf", {
      type: "application/pdf",
    });
    mockPreparedFiles([file]);

    const { result } = renderHook(() => useSendMessage());
    await act(async () => {
      await result.current.sendMessage("请阅读", [file]);
    });

    expect(mocks.uploadFile).toHaveBeenCalledWith(
      file,
      expect.any(Function),
      expect.any(Object),
      { captureLocalCopy: true },
    );
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
    expect(mocks.uploadFile).not.toHaveBeenCalled();
    expect(mocks.createTask).not.toHaveBeenCalled();
  });

  it("silently completes an old browser attachment reservation through the upload-first turn route", async () => {
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
        knowledgeBaseExpectedGeneration: 3,
        knowledgeBaseExpectedRevision: 7,
        knowledgeBaseExpectedLeafId: "2.1",
      });
    });

    expect(
      mocks.reserveKnowledgeBaseTurnWithAttachments,
    ).not.toHaveBeenCalled();
    expect(mocks.stageKnowledgeBaseTurnAttachment).not.toHaveBeenCalled();
    expect(mocks.uploadFile).toHaveBeenCalledTimes(1);
    expect(mocks.addMessage).not.toHaveBeenCalled();
    expect(mocks.createKnowledgeBaseTurnTask.mock.calls[0][0]).toEqual([
      {
        role: "user",
        content: [
          { type: "input_text", text: "请结合原附件修订" },
          expect.objectContaining({
            type: "input_file",
            file_id: "file-a.txt",
            filename: "a.txt",
          }),
        ],
      },
    ]);
    expect(mocks.createKnowledgeBaseTurnTask.mock.calls[0][1]).toEqual(
      expect.objectContaining({
        clientRequestId: "original-request",
        legacyAttachmentTakeover: {
          attachmentManifest: [
            {
              filename: "a.txt",
              sizeBytes: 1,
              mimeType: "text/plain",
              lastModified: 10,
              sha256: "b".repeat(64),
            },
          ],
        },
      }),
    );
  });

  it("submits a legacy attachment takeover even when the local pending message is gone", async () => {
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

    expect(mocks.uploadFile).toHaveBeenCalledTimes(1);
    expect(mocks.addMessage).not.toHaveBeenCalled();
    expect(mocks.createKnowledgeBaseTurnTask).toHaveBeenCalledWith(
      [
        {
          role: "user",
          content: [
            expect.objectContaining({
              type: "input_file",
              file_id: "file-a.txt",
            }),
          ],
        },
      ],
      expect.objectContaining({
        clientRequestId: "original-request",
        legacyAttachmentTakeover: expect.objectContaining({
          attachmentManifest: [expect.objectContaining({ filename: "a.txt" })],
        }),
      }),
    );
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
    expect(mocks.uploadFile).toHaveBeenCalledTimes(1);
    expect(mocks.uploadFile.mock.calls[0][0]).toBe(originalImage);

    const input = mocks.createTask.mock.calls[0][0][0].content;
    expect(input).toContainEqual(
      expect.objectContaining({
        type: "input_file",
        file_id: "file-original.png",
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

    expect(mocks.uploadFile.mock.calls[0][0]).toBe(zipFile);
    const input = mocks.createTask.mock.calls[0][0][0].content;
    expect(input).toContainEqual({
      type: "input_text",
      text: "附件 ZIP 中包含用户上传的原始参考图片，请解压后读取图片内容作为参考。",
    });
    expect(input).toContainEqual(
      expect.objectContaining({
        type: "input_file",
        file_id: "file-frontmind-original-images-20260706.zip",
        filename: "frontmind-original-images-20260706.zip",
        mime_type: "application/zip",
      }),
    );
  });

  it("does not create a task when file upload fails", async () => {
    const file = new File(["image-bytes"], "original.png", {
      type: "image/png",
    });
    mockPreparedFiles([file]);
    mocks.isImageUpload.mockReturnValue(true);
    mocks.uploadFile.mockRejectedValue(new Error("upload failed"));

    const { result } = renderHook(() => useSendMessage());

    await act(async () => {
      await result.current.sendMessage("with image", [file], {
        retryConfig: { maxRetries: 0, initialDelay: 0, maxDelay: 0 },
      });
    });

    expect(mocks.createTask).not.toHaveBeenCalled();
    expect(mocks.fileToBase64).not.toHaveBeenCalled();
    expect(result.current.uploadProgress).toBeNull();
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
