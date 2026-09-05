import { createHash } from "node:crypto";
import { mkdir, readFile, unlink } from "node:fs/promises";
import path from "node:path";

import JSZip from "jszip";
import { z } from "zod";

import type { KnowledgeAsset, KnowledgeDocument } from "../shared/dashboard";
import { installImmutableFileAtomically } from "./atomic-immutable-file";
import { knowledgeBaseMarkdownSha256 } from "./knowledge-base-package-validation";

const SHA256_PATTERN = /^[a-f0-9]{64}$/u;
const BUILD_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

const projectionDocumentSchema = z
  .object({
    id: z.string().min(1).max(191),
    kind: z.enum(["overview", "leaf", "evidence", "report", "index", "other"]),
    path: z.string().min(1).max(600),
    title: z.string().min(1).max(512),
    branchId: z.string().min(1).max(191).nullable(),
    branchTitle: z.string().min(1).max(512).nullable(),
    order: z.number().int().nonnegative().nullable(),
    bodyMarkdown: z.string(),
    bodySha256: z.string().regex(SHA256_PATTERN),
    sourceIds: z.array(z.string().min(1).max(191)).max(500),
    assetIds: z.array(z.string().min(1).max(191)).max(500),
    evidenceDocumentIds: z.array(z.string().min(1).max(191)).max(500),
    customerVisible: z.boolean(),
  })
  .strict();

const projectionAssetSchema = z
  .object({
    id: z.string().min(1).max(191),
    path: z.string().min(1).max(600),
    sha256: z.string().regex(SHA256_PATTERN),
    mimeType: z.string().startsWith("image/"),
    bytes: z.number().int().positive(),
    width: z.number().int().positive(),
    height: z.number().int().positive(),
    branchId: z.string().min(1).max(191).nullable(),
    documentIds: z.array(z.string().min(1).max(191)).min(1).max(500),
    sourceKind: z.string().min(1).max(100).nullable(),
    ownership: z.enum(["first_party", "third_party", "unknown"]).nullable(),
    assetType: z.string().min(1).max(100).nullable(),
    displayRole: z.string().min(1).max(100).nullable(),
    sourcePageUrl: z.string().nullable(),
    sourceAssetUrl: z.string().nullable(),
    sourceDocumentPath: z.string().nullable(),
    sourceUploadIndex: z.number().int().nonnegative().nullable(),
    sourceUploadFileId: z.string().nullable(),
    sourceUploadSha256: z.string().nullable(),
    sourceUploadFilename: z.string().nullable(),
    sourceUploadMimeType: z.string().nullable(),
    sourceUploadSizeBytes: z.number().int().positive().nullable(),
  })
  .strict();

export const packageProjectionV1Schema = z
  .object({
    kind: z.literal("frontmind.knowledge-package-projection"),
    schemaVersion: z.literal(1),
    buildId: z.string().regex(BUILD_ID_PATTERN),
    generation: z.number().int().positive(),
    archiveSha256: z.string().regex(SHA256_PATTERN),
    packageSchemaVersion: z.literal(4),
    documents: z.array(projectionDocumentSchema).min(1).max(1_500),
    assets: z.array(projectionAssetSchema).max(480),
    statistics: z
      .object({
        formalCharacters: z.number().int().nonnegative(),
        evidenceCharacters: z.number().int().nonnegative(),
        imageCount: z.number().int().nonnegative(),
      })
      .strict(),
    semanticFingerprint: z.string().regex(SHA256_PATTERN),
  })
  .strict();

export type PackageProjectionV1 = z.infer<typeof packageProjectionV1Schema>;

export type ValidatedArchive = {
  documents: KnowledgeDocument[];
  assets: KnowledgeAsset[];
  validationProfile?: string;
  packageSchemaVersion?: number;
};

type PackageManifest = {
  schemaVersion: number;
  profile: string;
  documents: Array<{
    id: string;
    path: string;
    kind?: PackageProjectionV1["documents"][number]["kind"];
    title: string;
    branchId?: string;
    branchTitle?: string;
    order?: number;
    sourceIds?: string[];
    assetIds?: string[];
    evidenceDocumentIds?: string[];
    customerVisible: boolean;
  }>;
  assets: Array<Record<string, unknown> & { id: string; path: string }>;
  counts: {
    customerVisibleCharacters: number;
    evidenceCharacters: number;
    packagedImages: number;
  };
};

function sha256(value: Buffer | string) {
  return createHash("sha256").update(value).digest("hex");
}

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

function sortedUnique(values: unknown) {
  return Array.isArray(values)
    ? [
        ...new Set(
          values.filter((value): value is string => typeof value === "string"),
        ),
      ].sort()
    : [];
}

function projectionRoot() {
  return path.resolve(
    process.env.FRONTMIND_DASHBOARD_ASSET_DIR ||
      path.join(process.cwd(), ".frontmind-dashboard-assets"),
  );
}

function assertProjectionIdentity(input: {
  buildId: string;
  generation: number;
  archiveSha256: string;
}) {
  if (
    !BUILD_ID_PATTERN.test(input.buildId) ||
    !Number.isSafeInteger(input.generation) ||
    input.generation < 1 ||
    !SHA256_PATTERN.test(input.archiveSha256)
  ) {
    throw new Error("PACKAGE_PROJECTION_IDENTITY_INVALID");
  }
}

export function packageProjectionStorageKey(input: {
  buildId: string;
  generation: number;
  archiveSha256: string;
}) {
  assertProjectionIdentity(input);
  return path.join(
    "knowledge-projections",
    input.buildId,
    `generation-${input.generation}`,
    `${input.archiveSha256}.json`,
  );
}

function projectionAbsolutePath(input: {
  buildId: string;
  generation: number;
  archiveSha256: string;
}) {
  const root = projectionRoot();
  const absolute = path.resolve(root, packageProjectionStorageKey(input));
  if (!absolute.startsWith(`${root}${path.sep}`)) {
    throw new Error("PACKAGE_PROJECTION_PATH_INVALID");
  }
  return absolute;
}

async function readManifest(archiveBytes: Buffer) {
  const zip = await JSZip.loadAsync(archiveBytes, { checkCRC32: true });
  const manifestEntries = Object.values(zip.files).filter(
    (entry) => !entry.dir && entry.name.endsWith("/00_package_manifest.json"),
  );
  if (manifestEntries.length !== 1) {
    throw new Error("PACKAGE_PROJECTION_MANIFEST_AMBIGUOUS");
  }
  const manifestPath = manifestEntries[0]!.name;
  const root = manifestPath.slice(0, -"00_package_manifest.json".length);
  const manifest = JSON.parse(
    await manifestEntries[0]!.async("string"),
  ) as PackageManifest;
  return { zip, root, manifest };
}

export async function buildPackageProjectionV1(input: {
  buildId: string;
  generation: number;
  archiveBytes: Buffer;
  validatedArchive: ValidatedArchive;
}) {
  const archiveSha256 = sha256(input.archiveBytes);
  assertProjectionIdentity({
    buildId: input.buildId,
    generation: input.generation,
    archiveSha256,
  });
  if (
    input.validatedArchive.validationProfile !== "dashboard-enterprise-v1" ||
    input.validatedArchive.packageSchemaVersion !== 4
  ) {
    throw new Error("PACKAGE_PROJECTION_REQUIRES_VALIDATED_V4_ARCHIVE");
  }
  const { zip, root, manifest } = await readManifest(input.archiveBytes);
  if (
    manifest.schemaVersion !== 4 ||
    manifest.profile !== "dashboard-enterprise-v1"
  ) {
    throw new Error("PACKAGE_PROJECTION_MANIFEST_VERSION_INVALID");
  }
  const validatedDocumentById = new Map(
    input.validatedArchive.documents.map((document) => [document.id, document]),
  );
  const documents = await Promise.all(
    manifest.documents.map(async (metadata) => {
      const validated = validatedDocumentById.get(metadata.id);
      const entry = zip.file(`${root}${metadata.path}`);
      if (!validated || !entry || validated.kind !== metadata.kind) {
        throw new Error(`PACKAGE_PROJECTION_DOCUMENT_MISMATCH:${metadata.id}`);
      }
      const bodyMarkdown = (await entry.async("string"))
        .replace(/^\uFEFF/u, "")
        .replace(/\r\n?/g, "\n");
      return {
        id: metadata.id,
        kind: metadata.kind ?? "other",
        path: metadata.path,
        title: metadata.title,
        branchId: metadata.branchId ?? null,
        branchTitle: metadata.branchTitle ?? null,
        order: metadata.order ?? null,
        bodyMarkdown,
        bodySha256: knowledgeBaseMarkdownSha256(bodyMarkdown),
        sourceIds: sortedUnique(metadata.sourceIds),
        assetIds: sortedUnique(metadata.assetIds),
        evidenceDocumentIds: sortedUnique(metadata.evidenceDocumentIds),
        customerVisible: metadata.customerVisible,
      };
    }),
  );
  documents.sort(
    (left, right) =>
      (left.order ?? 10_000) - (right.order ?? 10_000) ||
      left.id.localeCompare(right.id),
  );

  const validatedAssetById = new Map(
    input.validatedArchive.assets.map((asset) => [asset.id, asset]),
  );
  const assets = manifest.assets
    .map((metadata) => {
      const validated = validatedAssetById.get(metadata.id);
      if (
        !validated ||
        validated.path.split("/").slice(1).join("/") !== metadata.path ||
        !validated.sha256 ||
        !validated.width ||
        !validated.height
      ) {
        throw new Error(`PACKAGE_PROJECTION_ASSET_MISMATCH:${metadata.id}`);
      }
      return {
        id: metadata.id,
        path: metadata.path,
        sha256: validated.sha256.toLowerCase(),
        mimeType: validated.mimeType,
        bytes: validated.size,
        width: validated.width,
        height: validated.height,
        branchId: validated.branchId ?? null,
        documentIds: sortedUnique(validated.documentIds),
        sourceKind: validated.sourceKind ?? null,
        ownership: validated.ownership ?? null,
        assetType: validated.assetType ?? null,
        displayRole: validated.displayRole ?? null,
        sourcePageUrl: validated.sourcePageUrl ?? null,
        sourceAssetUrl: validated.sourceAssetUrl ?? null,
        sourceDocumentPath: validated.sourceDocumentPath ?? null,
        sourceUploadIndex: validated.sourceUploadIndex ?? null,
        sourceUploadFileId: validated.sourceUploadFileId ?? null,
        sourceUploadSha256: validated.sourceUploadSha256 ?? null,
        sourceUploadFilename: validated.sourceUploadFilename ?? null,
        sourceUploadMimeType: validated.sourceUploadMimeType ?? null,
        sourceUploadSizeBytes: validated.sourceUploadSizeBytes ?? null,
      };
    })
    .sort((left, right) => left.id.localeCompare(right.id));
  const statistics = {
    formalCharacters: manifest.counts.customerVisibleCharacters,
    evidenceCharacters: manifest.counts.evidenceCharacters,
    imageCount: manifest.counts.packagedImages,
  };
  const semanticFingerprint = sha256(
    canonicalJson({
      documents: documents.map(
        ({ bodyMarkdown: _body, ...document }) => document,
      ),
      assets,
      statistics,
    }),
  );
  return packageProjectionV1Schema.parse({
    kind: "frontmind.knowledge-package-projection",
    schemaVersion: 1,
    buildId: input.buildId,
    generation: input.generation,
    archiveSha256,
    packageSchemaVersion: 4,
    documents,
    assets,
    statistics,
    semanticFingerprint,
  });
}

export async function persistPackageProjectionSidecar(
  projection: PackageProjectionV1,
) {
  const parsed = packageProjectionV1Schema.parse(projection);
  const absolutePath = projectionAbsolutePath(parsed);
  await mkdir(path.dirname(absolutePath), { recursive: true });
  const buffer = Buffer.from(`${canonicalJson(parsed)}\n`, "utf8");
  const installed = await installImmutableFileAtomically({
    target: absolutePath,
    buffer,
  });
  if (installed === "exists") {
    const existing = await readFile(absolutePath);
    if (!existing.equals(buffer))
      throw new Error("PACKAGE_PROJECTION_CACHE_CONFLICT");
  }
  return packageProjectionStorageKey(parsed);
}

export async function readPackageProjectionSidecar(input: {
  buildId: string;
  generation: number;
  archiveSha256: string;
}) {
  return packageProjectionV1Schema.parse(
    JSON.parse(await readFile(projectionAbsolutePath(input), "utf8")),
  );
}

export async function removePackageProjectionSidecar(input: {
  buildId: string;
  generation: number;
  archiveSha256: string;
}) {
  await unlink(projectionAbsolutePath(input)).catch(
    (error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOENT") throw error;
    },
  );
}

export function comparePackageProjections(
  authoritative: PackageProjectionV1,
  candidate: PackageProjectionV1,
) {
  const left = packageProjectionV1Schema.parse(authoritative);
  const right = packageProjectionV1Schema.parse(candidate);
  const differences: Array<{ scope: string; id: string; field: string }> = [];
  function compareRows(
    scope: "document" | "asset",
    leftRows: Array<Record<string, unknown> & { id: string }>,
    rightRows: Array<Record<string, unknown> & { id: string }>,
    ignoredFields: ReadonlySet<string> = new Set(),
  ) {
    const rightById = new Map(rightRows.map((row) => [row.id, row]));
    for (const row of leftRows) {
      const other = rightById.get(row.id);
      if (!other) {
        differences.push({ scope, id: row.id, field: "missing" });
        continue;
      }
      const fields = new Set([...Object.keys(row), ...Object.keys(other)]);
      for (const field of fields) {
        if (ignoredFields.has(field)) continue;
        if (!sameCanonical(row[field], other[field])) {
          differences.push({ scope, id: row.id, field });
        }
      }
      rightById.delete(row.id);
    }
    for (const id of rightById.keys()) {
      differences.push({ scope, id, field: "unexpected" });
    }
  }
  // `bodyMarkdown` is retained for preview rendering, but it is not a
  // semantic comparison field. The canonical body hash already normalizes
  // harmless transport differences such as CRLF and trailing whitespace.
  compareRows(
    "document",
    left.documents,
    right.documents,
    new Set(["bodyMarkdown"]),
  );
  compareRows("asset", left.assets, right.assets);
  if (!sameCanonical(left.statistics, right.statistics)) {
    differences.push({ scope: "statistics", id: "counts", field: "value" });
  }
  return {
    equivalent: differences.length === 0,
    authoritativeFingerprint: left.semanticFingerprint,
    candidateFingerprint: right.semanticFingerprint,
    differences,
  };
}

function sameCanonical(left: unknown, right: unknown) {
  return canonicalJson(left) === canonicalJson(right);
}

export function packageProjectionCoverage(projection: PackageProjectionV1) {
  const parsed = packageProjectionV1Schema.parse(projection);
  const presentKinds = new Set(
    parsed.documents.map((document) => document.kind),
  );
  const requiredKinds = [
    "leaf",
    "overview",
    "evidence",
    "report",
    "index",
  ] as const;
  return {
    complete: requiredKinds.every((kind) => presentKinds.has(kind)),
    missingKinds: requiredKinds.filter((kind) => !presentKinds.has(kind)),
  };
}

/**
 * Best-effort projection hook. It can only populate the rebuildable sidecar
 * cache and never participates in package binding or publication decisions.
 * It is enabled by default; the environment switch is an emergency kill
 * switch, not a release gate.
 */
export async function recordPackageProjectionShadow(input: {
  buildId: string;
  generation: number;
  archiveBytes: Buffer;
  validatedArchive: ValidatedArchive;
  environment?: NodeJS.ProcessEnv;
  report?: (observation: {
    ruleCode: "package_projection_recorded" | "package_projection_failed";
    coverageComplete?: boolean;
    missingKinds?: string[];
  }) => void;
}) {
  const safeReport = (
    observation: Parameters<NonNullable<typeof input.report>>[0],
  ) => {
    try {
      input.report?.(observation);
    } catch {
      // Reporting is part of the shadow path and cannot become authoritative.
    }
  };
  const environment = input.environment ?? process.env;
  const configured =
    environment.FRONTMIND_KB_PACKAGE_PROJECTION_SHADOW?.trim().toLowerCase();
  if (configured && ["0", "disabled", "false", "off"].includes(configured)) {
    return { status: "disabled" as const };
  }
  try {
    const projection = await buildPackageProjectionV1(input);
    const storageKey = await persistPackageProjectionSidecar(projection);
    const coverage = packageProjectionCoverage(projection);
    safeReport({
      ruleCode: "package_projection_recorded",
      coverageComplete: coverage.complete,
      missingKinds: coverage.missingKinds,
    });
    return { status: "recorded" as const, projection, storageKey, coverage };
  } catch {
    // Shadow evidence is privacy-safe and non-authoritative. Do not log raw
    // archive content or error messages, and never fail the provider path.
    safeReport({ ruleCode: "package_projection_failed" });
    return { status: "failed" as const };
  }
}
