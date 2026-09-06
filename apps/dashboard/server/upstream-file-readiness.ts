export const UPSTREAM_FILE_METADATA_TIMEOUT_MS = 10_000;
export const UPSTREAM_FILE_READINESS_RETRY_AFTER_MS = 3_000;

export type UpstreamFileIdentity = {
  fileId: string;
  filename: string;
};

export type UpstreamFileReadiness = UpstreamFileIdentity & {
  state: "pending" | "uploaded";
  status: "pending" | "uploaded";
  checkedAt: number;
};

export type UpstreamFilesReadiness = {
  files: UpstreamFileReadiness[];
  ready: UpstreamFileReadiness[];
  pending: UpstreamFileReadiness[];
};

export type UpstreamFileReadinessErrorCode =
  | "UPSTREAM_FILE_METADATA_UNAVAILABLE"
  | "UPSTREAM_FILE_METADATA_INVALID"
  | "UPSTREAM_FILE_IDENTITY_MISMATCH"
  | "UPSTREAM_FILE_UNUSABLE";

export class UpstreamFileReadinessError extends Error {
  constructor(
    readonly code: UpstreamFileReadinessErrorCode,
    message: string,
    readonly retryable: boolean,
    readonly httpStatus: number | null = null,
    readonly providerStatus: string | null = null,
  ) {
    super(message);
    this.name = "UpstreamFileReadinessError";
  }
}
