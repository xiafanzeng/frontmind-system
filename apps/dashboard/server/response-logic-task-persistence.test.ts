import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getDb: vi.fn(),
}));

vi.mock("./db", () => ({
  getDb: mocks.getDb,
}));

import {
  apiCredentials,
  responseLogicEntries,
  upstreamResources,
  workspaceQuestions,
} from "../drizzle/schema";
import {
  ResponseLogicConfirmedError,
  ResponseLogicRevisionConflictError,
  ResponseLogicTaskActiveError,
  ResponseLogicTaskSupersededError,
  assertResponseLogicExpectedTask,
  assertResponseLogicTaskSlotAvailable,
  recordResponseLogicTaskStart,
  requireResponseLogicProviderReadiness,
  responseLogicReleasedContinuationMatches,
  saveResponseLogicEntry,
} from "./response-logic-service";

function awaitedRows(rows: unknown[]) {
  return {
    for: async () => rows,
    then: (
      resolve: (value: unknown[]) => unknown,
      reject?: (reason: unknown) => unknown,
    ) => Promise.resolve(rows).then(resolve, reject),
  };
}

describe("response logic task persistence", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("atomically rejects a result after reset or T1→T2 replacement", () => {
    expect(() =>
      assertResponseLogicExpectedTask({
        questionId: "question-1",
        expectedTaskId: "task-1",
        expectedOperationRevision: 3,
        currentTaskId: null,
        currentRevision: 3,
      }),
    ).toThrow(ResponseLogicTaskSupersededError);
    expect(() =>
      assertResponseLogicExpectedTask({
        questionId: "question-1",
        expectedTaskId: "task-1",
        expectedOperationRevision: 3,
        currentTaskId: "task-2",
        currentRevision: 3,
      }),
    ).toThrow(ResponseLogicTaskSupersededError);
    expect(() =>
      assertResponseLogicExpectedTask({
        questionId: "question-1",
        expectedTaskId: "task-1",
        expectedOperationRevision: 3,
        currentTaskId: "task-1",
        currentRevision: 3,
      }),
    ).not.toThrow();
    expect(() =>
      assertResponseLogicExpectedTask({
        questionId: "question-1",
        expectedTaskId: "task-1",
        expectedOperationRevision: 3,
        currentTaskId: "task-1",
        currentRevision: 4,
      }),
    ).toThrow(ResponseLogicTaskSupersededError);
  });

  it("pins an approved locked service question and exact fresh conversation before Provider I/O", async () => {
    const question = {
      id: "question-1",
      userId: 42,
      status: "selected",
      selectionApprovalStatus: "approved",
      locked: true,
      revision: 7,
      contractId: "contract-1",
      quotaPeriodId: "period-1",
    };
    const record = {
      questionId: "question-1",
      conversationId: "conversation-new",
      lastTaskId: null,
      revision: 4,
      confirmed: null,
    };
    mocks.getDb.mockResolvedValue({
      select: () => ({
        from: (table: unknown) => ({
          where: () => ({
            limit: () =>
              awaitedRows(
                table === workspaceQuestions
                  ? [question]
                  : table === responseLogicEntries
                    ? [record]
                    : [],
              ),
          }),
        }),
      }),
    });

    await expect(
      requireResponseLogicProviderReadiness({
        userId: 42,
        questionId: "question-1",
        conversationId: "conversation-new",
        expectedOperationRevision: 4,
        expectedQuestionScope: {
          revision: 7,
          contractId: "contract-1",
          quotaPeriodId: "period-1",
        },
      }),
    ).resolves.toEqual({
      questionScope: {
        revision: 7,
        contractId: "contract-1",
        quotaPeriodId: "period-1",
      },
      recordRevision: 4,
    });
  });

  it.each([
    ["missing reset row", null, "conversation-new", 4],
    [
      "old conversation",
      {
        questionId: "question-1",
        conversationId: "conversation-old",
        lastTaskId: null,
        revision: 4,
        confirmed: null,
      },
      "conversation-new",
      4,
    ],
    [
      "stale browser revision",
      {
        questionId: "question-1",
        conversationId: "conversation-new",
        lastTaskId: null,
        revision: 5,
        confirmed: null,
      },
      "conversation-new",
      4,
    ],
  ])(
    "rejects %s before Provider I/O",
    async (_label, record, conversationId, expectedOperationRevision) => {
      mocks.getDb.mockResolvedValue({
        select: () => ({
          from: (table: unknown) => ({
            where: () => ({
              limit: () =>
                awaitedRows(
                  table === workspaceQuestions
                    ? [
                        {
                          id: "question-1",
                          userId: 42,
                          status: "selected",
                          selectionApprovalStatus: "approved",
                          locked: true,
                          revision: 7,
                          contractId: "contract-1",
                          quotaPeriodId: "period-1",
                        },
                      ]
                    : table === responseLogicEntries && record
                      ? [record]
                      : [],
                ),
            }),
          }),
        }),
      });

      await expect(
        requireResponseLogicProviderReadiness({
          userId: 42,
          questionId: "question-1",
          conversationId,
          expectedOperationRevision,
          expectedQuestionScope: {
            revision: 7,
            contractId: "contract-1",
            quotaPeriodId: "period-1",
          },
        }),
      ).rejects.toBeInstanceOf(ResponseLogicTaskSupersededError);
    },
  );

  it("rejects an unlocked or out-of-scope question before reading task state", async () => {
    const selectedTables: unknown[] = [];
    mocks.getDb.mockResolvedValue({
      select: () => ({
        from: (table: unknown) => {
          selectedTables.push(table);
          return {
            where: () => ({
              limit: () =>
                awaitedRows(
                  table === workspaceQuestions
                    ? [
                        {
                          id: "question-1",
                          userId: 42,
                          status: "selected",
                          selectionApprovalStatus: "approved",
                          locked: false,
                          revision: 7,
                          contractId: "contract-1",
                          quotaPeriodId: "period-1",
                        },
                      ]
                    : [],
                ),
            }),
          };
        },
      }),
    });

    await expect(
      requireResponseLogicProviderReadiness({
        userId: 42,
        questionId: "question-1",
        conversationId: "conversation-new",
        expectedOperationRevision: 4,
        expectedQuestionScope: {
          revision: 7,
          contractId: "contract-1",
          quotaPeriodId: "period-1",
        },
      }),
    ).rejects.toThrow("不再属于有效服务范围");
    expect(selectedTables).toEqual([workspaceQuestions]);
  });

  it("accepts only the exact bound task and operation revision for a continuation", async () => {
    const question = {
      id: "question-1",
      userId: 42,
      status: "selected",
      selectionApprovalStatus: "approved",
      locked: true,
      revision: 7,
      contractId: "contract-1",
      quotaPeriodId: "period-1",
    };
    const record = {
      questionId: "question-1",
      conversationId: "conversation-new",
      lastTaskId: "task-current",
      revision: 5,
      confirmed: null,
    };
    mocks.getDb.mockResolvedValue({
      select: () => ({
        from: (table: unknown) => ({
          where: () => ({
            limit: () =>
              awaitedRows(table === workspaceQuestions ? [question] : [record]),
          }),
        }),
      }),
    });

    await expect(
      requireResponseLogicProviderReadiness({
        userId: 42,
        questionId: "question-1",
        conversationId: "conversation-new",
        taskId: "task-current",
        expectedOperationRevision: 5,
        expectedQuestionScope: {
          revision: 7,
          contractId: "contract-1",
          quotaPeriodId: "period-1",
        },
      }),
    ).resolves.toMatchObject({ recordRevision: 5 });
  });

  it("never authorizes released legacy continuation from conversation history", async () => {
    await expect(
      responseLogicReleasedContinuationMatches({
        userId: 42,
        conversationId: "conversation-old",
        taskId: "task-old",
      }),
    ).resolves.toBe(false);
    expect(mocks.getDb).not.toHaveBeenCalled();
  });

  it("commits task ownership and the recoverable latest draft in one transaction", async () => {
    const resources: Array<Record<string, any>> = [];
    const now = new Date("2026-08-19T00:00:00.000Z");
    const entries: Array<Record<string, any>> = [
      {
        id: "entry-1",
        userId: 42,
        questionId: "question-1",
        groupId: "basic",
        groupTitle: "产品场景",
        question: "企业有什么核心产品？",
        intent: "核验产品事实",
        summary: "给出可核验的产品口径",
        conversationId: "conversation-1",
        lastTaskId: null,
        skillName: "response-logic-builder",
        skillVersion: "1",
        skillContentHash: null,
        draft: {
          concern: "",
          conclusion: "",
          facts: "",
          pending: "",
          boundaries: "",
          references: "",
          images: [],
          attachments: [],
        },
        confirmed: null,
        version: 0,
        revision: 1,
        status: "draft",
        createdAt: now,
        updatedAt: now,
      },
    ];
    let transactionCount = 0;

    const executor = {
      select: () => ({
        from: (table: unknown) => ({
          where: () => ({
            limit: () =>
              awaitedRows(
                table === apiCredentials
                  ? [{ ownerUserId: 42, status: "active" }]
                  : table === upstreamResources
                    ? resources
                    : table === responseLogicEntries
                      ? entries
                      : [],
              ),
          }),
        }),
      }),
      insert: (table: unknown) => ({
        values: async (value: Record<string, any>) => {
          if (table === upstreamResources) resources.push({ ...value });
          if (table === responseLogicEntries) entries.push({ ...value });
        },
      }),
      update: (table: unknown) => ({
        set: (values: Record<string, any>) => ({
          where: async () => {
            if (table === responseLogicEntries) {
              Object.assign(entries[0]!, values);
            }
            return [{ affectedRows: 1 }];
          },
        }),
      }),
    };
    mocks.getDb.mockResolvedValue({
      ...executor,
      transaction: async (callback: (tx: typeof executor) => unknown) => {
        transactionCount += 1;
        return callback(executor);
      },
    });

    const saved = await recordResponseLogicTaskStart({
      userId: 42,
      apiCredentialId: "credential-1",
      value: {
        questionId: "question-1",
        groupId: "basic",
        groupTitle: "产品场景",
        question: "企业有什么核心产品？",
        intent: "核验产品事实",
        summary: "给出可核验的产品口径",
        conversationId: "conversation-1",
        draft: {
          concern: "",
          conclusion: "",
          facts: "",
          pending: "",
          boundaries: "",
          references: "",
          images: [],
          attachments: [],
        },
      },
      taskId: "task-1",
      skillName: "response-logic-builder",
      skillVersion: "1",
      skillContentHash: "a".repeat(64),
      expectedRecordRevision: 1,
      verifiedAttachments: [],
    });

    expect(transactionCount).toBe(1);
    expect(resources).toEqual([
      expect.objectContaining({
        userId: 42,
        apiCredentialId: "credential-1",
        kind: "task",
        upstreamId: "task-1",
      }),
    ]);
    expect(entries).toEqual([
      expect.objectContaining({
        userId: 42,
        questionId: "question-1",
        lastTaskId: "task-1",
        conversationId: "conversation-1",
        revision: 2,
      }),
    ]);
    expect(saved).toMatchObject({
      questionId: "question-1",
      conversationId: "conversation-1",
      lastTaskId: "task-1",
    });
  });

  it("rejects a second task before claiming its upstream resource", async () => {
    const insert = vi.fn();
    const existingEntries = [
      {
        userId: 42,
        questionId: "question-1",
        lastTaskId: "task-active",
        revision: 1,
      },
    ];
    const executor = {
      select: () => ({
        from: (table: unknown) => ({
          where: () => ({
            limit: () =>
              awaitedRows(
                table === apiCredentials
                  ? [{ ownerUserId: 42, status: "active" }]
                  : table === responseLogicEntries
                    ? existingEntries
                    : [],
              ),
          }),
        }),
      }),
      insert,
    };
    mocks.getDb.mockResolvedValue({
      transaction: async (callback: (tx: typeof executor) => unknown) =>
        callback(executor),
    });

    await expect(
      recordResponseLogicTaskStart({
        userId: 42,
        apiCredentialId: "credential-1",
        value: {
          questionId: "question-1",
          groupId: "basic",
          groupTitle: "产品场景",
          question: "企业有什么核心产品？",
          intent: "核验产品事实",
          summary: "给出可核验的产品口径",
          conversationId: "conversation-2",
          draft: {
            concern: "",
            conclusion: "",
            facts: "",
            pending: "",
            boundaries: "",
            references: "",
            images: [],
            attachments: [],
          },
        },
        taskId: "task-second",
        skillName: "response-logic-builder",
        skillVersion: "1",
        skillContentHash: "b".repeat(64),
        expectedRecordRevision: 1,
        verifiedAttachments: [],
      }),
    ).rejects.toBeInstanceOf(ResponseLogicTaskActiveError);
    expect(insert).not.toHaveBeenCalled();
  });

  it("rejects a new task for a confirmed response logic before claiming its resource", async () => {
    const insert = vi.fn();
    const existingEntries = [
      {
        userId: 42,
        questionId: "question-1",
        lastTaskId: null,
        revision: 1,
        confirmed: {
          concern: "已确认",
          conclusion: "已确认",
          facts: "已确认",
          pending: "",
          boundaries: "已确认",
          references: "已确认",
          images: [],
          attachments: [],
          version: 1,
          updatedAt: "2026-08-07T00:00:00.000Z",
        },
      },
    ];
    const executor = {
      select: () => ({
        from: (table: unknown) => ({
          where: () => ({
            limit: () =>
              awaitedRows(
                table === apiCredentials
                  ? [{ ownerUserId: 42, status: "active" }]
                  : table === responseLogicEntries
                    ? existingEntries
                    : [],
              ),
          }),
        }),
      }),
      insert,
    };
    mocks.getDb.mockResolvedValue({
      transaction: async (callback: (tx: typeof executor) => unknown) =>
        callback(executor),
    });

    await expect(
      recordResponseLogicTaskStart({
        userId: 42,
        apiCredentialId: "credential-1",
        value: {
          questionId: "question-1",
          groupId: "basic",
          groupTitle: "产品场景",
          question: "企业有什么核心产品？",
          intent: "核验产品事实",
          summary: "给出可核验的产品口径",
          conversationId: "conversation-1",
          draft: {
            concern: "",
            conclusion: "",
            facts: "",
            pending: "",
            boundaries: "",
            references: "",
            images: [],
            attachments: [],
          },
        },
        taskId: "task-after-confirmation",
        skillName: "response-logic-builder",
        skillVersion: "1",
        skillContentHash: "b".repeat(64),
        expectedRecordRevision: 1,
        verifiedAttachments: [],
      }),
    ).rejects.toBeInstanceOf(ResponseLogicConfirmedError);
    expect(insert).not.toHaveBeenCalled();
  });

  it("rejects a stale provider preflight revision before claiming the task resource", async () => {
    const insert = vi.fn();
    const executor = {
      select: () => ({
        from: (table: unknown) => ({
          where: () => ({
            limit: () =>
              awaitedRows(
                table === apiCredentials
                  ? [{ ownerUserId: 42, status: "active" }]
                  : table === responseLogicEntries
                    ? [
                        {
                          id: "entry-1",
                          userId: 42,
                          questionId: "question-1",
                          conversationId: "conversation-new",
                          lastTaskId: null,
                          revision: 2,
                          confirmed: null,
                        },
                      ]
                    : [],
              ),
          }),
        }),
      }),
      insert,
    };
    mocks.getDb.mockResolvedValue({
      transaction: async (callback: (tx: typeof executor) => unknown) =>
        callback(executor),
    });

    await expect(
      recordResponseLogicTaskStart({
        userId: 42,
        apiCredentialId: "credential-1",
        value: {
          questionId: "question-1",
          groupId: "basic",
          groupTitle: "产品场景",
          question: "企业有什么核心产品？",
          intent: "核验产品事实",
          summary: "给出可核验的产品口径",
          conversationId: "conversation-new",
          draft: {
            concern: "",
            conclusion: "",
            facts: "",
            pending: "",
            boundaries: "",
            references: "",
            images: [],
            attachments: [],
          },
        },
        taskId: "task-created-upstream",
        skillName: "response-logic-builder",
        skillVersion: "1",
        skillContentHash: "b".repeat(64),
        expectedRecordRevision: 1,
        verifiedAttachments: [],
      }),
    ).rejects.toBeInstanceOf(ResponseLogicRevisionConflictError);
    expect(insert).not.toHaveBeenCalled();
  });

  it("allows only the already-bound task to continue using the slot", () => {
    expect(() =>
      assertResponseLogicTaskSlotAvailable({
        currentTaskId: "task-active",
        incomingTaskId: "task-active",
      }),
    ).not.toThrow();
    expect(() =>
      assertResponseLogicTaskSlotAvailable({
        currentTaskId: "task-active",
        incomingTaskId: "task-second",
      }),
    ).toThrow(ResponseLogicTaskActiveError);
  });

  it("rejects a stale revision or replaced task before writing the locked row", async () => {
    const update = vi.fn();
    const existingEntry = {
      id: "entry-1",
      userId: 42,
      questionId: "question-1",
      lastTaskId: "task-2",
      revision: 4,
      confirmed: null,
      draft: {
        concern: "旧内容",
        conclusion: "旧内容",
        facts: "旧内容",
        pending: "",
        boundaries: "旧内容",
        references: "旧内容",
        images: [],
        attachments: [],
      },
    };
    const executor = {
      select: () => ({
        from: (table: unknown) => ({
          where: () => ({
            limit: () =>
              awaitedRows(
                table === responseLogicEntries ? [existingEntry] : [],
              ),
          }),
        }),
      }),
      update,
    };
    mocks.getDb.mockResolvedValue({
      ...executor,
      transaction: async (callback: (tx: typeof executor) => unknown) =>
        callback(executor),
    });

    await expect(
      saveResponseLogicEntry({
        userId: 42,
        value: {
          questionId: "question-1",
          groupId: "basic",
          groupTitle: "产品场景",
          question: "企业有什么核心产品？",
          intent: "核验产品事实",
          summary: "给出可核验的产品口径",
          expectedRevision: 3,
          draft: {
            concern: "新内容",
            conclusion: "新内容",
            facts: "新内容",
            pending: "",
            boundaries: "新内容",
            references: "新内容",
            images: [],
            attachments: [],
          },
          publish: false,
        },
      }),
    ).rejects.toBeInstanceOf(ResponseLogicRevisionConflictError);

    await expect(
      saveResponseLogicEntry({
        userId: 42,
        value: {
          questionId: "question-1",
          groupId: "basic",
          groupTitle: "产品场景",
          question: "企业有什么核心产品？",
          intent: "核验产品事实",
          summary: "给出可核验的产品口径",
          expectedRevision: 4,
          expectedTaskId: "task-1",
          draft: {
            concern: "新内容",
            conclusion: "新内容",
            facts: "新内容",
            pending: "",
            boundaries: "新内容",
            references: "新内容",
            images: [],
            attachments: [],
          },
          publish: false,
        },
      }),
    ).rejects.toBeInstanceOf(ResponseLogicTaskSupersededError);
    expect(update).not.toHaveBeenCalled();
  });

  it("does not recreate response logic after maintenance archived the question", async () => {
    const insert = vi.fn();
    const executor = {
      select: () => ({
        from: (table: unknown) => ({
          where: () => ({
            limit: () =>
              awaitedRows(
                table === apiCredentials
                  ? [{ ownerUserId: 42, status: "active" }]
                  : table === workspaceQuestions
                    ? [
                        {
                          id: "question-1",
                          userId: 42,
                          status: "archived",
                          selectionApprovalStatus: "approved",
                          locked: false,
                        },
                      ]
                    : [],
              ),
          }),
        }),
      }),
      insert,
    };
    mocks.getDb.mockResolvedValue({
      transaction: async (callback: (tx: typeof executor) => unknown) =>
        callback(executor),
    });

    await expect(
      recordResponseLogicTaskStart({
        userId: 42,
        apiCredentialId: "credential-1",
        value: {
          questionId: "question-1",
          groupId: "basic",
          groupTitle: "产品场景",
          question: "企业有什么核心产品？",
          intent: "核验产品事实",
          summary: "给出可核验的产品口径",
          conversationId: "conversation-1",
          draft: {
            concern: "",
            conclusion: "",
            facts: "",
            pending: "",
            boundaries: "",
            references: "",
            images: [],
            attachments: [],
          },
        },
        taskId: "task-after-archive",
        skillName: "response-logic-builder",
        skillVersion: "1",
        skillContentHash: "c".repeat(64),
        expectedRecordRevision: 1,
        verifiedAttachments: [],
      }),
    ).rejects.toThrow("不再可编辑");
    expect(insert).not.toHaveBeenCalled();
  });

  it("fails closed when a scoped question was deleted before task persistence", async () => {
    const insert = vi.fn();
    const executor = {
      select: () => ({
        from: (table: unknown) => ({
          where: () => ({
            limit: () =>
              awaitedRows(
                table === apiCredentials
                  ? [{ ownerUserId: 42, status: "active" }]
                  : [],
              ),
          }),
        }),
      }),
      insert,
    };
    mocks.getDb.mockResolvedValue({
      transaction: async (callback: (tx: typeof executor) => unknown) =>
        callback(executor),
    });

    await expect(
      recordResponseLogicTaskStart({
        userId: 42,
        apiCredentialId: "credential-1",
        expectedQuestionScope: {
          revision: 3,
          contractId: "contract-1",
          quotaPeriodId: "period-1",
        },
        value: {
          questionId: "question-1",
          groupId: "basic",
          groupTitle: "产品场景",
          question: "企业有什么核心产品？",
          intent: "核验产品事实",
          summary: "给出可核验的产品口径",
          conversationId: "conversation-1",
          draft: {
            concern: "",
            conclusion: "",
            facts: "",
            pending: "",
            boundaries: "",
            references: "",
            images: [],
            attachments: [],
          },
        },
        taskId: "task-after-delete",
        skillName: "response-logic-builder",
        skillVersion: "1",
        skillContentHash: "d".repeat(64),
        expectedRecordRevision: 1,
        verifiedAttachments: [],
      }),
    ).rejects.toThrow("已不存在");
    expect(insert).not.toHaveBeenCalled();
  });

  it("does not relabel an existing task with a newer Skill during continuation", async () => {
    const now = new Date("2026-08-05T00:00:00.000Z");
    const draft = {
      concern: "",
      conclusion: "",
      facts: "",
      pending: "",
      boundaries: "",
      references: "",
      images: [],
      attachments: [],
    };
    const existingEntry = {
      id: "entry-1",
      userId: 42,
      questionId: "question-1",
      groupId: "basic",
      groupTitle: "产品场景",
      question: "企业有什么核心产品？",
      intent: "核验产品事实",
      summary: "给出可核验的产品口径",
      conversationId: "conversation-1",
      lastTaskId: "task-1",
      skillName: "response-logic-builder",
      skillVersion: "1",
      skillContentHash: "a".repeat(64),
      draft,
      confirmed: null,
      revision: 1,
      version: 0,
      status: "draft",
      createdAt: now,
      updatedAt: now,
    };
    let updatedValues: Record<string, unknown> | null = null;
    const executor = {
      select: () => ({
        from: (table: unknown) => ({
          where: () => ({
            limit: () =>
              awaitedRows(
                table === apiCredentials
                  ? [{ ownerUserId: 42, status: "active" }]
                  : table === upstreamResources
                    ? [{ userId: 42, upstreamId: "task-1" }]
                    : table === responseLogicEntries
                      ? [existingEntry]
                      : [],
              ),
          }),
        }),
      }),
      insert: () => ({ values: async () => undefined }),
      update: () => ({
        set: (values: Record<string, unknown>) => {
          updatedValues = values;
          return { where: async () => [{ affectedRows: 1 }] };
        },
      }),
    };
    mocks.getDb.mockResolvedValue({
      ...executor,
      transaction: async (callback: (tx: typeof executor) => unknown) =>
        callback(executor),
    });

    await recordResponseLogicTaskStart({
      userId: 42,
      apiCredentialId: "credential-1",
      value: {
        questionId: "question-1",
        groupId: "basic",
        groupTitle: "产品场景",
        question: "企业有什么核心产品？",
        intent: "核验产品事实",
        summary: "给出可核验的产品口径",
        conversationId: "conversation-1",
        draft,
      },
      taskId: "task-1",
      skillName: "response-logic-builder",
      skillVersion: "2",
      skillContentHash: "b".repeat(64),
      preserveExistingSkillBinding: true,
      expectedRecordRevision: 1,
      verifiedAttachments: [],
    });

    expect(updatedValues).toMatchObject({
      skillName: "response-logic-builder",
      skillVersion: "1",
      skillContentHash: "a".repeat(64),
    });
  });
});
