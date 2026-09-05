import {
  mkdtemp,
  mkdir,
  readFile,
  rm,
  writeFile,
  copyFile,
} from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import path from "node:path";
import mysql from "mysql2/promise";
import { drizzle } from "drizzle-orm/mysql2";
import { migrate } from "drizzle-orm/mysql2/migrator";

import { createMigrationManifest } from "./migration-manifest.mjs";
import { evaluateDatabaseSchema } from "./schema-contract.mjs";
import { isApprovedUnreleasedMigrationCorrection } from "./unreleased-migration-correction-policy.mjs";

const databaseUrl = process.env.DATABASE_URL?.trim();
if (!databaseUrl) throw new Error("DATABASE_URL_REQUIRED");
const parsed = new URL(databaseUrl);
const databaseName = decodeURIComponent(parsed.pathname.replace(/^\//u, ""));
if (
  parsed.protocol !== "mysql:" ||
  !/^[A-Za-z0-9_$-]*acceptance[A-Za-z0-9_$-]*$/iu.test(databaseName)
) {
  throw new Error("CI_UPGRADE_DATABASE_MUST_BE_DISPOSABLE_ACCEPTANCE_DB");
}

const repositoryRoot = path.resolve(import.meta.dirname, "..");
const migrationsRoot = path.join(repositoryRoot, "drizzle");
const sha256 = (value) => createHash("sha256").update(value).digest("hex");
const gitShow = (ref, file, encoding) =>
  execFileSync("git", ["show", `${ref}:${file}`], {
    cwd: repositoryRoot,
    encoding,
    stdio: ["ignore", "pipe", "pipe"],
  });
const journal = JSON.parse(
  await readFile(path.join(migrationsRoot, "meta/_journal.json"), "utf8"),
);
const explicitBaseIdx = process.env.FRONTMIND_UPGRADE_BASE_IDX?.trim();
const baseRef = process.env.FRONTMIND_UPGRADE_BASE_REF?.trim();
let baseEntries;
let baseJournal = journal;
let baseMode;
if (explicitBaseIdx) {
  const baseIdx = Number.parseInt(explicitBaseIdx, 10);
  if (
    !Number.isInteger(baseIdx) ||
    baseIdx < 0 ||
    baseIdx >= journal.entries.length - 1
  ) {
    throw new Error("FRONTMIND_UPGRADE_BASE_IDX_INVALID");
  }
  baseEntries = journal.entries.slice(0, baseIdx + 1);
  baseMode = `historical-${baseEntries.at(-1).tag}`;
} else if (baseRef) {
  if (!/^[A-Za-z0-9_./^~-]+$/u.test(baseRef)) {
    throw new Error("FRONTMIND_UPGRADE_BASE_REF_INVALID");
  }
  baseJournal = JSON.parse(
    gitShow(baseRef, "drizzle/meta/_journal.json", "utf8"),
  );
  if (
    !Array.isArray(baseJournal.entries) ||
    baseJournal.entries.length > journal.entries.length ||
    baseJournal.entries.some(
      (entry, index) =>
        JSON.stringify(entry) !== JSON.stringify(journal.entries[index]),
    )
  ) {
    throw new Error("BASE_REF_MIGRATION_JOURNAL_NOT_CURRENT_PREFIX");
  }
  for (const entry of baseJournal.entries) {
    const snapshotName = `${String(entry.idx).padStart(4, "0")}_snapshot.json`;
    const [currentSql, currentSnapshot] = await Promise.all([
      readFile(path.join(migrationsRoot, `${entry.tag}.sql`)),
      readFile(path.join(migrationsRoot, "meta", snapshotName)),
    ]);
    const baseSql = gitShow(baseRef, `drizzle/${entry.tag}.sql`);
    const baseSnapshot = gitShow(baseRef, `drizzle/meta/${snapshotName}`);
    const currentSqlSha256 = sha256(currentSql);
    const baseSqlSha256 = sha256(baseSql);
    const approvedUnreleasedCorrection =
      isApprovedUnreleasedMigrationCorrection({
        baseRef,
        tag: entry.tag,
        baseSqlSha256,
        currentSqlSha256,
      });
    if (
      (!approvedUnreleasedCorrection && currentSqlSha256 !== baseSqlSha256) ||
      sha256(currentSnapshot) !== sha256(baseSnapshot)
    ) {
      throw new Error(`BASE_REF_RELEASED_MIGRATION_MUTATED:${entry.tag}`);
    }
    if (approvedUnreleasedCorrection) {
      console.log(
        `UNRELEASED_MIGRATION_CORRECTION_ACCEPTED:${entry.tag}:${baseRef}`,
      );
    }
  }
  if (baseJournal.entries.length > 49) {
    let basePolicy;
    try {
      basePolicy = JSON.parse(
        gitShow(baseRef, "drizzle/migration-policy.json", "utf8"),
      );
    } catch {
      throw new Error("BASE_REF_RELEASED_MIGRATION_POLICY_MISSING");
    }
    const currentPolicy = JSON.parse(
      await readFile(
        path.join(migrationsRoot, "migration-policy.json"),
        "utf8",
      ),
    );
    for (const entry of baseJournal.entries.slice(49)) {
      if (
        !["expand", "contract"].includes(basePolicy.migrations?.[entry.tag]) ||
        currentPolicy.migrations?.[entry.tag] !==
          basePolicy.migrations[entry.tag]
      ) {
        throw new Error(
          `BASE_REF_RELEASED_MIGRATION_POLICY_MUTATED:${entry.tag}`,
        );
      }
    }
  }
  if (baseJournal.entries.length < journal.entries.length) {
    baseEntries = baseJournal.entries;
    baseMode = `base-ref-${baseRef}`;
  } else {
    // A code-only PR has no new migration. Still exercise the most recent
    // upgrade edge by building current-minus-one and applying the tail.
    baseEntries = journal.entries.slice(0, -1);
    baseJournal = journal;
    baseMode = "current-previous-migration";
  }
} else {
  throw new Error("FRONTMIND_UPGRADE_BASE_REF_OR_IDX_REQUIRED");
}
if (baseEntries.length === 0 || baseEntries.length >= journal.entries.length) {
  throw new Error("CI_UPGRADE_BASE_MUST_BE_STRICT_PREFIX");
}

const pool = mysql.createPool({ uri: databaseUrl, connectionLimit: 4 });
const temporaryRoot = await mkdtemp(
  path.join(tmpdir(), "frontmind-migration-upgrade-"),
);
try {
  const [beforeRows] = await pool.query(
    "SELECT COUNT(*) AS tableCount FROM information_schema.tables WHERE table_schema = DATABASE()",
  );
  if (Number(beforeRows[0]?.tableCount || 0) !== 0) {
    throw new Error("CI_UPGRADE_DATABASE_MUST_BE_EMPTY");
  }

  const baseRoot = path.join(temporaryRoot, "base");
  await mkdir(path.join(baseRoot, "meta"), { recursive: true });
  for (const entry of baseEntries) {
    const target = path.join(baseRoot, `${entry.tag}.sql`);
    if (baseRef && baseMode.startsWith("base-ref-")) {
      await writeFile(
        target,
        gitShow(baseRef, `drizzle/${entry.tag}.sql`, "utf8"),
      );
    } else {
      await copyFile(path.join(migrationsRoot, `${entry.tag}.sql`), target);
    }
  }
  await writeFile(
    path.join(baseRoot, "meta/_journal.json"),
    `${JSON.stringify({ ...journal, entries: baseEntries }, null, 2)}\n`,
  );

  const executor = drizzle(pool);
  await migrate(executor, { migrationsFolder: baseRoot });
  const [baseLedgerRows] = await pool.query(
    "SELECT COUNT(*) AS migrationCount FROM __drizzle_migrations",
  );
  if (Number(baseLedgerRows[0]?.migrationCount || 0) !== baseEntries.length) {
    throw new Error("CI_BASE_MIGRATION_LEDGER_MISMATCH");
  }

  await migrate(executor, { migrationsFolder: migrationsRoot });
  const [finalLedgerRows] = await pool.query(
    "SELECT COUNT(*) AS migrationCount FROM __drizzle_migrations",
  );
  if (
    Number(finalLedgerRows[0]?.migrationCount || 0) !== journal.entries.length
  ) {
    throw new Error("CI_FINAL_MIGRATION_LEDGER_MISMATCH");
  }
  const [engineRows] = await pool.query(
    "SELECT COUNT(*) AS invalidCount FROM information_schema.tables WHERE table_schema = DATABASE() AND engine <> 'InnoDB'",
  );
  if (Number(engineRows[0]?.invalidCount || 0) !== 0) {
    throw new Error("CI_MIGRATION_NON_INNODB_TABLE_FOUND");
  }
  const manifest = await createMigrationManifest({
    migrationsFolder: migrationsRoot,
  });
  const schema = await evaluateDatabaseSchema(
    { query: (query) => pool.query(query) },
    manifest.schemaContract,
  );
  if (schema.status !== "exact") {
    throw new Error(
      `CI_FINAL_SCHEMA_DIVERGED:${schema.differences.join(",") || "hash"}`,
    );
  }

  console.log(
    `MYSQL_UPGRADE_OK mode=${baseMode} base=${baseEntries.at(-1).tag} current=${journal.entries.at(-1).tag} count=${journal.entries.length} schema=${schema.actualHash}`,
  );
} finally {
  await pool.end();
  await rm(temporaryRoot, { recursive: true, force: true });
}
