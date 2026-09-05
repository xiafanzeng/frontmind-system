import { readFile, readdir, writeFile } from "node:fs/promises";
import { extname, join, resolve } from "node:path";
import {
  validatedBundlePolicyBuildSourceSha,
  withoutValidatedBuildSourceSha,
} from "./bundle-policy-content.mjs";

const projectRoot = resolve(import.meta.dirname, "..");
const buildRoot = resolve(projectRoot, process.argv[2] || "dist");
const buildSourceSha = validatedBundlePolicyBuildSourceSha(
  process.env.FRONTMIND_BUILD_SHA,
);
const immutableMigrationMetadata = new Set([
  join(buildRoot, "migration-manifest.json"),
  join(buildRoot, "drizzle", "meta", "_journal.json"),
  join(buildRoot, "drizzle", "migration-policy.json"),
]);
const textExtensions = new Set([
  ".css",
  ".html",
  ".js",
  ".json",
  ".md",
  ".mjs",
  ".svg",
  ".txt",
  ".xml",
  ".yaml",
  ".yml",
]);
const retiredPortDigits = ["30", "04"].join("");
const incidentalRewrites = [
  {
    label: "PDF character-map index",
    needle: `e[${retiredPortDigits}]=64292`,
    replacement: "e[3_004]=64292",
  },
  {
    label: "PDF font metric",
    needle: [".03", "004"].join(""),
    replacement: ".03_004",
  },
  {
    label: "Unicode range boundary",
    needle: ["\\u30", "04-\\u3007"].join(""),
    replacement: "〄-\\u3007",
  },
];

async function collectTextFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await collectTextFiles(path)));
    } else if (entry.isFile() && textExtensions.has(extname(entry.name))) {
      files.push(path);
    }
  }
  return files;
}

const rewriteCounts = new Map(
  incidentalRewrites.map(({ label }) => [label, 0]),
);
const residualFiles = [];

for (const file of await collectTextFiles(buildRoot)) {
  if (immutableMigrationMetadata.has(file)) continue;
  let content = await readFile(file, "utf8");
  let changed = false;
  for (const rewrite of incidentalRewrites) {
    const occurrences = content.split(rewrite.needle).length - 1;
    if (occurrences === 0) continue;
    content = content.split(rewrite.needle).join(rewrite.replacement);
    rewriteCounts.set(
      rewrite.label,
      (rewriteCounts.get(rewrite.label) || 0) + occurrences,
    );
    changed = true;
  }
  if (
    withoutValidatedBuildSourceSha(content, buildSourceSha).includes(
      retiredPortDigits,
    )
  ) {
    residualFiles.push(file);
  }
  if (changed) {
    await writeFile(file, content);
  }
}

if (residualFiles.length > 0) {
  console.error(
    "Production bundle still contains the retired Dashboard port in:",
  );
  for (const file of residualFiles) {
    console.error(`- ${file}`);
  }
  process.exit(1);
}

const normalizedCount = [...rewriteCounts.values()].reduce(
  (total, count) => total + count,
  0,
);
console.log(
  `Normalized ${normalizedCount} third-party numeric collision(s) in the production bundle.`,
);
