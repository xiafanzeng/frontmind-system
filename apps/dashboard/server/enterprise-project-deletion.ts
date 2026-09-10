import { and, eq, sql } from "drizzle-orm";
import { enterpriseProjects, users } from "../drizzle/schema";
import { AuthServiceError, type AuthenticatedUser } from "./auth-service";
import { getDb } from "./db";
import { assertEnterpriseAccountAccess } from "./enterprise-project-service";

export type EnterpriseProjectDeletionResult = {
  enterpriseProjectId: string;
  revision: number;
  deletedAt: Date;
};

/** UI deletion retains immutable content, provider facts, and account ledgers. */
export async function deleteEnterpriseProject(
  actor: AuthenticatedUser,
  input: { enterpriseProjectId: string; expectedRevision: number },
): Promise<EnterpriseProjectDeletionResult> {
  const db = await getDb();
  if (!db) throw new AuthServiceError("DATABASE_UNAVAILABLE", "数据库暂不可用");
  // Archived rows remain addressable only to authorize an exact delete replay.
  const [owned] = await db.select().from(enterpriseProjects)
    .where(eq(enterpriseProjects.id, input.enterpriseProjectId)).limit(1);
  if (!owned) throw new AuthServiceError("NOT_FOUND", "企业项目不存在或无权访问");
  await assertEnterpriseAccountAccess(actor, owned.ownerUserId);
  // The admission fence waits on the project row while another transaction
  // may be committing its final business row.  Under MySQL's default
  // REPEATABLE READ, the subsequent UNION can retain a read view from before
  // that wait and miss the just-committed blocker.  READ COMMITTED makes the
  // post-lock blocker scan observe the state that won the project-row lock.
  return db.transaction(async tx => {
    await tx.select({ id: users.id }).from(users).where(eq(users.id, owned.ownerUserId)).limit(1).for("update");
    await assertEnterpriseAccountAccess(actor, owned.ownerUserId, tx);
    const [project] = await tx.select().from(enterpriseProjects)
      .where(and(eq(enterpriseProjects.id, owned.id), eq(enterpriseProjects.ownerUserId, owned.ownerUserId)))
      .limit(1).for("update");
    if (!project) throw new AuthServiceError("NOT_FOUND", "企业项目不存在或无权访问");
    if (project.archivedAt && project.revision === input.expectedRevision + 1)
      return { enterpriseProjectId: project.id, revision: project.revision, deletedAt: project.archivedAt };
    if (project.archivedAt || project.revision !== input.expectedRevision)
      throw new AuthServiceError("CONFLICT", "项目已更新，请刷新后重试");

    // Admission paths lock the same enterprise row before accepting new paid
    // work. Existing jobs remain visible here until terminal, including unknown
    // provider outcomes. A transport session alone is not an active task.
    const [blockers] = await tx.execute(sql`
      SELECT 'AI 智能体' AS kind FROM ai_charge_commands
        WHERE enterprise_project_id = ${project.id} AND state NOT IN ('settled', 'rejected')
      UNION ALL SELECT 'AI 智能体' FROM agent_operations
        WHERE enterpriseProjectId = ${project.id}
          AND operation_type <> 'dashboard.provider.transport'
          AND status IN ('queued', 'running', 'result_pending', 'attention_required')
      UNION ALL SELECT '知识库或内容制作' FROM conversation_turns
        WHERE enterpriseProjectId = ${project.id} AND status IN ('queued', 'running')
      UNION ALL SELECT '建站或内容制作' FROM site_operations so
        INNER JOIN site_projects sp ON sp.id = so.project_id
        WHERE sp.enterpriseProjectId = ${project.id}
          AND so.status IN ('queued', 'running', 'outcome_unknown', 'attention_required')
      UNION ALL SELECT '问题监控' FROM runs r INNER JOIN projects p ON p.id = r.project_id
        WHERE p.enterprise_project_id = ${project.id}
          AND r.status IN ('queued', 'waiting_quota', 'running', 'review_required')
      UNION ALL SELECT '问题监控' FROM attempts a INNER JOIN runs r ON r.id = a.run_id
        INNER JOIN projects p ON p.id = r.project_id
        WHERE p.enterprise_project_id = ${project.id}
          AND a.status IN ('queued', 'submitting', 'submission_unknown', 'accepted', 'processing', 'review_required')
      UNION ALL SELECT '媒体发布' FROM publisher_items
        WHERE enterprise_project_id = ${project.id}
          AND (status NOT IN ('success', 'failed') OR funds_status IN ('reserved', 'frozen'))
      LIMIT 1
    `) as unknown as [Array<{ kind: string }>];
    if (blockers[0]) throw new AuthServiceError("CONFLICT", `项目还有正在运行或待核算的${blockers[0].kind}任务，请结束后再删除`);

    // Keep schedule occurrences and all historical versions for provenance;
    // paused monitors plus the createRun admission fence prevent future sends.
    await tx.execute(sql`
      UPDATE monitors m INNER JOIN projects p ON p.id = m.project_id
      SET m.status = 'paused', m.next_run_at = NULL
      WHERE p.enterprise_project_id = ${project.id} AND m.deleted_at IS NULL
    `);
    // MySQL TIMESTAMP precision is seconds. Return the persisted value so a
    // lost-response retry is byte-for-byte equivalent to the first response.
    const deletedAt = new Date(Math.floor(Date.now() / 1000) * 1000);
    const revision = project.revision + 1;
    await tx.update(enterpriseProjects).set({ archivedAt: deletedAt, revision })
      .where(eq(enterpriseProjects.id, project.id));
    return { enterpriseProjectId: project.id, revision, deletedAt };
  }, { isolationLevel: "read committed" });
}
