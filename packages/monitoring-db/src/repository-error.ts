export class RepositoryError extends Error {
  constructor(
    public readonly code:
      | "NOT_FOUND"
      | "FORBIDDEN"
      | "CONFLICT"
      | "QUOTA_EXCEEDED"
      | "BALANCE_INSUFFICIENT"
      | "INVALID_STATE",
    message: string,
  ) {
    super(message);
    this.name = "RepositoryError";
  }
}
