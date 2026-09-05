import { and, eq, like, or, sql } from "drizzle-orm";

import {
  localAssets,
  siteBuildInputAssets,
  siteBuilds,
  siteDeployments,
  socialPackages,
  visualCandidatePoolItems,
  visualCandidatePoolPages,
  visualCandidatePools,
  websiteStyleSampleBatches,
  websiteStyleSamples,
} from "../../drizzle/schema";
import type { getDb } from "../db";

type SiteOpsArtifactDatabase = NonNullable<Awaited<ReturnType<typeof getDb>>>;

const SUPERSEDED_POOL_RECOVERY_MS = 7 * 24 * 60 * 60 * 1_000;

function withinSupersededRecoveryWindow(value: unknown, now: Date) {
  const timestamp = value instanceof Date ? value.getTime() : NaN;
  return (
    Number.isFinite(timestamp) &&
    timestamp > now.getTime() - SUPERSEDED_POOL_RECOVERY_MS
  );
}

async function poolPageRetainsArtifact(
  database: SiteOpsArtifactDatabase,
  page: { poolId?: unknown; status?: unknown; updatedAt?: unknown },
  now: Date,
) {
  if (page.status === "published" || page.status === "selected") return true;
  if (
    page.status === "superseded" &&
    withinSupersededRecoveryWindow(page.updatedAt, now)
  ) {
    return true;
  }
  if (page.status !== "reserved" || typeof page.poolId !== "string") {
    return false;
  }
  const pools = await database
    .select({ status: visualCandidatePools.status })
    .from(visualCandidatePools)
    .where(eq(visualCandidatePools.id, page.poolId))
    .limit(1);
  return pools[0]?.status === "active";
}

/**
 * The shared presales byte store also contains user uploads with a fixed TTL.
 * SiteOps output uses that store for immutable domain artifacts instead. Only
 * a `siteops:` row can be one of these artifacts, and every durable reference
 * is checked before the generic retention worker is allowed to add a TTL or
 * remove its bytes.
 */
export async function isSiteOpsArtifactReferenced(
  database: SiteOpsArtifactDatabase,
  localAssetId: string,
  now = new Date(),
) {
  const siteOpsAssets = await database
    .select({ id: localAssets.id })
    .from(localAssets)
    .where(
      and(
        eq(localAssets.id, localAssetId),
        like(localAssets.storageKey, "siteops:%"),
      ),
    )
    .limit(1);
  if (!siteOpsAssets[0]) return false;

  const previewReferences = await database
    .select({ id: websiteStyleSamples.id })
    .from(websiteStyleSamples)
    // V4 boards display the immutable 21st reference through the sample's
    // indexed direct preview coordinate.
    .where(eq(websiteStyleSamples.previewLocalAssetId, localAssetId))
    .limit(1);
  if (previewReferences[0]) return true;

  const v4MetadataPreviewReferences = await database
    .select({ id: websiteStyleSamples.id })
    .from(websiteStyleSamples)
    .where(
      or(
        // The independently rendered V4 realization remains a durable input
        // to the selected design/build even though it is not the board image.
        sql`JSON_UNQUOTE(JSON_EXTRACT(${websiteStyleSamples.sourceMetadata}, '$.realizationPreviewLocalAssetId')) = ${localAssetId}`,
        sql`JSON_UNQUOTE(JSON_EXTRACT(${websiteStyleSamples.sourceMetadata}, '$.referenceBlueprint.previewLocalAssetId')) = ${localAssetId}`,
        // Retain an explicitly frozen reference coordinate as well as the
        // direct column so a repaired/migrated row cannot orphan either side.
        sql`JSON_UNQUOTE(JSON_EXTRACT(${websiteStyleSamples.sourceMetadata}, '$.referenceBlueprint.referencePreviewLocalAssetId')) = ${localAssetId}`,
      ),
    )
    .limit(1);
  if (v4MetadataPreviewReferences[0]) return true;

  const bundleReferences = await database
    .select({ id: websiteStyleSampleBatches.id })
    .from(websiteStyleSampleBatches)
    .where(
      eq(websiteStyleSampleBatches.selectionBundleLocalAssetId, localAssetId),
    )
    .limit(1);
  if (bundleReferences[0]) return true;

  const poolManifestReferences = await database
    .select({
      id: visualCandidatePools.id,
      status: visualCandidatePools.status,
      updatedAt: visualCandidatePools.updatedAt,
    })
    .from(visualCandidatePools)
    .where(eq(visualCandidatePools.manifestLocalAssetId, localAssetId))
    .limit(1);
  const poolManifest = poolManifestReferences[0];
  if (
    poolManifest &&
    (poolManifest.status === "active" ||
      poolManifest.status === "selected" ||
      (poolManifest.status === "superseded" &&
        withinSupersededRecoveryWindow(poolManifest.updatedAt, now)))
  ) {
    return true;
  }

  const poolBundleReferences = await database
    .select({
      id: visualCandidatePoolPages.id,
      poolId: visualCandidatePoolPages.poolId,
      status: visualCandidatePoolPages.status,
      updatedAt: visualCandidatePoolPages.updatedAt,
    })
    .from(visualCandidatePoolPages)
    .where(
      eq(visualCandidatePoolPages.selectionBundleLocalAssetId, localAssetId),
    )
    .limit(1);
  if (
    poolBundleReferences[0] &&
    (await poolPageRetainsArtifact(database, poolBundleReferences[0], now))
  ) {
    return true;
  }

  const poolItemReferences = await database
    .select({ poolPageId: visualCandidatePoolItems.poolPageId })
    .from(visualCandidatePoolItems)
    .where(eq(visualCandidatePoolItems.previewLocalAssetId, localAssetId))
    .limit(1);
  if (poolItemReferences[0]) {
    const pages = await database
      .select({
        poolId: visualCandidatePoolPages.poolId,
        status: visualCandidatePoolPages.status,
        updatedAt: visualCandidatePoolPages.updatedAt,
      })
      .from(visualCandidatePoolPages)
      .where(eq(visualCandidatePoolPages.id, poolItemReferences[0].poolPageId))
      .limit(1);
    if (pages[0] && (await poolPageRetainsArtifact(database, pages[0], now))) {
      return true;
    }
  }

  const buildReferences = await database
    .select({ id: siteBuilds.id })
    .from(siteBuilds)
    .where(
      or(
        eq(siteBuilds.contentPlanLocalAssetId, localAssetId),
        eq(siteBuilds.contractLocalAssetId, localAssetId),
        eq(siteBuilds.sourceLocalAssetId, localAssetId),
        eq(siteBuilds.distLocalAssetId, localAssetId),
        eq(siteBuilds.qaLocalAssetId, localAssetId),
        eq(siteBuilds.provenanceLocalAssetId, localAssetId),
      ),
    )
    .limit(1);
  if (buildReferences[0]) return true;

  const buildInputReferences = await database
    .select({ id: siteBuildInputAssets.id })
    .from(siteBuildInputAssets)
    .where(eq(siteBuildInputAssets.localAssetId, localAssetId))
    .limit(1);
  if (buildInputReferences[0]) return true;

  const deploymentReferences = await database
    .select({ id: siteDeployments.id })
    .from(siteDeployments)
    .where(eq(siteDeployments.distLocalAssetId, localAssetId))
    .limit(1);
  if (deploymentReferences[0]) return true;

  const socialReferences = await database
    .select({ id: socialPackages.id })
    .from(socialPackages)
    .where(eq(socialPackages.archiveLocalAssetId, localAssetId))
    .limit(1);
  return Boolean(socialReferences[0]);
}
