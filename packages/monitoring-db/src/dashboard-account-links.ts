import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import type { Database } from "./client.js";

/** Dashboard is the authentication authority; this table only projects a
 * stable UUID into monitoring domain rows that still use UUID foreign keys. */
export type DashboardAccountLink = {
  dashboardUserId: number;
  monitoringUserId: string;
};

export async function ensureDashboardAccountLink(
  db: Database,
  dashboardUserId: number,
): Promise<DashboardAccountLink> {
  const [rows] = (await db.execute(sql`
    SELECT dashboardUserId, monitoringUserId
    FROM monitoring_account_links
    WHERE dashboardUserId = ${dashboardUserId}
    LIMIT 1
  `)) as unknown as [Array<{ dashboardUserId: number; monitoringUserId: string }>];
  const row = rows[0];
  if (row) return row;

  const monitoringUserId = randomUUID();
  await db.execute(sql`
    INSERT INTO monitoring_users
      (id, username, password_hash, role, status, session_version, password_changed_at, created_at, updated_at)
    VALUES
      (${monitoringUserId}, ${`dashboard-${dashboardUserId}`}, ${randomUUID()}, 'user', 'active', 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
  `);
  await db.execute(sql`
    INSERT INTO monitoring_account_links
      (dashboardUserId, monitoringUserId, createdAt, updatedAt)
    VALUES
      (${dashboardUserId}, ${monitoringUserId}, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
  `);
  return { dashboardUserId, monitoringUserId };
}

export async function findDashboardUserId(
  db: Database,
  monitoringUserId: string,
): Promise<number | null> {
  const [rows] = (await db.execute(sql`
    SELECT dashboardUserId
    FROM monitoring_account_links
    WHERE monitoringUserId = ${monitoringUserId}
    LIMIT 1
  `)) as unknown as [Array<{ dashboardUserId: number }>];
  return rows[0]?.dashboardUserId ?? null;
}
