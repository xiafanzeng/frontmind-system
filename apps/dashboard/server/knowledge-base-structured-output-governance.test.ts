import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

const root = process.cwd();
const trustedAssistantConsumers = [
  "shared/knowledge-base-output.ts",
  "server/knowledge-base-api.ts",
  "server/knowledge-base-progress.ts",
  "server/knowledge-base-progress-service.ts",
  "server/knowledge-base-live-preview-api.ts",
  "server/knowledge-base-finalization.ts",
  "server/knowledge-base-finalization-supplement.ts",
  "server/knowledge-base-artifact-binding-service.ts",
  "server/knowledge-base-package-shadow-live.ts",
];

describe("knowledge-base trusted structured-output governance", () => {
  it("keeps assistant protocol consumers behind the bounded resolver", () => {
    for (const relativePath of trustedAssistantConsumers) {
      const source = readFileSync(path.join(root, relativePath), "utf8");
      expect(source, relativePath).not.toMatch(/JSON\.parse\s*\(/u);
    }

    const protocolParser = readFileSync(
      path.join(root, "server/knowledge-base-progress.ts"),
      "utf8",
    );
    expect(protocolParser).toContain("parseExactJson(rawCandidate)");
    expect(protocolParser).toContain(
      "repairStructuredJsonCandidate(rawCandidate",
    );
    expect(protocolParser).toContain('identityKeys: ["operationId", "turnId"]');

    const sharedProjection = readFileSync(
      path.join(root, "shared/knowledge-base-output.ts"),
      "utf8",
    );
    expect(sharedProjection).toContain("parseExactJson(raw)");
    expect(sharedProjection).toContain("repairStructuredJsonCandidate(raw");

    const finalizationSupplement = readFileSync(
      path.join(root, "server/knowledge-base-finalization-supplement.ts"),
      "utf8",
    );
    expect(finalizationSupplement).toContain("parseExactJson(line)");
    expect(finalizationSupplement).toContain(
      "repairStructuredJsonCandidate(line",
    );

    expect(
      readFileSync(
        path.join(root, "server/model-output-repair.ts"),
        "utf8",
      ).trim(),
    ).toMatch(
      /^\/\*\*[\s\S]*export \* from "\.\.\/shared\/model-output-repair";$/u,
    );
  });
});
