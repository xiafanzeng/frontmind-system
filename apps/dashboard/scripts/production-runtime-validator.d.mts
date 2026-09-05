export type RuntimePreflightEnvironment = Record<string, string | undefined>;

export function deriveDownloadTokenSecretFromCredentialMasterKey(
  masterKey: Buffer,
): string;

export function validateProductionRuntimeEnvironment(
  env?: RuntimePreflightEnvironment,
): {
  buildSourceSha: string;
  imageDigest: string;
};
