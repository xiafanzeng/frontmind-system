import { describe, expect, it } from "vitest";
import type {
  Conversation,
  LocalMessage,
} from "@/contexts/ConversationContext";
import {
  conversationExecutionTimings,
  executionTimelineTiming,
} from "./execution-duration";
import type { GeneralExecutionEntry } from "@shared/frontmind-general-execution";

const row = (
  turnId: string,
  timestamp: number,
  status: "running" | "ended",
  rank: number,
): GeneralExecutionEntry => ({
  id: `${turnId}-${rank}`,
  turnId,
  userSequence: turnId === "first" ? 1 : 3,
  timestamp,
  rank,
  kind: "status",
  status,
});
describe("persisted turn timing", () => {
  it("keeps earlier completed turns fixed while a new optimistic turn counts independently", () => {
    const messages: LocalMessage[] = [
      {
        id: "first-user",
        role: "user",
        content: "初建",
        timestamp: 1000,
        serverSequence: 1,
      },
      {
        id: "first-reply",
        role: "assistant",
        content: "已完成",
        timestamp: 1000,
      },
      { id: "next-user", role: "user", content: "补充", timestamp: 20000 },
    ];
    const conversation = {
      messages,
      status: "running",
      startedAt: 1000,
      execution: {
        schemaVersion: 1,
        taskId: "task",
        coverage: "complete",
        timeline: [
          row("first", 1000, "running", 0),
          row("first", 9000, "ended", 1),
        ],
      },
    } as Conversation;
    const times = conversationExecutionTimings(conversation, messages);
    expect(times.get("first-user")).toEqual({
      startedAt: 1000,
      completedAt: 9000,
      active: false,
    });
    expect(times.get("next-user")).toEqual({
      startedAt: 20000,
      completedAt: undefined,
      active: true,
    });
    expect(conversationExecutionTimings(conversation, messages.slice(0, 2)).get("first-user"))
      .toEqual({ startedAt: 1000, completedAt: 9000, active: false });
  });
  it("does not stop an active business run at an intermediate completed upload stage", () => {
    const stage = {
      ...row("first", 1000, "ended", 0),
      phase: "uploading" as const,
    };
    expect(executionTimelineTiming([stage], true)).toMatchObject({
      startedAt: 1000,
      active: true,
      completedAt: undefined,
    });
    expect(
      executionTimelineTiming([{ ...stage, timestamp: NaN }]),
    ).toBeUndefined();
  });
  it("uses the tool finish time for completed history and never uses the current time", () => {
    expect(
      executionTimelineTiming([
        { ...row("first", 1000, "ended", 0), finishedAt: 7000 },
      ]),
    ).toEqual({ startedAt: 1000, completedAt: 7000, active: false });
  });
});
