import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  assertSiteOpsDeploymentTargetAvailable,
  assertCurrentVisualWorkflowVersion,
  completePublishedVisualPageCount,
  compareSiteOpsVisualOperationsNewestFirst,
  createVisualSearchOperationInput,
  currentSiteOpsBuildWorkflowCoordinates,
  freezeSiteOpsCustomerAiCredential,
  freezeSiteOpsReferenceBlueprint,
  hashSiteOpsRequest,
  isNativeVisualSelectionMetadata,
  isSiteOpsOperationReplay,
  isSiteOpsIcpApprovedForCurrentDomain,
  normalizeSiteOpsDomain,
  parseSiteOpsActionPayload,
  projectSiteOpsVisualGeneration,
  projectSiteOpsObservationStatuses,
  projectStaticTemplateCatalogVisualReadiness,
  projectSiteOpsExecutionSteps,
  projectSiteOpsBuildDelivery,
  projectSiteOpsBuildProgress,
  projectSiteOpsCurrentResetCycle,
  referenceBlueprintForSiteOpsRevision,
  requireTwentyFirstReferenceAdmission,
  resolveVisualCatalogObservationCoordinates,
  resolvePinnedTwentyFirstCredentialForBatch,
  resolveSiteOpsAgentProfile,
  runSiteOpsObservationQueries,
  runSiteOpsObservationSingleFlight,
  siteBriefFromSnapshot,
  siteOpsServiceErrorFromQuota,
  siteOpsResetPendingBlocksAction,
  siteOpsVisualCycleWorkflowVersion,
  siteOpsWorkflowForVisualSelectionMetadata,
  staticTemplateSelectionMetadataSchema,
  siteOpsVisualSelectionRecovery,
  SiteOpsServiceError,
  visualSearchAllowedForProjectStatus,
  visualSearchReadiness,
} from "./service";
import { SiteOpsQuotaError } from "./quota-service";
import { createVisualEvidenceV1 } from "../../shared/siteops-workflow";
import {
  SITEOPS_DEFAULT_WORKFLOW,
  SITEOPS_MATERIALIZER_V2_4,
  SITEOPS_MATERIALIZER_V2_5,
  SITEOPS_MATERIALIZER_V2_6,
  SITEOPS_MATERIALIZER_V2_7,
  SITEOPS_MATERIALIZER_V2_8,
  SITEOPS_WORKFLOW,
  siteOpsActInputSchema,
  siteOpsAliyunConnectionInputSchema,
  siteOpsSendMessageInputSchema,
} from "../../shared/siteops";
import {
  SITEOPS_CONTENT_PATCH_PARTIAL_DEFAULTS_WARNING_CODE,
  siteOpsBuildProjectionSchema,
} from "../../shared/siteops-contract";
import {
  referenceBlueprintV3ForFamily,
  referenceBlueprintV4ForFamily,
} from "../../shared/siteops-design";
import {
  NATIVE_RUNTIME_CONTRACT_V1_SHA256,
  NATIVE_RUNTIME_EXECUTION_SHELL_V1_SHA256,
} from "./native-react-source";
import { staticTemplateAdmissionEvidenceSha256 } from "./static-template-catalog";

describe("SiteOps core contracts", () => {
  it("allows local work in a fresh reset epoch while external writes remain gated", () => {
    for (const action of [
      "select_snapshot",
      "start_visual_search",
      "reselect_visual",
      "select_visual",
      "delegate_visual",
      "request_revision",
      "create_wechat_package",
      "create_xiaohongshu_package",
    ] as const) {
      expect(siteOpsResetPendingBlocksAction(action)).toBe(false);
    }
    for (const action of [
      "request_rebuild",
      "publish_global",
      "publish_mainland",
      "rollback",
      "domain_sync",
    ] as const) {
      expect(siteOpsResetPendingBlocksAction(action)).toBe(true);
    }
  });

  it("admits the host-owned visual-reference path without Template download readiness", () => {
    expect(
      requireTwentyFirstReferenceAdmission({
        configured: true,
        version: 7,
        fingerprint: "fingerprint",
        capabilities: { search: true },
        nativeTemplateReadiness: "plan_ineligible",
      } as never),
    ).toEqual({ version: 7, fingerprint: "fingerprint" });
    expect(() =>
      requireTwentyFirstReferenceAdmission({
        configured: true,
        version: 7,
        fingerprint: "fingerprint",
        capabilities: { search: false },
        nativeTemplateReadiness: "ready",
      } as never),
    ).toThrow(/视觉参考检索/u);
  });

  it("recognizes complete-template V6 metadata without legacy visual evidence", () => {
    const historicalV6 = {
      schemaVersion: 6,
      renderer: "twenty_first_native_template_v1",
      providerTemplateId: "template-42",
      providerSlug: "saas-landing",
      providerVersion: null,
      framework: "vite_react",
      sourceTreeSha256: "a".repeat(64),
      sourceArchiveSha256: "b".repeat(64),
      previewSha256: "c".repeat(64),
      sourceDirectory: "source",
      entrypoint: "src/App.tsx",
    } as const;
    expect(isNativeVisualSelectionMetadata(historicalV6)).toBe(true);
    expect(
      siteOpsWorkflowForVisualSelectionMetadata(historicalV6).frontMindVersion,
    ).toBe(SITEOPS_MATERIALIZER_V2_5.frontMindVersion);
    expect(
      siteOpsWorkflowForVisualSelectionMetadata({
        ...historicalV6,
        workflowVersion: SITEOPS_MATERIALIZER_V2_7.frontMindVersion,
      }).frontMindVersion,
    ).toBe(SITEOPS_MATERIALIZER_V2_7.frontMindVersion);
    expect(
      isNativeVisualSelectionMetadata({
        schemaVersion: 6,
        renderer: "twenty_first_native_template_v1",
        providerTemplateId: "template-42",
      }),
    ).toBe(false);
  });

  it("keeps historical V7 metadata readable while accepting its managed preview coordinate", () => {
    const metadata = {
      schemaVersion: 7,
      renderer: "frontmind_static_template_catalog_v1",
      workflowVersion: "2.8.0",
      catalogVersion: "21st-included-recommended-20260828-v1",
      catalogPosition: 1,
      catalogCandidateId: "template-1",
      providerTemplateId: "provider-template-1",
      providerSlug: "provider-template-1",
      providerVersion: null,
      sourceOwner: "frontmind",
      sourceRepo: "templates",
      sourceCommitSha: "a".repeat(40),
      sourceSubdirectory: null,
      sourceLicense: "MIT",
      sourceAssetId: "catalog/source/template-1",
      sourceArchiveSha256: "b".repeat(64),
      sourceArchiveBytes: 1024,
      previewAssetId: "catalog/preview/template-1",
      previewLocalAssetId: "10000000-0000-4000-8000-000000000001",
      previewSha256: "c".repeat(64),
      previewMimeType: "image/png",
      previewWidth: 1440,
      previewHeight: 900,
    } as const;

    expect(
      staticTemplateSelectionMetadataSchema.safeParse(metadata).success,
    ).toBe(true);
    expect(
      staticTemplateSelectionMetadataSchema.safeParse({
        ...metadata,
        previewLocalAssetId: undefined,
      }).success,
    ).toBe(true);
    expect(
      staticTemplateSelectionMetadataSchema.safeParse({
        ...metadata,
        previewLocalAssetId: "not-a-uuid",
      }).success,
    ).toBe(false);
    const admitted = {
      ...metadata,
      catalogVersion: "21st-included-recommended-20260828-v2",
      executionAdmission: {
        status: "admitted" as const,
        rawSourceSha256: "d".repeat(64),
        normalizedSourceSha256: metadata.sourceArchiveSha256,
        sourceTreeSha256: "e".repeat(64),
        runtimeContractSha256: NATIVE_RUNTIME_CONTRACT_V1_SHA256,
        executionShellSha256: NATIVE_RUNTIME_EXECUTION_SHELL_V1_SHA256,
        deliveryContractSha256: "f".repeat(64),
        distSha256: "1".repeat(64),
        qaSha256: "2".repeat(64),
        browserReceiptSha256: "3".repeat(64),
        qaStatus: "passed" as const,
        admissionEvidenceSha256: staticTemplateAdmissionEvidenceSha256({
          catalogVersion: "21st-included-recommended-20260828-v2",
          candidateId: metadata.catalogCandidateId,
          rawSourceSha256: "d".repeat(64),
          normalizedSourceSha256: metadata.sourceArchiveSha256,
          sourceTreeSha256: "e".repeat(64),
          runtimeContractSha256: NATIVE_RUNTIME_CONTRACT_V1_SHA256,
          executionShellSha256: NATIVE_RUNTIME_EXECUTION_SHELL_V1_SHA256,
          deliveryContractSha256: "f".repeat(64),
          distSha256: "1".repeat(64),
          qaSha256: "2".repeat(64),
          browserReceiptSha256: "3".repeat(64),
          qaStatus: "passed",
        }),
      },
    };
    expect(
      staticTemplateSelectionMetadataSchema.safeParse(admitted).success,
    ).toBe(true);
    expect(
      staticTemplateSelectionMetadataSchema.safeParse({
        ...admitted,
        executionAdmission: {
          ...admitted.executionAdmission,
          runtimeContractSha256: "4".repeat(64),
        },
      }).success,
    ).toBe(false);
    expect(
      staticTemplateSelectionMetadataSchema.safeParse({
        ...admitted,
        executionAdmission: {
          ...admitted.executionAdmission,
          executionShellSha256: "5".repeat(64),
        },
      }).success,
    ).toBe(false);
    expect(
      staticTemplateSelectionMetadataSchema.safeParse({
        ...admitted,
        executionAdmission: {
          ...admitted.executionAdmission,
          admissionEvidenceSha256: "6".repeat(64),
        },
      }).success,
    ).toBe(false);
  });

  it("projects only the fresh workflow cycle after a successful reset", () => {
    const boundary = new Date("2026-08-26T00:00:00.000Z");
    const before = new Date("2026-08-25T23:59:59.999Z");
    const after = new Date("2026-08-26T00:00:00.001Z");
    const resetMetadata = {
      siteOps: { payload: { reset: true, unpublishCompleted: true } },
    };
    const projected = projectSiteOpsCurrentResetCycle({
      successfulResetApplied: true,
      currentTaskStartedAt: boundary,
      messageRows: [
        { id: "old", sentAt: before, metadata: null },
        { id: "same-old", sentAt: boundary, metadata: null },
        { id: "reset-complete", sentAt: boundary, metadata: resetMetadata },
        { id: "new", sentAt: after, metadata: null },
      ],
      timelineMessageRows: [
        { id: "same-timeline", sentAt: boundary, metadata: null },
        { id: "new-timeline", sentAt: after, metadata: null },
      ],
      buildRows: [
        { id: "old-build", createdAt: before, status: "failed" },
        { id: "same-build", createdAt: boundary, status: "cancelled" },
        { id: "new-cancelled", createdAt: after, status: "cancelled" },
        { id: "new-build", createdAt: after, status: "queued" },
      ],
      deploymentRows: [],
      packageRows: [],
      batchRows: [
        { id: "old-board", createdAt: boundary, status: "superseded" },
        { id: "new-board", createdAt: after, status: "published" },
      ],
      timelineOperationRows: [
        { id: "old-operation", createdAt: boundary, status: "cancelled" },
        { id: "new-operation", createdAt: after, status: "running" },
      ],
    });

    expect(projected.messageRows.map((row) => row.id)).toEqual([
      "reset-complete",
      "new",
    ]);
    expect(projected.timelineMessageRows.map((row) => row.id)).toEqual([
      "new-timeline",
    ]);
    expect(projected.buildRows.map((row) => row.id)).toEqual(["new-build"]);
    expect(projected.batchRows.map((row) => row.id)).toEqual(["new-board"]);
    expect(projected.timelineOperationRows.map((row) => row.id)).toEqual([
      "new-operation",
    ]);
  });

  it("preserves the historical projection before a fresh-root reset", () => {
    const row = {
      id: "historical-build",
      createdAt: new Date("2026-08-25T00:00:00.000Z"),
      status: "cancelled",
    };
    expect(
      projectSiteOpsCurrentResetCycle({
        successfulResetApplied: false,
        currentTaskStartedAt: new Date("2026-08-26T00:00:00.000Z"),
        messageRows: [],
        timelineMessageRows: [],
        buildRows: [row],
        deploymentRows: [],
        packageRows: [],
        batchRows: [],
        timelineOperationRows: [],
      }).buildRows,
    ).toEqual([row]);
  });

  it("keeps native build delivery visible after a later deploy succeeds", () => {
    expect(
      projectSiteOpsBuildDelivery({
        buildId: "build-1",
        operations: [
          {
            buildId: "build-1",
            kind: "deploy",
            status: "succeeded",
            result: { stage: "deployed" },
          },
          {
            buildId: "build-1",
            kind: "site_build",
            status: "succeeded",
            result: {
              buildDelivery: {
                renderMode: "twenty_first_native",
                qaStatus: "passed_with_warnings",
                warningCodes: ["AXE_COLOR_CONTRAST"],
              },
            },
          },
        ],
      }),
    ).toEqual({
      renderMode: "twenty_first_native",
      qaStatus: "passed_with_warnings",
      warningCodes: ["AXE_COLOR_CONTRAST"],
    });
  });

  it("projects a validated content-patch delivery as a formal preview", () => {
    expect(
      projectSiteOpsBuildDelivery({
        buildId: "build-content-patch",
        operations: [
          {
            buildId: "build-content-patch",
            kind: "site_build",
            status: "succeeded",
            result: {
              buildDelivery: {
                renderMode: "content_patch",
                qaStatus: "passed",
                warningCodes: [],
              },
            },
          },
        ],
      }),
    ).toEqual({
      renderMode: "content_patch",
      qaStatus: "passed",
      warningCodes: [],
    });
  });

  it("projects partial content-patch defaults as fixed public preview copy", () => {
    expect(
      projectSiteOpsBuildProgress({
        buildId: "build-content-patch-defaults",
        operations: [
          {
            buildId: "build-content-patch-defaults",
            kind: "site_build",
            status: "succeeded",
            result: {
              buildDelivery: {
                renderMode: "content_patch",
                qaStatus: "passed_with_warnings",
                warningCodes: [
                  SITEOPS_CONTENT_PATCH_PARTIAL_DEFAULTS_WARNING_CODE,
                  "INTERNAL_PROVIDER_SLOT_DETAIL_MUST_NOT_LEAK",
                ],
              },
            },
          },
        ],
      }),
    ).toEqual({
      buildPhase: null,
      recoverable: false,
      previewWarning: "官网预览已生成，部分内容使用企业资料中的可信默认值。",
    });
  });

  it("exposes a bound trusted fallback while its original task keeps running", () => {
    const fallbackBuildId = "30000000-0000-4000-8000-000000000003";
    const artifactBindings = Object.fromEntries(
      (["contract", "source", "dist", "qa", "provenance"] as const).map(
        (kind, index) => [
          kind,
          {
            id: `60000000-0000-4000-8000-00000000000${index + 1}`,
            sha256: String(index + 1).repeat(64),
            bytes: index + 1,
            mimeType:
              kind === "contract" || kind === "provenance"
                ? "application/json"
                : "application/zip",
          },
        ],
      ),
    );
    const operation = {
      buildId: fallbackBuildId,
      kind: "site_build",
      status: "running",
      providerTaskId: "manus-task-1",
      result: {
        schemaVersion: 2,
        buildPhase: "provider_sync_delayed",
        fallbackPreview: {
          status: "bound",
          trigger: "provider_read_delayed",
          createdAt: "2026-08-27T00:15:00.000Z",
          reconcileUntilAt: "2026-08-28T00:00:00.000Z",
          buildId: fallbackBuildId,
          taskId: "manus-task-1",
          operationToken:
            "siteops-native-fallback:10000000-0000-4000-8000-000000000001",
          selectedPreviewSha256: "a".repeat(64),
          selectedSourceTreeSha256: "b".repeat(64),
          artifactBindings,
          buildDelivery: {
            renderMode: "trusted_fallback",
            qaStatus: "partial",
            warningCodes: ["NATIVE_PROVIDER_SYNC_TRUSTED_FALLBACK"],
          },
        },
      },
    };
    expect(
      projectSiteOpsBuildDelivery({
        buildId: fallbackBuildId,
        operations: [operation],
      }),
    ).toEqual({
      renderMode: "trusted_fallback",
      qaStatus: "partial",
      warningCodes: ["NATIVE_PROVIDER_SYNC_TRUSTED_FALLBACK"],
    });
    expect(
      projectSiteOpsBuildProgress({
        buildId: fallbackBuildId,
        operations: [operation],
      }),
    ).toMatchObject({
      buildPhase: "provider_sync_delayed",
      recoverable: true,
      previewWarning: expect.stringContaining("基础预览"),
    });
    expect(
      projectSiteOpsBuildProgress({
        buildId: fallbackBuildId,
        operations: [
          {
            ...operation,
            providerTaskId: null,
            result: {
              ...operation.result,
              taskId: undefined,
            },
          },
        ],
      }),
    ).toMatchObject({
      buildPhase: "provider_sync_delayed",
      recoverable: true,
      previewWarning: expect.stringContaining("基础预览"),
    });
    expect(
      projectSiteOpsBuildProgress({
        buildId: fallbackBuildId,
        operations: [{ ...operation, status: "attention_required" }],
      }),
    ).toMatchObject({
      recoverable: true,
      previewWarning: expect.stringContaining("自动对账窗口已结束"),
    });
  });

  it("projects recoverable native repair and provider sync phases", () => {
    expect(
      projectSiteOpsBuildProgress({
        buildId: "build-waiting",
        operations: [
          {
            buildId: "build-waiting",
            kind: "site_build",
            status: "running",
            providerTaskId: "manus-task-waiting",
            result: {
              schemaVersion: 2,
              stage: "native_source_pending",
              buildPhase: "source_waiting",
            },
          },
        ],
      }),
    ).toMatchObject({
      buildPhase: "source_waiting",
      recoverable: true,
      previewWarning: expect.stringContaining("可信默认内容"),
    });
    expect(
      projectSiteOpsBuildProgress({
        buildId: "build-1",
        operations: [
          {
            buildId: "build-1",
            kind: "site_build",
            status: "running",
            providerTaskId: "manus-task-1",
            result: {
              schemaVersion: 2,
              stage: "native_repair_pending",
              buildPhase: "provider_sync_delayed",
            },
          },
        ],
      }),
    ).toMatchObject({
      buildPhase: "provider_sync_delayed",
      recoverable: true,
      previewWarning: expect.stringContaining("同一任务"),
    });
    expect(
      projectSiteOpsBuildProgress({
        buildId: "build-1",
        operations: [
          {
            buildId: "build-1",
            kind: "build_revision",
            status: "failed",
            providerTaskId: "manus-task-1",
            errorCode: "FRONTMIND_BUILD_SERVICE_UNAVAILABLE",
            result: {
              schemaVersion: 1,
              stage: "native_repair_pending",
            },
          },
        ],
      }),
    ).toMatchObject({
      buildPhase: "source_repairing",
      recoverable: true,
    });
    expect(
      projectSiteOpsBuildProgress({
        buildId: "build-1",
        operations: [
          {
            buildId: "build-1",
            kind: "site_build",
            status: "succeeded",
            result: { buildPhase: "persisting_preview" },
          },
        ],
      }),
    ).toEqual({
      buildPhase: null,
      recoverable: false,
      previewWarning: null,
    });
  });

  it("projects real build stages once and preserves terminal elapsed time", () => {
    const steps = projectSiteOpsExecutionSteps({
      operations: [
        {
          id: "operation-build",
          buildId: "build-1",
          kind: "site_build",
          status: "failed",
          startedAt: new Date("2026-08-22T00:00:00.000Z"),
          completedAt: new Date("2026-08-22T00:04:00.000Z"),
          createdAt: new Date("2026-08-22T00:00:00.000Z"),
        },
      ],
      timelineMessages: [
        {
          id: "message-design-first",
          sentAt: new Date("2026-08-22T00:00:20.000Z"),
          metadata: {
            siteOps: {
              subjectId: "operation-build",
              payload: {
                stage: "design_compiling",
                buildId: "build-1",
                occurredAt: "2026-08-22T00:00:20.000Z",
              },
            },
          },
        },
        {
          id: "message-design-duplicate",
          sentAt: new Date("2026-08-22T00:00:40.000Z"),
          metadata: {
            siteOps: {
              subjectId: "operation-build",
              payload: {
                stage: "design_compiling",
                buildId: "build-1",
                occurredAt: "2026-08-22T00:00:40.000Z",
              },
            },
          },
        },
        {
          id: "message-content",
          sentAt: new Date("2026-08-22T00:01:00.000Z"),
          metadata: {
            siteOps: {
              subjectId: "operation-build",
              payload: {
                stage: "content_building",
                buildId: "build-1",
                occurredAt: "2026-08-22T00:01:00.000Z",
              },
            },
          },
        },
        {
          id: "message-qa",
          sentAt: new Date("2026-08-22T00:03:00.000Z"),
          metadata: {
            siteOps: {
              subjectId: "operation-build",
              payload: {
                stage: "qa_running",
                buildId: "build-1",
                occurredAt: "2026-08-22T00:03:00.000Z",
              },
            },
          },
        },
      ],
    });

    expect(steps.map((step) => step.stage)).toEqual([
      "preparing",
      "design_compiling",
      "content_building",
      "qa_running",
    ]);
    expect(steps[0]).toMatchObject({
      status: "succeeded",
      startedAt: "2026-08-22T00:00:00.000Z",
      completedAt: "2026-08-22T00:00:20.000Z",
    });
    expect(steps[3]).toMatchObject({
      status: "failed",
      completedAt: "2026-08-22T00:04:00.000Z",
    });
  });

  it("ends the customer build timeline when a trusted fallback is bound", () => {
    const artifactBinding = (
      id: string,
      mimeType: "application/json" | "application/zip",
    ) => ({
      id,
      sha256: "a".repeat(64),
      bytes: 100,
      mimeType,
    });
    const steps = projectSiteOpsExecutionSteps({
      operations: [
        {
          id: "operation-fallback",
          buildId: "10000000-0000-4000-8000-000000000001",
          kind: "site_build",
          status: "running",
          startedAt: new Date("2026-08-27T04:00:00.000Z"),
          completedAt: null,
          createdAt: new Date("2026-08-27T04:00:00.000Z"),
          result: {
            fallbackPreview: {
              status: "bound",
              trigger: "repair_budget_exhausted",
              createdAt: "2026-08-27T04:05:00.000Z",
              reconcileUntilAt: "2026-08-28T04:05:00.000Z",
              buildId: "10000000-0000-4000-8000-000000000001",
              taskId: "manus-task",
              operationToken:
                "siteops-native-fallback:20000000-0000-4000-8000-000000000002",
              selectedPreviewSha256: "b".repeat(64),
              selectedSourceTreeSha256: "c".repeat(64),
              artifactBindings: {
                contract: artifactBinding(
                  "30000000-0000-4000-8000-000000000003",
                  "application/json",
                ),
                source: artifactBinding(
                  "40000000-0000-4000-8000-000000000004",
                  "application/zip",
                ),
                dist: artifactBinding(
                  "50000000-0000-4000-8000-000000000005",
                  "application/zip",
                ),
                qa: artifactBinding(
                  "60000000-0000-4000-8000-000000000006",
                  "application/zip",
                ),
                provenance: artifactBinding(
                  "70000000-0000-4000-8000-000000000007",
                  "application/json",
                ),
              },
              buildDelivery: {
                renderMode: "trusted_fallback",
                qaStatus: "partial",
                warningCodes: ["SITEOPS_TRUSTED_FALLBACK"],
              },
            },
          },
        },
      ],
      timelineMessages: [
        {
          id: "qa-start",
          sentAt: new Date("2026-08-27T04:04:00.000Z"),
          metadata: {
            siteOps: {
              subjectId: "operation-fallback",
              payload: { stage: "qa_running" },
            },
          },
        },
      ],
    });

    expect(steps.at(-1)).toMatchObject({
      stage: "qa_running",
      status: "succeeded",
      completedAt: "2026-08-27T04:05:00.000Z",
    });
  });

  it("caps observation projection work at four concurrent queries", async () => {
    let active = 0;
    let maxActive = 0;
    const results = await runSiteOpsObservationQueries(
      Array.from({ length: 11 }, (_, index) => async () => {
        active += 1;
        maxActive = Math.max(maxActive, active);
        await new Promise((resolve) => setTimeout(resolve, 2));
        active -= 1;
        return index;
      }),
    );

    expect(maxActive).toBe(4);
    expect(results).toEqual(Array.from({ length: 11 }, (_, index) => index));
  });

  it("coalesces concurrent observation projections for the same key", async () => {
    let calls = 0;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const task = async () => {
      calls += 1;
      await gate;
      return { revision: 9 };
    };

    const first = runSiteOpsObservationSingleFlight("project:9", task);
    const second = runSiteOpsObservationSingleFlight("project:9", task);
    expect(calls).toBe(1);
    release();
    await expect(Promise.all([first, second])).resolves.toEqual([
      { revision: 9 },
      { revision: 9 },
    ]);
    expect(calls).toBe(1);
  });

  it("uses one total-duration row for a historical build without stage events", () => {
    expect(
      projectSiteOpsExecutionSteps({
        operations: [
          {
            id: "legacy-operation",
            buildId: "legacy-build",
            kind: "build_revision",
            status: "succeeded",
            startedAt: new Date("2026-08-22T00:00:00.000Z"),
            completedAt: new Date("2026-08-22T00:05:00.000Z"),
            createdAt: new Date("2026-08-22T00:00:00.000Z"),
          },
        ],
        timelineMessages: [],
      }),
    ).toEqual([
      {
        id: "legacy-operation:legacy-total",
        operationKind: "build_revision",
        buildId: "legacy-build",
        stage: "completed",
        label: "官网制作",
        status: "succeeded",
        startedAt: "2026-08-22T00:00:00.000Z",
        completedAt: "2026-08-22T00:05:00.000Z",
      },
    ]);
  });

  it("allows an unselected visual board to be replaced without resetting the website", () => {
    expect(
      visualSearchAllowedForProjectStatus("awaiting_visual_selection", true),
    ).toBe(true);
    expect(
      visualSearchAllowedForProjectStatus("awaiting_visual_selection", false),
    ).toBe(false);
    expect(visualSearchAllowedForProjectStatus("collecting_brief", false)).toBe(
      true,
    );
    expect(visualSearchAllowedForProjectStatus("visual_searching", true)).toBe(
      true,
    );
    expect(visualSearchAllowedForProjectStatus("preview_ready", true)).toBe(
      false,
    );
    expect(visualSearchAllowedForProjectStatus("live", true)).toBe(false);
  });

  it.each([
    ["SITEOPS_ENTITLEMENT_REQUIRED", 403, "FORBIDDEN"],
    ["SITEOPS_QUOTA_PERIOD_NOT_FOUND", 409, "STATE_CONFLICT"],
    ["SITEOPS_QUOTA_EXHAUSTED", 409, "STATE_CONFLICT"],
  ] as const)(
    "maps %s to its stable SiteOps service boundary",
    (quotaCode, statusCode, serviceCode) => {
      const mapped = siteOpsServiceErrorFromQuota(
        new SiteOpsQuotaError(quotaCode, "配额提示", statusCode),
      );

      expect(mapped).toMatchObject({
        code: serviceCode,
        message: "配额提示",
        statusCode,
      });
    },
  );

  it("freezes the selected production F reference to a hashed floating-orbit blueprint", () => {
    const visualEvidence = createVisualEvidenceV1({
      evidenceKind: "catalog_metadata_preview_v1",
      providerItemKey: "n:8435",
      metadataSha256: "a".repeat(64),
      providerResponseSha256: "b".repeat(64),
      previewSha256: "c".repeat(64),
      taxonomyDerivationVersion: "catalog-metadata-preview-v1",
    });
    const frozen = freezeSiteOpsReferenceBlueprint({
      sampleId: "10000000-0000-4000-8000-000000000001",
      note: "Hero Section 7",
      sourceMetadata: {
        providerItemKey: "n:8435",
        title: "Hero Section 7",
        sourceUrl: "https://21st.dev/@ravikatiyar162/components/hero-section-7",
        heroEligibility: {
          eligible: true,
          confidence: "explicit",
          variant: "centered_statement",
        },
        visualEvidence,
      },
    });
    expect(frozen.heroFamily).toBe("floating_orbit");
    expect(frozen.mediaStrategy).toBe("procedural_brand_svg");
    expect(frozen.blueprintHash).toHaveLength(64);

    const inherited = referenceBlueprintForSiteOpsRevision({
      parentWorkflowVersion: "2.0.0",
      parentOperationInput: { referenceBlueprint: frozen },
      derivedReferenceBlueprint: frozen,
    });
    expect(inherited).toEqual(frozen);
    expect(() =>
      referenceBlueprintForSiteOpsRevision({
        parentWorkflowVersion: "2.0.0",
        parentOperationInput: {},
        derivedReferenceBlueprint: frozen,
      }),
    ).toThrow("不能静默改变视觉方向");
    expect(
      referenceBlueprintForSiteOpsRevision({
        parentWorkflowVersion: "1.6.0",
        parentOperationInput: {},
        derivedReferenceBlueprint: frozen,
      }),
    ).toEqual(frozen);
  });

  it("freezes an exact host-rendered V3 blueprint and local preview", () => {
    const sampleId = "10000000-0000-4000-8000-000000000001";
    const previewLocalAssetId = "20000000-0000-4000-8000-000000000002";
    const providerItemKey = "s:frontmind:editorial:evidence";
    const visualEvidence = createVisualEvidenceV1({
      evidenceKind: "catalog_metadata_preview_v1",
      providerItemKey,
      metadataSha256: "a".repeat(64),
      providerResponseSha256: "b".repeat(64),
      previewSha256: "c".repeat(64),
      taxonomyDerivationVersion: "catalog-metadata-preview-v1",
    });
    const blueprint = referenceBlueprintV3ForFamily({
      candidateId: sampleId,
      providerItemKey,
      previewLocalAssetId,
      previewSha256: visualEvidence.previewSha256,
      heroFamily: "editorial",
      inspirationEvidenceIds: ["d".repeat(64)],
    });
    expect(
      freezeSiteOpsReferenceBlueprint({
        sampleId,
        previewLocalAssetId,
        note: "编辑杂志式",
        sourceMetadata: {
          providerItemKey,
          visualEvidence,
          referenceBlueprint: blueprint,
        },
      }),
    ).toEqual(blueprint);
    expect(() =>
      freezeSiteOpsReferenceBlueprint({
        sampleId,
        previewLocalAssetId: "30000000-0000-4000-8000-000000000003",
        note: "编辑杂志式",
        sourceMetadata: {
          providerItemKey,
          visualEvidence,
          referenceBlueprint: blueprint,
        },
      }),
    ).toThrow("所选视觉方案已失效");
  });

  it("freezes a V4 provider reference separately from its trusted realization", () => {
    const sampleId = "10000000-0000-4000-8000-000000000001";
    const referencePreviewLocalAssetId = "20000000-0000-4000-8000-000000000002";
    const realizationPreviewLocalAssetId =
      "30000000-0000-4000-8000-000000000003";
    const providerItemKey = "n:18898";
    const visualEvidence = createVisualEvidenceV1({
      evidenceKind: "catalog_metadata_preview_v1",
      providerItemKey,
      metadataSha256: "a".repeat(64),
      providerResponseSha256: "b".repeat(64),
      previewSha256: "c".repeat(64),
      taxonomyDerivationVersion: "catalog-metadata-preview-v1",
    });
    const blueprint = referenceBlueprintV4ForFamily({
      candidateId: sampleId,
      providerItemKey,
      referencePreviewLocalAssetId,
      referencePreviewSha256: visualEvidence.previewSha256,
      realizationPreviewLocalAssetId,
      realizationPreviewSha256: "d".repeat(64),
      heroFamily: "split_media",
      inspirationEvidenceId: visualEvidence.evidenceSha256,
      inspirationTaxonomy: {
        role: "foundation",
        palette: [],
        typography: [],
        layout: ["split-layout"],
        motion: [],
        accessibility: ["reduced-motion"],
      },
    });

    expect(
      freezeSiteOpsReferenceBlueprint({
        sampleId,
        previewLocalAssetId: referencePreviewLocalAssetId,
        note: "分屏媒体式",
        sourceMetadata: {
          providerItemKey,
          visualEvidence,
          referenceBlueprint: blueprint,
          realizationPreviewLocalAssetId,
          realizationPreviewSha256: blueprint.previewSha256,
        },
      }),
    ).toEqual(blueprint);
    expect(() =>
      freezeSiteOpsReferenceBlueprint({
        sampleId,
        previewLocalAssetId: referencePreviewLocalAssetId,
        note: "分屏媒体式",
        sourceMetadata: {
          providerItemKey,
          visualEvidence,
          referenceBlueprint: blueprint,
          realizationPreviewLocalAssetId,
          realizationPreviewSha256: "e".repeat(64),
        },
      }),
    ).toThrow("所选视觉方案已失效");
  });

  it("freezes every new or reset root to the Native Template 2.7 workflow", () => {
    expect(currentSiteOpsBuildWorkflowCoordinates()).toEqual({
      workflowUpstreamVersion: SITEOPS_DEFAULT_WORKFLOW.upstreamVersion,
      workflowUpstreamHash: SITEOPS_DEFAULT_WORKFLOW.upstreamSha256,
      workflowVersion: SITEOPS_DEFAULT_WORKFLOW.frontMindVersion,
      workflowPackageHash: SITEOPS_DEFAULT_WORKFLOW.runtimeManifestSha256,
      starterVersion: SITEOPS_DEFAULT_WORKFLOW.starterVersion,
    });
  });

  it("accepts frozen historical boards while rejecting unknown workflows", () => {
    expect(() => assertCurrentVisualWorkflowVersion("0.0.0")).toThrow(
      "历史建站合同无法继续",
    );
    expect(() =>
      assertCurrentVisualWorkflowVersion(
        SITEOPS_DEFAULT_WORKFLOW.frontMindVersion,
      ),
    ).not.toThrow();
    expect(() =>
      assertCurrentVisualWorkflowVersion(
        SITEOPS_MATERIALIZER_V2_5.frontMindVersion,
      ),
    ).not.toThrow();
    expect(() =>
      assertCurrentVisualWorkflowVersion(
        SITEOPS_MATERIALIZER_V2_6.frontMindVersion,
      ),
    ).not.toThrow();
    expect(() =>
      assertCurrentVisualWorkflowVersion(
        SITEOPS_MATERIALIZER_V2_4.frontMindVersion,
      ),
    ).toThrow("历史建站合同无法继续");
  });

  it("keeps supplemental visual pages on the cycle's frozen workflow", () => {
    const frozen = (workflowVersion: string, page: 1 | 2) => ({
      schemaVersion: 2 as const,
      knowledgeSnapshotId: "30000000-0000-4000-8000-000000000003",
      credentialId: "20000000-0000-4000-8000-000000000002",
      credentialVersion: 7,
      workflowVersion,
      mode: page === 1 ? ("initial" as const) : ("supplemental" as const),
      page,
      admissionRevision: page,
    });
    expect(
      siteOpsVisualCycleWorkflowVersion([
        frozen(SITEOPS_MATERIALIZER_V2_5.frontMindVersion, 1),
        frozen(SITEOPS_MATERIALIZER_V2_5.frontMindVersion, 2),
      ]),
    ).toBe(SITEOPS_MATERIALIZER_V2_5.frontMindVersion);
    expect(() =>
      siteOpsVisualCycleWorkflowVersion([
        frozen(SITEOPS_MATERIALIZER_V2_5.frontMindVersion, 1),
        frozen(SITEOPS_DEFAULT_WORKFLOW.frontMindVersion, 2),
      ]),
    ).toThrow("冻结工作流不一致");
  });

  it("creates a strict four-field visual operation without a Manus credential", () => {
    const input = createVisualSearchOperationInput({
      knowledgeSnapshotId: "10000000-0000-4000-8000-000000000001",
      credentialId: "20000000-0000-4000-8000-000000000002",
      credentialVersion: 7,
      workflowVersion: "1.2.0",
    });

    expect(input).toEqual({
      knowledgeSnapshotId: "10000000-0000-4000-8000-000000000001",
      credentialId: "20000000-0000-4000-8000-000000000002",
      credentialVersion: 7,
      workflowVersion: "1.2.0",
    });
    expect(Object.keys(input).sort()).toEqual([
      "credentialId",
      "credentialVersion",
      "knowledgeSnapshotId",
      "workflowVersion",
    ]);
  });

  it("creates a strict V2 supplemental visual operation pinned to the admitted revision", () => {
    expect(
      createVisualSearchOperationInput({
        schemaVersion: 2,
        knowledgeSnapshotId: "10000000-0000-4000-8000-000000000001",
        credentialId: "20000000-0000-4000-8000-000000000002",
        credentialVersion: 7,
        workflowVersion: "1.2.0",
        mode: "supplemental",
        page: 2,
        admissionRevision: 9,
      }),
    ).toMatchObject({
      schemaVersion: 2,
      mode: "supplemental",
      page: 2,
      admissionRevision: 9,
    });
    expect(() =>
      createVisualSearchOperationInput({
        schemaVersion: 2,
        knowledgeSnapshotId: "10000000-0000-4000-8000-000000000001",
        credentialId: "20000000-0000-4000-8000-000000000002",
        credentialVersion: 7,
        workflowVersion: "1.2.0",
        mode: "initial",
        page: 2,
        admissionRevision: 9,
      }),
    ).toThrow();
  });

  it("separates supplemental generation from selection and recovers a terminal legacy board", () => {
    const operationInput = {
      schemaVersion: 2,
      knowledgeSnapshotId: "10000000-0000-4000-8000-000000000001",
      credentialId: "20000000-0000-4000-8000-000000000002",
      credentialVersion: 7,
      workflowVersion: "1.2.0",
      mode: "supplemental",
      page: 2,
      admissionRevision: 9,
    };
    expect(
      projectSiteOpsVisualGeneration({
        projectStatus: "awaiting_visual_selection",
        generatedPages: 1,
        latestVisualOperation: { status: "running", input: operationInput },
        hasActiveVisualOperation: true,
        hasActiveBuild: false,
        hasBuildAttempt: false,
      }),
    ).toMatchObject({
      status: "generating",
      targetPage: 2,
      canGenerateMore: false,
      canSelectExisting: false,
    });
    expect(
      projectSiteOpsVisualGeneration({
        projectStatus: "attention_required",
        generatedPages: 1,
        latestVisualOperation: {
          status: "attention_required",
          input: operationInput,
        },
        hasActiveVisualOperation: false,
        hasActiveBuild: false,
        hasBuildAttempt: false,
      }),
    ).toMatchObject({
      status: "retryable_error",
      targetPage: null,
      availablePages: 1,
      reservedPages: 0,
      canGenerateMore: true,
      canSelectExisting: true,
      retryAction: "supplemental",
      recoveredSelection: true,
    });
  });

  it("only advertises pages that the candidate pool has already frozen", () => {
    const base = {
      projectStatus: "awaiting_visual_selection",
      generatedPages: 1,
      latestVisualOperation: { status: "succeeded" },
      hasActiveVisualOperation: false,
      hasActiveBuild: false,
      hasBuildAttempt: false,
    };

    expect(
      projectSiteOpsVisualGeneration({
        ...base,
        availablePages: 1,
        reservedPages: 0,
      }),
    ).toMatchObject({
      availablePages: 1,
      reservedPages: 0,
      canGenerateMore: false,
    });
    expect(
      projectSiteOpsVisualGeneration({
        ...base,
        availablePages: 2,
        reservedPages: 1,
      }),
    ).toMatchObject({
      availablePages: 2,
      reservedPages: 1,
      canGenerateMore: true,
    });
  });

  it("projects the fixed 2.8 catalog as four complete local pages with no supplemental generation", () => {
    expect(
      projectSiteOpsVisualGeneration({
        projectStatus: "awaiting_visual_selection",
        generatedPages: 4,
        availablePages: 4,
        reservedPages: 0,
        latestVisualOperation: { status: "succeeded" },
        hasActiveVisualOperation: false,
        hasActiveBuild: false,
        hasBuildAttempt: false,
        workflowVersion: SITEOPS_MATERIALIZER_V2_8.frontMindVersion,
        catalogVersion: "21st-included-recommended-20260828-v2",
        pageSize: 8,
        pageCount: 4,
      }),
    ).toMatchObject({
      status: "idle",
      generatedPages: 4,
      availablePages: 4,
      reservedPages: 0,
      maxPages: 4,
      workflowVersion: "2.8.0",
      catalogVersion: "21st-included-recommended-20260828-v2",
      pageSize: 8,
      pageCount: 4,
      canGenerateMore: false,
      canSelectExisting: true,
    });
  });

  it("projects a pristine project as the dynamic-IA 2.9 catalog before any visual operation exists", () => {
    const coordinates = resolveVisualCatalogObservationCoordinates({
      frozenVisualInput: null,
      hasAnyVisualOperation: false,
      visibleBatchCount: 0,
    });
    expect(coordinates).toMatchObject({
      pristineVisualCycle: true,
      workflowVersion: "2.9.0",
      catalogVersion: "21st-included-recommended-20260828-v2",
      staticCatalogVisualCycle: true,
      pageSize: 8,
      pageCount: 4,
      defaultAvailability: { availablePages: 4, reservedPages: 0 },
    });
    expect(
      projectSiteOpsVisualGeneration({
        projectStatus: "draft",
        generatedPages: 0,
        ...coordinates.defaultAvailability!,
        latestVisualOperation: null,
        hasActiveVisualOperation: false,
        hasActiveBuild: false,
        hasBuildAttempt: false,
        workflowVersion: coordinates.workflowVersion,
        catalogVersion: coordinates.catalogVersion,
        pageSize: coordinates.pageSize,
        pageCount: coordinates.pageCount,
      }),
    ).toMatchObject({
      generatedPages: 0,
      availablePages: 4,
      reservedPages: 0,
      maxPages: 4,
      workflowVersion: "2.9.0",
      catalogVersion: "21st-included-recommended-20260828-v2",
      pageSize: 8,
      pageCount: 4,
      canGenerateMore: false,
    });
  });

  it("reports visual readiness from the active fixed catalog rather than a legacy 21st credential", () => {
    expect(
      projectStaticTemplateCatalogVisualReadiness({
        workflowVersion: "2.8.0",
        catalogVersion: "21st-included-recommended-20260828-v2",
        pageSize: 8,
        pageCount: 4,
        entries: [
          {
            candidateId: "static-template-22-hirael-agency-landing",
            executionAdmission: { status: "admitted" },
          },
        ],
      }),
    ).toEqual({ status: "configured", reason: undefined });
    expect(projectStaticTemplateCatalogVisualReadiness(null)).toEqual({
      status: "not_configured",
      reason: "固定 Template 目录尚未就绪，请联系 FrontMind",
    });
  });

  it("does not relabel an existing historical visual operation as a pristine 2.8 cycle", () => {
    expect(
      resolveVisualCatalogObservationCoordinates({
        frozenVisualInput: null,
        hasAnyVisualOperation: true,
        visibleBatchCount: 0,
      }),
    ).toMatchObject({
      pristineVisualCycle: false,
      workflowVersion: null,
      catalogVersion: null,
      staticCatalogVisualCycle: false,
      pageSize: 9,
      pageCount: 3,
      defaultAvailability: null,
    });
  });

  it("keeps all four static pages complete after one batch becomes selected", () => {
    const batches = Array.from({ length: 4 }, (_, index) => ({
      id: `static-batch-${index + 1}`,
      status: index === 1 ? "selected" : "published",
    }));
    const candidates = batches.flatMap((batch) =>
      Array.from({ length: 8 }, () => ({ batchId: batch.id })),
    );

    expect(
      completePublishedVisualPageCount({
        batches,
        candidates,
        pageSize: 8,
        visibleStatuses: ["published", "selected"],
      }),
    ).toBe(4);
    expect(
      completePublishedVisualPageCount({ batches, candidates, pageSize: 8 }),
    ).toBe(3);
  });

  it("orders same-second visual retries by monotonic admission revision", () => {
    const at = new Date("2026-08-26T08:00:00.000Z");
    const baseInput = {
      schemaVersion: 2 as const,
      knowledgeSnapshotId: "10000000-0000-4000-8000-000000000001",
      credentialId: "20000000-0000-4000-8000-000000000002",
      credentialVersion: 7,
      workflowVersion: "2.5.0",
      mode: "initial" as const,
      page: 1 as const,
    };
    const oldFailure = {
      id: "ffffffff-ffff-4fff-8fff-ffffffffffff",
      status: "attention_required",
      input: { ...baseInput, admissionRevision: 9 },
      createdAt: at,
      updatedAt: at,
    };
    const activeRetry = {
      id: "00000000-0000-4000-8000-000000000000",
      status: "running",
      input: { ...baseInput, admissionRevision: 10 },
      createdAt: at,
      updatedAt: at,
    };
    expect(
      [oldFailure, activeRetry].sort(
        compareSiteOpsVisualOperationsNewestFirst,
      )[0],
    ).toBe(activeRetry);
  });

  it("makes a terminal first-page visual failure directly retryable without a reset", () => {
    expect(
      projectSiteOpsVisualGeneration({
        projectStatus: "attention_required",
        generatedPages: 0,
        latestVisualOperation: {
          status: "attention_required",
          errorCode: "NATIVE_SOURCE_COMPILE_UNAVAILABLE",
          input: {
            schemaVersion: 2,
            knowledgeSnapshotId: "10000000-0000-4000-8000-000000000001",
            credentialId: "20000000-0000-4000-8000-000000000002",
            credentialVersion: 7,
            workflowVersion: "2.5.0",
            mode: "initial",
            page: 1,
            admissionRevision: 9,
          },
        },
        hasActiveVisualOperation: false,
        hasActiveBuild: false,
        hasBuildAttempt: false,
      }),
    ).toMatchObject({
      status: "retryable_error",
      targetPage: null,
      generatedPages: 0,
      canGenerateMore: true,
      canSelectExisting: false,
      retryAction: "start",
      failureCategory: "compile_failed",
      recoveredSelection: false,
    });
  });

  it("projects a complete-template pool failure as a retryable initial generation", () => {
    expect(
      projectSiteOpsVisualGeneration({
        projectStatus: "attention_required",
        generatedPages: 0,
        latestVisualOperation: {
          status: "attention_required",
          errorCode: "NATIVE_TEMPLATE_BUILD_POOL_INSUFFICIENT",
          input: {
            schemaVersion: 2,
            knowledgeSnapshotId: "10000000-0000-4000-8000-000000000001",
            credentialId: "20000000-0000-4000-8000-000000000002",
            credentialVersion: 7,
            workflowVersion: "2.5.0",
            mode: "initial",
            page: 1,
            admissionRevision: 9,
          },
        },
        hasActiveVisualOperation: false,
        hasActiveBuild: false,
        hasBuildAttempt: false,
      }),
    ).toMatchObject({
      status: "retryable_error",
      retryAction: "start",
      failureCategory: "insufficient_live_templates",
      canGenerateMore: true,
    });
  });

  it("distinguishes static catalog persistence from local catalog failures", () => {
    const projectionFor = (errorCode: string) =>
      projectSiteOpsVisualGeneration({
        projectStatus: "attention_required",
        generatedPages: 0,
        latestVisualOperation: {
          status: "attention_required",
          errorCode,
          input: {
            schemaVersion: 3,
            knowledgeSnapshotId: "10000000-0000-4000-8000-000000000001",
            workflowVersion: "2.8.0",
            catalogVersion: "21st-included-recommended-20260828-v2",
            mode: "initial",
            page: 1,
            admissionRevision: 9,
          },
        },
        hasActiveVisualOperation: false,
        hasActiveBuild: false,
        hasBuildAttempt: false,
        workflowVersion: "2.8.0",
        catalogVersion: "21st-included-recommended-20260828-v2",
        pageSize: 8,
        pageCount: 4,
      });

    expect(projectionFor("VISUAL_BOARD_PERSISTENCE_FAILED")).toMatchObject({
      status: "retryable_error",
      failureCategory: "persistence_failed",
    });
    expect(
      projectionFor("STATIC_TEMPLATE_CATALOG_PREVIEW_HASH_MISMATCH"),
    ).toMatchObject({
      status: "retryable_error",
      failureCategory: "catalog_unavailable",
    });
    expect(
      projectionFor("STATIC_TEMPLATE_CATALOG_OPERATION_INVALID"),
    ).toMatchObject({
      status: "retryable_error",
      failureCategory: null,
    });
    for (const errorCode of [
      "STATIC_TEMPLATE_PREVIEW_PERSISTENCE_FAILED",
      "STATIC_TEMPLATE_PREVIEW_PERSISTENCE_HASH_MISMATCH",
      "STATIC_TEMPLATE_SELECTION_PERSISTENCE_FAILED",
      "STATIC_TEMPLATE_SELECTION_HASH_MISMATCH",
    ]) {
      expect(projectionFor(errorCode)).toMatchObject({
        status: "retryable_error",
        failureCategory: "persistence_failed",
      });
    }
  });

  it("prefers the recorded complete-template failure cause over the aggregate pool code", () => {
    expect(
      projectSiteOpsVisualGeneration({
        projectStatus: "attention_required",
        generatedPages: 0,
        latestVisualOperation: {
          status: "attention_required",
          errorCode: "NATIVE_TEMPLATE_BUILD_POOL_INSUFFICIENT",
          result: { templateFailureCategory: "compile_failed" },
        },
        hasActiveVisualOperation: false,
        hasActiveBuild: false,
        hasBuildAttempt: false,
      }),
    ).toMatchObject({
      status: "retryable_error",
      failureCategory: "compile_failed",
      canGenerateMore: true,
    });
  });

  it("does not expose a retry while a first-page visual operation is still active", () => {
    expect(
      projectSiteOpsVisualGeneration({
        projectStatus: "visual_searching",
        generatedPages: 0,
        latestVisualOperation: { status: "running" },
        hasActiveVisualOperation: true,
        hasActiveBuild: false,
        hasBuildAttempt: false,
      }),
    ).toMatchObject({
      status: "generating",
      canGenerateMore: false,
      canSelectExisting: false,
      retryAction: null,
      failureCategory: null,
    });
  });

  it("requires a complete board, terminal visual operation and no active work for compatibility selection", () => {
    const recoverable = {
      projectStatus: "failed",
      completePublishedPages: 1,
      latestVisualOperationStatus: "failed",
      hasActiveVisualOperation: false,
      hasActiveBuild: false,
      hasBuildAttempt: false,
    };
    expect(siteOpsVisualSelectionRecovery(recoverable)).toBe(true);
    expect(
      siteOpsVisualSelectionRecovery({
        ...recoverable,
        hasActiveVisualOperation: true,
      }),
    ).toBe(false);
    expect(
      siteOpsVisualSelectionRecovery({
        ...recoverable,
        completePublishedPages: 0,
      }),
    ).toBe(false);
    expect(
      siteOpsVisualSelectionRecovery({
        ...recoverable,
        hasBuildAttempt: true,
      }),
    ).toBe(false);
  });

  it("does not recover visual selection from a selected display fallback after a terminal build failure", () => {
    const selectedBatchId = "selected-batch";
    const generatedPages = completePublishedVisualPageCount({
      batches: [{ id: selectedBatchId, status: "selected" }],
      candidates: Array.from({ length: 9 }, () => ({
        batchId: selectedBatchId,
      })),
    });

    expect(generatedPages).toBe(0);
    for (const projectStatus of ["failed", "attention_required"]) {
      expect(
        projectSiteOpsVisualGeneration({
          projectStatus,
          generatedPages,
          latestVisualOperation: { status: "succeeded" },
          hasActiveVisualOperation: false,
          hasActiveBuild: false,
          hasBuildAttempt: true,
        }),
      ).toMatchObject({
        status: "idle",
        generatedPages: 0,
        canGenerateMore: false,
        canSelectExisting: false,
        recoveredSelection: false,
      });
    }
  });

  it("projects both the project and interaction state when a legacy board is recovered", () => {
    expect(
      projectSiteOpsObservationStatuses({
        projectStatus: "attention_required",
        recoveredSelection: true,
      }),
    ).toEqual({
      projectStatus: "awaiting_visual_selection",
      interactionState: "awaiting_visual_selection",
    });
    expect(
      projectSiteOpsObservationStatuses({
        projectStatus: "draft",
        recoveredSelection: false,
      }),
    ).toEqual({
      projectStatus: "draft",
      interactionState: "select_snapshot",
    });
  });

  it("hashes canonical object keys while preserving meaningful array order", () => {
    expect(hashSiteOpsRequest({ b: 2, a: { d: 4, c: 3 } })).toBe(
      hashSiteOpsRequest({ a: { c: 3, d: 4 }, b: 2 }),
    );
    expect(hashSiteOpsRequest({ items: ["A", "B"] })).not.toBe(
      hashSiteOpsRequest({ items: ["B", "A"] }),
    );
  });

  it("replays the same operation before reserving quota and rejects key reuse", () => {
    const requestHash = hashSiteOpsRequest({ action: "create_wechat_package" });
    expect(
      isSiteOpsOperationReplay({ inputHash: requestHash }, requestHash),
    ).toBe(true);
    expect(() =>
      isSiteOpsOperationReplay(
        { inputHash: requestHash },
        hashSiteOpsRequest({ action: "create_xiaohongshu_package" }),
      ),
    ).toThrow("该请求标识已用于不同操作");
    expect(isSiteOpsOperationReplay(null, requestHash)).toBe(false);
  });

  it("checks a lost-response message replay before re-freezing revision images", async () => {
    const source = await readFile(
      path.join(process.cwd(), "server/siteops/service.ts"),
      "utf8",
    );
    const body = source.slice(
      source.indexOf("export async function sendSiteOpsMessage("),
      source.indexOf("export function parseSiteOpsActionPayload("),
    );
    const replay = body.indexOf(
      "isSiteOpsOperationReplay(replayRows[0], requestHash)",
    );
    const freeze = body.indexOf("freezeSiteOpsRevisionInputAssets({");

    expect(replay).toBeGreaterThanOrEqual(0);
    expect(freeze).toBeGreaterThan(replay);
  });

  it("normalizes an IDN to its lower-case ASCII identity", () => {
    const domain = normalizeSiteOpsDomain("例子.公司.");
    expect(domain.domain).toBe("xn--fsqu00a.xn--55qx5d");
    expect(domain.domainUnicode).toBe("例子.公司");
  });

  it("accepts ICP approval only for the exact current domain revision", () => {
    const profile = {
      icpStatus: "approved",
      icpNumber: "京ICP备12345678号",
      icpDomainRevision: 6,
      domainRevision: 6,
    };
    expect(isSiteOpsIcpApprovedForCurrentDomain(profile)).toBe(true);
    expect(
      isSiteOpsIcpApprovedForCurrentDomain({ ...profile, domainRevision: 7 }),
    ).toBe(false);
    expect(
      isSiteOpsIcpApprovedForCurrentDomain({
        ...profile,
        icpStatus: "not_required",
      }),
    ).toBe(false);
  });

  it("builds a sourced brief from dashboard-core customer-confirmed leaves", () => {
    const brief = siteBriefFromSnapshot({
      sourceFileName: "维他健康-knowledge-base.zip",
      documents: [
        {
          id: "1.1",
          path: "企业概览/公司简介.md",
          title: "企业概览",
          content: "公司名称：维他健康\n\n面向关注健康管理的企业客户。",
          kind: "leaf",
          evidenceStatus: "needs_verification",
          customerVisible: true,
        },
        {
          id: "inferred-1",
          path: "推断.md",
          title: "推断内容",
          content: "不存在的客户案例",
          kind: "leaf",
          evidenceStatus: "inferred",
          customerVisible: true,
        },
      ],
      assets: [],
    } as never);

    expect(brief.companyName).toBe("维他健康");
    expect(brief.routes[0]?.sourceDocumentIds).toContain("1.1");
    expect(brief.verifiedFacts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ sourceDocumentIds: ["1.1"] }),
      ]),
    );
    expect(JSON.stringify(brief)).not.toContain("不存在的客户案例");
  });

  it("prefers the explicit public brand over a generic overview title", () => {
    const brief = siteBriefFromSnapshot({
      sourceFileName: "维他健康-knowledge-base.zip",
      documents: [
        {
          id: "brand-overview",
          path: "企业与品牌概览.md",
          title: "企业与品牌概览",
          content:
            "维他健康是一家聚焦健康服务的企业，以「天印溯方」为对外品牌。",
          kind: "overview",
          evidenceStatus: "verified",
          customerVisible: true,
        },
      ],
      assets: [],
    } as never);

    expect(brief.companyName).toBe("天印溯方");
    expect(brief.companyName).not.toBe("企业与品牌概览");
  });

  it("derives conditional content routes only from the frozen public inventory", () => {
    const documents = [
      ["overview-source", "企业概览.md", "企业概览", "公司名称：星河智造"],
      ["product-source", "产品/设备.md", "产品中心", "已确认的设备产品。"],
      ["service-source", "服务/运维.md", "服务方案", "已确认的运维服务。"],
      ["application-source", "应用/制造.md", "应用场景", "已确认的制造场景。"],
      ["case-source", "案例/客户.md", "客户案例", "已确认的客户案例。"],
      ["blog-source", "知识/指南.md", "知识博客", "已确认的知识指南。"],
      ["faq-source", "FAQ/问题.md", "常见问题", "已确认的常见问题。"],
      ["industry-news-source", "新闻/行业.md", "行业新闻", "外部行业新闻。"],
    ].map(([id, documentPath, title, content]) => ({
      id,
      path: documentPath,
      title,
      content,
      kind: id === "overview-source" ? "overview" : "leaf",
      evidenceStatus: "verified",
      customerVisible: true,
    }));
    documents.push({
      id: "inferred-company-news",
      path: "新闻/公司动态.md",
      title: "公司动态",
      content: "未经客户确认的动态。",
      kind: "leaf",
      evidenceStatus: "inferred",
      customerVisible: true,
    });

    const brief = siteBriefFromSnapshot({
      sourceFileName: "星河智造-knowledge-base.zip",
      documents,
      assets: [],
    } as never);
    const routeById = new Map(brief.routes.map((route) => [route.id, route]));
    for (const routeId of [
      "products",
      "services",
      "applications",
      "cases",
      "blog",
      "faq",
      "news",
    ]) {
      expect(routeById.has(routeId)).toBe(true);
    }
    expect(routeById.get("news")?.sourceDocumentIds).toEqual([]);
    expect(
      brief.contentInventory.entries.find(
        (entry) => entry.kind === "company_news",
      ),
    ).toBeUndefined();
    expect(JSON.stringify(brief)).not.toContain("inferred-company-news");
    expect(routeById.get("news")?.sourceDocumentIds).not.toContain(
      "industry-news-source",
    );
    expect(brief.contentInventory.entries.map((entry) => entry.kind)).toEqual(
      expect.arrayContaining([
        "product",
        "service",
        "application",
        "case_study",
        "blog",
        "faq",
      ]),
    );
  });

  it("allows the host-owned empty company-news route to start visual search", () => {
    const brief = siteBriefFromSnapshot({
      sourceFileName: "天印溯方-knowledge-base.zip",
      documents: [
        {
          id: "overview-source",
          path: "企业概览.md",
          title: "企业概览",
          content:
            "公司名称：天印溯方。天印溯方提供有来源记录的健康管理与检测服务。",
          kind: "overview",
          evidenceStatus: "needs_verification",
          customerVisible: true,
        },
      ],
      assets: [],
    } as never);

    expect(brief.routes.find((route) => route.id === "news")).toMatchObject({
      slug: "/news",
      sourceDocumentIds: [],
    });
    expect(
      brief.contentInventory.entries.some(
        (entry) => entry.kind === "company_news",
      ),
    ).toBe(false);
    expect(visualSearchReadiness(brief)).toEqual({ ready: true, brief });
  });

  it("rejects an empty news route when frozen company-news inventory exists", () => {
    const brief = siteBriefFromSnapshot({
      sourceFileName: "天印溯方-knowledge-base.zip",
      documents: [
        {
          id: "overview-source",
          path: "企业概览.md",
          title: "企业概览",
          content: "公司名称：天印溯方。企业提供有来源记录的健康管理服务。",
          kind: "overview",
          evidenceStatus: "verified_authoritative",
          customerVisible: true,
        },
        {
          id: "company-news-source",
          path: "新闻/企业动态.md",
          title: "企业动态",
          content: "天印溯方发布了有来源和日期记录的企业动态。",
          kind: "leaf",
          evidenceStatus: "verified_first_party",
          customerVisible: true,
        },
      ],
      assets: [],
    } as never);
    const broken = {
      ...brief,
      routes: brief.routes.map((route) =>
        route.id === "news" ? { ...route, sourceDocumentIds: [] } : route,
      ),
    };

    expect(visualSearchReadiness(broken)).toEqual({
      ready: false,
      reason: "source_contract_mismatch",
      routeId: "news",
    });
  });

  it("rejects an ordinary source-less route", () => {
    const brief = siteBriefFromSnapshot({
      sourceFileName: "天印溯方-knowledge-base.zip",
      documents: [
        {
          id: "overview-source",
          path: "企业概览.md",
          title: "企业概览",
          content: "公司名称：天印溯方。企业提供有来源记录的健康管理服务。",
          kind: "overview",
          evidenceStatus: "verified_first_party",
          customerVisible: true,
        },
      ],
      assets: [],
    } as never);
    const broken = {
      ...brief,
      routes: brief.routes.map((route) =>
        route.id === "about" ? { ...route, sourceDocumentIds: [] } : route,
      ),
    };

    expect(visualSearchReadiness(broken)).toEqual({
      ready: false,
      reason: "source_contract_mismatch",
      routeId: "about",
    });
  });

  it("distinguishes true public-fact absence from a malformed SiteBrief", () => {
    const brief = siteBriefFromSnapshot({
      sourceFileName: "天印溯方-knowledge-base.zip",
      documents: [
        {
          id: "overview-source",
          path: "企业概览.md",
          title: "企业概览",
          content: "公司名称：天印溯方。企业提供有来源记录的健康管理服务。",
          kind: "overview",
          evidenceStatus: "verified_first_party",
          customerVisible: true,
        },
      ],
      assets: [],
    } as never);

    expect(visualSearchReadiness({ ...brief, verifiedFacts: [] })).toEqual({
      ready: false,
      reason: "no_public_facts",
    });
    expect(
      visualSearchReadiness({ ...brief, unexpectedProviderField: true }),
    ).toEqual({ ready: false, reason: "invalid_brief" });
  });

  it.each(["localhost", "127.0.0.1", "bad domain.com", "-bad.example"])(
    "rejects a non-registrable or unsafe domain: %s",
    (domain) => {
      expect(() => normalizeSiteOpsDomain(domain)).toThrow(SiteOpsServiceError);
    },
  );

  it("keeps message and structured-action inputs strict", () => {
    const message = {
      conversationId: "siteops:7",
      clientRequestId: "request-0001",
      text: "请突出企业服务能力",
      localAssetIds: [],
      expectedProjectRevision: 1,
    };
    expect(siteOpsSendMessageInputSchema.parse(message)).toEqual(message);
    expect(() =>
      siteOpsSendMessageInputSchema.parse({ ...message, apiKey: "secret" }),
    ).toThrow();

    const assetIds = Array.from(
      { length: 8 },
      (_, index) => `asset_revision_${index}`,
    );
    expect(
      siteOpsSendMessageInputSchema.parse({
        ...message,
        localAssetIds: assetIds,
      }).localAssetIds,
    ).toEqual(assetIds);
    expect(() =>
      siteOpsSendMessageInputSchema.parse({
        ...message,
        localAssetIds: [...assetIds, "asset_revision_8"],
      }),
    ).toThrow();
    expect(() =>
      siteOpsSendMessageInputSchema.parse({
        ...message,
        localAssetIds: ["00000000-0000-4000-8000-000000000001"],
      }),
    ).toThrow();
    expect(() =>
      siteOpsSendMessageInputSchema.parse({
        ...message,
        localAssetIds: ["asset_duplicate", "asset_duplicate"],
      }),
    ).toThrow();

    expect(() =>
      siteOpsActInputSchema.parse({
        conversationId: "siteops:7",
        action: "pay_from_free_text",
        clientRequestId: "request-0002",
        expectedRevision: 1,
        input: {},
      }),
    ).toThrow();
  });

  it("keeps the customer build action free of API mode details", () => {
    const sampleId = "10000000-0000-4000-8000-000000000001";
    expect(parseSiteOpsActionPayload("select_visual", { sampleId })).toEqual({
      sampleId,
    });
    expect(parseSiteOpsActionPayload("delegate_visual", {})).toEqual({});
    expect(() =>
      parseSiteOpsActionPayload("select_visual", {
        sampleId,
        agentProfile: "frontmind-base",
      }),
    ).toThrow();
    expect(() =>
      parseSiteOpsActionPayload("delegate_visual", {
        agentProfile: "frontmind-pro",
      }),
    ).toThrow();
  });

  it("accepts server-selected knowledge binding while keeping old clients strict", () => {
    const snapshotId = "10000000-0000-4000-8000-000000000001";
    expect(parseSiteOpsActionPayload("select_snapshot", {})).toEqual({});
    expect(
      parseSiteOpsActionPayload("select_snapshot", {
        knowledgeSnapshotId: snapshotId,
      }),
    ).toEqual({ knowledgeSnapshotId: snapshotId });
    expect(() =>
      parseSiteOpsActionPayload("select_snapshot", {
        knowledgeSnapshotId: snapshotId,
        snapshotVersion: 7,
      }),
    ).toThrow();
  });

  it("rejects the legacy manual approval action before it can bypass atomic completion", () => {
    expect(() =>
      parseSiteOpsActionPayload("approve_build", {
        buildId: "10000000-0000-4000-8000-000000000001",
      }),
    ).toThrow("官网制作和检查完成后会自动批准");
  });

  it("accepts a concise rebuild request without technical coordinates", () => {
    expect(
      parseSiteOpsActionPayload("request_rebuild", {
        reason: "希望重新梳理首页叙事。",
      }),
    ).toEqual({ reason: "希望重新梳理首页叙事。" });
    expect(() =>
      parseSiteOpsActionPayload("request_rebuild", {
        reason: "重制",
        buildId: "10000000-0000-4000-8000-000000000001",
      }),
    ).toThrow();
  });

  it("keeps frozen build profiles and QA coordinates out of customer reads", () => {
    const projected = siteOpsBuildProjectionSchema.parse({
      id: "10000000-0000-4000-8000-000000000001",
      ordinal: 2,
      parentBuildId: null,
      status: "building",
      previewUrl: null,
      sourceUrl: null,
      needsHelp: false,
      createdAt: "2026-08-22T00:00:00.000Z",
      updatedAt: "2026-08-22T00:00:00.000Z",
    });
    expect(projected).not.toHaveProperty("agentProfile");
    expect(projected).not.toHaveProperty("qaUrl");
    expect(() =>
      siteOpsBuildProjectionSchema.parse({
        ...projected,
        agentProfile: "frontmind-base",
        qaUrl: "/internal/qa",
      }),
    ).toThrow();
  });

  it("keeps a parent build profile while rotating to the current customer credential", () => {
    expect(
      resolveSiteOpsAgentProfile({
        requested: "frontmind-base",
        credentialDefault: "frontmind-pro",
      }),
    ).toBe("frontmind-base");
    expect(
      resolveSiteOpsAgentProfile({
        parentOperationInput: { agentProfile: "frontmind-base" },
        credentialDefault: "frontmind-pro",
      }),
    ).toBe("frontmind-base");
    expect(
      resolveSiteOpsAgentProfile({ credentialDefault: "frontmind-base" }),
    ).toBe("frontmind-base");
    expect(resolveSiteOpsAgentProfile({ credentialDefault: null })).toBe(
      "frontmind-pro",
    );
    expect(
      freezeSiteOpsCustomerAiCredential({
        credential: {
          id: "20000000-0000-4000-8000-000000000002",
          version: 8,
          agentProfile: "frontmind-pro",
        },
        parentOperationInput: {
          agentProfile: "frontmind-base",
          manusCredentialId: "retired-credential",
        },
      }),
    ).toEqual({
      credentialScope: "customer",
      manusCredentialId: "20000000-0000-4000-8000-000000000002",
      manusCredentialVersion: 8,
      agentProfile: "frontmind-base",
    });
  });

  it("accepts only a selected Aliyun domain and normalizes its IDN identity", () => {
    expect(
      parseSiteOpsActionPayload("domain_sync", {
        domain: "例子.公司",
      }),
    ).toEqual({
      domain: "xn--fsqu00a.xn--55qx5d",
      domainUnicode: "例子.公司",
    });
    expect(() =>
      parseSiteOpsActionPayload("domain_sync", {
        domain: "example.com",
        typedDomain: "example.com",
      }),
    ).toThrow();
    expect(() =>
      parseSiteOpsActionPayload("domain_sync", {
        domain: "example.com",
        accessKeySecret: "must-not-be-accepted",
      }),
    ).toThrow();
  });

  it("keeps the Aliyun OAuth connection boundary free of account secrets", () => {
    expect(() =>
      siteOpsAliyunConnectionInputSchema.parse({
        conversationId: "siteops:7",
        accessKeySecret: "must-not-be-accepted",
      }),
    ).toThrow();
    expect(
      siteOpsAliyunConnectionInputSchema.parse({ conversationId: "siteops:7" }),
    ).toEqual({ conversationId: "siteops:7" });
  });

  it("pins a selected board to its original 21st credential after rotation or deletion", async () => {
    const visualOperationId = "10000000-0000-4000-8000-000000000001";
    const pinnedCredentialId = "20000000-0000-4000-8000-000000000002";
    const snapshotId = "30000000-0000-4000-8000-000000000003";
    const results = [
      [
        {
          input: {
            knowledgeSnapshotId: snapshotId,
            credentialId: pinnedCredentialId,
            credentialVersion: 7,
            workflowVersion: SITEOPS_DEFAULT_WORKFLOW.frontMindVersion,
          },
        },
      ],
      [{ id: pinnedCredentialId, version: 7, status: "deleted" }],
    ];
    let cursor = 0;
    const tx = {
      select: vi.fn(() => {
        const rows = results[cursor++] ?? [];
        const chain = {
          from: () => chain,
          where: () => chain,
          limit: async () => rows,
        };
        return chain;
      }),
    };

    await expect(
      resolvePinnedTwentyFirstCredentialForBatch(tx, {
        engineerNote: `siteops-21st-operation:${visualOperationId}`,
        projectId: "40000000-0000-4000-8000-000000000004",
        userId: 42,
        knowledgeSnapshotId: snapshotId,
        workflowVersion: SITEOPS_DEFAULT_WORKFLOW.frontMindVersion,
      }),
    ).resolves.toMatchObject({ id: pinnedCredentialId, version: 7 });
  });

  it.each(["reserved", "deploying", "verifying"] as const)(
    "rejects a second ESA admission while the same target is %s",
    async (status) => {
      const forUpdate = vi.fn().mockResolvedValue([
        {
          id: "10000000-0000-4000-8000-000000000001",
          buildId: "20000000-0000-4000-8000-000000000002",
          intent: "deploy",
          status,
        },
      ]);
      const tx = {
        select: vi.fn(() => ({
          from: vi.fn(() => ({
            where: vi.fn(() => ({
              limit: vi.fn(() => ({ for: forUpdate })),
            })),
          })),
        })),
      };

      await expect(
        assertSiteOpsDeploymentTargetAvailable(tx, {
          projectId: "30000000-0000-4000-8000-000000000003",
          target: "global_excluding_cn",
        }),
      ).rejects.toMatchObject({
        code: "STATE_CONFLICT",
        statusCode: 409,
      });
      expect(forUpdate).toHaveBeenCalledWith("update");
    },
  );

  it("admits an ESA target when no deployment is in flight", async () => {
    const forUpdate = vi.fn().mockResolvedValue([]);
    const tx = {
      select: vi.fn(() => ({
        from: vi.fn(() => ({
          where: vi.fn(() => ({
            limit: vi.fn(() => ({ for: forUpdate })),
          })),
        })),
      })),
    };

    await expect(
      assertSiteOpsDeploymentTargetAvailable(tx, {
        projectId: "30000000-0000-4000-8000-000000000003",
        target: "mainland_cn",
      }),
    ).resolves.toBeUndefined();
  });

  it("ships one contract migration that removes commerce and rebuilds the OAuth connection", async () => {
    const sql = await readFile(
      path.join(process.cwd(), "drizzle/0065_siteops_alidns_oauth.sql"),
      "utf8",
    );
    expect(sql).toContain("DROP TABLE `site_domain_operations`");
    expect(sql).toContain("DROP TABLE `site_provider_connections`");
    expect(sql).toContain("'domain_sync','dns_apply','dns_rollback'");
    expect(sql).toContain("`oauth_credential_id` varchar(36) NOT NULL");
    expect(sql).toContain("`encrypted_refresh_token` text NOT NULL");
    expect(sql).toContain("`status` enum('active','invalid','revoked')");
    expect(sql).toContain("`current_task_started_at` timestamp NOT NULL");
    expect(sql).toContain("`minimum_knowledge_snapshot_version` int unsigned");
    expect(sql).not.toContain("`active_financial_key`");
  });
});
