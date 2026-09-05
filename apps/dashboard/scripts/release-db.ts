import "dotenv/config";

import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { drizzle } from "drizzle-orm/mysql2";
import { migrate } from "drizzle-orm/mysql2/migrator";
import mysql, { type Connection } from "mysql2/promise";

import {
  evaluateMigrationJournal,
  loadMigrationManifest,
  type MigrationManifest,
} from "../server/_core/migration-journal";
import { createMigrationManifest } from "./migration-manifest.mjs";
import { evaluateDatabaseSchema } from "./schema-contract.mjs";

type ReleaseDbCommand = "plan" | "migrate" | "postflight";

class ReleaseDbError extends Error {
  constructor(public readonly code: string) {
    super(code);
    this.name = "ReleaseDbError";
  }
}

function firstExistingPath(candidates: string[], code: string) {
  const found = candidates.find((candidate) => existsSync(candidate));
  if (!found) throw new ReleaseDbError(code);
  return path.resolve(found);
}

export function resolveReleaseDbPaths(env = process.env) {
  const runtimeRoot = path.dirname(fileURLToPath(import.meta.url));
  const migrationsFolder = env.FRONTMIND_MIGRATIONS_DIR
    ? path.resolve(env.FRONTMIND_MIGRATIONS_DIR)
    : firstExistingPath(
        [path.join(runtimeRoot, "drizzle"), path.resolve("drizzle")],
        "MIGRATIONS_FOLDER_MISSING",
      );
  const manifestPath = env.FRONTMIND_MIGRATION_MANIFEST_PATH
    ? path.resolve(env.FRONTMIND_MIGRATION_MANIFEST_PATH)
    : firstExistingPath(
        [
          path.join(runtimeRoot, "migration-manifest.json"),
          path.resolve("dist", "migration-manifest.json"),
        ],
        "MIGRATION_MANIFEST_MISSING",
      );
  return { migrationsFolder, manifestPath };
}

function parseCommand(argv: string[]) {
  if (argv[0] === "--") argv = argv.slice(1);
  const command = argv[0] as ReleaseDbCommand | undefined;
  if (!command || !["plan", "migrate", "postflight"].includes(command)) {
    throw new ReleaseDbError("RELEASE_DB_COMMAND_REQUIRED");
  }
  const allowed = new Set(["--json"]);
  if (command === "migrate") {
    allowed.add("--release-id");
    allowed.add("--allow-contract");
    allowed.add("--expected-applied-count");
    allowed.add("--expected-applied-journal-hash");
  }
  for (let index = 1; index < argv.length; index += 1) {
    const argument = argv[index]!;
    if (!allowed.has(argument)) {
      throw new ReleaseDbError(`RELEASE_DB_ARGUMENT_INVALID:${argument}`);
    }
    if (
      argument === "--release-id" ||
      argument === "--expected-applied-count" ||
      argument === "--expected-applied-journal-hash"
    ) {
      index += 1;
    }
  }
  const releaseIdIndex = argv.indexOf("--release-id");
  const releaseId =
    releaseIdIndex >= 0 ? String(argv[releaseIdIndex + 1] || "") : null;
  if (
    command === "migrate" &&
    (!releaseId || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(releaseId))
  ) {
    throw new ReleaseDbError("RELEASE_ID_REQUIRED_OR_INVALID");
  }
  const expectedAppliedCountIndex = argv.indexOf("--expected-applied-count");
  const expectedAppliedCountValue =
    expectedAppliedCountIndex >= 0
      ? String(argv[expectedAppliedCountIndex + 1] || "")
      : "";
  const expectedAppliedJournalHashIndex = argv.indexOf(
    "--expected-applied-journal-hash",
  );
  const expectedAppliedJournalHash =
    expectedAppliedJournalHashIndex >= 0
      ? String(argv[expectedAppliedJournalHashIndex + 1] || "").toLowerCase()
      : "";
  if (
    command === "migrate" &&
    (!/^(?:0|[1-9][0-9]*)$/u.test(expectedAppliedCountValue) ||
      !/^[a-f0-9]{64}$/u.test(expectedAppliedJournalHash))
  ) {
    throw new ReleaseDbError("MIGRATION_EXPECTED_APPLIED_FACT_REQUIRED");
  }
  const expectedAppliedCount =
    command === "migrate" ? Number(expectedAppliedCountValue) : null;
  if (
    command === "migrate" &&
    (!Number.isSafeInteger(expectedAppliedCount) || expectedAppliedCount! < 0)
  ) {
    throw new ReleaseDbError("MIGRATION_EXPECTED_APPLIED_FACT_REQUIRED");
  }
  return {
    command,
    releaseId,
    allowContract: argv.includes("--allow-contract"),
    expectedAppliedCount,
    expectedAppliedJournalHash:
      command === "migrate" ? expectedAppliedJournalHash : null,
  };
}

function connectionUrl(command: ReleaseDbCommand, env = process.env) {
  const value =
    env.FRONTMIND_RELEASE_DB_URL ||
    (command === "migrate"
      ? env.MIGRATION_DATABASE_URL || env.DATABASE_URL
      : env.DATABASE_URL || env.MIGRATION_DATABASE_URL);
  if (!value) {
    throw new ReleaseDbError(
      command === "migrate"
        ? "MIGRATION_DATABASE_URL_REQUIRED"
        : "DATABASE_URL_REQUIRED",
    );
  }
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new ReleaseDbError("DATABASE_URL_INVALID");
  }
  if (parsed.protocol !== "mysql:" || !parsed.hostname || !parsed.pathname) {
    throw new ReleaseDbError("DATABASE_URL_INVALID");
  }
  return value;
}

async function loadVerifiedReleaseInputs() {
  const { migrationsFolder, manifestPath } = resolveReleaseDbPaths();
  const [manifest, currentManifest] = await Promise.all([
    loadMigrationManifest(manifestPath),
    createMigrationManifest({ migrationsFolder }),
  ]);
  if (
    manifest.journalHash !== currentManifest.journalHash ||
    manifest.schemaHash !== currentManifest.schemaHash ||
    manifest.schemaSnapshot !== currentManifest.schemaSnapshot
  ) {
    throw new ReleaseDbError("MIGRATION_MANIFEST_FOLDER_MISMATCH");
  }
  return { migrationsFolder, manifest };
}

function databaseAdapter(connection: Connection) {
  return {
    execute: async () =>
      connection.query(
        "SELECT id, hash, created_at FROM __drizzle_migrations ORDER BY created_at ASC, id ASC",
      ),
  };
}

async function releasePlan(
  command: ReleaseDbCommand,
  connection: Connection,
  manifest: MigrationManifest,
) {
  const result = await evaluateMigrationJournal(
    databaseAdapter(connection),
    manifest,
  );
  const schema =
    result.status === "exact"
      ? await evaluateDatabaseSchema(
          { query: (query) => connection.query(query) },
          manifest.schemaContract,
        )
      : {
          status: "not_checked" as const,
          expectedHash: manifest.schemaHash,
          expectedTableCount: manifest.schemaTableCount,
        };
  return { schemaVersion: 1 as const, command, ...result, schema };
}

function assertExactReleaseState(
  result: Awaited<ReturnType<typeof releasePlan>>,
  ledgerErrorPrefix: string,
) {
  if (result.status !== "exact") {
    throw new ReleaseDbError(`${ledgerErrorPrefix}:${result.status}`);
  }
  if (result.schema.status !== "exact") {
    throw new ReleaseDbError("DATABASE_SCHEMA_DIVERGED");
  }
}

function lockTimeoutSeconds(env = process.env) {
  const value = Number(env.FRONTMIND_MIGRATION_LOCK_TIMEOUT_SECONDS || "30");
  if (!Number.isInteger(value) || value < 0 || value > 300) {
    throw new ReleaseDbError("MIGRATION_LOCK_TIMEOUT_INVALID");
  }
  return value;
}

async function acquireMigrationLock(connection: Connection) {
  const [rows] = await connection.query("SELECT GET_LOCK(?, ?) AS acquired", [
    "frontmind-dashboard:release-db:migrate",
    lockTimeoutSeconds(),
  ]);
  const acquired = Number(
    (rows as Array<Record<string, unknown>>)[0]?.acquired,
  );
  if (acquired !== 1) throw new ReleaseDbError("MIGRATION_LOCK_UNAVAILABLE");
}

async function releaseMigrationLock(connection: Connection) {
  try {
    await connection.query("SELECT RELEASE_LOCK(?)", [
      "frontmind-dashboard:release-db:migrate",
    ]);
  } catch {
    // Closing the dedicated connection also releases the advisory lock.
  }
}

export async function runReleaseDb(argv = process.argv.slice(2)) {
  const parsed = parseCommand(argv);
  const { migrationsFolder, manifest } = await loadVerifiedReleaseInputs();
  const connection = await mysql.createConnection(
    connectionUrl(parsed.command),
  );
  try {
    if (parsed.command === "plan") {
      // plan is an observation API: ledger-exact/schema-diverged is a valid,
      // actionable fact, not a transport failure. Controllers need the full
      // JSON to distinguish ordinary preflight blocking from recovery of an
      // interrupted migration. postflight and migrate remain fail-closed.
      return await releasePlan("plan", connection, manifest);
    }
    if (parsed.command === "postflight") {
      const result = await releasePlan("postflight", connection, manifest);
      assertExactReleaseState(result, "MIGRATION_POSTFLIGHT_NOT_EXACT");
      return result;
    }

    await acquireMigrationLock(connection);
    try {
      const before = await releasePlan("migrate", connection, manifest);
      if (
        before.applied.count !== parsed.expectedAppliedCount ||
        before.applied.journalHash !== parsed.expectedAppliedJournalHash
      ) {
        throw new ReleaseDbError("MIGRATION_APPLIED_FACT_CHANGED");
      }
      if (before.status === "exact") {
        assertExactReleaseState(before, "MIGRATION_POSTFLIGHT_NOT_EXACT");
        return { ...before, releaseId: parsed.releaseId, migrated: false };
      }
      if (before.status !== "pending") {
        throw new ReleaseDbError(`MIGRATION_NOT_SAFE:${before.status}`);
      }
      if (!before.allPendingExpand && !parsed.allowContract) {
        throw new ReleaseDbError("MIGRATION_CONTRACT_APPROVAL_REQUIRED");
      }
      await migrate(drizzle(connection), { migrationsFolder });
      const after = await releasePlan("migrate", connection, manifest);
      assertExactReleaseState(after, "MIGRATION_POSTFLIGHT_NOT_EXACT");
      return { ...after, releaseId: parsed.releaseId, migrated: true };
    } finally {
      await releaseMigrationLock(connection);
    }
  } finally {
    await connection.end();
  }
}

function safeErrorCode(error: unknown) {
  if (error instanceof ReleaseDbError) return error.code;
  if (error instanceof Error && /^[A-Z0-9_:-]+$/u.test(error.message)) {
    return error.message;
  }
  return "RELEASE_DB_FAILED";
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : "";
if (invokedPath === fileURLToPath(import.meta.url)) {
  try {
    console.log(JSON.stringify(await runReleaseDb()));
  } catch (error) {
    console.log(
      JSON.stringify({
        schemaVersion: 1,
        command: process.argv[2] || null,
        status: "error",
        error: { code: safeErrorCode(error) },
      }),
    );
    process.exitCode = 1;
  }
}
