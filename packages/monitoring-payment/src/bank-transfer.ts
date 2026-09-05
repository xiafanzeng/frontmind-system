import type {
  BankTransferReviewInput,
  BankTransferReviewRecord,
  BankTransferReviewStore,
  BankTransferSubmissionInput,
} from "./contracts.js";
import { PaymentError } from "./errors.js";

function boundedText(
  value: string,
  field: string,
  minimum: number,
  maximum: number,
): string {
  const normalized = value.trim();
  if (normalized.length < minimum || normalized.length > maximum) {
    throw new PaymentError(
      `${field}格式无效`,
      "BANK_TRANSFER_REQUEST_INVALID",
      400,
    );
  }
  return normalized;
}

function canonicalDate(value: Date, field: string): Date {
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
    throw new PaymentError(
      `${field}格式无效`,
      "BANK_TRANSFER_REQUEST_INVALID",
      400,
    );
  }
  return new Date(value.getTime());
}

export class BankTransferService {
  constructor(private readonly store: BankTransferReviewStore) {}

  submit(
    input: BankTransferSubmissionInput,
  ): Promise<BankTransferReviewRecord> {
    const normalized: BankTransferSubmissionInput = {
      orderId: boundedText(input.orderId, "充值订单", 8, 128),
      userId: boundedText(input.userId, "用户", 1, 128),
      payerName: boundedText(input.payerName, "付款人或企业", 2, 160),
      transferredAt: canonicalDate(input.transferredAt, "实际转账时间"),
      remittanceReference: boundedText(
        input.remittanceReference,
        "汇款流水号",
        4,
        128,
      ),
      ...(input.evidenceObjectKey
        ? {
            evidenceObjectKey: boundedText(
              input.evidenceObjectKey,
              "转账凭证",
              1,
              512,
            ),
          }
        : {}),
      idempotencyKey: boundedText(input.idempotencyKey, "幂等键", 8, 200),
      submittedAt: canonicalDate(input.submittedAt, "提交时间"),
    };
    if (
      normalized.transferredAt.getTime() >
      normalized.submittedAt.getTime() + 5 * 60 * 1_000
    ) {
      throw new PaymentError(
        "实际转账时间不能晚于系统提交时间超过五分钟",
        "BANK_TRANSFER_REQUEST_INVALID",
        400,
      );
    }
    return this.store.submitBankTransferReview(normalized);
  }

  review(input: BankTransferReviewInput): Promise<BankTransferReviewRecord> {
    if (input.decision !== "approve" && input.decision !== "reject") {
      throw new PaymentError(
        "审核决定无效",
        "BANK_TRANSFER_REQUEST_INVALID",
        400,
      );
    }
    const reason = input.reviewReason.trim();
    if (!reason) {
      throw new PaymentError(
        "审核对公转账时必须填写说明",
        "BANK_TRANSFER_REQUEST_INVALID",
        400,
      );
    }
    const providerTradeNo = input.providerTradeNo?.trim();
    if (input.decision === "approve" && !providerTradeNo) {
      throw new PaymentError(
        "批准对公转账时必须填写银行流水号",
        "BANK_TRANSFER_REQUEST_INVALID",
        400,
      );
    }
    const normalized: BankTransferReviewInput = {
      reviewId: boundedText(input.reviewId, "审核记录", 8, 128),
      reviewerUserId: boundedText(input.reviewerUserId, "审核人", 1, 128),
      decision: input.decision,
      reviewReason: boundedText(reason, "审核说明", 1, 500),
      ...(providerTradeNo
        ? {
            providerTradeNo: boundedText(providerTradeNo, "银行流水号", 3, 191),
          }
        : {}),
      idempotencyKey: boundedText(input.idempotencyKey, "幂等键", 8, 200),
      reviewedAt: canonicalDate(input.reviewedAt, "审核时间"),
    };
    return this.store.reviewBankTransfer(normalized);
  }
}
