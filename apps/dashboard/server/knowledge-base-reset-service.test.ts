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
  knowledgeBaseResetRequests,
  knowledgeBaseResetStates,
  knowledgeBaseSnapshots,
  knowledgeImportReceipts,
} from "../drizzle/schema";
import {
  getKnowledgeResetStatus,
  knowledgeSnapshotCleanupStorageKeys,
  prepareKnowledgeResetCleanupResource,
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
            id: "build-1",
            conversationId: "conversation-1",
            upstreamTaskId: "task-1",
            logoStorageKey: "knowledge-builds/42/build-1/logo.bin",
            packageStorageKey: "knowledge-builds/42/build-1/package.zip",
          },
        ],
      ),
    ).toEqual([
      "knowledge-assets/snapshot/logo.webp",
      "knowledge-archives/42/00000000-0000-4000-8000-000000000123.zip",
      "knowledge-builds/42/build-1/logo.bin",
      "knowledge-builds/42/build-1/package.zip",
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
