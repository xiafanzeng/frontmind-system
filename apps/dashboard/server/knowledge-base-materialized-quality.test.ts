import { describe, expect, it } from "vitest";

import type { MaterializedBuildPublishabilityInput } from "./knowledge-base-materialized-quality";
import {
  isMaterializedBuildPublishable,
  materializedBuildResultQuality,
  materializedInitialResearchQuality,
} from "./knowledge-base-materialized-quality";
import { KNOWLEDGE_BASE_MATERIALIZED_V5_SKILL_CONTENT_HASH } from "./knowledge-base-tree-policy-rollout";

const DIMENSION_IDS = [
  "enterprise_identity",
  "team_and_organization",
  "products_and_services",
  "capabilities_and_delivery",
  "industries_scenarios_and_cases",
  "differentiation_and_evidence",
  "cooperation_delivery_and_support",
] as const;

function leafIds(count = 30) {
  return Array.from({ length: count }, (_, index) => `leaf-${index + 1}`);
}

function researchCoverage(ids: readonly string[], uploadsRead = 2) {
  return {
    officialPages: {
      discovered: 12,
      attempted: 12,
      succeeded: 12,
      failed: 0,
    },
    publicQueries: 6,
    officialDocuments: 0,
    uploadsRead,
    sourceCount: 12,
    productFamilies: [
      {
        id: "primary-product",
        name: "主要产品族",
        leafIds: [...ids],
      },
    ],
    dimensions: DIMENSION_IDS.map((id, index) => ({
      id,
      status: "covered" as const,
      leafIds: [ids[index]!],
    })),
    stopReason: "coverage_complete" as const,
  };
}

function build(
  initialResearchCoverage: Record<string, unknown> | null,
  materializedQuality: Record<string, unknown>,
  overrides: Partial<MaterializedBuildPublishabilityInput> = {},
): MaterializedBuildPublishabilityInput {
  return {
    executionMode: "materialized_bundle_v1",
    providerProtocol: "manus_v2",
    skillVersion: "5",
    skillContentHash: KNOWLEDGE_BASE_MATERIALIZED_V5_SKILL_CONTENT_HASH,
    activeWorkingSetId: "123e4567-e89b-42d3-a456-426614174000",
    contentVersion: 1,
    treePolicyVersion: 2,
    totalNodeCount: 30,
    initialResearchCoverage,
    handoffProvenance: { materializedQuality },
    ...overrides,
  };
}

describe("materialized knowledge-base publishability", () => {
  it("carries validated activation coverage into revision/package/publication eligibility", () => {
    const ids = leafIds();
    const activated = materializedInitialResearchQuality({
      researchCoverage: researchCoverage(ids),
      leafIds: ids,
      expectedUploadsRead: 2,
    });

    expect(activated.materializedQuality).toEqual({
      completeness: "complete",
      stats: {
        acceptedCount: 30,
        expectedCount: 30,
        droppedCount: 0,
      },
      warnings: [],
      downstreamEligible: true,
      publishable: true,
    });
    expect(
      isMaterializedBuildPublishable(
        build(activated.initialResearchCoverage, activated.materializedQuality),
        { knownLeafIds: ids },
      ),
    ).toBe(true);
  });

  it("keeps safe content display-only when upload coverage is inconsistent", () => {
    const ids = leafIds();
    const activated = materializedInitialResearchQuality({
      researchCoverage: researchCoverage(ids, 1),
      leafIds: ids,
      expectedUploadsRead: 2,
    });

    expect(activated).toEqual({
      initialResearchCoverage: null,
      materializedQuality: {
        completeness: "partial",
        stats: {
          acceptedCount: 30,
          expectedCount: 30,
          droppedCount: 0,
        },
        warnings: [{ code: "COVERAGE_INCOMPLETE" }],
        downstreamEligible: false,
        publishable: false,
      },
    });
    expect(
      isMaterializedBuildPublishable(
        build(activated.initialResearchCoverage, activated.materializedQuality),
        { knownLeafIds: ids },
      ),
    ).toBe(false);
  });

  it("does not upgrade a typed partial render snapshot after canonical revalidation", () => {
    const ids = leafIds();
    const activated = materializedInitialResearchQuality({
      researchCoverage: researchCoverage(ids),
      leafIds: ids,
      expectedUploadsRead: 2,
      warnings: [{ code: "MANIFEST_NORMALIZED", area: "nodes" }],
      normalization: {
        completeness: "partial",
        downstreamEligible: false,
        publishable: false,
      },
    });

    expect(activated.materializedQuality).toMatchObject({
      completeness: "partial",
      downstreamEligible: false,
      publishable: false,
      warnings: [{ code: "MANIFEST_NORMALIZED", area: "nodes" }],
    });
  });

  it("requires the deep leaf count and exact accepted node identity set", () => {
    const ids = leafIds();
    const activated = materializedInitialResearchQuality({
      researchCoverage: researchCoverage(ids),
      leafIds: ids,
      expectedUploadsRead: 2,
    });
    const eligible = build(
      activated.initialResearchCoverage,
      activated.materializedQuality,
    );

    expect(
      isMaterializedBuildPublishable(eligible, {
        knownLeafIds: ids.slice(0, 29),
      }),
    ).toBe(false);
    expect(
      isMaterializedBuildPublishable(eligible, {
        knownLeafIds: [...ids.slice(0, 29), ids[0]!],
      }),
    ).toBe(false);
    expect(
      isMaterializedBuildPublishable(
        { ...eligible, totalNodeCount: 29 },
        { knownLeafIds: ids.slice(0, 29) },
      ),
    ).toBe(false);
  });

  it("honors an explicit server-authored partial quality projection", () => {
    const ids = leafIds();
    const activated = materializedInitialResearchQuality({
      researchCoverage: researchCoverage(ids),
      leafIds: ids,
      expectedUploadsRead: 2,
    });
    expect(
      isMaterializedBuildPublishable(
        build(activated.initialResearchCoverage, {
          completeness: "partial",
          warnings: [{ code: "EVIDENCE_INCOMPLETE" }],
          publishable: false,
        }),
        { knownLeafIds: ids },
      ),
    ).toBe(false);
  });

  it("keeps an old-hash active Working Set read-only", () => {
    const ids = leafIds();
    const activated = materializedInitialResearchQuality({
      researchCoverage: researchCoverage(ids),
      leafIds: ids,
      expectedUploadsRead: 2,
    });
    expect(
      isMaterializedBuildPublishable(
        build(
          activated.initialResearchCoverage,
          activated.materializedQuality,
          { skillContentHash: "a".repeat(64) },
        ),
        { knownLeafIds: ids },
      ),
    ).toBe(false);
  });

  it("projects only coarse warning areas into the public progress DTO", () => {
    const projected = materializedBuildResultQuality({
      totalNodeCount: 29,
      handoffProvenance: {
        materializedQuality: {
          completeness: "partial",
          stats: {
            acceptedCount: 29,
            expectedCount: 30,
            droppedCount: 3,
          },
          warnings: [
            {
              code: "EVIDENCE_INCOMPLETE",
              area: "evidence/1.1/private-source.md",
            },
            {
              code: "OPTIONAL_ASSET_SKIPPED",
              area: "assets",
            },
            {
              code: "ITEM_DROPPED",
              area: "asset-123e4567-e89b-42d3-a456-426614174000",
            },
          ],
          downstreamEligible: false,
          publishable: false,
        },
      },
    });

    expect(projected?.warnings).toEqual([
      { code: "EVIDENCE_INCOMPLETE" },
      { code: "OPTIONAL_ASSET_SKIPPED", area: "assets" },
      { code: "ITEM_DROPPED" },
    ]);
    expect(JSON.stringify(projected)).not.toMatch(
      /private-source|\.md|123e4567|evidence\//u,
    );
  });
});
