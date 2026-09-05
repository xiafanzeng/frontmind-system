import { copyFile, mkdir, readFile, readdir } from "node:fs/promises";
import path from "node:path";

const projectRoot = path.resolve(import.meta.dirname, "..");
const sourceRoot = path.join(projectRoot, "drizzle");
const outputRoot = path.join(projectRoot, "dist", "drizzle");
const outputMetaRoot = path.join(outputRoot, "meta");

await mkdir(outputMetaRoot, { recursive: true });
const migrationFiles = (await readdir(sourceRoot))
  .filter((name) => /^\d{4}_[A-Za-z0-9_-]+\.sql$/u.test(name))
  .sort();
if (migrationFiles.length === 0) {
  throw new Error("RUNTIME_MIGRATIONS_MISSING");
}
const journal = JSON.parse(
  await readFile(path.join(sourceRoot, "meta", "_journal.json"), "utf8"),
);
const latestEntry = journal.entries?.at(-1);
if (
  !latestEntry ||
  !Number.isSafeInteger(latestEntry.idx) ||
  latestEntry.idx !== migrationFiles.length - 1
) {
  throw new Error("RUNTIME_MIGRATION_JOURNAL_INVALID");
}
const schemaSnapshotName = `${String(latestEntry.idx).padStart(4, "0")}_snapshot.json`;
for (const name of migrationFiles) {
  await copyFile(path.join(sourceRoot, name), path.join(outputRoot, name));
}
await Promise.all([
  copyFile(
    path.join(sourceRoot, "meta", "_journal.json"),
    path.join(outputMetaRoot, "_journal.json"),
  ),
  copyFile(
    path.join(sourceRoot, "meta", schemaSnapshotName),
    path.join(outputMetaRoot, schemaSnapshotName),
  ),
  copyFile(
    path.join(sourceRoot, "migration-policy.json"),
    path.join(outputRoot, "migration-policy.json"),
  ),
]);

console.log(
  `Copied ${migrationFiles.length} migration SQL files, latest schema snapshot, journal and policy into dist/drizzle.`,
);
