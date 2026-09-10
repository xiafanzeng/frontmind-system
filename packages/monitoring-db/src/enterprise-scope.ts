import { AsyncLocalStorage } from "node:async_hooks";
import { and, eq, isNull, sql, type SQLWrapper } from "drizzle-orm";
import type { AnyMySqlColumn } from "drizzle-orm/mysql-core";
export type MonitoringEnterpriseScope = {
  enterpriseProjectId: string | null;
  ownerId: string;
  /** Dashboard admission callback; absent for the independent worker. */
  beforeBusinessWrite?: (tx: any) => Promise<void>;
};
const scope = new AsyncLocalStorage<MonitoringEnterpriseScope>();
export function runWithMonitoringEnterpriseScope<T>(
  value: MonitoringEnterpriseScope,
  action: () => T,
): T {
  return scope.run(value, action);
}
export function currentMonitoringEnterpriseProjectId() {
  return scope.getStore()?.enterpriseProjectId ?? null;
}
export function monitoringEnterpriseProjectIdForOwner(ownerId: string) {
  const current = scope.getStore();
  if (current && current.ownerId !== ownerId)
    throw new Error("MONITORING_PROJECT_OWNER_MISMATCH");
  return current?.enterpriseProjectId ?? null;
}
export function monitoringProjectOwnerPredicate(
  table: { ownerId: AnyMySqlColumn; enterpriseProjectId: AnyMySqlColumn },
  ownerId: string | SQLWrapper,
) {
  const current = scope.getStore();
  if (!current) return eq(table.ownerId, ownerId);
  if (typeof ownerId === "string" && ownerId !== current.ownerId)
    throw new Error("MONITORING_PROJECT_OWNER_MISMATCH");
  return and(
    eq(table.ownerId, ownerId),
    current.enterpriseProjectId
      ? eq(table.enterpriseProjectId, current.enterpriseProjectId)
      : isNull(table.enterpriseProjectId),
  )!;
}

/** Versioned monitor/run rows inherit their immutable parent project's scope. */
export function monitoringChildOwnerPredicate(
  table: { ownerId: AnyMySqlColumn; projectId: AnyMySqlColumn },
  ownerId: string | SQLWrapper,
) {
  const current = scope.getStore();
  if (!current) return eq(table.ownerId, ownerId);
  if (typeof ownerId === "string" && ownerId !== current.ownerId)
    throw new Error("MONITORING_PROJECT_OWNER_MISMATCH");
  const projectCondition = current.enterpriseProjectId
    ? sql`ep.enterprise_project_id = ${current.enterpriseProjectId}`
    : sql`ep.enterprise_project_id IS NULL`;
  return and(
    eq(table.ownerId, ownerId),
    sql`EXISTS (SELECT 1 FROM projects ep WHERE ep.id = ${table.projectId} AND ep.owner_id = ${ownerId} AND ${projectCondition})`,
  )!;
}

export function monitoringEnterpriseBusinessWriteGuard() { return scope.getStore()?.beforeBusinessWrite; }
