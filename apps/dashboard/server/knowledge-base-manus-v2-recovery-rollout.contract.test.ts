import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";

const read = (file: string) => fs.readFile(path.resolve(file), "utf8");

describe("knowledge-base materialized-v5 recovery retirement", () => {
  it("keeps only fresh turn recovery and package sweeps mounted", async () => {
    const [api, worker, runtime, backfill] = await Promise.all([
      read("server/knowledge-base-api.ts"),
      read("server/knowledge-base-recovery-worker.ts"),
      read("server/_core/index.ts"),
      read("scripts/backfill-knowledge-base-state-machine.ts"),
    ]);
    expect(api).not.toContain("recoverOpenKnowledgeBaseTasks");
    expect(worker).not.toContain("recoverOpenBuilds");
    expect(worker).not.toContain("migrateActiveLegacyBuilds");
    expect(runtime).toContain("recoverExpiredKnowledgeBaseTurns()");
    expect(runtime).toContain("runKnowledgeBasePackageSweep()");
    expect(backfill).not.toContain("recoverOpenKnowledgeBaseTasks");
    const main = backfill.slice(backfill.indexOf("async function main()"));
    expect(main.indexOf("assertKnowledgeBaseBackfillApplyRetired(apply)"))
      .toBeLessThan(main.indexOf("inspectWithSkillPins()"));
  });

  it("physically removes legacy recovery modules", async () => {
    for (const file of [
      "server/knowledge-base-manus-v2-lifecycle.ts",
      "server/knowledge-base-active-v2-migration-core.ts",
      "server/knowledge-base-manus-v2-rollout.ts",
      "server/knowledge-base-incident-repair.ts",
    ]) {
      await expect(fs.access(path.resolve(file))).rejects.toMatchObject({
        code: "ENOENT",
      });
    }
  });

  it("keeps staging provider-write-free and dispatch as the claim boundary", async () => {
    const source = await read("server/knowledge-base-api.ts");
    const stageStart = source.indexOf('router.post("/turn/attachments/stage"');
    const dispatchStart = source.indexOf('router.post("/turn/dispatch"');
    const nextRoute = source.indexOf('router.post("/turn"', dispatchStart);
    const stage = source.slice(stageStart, dispatchStart);
    const dispatch = source.slice(dispatchStart, nextRoute);
    expect(stageStart).toBeGreaterThan(-1);
    expect(dispatchStart).toBeGreaterThan(stageStart);
    expect(stage).toContain("stageKnowledgeBaseDeferredTurnAttachment({");
    expect(stage).not.toContain("launchAcceptedKnowledgeBaseClaim({");
    expect(dispatch).toContain("claimKnowledgeBaseDeferredTurnDispatch({");
    expect(dispatch).toContain("launchAcceptedKnowledgeBaseClaim({");
  });

  it("returns RESET_REQUIRED from every retired public rebuild route", async () => {
    const source = await read("server/knowledge-base-api.ts");
    for (const routeStart of [
      'router.post("/start/recover"',
      'router.post("/recovery/execute"',
      'router.post("/canonical/recover-from-snapshot"',
      'router.post("/turn/replace-attachments"',
      'router.post("/retry"',
    ]) {
      const start = source.indexOf(routeStart);
      const next = source.indexOf("router.", start + routeStart.length);
      const route = source.slice(start, next);
      expect(start).toBeGreaterThan(-1);
      expect(route).toContain("res.status(410)");
      expect(route).toContain('code: "RESET_REQUIRED"');
      expect(route).not.toContain("frontmindCredential");
      expect(route).not.toContain("launchAcceptedKnowledgeBaseClaim");
    }
  });

  it("gates fresh dispatch before one exact task create", async () => {
    const source = await read("server/knowledge-base-api.ts");
    const start = source.indexOf("async function dispatchMaterializedKnowledgeBaseClaim(");
    const end = source.indexOf("async function dispatchKnowledgeBaseRecoveryClaim(", start);
    const dispatch = source.slice(start, end);
    const birth = dispatch.indexOf("knowledgeBaseMaterializedRecoveryContractVersion(build) !== 1");
    const prepare = dispatch.indexOf("await input.ensureDispatch({");
    const mapping = dispatch.indexOf("await input.ensureManusV2Attachments({");
    const fence = dispatch.indexOf("await input.beginDispatch({");
    const create = dispatch.indexOf("await client.createTask({");
    expect(birth).toBeGreaterThan(-1);
    expect(prepare).toBeGreaterThan(birth);
    expect(mapping).toBeGreaterThan(prepare);
    expect(fence).toBeGreaterThan(mapping);
    expect(create).toBeGreaterThan(fence);
    expect(dispatch.match(/await client\.createTask\(\{/gu)).toHaveLength(1);
    expect(dispatch).not.toContain("findCreatedTask");
    expect(dispatch).not.toContain("sendMessage");
  });

  it("allows recovery only for exact materialized-v5 authority", async () => {
    const source = await read("server/knowledge-base-api.ts");
    const start = source.indexOf("async function dispatchKnowledgeBaseRecoveryClaim(");
    const end = source.indexOf("export const knowledgeBaseTerminalAnchorRecoveryTestHooks", start);
    const dispatch = source.slice(start, end);
    const resetFence = dispatch.indexOf("existingBuild.executionMode !==");
    expect(resetFence).toBeGreaterThan(-1);
    expect(dispatch).toContain('existingBuild.skillVersion !== "5"');
    expect(dispatch).toContain('existingBuild.providerProtocol !== "manus_v2"');
    expect(dispatch).toContain("knowledgeBaseMaterializedRecoveryContractVersion(existingBuild) !== 1");
    expect(dispatch.indexOf("return dispatchMaterializedKnowledgeBaseClaim({"))
      .toBeGreaterThan(resetFence);
    expect(dispatch).not.toContain("activateKnowledgeBaseManusV2Handoff");
    expect(dispatch).not.toContain("findCreatedTask");
  });

  it("keeps browser reconcile projection-only", async () => {
    const source = await read("server/knowledge-base-api.ts");
    const start = source.indexOf('router.post("/progress/reconcile"');
    const end = source.indexOf("export default router", start);
    const route = source.slice(start, end);
    expect(start).toBeGreaterThan(-1);
    expect(route).toContain("Browser polling is projection-only");
    expect(route).not.toContain("launchAcceptedKnowledgeBaseClaim({");
    expect(route).not.toContain("createTask({");
    expect(route).not.toContain("sendMessage({");
  });
});
