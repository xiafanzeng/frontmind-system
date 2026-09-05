import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import express from "express";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createProvisioningRouter } from "./provisioning-router";

const SERVICE_TOKEN = "Z2B2cHVyY2hhc2VzY3Jvc3NyZXBvc2l0b3J5dGVzdA";
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

function purchaseRequest() {
  return {
    schemaVersion: 2 as const,
    project: { id: "project-basic-001", companyName: "示例企业" },
    order: {
      id: "order-basic-001",
      tradeNo: "trade-basic-001",
      status: "paid" as const,
      amountFen: 150000,
      paidAt: "2026-07-26T00:00:00.000Z",
    },
    service: {
      planCode: "basic" as const,
      serviceDays: 30 as const,
      startsAt: "2026-07-26T00:00:00.000Z",
      endsAt: "2026-08-25T00:00:00.000Z",
      purchasedQuestion: {
        id: "question-basic-001",
        category: "product_scenario" as const,
        question: "如何选择适合当前生产场景的解决方案？",
      },
    },
    contract: {
      id: "contract-basic-001",
      status: "pending_admin_confirmation" as const,
      projectId: "project-basic-001",
      orderId: "order-basic-001",
      questionId: "question-basic-001",
      templateVersion: "basic-2026.07-v1",
      evidence: {
        type: "system_admin_confirmation" as const,
        artifact: {
          taskId: null,
          fileId: null,
          outputDescriptor: null,
          sha256: null,
        },
      },
    },
    account: {
      mode: "create" as const,
      username: "example.customer",
      displayName: "示例企业",
    },
  };
}

async function startApp(input: {
  submitPurchase: any;
  readPurchase: any;
}) {
  const app = express();
  app.use(
    "/api/internal/provisioning",
    createProvisioningRouter({
      env: {
        FRONTMIND_PROVISIONING_SERVICE_TOKEN: SERVICE_TOKEN,
      },
      submitPurchase: input.submitPurchase,
      readPurchase: input.readPurchase,
    }),
  );
  const server = createServer(app);
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as AddressInfo;
  return `http://127.0.0.1:${address.port}/api/internal/provisioning`;
}

describe("provisioning v2 purchase routes", () => {
  it("submits a password-free purchase and returns pending confirmation", async () => {
    const result = {
      schemaVersion: 2 as const,
      purchase: {
        reference: "purchase-reference-1",
        projectId: "project-basic-001",
        orderId: "order-basic-001",
        status: "pending_confirmation" as const,
        updatedAt: "2026-07-26T00:01:00.000Z",
      },
      account: {
        username: "example.customer",
        displayName: "示例企业",
      },
    };
    const submitPurchase = vi.fn().mockResolvedValue(result);
    const baseUrl = await startApp({
      submitPurchase,
      readPurchase: vi.fn(),
    });
    const response = await fetch(`${baseUrl}/purchases`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "idempotency-key": "geo-basic-order-basic-001",
        "x-frontmind-provisioning-token": SERVICE_TOKEN,
      },
      body: JSON.stringify(purchaseRequest()),
    });
    expect(response.status).toBe(202);
    expect(submitPurchase).toHaveBeenCalledWith({
      idempotencyKey: "geo-basic-order-basic-001",
      request: purchaseRequest(),
      secret: SERVICE_TOKEN,
    });
    expect(JSON.stringify(await response.json())).not.toContain("password");
  });

  it("reads the opaque purchase reference without exposing userId", async () => {
    const result = {
      schemaVersion: 2 as const,
      purchase: {
        reference: "purchase-reference-1",
        projectId: "project-basic-001",
        orderId: "order-basic-001",
        status: "provisioned" as const,
        updatedAt: "2026-07-26T00:02:00.000Z",
      },
      account: {
        username: "example.customer",
        accountSetupUrl:
          "https://agent.example/setup-password?token=opaque-token",
        workspaceUrl: "https://agent.example/",
      },
    };
    const readPurchase = vi.fn().mockResolvedValue(result);
    const baseUrl = await startApp({
      submitPurchase: vi.fn(),
      readPurchase,
    });
    const response = await fetch(
      `${baseUrl}/purchases/purchase-reference-1/status`,
      {
        headers: {
          "x-frontmind-provisioning-token": SERVICE_TOKEN,
        },
      },
    );
    expect(response.status).toBe(200);
    expect(readPurchase).toHaveBeenCalledWith({
      reference: "purchase-reference-1",
      secret: SERVICE_TOKEN,
    });
    expect(JSON.stringify(await response.json())).not.toContain("userId");
  });
});
