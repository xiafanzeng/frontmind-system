import { beforeEach, describe, expect, it, vi } from "vitest";

const dependencies = vi.hoisted(() => ({
  getDb: vi.fn(),
}));

vi.mock("./db", () => ({ getDb: dependencies.getDb }));

import { users, workspaceQuestions } from "../drizzle/schema";
import { updateWorkspaceQuestionsByAdminBatch } from "./service-entitlement";

function question(
  id: string,
  revision: number,
  category:
    | "industry"
    | "competitor_comparison"
    | "reputation"
    | "product_scenario",
) {
  return {
    id,
    userId: 42,
    contractId: "contract-1",
    quotaPeriodId: "period-1",
    externalQuestionId: null,
    sourceQuestionId: null,
    candidateKey: `candidate:${id}`,
    category,
    question: `当前问题 ${id}`,
    intent: "当前意图",
    intentRevision: 3,
    intentConfirmedRevision: 3,
    intentConfirmedAt: new Date("2026-07-27T00:00:00.000Z"),
    intentConfirmedByUserId: 42,
    rationale: "当前理由",
    evidence: [],
    risks: [],
    source: "admin" as const,
    status: "selected" as const,
    selectionApprovalStatus: "approved" as const,
    selectionRequestedAt: null,
    selectionRequestedByUserId: null,
    selectionApprovedAt: new Date("2026-07-01T00:00:00.000Z"),
    selectionApprovedByUserId: 7,
    locked: true,
    sourceTaskId: null,
    knowledgeSnapshotId: null,
    ordinal: 0,
    revision,
    selectedAt: new Date("2026-07-01T00:00:00.000Z"),
    archivedAt: null,
    createdByUserId: 7,
    createdAt: new Date("2026-07-01T00:00:00.000Z"),
    updatedAt: new Date("2026-07-27T00:00:00.000Z"),
  };
}

function transactionalDatabase(initialQuestions: ReturnType<typeof question>[]) {
  let committed = initialQuestions.map((row) => ({ ...row }));
  let transactionCount = 0;
  const db = {
    async transaction(callback: (tx: any) => Promise<unknown>) {
      transactionCount += 1;
      const local = committed.map((row) => ({ ...row }));
      let updateIndex = 0;
      const tx = {
        select(selection?: unknown) {
          return {
            from(table: unknown) {
              if (table === users) {
                return {
                  where() {
                    return {
                      limit() {
                        return {
                          async for() {
                            return [{ id: 42 }];
                          },
                        };
                      },
                    };
                  },
                };
              }
              if (table === workspaceQuestions) {
                return {
                  where() {
                    return {
                      async for() {
                        return local;
                      },
                    };
                  },
                };
              }
              throw new Error(`unexpected table selection: ${String(selection)}`);
            },
          };
        },
        update(table: unknown) {
          if (table !== workspaceQuestions) throw new Error("unexpected update");
          return {
            set(values: Record<string, unknown>) {
              return {
                async where() {
                  local[updateIndex] = {
                    ...local[updateIndex]!,
                    ...values,
                  } as ReturnType<typeof question>;
                  updateIndex += 1;
                },
              };
            },
          };
        },
      };
      const result = await callback(tx);
      committed = local;
      return result;
    },
  };
  return {
    db,
    get questions() {
      return committed;
    },
    get transactionCount() {
      return transactionCount;
    },
  };
}

beforeEach(() => {
  dependencies.getDb.mockReset();
});

describe("formal question current-content batch publication", () => {
  it("validates every row before updating and runs preflight and audit hooks in one transaction", async () => {
    const database = transactionalDatabase([
      question("question-1", 4, "industry"),
      question("question-2", 8, "product_scenario"),
    ]);
    dependencies.getDb.mockResolvedValue(database.db);
    const beforeWrite = vi.fn(async () => undefined);
    const afterWrite = vi.fn(async () => undefined);

    const result = await updateWorkspaceQuestionsByAdminBatch({
      userId: 42,
      actorUserId: 7,
      entries: [
        {
          questionId: "question-1",
          expectedRevision: 4,
          category: "industry",
          question: "更新后的行业问题",
          intent: "更新后的行业意图",
          rationale: "更新后的行业理由",
        },
        {
          questionId: "question-2",
          expectedRevision: 8,
          category: "product_scenario",
          question: "更新后的场景问题",
          intent: "更新后的场景意图",
          rationale: "更新后的场景理由",
        },
      ],
      beforeWrite,
      afterWrite,
    });

    expect(database.transactionCount).toBe(1);
    expect(beforeWrite).toHaveBeenCalledOnce();
    expect(afterWrite).toHaveBeenCalledOnce();
    expect(result.map((item) => [item.id, item.revision])).toEqual([
      ["question-1", 5],
      ["question-2", 9],
    ]);
    expect(database.questions.map((item) => item.question)).toEqual([
      "更新后的行业问题",
      "更新后的场景问题",
    ]);
  });

  it("rolls back the whole batch when any formal question revision is stale", async () => {
    const initial = [
      question("question-1", 4, "industry"),
      question("question-2", 8, "product_scenario"),
    ];
    const database = transactionalDatabase(initial);
    dependencies.getDb.mockResolvedValue(database.db);
    const afterWrite = vi.fn(async () => undefined);

    await expect(
      updateWorkspaceQuestionsByAdminBatch({
        userId: 42,
        actorUserId: 7,
        entries: [
          {
            questionId: "question-1",
            expectedRevision: 4,
            category: "industry",
            question: "看似可更新",
            intent: null,
            rationale: null,
          },
          {
            questionId: "question-2",
            expectedRevision: 7,
            category: "product_scenario",
            question: "过期模板",
            intent: null,
            rationale: null,
          },
        ],
        afterWrite,
      }),
    ).rejects.toMatchObject({ code: "QUESTION_REVISION_CONFLICT" });

    expect(database.questions).toEqual(initial);
    expect(afterWrite).not.toHaveBeenCalled();
  });
});
