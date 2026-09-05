import { execFileSync } from "node:child_process";
import path from "node:path";
import {
  assertCleanProductionReleaseWorktree,
  changedSourcePaths,
} from "./assert-clean-build-source.mjs";
import {
  writeBuildArtifactIdentity,
  writeBuildArtifactManifest,
} from "./build-artifact-identity.mjs";
import { recreateEmptyProductionBuildRoot } from "./production-build-root.mjs";

const projectRoot = path.resolve(import.meta.dirname, "..");
const buildRoot = path.join(projectRoot, "dist");
const buildSourceSha = assertCleanProductionReleaseWorktree({
  repositoryRoot: projectRoot,
  env: process.env,
});

await recreateEmptyProductionBuildRoot({
  repositoryRoot: projectRoot,
  buildRoot,
});

const releaseEnvironment = {
  ...process.env,
  NODE_ENV: "production",
  FRONTMIND_BUILD_SHA: buildSourceSha,
  BUILD_SHA: buildSourceSha,
  FRONTMIND_INTERNAL_RELEASE_BUILD_STAGE: buildSourceSha,
};
execFileSync(process.execPath, ["scripts/build-unsealed-artifact.mjs"], {
  cwd: projectRoot,
  env: releaseEnvironment,
  stdio: "inherit",
});

const generatedSourcePaths = changedSourcePaths(projectRoot);
if (generatedSourcePaths.length > 0) {
  throw new Error(
    `BUILD_RELEASE_GENERATED_SOURCE_CHANGES:${generatedSourcePaths
      .slice(0, 20)
      .join(",")}`,
  );
}

await writeBuildArtifactIdentity(buildRoot, buildSourceSha);
const manifest = await writeBuildArtifactManifest(buildRoot, buildSourceSha);
execFileSync(process.execPath, ["scripts/audit-production-bundle.mjs"], {
  cwd: projectRoot,
  env: {
    ...releaseEnvironment,
    FRONTMIND_INTERNAL_RELEASE_AUDIT_STAGE: buildSourceSha,
  },
  stdio: "inherit",
});

console.log(
  `PRODUCTION_RELEASE_CANDIDATE_BUILT source=${buildSourceSha} files=${manifest.files.length} root=${manifest.rootSha256}`,
);
