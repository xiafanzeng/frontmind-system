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
} from "../drizzle/schema";
import {
  ResponseLogicTaskActiveError,
  assertResponseLogicTaskSlotAvailable,
  recordResponseLogicTaskStart,
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

  it("commits task ownership and the recoverable latest draft in one transaction", async () => {
    const resources: Array<Record<string, any>> = [];
    const entries: Array<Record<string, any>> = [];
    let transactionCount = 0;

    const executor = {
      select: () => ({
        from: (table: unknown) => ({
          where: () => ({
            limit: () =>
              awaitedRows(
                table === apiCredentials
                  ? [{ id: "credential-1" }]
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
      update: () => ({
        set: () => ({
          where: async () => undefined,
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
      },
    ];
    const executor = {
      select: () => ({
        from: (table: unknown) => ({
          where: () => ({
            limit: () =>
              awaitedRows(
                table === apiCredentials
                  ? [{ id: "credential-1" }]
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
        verifiedAttachments: [],
      }),
    ).rejects.toBeInstanceOf(ResponseLogicTaskActiveError);
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
});
