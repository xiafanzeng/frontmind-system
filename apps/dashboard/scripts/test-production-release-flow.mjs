import { execFileSync, spawnSync } from "node:child_process";
import {
  copyFile,
  lstat,
  mkdir,
  mkdtemp,
  readlink,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

const projectRoot = path.resolve(import.meta.dirname, "..");
const testRoot = await mkdtemp(
  path.join(tmpdir(), "frontmind-dashboard-single-release-"),
);
const releaseRepository = path.join(testRoot, "release");

execFileSync(
  process.execPath,
  ["--test", path.join(projectRoot, "scripts/promotion-prebuild-gate.node-test.mjs")],
  { cwd: projectRoot, stdio: "inherit" },
);
execFileSync(
  process.execPath,
  [
    "--test",
    path.join(projectRoot, "scripts/promotion-prebuild-gate-runtime.node-test.mjs"),
  ],
  { cwd: projectRoot, stdio: "inherit" },
);

function git(args) {
  return execFileSync("git", args, {
    cwd: releaseRepository,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

function run(command, args, env) {
  execFileSync(command, args, {
    cwd: releaseRepository,
    env,
    stdio: "inherit",
  });
}

function expectFailure(command, args, env, pattern) {
  const result = spawnSync(command, args, {
    cwd: releaseRepository,
    env,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  const output = `${result.stdout || ""}\n${result.stderr || ""}`;
  if (result.status === 0 || !pattern.test(output)) {
    throw new Error(
      `EXPECTED_RELEASE_FAILURE_MISSING status=${result.status} pattern=${pattern} output=${output.slice(0, 4000)}`,
    );
  }
}

async function copySource() {
  await mkdir(releaseRepository, { recursive: true });
  const files = execFileSync(
    "git",
    ["ls-files", "-z", "--cached", "--others", "--exclude-standard"],
    {
      cwd: projectRoot,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    },
  )
    .split("\0")
    .filter(
      (relativePath) =>
        relativePath &&
        relativePath !== "dist" &&
        !relativePath.startsWith("dist/"),
    );
  for (const relativePath of files) {
    const sourcePath = path.join(projectRoot, relativePath);
    const destinationPath = path.join(releaseRepository, relativePath);
    let sourceStat;
    try {
      sourceStat = await lstat(sourcePath);
    } catch (error) {
      if (error?.code === "ENOENT") continue;
      throw error;
    }
    await mkdir(path.dirname(destinationPath), { recursive: true });
    if (sourceStat.isSymbolicLink()) {
      await symlink(await readlink(sourcePath), destinationPath);
    } else if (sourceStat.isFile()) {
      await copyFile(sourcePath, destinationPath);
    } else {
      throw new Error(`RELEASE_SOURCE_ENTRY_UNSUPPORTED:${relativePath}`);
    }
  }
  await symlink(
    path.join(projectRoot, "node_modules"),
    path.join(releaseRepository, "node_modules"),
  );
}

try {
  await copySource();
  git(["init", "-q"]);
  await writeFile(
    path.join(releaseRepository, ".git", "info", "exclude"),
    "/node_modules\n",
    { flag: "a" },
  );
  git(["config", "user.email", "release@example.invalid"]);
  git(["config", "user.name", "FrontMind Release Test"]);
  git(["add", "-A"]);
  git(["commit", "-qm", "single immutable release source"]);
  const sourceSha = git(["rev-parse", "HEAD"]);
  const environment = {
    ...process.env,
    // The production Docker builder installs devDependencies under this outer
    // value. The release entry must still force Vite's production constants so
    // DEV-only routes and fixtures cannot enter the signed image.
    NODE_ENV: "development",
    FRONTMIND_ARCHIVE_BUILD: "1",
    FRONTMIND_BUILD_SHA: sourceSha,
    BUILD_SHA: sourceSha,
    GITHUB_SHA: sourceSha,
    COMMIT_SHA: sourceSha,
  };

  const repositoryGitMetadata = path.join(releaseRepository, ".git");
  const archivedGitMetadata = path.join(testRoot, "release-git-metadata");
  await rename(repositoryGitMetadata, archivedGitMetadata);
  try {
    run("pnpm", ["build"], environment);
    run("pnpm", ["audit:production"], environment);
  } finally {
    await rename(archivedGitMetadata, repositoryGitMetadata);
  }
  const statusAfterBuild = git([
    "status",
    "--porcelain=v1",
    "--untracked-files=all",
  ]);
  if (statusAfterBuild) {
    throw new Error(`RELEASE_BUILD_MUTATED_SOURCE:${statusAfterBuild}`);
  }

  await writeFile(
    path.join(releaseRepository, "dist", "index.js"),
    "tampered after image build\n",
  );
  expectFailure(
    "pnpm",
    ["audit:production"],
    environment,
    /BUILD_ARTIFACT_BYTES_MISMATCH/u,
  );

  await writeFile(
    path.join(releaseRepository, "server", "release-dirty-fixture.ts"),
    "export {};\n",
  );
  expectFailure(
    "pnpm",
    ["build"],
    environment,
    /BUILD_SOURCE_NOT_COMMITTED:server\/release-dirty-fixture\.ts/u,
  );

  console.log(`SINGLE_COMMIT_PRODUCTION_RELEASE_FLOW_OK source=${sourceSha}`);
} finally {
  await rm(testRoot, { recursive: true, force: true });
}
