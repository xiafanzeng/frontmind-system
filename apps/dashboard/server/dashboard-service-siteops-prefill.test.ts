import { beforeEach, describe, expect, it, vi } from "vitest";

import { knowledgeBaseSnapshots } from "../drizzle/schema";

const mocks = vi.hoisted(() => ({
  getDb: vi.fn(),
  snapshotRows: [] as any[],
}));

vi.mock("./db", () => ({ getDb: mocks.getDb }));

import { getLatestKnowledgeSnapshot } from "./dashboard-service";

function snapshot(overrides: Record<string, unknown> = {}) {
  return {
    id: "62000000-0000-4000-8000-000000000001",
    userId: 7,
    version: 1,
    sourceFileName: "knowledge.md",
    archiveHash: null,
    documents: [],
    documentCount: 0,
    imageCount: 0,
    characterCount: 0,
    totalBytes: 0,
    assets: [],
    status: "active",
    siteOpsKnowledgeInputEpochId: "61000000-0000-4000-8000-000000000001",
    createdAt: new Date("2026-08-30T00:00:00.000Z"),
    ...overrides,
  };
}

function database() {
  return {
    select: () => ({
      from: (table: unknown) => ({
        where: () => {
          const rows =
            table === knowledgeBaseSnapshots ? mocks.snapshotRows : [];
          return {
            limit: async () => rows,
            orderBy: () => ({ limit: async () => rows }),
          };
        },
      }),
    }),
  };
}

describe("knowledge-base active snapshot prefill", () => {
  beforeEach(() => {
    mocks.snapshotRows = [];
    mocks.getDb.mockReset().mockResolvedValue(database());
  });

  it("reuses the account active snapshot without consulting SiteOps lineage", async () => {
    mocks.snapshotRows = [snapshot()];

    await expect(getLatestKnowledgeSnapshot(7)).resolves.toMatchObject({
      id: "62000000-0000-4000-8000-000000000001",
      version: 1,
    });
  });

  it("returns no prefill when the account has no active snapshot", async () => {
    await expect(getLatestKnowledgeSnapshot(7)).resolves.toBeNull();
  });
});
