import { spawnSync } from "node:child_process";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import {
  defaultMigrationsDirectory,
  loadReleaseManifest,
} from "./release-manifest.js";

type Journal = {
  entries: Array<{ idx: number; tag: string; [key: string]: unknown }>;
};
type Policy = { migrations: unknown[] };

try {
  const base = parseArguments(process.argv.slice(2));
  const migrationsDirectory = defaultMigrationsDirectory();
  const manifest = await loadReleaseManifest(migrationsDirectory);
  await rejectOrphanedMigrationFiles(migrationsDirectory, manifest.migrations);
  if (base) await verifyAppendOnlyAgainstGit(base, migrationsDirectory);
  process.stdout.write(
    `Migration release policy is valid and append-only (${manifest.migrations.length} entries).\n`,
  );
} catch (error) {
  process.stderr.write(
    `Migration policy check failed: ${error instanceof Error ? error.message : String(error)}\n`,
  );
  process.exitCode = 1;
}

function parseArguments(argv: string[]): string | null {
  if (argv.length === 0) return null;
  if (argv.length !== 2 || argv[0] !== "--base" || !argv[1]) {
    throw new Error("Usage: check-migrations [--base <git-ref>]");
  }
  if (/\s|\.\.|[~^:\\]/.test(argv[1])) {
    throw new Error("Unsafe Git base reference");
  }
  return argv[1];
}

async function rejectOrphanedMigrationFiles(
  migrationsDirectory: string,
  migrations: Array<{ idx: number; tag: string }>,
): Promise<void> {
  const expectedSql = new Set(
    migrations.map((migration) => `${migration.tag}.sql`),
  );
  const expectedSnapshots = new Set(
    migrations.map(
      (migration) => `${String(migration.idx).padStart(4, "0")}_snapshot.json`,
    ),
  );
  const sqlFiles = (await readdir(migrationsDirectory)).filter((name) =>
    /^\d{4}_.+\.sql$/.test(name),
  );
  const snapshotFiles = (
    await readdir(path.join(migrationsDirectory, "meta"))
  ).filter((name) => /^\d{4}_snapshot\.json$/.test(name));
  await validateMigrationSql(migrationsDirectory, sqlFiles);
  for (const name of sqlFiles) {
    if (!expectedSql.has(name))
      throw new Error(`Orphaned migration SQL file: ${name}`);
  }
  for (const name of snapshotFiles) {
    if (!expectedSnapshots.has(name)) {
      throw new Error(`Orphaned migration snapshot file: meta/${name}`);
    }
  }
}

async function validateMigrationSql(
  migrationsDirectory: string,
  sqlFiles: string[],
): Promise<void> {
  for (const name of sqlFiles) {
    const contents = await readFile(path.join(migrationsDirectory, name), "utf8");
    for (const match of contents.matchAll(/CONSTRAINT\s+`([^`]+)`/giu)) {
      const identifier = match[1] ?? "";
      if (identifier.length > 64) {
        throw new Error(
          `MySQL constraint identifier exceeds 64 characters in ${name}: ${identifier}`,
        );
      }
    }
    for (const match of contents.matchAll(
      /timestamp\((\d+)\)[^,\n]*ON UPDATE CURRENT_TIMESTAMP(?:\((\d+)\))?/giu,
    )) {
      const columnPrecision = match[1];
      const updatePrecision = match[2];
      if (columnPrecision !== updatePrecision) {
        throw new Error(
          `Timestamp ON UPDATE precision is invalid in ${name}; expected CURRENT_TIMESTAMP(${columnPrecision})`,
        );
      }
    }
    for (const match of contents.matchAll(
      /timestamp\((\d+)\)[^,\n]*DEFAULT\s+(?:\(now\(\)\)|CURRENT_TIMESTAMP(?:\((\d+)\))?)/giu,
    )) {
      const columnPrecision = match[1];
      const defaultPrecision = match[2];
      if (columnPrecision !== defaultPrecision) {
        throw new Error(
          `Timestamp DEFAULT precision is invalid in ${name}; expected CURRENT_TIMESTAMP(${columnPrecision})`,
        );
      }
    }
  }
}

async function verifyAppendOnlyAgainstGit(
  base: string,
  migrationsDirectory: string,
): Promise<void> {
  const repositoryRoot = gitText(["rev-parse", "--show-toplevel"]).trim();
  const relativeMigrations = path.relative(repositoryRoot, migrationsDirectory);
  if (
    relativeMigrations.startsWith("..") ||
    path.isAbsolute(relativeMigrations)
  ) {
    throw new Error("Migration directory is outside the Git repository");
  }
  gitText(["rev-parse", "--verify", `${base}^{commit}`]);

  const currentJournal = JSON.parse(
    await readFile(
      path.join(migrationsDirectory, "meta", "_journal.json"),
      "utf8",
    ),
  ) as Journal;
  const baseJournalPath = `${relativeMigrations}/meta/_journal.json`;
  const baseJournal = JSON.parse(
    gitText(["show", `${base}:${baseJournalPath}`]),
  ) as Journal;
  if (
    !Array.isArray(baseJournal.entries) ||
    !Array.isArray(currentJournal.entries)
  ) {
    throw new Error("Git journal comparison requires entries arrays");
  }
  if (currentJournal.entries.length < baseJournal.entries.length) {
    throw new Error("Published migration journal entries cannot be removed");
  }

  for (const [index, baseEntry] of baseJournal.entries.entries()) {
    const currentEntry = currentJournal.entries[index];
    if (JSON.stringify(currentEntry) !== JSON.stringify(baseEntry)) {
      throw new Error(`Published journal entry ${index} was modified`);
    }
    const ordinal = String(index).padStart(4, "0");
    await requireSameBlob(
      base,
      repositoryRoot,
      `${relativeMigrations}/${baseEntry.tag}.sql`,
    );
    await requireSameBlob(
      base,
      repositoryRoot,
      `${relativeMigrations}/meta/${ordinal}_snapshot.json`,
    );
  }

  const policyPath = `${relativeMigrations}/release-policy.json`;
  if (gitExists(base, policyPath)) {
    const basePolicy = JSON.parse(
      gitText(["show", `${base}:${policyPath}`]),
    ) as Policy;
    const currentPolicy = JSON.parse(
      await readFile(
        path.join(migrationsDirectory, "release-policy.json"),
        "utf8",
      ),
    ) as Policy;
    if (
      !Array.isArray(basePolicy.migrations) ||
      !Array.isArray(currentPolicy.migrations)
    ) {
      throw new Error("Git policy comparison requires migrations arrays");
    }
    if (currentPolicy.migrations.length < basePolicy.migrations.length) {
      throw new Error("Published migration policy records cannot be removed");
    }
    for (const [index, baseEntry] of basePolicy.migrations.entries()) {
      if (
        JSON.stringify(currentPolicy.migrations[index]) !==
        JSON.stringify(baseEntry)
      ) {
        throw new Error(
          `Published migration policy record ${index} was modified`,
        );
      }
    }
  }
}

async function requireSameBlob(
  base: string,
  repositoryRoot: string,
  relativePath: string,
): Promise<void> {
  const baseBlob = gitBuffer(["show", `${base}:${relativePath}`]);
  const currentBlob = await readFile(path.join(repositoryRoot, relativePath));
  if (!baseBlob.equals(currentBlob)) {
    throw new Error(
      `Published migration artifact was modified: ${relativePath}`,
    );
  }
}

function gitExists(base: string, relativePath: string): boolean {
  const result = spawnSync(
    "git",
    ["cat-file", "-e", `${base}:${relativePath}`],
    {
      encoding: "utf8",
    },
  );
  return result.status === 0;
}

function gitText(argumentsList: string[]): string {
  return gitBuffer(argumentsList).toString("utf8");
}

function gitBuffer(argumentsList: string[]): Buffer {
  const result = spawnSync("git", argumentsList, { encoding: "buffer" });
  if (result.status !== 0) {
    const stderr = Buffer.isBuffer(result.stderr)
      ? result.stderr.toString("utf8").trim()
      : "";
    throw new Error(
      `git ${argumentsList[0] ?? "command"} failed${stderr ? `: ${stderr}` : ""}`,
    );
  }
  if (!Buffer.isBuffer(result.stdout))
    throw new Error("Git did not return byte output");
  return result.stdout;
}
