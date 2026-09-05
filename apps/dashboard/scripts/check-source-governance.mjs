import { readFile, readdir } from "node:fs/promises";
import path from "node:path";

const repositoryRoot = path.resolve(import.meta.dirname, "..");
const configurationPath = path.join(
  repositoryRoot,
  "config",
  "source-governance.json",
);

async function sourceFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const absolutePath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await sourceFiles(absolutePath)));
      continue;
    }
    if (entry.isFile() && /\.(?:[cm]?[jt]sx?)$/u.test(entry.name)) {
      files.push(absolutePath);
    }
  }
  return files;
}

const configuration = JSON.parse(await readFile(configurationPath, "utf8"));
if (
  configuration?.schemaVersion !== 1 ||
  !Array.isArray(configuration.productionTsNocheckAllowlist) ||
  !configuration.moduleLineBudgets ||
  typeof configuration.moduleLineBudgets !== "object" ||
  Array.isArray(configuration.moduleLineBudgets)
) {
  throw new Error("SOURCE_GOVERNANCE_CONFIG_INVALID");
}

const oversizedModules = [];
for (const [relativePath, rawBudget] of Object.entries(
  configuration.moduleLineBudgets,
)) {
  const budget = Number(rawBudget);
  if (
    !relativePath ||
    path.isAbsolute(relativePath) ||
    relativePath.split("/").includes("..") ||
    !Number.isSafeInteger(budget) ||
    budget < 1
  ) {
    throw new Error(`SOURCE_GOVERNANCE_MODULE_BUDGET_INVALID:${relativePath}`);
  }
  const contents = await readFile(
    path.join(repositoryRoot, relativePath),
    "utf8",
  );
  const lines = contents === "" ? 0 : contents.split(/\r?\n/u).length - 1;
  if (lines > budget) {
    oversizedModules.push(`${relativePath}:${lines}>${budget}`);
  }
}
if (oversizedModules.length > 0) {
  throw new Error(
    `LEGACY_MODULE_GROWTH_FORBIDDEN:${oversizedModules.join(",")}`,
  );
}

const allowlist = [...configuration.productionTsNocheckAllowlist].sort();
if (new Set(allowlist).size !== allowlist.length) {
  throw new Error("SOURCE_GOVERNANCE_TSNOCHECK_ALLOWLIST_DUPLICATED");
}

const discovered = [];
for (const sourceRoot of ["client/src", "server"]) {
  for (const absolutePath of await sourceFiles(
    path.join(repositoryRoot, sourceRoot),
  )) {
    const contents = await readFile(absolutePath, "utf8");
    if (!/^\s*(?:\/\/|\/)\*?\s*@ts-nocheck\b/mu.test(contents)) continue;
    const relativePath = path
      .relative(repositoryRoot, absolutePath)
      .split(path.sep)
      .join("/");
    // Development-only preview fixtures are not shipped as a supported
    // production module and therefore do not consume the production debt
    // budget. Every other occurrence must be explicitly listed.
    if (relativePath === "client/src/lib/development-preview-fixtures.ts") {
      continue;
    }
    discovered.push(relativePath);
  }
}

discovered.sort();
const unexpected = discovered.filter((value) => !allowlist.includes(value));
const resolved = allowlist.filter((value) => !discovered.includes(value));
if (unexpected.length > 0) {
  throw new Error(`NEW_PRODUCTION_TSNOCHECK_FORBIDDEN:${unexpected.join(",")}`);
}
if (resolved.length > 0) {
  throw new Error(
    `REMOVE_RESOLVED_TSNOCHECK_ALLOWLIST_ENTRIES:${resolved.join(",")}`,
  );
}

console.log(
  `SOURCE_GOVERNANCE_OK productionTsNocheckDebt=${discovered.length} moduleBudgets=${Object.keys(configuration.moduleLineBudgets).length}`,
);
