import { describe, expect, it } from "vitest";

import {
  bankTransferInstructions,
  mapAdminBankTransfer,
  mapAdminBillingUser,
  mapBillingLedgerViews,
  mapBillingPaymentMethodViews,
  mapBillingPricingViews,
  mapBillingSummaryView,
  mapBillingTopupView,
} from "./billingAdapters";

describe("billing API adapters", () => {
  it("maps summary atoms without numeric conversion", () => {
    expect(
      mapBillingSummaryView({
        availableTenThousandths: "90071992547409930000",
        reservedTenThousandths: "100",
        spentTenThousandths: "500",
      }),
    ).toEqual({
      availableTenThousandths: "90071992547409930000",
      reservedTenThousandths: "100",
      totalSpentTenThousandths: "500",
    });
  });

  it("pairs screenshot prices into compact official pricing rows", () => {
    expect(
      mapBillingPricingViews([
        {
          id: "a",
          pricingClass: "domestic",
          mode: "search",
          screenshotEnabled: false,
          amountTenThousandths: "900",
        },
        {
          id: "b",
          pricingClass: "domestic",
          mode: "search",
          screenshotEnabled: true,
          amountTenThousandths: "1800",
        },
        {
          id: "c",
          pricingClass: "domestic",
          mode: "reasoning_search",
          screenshotEnabled: false,
          amountTenThousandths: "1800",
        },
        {
          id: "d",
          pricingClass: "domestic",
          mode: "reasoning_search",
          screenshotEnabled: true,
          amountTenThousandths: "2700",
        },
      ]),
    ).toEqual(
      expect.arrayContaining([
        {
          id: "domestic:standard",
          platformType: "国内平台",
          answerMode: "标准问答",
          withoutScreenshotTenThousandths: "900",
          withScreenshotTenThousandths: "1800",
          available: true,
        },
        {
          id: "domestic:reasoning",
          platformType: "国内平台",
          answerMode: "深度思考",
          withoutScreenshotTenThousandths: "1800",
          withScreenshotTenThousandths: "2700",
          available: true,
        },
        {
          id: "overseas:reasoning",
          platformType: "海外平台",
          answerMode: "深度思考",
          withoutScreenshotTenThousandths: undefined,
          withScreenshotTenThousandths: undefined,
          available: false,
        },
      ]),
    );
    expect(
      mapBillingPricingViews([
        {
          id: "only-standard",
          pricingClass: "domestic",
          mode: "search",
          screenshotEnabled: false,
          amountTenThousandths: "900",
        },
      ]).map((row) => row.answerMode),
    ).toEqual(["标准问答", "深度思考", "标准问答", "深度思考"]);
    const missingPricing = mapBillingPricingViews([]);
    expect(missingPricing).toHaveLength(4);
    expect(
      missingPricing.every((row) => !row.withScreenshotTenThousandths),
    ).toBe(true);
  });

  it("maps ledger semantics and server-configured payment methods", () => {
    expect(
      mapBillingLedgerViews([
        {
          id: "entry-1",
          type: "consume",
          balanceDeltaTenThousandths: "-900",
          reservedDeltaTenThousandths: "0",
          reason: "一次成功回答",
          referenceType: "run",
          referenceId: "run-1",
          createdAt: "2026-08-31T00:00:00.000Z",
        },
      ])[0],
    ).toMatchObject({
      type: "spend",
      balanceDeltaTenThousandths: "-900",
      description: "成功回答结算",
      relatedRun: "run-1",
    });
    expect(
      mapBillingLedgerViews([
        {
          id: "reserve-1",
          type: "reserve",
          balanceDeltaTenThousandths: "0",
          reservedDeltaTenThousandths: "1800",
          reason: "运行费用冻结",
          referenceType: "run",
          referenceId: "run-2",
          createdAt: "2026-08-31T00:00:00.000Z",
        },
        {
          id: "release-1",
          type: "release",
          balanceDeltaTenThousandths: "0",
          reservedDeltaTenThousandths: "-1800",
          reason: "未使用金额释放",
          referenceType: "attempt",
          referenceId: "attempt-2",
          createdAt: "2026-08-31T00:01:00.000Z",
        },
      ]).map(({ type, balanceDeltaTenThousandths }) => ({
        type,
        balanceDeltaTenThousandths,
      })),
    ).toEqual([
      { type: "freeze", balanceDeltaTenThousandths: "-1800" },
      { type: "release", balanceDeltaTenThousandths: "1800" },
    ]);
    expect(
      mapBillingPaymentMethodViews({
        onlinePayment: { configured: true, methods: ["alipay"] },
        bankTransfer: { configured: false },
      }).map(({ id, configured }) => ({ id, configured })),
    ).toEqual([
      { id: "alipay", configured: true },
      { id: "wxpay", configured: false },
      { id: "bank_transfer", configured: false },
    ]);
  });

  it("maps checkout, bank instructions and administrator account rows", () => {
    const methods = {
      onlinePayment: {
        configured: true,
        methods: ["alipay", "wxpay"] as Array<"alipay" | "wxpay">,
      },
      bankTransfer: {
        configured: true,
        details: {
          accountName: "FrontMind",
          bankName: "测试银行",
          accountNumber: "622200000000",
        },
      },
    };
    expect(bankTransferInstructions(methods)).toContain(
      "银行账号：622200000000",
    );
    expect(
      mapBillingTopupView({
        order: {
          id: "order-1",
          paymentMethod: "alipay",
          amountTenThousandths: "1000000",
          state: "pending",
        },
        checkout: {
          action: "https://pay.example.test",
          httpMethod: "POST",
          fields: { pid: "p1", cid: undefined },
        },
      }),
    ).toMatchObject({
      id: "order-1",
      status: "pending_payment",
      checkout: { fields: { pid: "p1" } },
    });
    expect(
      mapAdminBillingUser({
        id: "user-1",
        username: "weita",
        role: "user",
        status: "active",
        lastLoginAt: null,
        balanceTenThousandths: "3000000",
        reservedTenThousandths: "100000",
        spentTenThousandths: "200000",
        availableTenThousandths: "2900000",
      }),
    ).toMatchObject({
      username: "weita",
      balanceTenThousandths: "2900000",
      reservedTenThousandths: "100000",
    });
    expect(
      mapAdminBankTransfer({
        username: "weita",
        order: {
          id: "order-1",
          paymentMethod: "bank_transfer",
          amountTenThousandths: "5000000",
          state: "review_required",
        },
        review: {
          id: "review-1",
          orderId: "order-1",
          status: "pending",
          payerName: "维塔科技",
          transferredAt: "2026-08-31T00:00:00.000Z",
          remittanceReference: "BANK-1",
          submittedAt: "2026-08-31T00:01:00.000Z",
        },
      }),
    ).toMatchObject({
      id: "review-1",
      amountTenThousandths: "5000000",
      payerName: "维塔科技",
    });
  });
});
