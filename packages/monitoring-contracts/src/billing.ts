import { z } from "zod";
import { idSchema, idempotencyKeySchema } from "./monitoring.js";
import { providerModeSchema, screenshotPolicySchema } from "./statuses.js";

export const moneyAmountSchema = z
  .string()
  .regex(/^-?(?:0|[1-9]\d*)$/u, "Expected integer 1/10,000 CNY units");
export const nonnegativeMoneyAmountSchema = moneyAmountSchema.refine(
  (value) => BigInt(value) >= 0n,
  "Money amount must be non-negative",
);
export const positiveFenCompatibleMoneyAmountSchema =
  nonnegativeMoneyAmountSchema.refine((value) => {
    const amount = BigInt(value);
    return amount >= 100_000n && amount <= 500_000_000n && amount % 100n === 0n;
  }, "Top-up amount must be between CNY 10 and CNY 50,000 in whole fen");

export const currencySchema = z.literal("CNY");
export const moneyScaleSchema = z.literal(4);
export const pricingClassSchema = z.enum(["domestic", "overseas"]);
export const moneyLedgerEntryTypeSchema = z.enum([
  "topup",
  "admin_adjustment",
  "reserve",
  "consume",
  "release",
]);
export const topupPaymentMethodSchema = z.enum([
  "alipay",
  "wxpay",
  "bank_transfer",
]);
export const topupOrderStateSchema = z.enum([
  "pending",
  "review_required",
  "paid",
  "credited",
  "expired",
  "cancelled",
  "rejected",
]);
export const bankTransferReviewStatusSchema = z.enum([
  "pending",
  "approved",
  "rejected",
]);

export const accountConsumptionSourceSchema = z.enum([
  "monitoring",
  "media_publishing",
  "ai",
]);
export const accountConsumptionTotalsSchema = z.object({
  totalTenThousandths: nonnegativeMoneyAmountSchema,
  last30DaysTenThousandths: nonnegativeMoneyAmountSchema,
});
export const consumptionBySourceSchema = z.object({
  monitoring: accountConsumptionTotalsSchema,
  media_publishing: accountConsumptionTotalsSchema,
  ai: accountConsumptionTotalsSchema,
});
export const accountActivityInputSchema = z.object({
  limit: z.number().int().min(1).max(500).optional(),
  source: accountConsumptionSourceSchema.optional(),
});
export const accountActivityOutputSchema = z.object({
  id: idSchema,
  source: accountConsumptionSourceSchema,
  type: z.string(),
  balanceDeltaTenThousandths: moneyAmountSchema,
  reservedDeltaTenThousandths: moneyAmountSchema,
  frozenDeltaTenThousandths: moneyAmountSchema,
  balanceAfterTenThousandths: moneyAmountSchema,
  reason: z.string(),
  referenceType: z.string().nullable(),
  referenceId: z.string().nullable(),
  createdAt: z.coerce.date(),
});
export const accountActivityPageInputSchema = z.object({
  page: z.number().int().min(1).max(1_000_000).default(1),
  source: accountConsumptionSourceSchema.optional(),
});
export const accountActivityPageOutputSchema = z.object({
  items: z.array(accountActivityOutputSchema).max(10),
  total: z.number().int().nonnegative(),
  page: z.number().int().positive(),
  pageSize: z.literal(10),
});

export const billingSummaryOutputSchema = z.object({
  userId: idSchema,
  currency: currencySchema,
  scale: moneyScaleSchema,
  balanceTenThousandths: moneyAmountSchema,
  accountingMode: z.literal("unified").optional(),
  consumptionBySource: consumptionBySourceSchema.optional(),
  frozenTenThousandths: nonnegativeMoneyAmountSchema.optional(),
  reservedTenThousandths: nonnegativeMoneyAmountSchema,
  spentTenThousandths: nonnegativeMoneyAmountSchema,
  availableTenThousandths: moneyAmountSchema,
});

export const pricingItemOutputSchema = z.object({
  id: idSchema,
  pricingClass: pricingClassSchema,
  mode: providerModeSchema,
  screenshotEnabled: z.boolean(),
  amountTenThousandths: nonnegativeMoneyAmountSchema,
});

export const pricingOutputSchema = z.object({
  versionId: z.string().min(1).max(36),
  code: z.string(),
  currency: currencySchema,
  scale: moneyScaleSchema,
  sourceUrl: z.string().url(),
  effectiveFrom: z.coerce.date(),
  items: z.array(pricingItemOutputSchema),
});

export const billingQuoteInputSchema = z
  .object({
    items: z
      .array(
        z.object({
          platformId: idSchema,
          mode: providerModeSchema,
          screenshot: screenshotPolicySchema,
          regionCode: z.string().trim().min(1).max(64).nullable().optional(),
          quantity: z.number().int().min(1).max(500),
        }),
      )
      .min(1)
      .max(500),
  })
  .superRefine((value, ctx) => {
    const count = value.items.reduce((sum, item) => sum + item.quantity, 0);
    if (count > 500) {
      ctx.addIssue({
        code: "custom",
        path: ["items"],
        message: "A quote may contain at most 500 provider attempts",
      });
    }
  });

export const billingQuoteOutputSchema = z.object({
  pricingVersionId: z.string().min(1).max(36),
  currency: currencySchema,
  scale: moneyScaleSchema,
  items: z.array(
    z.object({
      platformId: idSchema,
      pricingClass: pricingClassSchema,
      mode: providerModeSchema,
      screenshotEnabled: z.boolean(),
      quantity: z.number().int().positive(),
      unitAmountTenThousandths: nonnegativeMoneyAmountSchema,
      totalAmountTenThousandths: nonnegativeMoneyAmountSchema,
    }),
  ),
  totalAmountTenThousandths: nonnegativeMoneyAmountSchema,
});

export const billingMonitorQuoteInputSchema = z.object({
  monitorId: idSchema,
});

export const billingMonitorQuoteOutputSchema = z.object({
  monitorId: idSchema,
  pricingVersionId: z.string().min(1).max(36),
  currency: currencySchema,
  scale: moneyScaleSchema,
  totalAmountTenThousandths: nonnegativeMoneyAmountSchema,
  availableTenThousandths: moneyAmountSchema,
  sufficient: z.boolean(),
});

export const billingLedgerEntryOutputSchema = z.object({
  id: idSchema,
  type: moneyLedgerEntryTypeSchema,
  balanceDeltaTenThousandths: moneyAmountSchema,
  reservedDeltaTenThousandths: moneyAmountSchema,
  balanceAfterTenThousandths: moneyAmountSchema,
  reservedAfterTenThousandths: nonnegativeMoneyAmountSchema,
  reason: z.string(),
  referenceType: z.string().nullable(),
  referenceId: z.string().nullable(),
  createdAt: z.coerce.date(),
});

export const createTopupOrderInputSchema = z.object({
  paymentMethod: topupPaymentMethodSchema,
  amountTenThousandths: positiveFenCompatibleMoneyAmountSchema,
  idempotencyKey: idempotencyKeySchema,
});

export const topupOrderOutputSchema = z.object({
  id: idSchema,
  providerOrderId: z.string(),
  paymentMethod: topupPaymentMethodSchema,
  amountTenThousandths: positiveFenCompatibleMoneyAmountSchema,
  currency: currencySchema,
  scale: moneyScaleSchema,
  state: topupOrderStateSchema,
  checkoutExpiresAt: z.coerce.date(),
  paidAt: z.coerce.date().nullable(),
  creditedAt: z.coerce.date().nullable(),
  createdAt: z.coerce.date(),
});

export const paymentMethodsOutputSchema = z.object({
  configured: z.boolean(),
  onlinePayment: z.object({
    configured: z.boolean(),
    provider: z.literal("zpay").nullable(),
    methods: z.array(z.enum(["alipay", "wxpay"])),
  }),
  bankTransfer: z.object({
    configured: z.boolean(),
    details: z
      .object({
        accountName: z.string(),
        bankName: z.string(),
        accountNumber: z.string(),
        branchName: z.string().optional(),
        transferNoteHint: z.string().optional(),
      })
      .optional(),
  }),
});

export const topupCheckoutOutputSchema = z.object({
  provider: z.literal("zpay"),
  providerOrderId: z.string().regex(/^[1-9]\d{0,31}$/u),
  amountFen: z.number().int().positive(),
  method: z.enum(["alipay", "wxpay"]),
  action: z.literal("https://zpayz.cn/submit.php"),
  httpMethod: z.literal("POST"),
  fields: z.object({
    pid: z.string(),
    type: z.enum(["alipay", "wxpay"]),
    out_trade_no: z.string().regex(/^[1-9]\d{0,31}$/u),
    notify_url: z.string().url(),
    return_url: z.string().url(),
    name: z.string(),
    money: z.string().regex(/^(?:0|[1-9]\d*)\.\d{2}$/u),
    param: z.string().min(16),
    cid: z.string().optional(),
    sign: z.string().regex(/^[a-f0-9]{32}$/u),
    sign_type: z.literal("MD5"),
  }),
});

export const createTopupOrderOutputSchema = z.object({
  order: topupOrderOutputSchema,
  checkout: topupCheckoutOutputSchema.nullable(),
});

export const topupStatusInputSchema = z.object({ orderId: idSchema });
export const topupStatusOutputSchema = z.object({
  order: topupOrderOutputSchema,
  reconciliation: z.enum([
    "not_applicable",
    "unavailable",
    "pending",
    "credited",
    "review_required",
  ]),
});

export const switchTopupPaymentMethodInputSchema = z.object({
  orderId: idSchema,
  expectedPaymentMethod: topupPaymentMethodSchema,
  paymentMethod: topupPaymentMethodSchema,
});

export const switchTopupPaymentMethodOutputSchema =
  createTopupOrderOutputSchema;

export const bankTransferReviewOutputSchema = z.object({
  id: idSchema,
  orderId: idSchema,
  status: bankTransferReviewStatusSchema,
  payerName: z.string(),
  transferredAt: z.coerce.date(),
  remittanceReference: z.string(),
  evidenceSubmitted: z.boolean(),
  submittedAt: z.coerce.date(),
  reviewedBy: idSchema.nullable(),
  reviewReason: z.string().nullable(),
  reviewedAt: z.coerce.date().nullable(),
});

export const submitBankTransferReviewOutputSchema = z.object({
  review: bankTransferReviewOutputSchema,
  order: topupOrderOutputSchema,
});

export const adminBillingUserOutputSchema = z.object({
  id: idSchema,
  username: z.string(),
  role: z.enum(["user", "admin"]),
  status: z.enum(["active", "disabled"]),
  lastLoginAt: z.coerce.date().nullable(),
  createdAt: z.coerce.date(),
  currency: currencySchema,
  scale: moneyScaleSchema,
  balanceTenThousandths: moneyAmountSchema,
  reservedTenThousandths: nonnegativeMoneyAmountSchema,
  spentTenThousandths: nonnegativeMoneyAmountSchema,
  availableTenThousandths: moneyAmountSchema,
});

export const adminBankTransferOutputSchema = z.object({
  review: bankTransferReviewOutputSchema,
  order: topupOrderOutputSchema,
  username: z.string(),
});

export const approveBankTransferInputSchema = z.object({
  reviewId: idSchema,
  reason: z.string().trim().min(3).max(240),
  providerTradeNo: z.string().trim().min(3).max(191),
});

export const rejectBankTransferInputSchema = z.object({
  reviewId: idSchema,
  reason: z.string().trim().min(3).max(240),
});

export const adminBillingAdjustmentInputSchema = z.object({
  userId: idSchema,
  amountTenThousandths: moneyAmountSchema.refine(
    (value) => BigInt(value) !== 0n,
    "Adjustment must be non-zero",
  ),
  reason: z.string().trim().min(3).max(240),
  idempotencyKey: idempotencyKeySchema,
});

export const submitBankTransferReviewInputSchema = z.object({
  orderId: idSchema,
  payerName: z.string().trim().min(2).max(120),
  transferredAt: z.coerce
    .date()
    .refine(
      (value) => value.getTime() <= Date.now() + 5 * 60 * 1_000,
      "Transfer time cannot be in the future",
    ),
  remittanceReference: z.string().trim().min(3).max(191),
  evidenceObjectKey: z.string().trim().min(1).max(1_024).optional(),
});

export const reviewBankTransferInputSchema = z.object({
  reviewId: idSchema,
  decision: z.enum(["approve", "reject"]),
  reason: z.string().trim().min(3).max(240),
  providerTradeNo: z.string().trim().min(3).max(191).optional(),
});

export type BillingSummaryOutput = z.infer<typeof billingSummaryOutputSchema>;
export type PricingOutput = z.infer<typeof pricingOutputSchema>;
export type BillingQuoteInput = z.infer<typeof billingQuoteInputSchema>;
export type BillingQuoteOutput = z.infer<typeof billingQuoteOutputSchema>;
export type CreateTopupOrderInput = z.infer<typeof createTopupOrderInputSchema>;
export type PaymentMethodsOutput = z.infer<typeof paymentMethodsOutputSchema>;
export type TopupOrderOutput = z.infer<typeof topupOrderOutputSchema>;
export type CreateTopupOrderOutput = z.infer<
  typeof createTopupOrderOutputSchema
>;
export type AdminBillingAdjustmentInput = z.infer<
  typeof adminBillingAdjustmentInputSchema
>;
