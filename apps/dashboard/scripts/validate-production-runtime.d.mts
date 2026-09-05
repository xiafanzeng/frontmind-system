export type RuntimePreflightEnvironment = Record<
  string,
  string | undefined
>;

export function validateProductionRuntimeEnvironment(
  env?: RuntimePreflightEnvironment,
): {
  buildSourceSha: string | null;
  imageDigest: string | null;
};
