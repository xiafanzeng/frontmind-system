export type AdminAccessLevel = "system_admin" | "delivery_admin";

export function isExplicitAdminAccessLevel(
  value: unknown,
): value is AdminAccessLevel {
  return value === "system_admin" || value === "delivery_admin";
}

export function hasExplicitAdminRole(user: {
  role: unknown;
  adminAccessLevel?: unknown;
}) {
  return (
    user.role === "admin" && isExplicitAdminAccessLevel(user.adminAccessLevel)
  );
}

/**
 * System administrators inherit every delivery-administrator capability.
 * Callers that need the narrower identity (for labels or navigation) should
 * still inspect `adminAccessLevel` directly.
 */
export function hasDeliveryCapability(user: {
  role: unknown;
  adminAccessLevel?: unknown;
}) {
  return (
    user.role === "admin" &&
    (user.adminAccessLevel === "delivery_admin" ||
      user.adminAccessLevel === "system_admin")
  );
}

export function isProtectedBuiltinAdminUsername(value: unknown): boolean {
  return (
    typeof value === "string" &&
    value.normalize("NFKC").trim().toLowerCase() === "admin"
  );
}
