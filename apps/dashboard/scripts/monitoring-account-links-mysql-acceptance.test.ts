import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { RowDataPacket } from "mysql2/promise";
import { createDatabase } from "../../../packages/monitoring-db/src/client";
import {
  dashboardMonitoringUserId,
  ensureDashboardAccountLink,
  syncDashboardMonitoringAccountStates,
} from "../../../packages/monitoring-db/src/dashboard-account-links";

const acceptanceUrl =
  process.env.FRONTMIND_MONITORING_LINK_MYSQL_ACCEPTANCE_DATABASE_URL;
const mysqlDescribe = acceptanceUrl ? describe.sequential : describe.skip;

mysqlDescribe("unified monitoring account locks on real MySQL", () => {
  let connection: ReturnType<typeof createDatabase>;
  const createdTables: string[] = [];
  async function createTable(name: string, statement: string) {
    await connection.pool.query(statement);
    createdTables.push(name);
  }
  const tables = [
    "media_publishing_wallets",
    "quota_wallets",
    "money_wallets",
    "monitoring_account_links",
    "monitoring_users",
    "users",
  ];

  beforeAll(async () => {
    const url = new URL(acceptanceUrl!);
    if (
      url.protocol !== "mysql:" ||
      !/^\/fm_link_acceptance_[a-z0-9_]+$/.test(url.pathname)
    ) {
      throw new Error(
        "Account-link tests require their own disposable fm_link_acceptance_ database",
      );
    }
    connection = createDatabase(acceptanceUrl!, { connectionLimit: 8 });
    const [existing] =
      await connection.pool.query<RowDataPacket[]>("SHOW TABLES");
    if (existing.length)
      throw new Error("Account-link acceptance database must be empty");
    await createTable(
      "users",
      `CREATE TABLE users (
      id INT PRIMARY KEY, username VARCHAR(64), role VARCHAR(24),
      adminAccessLevel VARCHAR(24), isActive BOOLEAN NOT NULL
    ) ENGINE=InnoDB`,
    );
    await createTable(
      "monitoring_users",
      `CREATE TABLE monitoring_users (
      id VARCHAR(36) PRIMARY KEY, username VARCHAR(64) NOT NULL UNIQUE,
      password_hash VARCHAR(255) NOT NULL, role ENUM('user','admin') NOT NULL,
      status ENUM('active','disabled') NOT NULL, session_version INT NOT NULL,
      password_changed_at DATETIME(3) NOT NULL
    ) ENGINE=InnoDB`,
    );
    await createTable(
      "monitoring_account_links",
      `CREATE TABLE monitoring_account_links (
      dashboardUserId INT PRIMARY KEY, monitoringUserId VARCHAR(36) NOT NULL UNIQUE,
      FOREIGN KEY (dashboardUserId) REFERENCES users(id),
      FOREIGN KEY (monitoringUserId) REFERENCES monitoring_users(id)
    ) ENGINE=InnoDB`,
    );
    for (const table of tables.slice(0, 3)) {
      await createTable(
        table,
        `CREATE TABLE ${table} (
        user_id VARCHAR(36) PRIMARY KEY, balance INT NOT NULL DEFAULT 0,
        FOREIGN KEY (user_id) REFERENCES monitoring_users(id)
      ) ENGINE=InnoDB`,
      );
    }
    await connection.pool.query(
      "INSERT INTO users VALUES (1,'acceptance-admin','admin','system_admin',true),(2,'acceptance-customer','user',NULL,true)",
    );
    await ensureDashboardAccountLink(connection.db, 1);
    await ensureDashboardAccountLink(connection.db, 2);
    await connection.pool.execute(
      "UPDATE money_wallets SET balance=12345 WHERE user_id=?",
      [dashboardMonitoringUserId(1)],
    );
  });

  afterAll(async () => {
    if (!connection) return;
    try {
      for (const table of createdTables.reverse())
        await connection.pool.query(`DROP TABLE IF EXISTS ${table}`);
    } finally {
      await connection.pool.end();
    }
  });

  it("reproduces the former users-to-projection / projection-to-users lock inversion", async () => {
    const accountLink = await connection.pool.getConnection();
    const stateSync = await connection.pool.getConnection();
    try {
      await accountLink.beginTransaction();
      await stateSync.beginTransaction();
      await accountLink.query("SELECT id FROM users WHERE id=1 FOR UPDATE");
      await stateSync.execute(
        "SELECT id FROM monitoring_users WHERE id=? FOR UPDATE",
        [dashboardMonitoringUserId(1)],
      );
      const results = await Promise.allSettled([
        accountLink.execute(
          "UPDATE monitoring_users SET status='active' WHERE id=?",
          [dashboardMonitoringUserId(1)],
        ),
        stateSync.query(`UPDATE monitoring_users m
          LEFT JOIN monitoring_account_links l ON l.monitoringUserId=m.id
          LEFT JOIN users d ON d.id=l.dashboardUserId
          SET m.status=IF(d.isActive=true,'active','disabled')`),
      ]);
      expect(
        results.some(
          (result) =>
            result.status === "rejected" &&
            result.reason.code === "ER_LOCK_DEADLOCK",
        ),
      ).toBe(true);
    } finally {
      await Promise.all([accountLink.rollback(), stateSync.rollback()]);
      accountLink.release();
      stateSync.release();
    }
  }, 20_000);

  it("serializes concurrent identity linking and status sync without changing balances", async () => {
    for (let round = 0; round < 3; round++) {
      await Promise.all(
        Array.from({ length: 12 }, (_, index) =>
          index % 3 === 0
            ? syncDashboardMonitoringAccountStates(connection.db)
            : ensureDashboardAccountLink(connection.db, (index % 2) + 1),
        ),
      );
    }
    const [links] = await connection.pool.query<RowDataPacket[]>(
      "SELECT * FROM monitoring_account_links ORDER BY dashboardUserId",
    );
    expect(links).toEqual([
      { dashboardUserId: 1, monitoringUserId: dashboardMonitoringUserId(1) },
      { dashboardUserId: 2, monitoringUserId: dashboardMonitoringUserId(2) },
    ]);
    const [wallets] = await connection.pool.execute<RowDataPacket[]>(
      "SELECT balance FROM money_wallets WHERE user_id=?",
      [dashboardMonitoringUserId(1)],
    );
    expect(wallets[0].balance).toBe(12345);
  }, 40_000);

  it("still revokes inactive accounts, demotes non-system admins and disables unlinked projections", async () => {
    await connection.pool.query(
      "UPDATE users SET adminAccessLevel='delivery_admin' WHERE id=1",
    );
    await connection.pool.query("UPDATE users SET isActive=false WHERE id=2");
    await connection.pool.query(
      "INSERT INTO monitoring_users VALUES ('unlinked-synthetic-account','unlinked','unused','admin','active',1,UTC_TIMESTAMP(3))",
    );
    await syncDashboardMonitoringAccountStates(connection.db);
    const [states] = await connection.pool.query<RowDataPacket[]>(
      "SELECT id,role,status FROM monitoring_users ORDER BY id",
    );
    expect(states).toEqual(
      expect.arrayContaining([
        { id: dashboardMonitoringUserId(1), role: "user", status: "active" },
        { id: dashboardMonitoringUserId(2), role: "user", status: "disabled" },
        { id: "unlinked-synthetic-account", role: "user", status: "disabled" },
      ]),
    );
  });
});
