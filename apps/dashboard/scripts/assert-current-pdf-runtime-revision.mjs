#!/usr/bin/env node

import { createHash } from "node:crypto";
import { pathToFileURL } from "node:url";

const COMMIT_SHA_RE = /^[a-f0-9]{40}$/;
const TREE_SHA_RE = /^[a-f0-9]{40}$/;
const REPOSITORY_RE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const WORKFLOW_PATH = ".github/workflows/pdf-runtime.yml";
const RUNTIME_ROOT = "deploy/1panel-node-pdf";
const RUNTIME_PREFIX = `${RUNTIME_ROOT}/`;
const CONTROL_PATHS = [
  WORKFLOW_PATH,
  "scripts/assert-current-pdf-runtime-revision.mjs",
  "scripts/mark-ghcr-promoted.mjs",
];

function isRuntimeEntry(entryPath) {
  return (
    CONTROL_PATHS.includes(entryPath) || entryPath.startsWith(RUNTIME_PREFIX)
  );
}

function normalizedRuntimeEntries(response, label) {
  if (!response || typeof response !== "object") {
    throw new Error(`PDF_RUNTIME_TREE_INVALID:${label}`);
  }
  if (response.truncated !== false) {
    throw new Error(`PDF_RUNTIME_TREE_TRUNCATED:${label}`);
  }
  if (!Array.isArray(response.tree)) {
    throw new Error(`PDF_RUNTIME_TREE_INVALID:${label}`);
  }

  const entries = response.tree
    .filter(
      (entry) =>
        entry && typeof entry.path === "string" && isRuntimeEntry(entry.path),
    )
    .map((entry) => {
      if (
        typeof entry.path !== "string" ||
        typeof entry.mode !== "string" ||
        typeof entry.type !== "string" ||
        typeof entry.sha !== "string" ||
        !TREE_SHA_RE.test(entry.sha)
      ) {
        throw new Error(`PDF_RUNTIME_TREE_ENTRY_INVALID:${label}`);
      }
      return {
        path: entry.path,
        mode: entry.mode,
        type: entry.type,
        sha: entry.sha,
      };
    })
    .sort((left, right) => {
      const leftKey = `${left.path}\0${left.mode}\0${left.type}\0${left.sha}`;
      const rightKey = `${right.path}\0${right.mode}\0${right.type}\0${right.sha}`;
      return leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : 0;
    });

  for (const controlPath of CONTROL_PATHS) {
    if (!entries.some((entry) => entry.path === controlPath)) {
      throw new Error(
        `PDF_RUNTIME_CONTROL_FILE_MISSING:${label}:${controlPath}`,
      );
    }
  }
  if (!entries.some((entry) => entry.path.startsWith(RUNTIME_PREFIX))) {
    throw new Error(`PDF_RUNTIME_FILES_MISSING:${label}`);
  }
  return entries;
}

function hashEntries(entries) {
  return createHash("sha256")
    .update(`${JSON.stringify(entries)}\n`)
    .digest("hex");
}

export function comparePdfRuntimeTrees({ sourceTree, mainTree, phase }) {
  const phaseCode = String(phase ?? "verify")
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, "_");
  const sourceEntries = normalizedRuntimeEntries(sourceTree, "source");
  const mainEntries = normalizedRuntimeEntries(mainTree, "main");
  const sourceRevision = hashEntries(sourceEntries);
  const mainRevision = hashEntries(mainEntries);
  if (sourceRevision !== mainRevision) {
    throw new Error(
      `PDF_RUNTIME_${phaseCode}_SUPERSEDED:${sourceRevision}:${mainRevision}`,
    );
  }
  return {
    revision: sourceRevision,
    entryCount: sourceEntries.length,
  };
}

async function githubJson(endpoint, token) {
  const response = await fetch(`https://api.github.com${endpoint}`, {
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${token}`,
      "User-Agent": "frontmind-pdf-runtime-revision-gate",
      "X-GitHub-Api-Version": "2022-11-28",
    },
  });
  if (!response.ok) {
    throw new Error(`GITHUB_API_FAILED:${response.status}:${endpoint}`);
  }
  return response.json();
}

export async function verifyCurrentPdfRuntimeRevision({
  repository,
  sourceSha,
  token,
  phase,
  request = githubJson,
}) {
  if (!REPOSITORY_RE.test(repository ?? "")) {
    throw new Error("GITHUB_REPOSITORY_INVALID");
  }
  if (!COMMIT_SHA_RE.test(sourceSha ?? "")) {
    throw new Error("GITHUB_SHA_INVALID");
  }
  if (!token) throw new Error("GH_TOKEN_REQUIRED");

  const ref = await request(`/repos/${repository}/git/ref/heads/main`, token);
  const mainSha = ref?.object?.sha;
  if (typeof mainSha !== "string" || !COMMIT_SHA_RE.test(mainSha)) {
    throw new Error("GITHUB_MAIN_SHA_INVALID");
  }

  const [sourceTree, mainTree] = await Promise.all([
    request(`/repos/${repository}/git/trees/${sourceSha}?recursive=1`, token),
    request(`/repos/${repository}/git/trees/${mainSha}?recursive=1`, token),
  ]);
  const comparison = comparePdfRuntimeTrees({ sourceTree, mainTree, phase });
  return { ...comparison, sourceSha, mainSha };
}

function argument(name, fallback) {
  const index = process.argv.indexOf(name);
  if (index === -1) return fallback;
  const value = process.argv[index + 1];
  if (!value || value.startsWith("--"))
    throw new Error(`${name} requires a value`);
  return value;
}

async function main() {
  const result = await verifyCurrentPdfRuntimeRevision({
    repository: argument("--repository", process.env.GITHUB_REPOSITORY),
    sourceSha: argument("--source-sha", process.env.GITHUB_SHA),
    token: process.env.GH_TOKEN,
    phase: argument("--phase", "verify"),
  });
  console.error(
    JSON.stringify({ status: "exact", kind: "pdf-runtime", ...result }),
  );
  process.stdout.write(`${result.revision}\n`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.stack : String(error));
    process.exitCode = 1;
  });
}
