import axios from "axios";
import { and, eq, inArray } from "drizzle-orm";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";

import {
  conversationTurns,
  knowledgeBaseBuildNodes,
  knowledgeBaseBuilds,
} from "../drizzle/schema";
import type { KnowledgeAsset } from "../shared/dashboard";
import {
  assertSafeExternalUrl,
  safeExternalRequestOptions,
} from "./_core/safe-external-url";
import { getDb } from "./db";
import {
  downloadArchiveBytes,
  readKnowledgeArchive,
  readStoredKnowledgeAssetBytes,
  removeStoredKnowledgeAssets,
} from "./dashboard-api";
import {
  collectKnowledgeArchiveDescriptors,
  knowledgeArchiveBoundDescriptorHash,
  knowledgeArchiveDescriptorHash,
  knowledgeArchiveFileIdFromUrl,
  knowledgeArchivePhysicalDescriptorHash,
  type KnowledgeArchiveDescriptor,
} from "./knowledge-base-artifact";
import {
  assertKnowledgeBasePackageMatchesBuild,
  selectLegacyKnowledgeBaseLogoAsset,
} from "./knowledge-base-package-validation";
import { canonicalizeKnowledgeBaseFinalArchive } from "./knowledge-base-package-canonicalization";
import {
  createKnowledgeBaseAuthoritativeFinalOutput,
  deriveKnowledgeBaseAuthoritativeFinalizationPlan,
  hasKnowledgeBaseCompleteFinalProtocol,
  selectKnowledgeBaseAuthoritativeFinalDescriptor,
} from "./knowledge-base-finalization";
import {
  assertKnowledgeBaseCustomerUploadVisualBindings,
  verifiedKnowledgeBaseCustomerUploadsForBuild,
  verifiedKnowledgeBaseOfficialLogoUploadForBuild,
} from "./knowledge-base-customer-upload";
import {
  KnowledgeBuildArtifactError,
  persistKnowledgeBuildArtifact,
  listStaleKnowledgeBuildArtifactCandidates,
  readKnowledgeBuildArtifact,
  removeKnowledgeBuildArtifact,
  removeStagedKnowledgeBuildArtifact,
  stageKnowledgeBuildArtifact,
} from "./knowledge-build-artifact-store";
import { readStoredPresalesFile } from "./presales-file-store";
import {
  applyKnowledgeBaseProgressEnvelope,
  assertKnowledgeBasePresentationMatchesState,
  assertKnowledgeBaseProtocolOperation,
  canPackageKnowledgeBase,
  parseKnowledgeBaseManifestEnvelope,
  parseKnowledgeBaseProgressEnvelope,
  type KnowledgeBaseProgressState,
} from "./knowledge-base-progress";
import {
  classifyKnowledgeBaseUserAction,
  collectTrustedKnowledgeBaseOutputImageDescriptors,
  extractFinalKnowledgeBaseAssistantText,
  knowledgeBaseOutputImageDescriptorHash,
  selectKnowledgeBaseProtocolOperationOutput,
} from "./knowledge-base-progress-service";

const MAX_LOGO_DOWNLOAD_BYTES = 15 * 1024 * 1024;
const OFFICIAL_LOGO_UPLOAD_MIME_TYPES = new Set([
  "image/avif",
  "image/gif",
  "image/jpeg",
  "image/png",
  "image/webp",
]);

type KnowledgeBaseLogoDescriptor = {
  fileId?: string;
  url?: string;
  filename: string;
  mimeType: string;
};

export class KnowledgeBaseArtifactBindingError extends Error {
  constructor(
    public readonly code:
      | "LOGO_NOT_READY"
      | "LOGO_AMBIGUOUS"
      | "LOGO_UPLOAD_INVALID"
      | "PACKAGE_NOT_READY"
      | "PACKAGE_AMBIGUOUS"
      | "BUILD_CHANGED"
      | "ARTIFACT_DOWNLOAD_FAILED",
    message: string,
  ) {
    super(message);
    this.name = "KnowledgeBaseArtifactBindingError";
  }
}

export function assertKnowledgeBaseOfficialLogoMimeMatches(input: {
  declaredMimeType: string;
  detectedFormat?: string | null;
}) {
  const detectedMimeType =
    input.detectedFormat === "jpeg"
      ? "image/jpeg"
      : input.detectedFormat
        ? `image/${input.detectedFormat}`
        : "";
  if (!detectedMimeType || detectedMimeType !== input.declaredMimeType) {
    throw new KnowledgeBaseArtifactBindingError(
      "LOGO_UPLOAD_INVALID",
      `企业主 Logo 的文件格式与声明类型不一致：检测为 ${detectedMimeType || "未知格式"}，声明为 ${input.declaredMimeType}`,
    );
  }
  return detectedMimeType;
}

export function selectKnowledgeBaseRecoveryLogoAsset(input: {
  skillVersion: string;
  assets: readonly KnowledgeAsset[];
  expectedLogoSha256?: string | null;
}) {
  const eligibleAssets =
    input.skillVersion === "4"
      ? input.assets.filter((asset) => asset.sourceKind !== "user_upload")
      : input.assets;
  if (input.skillVersion === "3" || input.skillVersion === "4") {
    return selectLegacyKnowledgeBaseLogoAsset({
      assets: eligibleAssets,
      expectedLogoSha256:
        input.skillVersion === "4" ? input.expectedLogoSha256 : undefined,
    });
  }
  if (eligibleAssets.length !== 1) {
    throw new KnowledgeBaseArtifactBindingError(
      "PACKAGE_NOT_READY",
      `历史知识库 ZIP 必须包含唯一官方主 Logo，实际检测到 ${eligibleAssets.length} 张图片`,
    );
  }
  return eligibleAssets[0]!;
}

export interface KnowledgeBaseStagedArtifactCandidate {
  staged: true;
  kind: "logo" | "package";
  userId: number;
  buildId: string;
  generation: number;
  turnId: string;
  operationKey: string;
  taskId: string;
  expectedStateEpoch: number;
  expectedRevision: number;
  descriptorHash: string;
  sourceDescriptorHash?: string;
  storageKey: string;
  sha256: string;
  bytes: number;
  filename: string;
  mimeType: string;
  packageRevision?: number;
  outputItemId?: string;
  fileId?: string;
}

type ReadyPackageIdentity = Pick<
  typeof knowledgeBaseBuilds.$inferSelect,
  | "skillVersion"
  | "packageOutputItemId"
  | "packageFileId"
  | "packageDescriptorHash"
  | "packageArchiveSha256"
>;

/**
 * Selects the one historical ZIP that was already bound to the build before
 * the provider's cumulative output is downloaded. File IDs and provider item
 * aliases survive signed-URL rotation and top-level/nested projection order
 * changes. A v4 byte-bound descriptor remains an additional hard constraint;
 * the older URL-query-bound hash is used only when no stable persisted
 * coordinate exists.
 */
export function selectKnowledgeBaseReadyPackageDescriptor(input: {
  descriptors: readonly KnowledgeArchiveDescriptor[];
  identity: ReadyPackageIdentity;
}) {
  const { identity } = input;
  let candidates = [...input.descriptors];
  let hasStableCoordinate = false;

  if (identity.packageFileId) {
    hasStableCoordinate = true;
    candidates = candidates.filter((descriptor) => {
      const candidateFileId =
        descriptor.fileId ||
        (descriptor.url
          ? knowledgeArchiveFileIdFromUrl(descriptor.url)
          : undefined);
      return candidateFileId === identity.packageFileId;
    });
  }

  // A file ID is the provider's physical identity. When it exists, a nested
  // outputItemId may legitimately change solely because content was reordered.
  if (identity.packageOutputItemId && !identity.packageFileId) {
    hasStableCoordinate = true;
    candidates = candidates.filter((descriptor) =>
      (descriptor.outputItemIds || [descriptor.outputItemId]).includes(
        identity.packageOutputItemId!,
      ),
    );
  }

  if (identity.packageDescriptorHash) {
    const descriptorMatches = candidates.filter((descriptor) => {
      if (identity.skillVersion === "4" && identity.packageArchiveSha256) {
        return (
          knowledgeArchiveBoundDescriptorHash(
            descriptor,
            identity.packageArchiveSha256,
          ) === identity.packageDescriptorHash
        );
      }
      return (
        knowledgeArchiveDescriptorHash(descriptor) ===
        identity.packageDescriptorHash
      );
    });
    if (
      descriptorMatches.length > 0 ||
      !hasStableCoordinate ||
      (identity.skillVersion === "4" && identity.packageArchiveSha256)
    ) {
      candidates = descriptorMatches;
    }
  }

  if (candidates.length === 0) {
    throw new KnowledgeBaseArtifactBindingError(
      "PACKAGE_NOT_READY",
      "历史完成任务中没有与当前权威记录匹配的知识库 ZIP",
    );
  }
  if (candidates.length !== 1) {
    throw new KnowledgeBaseArtifactBindingError(
      "PACKAGE_AMBIGUOUS",
      `历史完成任务中与当前权威记录匹配的 ZIP 不唯一，实际检测到 ${candidates.length} 个`,
    );
  }
  return candidates[0]!;
}

export function knowledgeBaseRecoveredPackageMatchesStoredHash(input: {
  expectedSha256: string;
  providerBuffer: Buffer;
  authoritativeBuffer: Buffer;
}) {
  const providerSha256 = createHash("sha256")
    .update(input.providerBuffer)
    .digest("hex");
  if (input.expectedSha256 === providerSha256) return true;
  const authoritativeSha256 = createHash("sha256")
    .update(input.authoritativeBuffer)
    .digest("hex");
  return input.expectedSha256 === authoritativeSha256;
}

export function knowledgeBaseStagedArtifactCleanupDecision(input: {
  candidate: KnowledgeBaseStagedArtifactCandidate;
  build?: Pick<
    typeof knowledgeBaseBuilds.$inferSelect,
    | "logoStorageKey"
    | "packageStorageKey"
    | "activeTurnId"
    | "stateEpoch"
    | "revision"
    | "upstreamTaskId"
  >;
  turn?: Pick<
    typeof conversationTurns.$inferSelect,
    "operationKey" | "upstreamTaskId" | "status"
  >;
}) {
  const { candidate, build, turn } = input;
  if (
    build?.logoStorageKey === candidate.storageKey ||
    build?.packageStorageKey === candidate.storageKey
  ) {
    return "promoted" as const;
  }
  if (
    build?.activeTurnId === candidate.turnId &&
    build.stateEpoch === candidate.expectedStateEpoch &&
    build.revision === candidate.expectedRevision &&
    build.upstreamTaskId === candidate.taskId &&
    turn?.operationKey === candidate.operationKey &&
    turn.upstreamTaskId === candidate.taskId &&
    (turn.status === "queued" || turn.status === "running")
  ) {
    return "retained_current" as const;
  }
  return "delete" as const;
}

export async function removeKnowledgeBaseStagedArtifactCandidate(
  candidate: KnowledgeBaseStagedArtifactCandidate,
) {
  await removeStagedKnowledgeBuildArtifact({
    userId: candidate.userId,
    buildId: candidate.buildId,
    generation: candidate.generation,
    kind: candidate.kind,
    storageKey: candidate.storageKey,
  });
}

/**
 * Request-path cleanup must be serialized with pointer promotion. The same
 * operation/bytes can be observed by two pollers and therefore share one
 * candidate key; one poller may never unlink while the other can still promote
 * or has already promoted that key.
 */
export async function cleanupKnowledgeBaseStagedArtifactCandidate(
  candidate: KnowledgeBaseStagedArtifactCandidate,
) {
  const db = await requiredDb();
  return db.transaction(async (tx) => {
    const build = (
      await tx
        .select()
        .from(knowledgeBaseBuilds)
        .where(
          and(
            eq(knowledgeBaseBuilds.id, candidate.buildId),
            eq(knowledgeBaseBuilds.userId, candidate.userId),
            eq(knowledgeBaseBuilds.generation, candidate.generation),
          ),
        )
        .limit(1)
        .for("update")
    )[0];
    if (
      knowledgeBaseStagedArtifactCleanupDecision({ candidate, build }) ===
      "promoted"
    )
      return "promoted" as const;
    let turn:
      | Pick<
          typeof conversationTurns.$inferSelect,
          "operationKey" | "upstreamTaskId" | "status"
        >
      | undefined;
    if (
      build &&
      build.activeTurnId === candidate.turnId &&
      build.stateEpoch === candidate.expectedStateEpoch &&
      build.revision === candidate.expectedRevision &&
      build.upstreamTaskId === candidate.taskId
    ) {
      turn = (
        await tx
          .select({
            operationKey: conversationTurns.operationKey,
            upstreamTaskId: conversationTurns.upstreamTaskId,
            status: conversationTurns.status,
          })
          .from(conversationTurns)
          .where(
            and(
              eq(conversationTurns.id, candidate.turnId),
              eq(conversationTurns.userId, candidate.userId),
              eq(conversationTurns.buildId, candidate.buildId),
              eq(conversationTurns.buildGeneration, candidate.generation),
            ),
          )
          .limit(1)
          .for("update")
      )[0];
    }
    if (
      knowledgeBaseStagedArtifactCleanupDecision({ candidate, build, turn }) ===
      "retained_current"
    )
      return "retained_current" as const;
    await removeKnowledgeBaseStagedArtifactCandidate(candidate);
    return "deleted" as const;
  });
}

const DEFAULT_ORPHAN_CANDIDATE_AGE_MS = 24 * 60 * 60 * 1_000;

export async function cleanupOrphanedKnowledgeBuildArtifactCandidates(
  options: { limit?: number; olderThan?: Date } = {},
) {
  const db = await requiredDb();
  const candidates = await listStaleKnowledgeBuildArtifactCandidates({
    olderThan:
      options.olderThan ||
      new Date(Date.now() - DEFAULT_ORPHAN_CANDIDATE_AGE_MS),
    limit: options.limit,
  });
  const result = {
    scanned: candidates.length,
    deleted: 0,
    retained: 0,
    failed: 0,
  };
  for (const candidate of candidates) {
    try {
      const deleted = await db.transaction(async (tx) => {
        const build = (
          await tx
            .select({
              logoStorageKey: knowledgeBaseBuilds.logoStorageKey,
              packageStorageKey: knowledgeBaseBuilds.packageStorageKey,
              activeTurnId: knowledgeBaseBuilds.activeTurnId,
              status: knowledgeBaseBuilds.status,
            })
            .from(knowledgeBaseBuilds)
            .where(
              and(
                eq(knowledgeBaseBuilds.id, candidate.buildId),
                eq(knowledgeBaseBuilds.userId, candidate.userId),
                eq(knowledgeBaseBuilds.generation, candidate.generation),
              ),
            )
            .limit(1)
            .for("update")
        )[0];
        if (
          build?.logoStorageKey === candidate.storageKey ||
          build?.packageStorageKey === candidate.storageKey
        ) {
          return false;
        }
        if (
          build?.activeTurnId &&
          (build.status === "researching" || build.status === "confirming")
        ) {
          return false;
        }
        await removeStagedKnowledgeBuildArtifact(candidate);
        return true;
      });
      if (deleted) result.deleted += 1;
      else result.retained += 1;
    } catch {
      result.failed += 1;
    }
  }
  return result;
}

function stringValue(value: unknown) {
  return typeof value === "string" ? value.trim() : "";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

/** Nested/top-level provider projections often repeat one physical file. */
export function collectKnowledgeBaseLogoDescriptors(value: unknown) {
  const descriptors = new Map<string, KnowledgeBaseLogoDescriptor>();
  for (const raw of collectTrustedKnowledgeBaseOutputImageDescriptors(value)) {
    const descriptor: KnowledgeBaseLogoDescriptor = {
      ...(raw.fileId ? { fileId: raw.fileId } : {}),
      ...(raw.url ? { url: raw.url } : {}),
      filename: raw.filename,
      mimeType: raw.mimeType,
    };
    const aliases = new Set(
      [
        descriptor.fileId,
        descriptor.url,
        descriptor.url
          ? knowledgeArchiveFileIdFromUrl(descriptor.url)
          : undefined,
      ].filter(Boolean),
    );
    const existing = [...descriptors.entries()].find(([, candidate]) => {
      const candidateAliases = [
        candidate.fileId,
        candidate.url,
        candidate.url
          ? knowledgeArchiveFileIdFromUrl(candidate.url)
          : undefined,
      ].filter(Boolean) as string[];
      return candidateAliases.some((alias) => aliases.has(alias));
    });
    const key = existing?.[0] || descriptor.fileId || descriptor.url!;
    const previous = existing?.[1];
    descriptors.set(key, {
      ...descriptor,
      ...(previous?.fileId ? { fileId: previous.fileId } : {}),
      ...(previous?.url ? { url: previous.url } : {}),
    });
  }
  return [...descriptors.values()];
}

function upstreamHeaders(apiKey: string) {
  return { API_KEY: apiKey, Authorization: `Bearer ${apiKey}` };
}

async function downloadLogoBytes(input: {
  descriptor: KnowledgeBaseLogoDescriptor;
  apiKey: string;
  baseUrl: string;
}) {
  const fileId =
    input.descriptor.fileId ||
    (input.descriptor.url
      ? knowledgeArchiveFileIdFromUrl(input.descriptor.url)
      : undefined);
  const downloadUrl = fileId
    ? `${input.baseUrl.replace(/\/$/u, "")}/v1/files/${encodeURIComponent(fileId)}/content`
    : assertSafeExternalUrl(input.descriptor.url || "");
  const response = await axios.get<ArrayBuffer>(downloadUrl, {
    ...(fileId
      ? { proxy: false as const, maxRedirects: 0 }
      : safeExternalRequestOptions),
    ...(fileId ? { headers: upstreamHeaders(input.apiKey) } : {}),
    responseType: "arraybuffer",
    timeout: 120_000,
    maxContentLength: MAX_LOGO_DOWNLOAD_BYTES,
    maxBodyLength: MAX_LOGO_DOWNLOAD_BYTES,
    validateStatus: () => true,
  });
  if (response.status < 200 || response.status >= 300) {
    throw new KnowledgeBaseArtifactBindingError(
      "ARTIFACT_DOWNLOAD_FAILED",
      `下载企业官方主 Logo 失败 (${response.status})`,
    );
  }
  const buffer = Buffer.from(response.data);
  if (buffer.length === 0 || buffer.length > MAX_LOGO_DOWNLOAD_BYTES) {
    throw new KnowledgeBaseArtifactBindingError(
      "ARTIFACT_DOWNLOAD_FAILED",
      "企业官方主 Logo 文件为空或超过 15 MB",
    );
  }
  return buffer;
}

async function requiredDb() {
  const db = await getDb();
  if (!db) {
    throw new KnowledgeBaseArtifactBindingError(
      "BUILD_CHANGED",
      "数据库暂不可用，无法绑定知识库资源",
    );
  }
  return db;
}

async function loadBoundBuild(input: {
  userId: number;
  buildId: string;
  generation: number;
  taskId: string;
}) {
  const db = await requiredDb();
  const build = (
    await db
      .select()
      .from(knowledgeBaseBuilds)
      .where(
        and(
          eq(knowledgeBaseBuilds.id, input.buildId),
          eq(knowledgeBaseBuilds.userId, input.userId),
          eq(knowledgeBaseBuilds.generation, input.generation),
          eq(knowledgeBaseBuilds.upstreamTaskId, input.taskId),
        ),
      )
      .limit(1)
  )[0];
  if (!build) {
    throw new KnowledgeBaseArtifactBindingError(
      "BUILD_CHANGED",
      "知识库任务或构建代次已经变化，本轮资源已忽略",
    );
  }
  const activeTurn = build.activeTurnId
    ? (
        await db
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
      )[0]
    : undefined;
  return { db, build, activeTurn };
}

function assertArtifactEnvelopeBelongsToActiveTurn(input: {
  build: typeof knowledgeBaseBuilds.$inferSelect;
  activeTurn?: typeof conversationTurns.$inferSelect;
  envelope: { schemaVersion: 1 | 2; operationId?: string; turnId?: string };
}) {
  assertKnowledgeBaseProtocolOperation(input.envelope, {
    operationId: input.activeTurn?.operationKey || "",
    turnId: input.activeTurn?.id || "",
    requireV4: input.build.skillVersion === "4",
  });
}

async function assertStagedCandidateStillAuthoritative(
  candidate: KnowledgeBaseStagedArtifactCandidate,
) {
  const rebound = await loadBoundBuild(candidate);
  if (
    rebound.build.stateEpoch !== candidate.expectedStateEpoch ||
    rebound.build.revision !== candidate.expectedRevision ||
    rebound.build.activeTurnId !== candidate.turnId ||
    rebound.activeTurn?.id !== candidate.turnId ||
    rebound.activeTurn.operationKey !== candidate.operationKey ||
    rebound.activeTurn.upstreamTaskId !== candidate.taskId ||
    (rebound.activeTurn.status !== "queued" &&
      rebound.activeTurn.status !== "running")
  ) {
    await cleanupKnowledgeBaseStagedArtifactCandidate(candidate).catch(
      () => undefined,
    );
    throw new KnowledgeBaseArtifactBindingError(
      "BUILD_CHANGED",
      "知识库操作已被新的权威轮次替换，本轮暂存资源已忽略",
    );
  }
  return candidate;
}

export type KnowledgeBaseOfficialLogoUpload = {
  verified: true;
  index: number;
  fileId: string;
  filename: string;
  mimeType: string;
  sizeBytes: number;
  sourceSha256: string;
};

async function readOfficialLogoUploadBytes(input: {
  fileId: string;
  filename: string;
  sizeBytes: number;
  sourceSha256: string;
}) {
  const stored = await readStoredPresalesFile(input.fileId);
  if (
    !stored ||
    stored.filename !== input.filename ||
    stored.sizeBytes !== input.sizeBytes ||
    stored.sha256?.toLowerCase() !== input.sourceSha256 ||
    input.sizeBytes < 1 ||
    input.sizeBytes > MAX_LOGO_DOWNLOAD_BYTES
  ) {
    throw new KnowledgeBaseArtifactBindingError(
      "LOGO_UPLOAD_INVALID",
      "上传的 Logo 原始文件与受管字节记录不一致，请重新上传",
    );
  }
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of stored.createReadStream()) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    bytes += buffer.length;
    if (bytes > MAX_LOGO_DOWNLOAD_BYTES) {
      throw new KnowledgeBaseArtifactBindingError(
        "LOGO_UPLOAD_INVALID",
        "上传的 Logo 超过 15 MB，请压缩后重新上传",
      );
    }
    chunks.push(buffer);
  }
  const result = Buffer.concat(chunks, bytes);
  if (
    result.length !== input.sizeBytes ||
    createHash("sha256").update(result).digest("hex") !== input.sourceSha256
  ) {
    throw new KnowledgeBaseArtifactBindingError(
      "LOGO_UPLOAD_INVALID",
      "上传的 Logo 原始字节校验失败，请重新上传",
    );
  }
  return result;
}

/**
 * Promote one exact browser-uploaded image into the build's immutable official
 * Logo slot. The upload remains first-party provenance, but it is no longer a
 * generic node image and therefore does not consume the 99-image supplement
 * allowance.
 */
export async function bindKnowledgeBaseOfficialLogoUpload(input: {
  userId: number;
  buildId: string;
  generation: number;
  turnId: string;
  operationKey: string;
  expectedRevision: number;
  expectedLeafId: string;
  upload: Omit<KnowledgeBaseOfficialLogoUpload, "verified">;
}) {
  const upload = {
    ...input.upload,
    filename: String(input.upload.filename || "").trim(),
    mimeType: String(input.upload.mimeType || "")
      .trim()
      .toLowerCase(),
    sourceSha256: String(input.upload.sourceSha256 || "")
      .trim()
      .toLowerCase(),
  };
  if (
    upload.index !== 0 ||
    !upload.fileId ||
    !upload.filename ||
    !OFFICIAL_LOGO_UPLOAD_MIME_TYPES.has(upload.mimeType) ||
    !Number.isSafeInteger(upload.sizeBytes) ||
    upload.sizeBytes < 1 ||
    !/^[a-f0-9]{64}$/u.test(upload.sourceSha256)
  ) {
    throw new KnowledgeBaseArtifactBindingError(
      "LOGO_UPLOAD_INVALID",
      "请只上传一张 PNG、JPEG、WebP、AVIF 或 GIF 格式的企业主 Logo 原图",
    );
  }
  const buffer = await readOfficialLogoUploadBytes(upload);
  const descriptorHash = createHash("sha256")
    .update(
      JSON.stringify({
        kind: "official_logo_upload",
        fileId: upload.fileId,
        filename: upload.filename,
        mimeType: upload.mimeType,
        sizeBytes: upload.sizeBytes,
        sourceSha256: upload.sourceSha256,
      }),
      "utf8",
    )
    .digest("hex");
  let staged: Awaited<ReturnType<typeof stageKnowledgeBuildArtifact>>;
  try {
    staged = await stageKnowledgeBuildArtifact({
      userId: input.userId,
      buildId: input.buildId,
      generation: input.generation,
      turnId: input.turnId,
      operationKey: input.operationKey,
      descriptorHash,
      kind: "logo",
      buffer,
      expectedSha256: upload.sourceSha256,
    });
  } catch (error) {
    if (
      error instanceof KnowledgeBuildArtifactError &&
      error.code === "ARTIFACT_INVALID"
    ) {
      throw new KnowledgeBaseArtifactBindingError(
        "LOGO_UPLOAD_INVALID",
        error.message,
      );
    }
    throw error;
  }
  const removeStaged = () =>
    removeStagedKnowledgeBuildArtifact({
      userId: input.userId,
      buildId: input.buildId,
      generation: input.generation,
      kind: "logo",
      storageKey: staged.storageKey,
    }).catch(() => undefined);
  if (
    !staged.width ||
    !staged.height ||
    staged.width < 256 ||
    staged.height < 256
  ) {
    await removeStaged();
    throw new KnowledgeBaseArtifactBindingError(
      "LOGO_UPLOAD_INVALID",
      `企业主 Logo 位图宽高均需至少 256 像素；当前为 ${staged.width || 0}×${staged.height || 0}`,
    );
  }
  let stagedMimeType: string;
  try {
    stagedMimeType = assertKnowledgeBaseOfficialLogoMimeMatches({
      declaredMimeType: upload.mimeType,
      detectedFormat: staged.format,
    });
  } catch (error) {
    await removeStaged();
    throw error;
  }

  const db = await requiredDb();
  const verifiedUpload: KnowledgeBaseOfficialLogoUpload = {
    verified: true,
    ...upload,
  };
  try {
    return await db.transaction(async (tx) => {
      const build = (
        await tx
          .select()
          .from(knowledgeBaseBuilds)
          .where(
            and(
              eq(knowledgeBaseBuilds.id, input.buildId),
              eq(knowledgeBaseBuilds.userId, input.userId),
              eq(knowledgeBaseBuilds.generation, input.generation),
            ),
          )
          .limit(1)
          .for("update")
      )[0];
      const turn = (
        await tx
          .select()
          .from(conversationTurns)
          .where(
            and(
              eq(conversationTurns.id, input.turnId),
              eq(conversationTurns.userId, input.userId),
              eq(conversationTurns.buildId, input.buildId),
              eq(conversationTurns.buildGeneration, input.generation),
            ),
          )
          .limit(1)
          .for("update")
      )[0];
      const currentNode = build?.currentLeafId
        ? (
            await tx
              .select({ ordinal: knowledgeBaseBuildNodes.ordinal })
              .from(knowledgeBaseBuildNodes)
              .where(
                and(
                  eq(knowledgeBaseBuildNodes.buildId, input.buildId),
                  eq(knowledgeBaseBuildNodes.leafId, build.currentLeafId),
                ),
              )
              .limit(1)
              .for("update")
          )[0]
        : undefined;
      if (
        !build ||
        !turn ||
        build.activeTurnId !== input.turnId ||
        turn.operationKey !== input.operationKey ||
        (turn.status !== "queued" && turn.status !== "running") ||
        build.status !== "confirming" ||
        build.revision !== input.expectedRevision ||
        build.currentLeafId !== input.expectedLeafId ||
        turn.expectedRevision !== input.expectedRevision ||
        turn.expectedLeafId !== input.expectedLeafId ||
        currentNode?.ordinal !== 0
      ) {
        throw new KnowledgeBaseArtifactBindingError(
          "BUILD_CHANGED",
          "当前首个知识节点状态已变化，请刷新后重新上传 Logo",
        );
      }
      if (build.logoSha256) {
        if (build.logoSha256 !== staged.sha256) {
          throw new KnowledgeBaseArtifactBindingError(
            "BUILD_CHANGED",
            "企业官方主 Logo 已由另一轮操作绑定，请刷新后继续",
          );
        }
        return verifiedUpload;
      }
      const metadata = isRecord(turn.metadata) ? turn.metadata : {};
      const recovery = isRecord(metadata.recovery) ? metadata.recovery : {};
      const nextMetadata = {
        ...metadata,
        recovery: {
          ...recovery,
          officialLogoUpload: verifiedUpload,
        },
      };
      await tx
        .update(knowledgeBaseBuilds)
        .set({
          stateEpoch: build.stateEpoch + 1,
          logoStorageKey: staged.storageKey,
          logoSha256: staged.sha256,
          logoBytes: staged.bytes,
          logoFilename: upload.filename.slice(0, 512),
          logoMimeType: stagedMimeType.slice(0, 255),
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(knowledgeBaseBuilds.id, build.id),
            eq(knowledgeBaseBuilds.userId, input.userId),
            eq(knowledgeBaseBuilds.generation, input.generation),
            eq(knowledgeBaseBuilds.stateEpoch, build.stateEpoch),
            eq(knowledgeBaseBuilds.activeTurnId, input.turnId),
          ),
        );
      await tx
        .update(conversationTurns)
        .set({ metadata: nextMetadata, updatedAt: new Date() })
        .where(eq(conversationTurns.id, input.turnId));
      return verifiedUpload;
    });
  } catch (error) {
    await removeStaged();
    throw error;
  }
}

export async function bindKnowledgeBaseInitialLogo(input: {
  userId: number;
  buildId: string;
  generation: number;
  taskId: string;
  output: unknown;
  apiKey: string;
  baseUrl: string;
}) {
  const { db, build, activeTurn } = await loadBoundBuild(input);
  const operationOutput =
    build.skillVersion === "4"
      ? selectKnowledgeBaseProtocolOperationOutput(input.output, {
          operationId: activeTurn?.operationKey || "",
          turnId: activeTurn?.id || "",
          taskId: input.taskId,
          generation: input.generation,
          stateKind: "frontmind.knowledge-base.manifest",
        })
      : input.output;
  const manifest = parseKnowledgeBaseManifestEnvelope(
    extractFinalKnowledgeBaseAssistantText(operationOutput),
  );
  assertArtifactEnvelopeBelongsToActiveTurn({
    build,
    activeTurn,
    envelope: manifest,
  });
  const descriptors = collectKnowledgeBaseLogoDescriptors(operationOutput);
  if (descriptors.length === 0) {
    throw new KnowledgeBaseArtifactBindingError(
      "LOGO_NOT_READY",
      "首轮官方主 Logo 尚未随完整输出到达",
    );
  }
  if (descriptors.length !== 1) {
    throw new KnowledgeBaseArtifactBindingError(
      "LOGO_AMBIGUOUS",
      `首轮必须恰好绑定一张官方主 Logo，实际检测到 ${descriptors.length} 张`,
    );
  }
  if (build.skillVersion === "4") {
    if (!activeTurn?.operationKey) {
      throw new KnowledgeBaseArtifactBindingError(
        "BUILD_CHANGED",
        "当前 v4 首轮没有有效操作 reservation",
      );
    }
    const descriptor = descriptors[0]!;
    const buffer = await downloadLogoBytes({
      descriptor,
      apiKey: input.apiKey,
      baseUrl: input.baseUrl,
    });
    const descriptorHash = knowledgeBaseOutputImageDescriptorHash({
      fileId: descriptor.fileId || "",
      url: descriptor.url || "",
      filename: descriptor.filename,
      mimeType: descriptor.mimeType,
    });
    const staged = await stageKnowledgeBuildArtifact({
      userId: input.userId,
      buildId: input.buildId,
      generation: input.generation,
      turnId: activeTurn.id,
      operationKey: activeTurn.operationKey,
      descriptorHash,
      kind: "logo",
      buffer,
    });
    const mimeType =
      staged.format === "jpeg"
        ? "image/jpeg"
        : staged.format
          ? `image/${staged.format}`
          : "application/octet-stream";
    return assertStagedCandidateStillAuthoritative({
      staged: true,
      kind: "logo",
      userId: input.userId,
      buildId: input.buildId,
      generation: input.generation,
      turnId: activeTurn.id,
      operationKey: activeTurn.operationKey,
      taskId: input.taskId,
      expectedStateEpoch: build.stateEpoch,
      expectedRevision: build.revision,
      descriptorHash,
      storageKey: staged.storageKey,
      sha256: staged.sha256,
      bytes: staged.bytes,
      filename: descriptor.filename.slice(0, 512),
      mimeType: mimeType.slice(0, 255),
    });
  }
  if (build.logoStorageKey && build.logoSha256 && build.logoBytes) {
    return {
      storageKey: build.logoStorageKey,
      sha256: build.logoSha256,
      bytes: build.logoBytes,
      filename: build.logoFilename || descriptors[0]!.filename,
      mimeType: build.logoMimeType || descriptors[0]!.mimeType,
      idempotent: true,
    };
  }
  const buffer = await downloadLogoBytes({
    descriptor: descriptors[0]!,
    apiKey: input.apiKey,
    baseUrl: input.baseUrl,
  });
  const persisted = await persistKnowledgeBuildArtifact({
    userId: input.userId,
    buildId: input.buildId,
    generation: input.generation,
    kind: "logo",
    buffer,
  });
  const persistedMimeType =
    persisted.format === "jpeg"
      ? "image/jpeg"
      : persisted.format
        ? `image/${persisted.format}`
        : "application/octet-stream";
  await db
    .update(knowledgeBaseBuilds)
    .set({
      logoStorageKey: persisted.storageKey,
      logoSha256: persisted.sha256,
      logoBytes: persisted.bytes,
      logoFilename: descriptors[0]!.filename.slice(0, 512),
      logoMimeType: persistedMimeType.slice(0, 255),
    })
    .where(
      and(
        eq(knowledgeBaseBuilds.id, input.buildId),
        eq(knowledgeBaseBuilds.userId, input.userId),
        eq(knowledgeBaseBuilds.generation, input.generation),
        eq(knowledgeBaseBuilds.upstreamTaskId, input.taskId),
        inArray(knowledgeBaseBuilds.status, ["researching", "confirming"]),
      ),
    );
  const rebound = (await loadBoundBuild(input)).build;
  if (
    rebound.logoSha256 !== persisted.sha256 ||
    rebound.logoBytes !== persisted.bytes
  ) {
    throw new KnowledgeBaseArtifactBindingError(
      "BUILD_CHANGED",
      "知识库状态已变化，首轮 Logo 未绑定到旧任务",
    );
  }
  return {
    ...persisted,
    filename: rebound.logoFilename!,
    mimeType: rebound.logoMimeType!,
    idempotent: false,
  };
}

export async function bindKnowledgeBaseFinalPackage(input: {
  userId: number;
  buildId: string;
  generation: number;
  taskId: string;
  output: unknown;
  apiKey: string;
  baseUrl: string;
}) {
  const { db, build, activeTurn } = await loadBoundBuild(input);
  const nodes = await db
    .select()
    .from(knowledgeBaseBuildNodes)
    .where(eq(knowledgeBaseBuildNodes.buildId, build.id));
  const transitionTarget = (() => {
    const action = classifyKnowledgeBaseUserAction(
      build.lastTurnUserText || "",
      build.lastTurnAttachmentCount || 0,
    );
    return action === "confirm" || action === "direct_prefill"
      ? action === "confirm"
        ? ("confirmed" as const)
        : ("direct_prefilled" as const)
      : undefined;
  })();
  const finalizationPlan = deriveKnowledgeBaseAuthoritativeFinalizationPlan({
    build,
    activeTurn,
    nodes: nodes.map((node) => ({
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
  const scopedOperationOutput =
    build.skillVersion === "4"
      ? selectKnowledgeBaseProtocolOperationOutput(
          Array.isArray(input.output) ? input.output : [],
          {
            operationId: activeTurn?.operationKey || "",
            turnId: activeTurn?.id || "",
            taskId: input.taskId,
            generation: input.generation,
            stateKind: "frontmind.knowledge-base.progress",
          },
          { requireExplicitResourceOperation: true },
        )
      : input.output;
  const authoritativeDescriptor = finalizationPlan
    ? selectKnowledgeBaseAuthoritativeFinalDescriptor({
        output: input.output,
        scopedOutput: scopedOperationOutput,
        plan: finalizationPlan,
      })
    : null;
  const scopedProtocolComplete = finalizationPlan
    ? hasKnowledgeBaseCompleteFinalProtocol({
        assistantText: extractFinalKnowledgeBaseAssistantText(
          scopedOperationOutput,
        ),
        plan: finalizationPlan,
      })
    : false;
  const operationOutput =
    finalizationPlan && authoritativeDescriptor && !scopedProtocolComplete
      ? createKnowledgeBaseAuthoritativeFinalOutput({
          descriptor: authoritativeDescriptor,
          plan: finalizationPlan,
        })
      : scopedOperationOutput;
  const descriptors = collectKnowledgeArchiveDescriptors(operationOutput);
  if (
    build.skillVersion === "4" &&
    !finalizationPlan &&
    descriptors.length === 0 &&
    collectKnowledgeArchiveDescriptors(input.output).length > 0
  ) {
    throw new KnowledgeBaseArtifactBindingError(
      "BUILD_CHANGED",
      "累计输出中的 ZIP 不属于当前最终确认操作，已安全忽略",
    );
  }
  if (descriptors.length === 0) {
    throw new KnowledgeBaseArtifactBindingError(
      "PACKAGE_NOT_READY",
      "最终知识库 ZIP 尚未随完整输出到达",
    );
  }
  if (descriptors.length !== 1) {
    throw new KnowledgeBaseArtifactBindingError(
      "PACKAGE_AMBIGUOUS",
      `最终轮必须恰好返回一个 ZIP，实际检测到 ${descriptors.length} 个`,
    );
  }
  const assistantText = extractFinalKnowledgeBaseAssistantText(operationOutput);
  const progressEnvelope = parseKnowledgeBaseProgressEnvelope(assistantText);
  assertArtifactEnvelopeBelongsToActiveTurn({
    build,
    activeTurn,
    envelope: progressEnvelope,
  });
  if (
    build.skillVersion !== "4" &&
    build.packageStorageKey &&
    build.packageArchiveSha256 &&
    build.packageSizeBytes
  ) {
    if (
      build.packageDescriptorHash &&
      build.packageDescriptorHash !==
        knowledgeArchiveDescriptorHash(descriptors[0]!)
    ) {
      throw new KnowledgeBaseArtifactBindingError(
        "BUILD_CHANGED",
        "最终 ZIP 描述已在同一任务中变化，等待权威完整输出",
      );
    }
    return {
      storageKey: build.packageStorageKey,
      sha256: build.packageArchiveSha256,
      bytes: build.packageSizeBytes,
      filename: build.packageFilename || descriptors[0]!.filename,
      idempotent: true,
    };
  }
  if (!build.logoSha256 && build.skillVersion === "4") {
    throw new KnowledgeBaseArtifactBindingError(
      "PACKAGE_NOT_READY",
      "首轮官方主 Logo 尚未完成绑定，不能接受最终 ZIP",
    );
  }
  if (build.skillVersion === "4") {
    if (!build.logoStorageKey || !build.logoBytes) {
      throw new KnowledgeBaseArtifactBindingError(
        "PACKAGE_NOT_READY",
        "企业官方主 Logo 的永久副本不完整，不能接受最终 ZIP",
      );
    }
    try {
      await readKnowledgeBuildArtifact({
        userId: input.userId,
        buildId: input.buildId,
        generation: input.generation,
        kind: "logo",
        expectedSha256: build.logoSha256!,
        expectedBytes: build.logoBytes,
        storageKey: build.logoStorageKey,
      });
    } catch (error) {
      if (!(error instanceof KnowledgeBuildArtifactError)) throw error;
      throw new KnowledgeBaseArtifactBindingError(
        "PACKAGE_NOT_READY",
        "企业官方主 Logo 的永久副本无法通过完整性核验",
      );
    }
  }
  const downloaded = await downloadArchiveBytes({
    descriptor: descriptors[0]!,
    apiKey: input.apiKey,
    baseUrl: input.baseUrl,
  });
  const validationSnapshotId = randomUUID();
  let authoritativeArchiveBuffer: Buffer = Buffer.from(downloaded.buffer);
  let parsed = await readKnowledgeArchive(
    downloaded.buffer,
    downloaded.filename,
    validationSnapshotId,
    {
      validationProfile:
        build.skillVersion === "1" ? "historical" : "dashboard-enterprise-v1",
      archiveContractVersions:
        build.skillVersion === "1"
          ? undefined
          : build.skillVersion === "4"
            ? [3, 4]
            : [2, 3],
    },
  );
  const storedAssetKeys = [...parsed.storedAssetKeys];
  let packageRevision = build.revision;
  let recoveredLogo:
    | {
        buffer: Buffer;
        filename: string;
        mimeType: string;
        sha256: string;
      }
    | undefined;
  try {
    const state: KnowledgeBaseProgressState = {
      schemaVersion: 1,
      revision: build.revision,
      currentLeafId: build.currentLeafId,
      leaves: nodes
        .sort((left, right) => left.ordinal - right.ordinal)
        .map((node) => ({
          id: node.leafId,
          title: node.title,
          branchId: node.branchId,
          branchTitle: node.branchTitle,
          status: node.status,
        })),
    };
    const nextState = applyKnowledgeBaseProgressEnvelope(
      state,
      progressEnvelope,
    );
    if (parsed.packageSchemaVersion === 4) {
      const canonical = await canonicalizeKnowledgeBaseFinalArchive({
        buffer: authoritativeArchiveBuffer,
        nodes: nodes.map((node) => ({
          leafId: node.leafId,
          title: node.title,
          branchId: node.branchId,
          branchTitle: node.branchTitle,
          ordinal: node.ordinal,
          status:
            nextState.leaves.find((leaf) => leaf.id === node.leafId)?.status ||
            node.status,
          contentMarkdown: node.contentMarkdown,
          contentSha256: node.contentSha256,
        })),
        buildRevision: nextState.revision,
      });
      if (canonical.changed) {
        authoritativeArchiveBuffer = canonical.buffer;
        parsed = await readKnowledgeArchive(
          authoritativeArchiveBuffer,
          downloaded.filename,
          randomUUID(),
          {
            validationProfile: "dashboard-enterprise-v1",
            archiveContractVersions: [4],
          },
        );
        storedAssetKeys.push(...parsed.storedAssetKeys);
      }
    }
    if (
      build.skillVersion === "4" &&
      parsed.packageBuildRevision !== nextState.revision
    ) {
      throw new KnowledgeBaseArtifactBindingError(
        "PACKAGE_NOT_READY",
        `最终 ZIP buildRevision 与权威版本不一致：期望 ${nextState.revision}，实际 ${String(parsed.packageBuildRevision ?? "缺失")}`,
      );
    }
    const presentation = assertKnowledgeBasePresentationMatchesState(
      nextState,
      assistantText,
    );
    assertArtifactEnvelopeBelongsToActiveTurn({
      build,
      activeTurn,
      envelope: presentation,
    });
    if (!canPackageKnowledgeBase(nextState)) {
      throw new KnowledgeBaseArtifactBindingError(
        "PACKAGE_NOT_READY",
        "最终 ZIP 不能早于最后一个节点确认",
      );
    }
    packageRevision = nextState.revision;
    const nextStatusByLeafId = new Map(
      nextState.leaves.map((leaf) => [leaf.id, leaf.status]),
    );
    if (!build.logoSha256) {
      if (build.skillVersion !== "3" && parsed.assets.length !== 1) {
        throw new KnowledgeBaseArtifactBindingError(
          "PACKAGE_NOT_READY",
          `历史在建知识库 ZIP 必须包含唯一官方主 Logo，实际检测到 ${parsed.assets.length} 张图片`,
        );
      }
      const logo =
        build.skillVersion === "3"
          ? selectLegacyKnowledgeBaseLogoAsset({ assets: parsed.assets })
          : parsed.assets[0]!;
      const buffer = await readStoredKnowledgeAssetBytes(logo.key);
      const sha256 = createHash("sha256").update(buffer).digest("hex");
      if (!logo.sha256 || logo.sha256.toLowerCase() !== sha256) {
        throw new KnowledgeBaseArtifactBindingError(
          "PACKAGE_NOT_READY",
          "历史在建知识库 ZIP 中的 Logo 字节哈希不一致",
        );
      }
      recoveredLogo = {
        buffer,
        filename: path.basename(logo.path),
        mimeType: logo.mimeType,
        sha256,
      };
    }
    const expectedCustomerUploads =
      build.skillVersion === "4"
        ? await verifiedKnowledgeBaseCustomerUploadsForBuild({
            userId: input.userId,
            buildId: build.id,
            generation: build.generation,
            officialLogoSha256: build.logoSha256,
          })
        : [];
    const expectedOfficialLogoUpload =
      build.skillVersion === "4"
        ? await verifiedKnowledgeBaseOfficialLogoUploadForBuild({
            userId: input.userId,
            buildId: build.id,
            generation: build.generation,
          })
        : undefined;
    assertKnowledgeBasePackageMatchesBuild({
      nodes: nodes.map((node) => ({
        leafId: node.leafId,
        title: node.title,
        branchId: node.branchId,
        branchTitle: node.branchTitle,
        ordinal: node.ordinal,
        status: nextStatusByLeafId.get(node.leafId) || node.status,
        contentMarkdown: node.contentMarkdown,
        contentSha256: node.contentSha256,
      })),
      documents: parsed.documents,
      assets: parsed.assets,
      expectedLogoSha256: build.logoSha256 || recoveredLogo!.sha256,
      packageSchemaVersion: parsed.packageSchemaVersion,
      expectedCustomerUploads,
      expectedOfficialLogoUpload,
      legacyV3Compatibility: build.skillVersion === "3",
    });
    if (parsed.packageSchemaVersion === 4) {
      await assertKnowledgeBaseCustomerUploadVisualBindings({
        assets: parsed.assets,
        expectedUploads: expectedCustomerUploads,
        readPackagedAssetBytes: readStoredKnowledgeAssetBytes,
      });
    }
  } finally {
    await removeStoredKnowledgeAssets(storedAssetKeys);
  }
  if (build.skillVersion === "4") {
    if (!activeTurn?.operationKey) {
      throw new KnowledgeBaseArtifactBindingError(
        "BUILD_CHANGED",
        "当前 v4 最终轮没有有效操作 reservation",
      );
    }
    const descriptor = descriptors[0]!;
    const sourceDescriptorHash =
      knowledgeArchivePhysicalDescriptorHash(descriptor);
    const staged = await stageKnowledgeBuildArtifact({
      userId: input.userId,
      buildId: input.buildId,
      generation: input.generation,
      turnId: activeTurn.id,
      operationKey: activeTurn.operationKey,
      descriptorHash: sourceDescriptorHash,
      kind: "package",
      buffer: authoritativeArchiveBuffer,
    });
    return assertStagedCandidateStillAuthoritative({
      staged: true,
      kind: "package",
      userId: input.userId,
      buildId: input.buildId,
      generation: input.generation,
      turnId: activeTurn.id,
      operationKey: activeTurn.operationKey,
      taskId: input.taskId,
      expectedStateEpoch: build.stateEpoch,
      expectedRevision: build.revision,
      descriptorHash: knowledgeArchiveBoundDescriptorHash(
        descriptor,
        staged.sha256,
      ),
      sourceDescriptorHash,
      storageKey: staged.storageKey,
      sha256: staged.sha256,
      bytes: staged.bytes,
      filename: path.basename(downloaded.filename).slice(0, 512),
      mimeType: "application/zip",
      packageRevision,
      outputItemId: descriptor.outputItemId.slice(0, 255),
      fileId: descriptor.fileId?.slice(0, 255),
    });
  }
  let persistedLogo:
    | Awaited<ReturnType<typeof persistKnowledgeBuildArtifact>>
    | undefined;
  let persisted: Awaited<ReturnType<typeof persistKnowledgeBuildArtifact>>;
  try {
    if (recoveredLogo) {
      persistedLogo = await persistKnowledgeBuildArtifact({
        userId: input.userId,
        buildId: input.buildId,
        generation: input.generation,
        kind: "logo",
        buffer: recoveredLogo.buffer,
        expectedSha256: recoveredLogo.sha256,
      });
    }
    persisted = await persistKnowledgeBuildArtifact({
      userId: input.userId,
      buildId: input.buildId,
      generation: input.generation,
      kind: "package",
      buffer: downloaded.buffer,
    });
  } catch (error) {
    if (persistedLogo) {
      await removeKnowledgeBuildArtifact({
        userId: input.userId,
        buildId: input.buildId,
        generation: input.generation,
        kind: "logo",
      }).catch(() => undefined);
    }
    throw error;
  }
  const descriptor = descriptors[0]!;
  await db
    .update(knowledgeBaseBuilds)
    .set({
      packageRevision,
      packageTaskId: input.taskId.slice(0, 255),
      packageOutputItemId: descriptor.outputItemId.slice(0, 255),
      packageFileId: descriptor.fileId?.slice(0, 255) || null,
      packageFilename: path.basename(downloaded.filename).slice(0, 512),
      packageDescriptorHash: knowledgeArchiveDescriptorHash(descriptor),
      packageStorageKey: persisted.storageKey,
      packageArchiveSha256: persisted.sha256,
      packageSizeBytes: persisted.bytes,
      ...(persistedLogo && recoveredLogo
        ? {
            logoStorageKey: persistedLogo.storageKey,
            logoSha256: persistedLogo.sha256,
            logoBytes: persistedLogo.bytes,
            logoFilename: recoveredLogo.filename.slice(0, 512),
            logoMimeType: recoveredLogo.mimeType.slice(0, 255),
          }
        : {}),
    })
    .where(
      and(
        eq(knowledgeBaseBuilds.id, input.buildId),
        eq(knowledgeBaseBuilds.userId, input.userId),
        eq(knowledgeBaseBuilds.generation, input.generation),
        eq(knowledgeBaseBuilds.upstreamTaskId, input.taskId),
        eq(knowledgeBaseBuilds.status, "confirming"),
        eq(knowledgeBaseBuilds.revision, build.revision),
      ),
    );
  const rebound = (await loadBoundBuild(input)).build;
  if (
    rebound.packageArchiveSha256 !== persisted.sha256 ||
    rebound.packageSizeBytes !== persisted.bytes ||
    rebound.packageRevision !== packageRevision
  ) {
    throw new KnowledgeBaseArtifactBindingError(
      "BUILD_CHANGED",
      "知识库状态已变化，最终 ZIP 未绑定到旧版本",
    );
  }
  return {
    ...persisted,
    filename: rebound.packageFilename!,
    idempotent: false,
  };
}

/**
 * Compatibility/recovery path for a legacy build that reached
 * `ready_to_publish` before Dashboard-owned artifact storage existed. A
 * backfilled `PACKAGE_REBIND_REQUIRED` build is restored through this same
 * path. It does not replay a Progress transition: the already-committed
 * database nodes are the authority, and the ZIP must match them byte-for-byte
 * at the document/hash level before publication eligibility is restored.
 */
export async function bindKnowledgeBaseReadyPackage(input: {
  userId: number;
  buildId: string;
  generation: number;
  taskId: string;
  output: unknown;
  apiKey: string;
  baseUrl: string;
}) {
  const { db, build } = await loadBoundBuild(input);
  const packageRebindRequired =
    build.status === "protocol_error" &&
    build.protocolErrorCode === "PACKAGE_REBIND_REQUIRED";
  if (build.status !== "ready_to_publish" && !packageRebindRequired) {
    throw new KnowledgeBaseArtifactBindingError(
      "BUILD_CHANGED",
      "知识库不再处于等待发布状态，历史 ZIP 已忽略",
    );
  }
  const descriptors = collectKnowledgeArchiveDescriptors(input.output);
  const descriptor = selectKnowledgeBaseReadyPackageDescriptor({
    descriptors,
    identity: build,
  });
  const validPackageSha256 = /^[a-f0-9]{64}$/u.test(
    String(build.packageArchiveSha256 || ""),
  )
    ? build.packageArchiveSha256!
    : null;
  const validLogoSha256 = /^[a-f0-9]{64}$/u.test(String(build.logoSha256 || ""))
    ? build.logoSha256!
    : null;
  const packageMetadataComplete = Boolean(
    build.packageStorageKey &&
      validPackageSha256 &&
      Number(build.packageSizeBytes) > 0,
  );
  const logoMetadataComplete =
    build.skillVersion !== "4" ||
    Boolean(
      build.logoStorageKey && validLogoSha256 && Number(build.logoBytes) > 0,
    );
  let durablePackageVerified = false;
  let durableLogoVerified = build.skillVersion !== "4";
  if (packageMetadataComplete) {
    try {
      await readKnowledgeBuildArtifact({
        userId: input.userId,
        buildId: input.buildId,
        generation: input.generation,
        kind: "package",
        expectedSha256: validPackageSha256!,
        expectedBytes: build.packageSizeBytes!,
        storageKey: build.packageStorageKey!,
      });
      durablePackageVerified = true;
    } catch (error) {
      if (!(error instanceof KnowledgeBuildArtifactError)) throw error;
      // Metadata without readable bytes is not durable authority. Continue
      // through the same ZIP parser/hash validator used by a missing artifact
      // so the specialized rebind can repair the build safely.
      durablePackageVerified = false;
    }
  }
  if (build.skillVersion === "4" && logoMetadataComplete) {
    try {
      await readKnowledgeBuildArtifact({
        userId: input.userId,
        buildId: input.buildId,
        generation: input.generation,
        kind: "logo",
        expectedSha256: validLogoSha256!,
        expectedBytes: build.logoBytes!,
        storageKey: build.logoStorageKey!,
      });
      durableLogoVerified = true;
    } catch (error) {
      if (!(error instanceof KnowledgeBuildArtifactError)) throw error;
      durableLogoVerified = false;
    }
  }
  if (durablePackageVerified && durableLogoVerified) {
    if (packageRebindRequired) {
      const persistedDescriptorMatches =
        build.skillVersion === "4"
          ? build.packageDescriptorHash ===
            knowledgeArchiveBoundDescriptorHash(descriptor, validPackageSha256!)
          : Boolean(build.packageFileId || build.packageOutputItemId) ||
            build.packageDescriptorHash ===
              knowledgeArchiveDescriptorHash(descriptor);
      if (
        build.packageRevision !== build.revision ||
        build.packageTaskId !== input.taskId ||
        !build.packageDescriptorHash ||
        !persistedDescriptorMatches
      ) {
        throw new KnowledgeBaseArtifactBindingError(
          "BUILD_CHANGED",
          "待恢复知识库成品与当前权威任务或版本不一致",
        );
      }
      await db
        .update(knowledgeBaseBuilds)
        .set({
          status: "ready_to_publish",
          stateEpoch: build.stateEpoch + 1,
          protocolError: null,
          protocolErrorCode: null,
          awaitingResponseSince: null,
          completedAt: build.completedAt || new Date(),
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(knowledgeBaseBuilds.id, input.buildId),
            eq(knowledgeBaseBuilds.userId, input.userId),
            eq(knowledgeBaseBuilds.generation, input.generation),
            eq(knowledgeBaseBuilds.upstreamTaskId, input.taskId),
            eq(knowledgeBaseBuilds.status, "protocol_error"),
            eq(
              knowledgeBaseBuilds.protocolErrorCode,
              "PACKAGE_REBIND_REQUIRED",
            ),
            eq(knowledgeBaseBuilds.revision, build.revision),
            eq(knowledgeBaseBuilds.stateEpoch, build.stateEpoch),
          ),
        );
      const rebound = (await loadBoundBuild(input)).build;
      if (
        rebound.status !== "ready_to_publish" ||
        rebound.protocolError ||
        rebound.protocolErrorCode ||
        rebound.packageArchiveSha256 !== validPackageSha256 ||
        (build.skillVersion === "4" &&
          (rebound.logoSha256 !== validLogoSha256 ||
            rebound.logoBytes !== build.logoBytes ||
            rebound.logoStorageKey !== build.logoStorageKey))
      ) {
        throw new KnowledgeBaseArtifactBindingError(
          "BUILD_CHANGED",
          "知识库成品重新绑定状态已变化，请刷新后重试",
        );
      }
    }
    return {
      storageKey: build.packageStorageKey!,
      sha256: validPackageSha256!,
      bytes: build.packageSizeBytes!,
      filename: build.packageFilename || descriptor.filename,
      idempotent: true,
    };
  }
  const downloaded = await downloadArchiveBytes({
    descriptor,
    apiKey: input.apiKey,
    baseUrl: input.baseUrl,
  });
  let authoritativeArchiveBuffer: Buffer = Buffer.from(downloaded.buffer);
  let parsed = await readKnowledgeArchive(
    authoritativeArchiveBuffer,
    downloaded.filename,
    randomUUID(),
    {
      validationProfile:
        build.skillVersion === "1" ? "historical" : "dashboard-enterprise-v1",
      archiveContractVersions:
        build.skillVersion === "1"
          ? undefined
          : build.skillVersion === "4"
            ? [3, 4]
            : [2, 3],
    },
  );
  const storedAssetKeys = [...parsed.storedAssetKeys];
  let recoveredLogo:
    | {
        buffer: Buffer;
        filename: string;
        mimeType: string;
        sha256: string;
      }
    | undefined;
  try {
    const nodes = await db
      .select()
      .from(knowledgeBaseBuildNodes)
      .where(eq(knowledgeBaseBuildNodes.buildId, build.id));
    if (parsed.packageSchemaVersion === 4) {
      const canonical = await canonicalizeKnowledgeBaseFinalArchive({
        buffer: authoritativeArchiveBuffer,
        nodes: nodes.map((node) => ({
          leafId: node.leafId,
          title: node.title,
          branchId: node.branchId,
          branchTitle: node.branchTitle,
          ordinal: node.ordinal,
          status: node.status,
          contentMarkdown: node.contentMarkdown,
          contentSha256: node.contentSha256,
        })),
        buildRevision: build.revision,
      });
      if (canonical.changed) {
        authoritativeArchiveBuffer = canonical.buffer;
        parsed = await readKnowledgeArchive(
          authoritativeArchiveBuffer,
          downloaded.filename,
          randomUUID(),
          {
            validationProfile: "dashboard-enterprise-v1",
            archiveContractVersions: [4],
          },
        );
        storedAssetKeys.push(...parsed.storedAssetKeys);
      }
    }
    if (
      validPackageSha256 &&
      !knowledgeBaseRecoveredPackageMatchesStoredHash({
        expectedSha256: validPackageSha256,
        providerBuffer: downloaded.buffer,
        authoritativeBuffer: authoritativeArchiveBuffer,
      })
    ) {
      throw new KnowledgeBaseArtifactBindingError(
        "BUILD_CHANGED",
        "历史知识库 ZIP 字节与持久化权威哈希不一致",
      );
    }
    if (
      build.skillVersion === "4" &&
      parsed.packageBuildRevision !== build.revision
    ) {
      throw new KnowledgeBaseArtifactBindingError(
        "PACKAGE_NOT_READY",
        `历史 ZIP buildRevision 与权威版本不一致：期望 ${build.revision}，实际 ${String(parsed.packageBuildRevision ?? "缺失")}`,
      );
    }
    if (
      (build.skillVersion === "4" && !durableLogoVerified) ||
      (build.skillVersion !== "4" && !validLogoSha256)
    ) {
      const logo = selectKnowledgeBaseRecoveryLogoAsset({
        skillVersion: build.skillVersion,
        assets: parsed.assets,
        expectedLogoSha256: validLogoSha256,
      });
      const buffer = await readStoredKnowledgeAssetBytes(logo.key);
      const sha256 = createHash("sha256").update(buffer).digest("hex");
      if (!logo.sha256 || logo.sha256.toLowerCase() !== sha256) {
        throw new KnowledgeBaseArtifactBindingError(
          "PACKAGE_NOT_READY",
          "历史知识库 ZIP 中的 Logo 字节哈希不一致",
        );
      }
      recoveredLogo = {
        buffer,
        filename: path.basename(logo.path),
        mimeType: logo.mimeType,
        sha256,
      };
    }
    const expectedCustomerUploads =
      build.skillVersion === "4"
        ? await verifiedKnowledgeBaseCustomerUploadsForBuild({
            userId: input.userId,
            buildId: build.id,
            generation: build.generation,
            officialLogoSha256: validLogoSha256,
          })
        : [];
    const expectedOfficialLogoUpload =
      build.skillVersion === "4"
        ? await verifiedKnowledgeBaseOfficialLogoUploadForBuild({
            userId: input.userId,
            buildId: build.id,
            generation: build.generation,
          })
        : undefined;
    assertKnowledgeBasePackageMatchesBuild({
      nodes: nodes.map((node) => ({
        leafId: node.leafId,
        title: node.title,
        branchId: node.branchId,
        branchTitle: node.branchTitle,
        ordinal: node.ordinal,
        status: node.status,
        contentMarkdown: node.contentMarkdown,
        contentSha256: node.contentSha256,
      })),
      documents: parsed.documents,
      assets: parsed.assets,
      expectedLogoSha256: validLogoSha256 || recoveredLogo!.sha256,
      packageSchemaVersion: parsed.packageSchemaVersion,
      expectedCustomerUploads,
      expectedOfficialLogoUpload,
      legacyV3Compatibility: build.skillVersion === "3",
    });
    if (parsed.packageSchemaVersion === 4) {
      await assertKnowledgeBaseCustomerUploadVisualBindings({
        assets: parsed.assets,
        expectedUploads: expectedCustomerUploads,
        readPackagedAssetBytes: readStoredKnowledgeAssetBytes,
      });
    }
  } finally {
    await removeStoredKnowledgeAssets(storedAssetKeys);
  }

  let persistedLogo:
    | Awaited<ReturnType<typeof persistKnowledgeBuildArtifact>>
    | undefined;
  let persisted:
    | Awaited<ReturnType<typeof persistKnowledgeBuildArtifact>>
    | undefined;
  try {
    if (recoveredLogo) {
      persistedLogo = await persistKnowledgeBuildArtifact({
        userId: input.userId,
        buildId: input.buildId,
        generation: input.generation,
        kind: "logo",
        buffer: recoveredLogo.buffer,
        expectedSha256: recoveredLogo.sha256,
      });
    }
    persisted = await persistKnowledgeBuildArtifact({
      userId: input.userId,
      buildId: input.buildId,
      generation: input.generation,
      kind: "package",
      buffer: authoritativeArchiveBuffer,
    });
  } catch (error) {
    if (persistedLogo) {
      await removeKnowledgeBuildArtifact({
        userId: input.userId,
        buildId: input.buildId,
        generation: input.generation,
        kind: "logo",
      }).catch(() => undefined);
    }
    throw error;
  }
  const reboundStatus = packageRebindRequired
    ? "ready_to_publish"
    : build.status;
  await db
    .update(knowledgeBaseBuilds)
    .set({
      status: reboundStatus,
      ...(packageRebindRequired
        ? {
            stateEpoch: build.stateEpoch + 1,
            protocolError: null,
            protocolErrorCode: null,
            awaitingResponseSince: null,
            completedAt: build.completedAt || new Date(),
          }
        : {}),
      packageRevision: build.revision,
      packageTaskId: input.taskId.slice(0, 255),
      packageOutputItemId: descriptor.outputItemId.slice(0, 255),
      packageFileId: descriptor.fileId?.slice(0, 255) || null,
      packageFilename: path.basename(downloaded.filename).slice(0, 512),
      packageDescriptorHash:
        build.skillVersion === "4"
          ? knowledgeArchiveBoundDescriptorHash(descriptor, persisted.sha256)
          : knowledgeArchiveDescriptorHash(descriptor),
      packageStorageKey: persisted.storageKey,
      packageArchiveSha256: persisted.sha256,
      packageSizeBytes: persisted.bytes,
      ...(persistedLogo && recoveredLogo
        ? {
            logoStorageKey: persistedLogo.storageKey,
            logoSha256: persistedLogo.sha256,
            logoBytes: persistedLogo.bytes,
            logoFilename: recoveredLogo.filename.slice(0, 512),
            logoMimeType: recoveredLogo.mimeType.slice(0, 255),
          }
        : {}),
    })
    .where(
      and(
        eq(knowledgeBaseBuilds.id, input.buildId),
        eq(knowledgeBaseBuilds.userId, input.userId),
        eq(knowledgeBaseBuilds.generation, input.generation),
        eq(knowledgeBaseBuilds.upstreamTaskId, input.taskId),
        eq(knowledgeBaseBuilds.status, build.status),
        ...(packageRebindRequired
          ? [
              eq(
                knowledgeBaseBuilds.protocolErrorCode,
                "PACKAGE_REBIND_REQUIRED",
              ),
              eq(knowledgeBaseBuilds.stateEpoch, build.stateEpoch),
            ]
          : []),
        eq(knowledgeBaseBuilds.revision, build.revision),
      ),
    );
  const rebound = (await loadBoundBuild(input)).build;
  if (
    rebound.packageArchiveSha256 !== persisted.sha256 ||
    rebound.packageSizeBytes !== persisted.bytes ||
    rebound.packageRevision !== build.revision ||
    rebound.status !== reboundStatus ||
    (build.skillVersion === "4" &&
      (!rebound.logoStorageKey ||
        rebound.logoSha256 !== (validLogoSha256 || recoveredLogo?.sha256) ||
        !rebound.logoBytes)) ||
    (packageRebindRequired &&
      (rebound.protocolError !== null || rebound.protocolErrorCode !== null))
  ) {
    throw new KnowledgeBaseArtifactBindingError(
      "BUILD_CHANGED",
      "历史知识库状态已变化，最终 ZIP 未重新绑定",
    );
  }
  return {
    ...persisted,
    filename: rebound.packageFilename!,
    idempotent: false,
  };
}
