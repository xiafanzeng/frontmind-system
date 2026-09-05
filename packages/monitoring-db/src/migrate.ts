import { migrate } from "drizzle-orm/mysql2/migrator";
import { createDatabase } from "./client.js";

if (process.env.NODE_ENV === "production") {
  throw new Error(
    "The development migrator is disabled in production; use release-db plan/migrate/bootstrap-empty",
  );
}

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error("DATABASE_URL is required");

const { db, pool } = createDatabase(databaseUrl, { connectionLimit: 1 });
try {
  await migrate(db, {
    migrationsFolder: new URL("../migrations", import.meta.url).pathname,
  });
} finally {
  await pool.end();
}
