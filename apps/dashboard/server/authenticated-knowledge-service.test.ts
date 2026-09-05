import { describe, expect, it } from "vitest";

import { isAuthenticatedAdvancedKnowledgePublication } from "./authenticated-knowledge-service";

const CONTRACT_START = new Date("2026-07-01T00:00:00.000Z");
const PUBLISHED_AT = new Date("2026-07-02T00:00:00.000Z");
const ARCHIVE_HASH = "a".repeat(64);
const DESCRIPTOR_HASH = "d".repeat(64);
const VALID_DEEP_RESEARCH_COVERAGE = {
  officialPages: {
    discovered: 12,
    attempted: 12,
    succeeded: 12,
    failed: 0,
  },
  publicQueries: 6,
  officialDocuments: 2,
  uploadsRead: 0,
  sourceCount: 14,
  productFamilies: [{ id: "primary", name: "核心产品", leafIds: ["leaf-3"] }],
  dimensions: [
    "enterprise_identity",
    "team_and_organization",
    "products_and_services",
    "capabilities_and_delivery",
    "industries_scenarios_and_cases",
    "differentiation_and_evidence",
    "cooperation_delivery_and_support",
  ].map((id, index) => ({
    id,
    status: "covered",
    leafIds: [`leaf-${index + 1}`],
  })),
  stopReason: "coverage_complete",
};

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
      status: "active" as const,
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
      treePolicyVersion: 1,
      initialResearchCoverage: null,
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

  it.each([8, 10])(
    "keeps historical v1 publication compatible at %s leaves",
    (count) => {
      expect(
        isAuthenticatedAdvancedKnowledgePublication(
          publication({
            build: {
              totalNodeCount: count,
              confirmedCount: count,
              directPrefilledCount: 0,
            },
          }),
        ),
      ).toBe(true);
    },
  );

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

  it("does not authenticate an archived publication", () => {
    expect(
      isAuthenticatedAdvancedKnowledgePublication(
        publication({ snapshot: { status: "archived" } }),
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

  it("requires 30 nodes and a research ledger for deep-policy publications", () => {
    expect(
      isAuthenticatedAdvancedKnowledgePublication(
        publication({
          build: {
            treePolicyVersion: 2,
            totalNodeCount: 29,
            confirmedCount: 29,
            directPrefilledCount: 0,
            initialResearchCoverage: VALID_DEEP_RESEARCH_COVERAGE,
          },
        }),
      ),
    ).toBe(false);
    expect(
      isAuthenticatedAdvancedKnowledgePublication(
        publication({
          build: {
            treePolicyVersion: 2,
            totalNodeCount: 30,
            confirmedCount: 30,
            directPrefilledCount: 0,
            initialResearchCoverage: null,
          },
        }),
      ),
    ).toBe(false);
    expect(
      isAuthenticatedAdvancedKnowledgePublication(
        publication({
          build: {
            treePolicyVersion: 2,
            totalNodeCount: 30,
            confirmedCount: 30,
            directPrefilledCount: 0,
            initialResearchCoverage: { stopReason: "coverage_complete" },
          },
        }),
      ),
    ).toBe(false);
    expect(
      isAuthenticatedAdvancedKnowledgePublication(
        publication({
          build: {
            treePolicyVersion: 2,
            totalNodeCount: 30,
            confirmedCount: 30,
            directPrefilledCount: 0,
            initialResearchCoverage: VALID_DEEP_RESEARCH_COVERAGE,
          },
        }),
      ),
    ).toBe(true);
  });
});
