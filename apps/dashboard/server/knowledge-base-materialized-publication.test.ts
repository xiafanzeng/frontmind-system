import { describe, expect, it } from "vitest";

import type {
  KnowledgeBaseBuild,
  KnowledgeBaseBuildNode,
} from "../drizzle/schema";
import { isAuthenticatedAdvancedKnowledgePublication } from "./authenticated-knowledge-service";
import {
  buildDashboardOwnedKnowledgePackage,
  readDashboardOwnedKnowledgePackage,
} from "./knowledge-base-local-package";
import {
  isMaterializedBuildPublishable,
  materializedInitialResearchQuality,
} from "./knowledge-base-materialized-quality";
import { knowledgeBaseMarkdownSha256 } from "./knowledge-base-package-validation";
import { knowledgeBasePackageWriterTaskId } from "./knowledge-base-publication-binding";
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

describe("materialized activation to authenticated publication", () => {
  it("keeps one validated coverage ledger through package and publication", async () => {
    const leafIds = Array.from(
      { length: 30 },
      (_, index) => `leaf-${index + 1}`,
    );
    const activated = materializedInitialResearchQuality({
      researchCoverage: {
        officialPages: {
          discovered: 12,
          attempted: 12,
          succeeded: 12,
          failed: 0,
        },
        publicQueries: 6,
        officialDocuments: 2,
        uploadsRead: 3,
        sourceCount: 14,
        productFamilies: [{ id: "primary", name: "核心产品", leafIds }],
        dimensions: DIMENSION_IDS.map((id, index) => ({
          id,
          status: "covered",
          leafIds: [leafIds[index]!],
        })),
        stopReason: "coverage_complete",
      },
      leafIds,
      expectedUploadsRead: 3,
    });
    const build = {
      id: "123e4567-e89b-42d3-a456-426614174000",
      userId: 7,
      generation: 1,
      revision: 30,
      companyName: "FrontMind",
      executionMode: "materialized_bundle_v1",
      providerProtocol: "manus_v2",
      skillVersion: "5",
      skillContentHash: KNOWLEDGE_BASE_MATERIALIZED_V5_SKILL_CONTENT_HASH,
      activeWorkingSetId: "123e4567-e89b-42d3-a456-426614174001",
      contentVersion: 1,
      treePolicyVersion: 2,
      totalNodeCount: 30,
      initialResearchCoverage: activated.initialResearchCoverage,
      handoffProvenance: {
        materializedQuality: activated.materializedQuality,
      },
      logoStorageKey: null,
    } as KnowledgeBaseBuild;
    const nodes = leafIds.map((leafId, ordinal) => {
      const contentMarkdown = `# 节点 ${ordinal + 1}\n\n已确认的企业知识正文。\n`;
      return {
        leafId,
        title: `节点 ${ordinal + 1}`,
        branchId: `branch-${Math.floor(ordinal / 5) + 1}`,
        branchTitle: `分支 ${Math.floor(ordinal / 5) + 1}`,
        ordinal,
        status: "confirmed",
        contentMarkdown,
        contentSha256: knowledgeBaseMarkdownSha256(contentMarkdown),
        sourceUrls: [],
        imageUrls: [],
        assetRefs: [],
      } as KnowledgeBaseBuildNode;
    });

    expect(
      isMaterializedBuildPublishable(build, { knownLeafIds: leafIds }),
    ).toBe(true);

    const packaged = await buildDashboardOwnedKnowledgePackage({
      build,
      nodes,
    });
    const parsed = await readDashboardOwnedKnowledgePackage({
      buffer: packaged.buffer,
      expected: {
        buildId: build.id,
        generation: build.generation,
        revision: build.revision,
        companyName: build.companyName,
      },
      nodes,
    });
    expect(parsed.documents).toHaveLength(30);
    expect(parsed.manifest.documents).toHaveLength(30);

    const publishedAt = new Date("2026-08-16T00:00:00.000Z");
    const snapshotId = "snapshot-materialized";
    const packageTaskId = knowledgeBasePackageWriterTaskId(build);
    expect(
      isAuthenticatedAdvancedKnowledgePublication({
        snapshot: {
          id: snapshotId,
          userId: build.userId,
          sourceBuildId: build.id,
          sourceBuildRevision: build.revision,
          sourceTaskId: packageTaskId,
          sourceArtifactHash: packaged.sha256,
          archiveHash: packaged.sha256,
          status: "active",
          createdAt: publishedAt,
        },
        build: {
          id: build.id,
          userId: build.userId,
          generation: build.generation,
          executionMode: build.executionMode,
          status: "published",
          revision: build.revision,
          currentLeafId: null,
          totalNodeCount: build.totalNodeCount,
          confirmedCount: 30,
          directPrefilledCount: 0,
          needsVerificationCount: 0,
          upstreamTaskId: null,
          canonicalTaskId: null,
          packageRevision: build.revision,
          packageTaskId,
          packageDescriptorHash: "d".repeat(64),
          packageArchiveSha256: packaged.sha256,
          publishedSnapshotId: snapshotId,
          publishedAt,
          createdAt: new Date("2026-08-15T00:00:00.000Z"),
          treePolicyVersion: build.treePolicyVersion,
          initialResearchCoverage: build.initialResearchCoverage,
        },
        notBefore: new Date("2026-08-01T00:00:00.000Z"),
      }),
    ).toBe(true);
  });
});
