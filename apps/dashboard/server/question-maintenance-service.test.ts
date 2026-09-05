import { beforeEach, describe, expect, it, vi } from "vitest";

const dependencies = vi.hoisted(() => ({
  getDb: vi.fn(),
  assertDeliveryProjectContext: vi.fn(),
  deliveryExecutionActorRole: vi.fn(),
  assertServiceWriteAccess: vi.fn(),
  approveWorkspaceQuestionSelection: vi.fn(),
  reconcileInitialMonitoringAfterQuestionSelection: vi.fn(),
}));

vi.mock("./db", () => ({ getDb: dependencies.getDb }));
vi.mock("./delivery-role-service", () => ({
  assertDeliveryProjectContext: dependencies.assertDeliveryProjectContext,
  deliveryExecutionActorRole: dependencies.deliveryExecutionActorRole,
  reconcileInitialMonitoringAfterQuestionSelection:
    dependencies.reconcileInitialMonitoringAfterQuestionSelection,
}));
vi.mock("./service-entitlement", () => ({
  assertServiceWriteAccess: dependencies.assertServiceWriteAccess,
  approveWorkspaceQuestionSelection:
    dependencies.approveWorkspaceQuestionSelection,
  ServiceEntitlementError: class ServiceEntitlementError extends Error {},
}));

import {
  deliveryProjectAssignments,
  deliveryTicketEvents,
  deliveryTickets,
  responseLogicEntries,
  workspaceQuestions,
} from "../drizzle/schema";
import { deliveryRoleOwnsOperation } from "../shared/delivery-roles";
import {
  completeQuestionReviewRequest,
  decideQuestionMaintenance,
  parseQuestionMaintenancePayload,
  serializeQuestionMaintenancePayload,
  submitQuestionMaintenance,
  submitQuestionMaintenanceSchema,
  type QuestionMaintenancePayload,
} from "./question-maintenance-service";

const ids = {
  client: "10000000-0000-4000-8000-000000000001",
  question: "20000000-0000-4000-8000-000000000002",
  ticket: "30000000-0000-4000-8000-000000000003",
  assignment: "40000000-0000-4000-8000-000000000004",
  contract: "50000000-0000-4000-8000-000000000005",
  period: "60000000-0000-4000-8000-000000000006",
  snapshot: "70000000-0000-4000-8000-000000000007",
};

const customer = {
  id: 7,
  role: "user",
  username: "customer",
  adminAccessLevel: null,
} as any;
const engineer = {
  id: 91,
  role: "delivery_member",
  username: "monitoring",
  engineerRoleType: "monitoring_optimization_engineer",
  adminAccessLevel: null,
} as any;
const systemAdmin = {
  id: 1,
  role: "admin",
  username: "root",
  adminAccessLevel: "system_admin",
} as any;

function query(rows: Array<Record<string, any>>) {
  const chain = {
    innerJoin() {
      return chain;
    },
    where() {
      return chain;
    },
    orderBy() {
      return chain;
    },
    limit(limit: number) {
      return query(rows.slice(0, limit));
    },
    for() {
      return Promise.resolve(rows);
    },
    then(
      resolve: (value: Array<Record<string, any>>) => unknown,
      reject?: (reason: unknown) => unknown,
    ) {
      return Promise.resolve(rows).then(resolve, reject);
    },
  };
  return chain;
}

type HarnessOptions = {
  ticketSelects?: Array<Array<Record<string, any>>>;
  questionSelects?: Array<Array<Record<string, any>>>;
  logicSelects?: Array<Array<Record<string, any>>>;
  assignmentSelects?: Array<Array<Record<string, any>>>;
  deleteAffectedRows?: number;
};

function createHarness(options: HarnessOptions = {}) {
  const queues = new Map<unknown, Array<Array<Record<string, any>>>>([
    [deliveryTickets, [...(options.ticketSelects ?? [])]],
    [workspaceQuestions, [...(options.questionSelects ?? [])]],
    [responseLogicEntries, [...(options.logicSelects ?? [])]],
    [deliveryProjectAssignments, [...(options.assignmentSelects ?? [])]],
  ]);
  const inserts: Array<{ table: unknown; value: any }> = [];
  const updates: Array<{ table: unknown; value: any }> = [];
  const deletes: Array<{ table: unknown }> = [];
  const tx = {
    select() {
      return {
        from(table: unknown) {
          const rows = queues.get(table)?.shift() ?? [];
          return query(rows);
        },
      };
    },
    insert(table: unknown) {
      return {
        async values(value: any) {
          inserts.push({ table, value });
        },
      };
    },
    update(table: unknown) {
      return {
        set(value: any) {
          updates.push({ table, value });
          return { where: async () => undefined };
        },
      };
    },
    delete(table: unknown) {
      return {
        where: async () => {
          deletes.push({ table });
          return [{ affectedRows: options.deleteAffectedRows ?? 1 }];
        },
      };
    },
  };
  return {
    db: {
      async transaction(callback: (executor: typeof tx) => Promise<unknown>) {
        return callback(tx);
      },
    },
    executor: tx,
    inserts,
    updates,
    deletes,
  };
}

function question(overrides: Record<string, unknown> = {}) {
  return {
    id: ids.question,
    userId: customer.id,
    contractId: ids.contract,
    quotaPeriodId: ids.period,
    sourceQuestionId: null,
    category: "industry",
    question: "硅基流动有什么核心产品？",
    status: "selected",
    selectionApprovalStatus: "approved",
    locked: true,
    knowledgeSnapshotId: ids.snapshot,
    ordinal: 2,
    revision: 3,
    ...overrides,
  };
}

function payload(
  action: QuestionMaintenancePayload["action"],
): QuestionMaintenancePayload {
  return {
    version: 1,
    action,
    questionSnapshot: question().question,
    questionRevision: 3,
    proposedQuestion:
      action === "modify" ? "硅基流动的核心产品和优势是什么？" : null,
    reason: "用户请求调整",
    responseLogicRevision: action === "response_logic_reset" ? 5 : null,
  };
}

function maintenanceTicket(
  action: QuestionMaintenancePayload["action"],
  revision = 1,
) {
  const categories = {
    review: "question_review",
    modify: "question_modify",
    delete: "question_delete",
    response_logic_reset: "response_logic_reset",
  } as const;
  return {
    id: ids.ticket,
    userId: customer.id,
    status: "submitted",
    revision,
    operation: "question_maintenance",
    workflowDomain: "monitoring_optimization_engineer",
    assignedProjectAssignmentId: ids.assignment,
    assignedMemberId: engineer.id,
    sourceQuestionId: ids.question,
    responseLogicRevision: action === "response_logic_reset" ? 5 : null,
    category: categories[action],
    description: serializeQuestionMaintenancePayload(payload(action)),
  };
}

beforeEach(() => {
  dependencies.getDb.mockReset();
  dependencies.assertDeliveryProjectContext.mockReset().mockResolvedValue({
    projectAssignmentId: ids.assignment,
    customerUserId: customer.id,
    roleType: "monitoring_optimization_engineer",
  });
  dependencies.deliveryExecutionActorRole
    .mockReset()
    .mockImplementation((actor: any) =>
      actor.role === "delivery_member" ? "delivery_member" : null,
    );
  dependencies.assertServiceWriteAccess.mockReset().mockResolvedValue({
    purchasedQuestions: [question()],
  });
  dependencies.reconcileInitialMonitoringAfterQuestionSelection
    .mockReset()
    .mockResolvedValue({ id: "initial-monitoring-ticket", created: true });
  dependencies.approveWorkspaceQuestionSelection
    .mockReset()
    .mockImplementation(async (_input, options) => {
      const approvedQuestion = question({
        status: "selected",
        selectionApprovalStatus: "approved",
      });
      await options?.afterWrite?.(options.executor, approvedQuestion);
      return approvedQuestion;
    });
});

describe("question maintenance contract", () => {
  it("owns the operation in the monitoring role and validates action-specific input", () => {
    expect(
      deliveryRoleOwnsOperation(
        "monitoring_optimization_engineer",
        "question_maintenance",
      ),
    ).toBe(true);
    expect(
      deliveryRoleOwnsOperation(
        "content_distribution_engineer",
        "question_maintenance",
      ),
    ).toBe(false);
    expect(
      submitQuestionMaintenanceSchema.safeParse({
        clientRequestId: ids.client,
        questionId: ids.question,
        action: "modify",
      }).success,
    ).toBe(false);
    expect(
      submitQuestionMaintenanceSchema.safeParse({
        clientRequestId: ids.client,
        questionId: ids.question,
        action: "response_logic_reset",
      }).success,
    ).toBe(true);
  });

  it("round-trips the complete snapshot, proposed question and reason", () => {
    const request = payload("modify");
    expect(
      parseQuestionMaintenancePayload(
        serializeQuestionMaintenancePayload(request),
      ),
    ).toEqual(request);
  });

  it("closes an existing review ticket when the same question is confirmed from the brand library", async () => {
    const harness = createHarness({
      ticketSelects: [[maintenanceTicket("review")]],
    });

    await completeQuestionReviewRequest({
      executor: harness.executor,
      userId: customer.id,
      questionId: ids.question,
      actorUserId: customer.id,
      actorRole: "user",
      message: "该自主填写问题已从正式品牌词库确认并进入当前服务。",
    });

    expect(
      harness.updates.find((entry) => entry.table === deliveryTickets)?.value,
    ).toMatchObject({
      status: "completed",
      publicSummary: "该自主填写问题已从正式品牌词库确认并进入当前服务。",
      technicalDedupeKey: null,
    });
    expect(
      harness.inserts.find((entry) => entry.table === deliveryTicketEvents)
        ?.value,
    ).toMatchObject({
      ticketId: ids.ticket,
      actorRole: "user",
      fromStatus: "submitted",
      toStatus: "completed",
    });
  });
});

describe("submitQuestionMaintenance", () => {
  it("rejects an owned historical question outside the current service period", async () => {
    dependencies.assertServiceWriteAccess.mockResolvedValueOnce({
      purchasedQuestions: [],
    });

    await expect(
      submitQuestionMaintenance({
        actor: customer,
        value: {
          clientRequestId: ids.client,
          questionId: ids.question,
          action: "delete",
        },
      }),
    ).rejects.toThrow("当前有效服务周期");
    expect(dependencies.getDb).not.toHaveBeenCalled();
  });

  it("creates a quota-free monitoring ticket for a locked approved question", async () => {
    const harness = createHarness({
      ticketSelects: [[], []],
      questionSelects: [[question()]],
      assignmentSelects: [
        [[{ projectAssignmentId: ids.assignment, memberId: engineer.id }][0]],
      ],
    });
    dependencies.getDb.mockResolvedValue(harness.db);

    const result = await submitQuestionMaintenance({
      actor: customer,
      value: {
        clientRequestId: ids.client,
        questionId: ids.question,
        action: "modify",
        proposedQuestion: "硅基流动的核心产品和优势是什么？",
        reason: "用户请求调整",
      },
    });

    const ticket = harness.inserts.find(
      (entry) => entry.table === deliveryTickets,
    )?.value;
    expect(result).toMatchObject({
      ticket: {
        status: "submitted",
        category: "question_modify",
        sourceQuestionId: ids.question,
      },
      request: { action: "modify", questionRevision: 3 },
    });
    expect(ticket).toMatchObject({
      type: "knowledge_base",
      quotaPool: null,
      quotaState: "consumed",
      ordinal: 0,
      workflowDomain: "monitoring_optimization_engineer",
      operation: "question_maintenance",
      assignedProjectAssignmentId: ids.assignment,
      assignedMemberId: engineer.id,
    });
    expect(ticket.technicalDedupeKey).toHaveLength(64);
    expect(parseQuestionMaintenancePayload(ticket.description)).toMatchObject({
      proposedQuestion: "硅基流动的核心产品和优势是什么？",
      reason: "用户请求调整",
    });
    expect(
      harness.inserts.some((entry) => entry.table === deliveryTicketEvents),
    ).toBe(true);
  });

  it("rejects an additional active ticket for the same question", async () => {
    const harness = createHarness({
      ticketSelects: [[], [{ id: "active-ticket" }]],
      questionSelects: [[question()]],
      assignmentSelects: [
        [{ projectAssignmentId: ids.assignment, memberId: engineer.id }],
      ],
    });
    dependencies.getDb.mockResolvedValue(harness.db);

    await expect(
      submitQuestionMaintenance({
        actor: customer,
        value: {
          clientRequestId: ids.client,
          questionId: ids.question,
          action: "delete",
        },
      }),
    ).rejects.toThrow("已有一张维护需求");
    expect(harness.inserts).toHaveLength(0);
  });

  it("requires an existing response logic record before creating a reset ticket", async () => {
    const harness = createHarness({
      ticketSelects: [[]],
      questionSelects: [[question()]],
      assignmentSelects: [
        [{ projectAssignmentId: ids.assignment, memberId: engineer.id }],
      ],
      logicSelects: [[]],
    });
    dependencies.getDb.mockResolvedValue(harness.db);

    await expect(
      submitQuestionMaintenance({
        actor: customer,
        value: {
          clientRequestId: ids.client,
          questionId: ids.question,
          action: "response_logic_reset",
        },
      }),
    ).rejects.toThrow("没有可申请重置");
  });

  it.each([
    ["failed draft", { revision: 5, status: "draft", lastTaskId: null }],
    ["active draft", { revision: 6, status: "draft", lastTaskId: "task-1" }],
    [
      "confirmed result",
      { revision: 7, status: "confirmed", confirmed: { version: 1 } },
    ],
  ])("captures the exact revision for a %s reset", async (_label, logic) => {
    const harness = createHarness({
      ticketSelects: [[], []],
      questionSelects: [[question()]],
      assignmentSelects: [
        [{ projectAssignmentId: ids.assignment, memberId: engineer.id }],
      ],
      logicSelects: [[logic]],
    });
    dependencies.getDb.mockResolvedValue(harness.db);

    const result = await submitQuestionMaintenance({
      actor: customer,
      value: {
        clientRequestId: ids.client,
        questionId: ids.question,
        action: "response_logic_reset",
      },
    });

    expect(result.request.responseLogicRevision).toBe(logic.revision);
    const ticket = harness.inserts.find(
      (entry) => entry.table === deliveryTickets,
    )?.value;
    expect(ticket.responseLogicRevision).toBe(logic.revision);
    expect(
      parseQuestionMaintenancePayload(ticket.description).responseLogicRevision,
    ).toBe(logic.revision);
  });
});

describe("decideQuestionMaintenance", () => {
  async function approve(action: QuestionMaintenancePayload["action"]) {
    const harness = createHarness({
      ticketSelects: [[maintenanceTicket(action)]],
      questionSelects: [[question()]],
      logicSelects:
        action === "response_logic_reset"
          ? [[{ revision: 5, status: "draft", lastTaskId: "task-active" }]]
          : [],
    });
    dependencies.getDb.mockResolvedValue(harness.db);
    const result = await decideQuestionMaintenance({
      actor: engineer,
      projectAssignmentId: ids.assignment,
      ticketId: ids.ticket,
      expectedRevision: 1,
      decision: "approve",
    });
    return { harness, result };
  }

  it("triggers the idempotent initial-monitoring handoff after approving a review", async () => {
    const { harness, result } = await approve("review");

    expect(result).toMatchObject({
      decision: "approved",
      action: "review",
      replacementQuestionId: null,
    });
    expect(dependencies.approveWorkspaceQuestionSelection).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: customer.id,
        questionId: ids.question,
        actorUserId: engineer.id,
      }),
      expect.objectContaining({
        executor: expect.any(Object),
      }),
    );
    expect(
      dependencies.reconcileInitialMonitoringAfterQuestionSelection,
    ).toHaveBeenCalledWith(
      expect.objectContaining({
        question: expect.objectContaining({
          id: ids.question,
          status: "selected",
          selectionApprovalStatus: "approved",
        }),
        actorUserId: engineer.id,
      }),
    );
    expect(
      harness.updates.find((entry) => entry.table === deliveryTickets)?.value,
    ).toMatchObject({ status: "completed" });
  });

  it("archives the old question and creates a clean approved successor on modify", async () => {
    const { harness, result } = await approve("modify");
    const replacement = harness.inserts.find(
      (entry) => entry.table === workspaceQuestions,
    )?.value;
    expect(result).toMatchObject({
      decision: "approved",
      action: "modify",
      replacementQuestionId: expect.any(String),
    });
    expect(
      harness.updates.find((entry) => entry.table === workspaceQuestions)
        ?.value,
    ).toMatchObject({ status: "archived", locked: false });
    expect(
      harness.updates.find((entry) => entry.table === deliveryTickets)?.value,
    ).toMatchObject({
      status: "completed",
      publicSummary: expect.stringContaining("问题修改申请已通过"),
    });
    expect(replacement).toMatchObject({
      sourceQuestionId: ids.question,
      contractId: ids.contract,
      quotaPeriodId: ids.period,
      category: "industry",
      knowledgeSnapshotId: ids.snapshot,
      ordinal: 2,
      intent: null,
      evidence: [],
      risks: [],
      status: "selected",
      selectionApprovalStatus: "approved",
      locked: true,
    });
    expect(harness.deletes).toHaveLength(0);
  });

  it("archives the old question without creating a successor on delete", async () => {
    const { harness, result } = await approve("delete");
    expect(result).toMatchObject({
      decision: "approved",
      action: "delete",
      replacementQuestionId: null,
    });
    expect(
      harness.updates.find((entry) => entry.table === workspaceQuestions)
        ?.value,
    ).toMatchObject({ status: "archived" });
    expect(
      harness.updates.find((entry) => entry.table === deliveryTickets)?.value,
    ).toMatchObject({
      status: "completed",
      publicSummary: expect.stringContaining("问题删除申请已通过"),
    });
    expect(
      harness.inserts.some((entry) => entry.table === workspaceQuestions),
    ).toBe(false);
    expect(harness.deletes).toHaveLength(0);
  });

  it("clears the exact active response logic revision on reset", async () => {
    const { harness, result } = await approve("response_logic_reset");
    expect(result).toMatchObject({
      decision: "approved",
      action: "response_logic_reset",
    });
    expect(
      harness.updates.some((entry) => entry.table === workspaceQuestions),
    ).toBe(false);
    expect(harness.deletes).toEqual([{ table: responseLogicEntries }]);
    expect(
      harness.updates.find((entry) => entry.table === deliveryTickets)?.value,
    ).toMatchObject({
      status: "completed",
      publicSummary: expect.stringContaining("应答逻辑修改申请已通过"),
    });
  });

  it("fails the reset when the captured response logic revision is stale", async () => {
    const harness = createHarness({
      ticketSelects: [[maintenanceTicket("response_logic_reset")]],
      questionSelects: [[question()]],
      logicSelects: [[{ revision: 6, status: "draft" }]],
    });
    dependencies.getDb.mockResolvedValue(harness.db);

    await expect(
      decideQuestionMaintenance({
        actor: engineer,
        projectAssignmentId: ids.assignment,
        ticketId: ids.ticket,
        expectedRevision: 1,
        decision: "approve",
      }),
    ).rejects.toThrow("应答逻辑已变更");
    expect(harness.deletes).toHaveLength(0);
  });

  it("fails closed when the revision CAS delete loses a concurrent race", async () => {
    const harness = createHarness({
      ticketSelects: [[maintenanceTicket("response_logic_reset")]],
      questionSelects: [[question()]],
      logicSelects: [[{ revision: 5, status: "draft" }]],
      deleteAffectedRows: 0,
    });
    dependencies.getDb.mockResolvedValue(harness.db);

    await expect(
      decideQuestionMaintenance({
        actor: engineer,
        projectAssignmentId: ids.assignment,
        ticketId: ids.ticket,
        expectedRevision: 1,
        decision: "approve",
      }),
    ).rejects.toThrow("应答逻辑已变更");
    expect(
      harness.updates.some((entry) => entry.table === deliveryTickets),
    ).toBe(false);
  });

  it("rejects without changing the question or response logic", async () => {
    const harness = createHarness({
      ticketSelects: [[maintenanceTicket("delete")]],
    });
    dependencies.getDb.mockResolvedValue(harness.db);

    await expect(
      decideQuestionMaintenance({
        actor: engineer,
        projectAssignmentId: ids.assignment,
        ticketId: ids.ticket,
        expectedRevision: 1,
        decision: "reject",
        decisionNote: "当前监控仍需要该问题",
      }),
    ).resolves.toMatchObject({ decision: "rejected" });
    expect(
      harness.updates.some((entry) => entry.table === workspaceQuestions),
    ).toBe(false);
    expect(harness.deletes).toHaveLength(0);
    expect(
      harness.updates.find((entry) => entry.table === deliveryTickets)?.value,
    ).toMatchObject({
      status: "rejected",
      publicSummary: "需求未通过审核：当前监控仍需要该问题",
    });
  });

  it("enforces actor permission and ticket revision CAS", async () => {
    const unauthorizedHarness = createHarness({
      ticketSelects: [[maintenanceTicket("delete")]],
    });
    dependencies.getDb.mockResolvedValue(unauthorizedHarness.db);
    dependencies.deliveryExecutionActorRole.mockReturnValueOnce(null);
    await expect(
      decideQuestionMaintenance({
        actor: customer,
        projectAssignmentId: ids.assignment,
        ticketId: ids.ticket,
        expectedRevision: 1,
        decision: "approve",
      }),
    ).rejects.toThrow("需要 AI 监控");

    const wrongEngineerHarness = createHarness({
      ticketSelects: [[maintenanceTicket("delete")]],
    });
    dependencies.getDb.mockResolvedValue(wrongEngineerHarness.db);
    await expect(
      decideQuestionMaintenance({
        actor: { ...engineer, id: 92 },
        projectAssignmentId: ids.assignment,
        ticketId: ids.ticket,
        expectedRevision: 1,
        decision: "approve",
      }),
    ).rejects.toThrow("待审批的问题维护需求不存在");

    const staleHarness = createHarness({
      ticketSelects: [[maintenanceTicket("delete", 2)]],
    });
    dependencies.getDb.mockResolvedValue(staleHarness.db);
    await expect(
      decideQuestionMaintenance({
        actor: engineer,
        projectAssignmentId: ids.assignment,
        ticketId: ids.ticket,
        expectedRevision: 1,
        decision: "approve",
      }),
    ).rejects.toThrow("需求已被更新");
  });

  it("allows a system administrator to close the assigned maintenance ticket", async () => {
    const harness = createHarness({
      ticketSelects: [[maintenanceTicket("delete")]],
    });
    dependencies.getDb.mockResolvedValue(harness.db);
    dependencies.deliveryExecutionActorRole.mockReturnValueOnce("admin");

    await expect(
      decideQuestionMaintenance({
        actor: systemAdmin,
        projectAssignmentId: ids.assignment,
        ticketId: ids.ticket,
        expectedRevision: 1,
        decision: "reject",
        decisionNote: "暂不调整",
      }),
    ).resolves.toMatchObject({ decision: "rejected" });
    expect(dependencies.assertDeliveryProjectContext).toHaveBeenCalledWith(
      expect.objectContaining({
        actor: systemAdmin,
        expectedRoleType: "monitoring_optimization_engineer",
      }),
    );
  });

  it("rejects a stale question snapshot before applying side effects", async () => {
    const harness = createHarness({
      ticketSelects: [[maintenanceTicket("delete")]],
      questionSelects: [[question({ revision: 4 })]],
    });
    dependencies.getDb.mockResolvedValue(harness.db);

    await expect(
      decideQuestionMaintenance({
        actor: engineer,
        projectAssignmentId: ids.assignment,
        ticketId: ids.ticket,
        expectedRevision: 1,
        decision: "approve",
      }),
    ).rejects.toThrow("目标问题已变更");
    expect(harness.updates).toHaveLength(0);
    expect(harness.deletes).toHaveLength(0);
  });
});
