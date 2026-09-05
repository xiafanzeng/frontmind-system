import { describe, expect, it } from "vitest";

import {
  SITEOPS_DEFAULT_WORKFLOW,
  SITEOPS_MATERIALIZER_V2_8,
  SITEOPS_MATERIALIZER_V2_9,
  SITEOPS_WORKFLOWS_BY_VERSION,
  parseSiteOpsPersistedWorkflowCoordinates,
  siteOpsPersistedWorkflowCoordinateSchema,
} from "./siteops";

describe("SiteOps persisted workflow coordinates", () => {
  it("keeps every registered workflow within the shared 1-32 character boundary", () => {
    expect(Object.keys(SITEOPS_WORKFLOWS_BY_VERSION)).toHaveLength(15);
    for (const workflow of Object.values(SITEOPS_WORKFLOWS_BY_VERSION)) {
      expect(
        parseSiteOpsPersistedWorkflowCoordinates({
          upstreamVersion: workflow.upstreamVersion,
          frontMindVersion: workflow.frontMindVersion,
          starterVersion: workflow.starterVersion,
          componentLibraryVersion: workflow.componentLibraryVersion,
        }),
      ).toEqual({
        upstreamVersion: workflow.upstreamVersion,
        frontMindVersion: workflow.frontMindVersion,
        starterVersion: workflow.starterVersion,
        componentLibraryVersion: workflow.componentLibraryVersion,
      });
    }
  });

  it("rejects empty and overlong persisted coordinates", () => {
    expect(siteOpsPersistedWorkflowCoordinateSchema.safeParse("").success).toBe(
      false,
    );
    expect(
      siteOpsPersistedWorkflowCoordinateSchema.safeParse("x".repeat(32))
        .success,
    ).toBe(true);
    expect(
      siteOpsPersistedWorkflowCoordinateSchema.safeParse("x".repeat(33))
        .success,
    ).toBe(false);
  });

  it("uses the exact short 2.8 catalog coordinate without changing its hashes", () => {
    expect(SITEOPS_MATERIALIZER_V2_8).toEqual({
      upstreamVersion: "frontmind-static-catalog-v1",
      upstreamSha256:
        "772d8938e73213f505dbd7b078a61f2bed9351262d3a429d31a8621b3cc0ce4f",
      frontMindVersion: "2.8.0",
      runtimeManifestSha256:
        "c846027250d6519860a9458696e3e185a2bb14b7863be58b88afb367293983f9",
      starterVersion: "frontmind-static-catalog-v1",
      starterSha256:
        "d7a87a67ecb83fc89320c59c97070c18c23af49fa5dde7bbe14f177e2f4e898e",
      componentLibraryVersion: "frontmind-static-catalog-v1",
      materializerVersion: "2.8.0",
      materializerSha256:
        "806e2e87226f454ad6344f2e14d687f997d9716783536a336757113641ec26ce",
      qaPolicyVersion: "siteops-native-qa-v1",
    });
  });

  it("defaults new roots to 2.9 while retaining the exact historical 2.8 entry", () => {
    expect(SITEOPS_DEFAULT_WORKFLOW).toBe(SITEOPS_MATERIALIZER_V2_9);
    expect(SITEOPS_WORKFLOWS_BY_VERSION["2.8.0"]).toBe(
      SITEOPS_MATERIALIZER_V2_8,
    );
    expect(SITEOPS_WORKFLOWS_BY_VERSION["2.9.0"]).toBe(
      SITEOPS_MATERIALIZER_V2_9,
    );
  });
});
