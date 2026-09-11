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
const mocks = vi.hoisted(() => ({ db: vi.fn(), physical: vi.fn() }));
vi.mock("./db", () => ({ getDb: mocks.db }));
vi.mock("./knowledge-base-materialized-assets", () => ({
  readValidatedActiveKnowledgeBaseWorkingSet: mocks.physical,
}));
vi.mock("./knowledge-base-materialized-quality", () => ({
  isMaterializedBuildPublishable: () => true,
}));
import { acceptKnowledgeBaseInitialDraft } from "./knowledge-workbench-service";
import {
  knowledgeWorkbenchStage,
  knowledgeWorkbenchEditingAllowed,
} from "./knowledge-workbench-stage";
const sha = (value: string) => createHash("sha256").update(value).digest("hex");
const input = {
  conversationId: "conversation",
  clientRequestId: "accept-1",
  expectedGeneration: 1,
  expectedRevision: 4,
  expectedStateEpoch: 8,
  expectedContentVersion: 2,
  expectedResetRevision: 3,
};
function fixture() {
  const build: any = {
    id: "build",
    userId: 7,
    enterpriseProjectId: null,
    conversationId: "conversation",
    generation: 1,
    revision: 4,
    stateEpoch: 8,
    contentVersion: 2,
    activeWorkingSetId: "ws",
    totalNodeCount: 2,
    status: "confirming",
    activeTurnId: null,
    currentLeafId: "leaf1",
    currentPresentationKey: "presentation-1",
    confirmedCount: 0,
    directPrefilledCount: 0,
    needsVerificationCount: 0,
    publishedSnapshotId: null,
  };
  const nodes: any[] = [1, 2].map((n) => ({
    id: `node${n}`,
    buildId: build.id,
    leafId: `leaf${n}`,
    branchId: "branch",
    title: `节点${n}`,
    contentVersion: 2,
    contentMarkdown: `# 节点${n}\n\n正文${n}`,
    contentSha256: sha(`# 节点${n}\n\n正文${n}`),
    status: "pending",
  }));
  const start: any = {
    id: "start",
    userId: 7,
    enterpriseProjectId: null,
    buildId: build.id,
    buildGeneration: 1,
    operationType: "start",
    metadata: {
      knowledgeWorkbench: {
        schemaVersion: 1,
        originalAttachmentManifest: {
          schemaVersion: 1,
          status: "complete",
          expectedCount: 0,
          entries: [],
        },
      },
    },
  };
  const ws: any = {
    id: "ws",
    buildId: "build",
    generation: 1,
    contentVersion: 2,
    status: "active",
    packageSha256: sha("zip"),
    manifest: {
      buildId: "build",
      generation: 1,
      contentVersion: 2,
      leaves: nodes.map((node) => ({ ...node })),
      assets: [],
    },
  };
  const reset = { userId: 7, enterpriseProjectId: null, revision: 3 };
  const rows = new Map<any, any[]>([
    [knowledgeBaseBuilds, [build]],
    [knowledgeBaseBuildNodes, nodes],
    [knowledgeBaseWorkingSets, [ws]],
    [conversationTurns, [start]],
    [knowledgeBaseResetStates, [reset]],
    [enterpriseProjectResetStates, [reset]],
  ]);
  const locks: any[] = [];
  const dialect = new MySqlDialect();
  function matching(table: any, condition: any) {
    const sql = dialect.sqlToQuery(condition),
      columns = getTableColumns(table);
    return rows.get(table)!.filter((row) => {
      let i = 0;
      return [
        ...sql.sql.matchAll(/`[^`]+`\.`([^`]+)`\s*(=\s*\?|is null)/g),
      ].every((part) => {
        const key = Object.entries(columns).find(
          ([, c]) => c.name === part[1],
        )![0];
        return part[2] === "is null"
          ? row[key] == null
          : row[key] === sql.params[i++];
      });
    });
  }
  const tx: any = {
    select: () => ({
      from: (table: any) => ({
        where: (condition: any) => {
          const q: any = {
            limit: () => q,
            orderBy: () => q,
            for: () => {
              locks.push(table);
              return q;
            },
            then: (resolve: any, reject: any) =>
              Promise.resolve(
                matching(table, condition).map((row) => ({ ...row })),
              ).then(resolve, reject),
          };
          return q;
        },
      }),
    }),
    update: (table: any) => ({
      set: (patch: any) => ({
        where: async (condition: any) => {
          for (const row of matching(table, condition))
            Object.assign(row, patch);
        },
      }),
    }),
  };
  let queue = Promise.resolve();
  const db = {
    transaction: (run: any) => {
      const result = queue.then(async () => {
        const before = [...rows].map(
          ([table, values]) => [table, structuredClone(values)] as const,
        );
        try {
          return await run(tx);
        } catch (error) {
          for (const [table, values] of before) {
            const originals = rows.get(table)!;
            for (let i = 0; i < values.length; i++) {
              Object.keys(originals[i]).forEach(
                (key) => delete originals[i][key],
              );
              Object.assign(originals[i], values[i]);
            }
          }
          throw error;
        }
      });
      queue = result.catch(() => {});
      return result;
    },
  };
  mocks.db.mockResolvedValue(db);
  mocks.physical.mockResolvedValue({
    row: ws,
    validated: { manifest: ws.manifest },
  });
  return { build, nodes, start, ws, reset, locks, tx };
}
beforeEach(() => vi.clearAllMocks());
describe("knowledge workbench initial acceptance", () => {
  it("unlocks the editing phase atomically without confirming nodes", async () => {
    const f = fixture();
    const result = await acceptKnowledgeBaseInitialDraft(7, input);
    expect(result.unchanged).toBe(false);
    expect(f.nodes.map((n) => n.status)).toEqual(["pending", "pending"]);
    expect(f.build).toMatchObject({
      status: "confirming",
      revision: 4,
      stateEpoch: 8,
      currentLeafId: "leaf1",
      currentPresentationKey: "presentation-1",
      publishedSnapshotId: null,
    });
    expect(
      f.start.metadata.knowledgeWorkbench.initialAcceptance.nodesSha256,
    ).toMatch(/^[a-f0-9]{64}$/);
    expect(f.locks.slice(0, 3)).toEqual([
      knowledgeBaseResetStates,
      knowledgeBaseBuilds,
      conversationTurns,
    ]);
    expect(await knowledgeWorkbenchEditingAllowed(f.tx, f.build)).toBe(true);
    expect(knowledgeWorkbenchStage(f.build, f.start).phase).toBe("editing");
  });
  it("finishes to ready_to_publish only when every node is already settled", async () => {
    const f = fixture();
    f.nodes[0].status = "confirmed";
    f.nodes[1].status = "direct_prefilled";
    const result = await acceptKnowledgeBaseInitialDraft(7, input);
    expect(result.unchanged).toBe(false);
    expect(f.build).toMatchObject({
      status: "ready_to_publish",
      currentLeafId: null,
      currentPresentationKey: null,
      confirmedCount: 1,
      directPrefilledCount: 1,
      needsVerificationCount: 0,
      revision: 5,
      stateEpoch: 9,
    });
    expect(f.build.contentCompletedAt).toBeInstanceOf(Date);
    expect(await knowledgeWorkbenchEditingAllowed(f.tx, f.build)).toBe(true);
  });
  it("coalesces concurrent acceptance and never confirms later edits again", async () => {
    const f = fixture();
    const results = await Promise.all([
      acceptKnowledgeBaseInitialDraft(7, input),
      acceptKnowledgeBaseInitialDraft(7, input),
    ]);
    expect(results.map((r) => r.unchanged)).toEqual([false, true]);
    f.nodes[0].status = "needs_verification";
    f.build.contentVersion = 3;
    const again = await acceptKnowledgeBaseInitialDraft(7, {
      ...input,
      clientRequestId: "another-click",
      expectedContentVersion: 3,
    });
    expect(again.unchanged).toBe(true);
    expect(f.nodes[0].status).toBe("needs_verification");
    expect(knowledgeWorkbenchStage(f.build, f.start).phase).toBe("editing");
  });
  it.each(["count", "hash", "version", "missing"])(
    "rejects inconsistent %s without partially confirming nodes",
    async (kind) => {
      const f = fixture();
      if (kind === "count") f.build.totalNodeCount = 3;
      if (kind === "hash") f.nodes[1].contentMarkdown = "changed";
      if (kind === "version") f.nodes[1].contentVersion = 1;
      if (kind === "missing") f.ws.manifest.leaves.pop();
      await expect(
        acceptKnowledgeBaseInitialDraft(7, input),
      ).rejects.toMatchObject({ code: "INVALID_BUILD_STATE" });
      expect(f.nodes.every((n) => n.status === "pending")).toBe(true);
      expect(
        f.start.metadata.knowledgeWorkbench.initialAcceptance,
      ).toBeUndefined();
    },
  );
  it("rejects stale reset, generation and owner coordinates", async () => {
    fixture();
    await expect(
      acceptKnowledgeBaseInitialDraft(7, {
        ...input,
        expectedResetRevision: 2,
      }),
    ).rejects.toMatchObject({ code: "STALE_COORDINATES" });
    await expect(
      acceptKnowledgeBaseInitialDraft(7, { ...input, expectedGeneration: 2 }),
    ).rejects.toMatchObject({ code: "STALE_COORDINATES" });
    await expect(
      acceptKnowledgeBaseInitialDraft(8, input),
    ).rejects.toBeInstanceOf(Error);
  });
  it("rolls back when the physical archive cannot be verified", async () => {
    const f = fixture();
    mocks.physical.mockRejectedValueOnce(new Error("corrupt archive"));
    await expect(acceptKnowledgeBaseInitialDraft(7, input)).rejects.toThrow(
      "corrupt archive",
    );
    expect(f.nodes.every((n) => n.status === "pending")).toBe(true);
    expect(f.build.revision).toBe(4);
  });
  it("requires a new acceptance for a new generation and never trusts leaf status", () => {
    const f = fixture();
    f.nodes.forEach((n) => (n.status = "confirmed"));
    expect(knowledgeWorkbenchStage(f.build, f.start).phase).toBe("initial");
    f.start.metadata.knowledgeWorkbench.initialAcceptance = {
      buildId: "build",
      generation: 1,
      requestHash: "hash",
    };
    expect(knowledgeWorkbenchStage(f.build, f.start).phase).toBe("editing");
    f.build.generation = 2;
    expect(knowledgeWorkbenchStage(f.build, f.start).phase).toBe("initial");
  });
});
