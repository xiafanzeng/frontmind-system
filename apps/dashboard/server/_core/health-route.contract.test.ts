import fs from "node:fs/promises";
import path from "node:path";

import { describe, expect, it } from "vitest";

describe("runtime health route contract", () => {
  it("keeps liveness lightweight and isolates database work in readiness", async () => {
    const source = await fs.readFile(
      path.resolve("server/_core/index.ts"),
      "utf8",
    );
    const healthStart = source.indexOf('app.get("/healthz"');
    const readinessStart = source.indexOf('app.get("/readyz"', healthStart);

    expect(healthStart).toBeGreaterThan(-1);
    expect(readinessStart).toBeGreaterThan(healthStart);
    expect(source).toMatch(
      /runtimeIdentity\.buildSourceSha !== applicationBuildSha[\s\S]*FRONTMIND_RUNTIME_BUILD_SOURCE_SHA_MISMATCH/u,
    );
    const healthRoute = source.slice(healthStart, readinessStart);
    expect(healthRoute).toContain("res.status(200).json");
    expect(healthRoute).not.toMatch(
      /\b(?:await|getDb|evaluateKnowledgeBaseReadiness|evaluateReleaseReadiness|verifyCurrentReleaseArtifact)\b/u,
    );
    expect(source.slice(readinessStart)).toMatch(
      /\bgetDb\(\)[\s\S]*\bevaluateReleaseReadiness\(/u,
    );
  });

  it("runs and caches file-retention evidence before binding the listener", async () => {
    const source = await fs.readFile(
      path.resolve("server/_core/index.ts"),
      "utf8",
    );
    const lifecycleBackfill = source.indexOf(
      "prepareFileContentRetentionForServing()",
    );
    const retentionPreflight = source.indexOf(
      "inspectFileRetentionPreflight()",
      lifecycleBackfill,
    );
    const listener = source.indexOf("server.listen(", retentionPreflight);
    const cleanupScheduler = source.indexOf(
      "startFileContentRetentionScheduler(",
      listener,
    );
    const readinessStart = source.indexOf('app.get("/readyz"');

    expect(lifecycleBackfill).toBeGreaterThan(-1);
    expect(retentionPreflight).toBeGreaterThan(lifecycleBackfill);
    expect(listener).toBeGreaterThan(retentionPreflight);
    expect(cleanupScheduler).toBeGreaterThan(listener);
    expect(source.slice(readinessStart, listener)).toContain(
      "fileRetentionPreflightEvidence.read()",
    );
    expect(source.slice(readinessStart, listener)).toContain("fileRetention,");
  });
});
