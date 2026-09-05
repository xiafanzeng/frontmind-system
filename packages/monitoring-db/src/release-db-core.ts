import { drizzle } from "drizzle-orm/mysql2";
import { migrate as drizzleMigrate } from "drizzle-orm/mysql2/migrator";
import type { Connection, RowDataPacket } from "mysql2/promise";
import {
  inspectSchema,
  loadExpectedSchema,
  type SchemaInspection,
} from "./schema-contract.js";
import {
  journalHash,
  type ReleaseManifest,
  type ReleaseMigration,
} from "./release-manifest.js";

export const RELEASE_DB_SCHEMA_VERSION = 1 as const;
export const RELEASE_DB_LOCK_NAME = "frontmind-monitoring-release-db-v1";

export type LedgerStatus =
  "exact" | "pending" | "ahead" | "diverged" | "unknown";

export type PlanSchema =
  | SchemaInspection
  | { status: "not_checked"; contractHash: null; mismatch: null };

export type ReleaseDbPlan = {
  schemaVersion: typeof RELEASE_DB_SCHEMA_VERSION;
  status: LedgerStatus;
  schema: PlanSchema;
  appliedCount: number;
  appliedJournalHash: string;
  expectedCount: number;
  expectedJournalHash: string;
  pendingMigrations: Array<
    Pick<ReleaseMigration, "idx" | "tag" | "when" | "sqlSha256" | "kind">
  >;
  allPendingExpand: boolean;
  mismatchIndex: number | null;
};

export type AppliedMigration = { id: number; when: number; hash: string };

type CountRow = RowDataPacket & { present: number };
type LedgerRow = RowDataPacket & {
  id: number | string;
  migrationHash: string;
  migrationWhen: number | string;
};
type LockRow = RowDataPacket & { acquired: number | null };

const SHA256_PATTERN = /^[a-f0-9]{64}$/;

export async function createReleaseDbPlan(
  connection: Connection,
  manifest: ReleaseManifest,
): Promise<ReleaseDbPlan> {
  const applied = await readAppliedMigrations(connection);
  const classification = classifyLedger(applied, manifest.migrations);
  let schema: PlanSchema = {
    status: "not_checked",
    contractHash: null,
    mismatch: null,
  };

  if (classification.status === "exact") {
    schema = await inspectSchema(
      connection,
      await loadExpectedSchema(manifest),
    );
  } else if (classification.status === "pending") {
    const schemaIndex = applied.length - 1;
    if (schemaIndex >= 0) {
      schema = await inspectSchema(
        connection,
        await loadExpectedSchema(manifest, schemaIndex),
      );
    } else {
      // The latest contract is used only to enumerate business tables. With no
      // ledger, any non-empty schema is deliberately distinguishable from empty.
      schema = await inspectSchema(
        connection,
        await loadExpectedSchema(manifest),
      );
    }
  }

  const pendingMigrations =
    classification.status === "pending"
      ? manifest.migrations.slice(applied.length).map((migration) => ({
          idx: migration.idx,
          tag: migration.tag,
          when: migration.when,
          sqlSha256: migration.sqlSha256,
          kind: migration.kind,
        }))
      : [];

  return {
    schemaVersion: RELEASE_DB_SCHEMA_VERSION,
    status: classification.status,
    schema,
    appliedCount: applied.length,
    appliedJournalHash: journalHash(
      applied.map((migration) => ({
        when: migration.when,
        hash: migration.hash,
      })),
    ),
    expectedCount: manifest.migrations.length,
    expectedJournalHash: manifest.expectedJournalHash,
    pendingMigrations,
    allPendingExpand:
      pendingMigrations.length > 0 &&
      pendingMigrations.every((migration) => migration.kind === "expand"),
    mismatchIndex: classification.mismatchIndex,
  };
}

export function classifyLedger(
  applied: ReadonlyArray<Pick<AppliedMigration, "when" | "hash">>,
  expected: ReadonlyArray<Pick<ReleaseMigration, "when" | "sqlSha256">>,
): { status: Exclude<LedgerStatus, "unknown">; mismatchIndex: number | null } {
  const commonLength = Math.min(applied.length, expected.length);
  for (let index = 0; index < commonLength; index += 1) {
    const actualEntry = applied[index];
    const expectedEntry = expected[index];
    if (
      !actualEntry ||
      !expectedEntry ||
      actualEntry.when !== expectedEntry.when ||
      actualEntry.hash !== expectedEntry.sqlSha256
    ) {
      return { status: "diverged", mismatchIndex: index };
    }
  }
  if (applied.length === expected.length) {
    return { status: "exact", mismatchIndex: null };
  }
  if (applied.length < expected.length) {
    return { status: "pending", mismatchIndex: null };
  }
  return { status: "ahead", mismatchIndex: expected.length };
}

export async function migratePendingRelease(options: {
  connection: Connection;
  manifest: ReleaseManifest;
  releaseId: string;
  expectedAppliedCount: number;
  expectedAppliedJournalHash: string;
}): Promise<ReleaseDbPlan & { releaseId: string; migrated: string[] }> {
  const { connection, manifest } = options;
  return withMigrationLock(connection, async () => {
    const before = await createReleaseDbPlan(connection, manifest);
    assertExpectedPlan(before, options);
    if (before.status !== "pending") {
      throw new Error(
        `Migration requires pending status, found ${before.status}`,
      );
    }
    if (before.schema.status !== "exact") {
      throw new Error(
        `Migration requires the applied schema contract to be exact, found ${before.schema.status}`,
      );
    }
    if (!before.allPendingExpand) {
      throw new Error("Normal releases may apply only expand migrations");
    }
    const migrated = before.pendingMigrations.map((migration) => migration.tag);
    await applyJournal(connection, manifest);
    const after = await createReleaseDbPlan(connection, manifest);
    assertExactPostflight(after);
    return { ...after, releaseId: options.releaseId, migrated };
  });
}

export async function bootstrapEmptyRelease(options: {
  connection: Connection;
  manifest: ReleaseManifest;
  releaseId: string;
}): Promise<ReleaseDbPlan & { releaseId: string; migrated: string[] }> {
  const { connection, manifest } = options;
  return withMigrationLock(connection, async () => {
    const before = await createReleaseDbPlan(connection, manifest);
    if (
      before.status !== "pending" ||
      before.appliedCount !== 0 ||
      before.schema.status !== "empty"
    ) {
      throw new Error(
        "bootstrap-empty requires a database with no migration ledger and no business tables",
      );
    }
    const migrated = manifest.migrations.map((migration) => migration.tag);
    await applyJournal(connection, manifest);
    const after = await createReleaseDbPlan(connection, manifest);
    assertExactPostflight(after);
    return { ...after, releaseId: options.releaseId, migrated };
  });
}

export function assertExactPostflight(plan: ReleaseDbPlan): void {
  if (plan.status !== "exact" || plan.schema.status !== "exact") {
    throw new Error(
      `Release database postflight is not exact (ledger=${plan.status}, schema=${plan.schema.status})`,
    );
  }
}

async function readAppliedMigrations(
  connection: Connection,
): Promise<AppliedMigration[]> {
  const [tableRows] = await connection.execute<CountRow[]>(
    `SELECT COUNT(*) AS present
       FROM information_schema.TABLES
      WHERE TABLE_SCHEMA = DATABASE()
        AND TABLE_NAME = '__drizzle_migrations'
        AND TABLE_TYPE = 'BASE TABLE'`,
  );
  if (Number(tableRows[0]?.present ?? 0) === 0) return [];

  const [rows] = await connection.execute<LedgerRow[]>(
    `SELECT id,
            hash AS migrationHash,
            created_at AS migrationWhen
       FROM __drizzle_migrations
      ORDER BY created_at, id`,
  );
  return rows.map((row, index) => {
    const id = Number(row.id);
    const when = Number(row.migrationWhen);
    const hash = String(row.migrationHash);
    if (
      !Number.isSafeInteger(id) ||
      id < 1 ||
      !Number.isSafeInteger(when) ||
      when < 1 ||
      !SHA256_PATTERN.test(hash)
    ) {
      throw new Error(`Invalid migration ledger row at index ${index}`);
    }
    return { id, when, hash };
  });
}

async function applyJournal(
  connection: Connection,
  manifest: ReleaseManifest,
): Promise<void> {
  const db = drizzle(connection);
  await drizzleMigrate(db, { migrationsFolder: manifest.migrationsDirectory });
}

async function withMigrationLock<T>(
  connection: Connection,
  operation: () => Promise<T>,
): Promise<T> {
  const [rows] = await connection.execute<LockRow[]>(
    "SELECT GET_LOCK(?, 30) AS acquired",
    [RELEASE_DB_LOCK_NAME],
  );
  if (Number(rows[0]?.acquired ?? 0) !== 1) {
    throw new Error("Could not acquire the production migration advisory lock");
  }
  try {
    return await operation();
  } finally {
    await connection.execute("SELECT RELEASE_LOCK(?)", [RELEASE_DB_LOCK_NAME]);
  }
}

function assertExpectedPlan(
  plan: ReleaseDbPlan,
  expected: {
    expectedAppliedCount: number;
    expectedAppliedJournalHash: string;
  },
): void {
  if (
    plan.appliedCount !== expected.expectedAppliedCount ||
    plan.appliedJournalHash !== expected.expectedAppliedJournalHash
  ) {
    throw new Error(
      "Database migration state changed between plan and migrate; refusing TOCTOU mutation",
    );
  }
}
