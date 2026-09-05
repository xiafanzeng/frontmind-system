export type ReleaseChannel = "development" | "production";

export type ReleasePresentationProfile = Readonly<{
  releaseChannel: ReleaseChannel;
  websiteUrl: string;
  documentTitle: string;
  preventIndexing: boolean;
}>;

export type ReleaseCommandPlan = Readonly<{
  environment?: Readonly<Record<string, string>>;
  steps: ReadonlyArray<
    Readonly<{
      tool: "node" | "pnpm";
      args: ReadonlyArray<string>;
    }>
  >;
}>;

export const releasePresentation: ReleasePresentationProfile;

export function releaseCommandPlan(command: string): ReleaseCommandPlan;

export function validateReleaseChannelRuntimeEnvironment(
  env?: NodeJS.ProcessEnv,
): {
  buildSourceSha: string;
  imageDigest: string;
  releaseChannel: ReleaseChannel;
};

export function runReleaseChannelCommand(command: string): void;
