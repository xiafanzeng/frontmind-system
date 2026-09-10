import { lockCustomerProjectBusinessWrite } from "./customer-project-write-access";
import { createHash } from "node:crypto";
import { and, desc, eq, inArray, isNull } from "drizzle-orm";
import { ensureDashboardAccountLink } from "@frontmind/monitoring-db";
import { projects, projectBrandVersions, projectQuestions, runs } from "./enterprise-monitoring-tables";
import { enterpriseProjectMonitoringLinks, enterpriseProjectQuestions, enterpriseProjects } from "../drizzle/schema";
import { AuthServiceError, type AuthenticatedUser } from "./auth-service";
import { getDb } from "./db";
import { enterpriseProjectOperationId, readEnterpriseDashboard, resolveEnterpriseProjectScope } from "./enterprise-project-service";
import { runWithEnterpriseProjectScope } from "./enterprise-project-scope";
import { getMonitoringRuntime } from "./monitoring-module";
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
export async function createEnterpriseMonitoringProject(actor: AuthenticatedUser, input: { enterpriseProjectId: string; name: string; questionIds: string[]; clientRequestId: string }) {
  const scope = await resolveEnterpriseProjectScope(actor, input.enterpriseProjectId);
  return runWithEnterpriseProjectScope(scope, async () => {
    const db = await getDb();
    if (!db) throw new AuthServiceError("DATABASE_UNAVAILABLE", "数据库暂不可用");
    const link = await ensureDashboardAccountLink(getMonitoringRuntime().repository.db, scope.ownerUserId);
    const actorLink = actor.id === scope.ownerUserId ? link : await ensureDashboardAccountLink(getMonitoringRuntime().repository.db, actor.id);
    const dashboard = await readEnterpriseDashboard(scope.ownerUserId);
    const questionIds = [...new Set(input.questionIds)].sort();
    const requestHash = hash(JSON.stringify({ name: input.name, questionIds }));
    const projectId = enterpriseProjectOperationId(scope.ownerUserId, `monitoring:${scope.enterpriseProjectId}:${input.clientRequestId}`);
    const brandVersionId = enterpriseProjectOperationId(scope.ownerUserId, `${projectId}:brand:1`);
    return db.transaction(async tx => {
      await lockCustomerProjectBusinessWrite(tx, scope.ownerUserId, actor);
      const [prior] = await tx.select().from(enterpriseProjectMonitoringLinks).where(and(eq(enterpriseProjectMonitoringLinks.enterpriseProjectId, scope.enterpriseProjectId), eq(enterpriseProjectMonitoringLinks.clientRequestId, input.clientRequestId))).limit(1);
      if (prior) {
        if (prior.requestHash !== requestHash) throw new AuthServiceError("CONFLICT", "该请求编号已用于另一监控项目");
        return { projectId: prior.monitoringProjectId, questions: prior.sourceQuestions.map(row => row.question) };
      }
      const selected = await tx.select().from(enterpriseProjectQuestions).where(and(eq(enterpriseProjectQuestions.enterpriseProjectId, scope.enterpriseProjectId), eq(enterpriseProjectQuestions.userId, scope.ownerUserId), eq(enterpriseProjectQuestions.status, "selected"), inArray(enterpriseProjectQuestions.id, questionIds))).for("update");
      if (selected.length !== questionIds.length) throw new AuthServiceError("NOT_FOUND", "部分优化问题已归档或不属于当前企业项目");
      const sourceQuestions = questionIds.map(id => { const row = selected.find(row => row.id === id)!; return { questionId: row.id, revision: row.revision, question: row.question }; });
      await tx.insert(projects).values({ id: projectId, enterpriseProjectId: scope.enterpriseProjectId, ownerId: link.monitoringUserId, name: input.name, timezone: "Asia/Shanghai", currentBrandVersionId: brandVersionId });
      await tx.insert(projectBrandVersions).values({ id: brandVersionId, projectId, version: 1, mainBrand: dashboard?.payload.brandName || input.name, aliases: [], competitors: [], createdBy: actorLink.monitoringUserId });
      for (const question of new Set(sourceQuestions.map(row => row.question.trim()))) await tx.insert(projectQuestions).values({ id: enterpriseProjectOperationId(scope.ownerUserId, `${projectId}:question:${hash(question)}`), projectId, normalizedHash: hash(question), question, createdBy: actorLink.monitoringUserId });
      await tx.insert(enterpriseProjectMonitoringLinks).values({ monitoringProjectId: projectId, enterpriseProjectId: scope.enterpriseProjectId, ownerUserId: scope.ownerUserId, sourceQuestions, clientRequestId: input.clientRequestId, requestHash });
      return { projectId, questions: sourceQuestions.map(row => row.question) };
    });
  });
}

/** Real monitoring run facts; immutable source revisions remain on the link. */
export async function getEnterpriseMonitoringProgress(actor: AuthenticatedUser, enterpriseProjectId: string) {
  const scope = await resolveEnterpriseProjectScope(actor, enterpriseProjectId);
  const db = await getDb();
  if (!db) throw new AuthServiceError("DATABASE_UNAVAILABLE", "数据库暂不可用");
  const link = await ensureDashboardAccountLink(getMonitoringRuntime().repository.db, scope.ownerUserId);
  const projectRows = await db.select({ id: projects.id, name: projects.name }).from(projects).where(and(eq(projects.enterpriseProjectId, scope.enterpriseProjectId), eq(projects.ownerId, link.monitoringUserId), isNull(projects.deletedAt)));
  const sourceLinks = await db.select().from(enterpriseProjectMonitoringLinks).where(and(eq(enterpriseProjectMonitoringLinks.enterpriseProjectId, scope.enterpriseProjectId), eq(enterpriseProjectMonitoringLinks.ownerUserId, scope.ownerUserId)));
  const scopedProjects = projectRows.map(row => ({ ...row, sourceQuestions: sourceLinks.find(link => link.monitoringProjectId === row.id)?.sourceQuestions ?? [] }));
  const runRows = projectRows.length ? await db.select({ id: runs.id, projectId: runs.projectId, status: runs.status, expectedAttempts: runs.expectedAttempts, completedAttempts: runs.completedAttempts, failedAttempts: runs.failedAttempts, createdAt: runs.createdAt }).from(runs).where(and(eq(runs.ownerId, link.monitoringUserId), inArray(runs.projectId, projectRows.map(row => row.id)))).orderBy(desc(runs.createdAt)).limit(200) : [];
  return { enterpriseProjectId, projects: scopedProjects, runs: runRows, summary: { projectCount: projectRows.length, runCount: runRows.length, expectedAttempts: runRows.reduce((sum, row) => sum + row.expectedAttempts, 0), completedAttempts: runRows.reduce((sum, row) => sum + row.completedAttempts, 0), failedAttempts: runRows.reduce((sum, row) => sum + row.failedAttempts, 0) }, window: "latest_200_runs" as const };
}
