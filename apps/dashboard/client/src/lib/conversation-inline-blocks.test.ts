import { describe, expect, it } from "vitest";
import { conversationInlineSlots } from "./conversation-inline-blocks";
import type { LocalMessage } from "@/contexts/ConversationContext";
const message = (id: string, turnId?: string): LocalMessage => ({
  id,
  role: "assistant",
  content: "response",
  timestamp: 1,
  ...(turnId
    ? {
        generalChat: {
          schemaVersion: 1,
          kind: "assistant_projection",
          turnId,
          agentTaskId: "task",
          providerEventId: id,
          serverOwned: true,
        } as const,
      }
    : {}),
});
describe("business block transcript anchors", () => {
  it("places a public process before its exact reply while actions stay after", () => {
    const slots = conversationInlineSlots([message("reply", "turn-one"), message("newer", "turn-two")], [
      { id: "process", anchor: { kind: "message", messageId: "reply" }, placement: "before", content: "Reading documents" },
      { id: "accept", anchor: { kind: "message", messageId: "reply" }, content: "Confirm" },
    ]);
    expect(slots.before.get("reply")?.map((block) => block.id)).toEqual(["process"]);
    expect(slots.after.get("reply")?.map((block) => block.id)).toEqual(["accept"]);
    expect(slots.before.has("newer")).toBe(false);
  });
  it("retains exact message/turn placement after another assistant response arrives", () => {
    const slots = conversationInlineSlots(
      [
        message("first", "turn-1"),
        message("second", "turn-1"),
        message("latest", "turn-2"),
      ],
      [
        { id: "initial", anchor: { kind: "initial" }, content: "opening" },
        {
          id: "draft",
          anchor: { kind: "message", messageId: "first" },
          content: "draft",
        },
        {
          id: "confirm",
          anchor: { kind: "turn", turnId: "turn-1" },
          content: "confirm",
        },
        {
          id: "orphan",
          anchor: { kind: "message", messageId: "deleted" },
          content: "do not guess",
        },
      ],
    );
    expect(slots.initial.map((block) => block.id)).toEqual(["initial"]);
    expect(slots.after.get("first")?.map((block) => block.id)).toEqual([
      "draft",
    ]);
    expect(slots.after.get("second")?.map((block) => block.id)).toEqual([
      "confirm",
    ]);
    expect(slots.after.has("latest")).toBe(false);
    expect(slots.after.has("deleted")).toBe(false);
  });
  it("never attaches blocks from a previous task and does not duplicate a stable block id", () => {
    const blocks = [
      {
        id: "saved",
        anchor: { kind: "message" as const, messageId: "old" },
        content: "saved",
      },
      { id: "open", anchor: { kind: "initial" as const }, content: "open" },
      {
        id: "open",
        anchor: { kind: "initial" as const },
        content: "duplicate",
      },
    ];
    const slots = conversationInlineSlots([message("new", "new-turn")], blocks);
    expect(slots.initial).toHaveLength(1);
    expect(slots.after.size).toBe(0);
  });
});
