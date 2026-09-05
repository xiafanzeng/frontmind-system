import { describe, expect, it } from "vitest";

import type { ServicePortal } from "../../shared/service-portal";
import { unifiedActiveQuotaCountsByPeriod } from "../delivery-quota-usage";
import {
  assertSiteOpsServiceEntitlement,
  selectSiteOpsQuotaPeriod,
  siteOpsQuotaStateForProviderResult,
} from "./quota-service";

function portal(input: {
  status: ServicePortal["service"]["status"];
  planCode: ServicePortal["service"]["planCode"];
  mode?: "compatibility" | "enforced";
}) {
  return {
    service: {
      status: input.status,
      planCode: input.planCode,
    },
    entitlementRollout: {
      mode: input.mode ?? "enforced",
      pendingUserCount: 0,
    },
  } as ServicePortal;
}

function quotaPeriod(input: {
  id: string;
  content?: number;
  website?: number;
  archivedContent?: number;
  archivedWebsite?: number;
}) {
  return {
    id: input.id,
    contentAssetPublishLimit: input.content ?? 0,
    websiteContentPublishLimit: input.website ?? 0,
    archivedContentAssetPublishUsed: input.archivedContent ?? 0,
    archivedWebsiteContentPublishUsed: input.archivedWebsite ?? 0,
  } as never;
}

describe("SiteOps shared delivery quota", () => {
  it("enforces Advanced/Luxury entitlement while preserving rollout compatibility", () => {
    expect(
      assertSiteOpsServiceEntitlement(
        portal({ status: "active", planCode: "advanced" }),
      ),
    ).toBeTruthy();
    expect(
      assertSiteOpsServiceEntitlement(
        portal({
          status: "unconfigured",
          planCode: null,
          mode: "compatibility",
        }),
      ),
    ).toBeTruthy();
    expect(() =>
      assertSiteOpsServiceEntitlement(
        portal({ status: "active", planCode: "basic" }),
      ),
    ).toThrow("当前服务版本不包含AI友好官网管理");
    expect(() =>
      assertSiteOpsServiceEntitlement(
        portal({ status: "expired", planCode: "luxury" }),
      ),
    ).toThrow("当前AI友好官网管理已到期");
  });

  it("counts delivery tickets, website revisions and social packages together", () => {
    const rows = [
      {
        quotaPeriodId: "period-1",
        quotaPool: "content_asset_publish" as const,
        quotaState: "consumed" as const,
        value: 1,
      },
      {
        quotaPeriodId: "period-1",
        quotaPool: "content_asset_publish" as const,
        quotaState: "reserved" as const,
        value: 2,
      },
      {
        quotaPeriodId: "period-1",
        quotaPool: "website_content_publish" as const,
        quotaState: "reserved" as const,
        value: 4,
      },
    ];
    expect(
      unifiedActiveQuotaCountsByPeriod({
        rows,
        quotaPool: "content_asset_publish",
      }),
    ).toEqual(new Map([["period-1", 3]]));
    expect(
      unifiedActiveQuotaCountsByPeriod({
        rows,
        quotaPool: "website_content_publish",
      }),
    ).toEqual(new Map([["period-1", 4]]));
  });

  it("cannot allocate the same final slot after a concurrent reservation", () => {
    const period = quotaPeriod({ id: "period-1", website: 1 });
    expect(
      selectSiteOpsQuotaPeriod({
        periods: [period],
        quotaPool: "website_content_publish",
        activeCounts: new Map(),
      }),
    ).toBe(period);
    expect(
      selectSiteOpsQuotaPeriod({
        periods: [period],
        quotaPool: "website_content_publish",
        activeCounts: new Map([["period-1", 1]]),
      }),
    ).toBeNull();
  });

  it("consumes success, releases a known failure and retains uncertain reservations", () => {
    expect(siteOpsQuotaStateForProviderResult("succeeded")).toBe("consumed");
    expect(siteOpsQuotaStateForProviderResult("failed")).toBe("released");
    expect(siteOpsQuotaStateForProviderResult("attention_required")).toBe(
      "reserved",
    );
    expect(siteOpsQuotaStateForProviderResult("outcome_unknown")).toBe(
      "reserved",
    );
    expect(siteOpsQuotaStateForProviderResult("pending")).toBe("reserved");
  });
});
