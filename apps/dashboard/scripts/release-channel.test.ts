import { describe, expect, it } from "vitest";

import { releaseCommandPlan, releasePresentation } from "./release-channel.mjs";

describe("Dashboard production release-channel profile", () => {
  it("owns the production website and indexing policy outside product code", () => {
    expect(releasePresentation).toEqual({
      releaseChannel: "production",
      websiteUrl: "https://www.frontmind.cn",
      documentTitle: "FrontMind Client",
      preventIndexing: false,
    });
  });

  it("routes shared package commands to the existing production release tools", () => {
    expect(releaseCommandPlan("build").steps).toEqual([
      { tool: "node", args: ["scripts/build-production-release.mjs"] },
    ]);
    expect(releaseCommandPlan("runtime-preflight").steps).toEqual([
      { tool: "node", args: ["scripts/validate-production-runtime.mjs"] },
    ]);
  });

  it("preserves production migration commands and rejects Dev bootstrap", () => {
    expect(releaseCommandPlan("database-migrate").steps).toEqual([
      { tool: "pnpm", args: ["exec", "drizzle-kit", "migrate"] },
    ]);
    expect(releaseCommandPlan("database-push").steps).toHaveLength(2);
    expect(() => releaseCommandPlan("database-bootstrap-test")).toThrow(
      "RELEASE_CHANNEL_COMMAND_UNSUPPORTED:database-bootstrap-test",
    );
  });
});
