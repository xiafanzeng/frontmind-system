import mysql, {
  type Connection,
  type ResultSetHeader,
  type RowDataPacket,
} from "mysql2/promise";

import { optionalKnowledgeBaseUploadEvidenceStorageKey } from "./knowledge-base-upload-evidence-lifecycle";

export const DEFAULT_CONVERSATION_RETENTION_DAYS = 30;
export const DEFAULT_CONVERSATION_RETENTION_BATCH_SIZE = 100;
export const DEFAULT_CONVERSATION_RETENTION_MAX_BATCHES = 20;
export const CONVERSATION_RETENTION_INTERVAL_MS = 6 * 60 * 60 * 1_000;
export const CONVERSATION_RETENTION_LOCK_NAME =
  "frontmind-dashboard:conversation-retention";

export type ConversationRetentionResult = {
  cutoff: Date;
  batches: number;
  /** True when eligible rows remain after this bounded cleanup pass. */
  truncated: boolean;
  conversations: number;
  messages: number;
  attachments: number;
  turns: number;
  knowledgeBuilds: number;
  fileResourcesQueued: number;
  taskResourcesDeleted: number;
};

type ConversationRow = RowDataPacket & { id: string; userId: number };
type KnowledgeBuildRow = RowDataPacket & {
  id: string;
  userId: number;
  generation: number;
  conversationId: string;
  logoStorageKey: string | null;
  packageStorageKey: string | null;
};
type CountRow = RowDataPacket & { count: number };
type BacklogRow = RowDataPacket & { remaining: number };
type ResourceRow = RowDataPacket & {
  id: string;
  userId: number;
  kind: "task" | "file";
  upstreamId: string;
  contentDeletedAt: Date | null;
};
type ReferenceRow = RowDataPacket & { conversationId: string };

function positiveInteger(value: number, label: string) {
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(`${label}必须是大于 0 的整数`);
  }
  return value;
}

export function getConversationRetentionCutoff(
  retentionDays = DEFAULT_CONVERSATION_RETENTION_DAYS,
  now = new Date(),
) {
  positiveInteger(retentionDays, "保留天数");
  return new Date(now.getTime() - retentionDays * 24 * 60 * 60 * 1_000);
}

function placeholders(length: number) {
  return Array.from({ length }, () => "?").join(",");
}

async function hasExpiredConversationBacklog(
  connection: Connection,
  cutoff: Date,
) {
  const [rows] = await connection.execute<BacklogRow[]>(
    `SELECT EXISTS(
       SELECT 1
        FROM conversations
        WHERE updatedAt <= ?
        LIMIT 1
     ) AS remaining`,
    [cutoff],
  );
  return Number(rows[0]?.remaining ?? 0) === 1;
}

function publicConversationId(row: ConversationRow) {
  const prefix = `u${row.userId}:`;
  return row.id.startsWith(prefix) ? row.id.slice(prefix.length) : row.id;
}

/**
 * Lock the compact retention tombstone slot, then the unique build identity,
 * then (in the caller) the conversation. This is the same order as the
 * knowledge-base start path. Missing unique keys are gap-locked until commit.
 */
async function lockKnowledgeBaseBuilds(
  connection: Connection,
  rows: ConversationRow[],
) {
  const builds: KnowledgeBuildRow[] = [];
  for (const row of rows) {
    const publicId = publicConversationId(row);
    await connection.execute(
      `SELECT id
         FROM knowledge_base_conversation_retention_tombstones
        WHERE userId = ?
          AND publicConversationId = ?
        LIMIT 1
        FOR UPDATE`,
      [row.userId, publicId],
    );
    const [matches] = await connection.execute<KnowledgeBuildRow[]>(
      `SELECT id, userId, generation, conversationId, logoStorageKey, packageStorageKey
         FROM knowledge_base_builds
        WHERE userId = ?
          AND conversationId = ?
        LIMIT 1
        FOR UPDATE`,
      [row.userId, publicId],
    );
    if (matches[0]) builds.push(matches[0]);
  }
  return builds;
}

async function prepareKnowledgeBuildCleanup(
  connection: Connection,
  builds: KnowledgeBuildRow[],
  now: Date,
) {
  for (const build of builds) {
    await connection.execute(
      `INSERT INTO knowledge_base_conversation_retention_tombstones
         (id, userId, publicConversationId, resetAt, createdAt)
       VALUES (UUID(), ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE resetAt = VALUES(resetAt)`,
      [build.userId, build.conversationId, now, now],
    );
    for (const localAssetKey of [
      build.logoStorageKey,
      build.packageStorageKey,
      optionalKnowledgeBaseUploadEvidenceStorageKey({
        userId: build.userId,
        buildId: build.id,
        generation: build.generation,
      }),
    ]) {
      if (!localAssetKey) continue;
      await connection.execute(
        `INSERT INTO knowledge_base_reset_cleanup_jobs
           (id, resetRequestId, userId, apiCredentialId, kind,
            localAssetKey, upstreamId, status, attemptCount, createdAt, updatedAt)
         VALUES (UUID(), NULL, ?, NULL, 'local_asset', ?, SHA2(?, 256),
                 'pending', 0, ?, ?)`,
        [build.userId, localAssetKey, localAssetKey, now, now],
      );
    }
  }
  for (const build of builds) {
    await connection.execute("DELETE FROM knowledge_base_builds WHERE id = ?", [
      build.id,
    ]);
  }
  return builds.length;
}

async function lockEligibleConversations(
  connection: Connection,
  rows: ConversationRow[],
  cutoff: Date,
) {
  if (!rows.length) return [];
  const [locked] = await connection.execute<ConversationRow[]>(
    `SELECT id, userId
       FROM conversations
      WHERE id IN (${placeholders(rows.length)})
        AND updatedAt <= ?
      ORDER BY updatedAt ASC, id ASC
      FOR UPDATE`,
    [...rows.map((row) => row.id), cutoff],
  );
  return locked;
}

async function relatedCount(
  connection: Connection,
  table: "messages" | "attachments" | "conversation_turns",
  conversationIds: string[],
) {
  const [rows] = await connection.execute<CountRow[]>(
    `SELECT COUNT(*) AS count FROM ${table} WHERE conversationId IN (${placeholders(conversationIds.length)})`,
    conversationIds,
  );
  return Number(rows[0]?.count ?? 0);
}

async function prepareResourceCleanup(
  connection: Connection,
  conversationIds: string[],
) {
  const [resources] = await connection.execute<ResourceRow[]>(
    `SELECT id, userId, kind, upstreamId, contentDeletedAt
       FROM upstream_resources
      WHERE conversationId IN (${placeholders(conversationIds.length)})
      FOR UPDATE`,
    conversationIds,
  );
  let fileResourcesQueued = 0;
  let taskResourcesDeleted = 0;

  for (const resource of resources) {
    if (resource.kind === "task") {
      const [conversationReferences] = await connection.execute<ReferenceRow[]>(
        `SELECT id AS conversationId
           FROM conversations
          WHERE id NOT IN (${placeholders(conversationIds.length)})
            AND (upstreamTaskId = ? OR previousResponseId = ?)
          ORDER BY updatedAt DESC
          LIMIT 1`,
        [...conversationIds, resource.upstreamId, resource.upstreamId],
      );
      let survivingConversationId = conversationReferences[0]?.conversationId;
      let persistedSurvivingConversationId = survivingConversationId;
      if (!survivingConversationId) {
        const [turnReferences] = await connection.execute<ReferenceRow[]>(
          `SELECT conversationId
             FROM conversation_turns
            WHERE userId = ?
              AND upstreamTaskId = ?
              AND conversationId NOT IN (${placeholders(conversationIds.length)})
            ORDER BY createdAt ASC
            LIMIT 1`,
          [resource.userId, resource.upstreamId, ...conversationIds],
        );
        survivingConversationId = turnReferences[0]?.conversationId;
        persistedSurvivingConversationId = survivingConversationId;
      }
      if (!survivingConversationId) {
        const expiringPublicIds = conversationIds.map((conversationId) => {
          const prefix = `u${resource.userId}:`;
          return conversationId.startsWith(prefix)
            ? conversationId.slice(prefix.length)
            : conversationId;
        });
        const [buildReferences] = await connection.execute<ReferenceRow[]>(
          `SELECT conversationId
             FROM knowledge_base_builds
            WHERE userId = ?
              AND (upstreamTaskId = ? OR packageTaskId = ?)
              AND conversationId NOT IN (${placeholders(expiringPublicIds.length)})
            LIMIT 1`,
          [
            resource.userId,
            resource.upstreamId,
            resource.upstreamId,
            ...expiringPublicIds,
          ],
        );
        survivingConversationId = buildReferences[0]?.conversationId;
      }
      if (survivingConversationId) {
        // A surviving KB build can exist briefly before its browser snapshot
        // is persisted. In that case leave the resource detached rather than
        // writing a public id into the internal conversation foreign key.
        await connection.execute(
          "UPDATE upstream_resources SET conversationId = ? WHERE id = ?",
          [persistedSurvivingConversationId ?? null, resource.id],
        );
        continue;
      }
      const [deleted] = await connection.execute<ResultSetHeader>(
        "DELETE FROM upstream_resources WHERE id = ?",
        [resource.id],
      );
      taskResourcesDeleted += deleted.affectedRows;
      continue;
    }

    const [surviving] = await connection.execute<ReferenceRow[]>(
      `SELECT conversationId
         FROM attachments
        WHERE userId = ?
          AND upstreamFileId = ?
          AND deletedAt IS NULL
          AND conversationId NOT IN (${placeholders(conversationIds.length)})
        ORDER BY createdAt ASC
        LIMIT 1`,
      [resource.userId, resource.upstreamId, ...conversationIds],
    );
    let survivingConversationId = surviving[0]?.conversationId;
    if (!survivingConversationId) {
      const [turnReferences] = await connection.execute<ReferenceRow[]>(
        `SELECT conversationId
           FROM conversation_turns
          WHERE userId = ?
            AND JSON_CONTAINS(attachmentFileIds, JSON_QUOTE(?), '$')
            AND conversationId NOT IN (${placeholders(conversationIds.length)})
          ORDER BY createdAt ASC
          LIMIT 1`,
        [resource.userId, resource.upstreamId, ...conversationIds],
      );
      survivingConversationId = turnReferences[0]?.conversationId;
    }
    if (survivingConversationId) {
      await connection.execute(
        "UPDATE upstream_resources SET conversationId = ? WHERE id = ?",
        [survivingConversationId, resource.id],
      );
      continue;
    }

    if (resource.contentDeletedAt) {
      await connection.execute("DELETE FROM upstream_resources WHERE id = ?", [
        resource.id,
      ]);
      continue;
    }

    // Conversation deletion must not shorten the independent upload clock.
    // Detach the ownership row and synthesize a legacy clock only when none
    // exists. The hourly file worker will revoke/delete at that original
    // deadline and will re-check references, including any concurrent attach.
    await connection.execute(
      `UPDATE upstream_resources
          SET conversationId = NULL,
              uploadedAt = COALESCE(uploadedAt, createdAt),
              contentExpiresAt = COALESCE(
                contentExpiresAt,
                DATE_ADD(COALESCE(uploadedAt, createdAt), INTERVAL 30 DAY)
              )
        WHERE id = ?`,
      [resource.id],
    );
    fileResourcesQueued += 1;
  }
  return { fileResourcesQueued, taskResourcesDeleted };
}

/**
 * Permanently removes conversations that have not been updated during the
 * retention window. Foreign keys atomically cascade to turns, messages, and
 * attachment rows. Unreferenced file bytes are queued for the independent
 * hard-expiry worker instead of being removed inside the database transaction.
 */
export async function cleanupExpiredConversations(
  connection: Connection,
  retentionDays = DEFAULT_CONVERSATION_RETENTION_DAYS,
  now = new Date(),
  options?: { batchSize?: number; maxBatches?: number },
): Promise<ConversationRetentionResult> {
  const cutoff = getConversationRetentionCutoff(retentionDays, now);
  const batchSize = positiveInteger(
    options?.batchSize ?? DEFAULT_CONVERSATION_RETENTION_BATCH_SIZE,
    "会话清理批大小",
  );
  const maxBatches = positiveInteger(
    options?.maxBatches ?? DEFAULT_CONVERSATION_RETENTION_MAX_BATCHES,
    "会话清理批次数",
  );
  const result: ConversationRetentionResult = {
    cutoff,
    batches: 0,
    truncated: false,
    conversations: 0,
    messages: 0,
    attachments: 0,
    turns: 0,
    knowledgeBuilds: 0,
    fileResourcesQueued: 0,
    taskResourcesDeleted: 0,
  };

  for (let batch = 0; batch < maxBatches; batch += 1) {
    await connection.beginTransaction();
    try {
      const [rows] = await connection.execute<ConversationRow[]>(
        `SELECT id, userId
           FROM conversations
          WHERE updatedAt <= ?
          ORDER BY updatedAt ASC, id ASC
          LIMIT ?`,
        [cutoff, batchSize],
      );
      if (!rows.length) {
        await connection.commit();
        break;
      }
      // Lock the build unique slots before the conversation rows, matching the
      // reset path. Missing rows are gap-locked; existing rows are tombstoned
      // before deletion so a stale browser cannot recreate an expired build.
      const knowledgeBuilds = await lockKnowledgeBaseBuilds(connection, rows);
      const lockedRows = await lockEligibleConversations(
        connection,
        rows,
        cutoff,
      );
      const conversationIds = lockedRows.map((row) => row.id);
      if (!conversationIds.length) {
        await connection.commit();
        continue;
      }

      const [messages, attachments, turns] = await Promise.all([
        relatedCount(connection, "messages", conversationIds),
        relatedCount(connection, "attachments", conversationIds),
        relatedCount(connection, "conversation_turns", conversationIds),
      ]);
      const resources = await prepareResourceCleanup(
        connection,
        conversationIds,
      );
      const knowledgeBuildCount = await prepareKnowledgeBuildCleanup(
        connection,
        knowledgeBuilds.filter(
          (build) =>
            conversationIds.includes(
              `u${build.userId}:${build.conversationId}`,
            ) || conversationIds.includes(build.conversationId),
        ),
        now,
      );
      const [deleted] = await connection.execute<ResultSetHeader>(
        `DELETE FROM conversations
          WHERE id IN (${placeholders(conversationIds.length)})
            AND updatedAt <= ?`,
        [...conversationIds, cutoff],
      );
      if (deleted.affectedRows !== conversationIds.length) {
        // A build or last-moment update won the race. Roll back the resource
        // detach/queue operations together with the partial conversation delete.
        await connection.rollback();
        continue;
      }
      await connection.commit();

      result.batches += 1;
      result.conversations += deleted.affectedRows;
      result.messages += messages;
      result.attachments += attachments;
      result.turns += turns;
      result.knowledgeBuilds += knowledgeBuildCount;
      result.fileResourcesQueued += resources.fileResourcesQueued;
      result.taskResourcesDeleted += resources.taskResourcesDeleted;
      if (rows.length < batchSize) break;
    } catch (error) {
      await connection.rollback();
      throw error;
    }
  }
  result.truncated = await hasExpiredConversationBacklog(connection, cutoff);
  return result;
}

type RetentionLockConnection = Connection & {
  end: () => Promise<void>;
};

export async function runConversationRetentionCleanup(input?: {
  databaseUrl?: string;
  createConnection?: (url: string) => Promise<RetentionLockConnection>;
  cleanup?: (connection: Connection) => Promise<ConversationRetentionResult>;
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
      CONVERSATION_RETENTION_LOCK_NAME,
    ]);
    acquired = Number((rows as any)?.[0]?.acquired ?? 0) === 1;
    if (!acquired) return { acquired: false as const, result: null };
    const cleanup =
      input?.cleanup ??
      ((activeConnection: Connection) =>
        cleanupExpiredConversations(
          activeConnection,
          DEFAULT_CONVERSATION_RETENTION_DAYS,
        ));
    return {
      acquired: true as const,
      result: await cleanup(connection),
    };
  } finally {
    if (acquired) {
      await connection
        .query("SELECT RELEASE_LOCK(?) AS released", [
          CONVERSATION_RETENTION_LOCK_NAME,
        ])
        .catch(() => undefined);
    }
    await connection.end();
  }
}

export function startConversationRetentionScheduler(input?: {
  initialDelayMs?: number;
  intervalMs?: number;
  run?: typeof runConversationRetentionCleanup;
}) {
  let running = false;
  const runCleanup = input?.run ?? runConversationRetentionCleanup;
  const run = () => {
    if (running) return;
    running = true;
    runCleanup()
      .then((execution) => {
        if (!execution.acquired || !execution.result) return;
        console.info(
          "[Conversation retention] Cleanup complete",
          JSON.stringify(execution.result),
        );
      })
      .catch((error) => {
        console.error(
          "[Conversation retention] Cleanup failed",
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
    input?.intervalMs ?? CONVERSATION_RETENTION_INTERVAL_MS,
  );
  interval.unref?.();
  return () => {
    clearTimeout(initial);
    clearInterval(interval);
  };
}
