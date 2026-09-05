import { createHmac } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";

const databaseState = vi.hoisted(() => ({ value: undefined as any }));

vi.mock("./db", () => ({
  getDb: async () => databaseState.value,
}));

import {
  decideWebsitePurchase,
  listPendingWebsitePurchases,
  submitWebsitePurchase,
} from "./provisioning-v2-service";

const SECRET = "manual-ownership-test-secret-with-at-least-32-characters";

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value) ?? "null";
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(",")}]`;
  }
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .filter((key) => record[key] !== undefined)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
    .join(",")}}`;
}

function selectRowsDatabase(rows: any[]) {
  const query: any = {
    from: () => query,
    where: () => query,
    orderBy: async () => rows,
  };
  return { select: () => query };
}

function decisionDatabase(row: any) {
  const query: any = {
    from: () => query,
    where: () => query,
    limit: () => query,
    for: async () => [row],
  };
  const tx = { select: () => query };
  return {
    transaction: async (operation: (value: typeof tx) => unknown) =>
      operation(tx),
  };
}

function purchaseRequest() {
  return {
    schemaVersion: 2 as const,
    project: {
      id: "project-manual-001",
      companyName: "示例科技有限公司",
    },
    order: {
      id: "20260726100000123456",
      tradeNo: "zpay-trade-manual-001",
      status: "paid" as const,
      amountFen: 150_000,
      paidAt: "2026-07-26T10:10:00.000Z",
    },
    service: {
      planCode: "basic" as const,
      serviceDays: 30 as const,
      startsAt: "2026-07-26T10:10:00.000Z",
      endsAt: "2026-08-25T10:10:00.000Z",
      purchasedQuestion: {
        id: "question-manual-001",
        category: "product_scenario" as const,
        question: "如何选择适合当前生产场景的解决方案？",
      },
    },
    contract: {
      id: "contract-manual-001",
      status: "pending_admin_confirmation" as const,
      projectId: "project-manual-001",
      orderId: "20260726100000123456",
      questionId: "question-manual-001",
      templateVersion: "basic-2026.07-v2",
      evidence: {
        type: "system_admin_confirmation" as const,
        artifact: {
          taskId: null,
          fileId: "signed-pdf-file-001",
          outputDescriptor: "signed-contract.pdf",
          sha256: "a".repeat(64),
        },
      },
    },
    account: {
      mode: "create" as const,
      username: "example.manual",
      displayName: "示例科技有限公司",
    },
  };
}

beforeEach(() => {
  databaseState.value = undefined;
});

describe("manual purchase ledger ownership", () => {
  it("keeps manual-order ledgers out of the legacy pending-purchase queue", async () => {
    const manualRow = {
      contractEvidence: {
        type: "system_admin_confirmation",
        manualOrderReference: "manual-order-reference-001",
        artifact: { sha256: "a".repeat(64) },
      },
    };
    databaseState.value = selectRowsDatabase([manualRow]);

    await expect(listPendingWebsitePurchases()).resolves.toEqual([]);
  });

  it("keeps ordinary purchase ledgers visible in the legacy queue", async () => {
    const paidAt = new Date("2026-07-26T10:10:00.000Z");
    const createdAt = new Date("2026-07-26T10:11:00.000Z");
    databaseState.value = selectRowsDatabase([
      {
        id: "provision-standard-001",
        projectId: "project-standard-001",
        companyName: "示例科技有限公司",
        orderId: "20260726100000123456",
        amountFen: 150_000,
        questionId: "question-standard-001",
        question: "如何选择适合当前生产场景的解决方案？",
        serviceCategory: "product_scenario",
        requestedUsername: "example.standard",
        requestedDisplayName: "示例科技有限公司",
        accountMode: "create",
        contractId: "contract-standard-001",
        contractTemplateVersion: "basic-2026.07-v2",
        contractEvidence: { type: "system_admin_confirmation" },
        paidAt,
        createdAt,
      },
    ]);

    await expect(listPendingWebsitePurchases()).resolves.toEqual([
      expect.objectContaining({
        reference: "provision-standard-001",
        contractId: "contract-standard-001",
        paidAt: paidAt.getTime(),
        createdAt: createdAt.getTime(),
      }),
    ]);
  });

  it("blocks a legacy decision when the ledger belongs to a manual order", async () => {
    databaseState.value = decisionDatabase({
      id: "provision-manual-001",
      schemaVersion: 2,
      contractEvidence: {
        type: "system_admin_confirmation",
        manualOrderReference: "manual-order-reference-001",
      },
    });

    await expect(
      decideWebsitePurchase({
        reference: "provision-manual-001",
        actorUserId: 1,
        decision: "confirm",
        secret: SECRET,
      }),
    ).rejects.toMatchObject({
      code: "PURCHASE_MANUAL_WORKFLOW_REQUIRED",
      status: 409,
    });
    await expect(
      decideWebsitePurchase({
        reference: "provision-manual-001",
        manualOrderReference: "manual-order-reference-002",
        actorUserId: 1,
        decision: "reject",
        secret: SECRET,
      }),
    ).rejects.toMatchObject({
      code: "PURCHASE_MANUAL_WORKFLOW_REQUIRED",
      status: 409,
    });
  });

  it("requires the owning manual workflow to provide its pre-hashed customer password", async () => {
    databaseState.value = decisionDatabase({
      id: "provision-manual-001",
      schemaVersion: 2,
      status: "pending_confirmation",
      accountMode: "create",
      contractEvidence: {
        type: "system_admin_confirmation",
        manualOrderReference: "manual-order-reference-001",
        artifact: { sha256: "a".repeat(64) },
      },
    });

    await expect(
      decideWebsitePurchase({
        reference: "provision-manual-001",
        manualOrderReference: "manual-order-reference-001",
        actorUserId: 1,
        decision: "confirm",
        signedAt: new Date("2026-07-26T10:05:00.000Z"),
        signatoryId: "enterprise-signatory-001",
        secret: SECRET,
      }),
    ).rejects.toMatchObject({
      code: "PURCHASE_MANUAL_WORKFLOW_REQUIRED",
      status: 409,
    });

    await expect(
      decideWebsitePurchase({
        reference: "provision-manual-001",
        manualOrderReference: "manual-order-reference-001",
        actorUserId: 1,
        decision: "confirm",
        manualPasswordHash: "plaintext-must-never-be-accepted",
        signedAt: new Date("2026-07-26T10:05:00.000Z"),
        signatoryId: "enterprise-signatory-001",
        secret: SECRET,
      }),
    ).rejects.toMatchObject({
      code: "PURCHASE_MANUAL_WORKFLOW_REQUIRED",
      status: 409,
    });
  });

  it.each([
    [
      "与合同授权同时付款",
      "2026-07-26T10:10:00.000Z",
      "2026-07-26T10:10:00.000Z",
    ],
    ["先付款后授权", "2026-07-26T10:09:59.999Z", "2026-07-26T10:10:00.000Z"],
  ])("拒绝企业微信合同的无效付款顺序：%s", async (_, paidAt, authorizedAt) => {
    databaseState.value = decisionDatabase({
      id: "provision-external-001",
      schemaVersion: 2,
      status: "pending_confirmation",
      paidAt: new Date(paidAt),
      contractEvidence: {
        type: "external_wechat_confirmation",
        manualOrderReference: "manual-order-reference-001",
        eventReference: "wechat-contract-event-001",
        authorizedAt,
      },
    });

    await expect(
      decideWebsitePurchase({
        reference: "provision-external-001",
        manualOrderReference: "manual-order-reference-001",
        decision: "confirm",
        secret: SECRET,
        now: new Date("2026-07-26T10:20:00.000Z"),
      }),
    ).rejects.toMatchObject({
      code: "PURCHASE_ALREADY_DECIDED",
      status: 400,
      message: "企业微信合同确认记录无效",
    });
  });

  it("does not let a manual submission adopt an unowned idempotent ledger", async () => {
    const request = purchaseRequest();
    databaseState.value = decisionDatabase({
      schemaVersion: 2,
      requestHash: createHmac("sha256", SECRET)
        .update(canonicalJson(request), "utf8")
        .digest("hex"),
      contractEvidence: { type: "system_admin_confirmation" },
    });

    await expect(
      submitWebsitePurchase({
        idempotencyKey: "manual-payment-idempotency-001",
        manualOrderReference: "manual-order-reference-001",
        request,
        secret: SECRET,
      }),
    ).rejects.toMatchObject({
      code: "IDEMPOTENCY_CONFLICT",
      status: 409,
    });
  });
});
