import { describe, expect, it } from "vitest";

import {
  paymentReceiptReadRequestSchema,
  paymentReceiptReadyResponseSchema,
  paymentReceiptResponseSchema,
  paymentReceiptWriteRequestSchema,
} from "../shared/payment-receipt";

const receipt = {
  orderId: "order-20260728-0001",
  tradeNo: "zpay-trade-20260728-0001",
  amountFen: 150_000,
  paidAt: "2026-07-28T08:30:00.123Z",
  purchaseType: "service" as const,
  scopeHash: "a".repeat(64),
  authorizationDigest: "b".repeat(64),
  reviewRequired: false,
};

describe("payment receipt v1 contract", () => {
  it("accepts only the bounded immutable receipt shape", () => {
    expect(
      paymentReceiptWriteRequestSchema.parse({
        schemaVersion: 1,
        receipt,
      }),
    ).toEqual({ schemaVersion: 1, receipt });
    for (const patch of [
      { orderId: "short" },
      { orderId: "order with spaces" },
      { tradeNo: undefined },
      { tradeNo: "" },
      { tradeNo: "x".repeat(129) },
      { amountFen: 0 },
      { amountFen: 1.5 },
      { amountFen: 10_000_001 },
      { paidAt: "2026-07-28T08:30:00Z" },
      { paidAt: "2026-02-30T08:30:00.000Z" },
      { purchaseType: "report" },
      { scopeHash: "A".repeat(64) },
      { authorizationDigest: "not-a-digest" },
      { reviewRequired: "false" },
    ]) {
      expect(() =>
        paymentReceiptWriteRequestSchema.parse({
          schemaVersion: 1,
          receipt: { ...receipt, ...patch },
        }),
      ).toThrow();
    }
  });

  it("rejects version drift, raw authorization, sessions, and user content", () => {
    expect(() =>
      paymentReceiptWriteRequestSchema.parse({
        schemaVersion: 2,
        receipt,
      }),
    ).toThrow();
    for (const injected of [
      { authorization: "raw-browser-capability" },
      { session: "raw-session-cookie" },
      { userId: 42 },
      { companyName: "customer content" },
    ]) {
      expect(() =>
        paymentReceiptWriteRequestSchema.parse({
          schemaVersion: 1,
          receipt: { ...receipt, ...injected },
        }),
      ).toThrow();
    }
  });

  it("requires both digests on reads and validates stable responses", () => {
    expect(
      paymentReceiptReadRequestSchema.parse({
        orderId: receipt.orderId,
        scopeHash: receipt.scopeHash,
        authorizationDigest: receipt.authorizationDigest,
      }),
    ).toEqual({
      orderId: receipt.orderId,
      scopeHash: receipt.scopeHash,
      authorizationDigest: receipt.authorizationDigest,
    });
    expect(() =>
      paymentReceiptReadRequestSchema.parse({
        orderId: receipt.orderId,
        scopeHash: receipt.scopeHash,
      }),
    ).toThrow();
    expect(
      paymentReceiptResponseSchema.parse({
        schemaVersion: 1,
        receipt,
      }),
    ).toEqual({ schemaVersion: 1, receipt });
    expect(
      paymentReceiptReadyResponseSchema.parse({
        schemaVersion: 1,
        ready: true,
      }),
    ).toEqual({ schemaVersion: 1, ready: true });
  });
});
