import { describe, expect, it, vi } from "vitest";

import type { AuthenticatedUser } from "./auth-service";
import {
  setManagedAdminAccessLevel,
  type AdminAccessManagementStore,
} from "./admin-access-management-service";

type Account = {
  id: number;
  username: string;
  displayName: string;
  role: "admin";
  adminAccessLevel: "system_admin" | "delivery_admin";
  isActive: boolean;
};

function actor(
  adminAccessLevel: "system_admin" | "delivery_admin",
): AuthenticatedUser {
  const now = new Date("2026-07-27T08:00:00.000Z");
  return {
    id: adminAccessLevel === "system_admin" ? 1 : 9,
    openId: null,
    username:
      adminAccessLevel === "system_admin" ? "root.admin" : "delivery.admin",
    displayName: "管理员",
    name: "管理员",
    email: null,
    loginMethod: "password",
    role: "admin",
    adminAccessLevel,
    isActive: true,
    createdAt: now,
    updatedAt: now,
    lastSignedIn: now,
  };
}

function account(
  id: number,
  adminAccessLevel: "system_admin" | "delivery_admin",
  isActive = true,
): Account {
  return {
    id,
    username: `admin-${id}`,
    displayName: `管理员 ${id}`,
    role: "admin",
    adminAccessLevel,
    isActive,
  };
}

function memoryStore(
  initial: Account[],
  usageOwners: Array<{ userId: number; deliveryAdminId: number }> = [],
) {
  const rows = initial.map((item) => ({ ...item }));
  const updateAccessLevel = vi.fn(
    async (
      _executor: unknown,
      userId: number,
      adminAccessLevel: "system_admin" | "delivery_admin",
    ) => {
      const target = rows.find((item) => item.id === userId);
      if (target) target.adminAccessLevel = adminAccessLevel;
    },
  );
  const transaction = vi.fn(
    async <T>(callback: (executor: unknown) => Promise<T>) =>
      callback({ kind: "memory-transaction" }),
  );
  const store: AdminAccessManagementStore = {
    transaction,
    listAdministratorsForUpdate: async () => rows.map((item) => ({ ...item })),
    listUsageOwnedUserIdsForUpdate: async (_executor, deliveryAdminId) =>
      usageOwners
        .filter((owner) => owner.deliveryAdminId === deliveryAdminId)
        .map((owner) => owner.userId),
    updateAccessLevel,
  };
  return { rows, store, transaction, updateAccessLevel };
}

describe("managed administrator access levels", () => {
  it("fails closed before database access for a delivery administrator", async () => {
    const memory = memoryStore([
      account(1, "system_admin"),
      account(9, "delivery_admin"),
    ]);

    await expect(
      setManagedAdminAccessLevel(
        {
          actor: actor("delivery_admin"),
          targetUserId: 1,
          adminAccessLevel: "delivery_admin",
        },
        { store: memory.store },
      ),
    ).rejects.toMatchObject({ code: "INVALID_CREDENTIAL" });

    expect(memory.transaction).not.toHaveBeenCalled();
    expect(memory.updateAccessLevel).not.toHaveBeenCalled();
  });

  it("does not allow the final active system administrator to be demoted", async () => {
    const memory = memoryStore([
      account(1, "system_admin"),
      account(2, "system_admin", false),
      account(3, "delivery_admin"),
    ]);
    const writeAudit = vi.fn(async () => undefined);

    await expect(
      setManagedAdminAccessLevel(
        {
          actor: actor("system_admin"),
          targetUserId: 1,
          adminAccessLevel: "delivery_admin",
        },
        { store: memory.store, writeAudit },
      ),
    ).rejects.toMatchObject({
      code: "LAST_ADMIN",
      message: "至少需要保留一个已启用的系统管理员",
    });

    expect(memory.updateAccessLevel).not.toHaveBeenCalled();
    expect(writeAudit).not.toHaveBeenCalled();
    expect(memory.rows[0]?.adminAccessLevel).toBe("system_admin");
  });

  it("promotes a delivery administrator and writes a redacted audit event", async () => {
    const memory = memoryStore([
      account(1, "system_admin"),
      account(2, "delivery_admin"),
    ]);
    const writeAudit = vi.fn(async () => undefined);

    const result = await setManagedAdminAccessLevel(
      {
        actor: actor("system_admin"),
        targetUserId: 2,
        adminAccessLevel: "system_admin",
        reason: "承担系统账号与全局凭据管理",
      },
      { store: memory.store, writeAudit },
    );

    expect(result).toMatchObject({
      changed: true,
      user: { id: 2, adminAccessLevel: "system_admin" },
    });
    expect(memory.rows[1]?.adminAccessLevel).toBe("system_admin");
    expect(writeAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "account.admin_access_level_updated",
        targetType: "user",
        targetId: 2,
        reason: "承担系统账号与全局凭据管理",
        metadata: expect.objectContaining({
          previousAdminAccessLevel: "delivery_admin",
          adminAccessLevel: "system_admin",
        }),
      }),
      expect.anything(),
    );
  });

  it("preserves usage ownership when promoting a delivery administrator", async () => {
    const memory = memoryStore(
      [account(1, "system_admin"), account(2, "delivery_admin")],
      [
        { userId: 101, deliveryAdminId: 2 },
        { userId: 102, deliveryAdminId: 2 },
      ],
    );
    const writeAudit = vi.fn(async () => undefined);

    const result = await setManagedAdminAccessLevel(
      {
        actor: actor("system_admin"),
        targetUserId: 2,
        adminAccessLevel: "system_admin",
      },
      { store: memory.store, writeAudit },
    );

    expect(result).toMatchObject({
      changed: true,
      user: { id: 2, adminAccessLevel: "system_admin" },
    });
    expect(memory.rows[1]?.adminAccessLevel).toBe("system_admin");
    expect(writeAudit).toHaveBeenCalledOnce();
  });

  it("does not allow the built-in admin to be demoted", async () => {
    const builtin = account(1, "system_admin");
    builtin.username = "admin";
    const memory = memoryStore([builtin, account(2, "system_admin")]);

    await expect(
      setManagedAdminAccessLevel(
        {
          actor: actor("system_admin"),
          targetUserId: 1,
          adminAccessLevel: "delivery_admin",
        },
        { store: memory.store },
      ),
    ).rejects.toMatchObject({
      code: "CONFLICT",
      message: "内置 admin 必须保持为已启用的系统管理员",
    });
  });

  it("allows demotion only when another active system administrator remains", async () => {
    const memory = memoryStore([
      account(1, "system_admin"),
      account(2, "system_admin"),
    ]);
    const writeAudit = vi.fn(async () => undefined);

    const result = await setManagedAdminAccessLevel(
      {
        actor: actor("system_admin"),
        targetUserId: 2,
        adminAccessLevel: "delivery_admin",
      },
      { store: memory.store, writeAudit },
    );

    expect(result.changed).toBe(true);
    expect(memory.rows[1]?.adminAccessLevel).toBe("delivery_admin");
    expect(writeAudit).toHaveBeenCalledTimes(1);
  });

  it("treats an unchanged level as idempotent and does not add audit noise", async () => {
    const memory = memoryStore([
      account(1, "system_admin"),
      account(2, "delivery_admin"),
    ]);
    const writeAudit = vi.fn(async () => undefined);

    const result = await setManagedAdminAccessLevel(
      {
        actor: actor("system_admin"),
        targetUserId: 2,
        adminAccessLevel: "delivery_admin",
      },
      { store: memory.store, writeAudit },
    );

    expect(result.changed).toBe(false);
    expect(memory.updateAccessLevel).not.toHaveBeenCalled();
    expect(writeAudit).not.toHaveBeenCalled();
  });
});
