import { describe, expect, it } from "vitest";

import {
  formalBuildArtifactStagingSchema,
  NATIVE_SOURCE_MAX_REPAIR_ATTEMPTS,
} from "./build-artifact-checkpoint";

const UUIDS = [
  "10000000-0000-4000-8000-000000000001",
  "10000000-0000-4000-8000-000000000002",
  "10000000-0000-4000-8000-000000000003",
  "10000000-0000-4000-8000-000000000004",
  "10000000-0000-4000-8000-000000000005",
  "10000000-0000-4000-8000-000000000006",
  "10000000-0000-4000-8000-000000000007",
  "10000000-0000-4000-8000-000000000008",
] as const;

function staging(attempt: number) {
  const binding = (
    id: string,
    mimeType: "application/json" | "application/zip",
  ) => ({
    id,
    sha256: "a".repeat(64),
    bytes: 128,
    mimeType,
  });
  return {
    schemaVersion: 1,
    generation: "formal",
    projectId: UUIDS[0],
    buildId: UUIDS[1],
    knowledgeSnapshotId: UUIDS[2],
    taskId: "provider-task",
    operationToken: `siteops-native-source:${UUIDS[3]}:${attempt}`,
    nativeRepairAttempt: attempt,
    artifactBindings: {
      contract: binding(UUIDS[3], "application/json"),
      source: binding(UUIDS[4], "application/zip"),
      dist: binding(UUIDS[5], "application/zip"),
      qa: binding(UUIDS[6], "application/zip"),
      provenance: binding(UUIDS[7], "application/json"),
    },
    specHash: "b".repeat(64),
    distHash: "c".repeat(64),
    buildDelivery: {
      renderMode: "twenty_first_native",
      qaStatus: "passed",
      warningCodes: [],
    },
    qaSummary: { available: true },
    expiresAt: "2026-08-31T00:00:00.000Z",
  };
}

describe("formal build artifact checkpoint", () => {
  it("persists the third bounded native repair but rejects a fourth", () => {
    expect(NATIVE_SOURCE_MAX_REPAIR_ATTEMPTS).toBe(3);
    expect(formalBuildArtifactStagingSchema.safeParse(staging(3)).success).toBe(
      true,
    );
    expect(formalBuildArtifactStagingSchema.safeParse(staging(4)).success).toBe(
      false,
    );
  });
});
