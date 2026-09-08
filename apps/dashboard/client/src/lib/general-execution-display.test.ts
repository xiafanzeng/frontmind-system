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
  it("does not retain a retry spinner after a terminal task failure", () => {
    const retry = {
      ...execution.timeline[0]!,
      kind: "status" as const,
      status: "retrying" as const,
    };
    expect(
      generalExecutionSlots(
        messages,
        { ...execution, timeline: [retry] },
        false,
      ).after.size,
    ).toBe(0);
  });
  it("does not animate unconfirmed historical results when the task has ended", () => {
    expect(
      generalExecutionSlots(messages, execution).after.get("reply")?.[0],
    ).toMatchObject({ status: "unconfirmed" });
    expect(execution.timeline[2]).toMatchObject({ status: "running" });
  });
});
