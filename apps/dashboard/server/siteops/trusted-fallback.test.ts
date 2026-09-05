import { describe, expect, it } from "vitest";

import { siteOpsTrustedFallbackPreviewSchema } from "./trusted-fallback";

describe("trusted fallback preview marker", () => {
  it("accepts the strict initial baseline trigger", () => {
    const binding = (index: number, mimeType: string) => ({
      id: `00000000-0000-4000-8000-00000000000${index}`,
      sha256: String(index).repeat(64),
      bytes: index,
      mimeType,
    });
    expect(
      siteOpsTrustedFallbackPreviewSchema.parse({
        status: "staged",
        trigger: "initial_baseline",
        createdAt: "2026-08-28T00:00:00.000Z",
        reconcileUntilAt: "2026-08-29T00:00:00.000Z",
        buildId: "10000000-0000-4000-8000-000000000001",
        taskId: "task-1",
        operationToken:
          "siteops-native-fallback:20000000-0000-4000-8000-000000000002",
        selectedPreviewSha256: "a".repeat(64),
        selectedSourceTreeSha256: "b".repeat(64),
        artifactBindings: {
          contract: binding(1, "application/json"),
          source: binding(2, "application/zip"),
          dist: binding(3, "application/zip"),
          qa: binding(4, "application/zip"),
          provenance: binding(5, "application/json"),
        },
        buildDelivery: {
          renderMode: "trusted_fallback",
          qaStatus: "partial",
          warningCodes: ["NATIVE_INITIAL_BASELINE_TRUSTED_FALLBACK"],
        },
      }),
    ).toMatchObject({ trigger: "initial_baseline" });

    expect(
      siteOpsTrustedFallbackPreviewSchema.parse({
        status: "staged",
        trigger: "initial_baseline",
        createdAt: "2026-08-28T00:00:00.000Z",
        reconcileUntilAt: "2026-08-29T00:00:00.000Z",
        buildId: "10000000-0000-4000-8000-000000000001",
        taskId: null,
        operationToken:
          "siteops-native-fallback:20000000-0000-4000-8000-000000000002",
        selectedPreviewSha256: "a".repeat(64),
        selectedSourceTreeSha256: "b".repeat(64),
        artifactBindings: {
          contract: binding(1, "application/json"),
          source: binding(2, "application/zip"),
          dist: binding(3, "application/zip"),
          qa: binding(4, "application/zip"),
          provenance: binding(5, "application/json"),
        },
        buildDelivery: {
          renderMode: "trusted_fallback",
          qaStatus: "partial",
          warningCodes: ["NATIVE_INITIAL_BASELINE_TRUSTED_FALLBACK"],
        },
      }),
    ).toMatchObject({ taskId: null });
  });
});
