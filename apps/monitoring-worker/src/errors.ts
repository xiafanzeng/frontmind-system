export class DeferJobError extends Error {
  constructor(
    message: string,
    readonly availableAt: Date,
  ) {
    super(message);
    this.name = "DeferJobError";
  }
}

export class TerminalJobError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "TerminalJobError";
  }
}

export function safeErrorSummary(error: unknown): string {
  const name = error instanceof Error ? error.name : "UnknownError";
  const message =
    error instanceof Error ? error.message : "Unknown worker failure";
  return `${name}: ${message}`.replace(/[\r\n\t]+/g, " ").slice(0, 500);
}
