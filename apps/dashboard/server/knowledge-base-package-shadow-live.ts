import { createHash } from "node:crypto";

import type { KnowledgeAsset } from "../shared/dashboard";
import {
  parseFinalizationSupplementNdjson,
  type FinalizationSupplementRecord,
} from "./knowledge-base-finalization-supplement";
import {
  buildFinalizationSupplementShadowArchive,
  buildProviderSupplementedShadowArchive,
  validateProviderSupplementedShadowArchive,
} from "./knowledge-base-package-shadow";
import {
  buildPackageProjectionV1,
  packageProjectionCoverage,
  persistPackageProjectionSidecar,
  type PackageProjectionV1,
  type ValidatedArchive,
} from "./knowledge-package-projection";

const DISABLED_VALUES = new Set(["0", "disabled", "false", "off"]);

export type KnowledgePackageShadowRuleCode =
  | "package_projection_built"
  | "package_projection_failed"
  | "package_projection_sidecar_failed"
  | "package_shadow_a_equivalent"
  | "package_shadow_a_asset_read_failed"
  | "package_shadow_a_leaf_diverged"
  | "package_shadow_a_leaf_missing"
  | "package_shadow_a_rebuild_failed"
  | "package_shadow_a_validation_failed"
  | "package_shadow_b_equivalent"
  | "package_shadow_b_failed"
  | "package_shadow_b_supplement_missing";

export type KnowledgePackageShadowObservation = {
  ruleCode: KnowledgePackageShadowRuleCode;
  sampleId: string;
  buildId: string;
  generation: number;
  coverageComplete?: boolean;
  missingKinds?: string[];
};

function liveShadowEnabled(environment: NodeJS.ProcessEnv) {
  const configured =
    environment.FRONTMIND_KB_PACKAGE_SHADOW?.trim().toLowerCase();
  return !configured || !DISABLED_VALUES.has(configured);
}

function shadowSampleId(input: { buildId: string; generation: number }) {
  return createHash("sha256")
    .update(`${input.buildId}\u0000${input.generation}`, "utf8")
    .digest("hex");
}

function defaultReport(observation: KnowledgePackageShadowObservation) {
  // No provider text, filenames, URLs, user data or exception messages are
  // emitted. `sampleId` is derived only from buildId + sticky generation, so
  // retries, competing candidates and at-least-once polling can never inflate
  // one real build into multiple shadow samples.
  console.info("[KnowledgeBasePackageShadow]", JSON.stringify(observation));
}

function supplementalRecords(
  supplementText: string | undefined,
): readonly FinalizationSupplementRecord[] | undefined {
  if (supplementText === undefined || supplementText.trim() === "") {
    return undefined;
  }
  return parseFinalizationSupplementNdjson(supplementText).records;
}

function shadowARebuildRuleCode(
  error: unknown,
): KnowledgePackageShadowRuleCode {
  const message = error instanceof Error ? error.message : "";
  if (message.startsWith("PACKAGE_SHADOW_LEAF_DIVERGED")) {
    return "package_shadow_a_leaf_diverged";
  }
  if (
    message.startsWith("PACKAGE_SHADOW_LEAF_INPUT_INCOMPLETE") ||
    message.startsWith("PACKAGE_SHADOW_LEAF_MISSING")
  ) {
    return "package_shadow_a_leaf_missing";
  }
  return "package_shadow_a_rebuild_failed";
}

/**
 * Best-effort, default-on evidence collection for P3/P4.
 *
 * This function is deliberately incapable of changing a build, package key,
 * publication decision or database row. It writes only a rebuildable
 * PackageProjectionV1 sidecar and emits privacy-safe reason codes. Every
 * failure is converted into an observation/result and therefore cannot fail
 * the already-validated provider package path.
 */
export async function runKnowledgePackageLiveShadow(input: {
  buildId: string;
  generation: number;
  archiveBytes: Buffer;
  validatedArchive: ValidatedArchive;
  serverLeafMarkdownById: ReadonlyMap<string, string>;
  readDashboardAssetBytes: (asset: KnowledgeAsset) => Promise<Buffer>;
  validateArchive: (bytes: Buffer) => Promise<ValidatedArchive>;
  supplementText?: string;
  environment?: NodeJS.ProcessEnv;
  report?: (observation: KnowledgePackageShadowObservation) => void;
}) {
  const environment = input.environment ?? process.env;
  if (!liveShadowEnabled(environment)) {
    return { status: "disabled" as const };
  }
  const report = input.report ?? defaultReport;
  const safeReport = (observation: KnowledgePackageShadowObservation) => {
    try {
      report(observation);
    } catch {
      // Observability cannot become package authority.
    }
  };

  let projection: PackageProjectionV1;
  let sampleId: string;
  try {
    projection = await buildPackageProjectionV1({
      buildId: input.buildId,
      generation: input.generation,
      archiveBytes: input.archiveBytes,
      validatedArchive: input.validatedArchive,
    });
    sampleId = shadowSampleId(projection);
  } catch {
    // The archive already passed the authoritative validator. A projection
    // implementation failure is shadow evidence only and never escapes.
    safeReport({
      ruleCode: "package_projection_failed",
      sampleId: createHash("sha256")
        .update(`${input.buildId}\u0000${input.generation}`, "utf8")
        .digest("hex"),
      buildId: input.buildId,
      generation: input.generation,
    });
    return { status: "failed" as const, phase: "projection" as const };
  }

  const coverage = packageProjectionCoverage(projection);
  safeReport({
    ruleCode: "package_projection_built",
    sampleId,
    buildId: input.buildId,
    generation: input.generation,
    coverageComplete: coverage.complete,
    missingKinds: coverage.missingKinds,
  });
  try {
    await persistPackageProjectionSidecar(projection);
  } catch {
    safeReport({
      ruleCode: "package_projection_sidecar_failed",
      sampleId,
      buildId: input.buildId,
      generation: input.generation,
    });
    // The in-memory comparison remains useful and independent of cache I/O.
  }

  let dashboardAssetBytesById: Map<string, Buffer>;
  let shadowABytes: Buffer;
  try {
    const validatedAssetById = new Map(
      input.validatedArchive.assets
        .filter((asset) => typeof asset.id === "string")
        .map((asset) => [asset.id!, asset]),
    );
    dashboardAssetBytesById = new Map(
      await Promise.all(
        projection.assets.map(async (projected) => {
          const validated = validatedAssetById.get(projected.id);
          if (!validated) {
            throw new Error("PACKAGE_SHADOW_ASSET_INPUT_INCOMPLETE");
          }
          return [
            projected.id,
            await input.readDashboardAssetBytes(validated),
          ] as const;
        }),
      ),
    );
  } catch {
    safeReport({
      ruleCode: "package_shadow_a_asset_read_failed",
      sampleId,
      buildId: input.buildId,
      generation: input.generation,
    });
    return {
      status: "failed" as const,
      phase: "shadow_a_asset_read" as const,
      projection,
      coverage,
      sampleId,
    };
  }
  try {
    const shadowA = await buildProviderSupplementedShadowArchive({
      projection,
      providerArchiveBytes: input.archiveBytes,
      serverLeafMarkdownById: input.serverLeafMarkdownById,
      dashboardAssetBytesById,
    });
    shadowABytes = shadowA.bytes;
  } catch (error) {
    safeReport({
      ruleCode: shadowARebuildRuleCode(error),
      sampleId,
      buildId: input.buildId,
      generation: input.generation,
    });
    return {
      status: "failed" as const,
      phase: "shadow_a_rebuild" as const,
      projection,
      coverage,
      sampleId,
    };
  }
  try {
    await validateProviderSupplementedShadowArchive({
      authoritativeProjection: projection,
      shadowArchiveBytes: shadowABytes,
      validateArchive: input.validateArchive,
    });
  } catch {
    safeReport({
      ruleCode: "package_shadow_a_validation_failed",
      sampleId,
      buildId: input.buildId,
      generation: input.generation,
    });
    return {
      status: "failed" as const,
      phase: "shadow_a_validation" as const,
      projection,
      coverage,
      sampleId,
    };
  }

  safeReport({
    ruleCode: "package_shadow_a_equivalent",
    sampleId,
    buildId: input.buildId,
    generation: input.generation,
  });

  let records: readonly FinalizationSupplementRecord[] | undefined;
  try {
    records = supplementalRecords(input.supplementText);
  } catch {
    safeReport({
      ruleCode: "package_shadow_b_failed",
      sampleId,
      buildId: input.buildId,
      generation: input.generation,
    });
    return {
      status: "shadow_a_equivalent" as const,
      shadowB: "failed" as const,
      projection,
      coverage,
      sampleId,
    };
  }
  if (!records) {
    safeReport({
      ruleCode: "package_shadow_b_supplement_missing",
      sampleId,
      buildId: input.buildId,
      generation: input.generation,
    });
    return {
      status: "shadow_a_equivalent" as const,
      shadowB: "supplement_missing" as const,
      projection,
      coverage,
      sampleId,
    };
  }

  try {
    const shadowB = await buildFinalizationSupplementShadowArchive({
      projection,
      providerArchiveBytes: input.archiveBytes,
      serverLeafMarkdownById: input.serverLeafMarkdownById,
      dashboardAssetBytesById,
      supplementRecords: records,
    });
    await validateProviderSupplementedShadowArchive({
      authoritativeProjection: projection,
      shadowArchiveBytes: shadowB.bytes,
      validateArchive: input.validateArchive,
    });
  } catch {
    safeReport({
      ruleCode: "package_shadow_b_failed",
      sampleId,
      buildId: input.buildId,
      generation: input.generation,
    });
    return {
      status: "shadow_a_equivalent" as const,
      shadowB: "failed" as const,
      projection,
      coverage,
      sampleId,
    };
  }
  safeReport({
    ruleCode: "package_shadow_b_equivalent",
    sampleId,
    buildId: input.buildId,
    generation: input.generation,
  });
  return {
    status: "shadow_b_equivalent" as const,
    projection,
    coverage,
    sampleId,
  };
}
