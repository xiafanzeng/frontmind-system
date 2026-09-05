import { describe, expect, it } from "vitest";

import { isAuthenticatedAdvancedKnowledgePublication } from "./authenticated-knowledge-service";

const CONTRACT_START = new Date("2026-07-01T00:00:00.000Z");
const PUBLISHED_AT = new Date("2026-07-02T00:00:00.000Z");
const ARCHIVE_HASH = "a".repeat(64);
const DESCRIPTOR_HASH = "d".repeat(64);

function publication(
  overrides: {
    snapshot?: Record<string, unknown>;
    build?: Record<string, unknown>;
  } = {},
) {
  return {
    snapshot: {
      id: "snapshot-1",
      userId: 7,
      sourceBuildId: "build-1",
      sourceBuildRevision: 40,
      sourceTaskId: "task-1",
      sourceArtifactHash: ARCHIVE_HASH,
      archiveHash: ARCHIVE_HASH,
      createdAt: PUBLISHED_AT,
      ...overrides.snapshot,
    },
    build: {
      id: "build-1",
      userId: 7,
      status: "published" as const,
      revision: 40,
      currentLeafId: null,
      totalNodeCount: 40,
      confirmedCount: 30,
      directPrefilledCount: 10,
      needsVerificationCount: 0,
      upstreamTaskId: "task-1",
      packageRevision: 40,
      packageTaskId: "task-1",
      packageDescriptorHash: DESCRIPTOR_HASH,
      packageArchiveSha256: ARCHIVE_HASH,
      publishedSnapshotId: "snapshot-1",
      publishedAt: PUBLISHED_AT,
      createdAt: new Date("2026-07-01T01:00:00.000Z"),
      ...overrides.build,
    },
    notBefore: CONTRACT_START,
  };
}

describe("authenticated advanced knowledge publication", () => {
  it("accepts only a fully traversed build transactionally linked to its snapshot", () => {
    expect(isAuthenticatedAdvancedKnowledgePublication(publication())).toBe(
      true,
    );
  });

  it("preserves the descriptor-hash path only for packages without durable bytes", () => {
    expect(
      isAuthenticatedAdvancedKnowledgePublication(
        publication({
          snapshot: {
            sourceArtifactHash: DESCRIPTOR_HASH,
            archiveHash: ARCHIVE_HASH,
          },
          build: { packageArchiveSha256: null },
        }),
      ),
    ).toBe(true);
  });

  it("rejects a durable publication whose snapshot bytes differ from the bound archive", () => {
    expect(
      isAuthenticatedAdvancedKnowledgePublication(
        publication({
          snapshot: {
            sourceArtifactHash: DESCRIPTOR_HASH,
            archiveHash: DESCRIPTOR_HASH,
          },
        }),
      ),
    ).toBe(false);
  });

  it("does not treat a website one-shot snapshot as advanced completion", () => {
    expect(
      isAuthenticatedAdvancedKnowledgePublication(
        publication({
          snapshot: {
            sourceBuildId: null,
            sourceBuildRevision: null,
            sourceTaskId: "website-presales-task",
            sourceArtifactHash: null,
          },
        }),
      ),
    ).toBe(false);
  });

  it("rejects old-contract, below-minimum and incomplete publications", () => {
    expect(
      isAuthenticatedAdvancedKnowledgePublication(
        publication({
          snapshot: {
            createdAt: new Date("2026-06-30T23:59:59.000Z"),
          },
        }),
      ),
    ).toBe(false);
    expect(
      isAuthenticatedAdvancedKnowledgePublication(
        publication({
          build: {
            totalNodeCount: 7,
            confirmedCount: 5,
            directPrefilledCount: 2,
          },
        }),
      ),
    ).toBe(false);
    expect(
      isAuthenticatedAdvancedKnowledgePublication(
        publication({
          build: {
            confirmedCount: 29,
            directPrefilledCount: 10,
            needsVerificationCount: 1,
          },
        }),
      ),
    ).toBe(false);
  });
});
