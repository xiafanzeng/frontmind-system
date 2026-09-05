import type { ConversationTurn } from "../drizzle/schema";
import { conversationTurns } from "../drizzle/schema";
import type { KnowledgeAsset } from "../shared/dashboard";
import type { KnowledgeBaseApprovedResourceDto } from "../shared/knowledge-base-progress";
import {
  normalizeKnowledgeBaseAttachmentFilename,
  normalizeKnowledgeBaseAttachmentMimeType,
} from "../shared/knowledge-base-attachment";
import { and, asc, eq } from "drizzle-orm";
import sharp from "sharp";
import { createHash } from "node:crypto";
import { getDb } from "./db";
import { KnowledgeBasePackageBindingError } from "./knowledge-base-package-validation";
import type { KnowledgeBaseOfficialLogoProvenance } from "./knowledge-base-progress";
import { readStoredPresalesFile } from "./presales-file-store";
import { knowledgeBasePublicResource } from "./knowledge-base-public-resource";
import {
  KnowledgeBaseUploadEvidenceError,
  persistKnowledgeBaseUploadEvidence,
  readKnowledgeBasePersistedCustomerUploadBytes,
  readReusableKnowledgeBaseUploadEvidenceBytes,
  readKnowledgeBaseUploadEvidence,
} from "./knowledge-base-upload-evidence-store";

const CUSTOMER_IMAGE_MIME_TYPES = new Set([
  "image/avif",
  "image/bmp",
  "image/gif",
  "image/heic",
  "image/heif",
  "image/jpeg",
  "image/png",
  "image/svg+xml",
  "image/tiff",
  "image/vnd.microsoft.icon",
  "image/webp",
  "image/x-icon",
]);
const CUSTOMER_IMAGE_EXTENSION =
  /\.(?:avif|bmp|gif|heic|heif|ico|jpe?g|png|svg|tiff?|webp)$/iu;

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

type KnowledgeBaseCustomerUploadTurn = Pick<
  ConversationTurn,
  "id" | "expectedLeafId" | "attachmentFileIds" | "metadata" | "status"
>;

function knowledgeBaseCustomerUploadHasFinalBinding(
  turn: KnowledgeBaseCustomerUploadTurn,
  input: {
    sourceFileId: string;
    filename: string;
    mimeType: string;
    sizeBytes: number;
    sourceSha256: string;
  },
) {
  if (turn.attachmentFileIds.includes(input.sourceFileId)) return true;
  const metadata = record(turn.metadata) || {};
  const mappings = record(metadata.manusV2AttachmentMappings);
  if (!mappings) return false;
  const matches = Object.values(mappings).filter((candidate) => {
    const mapping = record(candidate);
    const upstreamFileId = String(mapping?.upstreamFileId || "").trim();
    return (
      mapping?.status === "ready" &&
      mapping?.sourceFileId === input.sourceFileId &&
      mapping?.filename === input.filename &&
      Number(mapping?.sizeBytes) === input.sizeBytes &&
      String(mapping?.contentSha256 || "").toLowerCase() ===
        input.sourceSha256 &&
      normalizeKnowledgeBaseAttachmentMimeType(
        input.filename,
        mapping?.mimeType,
      ) === input.mimeType &&
      upstreamFileId.length > 0 &&
      turn.attachmentFileIds.includes(upstreamFileId)
    );
  });
  return matches.length === 1;
}

function knowledgeBaseCustomerUploadEnrichmentErrorCode(error: unknown) {
  const candidate = record(error)?.code;
  if (
    typeof candidate === "string" &&
    /^[A-Z][A-Z0-9_]{0,127}$/u.test(candidate)
  ) {
    return candidate;
  }
  return error instanceof Error &&
    /^[A-Za-z][A-Za-z0-9_]{0,127}$/u.test(error.name)
    ? error.name
    : "UNKNOWN_ERROR";
}

/** Optional UI enrichment must never make an accepted presentation unreadable. */
export function logKnowledgeBaseCustomerUploadEnrichmentSkipped(input: {
  surface: "conversation" | "progress";
  buildId: string;
  turnId: string;
  error: unknown;
}) {
  console.warn(
    "[KnowledgeBaseCustomerUpload] enrichment_skipped",
    JSON.stringify({
      surface: input.surface,
      buildId: input.buildId,
      turnId: input.turnId,
      errorCode: knowledgeBaseCustomerUploadEnrichmentErrorCode(input.error),
    }),
  );
}

export type KnowledgeBaseCustomerUploadImage = {
  turnId: string;
  leafId: string;
  index: number;
  fileId: string;
  filename: string;
  mimeType: string;
  sizeBytes: number;
  sourceSha256: string;
};

export type KnowledgeBaseOfficialLogoUpload = {
  turnId: string;
  leafId: string;
  index: number;
  fileId: string;
  filename: string;
  mimeType: string;
  sizeBytes: number;
  sourceSha256: string;
};

export function knowledgeBaseOfficialLogoProvenanceFromMetadata(
  metadata: unknown,
): KnowledgeBaseOfficialLogoProvenance | null {
  const value = record(record(metadata)?.boundOfficialLogoProvenance);
  if (!value) return null;
  if (
    value.sourceKind === "official_web" &&
    typeof value.sourcePageUrl === "string" &&
    value.sourcePageUrl.length > 0 &&
    typeof value.sourceAssetUrl === "string" &&
    value.sourceAssetUrl.length > 0
  ) {
    return {
      sourceKind: "official_web",
      sourcePageUrl: value.sourcePageUrl,
      sourceAssetUrl: value.sourceAssetUrl,
    };
  }
  if (
    value.sourceKind === "official_document" &&
    typeof value.sourceDocumentPath === "string" &&
    value.sourceDocumentPath.length > 0
  ) {
    return {
      sourceKind: "official_document",
      sourceDocumentPath: value.sourceDocumentPath,
    };
  }
  return null;
}

export function knowledgeBaseOfficialLogoUploadFromTurn(
  turn: Pick<
    ConversationTurn,
    "id" | "expectedLeafId" | "attachmentFileIds" | "metadata" | "status"
  > &
    Partial<
      Pick<
        ConversationTurn,
        "operationType" | "buildId" | "buildGeneration" | "expectedRevision"
      >
    >,
): KnowledgeBaseOfficialLogoUpload | null {
  if (turn.status !== "completed") return null;
  const metadata = record(turn.metadata) || {};
  const localLogo = record(metadata.localLogo);
  const localUpload = record(localLogo?.officialLogoUpload);
  if (turn.operationType === "local_logo" || localLogo !== null) {
    const index = Number(localUpload?.index);
    const fileId = String(localUpload?.fileId || "").trim();
    const filename = normalizeKnowledgeBaseAttachmentFilename(
      localUpload?.filename,
      "official-logo",
    );
    const mimeType = normalizeKnowledgeBaseAttachmentMimeType(
      filename,
      localUpload?.mimeType,
    );
    const sizeBytes = Number(localUpload?.sizeBytes);
    const sourceSha256 = String(localUpload?.sourceSha256 || "")
      .trim()
      .toLowerCase();
    const leafId = String(turn.expectedLeafId || "").trim();
    if (
      turn.operationType !== "local_logo" ||
      localLogo?.kind !== "frontmind.knowledge-base.local-logo" ||
      localLogo?.schemaVersion !== 1 ||
      localLogo?.immutable !== true ||
      localLogo?.buildId !== turn.buildId ||
      localLogo?.leafId !== leafId ||
      localLogo?.generation !== turn.buildGeneration ||
      localLogo?.revision !== turn.expectedRevision ||
      localUpload?.verified !== true ||
      index !== 0 ||
      !fileId ||
      !leafId ||
      !mimeType.startsWith("image/") ||
      !Number.isSafeInteger(sizeBytes) ||
      sizeBytes < 1 ||
      !/^[a-f0-9]{64}$/u.test(sourceSha256) ||
      !Array.isArray(turn.attachmentFileIds) ||
      turn.attachmentFileIds.length !== 1 ||
      turn.attachmentFileIds[0] !== fileId
    ) {
      return null;
    }
    return {
      turnId: turn.id,
      leafId,
      index,
      fileId,
      filename,
      mimeType,
      sizeBytes,
      sourceSha256,
    };
  }
  const repair = record(metadata.logoProvenanceRepair);
  const repairUpload = record(repair?.officialLogoUpload);
  if (turn.operationType === "logo_provenance_repair" || repair !== null) {
    const index = Number(repairUpload?.index);
    const fileId = String(repairUpload?.fileId || "").trim();
    const filename = normalizeKnowledgeBaseAttachmentFilename(
      repairUpload?.filename,
      "official-logo",
    );
    const mimeType = normalizeKnowledgeBaseAttachmentMimeType(
      filename,
      repairUpload?.mimeType,
    );
    const sizeBytes = Number(repairUpload?.sizeBytes);
    const sourceSha256 = String(repairUpload?.sourceSha256 || "")
      .trim()
      .toLowerCase();
    const leafId = String(turn.expectedLeafId || "").trim();
    if (
      turn.operationType !== "logo_provenance_repair" ||
      repair?.kind !== "frontmind.knowledge-base.logo-provenance-repair" ||
      repair?.schemaVersion !== 1 ||
      repair?.immutable !== true ||
      repair?.buildId !== turn.buildId ||
      repair?.leafId !== leafId ||
      repair?.generation !== turn.buildGeneration ||
      repair?.revision !== turn.expectedRevision ||
      repairUpload?.verified !== true ||
      index !== 0 ||
      !fileId ||
      !leafId ||
      !mimeType.startsWith("image/") ||
      !Number.isSafeInteger(sizeBytes) ||
      sizeBytes < 1 ||
      !/^[a-f0-9]{64}$/u.test(sourceSha256) ||
      !Array.isArray(turn.attachmentFileIds) ||
      turn.attachmentFileIds.length !== 1 ||
      turn.attachmentFileIds[0] !== fileId
    ) {
      return null;
    }
    return {
      turnId: turn.id,
      leafId,
      index,
      fileId,
      filename,
      mimeType,
      sizeBytes,
      sourceSha256,
    };
  }
  const recovery = record(metadata.recovery);
  const upload = record(recovery?.officialLogoUpload);
  const manifest = Array.isArray(recovery?.attachmentManifest)
    ? recovery!.attachmentManifest
    : [];
  const attachments = Array.isArray(recovery?.attachments)
    ? recovery!.attachments
    : [];
  const prepared = record(metadata.preparedDispatch);
  const requestBody = record(prepared?.requestBody);
  const dispatchedAttachments = Array.isArray(requestBody?.attachments)
    ? requestBody!.attachments
    : [];
  const index = Number(upload?.index);
  const fileId = String(upload?.fileId || "").trim();
  const filename = normalizeKnowledgeBaseAttachmentFilename(
    upload?.filename,
    "official-logo",
  );
  const mimeType = normalizeKnowledgeBaseAttachmentMimeType(
    filename,
    upload?.mimeType,
  );
  const sizeBytes = Number(upload?.sizeBytes);
  const sourceSha256 = String(upload?.sourceSha256 || "")
    .trim()
    .toLowerCase();
  const leafId = String(turn.expectedLeafId || "").trim();
  const manifestItem = record(manifest[index]);
  const attachment = record(attachments[index]);
  const manifestFilename = normalizeKnowledgeBaseAttachmentFilename(
    manifestItem?.filename,
    "official-logo",
  );
  const manifestMimeType = normalizeKnowledgeBaseAttachmentMimeType(
    manifestFilename,
    manifestItem?.mimeType,
  );
  if (
    upload?.verified !== true ||
    index !== 0 ||
    !fileId ||
    !leafId ||
    !mimeType.startsWith("image/") ||
    !Number.isSafeInteger(sizeBytes) ||
    sizeBytes < 1 ||
    !/^[a-f0-9]{64}$/u.test(sourceSha256) ||
    metadata.attachmentsFrozen !== true ||
    recovery?.capturedClientAttachments !== true ||
    Number(metadata.userAttachmentCount) !== 1 ||
    manifest.length !== 1 ||
    attachments.length !== 1 ||
    manifestFilename !== filename ||
    manifestMimeType !== mimeType ||
    Number(manifestItem?.sizeBytes) !== sizeBytes ||
    String(manifestItem?.sha256 || "")
      .trim()
      .toLowerCase() !== sourceSha256 ||
    String(attachment?.file_id || "").trim() !== fileId ||
    String(attachment?.filename || "") !== filename ||
    !Array.isArray(turn.attachmentFileIds) ||
    !turn.attachmentFileIds.includes(fileId) ||
    !dispatchedAttachments.some((candidate) => {
      const dispatched = record(candidate);
      return (
        dispatched?.file_id === fileId && dispatched?.filename === filename
      );
    })
  ) {
    return null;
  }
  return {
    turnId: turn.id,
    leafId,
    index,
    fileId,
    filename,
    mimeType,
    sizeBytes,
    sourceSha256,
  };
}

/**
 * Parse only the browser-upload ledger frozen into a knowledge-base turn.
 * Provider output images and node.imageUrls are deliberately outside this
 * function, so a crawled URL can never become a customer-visible resource.
 */
export function knowledgeBaseCustomerUploadImagesFromTurn(
  turn: KnowledgeBaseCustomerUploadTurn,
): KnowledgeBaseCustomerUploadImage[] {
  const metadata = record(turn.metadata) || {};
  const recovery = record(metadata.recovery);
  const manifest = Array.isArray(recovery?.attachmentManifest)
    ? recovery!.attachmentManifest
    : [];
  const attachments = Array.isArray(recovery?.attachments)
    ? recovery!.attachments
    : [];
  const prepared = record(metadata.preparedDispatch);
  const requestBody = record(prepared?.requestBody);
  const dispatchedAttachments = Array.isArray(requestBody?.attachments)
    ? requestBody!.attachments
    : [];
  const expectedCount = Number(metadata.userAttachmentCount ?? 0);
  const leafId = String(turn.expectedLeafId || "").trim();
  if (
    turn.status !== "completed" ||
    recovery?.capturedClientAttachments !== true ||
    metadata.attachmentsFrozen !== true ||
    !leafId ||
    !Number.isSafeInteger(expectedCount) ||
    expectedCount < 1 ||
    manifest.length !== expectedCount ||
    attachments.length !== expectedCount ||
    !Array.isArray(turn.attachmentFileIds)
  ) {
    return [];
  }

  const images: KnowledgeBaseCustomerUploadImage[] = [];
  const seenHashes = new Set<string>();
  const officialLogoUpload = knowledgeBaseOfficialLogoUploadFromTurn(turn);
  for (let index = 0; index < expectedCount; index += 1) {
    const source = record(manifest[index]);
    const attachment = record(attachments[index]);
    const fileId = String(attachment?.file_id || "").trim();
    const filename = normalizeKnowledgeBaseAttachmentFilename(
      source?.filename,
      "customer-upload",
    );
    const mimeType = normalizeKnowledgeBaseAttachmentMimeType(
      filename,
      source?.mimeType,
    );
    const sizeBytes = Number(source?.sizeBytes);
    const sourceSha256 = String(source?.sha256 || "")
      .trim()
      .toLowerCase();
    if (
      officialLogoUpload &&
      officialLogoUpload.index === index &&
      officialLogoUpload.fileId === fileId &&
      officialLogoUpload.filename === filename &&
      officialLogoUpload.mimeType === mimeType &&
      officialLogoUpload.sizeBytes === sizeBytes &&
      officialLogoUpload.sourceSha256 === sourceSha256
    ) {
      continue;
    }
    if (
      !fileId ||
      String(attachment?.filename || "") !== filename ||
      !knowledgeBaseCustomerUploadHasFinalBinding(turn, {
        sourceFileId: fileId,
        filename,
        mimeType,
        sizeBytes,
        sourceSha256,
      }) ||
      !dispatchedAttachments.some((candidate) => {
        const dispatched = record(candidate);
        return (
          dispatched?.file_id === fileId && dispatched?.filename === filename
        );
      }) ||
      !Number.isSafeInteger(sizeBytes) ||
      sizeBytes < 1 ||
      !/^[a-f0-9]{64}$/u.test(sourceSha256) ||
      (!CUSTOMER_IMAGE_MIME_TYPES.has(mimeType) &&
        !CUSTOMER_IMAGE_EXTENSION.test(filename)) ||
      seenHashes.has(sourceSha256)
    ) {
      continue;
    }
    seenHashes.add(sourceSha256);
    images.push({
      turnId: turn.id,
      leafId,
      index,
      fileId,
      filename,
      mimeType: mimeType || "application/octet-stream",
      sizeBytes,
      sourceSha256,
    });
  }
  return images;
}

/**
 * A v4 completed node turn may ignore ordinary documents, but it may never
 * reinterpret a damaged browser-upload ledger as "no customer images". The
 * reservation path created every field below atomically before dispatch, so a
 * missing or contradictory field is an integrity failure, not compatibility.
 */
function assertKnowledgeBaseCustomerUploadLedgerComplete(
  turn: Parameters<typeof knowledgeBaseCustomerUploadImagesFromTurn>[0],
) {
  if (
    turn.status !== "completed" ||
    !String(turn.expectedLeafId || "").trim()
  ) {
    return;
  }
  const metadata = record(turn.metadata) || {};
  const recovery = record(metadata.recovery);
  const manifest = Array.isArray(recovery?.attachmentManifest)
    ? recovery!.attachmentManifest
    : null;
  const attachments = Array.isArray(recovery?.attachments)
    ? recovery!.attachments
    : null;
  const prepared = record(metadata.preparedDispatch);
  const requestBody = record(prepared?.requestBody);
  const dispatchedAttachments = Array.isArray(requestBody?.attachments)
    ? requestBody!.attachments
    : null;
  const expectedCount = Number(metadata.userAttachmentCount ?? 0);
  const ledgerClaimed =
    recovery?.capturedClientAttachments === true ||
    (manifest?.length || 0) > 0 ||
    (attachments?.length || 0) > 0 ||
    (Number.isFinite(expectedCount) && expectedCount > 0);
  if (!ledgerClaimed) return;
  if (
    recovery?.capturedClientAttachments !== true ||
    metadata.attachmentsFrozen !== true ||
    !Number.isSafeInteger(expectedCount) ||
    expectedCount < 1 ||
    manifest?.length !== expectedCount ||
    attachments?.length !== expectedCount ||
    !Array.isArray(turn.attachmentFileIds) ||
    !dispatchedAttachments
  ) {
    throw new KnowledgeBasePackageBindingError(
      "客户上传附件账本缺失或不完整，不能验证最终 ZIP",
    );
  }

  for (let index = 0; index < expectedCount; index += 1) {
    const source = record(manifest[index]);
    const attachment = record(attachments[index]);
    if (!source || !attachment) {
      throw new KnowledgeBasePackageBindingError(
        "客户上传附件账本包含无效条目，不能验证最终 ZIP",
      );
    }
    const fileId = String(attachment.file_id || "").trim();
    const filename = normalizeKnowledgeBaseAttachmentFilename(
      source.filename,
      "customer-upload",
    );
    const mimeType = normalizeKnowledgeBaseAttachmentMimeType(
      filename,
      source.mimeType,
    );
    const sizeBytes = Number(source.sizeBytes);
    const sourceSha256 = String(source.sha256 || "")
      .trim()
      .toLowerCase();
    const dispatched = dispatchedAttachments.some((candidate) => {
      const value = record(candidate);
      return value?.file_id === fileId && value?.filename === filename;
    });
    if (
      !fileId ||
      String(attachment.filename || "") !== filename ||
      !knowledgeBaseCustomerUploadHasFinalBinding(turn, {
        sourceFileId: fileId,
        filename,
        mimeType,
        sizeBytes,
        sourceSha256,
      }) ||
      !dispatched ||
      !Number.isSafeInteger(sizeBytes) ||
      sizeBytes < 1 ||
      !/^[a-f0-9]{64}$/u.test(sourceSha256)
    ) {
      throw new KnowledgeBasePackageBindingError(
        `客户上传附件账本绑定不完整：${filename}`,
      );
    }
    const declaresImage =
      String(source.mimeType || "")
        .trim()
        .toLowerCase()
        .startsWith("image/") || CUSTOMER_IMAGE_EXTENSION.test(filename);
    if (
      declaresImage &&
      !CUSTOMER_IMAGE_MIME_TYPES.has(mimeType) &&
      !CUSTOMER_IMAGE_EXTENSION.test(filename)
    ) {
      throw new KnowledgeBasePackageBindingError(
        `客户上传图片格式无法验证：${filename}`,
      );
    }
  }
}

/** Prove that the same bytes captured during the one upload still exist. */
export async function verifiedKnowledgeBaseCustomerUploadImagesFromTurn(
  turn: Parameters<typeof knowledgeBaseCustomerUploadImagesFromTurn>[0],
) {
  assertKnowledgeBaseCustomerUploadLedgerComplete(turn);
  const candidates = knowledgeBaseCustomerUploadImagesFromTurn(turn);
  const verified = await Promise.all(
    candidates.map(async (candidate) => {
      const stored = await readStoredPresalesFile(candidate.fileId);
      return stored &&
        stored.filename === candidate.filename &&
        stored.sizeBytes === candidate.sizeBytes &&
        stored.sha256?.toLowerCase() === candidate.sourceSha256
        ? candidate
        : null;
    }),
  );
  const complete = verified.filter(
    (candidate): candidate is KnowledgeBaseCustomerUploadImage =>
      candidate !== null,
  );
  if (complete.length !== candidates.length) {
    throw new KnowledgeBasePackageBindingError(
      "客户上传图片的受管原始字节缺失或完整性不一致",
    );
  }
  return complete;
}

/** Parse the frozen, authenticated turn ledger without touching expiring bytes. */
export function declaredKnowledgeBaseCustomerUploadImagesFromTurn(
  turn: Parameters<typeof knowledgeBaseCustomerUploadImagesFromTurn>[0],
) {
  assertKnowledgeBaseCustomerUploadLedgerComplete(turn);
  return knowledgeBaseCustomerUploadImagesFromTurn(turn);
}

export function knowledgeBaseCustomerUploadResource(
  buildId: string,
  image: KnowledgeBaseCustomerUploadImage,
): KnowledgeBaseApprovedResourceDto {
  return knowledgeBasePublicResource({
    buildId,
    kind: "customer_upload",
    internalIdentity: knowledgeBaseCustomerUploadInternalIdentity(image),
    contentSha256: image.sourceSha256,
    mimeType: image.mimeType,
    sizeBytes: image.sizeBytes,
  });
}

export function knowledgeBaseCustomerUploadInternalIdentity(
  image: Pick<
    KnowledgeBaseCustomerUploadImage,
    "turnId" | "index" | "sourceSha256"
  >,
) {
  return `${image.turnId}\0${image.index}\0${image.sourceSha256}`;
}

export async function knowledgeBaseCustomerUploadResources(
  buildId: string,
  turn: Parameters<typeof knowledgeBaseCustomerUploadImagesFromTurn>[0],
  options: {
    persistedEvidence?: {
      userId: number;
      generation: number;
      packageArchiveSha256: string;
    };
  } = {},
) {
  const images = options.persistedEvidence
    ? declaredKnowledgeBaseCustomerUploadImagesFromTurn(turn)
    : await verifiedKnowledgeBaseCustomerUploadImagesFromTurn(turn);
  if (options.persistedEvidence) {
    await Promise.all(
      images.map((image) =>
        persistedKnowledgeBaseCustomerUploadBytesForBuild({
          userId: options.persistedEvidence!.userId,
          buildId,
          generation: options.persistedEvidence!.generation,
          packageArchiveSha256: options.persistedEvidence!.packageArchiveSha256,
          sourceSha256: image.sourceSha256,
        }),
      ),
    );
  }
  return images.map((image) =>
    knowledgeBaseCustomerUploadResource(buildId, image),
  );
}

export type KnowledgeBaseExpectedCustomerUpload = {
  sourceSha256: string;
  leafIds: string[];
  filenames: string[];
  mimeTypes: string[];
  fileIds: string[];
  sizeBytes: number[];
};

export const MAX_KNOWLEDGE_BASE_CUSTOMER_UPLOAD_IMAGES = 99;
export const MAX_KNOWLEDGE_BASE_CUSTOMER_UPLOAD_BYTES = 80 * 1024 * 1024;

function groupKnowledgeBaseCustomerUploads(
  images: readonly KnowledgeBaseCustomerUploadImage[],
  options: { excludedSourceSha256?: string | null } = {},
): KnowledgeBaseExpectedCustomerUpload[] {
  const excludedSourceSha256 = String(options.excludedSourceSha256 || "")
    .trim()
    .toLowerCase();
  const grouped = new Map<
    string,
    {
      leafIds: Set<string>;
      filenames: Set<string>;
      mimeTypes: Set<string>;
      fileIds: Set<string>;
      sizeBytes: Set<number>;
      firstFilename: string;
      firstMimeType: string;
      firstFileId: string;
      firstSizeBytes: number;
    }
  >();
  for (const image of images) {
    if (excludedSourceSha256 && image.sourceSha256 === excludedSourceSha256) {
      continue;
    }
    const current = grouped.get(image.sourceSha256) || {
      leafIds: new Set<string>(),
      filenames: new Set<string>(),
      mimeTypes: new Set<string>(),
      fileIds: new Set<string>(),
      sizeBytes: new Set<number>(),
      firstFilename: image.filename,
      firstMimeType: image.mimeType,
      firstFileId: image.fileId,
      firstSizeBytes: image.sizeBytes,
    };
    current.leafIds.add(image.leafId);
    current.filenames.add(image.filename);
    current.mimeTypes.add(image.mimeType);
    current.fileIds.add(image.fileId);
    current.sizeBytes.add(image.sizeBytes);
    grouped.set(image.sourceSha256, current);
  }
  return [...grouped.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([sourceSha256, value]) => ({
      sourceSha256,
      leafIds: [...value.leafIds].sort(),
      filenames: [value.firstFilename],
      mimeTypes: [value.firstMimeType],
      fileIds: [
        value.firstFileId,
        ...[...value.fileIds]
          .filter((fileId) => fileId !== value.firstFileId)
          .sort(),
      ],
      sizeBytes: [value.firstSizeBytes],
    }));
}

export function knowledgeBaseExpectedCustomerUploadsFromTurns(
  turns: readonly Parameters<
    typeof knowledgeBaseCustomerUploadImagesFromTurn
  >[0][],
  options: { excludedSourceSha256?: string | null } = {},
) {
  turns.forEach(assertKnowledgeBaseCustomerUploadLedgerComplete);
  return groupKnowledgeBaseCustomerUploads(
    turns.flatMap(knowledgeBaseCustomerUploadImagesFromTurn),
    options,
  );
}

/**
 * Produce the immutable final-package allowlist. One original byte hash is one
 * physical asset, while repeated uploads may bind that asset to multiple
 * customer-confirmed leaves.
 */
export async function verifiedKnowledgeBaseCustomerUploadsFromTurns(
  turns: readonly Parameters<
    typeof knowledgeBaseCustomerUploadImagesFromTurn
  >[0][],
  options: { excludedSourceSha256?: string | null } = {},
): Promise<KnowledgeBaseExpectedCustomerUpload[]> {
  const verified = (
    await Promise.all(
      turns.map((turn) =>
        verifiedKnowledgeBaseCustomerUploadImagesFromTurn(turn),
      ),
    )
  ).flat();
  return groupKnowledgeBaseCustomerUploads(verified, options);
}

export async function verifiedKnowledgeBaseCustomerUploadsForBuild(input: {
  userId: number;
  buildId: string;
  generation: number;
  officialLogoSha256?: string | null;
}) {
  const db = await getDb();
  if (!db) throw new Error("数据库暂不可用，无法核验客户上传图片");
  const turns = await db
    .select({
      id: conversationTurns.id,
      expectedLeafId: conversationTurns.expectedLeafId,
      attachmentFileIds: conversationTurns.attachmentFileIds,
      metadata: conversationTurns.metadata,
      status: conversationTurns.status,
      operationType: conversationTurns.operationType,
      buildId: conversationTurns.buildId,
      buildGeneration: conversationTurns.buildGeneration,
      expectedRevision: conversationTurns.expectedRevision,
    })
    .from(conversationTurns)
    .where(
      and(
        eq(conversationTurns.userId, input.userId),
        eq(conversationTurns.buildId, input.buildId),
        eq(conversationTurns.buildGeneration, input.generation),
        eq(conversationTurns.status, "completed"),
      ),
    )
    .orderBy(asc(conversationTurns.createdAt), asc(conversationTurns.id));
  return verifiedKnowledgeBaseCustomerUploadsFromTurns(turns, {
    excludedSourceSha256: input.officialLogoSha256,
  });
}

/**
 * Return the exact managed bytes needed by the provider's finalization turn.
 * Package validation still re-reads the customer ZIP independently; this
 * handoff only makes it possible for the provider to include bytes which were
 * uploaded on earlier turns and may no longer exist in its implicit workspace.
 */
export async function verifiedKnowledgeBaseCustomerUploadBytesForBuild(input: {
  userId: number;
  buildId: string;
  generation: number;
  officialLogoSha256?: string | null;
}) {
  const uploads = await verifiedKnowledgeBaseCustomerUploadsForBuild(input);
  const results = [];
  let aggregateBytes = 0;
  for (const upload of uploads) {
    const fileId = upload.fileIds[0];
    if (!fileId) {
      throw new KnowledgeBasePackageBindingError(
        "客户上传图片缺少受管文件标识",
      );
    }
    const stored = await readStoredPresalesFile(fileId);
    if (
      !stored ||
      stored.sha256?.toLowerCase() !== upload.sourceSha256 ||
      !upload.filenames.includes(stored.filename)
    ) {
      throw new KnowledgeBasePackageBindingError(
        "客户上传图片的受管原始字节缺失或完整性不一致",
      );
    }
    const bytes = await readStoredCustomerUploadBytes(stored);
    if (
      createHash("sha256").update(bytes).digest("hex") !== upload.sourceSha256
    ) {
      throw new KnowledgeBasePackageBindingError(
        "客户上传图片的原始哈希不一致",
      );
    }
    aggregateBytes += bytes.length;
    if (aggregateBytes > MAX_KNOWLEDGE_BASE_CUSTOMER_UPLOAD_BYTES) {
      throw new KnowledgeBasePackageBindingError(
        "客户上传图片原始字节合计超过最终交付输入上限，请先压缩过大的图片",
      );
    }
    results.push({
      ...upload,
      fileId,
      filename: stored.filename,
      mimeType:
        (stored.mimeType.startsWith("image/") ? stored.mimeType : "") ||
        upload.mimeTypes.find((candidate) => candidate.startsWith("image/")) ||
        "application/octet-stream",
      sizeBytes: bytes.length,
      bytes,
    });
  }
  return results;
}

export async function verifiedKnowledgeBaseOfficialLogoUploadForBuild(input: {
  userId: number;
  buildId: string;
  generation: number;
  expectedLogoSha256?: string | null;
}) {
  const db = await getDb();
  if (!db) throw new Error("数据库暂不可用，无法核验客户上传 Logo");
  const turns = await db
    .select({
      id: conversationTurns.id,
      expectedLeafId: conversationTurns.expectedLeafId,
      attachmentFileIds: conversationTurns.attachmentFileIds,
      metadata: conversationTurns.metadata,
      status: conversationTurns.status,
      operationType: conversationTurns.operationType,
      buildId: conversationTurns.buildId,
      buildGeneration: conversationTurns.buildGeneration,
      expectedRevision: conversationTurns.expectedRevision,
    })
    .from(conversationTurns)
    .where(
      and(
        eq(conversationTurns.userId, input.userId),
        eq(conversationTurns.buildId, input.buildId),
        eq(conversationTurns.buildGeneration, input.generation),
        eq(conversationTurns.status, "completed"),
      ),
    )
    .orderBy(asc(conversationTurns.createdAt), asc(conversationTurns.id));
  const declared = turns
    .map(knowledgeBaseOfficialLogoUploadFromTurn)
    .filter(
      (upload): upload is KnowledgeBaseOfficialLogoUpload => upload !== null,
    );
  const declaredRows = turns.filter((turn) => {
    const metadata = record(turn.metadata);
    const recovery = record(metadata?.recovery);
    return Boolean(
      (recovery &&
        Object.prototype.hasOwnProperty.call(recovery, "officialLogoUpload")) ||
        (metadata &&
          Object.prototype.hasOwnProperty.call(
            metadata,
            "logoProvenanceRepair",
          )),
    );
  });
  if (declaredRows.length !== declared.length) {
    throw new KnowledgeBasePackageBindingError(
      "企业官方主 Logo 上传账本无效，不能验证最终 ZIP",
    );
  }
  if (declared.length === 0) return undefined;
  const expectedLogoSha256 = String(input.expectedLogoSha256 || "")
    .trim()
    .toLowerCase();
  if (!expectedLogoSha256 && declared.length !== 1) {
    throw new KnowledgeBasePackageBindingError(
      "企业官方主 Logo 上传账本不唯一且缺少当前 Logo 哈希，不能验证最终 ZIP",
    );
  }
  const upload = expectedLogoSha256
    ? [...declared]
        .reverse()
        .find((candidate) => candidate.sourceSha256 === expectedLogoSha256)
    : declared[0];
  if (!upload) {
    throw new KnowledgeBasePackageBindingError(
      "当前企业官方主 Logo 与已完成的上传账本不匹配，不能验证最终 ZIP",
    );
  }
  // Binding copied and hashed the exact upload into the build's immutable
  // Logo artifact in the same transaction that wrote this verified marker.
  // The short-lived presales capture may expire after 30 days; final-package
  // validation therefore binds against the durable build hash and packaged
  // bytes instead of making that temporary copy a permanent dependency.
  return upload;
}

/**
 * Load the immutable web/document provenance captured on the successful first
 * turn. Exactly one completed turn may own this marker. The customer-upload
 * recovery path deliberately has no marker here; its independent verified
 * upload ledger is the authority instead.
 */
export async function persistedKnowledgeBaseOfficialLogoProvenanceForBuild(input: {
  userId: number;
  buildId: string;
  generation: number;
}) {
  const db = await getDb();
  if (!db) throw new Error("数据库暂不可用，无法核验官方主 Logo 来源");
  const rows = await db
    .select({ metadata: conversationTurns.metadata })
    .from(conversationTurns)
    .where(
      and(
        eq(conversationTurns.userId, input.userId),
        eq(conversationTurns.buildId, input.buildId),
        eq(conversationTurns.buildGeneration, input.generation),
        eq(conversationTurns.status, "completed"),
      ),
    )
    .orderBy(asc(conversationTurns.createdAt), asc(conversationTurns.id));
  const declaredRows = rows.filter((row) => {
    const metadata = record(row.metadata);
    return Boolean(
      metadata &&
        Object.prototype.hasOwnProperty.call(
          metadata,
          "boundOfficialLogoProvenance",
        ),
    );
  });
  const provenances = rows
    .map((row) => knowledgeBaseOfficialLogoProvenanceFromMetadata(row.metadata))
    .filter(
      (value): value is KnowledgeBaseOfficialLogoProvenance => value !== null,
    );
  if (declaredRows.length !== provenances.length) {
    throw new KnowledgeBasePackageBindingError(
      "企业官方主 Logo 来源账本无效，不能验证最终 ZIP",
    );
  }
  if (provenances.length === 0) return undefined;
  if (provenances.length !== 1) {
    throw new KnowledgeBasePackageBindingError(
      "企业官方主 Logo 来源账本不唯一，不能验证最终 ZIP",
    );
  }
  return provenances[0]!;
}

/**
 * One shared evidence load for reconcile, publish and immutable download. This
 * prevents any path from accidentally counting an uploaded Logo as an ordinary
 * customer image or validating only its bytes while dropping its provenance.
 */
export async function verifiedKnowledgeBasePackageUploadEvidenceForBuild(input: {
  userId: number;
  buildId: string;
  generation: number;
  officialLogoSha256?: string | null;
  packageArchiveSha256?: string | null;
}) {
  const packageArchiveSha256 = String(input.packageArchiveSha256 || "")
    .trim()
    .toLowerCase();
  if (packageArchiveSha256) {
    try {
      const persisted = await readKnowledgeBaseUploadEvidence({
        userId: input.userId,
        buildId: input.buildId,
        generation: input.generation,
        packageArchiveSha256,
      });
      return {
        expectedCustomerUploads: persisted.expectedCustomerUploads,
        expectedOfficialLogoUpload: persisted.expectedOfficialLogoUpload,
        expectedOfficialLogoProvenance: undefined,
      };
    } catch (error) {
      if (
        !(error instanceof KnowledgeBaseUploadEvidenceError) ||
        error.code !== "NOT_FOUND"
      ) {
        throw new KnowledgeBasePackageBindingError(
          error instanceof Error
            ? error.message
            : "知识库客户上传永久证据读取失败",
        );
      }
      // Historical v4 builds may predate the durable evidence store. They are
      // allowed one fail-closed backfill while the captured source still
      // exists. Once written, all later reads use only build-owned evidence.
    }
  }
  const expectedOfficialLogoUpload =
    await verifiedKnowledgeBaseOfficialLogoUploadForBuild({
      userId: input.userId,
      buildId: input.buildId,
      generation: input.generation,
      expectedLogoSha256: input.officialLogoSha256,
    });
  const expectedOfficialLogoProvenance = undefined;
  const expectedCustomerUploads = packageArchiveSha256
    ? await declaredKnowledgeBaseCustomerUploadsForBuild(input)
    : await verifiedKnowledgeBaseCustomerUploadsForBuild(input);
  if (packageArchiveSha256) {
    let customerUploadBytes: ReadonlyMap<string, Buffer>;
    try {
      customerUploadBytes = await readReusableKnowledgeBaseUploadEvidenceBytes({
        userId: input.userId,
        buildId: input.buildId,
        generation: input.generation,
        packageArchiveSha256,
        expectedCustomerUploads,
        expectedOfficialLogoUpload,
        expectedOfficialLogoProvenance,
      });
    } catch (error) {
      if (
        !(error instanceof KnowledgeBaseUploadEvidenceError) ||
        error.code !== "NOT_FOUND"
      ) {
        throw new KnowledgeBasePackageBindingError(
          error instanceof Error
            ? error.message
            : "知识库客户上传永久证据复用失败",
        );
      }
      // No committed matching package ledger exists yet. The first binding
      // must still prove every byte against the short-lived upload capture.
      const verifiedBytes =
        await verifiedKnowledgeBaseCustomerUploadBytesForBuild(input);
      const verifiedUploads = verifiedBytes.map((upload) => ({
        sourceSha256: upload.sourceSha256,
        leafIds: upload.leafIds,
        filenames: upload.filenames,
        mimeTypes: upload.mimeTypes,
        fileIds: upload.fileIds,
        sizeBytes: [upload.sizeBytes],
      }));
      if (
        JSON.stringify(verifiedUploads) !==
        JSON.stringify(expectedCustomerUploads)
      ) {
        throw new KnowledgeBasePackageBindingError(
          "客户上传图片的受管原始字节与当前权威账本不一致",
        );
      }
      customerUploadBytes = new Map(
        verifiedBytes.map(
          (upload) => [upload.sourceSha256, upload.bytes] as const,
        ),
      );
    }
    try {
      await persistKnowledgeBaseUploadEvidence({
        userId: input.userId,
        buildId: input.buildId,
        generation: input.generation,
        packageArchiveSha256,
        expectedCustomerUploads,
        expectedOfficialLogoUpload,
        expectedOfficialLogoProvenance,
        customerUploadBytes,
      });
    } catch (error) {
      throw new KnowledgeBasePackageBindingError(
        error instanceof Error
          ? error.message
          : "知识库客户上传证据永久封存失败",
      );
    }
  }
  return {
    expectedCustomerUploads,
    expectedOfficialLogoUpload,
    expectedOfficialLogoProvenance,
  };
}

/** Read customer-visible bytes from the immutable build evidence, never TTL storage. */
export async function persistedKnowledgeBaseCustomerUploadBytesForBuild(input: {
  userId: number;
  buildId: string;
  generation: number;
  packageArchiveSha256: string;
  sourceSha256: string;
}) {
  try {
    return await readKnowledgeBasePersistedCustomerUploadBytes(input);
  } catch (error) {
    throw new KnowledgeBasePackageBindingError(
      error instanceof Error ? error.message : "客户上传图片的永久证据读取失败",
    );
  }
}

export async function declaredKnowledgeBaseCustomerUploadsForBuild(input: {
  userId: number;
  buildId: string;
  generation: number;
  officialLogoSha256?: string | null;
}) {
  const db = await getDb();
  if (!db) throw new Error("数据库暂不可用，无法读取客户上传图片账本");
  const turns = await db
    .select({
      id: conversationTurns.id,
      expectedLeafId: conversationTurns.expectedLeafId,
      attachmentFileIds: conversationTurns.attachmentFileIds,
      metadata: conversationTurns.metadata,
      status: conversationTurns.status,
    })
    .from(conversationTurns)
    .where(
      and(
        eq(conversationTurns.userId, input.userId),
        eq(conversationTurns.buildId, input.buildId),
        eq(conversationTurns.buildGeneration, input.generation),
        eq(conversationTurns.status, "completed"),
      ),
    )
    .orderBy(asc(conversationTurns.createdAt), asc(conversationTurns.id));
  return knowledgeBaseExpectedCustomerUploadsFromTurns(turns, {
    excludedSourceSha256: input.officialLogoSha256,
  });
}

const CUSTOMER_UPLOAD_VISUAL_MAX_BYTES = 100 * 1024 * 1024;
const CUSTOMER_UPLOAD_SVG_MAX_BYTES = 10 * 1024 * 1024;

async function readStoredCustomerUploadBytes(
  stored: NonNullable<Awaited<ReturnType<typeof readStoredPresalesFile>>>,
) {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of stored.createReadStream()) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += bytes.length;
    if (size > CUSTOMER_UPLOAD_VISUAL_MAX_BYTES) {
      throw new KnowledgeBasePackageBindingError(
        "客户上传图片超过最终 ZIP 核验上限",
      );
    }
    chunks.push(bytes);
  }
  if (size !== stored.sizeBytes) {
    throw new KnowledgeBasePackageBindingError(
      "客户上传图片本地字节长度不一致",
    );
  }
  return Buffer.concat(chunks, size);
}

function assertPassiveSvgForPackage(bytes: Buffer) {
  const source = new TextDecoder("utf-8", { fatal: true })
    .decode(bytes)
    .replace(/^\uFEFF/u, "");
  if (
    !/^\s*(?:<\?xml(?:\s+[^?]*)?\?>\s*)?<svg\b/iu.test(source) ||
    /<!\s*(?:doctype|entity)\b/iu.test(source) ||
    /<\s*(?:script|foreignObject|iframe|object|embed|image|feImage|audio|video|canvas|style|link|meta)\b/iu.test(
      source,
    ) ||
    /\bon[a-z][\w:.-]*\s*=/iu.test(source) ||
    /\b(?:src|xml:base)\s*=/iu.test(source) ||
    /(?:@import|url\s*\()/iu.test(source)
  ) {
    throw new KnowledgeBasePackageBindingError(
      "客户 SVG 含主动内容，不能绑定最终 ZIP",
    );
  }
  const hrefAssignments = source.match(/\b(?:xlink:)?href\s*=/giu)?.length || 0;
  const hrefValues = [
    ...source.matchAll(/\b(?:xlink:)?href\s*=\s*(?:"([^"]*)"|'([^']*)')/giu),
  ];
  if (
    hrefValues.length !== hrefAssignments ||
    hrefValues.some(
      (match) => !/^#[A-Za-z_][\w:.-]*$/u.test(match[1] || match[2] || ""),
    )
  ) {
    throw new KnowledgeBasePackageBindingError(
      "客户 SVG 含外部引用，不能绑定最终 ZIP",
    );
  }
}

function isPotentialCustomerSvg(
  bytes: Buffer,
  mimeType: string,
  filename: string,
) {
  if (
    mimeType.trim().toLowerCase() === "image/svg+xml" ||
    /\.svg$/iu.test(filename)
  ) {
    return true;
  }
  const prefix = bytes
    .subarray(0, 4_096)
    .toString("utf8")
    .replace(/^\uFEFF/u, "");
  return /^\s*(?:<\?xml(?:\s+[^?]*)?\?>\s*)?<svg\b/iu.test(prefix);
}

async function normalizedCustomerImagePixels(bytes: Buffer, svg: boolean) {
  if (svg) assertPassiveSvgForPackage(bytes);
  const pipeline = sharp(bytes, {
    failOn: "error",
    limitInputPixels: 100_000_000,
    ...(svg ? { density: 144 } : {}),
  });
  const metadata = await pipeline.metadata();
  if (!metadata.width || !metadata.height) {
    throw new KnowledgeBasePackageBindingError("客户上传图片无法解码");
  }
  const pixels = await pipeline
    .rotate()
    .resize(128, 128, {
      fit: "contain",
      background: { r: 255, g: 255, b: 255, alpha: 1 },
    })
    .flatten({ background: "#ffffff" })
    .removeAlpha()
    .raw()
    .toBuffer();
  return {
    pixels,
    width: metadata.width,
    height: metadata.height,
    aspectRatio: metadata.width / metadata.height,
  };
}

export async function assertCapturedKnowledgeBaseCustomerImage(input: {
  fileId: string;
  filename: string;
  mimeType: string;
  sizeBytes: number;
  sourceSha256: string;
}) {
  const stored = await readStoredPresalesFile(input.fileId);
  if (
    !stored ||
    stored.filename !== input.filename ||
    stored.sizeBytes !== input.sizeBytes ||
    stored.sha256?.toLowerCase() !== input.sourceSha256
  ) {
    throw new KnowledgeBasePackageBindingError(
      "客户上传图片的受管原始字节缺失或完整性不一致",
    );
  }
  const bytes = await readStoredCustomerUploadBytes(stored);
  if (createHash("sha256").update(bytes).digest("hex") !== input.sourceSha256) {
    throw new KnowledgeBasePackageBindingError("客户上传图片的原始哈希不一致");
  }
  const sourceIsSvg = isPotentialCustomerSvg(
    bytes,
    input.mimeType,
    input.filename,
  );
  if (sourceIsSvg && bytes.length > CUSTOMER_UPLOAD_SVG_MAX_BYTES) {
    throw new KnowledgeBasePackageBindingError(
      "客户 SVG 超过 10 MB 安全预览上限",
    );
  }
  return normalizedCustomerImagePixels(bytes, sourceIsSvg);
}

/**
 * Re-read and hash every locally captured source. Exact packaged copies need no
 * second visual comparison; any safe conversion (including compression of a
 * large JPEG/PNG) must still render the same image as the captured bytes.
 */
export async function assertKnowledgeBaseCustomerUploadVisualBindings(input: {
  assets: readonly KnowledgeAsset[];
  expectedUploads: readonly KnowledgeBaseExpectedCustomerUpload[];
  readPackagedAssetBytes: (key: string) => Promise<Buffer>;
}) {
  const assetsBySourceHash = new Map(
    input.assets
      .filter((asset) => asset.sourceKind === "user_upload")
      .map((asset) => [
        String(asset.sourceUploadSha256 || "").toLowerCase(),
        asset,
      ]),
  );
  for (const expected of input.expectedUploads) {
    const asset = assetsBySourceHash.get(expected.sourceSha256);
    const fileId = expected.fileIds[0];
    if (!asset?.key || !fileId) {
      throw new KnowledgeBasePackageBindingError(
        "最终 ZIP 缺少客户上传图片的字节绑定",
      );
    }
    const stored = await readStoredPresalesFile(fileId);
    if (!stored || stored.sha256?.toLowerCase() !== expected.sourceSha256) {
      throw new KnowledgeBasePackageBindingError(
        "客户上传图片的原始字节已不可验证",
      );
    }
    const sourceBytes = await readStoredCustomerUploadBytes(stored);
    if (
      createHash("sha256").update(sourceBytes).digest("hex") !==
      expected.sourceSha256
    ) {
      throw new KnowledgeBasePackageBindingError(
        "客户上传图片的原始哈希不一致",
      );
    }
    const exactPackagedCopy =
      String(asset.sha256 || "").toLowerCase() === expected.sourceSha256 &&
      String(asset.mimeType || "").toLowerCase() ===
        String(asset.sourceUploadMimeType || "").toLowerCase();
    if (exactPackagedCopy) continue;

    const packagedBytes = await input.readPackagedAssetBytes(asset.key);
    const sourceIsSvg = isPotentialCustomerSvg(
      sourceBytes,
      asset.sourceUploadMimeType || "",
      asset.sourceUploadFilename || "",
    );
    const packagedIsSvg = isPotentialCustomerSvg(
      packagedBytes,
      asset.mimeType || "",
      asset.path || asset.key,
    );
    const [sourceVisual, packagedVisual] = await Promise.all([
      normalizedCustomerImagePixels(sourceBytes, sourceIsSvg),
      normalizedCustomerImagePixels(packagedBytes, packagedIsSvg),
    ]);
    if (
      Math.abs(sourceVisual.aspectRatio - packagedVisual.aspectRatio) /
        sourceVisual.aspectRatio >
      0.03
    ) {
      throw new KnowledgeBasePackageBindingError(
        "最终 ZIP 客户图片的宽高比与原始上传不一致",
      );
    }
    let absoluteDifference = 0;
    for (let index = 0; index < sourceVisual.pixels.length; index += 1) {
      absoluteDifference += Math.abs(
        sourceVisual.pixels[index]! - packagedVisual.pixels[index]!,
      );
    }
    const meanDifference =
      absoluteDifference / Math.max(1, sourceVisual.pixels.length);
    if (meanDifference > 18) {
      throw new KnowledgeBasePackageBindingError(
        "最终 ZIP 客户图片与原始上传的渲染内容不一致",
      );
    }
  }
}
