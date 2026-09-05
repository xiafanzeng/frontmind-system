import { createHash } from "node:crypto";

import { z } from "zod";

import {
  packageProjectionCoverage,
  packageProjectionV1Schema,
  type PackageProjectionV1,
} from "./knowledge-package-projection";

const SHA256_PATTERN = /^[a-f0-9]{64}$/u;
const BUILD_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

/**
 * A read-only projection of the complete validated package. It deliberately
 * contains no storage key or remote URL: preview consumers must obtain asset
 * bytes through the existing authenticated archive/storage routes.
 */
export const knowledgeBaseFinalizationPreviewSchema = z
  .object({
    kind: z.literal("frontmind.knowledge-base-finalization-preview"),
    schemaVersion: z.literal(1),
    buildId: z.string().regex(BUILD_ID_PATTERN),
    generation: z.number().int().positive(),
    revision: z.number().int().nonnegative(),
    archiveSha256: z.string().regex(SHA256_PATTERN),
    packageSemanticFingerprint: z.string().regex(SHA256_PATTERN),
    previewFingerprint: z.string().regex(SHA256_PATTERN),
    documents: packageProjectionV1Schema.shape.documents,
    assets: packageProjectionV1Schema.shape.assets,
    statistics: packageProjectionV1Schema.shape.statistics,
  })
  .strict();

export type KnowledgeBaseFinalizationPreview = z.infer<
  typeof knowledgeBaseFinalizationPreviewSchema
>;

type PreviewCoordinates = {
  buildId: string;
  generation: number;
  revision: number;
  archiveSha256: string;
  packageSemanticFingerprint: string;
};

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, nested]) => `${JSON.stringify(key)}:${canonicalJson(nested)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function previewFingerprint(input: {
  coordinates: PreviewCoordinates;
  documents: PackageProjectionV1["documents"];
  assets: PackageProjectionV1["assets"];
  statistics: PackageProjectionV1["statistics"];
}) {
  return createHash("sha256").update(canonicalJson(input)).digest("hex");
}

function coordinatesFromProjection(
  projection: PackageProjectionV1,
  revision: number,
): PreviewCoordinates {
  return {
    buildId: projection.buildId,
    generation: projection.generation,
    revision,
    archiveSha256: projection.archiveSha256,
    packageSemanticFingerprint: projection.semanticFingerprint,
  };
}

export function buildKnowledgeBaseFinalizationPreview(input: {
  projection: PackageProjectionV1;
  revision: number;
}): KnowledgeBaseFinalizationPreview {
  const projection = packageProjectionV1Schema.parse(input.projection);
  if (!Number.isSafeInteger(input.revision) || input.revision < 0) {
    throw new Error("FINALIZATION_PREVIEW_REVISION_INVALID");
  }
  const coverage = packageProjectionCoverage(projection);
  if (!coverage.complete) {
    throw new Error(
      `FINALIZATION_PREVIEW_INCOMPLETE:${coverage.missingKinds.join(",")}`,
    );
  }
  const coordinates = coordinatesFromProjection(projection, input.revision);
  return knowledgeBaseFinalizationPreviewSchema.parse({
    kind: "frontmind.knowledge-base-finalization-preview",
    schemaVersion: 1,
    ...coordinates,
    previewFingerprint: previewFingerprint({
      coordinates,
      documents: projection.documents,
      assets: projection.assets,
      statistics: projection.statistics,
    }),
    documents: projection.documents,
    assets: projection.assets,
    statistics: projection.statistics,
  });
}

export function assertKnowledgeBaseFinalizationPreviewCurrent(input: {
  preview: KnowledgeBaseFinalizationPreview;
  current: PreviewCoordinates;
}) {
  const preview = knowledgeBaseFinalizationPreviewSchema.parse(input.preview);
  const expectedFingerprint = previewFingerprint({
    coordinates: input.current,
    documents: preview.documents,
    assets: preview.assets,
    statistics: preview.statistics,
  });
  const coordinateMismatch =
    preview.buildId !== input.current.buildId ||
    preview.generation !== input.current.generation ||
    preview.revision !== input.current.revision ||
    preview.archiveSha256 !== input.current.archiveSha256 ||
    preview.packageSemanticFingerprint !==
      input.current.packageSemanticFingerprint;
  if (
    coordinateMismatch ||
    preview.previewFingerprint !== expectedFingerprint
  ) {
    throw new Error("FINALIZATION_PREVIEW_STALE");
  }
  return preview;
}
