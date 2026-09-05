import { describe, expect, it, vi } from "vitest";

vi.mock("./db", () => ({ getDb: vi.fn() }));

import type { KnowledgeBaseBuild } from "../drizzle/schema";
import { getDb } from "./db";
import {
  finalizeKnowledgeBaseReadyPackageBackfill,
  knowledgeBaseActiveTurnRecoveryFacts,
  knowledgeBaseReadyArtifactRecoveryFacts,
  legacyKnowledgeBaseErrorCanBeCleared,
  legacyKnowledgeBaseOperationKey,
} from "./knowledge-base-state-machine-backfill";

function build(
  overrides: Partial<KnowledgeBaseBuild> = {},
): KnowledgeBaseBuild {
  return {
    id: "11111111-1111-4111-8111-111111111111",
    userId: 7,
    conversationId: "conversation-1",
    companyName: "FrontMind",
    companyWebsite: null,
    upstreamTaskId: "task-1",
    skillName: "socratic-kb-builder",
    skillVersion: "3",
    skillContentHash: null,
    status: "confirming",
    generation: 1,
    stateEpoch: 0,
    activeTurnId: null,
    lastAppliedOperationKey: null,
    currentPresentationKey: null,
    revision: 2,
    currentLeafId: "1.3",
    totalNodeCount: 8,
    confirmedCount: 2,
    directPrefilledCount: 0,
    needsVerificationCount: 0,
    lastReconciledHash: null,
    lastOutputLength: 0,
    lastOutputItemIds: [],
    lastTurnUserText: null,
    lastTurnAttachmentCount: 0,
    awaitingResponseSince: null,
    packageRevision: null,
    packageTaskId: null,
    packageOutputItemId: null,
    packageFileId: null,
    packageFilename: null,
    packageDescriptorHash: null,
    logoStorageKey: null,
    logoSha256: null,
    logoBytes: null,
    logoFilename: null,
    logoMimeType: null,
    packageStorageKey: null,
    packageArchiveSha256: null,
    packageSizeBytes: null,
    protocolErrorCode: null,
    protocolError: null,
    publishedSnapshotId: null,
    createdAt: new Date("2026-01-01T00:00:00.000Z"),
    updatedAt: new Date("2026-01-01T00:00:00.000Z"),
    completedAt: null,
    publishedAt: null,
    ...overrides,
  };
}

describe("knowledge-base v2 state-machine backfill", () => {
  it("applies the artifact backfill CAS once under concurrency and is idempotent on rerun", async () => {
    const row = {
      id: "11111111-1111-4111-8111-111111111111",
      generation: 1,
      skillVersion: "4",
      status: "ready_to_publish",
      stateEpoch: 7,
      packageStatus: "attention_required",
      logoStorageKey: null,
      logoSha256: null,
      logoBytes: null,
      packageStorageKey: null,
      packageArchiveSha256: null,
      packageSizeBytes: null,
      protocolErrorCode: null as string | null,
    };
    const eligibleRows = () =>
      row.status === "ready_to_publish" &&
      ["not_started", "attention_required"].includes(row.packageStatus) &&
      knowledgeBaseReadyArtifactRecoveryFacts(row).rebindRequired
        ? [row]
        : [];
    const db = {
      select: vi.fn(() => ({
        from: vi.fn(() => ({ where: vi.fn(async () => eligibleRows()) })),
      })),
      update: vi.fn(() => ({
        set: vi.fn((values: Record<string, unknown>) => ({
          where: vi.fn(async () => {
            if (!eligibleRows().length || row.stateEpoch !== 7) {
              return [{ affectedRows: 0 }];
            }
            Object.assign(row, values);
            return [{ affectedRows: 1 }];
          }),
        })),
      })),
    };
    vi.mocked(getDb).mockResolvedValue(db as never);

    const concurrent = await Promise.all([
      finalizeKnowledgeBaseReadyPackageBackfill({
        apply: true,
        confirmRebindRequired: true,
      }),
      finalizeKnowledgeBaseReadyPackageBackfill({
        apply: true,
        confirmRebindRequired: true,
      }),
    ]);
    expect(concurrent.map((result) => result.rebindRequired)).toEqual([1, 1]);
    expect(row).toMatchObject({
      status: "ready_to_publish",
      stateEpoch: 8,
      packageStatus: "preparing",
      protocolErrorCode: null,
    });

    await expect(
      finalizeKnowledgeBaseReadyPackageBackfill({
        apply: true,
        confirmRebindRequired: true,
      }),
    ).resolves.toMatchObject({ rebindRequired: 0, dispositions: [] });
    expect(row.stateEpoch).toBe(8);
  });

  it("rebuilds an incomplete ZIP without making optional Logo bytes a content gate", () => {
    const durable = {
      skillVersion: "4",
      packageStorageKey: "knowledge/package.zip",
      packageArchiveSha256: "a".repeat(64),
      packageSizeBytes: 4096,
      logoStorageKey: "knowledge/logo.bin",
      logoSha256: "b".repeat(64),
      logoBytes: 512,
    };
    expect(knowledgeBaseReadyArtifactRecoveryFacts(durable)).toEqual({
      packageDurable: true,
      logoDurable: true,
      rebindRequired: false,
    });

    for (const overrides of [
      { packageStorageKey: null },
      { packageArchiveSha256: null },
      { packageArchiveSha256: "invalid" },
      { packageSizeBytes: null },
      { packageSizeBytes: 0 },
    ]) {
      expect(
        knowledgeBaseReadyArtifactRecoveryFacts({
          ...durable,
          ...overrides,
        }),
      ).toMatchObject({ rebindRequired: true });
    }
    for (const overrides of [
      { logoStorageKey: null },
      { logoSha256: null },
      { logoSha256: "invalid" },
      { logoBytes: null },
      { logoBytes: 0 },
    ]) {
      expect(
        knowledgeBaseReadyArtifactRecoveryFacts({
          ...durable,
          ...overrides,
        }),
      ).toMatchObject({ rebindRequired: false });
    }
  });

  it("does not require a Logo identity for a durable v3 package", () => {
    expect(
      knowledgeBaseReadyArtifactRecoveryFacts({
        skillVersion: "3",
        packageStorageKey: "knowledge/package.zip",
        packageArchiveSha256: "a".repeat(64),
        packageSizeBytes: 4096,
        logoStorageKey: null,
        logoSha256: null,
        logoBytes: null,
      }),
    ).toEqual({
      packageDurable: true,
      logoDurable: false,
      rebindRequired: false,
    });
  });

  it("validates active-turn ownership before deciding whether recovery needs a Skill", () => {
    const base = {
      activeTurnId: "turn-1",
      buildId: "build-1",
      userId: 7,
      generation: 3,
    };
    const frozenTurn = {
      status: "running",
      userId: 7,
      buildId: "build-1",
      buildGeneration: 3,
      upstreamTaskId: "task-1",
      attachmentFileIds: [] as string[],
      metadata: {},
    };
    expect(
      knowledgeBaseActiveTurnRecoveryFacts({
        ...base,
        activeTurn: frozenTurn,
      }),
    ).toEqual({ valid: true, needsSkill: false });
    expect(
      knowledgeBaseActiveTurnRecoveryFacts({
        ...base,
        activeTurn: {
          ...frozenTurn,
          upstreamTaskId: null,
        },
      }),
    ).toEqual({ valid: true, needsSkill: true });
    expect(
      knowledgeBaseActiveTurnRecoveryFacts({
        ...base,
        activeTurn: {
          ...frozenTurn,
          buildId: "another-build",
        },
      }),
    ).toEqual({ valid: false, needsSkill: false });
    expect(
      knowledgeBaseActiveTurnRecoveryFacts({
        ...base,
        activeTurn: {
          ...frozenTurn,
          buildGeneration: 2,
        },
      }),
    ).toEqual({ valid: false, needsSkill: false });
    expect(
      knowledgeBaseActiveTurnRecoveryFacts({
        ...base,
        activeTurn: null,
      }),
    ).toEqual({ valid: false, needsSkill: true });
  });

  it("derives a stable legacy reservation slot without changing revision", () => {
    const source = build();
    expect(legacyKnowledgeBaseOperationKey(source)).toBe(
      legacyKnowledgeBaseOperationKey({ ...source }),
    );
    expect(legacyKnowledgeBaseOperationKey(source)).toMatch(
      /^kbv2_[a-f0-9]{64}$/u,
    );
    expect(source.revision).toBe(2);
  });

  it("clears only duplicate-result errors backed by a non-empty current node", () => {
    const source = build({
      status: "protocol_error",
      protocolError: "本轮内容已处理，无需重复更新",
    });
    expect(
      legacyKnowledgeBaseErrorCanBeCleared({
        build: source,
        currentNode: {
          leafId: "1.3",
          status: "current",
          contentMarkdown: "## 1.3 使命\n\n正式正文",
        },
      }),
    ).toBe(true);
    expect(
      legacyKnowledgeBaseErrorCanBeCleared({
        build: source,
        currentNode: {
          leafId: "1.3",
          status: "current",
          contentMarkdown: "  ",
        },
      }),
    ).toBe(false);
  });

  it("retains unrelated protocol errors and mismatched nodes", () => {
    const source = build({
      status: "protocol_error",
      protocolError: "知识树信息尚不完整",
    });
    expect(
      legacyKnowledgeBaseErrorCanBeCleared({
        build: source,
        currentNode: {
          leafId: "1.3",
          status: "current",
          contentMarkdown: "正文",
        },
      }),
    ).toBe(false);
    expect(
      legacyKnowledgeBaseErrorCanBeCleared({
        build: { ...source, protocolError: "STALE_REVISION" },
        currentNode: {
          leafId: "1.2",
          status: "current",
          contentMarkdown: "正文",
        },
      }),
    ).toBe(false);
  });
});
