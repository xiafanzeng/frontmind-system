import { describe, expect, it, vi } from "vitest";

import {
  apiCredentials,
  presalesApiCredentials,
  serviceContracts,
  serviceQuotaPeriods,
  userAdminAssignments,
  userUsageOwners,
  users,
} from "../drizzle/schema";
import {
  SERVICE_PLAN_CATALOG,
  type ServicePlanCode,
} from "../shared/service-portal";
import type { AuthenticatedUser } from "./auth-service";
import {
  completeManagedServiceUserProvisioning,
  createManagedServiceUser,
} from "./managed-user-onboarding-service";
import {
  createServiceQuotaWindows,
  deriveServicePortalState,
} from "./service-entitlement";

function actor(
  access: "delivery_admin" | "system_admin" = "delivery_admin",
): AuthenticatedUser {
  const now = new Date("2026-07-28T08:00:00.000Z");
  return {
    id: access === "system_admin" ? 1 : 42,
    openId: null,
    username: access === "system_admin" ? "admin" : "delivery.manager",
    displayName: "管理员",
    name: "管理员",
    email: null,
    loginMethod: "password",
    role: "admin",
    adminAccessLevel: access,
    isActive: true,
    createdAt: now,
    updatedAt: now,
    lastSignedIn: now,
  };
}

type TestState = {
  accounts: number[];
  contracts: any[];
  quotaPeriods: any[];
  credentials: any[];
  assignments: any[];
  audits: any[];
};

function cloneState(state: TestState): TestState {
  return {
    accounts: [...state.accounts],
    contracts: structuredClone(state.contracts),
    quotaPeriods: structuredClone(state.quotaPeriods),
    credentials: structuredClone(state.credentials),
    assignments: structuredClone(state.assignments),
    audits: structuredClone(state.audits),
  };
}

function harness(options?: {
  failAt?: "contract" | "credential" | "audit";
  invalidKey?: boolean;
}) {
  let committed: TestState = {
    accounts: [],
    contracts: [],
    quotaPeriods: [],
    credentials: [],
    assignments: [],
    audits: [],
  };
  let nextId = 0;
  const dependencies = {
    now: () => new Date("2026-07-28T08:00:00.000Z"),
    randomId: () =>
      `00000000-0000-4000-8000-${String(++nextId).padStart(12, "0")}`,
    transaction: async <T>(callback: (executor: unknown) => Promise<T>) => {
      const working = cloneState(committed);
      const result = await callback(working);
      committed = working;
      return result;
    },
    createAccount: async (input: any, executor: unknown) => {
      expect(input.passwordHash).toMatch(/^scrypt\$v1\$/);
      expect(JSON.stringify(input)).not.toContain("customer-initial-password");
      const state = executor as TestState;
      state.accounts.push(501);
      return {
        ...actor(),
        id: 501,
        username: "new.customer",
        role: "user" as const,
        adminAccessLevel: null,
        marketEdition: input.marketEdition,
      };
    },
    persistContract: async (value: any, executor: unknown) => {
      if (options?.failAt === "contract") throw new Error("contract failed");
      const state = executor as TestState;
      state.contracts.push(value.contract);
      state.quotaPeriods.push(...value.quotaPeriods);
    },
    persistCredentialAndAssignment: async (value: any, executor: unknown) => {
      if (options?.failAt === "credential") {
        throw new Error("credential failed");
      }
      const state = executor as TestState;
      if (value.apiKey) {
        state.credentials.push({
          userId: value.userId,
          apiKey: value.apiKey,
        });
      }
      state.assignments.push({
        userId: value.userId,
        adminId: value.deliveryAdminId,
      });
    },
    validateDeliveryAdmin: async () => undefined,
    validateApiKey: async () => {
      if (options?.invalidKey) throw new Error("invalid api key");
    },
    writeAudit: async (value: any, executor: unknown) => {
      if (options?.failAt === "audit") throw new Error("audit failed");
      (executor as TestState).audits.push(value);
    },
  };
  return {
    dependencies,
    state: () => committed,
  };
}

describe("managed user onboarding", () => {
  it.each<ServicePlanCode>(["basic", "advanced", "luxury"])(
    "immediately activates the %s plan, quota, direct Key and delivery-owner assignment",
    async (planCode) => {
      const test = harness();
      const result = await createManagedServiceUser(
        {
          actor: actor("system_admin"),
          username: "new.customer",
          password: "customer-initial-password",
          displayName: "新客户",
          planCode,
          marketEdition: "domestic",
          deliveryAdminId: 42,
          apiKey: "sk-customer-valid-credential-00000001",
        },
        test.dependencies,
      );
      const state = test.state();
      const expectedQuotaPeriodCount = createServiceQuotaWindows(
        planCode,
        new Date("2026-07-28T08:00:00.000Z"),
      ).length;

      expect(result.contract).toMatchObject({
        userId: 501,
        planCode,
        quotaPeriodCount: expectedQuotaPeriodCount,
      });
      expect(result.assignedToCreator).toBe(false);
      expect(result.assignedDeliveryAdminId).toBe(42);
      expect(state.accounts).toEqual([501]);
      expect(state.contracts).toEqual([
        expect.objectContaining({
          userId: 501,
          planCode,
          planVersion: SERVICE_PLAN_CATALOG[planCode].planVersion,
          status: "active",
          source: "admin",
          amountFen: null,
          revision: 1,
        }),
      ]);
      expect(state.quotaPeriods).toHaveLength(expectedQuotaPeriodCount);
      if (planCode === "luxury") {
        expect(state.quotaPeriods.map((period: any) => period.ordinal)).toEqual(
          [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12],
        );
        expect(state.quotaPeriods[0]).toMatchObject({
          ordinal: 0,
          totalQuestionLimit: 8,
          contentAssetPublishLimit: 0,
          websiteContentPublishLimit: 0,
        });
        expect(state.quotaPeriods.slice(1)).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              ordinal: 1,
              contentAssetPublishLimit: 20,
              websiteContentPublishLimit: 100,
            }),
          ]),
        );
      }
      expect(state.credentials).toEqual([
        {
          userId: 501,
          apiKey: "sk-customer-valid-credential-00000001",
        },
      ]);
      expect(state.assignments).toEqual([{ userId: 501, adminId: 42 }]);
      expect(state.audits[0]).toMatchObject({
        action: "account.created",
        workspaceUserId: 501,
        metadata: {
          role: "user",
          setupRequired: false,
          planCode,
          contractId: result.contract.id,
          entitlementStatus: "active",
          deliveryAdminId: 42,
        },
      });
      const portal = deriveServicePortalState({
        userId: 501,
        now: new Date("2026-07-28T08:00:01.000Z"),
        account: {
          userId: 501,
          username: "new.customer",
          displayName: "新客户",
        },
        contract: state.contracts[0],
        contracts: state.contracts,
        quotaPeriod: state.quotaPeriods[0],
        quotaPeriods: state.quotaPeriods,
        selectedQuestions: [],
        knowledgeVersion: null,
        latestImportStatus: null,
        hasActiveKnowledgeBuild: false,
      });
      expect(portal.service).toMatchObject({
        planCode,
        status: "active",
      });
      expect(portal.quotas).not.toBeNull();
      expect(portal.capabilities.knowledgeBuild.allowed).toBe(
        SERVICE_PLAN_CATALOG[planCode].includedCapabilities.knowledgeBuild,
      );
    },
  );

  it("uses the selected delivery administrator as the customer's responsible administrator", async () => {
    const test = harness();
    const result = await createManagedServiceUser(
      {
        actor: actor("system_admin"),
        username: "system.created.customer",
        password: "customer-initial-password",
        planCode: "advanced",
        marketEdition: "overseas",
        deliveryAdminId: 42,
        apiKey: "sk-customer-valid-credential-00000002",
      },
      test.dependencies,
    );

    expect(result.assignedToCreator).toBe(false);
    expect(result.assignedDeliveryAdminId).toBe(42);
    expect(test.state().contracts).toHaveLength(1);
    expect(test.state().assignments).toEqual([{ userId: 501, adminId: 42 }]);
  });

  it.each(["contract", "credential", "audit"] as const)(
    "rolls back the login account when %s persistence fails",
    async (failAt) => {
      const test = harness({ failAt });

      await expect(
        createManagedServiceUser(
          {
            actor: actor("system_admin"),
            username: "rollback.customer",
            password: "customer-initial-password",
            planCode: "luxury",
            marketEdition: "domestic",
            deliveryAdminId: 42,
            apiKey: "sk-customer-valid-credential-00000003",
          },
          test.dependencies,
        ),
      ).rejects.toThrow();
      expect(test.state()).toEqual({
        accounts: [],
        contracts: [],
        quotaPeriods: [],
        credentials: [],
        assignments: [],
        audits: [],
      });
    },
  );

  it("rejects a non-admin before opening a transaction", async () => {
    const test = harness();
    const userActor = { ...actor(), role: "user" as const };
    const transaction = vi.spyOn(test.dependencies, "transaction");

    await expect(
      createManagedServiceUser(
        {
          actor: userActor,
          username: "forbidden.customer",
          password: "customer-initial-password",
          planCode: "basic",
          marketEdition: "domestic",
          deliveryAdminId: 42,
          apiKey: "sk-customer-valid-credential-00000004",
        },
        test.dependencies,
      ),
    ).rejects.toThrow("只有系统管理员或交付管理员");
    expect(transaction).not.toHaveBeenCalled();
  });

  it("allows a delivery administrator to create a customer assigned to the current account", async () => {
    const test = harness();

    const result = await createManagedServiceUser(
      {
        actor: actor("delivery_admin"),
        username: "delivery.created.customer",
        password: "customer-initial-password",
        planCode: "luxury",
        marketEdition: "domestic",
        deliveryAdminId: 42,
      },
      test.dependencies,
    );

    expect(result.assignedToCreator).toBe(true);
    expect(result.assignedDeliveryAdminId).toBe(42);
    expect(test.state().accounts).toEqual([501]);
    expect(test.state().credentials).toEqual([]);
    expect(test.state().assignments).toEqual([{ userId: 501, adminId: 42 }]);
    expect(test.state().audits[0]).toMatchObject({
      metadata: { deliveryAdminId: 42 },
    });
  });

  it("rejects a customer Key supplied by a delivery administrator", async () => {
    const test = harness();
    const transaction = vi.spyOn(test.dependencies, "transaction");

    await expect(
      createManagedServiceUser(
        {
          actor: actor("delivery_admin"),
          username: "delivery.with-key.customer",
          password: "customer-initial-password",
          planCode: "basic",
          marketEdition: "domestic",
          deliveryAdminId: 42,
          apiKey: "sk-delivery-cannot-configure-customer",
        },
        test.dependencies,
      ),
    ).rejects.toThrow("仅由系统管理员");
    expect(transaction).not.toHaveBeenCalled();
  });

  it("rejects a delivery administrator assigning a new customer to another administrator", async () => {
    const test = harness();
    const transaction = vi.spyOn(test.dependencies, "transaction");

    await expect(
      createManagedServiceUser(
        {
          actor: actor("delivery_admin"),
          username: "cross-assigned.customer",
          password: "customer-initial-password",
          planCode: "luxury",
          marketEdition: "domestic",
          deliveryAdminId: 99,
          apiKey: "sk-customer-valid-credential-00000006",
        },
        test.dependencies,
      ),
    ).rejects.toThrow("必须归属当前账号");
    expect(transaction).not.toHaveBeenCalled();
    expect(test.state()).toEqual({
      accounts: [],
      contracts: [],
      quotaPeriods: [],
      credentials: [],
      assignments: [],
      audits: [],
    });
  });

  it("validates the Key before opening a transaction and leaves no account behind", async () => {
    const test = harness({ invalidKey: true });
    const transaction = vi.spyOn(test.dependencies, "transaction");

    await expect(
      createManagedServiceUser(
        {
          actor: actor("system_admin"),
          username: "invalid-key.customer",
          password: "customer-initial-password",
          planCode: "luxury",
          marketEdition: "domestic",
          deliveryAdminId: 42,
          apiKey: "sk-customer-invalid-credential-000001",
        },
        test.dependencies,
      ),
    ).rejects.toThrow("invalid api key");
    expect(transaction).not.toHaveBeenCalled();
    expect(test.state()).toEqual({
      accounts: [],
      contracts: [],
      quotaPeriods: [],
      credentials: [],
      assignments: [],
      audits: [],
    });
  });

  it("rejects the retired knowledge plan before opening a transaction", async () => {
    const test = harness();
    const transaction = vi.spyOn(test.dependencies, "transaction");

    await expect(
      createManagedServiceUser(
        {
          actor: actor("system_admin"),
          username: "retired-plan.customer",
          password: "customer-initial-password",
          planCode: "knowledge",
          marketEdition: "domestic",
          deliveryAdminId: 42,
          apiKey: "sk-customer-retired-plan-credential-00001",
        },
        test.dependencies,
      ),
    ).rejects.toThrow();
    expect(transaction).not.toHaveBeenCalled();
  });
});

describe("pending managed user provisioning repair", () => {
  it("activates the existing contract once and is idempotent on retry", async () => {
    process.env.FRONTMIND_CREDENTIAL_ENCRYPTION_KEY =
      "base64:MDEyMzQ1Njc4OTAxMjM0NTY3ODkwMTIzNDU2Nzg5MDE=";
    const contract = {
      id: "pending-contract",
      userId: 701,
      planCode: "luxury",
      planVersion: 1,
      status: "pending_confirmation",
      startsAt: new Date("2026-07-28T08:00:00.000Z"),
      endsAt: new Date("2026-10-28T08:00:00.000Z"),
      revision: 1,
    };
    const quotaRows: any[] = [];
    const credentialRows: any[] = [];
    const ownerRows: any[] = [];
    const assignmentRows: any[] = [];
    const auditRows: any[] = [];

    const rowsFor = (table: unknown) => {
      if (table === users) return [{ id: 701, role: "user" }];
      if (table === serviceContracts) return [contract];
      if (table === serviceQuotaPeriods) return quotaRows;
      if (table === apiCredentials) return credentialRows;
      if (table === presalesApiCredentials) return [];
      if (table === userUsageOwners) return ownerRows;
      return [];
    };
    const queryFor = (rows: any[]) => {
      const query: any = {
        where: () => query,
        orderBy: () => query,
        limit: () => query,
        for: async () => rows,
        then: (
          resolve: (value: any[]) => unknown,
          reject: (reason: unknown) => unknown,
        ) => Promise.resolve(rows).then(resolve, reject),
      };
      return query;
    };
    const tx: any = {
      select: () => ({
        from: (table: unknown) => queryFor(rowsFor(table)),
      }),
      insert: (table: unknown) => ({
        values: (value: any) => {
          const values = Array.isArray(value) ? value : [value];
          if (table === serviceQuotaPeriods) quotaRows.push(...values);
          else if (table === apiCredentials) credentialRows.push(...values);
          else if (table === userUsageOwners) ownerRows.push(...values);
          else if (table === userAdminAssignments) {
            assignmentRows.push(...values);
          } else {
            auditRows.push(...values);
          }
          return {
            onDuplicateKeyUpdate: async () => undefined,
          };
        },
      }),
      update: (table: unknown) => ({
        set: (value: any) => ({
          where: async () => {
            if (table === serviceContracts) Object.assign(contract, value);
            if (table === userUsageOwners && ownerRows[0]) {
              Object.assign(ownerRows[0], value);
            }
            if (table === apiCredentials) {
              for (const credential of credentialRows) {
                if (credential.status === "active") {
                  Object.assign(credential, value);
                }
              }
            }
          },
        }),
      }),
    };
    const dependencies = {
      transaction: async <T>(callback: (executor: any) => Promise<T>) =>
        callback(tx),
      validateApiKey: async () => undefined,
      validateDeliveryAdmin: async () => undefined,
      now: () => new Date("2026-07-28T08:05:00.000Z"),
      randomId: vi
        .fn()
        .mockImplementation(
          () => `00000000-0000-4000-8000-${quotaRows.length + 1}`,
        ),
    };
    const input = {
      actor: actor("system_admin"),
      userId: 701,
      expectedRevision: 1,
      deliveryAdminId: 42,
      apiKey: "sk-repair-existing-customer-credential-000001",
    };

    const first = await completeManagedServiceUserProvisioning(
      input,
      dependencies,
    );
    const quotaCountAfterFirst = quotaRows.length;
    const second = await completeManagedServiceUserProvisioning(
      input,
      dependencies,
    );

    expect(first).toMatchObject({
      userId: 701,
      planCode: "luxury",
      idempotent: false,
    });
    expect(second).toMatchObject({
      userId: 701,
      planCode: "luxury",
      idempotent: true,
    });
    expect(contract.status).toBe("active");
    expect(quotaCountAfterFirst).toBe(
      createServiceQuotaWindows("luxury", contract.startsAt, {
        planVersion: 1,
      }).length,
    );
    expect(quotaCountAfterFirst).toBe(3);
    expect(quotaRows).toHaveLength(quotaCountAfterFirst);
    expect(credentialRows).toHaveLength(1);
    expect(assignmentRows).toEqual([
      { userId: 701, adminId: 42, assignedByUserId: 1 },
    ]);
    expect(ownerRows).toEqual([
      expect.objectContaining({ userId: 701, deliveryAdminId: 42 }),
    ]);
    expect(auditRows).toHaveLength(1);
  });
});
