import { createHash } from "node:crypto";

const MAX_ARCHIVE_CANDIDATES = 32;
const MAX_FILE_ID_LENGTH = 255;
const MAX_FILENAME_LENGTH = 512;
const MAX_URL_LENGTH = 8_192;

export interface KnowledgeArchiveDescriptor {
  outputItemId: string;
  /** All provider projections that described this same physical file. */
  outputItemIds?: string[];
  fileId?: string;
  url?: string;
  filename: string;
  mimeType: string;
}

export function knowledgeArchiveFileIdFromUrl(value: string) {
  const match = value.match(/\/v1\/files\/([^/?#]+)(?:\/content)?(?:[?#]|$)/i);
  if (!match?.[1]) return undefined;
  try {
    return decodeURIComponent(match[1]).slice(0, MAX_FILE_ID_LENGTH);
  } catch {
    return match[1].slice(0, MAX_FILE_ID_LENGTH);
  }
}

function asObject(value: unknown) {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function descriptorFromTypedFile(
  value: unknown,
  outputItemId: string,
): KnowledgeArchiveDescriptor | null {
  const item = asObject(value);
  if (!item) return null;
  const type = String(item.type ?? "").toLowerCase();
  if (type !== "output_file" && type !== "file") return null;

  const filename = String(
    item.fileName ?? item.file_name ?? item.filename ?? item.name ?? "",
  )
    .trim()
    .slice(0, MAX_FILENAME_LENGTH);
  const mimeType = String(
    item.mimeType ?? item.mime_type ?? item.content_type ?? "",
  )
    .trim()
    .toLowerCase()
    .slice(0, 255);
  const rawFileId = String(item.file_id ?? item.fileId ?? "").trim();
  const rawUrl = String(item.file_url ?? item.fileUrl ?? item.url ?? "").trim();
  const fileId = (
    rawFileId ||
    knowledgeArchiveFileIdFromUrl(rawUrl) ||
    ""
  ).slice(0, MAX_FILE_ID_LENGTH);
  const url = rawUrl.slice(0, MAX_URL_LENGTH);
  const isZip =
    filename.toLowerCase().endsWith(".zip") ||
    mimeType.includes("application/zip") ||
    mimeType.includes("application/x-zip");
  if (!isZip || (!fileId && !url)) return null;

  return {
    outputItemId: outputItemId.slice(0, 255),
    fileId: fileId || undefined,
    url: url || undefined,
    filename: filename || "knowledge-base.zip",
    mimeType: mimeType || "application/zip",
  };
}

/**
 * Only trusts typed file records emitted directly by the task or inside an
 * assistant message. Metadata, reasoning, user messages and arbitrary nested
 * objects are deliberately outside this boundary.
 */
export function collectKnowledgeArchiveDescriptors(
  output: unknown,
): KnowledgeArchiveDescriptor[] {
  if (!Array.isArray(output)) return [];
  const descriptors: KnowledgeArchiveDescriptor[] = [];

  for (let outputIndex = 0; outputIndex < output.length; outputIndex += 1) {
    if (descriptors.length >= MAX_ARCHIVE_CANDIDATES) break;
    const item = asObject(output[outputIndex]);
    if (!item) continue;
    const role = String(item.role || "")
      .trim()
      .toLowerCase();
    const type = String(item.type || "")
      .trim()
      .toLowerCase();
    if (
      role === "user" ||
      role === "tool" ||
      role === "system" ||
      role === "developer" ||
      type.includes("reasoning") ||
      type.includes("tool") ||
      type.startsWith("input_")
    ) {
      continue;
    }
    const parentId = String(item.id || `output:${outputIndex}`).slice(0, 191);

    const topLevel =
      !role || role === "assistant"
        ? descriptorFromTypedFile(item, parentId)
        : null;
    if (topLevel) descriptors.push(topLevel);
    if (descriptors.length >= MAX_ARCHIVE_CANDIDATES) break;

    if (
      role !== "assistant" ||
      (type !== "message" && type !== "output_message") ||
      !Array.isArray(item.content)
    ) {
      continue;
    }
    for (
      let contentIndex = 0;
      contentIndex < item.content.length;
      contentIndex += 1
    ) {
      if (descriptors.length >= MAX_ARCHIVE_CANDIDATES) break;
      const descriptor = descriptorFromTypedFile(
        item.content[contentIndex],
        `${parentId}:content:${contentIndex}`,
      );
      if (descriptor) descriptors.push(descriptor);
    }
  }

  const deduplicated: KnowledgeArchiveDescriptor[] = [];
  for (const descriptor of descriptors) {
    const aliases = new Set(
      [
        descriptor.fileId,
        descriptor.url,
        descriptor.url
          ? knowledgeArchiveFileIdFromUrl(descriptor.url)
          : undefined,
      ].filter(Boolean),
    );
    const existingIndex = deduplicated.findIndex((candidate) =>
      [
        candidate.fileId,
        candidate.url,
        candidate.url
          ? knowledgeArchiveFileIdFromUrl(candidate.url)
          : undefined,
      ]
        .filter(Boolean)
        .some((alias) => aliases.has(alias)),
    );
    if (existingIndex < 0) {
      deduplicated.push(descriptor);
      continue;
    }
    const existing = deduplicated[existingIndex]!;
    deduplicated[existingIndex] = {
      ...existing,
      outputItemIds: [
        ...new Set([
          ...(existing.outputItemIds || [existing.outputItemId]),
          ...(descriptor.outputItemIds || [descriptor.outputItemId]),
        ]),
      ],
      ...(descriptor.fileId ? { fileId: descriptor.fileId } : {}),
      ...(descriptor.url ? { url: descriptor.url } : {}),
    };
  }
  return deduplicated;
}

export function knowledgeArchiveDescriptorHash(
  descriptor: KnowledgeArchiveDescriptor,
) {
  return createHash("sha256")
    .update(
      JSON.stringify({
        outputItemId: descriptor.outputItemId,
        fileId: descriptor.fileId || null,
        urlHash: descriptor.fileId
          ? null
          : createHash("sha256")
              .update(descriptor.url || "")
              .digest("hex"),
        filename: descriptor.filename,
        mimeType: descriptor.mimeType,
      }),
    )
    .digest("hex");
}

function canonicalPhysicalArchiveUrl(value: string) {
  try {
    const parsed = new URL(value);
    parsed.search = "";
    parsed.hash = "";
    return parsed.toString();
  } catch {
    return String(value || "").split(/[?#]/u, 1)[0] || "";
  }
}

/**
 * Stable v4 physical identity. Provider output item IDs, nesting/projection
 * order and signed URL query parameters are transport details, not file
 * identity. The immutable byte digest is bound separately below.
 */
export function knowledgeArchivePhysicalDescriptorHash(
  descriptor: KnowledgeArchiveDescriptor,
) {
  return createHash("sha256")
    .update(
      JSON.stringify({
        fileId: descriptor.fileId || null,
        canonicalUrl: descriptor.fileId
          ? null
          : canonicalPhysicalArchiveUrl(descriptor.url || ""),
        filename: descriptor.filename.normalize("NFKC").trim().toLowerCase(),
        mimeType: descriptor.mimeType.trim().toLowerCase(),
      }),
      "utf8",
    )
    .digest("hex");
}

export function knowledgeArchiveBoundDescriptorHash(
  descriptor: KnowledgeArchiveDescriptor,
  artifactSha256: string,
) {
  if (!/^[a-f0-9]{64}$/iu.test(artifactSha256)) {
    throw new Error("知识库 ZIP 字节哈希无效");
  }
  return createHash("sha256")
    .update(
      JSON.stringify({
        physicalDescriptorHash:
          knowledgeArchivePhysicalDescriptorHash(descriptor),
        artifactSha256: artifactSha256.toLowerCase(),
      }),
      "utf8",
    )
    .digest("hex");
}
