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
  return readAccountActivityRows(db, userId, { ...input, limit });
}

function activitySources(source?: ConsumptionSource) {
  return (["monitoring", "media_publishing", "ai"] as const).filter(
    (value) => !source || value === source,
  );
}

/** Customer presentation only; immutable ledger reasons remain available to administrators. */
export function customerAccountActivityReason(
  source: ConsumptionSource,
  type: string,
  reason: string,
) {
  if (source !== "ai") return reason;
  return (
    (
      {
        consume: "智能体用量结算",
        reserve: "智能体任务预留",
        release: "智能体未使用预留释放",
      } as Record<string, string>
    )[type] ?? reason
  );
}

async function readAccountActivityRows(
  db: Pick<Database, "execute">,
  userId: string,
  input: { limit: number; offset?: number; source?: ConsumptionSource },
) {
  const consumption = input.source ? sql`AND type='consume'` : sql``;
  const branches = {
    monitoring: sql`SELECT id,'monitoring' AS source,type,balance_delta_ten_thousandths AS balanceDeltaTenThousandths,
      reserved_delta_ten_thousandths AS reservedDeltaTenThousandths,0 AS frozenDeltaTenThousandths,
      balance_after_ten_thousandths AS balanceAfterTenThousandths,reason,reference_type AS referenceType,reference_id AS referenceId,created_at AS createdAt
      FROM money_ledger WHERE user_id=${userId} ${consumption}`,
    media_publishing: sql`SELECT id,'media_publishing' AS source,type,balance_delta_ten_thousandths AS balanceDeltaTenThousandths,
      reserved_delta_ten_thousandths AS reservedDeltaTenThousandths,frozen_delta_ten_thousandths AS frozenDeltaTenThousandths,
      balance_after_ten_thousandths AS balanceAfterTenThousandths,reason,reference_type AS referenceType,reference_id AS referenceId,created_at AS createdAt
      FROM media_publishing_ledger WHERE owner_id=${userId} ${consumption}`,
    ai: sql`SELECT id,'ai' AS source,type,balance_delta_ten_thousandths AS balanceDeltaTenThousandths,
      reserved_delta_ten_thousandths AS reservedDeltaTenThousandths,0 AS frozenDeltaTenThousandths,
      balance_after_ten_thousandths AS balanceAfterTenThousandths,reason,'ai_command' AS referenceType,command_id AS referenceId,created_at AS createdAt
      FROM ai_wallet_ledger WHERE user_id=${userId} ${consumption}`,
  };
  const [rows] = (await db.execute(sql`
    SELECT * FROM (${sql.join(
      activitySources(input.source).map((source) => branches[source]),
      sql` UNION ALL `,
    )}) activity
    ORDER BY createdAt DESC,id DESC,source DESC LIMIT ${input.limit} OFFSET ${input.offset ?? 0}
  `)) as unknown as [Array<Record<string, unknown>>];
  return rows.map((row) => ({
    id: String(row.id),
    source: row.source as ConsumptionSource,
    type: String(row.type),
    balanceDeltaTenThousandths: String(row.balanceDeltaTenThousandths),
    reservedDeltaTenThousandths: String(row.reservedDeltaTenThousandths),
    frozenDeltaTenThousandths: String(row.frozenDeltaTenThousandths),
    balanceAfterTenThousandths: String(row.balanceAfterTenThousandths),
    reason: customerAccountActivityReason(
      row.source as ConsumptionSource,
      String(row.type),
      String(row.reason),
    ),
    referenceType:
      row.referenceType === null ? null : String(row.referenceType),
    referenceId: row.referenceId === null ? null : String(row.referenceId),
    createdAt:
      row.createdAt instanceof Date
        ? row.createdAt
        : new Date(String(row.createdAt)),
  }));
}

export async function readAccountActivityPage(
  db: Database,
  userId: string,
  input: { page?: number; source?: ConsumptionSource } = {},
) {
  return db.transaction(async (tx) => {
    const consumption = input.source ? sql`AND type='consume'` : sql``;
    const counts = {
      monitoring: sql`SELECT COUNT(*) AS total FROM money_ledger WHERE user_id=${userId} ${consumption}`,
      media_publishing: sql`SELECT COUNT(*) AS total FROM media_publishing_ledger WHERE owner_id=${userId} ${consumption}`,
      ai: sql`SELECT COUNT(*) AS total FROM ai_wallet_ledger WHERE user_id=${userId} ${consumption}`,
    };
    const [rows] = (await tx.execute(sql`SELECT SUM(total) AS total FROM (
      ${sql.join(
        activitySources(input.source).map((source) => counts[source]),
        sql` UNION ALL `,
      )}
    ) counts`)) as unknown as [Array<{ total: string | number }>];
    const total = Number(rows[0]?.total ?? 0);
    const pageSize = 10 as const;
    const page = Math.min(
      Math.max(1, Math.floor(input.page ?? 1)),
      Math.max(1, Math.ceil(total / pageSize)),
    );
    const items = await readAccountActivityRows(tx, userId, {
      limit: pageSize,
      offset: (page - 1) * pageSize,
      source: input.source,
    });
    return { items, total, page, pageSize };
  });
}
