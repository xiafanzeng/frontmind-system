import { ManusV2ApiError, ManusV2Client } from "./manus-v2-client";

export const UPSTREAM_FILE_METADATA_TIMEOUT_MS = 10_000;
export const UPSTREAM_FILE_READINESS_RETRY_AFTER_MS = 3_000;

const READINESS_BACKOFF_MS = [500, 1_000, 2_000, 3_000] as const;

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

type ReadinessRequest = {
  baseUrl: string;
  apiKey: string;
  file: UpstreamFileIdentity;
  signal?: AbortSignal;
  timeoutMs?: number;
  filenamePolicy?: "exact" | "provider_authoritative";
};

type FilesReadinessRequest = Omit<ReadinessRequest, "file"> & {
  files: UpstreamFileIdentity[];
};

/**
 * Read the provider's official v2 file metadata shape through the single
 * Manus gateway. A provider file id is only a short-lived lease; callers must
 * keep the source bytes locally and use this check solely for lease readiness.
 */
export async function checkUpstreamFileReadiness(
  input: ReadinessRequest,
): Promise<UpstreamFileReadiness> {
  if (input.signal?.aborted) {
    throw input.signal.reason ?? new Error("Upstream readiness cancelled");
  }
  let metadata;
  try {
    metadata = await new ManusV2Client({
      baseUrl: input.baseUrl,
      apiKey: input.apiKey,
      timeoutMs: input.timeoutMs ?? UPSTREAM_FILE_METADATA_TIMEOUT_MS,
    }).fileDetail(input.file.fileId, { signal: input.signal });
  } catch (error) {
    if (input.signal?.aborted)
      throw input.signal.reason ?? new Error("Upstream readiness cancelled");
    if (error instanceof ManusV2ApiError) {
      const status = error.status;
      if (status === 404 || error.code === "FILE_UNUSABLE") {
        throw new UpstreamFileReadinessError(
          "UPSTREAM_FILE_UNUSABLE",
          "Upstream file no longer exists",
          false,
          status,
          "deleted",
        );
      }
      if (
        error.code === "FILE_ID_CONFLICT" ||
        error.code === "FILE_IDENTITY_CONFLICT"
      ) {
        throw new UpstreamFileReadinessError(
          "UPSTREAM_FILE_IDENTITY_MISMATCH",
          "Upstream file identity does not match the requested file",
          false,
          status,
        );
      }
      if (error.retryable || error.outcomeUnknown || status === null) {
        throw new UpstreamFileReadinessError(
          "UPSTREAM_FILE_METADATA_UNAVAILABLE",
          "Upstream file metadata is temporarily unavailable",
          true,
          status,
        );
      }
      throw new UpstreamFileReadinessError(
        "UPSTREAM_FILE_METADATA_INVALID",
        "Upstream file metadata request was rejected",
        false,
        status,
      );
    }
    throw new UpstreamFileReadinessError(
      "UPSTREAM_FILE_METADATA_UNAVAILABLE",
      "Upstream file metadata is temporarily unavailable",
      true,
    );
  }
  if (
    input.filenamePolicy !== "provider_authoritative" &&
    metadata.filename !== input.file.filename
  ) {
    throw new UpstreamFileReadinessError(
      "UPSTREAM_FILE_IDENTITY_MISMATCH",
      "Upstream file identity does not match the requested file",
      false,
      200,
      metadata.status,
    );
  }
  if (metadata.status === "pending" || metadata.status === "uploaded") {
    return {
      fileId: metadata.fileId,
      filename: metadata.filename,
      state: metadata.status,
      status: metadata.status,
      checkedAt: Date.now(),
    };
  }
  throw new UpstreamFileReadinessError(
    metadata.status === "deleted" || metadata.status === "error"
      ? "UPSTREAM_FILE_UNUSABLE"
      : "UPSTREAM_FILE_METADATA_INVALID",
    "Upstream file is not usable by a task",
    false,
    200,
    metadata.status,
  );
}

export async function checkUpstreamFilesReadiness(
  input: FilesReadinessRequest,
): Promise<UpstreamFilesReadiness> {
  const files = await Promise.all(
    input.files.map((file) =>
      checkUpstreamFileReadiness({
        ...input,
        file,
      }),
    ),
  );
  return {
    files,
    ready: files.filter((file) => file.state === "uploaded"),
    pending: files.filter((file) => file.state === "pending"),
  };
}

function readinessDelay(attempt: number, random: () => number) {
  const base =
    READINESS_BACKOFF_MS[Math.min(attempt, READINESS_BACKOFF_MS.length - 1)];
  return Math.max(1, Math.round(base * (0.8 + random() * 0.4)));
}

function abortableSleep(ms: number, signal?: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason ?? new Error("Upstream readiness wait cancelled"));
      return;
    }
    const timer = setTimeout(finish, ms);
    const onAbort = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      reject(signal?.reason ?? new Error("Upstream readiness wait cancelled"));
    };
    function finish() {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

export async function waitForUpstreamFilesReady(
  input: FilesReadinessRequest & {
    /** Maximum elapsed wait, including metadata requests. */
    deadlineMs?: number;
    sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
    random?: () => number;
  },
): Promise<UpstreamFilesReadiness> {
  const startedAt = Date.now();
  const deadlineMs = Math.max(0, input.deadlineMs ?? 5 * 60_000);
  const sleep = input.sleep ?? abortableSleep;
  const random = input.random ?? Math.random;
  let attempt = 0;
  let lastResult: UpstreamFilesReadiness | null = null;
  let lastTransientError: UpstreamFileReadinessError | null = null;

  while (true) {
    try {
      lastResult = await checkUpstreamFilesReadiness(input);
      lastTransientError = null;
      if (lastResult.pending.length === 0) return lastResult;
    } catch (error) {
      if (!(error instanceof UpstreamFileReadinessError) || !error.retryable) {
        throw error;
      }
      lastTransientError = error;
    }

    const elapsed = Date.now() - startedAt;
    if (elapsed >= deadlineMs) {
      if (lastTransientError) throw lastTransientError;
      return lastResult!;
    }
    const delay = Math.min(
      readinessDelay(attempt, random),
      Math.max(0, deadlineMs - elapsed),
    );
    attempt += 1;
    await sleep(delay, input.signal);
  }
}
