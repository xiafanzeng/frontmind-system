import { createHash } from "node:crypto";

import { and, eq, isNull } from "drizzle-orm";

import { localAssets } from "../drizzle/schema";
import type { KnowledgeBaseLocalUploadCoordinate } from "../shared/knowledge-base-local-upload";
import { getDb } from "./db";
import {
  normalizeKnowledgeBaseClientAttachmentManifest,
  type KnowledgeBaseClientAttachmentManifestItem,
} from "./knowledge-base-client-attachment-manifest";
import { knowledgeBaseLocalAssetIdentity } from "./knowledge-base-local-asset-upload";
import { readStoredPresalesFile } from "./presales-file-store";
import {
  inspectKnowledgeBaseDeferredAttachmentStagePolicy,
  requireKnowledgeBaseDeferredAttachmentStageBuild,
} from "./knowledge-base-deferred-attachment-stage-policy";
import {
  cancelUnpreparedKnowledgeBaseTurn,
  inspectKnowledgeBaseDeferredAttachmentReservation,
  KnowledgeBaseTurnReservationError,
  stageKnowledgeBaseDeferredTurnAttachment,
  type KnowledgeBaseDeferredAttachmentReservationSnapshot,
  type KnowledgeBaseTurnRecord,
} from "./knowledge-base-turn-service";

const MAX_RECOVERABLE_LOCAL_ASSET_BYTES = 100 * 1024 * 1024;

type FrozenRecoveryManifestItem = KnowledgeBaseClientAttachmentManifestItem & {
  itemId: string;
  ordinal: number;
  total: number;
};

export type KnowledgeBaseMissingCustomerAttachment = {
  itemId: string;
  ordinal: number;
  filename: string;
  sizeBytes: number;
  mimeType: string;
  lastModified: number;
  sha256?: string;
};

export type KnowledgeBaseDeferredUploadResumeResult = {
  stagedCustomerAttachmentCount: number;
  retainedCustomerAttachmentCount: number;
  missingCustomerAttachments: KnowledgeBaseMissingCustomerAttachment[];
  readyToDispatch: boolean;
  attachmentManifest: FrozenRecoveryManifestItem[];
};

type RetainedKnowledgeBaseLocalAsset = {
  localAssetId: string;
  contentSha256: string;
  bytes?: Buffer;
};

type ResumeInput = {
  userId: number;
  projectAssignmentId: string | null;
  conversationId: string;
  turnId: string;
  clientRequestId: string;
  expectedResetRevision: number;
};

type ResumeDependencies = {
  inspectReservation?: typeof inspectKnowledgeBaseDeferredAttachmentReservation;
  requireStageBuild?: typeof requireKnowledgeBaseDeferredAttachmentStageBuild;
  findRetainedAsset?: typeof findRetainedKnowledgeBaseLocalAsset;
  inspectStagePolicy?: typeof inspectKnowledgeBaseDeferredAttachmentStagePolicy;
  cancelUnprepared?: typeof cancelUnpreparedKnowledgeBaseTurn;
  stageAttachment?: typeof stageKnowledgeBaseDeferredTurnAttachment;
  deriveIdentity?: typeof knowledgeBaseLocalAssetIdentity;
};

type RetainedAssetFinderDependencies = {
  loadOwnedAsset?: (input: {
    userId: number;
    localAssetId: string;
  }) => Promise<typeof localAssets.$inferSelect | null>;
  readStoredFile?: typeof readStoredPresalesFile;
};

function frozenRecoveryManifest(value: unknown): FrozenRecoveryManifestItem[] {
  const manifest = normalizeKnowledgeBaseClientAttachmentManifest(value);
  if (
    manifest.some(
      (item, index) =>
        !item.itemId ||
        item.ordinal !== index + 1 ||
        item.total !== manifest.length ||
        item.sizeBytes < 1,
    )
  ) {
    throw new KnowledgeBaseTurnReservationError(
      "CONFLICT",
      "The deferred upload manifest is missing its deterministic coordinates",
    );
  }
  return manifest as FrozenRecoveryManifestItem[];
}

function missingDescriptor(
  item: FrozenRecoveryManifestItem,
): KnowledgeBaseMissingCustomerAttachment {
  return {
    itemId: item.itemId,
    ordinal: item.ordinal,
    filename: item.filename,
    sizeBytes: item.sizeBytes,
    mimeType: item.mimeType,
    lastModified: item.lastModified,
    ...(item.sha256 ? { sha256: item.sha256 } : {}),
  };
}

/**
 * Return null when the deterministic row or its retained body is absent. A
 * present body whose size or integrity proof does not match is a conflict,
 * because silently accepting it would mask corruption.
 */
export async function findRetainedKnowledgeBaseLocalAsset(
  input: {
    userId: number;
    localAssetId: string;
    filename: string;
    mimeType: string;
    sizeBytes: number;
    sha256?: string;
    includeBytes?: boolean;
  },
  dependencies: RetainedAssetFinderDependencies = {},
): Promise<RetainedKnowledgeBaseLocalAsset | null> {
  const loadOwnedAsset =
    dependencies.loadOwnedAsset ??
    (async (coordinate: { userId: number; localAssetId: string }) => {
      const db = await getDb();
      if (!db) {
        throw new KnowledgeBaseTurnReservationError(
          "CONFLICT",
          "Dashboard 本地附件存储暂不可用",
        );
      }
      return (
        (
          await db
            .select()
            .from(localAssets)
            .where(
              and(
                eq(localAssets.id, coordinate.localAssetId),
                eq(localAssets.scope, "managed_user"),
                eq(localAssets.accountUserId, coordinate.userId),
                isNull(localAssets.presalesProjectId),
              ),
            )
            .limit(1)
        )[0] ?? null
      );
    });
  const asset = await loadOwnedAsset({
    userId: input.userId,
    localAssetId: input.localAssetId,
  });
  if (!asset) return null;

  const expectedSha256 = String(input.sha256 || "")
    .trim()
    .toLowerCase();
  if (
    asset.id !== input.localAssetId ||
    asset.scope !== "managed_user" ||
    asset.accountUserId !== input.userId ||
    asset.presalesProjectId !== null ||
    asset.sizeBytes !== input.sizeBytes ||
    (expectedSha256 && asset.contentSha256.toLowerCase() !== expectedSha256)
  ) {
    throw new KnowledgeBaseTurnReservationError(
      "CONFLICT",
      `附件“${input.filename}”的本地身份、字节或哈希不匹配，请重新上传`,
    );
  }
  // Retention remains authoritative even if the asynchronous sweeper has not
  // removed the bytes yet. Report an expired row as missing so the browser can
  // reselect the exact content and the existing upload path can safely re-arm
  // its retention under the same live coordinate.
  if (
    !(asset.retainUntil instanceof Date) ||
    asset.retainUntil.getTime() <= Date.now()
  ) {
    return null;
  }

  const stored = await (dependencies.readStoredFile ?? readStoredPresalesFile)(
    input.localAssetId,
  );
  // Expired/cleaned retained bytes are a normal missing upload. The row alone
  // is not content and must never make recovery fail as a protocol conflict.
  if (!stored) return null;
  if (
    asset.contentSha256.toLowerCase() !== stored.sha256?.toLowerCase() ||
    stored.sizeBytes !== input.sizeBytes ||
    (expectedSha256 && stored.sha256?.toLowerCase() !== expectedSha256)
  ) {
    throw new KnowledgeBaseTurnReservationError(
      "CONFLICT",
      `附件“${input.filename}”的本地身份、字节或哈希不匹配，请重新上传`,
    );
  }

  const chunks: Buffer[] | null = input.includeBytes === false ? null : [];
  const hash = createHash("sha256");
  let total = 0;
  for await (const chunk of stored.createReadStream()) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += bytes.length;
    if (total > input.sizeBytes || total > MAX_RECOVERABLE_LOCAL_ASSET_BYTES) {
      throw new KnowledgeBaseTurnReservationError(
        "CONFLICT",
        `附件“${input.filename}”未通过 Dashboard 本地字节校验`,
      );
    }
    hash.update(bytes);
    chunks?.push(bytes);
  }
  const contentSha256 = hash.digest("hex");
  if (
    total !== input.sizeBytes ||
    contentSha256 !== asset.contentSha256.toLowerCase() ||
    contentSha256 !== stored.sha256?.toLowerCase() ||
    (expectedSha256 && contentSha256 !== expectedSha256)
  ) {
    throw new KnowledgeBaseTurnReservationError(
      "CONFLICT",
      `附件“${input.filename}”未通过 Dashboard 本地字节校验`,
    );
  }
  return {
    localAssetId: asset.id,
    contentSha256,
    ...(chunks ? { bytes: Buffer.concat(chunks, total) } : {}),
  };
}

/**
 * Reconcile Dashboard-owned customer bytes into the existing turn. This
 * function never freezes attachments, acquires a lease or dispatches a
 * Provider task; the existing /turn/dispatch endpoint remains that boundary.
 */
export async function resumeKnowledgeBaseDeferredTurnAttachments(
  input: ResumeInput,
  dependencies: ResumeDependencies = {},
): Promise<KnowledgeBaseDeferredUploadResumeResult> {
  const inspectReservation =
    dependencies.inspectReservation ??
    inspectKnowledgeBaseDeferredAttachmentReservation;
  const requireStageBuild =
    dependencies.requireStageBuild ??
    requireKnowledgeBaseDeferredAttachmentStageBuild;
  const findRetainedAsset =
    dependencies.findRetainedAsset ?? findRetainedKnowledgeBaseLocalAsset;
  const inspectStagePolicy =
    dependencies.inspectStagePolicy ??
    inspectKnowledgeBaseDeferredAttachmentStagePolicy;
  const cancelUnprepared =
    dependencies.cancelUnprepared ?? cancelUnpreparedKnowledgeBaseTurn;
  const stageAttachment =
    dependencies.stageAttachment ?? stageKnowledgeBaseDeferredTurnAttachment;
  const deriveIdentity =
    dependencies.deriveIdentity ?? knowledgeBaseLocalAssetIdentity;

  const snapshot: KnowledgeBaseDeferredAttachmentReservationSnapshot =
    await inspectReservation(input);
  const build = await requireStageBuild({
    userId: input.userId,
    conversationId: input.conversationId,
  });
  const attachmentManifest = frozenRecoveryManifest(
    snapshot.clientAttachmentManifest,
  );
  let finalTurn: KnowledgeBaseTurnRecord = snapshot.turn;
  const initialStagedCount = snapshot.turn.stagedUserAttachmentCount;
  if (
    initialStagedCount < 0 ||
    initialStagedCount > attachmentManifest.length ||
    snapshot.turn.expectedUserAttachmentCount !== attachmentManifest.length
  ) {
    throw new KnowledgeBaseTurnReservationError(
      "CONFLICT",
      "The customer attachment ledger does not match its frozen manifest",
    );
  }

  let retainedCustomerAttachmentCount = initialStagedCount;
  let contiguousPrefixRetained = true;
  const missingCustomerAttachments: KnowledgeBaseMissingCustomerAttachment[] =
    [];
  for (
    let index = initialStagedCount;
    index < attachmentManifest.length;
    index += 1
  ) {
    const item = attachmentManifest[index]!;
    const coordinate: KnowledgeBaseLocalUploadCoordinate = {
      conversationId: input.conversationId,
      turnId: input.turnId,
      clientRequestId: input.clientRequestId,
      itemId: item.itemId,
      expectedResetRevision: input.expectedResetRevision,
      ...(item.sha256 ? { contentSha256: item.sha256 } : {}),
      ordinal: item.ordinal,
    };
    const identity = deriveIdentity({
      userId: input.userId,
      projectAssignmentId: input.projectAssignmentId,
      coordinate,
      sizeBytes: item.sizeBytes,
    });
    const retained = await findRetainedAsset({
      userId: input.userId,
      localAssetId: identity.localAssetId,
      filename: item.filename,
      mimeType: item.mimeType,
      sizeBytes: item.sizeBytes,
      sha256: item.sha256,
      includeBytes: contiguousPrefixRetained,
    });
    if (!retained) {
      missingCustomerAttachments.push(missingDescriptor(item));
      contiguousPrefixRetained = false;
      continue;
    }
    retainedCustomerAttachmentCount += 1;
    // After the first true gap, hash later retained assets for the status
    // response but do not materialize their bodies or stage past the gap.
    if (!contiguousPrefixRetained) continue;
    if (!retained.bytes) {
      throw new KnowledgeBaseTurnReservationError(
        "CONFLICT",
        `附件“${item.filename}”的 Dashboard 本地字节不可读`,
      );
    }
    const stagePolicyRejection = await inspectStagePolicy({
      build,
      turnId: input.turnId,
      attachmentManifest,
      index,
      fileId: retained.localAssetId,
      filename: item.filename,
      mimeType: item.mimeType,
      sizeBytes: item.sizeBytes,
      contentSha256: retained.contentSha256,
    });
    if (stagePolicyRejection) {
      await cancelUnprepared({
        userId: input.userId,
        turnId: input.turnId,
        clientRequestId: input.clientRequestId,
        code: stagePolicyRejection.code,
        message: stagePolicyRejection.message,
      });
      throw new KnowledgeBaseTurnReservationError(
        stagePolicyRejection.code,
        stagePolicyRejection.message,
      );
    }
    finalTurn = await stageAttachment({
      userId: input.userId,
      buildId: snapshot.buildId,
      turnId: input.turnId,
      clientRequestId: input.clientRequestId,
      clientAttachmentManifest: attachmentManifest,
      expectedResetRevision: input.expectedResetRevision,
      index,
      attachment: {
        file_id: retained.localAssetId,
        filename: item.filename,
      },
      managedUploadProof: {
        intentId: `local-asset:${retained.localAssetId}`,
        itemId: item.itemId,
        mimeType: item.mimeType,
        sizeBytes: item.sizeBytes,
        contentSha256: retained.contentSha256,
      },
      managedUploadBytes: retained.bytes,
      projectAssignmentId: input.projectAssignmentId,
    });
  }

  const stagedCustomerAttachmentCount = finalTurn.stagedUserAttachmentCount;
  return {
    stagedCustomerAttachmentCount,
    retainedCustomerAttachmentCount,
    missingCustomerAttachments,
    readyToDispatch:
      stagedCustomerAttachmentCount === attachmentManifest.length,
    attachmentManifest,
  };
}
