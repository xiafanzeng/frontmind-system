import { Router, type Request, type Response } from "express";
import type { PaymentSettlementStore } from "./contracts.js";
import type { PaymentConfiguration } from "./config.js";
import { PaymentError, paymentErrorCode } from "./errors.js";
import { ZpayClient } from "./zpay.js";
import {
  assertZpayCallbackMatchesOrder,
  ZpaySettlementService,
} from "./settlement.js";

export type PaymentRouterLogger = {
  warn(event: string, details: { code: string }): void;
};

export type CreatePaymentRouterOptions = {
  configuration: PaymentConfiguration;
  settlementStore: PaymentSettlementStore;
  fetchImpl?: typeof fetch;
  now?: () => Date;
  logger?: PaymentRouterLogger;
};

type ReturnPageStatus = "paid" | "review_required" | "pending" | "unverified";

function callbackParameters(query: Request["query"]): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(query)) {
    if (typeof value !== "string") {
      throw new PaymentError(
        "支付通知参数格式无效",
        "PAYMENT_CALLBACK_INVALID",
        400,
      );
    }
    result[key] = value;
  }
  return result;
}

function returnPageStatus(order: { state: string }): ReturnPageStatus {
  if (order.state === "credited") return "paid";
  if (order.state === "review_required") return "review_required";
  return "pending";
}

function paymentReturnPage(status: ReturnPageStatus): string {
  const content: Record<ReturnPageStatus, { title: string; message: string }> =
    {
      paid: {
        title: "充值结果已确认",
        message: "充值已经安全入账，可以关闭此页面并返回账户设置。",
      },
      review_required: {
        title: "充值需要人工核对",
        message:
          "付款记录已保存，但当前不能自动入账。请勿重复支付，并联系管理员核对。",
      },
      pending: {
        title: "正在确认充值结果",
        message:
          "异步通知可能仍在处理中，请关闭此页面并返回账户设置查看最新状态。",
      },
      unverified: {
        title: "充值结果暂未确认",
        message: "当前页面不能作为入账依据，请返回账户设置查看订单状态。",
      },
    };
  const selected = content[status];
  return `<!doctype html>
<html lang="zh-CN">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width,initial-scale=1" />
    <title>${selected.title} · FrontMind</title>
    <style>
      :root { color-scheme: light; font-family: -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif; }
      body { display:grid;min-height:100vh;place-items:center;margin:0;background:#f6f5f8;color:#272330; }
      main { width:min(520px,calc(100% - 40px));box-sizing:border-box;border:1px solid #e2dfe7;border-radius:16px;background:#fff;padding:36px;box-shadow:0 20px 60px rgba(48,34,64,.12); }
      h1 { margin:0 0 12px;font-size:28px;line-height:1.3; }
      p { margin:0;color:#716b78;font-size:15px;line-height:1.75; }
    </style>
  </head>
  <body><main><h1>${selected.title}</h1><p>${selected.message}</p></main></body>
</html>`;
}

/**
 * Mount this router at `/api/payments`. The return route is deliberately
 * read-only. The signed asynchronous notify route only wakes the same
 * authoritative provider-query reconciliation used by authenticated status
 * checks.
 */
export function createPaymentRouter(
  options: CreatePaymentRouterOptions,
): Router {
  const router = Router();
  const zpay = options.configuration.zpay
    ? new ZpayClient(options.configuration.zpay, {
        ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
        ...(options.now ? { now: options.now } : {}),
      })
    : undefined;
  const now = options.now ?? (() => new Date());
  const settlement = zpay
    ? new ZpaySettlementService(zpay, options.settlementStore, { now })
    : undefined;

  const rejectHead = (_request: Request, response: Response) => {
    response.setHeader("Allow", "GET");
    response.status(405).end();
  };
  router.head("/zpay/notify", rejectHead);
  router.head("/zpay/return", rejectHead);

  router.get("/zpay/notify", async (request, response) => {
    try {
      if (!zpay) {
        throw new PaymentError(
          "在线支付未配置",
          "PAYMENT_PROVIDER_DISABLED",
          503,
        );
      }
      const callback = zpay.verifyCallback(callbackParameters(request.query));
      if (callback.status !== "paid" || !callback.providerTradeNo) {
        throw new PaymentError(
          "支付渠道尚未确认交易成功",
          "PAYMENT_CALLBACK_INVALID",
          400,
        );
      }
      await settlement!.reconcileProviderOrder(callback.providerOrderId, {
        callback,
      });
      response.status(200).type("text/plain").send("success");
    } catch (error) {
      options.logger?.warn("zpay_notify_rejected", {
        code: paymentErrorCode(error),
      });
      const status =
        error instanceof PaymentError && error.status < 500
          ? error.status
          : 503;
      response.status(status).type("text/plain").send("fail");
    }
  });

  router.get("/zpay/return", async (request, response) => {
    let status: ReturnPageStatus = "unverified";
    if (zpay) {
      try {
        const callback = zpay.verifyCallback(callbackParameters(request.query));
        const order =
          await options.settlementStore.getTopupOrderByProviderOrderId(
            callback.providerOrderId,
          );
        assertZpayCallbackMatchesOrder(callback, order);
        status = returnPageStatus(order);
      } catch (error) {
        options.logger?.warn("zpay_return_unverified", {
          code: paymentErrorCode(error),
        });
      }
    }
    response
      .status(status === "unverified" ? 400 : 200)
      .setHeader("Cache-Control", "no-store");
    response.setHeader(
      "Content-Security-Policy",
      "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; frame-ancestors 'none'",
    );
    response.type("html").send(paymentReturnPage(status));
  });

  return router;
}
