import { validateProductionRuntimeEnvironment } from "../../scripts/production-runtime-validator.mjs";

declare const __FRONTMIND_RELEASE_CHANNEL__: string | undefined;

type RuntimeIdentity = {
  buildSourceSha: string;
  releaseChannel: string;
};

type HeaderWriter = {
  setHeader(name: string, value: string): unknown;
};

const compiledReleaseChannel =
  typeof __FRONTMIND_RELEASE_CHANNEL__ === "string"
    ? __FRONTMIND_RELEASE_CHANNEL__.trim().toLowerCase()
    : "";

export const applicationReleaseChannel = compiledReleaseChannel;

// Keep the runtime adapter free of the executable release-channel module.
// The production CLI is bundled into one file; importing a module with a
// direct-entry command guard would otherwise execute that guard at startup.
const releasePresentation = Object.freeze({
  releaseChannel: "production",
  preventIndexing: false,
});

export function assertReleaseChannelIdentity(
  runtimeIdentity: RuntimeIdentity,
  applicationBuildSha: string | null,
  releaseChannel = compiledReleaseChannel,
) {
  if (runtimeIdentity.buildSourceSha !== applicationBuildSha) {
    throw new Error("FRONTMIND_RUNTIME_BUILD_SOURCE_SHA_MISMATCH");
  }
  if (
    !releaseChannel ||
    runtimeIdentity.releaseChannel !== releaseChannel ||
    releaseChannel !== releasePresentation.releaseChannel
  ) {
    throw new Error("FRONTMIND_RUNTIME_RELEASE_CHANNEL_MISMATCH");
  }
}

export function validateReleaseRuntimeEnvironment(
  env: NodeJS.ProcessEnv,
  applicationBuildSha: string | null,
) {
  const configuredReleaseChannel = String(env.FRONTMIND_RELEASE_CHANNEL || "")
    .trim()
    .toLowerCase();
  if (
    configuredReleaseChannel &&
    configuredReleaseChannel !== releasePresentation.releaseChannel
  ) {
    throw new Error("FRONTMIND_RUNTIME_RELEASE_CHANNEL_MISMATCH");
  }
  const productionIdentity = validateProductionRuntimeEnvironment(env);
  const { buildSourceSha, imageDigest } = productionIdentity;
  if (!buildSourceSha || !imageDigest) {
    throw new Error("FRONTMIND_RUNTIME_IDENTITY_MISSING");
  }
  const runtimeIdentity = {
    buildSourceSha,
    imageDigest,
    releaseChannel: releasePresentation.releaseChannel,
  };
  assertReleaseChannelIdentity(runtimeIdentity, applicationBuildSha);
  return runtimeIdentity;
}

export function applyReleaseChannelHeaders(response: HeaderWriter) {
  if (releasePresentation.preventIndexing) {
    response.setHeader("X-Robots-Tag", "noindex, nofollow, noarchive");
  }
}
