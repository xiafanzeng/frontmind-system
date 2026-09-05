import type { RunStatus } from "./domain";

export function shouldPollRun(status: RunStatus): boolean {
  return (
    status === "queued" || status === "waiting_quota" || status === "running"
  );
}
