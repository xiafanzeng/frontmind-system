import { execFileSync, spawnSync } from "node:child_process";
import {
  copyFile,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readlink,
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
const gitRepository = path.join(testRoot, "git-source");
const archiveRepository = path.join(testRoot, "archive-source");

function git(args) {
  return execFileSync("git", args, {
    cwd: gitRepository,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

function run(command, args, env, repositoryRoot) {
  execFileSync(command, args, {
    cwd: repositoryRoot,
    env,
    stdio: "inherit",
  });
}

function expectFailure(command, args, env, pattern, repositoryRoot) {
  const result = spawnSync(command, args, {
    cwd: repositoryRoot,
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

async function copySource(sourceRoot, destinationRoot, includeUntracked) {
  await mkdir(destinationRoot, { recursive: true });
  const files = execFileSync(
    "git",
    [
      "ls-files",
      "-z",
      "--cached",
      ...(includeUntracked ? ["--others", "--exclude-standard"] : []),
    ],
    {
      cwd: sourceRoot,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    },
  )
    .split("\0")
    .filter(
      (relativePath) =>
        relativePath &&
        relativePath !== "node_modules" &&
        !relativePath.startsWith("node_modules/") &&
        relativePath !== "dist" &&
        !relativePath.startsWith("dist/"),
  );
  for (const relativePath of files) {
    const sourcePath = path.join(sourceRoot, relativePath);
    const destinationPath = path.join(destinationRoot, relativePath);
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
    path.join(destinationRoot, "node_modules"),
  );
}

try {
  await copySource(projectRoot, gitRepository, true);
  git(["init", "-q"]);
  await writeFile(
    path.join(gitRepository, ".git", "info", "exclude"),
    "/node_modules\n",
    { flag: "a" },
  );
  git(["config", "user.email", "release@example.invalid"]);
  git(["config", "user.name", "FrontMind Release Test"]);
  // Exercise the future exact-product projection without adding product bytes
  // to this production-owned prerequisite commit.
  await writeFile(
    path.join(gitRepository, "server", "knowledge-base-incident-repair-cli.ts"),
    "export const signedIncidentRepairFixture = true;\n",
  );
  git(["add", "-A"]);
  git(["commit", "-qm", "single immutable release source"]);
  const sourceSha = git(["rev-parse", "HEAD"]);
  await copySource(gitRepository, archiveRepository, false);
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
  const gitEnvironment = { ...environment };
  delete gitEnvironment.FRONTMIND_ARCHIVE_BUILD;

  run("pnpm", ["build"], environment, archiveRepository);
  run("pnpm", ["audit:production"], environment, archiveRepository);
  const incidentRepairCli = await lstat(
    path.join(
      archiveRepository,
      "dist",
      "knowledge-base-incident-repair-cli.js",
    ),
  );
  const artifactManifest = JSON.parse(
    await readFile(
      path.join(archiveRepository, "dist", "artifact-manifest.json"),
      "utf8",
    ),
  );
  if (
    !incidentRepairCli.isFile() ||
    incidentRepairCli.size === 0 ||
    !artifactManifest.files?.some(
      (file) => file.path === "knowledge-base-incident-repair-cli.js",
    )
  ) {
    throw new Error("RELEASE_INCIDENT_REPAIR_CLI_CHAIN_INCOMPLETE");
  }
  const incidentRepairCliPath = path.join(
    archiveRepository,
    "dist",
    "knowledge-base-incident-repair-cli.js",
  );
  const incidentRepairCliBytes = await readFile(incidentRepairCliPath);
  await rm(incidentRepairCliPath);
  expectFailure(
    "pnpm",
    ["audit:production"],
    environment,
    /BUILD_ARTIFACT_REQUIRED_COVERAGE_MISSING/u,
    archiveRepository,
  );
  await writeFile(incidentRepairCliPath, incidentRepairCliBytes);
  const statusAfterBuild = git([
    `--git-dir=${path.join(gitRepository, ".git")}`,
    `--work-tree=${archiveRepository}`,
    "status",
    "--porcelain=v1",
    "--untracked-files=all",
  ]);
  if (statusAfterBuild) {
    throw new Error(`RELEASE_BUILD_MUTATED_SOURCE:${statusAfterBuild}`);
  }

  await writeFile(
    path.join(archiveRepository, "dist", "index.js"),
    "tampered after image build\n",
  );
  expectFailure(
    "pnpm",
    ["audit:production"],
    environment,
    /BUILD_ARTIFACT_BYTES_MISMATCH/u,
    archiveRepository,
  );

  await writeFile(
    path.join(gitRepository, "server", "release-dirty-fixture.ts"),
    "export {};\n",
  );
  expectFailure(
    "pnpm",
    ["build"],
    gitEnvironment,
    /BUILD_SOURCE_NOT_COMMITTED:server\/release-dirty-fixture\.ts/u,
    gitRepository,
  );

  console.log(`SINGLE_COMMIT_PRODUCTION_RELEASE_FLOW_OK source=${sourceSha}`);
} finally {
  await rm(testRoot, { recursive: true, force: true });
}
