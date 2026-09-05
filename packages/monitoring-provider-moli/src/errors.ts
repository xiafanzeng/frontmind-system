export class MoliError extends Error {
  constructor(
    message: string,
    readonly details: Readonly<Record<string, unknown>> = {},
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = new.target.name;
  }
}

export class MoliConfigurationError extends MoliError {}

export class MoliTransportError extends MoliError {
  readonly retryable = true;
}

export class MoliSubmissionUnknownError extends MoliTransportError {
  constructor(
    message: string,
    readonly consumerTaskId: string,
    details: Readonly<Record<string, unknown>> = {},
    options?: ErrorOptions,
  ) {
    super(message, { ...details, consumerTaskId }, options);
  }
}

export class MoliHttpError extends MoliError {
  readonly retryable: boolean;

  constructor(
    message: string,
    readonly status: number,
    details: Readonly<Record<string, unknown>> = {},
    options?: ErrorOptions,
  ) {
    super(message, { ...details, status }, options);
    this.retryable = status === 408 || status === 429 || status >= 500;
  }
}

export class MoliApiError extends MoliError {
  readonly retryable: boolean;

  constructor(
    message: string,
    readonly code: string | number | undefined,
    details: Readonly<Record<string, unknown>> = {},
  ) {
    super(message, { ...details, code });
    const normalized = String(code ?? "").toLowerCase();
    this.retryable =
      normalized.includes("timeout") ||
      normalized.includes("busy") ||
      normalized.includes("limit") ||
      normalized === "429" ||
      normalized.startsWith("5");
  }
}

export class MoliResponseError extends MoliError {}
