import { describe, expect, it, vi } from "vitest";

import {
  deliveryProjectAssignments,
  serviceContracts,
  serviceQuotaPeriods,
  workspaceQuestions,
} from "../drizzle/schema";
import { adjustQuestionQuotaSchema } from "../shared/service-portal";
import type { AuthenticatedUser } from "./auth-service";
import {
  adjustMyCustomerQuestionQuota,
  countQuestionQuotaUsage,
  getQuestionQuotaState,
  validateQuestionQuotaAdjustment,
} from "./question-quota-service";
import { UNCLASSIFIED_QUESTION_CANDIDATE_KEY } from "./question-selection-policy";

const NOW = new Date("2026-08-05T08:00:00.000Z");
const PROJECT_ID = "5fd64890-0ba5-4bdf-b9bb-b6a102a97421";
const PERIOD_ID = "065593df-4fd7-4512-8b1d-babfdf8af81d";
const CONTRACT_ID = "73a0d87f-3354-464c-a57b-70c75b6f3d36";

function actor(
  input: {
    id?: number;
    role?: "user" | "admin" | "delivery_member";
    adminAccessLevel?: "system_admin" | "delivery_admin" | null;
    engineerRoleType?:
      | "ai_operations_engineer"
      | "monitoring_optimization_engineer"
      | "content_distribution_engineer"
      | null;
    isActive?: boolean;
  } = {},
): AuthenticatedUser {
  return {
    id: input.id ?? 19,
    openId: null,
    username: `actor-${input.id ?? 19}`,
    displayName: "额度操作人",
    name: "额度操作人",
    email: null,
    loginMethod: "password",
    role: input.role ?? "delivery_member",
    adminAccessLevel: input.adminAccessLevel ?? null,
    engineerRoleType:
      input.engineerRoleType === undefined
        ? "monitoring_optimization_engineer"
        : input.engineerRoleType,
    isActive: input.isActive ?? true,
    createdAt: NOW,
    updatedAt: NOW,
    lastSignedIn: NOW,
  };
}

function contract(
  overrides: Record<string, unknown> = {},
): typeof serviceContracts.$inferSelect {
  return {
    id: CONTRACT_ID,
    userId: 42,
    planCode: "advanced",
    planVersion: 1,
    status: "active",
    startsAt: new Date("2026-07-01T00:00:00.000Z"),
    endsAt: new Date("2026-10-01T00:00:00.000Z"),
    source: "admin",
    amountFen: null,
    currency: "CNY",
    prepaidMonths: 3,
    orderReference: null,
    externalContractReference: null,
    signedAt: NOW,
    signatoryId: "customer-42",
    signingEvidence: null,
    replacesContractIds: [],
    sourceReference: null,
    revision: 2,
    createdByUserId: 1,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  } as typeof serviceContracts.$inferSelect;
}

function period(
  overrides: Record<string, unknown> = {},
): typeof serviceQuotaPeriods.$inferSelect {
  return {
    id: PERIOD_ID,
    contractId: CONTRACT_ID,
    userId: 42,
    ordinal: 1,
    startsAt: new Date("2026-07-01T00:00:00.000Z"),
    endsAt: new Date("2026-10-01T00:00:00.000Z"),
    industryLimit: 1,
    competitorComparisonLimit: 1,
    reputationLimit: 1,
    productScenarioLimit: 5,
    totalQuestionLimit: 8,
    contentAssetPublishLimit: 20,
    websiteContentPublishLimit: 100,
    archivedContentAssetPublishUsed: 0,
    archivedWebsiteContentPublishUsed: 0,
    revision: 3,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  } as typeof serviceQuotaPeriods.$inferSelect;
}

const questionRows = [
  {
    category: "industry",
    status: "selected",
    selectionApprovalStatus: "approved",
  },
  {
    category: "product_scenario",
    status: "candidate",
    selectionApprovalStatus: "pending",
  },
] as const;

const value = adjustQuestionQuotaSchema.parse({
  projectAssignmentId: PROJECT_ID,
  quotaPeriodId: PERIOD_ID,
  expectedRevision: 3,
  industryLimit: 1,
  competitorComparisonLimit: 1,
  reputationLimit: 1,
  productScenarioLimit: 5,
  reason: " 本期客户需求调整 ",
});

function fakeDatabase(input: {
  assignmentRows?: Array<Record<string, unknown>>;
  contractRows?: Array<typeof serviceContracts.$inferSelect>;
  periodRows?: Array<typeof serviceQuotaPeriods.$inferSelect>;
  questions?: Array<Record<string, unknown>>;
  affectedRows?: number;
}) {
  let updateValue: Record<string, unknown> | null = null;
  const updateWhere = vi.fn(async () => [
    { affectedRows: input.affectedRows ?? 1 },
  ]);
  const select = vi.fn(() => {
    let source: unknown;
    const rows = () => {
      if (source === deliveryProjectAssignments) {
        return (
          input.assignmentRows ?? [
            {
              projectAssignmentId: PROJECT_ID,
              customerUserId: 42,
              roleType: "monitoring_optimization_engineer",
              engineerUserId: 19,
            },
          ]
        );
      }
      if (source === serviceQuotaPeriods) {
        return input.periodRows ?? [period()];
      }
      if (source === serviceContracts) {
        return input.contractRows ?? [contract()];
      }
      if (source === workspaceQuestions) {
        return input.questions ?? [...questionRows];
      }
      return [];
    };
    const builder: any = {
      from(table: unknown) {
        source = table;
        return builder;
      },
      innerJoin() {
        return builder;
      },
      where() {
        return builder;
      },
      orderBy() {
        return builder;
      },
      limit() {
        return builder;
      },
      for() {
        return Promise.resolve(rows());
      },
      then(
        resolve: (value: unknown) => unknown,
        reject: (error: unknown) => unknown,
      ) {
        return Promise.resolve(rows()).then(resolve, reject);
      },
    };
    return builder;
  });
  const tx: any = {
    select,
    update: vi.fn(() => ({
      set(next: Record<string, unknown>) {
        updateValue = next;
        return { where: updateWhere };
      },
    })),
  };
  const database = {
    transaction: vi.fn(async (callback: (executor: any) => unknown) =>
      callback(tx),
    ),
  };
  return {
    database,
    tx,
    updateWhere,
    getUpdateValue: () => updateValue,
  };
}

describe("question quota input and usage", () => {
  it("accepts four bounded category limits and never accepts a caller userId", () => {
    expect(value).toMatchObject({
      industryLimit: 1,
      competitorComparisonLimit: 1,
      reputationLimit: 1,
      productScenarioLimit: 5,
      reason: "本期客户需求调整",
    });
    expect(() =>
      adjustQuestionQuotaSchema.parse({ ...value, userId: 42 }),
    ).toThrow();
    expect(() =>
      adjustQuestionQuotaSchema.parse({ ...value, reputationLimit: -1 }),
    ).toThrow();
    expect(() =>
      adjustQuestionQuotaSchema.parse({ ...value, productScenarioLimit: 1.5 }),
    ).toThrow();
    expect(() =>
      adjustQuestionQuotaSchema.parse({ ...value, industryLimit: 67 }),
    ).toThrow();
  });

  it("counts selected questions and pending approvals as active reservations", () => {
    expect(
      countQuestionQuotaUsage([
        ...questionRows,
        {
          category: "reputation",
          status: "archived",
          selectionApprovalStatus: "pending",
        },
      ]),
    ).toEqual({
      selectedUsage: {
        industry: 1,
        competitorComparison: 0,
        reputation: 0,
        productScenario: 0,
        total: 1,
      },
      reservedUsage: {
        industry: 1,
        competitorComparison: 0,
        reputation: 0,
        productScenario: 1,
        total: 2,
      },
    });
  });

  it("reserves only the total slot for an unclassified direct submission", () => {
    expect(
      countQuestionQuotaUsage([
        {
          category: "product_scenario",
          candidateKey: UNCLASSIFIED_QUESTION_CANDIDATE_KEY,
          source: "user",
          status: "candidate",
          selectionApprovalStatus: "pending",
        },
      ]),
    ).toEqual({
      selectedUsage: {
        industry: 0,
        competitorComparison: 0,
        reputation: 0,
        productScenario: 0,
        total: 0,
      },
      reservedUsage: {
        industry: 0,
        competitorComparison: 0,
        reputation: 0,
        productScenario: 0,
        total: 1,
      },
    });
  });

  it("conservatively reserves every category for a progressive unclassified submission", () => {
    expect(
      countQuestionQuotaUsage(
        [
          {
            category: "product_scenario",
            candidateKey: UNCLASSIFIED_QUESTION_CANDIDATE_KEY,
            source: "user",
            status: "candidate",
            selectionApprovalStatus: "pending",
          },
        ],
        { reserveUnclassifiedAcrossCategories: true },
      ).reservedUsage,
    ).toEqual({
      industry: 1,
      competitorComparison: 1,
      reputation: 1,
      productScenario: 1,
      total: 1,
    });
  });

  it("does not reinterpret a legacy pending product-scenario question", () => {
    expect(
      countQuestionQuotaUsage([
        {
          category: "product_scenario",
          candidateKey: null,
          source: "user",
          status: "candidate",
          selectionApprovalStatus: "pending",
        },
      ]).reservedUsage,
    ).toEqual({
      industry: 0,
      competitorComparison: 0,
      reputation: 0,
      productScenario: 1,
      total: 1,
    });
  });

  it("derives the total, increments the revision, and protects soft holds", () => {
    expect(
      validateQuestionQuotaAdjustment({
        expectedRevision: 3,
        currentRevision: 3,
        limits: {
          industryLimit: 1,
          competitorComparisonLimit: 1,
          reputationLimit: 1,
          productScenarioLimit: 5,
        },
        maximumLimits: period(),
        reservedUsage: {
          industry: 1,
          competitorComparison: 0,
          reputation: 0,
          productScenario: 1,
          total: 2,
        },
      }),
    ).toEqual({
      limits: {
        industryLimit: 1,
        competitorComparisonLimit: 1,
        reputationLimit: 1,
        productScenarioLimit: 5,
        totalQuestionLimit: 8,
      },
      revision: 4,
    });
    expect(() =>
      validateQuestionQuotaAdjustment({
        expectedRevision: 3,
        currentRevision: 3,
        limits: {
          industryLimit: 1,
          competitorComparisonLimit: 1,
          reputationLimit: 1,
          productScenarioLimit: 0,
        },
        maximumLimits: period(),
        reservedUsage: {
          industry: 1,
          competitorComparison: 0,
          reputation: 0,
          productScenario: 1,
          total: 2,
        },
      }),
    ).toThrow("产品场景词额度不能低于当前已确认与待审核预留数量 1");
    expect(() =>
      validateQuestionQuotaAdjustment({
        expectedRevision: 2,
        currentRevision: 3,
        limits: {
          industryLimit: 1,
          competitorComparisonLimit: 1,
          reputationLimit: 1,
          productScenarioLimit: 5,
        },
        maximumLimits: period(),
        reservedUsage: {
          industry: 0,
          competitorComparison: 0,
          reputation: 0,
          productScenario: 0,
          total: 0,
        },
      }),
    ).toThrow("问题额度已被其他人更新");
  });

  it("never lets a manual adjustment exceed the system-unlocked cap", () => {
    expect(() =>
      validateQuestionQuotaAdjustment({
        expectedRevision: 3,
        currentRevision: 3,
        limits: {
          industryLimit: 1,
          competitorComparisonLimit: 1,
          reputationLimit: 1,
          productScenarioLimit: 6,
        },
        maximumLimits: {
          industryLimit: 1,
          competitorComparisonLimit: 1,
          reputationLimit: 1,
          productScenarioLimit: 5,
          totalQuestionLimit: 8,
        },
        reservedUsage: {
          industry: 0,
          competitorComparison: 0,
          reputation: 0,
          productScenario: 0,
          total: 0,
        },
      }),
    ).toThrow("产品场景词额度不能超过当前已解锁上限 5");
  });

  it("keeps legacy quota adjustments independent from progressive unlock caps", () => {
    expect(
      validateQuestionQuotaAdjustment({
        expectedRevision: 3,
        currentRevision: 3,
        limits: {
          industryLimit: 1,
          competitorComparisonLimit: 1,
          reputationLimit: 1,
          productScenarioLimit: 6,
        },
        reservedUsage: {
          industry: 0,
          competitorComparison: 0,
          reputation: 0,
          productScenario: 0,
          total: 0,
        },
      }),
    ).toMatchObject({
      limits: { productScenarioLimit: 6, totalQuestionLimit: 9 },
    });
  });
});

describe("question quota service", () => {
  it("lets the assigned monitoring engineer update the current period with CAS and audit", async () => {
    const fake = fakeDatabase({});
    const writeAudit = vi.fn(async () => undefined as any);
    const result = await adjustMyCustomerQuestionQuota({
      actor: actor(),
      value,
      dependencies: {
        getDatabase: vi.fn(async () => fake.database as any),
        writeAudit,
        now: () => NOW,
      },
    });

    expect(fake.getUpdateValue()).toMatchObject({
      industryLimit: 1,
      competitorComparisonLimit: 1,
      reputationLimit: 1,
      productScenarioLimit: 5,
      totalQuestionLimit: 8,
      revision: 4,
    });
    expect(fake.updateWhere).toHaveBeenCalledOnce();
    expect(writeAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        actor: expect.objectContaining({ id: 19 }),
        action: "service_quota_period.question_limits_adjusted",
        targetId: PERIOD_ID,
        workspaceUserId: 42,
        reason: "本期客户需求调整",
        metadata: expect.objectContaining({
          projectAssignmentId: PROJECT_ID,
          previousRevision: 3,
          revision: 4,
          reservedUsage: expect.objectContaining({ total: 2 }),
        }),
      }),
      fake.tx,
    );
    expect(result.questionQuota).toMatchObject({
      periodId: PERIOD_ID,
      revision: 4,
      limits: { totalQuestionLimit: 8 },
      unlockedLimits: { totalQuestionLimit: 8 },
      unlockStage: { current: 1, total: 1 },
      nextUnlockAt: null,
      progressiveUnlock: false,
      selectedUsage: { total: 1 },
      reservedUsage: { total: 2 },
      remaining: { total: 6 },
    });
    expect(result.questionQuota).not.toHaveProperty("contractId");
  });

  it("lets a system administrator use the same monitoring-project boundary", async () => {
    const fake = fakeDatabase({
      assignmentRows: [
        {
          projectAssignmentId: PROJECT_ID,
          customerUserId: 42,
          roleType: "monitoring_optimization_engineer",
          engineerUserId: null,
        },
      ],
    });
    await expect(
      adjustMyCustomerQuestionQuota({
        actor: actor({
          id: 1,
          role: "admin",
          adminAccessLevel: "system_admin",
          engineerRoleType: null,
        }),
        value,
        dependencies: {
          getDatabase: vi.fn(async () => fake.database as any),
          writeAudit: vi.fn(async () => undefined as any),
          now: () => NOW,
        },
      }),
    ).resolves.toMatchObject({ success: true });
  });

  it("rejects a Luxury v2 increase beyond the current quarterly unlock", async () => {
    const luxuryContract = contract({
      planCode: "luxury",
      planVersion: 2,
      startsAt: new Date("2026-07-01T00:00:00.000Z"),
      endsAt: new Date("2027-07-01T00:00:00.000Z"),
    });
    const fake = fakeDatabase({
      contractRows: [luxuryContract],
      periodRows: [
        period({
          ordinal: 2,
          startsAt: new Date("2026-08-01T00:00:00.000Z"),
          endsAt: new Date("2026-09-01T00:00:00.000Z"),
          industryLimit: 4,
          competitorComparisonLimit: 4,
          reputationLimit: 4,
          productScenarioLimit: 20,
          totalQuestionLimit: 32,
        }),
      ],
    });

    await expect(
      adjustMyCustomerQuestionQuota({
        actor: actor(),
        value: { ...value, productScenarioLimit: 6 },
        dependencies: {
          getDatabase: vi.fn(async () => fake.database as any),
          writeAudit: vi.fn(),
          now: () => NOW,
        },
      }),
    ).rejects.toThrow("产品场景词额度不能超过当前已解锁上限 5");
    expect(fake.getUpdateValue()).toBeNull();
  });

  it("rejects wrong roles before database access and unassigned engineers inside the lock", async () => {
    const getDatabase = vi.fn();
    await expect(
      adjustMyCustomerQuestionQuota({
        actor: actor({ engineerRoleType: "ai_operations_engineer" }),
        value,
        dependencies: { getDatabase },
      }),
    ).rejects.toMatchObject({ code: "INVALID_CREDENTIAL" });
    expect(getDatabase).not.toHaveBeenCalled();

    const fake = fakeDatabase({ assignmentRows: [] });
    await expect(
      adjustMyCustomerQuestionQuota({
        actor: actor(),
        value,
        dependencies: {
          getDatabase: vi.fn(async () => fake.database as any),
          writeAudit: vi.fn(async () => undefined as any),
          now: () => NOW,
        },
      }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("rejects Basic, inactive, historical, and lost-CAS periods without audit", async () => {
    for (const currentContract of [
      contract({ planCode: "basic" }),
      contract({ status: "suspended" }),
    ]) {
      const fake = fakeDatabase({ contractRows: [currentContract] });
      const writeAudit = vi.fn();
      await expect(
        adjustMyCustomerQuestionQuota({
          actor: actor(),
          value,
          dependencies: {
            getDatabase: vi.fn(async () => fake.database as any),
            writeAudit,
            now: () => NOW,
          },
        }),
      ).rejects.toMatchObject({ code: "CONFLICT" });
      expect(writeAudit).not.toHaveBeenCalled();
    }

    const stale = fakeDatabase({
      periodRows: [period({ endsAt: new Date("2026-08-01T00:00:00.000Z") })],
    });
    await expect(
      adjustMyCustomerQuestionQuota({
        actor: actor(),
        value,
        dependencies: {
          getDatabase: vi.fn(async () => stale.database as any),
          writeAudit: vi.fn(),
          now: () => NOW,
        },
      }),
    ).rejects.toMatchObject({ code: "CONFLICT" });

    const lostCas = fakeDatabase({ affectedRows: 0 });
    const writeAudit = vi.fn();
    await expect(
      adjustMyCustomerQuestionQuota({
        actor: actor(),
        value,
        dependencies: {
          getDatabase: vi.fn(async () => lostCas.database as any),
          writeAudit,
          now: () => NOW,
        },
      }),
    ).rejects.toMatchObject({ code: "CONFLICT" });
    expect(writeAudit).not.toHaveBeenCalled();
  });

  it("returns a narrow workbench DTO with selected and pending usage", async () => {
    const fake = fakeDatabase({});
    const state = await getQuestionQuotaState({
      executor: fake.tx,
      customerUserId: 42,
      now: NOW,
    });
    expect(state).toMatchObject({
      periodId: PERIOD_ID,
      revision: 3,
      limits: { totalQuestionLimit: 8 },
      unlockedLimits: { totalQuestionLimit: 8 },
      progressiveUnlock: false,
      selectedUsage: { industry: 1, productScenario: 0, total: 1 },
      reservedUsage: { industry: 1, productScenario: 1, total: 2 },
      remaining: { industry: 0, productScenario: 4, total: 6 },
    });
    expect(state).not.toHaveProperty("contractId");
  });

  it("returns Luxury v2 quarterly metadata while aggregating contract usage", async () => {
    const fake = fakeDatabase({
      contractRows: [
        contract({
          planCode: "luxury",
          planVersion: 2,
          startsAt: new Date("2026-07-01T00:00:00.000Z"),
          endsAt: new Date("2027-07-01T00:00:00.000Z"),
        }),
      ],
      periodRows: [
        period({
          ordinal: 2,
          startsAt: new Date("2026-08-01T00:00:00.000Z"),
          endsAt: new Date("2026-09-01T00:00:00.000Z"),
          industryLimit: 4,
          competitorComparisonLimit: 4,
          reputationLimit: 4,
          productScenarioLimit: 20,
          totalQuestionLimit: 32,
        }),
      ],
      questions: [
        {
          category: "industry",
          status: "selected",
          selectionApprovalStatus: "approved",
        },
        {
          category: "product_scenario",
          status: "candidate",
          selectionApprovalStatus: "pending",
        },
      ],
    });

    const state = await getQuestionQuotaState({
      executor: fake.tx,
      customerUserId: 42,
      now: NOW,
    });
    expect(state).toMatchObject({
      limits: {
        industryLimit: 1,
        competitorComparisonLimit: 1,
        reputationLimit: 1,
        productScenarioLimit: 5,
        totalQuestionLimit: 8,
      },
      unlockedLimits: { totalQuestionLimit: 8 },
      unlockStage: { current: 1, total: 4 },
      progressiveUnlock: true,
      selectedUsage: { total: 1 },
      reservedUsage: { total: 2 },
      remaining: { total: 6 },
    });
    expect(state?.nextUnlockAt).toBe(Date.parse("2026-10-01T00:00:00.000Z"));
  });

  it("never selects the annual Luxury v2 question anchor as the operational period", async () => {
    const luxuryContract = contract({
      planCode: "luxury",
      planVersion: 2,
      startsAt: new Date("2026-07-01T00:00:00.000Z"),
      endsAt: new Date("2027-07-01T00:00:00.000Z"),
    });
    const anchor = period({
      id: "annual-question-anchor",
      ordinal: 0,
      startsAt: luxuryContract.startsAt,
      endsAt: luxuryContract.endsAt,
      contentAssetPublishLimit: 0,
      websiteContentPublishLimit: 0,
    });
    const operational = period({
      id: "month-2-operational",
      ordinal: 2,
      startsAt: new Date("2026-08-01T00:00:00.000Z"),
      endsAt: new Date("2026-09-01T00:00:00.000Z"),
    });
    const fake = fakeDatabase({
      contractRows: [luxuryContract],
      // The fake intentionally does not evaluate the SQL WHERE clause. The
      // service's defensive in-memory selection must still skip ordinal 0.
      periodRows: [anchor, operational],
    });

    const state = await getQuestionQuotaState({
      executor: fake.tx,
      customerUserId: 42,
      now: NOW,
    });
    expect(state?.periodId).toBe(operational.id);
  });

  it("rejects attempts to edit the annual Luxury v2 compatibility anchor", async () => {
    const luxuryContract = contract({
      planCode: "luxury",
      planVersion: 2,
      startsAt: new Date("2026-07-01T00:00:00.000Z"),
      endsAt: new Date("2027-07-01T00:00:00.000Z"),
    });
    const fake = fakeDatabase({
      contractRows: [luxuryContract],
      periodRows: [
        period({
          id: PERIOD_ID,
          ordinal: 0,
          startsAt: luxuryContract.startsAt,
          endsAt: luxuryContract.endsAt,
          contentAssetPublishLimit: 0,
          websiteContentPublishLimit: 0,
        }),
      ],
    });

    await expect(
      adjustMyCustomerQuestionQuota({
        actor: actor(),
        value,
        dependencies: {
          getDatabase: vi.fn(async () => fake.database as any),
          writeAudit: vi.fn(),
          now: () => NOW,
        },
      }),
    ).rejects.toMatchObject({ code: "CONFLICT" });
    expect(fake.getUpdateValue()).toBeNull();
  });
});
