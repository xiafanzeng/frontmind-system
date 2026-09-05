import { describe, expect, it } from "vitest";

import {
  assertDeliveryMemberCredentialVersion,
  decideEngineerCredentialManagementScope,
} from "./delivery-role-service";

describe("delivery engineer credential management scope", () => {
  const decide = (
    assignmentAdminIds: Array<number | null>,
    createdByAdminId: number | null = null,
    systemAdmin = false,
  ) =>
    decideEngineerCredentialManagementScope({
      systemAdmin,
      actorUserId: 10,
      assignmentAdminIds,
      createdByAdminId,
    });

  it("keeps engineer Key management away from delivery administrators", () => {
    expect(decide([10, 10])).toMatchObject({
      manageable: false,
      reason: expect.stringContaining("仅由系统管理员"),
      managerAdminIds: [10],
    });
  });

  it("applies the same system-only rule to shared or unowned portfolios", () => {
    expect(decide([20])).toMatchObject({
      manageable: false,
      reason: expect.stringContaining("仅由系统管理员"),
    });
    expect(decide([10, 20])).toMatchObject({
      manageable: false,
      reason: expect.stringContaining("仅由系统管理员"),
    });
    expect(decide([10, null])).toMatchObject({
      manageable: false,
      reason: expect.stringContaining("仅由系统管理员"),
    });
  });

  it("does not grant Key management based on account creation origin", () => {
    expect(decide([], 10)).toMatchObject({ manageable: false });
    expect(decide([], 20)).toMatchObject({ manageable: false });
  });

  it("allows a system administrator across all scopes", () => {
    expect(decide([10, 20, null], null, true)).toMatchObject({
      manageable: true,
      managerAdminIds: [10, 20],
    });
  });

  it("rejects a stale concurrent credential version", () => {
    expect(() =>
      assertDeliveryMemberCredentialVersion({
        actualVersion: 4,
        expectedVersion: 3,
      }),
    ).toThrow("工程师 API Key 状态已变化，请刷新后重试");
    expect(() =>
      assertDeliveryMemberCredentialVersion({
        actualVersion: 4,
        expectedVersion: 4,
      }),
    ).not.toThrow();
  });
});
