import { describe, expect, it } from "vitest";
import { siteOpsFinalReplyIds } from "./siteops-final-reply";
const message = (id: string, sequence: number, extra = {}): any => ({ id, sequence, role: "assistant", content: id, metadata: null, ...extra });
describe("site operations final replies", () => {
  it("excludes progress and preserves the final reply of historical turns while a new run works", () => {
    const messages = [message("user1", 1, { role: "user" }), message("analysis", 2), message("final1", 3), message("user2", 4, { role: "user" }), message("current-analysis", 5), message("progress", 6, { metadata: { siteOps: { kind: "build_progress", payload: {} } } })];
    expect([...siteOpsFinalReplyIds(messages, true)]).toEqual(["final1"]);
    expect([...siteOpsFinalReplyIds([...messages, message("final2", 7)], false)]).toEqual(["final1", "final2"]);
  });
  it("keeps a historical final reply without metadata copyable", () => {
    expect([...siteOpsFinalReplyIds([message("legacy-final", 1)], false)]).toEqual(["legacy-final"]);
  });
});
