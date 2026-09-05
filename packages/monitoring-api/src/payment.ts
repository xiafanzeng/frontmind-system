import crypto from "node:crypto";
import type { TopupOrderOutput } from "@frontmind/monitoring-contracts";
import type {
  MonitoringRepository,
  PublishingRepository,
  RequestAudit,
} from "@frontmind/monitoring-db";
import {
  BankTransferService,
  PaymentError,
  ZpayClient,
  ZpaySettlementService,
  deriveZpayProviderOrderId,
  digestCallbackToken,
  tenThousandthsToFen,
  type BankTransferReviewRecord,
  type BankTransferReviewStore,
  type PaymentConfiguration,
  type PaymentMethod,
  type PaymentSettlementStore,
  type ZpayCheckout,
} from "@frontmind/monitoring-payment";

export const TOPUP_CHECKOUT_TTL_MS = 30 * 60 * 1_000;

function safePaymentMethod(value: string): PaymentMethod {
  if (value !== "alipay" && value !== "wxpay" && value !== "bank_transfer") {
    throw new PaymentError(
      "充值订单支付方式无效",
      "PAYMENT_ORDER_STATE_INVALID",
      409,
    );
  }
  return value;
}

/**
 * The browser must submit this token to ZPAY, so it is not treated as a user
 * credential. HMAC derivation keeps it unpredictable and lets idempotent
 * checkout responses be reconstructed without persisting the raw token.
 */
export function deriveTopupCallbackToken(input: {
  sessionSecret: string;
  userId: string;
  providerOrderId: string;
}): string {
  return crypto
    .createHmac("sha256", input.sessionSecret)
    .update(
      JSON.stringify([
        "frontmind:topup-callback:v1",
        input.userId,
        input.providerOrderId,
      ]),
      "utf8",
    )
    .digest("base64url");
}

export function newTopupIdentity(input: {
  sessionSecret: string;
  userId: string;
  idempotencyKey: string;
}) {
  const providerOrderId = deriveZpayProviderOrderId({
    userId: input.userId,
    idempotencyKey: input.idempotencyKey,
  });
  const callbackToken = deriveTopupCallbackToken({
    sessionSecret: input.sessionSecret,
    userId: input.userId,
    providerOrderId,
  });
  return {
    providerOrderId,
    callbackToken,
    callbackTokenDigest: digestCallbackToken(callbackToken),
  };
}

export function createPaymentSettlementStore(
  repository: MonitoringRepository,
  publishingRepository?: PublishingRepository,
): PaymentSettlementStore {
  return {
    async getTopupOrderByProviderOrderId(providerOrderId) {
      const route = publishingRepository
        ? await publishingRepository.resolvePaymentOrderRoute(providerOrderId)
        : null;
      const order =
        route?.walletScope === "media_publishing" && publishingRepository
          ? await publishingRepository.getMediaPublishingTopupOrderByProviderOrderId(
              providerOrderId,
            )
          : await repository.getTopupOrderByProviderOrderId(providerOrderId);
      if (!order) return null;
      if (order.currency !== "CNY") {
        throw new PaymentError(
          "充值订单币种无效",
          "PAYMENT_ORDER_STATE_INVALID",
          409,
        );
      }
      return {
        id: order.id,
        providerOrderId: order.providerOrderId,
        userId: order.userId,
        method: safePaymentMethod(
          "method" in order && typeof order.method === "string"
            ? order.method
            : order.paymentMethod,
        ),
        amountTenThousandths: order.amountTenThousandths,
        currency: "CNY",
        state: order.state,
        callbackTokenDigest: order.callbackTokenDigest,
        checkoutExpiresAt: order.checkoutExpiresAt,
      };
    },
    async recordTopupReceiptAndCredit(receipt) {
      const route = publishingRepository
        ? await publishingRepository.resolvePaymentOrderRoute(
            receipt.providerOrderId,
          )
        : null;
      return route?.walletScope === "media_publishing" && publishingRepository
        ? publishingRepository.recordMediaPublishingTopupReceiptAndCredit(
            receipt,
          )
        : repository.recordTopupReceiptAndCredit(receipt);
    },
  };
}

export function createZpaySettlementService(input: {
  configuration: PaymentConfiguration;
  repository: MonitoringRepository;
  publishingRepository?: PublishingRepository;
  fetchImpl?: typeof fetch;
  now?: () => Date;
}): ZpaySettlementService | undefined {
  if (!input.configuration.zpay) return undefined;
  return new ZpaySettlementService(
    new ZpayClient(input.configuration.zpay, {
      ...(input.fetchImpl ? { fetchImpl: input.fetchImpl } : {}),
      ...(input.now ? { now: input.now } : {}),
    }),
    createPaymentSettlementStore(
      input.repository,
      input.publishingRepository,
    ),
    input.now ? { now: input.now } : {},
  );
}

export function isPaymentMethodConfigured(
  configuration: PaymentConfiguration,
  method: PaymentMethod,
): boolean {
  return method === "bank_transfer"
    ? Boolean(configuration.bankTransfer)
    : Boolean(configuration.zpay);
}

export function createCheckoutForOrder(input: {
  configuration: PaymentConfiguration;
  sessionSecret: string;
  userId: string;
  order: TopupOrderOutput;
  observedAt?: Date;
}): ZpayCheckout | null {
  const method = safePaymentMethod(input.order.paymentMethod);
  const observedAt = input.observedAt ?? new Date();
  if (
    method === "bank_transfer" ||
    input.order.state !== "pending" ||
    input.order.checkoutExpiresAt.getTime() <= observedAt.getTime()
  ) {
    return null;
  }
  if (!input.configuration.zpay) {
    throw new PaymentError(
      "在线支付暂未配置",
      "PAYMENT_PROVIDER_DISABLED",
      503,
    );
  }
  const callbackToken = deriveTopupCallbackToken({
    sessionSecret: input.sessionSecret,
    userId: input.userId,
    providerOrderId: input.order.providerOrderId,
  });
  return new ZpayClient(input.configuration.zpay).createCheckout({
    providerOrderId: input.order.providerOrderId,
    amountFen: tenThousandthsToFen(BigInt(input.order.amountTenThousandths)),
    method,
    subject: "FrontMind 账户充值",
    callbackToken,
  });
}

function bankReviewRecord(value: {
  id: string;
  orderId: string;
  status: string;
  payerName: string;
  transferredAt: Date;
  remittanceReference: string;
  evidenceObjectKey?: string | null;
  submittedAt: Date;
  reviewedBy?: string | null;
  reviewReason?: string | null;
  reviewedAt?: Date | null;
}): BankTransferReviewRecord {
  if (
    value.status !== "pending" &&
    value.status !== "approved" &&
    value.status !== "rejected"
  ) {
    throw new PaymentError(
      "企业转账审核状态无效",
      "PAYMENT_ORDER_STATE_INVALID",
      409,
    );
  }
  return {
    id: value.id,
    orderId: value.orderId,
    status: value.status,
    payerName: value.payerName,
    transferredAt: value.transferredAt,
    remittanceReference: value.remittanceReference,
    ...(value.evidenceObjectKey
      ? { evidenceObjectKey: value.evidenceObjectKey }
      : {}),
    submittedAt: value.submittedAt,
    ...(value.reviewedBy ? { reviewedBy: value.reviewedBy } : {}),
    ...(value.reviewReason ? { reviewReason: value.reviewReason } : {}),
    ...(value.reviewedAt ? { reviewedAt: value.reviewedAt } : {}),
  };
}

export function createBankTransferService(input: {
  repository: MonitoringRepository;
  audit: RequestAudit;
}): BankTransferService {
  const store: BankTransferReviewStore = {
    async submitBankTransferReview(submission) {
      return bankReviewRecord(
        await input.repository.submitBankTransferReview({
          userId: submission.userId,
          orderId: submission.orderId,
          payerName: submission.payerName,
          transferredAt: submission.transferredAt,
          remittanceReference: submission.remittanceReference,
          ...(submission.evidenceObjectKey
            ? { evidenceObjectKey: submission.evidenceObjectKey }
            : {}),
          submittedAt: submission.submittedAt,
        }),
      );
    },
    async reviewBankTransfer(review) {
      return bankReviewRecord(
        await input.repository.reviewBankTransfer(
          {
            reviewId: review.reviewId,
            decision: review.decision,
            reason: review.reviewReason,
            ...(review.providerTradeNo
              ? { providerTradeNo: review.providerTradeNo }
              : {}),
            reviewedAt: review.reviewedAt,
          },
          input.audit,
        ),
      );
    },
  };
  return new BankTransferService(store);
}
