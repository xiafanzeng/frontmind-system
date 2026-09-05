import { describe, expect, it } from "vitest";

import type { TrpcContext } from "./_core/context";
import { adminRouter, adminUpdateServiceSchema } from "./admin-router";
import type { AuthenticatedUser } from "./auth-service";

const validInternalServiceUpdate = {
  userId: 7,
  expectedRevision: 1,
  planCode: "advanced" as const,
  status: "active" as const,
  prepaidMonths: 3,
  signedAt: Date.now(),
  signatoryId: "enterprise-legal-entity",
  signingEvidence: { verifiedBy: "system-admin" },
};

function systemAdminContext(): TrpcContext {
  const now = new Date("2026-07-28T08:00:00.000Z");
  const user: AuthenticatedUser = {
    id: 1,
    openId: null,
    username: "system.admin",
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
  };
  return {
    user,
    req: {} as TrpcContext["req"],
    res: {} as TrpcContext["res"],
  };
}

describe("admin service contract input", () => {
  it("keeps internal signing evidence without requiring a fixed amount", () => {
    expect(adminUpdateServiceSchema.parse(validInternalServiceUpdate)).toEqual(
      validInternalServiceUpdate,
    );
  });

  it.each([
    ["amountFen", 2_980_000],
    ["currency", "CNY"],
  ])("rejects legacy commercial input %s on new updates", (field, value) => {
    expect(
      adminUpdateServiceSchema.safeParse({
        ...validInternalServiceUpdate,
        [field]: value,
      }).success,
    ).toBe(false);
  });

  it.each(["active", "scheduled"] as const)(
    "rejects %s activation before the signatory and signing time are complete",
    async (status) => {
      const caller = adminRouter.createCaller(systemAdminContext());
      await expect(
        caller.workspace.updateService({
          userId: 7,
          expectedRevision: 1,
          planCode: "advanced",
          status,
          prepaidMonths: 3,
        }),
      ).rejects.toMatchObject({
        code: "BAD_REQUEST",
        message: "生效或待生效合同必须包含签署主体与签署时间",
      });
    },
  );

  it("allows activation without a separate signing or payment evidence field", () => {
    expect(
      adminUpdateServiceSchema.safeParse({
        userId: 7,
        expectedRevision: 1,
        planCode: "advanced",
        status: "active",
        prepaidMonths: 3,
        signedAt: Date.now(),
        signatoryId: "enterprise-legal-entity",
      }).success,
    ).toBe(true);
  });
});
