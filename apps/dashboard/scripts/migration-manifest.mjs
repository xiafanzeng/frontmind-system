import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";

import { readMigrationFiles } from "drizzle-orm/migrator";

import {
  createSchemaContractFromSnapshot,
  parseSchemaContract,
  schemaContractHash,
} from "./schema-contract.mjs";

export const MIGRATION_MANIFEST_SCHEMA_VERSION = 2;
export const MIGRATION_CLASSIFICATIONS = ["expand", "contract"];

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function assertPlainObject(value, code) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(code);
  }
  return value;
}

function assertSha256(value, code) {
  if (!/^[a-f0-9]{64}$/u.test(String(value || ""))) {
    throw new Error(code);
  }
  return String(value);
}

export function canonicalMigrationJournalPayload(manifest) {
  return `${JSON.stringify({
    schemaVersion: MIGRATION_MANIFEST_SCHEMA_VERSION,
    dialect: manifest.dialect,
    journalVersion: manifest.journalVersion,
    migrations: manifest.migrations,
  })}\n`;
}

export function migrationJournalHash(manifest) {
  return sha256(canonicalMigrationJournalPayload(manifest));
}

export async function readMigrationPolicy(migrationsFolder) {
  const policyPath = path.join(migrationsFolder, "migration-policy.json");
  let policy;
  try {
    policy = JSON.parse(await readFile(policyPath, "utf8"));
  } catch {
    throw new Error("MIGRATION_POLICY_MISSING_OR_INVALID");
  }
  assertPlainObject(policy, "MIGRATION_POLICY_MISSING_OR_INVALID");
  if (
    policy.schemaVersion !== 1 ||
    typeof policy.historicalBaselineThrough !== "string" ||
    !policy.historicalBaselineThrough ||
    !policy.migrations ||
    typeof policy.migrations !== "object" ||
    Array.isArray(policy.migrations)
  ) {
    throw new Error("MIGRATION_POLICY_MISSING_OR_INVALID");
  }
  for (const [tag, classification] of Object.entries(policy.migrations)) {
    if (!tag || !MIGRATION_CLASSIFICATIONS.includes(String(classification))) {
      throw new Error(`MIGRATION_POLICY_ENTRY_INVALID:${tag || "unknown"}`);
    }
  }
  return policy;
}

export async function createMigrationManifest(options = {}) {
  const migrationsFolder = path.resolve(
    options.migrationsFolder || path.resolve(process.cwd(), "drizzle"),
  );
  let journal;
  try {
    journal = JSON.parse(
      await readFile(
        path.join(migrationsFolder, "meta", "_journal.json"),
        "utf8",
      ),
    );
  } catch {
    throw new Error("MIGRATION_JOURNAL_MISSING_OR_INVALID");
  }
  assertPlainObject(journal, "MIGRATION_JOURNAL_MISSING_OR_INVALID");
  if (
    journal.dialect !== "mysql" ||
    typeof journal.version !== "string" ||
    !Array.isArray(journal.entries) ||
    journal.entries.length === 0
  ) {
    throw new Error("MIGRATION_JOURNAL_MISSING_OR_INVALID");
  }

  const migrationFiles = readMigrationFiles({ migrationsFolder });
  if (migrationFiles.length !== journal.entries.length) {
    throw new Error("MIGRATION_JOURNAL_FILE_COUNT_MISMATCH");
  }
  const policy = await readMigrationPolicy(migrationsFolder);
  const baselineIndex = journal.entries.findIndex(
    (entry) => entry?.tag === policy.historicalBaselineThrough,
  );
  if (baselineIndex < 0) {
    throw new Error("MIGRATION_POLICY_BASELINE_UNKNOWN");
  }
  const journalTags = new Set(journal.entries.map((entry) => entry?.tag));
  for (const tag of Object.keys(policy.migrations)) {
    if (!journalTags.has(tag)) {
      throw new Error(`MIGRATION_POLICY_ENTRY_UNKNOWN:${tag}`);
    }
    const entryIndex = journal.entries.findIndex((entry) => entry?.tag === tag);
    if (entryIndex <= baselineIndex) {
      throw new Error(`MIGRATION_POLICY_HISTORICAL_OVERRIDE:${tag}`);
    }
  }

  const migrations = journal.entries.map((entry, index) => {
    const migration = migrationFiles[index];
    if (
      !entry ||
      entry.idx !== index ||
      typeof entry.tag !== "string" ||
      !entry.tag ||
      !Number.isSafeInteger(entry.when) ||
      entry.when <= 0 ||
      !migration ||
      migration.folderMillis !== entry.when
    ) {
      throw new Error(`MIGRATION_JOURNAL_ENTRY_INVALID:${index}`);
    }
    const configuredClassification = policy.migrations[entry.tag];
    const classification =
      index <= baselineIndex ? "contract" : configuredClassification;
    if (!MIGRATION_CLASSIFICATIONS.includes(String(classification))) {
      throw new Error(`MIGRATION_CLASSIFICATION_REQUIRED:${entry.tag}`);
    }
    return {
      idx: index,
      tag: entry.tag,
      when: entry.when,
      sqlSha256: assertSha256(
        migration.hash,
        `MIGRATION_SQL_HASH_INVALID:${entry.tag}`,
      ),
      classification,
    };
  });

  const latestMigration = migrations.at(-1);
  const schemaSnapshot = `meta/${String(latestMigration.idx).padStart(4, "0")}_snapshot.json`;
  let snapshot;
  try {
    snapshot = JSON.parse(
      await readFile(path.join(migrationsFolder, schemaSnapshot), "utf8"),
    );
  } catch {
    throw new Error("MIGRATION_SCHEMA_SNAPSHOT_MISSING_OR_INVALID");
  }
  const schemaContract = createSchemaContractFromSnapshot(snapshot);
  const schemaHash = schemaContractHash(schemaContract);

  const base = {
    schemaVersion: MIGRATION_MANIFEST_SCHEMA_VERSION,
    dialect: "mysql",
    journalVersion: journal.version,
    count: migrations.length,
    latestTag: migrations.at(-1)?.tag ?? null,
    migrations,
    schemaSnapshot,
    schemaTableCount: schemaContract.tables.length,
    schemaContract,
    schemaHash,
  };
  return { ...base, journalHash: migrationJournalHash(base) };
}

export function parseMigrationManifest(value) {
  assertPlainObject(value, "MIGRATION_MANIFEST_INVALID");
  if (
    value.schemaVersion !== MIGRATION_MANIFEST_SCHEMA_VERSION ||
    value.dialect !== "mysql" ||
    typeof value.journalVersion !== "string" ||
    !Number.isSafeInteger(value.count) ||
    value.count < 1 ||
    !Array.isArray(value.migrations) ||
    value.migrations.length !== value.count ||
    typeof value.latestTag !== "string" ||
    !value.latestTag ||
    typeof value.schemaSnapshot !== "string" ||
    !/^meta\/\d{4}_snapshot\.json$/u.test(value.schemaSnapshot) ||
    !Number.isSafeInteger(value.schemaTableCount) ||
    value.schemaTableCount < 1 ||
    !/^[a-f0-9]{64}$/u.test(String(value.schemaHash || "")) ||
    !/^[a-f0-9]{64}$/u.test(String(value.journalHash || ""))
  ) {
    throw new Error("MIGRATION_MANIFEST_INVALID");
  }
  for (const [index, entry] of value.migrations.entries()) {
    if (
      !entry ||
      entry.idx !== index ||
      typeof entry.tag !== "string" ||
      !entry.tag ||
      !Number.isSafeInteger(entry.when) ||
      entry.when <= 0 ||
      !/^[a-f0-9]{64}$/u.test(String(entry.sqlSha256 || "")) ||
      !MIGRATION_CLASSIFICATIONS.includes(entry.classification)
    ) {
      throw new Error(`MIGRATION_MANIFEST_ENTRY_INVALID:${index}`);
    }
  }
  if (
    value.latestTag !== value.migrations.at(-1)?.tag ||
    value.schemaSnapshot !==
      `meta/${String(value.migrations.at(-1)?.idx).padStart(4, "0")}_snapshot.json` ||
    parseSchemaContract(value.schemaContract).tables.length !==
      value.schemaTableCount ||
    schemaContractHash(value.schemaContract) !== value.schemaHash ||
    migrationJournalHash(value) !== value.journalHash
  ) {
    throw new Error("MIGRATION_MANIFEST_HASH_MISMATCH");
  }
  return value;
}

export async function readMigrationManifest(manifestPath) {
  let value;
  try {
    value = JSON.parse(await readFile(path.resolve(manifestPath), "utf8"));
  } catch {
    throw new Error("MIGRATION_MANIFEST_MISSING_OR_INVALID");
  }
  return parseMigrationManifest(value);
}
