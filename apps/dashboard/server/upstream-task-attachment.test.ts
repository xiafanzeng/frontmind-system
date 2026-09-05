import axios from "axios";
import { afterEach, describe, expect, it, vi } from "vitest";

import { uploadUpstreamTaskAttachment } from "./upstream-task-attachment";

describe("durable upstream task attachments", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("creates with the stable idempotency key and persists the file id before uploading bytes", async () => {
    const events: string[] = [];
    const uploadUrl =
      "https://uploads.example.test/generated.skill?X-Amz-Signature=stable";
    const post = vi.spyOn(axios, "post").mockImplementation(async () => {
      events.push("create");
      return {
        status: 201,
        data: { id: "provider-file-1", upload_url: uploadUrl },
      };
    });
    const put = vi.spyOn(axios, "put").mockImplementation(async () => {
      events.push("upload");
      return { status: 200, data: "" };
    });

    const result = await uploadUpstreamTaskAttachment({
      baseUrl: "https://api.example.test",
      apiKey: "secret-test-key",
      filename: "socratic-kb-builder-v4.skill",
      bytes: Buffer.from("immutable-skill"),
      idempotencyKey: "frontmind-kb-file-v1:stable-operation",
      onFileResolved: async (fileId) => {
        events.push(`persist:${fileId}`);
      },
    });

    expect(events).toEqual(["create", "persist:provider-file-1", "upload"]);
    expect(result.fileId).toBe("provider-file-1");
    expect(post).toHaveBeenCalledWith(
      "https://api.example.test/v1/files",
      { filename: "socratic-kb-builder-v4.skill" },
      expect.objectContaining({
        headers: expect.objectContaining({
          "Idempotency-Key": "frontmind-kb-file-v1:stable-operation",
        }),
      }),
    );
    expect(put.mock.calls[0]?.[0]).toBe(uploadUrl);
    expect(put.mock.calls[0]?.[2]?.headers).not.toHaveProperty("API_KEY");
    expect(put.mock.calls[0]?.[2]?.headers).not.toHaveProperty("Authorization");
  });

  it("skips creation on completed replay and refreshes the signed upload URL for the same file", async () => {
    const post = vi.spyOn(axios, "post");
    const get = vi.spyOn(axios, "get").mockResolvedValue({
      status: 200,
      data: {
        upload_url:
          "https://uploads.example.test/replayed.skill?X-Amz-Signature=fresh",
      },
    });
    const put = vi.spyOn(axios, "put").mockResolvedValue({
      status: 200,
      data: "",
    });
    const onFileResolved = vi.fn().mockResolvedValue(undefined);

    const result = await uploadUpstreamTaskAttachment({
      baseUrl: "https://api.example.test",
      apiKey: "secret-test-key",
      filename: "socratic-kb-builder-v4.skill",
      bytes: Buffer.from("immutable-skill"),
      existingFileId: "provider-file-1",
      idempotencyKey: "frontmind-kb-file-v1:stable-operation",
      onFileResolved,
    });

    expect(post).not.toHaveBeenCalled();
    expect(get).toHaveBeenCalledWith(
      "https://api.example.test/v1/files/provider-file-1",
      expect.objectContaining({
        headers: expect.objectContaining({ API_KEY: "secret-test-key" }),
      }),
    );
    expect(onFileResolved).toHaveBeenCalledWith("provider-file-1");
    expect(put).toHaveBeenCalledTimes(1);
    expect(result.attachment.file_id).toBe("provider-file-1");
  });

  it("does not delete an idempotently recoverable file when binding or upload fails", async () => {
    vi.spyOn(axios, "post").mockResolvedValue({
      status: 201,
      data: {
        id: "provider-file-uncertain",
        upload_url:
          "https://uploads.example.test/uncertain.skill?X-Amz-Signature=one",
      },
    });
    const remove = vi.spyOn(axios, "delete").mockResolvedValue({
      status: 204,
      data: "",
    });

    await expect(
      uploadUpstreamTaskAttachment({
        baseUrl: "https://api.example.test",
        apiKey: "secret-test-key",
        filename: "socratic-kb-builder-v4.skill",
        bytes: Buffer.from("immutable-skill"),
        idempotencyKey: "frontmind-kb-file-v1:stable-operation",
        onFileResolved: async () => {
          throw new Error("simulated database interruption");
        },
      }),
    ).rejects.toThrow("simulated database interruption");
    expect(remove).not.toHaveBeenCalled();

    vi.spyOn(axios, "get").mockResolvedValue({
      status: 200,
      data: {
        upload_url:
          "https://uploads.example.test/uncertain.skill?X-Amz-Signature=two",
      },
    });
    vi.spyOn(axios, "put").mockResolvedValue({ status: 503, data: "retry" });
    await expect(
      uploadUpstreamTaskAttachment({
        baseUrl: "https://api.example.test",
        apiKey: "secret-test-key",
        filename: "socratic-kb-builder-v4.skill",
        bytes: Buffer.from("immutable-skill"),
        existingFileId: "provider-file-uncertain",
        onFileResolved: async () => undefined,
      }),
    ).rejects.toThrow("Task attachment upload failed");
    expect(remove).not.toHaveBeenCalled();
  });
});
