import { describe, expect, it } from "vitest";
import { MySqlDialect } from "drizzle-orm/mysql-core";
import {
  conversations,
  messages,
  monitoringAccountLinks,
  knowledgeBaseBuilds,
  responseLogicEntries,
  siteProjects,
  agentTasks,
  agentOperations,
} from "../drizzle/schema";
import {
  publisherArticleVersions,
  publisherDrafts,
} from "../../../packages/monitoring-db/src/schema";
import { runWithEnterpriseProjectScope } from "./enterprise-project-context";
import {
  bindWorkbenchTask,
  handoffWorkbenchTask,
  saveWorkbenchTask,
  workbenchStorageMessageId,
} from "./workbench-task-service";
import {
  listSnapshots,
  loadPersistedMessages,
  persistSnapshot,
} from "./conversation-router";

// Executes the actual service, SQL predicates and snapshot serializers against
// a transactional fixture. It deliberately checks SQL ownership predicates;
// returning canned rows would miss a omitted project boundary.
function database() {
  const rows = new Map<any, any[]>();
  const dialect = new MySqlDialect();
  let locks = 0;
  const get = (table: any) => {
    if (!rows.has(table)) rows.set(table, []);
    return rows.get(table)!;
  };
  const matches = (table: any, predicate: any, row: any) => {
    if (!predicate) return true;
    const query = dialect.sqlToQuery(predicate);
    let index = 0;
    let expression = query.sql
      .replace(/\?/g, () => `params[${index++}]`)
      .replace(/`[^`]+`\.`([^`]+)`/g, (_all, name) => {
        const key =
          Object.keys(table).find((key) => table[key]?.name === name) ?? name;
        return `row[${JSON.stringify(key)}]`;
      });
    expression = expression
      .replace(/\bis not null\b/gi, "!= null")
      .replace(/\bis null\b/gi, "== null")
      .replace(/(row\["[^"]+"\]) not in \(([^)]+)\)/gi, "!([$2]).includes($1)")
      .replace(/(row\["[^"]+"\]) in \(([^)]+)\)/gi, "([$2]).includes($1)")
      .replace(/\band\b/gi, "&&")
      .replace(/\bor\b/gi, "||")
      .replace(/ <> /g, " !== ")
      .replace(/(?<![=!<>]) = (?!=)/g, " === ");
    return Function("row", "params", `return ${expression}`)(row, query.params);
  };
  const executor: any = {
    select: (fields?: any) => ({
      from: (table: any) => {
        let predicate: any;
        let count = Infinity;
        const query: any = {
          where: (value: any) => {
            predicate = value;
            return query;
          },
          orderBy: () => query,
          limit: (value: number) => {
            count = value;
            return query;
          },
          for: () => {
            locks++;
            return query;
          },
          then: (resolve: any, reject: any) =>
            Promise.resolve(
              get(table)
                .filter((row) => matches(table, predicate, row))
                .slice(0, count)
                .map((row) =>
                  fields
                    ? Object.fromEntries(
                        Object.entries(fields).map(([key, col]: any) => [
                          key,
                          row[
                            Object.keys(table).find(
                              (key) => table[key]?.name === col?.name,
                            ) ?? key
                          ],
                        ]),
                      )
                    : { ...row },
                ),
            ).then(resolve, reject),
        };
        return query;
      },
    }),
    insert: (table: any) => ({
      values: async (value: any) => {
        if (get(table).some((row) => row.id === value.id))
          throw Object.assign(new Error("duplicate"), { code: "ER_DUP_ENTRY" });
        get(table).push({
          deletedAt: null,
          deletedMessageIds: [],
          apiCredentialId: null,
          taskUrl: null,
          upstreamTaskId: null,
          previousResponseId: null,
          lastKnownOutputLength: 0,
          ...value,
        });
      },
    }),
    update: (table: any) => ({
      set: (value: any) => ({
        where: async (predicate: any) => {
          for (const row of get(table))
            if (matches(table, predicate, row)) Object.assign(row, value);
        },
      }),
    }),
    delete: (table: any) => ({
      where: async (predicate: any) => {
        rows.set(
          table,
          get(table).filter((row) => !matches(table, predicate, row)),
        );
      },
    }),
  };
  let lane = Promise.resolve();
  const transaction = <T>(action: (tx: any) => Promise<T>) => {
    const next = lane.then(() => action(executor));
    lane = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  };
  return { executor, get, transaction, locks: () => locks };
}
const scope = { userId: 7, projectAssignmentId: null };
const project = "10000000-0000-4000-8000-000000000001";
const otherProject = "10000000-0000-4000-8000-000000000002";
const inProject = <T>(id: string, run: () => T) =>
  runWithEnterpriseProjectScope(
    {
      enterpriseProjectId: id,
      ownerUserId: 7,
      actorUserId: 7,
      isLegacyDefault: false,
    },
    run,
  );

describe("durable workbench tasks", () => {
  it("round trips agent identity and flow state without model messages, surviving an old snapshot rewrite", async () => {
    const db = database();
    await db.transaction((tx) =>
      bindWorkbenchTask(tx, scope, {
        conversationId: "media-one",
        agentId: "media",
        title: "选择媒体",
      }),
    );
    const saved = await db.transaction((tx) =>
      saveWorkbenchTask(tx, scope, {
        conversationId: "media-one",
        agentId: "media",
        expectedRevision: 1,
        patch: {
          step: "catalog",
          values: { query: "科技", selected: ["a"] },
          record: {
            id: "filter",
            label: "已筛选科技媒体",
            status: "completed",
          },
        },
      }),
    );
    const [snapshot] = await listSnapshots(7, null, db.executor);
    expect(snapshot.workbenchAgentId).toBe("media");
    expect(snapshot.workbench).toEqual(saved);
    expect(snapshot.messages).toEqual([]);
    expect(
      await loadPersistedMessages(db.executor, 7, "u7:media-one", null),
    ).toEqual([]);
    await persistSnapshot(db.executor, 7, {
      id: "media-one",
      title: "旧窗口",
      messages: [],
      status: "idle",
      createdAt: 1,
      updatedAt: 2,
      deletedMessageIds: [workbenchStorageMessageId("u7:media-one")],
    });
    const [restored] = await listSnapshots(7, null, db.executor);
    expect(restored.workbench).toEqual(saved);
    expect(restored.updatedAt).toBeGreaterThanOrEqual(saved.updatedAt);
    expect(db.get(messages)).toHaveLength(1);
    expect(db.get(messages)[0].sequence).toBe(-1);
  });
  it("serializes concurrent updates and rejects a stale revision without overwriting the winner", async () => {
    const db = database();
    await db.transaction((tx) =>
      bindWorkbenchTask(tx, scope, { conversationId: "one", agentId: "media" }),
    );
    const write = (query: string) =>
      db.transaction((tx) =>
        saveWorkbenchTask(tx, scope, {
          conversationId: "one",
          agentId: "media",
          expectedRevision: 1,
          patch: { values: { query } },
        }),
      );
    const results = await Promise.allSettled([write("first"), write("second")]);
    expect(results[0].status).toBe("fulfilled");
    expect(results[1]).toMatchObject({
      status: "rejected",
      reason: { code: "CONFLICT" },
    });
    expect(
      (await listSnapshots(7, null, db.executor))[0].workbench?.values.query,
    ).toBe("first");
    expect(db.locks()).toBeGreaterThanOrEqual(3);
  });
  it("does not rebind a task through bind or an older browser snapshot", async () => {
    const db = database();
    await bindWorkbenchTask(db.executor, scope, {
      conversationId: "one",
      agentId: "media",
    });
    await expect(
      bindWorkbenchTask(db.executor, scope, {
        conversationId: "one",
        agentId: "articles",
      }),
    ).rejects.toMatchObject({ code: "CONFLICT" });
    await expect(
      persistSnapshot(db.executor, 7, {
        id: "one",
        title: "wrong route",
        workbenchAgentId: "articles",
        messages: [],
        status: "idle",
        createdAt: 1,
        updatedAt: 2,
      }),
    ).rejects.toMatchObject({ code: "CONFLICT" });
  });
  it("hands off one target under double submission and rejects changed payloads for the same intent", async () => {
    const db = database();
    await bindWorkbenchTask(db.executor, scope, {
      conversationId: "source",
      agentId: "media",
    });
    const input = {
      conversationId: "source",
      agentId: "media" as const,
      targetAgentId: "publishing" as const,
      resources: [],
      values: { publicationNote: "优先科技媒体" },
      idempotencyKey: "chosen-version-and-media",
    };
    const [first, second] = await Promise.all([
      db.transaction((tx) => handoffWorkbenchTask(tx, scope, input)),
      db.transaction((tx) => handoffWorkbenchTask(tx, scope, input)),
    ]);
    expect(second).toEqual(first);
    expect(db.get(conversations)).toHaveLength(2);
    expect(first.state.source).toEqual({
      conversationId: "source",
      agentId: "media",
    });
    expect(first.state.values).toEqual(input.values);
    expect(
      (await listSnapshots(7, null, db.executor)).find(
        (item) => item.id === first.conversationId,
      )?.workbench?.values,
    ).toEqual(input.values);
    const source = (await listSnapshots(7, null, db.executor)).find(
      (item) => item.id === "source",
    )!;
    expect(source.workbench?.records[0].targetTask).toEqual({
      conversationId: first.conversationId,
      agentId: "publishing",
    });
    expect(first.state.records[0].label).toBe("已接收交接内容");
    // Simulates retry after losing the response: only persisted rows are read.
    expect(
      await db.transaction((tx) => handoffWorkbenchTask(tx, scope, input)),
    ).toEqual(first);
    await expect(
      db.transaction((tx) =>
        handoffWorkbenchTask(tx, scope, {
          ...input,
          values: { questionDraft: "different" },
        }),
      ),
    ).rejects.toMatchObject({ code: "CONFLICT" });
    await expect(
      db.transaction((tx) =>
        handoffWorkbenchTask(tx, scope, {
          ...input,
          targetAgentId: "articles",
        }),
      ),
    ).rejects.toMatchObject({ code: "CONFLICT" });
  });
  it.each([
    [knowledgeBaseBuilds, "knowledge"],
    [responseLogicEntries, "response-logic"],
    [siteProjects, "website"],
  ] as const)(
    "preserves a native association before its first workbench binding",
    async (table, nativeAgent) => {
      const db = database();
      db.get(conversations).push({
        id: "u7:native",
        userId: 7,
        enterpriseProjectId: null,
        projectAssignmentId: null,
        deletedAt: null,
        title: "native",
        createdAt: new Date(),
        updatedAt: new Date(),
      });
      db.get(table).push({
        id: "native-resource",
        userId: 7,
        enterpriseProjectId: null,
        conversationId: "u7:native",
      });
      await expect(
        bindWorkbenchTask(db.executor, scope, {
          conversationId: "native",
          agentId: "media",
        }),
      ).rejects.toMatchObject({ code: "CONFLICT" });
      expect(db.get(messages)).toHaveLength(0);
      expect(
        (
          await bindWorkbenchTask(db.executor, scope, {
            conversationId: "native",
            agentId: nativeAgent,
          })
        ).agentId,
      ).toBe(nativeAgent);
    },
  );
  it("preserves the frozen enterprise QA purpose without trusting a new route label", async () => {
    const db = database();
    db.get(conversations).push({
      id: "u7:qa",
      userId: 7,
      enterpriseProjectId: null,
      projectAssignmentId: null,
      deletedAt: null,
      title: "qa",
      upstreamTaskId: "native-task",
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    db.get(agentTasks).push({
      id: "native-task",
      operationId: "native-operation",
      providerRuntime: {
        generalPurpose: {
          revision: 1,
          accountUserId: 7,
          purpose: "enterprise_qa",
          knowledgeBase: null,
          knowledgeText: null,
        },
      },
    });
    db.get(agentOperations).push({
      id: "native-operation",
      accountUserId: 7,
      scope: "managed_user",
      enterpriseProjectId: null,
    });
    await expect(
      bindWorkbenchTask(db.executor, scope, {
        conversationId: "qa",
        agentId: "media",
      }),
    ).rejects.toMatchObject({ code: "CONFLICT" });
    expect(
      (
        await bindWorkbenchTask(db.executor, scope, {
          conversationId: "qa",
          agentId: "enterprise-qa",
        })
      ).agentId,
    ).toBe("enterprise-qa");
  });
  it("requires the mapped publishing owner AND exact enterprise project for every resource", async () => {
    const db = database();
    db.get(monitoringAccountLinks).push({
      dashboardUserId: 7,
      monitoringUserId: "publisher-seven",
    });
    db.get(publisherArticleVersions).push({
      id: "version",
      ownerId: "publisher-seven",
      enterpriseProjectId: project,
    });
    db.get(publisherDrafts).push({
      id: "foreign-draft",
      ownerId: "publisher-seven",
      enterpriseProjectId: otherProject,
    });
    await inProject(project, () =>
      bindWorkbenchTask(db.executor, scope, {
        conversationId: "source",
        agentId: "media",
      }),
    );
    await inProject(project, () =>
      saveWorkbenchTask(db.executor, scope, {
        conversationId: "source",
        agentId: "media",
        expectedRevision: 1,
        patch: { resources: [{ kind: "article_version", id: "version" }] },
      }),
    );
    await expect(
      inProject(project, () =>
        handoffWorkbenchTask(db.executor, scope, {
          conversationId: "source",
          agentId: "media",
          targetAgentId: "publishing",
          resources: [{ kind: "publication_draft", id: "foreign-draft" }],
          idempotencyKey: "cross-project",
        }),
      ),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(
      inProject(otherProject, () =>
        saveWorkbenchTask(db.executor, scope, {
          conversationId: "source",
          agentId: "media",
          expectedRevision: 2,
          patch: { step: "wrong" },
        }),
      ),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    const [restored] = await inProject(project, () =>
      listSnapshots(7, null, db.executor),
    );
    expect(restored.workbench?.revision).toBe(2);
    expect(db.get(conversations)).toHaveLength(1);
  });
});
