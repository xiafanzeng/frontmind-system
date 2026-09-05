import type { KnowledgeBaseBuild } from "../drizzle/schema";
import type {
  KnowledgeBaseResultQualityDto,
  KnowledgeBaseResultQualityWarningCode,
} from "../shared/knowledge-base-progress";
import {
  knowledgeBaseTreePolicy,
  validateStoredKnowledgeBaseResearchCoverage,
} from "./knowledge-base-progress";
import { KNOWLEDGE_BASE_MATERIALIZED_V5_SKILL_CONTENT_HASH } from "./knowledge-base-tree-policy-rollout";

const MATERIALIZED_EXECUTION_MODE = "materialized_bundle_v1" as const;

export type MaterializedBuildPublishabilityInput = Pick<
  KnowledgeBaseBuild,
  | "executionMode"
  | "providerProtocol"
  | "skillVersion"
  | "skillContentHash"
  | "activeWorkingSetId"
  | "contentVersion"
  | "treePolicyVersion"
  | "totalNodeCount"
  | "initialResearchCoverage"
  | "handoffProvenance"
>;

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

export function materializedInitialResearchQuality(input: {
  researchCoverage: unknown;
  leafIds: readonly string[];
  expectedUploadsRead: number;
  warnings?: KnowledgeBaseResultQualityDto["warnings"];
  droppedCount?: number;
  normalization?: Pick<
    KnowledgeBaseResultQualityDto,
    "completeness" | "downstreamEligible" | "publishable"
  >;
}) {
  const acceptedCount = input.leafIds.length;
  const countComplete = acceptedCount >= 30 && acceptedCount <= 115;
  const droppedBody = input.warnings?.some(
    (warning) => warning.code === "RESULT_INCOMPLETE",
  );
  let initialResearchCoverage: Record<string, unknown> | null = null;
  let coverageComplete = false;
  try {
    if (
      !Number.isSafeInteger(input.expectedUploadsRead) ||
      input.expectedUploadsRead < 0
    ) {
      throw new Error("Initial upload count is invalid");
    }
    initialResearchCoverage = validateStoredKnowledgeBaseResearchCoverage(
      input.researchCoverage,
      {
        knownLeafIds: input.leafIds,
        totalLeafCount: acceptedCount,
        expectedUploadsRead: input.expectedUploadsRead,
      },
    ) as unknown as Record<string, unknown>;
    coverageComplete = true;
  } catch {
    initialResearchCoverage = null;
  }
  const normalizationComplete =
    !input.normalization ||
    (input.normalization.completeness === "complete" &&
      input.normalization.downstreamEligible === true &&
      input.normalization.publishable === true);
  const publishable =
    countComplete && coverageComplete && !droppedBody && normalizationComplete;
  const warnings: NonNullable<KnowledgeBaseResultQualityDto["warnings"]> = [
    ...(input.warnings || []),
  ];
  if (!countComplete && !droppedBody)
    warnings.push({ code: "RESULT_INCOMPLETE" });
  if (!coverageComplete) warnings.push({ code: "COVERAGE_INCOMPLETE" });
  const deduplicatedWarnings = warnings.filter(
    (warning, index) =>
      warnings.findIndex(
        (candidate) =>
          candidate.code === warning.code && candidate.area === warning.area,
      ) === index,
  );
  return {
    initialResearchCoverage,
    materializedQuality: {
      completeness: publishable ? ("complete" as const) : ("partial" as const),
      stats: {
        acceptedCount,
        expectedCount: 30,
        droppedCount: Math.max(0, Number(input.droppedCount) || 0),
      },
      warnings: deduplicatedWarnings,
      downstreamEligible: publishable,
      publishable,
    } satisfies KnowledgeBaseResultQualityDto,
  };
}

const QUALITY_WARNING_CODES = new Set<KnowledgeBaseResultQualityWarningCode>([
  "RESULT_INCOMPLETE",
  "ITEM_DROPPED",
  "EVIDENCE_INCOMPLETE",
  "AGGREGATE_UNAVAILABLE",
  "OPTIONAL_ASSET_SKIPPED",
  "OPTIONAL_BINARY_EVIDENCE_SKIPPED",
  "MANIFEST_NORMALIZED",
  "SERVER_COORDINATE_NORMALIZED",
  "PRESENTATION_NORMALIZED",
  "COVERAGE_INCOMPLETE",
]);

// Public progress payloads intentionally expose only coarse, user-facing
// sections. Provider paths, filenames, IDs and hashes stay in the internal
// validation result and must never cross this projection boundary.
const PUBLIC_QUALITY_WARNING_AREAS = new Set([
  "nodes",
  "evidence",
  "assets",
  "logo",
  "coverage",
]);

export function materializedBuildResultQuality(
  build: Pick<KnowledgeBaseBuild, "handoffProvenance" | "totalNodeCount">,
): KnowledgeBaseResultQualityDto | undefined {
  const raw = record(record(build.handoffProvenance)?.materializedQuality);
  if (
    !raw ||
    (raw.completeness !== "complete" && raw.completeness !== "partial")
  ) {
    return undefined;
  }
  const rawStats = record(raw.stats);
  const acceptedCount = Number(rawStats?.acceptedCount);
  const expectedCount = Number(rawStats?.expectedCount);
  const droppedCount = Number(rawStats?.droppedCount);
  const warnings = Array.isArray(raw.warnings)
    ? raw.warnings.flatMap((warning) => {
        const value = record(warning);
        const code = value?.code as KnowledgeBaseResultQualityWarningCode;
        if (!QUALITY_WARNING_CODES.has(code)) return [];
        const area = typeof value?.area === "string" ? value.area.trim() : "";
        return [
          {
            code,
            ...(PUBLIC_QUALITY_WARNING_AREAS.has(area) ? { area } : {}),
          },
        ];
      })
    : [];
  return {
    completeness: raw.completeness,
    ...(Number.isSafeInteger(acceptedCount) &&
    acceptedCount >= 0 &&
    Number.isSafeInteger(droppedCount) &&
    droppedCount >= 0
      ? {
          stats: {
            acceptedCount,
            ...(Number.isSafeInteger(expectedCount) && expectedCount >= 0
              ? { expectedCount }
              : {}),
            droppedCount,
          },
        }
      : {
          stats: {
            acceptedCount: Math.max(0, build.totalNodeCount),
            droppedCount: 0,
          },
        }),
    warnings,
    downstreamEligible: raw.downstreamEligible === true,
    publishable: raw.publishable === true,
  };
}

/**
 * One server-owned content-quality predicate shared by revision, package and
 * publication. Workflow state (current node, confirmation count and package
 * binding) stays at the respective entry point; this predicate only answers
 * whether the active materialized Working Set is complete enough to drive any
 * of those downstream mutations.
 */
export function isMaterializedBuildPublishable(
  build: MaterializedBuildPublishabilityInput,
  options: { knownLeafIds?: readonly string[] } = {},
) {
  if (
    build.executionMode !== MATERIALIZED_EXECUTION_MODE ||
    build.providerProtocol !== "manus_v2" ||
    build.skillVersion !== "5" ||
    build.skillContentHash !==
      KNOWLEDGE_BASE_MATERIALIZED_V5_SKILL_CONTENT_HASH ||
    !build.activeWorkingSetId ||
    !Number.isSafeInteger(build.contentVersion) ||
    Number(build.contentVersion) < 1
  ) {
    return false;
  }

  let policy: ReturnType<typeof knowledgeBaseTreePolicy>;
  try {
    policy = knowledgeBaseTreePolicy(build.treePolicyVersion);
  } catch {
    return false;
  }
  if (
    !Number.isSafeInteger(build.totalNodeCount) ||
    build.totalNodeCount < policy.minLeaves ||
    build.totalNodeCount > policy.maxLeaves
  ) {
    return false;
  }

  const knownLeafIds = options.knownLeafIds;
  if (knownLeafIds) {
    const normalized = knownLeafIds.map((leafId) => String(leafId).trim());
    if (
      normalized.some((leafId) => !leafId) ||
      new Set(normalized).size !== normalized.length ||
      normalized.length !== build.totalNodeCount
    ) {
      return false;
    }
  }

  try {
    validateStoredKnowledgeBaseResearchCoverage(build.initialResearchCoverage, {
      ...(knownLeafIds ? { knownLeafIds } : {}),
      totalLeafCount: build.totalNodeCount,
    });
  } catch {
    return false;
  }

  const materializedQuality = record(
    record(build.handoffProvenance)?.materializedQuality,
  );
  if (
    materializedQuality?.publishable === false ||
    materializedQuality?.completeness === "partial"
  ) {
    return false;
  }
  return true;
}
