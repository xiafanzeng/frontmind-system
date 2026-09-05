import { createHash } from "node:crypto";

const MAX_ARCHIVE_CANDIDATES = 32;
const MAX_FILE_ID_LENGTH = 255;
const MAX_OUTPUT_ITEM_ID_LENGTH = 255;
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

export type KnowledgeBaseOutputResourceProjection = {
  outputItemId: string;
  type: string;
  fileId?: string;
  url?: string;
  filename: string;
  mimeType: string;
};

export class KnowledgeBaseFinalOutputResourceContractError extends Error {
  constructor(
    public readonly code: "MISSING" | "AMBIGUOUS" | "INVALID",
    message: string,
  ) {
    super(message);
    this.name = "KnowledgeBaseFinalOutputResourceContractError";
  }
}

export class KnowledgeBaseArtifactIdentityError extends Error {
  readonly code = "ARTIFACT_IDENTITY_INVALID";

  constructor(message: string) {
    super(message);
    this.name = "KnowledgeBaseArtifactIdentityError";
  }
}

export function assertKnowledgeBaseArtifactIdentity(input: {
  value: unknown;
  label: string;
  maxLength?: number;
  required?: boolean;
}) {
  if (input.value === undefined || input.value === null || input.value === "") {
    if (input.required) {
      throw new KnowledgeBaseArtifactIdentityError(`${input.label} 缺失`);
    }
    return undefined;
  }
  if (typeof input.value !== "string" && typeof input.value !== "number") {
    throw new KnowledgeBaseArtifactIdentityError(`${input.label} 格式无效`);
  }
  if (
    typeof input.value === "number" &&
    (!Number.isFinite(input.value) || !Number.isSafeInteger(input.value))
  ) {
    throw new KnowledgeBaseArtifactIdentityError(
      `${input.label} 数字格式无法无损表示`,
    );
  }
  const rawValue = String(input.value);
  const value = rawValue.trim();
  if (value !== rawValue) {
    throw new KnowledgeBaseArtifactIdentityError(
      `${input.label} 含首尾空白，拒绝改写后继续绑定`,
    );
  }
  if (!value) {
    if (input.required) {
      throw new KnowledgeBaseArtifactIdentityError(`${input.label} 缺失`);
    }
    return undefined;
  }
  const maxLength = input.maxLength ?? MAX_FILE_ID_LENGTH;
  if (value.length > maxLength) {
    throw new KnowledgeBaseArtifactIdentityError(
      `${input.label} 超过 ${maxLength} 个字符，拒绝截断后继续绑定`,
    );
  }
  return value;
}

export function knowledgeBaseArtifactAliasedIdentity(input: {
  value: Record<string, unknown>;
  aliases: readonly string[];
  label: string;
  maxLength?: number;
}) {
  const claims = input.aliases.flatMap((alias) => {
    if (!Object.prototype.hasOwnProperty.call(input.value, alias)) return [];
    const value = assertKnowledgeBaseArtifactIdentity({
      value: input.value[alias],
      label: input.label,
      maxLength: input.maxLength,
    });
    return value ? [value] : [];
  });
  const distinct = [...new Set(claims)];
  if (distinct.length > 1) {
    throw new KnowledgeBaseArtifactIdentityError(
      `${input.label} 的别名字段相互冲突`,
    );
  }
  return distinct[0];
}

export function knowledgeArchiveFileIdFromUrl(value: string) {
  const match = value.match(/\/v1\/files\/([^/?#]+)(?:\/content)?(?:[?#]|$)/i);
  if (!match?.[1]) return undefined;
  let fileId: string;
  try {
    fileId = decodeURIComponent(match[1]);
  } catch {
    fileId = match[1];
  }
  return assertKnowledgeBaseArtifactIdentity({
    value: fileId,
    label: "上游文件标识",
    maxLength: MAX_FILE_ID_LENGTH,
  });
}

function asObject(value: unknown) {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function knowledgeBaseParentOutputItemId(
  item: Record<string, unknown>,
  outputIndex: number,
) {
  return (
    assertKnowledgeBaseArtifactIdentity({
      value: Object.prototype.hasOwnProperty.call(item, "id")
        ? item.id
        : undefined,
      label: "上游输出项标识",
      maxLength: MAX_OUTPUT_ITEM_ID_LENGTH,
    }) ?? `output:${outputIndex}`
  );
}

function knowledgeBaseChildOutputItemId(
  parentOutputItemId: string,
  contentIndex: number,
) {
  const legacyDerivedId = `${parentOutputItemId}:content:${contentIndex}`;
  if (legacyDerivedId.length <= MAX_OUTPUT_ITEM_ID_LENGTH) {
    return legacyDerivedId;
  }
  const digest = createHash("sha256")
    .update(
      JSON.stringify({
        parentOutputItemId,
        contentIndex,
      }),
    )
    .digest("hex");
  return `content:${digest}`;
}

const TRUSTED_PROVIDER_RESOURCE_TYPES = new Set([
  "output_file",
  "file",
  "output_image",
  "image",
  "output_audio",
  "audio",
  "output_video",
  "video",
]);

function resourceProjectionFromTypedValue(
  value: unknown,
  outputItemId: () => string,
): KnowledgeBaseOutputResourceProjection | null {
  const item = asObject(value);
  if (!item) return null;
  const type = String(item.type ?? "")
    .trim()
    .toLowerCase();
  if (
    type.startsWith("input_") ||
    type.includes("reasoning") ||
    type.includes("tool")
  ) {
    return null;
  }

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
  const rawFileId = knowledgeBaseArtifactAliasedIdentity({
    value: item,
    aliases: ["file_id", "fileId"],
    label: "上游文件标识",
    maxLength: MAX_FILE_ID_LENGTH,
  });
  const rawUrl = String(
    item.file_url ??
      item.fileUrl ??
      item.image_url ??
      item.imageUrl ??
      item.audio_url ??
      item.audioUrl ??
      item.video_url ??
      item.videoUrl ??
      item.url ??
      "",
  );
  const fileIdFromUrl = rawUrl
    ? knowledgeArchiveFileIdFromUrl(rawUrl)
    : undefined;
  if (rawFileId && fileIdFromUrl && rawFileId !== fileIdFromUrl) {
    throw new KnowledgeBaseArtifactIdentityError(
      "上游文件标识与文件 URL 中的标识相互冲突",
    );
  }
  const fileId = rawFileId || fileIdFromUrl;
  const url = assertKnowledgeBaseArtifactIdentity({
    value: rawUrl,
    label: "上游文件 URL",
    maxLength: MAX_URL_LENGTH,
  });
  const isExplicitResource = TRUSTED_PROVIDER_RESOURCE_TYPES.has(type);
  const hasResourceShape = Boolean((fileId || url) && (filename || mimeType));
  if (!isExplicitResource && !hasResourceShape) return null;

  return {
    outputItemId: assertKnowledgeBaseArtifactIdentity({
      value: outputItemId(),
      label: "上游输出项标识",
      maxLength: MAX_OUTPUT_ITEM_ID_LENGTH,
      required: true,
    })!,
    type,
    fileId: fileId || undefined,
    url: url || undefined,
    filename,
    mimeType,
  };
}

function isKnowledgeBaseImageResourceProjection(value: unknown) {
  const item = asObject(value);
  if (!item) return false;
  const type = String(item.type ?? "")
    .trim()
    .toLowerCase();
  const mimeType = String(
    item.mimeType ?? item.mime_type ?? item.content_type ?? "",
  )
    .trim()
    .toLowerCase();
  return (
    type === "output_image" || type === "image" || mimeType.startsWith("image/")
  );
}

/**
 * Enumerates only provider resource projections at the same trust boundary as
 * the ZIP and image collectors: direct assistant output items and direct
 * children of assistant messages. User, tool, system and developer items are
 * never treated as model-delivered resources.
 */
export function collectKnowledgeBaseOutputResourceProjections(
  output: unknown,
  options: {
    ignoreInvalidImageProjections?: boolean;
  } = {},
): KnowledgeBaseOutputResourceProjection[] {
  if (!Array.isArray(output)) return [];
  const projections: KnowledgeBaseOutputResourceProjection[] = [];

  for (let outputIndex = 0; outputIndex < output.length; outputIndex += 1) {
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
    let resolvedParentId: string | undefined;
    const parentId = () =>
      (resolvedParentId ??= knowledgeBaseParentOutputItemId(item, outputIndex));
    let topLevel: KnowledgeBaseOutputResourceProjection | null = null;
    try {
      topLevel =
        !role || role === "assistant"
          ? resourceProjectionFromTypedValue(item, parentId)
          : null;
    } catch (error) {
      if (
        !(error instanceof KnowledgeBaseArtifactIdentityError) ||
        !options.ignoreInvalidImageProjections ||
        !isKnowledgeBaseImageResourceProjection(item)
      ) {
        throw error;
      }
    }
    if (topLevel) projections.push(topLevel);

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
      let projection: KnowledgeBaseOutputResourceProjection | null = null;
      try {
        projection = resourceProjectionFromTypedValue(
          item.content[contentIndex],
          () => knowledgeBaseChildOutputItemId(parentId(), contentIndex),
        );
      } catch (error) {
        if (
          !(error instanceof KnowledgeBaseArtifactIdentityError) ||
          !options.ignoreInvalidImageProjections ||
          !isKnowledgeBaseImageResourceProjection(item.content[contentIndex])
        ) {
          throw error;
        }
      }
      if (projection) projections.push(projection);
    }
  }
  return projections;
}

function resourceProjectionAliases(
  projection: KnowledgeBaseOutputResourceProjection,
) {
  const fileIdFromUrl = projection.url
    ? knowledgeArchiveFileIdFromUrl(projection.url)
    : undefined;
  return new Set(
    [
      projection.fileId ? `file:${projection.fileId}` : undefined,
      fileIdFromUrl ? `file:${fileIdFromUrl}` : undefined,
      projection.url
        ? `url:${canonicalPhysicalArchiveUrl(projection.url)}`
        : undefined,
    ].filter((value): value is string => Boolean(value)),
  );
}

function groupKnowledgeBaseOutputResourceProjections(
  projections: readonly KnowledgeBaseOutputResourceProjection[],
) {
  const groups: Array<{
    aliases: Set<string>;
    projections: KnowledgeBaseOutputResourceProjection[];
  }> = [];
  for (const projection of projections) {
    const aliases = resourceProjectionAliases(projection);
    const matchingIndexes = groups.flatMap((group, index) =>
      [...aliases].some((alias) => group.aliases.has(alias)) ? [index] : [],
    );
    if (matchingIndexes.length === 0) {
      groups.push({
        aliases:
          aliases.size > 0
            ? aliases
            : new Set([`projection:${projection.outputItemId}`]),
        projections: [projection],
      });
      continue;
    }
    const targetIndex = matchingIndexes[0]!;
    const target = groups[targetIndex]!;
    for (const alias of aliases) target.aliases.add(alias);
    target.projections.push(projection);
    for (const index of matchingIndexes.slice(1).reverse()) {
      const merged = groups[index]!;
      for (const alias of merged.aliases) target.aliases.add(alias);
      target.projections.push(...merged.projections);
      groups.splice(index, 1);
    }
  }
  return groups;
}

/**
 * Schema-v4 final turns have one deliberately narrow resource contract. The
 * same physical ZIP may be projected more than once by the provider, but every
 * projection must retain the exact typed-file metadata and no second physical
 * non-text resource may accompany it.
 */
export function assertKnowledgeBaseV4FinalOutputResourceContract(
  output: unknown,
): KnowledgeArchiveDescriptor {
  const projections = collectKnowledgeBaseOutputResourceProjections(output);
  if (projections.length === 0) {
    throw new KnowledgeBaseFinalOutputResourceContractError(
      "MISSING",
      "最终轮必须返回唯一的 typed application/zip 文件",
    );
  }
  const groups = groupKnowledgeBaseOutputResourceProjections(projections);
  if (groups.length !== 1) {
    throw new KnowledgeBaseFinalOutputResourceContractError(
      "AMBIGUOUS",
      `最终轮只允许一个物理非文本资源，实际检测到 ${groups.length} 个`,
    );
  }
  const group = groups[0]!;
  for (const projection of group.projections) {
    if (projection.type !== "output_file") {
      throw new KnowledgeBaseFinalOutputResourceContractError(
        "INVALID",
        "最终 ZIP 的每个资源投影都必须使用 type=output_file",
      );
    }
    if (projection.mimeType !== "application/zip") {
      throw new KnowledgeBaseFinalOutputResourceContractError(
        "INVALID",
        "最终 ZIP 的每个资源投影都必须声明 MIME=application/zip",
      );
    }
    if (!projection.filename.toLowerCase().endsWith(".zip")) {
      throw new KnowledgeBaseFinalOutputResourceContractError(
        "INVALID",
        "最终 ZIP 的每个资源投影都必须使用 .zip 文件名",
      );
    }
    if (!projection.fileId && !projection.url) {
      throw new KnowledgeBaseFinalOutputResourceContractError(
        "INVALID",
        "最终 ZIP 资源缺少可下载的 file_id 或 file_url",
      );
    }
  }
  const primary =
    group.projections.find((projection) => projection.fileId) ||
    group.projections[0]!;
  const fileId = group.projections.find(
    (projection) => projection.fileId,
  )?.fileId;
  const url = group.projections.find((projection) => projection.url)?.url;
  return {
    outputItemId: primary.outputItemId,
    outputItemIds: [
      ...new Set(group.projections.map((item) => item.outputItemId)),
    ],
    fileId,
    url,
    filename: primary.filename,
    mimeType: "application/zip",
  };
}

function descriptorFromTypedFile(
  value: unknown,
  outputItemId: () => string,
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
  const rawFileId = knowledgeBaseArtifactAliasedIdentity({
    value: item,
    aliases: ["file_id", "fileId"],
    label: "上游文件标识",
    maxLength: MAX_FILE_ID_LENGTH,
  });
  const rawUrl = String(item.file_url ?? item.fileUrl ?? item.url ?? "");
  const fileIdFromUrl = rawUrl
    ? knowledgeArchiveFileIdFromUrl(rawUrl)
    : undefined;
  if (rawFileId && fileIdFromUrl && rawFileId !== fileIdFromUrl) {
    throw new KnowledgeBaseArtifactIdentityError(
      "上游文件标识与文件 URL 中的标识相互冲突",
    );
  }
  const fileId = rawFileId || fileIdFromUrl;
  const url = assertKnowledgeBaseArtifactIdentity({
    value: rawUrl,
    label: "上游文件 URL",
    maxLength: MAX_URL_LENGTH,
  });
  const isZip =
    filename.toLowerCase().endsWith(".zip") ||
    mimeType.includes("application/zip") ||
    mimeType.includes("application/x-zip");
  if (!isZip || (!fileId && !url)) return null;

  return {
    outputItemId: assertKnowledgeBaseArtifactIdentity({
      value: outputItemId(),
      label: "上游输出项标识",
      maxLength: MAX_OUTPUT_ITEM_ID_LENGTH,
      required: true,
    })!,
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
    let resolvedParentId: string | undefined;
    const parentId = () =>
      (resolvedParentId ??= knowledgeBaseParentOutputItemId(item, outputIndex));

    let topLevel: KnowledgeArchiveDescriptor | null = null;
    try {
      topLevel =
        !role || role === "assistant"
          ? descriptorFromTypedFile(item, parentId)
          : null;
    } catch (error) {
      if (!(error instanceof KnowledgeBaseArtifactIdentityError)) throw error;
      // One malformed direct descriptor is not authority to discard other
      // direct assistant ZIPs. The invalid candidate is locally ineligible;
      // later candidates remain independently verifiable.
    }
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
      let descriptor: KnowledgeArchiveDescriptor | null = null;
      try {
        descriptor = descriptorFromTypedFile(item.content[contentIndex], () =>
          knowledgeBaseChildOutputItemId(parentId(), contentIndex),
        );
      } catch (error) {
        if (!(error instanceof KnowledgeBaseArtifactIdentityError)) throw error;
        // Continue with the next sibling instead of widening trust into an
        // arbitrary nested object or failing the whole assistant message.
      }
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
