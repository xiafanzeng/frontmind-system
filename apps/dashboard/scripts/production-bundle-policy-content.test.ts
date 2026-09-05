import { describe, expect, it } from "vitest";

import {
  validatedProductionBundleBuildSourceSha,
  withoutValidatedProductionBundleBuildSourceSha,
} from "./production-bundle-policy-content.mjs";

describe("production bundle source identity scanning", () => {
  const sourceSha = "7b3004940f8a4e1fc82acf075ff57264e190ce18";

  it("removes only the validated source identity before policy matching", () => {
    expect(
      withoutValidatedProductionBundleBuildSourceSha(
        `build=${sourceSha}; endpoint=http://127.0.0.1:3004/healthz`,
        sourceSha,
      ),
    ).toBe("build=; endpoint=http://127.0.0.1:3004/healthz");
  });

  it("prevents digits inside a valid SHA from triggering a port rule", () => {
    expect(
      withoutValidatedProductionBundleBuildSourceSha(
        `build=${sourceSha}`,
        sourceSha,
      ),
    ).not.toContain("3004");
    expect(
      validatedProductionBundleBuildSourceSha(sourceSha.toUpperCase()),
    ).toBe(sourceSha);
  });

  it("rejects an unvalidated source identity", () => {
    expect(() =>
      withoutValidatedProductionBundleBuildSourceSha("build=3004", "3004"),
    ).toThrow("BUNDLE_POLICY_BUILD_SOURCE_SHA_INVALID");
  });
});
