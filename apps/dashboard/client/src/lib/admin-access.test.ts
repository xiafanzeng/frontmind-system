import { describe, expect, it } from "vitest";

import type { AuthUser } from "@/_core/hooks/useAuth";
import {
  hasDeliveryCapability,
  isDeliveryAdminAccount,
  isProtectedBuiltinAdminUsername,
  isSystemAdminAccount,
} from "./admin-access";

function admin(
  adminAccessLevel: AuthUser["adminAccessLevel"],
  username = "admin",
): AuthUser {
  return {
    id: 1,
    username,
    displayName: "管理员",
    role: "admin",
    adminAccessLevel,
    isActive: true,
  };
}

describe("client administrator access", () => {
  it("grants system access only from the explicit access level", () => {
    expect(isSystemAdminAccount(admin("system_admin", "not-admin"))).toBe(true);
    expect(isSystemAdminAccount(admin("delivery_admin", "admin"))).toBe(false);
    expect(isSystemAdminAccount(admin(null, "admin"))).toBe(false);
  });

  it("does not reinterpret a missing level as delivery access", () => {
    expect(isDeliveryAdminAccount(admin("delivery_admin"))).toBe(true);
    expect(isDeliveryAdminAccount(admin("system_admin"))).toBe(false);
    expect(isDeliveryAdminAccount(admin(null))).toBe(false);
  });

  it("treats system administrators as delivery-capable", () => {
    expect(hasDeliveryCapability(admin("delivery_admin"))).toBe(true);
    expect(hasDeliveryCapability(admin("system_admin"))).toBe(true);
    expect(hasDeliveryCapability(admin(null))).toBe(false);
  });

  it("protects only the normalized built-in admin username", () => {
    expect(isProtectedBuiltinAdminUsername(" admin ")).toBe(true);
    expect(isProtectedBuiltinAdminUsername("ＡＤＭＩＮ")).toBe(true);
    expect(isProtectedBuiltinAdminUsername("admin.backup")).toBe(false);
    expect(isProtectedBuiltinAdminUsername("system-admin")).toBe(false);
  });
});
