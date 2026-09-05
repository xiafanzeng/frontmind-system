import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { assertCleanProductionBuildSource } from "./assert-clean-build-source.mjs";

const temporaryRepositories: string[] = [];

function git(repositoryRoot: string, args: string[]) {
  return execFileSync("git", args, {
    cwd: repositoryRoot,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

async function createRepository() {
  const repositoryRoot = await mkdtemp(
    path.join(tmpdir(), "frontmind-build-source-"),
  );
  temporaryRepositories.push(repositoryRoot);
  git(repositoryRoot, ["init", "-q"]);
  git(repositoryRoot, ["config", "user.email", "release@example.invalid"]);
  git(repositoryRoot, ["config", "user.name", "Release Test"]);
  await mkdir(path.join(repositoryRoot, "dist"));
  await writeFile(path.join(repositoryRoot, "source.ts"), "export {}\n");
  await writeFile(path.join(repositoryRoot, "dist", "index.js"), "old\n");
  git(repositoryRoot, ["add", "-A"]);
  git(repositoryRoot, ["commit", "-qm", "fixture"]);
  return repositoryRoot;
}

afterEach(async () => {
  await Promise.all(
    temporaryRepositories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("production build source identity", () => {
  it("accepts an explicit immutable SHA only for a Git-free CI build context", async () => {
    const repositoryRoot = await mkdtemp(
      path.join(tmpdir(), "frontmind-build-archive-"),
    );
    temporaryRepositories.push(repositoryRoot);
    const sha = "a".repeat(40);

    expect(() =>
      assertCleanProductionBuildSource({
        repositoryRoot,
        env: { FRONTMIND_BUILD_SHA: sha },
      }),
    ).toThrow("BUILD_SOURCE_GIT_METADATA_REQUIRED");
    expect(
      assertCleanProductionBuildSource({
        repositoryRoot,
        env: {
          FRONTMIND_ARCHIVE_BUILD: "1",
          FRONTMIND_BUILD_SHA: sha,
          BUILD_SHA: sha,
        },
      }),
    ).toBe(sha);
    expect(() =>
      assertCleanProductionBuildSource({
        repositoryRoot,
        env: {
          FRONTMIND_ARCHIVE_BUILD: "1",
          FRONTMIND_BUILD_SHA: sha,
          BUILD_SHA: "b".repeat(40),
        },
      }),
    ).toThrow("BUILD_SOURCE_COMMIT_MISMATCH");
  });

  it("allows only dist drift around an immutable source commit", async () => {
    const repositoryRoot = await createRepository();
    const sha = git(repositoryRoot, ["rev-parse", "HEAD"]);

    expect(assertCleanProductionBuildSource({ repositoryRoot, env: {} })).toBe(
      sha,
    );
    await writeFile(path.join(repositoryRoot, "dist", "index.js"), "new\n");
    await writeFile(path.join(repositoryRoot, "dist", "chunk.js"), "new\n");
    expect(assertCleanProductionBuildSource({ repositoryRoot, env: {} })).toBe(
      sha,
    );
  });

  it("rejects modified, staged and untracked source paths", async () => {
    const repositoryRoot = await createRepository();
    await writeFile(
      path.join(repositoryRoot, "source.ts"),
      "export const x=1\n",
    );
    expect(() =>
      assertCleanProductionBuildSource({ repositoryRoot, env: {} }),
    ).toThrow(/BUILD_SOURCE_NOT_COMMITTED:source\.ts/u);

    git(repositoryRoot, ["add", "source.ts"]);
    expect(() =>
      assertCleanProductionBuildSource({ repositoryRoot, env: {} }),
    ).toThrow(/BUILD_SOURCE_NOT_COMMITTED:source\.ts/u);

    git(repositoryRoot, ["commit", "-qm", "source"]);
    await writeFile(path.join(repositoryRoot, "untracked.ts"), "export {}\n");
    expect(() =>
      assertCleanProductionBuildSource({ repositoryRoot, env: {} }),
    ).toThrow(/BUILD_SOURCE_NOT_COMMITTED:untracked\.ts/u);
  });

  it("rejects a build environment SHA that does not equal HEAD", async () => {
    const repositoryRoot = await createRepository();
    expect(() =>
      assertCleanProductionBuildSource({
        repositoryRoot,
        env: { FRONTMIND_BUILD_SHA: "f".repeat(40) },
      }),
    ).toThrow("BUILD_SOURCE_COMMIT_MISMATCH");
  });
});
