import { describe, expect, it } from "vitest";

import {
  assertSiliconFlowMaintenanceIdentity,
  siliconFlowKnowledgeSnapshotCleanupStorageKeys,
  shouldDeleteSiliconFlowUpstreamResource,
  SILICONFLOW_MAINTENANCE_BRAND,
} from "./siliconflow-kb-maintenance";

describe("SiliconFlow one-time knowledge-base maintenance guard", () => {
  it("retains task evidence while allowing temporary files to be deleted", () => {
    expect(shouldDeleteSiliconFlowUpstreamResource("task")).toBe(false);
    expect(shouldDeleteSiliconFlowUpstreamResource("file")).toBe(true);
  });

  it("includes each deterministic snapshot ZIP key in local cleanup", () => {
    expect(
      siliconFlowKnowledgeSnapshotCleanupStorageKeys(42, [
        {
          id: "00000000-0000-4000-8000-000000000123",
          assets: [{ key: "knowledge-assets/42/logo.webp" }],
        },
      ]),
    ).toEqual([
      "knowledge-assets/42/logo.webp",
      "knowledge-archives/42/00000000-0000-4000-8000-000000000123.zip",
    ]);
  });

  it("accepts only one explicit user whose formal and build names match", () => {
    expect(() =>
      assertSiliconFlowMaintenanceIdentity({
        userId: 42,
        userMatches: 1,
        dashboardBrandNames: [SILICONFLOW_MAINTENANCE_BRAND],
        buildCompanyNames: [" 硅基流动 ", "硅基流动"],
      }),
    ).not.toThrow();
  });

  it.each([
    {
      userMatches: 0,
      dashboardBrandNames: ["硅基流动"],
      buildCompanyNames: ["硅基流动"],
    },
    {
      userMatches: 2,
      dashboardBrandNames: ["硅基流动"],
      buildCompanyNames: ["硅基流动"],
    },
    {
      userMatches: 1,
      dashboardBrandNames: [],
      buildCompanyNames: ["硅基流动"],
    },
    {
      userMatches: 1,
      dashboardBrandNames: ["另一企业"],
      buildCompanyNames: ["硅基流动"],
    },
    {
      userMatches: 1,
      dashboardBrandNames: ["硅基流动"],
      buildCompanyNames: [],
    },
    {
      userMatches: 1,
      dashboardBrandNames: ["硅基流动"],
      buildCompanyNames: ["另一企业"],
    },
  ])("aborts on zero, multiple or mismatched targets", (input) => {
    expect(() =>
      assertSiliconFlowMaintenanceIdentity({
        userId: 42,
        ...input,
      }),
    ).toThrow();
  });
});
