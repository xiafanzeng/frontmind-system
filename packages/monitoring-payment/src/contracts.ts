export type OnlinePaymentMethod = "alipay" | "wxpay";
export type PaymentMethod = OnlinePaymentMethod | "bank_transfer";

export type TopupOrderState =
  | "pending"
  | "review_required"
  | "paid"
  | "credited"
  | "expired"
  | "cancelled"
  | "rejected";

const TOPUP_ORDER_TRANSITIONS: Readonly<
  Record<TopupOrderState, ReadonlySet<TopupOrderState>>
> = {
  pending: new Set([
    "review_required",
    "paid",
    "credited",
    "expired",
    "cancelled",
    "rejected",
  ]),
  review_required: new Set(["paid", "credited", "cancelled", "rejected"]),
  paid: new Set(["credited", "review_required"]),
  credited: new Set(),
  expired: new Set(["review_required"]),
  cancelled: new Set(["review_required"]),
  rejected: new Set(),
};

/**
 * Late, signed provider settlements can move an expired/cancelled order into
 * manual review, but terminal funds states never move backwards.
 */
export function canTransitionTopupOrderState(
  from: TopupOrderState,
  to: TopupOrderState,
): boolean {
  return from === to || TOPUP_ORDER_TRANSITIONS[from].has(to);
}

export type PaymentSettlementOrder = {
  id: string;
  providerOrderId: string;
  userId: string;
  method: PaymentMethod;
  amountTenThousandths: bigint;
  currency: "CNY";
  state: TopupOrderState;
  callbackTokenDigest: string;
  checkoutExpiresAt: Date;
};

export type ZpayReceiptForCredit = {
  provider: "zpay";
  providerOrderId: string;
  providerTradeNo: string;
  amountTenThousandths: bigint;
  paidAt: Date;
  payloadDigest: string;
  receivedAt: Date;
};

export type ReceiptCreditResult = {
  outcome: "recorded" | "replayed";
  orderId: string;
  orderState: "credited" | "review_required";
  providerTradeNo: string;
};

/**
 * Implementations must atomically verify the persisted order scope, insert or
 * replay the unique receipt, credit the balance ledger exactly once, and move
 * an eligible order to `credited`. A valid late settlement may instead be
 * recorded as `review_required` without credit. A scope conflict must reject
 * instead of returning replay. Returning the persisted identity and replay
 * outcome lets the caller verify that an idempotent response is bound to the
 * exact same order and provider trade.
 */
export interface PaymentSettlementStore {
  getTopupOrderByProviderOrderId(
    providerOrderId: string,
  ): Promise<PaymentSettlementOrder | null>;
  recordTopupReceiptAndCredit(
    receipt: ZpayReceiptForCredit,
  ): Promise<ReceiptCreditResult>;
}

export type BankTransferSubmissionInput = {
  orderId: string;
  userId: string;
  payerName: string;
  transferredAt: Date;
  remittanceReference: string;
  evidenceObjectKey?: string;
  idempotencyKey: string;
  submittedAt: Date;
};

export type BankTransferReviewDecision = "approve" | "reject";

export type BankTransferReviewInput = {
  reviewId: string;
  reviewerUserId: string;
  decision: BankTransferReviewDecision;
  reviewReason: string;
  providerTradeNo?: string;
  idempotencyKey: string;
  reviewedAt: Date;
};

export type BankTransferReviewRecord = {
  id: string;
  orderId: string;
  status: "pending" | "approved" | "rejected";
  payerName: string;
  transferredAt: Date;
  remittanceReference: string;
  evidenceObjectKey?: string;
  submittedAt: Date;
  reviewedBy?: string;
  reviewReason?: string;
  reviewedAt?: Date;
};

/**
 * Authentication and role checks belong to the API layer. Implementations
 * must still enforce order ownership on submit and administrator authority on
 * review. Approval must create the bank receipt and balance credit atomically.
 */
export interface BankTransferReviewStore {
  submitBankTransferReview(
    input: BankTransferSubmissionInput,
  ): Promise<BankTransferReviewRecord>;
  reviewBankTransfer(
    input: BankTransferReviewInput,
  ): Promise<BankTransferReviewRecord>;
}
