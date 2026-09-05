import { execFileSync } from "node:child_process";
import { lstat, readdir } from "node:fs/promises";
import path from "node:path";
import { assertCleanProductionBuildSource } from "./assert-clean-build-source.mjs";
import { releasePresentation } from "./release-channel.mjs";

const projectRoot = path.resolve(import.meta.dirname, "..");
const buildRoot = path.join(projectRoot, "dist");
const knowledgeBaseIncidentRepairCliSource = path.join(
  projectRoot,
  "server/knowledge-base-incident-repair-cli.ts",
);
const buildSourceSha = assertCleanProductionBuildSource({
  repositoryRoot: projectRoot,
  env: process.env,
});

// This stage is not a production release entrance. The formal builder creates
// an empty, verified dist root and binds this one-shot marker to the source
// commit. Even if this file is invoked directly, it never creates the final
// artifact manifest, so CI cannot package it as a release image.
if (process.env.FRONTMIND_INTERNAL_RELEASE_BUILD_STAGE !== buildSourceSha) {
  throw new Error("BUILD_INTERNAL_STAGE_NOT_AUTHORIZED");
}
if ((await readdir(buildRoot)).length !== 0) {
  throw new Error("BUILD_INTERNAL_STAGE_REQUIRES_EMPTY_DIST");
}

async function requiresKnowledgeBaseIncidentRepairCli() {
  try {
    const source = await lstat(knowledgeBaseIncidentRepairCliSource);
    if (!source.isFile()) {
      throw new Error("BUILD_INCIDENT_REPAIR_CLI_SOURCE_INVALID");
    }
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}

// This is production-owned wiring for an exact-product entry. The ordinary
// prerequisite release remains buildable before the product projection lands;
// as soon as that projection contains the CLI source, omission of its runtime
// entry becomes a hard build failure.
const knowledgeBaseIncidentRepairCliRequired =
  await requiresKnowledgeBaseIncidentRepairCli();

const releaseEnvironment = {
  ...process.env,
  FRONTMIND_RELEASE_CHANNEL: releasePresentation.releaseChannel,
  VITE_FRONTMIND_RELEASE_CHANNEL: releasePresentation.releaseChannel,
  VITE_FRONTMIND_WEBSITE_URL: releasePresentation.websiteUrl,
  FRONTMIND_BUILD_SHA: buildSourceSha,
  BUILD_SHA: buildSourceSha,
};

function run(command, args) {
  execFileSync(command, args, {
    cwd: projectRoot,
    env: releaseEnvironment,
    stdio: "inherit",
  });
}

run("pnpm", ["exec", "vite", "build"]);
run("pnpm", [
  "exec",
  "esbuild",
  "server/_core/index.ts",
  ...(knowledgeBaseIncidentRepairCliRequired
    ? ["server/knowledge-base-incident-repair-cli.ts"]
    : []),
  "server/pdf-prepare-worker.ts",
  "server/siteops/seed-static-template-catalog.ts",
  "scripts/reconcile-siteops-build.ts",
  "scripts/release-db.ts",
  "scripts/verify-presales-file-roundtrip.ts",
  "--platform=node",
  "--packages=external",
  "--bundle",
  "--format=esm",
  "--entry-names=[name]",
  "--outdir=dist",
  '--define:process.env.NODE_ENV="production"',
  `--define:process.env.FRONTMIND_RELEASE_CHANNEL=${JSON.stringify(releasePresentation.releaseChannel)}`,
  `--define:__FRONTMIND_BUILD_SHA__=${JSON.stringify(buildSourceSha)}`,
  `--define:__FRONTMIND_RELEASE_CHANNEL__=${JSON.stringify(releasePresentation.releaseChannel)}`,
]);
if (knowledgeBaseIncidentRepairCliRequired) {
  const output = await lstat(
    path.join(buildRoot, "knowledge-base-incident-repair-cli.js"),
  );
  if (!output.isFile() || output.size === 0) {
    throw new Error("BUILD_INCIDENT_REPAIR_CLI_OUTPUT_MISSING");
  }
}
const siteOpsReconcileBuildCli = await lstat(
  path.join(buildRoot, "reconcile-siteops-build.js"),
);
if (!siteOpsReconcileBuildCli.isFile() || siteOpsReconcileBuildCli.size === 0) {
  throw new Error("BUILD_SITEOPS_RECONCILE_CLI_OUTPUT_MISSING");
}
run(process.execPath, ["scripts/copy-runtime-skills.mjs"]);
run(process.execPath, ["scripts/copy-runtime-migrations.mjs"]);
run(process.execPath, [
  "scripts/generate-migration-manifest.mjs",
  "--output",
  "dist/migration-manifest.json",
]);
run(process.execPath, ["scripts/normalize-production-bundle.mjs"]);

console.log(
  `UNSEALED_BUILD_COMPLETE source=${buildSourceSha}; production requires the audited release-image build`,
);
