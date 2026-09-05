import path from "node:path";
import { readFileSync } from "node:fs";

import { readMigrationFiles } from "drizzle-orm/migrator";
import mysql from "mysql2/promise";

import { normalizeDatabaseColumnDefault } from "./schema-contract.mjs";

const mode = String(process.argv[2] || "").trim();
if (mode !== "pre" && mode !== "post") {
  throw new Error("API_USAGE_MIGRATION_VERIFY_MODE_REQUIRED:pre|post");
}
if (!process.env.DATABASE_URL) {
  throw new Error("DATABASE_URL_REQUIRED");
}

const migrationsFolder = path.resolve(process.cwd(), "drizzle");
const expectedMigrations = readMigrationFiles({ migrationsFolder });
const requiredTags = [
  "0046_api_usage_snapshot_claims",
  "0047_api_usage_task_ledger",
  "0048_api_usage_coverage_claims",
];
const journalEntries = JSON.parse(
  readFileSync(path.join(migrationsFolder, "meta", "_journal.json"), "utf8"),
).entries;

for (const tag of requiredTags) {
  if (!journalEntries.some((entry) => entry.tag === tag)) {
    throw new Error(`API_USAGE_MIGRATION_MISSING:${tag}`);
  }
}

function assertColumn(actualColumns, table, name, expected) {
  const row = actualColumns.get(`${table}.${name}`);
  if (
    !row ||
    String(row.column_type).toLowerCase() !== expected.type ||
    String(row.is_nullable).toUpperCase() !== expected.nullable ||
    JSON.stringify(
      normalizeDatabaseColumnDefault(
        row.column_default,
        row.column_type,
        row.extra,
      ),
    ) !== JSON.stringify(expected.defaultValue) ||
    (expected.onUpdate === true &&
      !String(row.extra || "")
        .toLowerCase()
        .includes("on update current_timestamp"))
  ) {
    throw new Error(`API_USAGE_COLUMN_MISMATCH:${table}.${name}`);
  }
}

function assertIndex(actualIndexes, table, name, unique, columns) {
  const rows = actualIndexes
    .filter((row) => row.table_name === table && row.index_name === name)
    .sort(
      (left, right) => Number(left.seq_in_index) - Number(right.seq_in_index),
    );
  if (
    rows.length !== columns.length ||
    rows.some((row, index) => row.column_name !== columns[index]) ||
    rows.some((row) => Number(row.non_unique) !== (unique ? 0 : 1))
  ) {
    throw new Error(`API_USAGE_INDEX_MISMATCH:${table}.${name}`);
  }
}

function assertAbsent(actualColumns, actualIndexes, table, columns, indexes) {
  for (const name of columns) {
    if (actualColumns.has(`${table}.${name}`)) {
      throw new Error(`API_USAGE_PENDING_COLUMN_PRESENT:${table}.${name}`);
    }
  }
  for (const name of indexes) {
    if (
      actualIndexes.some(
        (row) => row.table_name === table && row.index_name === name,
      )
    ) {
      throw new Error(`API_USAGE_PENDING_INDEX_PRESENT:${table}.${name}`);
    }
  }
}

function assertExactColumnSet(actualColumns, table, expectedNames) {
  const actualNames = Array.from(actualColumns.values())
    .filter((row) => row.table_name === table)
    .map((row) => row.column_name)
    .sort();
  const expected = [...expectedNames].sort();
  if (
    actualNames.length !== expected.length ||
    actualNames.some((name, index) => name !== expected[index])
  ) {
    throw new Error(`API_USAGE_COLUMN_SET_MISMATCH:${table}`);
  }
}

const connection = await mysql.createConnection(process.env.DATABASE_URL);
try {
  const [ledgerRows] = await connection.query(
    "SELECT id, hash, created_at AS createdAt FROM __drizzle_migrations ORDER BY created_at ASC, id ASC",
  );
  if (ledgerRows.length > expectedMigrations.length) {
    throw new Error("MIGRATION_LEDGER_NOT_APPROVED_PREFIX");
  }
  for (const [index, row] of ledgerRows.entries()) {
    const expected = expectedMigrations[index];
    if (
      !expected ||
      String(row.hash) !== expected.hash ||
      Number(row.createdAt) !== expected.folderMillis
    ) {
      throw new Error(`MIGRATION_LEDGER_PREFIX_MISMATCH:${index}`);
    }
  }
  if (mode === "post" && ledgerRows.length !== expectedMigrations.length) {
    throw new Error(
      `MIGRATION_LEDGER_INCOMPLETE:${ledgerRows.length}/${expectedMigrations.length}`,
    );
  }

  const appliedTags = new Set(
    journalEntries.slice(0, ledgerRows.length).map((entry) => entry.tag),
  );
  const [tableRows] = await connection.query(`
    SELECT TABLE_NAME AS table_name, ENGINE AS engine
    FROM information_schema.tables
    WHERE table_schema = DATABASE()
      AND table_name IN (
        'api_usage_snapshots',
        'api_usage_task_ledger',
        'api_usage_credential_coverage'
      )
  `);
  const tables = new Map(tableRows.map((row) => [row.table_name, row]));
  const [columnRows] = await connection.query(`
    SELECT TABLE_NAME AS table_name, COLUMN_NAME AS column_name,
           COLUMN_TYPE AS column_type, IS_NULLABLE AS is_nullable,
           COLUMN_DEFAULT AS column_default, EXTRA AS extra
    FROM information_schema.columns
    WHERE table_schema = DATABASE()
      AND table_name IN (
        'api_usage_snapshots',
        'api_usage_task_ledger',
        'api_usage_credential_coverage'
      )
  `);
  const columns = new Map(
    columnRows.map((row) => [`${row.table_name}.${row.column_name}`, row]),
  );
  const [indexRows] = await connection.query(`
    SELECT TABLE_NAME AS table_name, INDEX_NAME AS index_name,
           COLUMN_NAME AS column_name, SEQ_IN_INDEX AS seq_in_index,
           NON_UNIQUE AS non_unique
    FROM information_schema.statistics
    WHERE table_schema = DATABASE()
      AND table_name IN (
        'api_usage_snapshots',
        'api_usage_task_ledger',
        'api_usage_credential_coverage'
      )
  `);

  const column = (type, nullable, defaultValue = null, onUpdate = false) => ({
    type,
    nullable,
    defaultValue:
      defaultValue === null
        ? null
        : defaultValue === "current_timestamp"
          ? { kind: "expression", value: "current_timestamp()" }
          : { kind: "literal", value: defaultValue },
    onUpdate,
  });
  const snapshotClaimsApplied = appliedTags.has(requiredTags[0]);
  if (snapshotClaimsApplied) {
    assertColumn(
      columns,
      "api_usage_snapshots",
      "syncGeneration",
      column("int unsigned", "NO", "0"),
    );
    assertColumn(
      columns,
      "api_usage_snapshots",
      "syncToken",
      column("varchar(36)", "YES"),
    );
    assertColumn(
      columns,
      "api_usage_snapshots",
      "syncStartedAt",
      column("timestamp", "YES"),
    );
    assertIndex(
      indexRows,
      "api_usage_snapshots",
      "api_usage_snapshots_sync_claim_idx",
      false,
      ["syncToken", "syncStartedAt"],
    );
  } else {
    assertAbsent(
      columns,
      indexRows,
      "api_usage_snapshots",
      ["syncGeneration", "syncToken", "syncStartedAt"],
      ["api_usage_snapshots_sync_claim_idx"],
    );
  }

  const ledgerApplied = appliedTags.has(requiredTags[1]);
  if (!ledgerApplied) {
    for (const table of [
      "api_usage_task_ledger",
      "api_usage_credential_coverage",
    ]) {
      if (tables.has(table)) {
        throw new Error(`API_USAGE_PENDING_TABLE_PRESENT:${table}`);
      }
    }
  } else {
    for (const table of [
      "api_usage_task_ledger",
      "api_usage_credential_coverage",
    ]) {
      if (String(tables.get(table)?.engine || "").toUpperCase() !== "INNODB") {
        throw new Error(`API_USAGE_TABLE_MISMATCH:${table}`);
      }
    }
    const taskColumns = {
      id: column("varchar(36)", "NO"),
      scope: column("enum('managed_user','website_frontend')", "NO"),
      upstreamTaskId: column("varchar(255)", "NO"),
      credentialFingerprint: column("varchar(32)", "NO"),
      apiCredentialId: column("varchar(36)", "YES"),
      accountUserId: column("int", "YES"),
      isFirstParty: column("tinyint(1)", "NO", "0"),
      taskCreatedAtMs: column("bigint unsigned", "NO"),
      creditUsage: column("bigint unsigned", "NO", "0"),
      isTerminal: column("tinyint(1)", "NO", "0"),
      observedAt: column("timestamp", "NO"),
      createdAt: column("timestamp", "NO", "current_timestamp"),
      updatedAt: column("timestamp", "NO", "current_timestamp", true),
    };
    const coverageColumns = {
      id: column("varchar(36)", "NO"),
      scope: column("enum('managed_user','website_frontend')", "NO"),
      credentialFingerprint: column("varchar(32)", "NO"),
      coveredFromMs: column("bigint unsigned", "NO"),
      fullScanAtMs: column("bigint unsigned", "NO"),
      credentialRetiredAtMs: column("bigint unsigned", "YES"),
      allTasksSettled: column("tinyint(1)", "NO", "0"),
      createdAt: column("timestamp", "NO", "current_timestamp"),
      updatedAt: column("timestamp", "NO", "current_timestamp", true),
    };
    for (const [name, expected] of Object.entries(taskColumns)) {
      assertColumn(columns, "api_usage_task_ledger", name, expected);
    }
    for (const [name, expected] of Object.entries(coverageColumns)) {
      assertColumn(columns, "api_usage_credential_coverage", name, expected);
    }
    assertExactColumnSet(
      columns,
      "api_usage_task_ledger",
      Object.keys(taskColumns),
    );
    assertIndex(indexRows, "api_usage_task_ledger", "PRIMARY", true, ["id"]);
    assertIndex(
      indexRows,
      "api_usage_task_ledger",
      "api_usage_task_ledger_scope_task_uq",
      true,
      ["scope", "upstreamTaskId"],
    );
    assertIndex(
      indexRows,
      "api_usage_task_ledger",
      "api_usage_task_ledger_account_time_idx",
      false,
      ["accountUserId", "taskCreatedAtMs"],
    );
    assertIndex(
      indexRows,
      "api_usage_task_ledger",
      "api_usage_task_ledger_pool_time_idx",
      false,
      ["scope", "credentialFingerprint", "taskCreatedAtMs"],
    );
    assertIndex(indexRows, "api_usage_credential_coverage", "PRIMARY", true, [
      "id",
    ]);
    assertIndex(
      indexRows,
      "api_usage_credential_coverage",
      "api_usage_credential_coverage_scope_fp_uq",
      true,
      ["scope", "credentialFingerprint"],
    );
    assertIndex(
      indexRows,
      "api_usage_credential_coverage",
      "api_usage_credential_coverage_scan_idx",
      false,
      ["scope", "fullScanAtMs"],
    );
    const [foreignKeyRows] = await connection.query(`
      SELECT kcu.TABLE_NAME AS table_name,
             kcu.CONSTRAINT_NAME AS constraint_name,
             kcu.COLUMN_NAME AS column_name,
             kcu.REFERENCED_TABLE_NAME AS referenced_table_name,
             kcu.REFERENCED_COLUMN_NAME AS referenced_column_name,
             rc.DELETE_RULE AS delete_rule,
             rc.UPDATE_RULE AS update_rule
      FROM information_schema.key_column_usage kcu
      JOIN information_schema.referential_constraints rc
        ON rc.constraint_schema = kcu.constraint_schema
       AND rc.table_name = kcu.table_name
       AND rc.constraint_name = kcu.constraint_name
      WHERE kcu.constraint_schema = DATABASE()
        AND kcu.table_name = 'api_usage_task_ledger'
        AND kcu.constraint_name =
          'api_usage_task_ledger_accountUserId_users_id_fk'
    `);
    const foreignKey = foreignKeyRows[0];
    if (
      foreignKeyRows.length !== 1 ||
      foreignKey.column_name !== "accountUserId" ||
      foreignKey.referenced_table_name !== "users" ||
      foreignKey.referenced_column_name !== "id" ||
      String(foreignKey.delete_rule).toUpperCase() !== "SET NULL" ||
      String(foreignKey.update_rule).toUpperCase() !== "NO ACTION"
    ) {
      throw new Error("API_USAGE_FOREIGN_KEY_MISMATCH");
    }
  }

  const coverageClaimsApplied = appliedTags.has(requiredTags[2]);
  if (coverageClaimsApplied) {
    assertColumn(
      columns,
      "api_usage_credential_coverage",
      "scanGeneration",
      column("int unsigned", "NO", "0"),
    );
    assertColumn(
      columns,
      "api_usage_credential_coverage",
      "scanToken",
      column("varchar(36)", "YES"),
    );
    assertColumn(
      columns,
      "api_usage_credential_coverage",
      "scanStartedAtMs",
      column("bigint unsigned", "YES"),
    );
    assertIndex(
      indexRows,
      "api_usage_credential_coverage",
      "api_usage_credential_coverage_claim_idx",
      false,
      ["scanToken", "scanStartedAtMs"],
    );
    assertExactColumnSet(columns, "api_usage_credential_coverage", [
      "id",
      "scope",
      "credentialFingerprint",
      "coveredFromMs",
      "fullScanAtMs",
      "credentialRetiredAtMs",
      "allTasksSettled",
      "scanGeneration",
      "scanToken",
      "scanStartedAtMs",
      "createdAt",
      "updatedAt",
    ]);
  } else if (ledgerApplied) {
    assertAbsent(
      columns,
      indexRows,
      "api_usage_credential_coverage",
      ["scanGeneration", "scanToken", "scanStartedAtMs"],
      ["api_usage_credential_coverage_claim_idx"],
    );
    assertExactColumnSet(columns, "api_usage_credential_coverage", [
      "id",
      "scope",
      "credentialFingerprint",
      "coveredFromMs",
      "fullScanAtMs",
      "credentialRetiredAtMs",
      "allTasksSettled",
      "createdAt",
      "updatedAt",
    ]);
  }

  console.log(
    mode === "post"
      ? `API_USAGE_0046_0048_SCHEMA_OK migrations=${ledgerRows.length}`
      : `API_USAGE_0046_0048_PREFLIGHT_OK applied=${ledgerRows.length} pending=${expectedMigrations.length - ledgerRows.length}`,
  );
} finally {
  await connection.end();
}
