import { randomUUID } from "node:crypto";
import mysql, { type Pool, type RowDataPacket } from "mysql2/promise";
import { drizzle } from "drizzle-orm/mysql2";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  bindWorkbenchTask,
  handoffWorkbenchTask,
  readWorkbenchStorage,
  saveWorkbenchTask,
  workbenchStorageMessageId,
} from "./workbench-task-service";
import {
  listSnapshots,
  loadPersistedMessages,
  persistSnapshot,
  runConversationWriteTransaction,
} from "./conversation-router";
import { runWithEnterpriseProjectScope } from "./enterprise-project-context";

const databaseUrl = process.env.FRONTMIND_WORKBENCH_TEST_MYSQL_URL;
const scope = { userId: 101, projectAssignmentId: null };
function deferred<T = void>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((yes) => {
    resolve = yes;
  });
  return { promise, resolve };
}

(databaseUrl ? describe : describe.skip)(
  "workbench transactions on isolated MySQL",
  () => {
    let pool: Pool;
    let db: ReturnType<typeof drizzle>;
    const projectId = randomUUID();
    const inProject = <T>(operation: () => T) =>
      runWithEnterpriseProjectScope(
        {
          enterpriseProjectId: projectId,
          ownerUserId: 101,
          actorUserId: 101,
          isLegacyDefault: false,
        },
        operation,
      );
    const transaction = <T>(operation: (tx: any) => Promise<T>) =>
      inProject(() => runConversationWriteTransaction(db, operation));
    const storageId = (id: string) => `e${projectId}:${id}`;
    const snapshot = async (id: string) =>
      inProject(
        async () =>
          (await listSnapshots(101, null, db)).find((item) => item.id === id)!,
      );
    beforeAll(async () => {
      const url = new URL(databaseUrl!);
      if (
        !["127.0.0.1", "localhost"].includes(url.hostname) ||
        !/^\/[a-zA-Z0-9_]*acceptance[a-zA-Z0-9_]*$/.test(url.pathname)
      )
        throw new Error("Local disposable acceptance database required");
      pool = mysql.createPool({
        uri: databaseUrl,
        connectionLimit: 8,
        timezone: "Z",
      });
      db = drizzle(pool);
      await pool.execute(
        "INSERT INTO enterprise_projects(id,ownerUserId,name) VALUES(?,101,?)",
        [projectId, `Workbench acceptance ${projectId}`],
      );
    });
    afterAll(async () => {
      await pool?.end();
    });

    it("takes an actual InnoDB row lock before revision reads and rejects a concurrent stale save", async () => {
      const id = `lock-${randomUUID()}`;
      await transaction((tx) =>
        bindWorkbenchTask(tx, scope, { conversationId: id, agentId: "media" }),
      );
      const held = deferred();
      const release = deferred();
      const first = transaction(async (tx) => {
        const state = await saveWorkbenchTask(tx, scope, {
          conversationId: id,
          agentId: "media",
          expectedRevision: 1,
          patch: { values: { selected: ["first"] } },
        });
        held.resolve();
        await release.promise;
        return state;
      });
      await held.promise;
      const second = transaction((tx) =>
        saveWorkbenchTask(tx, scope, {
          conversationId: id,
          agentId: "media",
          expectedRevision: 1,
          patch: { values: { selected: ["second"] } },
        }),
      ).then(
        (value) => ({ value, error: null }),
        (error) => ({ value: null, error }),
      );
      let observedWait = false;
      try {
        const deadline = Date.now() + 5000;
        while (Date.now() < deadline) {
          const [rows] = await pool.query<RowDataPacket[]>(
            "SELECT COUNT(*) AS count FROM performance_schema.data_lock_waits AS waiting JOIN performance_schema.data_locks AS requested ON requested.ENGINE_LOCK_ID=waiting.REQUESTING_ENGINE_LOCK_ID WHERE requested.OBJECT_SCHEMA=DATABASE() AND requested.OBJECT_NAME='conversations'",
          );
          if (Number(rows[0]?.count) > 0) {
            observedWait = true;
            break;
          }
          await new Promise((resolve) => setTimeout(resolve, 20));
        }
      } finally {
        release.resolve();
      }
      await first;
      expect(observedWait).toBe(true);
      expect((await second).error).toMatchObject({ code: "CONFLICT" });
      expect((await snapshot(id))?.workbench?.values.selected).toEqual([
        "first",
      ]);
    }, 15000);

    it("commits one target and one source receipt under concurrent handoffs and lost-response replay", async () => {
      const id = `handoff-${randomUUID()}`;
      await transaction((tx) =>
        bindWorkbenchTask(tx, scope, { conversationId: id, agentId: "media" }),
      );
      const input = {
        conversationId: id,
        agentId: "media" as const,
        targetAgentId: "publishing" as const,
        resources: [],
        idempotencyKey: "one-click",
        title: "真实事务交接",
      };
      const [first, second] = await Promise.all([
        transaction((tx) => handoffWorkbenchTask(tx, scope, input)),
        transaction((tx) => handoffWorkbenchTask(tx, scope, input)),
      ]);
      expect(second).toEqual(first);
      // The next call knows only the original request, as after a lost HTTP reply.
      expect(
        await transaction((tx) => handoffWorkbenchTask(tx, scope, input)),
      ).toEqual(first);
      const [targets] = await pool.query<RowDataPacket[]>(
        "SELECT COUNT(*) AS count FROM conversations WHERE id=?",
        [storageId(first.conversationId)],
      );
      expect(Number(targets[0].count)).toBe(1);
      expect(
        (await snapshot(id))?.workbench?.records.filter(
          (item) => item.targetTask,
        ),
      ).toHaveLength(1);
      expect((await snapshot(first.conversationId))?.workbench?.source).toEqual(
        { conversationId: id, agentId: "media" },
      );
      await expect(
        transaction((tx) =>
          handoffWorkbenchTask(tx, scope, {
            ...input,
            targetAgentId: "articles",
          }),
        ),
      ).rejects.toMatchObject({ code: "CONFLICT" });
    });

    it("rolls back both target creation and source receipt if a handoff transaction fails before commit", async () => {
      const id = `rollback-${randomUUID()}`;
      await transaction((tx) =>
        bindWorkbenchTask(tx, scope, { conversationId: id, agentId: "media" }),
      );
      const input = {
        conversationId: id,
        agentId: "media" as const,
        targetAgentId: "publishing" as const,
        resources: [],
        idempotencyKey: "rollback-click",
      };
      let targetId = "";
      await expect(
        transaction(async (tx) => {
          targetId = (await handoffWorkbenchTask(tx, scope, input))
            .conversationId;
          throw new Error("ACCEPTANCE_FAILURE_BEFORE_COMMIT");
        }),
      ).rejects.toThrow("ACCEPTANCE_FAILURE_BEFORE_COMMIT");
      const [rows] = await pool.query<RowDataPacket[]>(
        "SELECT COUNT(*) AS count FROM conversations WHERE id=?",
        [storageId(targetId)],
      );
      expect(Number(rows[0].count)).toBe(0);
      const stored = await readWorkbenchStorage(db, storageId(id));
      expect(stored?.state.revision).toBe(1);
      expect(stored?.handoffs).toEqual({});
      expect(
        (await transaction((tx) => handoffWorkbenchTask(tx, scope, input)))
          .conversationId,
      ).toBe(targetId);
    });

    it("retains business metadata across a stale snapshot rewrite and excludes it from model messages", async () => {
      const id = `snapshot-${randomUUID()}`;
      await transaction((tx) =>
        bindWorkbenchTask(tx, scope, { conversationId: id, agentId: "media" }),
      );
      const saved = await transaction((tx) =>
        saveWorkbenchTask(tx, scope, {
          conversationId: id,
          agentId: "media",
          expectedRevision: 1,
          patch: {
            step: "media-selection",
            values: { selected: ["frozen-choice"] },
            record: {
              id: "selection",
              label: "已选择媒体",
              status: "completed",
            },
          },
        }),
      );
      await transaction((tx) =>
        persistSnapshot(tx, 101, {
          id,
          title: "旧窗口",
          status: "idle",
          messages: [],
          createdAt: 1,
          updatedAt: 2,
          deletedMessageIds: [workbenchStorageMessageId(storageId(id))],
        }),
      );
      expect((await snapshot(id))?.workbench).toEqual(saved);
      expect((await snapshot(id))?.messages).toEqual([]);
      expect(
        await inProject(() =>
          loadPersistedMessages(db, 101, storageId(id), null),
        ),
      ).toEqual([]);
      await expect(
        transaction((tx) =>
          bindWorkbenchTask(tx, scope, {
            conversationId: id,
            agentId: "articles",
          }),
        ),
      ).rejects.toMatchObject({ code: "CONFLICT" });
    });
  },
);
