import { describe, expect, it } from "vitest";

import {
  type ExistingManusBuildReconciliationSnapshot,
  parseExistingManusBuildReconciliationArgs,
  prepareExistingManusBuildReconciliation,
} from "./manus-build-reconciliation";

const buildId = "4019dbff-7907-4e06-a509-1e64d94a06bd";
const projectId = "20000000-0000-4000-8000-000000000002";
const operationId = "30000000-0000-4000-8000-000000000003";
const turnId = "40000000-0000-4000-8000-000000000004";
const taskId = "manus-task-existing";
const snapshotId = "50000000-0000-4000-8000-000000000005";
const quotaPeriodId = "60000000-0000-4000-8000-000000000006";
const failureCode = "FRONTMIND_BUILD_SERVICE_UNAVAILABLE";

function snapshot(): ExistingManusBuildReconciliationSnapshot {
  return {
    build: {
      id: buildId,
      projectId,
      userId: 7,
      knowledgeSnapshotId: snapshotId,
      parentBuildId: null,
      quotaPeriodId,
      quotaState: "released",
      ordinal: 3,
      contractLocalAssetId: null,
      contractHash: null,
      sourceLocalAssetId: null,
      sourceHash: null,
      distLocalAssetId: null,
      distHash: null,
      qaLocalAssetId: null,
      provenanceLocalAssetId: null,
      upstreamManusTaskId: taskId,
      status: "failed",
      errorCode: failureCode,
      createdAt: new Date("2026-08-27T05:50:00.000Z"),
    },
    operation: {
      id: operationId,
      projectId,
      userId: 7,
      conversationTurnId: turnId,
      buildId,
      kind: "site_build",
      status: "failed",
      provider: "manus",
      providerTaskId: taskId,
      result: {
        schemaVersion: 1,
        stage: "native_repair_pending",
        taskId,
        nativeRepairAttempt: 1,
      },
      errorCode: failureCode,
    },
    project: {
      id: projectId,
      userId: 7,
      currentKnowledgeSnapshotId: snapshotId,
      currentBuildId: buildId,
      currentTaskStartedAt: new Date("2026-08-27T05:00:00.000Z"),
      status: "failed",
      revision: 12,
    },
    turn: {
      id: turnId,
      userId: 7,
      expectedRevision: 10,
    },
    latestBuildId: buildId,
    latestBuildOrdinal: 3,
    latestBuildOperationId: operationId,
  };
}

function fallbackSnapshot(): ExistingManusBuildReconciliationSnapshot {
  const value = snapshot();
  const kinds = ["contract", "source", "dist", "qa", "provenance"] as const;
  const artifactBindings = Object.fromEntries(
    kinds.map((kind, index) => [
      kind,
      {
        id: `70000000-0000-4000-8000-00000000000${index + 1}`,
        sha256: String(index + 1).repeat(64),
        bytes: index + 10,
        mimeType:
          kind === "contract" || kind === "provenance"
            ? "application/json"
            : "application/zip",
      },
    ]),
  ) as Record<
    (typeof kinds)[number],
    { id: string; sha256: string; bytes: number; mimeType: string }
  >;
  value.operation.status = "attention_required";
  value.operation.errorCode = "FRONTMIND_BUILD_RECONCILIATION_REQUIRED";
  value.operation.result = {
    schemaVersion: 2,
    stage: "native_source_pending",
    taskId,
    nativeRepairAttempt: 0,
    attempts: { extraction: 0, design: 0, content: 0, materialization: 0 },
    buildPhase: "provider_sync_delayed",
    fallbackPreview: {
      status: "bound",
      trigger: "provider_read_delayed",
      createdAt: "2026-08-27T05:15:00.000Z",
      reconcileUntilAt: "2026-08-28T05:00:00.000Z",
      buildId,
      taskId,
      operationToken: `siteops-native-fallback:${operationId}`,
      selectedPreviewSha256: "a".repeat(64),
      selectedSourceTreeSha256: "b".repeat(64),
      artifactBindings,
      buildDelivery: {
        renderMode: "trusted_fallback",
        qaStatus: "partial",
        warningCodes: ["NATIVE_PROVIDER_SYNC_TRUSTED_FALLBACK"],
      },
    },
  };
  value.build.status = "attention_required";
  value.build.errorCode = "FRONTMIND_BUILD_RECONCILIATION_REQUIRED";
  value.build.contractLocalAssetId = artifactBindings.contract.id;
  value.build.contractHash = artifactBindings.contract.sha256;
  value.build.sourceLocalAssetId = artifactBindings.source.id;
  value.build.sourceHash = artifactBindings.source.sha256;
  value.build.distLocalAssetId = artifactBindings.dist.id;
  value.build.distHash = artifactBindings.dist.sha256;
  value.build.qaLocalAssetId = artifactBindings.qa.id;
  value.build.provenanceLocalAssetId = artifactBindings.provenance.id;
  value.project.status = "attention_required";
  return value;
}

describe("existing Manus build incident reconciliation", () => {
  it("prepares the exact failed task for GET-only restart", () => {
    const prepared = prepareExistingManusBuildReconciliation(snapshot());
    expect(prepared).toMatchObject({
      buildId,
      projectId,
      operationId,
      taskId,
      quotaPeriodId,
      previousProjectRevision: 12,
      previousOperationStatus: "failed",
      recoveryState: {
        schemaVersion: 2,
        stage: "native_repair_pending",
        taskId,
        nativeRepairAttempt: 1,
        existingTaskOnly: true,
        buildPhase: "source_repairing",
      },
    });
  });

  it("restores an attention fallback only when all five bound coordinates still match", () => {
    const prepared =
      prepareExistingManusBuildReconciliation(fallbackSnapshot());
    expect(prepared).toMatchObject({
      buildId,
      taskId,
      previousOperationStatus: "attention_required",
      previousBuildStatus: "attention_required",
      previousProjectStatus: "attention_required",
      recoveryErrorCode: "FRONTMIND_BUILD_RECONCILIATION_REQUIRED",
      recoveryState: {
        existingTaskOnly: true,
        buildPhase: "provider_sync_delayed",
        fallbackPreview: { status: "bound" },
      },
      boundFallback: {
        contract: { id: expect.any(String), sha256: expect.any(String) },
        dist: { id: expect.any(String), sha256: expect.any(String) },
      },
    });

    const mismatch = fallbackSnapshot();
    mismatch.build.distHash = "f".repeat(64);
    expect(() => prepareExistingManusBuildReconciliation(mismatch)).toThrow(
      "SITEOPS_RECONCILE_FALLBACK_ARTIFACT_MISMATCH",
    );
  });

  it("refuses a newer build, bound artifact, changed revision, or mismatched task", () => {
    const newer = snapshot();
    newer.latestBuildId = "70000000-0000-4000-8000-000000000007";
    expect(() => prepareExistingManusBuildReconciliation(newer)).toThrow(
      "SITEOPS_RECONCILE_NEWER_BUILD_OR_OPERATION_EXISTS",
    );

    const bound = snapshot();
    bound.build.sourceLocalAssetId = "80000000-0000-4000-8000-000000000008";
    expect(() => prepareExistingManusBuildReconciliation(bound)).toThrow(
      "SITEOPS_RECONCILE_BUILD_ALREADY_HAS_ARTIFACTS",
    );

    const changed = snapshot();
    changed.project.revision += 1;
    expect(() => prepareExistingManusBuildReconciliation(changed)).toThrow(
      "SITEOPS_RECONCILE_PROJECT_REVISION_CHANGED",
    );

    const mismatch = snapshot();
    mismatch.operation.providerTaskId = "manus-task-other";
    expect(() => prepareExistingManusBuildReconciliation(mismatch)).toThrow(
      "SITEOPS_RECONCILE_PROVIDER_TASK_MISMATCH",
    );
  });

  it("refuses a task that is not the persisted native repair and a quota that was not released", () => {
    const wrongStage = snapshot();
    wrongStage.operation.result = {
      schemaVersion: 1,
      stage: "design_pending",
      taskId,
    };
    expect(() => prepareExistingManusBuildReconciliation(wrongStage)).toThrow(
      "SITEOPS_RECONCILE_NATIVE_REPAIR_STATE_REQUIRED",
    );

    const quotaReserved = snapshot();
    quotaReserved.build.quotaState = "reserved";
    expect(() =>
      prepareExistingManusBuildReconciliation(quotaReserved),
    ).toThrow("SITEOPS_RECONCILE_RELEASED_QUOTA_REQUIRED");
  });

  it("requires the explicit existing-task-only CLI guard and a UUID build", () => {
    expect(
      parseExistingManusBuildReconciliationArgs([
        "--build",
        buildId,
        "--existing-task-only",
      ]),
    ).toEqual({ buildId, existingTaskOnly: true });
    expect(() =>
      parseExistingManusBuildReconciliationArgs(["--build", buildId]),
    ).toThrow("SITEOPS_RECONCILE_ARGUMENTS_INVALID");
    expect(() =>
      parseExistingManusBuildReconciliationArgs([
        "--build",
        "not-a-build",
        "--existing-task-only",
      ]),
    ).toThrow("SITEOPS_RECONCILE_ARGUMENTS_INVALID");
  });
});
