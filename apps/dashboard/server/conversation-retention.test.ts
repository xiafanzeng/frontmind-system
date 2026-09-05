import { describe, expect, it, vi } from "vitest";
import type { Connection } from "mysql2/promise";

import {
  CONVERSATION_RETENTION_LOCK_NAME,
  cleanupExpiredConversations,
  getConversationRetentionCutoff,
  runConversationRetentionCleanup,
} from "./conversation-retention";

describe("conversation retention", () => {
  it("computes a 30-day rolling cutoff", () => {
    const now = new Date("2026-07-14T12:00:00.000Z");
    expect(getConversationRetentionCutoff(30, now).toISOString()).toBe(
      "2026-06-14T12:00:00.000Z",
    );
  });

  it("deletes conversations by last update and relies on foreign-key cascades", async () => {
    const execute = vi.fn().mockImplementation(async (query: string) => {
      if (
        query.includes("FROM knowledge_base_conversation_retention_tombstones")
      ) {
        return [[]];
      }
      if (query.includes("SELECT id") && query.includes("FROM conversations")) {
        return [
          [
            { id: "u7:conversation-1", userId: 7 },
            { id: "conversation-2", userId: 7 },
          ],
        ];
      }
      if (query.includes("SELECT EXISTS(")) {
        return [[{ remaining: 0 }]];
      }
      if (query.includes("DELETE FROM conversations")) {
        return [{ affectedRows: 2 }];
      }
      if (query.includes("FROM knowledge_base_builds")) {
        return [[]];
      }
      if (query.includes("SELECT COUNT(*)") && query.includes("messages")) {
        return [[{ count: 4 }]];
      }
      if (query.includes("SELECT COUNT(*)") && query.includes("attachments")) {
        return [[{ count: 2 }]];
      }
      if (
        query.includes("SELECT COUNT(*)") &&
        query.includes("conversation_turns")
      ) {
        return [[{ count: 1 }]];
      }
      if (query.includes("FROM upstream_resources")) return [[]];
      throw new Error(`Unexpected query: ${query}`);
    });
    const connection = {
      beginTransaction: vi.fn().mockResolvedValue(undefined),
      execute,
      commit: vi.fn().mockResolvedValue(undefined),
      rollback: vi.fn().mockResolvedValue(undefined),
    } as unknown as Connection;

    const result = await cleanupExpiredConversations(
      connection,
      30,
      new Date("2026-07-14T12:00:00.000Z"),
    );

    expect(execute).toHaveBeenCalledWith(
      expect.stringContaining("DELETE FROM conversations"),
      [
        "u7:conversation-1",
        "conversation-2",
        new Date("2026-06-14T12:00:00.000Z"),
      ],
    );
    expect(result.conversations).toBe(2);
    expect(result.messages).toBe(4);
    expect(result.attachments).toBe(2);
    expect(result.turns).toBe(1);
    expect(result.batches).toBe(1);
    expect(result.truncated).toBe(false);
    const candidateQuery = execute.mock.calls.find(
      ([query]) =>
        String(query).includes("SELECT id") &&
        String(query).includes("FROM conversations"),
    )?.[0] as string;
    const deleteQuery = execute.mock.calls.find(([query]) =>
      String(query).includes("DELETE FROM conversations"),
    )?.[0] as string;
    for (const query of [candidateQuery, deleteQuery]) {
      expect(query).not.toContain("NOT EXISTS");
      expect(query).not.toContain("FROM knowledge_base_builds");
    }
    const conversationSelectCalls = execute.mock.calls
      .map(([query], index) => ({ query: String(query), index }))
      .filter(
        ({ query }) =>
          query.includes("SELECT id, userId") &&
          query.includes("FROM conversations"),
      );
    const buildLockIndex = execute.mock.calls.findIndex(
      ([query]) =>
        String(query).includes("FROM knowledge_base_builds") &&
        String(query).includes("WHERE userId = ?"),
    );
    expect(conversationSelectCalls).toHaveLength(2);
    expect(conversationSelectCalls[0]?.query).not.toContain("FOR UPDATE");
    expect(conversationSelectCalls[1]?.query).toContain("FOR UPDATE");
    expect(conversationSelectCalls[0]!.index).toBeLessThan(buildLockIndex);
    expect(buildLockIndex).toBeLessThan(conversationSelectCalls[1]!.index);
    expect(connection.commit).toHaveBeenCalledTimes(1);
    expect(connection.rollback).not.toHaveBeenCalled();
  });

  it("reports a truncated backlog after reaching the bounded batch limit", async () => {
    const execute = vi.fn().mockImplementation(async (query: string) => {
      if (
        query.includes("FROM knowledge_base_conversation_retention_tombstones")
      ) {
        return [[]];
      }
      if (query.includes("SELECT id") && query.includes("FROM conversations")) {
        return [[{ id: "u7:conversation-1", userId: 7 }]];
      }
      if (query.includes("SELECT EXISTS(")) {
        return [[{ remaining: 1 }]];
      }
      if (query.includes("DELETE FROM conversations")) {
        return [{ affectedRows: 1 }];
      }
      if (query.includes("FROM knowledge_base_builds")) {
        return [[]];
      }
      if (query.includes("SELECT COUNT(*)")) return [[{ count: 0 }]];
      if (query.includes("FROM upstream_resources")) return [[]];
      throw new Error(`Unexpected query: ${query}`);
    });
    const connection = {
      beginTransaction: vi.fn().mockResolvedValue(undefined),
      execute,
      commit: vi.fn().mockResolvedValue(undefined),
      rollback: vi.fn().mockResolvedValue(undefined),
    } as unknown as Connection;

    const result = await cleanupExpiredConversations(
      connection,
      30,
      new Date("2026-07-14T12:00:00.000Z"),
      { batchSize: 1, maxBatches: 1 },
    );

    expect(result).toMatchObject({
      batches: 1,
      conversations: 1,
      truncated: true,
    });
  });

  it("tombstones and deletes an idle knowledge-base build with its conversation", async () => {
    const execute = vi.fn().mockImplementation(async (query: string) => {
      if (
        query.includes("FROM knowledge_base_conversation_retention_tombstones")
      ) {
        return [[]];
      }
      if (query.includes("SELECT id") && query.includes("FROM conversations")) {
        return [[{ id: "u7:knowledge-conversation", userId: 7 }]];
      }
      if (query.includes("SELECT EXISTS(")) {
        return [[{ remaining: 0 }]];
      }
      if (query.includes("FROM knowledge_base_builds")) {
        return [
          [
            {
              id: "10000000-0000-4000-8000-000000000001",
              userId: 7,
              generation: 2,
              conversationId: "knowledge-conversation",
              logoStorageKey: null,
              packageStorageKey: null,
            },
          ],
        ];
      }
      if (query.includes("SELECT COUNT(*)")) return [[{ count: 0 }]];
      if (query.includes("FROM upstream_resources")) return [[]];
      if (
        query.includes(
          "INSERT INTO knowledge_base_conversation_retention_tombstones",
        ) ||
        query.includes("INSERT INTO knowledge_base_reset_cleanup_jobs") ||
        query.includes("DELETE FROM knowledge_base_builds")
      ) {
        return [{ affectedRows: 1 }];
      }
      if (query.includes("DELETE FROM conversations")) {
        return [{ affectedRows: 1 }];
      }
      throw new Error(`Unexpected query: ${query}`);
    });
    const connection = {
      beginTransaction: vi.fn().mockResolvedValue(undefined),
      execute,
      commit: vi.fn().mockResolvedValue(undefined),
      rollback: vi.fn().mockResolvedValue(undefined),
    } as unknown as Connection;

    const result = await cleanupExpiredConversations(
      connection,
      30,
      new Date("2026-07-14T12:00:00.000Z"),
      { batchSize: 1, maxBatches: 1 },
    );

    expect(result.conversations).toBe(1);
    expect(result.knowledgeBuilds).toBe(1);
    expect(
      execute.mock.calls.some(([query]) =>
        String(query).includes(
          "INSERT INTO knowledge_base_conversation_retention_tombstones",
        ),
      ),
    ).toBe(true);
    expect(execute).toHaveBeenCalledWith(
      expect.stringContaining("INSERT INTO knowledge_base_reset_cleanup_jobs"),
      [
        7,
        "knowledge-builds/7/10000000-0000-4000-8000-000000000001/generation-2/upload-evidence",
        "knowledge-builds/7/10000000-0000-4000-8000-000000000001/generation-2/upload-evidence",
        new Date("2026-07-14T12:00:00.000Z"),
        new Date("2026-07-14T12:00:00.000Z"),
      ],
    );
    expect(execute).toHaveBeenCalledWith(
      expect.stringContaining("FROM knowledge_base_builds"),
      [7, "knowledge-conversation"],
    );
    expect(connection.commit).toHaveBeenCalledTimes(1);
    expect(connection.rollback).not.toHaveBeenCalled();
  });

  it("uses a non-blocking advisory lock around scheduled or CLI cleanup", async () => {
    const query = vi
      .fn()
      .mockResolvedValueOnce([[{ acquired: 1 }], undefined])
      .mockResolvedValueOnce([[{ released: 1 }], undefined]);
    const end = vi.fn().mockResolvedValue(undefined);
    const cleanup = vi.fn().mockResolvedValue({
      cutoff: new Date("2026-06-14T12:00:00.000Z"),
      batches: 0,
      truncated: false,
      conversations: 0,
      messages: 0,
      attachments: 0,
      turns: 0,
      fileResourcesQueued: 0,
      taskResourcesDetached: 0,
    });

    const result = await runConversationRetentionCleanup({
      databaseUrl: "mysql://example",
      createConnection: async () => ({ query, end }) as never,
      cleanup,
    });

    expect(result.acquired).toBe(true);
    expect(cleanup).toHaveBeenCalledTimes(1);
    expect(query).toHaveBeenNthCalledWith(
      1,
      "SELECT GET_LOCK(?, 0) AS acquired",
      [CONVERSATION_RETENTION_LOCK_NAME],
    );
    expect(query).toHaveBeenNthCalledWith(
      2,
      "SELECT RELEASE_LOCK(?) AS released",
      [CONVERSATION_RETENTION_LOCK_NAME],
    );
    expect(end).toHaveBeenCalledTimes(1);
  });

  it("keeps scheduled cleanup fixed at 30 days even if a legacy environment override is present", async () => {
    const previous = process.env.FRONTMIND_CONVERSATION_RETENTION_DAYS;
    process.env.FRONTMIND_CONVERSATION_RETENTION_DAYS = "365";
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-14T12:00:00.000Z"));
    try {
      const query = vi
        .fn()
        .mockResolvedValueOnce([[{ acquired: 1 }], undefined])
        .mockResolvedValueOnce([[{ released: 1 }], undefined]);
      const execute = vi.fn().mockImplementation(async (statement: string) => {
        if (statement.includes("SELECT EXISTS(")) {
          return [[{ remaining: 0 }]];
        }
        if (
          statement.includes("SELECT id, userId") &&
          statement.includes("FROM conversations")
        ) {
          return [[]];
        }
        throw new Error(`Unexpected query: ${statement}`);
      });
      const connection = {
        query,
        execute,
        beginTransaction: vi.fn().mockResolvedValue(undefined),
        commit: vi.fn().mockResolvedValue(undefined),
        rollback: vi.fn().mockResolvedValue(undefined),
        end: vi.fn().mockResolvedValue(undefined),
      };

      const result = await runConversationRetentionCleanup({
        databaseUrl: "mysql://example",
        createConnection: async () => connection as never,
      });

      const candidateCall = execute.mock.calls.find(([statement]) =>
        String(statement).includes("SELECT id, userId"),
      );
      expect(candidateCall?.[1]).toEqual([
        new Date("2026-06-14T12:00:00.000Z"),
        100,
      ]);
      expect(result.result?.cutoff).toEqual(
        new Date("2026-06-14T12:00:00.000Z"),
      );
    } finally {
      vi.useRealTimers();
      if (previous === undefined) {
        delete process.env.FRONTMIND_CONVERSATION_RETENTION_DAYS;
      } else {
        process.env.FRONTMIND_CONVERSATION_RETENTION_DAYS = previous;
      }
    }
  });
});
