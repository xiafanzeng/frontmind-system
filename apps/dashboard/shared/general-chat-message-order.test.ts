import { describe, expect, it } from "vitest";
import {
  generalChatMessageIdentity,
  orderGeneralChatMessages,
  type GeneralChatMessageAnchor,
} from "./general-chat-message-order";

const user = (
  id: string,
  serverSequence: number,
): GeneralChatMessageAnchor => ({ id, role: "user", serverSequence });
const reply = (
  id: string,
  serverSequence: number,
  userSequence: number,
  rank: number,
): GeneralChatMessageAnchor => ({
  id,
  role: "assistant",
  serverSequence,
  generalChat: {
    agentTaskId: "task",
    turnId: `turn-${userSequence}`,
    providerEventId: id,
    userSequence,
    rank,
  },
});
const ids = (rows: GeneralChatMessageAnchor[]) => rows.map((row) => row.id);

describe("general chat turn ordering", () => {
  it("repairs the September 10 greeting at storage sequence 8 without changing stored rows", () => {
    const rows = [
      user("identity-question", 0),
      user("research", 2),
      reply("research-answer", 3, 2, 4),
      user("retry-later", 5),
      reply("retry-answer", 6, 5, 8),
      user("pdf-question", 7),
      reply("greeting", 8, 0, 1),
      reply("pdf-answer", 9, 7, 11),
    ];
    const result = orderGeneralChatMessages(rows);
    expect(ids(result)).toEqual([
      "identity-question",
      "greeting",
      "research",
      "research-answer",
      "retry-later",
      "retry-answer",
      "pdf-question",
      "pdf-answer",
    ]);
    expect(rows[6]!.serverSequence).toBe(8);
    expect(result[1]).toBe(rows[6]);
    expect(orderGeneralChatMessages(result)).toEqual(result);
  });
  it("uses provider rank for late events in the same turn and supports assistant-only DTOs", () => {
    const rows = [
      reply("late-first", 9, 0, 1),
      reply("second-turn", 5, 4, 7),
      reply("first-final", 1, 0, 3),
    ];
    expect(ids(orderGeneralChatMessages(rows))).toEqual([
      "late-first",
      "first-final",
      "second-turn",
    ]);
  });
  it("uses a real user ID before an obsolete user sequence", () => {
    const answer = reply("answer", 8, 7, 1);
    answer.generalChat!.userMessageId = "first";
    expect(
      ids(orderGeneralChatMessages([user("first", 0), user("pdf", 7), answer])),
    ).toEqual(["first", "answer", "pdf"]);
  });
  it("keeps pending browser requests after hydrated history", () => {
    const pending: GeneralChatMessageAnchor = {
      id: "pending",
      role: "user",
      generalChatDispatch: { kind: "pending_user" },
    };
    expect(
      ids(
        orderGeneralChatMessages([
          pending,
          user("first", 0),
          reply("greeting", 8, 0, 1),
        ]),
      ),
    ).toEqual(["first", "greeting", "pending"]);
    expect(
      ids(
        orderGeneralChatMessages([
          pending,
          { id: "legacy-user", role: "user" },
        ]),
      ),
    ).toEqual(["legacy-user", "pending"]);
  });
  it("keeps unbound historical replies in their original slots without assuming the latest turn", () => {
    const unbound: GeneralChatMessageAnchor = {
      id: "unbound",
      role: "assistant",
      generalChat: {
        agentTaskId: "task",
        turnId: "unknown",
        providerEventId: "unknown",
      },
    };
    const rows = [
      user("first", 0),
      unbound,
      user("pdf", 7),
      reply("greeting", 8, 0, 1),
    ];
    expect(orderGeneralChatMessages(rows)[1]).toBe(unbound);
  });
  it("scopes provider identities to both task and turn", () => {
    const first = reply("event", 1, 0, 1);
    const second = {
      ...first,
      generalChat: { ...first.generalChat!, turnId: "other-turn" },
    };
    const third = {
      ...first,
      generalChat: { ...first.generalChat!, agentTaskId: "other-task" },
    };
    expect(
      new Set([first, second, third].map(generalChatMessageIdentity)).size,
    ).toBe(3);
    expect(generalChatMessageIdentity(user("user", 0))).toBeUndefined();
  });
});
