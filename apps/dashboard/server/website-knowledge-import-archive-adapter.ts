import { createHash } from "node:crypto";
import path from "node:path";

import JSZip from "jszip";
import { z } from "zod";

import {
  readKnowledgeArchive,
  removeStoredKnowledgeAssets,
} from "./dashboard-api";
import {
  decodedRasterImageDimensions,
  imageMimeByExtension,
} from "./knowledge-archive-image-validation";
import { validateKnowledgeArchiveEntryPath } from "./knowledge-archive-text-utils";

export const WEBSITE_KNOWLEDGE_IMPORT_CANONICAL_ROOT =
  "frontmind_website_knowledge_base";

const CANONICAL_ROOT_PREFIX = `${WEBSITE_KNOWLEDGE_IMPORT_CANONICAL_ROOT}/`;
const CANONICAL_ZIP_DATE = new Date(Date.UTC(1980, 0, 1, 0, 0, 0));
const MAX_ARCHIVE_BYTES = 250 * 1024 * 1024;
const MAX_ARCHIVE_ENTRIES = 2_000;
const MAX_ARCHIVE_DIRECTORY_ENTRIES = 2_000;
const MAX_UNPACKED_BYTES = 220 * 1024 * 1024;
const MAX_DOCUMENT_BYTES = 8 * 1024 * 1024;
const MAX_IMAGE_BYTES = 32 * 1024 * 1024;
const MAX_COMPRESSION_RATIO = 200;
const PACKAGE_MANIFEST_PATH = "00_package_manifest.json";
const COMPLETENESS_PATH = "00_completeness.json";
const LEGACY_STANDARD_PACKAGE_PATHS = [
  "README.md",
  "00_knowledge_tree.md",
  "00_crawl_coverage_report.md",
  "00_web_intelligence_report.md",
  "00_source_index.md",
  "09_media_assets/asset_inventory.md",
  "10_reference_assets/reference_asset_inventory.md",
  PACKAGE_MANIFEST_PATH,
  COMPLETENESS_PATH,
] as const;
const DISPLAY_EXTRACTOR_PLACEHOLDER_PATHS = [
  "README.md",
  "00_knowledge_tree.md",
  "00_crawl_coverage_report.md",
  "00_web_intelligence_report.md",
  "00_source_index.md",
  "09_media_assets/asset_inventory.md",
  "10_reference_assets/reference_asset_inventory.md",
] as const;
const IMAGE_EXTENSIONS = new Set([
  ".avif",
  ".gif",
  ".jpeg",
  ".jpg",
  ".png",
  ".webp",
]);
const DISPLAY_DOCUMENT_EXTENSIONS = new Set([".md", ".markdown", ".txt"]);
const websiteDisplayBranchByDirectory = new Map([
  ["01_company_overview", "company-identity"],
  ["02_team", "team"],
  ["03_products", "products-services"],
  ["04_technology", "core-capabilities"],
  ["05_manufacturing", "core-capabilities"],
  ["06_industries", "customers-industries"],
  ["07_service", "cooperation"],
  ["08_competitive_advantages", "why-frontmind"],
]);

const websitePackageDescriptorSchema = z
  .object({
    schemaVersion: z.union([
      z.literal(1),
      z.literal(2),
      z.literal(3),
      z.literal(4),
    ]),
    profile: z.literal("website-lead-v1"),
  })
  .passthrough();

const websiteV4DocumentSchema = z
  .object({
    id: z.string().trim().min(1).max(191),
    path: z.string().trim().min(1).max(600),
    kind: z.enum([
      "overview",
      "leaf",
      "evidence",
      "report",
      "index",
      "tree",
      "source_index",
      "readme",
    ]),
    title: z.string().trim().min(1).max(512),
    branchId: z.string().trim().min(1).max(191).optional(),
    order: z.number().int().min(0).max(10_000).optional(),
    evidenceStatus: z
      .enum([
        "verified_first_party",
        "verified_authoritative",
        "supported_third_party",
        "inferred",
        "needs_verification",
        "not_applicable",
      ])
      .optional(),
    sourceIds: z.array(z.string().trim().min(1).max(191)).max(500).optional(),
    evidenceDocumentIds: z
      .array(z.string().trim().min(1).max(191))
      .max(500)
      .optional(),
    assetIds: z.array(z.string().trim().min(1).max(191)).max(500).optional(),
    customerVisible: z.boolean(),
  })
  .passthrough();
const websiteV4DisplayDocumentSchema = websiteV4DocumentSchema.extend({
  kind: z.enum(["overview", "leaf"]),
  customerVisible: z.literal(true),
});

const publicSourceUrlSchema = z
  .string()
  .trim()
  .url()
  .max(4_000)
  .refine((value) => {
    try {
      const parsed = new URL(value);
      return (
        ["http:", "https:"].includes(parsed.protocol) &&
        !parsed.username &&
        !parsed.password
      );
    } catch {
      return false;
    }
  });

const websiteV4AssetSchema = z
  .object({
    id: z.string().trim().min(1).max(191),
    path: z.string().trim().min(1).max(600),
    sha256: z.string().regex(/^[a-f0-9]{64}$/iu),
    mimeType: z.enum([
      "image/avif",
      "image/gif",
      "image/jpeg",
      "image/png",
      "image/webp",
    ]),
    bytes: z.number().int().positive().max(MAX_IMAGE_BYTES),
    width: z.number().int().positive().max(100_000),
    height: z.number().int().positive().max(100_000),
    caption: z.string().trim().min(1).max(2_000),
    alt: z.string().trim().max(1_000).optional(),
    branchId: z.string().trim().min(1).max(191),
    documentIds: z.array(z.string().trim().min(1).max(191)).min(1).max(500),
    sourcePageUrl: publicSourceUrlSchema.optional(),
    sourceAssetUrl: publicSourceUrlSchema.optional(),
    sourceDocumentPath: z.string().trim().min(1).max(600).optional(),
    sourceKind: z
      .enum(["official_web", "official_document", "user_upload"])
      .optional(),
    ownership: z.literal("first_party"),
    assetType: z
      .enum([
        "brand_identity",
        "product_ui",
        "product_diagram",
        "case_photo",
        "team_photo",
        "environment_photo",
        "certificate_badge",
        "document_figure",
        "customer_supplied",
        "other",
      ])
      .optional(),
    displayRole: z.enum(["hero", "inline", "badge"]).optional(),
  })
  .passthrough();

const websiteV4ProjectionManifestSchema = z
  .object({
    schemaVersion: z.literal(4),
    profile: z.literal("website-lead-v1"),
    documents: z.array(z.unknown()).max(MAX_ARCHIVE_ENTRIES),
    assets: z.array(z.unknown()).max(MAX_ARCHIVE_ENTRIES).default([]),
  })
  .passthrough();

type LoadedFile = {
  path: string;
  normalizedPath: string;
  bytes: Buffer;
};

export class WebsiteKnowledgeImportArchiveError extends Error {
  readonly code = "WEBSITE_KNOWLEDGE_IMPORT_ARCHIVE_INVALID";

  constructor(message: string) {
    super(message);
    this.name = "WebsiteKnowledgeImportArchiveError";
  }
}

function invalid(message: string): never {
  throw new WebsiteKnowledgeImportArchiveError(message);
}

function normalizedPath(value: string) {
  return value.normalize("NFKC").toLowerCase();
}

const DISPLAY_EXTRACTOR_PLACEHOLDER_NORMALIZED_PATHS = new Set(
  DISPLAY_EXTRACTOR_PLACEHOLDER_PATHS.map((value) => normalizedPath(value)),
);
const EVIDENCE_NORMALIZED_PATH_PREFIX = normalizedPath("evidence/");

function fileExtension(value: string) {
  const basename = value.slice(value.lastIndexOf("/") + 1);
  const dot = basename.lastIndexOf(".");
  return dot < 0 ? "" : basename.slice(dot).toLowerCase();
}

function isIgnoredMetadataPath(value: string) {
  return (
    value.startsWith("__MACOSX/") ||
    value === ".DS_Store" ||
    value.endsWith("/.DS_Store")
  );
}

function unixPermissions(entry: JSZip.JSZipObject) {
  const value = entry.unixPermissions;
  return typeof value === "string" ? Number.parseInt(value, 8) : value;
}

function declaredSizes(entry: JSZip.JSZipObject) {
  const data = (
    entry as typeof entry & {
      _data?: { compressedSize?: number; uncompressedSize?: number };
    }
  )._data;
  return {
    compressed: Number(data?.compressedSize || 0),
    uncompressed: Number(data?.uncompressedSize || 0),
  };
}

function standardPathOccurrences(
  files: readonly LoadedFile[],
  standardPath: string,
) {
  const standard = normalizedPath(standardPath);
  return files.filter(
    (file) =>
      file.normalizedPath === standard ||
      file.normalizedPath.endsWith(`/${standard}`),
  );
}

function parentPath(value: string) {
  const slash = value.lastIndexOf("/");
  return slash < 0 ? "" : value.slice(0, slash);
}

function parseJson(bytes: Buffer, label: string) {
  try {
    return JSON.parse(
      new TextDecoder("utf-8", { fatal: true })
        .decode(bytes)
        .replace(/^\uFEFF/u, ""),
    );
  } catch {
    invalid(`${label} 不是有效 JSON`);
  }
}

function resolveManifest(files: readonly LoadedFile[]) {
  const manifestEntries = standardPathOccurrences(files, PACKAGE_MANIFEST_PATH);
  if (manifestEntries.length !== 1) {
    invalid("Website 知识库 ZIP 必须包含一份 package manifest");
  }
  const manifest = manifestEntries[0]!;
  const sourceRoot = parentPath(manifest.path);
  if (sourceRoot && sourceRoot.includes("/")) {
    invalid("Website 知识库 ZIP 的 package manifest 不在同一包根目录");
  }
  let descriptor: z.infer<typeof websitePackageDescriptorSchema>;
  try {
    descriptor = websitePackageDescriptorSchema.parse(
      parseJson(manifest.bytes, "Website package manifest"),
    );
  } catch (error) {
    if (error instanceof WebsiteKnowledgeImportArchiveError) throw error;
    invalid("Website 知识库 package manifest 合同无法识别");
  }
  return { descriptor, manifest, sourceRoot };
}

function centralDirectoryEntryCount(buffer: Buffer) {
  const minimumOffset = Math.max(0, buffer.length - 65_557);
  for (let offset = buffer.length - 22; offset >= minimumOffset; offset -= 1) {
    if (buffer.readUInt32LE(offset) !== 0x06054b50) continue;
    const commentBytes = buffer.readUInt16LE(offset + 20);
    if (offset + 22 + commentBytes !== buffer.length) continue;
    const diskNumber = buffer.readUInt16LE(offset + 4);
    const directoryDisk = buffer.readUInt16LE(offset + 6);
    const entriesOnDisk = buffer.readUInt16LE(offset + 8);
    const totalEntries = buffer.readUInt16LE(offset + 10);
    if (
      diskNumber !== 0 ||
      directoryDisk !== 0 ||
      entriesOnDisk !== totalEntries ||
      totalEntries === 0xffff
    ) {
      invalid("Website 知识库 ZIP 不支持分卷或 ZIP64 目录");
    }
    return totalEntries;
  }
  invalid("Website 知识库 ZIP 缺少有效中央目录");
}

async function loadSafeWebsiteArchive(buffer: Buffer) {
  if (
    buffer.length < 4 ||
    buffer.length > MAX_ARCHIVE_BYTES ||
    !["PK\u0003\u0004", "PK\u0005\u0006", "PK\u0007\u0008"].includes(
      buffer.subarray(0, 4).toString("binary"),
    )
  ) {
    invalid("Website 知识库不是有效且有界的 ZIP 归档");
  }
  const declaredEntryCount = centralDirectoryEntryCount(buffer);
  if (
    declaredEntryCount === 0 ||
    declaredEntryCount > MAX_ARCHIVE_ENTRIES + MAX_ARCHIVE_DIRECTORY_ENTRIES
  ) {
    invalid("Website 知识库 ZIP 文件数量超出限制");
  }

  let archive: JSZip;
  try {
    archive = await JSZip.loadAsync(buffer, { checkCRC32: true });
  } catch {
    invalid("Website 知识库 ZIP 无法解析或 CRC 校验失败");
  }

  const entries = Object.values(archive.files);
  if (entries.length !== declaredEntryCount) {
    invalid("Website 知识库 ZIP 包含重复或含糊的中央目录路径");
  }
  const fileEntryCount = entries.filter((entry) => !entry.dir).length;
  if (fileEntryCount === 0 || fileEntryCount > MAX_ARCHIVE_ENTRIES) {
    invalid("Website 知识库 ZIP 文件数量超出限制");
  }

  const seenPaths = new Set<string>();
  const files: LoadedFile[] = [];
  let unpackedBytes = 0;
  for (const entry of entries) {
    const raw = entry as typeof entry & { unsafeOriginalName?: string };
    const rawName = raw.unsafeOriginalName || entry.name;
    const candidatePath = rawName.endsWith("/")
      ? rawName.slice(0, -1)
      : rawName;
    let safePath: string;
    try {
      safePath = validateKnowledgeArchiveEntryPath(candidatePath);
    } catch {
      invalid("Website 知识库 ZIP 包含不安全的文件路径");
    }
    const loadedPath = entry.name.endsWith("/")
      ? entry.name.slice(0, -1)
      : entry.name;
    if (loadedPath !== safePath) {
      invalid("Website 知识库 ZIP 包含经过路径清理的文件名");
    }
    const pathKey = normalizedPath(safePath);
    if (seenPaths.has(pathKey)) {
      invalid("Website 知识库 ZIP 包含重复规范路径");
    }
    seenPaths.add(pathKey);

    const permissions = unixPermissions(entry);
    if (
      typeof permissions === "number" &&
      (permissions & 0o170000) === 0o120000
    ) {
      invalid("Website 知识库 ZIP 不允许包含符号链接");
    }
    if (entry.dir) continue;

    const declared = declaredSizes(entry);
    const entryLimit = IMAGE_EXTENSIONS.has(fileExtension(safePath))
      ? MAX_IMAGE_BYTES
      : MAX_DOCUMENT_BYTES;
    if (
      declared.uncompressed > entryLimit ||
      (declared.uncompressed > 1024 * 1024 &&
        declared.compressed > 0 &&
        declared.uncompressed / declared.compressed > MAX_COMPRESSION_RATIO)
    ) {
      invalid("Website 知识库 ZIP 单文件大小或压缩比超出限制");
    }
    const bytes = await entry.async("nodebuffer");
    if (bytes.length > entryLimit) {
      invalid("Website 知识库 ZIP 单文件大小超出限制");
    }
    unpackedBytes += bytes.length;
    if (unpackedBytes > MAX_UNPACKED_BYTES) {
      invalid("Website 知识库 ZIP 解压后总大小超出限制");
    }
    if (isIgnoredMetadataPath(safePath)) continue;
    files.push({ path: safePath, normalizedPath: pathKey, bytes });
  }
  if (files.length === 0) {
    invalid("Website 知识库 ZIP 不包含可导入文件");
  }
  return files;
}

function resolveLegacySourceRoot(files: readonly LoadedFile[]) {
  const manifestEntries = standardPathOccurrences(files, PACKAGE_MANIFEST_PATH);
  const completenessEntries = standardPathOccurrences(files, COMPLETENESS_PATH);
  if (manifestEntries.length !== 1 || completenessEntries.length !== 1) {
    invalid(
      "Website 知识库 ZIP 必须各包含一份 package manifest 和 completeness",
    );
  }
  const manifestRoot = parentPath(manifestEntries[0]!.path);
  const completenessRoot = parentPath(completenessEntries[0]!.path);
  if (
    manifestRoot !== completenessRoot ||
    (manifestRoot && manifestRoot.includes("/"))
  ) {
    invalid("Website 知识库 ZIP 的标准文件不在同一包根目录");
  }

  for (const standardPath of LEGACY_STANDARD_PACKAGE_PATHS) {
    const occurrences = standardPathOccurrences(files, standardPath);
    const expectedPath = manifestRoot
      ? `${manifestRoot}/${standardPath}`
      : standardPath;
    if (occurrences.length !== 1 || occurrences[0]!.path !== expectedPath) {
      invalid(`Website 知识库 ZIP 的标准文件重复或位置无效：${standardPath}`);
    }
  }
  return manifestRoot;
}

/**
 * Normalizes only the Website knowledge-import boundary. The original final
 * artifact identity remains bound to its raw bytes before this function runs;
 * the returned bytes are the sole archive consumed by the strict reader and
 * durable snapshot path.
 */
export async function canonicalizeWebsiteKnowledgeImportArchive(
  buffer: Buffer,
) {
  const files = await loadSafeWebsiteArchive(buffer);
  const manifest = resolveManifest(files);
  const sourceRoot =
    manifest.descriptor.schemaVersion === 4
      ? manifest.sourceRoot
      : resolveLegacySourceRoot(files);
  const sourcePrefix = sourceRoot ? `${sourceRoot}/` : "";
  const canonicalFiles: Array<{ path: string; bytes: Buffer }> = [];
  const seenRelativePaths = new Set<string>();
  for (const file of files) {
    if (sourcePrefix && !file.path.startsWith(sourcePrefix)) {
      invalid("Website 知识库 ZIP 在包根目录之外包含文件");
    }
    const relativePath = sourcePrefix
      ? file.path.slice(sourcePrefix.length)
      : file.path;
    let safeRelativePath: string;
    try {
      safeRelativePath = validateKnowledgeArchiveEntryPath(relativePath);
    } catch {
      invalid("Website 知识库 ZIP 包含无效的包内相对路径");
    }
    const relativeKey = normalizedPath(safeRelativePath);
    if (seenRelativePaths.has(relativeKey)) {
      invalid("Website 知识库 ZIP 归一化后包含重复路径");
    }
    seenRelativePaths.add(relativeKey);
    canonicalFiles.push({
      path: `${CANONICAL_ROOT_PREFIX}${safeRelativePath}`,
      bytes: file.bytes,
    });
  }
  canonicalFiles.sort((left, right) =>
    left.path < right.path ? -1 : left.path > right.path ? 1 : 0,
  );

  const canonical = new JSZip();
  for (const file of canonicalFiles) {
    canonical.file(file.path, file.bytes, {
      binary: true,
      createFolders: false,
      date: CANONICAL_ZIP_DATE,
      unixPermissions: 0o100644,
    });
  }
  const canonicalBuffer = await canonical.generateAsync({
    type: "nodebuffer",
    platform: "UNIX",
    compression: "DEFLATE",
    compressionOptions: { level: 9 },
    streamFiles: false,
  });
  return {
    buffer: canonicalBuffer,
    sha256: createHash("sha256").update(canonicalBuffer).digest("hex"),
    schemaVersion: manifest.descriptor.schemaVersion,
  };
}

function safeManifestRelativePath(value: string) {
  try {
    const safe = validateKnowledgeArchiveEntryPath(value);
    return safe === value && !safe.startsWith(CANONICAL_ROOT_PREFIX)
      ? safe
      : undefined;
  } catch {
    return undefined;
  }
}

function displayBranchId(value: string | undefined) {
  return value
    ? websiteDisplayBranchByDirectory.get(value) || value
    : undefined;
}

function countBy<T>(values: readonly T[], key: (value: T) => string) {
  const counts = new Map<string, number>();
  for (const value of values) {
    const entryKey = key(value);
    counts.set(entryKey, (counts.get(entryKey) || 0) + 1);
  }
  return counts;
}

/**
 * Projects a schema-v4 Website package onto the existing Dashboard snapshot
 * shape. It deliberately does not run the Website v2/v3 content validator:
 * usable overview/leaf documents survive incomplete hidden evidence and
 * individually invalid images.
 */
export async function projectWebsiteKnowledgeImportArchiveV4(input: {
  buffer: Buffer;
  snapshotId: string;
}) {
  const files = await loadSafeWebsiteArchive(input.buffer);
  const resolved = resolveManifest(files);
  let manifest: z.infer<typeof websiteV4ProjectionManifestSchema>;
  try {
    manifest = websiteV4ProjectionManifestSchema.parse(
      parseJson(resolved.manifest.bytes, "Website v4 package manifest"),
    );
  } catch (error) {
    if (error instanceof WebsiteKnowledgeImportArchiveError) throw error;
    invalid("Website 知识库 v4 package manifest 合同无法识别");
  }
  if (resolved.sourceRoot !== WEBSITE_KNOWLEDGE_IMPORT_CANONICAL_ROOT) {
    invalid("Website 知识库 v4 必须先规范化到 Dashboard 导入根目录");
  }

  const relativeFiles = new Map<string, LoadedFile>();
  for (const file of files) {
    if (!file.path.startsWith(CANONICAL_ROOT_PREFIX)) {
      invalid("Website 知识库 ZIP 在包根目录之外包含文件");
    }
    const relativePath = file.path.slice(CANONICAL_ROOT_PREFIX.length);
    relativeFiles.set(normalizedPath(relativePath), file);
  }

  const parsedDocuments = manifest.documents.flatMap((value) => {
    const parsed = websiteV4DisplayDocumentSchema.safeParse(value);
    if (!parsed.success) return [];
    const metadata = parsed.data;
    const relativePath = safeManifestRelativePath(metadata.path);
    const relativeKey = relativePath
      ? normalizedPath(relativePath)
      : undefined;
    if (
      !relativePath ||
      !relativeKey ||
      !DISPLAY_DOCUMENT_EXTENSIONS.has(
        path.posix.extname(relativePath).toLowerCase(),
      ) ||
      DISPLAY_EXTRACTOR_PLACEHOLDER_NORMALIZED_PATHS.has(relativeKey) ||
      relativeKey.startsWith(EVIDENCE_NORMALIZED_PATH_PREFIX)
    ) {
      return [];
    }
    const file = relativeFiles.get(relativeKey);
    if (!file) return [];
    try {
      const text = new TextDecoder("utf-8", { fatal: true }).decode(file.bytes);
      if (!text.trim()) return [];
    } catch {
      return [];
    }
    return [{ metadata, relativePath, file }];
  });
  const documentIdCounts = countBy(parsedDocuments, ({ metadata }) =>
    normalizedPath(metadata.id),
  );
  const documentPathCounts = countBy(parsedDocuments, ({ relativePath }) =>
    normalizedPath(relativePath),
  );
  const selectedDocuments = parsedDocuments.filter(
    ({ metadata, relativePath }) =>
      documentIdCounts.get(normalizedPath(metadata.id)) === 1 &&
      documentPathCounts.get(normalizedPath(relativePath)) === 1,
  );
  if (selectedDocuments.length === 0) {
    invalid("Website 知识库 v4 没有可安全展示的正式正文");
  }
  const selectedDocumentIds = new Set(
    selectedDocuments.map(({ metadata }) => metadata.id),
  );

  const parsedAssets = manifest.assets.flatMap((value) => {
    const parsed = websiteV4AssetSchema.safeParse(value);
    if (!parsed.success) return [];
    const metadata = parsed.data;
    const relativePath = safeManifestRelativePath(metadata.path);
    if (!relativePath) return [];
    const file = relativeFiles.get(normalizedPath(relativePath));
    const extension = path.posix.extname(relativePath).toLowerCase();
    if (
      !file ||
      imageMimeByExtension[extension] !== metadata.mimeType ||
      file.bytes.length !== metadata.bytes ||
      createHash("sha256").update(file.bytes).digest("hex") !==
        metadata.sha256.toLowerCase() ||
      !metadata.documentIds.some((id) => selectedDocumentIds.has(id))
    ) {
      return [];
    }
    return [{ metadata, relativePath, file, extension }];
  });
  const assetIdCounts = countBy(parsedAssets, ({ metadata }) =>
    normalizedPath(metadata.id),
  );
  const assetPathCounts = countBy(parsedAssets, ({ relativePath }) =>
    normalizedPath(relativePath),
  );
  const selectedAssets: typeof parsedAssets = [];
  for (const asset of parsedAssets) {
    if (
      assetIdCounts.get(normalizedPath(asset.metadata.id)) !== 1 ||
      assetPathCounts.get(normalizedPath(asset.relativePath)) !== 1
    ) {
      continue;
    }
    const dimensions = await decodedRasterImageDimensions(
      asset.extension,
      asset.file.bytes,
    );
    if (
      !dimensions ||
      dimensions.width !== asset.metadata.width ||
      dimensions.height !== asset.metadata.height
    ) {
      continue;
    }
    selectedAssets.push(asset);
  }

  const extractor = new JSZip();
  for (const placeholderPath of DISPLAY_EXTRACTOR_PLACEHOLDER_PATHS) {
    extractor.file(
      `${CANONICAL_ROOT_PREFIX}${placeholderPath}`,
      `# Website 导入辅助文件\n`,
      { createFolders: false, date: CANONICAL_ZIP_DATE },
    );
  }
  for (const document of selectedDocuments) {
    extractor.file(
      `${CANONICAL_ROOT_PREFIX}${document.relativePath}`,
      document.file.bytes,
      { binary: true, createFolders: false, date: CANONICAL_ZIP_DATE },
    );
  }
  for (const asset of selectedAssets) {
    extractor.file(
      `${CANONICAL_ROOT_PREFIX}${asset.relativePath}`,
      asset.file.bytes,
      { binary: true, createFolders: false, date: CANONICAL_ZIP_DATE },
    );
  }
  const extractorBuffer = await extractor.generateAsync({
    type: "nodebuffer",
    platform: "UNIX",
    compression: "DEFLATE",
    compressionOptions: { level: 9 },
  });
  const extracted = await readKnowledgeArchive(
    extractorBuffer,
    "website-v4-display.zip",
    input.snapshotId,
    { validationProfile: "historical" },
  );

  try {
    const extractedDocuments = new Map(
      extracted.documents.map((document) => [
        normalizedPath(document.path.slice(CANONICAL_ROOT_PREFIX.length)),
        document,
      ]),
    );
    const projectedDocuments = selectedDocuments.flatMap(
      ({ metadata, relativePath }) => {
        const document = extractedDocuments.get(normalizedPath(relativePath));
        if (!document?.content.trim()) return [];
        return [
          {
            ...document,
            id: metadata.id,
            title: metadata.title,
            kind: metadata.kind,
            branchId: displayBranchId(metadata.branchId),
            order: metadata.order,
            evidenceStatus: metadata.evidenceStatus,
            sourceIds: metadata.sourceIds || [],
            assetIds: metadata.assetIds || [],
            customerVisible: true,
          },
        ];
      },
    );
    if (projectedDocuments.length === 0) {
      invalid("Website 知识库 v4 没有可安全展示的正式正文");
    }
    const projectedDocumentIds = new Set(
      projectedDocuments.flatMap((document) =>
        document.id ? [document.id] : [],
      ),
    );
    const extractedAssets = new Map(
      extracted.assets.map((asset) => [
        normalizedPath(asset.path.slice(CANONICAL_ROOT_PREFIX.length)),
        asset,
      ]),
    );
    const projectedAssets = selectedAssets.flatMap(
      ({ metadata, relativePath }) => {
        const asset = extractedAssets.get(normalizedPath(relativePath));
        const documentIds = metadata.documentIds.filter((id) =>
          projectedDocumentIds.has(id),
        );
        if (!asset || documentIds.length === 0) return [];
        return [
          {
            ...asset,
            id: metadata.id,
            caption: metadata.caption,
            alt: metadata.alt,
            branchId: displayBranchId(metadata.branchId),
            documentIds,
            sourcePageUrl: metadata.sourcePageUrl,
            sourceAssetUrl: metadata.sourceAssetUrl,
            sourceDocumentPath: metadata.sourceDocumentPath,
            sourceKind: metadata.sourceKind,
            ownership: metadata.ownership,
            assetType: metadata.assetType,
            displayRole: metadata.displayRole,
          },
        ];
      },
    );
    const projectedAssetIds = new Set(
      projectedAssets.flatMap((asset) => (asset.id ? [asset.id] : [])),
    );
    return {
      documents: projectedDocuments.map((document) => ({
        ...document,
        assetIds: document.assetIds?.filter((id) => projectedAssetIds.has(id)),
      })),
      assets: projectedAssets,
      storedAssetKeys: extracted.storedAssetKeys,
      validationProfile: "website-lead-v1" as const,
      packageSchemaVersion: 4 as const,
      packageManifestSha256: createHash("sha256")
        .update(resolved.manifest.bytes)
        .digest("hex"),
    };
  } catch (error) {
    await removeStoredKnowledgeAssets(extracted.storedAssetKeys);
    throw error;
  }
}
