import {
  and,
  asc,
  eq,
  isNotNull,
  isNull,
  lte,
  notInArray,
  sql,
} from "drizzle-orm";
import mysql from "mysql2/promise";

import {
  attachments,
  conversationTurns,
  presalesUpstreamResources,
  upstreamResources,
} from "../drizzle/schema";
import { getDb } from "./db";
import {
  markStoredPresalesFileRetention,
  readStoredPresalesFile,
  removeStoredPresalesFile,
  sweepPresalesFileStorageRetention,
} from "./presales-file-store";

export const FILE_CONTENT_RETENTION_DAYS = 30;
export const FILE_CONTENT_RETENTION_MS =
  FILE_CONTENT_RETENTION_DAYS * 24 * 60 * 60 * 1_000;
export const FILE_CONTENT_RETENTION_BATCH_SIZE = 200;
export const FILE_CONTENT_RETENTION_MAX_BATCHES = 20;
export const FILE_CONTENT_RETENTION_INTERVAL_MS = 60 * 60 * 1_000;
export const FILE_CONTENT_RETENTION_LOCK_NAME =
  "frontmind-dashboard:file-content-retention";

function retentionRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/** In-memory mirror of the SQL classification policy, used by audits/tests. */
export function historicalKnowledgeBaseTurnUserUploadFileIds(input: {
  attachmentFileIds?: readonly string[] | null;
  metadata?: unknown;
}) {
  const ledger = new Set((input.attachmentFileIds ?? []).map(String));
  const metadata = retentionRecord(input.metadata) ?? {};
  const staged = metadata.clientStagedAttachments;
  if (Array.isArray(staged)) {
    return [
      ...new Set(
        staged
          .map((value) => String(retentionRecord(value)?.file_id ?? ""))
          .filter((fileId) => fileId && ledger.has(fileId)),
      ),
    ];
  }
  const userAttachmentCount = Number(metadata.userAttachmentCount ?? 0);
  const recovery = retentionRecord(metadata.recovery);
  const recoveryAttachments = recovery?.attachments;
  if (
    !Number.isSafeInteger(userAttachmentCount) ||
    userAttachmentCount < 1 ||
    !Array.isArray(recoveryAttachments) ||
    recoveryAttachments.length !== userAttachmentCount
  ) {
    return [];
  }
  return [
    ...new Set(
      recoveryAttachments
        .map((value) => String(retentionRecord(value)?.file_id ?? ""))
        .filter((fileId) => fileId && ledger.has(fileId)),
    ),
  ];
}

/**
 * SQL predicate for an attachment whose owning chat message was written by the
 * user. Assistant/tool attachments are generated output and must not acquire a
 * user-upload retention clock merely because they share the attachments table.
 * Soft-deleted rows remain valid provenance, so no deletedAt filter is applied.
 */
export function historicalMessageUserUploadReferenceSql(input: {
  resourceUserIdExpression: string;
  resourceFileIdExpression: string;
  attachmentAlias?: string;
  messageAlias?: string;
}) {
  const attachmentAlias = input.attachmentAlias ?? "retention_attachment";
  const messageAlias = input.messageAlias ?? "retention_message";
  const userId = input.resourceUserIdExpression;
  const fileId = input.resourceFileIdExpression;
  return `EXISTS (
    SELECT 1
      FROM attachments ${attachmentAlias}
      INNER JOIN messages ${messageAlias}
              ON ${messageAlias}.id = ${attachmentAlias}.messageId
             AND ${messageAlias}.userId = ${attachmentAlias}.userId
     WHERE ${attachmentAlias}.userId = ${userId}
       AND ${attachmentAlias}.upstreamFileId = ${fileId}
       AND ${messageAlias}.role = 'user'
  )`;
}

/**
 * SQL predicate for a customer-supplied knowledge-base attachment.
 *
 * `conversation_turns.attachmentFileIds` also contains generated Skill/prefill
 * files, so membership in that array alone is not proof of a user upload. New
 * turns have the exact browser-upload ledger in `clientStagedAttachments`.
 * Legacy upload-first turns are accepted only when the recovery attachment
 * list is complete for the declared `userAttachmentCount`. Generated files are
 * intentionally absent from both ledgers.
 *
 * The expressions are internal SQL identifiers supplied by this module and the
 * read-only preflight script; never pass request data here.
 */
export function historicalKnowledgeBaseUserUploadReferenceSql(input: {
  resourceUserIdExpression: string;
  resourceFileIdExpression: string;
  turnAlias?: string;
}) {
  const turnAlias = input.turnAlias ?? "retention_turn";
  const userId = input.resourceUserIdExpression;
  const fileId = input.resourceFileIdExpression;
  return `EXISTS (
    SELECT 1
      FROM conversation_turns ${turnAlias}
     WHERE ${turnAlias}.userId = ${userId}
       AND JSON_CONTAINS(
             ${turnAlias}.attachmentFileIds,
             JSON_QUOTE(${fileId}),
             '$'
           )
       AND (
         JSON_CONTAINS(
           COALESCE(
             JSON_EXTRACT(
               ${turnAlias}.metadata,
               '$.clientStagedAttachments[*].file_id'
             ),
             JSON_ARRAY()
           ),
           JSON_QUOTE(${fileId}),
           '$'
         )
         OR (
           JSON_EXTRACT(
             ${turnAlias}.metadata,
             '$.clientStagedAttachments'
           ) IS NULL
           AND COALESCE(
                 CAST(
                   NULLIF(
                     JSON_UNQUOTE(
                       JSON_EXTRACT(
                         ${turnAlias}.metadata,
                         '$.userAttachmentCount'
                       )
                     ),
                     'null'
                   ) AS UNSIGNED
                 ),
                 0
               ) > 0
           AND JSON_LENGTH(
                 COALESCE(
                   JSON_EXTRACT(
                     ${turnAlias}.metadata,
                     '$.recovery.attachments'
                   ),
                   JSON_ARRAY()
                 )
               ) = COALESCE(
                 CAST(
                   NULLIF(
                     JSON_UNQUOTE(
                       JSON_EXTRACT(
                         ${turnAlias}.metadata,
                         '$.userAttachmentCount'
                       )
                     ),
                     'null'
                   ) AS UNSIGNED
                 ),
                 0
               )
           AND JSON_CONTAINS(
                 COALESCE(
                   JSON_EXTRACT(
                     ${turnAlias}.metadata,
                     '$.recovery.attachments[*].file_id'
                   ),
                   JSON_ARRAY()
                 ),
                 JSON_QUOTE(${fileId}),
                 '$'
               )
         )
       )
  )`;
}

function historicalUserUploadReferenceCondition() {
  // `deletedAt` is intentionally not filtered: soft-deleting a message/card
  // cannot erase the fact that its bytes were a user upload or make an old
  // null-lifecycle ownership row immortal.
  return sql.raw(`(
    ${historicalMessageUserUploadReferenceSql({
      resourceUserIdExpression: "upstream_resources.userId",
      resourceFileIdExpression: "upstream_resources.upstreamId",
    })}
    OR ${historicalKnowledgeBaseUserUploadReferenceSql({
      resourceUserIdExpression: "upstream_resources.userId",
      resourceFileIdExpression: "upstream_resources.upstreamId",
    })}
  )`);
}

type FileResourceRow = {
  id: string;
  userId: number;
  upstreamId: string;
  projectAssignmentId: string | null;
  createdAt: Date;
  uploadedAt: Date | null;
  contentExpiresAt: Date | null;
  contentDeletedAt: Date | null;
};

export type FileContentRetentionResult = {
  cutoff: Date;
  backfilled: number;
  batches: number;
  contentBatches: number;
  metadataBatches: number;
  expired: number;
  metadataDeleted: number;
  bytesReclaimed: number;
  failures: number;
  filesystemDeleted: number;
  filesystemBytesReclaimed: number;
  filesystemStaleTempsDeleted: number;
  filesystemFailures: number;
  filesystemHasMore: boolean;
  filesystemNextCursor: string | null;
};

type RetentionDatabase = NonNullable<Awaited<ReturnType<typeof getDb>>>;

function positiveInteger(value: number, label: string) {
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(`${label}必须是大于 0 的整数`);
  }
  return value;
}

export function fileContentExpiryFromUpload(
  uploadedAt: Date,
  retentionDays = FILE_CONTENT_RETENTION_DAYS,
) {
  positiveInteger(retentionDays, "文件保留天数");
  return new Date(uploadedAt.getTime() + retentionDays * 24 * 60 * 60 * 1_000);
}

function retentionTimestamp(value: Date | string | number | null | undefined) {
  if (value instanceof Date) return value.getTime();
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim()) {
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
}

export function fileResourceContentExpiry(resource: {
  uploadedAt?: Date | string | number | null;
  contentExpiresAt?: Date | string | number | null;
}) {
  const explicit = retentionTimestamp(resource.contentExpiresAt);
  if (explicit !== undefined) return explicit;
  // Only user uploads receive the immutable hard-expiry clock. Assistant
  // outputs and external files intentionally leave both retention columns
  // null; falling back to the generic resource createdAt would silently turn
  // the user-upload policy into an all-files policy.
  const origin = retentionTimestamp(resource.uploadedAt);
  return origin === undefined ? undefined : origin + FILE_CONTENT_RETENTION_MS;
}

export function isFileResourceContentExpired(
  resource: {
    uploadedAt?: Date | string | number | null;
    contentExpiresAt?: Date | string | number | null;
    contentDeletedAt?: Date | string | number | null;
  },
  now = Date.now(),
) {
  if (retentionTimestamp(resource.contentDeletedAt) !== undefined) return true;
  const expiresAt = fileResourceContentExpiry(resource);
  return expiresAt !== undefined && expiresAt <= now;
}

/**
 * Starts the immutable retention clock after the upstream PUT and local
 * capture have both committed. COALESCE deliberately prevents a conversation
 * snapshot or repeated request from extending an existing deadline.
 */
export async function markUploadedFileRetention(input: {
  database?: RetentionDatabase | null;
  userId: number;
  fileId: string;
  uploadedAt?: Date;
}) {
  const database = input.database ?? (await getDb());
  if (!database) throw new Error("DATABASE_UNAVAILABLE");
  const uploadedAt = input.uploadedAt ?? new Date();
  await database.execute(sql`
    UPDATE ${upstreamResources}
       SET ${upstreamResources.uploadedAt} = COALESCE(${upstreamResources.uploadedAt}, ${uploadedAt}),
           ${upstreamResources.contentExpiresAt} = COALESCE(
             ${upstreamResources.contentExpiresAt},
             DATE_ADD(
               COALESCE(${upstreamResources.uploadedAt}, ${uploadedAt}),
               INTERVAL 30 DAY
             )
           )
     WHERE ${upstreamResources.kind} = 'file'
       AND ${upstreamResources.userId} = ${input.userId}
       AND ${upstreamResources.upstreamId} = ${input.fileId}
  `);
  const rows = await database
    .select({
      uploadedAt: upstreamResources.uploadedAt,
      contentExpiresAt: upstreamResources.contentExpiresAt,
      contentDeletedAt: upstreamResources.contentDeletedAt,
    })
    .from(upstreamResources)
    .where(
      and(
        eq(upstreamResources.kind, "file"),
        eq(upstreamResources.userId, input.userId),
        eq(upstreamResources.upstreamId, input.fileId),
      ),
    )
    .limit(1);
  if (!rows[0]?.uploadedAt || !rows[0]?.contentExpiresAt) {
    throw new Error("UPLOADED_FILE_RESOURCE_NOT_FOUND");
  }
  return rows[0];
}

/**
 * Existing attachment resources predate the immutable upload clock. Prefer
 * the local stored-manifest commit time; if no local manifest exists, the
 * first ownership-ledger timestamp is the oldest trustworthy server time.
 * Neither value is derived from a later conversation snapshot.
 */
export async function backfillHistoricalFileRetention(input?: {
  database?: RetentionDatabase | null;
  batchSize?: number;
  maxBatches?: number;
}) {
  const database = input?.database ?? (await getDb());
  if (!database) return 0;
  const batchSize = positiveInteger(
    input?.batchSize ?? FILE_CONTENT_RETENTION_BATCH_SIZE,
    "文件回填批大小",
  );
  const maxBatches = positiveInteger(
    input?.maxBatches ?? FILE_CONTENT_RETENTION_MAX_BATCHES,
    "文件回填批次数",
  );
  let backfilled = 0;
  for (let batch = 0; batch < maxBatches; batch += 1) {
    const candidates = (await database
      .select({
        id: upstreamResources.id,
        upstreamId: upstreamResources.upstreamId,
        createdAt: upstreamResources.createdAt,
        uploadedAt: upstreamResources.uploadedAt,
      })
      .from(upstreamResources)
      .where(
        and(
          eq(upstreamResources.kind, "file"),
          isNull(upstreamResources.contentExpiresAt),
          historicalUserUploadReferenceCondition(),
        ),
      )
      .orderBy(asc(upstreamResources.createdAt), asc(upstreamResources.id))
      .limit(batchSize)) as Array<{
      id: string;
      upstreamId: string;
      createdAt: Date;
      uploadedAt: Date | null;
    }>;

    for (const candidate of candidates) {
      let uploadedAt = candidate.uploadedAt ?? candidate.createdAt;
      let hasStoredCopy = false;
      try {
        const stored = await readStoredPresalesFile(candidate.upstreamId);
        // A managed manifest is authoritative. For an older unmanaged local
        // upload, use the content file's birthtime/mtime instead of descriptor
        // updatedAt, which can be rewritten by a later metadata refresh.
        uploadedAt =
          candidate.uploadedAt ??
          stored?.uploadedAt ??
          stored?.contentStoredAt ??
          uploadedAt;
        hasStoredCopy = Boolean(stored);
      } catch {
        // Corrupt or missing local content does not block the ledger backfill;
        // the resolver will make one authenticated /content recovery attempt.
      }
      const expiresAt = fileContentExpiryFromUpload(uploadedAt);
      if (hasStoredCopy) {
        await markStoredPresalesFileRetention({
          fileId: candidate.upstreamId,
          uploadedAt,
          contentExpiresAt: expiresAt,
        });
      }
      await database
        .update(upstreamResources)
        .set({
          uploadedAt: sql`COALESCE(${upstreamResources.uploadedAt}, ${uploadedAt})`,
          contentExpiresAt: sql`COALESCE(
            ${upstreamResources.contentExpiresAt},
            DATE_ADD(
              COALESCE(${upstreamResources.uploadedAt}, ${uploadedAt}),
              INTERVAL 30 DAY
            )
          )`,
        })
        .where(
          and(
            eq(upstreamResources.id, candidate.id),
            isNull(upstreamResources.contentExpiresAt),
          ),
        );
      backfilled += 1;
    }
    if (candidates.length < batchSize) break;
  }
  return backfilled;
}

async function hasHistoricalFileRetentionBacklog(database: RetentionDatabase) {
  const rows = await database
    .select({ id: upstreamResources.id })
    .from(upstreamResources)
    .where(
      and(
        eq(upstreamResources.kind, "file"),
        isNull(upstreamResources.contentExpiresAt),
        historicalUserUploadReferenceCondition(),
      ),
    )
    .limit(1);
  return rows.length > 0;
}

async function backfillStoredFileLifecycle(input: {
  database: RetentionDatabase;
  fileId: string;
  uploadedAt: Date;
}) {
  await input.database.execute(sql`
    UPDATE ${upstreamResources}
       SET ${upstreamResources.uploadedAt} = COALESCE(
             ${upstreamResources.uploadedAt},
             ${input.uploadedAt}
           ),
           ${upstreamResources.contentExpiresAt} = COALESCE(
             ${upstreamResources.contentExpiresAt},
             DATE_ADD(
               COALESCE(${upstreamResources.uploadedAt}, ${input.uploadedAt}),
               INTERVAL 30 DAY
             )
           )
     WHERE ${upstreamResources.kind} = 'file'
       AND ${upstreamResources.upstreamId} = ${input.fileId}
  `);
  await input.database.execute(sql`
    UPDATE ${presalesUpstreamResources}
       SET ${presalesUpstreamResources.contentSource} = COALESCE(
             ${presalesUpstreamResources.contentSource},
             'user_upload'
           ),
           ${presalesUpstreamResources.uploadReservedAt} = ${input.uploadedAt},
           ${presalesUpstreamResources.uploadedAt} = ${input.uploadedAt},
           ${presalesUpstreamResources.contentExpiresAt} = DATE_ADD(
             ${input.uploadedAt},
             INTERVAL 30 DAY
           )
     WHERE ${presalesUpstreamResources.kind} = 'file'
       AND ${presalesUpstreamResources.upstreamId} = ${input.fileId}
       AND ${presalesUpstreamResources.uploadReservedAt} IS NULL
       AND ${presalesUpstreamResources.uploadedAt} IS NULL
       AND ${presalesUpstreamResources.contentExpiresAt} IS NULL
       AND ${presalesUpstreamResources.contentDeletedAt} IS NULL
       AND (
         ${presalesUpstreamResources.contentSource} IS NULL
         OR ${presalesUpstreamResources.contentSource} = 'user_upload'
       )
  `);
}

export type FileContentRetentionStartupResult = {
  databasePasses: number;
  databaseBackfilled: number;
  filesystemPasses: number;
  filesystemEntriesScanned: number;
  filesystemManifestsBackfilled: number;
};

/**
 * Completes the immutable lifecycle ledger before production accepts traffic.
 * Each query/filesystem pass remains bounded at the normal 200 x 20 limits,
 * but continuation is mandatory until no trusted historical user upload is
 * left with a null deadline. This prevents a large (>4,000 row) deployment
 * backlog from creating an hours-long access window.
 *
 * The filesystem reconciliation uses an epoch observation time, so it may
 * repair legacy manifest clocks but cannot physically expire content here.
 * The normal hourly worker performs bounded deletion after startup.
 */
export async function prepareFileContentRetentionForServing(input?: {
  database?: RetentionDatabase | null;
  batchSize?: number;
  maxBatches?: number;
  sweep?: typeof sweepPresalesFileStorageRetention;
  backfill?: typeof backfillHistoricalFileRetention;
  hasBacklog?: (database: RetentionDatabase) => Promise<boolean>;
  yieldBetweenPasses?: () => Promise<void>;
}): Promise<FileContentRetentionStartupResult> {
  const database = input?.database ?? (await getDb());
  if (!database) throw new Error("DATABASE_UNAVAILABLE");
  const batchSize = positiveInteger(
    input?.batchSize ?? FILE_CONTENT_RETENTION_BATCH_SIZE,
    "文件启动回填批大小",
  );
  const maxBatches = positiveInteger(
    input?.maxBatches ?? FILE_CONTENT_RETENTION_MAX_BATCHES,
    "文件启动回填批次数",
  );
  const result: FileContentRetentionStartupResult = {
    databasePasses: 0,
    databaseBackfilled: 0,
    filesystemPasses: 0,
    filesystemEntriesScanned: 0,
    filesystemManifestsBackfilled: 0,
  };
  const sweep = input?.sweep ?? sweepPresalesFileStorageRetention;
  const backfill = input?.backfill ?? backfillHistoricalFileRetention;
  const hasBacklog = input?.hasBacklog ?? hasHistoricalFileRetentionBacklog;
  const yieldBetweenPasses =
    input?.yieldBetweenPasses ??
    (() => new Promise<void>((resolve) => setImmediate(resolve)));

  let cursor: string | null = null;
  do {
    const filesystem = await sweep({
      // Nothing can be expired at the Unix epoch. This startup phase only
      // repairs immutable ledgers; byte deletion remains an hourly job.
      now: new Date(0),
      batchSize,
      maxBatches,
      cursor,
      persistCursor: false,
      onRetainedFile: async ({ fileId, uploadedAt }) => {
        await backfillStoredFileLifecycle({
          database,
          fileId,
          uploadedAt,
        });
        result.filesystemManifestsBackfilled += 1;
      },
    });
    result.filesystemPasses += 1;
    result.filesystemEntriesScanned += filesystem.scannedEntries;
    if (filesystem.failures > 0) {
      throw new Error(
        "FILE_RETENTION_STARTUP_FILESYSTEM_RECONCILIATION_FAILED",
      );
    }
    cursor = filesystem.nextCursor;
    if (!filesystem.hasMore) break;
  } while (cursor);

  for (;;) {
    const backfilled = await backfill({
      database,
      batchSize,
      maxBatches,
    });
    result.databasePasses += 1;
    result.databaseBackfilled += backfilled;
    if (!(await hasBacklog(database))) break;
    if (backfilled < 1) {
      throw new Error("FILE_RETENTION_STARTUP_BACKFILL_MADE_NO_PROGRESS");
    }
    // Yield between bounded passes without exposing an HTTP listener.
    await yieldBetweenPasses();
  }
  return result;
}

async function hasLiveFileReference(
  database: RetentionDatabase,
  resource: Pick<FileResourceRow, "userId" | "upstreamId">,
) {
  const rows = await database
    .select({ id: attachments.id })
    .from(attachments)
    .where(
      and(
        eq(attachments.userId, resource.userId),
        eq(attachments.upstreamFileId, resource.upstreamId),
        isNull(attachments.deletedAt),
      ),
    )
    .limit(1);
  if (rows.length > 0) return true;
  const turnRows = await database
    .select({ id: conversationTurns.id })
    .from(conversationTurns)
    .where(
      and(
        eq(conversationTurns.userId, resource.userId),
        sql`JSON_CONTAINS(${conversationTurns.attachmentFileIds}, JSON_QUOTE(${resource.upstreamId}), '$')`,
      ),
    )
    .limit(1);
  return turnRows.length > 0;
}

/**
 * Filters the compact-metadata phase before its bounded LIMIT is applied.
 * Active expired cards are intentionally retained, but they must not occupy
 * every batch forever and starve metadata whose final reference disappeared.
 * Identifiers in this predicate are fixed schema names, never request data.
 */
function hasNoLiveFileReferenceCondition() {
  return sql.raw(`(
    NOT EXISTS (
      SELECT 1
        FROM attachments retention_live_attachment
       WHERE retention_live_attachment.userId = upstream_resources.userId
         AND retention_live_attachment.upstreamFileId = upstream_resources.upstreamId
         AND retention_live_attachment.deletedAt IS NULL
    )
    AND NOT EXISTS (
      SELECT 1
        FROM conversation_turns retention_live_turn
       WHERE retention_live_turn.userId = upstream_resources.userId
         AND JSON_CONTAINS(
               retention_live_turn.attachmentFileIds,
               JSON_QUOTE(upstream_resources.upstreamId),
               '$'
             )
    )
  )`);
}

async function purgeExpiredFileResource(input: {
  database: RetentionDatabase;
  resource: FileResourceRow;
  now: Date;
  removePreparedAssets: (resource: FileResourceRow) => Promise<number>;
}) {
  let sizeBytes = 0;
  try {
    const stored = await readStoredPresalesFile(input.resource.upstreamId);
    sizeBytes = stored?.sizeBytes ?? 0;
  } catch {
    // A corrupt local copy is still removed below. Expiry must not be blocked
    // by integrity inspection failing.
  }
  await removeStoredPresalesFile(input.resource.upstreamId);
  await input.removePreparedAssets(input.resource);

  const referenced = await hasLiveFileReference(input.database, input.resource);
  if (referenced) {
    await input.database
      .update(upstreamResources)
      .set({ contentDeletedAt: input.now })
      .where(
        and(
          eq(upstreamResources.id, input.resource.id),
          isNull(upstreamResources.contentDeletedAt),
        ),
      );
    return { sizeBytes, metadataDeleted: 0 };
  }
  await input.database
    .delete(upstreamResources)
    .where(eq(upstreamResources.id, input.resource.id));
  return { sizeBytes, metadataDeleted: 1 };
}

type FileContentCleanupPhaseResult = {
  contentBatches: number;
  metadataBatches: number;
  expired: number;
  metadataDeleted: number;
  bytesReclaimed: number;
  failures: number;
};

/**
 * Runs byte deletion before compact-metadata reclamation. Each phase owns its
 * own batch budget and processed-id set, so an arbitrarily large population
 * of active expired cards can neither consume nor delay the physical-content
 * cleanup budget.
 */
export async function cleanupExpiredFileResourcePhases(input: {
  batchSize: number;
  maxBatches: number;
  loadContentCandidates: (
    processedResourceIds: ReadonlySet<string>,
  ) => Promise<FileResourceRow[]>;
  loadMetadataCandidates: (
    processedResourceIds: ReadonlySet<string>,
  ) => Promise<FileResourceRow[]>;
  purgeContent: (
    resource: FileResourceRow,
  ) => Promise<{ sizeBytes: number; metadataDeleted: number }>;
  reclaimMetadata: (resource: FileResourceRow) => Promise<number>;
  onFailure?: (resource: FileResourceRow, error: unknown) => void;
}): Promise<FileContentCleanupPhaseResult> {
  const batchSize = positiveInteger(input.batchSize, "文件清理批大小");
  const maxBatches = positiveInteger(input.maxBatches, "文件清理批次数");
  const result: FileContentCleanupPhaseResult = {
    contentBatches: 0,
    metadataBatches: 0,
    expired: 0,
    metadataDeleted: 0,
    bytesReclaimed: 0,
    failures: 0,
  };

  const processedContentIds = new Set<string>();
  for (let batch = 0; batch < maxBatches; batch += 1) {
    const candidates = await input.loadContentCandidates(processedContentIds);
    if (!candidates.length) break;
    result.contentBatches += 1;
    for (const resource of candidates) {
      processedContentIds.add(resource.id);
      try {
        const purged = await input.purgeContent(resource);
        result.expired += 1;
        result.metadataDeleted += purged.metadataDeleted;
        result.bytesReclaimed += purged.sizeBytes;
      } catch (error) {
        result.failures += 1;
        input.onFailure?.(resource, error);
      }
    }
    if (candidates.length < batchSize) break;
  }

  const processedMetadataIds = new Set<string>();
  for (let batch = 0; batch < maxBatches; batch += 1) {
    const candidates = await input.loadMetadataCandidates(processedMetadataIds);
    if (!candidates.length) break;
    result.metadataBatches += 1;
    for (const resource of candidates) {
      processedMetadataIds.add(resource.id);
      try {
        result.metadataDeleted += await input.reclaimMetadata(resource);
      } catch (error) {
        result.failures += 1;
        input.onFailure?.(resource, error);
      }
    }
    if (candidates.length < batchSize) break;
  }

  return result;
}

export async function cleanupExpiredFileContent(input?: {
  database?: RetentionDatabase | null;
  now?: Date;
  batchSize?: number;
  maxBatches?: number;
  removePreparedAssets?: (resource: FileResourceRow) => Promise<number>;
  removePreparedAssetsByFileId?: (fileId: string) => Promise<number>;
  filesystemCursor?: string | null;
}): Promise<FileContentRetentionResult> {
  const now = input?.now ?? new Date();
  const database = input?.database ?? (await getDb());
  const result: FileContentRetentionResult = {
    cutoff: now,
    backfilled: 0,
    batches: 0,
    contentBatches: 0,
    metadataBatches: 0,
    expired: 0,
    metadataDeleted: 0,
    bytesReclaimed: 0,
    failures: 0,
    filesystemDeleted: 0,
    filesystemBytesReclaimed: 0,
    filesystemStaleTempsDeleted: 0,
    filesystemFailures: 0,
    filesystemHasMore: false,
    filesystemNextCursor: null,
  };
  const batchSize = positiveInteger(
    input?.batchSize ?? FILE_CONTENT_RETENTION_BATCH_SIZE,
    "文件清理批大小",
  );
  const maxBatches = positiveInteger(
    input?.maxBatches ?? FILE_CONTENT_RETENTION_MAX_BATCHES,
    "文件清理批次数",
  );
  // Attachment-ledger rows are backfilled first. This makes the API reject an
  // already-expired historical upload before any local bytes can disappear.
  // The filesystem pass below then contributes valid local-only manifests.
  if (database) {
    result.backfilled = await backfillHistoricalFileRetention({
      database,
      batchSize,
      maxBatches,
    });
  }
  let localManifestBackfills = 0;
  const filesystem = await sweepPresalesFileStorageRetention({
    now,
    batchSize,
    maxBatches,
    cursor: input?.filesystemCursor,
    persistCursor: input?.filesystemCursor === undefined,
    onRetainedFile: database
      ? async ({ fileId, uploadedAt }) => {
          await backfillStoredFileLifecycle({
            database,
            fileId,
            uploadedAt,
          });
          localManifestBackfills += 1;
        }
      : async () => {
          // A managed manifest is a durable recovery ledger. If MySQL is
          // unavailable, retain it so an upstream-recoverable file cannot
          // come back as an immortal null-retention resource.
          throw new Error("DATABASE_UNAVAILABLE");
        },
    canDeleteUnidentifiedFile: database
      ? async ({ storageKey }) => {
          const rows = await database
            .select({
              contentExpiresAt: upstreamResources.contentExpiresAt,
              contentDeletedAt: upstreamResources.contentDeletedAt,
            })
            .from(upstreamResources)
            .where(
              and(
                eq(upstreamResources.kind, "file"),
                sql`LOWER(SHA2(${upstreamResources.upstreamId}, 256)) = ${storageKey}`,
              ),
            )
            .limit(1);
          if (!rows[0]) return true;
          if (rows[0].contentDeletedAt) return true;
          return Boolean(
            rows[0].contentExpiresAt &&
              rows[0].contentExpiresAt.getTime() <= now.getTime(),
          );
        }
      : undefined,
    onExpiredFile: database
      ? async ({ fileId }) => {
          await database.execute(sql`
            UPDATE ${presalesUpstreamResources}
               SET ${presalesUpstreamResources.contentDeletedAt} = COALESCE(
                     ${presalesUpstreamResources.contentDeletedAt},
                     ${now}
                   )
             WHERE ${presalesUpstreamResources.kind} = 'file'
               AND ${presalesUpstreamResources.upstreamId} = ${fileId}
               AND ${presalesUpstreamResources.contentSource} = 'user_upload'
          `);
          await input?.removePreparedAssetsByFileId?.(fileId);
        }
      : undefined,
  });
  result.filesystemDeleted = filesystem.deleted;
  result.filesystemBytesReclaimed = filesystem.bytesReclaimed;
  result.filesystemStaleTempsDeleted = filesystem.staleTempsDeleted;
  result.filesystemFailures = filesystem.failures;
  result.filesystemHasMore = filesystem.hasMore;
  result.filesystemNextCursor = filesystem.nextCursor;
  if (!database) return result;
  result.backfilled += localManifestBackfills;
  const removePreparedAssets = input?.removePreparedAssets ?? (async () => 0);
  const selectExpiredCandidates = async (
    contentState: "pending" | "deleted",
    processedResourceIds: ReadonlySet<string>,
  ) =>
    (await database
      .select({
        id: upstreamResources.id,
        userId: upstreamResources.userId,
        upstreamId: upstreamResources.upstreamId,
        projectAssignmentId: upstreamResources.projectAssignmentId,
        createdAt: upstreamResources.createdAt,
        uploadedAt: upstreamResources.uploadedAt,
        contentExpiresAt: upstreamResources.contentExpiresAt,
        contentDeletedAt: upstreamResources.contentDeletedAt,
      })
      .from(upstreamResources)
      .where(
        and(
          eq(upstreamResources.kind, "file"),
          isNotNull(upstreamResources.contentExpiresAt),
          lte(upstreamResources.contentExpiresAt, now),
          contentState === "pending"
            ? isNull(upstreamResources.contentDeletedAt)
            : isNotNull(upstreamResources.contentDeletedAt),
          contentState === "deleted"
            ? hasNoLiveFileReferenceCondition()
            : undefined,
          processedResourceIds.size > 0
            ? notInArray(upstreamResources.id, [...processedResourceIds])
            : undefined,
        ),
      )
      .orderBy(
        asc(upstreamResources.contentExpiresAt),
        asc(upstreamResources.id),
      )
      .limit(batchSize)) as FileResourceRow[];

  const phases = await cleanupExpiredFileResourcePhases({
    batchSize,
    maxBatches,
    loadContentCandidates: (processedResourceIds) =>
      selectExpiredCandidates("pending", processedResourceIds),
    loadMetadataCandidates: (processedResourceIds) =>
      selectExpiredCandidates("deleted", processedResourceIds),
    purgeContent: (resource) =>
      purgeExpiredFileResource({
        database,
        resource,
        now,
        removePreparedAssets,
      }),
    reclaimMetadata: async (resource) => {
      // The SQL anti-joins keep referenced cards outside the batch limit. This
      // second check closes the race with a reference created after selection.
      if (await hasLiveFileReference(database, resource)) return 0;
      await database
        .delete(upstreamResources)
        .where(
          and(
            eq(upstreamResources.id, resource.id),
            isNotNull(upstreamResources.contentDeletedAt),
          ),
        );
      return 1;
    },
    onFailure: (resource, error) => {
      console.error(
        "[File content retention] File cleanup failed",
        JSON.stringify({
          resourceId: resource.id,
          error: error instanceof Error ? error.message : "unknown error",
        }),
      );
    },
  });
  result.contentBatches = phases.contentBatches;
  result.metadataBatches = phases.metadataBatches;
  result.batches = phases.contentBatches + phases.metadataBatches;
  result.expired += phases.expired;
  result.metadataDeleted += phases.metadataDeleted;
  result.bytesReclaimed += phases.bytesReclaimed;
  result.failures += phases.failures;
  return result;
}

type RetentionLockConnection = {
  query: (query: string, values?: unknown[]) => Promise<[any, unknown]>;
  end: () => Promise<void>;
};

export async function runFileContentRetentionCleanup(input?: {
  databaseUrl?: string;
  createConnection?: (url: string) => Promise<RetentionLockConnection>;
  cleanup?: () => Promise<FileContentRetentionResult>;
}) {
  const databaseUrl =
    input?.databaseUrl ?? process.env.DATABASE_URL?.trim() ?? "";
  if (!databaseUrl) return { acquired: false as const, result: null };
  const createConnection =
    input?.createConnection ??
    ((url: string) =>
      mysql.createConnection(url) as Promise<RetentionLockConnection>);
  const connection = await createConnection(databaseUrl);
  let acquired = false;
  try {
    const [rows] = await connection.query("SELECT GET_LOCK(?, 0) AS acquired", [
      FILE_CONTENT_RETENTION_LOCK_NAME,
    ]);
    acquired = Number(rows?.[0]?.acquired ?? 0) === 1;
    if (!acquired) return { acquired: false as const, result: null };
    return {
      acquired: true as const,
      result: await (input?.cleanup ?? cleanupExpiredFileContent)(),
    };
  } finally {
    if (acquired) {
      await connection
        .query("SELECT RELEASE_LOCK(?) AS released", [
          FILE_CONTENT_RETENTION_LOCK_NAME,
        ])
        .catch(() => undefined);
    }
    await connection.end();
  }
}

export function startFileContentRetentionScheduler(input?: {
  initialDelayMs?: number;
  intervalMs?: number;
  run?: typeof runFileContentRetentionCleanup;
}) {
  let running = false;
  const runCleanup = input?.run ?? runFileContentRetentionCleanup;
  const run = () => {
    if (running) return;
    running = true;
    runCleanup()
      .then((execution) => {
        if (!execution.acquired || !execution.result) return;
        console.info(
          "[File content retention] Cleanup complete",
          JSON.stringify(execution.result),
        );
      })
      .catch((error) => {
        console.error(
          "[File content retention] Cleanup failed",
          error instanceof Error ? error.message : "unknown error",
        );
      })
      .finally(() => {
        running = false;
      });
  };
  const initial = setTimeout(run, input?.initialDelayMs ?? 60_000);
  initial.unref?.();
  const interval = setInterval(
    run,
    input?.intervalMs ?? FILE_CONTENT_RETENTION_INTERVAL_MS,
  );
  interval.unref?.();
  return () => {
    clearTimeout(initial);
    clearInterval(interval);
  };
}
