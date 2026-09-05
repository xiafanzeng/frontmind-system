import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getDb: vi.fn(),
}));

vi.mock("./db", () => ({
  getDb: mocks.getDb,
}));

import { responseLogicEntries } from "../drizzle/schema";
import type {
  ResponseLogicDraft,
  SaveResponseLogicInput,
} from "../shared/response-logic";
import {
  ResponseLogicRevisionConflictError,
  saveResponseLogicEntriesBatch,
} from "./response-logic-service";

const USER_ID = 42;
const NOW = new Date("2026-07-28T00:00:00.000Z");

function draft(label: string): ResponseLogicDraft {
  return {
    concern: `${label} 用户关心`,
    conclusion: `${label} 核心结论`,
    facts: `${label} 企业事实`,
    pending: "",
    boundaries: `${label} 表达边界`,
    references: `${label} 引用规则`,
    images: [],
    attachments: [],
  };
}

function row(questionId: string, revision: number) {
  return {
    id: `record-${questionId}`,
    userId: USER_ID,
    questionId,
    groupId: "product",
    groupTitle: "产品场景",
    question: `${questionId} 当前问题`,
    intent: "核验事实",
    summary: "形成正式口径",
    conversationId: null,
    lastTaskId: null,
    skillName: "response-logic-builder",
    skillVersion: "1",
    skillContentHash: null,
    draft: draft(questionId),
    confirmed: null,
    version: 0,
    revision,
    status: "draft",
    createdAt: NOW,
    updatedAt: NOW,
  };
}

function value(questionId: string, publish = true): SaveResponseLogicInput {
  return {
    questionId,
    groupId: "product",
    groupTitle: "产品场景",
    question: `${questionId} 当前问题`,
    intent: "核验事实",
    summary: "形成正式口径",
    draft: draft(`${questionId} 更新`),
    publish,
  };
}

function transactionalDatabase(input: {
  rows: Array<Record<string, any>>;
  failOnUpdate?: number;
}) {
  let committedRows = input.rows.map((item) => ({ ...item }));
  let preflightConsumed = false;
  let auditWritten = false;
  let transactionCount = 0;

  const db = {
    async transaction(callback: (tx: any) => Promise<unknown>) {
      transactionCount += 1;
      const localRows = committedRows.map((item) => ({ ...item }));
      let localPreflightConsumed = preflightConsumed;
      let localAuditWritten = auditWritten;
      let updateIndex = 0;

      const selectedRows = () => localRows;
      const terminal = () => ({
        async for() {
          return selectedRows();
        },
        then(
          resolve: (value: Array<Record<string, any>>) => unknown,
          reject?: (reason: unknown) => unknown,
        ) {
          return Promise.resolve(selectedRows()).then(resolve, reject);
        },
      });
      const tx = {
        select() {
          return {
            from(table: unknown) {
              if (table !== responseLogicEntries) {
                throw new Error("unexpected table");
              }
              return {
                where() {
                  return {
                    ...terminal(),
                    orderBy() {
                      return selectedRows();
                    },
                  };
                },
              };
            },
          };
        },
        update(table: unknown) {
          if (table !== responseLogicEntries) {
            throw new Error("unexpected table");
          }
          return {
            set(values: Record<string, any>) {
              return {
                async where() {
                  updateIndex += 1;
                  if (input.failOnUpdate === updateIndex) {
                    throw new Error("simulated response-logic update failure");
                  }
                  const target = localRows[updateIndex - 1]!;
                  localRows[updateIndex - 1] = { ...target, ...values };
                },
              };
            },
          };
        },
        insert(table: unknown) {
          if (table !== responseLogicEntries) {
            throw new Error("unexpected table");
          }
          return {
            async values(values: Record<string, any>) {
              localRows.push(values);
            },
          };
        },
        async consumePreflight() {
          localPreflightConsumed = true;
        },
        async writeAudit() {
          localAuditWritten = true;
        },
      };

      const result = await callback(tx);
      committedRows = localRows;
      preflightConsumed = localPreflightConsumed;
      auditWritten = localAuditWritten;
      return result;
    },
  };

  return {
    db,
    get rows() {
      return committedRows;
    },
    get preflightConsumed() {
      return preflightConsumed;
    },
    get auditWritten() {
      return auditWritten;
    },
    get transactionCount() {
      return transactionCount;
    },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("response-logic template atomic publication", () => {
  it("checks every record version and commits the batch, preflight and audit once", async () => {
    const database = transactionalDatabase({
      rows: [row("question-1", 3), row("question-2", 8)],
    });
    mocks.getDb.mockResolvedValue(database.db);

    const records = await saveResponseLogicEntriesBatch({
      userId: USER_ID,
      entries: [
        { expectedRevision: 3, value: value("question-1") },
        { expectedRevision: 8, value: value("question-2", false) },
      ],
      beforeWrite: (tx) => tx.consumePreflight(),
      afterWrite: (tx) => tx.writeAudit(),
    });

    expect(database.transactionCount).toBe(1);
    expect(database.preflightConsumed).toBe(true);
    expect(database.auditWritten).toBe(true);
    expect(database.rows.map((item) => item.revision)).toEqual([4, 9]);
    expect(records.map((record) => record.revision)).toEqual([4, 9]);
    expect(records[0]?.confirmed?.version).toBe(1);
    expect(records[1]?.confirmed).toBeUndefined();
  });

  it("rejects a stale row version and rolls back preflight consumption", async () => {
    const initialRows = [row("question-1", 4), row("question-2", 8)];
    const database = transactionalDatabase({ rows: initialRows });
    mocks.getDb.mockResolvedValue(database.db);

    await expect(
      saveResponseLogicEntriesBatch({
        userId: USER_ID,
        entries: [
          { expectedRevision: 3, value: value("question-1") },
          { expectedRevision: 8, value: value("question-2") },
        ],
        beforeWrite: (tx) => tx.consumePreflight(),
        afterWrite: (tx) => tx.writeAudit(),
      }),
    ).rejects.toBeInstanceOf(ResponseLogicRevisionConflictError);

    expect(database.rows).toEqual(initialRows);
    expect(database.preflightConsumed).toBe(false);
    expect(database.auditWritten).toBe(false);
  });

  it("rolls back all records and the preflight when a later write fails", async () => {
    const initialRows = [row("question-1", 3), row("question-2", 8)];
    const database = transactionalDatabase({
      rows: initialRows,
      failOnUpdate: 2,
    });
    mocks.getDb.mockResolvedValue(database.db);

    await expect(
      saveResponseLogicEntriesBatch({
        userId: USER_ID,
        entries: [
          { expectedRevision: 3, value: value("question-1") },
          { expectedRevision: 8, value: value("question-2") },
        ],
        beforeWrite: (tx) => tx.consumePreflight(),
        afterWrite: (tx) => tx.writeAudit(),
      }),
    ).rejects.toThrow("simulated response-logic update failure");

    expect(database.rows).toEqual(initialRows);
    expect(database.preflightConsumed).toBe(false);
    expect(database.auditWritten).toBe(false);
  });
});
