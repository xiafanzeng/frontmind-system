import { createHash } from "node:crypto";
import { and, asc, eq, isNull } from "drizzle-orm";
import { deliveryProjectAssignments, enterpriseProjects, enterpriseProjectDashboardContents, userAdminAssignments, userDashboardContents, users } from "../drizzle/schema";
import { createDefaultDashboardPayload, dashboardPayloadSchema } from "../shared/dashboard";
import { AuthServiceError, type AuthenticatedUser } from "./auth-service";
import { getDb } from "./db";
import { getEnterpriseProjectScope, type EnterpriseProjectScope } from "./enterprise-project-context";

export function enterpriseDashboardTable() {
  return (getEnterpriseProjectScope() ? enterpriseProjectDashboardContents : userDashboardContents) as typeof userDashboardContents;
}
export function enterpriseDashboardOwnerPredicate(userId: number) {
  const scope = getEnterpriseProjectScope();
  if (!scope) return eq(userDashboardContents.userId, userId);
  if (scope.ownerUserId !== userId) throw new AuthServiceError("NOT_FOUND", "企业项目不存在或无权访问");
  return and(eq(enterpriseProjectDashboardContents.userId, userId), eq(enterpriseProjectDashboardContents.enterpriseProjectId, scope.enterpriseProjectId))!;
}

export function enterpriseProjectOperationId(ownerUserId: number, requestId: string) {
  const hash = createHash("sha256").update(`enterprise-project:v1:${ownerUserId}:${requestId}`).digest("hex");
  return `${hash.slice(0, 8)}-${hash.slice(8, 12)}-8${hash.slice(13, 16)}-a${hash.slice(17, 20)}-${hash.slice(20, 32)}`;
}

async function database() {
  const db = await getDb();
  if (!db) throw new AuthServiceError("DATABASE_UNAVAILABLE", "数据库暂不可用");
  return db;
}

export async function assertEnterpriseAccountAccess(actor: AuthenticatedUser, ownerUserId: number, executor?: any) {
  const db = executor ?? await database();
  const [owner] = await db.select({ id: users.id, isActive: users.isActive }).from(users).where(eq(users.id, ownerUserId)).limit(1);
  if (!owner?.isActive) throw new AuthServiceError("NOT_FOUND", "企业项目不存在或无权访问");
  if (actor.id === ownerUserId) return;
  if (actor.role === "admin" && actor.adminAccessLevel === "system_admin") return;
  if (actor.role === "admin" && actor.adminAccessLevel === "delivery_admin") {
    const [assignment] = await db.select({ id: userAdminAssignments.id }).from(userAdminAssignments).where(and(eq(userAdminAssignments.userId, ownerUserId), eq(userAdminAssignments.adminId, actor.id))).limit(1);
    if (assignment) return;
  }
  if (actor.role === "delivery_member" && actor.engineerRoleType) {
    const [assignment] = await db.select({id:deliveryProjectAssignments.id}).from(deliveryProjectAssignments).where(and(eq(deliveryProjectAssignments.customerUserId,ownerUserId),eq(deliveryProjectAssignments.engineerUserId,actor.id),eq(deliveryProjectAssignments.roleType,actor.engineerRoleType))).limit(1);
    if(assignment) return;
  }
  throw new AuthServiceError("NOT_FOUND", "企业项目不存在或无权访问");
}

export async function ensureLegacyEnterpriseProject(ownerUserId: number) {
  const db = await database();
  const id = enterpriseProjectOperationId(ownerUserId, "legacy-default");
  return db.transaction(async tx => {
    const [owner] = await tx.select().from(users).where(eq(users.id, ownerUserId)).limit(1).for("update");
    if (!owner?.isActive) throw new AuthServiceError("NOT_FOUND", "账号不存在或已停用");
    const [existing] = await tx.select().from(enterpriseProjects).where(eq(enterpriseProjects.id, id)).limit(1);
    if (existing) return existing;
    const [legacy] = await tx.select().from(userDashboardContents).where(eq(userDashboardContents.userId, ownerUserId)).limit(1);
    const name = String(legacy?.payload?.brandName || owner.displayName || owner.username || "默认企业项目").trim().slice(0, 120);
    await tx.insert(enterpriseProjects).values({ id, ownerUserId, name, isLegacyDefault: true, clientRequestId: "legacy-default" });
    if (legacy) await tx.insert(enterpriseProjectDashboardContents).values({ ...legacy, enterpriseProjectId: id });
    const [created] = await tx.select().from(enterpriseProjects).where(eq(enterpriseProjects.id, id)).limit(1);
    return created!;
  });
}

export async function resolveEnterpriseProjectScope(actor: AuthenticatedUser, enterpriseProjectId: string): Promise<EnterpriseProjectScope> {
  const db = await database();
  const [project] = await db.select().from(enterpriseProjects).where(and(eq(enterpriseProjects.id, enterpriseProjectId), isNull(enterpriseProjects.archivedAt))).limit(1);
  if (!project) throw new AuthServiceError("NOT_FOUND", "企业项目不存在或已归档");
  await assertEnterpriseAccountAccess(actor, project.ownerUserId);
  return { enterpriseProjectId: project.id, ownerUserId: project.ownerUserId, actorUserId: actor.id, isLegacyDefault: project.isLegacyDefault };
}

export async function listEnterpriseProjects(actor: AuthenticatedUser, requestedOwner?: number) {
  const db = await database();
  let ownerIds: number[];
  if (requestedOwner !== undefined || actor.role !== "admin") {
    const ownerId = requestedOwner ?? actor.id;
    await assertEnterpriseAccountAccess(actor, ownerId);
    ownerIds = [ownerId];
  } else if (actor.adminAccessLevel === "system_admin") {
    ownerIds = (await db.select({ id: users.id }).from(users).where(and(eq(users.role, "user"), eq(users.isActive, true)))).map(row => row.id);
  } else {
    ownerIds = (await db.select({ id: userAdminAssignments.userId }).from(userAdminAssignments).where(eq(userAdminAssignments.adminId, actor.id))).map(row => row.id);
  }
  const projects = [];
  for (const ownerId of ownerIds) {
    projects.push(...await db.select().from(enterpriseProjects).where(and(eq(enterpriseProjects.ownerUserId, ownerId), isNull(enterpriseProjects.archivedAt))).orderBy(asc(enterpriseProjects.createdAt), asc(enterpriseProjects.id)));
  }
  return { projects };
}

export async function createEnterpriseProject(actor: AuthenticatedUser, input: { name: string; clientRequestId: string; ownerUserId?: number }) {
  const ownerUserId = input.ownerUserId ?? actor.id;
  await assertEnterpriseAccountAccess(actor, ownerUserId);
  const db = await database();
  const id = enterpriseProjectOperationId(ownerUserId, input.clientRequestId);
  const name = input.name.trim();
  return db.transaction(async tx => {
    await tx.select({ id: users.id }).from(users).where(eq(users.id, ownerUserId)).limit(1).for("update");
    await assertEnterpriseAccountAccess(actor, ownerUserId, tx);
    const [existing] = await tx.select().from(enterpriseProjects).where(eq(enterpriseProjects.id, id)).limit(1);
    if (existing) {
      if (existing.archivedAt) throw new AuthServiceError("CONFLICT", "该请求对应的企业项目已删除，请重新新建项目");
      if (existing.name !== name || existing.ownerUserId !== ownerUserId) throw new AuthServiceError("CONFLICT", "该请求编号已用于另一企业项目");
      return existing;
    }
    await tx.insert(enterpriseProjects).values({ id, ownerUserId, name, clientRequestId: input.clientRequestId });
    await tx.insert(enterpriseProjectDashboardContents).values({ enterpriseProjectId: id, userId: ownerUserId, payload: createDefaultDashboardPayload(name), revision: 0, updatedByUserId: actor.id });
    const [created] = await tx.select().from(enterpriseProjects).where(eq(enterpriseProjects.id, id)).limit(1);
    return created!;
  });
}

export async function renameEnterpriseProject(actor: AuthenticatedUser, input: { enterpriseProjectId: string; name: string; expectedRevision: number }) {
  const scope = await resolveEnterpriseProjectScope(actor, input.enterpriseProjectId);
  const db = await database();
  return db.transaction(async tx => {
    await tx.select({ id: users.id }).from(users).where(eq(users.id, scope.ownerUserId)).limit(1).for("update");
    await assertEnterpriseAccountAccess(actor, scope.ownerUserId, tx);
    const [project] = await tx.select().from(enterpriseProjects).where(and(eq(enterpriseProjects.id, scope.enterpriseProjectId), eq(enterpriseProjects.ownerUserId, scope.ownerUserId))).limit(1).for("update");
    if (!project || project.archivedAt || project.revision !== input.expectedRevision) throw new AuthServiceError("CONFLICT", "项目已更新或删除，请刷新后重试");
    await tx.update(enterpriseProjects).set({ name: input.name.trim(), revision: project.revision + 1 }).where(eq(enterpriseProjects.id, project.id));
    return { ...project, name: input.name.trim(), revision: project.revision + 1 };
  });
}

export async function readEnterpriseDashboard(userId: number) {
  const scope = getEnterpriseProjectScope();
  if (!scope) return null;
  if (scope.ownerUserId !== userId) throw new AuthServiceError("NOT_FOUND", "企业项目不存在或无权访问");
  const db = await database();
  const [content] = await db.select().from(enterpriseProjectDashboardContents).where(and(eq(enterpriseProjectDashboardContents.enterpriseProjectId, scope.enterpriseProjectId), eq(enterpriseProjectDashboardContents.userId, userId))).limit(1);
  const [project] = await db.select().from(enterpriseProjects).where(eq(enterpriseProjects.id, scope.enterpriseProjectId)).limit(1);
  if (!project || project.archivedAt) throw new AuthServiceError("NOT_FOUND", "企业项目不存在或已删除");
  return { payload: dashboardPayloadSchema.parse(content?.payload ?? createDefaultDashboardPayload(project.name)), sourceName: content?.sourceName ?? null, enterpriseIdentityBoundAt: content?.enterpriseIdentityBoundAt?.getTime() ?? null, revision: content?.revision ?? 0, updatedAt: content?.updatedAt?.getTime() ?? null, knowledgeUpdatedAt: null };
}
