import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";

import {
  applyReleaseChannelHeaders,
  assertReleaseChannelIdentity,
  validateReleaseRuntimeEnvironment,
} from "./release-channel-adapter";

describe("Dashboard production runtime channel adapter", () => {
  const buildSourceSha = "a".repeat(40);

  it("accepts one matching compiled/runtime/source identity", () => {
    expect(() =>
      assertReleaseChannelIdentity(
        { buildSourceSha, releaseChannel: "production" },
        buildSourceSha,
        "production",
      ),
    ).not.toThrow();
  });

  it("rejects source or channel conflicts", () => {
    expect(() =>
      assertReleaseChannelIdentity(
        { buildSourceSha, releaseChannel: "production" },
        "b".repeat(40),
        "production",
      ),
    ).toThrow("FRONTMIND_RUNTIME_BUILD_SOURCE_SHA_MISMATCH");
    expect(() =>
      assertReleaseChannelIdentity(
        { buildSourceSha, releaseChannel: "production" },
        buildSourceSha,
        "development",
      ),
    ).toThrow("FRONTMIND_RUNTIME_RELEASE_CHANNEL_MISMATCH");
  });

  it("rejects a conflicting configured runtime channel", () => {
    expect(() =>
      validateReleaseRuntimeEnvironment(
        { FRONTMIND_RELEASE_CHANNEL: "development" },
        buildSourceSha,
      ),
    ).toThrow("FRONTMIND_RUNTIME_RELEASE_CHANNEL_MISMATCH");
  });

  it("does not add a production indexing prohibition", () => {
    const setHeader = vi.fn();
    applyReleaseChannelHeaders({ setHeader });
    expect(setHeader).not.toHaveBeenCalled();
  });

  it("does not import the executable release command module", () => {
    const source = readFileSync(
      "server/_core/release-channel-adapter.ts",
      "utf8",
    );
    expect(source).toContain("production-runtime-validator.mjs");
    expect(source).not.toContain("validate-production-runtime.mjs");
    expect(source).not.toContain('from "../../scripts/release-channel.mjs"');
  });
});
