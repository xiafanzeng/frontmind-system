import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  cancelKnowledgeBaseTurnAttachments: vi.fn(),
  createKnowledgeBaseTurnTask: vi.fn(),
  getKnowledgeBaseUploadStatus: vi.fn(),
  resumeKnowledgeBaseTurnAttachments: vi.fn(),
  uploadKnowledgeBaseLocalAsset: vi.fn(),
  sha256UploadFile: vi.fn(),
  onObservation: vi.fn(),
  onRecovered: vi.fn(),
  onCancelled: vi.fn(),
}));

vi.mock("@/lib/attachment-files", () => ({
  normalizedKnowledgeBaseUploadFilename: (name: string) =>
    name.normalize("NFKC"),
  normalizedKnowledgeBaseUploadMimeType: (file: File) =>
    file.type || "application/octet-stream",
  sha256UploadFile: mocks.sha256UploadFile,
}));

vi.mock("@/lib/frontmind-api", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/lib/frontmind-api")>(),
  cancelKnowledgeBaseTurnAttachments: mocks.cancelKnowledgeBaseTurnAttachments,
  createKnowledgeBaseTurnTask: mocks.createKnowledgeBaseTurnTask,
  getKnowledgeBaseUploadStatus: async (...args: unknown[]) => {
    const resumed = await mocks.getKnowledgeBaseUploadStatus(...args);
    return { buildId: "build-revise", conversationId: "conversation-revise", turnId: "turn-revise", clientRequestId: "request-revise", resetRevision: 7, generation: 2, stateEpoch: 11, uploadStatusVersion: 1, uploadAttemptId: "attempt-1", runPhase: "uploading", controlState: resumed.controlState ?? "active", totalFiles: resumed.attachmentManifest.length, totalBytes: resumed.attachmentManifest.reduce((sum: number, item: {sizeBytes: number}) => sum + item.sizeBytes, 0), confirmedFiles: resumed.stagedCustomerAttachmentCount, confirmedBytes: 0,
      files: resumed.attachmentManifest.map((item: {itemId: string}) => ({ ...item, status: resumed.missingCustomerAttachments.some((missing: {itemId: string}) => missing.itemId === item.itemId) ? "missing" : resumed.retainedItemIds?.includes(item.itemId) ? "retained" : "confirmed" })), readyToDispatch: resumed.readyToDispatch, allowedActions: resumed.controlState === "stopped" ? ["resume"] : resumed.readyToDispatch ? ["dispatch"] : ["upload", "stop"], knowledgeObservation: resumed.knowledgeObservation };
  },
  resumeKnowledgeBaseTurnAttachments: mocks.resumeKnowledgeBaseTurnAttachments,
  uploadKnowledgeBaseLocalAsset: mocks.uploadKnowledgeBaseLocalAsset,
  stageKnowledgeBaseTurnAttachment: vi.fn(),
}));

import KnowledgeBaseManagedUploadRecovery from "./KnowledgeBaseManagedUploadRecovery";

const coordinate = {
  conversationId: "conversation-revise",
  turnId: "turn-revise",
  clientRequestId: "request-revise",
  expectedResetRevision: 7,
};

function manifestItem(ordinal: number, sha256?: string) {
  return {
    itemId: `request-revise:${ordinal}`,
    ordinal,
    total: 9,
    filename: `source-${ordinal}.jpg`,
    sizeBytes: ordinal + 2,
    mimeType: "image/jpeg",
    lastModified: 1_755_000_000_000 + ordinal,
    ...(sha256 ? { sha256 } : {}),
  };
}

const attachmentManifest = Array.from({ length: 9 }, (_, index) =>
  manifestItem(index + 1),
);

function partialResume() {
  return {
    stagedCustomerAttachmentCount: 4,
    retainedCustomerAttachmentCount: 4,
    missingCustomerAttachments: attachmentManifest.slice(4),
    readyToDispatch: false,
    attachmentManifest,
  };
}

function renderRecovery() {
  return render(
    <KnowledgeBaseManagedUploadRecovery
      {...coordinate}
      onObservation={mocks.onObservation}
      onRecovered={mocks.onRecovered}
      onCancelled={mocks.onCancelled}
    />,
  );
}

function fileForManifest(item: ReturnType<typeof manifestItem>) {
  return new File(["x".repeat(item.sizeBytes)], item.filename, {
    type: item.mimeType,
    lastModified: item.lastModified,
  });
}

describe("KnowledgeBaseManagedUploadRecovery", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mocks.getKnowledgeBaseUploadStatus.mockResolvedValue(partialResume());
    mocks.uploadKnowledgeBaseLocalAsset.mockResolvedValue({
      fileId: "asset-local",
    });
    mocks.createKnowledgeBaseTurnTask.mockResolvedValue({});
    mocks.sha256UploadFile.mockResolvedValue("a".repeat(64));
  });

  afterEach(cleanup);

  it("does not dispatch a fully retained but explicitly stopped batch on refresh", async () => {
    mocks.getKnowledgeBaseUploadStatus.mockResolvedValue({ ...partialResume(), stagedCustomerAttachmentCount: 9, retainedCustomerAttachmentCount: 9, missingCustomerAttachments: [], readyToDispatch: true, controlState: "stopped" });
    renderRecovery();
    expect(await screen.findByRole("button", { name: "继续上传" })).toBeInTheDocument();
    expect(mocks.createKnowledgeBaseTurnTask).not.toHaveBeenCalled();
  });

  it("preserves a stop committed while retained attachments were being confirmed", async () => {
    const retained = { ...partialResume(), stagedCustomerAttachmentCount: 0, retainedCustomerAttachmentCount: 9, missingCustomerAttachments: [], retainedItemIds: attachmentManifest.map(item => item.itemId) };
    const confirmed = { ...partialResume(), stagedCustomerAttachmentCount: 9, retainedCustomerAttachmentCount: 9, missingCustomerAttachments: [], readyToDispatch: true };
    mocks.getKnowledgeBaseUploadStatus.mockResolvedValueOnce(retained).mockResolvedValue({ ...confirmed, controlState: "stopped" });
    mocks.resumeKnowledgeBaseTurnAttachments.mockResolvedValue(confirmed);
    renderRecovery();
    expect(await screen.findByRole("button", { name: "继续上传" })).toBeInTheDocument();
    expect(mocks.resumeKnowledgeBaseTurnAttachments).toHaveBeenCalledOnce();
    expect(mocks.createKnowledgeBaseTurnTask).not.toHaveBeenCalled();
    expect(mocks.onRecovered).not.toHaveBeenCalled();
  });

  it("shows the production-like 4/9 retained state without dispatching", async () => {
    renderRecovery();

    expect(
      await screen.findByText(
        "已保存 4/9，仍缺 5 份资料。可选择缺失资料，也可重新选择全部原文件；已保留文件不会重复上传。",
      ),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "重新选择缺失文件" }),
    ).toBeEnabled();
    expect(mocks.createKnowledgeBaseTurnTask).not.toHaveBeenCalled();
  });

  it("commits a concurrent winner observation instead of leaving stale recovery state authoritative", async () => {
    const knowledgeObservation = {
      generation: 2,
      stateEpoch: 11,
      activeTurn: null,
      interaction: { interactionState: "awaiting_input", canReply: true },
    };
    mocks.getKnowledgeBaseUploadStatus.mockRejectedValue(
      Object.assign(new Error("本轮已由另一页面处理"), {
        knowledgeObservation,
      }),
    );

    renderRecovery();

    expect(await screen.findByText("本轮已由另一页面处理")).toBeInTheDocument();
    expect(mocks.onObservation).toHaveBeenCalledWith(knowledgeObservation);
    expect(mocks.createKnowledgeBaseTurnTask).not.toHaveBeenCalled();
  });

  it("accepts a digest-free manifest, skips retained selections, uploads only 5-9, then dispatches the same turn once", async () => {
    const ready = {
      ...partialResume(),
      stagedCustomerAttachmentCount: 9,
      retainedCustomerAttachmentCount: 9,
      missingCustomerAttachments: [],
      readyToDispatch: true,
    };
    mocks.getKnowledgeBaseUploadStatus
      .mockResolvedValueOnce(partialResume())
      .mockResolvedValueOnce(partialResume())
      .mockResolvedValueOnce(ready);

    renderRecovery();
    await screen.findByRole("button", { name: "重新选择缺失文件" });
    const allFiles = attachmentManifest.map(fileForManifest);
    fireEvent.change(screen.getByLabelText("选择本轮缺失的知识库原文件"), {
      target: { files: allFiles },
    });

    await waitFor(() =>
      expect(mocks.uploadKnowledgeBaseLocalAsset).toHaveBeenCalledTimes(5),
    );
    expect(
      mocks.uploadKnowledgeBaseLocalAsset.mock.calls.map(
        (call) => call[3].batchOrdinal,
      ),
    ).toEqual([5, 6, 7, 8, 9]);
    for (const call of mocks.uploadKnowledgeBaseLocalAsset.mock.calls) {
      expect(call[3].resumeScope).toMatchObject({
        kind: "knowledge_base",
        operationType: "revise",
        ...coordinate,
      });
      expect(call[3]).not.toHaveProperty("contentSha256");
    }
    expect(mocks.sha256UploadFile).not.toHaveBeenCalled();
    await waitFor(() =>
      expect(mocks.createKnowledgeBaseTurnTask).toHaveBeenCalledOnce(),
    );
    expect(mocks.createKnowledgeBaseTurnTask).toHaveBeenCalledWith([], {
      conversationId: coordinate.conversationId,
      clientRequestId: coordinate.clientRequestId,
      expectedResetRevision: coordinate.expectedResetRevision,
      attachmentReservation: {
        uploadAttemptId: "attempt-1",
        turnId: coordinate.turnId,
        attachmentManifest,
      },
    }, expect.any(AbortSignal));
    expect(mocks.onRecovered).toHaveBeenCalledOnce();
  });

  it("keeps an explicit digest authoritative and rejects a mismatched file", async () => {
    const digestManifest = [
      {
        ...manifestItem(1, "a".repeat(64)),
        total: 1,
      },
    ];
    mocks.getKnowledgeBaseUploadStatus.mockResolvedValue({
      stagedCustomerAttachmentCount: 0,
      retainedCustomerAttachmentCount: 0,
      missingCustomerAttachments: digestManifest,
      readyToDispatch: false,
      attachmentManifest: digestManifest,
    });
    mocks.sha256UploadFile.mockResolvedValue("b".repeat(64));

    renderRecovery();
    await screen.findByRole("button", { name: "重新选择缺失文件" });
    fireEvent.change(screen.getByLabelText("选择本轮缺失的知识库原文件"), {
      target: { files: [fileForManifest(digestManifest[0]!)] },
    });

    expect(
      await screen.findByText(
        `所选文件与本轮资料清单不一致：${digestManifest[0]!.filename}`,
      ),
    ).toBeInTheDocument();
    expect(mocks.uploadKnowledgeBaseLocalAsset).not.toHaveBeenCalled();
    expect(mocks.createKnowledgeBaseTurnTask).not.toHaveBeenCalled();
  });

  it("prefers a missing entry when retained and missing files share digest-free metadata", async () => {
    const duplicate = manifestItem(1);
    const duplicateManifest = [
      duplicate,
      { ...duplicate, itemId: "request-revise:2", ordinal: 2, total: 2 },
    ];
    mocks.getKnowledgeBaseUploadStatus.mockResolvedValue({
      stagedCustomerAttachmentCount: 1,
      retainedCustomerAttachmentCount: 1,
      missingCustomerAttachments: [duplicateManifest[1]],
      readyToDispatch: false,
      attachmentManifest: duplicateManifest,
    });

    renderRecovery();
    await screen.findByRole("button", { name: "重新选择缺失文件" });
    fireEvent.change(screen.getByLabelText("选择本轮缺失的知识库原文件"), {
      target: { files: [fileForManifest(duplicateManifest[1]!)] },
    });

    await waitFor(() =>
      expect(mocks.uploadKnowledgeBaseLocalAsset).toHaveBeenCalledOnce(),
    );
    expect(mocks.uploadKnowledgeBaseLocalAsset.mock.calls[0]![3]).toMatchObject(
      { itemId: "request-revise:2", batchOrdinal: 2 },
    );
  });

  it("cancels only the unprepared revise turn and commits the returned node observation", async () => {
    const knowledgeObservation = {
      generation: 2,
      stateEpoch: 10,
      interaction: { interactionState: "awaiting_input", canReply: true },
    };
    mocks.cancelKnowledgeBaseTurnAttachments.mockResolvedValue({
      cancelled: true,
      knowledgeObservation,
    });

    renderRecovery();
    fireEvent.click(
      await screen.findByRole("button", {
        name: "放弃本轮补充，返回当前节点",
      }),
    );

    await waitFor(() =>
      expect(mocks.cancelKnowledgeBaseTurnAttachments).toHaveBeenCalledWith(
        coordinate,
      ),
    );
    expect(mocks.onObservation).toHaveBeenCalledWith(knowledgeObservation);
    expect(mocks.onCancelled).toHaveBeenCalledOnce();
    expect(mocks.createKnowledgeBaseTurnTask).not.toHaveBeenCalled();
    expect(
      screen.queryByTestId("knowledge-base-managed-upload-recovery"),
    ).not.toBeInTheDocument();
  });
});
