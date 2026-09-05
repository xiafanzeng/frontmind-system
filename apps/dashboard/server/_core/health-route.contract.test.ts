import fs from "node:fs/promises";
import path from "node:path";

import { describe, expect, it } from "vitest";

describe("runtime health route contract", () => {
  it("keeps liveness lightweight and isolates database work in readiness", async () => {
    const [source, releaseChannelAdapter] = await Promise.all([
      fs.readFile(path.resolve("server/_core/index.ts"), "utf8"),
      fs.readFile(
        path.resolve("server/_core/release-channel-adapter.ts"),
        "utf8",
      ),
    ]);
    const healthStart = source.indexOf('app.get("/healthz"');
    const readinessStart = source.indexOf('app.get("/readyz"', healthStart);

    expect(healthStart).toBeGreaterThan(-1);
    expect(readinessStart).toBeGreaterThan(healthStart);
    expect(source).toContain("validateReleaseRuntimeEnvironment");
    expect(releaseChannelAdapter).toMatch(
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
    expect(source.slice(readinessStart, listener)).toContain(
      "fileRetention?.ready === true",
    );
  });

  it("keeps provider and credential diagnostics out of public readiness", async () => {
    const source = await fs.readFile(
      path.resolve("server/_core/index.ts"),
      "utf8",
    );
    const readinessStart = source.indexOf('app.get("/readyz"');
    const listener = source.indexOf("server.listen(", readinessStart);
    const readiness = source.slice(readinessStart, listener);

    expect(readinessStart).toBeGreaterThan(-1);
    expect(readiness).not.toContain("monitorCredentialAuthenticated:");
    expect(readiness).not.toContain("knowledgeBaseManusV2Writer:");
    expect(readiness).not.toContain("knowledgeBaseManusV2ActiveMigration:");
    expect(readiness).not.toContain("latestExpectedTag:");
    expect(readiness).not.toContain("latestAppliedTag:");
  });

  it("retains only neutral deployment identity, schema and degradation fields", async () => {
    const source = await fs.readFile(
      path.resolve("server/_core/index.ts"),
      "utf8",
    );
    const readinessStart = source.indexOf('app.get("/readyz"');
    const listener = source.indexOf("server.listen(", readinessStart);

    const readiness = source.slice(readinessStart, listener);
    expect(readiness).toContain("channel: applicationReleaseChannel");
    expect(readiness).toContain("sha: applicationBuildSha");
    expect(readiness).toContain("imageDigest: applicationImageDigest");
    expect(readiness).toContain("migrationState.schema.status");
    expect(readiness).toContain("templateCatalog.ready === true");
    expect(readiness).toContain(
      "templateCatalog.requiredAdmissionReady === true",
    );
    expect(readiness).toContain(
      "version: templateCatalog.activeCatalogVersion",
    );
    expect(readiness).toContain("degradedBuildCount:");
    expect(readiness).toContain("violationCount:");
  });

  it("returns unavailable when the required #22 execution admission is absent", async () => {
    const source = await fs.readFile(
      path.resolve("server/_core/index.ts"),
      "utf8",
    );
    const readinessStart = source.indexOf('app.get("/readyz"');
    const readyStart = source.indexOf("const ready =", readinessStart);
    const statusStart = source.indexOf("const status =", readyStart);
    const readinessDecision = source.slice(readyStart, statusStart);

    expect(readinessDecision).toContain("templateCatalog.ready === true");
    expect(readinessDecision).toContain(
      "templateCatalog.requiredAdmissionReady === true",
    );
    expect(source.slice(statusStart)).toContain(
      "const status = ready ? 200 : 503",
    );
  });

  it("removes the legacy writer and active-migration rollout control plane", async () => {
    const source = await fs.readFile(
      path.resolve("server/_core/index.ts"),
      "utf8",
    );
    const readinessStart = source.indexOf('app.get("/readyz"');
    const listener = source.indexOf("server.listen(", readinessStart);
    const readiness = source.slice(readinessStart, listener);

    expect(source).not.toContain("knowledgeBaseManusV2WriterEnabled()");
    expect(source).not.toContain(
      "knowledgeBaseManusV2ActiveMigrationEnabled()",
    );
    expect(readiness).not.toContain("knowledgeBaseManusV2Writer:");
    expect(readiness).not.toContain("knowledgeBaseManusV2ActiveMigration:");
    expect(source).not.toContain('"[KnowledgeBase] manus_v2_writer"');
    expect(source).not.toContain('"[KnowledgeBase] manus_v2_active_migration"');
    expect(source).not.toContain("migrateActiveLegacyBuilds");
  });

  it("removes active-migration diagnostics from the runtime", async () => {
    const source = await fs.readFile(
      path.resolve("server/_core/index.ts"),
      "utf8",
    );
    const readinessStart = source.indexOf('app.get("/readyz"');
    const readyStart = source.indexOf("const ready =", readinessStart);
    const statusStart = source.indexOf("const status =", readyStart);
    const responseStart = source.indexOf("const response =", statusStart);
    const listener = source.indexOf("server.listen(", responseStart);

    expect(source.slice(readyStart, statusStart)).not.toContain(
      "knowledgeBaseMigrationDiagnostics",
    );
    expect(source.slice(responseStart, listener)).not.toContain(
      "knowledgeBaseMigrationDiagnostics.snapshot",
    );
    expect(source.slice(listener)).not.toContain(
      "knowledgeBaseMigrationDiagnostics.recordSweep",
    );
    expect(source).not.toContain("knowledgeBaseMigrationDiagnostics.snapshot");
  });

  it("exposes build-local degradation without using it in the readiness decision", async () => {
    const source = await fs.readFile(
      path.resolve("server/_core/index.ts"),
      "utf8",
    );
    const readinessStart = source.indexOf('app.get("/readyz"');
    const readyStart = source.indexOf("const ready =", readinessStart);
    const statusStart = source.indexOf("const status =", readyStart);
    const responseStart = source.indexOf("const response =", statusStart);
    const listener = source.indexOf("server.listen(", responseStart);

    expect(source.slice(readyStart, statusStart)).not.toContain(
      "degradedBuildCount",
    );
    expect(source.slice(responseStart, listener)).toContain(
      "invariantSnapshot.degradedBuildCount",
    );
  });

  it("gates readiness only on workers owned by the current runtime role", async () => {
    const source = await fs.readFile(
      path.resolve("server/_core/index.ts"),
      "utf8",
    );
    const readinessStart = source.indexOf('app.get("/readyz"');
    const listener = source.indexOf("server.listen(", readinessStart);
    const readiness = source.slice(readinessStart, listener);

    expect(source).toContain("runtimeRoleReadinessRequirements(runtimeRole)");
    expect(readiness).toContain("readinessRequirements.knowledgeBaseRecovery");
    expect(readiness).toContain("!readinessRequirements.managedUploads");
  });
});
