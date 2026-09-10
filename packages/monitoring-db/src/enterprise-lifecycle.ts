import { monitoringEnterpriseBusinessWriteGuard } from "./enterprise-scope.js";
import { sql } from "drizzle-orm";
import { RepositoryError } from "./repository-error.js";

/** Existing Dashboard projection; standalone account-level monitoring skips it. */
export async function assertMonitoringEnterpriseProjectActive(
  tx: { execute: (query: ReturnType<typeof sql>) => Promise<unknown> },
  enterpriseProjectId: string | null | undefined,
  ownerId: string,
) {
  if (!enterpriseProjectId) return;
  await monitoringEnterpriseBusinessWriteGuard()?.(tx);
  const [rows] = await tx.execute(sql`
    SELECT ep.id, ep.archivedAt FROM enterprise_projects ep
    INNER JOIN monitoring_account_links al ON al.dashboardUserId = ep.ownerUserId
    WHERE ep.id = ${enterpriseProjectId} AND al.monitoringUserId = ${ownerId}
    FOR UPDATE
  `) as unknown as [Array<{ id: string; archivedAt: Date | null }>];
  if (!rows[0] || rows[0].archivedAt)
    throw new RepositoryError("NOT_FOUND", "企业项目不存在或已删除");
}
