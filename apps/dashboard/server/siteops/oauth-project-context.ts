import { and, eq } from "drizzle-orm";
import { siteProjects } from "../../drizzle/schema";
import { AuthServiceError, type AuthenticatedUser } from "../auth-service";
import { getDb } from "../db";
import { runWithEnterpriseProjectScope, runWithoutEnterpriseProjectScope } from "../enterprise-project-context";
import { assertEnterpriseAccountAccess, resolveEnterpriseProjectScope } from "../enterprise-project-service";

/** These coordinates come only from a verified OAuth state, never the URL selector. */
export type SiteOpsOAuthProjectIdentity = {
  projectId: string;
  userId: number;
  actorUserId?: number;
  enterpriseProjectId?: string | null;
};

export async function runWithSiteOpsOAuthProjectScope<T>(
  actor: AuthenticatedUser,
  identity: SiteOpsOAuthProjectIdentity,
  action: () => T | Promise<T>,
): Promise<T> {
  if ((identity.actorUserId ?? identity.userId) !== actor.id) {
    throw new AuthServiceError("INVALID_CREDENTIAL", "阿里云授权不属于当前操作员");
  }
  const db = await getDb();
  if (!db) throw new AuthServiceError("DATABASE_UNAVAILABLE", "数据库暂不可用");
  const [project] = await db.select({
    userId: siteProjects.userId,
    enterpriseProjectId: siteProjects.enterpriseProjectId,
  }).from(siteProjects).where(and(
    eq(siteProjects.id, identity.projectId),
    eq(siteProjects.userId, identity.userId),
  )).limit(1);
  if (!project || project.userId !== identity.userId ||
      (identity.enterpriseProjectId !== undefined && identity.enterpriseProjectId !== project.enterpriseProjectId)) {
    throw new AuthServiceError("NOT_FOUND", "阿里云授权对应的企业项目不存在或已变更");
  }
  if (project.enterpriseProjectId) {
    const scope = await resolveEnterpriseProjectScope(actor, project.enterpriseProjectId);
    if (scope.ownerUserId !== identity.userId) {
      throw new AuthServiceError("NOT_FOUND", "阿里云授权对应的企业项目所有者已变更");
    }
    return await runWithEnterpriseProjectScope(scope, action);
  }
  await assertEnterpriseAccountAccess(actor, identity.userId);
  return await runWithoutEnterpriseProjectScope(action);
}
