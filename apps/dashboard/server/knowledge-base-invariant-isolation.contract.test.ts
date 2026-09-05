import { readFile } from "node:fs/promises";
import path from "node:path";

import { describe, expect, it } from "vitest";

describe("knowledge-base invariant isolation contract", () => {
  it("never turns build-level findings into a global write block", async () => {
    const [auditSource, runtimeSource] = await Promise.all([
      readFile(
        path.join(process.cwd(), "server/knowledge-base-invariant-audit.ts"),
        "utf8",
      ),
      readFile(path.join(process.cwd(), "server/_core/index.ts"), "utf8"),
    ]);

    expect(auditSource).not.toContain(
      "activateKnowledgeBaseInvariantWriteBlock",
    );
    expect(runtimeSource).not.toContain("blockWritesOnP0: true");
    expect(auditSource).toContain(
      '[KnowledgeBaseInvariant] build_degraded',
    );
  });
});
