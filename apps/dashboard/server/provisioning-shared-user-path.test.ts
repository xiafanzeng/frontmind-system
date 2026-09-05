import { beforeEach, describe, expect, it, vi } from "vitest";

const dbMock = vi.hoisted(() => ({
  getDb: vi.fn(),
}));

vi.mock("./db", () => ({
  getDb: dbMock.getDb,
}));

import {
  apiCredentials,
  serviceContracts,
  serviceQuotaPeriods,
  userAdminAssignments,
  userDashboardContents,
  userPasswordSetupTokens,
  userUsageOwners,
  users,
  websiteUserProvisions,
} from "../drizzle/schema";
import type { TrpcContext } from "./_core/context";
import { adminRouter } from "./admin-router";
import type { AuthenticatedUser } from "./auth-service";
import {
  provisionWebsiteUser,
  type WebsiteProvisionRequest,
} from "./provisioning-service";

const REQUEST_HASH_KEY = "mZE7Hc8h9KJErqfZ76u21kSx3U95QPJNgLw9b4eE5do";

type InsertCall = {
  table: unknown;
  values: Record<string, unknown>;
};

class SharedUsersTableDb {
  readonly deliveryAdminId = 777;
  ownerAdminAccessLevel: "system_admin" | "delivery_admin" = "delivery_admin";
  inserts: InsertCall[] = [];
  userRows: Array<Record<string, any>> = [];
  provisionRows: Array<Record<string, any>> = [];
  projectedUserSelectCount = 0;
  pendingInsertedUserLock = false;

  select(selection?: Record<string, unknown>) {
    return {
      from: (table: unknown) => {
        const selectedRows = () => {
          if (table === users) {
            if (!selection) return this.userRows.slice(-1);
            if ("adminAccessLevel" in selection) {
              return [
                {
                  id: this.deliveryAdminId,
                  role: "admin",
                  adminAccessLevel: this.ownerAdminAccessLevel,
                  isActive: true,
                },
              ];
            }
            this.projectedUserSelectCount += 1;
            if (!this.pendingInsertedUserLock) return [];
            this.pendingInsertedUserLock = false;
            return this.userRows
              .slice(-1)
              .map(({ id, role }) =>
                "role" in selection ? { id, role } : { id },
              );
          }
          if (table === apiCredentials) return [];
          if (table === websiteUserProvisions) {
            return this.provisionRows.slice(-1);
          }
          return [];
        };
        const limit = () => {
          const rows = selectedRows();
          const query = Promise.resolve(rows) as Promise<
            Array<Record<string, any>>
          > & {
            for: () => Promise<Array<Record<string, any>>>;
          };
          query.for = async () => rows;
          return query;
        };
        return {
          where: () => ({
            limit,
            orderBy: () => ({ limit }),
          }),
        };
      },
    };
  }

  insert(table: unknown) {
    return {
      values: async (values: Record<string, unknown>) => {
        this.inserts.push({ table, values });
        if (table === users) {
          const now = new Date("2026-07-24T08:10:00.000Z");
          this.userRows.push({
            id: this.userRows.length + 1,
            openId: null,
            username: values.username,
            passwordHash: values.passwordHash,
            displayName: values.displayName ?? null,
            name: values.name ?? null,
            email: null,
            loginMethod: values.loginMethod ?? "password",
            role: values.role ?? "user",
            marketEdition: values.marketEdition ?? "domestic",
            isActive: values.isActive ?? true,
            passwordChangedAt: values.passwordChangedAt ?? now,
            createdAt: now,
            updatedAt: now,
            lastSignedIn: null,
          });
          this.pendingInsertedUserLock = true;
        } else if (table === websiteUserProvisions) {
          this.provisionRows.push({ ...values });
        }
      },
    };
  }

  update(table: unknown) {
    return {
      set: (values: Record<string, unknown>) => ({
        where: async () => {
          if (table === websiteUserProvisions) {
            Object.assign(this.provisionRows.at(-1)!, values);
          }
        },
      }),
    };
  }

  async transaction<T>(callback: (tx: SharedUsersTableDb) => Promise<T>) {
    return callback(this);
  }
}

function adminContext(
  access: "system_admin" | "delivery_admin" = "system_admin",
): TrpcContext {
  const now = new Date("2026-07-24T08:00:00.000Z");
  const user: AuthenticatedUser = {
    id: access === "system_admin" ? 999 : 777,
    openId: null,
    username: access === "system_admin" ? "admin" : "assigned.manager",
    displayName: "FrontMind 管理员",
    name: "FrontMind 管理员",
    email: null,
    loginMethod: "password",
    role: "admin",
    adminAccessLevel: access,
    isActive: true,
    createdAt: now,
    updatedAt: now,
    lastSignedIn: now,
  };
  return {
    user,
    req: {} as TrpcContext["req"],
    res: {} as TrpcContext["res"],
  };
}

function websiteRequest(): WebsiteProvisionRequest {
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
      displayName: "验收企业·品牌负责人",
    },
  };
}

describe("shared Admin and website user creation path", () => {
  let db: SharedUsersTableDb;

  beforeEach(() => {
    process.env.FRONTMIND_CREDENTIAL_ENCRYPTION_KEY =
      "base64:MDEyMzQ1Njc4OTAxMjM0NTY3ODkwMTIzNDU2Nzg5MDE=";
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("{}", { status: 200 }),
    );
    db = new SharedUsersTableDb();
    dbMock.getDb.mockResolvedValue(db);
  });

  it("writes Admin-created and paid/signed website accounts to the same users table", async () => {
    const adminCaller = adminRouter.createCaller(adminContext());
    const adminResult = await adminCaller.users.create({
      username: "Admin.Created.User",
      password: "admin-created-password",
      displayName: "示例企业·运营负责人",
      role: "user",
      planCode: "advanced",
      marketEdition: "domestic",
      deliveryAdminId: db.deliveryAdminId,
      apiKey: "sk-admin-created-customer-credential-000001",
    });
    expect(adminResult.contract).toMatchObject({
      planCode: "advanced",
      quotaPeriodCount: 1,
    });
    expect(
      db.inserts.find(({ table }) => table === serviceContracts)?.values,
    ).toMatchObject({
      userId: adminResult.user.id,
      status: "active",
      orderReference: null,
      externalContractReference: null,
      signedAt: null,
      signingEvidence: null,
    });
    expect(
      db.inserts.find(({ table }) => table === serviceQuotaPeriods)?.values,
    ).toHaveLength(1);
    expect(
      db.inserts.find(({ table }) => table === apiCredentials)?.values,
    ).toMatchObject({
      userId: adminResult.user.id,
      status: "active",
      version: 1,
    });
    expect(
      db.inserts.find(({ table }) => table === userAdminAssignments)?.values,
    ).toMatchObject({
      userId: adminResult.user.id,
      adminId: db.deliveryAdminId,
    });
    expect(
      db.inserts.find(({ table }) => table === userUsageOwners)?.values,
    ).toMatchObject({
      userId: adminResult.user.id,
      deliveryAdminId: db.deliveryAdminId,
    });

    const request = websiteRequest();
    const websiteResult = await provisionWebsiteUser(
      {
        idempotencyKey: "website-order-zpay-000001",
        request,
      },
      {
        requestHashKey: REQUEST_HASH_KEY,
        now: () => new Date("2026-07-24T08:06:00.000Z"),
      },
    );

    const userInserts = db.inserts.filter(({ table }) => table === users);
    expect(userInserts).toHaveLength(2);
    expect(userInserts.map(({ values }) => values)).toEqual([
      expect.objectContaining({
        username: "admin.created.user",
        passwordHash: expect.stringMatching(/^scrypt\$v1\$/),
        displayName: "示例企业·运营负责人",
        name: "示例企业·运营负责人",
        role: "user",
      }),
      expect.objectContaining({
        username: "acceptance.customer",
        passwordHash: expect.stringMatching(/^scrypt\$v1\$/),
        displayName: "验收企业·品牌负责人",
        name: "验收企业·品牌负责人",
        role: "user",
      }),
    ]);
    expect(adminResult.user).toMatchObject({
      displayName: "示例企业·运营负责人",
      role: "user",
    });
    expect(adminResult).toMatchObject({
      setupUrl: null,
      setupExpiresAt: null,
    });
    expect(
      db.inserts.find(({ table }) => table === userPasswordSetupTokens),
    ).toBeUndefined();
    expect(websiteResult.user).toMatchObject({
      displayName: "验收企业·品牌负责人",
      role: "user",
    });
    expect(db.provisionRows[0]).toMatchObject({
      companyName: "验收企业",
      requestedDisplayName: "验收企业·品牌负责人",
      userId: websiteResult.user.id,
      status: "completed",
    });
    expect(
      db.inserts.find(({ table }) => table === userDashboardContents)?.values,
    ).toMatchObject({
      userId: websiteResult.user.id,
      payload: expect.objectContaining({
        brandName: "验收企业",
      }),
      sourceName: "官网售前开通 · project-acceptance-001",
      revision: 1,
    });
    expect(JSON.stringify(db.provisionRows)).not.toContain(
      request.account.password,
    );
    const insertedUserValues = userInserts.map(({ values }) => values);
    expect(JSON.stringify(insertedUserValues)).not.toContain(
      "admin-created-password",
    );
    expect(JSON.stringify(insertedUserValues)).not.toContain(
      request.account.password,
    );
    expect(JSON.stringify(websiteResult)).not.toContain(
      request.account.password,
    );
  });

  it("allows an active system Admin to be the new customer's primary owner", async () => {
    db.ownerAdminAccessLevel = "system_admin";
    const adminCaller = adminRouter.createCaller(adminContext());

    const result = await adminCaller.users.create({
      username: "Admin.Owned.Customer",
      password: "admin-owned-customer-password",
      displayName: "Admin 负责客户",
      role: "user",
      planCode: "basic",
      marketEdition: "domestic",
      deliveryAdminId: db.deliveryAdminId,
      apiKey: "sk-admin-owned-customer-credential-000001",
    });

    expect(result.assignedDeliveryAdminId).toBe(db.deliveryAdminId);
    expect(
      db.inserts.find(({ table }) => table === userUsageOwners)?.values,
    ).toMatchObject({
      userId: result.user.id,
      deliveryAdminId: db.deliveryAdminId,
    });
  });

  it("keeps administrator passwords on the existing managed-account path", async () => {
    const adminCaller = adminRouter.createCaller(adminContext());
    const result = await adminCaller.users.create({
      username: "operations.admin",
      password: "administrator-selected-password",
      displayName: "运营管理员",
      role: "admin",
    });

    expect(result).toMatchObject({
      user: { username: "operations.admin", role: "admin" },
      setupUrl: null,
      setupExpiresAt: null,
    });
    expect(db.inserts.find(({ table }) => table === users)?.values).toEqual(
      expect.objectContaining({
        passwordHash: expect.stringMatching(/^scrypt\$v1\$/),
        passwordChangedAt: expect.any(Date),
      }),
    );
  });

  it("allows a delivery administrator to create a customer owned by the current account", async () => {
    const caller = adminRouter.createCaller(adminContext("delivery_admin"));
    const result = await caller.users.create({
      username: "assigned.customer",
      password: "delivery-selected-password",
      displayName: "已分配客户",
      role: "user",
      planCode: "luxury",
      marketEdition: "overseas",
      deliveryAdminId: 12_345,
    });

    expect(result).toMatchObject({
      assignedToCreator: true,
      assignedDeliveryAdminId: db.deliveryAdminId,
      user: {
        username: "assigned.customer",
        role: "user",
        marketEdition: "overseas",
      },
      contract: { planCode: "luxury" },
    });
    expect(
      db.inserts.find(({ table }) => table === userAdminAssignments)?.values,
    ).toMatchObject({
      userId: result.user.id,
      adminId: db.deliveryAdminId,
      assignedByUserId: db.deliveryAdminId,
    });
  });

  it("requires an initial password for a normal user", async () => {
    const adminCaller = adminRouter.createCaller(adminContext());
    await expect(
      adminCaller.users.create({
        username: "missing-password.user",
        role: "user",
        planCode: "basic",
        deliveryAdminId: db.deliveryAdminId,
        apiKey: "sk-missing-password-customer-000001",
      } as never),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    expect(db.inserts).toHaveLength(0);
  });

  it("rejects creation of a customer account without an explicit plan", async () => {
    const caller = adminRouter.createCaller(adminContext());
    await expect(
      caller.users.create({
        username: "unplanned.user",
        role: "user",
      } as never),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    expect(db.inserts).toHaveLength(0);
  });
});
