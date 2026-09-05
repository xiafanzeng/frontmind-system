import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import express from "express";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createProvisioningRouter } from "./provisioning-router";

const SERVICE_TOKEN = "manual-order-router-token-with-at-least-32-characters";
const servers: Server[] = [];

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

function createRequest() {
  return {
    schemaVersion: 1,
    project: {
      id: "project-manual-001",
      companyName: "示例科技有限公司",
    },
    service: {
      planCode: "basic",
      serviceDays: 30,
      purchasedQuestion: {
        id: "question-manual-001",
        category: "product_scenario",
        question: "如何选择适合当前生产场景的解决方案？",
      },
    },
    contract: {
      templateVersion: "basic-2026.07-v2",
      profile: {
        legalName: "示例科技有限公司",
        creditCode: "91310000MA1K12345X",
        address: "上海市浦东新区示例路 1 号",
        signatoryName: "张三",
        signatoryTitle: "法定代表人",
        mobile: "13800138000",
        email: "legal@example.com",
        authorized: true,
      },
    },
  };
}

function response(
  status:
    | "pending_admin"
    | "account_setup_required"
    | "activation_required"
    | "active",
) {
  return {
    schemaVersion: 1 as const,
    order: {
      reference: "manual-order-reference-001",
      projectId: "project-manual-001",
      status,
      amountFen: 150_000,
      message:
        status === "pending_admin"
          ? "签约资料已提交，等待管理员发起电子签署"
          : status === "account_setup_required"
            ? "付款已确认，请设置用于登录服务看板的账号和密码"
            : status === "activation_required"
              ? "账号资料已提交，正在自动开通服务"
              : "服务账号与普通版权益已开通",
      updatedAt: "2026-07-26T10:20:00.000Z",
      ...(status === "activation_required" || status === "active"
        ? { provisioningReference: "provision-manual-001" }
        : {}),
    },
  };
}

async function startApp(manualOrders: any) {
  const app = express();
  app.use(
    "/api/internal/provisioning",
    createProvisioningRouter({
      env: {
        FRONTMIND_PROVISIONING_SERVICE_TOKEN: SERVICE_TOKEN,
      },
      manualOrders,
    }),
  );
  const server = createServer(app);
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as AddressInfo;
  return `http://127.0.0.1:${address.port}/api/internal/provisioning`;
}

describe("manual service order internal routes", () => {
  it("creates and reads an opaque manual order through the service-token boundary", async () => {
    const manualOrders = {
      create: vi.fn().mockResolvedValue(response("pending_admin")),
      status: vi.fn().mockResolvedValue(response("pending_admin")),
      recordPayment: vi.fn(),
      setupAccount: vi.fn(),
    };
    const baseUrl = await startApp(manualOrders);
    const created = await fetch(`${baseUrl}/manual-orders`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "idempotency-key": "manual-create-idempotency-001",
        "x-frontmind-provisioning-token": SERVICE_TOKEN,
      },
      body: JSON.stringify(createRequest()),
    });
    expect(created.status).toBe(201);
    expect(await created.json()).toMatchObject({
      order: {
        reference: "manual-order-reference-001",
        status: "pending_admin",
      },
    });
    expect(manualOrders.create).toHaveBeenCalledWith({
      idempotencyKey: "manual-create-idempotency-001",
      request: createRequest(),
      secret: SERVICE_TOKEN,
    });

    const status = await fetch(
      `${baseUrl}/manual-orders/manual-order-reference-001/status`,
      {
        headers: {
          "x-frontmind-provisioning-token": SERVICE_TOKEN,
        },
      },
    );
    expect(status.status).toBe(200);
    expect(manualOrders.status).toHaveBeenCalledWith({
      reference: "manual-order-reference-001",
      secret: SERVICE_TOKEN,
    });
  });

  it("accepts only a bounded verified-payment shape and returns 202", async () => {
    const paid = response("account_setup_required");
    const manualOrders = {
      create: vi.fn(),
      status: vi.fn(),
      recordPayment: vi.fn().mockResolvedValue(paid),
      setupAccount: vi.fn(),
    };
    const baseUrl = await startApp(manualOrders);
    const request = {
      schemaVersion: 1,
      payment: {
        orderId: "20260726100000123456",
        tradeNo: "zpay-trade-manual-001",
        amountFen: 150_000,
        paidAt: "2026-07-26T10:10:00.000Z",
      },
    };
    const result = await fetch(
      `${baseUrl}/manual-orders/manual-order-reference-001/payment`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "idempotency-key": "manual-payment-idempotency-001",
          "x-frontmind-provisioning-token": SERVICE_TOKEN,
        },
        body: JSON.stringify(request),
      },
    );
    expect(result.status).toBe(202);
    expect(manualOrders.recordPayment).toHaveBeenCalledWith({
      reference: "manual-order-reference-001",
      idempotencyKey: "manual-payment-idempotency-001",
      request,
      secret: SERVICE_TOKEN,
    });
  });

  it("confirms an external WeChat contract through the service-token boundary", async () => {
    const authorized = {
      ...response("payment_required"),
      order: {
        ...response("payment_required").order,
        contractAuthorizationMode: "external_wechat" as const,
        contractAuthorizedAt: "2026-07-26T10:05:00.000Z",
      },
    };
    const manualOrders = {
      create: vi.fn(),
      status: vi.fn(),
      authorizeExternal: vi.fn().mockResolvedValue(authorized),
      recordPayment: vi.fn(),
      setupAccount: vi.fn(),
    };
    const baseUrl = await startApp(manualOrders);
    const request = {
      schemaVersion: 1,
      authorization: {
        mode: "external_wechat",
        eventReference: "wechat-contract-event-001",
        authorizedAt: "2026-07-26T10:05:00.000Z",
      },
    };
    const result = await fetch(
      `${baseUrl}/manual-orders/manual-order-reference-001/external-contract`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-frontmind-provisioning-token": SERVICE_TOKEN,
        },
        body: JSON.stringify(request),
      },
    );
    expect(result.status).toBe(200);
    expect(manualOrders.authorizeExternal).toHaveBeenCalledWith({
      reference: "manual-order-reference-001",
      request,
      secret: SERVICE_TOKEN,
    });
    expect(await result.json()).toMatchObject({
      order: {
        status: "payment_required",
        contractAuthorizationMode: "external_wechat",
      },
    });
  });

  it("accepts customer credentials only after payment on the dedicated account route", async () => {
    const ready = response("active");
    const manualOrders = {
      create: vi.fn(),
      status: vi.fn(),
      recordPayment: vi.fn(),
      setupAccount: vi.fn().mockResolvedValue(ready),
    };
    const baseUrl = await startApp(manualOrders);
    const request = {
      schemaVersion: 1,
      account: {
        mode: "create",
        username: "example.manual",
        displayName: "示例科技有限公司",
        password: "customer-selected-password",
      },
    };
    const result = await fetch(
      `${baseUrl}/manual-orders/manual-order-reference-001/account`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "idempotency-key": "manual-account-idempotency-001",
          "x-frontmind-provisioning-token": SERVICE_TOKEN,
        },
        body: JSON.stringify(request),
      },
    );
    expect(result.status).toBe(200);
    expect(manualOrders.setupAccount).toHaveBeenCalledWith({
      reference: "manual-order-reference-001",
      idempotencyKey: "manual-account-idempotency-001",
      request,
      secret: SERVICE_TOKEN,
    });
    expect(JSON.stringify(await result.json())).not.toContain(
      request.account.password,
    );
  });

  it("blocks the old payment-plus-account bypass and weak account passwords", async () => {
    const manualOrders = {
      create: vi.fn(),
      status: vi.fn(),
      recordPayment: vi.fn(),
      setupAccount: vi.fn(),
    };
    const baseUrl = await startApp(manualOrders);
    const paymentResult = await fetch(
      `${baseUrl}/manual-orders/manual-order-reference-001/payment`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "idempotency-key": "manual-payment-idempotency-001",
          "x-frontmind-provisioning-token": SERVICE_TOKEN,
        },
        body: JSON.stringify({
          schemaVersion: 1,
          payment: {
            orderId: "20260726100000123456",
            tradeNo: "zpay-trade-manual-001",
            amountFen: 150_000,
            paidAt: "2026-07-26T10:10:00.000Z",
          },
          account: {
            mode: "create",
            username: "old.bypass",
            displayName: "示例科技有限公司",
          },
        }),
      },
    );
    expect(paymentResult.status).toBe(400);
    expect(manualOrders.recordPayment).not.toHaveBeenCalled();

    const accountResult = await fetch(
      `${baseUrl}/manual-orders/manual-order-reference-001/account`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "idempotency-key": "manual-account-idempotency-001",
          "x-frontmind-provisioning-token": SERVICE_TOKEN,
        },
        body: JSON.stringify({
          schemaVersion: 1,
          account: {
            mode: "create",
            username: "weak.password",
            displayName: "示例科技有限公司",
            password: "1234567",
          },
        }),
      },
    );
    expect(accountResult.status).toBe(400);
    expect(manualOrders.setupAccount).not.toHaveBeenCalled();
  });

  it("rejects callers without the dedicated provisioning token before dispatch", async () => {
    const manualOrders = {
      create: vi.fn(),
      status: vi.fn(),
      recordPayment: vi.fn(),
      setupAccount: vi.fn(),
    };
    const baseUrl = await startApp(manualOrders);
    const result = await fetch(`${baseUrl}/manual-orders`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "idempotency-key": "manual-create-idempotency-001",
      },
      body: JSON.stringify(createRequest()),
    });
    expect(result.status).toBe(401);
    expect(manualOrders.create).not.toHaveBeenCalled();
  });
});
