import { asc, eq } from "drizzle-orm";

import { userUsageOwners, users } from "../drizzle/schema";
import {
  getEffectiveAdminAccessLevel,
  hasSystemAdminAccess,
  writeWorkspaceAuditEvent,
} from "./admin-control-plane-service";
import { isProtectedBuiltinAdminUsername } from "../shared/admin-access";
import { AuthServiceError, type AuthenticatedUser } from "./auth-service";
import { getDb } from "./db";

export type ManagedAdminAccessLevel = "system_admin" | "delivery_admin";

type AdminAccessAccount = {
  id: number;
  username: string | null;
  displayName: string | null;
  role: "user" | "admin";
  adminAccessLevel: ManagedAdminAccessLevel | null;
  isActive: boolean;
};

type AdminAccessAuditInput = Parameters<typeof writeWorkspaceAuditEvent>[0];

export type AdminAccessManagementStore = {
  transaction<T>(callback: (executor: unknown) => Promise<T>): Promise<T>;
  listAdministratorsForUpdate(executor: unknown): Promise<AdminAccessAccount[]>;
  listUsageOwnedUserIdsForUpdate(
    executor: unknown,
    deliveryAdminId: number,
  ): Promise<number[]>;
  updateAccessLevel(
    executor: unknown,
    userId: number,
    adminAccessLevel: ManagedAdminAccessLevel,
  ): Promise<void>;
};

type AdminAccessManagementDependencies = {
  store?: AdminAccessManagementStore;
  writeAudit?: (
    input: AdminAccessAuditInput,
    executor: unknown,
  ) => Promise<unknown>;
};

function effectiveAccessLevel(account: AdminAccessAccount) {
  return getEffectiveAdminAccessLevel({
    role: account.role,
    username: account.username ?? "",
    adminAccessLevel: account.adminAccessLevel,
  });
}

export function assertAdminAccessLevelTransition(input: {
  actor: Pick<AuthenticatedUser, "role" | "username" | "adminAccessLevel">;
  targetUserId: number;
  nextAccessLevel: ManagedAdminAccessLevel;
  administrators: AdminAccessAccount[];
}) {
  if (!hasSystemAdminAccess(input.actor)) {
    throw new AuthServiceError(
      "INVALID_CREDENTIAL",
      "只有系统管理员可以调整管理员权限",
    );
  }

  const target = input.administrators.find(
    (account) => account.id === input.targetUserId,
  );
  if (!target) {
    throw new AuthServiceError("NOT_FOUND", "管理员账号不存在");
  }

  const previousAccessLevel = effectiveAccessLevel(target) ?? "delivery_admin";
  if (
    isProtectedBuiltinAdminUsername(target.username) &&
    input.nextAccessLevel !== "system_admin"
  ) {
    throw new AuthServiceError(
      "CONFLICT",
      "内置 admin 必须保持为已启用的系统管理员",
    );
  }
  if (previousAccessLevel === input.nextAccessLevel) {
    return {
      changed: false as const,
      target,
      previousAccessLevel,
    };
  }

  if (
    previousAccessLevel === "system_admin" &&
    input.nextAccessLevel === "delivery_admin"
  ) {
    const anotherActiveSystemAdmin = input.administrators.some(
      (account) =>
        account.id !== target.id &&
        account.isActive &&
        effectiveAccessLevel(account) === "system_admin",
    );
    if (!anotherActiveSystemAdmin) {
      throw new AuthServiceError(
        "LAST_ADMIN",
        "至少需要保留一个已启用的系统管理员",
      );
    }
  }

  return {
    changed: true as const,
    target,
    previousAccessLevel,
  };
}

async function defaultStore(): Promise<AdminAccessManagementStore> {
  const db = await getDb();
  if (!db) {
    throw new AuthServiceError(
      "DATABASE_UNAVAILABLE",
      "Database is not configured",
    );
  }

  return {
    transaction: (callback) => db.transaction((executor) => callback(executor)),
    listAdministratorsForUpdate: async (executor) =>
      (executor as any)
        .select({
          id: users.id,
          username: users.username,
          displayName: users.displayName,
          role: users.role,
          adminAccessLevel: users.adminAccessLevel,
          isActive: users.isActive,
        })
        .from(users)
        .where(eq(users.role, "admin"))
        .orderBy(asc(users.id))
        .for("update"),
    listUsageOwnedUserIdsForUpdate: async (executor, deliveryAdminId) => {
      const rows = await (executor as any)
        .select({ userId: userUsageOwners.userId })
        .from(userUsageOwners)
        .where(eq(userUsageOwners.deliveryAdminId, deliveryAdminId))
        .orderBy(asc(userUsageOwners.userId))
        .for("update");
      return rows.map((row: { userId: number }) => row.userId);
    },
    updateAccessLevel: async (executor, userId, adminAccessLevel) => {
      await (executor as any)
        .update(users)
        .set({ adminAccessLevel })
        .where(eq(users.id, userId));
    },
  };
}

export async function setManagedAdminAccessLevel(
  input: {
    actor: AuthenticatedUser;
    targetUserId: number;
    adminAccessLevel: ManagedAdminAccessLevel;
    reason?: string;
  },
  dependencies: AdminAccessManagementDependencies = {},
) {
  // Fail before opening a transaction so delivery administrators cannot use
  // this service through a future route that forgets its own RBAC guard.
  if (!hasSystemAdminAccess(input.actor)) {
    throw new AuthServiceError(
      "INVALID_CREDENTIAL",
      "只有系统管理员可以调整管理员权限",
    );
  }

  const store = dependencies.store ?? (await defaultStore());
  const writeAudit =
    dependencies.writeAudit ??
    ((event, executor) => writeWorkspaceAuditEvent(event, executor));

  return store.transaction(async (executor) => {
    // Lock every administrator in a stable order. Two concurrent demotions
    // therefore cannot both observe another system administrator and remove
    // the final active system-level account.
    const administrators = await store.listAdministratorsForUpdate(executor);
    const transition = assertAdminAccessLevelTransition({
      actor: input.actor,
      targetUserId: input.targetUserId,
      nextAccessLevel: input.adminAccessLevel,
      administrators,
    });

    const user = {
      id: transition.target.id,
      username: transition.target.username ?? `legacy-${transition.target.id}`,
      displayName:
        transition.target.displayName ??
        transition.target.username ??
        `管理员 ${transition.target.id}`,
      role: "admin" as const,
      adminAccessLevel: input.adminAccessLevel,
      isActive: transition.target.isActive,
    };

    if (!transition.changed) {
      return { changed: false as const, user };
    }

    await store.updateAccessLevel(
      executor,
      transition.target.id,
      input.adminAccessLevel,
    );
    await writeAudit(
      {
        actor: input.actor,
        action: "account.admin_access_level_updated",
        targetType: "user",
        targetId: transition.target.id,
        reason: input.reason,
        metadata: {
          username: user.username,
          previousAdminAccessLevel: transition.previousAccessLevel,
          adminAccessLevel: input.adminAccessLevel,
        },
      },
      executor,
    );

    return { changed: true as const, user };
  });
}
