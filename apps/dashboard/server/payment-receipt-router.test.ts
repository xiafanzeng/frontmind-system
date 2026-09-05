import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import express from "express";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createProvisioningRouter } from "./provisioning-router";
import { PaymentReceiptLedgerError } from "./payment-receipt-ledger-service";

const SERVICE_TOKEN = "payment-receipt-router-token-at-least-32-characters";
const servers: Server[] = [];

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

afterEach(async () => {
  await Promise.all(
    servers
      .splice(0)
      .map(
        (server) =>
          new Promise<void>((resolve, reject) =>
            server.close((error) => (error ? reject(error) : resolve())),
          ),
      ),
  );
});

async function startApp(paymentReceipts: any) {
  const app = express();
  app.use(
    "/api/internal/provisioning",
    createProvisioningRouter({
      env: {
        FRONTMIND_PROVISIONING_SERVICE_TOKEN: SERVICE_TOKEN,
      },
      paymentReceipts,
    }),
  );
  const server = createServer(app);
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as AddressInfo;
  return `http://127.0.0.1:${address.port}/api/internal/provisioning/payment-receipts`;
}

function service(overrides: Record<string, unknown> = {}) {
  return {
    record: vi.fn(),
    read: vi.fn(),
    ready: vi.fn().mockResolvedValue({ schemaVersion: 1, ready: true }),
    ...overrides,
  };
}

describe("payment receipt internal routes", () => {
  it("authenticates before parsing or touching the ledger", async () => {
    const paymentReceipts = service();
    const url = await startApp(paymentReceipts);
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-frontmind-provisioning-token": "wrong-token",
      },
      body: "{",
    });
    expect(response.status).toBe(401);
    expect(paymentReceipts.record).not.toHaveBeenCalled();
    expect(paymentReceipts.read).not.toHaveBeenCalled();
    expect(paymentReceipts.ready).not.toHaveBeenCalled();
  });

  it("creates and exactly replays immutable receipts", async () => {
    const responseBody = { schemaVersion: 1 as const, receipt };
    const paymentReceipts = service({
      record: vi
        .fn()
        .mockResolvedValueOnce({ response: responseBody, replayed: false })
        .mockResolvedValueOnce({ response: responseBody, replayed: true }),
    });
    const url = await startApp(paymentReceipts);
    const init = {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-frontmind-provisioning-token": SERVICE_TOKEN,
      },
      body: JSON.stringify({ schemaVersion: 1, receipt }),
    };

    const created = await fetch(url, init);
    expect(created.status).toBe(201);
    expect(created.headers.get("idempotent-replayed")).toBeNull();
    expect(await created.json()).toEqual(responseBody);

    const replay = await fetch(url, init);
    expect(replay.status).toBe(200);
    expect(replay.headers.get("idempotent-replayed")).toBe("true");
    expect(paymentReceipts.record).toHaveBeenNthCalledWith(1, {
      schemaVersion: 1,
      receipt,
    });
  });

  it("returns 409 for an immutable-field or uniqueness conflict", async () => {
    const paymentReceipts = service({
      record: vi
        .fn()
        .mockRejectedValue(
          new PaymentReceiptLedgerError(
            "PAYMENT_RECEIPT_CONFLICT",
            "The order or trade number is already bound to a different payment receipt",
            409,
          ),
        ),
    });
    const url = await startApp(paymentReceipts);
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-frontmind-provisioning-token": SERVICE_TOKEN,
      },
      body: JSON.stringify({ schemaVersion: 1, receipt }),
    });
    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: "PAYMENT_RECEIPT_CONFLICT" },
    });
  });

  it("reads only an order bound to both exact digests", async () => {
    const responseBody = { schemaVersion: 1 as const, receipt };
    const paymentReceipts = service({
      read: vi.fn().mockResolvedValue(responseBody),
    });
    const url = await startApp(paymentReceipts);
    const query = new URLSearchParams({
      scopeHash: receipt.scopeHash,
      authorizationDigest: receipt.authorizationDigest,
    });
    const response = await fetch(`${url}/${receipt.orderId}?${query}`, {
      headers: { "x-frontmind-provisioning-token": SERVICE_TOKEN },
    });
    expect(response.status).toBe(200);
    expect(paymentReceipts.read).toHaveBeenCalledWith({
      orderId: receipt.orderId,
      scopeHash: receipt.scopeHash,
      authorizationDigest: receipt.authorizationDigest,
    });

    const incomplete = await fetch(
      `${url}/${receipt.orderId}?scopeHash=${receipt.scopeHash}`,
      {
        headers: { "x-frontmind-provisioning-token": SERVICE_TOKEN },
      },
    );
    expect(incomplete.status).toBe(400);
    const extra = await fetch(
      `${url}/${receipt.orderId}?${query}&unexpected=true`,
      {
        headers: { "x-frontmind-provisioning-token": SERVICE_TOKEN },
      },
    );
    expect(extra.status).toBe(400);
    expect(paymentReceipts.read).toHaveBeenCalledTimes(1);
  });

  it("uses one indistinguishable 404 for missing or mismatched bindings", async () => {
    const paymentReceipts = service({
      read: vi
        .fn()
        .mockRejectedValue(
          new PaymentReceiptLedgerError(
            "PAYMENT_RECEIPT_NOT_FOUND",
            "Payment receipt not found",
            404,
          ),
        ),
    });
    const url = await startApp(paymentReceipts);
    const response = await fetch(
      `${url}/${receipt.orderId}?${new URLSearchParams({
        scopeHash: receipt.scopeHash,
        authorizationDigest: "c".repeat(64),
      })}`,
      {
        headers: { "x-frontmind-provisioning-token": SERVICE_TOKEN },
      },
    );
    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toEqual({
      error: {
        code: "PAYMENT_RECEIPT_NOT_FOUND",
        message: "Payment receipt not found",
      },
    });
  });

  it("exposes an authenticated table-readiness gate and fails closed", async () => {
    const paymentReceipts = service();
    const url = await startApp(paymentReceipts);
    const ready = await fetch(`${url}/ready`, {
      headers: { "x-frontmind-provisioning-token": SERVICE_TOKEN },
    });
    expect(ready.status).toBe(200);
    await expect(ready.json()).resolves.toEqual({
      schemaVersion: 1,
      ready: true,
    });

    paymentReceipts.ready.mockRejectedValueOnce(
      new PaymentReceiptLedgerError(
        "PAYMENT_RECEIPT_DATABASE_UNAVAILABLE",
        "The payment receipt ledger is unavailable",
        503,
      ),
    );
    const unavailable = await fetch(`${url}/ready`, {
      headers: { "x-frontmind-provisioning-token": SERVICE_TOKEN },
    });
    expect(unavailable.status).toBe(503);
    await expect(unavailable.json()).resolves.toMatchObject({
      error: { code: "PAYMENT_RECEIPT_DATABASE_UNAVAILABLE" },
    });
  });
});
