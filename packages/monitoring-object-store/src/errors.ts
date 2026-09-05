export class ObjectStoreError extends Error {
  constructor(
    message: string,
    readonly details: Readonly<Record<string, unknown>> = {},
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = new.target.name;
  }
}

export class RemoteMediaRejectedError extends ObjectStoreError {}
export class RemoteMediaFetchError extends ObjectStoreError {}
export class ObjectStoreReadLimitError extends ObjectStoreError {}
export class OssRequestError extends ObjectStoreError {
  readonly retryable: boolean;

  constructor(
    message: string,
    readonly status: number,
    details: Readonly<Record<string, unknown>> = {},
  ) {
    super(message, { ...details, status });
    this.retryable = status === 408 || status === 429 || status >= 500;
  }
}
