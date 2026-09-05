import { describe, expect, it } from "vitest";

import { isApprovedUnreleasedMigrationCorrection } from "./unreleased-migration-correction-policy.mjs";

const approved = {
  baseRef: "754c21e498fee1fe25edc44fd131347ecb29ada3",
  tag: "0050_nullable_manual_order_commercial_evidence",
  baseSqlSha256:
    "54a5851a12024ae18f7cdcaf7994395a518fb18a9456ee7355f9bda60c88392b",
  currentSqlSha256:
    "f8630a281cfebae6d1ae1933cf0fe937df200aff62358ee953eb5d603e0da6eb",
};

describe("unreleased migration correction policy", () => {
  it("accepts only the exact failed-release SQL correction", () => {
    expect(isApprovedUnreleasedMigrationCorrection(approved)).toBe(true);
  });

  it("fails closed when any identity or hash differs", () => {
    for (const [field, value] of [
      ["baseRef", "754c21e498fee1fe25edc44fd131347ecb29ada4"],
      ["tag", "0051_delivery_ticket_retention"],
      ["baseSqlSha256", "0".repeat(64)],
      ["currentSqlSha256", "f".repeat(64)],
    ] as const) {
      expect(
        isApprovedUnreleasedMigrationCorrection({
          ...approved,
          [field]: value,
        }),
      ).toBe(false);
    }
  });
});
