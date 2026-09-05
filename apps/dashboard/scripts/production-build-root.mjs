import { lstat, mkdir, readdir, rm } from "node:fs/promises";
import path from "node:path";

function expectedDistRoot(repositoryRoot) {
  return path.join(path.resolve(repositoryRoot), "dist");
}

/**
 * Remove only the exact dist directory beneath the verified repository root.
 * The formal production builder calls this only after the complete clean
 * worktree gate succeeds. It is deliberately not exposed as a package script.
 */
export async function recreateEmptyProductionBuildRoot(options) {
  const repositoryRoot = path.resolve(options.repositoryRoot);
  const buildRoot = path.resolve(
    options.buildRoot || expectedDistRoot(repositoryRoot),
  );
  const expected = expectedDistRoot(repositoryRoot);
  if (
    buildRoot !== expected ||
    path.dirname(buildRoot) !== repositoryRoot ||
    path.basename(buildRoot) !== "dist"
  ) {
    throw new Error("BUILD_RELEASE_DIST_TARGET_UNSAFE");
  }

  try {
    const current = await lstat(buildRoot);
    if (current.isSymbolicLink()) {
      throw new Error("BUILD_RELEASE_DIST_TARGET_IS_SYMLINK");
    }
    if (!current.isDirectory()) {
      throw new Error("BUILD_RELEASE_DIST_TARGET_NOT_DIRECTORY");
    }
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }

  await rm(buildRoot, { recursive: true, force: true });
  await mkdir(buildRoot, { recursive: false, mode: 0o755 });
  if ((await readdir(buildRoot)).length !== 0) {
    throw new Error("BUILD_RELEASE_DIST_NOT_EMPTY");
  }
  return buildRoot;
}
