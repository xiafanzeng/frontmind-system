import { createHash } from "node:crypto";
import { z } from "zod";
import { beforeEach, describe, expect, it, vi } from "vitest";
const dependencies = vi.hoisted(() => ({
  getDb: vi.fn(),
  assertServiceWriteAccess: vi.fn(),
}));
vi.mock("./db", () => ({ getDb: dependencies.getDb }));
vi.mock("./service-entitlement", () => ({
  assertServiceWriteAccess: dependencies.assertServiceWriteAccess,
}));
import {
  responseLogicEntries,
  users,
  workspaceAuditEvents,
  workspaceQuestions,
} from "../drizzle/schema";
import {
  applyQuestionMaintenance,
  applyQuestionMaintenanceSchema,
  questionMaintenanceOperationId,
} from "./question-maintenance-service";
const customer = { id: 7, role: "user", username: "customer" } as any;
const question = {
  id: "20000000-0000-4000-8000-000000000002",
  userId: 7,
  contractId: "contract-1",
  quotaPeriodId: "period-1",
  category: "product_scenario",
  question: "旧的产品问题",
  status: "selected",
  selectionApprovalStatus: "approved",
  locked: true,
  revision: 3,
  ordinal: 0,
};
const request = {
  clientRequestId: "10000000-0000-4000-8000-000000000001",
  questionId: question.id,
  expectedRevision: 3,
};
function chain(rows: any[]): any {
  return {
    where() {
      return this;
    },
    limit() {
      return this;
    },
    for() {
      return Promise.resolve(rows);
    },
    then(resolve: any, reject: any) {
      return Promise.resolve(rows).then(resolve, reject);
    },
  };
}
function harness(
  overrides: { question?: any; logicRevision?: number; prior?: any } = {},
) {
  const inserts: any[] = [],
    updates: any[] = [],
    deletes: any[] = [];
  const tx = {
    select() {
      return {
        from(table: any) {
          return chain(
            table === users
              ? [{ id: 7 }]
              : table === workspaceQuestions
                ? [overrides.question ?? question]
                : table === responseLogicEntries
                  ? [{ revision: overrides.logicRevision ?? 5 }]
                  : table === workspaceAuditEvents && overrides.prior
                    ? [{ metadata: overrides.prior }]
                    : [],
          );
        },
      };
    },
    insert(table: any) {
      return {
        async values(value: any) {
          inserts.push({ table, value });
        },
      };
    },
    update(table: any) {
      return {
        set(value: any) {
          return {
            async where() {
              updates.push({ table, value });
              return [{ affectedRows: 1 }];
            },
          };
        },
      };
    },
    delete(table: any) {
      return {
        async where() {
          deletes.push(table);
          return [{ affectedRows: 1 }];
        },
      };
    },
  };
  dependencies.getDb.mockResolvedValue({
    transaction: async (fn: any) => fn(tx),
  });
  return { inserts, updates, deletes };
}
beforeEach(() => {
  vi.clearAllMocks();
  dependencies.assertServiceWriteAccess.mockResolvedValue({
    purchasedQuestions: [question],
  });
});
describe("direct customer question maintenance", () => {
  it("replaces a question without changing quota category or historical text", async () => {
    const h = harness();
    const result = await applyQuestionMaintenance({
      actor: customer,
      value: { ...request, action: "modify", proposedQuestion: "新的产品问题" },
    });
    expect(result.replacementQuestionId).toBeTruthy();
    expect(h.updates[0].value).toMatchObject({
      status: "archived",
      locked: false,
    });
    expect(
      h.inserts.find((x) => x.table === workspaceQuestions).value,
    ).toMatchObject({
      question: "新的产品问题",
      category: question.category,
      contractId: question.contractId,
      quotaPeriodId: question.quotaPeriodId,
      status: "selected",
      selectionApprovalStatus: "approved",
      locked: true,
      sourceQuestionId: question.id,
    });
    expect(h.inserts).toHaveLength(2);
  });
  it("generates UUID-valid replacement IDs while retaining the existing audit replay key", () => {
    const originalHash = createHash("sha256")
      .update(`question-maintenance:7:${request.clientRequestId}:operation`)
      .digest("hex");
    const originalKey = `${originalHash.slice(0, 8)}-${originalHash.slice(8, 12)}-${originalHash.slice(12, 16)}-${originalHash.slice(16, 20)}-${originalHash.slice(20, 32)}`;
    expect(questionMaintenanceOperationId(7, request.clientRequestId)).toBe(
      originalKey,
    );
    const first = questionMaintenanceOperationId(
      7,
      request.clientRequestId,
      "replacement",
    );
    expect(z.string().uuid().parse(first)).toBe(first);
    expect(first).toMatch(
      /^[a-f0-9]{8}-[a-f0-9]{4}-8[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/,
    );
    expect(
      questionMaintenanceOperationId(7, request.clientRequestId, "replacement"),
    ).toBe(first);
    expect(
      questionMaintenanceOperationId(8, request.clientRequestId, "replacement"),
    ).not.toBe(first);
    expect(
      questionMaintenanceOperationId(
        7,
        "10000000-0000-4000-8000-000000000003",
        "replacement",
      ),
    ).not.toBe(first);
  });
  it("allows the replacement returned by modify to be deleted through the same strict customer API", async () => {
    const modified = harness();
    const result = await applyQuestionMaintenance({
      actor: customer,
      value: { ...request, action: "modify", proposedQuestion: "新的产品问题" },
    });
    const replacement = modified.inserts.find(
      (row) => row.table === workspaceQuestions,
    ).value;
    expect(result.replacementQuestionId).toBe(replacement.id);
    const deletion = applyQuestionMaintenanceSchema.parse({
      action: "delete",
      clientRequestId: "10000000-0000-4000-8000-000000000004",
      questionId: result.replacementQuestionId,
      expectedRevision: replacement.revision,
    });
    dependencies.assertServiceWriteAccess.mockResolvedValue({
      purchasedQuestions: [replacement],
    });
    const deleted = harness({ question: replacement });
    await expect(
      applyQuestionMaintenance({ actor: customer, value: deletion }),
    ).resolves.toEqual({
      action: "delete",
      questionId: replacement.id,
      replacementQuestionId: null,
    });
    expect(deleted.updates[0].value).toMatchObject({
      status: "archived",
      locked: false,
    });
    expect(deleted.deletes).toEqual([]);
  });
  it("keeps rejecting non-RFC UUID question IDs without broadening the customer input schema", () => {
    expect(
      applyQuestionMaintenanceSchema.safeParse({
        ...request,
        action: "delete",
        questionId: "249febf6-65dd-243a-7074-c79bf54b6ce6",
      }).success,
    ).toBe(false);
  });
  it("archives a deleted question without deleting historical responses", async () => {
    const h = harness();
    expect(
      await applyQuestionMaintenance({
        actor: customer,
        value: { ...request, action: "delete" },
      }),
    ).toMatchObject({ action: "delete", replacementQuestionId: null });
    expect(h.deletes).toEqual([]);
    expect(h.updates[0].value.status).toBe("archived");
  });
  it("resets only the current response revision", async () => {
    const h = harness();
    await applyQuestionMaintenance({
      actor: customer,
      value: {
        ...request,
        action: "response_logic_reset",
        expectedResponseLogicRevision: 5,
      },
    });
    expect(h.deletes).toEqual([responseLogicEntries]);
    expect(h.updates).toEqual([]);
  });
  it("rejects a stale response revision without deleting anything", async () => {
    const h = harness({ logicRevision: 6 });
    await expect(
      applyQuestionMaintenance({
        actor: customer,
        value: {
          ...request,
          action: "response_logic_reset",
          expectedResponseLogicRevision: 5,
        },
      }),
    ).rejects.toThrow("应答逻辑已更新");
    expect(h.deletes).toEqual([]);
  });
  it("rejects a stale question revision", async () => {
    const h = harness({ question: { ...question, revision: 4 } });
    await expect(
      applyQuestionMaintenance({
        actor: customer,
        value: { ...request, action: "delete" },
      }),
    ).rejects.toThrow("问题已更新");
    expect(h.updates).toEqual([]);
  });
  it("rejects a question owned by another tenant", async () => {
    const h = harness({ question: { ...question, userId: 8 } });
    await expect(
      applyQuestionMaintenance({
        actor: customer,
        value: { ...request, action: "delete" },
      }),
    ).rejects.toThrow("问题已更新");
    expect(h.updates).toEqual([]);
  });
  it("rejects a question outside the current service scope", async () => {
    const h = harness();
    dependencies.assertServiceWriteAccess.mockResolvedValue({
      purchasedQuestions: [],
    });
    await expect(
      applyQuestionMaintenance({
        actor: customer,
        value: { ...request, action: "delete" },
      }),
    ).rejects.toThrow("当前有效服务周期");
    expect(h.updates).toEqual([]);
  });
  it("replays the same request without applying it twice", async () => {
    const h = harness();
    const value = { ...request, action: "delete" as const };
    const first = await applyQuestionMaintenance({ actor: customer, value });
    const audit = h.inserts.find((x) => x.table === workspaceAuditEvents).value;
    const replay = harness({ prior: audit.metadata });
    await expect(
      applyQuestionMaintenance({ actor: customer, value }),
    ).resolves.toEqual(first);
    expect(replay.updates).toEqual([]);
    expect(replay.inserts).toEqual([]);
  });
  it("rejects reuse of a request id with a different action", async () => {
    harness({ prior: { requestHash: "another" } });
    await expect(
      applyQuestionMaintenance({
        actor: customer,
        value: { ...request, action: "delete" },
      }),
    ).rejects.toThrow("其他操作");
  });
  it("rejects attempts to target an explicit different user", () => {
    expect(
      applyQuestionMaintenanceSchema.safeParse({
        ...request,
        action: "delete",
        userId: 8,
      }).success,
    ).toBe(false);
  });
  it("rejects noncustomer actors before touching data", async () => {
    await expect(
      applyQuestionMaintenance({
        actor: { ...customer, role: "admin" },
        value: { ...request, action: "delete" },
      }),
    ).rejects.toThrow("只有客户");
    expect(dependencies.getDb).not.toHaveBeenCalled();
  });
});
