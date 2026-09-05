import { createHash, randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { z } from "zod";

import {
  knowledgeImportReceipts,
  websiteUserProvisions,
} from "../drizzle/schema";
import {
  assertKnowledgeArchiveEnterpriseIdentity,
  readKnowledgeArchive,
  removeStoredKnowledgeAssets,
} from "./dashboard-api";
import {
  createKnowledgeSnapshot,
  getDashboardWorkspace,
  getKnowledgeSnapshotById,
} from "./dashboard-service";
import { createKnowledgeMonitoringHandoff } from "./delivery-role-service";
import { assertKnowledgeBaseWritable } from "./knowledge-base-reset-service";
import { getDb } from "./db";
import {
  assertServiceCapability,
  ServiceEntitlementError,
} from "./service-entitlement";
import {
  persistKnowledgeSnapshotArchive,
  removeKnowledgeSnapshotArchive,
} from "./knowledge-snapshot-archive-store";
import { readPresalesV2Artifact } from "./presales-v2-store";
import { readStoredPresalesFile } from "./presales-file-store";
import {
  canonicalizeWebsiteKnowledgeImportArchive,
  projectWebsiteKnowledgeImportArchiveV4,
} from "./website-knowledge-import-archive-adapter";
import {
  lockActiveWebsiteProjectLifecycle,
  WebsiteProjectInactiveError,
} from "./website-project-lifecycle";

const sha256Schema = z
  .string()
  .trim()
  .regex(/^[a-f0-9]{64}$/i);

const localArtifactIdentitySchema = z
  .string()
  .regex(/^artifact_[a-f0-9]{64}$/u)
  .refine((value) => value === value.trim(), {
    message: "opaque identity must not contain leading or trailing whitespace",
  });

export const websiteKnowledgeImportSchema = z
  .object({
    schemaVersion: z.literal(5),
    companyName: z.string().trim().min(1).max(200),
    candidateArtifactId: localArtifactIdentitySchema,
    finalArtifactId: localArtifactIdentitySchema,
    candidateSha256: sha256Schema,
    finalSha256: sha256Schema,
    packageManifestSha256: sha256Schema,
    finalizerVersion: z.literal("website-kb-finalizer-v1"),
  })
  .strict();

export type WebsiteKnowledgeImport = z.infer<
  typeof websiteKnowledgeImportSchema
>;

export type KnowledgeImportErrorCode =
  | "PROJECT_NOT_PROVISIONED"
  | "PROJECT_OWNER_CONFLICT"
  | "PROJECT_ENTERPRISE_CONFLICT"
  | "PROJECT_ENTERPRISE_MISMATCH"
  | "TASK_PROJECT_MISMATCH"
  | "TASK_NOT_COMPLETED"
  | "ARTIFACT_DESCRIPTOR_MISMATCH"
  | "ARTIFACT_HASH_MISMATCH"
  | "IDEMPOTENCY_CONFLICT"
  | "IDEMPOTENCY_PENDING"
  | "RECEIPT_DATA_INCOMPLETE"
  | "SERVICE_NOT_WRITABLE"
  | "PROJECT_DELETED"
  | "DATABASE_UNAVAILABLE"
  | "KNOWLEDGE_IMPORT_FAILED";

export class KnowledgeImportError extends Error {
  constructor(
    public readonly code: KnowledgeImportErrorCode,
    message: string,
    public readonly status: number,
    public readonly retryAfterMs?: number,
  ) {
    super(message);
    this.name = "KnowledgeImportError";
  }
}

async function lockActiveKnowledgeImportProject(tx: any, projectId: string) {
  try {
    await lockActiveWebsiteProjectLifecycle(tx, projectId);
  } catch (error) {
    if (!(error instanceof WebsiteProjectInactiveError)) throw error;
    throw new KnowledgeImportError(
      "PROJECT_DELETED",
      "项目已被永久删除，不能再写入知识库导入回执",
      410,
    );
  }
}

function normalizedEnterpriseName(value: string) {
  return value.normalize("NFKC").trim().replace(/\s+/g, "").toLowerCase();
}

function knowledgeImportTaskId(value: WebsiteKnowledgeImport) {
  return value.candidateArtifactId;
}

function knowledgeImportOutputItemId(value: WebsiteKnowledgeImport) {
  return value.finalizerVersion;
}

function knowledgeImportReceiptFileId(value: WebsiteKnowledgeImport) {
  return value.finalArtifactId;
}

function knowledgeImportDescriptorHash(value: WebsiteKnowledgeImport) {
  return value.candidateSha256;
}

function knowledgeImportArtifactSha256(value: WebsiteKnowledgeImport) {
  return value.finalSha256;
}

function knowledgeImportFilename(value: WebsiteKnowledgeImport) {
  return "frontmind-website-knowledge-base.zip";
}

function knowledgeImportPackageManifestSha256(value: WebsiteKnowledgeImport) {
  return value.packageManifestSha256;
}

function knowledgeImportArchiveContractVersion(value: WebsiteKnowledgeImport) {
  return undefined;
}

export function resolveKnowledgeImportProjectOwner(
  provisions: Array<{
    userId: number | null;
    companyName: string;
    status: string;
  }>,
  requestedCompanyName: string,
) {
  const completed = provisions.filter(
    (provision) =>
      provision.status === "completed" &&
      Number.isInteger(provision.userId) &&
      Number(provision.userId) > 0,
  );
  if (completed.length === 0) {
    throw new KnowledgeImportError(
      "PROJECT_NOT_PROVISIONED",
      "当前官网项目尚未完成账号开通",
      409,
    );
  }
  const userIds = new Set(completed.map((provision) => provision.userId!));
  if (userIds.size !== 1) {
    throw new KnowledgeImportError(
      "PROJECT_OWNER_CONFLICT",
      "同一官网项目关联了多个用户账号，无法确定知识库归属",
      409,
    );
  }
  const enterpriseNames = new Set(
    completed.map((provision) =>
      normalizedEnterpriseName(provision.companyName),
    ),
  );
  if (enterpriseNames.size !== 1) {
    throw new KnowledgeImportError(
      "PROJECT_ENTERPRISE_CONFLICT",
      "同一官网项目包含相互冲突的企业身份，无法导入知识库",
      409,
    );
  }
  const provision = completed[0]!;
  if (
    normalizedEnterpriseName(provision.companyName) !==
    normalizedEnterpriseName(requestedCompanyName)
  ) {
    throw new KnowledgeImportError(
      "PROJECT_ENTERPRISE_MISMATCH",
      "知识库企业与官网开通企业不一致",
      409,
    );
  }
  return {
    userId: provision.userId!,
    companyName: provision.companyName,
    purchaseCount: completed.length,
  };
}

function idempotencyHash(value: string) {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

const websiteKnowledgeImportV5ReferencePrefix = "website-kb:v5";

export function knowledgeImportReceiptSourceReference(input: {
  projectId: string;
  value: WebsiteKnowledgeImport;
}) {
  return [
    websiteKnowledgeImportV5ReferencePrefix,
    input.value.finalizerVersion,
    idempotencyHash(
      [
        input.projectId,
        input.value.candidateArtifactId,
        input.value.finalArtifactId,
        input.value.candidateSha256.toLowerCase(),
        input.value.finalSha256.toLowerCase(),
        input.value.packageManifestSha256.toLowerCase(),
      ].join(":"),
    ),
  ].join(":");
}

function knowledgeArtifactReceiptDescriptorMatchesRequest(
  receipt: {
    projectId: string | null;
    taskId: string | null;
    outputItemId: string | null;
    fileId: string | null;
    descriptorHash: string | null;
  },
  input: {
    projectId: string;
    value: WebsiteKnowledgeImport;
  },
) {
  return (
    receipt.projectId === input.projectId &&
    receipt.taskId === knowledgeImportTaskId(input.value) &&
    receipt.outputItemId === knowledgeImportOutputItemId(input.value) &&
    (receipt.fileId ?? null) ===
      (knowledgeImportReceiptFileId(input.value) ?? null) &&
    receipt.descriptorHash?.toLowerCase() ===
      knowledgeImportDescriptorHash(input.value).toLowerCase()
  );
}

export function knowledgeArtifactReceiptMatchesRequest(
  receipt: {
    projectId: string | null;
    taskId: string | null;
    outputItemId: string | null;
    fileId: string | null;
    descriptorHash: string | null;
    sourceReference?: string | null;
  },
  input: {
    projectId: string;
    value: WebsiteKnowledgeImport;
  },
) {
  if (!knowledgeArtifactReceiptDescriptorMatchesRequest(receipt, input)) {
    return false;
  }
  return (
    receipt.sourceReference === knowledgeImportReceiptSourceReference(input)
  );
}

async function requireImportDb() {
  const db = await getDb();
  if (!db) {
    throw new KnowledgeImportError(
      "DATABASE_UNAVAILABLE",
      "知识库同步服务暂不可用",
      503,
    );
  }
  return db;
}

type ReceiptReservation =
  | {
      state: "completed";
      receiptId: string;
      snapshotId: string;
    }
  | { state: "acquired"; receiptId: string; claimRevision: number };

function importAffectedRows(result: unknown) {
  const direct = result as { affectedRows?: unknown } | undefined;
  const tuple = result as Array<{ affectedRows?: unknown }> | undefined;
  const value = direct?.affectedRows ?? tuple?.[0]?.affectedRows;
  return value === undefined ? undefined : Number(value);
}

function incompleteReceiptError() {
  return new KnowledgeImportError(
    "RECEIPT_DATA_INCOMPLETE",
    "知识库导入回执已完成，但缺少精确快照绑定",
    409,
  );
}

async function reserveReceipt(input: {
  userId: number;
  projectId: string;
  idempotencyKey: string;
  value: WebsiteKnowledgeImport;
  now: Date;
}): Promise<ReceiptReservation> {
  const db = await requireImportDb();
  const keyHash = idempotencyHash(input.idempotencyKey);
  return db.transaction(async (tx) => {
    await lockActiveKnowledgeImportProject(tx, input.projectId);
    const rows = await tx
      .select()
      .from(knowledgeImportReceipts)
      .where(eq(knowledgeImportReceipts.idempotencyKeyHash, keyHash))
      .limit(1)
      .for("update");
    const existing = rows[0];
    if (existing) {
      const sameArtifact =
        existing.userId === input.userId &&
        knowledgeArtifactReceiptDescriptorMatchesRequest(existing, input) &&
        existing.artifactHash.toLowerCase() ===
          knowledgeImportArtifactSha256(input.value).toLowerCase();
      if (!sameArtifact) {
        throw new KnowledgeImportError(
          "IDEMPOTENCY_CONFLICT",
          "该幂等键已用于不同的知识库产物",
          409,
        );
      }
      const sameRequest = knowledgeArtifactReceiptMatchesRequest(
        existing,
        input,
      );
      if (!sameRequest) {
        throw new KnowledgeImportError(
          "IDEMPOTENCY_CONFLICT",
          "该幂等键已用于不同的知识库导入请求",
          409,
        );
      }
      if (existing.status === "completed") {
        if (!existing.snapshotId) throw incompleteReceiptError();
        return {
          state: "completed",
          receiptId: existing.id,
          snapshotId: existing.snapshotId,
        };
      }
      const ageMs = input.now.getTime() - existing.updatedAt.getTime();
      if (
        (existing.status === "pending" || existing.status === "processing") &&
        ageMs < 5 * 60 * 1000
      ) {
        throw new KnowledgeImportError(
          "IDEMPOTENCY_PENDING",
          "相同知识库正在同步中",
          425,
          2_000,
        );
      }
      const claimRevision = existing.revision + 1;
      const result = await tx
        .update(knowledgeImportReceipts)
        .set({
          status: "processing",
          attemptCount: existing.attemptCount + 1,
          revision: claimRevision,
          errorCode: null,
          errorMessage: null,
          sourceReference: knowledgeImportReceiptSourceReference(input),
          updatedAt: input.now,
        })
        .where(
          and(
            eq(knowledgeImportReceipts.id, existing.id),
            eq(knowledgeImportReceipts.revision, existing.revision),
          ),
        );
      if (importAffectedRows(result) === 0) {
        throw new KnowledgeImportError(
          "IDEMPOTENCY_PENDING",
          "相同知识库已由其他请求接管",
          425,
          2_000,
        );
      }
      return { state: "acquired", receiptId: existing.id, claimRevision };
    }

    const artifactRows = await tx
      .select()
      .from(knowledgeImportReceipts)
      .where(
        and(
          eq(knowledgeImportReceipts.userId, input.userId),
          eq(
            knowledgeImportReceipts.artifactHash,
            knowledgeImportArtifactSha256(input.value).toLowerCase(),
          ),
        ),
      )
      .limit(1)
      .for("update");
    const existingArtifact = artifactRows[0];
    if (existingArtifact) {
      const sameArtifactDescriptor =
        knowledgeArtifactReceiptDescriptorMatchesRequest(
          existingArtifact,
          input,
        );
      if (!sameArtifactDescriptor) {
        throw new KnowledgeImportError(
          "IDEMPOTENCY_CONFLICT",
          "相同知识库产物已由另一份任务描述导入，不能重复绑定",
          409,
        );
      }
      const sameArtifactRequest = knowledgeArtifactReceiptMatchesRequest(
        existingArtifact,
        input,
      );
      if (!sameArtifactRequest) {
        throw new KnowledgeImportError(
          "IDEMPOTENCY_CONFLICT",
          "相同知识库产物已由另一份来源合同导入，不能重新绑定",
          409,
        );
      }
      if (existingArtifact.status === "completed") {
        if (!existingArtifact.snapshotId) throw incompleteReceiptError();
        return {
          state: "completed",
          receiptId: existingArtifact.id,
          snapshotId: existingArtifact.snapshotId,
        };
      }
      if (
        existingArtifact.status === "pending" ||
        existingArtifact.status === "processing"
      ) {
        throw new KnowledgeImportError(
          "IDEMPOTENCY_PENDING",
          "相同知识库正在同步中",
          425,
          2_000,
        );
      }
      throw new KnowledgeImportError(
        "IDEMPOTENCY_CONFLICT",
        "相同知识库产物已有失败记录，请使用原幂等键重试",
        409,
      );
    }

    const receiptId = randomUUID();
    try {
      await tx.insert(knowledgeImportReceipts).values({
        id: receiptId,
        userId: input.userId,
        source: "website",
        projectId: input.projectId,
        companyName: input.value.companyName,
        taskId: knowledgeImportTaskId(input.value),
        fileId: knowledgeImportReceiptFileId(input.value) ?? null,
        outputItemId: knowledgeImportOutputItemId(input.value),
        descriptorHash: knowledgeImportDescriptorHash(
          input.value,
        ).toLowerCase(),
        sourceReference: knowledgeImportReceiptSourceReference(input),
        idempotencyKeyHash: keyHash,
        artifactHash: knowledgeImportArtifactSha256(input.value).toLowerCase(),
        sourceFileName: knowledgeImportFilename(input.value),
        siteOpsKnowledgeInputEpochId: null,
        status: "processing",
        attemptCount: 1,
        revision: 1,
        createdAt: input.now,
        updatedAt: input.now,
      });
    } catch (error) {
      if ((error as { code?: string })?.code === "ER_DUP_ENTRY") {
        throw new KnowledgeImportError(
          "IDEMPOTENCY_PENDING",
          "相同知识库正在同步中",
          425,
          2_000,
        );
      }
      throw error;
    }
    return { state: "acquired", receiptId, claimRevision: 1 };
  });
}

async function markReceiptFailed(
  receiptId: string,
  claimRevision: number,
  error: unknown,
) {
  const db = await requireImportDb();
  const bindings = await db
    .select({ projectId: knowledgeImportReceipts.projectId })
    .from(knowledgeImportReceipts)
    .where(eq(knowledgeImportReceipts.id, receiptId))
    .limit(1);
  await db.transaction(async (tx) => {
    if (bindings[0]?.projectId) {
      await lockActiveKnowledgeImportProject(tx, bindings[0].projectId);
    }
    await tx
      .update(knowledgeImportReceipts)
      .set({
        status: "failed",
        errorCode:
          error instanceof KnowledgeImportError
            ? error.code
            : "KNOWLEDGE_IMPORT_FAILED",
        errorMessage: (error instanceof Error
          ? error.message
          : "知识库同步失败"
        ).slice(0, 2000),
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(knowledgeImportReceipts.id, receiptId),
          eq(knowledgeImportReceipts.status, "processing"),
          eq(knowledgeImportReceipts.revision, claimRevision),
        ),
      );
  });
}

async function readImportReceiptState(receiptId: string) {
  const db = await requireImportDb();
  const rows = await db
    .select({
      userId: knowledgeImportReceipts.userId,
      status: knowledgeImportReceipts.status,
      revision: knowledgeImportReceipts.revision,
      snapshotId: knowledgeImportReceipts.snapshotId,
    })
    .from(knowledgeImportReceipts)
    .where(eq(knowledgeImportReceipts.id, receiptId))
    .limit(1);
  return rows[0] ?? null;
}

async function readKnowledgeImportArtifactBytes(artifactId: string) {
  const [artifact, stored] = await Promise.all([
    readPresalesV2Artifact(artifactId),
    readStoredPresalesFile(artifactId),
  ]);
  if (!artifact || !stored) {
    throw new KnowledgeImportError(
      "ARTIFACT_DESCRIPTOR_MISMATCH",
      "本地知识库产物不存在或已过期",
      409,
    );
  }
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const raw of stored.createReadStream()) {
    const chunk = Buffer.isBuffer(raw) ? raw : Buffer.from(raw);
    bytes += chunk.length;
    if (bytes > 100 * 1024 * 1024) {
      throw new KnowledgeImportError(
        "ARTIFACT_DESCRIPTOR_MISMATCH",
        "本地知识库产物超过允许大小",
        413,
      );
    }
    chunks.push(chunk);
  }
  const buffer = Buffer.concat(chunks);
  const sha256 = createHash("sha256").update(buffer).digest("hex");
  if (
    artifact.bytes !== buffer.length ||
    stored.sizeBytes !== buffer.length ||
    artifact.sha256 !== sha256 ||
    (stored.sha256 !== null && stored.sha256 !== sha256)
  ) {
    throw new KnowledgeImportError(
      "ARTIFACT_HASH_MISMATCH",
      "本地知识库产物字节或哈希不一致",
      409,
    );
  }
  return { artifact, buffer, filename: artifact.filename, sha256 };
}

export async function importWebsiteKnowledgeArtifact(input: {
  projectId: string;
  idempotencyKey: string;
  value: WebsiteKnowledgeImport;
  now?: Date;
}) {
  const value = websiteKnowledgeImportSchema.parse(input.value);
  const db = await requireImportDb();
  const provisions = await db
    .select({
      userId: websiteUserProvisions.userId,
      companyName: websiteUserProvisions.companyName,
      status: websiteUserProvisions.status,
    })
    .from(websiteUserProvisions)
    .where(eq(websiteUserProvisions.projectId, input.projectId));
  const provision = resolveKnowledgeImportProjectOwner(
    provisions,
    value.companyName,
  );
  const [candidateArtifact, finalArtifact] = await Promise.all([
    readKnowledgeImportArtifactBytes(value.candidateArtifactId),
    readKnowledgeImportArtifactBytes(value.finalArtifactId),
  ]);
  if (
    candidateArtifact.artifact.projectId !== input.projectId ||
    finalArtifact.artifact.projectId !== input.projectId
  ) {
    throw new KnowledgeImportError(
      "TASK_PROJECT_MISMATCH",
      "知识库本地产物不属于当前官网项目",
      403,
    );
  }
  if (
    candidateArtifact.sha256 !== value.candidateSha256.toLowerCase() ||
    finalArtifact.sha256 !== value.finalSha256.toLowerCase()
  ) {
    throw new KnowledgeImportError(
      "ARTIFACT_HASH_MISMATCH",
      "知识库本地产物哈希与官网声明不一致",
      409,
    );
  }
  const taskId = value.candidateArtifactId;

  const reservation = await reserveReceipt({
    userId: provision.userId,
    projectId: input.projectId,
    idempotencyKey: input.idempotencyKey,
    value,
    now: input.now ?? new Date(),
  });
  if (reservation.state === "completed") {
    const snapshot = await getKnowledgeSnapshotById({
      userId: provision.userId,
      snapshotId: reservation.snapshotId,
    });
    if (!snapshot) throw incompleteReceiptError();
    // Snapshot + receipt commit atomically, while the monitoring handoff is a
    // post-commit side effect. A worker can exit in that narrow interval, so
    // every completed-receipt replay must also repair the handoff. The handoff
    // service is snapshot-keyed/idempotent; failure remains non-fatal because
    // the knowledge snapshot is already durable and a later replay can retry.
    await createKnowledgeMonitoringHandoff({
      userId: provision.userId,
      actorUserId: provision.userId,
      knowledgeSnapshotId: reservation.snapshotId,
    }).catch((handoffError) => {
      console.error(
        "[KnowledgeImport] Completed receipt replay could not ensure monitoring handoff",
        handoffError,
      );
    });
    return {
      status: "completed" as const,
      replayed: true,
      receiptId: reservation.receiptId,
      snapshot,
    };
  }

  let storedAssetKeys: string[] = [];
  let snapshotCommitted = false;
  let snapshotCommitAttempted = false;
  let storedArchive: { userId: number; snapshotId: string } | undefined;
  let committedSnapshot: Awaited<
    ReturnType<typeof createKnowledgeSnapshot>
  > | null = null;
  let committedSnapshotId = "";
  try {
    await assertKnowledgeBaseWritable(provision.userId);
    try {
      await assertServiceCapability(provision.userId, "knowledgeDisplay");
    } catch (error) {
      if (error instanceof ServiceEntitlementError) {
        throw new KnowledgeImportError(
          "SERVICE_NOT_WRITABLE",
          error.message,
          error.statusCode,
        );
      }
      throw error;
    }
    const downloaded = {
      buffer: finalArtifact.buffer,
      filename: finalArtifact.filename,
    };
    const rawArchiveHash = createHash("sha256")
      .update(downloaded.buffer)
      .digest("hex");
    if (rawArchiveHash !== knowledgeImportArtifactSha256(value).toLowerCase()) {
      throw new KnowledgeImportError(
        "ARTIFACT_HASH_MISMATCH",
        "知识库 ZIP 哈希与官网声明不一致",
        409,
      );
    }
    const canonicalArchive = await canonicalizeWebsiteKnowledgeImportArchive(
      downloaded.buffer,
    );
    const snapshotId = randomUUID();
    const parsed =
      canonicalArchive.schemaVersion === 4
        ? await projectWebsiteKnowledgeImportArchiveV4({
            buffer: canonicalArchive.buffer,
            snapshotId,
          })
        : await readKnowledgeArchive(
            canonicalArchive.buffer,
            downloaded.filename,
            snapshotId,
            {
              validationProfile: "website-lead-v1",
              archiveContractVersion:
                knowledgeImportArchiveContractVersion(value),
            },
          );
    storedAssetKeys = parsed.storedAssetKeys;
    const packageManifestSha256 = knowledgeImportPackageManifestSha256(value);
    if (
      packageManifestSha256 &&
      parsed.packageManifestSha256?.toLowerCase() !==
        packageManifestSha256.toLowerCase()
    ) {
      throw new KnowledgeImportError(
        "ARTIFACT_HASH_MISMATCH",
        "知识库 package manifest 哈希与官网声明不一致",
        409,
      );
    }
    const workspace = await getDashboardWorkspace(provision.userId);
    if (
      normalizedEnterpriseName(workspace.payload.brandName) !==
      normalizedEnterpriseName(value.companyName)
    ) {
      throw new KnowledgeImportError(
        "PROJECT_ENTERPRISE_MISMATCH",
        "用户工作空间企业与官网知识库企业不一致",
        409,
      );
    }
    if (canonicalArchive.schemaVersion !== 4) {
      assertKnowledgeArchiveEnterpriseIdentity({
        enterpriseIdentityConfirmed: true,
        brandName: workspace.payload.brandName,
        documents: parsed.documents,
      });
    }
    await persistKnowledgeSnapshotArchive({
      userId: provision.userId,
      snapshotId,
      buffer: canonicalArchive.buffer,
      expectedSha256: canonicalArchive.sha256,
    });
    storedArchive = { userId: provision.userId, snapshotId };
    snapshotCommitAttempted = true;
    const snapshot = await createKnowledgeSnapshot({
      snapshotId,
      userId: provision.userId,
      actorUserId: provision.userId,
      sourceFileName: downloaded.filename,
      sourceTaskId: taskId,
      sourceArtifactHash: knowledgeImportDescriptorHash(value).toLowerCase(),
      archiveHash: canonicalArchive.sha256,
      documents: parsed.documents,
      assets: parsed.assets,
      totalBytes: canonicalArchive.buffer.length,
      importReceiptClaim: {
        receiptId: reservation.receiptId,
        claimRevision: reservation.claimRevision,
      },
    });
    committedSnapshot = snapshot;
    committedSnapshotId = snapshot?.id ?? snapshotId;
    snapshotCommitted = true;
    await createKnowledgeMonitoringHandoff({
      userId: provision.userId,
      actorUserId: provision.userId,
      knowledgeSnapshotId: snapshot?.id ?? snapshotId,
    });
    return {
      status: "completed" as const,
      replayed: false,
      receiptId: reservation.receiptId,
      snapshot,
    };
  } catch (error) {
    if (!snapshotCommitted && snapshotCommitAttempted) {
      let receiptState:
        | Awaited<ReturnType<typeof readImportReceiptState>>
        | undefined;
      try {
        receiptState = await readImportReceiptState(reservation.receiptId);
      } catch (receiptReadError) {
        console.error(
          "[KnowledgeImport] Snapshot commit outcome is unknown; preserving claimant files for replay",
          receiptReadError,
        );
      }
      if (receiptState?.status === "completed" && receiptState.snapshotId) {
        const durableSnapshot = await getKnowledgeSnapshotById({
          userId: provision.userId,
          snapshotId: receiptState.snapshotId,
        });
        if (!durableSnapshot) throw incompleteReceiptError();
        if (storedArchive?.snapshotId !== receiptState.snapshotId) {
          await removeStoredKnowledgeAssets(storedAssetKeys);
          if (storedArchive) {
            await removeKnowledgeSnapshotArchive(storedArchive).catch(
              () => undefined,
            );
          }
        }
        await createKnowledgeMonitoringHandoff({
          userId: provision.userId,
          actorUserId: provision.userId,
          knowledgeSnapshotId: receiptState.snapshotId,
        }).catch((handoffError) => {
          console.error(
            "[KnowledgeImport] Replayed committed snapshot but monitoring handoff failed",
            handoffError,
          );
        });
        return {
          status: "completed" as const,
          replayed: true,
          receiptId: reservation.receiptId,
          snapshot: durableSnapshot,
        };
      }
      if (receiptState === undefined) {
        throw error instanceof KnowledgeImportError
          ? error
          : new KnowledgeImportError(
              "KNOWLEDGE_IMPORT_FAILED",
              "知识库快照提交结果暂时无法确认，请使用原幂等键重试",
              503,
            );
      }
    }
    if (snapshotCommitted) {
      await createKnowledgeMonitoringHandoff({
        userId: provision.userId,
        actorUserId: provision.userId,
        knowledgeSnapshotId: committedSnapshotId,
      }).catch((handoffError) => {
        console.error(
          "[KnowledgeImport] Snapshot committed but monitoring handoff retry failed",
          handoffError,
        );
      });
      console.warn(
        "[KnowledgeImport] Returning committed snapshot after a non-fatal post-commit failure",
        error,
      );
      return {
        status: "completed" as const,
        replayed: false,
        receiptId: reservation.receiptId,
        snapshot: committedSnapshot,
      };
    }
    if (!snapshotCommitted) {
      await removeStoredKnowledgeAssets(storedAssetKeys);
      if (storedArchive) {
        await removeKnowledgeSnapshotArchive(storedArchive).catch(
          () => undefined,
        );
      }
    }
    await markReceiptFailed(
      reservation.receiptId,
      reservation.claimRevision,
      error,
    );
    throw error instanceof KnowledgeImportError
      ? error
      : new KnowledgeImportError(
          "KNOWLEDGE_IMPORT_FAILED",
          error instanceof Error ? error.message : "知识库同步失败",
          400,
        );
  }
}
