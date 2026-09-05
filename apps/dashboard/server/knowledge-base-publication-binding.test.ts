import { describe, expect, it } from "vitest";

import { knowledgeBasePublicationBindingHash } from "./knowledge-base-publication-binding";

describe("knowledge-base publication binding", () => {
  it("uses the immutable archive hash for v4-style durable packages", () => {
    expect(
      knowledgeBasePublicationBindingHash({
        packageArchiveSha256: "A".repeat(64),
        packageDescriptorHash: "b".repeat(64),
      }),
    ).toBe("a".repeat(64));
  });

  it("retains the descriptor fallback only for historical packages", () => {
    expect(
      knowledgeBasePublicationBindingHash({
        packageArchiveSha256: null,
        packageDescriptorHash: "b".repeat(64),
      }),
    ).toBe("b".repeat(64));
    expect(
      knowledgeBasePublicationBindingHash({
        packageArchiveSha256: null,
        packageDescriptorHash: "invalid",
      }),
    ).toBeNull();
  });
});
