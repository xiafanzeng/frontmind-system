import { and, eq } from "drizzle-orm";
import { userAdminAssignments, users } from "../drizzle/schema";
import { AuthServiceError, type AuthenticatedUser } from "./auth-service";
import { getDb } from "./db";
import { getEnterpriseProjectScope } from "./enterprise-project-context";
import { assertEnterpriseProjectActive } from "./enterprise-project-lifecycle";

type BusinessActor = Pick<AuthenticatedUser, "id" | "role" | "adminAccessLevel">;

/** Business maintenance only. Account administration and engineer role grants
 * remain governed by their existing, narrower services. This check does not
 * acquire the project lock: callers may authorize an exact successful replay
 * before applying the active-project admission fence. */
export async function assertCustomerProjectBusinessWrite(
  actor: BusinessActor,
  ownerUserId: number,
  options: { executor?: any; requireProject?: boolean; currentRead?: boolean } = {},
) {
  const scope = getEnterpriseProjectScope();
  if (scope && (scope.ownerUserId !== ownerUserId || scope.actorUserId !== actor.id))
    throw new AuthServiceError("NOT_FOUND", "客户与企业项目不匹配或无权写入");
  if ((options.requireProject ?? (actor.role === "admin" && actor.id !== ownerUserId)) && !scope)
    throw new AuthServiceError("CONFLICT", "请先选择目标客户的企业项目");
  // Account-level customer writes retain their session-based authorization.
  // Scoped submissions still recheck the active owner in their transaction.
  if (!scope && actor.role === "user" && actor.id === ownerUserId) return;
  const executor = options.executor ?? await getDb();
  if (!executor) throw new AuthServiceError("DATABASE_UNAVAILABLE", "数据库暂不可用");
  const ownerQuery = executor.select({ id: users.id, isActive: users.isActive })
    .from(users).where(eq(users.id, ownerUserId)).limit(1);
  const [owner] = await (options.currentRead ? ownerQuery.for("share") : ownerQuery);
  if (!owner?.isActive) throw new AuthServiceError("NOT_FOUND", "客户不存在或已停用");
  if (actor.role === "user" && actor.id === ownerUserId) return;
  if (actor.role === "admin" && actor.adminAccessLevel === "system_admin") return;
  if (actor.role === "admin" && actor.adminAccessLevel === "delivery_admin") {
    const assignmentQuery = executor.select({ id: userAdminAssignments.id }).from(userAdminAssignments)
      .where(and(eq(userAdminAssignments.userId, ownerUserId), eq(userAdminAssignments.adminId, actor.id))).limit(1);
    const [assignment] = await (options.currentRead ? assignmentQuery.for("share") : assignmentQuery);
    if (assignment) return;
  }
  throw new AuthServiceError("NOT_FOUND", "客户不存在或无权写入");
}

/** Final acceptance only: customer -> enterprise project -> business rows.
 * Never call this from provider completion, settlement, refunds or recovery. */
export async function lockCustomerProjectBusinessWrite(
  tx: any,
  ownerUserId: number,
  actor?: BusinessActor,
) {
  const scope = getEnterpriseProjectScope();
  if (!scope) return;
  if (scope.ownerUserId !== ownerUserId || (actor && actor.id !== scope.actorUserId))
    throw new AuthServiceError("NOT_FOUND", "客户与企业项目不匹配或无权写入");
  const [owner] = await tx.select({ id: users.id, isActive: users.isActive }).from(users)
    .where(eq(users.id, ownerUserId)).limit(1).for("update");
  if (!owner?.isActive) throw new AuthServiceError("NOT_FOUND", "客户不存在或已停用");
  // Admission may follow a non-locking ownership lookup. Current reads avoid
  // reusing that older REPEATABLE READ snapshot after assignment revocation.
  const [currentActor] = await tx.select({ id: users.id, role: users.role, adminAccessLevel: users.adminAccessLevel, isActive: users.isActive })
    .from(users).where(eq(users.id, scope.actorUserId)).limit(1).for("share");
  if (!currentActor?.isActive) throw new AuthServiceError("NOT_FOUND", "操作者不存在或已停用");
  // Engineers are admitted by assertDeliveryProjectContext at the existing
  // transport boundary. Do not grant them administrator capabilities here.
  if (currentActor.role !== "delivery_member")
    await assertCustomerProjectBusinessWrite(currentActor, ownerUserId, { executor: tx, requireProject: true, currentRead: true });
  await assertEnterpriseProjectActive(tx, scope.enterpriseProjectId, ownerUserId);
}
