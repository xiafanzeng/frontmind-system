import { createHash } from "node:crypto";
import { collectKnowledgeArchiveDescriptors } from "../knowledge-base-artifact";
import { describe, expect, it, vi } from "vitest";
import {
  ManusV2ApiError,
  manusV2EventMatchesGeneralChatRequest,
  latestManusV2TaskState,
  latestManusV2WaitingDetail,
  normalizeManusV2Output,
} from "../manus-v2-client";
import {
  createDashboardAgentClient,
  type DashboardAgentClientOptions,
} from "./dashboard-agent-provider";
import {
  assertDashboardManagedRuntimeImmutable,
  type DashboardAgentRuntimeStore,
  type DashboardRuntimeRecord,
  type DashboardProviderIdentity,
} from "./dashboard-agent-runtime-store";
import { ZhipuManagedClient, type ZhipuRecord } from "./zhipu-managed-client";

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
function fixture() {
  const memory = memoryStore();
  const calls: Array<{ method: string; path: string; body?: any }> = [];
  const events: ZhipuRecord[] = [];
  const files = new Map<string, ZhipuRecord & { bytes?: Buffer }>();
  const resources: ZhipuRecord[] = [];
  let sendFailure: "none" | "lost_after_accept" | "lost_before_accept" | "429" =
    "none";
  let sessionStatus = "idle";
  let sequence = 0;
  let time = Date.now();
  const now = () => new Date((time += 1000)).toISOString();
  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    });
  const fetchImpl: typeof fetch = vi.fn(async (url, init) => {
    const parsed = new URL(String(url));
    const path = parsed.pathname.replace("/api/agent/managed", "");
    const method = init?.method ?? "GET";
    const body =
      typeof init?.body === "string" ? JSON.parse(init.body) : init?.body;
    calls.push({ path, method, body });
    if (path.endsWith("/events/stream"))
      return new Response("", {
        headers: { "content-type": "text/event-stream" },
      });
    if (path === "/v1/files" && method === "POST") {
      const source = (body as FormData).get("file") as File;
      const bytes = Buffer.from(await source.arrayBuffer());
      const file = {
        id: `file_${++sequence}`,
        filename: source.name,
        mime_type: source.type,
        size_bytes: bytes.length,
        bytes,
        created_at: now(),
        downloadable: false,
      };
      files.set(file.id, file);
      return json(file);
    }
    if (path === "/v1/agents" && method === "POST")
      return json({ id: "agent_1" });
    if (path === "/v1/environments" && method === "POST")
      return json({ id: "environment_1" });
    if (path === "/v1/sessions" && method === "POST") {
      resources.push(
        ...body.resources.map((r: ZhipuRecord) => ({
          ...r,
          id: `resource_${++sequence}`,
          mount_path: `/mnt/session/uploads${r.mount_path}`,
        })),
      );
      return json({ id: "session_1" });
    }
    if (path === "/v1/sessions/session_1" && method === "GET")
      return json({
        id: "session_1",
        status: sessionStatus,
        title: "Original task",
        created_at: new Date(time - 10_000).toISOString(),
        updated_at: now(),
        resources,
        usage: {
          input_tokens: 20,
          output_tokens: 7,
          cache_read_input_tokens: 3,
        },
      });
    if (path === "/v1/sessions/session_1/resources" && method === "POST") {
      const resource = {
        ...body,
        id: `resource_${++sequence}`,
        mount_path: `/mnt/session/uploads${body.mount_path}`,
      };
      resources.push(resource);
      return json(resource);
    }
    if (path.includes("/resources/") && method === "DELETE") {
      const id = path.split("/").at(-1);
      resources.splice(
        resources.findIndex((r) => r.id === id),
        1,
      );
      return json({ id, deleted: true });
    }
    if (path === "/v1/sessions/session_1/events" && method === "GET")
      return json({
        data:
          parsed.searchParams.get("order") === "desc"
            ? [...events].reverse()
            : events,
        next_page: null,
      });
    if (path === "/v1/sessions/session_1/events" && method === "POST") {
      const mode = sendFailure;
      sendFailure = "none";
      if (mode === "429") return json({}, 429);
      if (mode === "lost_before_accept") throw new Error("connection lost");
      const event = {
        ...body.events[0],
        id: `event_${++sequence}`,
        processed_at: now(),
      };
      events.push(event);
      if (mode === "lost_after_accept") throw new Error("response lost");
      return json({ data: [event] });
    }
    if (path === "/v1/files" && method === "GET")
      return json({
        data: [...files.values()].filter(
          (f) => (f.scope as any)?.id === "session_1",
        ),
        has_more: false,
      });
    if (path.startsWith("/v1/files/") && path.endsWith("/content")) {
      const file = files.get(path.split("/")[3]);
      return file
        ? new Response(new Uint8Array(file.bytes!), {
            headers: { "content-type": String(file.mime_type) },
          })
        : json({}, 404);
    }
    if (path.startsWith("/v1/files/") && method === "GET") {
      const file = files.get(path.split("/")[3]);
      return file ? json(file) : json({}, 404);
    }
    if (path.startsWith("/v1/files/") && method === "DELETE") {
      const id = path.split("/")[3];
      files.delete(id);
      return json({ id, deleted: true });
    }
    if (path === "/v1/sessions/session_1" && method === "DELETE")
      return json({ id: "session_1", deleted: true });
    if (path === "/v1/agents" && method === "GET") return json({ data: [] });
    throw new Error(`unexpected ${method} ${path}`);
  });
  const api = new ZhipuManagedClient({ apiKey: "synthetic-key", fetchImpl });
  const client = (extra: Partial<DashboardAgentClientOptions> = {}) =>
    createDashboardAgentClient({
      ...identity,
      apiKey: "synthetic-key",
      intentId: "initial-intent",
      model: "glm-5.3",
      effort: "high",
      store: memory.store,
      api,
      ...extra,
    });
  const finish = (content = '{"ok":true}') => {
    events.push(
      {
        id: `assistant_${++sequence}`,
        type: "agent.message",
        content: [{ type: "text", text: content }],
        processed_at: now(),
      },
      {
        id: `idle_${++sequence}`,
        type: "session.status_idle",
        stop_reason: { type: "end_turn" },
        processed_at: now(),
      },
    );
  };
  const output = (filename: string, bytes = Buffer.from("deliverable")) => {
    const file = {
      id: `output_${++sequence}`,
      filename,
      bytes,
      size_bytes: bytes.length,
      mime_type: "application/zip",
      scope: { type: "session", id: "session_1" },
      created_at: now(),
      downloadable: true,
    };
    files.set(file.id, file);
    return file;
  };
  return {
    ...memory,
    client,
    api,
    calls,
    events,
    files,
    finish,
    output,
    now,
    failSend: (value: typeof sendFailure) => (sendFailure = value),
    status: (value: string) => (sessionStatus = value),
  };
}
const request = {
  title: "Original task",
  prompt: "Original Skill and prompt bytes\n保留用户确认点",
};

describe("tenant-owned Dashboard Managed Agents transport", () => {
  it("rejects a legacy AI credential instead of calling Manus", () => {
    expect(() =>
      createDashboardAgentClient({
        ...identity,
        provider: "manus",
        apiKey: "synthetic",
      }),
    ).toThrow("DASHBOARD_PROVIDER_IDENTITY_REQUIRED");
  });
  it("uploads original bytes, establishes SSE before send, restores exact original prompt and attachments, and replays once", async () => {
    const f = fixture();
    const bytes = Buffer.from("original workflow bytes");
    const file = await f.client().uploadFile({
      filename: "original.skill.zip",
      bytes,
      contentType: "application/zip",
    });
    expect(file.uploadUrl).toBe("");
    expect(file.detail.expiresAt - Date.now() / 1000).toBeLessThanOrEqual(
      86400,
    );
    const create = {
      ...request,
      attachments: [{ file_id: file.fileId, filename: file.filename }],
    };
    await f.client().createTask(create);
    await f.client().createTask(create);
    expect(
      f.calls.filter((c) => c.path.endsWith("/events") && c.method === "POST"),
    ).toHaveLength(1);
    const firstStream = f.calls.findIndex((c) =>
      c.path.endsWith("/events/stream"),
    );
    const firstSend = f.calls.findIndex(
      (c) => c.path.endsWith("/events") && c.method === "POST",
    );
    expect(firstStream).toBeGreaterThan(-1);
    expect(firstStream).toBeLessThan(firstSend);
    expect(f.files.get(file.fileId)?.bytes).toEqual(bytes);
    const messages = await f
      .client()
      .listAllMessages({ taskId: "session_1", order: "desc" });
    expect(
      manusV2EventMatchesGeneralChatRequest(
        messages.find((m) => m.type === "user_message")!,
        {
          promptSha256: digest(request.prompt),
          attachmentFileIds: [file.fileId],
        },
      ),
    ).toBe(true);
    expect([...f.rows.values()][0].runtime.usage).toMatchObject({
      input_tokens: 20,
      output_tokens: 7,
    });
    expect(f.calls.some((c) => c.method === "PUT")).toBe(false);
  });
  it("preserves the original knowledge workflow ZIP and charset-qualified instructions", async () => {
    const f = fixture();
    const originals = [
      {
        filename: "socratic-kb-builder-v5.skill.zip",
        mime: "application/zip",
        bytes: Buffer.from("original ZIP bytes"),
      },
      {
        filename: "frontmind-kb-server-instructions.txt",
        mime: "text/plain; charset=utf-8",
        bytes: Buffer.from("原始企业信息与输出合同\n不可改变", "utf8"),
      },
    ];
    const input = {
      ...request,
      attachments: originals.map(({ filename, mime, bytes }) => ({
        filename,
        mime_type: mime,
        file_data: `data:${mime};base64,${bytes.toString("base64")}`,
      })),
    };
    await f.client().createTask(input);
    await f.client().createTask(input);
    expect(f.files.size).toBe(2);
    const record = [...f.rows.values()][0];
    for (const original of originals) {
      const file = [...f.files.values()].find(
        (item) => item.filename === original.filename,
      )!;
      expect(file.bytes).toEqual(original.bytes);
      expect(file.mime_type).toBe(original.mime);
      expect(
        record.runtime.files.find(
          (item) => item.filename === original.filename,
        ),
      ).toMatchObject({
        bytes: original.bytes.length,
        sha256: digest(original.bytes),
        contentType: original.mime,
      });
    }
    expect(
      f.calls.filter(
        (item) => item.method === "POST" && item.path === "/v1/sessions",
      ),
    ).toHaveLength(1);
    expect(
      f.calls.filter(
        (item) => item.method === "POST" && item.path.endsWith("/events"),
      ),
    ).toHaveLength(1);
  });
  it("classifies a mismatched inline MIME as an explicit pre-session rejection", async () => {
    const f = fixture();
    await expect(
      f.client().createTask({
        ...request,
        attachments: [
          {
            filename: "instructions.txt",
            mime_type: "text/plain; charset=utf-8",
            file_data: `data:text/html; charset=utf-8;base64,${Buffer.from("original").toString("base64")}`,
          },
        ],
      }),
    ).rejects.toMatchObject({
      code: "INLINE_FILE_INVALID",
      outcomeUnknown: false,
      status: 400,
    });
    expect(f.calls.filter((item) => item.method === "POST")).toHaveLength(0);
  });
  it("continues the same session with new original files and does not settle from an earlier end_turn", async () => {
    const f = fixture();
    await f.client().createTask(request);
    f.finish();
    const record = [...f.rows.values()][0];
    const next = f.client({
      localTaskId: record.localTaskId,
      operationId: record.operationId,
      intentId: "second-turn",
    });
    await next.sendMessage({
      taskId: "session_1",
      prompt: "second unchanged prompt",
      attachments: [
        {
          filename: "材料.txt",
          mime_type: "text/plain",
          file_data: `data:text/plain;base64,${Buffer.from("new exact bytes").toString("base64")}`,
        },
      ],
    });
    expect((await next.taskDetail("session_1")).status).toBe("running");
    const sends = f.calls.filter(
      (c) => c.path.endsWith("/events") && c.method === "POST",
    ).length;
    f.status("running");
    expect(
      latestManusV2TaskState(
        await next.listAllMessages({ taskId: "session_1" }),
      ),
    ).toBe("running");
    await next.sendMessage({
      taskId: "session_1",
      prompt: "second unchanged prompt",
      attachments: [
        {
          filename: "材料.txt",
          mime_type: "text/plain",
          file_data: `data:text/plain;base64,${Buffer.from("new exact bytes").toString("base64")}`,
        },
      ],
    });
    expect(
      f.calls.filter((c) => c.path.endsWith("/events") && c.method === "POST"),
    ).toHaveLength(sends);
    expect(
      f.calls.filter((c) => c.path === "/v1/sessions" && c.method === "POST"),
    ).toHaveLength(1);
    expect([...f.rows.values()][0].runtime.intentId).toBe("initial-intent");
  });
  it("requires a fresh task after a lost send acknowledgement without reconstructing history", async () => {
    const f = fixture();
    f.failSend("lost_after_accept");
    await expect(f.client().createTask(request)).rejects.toMatchObject({
      outcomeUnknown: true,
    });
    await expect(f.client().createTask(request)).rejects.toMatchObject({
      outcomeUnknown: true,
    });
    expect(
      (await f.client().findCreatedTask({ title: request.title })).unique,
    ).toBeNull();
    expect(
      f.calls.filter((c) => c.method === "POST" && c.path.endsWith("/events")),
    ).toHaveLength(1);
  });
  it("fences an unresolved send across restart and only retries explicit 429 rejection", async () => {
    const f = fixture();
    f.failSend("lost_before_accept");
    await expect(f.client().createTask(request)).rejects.toBeInstanceOf(
      ManusV2ApiError,
    );
    await expect(f.client().createTask(request)).rejects.toMatchObject({
      outcomeUnknown: true,
    });
    expect(
      f.calls.filter((c) => c.method === "POST" && c.path.endsWith("/events")),
    ).toHaveLength(1);
    const retry = fixture();
    retry.failSend("429");
    await expect(retry.client().createTask(request)).rejects.toMatchObject({
      retryable: true,
      outcomeUnknown: false,
    });
    await retry.client().createTask(request);
    expect(
      retry.calls.filter(
        (c) => c.method === "POST" && c.path.endsWith("/events"),
      ),
    ).toHaveLength(2);
  });
  it("rejects cross-tenant and wrong-operation reads before contacting the provider", async () => {
    const f = fixture();
    await f.client().createTask(request);
    const count = f.calls.length;
    await expect(
      f.client({ accountUserId: 9 }).taskDetail("session_1"),
    ).rejects.toMatchObject({ status: 404 });
    await expect(
      f.client({ operationId: "wrong" }).taskDetail("session_1"),
    ).rejects.toMatchObject({ status: 404 });
    expect(f.calls).toHaveLength(count);
  });
  it("passes structured JSON to the business validator and binds the current turn artifacts", async () => {
    const f = fixture();
    const schema = {
      type: "object",
      properties: { ok: { const: true } },
      required: ["ok"],
      additionalProperties: false,
    };
    await f.client().createTask({ ...request, structuredOutputSchema: schema });
    const archive = f.output("result.zip");
    const excluded = f.output("internal.skill.zip");
    f.finish();
    const events = await f
      .client()
      .listAllMessages({ taskId: "session_1", order: "asc" });
    expect(
      events.find((e) => e.type === "structured_output_result")
        ?.structured_output_result,
    ).toEqual({ success: true, value: { ok: true } });
    expect(JSON.stringify(events)).toContain(`zhipu-file:${archive.id}`);
    expect(JSON.stringify(events)).not.toContain(`zhipu-file:${excluded.id}`);
    const artifact = await f.client().downloadArtifact!(archive.id);
    const parts = [];
    for await (const part of artifact.data) parts.push(part);
    expect(Buffer.concat(parts)).toEqual(archive.bytes);
    await expect(
      f.client({ localTaskId: "wrong" }).downloadArtifact!(archive.id),
    ).rejects.toMatchObject({ status: 404 });
    archive.bytes = Buffer.alloc(archive.bytes.length, 120);
    await expect(
      f.client().downloadArtifact!(archive.id),
    ).rejects.toMatchObject({ code: "ARTIFACT_CONTENT_CONFLICT" });
    const local = [...f.rows.values()][0];
    const next = f.client({
      localTaskId: local.localTaskId,
      intentId: "repair-turn",
    });
    await next.sendMessage({
      taskId: "session_1",
      prompt: "repair unchanged",
      structuredOutputSchema: schema,
    });
    f.finish('{"ok":false}');
    const all = await next.listAllMessages({ taskId: "session_1" });
    expect(
      all
        .filter((e) => e.type === "structured_output_result")
        .map((e) => e.structured_output_result),
    ).toEqual([
      { success: true, value: { ok: true } },
      { success: true, value: { ok: false } },
    ]);
    expect(
      all.filter((e) => JSON.stringify(e).includes(`zhipu-file:${archive.id}`)),
    ).toHaveLength(1);
  });
  it("preserves an attachment-only KB result and usable JSON before a closing sentence", async () => {
    const f = fixture();
    await f
      .client()
      .createTask({ ...request, structuredOutputSchema: { type: "object" } });
    const archive = f.output("frontmind-kb-bundle-original.zip");
    f.events.push({
      id: "business-json",
      type: "agent.message",
      processed_at: f.now(),
      content: [
        { type: "text", text: '```json\n{"payload":{"original":true}}\n```' },
      ],
    });
    f.finish("已完成，知识库 ZIP 已附上。");
    const events = await f
      .client()
      .listAllMessages({ taskId: "session_1", order: "desc" });
    expect(
      events.find((e) => e.type === "structured_output_result")
        ?.structured_output_result,
    ).toEqual({ success: true, value: { payload: { original: true } } });
    expect(
      collectKnowledgeArchiveDescriptors(normalizeManusV2Output(events)),
    ).toEqual([
      expect.objectContaining({
        fileId: archive.id,
        filename: archive.filename,
        url: `zhipu-file:${archive.id}`,
      }),
    ]);
  });
  it("preserves pending tool confirmation and makes confirmation, stop and delete replay-safe", async () => {
    const f = fixture();
    await f.client().createTask(request);
    f.events.push(
      { id: "tool_1", type: "agent.tool_use", processed_at: f.now() },
      {
        id: "waiting",
        type: "session.status_idle",
        processed_at: f.now(),
        stop_reason: { type: "requires_action", event_ids: ["tool_1"] },
      },
    );
    const action = {
      taskId: "session_1",
      eventId: "tool_1",
      confirmationInput: {
        result: "deny",
        deny_message: "user requested pause",
      },
    };
    await f.client().confirmAction(action);
    f.status("running");
    expect(
      latestManusV2WaitingDetail(
        await f.client().listAllMessages({ taskId: "session_1" }),
      ),
    ).toBeNull();
    await f.client().confirmAction(action);
    await expect(
      f
        .client()
        .confirmAction({ ...action, confirmationInput: { result: "allow" } }),
    ).rejects.toMatchObject({ code: "PROVIDER_MUTATION_CONFLICT" });
    await f.client().stopTask("session_1");
    await f.client().stopTask("session_1");
    await f.client().deleteTask("session_1");
    await f.client().deleteTask("session_1");
    const posts = f.calls.filter(
      (c) => c.path.endsWith("/events") && c.method === "POST",
    );
    expect(posts.map((c) => c.body.events[0].type)).toEqual([
      "user.message",
      "user.tool_confirmation",
      "user.interrupt",
    ]);
    expect(posts[1].body.events[0]).toMatchObject({
      tool_use_id: "tool_1",
      result: "deny",
    });
    expect(f.calls.filter((c) => c.method === "DELETE")).toHaveLength(1);
  });
  it("reuses only a locally acknowledged task without searching titles or validating business schemas twice", async () => {
    const f = fixture();
    expect(
      (await f.client().findCreatedTask({ title: request.title })).unique,
    ).toBeNull();
    await f
      .client()
      .createTask({ ...request, structuredOutputSchema: { type: "object" } });
    expect(
      (await f.client().findCreatedTask({ title: request.title })).unique?.id,
    ).toBe("session_1");
    expect(
      f.calls.some((c) => c.path === "/v1/sessions" && c.method === "GET"),
    ).toBe(false);
  });
  it("preserves an exhausted provider error across its following idle notification", async () => {
    const f = fixture();
    await f
      .client()
      .createTask({ ...request, structuredOutputSchema: { type: "object" } });
    const archive = f.output("unfinished-result.zip");
    f.events.push({
      id: "provider-failed",
      type: "session.error",
      processed_at: f.now(),
      error: {
        type: "unknown_error",
        message: "服务暂时不可用",
        retry_status: { type: "exhausted" },
      },
    });
    f.finish();
    expect((await f.client().taskDetail("session_1")).status).toBe("error");
    const events = await f.client().listAllMessages({ taskId: "session_1" });
    expect(
      events.filter((event) => event.type === "status_update").at(-1)
        ?.status_update,
    ).toMatchObject({
      agent_status: "error",
      error_type: "unknown_error",
      error_content: "服务暂时不可用",
    });
    expect(
      events.some((event) => event.type === "structured_output_result"),
    ).toBe(false);
    expect(JSON.stringify(events)).not.toContain(`zhipu-file:${archive.id}`);
  });

  it("allows a retrying provider error to finish normally", async () => {
    const f = fixture();
    await f.client().createTask(request);
    f.events.push({
      id: "provider-retrying",
      type: "session.error",
      processed_at: f.now(),
      error: {
        type: "unknown_error",
        message: "服务暂时不可用",
        retry_status: { type: "retrying" },
      },
    });
    expect((await f.client().taskDetail("session_1")).status).toBe("running");
    f.finish();
    expect((await f.client().taskDetail("session_1")).status).toBe("stopped");
    const events = await f.client().listAllMessages({ taskId: "session_1" });
    expect(
      events.filter((event) => event.type === "status_update").at(-1)
        ?.status_update,
    ).toMatchObject({ agent_status: "stopped" });
  });

  it("does not apply an earlier execution error after a later running boundary", async () => {
    const f = fixture();
    await f.client().createTask(request);
    f.events.push(
      {
        id: "old-error",
        type: "session.error",
        processed_at: f.now(),
        error: { type: "unknown_error", retry_status: { type: "exhausted" } },
      },
      {
        id: "resumed-running",
        type: "session.status_running",
        processed_at: f.now(),
      },
    );
    f.finish();
    expect((await f.client().taskDetail("session_1")).status).toBe("stopped");
  });
});
