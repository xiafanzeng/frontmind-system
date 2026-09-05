export class DeferPublisherJobError extends Error {
  constructor(
    message: string,
    readonly availableAt: Date,
  ) {
    super(message);
    this.name = "DeferPublisherJobError";
  }
}

export class TerminalPublisherJobError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "TerminalPublisherJobError";
  }
}

/**
 * The provider outcome is already known (or may have been sent), but its local
 * durable transition could not be confirmed. The job must be dead-lettered so
 * repository recovery freezes/retains funds and never enters create-order
 * again.
 */
export class PublisherSubmissionPersistenceError extends TerminalPublisherJobError {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "PublisherSubmissionPersistenceError";
  }
}

export function safePublisherError(error: unknown): string {
  const value =
    error instanceof Error
      ? `${error.name}: ${error.message}`
      : typeof error === "string"
        ? error
        : "Unknown publisher worker error";
  return value.replace(/[\r\n]+/gu, " ").slice(0, 1_000);
}
