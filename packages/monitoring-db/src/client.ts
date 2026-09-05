import { drizzle } from "drizzle-orm/mysql2";
import mysql, { type PoolOptions } from "mysql2/promise";
import { schema } from "./schema.js";

export function createDatabase(
  databaseUrl: string,
  options: Partial<PoolOptions> = {},
) {
  const pool = mysql.createPool({
    uri: databaseUrl,
    connectionLimit: 10,
    enableKeepAlive: true,
    maxIdle: 10,
    idleTimeout: 60_000,
    queueLimit: 0,
    charset: "utf8mb4",
    ...options,
    // Drizzle serializes MySQL DATETIME/TIMESTAMP values as UTC wall-clock
    // strings. Raw mysql2 Date parameters must use the same convention even
    // when the API/worker process runs in a positive local timezone.
    timezone: "Z",
  });
  // MySQL TIMESTAMP defaults and reads follow the session timezone. Drizzle's
  // MySQL date mappers interpret returned strings as UTC, so normalize every
  // newly-created connection before it can execute application work.
  pool.pool.on("connection", (connection) => {
    connection.query("SET SESSION time_zone = '+00:00'", (error) => {
      if (error) connection.destroy();
    });
  });
  return { db: drizzle(pool, { schema, mode: "default" }), pool };
}

export type Database = ReturnType<typeof createDatabase>["db"];
