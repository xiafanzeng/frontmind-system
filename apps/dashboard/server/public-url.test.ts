import { describe, expect, it } from "vitest";

import {
  assertFrontMindPublicUrlConfigured,
  configuredFrontMindPublicUrl,
  isFrontMindPublicUrlConfigured,
} from "./public-url";

describe("FrontMind public URL readiness", () => {
  it("accepts a canonical production HTTPS URL", () => {
    const env = {
      NODE_ENV: "production",
      FRONTMIND_PUBLIC_URL: "https://agent.frontmind.test/",
    };
    expect(configuredFrontMindPublicUrl(env)).toBe(
      "https://agent.frontmind.test",
    );
    expect(isFrontMindPublicUrlConfigured(env)).toBe(true);
    expect(assertFrontMindPublicUrlConfigured(env)).toBe(
      "https://agent.frontmind.test",
    );
  });

  it("rejects missing, placeholder, credential-bearing and insecure URLs", () => {
    expect(configuredFrontMindPublicUrl({ NODE_ENV: "production" })).toBeNull();
    expect(
      configuredFrontMindPublicUrl({
        NODE_ENV: "production",
        FRONTMIND_PUBLIC_URL: "https://agent.example.com",
      }),
    ).toBeNull();
    expect(
      configuredFrontMindPublicUrl({
        NODE_ENV: "production",
        FRONTMIND_PUBLIC_URL: "https://user:pass@agent.frontmind.test",
      }),
    ).toBeNull();
    expect(
      configuredFrontMindPublicUrl({
        NODE_ENV: "production",
        FRONTMIND_PUBLIC_URL: "http://agent.frontmind.test",
      }),
    ).toBeNull();
    expect(() =>
      assertFrontMindPublicUrlConfigured({
        NODE_ENV: "production",
        FRONTMIND_PUBLIC_URL: "",
      }),
    ).toThrow("FRONTMIND_PUBLIC_URL");
  });

  it("allows loopback HTTP only outside production", () => {
    expect(
      configuredFrontMindPublicUrl({
        NODE_ENV: "development",
        FRONTMIND_PUBLIC_URL: "http://127.0.0.1:3001/",
      }),
    ).toBe("http://127.0.0.1:3001");
    expect(
      configuredFrontMindPublicUrl({
        NODE_ENV: "production",
        FRONTMIND_PUBLIC_URL: "http://127.0.0.1:3001/",
      }),
    ).toBeNull();
  });
});
