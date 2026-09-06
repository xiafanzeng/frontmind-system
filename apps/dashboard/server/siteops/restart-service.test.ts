import { describe, expect, it } from "vitest";
import { MySqlDialect } from "drizzle-orm/mysql-core";
import {
  messages,
  siteBuilds,
  siteOperations,
  siteProjects,
  socialPackages,
  visualCandidatePools,
  visualCandidatePoolPages,
} from "../../drizzle/schema";
import {
  restartSiteOpsProject,
  siteOpsOperationBlocksRestart,
  siteOpsRestartState,
} from "./restart-service";

const now = new Date("2026-09-06T04:00:00.345Z");
const project = {
  id: "project-1",
  userId: 7,
  conversationId: "siteops:7",
  revision: 4,
  currentBuildId: "build-1",
  currentKnowledgeSnapshotId: "knowledge-1",
  globalLiveDeploymentId: "live-global",
  mainlandLiveDeploymentId: "live-mainland",
  canonicalHostname: "customer.example.com",
} as typeof siteProjects.$inferSelect;

function fixture(operations: object[] = [], projectAffectedRows = 1) {
  const writes: Array<{
    table: unknown;
    values: Record<string, unknown>;
    where?: unknown;
  }> = [];
  const reads: Array<{ table: unknown; where: unknown }> = [];
  const rowsFor = (table: unknown) =>
    table === siteOperations
      ? operations
      : table === messages
        ? [{ sequence: 8 }]
        : table === visualCandidatePools
          ? [{ id: "pool-1" }]
          : [];
  const tx = {
    select: () => ({
      from: (table: unknown) => ({
        where: (where: unknown) => {
          reads.push({ table, where });
          return {
            for: async () => rowsFor(table),
            then: (resolve: any, reject: any) =>
              Promise.resolve(rowsFor(table)).then(resolve, reject),
          };
        },
      }),
    }),
    update: (table: unknown) => ({
      set: (values: Record<string, unknown>) => ({
        where: async (where: unknown) => {
          writes.push({ table, values, where });
          return [
            { affectedRows: table === siteProjects ? projectAffectedRows : 1 },
          ];
        },
      }),
    }),
    insert: (table: unknown) => ({
      values: async (values: Record<string, unknown>) => {
        writes.push({ table, values });
      },
    }),
  };
  return { tx, writes, reads };
}

describe("customer direct SiteOps restart", () => {
  it("offers restart after workflow progress without an approval state", () => {
    expect(siteOpsRestartState({ currentBuildId: null })).toMatchObject({
      allowed: false,
    });
    expect(
      siteOpsRestartState({ currentBuildId: null, hasWorkflowProgress: true }),
    ).toMatchObject({ allowed: true });
  });

  it.each([
    "publish_global",
    "publish_mainland",
    "rollback",
    "domain_sync",
    "dns_rollback",
  ])("blocks an active external %s operation before mutation", async (kind) => {
    const f = fixture([
      { id: "external", kind, provider: "aliyun_esa", status: "running" },
    ]);
    await expect(
      restartSiteOpsProject(f.tx, { project, requestId: "restart-1", now }),
    ).rejects.toMatchObject({ code: "IN_FLIGHT_OPERATION" });
    expect(f.writes).toEqual([]);
    expect(
      siteOpsOperationBlocksRestart({
        kind,
        provider: "aliyun_esa",
        status: "succeeded",
      }),
    ).toBe(false);
  });

  it("starts a fresh local cycle, releases pending generation quota and preserves the published website", async () => {
    const f = fixture([
      {
        id: "generation-1",
        kind: "site_build",
        provider: "zhipu",
        status: "running",
      },
    ]);
    await expect(
      restartSiteOpsProject(f.tx, { project, requestId: "restart-1", now }),
    ).resolves.toEqual({ revision: 5, sourceBuildId: "build-1" });
    const update = f.writes.find((w) => w.table === siteProjects)!;
    expect(update.values).toMatchObject({
      currentBuildId: null,
      currentKnowledgeSnapshotId: "knowledge-1",
      brief: null,
      revision: 5,
      status: "draft",
      knowledgeInputEpochId: expect.any(String),
      currentTaskStartedAt: new Date("2026-09-06T04:00:00Z"),
    });
    for (const field of [
      "globalLiveDeploymentId",
      "mainlandLiveDeploymentId",
      "canonicalHostname",
    ])
      expect(update.values).not.toHaveProperty(field);
    expect(f.writes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          table: siteOperations,
          values: expect.objectContaining({
            status: "cancelled",
            leaseOwner: null,
          }),
        }),
        expect.objectContaining({
          table: socialPackages,
          values: expect.objectContaining({ quotaState: "released" }),
        }),
        expect.objectContaining({
          table: siteBuilds,
          values: expect.objectContaining({ quotaState: "released" }),
        }),
        expect.objectContaining({
          table: visualCandidatePoolPages,
          values: expect.objectContaining({ status: "superseded" }),
        }),
        expect.objectContaining({
          table: messages,
          values: expect.objectContaining({ sequence: 9, userId: 7 }),
        }),
      ]),
    );
    const dialect = new MySqlDialect();
    const query = dialect.sqlToQuery(update.where as never);
    expect(query.params).toEqual(
      expect.arrayContaining([
        project.id,
        project.userId,
        project.revision,
        project.currentBuildId,
        project.currentKnowledgeSnapshotId,
        project.globalLiveDeploymentId,
        project.mainlandLiveDeploymentId,
        project.canonicalHostname,
      ]),
    );
    const operationQuery = dialect.sqlToQuery(f.reads[0].where as never);
    expect(operationQuery.params).toEqual(
      expect.arrayContaining([project.id, project.userId]),
    );
  });

  it("rejects a changed project before replacing its conversation or build state", async () => {
    const f = fixture([], 0);
    await expect(
      restartSiteOpsProject(f.tx, { project, requestId: "restart-1", now }),
    ).rejects.toMatchObject({ code: "IN_FLIGHT_OPERATION" });
    expect(f.writes.map((w) => w.table)).toEqual([siteProjects]);
  });
});
