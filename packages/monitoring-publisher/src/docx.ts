import { Buffer } from "node:buffer";
import { inflateRaw } from "node:zlib";
import JSZip from "jszip";
import mammoth from "mammoth";
import {
  canonicalizePublisherHtml,
  publisherHtmlToPlainText,
} from "./canonical-html.js";
import { sha256Hex } from "./hash.js";
import { normalizePublisherImage, PublisherImageError } from "./image.js";
import type {
  ContentIssue,
  DocxImportReport,
  PersistedDocxImage,
  ValidatedDocx,
} from "./types.js";

export const DOCX_LIMITS = Object.freeze({
  maxBytes: 20 * 1024 * 1024,
  maxEntries: 2_000,
  maxUncompressedBytes: 100 * 1024 * 1024,
  maxEntryBytes: 25 * 1024 * 1024,
  maxCompressionRatio: 200,
  maxBodyImages: 50,
});

const DOCX_MIME =
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
const ACCEPTED_MIME_TYPES = new Set([
  DOCX_MIME,
  "application/octet-stream",
  "application/zip",
  "",
]);

export class DocxSafetyError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly httpStatus = 400,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "DocxSafetyError";
  }
}

export async function validatePublisherDocx(input: {
  bytes: Uint8Array;
  fileName: string;
  contentType?: string;
}): Promise<ValidatedDocx> {
  const fileName = safeFileName(input.fileName);
  if (!fileName.toLowerCase().endsWith(".docx")) {
    throw new DocxSafetyError(
      "invalid_extension",
      "Only .docx files are accepted",
      415,
    );
  }
  const contentType = input.contentType?.split(";", 1)[0]?.trim().toLowerCase();
  if (contentType !== undefined && !ACCEPTED_MIME_TYPES.has(contentType)) {
    throw new DocxSafetyError(
      "invalid_content_type",
      "Upload MIME type is not DOCX",
      415,
    );
  }
  if (
    input.bytes.byteLength === 0 ||
    input.bytes.byteLength > DOCX_LIMITS.maxBytes
  ) {
    throw new DocxSafetyError(
      "invalid_size",
      "DOCX must not exceed 20 MiB",
      413,
    );
  }
  if (
    input.bytes[0] !== 0x50 ||
    input.bytes[1] !== 0x4b ||
    input.bytes[2] !== 0x03 ||
    input.bytes[3] !== 0x04
  ) {
    throw new DocxSafetyError(
      "invalid_magic",
      "File is not an OOXML ZIP archive",
      415,
    );
  }
  await validateZipCentralDirectory(input.bytes);
  let zip: JSZip;
  try {
    zip = await JSZip.loadAsync(input.bytes, {
      checkCRC32: true,
      createFolders: false,
    });
  } catch (cause) {
    throw new DocxSafetyError("invalid_zip", "DOCX archive is corrupt", 422, {
      cause,
    });
  }
  validateArchiveShape(zip);
  if (zip.file("EncryptionInfo") || zip.file("EncryptedPackage")) {
    throw new DocxSafetyError(
      "encrypted_docx",
      "Encrypted DOCX is not supported",
      422,
    );
  }
  if (
    zip.file("word/vbaProject.bin") ||
    zip.file(/vbaProject\.bin$/iu).length
  ) {
    throw new DocxSafetyError(
      "macro_docx",
      "Macro-enabled DOCX is not supported",
      422,
    );
  }
  if (zip.file(/^word\/(?:embeddings|activeX)\//iu).length) {
    throw new DocxSafetyError(
      "embedded_object",
      "Embedded objects and ActiveX are not supported",
      422,
    );
  }
  const contentTypes = await requiredZipText(zip, "[Content_Types].xml");
  const documentXml = await requiredZipText(zip, "word/document.xml");
  const xmlParts = Object.values(zip.files).filter(
    (entry) => !entry.dir && /(?:\.xml|\.rels)$/iu.test(entry.name),
  );
  let externalImages = 0;
  for (const part of xmlParts) {
    const xml = await part.async("text");
    if (/<!DOCTYPE\b|<!ENTITY\b/iu.test(xml)) {
      throw new DocxSafetyError(
        "unsafe_xml",
        `${part.name} contains unsafe XML declarations`,
        422,
      );
    }
    if (/\.rels$/iu.test(part.name)) {
      externalImages += countExternalImageRelationships(xml);
    }
  }
  if (/macroEnabled/iu.test(contentTypes)) {
    throw new DocxSafetyError(
      "macro_docx",
      "Macro-enabled DOCX is not supported",
      422,
    );
  }
  if (/<w:altChunk\b/iu.test(documentXml)) {
    throw new DocxSafetyError(
      "alt_chunk",
      "DOCX contains unsafe alternative content",
      422,
    );
  }
  const blockers: ContentIssue[] = externalImages
    ? [
        {
          code: "external_image",
          message: `DOCX contains ${externalImages} external images; external image fetch is forbidden`,
          blocking: true,
          source: "validation",
        },
      ]
    : [];
  const imageCount =
    (documentXml.match(/<a:blip\b[^>]*\br:embed=["'][^"']+["'][^>]*>/giu)
      ?.length ?? 0) +
    (documentXml.match(/<v:imagedata\b[^>]*\br:id=["'][^"']+["'][^>]*>/giu)
      ?.length ?? 0);
  if (imageCount > DOCX_LIMITS.maxBodyImages) {
    throw new DocxSafetyError(
      "too_many_images",
      `DOCX body may contain at most ${DOCX_LIMITS.maxBodyImages} images`,
      413,
    );
  }
  return {
    bytes: input.bytes,
    fileName,
    sourceSha256: sha256Hex(input.bytes),
    suggestedTitle: suggestedTitle(documentXml),
    referencedBodyImageCount: imageCount,
    warnings: annotationWarnings(documentXml),
    blockingIssues: blockers,
  };
}

interface SafeZipEntry {
  name: string;
  compressionMethod: 0 | 8;
  compressedSize: number;
  uncompressedSize: number;
  dataOffset: number;
  directory: boolean;
}

/**
 * JSZip's CRC mode inflates entries while loading. Parse and verify the central
 * directory first, then inflate each stream behind an explicit output cap so
 * forged ZIP metadata cannot move decompression ahead of our bomb limits.
 */
async function validateZipCentralDirectory(bytes: Uint8Array): Promise<void> {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const eocdOffset = findEndOfCentralDirectory(view);
  if (eocdOffset < 0) {
    throw new DocxSafetyError(
      "invalid_zip_directory",
      "DOCX ZIP central directory is missing or malformed",
      422,
    );
  }
  const diskNumber = view.getUint16(eocdOffset + 4, true);
  const centralDisk = view.getUint16(eocdOffset + 6, true);
  const entriesOnDisk = view.getUint16(eocdOffset + 8, true);
  const entryCount = view.getUint16(eocdOffset + 10, true);
  const centralSize = view.getUint32(eocdOffset + 12, true);
  const centralOffset = view.getUint32(eocdOffset + 16, true);
  if (diskNumber !== 0 || centralDisk !== 0 || entriesOnDisk !== entryCount) {
    throw new DocxSafetyError(
      "multi_disk_zip",
      "Multi-disk DOCX archives are not supported",
      422,
    );
  }
  if (
    entryCount === 0xffff ||
    centralSize === 0xffffffff ||
    centralOffset === 0xffffffff
  ) {
    throw new DocxSafetyError(
      "zip64_not_supported",
      "ZIP64 DOCX archives are not supported",
      422,
    );
  }
  if (entryCount > DOCX_LIMITS.maxEntries) {
    throw new DocxSafetyError(
      "too_many_entries",
      "DOCX contains too many ZIP entries",
      413,
    );
  }
  const centralEnd = centralOffset + centralSize;
  if (
    centralOffset > eocdOffset ||
    centralEnd !== eocdOffset ||
    centralEnd > bytes.byteLength
  ) {
    throw new DocxSafetyError(
      "invalid_zip_directory",
      "DOCX ZIP central directory bounds are invalid",
      422,
    );
  }

  const entries: SafeZipEntry[] = [];
  const names = new Set<string>();
  const localOffsets = new Set<number>();
  let cursor = centralOffset;
  let totalUncompressed = 0;
  for (let index = 0; index < entryCount; index += 1) {
    if (
      cursor + 46 > centralEnd ||
      view.getUint32(cursor, true) !== 0x02014b50
    ) {
      throw new DocxSafetyError(
        "invalid_zip_directory",
        "DOCX contains an invalid central-directory entry",
        422,
      );
    }
    const flags = view.getUint16(cursor + 8, true);
    const method = view.getUint16(cursor + 10, true);
    const compressedSize = view.getUint32(cursor + 20, true);
    const uncompressedSize = view.getUint32(cursor + 24, true);
    const nameLength = view.getUint16(cursor + 28, true);
    const extraLength = view.getUint16(cursor + 30, true);
    const commentLength = view.getUint16(cursor + 32, true);
    const startingDisk = view.getUint16(cursor + 34, true);
    const localOffset = view.getUint32(cursor + 42, true);
    const recordEnd = cursor + 46 + nameLength + extraLength + commentLength;
    if (recordEnd > centralEnd || nameLength === 0) {
      throw new DocxSafetyError(
        "invalid_zip_directory",
        "DOCX contains a truncated central-directory entry",
        422,
      );
    }
    if (startingDisk !== 0 || localOffset === 0xffffffff) {
      throw new DocxSafetyError(
        "zip64_not_supported",
        "Split or ZIP64 DOCX entries are not supported",
        422,
      );
    }
    if ((flags & 0x1) !== 0) {
      throw new DocxSafetyError(
        "encrypted_docx",
        "Encrypted DOCX entries are not supported",
        422,
      );
    }
    if (method !== 0 && method !== 8) {
      throw new DocxSafetyError(
        "unsupported_zip_compression",
        "DOCX uses an unsupported ZIP compression method",
        422,
      );
    }
    const rawName = bytes.subarray(cursor + 46, cursor + 46 + nameLength);
    const name = Buffer.from(rawName).toString(
      (flags & 0x800) !== 0 ? "utf8" : "latin1",
    );
    if (name.includes("\ufffd") || unsafeArchivePath(name)) {
      throw new DocxSafetyError(
        "unsafe_archive_path",
        "DOCX contains an unsafe ZIP path",
        422,
      );
    }
    if (names.has(name) || localOffsets.has(localOffset)) {
      throw new DocxSafetyError(
        "duplicate_zip_entry",
        "DOCX contains duplicate or aliased ZIP entries",
        422,
      );
    }
    names.add(name);
    localOffsets.add(localOffset);
    if (uncompressedSize > DOCX_LIMITS.maxEntryBytes) {
      throw new DocxSafetyError(
        "entry_too_large",
        "DOCX entry exceeds safety limit",
        413,
      );
    }
    if (
      uncompressedSize > 0 &&
      (compressedSize === 0 ||
        uncompressedSize / compressedSize > DOCX_LIMITS.maxCompressionRatio)
    ) {
      throw new DocxSafetyError(
        "suspicious_compression",
        "DOCX compression ratio is unsafe",
        413,
      );
    }
    totalUncompressed += uncompressedSize;
    if (totalUncompressed > DOCX_LIMITS.maxUncompressedBytes) {
      throw new DocxSafetyError(
        "zip_bomb",
        "DOCX expanded size exceeds 100 MiB",
        413,
      );
    }

    if (
      localOffset + 30 > centralOffset ||
      view.getUint32(localOffset, true) !== 0x04034b50
    ) {
      throw new DocxSafetyError(
        "invalid_zip_local_header",
        "DOCX contains an invalid local ZIP header",
        422,
      );
    }
    const localFlags = view.getUint16(localOffset + 6, true);
    const localMethod = view.getUint16(localOffset + 8, true);
    const localNameLength = view.getUint16(localOffset + 26, true);
    const localExtraLength = view.getUint16(localOffset + 28, true);
    const localNameStart = localOffset + 30;
    const dataOffset = localNameStart + localNameLength + localExtraLength;
    const dataEnd = dataOffset + compressedSize;
    if (
      (localFlags & 0x1) !== 0 ||
      localMethod !== method ||
      dataOffset > centralOffset ||
      dataEnd > centralOffset ||
      localNameLength !== rawName.byteLength ||
      !Buffer.from(
        bytes.subarray(localNameStart, localNameStart + localNameLength),
      ).equals(Buffer.from(rawName))
    ) {
      throw new DocxSafetyError(
        "invalid_zip_local_header",
        "DOCX local and central ZIP headers do not match",
        422,
      );
    }
    entries.push({
      name,
      compressionMethod: method,
      compressedSize,
      uncompressedSize,
      dataOffset,
      directory: name.endsWith("/"),
    });
    cursor = recordEnd;
  }
  if (cursor !== centralEnd) {
    throw new DocxSafetyError(
      "invalid_zip_directory",
      "DOCX ZIP central directory contains trailing records",
      422,
    );
  }

  for (const entry of entries) {
    if (entry.directory) continue;
    const compressed = bytes.subarray(
      entry.dataOffset,
      entry.dataOffset + entry.compressedSize,
    );
    if (entry.compressionMethod === 0) {
      if (entry.compressedSize !== entry.uncompressedSize) {
        throw new DocxSafetyError(
          "invalid_zip_size",
          `DOCX entry ${entry.name} has inconsistent stored size`,
          422,
        );
      }
      continue;
    }
    let inflated: Uint8Array;
    try {
      inflated = await inflateRawBounded(
        compressed,
        Math.max(1, entry.uncompressedSize + 1),
      );
    } catch (cause) {
      throw new DocxSafetyError(
        "unsafe_deflate_stream",
        `DOCX entry ${entry.name} exceeds its declared safe size or is corrupt`,
        422,
        { cause },
      );
    }
    if (inflated.byteLength !== entry.uncompressedSize) {
      throw new DocxSafetyError(
        "invalid_zip_size",
        `DOCX entry ${entry.name} does not match its declared size`,
        422,
      );
    }
  }
}

function findEndOfCentralDirectory(view: DataView): number {
  const minimum = Math.max(0, view.byteLength - 65_535 - 22);
  for (let cursor = view.byteLength - 22; cursor >= minimum; cursor -= 1) {
    if (view.getUint32(cursor, true) !== 0x06054b50) continue;
    const commentLength = view.getUint16(cursor + 20, true);
    if (cursor + 22 + commentLength === view.byteLength) return cursor;
  }
  return -1;
}

function inflateRawBounded(
  input: Uint8Array,
  maxOutputLength: number,
): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    inflateRaw(input, { maxOutputLength }, (error, result) => {
      if (error) reject(error);
      else resolve(result);
    });
  });
}

export async function importPublisherDocx(input: {
  bytes: Uint8Array;
  fileName: string;
  contentType?: string;
  persistImage: (input: {
    ordinal: number;
    bytes: Uint8Array;
    sha256: string;
    mimeType: "image/jpeg" | "image/png";
    width: number;
    height: number;
  }) => Promise<PersistedDocxImage>;
}): Promise<DocxImportReport> {
  const validated = await validatePublisherDocx(input);
  const conversionBytes = await bodyOnlyDocx(validated.bytes);
  const warnings: ContentIssue[] = [...validated.warnings];
  const blockers: ContentIssue[] = [...validated.blockingIssues];
  const images: DocxImportReport["images"][number][] = [];
  let ordinal = 0;

  const conversion = await mammoth.convertToHtml(
    { buffer: Buffer.from(conversionBytes) },
    {
      styleMap: [
        "p[style-name='Title'] => h2:fresh",
        "p[style-name='标题'] => h2:fresh",
        "p[style-name='Heading 1'] => h2:fresh",
        "p[style-name='标题 1'] => h2:fresh",
        "p[style-name='Heading 2'] => h2:fresh",
        "p[style-name='Heading 3'] => h3:fresh",
        "p[style-name='Quote'] => blockquote:fresh",
        "u => u",
      ],
      includeDefaultStyleMap: true,
      convertImage: mammoth.images.imgElement(async (image) => {
        ordinal += 1;
        const currentOrdinal = ordinal;
        try {
          const bytes = new Uint8Array(await image.readAsArrayBuffer());
          const normalized = await normalizePublisherImage({
            bytes,
            sourceMimeType: image.contentType || "application/octet-stream",
          });
          const persisted = await input.persistImage({
            ordinal: currentOrdinal,
            bytes: normalized.bytes,
            sha256: normalized.sha256,
            mimeType: normalized.mimeType,
            width: normalized.width,
            height: normalized.height,
          });
          images.push({
            ordinal: currentOrdinal,
            ...persisted,
            sha256: normalized.sha256,
            mimeType: normalized.mimeType,
            width: normalized.width,
            height: normalized.height,
            sizeBytes: normalized.bytes.byteLength,
          });
          warnings.push(
            ...normalized.warnings.map((issue) => ({
              ...issue,
              ordinal: currentOrdinal,
              assetId: persisted.assetId,
            })),
          );
          return {
            src: persisted.src,
            alt: `Article image ${currentOrdinal}`,
            "data-asset-id": persisted.assetId,
          };
        } catch (error) {
          blockers.push({
            code:
              error instanceof PublisherImageError
                ? error.code
                : "image_import_failed",
            message: `Image ${currentOrdinal} could not be imported`,
            blocking: true,
            source: "image",
            ordinal: currentOrdinal,
          });
          return {
            src: `https://invalid.frontmind.local/unresolved-${currentOrdinal}`,
            alt: `[Image ${currentOrdinal} import failed]`,
            "data-asset-id": `unresolved-${currentOrdinal}`,
          };
        }
      }),
    },
  );

  for (const message of conversion.messages) {
    warnings.push({
      code: "docx_conversion_message",
      message: message.message.slice(0, 1_000),
      blocking: false,
      source: "conversion",
    });
  }
  if (ordinal !== validated.referencedBodyImageCount) {
    blockers.push({
      code: "image_extraction_mismatch",
      message: `DOCX references ${validated.referencedBodyImageCount} images but converter observed ${ordinal}`,
      blocking: true,
      source: "conversion",
    });
  }
  const html = removeTitleHeading(conversion.value, validated.suggestedTitle);
  const sources = new Map(
    images.map((image) => [image.assetId, [image.src]] as const),
  );
  const canonical = canonicalizePublisherHtml(html, {
    allowedAssetIds: images.map((image) => image.assetId),
    allowedImageSourcesByAssetId: sources,
  });
  warnings.push(...canonical.warnings);
  blockers.push(...canonical.blockingIssues);
  if (canonical.stats.imageCount !== images.length) {
    blockers.push({
      code: "canonical_image_mismatch",
      message:
        "Canonical article image count differs from imported image count",
      blocking: true,
      source: "sanitizer",
    });
  }
  return {
    fileName: validated.fileName,
    sourceSha256: validated.sourceSha256,
    suggestedTitle: validated.suggestedTitle,
    canonicalHtml: canonical.canonicalHtml,
    plainText: canonical.plainText,
    contentHash: canonical.contentHash,
    containsImages:
      canonical.containsImages || validated.referencedBodyImageCount > 0,
    images: images.sort((left, right) => left.ordinal - right.ordinal),
    warnings: dedupeIssues(warnings),
    blockingIssues: dedupeIssues(blockers),
    stats: canonical.stats,
  };
}

function validateArchiveShape(zip: JSZip): void {
  const entries = Object.values(zip.files);
  if (entries.length > DOCX_LIMITS.maxEntries) {
    throw new DocxSafetyError(
      "too_many_entries",
      "DOCX contains too many ZIP entries",
      413,
    );
  }
  let totalUncompressed = 0;
  for (const entry of entries) {
    const internals = entry as unknown as {
      unsafeOriginalName?: string;
      _data?: { uncompressedSize?: number; compressedSize?: number };
    };
    if (
      unsafeArchivePath(entry.name) ||
      (internals.unsafeOriginalName &&
        unsafeArchivePath(internals.unsafeOriginalName))
    ) {
      throw new DocxSafetyError(
        "unsafe_archive_path",
        "DOCX contains an unsafe ZIP path",
        422,
      );
    }
    const uncompressed = internals._data?.uncompressedSize ?? 0;
    const compressed = internals._data?.compressedSize ?? 0;
    if (uncompressed > DOCX_LIMITS.maxEntryBytes) {
      throw new DocxSafetyError(
        "entry_too_large",
        "DOCX entry exceeds safety limit",
        413,
      );
    }
    if (
      compressed > 0 &&
      uncompressed / compressed > DOCX_LIMITS.maxCompressionRatio
    ) {
      throw new DocxSafetyError(
        "suspicious_compression",
        "DOCX compression ratio is unsafe",
        413,
      );
    }
    totalUncompressed += uncompressed;
  }
  if (totalUncompressed > DOCX_LIMITS.maxUncompressedBytes) {
    throw new DocxSafetyError(
      "zip_bomb",
      "DOCX expanded size exceeds 100 MiB",
      413,
    );
  }
  if (!zip.file("[Content_Types].xml") || !zip.file("word/document.xml")) {
    throw new DocxSafetyError(
      "invalid_ooxml",
      "DOCX is missing required Word parts",
      422,
    );
  }
}

function unsafeArchivePath(value: string): boolean {
  const normalized = value.normalize("NFKC");
  const pathValue = normalized.endsWith("/")
    ? normalized.slice(0, -1)
    : normalized;
  return (
    !pathValue ||
    /\p{Cc}/u.test(normalized) ||
    normalized.includes("\\") ||
    normalized.startsWith("/") ||
    /^[a-z]:/iu.test(normalized) ||
    pathValue
      .split("/")
      .some((part) => !part || part === "." || part === "..")
  );
}

async function requiredZipText(zip: JSZip, name: string): Promise<string> {
  const file = zip.file(name);
  if (!file)
    throw new DocxSafetyError("invalid_ooxml", `DOCX is missing ${name}`, 422);
  return file.async("text");
}

function safeFileName(value: string): string {
  const normalized = value
    .normalize("NFKC")
    .replace(/[\p{Cc}/\\]/gu, "_")
    .trim();
  if (!normalized || normalized.length > 240) {
    throw new DocxSafetyError("invalid_file_name", "DOCX file name is invalid");
  }
  return normalized;
}

function countExternalImageRelationships(xml: string): number {
  const relationships = xml.match(/<Relationship\b[^>]*>/giu) ?? [];
  return relationships.filter(
    (relationship) =>
      /\bType\s*=\s*["'][^"']*\/image["']/iu.test(relationship) &&
      (/\bTargetMode\s*=/iu.test(relationship) ||
        /\bTarget\s*=\s*["'](?:https?:|\/\/)/iu.test(relationship)),
  ).length;
}

function suggestedTitle(xml: string): string {
  const paragraphs = xml.match(/<w:p\b[\s\S]*?<\/w:p>/giu) ?? [];
  for (const paragraph of paragraphs.slice(0, 20)) {
    if (
      !/<w:pStyle\b[^>]*w:val=["'](?:Title|Heading1|Heading 1|标题|标题1|标题 1)["']/iu.test(
        paragraph,
      )
    )
      continue;
    const value = [
      ...paragraph.matchAll(/<w:t(?:\s[^>]*)?>([\s\S]*?)<\/w:t>/giu),
    ]
      .map((match) => decodeXml(match[1] ?? ""))
      .join("")
      .trim();
    if (value) return value.slice(0, 200);
  }
  return "";
}

function annotationWarnings(xml: string): ContentIssue[] {
  const types = ["footnoteReference", "endnoteReference", "commentReference"];
  return types.flatMap((name) => {
    const count = xml.match(new RegExp(`<w:${name}\\b`, "giu"))?.length ?? 0;
    return count
      ? [
          {
            code: `${name.replace(/Reference$/u, "").toLowerCase()}_excluded`,
            message: `${count} ${name} annotations will not be included in the article body`,
            blocking: false,
            source: "validation" as const,
          },
        ]
      : [];
  });
}

async function bodyOnlyDocx(bytes: Uint8Array): Promise<Uint8Array> {
  const zip = await JSZip.loadAsync(bytes, {
    checkCRC32: true,
    createFolders: false,
  });
  const document = zip.file("word/document.xml");
  if (!document)
    throw new DocxSafetyError("invalid_ooxml", "DOCX body disappeared", 422);
  let xml = await document.async("text");
  for (const name of [
    "footnoteReference",
    "endnoteReference",
    "commentReference",
    "commentRangeStart",
    "commentRangeEnd",
  ]) {
    xml = xml.replace(
      new RegExp(
        `<w:${name}\\b[^>]*(?:\\/>|>[\\s\\S]*?<\\/w:${name}\\s*>)`,
        "giu",
      ),
      "",
    );
  }
  zip.file("word/document.xml", xml);
  for (const part of [
    "word/footnotes.xml",
    "word/endnotes.xml",
    "word/comments.xml",
    "word/commentsExtended.xml",
  ]) {
    zip.remove(part);
  }
  return new Uint8Array(
    await zip.generateAsync({ type: "uint8array", compression: "DEFLATE" }),
  );
}

function removeTitleHeading(html: string, title: string): string {
  if (!title) return html;
  const heading = html.match(/<h[1-3](?:\s[^>]*)?>([\s\S]*?)<\/h[1-3]>/iu);
  return heading && publisherHtmlToPlainText(heading[1] ?? "") === title
    ? html.replace(heading[0], "")
    : html;
}

function decodeXml(value: string): string {
  return value
    .replace(/&lt;/gu, "<")
    .replace(/&gt;/gu, ">")
    .replace(/&amp;/gu, "&")
    .replace(/&quot;/gu, '"')
    .replace(/&apos;/gu, "'");
}

function dedupeIssues(issues: readonly ContentIssue[]): ContentIssue[] {
  const seen = new Set<string>();
  return issues.filter((issue) => {
    const key = `${issue.code}:${issue.ordinal ?? ""}:${issue.assetId ?? ""}:${issue.message}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
