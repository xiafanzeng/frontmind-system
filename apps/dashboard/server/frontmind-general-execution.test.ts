import { describe, expect, it } from "vitest";
import { projectGeneralExecution } from "./frontmind-general-execution";
import {
  nativeGeneralExecutionActivity,
  normalizeDashboardZhipuEvents,
} from "./providers/dashboard-agent-provider";
import {
  frontmindGeneralIdentity,
  GENERAL_IDENTITY_VERSION,
} from "./frontmind-general-identity";

const row = (
  id: string,
  rank: number,
  activity: unknown,
  extra: Record<string, unknown> = {},
) => ({
  taskId: "task",
  providerEventId: id,
  providerTimestampMs: 1700000000000,
  normalizedPayload: {
    kind: "provider_event",
    providerOriginalRank: rank,
    executionActivity: activity,
    executionTurn: { id: "turn", userSequence: 4 },
    ...extra,
  },
});
const use = (name = "read") =>
  nativeGeneralExecutionActivity({
    type: "agent.tool_use",
    name,
    input: { token: "secret-tool-input" },
  });

describe("Managed public execution evidence", () => {
  it("shows pending native activity from its creation time without exposing unprocessed messages", () => {
    const events = normalizeDashboardZhipuEvents(
      [
        {
          id: "thinking",
          type: "agent.thinking",
          processed_at: null,
          created_at: "2026-09-09T01:00:00Z",
          content: " 先检查题目。\n再执行验证。 ",
        },
        {
          id: "call",
          type: "agent.tool_use",
          name: "web_search",
          processed_at: null,
          created_at: "2026-09-09T01:00:01Z",
          input: { query: "private-query" },
        },
        {
          id: "draft",
          type: "agent.message",
          processed_at: null,
          created_at: "2026-09-09T01:00:02Z",
          content: "unprocessed-answer",
        },
        { id: "untimed", type: "agent.thinking", processed_at: null },
        {
          id: "unprocessed-result",
          type: "agent.tool_result",
          tool_use_id: "call",
          is_error: false,
          processed_at: null,
          created_at: "2026-09-09T01:00:02Z",
        },
        {
          id: "unprocessed-end",
          type: "session.status_idle",
          stop_reason: { type: "end_turn" },
          processed_at: null,
          created_at: "2026-09-09T01:00:03Z",
        },
      ],
      { commands: [], generalIdentitySystem: "frontmind-general-v2" } as any,
    );
    expect(events.map((event) => event.id)).toEqual(["thinking", "call"]);
    expect(events[1]).toMatchObject({
      executionActivity: { kind: "tool_use", label: "搜索网页" },
    });
    expect(events[0]!.timestamp).toBeGreaterThan(0);
    expect(events[0]!.executionActivity).toMatchObject({
      thinkingText: " 先检查题目。\n再执行验证。 ",
      thinkingSource: "event",
    });
    expect(JSON.stringify(events)).not.toMatch(
      /private-query|unprocessed-answer/,
    );
  });
  it("retains lifecycle history and tool kind for presentation while omitting impossible durations", () => {
    const dto = projectGeneralExecution("task", [
      row("think", 0, { kind: "status", status: "thinking" }),
      row(
        "call",
        1,
        nativeGeneralExecutionActivity({
          type: "agent.mcp_tool_use",
          name: "private-name",
        }),
      ),
      {
        ...row("result", 2, {
          kind: "tool_result",
          callId: "call",
          isError: false,
        }),
        providerTimestampMs: 1699999999000,
      },
      row("retry", 3, { kind: "status", status: "retrying" }),
      row("end", 4, { kind: "status", status: "ended" }),
    ]);
    expect(dto.timeline.map((entry) => entry.kind)).toEqual([
      "status",
      "tool",
      "status",
      "status",
    ]);
    expect(dto.timeline[1]).toMatchObject({
      label: "调用扩展工具",
      toolKind: "mcp",
      status: "completed",
    });
    expect(dto.timeline[1]).not.toHaveProperty("finishedAt");
    expect(JSON.stringify(dto)).not.toContain("private-name");
  });
  it("retains native linkage and thinking text while excluding tool arguments and result payloads", () => {
    for (const flag of [true, false, undefined]) {
      const events = normalizeDashboardZhipuEvents(
        [
          {
            id: "u",
            type: "agent.tool_use",
            processed_at: "2026-09-08T01:00:00Z",
            name: "read",
            input: { path: "secret-input" },
          },
          {
            id: "r",
            type: "agent.tool_result",
            processed_at: "2026-09-08T01:00:00Z",
            tool_use_id: "u",
            is_error: flag,
            content: [{ text: "secret-output" }],
          },
          {
            id: "t",
            type: "agent.thinking",
            processed_at: "2026-09-08T01:00:00Z",
            content: [{ type: "text", text: "先核对材料，再计算。" }],
          },
        ],
        { commands: [], generalIdentitySystem: "frontmind-general-v2" } as any,
      );
      expect(events[1]!.executionActivity).toEqual({
        kind: "tool_result",
        callId: "u",
        isError: flag ?? null,
      });
      expect(JSON.stringify(events)).not.toMatch(/secret-input|secret-output/);
      expect(events[2]!.executionActivity).toMatchObject({
        thinkingText: "先核对材料，再计算。",
        thinkingComplete: true,
      });
      expect(events.map((event) => event.providerOriginalRank)).toEqual([
        0, 1, 2,
      ]);
    }
  });
  it("pairs simultaneous calls by native ID, never nearest timestamp, and does not leak unknown names", () => {
    const dto = projectGeneralExecution("task", [
      row("b", 1, use("https://secret/?token=x")),
      row("a", 0, use()),
      row("rb", 2, { kind: "tool_result", callId: "b", isError: true }),
      row("ra", 3, { kind: "tool_result", callId: "a", isError: false }),
    ]);
    expect(
      dto.timeline.map((entry) =>
        entry.kind === "tool" ? [entry.label, entry.status] : null,
      ),
    ).toEqual([
      ["读取文件", "completed"],
      ["调用工具", "failed"],
    ]);
    expect(JSON.stringify(dto)).not.toContain("secret");
    expect(
      projectGeneralExecution(
        "task",
        [
          ...[
            row("a", 0, use()),
            row("ra", 3, { kind: "tool_result", callId: "a", isError: false }),
          ],
        ].reverse(),
      ).timeline[0]!.id,
    ).toBe(dto.timeline[0]!.id);
  });
  it("pairs a result even when its native rank precedes the call", () => {
    const dto = projectGeneralExecution("task", [
      row("result", 0, { kind: "tool_result", callId: "call", isError: false }),
      row("call", 1, use()),
      row("end", 2, { kind: "status", status: "ended" }),
    ]);
    expect(dto.timeline.filter((entry) => entry.kind === "tool")).toEqual([
      expect.objectContaining({ label: "读取文件", status: "completed" }),
    ]);
  });
  it("does not bind cross-turn or cross-task results, nor treat missing is_error as success", () => {
    const dto = projectGeneralExecution("task", [
      row("a", 0, use()),
      row(
        "ra",
        1,
        { kind: "tool_result", callId: "a", isError: false },
        { executionTurn: { id: "other-turn", userSequence: 9 } },
      ),
      row("orphan", 2, { kind: "tool_result", callId: "absent" }),
      { ...row("foreign", 3, use()), taskId: "other-task" },
      row("unbound", 4, use(), { executionTurn: null }),
    ]);
    expect(dto.timeline).toHaveLength(3);
    expect(dto.timeline[0]).toMatchObject({ kind: "tool", status: "running" });
    expect(dto.timeline[2]).toMatchObject({
      kind: "tool",
      status: "returned",
      resultOnly: true,
    });
  });
  it("requires lifecycle waiting IDs and does not infer missing tool results from end_turn", () => {
    const a = row("a", 0, use());
    const wait = row(
      "w",
      1,
      nativeGeneralExecutionActivity({
        type: "session.status_idle",
        stop_reason: { type: "requires_action", event_ids: ["a"] },
      }),
    );
    expect(
      projectGeneralExecution("task", [a, wait]).timeline[0],
    ).toMatchObject({ status: "waiting" });
    expect(
      projectGeneralExecution("task", [
        a,
        row("end", 2, { kind: "status", status: "ended" }),
      ]).timeline[0],
    ).toMatchObject({ status: "unconfirmed" });
    expect(
      nativeGeneralExecutionActivity({
        type: "agent.tool_use",
        name: "read",
        evaluated_permission: "ask",
      }),
    ).toEqual(use());
  });
  it("marks coverage only after durable snapshot apply and excludes unbound history", () => {
    const a = row("a", 0, use());
    expect(projectGeneralExecution("task", [a]).coverage).toBe("pending");
    expect(
      projectGeneralExecution("task", [
        a,
        row("marker", 3, null, {
          kind: "local_projection_snapshot",
          status: "applied",
          executionVersion: 1,
        }),
      ]).coverage,
    ).toBe("complete");
  });
  it("uses FrontMind product identity without preset vendor expansion or false training claims", () => {
    expect(GENERAL_IDENTITY_VERSION).toBe("frontmind-general-v2");
    const system = frontmindGeneralIdentity("glm-5.3");
    expect(system).toContain("我是 FrontMind 通用智能体");
    expect(system).not.toMatch(/glm-5\.3|Z\.ai|智谱提供/);
    expect(system).toContain(
      "身份回答仅介绍 FrontMind，不追加底层模型、供应商、训练机构或产品层关系的说明",
    );
    expect(system).toContain("不编造训练或研发归属");
    expect(system).toContain("没有实际执行的操作不能声称完成");
    expect(system).toContain("开始和关键进展处用一到两句话");
    expect(system).toContain("正文不要重复工具调用日志");
  });
});

describe("Provider thinking transcript projection", () => {
  const began = "2026-09-09T02:00:00Z";
  const captures = [
    {
      eventId: "think",
      commandKey: "initial",
      afterEventId: "user",
      text: " 先计算\n再验证 <script>原文</script> ",
      startedAt: began,
      complete: true,
    },
  ];
  const runtime = {
    commands: [{ key: "initial", eventId: "user", createdAt: began }],
    thinkingCaptures: captures,
    generalIdentitySystem: "frontmind-general-v2",
  } as any;
  // No command projection fields are needed here: use an unowned user message
  // as the chronological boundary and a separately acknowledged runtime key.
  const raw = [
    { id: "user", type: "user.message", processed_at: began, content: [] },
  ];
  const normalize = (events: any[], state = runtime) =>
    normalizeDashboardZhipuEvents(events, {
      ...state,
      commands: state.commands.map((command: any) => ({
        ...command,
        prompt: "",
        providerPromptHash:
          "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
        attachments: [],
      })),
    });
  it("keeps streamed text when the complete history event contains no text", () => {
    const normalized = normalize([
      ...raw,
      { id: "think", type: "agent.thinking", processed_at: began },
    ]);
    expect(normalized[1]!.executionActivity).toMatchObject({
      thinkingText: captures[0]!.text,
      thinkingSource: "stream",
      thinkingComplete: true,
    });
    const dto = projectGeneralExecution(
      "task",
      normalized.map((event, index) =>
        row(event.id, index, event.executionActivity),
      ),
    );
    expect(dto.timeline.find((item) => item.kind === "status")).toMatchObject({
      thinkingText: captures[0]!.text,
    });
  });
  it("shows only a positively command-bound stream preview with its real event id", () => {
    const normalized = normalize(raw);
    expect(normalized.map((item) => item.id)).toEqual(["user", "think"]);
    expect(normalized[1]).toMatchObject({
      providerProjection: "zhipu_thinking_stream_preview",
      executionActivity: { thinkingSource: "stream" },
    });
    expect(
      normalize(raw, {
        ...runtime,
        thinkingCaptures: [{ ...captures[0], commandKey: "foreign" }],
      }),
    ).toHaveLength(1);
  });
  it("does not attach a capture to another turn or overwrite an authoritative full text", () => {
    const withNextTurn = [
      ...raw,
      { id: "next", type: "user.message", processed_at: began },
      { id: "think", type: "agent.thinking", processed_at: began },
    ];
    expect(
      normalize(withNextTurn).at(-1)!.executionActivity,
    ).not.toHaveProperty("thinkingText");
    expect(normalize(withNextTurn).map((item) => item.id)).toEqual([
      "user",
      "next",
      "think",
    ]);
    expect(
      normalize([
        ...raw,
        {
          id: "think",
          type: "agent.thinking",
          processed_at: began,
          content: "完整正文",
        },
      ])[1]!.executionActivity,
    ).toMatchObject({ thinkingText: "完整正文", thinkingSource: "event" });
  });
  it("binds repeated provider event IDs to their own command boundaries", () => {
    const secondRuntime = {
      ...runtime,
      commands: [
        ...runtime.commands,
        {
          key: "turn:2",
          eventId: "next",
          createdAt: began,
          prompt: "",
          providerPromptHash:
            "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
          attachments: [],
        },
      ],
      thinkingCaptures: [
        ...captures,
        {
          ...captures[0],
          commandKey: "turn:2",
          afterEventId: "next",
          text: "第二轮正文",
        },
      ],
    } as any;
    const normalized = normalize(
      [
        ...raw,
        { id: "next", type: "user.message", processed_at: began, content: [] },
      ],
      secondRuntime,
    );
    expect(normalized.map((item) => item.id)).toEqual([
      "user",
      "think",
      "next",
      "think",
    ]);
    expect(normalized[1]!.executionActivity).toMatchObject({
      thinkingText: captures[0]!.text,
    });
    expect(normalized[3]!.executionActivity).toMatchObject({
      thinkingText: "第二轮正文",
    });
  });
  it("does not project stream captures outside the general agent", () => {
    const normalized = normalize(raw, {
      ...runtime,
      generalIdentitySystem: undefined,
    });
    expect(normalized).toHaveLength(1);
    expect(normalized[0]!.executionActivity).toBeUndefined();
  });
  it("keeps thinking text restricted to thinking statuses at the read boundary", () => {
    const dto = projectGeneralExecution("task", [
      row("run", 0, {
        kind: "status",
        status: "running",
        thinkingText: "not a thinking event",
      }),
      row("text", 1, {
        kind: "status",
        status: "thinking",
        thinkingText: captures[0]!.text,
        input: "ignored",
      }),
    ]);
    expect(dto.timeline[0]).not.toHaveProperty("thinkingText");
    expect(dto.timeline[1]).toMatchObject({ thinkingText: captures[0]!.text });
    expect(JSON.stringify(dto)).not.toContain("ignored");
  });
});
