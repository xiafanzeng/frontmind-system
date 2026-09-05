import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { createMigrationManifest } from "./migration-manifest.mjs";

function argumentValue(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

export async function generateMigrationManifest(options = {}) {
  const migrationsFolder = path.resolve(
    options.migrationsFolder ||
      argumentValue("--migrations-folder") ||
      path.resolve(process.cwd(), "drizzle"),
  );
  const outputPath = path.resolve(
    options.outputPath ||
      argumentValue("--output") ||
      path.resolve(process.cwd(), "dist", "migration-manifest.json"),
  );
  const manifest = await createMigrationManifest({ migrationsFolder });
  await mkdir(path.dirname(outputPath), { recursive: true });
  await writeFile(outputPath, `${JSON.stringify(manifest, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o644,
  });
  return { outputPath, manifest };
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : "";
if (invokedPath === fileURLToPath(import.meta.url)) {
  const { outputPath, manifest } = await generateMigrationManifest();
  console.log(
    `MIGRATION_MANIFEST_WRITTEN path=${outputPath} count=${manifest.count} latest=${manifest.latestTag} journal=${manifest.journalHash} schema=${manifest.schemaHash}`,
  );
}
