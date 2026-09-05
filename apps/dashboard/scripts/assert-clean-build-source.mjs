import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

function git(repositoryRoot, args) {
  return execFileSync("git", args, {
    cwd: repositoryRoot,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

function normalizedFullSha(value, errorCode) {
  const sha = String(value || "")
    .trim()
    .toLowerCase();
  if (!/^[a-f0-9]{40}$/u.test(sha)) throw new Error(errorCode);
  return sha;
}

function repositoryHasGitMetadata(repositoryRoot) {
  return existsSync(path.join(repositoryRoot, ".git"));
}

function archiveBuildSourceSha(options, repositoryRoot) {
  const env = options.env || {};
  if (env.FRONTMIND_ARCHIVE_BUILD !== "1") {
    throw new Error("BUILD_SOURCE_GIT_METADATA_REQUIRED");
  }
  const expectedBuildSha = normalizedFullSha(
    options.expectedBuildSha || env.FRONTMIND_BUILD_SHA,
    "BUILD_SOURCE_EXPECTED_SHA_INVALID",
  );
  const requestedShas = [
    env.FRONTMIND_BUILD_SHA,
    env.BUILD_SHA,
    env.COMMIT_SHA,
    env.RENDER_GIT_COMMIT,
    env.RAILWAY_GIT_COMMIT_SHA,
    env.GITHUB_SHA,
  ]
    .map((value) =>
      String(value || "")
        .trim()
        .toLowerCase(),
    )
    .filter(Boolean);
  if (requestedShas.length === 0) {
    throw new Error("BUILD_SOURCE_EXPECTED_SHA_INVALID");
  }
  for (const requestedSha of requestedShas) {
    if (!/^[a-f0-9]{40}$/u.test(requestedSha)) {
      throw new Error("BUILD_SOURCE_ENV_SHA_INVALID");
    }
    if (requestedSha !== expectedBuildSha) {
      throw new Error("BUILD_SOURCE_COMMIT_MISMATCH");
    }
  }
  if (!path.isAbsolute(repositoryRoot)) {
    throw new Error("BUILD_SOURCE_ROOT_INVALID");
  }
  return expectedBuildSha;
}

export function changedSourcePaths(repositoryRoot) {
  if (!repositoryHasGitMetadata(repositoryRoot)) return [];
  const sourcePathspec = ["--", ".", ":(exclude)dist", ":(exclude)dist/**"];
  const groups = [
    git(repositoryRoot, ["diff", "--name-only", ...sourcePathspec]),
    git(repositoryRoot, ["diff", "--cached", "--name-only", ...sourcePathspec]),
    git(repositoryRoot, [
      "ls-files",
      "--others",
      "--exclude-standard",
      ...sourcePathspec,
    ]),
  ];
  return Array.from(
    new Set(groups.flatMap((value) => value.split("\n")).filter(Boolean)),
  ).sort();
}

/**
 * A release is built directly from one immutable source commit. `dist/` is a
 * disposable, ignored build directory and must never be committed again.
 */
export function assertCleanProductionReleaseWorktree(options = {}) {
  const repositoryRoot = path.resolve(
    options.repositoryRoot || path.resolve(import.meta.dirname, ".."),
  );
  const sha = assertCleanProductionBuildSource({
    ...options,
    repositoryRoot,
  });
  if (!repositoryHasGitMetadata(repositoryRoot)) return sha;
  const trackedDistPaths = git(repositoryRoot, ["ls-files", "--", "dist"])
    .split("\n")
    .filter(Boolean);
  if (trackedDistPaths.length > 0) {
    throw new Error(
      `BUILD_RELEASE_DIST_MUST_NOT_BE_TRACKED:${trackedDistPaths
        .slice(0, 20)
        .join(",")}`,
    );
  }
  return sha;
}

/**
 * Production artifacts must describe the exact immutable source commit.
 * `dist/` is excluded because it is generated and ignored, while every source,
 * migration, test and Skill file must already be committed.
 */
export function assertCleanProductionBuildSource(options = {}) {
  const repositoryRoot = path.resolve(
    options.repositoryRoot || path.resolve(import.meta.dirname, ".."),
  );
  if (!repositoryHasGitMetadata(repositoryRoot)) {
    return archiveBuildSourceSha(options, repositoryRoot);
  }
  const repositorySha = normalizedFullSha(
    git(repositoryRoot, ["rev-parse", "HEAD"]),
    "BUILD_SOURCE_COMMIT_INVALID",
  );
  const expectedBuildSha = normalizedFullSha(
    options.expectedBuildSha || repositorySha,
    "BUILD_SOURCE_EXPECTED_SHA_INVALID",
  );
  if (repositorySha !== expectedBuildSha) {
    throw new Error("BUILD_SOURCE_COMMIT_MISMATCH");
  }
  const env = options.env || {};
  const requestedShas = [
    env.FRONTMIND_BUILD_SHA,
    env.BUILD_SHA,
    env.COMMIT_SHA,
    env.RENDER_GIT_COMMIT,
    env.RAILWAY_GIT_COMMIT_SHA,
    env.GITHUB_SHA,
  ]
    .map((value) =>
      String(value || "")
        .trim()
        .toLowerCase(),
    )
    .filter(Boolean);
  for (const requestedSha of requestedShas) {
    if (!/^[a-f0-9]{40}$/u.test(requestedSha)) {
      throw new Error("BUILD_SOURCE_ENV_SHA_INVALID");
    }
    if (requestedSha !== expectedBuildSha) {
      throw new Error("BUILD_SOURCE_COMMIT_MISMATCH");
    }
  }
  const dirtyPaths = changedSourcePaths(repositoryRoot);
  if (dirtyPaths.length > 0) {
    throw new Error(
      `BUILD_SOURCE_NOT_COMMITTED:${dirtyPaths.slice(0, 20).join(",")}`,
    );
  }
  return repositorySha;
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : "";
if (invokedPath === fileURLToPath(import.meta.url)) {
  try {
    const sha = assertCleanProductionBuildSource({ env: process.env });
    console.log(`BUILD_SOURCE_COMMITTED=${sha}`);
  } catch (error) {
    console.error(
      error instanceof Error ? error.message : "BUILD_SOURCE_CHECK_FAILED",
    );
    process.exitCode = 1;
  }
}
