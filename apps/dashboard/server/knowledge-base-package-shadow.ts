import { createHash } from "node:crypto";
import { mkdir, readFile, unlink } from "node:fs/promises";
import path from "node:path";

import JSZip from "jszip";

import { installImmutableFileAtomically } from "./atomic-immutable-file";
import {
  canonicalApprovedKnowledgeBaseLeafMarkdown,
  canonicalPackagedKnowledgeBaseLeafMarkdown,
  knowledgeBaseMarkdownSha256,
} from "./knowledge-base-package-validation";
import {
  buildPackageProjectionV1,
  comparePackageProjections,
  packageProjectionV1Schema,
  type PackageProjectionV1,
  type ValidatedArchive,
} from "./knowledge-package-projection";
import {
  finalizationSupplementCoverage,
  type FinalizationSupplementRecord,
} from "./knowledge-base-finalization-supplement";

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const SHA256_PATTERN = /^[a-f0-9]{64}$/u;
const FIXED_ZIP_DATE = new Date("2000-01-01T00:00:00.000Z");
const FORMAL_CONTENT_START = "<!-- FRONTMIND_FORMAL_CONTENT_START -->";
const FORMAL_CONTENT_END = "<!-- FRONTMIND_FORMAL_CONTENT_END -->";

function sha256(bytes: Buffer) {
  return createHash("sha256").update(bytes).digest("hex");
}

function serverOwnedLeafArchiveMarkdown(input: {
  packagedMarkdown: string;
  approvedMarkdown: string;
}) {
  const approved = canonicalApprovedKnowledgeBaseLeafMarkdown(
    input.approvedMarkdown,
  );
  const start = input.packagedMarkdown.indexOf(FORMAL_CONTENT_START);
  const end = input.packagedMarkdown.indexOf(FORMAL_CONTENT_END);
  if (start < 0 && end < 0) return approved;
  if (
    start < 0 ||
    end <= start ||
    input.packagedMarkdown.indexOf(
      FORMAL_CONTENT_START,
      start + FORMAL_CONTENT_START.length,
    ) >= 0 ||
    input.packagedMarkdown.indexOf(
      FORMAL_CONTENT_END,
      end + FORMAL_CONTENT_END.length,
    ) >= 0
  ) {
    throw new Error("PACKAGE_SHADOW_LEAF_MARKERS_INVALID");
  }
  return `${input.packagedMarkdown
    .slice(0, start + FORMAL_CONTENT_START.length)
    .trimEnd()}\n\n${approved}\n\n${input.packagedMarkdown.slice(end).trimStart()}`;
}

function shadowRoot() {
  return path.resolve(
    process.env.FRONTMIND_DASHBOARD_ASSET_DIR ||
      path.join(process.cwd(), ".frontmind-dashboard-assets"),
  );
}

function assertShadowIdentity(input: {
  buildId: string;
  generation: number;
  operationId: string;
  archiveSha256?: string;
}) {
  if (
    !UUID_PATTERN.test(input.buildId) ||
    !Number.isSafeInteger(input.generation) ||
    input.generation < 1 ||
    !UUID_PATTERN.test(input.operationId) ||
    (input.archiveSha256 !== undefined &&
      !SHA256_PATTERN.test(input.archiveSha256))
  ) {
    throw new Error("PACKAGE_SHADOW_IDENTITY_INVALID");
  }
}

export function knowledgePackageShadowStorageKey(input: {
  buildId: string;
  generation: number;
  operationId: string;
  archiveSha256: string;
}) {
  assertShadowIdentity(input);
  return path.join(
    "knowledge-shadows",
    input.buildId,
    `generation-${input.generation}`,
    "operations",
    input.operationId,
    `${input.archiveSha256}.zip`,
  );
}

function shadowAbsolutePath(input: {
  buildId: string;
  generation: number;
  operationId: string;
  archiveSha256: string;
}) {
  const root = shadowRoot();
  const absolute = path.resolve(root, knowledgePackageShadowStorageKey(input));
  if (!absolute.startsWith(`${root}${path.sep}`)) {
    throw new Error("PACKAGE_SHADOW_PATH_INVALID");
  }
  return absolute;
}

/**
 * Shadow A deliberately retains provider-owned supplemental documents. It
 * proves that the server can repack validated content without claiming that
 * the provider ZIP is no longer needed. Every DB leaf and Dashboard asset must
 * already be byte/semantic equivalent to the authoritative projection.
 */
export async function buildProviderSupplementedShadowArchive(input: {
  projection: PackageProjectionV1;
  providerArchiveBytes: Buffer;
  serverLeafMarkdownById: ReadonlyMap<string, string>;
  dashboardAssetBytesById: ReadonlyMap<string, Buffer>;
}) {
  const projection = packageProjectionV1Schema.parse(input.projection);
  if (sha256(input.providerArchiveBytes) !== projection.archiveSha256) {
    throw new Error("PACKAGE_SHADOW_PROVIDER_ARCHIVE_MISMATCH");
  }
  const zip = await JSZip.loadAsync(input.providerArchiveBytes, {
    checkCRC32: true,
  });
  const manifestEntries = Object.values(zip.files).filter(
    (entry) => !entry.dir && entry.name.endsWith("/00_package_manifest.json"),
  );
  if (manifestEntries.length !== 1)
    throw new Error("PACKAGE_SHADOW_MANIFEST_AMBIGUOUS");
  const manifestPath = manifestEntries[0]!.name;
  const root = manifestPath.slice(0, -"00_package_manifest.json".length);

  const missingLeafIds: string[] = [];
  for (const document of projection.documents.filter(
    (item) => item.kind === "leaf",
  )) {
    const body = input.serverLeafMarkdownById.get(document.id);
    if (body === undefined) {
      missingLeafIds.push(document.id);
      continue;
    }
    if (
      knowledgeBaseMarkdownSha256(body) !==
      knowledgeBaseMarkdownSha256(
        canonicalPackagedKnowledgeBaseLeafMarkdown(document.bodyMarkdown),
      )
    ) {
      throw new Error(`PACKAGE_SHADOW_LEAF_DIVERGED:${document.id}`);
    }
    const entryPath = `${root}${document.path}`;
    if (!zip.file(entryPath))
      throw new Error(`PACKAGE_SHADOW_LEAF_MISSING:${document.id}`);
    const archiveMarkdown = serverOwnedLeafArchiveMarkdown({
      packagedMarkdown: document.bodyMarkdown,
      approvedMarkdown: body,
    });
    if (knowledgeBaseMarkdownSha256(archiveMarkdown) !== document.bodySha256) {
      throw new Error(`PACKAGE_SHADOW_LEAF_REBUILD_DIVERGED:${document.id}`);
    }
    zip.file(entryPath, archiveMarkdown, {
      binary: false,
      date: FIXED_ZIP_DATE,
      unixPermissions: 0o100644,
    });
  }
  if (missingLeafIds.length > 0) {
    throw new Error(
      `PACKAGE_SHADOW_LEAF_INPUT_INCOMPLETE:${missingLeafIds.join(",")}`,
    );
  }

  const missingAssetIds: string[] = [];
  for (const asset of projection.assets) {
    const bytes = input.dashboardAssetBytesById.get(asset.id);
    if (!bytes) {
      missingAssetIds.push(asset.id);
      continue;
    }
    if (sha256(bytes) !== asset.sha256) {
      throw new Error(`PACKAGE_SHADOW_ASSET_DIVERGED:${asset.id}`);
    }
    const entryPath = `${root}${asset.path}`;
    if (!zip.file(entryPath))
      throw new Error(`PACKAGE_SHADOW_ASSET_MISSING:${asset.id}`);
    zip.file(entryPath, bytes, {
      binary: true,
      date: FIXED_ZIP_DATE,
      unixPermissions: 0o100644,
    });
  }
  if (missingAssetIds.length > 0) {
    throw new Error(
      `PACKAGE_SHADOW_ASSET_INPUT_INCOMPLETE:${missingAssetIds.join(",")}`,
    );
  }

  const bytes = await zip.generateAsync({
    type: "nodebuffer",
    compression: "DEFLATE",
    compressionOptions: { level: 9 },
    platform: "UNIX",
    streamFiles: false,
  });
  return {
    bytes,
    sha256: sha256(bytes),
    retainedSupplementDocumentIds: projection.documents
      .filter((document) => document.kind !== "leaf")
      .map((document) => document.id),
    authoritativeSemanticFingerprint: projection.semanticFingerprint,
  };
}

/**
 * Shadow B replaces every provider-authored supplemental document with the
 * candidate supplement contract while continuing to use the same validated
 * provider ZIP only as a non-authoritative archive skeleton. The leaf and
 * asset replacement is delegated to Shadow A first, so no model-supplied leaf
 * or image byte can accidentally become the server-side candidate authority.
 *
 * This helper intentionally does not accept or persist tenant/task/turn/hash
 * claims from the supplement. Paths, customer visibility and relationships
 * outside the narrow supplement contract remain server/projection-owned.
 */
export async function buildFinalizationSupplementShadowArchive(input: {
  projection: PackageProjectionV1;
  providerArchiveBytes: Buffer;
  serverLeafMarkdownById: ReadonlyMap<string, string>;
  dashboardAssetBytesById: ReadonlyMap<string, Buffer>;
  supplementRecords: readonly FinalizationSupplementRecord[];
}) {
  const projection = packageProjectionV1Schema.parse(input.projection);
  const coverage = finalizationSupplementCoverage(input.supplementRecords);
  if (!coverage.complete) {
    throw new Error(
      `PACKAGE_SHADOW_SUPPLEMENT_INCOMPLETE:${coverage.missingKinds.join(",")}`,
    );
  }

  const supplementalDocuments = projection.documents.filter((document) =>
    ["overview", "evidence", "report", "index"].includes(document.kind),
  );
  const documentById = new Map(
    supplementalDocuments.map((document) => [document.id, document]),
  );
  const recordById = new Map<string, FinalizationSupplementRecord>();
  for (const record of input.supplementRecords) {
    const document = documentById.get(record.id);
    if (!document) {
      throw new Error(`PACKAGE_SHADOW_SUPPLEMENT_UNEXPECTED:${record.id}`);
    }
    if (document.kind !== record.kind) {
      throw new Error(`PACKAGE_SHADOW_SUPPLEMENT_KIND_DIVERGED:${record.id}`);
    }
    if (recordById.has(record.id)) {
      throw new Error(`PACKAGE_SHADOW_SUPPLEMENT_DUPLICATED:${record.id}`);
    }
    recordById.set(record.id, record);
  }
  const missingIds = supplementalDocuments
    .filter((document) => !recordById.has(document.id))
    .map((document) => document.id);
  if (missingIds.length > 0) {
    throw new Error(
      `PACKAGE_SHADOW_SUPPLEMENT_DOCUMENTS_INCOMPLETE:${missingIds.join(",")}`,
    );
  }

  const base = await buildProviderSupplementedShadowArchive({
    projection,
    providerArchiveBytes: input.providerArchiveBytes,
    serverLeafMarkdownById: input.serverLeafMarkdownById,
    dashboardAssetBytesById: input.dashboardAssetBytesById,
  });
  const zip = await JSZip.loadAsync(base.bytes, { checkCRC32: true });
  const manifestEntries = Object.values(zip.files).filter(
    (entry) => !entry.dir && entry.name.endsWith("/00_package_manifest.json"),
  );
  if (manifestEntries.length !== 1) {
    throw new Error("PACKAGE_SHADOW_MANIFEST_AMBIGUOUS");
  }
  const manifestEntry = manifestEntries[0]!;
  const root = manifestEntry.name.slice(0, -"00_package_manifest.json".length);
  const manifest = JSON.parse(await manifestEntry.async("string")) as {
    documents?: Array<Record<string, unknown> & { id?: unknown }>;
  };
  if (!Array.isArray(manifest.documents)) {
    throw new Error("PACKAGE_SHADOW_MANIFEST_DOCUMENTS_INVALID");
  }
  const manifestDocumentById = new Map(
    manifest.documents
      .filter((document) => typeof document.id === "string")
      .map((document) => [document.id as string, document]),
  );

  for (const document of supplementalDocuments) {
    const record = recordById.get(document.id)!;
    const manifestDocument = manifestDocumentById.get(document.id);
    if (!manifestDocument) {
      throw new Error(
        `PACKAGE_SHADOW_MANIFEST_DOCUMENT_MISSING:${document.id}`,
      );
    }
    const entryPath = `${root}${document.path}`;
    if (!zip.file(entryPath)) {
      throw new Error(`PACKAGE_SHADOW_SUPPLEMENT_PATH_MISSING:${document.id}`);
    }
    zip.file(entryPath, record.bodyMarkdown, {
      binary: false,
      date: FIXED_ZIP_DATE,
      unixPermissions: 0o100644,
    });
    // Only fields carried by FINALIZATION_SUPPLEMENT.ndjson are projected
    // back into the candidate Manifest. All remaining fields are owned by the
    // server-side package projection/skeleton.
    manifestDocument.kind = record.kind;
    manifestDocument.title = record.title;
    manifestDocument.branchId = record.branchId;
    manifestDocument.sourceIds = record.sourceIds;
    manifestDocument.assetIds = record.assetIds;
    if (record.order === undefined) delete manifestDocument.order;
    else manifestDocument.order = record.order;
  }
  zip.file(manifestEntry.name, JSON.stringify(manifest), {
    binary: false,
    date: FIXED_ZIP_DATE,
    unixPermissions: 0o100644,
  });
  const bytes = await zip.generateAsync({
    type: "nodebuffer",
    compression: "DEFLATE",
    compressionOptions: { level: 9 },
    platform: "UNIX",
    streamFiles: false,
  });
  return {
    bytes,
    sha256: sha256(bytes),
    supplementDocumentIds: supplementalDocuments.map((document) => document.id),
    authoritativeSemanticFingerprint: projection.semanticFingerprint,
  };
}

/**
 * Offline/worker verification boundary for Shadow A. A rebuilt archive is not
 * evidence until the current authoritative validator accepts it and its full
 * PackageProjectionV1 is semantically equal to the provider package.
 */
export async function validateProviderSupplementedShadowArchive(input: {
  authoritativeProjection: PackageProjectionV1;
  shadowArchiveBytes: Buffer;
  validateArchive: (bytes: Buffer) => Promise<ValidatedArchive>;
}) {
  const authoritative = packageProjectionV1Schema.parse(
    input.authoritativeProjection,
  );
  const validatedArchive = await input.validateArchive(
    input.shadowArchiveBytes,
  );
  const candidateProjection = await buildPackageProjectionV1({
    buildId: authoritative.buildId,
    generation: authoritative.generation,
    archiveBytes: input.shadowArchiveBytes,
    validatedArchive,
  });
  const comparison = comparePackageProjections(
    authoritative,
    candidateProjection,
  );
  if (!comparison.equivalent) {
    throw new Error("PACKAGE_SHADOW_PROJECTION_DIVERGED");
  }
  return { candidateProjection, comparison };
}

export async function persistKnowledgePackageShadow(input: {
  buildId: string;
  generation: number;
  operationId: string;
  bytes: Buffer;
}) {
  const archiveSha256 = sha256(input.bytes);
  const identity = { ...input, archiveSha256 };
  assertShadowIdentity(identity);
  const absolute = shadowAbsolutePath(identity);
  await mkdir(path.dirname(absolute), { recursive: true });
  const result = await installImmutableFileAtomically({
    target: absolute,
    buffer: input.bytes,
  });
  if (result === "exists") {
    const existing = await readFile(absolute);
    if (!existing.equals(input.bytes))
      throw new Error("PACKAGE_SHADOW_CACHE_CONFLICT");
  }
  return {
    storageKey: knowledgePackageShadowStorageKey(identity),
    archiveSha256,
  };
}

export async function removeKnowledgePackageShadow(input: {
  buildId: string;
  generation: number;
  operationId: string;
  archiveSha256: string;
}) {
  await unlink(shadowAbsolutePath(input)).catch(
    (error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOENT") throw error;
    },
  );
}
