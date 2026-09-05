import { beforeEach, describe, expect, it, vi } from "vitest";

import type { TrpcContext } from "./_core/context";
import type { AuthenticatedUser } from "./auth-service";
import { JenovaBrandTrackingError } from "./jenova-brand-tracking-service";

const mocks = vi.hoisted(() => ({
  getUsage: vi.fn(),
  updateLimit: vi.fn(),
}));

vi.mock("./delivery-role-service", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("./delivery-role-service")>();
  return {
    ...actual,
    getMyCustomerBrandTrackingUsage: mocks.getUsage,
    updateMyCustomerBrandTrackingLimit: mocks.updateLimit,
  };
});

import { deliveryRoleRouter } from "./delivery-role-router";

const PROJECT_ID = "5fd64890-0ba5-4bdf-b9bb-b6a102a97421";

function context(user: AuthenticatedUser | null): TrpcContext {
  return {
    user,
    req: {} as TrpcContext["req"],
    res: {} as TrpcContext["res"],
  };
}

function engineer(): AuthenticatedUser {
  const now = new Date("2026-08-09T08:00:00.000Z");
  return {
    id: 19,
    openId: null,
    username: "ai-operations",
    displayName: "AI 运营工程师",
    name: "AI 运营工程师",
    email: null,
    loginMethod: "password",
    role: "delivery_member",
    adminAccessLevel: null,
    engineerRoleType: "ai_operations_engineer",
    marketEdition: "domestic",
    isActive: true,
    createdAt: now,
    updatedAt: now,
    lastSignedIn: now,
  };
}

const usage = {
  rolling30DayCost: "2.50000000",
  lifetimeCost: "12.50000000",
  limit: "10.00000000",
  remaining: "7.50000000",
  exceededBy: "0.00000000",
  windowStartedAt: "2026-07-10T00:00:00.000Z",
  windowEndsAt: "2026-08-09T00:00:00.000Z",
  pendingReconciliationCount: 0,
  hasUnknownUsage: false,
  keyConfigured: true,
  blocked: false,
  blockReason: null,
};

describe("delivery Jenova brand-tracking control plane", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getUsage.mockResolvedValue({ customerUserId: 42, usage });
    mocks.updateLimit.mockResolvedValue({
      success: true,
      customerUserId: 42,
      usage,
    });
  });

  it("reads usage by assignment without accepting a caller-selected customer", async () => {
    const actor = engineer();
    const caller = deliveryRoleRouter.createCaller(context(actor));

    await expect(
      caller.mine.brandTrackingUsage({ projectAssignmentId: PROJECT_ID }),
    ).resolves.toMatchObject({ customerUserId: 42, usage });
    expect(mocks.getUsage).toHaveBeenCalledWith({
      actor,
      projectAssignmentId: PROJECT_ID,
    });
    await expect(
      caller.mine.brandTrackingUsage({
        projectAssignmentId: PROJECT_ID,
        userId: 42,
      } as any),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });

  it("converts the exact credit string when updating the rolling limit", async () => {
    const actor = engineer();
    const caller = deliveryRoleRouter.createCaller(context(actor));

    await expect(
      caller.mine.updateBrandTrackingLimit({
        projectAssignmentId: PROJECT_ID,
        limitCredits: "10000.00001",
      }),
    ).resolves.toMatchObject({ success: true });
    expect(mocks.updateLimit).toHaveBeenCalledWith({
      actor,
      projectAssignmentId: PROJECT_ID,
      limit: "10.00000001",
    });

    await expect(
      caller.mine.updateBrandTrackingLimit({
        projectAssignmentId: PROJECT_ID,
        limitCredits: "1.000001",
      }),
    ).rejects.toMatchObject({
      code: "BAD_REQUEST",
      message: expect.stringContaining("积分上限"),
    });
    await expect(
      caller.mine.updateBrandTrackingLimit({
        projectAssignmentId: PROJECT_ID,
        limit: "10",
      } as any),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });

    for (const limitCredits of [-1, null, "1000000000000000"] as any[]) {
      await expect(
        caller.mine.updateBrandTrackingLimit({
          projectAssignmentId: PROJECT_ID,
          limitCredits,
        }),
      ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    }
  });

  it("preserves the core forbidden status and requires authentication", async () => {
    mocks.getUsage.mockRejectedValueOnce(
      new JenovaBrandTrackingError(
        "FORBIDDEN",
        "只能管理自己负责的海外客户",
        403,
      ),
    );
    const caller = deliveryRoleRouter.createCaller(context(engineer()));
    await expect(
      caller.mine.brandTrackingUsage({ projectAssignmentId: PROJECT_ID }),
    ).rejects.toMatchObject({
      code: "FORBIDDEN",
      message: "只能管理自己负责的海外客户",
    });

    const anonymous = deliveryRoleRouter.createCaller(context(null));
    await expect(
      anonymous.mine.brandTrackingUsage({ projectAssignmentId: PROJECT_ID }),
    ).rejects.toMatchObject({ code: "UNAUTHORIZED" });
  });
});
