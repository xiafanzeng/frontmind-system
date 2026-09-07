import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { KnowledgeNodeEditProvider } from "./knowledge-node-edit-provider";
import {
  assertDashboardManagedRuntimeImmutable,
  type DashboardAgentRuntimeStore,
  type DashboardRuntimeRecord,
  type DashboardProviderIdentity,
} from "./dashboard-agent-runtime-store";
import { ZhipuManagedClient, type ZhipuRecord } from "./zhipu-managed-client";
import { knowledgeNodeEditPrompt } from "../knowledge-node-edit-contract";
const digest = (value: string | Buffer) =>
  createHash("sha256").update(value).digest("hex");
const identity: DashboardProviderIdentity = {
  provider: "zhipu",
  accountUserId: 7,
  credentialOwnerUserId: 3,
  credentialId: "credential",
  credentialVersion: 2,
};
function memoryStore() {
  const rows = new Map<
    string,
    DashboardRuntimeRecord & { identity: DashboardProviderIdentity }
  >();
  const same = (
    row: { identity: DashboardProviderIdentity },
    value: DashboardProviderIdentity,
  ) =>
    row.identity.accountUserId === value.accountUserId &&
    row.identity.credentialId === value.credentialId &&
    row.identity.credentialVersion === value.credentialVersion;
  const store: DashboardAgentRuntimeStore = {
    async reserve(input) {
      const id =
        input.localTaskId ?? `local_${digest(input.intentId).slice(0, 12)}`;
      const old = rows.get(id);
      if (old) {
        if (!same(old, input.identity))
          throw new Error("DASHBOARD_PROVIDER_TASK_OWNERSHIP");
        return structuredClone(old);
      }
      const row = {
        identity: input.identity,
        localTaskId: id,
        operationId: input.operationId ?? `operation_${id}`,
        runtime: {
          revision: 1 as const,
          model: input.model,
          effort: input.effort,
          intentId: input.intentId,
          commands: [],
          mutations: {},
          files: [],
        },
      };
      rows.set(id, row);
      return structuredClone(row);
    },
    async findByIntent(who, intentId) {
      const row = [...rows.values()].find(
        (r) => same(r, who) && r.runtime.intentId === intentId,
      );
      return row ? structuredClone(row) : null;
    },
    async findBySession(who, sessionId) {
      const row = [...rows.values()].find(
        (r) => same(r, who) && r.runtime.sessionId === sessionId,
      );
      return row ? structuredClone(row) : null;
    },
    async findByFile(who, fileId, binding) {
      const row = [...rows.values()].find(
        (r) =>
          same(r, who) &&
          (!binding?.localTaskId || r.localTaskId === binding.localTaskId) &&
          (!binding?.operationId || r.operationId === binding.operationId) &&
          r.runtime.files.some(
            (f) =>
              f.id === fileId && (!binding?.role || f.role === binding.role),
          ),
      );
      return row ? structuredClone(row) : null;
    },
    async mutate(who, id, change) {
      const row = rows.get(id);
      if (!row || !same(row, who))
        throw new Error("DASHBOARD_PROVIDER_TASK_OWNERSHIP");
      const next = change(structuredClone(row.runtime));
      assertDashboardManagedRuntimeImmutable(row.runtime, next);
      row.runtime = next;
      return structuredClone(row);
    },
  };
  return { store, rows };
}

function fixture(
  output = '{"contentMarkdown":"# 修改后的当前节点"}',
  lostAck = false,
) {
  const memory = memoryStore();
  const calls: Array<{ method: string; path: string; body: any }> = [];
  const events: ZhipuRecord[] = [];
  const authorize = vi.fn(async () => {});
  const observe = vi.fn(async (_input: unknown) => ({
    shouldInterrupt: false,
  }));
  const reject = vi.fn(async () => {});
  let sends = 0;
  const fetchImpl: typeof fetch = vi.fn(async (url, init) => {
    const path = new URL(String(url)).pathname.replace(
      "/api/agent/managed",
      "",
    );
    const method = init?.method ?? "GET";
    const body =
      typeof init?.body === "string" ? JSON.parse(init.body) : init?.body;
    calls.push({ method, path, body });
    const json = (value: unknown) =>
      new Response(JSON.stringify(value), {
        headers: { "content-type": "application/json" },
      });
    if (method === "POST" && path === "/v1/agents")
      return json({ id: "agent_1" });
    if (method === "POST" && path === "/v1/environments")
      return json({ id: "environment_1" });
    if (method === "POST" && path === "/v1/sessions")
      return json({ id: "session_1" });
    if (method === "POST" && path.endsWith("/events")) {
      sends += 1;
      expect(authorize).toHaveBeenCalledTimes(1);
      events.push({
        id: "event_user",
        type: "user.message",
        content: body.events[0].content,
      });
      events.push({
        id: "event_usage",
        type: "span.model_request_end",
        model_usage: {
          input_tokens: 12,
          output_tokens: 8,
          cache_read_input_tokens: 0,
        },
      });
      events.push({
        id: "event_answer",
        type: "agent.message",
        content: [{ type: "text", text: output }],
      });
      if (lostAck) throw new Error("response lost");
      return json({ data: [events[0]] });
    }
    if (path.endsWith("/events"))
      return json({ data: events, next_page: null });
    if (path === "/v1/sessions/session_1")
      return json({ id: "session_1", status: "idle", usage: {} });
    throw new Error(`Unexpected provider call: ${method} ${path}`);
  });
  const provider = new KnowledgeNodeEditProvider({
    apiKey: "test-only",
    identity,
    store: memory.store,
    api: new ZhipuManagedClient({ apiKey: "test-only", fetchImpl }),
    authorize,
    observe,
    reject,
    pollMs: 1,
    deadlineMs: 20,
  });
  return {
    provider,
    calls,
    authorize,
    observe,
    reject,
    rows: memory.rows,
    sends: () => sends,
  };
}

describe("knowledge node Low provider", () => {
  it("leaves an unfunded command explicitly unsent without a transport mutation", async () => {
    const f = fixture();
    f.authorize.mockRejectedValueOnce(new Error("AI_BALANCE_INSUFFICIENT"));
    await expect(
      f.provider.edit({
        intentId: "unfunded",
        prompt: "edit",
        onSession: async () => {},
      }),
    ).rejects.toThrow("AI_BALANCE_INSUFFICIENT");
    expect(f.sends()).toBe(0);
    expect([...f.rows.values()][0].runtime.mutations.send).toBeUndefined();
    expect([...f.rows.values()][0].runtime.commands[0].eventId).toBeUndefined();
    expect(f.reject).not.toHaveBeenCalled();
  });
  it("sends only one node and instruction under fixed Low, with no tools, skills, files or network", async () => {
    const f = fixture();
    const onSession = vi.fn(async () => {});
    const prompt = knowledgeNodeEditPrompt("# 当前节点", "修改标题");
    await expect(
      f.provider.edit({ intentId: "turn_1", prompt, onSession }),
    ).resolves.toEqual({
      sessionId: "session_1",
      contentMarkdown: "# 修改后的当前节点",
    });
    expect(
      f.calls.find((call) => call.path === "/v1/agents")?.body,
    ).toMatchObject({
      model: { id: "glm-5.3", effort: "low", speed: "standard" },
      tools: [],
      skills: [],
      mcp_servers: [],
    });
    expect(
      f.calls.find((call) => call.path === "/v1/environments")?.body.config
        .networking,
    ).toEqual({
      type: "limited",
      allowed_hosts: [],
      allow_package_managers: false,
      allow_mcp_servers: false,
    });
    expect(
      f.calls.find((call) => call.path === "/v1/sessions")?.body.resources,
    ).toEqual([]);
    expect(f.calls.filter((call) => call.path.includes("/files"))).toHaveLength(
      0,
    );
    expect(
      f.calls.find(
        (call) => call.method === "POST" && call.path.endsWith("/events"),
      )?.body.events[0].content,
    ).toEqual([{ type: "text", text: prompt }]);
    expect(f.observe.mock.calls[0]?.[0]).toMatchObject({
      model: "glm-5.3",
      events: expect.arrayContaining([
        expect.objectContaining({ type: "span.model_request_end" }),
      ]),
    });
    expect(onSession.mock.invocationCallOrder[0]).toBeLessThan(
      f.authorize.mock.invocationCallOrder[0]!,
    );
    await f.provider.edit({ intentId: "turn_1", prompt, onSession });
    expect(f.sends()).toBe(1);
  });
  it("reconciles a lost send acknowledgement without another model call", async () => {
    const f = fixture(undefined, true);
    await f.provider.edit({
      intentId: "turn_lost",
      prompt: knowledgeNodeEditPrompt("node", "edit"),
      onSession: async () => {},
    });
    expect(f.sends()).toBe(1);
  });
  it("rejects malformed output without repairing, rerunning or upgrading", async () => {
    const f = fixture("not json");
    await expect(
      f.provider.edit({
        intentId: "turn_invalid",
        prompt: knowledgeNodeEditPrompt("node", "edit"),
        onSession: async () => {},
      }),
    ).rejects.toThrow();
    expect(f.sends()).toBe(1);
    expect(f.calls.filter((call) => call.path === "/v1/agents")).toHaveLength(
      1,
    );
    expect(f.observe).toHaveBeenCalledTimes(1);
  });
});
