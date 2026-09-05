import { execFileSync } from "node:child_process";
import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  assertCleanProductionBuildSource,
  assertCleanProductionReleaseWorktree,
} from "./assert-clean-build-source.mjs";
import {
  readBuildArtifactManifest,
  verifyBuildArtifactManifest,
  writeBuildArtifactIdentity,
  writeBuildArtifactManifest,
} from "./build-artifact-identity.mjs";
import { recreateEmptyProductionBuildRoot } from "./production-build-root.mjs";

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
    path.join(tmpdir(), "frontmind-dashboard-release-"),
  );
  temporaryRepositories.push(repositoryRoot);
  git(repositoryRoot, ["init", "-q"]);
  git(repositoryRoot, ["config", "user.email", "release@example.invalid"]);
  git(repositoryRoot, ["config", "user.name", "Release Test"]);
  await writeFile(path.join(repositoryRoot, ".gitignore"), "/dist/\n");
  await writeFile(path.join(repositoryRoot, "source.ts"), "export {};\n");
  git(repositoryRoot, ["add", "-A"]);
  git(repositoryRoot, ["commit", "-qm", "fixture source"]);
  return repositoryRoot;
}

async function populateReleaseArtifact(repositoryRoot: string) {
  const distRoot = path.join(repositoryRoot, "dist");
  await mkdir(path.join(distRoot, "public", "assets"), { recursive: true });
  await mkdir(path.join(distRoot, "drizzle", "meta"), { recursive: true });
  await mkdir(path.join(distRoot, "private-workflows", "fixture.skill"), {
    recursive: true,
  });
  await writeFile(path.join(distRoot, "index.js"), "server\n");
  await writeFile(path.join(distRoot, "pdf-prepare-worker.js"), "worker\n");
  await writeFile(path.join(distRoot, "release-db.js"), "release db\n");
  await writeFile(
    path.join(distRoot, "migration-manifest.json"),
    '{"schemaVersion":1}\n',
  );
  await writeFile(
    path.join(distRoot, "drizzle", "meta", "_journal.json"),
    '{"version":"7","dialect":"mysql","entries":[]}\n',
  );
  await writeFile(
    path.join(distRoot, "drizzle", "migration-policy.json"),
    '{"schemaVersion":1}\n',
  );
  await writeFile(
    path.join(distRoot, "verify-presales-file-roundtrip.js"),
    "verifier\n",
  );
  await writeFile(path.join(distRoot, "public", "index.html"), "<html />\n");
  await writeFile(
    path.join(distRoot, "public", "assets", "entry.js"),
    "client\n",
  );
  await writeFile(
    path.join(distRoot, "public", "assets", "entry.css"),
    "body {}\n",
  );
  await writeFile(
    path.join(distRoot, "private-workflows", "fixture.skill", "SKILL.md"),
    "# Skill\n",
  );
  return distRoot;
}

afterEach(async () => {
  await Promise.all(
    temporaryRepositories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("Dashboard single-commit production release identity", () => {
  it("accepts ignored disposable dist and rejects tracked dist", async () => {
    const repositoryRoot = await createRepository();
    const sourceSha = git(repositoryRoot, ["rev-parse", "HEAD"]);
    await mkdir(path.join(repositoryRoot, "dist"));
    await writeFile(path.join(repositoryRoot, "dist", "ignored.js"), "x\n");
    expect(
      assertCleanProductionReleaseWorktree({ repositoryRoot, env: {} }),
    ).toBe(sourceSha);

    git(repositoryRoot, ["add", "-f", "dist/ignored.js"]);
    git(repositoryRoot, ["commit", "-qm", "track forbidden artifact"]);
    expect(() =>
      assertCleanProductionReleaseWorktree({ repositoryRoot, env: {} }),
    ).toThrow(/BUILD_RELEASE_DIST_MUST_NOT_BE_TRACKED:dist\/ignored\.js/u);
  });

  it("binds every build identity to the one source commit", async () => {
    const repositoryRoot = await createRepository();
    const sourceSha = git(repositoryRoot, ["rev-parse", "HEAD"]);
    expect(
      assertCleanProductionBuildSource({
        repositoryRoot,
        env: {
          FRONTMIND_BUILD_SHA: sourceSha,
          BUILD_SHA: sourceSha.toUpperCase(),
          GITHUB_SHA: sourceSha,
          COMMIT_SHA: sourceSha,
        },
      }),
    ).toBe(sourceSha);
    expect(() =>
      assertCleanProductionBuildSource({
        repositoryRoot,
        env: { GITHUB_SHA: "f".repeat(40) },
      }),
    ).toThrow("BUILD_SOURCE_COMMIT_MISMATCH");

    await writeFile(
      path.join(repositoryRoot, "source.ts"),
      "export const x=1;\n",
    );
    expect(() =>
      assertCleanProductionBuildSource({ repositoryRoot, env: {} }),
    ).toThrow(/BUILD_SOURCE_NOT_COMMITTED:source\.ts/u);
  });

  it("recreates only the repository dist directory", async () => {
    const repositoryRoot = await createRepository();
    const distRoot = path.join(repositoryRoot, "dist");
    await mkdir(distRoot);
    await writeFile(path.join(distRoot, "stale.js"), "stale\n");
    await recreateEmptyProductionBuildRoot({
      repositoryRoot,
      buildRoot: distRoot,
    });
    await expect(access(path.join(distRoot, "stale.js"))).rejects.toThrow();
    await expect(
      recreateEmptyProductionBuildRoot({
        repositoryRoot,
        buildRoot: path.join(repositoryRoot, "not-dist"),
      }),
    ).rejects.toThrow("BUILD_RELEASE_DIST_TARGET_UNSAFE");
    await rm(distRoot, { recursive: true, force: true });
    await symlink(path.join(repositoryRoot, "source.ts"), distRoot);
    await expect(
      recreateEmptyProductionBuildRoot({ repositoryRoot, buildRoot: distRoot }),
    ).rejects.toThrow("BUILD_RELEASE_DIST_TARGET_IS_SYMLINK");
  });

  it("keeps build-time manifest auditing and detects changed bytes", async () => {
    const repositoryRoot = await createRepository();
    const sourceSha = git(repositoryRoot, ["rev-parse", "HEAD"]);
    const distRoot = await populateReleaseArtifact(repositoryRoot);
    await writeBuildArtifactIdentity(distRoot, sourceSha);
    const manifest = await writeBuildArtifactManifest(distRoot, sourceSha);
    expect(manifest.buildSourceSha).toBe(sourceSha);
    await expect(
      verifyBuildArtifactManifest(distRoot, {
        expectedBuildSourceSha: sourceSha,
      }),
    ).resolves.toMatchObject({ rootSha256: manifest.rootSha256 });

    await writeFile(path.join(distRoot, "index.js"), "tampered\n");
    await expect(verifyBuildArtifactManifest(distRoot)).rejects.toThrow(
      "BUILD_ARTIFACT_BYTES_MISMATCH",
    );
  });

  it("requires the incident repair CLI artifact exactly when its product source exists", async () => {
    const repositoryRoot = await createRepository();
    const sourceSha = git(repositoryRoot, ["rev-parse", "HEAD"]);
    const distRoot = await populateReleaseArtifact(repositoryRoot);
    await writeFile(
      path.join(distRoot, "knowledge-base-incident-repair-cli.js"),
      "orphaned incident repair CLI\n",
    );
    await writeBuildArtifactIdentity(distRoot, sourceSha);
    await expect(
      writeBuildArtifactManifest(distRoot, sourceSha),
    ).rejects.toThrow("BUILD_ARTIFACT_REQUIRED_COVERAGE_MISSING");

    await rm(path.join(distRoot, "knowledge-base-incident-repair-cli.js"));
    await mkdir(path.join(repositoryRoot, "server"));
    await writeFile(
      path.join(
        repositoryRoot,
        "server",
        "knowledge-base-incident-repair-cli.ts",
      ),
      "export {};\n",
    );
    await expect(
      writeBuildArtifactManifest(distRoot, sourceSha),
    ).rejects.toThrow("BUILD_ARTIFACT_REQUIRED_COVERAGE_MISSING");

    await writeFile(
      path.join(distRoot, "knowledge-base-incident-repair-cli.js"),
      "",
    );
    await expect(
      writeBuildArtifactManifest(distRoot, sourceSha),
    ).rejects.toThrow("BUILD_ARTIFACT_REQUIRED_COVERAGE_MISSING");

    await writeFile(
      path.join(distRoot, "knowledge-base-incident-repair-cli.js"),
      "signed incident repair CLI\n",
    );
    await expect(
      writeBuildArtifactManifest(distRoot, sourceSha),
    ).resolves.toMatchObject({ buildSourceSha: sourceSha });
  });

  it("rejects a replaced manifest without requiring an external runtime root", async () => {
    const repositoryRoot = await createRepository();
    const sourceSha = git(repositoryRoot, ["rev-parse", "HEAD"]);
    const distRoot = await populateReleaseArtifact(repositoryRoot);
    await writeBuildArtifactIdentity(distRoot, sourceSha);
    await writeBuildArtifactManifest(distRoot, sourceSha);
    const manifest = await readBuildArtifactManifest(distRoot);
    await writeFile(
      path.join(distRoot, "artifact-manifest.json"),
      JSON.stringify({ ...manifest, rootSha256: "0".repeat(64) }),
    );
    await expect(readBuildArtifactManifest(distRoot)).rejects.toThrow(
      "BUILD_ARTIFACT_MANIFEST_ROOT_MISMATCH",
    );
    expect(
      JSON.parse(
        await readFile(path.join(distRoot, "build-source.json"), "utf8"),
      ),
    ).toMatchObject({ buildSourceSha: sourceSha });
  });
});
