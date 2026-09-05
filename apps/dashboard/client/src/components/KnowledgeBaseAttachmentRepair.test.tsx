import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  uploadFile: vi.fn(),
  replaceAttachments: vi.fn(),
  onObservation: vi.fn(),
  toastSuccess: vi.fn(),
  toastWarning: vi.fn(),
  toastError: vi.fn(),
}));

vi.mock("sonner", () => ({
  toast: {
    success: mocks.toastSuccess,
    warning: mocks.toastWarning,
    error: mocks.toastError,
  },
}));

vi.mock("@/lib/attachment-files", () => ({
  assertChatAttachmentSizes: vi.fn(),
  normalizedKnowledgeBaseUploadFilename: (name: string) => name,
  normalizedKnowledgeBaseUploadMimeType: (file: File) =>
    file.type || "application/octet-stream",
  sha256UploadFile: vi.fn().mockResolvedValue("a".repeat(64)),
}));

vi.mock("@/lib/frontmind-api", () => ({
  uploadFile: mocks.uploadFile,
}));

vi.mock("@/lib/knowledge-progress", () => ({
  replaceKnowledgeBaseTurnAttachments: mocks.replaceAttachments,
}));

import KnowledgeBaseAttachmentRepair from "./KnowledgeBaseAttachmentRepair";

describe("KnowledgeBaseAttachmentRepair", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.uploadFile.mockResolvedValue({ fileId: "replacement-file-1" });
  });

  it("keeps one uploaded attachment and one repair id across a 5xx replay", async () => {
    const uncertain = Object.assign(new Error("temporary gateway failure"), {
      status: 503,
    });
    const repairedObservation = {
      generation: 3,
      stateEpoch: 19,
      interaction: { interactionState: "running", progress: null },
    } as any;
    mocks.replaceAttachments
      .mockRejectedValueOnce(uncertain)
      .mockResolvedValueOnce(repairedObservation);

    render(
      <KnowledgeBaseAttachmentRepair
        conversationId="conversation-413"
        expectedGeneration={3}
        expectedRevision={8}
        expectedLeafId="products.2"
        onObservation={mocks.onObservation}
      />,
    );

    expect(
      screen.getByTestId("knowledge-base-attachment-repair"),
    ).toHaveTextContent("不会把它标记为“重新生成”");

    const file = new File(["compressed replacement"], "replacement.pdf", {
      type: "application/pdf",
      lastModified: 1_754_000_000_000,
    });
    fireEvent.change(screen.getByLabelText("选择替换后的知识库资料"), {
      target: { files: [file] },
    });
    expect(screen.getByText("已选择 1 份资料")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "替换附件并继续本轮" }));
    await waitFor(() =>
      expect(mocks.replaceAttachments).toHaveBeenCalledOnce(),
    );
    expect(mocks.uploadFile).toHaveBeenCalledOnce();
    const firstRequest = mocks.replaceAttachments.mock.calls[0]![0];
    expect(firstRequest).toMatchObject({
      conversationId: "conversation-413",
      expectedGeneration: 3,
      expectedRevision: 8,
      expectedLeafId: "products.2",
      attachments: [
        { file_id: "replacement-file-1", filename: "replacement.pdf" },
      ],
      attachmentManifest: [
        {
          filename: "replacement.pdf",
          mimeType: "application/pdf",
          sha256: "a".repeat(64),
        },
      ],
    });
    expect(firstRequest.clientRequestId).toBeTruthy();
    expect(mocks.toastWarning).toHaveBeenCalledOnce();

    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: "替换附件并继续本轮" }),
      ).toBeEnabled(),
    );
    fireEvent.click(screen.getByRole("button", { name: "替换附件并继续本轮" }));

    await waitFor(() =>
      expect(mocks.replaceAttachments).toHaveBeenCalledTimes(2),
    );
    expect(mocks.uploadFile).toHaveBeenCalledOnce();
    expect(mocks.replaceAttachments.mock.calls[1]![0]).toEqual(firstRequest);
    await waitFor(() =>
      expect(mocks.onObservation).toHaveBeenCalledWith(repairedObservation),
    );
    expect(mocks.toastSuccess).toHaveBeenCalledOnce();
    expect(screen.queryByText("已选择 1 份资料")).not.toBeInTheDocument();
  });
});
