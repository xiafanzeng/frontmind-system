import { beforeEach, describe, expect, it, vi } from "vitest";

import type { TrpcContext } from "./_core/context";
import type { AuthenticatedUser } from "./auth-service";

const mocks = vi.hoisted(() => ({
  adjust: vi.fn(),
}));

vi.mock("./question-quota-service", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("./question-quota-service")>();
  return {
    ...actual,
    adjustMyCustomerQuestionQuota: mocks.adjust,
  };
});

import { deliveryRoleRouter } from "./delivery-role-router";

const PROJECT_ID = "5fd64890-0ba5-4bdf-b9bb-b6a102a97421";
const PERIOD_ID = "065593df-4fd7-4512-8b1d-babfdf8af81d";

function context(user: AuthenticatedUser | null): TrpcContext {
  return {
    user,
    req: {} as TrpcContext["req"],
    res: {} as TrpcContext["res"],
  };
}

function engineer(): AuthenticatedUser {
  const now = new Date("2026-08-05T08:00:00.000Z");
  return {
    id: 19,
    openId: null,
    username: "monitoring-engineer",
    displayName: "AI 监控与优化工程师",
    name: "AI 监控与优化工程师",
    email: null,
    loginMethod: "password",
    role: "delivery_member",
    adminAccessLevel: null,
    engineerRoleType: "monitoring_optimization_engineer",
    isActive: true,
    createdAt: now,
    updatedAt: now,
    lastSignedIn: now,
  };
}

const input = {
  projectAssignmentId: PROJECT_ID,
  quotaPeriodId: PERIOD_ID,
  expectedRevision: 3,
  industryLimit: 1,
  competitorComparisonLimit: 1,
  reputationLimit: 1,
  productScenarioLimit: 5,
  reason: "客户本期需求调整",
};

describe("delivery question quota route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.adjust.mockResolvedValue({
      success: true,
      questionQuota: { periodId: PERIOD_ID, revision: 4 },
    });
  });

  it("forwards the authenticated actor and strict period-bound input", async () => {
    const user = engineer();
    const caller = deliveryRoleRouter.createCaller(context(user));
    await expect(caller.mine.adjustQuestionQuota(input)).resolves.toMatchObject(
      {
        success: true,
        questionQuota: { revision: 4 },
      },
    );
    expect(mocks.adjust).toHaveBeenCalledWith({ actor: user, value: input });
  });

  it("rejects caller-selected customer ids and invalid limits before service", async () => {
    const caller = deliveryRoleRouter.createCaller(context(engineer()));
    await expect(
      caller.mine.adjustQuestionQuota({ ...input, userId: 42 } as any),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    await expect(
      caller.mine.adjustQuestionQuota({ ...input, industryLimit: -1 }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    expect(mocks.adjust).not.toHaveBeenCalled();
  });

  it("requires an authenticated session", async () => {
    const caller = deliveryRoleRouter.createCaller(context(null));
    await expect(caller.mine.adjustQuestionQuota(input)).rejects.toMatchObject({
      code: "UNAUTHORIZED",
    });
    expect(mocks.adjust).not.toHaveBeenCalled();
  });
});
