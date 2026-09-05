import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

import { createDefaultDashboardPayload } from "../shared/dashboard";
import type { AuthenticatedUser } from "./auth-service";
import {
  assertAdminAccessLevelsBackfilled,
  buildAdminControlPlaneOverview,
  getEffectiveAdminAccessLevel,
  hasSystemAdminAccess,
  sanitizeAuditMetadata,
  workspaceAuditEventsForActor,
  writeSystemMaintenanceWorkspaceAuditEvent,
} from "./admin-control-plane-service";

function admin(overrides: Partial<AuthenticatedUser> = {}): AuthenticatedUser {
  const now = new Date("2026-07-27T00:00:00.000Z");
  return {
    id: 1,
    openId: null,
    username: "admin",
    displayName: "系统管理员",
    name: "系统管理员",
    email: null,
    loginMethod: "password",
    role: "admin",
    adminAccessLevel: "system_admin",
    isActive: true,
    createdAt: now,
    updatedAt: now,
    lastSignedIn: now,
    ...overrides,
  };
}

describe("administrator access levels", () => {
  it("requires an explicit access level and never trusts the username", () => {
    expect(hasSystemAdminAccess(admin())).toBe(true);
    expect(
      hasSystemAdminAccess(
        admin({ username: "admin", adminAccessLevel: null }),
      ),
    ).toBe(false);
    expect(
      hasSystemAdminAccess(
        admin({ username: "admin", adminAccessLevel: "delivery_admin" }),
      ),
    ).toBe(false);
    expect(
      hasSystemAdminAccess(
        admin({
          username: "delivery.lead",
          adminAccessLevel: "system_admin",
        }),
      ),
    ).toBe(true);
    expect(
      getEffectiveAdminAccessLevel(
        admin({ username: "ordinary.manager", adminAccessLevel: null }),
      ),
    ).toBeNull();
  });

  it("backfills legacy administrators in the migration", () => {
    const migration = readFileSync(
      resolve(process.cwd(), "drizzle/0025_admin_control_plane.sql"),
      "utf8",
    );
    expect(migration).toContain("LOWER(TRIM(COALESCE(`username`, '')))");
    expect(migration).toContain("THEN 'system_admin'");
    expect(migration).toContain("ELSE 'delivery_admin'");
  });

  it("fails production startup when any administrator remains unbackfilled", async () => {
    const executor = (rows: Array<{ id: number; username: string }>) => ({
      select: () => ({
        from: () => ({
          where: () => ({
            limit: async () => rows,
          }),
        }),
      }),
    });

    await expect(
      assertAdminAccessLevelsBackfilled(executor([])),
    ).resolves.toBeUndefined();
    await expect(
      assertAdminAccessLevelsBackfilled(
        executor([{ id: 7, username: "admin" }]),
      ),
    ).rejects.toMatchObject({ code: "CONFLICT" });
  });
});

describe("workspace audit metadata", () => {
  it("records signed-image maintenance without impersonating an administrator", async () => {
    const inserted: Array<Record<string, unknown>> = [];
    const executor = {
      insert: () => ({
        values: async (event: Record<string, unknown>) => inserted.push(event),
      }),
    };
    const event = await writeSystemMaintenanceWorkspaceAuditEvent(
      {
        action: "knowledge_base.incident_repair_applied",
        targetType: "knowledge_base_repair",
        targetId: "kb-repair:proof",
        workspaceUserId: 7,
        reasonCode: "authorized_incident_recovery",
        metadata: { operationToken: "must-not-persist", outcome: "applied" },
      },
      executor,
    );

    expect(event).toMatchObject({
      actorUserId: null,
      actorUsername: "signed-image-maintenance",
      actorAccessLevel: null,
      reason: "authorized_incident_recovery",
      metadata: {
        operationToken: "[REDACTED]",
        outcome: "applied",
        executionChannel: "signed_image_maintenance",
      },
    });
    expect(inserted).toEqual([event]);
  });

  it("redacts credentials recursively while retaining safe evidence", () => {
    const metadata = sanitizeAuditMetadata({
      fingerprint: "fp_1234",
      apiKey: "must-not-be-written",
      nested: {
        password: "also-secret",
        clientSecret: "third-secret",
        status: "verified",
        authorization: "Bearer secret",
      },
      attempts: [{ setupToken: "opaque", result: "success" }],
    });

    expect(metadata).toEqual({
      fingerprint: "fp_1234",
      apiKey: "[REDACTED]",
      nested: {
        password: "[REDACTED]",
        clientSecret: "[REDACTED]",
        status: "verified",
        authorization: "[REDACTED]",
      },
      attempts: [{ setupToken: "[REDACTED]", result: "success" }],
    });
    expect(JSON.stringify(metadata)).not.toContain("must-not-be-written");
    expect(JSON.stringify(metadata)).not.toContain("also-secret");
    expect(JSON.stringify(metadata)).not.toContain("Bearer secret");
  });

  it("removes contract and peer-administrator identifiers for delivery administrators", () => {
    const event = {
      id: "audit-event",
      actorUserId: 88,
      actorUsername: "peer.manager",
      actorAccessLevel: "delivery_admin" as const,
      action: "workspace.service.updated",
      targetType: "service_contract",
      targetId: "contract-internal",
      workspaceUserId: 7,
      reason: null,
      metadata: {
        contractId: "contract-internal",
        adminIds: [42, 88],
        previousAdminIds: [42],
        revision: 3,
      },
      createdAt: Date.parse("2026-07-28T08:00:00.000Z"),
    };

    const [visible] = workspaceAuditEventsForActor(
      admin({
        id: 42,
        username: "delivery.manager",
        adminAccessLevel: "delivery_admin",
      }),
      [event],
    );
    expect(visible).toMatchObject({
      targetType: "service_contract",
      targetId: "7",
      workspaceUserId: 7,
      metadata: {},
    });
    expect(visible).not.toHaveProperty("actorUserId");
    expect(JSON.stringify(visible)).not.toContain("contract-internal");
    expect(JSON.stringify(visible)).not.toContain('"adminIds"');
    expect(JSON.stringify(visible)).not.toContain('"previousAdminIds"');
  });

  it("retains complete audit identifiers for a system administrator", () => {
    const event = {
      id: "audit-event",
      actorUserId: 88,
      actorUsername: "peer.manager",
      actorAccessLevel: "delivery_admin" as const,
      action: "workspace.service.updated",
      targetType: "service_contract",
      targetId: "contract-internal",
      workspaceUserId: 7,
      reason: null,
      metadata: {
        contractId: "contract-internal",
        adminIds: [42, 88],
      },
      createdAt: Date.parse("2026-07-28T08:00:00.000Z"),
    };

    expect(workspaceAuditEventsForActor(admin(), [event])).toEqual([event]);
  });
});

describe("control-plane overview aggregation", () => {
  it("derives configuration, service, key, knowledge and task todos from real rows", () => {
    const now = new Date("2026-07-27T00:00:00.000Z");
    const overview = buildAdminControlPlaneOverview({
      actor: admin({ adminAccessLevel: "system_admin" }),
      now,
      users: [
        {
          id: 10,
          username: "customer.one",
          displayName: "客户一",
          isActive: true,
          createdAt: new Date("2026-07-20T00:00:00.000Z"),
        },
        {
          id: 11,
          username: "customer.two",
          displayName: "客户二",
          isActive: true,
          createdAt: new Date("2026-07-21T00:00:00.000Z"),
        },
      ],
      assignments: [{ userId: 11, adminId: 7 }],
      dashboards: [
        {
          userId: 11,
          payload: createDefaultDashboardPayload("客户二"),
          sourceName: "正式发布",
        },
      ],
      contracts: [
        {
          id: "contract-11",
          userId: 11,
          planCode: "advanced",
          planVersion: 1,
          status: "active",
          startsAt: new Date("2026-07-01T00:00:00.000Z"),
          endsAt: new Date("2026-10-01T00:00:00.000Z"),
          source: "admin",
          revision: 1,
          createdAt: new Date("2026-07-01T00:00:00.000Z"),
        },
      ],
      credentials: [
        {
          userId: 11,
          validationStatus: "invalid",
          verifiedAt: null,
        },
      ],
      knowledgeBuilds: [
        {
          id: "build-11",
          userId: 11,
          companyName: "客户二",
          status: "ready_to_publish",
          protocolError: null,
          updatedAt: new Date("2026-07-26T00:00:00.000Z"),
        },
      ],
      taskCounts: [
        { userId: 10, status: "failed", total: 2 },
        { userId: 11, status: "completed", total: 4 },
      ],
    });

    expect(overview.metrics.customers).toEqual({
      total: 2,
      active: 2,
      inactive: 0,
      unassigned: 1,
      pendingDashboardConfiguration: 1,
    });
    expect(overview.metrics.services.unconfigured).toBe(1);
    expect(overview.metrics.services.active).toBe(1);
    expect(overview.metrics.credentials).toMatchObject({
      configured: 1,
      missing: 1,
      invalid: 1,
    });
    expect(overview.metrics.knowledge.readyToPublish).toBe(1);
    expect(overview.metrics.tasks).toMatchObject({ failed: 2, completed: 4 });
    expect(overview.todos.map((todo) => todo.kind)).toEqual(
      expect.arrayContaining([
        "customer_configuration",
        "service",
        "credential",
        "knowledge",
        "task",
      ]),
    );
    expect(overview.todos[0]?.severity).toBe("critical");
    expect(
      overview.todos.find((todo) => todo.kind === "customer_configuration")
        ?.href,
    ).toBe("/admin/customers/10/workspace");
    expect(
      overview.todos.find(
        (todo) => todo.kind === "service" && todo.userId === 10,
      )?.href,
    ).toBe("/admin/customers/10/workspace");
    expect(
      overview.todos.find(
        (todo) => todo.kind === "credential" && todo.userId === 11,
      )?.href,
    ).toBe(
      "/?credentialType=managed_api&credentialUserId=11&credentialKind=customer",
    );
    expect(
      overview.todos.find(
        (todo) => todo.kind === "knowledge" && todo.userId === 11,
      )?.href,
    ).toBe("/admin/customers/11/workspace");
    expect(overview.todos.find((todo) => todo.kind === "task")?.href).toBe(
      "/admin/customers/10/workspace",
    );
  });

  it("does not claim a global unassigned count for a delivery administrator", () => {
    const overview = buildAdminControlPlaneOverview({
      actor: admin({
        id: 7,
        username: "delivery.lead",
        adminAccessLevel: "delivery_admin",
      }),
      users: [],
      assignments: [],
      dashboards: [],
      contracts: [],
      credentials: [],
      knowledgeBuilds: [],
      taskCounts: [],
    });
    expect(overview.access.isSystemAdmin).toBe(false);
    expect(overview.metrics.customers.unassigned).toBeNull();
  });
});
