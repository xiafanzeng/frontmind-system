import { createHash, randomUUID } from "node:crypto";
import { and, eq, inArray, sql } from "drizzle-orm";
import { z } from "zod";

import {
  deliveryProjectAssignments,
  deliveryTicketEvents,
  deliveryTickets,
  responseLogicEntries,
  users,
  workspaceQuestions,
} from "../drizzle/schema";
import { AuthServiceError, type AuthenticatedUser } from "./auth-service";
import { getDb } from "./db";
import { workspaceQuestionCategorySchema } from "../shared/service-portal";
import {
  assertDeliveryProjectContext,
  deliveryExecutionActorRole,
  reconcileInitialMonitoringAfterQuestionSelection,
  type InitialMonitoringQuestionSelection,
} from "./delivery-role-service";
import {
  approveWorkspaceQuestionSelection,
  assertServiceWriteAccess,
  ServiceEntitlementError,
} from "./service-entitlement";

const ACTIVE_TICKET_STATUSES = [
  "submitted",
  "needs_information",
  "scheduled",
  "in_progress",
] as const;

const questionMaintenanceBaseSchema = z.object({
  clientRequestId: z.string().uuid(),
  questionId: z.string().uuid(),
  reason: z.string().trim().max(2_000).optional(),
});

export const submitQuestionMaintenanceSchema = z.discriminatedUnion("action", [
  questionMaintenanceBaseSchema.extend({
    action: z.literal("modify"),
    proposedQuestion: z
      .string()
      .trim()
      .min(2, "修改后的问题至少需要 2 个字符")
      .max(4_000, "修改后的问题不能超过 4000 个字符"),
  }),
  questionMaintenanceBaseSchema.extend({
    action: z.literal("delete"),
  }),
  questionMaintenanceBaseSchema.extend({
    action: z.literal("response_logic_reset"),
  }),
]);
export type SubmitQuestionMaintenanceInput = z.infer<
  typeof submitQuestionMaintenanceSchema
>;

export const decideQuestionMaintenanceSchema = z
  .object({
    projectAssignmentId: z.string().uuid(),
    ticketId: z.string().uuid(),
    expectedRevision: z.number().int().positive(),
    decision: z.enum(["approve", "reject"]),
    category: workspaceQuestionCategorySchema.optional(),
    decisionNote: z.string().trim().max(2_000).optional(),
  })
  .superRefine((value, context) => {
    if (value.decision === "reject" && !value.decisionNote?.trim()) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["decisionNote"],
        message: "驳回时必须填写原因",
      });
    }
  });
export type DecideQuestionMaintenanceInput = z.infer<
  typeof decideQuestionMaintenanceSchema
>;

const questionMaintenancePayloadSchema = z
  .object({
    version: z.literal(1),
    action: z.enum(["review", "modify", "delete", "response_logic_reset"]),
    questionSnapshot: z.string().min(1),
    questionRevision: z.number().int().positive(),
    proposedQuestion: z.string().min(1).nullable(),
    reason: z.string().nullable(),
    responseLogicRevision: z.number().int().positive().nullable(),
  })
  .strict();
export type QuestionMaintenancePayload = z.infer<
  typeof questionMaintenancePayloadSchema
>;

const CATEGORY_BY_ACTION = {
  review: "question_review",
  modify: "question_modify",
  delete: "question_delete",
  response_logic_reset: "response_logic_reset",
} as const;

const TITLE_BY_ACTION = {
  review: "自主填写问题审核",
  modify: "修改问题申请",
  delete: "删除问题申请",
  response_logic_reset: "重置应答逻辑申请",
} as const;

function technicalDedupeKey(questionId: string) {
  return `qm:${createHash("sha256").update(questionId).digest("hex").slice(0, 61)}`;
}

export async function ensureQuestionReviewRequest(input: {
  executor: any;
  question: Pick<
    typeof workspaceQuestions.$inferSelect,
    | "id"
    | "userId"
    | "contractId"
    | "quotaPeriodId"
    | "question"
    | "revision"
    | "selectionApprovalStatus"
  >;
  actorUserId: number;
}) {
  if (input.question.selectionApprovalStatus !== "pending") return;
  const dedupeKey = technicalDedupeKey(input.question.id);
  const activeRows = await input.executor
    .select({ id: deliveryTickets.id })
    .from(deliveryTickets)
    .where(
      and(
        eq(deliveryTickets.userId, input.question.userId),
        eq(deliveryTickets.technicalDedupeKey, dedupeKey),
        inArray(deliveryTickets.status, ACTIVE_TICKET_STATUSES),
      ),
    )
    .limit(1)
    .for("update");
  if (activeRows[0]) return;

  const owner = await getMonitoringOwner(input.executor, input.question.userId);
  if (!owner) {
    throw new AuthServiceError(
      "CONFLICT",
      "尚未分配 AI 监控与优化工程师，请联系交付管理员",
    );
  }

  const payload: QuestionMaintenancePayload = {
    version: 1,
    action: "review",
    questionSnapshot: input.question.question,
    questionRevision: input.question.revision,
    proposedQuestion: null,
    reason: null,
    responseLogicRevision: null,
  };
  const ticketId = randomUUID();
  const now = new Date();
  await input.executor.insert(deliveryTickets).values({
    id: ticketId,
    userId: input.question.userId,
    contractId: input.question.contractId,
    quotaPeriodId: input.question.quotaPeriodId,
    type: "knowledge_base",
    quotaPool: null,
    ordinal: 0,
    clientRequestId: randomUUID(),
    category: CATEGORY_BY_ACTION.review,
    topic: input.question.question.slice(0, 512),
    title: TITLE_BY_ACTION.review,
    description: serializeQuestionMaintenancePayload(payload),
    workflowDomain: "monitoring_optimization_engineer",
    operation: "question_maintenance",
    assignedProjectAssignmentId: owner.projectAssignmentId,
    assignedMemberId: owner.memberId,
    sourceQuestionId: input.question.id,
    responseLogicRevision: null,
    technicalDedupeKey: dedupeKey,
    quotaState: "consumed",
    status: "submitted",
    revision: 1,
    createdByUserId: input.actorUserId,
    updatedByUserId: input.actorUserId,
    createdAt: now,
    updatedAt: now,
  });
  await input.executor.insert(deliveryTicketEvents).values({
    id: randomUUID(),
    ticketId,
    userId: input.question.userId,
    actorUserId: input.actorUserId,
    actorRole: "user",
    kind: "created",
    visibility: "customer",
    message: `自主填写问题已提交审核：${input.question.question}`,
    toStatus: "submitted",
    createdAt: now,
  });
}

export async function completeQuestionReviewRequest(input: {
  executor: any;
  userId: number;
  questionId: string;
  actorUserId: number;
  actorRole: "admin" | "delivery_member" | "user";
  message?: string;
}) {
  const rows = await input.executor
    .select()
    .from(deliveryTickets)
    .where(
      and(
        eq(deliveryTickets.userId, input.userId),
        eq(deliveryTickets.sourceQuestionId, input.questionId),
        eq(deliveryTickets.operation, "question_maintenance"),
        eq(deliveryTickets.category, CATEGORY_BY_ACTION.review),
        inArray(deliveryTickets.status, ACTIVE_TICKET_STATUSES),
      ),
    )
    .limit(1)
    .for("update");
  const ticket = rows[0];
  if (!ticket) return;
  const now = new Date();
  const message =
    input.message?.trim() || "自主填写问题已通过专业审核并进入当前服务。";
  await input.executor
    .update(deliveryTickets)
    .set({
      status: "completed",
      publicSummary: message,
      technicalDedupeKey: null,
      resolvedAt: now,
      revision: sql`${deliveryTickets.revision} + 1`,
      updatedByUserId: input.actorUserId,
      updatedAt: now,
    })
    .where(
      and(
        eq(deliveryTickets.id, ticket.id),
        eq(deliveryTickets.revision, ticket.revision),
      ),
    );
  await input.executor.insert(deliveryTicketEvents).values({
    id: randomUUID(),
    ticketId: ticket.id,
    userId: input.userId,
    actorUserId: input.actorUserId,
    actorRole: input.actorRole,
    kind: "status_change",
    visibility: "customer",
    message,
    fromStatus: ticket.status,
    toStatus: "completed",
    createdAt: now,
  });
}

export function serializeQuestionMaintenancePayload(
  value: QuestionMaintenancePayload,
) {
  return JSON.stringify(questionMaintenancePayloadSchema.parse(value));
}

export function parseQuestionMaintenancePayload(
  value: string | null | undefined,
) {
  if (!value) {
    throw new AuthServiceError("CONFLICT", "需求缺少问题维护内容");
  }
  try {
    return questionMaintenancePayloadSchema.parse(JSON.parse(value));
  } catch {
    throw new AuthServiceError("CONFLICT", "需求问题维护内容无法解析");
  }
}

async function requireDb() {
  const db = await getDb();
  if (!db) {
    throw new AuthServiceError(
      "DATABASE_UNAVAILABLE",
      "Database is not configured",
    );
  }
  return db;
}

async function requireCurrentQuestionScope(userId: number, questionId: string) {
  let portal;
  try {
    portal = await assertServiceWriteAccess(userId);
  } catch (error) {
    if (error instanceof ServiceEntitlementError) {
      throw new AuthServiceError(
        error.code === "DATABASE_UNAVAILABLE"
          ? "DATABASE_UNAVAILABLE"
          : "CONFLICT",
        error.message,
      );
    }
    throw error;
  }
  const question = portal.purchasedQuestions.find(
    (candidate) => candidate.id === questionId,
  );
  if (!question) {
    throw new AuthServiceError("CONFLICT", "只能维护当前有效服务周期内的问题");
  }
  return {
    contractId: question.contractId,
    quotaPeriodId: question.quotaPeriodId,
  };
}

async function getMonitoringOwner(executor: any, userId: number) {
  const rows = await executor
    .select({
      projectAssignmentId: deliveryProjectAssignments.id,
      memberId: deliveryProjectAssignments.engineerUserId,
    })
    .from(deliveryProjectAssignments)
    .innerJoin(users, eq(users.id, deliveryProjectAssignments.engineerUserId))
    .where(
      and(
        eq(deliveryProjectAssignments.customerUserId, userId),
        eq(
          deliveryProjectAssignments.roleType,
          "monitoring_optimization_engineer",
        ),
        eq(users.role, "delivery_member"),
        eq(users.engineerRoleType, "monitoring_optimization_engineer"),
        eq(users.isActive, true),
      ),
    )
    .limit(1)
    .for("update");
  return rows[0] ?? null;
}

function ticketResult(
  ticket: typeof deliveryTickets.$inferSelect,
  payload: QuestionMaintenancePayload,
) {
  return {
    ticket: {
      id: ticket.id,
      status: ticket.status,
      revision: ticket.revision,
      category: ticket.category,
      sourceQuestionId: ticket.sourceQuestionId,
      projectAssignmentId: ticket.assignedProjectAssignmentId,
      assignedMemberId: ticket.assignedMemberId,
      createdAt: ticket.createdAt.getTime(),
    },
    request: payload,
  };
}

export async function submitQuestionMaintenance(input: {
  actor: AuthenticatedUser;
  value: SubmitQuestionMaintenanceInput;
}) {
  if (input.actor.role !== "user") {
    throw new AuthServiceError(
      "INVALID_CREDENTIAL",
      "只有当前用户可以提交问题维护需求",
    );
  }
  const value = submitQuestionMaintenanceSchema.parse(input.value);
  const currentQuestionScope = await requireCurrentQuestionScope(
    input.actor.id,
    value.questionId,
  );
  const db = await requireDb();
  try {
    return await db.transaction(async (tx) => {
      const duplicateRows = await tx
        .select()
        .from(deliveryTickets)
        .where(
          and(
            eq(deliveryTickets.userId, input.actor.id),
            eq(deliveryTickets.clientRequestId, value.clientRequestId),
          ),
        )
        .limit(1)
        .for("update");
      const duplicate = duplicateRows[0];
      if (duplicate) {
        if (
          duplicate.operation !== "question_maintenance" ||
          duplicate.sourceQuestionId !== value.questionId
        ) {
          throw new AuthServiceError("CONFLICT", "该请求编号已用于其他需求");
        }
        const payload = parseQuestionMaintenancePayload(duplicate.description);
        if (payload.action !== value.action) {
          throw new AuthServiceError("CONFLICT", "该请求编号已用于其他操作");
        }
        return ticketResult(duplicate, payload);
      }

      const dedupeKey = technicalDedupeKey(value.questionId);
      const activeRows = await tx
        .select({ id: deliveryTickets.id })
        .from(deliveryTickets)
        .where(
          and(
            eq(deliveryTickets.userId, input.actor.id),
            eq(deliveryTickets.technicalDedupeKey, dedupeKey),
            inArray(deliveryTickets.status, ACTIVE_TICKET_STATUSES),
          ),
        )
        .limit(1)
        .for("update");
      if (activeRows[0]) {
        throw new AuthServiceError(
          "CONFLICT",
          "该问题已有一张维护需求正在处理",
        );
      }

      const questionRows = await tx
        .select()
        .from(workspaceQuestions)
        .where(
          and(
            eq(workspaceQuestions.id, value.questionId),
            eq(workspaceQuestions.userId, input.actor.id),
          ),
        )
        .limit(1)
        .for("update");
      const question = questionRows[0];
      if (
        !question ||
        question.status !== "selected" ||
        question.selectionApprovalStatus !== "approved" ||
        !question.locked ||
        question.contractId !== currentQuestionScope.contractId ||
        question.quotaPeriodId !== currentQuestionScope.quotaPeriodId
      ) {
        throw new AuthServiceError(
          "CONFLICT",
          "只能维护已审核并锁定的当前问题",
        );
      }

      const owner = await getMonitoringOwner(tx, input.actor.id);
      if (!owner) {
        throw new AuthServiceError(
          "CONFLICT",
          "尚未分配 AI 监控与优化工程师，请联系交付管理员",
        );
      }

      let responseLogicRevision: number | null = null;
      if (value.action === "response_logic_reset") {
        const logicRows = await tx
          .select({
            revision: responseLogicEntries.revision,
          })
          .from(responseLogicEntries)
          .where(
            and(
              eq(responseLogicEntries.userId, input.actor.id),
              eq(responseLogicEntries.questionId, question.id),
            ),
          )
          .limit(1)
          .for("update");
        const logic = logicRows[0];
        if (!logic) {
          throw new AuthServiceError(
            "CONFLICT",
            "当前问题没有可申请重置的应答逻辑记录",
          );
        }
        responseLogicRevision = logic.revision;
      }

      const payload: QuestionMaintenancePayload = {
        version: 1,
        action: value.action,
        questionSnapshot: question.question,
        questionRevision: question.revision,
        proposedQuestion:
          value.action === "modify" ? value.proposedQuestion : null,
        reason: value.reason?.trim() || null,
        responseLogicRevision,
      };
      const ticketId = randomUUID();
      const now = new Date();
      const ticket = {
        id: ticketId,
        userId: input.actor.id,
        contractId: question.contractId,
        quotaPeriodId: question.quotaPeriodId,
        type: "knowledge_base" as const,
        quotaPool: null,
        ordinal: 0,
        clientRequestId: value.clientRequestId,
        category: CATEGORY_BY_ACTION[value.action],
        topic: question.question.slice(0, 512),
        title: TITLE_BY_ACTION[value.action],
        description: serializeQuestionMaintenancePayload(payload),
        workflowDomain: "monitoring_optimization_engineer" as const,
        operation: "question_maintenance",
        assignedProjectAssignmentId: owner.projectAssignmentId,
        assignedMemberId: owner.memberId,
        sourceQuestionId: question.id,
        responseLogicRevision,
        technicalDedupeKey: dedupeKey,
        quotaState: "consumed" as const,
        status: "submitted" as const,
        revision: 1,
        createdByUserId: input.actor.id,
        updatedByUserId: input.actor.id,
        createdAt: now,
        updatedAt: now,
      };
      await tx.insert(deliveryTickets).values(ticket);
      await tx.insert(deliveryTicketEvents).values({
        id: randomUUID(),
        ticketId,
        userId: input.actor.id,
        actorUserId: input.actor.id,
        actorRole: "user",
        kind: "created",
        visibility: "customer",
        message: `${TITLE_BY_ACTION[value.action]}：${question.question}`,
        toStatus: "submitted",
        createdAt: now,
      });
      return ticketResult(
        ticket as typeof deliveryTickets.$inferSelect,
        payload,
      );
    });
  } catch (error) {
    if ((error as { code?: string }).code === "ER_DUP_ENTRY") {
      throw new AuthServiceError("CONFLICT", "该问题已有一张维护需求正在处理");
    }
    throw error;
  }
}

async function requirePendingQuestionMaintenance(input: {
  actor: AuthenticatedUser;
  projectAssignmentId: string;
  ticketId: string;
  executor: any;
}) {
  const actorRole = deliveryExecutionActorRole(input.actor);
  if (!actorRole) {
    throw new AuthServiceError(
      "INVALID_CREDENTIAL",
      "需要 AI 监控与优化工程师或系统管理员权限",
    );
  }
  const systemAdmin = actorRole === "admin";
  const ticketRows = await input.executor
    .select()
    .from(deliveryTickets)
    .where(eq(deliveryTickets.id, input.ticketId))
    .limit(1)
    .for("update");
  const ticket = ticketRows[0];
  if (
    !ticket ||
    ticket.status !== "submitted" ||
    ticket.operation !== "question_maintenance" ||
    ticket.workflowDomain !== "monitoring_optimization_engineer" ||
    !ticket.assignedProjectAssignmentId ||
    ticket.assignedProjectAssignmentId !== input.projectAssignmentId ||
    !ticket.sourceQuestionId ||
    (!systemAdmin && ticket.assignedMemberId !== input.actor.id)
  ) {
    throw new AuthServiceError("NOT_FOUND", "待审批的问题维护需求不存在");
  }
  const role = await assertDeliveryProjectContext({
    actor: input.actor,
    projectAssignmentId: input.projectAssignmentId,
    customerUserId: ticket.userId,
    expectedRoleType: "monitoring_optimization_engineer",
    executor: input.executor,
  });
  return {
    ticket,
    role,
    actorRole,
  };
}

export async function decideQuestionMaintenance(
  input: {
    actor: AuthenticatedUser;
  } & DecideQuestionMaintenanceInput,
) {
  const value = decideQuestionMaintenanceSchema.parse(input);
  const db = await requireDb();
  const reconcileState: {
    question: InitialMonitoringQuestionSelection | null;
  } = { question: null };
  const result = await db.transaction(async (tx) => {
    const row = await requirePendingQuestionMaintenance({
      actor: input.actor,
      projectAssignmentId: value.projectAssignmentId,
      ticketId: value.ticketId,
      executor: tx,
    });
    if (row.ticket.revision !== value.expectedRevision) {
      throw new AuthServiceError("CONFLICT", "需求已被更新，请刷新后重试");
    }
    const payload = parseQuestionMaintenancePayload(row.ticket.description);
    if (row.ticket.category !== CATEGORY_BY_ACTION[payload.action]) {
      throw new AuthServiceError("CONFLICT", "需求问题维护内容不一致");
    }
    const now = new Date();
    const decisionNote = value.decisionNote?.trim() || null;
    if (value.decision === "reject") {
      const publicSummary = `需求未通过审核：${decisionNote}`;
      if (payload.action === "review") {
        const questionRows = await tx
          .select()
          .from(workspaceQuestions)
          .where(
            and(
              eq(workspaceQuestions.id, row.ticket.sourceQuestionId),
              eq(workspaceQuestions.userId, row.ticket.userId),
            ),
          )
          .limit(1)
          .for("update");
        const question = questionRows[0];
        if (
          !question ||
          question.status !== "candidate" ||
          question.selectionApprovalStatus !== "pending" ||
          question.revision !== payload.questionRevision
        ) {
          throw new AuthServiceError(
            "CONFLICT",
            "待审核问题已更新，请刷新后重试",
          );
        }
        await tx
          .update(workspaceQuestions)
          .set({
            status: "archived",
            selectionApprovalStatus: "not_requested",
            locked: false,
            archivedAt: now,
            revision: sql`${workspaceQuestions.revision} + 1`,
            updatedAt: now,
          })
          .where(
            and(
              eq(workspaceQuestions.id, question.id),
              eq(workspaceQuestions.revision, payload.questionRevision),
            ),
          );
      }
      await tx
        .update(deliveryTickets)
        .set({
          status: "rejected",
          publicSummary,
          technicalDedupeKey: null,
          resolvedAt: now,
          revision: sql`${deliveryTickets.revision} + 1`,
          updatedByUserId: input.actor.id,
          updatedAt: now,
        })
        .where(
          and(
            eq(deliveryTickets.id, row.ticket.id),
            eq(deliveryTickets.revision, value.expectedRevision),
            eq(deliveryTickets.status, "submitted"),
          ),
        );
      await tx.insert(deliveryTicketEvents).values({
        id: randomUUID(),
        ticketId: row.ticket.id,
        userId: row.ticket.userId,
        actorUserId: input.actor.id,
        actorRole: row.actorRole,
        actorContext: {
          projectAssignmentId: value.projectAssignmentId,
          customerUserId: row.role.customerUserId,
          roleType: row.role.roleType,
        },
        kind: "status_change",
        visibility: "customer",
        message: publicSummary,
        fromStatus: "submitted",
        toStatus: "rejected",
        createdAt: now,
      });
      return {
        ticketId: row.ticket.id,
        action: payload.action,
        decision: "rejected" as const,
        replacementQuestionId: null,
      };
    }

    if (payload.action === "review") {
      await approveWorkspaceQuestionSelection(
        {
          userId: row.ticket.userId,
          questionId: row.ticket.sourceQuestionId!,
          expectedRevision: payload.questionRevision,
          actorUserId: input.actor.id,
          category: value.category,
          now,
        },
        {
          executor: tx,
          afterWrite: async (_executor, approvedQuestion) => {
            reconcileState.question = approvedQuestion;
          },
        },
      );
      const publicSummary = "自主填写问题已通过专业审核并进入当前服务。";
      await tx
        .update(deliveryTickets)
        .set({
          status: "completed",
          publicSummary,
          technicalDedupeKey: null,
          resolvedAt: now,
          revision: sql`${deliveryTickets.revision} + 1`,
          updatedByUserId: input.actor.id,
          updatedAt: now,
        })
        .where(
          and(
            eq(deliveryTickets.id, row.ticket.id),
            eq(deliveryTickets.revision, value.expectedRevision),
            eq(deliveryTickets.status, "submitted"),
          ),
        );
      await tx.insert(deliveryTicketEvents).values({
        id: randomUUID(),
        ticketId: row.ticket.id,
        userId: row.ticket.userId,
        actorUserId: input.actor.id,
        actorRole: row.actorRole,
        actorContext: {
          projectAssignmentId: value.projectAssignmentId,
          customerUserId: row.role.customerUserId,
          roleType: row.role.roleType,
        },
        kind: "status_change",
        visibility: "customer",
        message: decisionNote || publicSummary,
        fromStatus: "submitted",
        toStatus: "completed",
        createdAt: now,
      });
      return {
        ticketId: row.ticket.id,
        action: payload.action,
        decision: "approved" as const,
        replacementQuestionId: null,
      };
    }

    const approvalScope = await requireCurrentQuestionScope(
      row.ticket.userId,
      row.ticket.sourceQuestionId!,
    );

    const questionRows = await tx
      .select()
      .from(workspaceQuestions)
      .where(
        and(
          eq(workspaceQuestions.id, row.ticket.sourceQuestionId),
          eq(workspaceQuestions.userId, row.ticket.userId),
        ),
      )
      .limit(1)
      .for("update");
    const question = questionRows[0];
    if (
      !question ||
      question.status !== "selected" ||
      question.selectionApprovalStatus !== "approved" ||
      !question.locked ||
      question.revision !== payload.questionRevision ||
      question.question !== payload.questionSnapshot ||
      !approvalScope ||
      question.contractId !== approvalScope.contractId ||
      question.quotaPeriodId !== approvalScope.quotaPeriodId
    ) {
      throw new AuthServiceError(
        "CONFLICT",
        "目标问题已变更，请关闭旧需求后重新提交",
      );
    }

    const logicRows = await tx
      .select({
        revision: responseLogicEntries.revision,
      })
      .from(responseLogicEntries)
      .where(
        and(
          eq(responseLogicEntries.userId, row.ticket.userId),
          eq(responseLogicEntries.questionId, question.id),
        ),
      )
      .limit(1)
      .for("update");
    const currentLogic = logicRows[0] ?? null;
    if (payload.action === "response_logic_reset") {
      if (
        !currentLogic ||
        currentLogic.revision !== payload.responseLogicRevision ||
        row.ticket.responseLogicRevision !== payload.responseLogicRevision
      ) {
        throw new AuthServiceError(
          "CONFLICT",
          "应答逻辑已变更，请刷新后重新提交需求",
        );
      }
    }

    let replacementQuestionId: string | null = null;
    if (payload.action === "modify") {
      replacementQuestionId = randomUUID();
      await tx
        .update(workspaceQuestions)
        .set({
          status: "archived",
          locked: false,
          archivedAt: now,
          revision: sql`${workspaceQuestions.revision} + 1`,
          updatedAt: now,
        })
        .where(
          and(
            eq(workspaceQuestions.id, question.id),
            eq(workspaceQuestions.revision, payload.questionRevision),
          ),
        );
      await tx.insert(workspaceQuestions).values({
        id: replacementQuestionId,
        userId: question.userId,
        contractId: question.contractId,
        quotaPeriodId: question.quotaPeriodId,
        externalQuestionId: null,
        sourceQuestionId: question.sourceQuestionId ?? question.id,
        candidateKey: null,
        category: question.category,
        question: payload.proposedQuestion!,
        intent: null,
        intentRevision: 1,
        intentConfirmedRevision: null,
        intentConfirmedAt: null,
        intentConfirmedByUserId: null,
        rationale: null,
        evidence: [],
        risks: [],
        source: "user",
        status: "selected",
        selectionApprovalStatus: "approved",
        selectionRequestedAt: now,
        selectionRequestedByUserId: question.userId,
        selectionApprovedAt: now,
        selectionApprovedByUserId: input.actor.id,
        locked: true,
        sourceTaskId: null,
        knowledgeSnapshotId: question.knowledgeSnapshotId,
        ordinal: question.ordinal,
        revision: 1,
        selectedAt: now,
        archivedAt: null,
        createdByUserId: question.userId,
        createdAt: now,
        updatedAt: now,
      });
    } else if (payload.action === "delete") {
      await tx
        .update(workspaceQuestions)
        .set({
          status: "archived",
          locked: false,
          archivedAt: now,
          revision: sql`${workspaceQuestions.revision} + 1`,
          updatedAt: now,
        })
        .where(
          and(
            eq(workspaceQuestions.id, question.id),
            eq(workspaceQuestions.revision, payload.questionRevision),
          ),
        );
    }

    if (payload.action === "response_logic_reset") {
      const deleteResult = await tx
        .delete(responseLogicEntries)
        .where(
          and(
            eq(responseLogicEntries.userId, row.ticket.userId),
            eq(responseLogicEntries.questionId, question.id),
            eq(responseLogicEntries.revision, payload.responseLogicRevision!),
          ),
        );
      if (!deleteResult?.[0]?.affectedRows) {
        throw new AuthServiceError(
          "CONFLICT",
          "应答逻辑已变更，请刷新后重新提交需求",
        );
      }
    }

    const publicSummary =
      payload.action === "modify"
        ? "问题修改申请已通过，原问题已替换，新问题可重新进入应答逻辑确认。"
        : payload.action === "delete"
          ? "问题删除申请已通过，问题已删除。"
          : "应答逻辑修改申请已通过，原应答逻辑已清空，可从问题优化重新确认。";
    await tx
      .update(deliveryTickets)
      .set({
        status: "completed",
        publicSummary,
        technicalDedupeKey: null,
        resolvedAt: now,
        revision: sql`${deliveryTickets.revision} + 1`,
        updatedByUserId: input.actor.id,
        updatedAt: now,
      })
      .where(
        and(
          eq(deliveryTickets.id, row.ticket.id),
          eq(deliveryTickets.revision, value.expectedRevision),
          eq(deliveryTickets.status, "submitted"),
        ),
      );
    await tx.insert(deliveryTicketEvents).values({
      id: randomUUID(),
      ticketId: row.ticket.id,
      userId: row.ticket.userId,
      actorUserId: input.actor.id,
      actorRole: row.actorRole,
      actorContext: {
        projectAssignmentId: value.projectAssignmentId,
        customerUserId: row.role.customerUserId,
        roleType: row.role.roleType,
      },
      kind: "status_change",
      visibility: "customer",
      message: decisionNote || publicSummary,
      fromStatus: "submitted",
      toStatus: "completed",
      createdAt: now,
    });
    return {
      ticketId: row.ticket.id,
      action: payload.action,
      decision: "approved" as const,
      replacementQuestionId,
    };
  });
  if (result.action === "review" && !reconcileState.question) {
    throw new AuthServiceError("CONFLICT", "问题审核结果缺少当前服务范围");
  }
  if (reconcileState.question) {
    await reconcileInitialMonitoringAfterQuestionSelection({
      question: reconcileState.question,
      actorUserId: input.actor.id,
    });
  }
  return result;
}
