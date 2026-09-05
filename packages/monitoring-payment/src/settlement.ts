import crypto from "node:crypto";
import { tenThousandthsToFen } from "./amount.js";
import type {
  OnlinePaymentMethod,
  PaymentSettlementOrder,
  PaymentSettlementStore,
  ReceiptCreditResult,
  TopupOrderState,
} from "./contracts.js";
import { PaymentError } from "./errors.js";
import {
  callbackTokenMatchesDigest,
  ZpayClient,
  type VerifiedZpayCallback,
} from "./zpay.js";

const RECONCILABLE_STATES = new Set<TopupOrderState>([
  "pending",
  "paid",
  "credited",
  "review_required",
  "expired",
  "cancelled",
]);

export type ReconciledZpayOrder =
  | {
      status: "pending";
      orderId: string;
      providerOrderId: string;
    }
  | {
      status: "credited" | "review_required";
      orderId: string;
      providerOrderId: string;
      outcome?: ReceiptCreditResult["outcome"];
      providerTradeNo?: string;
    };

export function assertZpayOrder(
  order: PaymentSettlementOrder | null,
): asserts order is PaymentSettlementOrder & {
  method: OnlinePaymentMethod;
} {
  if (!order) {
    throw new PaymentError("未找到支付订单", "PAYMENT_ORDER_NOT_FOUND", 404);
  }
  if (
    order.currency !== "CNY" ||
    (order.method !== "alipay" && order.method !== "wxpay")
  ) {
    throw new PaymentError(
      "支付订单不属于在线支付范围",
      "PAYMENT_CALLBACK_SCOPE_MISMATCH",
      409,
    );
  }
  if (!RECONCILABLE_STATES.has(order.state)) {
    throw new PaymentError(
      "支付订单状态不允许结算",
      "PAYMENT_ORDER_STATE_INVALID",
      409,
    );
  }
  tenThousandthsToFen(order.amountTenThousandths);
}

export function assertZpayCallbackMatchesOrder(
  callback: VerifiedZpayCallback,
  order: PaymentSettlementOrder | null,
): asserts order is PaymentSettlementOrder & {
  method: OnlinePaymentMethod;
} {
  assertZpayOrder(order);
  const amountFen = tenThousandthsToFen(order.amountTenThousandths);
  if (
    order.providerOrderId !== callback.providerOrderId ||
    order.method !== callback.method ||
    amountFen !== callback.amountFen ||
    !callbackTokenMatchesDigest(
      callback.callbackToken,
      order.callbackTokenDigest,
    )
  ) {
    throw new PaymentError(
      "支付通知与订单范围不匹配",
      "PAYMENT_CALLBACK_SCOPE_MISMATCH",
      409,
    );
  }
}

function settlementPayloadDigest(
  providerQueryDigest: string,
  callbackDigest?: string,
): string {
  return crypto
    .createHash("sha256")
    .update(
      JSON.stringify({
        schemaVersion: 1,
        provider: "zpay",
        providerQueryDigest,
        ...(callbackDigest ? { callbackDigest } : {}),
      }),
      "utf8",
    )
    .digest("hex");
}

/**
 * Shared reconciliation path for authenticated status checks and signed
 * notify wake-ups. The provider query is authoritative; callback fields never
 * directly create a receipt or credit. An API status endpoint must first
 * resolve an order through its authenticated owner, then pass that persisted
 * order's provider identifier here; never accept an arbitrary provider order
 * identifier from a browser without the ownership check.
 */
export class ZpaySettlementService {
  private readonly now: () => Date;

  constructor(
    private readonly client: ZpayClient,
    private readonly store: PaymentSettlementStore,
    options: { now?: () => Date } = {},
  ) {
    this.now = options.now ?? (() => new Date());
  }

  async reconcileProviderOrder(
    providerOrderId: string,
    options: { callback?: VerifiedZpayCallback } = {},
  ): Promise<ReconciledZpayOrder> {
    const order =
      await this.store.getTopupOrderByProviderOrderId(providerOrderId);
    if (options.callback) {
      if (
        options.callback.status !== "paid" ||
        !options.callback.providerTradeNo
      ) {
        throw new PaymentError(
          "支付渠道尚未确认交易成功",
          "PAYMENT_CALLBACK_INVALID",
          400,
        );
      }
      assertZpayCallbackMatchesOrder(options.callback, order);
    } else {
      assertZpayOrder(order);
      if (order.state === "credited" || order.state === "review_required") {
        return {
          status: order.state,
          orderId: order.id,
          providerOrderId: order.providerOrderId,
        };
      }
    }

    const amountFen = tenThousandthsToFen(order.amountTenThousandths);
    const providerStatus = await this.client.queryOrder({
      providerOrderId: order.providerOrderId,
      amountFen,
      method: order.method,
    });
    if (providerStatus.status !== "paid") {
      if (options.callback?.status === "paid") {
        throw new PaymentError(
          "支付渠道尚未返回可入账的最终结果",
          "PAYMENT_PROVIDER_RESPONSE_INVALID",
          502,
        );
      }
      return {
        status: "pending",
        orderId: order.id,
        providerOrderId: order.providerOrderId,
      };
    }
    if (
      options.callback?.providerTradeNo &&
      options.callback.providerTradeNo !== providerStatus.providerTradeNo
    ) {
      throw new PaymentError(
        "支付通知交易号与主动查询结果不一致",
        "PAYMENT_CALLBACK_SCOPE_MISMATCH",
        409,
      );
    }

    const result = await this.store.recordTopupReceiptAndCredit({
      provider: "zpay",
      providerOrderId: order.providerOrderId,
      providerTradeNo: providerStatus.providerTradeNo,
      amountTenThousandths: order.amountTenThousandths,
      paidAt: providerStatus.paidAt,
      payloadDigest: settlementPayloadDigest(
        providerStatus.payloadDigest,
        options.callback?.payloadDigest,
      ),
      receivedAt: this.now(),
    });
    if (
      result.orderId !== order.id ||
      result.providerTradeNo !== providerStatus.providerTradeNo ||
      (result.orderState !== "credited" &&
        result.orderState !== "review_required")
    ) {
      throw new PaymentError(
        "充值回执入账结果不一致",
        "PAYMENT_SETTLEMENT_FAILED",
        502,
      );
    }
    return {
      status: result.orderState,
      orderId: result.orderId,
      providerOrderId: order.providerOrderId,
      outcome: result.outcome,
      providerTradeNo: result.providerTradeNo,
    };
  }
}
