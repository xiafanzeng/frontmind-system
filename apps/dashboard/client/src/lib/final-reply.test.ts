import { describe, expect, it } from "vitest";
import { finalReplyIds } from "./final-reply";
import type { LocalMessage } from "@/contexts/ConversationContext";
const m = (id: string, role: "user" | "assistant", extra = {}): LocalMessage => ({id, role, content: id, timestamp: 1, ...extra});
describe("final answers", () => {
  it("keeps only the final response from each completed turn", () => {
    expect([...finalReplyIds([m("u1", "user"), m("thinking", "assistant"), m("answer1", "assistant", {stepGroups: [{steps: []}]}), m("u2", "user"), m("activity", "assistant"), m("answer2", "assistant")])]).toEqual(["answer1", "answer2"]);
  });
  it("does not copy live commentary but retains the previous turn's answer", () => {
    expect([...finalReplyIds([m("u1", "user"), m("a1", "assistant"), m("u2", "user"), m("checking the web", "assistant")], undefined, true)]).toEqual(["a1"]);
  });
  it("does not treat a steps placeholder as a returned answer", () => {
    expect(finalReplyIds([m("steps", "assistant", {isStepsPlaceholder: true})]).size).toBe(0);
  });
  it("does not turn a completed preparation step into a final model reply", () => {
    const replies = [m("u", "user"), m("checking", "assistant", {knowledgeBase: {turnId: "turn"}})];
    expect(finalReplyIds(replies, { schemaVersion: 1, taskId: "build", coverage: "partial", timeline: [
      { id: "step", turnId: "turn", userSequence: 1, rank: 2, timestamp: 1, kind: "status", phase: "staging", status: "ended" },
    ] }, true).size).toBe(0);
  });
});

describe("authoritative final answer regressions", () => {
  it("does not copy knowledge presentation even when it is the last assistant", () => {
    expect(finalReplyIds([m("summary", "assistant", { knowledgeBase: { kind: "presentation", turnId: "turn" } })]).size).toBe(0);
  });
  it("prefers the server final answer marker to a later public summary", () => {
    const base = { turnId: "turn", kind: "assistant_projection" };
    expect([...finalReplyIds([m("answer", "assistant", { generalChat: { ...base, isFinalAnswer: true } }), m("summary", "assistant", { generalChat: { ...base, isFinalAnswer: false } })])]).toEqual(["answer"]);
  });
});
