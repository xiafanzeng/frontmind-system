import { createHash, randomUUID } from "node:crypto";

import { and, asc, desc, eq, inArray, isNotNull, isNull } from "drizzle-orm";

import {
  conversations,
  conversationTurns,
  knowledgeBaseBuildNodes,
  knowledgeBaseBuilds,
  knowledgeBaseConversationRetentionTombstones,
  messages,
  type ConversationTurn,
  type KnowledgeBaseBuild,
  type KnowledgeBaseBuildNode,
} from "../drizzle/schema";
import type {
  KnowledgeBaseBuildStatus,
  KnowledgeBaseActiveTurnDto,
  KnowledgeBaseApprovedPresentationDto,
  KnowledgeBaseNoticeDto,
  KnowledgeBaseObservationDto,
  KnowledgeBasePackageDto,
  KnowledgeBaseProgressDto,
  KnowledgeBaseProgressLeafDto,
  KnowledgeBaseOperationType,
} from "../shared/knowledge-base-progress";
import {
  extractKnowledgeBaseProtocolObjects,
  stripKnowledgeBaseProtocolPayloads,
  stripKnowledgeBaseReferenceAppendix,
} from "../shared/knowledge-base-output";
import { AuthServiceError } from "./auth-service";
import { getDb } from "./db";
import {
  collectKnowledgeArchiveDescriptors,
  knowledgeArchiveDescriptorHash,
  knowledgeArchiveFileIdFromUrl,
  knowledgeArchivePhysicalDescriptorHash,
} from "./knowledge-base-artifact";
import {
  canonicalKnowledgeBaseMarkdown,
  knowledgeBaseMarkdownSha256,
} from "./knowledge-base-package-validation";
import {
  createKnowledgeBaseAuthoritativeFinalOutput,
  deriveKnowledgeBaseAuthoritativeFinalizationPlan,
  hasKnowledgeBaseCompleteFinalProtocol,
  selectKnowledgeBaseAuthoritativeFinalDescriptor,
} from "./knowledge-base-finalization";
import {
  knowledgeBaseCustomerUploadResources,
  knowledgeBaseOfficialLogoUploadFromTurn,
} from "./knowledge-base-customer-upload";
import {
  markKnowledgeBaseConversationCompletedInTransaction,
  markKnowledgeBaseConversationFailedInTransaction,
  persistKnowledgeBasePresentationInTransaction,
} from "./knowledge-base-conversation-messages";
import {
  KnowledgeBaseProgressError,
  applyKnowledgeBaseProgressEnvelope,
  assertKnowledgeBaseProtocolOperation,
  assertKnowledgeBasePresentationMatchesState,
  assertKnowledgeBaseReadyForPackage,
  canPackageKnowledgeBase,
  classifyKnowledgeBaseUpstreamTaskStatus,
  createKnowledgeBaseProgressState,
  getKnowledgeBaseProgressSummary,
  parseKnowledgeBaseManifestEnvelope,
  parseKnowledgeBaseProgressEnvelope,
  parseKnowledgeBaseReopenEnvelope,
  type KnowledgeBaseLeafStatus,
  type KnowledgeBasePresentationEnvelope,
  type KnowledgeBaseProgressState,
} from "./knowledge-base-progress";
import type { KnowledgeBaseStagedArtifactCandidate } from "./knowledge-base-artifact-binding-service";

export type KnowledgeBaseUserAction =
  | "initial"
  | "confirm"
  | "direct_prefill"
  | "revise";

type KnowledgeBaseStagedArtifacts = {
  logo?: KnowledgeBaseStagedArtifactCandidate;
  package?: KnowledgeBaseStagedArtifactCandidate;
};

export function knowledgeBaseStagedArtifactMatchesAuthority(input: {
  candidate: KnowledgeBaseStagedArtifactCandidate;
  kind: "logo" | "package";
  userId: number;
  build: Pick<
    KnowledgeBaseBuild,
    | "id"
    | "generation"
    | "stateEpoch"
    | "revision"
    | "activeTurnId"
    | "upstreamTaskId"
  >;
  activeTurn?: Pick<
    ConversationTurn,
    "id" | "operationKey" | "upstreamTaskId" | "status"
  >;
  taskId?: string;
}) {
  const { candidate, build, activeTurn } = input;
  return Boolean(
    candidate.staged === true &&
      candidate.kind === input.kind &&
      candidate.userId === input.userId &&
      candidate.buildId === build.id &&
      candidate.generation === build.generation &&
      candidate.expectedStateEpoch === build.stateEpoch &&
      candidate.expectedRevision === build.revision &&
      candidate.turnId === build.activeTurnId &&
      candidate.turnId === activeTurn?.id &&
      candidate.operationKey === activeTurn?.operationKey &&
      candidate.taskId === (input.taskId || build.upstreamTaskId) &&
      candidate.taskId === activeTurn?.upstreamTaskId &&
      (activeTurn?.status === "queued" || activeTurn?.status === "running"),
  );
}

export class KnowledgeBaseBuildError extends Error {
  constructor(
    public readonly code:
      | "BUILD_NOT_FOUND"
      | "FINAL_PACKAGE_MISSING"
      | "PROGRESS_PROTOCOL_INVALID"
      | "PUBLISH_BLOCKED",
    message: string,
  ) {
    super(message);
    this.name = "KnowledgeBaseBuildError";
  }
}

async function requireDb() {
  const db = await getDb();
  if (!db) {
    throw new AuthServiceError(
      "DATABASE_UNAVAILABLE",
      "Database is not configured",
    );
  }
  return db;
}

function normalizeConversationId(value: string) {
  const normalized = String(value || "").trim();
  if (!normalized || normalized.length > 191) {
    throw new KnowledgeBaseBuildError("BUILD_NOT_FOUND", "知识库对话标识无效");
  }
  return normalized;
}

export function knowledgeBaseObservationConversationStorageId(
  userId: number,
  publicConversationId: string,
) {
  return `u${userId}:${normalizeConversationId(publicConversationId)}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function assertEnvelopeBelongsToActiveTurn(input: {
  build: KnowledgeBaseBuild;
  activeTurn?: ConversationTurn;
  envelope: {
    schemaVersion: 1 | 2;
    operationId?: string;
    turnId?: string;
  };
}) {
  if (input.build.skillVersion === "4") {
    if (!input.activeTurn?.operationKey) {
      throw new KnowledgeBaseBuildError(
        "PROGRESS_PROTOCOL_INVALID",
        "当前 v4 输出没有匹配的服务端 turn reservation",
      );
    }
    assertKnowledgeBaseProtocolOperation(input.envelope, {
      operationId: input.activeTurn.operationKey,
      turnId: input.activeTurn.id,
      requireV4: true,
    });
    return;
  }
  assertKnowledgeBaseProtocolOperation(input.envelope, {
    operationId: "",
    turnId: "",
    requireV4: false,
  });
}

export function knowledgeBaseSuccessfulTurnIdentity(input: {
  activeTurnId: string | null;
  operationKey?: string | null;
  lastAppliedOperationKey?: string | null;
}) {
  return {
    // The node keeps provenance after the build releases its reservation.
    sourceTurnId: input.activeTurnId,
    activeTurnId: null,
    lastAppliedOperationKey:
      input.operationKey || input.lastAppliedOperationKey || null,
  } as const;
}

export type KnowledgeBaseOutputImageDescriptor = {
  fileId: string;
  url: string;
  filename: string;
  mimeType: string;
};

export function knowledgeBaseOutputImageDescriptorHash(
  descriptor: KnowledgeBaseOutputImageDescriptor,
) {
  return createHash("sha256")
    .update(
      JSON.stringify({
        fileId: descriptor.fileId || null,
        urlHash: descriptor.fileId
          ? null
          : createHash("sha256")
              .update(descriptor.url || "", "utf8")
              .digest("hex"),
        filename: descriptor.filename,
        mimeType: descriptor.mimeType,
      }),
      "utf8",
    )
    .digest("hex");
}

function trustedKnowledgeBaseImageDescriptor(value: unknown) {
  if (!isRecord(value)) return null;
  const type = stringValue(value.type).toLowerCase();
  const mimeType = stringValue(
    value.mimeType || value.mime_type || value.content_type,
  ).toLowerCase();
  const fileName = stringValue(
    value.fileName || value.file_name || value.filename || value.name,
  );
  const rawResourceId = stringValue(value.fileId || value.file_id);
  const resourceUrl = stringValue(
    value.fileUrl ||
      value.file_url ||
      value.imageUrl ||
      value.image_url ||
      value.url,
  );
  const resourceId =
    rawResourceId ||
    (resourceUrl ? knowledgeArchiveFileIdFromUrl(resourceUrl) || "" : "");
  const isImage =
    type === "output_image" ||
    type === "image" ||
    ((type === "output_file" || type === "file") &&
      (mimeType.startsWith("image/") ||
        /\.(?:avif|gif|jpe?g|png|webp)$/i.test(fileName)));
  if (!isImage || (!resourceId && !resourceUrl)) return null;
  return {
    fileId: resourceId,
    url: resourceUrl,
    filename: fileName || "official-logo",
    mimeType: mimeType || "application/octet-stream",
  } satisfies KnowledgeBaseOutputImageDescriptor;
}

/**
 * Images are trusted only when emitted as typed provider output or as a direct
 * child of a typed assistant output message. User/tool/reasoning/input records
 * are never resources of the model operation, even if arbitrary nested
 * metadata happens to look like an image descriptor.
 */
export function collectTrustedKnowledgeBaseOutputImageDescriptors(
  output: unknown,
) {
  const items = Array.isArray(output)
    ? output
    : isRecord(output)
      ? [output]
      : [];
  const result: KnowledgeBaseOutputImageDescriptor[] = [];
  for (const rawItem of items) {
    if (!isRecord(rawItem)) continue;
    const role = stringValue(rawItem.role).toLowerCase();
    const type = stringValue(rawItem.type).toLowerCase();
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
    const topLevel = trustedKnowledgeBaseImageDescriptor(rawItem);
    if (topLevel && (!role || role === "assistant")) result.push(topLevel);

    if (
      role !== "assistant" ||
      (type !== "message" && type !== "output_message") ||
      !Array.isArray(rawItem.content)
    ) {
      continue;
    }
    for (const content of rawItem.content) {
      const descriptor = trustedKnowledgeBaseImageDescriptor(content);
      if (descriptor) result.push(descriptor);
    }
  }
  const deduplicated: KnowledgeBaseOutputImageDescriptor[] = [];
  for (const descriptor of result) {
    const aliases = new Set(
      [
        descriptor.fileId,
        descriptor.url,
        descriptor.url
          ? knowledgeArchiveFileIdFromUrl(descriptor.url) || ""
          : "",
      ].filter(Boolean),
    );
    const existing = deduplicated.find((candidate) =>
      [
        candidate.fileId,
        candidate.url,
        candidate.url ? knowledgeArchiveFileIdFromUrl(candidate.url) || "" : "",
      ]
        .filter(Boolean)
        .some((alias) => aliases.has(alias)),
    );
    if (!existing) {
      deduplicated.push(descriptor);
      continue;
    }
    existing.fileId ||= descriptor.fileId;
    existing.url ||= descriptor.url;
    existing.filename ||= descriptor.filename;
    existing.mimeType ||= descriptor.mimeType;
  }
  return deduplicated;
}

export function collectKnowledgeBaseOutputImageKeys(
  value: unknown,
  result = new Set<string>(),
) {
  const descriptors = collectTrustedKnowledgeBaseOutputImageDescriptors(value);
  const physicalImages: Array<{
    aliases: Set<string>;
    fileId: string;
    url: string;
  }> = [];
  for (const descriptor of descriptors) {
    const extractedFileId = descriptor.url
      ? knowledgeArchiveFileIdFromUrl(descriptor.url) || ""
      : "";
    const aliases = new Set(
      [descriptor.fileId, descriptor.url, extractedFileId].filter(Boolean),
    );
    const overlaps = physicalImages.filter((image) =>
      [...image.aliases].some((alias) => aliases.has(alias)),
    );
    if (overlaps.length === 0) {
      physicalImages.push({
        aliases,
        fileId: descriptor.fileId || extractedFileId,
        url: descriptor.url,
      });
      continue;
    }
    const primary = overlaps[0]!;
    for (const alias of aliases) primary.aliases.add(alias);
    primary.fileId ||= descriptor.fileId || extractedFileId;
    primary.url ||= descriptor.url;
    for (const duplicate of overlaps.slice(1)) {
      for (const alias of duplicate.aliases) primary.aliases.add(alias);
      primary.fileId ||= duplicate.fileId;
      primary.url ||= duplicate.url;
      physicalImages.splice(physicalImages.indexOf(duplicate), 1);
    }
  }
  for (const image of physicalImages) {
    const key = image.fileId || image.url;
    if (key) result.add(key);
  }
  return result;
}

/**
 * Return every usable alias carried by an image descriptor. Some upstream
 * versions provide both a durable file ID and a signed CDN URL for one image;
 * counting still uses one preferred key, while download authorization must
 * recognize both aliases.
 */
export function collectKnowledgeBaseOutputImageResourceAliases(
  value: unknown,
  result = new Set<string>(),
) {
  for (const descriptor of collectTrustedKnowledgeBaseOutputImageDescriptors(
    value,
  )) {
    if (descriptor.fileId) result.add(descriptor.fileId);
    if (descriptor.url) result.add(descriptor.url);
  }
  return result;
}

export function latestKnowledgeBasePresentationOutput(output: unknown) {
  if (!Array.isArray(output)) return output;
  const assistantIndexes = output.flatMap((item, index) =>
    extractFinalKnowledgeBaseAssistantText([item]) ? [index] : [],
  );
  if (assistantIndexes.length === 0) return output;
  const presentationIndex =
    [...assistantIndexes]
      .reverse()
      .find((index) =>
        containsKnowledgeBasePresentationPayload(
          extractFinalKnowledgeBaseAssistantText([output[index]]),
        ),
      ) ??
    [...assistantIndexes]
      .reverse()
      .find((index) =>
        containsKnowledgeBaseStatePayload(
          extractFinalKnowledgeBaseAssistantText([output[index]]),
        ),
      ) ??
    assistantIndexes[assistantIndexes.length - 1]!;
  return output.slice(presentationIndex);
}

export function assertKnowledgeBaseNodeImageDelivery(input: {
  presentation: KnowledgeBasePresentationEnvelope;
  output: unknown;
}) {
  const { presentation } = input;
  const protocolScopedOutput =
    presentation.operationId && presentation.turnId
      ? selectKnowledgeBaseProtocolOperationOutput(input.output, {
          operationId: presentation.operationId,
          turnId: presentation.turnId,
        })
      : latestKnowledgeBasePresentationOutput(input.output);
  assertKnowledgeBaseOutputHasNoInlineImages(protocolScopedOutput);
  if (
    presentation.imageState === undefined ||
    presentation.assetIds === undefined ||
    presentation.imageCount === undefined
  ) {
    throw new KnowledgeBaseBuildError(
      "PROGRESS_PROTOCOL_INVALID",
      "当前节点缺少图片交付声明，本轮未推进",
    );
  }

  const resourceScopedOutput =
    presentation.operationId && presentation.turnId
      ? selectKnowledgeBaseProtocolOperationOutput(
          input.output,
          {
            operationId: presentation.operationId,
            turnId: presentation.turnId,
          },
          { requireExplicitResourceOperation: true },
        )
      : protocolScopedOutput;
  const actualImageCount =
    collectKnowledgeBaseOutputImageKeys(resourceScopedOutput).size;
  if (presentation.leafId === null) {
    if (
      presentation.imageState !== "not_applicable" ||
      presentation.assetIds.length !== 0 ||
      presentation.imageCount !== 0 ||
      actualImageCount !== 0
    ) {
      throw new KnowledgeBaseBuildError(
        "PROGRESS_PROTOCOL_INVALID",
        "知识库已完成，本轮图片交付声明必须为 not_applicable",
      );
    }
    return;
  }

  if (
    presentation.imageState !== "no_eligible_asset" ||
    presentation.assetIds.length !== 0 ||
    presentation.imageCount !== 0 ||
    actualImageCount !== 0
  ) {
    throw new KnowledgeBaseBuildError(
      "PROGRESS_PROTOCOL_INVALID",
      "图片只允许在首轮第一个节点展示；后续节点必须声明 no_eligible_asset 且不得返回图片附件",
    );
  }
}

export function assertKnowledgeBaseInitialImageDelivery(
  output: unknown,
  operation?: KnowledgeBaseProtocolOperationIdentity,
  options: { allowMissing?: boolean } = {},
) {
  const scopedOutput = operation
    ? selectKnowledgeBaseProtocolOperationOutput(output, {
        ...operation,
        stateKind: "frontmind.knowledge-base.manifest",
      })
    : latestKnowledgeBasePresentationOutput(output);
  assertKnowledgeBaseOutputHasNoInlineImages(scopedOutput);
  const imageCount = collectKnowledgeBaseOutputImageKeys(scopedOutput).size;
  if (imageCount === 0 && options.allowMissing === true) return imageCount;
  if (imageCount !== 1) {
    throw new KnowledgeBaseBuildError(
      "PROGRESS_PROTOCOL_INVALID",
      `首个知识节点必须只展示一张企业官方主 Logo，实际返回 ${imageCount} 张`,
    );
  }
  return imageCount;
}

function assertKnowledgeBaseOutputHasNoInlineImages(output: unknown) {
  const text = extractFinalKnowledgeBaseAssistantText(output);
  if (/!\[[^\r\n]*\]\([^\r\n)]*\)|<img\b|data:image\//i.test(text)) {
    throw new KnowledgeBaseBuildError(
      "PROGRESS_PROTOCOL_INVALID",
      "知识库正文不得包含 Markdown、HTML 或 data URL 图片；图片必须使用服务端绑定资源",
    );
  }
}

function stringValue(value: unknown) {
  if (typeof value === "string") return value.trim();
  if (isRecord(value) && typeof value.value === "string") {
    return value.value.trim();
  }
  return "";
}

function typedKnowledgeAssistantMessageText(value: unknown) {
  if (
    !isRecord(value) ||
    stringValue(value.role).toLowerCase() !== "assistant"
  ) {
    return "";
  }
  const type =
    typeof value.type === "string" ? value.type.trim().toLowerCase() : "";
  if (
    type &&
    !["message", "output_message", "output_text", "text"].includes(type)
  ) {
    return "";
  }

  const parts: string[] = [];
  for (const candidate of [
    value.output_text,
    value.text,
    typeof value.content === "string" ? value.content : undefined,
  ]) {
    const text = stringValue(candidate);
    if (text && !parts.includes(text)) parts.push(text);
  }
  if (Array.isArray(value.content)) {
    for (const rawContent of value.content) {
      if (typeof rawContent === "string") {
        const text = rawContent.trim();
        if (text && !parts.includes(text)) parts.push(text);
        continue;
      }
      if (!isRecord(rawContent)) continue;
      const contentType =
        typeof rawContent.type === "string"
          ? rawContent.type.trim().toLowerCase()
          : "";
      if (!["output_text", "text", "message", ""].includes(contentType)) {
        continue;
      }
      const text = stringValue(
        rawContent.text ?? rawContent.output_text ?? rawContent.value,
      );
      if (text && !parts.includes(text)) parts.push(text);
    }
  }
  return parts.join("\n\n").trim();
}

interface KnowledgeBaseAssistantTextEntry {
  index: number;
  text: string;
}

export interface KnowledgeBaseProtocolOperationIdentity {
  operationId: string;
  turnId: string;
  taskId?: string;
  generation?: number;
  stateKind?:
    | "frontmind.knowledge-base.manifest"
    | "frontmind.knowledge-base.progress"
    | "frontmind.knowledge-base.reopen";
}

interface KnowledgeBaseProtocolOperationSelectionOptions {
  /**
   * Later v4 turns must never infer a resource's owner from proximity to a
   * protocol message. Provider output is cumulative, so an unscoped image can
   * arrive late beside a newer Progress/Presentation pair. Requiring both
   * operation and turn claims makes that descriptor a stale/no-op observation
   * instead of contaminating the active turn.
   *
   * The initial Manifest deliberately keeps the default proximity behaviour:
   * providers are known to place the one official Logo immediately before or
   * after the Manifest item.
   */
  requireExplicitImageOperation?: boolean;
  /** Apply the same exact operation+turn ownership rule to every file/image. */
  requireExplicitResourceOperation?: boolean;
}

function knowledgeBaseAssistantTextEntries(
  output: unknown,
): KnowledgeBaseAssistantTextEntry[] {
  if (!Array.isArray(output)) return [];
  return output.flatMap((item, index) => {
    const text = typedKnowledgeAssistantMessageText(item);
    return text ? [{ index, text }] : [];
  });
}

const KNOWLEDGE_BASE_STATE_KINDS = new Set([
  "frontmind.knowledge-base.manifest",
  "frontmind.knowledge-base.progress",
  "frontmind.knowledge-base.reopen",
]);

type KnowledgeBaseProtocolAnchor = KnowledgeBaseAssistantTextEntry & {
  identities: Array<{
    kind: string;
    operationId: string;
    turnId: string;
  }>;
};

function knowledgeBaseProtocolAnchors(
  output: unknown[],
): KnowledgeBaseProtocolAnchor[] {
  return knowledgeBaseAssistantTextEntries(output).flatMap((entry) => {
    const identities = extractKnowledgeBaseProtocolObjects(entry.text)
      .filter((value) =>
        KNOWLEDGE_BASE_STATE_KINDS.has(String(value.kind || "")),
      )
      .map((value) => ({
        kind: String(value.kind || ""),
        operationId: String(value.operationId || "").trim(),
        turnId: String(value.turnId || "").trim(),
      }));
    return identities.length > 0 ? [{ ...entry, identities }] : [];
  });
}

type KnowledgeBaseOutputIdentityClaims = {
  operationIds: Set<string>;
  turnIds: Set<string>;
  taskIds: Set<string>;
  generations: Set<number>;
};

function collectKnowledgeBaseOutputIdentityClaims(
  value: unknown,
  claims: KnowledgeBaseOutputIdentityClaims = {
    operationIds: new Set(),
    turnIds: new Set(),
    taskIds: new Set(),
    generations: new Set(),
  },
  depth = 0,
) {
  if (value === null || value === undefined || depth > 50) return claims;
  if (Array.isArray(value)) {
    for (const item of value) {
      collectKnowledgeBaseOutputIdentityClaims(item, claims, depth + 1);
    }
    return claims;
  }
  if (!isRecord(value)) return claims;
  for (const [key, raw] of Object.entries(value)) {
    const normalizedKey = key.replace(/_/gu, "").toLowerCase();
    if (typeof raw === "string" && raw.trim()) {
      if (normalizedKey === "operationid") {
        claims.operationIds.add(raw.trim());
      } else if (normalizedKey === "turnid") {
        claims.turnIds.add(raw.trim());
      } else if (normalizedKey === "taskid") {
        claims.taskIds.add(raw.trim());
      }
    } else if (
      typeof raw === "number" &&
      Number.isInteger(raw) &&
      (normalizedKey === "generation" || normalizedKey === "buildgeneration")
    ) {
      claims.generations.add(raw);
    }
    if (raw && typeof raw === "object") {
      collectKnowledgeBaseOutputIdentityClaims(raw, claims, depth + 1);
    }
  }
  return claims;
}

function identityClaimsMatchKnowledgeBaseOperation(
  claims: KnowledgeBaseOutputIdentityClaims,
  expected: KnowledgeBaseProtocolOperationIdentity,
) {
  return (
    (claims.operationIds.size === 0 ||
      (claims.operationIds.size === 1 &&
        claims.operationIds.has(expected.operationId))) &&
    (claims.turnIds.size === 0 ||
      (claims.turnIds.size === 1 && claims.turnIds.has(expected.turnId))) &&
    (claims.taskIds.size === 0 ||
      (Boolean(expected.taskId) &&
        claims.taskIds.size === 1 &&
        claims.taskIds.has(expected.taskId!))) &&
    (claims.generations.size === 0 ||
      (expected.generation !== undefined &&
        claims.generations.size === 1 &&
        claims.generations.has(expected.generation)))
  );
}

/**
 * Select one operation's complete provider-output window. Some providers put
 * a file descriptor immediately before the assistant Manifest item, while
 * others put it after or duplicate it inside the item. A tail slice therefore
 * loses valid Logos, while scanning the cumulative task output admits an old
 * operation's files. Explicit operation/turn/task/generation claims win; an
 * unscoped item is associated only with its unique nearest protocol anchor.
 */
export function selectKnowledgeBaseProtocolOperationOutput(
  output: unknown,
  expected: KnowledgeBaseProtocolOperationIdentity,
  options: KnowledgeBaseProtocolOperationSelectionOptions = {},
) {
  if (!Array.isArray(output)) return [];
  const anchors = knowledgeBaseProtocolAnchors(output);
  const matchingAnchors = anchors.filter((anchor) =>
    anchor.identities.some(
      (identity) =>
        identity.operationId === expected.operationId &&
        identity.turnId === expected.turnId &&
        (!expected.stateKind || identity.kind === expected.stateKind),
    ),
  );
  if (matchingAnchors.length === 0) return [];
  const matchingIndexes = new Set(
    matchingAnchors.map((anchor) => anchor.index),
  );

  return output.filter((item, index) => {
    const claims = collectKnowledgeBaseOutputIdentityClaims(item);
    const containsImage = collectKnowledgeBaseOutputImageKeys(item).size > 0;
    const containsArchive =
      collectKnowledgeArchiveDescriptors([item]).length > 0;
    if (
      (options.requireExplicitImageOperation && containsImage) ||
      (options.requireExplicitResourceOperation &&
        (containsImage || containsArchive))
    ) {
      // A resource nested in the exact matching protocol item is scoped by
      // that item's operation/turn envelope. This still rejects a forbidden
      // current-turn image while refusing to infer ownership for a separate,
      // late top-level descriptor merely because it is nearby.
      if (matchingIndexes.has(index)) return true;
      // taskId/generation alone are insufficient: both can be shared by
      // cumulative snapshots containing multiple turns. A later-turn image is
      // attributable only when the resource itself (or its containing output
      // item) carries the exact operation + turn pair.
      return (
        claims.operationIds.size === 1 &&
        claims.operationIds.has(expected.operationId) &&
        claims.turnIds.size === 1 &&
        claims.turnIds.has(expected.turnId) &&
        (expected.taskId === undefined ||
          claims.taskIds.size === 0 ||
          (claims.taskIds.size === 1 && claims.taskIds.has(expected.taskId))) &&
        (expected.generation === undefined ||
          claims.generations.size === 0 ||
          (claims.generations.size === 1 &&
            claims.generations.has(expected.generation)))
      );
    }
    if (matchingIndexes.has(index)) return true;
    const hasExplicitClaims =
      claims.operationIds.size > 0 ||
      claims.turnIds.size > 0 ||
      claims.taskIds.size > 0 ||
      claims.generations.size > 0;
    if (hasExplicitClaims) {
      return identityClaimsMatchKnowledgeBaseOperation(claims, expected);
    }

    let nearestDistance = Number.POSITIVE_INFINITY;
    let nearest: KnowledgeBaseProtocolAnchor[] = [];
    for (const anchor of anchors) {
      const distance = Math.abs(anchor.index - index);
      if (distance < nearestDistance) {
        nearestDistance = distance;
        nearest = [anchor];
      } else if (distance === nearestDistance) {
        nearest.push(anchor);
      }
    }
    // A tie between two operations is inherently ambiguous. Waiting for a
    // scoped/nested descriptor is safer than binding another turn's bytes.
    return nearest.length === 1 && matchingIndexes.has(nearest[0]!.index);
  });
}

const KNOWLEDGE_BASE_STATE_MARKER_OPENING =
  /<!--\s*FRONTMIND_KB_(?:MANIFEST|PROGRESS|REOPEN)\b/i;
const KNOWLEDGE_BASE_PRESENTATION_MARKER_OPENING =
  /<!--\s*FRONTMIND_KB_PRESENTATION\b/i;
const KNOWLEDGE_BASE_CLOSED_STATE_MARKER =
  /<!--\s*FRONTMIND_KB_(?:MANIFEST|PROGRESS|REOPEN)\b[\s\S]*?-->/i;
const KNOWLEDGE_BASE_CLOSED_PRESENTATION_MARKER =
  /<!--\s*FRONTMIND_KB_PRESENTATION\b[\s\S]*?-->/i;
function containsKnowledgeBaseStatePayload(text: string) {
  return (
    KNOWLEDGE_BASE_STATE_MARKER_OPENING.test(text) ||
    extractKnowledgeBaseProtocolObjects(text).some((value) =>
      KNOWLEDGE_BASE_STATE_KINDS.has(String(value.kind || "")),
    )
  );
}

function containsKnowledgeBasePresentationPayload(text: string) {
  return (
    KNOWLEDGE_BASE_PRESENTATION_MARKER_OPENING.test(text) ||
    extractKnowledgeBaseProtocolObjects(text).some(
      (value) => value.kind === "frontmind.knowledge-base.presentation",
    )
  );
}

/**
 * Select the newest state-bearing assistant response, not merely the final
 * assistant record. Providers occasionally append a plain "task complete"
 * message after the actual protocol response, and sometimes emit the
 * presentation in the immediately following assistant record.
 */
export function extractAuthoritativeKnowledgeBaseAssistantText(
  output: unknown,
): string {
  const entries = knowledgeBaseAssistantTextEntries(output);
  if (entries.length === 0) return "";
  let stateEntryIndex = -1;
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    if (containsKnowledgeBaseStatePayload(entries[index]!.text)) {
      stateEntryIndex = index;
      break;
    }
  }
  if (stateEntryIndex < 0) {
    return entries[entries.length - 1]!.text.slice(-4_000_000);
  }
  const selected = [entries[stateEntryIndex]!.text];
  if (!containsKnowledgeBasePresentationPayload(selected[0]!)) {
    for (let index = stateEntryIndex + 1; index < entries.length; index += 1) {
      const text = entries[index]!.text;
      if (containsKnowledgeBaseStatePayload(text)) break;
      if (containsKnowledgeBasePresentationPayload(text)) {
        selected.push(text);
        break;
      }
    }
  }
  return selected.join("\n\n").slice(-4_000_000);
}

export function hasClosedKnowledgeBaseStateEnvelope(text: string) {
  return KNOWLEDGE_BASE_CLOSED_STATE_MARKER.test(String(text || ""));
}

export function hasClosedKnowledgeBasePresentationEnvelope(text: string) {
  return KNOWLEDGE_BASE_CLOSED_PRESENTATION_MARKER.test(String(text || ""));
}

/**
 * Only a typed assistant message may drive the authoritative knowledge state
 * machine. User, reasoning, tool and role-less provider records are excluded
 * even when they contain a valid-looking envelope.
 */
export function extractFinalKnowledgeBaseAssistantText(
  output: unknown,
): string {
  return extractAuthoritativeKnowledgeBaseAssistantText(output);
}

export function isKnowledgeBaseAcknowledgementOnlyOutput(output: unknown) {
  const normalized = extractFinalKnowledgeBaseAssistantText(output)
    .trim()
    .replace(/[\s。！!，,]/gu, "");
  return ["已收到", "收到", "好的", "好", "开始处理", "马上处理"].includes(
    normalized,
  );
}

export const KNOWLEDGE_BASE_ACKNOWLEDGEMENT_FAILURE_MESSAGE =
  "上游智能体仅返回了确认回执，未生成知识库正文；本轮未写入，现可安全重试";

export function assertKnowledgeBaseCustomerOutput(output: unknown) {
  return extractFinalKnowledgeBaseAssistantText(output);
}

function reconciliationHash(input: {
  taskId?: string;
  assistantText: string;
  output: unknown;
  userText: string;
  attachmentCount: number;
}) {
  const imageKeys = [
    ...collectKnowledgeBaseOutputImageKeys(input.output),
  ].sort();
  const archiveKeys = collectKnowledgeArchiveDescriptors(input.output)
    .map((descriptor) => ({
      outputItemId: descriptor.outputItemId,
      fileId: descriptor.fileId || null,
      filename: descriptor.filename,
      mimeType: descriptor.mimeType,
    }))
    .sort((left, right) =>
      JSON.stringify(left).localeCompare(JSON.stringify(right)),
    );
  return createHash("sha256")
    .update(
      JSON.stringify({
        taskId: input.taskId || null,
        assistantText: input.assistantText.normalize("NFKC").trim(),
        imageKeys,
        archiveKeys,
        userText: input.userText,
        attachmentCount: input.attachmentCount,
      }),
    )
    .digest("hex");
}

function modelOutputAudit(text: string) {
  const auditMarkdown = stripKnowledgeBaseProtocolPayloads(text)
    .trim()
    .slice(-2_000_000);
  const contentMarkdown =
    stripKnowledgeBaseReferenceAppendix(auditMarkdown).slice(-2_000_000);
  const sourceUrls = Array.from(
    new Set(auditMarkdown.match(/https?:\/\/[^\s<>)\]"']+/gi) || []),
  ).slice(0, 500);
  const imageUrls = Array.from(
    new Set(
      [
        ...Array.from(
          auditMarkdown.matchAll(/!\[[^\]]*]\((https?:\/\/[^)\s]+)\)/gi),
          (match) => match[1],
        ),
        ...sourceUrls.filter((url) =>
          /\.(?:avif|gif|jpe?g|png|svg|webp)(?:[?#].*)?$/i.test(url),
        ),
      ].filter(Boolean),
    ),
  ).slice(0, 500);
  return { contentMarkdown, sourceUrls, imageUrls };
}

function stripMarkdownDecoration(value: string) {
  let normalized = value
    .trim()
    .replace(/\s+#+\s*$/u, "")
    .trim();
  for (const marker of ["**", "__", "~~", "`"]) {
    if (normalized.startsWith(marker) && normalized.endsWith(marker)) {
      normalized = normalized.slice(marker.length, -marker.length).trim();
    }
  }
  return normalized;
}

function stripLeadingKnowledgeBaseAcknowledgements(value: string) {
  const lines = canonicalKnowledgeBaseMarkdown(value).split("\n");
  let cursor = 0;
  while (cursor < lines.length) {
    while (cursor < lines.length && !lines[cursor]!.trim()) cursor += 1;
    if (cursor >= lines.length) break;
    const candidate = stripMarkdownDecoration(
      lines[cursor]!.replace(/^\s{0,3}#{1,6}[\t ]+/u, ""),
    );
    const startsWithLeafId =
      /^(?:节点[\t ]*)?[A-Za-z0-9]+(?:[._-][A-Za-z0-9]+)+(?:[\t ]|[「【:：]|$)/u.test(
        candidate,
      );
    const isAcknowledgement =
      /(?:已确认|确认完成|已采用预填|已处理)(?:[。.!！]|$)/u.test(candidate);
    if (!startsWithLeafId || !isAcknowledgement || candidate.length > 200) {
      break;
    }
    cursor += 1;
  }
  return canonicalKnowledgeBaseMarkdown(lines.slice(cursor).join("\n"));
}

function knowledgeBaseHeadingText(line: string) {
  const heading = /^\s{0,3}#{1,6}[\t ]+(.+?)[\t ]*#*[\t ]*$/u.exec(line);
  if (!heading) return null;
  return stripMarkdownDecoration(heading[1]!);
}

function knowledgeBaseHeadingLeafId(title: string, leafIds: readonly string[]) {
  const orderedIds = [...leafIds].sort(
    (left, right) => right.length - left.length,
  );
  return (
    orderedIds.find(
      (leafId) =>
        title === leafId ||
        title.startsWith(`${leafId} `) ||
        title.startsWith(`${leafId}\t`) ||
        title.startsWith(`${leafId}「`) ||
        title.startsWith(`${leafId}【`) ||
        title.startsWith(`${leafId}:`) ||
        title.startsWith(`${leafId}：`),
    ) || null
  );
}

function normalizedKnowledgeBaseLeafTitle(value: string) {
  return String(value || "")
    .normalize("NFKC")
    .replace(/[*_`~]/gu, "")
    .replace(/^[\s「」『』【】\[\]():：-]+|[\s「」『』【】\[\]():：-]+$/gu, "")
    .replace(/\s+/gu, "")
    .toLowerCase();
}

/**
 * Reduce a cumulative provider response to the one server-approved leaf.
 * Status acknowledgements (for example, "1.1 已确认") belong to interaction
 * state, never to the next leaf body. The returned bytes are also the bytes
 * hashed into the database and compared with the final ZIP.
 */
export function projectKnowledgeBasePresentationMarkdown(input: {
  markdown: string;
  leafId: string;
  leafTitle: string;
  leafIds: readonly string[];
}) {
  const withoutAcknowledgements = stripLeadingKnowledgeBaseAcknowledgements(
    input.markdown,
  );
  if (!withoutAcknowledgements) return "";
  const leafIds = Array.from(
    new Set(
      [input.leafId, ...input.leafIds]
        .map((value) => value.trim())
        .filter(Boolean),
    ),
  );
  const lines = withoutAcknowledgements.split("\n");
  const headings = lines.flatMap((line, index) => {
    const text = knowledgeBaseHeadingText(line);
    const leafId = text ? knowledgeBaseHeadingLeafId(text, leafIds) : null;
    return leafId && text ? [{ index, leafId, text }] : [];
  });
  const targets = headings.filter((heading) => heading.leafId === input.leafId);
  if (targets.length > 1) {
    throw new KnowledgeBaseBuildError(
      "PROGRESS_PROTOCOL_INVALID",
      `当前输出重复包含节点 ${input.leafId} 的多个正文，本轮未推进`,
    );
  }
  if (targets.length === 1) {
    const targetTitle = targets[0]!.text.slice(input.leafId.length);
    if (
      normalizedKnowledgeBaseLeafTitle(targetTitle) &&
      normalizedKnowledgeBaseLeafTitle(targetTitle) !==
        normalizedKnowledgeBaseLeafTitle(input.leafTitle)
    ) {
      throw new KnowledgeBaseBuildError(
        "PROGRESS_PROTOCOL_INVALID",
        `当前输出节点 ${input.leafId} 的标题与知识树不一致，本轮未推进`,
      );
    }
    const start = targets[0]!.index;
    const next = headings.find((heading) => heading.index > start);
    return canonicalKnowledgeBaseMarkdown(
      lines.slice(start, next?.index ?? lines.length).join("\n"),
    );
  }
  if (headings.length > 0) {
    throw new KnowledgeBaseBuildError(
      "PROGRESS_PROTOCOL_INVALID",
      `当前输出正文属于节点 ${headings[0]!.leafId}，与待展示节点 ${input.leafId} 不一致`,
    );
  }
  const unknownLeafHeading = lines
    .map((line) => knowledgeBaseHeadingText(line))
    .filter(Boolean)
    .map((text) =>
      /^([A-Za-z0-9]+(?:[._-][A-Za-z0-9]+)+)(?:[\t ]|[「【:：]|$)/u.exec(text!),
    )
    .find(Boolean);
  if (unknownLeafHeading) {
    throw new KnowledgeBaseBuildError(
      "PROGRESS_PROTOCOL_INVALID",
      `当前输出正文属于未知节点 ${unknownLeafHeading[1]}，与待展示节点 ${input.leafId} 不一致`,
    );
  }
  const body = canonicalKnowledgeBaseMarkdown(withoutAcknowledgements);
  if (!body) return "";
  const title = [input.leafId, input.leafTitle.trim()]
    .filter(Boolean)
    .join(" ");
  return canonicalKnowledgeBaseMarkdown(`## ${title}\n\n${body}`);
}

function knowledgePresentationKey(input: {
  buildId: string;
  generation: number;
  revision: number;
  leafId: string;
  contentSha256: string;
}) {
  return createHash("sha256")
    .update(
      [
        input.buildId,
        input.generation,
        input.revision,
        input.leafId,
        input.contentSha256,
      ].join(":"),
    )
    .digest("hex");
}

function mergeAuditUrls(existing: string[] | null, incoming: string[]) {
  return Array.from(new Set([...(existing || []), ...incoming])).slice(0, 500);
}

export function classifyKnowledgeBaseUserAction(
  userText: string,
  attachmentCount = 0,
): KnowledgeBaseUserAction {
  const normalized = String(userText || "")
    .normalize("NFKC")
    .trim()
    .replace(/[。！!]+$/g, "")
    .trim()
    .toLowerCase();
  if (attachmentCount > 0) return "revise";
  if (!normalized) return "initial";
  if (/^(确认|确认无误|无误|没问题|可以|通过|采用|ok|okay)$/.test(normalized)) {
    return "confirm";
  }
  if (
    /^(跳过|直接预填|采用预填|保留预填|按预填继续|使用预填)$/.test(normalized)
  ) {
    return "direct_prefill";
  }
  return "revise";
}

export function isAmbiguousKnowledgeBaseAdvance(userText: string) {
  const normalized = String(userText || "")
    .normalize("NFKC")
    .trim()
    .replace(/[。！!]+$/g, "")
    .trim()
    .toLowerCase();
  return /^(继续|下一步|下一个|继续吧|请继续|next)$/.test(normalized);
}

function stateFromRows(
  build: KnowledgeBaseBuild,
  rows: KnowledgeBaseBuildNode[],
): KnowledgeBaseProgressState {
  return {
    schemaVersion: 1,
    revision: build.revision,
    currentLeafId: build.currentLeafId,
    leaves: rows.map((row) => ({
      id: row.leafId,
      title: row.title,
      branchId: row.branchId,
      branchTitle: row.branchTitle,
      status: row.status as KnowledgeBaseLeafStatus,
    })),
  };
}

function buildDto(
  build: KnowledgeBaseBuild,
  rows: KnowledgeBaseBuildNode[],
): KnowledgeBaseProgressDto {
  const currentBuildRow = rows.find(
    (row) => row.leafId === build.currentLeafId,
  );
  const leaves: KnowledgeBaseProgressLeafDto[] = rows.map((row) => ({
    id: row.leafId,
    title: row.title,
    branchId: row.branchId,
    branchTitle: row.branchTitle,
    ordinal: row.ordinal,
    status: row.status,
  }));
  const branchMap = new Map<
    string,
    KnowledgeBaseProgressDto["branches"][number]
  >();
  for (const leaf of leaves) {
    let branch = branchMap.get(leaf.branchId);
    if (!branch) {
      branch = {
        id: leaf.branchId,
        title: leaf.branchTitle,
        total: 0,
        handled: 0,
        confirmed: 0,
        directPrefilled: 0,
        pending: 0,
        current: 0,
        needsVerification: 0,
        leaves: [],
      };
      branchMap.set(leaf.branchId, branch);
    }
    branch.total += 1;
    branch.leaves.push(leaf);
    if (leaf.status === "confirmed") {
      branch.confirmed += 1;
      branch.handled += 1;
    } else if (leaf.status === "direct_prefilled") {
      branch.directPrefilled += 1;
      branch.handled += 1;
    } else if (leaf.status === "current") {
      branch.current += 1;
    } else if (leaf.status === "needs_verification") {
      branch.needsVerification += 1;
    } else {
      branch.pending += 1;
    }
  }
  const confirmed = leaves.filter((leaf) => leaf.status === "confirmed").length;
  const directPrefilled = leaves.filter(
    (leaf) => leaf.status === "direct_prefilled",
  ).length;
  const pending = leaves.filter((leaf) => leaf.status === "pending").length;
  const current = leaves.filter((leaf) => leaf.status === "current").length;
  const needsVerification = leaves.filter(
    (leaf) => leaf.status === "needs_verification",
  ).length;
  const handled = confirmed + directPrefilled;
  const total = leaves.length;
  return {
    build: {
      id: build.id,
      conversationId: build.conversationId,
      companyName: build.companyName,
      skillVersion: build.skillVersion,
      status: build.status as KnowledgeBaseBuildStatus,
      revision: build.revision,
      currentLeafId: build.currentLeafId,
      logoRequired:
        build.skillVersion === "4" &&
        build.status === "confirming" &&
        build.revision === 0 &&
        build.confirmedCount === 0 &&
        build.directPrefilledCount === 0 &&
        currentBuildRow?.ordinal === 0 &&
        !build.logoSha256,
      protocolError: build.protocolError,
      awaitingResponseSince: build.awaitingResponseSince?.getTime() ?? null,
      updatedAt: build.updatedAt.getTime(),
    },
    summary: {
      total,
      handled,
      confirmed,
      directPrefilled,
      pending,
      current,
      needsVerification,
      overallPercent: total === 0 ? 0 : Math.round((handled / total) * 100),
    },
    branches: [...branchMap.values()],
    packageAllowed:
      total > 0 &&
      handled === total &&
      build.currentLeafId === null &&
      build.status === "ready_to_publish" &&
      build.packageRevision === build.revision &&
      build.packageTaskId === build.upstreamTaskId &&
      Boolean(build.packageOutputItemId) &&
      Boolean(build.packageDescriptorHash) &&
      Boolean(build.packageStorageKey) &&
      /^[a-f0-9]{64}$/u.test(String(build.packageArchiveSha256 || "")) &&
      Number.isSafeInteger(build.packageSizeBytes) &&
      Number(build.packageSizeBytes) > 0,
  };
}

async function loadBuild(
  executor: any,
  userId: number,
  conversationId: string,
  lock = false,
) {
  let query = executor
    .select()
    .from(knowledgeBaseBuilds)
    .where(
      and(
        eq(knowledgeBaseBuilds.userId, userId),
        eq(knowledgeBaseBuilds.conversationId, conversationId),
      ),
    )
    .limit(1);
  if (lock) query = query.for("update");
  const rows = await query;
  return rows[0] as KnowledgeBaseBuild | undefined;
}

async function loadNodes(executor: any, buildId: string) {
  return (await executor
    .select()
    .from(knowledgeBaseBuildNodes)
    .where(eq(knowledgeBaseBuildNodes.buildId, buildId))
    .orderBy(asc(knowledgeBaseBuildNodes.ordinal))) as KnowledgeBaseBuildNode[];
}

export async function createKnowledgeBaseBuild(input: {
  userId: number;
  conversationId: string;
  companyName: string;
  companyWebsite?: string;
  skillName?: string;
  skillVersion?: string;
  skillContentHash?: string;
}) {
  const db = await requireDb();
  const conversationId = normalizeConversationId(input.conversationId);
  const companyName = String(input.companyName || "")
    .trim()
    .slice(0, 255);
  if (!companyName) {
    throw new KnowledgeBaseBuildError(
      "PROGRESS_PROTOCOL_INVALID",
      "企业名称不能为空",
    );
  }
  const build = await db.transaction(async (tx) => {
    const retentionTombstone = (
      await tx
        .select({ id: knowledgeBaseConversationRetentionTombstones.id })
        .from(knowledgeBaseConversationRetentionTombstones)
        .where(
          and(
            eq(
              knowledgeBaseConversationRetentionTombstones.userId,
              input.userId,
            ),
            eq(
              knowledgeBaseConversationRetentionTombstones.publicConversationId,
              conversationId,
            ),
          ),
        )
        .limit(1)
        .for("update")
    )[0];
    if (retentionTombstone) {
      throw new KnowledgeBaseBuildError(
        "BUILD_NOT_FOUND",
        "该知识库会话已过期，请使用新会话重新构建",
      );
    }
    const existing = await loadBuild(tx, input.userId, conversationId, true);
    if (existing) {
      // `/start` is an at-least-once client operation. Replaying it must never
      // delete accepted nodes or silently create a new generation. Explicit
      // reset/restart is owned by the audited reset workflow.
      return existing;
    }
    const id = randomUUID();
    await tx.insert(knowledgeBaseBuilds).values({
      id,
      userId: input.userId,
      conversationId,
      companyName,
      companyWebsite: input.companyWebsite?.trim() || null,
      skillName: input.skillName || "socratic-kb-builder",
      skillVersion: input.skillVersion || "1",
      skillContentHash: input.skillContentHash || null,
      status: "researching",
      awaitingResponseSince: new Date(),
    });
    return (await loadBuild(tx, input.userId, conversationId))!;
  });
  return buildDto(build, await loadNodes(db, build.id));
}

export async function attachKnowledgeBaseBuildTask(input: {
  userId: number;
  conversationId: string;
  taskId: string;
}) {
  const db = await requireDb();
  const conversationId = normalizeConversationId(input.conversationId);
  await db
    .update(knowledgeBaseBuilds)
    .set({ upstreamTaskId: String(input.taskId).slice(0, 255) })
    .where(
      and(
        eq(knowledgeBaseBuilds.userId, input.userId),
        eq(knowledgeBaseBuilds.conversationId, conversationId),
      ),
    );
}

export async function recordKnowledgeBaseTurn(input: {
  userId: number;
  conversationId: string;
  taskId: string;
  userText: string;
  attachmentCount: number;
}) {
  const db = await requireDb();
  const conversationId = normalizeConversationId(input.conversationId);
  const result = await db
    .update(knowledgeBaseBuilds)
    .set({
      upstreamTaskId: String(input.taskId).slice(0, 255),
      lastTurnUserText: String(input.userText || "").slice(0, 2_000_000),
      lastTurnAttachmentCount: Math.max(
        0,
        Math.trunc(input.attachmentCount || 0),
      ),
      awaitingResponseSince: new Date(),
    })
    .where(
      and(
        eq(knowledgeBaseBuilds.userId, input.userId),
        eq(knowledgeBaseBuilds.conversationId, conversationId),
      ),
    );
  if (!result[0]?.affectedRows) {
    throw new KnowledgeBaseBuildError(
      "BUILD_NOT_FOUND",
      "当前对话没有知识库构建记录",
    );
  }
}

/**
 * Atomically locks one customer turn before the non-idempotent upstream task
 * call. This closes the server-side double-click race in addition to the UI
 * lock.
 */
export async function claimKnowledgeBaseTurn(input: {
  userId: number;
  conversationId: string;
  taskId: string;
  userText: string;
  attachmentCount: number;
  expectedRevision?: number;
  expectedLeafId?: string;
}) {
  const db = await requireDb();
  const conversationId = normalizeConversationId(input.conversationId);
  const result = await db
    .update(knowledgeBaseBuilds)
    .set({
      lastTurnUserText: String(input.userText || "").slice(0, 2_000_000),
      lastTurnAttachmentCount: Math.max(
        0,
        Math.trunc(input.attachmentCount || 0),
      ),
      awaitingResponseSince: new Date(),
    })
    .where(
      and(
        eq(knowledgeBaseBuilds.userId, input.userId),
        eq(knowledgeBaseBuilds.conversationId, conversationId),
        eq(knowledgeBaseBuilds.upstreamTaskId, input.taskId),
        eq(knowledgeBaseBuilds.status, "confirming"),
        isNotNull(knowledgeBaseBuilds.currentLeafId),
        isNull(knowledgeBaseBuilds.awaitingResponseSince),
        input.expectedRevision === undefined
          ? undefined
          : eq(knowledgeBaseBuilds.revision, input.expectedRevision),
        input.expectedLeafId
          ? eq(knowledgeBaseBuilds.currentLeafId, input.expectedLeafId)
          : undefined,
      ),
    );
  if (!result[0]?.affectedRows) {
    throw new KnowledgeBaseBuildError(
      "PROGRESS_PROTOCOL_INVALID",
      "当前节点已提交或尚未进入可回复状态，请等待本轮处理完成",
    );
  }
}

export async function releaseKnowledgeBaseTurnClaim(input: {
  userId: number;
  conversationId: string;
  taskId: string;
}) {
  const db = await requireDb();
  await db
    .update(knowledgeBaseBuilds)
    .set({
      awaitingResponseSince: null,
      lastTurnUserText: null,
      lastTurnAttachmentCount: 0,
    })
    .where(
      and(
        eq(knowledgeBaseBuilds.userId, input.userId),
        eq(
          knowledgeBaseBuilds.conversationId,
          normalizeConversationId(input.conversationId),
        ),
        eq(knowledgeBaseBuilds.upstreamTaskId, input.taskId),
        isNotNull(knowledgeBaseBuilds.awaitingResponseSince),
      ),
    );
}

export async function assertKnowledgeBaseTaskBinding(input: {
  userId: number;
  conversationId: string;
  taskId: string;
}) {
  const db = await requireDb();
  const conversationId = normalizeConversationId(input.conversationId);
  const build = await loadBuild(db, input.userId, conversationId);
  if (!build) {
    throw new KnowledgeBaseBuildError(
      "BUILD_NOT_FOUND",
      "当前对话没有知识库构建记录",
    );
  }
  if (!build.upstreamTaskId || build.upstreamTaskId !== input.taskId) {
    throw new KnowledgeBaseBuildError(
      "PROGRESS_PROTOCOL_INVALID",
      "任务与当前知识库构建记录不匹配",
    );
  }
  return build;
}

export async function getKnowledgeBaseProgress(input: {
  userId: number;
  conversationId?: string;
}): Promise<KnowledgeBaseProgressDto | null> {
  const db = await requireDb();
  const buildRows = input.conversationId
    ? await db
        .select()
        .from(knowledgeBaseBuilds)
        .where(
          and(
            eq(knowledgeBaseBuilds.userId, input.userId),
            eq(
              knowledgeBaseBuilds.conversationId,
              normalizeConversationId(input.conversationId),
            ),
          ),
        )
        .limit(1)
    : await db
        .select()
        .from(knowledgeBaseBuilds)
        .where(eq(knowledgeBaseBuilds.userId, input.userId))
        .orderBy(desc(knowledgeBaseBuilds.updatedAt))
        .limit(1);
  const build = buildRows[0];
  if (!build) return null;
  return buildDto(build, await loadNodes(db, build.id));
}

export type KnowledgeBaseObservationProjection = Omit<
  KnowledgeBaseObservationDto,
  "interaction"
> & {
  progress: KnowledgeBaseProgressDto;
};

const KNOWLEDGE_BASE_MAINTENANCE_ONLY_ERROR_CODES = new Set([
  "LEGACY_TASK_REBIND_REQUIRED",
  "LEGACY_CREDENTIAL_REBIND_REQUIRED",
]);

export function knowledgeBaseProtocolErrorIsRetryable(input: {
  status: string;
  code: string;
  activeTurnId: string | null;
}) {
  if (input.status !== "protocol_error") return false;
  if (input.code === "PACKAGE_REBIND_REQUIRED") return true;
  if (KNOWLEDGE_BASE_MAINTENANCE_ONLY_ERROR_CODES.has(input.code)) {
    return false;
  }
  return Boolean(input.activeTurnId);
}

export function knowledgeBaseProtocolErrorAllowsSameTaskRecovery(
  code?: string | null,
) {
  return code === "PACKAGE_REBIND_REQUIRED" || code === "FINAL_PACKAGE_MISSING";
}

/**
 * Reconstruct the exact server-approved presentation from durable state. GET
 * and reconcile use this same projection, so the UI never renders a different
 * upstream snapshot from the one that advanced the revision.
 */
class KnowledgeBaseObservationSnapshotChangedError extends Error {
  constructor() {
    super("Knowledge-base observation changed while its snapshot was read");
    this.name = "KnowledgeBaseObservationSnapshotChangedError";
  }
}

async function readKnowledgeBaseObservationProjection(
  db: any,
  input: {
    userId: number;
    conversationId: string;
  },
): Promise<KnowledgeBaseObservationProjection | null> {
  const conversationId = normalizeConversationId(input.conversationId);
  const persistedConversationId = knowledgeBaseObservationConversationStorageId(
    input.userId,
    conversationId,
  );
  // The caller provides one repeatable-read transaction. The final coordinate
  // check below is a second guard for test adapters or deployments that fail
  // to honor the requested isolation level.
  const build = await loadBuild(db, input.userId, conversationId);
  if (!build) return null;
  const rows = await loadNodes(db, build.id);
  const progress = buildDto(build, rows);
  const currentRow = build.currentLeafId
    ? rows.find((row) => row.leafId === build.currentLeafId) || null
    : null;
  const relevantTurnIds = [
    ...new Set(
      [build.activeTurnId, currentRow?.sourceTurnId].filter(
        (turnId): turnId is string => Boolean(turnId),
      ),
    ),
  ];
  const [activeTurnRow, presentationTurnRow, conversationRow, messageRows] =
    await Promise.all([
      build.activeTurnId
        ? db
            .select()
            .from(conversationTurns)
            .where(
              and(
                eq(conversationTurns.id, build.activeTurnId),
                eq(conversationTurns.userId, input.userId),
                eq(conversationTurns.buildId, build.id),
                eq(conversationTurns.buildGeneration, build.generation),
              ),
            )
            .limit(1)
            .then(
              (values: Array<typeof conversationTurns.$inferSelect>) =>
                values[0] || null,
            )
        : Promise.resolve(null),
      currentRow?.sourceTurnId
        ? db
            .select()
            .from(conversationTurns)
            .where(
              and(
                eq(conversationTurns.id, currentRow.sourceTurnId),
                eq(conversationTurns.userId, input.userId),
                eq(conversationTurns.buildId, build.id),
                eq(conversationTurns.buildGeneration, build.generation),
              ),
            )
            .limit(1)
            .then(
              (values: Array<typeof conversationTurns.$inferSelect>) =>
                values[0] || null,
            )
        : Promise.resolve(null),
      db
        .select({ version: conversations.version })
        .from(conversations)
        .where(
          and(
            eq(conversations.id, persistedConversationId),
            eq(conversations.userId, input.userId),
          ),
        )
        .limit(1)
        .then((values: Array<{ version: number }>) => values[0] || null),
      relevantTurnIds.length > 0
        ? db
            .select({
              turnId: messages.turnId,
              role: messages.role,
              sequence: messages.sequence,
            })
            .from(messages)
            .where(
              and(
                eq(messages.userId, input.userId),
                eq(messages.conversationId, persistedConversationId),
                inArray(messages.turnId, relevantTurnIds),
                isNull(messages.deletedAt),
              ),
            )
        : Promise.resolve([]),
    ]);

  const verifiedBuild = await loadBuild(db, input.userId, conversationId);
  if (
    !verifiedBuild ||
    verifiedBuild.id !== build.id ||
    verifiedBuild.generation !== build.generation ||
    verifiedBuild.stateEpoch !== build.stateEpoch ||
    verifiedBuild.revision !== build.revision ||
    verifiedBuild.status !== build.status ||
    verifiedBuild.currentLeafId !== build.currentLeafId ||
    verifiedBuild.activeTurnId !== build.activeTurnId ||
    verifiedBuild.upstreamTaskId !== build.upstreamTaskId
  ) {
    throw new KnowledgeBaseObservationSnapshotChangedError();
  }

  const customerUploadResources =
    currentRow &&
    presentationTurnRow &&
    presentationTurnRow.id === currentRow.sourceTurnId &&
    presentationTurnRow.expectedLeafId === currentRow.leafId
      ? await knowledgeBaseCustomerUploadResources(
          build.id,
          presentationTurnRow,
        )
      : [];

  return projectKnowledgeBaseObservationSnapshot({
    build,
    progress,
    currentRow,
    activeTurnRow,
    presentationTurnRow,
    customerUploadResources,
    conversationRow,
    messageRows,
  });
}

function projectKnowledgeBaseObservationSnapshot(input: {
  build: KnowledgeBaseBuild;
  progress: KnowledgeBaseProgressDto;
  currentRow: KnowledgeBaseBuildNode | null;
  activeTurnRow: typeof conversationTurns.$inferSelect | null;
  presentationTurnRow: Pick<
    typeof conversationTurns.$inferSelect,
    | "id"
    | "clientRequestId"
    | "expectedLeafId"
    | "attachmentFileIds"
    | "metadata"
    | "status"
  > | null;
  customerUploadResources: KnowledgeBaseApprovedPresentationDto["resources"];
  conversationRow: { version: number } | null;
  messageRows: Array<{
    turnId: string | null;
    role: string;
    sequence: number;
  }>;
}): KnowledgeBaseObservationProjection {
  const {
    build,
    progress,
    currentRow,
    activeTurnRow,
    presentationTurnRow,
    customerUploadResources,
    conversationRow,
    messageRows,
  } = input;
  const messageSequence = (
    turnId: string | null | undefined,
    role: "user" | "assistant",
  ) =>
    turnId
      ? messageRows.find(
          (message) => message.turnId === turnId && message.role === role,
        )?.sequence
      : undefined;
  let activeTurn: KnowledgeBaseActiveTurnDto | null = null;
  const activeTurnMetadata =
    activeTurnRow?.metadata && typeof activeTurnRow.metadata === "object"
      ? (activeTurnRow.metadata as Record<string, unknown>)
      : {};
  const stagedClientAttachments = Array.isArray(
    activeTurnMetadata.clientStagedAttachments,
  )
    ? activeTurnMetadata.clientStagedAttachments.length
    : 0;
  const expectedClientAttachments = Number(
    activeTurnMetadata.userAttachmentCount ?? 0,
  );
  const requiresAttachmentReselection =
    activeTurnMetadata.awaitingClientAttachments === true;
  if (
    activeTurnRow?.operationKey &&
    activeTurnRow.clientRequestId &&
    activeTurnRow.buildGeneration
  ) {
    activeTurn = {
      id: activeTurnRow.id,
      clientRequestId: activeTurnRow.clientRequestId,
      operationKey: activeTurnRow.operationKey,
      operationType: (activeTurnRow.operationType ||
        "legacy_reconcile") as KnowledgeBaseOperationType,
      status: activeTurnRow.status,
      buildGeneration: activeTurnRow.buildGeneration,
      expectedRevision: activeTurnRow.expectedRevision,
      expectedLeafId: activeTurnRow.expectedLeafId,
      startedAt: activeTurnRow.startedAt?.getTime() ?? null,
      completedAt: activeTurnRow.completedAt?.getTime() ?? null,
      updatedAt: activeTurnRow.updatedAt.getTime(),
      requiresAttachmentReselection,
      stagedAttachmentCount: stagedClientAttachments,
      expectedAttachmentCount:
        Number.isSafeInteger(expectedClientAttachments) &&
        expectedClientAttachments >= 0
          ? expectedClientAttachments
          : 0,
      messageSequence: messageSequence(activeTurnRow.id, "user"),
    };
  }

  const presentationOfficialLogoUpload = presentationTurnRow
    ? knowledgeBaseOfficialLogoUploadFromTurn(presentationTurnRow)
    : null;
  const logoResources =
    currentRow?.ordinal === 0 &&
    (build.revision === 0 ||
      (presentationTurnRow?.id === currentRow.sourceTurnId &&
        presentationOfficialLogoUpload?.leafId === currentRow.leafId)) &&
    build.logoStorageKey &&
    build.logoSha256 &&
    build.logoBytes &&
    build.logoFilename &&
    build.logoMimeType
      ? [
          {
            kind: "logo" as const,
            outputItemId: null,
            fileId: null,
            sameOriginUrl: `/api/knowledge-base/artifacts/${encodeURIComponent(build.id)}/logo`,
            filename: build.logoFilename,
            mimeType: build.logoMimeType,
            sha256: build.logoSha256,
            sizeBytes: build.logoBytes,
          },
        ]
      : [];
  const resources = [...logoResources, ...customerUploadResources];
  let approvedPresentation: KnowledgeBaseApprovedPresentationDto | null = null;
  const visibleMarkdown = canonicalKnowledgeBaseMarkdown(
    currentRow?.contentMarkdown || "",
  );
  if (currentRow && visibleMarkdown && (!build.activeTurnId || activeTurnRow)) {
    const contentSha256 =
      currentRow.contentSha256 || knowledgeBaseMarkdownSha256(visibleMarkdown);
    approvedPresentation = {
      turnId:
        currentRow.sourceTurnId ||
        activeTurnRow?.id ||
        `legacy:${build.id}:${build.revision}`,
      clientRequestId:
        presentationTurnRow?.clientRequestId ||
        (!currentRow.sourceTurnId ||
        activeTurnRow?.id === currentRow.sourceTurnId
          ? activeTurnRow?.clientRequestId || null
          : null),
      presentationKey:
        currentRow.presentationKey ||
        build.currentPresentationKey ||
        knowledgePresentationKey({
          buildId: build.id,
          generation: build.generation,
          revision: build.revision,
          leafId: currentRow.leafId,
          contentSha256,
        }),
      revision: build.revision,
      leafId: currentRow.leafId,
      visibleMarkdown,
      contentSha256,
      imageState: resources.length > 0 ? "attached" : "no_eligible_asset",
      resources,
      requestMessageSequence: messageSequence(currentRow.sourceTurnId, "user"),
      messageSequence: messageSequence(currentRow.sourceTurnId, "assistant"),
    };
  }

  let packageDto: KnowledgeBasePackageDto | null = null;
  if (
    build.status === "ready_to_publish" &&
    build.packageRevision === build.revision &&
    build.packageArchiveSha256 &&
    build.packageSizeBytes &&
    build.packageStorageKey
  ) {
    packageDto = {
      revision: build.revision,
      outputItemId: build.packageOutputItemId,
      fileId: build.packageFileId,
      filename: build.packageFilename || "knowledge-base.zip",
      mimeType: "application/zip",
      sha256: build.packageArchiveSha256,
      sizeBytes: build.packageSizeBytes,
      downloadPath: `/api/knowledge-base/artifacts/${encodeURIComponent(build.id)}/package`,
    };
  }

  let notice: KnowledgeBaseNoticeDto | null = null;
  if (requiresAttachmentReselection && activeTurnRow) {
    notice = {
      key: `${build.id}:${build.generation}:${activeTurnRow.id}:attachments-required`,
      code: "KNOWLEDGE_BASE_ATTACHMENTS_REQUIRED",
      severity: "warning",
      message:
        stagedClientAttachments > 0
          ? `正在校验并暂存本轮附件（${stagedClientAttachments}/${expectedClientAttachments}）；完成后会直接提交本轮。`
          : "附件已上传，正在完成完整性校验；校验通过后会直接提交本轮。",
      retryable: false,
      turnId: activeTurnRow.id,
      createdAt: activeTurnRow.updatedAt.getTime(),
    };
  } else if (
    progress.build.logoRequired === true &&
    currentRow?.ordinal === 0 &&
    !activeTurnRow
  ) {
    notice = {
      key: `${build.id}:${build.generation}:official-logo-required`,
      code: "KNOWLEDGE_BASE_LOGO_REQUIRED",
      severity: "warning",
      message:
        "未找到可用的企业官方主 Logo。请上传一张主 Logo 原图后继续；推荐透明 PNG，位图宽高均需至少 256 像素。",
      retryable: false,
      turnId: null,
      createdAt: build.updatedAt.getTime(),
    };
  } else if (build.protocolError) {
    const code = build.protocolErrorCode || "PROGRESS_PROTOCOL_INVALID";
    notice = {
      key: `${build.id}:${build.generation}:${build.stateEpoch}:${code}`,
      code,
      severity: "error",
      message: build.protocolError,
      retryable: knowledgeBaseProtocolErrorIsRetryable({
        status: build.status,
        code,
        activeTurnId: activeTurnRow?.id || null,
      }),
      turnId: activeTurnRow?.id || null,
      createdAt: build.updatedAt.getTime(),
    };
  }

  return {
    progress,
    stateEpoch: build.stateEpoch,
    generation: build.generation,
    // While a newly accepted turn is still preparing its Skill/attachments,
    // build.upstreamTaskId is the completed parent task. Exposing that stale
    // id would make the coordinator reconcile old output during the short
    // accepted-but-unbound window. Only the active turn can be authoritative
    // until it releases the build.
    authoritativeTaskId: activeTurnRow
      ? activeTurnRow.upstreamTaskId
      : build.upstreamTaskId,
    activeTurn,
    approvedPresentation,
    package: packageDto,
    notice,
    conversationVersion: conversationRow?.version ?? null,
  };
}

export async function getKnowledgeBaseObservationProjection(input: {
  userId: number;
  conversationId: string;
}): Promise<KnowledgeBaseObservationProjection | null> {
  const db = await requireDb();
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      return await db.transaction(
        (tx) => readKnowledgeBaseObservationProjection(tx, input),
        { isolationLevel: "repeatable read" },
      );
    } catch (error) {
      if (
        !(error instanceof KnowledgeBaseObservationSnapshotChangedError) ||
        attempt === 1
      ) {
        throw error;
      }
    }
  }
  throw new KnowledgeBaseObservationSnapshotChangedError();
}

function assertActionMatchesTransition(
  action: KnowledgeBaseUserAction,
  target: "confirmed" | "direct_prefilled" | "needs_verification",
) {
  const expected =
    action === "confirm"
      ? "confirmed"
      : action === "direct_prefill"
        ? "direct_prefilled"
        : "needs_verification";
  if (target !== expected) {
    throw new KnowledgeBaseBuildError(
      "PROGRESS_PROTOCOL_INVALID",
      action === "revise"
        ? "当前回复属于补充或修订，节点必须继续停留在对话中等待明确确认"
        : "智能体返回的节点状态与用户本轮选择不一致，本轮未推进",
    );
  }
}

function friendlyProtocolError(error: unknown) {
  if (error instanceof KnowledgeBaseBuildError) return error.message;
  if (error instanceof KnowledgeBaseProgressError) {
    if (error.code === "INVALID_MANIFEST") {
      return "知识树信息尚不完整，请在对话中继续补充或重试本轮";
    }
    if (error.code === "STALE_REVISION") {
      return "本轮内容已处理，无需重复更新";
    }
    if (error.code === "WRONG_LEAF") {
      return "请先完成当前节点，再继续处理其他内容";
    }
    return "当前节点仍需确认或补充，本轮进度未更新";
  }
  return "知识库节点状态校验失败，本轮内容尚未更新";
}

export function isIdempotentKnowledgeBaseReconcileError(error: unknown) {
  return (
    error instanceof KnowledgeBaseProgressError &&
    (error.code === "STALE_REVISION" || error.code === "STALE_OPERATION")
  );
}

function recordKnowledgeInputUnlock(
  build: typeof knowledgeBaseBuilds.$inferSelect,
) {
  if (!build.awaitingResponseSince) return;
  console.info(
    "[KnowledgeBaseInteraction] input_unlocked",
    JSON.stringify({
      buildId: build.id,
      conversationId: build.conversationId,
      revision: build.revision,
      waitMs: Math.max(0, Date.now() - build.awaitingResponseSince.getTime()),
    }),
  );
}

export type KnowledgeBaseProtocolFailureObservation = {
  observationKeyHash: string;
  count: number;
  firstObservedAt: string;
  lastObservedAt: string;
};

function protocolFailureObservation(value: unknown) {
  if (!isRecord(value)) return null;
  const observationKeyHash = String(value.observationKeyHash || "");
  const count = Number(value.count);
  const firstObservedAt = String(value.firstObservedAt || "");
  const lastObservedAt = String(value.lastObservedAt || "");
  if (
    !/^[a-f0-9]{64}$/u.test(observationKeyHash) ||
    !Number.isSafeInteger(count) ||
    count < 1 ||
    !Number.isFinite(Date.parse(firstObservedAt)) ||
    !Number.isFinite(Date.parse(lastObservedAt))
  ) {
    return null;
  }
  return {
    observationKeyHash,
    count,
    firstObservedAt,
    lastObservedAt,
  } satisfies KnowledgeBaseProtocolFailureObservation;
}

export function advanceKnowledgeBaseProtocolFailureObservation(input: {
  previous?: unknown;
  observationKey: string;
  observedAt: Date;
}) {
  const observedAt = new Date(input.observedAt);
  if (!Number.isFinite(observedAt.getTime())) {
    throw new TypeError("observedAt must be a valid date");
  }
  const observationKeyHash = createHash("sha256")
    .update(String(input.observationKey || ""), "utf8")
    .digest("hex");
  const previous = protocolFailureObservation(input.previous);
  const isSame = previous?.observationKeyHash === observationKeyHash;
  const firstObservedAt = isSame
    ? new Date(previous.firstObservedAt)
    : observedAt;
  const observation = {
    observationKeyHash,
    count: isSame ? Math.min(previous.count + 1, 1_000_000) : 1,
    firstObservedAt: firstObservedAt.toISOString(),
    lastObservedAt: observedAt.toISOString(),
  } satisfies KnowledgeBaseProtocolFailureObservation;
  return {
    observation,
    shouldPersist:
      observation.count >= 3 &&
      observedAt.getTime() - firstObservedAt.getTime() >= 10_000,
  };
}

/**
 * Observe one settled protocol/artifact failure. A single partial or replaced
 * snapshot cannot poison a build: only three identical observations spanning
 * at least ten seconds become one durable notice. The counter lives on the
 * authoritative turn reservation and therefore survives process restarts.
 */
export async function observeKnowledgeBaseProtocolFailure(input: {
  userId: number;
  conversationId: string;
  observationKey: string;
  message: string;
  code?: string;
  status?: "protocol_error" | "failed";
  /** Exact task owned by the currently active turn, when already bound. */
  taskId?: string;
  observedAt?: Date;
  /**
   * Use only for an immutable, settled provider result whose protocol failure
   * is already conclusive (for example, an acknowledgement-only response).
   * Ordinary resource/protocol snapshots must retain the multi-observation
   * debounce because providers can replace an incomplete settled snapshot.
   */
  definitive?: boolean;
}): Promise<boolean> {
  const db = await requireDb();
  const conversationId = normalizeConversationId(input.conversationId);
  const observedAt = input.observedAt ?? new Date();
  const message = String(input.message || "")
    .trim()
    .slice(0, 10_000);
  return db.transaction(async (tx) => {
    const build = await loadBuild(tx, input.userId, conversationId, true);
    if (
      !build ||
      build.status === "ready_to_publish" ||
      build.status === "published"
    ) {
      return false;
    }
    if (build.status === "protocol_error" || build.status === "failed") {
      // One build generation exposes one stable error notice. A retry creates
      // a new reservation instead of replacing the accepted notice in place.
      return false;
    }

    // Only an operation which still owns activeTurnId may poison state. A
    // completed turn retained through lastAppliedOperationKey is provenance,
    // never failure authority. This locked coordinate check also makes stale
    // task/generation observations semantic no-ops.
    if (!build.activeTurnId) return false;
    const turn = (
      await tx
        .select()
        .from(conversationTurns)
        .where(
          and(
            eq(conversationTurns.id, build.activeTurnId),
            eq(conversationTurns.userId, input.userId),
            eq(conversationTurns.buildId, build.id),
            eq(conversationTurns.buildGeneration, build.generation),
          ),
        )
        .limit(1)
        .for("update")
    )[0] as ConversationTurn | undefined;
    if (
      !turn ||
      (turn.status !== "queued" && turn.status !== "running") ||
      (input.taskId &&
        (build.upstreamTaskId !== input.taskId ||
          turn.upstreamTaskId !== input.taskId))
    ) {
      return false;
    }

    const metadata = isRecord(turn.metadata) ? turn.metadata : {};
    const recovery = isRecord(metadata.recovery) ? metadata.recovery : {};
    const advanced = advanceKnowledgeBaseProtocolFailureObservation({
      previous: recovery.protocolFailureObservation,
      observationKey: input.observationKey,
      observedAt,
    });
    const nextMetadata = {
      ...metadata,
      recovery: {
        ...recovery,
        protocolFailureObservation: advanced.observation,
      },
    };
    if (!input.definitive && !advanced.shouldPersist) {
      await tx
        .update(conversationTurns)
        .set({ metadata: nextMetadata, updatedAt: observedAt })
        .where(eq(conversationTurns.id, turn.id));
      return false;
    }

    const failureStatus = input.status ?? "protocol_error";
    const failureCode = String(input.code || "PROGRESS_PROTOCOL_INVALID").slice(
      0,
      128,
    );
    await tx
      .update(knowledgeBaseBuilds)
      .set({
        status: failureStatus,
        stateEpoch: build.stateEpoch + 1,
        protocolErrorCode: failureCode,
        protocolError: message || "知识库节点状态校验失败，本轮内容尚未更新",
        awaitingResponseSince: null,
        updatedAt: observedAt,
      })
      .where(eq(knowledgeBaseBuilds.id, build.id));
    await tx
      .update(conversationTurns)
      .set({
        metadata: nextMetadata,
        status: "failed",
        errorCode: failureCode,
        errorMessage: message || null,
        completedAt: observedAt,
        leaseExpiresAt: null,
        updatedAt: observedAt,
      })
      .where(eq(conversationTurns.id, turn.id));
    await markKnowledgeBaseConversationFailedInTransaction({
      tx,
      userId: input.userId,
      conversationId: knowledgeBaseObservationConversationStorageId(
        input.userId,
        conversationId,
      ),
      authoritativeTaskId: turn.upstreamTaskId || build.upstreamTaskId,
      failedAt: observedAt,
    });
    return true;
  });
}

/**
 * Re-open only the exact failed final turn when its provider task later gains
 * a ZIP resource. The caller must first observe an archive descriptor in the
 * same task snapshot. This does not accept the final node or package: it only
 * restores the original authority long enough for the normal download,
 * schema, hash, operation, revision and immutable-storage checks to run.
 */
export async function resumeKnowledgeBaseFinalPackageMissing(input: {
  userId: number;
  conversationId: string;
  taskId: string;
  output: unknown;
  resumedAt?: Date;
}): Promise<boolean> {
  const db = await requireDb();
  const conversationId = normalizeConversationId(input.conversationId);
  const taskId = String(input.taskId || "").trim();
  if (!taskId) return false;
  const resumedAt = input.resumedAt ?? new Date();
  return db.transaction(async (tx) => {
    const build = await loadBuild(tx, input.userId, conversationId, true);
    if (
      !build ||
      build.status !== "protocol_error" ||
      build.protocolErrorCode !== "FINAL_PACKAGE_MISSING" ||
      !build.activeTurnId ||
      build.upstreamTaskId !== taskId
    ) {
      return false;
    }
    const turn = (
      await tx
        .select()
        .from(conversationTurns)
        .where(
          and(
            eq(conversationTurns.id, build.activeTurnId),
            eq(conversationTurns.userId, input.userId),
            eq(conversationTurns.buildId, build.id),
            eq(conversationTurns.buildGeneration, build.generation),
          ),
        )
        .limit(1)
        .for("update")
    )[0] as ConversationTurn | undefined;
    if (
      !turn ||
      turn.status !== "failed" ||
      turn.errorCode !== "FINAL_PACKAGE_MISSING" ||
      turn.upstreamTaskId !== taskId ||
      !turn.operationKey
    ) {
      return false;
    }
    const operationOutput = selectKnowledgeBaseProtocolOperationOutput(
      Array.isArray(input.output) ? input.output : [],
      {
        operationId: turn.operationKey,
        turnId: turn.id,
        taskId,
        generation: build.generation,
        stateKind: "frontmind.knowledge-base.progress",
      },
      { requireExplicitResourceOperation: true },
    );
    const action = classifyKnowledgeBaseUserAction(
      build.lastTurnUserText || "",
      build.lastTurnAttachmentCount || 0,
    );
    const transitionTarget =
      action === "confirm"
        ? ("confirmed" as const)
        : action === "direct_prefill"
          ? ("direct_prefilled" as const)
          : undefined;
    const rows = await loadNodes(tx, build.id);
    const finalizationPlan = deriveKnowledgeBaseAuthoritativeFinalizationPlan({
      build: { ...build, status: "confirming" },
      activeTurn: { ...turn, status: "running" },
      nodes: rows.map((node) => ({
        leafId: node.leafId,
        title: node.title,
        branchId: node.branchId,
        branchTitle: node.branchTitle,
        ordinal: node.ordinal,
        status: node.status,
        contentMarkdown: node.contentMarkdown,
        contentSha256: node.contentSha256,
      })),
      transitionTarget,
    });
    if (
      !finalizationPlan ||
      !selectKnowledgeBaseAuthoritativeFinalDescriptor({
        output: input.output,
        scopedOutput: operationOutput,
        plan: finalizationPlan,
      })
    ) {
      // Cumulative provider output may still contain an older operation's ZIP.
      // It is never authority to revive this failed final turn.
      return false;
    }

    const metadata = isRecord(turn.metadata) ? turn.metadata : {};
    const recovery = isRecord(metadata.recovery) ? metadata.recovery : {};
    const { protocolFailureObservation: _discarded, ...nextRecovery } =
      recovery;
    const nextMetadata = { ...metadata, recovery: nextRecovery };

    await tx
      .update(knowledgeBaseBuilds)
      .set({
        status: "confirming",
        stateEpoch: build.stateEpoch + 1,
        protocolErrorCode: null,
        protocolError: null,
        awaitingResponseSince: resumedAt,
        completedAt: null,
        updatedAt: resumedAt,
      })
      .where(
        and(
          eq(knowledgeBaseBuilds.id, build.id),
          eq(knowledgeBaseBuilds.userId, input.userId),
          eq(knowledgeBaseBuilds.generation, build.generation),
          eq(knowledgeBaseBuilds.stateEpoch, build.stateEpoch),
          eq(knowledgeBaseBuilds.activeTurnId, turn.id),
          eq(knowledgeBaseBuilds.upstreamTaskId, taskId),
          eq(knowledgeBaseBuilds.status, "protocol_error"),
          eq(knowledgeBaseBuilds.protocolErrorCode, "FINAL_PACKAGE_MISSING"),
        ),
      );
    await tx
      .update(conversationTurns)
      .set({
        metadata: nextMetadata,
        status: "running",
        errorCode: null,
        errorMessage: null,
        completedAt: null,
        leaseExpiresAt: null,
        updatedAt: resumedAt,
      })
      .where(
        and(
          eq(conversationTurns.id, turn.id),
          eq(conversationTurns.status, "failed"),
          eq(conversationTurns.errorCode, "FINAL_PACKAGE_MISSING"),
          eq(conversationTurns.upstreamTaskId, taskId),
        ),
      );

    const persistedConversationId =
      knowledgeBaseObservationConversationStorageId(
        input.userId,
        conversationId,
      );
    const conversation = (
      await tx
        .select()
        .from(conversations)
        .where(
          and(
            eq(conversations.id, persistedConversationId),
            eq(conversations.userId, input.userId),
          ),
        )
        .limit(1)
        .for("update")
    )[0];
    if (conversation) {
      await tx
        .update(conversations)
        .set({
          status: "running",
          upstreamTaskId: taskId,
          previousResponseId: taskId,
          version: conversation.version + 1,
          completedAt: null,
          updatedAt: resumedAt,
        })
        .where(
          and(
            eq(conversations.id, persistedConversationId),
            eq(conversations.userId, input.userId),
            eq(conversations.version, conversation.version),
          ),
        );
    }

    const reboundBuild = await loadBuild(
      tx,
      input.userId,
      conversationId,
      true,
    );
    const reboundTurn = (
      await tx
        .select()
        .from(conversationTurns)
        .where(eq(conversationTurns.id, turn.id))
        .limit(1)
        .for("update")
    )[0] as ConversationTurn | undefined;
    return Boolean(
      reboundBuild?.status === "confirming" &&
        reboundBuild.stateEpoch === build.stateEpoch + 1 &&
        reboundBuild.activeTurnId === turn.id &&
        reboundBuild.upstreamTaskId === taskId &&
        !reboundBuild.protocolErrorCode &&
        reboundTurn?.status === "running" &&
        reboundTurn.upstreamTaskId === taskId &&
        !reboundTurn.errorCode,
    );
  });
}

function knowledgeBaseProtocolFailureObservationKey(input: {
  taskId?: string;
  output: unknown;
  upstreamStatus?: unknown;
  error: unknown;
}) {
  const assistantText = extractAuthoritativeKnowledgeBaseAssistantText(
    input.output,
  );
  const imageKeys = [
    ...collectKnowledgeBaseOutputImageKeys(input.output),
  ].sort();
  const archiveKeys = collectKnowledgeArchiveDescriptors(input.output)
    .map((descriptor) => ({
      outputItemId: descriptor.outputItemId,
      fileId: descriptor.fileId || null,
      filename: descriptor.filename,
      mimeType: descriptor.mimeType,
    }))
    .sort((left, right) =>
      JSON.stringify(left).localeCompare(JSON.stringify(right)),
    );
  const errorCode =
    input.error instanceof KnowledgeBaseProgressError ||
    input.error instanceof KnowledgeBaseBuildError
      ? input.error.code
      : input.error instanceof Error
        ? input.error.name
        : "UNKNOWN";
  return createHash("sha256")
    .update(
      JSON.stringify({
        taskId: input.taskId || null,
        phase: classifyKnowledgeBaseUpstreamTaskStatus(input.upstreamStatus)
          .phase,
        assistantText: canonicalKnowledgeBaseMarkdown(assistantText),
        imageKeys,
        archiveKeys,
        errorCode,
      }),
      "utf8",
    )
    .digest("hex");
}

async function finishLegacyKnowledgeBaseReconcileNoop(input: {
  tx: any;
  userId: number;
  conversationId: string;
  build: KnowledgeBaseBuild;
  rows: KnowledgeBaseBuildNode[];
  activeTurn?: ConversationTurn;
}) {
  const { activeTurn, build } = input;
  if (
    !activeTurn?.operationKey ||
    activeTurn.operationType !== "legacy_reconcile"
  ) {
    return false;
  }
  const persistedConversationId = knowledgeBaseObservationConversationStorageId(
    input.userId,
    input.conversationId,
  );
  let currentPresentationKey = build.currentPresentationKey;
  if (build.currentLeafId) {
    const current = input.rows.find(
      (row) => row.leafId === build.currentLeafId,
    );
    const content = canonicalKnowledgeBaseMarkdown(
      current?.contentMarkdown || "",
    );
    if (!current || !content) return false;
    const contentSha256 =
      current.contentSha256 || knowledgeBaseMarkdownSha256(content);
    currentPresentationKey =
      current.presentationKey ||
      knowledgePresentationKey({
        buildId: build.id,
        generation: build.generation,
        revision: build.revision,
        leafId: current.leafId,
        contentSha256,
      });
    await input.tx
      .update(knowledgeBaseBuildNodes)
      .set({
        contentMarkdown: content,
        contentSha256,
        presentationKey: currentPresentationKey,
        sourceTurnId: activeTurn.id,
      })
      .where(eq(knowledgeBaseBuildNodes.id, current.id));
    await persistKnowledgeBasePresentationInTransaction({
      tx: input.tx,
      userId: input.userId,
      conversationId: persistedConversationId,
      turnId: activeTurn.id,
      buildId: build.id,
      generation: build.generation,
      operationKey: activeTurn.operationKey,
      presentationKey: currentPresentationKey,
      revision: build.revision,
      leafId: current.leafId,
      content,
      authoritativeTaskId: activeTurn.upstreamTaskId || build.upstreamTaskId,
      sentAt: new Date(),
    });
  } else if (
    input.rows.length > 0 &&
    input.rows.every(
      (row) => row.status === "confirmed" || row.status === "direct_prefilled",
    )
  ) {
    await markKnowledgeBaseConversationCompletedInTransaction({
      tx: input.tx,
      userId: input.userId,
      conversationId: persistedConversationId,
      authoritativeTaskId: activeTurn.upstreamTaskId || build.upstreamTaskId,
      completedAt: new Date(),
    });
  } else {
    return false;
  }
  await input.tx
    .update(conversationTurns)
    .set({
      status: "completed",
      completedAt: new Date(),
      leaseExpiresAt: null,
      errorCode: null,
      errorMessage: null,
    })
    .where(eq(conversationTurns.id, activeTurn.id));
  await input.tx
    .update(knowledgeBaseBuilds)
    .set({
      activeTurnId: null,
      lastAppliedOperationKey: activeTurn.operationKey,
      currentPresentationKey,
      stateEpoch: build.stateEpoch + 1,
      awaitingResponseSince: null,
      protocolError: null,
      protocolErrorCode: null,
    })
    .where(
      and(
        eq(knowledgeBaseBuilds.id, build.id),
        eq(knowledgeBaseBuilds.generation, build.generation),
        eq(knowledgeBaseBuilds.activeTurnId, activeTurn.id),
      ),
    );
  return true;
}

async function finishLegacyKnowledgeBaseReconcileNoopByConversation(input: {
  userId: number;
  conversationId: string;
}) {
  const db = await requireDb();
  return db.transaction(async (tx) => {
    const build = await loadBuild(
      tx,
      input.userId,
      normalizeConversationId(input.conversationId),
      true,
    );
    if (!build?.activeTurnId) return false;
    const activeTurn = (
      await tx
        .select()
        .from(conversationTurns)
        .where(
          and(
            eq(conversationTurns.id, build.activeTurnId),
            eq(conversationTurns.userId, input.userId),
            eq(conversationTurns.buildId, build.id),
            eq(conversationTurns.buildGeneration, build.generation),
          ),
        )
        .limit(1)
        .for("update")
    )[0];
    return finishLegacyKnowledgeBaseReconcileNoop({
      tx,
      userId: input.userId,
      conversationId: build.conversationId,
      build,
      rows: await loadNodes(tx, build.id),
      activeTurn,
    });
  });
}

export async function reconcileKnowledgeBaseProgress(input: {
  userId: number;
  conversationId: string;
  taskId?: string;
  userText?: string;
  attachmentCount?: number;
  output: unknown;
  upstreamStatus?: unknown;
  outputState?: {
    totalLength: number;
    itemIds: string[];
  };
  stagedArtifacts?: KnowledgeBaseStagedArtifacts;
}) {
  const db = await requireDb();
  const conversationId = normalizeConversationId(input.conversationId);
  const outputLedger = {
    lastOutputLength: Math.max(
      0,
      Math.trunc(input.outputState?.totalLength || 0),
    ),
    lastOutputItemIds: (input.outputState?.itemIds || []).slice(-5_000),
  };

  try {
    return await db.transaction(async (tx) => {
      let build = await loadBuild(tx, input.userId, conversationId, true);
      if (!build) {
        throw new KnowledgeBaseBuildError(
          "BUILD_NOT_FOUND",
          "当前对话没有知识库构建记录",
        );
      }
      let rows = await loadNodes(tx, build.id);
      const activeTurn = build.activeTurnId
        ? (
            await tx
              .select()
              .from(conversationTurns)
              .where(
                and(
                  eq(conversationTurns.id, build.activeTurnId),
                  eq(conversationTurns.userId, input.userId),
                  eq(conversationTurns.buildId, build.id),
                  eq(conversationTurns.buildGeneration, build.generation),
                ),
              )
              .limit(1)
              .for("update")
          )[0]
        : undefined;
      const stagedEntries = (
        [
          ["logo", input.stagedArtifacts?.logo],
          ["package", input.stagedArtifacts?.package],
        ] as const
      ).filter(
        (
          entry,
        ): entry is readonly [
          "logo" | "package",
          KnowledgeBaseStagedArtifactCandidate,
        ] => Boolean(entry[1]),
      );
      if (
        stagedEntries.some(
          ([kind, candidate]) =>
            !knowledgeBaseStagedArtifactMatchesAuthority({
              candidate,
              kind,
              userId: input.userId,
              build: build!,
              activeTurn,
              taskId: input.taskId,
            }),
        )
      ) {
        // Download can race a retry/reset in another process. A candidate from
        // the superseded operation is only an orphan file; it has no authority
        // to parse or mutate the current turn.
        return buildDto(build, rows);
      }
      const successfulTurnIdentity = knowledgeBaseSuccessfulTurnIdentity({
        activeTurnId: build.activeTurnId,
        operationKey: activeTurn?.operationKey,
        lastAppliedOperationKey: build.lastAppliedOperationKey,
      });
      // Published/package-ready builds are immutable projections. Background
      // polling of an older task must not reopen or poison the accepted build.
      if (build.status === "ready_to_publish" || build.status === "published") {
        return buildDto(build, rows);
      }
      // A reset/restart can leave an old browser poll in flight. Re-check the
      // task binding under the same row lock used for all state mutations.
      if (
        input.taskId &&
        build.upstreamTaskId &&
        input.taskId !== build.upstreamTaskId
      ) {
        return buildDto(build, rows);
      }
      // A v4 response is authorized by the active reservation, not merely by
      // the task id. Once a turn has been applied, cumulative/full snapshots
      // of that same task are ordinary at-least-once replays. In particular,
      // an old first-turn Logo can make the provider's raw output hash differ
      // from the earlier tail snapshot; it must not reopen protocol parsing or
      // poison the already-approved node after activeTurnId was released.
      if (build.skillVersion === "4" && !activeTurn?.operationKey) {
        if (
          build.activeTurnId === null &&
          Boolean(build.lastAppliedOperationKey)
        ) {
          return buildDto(build, rows);
        }
        throw new KnowledgeBaseBuildError(
          "PROGRESS_PROTOCOL_INVALID",
          build.activeTurnId
            ? "当前 v4 turn reservation 已损坏，拒绝应用上游输出"
            : "当前 v4 输出没有可证明已应用或仍有效的 turn reservation",
        );
      }

      const userText =
        input.userText !== undefined
          ? String(input.userText)
          : String(build.lastTurnUserText || "");
      const attachmentCount =
        input.attachmentCount !== undefined
          ? Math.max(0, Math.trunc(input.attachmentCount || 0))
          : Math.max(0, build.lastTurnAttachmentCount || 0);
      const action = classifyKnowledgeBaseUserAction(userText, attachmentCount);

      // Providers may return the complete task history in any poll. Select
      // only the active operation/turn window before extracting Markdown,
      // resources or calculating the semantic reconciliation hash. Later
      // turns require explicit image ownership so an unscoped Logo from the
      // initial Manifest can never be attributed to a confirmation turn.
      const protocolScopedOutput =
        build.skillVersion === "4" && activeTurn?.operationKey
          ? selectKnowledgeBaseProtocolOperationOutput(
              Array.isArray(input.output) ? input.output : [],
              {
                operationId: activeTurn.operationKey,
                turnId: activeTurn.id,
                taskId:
                  input.taskId ||
                  activeTurn.upstreamTaskId ||
                  build.upstreamTaskId ||
                  undefined,
                generation: build.generation,
                stateKind:
                  rows.length === 0
                    ? "frontmind.knowledge-base.manifest"
                    : "frontmind.knowledge-base.progress",
              },
              {
                requireExplicitResourceOperation: rows.length > 0,
              },
            )
          : input.output;
      const transitionTarget =
        action === "confirm"
          ? ("confirmed" as const)
          : action === "direct_prefill"
            ? ("direct_prefilled" as const)
            : undefined;
      const finalizationPlan = deriveKnowledgeBaseAuthoritativeFinalizationPlan(
        {
          build,
          activeTurn,
          nodes: rows.map((node) => ({
            leafId: node.leafId,
            title: node.title,
            branchId: node.branchId,
            branchTitle: node.branchTitle,
            ordinal: node.ordinal,
            status: node.status,
            contentMarkdown: node.contentMarkdown,
            contentSha256: node.contentSha256,
          })),
          transitionTarget,
        },
      );
      const finalDescriptor =
        finalizationPlan && input.stagedArtifacts?.package
          ? selectKnowledgeBaseAuthoritativeFinalDescriptor({
              output: input.output,
              scopedOutput: protocolScopedOutput,
              plan: finalizationPlan,
            })
          : null;
      const scopedProtocolComplete = finalizationPlan
        ? hasKnowledgeBaseCompleteFinalProtocol({
            assistantText:
              extractFinalKnowledgeBaseAssistantText(protocolScopedOutput),
            plan: finalizationPlan,
          })
        : false;
      const authoritativeOutput =
        finalizationPlan &&
        finalDescriptor &&
        !scopedProtocolComplete &&
        input.stagedArtifacts?.package?.sourceDescriptorHash ===
          knowledgeArchivePhysicalDescriptorHash(finalDescriptor)
          ? createKnowledgeBaseAuthoritativeFinalOutput({
              descriptor: finalDescriptor,
              plan: finalizationPlan,
            })
          : protocolScopedOutput;
      const text = assertKnowledgeBaseCustomerOutput(authoritativeOutput);
      const audit = modelOutputAudit(text);
      const hash = reconciliationHash({
        taskId: input.taskId || build.upstreamTaskId || undefined,
        assistantText: text,
        output: authoritativeOutput,
        userText,
        attachmentCount,
      });
      if (build.lastReconciledHash === hash) {
        if (
          await finishLegacyKnowledgeBaseReconcileNoop({
            tx,
            userId: input.userId,
            conversationId,
            build,
            rows,
            activeTurn,
          })
        ) {
          build = (await loadBuild(tx, input.userId, conversationId))!;
          rows = await loadNodes(tx, build.id);
        }
        return buildDto(build, rows);
      }

      if (rows.length === 0) {
        // The first visible user bubble contains the start command and company
        // details, so it is intentionally non-empty. A valid signed manifest
        // is authoritative for initialization and makes a failed first parse
        // recoverable on the next server-side task check.
        const manifest = parseKnowledgeBaseManifestEnvelope(text);
        assertEnvelopeBelongsToActiveTurn({
          build,
          activeTurn,
          envelope: manifest,
        });
        const initialImageCount = assertKnowledgeBaseInitialImageDelivery(
          authoritativeOutput,
          build.skillVersion === "4"
            ? {
                operationId: activeTurn?.operationKey || "",
                turnId: activeTurn?.id || "",
                taskId: input.taskId || build.upstreamTaskId || undefined,
                generation: build.generation,
              }
            : undefined,
          {
            allowMissing:
              build.skillVersion === "4" &&
              classifyKnowledgeBaseUpstreamTaskStatus(input.upstreamStatus)
                .settled,
          },
        );
        const stagedLogo = input.stagedArtifacts?.logo;
        if (build.skillVersion === "4") {
          const descriptors =
            collectTrustedKnowledgeBaseOutputImageDescriptors(
              authoritativeOutput,
            );
          if (
            initialImageCount === 1 &&
            (!stagedLogo ||
              descriptors.length !== 1 ||
              stagedLogo.descriptorHash !==
                knowledgeBaseOutputImageDescriptorHash(descriptors[0]!))
          ) {
            throw new KnowledgeBaseBuildError(
              "PROGRESS_PROTOCOL_INVALID",
              "首轮官方主 Logo 尚未完成当前操作级暂存与字节校验",
            );
          }
          if (initialImageCount === 0 && stagedLogo) {
            throw new KnowledgeBaseBuildError(
              "PROGRESS_PROTOCOL_INVALID",
              "首轮 Logo 暂存结果与当前操作输出不一致",
            );
          }
        }
        const state = createKnowledgeBaseProgressState(manifest.leaves);
        const initialLeaf = state.leaves.find(
          (leaf) => leaf.id === state.currentLeafId,
        )!;
        const initialContent = projectKnowledgeBasePresentationMarkdown({
          markdown: audit.contentMarkdown,
          leafId: initialLeaf.id,
          leafTitle: initialLeaf.title,
          leafIds: state.leaves.map((leaf) => leaf.id),
        });
        if (!initialContent) {
          throw new KnowledgeBaseBuildError(
            "PROGRESS_PROTOCOL_INVALID",
            "首个知识节点缺少可展示正文，本轮未推进",
          );
        }
        const initialContentSha256 =
          knowledgeBaseMarkdownSha256(initialContent);
        const initialPresentationKey = knowledgePresentationKey({
          buildId: build.id,
          generation: build.generation,
          revision: state.revision,
          leafId: state.currentLeafId!,
          contentSha256: initialContentSha256,
        });
        await tx.insert(knowledgeBaseBuildNodes).values(
          state.leaves.map((leaf, index) => ({
            id: randomUUID(),
            buildId: build!.id,
            leafId: leaf.id,
            branchId: leaf.branchId!,
            branchTitle: leaf.branchTitle!,
            title: leaf.title,
            ordinal: index,
            status: leaf.status,
            ...(index === 0
              ? {
                  contentMarkdown: initialContent,
                  sourceTurnId: successfulTurnIdentity.sourceTurnId,
                  presentationKey: initialPresentationKey,
                  contentSha256: initialContentSha256,
                  lastUserInput: userText || null,
                  sourceUrls: audit.sourceUrls,
                  imageUrls: audit.imageUrls,
                  lastTaskId: input.taskId?.slice(0, 255) || null,
                  lastResponseAt: new Date(),
                }
              : {}),
          })),
        );
        if (activeTurn?.operationKey) {
          await persistKnowledgeBasePresentationInTransaction({
            tx,
            userId: input.userId,
            conversationId: knowledgeBaseObservationConversationStorageId(
              input.userId,
              conversationId,
            ),
            turnId: activeTurn.id,
            buildId: build.id,
            generation: build.generation,
            operationKey: activeTurn.operationKey,
            presentationKey: initialPresentationKey,
            revision: state.revision,
            leafId: state.currentLeafId!,
            content: initialContent,
            authoritativeTaskId:
              input.taskId?.slice(0, 255) || build.upstreamTaskId,
            sentAt: new Date(),
          });
        }
        const initialBuildUpdate = await tx
          .update(knowledgeBaseBuilds)
          .set({
            upstreamTaskId: input.taskId?.slice(0, 255) || build.upstreamTaskId,
            status: "confirming",
            stateEpoch: build.stateEpoch + 1,
            activeTurnId: successfulTurnIdentity.activeTurnId,
            currentPresentationKey: initialPresentationKey,
            lastAppliedOperationKey:
              successfulTurnIdentity.lastAppliedOperationKey,
            revision: state.revision,
            currentLeafId: state.currentLeafId,
            totalNodeCount: state.leaves.length,
            confirmedCount: 0,
            directPrefilledCount: 0,
            needsVerificationCount: 0,
            lastReconciledHash: hash,
            ...outputLedger,
            protocolError: null,
            protocolErrorCode: null,
            awaitingResponseSince: null,
            ...(stagedLogo
              ? {
                  logoStorageKey: stagedLogo.storageKey,
                  logoSha256: stagedLogo.sha256,
                  logoBytes: stagedLogo.bytes,
                  logoFilename: stagedLogo.filename,
                  logoMimeType: stagedLogo.mimeType,
                }
              : {}),
          })
          .where(
            and(
              eq(knowledgeBaseBuilds.id, build.id),
              eq(knowledgeBaseBuilds.userId, input.userId),
              eq(knowledgeBaseBuilds.generation, build.generation),
              eq(knowledgeBaseBuilds.stateEpoch, build.stateEpoch),
              build.skillVersion === "4" && activeTurn
                ? eq(knowledgeBaseBuilds.activeTurnId, activeTurn.id)
                : undefined,
              input.taskId
                ? eq(knowledgeBaseBuilds.upstreamTaskId, input.taskId)
                : undefined,
              eq(knowledgeBaseBuilds.revision, build.revision),
              eq(knowledgeBaseBuilds.status, build.status),
            ),
          );
        if (
          build.skillVersion === "4" &&
          !initialBuildUpdate[0]?.affectedRows
        ) {
          throw new KnowledgeBaseProgressError(
            "STALE_OPERATION",
            "首轮操作已被新的权威状态替换",
          );
        }
        if (activeTurn) {
          await tx
            .update(conversationTurns)
            .set({
              status: "completed",
              completedAt: new Date(),
              leaseExpiresAt: null,
              errorCode: null,
              errorMessage: null,
            })
            .where(eq(conversationTurns.id, activeTurn.id));
        }
        recordKnowledgeInputUnlock(build);
        build = (await loadBuild(tx, input.userId, conversationId))!;
        rows = await loadNodes(tx, build.id);
        return buildDto(build, rows);
      }

      if (
        build.currentLeafId === null &&
        rows.every(
          (row) =>
            row.status === "confirmed" || row.status === "direct_prefilled",
        )
      ) {
        // v4 has no reopen transition. Once all leaves are handled, delayed
        // output is an immutable no-op; post-completion changes use a
        // maintenance ticket instead of mutating this build generation.
        if (build.skillVersion === "4") {
          return buildDto(build, rows);
        }
        if (action !== "revise") {
          throw new KnowledgeBaseBuildError(
            "PROGRESS_PROTOCOL_INVALID",
            "知识库已完成；如需更新，请直接说明要补充或修改的内容",
          );
        }
        const reopen = parseKnowledgeBaseReopenEnvelope(text);
        if (reopen.revision !== build.revision) {
          throw new KnowledgeBaseBuildError(
            "PROGRESS_PROTOCOL_INVALID",
            "本轮修订基于旧版本，请重新提交最新内容",
          );
        }
        const target = rows.find((row) => row.leafId === reopen.leafId);
        if (!target) {
          throw new KnowledgeBaseBuildError(
            "PROGRESS_PROTOCOL_INVALID",
            "本轮内容未匹配到现有知识节点，请补充更具体的修改对象",
          );
        }
        if (build.skillVersion === "3") {
          const reopenedRows = rows.map((row) =>
            row.id === target.id
              ? { ...row, status: "needs_verification" as const }
              : row,
          );
          const expectedReopenedState = stateFromRows(
            {
              ...build,
              revision: build.revision + 1,
              currentLeafId: target.leafId,
            },
            reopenedRows,
          );
          const presentation = assertKnowledgeBasePresentationMatchesState(
            expectedReopenedState,
            text,
          );
          assertKnowledgeBaseNodeImageDelivery({
            presentation,
            output: input.output,
          });
        }
        const reopenedContent = audit.contentMarkdown
          ? projectKnowledgeBasePresentationMarkdown({
              markdown: audit.contentMarkdown,
              leafId: target.leafId,
              leafTitle: target.title,
              leafIds: rows.map((row) => row.leafId),
            })
          : canonicalKnowledgeBaseMarkdown(target.contentMarkdown || "");
        if (!reopenedContent) {
          throw new KnowledgeBaseBuildError(
            "PROGRESS_PROTOCOL_INVALID",
            "重新核验的知识节点缺少可展示正文，本轮未推进",
          );
        }
        const reopenedContentSha256 =
          knowledgeBaseMarkdownSha256(reopenedContent);
        const reopenedPresentationKey = knowledgePresentationKey({
          buildId: build.id,
          generation: build.generation,
          revision: build.revision + 1,
          leafId: target.leafId,
          contentSha256: reopenedContentSha256,
        });
        await tx
          .update(knowledgeBaseBuildNodes)
          .set({
            status: "needs_verification",
            transitionReason:
              reopen.reason || "根据企业补充内容重新核验当前节点",
            contentMarkdown: reopenedContent,
            sourceTurnId: successfulTurnIdentity.sourceTurnId,
            presentationKey: reopenedPresentationKey,
            contentSha256: reopenedContentSha256,
            lastUserInput: userText || null,
            sourceUrls: mergeAuditUrls(target.sourceUrls, audit.sourceUrls),
            imageUrls: mergeAuditUrls(target.imageUrls, audit.imageUrls),
            lastTaskId: input.taskId?.slice(0, 255) || build.upstreamTaskId,
            lastResponseAt: new Date(),
            confirmedAt: null,
          })
          .where(eq(knowledgeBaseBuildNodes.id, target.id));
        rows = await loadNodes(tx, build.id);
        const reopenedState = stateFromRows(
          {
            ...build,
            revision: build.revision + 1,
            currentLeafId: target.leafId,
          },
          rows,
        );
        const reopenedSummary = getKnowledgeBaseProgressSummary(reopenedState);
        if (activeTurn?.operationKey) {
          await persistKnowledgeBasePresentationInTransaction({
            tx,
            userId: input.userId,
            conversationId: knowledgeBaseObservationConversationStorageId(
              input.userId,
              conversationId,
            ),
            turnId: activeTurn.id,
            buildId: build.id,
            generation: build.generation,
            operationKey: activeTurn.operationKey,
            presentationKey: reopenedPresentationKey,
            revision: reopenedState.revision,
            leafId: target.leafId,
            content: reopenedContent,
            authoritativeTaskId:
              input.taskId?.slice(0, 255) || build.upstreamTaskId,
            sentAt: new Date(),
          });
        }
        await tx
          .update(knowledgeBaseBuilds)
          .set({
            upstreamTaskId: input.taskId?.slice(0, 255) || build.upstreamTaskId,
            status: "confirming",
            stateEpoch: build.stateEpoch + 1,
            activeTurnId: successfulTurnIdentity.activeTurnId,
            currentPresentationKey: reopenedPresentationKey,
            lastAppliedOperationKey:
              successfulTurnIdentity.lastAppliedOperationKey,
            revision: build.revision + 1,
            currentLeafId: target.leafId,
            confirmedCount: reopenedSummary.confirmed,
            directPrefilledCount: reopenedSummary.directPrefilled,
            needsVerificationCount: reopenedSummary.needsVerification,
            lastReconciledHash: hash,
            ...outputLedger,
            protocolError: null,
            protocolErrorCode: null,
            awaitingResponseSince: null,
            completedAt: null,
            packageRevision: null,
            packageTaskId: null,
            packageOutputItemId: null,
            packageFileId: null,
            packageFilename: null,
            packageDescriptorHash: null,
          })
          .where(eq(knowledgeBaseBuilds.id, build.id));
        if (activeTurn) {
          await tx
            .update(conversationTurns)
            .set({
              status: "completed",
              completedAt: new Date(),
              leaseExpiresAt: null,
              errorCode: null,
              errorMessage: null,
            })
            .where(eq(conversationTurns.id, activeTurn.id));
        }
        recordKnowledgeInputUnlock(build);
        build = (await loadBuild(tx, input.userId, conversationId))!;
        rows = await loadNodes(tx, build.id);
        return buildDto(build, rows);
      }

      if (action === "initial") {
        throw new KnowledgeBaseBuildError(
          "PROGRESS_PROTOCOL_INVALID",
          "节点已开始确认，空白回复不能推进当前节点",
        );
      }

      const state = stateFromRows(build, rows);
      const envelope = parseKnowledgeBaseProgressEnvelope(text);
      assertEnvelopeBelongsToActiveTurn({
        build,
        activeTurn,
        envelope,
      });
      assertActionMatchesTransition(action, envelope.transition.to);
      const nextState = applyKnowledgeBaseProgressEnvelope(state, envelope);
      let acceptedPresentation: KnowledgeBasePresentationEnvelope | null = null;
      if (build.skillVersion === "3" || build.skillVersion === "4") {
        acceptedPresentation = assertKnowledgeBasePresentationMatchesState(
          nextState,
          text,
        );
        assertEnvelopeBelongsToActiveTurn({
          build,
          activeTurn,
          envelope: acceptedPresentation,
        });
        assertKnowledgeBaseNodeImageDelivery({
          presentation: acceptedPresentation,
          output: authoritativeOutput,
        });
      }
      const summary = getKnowledgeBaseProgressSummary(nextState);
      const packageAllowed = canPackageKnowledgeBase(nextState);
      const packageDescriptors = packageAllowed
        ? collectKnowledgeArchiveDescriptors(
            Array.isArray(authoritativeOutput) ? authoritativeOutput : [],
          )
        : [];
      if (packageAllowed && packageDescriptors.length !== 1) {
        throw new KnowledgeBaseBuildError(
          packageDescriptors.length === 0
            ? "FINAL_PACKAGE_MISSING"
            : "PROGRESS_PROTOCOL_INVALID",
          packageDescriptors.length === 0
            ? build.skillVersion === "4"
              ? "上游已确认最后节点，但未返回当前操作唯一的最终知识库 ZIP；本轮未提交，仍停留在最后节点"
              : "所有节点已完成，但本轮尚未生成唯一的最终知识库 ZIP"
            : "本轮返回了多个知识库 ZIP，无法确认唯一发布版本",
        );
      }
      const packageDescriptor = packageDescriptors[0];
      const stagedPackage = input.stagedArtifacts?.package;
      if (
        packageAllowed &&
        build.skillVersion === "4" &&
        (!stagedPackage ||
          !packageDescriptor ||
          stagedPackage.sourceDescriptorHash !==
            knowledgeArchivePhysicalDescriptorHash(packageDescriptor) ||
          stagedPackage.packageRevision !== nextState.revision ||
          stagedPackage.outputItemId !== packageDescriptor.outputItemId ||
          (stagedPackage.fileId || null) !==
            (packageDescriptor.fileId || null) ||
          !/^[a-f0-9]{64}$/u.test(stagedPackage.sha256) ||
          !Number.isSafeInteger(stagedPackage.bytes) ||
          stagedPackage.bytes <= 0)
      ) {
        throw new KnowledgeBaseBuildError(
          "PROGRESS_PROTOCOL_INVALID",
          "最终知识库 ZIP 尚未通过当前操作、版本、描述与不可变字节校验",
        );
      }
      const presentationLeaf = nextState.currentLeafId
        ? nextState.leaves.find(
            (leaf) => leaf.id === nextState.currentLeafId,
          ) || null
        : null;
      const visibleContent = packageAllowed
        ? ""
        : projectKnowledgeBasePresentationMarkdown({
            markdown: audit.contentMarkdown,
            leafId: presentationLeaf!.id,
            leafTitle: presentationLeaf!.title,
            leafIds: nextState.leaves.map((leaf) => leaf.id),
          });
      if (!packageAllowed && !visibleContent) {
        throw new KnowledgeBaseBuildError(
          "PROGRESS_PROTOCOL_INVALID",
          "当前知识节点缺少可展示正文，本轮未推进",
        );
      }
      const visibleContentSha256 = packageAllowed
        ? null
        : knowledgeBaseMarkdownSha256(visibleContent);
      const acceptedPresentationKey =
        packageAllowed || !nextState.currentLeafId || !visibleContentSha256
          ? null
          : knowledgePresentationKey({
              buildId: build.id,
              generation: build.generation,
              revision: nextState.revision,
              leafId: nextState.currentLeafId,
              contentSha256: visibleContentSha256,
            });
      const previousCurrentIndex = rows.findIndex(
        (row) => row.leafId === state.currentLeafId,
      );

      for (let index = 0; index < rows.length; index += 1) {
        const previous = rows[index]!;
        const next = nextState.leaves[index]!;
        const isCurrentLeaf = previous.leafId === state.currentLeafId;
        const isNextLeaf =
          nextState.currentLeafId !== null &&
          previous.leafId === nextState.currentLeafId;
        const storesRevisedCurrent = isCurrentLeaf && action === "revise";
        const storesNextPrefill =
          isNextLeaf &&
          nextState.currentLeafId !== state.currentLeafId &&
          action !== "revise";
        if (
          previous.status === next.status &&
          !isCurrentLeaf &&
          !storesNextPrefill
        ) {
          continue;
        }
        await tx
          .update(knowledgeBaseBuildNodes)
          .set({
            status: next.status,
            transitionReason:
              index === previousCurrentIndex
                ? envelope.transition.reason || null
                : null,
            ...(storesRevisedCurrent || storesNextPrefill
              ? {
                  contentMarkdown: visibleContent || previous.contentMarkdown,
                  sourceTurnId: successfulTurnIdentity.sourceTurnId,
                  presentationKey: acceptedPresentationKey,
                  contentSha256: visibleContentSha256,
                  lastUserInput: storesRevisedCurrent
                    ? userText || null
                    : previous.lastUserInput,
                  sourceUrls: mergeAuditUrls(
                    previous.sourceUrls,
                    audit.sourceUrls,
                  ),
                  imageUrls: mergeAuditUrls(
                    previous.imageUrls,
                    audit.imageUrls,
                  ),
                  lastTaskId:
                    input.taskId?.slice(0, 255) || build.upstreamTaskId,
                  lastResponseAt: new Date(),
                }
              : {}),
            confirmedAt:
              next.status === "confirmed" || next.status === "direct_prefilled"
                ? new Date()
                : null,
          })
          .where(eq(knowledgeBaseBuildNodes.id, previous.id));
      }

      const authoritativeTaskId =
        input.taskId?.slice(0, 255) || build.upstreamTaskId;
      if (activeTurn?.operationKey) {
        const persistedConversationId =
          knowledgeBaseObservationConversationStorageId(
            input.userId,
            conversationId,
          );
        if (
          !packageAllowed &&
          acceptedPresentationKey &&
          nextState.currentLeafId
        ) {
          await persistKnowledgeBasePresentationInTransaction({
            tx,
            userId: input.userId,
            conversationId: persistedConversationId,
            turnId: activeTurn.id,
            buildId: build.id,
            generation: build.generation,
            operationKey: activeTurn.operationKey,
            presentationKey: acceptedPresentationKey,
            revision: nextState.revision,
            leafId: nextState.currentLeafId,
            content: visibleContent,
            authoritativeTaskId,
            sentAt: new Date(),
          });
        } else if (packageAllowed) {
          await markKnowledgeBaseConversationCompletedInTransaction({
            tx,
            userId: input.userId,
            conversationId: persistedConversationId,
            authoritativeTaskId,
            completedAt: new Date(),
          });
        }
      }

      const finalBuildUpdate = await tx
        .update(knowledgeBaseBuilds)
        .set({
          upstreamTaskId: authoritativeTaskId,
          status: packageAllowed ? "ready_to_publish" : "confirming",
          stateEpoch: build.stateEpoch + 1,
          activeTurnId: successfulTurnIdentity.activeTurnId,
          currentPresentationKey: acceptedPresentationKey,
          lastAppliedOperationKey:
            successfulTurnIdentity.lastAppliedOperationKey,
          revision: nextState.revision,
          currentLeafId: nextState.currentLeafId,
          totalNodeCount: summary.total,
          confirmedCount: summary.confirmed,
          directPrefilledCount: summary.directPrefilled,
          needsVerificationCount: summary.needsVerification,
          lastReconciledHash: hash,
          ...outputLedger,
          protocolError: null,
          protocolErrorCode: null,
          awaitingResponseSince: null,
          completedAt: packageAllowed ? new Date() : null,
          packageRevision: packageAllowed ? nextState.revision : null,
          packageTaskId: packageAllowed
            ? input.taskId?.slice(0, 255) || build.upstreamTaskId
            : null,
          packageOutputItemId: packageAllowed
            ? stagedPackage?.outputItemId ||
              packageDescriptor?.outputItemId ||
              null
            : null,
          packageFileId: packageAllowed
            ? stagedPackage?.fileId || packageDescriptor?.fileId || null
            : null,
          packageFilename: packageAllowed
            ? stagedPackage?.filename || packageDescriptor?.filename || null
            : null,
          packageDescriptorHash: packageAllowed
            ? stagedPackage?.descriptorHash ||
              (packageDescriptor
                ? knowledgeArchiveDescriptorHash(packageDescriptor)
                : null)
            : null,
          ...(packageAllowed && stagedPackage
            ? {
                packageStorageKey: stagedPackage.storageKey,
                packageArchiveSha256: stagedPackage.sha256,
                packageSizeBytes: stagedPackage.bytes,
              }
            : {}),
        })
        .where(
          and(
            eq(knowledgeBaseBuilds.id, build.id),
            eq(knowledgeBaseBuilds.userId, input.userId),
            eq(knowledgeBaseBuilds.generation, build.generation),
            eq(knowledgeBaseBuilds.stateEpoch, build.stateEpoch),
            build.skillVersion === "4" && activeTurn
              ? eq(knowledgeBaseBuilds.activeTurnId, activeTurn.id)
              : undefined,
            input.taskId
              ? eq(knowledgeBaseBuilds.upstreamTaskId, input.taskId)
              : undefined,
            eq(knowledgeBaseBuilds.revision, build.revision),
            eq(knowledgeBaseBuilds.status, build.status),
          ),
        );
      if (build.skillVersion === "4" && !finalBuildUpdate[0]?.affectedRows) {
        throw new KnowledgeBaseProgressError(
          "STALE_OPERATION",
          "知识库操作已被新的权威状态替换",
        );
      }

      if (activeTurn) {
        await tx
          .update(conversationTurns)
          .set({
            status: "completed",
            completedAt: new Date(),
            leaseExpiresAt: null,
            errorCode: null,
            errorMessage: null,
          })
          .where(eq(conversationTurns.id, activeTurn.id));
      }

      recordKnowledgeInputUnlock(build);
      build = (await loadBuild(tx, input.userId, conversationId))!;
      rows = await loadNodes(tx, build.id);
      if (
        packageAllowed &&
        build.skillVersion === "4" &&
        stagedPackage &&
        (build.packageStorageKey !== stagedPackage.storageKey ||
          build.packageArchiveSha256 !== stagedPackage.sha256 ||
          build.packageSizeBytes !== stagedPackage.bytes ||
          build.packageRevision !== nextState.revision ||
          build.packageTaskId !== input.taskId ||
          build.packageDescriptorHash !== stagedPackage.descriptorHash)
      ) {
        throw new KnowledgeBaseProgressError(
          "STALE_OPERATION",
          "最终知识库 ZIP 未与当前任务、版本和描述原子绑定",
        );
      }
      return buildDto(build, rows);
    });
  } catch (error) {
    if (
      error instanceof KnowledgeBaseBuildError &&
      error.code === "BUILD_NOT_FOUND"
    ) {
      throw error;
    }
    if (isIdempotentKnowledgeBaseReconcileError(error)) {
      // Duplicate/full-vs-tail/future observations are normal in an
      // at-least-once polling system. They are a semantic no-op, not a durable
      // customer-facing protocol failure.
      await finishLegacyKnowledgeBaseReconcileNoopByConversation({
        userId: input.userId,
        conversationId,
      });
      const progress = await getKnowledgeBaseProgress({
        userId: input.userId,
        conversationId,
      });
      if (progress) return progress;
    }
    const upstream = classifyKnowledgeBaseUpstreamTaskStatus(
      input.upstreamStatus,
    );
    if (input.upstreamStatus !== undefined && !upstream.settled) {
      // Streaming output may contain a closed state envelope before its
      // presentation, Logo or final ZIP arrives. Keep the turn locked and do
      // not advance the accepted output cursor until the complete bundle can
      // be validated.
      const progress = await getKnowledgeBaseProgress({
        userId: input.userId,
        conversationId,
      });
      if (progress) return progress;
    }
    const acknowledgementOnly = isKnowledgeBaseAcknowledgementOnlyOutput(
      input.output,
    );
    const message = acknowledgementOnly
      ? KNOWLEDGE_BASE_ACKNOWLEDGEMENT_FAILURE_MESSAGE
      : friendlyProtocolError(error);
    // Deliberately do not update the output ledger on failure. A provider may
    // append a missing companion resource to the same cumulative output; the
    // next observation must revalidate that complete bundle.
    await observeKnowledgeBaseProtocolFailure({
      userId: input.userId,
      conversationId,
      taskId: input.taskId,
      observationKey: knowledgeBaseProtocolFailureObservationKey({
        taskId: input.taskId,
        output: input.output,
        upstreamStatus: input.upstreamStatus,
        error,
      }),
      message,
      code: acknowledgementOnly
        ? "UPSTREAM_ACKNOWLEDGEMENT_ONLY"
        : error instanceof KnowledgeBaseBuildError &&
            error.code === "FINAL_PACKAGE_MISSING"
          ? error.code
          : undefined,
      definitive: acknowledgementOnly,
    });
    const progress = await getKnowledgeBaseProgress({
      userId: input.userId,
      conversationId,
    });
    if (progress) return progress;
    throw new KnowledgeBaseBuildError("PROGRESS_PROTOCOL_INVALID", message);
  }
}

export async function assertKnowledgeBasePublishable(input: {
  userId: number;
  conversationId: string;
}) {
  const db = await requireDb();
  const conversationId = normalizeConversationId(input.conversationId);
  const build = await loadBuild(db, input.userId, conversationId);
  if (!build) {
    throw new KnowledgeBaseBuildError(
      "BUILD_NOT_FOUND",
      "当前对话没有知识库构建记录",
    );
  }
  const rows = await loadNodes(db, build.id);
  if (build.status === "published" && build.publishedSnapshotId) {
    return build;
  }
  if (build.status !== "ready_to_publish") {
    throw new KnowledgeBaseBuildError(
      "PUBLISH_BLOCKED",
      "知识库尚未完成全部节点确认",
    );
  }
  try {
    assertKnowledgeBaseReadyForPackage(stateFromRows(build, rows));
  } catch {
    const handled = build.confirmedCount + build.directPrefilledCount;
    throw new KnowledgeBaseBuildError(
      "PUBLISH_BLOCKED",
      `知识库尚未逐项走完，当前完成进度为 ${handled}/${build.totalNodeCount}`,
    );
  }
  if (
    build.packageRevision !== build.revision ||
    build.packageTaskId !== build.upstreamTaskId ||
    !build.packageOutputItemId ||
    !build.packageDescriptorHash ||
    !build.packageStorageKey ||
    !/^[a-f0-9]{64}$/u.test(String(build.packageArchiveSha256 || "")) ||
    !Number.isSafeInteger(build.packageSizeBytes) ||
    Number(build.packageSizeBytes) <= 0
  ) {
    throw new KnowledgeBaseBuildError(
      "PUBLISH_BLOCKED",
      "最终知识库文件尚未与当前完成版本绑定",
    );
  }
  return build;
}

export async function markKnowledgeBasePublished(input: {
  userId: number;
  conversationId: string;
  snapshotId: string;
}) {
  const db = await requireDb();
  await db
    .update(knowledgeBaseBuilds)
    .set({
      status: "published",
      publishedSnapshotId: input.snapshotId,
      publishedAt: new Date(),
      protocolError: null,
    })
    .where(
      and(
        eq(knowledgeBaseBuilds.userId, input.userId),
        eq(
          knowledgeBaseBuilds.conversationId,
          normalizeConversationId(input.conversationId),
        ),
      ),
    );
}
