import { lockCustomerProjectBusinessWrite } from "./customer-project-write-access";
import { enterpriseProjectOperationId } from "./enterprise-project-service";
import { createHash } from "node:crypto";
import { and, asc, desc, eq, inArray } from "drizzle-orm";
import { enterpriseProjectQuestions as questions, knowledgeBaseSnapshots, responseLogicEntries, users, workspaceQuestions } from "../drizzle/schema";
import { serviceCapabilityKeySchema, type ServicePortal, type ServicePortalQuestion, type WorkspaceQuestionCategory } from "../shared/service-portal";
import { AuthServiceError } from "./auth-service";
import { getDb } from "./db";
import { enterpriseOwnerPredicate, enterpriseProjectIdForOwner, getEnterpriseProjectScope } from "./enterprise-project-scope";

export function workspaceQuestionTable() {
  // The persisted fields are compatible. Only the tool table permits absent
  // historical contract coordinates; callers project those explicitly.
  return (getEnterpriseProjectScope() ? questions : workspaceQuestions) as typeof workspaceQuestions;
}
export function workspaceQuestionOwnerPredicate(userId: number) {
  const projectId = enterpriseProjectIdForOwner(userId);
  return projectId ? and(eq(questions.userId, userId), eq(questions.enterpriseProjectId, projectId))! : eq(workspaceQuestions.userId, userId);
}
async function context(userId: number) {
  const enterpriseProjectId = enterpriseProjectIdForOwner(userId);
  if (!enterpriseProjectId) throw new AuthServiceError("CONFLICT", "请先选择企业项目");
  const db = await getDb();
  if (!db) throw new AuthServiceError("DATABASE_UNAVAILABLE", "数据库暂不可用");
  return { db, enterpriseProjectId };
}
export function projectQuestionDto(row: typeof questions.$inferSelect): ServicePortalQuestion {
  return {
    ...row,
    quotaPeriodId: row.quotaPeriodId ?? "",
    intentConfirmed: row.intentConfirmedRevision === row.intentRevision && row.intentConfirmedAt !== null,
    intentConfirmedAt: row.intentConfirmedAt?.getTime() ?? null,
    selectionRequestedAt: row.selectionRequestedAt?.getTime() ?? null,
    selectionApprovedAt: row.selectionApprovedAt?.getTime() ?? null,
  };
}
export async function listEnterpriseQuestions(userId: number, includeArchived = false) {
  const { db, enterpriseProjectId } = await context(userId);
  const rows = await db.select().from(questions).where(and(eq(questions.userId, userId), eq(questions.enterpriseProjectId, enterpriseProjectId), includeArchived ? undefined : inArray(questions.status, ["candidate", "selected"]))).orderBy(asc(questions.ordinal), asc(questions.createdAt));
  return rows.map(projectQuestionDto);
}

export async function selectEnterpriseQuestion(input: {
  userId: number; actorUserId: number; questionId?: string; expectedRevision?: number;
  question?: string; category?: WorkspaceQuestionCategory; clientRequestId?: string;
}) {
  const { db, enterpriseProjectId } = await context(input.userId);
  return db.transaction(async tx => {
    await lockCustomerProjectBusinessWrite(tx, input.userId);
    // Lock project question writes through the owner to cover the missing-row case.
    await tx.select({ id: users.id }).from(users).where(eq(users.id, input.userId)).limit(1).for("update");
    const now = new Date();
    if (input.questionId) {
      const [row] = await tx.select().from(questions).where(and(eq(questions.id, input.questionId), workspaceQuestionOwnerPredicate(input.userId))).limit(1).for("update");
      if (!row || row.status === "archived") throw new AuthServiceError("NOT_FOUND", "当前企业项目没有该问题");
      if (row.status === "selected") return projectQuestionDto(row);
      if (row.revision !== input.expectedRevision) throw new AuthServiceError("CONFLICT", "问题已变化，请刷新后重试");
      const changes = { status: "selected" as const, locked: true, selectionApprovalStatus: "approved" as const, selectedAt: now, selectionApprovedAt: now, selectionApprovedByUserId: input.actorUserId, revision: row.revision + 1 };
      await tx.update(questions).set(changes).where(and(eq(questions.id, row.id), workspaceQuestionOwnerPredicate(input.userId)));
      return projectQuestionDto({ ...row, ...changes });
    }
    const text = input.question?.trim();
    if (!text || !input.category) throw new AuthServiceError("CONFLICT", "请填写问题并选择类型");
    const requestHash = createHash("sha256").update(JSON.stringify({ text, category: input.category })).digest("hex");
    // Older clients have no request id. Exact project/text/category replay is
    // deterministic, while a new explicit request id can represent a new row.
    const clientRequestId = input.clientRequestId ?? `question:${requestHash}`;
    const [prior] = await tx.select().from(questions).where(and(eq(questions.enterpriseProjectId, enterpriseProjectId), eq(questions.clientRequestId, clientRequestId))).limit(1);
    if (prior) {
      if (prior.requestHash !== requestHash) throw new AuthServiceError("CONFLICT", "该请求编号已用于另一问题");
      return projectQuestionDto(prior);
    }
    const id = enterpriseProjectOperationId(input.userId, `question:${enterpriseProjectId}:${clientRequestId}`);
    await tx.insert(questions).values({ id, enterpriseProjectId, userId: input.userId, clientRequestId, requestHash, question: text, category: input.category, source: "user", status: "selected", locked: true, selectionApprovalStatus: "approved", selectedAt: now, selectionApprovedAt: now, selectionApprovedByUserId: input.actorUserId, createdByUserId: input.actorUserId });
    const [created] = await tx.select().from(questions).where(eq(questions.id, id)).limit(1);
    return projectQuestionDto(created!);
  });
}

export async function confirmEnterpriseQuestionIntent(input: { userId: number; questionId: string; expectedRevision: number; expectedIntentRevision: number }) {
  const { db } = await context(input.userId);
  return db.transaction(async tx => {
    await lockCustomerProjectBusinessWrite(tx, input.userId);
    const [row] = await tx.select().from(questions).where(and(eq(questions.id, input.questionId), workspaceQuestionOwnerPredicate(input.userId))).limit(1).for("update");
    if (!row || row.status !== "selected" || row.revision !== input.expectedRevision || row.intentRevision !== input.expectedIntentRevision) throw new AuthServiceError("CONFLICT", "问题已更新，请刷新后重试");
    if (!row.intent?.trim()) throw new AuthServiceError("CONFLICT", "请先补充问题意图");
    const changes = { intentConfirmedRevision: row.intentRevision, intentConfirmedAt: new Date(), intentConfirmedByUserId: getEnterpriseProjectScope()?.actorUserId ?? input.userId, revision: row.revision + 1 };
    await tx.update(questions).set(changes).where(and(eq(questions.id, row.id), workspaceQuestionOwnerPredicate(input.userId)));
    return projectQuestionDto({ ...row, ...changes });
  });
}

export async function getEnterpriseToolPortal(userId: number): Promise<ServicePortal> {
  const { db, enterpriseProjectId } = await context(userId);
  const [accountRows, snapshotRows, allQuestions, logicRows] = await Promise.all([
    db.select({ userId: users.id, username: users.username, displayName: users.displayName }).from(users).where(eq(users.id, userId)).limit(1),
    db.select({ version: knowledgeBaseSnapshots.version }).from(knowledgeBaseSnapshots).where(and(enterpriseOwnerPredicate(knowledgeBaseSnapshots, userId), eq(knowledgeBaseSnapshots.status, "active"))).orderBy(desc(knowledgeBaseSnapshots.version)).limit(1),
    listEnterpriseQuestions(userId, true),
    db.select({ questionId: responseLogicEntries.questionId }).from(responseLogicEntries).where(and(enterpriseOwnerPredicate(responseLogicEntries, userId), eq(responseLogicEntries.status, "confirmed"))),
  ]);
  const confirmed = new Set(logicRows.map(row => row.questionId));
  const selected = allQuestions.filter(row => row.status === "selected").map(row => ({ ...row, category: row.category!, responseLogicConfirmed: confirmed.has(row.id) }));
  const hasKnowledge = snapshotRows.length > 0;
  const capabilities = Object.fromEntries(serviceCapabilityKeySchema.options.map(key => {
    const needsKnowledge = ["globalKeywords", "responseLogic", "contentAssets"].includes(key);
    const allowed = !needsKnowledge || hasKnowledge;
    return [key, { allowed, effectiveStatus: allowed ? "available" : "workflow_prerequisite", reason: allowed ? null : "请先完成并发布当前项目的知识库" }];
  })) as ServicePortal["capabilities"];
  return {
    schemaVersion: 1, mode: "operator", enterpriseProjectId, revision: Math.max(0, ...allQuestions.map(row => row.revision)),
    entitlementRollout: { mode: "enforced", pendingUserCount: 0 }, account: accountRows[0] ?? null,
    service: { contractId: null, planCode: null, planVersion: null, planName: "企业项目", status: "active", validFrom: null, validUntil: null, billingLabel: "按实际使用计费", source: null },
    quotas: null, quotaPeriods: [], purchases: [],
    knowledge: { version: snapshotRows[0]?.version ?? null, authenticatedVersion: snapshotRows[0]?.version ?? null, authenticatedForCurrentService: hasKnowledge, status: hasKnowledge ? "display_ready" : "missing", latestImportStatus: null },
    purchasedQuestions: selected,
    historicalQuestions: allQuestions.filter(row => row.status === "archived").map(row => ({ ...row, category: row.category! })),
    capabilities, workflowSteps: [], nextAction: { kind: hasKnowledge ? "select_service_questions" : "start_knowledge_build", label: hasKnowledge ? "优化问题" : "开始知识库", href: hasKnowledge ? "/brand-question-portfolio" : "/knowledge-base" },
  };
}
