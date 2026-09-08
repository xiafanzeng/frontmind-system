import { createHash } from "node:crypto";
import { getTableColumns } from "drizzle-orm";
import { MySqlDialect } from "drizzle-orm/mysql-core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  conversationTurns,
  knowledgeBaseBuilds,
  knowledgeBaseBuildNodes,
  knowledgeBaseWorkingSets,
  knowledgeBaseResetStates,
  enterpriseProjectResetStates,
} from "../drizzle/schema";
import { KNOWLEDGE_BASE_MATERIALIZED_V5_SKILL_CONTENT_HASH } from "./knowledge-base-tree-policy-rollout";
import { runWithEnterpriseProjectScope } from "./enterprise-project-scope";

const mocks = vi.hoisted(() => ({
  db: vi.fn(),
  select: vi.fn(),
  reserve: vi.fn(),
  dispatch: vi.fn(),
  publicResource: vi.fn(),
}));
vi.mock("./db", () => ({ getDb: mocks.db }));
vi.mock("./knowledge-base-progress-service", () => ({
  knowledgeBaseObservationConversationStorageId: (userId: number, id: string) =>
    `u${userId}:${id}`,
}));
vi.mock("./knowledge-base-materialized-service", async (actual) => ({
  ...(await actual<typeof import("./knowledge-base-materialized-service")>()),
  selectMaterializedKnowledgeBaseNode: mocks.select,
}));
vi.mock("./knowledge-base-turn-service", async (actual) => ({
  ...(await actual<typeof import("./knowledge-base-turn-service")>()),
  reserveKnowledgeBaseTurnInTransaction: mocks.reserve,
}));
vi.mock("./knowledge-node-manual-edit-service", () => ({
  dispatchManualKnowledgeNodeEdit: mocks.dispatch,
}));
vi.mock("./knowledge-base-public-resource", async (actual) => ({
  ...(await actual<typeof import("./knowledge-base-public-resource")>()),
  knowledgeBasePublicResource: mocks.publicResource,
}));

import {
  getKnowledgeNodeDetails,
  searchKnowledgeNodes,
  saveKnowledgeNodeContent,
  knowledgeNodeSaveSchema,
} from "./knowledge-node-workspace-service";
import { hasKnowledgeNodeEditPatchAuthority } from "./knowledge-base-materialized-service";

const sha = (value: string) => createHash("sha256").update(value).digest("hex");
const buildId = "11111111-1111-4111-8111-111111111111";
const workingSetId = "22222222-2222-4222-8222-222222222222";
const ids = Array.from({ length: 30 }, (_, index) => `leaf-${index + 1}`);
const dimensions = [
  "enterprise_identity",
  "team_and_organization",
  "products_and_services",
  "capabilities_and_delivery",
  "industries_scenarios_and_cases",
  "differentiation_and_evidence",
  "cooperation_delivery_and_support",
];
const originalBody = "# 节点一\n\n原始内容";
const query = {
  conversationId: "conversation",
  leafId: ids[0],
  expectedGeneration: 1,
  expectedContentVersion: 1,
};
const request = {
  ...query,
  clientRequestId: "save-one",
  expectedRevision: 4,
  expectedStateEpoch: 7,
  expectedResetRevision: 2,
  contentMarkdown: "# 节点一\n\n手动修改内容",
};

/** SQL-aware in-memory repository: reads honor the real owner/project/id
 * predicates, and its transaction queue exercises competing browser saves. */
function fixture() {
  const build: Record<string, any> = {
    id: buildId,
    userId: 7,
    enterpriseProjectId: null,
    conversationId: "conversation",
    executionMode: "materialized_bundle_v1",
    providerProtocol: "manus_v2",
    skillVersion: "5",
    skillContentHash: KNOWLEDGE_BASE_MATERIALIZED_V5_SKILL_CONTENT_HASH,
    generation: 1,
    revision: 4,
    stateEpoch: 7,
    contentVersion: 1,
    activeWorkingSetId: workingSetId,
    status: "published",
    currentLeafId: null,
    activeTurnId: null,
    awaitingResponseSince: null,
    publishedSnapshotId: "published-snapshot",
    treePolicyVersion: 2,
    totalNodeCount: 30,
    initialResearchCoverage: {
      officialPages: {
        discovered: 12,
        attempted: 12,
        succeeded: 12,
        failed: 0,
      },
      publicQueries: 6,
      officialDocuments: 0,
      uploadsRead: 0,
      sourceCount: 12,
      productFamilies: [{ id: "product", name: "主要产品", leafIds: ids }],
      dimensions: dimensions.map((id) => ({
        id,
        status: "covered",
        leafIds: [ids[0]],
      })),
      stopReason: "coverage_complete",
    },
    handoffProvenance: {
      materializedRecoveryContractVersion: 1,
      materializedCompletionContractVersion: 2,
      materializedQuality: {
        completeness: "complete",
        downstreamEligible: true,
        publishable: true,
      },
    },
  };
  const node = {
    id: "node",
    buildId,
    leafId: ids[0],
    title: "节点一",
    branchId: "identity",
    ordinal: 0,
    status: "confirmed",
    contentMarkdown: originalBody,
    contentSha256: sha(originalBody),
    contentVersion: 1,
  };
  const manifest = {
    buildId,
    generation: 1,
    contentVersion: 1,
    leaves: [
      {
        leafId: ids[0],
        title: node.title,
        branchId: node.branchId,
        contentSha256: node.contentSha256,
        assetIds: [] as string[],
      },
    ],
    assets: [] as any[],
  };
  const workingSet = {
    id: workingSetId,
    buildId,
    generation: 1,
    contentVersion: 1,
    status: "active",
    manifest,
  };
  const reset = { userId: 7, revision: 2, enterpriseProjectId: "project-a" };
  const turns: any[] = [];
  const tables = new Map<any, any[]>([
    [knowledgeBaseBuilds, [build]],
    [knowledgeBaseBuildNodes, [node]],
    [knowledgeBaseWorkingSets, [workingSet]],
    [knowledgeBaseResetStates, [reset]],
    [enterpriseProjectResetStates, [reset]],
    [conversationTurns, turns],
  ]);
  const dialect = new MySqlDialect();
  function matching(table: any, condition: any) {
    if (!condition) return tables.get(table) ?? [];
    const compiled = dialect.sqlToQuery(condition);
    const columns = getTableColumns(table);
    const expressions = [
      ...compiled.sql.matchAll(/`[^`]+`\.`([^`]+)`\s*(=\s*\?|is null)/g),
    ];
    return (tables.get(table) ?? []).filter((row) => {
      let paramIndex = 0;
      return expressions.every((expression) => {
        const field = Object.entries(columns).find(
          ([, column]) => column.name === expression[1],
        )?.[0];
        if (!field) throw new Error(`unknown SQL field ${expression[1]}`);
        return expression[2] === "is null"
          ? row[field] == null
          : row[field] === compiled.params[paramIndex++];
      });
    });
  }
  const tx: any = {
    select: () => ({
      from: (table: any) => ({
        where: (condition: any) => {
          const result: any = {
            limit: () => result,
            for: () => result,
            then: (resolve: any, reject: any) =>
              Promise.resolve(
                matching(table, condition).map((row) => ({ ...row })),
              ).then(resolve, reject),
          };
          return result;
        },
      }),
    }),
    insert: (table: any) => ({
      values: async (value: any) => {
        (tables.get(table) ?? []).push(value);
      },
    }),
  };
  let queue = Promise.resolve();
  const db = {
    transaction: (run: any) => {
      const result = queue.then(async () => {
        const before = new Map(
          [...tables].map(([table, rows]) => [table, structuredClone(rows)]),
        );
        try {
          return await run(tx);
        } catch (error) {
          for (const [table, snapshot] of before) {
            const rows = tables.get(table)!;
            snapshot.forEach((row, index) => {
              if (!rows[index]) rows[index] = row;
              else {
                Object.keys(rows[index]).forEach(
                  (key) => delete rows[index][key],
                );
                Object.assign(rows[index], row);
              }
            });
            rows.length = snapshot.length;
          }
          throw error;
        }
      });
      queue = result.then(
        () => undefined,
        () => undefined,
      );
      return result;
    },
  };
  mocks.db.mockResolvedValue(db);
  mocks.select.mockImplementation(async (input) => {
    build.currentLeafId = input.leafId;
    build.revision++;
    build.stateEpoch++;
    build.status = "confirming";
    build.currentPresentationKey = "selected-presentation";
    node.status = "needs_verification";
  });
  mocks.reserve.mockImplementation(async (input) => {
    const turn = {
      id: "manual-turn",
      userId: 7,
      conversationId: "u7:conversation",
      buildId,
      buildGeneration: 1,
      expectedLeafId: ids[0],
      operationKey: "operation",
      operationType: "revise",
      status: "queued",
      apiCredentialId: null,
      upstreamTaskId: null,
      attachmentFileIds: [],
      clientRequestId: input.clientRequestId,
      metadata: { recovery: input.recoveryMetadata },
    };
    turns.push(turn);
    build.activeTurnId = turn.id;
    return {
      state: "acquired",
      turn,
      leaseToken: "lease",
      leaseExpiresAt: new Date(Date.now() + 300000),
      upstreamIdempotencyKey: "local",
    };
  });
  mocks.dispatch.mockImplementation(async (claim) => {
    node.contentMarkdown = claim.recoveryMetadata.contentMarkdown;
    node.contentSha256 = sha(node.contentMarkdown);
    node.contentVersion++;
    build.contentVersion++;
    build.revision++;
    build.stateEpoch++;
    build.activeTurnId = null;
    turns.find((turn) => turn.id === claim.turn.id).status = "completed";
    return { reconciled: true };
  });
  return { build, node, workingSet, manifest, turns, reset };
}

beforeEach(() => {
  vi.clearAllMocks();
  delete process.env.KNOWLEDGE_BASE_WRITES_DISABLED;
});

describe("knowledge node workspace", () => {
  it("searches current node titles and正文 with immutable coordinates", async () => {
    fixture();
    const result = await searchKnowledgeNodes(7, {
      conversationId: "conversation",
      query: "原始内容",
      expectedGeneration: 1,
      expectedContentVersion: 1,
      expectedResetRevision: 2,
    });
    expect(result.matches).toEqual([
      expect.objectContaining({
        leafId: ids[0],
        matchFields: ["content"],
      }),
    ]);
    await expect(
      searchKnowledgeNodes(7, {
        conversationId: "conversation",
        query: "原始内容",
        expectedGeneration: 2,
        expectedContentVersion: 1,
      }),
    ).rejects.toMatchObject({ code: "STALE_COORDINATES" });
  });

  it("reads one materialized node without changing confirmation, selecting a node or dispatching", async () => {
    const store = fixture();
    const before = structuredClone(store);
    const result = await getKnowledgeNodeDetails(7, query);
    expect(result.node.contentMarkdown).toBe(originalBody);
    expect(result.capabilities.directEdit).toEqual({
      allowed: true,
      reason: null,
    });
    expect(result.coordinates).toMatchObject({
      resetRevision: 2,
      revision: 4,
      stateEpoch: 7,
    });
    expect(store).toEqual(before);
    expect(mocks.select).not.toHaveBeenCalled();
    expect(mocks.dispatch).not.toHaveBeenCalled();
  });

  it("rejects old versions, another owner's conversation and an out-of-project node", async () => {
    const store = fixture();
    await expect(
      getKnowledgeNodeDetails(7, { ...query, expectedContentVersion: 2 }),
    ).rejects.toMatchObject({ code: "STALE_COORDINATES" });
    await expect(getKnowledgeNodeDetails(8, query)).rejects.toMatchObject({
      code: "BUILD_NOT_FOUND",
    });
    store.build.enterpriseProjectId = "project-b";
    await expect(
      runWithEnterpriseProjectScope(
        {
          ownerUserId: 7,
          enterpriseProjectId: "project-a",
          isLegacyDefault: false,
        } as any,
        () => getKnowledgeNodeDetails(7, query),
      ),
    ).rejects.toMatchObject({ code: "BUILD_NOT_FOUND" });
  });

  it("keeps partial content readable with all mutations unavailable", async () => {
    const store = fixture();
    store.build.handoffProvenance.materializedQuality = {
      completeness: "partial",
      downstreamEligible: false,
      publishable: false,
    };
    const result = await getKnowledgeNodeDetails(7, query);
    expect(result.node.contentMarkdown).toBe(originalBody);
    expect(
      Object.values(result.capabilities).every(
        (capability) => !capability.allowed,
      ),
    ).toBe(true);
    await expect(saveKnowledgeNodeContent(7, request)).rejects.toMatchObject({
      code: "INVALID_BUILD_STATE",
    });
    expect(mocks.reserve).not.toHaveBeenCalled();
  });

  it("projects only opaque, node-bound images from manifest metadata", async () => {
    const store = fixture();
    store.manifest.leaves[0].assetIds.push("image");
    store.manifest.assets.push({
      assetId: "image",
      path: "private/image.png",
      sha256: "a".repeat(64),
      mimeType: "image/png",
      bytes: 10,
      documentIds: [ids[0]],
    });
    mocks.publicResource.mockReturnValue({
      id: "public",
      sameOriginUrl: "/api/knowledge-base/artifacts/resources/opaque",
      kind: "working_set_asset",
      mimeType: "image/png",
      caption: "知识库配图",
    });
    const result = await getKnowledgeNodeDetails(7, query);
    expect(result.resources).toHaveLength(1);
    expect(JSON.stringify(result)).not.toContain("private/image.png");
    store.manifest.assets[0].documentIds = ["other-node"];
    await expect(getKnowledgeNodeDetails(7, query)).rejects.toMatchObject({
      code: "INVALID_BUILD_STATE",
    });
  });

  it("saves through one credential-free local patch and keeps the published snapshot", async () => {
    const store = fixture();
    await expect(saveKnowledgeNodeContent(7, request)).resolves.toEqual({
      accepted: true,
      unchanged: false,
    });
    expect(mocks.select).toHaveBeenCalledTimes(1);
    expect(mocks.reserve.mock.calls[0][0]).toMatchObject({
      apiCredentialId: null,
      operationType: "revise",
      expectedRevision: 5,
      expectedPresentationKey: "selected-presentation",
      recoveryMetadata: {
        nodeEditMode: "manual_v1",
        contentMarkdown: request.contentMarkdown,
      },
    });
    expect(mocks.dispatch).toHaveBeenCalledTimes(1);
    expect(store.node.status).toBe("needs_verification");
    expect(store.build.publishedSnapshotId).toBe("published-snapshot");
    expect(store.build.status).toBe("confirming");
    expect(store.build.contentVersion).toBe(2);
  });

  it("replays an accepted body once and rejects reuse for a different body", async () => {
    fixture();
    await saveKnowledgeNodeContent(7, request);
    await expect(saveKnowledgeNodeContent(7, request)).resolves.toMatchObject({
      accepted: true,
    });
    expect(mocks.dispatch).toHaveBeenCalledTimes(1);
    await expect(
      saveKnowledgeNodeContent(7, {
        ...request,
        contentMarkdown: "改为别的内容",
      }),
    ).rejects.toMatchObject({ code: "IDEMPOTENCY_CONFLICT" });
  });

  it("records an unchanged save without reopening a confirmed or published node", async () => {
    const store = fixture();
    const before = structuredClone({ build: store.build, node: store.node });
    const input = { ...request, contentMarkdown: originalBody };
    await expect(saveKnowledgeNodeContent(7, input)).resolves.toEqual({
      accepted: true,
      unchanged: true,
    });
    await expect(saveKnowledgeNodeContent(7, input)).resolves.toEqual({
      accepted: true,
      unchanged: true,
    });
    expect({ build: store.build, node: store.node }).toEqual(before);
    expect(store.turns).toHaveLength(1);
    expect(mocks.select).not.toHaveBeenCalled();
    expect(mocks.reserve).not.toHaveBeenCalled();
    expect(mocks.dispatch).not.toHaveBeenCalled();
  });

  it("allows only one competing save at a frozen coordinate", async () => {
    fixture();
    const results = await Promise.allSettled([
      saveKnowledgeNodeContent(7, request),
      saveKnowledgeNodeContent(7, {
        ...request,
        clientRequestId: "competing",
        contentMarkdown: "另一份正文",
      }),
    ]);
    expect(
      results.filter((result) => result.status === "fulfilled"),
    ).toHaveLength(1);
    expect(
      results.filter((result) => result.status === "rejected"),
    ).toHaveLength(1);
    expect(mocks.dispatch).toHaveBeenCalledTimes(1);
  });

  it("rolls node selection back when its local turn cannot be reserved", async () => {
    const store = fixture();
    const before = structuredClone({ build: store.build, node: store.node });
    mocks.reserve.mockRejectedValue(new Error("reservation unavailable"));
    await expect(saveKnowledgeNodeContent(7, request)).rejects.toThrow(
      "reservation unavailable",
    );
    expect({ build: store.build, node: store.node }).toEqual(before);
    expect(store.turns).toEqual([]);
    expect(mocks.dispatch).not.toHaveBeenCalled();
  });

  it("rejects reset and state-epoch races without selecting the node", async () => {
    fixture();
    await expect(
      saveKnowledgeNodeContent(7, { ...request, expectedResetRevision: 1 }),
    ).rejects.toMatchObject({ code: "STALE_COORDINATES" });
    await expect(
      saveKnowledgeNodeContent(7, { ...request, expectedStateEpoch: 6 }),
    ).rejects.toMatchObject({ code: "STALE_COORDINATES" });
    expect(mocks.select).not.toHaveBeenCalled();
  });

  it("accepts manual patch authority only for the same null-provider frozen base", () => {
    const bytes = Buffer.from("patch");
    const metadata = {
      recovery: { nodeEditMode: "manual_v1" },
      applicationNodeEdit: {
        schemaVersion: 1,
        mode: "manual_v1",
        patchSha256: sha("patch"),
        providerTaskId: null,
        baseWorkingSetId: workingSetId,
        baseContentVersion: 1,
      },
    };
    expect(
      hasKnowledgeNodeEditPatchAuthority(
        metadata,
        bytes,
        null,
        workingSetId,
        1,
      ),
    ).toBe(true);
    expect(
      hasKnowledgeNodeEditPatchAuthority(
        metadata,
        Buffer.from("altered"),
        null,
        workingSetId,
        1,
      ),
    ).toBe(false);
    expect(
      hasKnowledgeNodeEditPatchAuthority(
        metadata,
        bytes,
        "provider-task",
        workingSetId,
        1,
      ),
    ).toBe(false);
    expect(
      hasKnowledgeNodeEditPatchAuthority(
        metadata,
        bytes,
        null,
        workingSetId,
        2,
      ),
    ).toBe(false);
  });

  it("rejects blank, oversized, secret-shaped and model override request fields", () => {
    expect(
      knowledgeNodeSaveSchema.safeParse({ ...request, contentMarkdown: "   " })
        .success,
    ).toBe(false);
    expect(
      knowledgeNodeSaveSchema.safeParse({
        ...request,
        contentMarkdown: "x".repeat(300001),
      }).success,
    ).toBe(false);
    expect(
      knowledgeNodeSaveSchema.safeParse({
        ...request,
        providerTaskId: "task",
        apiKey: "ignored",
      }).success,
    ).toBe(false);
  });
});
