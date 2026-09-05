import { describe, expect, it, vi } from "vitest";

import { adjustDeliveryTicketQuotaSchema } from "../shared/delivery-ticket";
import type { AuthenticatedUser } from "./auth-service";
import {
  adjustDeliveryTicketQuota,
  validateDeliveryQuotaAdjustment,
} from "./delivery-ticket-quota-service";

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

const value = adjustDeliveryTicketQuotaSchema.parse({
  userId: 42,
  quotaPeriodId: "77f85ac6-9283-4e2d-a768-c7edec482659",
  expectedRevision: 3,
  contentAssetPublishLimit: 12,
  websiteContentPublishLimit: 48,
  reason: " 客户合同补充额度 ",
});

describe("delivery ticket quota adjustment contract", () => {
  it("requires a period, revision, bounded limits and an audit reason", () => {
    expect(value).toMatchObject({
      userId: 42,
      expectedRevision: 3,
      contentAssetPublishLimit: 12,
      websiteContentPublishLimit: 48,
      reason: "客户合同补充额度",
    });
    expect(() =>
      adjustDeliveryTicketQuotaSchema.parse({
        ...value,
        websiteContentPublishLimit: -1,
      }),
    ).toThrow();
    expect(() =>
      adjustDeliveryTicketQuotaSchema.parse({ ...value, reason: " " }),
    ).toThrow();
  });

  it("increments the revision only when neither limit drops below active usage", () => {
    expect(
      validateDeliveryQuotaAdjustment({
        expectedRevision: 3,
        currentRevision: 3,
        contentAssetPublishLimit: 6,
        websiteContentPublishLimit: 21,
        contentAssetUsage: { reserved: 1, consumed: 5, used: 6 },
        websiteContentUsage: { reserved: 2, consumed: 19, used: 21 },
      }),
    ).toEqual({
      contentAssetPublishLimit: 6,
      websiteContentPublishLimit: 21,
      revision: 4,
    });

    expect(() =>
      validateDeliveryQuotaAdjustment({
        expectedRevision: 3,
        currentRevision: 3,
        contentAssetPublishLimit: 5,
        websiteContentPublishLimit: 21,
        contentAssetUsage: { reserved: 1, consumed: 5, used: 6 },
        websiteContentUsage: { reserved: 2, consumed: 19, used: 21 },
      }),
    ).toThrow("不能低于当前已消耗与已预留数量 6");
    expect(() =>
      validateDeliveryQuotaAdjustment({
        expectedRevision: 2,
        currentRevision: 3,
        contentAssetPublishLimit: 6,
        websiteContentPublishLimit: 21,
        contentAssetUsage: { reserved: 1, consumed: 5, used: 6 },
        websiteContentUsage: { reserved: 2, consumed: 19, used: 21 },
      }),
    ).toThrow("已被其他管理员更新");
  });

  it("rejects delivery administrators before any service or database read", async () => {
    const getPortal = vi.fn();
    const getDatabase = vi.fn();

    await expect(
      adjustDeliveryTicketQuota({
        actor: actor("delivery_admin"),
        value,
        dependencies: { getPortal, getDatabase },
      }),
    ).rejects.toMatchObject({
      code: "SYSTEM_ADMIN_REQUIRED",
      statusCode: 403,
    });

    expect(getPortal).not.toHaveBeenCalled();
    expect(getDatabase).not.toHaveBeenCalled();
  });

  it("does not let a quota change unlock Basic or inactive service", async () => {
    const getDatabase = vi.fn();
    const basicPortal = vi.fn(async () => ({
      service: {
        status: "active",
        planCode: "basic",
        contractId: "contract-basic",
      },
      quotas: { periodId: value.quotaPeriodId },
    })) as any;

    await expect(
      adjustDeliveryTicketQuota({
        actor: actor("system_admin"),
        value,
        dependencies: { getPortal: basicPortal, getDatabase },
      }),
    ).rejects.toMatchObject({
      code: "QUOTA_ADJUSTMENT_NOT_ALLOWED",
      statusCode: 403,
    });
    expect(getDatabase).not.toHaveBeenCalled();
  });

  it("rejects a stale or historical period before opening a transaction", async () => {
    const getDatabase = vi.fn();
    const getPortal = vi.fn(async () => ({
      service: {
        status: "active",
        planCode: "luxury",
        contractId: "contract-luxury",
      },
      quotas: {
        periodId: "ad8bf39b-eedd-4652-b9c8-f765c86bb062",
      },
    })) as any;

    await expect(
      adjustDeliveryTicketQuota({
        actor: actor("system_admin"),
        value,
        dependencies: { getPortal, getDatabase },
      }),
    ).rejects.toMatchObject({ code: "QUOTA_PERIOD_NOT_CURRENT" });
    expect(getDatabase).not.toHaveBeenCalled();
  });
});
