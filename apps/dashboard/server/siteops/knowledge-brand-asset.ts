import { createHash } from "node:crypto";
import path from "node:path";

import JSZip from "jszip";
import sharp from "sharp";

import type { KnowledgeAssetRecord } from "../../drizzle/schema";

const MAX_BRAND_ASSET_BYTES = 8 * 1024 * 1024;
const MAX_BRAND_ASSET_DIMENSION = 8_192;
const MAX_BRAND_ASSET_PIXELS = 24_000_000;

const MIME_DESCRIPTOR = {
  "image/jpeg": {
    extension: ".jpg",
    archiveExtensions: new Set([".jpeg", ".jpg"]),
    formats: new Set(["jpeg"]),
  },
  "image/png": {
    extension: ".png",
    archiveExtensions: new Set([".png"]),
    formats: new Set(["png"]),
  },
  "image/svg+xml": {
    extension: ".svg",
    archiveExtensions: new Set([".svg"]),
    formats: new Set(["svg"]),
  },
  "image/webp": {
    extension: ".webp",
    archiveExtensions: new Set([".webp"]),
    formats: new Set(["webp"]),
  },
} as const;

export type SiteOpsAssetDecision = {
  id: string;
  sha256: string;
  decision: "publish" | "omit" | "quarantine";
};

export type TrustedSiteBrandAsset = {
  schemaVersion: 1;
  assetId: string;
  sha256: string;
  mimeType: keyof typeof MIME_DESCRIPTOR;
  publicPath: string;
  sizeBytes: number;
  width: number;
  height: number;
  bytes: Buffer;
};

export type FrozenSiteBrandAsset = Omit<TrustedSiteBrandAsset, "bytes">;

function sha256(bytes: Buffer) {
  return createHash("sha256").update(bytes).digest("hex");
}

function assertSafeStorageKey(value: string) {
  if (
    !value ||
    value !== value.trim() ||
    value !== value.normalize("NFKC") ||
    value !== path.basename(value) ||
    value.includes("\\") ||
    value.includes("\0") ||
    !/^[A-Za-z0-9][A-Za-z0-9._-]{0,190}$/u.test(value)
  ) {
    throw new Error("SITEOPS_BRAND_ASSET_STORAGE_KEY_INVALID");
  }
}

function assertSafeArchivePath(value: string) {
  if (
    !value ||
    value !== value.trim() ||
    value !== value.normalize("NFKC") ||
    value.startsWith("/") ||
    value.includes("\\") ||
    value.includes("\0") ||
    value.length > 512 ||
    value.split("/").some((segment) => segment === "" || segment === "." || segment === "..")
  ) {
    throw new Error("SITEOPS_BRAND_ASSET_ARCHIVE_PATH_INVALID");
  }
}

function isOfficialLogo(asset: KnowledgeAssetRecord) {
  return (
    asset.sourceKind === "official_logo_upload" ||
    (asset.ownership === "first_party" && /logo/iu.test(`${asset.key} ${asset.path}`))
  );
}

function assertSafeSvg(bytes: Buffer) {
  let source: string;
  try {
    source = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new Error("SITEOPS_BRAND_ASSET_SVG_INVALID");
  }
  if (
    !/<svg\b/iu.test(source) ||
    /<!DOCTYPE|<!ENTITY|<\?(?!xml\s)|<\s*(?:script|foreignObject|iframe|object|embed|image|link|style)\b/iu.test(source) ||
    /\son[a-z][a-z0-9_-]*\s*=/iu.test(source) ||
    /(?:javascript:|data:|https?:|\/\/|@import)/iu.test(source) ||
    /url\(\s*["']?(?!#)/iu.test(source)
  ) {
    throw new Error("SITEOPS_BRAND_ASSET_SVG_UNSAFE");
  }
  for (const match of source.matchAll(/\s(?:href|xlink:href)\s*=\s*["']([^"']*)["']/giu)) {
    if (!/^#[A-Za-z_][A-Za-z0-9_.:-]*$/u.test(match[1] ?? "")) {
      throw new Error("SITEOPS_BRAND_ASSET_SVG_EXTERNAL_REFERENCE");
    }
  }
}

export async function validateTrustedSiteBrandAsset(input: {
  assetId: string;
  sha256: string;
  mimeType: string;
  publicPath?: string;
  sizeBytes?: number;
  width?: number;
  height?: number;
  bytes: Buffer;
}): Promise<TrustedSiteBrandAsset> {
  const descriptor = MIME_DESCRIPTOR[input.mimeType as keyof typeof MIME_DESCRIPTOR];
  if (!descriptor) throw new Error("SITEOPS_BRAND_ASSET_MIME_INVALID");
  if (
    !input.assetId ||
    input.assetId !== input.assetId.trim() ||
    input.assetId !== input.assetId.normalize("NFKC") ||
    input.assetId.length > 191 ||
    /[\u0000-\u001f\u007f]/u.test(input.assetId)
  ) {
    throw new Error("SITEOPS_BRAND_ASSET_ID_INVALID");
  }
  if (
    !Buffer.isBuffer(input.bytes) ||
    input.bytes.length < 1 ||
    input.bytes.length > MAX_BRAND_ASSET_BYTES ||
    !/^[a-f0-9]{64}$/u.test(input.sha256) ||
    sha256(input.bytes) !== input.sha256 ||
    (input.sizeBytes !== undefined && input.sizeBytes !== input.bytes.length)
  ) {
    throw new Error("SITEOPS_BRAND_ASSET_HASH_MISMATCH");
  }
  const publicPath = input.publicPath ?? `public/brand-logo${descriptor.extension}`;
  if (publicPath !== `public/brand-logo${descriptor.extension}`) {
    throw new Error("SITEOPS_BRAND_ASSET_PUBLIC_PATH_INVALID");
  }
  if (input.mimeType === "image/svg+xml") assertSafeSvg(input.bytes);
  let metadata: Awaited<ReturnType<ReturnType<typeof sharp>["metadata"]>>;
  try {
    metadata = await sharp(input.bytes, {
      animated: false,
      failOn: "warning",
      limitInputPixels: MAX_BRAND_ASSET_PIXELS,
    }).metadata();
  } catch {
    throw new Error("SITEOPS_BRAND_ASSET_DECODE_INVALID");
  }
  const width = metadata.width ?? 0;
  const height = metadata.height ?? 0;
  if (
    !descriptor.formats.has(metadata.format as never) ||
    !Number.isInteger(width) ||
    !Number.isInteger(height) ||
    width < 1 ||
    height < 1 ||
    width > MAX_BRAND_ASSET_DIMENSION ||
    height > MAX_BRAND_ASSET_DIMENSION ||
    width * height > MAX_BRAND_ASSET_PIXELS ||
    (metadata.pages ?? 1) !== 1 ||
    (input.width !== undefined && input.width !== width) ||
    (input.height !== undefined && input.height !== height)
  ) {
    throw new Error("SITEOPS_BRAND_ASSET_DIMENSIONS_INVALID");
  }
  return {
    schemaVersion: 1,
    assetId: input.assetId,
    sha256: input.sha256,
    mimeType: input.mimeType as keyof typeof MIME_DESCRIPTOR,
    publicPath,
    sizeBytes: input.bytes.length,
    width,
    height,
    bytes: input.bytes,
  };
}

export async function readSelectedOfficialLogoFromKnowledgeArchive(input: {
  archiveBytes: Buffer;
  assets: readonly KnowledgeAssetRecord[];
  decisions: readonly SiteOpsAssetDecision[];
}): Promise<TrustedSiteBrandAsset | null> {
  const published = input.decisions.filter((decision) => decision.decision === "publish");
  if (published.length === 0) return null;
  if (published.length !== 1) {
    throw new Error("SITEOPS_BRAND_ASSET_PUBLISH_COUNT_INVALID");
  }
  const decision = published[0]!;
  const matches = input.assets.filter((asset) => asset.id === decision.id);
  if (matches.length !== 1) throw new Error("SITEOPS_BRAND_ASSET_RECORD_INVALID");
  const asset = matches[0]!;
  if (
    !isOfficialLogo(asset) ||
    !asset.sha256 ||
    asset.sha256.toLowerCase() !== decision.sha256
  ) {
    throw new Error("SITEOPS_BRAND_ASSET_DECISION_MISMATCH");
  }
  assertSafeStorageKey(asset.key);
  assertSafeArchivePath(asset.path);
  const descriptor = MIME_DESCRIPTOR[asset.mimeType as keyof typeof MIME_DESCRIPTOR];
  if (
    !descriptor ||
    !descriptor.archiveExtensions.has(path.posix.extname(asset.path).toLowerCase() as never)
  ) {
    throw new Error("SITEOPS_BRAND_ASSET_EXTENSION_MISMATCH");
  }
  let archive: JSZip;
  try {
    archive = await JSZip.loadAsync(input.archiveBytes, { checkCRC32: true });
  } catch {
    throw new Error("SITEOPS_BRAND_ASSET_ARCHIVE_INVALID");
  }
  const entry = archive.file(asset.path);
  const unsafeOriginalName = entry
    ? (entry as typeof entry & { unsafeOriginalName?: string }).unsafeOriginalName
    : undefined;
  if (!entry || (unsafeOriginalName && unsafeOriginalName !== asset.path)) {
    throw new Error("SITEOPS_BRAND_ASSET_ARCHIVE_ENTRY_MISMATCH");
  }
  const declaredBytes = Number(
    (entry as typeof entry & { _data?: { uncompressedSize?: number } })._data
      ?.uncompressedSize ?? 0,
  );
  if (declaredBytes < 1 || declaredBytes > MAX_BRAND_ASSET_BYTES) {
    throw new Error("SITEOPS_BRAND_ASSET_SIZE_INVALID");
  }
  const bytes = await entry.async("nodebuffer");
  if (asset.size !== bytes.length) {
    throw new Error("SITEOPS_BRAND_ASSET_SIZE_INVALID");
  }
  return validateTrustedSiteBrandAsset({
    assetId: decision.id,
    sha256: decision.sha256,
    mimeType: asset.mimeType,
    sizeBytes: asset.size,
    width: asset.width,
    height: asset.height,
    bytes,
  });
}

export function freezeSiteBrandAsset(
  asset: TrustedSiteBrandAsset | null,
): FrozenSiteBrandAsset | null {
  if (!asset) return null;
  const { bytes: _bytes, ...frozen } = asset;
  return frozen;
}
