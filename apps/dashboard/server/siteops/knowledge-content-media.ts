import { createHash } from "node:crypto";
import path from "node:path";

import JSZip, { type JSZipObject } from "jszip";
import sharp from "sharp";

import type { KnowledgeAssetRecord } from "../../drizzle/schema";
import { customerSafeKnowledgeAssetLabel } from "../../shared/knowledge-base-public-artifacts";
import { KNOWLEDGE_BASE_WORKING_SET_POLICY } from "../../shared/knowledge-base-working-set-policy";

export const SITEOPS_KNOWLEDGE_MEDIA_MAX_ITEMS = 100;
export const SITEOPS_KNOWLEDGE_MEDIA_MAX_ITEM_BYTES = 8 * 1024 * 1024;
export const SITEOPS_KNOWLEDGE_MEDIA_MAX_TOTAL_BYTES = 64 * 1024 * 1024;

const MAX_IMAGE_DIMENSION = 8_192;
const MAX_IMAGE_PIXELS = 24_000_000;
const MAX_SOURCE_ARCHIVE_BYTES = 24 * 1024 * 1024;
const MAX_SOURCE_FILES = 512;
const MAX_SOURCE_FILE_BYTES = 8 * 1024 * 1024;
const MAX_SOURCE_EXPANDED_BYTES = 48 * 1024 * 1024;
const FIXED_ZIP_DATE = new Date("2000-01-01T00:00:00.000Z");

const MEDIA_DESCRIPTOR = {
  "image/jpeg": {
    publicExtension: "jpg",
    archiveExtensions: new Set([".jpeg", ".jpg"]),
    sharpFormat: "jpeg",
  },
  "image/png": {
    publicExtension: "png",
    archiveExtensions: new Set([".png"]),
    sharpFormat: "png",
  },
  "image/webp": {
    publicExtension: "webp",
    archiveExtensions: new Set([".webp"]),
    sharpFormat: "webp",
  },
} as const;

export type SiteOpsKnowledgeMediaErrorCode =
  | "SITEOPS_KNOWLEDGE_MEDIA_ARCHIVE_INVALID"
  | "SITEOPS_KNOWLEDGE_MEDIA_ARCHIVE_PATH_INVALID"
  | "SITEOPS_KNOWLEDGE_MEDIA_DECODE_INVALID"
  | "SITEOPS_KNOWLEDGE_MEDIA_DIMENSIONS_INVALID"
  | "SITEOPS_KNOWLEDGE_MEDIA_HASH_MISMATCH"
  | "SITEOPS_KNOWLEDGE_MEDIA_MIME_INVALID"
  | "SITEOPS_KNOWLEDGE_MEDIA_OWNERSHIP_INVALID"
  | "SITEOPS_KNOWLEDGE_MEDIA_RECORD_INVALID"
  | "SITEOPS_KNOWLEDGE_MEDIA_SELECTION_INVALID"
  | "SITEOPS_KNOWLEDGE_MEDIA_SIZE_INVALID"
  | "SITEOPS_KNOWLEDGE_MEDIA_SOURCE_ARCHIVE_INVALID"
  | "SITEOPS_KNOWLEDGE_MEDIA_SOURCE_LIMIT_EXCEEDED"
  | "SITEOPS_KNOWLEDGE_MEDIA_TARGET_COLLISION";

export class SiteOpsKnowledgeMediaError extends Error {
  constructor(readonly code: SiteOpsKnowledgeMediaErrorCode) {
    super(code);
    this.name = "SiteOpsKnowledgeMediaError";
  }
}

export type TrustedSiteKnowledgeMedia = Readonly<{
  schemaVersion: 1;
  assetId: string;
  sourceArchivePath: string;
  sha256: string;
  mimeType: keyof typeof MEDIA_DESCRIPTOR;
  publicPath: string;
  sizeBytes: number;
  width: number;
  height: number;
  alt: string;
  bytes: Buffer;
}>;

export type FrozenSiteKnowledgeMedia = Omit<TrustedSiteKnowledgeMedia, "bytes">;

type UnsafeZipObject = JSZipObject & {
  unsafeOriginalName?: string;
  unixPermissions?: number | string | null;
  _data?: { compressedSize?: number; uncompressedSize?: number };
};

function fail(code: SiteOpsKnowledgeMediaErrorCode): never {
  throw new SiteOpsKnowledgeMediaError(code);
}

function sha256(bytes: Buffer) {
  return createHash("sha256").update(bytes).digest("hex");
}

function safeId(value: string) {
  if (
    !value ||
    value !== value.trim() ||
    value !== value.normalize("NFKC") ||
    value.length > 191 ||
    /[\u0000-\u001f\u007f]/u.test(value)
  ) {
    fail("SITEOPS_KNOWLEDGE_MEDIA_RECORD_INVALID");
  }
  return value;
}

function safeArchivePath(
  value: string,
  limits: { maxBytes: number; maxDepth: number },
) {
  if (
    !value ||
    value !== value.trim() ||
    value !== value.normalize("NFKC") ||
    value.startsWith("/") ||
    /^[a-z]:/iu.test(value) ||
    value.includes("\\") ||
    value.includes("\0")
  ) {
    fail("SITEOPS_KNOWLEDGE_MEDIA_ARCHIVE_PATH_INVALID");
  }
  const parts = value.split("/");
  if (
    parts.some((part) => !part || part === "." || part === "..") ||
    parts.length > limits.maxDepth ||
    Buffer.byteLength(value, "utf8") > limits.maxBytes
  ) {
    fail("SITEOPS_KNOWLEDGE_MEDIA_ARCHIVE_PATH_INVALID");
  }
  return value;
}

function unixMode(entry: UnsafeZipObject) {
  return typeof entry.unixPermissions === "string"
    ? Number.parseInt(entry.unixPermissions, 8)
    : entry.unixPermissions;
}

function assertUniqueCentralDirectoryNames(bytes: Buffer) {
  const searchStart = Math.max(0, bytes.length - 65_557);
  let endOffset = -1;
  for (let offset = bytes.length - 22; offset >= searchStart; offset -= 1) {
    if (
      bytes.readUInt32LE(offset) === 0x06054b50 &&
      offset + 22 + bytes.readUInt16LE(offset + 20) === bytes.length
    ) {
      endOffset = offset;
      break;
    }
  }
  if (endOffset < 0 || endOffset + 22 > bytes.length) {
    fail("SITEOPS_KNOWLEDGE_MEDIA_ARCHIVE_INVALID");
  }
  const disk = bytes.readUInt16LE(endOffset + 4);
  const directoryDisk = bytes.readUInt16LE(endOffset + 6);
  const diskEntries = bytes.readUInt16LE(endOffset + 8);
  const totalEntries = bytes.readUInt16LE(endOffset + 10);
  const directoryBytes = bytes.readUInt32LE(endOffset + 12);
  const directoryOffset = bytes.readUInt32LE(endOffset + 16);
  if (
    disk !== 0 ||
    directoryDisk !== 0 ||
    diskEntries !== totalEntries ||
    totalEntries === 0 ||
    totalEntries === 0xffff ||
    directoryBytes === 0xffffffff ||
    directoryOffset === 0xffffffff ||
    directoryOffset + directoryBytes > endOffset
  ) {
    fail("SITEOPS_KNOWLEDGE_MEDIA_ARCHIVE_INVALID");
  }
  const names = new Set<string>();
  let cursor = directoryOffset;
  for (let index = 0; index < totalEntries; index += 1) {
    if (cursor + 46 > endOffset || bytes.readUInt32LE(cursor) !== 0x02014b50) {
      fail("SITEOPS_KNOWLEDGE_MEDIA_ARCHIVE_INVALID");
    }
    const nameLength = bytes.readUInt16LE(cursor + 28);
    const extraLength = bytes.readUInt16LE(cursor + 30);
    const commentLength = bytes.readUInt16LE(cursor + 32);
    const entryEnd = cursor + 46 + nameLength + extraLength + commentLength;
    if (!nameLength || entryEnd > endOffset) {
      fail("SITEOPS_KNOWLEDGE_MEDIA_ARCHIVE_INVALID");
    }
    const physicalName = bytes
      .subarray(cursor + 46, cursor + 46 + nameLength)
      .toString("hex");
    if (names.has(physicalName)) {
      fail("SITEOPS_KNOWLEDGE_MEDIA_ARCHIVE_INVALID");
    }
    names.add(physicalName);
    cursor = entryEnd;
  }
  if (cursor !== directoryOffset + directoryBytes) {
    fail("SITEOPS_KNOWLEDGE_MEDIA_ARCHIVE_INVALID");
  }
  return totalEntries;
}

async function loadBoundedZip(input: {
  bytes: Buffer;
  maxArchiveBytes: number;
  maxExpandedBytes: number;
  maxEntries: number;
  maxPathBytes: number;
  maxPathDepth: number;
  maxCompressionRatio: number;
  errorCode:
    | "SITEOPS_KNOWLEDGE_MEDIA_ARCHIVE_INVALID"
    | "SITEOPS_KNOWLEDGE_MEDIA_SOURCE_ARCHIVE_INVALID";
}) {
  if (
    !Buffer.isBuffer(input.bytes) ||
    input.bytes.length < 1 ||
    input.bytes.length > input.maxArchiveBytes
  ) {
    fail(input.errorCode);
  }
  let totalEntries: number;
  try {
    totalEntries = assertUniqueCentralDirectoryNames(input.bytes);
  } catch (error) {
    if (error instanceof SiteOpsKnowledgeMediaError) fail(input.errorCode);
    throw error;
  }
  if (totalEntries > input.maxEntries) fail(input.errorCode);
  let zip: JSZip;
  try {
    zip = await JSZip.loadAsync(input.bytes, {
      checkCRC32: true,
      createFolders: false,
    });
  } catch {
    fail(input.errorCode);
  }
  const entries = Object.values(zip.files) as UnsafeZipObject[];
  if (entries.length !== totalEntries || entries.length > input.maxEntries) {
    fail(input.errorCode);
  }
  let expanded = 0;
  const portablePaths = new Set<string>();
  for (const entry of entries) {
    const candidate = entry.dir ? entry.name.replace(/\/$/u, "") : entry.name;
    let pathname: string;
    try {
      pathname = safeArchivePath(candidate, {
        maxBytes: input.maxPathBytes,
        maxDepth: input.maxPathDepth,
      });
    } catch (error) {
      if (error instanceof SiteOpsKnowledgeMediaError) fail(input.errorCode);
      throw error;
    }
    if (
      (entry.unsafeOriginalName && entry.unsafeOriginalName !== entry.name) ||
      (typeof unixMode(entry) === "number" &&
        (Number(unixMode(entry)) & 0o170000) === 0o120000)
    ) {
      fail(input.errorCode);
    }
    const collisionKey = pathname.normalize("NFC").toLocaleLowerCase("en-US");
    if (portablePaths.has(collisionKey)) fail(input.errorCode);
    portablePaths.add(collisionKey);
    if (entry.dir) continue;
    const uncompressed = Number(entry._data?.uncompressedSize ?? -1);
    const compressed = Number(entry._data?.compressedSize ?? -1);
    if (
      !Number.isSafeInteger(uncompressed) ||
      uncompressed < 0 ||
      !Number.isSafeInteger(compressed) ||
      compressed < 0 ||
      (uncompressed > 0 &&
        (compressed < 1 ||
          uncompressed / compressed > input.maxCompressionRatio))
    ) {
      fail(input.errorCode);
    }
    expanded += uncompressed;
    if (expanded > input.maxExpandedBytes) fail(input.errorCode);
  }
  return zip;
}

function selectedRecords(
  assets: readonly KnowledgeAssetRecord[],
  selectedMediaIds: readonly string[],
) {
  if (
    selectedMediaIds.length > SITEOPS_KNOWLEDGE_MEDIA_MAX_ITEMS ||
    new Set(selectedMediaIds).size !== selectedMediaIds.length
  ) {
    fail("SITEOPS_KNOWLEDGE_MEDIA_SELECTION_INVALID");
  }
  const records = selectedMediaIds.map((id) => {
    safeId(id);
    const matches = assets.filter((asset) => asset.id === id);
    if (matches.length !== 1) {
      fail("SITEOPS_KNOWLEDGE_MEDIA_RECORD_INVALID");
    }
    return matches[0]!;
  });
  const selectedPaths = new Set<string>();
  let declaredTotal = 0;
  for (const asset of records) {
    const assetId = safeId(asset.id ?? "");
    const pathname = safeArchivePath(asset.path, {
      maxBytes: 512,
      maxDepth: 32,
    });
    const pathKey = pathname.normalize("NFC").toLocaleLowerCase("en-US");
    if (
      selectedPaths.has(pathKey) ||
      assets.filter(
        (candidate) =>
          candidate.path.normalize("NFC").toLocaleLowerCase("en-US") ===
          pathKey,
      ).length !== 1 ||
      assets.filter((candidate) => candidate.id === assetId).length !== 1
    ) {
      fail("SITEOPS_KNOWLEDGE_MEDIA_RECORD_INVALID");
    }
    selectedPaths.add(pathKey);
    if (
      !Number.isSafeInteger(asset.size) ||
      asset.size < 1 ||
      asset.size > SITEOPS_KNOWLEDGE_MEDIA_MAX_ITEM_BYTES
    ) {
      fail("SITEOPS_KNOWLEDGE_MEDIA_SIZE_INVALID");
    }
    declaredTotal += asset.size;
    if (declaredTotal > SITEOPS_KNOWLEDGE_MEDIA_MAX_TOTAL_BYTES) {
      fail("SITEOPS_KNOWLEDGE_MEDIA_SIZE_INVALID");
    }
  }
  return records;
}

async function validateImage(input: {
  asset: KnowledgeAssetRecord;
  bytes: Buffer;
}) {
  const descriptor =
    MEDIA_DESCRIPTOR[input.asset.mimeType as keyof typeof MEDIA_DESCRIPTOR];
  if (
    !descriptor ||
    !descriptor.archiveExtensions.has(
      path.posix.extname(input.asset.path).toLowerCase() as never,
    )
  ) {
    fail("SITEOPS_KNOWLEDGE_MEDIA_MIME_INVALID");
  }
  if (input.asset.ownership !== "first_party") {
    fail("SITEOPS_KNOWLEDGE_MEDIA_OWNERSHIP_INVALID");
  }
  if (
    input.bytes.length !== input.asset.size ||
    input.bytes.length < 1 ||
    input.bytes.length > SITEOPS_KNOWLEDGE_MEDIA_MAX_ITEM_BYTES
  ) {
    fail("SITEOPS_KNOWLEDGE_MEDIA_SIZE_INVALID");
  }
  const digest = sha256(input.bytes);
  if (
    !/^[a-f0-9]{64}$/u.test(input.asset.sha256 ?? "") ||
    digest !== input.asset.sha256
  ) {
    fail("SITEOPS_KNOWLEDGE_MEDIA_HASH_MISMATCH");
  }
  let metadata: Awaited<ReturnType<ReturnType<typeof sharp>["metadata"]>>;
  try {
    const options = {
      animated: false,
      failOn: "warning" as const,
      limitInputPixels: MAX_IMAGE_PIXELS,
      pages: 1,
      sequentialRead: true,
    };
    metadata = await sharp(input.bytes, options).metadata();
    await sharp(input.bytes, options).stats();
  } catch {
    fail("SITEOPS_KNOWLEDGE_MEDIA_DECODE_INVALID");
  }
  const width = metadata.width ?? 0;
  const height = metadata.height ?? 0;
  if (
    metadata.format !== descriptor.sharpFormat ||
    (metadata.pages ?? 1) !== 1 ||
    !Number.isInteger(width) ||
    !Number.isInteger(height) ||
    width < 1 ||
    height < 1 ||
    width > MAX_IMAGE_DIMENSION ||
    height > MAX_IMAGE_DIMENSION ||
    width * height > MAX_IMAGE_PIXELS ||
    (input.asset.width !== undefined && input.asset.width !== width) ||
    (input.asset.height !== undefined && input.asset.height !== height)
  ) {
    fail("SITEOPS_KNOWLEDGE_MEDIA_DIMENSIONS_INVALID");
  }
  return { descriptor, digest, width, height };
}

/**
 * Resolves every plan-selected knowledge image from the immutable archive.
 * Selection is all-or-nothing: unsupported, missing or drifted records abort
 * the build instead of silently dropping media chosen by the content plan.
 */
export async function freezeSelectedKnowledgeMediaFromArchive(input: {
  archiveBytes: Buffer;
  assets: readonly KnowledgeAssetRecord[];
  selectedMediaIds: readonly string[];
}): Promise<TrustedSiteKnowledgeMedia[]> {
  const records = selectedRecords(input.assets, input.selectedMediaIds);
  if (records.length === 0) return [];
  const policy = KNOWLEDGE_BASE_WORKING_SET_POLICY.archive;
  const archive = await loadBoundedZip({
    bytes: input.archiveBytes,
    maxArchiveBytes: policy.maxCompressedBytes,
    maxExpandedBytes: policy.maxUncompressedBytes,
    maxEntries: policy.maxEntryCount,
    maxPathBytes: 512,
    maxPathDepth: 32,
    maxCompressionRatio: policy.maxCompressionRatio,
    errorCode: "SITEOPS_KNOWLEDGE_MEDIA_ARCHIVE_INVALID",
  });
  const resolved: TrustedSiteKnowledgeMedia[] = [];
  const publicPaths = new Set<string>();
  let actualTotal = 0;
  for (const asset of records) {
    const entry = archive.file(asset.path) as UnsafeZipObject | null;
    if (
      !entry ||
      entry.dir ||
      (entry.unsafeOriginalName && entry.unsafeOriginalName !== asset.path)
    ) {
      fail("SITEOPS_KNOWLEDGE_MEDIA_RECORD_INVALID");
    }
    const declared = Number(entry._data?.uncompressedSize ?? -1);
    if (declared !== asset.size) fail("SITEOPS_KNOWLEDGE_MEDIA_SIZE_INVALID");
    const bytes = await entry.async("nodebuffer");
    actualTotal += bytes.length;
    if (actualTotal > SITEOPS_KNOWLEDGE_MEDIA_MAX_TOTAL_BYTES) {
      fail("SITEOPS_KNOWLEDGE_MEDIA_SIZE_INVALID");
    }
    const image = await validateImage({ asset, bytes });
    const publicPath = `/frontmind-knowledge-media/${image.digest}.${image.descriptor.publicExtension}`;
    if (publicPaths.has(publicPath)) {
      fail("SITEOPS_KNOWLEDGE_MEDIA_TARGET_COLLISION");
    }
    publicPaths.add(publicPath);
    const label =
      customerSafeKnowledgeAssetLabel(asset.alt) ??
      customerSafeKnowledgeAssetLabel(asset.caption) ??
      "知识库图片";
    const alt = Array.from(label).slice(0, 240).join("").trim();
    resolved.push({
      schemaVersion: 1,
      assetId: asset.id!,
      sourceArchivePath: asset.path,
      sha256: image.digest,
      mimeType: asset.mimeType as keyof typeof MEDIA_DESCRIPTOR,
      publicPath,
      sizeBytes: bytes.length,
      width: image.width,
      height: image.height,
      alt: alt || "知识库图片",
      bytes: Buffer.from(bytes),
    });
  }
  return resolved;
}

export function freezeSiteKnowledgeMedia(
  media: readonly TrustedSiteKnowledgeMedia[],
): FrozenSiteKnowledgeMedia[] {
  return media.map(({ bytes: _bytes, ...record }) => record);
}

function wrapperRoot(paths: readonly string[]) {
  if (paths.length === 0) return null;
  const root = paths[0]!.split("/")[0]!;
  return paths.every((pathname) => pathname.startsWith(`${root}/`))
    ? root
    : null;
}

async function assertFrozenMedia(media: readonly TrustedSiteKnowledgeMedia[]) {
  if (
    media.length > SITEOPS_KNOWLEDGE_MEDIA_MAX_ITEMS ||
    new Set(media.map((asset) => asset.assetId)).size !== media.length ||
    new Set(media.map((asset) => asset.publicPath)).size !== media.length
  ) {
    fail("SITEOPS_KNOWLEDGE_MEDIA_TARGET_COLLISION");
  }
  let total = 0;
  for (const asset of media) {
    const descriptor = MEDIA_DESCRIPTOR[asset.mimeType];
    const expectedPath = `/frontmind-knowledge-media/${asset.sha256}.${descriptor?.publicExtension ?? "invalid"}`;
    if (
      asset.schemaVersion !== 1 ||
      !descriptor ||
      safeId(asset.assetId) !== asset.assetId ||
      !/^[a-f0-9]{64}$/u.test(asset.sha256) ||
      asset.publicPath !== expectedPath ||
      asset.bytes.length !== asset.sizeBytes ||
      asset.bytes.length < 1 ||
      asset.bytes.length > SITEOPS_KNOWLEDGE_MEDIA_MAX_ITEM_BYTES ||
      sha256(asset.bytes) !== asset.sha256 ||
      !asset.alt.trim() ||
      Array.from(asset.alt).length > 240
    ) {
      fail("SITEOPS_KNOWLEDGE_MEDIA_HASH_MISMATCH");
    }
    let metadata: Awaited<ReturnType<ReturnType<typeof sharp>["metadata"]>>;
    try {
      const options = {
        animated: false,
        failOn: "warning" as const,
        limitInputPixels: MAX_IMAGE_PIXELS,
        pages: 1,
        sequentialRead: true,
      };
      metadata = await sharp(asset.bytes, options).metadata();
      await sharp(asset.bytes, options).stats();
    } catch {
      fail("SITEOPS_KNOWLEDGE_MEDIA_DECODE_INVALID");
    }
    if (
      metadata.format !== descriptor.sharpFormat ||
      (metadata.pages ?? 1) !== 1 ||
      metadata.width !== asset.width ||
      metadata.height !== asset.height ||
      asset.width < 1 ||
      asset.height < 1 ||
      asset.width > MAX_IMAGE_DIMENSION ||
      asset.height > MAX_IMAGE_DIMENSION ||
      asset.width * asset.height > MAX_IMAGE_PIXELS
    ) {
      fail("SITEOPS_KNOWLEDGE_MEDIA_DIMENSIONS_INVALID");
    }
    total += asset.bytes.length;
    if (total > SITEOPS_KNOWLEDGE_MEDIA_MAX_TOTAL_BYTES) {
      fail("SITEOPS_KNOWLEDGE_MEDIA_SIZE_INVALID");
    }
  }
}

/** Adds exact frozen bytes under public/frontmind-knowledge-media. */
export async function overlaySiteOpsKnowledgeMedia(
  sourceZip: Buffer,
  media: readonly TrustedSiteKnowledgeMedia[],
) {
  await assertFrozenMedia(media);
  const archive = await loadBoundedZip({
    bytes: sourceZip,
    maxArchiveBytes: MAX_SOURCE_ARCHIVE_BYTES,
    maxExpandedBytes: MAX_SOURCE_EXPANDED_BYTES,
    maxEntries: MAX_SOURCE_FILES,
    maxPathBytes: 240,
    maxPathDepth: 16,
    maxCompressionRatio: 200,
    errorCode: "SITEOPS_KNOWLEDGE_MEDIA_SOURCE_ARCHIVE_INVALID",
  });
  const entries = (Object.values(archive.files) as UnsafeZipObject[]).filter(
    (entry) => !entry.dir,
  );
  if (entries.length + media.length > MAX_SOURCE_FILES) {
    fail("SITEOPS_KNOWLEDGE_MEDIA_SOURCE_LIMIT_EXCEEDED");
  }
  const paths = entries.map((entry) => entry.name);
  const root = wrapperRoot(paths);
  const additions = new Map<string, Buffer>();
  const existingPaths = new Set(
    paths.map((pathname) =>
      pathname.normalize("NFC").toLocaleLowerCase("en-US"),
    ),
  );
  for (const asset of media) {
    const relative = `public${asset.publicPath}`;
    const target = root ? `${root}/${relative}` : relative;
    safeArchivePath(target, { maxBytes: 240, maxDepth: 16 });
    const collisionKey = target.normalize("NFC").toLocaleLowerCase("en-US");
    if (existingPaths.has(collisionKey) || additions.has(collisionKey)) {
      fail("SITEOPS_KNOWLEDGE_MEDIA_TARGET_COLLISION");
    }
    additions.set(collisionKey, Buffer.from(asset.bytes));
  }

  const files = new Map<string, Buffer>();
  let expanded = 0;
  for (const entry of entries) {
    const bytes = await entry.async("nodebuffer");
    if (bytes.length > MAX_SOURCE_FILE_BYTES) {
      fail("SITEOPS_KNOWLEDGE_MEDIA_SOURCE_LIMIT_EXCEEDED");
    }
    expanded += bytes.length;
    if (expanded > MAX_SOURCE_EXPANDED_BYTES) {
      fail("SITEOPS_KNOWLEDGE_MEDIA_SOURCE_LIMIT_EXCEEDED");
    }
    files.set(entry.name, bytes);
  }
  for (const asset of media) {
    const relative = `public${asset.publicPath}`;
    const target = root ? `${root}/${relative}` : relative;
    expanded += asset.bytes.length;
    if (expanded > MAX_SOURCE_EXPANDED_BYTES) {
      fail("SITEOPS_KNOWLEDGE_MEDIA_SOURCE_LIMIT_EXCEEDED");
    }
    files.set(target, Buffer.from(asset.bytes));
  }

  const output = new JSZip();
  for (const [pathname, bytes] of [...files].sort(([left], [right]) =>
    left.localeCompare(right, "en-US"),
  )) {
    output.file(pathname, bytes, {
      binary: true,
      createFolders: false,
      date: FIXED_ZIP_DATE,
      unixPermissions: 0o100644,
    });
  }
  const outputBytes = await output.generateAsync({
    type: "nodebuffer",
    compression: "DEFLATE",
    compressionOptions: { level: 9 },
    platform: "UNIX",
  });
  if (outputBytes.length > MAX_SOURCE_ARCHIVE_BYTES) {
    fail("SITEOPS_KNOWLEDGE_MEDIA_SOURCE_LIMIT_EXCEEDED");
  }

  const verified = await loadBoundedZip({
    bytes: outputBytes,
    maxArchiveBytes: MAX_SOURCE_ARCHIVE_BYTES,
    maxExpandedBytes: MAX_SOURCE_EXPANDED_BYTES,
    maxEntries: MAX_SOURCE_FILES,
    maxPathBytes: 240,
    maxPathDepth: 16,
    maxCompressionRatio: 200,
    errorCode: "SITEOPS_KNOWLEDGE_MEDIA_SOURCE_ARCHIVE_INVALID",
  });
  for (const asset of media) {
    const relative = `public${asset.publicPath}`;
    const target = root ? `${root}/${relative}` : relative;
    const bytes = await verified.file(target)?.async("nodebuffer");
    if (
      !bytes ||
      !bytes.equals(asset.bytes) ||
      sha256(bytes) !== asset.sha256
    ) {
      fail("SITEOPS_KNOWLEDGE_MEDIA_HASH_MISMATCH");
    }
  }
  return outputBytes;
}
