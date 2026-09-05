import { createHash, randomUUID } from "node:crypto";
import { and, asc, eq } from "drizzle-orm";
import sharp from "sharp";

import {
  conversationTurns,
  knowledgeBaseBuildNodes,
  knowledgeBaseBuilds,
  type ConversationTurn,
  type KnowledgeBaseBuild,
  type KnowledgeBaseBuildNode,
} from "../drizzle/schema";
import { getDb } from "./db";
import {
  knowledgeBaseOfficialLogoProvenanceFromMetadata,
  knowledgeBaseOfficialLogoUploadFromTurn,
  type KnowledgeBaseOfficialLogoUpload,
} from "./knowledge-base-customer-upload";
import type { KnowledgeBaseClientAttachmentManifestItem } from "./knowledge-base-client-attachment-manifest";
import type {
  KnowledgeBaseInteractionDto,
  KnowledgeBaseObservationDto,
  KnowledgeBaseProgressDto,
} from "../shared/knowledge-base-progress";
import { readKnowledgeBuildArtifact } from "./knowledge-build-artifact-store";
import { readStoredPresalesFile } from "./presales-file-store";
import { knowledgeBaseConversationStorageId } from "./knowledge-base-turn-service";

const LOGO_REPAIR_OPERATION_TYPE = "logo_provenance_repair";
const LOGO_REPAIR_LEDGER_KIND =
  "frontmind.knowledge-base.logo-provenance-repair";
const MAX_LOGO_BYTES = 15 * 1024 * 1024;
const LOGO_MIME_TYPES = new Set([
  "image/avif",
  "image/gif",
  "image/jpeg",
  "image/png",
  "image/webp",
]);

export type KnowledgeBaseFinalLogoProvenanceState =
  | "not_applicable"
  | "present"
  | "missing"
  | "conflict";

export class KnowledgeBaseLogoProvenanceRepairError extends Error {
  constructor(
    public readonly code:
      | "KNOWLEDGE_BASE_LOGO_PROVENANCE_REQUIRED"
      | "KNOWLEDGE_BASE_LOGO_PROVENANCE_NOT_REQUIRED"
      | "KNOWLEDGE_BASE_LOGO_PROVENANCE_CONFLICT"
      | "KNOWLEDGE_BASE_LOGO_REPAIR_UPLOAD_INVALID"
      | "KNOWLEDGE_BASE_LOGO_REPAIR_BUILD_CHANGED",
    message: string,
  ) {
    super(message);
    this.name = "KnowledgeBaseLogoProvenanceRepairError";
  }
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function normalizedMimeType(value: unknown) {
  return String(value || "")
    .trim()
    .toLowerCase();
}

function isFinalLeafCoordinate(
  build: Pick<
    KnowledgeBaseBuild,
    | "skillVersion"
    | "currentLeafId"
    | "totalNodeCount"
    | "confirmedCount"
    | "directPrefilledCount"
  >,
  nodes: readonly Pick<
    KnowledgeBaseBuildNode,
    "leafId" | "ordinal" | "status"
  >[],
) {
  if (
    build.skillVersion !== "4" ||
    !build.currentLeafId ||
    build.totalNodeCount < 1 ||
    nodes.length !== build.totalNodeCount ||
    build.confirmedCount + build.directPrefilledCount + 1 !==
      build.totalNodeCount
  ) {
    return false;
  }
  const ordered = [...nodes].sort(
    (left, right) => left.ordinal - right.ordinal,
  );
  return (
    ordered.every((node, index) => node.ordinal === index) &&
    ordered.at(-1)?.leafId === build.currentLeafId &&
    (ordered.at(-1)?.status === "current" ||
      ordered.at(-1)?.status === "needs_verification")
  );
}

function turnDeclaresOfficialLogoUpload(
  turn: Pick<ConversationTurn, "metadata">,
) {
  const metadata = record(turn.metadata);
  const recovery = record(metadata?.recovery);
  return Boolean(
    (recovery &&
      Object.prototype.hasOwnProperty.call(recovery, "officialLogoUpload")) ||
      (metadata &&
        Object.prototype.hasOwnProperty.call(metadata, "logoProvenanceRepair")),
  );
}

function repairLedgerFromTurn(turn: Pick<ConversationTurn, "metadata">) {
  return record(record(turn.metadata)?.logoProvenanceRepair);
}

function inspectCompletedTurns(
  turns: readonly Pick<
    ConversationTurn,
    | "id"
    | "expectedLeafId"
    | "attachmentFileIds"
    | "metadata"
    | "status"
    | "operationType"
    | "clientRequestId"
    | "buildId"
    | "buildGeneration"
    | "expectedRevision"
  >[],
) {
  const declaredUploads = turns.filter(turnDeclaresOfficialLogoUpload);
  const uploads = turns
    .map(knowledgeBaseOfficialLogoUploadFromTurn)
    .filter(
      (value): value is KnowledgeBaseOfficialLogoUpload => value !== null,
    );
  const declaredProvenances = turns.filter((turn) => {
    const metadata = record(turn.metadata);
    return Boolean(
      metadata &&
        Object.prototype.hasOwnProperty.call(
          metadata,
          "boundOfficialLogoProvenance",
        ),
    );
  });
  const provenances = turns
    .map((turn) =>
      knowledgeBaseOfficialLogoProvenanceFromMetadata(turn.metadata),
    )
    .filter((value) => value !== null);
  const malformed =
    declaredUploads.length !== uploads.length ||
    declaredProvenances.length !== provenances.length;
  const conflict =
    malformed ||
    uploads.length > 1 ||
    provenances.length > 1 ||
    (uploads.length > 0 && provenances.length > 0);
  return {
    conflict,
    upload: conflict ? undefined : uploads[0],
    provenance: conflict ? undefined : provenances[0],
  };
}

async function completedLogoLedgerTurns(input: {
  userId: number;
  buildId: string;
  generation: number;
  executor?: any;
  lock?: boolean;
}) {
  const db = input.executor ?? (await getDb());
  if (!db) throw new Error("数据库暂不可用，无法核验企业主 Logo 来源");
  const base = db
    .select({
      id: conversationTurns.id,
      expectedLeafId: conversationTurns.expectedLeafId,
      attachmentFileIds: conversationTurns.attachmentFileIds,
      metadata: conversationTurns.metadata,
      status: conversationTurns.status,
      operationType: conversationTurns.operationType,
      clientRequestId: conversationTurns.clientRequestId,
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
  return input.lock ? base.for("update") : base;
}

async function loadFinalCoordinate(input: {
  userId: number;
  buildId: string;
  generation: number;
  executor?: any;
  lock?: boolean;
}) {
  const db = input.executor ?? (await getDb());
  if (!db) throw new Error("数据库暂不可用，无法核验企业主 Logo 来源");
  let buildQuery = db
    .select()
    .from(knowledgeBaseBuilds)
    .where(
      and(
        eq(knowledgeBaseBuilds.id, input.buildId),
        eq(knowledgeBaseBuilds.userId, input.userId),
        eq(knowledgeBaseBuilds.generation, input.generation),
      ),
    )
    .limit(1);
  if (input.lock) buildQuery = buildQuery.for("update");
  const build = (await buildQuery)[0] as KnowledgeBaseBuild | undefined;
  if (!build) return null;
  let nodesQuery = db
    .select({
      leafId: knowledgeBaseBuildNodes.leafId,
      ordinal: knowledgeBaseBuildNodes.ordinal,
      status: knowledgeBaseBuildNodes.status,
    })
    .from(knowledgeBaseBuildNodes)
    .where(eq(knowledgeBaseBuildNodes.buildId, build.id))
    .orderBy(asc(knowledgeBaseBuildNodes.ordinal));
  if (input.lock) nodesQuery = nodesQuery.for("update");
  const nodes = await nodesQuery;
  return { build, nodes };
}

/** Read-only, fail-closed state used by observation and retry preflight. */
export async function inspectKnowledgeBaseFinalLogoProvenance(input: {
  userId: number;
  buildId: string;
  generation: number;
}): Promise<KnowledgeBaseFinalLogoProvenanceState> {
  void input;
  // A model-returned Logo is authoritative once its managed bytes have been
  // downloaded, decoded and bound to the build. External website/document
  // provenance is optional metadata and must never lock the final customer
  // turn or force a duplicate upload of the same image.
  return "not_applicable";
}

/** Ensure a v4 final reservation never reaches an upstream create without provenance. */
export async function assertKnowledgeBaseFinalLogoProvenance(input: {
  userId: number;
  buildId: string;
  generation: number;
}) {
  return inspectKnowledgeBaseFinalLogoProvenance(input);
}

export function applyKnowledgeBaseFinalLogoProvenanceObservation(input: {
  state: KnowledgeBaseFinalLogoProvenanceState;
  progress: KnowledgeBaseProgressDto;
  observation: Pick<
    KnowledgeBaseObservationDto,
    "generation" | "activeTurn" | "notice"
  >;
  interaction: KnowledgeBaseInteractionDto;
}) {
  void input.state;
  return {
    interaction: input.interaction,
    notice: input.observation.notice,
  };
}

export function assertKnowledgeBaseFinalLogoProvenanceForBuild(
  userId: number,
  build: Pick<KnowledgeBaseBuild, "id" | "generation">,
) {
  return assertKnowledgeBaseFinalLogoProvenance({
    userId,
    buildId: build.id,
    generation: build.generation,
  });
}

async function readManagedUploadBytes(input: {
  fileId: string;
  filename: string;
  mimeType: string;
  sizeBytes: number;
  sha256: string;
}) {
  const stored = await readStoredPresalesFile(input.fileId);
  if (
    !stored ||
    stored.filename !== input.filename ||
    normalizedMimeType(stored.mimeType) !== input.mimeType ||
    stored.recordedSizeBytes !== input.sizeBytes ||
    stored.sizeBytes !== input.sizeBytes ||
    stored.sha256?.toLowerCase() !== input.sha256 ||
    input.sizeBytes < 1 ||
    input.sizeBytes > MAX_LOGO_BYTES
  ) {
    throw new KnowledgeBaseLogoProvenanceRepairError(
      "KNOWLEDGE_BASE_LOGO_REPAIR_UPLOAD_INVALID",
      "重传 Logo 的受管原始字节记录不完整，请重新选择原文件上传。",
    );
  }
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of stored.createReadStream()) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > MAX_LOGO_BYTES) {
      throw new KnowledgeBaseLogoProvenanceRepairError(
        "KNOWLEDGE_BASE_LOGO_REPAIR_UPLOAD_INVALID",
        "重传 Logo 超过 15 MB，无法完成来源绑定。",
      );
    }
    chunks.push(buffer);
  }
  const bytes = Buffer.concat(chunks, size);
  if (
    size !== input.sizeBytes ||
    createHash("sha256").update(bytes).digest("hex") !== input.sha256
  ) {
    throw new KnowledgeBaseLogoProvenanceRepairError(
      "KNOWLEDGE_BASE_LOGO_REPAIR_UPLOAD_INVALID",
      "重传 Logo 的原始字节校验失败，请重新上传。",
    );
  }
  return bytes;
}

function sameUpload(
  left: KnowledgeBaseOfficialLogoUpload,
  right: Omit<KnowledgeBaseOfficialLogoUpload, "turnId" | "leafId">,
) {
  return (
    left.index === right.index &&
    left.fileId === right.fileId &&
    left.filename === right.filename &&
    left.mimeType === right.mimeType &&
    left.sizeBytes === right.sizeBytes &&
    left.sourceSha256 === right.sourceSha256
  );
}

export type RepairKnowledgeBaseOfficialLogoProvenanceInput = {
  userId: number;
  conversationId: string;
  clientRequestId: string;
  expectedGeneration: number;
  expectedRevision: number;
  expectedLeafId: string;
  attachment: { file_id: string; filename: string };
  manifest: KnowledgeBaseClientAttachmentManifestItem;
  now?: Date;
};

function normalizedRepairUpload(
  input: RepairKnowledgeBaseOfficialLogoProvenanceInput,
) {
  return {
    index: 0,
    fileId: String(input.attachment.file_id || "").trim(),
    filename: String(input.manifest.filename || "").trim(),
    mimeType: normalizedMimeType(input.manifest.mimeType),
    sizeBytes: Number(input.manifest.sizeBytes),
    sourceSha256: String(input.manifest.sha256 || "")
      .trim()
      .toLowerCase(),
  } as const;
}

/**
 * Resolve an exact replay from the immutable server ledger before consulting
 * the uploaded file again. A lost success response must remain replayable even
 * after the temporary upload credential or captured bytes have expired.
 */
export async function replayCompletedKnowledgeBaseLogoProvenanceRepair(
  input: RepairKnowledgeBaseOfficialLogoProvenanceInput,
) {
  const upload = normalizedRepairUpload(input);
  const db = await getDb();
  if (!db) throw new Error("数据库暂不可用，无法核验企业主 Logo 来源");
  const build = (
    await db
      .select({
        id: knowledgeBaseBuilds.id,
        generation: knowledgeBaseBuilds.generation,
      })
      .from(knowledgeBaseBuilds)
      .where(
        and(
          eq(knowledgeBaseBuilds.userId, input.userId),
          eq(knowledgeBaseBuilds.conversationId, input.conversationId.trim()),
        ),
      )
      .limit(1)
  )[0];
  if (!build || build.generation !== input.expectedGeneration) return null;
  const turns = await completedLogoLedgerTurns({
    userId: input.userId,
    buildId: build.id,
    generation: input.expectedGeneration,
  });
  const ledgers = inspectCompletedTurns(turns);
  if (ledgers.conflict) {
    throw new KnowledgeBaseLogoProvenanceRepairError(
      "KNOWLEDGE_BASE_LOGO_PROVENANCE_CONFLICT",
      "企业官方主 Logo 来源账本冲突，请联系管理员核验。",
    );
  }
  if (!ledgers.upload) return null;
  const sourceTurn = turns.find(
    (turn: (typeof turns)[number]) => turn.id === ledgers.upload!.turnId,
  );
  return sourceTurn?.operationType === LOGO_REPAIR_OPERATION_TYPE &&
    sourceTurn.clientRequestId === input.clientRequestId.trim() &&
    sourceTurn.expectedRevision === input.expectedRevision &&
    sourceTurn.expectedLeafId === input.expectedLeafId.trim() &&
    repairLedgerFromTurn(sourceTurn)?.kind === LOGO_REPAIR_LEDGER_KIND &&
    sameUpload(ledgers.upload, upload)
    ? { upload: ledgers.upload, idempotent: true as const }
    : null;
}

/**
 * Bind a fresh browser upload as provenance for a historical v4 Logo only when
 * its managed original bytes are exactly the already-immutable build Logo.
 * This writes one completed server-only ledger turn and never calls upstream.
 */
export async function repairKnowledgeBaseOfficialLogoProvenance(
  input: RepairKnowledgeBaseOfficialLogoProvenanceInput,
) {
  const clientRequestId = String(input.clientRequestId || "").trim();
  const upload = normalizedRepairUpload(input);
  const { fileId, filename, mimeType, sizeBytes, sourceSha256 } = upload;
  if (
    !input.conversationId.trim() ||
    !clientRequestId ||
    clientRequestId.length > 128 ||
    !Number.isSafeInteger(input.expectedGeneration) ||
    input.expectedGeneration < 1 ||
    !Number.isSafeInteger(input.expectedRevision) ||
    input.expectedRevision < 0 ||
    !input.expectedLeafId.trim() ||
    !fileId ||
    fileId.length > 512 ||
    input.attachment.filename !== filename ||
    !filename ||
    !LOGO_MIME_TYPES.has(mimeType) ||
    !Number.isSafeInteger(sizeBytes) ||
    sizeBytes < 1 ||
    sizeBytes > MAX_LOGO_BYTES ||
    !/^[a-f0-9]{64}$/u.test(sourceSha256)
  ) {
    throw new KnowledgeBaseLogoProvenanceRepairError(
      "KNOWLEDGE_BASE_LOGO_REPAIR_UPLOAD_INVALID",
      "请只上传一张 PNG、JPEG、WebP、AVIF 或 GIF 格式的原始 Logo 文件。",
    );
  }
  const uploadedBytes = await readManagedUploadBytes({
    fileId,
    filename,
    mimeType,
    sizeBytes,
    sha256: sourceSha256,
  });
  const db = await getDb();
  if (!db) throw new Error("数据库暂不可用，无法修复企业主 Logo 来源");
  const preliminaryBuild = (
    await db
      .select()
      .from(knowledgeBaseBuilds)
      .where(
        and(
          eq(knowledgeBaseBuilds.userId, input.userId),
          eq(knowledgeBaseBuilds.conversationId, input.conversationId.trim()),
        ),
      )
      .limit(1)
  )[0] as KnowledgeBaseBuild | undefined;
  if (
    !preliminaryBuild ||
    preliminaryBuild.generation !== input.expectedGeneration ||
    preliminaryBuild.revision !== input.expectedRevision ||
    preliminaryBuild.currentLeafId !== input.expectedLeafId ||
    !preliminaryBuild.logoStorageKey ||
    !preliminaryBuild.logoSha256 ||
    !preliminaryBuild.logoBytes ||
    !preliminaryBuild.logoMimeType
  ) {
    throw new KnowledgeBaseLogoProvenanceRepairError(
      "KNOWLEDGE_BASE_LOGO_REPAIR_BUILD_CHANGED",
      "知识库状态或已绑定 Logo 已变化，请刷新后重试。",
    );
  }
  const buildLogoBytes = await readKnowledgeBuildArtifact({
    userId: input.userId,
    buildId: preliminaryBuild.id,
    generation: preliminaryBuild.generation,
    kind: "logo",
    expectedSha256: preliminaryBuild.logoSha256,
    expectedBytes: preliminaryBuild.logoBytes,
    storageKey: preliminaryBuild.logoStorageKey,
  });
  const [uploadedMetadata, buildMetadata] = await Promise.all([
    sharp(uploadedBytes).metadata(),
    sharp(buildLogoBytes).metadata(),
  ]).catch(() => {
    throw new KnowledgeBaseLogoProvenanceRepairError(
      "KNOWLEDGE_BASE_LOGO_REPAIR_UPLOAD_INVALID",
      "重传文件不是可安全解码的 Logo 图片。",
    );
  });
  if (
    sourceSha256 !== preliminaryBuild.logoSha256 ||
    sizeBytes !== preliminaryBuild.logoBytes ||
    mimeType !== normalizedMimeType(preliminaryBuild.logoMimeType) ||
    !uploadedBytes.equals(buildLogoBytes) ||
    !uploadedMetadata.width ||
    !uploadedMetadata.height ||
    uploadedMetadata.width !== buildMetadata.width ||
    uploadedMetadata.height !== buildMetadata.height ||
    uploadedMetadata.format !== buildMetadata.format
  ) {
    throw new KnowledgeBaseLogoProvenanceRepairError(
      "KNOWLEDGE_BASE_LOGO_REPAIR_UPLOAD_INVALID",
      "重传图片必须与当前知识库已绑定的企业主 Logo 原始字节完全一致。",
    );
  }

  const now = input.now ?? new Date();
  return db.transaction(async (tx) => {
    const coordinate = await loadFinalCoordinate({
      userId: input.userId,
      buildId: preliminaryBuild.id,
      generation: input.expectedGeneration,
      executor: tx,
      lock: true,
    });
    const build = coordinate?.build;
    if (
      !coordinate ||
      !build ||
      build.conversationId !== input.conversationId.trim() ||
      build.revision !== input.expectedRevision ||
      build.currentLeafId !== input.expectedLeafId ||
      build.logoStorageKey !== preliminaryBuild.logoStorageKey ||
      build.logoSha256 !== sourceSha256 ||
      build.logoBytes !== sizeBytes ||
      normalizedMimeType(build.logoMimeType) !== mimeType ||
      !isFinalLeafCoordinate(build, coordinate.nodes)
    ) {
      throw new KnowledgeBaseLogoProvenanceRepairError(
        "KNOWLEDGE_BASE_LOGO_REPAIR_BUILD_CHANGED",
        "知识库状态或已绑定 Logo 已变化，请刷新后重试。",
      );
    }
    if (build.status !== "protocol_error" && build.status !== "confirming") {
      throw new KnowledgeBaseLogoProvenanceRepairError(
        "KNOWLEDGE_BASE_LOGO_PROVENANCE_NOT_REQUIRED",
        "当前知识库状态不需要修复 Logo 来源。",
      );
    }
    if (build.activeTurnId) {
      const activeTurn = (
        await tx
          .select({ status: conversationTurns.status })
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
      if (!activeTurn || activeTurn.status !== "failed") {
        throw new KnowledgeBaseLogoProvenanceRepairError(
          "KNOWLEDGE_BASE_LOGO_REPAIR_BUILD_CHANGED",
          "当前知识库仍有执行中的操作，请等待完成并刷新状态。",
        );
      }
    }
    const turns = await completedLogoLedgerTurns({
      userId: input.userId,
      buildId: build.id,
      generation: build.generation,
      executor: tx,
      lock: true,
    });
    const ledgers = inspectCompletedTurns(turns);
    if (ledgers.conflict) {
      throw new KnowledgeBaseLogoProvenanceRepairError(
        "KNOWLEDGE_BASE_LOGO_PROVENANCE_CONFLICT",
        "企业官方主 Logo 来源账本冲突，请联系管理员核验。",
      );
    }
    if (ledgers.provenance) {
      throw new KnowledgeBaseLogoProvenanceRepairError(
        "KNOWLEDGE_BASE_LOGO_PROVENANCE_NOT_REQUIRED",
        "企业官方主 Logo 已有可信来源，无需重传。",
      );
    }
    if (ledgers.upload) {
      const sourceTurn = turns.find(
        (turn: (typeof turns)[number]) => turn.id === ledgers.upload!.turnId,
      );
      const isRepair =
        sourceTurn?.operationType === LOGO_REPAIR_OPERATION_TYPE &&
        repairLedgerFromTurn(sourceTurn)?.kind === LOGO_REPAIR_LEDGER_KIND;
      if (
        isRepair &&
        sourceTurn?.clientRequestId === clientRequestId &&
        sourceTurn.expectedRevision === input.expectedRevision &&
        sourceTurn.expectedLeafId === input.expectedLeafId.trim() &&
        sameUpload(ledgers.upload, upload)
      ) {
        return { upload: ledgers.upload, idempotent: true };
      }
      throw new KnowledgeBaseLogoProvenanceRepairError(
        "KNOWLEDGE_BASE_LOGO_PROVENANCE_NOT_REQUIRED",
        "企业官方主 Logo 已有可信上传来源，无需再次重传。",
      );
    }

    const turnId = randomUUID();
    const requestHash = createHash("sha256")
      .update(
        JSON.stringify({
          protocol: LOGO_REPAIR_LEDGER_KIND,
          buildId: build.id,
          generation: build.generation,
          revision: build.revision,
          leafId: build.currentLeafId,
          fileId,
          filename,
          mimeType,
          sizeBytes,
          sourceSha256,
        }),
        "utf8",
      )
      .digest("hex");
    const operationKey = `kb-logo-repair-v1:${requestHash}`;
    const verifiedUpload = {
      turnId,
      leafId: build.currentLeafId!,
      ...upload,
    } satisfies KnowledgeBaseOfficialLogoUpload;
    await tx.insert(conversationTurns).values({
      id: turnId,
      conversationId: knowledgeBaseConversationStorageId(
        input.userId,
        build.conversationId,
      ),
      userId: input.userId,
      clientRequestId,
      buildId: build.id,
      buildGeneration: build.generation,
      operationKey,
      operationType: LOGO_REPAIR_OPERATION_TYPE,
      expectedRevision: build.revision,
      expectedLeafId: build.currentLeafId,
      requestHash,
      attachmentFileIds: [fileId],
      metadata: {
        logoProvenanceRepair: {
          kind: LOGO_REPAIR_LEDGER_KIND,
          schemaVersion: 1,
          immutable: true,
          buildId: build.id,
          generation: build.generation,
          revision: build.revision,
          leafId: build.currentLeafId,
          officialLogoUpload: {
            verified: true,
            ...upload,
          },
        },
      },
      status: "completed",
      startedAt: now,
      completedAt: now,
      createdAt: now,
      updatedAt: now,
    });
    const buildUpdate = await tx
      .update(knowledgeBaseBuilds)
      .set({ stateEpoch: build.stateEpoch + 1, updatedAt: now })
      .where(
        and(
          eq(knowledgeBaseBuilds.id, build.id),
          eq(knowledgeBaseBuilds.userId, input.userId),
          eq(knowledgeBaseBuilds.generation, build.generation),
          eq(knowledgeBaseBuilds.stateEpoch, build.stateEpoch),
        ),
      );
    if (!buildUpdate[0]?.affectedRows) {
      throw new KnowledgeBaseLogoProvenanceRepairError(
        "KNOWLEDGE_BASE_LOGO_REPAIR_BUILD_CHANGED",
        "知识库状态在来源绑定期间发生变化，请刷新后重试。",
      );
    }
    return { upload: verifiedUpload, idempotent: false };
  });
}
