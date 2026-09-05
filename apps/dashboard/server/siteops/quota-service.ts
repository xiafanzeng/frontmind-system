import { and, asc, eq, inArray } from "drizzle-orm";

import { serviceQuotaPeriods } from "../../drizzle/schema";
import type { DeliveryTicketQuotaPool } from "../../shared/delivery-ticket";
import type { ServicePortal } from "../../shared/service-portal";
import { SITEOPS_CUSTOMER_DISPLAY_NAME } from "../../shared/siteops-branding";
import {
  loadUnifiedDeliveryQuotaUsageRows,
  unifiedActiveQuotaCountsByPeriod,
} from "../delivery-quota-usage";

export type SiteOpsQuotaState = "reserved" | "consumed" | "released";

export class SiteOpsQuotaError extends Error {
  constructor(
    public readonly code:
      | "SITEOPS_ENTITLEMENT_REQUIRED"
      | "SITEOPS_QUOTA_PERIOD_NOT_FOUND"
      | "SITEOPS_QUOTA_EXHAUSTED",
    message: string,
    public readonly statusCode: 403 | 409,
  ) {
    super(message);
    this.name = "SiteOpsQuotaError";
  }
}

/**
 * SiteOps is the AI-friendly website capability: signed Advanced/Luxury
 * service is eligible. During the existing entitlement compatibility window,
 * already-onboarded legacy customers remain usable rather than being cut off
 * before their historical service contract has been imported.
 */
export function assertSiteOpsServiceEntitlement(portal: ServicePortal) {
  if (
    portal.service.status === "unconfigured" &&
    portal.entitlementRollout.mode === "compatibility"
  ) {
    return portal;
  }
  if (
    portal.service.status === "active" &&
    (portal.service.planCode === "advanced" ||
      portal.service.planCode === "luxury")
  ) {
    return portal;
  }
  throw new SiteOpsQuotaError(
    "SITEOPS_ENTITLEMENT_REQUIRED",
    portal.service.status === "expired" ||
      portal.service.status === "cancelled"
      ? `当前${SITEOPS_CUSTOMER_DISPLAY_NAME}已到期，请续费后继续使用。`
      : `当前服务版本不包含${SITEOPS_CUSTOMER_DISPLAY_NAME}，请升级进阶版或豪华版。`,
    403,
  );
}

export function siteOpsQuotaPeriodIds(
  portal: ServicePortal,
  _quotaPool: DeliveryTicketQuotaPool,
) {
  assertSiteOpsServiceEntitlement(portal);
  const periodIds = [
    ...new Set(
      [
        ...(portal.quotaPeriods ?? []).map((period) => period.periodId),
        ...(portal.quotas &&
        !portal.quotas.periodId.startsWith("basic-aggregate:")
          ? [portal.quotas.periodId]
          : []),
      ].filter(Boolean),
    ),
  ];
  if (!portal.service.contractId || !periodIds.length) {
    throw new SiteOpsQuotaError(
      "SITEOPS_QUOTA_PERIOD_NOT_FOUND",
      "当前服务周期尚未建立，暂时不能创建新的交付内容。",
      409,
    );
  }
  return periodIds;
}

function archivedUsage(
  period: typeof serviceQuotaPeriods.$inferSelect,
  quotaPool: DeliveryTicketQuotaPool,
) {
  return Number(
    quotaPool === "content_asset_publish"
      ? period.archivedContentAssetPublishUsed
      : period.archivedWebsiteContentPublishUsed,
  );
}

export function selectSiteOpsQuotaPeriod(input: {
  periods: Array<typeof serviceQuotaPeriods.$inferSelect>;
  quotaPool: DeliveryTicketQuotaPool;
  activeCounts: ReadonlyMap<string, number>;
}) {
  return (
    input.periods.find((candidate) => {
      const limit =
        input.quotaPool === "content_asset_publish"
          ? candidate.contentAssetPublishLimit
          : candidate.websiteContentPublishLimit;
      return (
        (input.activeCounts.get(candidate.id) ?? 0) +
          archivedUsage(candidate, input.quotaPool) <
        limit
      );
    }) ?? null
  );
}

/**
 * Caller runs inside the same transaction that creates the immutable SiteOps
 * delivery row. Lock ordering matches delivery-ticket creation, so a ticket
 * and a SiteOps request cannot both allocate the final slot.
 */
export async function reserveSiteOpsQuota(
  tx: any,
  input: {
    userId: number;
    quotaPool: DeliveryTicketQuotaPool;
    quotaPeriodIds: string[];
  },
) {
  const lockedPeriods = await tx
    .select()
    .from(serviceQuotaPeriods)
    .where(
      and(
        eq(serviceQuotaPeriods.userId, input.userId),
        inArray(serviceQuotaPeriods.id, input.quotaPeriodIds),
      ),
    )
    .orderBy(asc(serviceQuotaPeriods.id))
    .for("update");
  if (!lockedPeriods.length) {
    throw new SiteOpsQuotaError(
      "SITEOPS_QUOTA_PERIOD_NOT_FOUND",
      "当前服务周期已变化，请刷新后重试。",
      409,
    );
  }
  const periods = [...lockedPeriods].sort(
    (left, right) =>
      left.endsAt.getTime() - right.endsAt.getTime() ||
      left.startsAt.getTime() - right.startsAt.getTime() ||
      left.id.localeCompare(right.id),
  );
  const usageRows = await loadUnifiedDeliveryQuotaUsageRows(tx, {
    userId: input.userId,
    quotaPeriodIds: periods.map((period) => period.id),
  });
  const counts = unifiedActiveQuotaCountsByPeriod({
    rows: usageRows,
    quotaPool: input.quotaPool,
  });
  const period = selectSiteOpsQuotaPeriod({
    periods,
    quotaPool: input.quotaPool,
    activeCounts: counts,
  });
  if (!period) {
    throw new SiteOpsQuotaError(
      "SITEOPS_QUOTA_EXHAUSTED",
      input.quotaPool === "content_asset_publish"
        ? "本服务周期的内容资产发布额度已用完。"
        : "本服务周期的官网内容发布额度已用完。",
      409,
    );
  }
  return period.id;
}

export function siteOpsQuotaStateForProviderResult(
  status:
    | "pending"
    | "succeeded"
    | "failed"
    | "attention_required"
    | "outcome_unknown",
): SiteOpsQuotaState {
  if (status === "succeeded") return "consumed";
  if (status === "failed") return "released";
  return "reserved";
}
