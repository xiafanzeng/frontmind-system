import { createHash } from "node:crypto";

const CONSUMER_TASK_ID_LENGTH = 64;

/**
 * Creates the provider idempotency key from a stable internal attempt id.
 * The same attempt must always reuse this value, including after timeouts.
 */
export function createConsumerTaskId(attemptId: string): string {
  const normalized = attemptId.trim();
  if (!normalized) {
    throw new TypeError("attemptId must not be empty");
  }

  const digest = createHash("sha256").update(normalized, "utf8").digest("hex");
  return `fm${digest}`.slice(0, CONSUMER_TASK_ID_LENGTH);
}

export function assertConsumerTaskId(value: string): void {
  if (!/^[A-Za-z0-9]{8,64}$/.test(value)) {
    throw new TypeError(
      "consumerTaskId must contain 8-64 ASCII letters or digits",
    );
  }
}
