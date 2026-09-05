import { and, count, eq, inArray } from "drizzle-orm";

import {
  deliveryTickets,
  serviceContracts,
  serviceQuotaPeriods,
} from "../drizzle/schema";
import type {
  AdjustDeliveryTicketQuotaInput,
  DeliveryTicketQuotaPool,
} from "../shared/delivery-ticket";
import type { AuthenticatedUser } from "./auth-service";
import { writeWorkspaceAuditEvent } from "./admin-control-plane-service";
import { isSystemAdmin } from "./dashboard-service";
import { getDb } from "./db";
import { DeliveryTicketError } from "./delivery-ticket-service";
import { getServicePortal } from "./service-entitlement";

export type DeliveryQuotaPoolUsage = {
  reserved: number;
  consumed: number;
  used: number;
};

export type DeliveryQuotaAdjustment = {
  contentAssetPublishLimit: number;
  websiteContentPublishLimit: number;
  revision: number;
};

export function validateDeliveryQuotaAdjustment(input: {
  expectedRevision: number;
  currentRevision: number;
  contentAssetPublishLimit: number;
  websiteContentPublishLimit: number;
  contentAssetUsage: DeliveryQuotaPoolUsage;
  websiteContentUsage: DeliveryQuotaPoolUsage;
}): DeliveryQuotaAdjustment {
  if (input.expectedRevision !== input.currentRevision) {
    throw new DeliveryTicketError(
      "QUOTA_PERIOD_REVISION_CONFLICT",
      "服务周期额度已被其他管理员更新，请刷新后重试。",
    );
  }
  if (input.contentAssetPublishLimit < input.contentAssetUsage.used) {
    throw new DeliveryTicketError(
      "CONTENT_ASSET_QUOTA_BELOW_ACTIVE_USAGE",
      `内容资产发布额度不能低于当前已消耗与已预留数量 ${input.contentAssetUsage.used}。`,
    );
  }
  if (input.websiteContentPublishLimit < input.websiteContentUsage.used) {
    throw new DeliveryTicketError(
      "WEBSITE_CONTENT_QUOTA_BELOW_ACTIVE_USAGE",
      `官网内容发布额度不能低于当前已消耗与已预留数量 ${input.websiteContentUsage.used}。`,
    );
  }
  return {
    contentAssetPublishLimit: input.contentAssetPublishLimit,
    websiteContentPublishLimit: input.websiteContentPublishLimit,
    revision: input.currentRevision + 1,
  };
}

function usageByPool(
  rows: Array<{
    quotaPool: DeliveryTicketQuotaPool | null;
    quotaState: "reserved" | "consumed" | "released";
    value: number | bigint;
  }>,
  pool: DeliveryTicketQuotaPool,
  archivedConsumed = 0,
): DeliveryQuotaPoolUsage {
  const reserved = rows
    .filter((row) => row.quotaPool === pool && row.quotaState === "reserved")
    .reduce((sum, row) => sum + Number(row.value), 0);
  const consumed =
    rows
      .filter((row) => row.quotaPool === pool && row.quotaState === "consumed")
      .reduce((sum, row) => sum + Number(row.value), 0) + archivedConsumed;
  return { reserved, consumed, used: reserved + consumed };
}

function quotaDto(input: {
  pool: DeliveryTicketQuotaPool;
  periodId: string;
  revision: number;
  limit: number;
  usage: DeliveryQuotaPoolUsage;
}) {
  return {
    type: input.pool,
    periodId: input.periodId,
    revision: input.revision,
    limit: input.limit,
    reserved: input.usage.reserved,
    consumed: input.usage.consumed,
    used: input.usage.used,
    remaining: Math.max(0, input.limit - input.usage.used),
  };
}

type QuotaAdjustmentDependencies = {
  getPortal?: typeof getServicePortal;
  getDatabase?: typeof getDb;
  writeAudit?: typeof writeWorkspaceAuditEvent;
  now?: () => Date;
};

export async function adjustDeliveryTicketQuota(input: {
  actor: AuthenticatedUser;
  value: AdjustDeliveryTicketQuotaInput;
  dependencies?: QuotaAdjustmentDependencies;
}) {
  if (!isSystemAdmin(input.actor)) {
    throw new DeliveryTicketError(
      "SYSTEM_ADMIN_REQUIRED",
      "只有系统管理员可以调整服务周期额度。",
      403,
    );
  }

  const getPortal = input.dependencies?.getPortal ?? getServicePortal;
  const portal = await getPortal(input.value.userId);
  if (
    portal.service.status !== "active" ||
    (portal.service.planCode !== "advanced" &&
      portal.service.planCode !== "luxury")
  ) {
    throw new DeliveryTicketError(
      "QUOTA_ADJUSTMENT_NOT_ALLOWED",
      "只有服务中的进阶版或豪华版可以调整发布额度。",
      403,
    );
  }
  if (
    !portal.service.contractId ||
    !portal.quotas ||
    portal.quotas.periodId !== input.value.quotaPeriodId
  ) {
    throw new DeliveryTicketError(
      "QUOTA_PERIOD_NOT_CURRENT",
      "所选额度周期不是该用户的当前服务周期，请刷新后重试。",
    );
  }

  const getDatabase = input.dependencies?.getDatabase ?? getDb;
  const db = await getDatabase();
  if (!db) {
    throw new DeliveryTicketError(
      "DATABASE_UNAVAILABLE",
      "数据库暂时不可用。",
      503,
    );
  }
  const audit = input.dependencies?.writeAudit ?? writeWorkspaceAuditEvent;
  const now = input.dependencies?.now?.() ?? new Date();

  return db.transaction(async (tx) => {
    const periodRows = await tx
      .select()
      .from(serviceQuotaPeriods)
      .where(
        and(
          eq(serviceQuotaPeriods.id, input.value.quotaPeriodId),
          eq(serviceQuotaPeriods.userId, input.value.userId),
          eq(serviceQuotaPeriods.contractId, portal.service.contractId!),
        ),
      )
      .limit(1)
      .for("update");
    const period = periodRows[0];
    if (!period) {
      throw new DeliveryTicketError(
        "QUOTA_PERIOD_NOT_FOUND",
        "当前服务周期已变化，请刷新后重试。",
        404,
      );
    }

    const contractRows = await tx
      .select()
      .from(serviceContracts)
      .where(
        and(
          eq(serviceContracts.id, period.contractId),
          eq(serviceContracts.userId, input.value.userId),
        ),
      )
      .limit(1)
      .for("update");
    const contract = contractRows[0];
    const contractIsCurrent =
      contract?.status === "active" &&
      (contract.planCode === "advanced" || contract.planCode === "luxury") &&
      contract.startsAt.getTime() <= now.getTime() &&
      contract.endsAt.getTime() > now.getTime() &&
      period.startsAt.getTime() <= now.getTime() &&
      period.endsAt.getTime() > now.getTime();
    if (!contractIsCurrent) {
      throw new DeliveryTicketError(
        "QUOTA_PERIOD_NOT_CURRENT",
        "该额度周期已结束或所属套餐不可调整，请刷新后重试。",
      );
    }

    const activeRows = (await tx
      .select({
        quotaPool: deliveryTickets.quotaPool,
        quotaState: deliveryTickets.quotaState,
        value: count(),
      })
      .from(deliveryTickets)
      .where(
        and(
          eq(deliveryTickets.userId, input.value.userId),
          eq(deliveryTickets.quotaPeriodId, period.id),
          inArray(deliveryTickets.quotaState, ["reserved", "consumed"]),
        ),
      )
      .groupBy(
        deliveryTickets.quotaPool,
        deliveryTickets.quotaState,
      )) as Array<{
      quotaPool: DeliveryTicketQuotaPool | null;
      quotaState: "reserved" | "consumed" | "released";
      value: number | bigint;
    }>;
    const contentAssetUsage = usageByPool(
      activeRows,
      "content_asset_publish",
      period.archivedContentAssetPublishUsed,
    );
    const websiteContentUsage = usageByPool(
      activeRows,
      "website_content_publish",
      period.archivedWebsiteContentPublishUsed,
    );
    const next = validateDeliveryQuotaAdjustment({
      expectedRevision: input.value.expectedRevision,
      currentRevision: period.revision,
      contentAssetPublishLimit: input.value.contentAssetPublishLimit,
      websiteContentPublishLimit: input.value.websiteContentPublishLimit,
      contentAssetUsage,
      websiteContentUsage,
    });

    await tx
      .update(serviceQuotaPeriods)
      .set({
        contentAssetPublishLimit: next.contentAssetPublishLimit,
        websiteContentPublishLimit: next.websiteContentPublishLimit,
        revision: next.revision,
        updatedAt: now,
      })
      .where(
        and(
          eq(serviceQuotaPeriods.id, period.id),
          eq(serviceQuotaPeriods.revision, period.revision),
        ),
      );

    await audit(
      {
        actor: input.actor,
        action: "service_quota_period.delivery_limits_adjusted",
        targetType: "service_quota_period",
        targetId: period.id,
        workspaceUserId: input.value.userId,
        reason: input.value.reason,
        metadata: {
          contractId: period.contractId,
          planCode: contract.planCode,
          previousRevision: period.revision,
          revision: next.revision,
          previousLimits: {
            contentAssetPublishLimit: period.contentAssetPublishLimit,
            websiteContentPublishLimit: period.websiteContentPublishLimit,
          },
          limits: {
            contentAssetPublishLimit: next.contentAssetPublishLimit,
            websiteContentPublishLimit: next.websiteContentPublishLimit,
          },
          activeUsage: {
            contentAssetPublish: contentAssetUsage,
            websiteContentPublish: websiteContentUsage,
          },
        },
      },
      tx,
    );

    const contentAssetPublish = quotaDto({
      pool: "content_asset_publish",
      periodId: period.id,
      revision: next.revision,
      limit: next.contentAssetPublishLimit,
      usage: contentAssetUsage,
    });
    const websiteContentPublish = quotaDto({
      pool: "website_content_publish",
      periodId: period.id,
      revision: next.revision,
      limit: next.websiteContentPublishLimit,
      usage: websiteContentUsage,
    });
    return {
      success: true,
      periodId: period.id,
      revision: next.revision,
      contentAssetPublishLimit: next.contentAssetPublishLimit,
      websiteContentPublishLimit: next.websiteContentPublishLimit,
      quotas: {
        contentAssetPublish,
        websiteContentPublish,
      },
    };
  });
}
