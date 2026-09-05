import { createHash } from "node:crypto";

import {
  decryptCredentialSecret,
  encryptCredentialSecret,
  type DecryptedCredential,
} from "./auth-service";
import {
  KnowledgeBaseAttachmentsProcessingError,
  KnowledgeBaseLocalPreparationError,
} from "./knowledge-base-api-errors";
import {
  finalizeKnowledgeBaseManusV2AttachmentMappings,
  loadKnowledgeBaseManusV2AttachmentLedger,
  persistKnowledgeBaseManusV2AttachmentAttempt,
  persistKnowledgeBaseManusV2AttachmentMapping,
  renewKnowledgeBaseTurnLease,
  type KnowledgeBaseGeneratedAttachmentReservation,
  type KnowledgeBaseManusV2AttachmentAttempt,
  type KnowledgeBaseManusV2AttachmentMimeEvidence,
  type KnowledgeBaseManusV2AttachmentMapping,
  type KnowledgeBaseRecoveryClaim,
} from "./knowledge-base-turn-service";
import {
  persistKnowledgeBaseBuildSource,
  readKnowledgeBaseLocalSource,
} from "./knowledge-base-local-source-store";
import { readKnowledgeBasePinnedSkillArchiveAttachment } from "./knowledge-base-skill-runtime";
import {
  ManusV2ApiError,
  ManusV2Client,
  classifyManusV2ProviderFileMime,
  isManusV2ProviderFileMimeUsable,
  type ManusV2Attachment,
  type ManusV2CreatedFile,
  type ManusV2ProviderFileDetail,
} from "./manus-v2-client";
import { readStoredPresalesFile } from "./presales-file-store";

const SHA256_PATTERN = /^[a-f0-9]{64}$/u;
const MAX_SOURCE_BYTES = 100 * 1024 * 1024;
// Leave a small verification budget after the final provider detail pass.
const ENSURE_MINIMUM_USABLE_SECONDS = 16 * 60;
const FINAL_MINIMUM_USABLE_SECONDS = 15 * 60;
const MAX_EXPLICIT_FILE_REJECTION_RETRIES = 3;
const MAX_INLINE_GENERATED_ATTACHMENT_BYTES = 20 * 1024 * 1024;

export type KnowledgeBaseManusV2ResolvedAttachment = ManusV2Attachment;

type LocalAttachmentSource = {
  sourceFileId: string;
  localStorageKey: string;
  contentSha256: string;
  sizeBytes: number;
  filename: string;
  mimeType: string;
  bytes: Buffer;
};

type SealedUploadCapability = NonNullable<
  KnowledgeBaseManusV2AttachmentAttempt["uploadCapability"]
>;

function localPreparationError(message: string, cause?: unknown) {
  return new KnowledgeBaseLocalPreparationError(
    "KNOWLEDGE_BASE_MANUS_V2_ATTACHMENT_SOURCE_UNAVAILABLE",
    message,
    cause === undefined ? undefined : { cause },
  );
}

function attachmentIntegrityError(message: string, cause?: unknown) {
  return new KnowledgeBaseLocalPreparationError(
    "KNOWLEDGE_BASE_MANUS_V2_ATTACHMENT_INTEGRITY_CONFLICT",
    message,
    cause === undefined ? undefined : { cause },
  );
}

function attachmentLifecycleExhaustedError(message: string, cause?: unknown) {
  return new KnowledgeBaseLocalPreparationError(
    "KNOWLEDGE_BASE_MANUS_V2_ATTACHMENT_LIFECYCLE_EXHAUSTED",
    message,
    cause === undefined ? undefined : { cause },
  );
}

export function isKnowledgeBaseManusV2GeneratedFileCreateRejected(
  error: unknown,
) {
  return Boolean(
    error instanceof KnowledgeBaseLocalPreparationError &&
      error.code === "KNOWLEDGE_BASE_MANUS_V2_ATTACHMENT_SOURCE_UNAVAILABLE" &&
      error.cause instanceof ManusV2ApiError &&
      error.cause.operation === "file.upload" &&
      !error.cause.retryable &&
      !error.cause.outcomeUnknown,
  );
}

function sha256(bytes: Buffer) {
  return createHash("sha256").update(bytes).digest("hex");
}

function generatedReservationByIndex(
  claim: KnowledgeBaseRecoveryClaim,
  attachmentIndex: number,
) {
  const matches = Object.values(
    claim.turn.generatedAttachmentReservations || {},
  ).filter((item) => item.attachmentIndex === attachmentIndex);
  if (matches.length > 1) {
    throw localPreparationError(
      "同一附件位置存在多个系统附件来源，已暂停当前构建以避免发送错误文件",
    );
  }
  return matches[0] || null;
}

function generatedReservationByProviderId(
  claim: KnowledgeBaseRecoveryClaim,
  sourceFileId: string,
) {
  const reservations = Object.values(
    claim.turn.generatedAttachmentReservations || {},
  );
  const byProviderId = reservations.filter(
    (item) => item.upstreamFileId === sourceFileId,
  );
  if (byProviderId.length === 1) return byProviderId[0]!;
  if (byProviderId.length > 1) {
    throw localPreparationError(
      "同一源文件 ID 对应多个系统附件，已暂停当前构建",
    );
  }
  return null;
}

async function readStoredBytes(
  stored: NonNullable<Awaited<ReturnType<typeof readStoredPresalesFile>>>,
) {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of stored.createReadStream()) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += bytes.length;
    if (total > MAX_SOURCE_BYTES) {
      throw localPreparationError("知识库源文件超过本地恢复上限");
    }
    chunks.push(bytes);
  }
  if (total !== stored.sizeBytes || total < 1) {
    throw localPreparationError("知识库源文件本地字节长度不一致");
  }
  return Buffer.concat(chunks, total);
}

function recoveryAttachmentDescriptor(
  claim: KnowledgeBaseRecoveryClaim,
  sourceFileId: string,
) {
  const attachments = Array.isArray(claim.recoveryMetadata.attachments)
    ? claim.recoveryMetadata.attachments
    : [];
  const index = attachments.findIndex(
    (value) =>
      value &&
      typeof value === "object" &&
      !Array.isArray(value) &&
      String((value as Record<string, unknown>).file_id || "") === sourceFileId,
  );
  if (index < 0) return null;
  const manifest = Array.isArray(claim.recoveryMetadata.attachmentManifest)
    ? claim.recoveryMetadata.attachmentManifest[index]
    : undefined;
  return manifest && typeof manifest === "object" && !Array.isArray(manifest)
    ? (manifest as Record<string, unknown>)
    : null;
}

function recoveryAttachmentSourceProof(
  claim: KnowledgeBaseRecoveryClaim,
  sourceFileId: string,
) {
  const proofs = Array.isArray(claim.recoveryMetadata.attachmentSourceProofs)
    ? claim.recoveryMetadata.attachmentSourceProofs
    : [];
  const matches = proofs.filter(
    (value) =>
      value &&
      typeof value === "object" &&
      !Array.isArray(value) &&
      String((value as Record<string, unknown>).fileId || "") === sourceFileId,
  );
  if (matches.length > 1) {
    throw localPreparationError("客户附件的 Dashboard 固定副本证明不唯一");
  }
  return matches[0] &&
    typeof matches[0] === "object" &&
    !Array.isArray(matches[0])
    ? (matches[0] as Record<string, unknown>)
    : null;
}

async function installBuildOwnedSource(input: {
  claim: KnowledgeBaseRecoveryClaim;
  bytes: Buffer;
}) {
  return persistKnowledgeBaseBuildSource({
    userId: input.claim.turn.userId,
    buildId: input.claim.turn.buildId,
    generation: input.claim.turn.buildGeneration,
    bytes: input.bytes,
  });
}

async function generatedLocalSource(input: {
  claim: KnowledgeBaseRecoveryClaim;
  attachmentIndex: number;
  sourceFileId: string;
  filename: string;
  reservation: KnowledgeBaseGeneratedAttachmentReservation;
}): Promise<LocalAttachmentSource> {
  const { reservation } = input;
  let bytes: Buffer;
  if (reservation.localStorageKey) {
    try {
      bytes = await readKnowledgeBaseLocalSource({
        storageKey: reservation.localStorageKey,
        contentSha256: reservation.contentSha256,
        sizeBytes: reservation.sizeBytes,
      });
    } catch (error) {
      throw localPreparationError(
        `系统附件“${input.filename}”的 Dashboard 固定副本不可用`,
        error,
      );
    }
  } else if (reservation.role === "skill") {
    // Historical rows may predate generated-source storage. Skill is the one
    // safe reconstruction: its physical archive is independently pinned.
    const archive = await readKnowledgeBasePinnedSkillArchiveAttachment({
      version: String(input.claim.recoveryMetadata.skillVersion || "4"),
      contentHash:
        typeof input.claim.recoveryMetadata.skillContentHash === "string"
          ? input.claim.recoveryMetadata.skillContentHash
          : undefined,
      physicalSha256:
        typeof input.claim.recoveryMetadata.skillArchiveSha256 === "string"
          ? input.claim.recoveryMetadata.skillArchiveSha256
          : reservation.contentSha256,
      archiveBytes: Number.isSafeInteger(
        input.claim.recoveryMetadata.skillArchiveBytes,
      )
        ? Number(input.claim.recoveryMetadata.skillArchiveBytes)
        : reservation.sizeBytes,
      storageKey:
        typeof input.claim.recoveryMetadata.skillArchiveStorageKey === "string"
          ? input.claim.recoveryMetadata.skillArchiveStorageKey
          : null,
    });
    bytes = archive.bytes;
  } else {
    throw localPreparationError(
      `系统附件“${input.filename}”缺少 Dashboard 固定副本；当前构建已隔离，绝不会回退发送旧 Provider 文件`,
    );
  }
  if (
    bytes.length !== reservation.sizeBytes ||
    sha256(bytes) !== reservation.contentSha256 ||
    reservation.filename !== input.filename
  ) {
    throw localPreparationError(
      `系统附件“${input.filename}”与固定物理哈希不一致`,
    );
  }
  const retained = await installBuildOwnedSource({ claim: input.claim, bytes });
  return {
    sourceFileId: input.sourceFileId,
    localStorageKey: retained.storageKey,
    contentSha256: retained.contentSha256,
    sizeBytes: retained.sizeBytes,
    filename: input.filename,
    mimeType: reservation.mimeType,
    bytes,
  };
}

async function customerLocalSource(input: {
  claim: KnowledgeBaseRecoveryClaim;
  sourceFileId: string;
  filename: string;
}): Promise<LocalAttachmentSource> {
  const descriptor = recoveryAttachmentDescriptor(
    input.claim,
    input.sourceFileId,
  );
  const sourceProof = recoveryAttachmentSourceProof(
    input.claim,
    input.sourceFileId,
  );
  const expectedSize = Number(sourceProof?.sizeBytes ?? descriptor?.sizeBytes);
  const expectedSha = String(
    sourceProof?.contentSha256 ?? descriptor?.sha256 ?? "",
  )
    .trim()
    .toLowerCase();
  const expectedMimeType = String(
    sourceProof?.mimeType ?? descriptor?.mimeType ?? "application/octet-stream",
  ).trim();
  const localStorageKey = String(sourceProof?.localStorageKey || "").trim();
  if (
    !Number.isSafeInteger(expectedSize) ||
    expectedSize < 1 ||
    !SHA256_PATTERN.test(expectedSha)
  ) {
    throw localPreparationError(
      `客户附件“${input.filename}”缺少完整的本地 size/SHA 证明`,
    );
  }
  let bytes: Buffer;
  if (localStorageKey) {
    try {
      bytes = await readKnowledgeBaseLocalSource({
        storageKey: localStorageKey,
        contentSha256: expectedSha,
        sizeBytes: expectedSize,
      });
    } catch (error) {
      throw localPreparationError(
        `客户附件“${input.filename}”的 build 固定副本不可用`,
        error,
      );
    }
  } else {
    // Compatibility for reservations created before stage-time build-owned
    // installation. New turns always use the durable source proof above.
    const stored = await readStoredPresalesFile(input.sourceFileId);
    if (
      !stored ||
      stored.sizeBytes !== expectedSize ||
      (stored.sha256 && stored.sha256.toLowerCase() !== expectedSha)
    ) {
      throw localPreparationError(
        `客户附件“${input.filename}”的 Dashboard 原始字节不可用`,
      );
    }
    bytes = await readStoredBytes(stored);
  }
  if (bytes.length !== expectedSize || sha256(bytes) !== expectedSha) {
    throw localPreparationError(
      `客户附件“${input.filename}”未通过 Dashboard 原始字节校验`,
    );
  }
  const retained = await installBuildOwnedSource({ claim: input.claim, bytes });
  return {
    sourceFileId: input.sourceFileId,
    localStorageKey: retained.storageKey,
    contentSha256: retained.contentSha256,
    sizeBytes: retained.sizeBytes,
    // The frozen prepared filename is the task contract. The local manifest
    // still proves content/MIME and is never trusted to change the slot.
    filename: input.filename,
    mimeType: expectedMimeType || "application/octet-stream",
    bytes,
  };
}

async function resolveLocalSources(claim: KnowledgeBaseRecoveryClaim) {
  const prepared = claim.preparedDispatch;
  if (!prepared) {
    throw localPreparationError(
      "FrontMind 附件映射缺少冻结的 prepared dispatch",
    );
  }
  const result: LocalAttachmentSource[] = [];
  for (
    let attachmentIndex = 0;
    attachmentIndex < prepared.requestBody.attachments.length;
    attachmentIndex += 1
  ) {
    const attachment = prepared.requestBody.attachments[attachmentIndex]!;
    const indexedGenerated = generatedReservationByIndex(
      claim,
      attachmentIndex,
    );
    const generated =
      indexedGenerated?.filename === attachment.filename
        ? indexedGenerated
        : generatedReservationByProviderId(claim, attachment.file_id);
    result.push(
      generated
        ? await generatedLocalSource({
            claim,
            attachmentIndex,
            sourceFileId: attachment.file_id,
            filename: attachment.filename,
            reservation: generated,
          })
        : await customerLocalSource({
            claim,
            sourceFileId: attachment.file_id,
            filename: attachment.filename,
          }),
    );
  }
  return result;
}

function generatedReservationForSource(input: {
  claim: KnowledgeBaseRecoveryClaim;
  attachmentIndex: number;
  source: LocalAttachmentSource;
}) {
  const indexed = generatedReservationByIndex(
    input.claim,
    input.attachmentIndex,
  );
  if (
    indexed &&
    indexed.filename === input.source.filename &&
    indexed.contentSha256 === input.source.contentSha256 &&
    indexed.sizeBytes === input.source.sizeBytes
  ) {
    return indexed;
  }
  return null;
}

function eligibleInlineGeneratedSource(input: {
  claim: KnowledgeBaseRecoveryClaim;
  attachmentIndex: number;
  source: LocalAttachmentSource;
}) {
  const reservation = generatedReservationForSource(input);
  return Boolean(
    reservation &&
      (reservation.role === "skill" || reservation.role === "instructions") &&
      input.source.sizeBytes > 0 &&
      input.source.sizeBytes <= MAX_INLINE_GENERATED_ATTACHMENT_BYTES,
  );
}

function inlineGeneratedAttachment(input: {
  source: LocalAttachmentSource;
  attachmentIndex: number;
}): KnowledgeBaseManusV2ResolvedAttachment {
  return {
    file_data: `data:${input.source.mimeType};base64,${input.source.bytes.toString("base64")}`,
    filename: input.source.filename,
    mime_type: input.source.mimeType,
  };
}

function mappingKey(input: {
  claim: KnowledgeBaseRecoveryClaim;
  attachmentIndex: number;
  source: LocalAttachmentSource;
}) {
  return `g${input.claim.turn.buildGeneration}:${input.attachmentIndex}:${input.source.contentSha256}:${input.source.sizeBytes}`;
}

function uploadCapabilityAad(input: {
  claim: KnowledgeBaseRecoveryClaim;
  mappingKey: string;
  providerGeneration: number;
  upstreamFileId: string;
}) {
  return [
    "frontmind-kb-manus-v2-upload-capability:v1",
    input.claim.turn.userId,
    input.claim.turn.id,
    input.mappingKey,
    input.providerGeneration,
    input.upstreamFileId,
  ].join(":");
}

function sealUploadCapability(input: {
  claim: KnowledgeBaseRecoveryClaim;
  mappingKey: string;
  providerGeneration: number;
  file: ManusV2CreatedFile;
}): SealedUploadCapability {
  const sealed = encryptCredentialSecret(
    uploadCapabilityAad({
      ...input,
      upstreamFileId: input.file.fileId,
    }),
    input.file.uploadUrl,
  );
  return {
    schemaVersion: 1,
    encryptionVersion: 1,
    ciphertext: sealed.encryptedKey,
    iv: sealed.encryptionIv,
    authTag: sealed.encryptionAuthTag,
  };
}

function openUploadCapability(input: {
  claim: KnowledgeBaseRecoveryClaim;
  attempt: KnowledgeBaseManusV2AttachmentAttempt;
}) {
  const capability = input.attempt.uploadCapability;
  if (!capability || !input.attempt.upstreamFileId) {
    throw localPreparationError(
      "FrontMind 附件的耐久上传能力缺失，无法安全恢复明确未受理的 PUT",
    );
  }
  const uploadUrl = decryptCredentialSecret(
    uploadCapabilityAad({
      claim: input.claim,
      mappingKey: input.attempt.mappingKey,
      providerGeneration: input.attempt.providerGeneration,
      upstreamFileId: input.attempt.upstreamFileId,
    }),
    {
      encryptionVersion: capability.encryptionVersion,
      encryptedKey: capability.ciphertext,
      encryptionIv: capability.iv,
      encryptionAuthTag: capability.authTag,
    },
  );
  const target = new URL(uploadUrl);
  if (
    target.protocol !== "https:" ||
    target.username ||
    target.password ||
    uploadUrl.length > 8_192
  ) {
    throw localPreparationError("FrontMind 附件的耐久上传能力无效");
  }
  return uploadUrl;
}

function existingMapping(input: {
  claim: KnowledgeBaseRecoveryClaim;
  attachmentIndex: number;
  source: LocalAttachmentSource;
}) {
  const key = mappingKey(input);
  return input.claim.turn.manusV2AttachmentMappings?.[key] || null;
}

function existingAttempt(input: {
  claim: KnowledgeBaseRecoveryClaim;
  attachmentIndex: number;
  source: LocalAttachmentSource;
}) {
  const key = mappingKey(input);
  return input.claim.turn.manusV2AttachmentAttempts?.[key] || null;
}

function attachmentAttempt(input: {
  claim: KnowledgeBaseRecoveryClaim;
  attachmentIndex: number;
  source: LocalAttachmentSource;
  providerGeneration: number;
  state: KnowledgeBaseManusV2AttachmentAttempt["state"];
  file?: ManusV2CreatedFile | null;
  code?: string | null;
  rejectionCount?: number;
  nextRetryAt?: string | null;
  uploadCapability?: SealedUploadCapability | null;
  mimeEvidence?: KnowledgeBaseManusV2AttachmentMimeEvidence;
}): KnowledgeBaseManusV2AttachmentAttempt {
  return {
    schemaVersion: 1,
    mappingKey: mappingKey(input),
    buildGeneration: input.claim.turn.buildGeneration,
    attachmentIndex: input.attachmentIndex,
    sourceFileId: input.source.sourceFileId,
    localStorageKey: input.source.localStorageKey,
    contentSha256: input.source.contentSha256,
    sizeBytes: input.source.sizeBytes,
    filename: input.source.filename,
    mimeType: input.source.mimeType,
    providerGeneration: input.providerGeneration,
    state: input.state,
    upstreamFileId: input.file?.fileId ?? null,
    uploadExpiresAt: input.file?.uploadExpiresAt ?? null,
    ...(input.uploadCapability === undefined
      ? {}
      : { uploadCapability: input.uploadCapability }),
    code: input.code ?? null,
    ...(input.rejectionCount === undefined
      ? {}
      : { rejectionCount: input.rejectionCount }),
    ...(input.nextRetryAt === undefined
      ? {}
      : { nextRetryAt: input.nextRetryAt }),
    ...(input.mimeEvidence === undefined
      ? {}
      : { mimeEvidence: input.mimeEvidence }),
    recordedAt: new Date().toISOString(),
  };
}

function providerMimeEvidence(input: {
  filename: string;
  expectedContentType: string;
  detail: ManusV2ProviderFileDetail;
}): KnowledgeBaseManusV2AttachmentMimeEvidence {
  const expectedContentType = input.expectedContentType
    .split(";", 1)[0]!
    .trim()
    .toLowerCase();
  if (!/^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/u.test(expectedContentType)) {
    throw localPreparationError(
      "FrontMind 冻结附件的 canonical MIME 无效，无法建立 Provider 文件证明",
    );
  }
  const disposition = classifyManusV2ProviderFileMime({
    filename: input.filename,
    expectedContentType,
    providerContentType: input.detail.contentType,
    providerContentTypeParseStatus: input.detail.contentTypeParseStatus,
  });
  return {
    expectedContentType,
    providerContentType: input.detail.contentType,
    disposition,
    observedAt: new Date().toISOString(),
  };
}

function safeFilenameExtension(filename: string) {
  const basename = filename.replace(/^.*[\\/]/u, "").toLowerCase();
  const lastDot = basename.lastIndexOf(".");
  if (lastDot <= 0 || lastDot === basename.length - 1) return null;
  const extension = basename.slice(lastDot, lastDot + 17);
  return /^\.[a-z0-9]{1,15}$/u.test(extension) ? extension : null;
}

function logProviderMimeDecision(input: {
  attempt: KnowledgeBaseManusV2AttachmentAttempt;
  evidence: KnowledgeBaseManusV2AttachmentMimeEvidence;
  decision: "ready" | "replaceable_unusable" | "integrity_conflict";
}) {
  if (input.evidence.disposition === "exact") return;
  console.info("[Knowledge base] provider attachment MIME advisory", {
    diagnosticCode: "KB_ATTACHMENT_PROVIDER_MIME_ADVISORY",
    stage: "provider_file_registration",
    buildGeneration: input.attempt.buildGeneration,
    attachmentIndex: input.attempt.attachmentIndex,
    filenameExtension: safeFilenameExtension(input.attempt.filename),
    providerGeneration: input.attempt.providerGeneration,
    expectedContentType: input.evidence.expectedContentType,
    providerContentType: input.evidence.providerContentType,
    mimeDisposition: input.evidence.disposition,
    identityDecision: input.decision,
  });
}

async function persistAttempt(input: {
  claim: KnowledgeBaseRecoveryClaim;
  attempt: KnowledgeBaseManusV2AttachmentAttempt;
}) {
  await persistKnowledgeBaseManusV2AttachmentAttempt({
    userId: input.claim.turn.userId,
    turnId: input.claim.turn.id,
    leaseToken: input.claim.leaseToken,
    attempt: input.attempt,
  });
  input.claim.turn.manusV2AttachmentAttempts = {
    ...(input.claim.turn.manusV2AttachmentAttempts || {}),
    [input.attempt.mappingKey]: input.attempt,
  };
}

function exactProviderProof(input: {
  mapping: KnowledgeBaseManusV2AttachmentMapping;
  detail: Awaited<ReturnType<ManusV2Client["fileDetail"]>>;
  minimumExpirySeconds: number;
}) {
  return (
    input.detail.fileId === input.mapping.upstreamFileId &&
    input.detail.filename === input.mapping.filename &&
    input.detail.status === "uploaded" &&
    input.detail.bytes === input.mapping.sizeBytes &&
    isManusV2ProviderFileMimeUsable({
      filename: input.mapping.filename,
      expectedContentType: input.mapping.mimeType,
      providerContentType: input.detail.contentType,
      providerContentTypeParseStatus: input.detail.contentTypeParseStatus,
      confirmationPolicy: "kb_frozen_source_advisory",
    }) &&
    Number.isSafeInteger(input.detail.expiresAt) &&
    input.detail.expiresAt >= input.minimumExpirySeconds
  );
}

export async function validateReusableKnowledgeBaseManusV2Attachment(input: {
  client: ManusV2Client;
  mapping: KnowledgeBaseManusV2AttachmentMapping;
  minimumExpirySeconds: number;
}) {
  try {
    const detail = await input.client.fileDetail(input.mapping.upstreamFileId);
    return exactProviderProof({ ...input, detail }) ? detail : null;
  } catch (error) {
    // A transport/5xx result cannot prove the old file unusable. Replacing it
    // would turn response loss into unbounded provider files.
    if (
      error instanceof ManusV2ApiError &&
      !error.retryable &&
      !error.outcomeUnknown &&
      (error.status === 404 || error.status === 410)
    ) {
      return null;
    }
    throw error;
  }
}

export async function inspectKnowledgeBaseManusV2AttachmentAttempt(input: {
  client: ManusV2Client;
  attempt: KnowledgeBaseManusV2AttachmentAttempt;
  minimumExpirySeconds: number;
}) {
  return inspectCandidate(input);
}

type CandidateInspection =
  | {
      state: "ready";
      detail: Awaited<ReturnType<ManusV2Client["fileDetail"]>>;
      mimeEvidence: KnowledgeBaseManusV2AttachmentMimeEvidence;
    }
  | {
      state: "replaceable_unusable";
      code: string;
      mimeEvidence?: KnowledgeBaseManusV2AttachmentMimeEvidence;
    }
  | {
      state: "integrity_conflict";
      code: string;
      mimeEvidence?: KnowledgeBaseManusV2AttachmentMimeEvidence;
    }
  | { state: "unresolved"; code: string };

export function finalKnowledgeBaseManusV2AttachmentInspectionAction(input: {
  inspection: CandidateInspection;
  providerGeneration: number;
}) {
  if (input.inspection.state === "ready") return "refresh" as const;
  if (input.inspection.state === "unresolved") return "wait" as const;
  if (input.inspection.state === "integrity_conflict") {
    return "reject" as const;
  }
  return input.providerGeneration < 2
    ? ("replace" as const)
    : ("isolate" as const);
}

export function shouldInspectReadyMappingBeforeAttachmentAttempt(input: {
  mappingProviderGeneration: number;
  attemptProviderGeneration: number | null;
}) {
  // A crash may leave a generation-1 ready mapping next to the already
  // journaled generation-2 candidate. The newer attempt is the only remaining
  // writer authority; inspecting the stale id first could otherwise try to
  // move the monotonic attempt ledger backwards.
  return (
    input.attemptProviderGeneration === null ||
    input.attemptProviderGeneration <= input.mappingProviderGeneration
  );
}

async function inspectCandidate(input: {
  client: ManusV2Client;
  attempt: KnowledgeBaseManusV2AttachmentAttempt;
  minimumExpirySeconds: number;
}): Promise<CandidateInspection> {
  if (!input.attempt.upstreamFileId) {
    return {
      state: "unresolved",
      code: "MANUS_V2_FILE_CREATE_OUTCOME_UNKNOWN",
    };
  }
  try {
    const detail = await input.client.fileDetail(input.attempt.upstreamFileId);
    const mimeEvidence = providerMimeEvidence({
      filename: input.attempt.filename,
      expectedContentType: input.attempt.mimeType,
      detail,
    });
    if (detail.fileId !== input.attempt.upstreamFileId) {
      return {
        state: "integrity_conflict",
        code: "KB_ATTACHMENT_IDENTITY_CONFLICT",
        mimeEvidence,
      };
    }
    if (detail.filename !== input.attempt.filename) {
      return {
        state: "integrity_conflict",
        code: "KB_ATTACHMENT_IDENTITY_CONFLICT",
        mimeEvidence,
      };
    }
    if (detail.status === "deleted" || detail.status === "error") {
      return {
        state: "replaceable_unusable",
        code: "KB_ATTACHMENT_LIFECYCLE_UNUSABLE",
        mimeEvidence,
      };
    }
    if (
      detail.status === "uploaded" &&
      detail.bytes !== input.attempt.sizeBytes
    ) {
      return {
        state: "integrity_conflict",
        code: "KB_ATTACHMENT_BYTES_CONFLICT",
        mimeEvidence,
      };
    }
    if (
      detail.status === "uploaded" &&
      detail.bytes === input.attempt.sizeBytes &&
      Number.isSafeInteger(detail.expiresAt) &&
      detail.expiresAt >= input.minimumExpirySeconds
    ) {
      const inspection = { state: "ready", detail, mimeEvidence } as const;
      logProviderMimeDecision({
        attempt: input.attempt,
        evidence: mimeEvidence,
        decision: "ready",
      });
      return inspection;
    }
    if (
      detail.status === "uploaded" &&
      Number.isSafeInteger(detail.expiresAt) &&
      detail.expiresAt < input.minimumExpirySeconds
    ) {
      return {
        state: "replaceable_unusable",
        code: "KB_ATTACHMENT_LIFECYCLE_UNUSABLE",
        mimeEvidence,
      };
    }
    if (
      detail.status === "pending" &&
      input.attempt.uploadExpiresAt !== null &&
      input.attempt.uploadExpiresAt * 1_000 - 5_000 <= Date.now()
    ) {
      // Once the provider's own signed-upload deadline has passed, a still
      // pending record can no longer become uploaded from this attempt.
      return {
        state: "replaceable_unusable",
        code: "KB_ATTACHMENT_LIFECYCLE_UNUSABLE",
        mimeEvidence,
      };
    }
    // A known pending file is not proof of failure. It remains the only
    // candidate and a later recovery details this same id again.
    return { state: "unresolved", code: "KB_ATTACHMENT_PENDING" };
  } catch (error) {
    if (
      error instanceof ManusV2ApiError &&
      !error.outcomeUnknown &&
      !error.retryable &&
      (error.status === 404 || error.status === 410)
    ) {
      return {
        state: "replaceable_unusable",
        code: "KB_ATTACHMENT_LIFECYCLE_UNUSABLE",
      };
    }
    if (
      error instanceof ManusV2ApiError &&
      ["FILE_ID_CONFLICT", "FILE_IDENTITY_CONFLICT"].includes(error.code)
    ) {
      return {
        state: "integrity_conflict",
        code: "KB_ATTACHMENT_IDENTITY_CONFLICT",
      };
    }
    if (
      error instanceof ManusV2ApiError &&
      error.code === "FILE_BYTES_CONFLICT"
    ) {
      return {
        state: "integrity_conflict",
        code: "KB_ATTACHMENT_BYTES_CONFLICT",
      };
    }
    return {
      state: "unresolved",
      code:
        error instanceof ManusV2ApiError
          ? `MANUS_V2_FILE_DETAIL_${error.code}`.slice(0, 128)
          : "MANUS_V2_FILE_DETAIL_UNRESOLVED",
    };
  }
}

function mappingFromCandidate(input: {
  attempt: KnowledgeBaseManusV2AttachmentAttempt;
  detail: Awaited<ReturnType<ManusV2Client["fileDetail"]>>;
  mimeEvidence: KnowledgeBaseManusV2AttachmentMimeEvidence;
}): KnowledgeBaseManusV2AttachmentMapping {
  if (!input.attempt.upstreamFileId) {
    throw localPreparationError("FrontMind 附件 candidate 缺少 Provider ID");
  }
  return {
    schemaVersion: 1,
    providerProtocol: "manus_v2",
    mappingKey: input.attempt.mappingKey,
    buildGeneration: input.attempt.buildGeneration,
    attachmentIndex: input.attempt.attachmentIndex,
    sourceFileId: input.attempt.sourceFileId,
    localStorageKey: input.attempt.localStorageKey,
    contentSha256: input.attempt.contentSha256,
    sizeBytes: input.attempt.sizeBytes,
    filename: input.attempt.filename,
    mimeType: input.attempt.mimeType,
    upstreamFileId: input.attempt.upstreamFileId,
    status: "ready",
    expiresAt: input.detail.expiresAt,
    providerGeneration: input.attempt.providerGeneration,
    verifiedAt: new Date().toISOString(),
    mimeEvidence: input.mimeEvidence,
  };
}

function unresolvedCandidateError(input: { filename: string; code: string }) {
  return new KnowledgeBaseAttachmentsProcessingError(0, 1, 30_000, input.code);
}

export function nextKnowledgeBaseManusV2FileCreateGeneration(
  attempt: KnowledgeBaseManusV2AttachmentAttempt | null,
) {
  if (!attempt) return 1;
  if (
    attempt.state === "unusable" &&
    [
      "KB_ATTACHMENT_IDENTITY_CONFLICT",
      "KB_ATTACHMENT_BYTES_CONFLICT",
    ].includes(String(attempt.code || ""))
  ) {
    return null;
  }
  if (
    attempt.state !== "unusable" &&
    attempt.state !== "create_outcome_unknown" &&
    attempt.state !== "creating"
  ) {
    return null;
  }
  return attempt.providerGeneration < 2 ? attempt.providerGeneration + 1 : null;
}

export function knowledgeBaseManusV2FileRejectionRetryDelay(input: {
  mappingKey: string;
  rejectionCount: number;
  providerRetryAfterMs: number | null;
}) {
  if (input.providerRetryAfterMs !== null) {
    return Math.min(60 * 60_000, Math.max(0, input.providerRetryAfterMs));
  }
  const base = Math.min(
    30_000,
    1_000 * 2 ** Math.min(input.rejectionCount - 1, 5),
  );
  const seed =
    createHash("sha256")
      .update(`${input.mappingKey}:${input.rejectionCount}`, "utf8")
      .digest()[0] ?? 0;
  return base + Math.floor((base * (seed % 21)) / 100);
}

async function persistReadyMapping(input: {
  claim: KnowledgeBaseRecoveryClaim;
  mapping: KnowledgeBaseManusV2AttachmentMapping;
}) {
  await persistKnowledgeBaseManusV2AttachmentMapping({
    userId: input.claim.turn.userId,
    turnId: input.claim.turn.id,
    leaseToken: input.claim.leaseToken,
    mapping: input.mapping,
  });
  input.claim.turn.manusV2AttachmentMappings = {
    ...(input.claim.turn.manusV2AttachmentMappings || {}),
    [input.mapping.mappingKey]: input.mapping,
  };
}

async function ensureOneMapping(input: {
  claim: KnowledgeBaseRecoveryClaim;
  client: ManusV2Client;
  source: LocalAttachmentSource;
  attachmentIndex: number;
}) {
  await renewKnowledgeBaseTurnLease({
    userId: input.claim.turn.userId,
    turnId: input.claim.turn.id,
    leaseToken: input.claim.leaseToken,
  });
  const existing = existingMapping(input);
  const key = mappingKey(input);
  let attempt = existingAttempt(input);
  let retryingCreateSameGeneration = false;
  let retryingPutSameCandidate = false;
  const minimumExpirySeconds =
    Math.floor(Date.now() / 1_000) + ENSURE_MINIMUM_USABLE_SECONDS;
  if (attempt?.state === "put_retry_wait") {
    const nextRetryAt = Date.parse(String(attempt.nextRetryAt || ""));
    if (!Number.isFinite(nextRetryAt)) {
      throw localPreparationError(
        `FrontMind 附件“${input.source.filename}”的 PUT 重试时间无效`,
      );
    }
    if (Date.now() < nextRetryAt) {
      throw new KnowledgeBaseAttachmentsProcessingError(
        0,
        1,
        Math.max(250, Math.min(60_000, nextRetryAt - Date.now())),
        attempt.code || undefined,
      );
    }
    if (
      !attempt.uploadExpiresAt ||
      attempt.uploadExpiresAt * 1_000 - 5_000 <= Date.now()
    ) {
      const unusable = attachmentAttempt({
        ...input,
        providerGeneration: attempt.providerGeneration,
        state: "unusable",
        file: {
          fileId: attempt.upstreamFileId!,
          filename: attempt.filename,
          uploadUrl: "https://redacted.invalid/",
          uploadExpiresAt: attempt.uploadExpiresAt!,
          requestId: null,
        },
        code: "MANUS_V2_FILE_UPLOAD_URL_EXPIRED",
        uploadCapability: null,
      });
      await persistAttempt({ claim: input.claim, attempt: unusable });
      attempt = unusable;
    } else {
      // A retryable HTTP response proves that the PUT was not accepted. The
      // exact signed capability was sealed before the first PUT, so a process
      // restart can safely resume this one file id without file.create or a
      // replacement generation.
      openUploadCapability({ claim: input.claim, attempt });
      retryingPutSameCandidate = true;
    }
  } else if (
    attempt?.state === "candidate_created" &&
    attempt.uploadCapability &&
    attempt.uploadExpiresAt &&
    attempt.uploadExpiresAt * 1_000 - 5_000 > Date.now()
  ) {
    // `onCandidateCreated` is durably committed before `onPutStarted` is
    // invoked. Therefore this exact state proves that no PUT body was sent.
    // Resume the sealed signed capability with rejection count zero instead
    // of consuming the one bounded replacement generation.
    openUploadCapability({ claim: input.claim, attempt });
    retryingPutSameCandidate = true;
  } else if (attempt?.state === "create_retry_wait") {
    const nextRetryAt = Date.parse(String(attempt.nextRetryAt || ""));
    if (!Number.isFinite(nextRetryAt)) {
      throw localPreparationError(
        `FrontMind 附件“${input.source.filename}”的重试时间无效`,
      );
    }
    if (Date.now() < nextRetryAt) {
      throw new KnowledgeBaseAttachmentsProcessingError(
        0,
        1,
        Math.max(250, Math.min(60_000, nextRetryAt - Date.now())),
        attempt.code || undefined,
      );
    }
    const retrying = attachmentAttempt({
      ...input,
      providerGeneration: attempt.providerGeneration,
      state: "creating",
      code: attempt.code,
      rejectionCount: attempt.rejectionCount,
    });
    await persistAttempt({ claim: input.claim, attempt: retrying });
    attempt = retrying;
    retryingCreateSameGeneration = true;
  } else if (attempt?.state === "creating") {
    // Crash after file.create returned but before its id was journaled is
    // indistinguishable from create response loss. Consume the one bounded
    // replacement generation; never replay an unbounded POST loop.
    const unknown = attachmentAttempt({
      ...input,
      providerGeneration: attempt.providerGeneration,
      state: "create_outcome_unknown",
      code: "MANUS_V2_FILE_CREATE_CRASH_OUTCOME_UNKNOWN",
    });
    await persistAttempt({ claim: input.claim, attempt: unknown });
    attempt = unknown;
  }
  if (
    existing &&
    shouldInspectReadyMappingBeforeAttachmentAttempt({
      mappingProviderGeneration: existing.providerGeneration,
      attemptProviderGeneration: attempt?.providerGeneration ?? null,
    })
  ) {
    const inspectionAttempt =
      attempt &&
      attempt.providerGeneration === existing.providerGeneration &&
      attempt.upstreamFileId === existing.upstreamFileId
        ? attempt
        : attachmentAttempt({
            ...input,
            providerGeneration: existing.providerGeneration,
            state: "put_accepted",
            file: {
              fileId: existing.upstreamFileId,
              filename: existing.filename,
              uploadUrl: "https://redacted.invalid/",
              uploadExpiresAt: existing.expiresAt,
              requestId: null,
            },
          });
    const inspection = await inspectCandidate({
      client: input.client,
      attempt: inspectionAttempt,
      minimumExpirySeconds,
    });
    if (inspection.state === "ready") {
      const refreshed: KnowledgeBaseManusV2AttachmentMapping = {
        ...existing,
        expiresAt: inspection.detail.expiresAt,
        verifiedAt: new Date().toISOString(),
        mimeEvidence: inspection.mimeEvidence,
      };
      await persistReadyMapping({ claim: input.claim, mapping: refreshed });
      return refreshed;
    }
    if (inspection.state === "unresolved") {
      throw unresolvedCandidateError({
        filename: input.source.filename,
        code: inspection.code,
      });
    }
    if (inspection.state === "integrity_conflict") {
      if (inspection.mimeEvidence) {
        logProviderMimeDecision({
          attempt: inspectionAttempt,
          evidence: inspection.mimeEvidence,
          decision: "integrity_conflict",
        });
      }
      if (attempt?.state !== "unusable") {
        attempt = attachmentAttempt({
          ...input,
          providerGeneration: existing.providerGeneration,
          state: "unusable",
          file: {
            fileId: existing.upstreamFileId,
            filename: existing.filename,
            uploadUrl: "https://redacted.invalid/",
            uploadExpiresAt: existing.expiresAt,
            requestId: null,
          },
          code: inspection.code,
          mimeEvidence: inspection.mimeEvidence,
        });
        await persistAttempt({ claim: input.claim, attempt });
      }
      throw attachmentIntegrityError(
        `FrontMind 附件“${input.source.filename}”的 Provider 身份证明与冻结源不一致（${inspection.code}）`,
      );
    }
    if (existing.providerGeneration >= 2) {
      throw attachmentLifecycleExhaustedError(
        `FrontMind 附件“${input.source.filename}”两次失效，当前构建已局部隔离`,
      );
    }
    // Older ready-only ledgers had no candidate lifecycle row. A definitely
    // unusable ready id is still an authoritative first generation.
    if (attempt?.state !== "unusable") {
      attempt = attachmentAttempt({
        ...input,
        providerGeneration: existing.providerGeneration,
        state: "unusable",
        file: {
          fileId: existing.upstreamFileId,
          filename: existing.filename,
          uploadUrl: "https://redacted.invalid/",
          uploadExpiresAt: existing.expiresAt,
          requestId: null,
        },
        code: inspection.code,
        mimeEvidence: inspection.mimeEvidence,
      });
      await persistAttempt({ claim: input.claim, attempt });
    }
  }
  if (
    attempt &&
    !retryingCreateSameGeneration &&
    !retryingPutSameCandidate &&
    attempt.state !== "unusable" &&
    attempt.state !== "create_rejected" &&
    attempt.state !== "create_outcome_unknown"
  ) {
    if (attempt.state === "creating" || !attempt.upstreamFileId) {
      throw unresolvedCandidateError({
        filename: input.source.filename,
        code: "MANUS_V2_FILE_CREATE_OUTCOME_UNKNOWN",
      });
    }
    if (attempt.state === "put_sending") {
      // The signed PUT may not have reached Manus. There is no safe second PUT
      // contract for an ambiguous body upload; detail remains the only read.
      const inspection = await inspectCandidate({
        client: input.client,
        attempt,
        minimumExpirySeconds,
      });
      if (inspection.state === "ready") {
        const mapping = mappingFromCandidate({
          attempt,
          detail: inspection.detail,
          mimeEvidence: inspection.mimeEvidence,
        });
        await persistReadyMapping({ claim: input.claim, mapping });
        return mapping;
      }
      if (
        inspection.state === "replaceable_unusable" ||
        inspection.state === "integrity_conflict"
      ) {
        attempt = attachmentAttempt({
          ...input,
          providerGeneration: attempt.providerGeneration,
          state: "unusable",
          file: {
            fileId: attempt.upstreamFileId,
            filename: attempt.filename,
            uploadUrl: "https://redacted.invalid/",
            uploadExpiresAt: attempt.uploadExpiresAt!,
            requestId: null,
          },
          code: inspection.code,
          mimeEvidence: inspection.mimeEvidence,
        });
        await persistAttempt({ claim: input.claim, attempt });
        if (inspection.state === "integrity_conflict") {
          throw attachmentIntegrityError(
            `FrontMind 附件“${input.source.filename}”的 Provider 身份证明与冻结源不一致（${inspection.code}）`,
          );
        }
      } else {
        throw unresolvedCandidateError({
          filename: input.source.filename,
          code: inspection.code,
        });
      }
    } else if (attempt.state === "candidate_created") {
      // Historical candidate rows predate durable sealed upload capabilities.
      // No PUT was attempted, so a missing or expired capability may consume
      // the one bounded replacement generation without duplicating a body.
      attempt = attachmentAttempt({
        ...input,
        providerGeneration: attempt.providerGeneration,
        state: "unusable",
        file: {
          fileId: attempt.upstreamFileId,
          filename: attempt.filename,
          uploadUrl: "https://redacted.invalid/",
          uploadExpiresAt: attempt.uploadExpiresAt!,
          requestId: null,
        },
        code:
          attempt.uploadExpiresAt! * 1_000 - 5_000 <= Date.now()
            ? "MANUS_V2_FILE_UPLOAD_URL_EXPIRED"
            : "MANUS_V2_FILE_UPLOAD_URL_NOT_RETAINED",
      });
      await persistAttempt({ claim: input.claim, attempt });
    } else {
      const inspection = await inspectCandidate({
        client: input.client,
        attempt,
        minimumExpirySeconds,
      });
      if (inspection.state === "ready") {
        const mapping = mappingFromCandidate({
          attempt,
          detail: inspection.detail,
          mimeEvidence: inspection.mimeEvidence,
        });
        await persistReadyMapping({ claim: input.claim, mapping });
        return mapping;
      }
      if (inspection.state === "unresolved") {
        throw unresolvedCandidateError({
          filename: input.source.filename,
          code: inspection.code,
        });
      }
      attempt = attachmentAttempt({
        ...input,
        providerGeneration: attempt.providerGeneration,
        state: "unusable",
        file: {
          fileId: attempt.upstreamFileId,
          filename: attempt.filename,
          uploadUrl: "https://redacted.invalid/",
          uploadExpiresAt: attempt.uploadExpiresAt!,
          requestId: null,
        },
        code: inspection.code,
        mimeEvidence: inspection.mimeEvidence,
      });
      await persistAttempt({ claim: input.claim, attempt });
      if (inspection.state === "integrity_conflict") {
        throw attachmentIntegrityError(
          `FrontMind 附件“${input.source.filename}”的 Provider 身份证明与冻结源不一致（${inspection.code}）`,
        );
      }
    }
  }
  const providerGeneration = retryingPutSameCandidate
    ? attempt!.providerGeneration
    : retryingCreateSameGeneration
      ? attempt!.providerGeneration
      : nextKnowledgeBaseManusV2FileCreateGeneration(attempt || null);
  if (providerGeneration === null) {
    if (
      attempt?.state === "unusable" &&
      [
        "KB_ATTACHMENT_IDENTITY_CONFLICT",
        "KB_ATTACHMENT_BYTES_CONFLICT",
      ].includes(String(attempt.code || ""))
    ) {
      throw attachmentIntegrityError(
        `FrontMind 附件“${input.source.filename}”的 Provider 身份证明与冻结源不一致（${attempt.code}）`,
      );
    }
    if (attempt?.state === "unusable") {
      throw attachmentLifecycleExhaustedError(
        `FrontMind 附件“${input.source.filename}”两次失效，当前构建已局部隔离`,
      );
    }
    throw localPreparationError(
      `FrontMind 附件“${input.source.filename}”没有可继续使用的 Provider 文件创建权限`,
    );
  }
  const creating = retryingPutSameCandidate
    ? attempt!
    : retryingCreateSameGeneration
      ? attempt!
      : attachmentAttempt({
          ...input,
          providerGeneration,
          state: "creating",
          rejectionCount: attempt?.rejectionCount,
        });
  if (!retryingCreateSameGeneration && !retryingPutSameCandidate) {
    await persistAttempt({ claim: input.claim, attempt: creating });
  }
  let currentAttempt = creating;
  const candidateFor = (
    file: ManusV2CreatedFile,
    state: KnowledgeBaseManusV2AttachmentAttempt["state"],
    code?: string | null,
  ) =>
    attachmentAttempt({
      ...input,
      providerGeneration,
      state,
      file,
      code,
    });
  let uploaded: Awaited<ReturnType<ManusV2Client["uploadFile"]>>;
  try {
    const resumedUploadUrl = retryingPutSameCandidate
      ? openUploadCapability({ claim: input.claim, attempt: currentAttempt })
      : null;
    uploaded = await input.client.uploadFile({
      filename: input.source.filename,
      bytes: input.source.bytes,
      contentType: input.source.mimeType,
      confirmationPolicy: "kb_frozen_source_advisory",
      minimumUsableSeconds: ENSURE_MINIMUM_USABLE_SECONDS,
      ...(retryingPutSameCandidate
        ? {
            existingCandidate: {
              fileId: currentAttempt.upstreamFileId!,
              filename: currentAttempt.filename,
              uploadUrl: resumedUploadUrl!,
              uploadExpiresAt: currentAttempt.uploadExpiresAt!,
              resumePutRejectionCount: currentAttempt.rejectionCount ?? 0,
            },
          }
        : {}),
      observer: {
        onCandidateCreated: async (file) => {
          currentAttempt = attachmentAttempt({
            ...input,
            providerGeneration,
            state: "candidate_created",
            file,
            uploadCapability: sealUploadCapability({
              claim: input.claim,
              mappingKey: key,
              providerGeneration,
              file,
            }),
          });
          await persistAttempt({ claim: input.claim, attempt: currentAttempt });
        },
        onPutStarted: async (file) => {
          currentAttempt = attachmentAttempt({
            ...input,
            providerGeneration,
            state: "put_sending",
            file,
            rejectionCount: currentAttempt.rejectionCount,
            uploadCapability: currentAttempt.uploadCapability ?? null,
          });
          await persistAttempt({ claim: input.claim, attempt: currentAttempt });
        },
        onPutRetryWait: async (file, rejection) => {
          currentAttempt = attachmentAttempt({
            ...input,
            providerGeneration,
            state: "put_retry_wait",
            file,
            code: `MANUS_V2_FILE_PUT_${rejection.code}`.slice(0, 128),
            rejectionCount: rejection.rejectionCount,
            nextRetryAt: rejection.nextRetryAt,
            uploadCapability: currentAttempt.uploadCapability ?? null,
          });
          await persistAttempt({ claim: input.claim, attempt: currentAttempt });
        },
        onPutAccepted: async (file) => {
          currentAttempt = candidateFor(file, "put_accepted");
          await persistAttempt({ claim: input.claim, attempt: currentAttempt });
        },
        onPutRejected: async (file, rejection) => {
          currentAttempt = candidateFor(
            file,
            "unusable",
            `MANUS_V2_FILE_PUT_${rejection.code}`.slice(0, 128),
          );
          await persistAttempt({ claim: input.claim, attempt: currentAttempt });
        },
        onPutOutcomeUnknown: async (file) => {
          currentAttempt = candidateFor(
            file,
            "put_outcome_unknown",
            "MANUS_V2_FILE_PUT_OUTCOME_UNKNOWN",
          );
          await persistAttempt({ claim: input.claim, attempt: currentAttempt });
        },
      },
    });
  } catch (error) {
    // createFile may fail before the observer receives a provider id. The
    // precommitted creating fence is intentionally terminal for automatic
    // recreation: without a provider lookup contract absence is unprovable.
    if (currentAttempt.state === "creating") {
      const explicitCreateRejection =
        error instanceof ManusV2ApiError &&
        error.operation === "file.upload" &&
        !error.outcomeUnknown;
      const previousRejectionCount = Number.isSafeInteger(
        currentAttempt.rejectionCount,
      )
        ? Number(currentAttempt.rejectionCount)
        : 0;
      const nextRejectionCount = previousRejectionCount + 1;
      const retryableCreateRejection =
        explicitCreateRejection &&
        error instanceof ManusV2ApiError &&
        error.retryable &&
        nextRejectionCount <= MAX_EXPLICIT_FILE_REJECTION_RETRIES;
      const retryDelayMs =
        retryableCreateRejection && error instanceof ManusV2ApiError
          ? knowledgeBaseManusV2FileRejectionRetryDelay({
              mappingKey: key,
              rejectionCount: nextRejectionCount,
              providerRetryAfterMs: error.retryAfterMs,
            })
          : null;
      const settled = attachmentAttempt({
        ...input,
        providerGeneration,
        state: retryableCreateRejection
          ? "create_retry_wait"
          : explicitCreateRejection
            ? "create_rejected"
            : "create_outcome_unknown",
        code:
          error instanceof ManusV2ApiError
            ? `MANUS_V2_FILE_CREATE_${error.code}`.slice(0, 128)
            : "MANUS_V2_FILE_CREATE_OUTCOME_UNKNOWN",
        rejectionCount: explicitCreateRejection
          ? nextRejectionCount
          : undefined,
        nextRetryAt:
          retryDelayMs === null
            ? undefined
            : new Date(Date.now() + retryDelayMs).toISOString(),
      });
      await persistAttempt({ claim: input.claim, attempt: settled });
      if (retryableCreateRejection && retryDelayMs !== null) {
        throw new KnowledgeBaseAttachmentsProcessingError(
          0,
          1,
          Math.max(250, retryDelayMs),
          settled.code || undefined,
        );
      }
      if (explicitCreateRejection) {
        throw localPreparationError(
          `FrontMind 附件“${input.source.filename}”创建请求被明确拒绝`,
          error,
        );
      }
    }
    // Explicitly unusable detail after a known PUT may use the one bounded
    // replacement on the next recovery. Ambiguous/pending detail leaves the
    // same provider id intact for read-only reconciliation.
    if (
      currentAttempt.upstreamFileId &&
      currentAttempt.state !== "unusable" &&
      error instanceof ManusV2ApiError &&
      !error.outcomeUnknown &&
      !error.retryable &&
      [
        "FILE_UNUSABLE",
        "FILE_EXPIRING",
        "FILE_ID_CONFLICT",
        "FILE_IDENTITY_CONFLICT",
        "FILE_BYTES_CONFLICT",
      ].includes(error.code)
    ) {
      const integrityConflict = [
        "FILE_ID_CONFLICT",
        "FILE_IDENTITY_CONFLICT",
        "FILE_BYTES_CONFLICT",
      ].includes(error.code);
      const unusable = attachmentAttempt({
        ...input,
        providerGeneration,
        state: "unusable",
        file: {
          fileId: currentAttempt.upstreamFileId,
          filename: currentAttempt.filename,
          uploadUrl: "https://redacted.invalid/",
          uploadExpiresAt: currentAttempt.uploadExpiresAt!,
          requestId: null,
        },
        code: integrityConflict
          ? error.code === "FILE_BYTES_CONFLICT"
            ? "KB_ATTACHMENT_BYTES_CONFLICT"
            : "KB_ATTACHMENT_IDENTITY_CONFLICT"
          : "KB_ATTACHMENT_LIFECYCLE_UNUSABLE",
      });
      await persistAttempt({ claim: input.claim, attempt: unusable });
      currentAttempt = unusable;
      if (integrityConflict) {
        throw attachmentIntegrityError(
          `FrontMind 附件“${input.source.filename}”的 Provider 身份证明与冻结源不一致（${unusable.code}）`,
          error,
        );
      }
      if (providerGeneration >= 2) {
        throw attachmentLifecycleExhaustedError(
          `FrontMind 附件“${input.source.filename}”两次失效，当前构建已局部隔离`,
          error,
        );
      }
    }
    if (currentAttempt.state === "unusable") {
      throw unresolvedCandidateError({
        filename: input.source.filename,
        code: currentAttempt.code || "MANUS_V2_FILE_EXPLICITLY_UNUSABLE",
      });
    }
    throw error;
  }
  const mapping: KnowledgeBaseManusV2AttachmentMapping = {
    schemaVersion: 1,
    providerProtocol: "manus_v2",
    mappingKey: key,
    buildGeneration: input.claim.turn.buildGeneration,
    attachmentIndex: input.attachmentIndex,
    sourceFileId: input.source.sourceFileId,
    localStorageKey: input.source.localStorageKey,
    contentSha256: input.source.contentSha256,
    sizeBytes: input.source.sizeBytes,
    filename: input.source.filename,
    mimeType: input.source.mimeType,
    upstreamFileId: uploaded.fileId,
    status: "ready",
    expiresAt: uploaded.detail.expiresAt,
    providerGeneration,
    verifiedAt: new Date().toISOString(),
    mimeEvidence: providerMimeEvidence({
      filename: input.source.filename,
      expectedContentType: input.source.mimeType,
      detail: uploaded.detail,
    }),
  };
  await persistReadyMapping({ claim: input.claim, mapping });
  return mapping;
}

/**
 * Materialize a frozen operation's attachment set as Manus v2 inputs. Small,
 * server-owned Skill/Instructions bytes use the provider's inline data form;
 * every other attachment keeps the durable file mapping/recovery contract.
 * This never returns prepared/v1 ids.
 */
export async function ensureKnowledgeBaseManusV2Attachments(input: {
  claim: KnowledgeBaseRecoveryClaim;
  credential: Pick<DecryptedCredential, "id" | "userId" | "apiKey">;
  baseUrl: string;
}): Promise<KnowledgeBaseManusV2ResolvedAttachment[]> {
  const { claim } = input;
  const durable = await loadKnowledgeBaseManusV2AttachmentLedger({
    userId: claim.turn.userId,
    turnId: claim.turn.id,
    leaseToken: claim.leaseToken,
  });
  claim.turn = durable.turn;
  claim.preparedDispatch = durable.preparedDispatch;
  if (
    claim.turn.providerProtocol !== "manus_v2" ||
    claim.turn.apiCredentialId !== input.credential.id ||
    claim.turn.userId !== input.credential.userId ||
    !claim.turn.attachmentsFrozen ||
    !claim.preparedDispatch
  ) {
    throw localPreparationError(
      "FrontMind 附件映射的用户、credential 或 frozen turn 所有权不一致",
    );
  }
  const client = new ManusV2Client({
    baseUrl: input.baseUrl,
    apiKey: input.credential.apiKey,
  });
  const sources = await resolveLocalSources(claim);
  const mappings: Array<KnowledgeBaseManusV2AttachmentMapping | null> = [];
  const inlineAttachments = new Map<
    number,
    KnowledgeBaseManusV2ResolvedAttachment
  >();
  for (
    let attachmentIndex = 0;
    attachmentIndex < sources.length;
    attachmentIndex += 1
  ) {
    const source = sources[attachmentIndex]!;
    if (eligibleInlineGeneratedSource({ claim, attachmentIndex, source })) {
      inlineAttachments.set(
        attachmentIndex,
        inlineGeneratedAttachment({ source, attachmentIndex }),
      );
      mappings.push(null);
      continue;
    }
    mappings.push(
      await ensureOneMapping({
        claim,
        client,
        source,
        attachmentIndex,
      }),
    );
  }

  // Revalidate every mapping after the last upload. This prevents a long
  // multi-file operation from finalizing an early file whose expiry crossed
  // the 15-minute dispatch boundary while later files were being uploaded.
  const finalMinimumExpiry =
    Math.floor(Date.now() / 1_000) + FINAL_MINIMUM_USABLE_SECONDS;
  let finalMappings: KnowledgeBaseManusV2AttachmentMapping[] = [];
  let replacementCount = 0;
  // A final pass can discover that an early file expired while a later file
  // uploaded. Consume that slot's single bounded replacement and restart the
  // complete proof; transport-ambiguous detail never creates another file.
  for (;;) {
    finalMappings = [];
    let replaced = false;
    for (
      let attachmentIndex = 0;
      attachmentIndex < mappings.length;
      attachmentIndex += 1
    ) {
      const mapping = mappings[attachmentIndex];
      if (!mapping) continue;
      const source = sources[attachmentIndex]!;
      const durableAttempt = existingAttempt({
        claim,
        attachmentIndex,
        source,
      });
      const inspectionAttempt =
        durableAttempt &&
        durableAttempt.providerGeneration === mapping.providerGeneration &&
        durableAttempt.upstreamFileId === mapping.upstreamFileId
          ? durableAttempt
          : attachmentAttempt({
              claim,
              attachmentIndex,
              source,
              providerGeneration: mapping.providerGeneration,
              state: "put_accepted",
              file: {
                fileId: mapping.upstreamFileId,
                filename: mapping.filename,
                uploadUrl: "https://redacted.invalid/",
                uploadExpiresAt: mapping.expiresAt,
                requestId: null,
              },
            });
      const inspection = await inspectCandidate({
        client,
        attempt: inspectionAttempt,
        minimumExpirySeconds: finalMinimumExpiry,
      });
      const action = finalKnowledgeBaseManusV2AttachmentInspectionAction({
        inspection,
        providerGeneration: mapping.providerGeneration,
      });
      if (action === "wait") {
        throw unresolvedCandidateError({
          filename: mapping.filename,
          code:
            inspection.state === "unresolved"
              ? inspection.code
              : "MANUS_V2_FILE_DETAIL_UNRESOLVED",
        });
      }
      if (action === "isolate") {
        throw attachmentLifecycleExhaustedError(
          `FrontMind 附件“${mapping.filename}”两次失效，当前构建已局部隔离`,
        );
      }
      if (action === "reject") {
        if (
          inspection.state === "integrity_conflict" &&
          durableAttempt?.state !== "unusable"
        ) {
          await persistAttempt({
            claim,
            attempt: attachmentAttempt({
              claim,
              attachmentIndex,
              source,
              providerGeneration: mapping.providerGeneration,
              state: "unusable",
              file: {
                fileId: mapping.upstreamFileId,
                filename: mapping.filename,
                uploadUrl: "https://redacted.invalid/",
                uploadExpiresAt: mapping.expiresAt,
                requestId: null,
              },
              code: inspection.code,
              mimeEvidence: inspection.mimeEvidence,
            }),
          });
        }
        throw attachmentIntegrityError(
          `FrontMind 附件“${mapping.filename}”的 Provider 身份证明与冻结源不一致（${
            inspection.state === "integrity_conflict"
              ? inspection.code
              : "KB_ATTACHMENT_IDENTITY_CONFLICT"
          }）`,
        );
      }
      if (action === "replace") {
        if (inspection.state !== "replaceable_unusable") {
          throw localPreparationError("FrontMind 附件最终复核状态无效");
        }
        if (durableAttempt?.state !== "unusable") {
          await persistAttempt({
            claim,
            attempt: attachmentAttempt({
              claim,
              attachmentIndex,
              source,
              providerGeneration: mapping.providerGeneration,
              state: "unusable",
              file: {
                fileId: mapping.upstreamFileId,
                filename: mapping.filename,
                uploadUrl: "https://redacted.invalid/",
                uploadExpiresAt: mapping.expiresAt,
                requestId: null,
              },
              code: inspection.code,
              mimeEvidence: inspection.mimeEvidence,
            }),
          });
        }
        replacementCount += 1;
        if (replacementCount > sources.length) {
          throw attachmentLifecycleExhaustedError(
            "FrontMind 附件最终复核超出有界替换次数",
          );
        }
        mappings[attachmentIndex] = await ensureOneMapping({
          claim,
          client,
          source,
          attachmentIndex,
        });
        replaced = true;
        break;
      }
      if (inspection.state !== "ready") {
        throw localPreparationError("FrontMind 附件最终复核状态无效");
      }
      const refreshed = {
        ...mapping,
        expiresAt: inspection.detail.expiresAt,
        verifiedAt: new Date().toISOString(),
        mimeEvidence: inspection.mimeEvidence,
      };
      await persistReadyMapping({ claim, mapping: refreshed });
      mappings[attachmentIndex] = refreshed;
      finalMappings.push(refreshed);
    }
    if (!replaced) break;
  }
  await renewKnowledgeBaseTurnLease({
    userId: claim.turn.userId,
    turnId: claim.turn.id,
    leaseToken: claim.leaseToken,
  });
  if (inlineAttachments.size === 0) {
    const finalized = await finalizeKnowledgeBaseManusV2AttachmentMappings({
      userId: claim.turn.userId,
      turnId: claim.turn.id,
      leaseToken: claim.leaseToken,
      mappings: finalMappings,
      minimumUsableSeconds: FINAL_MINIMUM_USABLE_SECONDS,
    });
    claim.turn.attachmentFileIds = [...finalized.attachmentFileIds];
    claim.turn.manusV2AttachmentMappings = {
      ...finalized.manusV2AttachmentMappings,
    };
  } else {
    // Inline delivery is a provider request representation, not a rewrite of
    // the frozen Dashboard source ledger. Every non-inline slot still has the
    // same ready mapping proof; the create/send at-most-once fence is consumed
    // only after the complete mixed body hash is computed by the caller.
    const expectedReady = sources.length - inlineAttachments.size;
    if (finalMappings.length !== expectedReady) {
      throw localPreparationError(
        "FrontMind 内联系统附件混排缺少其余附件的完整可用性证明",
      );
    }
  }
  const readyByIndex = new Map(
    finalMappings.map((mapping) => [mapping.attachmentIndex, mapping]),
  );
  return sources.map((source, attachmentIndex) => {
    const inline = inlineAttachments.get(attachmentIndex);
    if (inline) return inline;
    const mapping = readyByIndex.get(attachmentIndex);
    if (!mapping) {
      throw localPreparationError("FrontMind 附件最终映射缺失");
    }
    return {
      file_id: mapping.upstreamFileId,
      filename: mapping.filename,
    };
  });
}
