export function validatedBundlePolicyBuildSourceSha(value) {
  const sourceSha = String(value || "")
    .trim()
    .toLowerCase();
  if (!/^[a-f0-9]{40}$/u.test(sourceSha)) {
    throw new Error("BUNDLE_POLICY_BUILD_SOURCE_SHA_INVALID");
  }
  return sourceSha;
}

export function withoutValidatedBuildSourceSha(content, value) {
  const sourceSha = validatedBundlePolicyBuildSourceSha(value);
  return String(content)
    .replaceAll(sourceSha, "")
    .replaceAll(sourceSha.toUpperCase(), "");
}
