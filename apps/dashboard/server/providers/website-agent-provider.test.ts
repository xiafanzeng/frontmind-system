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
  createWebsiteAgentClient,
} from "./website-agent-provider";
import { ZhipuManagedClient, ZhipuManagedError } from "./zhipu-managed-client";
import { ManusV2Client } from "../manus-v2-client";
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
  it("keeps historical tasks on Manus despite new defaults", () => {
    expect(
      createWebsiteAgentClient(
        "test",
        { ...state.record, provider: undefined },
        update,
      ),
    ).toBeInstanceOf(ManusV2Client);
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
    ).toEqual(["error", "waiting", "stopped"]);
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
  it("opens the event channel before the single initial send and reuses saved resources", async () => {
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
  });
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
