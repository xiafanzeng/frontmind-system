import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PresalesV2TaskRecord } from "../presales-v2-store";
const state = vi.hoisted(() => ({
  record: null as unknown as PresalesV2TaskRecord,
}));
vi.mock("../presales-v2-store", () => ({
  readPresalesV2Task: vi.fn(async () => state.record),
}));
import {
  ZhipuWebsiteAgentProvider,
  normalizeZhipuEvents,
  zhipuTaskPrompt,
  createWebsiteAgentClient,
} from "./website-agent-provider";
import { ZhipuManagedClient, ZhipuManagedError } from "./zhipu-managed-client";
import { ManusV2Client, latestManusV2TaskState } from "../manus-v2-client";
import {
  executionEventMessage,
  safeExecutionText,
} from "./execution-log-projector";
const update = async (
  _id: string,
  mutate: (record: PresalesV2TaskRecord) => PresalesV2TaskRecord,
) => (state.record = mutate(state.record));
const stamp = "2026-09-05T00:00:00.000Z";
beforeEach(() => {
  state.record = {
    localTaskId: "local_1",
    operationId: "operation_1",
    provider: "zhipu",
    safeEvents: [],
    createdAt: stamp,
  } as unknown as PresalesV2TaskRecord;
});
describe("Website provider compatibility", () => {
  it("always uses Zhipu for the current Website task", () => {
    expect(
      createWebsiteAgentClient(
        "test",
        { ...state.record, provider: undefined },
        update,
      ),
    ).toBeInstanceOf(ZhipuWebsiteAgentProvider);
    expect(
      createWebsiteAgentClient("test", state.record, update),
    ).toBeInstanceOf(ZhipuWebsiteAgentProvider);
  });
  it("does not confuse initial idle, user pauses or exhausted execution with completion", () => {
    const events = normalizeZhipuEvents([
      { id: "i", type: "session.status_idle", processed_at: stamp },
      {
        id: "w",
        type: "session.status_idle",
        processed_at: stamp,
        stop_reason: { type: "requires_action", event_ids: ["tool_1"] },
      },
      {
        id: "s",
        type: "session.status_idle",
        processed_at: stamp,
        stop_reason: { type: "end_turn" },
      },
      {
        id: "think",
        type: "agent.thinking",
        processed_at: stamp,
        content: "private reasoning",
      },
    ]);
    expect(
      events.map(
        (event) =>
          (event.status_update as { agent_status: string }).agent_status,
      ),
    ).toEqual(["unknown", "waiting", "stopped"]);
    expect(JSON.stringify(events)).not.toContain("private reasoning");
  });
  it("preserves stable rank for equal-time events and drops unprocessed inputs", () => {
    expect(
      normalizeZhipuEvents([
        { id: "queued", type: "user.message", processed_at: null },
      ]),
    ).toEqual([]);
    const events = normalizeZhipuEvents([
      {
        id: "z",
        type: "agent.message",
        processed_at: stamp,
        content: [{ type: "text", text: "reply" }],
      },
      {
        id: "a",
        type: "session.status_idle",
        processed_at: stamp,
        stop_reason: { type: "end_turn" },
      },
    ]);
    expect(events.map((event) => event.providerOriginalRank)).toEqual([0, 1]);
  });
  it.each(["session.status_terminated", "session.deleted"])(
    "preserves explicit %s cancellation across a later idle",
    (type) => {
      const events = normalizeZhipuEvents([
        { id: "run", type: "session.status_running", processed_at: stamp },
        { id: "cancel", type, processed_at: stamp },
        {
          id: "queued",
          type: "user.message",
          processed_at: null,
          created_at: stamp,
        },
        {
          id: "idle",
          type: "session.status_idle",
          processed_at: stamp,
          stop_reason: { type: "end_turn" },
        },
      ]);
      expect(
        events.map(
          (event) =>
            (event.status_update as { agent_status: string }).agent_status,
        ),
      ).toEqual(["running", "cancelled", "cancelled"]);
    },
  );
  it.each(["interrupted", "user_interrupt"])(
    "projects explicit %s as cancelled",
    (type) => {
      expect(
        normalizeZhipuEvents([
          {
            id: "interrupt",
            type: "session.status_idle",
            processed_at: stamp,
            stop_reason: { type },
          },
        ])[0]?.status_update,
      ).toEqual({ agent_status: "cancelled" });
    },
  );
  it.each(["retrying", { type: "retrying" }])(
    "keeps provider retry status %j active until its actual completion",
    (retryStatus) => {
      const events = normalizeZhipuEvents([
        { id: "run", type: "session.status_running", processed_at: stamp },
        {
          id: "retry",
          type: "session.error",
          processed_at: stamp,
          error: {
            type: "unknown_error",
            message: "服务暂时不可用",
            retry_status: retryStatus,
          },
        },
        {
          id: "answer",
          type: "agent.message",
          processed_at: stamp,
          content: [{ type: "text", text: "original result" }],
        },
        {
          id: "done",
          type: "session.status_idle",
          processed_at: stamp,
          stop_reason: { type: "end_turn" },
        },
      ]);
      expect(
        events
          .filter((event) => event.type === "status_update")
          .map(
            (event) =>
              (event.status_update as { agent_status: string }).agent_status,
          ),
      ).toEqual(["running", "stopped"]);
      expect(
        events.find((event) => event.id === "answer")?.assistant_message,
      ).toEqual({ content: "original result" });
    },
  );
  it.each(["exhausted", { type: "exhausted" }, "terminal"])(
    "retains terminal status %j across idle and clears it for the next acknowledged turn",
    (retryStatus) => {
      const events = normalizeZhipuEvents([
        { id: "run", type: "session.status_running", processed_at: stamp },
        {
          id: "failed",
          type: "session.error",
          processed_at: stamp,
          error: {
            type: "unknown_error",
            message: "服务暂时不可用",
            retry_status: retryStatus,
          },
        },
        {
          id: "idle",
          type: "session.status_idle",
          processed_at: stamp,
          stop_reason: { type: "end_turn" },
        },
        { id: "resumed", type: "session.status_running", processed_at: stamp },
        {
          id: "done",
          type: "session.status_idle",
          processed_at: stamp,
          stop_reason: { type: "end_turn" },
        },
      ]);
      expect(
        events.map(
          (event) =>
            (event.status_update as { agent_status: string }).agent_status,
        ),
      ).toEqual(["running", "error", "error", "running", "stopped"]);
    },
  );
  it("does not repeat file upload after response loss or a process restart", async () => {
    const uploadFile = vi.fn(async () => {
      throw new ZhipuManagedError("/v1/files", null, "TRANSPORT_ERROR", true);
    });
    const api = { uploadFile } as unknown as ZhipuManagedClient;
    const input = {
      filename: "original.skill.zip",
      contentType: "application/zip",
      bytes: Buffer.from("frozen bytes"),
    };
    await expect(
      new ZhipuWebsiteAgentProvider(
        state.record,
        update,
        "test",
        api,
      ).uploadFile(input),
    ).rejects.toMatchObject({ outcomeUnknown: true });
    await expect(
      new ZhipuWebsiteAgentProvider(
        state.record,
        update,
        "test",
        api,
      ).uploadFile(input),
    ).rejects.toMatchObject({ outcomeUnknown: true });
    expect(uploadFile).toHaveBeenCalledTimes(1);
    expect(
      Object.values(state.record.providerRuntime!.mutations)[0]!.state,
    ).toBe("outcome_unknown");
  });
  it.each([undefined, "low", "high", "max"] as const)(
    "opens the event channel before the single initial send and reuses the frozen model (%s)",
    async (effort) => {
      if (effort) {
        state.record.providerRuntime = {
          revision: 1,
          model: "glm-5.3",
          effort,
          mutations: {},
        };
      }
      const order: string[] = [];
      const api = {
        create: vi.fn(async (path: string) => ({
          id:
            path === "/v1/agents"
              ? "agent_1"
              : path === "/v1/environments"
                ? "env_1"
                : "sess_1",
        })),
        subscribeEvents: vi.fn(async () => {
          order.push("connect");
          return { events: (async function* () {})(), close() {} };
        }),
        sendMessage: vi.fn(async () => {
          order.push("send");
          return { data: [{ id: "event_1" }] };
        }),
      } as unknown as ZhipuManagedClient;
      const provider = new ZhipuWebsiteAgentProvider(
        state.record,
        update,
        "test",
        api,
      );
      const result = await provider.createTask({
        prompt: "original task",
        title: "frozen title",
      });
      expect(order).toEqual(["connect", "send"]);
      expect(result.taskId).toBe("sess_1");
      expect(api.create).toHaveBeenNthCalledWith(
        1,
        "/v1/agents",
        expect.objectContaining({
          model: effort
            ? { id: "glm-5.3", effort, speed: "standard" }
            : "glm-5.3",
        }),
      );
      expect(state.record.providerRuntime).toMatchObject({
        agentId: "agent_1",
        environmentId: "env_1",
        sessionId: "sess_1",
        commandEventIds: ["event_1"],
      });
      await provider.createTask({
        prompt: "original task",
        title: "frozen title",
      });
      expect(api.create).toHaveBeenCalledTimes(3);
      expect(api.sendMessage).toHaveBeenCalledTimes(1);
    },
  );
  it("never resends an uncertain initial message", async () => {
    const api = {
      create: vi.fn(async (path: string) => ({
        id:
          path === "/v1/agents"
            ? "agent_2"
            : path === "/v1/environments"
              ? "env_2"
              : "sess_2",
      })),
      subscribeEvents: vi.fn(async () => ({
        events: (async function* () {})(),
        close() {},
      })),
      sendMessage: vi.fn(async () => {
        throw new ZhipuManagedError(
          "/v1/events",
          null,
          "TRANSPORT_ERROR",
          true,
        );
      }),
    } as unknown as ZhipuManagedClient;
    for (let attempt = 0; attempt < 2; attempt++)
      await expect(
        new ZhipuWebsiteAgentProvider(
          state.record,
          update,
          "test",
          api,
        ).createTask({ prompt: "original" }),
      ).rejects.toMatchObject({ outcomeUnknown: true });
    expect(api.sendMessage).toHaveBeenCalledTimes(1);
    expect(state.record.providerRuntime!.sessionId).toBe("sess_2");
  });
});
describe("session output ownership", () => {
  it("uses authoritative terminated status when history still ends at running", async () => {
    state.record.providerRuntime = {
      revision: 1,
      model: "glm-5.3",
      sessionId: "sess_terminated",
      mutations: {},
    };
    const api = {
      request: vi
        .fn()
        .mockResolvedValue({ status: "terminated", updated_at: stamp }),
      listAll: vi.fn().mockResolvedValue([
        { id: "think1", type: "agent.thinking", processed_at: stamp },
        { id: "think2", type: "agent.thinking", processed_at: stamp },
        {
          id: "run",
          type: "session.status_running",
          processed_at: "2026-09-05T00:00:01.000Z",
        },
      ]),
    } as unknown as ZhipuManagedClient;
    const events = await new ZhipuWebsiteAgentProvider(
      state.record,
      update,
      "test",
      api,
    ).listAllMessages({ taskId: "sess_terminated" });
    expect(events.at(-1)?.status_update).toEqual({ agent_status: "cancelled" });
    expect(latestManusV2TaskState(events)).toBe("cancelled");
    expect(events.at(-1)?.providerOriginalRank).toBe(3);
    expect(api.listAll).toHaveBeenCalledTimes(1);
  });
  it.each([408, 425])(
    "defers HTTP %s reads without changing the bound session",
    async (status) => {
      state.record.providerRuntime = {
        revision: 1,
        model: "glm-5.3",
        sessionId: "sess_read",
        mutations: {},
      };
      const api = {
        request: vi
          .fn()
          .mockRejectedValue(
            new ZhipuManagedError(
              "/v1/sessions/sess_read",
              status,
              `HTTP_${status}`,
              false,
            ),
          ),
      } as unknown as ZhipuManagedClient;
      await expect(
        new ZhipuWebsiteAgentProvider(
          state.record,
          update,
          "test",
          api,
        ).listAllMessages({ taskId: "sess_read" }),
      ).rejects.toMatchObject({
        status,
        retryable: true,
        outcomeUnknown: false,
      });
      expect(state.record.providerRuntime.sessionId).toBe("sess_read");
      expect(api.request).toHaveBeenCalledTimes(1);
    },
  );
  it("keeps a streamed terminal failure from becoming a successful idle log", async () => {
    state.record.providerRuntime = {
      revision: 1,
      model: "glm-5.3",
      mutations: {},
      sessionId: "sess_stream_failure",
    };
    const close = vi.fn();
    const api = {
      request: vi.fn(async () => ({ status: "running" })),
      listAll: vi.fn(async () => []),
      subscribeEvents: vi.fn(async () => ({
        close,
        events: (async function* () {
          yield {
            id: "failed",
            type: "session.error",
            processed_at: stamp,
            error: {
              type: "unknown_error",
              retry_status: { type: "exhausted" },
            },
          };
          yield {
            id: "idle",
            type: "session.status_idle",
            processed_at: stamp,
            stop_reason: { type: "end_turn" },
          };
        })(),
      })),
    } as unknown as ZhipuManagedClient;
    await new ZhipuWebsiteAgentProvider(
      state.record,
      update,
      "test",
      api,
    ).listAllMessages({ taskId: "sess_stream_failure", order: "asc" });
    await vi.waitFor(() => expect(close).toHaveBeenCalledOnce());
    expect(state.record.safeEvents.map((event) => event.message)).toEqual([
      "上游执行异常。",
      "上游执行异常。",
    ]);
  });
  it("never publishes mounted inputs or another session's files", async () => {
    state.record.providerRuntime = {
      revision: 1,
      model: "glm-5.3",
      mutations: {},
      sessionId: "sess_output",
      files: [
        {
          id: "input_1",
          filename: "private.skill.zip",
          sha256: "f".repeat(64),
          bytes: 4,
          role: "input",
        },
      ],
    };
    const files = [
      {
        id: "input_copy",
        filename: "private.skill.zip",
        downloadable: true,
        scope: { id: "sess_output" },
      },
      {
        id: "foreign",
        filename: "foreign.zip",
        downloadable: true,
        scope: { id: "sess_elsewhere" },
      },
      {
        id: "output",
        filename: "result.zip",
        mime_type: "application/zip",
        downloadable: true,
        scope: { id: "sess_output" },
      },
    ];
    const api = {
      request: vi.fn(async () => ({
        status: "idle",
        usage: { input_tokens: 10, output_tokens: 2 },
      })),
      listAll: vi.fn(async (path: string) =>
        path === "/v1/files"
          ? files
          : [
              { id: "think1", type: "agent.thinking", processed_at: stamp },
              { id: "think2", type: "agent.thinking", processed_at: stamp },
              {
                id: "ended",
                type: "session.status_idle",
                processed_at: stamp,
                stop_reason: { type: "end_turn" },
              },
            ],
      ),
    } as unknown as ZhipuManagedClient;
    const provider = new ZhipuWebsiteAgentProvider(
      state.record,
      update,
      "test",
      api,
    );
    const events = await provider.listAllMessages({ taskId: "sess_output" });
    expect(events.at(-1)?.providerOriginalRank).toBe(3);
    const attached = events.find((event) => event.type === "assistant_message")!
      .assistant_message as { attachments: Array<{ filename: string }> };
    expect(attached.attachments.map((file) => file.filename)).toEqual([
      "result.zip",
    ]);
    expect(state.record.providerRuntime!.usage).toEqual({
      input_tokens: 10,
      output_tokens: 2,
    });
    await expect(provider.downloadArtifact("foreign")).rejects.toThrow(
      "ARTIFACT_OWNERSHIP_INVALID",
    );
    await expect(provider.downloadArtifact("input_copy")).rejects.toThrow(
      "ARTIFACT_OWNERSHIP_INVALID",
    );
  });
});

describe("public execution text", () => {
  it("redacts credentials, cookies and signed URLs without reading tool output", () => {
    const text = safeExecutionText(
      "hello\nAuthorization: Bearer top-secret\nAPI_KEY=private-value\nhttps://object.test/report?signature=private",
    )!;
    expect(text).toContain("hello");
    expect(text).not.toMatch(/top-secret|private-value|signature/);
    expect(
      executionEventMessage({
        type: "agent.tool_result",
        content: "internal skill and secret",
      }),
    ).toBe("工具执行完成。");
    expect(
      executionEventMessage({ type: "agent.thinking", message: "hidden" }),
    ).toBeUndefined();
  });
  it("shows genuine assistant replies but excludes workflow internals and raw JSON", () => {
    expect(
      executionEventMessage({
        type: "assistant_message",
        assistant_message: { content: "已读取材料，开始核对来源。" },
      }),
    ).toBe("已读取材料，开始核对来源。");
    expect(
      safeExecutionText('FRONTMIND_MANUS_V2_OPERATION_CONTRACT={"id":"x"}'),
    ).toBeUndefined();
    expect(safeExecutionText('{"internal":true}')).toBeUndefined();
  });
});

it("preserves the original task and stricter skill constraints with the frozen transport schema", () => {
  const schema = {
    type: "object",
    additionalProperties: false,
    required: ["decision"],
    properties: { decision: { const: "accept" } },
  };
  const prompt = zhipuTaskPrompt({
    prompt: "Original skill and task instructions.",
    structuredOutputSchema: schema,
  });
  expect(prompt.startsWith("Original skill and task instructions.\n\n")).toBe(
    true,
  );
  expect(JSON.parse(prompt.split("\n").at(-1)!)).toEqual(schema);
  expect(prompt).toContain("Preserve the original Skill and its instructions.");
  expect(prompt).toContain(
    "The existing business interface expects this result shape:",
  );
});

it("retries a definite 429 rejection once while never replaying an unknown outcome", async () => {
  const uploadFile = vi
    .fn()
    .mockRejectedValueOnce(
      new ZhipuManagedError("/v1/files", 429, "HTTP_429", false),
    )
    .mockResolvedValueOnce({ id: "file_retry" });
  const provider = new ZhipuWebsiteAgentProvider(state.record, update, "test", {
    uploadFile,
  } as unknown as ZhipuManagedClient);
  const input = {
    filename: "original.skill.zip",
    contentType: "application/zip",
    bytes: Buffer.from("original"),
  };
  await expect(provider.uploadFile(input)).rejects.toMatchObject({
    status: 429,
    outcomeUnknown: false,
  });
  const first = {
    ...Object.values(state.record.providerRuntime!.mutations)[0]!,
  };
  expect((await provider.uploadFile(input)).fileId).toBe("file_retry");
  const final = Object.values(state.record.providerRuntime!.mutations)[0]!;
  expect(final).toMatchObject({
    state: "acknowledged",
    attempts: 2,
    startedAt: first.startedAt,
    requestHash: first.requestHash,
  });
  expect(uploadFile).toHaveBeenCalledTimes(2);
});
