import { describe, expect, it, vi, beforeEach } from "vitest";
import { MySqlDialect } from "drizzle-orm/mysql-core";
import type { SQL } from "drizzle-orm";
const mocked = vi.hoisted(() => ({ getDb: vi.fn() }));
vi.mock("../db", () => ({ getDb: mocked.getDb }));
import {
  dashboardAgentRuntimeStore,
  assertDashboardManagedRuntimeImmutable,
  retainDashboardThinkingCapture,
  type DashboardManagedRuntime,
} from "./dashboard-agent-runtime-store";

const identity = {
  provider: "zhipu" as const,
  accountUserId: 7,
  credentialOwnerUserId: 3,
  credentialId: "credential",
  credentialVersion: 2,
};
const runtime = (): DashboardManagedRuntime => ({
  revision: 1,
  model: "glm-5.3",
  effort: "high",
  intentId: "first-turn",
  commands: [],
  mutations: {},
  files: [],
});
const row = () => ({
  task: {
    id: "local-task",
    operationId: "business-operation",
    providerRuntime: { businessField: "preserve", dashboardManaged: runtime() },
  },
  operation: { id: "business-operation", upstreamModel: "glm-5.3" },
});
function database(responses: unknown[][]) {
  const predicates: SQL[] = [];
  const updates: unknown[] = [];
  const insert = vi.fn(() => {
    throw new Error("unexpected extra transport row");
  });
  const select = vi.fn(() => {
    const data = responses.shift();
    if (!data) throw new Error("unexpected query");
    const chain = {
      from: () => chain,
      innerJoin: () => chain,
      where: (predicate: SQL) => {
        predicates.push(predicate);
        return chain;
      },
      limit: () => chain,
      for: async () => data,
      then: (
        resolve: (value: unknown[]) => unknown,
        reject: (error: unknown) => unknown,
      ) => Promise.resolve(data).then(resolve, reject),
    };
    return chain;
  });
  const db = {
    select,
    insert,
    update: () => ({
      set: (value: unknown) => {
        updates.push(value);
        return { where: async () => undefined };
      },
    }),
    transaction: async (run: (value: unknown) => Promise<unknown>) => run(db),
  };
  mocked.getDb.mockResolvedValue(db);
  return { predicates, updates, insert };
}
beforeEach(() => vi.clearAllMocks());

describe("API thinking transcript retention", () => {
  const readyRuntime = (): DashboardManagedRuntime => ({
    ...runtime(),
    generalIdentitySystem: "FrontMind",
    commands: ["first", "second"].map((key) => ({
      key, intentId: key, prompt: key, providerPromptHash: key,
      attachments: [], beforeEventIds: [], beforeFileIds: [],
      createdAt: "2026-09-09T00:00:00Z",
    })),
  });
  const capture = {
    eventId: "reused-id", commandKey: "first", text: "收到的过程文本",
    startedAt: "2026-09-09T00:00:01Z", complete: false,
  };
  it("persists the same provider ID independently for each owning command", () => {
    const first = retainDashboardThinkingCapture(readyRuntime(), capture);
    const second = retainDashboardThinkingCapture(first, {
      ...capture, commandKey: "second", text: "另一个轮次的文本",
    });
    expect(second.thinkingCaptures?.map((item) => [item.commandKey, item.text]))
      .toEqual([["first", "收到的过程文本"], ["second", "另一个轮次的文本"]]);
  });
  it("preserves longer saved text on replay but accepts authoritative event content", () => {
    const first = retainDashboardThinkingCapture(readyRuntime(), capture);
    expect(retainDashboardThinkingCapture(first, { ...capture, text: "收到" })).toBe(first);
    expect(retainDashboardThinkingCapture(first, { ...capture, text: "收到", complete: true })).toBe(first);
    const finished = retainDashboardThinkingCapture(first, {
      ...capture, text: "完整事件修订的正文", complete: true, authoritativeText: true,
    });
    expect(finished.thinkingCaptures?.[0]).toMatchObject({ text: "完整事件修订的正文", complete: true });
    expect(retainDashboardThinkingCapture(finished, {
      ...capture, text: "完整事件修订的正文以及迟到增量",
    })).toBe(finished);
  });
  it("rejects unowned commands, empty captures and non-general workflows", () => {
    const current = readyRuntime();
    expect(retainDashboardThinkingCapture(current, { ...capture, commandKey: "unknown" })).toBe(current);
    expect(retainDashboardThinkingCapture(current, { ...capture, text: "  " })).toBe(current);
    const workflow = { ...current, generalIdentitySystem: undefined };
    expect(retainDashboardThinkingCapture(workflow, capture)).toBe(workflow);
  });
});
describe("Dashboard runtime ownership and immutable bindings", () => {
  it("reuses a supplied operation's one owned task instead of creating a transport duplicate", async () => {
    const f = database([
      [{ id: identity.credentialId }],
      [{ id: "local-task" }],
      [row()],
    ]);
    const found = await dashboardAgentRuntimeStore.reserve({
      identity,
      operationId: "business-operation",
      intentId: "continuation-turn",
      model: "glm-5.3",
      effort: "high",
    });
    expect(found.localTaskId).toBe("local-task");
    expect(found.runtime.intentId).toBe("first-turn");
    expect(f.insert).not.toHaveBeenCalled();
    const dialect = new MySqlDialect();
    const credential = dialect.sqlToQuery(f.predicates[0]);
    expect(credential.params).toEqual(["credential", 3, 2, "zhipu"]);
    const operation = dialect.sqlToQuery(f.predicates[1]);
    expect(operation.params).toContain(7);
    expect(operation.params).toContain("business-operation");
  });
  it("replays a migrated default project's old intent without creating a second provider operation", async () => {
    const legacyIdentity = { ...identity, enterpriseProjectId: "legacy-project", enterpriseProjectLegacyDefault: true };
    const f = database([[{id:"legacy-project",archivedAt:null}], [{id:identity.credentialId}], [{id:"local-task"}], [row()]]);
    const found = await dashboardAgentRuntimeStore.reserve({ identity:legacyIdentity, intentId:"first-turn", model:"glm-5.3", effort:"high" });
    expect(found.localTaskId).toBe("local-task");
    expect(f.insert).not.toHaveBeenCalled();
    const lookup = new MySqlDialect().sqlToQuery(f.predicates[2]);
    expect(lookup.params).toContain("legacy-project");
    expect(lookup.sql).toContain("idempotency_key_hash");
    expect(lookup.sql).not.toContain("is null");
  });
  it("refuses an ambiguous migrated replay rather than sending another provider request", async () => {
    const f = database([[{id:"legacy-project",archivedAt:null}], [{id:identity.credentialId}], [{id:"old-task"},{id:"new-task"}]]);
    await expect(dashboardAgentRuntimeStore.reserve({ identity:{...identity,enterpriseProjectId:"legacy-project",enterpriseProjectLegacyDefault:true}, intentId:"first-turn", model:"glm-5.3", effort:"high" })).rejects.toThrow("DASHBOARD_PROVIDER_INTENT_AMBIGUOUS");
    expect(f.insert).not.toHaveBeenCalled();
  });
  it("fails closed when an operation is missing or ambiguous and never creates a fallback row", async () => {
    for (const tasks of [[], [{ id: "one" }, { id: "two" }]]) {
      const f = database([[{ id: "credential" }], tasks]);
      await expect(
        dashboardAgentRuntimeStore.reserve({
          identity,
          operationId: "business-operation",
          intentId: "turn",
          model: "glm-5.3",
          effort: "high",
        }),
      ).rejects.toThrow("DASHBOARD_PROVIDER_TASK_OWNERSHIP");
      expect(f.insert).not.toHaveBeenCalled();
    }
  });
  it("preserves business runtime fields and exposes native usage without mutating business status", async () => {
    const f = database([[row()]]);
    await dashboardAgentRuntimeStore.mutate(
      identity,
      "local-task",
      (current) => ({
        ...current,
        usage: { input_tokens: 11, output_tokens: 3 },
      }),
    );
    expect(f.updates).toEqual([
      {
        providerRuntime: {
          businessField: "preserve",
          dashboardManaged: {
            ...runtime(),
            usage: { input_tokens: 11, output_tokens: 3 },
          },
          usage: { input_tokens: 11, output_tokens: 3 },
        },
      },
    ]);
  });
  it("rejects provider/model rebinding and rewriting an acknowledged file or command", () => {
    const old = {
      ...runtime(),
      sessionId: "session",
      files: [
        {
          id: "file",
          filename: "input.txt",
          bytes: 3,
          sha256: "a".repeat(64),
          contentType: "text/plain",
          role: "input" as const,
        },
      ],
    };
    expect(() =>
      assertDashboardManagedRuntimeImmutable(old, {
        ...old,
        model: "glm-5.3-flash",
      }),
    ).toThrow("DASHBOARD_PROVIDER_RUNTIME_CONFLICT");
    expect(() =>
      assertDashboardManagedRuntimeImmutable(old, {
        ...old,
        sessionId: "other",
      }),
    ).toThrow("DASHBOARD_PROVIDER_IDENTITY_CONFLICT");
    expect(() =>
      assertDashboardManagedRuntimeImmutable(old, {
        ...old,
        files: old.files.map((file) => ({ ...file, bytes: 4 })),
      }),
    ).toThrow("DASHBOARD_PROVIDER_FILE_CONFLICT");
  });
});
