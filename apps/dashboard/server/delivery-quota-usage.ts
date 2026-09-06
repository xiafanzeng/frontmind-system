import { and, count, eq, inArray } from "drizzle-orm";

import {
  siteBuilds,
  socialPackages,
} from "../drizzle/schema";
import type { ContentQuotaPool } from "../shared/content-quota";

export type UnifiedDeliveryQuotaState =
  | "reserved"
  | "consumed"
  | "released";

export type UnifiedDeliveryQuotaUsageRow = {
  quotaPeriodId: string;
  quotaPool: ContentQuotaPool;
  quotaState: UnifiedDeliveryQuotaState;
  value: number | string | bigint;
};

/**
 * Counts actual website builds and social packages against their purchased
 * service quota pools.
 */
export async function loadUnifiedDeliveryQuotaUsageRows(
  executor: any,
  input: {
    userId: number;
    quotaPeriodIds: string[];
    states?: Array<"reserved" | "consumed">;
  },
): Promise<UnifiedDeliveryQuotaUsageRow[]> {
  const quotaPeriodIds = [...new Set(input.quotaPeriodIds)];
  if (!quotaPeriodIds.length) return [];
  const states = input.states ?? ["reserved", "consumed"];

  const buildRows = await executor
    .select({
      quotaPeriodId: siteBuilds.quotaPeriodId,
      quotaState: siteBuilds.quotaState,
      value: count(),
    })
    .from(siteBuilds)
    .where(
      and(
        eq(siteBuilds.userId, input.userId),
        inArray(siteBuilds.quotaPeriodId, quotaPeriodIds),
        inArray(siteBuilds.quotaState, states),
      ),
    )
    .groupBy(siteBuilds.quotaPeriodId, siteBuilds.quotaState);

  const packageRows = await executor
    .select({
      quotaPeriodId: socialPackages.quotaPeriodId,
      quotaState: socialPackages.quotaState,
      value: count(),
    })
    .from(socialPackages)
    .where(
      and(
        eq(socialPackages.userId, input.userId),
        inArray(socialPackages.quotaPeriodId, quotaPeriodIds),
        inArray(socialPackages.quotaState, states),
      ),
    )
    .groupBy(socialPackages.quotaPeriodId, socialPackages.quotaState);

  return [
    ...buildRows.flatMap((row: any) =>
      row.quotaPeriodId && row.quotaState
        ? [
            {
              quotaPeriodId: String(row.quotaPeriodId),
              quotaPool: "website_content_publish" as const,
              quotaState: row.quotaState as UnifiedDeliveryQuotaState,
              value: row.value,
            },
          ]
        : [],
    ),
    ...packageRows.flatMap((row: any) =>
      row.quotaPeriodId && row.quotaState
        ? [
            {
              quotaPeriodId: String(row.quotaPeriodId),
              quotaPool: "content_asset_publish" as const,
              quotaState: row.quotaState as UnifiedDeliveryQuotaState,
              value: row.value,
            },
          ]
        : [],
    ),
  ];
}

export function unifiedActiveQuotaCountsByPeriod(input: {
  rows: UnifiedDeliveryQuotaUsageRow[];
  quotaPool: ContentQuotaPool;
}) {
  const counts = new Map<string, number>();
  for (const row of input.rows) {
    if (
      row.quotaPool !== input.quotaPool ||
      (row.quotaState !== "reserved" && row.quotaState !== "consumed")
    ) {
      continue;
    }
    counts.set(
      row.quotaPeriodId,
      (counts.get(row.quotaPeriodId) ?? 0) + Number(row.value),
    );
  }
  return counts;
}
