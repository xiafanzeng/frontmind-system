import { randomUUID } from "node:crypto";
import path from "node:path";

import { drizzle } from "drizzle-orm/mysql2";
import { migrate } from "drizzle-orm/mysql2/migrator";
import mysql, {
  type Pool,
  type ResultSetHeader,
  type RowDataPacket,
} from "mysql2/promise";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  changeOwnPassword,
  hashPassword,
  loginWithPassword,
  permanentlyDeleteManagedUserRows,
  verifyPassword,
} from "../server/auth-service";

const URL_ENV = "FRONTMIND_AUTH_MYSQL_ACCEPTANCE_DATABASE_URL";
const REQUIRED_ENV = "FRONTMIND_AUTH_MYSQL_ACCEPTANCE_REQUIRED";
const acceptanceUrl = process.env[URL_ENV]?.trim();
if (process.env[REQUIRED_ENV] === "1" && !acceptanceUrl) {
  throw new Error(`${URL_ENV}_REQUIRED_FOR_RELEASE_GATE`);
}

const mysqlDescribe = acceptanceUrl ? describe.sequential : describe.skip;

mysqlDescribe("password/session transaction on real MySQL", () => {
  let pool: Pool;
  let userId = 0;
  const username = `auth_mysql_${randomUUID().replaceAll("-", "")}`.slice(
    0,
    64,
  );
  const triggerName = `auth_revoke_fail_${randomUUID().replaceAll("-", "").slice(0, 12)}`;

  async function insertOutstandingSetupCapabilities(label: string) {
    const provisionId = randomUUID();
    const setupTokenId = randomUUID();
    const unique = `${label}-${randomUUID().replaceAll("-", "")}`;
    await pool.execute(
      `INSERT INTO user_password_setup_tokens
         (id, userId, tokenHash, expiresAt)
       VALUES (?, ?, ?, DATE_ADD(NOW(), INTERVAL 1 DAY))`,
      [setupTokenId, userId, `${unique}0`.padEnd(64, "0").slice(0, 64)],
    );
    await pool.execute(
      `INSERT INTO website_user_provisions
         (id, idempotencyKeyHash, requestHash, projectId, companyName,
          orderId, tradeNo, amountFen, paidAt, serviceCategory, planCode,
          questionId, question, contractId, contractTemplateVersion,
          contractDocumentSha256, requestedUsername, requestedDisplayName,
          accountMode, userId, status, accountSetupTokenHash,
          accountSetupTokenExpiresAt, completedAt)
       VALUES (?, ?, ?, ?, ?, ?, ?, 100, NOW(), 'product_scenario', 'basic',
               ?, ?, ?, 'v1', ?, ?, ?, 'create', ?, 'completed', ?,
               DATE_ADD(NOW(), INTERVAL 1 DAY), NOW())`,
      [
        provisionId,
        `${unique}1`.padEnd(64, "1").slice(0, 64),
        `${unique}2`.padEnd(64, "2").slice(0, 64),
        `project-${unique}`.slice(0, 80),
        "Auth MySQL acceptance",
        `order-${unique}`.slice(0, 64),
        `trade-${unique}`.slice(0, 128),
        `question-${unique}`.slice(0, 80),
        "Does password capability revocation roll back atomically?",
        `contract-${unique}`.slice(0, 128),
        `${unique}3`.padEnd(64, "3").slice(0, 64),
        username,
        "Auth MySQL acceptance",
        userId,
        `${unique}4`.padEnd(64, "4").slice(0, 64),
      ],
    );
    return { provisionId, setupTokenId };
  }

  beforeAll(async () => {
    const parsed = new URL(acceptanceUrl!);
    const databaseName = decodeURIComponent(
      parsed.pathname.replace(/^\//u, ""),
    );
    if (
      parsed.protocol !== "mysql:" ||
      !/^[A-Za-z0-9_$-]*acceptance[A-Za-z0-9_$-]*$/iu.test(databaseName)
    ) {
      throw new Error(`${URL_ENV}_MUST_TARGET_DISPOSABLE_ACCEPTANCE_DB`);
    }
    process.env.DATABASE_URL = acceptanceUrl;
    pool = mysql.createPool({ uri: acceptanceUrl!, connectionLimit: 4 });
    const [rows] = await pool.query<RowDataPacket[]>(
      "SELECT COUNT(*) AS tableCount FROM information_schema.tables WHERE table_schema = DATABASE()",
    );
    if (Number(rows[0]?.tableCount || 0) !== 0) {
      throw new Error(`${URL_ENV}_DATABASE_MUST_BE_EMPTY`);
    }
    await migrate(drizzle(pool), {
      migrationsFolder: path.resolve(process.cwd(), "drizzle"),
    });
    const passwordHash = await hashPassword("initial-password");
    const [inserted] = await pool.execute<ResultSetHeader>(
      `INSERT INTO users
         (openId, username, passwordHash, displayName, loginMethod, role, marketEdition, isActive)
       VALUES (?, ?, ?, ?, 'password', 'user', 'domestic', 1)`,
      [
        `auth-mysql-${randomUUID()}`.slice(0, 64),
        username,
        passwordHash,
        "Auth MySQL acceptance",
      ],
    );
    userId = inserted.insertId;
  }, 300_000);

  afterAll(async () => {
    if (!pool) return;
    await pool
      .query(`DROP TRIGGER IF EXISTS \`${triggerName}\``)
      .catch(() => undefined);
    if (userId) {
      await pool.execute(
        "DELETE FROM website_user_provisions WHERE userId = ?",
        [userId],
      );
      await pool.execute("DELETE FROM users WHERE id = ?", [userId]);
    }
    await pool.end();
  });

  it("commits password replacement and session revocation together", async () => {
    await loginWithPassword(username, "initial-password", "127.0.0.1");
    const capabilities = await insertOutstandingSetupCapabilities("commit");
    await changeOwnPassword(userId, "initial-password", "second-password");

    const [userRows] = await pool.query<RowDataPacket[]>(
      "SELECT passwordHash, passwordChangedAt FROM users WHERE id = ?",
      [userId],
    );
    const [sessionRows] = await pool.query<RowDataPacket[]>(
      "SELECT COUNT(*) AS activeCount FROM sessions WHERE userId = ? AND revokedAt IS NULL",
      [userId],
    );
    const [setupTokenRows] = await pool.query<RowDataPacket[]>(
      "SELECT consumedAt FROM user_password_setup_tokens WHERE id = ?",
      [capabilities.setupTokenId],
    );
    const [websiteTokenRows] = await pool.query<RowDataPacket[]>(
      "SELECT accountSetupTokenConsumedAt FROM website_user_provisions WHERE id = ?",
      [capabilities.provisionId],
    );
    await expect(
      verifyPassword(
        "second-password",
        String(userRows[0]?.passwordHash || ""),
      ),
    ).resolves.toBe(true);
    expect(userRows[0]?.passwordChangedAt).toBeTruthy();
    expect(Number(sessionRows[0]?.activeCount || 0)).toBe(0);
    expect(setupTokenRows[0]?.consumedAt).toBeTruthy();
    expect(websiteTokenRows[0]?.accountSetupTokenConsumedAt).toBeTruthy();
  });

  it("rolls the password update back when real MySQL rejects session revocation", async () => {
    await loginWithPassword(username, "second-password", "127.0.0.1");
    const capabilities = await insertOutstandingSetupCapabilities("rollback");
    const [beforeRows] = await pool.query<RowDataPacket[]>(
      "SELECT passwordHash, passwordChangedAt FROM users WHERE id = ?",
      [userId],
    );
    await pool.query(
      `CREATE TRIGGER \`${triggerName}\`
       BEFORE UPDATE ON sessions
       FOR EACH ROW
       SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'AUTH_ACCEPTANCE_SESSION_REVOKE_FAILED'`,
    );

    await expect(
      changeOwnPassword(userId, "second-password", "must-not-commit"),
    ).rejects.toBeTruthy();

    const [afterRows] = await pool.query<RowDataPacket[]>(
      "SELECT passwordHash, passwordChangedAt FROM users WHERE id = ?",
      [userId],
    );
    const [sessionRows] = await pool.query<RowDataPacket[]>(
      "SELECT COUNT(*) AS activeCount FROM sessions WHERE userId = ? AND revokedAt IS NULL",
      [userId],
    );
    const [setupTokenRows] = await pool.query<RowDataPacket[]>(
      "SELECT consumedAt FROM user_password_setup_tokens WHERE id = ?",
      [capabilities.setupTokenId],
    );
    const [websiteTokenRows] = await pool.query<RowDataPacket[]>(
      "SELECT accountSetupTokenConsumedAt FROM website_user_provisions WHERE id = ?",
      [capabilities.provisionId],
    );
    expect(afterRows[0]?.passwordHash).toBe(beforeRows[0]?.passwordHash);
    expect(new Date(afterRows[0]?.passwordChangedAt).getTime()).toBe(
      new Date(beforeRows[0]?.passwordChangedAt).getTime(),
    );
    await expect(
      verifyPassword(
        "must-not-commit",
        String(afterRows[0]?.passwordHash || ""),
      ),
    ).resolves.toBe(false);
    expect(Number(sessionRows[0]?.activeCount || 0)).toBe(1);
    expect(setupTokenRows[0]?.consumedAt).toBeNull();
    expect(websiteTokenRows[0]?.accountSetupTokenConsumedAt).toBeNull();
  });

  it("permanently deletes an account with reset tickets without FK-order failures", async () => {
    const suffix = randomUUID().replaceAll("-", "");
    const contractId = randomUUID();
    const quotaPeriodId = randomUUID();
    const ticketId = randomUUID();
    const resetRequestId = randomUUID();
    const attachmentId = randomUUID();
    const styleBatchId = randomUUID();
    const styleSampleId = randomUUID();
    const [inserted] = await pool.execute<ResultSetHeader>(
      `INSERT INTO users
         (openId, username, displayName, loginMethod, role, marketEdition, isActive)
       VALUES (?, ?, 'Deletion acceptance', 'password', 'user', 'domestic', 1)`,
      [
        `delete-mysql-${suffix}`.slice(0, 64),
        `delete_mysql_${suffix}`.slice(0, 64),
      ],
    );
    const deletedUserId = inserted.insertId;
    await pool.execute(
      `INSERT INTO service_contracts
         (id, userId, planCode, startsAt, endsAt)
       VALUES (?, ?, 'advanced', NOW(), DATE_ADD(NOW(), INTERVAL 1 MONTH))`,
      [contractId, deletedUserId],
    );
    await pool.execute(
      `INSERT INTO service_quota_periods
         (id, contractId, userId, ordinal, startsAt, endsAt)
       VALUES (?, ?, ?, 1, NOW(), DATE_ADD(NOW(), INTERVAL 1 MONTH))`,
      [quotaPeriodId, contractId, deletedUserId],
    );
    await pool.execute(
      `INSERT INTO delivery_tickets
         (id, userId, contractId, quotaPeriodId, type, ordinal, clientRequestId)
       VALUES (?, ?, ?, ?, 'knowledge_base', 1, ?)`,
      [ticketId, deletedUserId, contractId, quotaPeriodId, resetRequestId],
    );
    await pool.execute(
      `INSERT INTO knowledge_base_reset_requests
         (id, ticketId, userId, reasonCode)
       VALUES (?, ?, ?, 'stuck')`,
      [resetRequestId, ticketId, deletedUserId],
    );
    await pool.execute(
      `INSERT INTO delivery_ticket_attachments
         (id, ticketId, workspaceUserId, ownerUserId, filename)
       VALUES (?, ?, ?, ?, 'style-sample.png')`,
      [attachmentId, ticketId, deletedUserId, deletedUserId],
    );
    await pool.execute(
      `INSERT INTO website_style_sample_batches
         (id, userId, ticketId, ordinal, publishedAt)
       VALUES (?, ?, ?, 1, NOW())`,
      [styleBatchId, deletedUserId, ticketId],
    );
    await pool.execute(
      `INSERT INTO website_style_samples
         (id, batchId, attachmentId, label, sortOrder)
       VALUES (?, ?, ?, 'Deletion acceptance', 1)`,
      [styleSampleId, styleBatchId, attachmentId],
    );
    await pool.execute(
      `INSERT INTO knowledge_base_conversation_tombstones
         (id, userId, publicConversationId, resetRequestId)
       VALUES (?, ?, ?, ?)`,
      [
        randomUUID(),
        deletedUserId,
        `delete-${suffix}`.slice(0, 191),
        resetRequestId,
      ],
    );
    await pool.execute(
      `INSERT INTO knowledge_base_reset_cleanup_jobs
         (id, resetRequestId, userId, kind, upstreamId)
       VALUES (?, ?, ?, 'task', ?)`,
      [
        randomUUID(),
        resetRequestId,
        deletedUserId,
        `task-${suffix}`.slice(0, 255),
      ],
    );

    const database = drizzle(pool);
    await database.transaction((tx) =>
      permanentlyDeleteManagedUserRows(tx, deletedUserId),
    );

    const [rows] = await pool.query<RowDataPacket[]>(
      `SELECT
         (SELECT COUNT(*) FROM users WHERE id = ?) AS userCount,
         (SELECT COUNT(*) FROM delivery_tickets WHERE id = ?) AS ticketCount,
         (SELECT COUNT(*) FROM knowledge_base_reset_requests WHERE id = ?) AS requestCount,
         (SELECT COUNT(*) FROM service_contracts WHERE id = ?) AS contractCount,
         (SELECT COUNT(*) FROM service_quota_periods WHERE id = ?) AS quotaCount,
         (SELECT COUNT(*) FROM delivery_ticket_attachments WHERE id = ?) AS attachmentCount,
         (SELECT COUNT(*) FROM website_style_sample_batches WHERE id = ?) AS styleBatchCount,
         (SELECT COUNT(*) FROM website_style_samples WHERE id = ?) AS styleSampleCount,
         (SELECT COUNT(*) FROM knowledge_base_reset_cleanup_jobs WHERE userId = ?) AS cleanupCount`,
      [
        deletedUserId,
        ticketId,
        resetRequestId,
        contractId,
        quotaPeriodId,
        attachmentId,
        styleBatchId,
        styleSampleId,
        deletedUserId,
      ],
    );
    expect(rows[0]).toMatchObject({
      userCount: 0,
      ticketCount: 0,
      requestCount: 0,
      contractCount: 0,
      quotaCount: 0,
      attachmentCount: 0,
      styleBatchCount: 0,
      styleSampleCount: 0,
      cleanupCount: 0,
    });
  });
});
