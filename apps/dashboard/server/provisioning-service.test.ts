import { describe, expect, it } from "vitest";

import {
  hashProvisioningIdempotencyKey,
  provisionWebsiteUser,
  websiteProvisionRequestSchema,
  type CreateProvisionRecord,
  type StoredWebsiteProvision,
  type WebsiteProvisioningRepository,
  type WebsiteProvisionRequest,
} from "./provisioning-service";

const REQUEST_HASH_KEY = "n5x5mME6TnUoGiwX4zbaKg0P4NmbdM2uKwvDV8xGX3M";

function validRequest(): WebsiteProvisionRequest {
  return {
    schemaVersion: 1,
    project: {
      id: "project-acceptance-001",
      companyName: "验收企业",
    },
    order: {
      id: "order-zpay-000001",
      tradeNo: "zpay-trade-000001",
      status: "paid",
      amountFen: 150_000,
      paidAt: "2026-07-24T08:00:00.000Z",
      serviceCategory: "product_scenario",
      questionId: "question-acceptance-001",
      question: "验收企业有哪些核心服务？",
    },
    contract: {
      id: "contract-acceptance-000001",
      status: "signed",
      projectId: "project-acceptance-001",
      orderId: "order-zpay-000001",
      questionId: "question-acceptance-001",
      templateVersion: "geo-monthly-v1",
      documentSha256:
        "13d24e49d2d8fb42551cc71e449553c242add7a689f633062f838263672cb80d",
      signedAt: "2026-07-24T08:05:00.000Z",
      signatoryId: "customer-signatory-001",
    },
    account: {
      username: "Acceptance.Customer",
      password: "customer-selected-password",
      displayName: "验收企业",
    },
  };
}

class MemoryProvisioningRepository implements WebsiteProvisioningRepository {
  records = new Map<string, StoredWebsiteProvision>();
  createCount = 0;
  lastCreateInput: CreateProvisionRecord | null = null;

  async findByIdempotencyKeyHash(idempotencyKeyHash: string) {
    return this.records.get(idempotencyKeyHash) ?? null;
  }

  async createAtomically(input: CreateProvisionRecord) {
    this.createCount += 1;
    this.lastCreateInput = input;
    const stored: StoredWebsiteProvision = {
      idempotencyKeyHash: input.idempotencyKeyHash,
      requestHash: input.requestHash,
      provision: {
        id: input.id,
        projectId: input.request.project.id,
        orderId: input.request.order.id,
        contractId: input.request.contract.id,
        status: "completed",
        completedAt: input.now.toISOString(),
      },
      user: {
        id: 42,
        username: input.account.username,
        displayName: input.account.displayName,
        role: input.account.role,
        isActive: true,
      },
    };
    this.records.set(input.idempotencyKeyHash, stored);
    return stored;
  }
}

describe("website account provisioning", () => {
  it("rejects caller-controlled roles in the strict request contract", () => {
    const request = validRequest() as WebsiteProvisionRequest & {
      account: WebsiteProvisionRequest["account"] & { role: "admin" };
    };
    request.account.role = "admin";

    const parsed = websiteProvisionRequestSchema.safeParse(request);

    expect(parsed.success).toBe(false);
    if (!parsed.success) {
      expect(parsed.error.issues).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            code: "unrecognized_keys",
            path: ["account"],
          }),
        ]),
      );
    }
  });

  it("always creates a user role and never returns the password", async () => {
    const repository = new MemoryProvisioningRepository();
    const request = validRequest();
    const result = await provisionWebsiteUser(
      {
        idempotencyKey: "website-order-zpay-000001",
        request,
      },
      {
        repository,
        requestHashKey: REQUEST_HASH_KEY,
        now: () => new Date("2026-07-24T08:06:00.000Z"),
      },
    );

    expect(repository.lastCreateInput?.account.role).toBe("user");
    expect(result.user).toMatchObject({
      id: 42,
      username: "acceptance.customer",
      displayName: "验收企业",
      role: "user",
      isActive: true,
    });
    expect(JSON.stringify(result)).not.toContain(request.account.password);
    expect(result).not.toHaveProperty("password");
  });

  it("replays the same request without creating a second user", async () => {
    const repository = new MemoryProvisioningRepository();
    const input = {
      idempotencyKey: "website-order-zpay-000001",
      request: validRequest(),
    };
    const options = {
      repository,
      requestHashKey: REQUEST_HASH_KEY,
      now: () => new Date("2026-07-24T08:06:00.000Z"),
    };

    const first = await provisionWebsiteUser(input, options);
    const second = await provisionWebsiteUser(input, options);

    expect(first.replayed).toBe(false);
    expect(second.replayed).toBe(true);
    expect(second.user.id).toBe(first.user.id);
    expect(second.provision.id).toBe(first.provision.id);
    expect(repository.createCount).toBe(1);
    expect(
      repository.records.has(
        hashProvisioningIdempotencyKey(input.idempotencyKey),
      ),
    ).toBe(true);
  });

  it("rejects using the same idempotency key for a different body", async () => {
    const repository = new MemoryProvisioningRepository();
    const idempotencyKey = "website-order-zpay-000001";
    await provisionWebsiteUser(
      { idempotencyKey, request: validRequest() },
      { repository, requestHashKey: REQUEST_HASH_KEY },
    );
    const changed = validRequest();
    changed.account.password = "a-different-customer-password";

    await expect(
      provisionWebsiteUser(
        { idempotencyKey, request: changed },
        { repository, requestHashKey: REQUEST_HASH_KEY },
      ),
    ).rejects.toMatchObject({
      code: "IDEMPOTENCY_CONFLICT",
      status: 409,
    });
    expect(repository.createCount).toBe(1);
  });

  it("accepts the verified paid amount while requiring matching contract evidence", () => {
    const negotiatedAmount = validRequest();
    negotiatedAmount.order.amountFen = 200_000;
    const wrongContract = validRequest();
    wrongContract.contract.orderId = "a-different-order";

    expect(
      websiteProvisionRequestSchema.safeParse(negotiatedAmount).success,
    ).toBe(true);
    expect(websiteProvisionRequestSchema.safeParse(wrongContract).success).toBe(
      false,
    );
  });
});
