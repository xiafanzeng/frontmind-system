import { randomUUID } from "node:crypto";
import { drizzle } from "drizzle-orm/mysql2";
import { migrate } from "drizzle-orm/mysql2/migrator";
import mysql from "mysql2/promise";

const url = new URL(process.env.FRONTMIND_WORKBENCH_TEST_MYSQL_URL ?? "");
const database = decodeURIComponent(url.pathname.slice(1));
if (
  url.protocol !== "mysql:" ||
  !["localhost", "127.0.0.1"].includes(url.hostname) ||
  !/^[a-zA-Z0-9_]*acceptance[a-zA-Z0-9_]*$/.test(database)
)
  throw new Error("A local disposable acceptance database is required");
const adminUrl = new URL(url);
adminUrl.pathname = "/";
const admin = await mysql.createConnection(adminUrl.toString());
try {
  const [existing] = await admin.query(
    "SELECT SCHEMA_NAME FROM information_schema.SCHEMATA WHERE SCHEMA_NAME = ?",
    [database],
  );
  if ((existing as unknown[]).length)
    throw new Error("Acceptance bootstrap requires a brand new database");
  await admin.query(
    `CREATE DATABASE \`${database}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci`,
  );
} finally {
  await admin.end();
}
const connection = await mysql.createConnection(url.toString());
try {
  await migrate(drizzle(connection), {
    migrationsFolder: new URL("../drizzle", import.meta.url).pathname,
  });
  await connection.execute(
    "INSERT INTO users(id,openId,name,email,role) VALUES(101,?,?,?,'user')",
    [
      "workbench-acceptance",
      "Local acceptance",
      "workbench-acceptance@example.invalid",
    ],
  );
  const owner = randomUUID();
  await connection.execute(
    "INSERT INTO monitoring_users(id,username,password_hash,password_changed_at,role) VALUES(?,?,?,UTC_TIMESTAMP(3),'user')",
    [owner, "workbench-acceptance@example.invalid", "local-acceptance-only"],
  );
  await connection.execute(
    "INSERT INTO monitoring_account_links(dashboardUserId,monitoringUserId) VALUES(101,?)",
    [owner],
  );
  console.log(`WORKBENCH_ACCEPTANCE_BOOTSTRAPPED ${database}`);
} finally {
  await connection.end();
}
