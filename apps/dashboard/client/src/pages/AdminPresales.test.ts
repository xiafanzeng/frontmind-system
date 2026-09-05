import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { presalesUsageDisplayState } from "./AdminPresales";

describe("presalesUsageDisplayState", () => {
  it("requires an explicit attribution-complete proof from the API", () => {
    const source = readFileSync(
      resolve(process.cwd(), "client/src/pages/AdminPresales.tsx"),
      "utf8",
    );
    expect(source).toContain("usageQuery.data?.attributionComplete === true");
  });
  it("hides every aggregate and percentage when the scan is incomplete", () => {
    expect(
      presalesUsageDisplayState({
        complete: false,
        attributionComplete: false,
        keyTotalUsed: 98_765,
        websiteUsed: 12_345,
        limit: 230_000,
      }),
    ).toEqual({
      keyTotalLabel: "—",
      websiteUsedLabel: "—",
      percentageLabel: "—",
      progressPercentage: 0,
    });
  });

  it("shows exact values only after a complete scan", () => {
    const display = presalesUsageDisplayState({
      complete: true,
      attributionComplete: true,
      keyTotalUsed: 115_000,
      websiteUsed: 12_345,
      limit: 230_000,
    });
    expect(display.keyTotalLabel).not.toBe("—");
    expect(display.websiteUsedLabel).not.toBe("—");
    expect(display.percentageLabel).toBe("50%");
    expect(display.progressPercentage).toBe(50);
  });

  it("keeps the authoritative pool total visible when only task attribution is incomplete", () => {
    expect(
      presalesUsageDisplayState({
        complete: true,
        attributionComplete: false,
        keyTotalUsed: 216_314,
        websiteUsed: 144_360,
        limit: 230_000,
      }),
    ).toEqual({
      keyTotalLabel: "216,314",
      websiteUsedLabel: "—",
      percentageLabel: "94%",
      progressPercentage: 94,
    });
  });
});
