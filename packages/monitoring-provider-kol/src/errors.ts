export type KolProviderErrorCode =
  | "invalid_configuration"
  | "authentication_failed"
  | "authentication_blocked"
  | "rate_limited"
  | "upstream_unavailable"
  | "invalid_response"
  | "order_rejected"
  | "submission_unknown"
  | "publishing_disabled"
  | "test_resource_required";

export class KolProviderError extends Error {
  readonly retryable: boolean;
  readonly submissionMayHaveSucceeded: boolean;

  constructor(
    readonly code: KolProviderErrorCode,
    message: string,
    readonly details: Readonly<{
      operation: string;
      httpStatus?: number;
      retryable?: boolean;
      submissionMayHaveSucceeded?: boolean;
    }>,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = new.target.name;
    this.retryable = details.retryable ?? false;
    this.submissionMayHaveSucceeded =
      details.submissionMayHaveSucceeded ?? false;
  }
}

export class KolSubmissionUnknownError extends KolProviderError {
  constructor(
    message = "The KOL order may have been created but no authoritative order id was returned; automatic retry is forbidden",
    details: Readonly<{ httpStatus?: number }> = {},
    options?: ErrorOptions,
  ) {
    super(
      "submission_unknown",
      message,
      {
        operation: "create_order",
        httpStatus: details.httpStatus,
        submissionMayHaveSucceeded: true,
      },
      options,
    );
  }
}

export function isKolProviderError(error: unknown): error is KolProviderError {
  return error instanceof KolProviderError;
}
