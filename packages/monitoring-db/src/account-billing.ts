import { sql } from "drizzle-orm";
import type { Database } from "./client.js";
export type ConsumptionSource = "monitoring" | "media_publishing" | "ai";
export type AccountConsumption = Record<
  ConsumptionSource,
  { totalTenThousandths: string; last30DaysTenThousandths: string }
>;
export async function readAccountConsumption(
  db: Database,
  userId: string,
): Promise<AccountConsumption> {
  const [rows] = (await db.execute(sql`
    SELECT 'monitoring' AS source, COALESCE(SUM(-balance_delta_ten_thousandths),0) AS total,
      COALESCE(SUM(IF(created_at >= UTC_TIMESTAMP() - INTERVAL 30 DAY,-balance_delta_ten_thousandths,0)),0) AS recent
      FROM money_ledger WHERE user_id=${userId} AND type='consume'
    UNION ALL SELECT 'media_publishing',COALESCE(SUM(-balance_delta_ten_thousandths),0),
      COALESCE(SUM(IF(created_at >= UTC_TIMESTAMP() - INTERVAL 30 DAY,-balance_delta_ten_thousandths,0)),0)
      FROM media_publishing_ledger WHERE owner_id=${userId} AND type='consume'
    UNION ALL SELECT 'ai',COALESCE(SUM(-balance_delta_ten_thousandths),0),
      COALESCE(SUM(IF(created_at >= UTC_TIMESTAMP() - INTERVAL 30 DAY,-balance_delta_ten_thousandths,0)),0)
      FROM ai_wallet_ledger WHERE user_id=${userId} AND type='consume'
  `)) as unknown as [
    Array<{ source: ConsumptionSource; total: string; recent: string }>,
  ];
  return Object.fromEntries(
    rows.map((row) => [
      row.source,
      {
        totalTenThousandths: String(row.total),
        last30DaysTenThousandths: String(row.recent),
      },
    ]),
  ) as AccountConsumption;
}
export async function readAccountActivity(
  db: Database,
  userId: string,
  input: { limit?: number; source?: ConsumptionSource } = {},
) {
  const limit = Math.max(1, Math.min(500, input.limit ?? 100));
  const [rows] = (await db.execute(sql`
    SELECT * FROM (
      SELECT id,'monitoring' AS source,type,balance_delta_ten_thousandths AS balanceDeltaTenThousandths,
       reserved_delta_ten_thousandths AS reservedDeltaTenThousandths,0 AS frozenDeltaTenThousandths,
       balance_after_ten_thousandths AS balanceAfterTenThousandths,reason,reference_type AS referenceType,reference_id AS referenceId,created_at AS createdAt
       FROM money_ledger WHERE user_id=${userId}
      UNION ALL SELECT id,'media_publishing',type,balance_delta_ten_thousandths,reserved_delta_ten_thousandths,frozen_delta_ten_thousandths,
       balance_after_ten_thousandths,reason,reference_type,reference_id,created_at FROM media_publishing_ledger WHERE owner_id=${userId}
      UNION ALL SELECT id,'ai',type,balance_delta_ten_thousandths,reserved_delta_ten_thousandths,0,
       balance_after_ten_thousandths,reason,'ai_command',command_id,created_at FROM ai_wallet_ledger WHERE user_id=${userId}
    ) activity ${input.source ? sql`WHERE source=${input.source} AND type='consume'` : sql``} ORDER BY createdAt DESC,id DESC LIMIT ${limit}
  `)) as unknown as [Array<Record<string, unknown>>];
  return rows.map((row) => ({
    id: String(row.id),
    source: row.source as ConsumptionSource,
    type: String(row.type),
    balanceDeltaTenThousandths: String(row.balanceDeltaTenThousandths),
    reservedDeltaTenThousandths: String(row.reservedDeltaTenThousandths),
    frozenDeltaTenThousandths: String(row.frozenDeltaTenThousandths),
    balanceAfterTenThousandths: String(row.balanceAfterTenThousandths),
    reason: String(row.reason),
    referenceType:
      row.referenceType === null ? null : String(row.referenceType),
    referenceId: row.referenceId === null ? null : String(row.referenceId),
    createdAt:
      row.createdAt instanceof Date
        ? row.createdAt
        : new Date(String(row.createdAt)),
  }));
}
