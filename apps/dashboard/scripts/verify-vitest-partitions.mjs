import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);

function listFiles(configFile) {
  const output = execFileSync(
    "pnpm",
    ["exec", "vitest", "list", "--config", configFile, "--filesOnly", "--json"],
    {
      cwd: repositoryRoot,
      encoding: "utf8",
      maxBuffer: 16 * 1024 * 1024,
      stdio: ["ignore", "pipe", "inherit"],
    },
  );

  const entries = JSON.parse(output);
  if (!Array.isArray(entries)) {
    throw new Error(`${configFile} did not return a Vitest file list`);
  }

  const files = entries.map((entry) => {
    if (!entry || typeof entry.file !== "string") {
      throw new Error(`${configFile} returned an invalid Vitest file entry`);
    }
    const relative = path.relative(repositoryRoot, path.resolve(entry.file));
    if (
      relative === "" ||
      relative === ".." ||
      relative.startsWith(`..${path.sep}`) ||
      path.isAbsolute(relative)
    ) {
      throw new Error(`${configFile} collected a file outside the repository`);
    }
    return relative.split(path.sep).join("/");
  });

  if (new Set(files).size !== files.length) {
    throw new Error(`${configFile} collected a duplicate test file`);
  }
  return files.sort();
}

function difference(left, right) {
  const rightSet = new Set(right);
  return left.filter((value) => !rightSet.has(value));
}

function failWithFiles(message, files) {
  const details = files.length > 0 ? `\n- ${files.join("\n- ")}` : "";
  throw new Error(`${message}${details}`);
}

const canonicalFiles = listFiles("vitest.config.ts");
const nodeFiles = listFiles("vitest.node.config.ts");
const clientFiles = listFiles("vitest.client.config.ts");

if (canonicalFiles.length === 0) {
  throw new Error("The canonical Vitest suite is empty");
}

const overlap = nodeFiles.filter((file) => new Set(clientFiles).has(file));
if (overlap.length > 0) {
  failWithFiles("Vitest partitions overlap", overlap);
}

const partitionUnion = [...nodeFiles, ...clientFiles].sort();
const missing = difference(canonicalFiles, partitionUnion);
const unexpected = difference(partitionUnion, canonicalFiles);
if (missing.length > 0) {
  failWithFiles("Vitest partitions omit canonical test files", missing);
}
if (unexpected.length > 0) {
  failWithFiles(
    "Vitest partitions include non-canonical test files",
    unexpected,
  );
}

const misplacedClientFiles = clientFiles.filter(
  (file) => !file.startsWith("client/"),
);
if (misplacedClientFiles.length > 0) {
  failWithFiles(
    "The jsdom partition contains non-client tests",
    misplacedClientFiles,
  );
}

const misplacedNodeFiles = nodeFiles.filter((file) =>
  file.startsWith("client/"),
);
if (misplacedNodeFiles.length > 0) {
  failWithFiles("The node partition contains client tests", misplacedNodeFiles);
}

const manifestSha256 = createHash("sha256")
  .update(`${canonicalFiles.join("\n")}\n`)
  .digest("hex");

console.log(
  `VITEST_PARTITIONS_EXACT canonical=${canonicalFiles.length} node=${nodeFiles.length} client=${clientFiles.length} manifestSha256=${manifestSha256}`,
);
