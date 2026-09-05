import { describe, expect, it } from "vitest";

import type { AuthenticatedUser } from "./auth-service";
import { assertManagedCredentialMutationAccess } from "./dashboard-service";

function actor(
  id: number,
  adminAccessLevel: "system_admin" | "delivery_admin",
): Pick<AuthenticatedUser, "id" | "role" | "username" | "adminAccessLevel"> {
  return {
    id,
    role: "admin",
    username: `admin-${id}`,
    adminAccessLevel,
  };
}

describe("managed customer credential authorization", () => {
  it("allows a system administrator regardless of the current owner", () => {
    expect(() =>
      assertManagedCredentialMutationAccess(actor(1, "system_admin"), 42),
    ).not.toThrow();
    expect(() =>
      assertManagedCredentialMutationAccess(actor(1, "system_admin"), null),
    ).not.toThrow();
  });

  it("never grants customer Key mutation access to delivery administrators", () => {
    expect(() =>
      assertManagedCredentialMutationAccess(actor(42, "delivery_admin"), 42),
    ).toThrow(/仅由系统管理员/);
    expect(() =>
      assertManagedCredentialMutationAccess(actor(43, "delivery_admin"), 42),
    ).toThrow(/仅由系统管理员/);
    expect(() =>
      assertManagedCredentialMutationAccess(actor(43, "delivery_admin"), null),
    ).toThrow(/仅由系统管理员/);
  });
});
