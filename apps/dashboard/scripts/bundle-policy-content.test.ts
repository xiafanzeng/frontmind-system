import { describe, expect, it } from "vitest";

import {
  validatedBundlePolicyBuildSourceSha,
  withoutValidatedBuildSourceSha,
} from "./bundle-policy-content.mjs";

describe("bundle policy source identity handling", () => {
  const sourceSha = "7b3004940f8a4e1fc82acf075ff57264e190ce18";

  it("removes only the validated build identity before policy scanning", () => {
    expect(
      withoutValidatedBuildSourceSha(
        `build=${sourceSha}; endpoint=http://127.0.0.1:3004/healthz`,
        sourceSha,
      ),
    ).toBe("build=; endpoint=http://127.0.0.1:3004/healthz");
  });

  it("accepts a source identity containing a numeric policy collision", () => {
    expect(
      withoutValidatedBuildSourceSha(`build=${sourceSha}`, sourceSha),
    ).not.toContain("3004");
    expect(validatedBundlePolicyBuildSourceSha(sourceSha.toUpperCase())).toBe(
      sourceSha,
    );
  });

  it("rejects an unvalidated identity", () => {
    expect(() => withoutValidatedBuildSourceSha("build=3004", "3004")).toThrow(
      "BUNDLE_POLICY_BUILD_SOURCE_SHA_INVALID",
    );
  });
});
