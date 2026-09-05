import axios, { type AxiosResponse } from "axios";
import { and, eq, inArray, isNull } from "drizzle-orm";
import { createHash, randomUUID } from "node:crypto";
import path from "node:path";

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
  KnowledgeArchiveValidationError,
  readKnowledgeArchive,
  readStoredKnowledgeAssetBytes,
  removeStoredKnowledgeAssets,
} from "./dashboard-api";
import {
  assertKnowledgeBaseArtifactIdentity,
  collectKnowledgeArchiveDescriptors,
  KnowledgeBaseArtifactIdentityError,
  KnowledgeBaseFinalOutputResourceContractError,
  knowledgeArchiveBoundDescriptorHash,
  knowledgeArchiveDescriptorHash,
  knowledgeArchiveFileIdFromUrl,
  knowledgeArchivePhysicalDescriptorHash,
  type KnowledgeArchiveDescriptor,
} from "./knowledge-base-artifact";
import {
  assertKnowledgeBasePackageMatchesBuild,
  KnowledgeBasePackageBindingError,
  selectLegacyKnowledgeBaseLogoAsset,
} from "./knowledge-base-package-validation";
import {
  canonicalizeKnowledgeBaseFinalArchive,
  KnowledgeBasePackageCanonicalizationError,
} from "./knowledge-base-package-canonicalization";
import {
  createKnowledgeBaseAuthoritativeFinalOutput,
  deriveKnowledgeBaseAuthoritativeFinalizationPlan,
  hasKnowledgeBaseCompleteFinalProtocol,
  selectKnowledgeBaseAuthoritativeFinalDescriptor,
} from "./knowledge-base-finalization";
import {
  assertKnowledgeBaseCustomerUploadVisualBindings,
  verifiedKnowledgeBasePackageUploadEvidenceForBuild,
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
  knowledgeBaseTreePolicy,
  parseKnowledgeBaseManifestEnvelope,
  parseKnowledgeBaseProgressEnvelope,
  validateKnowledgeBaseManifestForTreePolicy,
  type KnowledgeBaseProgressState,
} from "./knowledge-base-progress";
import {
  classifyKnowledgeBaseUserAction,
  collectTrustedKnowledgeBaseOutputImageDescriptors,
  extractFinalKnowledgeBaseAssistantText,
  knowledgeBaseOutputImageDescriptorHash,
  selectKnowledgeBaseProtocolOperationOutput,
} from "./knowledge-base-progress-service";
import {
  knowledgeBaseArchiveRequiresV4UploadEvidence,
  knowledgeBaseArchiveReadContractVersions,
  knowledgeBaseArchiveWriteContractVersions,
} from "./knowledge-base-archive-contract";
import { runKnowledgePackageLiveShadow } from "./knowledge-base-package-shadow-live";

const MAX_LOGO_DOWNLOAD_BYTES = 15 * 1024 * 1024;
const MAX_OFFICIAL_LOGO_UPLOAD_BYTES = 100 * 1024 * 1024;
const OFFICIAL_LOGO_UPLOAD_MIME_TYPES = new Set([
  "image/avif",
  "image/gif",
  "image/jpeg",
  "image/png",
  "image/webp",
]);

export function assertKnowledgeBaseOfficialLogoUploadCandidate(
  upload: Omit<KnowledgeBaseOfficialLogoUpload, "verified">,
) {
  if (
    upload.index !== 0 ||
    !upload.fileId ||
    !String(upload.filename || "").trim() ||
    !OFFICIAL_LOGO_UPLOAD_MIME_TYPES.has(
      String(upload.mimeType || "")
        .trim()
        .toLowerCase(),
    ) ||
    !Number.isSafeInteger(upload.sizeBytes) ||
    upload.sizeBytes < 1 ||
    upload.sizeBytes > MAX_OFFICIAL_LOGO_UPLOAD_BYTES ||
    !/^[a-f0-9]{64}$/u.test(
      String(upload.sourceSha256 || "")
        .trim()
        .toLowerCase(),
    )
  ) {
    throw new KnowledgeBaseArtifactBindingError(
      "LOGO_UPLOAD_INVALID",
      "请只上传一张不超过 100 MB 的 PNG、JPEG、WebP、AVIF 或 GIF 格式企业主 Logo 原图",
    );
  }
}

export {
  knowledgeBaseArchiveRequiresV4UploadEvidence,
  knowledgeBaseArchiveReadContractVersions,
  knowledgeBaseArchiveWriteContractVersions,
} from "./knowledge-base-archive-contract";

export type KnowledgeBaseLogoDescriptor = {
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
      | "PACKAGE_INVALID"
      | "PACKAGE_AMBIGUOUS"
      | "BUILD_CHANGED"
      | "ARTIFACT_IDENTITY_INVALID"
      | "ARTIFACT_DOWNLOAD_FAILED",
    message: string,
  ) {
    super(message);
    this.name = "KnowledgeBaseArtifactBindingError";
  }
}

function assertKnowledgeBaseBindingIdentity(
  value: unknown,
  label: string,
  required = true,
) {
  try {
    const identity = assertKnowledgeBaseArtifactIdentity({
      value,
      label,
      required,
    });
    if (identity !== undefined && identity !== String(value)) {
      throw new KnowledgeBaseArtifactIdentityError(
        `${label} 含首尾空白，拒绝改写后继续绑定`,
      );
    }
    return identity;
  } catch (error) {
    if (error instanceof KnowledgeBaseArtifactIdentityError) {
      throw new KnowledgeBaseArtifactBindingError(
        "ARTIFACT_IDENTITY_INVALID",
        error.message,
      );
    }
    throw error;
  }
}

function collectKnowledgeArchiveDescriptorsForBinding(value: unknown) {
  try {
    return collectKnowledgeArchiveDescriptors(value);
  } catch (error) {
    if (error instanceof KnowledgeBaseArtifactIdentityError) {
      throw new KnowledgeBaseArtifactBindingError(
        "PACKAGE_INVALID",
        error.message,
      );
    }
    throw error;
  }
}

async function readKnowledgeArchiveForBinding(
  ...args: Parameters<typeof readKnowledgeArchive>
) {
  try {
    return await readKnowledgeArchive(...args);
  } catch (error) {
    if (error instanceof KnowledgeArchiveValidationError) {
      throw new KnowledgeBaseArtifactBindingError(
        "PACKAGE_INVALID",
        error.message,
      );
    }
    throw error;
  }
}

async function observeValidatedV4PackageShadow(input: {
  buildId: string;
  generation: number;
  treePolicyVersion: number;
  archiveBytes: Buffer;
  parsed: Awaited<ReturnType<typeof readKnowledgeArchive>>;
  nodes: ReadonlyArray<{
    leafId: string;
    contentMarkdown: string | null;
  }>;
}) {
  try {
    await runKnowledgePackageLiveShadow({
      buildId: input.buildId,
      generation: input.generation,
      archiveBytes: input.archiveBytes,
      validatedArchive: input.parsed,
      serverLeafMarkdownById: new Map(
        input.nodes.flatMap((node) =>
          typeof node.contentMarkdown === "string"
            ? [[node.leafId, node.contentMarkdown] as const]
            : [],
        ),
      ),
      readDashboardAssetBytes: (asset) =>
        readStoredKnowledgeAssetBytes(asset.key),
      validateArchive: async (bytes) => {
        const candidate = await readKnowledgeArchiveForBinding(
          bytes,
          "FINAL.shadow.zip",
          randomUUID(),
          {
            validationProfile: "dashboard-enterprise-v1",
            archiveContractVersions: [4],
            dashboardEnterpriseMinLeaves: knowledgeBaseTreePolicy(
              input.treePolicyVersion,
            ).minLeaves,
            requireDashboardAdaptiveFormalGate: input.treePolicyVersion === 2,
          },
        );
        try {
          return candidate;
        } finally {
          await removeStoredKnowledgeAssets(candidate.storedAssetKeys);
        }
      },
      // The current v4 transport deliberately permits one physical FINAL.zip
      // only. Until the provider transport gains an independently reviewed
      // text supplement contract, Shadow B records the safe missing reason.
      supplementText: undefined,
    });
  } catch {
    // Keep a second failure-isolation boundary at the authoritative caller so
    // a future shadow implementation regression cannot block FINAL.zip.
  }
}

function rethrowKnowledgeBasePackageContentError(error: unknown): never {
  if (
    error instanceof KnowledgeBasePackageBindingError ||
    error instanceof KnowledgeBasePackageCanonicalizationError
  ) {
    throw new KnowledgeBaseArtifactBindingError(
      "PACKAGE_INVALID",
      error.message,
    );
  }
  throw error;
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

export type KnowledgeBaseRejectedInitialLogoDisposition = {
  rejected: true;
  kind: "logo";
  userId: number;
  buildId: string;
  generation: number;
  turnId: string;
  operationKey: string;
  taskId: string;
  expectedStateEpoch: number;
  expectedRevision: number;
  descriptorHashes: string[];
  rejectionCode:
    | "LOGO_NOT_READY"
    | "LOGO_AMBIGUOUS"
    | "LOGO_UPLOAD_INVALID"
    | "ARTIFACT_DOWNLOAD_FAILED";
};

export type KnowledgeBaseInitialLogoDisposition =
  | KnowledgeBaseStagedArtifactCandidate
  | KnowledgeBaseRejectedInitialLogoDisposition;

export function knowledgeBaseInitialLogoRejectionCode(error: unknown) {
  if (
    error instanceof KnowledgeBuildArtifactError &&
    error.code === "ARTIFACT_INVALID"
  ) {
    return "LOGO_UPLOAD_INVALID" as const;
  }
  if (!(error instanceof KnowledgeBaseArtifactBindingError)) return null;
  return [
    "LOGO_NOT_READY",
    "LOGO_AMBIGUOUS",
    "LOGO_UPLOAD_INVALID",
    "ARTIFACT_DOWNLOAD_FAILED",
  ].includes(error.code)
    ? (error.code as KnowledgeBaseRejectedInitialLogoDisposition["rejectionCode"])
    : null;
}

function rejectedInitialLogoDisposition(input: {
  error: unknown;
  descriptors: readonly KnowledgeBaseLogoDescriptor[];
  userId: number;
  build: typeof knowledgeBaseBuilds.$inferSelect;
  activeTurn?: typeof conversationTurns.$inferSelect;
  taskId: string;
}): KnowledgeBaseRejectedInitialLogoDisposition {
  const rejectionCode = knowledgeBaseInitialLogoRejectionCode(input.error);
  if (!rejectionCode) throw input.error;
  if (!input.activeTurn?.operationKey) {
    throw new KnowledgeBaseArtifactBindingError(
      "BUILD_CHANGED",
      "当前 v4 首轮没有有效操作 reservation",
    );
  }
  return {
    rejected: true,
    kind: "logo",
    userId: input.userId,
    buildId: input.build.id,
    generation: input.build.generation,
    turnId: input.activeTurn.id,
    operationKey: input.activeTurn.operationKey,
    taskId: input.taskId,
    expectedStateEpoch: input.build.stateEpoch,
    expectedRevision: input.build.revision,
    descriptorHashes: input.descriptors
      .map((descriptor) =>
        knowledgeBaseOutputImageDescriptorHash({
          fileId: descriptor.fileId || "",
          url: descriptor.url || "",
          filename: descriptor.filename,
          mimeType: descriptor.mimeType,
        }),
      )
      .sort(),
    rejectionCode,
  };
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
  for (const raw of collectTrustedKnowledgeBaseOutputImageDescriptors(value, {
    ignoreInvalidDescriptors: true,
    // Initial-Logo binding is byte-authoritative. Providers sometimes emit a
    // real PNG as a typed output_file with application/octet-stream and a
    // meaningless extension. Keep every assistant output_file in the
    // operation scope long enough to download and decode it; non-images are
    // rejected locally by the staged Logo byte validator.
    includeUndeclaredOutputFiles: true,
  })) {
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
  let response: AxiosResponse<ArrayBuffer>;
  try {
    if (fileId && !input.descriptor.url) {
      throw new KnowledgeBaseArtifactBindingError(
        "ARTIFACT_DOWNLOAD_FAILED",
        "Provider file ID 不是可持久读取的资产；请使用已本地化附件",
      );
    }
    const downloadUrl = assertSafeExternalUrl(input.descriptor.url || "");
    response = await axios.get<ArrayBuffer>(downloadUrl, {
      ...safeExternalRequestOptions,
      responseType: "arraybuffer",
      timeout: 120_000,
      maxContentLength: MAX_LOGO_DOWNLOAD_BYTES,
      maxBodyLength: MAX_LOGO_DOWNLOAD_BYTES,
      validateStatus: () => true,
    });
  } catch (error) {
    if (error instanceof KnowledgeBaseArtifactBindingError) throw error;
    throw new KnowledgeBaseArtifactBindingError(
      "ARTIFACT_DOWNLOAD_FAILED",
      "下载企业官方主 Logo 失败",
    );
  }
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

/**
 * A materialized v5 Logo replacement is only a staged candidate until the
 * corresponding PATCH Working Set wins its CAS.  Keeping these coordinates in
 * the turn ledger lets recovery validate the exact local bytes without
 * changing the build's authoritative Logo pointer early.
 */
export type KnowledgeBaseStagedOfficialLogo = {
  schemaVersion: 1;
  kind: "materialized_official_logo";
  operationKey: string;
  expectedRevision: number;
  expectedLeafId: string;
  storageKey: string;
  sha256: string;
  bytes: number;
  filename: string;
  mimeType: string;
  sourceSha256: string;
};

export function materializedKnowledgeBaseStagedOfficialLogo(input: {
  operationKey: string;
  expectedRevision: number;
  expectedLeafId: string;
  staged: { storageKey: string; sha256: string; bytes: number };
  filename: string;
  mimeType: string;
  sourceSha256: string;
}): KnowledgeBaseStagedOfficialLogo {
  return {
    schemaVersion: 1,
    kind: "materialized_official_logo",
    operationKey: input.operationKey,
    expectedRevision: input.expectedRevision,
    expectedLeafId: input.expectedLeafId,
    storageKey: input.staged.storageKey,
    sha256: input.staged.sha256,
    bytes: input.staged.bytes,
    filename: input.filename.slice(0, 512),
    mimeType: input.mimeType.slice(0, 255),
    sourceSha256: input.sourceSha256,
  };
}

export function knowledgeBaseExistingLogoUploadBindingDecision(input: {
  buildLogoSha256: string | null;
  buildLogoBytes: number | null;
  buildLogoMimeType: string | null;
  stagedSha256: string;
  stagedBytes: number;
  stagedMimeType: string;
  existingUpload: Record<string, unknown> | null;
  verifiedUpload: KnowledgeBaseOfficialLogoUpload;
  allowReplacement?: boolean;
}) {
  const immutableUploadKeys = [
    "index",
    "fileId",
    "filename",
    "mimeType",
    "sizeBytes",
    "sourceSha256",
  ] as const satisfies ReadonlyArray<keyof KnowledgeBaseOfficialLogoUpload>;
  const sameImmutableUpload = input.existingUpload
    ? immutableUploadKeys.every(
        (key) => input.existingUpload?.[key] === input.verifiedUpload[key],
      )
    : false;
  if (input.existingUpload && !sameImmutableUpload) {
    throw new KnowledgeBaseArtifactBindingError(
      "BUILD_CHANGED",
      "当前轮次已绑定另一份企业官方主 Logo 上传账本",
    );
  }
  if (!input.buildLogoSha256) return "bind_artifact" as const;
  if (
    input.buildLogoSha256 !== input.stagedSha256 ||
    input.buildLogoBytes !== input.stagedBytes ||
    input.buildLogoMimeType !== input.stagedMimeType
  ) {
    if (input.allowReplacement === true) return "replace_artifact" as const;
    throw new KnowledgeBaseArtifactBindingError(
      "BUILD_CHANGED",
      "企业官方主 Logo 已由另一轮操作绑定，请刷新后继续",
    );
  }
  return input.existingUpload?.verified === true
    ? ("already_complete" as const)
    : ("repair_provenance" as const);
}

export function knowledgeBaseAllowsFirstLeafLogoReplacement(input: {
  requested: boolean;
  skillVersion: string;
  executionMode?: string | null;
  confirmedCount: number;
  directPrefilledCount: number;
}) {
  return (
    input.requested === true &&
    (input.skillVersion === "4" ||
      (input.skillVersion === "5" &&
        input.executionMode === "materialized_bundle_v1")) &&
    input.confirmedCount === 0 &&
    input.directPrefilledCount === 0
  );
}

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
    input.sizeBytes > MAX_OFFICIAL_LOGO_UPLOAD_BYTES
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
    if (bytes > MAX_OFFICIAL_LOGO_UPLOAD_BYTES) {
      throw new KnowledgeBaseArtifactBindingError(
        "LOGO_UPLOAD_INVALID",
        "上传的 Logo 超过 100 MB，请压缩后重新上传",
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
  allowFirstLeafReplacement?: boolean;
  activation?: "immediate" | "materialized_patch";
}) {
  const uploadFileId = assertKnowledgeBaseBindingIdentity(
    input.upload.fileId,
    "客户上传文件标识",
  )!;
  const upload = {
    ...input.upload,
    fileId: uploadFileId,
    filename: String(input.upload.filename || "").trim(),
    mimeType: String(input.upload.mimeType || "")
      .trim()
      .toLowerCase(),
    sourceSha256: String(input.upload.sourceSha256 || "")
      .trim()
      .toLowerCase(),
  };
  assertKnowledgeBaseOfficialLogoUploadCandidate(upload);
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
  let duplicateBuildArtifact = false;
  let replacedBuildArtifactStorageKey: string | null = null;
  try {
    const result = await db.transaction(async (tx) => {
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
      const metadata = isRecord(turn.metadata) ? turn.metadata : {};
      const recovery = isRecord(metadata.recovery) ? metadata.recovery : {};
      const existingUpload = isRecord(recovery.officialLogoUpload)
        ? recovery.officialLogoUpload
        : null;
      const bindingDecision = knowledgeBaseExistingLogoUploadBindingDecision({
        buildLogoSha256: build.logoSha256,
        buildLogoBytes: build.logoBytes,
        buildLogoMimeType: build.logoMimeType,
        stagedSha256: staged.sha256,
        stagedBytes: staged.bytes,
        stagedMimeType,
        existingUpload,
        verifiedUpload,
        allowReplacement: knowledgeBaseAllowsFirstLeafLogoReplacement({
          requested: input.allowFirstLeafReplacement === true,
          skillVersion: build.skillVersion,
          executionMode: build.executionMode,
          confirmedCount: build.confirmedCount,
          directPrefilledCount: build.directPrefilledCount,
        }),
      });
      const nextMetadata = {
        ...metadata,
        recovery: {
          ...recovery,
          officialLogoUpload: verifiedUpload,
          ...(input.activation === "materialized_patch"
            ? {
                stagedOfficialLogo:
                  materializedKnowledgeBaseStagedOfficialLogo({
                    operationKey: input.operationKey,
                    expectedRevision: input.expectedRevision,
                    expectedLeafId: input.expectedLeafId,
                    staged,
                    filename: upload.filename,
                    mimeType: stagedMimeType,
                    sourceSha256: upload.sourceSha256,
                  }),
              }
            : {}),
        },
      };
      if (input.activation === "materialized_patch") {
        // PATCH validation and Working Set activation have not happened yet.
        // Persist only the immutable staging ledger; the build Logo pointer
        // and the previous artifact stay authoritative until the PATCH CAS.
        await tx
          .update(conversationTurns)
          .set({ metadata: nextMetadata, updatedAt: new Date() })
          .where(eq(conversationTurns.id, input.turnId));
        return verifiedUpload;
      }
      if (build.logoSha256 && bindingDecision !== "replace_artifact") {
        // A crash/replay may have committed the immutable artifact before the
        // turn provenance marker. Same bytes are not enough: repair the exact
        // active turn ledger before reporting success.
        if (bindingDecision === "repair_provenance") {
          await tx
            .update(conversationTurns)
            .set({ metadata: nextMetadata, updatedAt: new Date() })
            .where(eq(conversationTurns.id, input.turnId));
        }
        duplicateBuildArtifact = staged.storageKey !== build.logoStorageKey;
        return verifiedUpload;
      }
      if (bindingDecision === "replace_artifact") {
        replacedBuildArtifactStorageKey = build.logoStorageKey;
      }
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
    if (duplicateBuildArtifact) await removeStaged();
    if (
      replacedBuildArtifactStorageKey &&
      replacedBuildArtifactStorageKey !== staged.storageKey
    ) {
      await removeKnowledgeBuildArtifact({
        userId: input.userId,
        buildId: input.buildId,
        generation: input.generation,
        kind: "logo",
        storageKey: replacedBuildArtifactStorageKey,
      }).catch(() => undefined);
    }
    return result;
  } catch (error) {
    await removeStaged();
    throw error;
  }
}

/**
 * Collapse provider aliases by immutable bytes and identify every staging key
 * which must be removed before returning. Ambiguity cleanup deliberately
 * includes same-SHA aliases as well as each distinct physical candidate.
 */
export function selectKnowledgeBaseInitialLogoPhysicalCandidate(
  candidates: readonly KnowledgeBaseStagedArtifactCandidate[],
) {
  const bySha256 = new Map<string, KnowledgeBaseStagedArtifactCandidate>();
  for (const candidate of candidates) {
    if (!bySha256.has(candidate.sha256)) {
      bySha256.set(candidate.sha256, candidate);
    }
  }
  const uniqueByStorageKey = [
    ...new Map(
      candidates.map((candidate) => [candidate.storageKey, candidate]),
    ).values(),
  ];
  if (bySha256.size === 1) {
    const selected = bySha256.values().next().value!;
    return {
      selected,
      physicalCount: 1,
      cleanup: uniqueByStorageKey.filter(
        (candidate) => candidate.storageKey !== selected.storageKey,
      ),
    } as const;
  }
  return {
    selected: null,
    physicalCount: bySha256.size,
    cleanup: bySha256.size > 1 ? uniqueByStorageKey : [],
  } as const;
}

/**
 * Decode every typed file candidate independently. One unrelated PDF/ZIP must
 * never hide a valid Logo returned by the same provider operation.
 */
export async function probeKnowledgeBaseInitialLogoCandidates<T>(input: {
  descriptors: readonly KnowledgeBaseLogoDescriptor[];
  probe: (descriptor: KnowledgeBaseLogoDescriptor) => Promise<T>;
}) {
  const validCandidates: T[] = [];
  let lastRejectedError: unknown;
  for (const descriptor of input.descriptors) {
    try {
      validCandidates.push(await input.probe(descriptor));
    } catch (error) {
      if (!knowledgeBaseInitialLogoRejectionCode(error)) throw error;
      lastRejectedError = error;
    }
  }
  return { validCandidates, lastRejectedError };
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
  assertKnowledgeBaseBindingIdentity(input.taskId, "上游任务标识");
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
  const manifest = validateKnowledgeBaseManifestForTreePolicy(
    parseKnowledgeBaseManifestEnvelope(
      extractFinalKnowledgeBaseAssistantText(operationOutput),
    ),
    build.treePolicyVersion,
    { expectedUploadsRead: build.lastTurnAttachmentCount },
  );
  assertArtifactEnvelopeBelongsToActiveTurn({
    build,
    activeTurn,
    envelope: manifest,
  });
  let descriptors: KnowledgeBaseLogoDescriptor[] = [];
  try {
    descriptors = collectKnowledgeBaseLogoDescriptors(operationOutput);
  } catch (error) {
    if (error instanceof KnowledgeBaseArtifactIdentityError) {
      const bindingError = new KnowledgeBaseArtifactBindingError(
        "LOGO_UPLOAD_INVALID",
        error.message,
      );
      if (build.skillVersion === "4") {
        return rejectedInitialLogoDisposition({
          error: bindingError,
          descriptors,
          userId: input.userId,
          build,
          activeTurn,
          taskId: input.taskId,
        });
      }
      throw bindingError;
    }
    throw error;
  }
  const rejectInitialLogo = (error: unknown) =>
    rejectedInitialLogoDisposition({
      error,
      descriptors,
      userId: input.userId,
      build,
      activeTurn,
      taskId: input.taskId,
    });
  if (descriptors.length === 0) {
    const error = new KnowledgeBaseArtifactBindingError(
      "LOGO_NOT_READY",
      "首轮官方主 Logo 尚未随完整输出到达",
    );
    if (build.skillVersion === "4") return rejectInitialLogo(error);
    throw error;
  }
  if (build.skillVersion === "4") {
    if (!activeTurn?.operationKey) {
      throw new KnowledgeBaseArtifactBindingError(
        "BUILD_CHANGED",
        "当前 v4 首轮没有有效操作 reservation",
      );
    }
    const operationKey = activeTurn.operationKey;
    const { validCandidates, lastRejectedError } =
      await probeKnowledgeBaseInitialLogoCandidates({
        descriptors,
        probe: async (descriptor) => {
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
            operationKey,
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
            operationKey,
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
        },
      });
    const selection =
      selectKnowledgeBaseInitialLogoPhysicalCandidate(validCandidates);
    if (selection.selected) {
      await Promise.all(
        selection.cleanup.map((candidate) =>
          removeKnowledgeBaseStagedArtifactCandidate(candidate).catch(
            () => undefined,
          ),
        ),
      );
      return selection.selected;
    }
    if (selection.physicalCount > 1) {
      // Multiple independently valid bytes are an editorial choice, not a
      // research failure. Leave the tree usable and ask the customer to pick
      // or upload the official Logo; never guess or recreate the model task.
      await Promise.all(
        selection.cleanup.map((candidate) =>
          removeKnowledgeBaseStagedArtifactCandidate(candidate).catch(
            () => undefined,
          ),
        ),
      );
      return rejectInitialLogo(
        new KnowledgeBaseArtifactBindingError(
          "LOGO_AMBIGUOUS",
          `首轮返回了 ${selection.physicalCount} 张不同的有效图片，请选择或上传企业官方主 Logo`,
        ),
      );
    }
    return rejectInitialLogo(
      lastRejectedError ||
        new KnowledgeBaseArtifactBindingError(
          "LOGO_NOT_READY",
          "首轮没有可下载并解码的 Logo 图片",
        ),
    );
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

/**
 * Repair a first-node build that previously committed its text while dropping
 * a usable provider image. This reuses only the exact completed start turn and
 * its already-billed upstream task; it never creates or reopens a model turn.
 */
export async function recoverKnowledgeBaseInitialLogoFromCompletedTurn(input: {
  userId: number;
  buildId: string;
  generation: number;
  taskId: string;
  output: unknown;
  apiKey: string;
  baseUrl: string;
}) {
  assertKnowledgeBaseBindingIdentity(input.taskId, "上游任务标识");
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
        ),
      )
      .limit(1)
  )[0];
  if (
    !build ||
    build.skillVersion !== "4" ||
    build.status !== "confirming" ||
    build.revision !== 0 ||
    build.logoSha256 ||
    build.activeTurnId ||
    build.upstreamTaskId !== input.taskId ||
    !build.currentLeafId ||
    !build.lastAppliedOperationKey
  ) {
    return false;
  }
  const firstNode = (
    await db
      .select()
      .from(knowledgeBaseBuildNodes)
      .where(
        and(
          eq(knowledgeBaseBuildNodes.buildId, build.id),
          eq(knowledgeBaseBuildNodes.ordinal, 0),
        ),
      )
      .limit(1)
  )[0];
  if (!firstNode?.sourceTurnId || firstNode.leafId !== build.currentLeafId) {
    return false;
  }
  const completedTurn = (
    await db
      .select()
      .from(conversationTurns)
      .where(
        and(
          eq(conversationTurns.id, firstNode.sourceTurnId),
          eq(conversationTurns.userId, input.userId),
          eq(conversationTurns.buildId, build.id),
          eq(conversationTurns.buildGeneration, build.generation),
          eq(conversationTurns.status, "completed"),
        ),
      )
      .limit(1)
  )[0];
  if (
    !completedTurn?.operationKey ||
    completedTurn.operationType !== "start" ||
    completedTurn.upstreamTaskId !== input.taskId ||
    completedTurn.operationKey !== build.lastAppliedOperationKey ||
    completedTurn.expectedRevision !== 0 ||
    completedTurn.expectedLeafId !== null
  ) {
    return false;
  }

  const operationOutput = selectKnowledgeBaseProtocolOperationOutput(
    input.output,
    {
      operationId: completedTurn.operationKey,
      turnId: completedTurn.id,
      taskId: input.taskId,
      generation: input.generation,
      stateKind: "frontmind.knowledge-base.manifest",
    },
  );
  try {
    const manifest = validateKnowledgeBaseManifestForTreePolicy(
      parseKnowledgeBaseManifestEnvelope(
        extractFinalKnowledgeBaseAssistantText(operationOutput),
      ),
      build.treePolicyVersion,
      { expectedUploadsRead: build.lastTurnAttachmentCount },
    );
    assertArtifactEnvelopeBelongsToActiveTurn({
      build,
      activeTurn: completedTurn,
      envelope: manifest,
    });
  } catch {
    return false;
  }
  const descriptors = collectKnowledgeBaseLogoDescriptors(operationOutput);
  for (const descriptor of descriptors) {
    let staged: Awaited<ReturnType<typeof stageKnowledgeBuildArtifact>>;
    const descriptorHash = knowledgeBaseOutputImageDescriptorHash({
      fileId: descriptor.fileId || "",
      url: descriptor.url || "",
      filename: descriptor.filename,
      mimeType: descriptor.mimeType,
    });
    try {
      const buffer = await downloadLogoBytes({
        descriptor,
        apiKey: input.apiKey,
        baseUrl: input.baseUrl,
      });
      staged = await stageKnowledgeBuildArtifact({
        userId: input.userId,
        buildId: input.buildId,
        generation: input.generation,
        turnId: completedTurn.id,
        operationKey: completedTurn.operationKey,
        descriptorHash,
        kind: "logo",
        buffer,
      });
    } catch (error) {
      if (knowledgeBaseInitialLogoRejectionCode(error)) continue;
      throw error;
    }
    const mimeType =
      staged.format === "jpeg"
        ? "image/jpeg"
        : staged.format
          ? `image/${staged.format}`
          : "application/octet-stream";
    try {
      const recovered = await db.transaction(async (tx) => {
        const lockedBuild = (
          await tx
            .select()
            .from(knowledgeBaseBuilds)
            .where(
              and(
                eq(knowledgeBaseBuilds.id, build.id),
                eq(knowledgeBaseBuilds.userId, input.userId),
                eq(knowledgeBaseBuilds.generation, input.generation),
              ),
            )
            .limit(1)
            .for("update")
        )[0];
        const lockedNode = (
          await tx
            .select()
            .from(knowledgeBaseBuildNodes)
            .where(
              and(
                eq(knowledgeBaseBuildNodes.buildId, build.id),
                eq(knowledgeBaseBuildNodes.ordinal, 0),
              ),
            )
            .limit(1)
            .for("update")
        )[0];
        const lockedTurn = (
          await tx
            .select()
            .from(conversationTurns)
            .where(eq(conversationTurns.id, completedTurn.id))
            .limit(1)
            .for("update")
        )[0];
        if (
          !lockedBuild ||
          lockedBuild.stateEpoch !== build.stateEpoch ||
          lockedBuild.status !== "confirming" ||
          lockedBuild.revision !== 0 ||
          lockedBuild.logoSha256 ||
          lockedBuild.activeTurnId ||
          lockedBuild.currentLeafId !== firstNode.leafId ||
          lockedBuild.upstreamTaskId !== input.taskId ||
          lockedBuild.lastAppliedOperationKey !== completedTurn.operationKey ||
          lockedNode?.sourceTurnId !== completedTurn.id ||
          lockedTurn?.status !== "completed" ||
          lockedTurn.operationKey !== completedTurn.operationKey ||
          lockedTurn.upstreamTaskId !== input.taskId
        ) {
          return false;
        }
        const updated = await tx
          .update(knowledgeBaseBuilds)
          .set({
            stateEpoch: lockedBuild.stateEpoch + 1,
            logoStorageKey: staged.storageKey,
            logoSha256: staged.sha256,
            logoBytes: staged.bytes,
            logoFilename: descriptor.filename.slice(0, 512),
            logoMimeType: mimeType.slice(0, 255),
            updatedAt: new Date(),
          })
          .where(
            and(
              eq(knowledgeBaseBuilds.id, lockedBuild.id),
              eq(knowledgeBaseBuilds.userId, input.userId),
              eq(knowledgeBaseBuilds.generation, input.generation),
              eq(knowledgeBaseBuilds.stateEpoch, lockedBuild.stateEpoch),
              isNull(knowledgeBaseBuilds.logoSha256),
              isNull(knowledgeBaseBuilds.activeTurnId),
            ),
          );
        return Boolean(updated[0]?.affectedRows);
      });
      if (recovered) return true;
      await removeStagedKnowledgeBuildArtifact({
        userId: input.userId,
        buildId: input.buildId,
        generation: input.generation,
        kind: "logo",
        storageKey: staged.storageKey,
      }).catch(() => undefined);
      return false;
    } catch (error) {
      await removeStagedKnowledgeBuildArtifact({
        userId: input.userId,
        buildId: input.buildId,
        generation: input.generation,
        kind: "logo",
        storageKey: staged.storageKey,
      }).catch(() => undefined);
      throw error;
    }
  }
  return false;
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
  assertKnowledgeBaseBindingIdentity(input.taskId, "上游任务标识");
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
  let authoritativeDescriptor: KnowledgeArchiveDescriptor | null = null;
  try {
    authoritativeDescriptor = finalizationPlan
      ? selectKnowledgeBaseAuthoritativeFinalDescriptor({
          output: input.output,
          scopedOutput: scopedOperationOutput,
          plan: finalizationPlan,
        })
      : null;
  } catch (error) {
    if (error instanceof KnowledgeBaseArtifactIdentityError) {
      throw new KnowledgeBaseArtifactBindingError(
        "PACKAGE_INVALID",
        error.message,
      );
    }
    if (error instanceof KnowledgeBaseFinalOutputResourceContractError) {
      throw new KnowledgeBaseArtifactBindingError(
        error.code === "AMBIGUOUS"
          ? "PACKAGE_AMBIGUOUS"
          : error.code === "INVALID"
            ? "PACKAGE_INVALID"
            : "PACKAGE_NOT_READY",
        error.message,
      );
    }
    throw error;
  }
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
  const descriptors = finalizationPlan
    ? authoritativeDescriptor
      ? [authoritativeDescriptor]
      : []
    : collectKnowledgeArchiveDescriptorsForBinding(operationOutput);
  if (
    build.skillVersion === "4" &&
    !finalizationPlan &&
    descriptors.length === 0 &&
    collectKnowledgeArchiveDescriptorsForBinding(input.output).length > 0
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
  let parsed = await readKnowledgeArchiveForBinding(
    downloaded.buffer,
    downloaded.filename,
    validationSnapshotId,
    {
      validationProfile:
        build.skillVersion === "1" ? "historical" : "dashboard-enterprise-v1",
      archiveContractVersions: knowledgeBaseArchiveWriteContractVersions(
        build.skillVersion,
      ),
      dashboardEnterpriseMinLeaves: knowledgeBaseTreePolicy(
        build.treePolicyVersion,
      ).minLeaves,
      requireDashboardAdaptiveFormalGate: build.treePolicyVersion === 2,
      // v4 customerVisibleCharacters is derived entirely from the packaged
      // formal bytes. Let the binder reach its canonicalizer for this field
      // only; canonicalization is followed by another strict read below.
      allowV4CustomerVisibleCharacterCountRepair: build.skillVersion === "4",
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
        parsed = await readKnowledgeArchiveForBinding(
          authoritativeArchiveBuffer,
          downloaded.filename,
          randomUUID(),
          {
            validationProfile: "dashboard-enterprise-v1",
            archiveContractVersions: [4],
            dashboardEnterpriseMinLeaves: knowledgeBaseTreePolicy(
              build.treePolicyVersion,
            ).minLeaves,
            requireDashboardAdaptiveFormalGate: build.treePolicyVersion === 2,
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
    const {
      expectedCustomerUploads,
      expectedOfficialLogoUpload,
      expectedOfficialLogoProvenance,
    } = knowledgeBaseArchiveRequiresV4UploadEvidence(
      build.skillVersion,
      parsed.packageSchemaVersion,
    )
      ? await verifiedKnowledgeBasePackageUploadEvidenceForBuild({
          userId: input.userId,
          buildId: build.id,
          generation: build.generation,
          officialLogoSha256: build.logoSha256,
          packageArchiveSha256: createHash("sha256")
            .update(authoritativeArchiveBuffer)
            .digest("hex"),
        })
      : {
          expectedCustomerUploads: [],
          expectedOfficialLogoUpload: undefined,
          expectedOfficialLogoProvenance: undefined,
        };
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
      expectedOfficialLogoProvenance,
      legacyV3Compatibility: build.skillVersion === "3",
    });
    if (parsed.packageSchemaVersion === 4) {
      await assertKnowledgeBaseCustomerUploadVisualBindings({
        assets: parsed.assets,
        expectedUploads: expectedCustomerUploads,
        readPackagedAssetBytes: readStoredKnowledgeAssetBytes,
      });
      await observeValidatedV4PackageShadow({
        buildId: build.id,
        generation: build.generation,
        treePolicyVersion: build.treePolicyVersion,
        archiveBytes: authoritativeArchiveBuffer,
        parsed,
        nodes,
      });
    }
  } catch (error) {
    rethrowKnowledgeBasePackageContentError(error);
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
      outputItemId: assertKnowledgeBaseBindingIdentity(
        descriptor.outputItemId,
        "上游输出项标识",
      ),
      fileId: assertKnowledgeBaseBindingIdentity(
        descriptor.fileId,
        "上游文件标识",
        false,
      ),
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
      packageTaskId: input.taskId,
      packageOutputItemId: assertKnowledgeBaseBindingIdentity(
        descriptor.outputItemId,
        "上游输出项标识",
      ),
      packageFileId:
        assertKnowledgeBaseBindingIdentity(
          descriptor.fileId,
          "上游文件标识",
          false,
        ) || null,
      packageFilename: path.basename(downloaded.filename).slice(0, 512),
      packageDescriptorHash: knowledgeArchiveDescriptorHash(descriptor),
      packageStorageKey: persisted.storageKey,
      packageArchiveSha256: persisted.sha256,
      packageSizeBytes: persisted.bytes,
      packageStatus: "ready",
      packageAttemptCount: Math.max(1, build.packageAttemptCount),
      packageNextRetryAt: null,
      packageLastErrorCode: null,
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
  assertKnowledgeBaseBindingIdentity(input.taskId, "上游任务标识");
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
  const descriptors = collectKnowledgeArchiveDescriptorsForBinding(
    input.output,
  );
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
  let parsed = await readKnowledgeArchiveForBinding(
    authoritativeArchiveBuffer,
    downloaded.filename,
    randomUUID(),
    {
      validationProfile:
        build.skillVersion === "1" ? "historical" : "dashboard-enterprise-v1",
      archiveContractVersions: knowledgeBaseArchiveReadContractVersions(
        build.skillVersion,
      ),
      dashboardEnterpriseMinLeaves: knowledgeBaseTreePolicy(
        build.treePolicyVersion,
      ).minLeaves,
      requireDashboardAdaptiveFormalGate: build.treePolicyVersion === 2,
      // Match the final-turn binder: this derived v4 manifest field is
      // repaired from validated formal bytes, then the canonical archive is
      // immediately read again without this allowance below.
      allowV4CustomerVisibleCharacterCountRepair: build.skillVersion === "4",
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
        legacyV4ReadCompatibility: build.skillVersion === "4",
      });
      if (canonical.changed) {
        authoritativeArchiveBuffer = canonical.buffer;
        parsed = await readKnowledgeArchiveForBinding(
          authoritativeArchiveBuffer,
          downloaded.filename,
          randomUUID(),
          {
            validationProfile: "dashboard-enterprise-v1",
            archiveContractVersions: [4],
            dashboardEnterpriseMinLeaves: knowledgeBaseTreePolicy(
              build.treePolicyVersion,
            ).minLeaves,
            requireDashboardAdaptiveFormalGate: build.treePolicyVersion === 2,
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
    const {
      expectedCustomerUploads,
      expectedOfficialLogoUpload,
      expectedOfficialLogoProvenance,
    } = knowledgeBaseArchiveRequiresV4UploadEvidence(
      build.skillVersion,
      parsed.packageSchemaVersion,
    )
      ? await verifiedKnowledgeBasePackageUploadEvidenceForBuild({
          userId: input.userId,
          buildId: build.id,
          generation: build.generation,
          officialLogoSha256: validLogoSha256,
          packageArchiveSha256:
            validPackageSha256 ||
            createHash("sha256")
              .update(authoritativeArchiveBuffer)
              .digest("hex"),
        })
      : {
          expectedCustomerUploads: [],
          expectedOfficialLogoUpload: undefined,
          expectedOfficialLogoProvenance: undefined,
        };
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
      expectedOfficialLogoProvenance,
      legacyV3Compatibility: build.skillVersion === "3",
      legacyV4ReadCompatibility: build.skillVersion === "4",
    });
    if (parsed.packageSchemaVersion === 4) {
      await assertKnowledgeBaseCustomerUploadVisualBindings({
        assets: parsed.assets,
        expectedUploads: expectedCustomerUploads,
        readPackagedAssetBytes: readStoredKnowledgeAssetBytes,
      });
      await observeValidatedV4PackageShadow({
        buildId: build.id,
        generation: build.generation,
        treePolicyVersion: build.treePolicyVersion,
        archiveBytes: authoritativeArchiveBuffer,
        parsed,
        nodes,
      });
    }
  } catch (error) {
    rethrowKnowledgeBasePackageContentError(error);
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
      packageTaskId: input.taskId,
      packageOutputItemId: assertKnowledgeBaseBindingIdentity(
        descriptor.outputItemId,
        "上游输出项标识",
      ),
      packageFileId:
        assertKnowledgeBaseBindingIdentity(
          descriptor.fileId,
          "上游文件标识",
          false,
        ) || null,
      packageFilename: path.basename(downloaded.filename).slice(0, 512),
      packageDescriptorHash:
        build.skillVersion === "4"
          ? knowledgeArchiveBoundDescriptorHash(descriptor, persisted.sha256)
          : knowledgeArchiveDescriptorHash(descriptor),
      packageStorageKey: persisted.storageKey,
      packageArchiveSha256: persisted.sha256,
      packageSizeBytes: persisted.bytes,
      packageStatus: "ready",
      packageAttemptCount: Math.max(1, build.packageAttemptCount),
      packageNextRetryAt: null,
      packageLastErrorCode: null,
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
