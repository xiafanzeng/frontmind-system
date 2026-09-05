import { beforeEach, describe, expect, it, vi } from "vitest";

const dependencies = vi.hoisted(() => ({
  getManagedCredentialStatus: vi.fn(),
  getDashboardWorkspace: vi.fn(),
  updateDashboardWorkspace: vi.fn(),
  assertServiceCapability: vi.fn(),
  getServicePortal: vi.fn(),
  writeWorkspaceAuditEvent: vi.fn(),
}));

vi.mock("./dashboard-service", async () => {
  const actual = await vi.importActual<typeof import("./dashboard-service")>(
    "./dashboard-service",
  );
  return {
    ...actual,
    getManagedCredentialStatus: dependencies.getManagedCredentialStatus,
    getDashboardWorkspace: dependencies.getDashboardWorkspace,
    updateDashboardWorkspace: dependencies.updateDashboardWorkspace,
  };
});

vi.mock("./service-entitlement", async () => {
  const actual = await vi.importActual<typeof import("./service-entitlement")>(
    "./service-entitlement",
  );
  return {
    ...actual,
    assertServiceCapability: dependencies.assertServiceCapability,
    getServicePortal: dependencies.getServicePortal,
  };
});

vi.mock("./admin-control-plane-service", async () => {
  const actual = await vi.importActual<
    typeof import("./admin-control-plane-service")
  >("./admin-control-plane-service");
  return {
    ...actual,
    writeWorkspaceAuditEvent: dependencies.writeWorkspaceAuditEvent,
  };
});

import type { TrpcContext } from "./_core/context";
import { adminRouter } from "./admin-router";
import type { AuthenticatedUser } from "./auth-service";
import { createDefaultDashboardPayload } from "../shared/dashboard";

let existingPayload = createDefaultDashboardPayload("正式企业");

const ACTOR: AuthenticatedUser = {
  id: 7,
  openId: null,
  username: "system.admin",
  displayName: "系统管理员",
  name: "系统管理员",
  email: null,
  loginMethod: "password",
  role: "admin",
  adminAccessLevel: "system_admin",
  isActive: true,
  createdAt: new Date("2026-07-28T00:00:00.000Z"),
  updatedAt: new Date("2026-07-28T00:00:00.000Z"),
  lastSignedIn: new Date("2026-07-28T00:00:00.000Z"),
};

function context(): TrpcContext {
  return {
    user: ACTOR,
    req: {} as TrpcContext["req"],
    res: {} as TrpcContext["res"],
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  existingPayload = createDefaultDashboardPayload("正式企业");
  dependencies.getManagedCredentialStatus.mockResolvedValue({});
  dependencies.assertServiceCapability.mockResolvedValue({});
  dependencies.getServicePortal.mockResolvedValue({
    service: { planCode: "advanced" },
    capabilities: {
      contentAssets: { allowed: true },
      knowledgeBuild: { allowed: true },
    },
  });
  dependencies.getDashboardWorkspace.mockResolvedValue({
    payload: existingPayload,
    sourceName: "管理员结构化编辑",
    enterpriseIdentityBoundAt: Date.parse("2026-07-01T00:00:00.000Z"),
    revision: 3,
    updatedAt: Date.parse("2026-07-27T00:00:00.000Z"),
    knowledgeUpdatedAt: null,
  });
  dependencies.writeWorkspaceAuditEvent.mockResolvedValue({});
  dependencies.updateDashboardWorkspace.mockImplementation(
    async (input: Record<string, any>) => {
      const tx = { transaction: "dashboard-write" };
      await input.afterWrite(tx, {
        currentRevision: 3,
        nextRevision: 4,
        payload: input.payload,
        sourceName: input.sourceName,
        enterpriseIdentityBoundAt: new Date("2026-07-01T00:00:00.000Z"),
        publishedAt: new Date("2026-07-28T00:00:00.000Z"),
      });
      return {
        payload: input.payload,
        sourceName: input.sourceName,
        enterpriseIdentityBoundAt: Date.parse("2026-07-01T00:00:00.000Z"),
        revision: 4,
        updatedAt: Date.parse("2026-07-28T00:00:00.000Z"),
        knowledgeUpdatedAt: null,
      };
    },
  );
});

describe("admin dashboard structured publication", () => {
  it("writes its audit through the dashboard transaction hook", async () => {
    const payload = {
      ...createDefaultDashboardPayload("正式企业"),
      headline: "管理员确认后的正式标题",
    };
    const caller = adminRouter.createCaller(context());

    const result = await caller.workspace.updateDashboard({
      userId: 42,
      expectedRevision: 3,
      payload,
      reason: "正式内容更新",
    });

    expect(result.revision).toBe(4);
    expect(dependencies.updateDashboardWorkspace).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: 42,
        actorUserId: ACTOR.id,
        expectedRevision: 3,
        afterWrite: expect.any(Function),
      }),
    );
    expect(dependencies.writeWorkspaceAuditEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        actor: ACTOR,
        action: "workspace.dashboard.updated",
        targetType: "dashboard",
        targetId: 42,
        workspaceUserId: 42,
        reason: "正式内容更新",
        metadata: {
          expectedRevision: 3,
          revision: 4,
          sourceName: "管理员结构化编辑",
        },
      }),
      { transaction: "dashboard-write" },
    );
  });
});
