import { and, eq, isNull } from "drizzle-orm";
import { enterpriseProjects } from "../drizzle/schema";
import { getDb } from "./db";
import { runWithEnterpriseProjectScope, runWithoutEnterpriseProjectScope } from "./enterprise-project-context";
/** Restore persisted ownership before a worker touches project content. */
export async function runWithStoredEnterpriseProjectScope<T>(ownerUserId: number, enterpriseProjectId: string | null | undefined, action: () => T | Promise<T>): Promise<T> {
  if (!enterpriseProjectId) return runWithoutEnterpriseProjectScope(action);
  const db = await getDb();
  if (!db) throw new Error("DATABASE_UNAVAILABLE");
  const [project] = await db.select().from(enterpriseProjects).where(and(eq(enterpriseProjects.id, enterpriseProjectId), eq(enterpriseProjects.ownerUserId, ownerUserId), isNull(enterpriseProjects.archivedAt))).limit(1);
  if (!project) throw new Error("ENTERPRISE_PROJECT_RECOVERY_OWNER_MISMATCH");
  return runWithEnterpriseProjectScope({ enterpriseProjectId, ownerUserId, actorUserId: ownerUserId, isLegacyDefault: project.isLegacyDefault }, action);
}
