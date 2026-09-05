import { createHash } from "node:crypto";
import path from "node:path";

import { sql, type SQL } from "drizzle-orm";

import { readMigrationManifest } from "../../scripts/migration-manifest.mjs";
import type { DatabaseSchemaContract } from "../../scripts/schema-contract.mjs";

export type MigrationClassification = "expand" | "contract";
export type MigrationJournalStatus = "exact" | "pending" | "ahead" | "diverged";

export type MigrationManifestEntry = {
  idx: number;
  tag: string;
  when: number;
  sqlSha256: string;
  classification: MigrationClassification;
};

export type MigrationManifest = {
  schemaVersion: 2;
  dialect: "mysql";
  journalVersion: string;
  count: number;
  latestTag: string;
  migrations: MigrationManifestEntry[];
  journalHash: string;
  schemaSnapshot: string;
  schemaTableCount: number;
  schemaContract: DatabaseSchemaContract;
  schemaHash: string;
};

export type AppliedMigration = {
  id: number;
  hash: string;
  createdAt: number;
};

type MigrationDatabase = {
  execute(query: SQL): Promise<unknown>;
};

type MigrationRow = Record<string, unknown>;

function resultRows(result: unknown): MigrationRow[] {
  if (!Array.isArray(result)) return [];
  const candidate = Array.isArray(result[0]) ? result[0] : result;
  return candidate.filter(
    (row): row is MigrationRow => Boolean(row) && typeof row === "object",
  );
}

function rowValue(row: MigrationRow, ...keys: string[]) {
  for (const key of keys) {
    if (row[key] !== undefined) return row[key];
  }
  const normalizedKeys = new Set(
    keys.map((key) => key.replaceAll("_", "").toLowerCase()),
  );
  for (const [key, value] of Object.entries(row)) {
    if (normalizedKeys.has(key.replaceAll("_", "").toLowerCase())) {
      return value;
    }
  }
  return undefined;
}

function databaseErrorCode(error: unknown) {
  if (!error || typeof error !== "object") return null;
  const value = error as { code?: unknown; errno?: unknown };
  return {
    code: typeof value.code === "string" ? value.code : null,
    errno: Number(value.errno),
  };
}

function isMissingMigrationLedger(error: unknown) {
  const details = databaseErrorCode(error);
  return details?.code === "ER_NO_SUCH_TABLE" || details?.errno === 1146;
}

export async function loadMigrationManifest(
  manifestPath: string,
): Promise<MigrationManifest> {
  return (await readMigrationManifest(manifestPath)) as MigrationManifest;
}

export function bundledMigrationManifestPath(runtimeRoot: string) {
  return path.join(path.resolve(runtimeRoot), "migration-manifest.json");
}

export async function readAppliedMigrationJournal(
  db: MigrationDatabase,
): Promise<AppliedMigration[]> {
  let result: unknown;
  try {
    result = await db.execute(sql`
      SELECT id, hash, created_at
      FROM __drizzle_migrations
      ORDER BY created_at ASC, id ASC
    `);
  } catch (error) {
    if (isMissingMigrationLedger(error)) return [];
    throw error;
  }
  return resultRows(result).map((row, index) => {
    const id = Number(rowValue(row, "id"));
    const hash = String(rowValue(row, "hash") || "").toLowerCase();
    const createdAt = Number(rowValue(row, "createdAt", "created_at"));
    if (
      !Number.isSafeInteger(id) ||
      id < 1 ||
      !/^[a-f0-9]{64}$/u.test(hash) ||
      !Number.isSafeInteger(createdAt) ||
      createdAt <= 0
    ) {
      throw new Error(`MIGRATION_LEDGER_ROW_INVALID:${index}`);
    }
    return { id, hash, createdAt };
  });
}

function appliedJournalHash(applied: AppliedMigration[]) {
  return createHash("sha256")
    .update(
      `${JSON.stringify(
        applied.map(({ hash, createdAt }) => ({ hash, createdAt })),
      )}\n`,
    )
    .digest("hex");
}

export function classifyMigrationJournal(
  manifest: MigrationManifest,
  applied: AppliedMigration[],
) {
  const commonLength = Math.min(manifest.migrations.length, applied.length);
  let mismatchIndex: number | null = null;
  for (let index = 0; index < commonLength; index += 1) {
    const expected = manifest.migrations[index]!;
    const actual = applied[index]!;
    if (
      actual.hash !== expected.sqlSha256 ||
      actual.createdAt !== expected.when
    ) {
      mismatchIndex = index;
      break;
    }
  }

  let status: MigrationJournalStatus;
  if (mismatchIndex !== null) status = "diverged";
  else if (applied.length === manifest.migrations.length) status = "exact";
  else if (applied.length < manifest.migrations.length) status = "pending";
  else status = "ahead";

  const pending =
    status === "pending" ? manifest.migrations.slice(applied.length) : [];
  return {
    status,
    journalHash: manifest.journalHash,
    expected: {
      count: manifest.count,
      latestTag: manifest.latestTag,
      journalHash: manifest.journalHash,
    },
    applied: {
      count: applied.length,
      latestTag:
        mismatchIndex === null &&
        applied.length > 0 &&
        applied.length <= manifest.count
          ? (manifest.migrations[applied.length - 1]?.tag ?? null)
          : null,
      journalHash: appliedJournalHash(applied),
    },
    pending,
    allPendingExpand:
      status === "pending" &&
      pending.length > 0 &&
      pending.every((entry) => entry.classification === "expand"),
    mismatchIndex,
  };
}

export async function evaluateMigrationJournal(
  db: MigrationDatabase,
  manifest: MigrationManifest,
) {
  const applied = await readAppliedMigrationJournal(db);
  return classifyMigrationJournal(manifest, applied);
}
