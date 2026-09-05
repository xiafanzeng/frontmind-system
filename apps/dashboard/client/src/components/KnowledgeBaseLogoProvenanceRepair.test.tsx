import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { toast } from "sonner";

import KnowledgeBaseLogoProvenanceRepair from "./KnowledgeBaseLogoProvenanceRepair";

const mocks = vi.hoisted(() => ({
  uploadFile: vi.fn(),
  sha256UploadFile: vi.fn(),
  repairKnowledgeBaseLogoProvenance: vi.fn(),
  retryKnowledgeBaseTurn: vi.fn(),
}));

vi.mock("@/lib/frontmind-api", () => ({
  uploadFile: mocks.uploadFile,
}));

vi.mock("@/lib/attachment-files", () => ({
  assertChatAttachmentSizes: vi.fn(),
  normalizedKnowledgeBaseUploadFilename: (name: string) => name,
  normalizedKnowledgeBaseUploadMimeType: (file: File) => file.type,
  sha256UploadFile: mocks.sha256UploadFile,
}));

vi.mock("@/lib/knowledge-progress", () => ({
  repairKnowledgeBaseLogoProvenance: mocks.repairKnowledgeBaseLogoProvenance,
  retryKnowledgeBaseTurn: mocks.retryKnowledgeBaseTurn,
}));

const observation = {
  stateEpoch: 9,
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
    key: "kb:retry-final",
    code: "FINAL_PACKAGE_INVALID",
    severity: "error",
    message: "请重试本轮",
    retryable: true,
    turnId: "turn-50",
    createdAt: 9,
  },
  conversationVersion: 9,
};

const retryObservation = {
  ...observation,
  stateEpoch: 10,
  activeTurn: { id: "retry-turn-1", status: "running" },
  interaction: {
    ...observation.interaction,
    interactionState: "executing",
    lockReason: "UPSTREAM_RUNNING",
  },
  notice: null,
};

function renderRepair(onObservation = vi.fn()) {
  return {
    onObservation,
    ...render(
      <KnowledgeBaseLogoProvenanceRepair
        conversationId="conversation-1"
        expectedGeneration={1}
        expectedRevision={50}
        expectedLeafId="7.5"
        onObservation={onObservation}
      />,
    ),
  };
}

describe("KnowledgeBaseLogoProvenanceRepair", () => {
  beforeEach(() => {
    mocks.uploadFile.mockReset();
    mocks.sha256UploadFile.mockReset();
    mocks.repairKnowledgeBaseLogoProvenance.mockReset();
    mocks.retryKnowledgeBaseTurn.mockReset();
    mocks.sha256UploadFile.mockResolvedValue("a".repeat(64));
    mocks.uploadFile.mockResolvedValue({
      fileId: "file-logo-1",
      filename: "official-logo.png",
    });
    mocks.repairKnowledgeBaseLogoProvenance.mockResolvedValue(observation);
    mocks.retryKnowledgeBaseTurn.mockResolvedValue(retryObservation);
  });

  it("repairs one exact Logo and automatically retries the failed final turn", async () => {
    const { onObservation } = renderRepair();
    const file = new File(["original-logo"], "official-logo.png", {
      type: "image/png",
      lastModified: 123,
    });

    const input = screen.getByLabelText("选择同一张官方主 Logo 原图");
    expect(input).toHaveAttribute(
      "accept",
      "image/png,image/jpeg,image/webp,image/avif,image/gif",
    );
    expect(input).not.toHaveAttribute("multiple");
    fireEvent.change(input, { target: { files: [file] } });
    fireEvent.click(screen.getByRole("button", { name: "校验并绑定" }));

    await waitFor(() =>
      expect(mocks.repairKnowledgeBaseLogoProvenance).toHaveBeenCalled(),
    );
    expect(mocks.uploadFile).toHaveBeenCalledWith(
      file,
      expect.any(Function),
      undefined,
      {
        captureLocalCopy: true,
        captureFilename: "official-logo.png",
      },
    );
    expect(mocks.repairKnowledgeBaseLogoProvenance).toHaveBeenCalledWith({
      conversationId: "conversation-1",
      clientRequestId: expect.any(String),
      expectedGeneration: 1,
      expectedRevision: 50,
      expectedLeafId: "7.5",
      attachmentManifest: [
        {
          filename: "official-logo.png",
          sizeBytes: file.size,
          mimeType: "image/png",
          lastModified: 123,
          sha256: "a".repeat(64),
        },
      ],
      attachment: {
        file_id: "file-logo-1",
        filename: "official-logo.png",
      },
    });
    expect(mocks.retryKnowledgeBaseTurn).toHaveBeenCalledWith({
      conversationId: "conversation-1",
      clientRequestId: expect.any(String),
      expectedGeneration: 1,
      expectedRevision: 50,
      expectedLeafId: "7.5",
    });
    expect(onObservation).toHaveBeenCalledWith(retryObservation);
    expect(toast.success).toHaveBeenCalledWith(
      "Logo 来源已校验，最终交付已重新发起",
      {
        description:
          "系统已使用新的幂等操作重新生成并校验最终知识库，无需再次点击重试。",
      },
    );
  });

  it("keeps a successful provenance repair when the automatic retry is uncertain", async () => {
    mocks.retryKnowledgeBaseTurn.mockRejectedValue(
      new Error("network unknown"),
    );
    const { onObservation } = renderRepair();
    const file = new File(["original-logo"], "official-logo.png", {
      type: "image/png",
    });

    fireEvent.change(screen.getByLabelText("选择同一张官方主 Logo 原图"), {
      target: { files: [file] },
    });
    fireEvent.click(screen.getByRole("button", { name: "校验并绑定" }));

    await waitFor(() =>
      expect(toast.warning).toHaveBeenCalledWith(
        "Logo 来源已修复，正在恢复最终交付",
        {
          description:
            "重试请求结果暂时未知，系统会核对同一操作，不会要求再次上传 Logo。",
        },
      ),
    );
    expect(onObservation).toHaveBeenCalledWith(observation);
    expect(screen.queryByText("official-logo.png")).not.toBeInTheDocument();
  });

  it("explains an exact-byte mismatch and requires a new selection", async () => {
    mocks.repairKnowledgeBaseLogoProvenance.mockRejectedValue(
      Object.assign(new Error("Logo bytes do not match"), {
        status: 422,
        code: "KNOWLEDGE_BASE_LOGO_REPAIR_UPLOAD_INVALID",
      }),
    );
    renderRepair();
    const file = new File(["different-logo"], "different.png", {
      type: "image/png",
    });

    fireEvent.change(screen.getByLabelText("选择同一张官方主 Logo 原图"), {
      target: { files: [file] },
    });
    fireEvent.click(screen.getByRole("button", { name: "校验并绑定" }));

    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith("Logo 原图不一致", {
        description:
          "所选图片与当前知识库已绑定的 Logo 不是同一份原始字节。请上传当时使用的同一文件，不要截图、压缩或重新导出。",
      }),
    );
    expect(screen.queryByText("different.png")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "校验并绑定" })).toBeDisabled();
  });

  it("replays an uncertain repair with the same upload and request identity", async () => {
    mocks.repairKnowledgeBaseLogoProvenance
      .mockRejectedValueOnce(new Error("network unknown"))
      .mockResolvedValueOnce(observation);
    renderRepair();
    const file = new File(["original-logo"], "official-logo.png", {
      type: "image/png",
    });
    fireEvent.change(screen.getByLabelText("选择同一张官方主 Logo 原图"), {
      target: { files: [file] },
    });

    fireEvent.click(screen.getByRole("button", { name: "校验并绑定" }));
    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith("Logo 来源修复失败", {
        description: "network unknown",
      }),
    );
    const firstRequest =
      mocks.repairKnowledgeBaseLogoProvenance.mock.calls[0]![0];

    fireEvent.click(screen.getByRole("button", { name: "校验并绑定" }));
    await waitFor(() =>
      expect(mocks.repairKnowledgeBaseLogoProvenance).toHaveBeenCalledTimes(2),
    );
    const secondRequest =
      mocks.repairKnowledgeBaseLogoProvenance.mock.calls[1]![0];
    expect(mocks.uploadFile).toHaveBeenCalledTimes(1);
    expect(secondRequest).toEqual(firstRequest);
  });
});
