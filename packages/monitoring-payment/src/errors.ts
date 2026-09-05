export type PaymentErrorCode =
  | "PAYMENT_CONFIGURATION_INVALID"
  | "PAYMENT_PROVIDER_DISABLED"
  | "PAYMENT_REQUEST_INVALID"
  | "PAYMENT_CALLBACK_INVALID"
  | "PAYMENT_CALLBACK_SCOPE_MISMATCH"
  | "PAYMENT_ORDER_NOT_FOUND"
  | "PAYMENT_ORDER_STATE_INVALID"
  | "PAYMENT_PROVIDER_UNAVAILABLE"
  | "PAYMENT_PROVIDER_REJECTED"
  | "PAYMENT_PROVIDER_RESPONSE_INVALID"
  | "PAYMENT_SETTLEMENT_FAILED"
  | "BANK_TRANSFER_REQUEST_INVALID";

export class PaymentError extends Error {
  constructor(
    message: string,
    readonly code: PaymentErrorCode,
    readonly status: number,
  ) {
    super(message);
    this.name = "PaymentError";
  }
}

export function paymentErrorCode(error: unknown): PaymentErrorCode {
  return error instanceof PaymentError
    ? error.code
    : "PAYMENT_SETTLEMENT_FAILED";
}
