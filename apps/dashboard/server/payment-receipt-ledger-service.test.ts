import { describe, expect, it } from "vitest";

import type {
  InsertWebsitePaymentReceipt,
  WebsitePaymentReceipt,
} from "../drizzle/schema";
import type {
  PaymentReceipt,
  PaymentReceiptWriteRequest,
} from "../shared/payment-receipt";
import {
  createPaymentReceiptLedgerService,
  PaymentReceiptLedgerError,
  type PaymentReceiptRepository,
} from "./payment-receipt-ledger-service";

const NOW = new Date("2026-07-28T10:00:00.000Z");

function receipt(): PaymentReceipt {
  return {
    orderId: "order-20260728-0001",
    tradeNo: "zpay-trade-20260728-0001",
    amountFen: 150_000,
    paidAt: "2026-07-28T08:30:00.123Z",
    purchaseType: "service",
    scopeHash: "a".repeat(64),
    authorizationDigest: "b".repeat(64),
    reviewRequired: false,
  };
}

function request(value = receipt()): PaymentReceiptWriteRequest {
  return { schemaVersion: 1, receipt: value };
}

function row(value: InsertWebsitePaymentReceipt): WebsitePaymentReceipt {
  return {
    orderId: value.orderId,
    schemaVersion: value.schemaVersion ?? 1,
    tradeNo: value.tradeNo,
    amountFen: value.amountFen,
    paidAt: value.paidAt,
    purchaseType: value.purchaseType,
    scopeHash: value.scopeHash,
    authorizationDigest: value.authorizationDigest,
    reviewRequired: value.reviewRequired,
    createdAt: value.createdAt ?? NOW,
  };
}

function memoryRepository(): PaymentReceiptRepository & {
  rows: Map<string, WebsitePaymentReceipt>;
} {
  const rows = new Map<string, WebsitePaymentReceipt>();
  return {
    rows,
    async findByOrderId(orderId) {
      return rows.get(orderId);
    },
    async findByTradeNo(tradeNo) {
      return [...rows.values()].find((entry) => entry.tradeNo === tradeNo);
    },
    async findScoped(input) {
      const entry = rows.get(input.orderId);
      return entry?.scopeHash === input.scopeHash &&
        entry.authorizationDigest === input.authorizationDigest
        ? entry
        : undefined;
    },
    async insert(value) {
      if (
        rows.has(value.orderId) ||
        [...rows.values()].some((entry) => entry.tradeNo === value.tradeNo)
      ) {
        throw Object.assign(new Error("duplicate"), { code: "ER_DUP_ENTRY" });
      }
      const stored = row(value);
      rows.set(stored.orderId, stored);
      return stored;
    },
    async ready() {},
  };
}

function harness(repository = memoryRepository()) {
  return {
    repository,
    service: createPaymentReceiptLedgerService({
      repository,
      now: () => new Date(NOW),
    }),
  };
}

describe("immutable payment receipt ledger", () => {
  it("creates once and returns an exact replay without rewriting", async () => {
    const { repository, service } = harness();
    const first = await service.record(request());
    expect(first.replayed).toBe(false);
    expect(first.response).toEqual({ schemaVersion: 1, receipt: receipt() });
    const createdAt = repository.rows.get(receipt().orderId)?.createdAt;

    const replay = await service.record(request());
    expect(replay.replayed).toBe(true);
    expect(replay.response).toEqual(first.response);
    expect(repository.rows.size).toBe(1);
    expect(repository.rows.get(receipt().orderId)?.createdAt).toEqual(
      createdAt,
    );
  });

  it("returns 409 when any immutable field changes for an order", async () => {
    const { service } = harness();
    await service.record(request());
    const changes: Array<Partial<PaymentReceipt>> = [
      { tradeNo: "zpay-trade-20260728-0002" },
      { amountFen: 150_001 },
      { paidAt: "2026-07-28T08:30:00.124Z" },
      { purchaseType: "monitoring" },
      { scopeHash: "c".repeat(64) },
      { authorizationDigest: "d".repeat(64) },
      { reviewRequired: true },
    ];
    for (const change of changes) {
      await expect(
        service.record(request({ ...receipt(), ...change })),
      ).rejects.toMatchObject<Partial<PaymentReceiptLedgerError>>({
        code: "PAYMENT_RECEIPT_CONFLICT",
        status: 409,
      });
    }
  });

  it("keeps a present trade number globally unique", async () => {
    const { service } = harness();
    await service.record(request());
    await expect(
      service.record(
        request({
          ...receipt(),
          orderId: "order-20260728-0002",
          scopeHash: "c".repeat(64),
        }),
      ),
    ).rejects.toMatchObject({
      code: "PAYMENT_RECEIPT_CONFLICT",
      status: 409,
    });
  });

  it("recovers an identical concurrent insert as an idempotent replay", async () => {
    const repository = memoryRepository();
    const originalInsert = repository.insert.bind(repository);
    repository.insert = async (value) => {
      await originalInsert(value);
      throw Object.assign(new Error("racing duplicate"), {
        code: "ER_DUP_ENTRY",
      });
    };
    const service = createPaymentReceiptLedgerService({
      repository,
      now: () => new Date(NOW),
    });

    await expect(service.record(request())).resolves.toMatchObject({
      replayed: true,
      response: { receipt: { orderId: receipt().orderId } },
    });
  });

  it("requires exact order, scope, and authorization digests for reads", async () => {
    const { service } = harness();
    await service.record(request());
    const binding = {
      orderId: receipt().orderId,
      scopeHash: receipt().scopeHash,
      authorizationDigest: receipt().authorizationDigest,
    };
    await expect(service.read(binding)).resolves.toEqual({
      schemaVersion: 1,
      receipt: receipt(),
    });
    for (const change of [
      { orderId: "order-20260728-9999" },
      { scopeHash: "c".repeat(64) },
      { authorizationDigest: "d".repeat(64) },
    ]) {
      await expect(
        service.read({ ...binding, ...change }),
      ).rejects.toMatchObject({
        code: "PAYMENT_RECEIPT_NOT_FOUND",
        status: 404,
      });
    }
  });

  it("rejects impossible payment times and fails readiness closed", async () => {
    const { service } = harness();
    await expect(
      service.record(
        request({ ...receipt(), paidAt: "2019-12-31T23:59:59.999Z" }),
      ),
    ).rejects.toMatchObject({
      code: "PAYMENT_RECEIPT_TIMESTAMP_INVALID",
      status: 400,
    });
    await expect(
      service.record(
        request({ ...receipt(), paidAt: "2026-07-28T10:05:00.001Z" }),
      ),
    ).rejects.toMatchObject({
      code: "PAYMENT_RECEIPT_TIMESTAMP_INVALID",
      status: 400,
    });

    const repository = memoryRepository();
    repository.ready = async () => {
      throw new Error("table missing");
    };
    const unavailable = createPaymentReceiptLedgerService({ repository });
    await expect(unavailable.ready()).rejects.toMatchObject({
      code: "PAYMENT_RECEIPT_DATABASE_UNAVAILABLE",
      status: 503,
    });
  });
});
