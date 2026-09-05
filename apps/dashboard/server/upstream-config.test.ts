import { describe, expect, it } from "vitest";

import {
  assertUpstreamBaseUrlConfigured,
  configuredUpstreamBaseUrl,
  isUpstreamBaseUrlConfigured,
} from "./upstream-config";

describe("upstream base URL readiness", () => {
  it("accepts HTTPS origins and preserves a configured base path", () => {
    expect(
      configuredUpstreamBaseUrl({
        FRONTMIND_UPSTREAM_BASE_URL:
          "  https://upstream.frontmind.test/custom/api/  ",
      }),
    ).toBe("https://upstream.frontmind.test/custom/api");
    expect(
      isUpstreamBaseUrlConfigured({
        FRONTMIND_UPSTREAM_BASE_URL:
          "https://upstream.frontmind.test/custom/api",
      }),
    ).toBe(true);
  });

  it("uses the built-in HTTPS upstream when no override is configured", () => {
    expect(configuredUpstreamBaseUrl({})).toMatch(/^https:\/\//);
    expect(assertUpstreamBaseUrlConfigured({})).toBe(
      configuredUpstreamBaseUrl({}),
    );
  });

  it.each([
    ["plain HTTP", "http://upstream.frontmind.test/api"],
    ["loopback HTTP", "http://127.0.0.1:4010/api"],
    ["userinfo", "https://user:secret@upstream.frontmind.test/api"],
    ["query", "https://upstream.frontmind.test/api?target=other"],
    ["empty query", "https://upstream.frontmind.test/api?"],
    ["fragment", "https://upstream.frontmind.test/api#other"],
    ["empty fragment", "https://upstream.frontmind.test/api#"],
    ["non-HTTP scheme", "file:///tmp/upstream"],
    ["malformed URL", "not a URL"],
  ])("rejects a %s URL", (_label, value) => {
    const env = { FRONTMIND_UPSTREAM_BASE_URL: value };
    expect(configuredUpstreamBaseUrl(env)).toBeNull();
    expect(isUpstreamBaseUrlConfigured(env)).toBe(false);
    expect(() => assertUpstreamBaseUrlConfigured(env)).toThrow(
      "FRONTMIND_UPSTREAM_BASE_URL",
    );
  });

  it("fails closed without echoing credential-bearing configuration", () => {
    const configured =
      "https://sensitive-user:sensitive-password@upstream.frontmind.test/api";

    try {
      assertUpstreamBaseUrlConfigured({
        FRONTMIND_UPSTREAM_BASE_URL: configured,
      });
      throw new Error("expected invalid configuration to throw");
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      expect(message).not.toContain(configured);
      expect(message).not.toContain("sensitive-user");
      expect(message).not.toContain("sensitive-password");
    }
  });
});
