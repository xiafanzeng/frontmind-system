export type KnowledgeArchiveDownloadErrorKind =
  | "transport"
  | "timeout"
  | "http_status"
  | "unsafe_url"
  | "missing_url"
  | "local_copy_missing"
  | "local_copy_invalid"
  | "local_size_mismatch"
  | "local_sha256_mismatch"
  | "empty"
  | "too_large";

export function isRetryableKnowledgeArchiveDownloadStatus(status: number) {
  return (
    status === 404 ||
    status === 408 ||
    status === 425 ||
    status === 429 ||
    (status >= 500 && status <= 599)
  );
}

/**
 * Stable, customer-safe download failure metadata for the knowledge-base
 * recovery state machine. The original transport error is deliberately not
 * retained: Axios request data can contain signed URLs or credentials.
 */
export class KnowledgeArchiveDownloadError extends Error {
  public readonly status: number | null;
  public readonly retryable: boolean;

  constructor(
    public readonly kind: KnowledgeArchiveDownloadErrorKind,
    message: string,
    status: number | null = null,
  ) {
    super(message);
    this.name = "KnowledgeArchiveDownloadError";
    this.status = Number.isInteger(status) ? status : null;
    this.retryable =
      kind === "transport" ||
      kind === "timeout" ||
      (kind === "http_status" &&
        this.status !== null &&
        isRetryableKnowledgeArchiveDownloadStatus(this.status));
  }
}
