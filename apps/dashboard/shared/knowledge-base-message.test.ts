import { describe, expect, it } from "vitest";

import {
  knowledgeBasePresentationMessagePublicId,
  knowledgeBaseUserMessagePublicId,
} from "./knowledge-base-message";

describe("knowledge-base durable message ids", () => {
  it("uses the authoritative turn id for optimistic user-message convergence", () => {
    expect(knowledgeBaseUserMessagePublicId("turn-123")).toBe(
      "msg-kb-user-turn-123",
    );
  });

  it("uses the full presentation digest without collision-prone truncation", () => {
    const key = "a".repeat(64);
    expect(knowledgeBasePresentationMessagePublicId(key)).toBe(
      `msg-kb-presentation-${key}`,
    );
  });

  it("rejects identities that cannot be safely persisted", () => {
    expect(() => knowledgeBaseUserMessagePublicId("bad id")).toThrow();
    expect(() => knowledgeBasePresentationMessagePublicId("short")).toThrow();
  });
});
