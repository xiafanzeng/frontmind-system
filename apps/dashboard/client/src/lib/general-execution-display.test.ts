import { describe, expect, it } from "vitest";
import { generalExecutionSlots } from "./general-execution-display";
import type { GeneralExecutionDto } from "@shared/frontmind-general-execution";

const execution: GeneralExecutionDto = {
  schemaVersion: 1,
  taskId: "t",
  coverage: "complete",
  timeline: [
    {
      id: "tool-1",
      turnId: "turn",
      userSequence: 1,
      userMessageId: "optimistic",
      timestamp: 100,
      rank: 0,
      kind: "tool",
      label: "读取文件",
      status: "completed",
    },
    {
      id: "message-1",
      turnId: "turn",
      userSequence: 1,
      userMessageId: "optimistic",
      timestamp: 100,
      rank: 1,
      kind: "message",
      providerEventId: "event-1",
    },
    {
      id: "tool-2",
      turnId: "turn",
      userSequence: 1,
      userMessageId: "optimistic",
      timestamp: 100,
      rank: 2,
      kind: "tool",
      label: "执行命令",
      status: "running",
    },
  ],
};
const messages = [
  { id: "user", role: "user", serverSequence: 1 },
  {
    id: "reply",
    role: "assistant",
    generalChat: { turnId: "turn", providerEventId: "event-1" },
  },
];
describe("public execution chronology", () => {
  it("marks a current confirmation wait without animating it or reviving an old wait", () => {
    const waiting = {
      ...execution.timeline[0]!,
      id: "wait",
      kind: "status" as const,
      status: "waiting" as const,
    };
    const dto = { ...execution, timeline: [waiting] };
    expect(
      generalExecutionSlots(messages, dto, true).after.get("user")?.[0],
    ).toMatchObject({ isCurrent: true, animate: false });
    expect(
      generalExecutionSlots(
        [...messages, { id: "new-user", role: "user", serverSequence: 5 }],
        dto,
        true,
      ).after.get("user")?.[0],
    ).toMatchObject({ isCurrent: false, animate: false });
  });
  it("interleaves equal-timestamp events by provider rank around unchanged messages", () => {
    const slots = generalExecutionSlots(messages, execution, true);
    expect(slots.before.get("reply")?.map((row) => row.id)).toEqual(["tool-1"]);
    expect(slots.after.get("reply")?.map((row) => row.id)).toEqual(["tool-2"]);
  });
  it("keeps pre-reply evidence anchored to the correct durable user after hydration", () => {
    const slots = generalExecutionSlots(
      [messages[0]!],
      { ...execution, timeline: [execution.timeline[0]!] },
      true,
    );
    expect(slots.after.get("user")?.[0]?.id).toBe("tool-1");
    expect(
      generalExecutionSlots(
        [{ id: "optimistic", role: "user" }],
        { ...execution, timeline: [execution.timeline[0]!] },
        true,
      ).after.has("optimistic"),
    ).toBe(true);
  });
  it("does not attach unanchored history to another optimistic turn", () => {
    const entry = { ...execution.timeline[0]!, userMessageId: undefined };
    const slots = generalExecutionSlots(
      [{ id: "another-turn", role: "user" }],
      { ...execution, timeline: [entry] },
      true,
    );
    expect(slots.before.size).toBe(0);
    expect(slots.after.size).toBe(0);
  });
  it("retains retry evidence without a spinner after a terminal task failure", () => {
    const retry = {
      ...execution.timeline[0]!,
      kind: "status" as const,
      status: "retrying" as const,
    };
    const slots = generalExecutionSlots(
      messages,
      { ...execution, timeline: [retry] },
      false,
    );
    expect(slots.after.get("user")).toEqual([
      expect.objectContaining({
        kind: "status",
        status: "retrying",
        animate: false,
      }),
    ]);
  });
  it("does not animate unconfirmed historical results when the task has ended", () => {
    expect(
      generalExecutionSlots(messages, execution).after.get("reply")?.[0],
    ).toMatchObject({ status: "unconfirmed" });
    expect(execution.timeline[2]).toMatchObject({ status: "running" });
  });

  it("never revives an earlier turn's spinner while the next optimistic turn runs", () => {
    const current = {
      ...execution.timeline[2]!,
      id: "current-tool",
      turnId: "next-turn",
      userSequence: 4,
      userMessageId: "next-user",
    };
    const slots = generalExecutionSlots(
      [...messages, { id: "next-user", role: "user" }],
      { ...execution, timeline: [...execution.timeline, current] },
      true,
    );
    expect(slots.after.get("reply")?.[0]).toMatchObject({
      id: "tool-2",
      status: "unconfirmed",
      animate: false,
    });
    expect(slots.after.get("next-user")?.[0]).toMatchObject({
      id: "current-tool",
      status: "running",
      animate: true,
    });
    expect(execution.timeline[2]).toMatchObject({ status: "running" });
  });

  it("anchors reused provider event IDs within their own turns", () => {
    const nextTool = {
      ...execution.timeline[0]!,
      id: "next-tool",
      turnId: "next-turn",
      userSequence: 4,
    };
    const nextReply = {
      ...execution.timeline[1]!,
      id: "next-reply",
      turnId: "next-turn",
      userSequence: 4,
    };
    const slots = generalExecutionSlots(
      [
        ...messages,
        { id: "next-user", role: "user", serverSequence: 4 },
        {
          id: "next-answer",
          role: "assistant",
          generalChat: { turnId: "next-turn", providerEventId: "event-1" },
        },
      ],
      {
        ...execution,
        timeline: [
          execution.timeline[0]!,
          execution.timeline[1]!,
          nextTool,
          nextReply,
        ],
      },
    );
    expect(slots.before.get("reply")?.map((entry) => entry.id)).toEqual([
      "tool-1",
    ]);
    expect(slots.before.get("next-answer")?.map((entry) => entry.id)).toEqual([
      "next-tool",
    ]);
  });

  it("preserves lifecycle chronology and animates only the current final phase", () => {
    const lifecycle = [
      "thinking",
      "running",
      "retrying",
      "ended",
      "cancelled",
    ] as const;
    const timeline = lifecycle.map((status, rank) => ({
      ...execution.timeline[0]!,
      id: `phase-${rank}`,
      rank,
      kind: "status" as const,
      status,
    }));
    const historical = generalExecutionSlots(
      messages,
      { ...execution, timeline },
      true,
    );
    expect(
      historical.after
        .get("user")
        ?.map((entry) => [entry.status, entry.animate]),
    ).toEqual(lifecycle.map((status) => [status, false]));
    const live = generalExecutionSlots(
      messages,
      { ...execution, timeline: timeline.slice(0, 3) },
      true,
    );
    expect(
      live.after.get("user")?.map((entry) => [entry.status, entry.animate]),
    ).toEqual([
      ["thinking", false],
      ["running", false],
      ["retrying", true],
    ]);
  });
});
