import { execFileSync } from "node:child_process";
import { readdir } from "node:fs/promises";
import path from "node:path";
import { assertCleanProductionBuildSource } from "./assert-clean-build-source.mjs";

const projectRoot = path.resolve(import.meta.dirname, "..");
const buildRoot = path.join(projectRoot, "dist");
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

const releaseEnvironment = {
  ...process.env,
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
  "server/pdf-prepare-worker.ts",
  "scripts/release-db.ts",
  "scripts/verify-presales-file-roundtrip.ts",
  "--platform=node",
  "--packages=external",
  "--bundle",
  "--format=esm",
  "--entry-names=[name]",
  "--outdir=dist",
  '--define:process.env.NODE_ENV="production"',
  `--define:__FRONTMIND_BUILD_SHA__=${JSON.stringify(buildSourceSha)}`,
]);
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
