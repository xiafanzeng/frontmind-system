import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";

import { beforeEach, describe, expect, it, vi } from "vitest";

const dependencies = vi.hoisted(() => ({
  getDb: vi.fn(),
  getServicePortal: vi.fn(),
  getCredential: vi.fn(),
  stopTask: vi.fn(),
  deleteFile: vi.fn(),
}));

vi.mock("./db", () => ({ getDb: dependencies.getDb }));
vi.mock("./service-entitlement", () => ({
  getServicePortal: dependencies.getServicePortal,
}));

vi.mock("./auth-service", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./auth-service")>();
  return {
    ...actual,
    getCredentialForUpstreamResource: dependencies.getCredential,
  };
});
vi.mock("./credential-agent-client", () => ({
  createCredentialAgentClient: () => ({
    stopTask: dependencies.stopTask,
    deleteFile: dependencies.deleteFile,
  }),
}));

import {
  deliveryProjectAssignments,
  knowledgeBaseBuilds,
  knowledgeBaseConversationRetentionTombstones,
  workspaceAuditEvents,
  knowledgeBaseResetCleanupJobs,
  knowledgeBaseResetRequests,
  knowledgeBaseResetStates,
  knowledgeBaseSnapshots,
  knowledgeImportReceipts,
  localAssets,
  siteBuilds,
  siteProjects,
  socialPackages,
  visualCandidatePools,
  workspaceQuestions,
} from "../drizzle/schema";
import {
  getKnowledgeResetStatus,
  resetKnowledgeBase,
  knowledgeSnapshotCleanupStorageKeys,
  prepareKnowledgeResetCleanupResource,
  processKnowledgeResetCleanupJobs,
  removeKnowledgeResetLocalAssetIfOrphaned,
  shouldDeleteKnowledgeResetUpstreamResource,
} from "./knowledge-base-reset-service";

function query(rows: Array<Record<string, unknown>>) {
  const chain = {
    innerJoin() {
      return chain;
    },
    where() {
      return chain;
    },
    orderBy() {
      return chain;
    },
    limit(limit: number) {
      return query(rows.slice(0, limit));
    },
    for() {
      return Promise.resolve(rows);
    },
    then(
      resolve: (value: Array<Record<string, unknown>>) => unknown,
      reject?: (reason: unknown) => unknown,
    ) {
      return Promise.resolve(rows).then(resolve, reject);
    },
  };
  return chain;
}

function resetStatusDb(options: { withPartialBuild: boolean }) {
  return {
    select() {
      return {
        from(table: unknown) {
          if (table === knowledgeBaseBuilds) {
            return query(
              options.withPartialBuild
                ? [
                    {
                      id: "build-in-progress",
                      conversationId: "conversation-in-progress",
                      upstreamTaskId: "task-in-progress",
                    },
                  ]
                : [],
            );
          }
          if (table === knowledgeBaseSnapshots) return query([]);
          if (table === knowledgeImportReceipts) return query([]);
          if (table === knowledgeBaseResetRequests) return query([]);
          if (table === knowledgeBaseResetStates) return query([]);
          if (table === deliveryProjectAssignments) {
            return query([
              {
                projectAssignmentId: "assignment-1",
                memberId: 91,
                memberName: "AI 运维工程师",
                memberUsername: "ai-ops",
              },
            ]);
          }
          return query([]);
        },
      };
    },
  };
}

beforeEach(() => {
  dependencies.getDb.mockReset();
  dependencies.getCredential
    .mockReset()
    .mockResolvedValue({ id: "credential", userId: 42 });
  dependencies.stopTask.mockReset().mockResolvedValue({});
  dependencies.deleteFile.mockReset().mockResolvedValue({});
  dependencies.getServicePortal.mockReset().mockResolvedValue({
    service: { planCode: "advanced" },
  });
});

describe("knowledge-base reset status", () => {
  it("retains task ownership evidence while allowing file cleanup", () => {
    expect(shouldDeleteKnowledgeResetUpstreamResource("task")).toBe(false);
    expect(shouldDeleteKnowledgeResetUpstreamResource("file")).toBe(true);
  });

  it("queues both rendered assets and the immutable snapshot ZIP for cleanup", () => {
    expect(
      knowledgeSnapshotCleanupStorageKeys(
        42,
        [
          {
            id: "00000000-0000-4000-8000-000000000123",
            sourceConversationId: null,
            assets: [{ key: "knowledge-assets/snapshot/logo.webp" }],
          },
        ],
        [
          {
            id: "10000000-0000-4000-8000-000000000001",
            generation: 2,
            conversationId: "conversation-1",
            upstreamTaskId: "task-1",
            logoStorageKey:
              "knowledge-builds/42/10000000-0000-4000-8000-000000000001/generation-2/official-logo.bin",
            packageStorageKey:
              "knowledge-builds/42/10000000-0000-4000-8000-000000000001/generation-2/knowledge-base.zip",
          },
        ],
      ),
    ).toEqual([
      "knowledge-assets/snapshot/logo.webp",
      "knowledge-archives/42/00000000-0000-4000-8000-000000000123.zip",
      "knowledge-builds/42/10000000-0000-4000-8000-000000000001/generation-2/official-logo.bin",
      "knowledge-builds/42/10000000-0000-4000-8000-000000000001/generation-2/knowledge-base.zip",
      "knowledge-builds/42/10000000-0000-4000-8000-000000000001/generation-2/upload-evidence",
    ]);
  });

  it("preserves long local asset keys behind a fixed-width queue identity", () => {
    const localAssetKey = `knowledge-builds/42/${"a".repeat(320)}/official-logo.bin`;

    expect(
      prepareKnowledgeResetCleanupResource({
        kind: "local_asset",
        upstreamId: localAssetKey,
        apiCredentialId: null,
      }),
    ).toEqual({
      kind: "local_asset",
      upstreamId: expect.stringMatching(/^[a-f0-9]{64}$/u),
      apiCredentialId: null,
      localAssetKey,
    });
  });

  it("retains an evidence cleanup job for retry while its build is active", async () => {
    const updates: Array<Record<string, unknown>> = [];
    const jobsQuery = {
      where() {
        return jobsQuery;
      },
      orderBy() {
        return jobsQuery;
      },
      async limit() {
        return [
          {
            id: "cleanup-job-1",
            userId: 7,
            kind: "local_asset",
            localAssetKey:
              "knowledge-builds/7/10000000-0000-4000-8000-000000000001/generation-2/upload-evidence",
            upstreamId: "a".repeat(64),
          },
        ];
      },
    };
    const activeBuildQuery = {
      from() {
        return activeBuildQuery;
      },
      where() {
        return activeBuildQuery;
      },
      limit() {
        return activeBuildQuery;
      },
      async for() {
        return [{ id: "10000000-0000-4000-8000-000000000001" }];
      },
    };
    dependencies.getDb.mockResolvedValue({
      select() {
        return {
          from(table: unknown) {
            expect(table).toBe(knowledgeBaseResetCleanupJobs);
            return jobsQuery;
          },
        };
      },
      async transaction(callback: (tx: unknown) => Promise<unknown>) {
        return callback({ select: () => activeBuildQuery });
      },
      update(table: unknown) {
        expect(table).toBe(knowledgeBaseResetCleanupJobs);
        return {
          set(value: Record<string, unknown>) {
            updates.push(value);
            return { where: async () => undefined };
          },
        };
      },
    });

    await expect(processKnowledgeResetCleanupJobs()).resolves.toEqual({
      processed: 1,
    });
    expect(updates).toHaveLength(1);
    expect(updates[0]).toMatchObject({
      status: "failed",
      lastError: "活跃知识库构建仍引用上传证据目录",
    });
  });

  it("allows a direct reset without an engineer while a build is still in progress", async () => {
    dependencies.getDb.mockResolvedValue(
      resetStatusDb({ withPartialBuild: true }),
    );

    await expect(getKnowledgeResetStatus(42)).resolves.toMatchObject({
      hasKnowledge: true,
      canReset: true,
      unavailableReason: null,
    });
  });

  it("keeps the action unavailable before any resettable build exists", async () => {
    dependencies.getDb.mockResolvedValue(
      resetStatusDb({ withPartialBuild: false }),
    );

    await expect(getKnowledgeResetStatus(42)).resolves.toMatchObject({
      hasKnowledge: false,
      canReset: false,
      unavailableReason: "当前没有可重置的知识库记录",
    });
  });
});

describe("direct knowledge reset", () => {
  function harness(
    options: {
      revision?: number;
      prior?: any;
      snapshots?: any[];
      referenceTable?: unknown;
    } = {},
  ) {
    const writes: Array<{ table: unknown; value: any }> = [];
    const deletes: unknown[] = [];
    const database: any = {
      select() {
        return {
          from(table: unknown) {
            if (table === knowledgeBaseResetStates)
              return query([{ revision: options.revision ?? 2 }]);
            if (table === workspaceAuditEvents)
              return query(options.prior ? [{ metadata: options.prior }] : []);
            if (table === knowledgeBaseSnapshots)
              return query(options.snapshots ?? []);
            if (table === options.referenceTable)
              return query(
                (options.snapshots ?? []).map((snapshot) => ({
                  snapshotId: snapshot.id,
                })),
              );
            if (table === knowledgeBaseBuilds)
              return query([
                {
                  id: "build-1",
                  generation: 1,
                  conversationId: "conversation-1",
                  upstreamTaskId: null,
                  logoStorageKey: null,
                  packageStorageKey: null,
                },
              ]);
            return query([]);
          },
        };
      },
      insert(table: unknown) {
        return {
          values(value: any) {
            writes.push({ table, value });
            return {
              onDuplicateKeyUpdate: async () => undefined,
              then(resolve: any) {
                return Promise.resolve(undefined).then(resolve);
              },
            };
          },
        };
      },
      update(table: unknown) {
        return {
          set(value: any) {
            return {
              where: async () => {
                writes.push({ table, value });
                return [{ affectedRows: 1 }];
              },
            };
          },
        };
      },
      delete(table: unknown) {
        return {
          where: async () => {
            deletes.push(table);
            return [{ affectedRows: 1 }];
          },
        };
      },
      transaction(callback: any) {
        return callback(database);
      },
    };
    dependencies.getDb.mockResolvedValue(database);
    return { writes, deletes };
  }
  const actor = { id: 42, username: "customer", role: "user" } as any;
  it("clears owned content and advances the revision without tickets or an engineer", async () => {
    const h = harness();
    await expect(
      resetKnowledgeBase({ actor, expectedRevision: 2 }),
    ).resolves.toMatchObject({ revision: 3, cleanup: { builds: 1 } });
    expect(h.deletes).toContain(knowledgeBaseBuilds);
    const tombstone = h.writes.find(
      (row) => row.table === knowledgeBaseConversationRetentionTombstones,
    )?.value[0];
    expect(tombstone).toMatchObject({
      userId: 42,
      publicConversationId: "conversation-1",
    });
    expect(tombstone.resetAt).toBeInstanceOf(Date);
    expect(tombstone).not.toHaveProperty("resetRequestId");
    expect(
      h.writes.some((row) => row.table === knowledgeBaseResetRequests),
    ).toBe(false);
  });
  it.each([
    ["website project", siteProjects],
    ["website build", siteBuilds],
    ["visual candidate pool", visualCandidatePools],
    ["social package", socialPackages],
    ["historical question", workspaceQuestions],
  ])(
    "archives a snapshot referenced by a %s and preserves its files",
    async (_label, referenceTable) => {
      const snapshot = {
        id: "00000000-0000-4000-8000-000000000123",
        sourceConversationId: "conversation-1",
        status: "active",
        assets: [{ key: "knowledge-assets/retained/logo.webp" }],
      };
      const h = harness({ snapshots: [snapshot], referenceTable });
      await expect(
        resetKnowledgeBase({ actor, expectedRevision: 2 }),
      ).resolves.toMatchObject({ revision: 3, cleanup: { snapshots: 1 } });
      expect(h.deletes).not.toContain(knowledgeBaseSnapshots);
      expect(
        h.writes.find((row) => row.table === knowledgeBaseSnapshots)?.value,
      ).toEqual({ status: "archived" });
      const cleanup = h.writes
        .filter((row) => row.table === knowledgeBaseResetCleanupJobs)
        .flatMap((row) => row.value);
      expect(cleanup.map((row) => row.localAssetKey)).not.toContain(
        snapshot.assets[0].key,
      );
      expect(cleanup.map((row) => row.localAssetKey)).not.toContain(
        `knowledge-archives/42/${snapshot.id}.zip`,
      );
      expect(h.deletes).toContain(knowledgeBaseBuilds);
    },
  );
  it("deletes an unreferenced snapshot and queues its archive", async () => {
    const snapshot = {
      id: "00000000-0000-4000-8000-000000000123",
      sourceConversationId: "conversation-1",
      status: "active",
      assets: [],
    };
    const h = harness({ snapshots: [snapshot] });
    await resetKnowledgeBase({ actor, expectedRevision: 2 });
    expect(h.deletes).toContain(knowledgeBaseSnapshots);
    const cleanup = h.writes
      .filter((row) => row.table === knowledgeBaseResetCleanupJobs)
      .flatMap((row) => row.value);
    expect(cleanup.map((row) => row.localAssetKey)).toContain(
      `knowledge-archives/42/${snapshot.id}.zip`,
    );
  });
  it("does not offer reset for archived history alone", async () => {
    dependencies.getDb.mockResolvedValue({
      select: () => ({
        from: (table: unknown) =>
          query(
            table === knowledgeBaseSnapshots
              ? [{ id: "retained", status: "archived", assets: [] }]
              : [],
          ),
      }),
    });
    await expect(getKnowledgeResetStatus(42)).resolves.toMatchObject({
      hasKnowledge: false,
      canReset: false,
    });
  });
  it("rejects a stale reset revision before deleting any current content", async () => {
    const h = harness({ revision: 3 });
    await expect(
      resetKnowledgeBase({ actor, expectedRevision: 2 }),
    ).rejects.toThrow("知识库已更新");
    expect(h.deletes).toEqual([]);
  });
  it("returns an earlier reset result without clearing content created afterwards", async () => {
    const prior = {
      revision: 3,
      cleanup: {
        builds: 1,
        snapshots: 0,
        conversations: 0,
        attachments: 0,
        importReceipts: 0,
      },
    };
    const h = harness({ revision: 4, prior });
    await expect(
      resetKnowledgeBase({ actor, expectedRevision: 2 }),
    ).resolves.toEqual(prior);
    expect(h.deletes).toEqual([]);
  });
  it("rejects noncustomer actors before accessing data", async () => {
    await expect(
      resetKnowledgeBase({
        actor: { ...actor, role: "admin" },
        expectedRevision: 2,
      }),
    ).rejects.toThrow("只有客户");
    expect(dependencies.getDb).not.toHaveBeenCalled();
  });
});

it("stops a reset task through the bound provider while retaining its ownership record", async () => {
  const deleted: unknown[] = [];
  const db: any = {
    select() {
      return {
        from() {
          return query([
            {
              id: "cleanup-1",
              userId: 42,
              kind: "task",
              upstreamId: "session-1",
            },
          ]);
        },
      };
    },
    delete(table: unknown) {
      return {
        where: async () => {
          deleted.push(table);
        },
      };
    },
    transaction(fn: any) {
      return fn(db);
    },
  };
  dependencies.getDb.mockResolvedValue(db);
  await processKnowledgeResetCleanupJobs();
  expect(dependencies.getCredential).toHaveBeenCalledWith(
    42,
    "task",
    "session-1",
  );
  expect(dependencies.stopTask).toHaveBeenCalledWith("session-1");
  expect(dependencies.deleteFile).not.toHaveBeenCalled();
  expect(deleted).toEqual([knowledgeBaseResetCleanupJobs]);
});

describe("reset local file reference protection", () => {
  function fileDb(referenceTable?: unknown) {
    const db: any = {
      select: () => ({
        from: (table: unknown) =>
          query(table === referenceTable ? [{ id: "retained-reference" }] : []),
      }),
      transaction: (callback: any) => callback(db),
    };
    return db;
  }
  it.each([
    ["archived snapshot", knowledgeBaseSnapshots],
    ["other build", knowledgeBaseBuilds],
    ["registered local asset", localAssets],
  ])(
    "keeps a file referenced by a %s at cleanup time",
    async (_label, referenceTable) => {
      const assetRoot = await mkdtemp(
        resolve(tmpdir(), "frontmind-reset-files-"),
      );
      try {
        await writeFile(resolve(assetRoot, "logo.bin"), "retained bytes");
        await expect(
          removeKnowledgeResetLocalAssetIfOrphaned({
            storageKey: "logo.bin",
            assetRoot,
            db: fileDb(referenceTable),
          }),
        ).resolves.toBe("referenced");
        expect(await readFile(resolve(assetRoot, "logo.bin"), "utf8")).toBe(
          "retained bytes",
        );
      } finally {
        await rm(assetRoot, { recursive: true, force: true });
      }
    },
  );
  it("deletes only an orphan and tolerates an already removed file", async () => {
    const assetRoot = await mkdtemp(
      resolve(tmpdir(), "frontmind-reset-files-"),
    );
    try {
      await mkdir(resolve(assetRoot, "knowledge-assets"));
      const storageKey = "knowledge-assets/orphan.bin";
      await writeFile(resolve(assetRoot, storageKey), "orphan bytes");
      const input = { storageKey, assetRoot, db: fileDb() };
      await expect(
        removeKnowledgeResetLocalAssetIfOrphaned(input),
      ).resolves.toBe("removed");
      await expect(
        readFile(resolve(assetRoot, storageKey)),
      ).rejects.toMatchObject({ code: "ENOENT" });
      await expect(
        removeKnowledgeResetLocalAssetIfOrphaned(input),
      ).resolves.toBe("removed");
      await expect(
        removeKnowledgeResetLocalAssetIfOrphaned({
          ...input,
          storageKey: "../outside",
        }),
      ).rejects.toThrow("知识库本地资源路径无效");
    } finally {
      await rm(assetRoot, { recursive: true, force: true });
    }
  });
});
