import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";

import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/mysql2";
import { migrate } from "drizzle-orm/mysql2/migrator";
import mysql, {
  type Pool,
  type ResultSetHeader,
  type RowDataPacket,
} from "mysql2/promise";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  apiUsagePolicies,
  apiUsageSnapshots,
  conversations,
} from "../drizzle/schema";

import {
  KnowledgeBaseTurnReservationError,
  claimKnowledgeBaseTurnForRecovery,
  knowledgeBaseConversationStorageId,
  reserveKnowledgeBaseStartBuild,
  reserveKnowledgeBaseTurn,
} from "../server/knowledge-base-turn-service";
import {
  claimKnowledgeBaseOpenRecoveryBuild,
  releaseKnowledgeBaseOpenRecoveryLease,
} from "../server/knowledge-base-open-recovery-lease";
import {
  loadConversationSnapshotRowForUpdateIfPresent,
  runConversationWriteTransaction,
} from "../server/conversation-router";
import { cleanupExpiredDeliveryTickets } from "../server/delivery-ticket-retention";
import {
  claimUsageSnapshotRefresh,
  finalizeApiUsageSnapshotClaim,
} from "../server/api-usage-snapshot-service";
import { prepareKnowledgeResetCleanupResource } from "../server/knowledge-base-reset-service";

const ACCEPTANCE_ENV = "FRONTMIND_KB_MYSQL_ACCEPTANCE_DATABASE_URL";
const REQUIRED_ENV = "FRONTMIND_KB_MYSQL_ACCEPTANCE_REQUIRED";
const DATABASE_MARKER = "frontmind_kb_acceptance";

type AcceptanceTarget = { url: string; databaseName: string };

export function parseKnowledgeBaseMysqlAcceptanceTarget(
  rawValue: string | undefined,
): AcceptanceTarget {
  const value = rawValue?.trim();
  if (!value) throw new Error(`${ACCEPTANCE_ENV}_MISSING`);
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error(`${ACCEPTANCE_ENV}_INVALID`);
  }
  if (parsed.protocol !== "mysql:") {
    throw new Error(`${ACCEPTANCE_ENV}_MUST_USE_MYSQL`);
  }
  if (
    [...parsed.searchParams.keys()].some((key) =>
      ["database", "schema", "db"].includes(key.toLowerCase()),
    )
  ) {
    throw new Error(`${ACCEPTANCE_ENV}_DATABASE_OVERRIDE_FORBIDDEN`);
  }
  const encodedDatabaseName = parsed.pathname.replace(/^\/+/, "");
  let databaseName = "";
  try {
    databaseName = decodeURIComponent(encodedDatabaseName);
  } catch {
    throw new Error(`${ACCEPTANCE_ENV}_DATABASE_INVALID`);
  }
  if (
    !databaseName ||
    databaseName.includes("/") ||
    !/^[A-Za-z0-9_$-]+$/u.test(databaseName) ||
    !databaseName.toLowerCase().includes(DATABASE_MARKER)
  ) {
    throw new Error(`${ACCEPTANCE_ENV}_DATABASE_NOT_DISPOSABLE`);
  }
  return { url: value, databaseName };
}

function mysqlCode(error: unknown) {
  return typeof error === "object" && error !== null && "code" in error
    ? String((error as { code?: unknown }).code || "")
    : "";
}

async function settleTurnAndAdvanceBuild(input: {
  pool: Pool;
  buildId: string;
  turnId: string;
  generation: number;
  nextGeneration: number;
  revision: number;
  leafId: string;
}) {
  const connection = await input.pool.getConnection();
  try {
    await connection.beginTransaction();
    const [turnResult] = await connection.execute<ResultSetHeader>(
      `UPDATE conversation_turns
       SET status = 'completed', leaseExpiresAt = NULL,
           completedAt = CURRENT_TIMESTAMP, updatedAt = CURRENT_TIMESTAMP
       WHERE id = ? AND buildId = ? AND buildGeneration = ?`,
      [input.turnId, input.buildId, input.generation],
    );
    expect(turnResult.affectedRows).toBe(1);
    const [buildResult] = await connection.execute<ResultSetHeader>(
      `UPDATE knowledge_base_builds
       SET status = 'confirming', generation = ?, revision = ?,
           currentLeafId = ?, activeTurnId = NULL,
           stateEpoch = stateEpoch + 1, updatedAt = CURRENT_TIMESTAMP
       WHERE id = ? AND generation = ? AND activeTurnId = ?`,
      [
        input.nextGeneration,
        input.revision,
        input.leafId,
        input.buildId,
        input.generation,
        input.turnId,
      ],
    );
    expect(buildResult.affectedRows).toBe(1);
    await connection.commit();
  } catch (error) {
    await connection.rollback();
    throw error;
  } finally {
    connection.release();
  }
}

async function conditionalApply(input: {
  pool: Pool;
  buildId: string;
  turnId: string;
  generation: number;
  expectedRevision: number;
  expectedLeafId: string;
  nextRevision: number;
  nextLeafId: string;
  operationKey: string;
}) {
  const connection = await input.pool.getConnection();
  try {
    await connection.beginTransaction();
    await connection.execute(
      "SELECT id FROM knowledge_base_builds WHERE id = ? FOR UPDATE",
      [input.buildId],
    );
    const [result] = await connection.execute<ResultSetHeader>(
      `UPDATE knowledge_base_builds
       SET revision = ?, currentLeafId = ?, activeTurnId = NULL,
           lastAppliedOperationKey = ?, stateEpoch = stateEpoch + 1,
           updatedAt = CURRENT_TIMESTAMP
       WHERE id = ? AND generation = ? AND revision = ?
         AND currentLeafId = ? AND activeTurnId = ?`,
      [
        input.nextRevision,
        input.nextLeafId,
        input.operationKey,
        input.buildId,
        input.generation,
        input.expectedRevision,
        input.expectedLeafId,
        input.turnId,
      ],
    );
    if (result.affectedRows === 1) {
      const [turnResult] = await connection.execute<ResultSetHeader>(
        `UPDATE conversation_turns
         SET status = 'completed', leaseExpiresAt = NULL,
             completedAt = CURRENT_TIMESTAMP, updatedAt = CURRENT_TIMESTAMP
         WHERE id = ? AND buildId = ? AND buildGeneration = ?`,
        [input.turnId, input.buildId, input.generation],
      );
      expect(turnResult.affectedRows).toBe(1);
    }
    await connection.commit();
    return result.affectedRows;
  } catch (error) {
    await connection.rollback();
    throw error;
  } finally {
    connection.release();
  }
}

describe("knowledge-base MySQL acceptance URL guard", () => {
  it("accepts only a dedicated MySQL database whose name contains the marker", () => {
    expect(
      parseKnowledgeBaseMysqlAcceptanceTarget(
        "mysql://tester:secret@127.0.0.1:3306/frontmind_kb_acceptance_ci_01",
      ).databaseName,
    ).toBe("frontmind_kb_acceptance_ci_01");
    for (const unsafe of [
      undefined,
      "postgres://tester:secret@127.0.0.1/frontmind_kb_acceptance",
      "mysql://tester:secret@127.0.0.1/frontmind_production",
      "mysql://tester:secret@127.0.0.1/frontmind_kb_acceptance/other",
      "mysql://tester:secret@127.0.0.1/frontmind_kb_acceptance?database=frontmind_production",
    ]) {
      expect(() => parseKnowledgeBaseMysqlAcceptanceTarget(unsafe)).toThrow();
    }
  });
});

const acceptanceUrl = process.env[ACCEPTANCE_ENV]?.trim();
if (process.env[REQUIRED_ENV] === "1" && !acceptanceUrl) {
  throw new Error(`${ACCEPTANCE_ENV}_REQUIRED_FOR_RELEASE_GATE`);
}
const mysqlDescribe = acceptanceUrl ? describe.sequential : describe.skip;

mysqlDescribe("knowledge-base real MySQL state-machine acceptance", () => {
  let pool: Pool;
  let executor: ReturnType<typeof drizzle>;
  let target: AcceptanceTarget;
  let userId: number | null = null;
  const runId = randomUUID().replaceAll("-", "");

  beforeAll(async () => {
    target = parseKnowledgeBaseMysqlAcceptanceTarget(acceptanceUrl);
    pool = mysql.createPool({
      uri: target.url,
      connectionLimit: 12,
      multipleStatements: false,
    });
    const [databaseRows] = await pool.query<RowDataPacket[]>(
      "SELECT DATABASE() AS databaseName",
    );
    expect(String(databaseRows[0]?.databaseName || "")).toBe(
      target.databaseName,
    );
    const [preMigrationRows] = await pool.query<RowDataPacket[]>(
      `SELECT COUNT(*) AS tableCount
       FROM information_schema.tables
       WHERE table_schema = DATABASE()`,
    );
    if (Number(preMigrationRows[0]?.tableCount || 0) !== 0) {
      throw new Error(`${ACCEPTANCE_ENV}_DATABASE_MUST_BE_EMPTY`);
    }

    executor = drizzle(pool);
    await migrate(executor, {
      migrationsFolder: path.resolve(process.cwd(), "drizzle"),
    });
    const journal = JSON.parse(
      await readFile(
        path.resolve(process.cwd(), "drizzle/meta/_journal.json"),
        "utf8",
      ),
    ) as { entries: unknown[] };
    const [ledgerRows] = await pool.query<RowDataPacket[]>(
      "SELECT COUNT(*) AS migrationCount FROM __drizzle_migrations",
    );
    expect(Number(ledgerRows[0]?.migrationCount || 0)).toBe(
      journal.entries.length,
    );
    const [engineRows] = await pool.query<RowDataPacket[]>(
      `SELECT TABLE_NAME AS tableName, ENGINE AS engine
       FROM information_schema.tables
       WHERE table_schema = DATABASE()
         AND table_name IN (
           'knowledge_base_builds', 'conversation_turns', 'conversations'
         )`,
    );
    expect(engineRows).toHaveLength(3);
    expect(engineRows.every((row) => row.engine === "InnoDB")).toBe(true);

    const [userResult] = await pool.execute<ResultSetHeader>(
      `INSERT INTO users (openId, username, displayName)
       VALUES (?, ?, ?)`,
      [
        `kb-mysql-${runId}`.slice(0, 64),
        `kb_mysql_${runId}`.slice(0, 64),
        "KB MySQL acceptance",
      ],
    );
    userId = userResult.insertId;
  }, 300_000);

  afterAll(async () => {
    if (pool && userId) {
      await pool.execute("DELETE FROM users WHERE id = ?", [userId]);
    }
    if (pool) await pool.end();
  }, 60_000);

  it("inserts concurrent new conversation snapshots without PRIMARY gap deadlocks", async () => {
    expect(userId).not.toBeNull();
    const ids = [`u${userId}:conv-${runId}-a`, `u${userId}:conv-${runId}-b`];
    let readyCount = 0;
    let releaseBoth!: () => void;
    const bothSelected = new Promise<void>((resolve) => {
      releaseBoth = resolve;
    });

    const insertSnapshot = (id: string) =>
      runConversationWriteTransaction(executor, async (tx) => {
        const selected = await loadConversationSnapshotRowForUpdateIfPresent(
          tx,
          id,
        );
        expect(selected.observedExisting).toBe(false);
        expect(selected.existing).toBeUndefined();
        readyCount += 1;
        if (readyCount === ids.length) releaseBoth();
        await bothSelected;
        const now = new Date();
        await tx.insert(conversations).values({
          id,
          userId: userId!,
          title: "KB concurrent draft",
          status: "idle",
          deletedMessageIds: [],
          version: 1,
          createdAt: now,
          updatedAt: now,
        });
      });

    await Promise.all(ids.map((id) => insertSnapshot(id)));
    const [rows] = await pool.query<RowDataPacket[]>(
      "SELECT COUNT(*) AS conversationCount FROM conversations WHERE id IN (?, ?)",
      ids,
    );
    expect(Number(rows[0]?.conversationCount || 0)).toBe(2);
  });

  it("finalizes a rounded TIMESTAMP claim and lets only the latest delayed token win", async () => {
    expect(userId).not.toBeNull();
    const policyId = randomUUID();
    await executor.insert(apiUsagePolicies).values({
      id: policyId,
      policyKey: `managed_user:${userId}:${runId}`,
      scope: "managed_user",
      workspaceUserId: userId!,
    });
    const [policy] = await executor
      .select()
      .from(apiUsagePolicies)
      .where(eq(apiUsagePolicies.id, policyId));
    expect(policy).toBeDefined();

    const baseNowMs = Math.floor(Date.now() / 1_000) * 1_000;
    // Production uses second-precision TIMESTAMP columns. A .750 millisecond
    // fraction rounds into the next second in MySQL 8.4, which previously made
    // an additional `updatedAt <= now` predicate reject the rightful token.
    const firstNow = new Date(baseNowMs + 750);
    const firstToken = await claimUsageSnapshotRefresh({
      executor,
      policy: policy!,
      now: firstNow,
    });

    let rows = await executor
      .select()
      .from(apiUsageSnapshots)
      .where(eq(apiUsageSnapshots.policyId, policyId));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.updatedAt.getTime()).toBe(baseNowMs + 1_000);

    await finalizeApiUsageSnapshotClaim({
      executor,
      policy: policy!,
      credentialFingerprint: "fp_mysql_acceptance",
      used: 111,
      accountUsed: 11,
      status: "ok",
      now: firstNow,
      syncToken: firstToken,
    });
    rows = await executor
      .select()
      .from(apiUsageSnapshots)
      .where(eq(apiUsageSnapshots.policyId, policyId));
    expect(rows[0]).toMatchObject({
      syncStatus: "ok",
      used: 111,
      accountUsed: 11,
      syncGeneration: 1,
      syncToken: firstToken,
    });

    const secondNow = new Date(baseNowMs + 2_750);
    const secondToken = await claimUsageSnapshotRefresh({
      executor,
      policy: policy!,
      now: secondNow,
    });
    const latestNow = new Date(baseNowMs + 4_750);
    const latestToken = await claimUsageSnapshotRefresh({
      executor,
      policy: policy!,
      now: latestNow,
    });

    rows = await executor
      .select()
      .from(apiUsageSnapshots)
      .where(eq(apiUsageSnapshots.policyId, policyId));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      syncGeneration: 3,
      syncToken: latestToken,
      syncStatus: "ok",
      used: 111,
    });
    expect(firstToken).not.toBe(secondToken);
    expect(secondToken).not.toBe(latestToken);

    await finalizeApiUsageSnapshotClaim({
      executor,
      policy: policy!,
      credentialFingerprint: "fp_mysql_acceptance",
      used: 222,
      accountUsed: 22,
      status: "ok",
      now: secondNow,
      syncToken: secondToken,
    });
    rows = await executor
      .select()
      .from(apiUsageSnapshots)
      .where(eq(apiUsageSnapshots.policyId, policyId));
    expect(rows[0]).toMatchObject({
      syncStatus: "ok",
      used: 111,
      accountUsed: 11,
      syncToken: latestToken,
    });

    await finalizeApiUsageSnapshotClaim({
      executor,
      policy: policy!,
      credentialFingerprint: "fp_mysql_acceptance",
      used: 333,
      accountUsed: 33,
      status: "ok",
      now: latestNow,
      syncToken: latestToken,
    });
    rows = await executor
      .select()
      .from(apiUsageSnapshots)
      .where(eq(apiUsageSnapshots.policyId, policyId));
    expect(rows[0]).toMatchObject({
      syncStatus: "ok",
      used: 333,
      accountUsed: 33,
      syncGeneration: 3,
      syncToken: latestToken,
    });
  });

  it("purges expired delivery records while retaining compact workflow facts", async () => {
    expect(userId).not.toBeNull();
    const ownerId = userId!;
    const contractId = randomUUID();
    const quotaPeriodId = randomUUID();
    const expiredContentTicketId = randomUUID();
    const expiredResetTicketId = randomUUID();
    const recentTicketId = randomUUID();
    const resetRequestId = randomUUID();
    const now = new Date("2026-08-02T12:00:00.000Z");
    const expiredAt = new Date("2026-06-01T12:00:00.000Z");
    const recentAt = new Date("2026-07-20T12:00:00.000Z");

    await pool.execute(
      `INSERT INTO service_contracts
         (id, userId, planCode, startsAt, endsAt, revision)
       VALUES (?, ?, 'basic', ?, ?, 1)`,
      [
        contractId,
        ownerId,
        new Date("2026-01-01T00:00:00.000Z"),
        new Date("2027-01-01T00:00:00.000Z"),
      ],
    );
    await pool.execute(
      `INSERT INTO service_quota_periods
         (id, contractId, userId, ordinal, startsAt, endsAt,
          contentAssetPublishLimit, websiteContentPublishLimit)
       VALUES (?, ?, ?, 1, ?, ?, 10, 10)`,
      [
        quotaPeriodId,
        contractId,
        ownerId,
        new Date("2026-01-01T00:00:00.000Z"),
        new Date("2027-01-01T00:00:00.000Z"),
      ],
    );
    await pool.execute(
      `INSERT INTO delivery_tickets
         (id, userId, contractId, quotaPeriodId, type, quotaPool, ordinal,
          clientRequestId, operation, contentAssetIds, status, quotaState,
          resolvedAt, createdAt, updatedAt)
       VALUES (?, ?, ?, ?, 'content_asset', 'content_asset_publish', 1,
               ?, 'content_asset_publish', JSON_ARRAY('asset-retained'),
               'completed', 'consumed', ?, ?, ?)`,
      [
        expiredContentTicketId,
        ownerId,
        contractId,
        quotaPeriodId,
        randomUUID(),
        expiredAt,
        expiredAt,
        expiredAt,
      ],
    );
    await pool.execute(
      `INSERT INTO delivery_tickets
         (id, userId, contractId, quotaPeriodId, type, ordinal,
          clientRequestId, status, quotaState, resolvedAt, createdAt, updatedAt)
       VALUES (?, ?, ?, ?, 'knowledge_base', 1, ?, 'completed', 'released',
               ?, ?, ?)`,
      [
        expiredResetTicketId,
        ownerId,
        contractId,
        quotaPeriodId,
        randomUUID(),
        expiredAt,
        expiredAt,
        expiredAt,
      ],
    );
    await pool.execute(
      `INSERT INTO delivery_tickets
         (id, userId, contractId, quotaPeriodId, type, quotaPool, ordinal,
          clientRequestId, operation, contentAssetIds, status, quotaState,
          resolvedAt, createdAt, updatedAt)
       VALUES (?, ?, ?, ?, 'content_asset', 'content_asset_publish', 2,
               ?, 'content_asset_publish', JSON_ARRAY('asset-recent'),
               'completed', 'consumed', ?, ?, ?)`,
      [
        recentTicketId,
        ownerId,
        contractId,
        quotaPeriodId,
        randomUUID(),
        recentAt,
        recentAt,
        recentAt,
      ],
    );
    const expiredEventId = randomUUID();
    await pool.execute(
      `INSERT INTO delivery_ticket_events
         (id, ticketId, userId, actorRole, kind, message, createdAt)
       VALUES (?, ?, ?, 'system', 'created', 'expired event', ?)`,
      [expiredEventId, expiredContentTicketId, ownerId, expiredAt],
    );
    await pool.execute(
      `INSERT INTO delivery_ticket_attachments
         (id, ticketId, eventId, workspaceUserId, ownerUserId, filename, createdAt)
       VALUES (?, ?, ?, ?, ?, 'expired.txt', ?)`,
      [
        randomUUID(),
        expiredContentTicketId,
        expiredEventId,
        ownerId,
        ownerId,
        expiredAt,
      ],
    );
    await pool.execute(
      `INSERT INTO knowledge_base_reset_requests
         (id, ticketId, userId, reasonCode, status, createdAt, updatedAt)
       VALUES (?, ?, ?, 'stuck', 'approved', ?, ?)`,
      [resetRequestId, expiredResetTicketId, ownerId, expiredAt, expiredAt],
    );
    await pool.execute(
      `INSERT INTO knowledge_base_conversation_tombstones
         (id, userId, publicConversationId, resetRequestId, createdAt)
       VALUES (?, ?, ?, ?, ?)`,
      [randomUUID(), ownerId, `retention-${runId}`, resetRequestId, expiredAt],
    );
    await pool.execute(
      `INSERT INTO knowledge_base_reset_cleanup_jobs
         (id, resetRequestId, userId, kind, upstreamId, status,
          attemptCount, completedAt, createdAt, updatedAt)
       VALUES
         (?, ?, ?, 'file', 'completed-resource', 'completed', 1, ?, ?, ?),
         (?, ?, ?, 'task', 'failed-resource', 'failed', 3, NULL, ?, ?)`,
      [
        randomUUID(),
        resetRequestId,
        ownerId,
        expiredAt,
        expiredAt,
        expiredAt,
        randomUUID(),
        resetRequestId,
        ownerId,
        expiredAt,
        expiredAt,
      ],
    );

    await expect(
      cleanupExpiredDeliveryTickets({ database: executor, now }),
    ).resolves.toMatchObject({
      tickets: 2,
      milestones: 1,
      quotaFacts: 1,
      resetRequests: 1,
    });

    const [ticketRows] = await pool.query<RowDataPacket[]>(
      "SELECT id FROM delivery_tickets WHERE id IN (?, ?, ?) ORDER BY id",
      [expiredContentTicketId, expiredResetTicketId, recentTicketId],
    );
    expect(ticketRows.map((row) => row.id)).toEqual([recentTicketId]);
    const [quotaRows] = await pool.query<RowDataPacket[]>(
      `SELECT archivedContentAssetPublishUsed AS archivedUsed
         FROM service_quota_periods WHERE id = ?`,
      [quotaPeriodId],
    );
    expect(Number(quotaRows[0]?.archivedUsed || 0)).toBe(1);
    const [milestoneRows] = await pool.query<RowDataPacket[]>(
      `SELECT contentAssetIds FROM delivery_workflow_milestones
         WHERE userId = ? AND operation = 'content_asset_publish'`,
      [ownerId],
    );
    expect(milestoneRows).toHaveLength(1);
    const retainedAssetIds =
      typeof milestoneRows[0]?.contentAssetIds === "string"
        ? JSON.parse(String(milestoneRows[0].contentAssetIds))
        : milestoneRows[0]?.contentAssetIds;
    expect(retainedAssetIds).toEqual(["asset-retained"]);
    const [dependentRows] = await pool.query<RowDataPacket[]>(
      `SELECT
         (SELECT COUNT(*) FROM delivery_ticket_events
           WHERE ticketId = ?) AS eventCount,
         (SELECT COUNT(*) FROM delivery_ticket_attachments
           WHERE ticketId = ?) AS attachmentCount,
         (SELECT COUNT(*) FROM knowledge_base_reset_requests
           WHERE id = ?) AS requestCount,
         (SELECT COUNT(*) FROM knowledge_base_conversation_tombstones
           WHERE resetRequestId = ?) AS verboseTombstoneCount,
         (SELECT COUNT(*) FROM knowledge_base_conversation_retention_tombstones
           WHERE userId = ? AND publicConversationId = ?) AS compactTombstoneCount`,
      [
        expiredContentTicketId,
        expiredContentTicketId,
        resetRequestId,
        resetRequestId,
        ownerId,
        `retention-${runId}`,
      ],
    );
    expect(dependentRows[0]).toMatchObject({
      eventCount: 0,
      attachmentCount: 0,
      requestCount: 0,
      verboseTombstoneCount: 0,
      compactTombstoneCount: 1,
    });
    const [cleanupRows] = await pool.query<RowDataPacket[]>(
      `SELECT status, resetRequestId FROM knowledge_base_reset_cleanup_jobs
         WHERE upstreamId IN ('completed-resource', 'failed-resource')
         ORDER BY upstreamId`,
    );
    expect(cleanupRows).toEqual([{ status: "failed", resetRequestId: null }]);
    await expect(
      cleanupExpiredDeliveryTickets({ database: executor, now }),
    ).resolves.toMatchObject({ tickets: 0, quotaFacts: 0, milestones: 0 });
  }, 120_000);

  it("stores a long local cleanup key losslessly behind its queue identity", async () => {
    expect(userId).not.toBeNull();
    const ownerId = userId!;
    const localAssetKey = `knowledge-builds/${ownerId}/${"a".repeat(320)}/official-logo.bin`;
    const resource = prepareKnowledgeResetCleanupResource({
      kind: "local_asset",
      upstreamId: localAssetKey,
      apiCredentialId: null,
    });
    const cleanupJobId = randomUUID();
    await pool.execute(
      `INSERT INTO knowledge_base_reset_cleanup_jobs
         (id, userId, apiCredentialId, kind, upstreamId, localAssetKey)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [
        cleanupJobId,
        ownerId,
        resource.apiCredentialId,
        resource.kind,
        resource.upstreamId,
        resource.localAssetKey,
      ],
    );

    const [rows] = await pool.query<RowDataPacket[]>(
      `SELECT upstreamId, localAssetKey
         FROM knowledge_base_reset_cleanup_jobs WHERE id = ?`,
      [cleanupJobId],
    );
    expect(rows[0]).toMatchObject({
      upstreamId: resource.upstreamId,
      localAssetKey,
    });
    await pool.execute(
      "DELETE FROM knowledge_base_reset_cleanup_jobs WHERE id = ?",
      [cleanupJobId],
    );
  });

  it("proves exactly-once reservations, stale-write guards, leases and rollback", async () => {
    expect(userId).not.toBeNull();
    const ownerId = userId!;
    const publicConversationId = `kb-mysql-${runId}`;
    const startInput = {
      userId: ownerId,
      conversationId: publicConversationId,
      clientRequestId: `start-${runId}`,
      companyName: "FrontMind MySQL Acceptance",
      companyWebsite: "https://acceptance.invalid",
      skillName: "socratic-kb-builder",
      skillVersion: "4",
      skillContentHash: "a".repeat(64),
      userText: "开始构建企业知识库",
      expectedAttachmentCount: 0,
      requestPayload: { kind: "acceptance-start", runId },
      recoveryMetadata: { kind: "start", runId },
      leaseMs: 5_000,
    } as const;

    const doubleStart = await Promise.all([
      reserveKnowledgeBaseStartBuild(startInput, executor),
      reserveKnowledgeBaseStartBuild(startInput, executor),
    ]);
    expect(new Set(doubleStart.map((item) => item.build.id)).size).toBe(1);
    expect(
      new Set(doubleStart.map((item) => item.reservation.turn.id)).size,
    ).toBe(1);
    const buildId = doubleStart[0].build.id;
    const startTurnId = doubleStart[0].reservation.turn.id;
    const storageConversationId =
      doubleStart[0].reservation.turn.conversationId;
    const [startRows] = await pool.query<RowDataPacket[]>(
      `SELECT b.activeTurnId, COUNT(t.id) AS turnCount,
                COUNT(DISTINCT t.operationKey) AS operationCount
         FROM knowledge_base_builds b
         JOIN conversation_turns t ON t.buildId = b.id
         WHERE b.id = ? AND t.operationType = 'start'
         GROUP BY b.activeTurnId`,
      [buildId],
    );
    expect(startRows).toHaveLength(1);
    expect(startRows[0].activeTurnId).toBe(startTurnId);
    expect(Number(startRows[0].turnCount)).toBe(1);
    expect(Number(startRows[0].operationCount)).toBe(1);

    const rollbackConversationId = `kb-rollback-${runId}`;
    await expect(
      reserveKnowledgeBaseStartBuild(
        {
          ...startInput,
          conversationId: rollbackConversationId,
          clientRequestId: `rollback-${runId}`,
          apiCredentialId: randomUUID(),
          requestPayload: { kind: "forced-fk-rollback", runId },
        },
        executor,
      ),
    ).rejects.toBeTruthy();
    const [rollbackRows] = await pool.query<RowDataPacket[]>(
      `SELECT
           (SELECT COUNT(*) FROM knowledge_base_builds
            WHERE userId = ? AND conversationId = ?) AS buildCount,
           (SELECT COUNT(*) FROM conversations WHERE id = ?) AS conversationCount`,
      [
        ownerId,
        rollbackConversationId,
        knowledgeBaseConversationStorageId(ownerId, rollbackConversationId),
      ],
    );
    expect(Number(rollbackRows[0].buildCount)).toBe(0);
    expect(Number(rollbackRows[0].conversationCount)).toBe(0);

    await settleTurnAndAdvanceBuild({
      pool,
      buildId,
      turnId: startTurnId,
      generation: 1,
      nextGeneration: 1,
      revision: 0,
      leafId: "1.1",
    });
    const confirmBase = {
      userId: ownerId,
      buildId,
      operationType: "confirm" as const,
      expectedGeneration: 1,
      expectedRevision: 0,
      expectedLeafId: "1.1",
      expectedAttachmentCount: 0,
      userText: "确认",
      recoveryMetadata: { kind: "turn", runId },
      leaseMs: 5_000,
    };
    const confirmResults = await Promise.allSettled([
      reserveKnowledgeBaseTurn(
        {
          ...confirmBase,
          clientRequestId: `confirm-a-${runId}`,
          requestPayload: { decision: "confirm", tab: "a" },
        },
        executor,
      ),
      reserveKnowledgeBaseTurn(
        {
          ...confirmBase,
          clientRequestId: `confirm-b-${runId}`,
          requestPayload: { decision: "different-content", tab: "b" },
        },
        executor,
      ),
    ]);
    const fulfilledConfirm = confirmResults.filter(
      (result) => result.status === "fulfilled",
    );
    const rejectedConfirm = confirmResults.filter(
      (result) => result.status === "rejected",
    );
    expect(fulfilledConfirm).toHaveLength(1);
    expect(rejectedConfirm).toHaveLength(1);
    const rejectedReason = rejectedConfirm[0] as PromiseRejectedResult;
    expect(rejectedReason.reason).toBeInstanceOf(
      KnowledgeBaseTurnReservationError,
    );
    expect(
      (rejectedReason.reason as KnowledgeBaseTurnReservationError).code,
    ).toBe("CONFLICT");
    const confirmReservation = (
      fulfilledConfirm[0] as PromiseFulfilledResult<
        Awaited<ReturnType<typeof reserveKnowledgeBaseTurn>>
      >
    ).value;
    const confirmTurnId = confirmReservation.turn.id;
    const confirmOperationKey = confirmReservation.turn.operationKey;
    const [confirmRows] = await pool.query<RowDataPacket[]>(
      `SELECT id, operationKey FROM conversation_turns
         WHERE buildId = ? AND buildGeneration = 1
           AND operationType = 'confirm'`,
      [buildId],
    );
    expect(confirmRows).toHaveLength(1);
    expect(confirmRows[0].id).toBe(confirmTurnId);

    let duplicateIndexError: unknown;
    try {
      await pool.execute(
        `INSERT INTO conversation_turns
             (id, conversationId, userId, clientRequestId, buildId,
              buildGeneration, operationKey, operationType,
              expectedRevision, expectedLeafId, requestHash,
              upstreamIdempotencyKeyHash, attachmentFileIds, metadata)
           VALUES (?, ?, ?, ?, ?, 1, ?, 'confirm', 0, '1.1', ?, ?, '[]', '{}')`,
        [
          randomUUID(),
          storageConversationId,
          ownerId,
          `duplicate-${runId}`,
          buildId,
          confirmOperationKey,
          "b".repeat(64),
          "c".repeat(64),
        ],
      );
    } catch (error) {
      duplicateIndexError = error;
    }
    expect(mysqlCode(duplicateIndexError)).toBe("ER_DUP_ENTRY");

    await settleTurnAndAdvanceBuild({
      pool,
      buildId,
      turnId: confirmTurnId,
      generation: 1,
      nextGeneration: 2,
      revision: 0,
      leafId: "1.1",
    });
    expect(
      await conditionalApply({
        pool,
        buildId,
        turnId: confirmTurnId,
        generation: 1,
        expectedRevision: 0,
        expectedLeafId: "1.1",
        nextRevision: 1,
        nextLeafId: "1.2",
        operationKey: "old-generation-must-not-apply",
      }),
    ).toBe(0);

    const generationTwo = await reserveKnowledgeBaseTurn(
      {
        ...confirmBase,
        clientRequestId: `generation-two-${runId}`,
        expectedGeneration: 2,
        requestPayload: { decision: "confirm-generation-two" },
      },
      executor,
    );
    expect(generationTwo.state).toBe("acquired");
    expect(
      await conditionalApply({
        pool,
        buildId,
        turnId: generationTwo.turn.id,
        generation: 2,
        expectedRevision: 2,
        expectedLeafId: "1.1",
        nextRevision: 3,
        nextLeafId: "1.4",
        operationKey: "future-revision-must-not-apply",
      }),
    ).toBe(0);
    expect(
      await conditionalApply({
        pool,
        buildId,
        turnId: generationTwo.turn.id,
        generation: 2,
        expectedRevision: 0,
        expectedLeafId: "1.1",
        nextRevision: 1,
        nextLeafId: "1.2",
        operationKey: generationTwo.turn.operationKey,
      }),
    ).toBe(1);
    expect(
      await conditionalApply({
        pool,
        buildId,
        turnId: generationTwo.turn.id,
        generation: 2,
        expectedRevision: 0,
        expectedLeafId: "1.1",
        nextRevision: 1,
        nextLeafId: "1.2",
        operationKey: "duplicate-revision-must-not-apply",
      }),
    ).toBe(0);
    const [appliedRows] = await pool.query<RowDataPacket[]>(
      `SELECT generation, revision, currentLeafId, activeTurnId,
                lastAppliedOperationKey
         FROM knowledge_base_builds WHERE id = ?`,
      [buildId],
    );
    expect(appliedRows[0]).toMatchObject({
      generation: 2,
      revision: 1,
      currentLeafId: "1.2",
      activeTurnId: null,
      lastAppliedOperationKey: generationTwo.turn.operationKey,
    });

    const expiredReservation = await reserveKnowledgeBaseTurn(
      {
        ...confirmBase,
        operationType: "revise",
        clientRequestId: `lease-${runId}`,
        expectedGeneration: 2,
        expectedRevision: 1,
        expectedLeafId: "1.2",
        requestPayload: { correction: "lease acceptance" },
      },
      executor,
    );
    await pool.execute(
      `UPDATE conversation_turns
         SET status = 'running', leaseExpiresAt = DATE_SUB(CURRENT_TIMESTAMP, INTERVAL 5 SECOND)
         WHERE id = ?`,
      [expiredReservation.turn.id],
    );
    const claimNow = new Date(Date.now() + 1_000);
    const claims = await Promise.all([
      claimKnowledgeBaseTurnForRecovery(
        { turnId: expiredReservation.turn.id, now: claimNow, leaseMs: 5_000 },
        executor,
      ),
      claimKnowledgeBaseTurnForRecovery(
        { turnId: expiredReservation.turn.id, now: claimNow, leaseMs: 5_000 },
        executor,
      ),
    ]);
    expect(claims.filter(Boolean)).toHaveLength(1);
    expect(claims.filter((claim) => claim === null)).toHaveLength(1);

    await pool.execute(
      `UPDATE conversation_turns
          SET status = 'completed', completedAt = CURRENT_TIMESTAMP,
              leaseExpiresAt = NULL
        WHERE id = ?`,
      [expiredReservation.turn.id],
    );
    await pool.execute(
      `UPDATE knowledge_base_builds
          SET activeTurnId = NULL, status = 'researching',
              upstreamTaskId = ?, awaitingResponseSince = CURRENT_TIMESTAMP,
              recoveryLeaseOwnerHash = NULL, recoveryLeaseExpiresAt = NULL
        WHERE id = ?`,
      [`open-recovery-${runId}`, buildId],
    );
    const [openRows] = await pool.query<RowDataPacket[]>(
      `SELECT generation, stateEpoch, upstreamTaskId
         FROM knowledge_base_builds WHERE id = ?`,
      [buildId],
    );
    const openClaimInput = {
      buildId,
      expectedGeneration: Number(openRows[0].generation),
      expectedStateEpoch: Number(openRows[0].stateEpoch),
      expectedTaskId: String(openRows[0].upstreamTaskId),
      now: new Date(),
      leaseMs: 5_000,
    };
    const openClaims = await Promise.all([
      claimKnowledgeBaseOpenRecoveryBuild(openClaimInput, executor),
      claimKnowledgeBaseOpenRecoveryBuild(openClaimInput, executor),
    ]);
    expect(openClaims.filter(Boolean)).toHaveLength(1);
    expect(openClaims.filter((claim) => claim === null)).toHaveLength(1);
    const openClaim = openClaims.find(Boolean)!;
    await expect(
      releaseKnowledgeBaseOpenRecoveryLease(
        {
          buildId,
          generation: openClaim.build.generation,
          leaseToken: openClaim.leaseToken,
        },
        executor,
      ),
    ).resolves.toBe(true);

    console.log(`KB_MYSQL_ACCEPTANCE_COMPLETE database=${target.databaseName}`);
  }, 180_000);
});
