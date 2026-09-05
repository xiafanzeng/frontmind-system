const COMPLETED_TASK_STATES = new Set([
  "stopped",
  "completed",
  "complete",
  "finished",
  "done",
  "success",
]);

const FAILED_TASK_STATES = new Set([
  "failed",
  "error",
  "cancelled",
  "canceled",
]);

/**
 * One normalizer for provider lifecycle reads. Keep reset inspection and the
 * build poller aligned as providers add equivalent terminal spellings.
 */
export function terminalTaskState(value: string | null | undefined) {
  const normalized = String(value ?? "")
    .trim()
    .toLowerCase();
  return {
    completed: COMPLETED_TASK_STATES.has(normalized),
    failed: FAILED_TASK_STATES.has(normalized),
  };
}
