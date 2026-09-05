import axios from "axios";

import {
  assertSafeExternalUrl,
  safeExternalRequestOptions,
} from "./_core/safe-external-url";

export async function uploadUpstreamTaskAttachment(input: {
  baseUrl: string;
  apiKey: string;
  filename: string;
  bytes: Buffer;
  mimeType?: string;
  /** Stable per-turn/per-slot key. Required by durable KB attachment callers. */
  idempotencyKey?: string;
  /** Completed reservation replay: reuse this file and refresh its upload URL. */
  existingFileId?: string;
  /** Persist file ownership before any byte upload can begin. */
  onFileResolved?: (fileId: string) => Promise<void>;
}) {
  const mimeType = input.mimeType || "application/zip";
  const authHeaders = {
    API_KEY: input.apiKey,
    Authorization: `Bearer ${input.apiKey}`,
  };
  let createdData: Record<string, unknown> = {};
  let fileId = String(input.existingFileId || "").trim();
  if (!fileId) {
    const created = await axios.post(
      `${input.baseUrl}/v1/files`,
      { filename: input.filename },
      {
        headers: {
          ...authHeaders,
          "Content-Type": "application/json",
          ...(input.idempotencyKey
            ? { "Idempotency-Key": input.idempotencyKey }
            : {}),
        },
        timeout: 120_000,
        validateStatus: () => true,
      },
    );
    createdData =
      created.data && typeof created.data === "object" ? created.data : {};
    fileId = String(createdData.id || createdData.file_id || "");
    if (created.status < 200 || created.status >= 300 || !fileId) {
      throw new Error(`Task attachment creation failed: ${input.filename}`);
    }
  }

  const removeOrphan = async () => {
    await axios
      .delete(`${input.baseUrl}/v1/files/${encodeURIComponent(fileId)}`, {
        headers: authHeaders,
        timeout: 30_000,
        validateStatus: () => true,
      })
      .catch(() => undefined);
  };

  try {
    // Once this callback commits, file id + credential + conversation cleanup
    // ownership are durable. Never delete the file on later upload failures;
    // recovery must refresh the signed URL and retry the same file id.
    await input.onFileResolved?.(fileId);
    let uploadUrl = String(createdData.upload_url || "");
    if (!uploadUrl) {
      const metadata = await axios.get(
        `${input.baseUrl}/v1/files/${encodeURIComponent(fileId)}`,
        {
          headers: authHeaders,
          timeout: 30_000,
          validateStatus: () => true,
        },
      );
      if (metadata.status < 200 || metadata.status >= 300) {
        throw new Error(
          `Task attachment upload URL lookup failed: ${input.filename}`,
        );
      }
      uploadUrl = String(metadata.data?.upload_url || "");
    }
    const target = assertSafeExternalUrl(uploadUrl);
    const uploaded = await axios.put(target, input.bytes, {
      ...safeExternalRequestOptions,
      // Query-signed uploads must use the exact URL and cannot carry API auth.
      maxRedirects: 0,
      headers: {
        "Content-Type": mimeType,
        "Content-Length": String(input.bytes.length),
      },
      timeout: 120_000,
      maxBodyLength: input.bytes.length,
      maxContentLength: 1024 * 1024,
      validateStatus: () => true,
    });
    if (uploaded.status < 200 || uploaded.status >= 300) {
      throw new Error(`Task attachment upload failed: ${input.filename}`);
    }
    return {
      attachment: { file_id: fileId, filename: input.filename },
      fileId,
      removeOrphan,
    };
  } catch (error) {
    if (!input.onFileResolved) await removeOrphan();
    throw error;
  }
}
