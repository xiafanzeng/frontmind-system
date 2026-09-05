import { afterEach, describe, expect, it, vi } from "vitest";

import { ManusV2Client } from "./manus-v2-client";
import { uploadUpstreamTaskAttachment } from "./upstream-task-attachment";

const baseInput = {
  baseUrl: "https://api.example.test",
  apiKey: "secret-test-key",
  filename: "socratic-kb-builder.skill.zip",
  bytes: Buffer.from("immutable-skill-archive"),
  mimeType: "application/zip",
};

function uploaded(fileId: string) {
  return {
    fileId,
    filename: baseInput.filename,
    uploadUrl: "https://uploads.example.test/signed",
    uploadExpiresAt: 2_000_000_000,
    requestId: "request-1",
    detail: {
      fileId,
      filename: baseInput.filename,
      status: "uploaded" as const,
      bytes: baseInput.bytes.length,
      expiresAt: 2_000_000_000,
      contentType: baseInput.mimeType,
      requestId: "request-2",
    },
  };
}

describe("durable upstream task attachments v2", () => {
  afterEach(() => vi.restoreAllMocks());

  it("persists the v2 lease before the signed URL upload begins", async () => {
    const events: string[] = [];
    const uploadFile = vi
      .spyOn(ManusV2Client.prototype, "uploadFile")
      .mockImplementation(async (input) => {
        const created = {
          fileId: "provider-file-1",
          filename: baseInput.filename,
          uploadUrl: "https://uploads.example.test/signed",
          uploadExpiresAt: 2_000_000_000,
          requestId: "request-1",
        };
        events.push("create");
        await input.observer?.onCandidateCreated?.(created);
        events.push("upload");
        return uploaded(created.fileId);
      });

    const result = await uploadUpstreamTaskAttachment({
      ...baseInput,
      onFileResolved: async (fileId) => {
        events.push(`persist:${fileId}`);
      },
    });

    expect(events).toEqual(["create", "persist:provider-file-1", "upload"]);
    expect(result.fileId).toBe("provider-file-1");
    expect(uploadFile).toHaveBeenCalledWith(
      expect.objectContaining({
        filename: baseInput.filename,
        bytes: baseInput.bytes,
        contentType: baseInput.mimeType,
        observer: expect.any(Object),
      }),
    );
  });

  it("reuses an exact v2 lease without a legacy content download", async () => {
    const uploadFile = vi
      .spyOn(ManusV2Client.prototype, "uploadFile")
      .mockResolvedValue(uploaded("provider-file-existing"));
    const onFileResolved = vi.fn(async () => undefined);

    const result = await uploadUpstreamTaskAttachment({
      ...baseInput,
      existingFileId: "provider-file-existing",
      onFileResolved,
    });

    expect(result).toMatchObject({
      attachment: {
        file_id: "provider-file-existing",
        filename: baseInput.filename,
      },
    });
    expect(onFileResolved).toHaveBeenCalledWith("provider-file-existing");
    expect(uploadFile).toHaveBeenCalledWith(
      expect.objectContaining({
        existingCandidate: {
          fileId: "provider-file-existing",
          filename: baseInput.filename,
        },
      }),
    );
  });

  it("deletes an unowned v2 candidate when upload fails", async () => {
    vi.spyOn(ManusV2Client.prototype, "uploadFile").mockImplementation(
      async (input) => {
        await input.observer?.onCandidateCreated?.({
          fileId: "provider-file-orphan",
          filename: baseInput.filename,
          uploadUrl: "https://uploads.example.test/signed",
          uploadExpiresAt: 2_000_000_000,
          requestId: "request-1",
        });
        throw new Error("put failed");
      },
    );
    const deleteFile = vi
      .spyOn(ManusV2Client.prototype, "deleteFile")
      .mockResolvedValue({ fileId: "provider-file-orphan", requestId: null });

    await expect(uploadUpstreamTaskAttachment(baseInput)).rejects.toThrow(
      "put failed",
    );
    expect(deleteFile).toHaveBeenCalledWith("provider-file-orphan");
  });

  it("returns a cleanup function backed by v2 file.delete", async () => {
    vi.spyOn(ManusV2Client.prototype, "uploadFile").mockImplementation(
      async (input) => {
        await input.observer?.onCandidateCreated?.({
          fileId: "provider-file-cleanup",
          filename: baseInput.filename,
          uploadUrl: "https://uploads.example.test/signed",
          uploadExpiresAt: 2_000_000_000,
          requestId: "request-1",
        });
        return uploaded("provider-file-cleanup");
      },
    );
    const deleteFile = vi
      .spyOn(ManusV2Client.prototype, "deleteFile")
      .mockResolvedValue({ fileId: "provider-file-cleanup", requestId: null });

    const result = await uploadUpstreamTaskAttachment({
      ...baseInput,
      onFileResolved: async () => undefined,
    });
    await result.removeOrphan();
    expect(deleteFile).toHaveBeenCalledWith("provider-file-cleanup");
  });
});
