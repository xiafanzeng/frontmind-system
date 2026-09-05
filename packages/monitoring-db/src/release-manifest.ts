import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

export type MigrationKind = "expand" | "contract";

export type ReleaseMigration = {
  idx: number;
  tag: string;
  when: number;
  sqlSha256: string;
  snapshotSha256: string;
  kind: MigrationKind;
  bootstrapBaseline: boolean;
  sqlPath: string;
  snapshotPath: string;
};

export type ReleaseManifest = {
  schemaVersion: 1;
  migrationsDirectory: string;
  expectedJournalHash: string;
  migrations: ReleaseMigration[];
};

type JournalDocument = {
  version: string;
  dialect: string;
  entries: Array<{
    idx: number;
    version: string;
    when: number;
    tag: string;
    breakpoints: boolean;
  }>;
};

type PolicyDocument = {
  schemaVersion: number;
  migrations: Array<{
    tag: string;
    when: number;
    sqlSha256: string;
    snapshotSha256: string;
    kind: string;
    bootstrapBaseline?: boolean;
  }>;
};

const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const TAG_PATTERN = /^[0-9]{4}_[a-z0-9_]+$/;

export function defaultMigrationsDirectory(): string {
  return fileURLToPath(new URL("../migrations", import.meta.url));
}

export function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

export function journalHash(
  entries: ReadonlyArray<{ when: number; hash: string }>,
): string {
  const canonical = entries
    .map(({ when, hash }) => `${String(when)}\t${hash}\n`)
    .join("");
  return sha256(canonical);
}

export async function loadReleaseManifest(
  migrationsDirectory = defaultMigrationsDirectory(),
): Promise<ReleaseManifest> {
  const journalPath = path.join(migrationsDirectory, "meta", "_journal.json");
  const policyPath = path.join(migrationsDirectory, "release-policy.json");
  const [journalText, policyText] = await Promise.all([
    readFile(journalPath, "utf8"),
    readFile(policyPath, "utf8"),
  ]);
  const journal = parseDocument<JournalDocument>(journalText, journalPath);
  const policy = parseDocument<PolicyDocument>(policyText, policyPath);

  if (journal.version !== "7" || journal.dialect !== "mysql") {
    throw new Error("The Drizzle journal must use MySQL journal version 7");
  }
  if (policy.schemaVersion !== 1) {
    throw new Error("release-policy.json must use schemaVersion 1");
  }
  if (!Array.isArray(journal.entries) || !Array.isArray(policy.migrations)) {
    throw new Error("Migration journal and policy entries must be arrays");
  }
  if (journal.entries.length === 0) {
    throw new Error("The production migration journal cannot be empty");
  }
  if (journal.entries.length !== policy.migrations.length) {
    throw new Error(
      "Migration policy must contain exactly one record per journal entry",
    );
  }

  const migrations: ReleaseMigration[] = [];
  for (const [position, journalEntry] of journal.entries.entries()) {
    const policyEntry = policy.migrations[position];
    if (!policyEntry)
      throw new Error(`Missing migration policy at index ${position}`);
    if (
      !Number.isSafeInteger(journalEntry.idx) ||
      journalEntry.idx !== position ||
      !Number.isSafeInteger(journalEntry.when) ||
      journalEntry.when <= 0 ||
      journalEntry.version !== "7" ||
      typeof journalEntry.breakpoints !== "boolean" ||
      !TAG_PATTERN.test(journalEntry.tag)
    ) {
      throw new Error(`Invalid Drizzle journal entry at index ${position}`);
    }
    const previousEntry = journal.entries[position - 1];
    if (previousEntry && journalEntry.when <= previousEntry.when) {
      throw new Error(
        `Migration timestamps must be strictly increasing at ${journalEntry.tag}`,
      );
    }
    if (
      policyEntry.tag !== journalEntry.tag ||
      policyEntry.when !== journalEntry.when
    ) {
      throw new Error(
        `Migration policy does not match journal entry ${journalEntry.tag}`,
      );
    }
    if (!SHA256_PATTERN.test(policyEntry.sqlSha256)) {
      throw new Error(`Invalid SQL SHA-256 for ${journalEntry.tag}`);
    }
    if (!SHA256_PATTERN.test(policyEntry.snapshotSha256)) {
      throw new Error(`Invalid snapshot SHA-256 for ${journalEntry.tag}`);
    }
    if (policyEntry.kind !== "expand" && policyEntry.kind !== "contract") {
      throw new Error(`Invalid migration kind for ${journalEntry.tag}`);
    }
    const bootstrapBaseline = policyEntry.bootstrapBaseline === true;
    if (
      position === 0 &&
      (!bootstrapBaseline || journalEntry.tag !== "0000_frontmind_monitoring")
    ) {
      throw new Error(
        "0000_frontmind_monitoring must be the bootstrap baseline",
      );
    }
    if (position > 0 && bootstrapBaseline) {
      throw new Error("Only the first migration may be the bootstrap baseline");
    }

    const ordinal = String(position).padStart(4, "0");
    const sqlPath = path.join(migrationsDirectory, `${journalEntry.tag}.sql`);
    const snapshotPath = path.join(
      migrationsDirectory,
      "meta",
      `${ordinal}_snapshot.json`,
    );
    const [sqlBytes, snapshotBytes] = await Promise.all([
      readFile(sqlPath),
      readFile(snapshotPath),
    ]);
    if (sha256(sqlBytes) !== policyEntry.sqlSha256) {
      throw new Error(
        `Committed SQL hash does not match policy for ${journalEntry.tag}`,
      );
    }
    if (sha256(snapshotBytes) !== policyEntry.snapshotSha256) {
      throw new Error(
        `Committed snapshot hash does not match policy for ${journalEntry.tag}`,
      );
    }

    migrations.push({
      idx: position,
      tag: journalEntry.tag,
      when: journalEntry.when,
      sqlSha256: policyEntry.sqlSha256,
      snapshotSha256: policyEntry.snapshotSha256,
      kind: policyEntry.kind,
      bootstrapBaseline,
      sqlPath,
      snapshotPath,
    });
  }

  return {
    schemaVersion: 1,
    migrationsDirectory,
    expectedJournalHash: journalHash(
      migrations.map((migration) => ({
        when: migration.when,
        hash: migration.sqlSha256,
      })),
    ),
    migrations,
  };
}

function parseDocument<T>(source: string, sourcePath: string): T {
  let parsed: unknown;
  try {
    parsed = JSON.parse(source);
  } catch {
    throw new Error(`Invalid JSON in ${sourcePath}`);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`Expected a JSON object in ${sourcePath}`);
  }
  return parsed as T;
}
