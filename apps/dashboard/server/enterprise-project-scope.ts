import { and, eq, isNull, or, type SQL, type SQLWrapper } from "drizzle-orm";
import type { AnyMySqlColumn } from "drizzle-orm/mysql-core";
export {
  getEnterpriseProjectScope,
  runWithEnterpriseProjectScope,
  currentEnterpriseProjectId,
  type EnterpriseProjectScope,
} from "./enterprise-project-context";
import { getEnterpriseProjectScope } from "./enterprise-project-context";

/** Migrated project rows are exact; NULL is reserved for account-level work. */
export function enterpriseProjectPredicate(projectColumn: AnyMySqlColumn): SQL {
  const scope = getEnterpriseProjectScope();
  if (!scope) return isNull(projectColumn);
  const exact = eq(projectColumn, scope.enterpriseProjectId);
  return exact;
}

export function enterpriseOwnerPredicate(
  table: { userId: AnyMySqlColumn; enterpriseProjectId: AnyMySqlColumn },
  userId: number | SQLWrapper,
) {
  const scope = getEnterpriseProjectScope();
  if (scope && typeof userId === "number" && scope.ownerUserId !== userId) {
    throw new Error("ENTERPRISE_PROJECT_OWNER_MISMATCH");
  }
  return and(eq(table.userId, userId), enterpriseProjectPredicate(table.enterpriseProjectId))!;
}

export function enterpriseProjectIdForOwner(userId: number): string | null {
  const scope = getEnterpriseProjectScope();
  if (!scope) return null;
  if (scope.ownerUserId !== userId) throw new Error("ENTERPRISE_PROJECT_OWNER_MISMATCH");
  return scope.enterpriseProjectId;
}

export function enterpriseProjectUrl(url: string) {
  const projectId = getEnterpriseProjectScope()?.enterpriseProjectId;
  if (!projectId || !url.startsWith("/")) return url;
  const parsed = new URL(url, "https://frontmind.invalid");
  parsed.searchParams.set("enterpriseProjectId", projectId);
  return `${parsed.pathname}${parsed.search}${parsed.hash}`;
}

export function enterpriseAccountOwnerPredicate(table: { accountUserId: AnyMySqlColumn; enterpriseProjectId: AnyMySqlColumn }, userId: number | SQLWrapper) {
  return enterpriseOwnerPredicate({ userId: table.accountUserId, enterpriseProjectId: table.enterpriseProjectId }, userId);
}
