import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  recordUpstreamResource: vi.fn(),
  logKnowledgeBaseRuntimeFailure: vi.fn(),
}));

vi.mock("./auth-service", () => ({
  recordUpstreamResource: mocks.recordUpstreamResource,
}));

vi.mock("./knowledge-base-runtime-log", () => ({
  logKnowledgeBaseRuntimeFailure: mocks.logKnowledgeBaseRuntimeFailure,
}));

import { recordKnowledgeBaseOutputFiles } from "./knowledge-base-output-resource-service";

describe("recordKnowledgeBaseOutputFiles identity boundary", () => {
  beforeEach(() => {
    mocks.recordUpstreamResource.mockReset().mockResolvedValue(undefined);
    mocks.logKnowledgeBaseRuntimeFailure.mockReset();
  });

  it("skips a malformed image while recording valid provider output", async () => {
    await recordKnowledgeBaseOutputFiles({
      userId: 17,
      apiCredentialId: "credential-1",
      output: [
        {
          id: "valid-output",
          type: "output_file",
          file_id: "valid-file",
          filename: "report.pdf",
          mime_type: "application/pdf",
        },
        {
          id: "conflicting-output",
          type: "output_image",
          file_id: "image-a",
          fileId: "image-b",
          filename: "image.webp",
          mime_type: "image/webp",
        },
      ],
    });

    expect(mocks.recordUpstreamResource).toHaveBeenCalledTimes(1);
    expect(mocks.recordUpstreamResource).toHaveBeenCalledWith({
      userId: 17,
      apiCredentialId: "credential-1",
      kind: "file",
      upstreamId: "valid-file",
    });
  });

  it("still rejects malformed non-image resources", async () => {
    await expect(
      recordKnowledgeBaseOutputFiles({
        userId: 17,
        apiCredentialId: "credential-1",
        output: [
          {
            id: "conflicting-document",
            type: "output_file",
            file_id: "document-a",
            fileId: "document-b",
            filename: "report.pdf",
            mime_type: "application/pdf",
          },
        ],
      }),
    ).rejects.toThrow("上游文件标识 的别名字段相互冲突");
    expect(mocks.recordUpstreamResource).not.toHaveBeenCalled();
  });

  it("records each deduplicated trusted file identity", async () => {
    await recordKnowledgeBaseOutputFiles({
      userId: 17,
      apiCredentialId: "credential-1",
      output: [
        {
          id: "assistant-message",
          role: "assistant",
          type: "output_message",
          content: [
            {
              type: "output_image",
              file_id: "image-file",
              filename: "image.webp",
              mime_type: "image/webp",
            },
          ],
        },
        {
          id: "image-duplicate",
          type: "output_image",
          file_id: "image-file",
          filename: "image.webp",
          mime_type: "image/webp",
        },
        {
          id: "document-output",
          type: "output_file",
          file_id: "document-file",
          filename: "report.pdf",
          mime_type: "application/pdf",
        },
      ],
    });

    expect(mocks.recordUpstreamResource.mock.calls).toEqual([
      [
        {
          userId: 17,
          apiCredentialId: "credential-1",
          kind: "file",
          upstreamId: "image-file",
        },
      ],
      [
        {
          userId: 17,
          apiCredentialId: "credential-1",
          kind: "file",
          upstreamId: "document-file",
        },
      ],
    ]);
  });
});
