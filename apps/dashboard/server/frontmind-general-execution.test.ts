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
          content: "private-reasoning",
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
      { commands: [] } as any,
    );
    expect(events.map((event) => event.id)).toEqual(["thinking", "call"]);
    expect(events[1]).toMatchObject({
      executionActivity: { kind: "tool_use", label: "搜索网页" },
    });
    expect(events[0]!.timestamp).toBeGreaterThan(0);
    expect(JSON.stringify(events)).not.toMatch(/private-|unprocessed-answer/);
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
  it("retains native linkage and strict result tri-state without arguments, results or reasoning", () => {
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
            content: [{ text: "secret-reasoning" }],
          },
        ],
        { commands: [] } as any,
      );
      expect(events[1]!.executionActivity).toEqual({
        kind: "tool_result",
        callId: "u",
        isError: flag ?? null,
      });
      expect(JSON.stringify(events)).not.toMatch(/secret-|input|content/);
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
