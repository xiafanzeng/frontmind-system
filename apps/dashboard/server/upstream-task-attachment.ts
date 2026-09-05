import { ManusV2Client } from "./manus-v2-client";

export type CanonicalProviderFile = {
  id: string;
  filename: string;
  sizeBytes: number | null;
  status: string;
  uploadUrl: string;
  mimeType: string | null;
  sha256: string | null;
};

function providerRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function canonicalStringAlias(
  source: Record<string, unknown>,
  aliases: readonly string[],
  normalize: (value: string) => string = (value) => value,
  nullIsMissing = false,
) {
  const values = aliases
    .filter((alias) => Object.prototype.hasOwnProperty.call(source, alias))
    .map((alias) => source[alias])
    .map((value) =>
      value === null && nullIsMissing
        ? undefined
        : typeof value === "string"
          ? normalize(value)
          : null,
    );
  if (values.some((value) => value === null)) return { valid: false } as const;
  const present = values.filter(
    (value): value is string => value !== undefined,
  );
  if (present.length === 0) return { valid: true, value: null } as const;
  if (present.some((value) => value !== present[0])) {
    return { valid: false } as const;
  }
  return { valid: true, value: present[0] } as const;
}

function canonicalSizeAlias(
  source: Record<string, unknown>,
  aliases: readonly string[],
) {
  const values = aliases
    .filter((alias) => Object.prototype.hasOwnProperty.call(source, alias))
    .map((alias) => source[alias])
    .map((value) => {
      if (
        typeof value === "number" &&
        Number.isSafeInteger(value) &&
        value >= 0
      ) {
        return value;
      }
      if (typeof value === "string" && /^(?:0|[1-9][0-9]*)$/u.test(value)) {
        const parsed = Number(value);
        return Number.isSafeInteger(parsed) ? parsed : null;
      }
      return null;
    });
  if (values.some((value) => value === null)) return { valid: false } as const;
  const present = values as number[];
  if (present.length === 0) return { valid: true, value: null } as const;
  if (present.some((value) => value !== present[0])) {
    return { valid: false } as const;
  }
  return { valid: true, value: present[0] } as const;
}

export function canonicalProviderFile(
  value: unknown,
): CanonicalProviderFile | null {
  const source = providerRecord(value);
  if (!source) return null;
  const id = canonicalStringAlias(source, ["id", "file_id"]);
  const filename = canonicalStringAlias(source, ["filename", "file_name"]);
  const sizeBytes = canonicalSizeAlias(source, [
    "bytes",
    "size",
    "size_bytes",
    "sizeBytes",
  ]);
  const status = canonicalStringAlias(
    source,
    ["status", "upload_status", "uploadStatus"],
    (item) => item.trim().toLowerCase().replace(/[ -]+/gu, "_"),
  );
  const uploadUrl = canonicalStringAlias(
    source,
    ["upload_url"],
    (item) => item,
    true,
  );
  const mimeType = canonicalStringAlias(
    source,
    ["mime_type", "mimeType", "content_type", "contentType"],
    (item) => item.trim().toLowerCase().split(";", 1)[0] || "",
    true,
  );
  const sha256 = canonicalStringAlias(
    source,
    ["sha256", "content_sha256", "contentSha256", "checksum_sha256"],
    (item) => item.trim().toLowerCase(),
    true,
  );
  if (
    !id.valid ||
    !filename.valid ||
    !sizeBytes.valid ||
    !status.valid ||
    !uploadUrl.valid ||
    !mimeType.valid ||
    !sha256.valid
  ) {
    return null;
  }
  return {
    id: id.value || "",
    filename: filename.value || "",
    sizeBytes: sizeBytes.value,
    status: status.value || "",
    uploadUrl: uploadUrl.value || "",
    mimeType: mimeType.value,
    sha256: sha256.value,
  };
}

export function canonicalMimeType(value: string) {
  return value.trim().toLowerCase().split(";", 1)[0] || "";
}

export class UpstreamTaskAttachmentPendingError extends Error {
  readonly code = "UPSTREAM_FILE_PENDING";

  constructor(readonly fileId: string) {
    super("Task attachment is still processing upstream");
    this.name = "UpstreamTaskAttachmentPendingError";
  }
}

export type UpstreamTaskAttachmentContentProofFailureClass =
  | "transient"
  | "deterministic";

export type UpstreamTaskAttachmentContentProofReason =
  | "network"
  | "http_status"
  | "invalid_stream"
  | "stream_interrupted"
  | "invalid_chunk"
  | "size_mismatch"
  | "sha256_mismatch";

/**
 * Safe, credential-free classification for an existing generated file whose
 * authenticated /content proof could not be completed. The message never
 * contains a provider file id, filename, URL, response body, or API key.
 */
export class UpstreamTaskAttachmentContentProofError extends Error {
  readonly code: string;
  readonly retryable: boolean;

  constructor(
    readonly failureClass: UpstreamTaskAttachmentContentProofFailureClass,
    readonly reason: UpstreamTaskAttachmentContentProofReason,
    readonly httpStatus?: number,
  ) {
    super(
      failureClass === "transient"
        ? "Provider attachment content proof is temporarily unavailable"
        : "Provider attachment content proof failed integrity validation",
    );
    this.name = "UpstreamTaskAttachmentContentProofError";
    this.code =
      failureClass === "transient"
        ? "UPSTREAM_FILE_CONTENT_PROOF_UNAVAILABLE"
        : "UPSTREAM_FILE_CONTENT_PROOF_INVALID";
    this.retryable = failureClass === "transient";
  }
}

export async function uploadUpstreamTaskAttachment(input: {
  baseUrl: string;
  apiKey: string;
  filename: string;
  bytes: Buffer;
  mimeType?: string;
  /** Stable per-turn/per-slot key. Required by durable KB attachment callers. */
  idempotencyKey?: string;
  /** Completed reservation replay: verify/reuse this exact provider file. */
  existingFileId?: string;
  /** Persist file ownership before any byte upload can begin. */
  onFileResolved?: (fileId: string) => Promise<void>;
  /** Bounded provider readiness wait; production defaults to five minutes. */
  readinessDeadlineMs?: number;
  /** Test seam for readiness backoff without changing production timing. */
  readinessSleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
}) {
  const mimeType = input.mimeType || "application/zip";
  const client = new ManusV2Client({
    baseUrl: input.baseUrl,
    apiKey: input.apiKey,
  });
  const suppliedFileId = String(input.existingFileId ?? "");
  const usesExistingFile = suppliedFileId.length > 0;
  let fileId = suppliedFileId;
  let candidateCreated = false;
  const removeOrphan = async () => {
    if (!fileId) return;
    await client.deleteFile(fileId).catch(() => undefined);
  };

  try {
    if (usesExistingFile) {
      await input.onFileResolved?.(fileId);
    }
    const uploaded = await client.uploadFile({
      filename: input.filename,
      bytes: input.bytes,
      contentType: mimeType,
      sleep: input.readinessSleep
        ? (ms) => input.readinessSleep!(ms)
        : undefined,
      ...(usesExistingFile
        ? {
            existingCandidate: {
              fileId,
              filename: input.filename,
            },
          }
        : {}),
      observer: usesExistingFile
        ? undefined
        : {
            onCandidateCreated: async (created) => {
              candidateCreated = true;
              fileId = created.fileId;
              // Ownership is persisted before the signed URL is used.
              await input.onFileResolved?.(fileId);
            },
          },
    });
    fileId = uploaded.fileId;
    return {
      attachment: { file_id: fileId, filename: input.filename },
      fileId,
      removeOrphan,
    };
  } catch (error) {
    if (!usesExistingFile && candidateCreated && !input.onFileResolved) {
      await removeOrphan();
    }
    throw error;
  }
}
