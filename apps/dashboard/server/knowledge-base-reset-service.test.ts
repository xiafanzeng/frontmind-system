import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { beforeEach, describe, expect, it, vi } from "vitest";

const dependencies = vi.hoisted(() => ({
  getDb: vi.fn(),
  getServicePortal: vi.fn(),
}));

vi.mock("./db", () => ({ getDb: dependencies.getDb }));
vi.mock("./service-entitlement", () => ({
  getServicePortal: dependencies.getServicePortal,
}));

import {
  deliveryProjectAssignments,
  knowledgeBaseBuilds,
  knowledgeBaseResetCleanupJobs,
  knowledgeBaseResetRequests,
  knowledgeBaseResetStates,
  knowledgeBaseSnapshots,
  knowledgeImportReceipts,
} from "../drizzle/schema";
import {
  getKnowledgeResetStatus,
  knowledgeSnapshotCleanupStorageKeys,
  prepareKnowledgeResetCleanupResource,
  processKnowledgeResetCleanupJobs,
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
  dependencies.getServicePortal.mockReset().mockResolvedValue({
    service: { planCode: "advanced" },
  });
});

describe("knowledge-base reset status", () => {
  it("binds reset submissions through the authoritative current quota scope", () => {
    const source = readFileSync(
      resolve(process.cwd(), "server/knowledge-base-reset-service.ts"),
      "utf8",
    );
    const submitSource = source.slice(
      source.indexOf("export async function submitKnowledgeReset"),
      source.indexOf("export async function approveKnowledgeReset"),
    );
    expect(submitSource).toContain("resolveCurrentServiceQuotaScope");
    expect(submitSource).not.toContain(
      "orderBy(desc(serviceQuotaPeriods.endsAt))",
    );
  });

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

  it("allows a reset request while a build is still in progress", async () => {
    dependencies.getDb.mockResolvedValue(
      resetStatusDb({ withPartialBuild: true }),
    );

    await expect(getKnowledgeResetStatus(42)).resolves.toMatchObject({
      hasKnowledge: true,
      locked: false,
      canRequest: true,
      unavailableReason: null,
    });
  });

  it("keeps the action unavailable before any resettable build exists", async () => {
    dependencies.getDb.mockResolvedValue(
      resetStatusDb({ withPartialBuild: false }),
    );

    await expect(getKnowledgeResetStatus(42)).resolves.toMatchObject({
      hasKnowledge: false,
      canRequest: false,
      unavailableReason: "当前没有可重置的知识库记录",
    });
  });
});
