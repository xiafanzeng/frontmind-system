import { beforeEach, describe, expect, it, vi } from "vitest";

import type { TrpcContext } from "./_core/context";
import type { AuthenticatedUser } from "./auth-service";

const mocks = vi.hoisted(() => ({
  getJenovaBrandTrackingOverview: vi.fn(),
  listJenovaBrandTrackingSessions: vi.fn(),
  getJenovaBrandTrackingSession: vi.fn(),
  assertServiceCapability: vi.fn(),
}));

vi.mock("./jenova-brand-tracking-service", () => mocks);
vi.mock("./service-entitlement", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./service-entitlement")>();
  return {
    ...actual,
    assertServiceCapability: mocks.assertServiceCapability,
  };
});

import { workspaceRouter } from "./workspace-router";

const now = new Date("2026-08-08T08:00:00.000Z");
const sessionId = "11111111-1111-4111-8111-111111111111";

function context(): TrpcContext {
  const user: AuthenticatedUser = {
    id: 7,
    openId: null,
    username: "overseas.customer",
    displayName: "海外客户",
    name: "海外客户",
    email: null,
    loginMethod: "password",
    role: "user",
    adminAccessLevel: null,
    engineerRoleType: null,
    marketEdition: "overseas",
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

describe("workspace Jenova brand-tracking router", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.assertServiceCapability.mockResolvedValue({});
    mocks.getJenovaBrandTrackingOverview.mockResolvedValue({
      eligible: true,
      keyConfigured: true,
      blocked: false,
      blockReason: null,
      activeSessionId: sessionId,
      usage: {
        rolling30DayCost: "1.25000000",
        lifetimeCost: "2.00000000",
        limit: "10.00000000",
        remaining: "8.75000000",
        exceededBy: "0.00000000",
        windowStartedAt: "2026-07-09T08:00:00.000Z",
        windowEndsAt: "2026-08-08T08:00:00.000Z",
      },
    });
    mocks.listJenovaBrandTrackingSessions.mockResolvedValue({
      sessions: [
        {
          sessionId,
          title: "品牌追踪",
          status: "active",
          createdAt: now.toISOString(),
          updatedAt: now.toISOString(),
        },
      ],
    });
    mocks.getJenovaBrandTrackingSession.mockResolvedValue({
      session: {
        sessionId,
        title: "品牌追踪",
        status: "active",
        createdAt: now.toISOString(),
        updatedAt: now.toISOString(),
      },
      messages: [],
    });
  });

  it("returns only the authenticated user's local usage overview", async () => {
    const caller = workspaceRouter.createCaller(context());

    await expect(caller.brandTracking.overview()).resolves.toMatchObject({
      keyConfigured: true,
      usage: { rolling30DayCost: "1.25000000" },
    });
    expect(mocks.getJenovaBrandTrackingOverview).toHaveBeenCalledWith(
      expect.objectContaining({ id: 7, marketEdition: "overseas" }),
    );
    expect(mocks.assertServiceCapability).toHaveBeenCalledWith(
      7,
      "brandTracking",
    );
  });

  it("lists local sessions and scopes a transcript lookup to the actor", async () => {
    const caller = workspaceRouter.createCaller(context());

    await expect(caller.brandTracking.listSessions()).resolves.toMatchObject({
      sessions: [expect.objectContaining({ sessionId })],
    });
    await expect(
      caller.brandTracking.getSession({ sessionId }),
    ).resolves.toMatchObject({ session: { sessionId }, messages: [] });
    expect(mocks.listJenovaBrandTrackingSessions).toHaveBeenCalledWith(
      expect.objectContaining({ id: 7 }),
    );
    expect(mocks.getJenovaBrandTrackingSession).toHaveBeenCalledWith(
      expect.objectContaining({ id: 7 }),
      sessionId,
    );
    expect(mocks.assertServiceCapability).toHaveBeenCalledTimes(2);
  });

  it("rejects malformed local session identifiers before the service", async () => {
    const caller = workspaceRouter.createCaller(context());

    await expect(
      caller.brandTracking.getSession({ sessionId: "not-a-session" }),
    ).rejects.toBeDefined();
    expect(mocks.getJenovaBrandTrackingSession).not.toHaveBeenCalled();
  });
});
