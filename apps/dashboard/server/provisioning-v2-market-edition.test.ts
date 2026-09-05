import { beforeEach, describe, expect, it, vi } from "vitest";

const databaseState = vi.hoisted(() => ({ value: undefined as any }));
const authMocks = vi.hoisted(() => ({
  createManagedUser: vi.fn(),
  createManagedUserWithPasswordHash: vi.fn(),
}));
const entitlementMocks = vi.hoisted(() => ({
  provisionBasicEntitlement: vi.fn(),
}));

vi.mock("./db", () => ({
  getDb: async () => databaseState.value,
}));

vi.mock("./auth-service", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./auth-service")>();
  return {
    ...actual,
    createManagedUser: authMocks.createManagedUser,
    createManagedUserWithPasswordHash:
      authMocks.createManagedUserWithPasswordHash,
  };
});

vi.mock("./basic-entitlement-service", () => ({
  provisionBasicEntitlement: entitlementMocks.provisionBasicEntitlement,
}));

import {
  purchaseIntents,
  userDashboardContents,
  users,
  websiteProjectDeletionTombstones,
  websiteUserProvisions,
} from "../drizzle/schema";
import {
  decideWebsitePurchase,
  submitWebsitePurchase,
} from "./provisioning-v2-service";

const SECRET = "market-edition-test-secret-with-at-least-32-characters";
const NOW = new Date("2026-08-07T08:00:00.000Z");
const PASSWORD_HASH = [
  "scrypt",
  "v1",
  "16384",
  "8",
  "1",
  Buffer.alloc(16, 1).toString("base64"),
  Buffer.alloc(64, 2).toString("base64"),
].join("$");

function rowsResult(rows: any[]) {
  const result = Promise.resolve(rows) as Promise<any[]> & {
    for: () => Promise<any[]>;
  };
  result.for = async () => rows;
  return result;
}

function purchaseRequest(input?: {
  marketEdition?: "domestic" | "overseas";
  bindExisting?: boolean;
}) {
  return {
    schemaVersion: 2 as const,
    ...(input?.marketEdition ? { marketEdition: input.marketEdition } : {}),
    project: {
      id: "project-edition-001",
      companyName: "版本测试企业",
    },
    order: {
      id: "order-edition-001",
      tradeNo: "trade-edition-001",
      status: "paid" as const,
      amountFen: 450_000,
      paidAt: "2026-08-07T07:00:00.000Z",
    },
    service: {
      planCode: "basic" as const,
      serviceDays: 30 as const,
      startsAt: "2026-08-07T07:00:00.000Z",
      endsAt: "2026-09-06T07:00:00.000Z",
      purchasedQuestion: {
        id: "question-edition-001",
        category: "product_scenario" as const,
        question: "版本测试企业如何支持当前产品场景？",
      },
    },
    contract: {
      id: "contract-edition-001",
      status: "pending_admin_confirmation" as const,
      projectId: "project-edition-001",
      orderId: "order-edition-001",
      questionId: "question-edition-001",
      templateVersion: "geo-basic-v2",
      evidence: {
        type: "system_admin_confirmation" as const,
        artifact: {
          taskId: null,
          fileId: "signed-contract-edition-001",
          outputDescriptor: "signed-contract.pdf",
          sha256: "a".repeat(64),
        },
      },
    },
    account: input?.bindExisting
      ? {
          mode: "bind_existing" as const,
          purchaseIntent: "opaque-purchase-intent-for-edition-test",
        }
      : {
          mode: "create" as const,
          username: "edition.customer",
          displayName: "版本测试企业",
        },
  };
}

class SubmissionDatabase {
  provision: Record<string, any> | undefined;

  constructor(
    private readonly account?: {
      id: number;
      username: string;
      displayName: string;
      marketEdition: "domestic" | "overseas";
    },
  ) {}

  select() {
    return {
      from: (table: unknown) => ({
        where: () => ({
          limit: () => {
            if (table === websiteProjectDeletionTombstones) {
              return rowsResult([{ status: "active" }]);
            }
            if (table === websiteUserProvisions) {
              return rowsResult(this.provision ? [this.provision] : []);
            }
            if (table === purchaseIntents) {
              return rowsResult(
                this.account
                  ? [
                      {
                        id: "purchase-intent-edition-001",
                        userId: this.account.id,
                        targetPlanCode: "basic",
                        externalOrderId: null,
                        status: "pending",
                        expiresAt: new Date("2026-08-08T08:00:00.000Z"),
                        revision: 1,
                      },
                    ]
                  : [],
              );
            }
            if (table === users) {
              return rowsResult(this.account ? [this.account] : []);
            }
            if (table === userDashboardContents) return rowsResult([]);
            return rowsResult([]);
          },
        }),
      }),
    };
  }

  insert(table: unknown) {
    return {
      values: (value: Record<string, any>) => {
        if (table === websiteProjectDeletionTombstones) {
          return { onDuplicateKeyUpdate: async () => undefined };
        }
        if (table === websiteUserProvisions) this.provision = { ...value };
        return Promise.resolve(undefined);
      },
    };
  }

  update() {
    return {
      set: () => ({ where: async () => undefined }),
    };
  }

  async transaction<T>(operation: (tx: SubmissionDatabase) => Promise<T>) {
    return operation(this);
  }
}

class DecisionDatabase {
  readonly row: Record<string, any>;

  constructor(manual: boolean) {
    this.row = {
      id: "provision-edition-001",
      schemaVersion: 2,
      idempotencyKeyHash: "b".repeat(64),
      requestHash: "c".repeat(64),
      projectId: "project-edition-001",
      companyName: "版本测试企业",
      marketEdition: "overseas",
      orderId: "order-edition-001",
      tradeNo: "trade-edition-001",
      amountFen: 450_000,
      paidAt: new Date("2026-08-07T07:00:00.000Z"),
      serviceCategory: "product_scenario",
      planCode: "basic",
      questionId: "question-edition-001",
      question: "版本测试企业如何支持当前产品场景？",
      contractId: "contract-edition-001",
      contractTemplateVersion: "geo-basic-v2",
      contractDocumentSha256: "a".repeat(64),
      contractEvidence: {
        type: "system_admin_confirmation",
        ...(manual ? { manualOrderReference: "manual-edition-001" } : {}),
        artifact: { sha256: "a".repeat(64) },
      },
      contractConfirmationStatus: "pending_confirmation",
      contractSignedAt: null,
      signatoryId: null,
      requestedUsername: "edition.customer",
      requestedDisplayName: "版本测试企业",
      accountMode: "create",
      purchaseIntentId: null,
      userId: null,
      status: "pending_confirmation",
      accountSetupTokenHash: null,
      accountSetupTokenExpiresAt: null,
      accountSetupTokenConsumedAt: null,
      lastError: null,
      completedAt: null,
      createdAt: NOW,
      updatedAt: NOW,
    };
  }

  select() {
    return {
      from: (table: unknown) => ({
        where: () => ({
          limit: () =>
            rowsResult(
              table === websiteProjectDeletionTombstones
                ? [{ status: "active" }]
                : table === websiteUserProvisions
                  ? [this.row]
                  : [],
            ),
        }),
      }),
    };
  }

  insert(table: unknown) {
    return {
      values: () =>
        table === websiteProjectDeletionTombstones
          ? { onDuplicateKeyUpdate: async () => undefined }
          : Promise.resolve(undefined),
    };
  }

  update(table: unknown) {
    return {
      set: (patch: Record<string, any>) => ({
        where: async () => {
          if (table === websiteUserProvisions) Object.assign(this.row, patch);
        },
      }),
    };
  }

  async transaction<T>(operation: (tx: DecisionDatabase) => Promise<T>) {
    return operation(this);
  }
}

beforeEach(() => {
  databaseState.value = undefined;
  authMocks.createManagedUser.mockReset().mockResolvedValue({ id: 42 });
  authMocks.createManagedUserWithPasswordHash
    .mockReset()
    .mockResolvedValue({ id: 42 });
  entitlementMocks.provisionBasicEntitlement
    .mockReset()
    .mockResolvedValue("service-contract-edition-001");
});

describe("website purchase market edition", () => {
  it("keeps old create clients domestic and persists an explicit overseas edition", async () => {
    const legacyDb = new SubmissionDatabase();
    databaseState.value = legacyDb;
    const legacy = await submitWebsitePurchase({
      idempotencyKey: "edition-create-legacy-idempotency",
      request: purchaseRequest(),
      secret: SECRET,
      now: NOW,
    });
    expect(legacyDb.provision?.marketEdition).toBe("domestic");
    expect(legacy.purchase.marketEdition).toBe("domestic");

    const overseasDb = new SubmissionDatabase();
    databaseState.value = overseasDb;
    const overseas = await submitWebsitePurchase({
      idempotencyKey: "edition-create-overseas-idempotency",
      request: purchaseRequest({ marketEdition: "overseas" }),
      secret: SECRET,
      now: NOW,
    });
    expect(overseasDb.provision?.marketEdition).toBe("overseas");
    expect(overseas.purchase.marketEdition).toBe("overseas");
  });

  it("treats an omitted and explicit domestic edition as the same replay scope", async () => {
    const legacyFirstDb = new SubmissionDatabase();
    databaseState.value = legacyFirstDb;
    const legacy = await submitWebsitePurchase({
      idempotencyKey: "edition-domestic-replay-legacy-first",
      request: purchaseRequest(),
      secret: SECRET,
      now: NOW,
    });
    const explicitReplay = await submitWebsitePurchase({
      idempotencyKey: "edition-domestic-replay-legacy-first",
      request: purchaseRequest({ marketEdition: "domestic" }),
      secret: SECRET,
      now: NOW,
    });
    expect(explicitReplay.purchase.reference).toBe(legacy.purchase.reference);

    const explicitFirstDb = new SubmissionDatabase();
    databaseState.value = explicitFirstDb;
    const explicit = await submitWebsitePurchase({
      idempotencyKey: "edition-domestic-replay-explicit-first",
      request: purchaseRequest({ marketEdition: "domestic" }),
      secret: SECRET,
      now: NOW,
    });
    const omittedReplay = await submitWebsitePurchase({
      idempotencyKey: "edition-domestic-replay-explicit-first",
      request: purchaseRequest(),
      secret: SECRET,
      now: NOW,
    });
    expect(omittedReplay.purchase.reference).toBe(explicit.purchase.reference);
  });

  it("does not let edition compatibility weaken an idempotency conflict", async () => {
    const db = new SubmissionDatabase();
    databaseState.value = db;
    await submitWebsitePurchase({
      idempotencyKey: "edition-replay-mismatch",
      request: purchaseRequest(),
      secret: SECRET,
      now: NOW,
    });
    await expect(
      submitWebsitePurchase({
        idempotencyKey: "edition-replay-mismatch",
        request: purchaseRequest({ marketEdition: "overseas" }),
        secret: SECRET,
        now: NOW,
      }),
    ).rejects.toMatchObject({ code: "IDEMPOTENCY_CONFLICT", status: 409 });

    const overseasDb = new SubmissionDatabase();
    databaseState.value = overseasDb;
    await submitWebsitePurchase({
      idempotencyKey: "edition-overseas-create-replay-mismatch",
      request: purchaseRequest({ marketEdition: "overseas" }),
      secret: SECRET,
      now: NOW,
    });
    await expect(
      submitWebsitePurchase({
        idempotencyKey: "edition-overseas-create-replay-mismatch",
        request: purchaseRequest(),
        secret: SECRET,
        now: NOW,
      }),
    ).rejects.toMatchObject({ code: "IDEMPOTENCY_CONFLICT", status: 409 });
  });

  it("derives an omitted bind edition and rejects an explicit mismatch", async () => {
    const account = {
      id: 17,
      username: "existing.overseas",
      displayName: "版本测试企业",
      marketEdition: "overseas" as const,
    };
    const compatibleDb = new SubmissionDatabase(account);
    databaseState.value = compatibleDb;
    await submitWebsitePurchase({
      idempotencyKey: "edition-bind-compatible-idempotency",
      request: purchaseRequest({ bindExisting: true }),
      secret: SECRET,
      now: NOW,
    });
    expect(compatibleDb.provision?.marketEdition).toBe("overseas");

    const mismatchDb = new SubmissionDatabase(account);
    databaseState.value = mismatchDb;
    await expect(
      submitWebsitePurchase({
        idempotencyKey: "edition-bind-mismatch-idempotency",
        request: purchaseRequest({
          marketEdition: "domestic",
          bindExisting: true,
        }),
        secret: SECRET,
        now: NOW,
      }),
    ).rejects.toMatchObject({
      code: "ACCOUNT_EDITION_MISMATCH",
      status: 409,
    });
    expect(mismatchDb.provision).toBeUndefined();
  });

  it("passes the ledger edition to ordinary managed-user creation", async () => {
    databaseState.value = new DecisionDatabase(false);
    const result = await decideWebsitePurchase({
      reference: "provision-edition-001",
      actorUserId: 1,
      decision: "confirm",
      signedAt: new Date("2026-08-07T07:30:00.000Z"),
      signatoryId: "edition-signatory-001",
      note: "已核对海外版合同签署证据",
      secret: SECRET,
      now: NOW,
    });
    expect(result.purchase.marketEdition).toBe("overseas");
    expect(authMocks.createManagedUser).toHaveBeenCalledWith(
      expect.objectContaining({ marketEdition: "overseas" }),
      expect.anything(),
    );
  });

  it("passes the ledger edition to signing-first password-hash creation", async () => {
    databaseState.value = new DecisionDatabase(true);
    const result = await decideWebsitePurchase({
      reference: "provision-edition-001",
      manualOrderReference: "manual-edition-001",
      actorUserId: 1,
      decision: "confirm",
      signedAt: new Date("2026-08-07T07:30:00.000Z"),
      signatoryId: "edition-signatory-001",
      note: "已核对海外版合同签署证据",
      manualPasswordHash: PASSWORD_HASH,
      secret: SECRET,
      now: NOW,
    });
    expect(result.purchase.marketEdition).toBe("overseas");
    expect(authMocks.createManagedUserWithPasswordHash).toHaveBeenCalledWith(
      expect.objectContaining({ marketEdition: "overseas" }),
      expect.anything(),
    );
  });
});
