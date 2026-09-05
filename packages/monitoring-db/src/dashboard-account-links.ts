import { createHash } from "node:crypto";
import { sql } from "drizzle-orm";
import type { Database } from "./client.js";

/** Dashboard owns login, status and roles. The UUID preserves monitoring FKs. */
export type DashboardAccountLink = {
  dashboardUserId: number;
  monitoringUserId: string;
};

export function dashboardMonitoringUserId(dashboardUserId: number): string {
  if (!Number.isSafeInteger(dashboardUserId) || dashboardUserId < 1) {
    throw new Error("Invalid Dashboard account id");
  }
  const bytes = createHash("sha256")
    .update(`frontmind-system:monitoring-user:v1:${dashboardUserId}`)
    .digest();
  bytes[6] = (bytes[6]! & 0x0f) | 0x50;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.subarray(0, 16).toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export async function ensureDashboardAccountLink(
  db: Database,
  dashboardUserId: number,
): Promise<DashboardAccountLink> {
  const deterministicId = dashboardMonitoringUserId(dashboardUserId);
  return db.transaction(async (tx) => {
    // Lock the canonical account, including the missing-link case. Parallel
    // requests cannot leave orphan projections or initialise two wallets.
    const [accounts] = (await tx.execute(sql`
      SELECT id, username, role, adminAccessLevel, isActive FROM users
      WHERE id = ${dashboardUserId} FOR UPDATE
    `)) as unknown as [Array<{
      id: number; username: string | null; role: string;
      adminAccessLevel: string | null; isActive: number;
    }>];
    const account = accounts[0];
    if (!account || !account.isActive) throw new Error("Dashboard account is inactive");
    const role = account.role === "admin" && account.adminAccessLevel === "system_admin"
      ? "admin" : "user";
    const [rows] = (await tx.execute(sql`
      SELECT dashboardUserId, monitoringUserId FROM monitoring_account_links
      WHERE dashboardUserId = ${dashboardUserId} LIMIT 1
    `)) as unknown as [DashboardAccountLink[]];
    const monitoringUserId = rows[0]?.monitoringUserId ?? deterministicId;
    // The username is a display projection only. Dashboard id remains the
    // identity, so a renamed account or pre-existing UUID keeps its history.
    const username = `${(account.username || "user").slice(0, 42)} [${dashboardUserId}]`;
    await tx.execute(sql`
      INSERT INTO monitoring_users
        (id, username, password_hash, role, status, session_version, password_changed_at)
      VALUES (${monitoringUserId}, ${username}, 'dashboard-session-only', ${role}, 'active', 1, UTC_TIMESTAMP(3))
      ON DUPLICATE KEY UPDATE username = VALUES(username), role = VALUES(role), status = 'active'
    `);
    if (!rows[0]) {
      await tx.execute(sql`
        INSERT INTO monitoring_account_links (dashboardUserId, monitoringUserId)
        VALUES (${dashboardUserId}, ${monitoringUserId})
      `);
    }
    // Never overwrite balances or issue complimentary quota while linking.
    await tx.execute(sql`INSERT IGNORE INTO money_wallets (user_id) VALUES (${monitoringUserId})`);
    await tx.execute(sql`INSERT IGNORE INTO quota_wallets (user_id) VALUES (${monitoringUserId})`);
    await tx.execute(sql`INSERT IGNORE INTO media_publishing_wallets (user_id) VALUES (${monitoringUserId})`);
    return { dashboardUserId, monitoringUserId };
  });
}

export async function findDashboardUserId(
  db: Database,
  monitoringUserId: string,
): Promise<number | null> {
  const [rows] = (await db.execute(sql`
    SELECT dashboardUserId FROM monitoring_account_links
    WHERE monitoringUserId = ${monitoringUserId} LIMIT 1
  `)) as unknown as [Array<{ dashboardUserId: number }>];
  return rows[0]?.dashboardUserId ?? null;
}

/** Provision zero-balance domain accounts for the unified administrator picker. */
export async function syncDashboardMonitoringAccounts(db: Database): Promise<void> {
  const [rows] = (await db.execute(sql`
    SELECT id FROM users WHERE isActive = true ORDER BY id
  `)) as unknown as [Array<{ id: number }>];
  for (const row of rows) await ensureDashboardAccountLink(db, row.id);
  await syncDashboardMonitoringAccountStates(db);
}

export async function syncDashboardMonitoringAccountStates(db: Database): Promise<void> {
  await db.execute(sql`
    UPDATE monitoring_users m
    LEFT JOIN monitoring_account_links l ON l.monitoringUserId = m.id
    LEFT JOIN users d ON d.id = l.dashboardUserId
    SET m.status = IF(d.id IS NOT NULL AND d.isActive = true, 'active', 'disabled'),
        m.role = IF(d.role = 'admin' AND d.adminAccessLevel = 'system_admin', 'admin', 'user')
  `);
}
