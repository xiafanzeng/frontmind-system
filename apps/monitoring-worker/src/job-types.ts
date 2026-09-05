export const workerJobTypes = [
  "submit_attempt",
  "stop_attempt",
  "poll_attempt",
  "fetch_result",
  "archive_media",
  "schedule_catch_up",
  "dispatch_occurrences",
  "purge_soft_deleted",
  "reconcile_billing",
  "sync_provider_catalog",
] as const;

export type WorkerJobType = (typeof workerJobTypes)[number];

export interface WorkerJob {
  id: string;
  type: WorkerJobType;
  payload: unknown;
  attemptCount: number;
  maxAttempts: number;
  leasedUntil: Date;
}

export interface SubmitAttemptPayload {
  attemptId: string;
}

export interface PollAttemptPayload {
  attemptId: string;
}

export interface FetchResultPayload {
  attemptId: string;
}

export interface ArchiveMediaPayload {
  mediaId: string;
}

export function requiredStringPayload(payload: unknown, key: string): string {
  if (
    typeof payload !== "object" ||
    payload === null ||
    Array.isArray(payload)
  ) {
    throw new TypeError("Job payload must be an object");
  }
  const value = (payload as Record<string, unknown>)[key];
  if (typeof value !== "string" || !value.trim())
    throw new TypeError(`Job payload.${key} is required`);
  return value;
}
