import { describe, expect, it } from "vitest";

import {
  assertKnowledgeBaseInitialImageDelivery,
  assertKnowledgeBaseNodeImageDelivery,
  assertKnowledgeBaseCustomerOutput,
  assertKnowledgeBaseUpstreamTaskIdentity,
  advanceKnowledgeBaseProtocolFailureObservation,
  classifyKnowledgeBaseUserAction,
  collectKnowledgeBaseInitialOutputImageDescriptors,
  collectKnowledgeBaseOutputImageKeys,
  collectKnowledgeBaseOutputImageResourceAliases,
  collectTrustedKnowledgeBaseOutputImageDescriptors,
  extractAuthoritativeKnowledgeBaseAssistantText,
  extractFinalKnowledgeBaseAssistantText,
  isIdempotentKnowledgeBaseReconcileError,
  isAmbiguousKnowledgeBaseAdvance,
  isKnowledgeBaseAcknowledgementOnlyOutput,
  knowledgeBaseObservationConversationStorageId,
  knowledgeBaseNodeBackedPresentationGeneration,
  knowledgeBaseAcceptedProviderAttemptMetadata,
  knowledgeBaseBuildRequiresApprovedReset,
  knowledgeBaseDeferredUploadProjection,
  knowledgeBaseMaterializedResultFailureNotice,
  knowledgeBaseMaterializedBusinessProjection,
  knowledgeBaseLogoProgressPolicy,
  knowledgeBaseOperationalFailureAuthority,
  knowledgeBasePackageProjectionCompatibility,
  knowledgeBasePublicTerminalRecovery,
  knowledgeBaseProtocolFailureShouldBecomeTerminal,
  knowledgeBaseProtocolErrorAllowsSameTaskRecovery,
  knowledgeBaseProtocolErrorIsRetryable,
  knowledgeBaseRejectedInitialLogoMatchesAuthority,
  knowledgeBaseStagedArtifactMatchesAuthority,
  knowledgeBaseSuccessfulTurnIdentity,
  projectKnowledgeBasePresentationMarkdown,
  selectKnowledgeBaseProtocolOperationOutput,
} from "./knowledge-base-progress-service";
import { KNOWLEDGE_BASE_MATERIALIZED_RESULT_RESET_MESSAGE } from "../shared/knowledge-base-progress";
import type {
  KnowledgeBaseRejectedInitialLogoDisposition,
  KnowledgeBaseStagedArtifactCandidate,
} from "./knowledge-base-artifact-binding-service";
import {
  formatKnowledgeBasePresentationEnvelope,
  formatKnowledgeBaseProgressEnvelope,
  KnowledgeBaseProgressError,
} from "./knowledge-base-progress";
import { stripKnowledgeBaseReferenceAppendix } from "../shared/knowledge-base-output";
import { KNOWLEDGE_BASE_MATERIALIZED_V5_SKILL_CONTENT_HASH } from "./knowledge-base-tree-policy-rollout";

describe("knowledge-base Logo progress policy", () => {
  const firstLeaf = {
    status: "confirming",
    confirmedCount: 0,
    directPrefilledCount: 0,
    currentOrdinal: 0,
    logoSha256: null,
  };

  it("keeps Logo optional for materialized v5 and exposes a bound Logo", () => {
    expect(
      knowledgeBaseLogoProgressPolicy({
        ...firstLeaf,
        executionMode: "materialized_bundle_v1",
        providerProtocol: "manus_v2",
        skillVersion: "5",
      }),
    ).toEqual({ logoRequired: false, logoAvailable: false });
    expect(
      knowledgeBaseLogoProgressPolicy({
        ...firstLeaf,
        executionMode: "materialized_bundle_v1",
        providerProtocol: "manus_v2",
        skillVersion: "5",
        logoSha256: "a".repeat(64),
      }),
    ).toEqual({ logoRequired: false, logoAvailable: true });
  });

  it("preserves the legacy v4 first-node Logo requirement", () => {
    expect(
      knowledgeBaseLogoProgressPolicy({
        ...firstLeaf,
        executionMode: null,
        providerProtocol: "legacy",
        skillVersion: "4",
      }),
    ).toEqual({ logoRequired: true, logoAvailable: false });
  });
});

describe("knowledge-base reset-only materialized authority", () => {
  const current = {
    executionMode: "materialized_bundle_v1",
    skillVersion: "5",
    skillContentHash: KNOWLEDGE_BASE_MATERIALIZED_V5_SKILL_CONTENT_HASH,
    providerProtocol: "manus_v2",
    contentVersion: 0,
    handoffProvenance: {
      materializedRecoveryContractVersion: 1,
      materializedCompletionContractVersion: 2,
    },
  } as any;

  it("accepts only a build born with the durable recovery contract marker", () => {
    expect(knowledgeBaseBuildRequiresApprovedReset(current)).toBe(false);
    expect(
      knowledgeBaseBuildRequiresApprovedReset({
        ...current,
        skillContentHash: "0".repeat(64),
      }),
    ).toBe(true);
    expect(
      knowledgeBaseBuildRequiresApprovedReset({
        ...current,
        handoffProvenance: null,
      }),
    ).toBe(true);
    expect(
      knowledgeBaseBuildRequiresApprovedReset({
        ...current,
        contentVersion: null,
      }),
    ).toBe(true);
    expect(
      knowledgeBaseBuildRequiresApprovedReset({
        ...current,
        handoffProvenance: {
          materializedRecoveryContractVersion: 1,
          materializedCompletionContractVersion: 2,
          sourceResetRevision: 4,
          authorizedAt: "2026-08-15T00:00:00.000Z",
        },
      }),
    ).toBe(false);
    expect(
      knowledgeBaseBuildRequiresApprovedReset({
        ...current,
        handoffProvenance: { materializedRecoveryContractVersion: 1 },
      }),
    ).toBe(true);
  });
});

describe("knowledge-base deferred upload projection", () => {
  const base = {
    awaitingClientAttachments: true,
    expectedAttachmentCount: 1,
    stagedAttachmentCount: 0,
  };

  it("projects a start reservation as neutral upload progress", () => {
    expect(
      knowledgeBaseDeferredUploadProjection({
        ...base,
        operationType: "start",
      }),
    ).toEqual({
      processingPhase: "uploading",
    });
  });

  it("projects a middle-node revise as neutral upload progress", () => {
    expect(
      knowledgeBaseDeferredUploadProjection({
        ...base,
        operationType: "revise",
      }),
    ).toEqual({
      processingPhase: "uploading",
    });
  });

  it("keeps partial k/n staging as neutral upload progress", () => {
    expect(
      knowledgeBaseDeferredUploadProjection({
        ...base,
        operationType: "revise",
        expectedAttachmentCount: 3,
        stagedAttachmentCount: 1,
      }),
    ).toEqual({ processingPhase: "uploading" });
  });

  it("keeps n/n staging in upload progress until dispatch releases the fence", () => {
    expect(
      knowledgeBaseDeferredUploadProjection({
        ...base,
        operationType: "revise",
        stagedAttachmentCount: 1,
      }),
    ).toEqual({ processingPhase: "uploading" });
  });
});

describe("knowledge-base rejected materialized result projection", () => {
  const terminalBuild = {
    activeTurnId: null,
    canonicalTaskState: "attention_required",
    generation: 6,
    protocolErrorCode: "KNOWLEDGE_BASE_MATERIALIZED_CONTRACT_INVALID",
    stateEpoch: 14,
    status: "protocol_error",
    updatedAt: new Date("2026-08-15T12:00:00.000Z"),
  } as any;

  it("exposes only the fixed approved-reset notice", () => {
    const notice = knowledgeBaseMaterializedResultFailureNotice(terminalBuild);
    expect(notice).toEqual({
      key: "materialized-result-reset:6:14",
      code: "KNOWLEDGE_BASE_MATERIALIZED_CONTRACT_INVALID",
      severity: "error",
      message: KNOWLEDGE_BASE_MATERIALIZED_RESULT_RESET_MESSAGE,
      retryable: false,
      failureClass: "requires_user_fix",
      recoveryAction: "approve_reset",
      canRegenerate: false,
      turnId: null,
      createdAt: Date.parse("2026-08-15T12:00:00.000Z"),
    });
    expect(JSON.stringify(notice)).not.toMatch(
      /(?:trace|sha256|provider|task[_-]?id|turn-[a-z0-9])/iu,
    );
  });

  it("does not project a recoverable or still-active result as terminal", () => {
    expect(
      knowledgeBaseMaterializedResultFailureNotice({
        ...terminalBuild,
        activeTurnId: "active-turn",
      }),
    ).toBeNull();
    expect(
      knowledgeBaseMaterializedResultFailureNotice({
        ...terminalBuild,
        protocolErrorCode: "RECOVERY_DEFERRED",
      }),
    ).toBeNull();
  });
});

describe("knowledge-base materialized business projection", () => {
  const progress = {
    build: { id: "build-v5" },
    contentAvailability: "partial",
    operationState: "creating",
    resetAllowed: false,
    warningCodes: [],
  } as any;

  it("uses durable acknowledgement rather than Provider terminal status", () => {
    expect(
      knowledgeBaseMaterializedBusinessProjection({
        progress,
        activeTurn: {
          upstreamTaskId: "task-v5",
          metadata: {
            createAttemptState: "acknowledged",
            providerAttemptState: "output_pending",
            materializedCompletion: {
              schemaVersion: 1,
              lastStatus: "stopped",
            },
          },
        } as any,
      }),
    ).toMatchObject({
      contentAvailability: "partial",
      operationState: "waiting_output",
      resetAllowed: false,
    });
  });

  it("projects a locally staged canonical candidate as normalization", () => {
    expect(
      knowledgeBaseMaterializedBusinessProjection({
        progress,
        activeTurn: {
          upstreamTaskId: "task-v5",
          metadata: {
            createAttemptState: "acknowledged",
            materializedCompletion: {
              schemaVersion: 1,
              storageKey: "working/candidate.zip",
              candidateArchiveSha256: "a".repeat(64),
            },
          },
        } as any,
      }).operationState,
    ).toBe("normalizing");
  });

  it.each(["unknown", "rejected"])(
    "opens approved reset for a %s create result without exposing a stopped state",
    (createAttemptState) => {
      expect(
        knowledgeBaseMaterializedBusinessProjection({
          progress,
          activeTurn: {
            upstreamTaskId: null,
            metadata: { createAttemptState },
          } as any,
        }),
      ).toMatchObject({
        operationState: "reset_required",
        resetAllowed: true,
        warningCodes: ["FRONTMIND_KB_RESET_REQUIRED"],
      });
    },
  );

  it("separates retained customer files from generated system attachments after pre-create settlement", () => {
    expect(
      knowledgeBaseMaterializedBusinessProjection({
        progress: {
          ...progress,
          contentAvailability: "none",
          operationState: "reset_required",
          resetAllowed: true,
        },
        lifecycleTurn: {
          upstreamTaskId: null,
          completedAt: new Date("2026-08-17T15:04:37.000Z"),
          metadata: {
            createAttemptState: "not_sent",
            providerAttemptState: "not_sent",
            failureStage: "provider_file_registration",
            userAttachmentCount: 9,
            expectedAttachmentCount: 11,
          },
        } as any,
      }),
    ).toMatchObject({
      contentAvailability: "none",
      operationState: "reset_required",
      resetAllowed: true,
      taskCreationState: "not_attempted",
      failureStage: "provider_file_registration",
      retainedCustomerAttachmentCount: 9,
      generatedSystemAttachmentCount: 2,
      settledAt: Date.parse("2026-08-17T15:04:37.000Z"),
    });
  });

  it("leaves a legacy DTO unchanged", () => {
    const legacy = { build: { id: "legacy" } } as any;
    expect(
      knowledgeBaseMaterializedBusinessProjection({ progress: legacy }),
    ).toBe(legacy);
  });
});

describe("knowledge-base replacement canonical presentation authority", () => {
  it("uses only the strictly matched historical receipt generation for retained node presentation", () => {
    const build = (
      createNewCanonicalFromSnapshot?: Record<string, unknown>,
    ): Parameters<typeof knowledgeBaseNodeBackedPresentationGeneration>[0] =>
      ({
        generation: 8,
        handoffProvenance: createNewCanonicalFromSnapshot
          ? { createNewCanonicalFromSnapshot }
          : null,
      }) as Parameters<typeof knowledgeBaseNodeBackedPresentationGeneration>[0];

    expect(
      knowledgeBaseNodeBackedPresentationGeneration(
        build({
          schemaVersion: 1,
          receiptSourceGeneration: 7,
          sourceGeneration: 7,
          targetGeneration: 8,
        }),
      ),
    ).toBe(7);
    expect(
      knowledgeBaseNodeBackedPresentationGeneration(
        build({
          schemaVersion: 1,
          receiptSourceGeneration: 6,
          sourceGeneration: 7,
          targetGeneration: 8,
        }),
      ),
    ).toBe(6);

    for (const marker of [
      undefined,
      {
        schemaVersion: 1,
        sourceGeneration: 7,
        targetGeneration: 9,
      },
      {
        schemaVersion: 1,
        sourceGeneration: 6,
        targetGeneration: 8,
      },
      {
        schemaVersion: 1,
        sourceGeneration: "7",
        targetGeneration: 8,
      },
      {
        schemaVersion: 1,
        receiptSourceGeneration: "6",
        sourceGeneration: 7,
        targetGeneration: 8,
      },
      {
        schemaVersion: 1,
        sourceGeneration: 8,
        targetGeneration: 8,
      },
    ]) {
      expect(knowledgeBaseNodeBackedPresentationGeneration(build(marker))).toBe(
        8,
      );
    }
  });
});

describe("knowledge-base public terminal recovery", () => {
  const build = (action: string, overrides: Record<string, unknown> = {}) =>
    ({
      activeTurnId: null,
      canonicalTaskState: "attention_required",
      status: "protocol_error",
      generation: 3,
      stateEpoch: 9,
      revision: 7,
      currentLeafId: "1.8",
      currentPresentationKey: "presentation-7",
      handoffProvenance: {
        terminalRecovery: {
          schemaVersion: 1,
          action,
          sourceTurnId: "private-source-turn",
          sourceCredentialIdSha256: "c".repeat(64),
          sourceGeneration: 3,
          sourceStateEpoch: 9,
          sourceRevision: 7,
          sourceLeafId: "1.8",
          sourcePresentationKey: "presentation-7",
          recoveryStateSha256: "a".repeat(64),
          normalizedAt: "2026-08-14T01:00:00.000Z",
        },
      },
      ...overrides,
    }) as any;

  it.each([
    ["retry_compatible_create", "retry_request"],
    ["create_new_canonical_from_snapshot", "start_new_generation"],
    ["stopped", "stopped"],
  ])("maps %s without exposing private coordinates", (internal, action) => {
    expect(knowledgeBasePublicTerminalRecovery(build(internal))).toEqual({
      action,
      recoveryToken: "a".repeat(64),
    });
  });

  it("keeps a cleared writer stable and rejects stale recovery state", () => {
    expect(
      knowledgeBasePublicTerminalRecovery(
        build("retry_compatible_create", { stateEpoch: 10 }),
      ),
    ).toBeNull();
    expect(
      knowledgeBasePublicTerminalRecovery(
        build("retry_compatible_create", { activeTurnId: "new-turn" }),
      ),
    ).toBeNull();
  });
});

describe("knowledge-base structured-result acceptance metadata", () => {
  it.each(["sending", "output_pending"])(
    "accepts a Manus v2 %s ledger without dropping sibling fields",
    (providerAttemptState) => {
      const metadata = {
        providerProtocol: "manus_v2",
        providerAttemptState,
        providerMethod: "task.sendMessage",
        operationToken: "operation-1",
        lastSeenEventIds: ["event-1", "event-2"],
        manusV2Lifecycle: { waitingEventId: "event-waiting" },
        recovery: { outputCursor: 7 },
      };

      expect(knowledgeBaseAcceptedProviderAttemptMetadata(metadata)).toEqual({
        ...metadata,
        providerAttemptState: "accepted",
      });
      expect(metadata.providerAttemptState).toBe(providerAttemptState);
    },
  );

  it.each([
    { recovery: { legacy: true } },
    { providerProtocol: "legacy_v1", providerAttemptState: "sending" },
    { providerProtocol: "manus_v2", providerAttemptState: "not_sent" },
    { providerProtocol: "manus_v2", providerAttemptState: "acknowledged" },
    { providerProtocol: "manus_v2", providerAttemptState: "accepted" },
    { providerProtocol: "manus_v2", providerAttemptState: "rejected" },
    { providerProtocol: "manus_v2", providerAttemptState: "outcome_unknown" },
    { providerProtocol: "manus_v2", providerAttemptState: "unknown" },
  ])("does not rewrite legacy or non-pending metadata %#", (metadata) => {
    expect(knowledgeBaseAcceptedProviderAttemptMetadata(metadata)).toBe(
      undefined,
    );
  });
});

describe("knowledge-base 0061 package/content dual-read", () => {
  const completedAt = new Date("2026-07-31T12:00:00.000Z");
  const updatedAt = new Date("2026-08-01T12:00:00.000Z");
  const legacyPackage = {
    id: "build-legacy-package",
    status: "ready_to_publish" as const,
    revision: 41,
    canonicalTaskId: null,
    upstreamTaskId: "task-legacy",
    packageStatus: "not_started",
    packageRevision: 41,
    packageTaskId: "task-legacy",
    packageOutputItemId: "output-legacy",
    packageFileId: "file-legacy",
    packageFilename: "legacy.zip",
    packageDescriptorHash: "d".repeat(64),
    packageStorageKey: "knowledge-builds/legacy/package.zip",
    packageArchiveSha256: "a".repeat(64),
    packageSizeBytes: 123_456,
    contentCompletedAt: null,
    completedAt,
    updatedAt,
  };

  it("keeps a complete pre-0061 durable package visible without a data backfill", () => {
    const projected =
      knowledgeBasePackageProjectionCompatibility(legacyPackage);

    expect(projected).toMatchObject({
      contentCompleted: true,
      contentCompletedAt: completedAt,
      packageAllowed: true,
      packageState: "ready",
      package: {
        revision: 41,
        outputItemId: "output-legacy",
        fileId: "file-legacy",
        filename: "legacy.zip",
        mimeType: "application/zip",
        sha256: "a".repeat(64),
        sizeBytes: 123_456,
        downloadPath:
          "/api/knowledge-base/artifacts/build-legacy-package/package",
      },
    });
  });

  it("uses updatedAt only as the final completion fallback for a terminal legacy build", () => {
    const projected = knowledgeBasePackageProjectionCompatibility({
      ...legacyPackage,
      status: "published",
      packageStatus: null as never,
      completedAt: null,
    });

    expect(projected.contentCompleted).toBe(true);
    expect(projected.contentCompletedAt).toEqual(updatedAt);
    expect(projected.packageAllowed).toBe(true);
    expect(projected.packageState).toBe("ready");
  });

  it("never exposes a current preparing package, even if stale package fields remain", () => {
    const projected = knowledgeBasePackageProjectionCompatibility({
      ...legacyPackage,
      packageStatus: "preparing",
      contentCompletedAt: updatedAt,
    });

    expect(projected.contentCompleted).toBe(true);
    expect(projected.packageAllowed).toBe(false);
    expect(projected.packageState).toBe("preparing");
    expect(projected.package).toBeNull();
  });

  it("does not treat an incomplete not_started tuple as a legacy package", () => {
    const projected = knowledgeBasePackageProjectionCompatibility({
      ...legacyPackage,
      packageStorageKey: null,
      packageArchiveSha256: null,
      packageSizeBytes: null,
    });

    expect(projected.contentCompleted).toBe(true);
    expect(projected.packageAllowed).toBe(false);
    expect(projected.packageState).toBe("not_started");
    expect(projected.package).toBeNull();
  });
});

describe("knowledge-base notice recovery contract", () => {
  it("offers a direct retry only when a valid recovery path exists", () => {
    expect(
      knowledgeBaseProtocolErrorIsRetryable({
        status: "protocol_error",
        code: "PROGRESS_PROTOCOL_INVALID",
        activeTurnId: "turn-1",
      }),
    ).toBe(true);
    expect(
      knowledgeBaseProtocolErrorIsRetryable({
        status: "protocol_error",
        code: "PACKAGE_REBIND_REQUIRED",
        activeTurnId: null,
      }),
    ).toBe(true);
    for (const code of [
      "LEGACY_TASK_REBIND_REQUIRED",
      "LEGACY_CREDENTIAL_REBIND_REQUIRED",
      "UPSTREAM_CREATE_3",
      "UPSTREAM_CREATE_HTTP_400",
    ]) {
      expect(
        knowledgeBaseProtocolErrorIsRetryable({
          status: "protocol_error",
          code,
          activeTurnId: null,
        }),
      ).toBe(false);
    }
    expect(
      knowledgeBaseProtocolErrorIsRetryable({
        status: "protocol_error",
        code: "PROGRESS_PROTOCOL_INVALID",
        activeTurnId: null,
      }),
    ).toBe(false);
  });

  it("only rereads the original task for recoverable package states", () => {
    expect(
      knowledgeBaseProtocolErrorAllowsSameTaskRecovery("FINAL_PACKAGE_MISSING"),
    ).toBe(true);
    expect(
      knowledgeBaseProtocolErrorAllowsSameTaskRecovery(
        "PACKAGE_REBIND_REQUIRED",
      ),
    ).toBe(true);
    expect(
      knowledgeBaseProtocolErrorAllowsSameTaskRecovery(
        "PROGRESS_PROTOCOL_INVALID",
      ),
    ).toBe(false);
  });
});

describe("knowledge-base persisted identity boundaries", () => {
  it("preserves a 255-character task identity and rejects 256 characters", () => {
    const maximum = "t".repeat(255);
    expect(assertKnowledgeBaseUpstreamTaskIdentity(maximum)).toBe(maximum);
    expect(() =>
      assertKnowledgeBaseUpstreamTaskIdentity("t".repeat(256)),
    ).toThrow("拒绝截断");
    expect(() => assertKnowledgeBaseUpstreamTaskIdentity(" task-1 ")).toThrow(
      "首尾空白",
    );
    expect(() => assertKnowledgeBaseUpstreamTaskIdentity("   ", false)).toThrow(
      "首尾空白",
    );
    expect(() =>
      assertKnowledgeBaseUpstreamTaskIdentity(Number.MAX_SAFE_INTEGER + 1),
    ).toThrow("无法无损表示");
  });

  it("rejects overlong or conflicting image file identities", () => {
    expect(() =>
      collectTrustedKnowledgeBaseOutputImageDescriptors({
        type: "output_image",
        file_id: "f".repeat(256),
        filename: "logo.png",
        mime_type: "image/png",
      }),
    ).toThrow("超过 255 个字符");
    expect(() =>
      collectTrustedKnowledgeBaseOutputImageDescriptors({
        type: "output_image",
        file_id: "file-a",
        fileId: "file-b",
        filename: "logo.png",
        mime_type: "image/png",
      }),
    ).toThrow("别名字段相互冲突");
  });
});

describe("knowledge-base user action classification", () => {
  it("treats old/future revisions as idempotent observations", () => {
    expect(
      isIdempotentKnowledgeBaseReconcileError(
        new KnowledgeBaseProgressError("STALE_REVISION", "old revision"),
      ),
    ).toBe(true);
    expect(
      isIdempotentKnowledgeBaseReconcileError(
        new KnowledgeBaseProgressError("WRONG_LEAF", "wrong current leaf"),
      ),
    ).toBe(false);
  });

  it("only advances on an explicit confirmation", () => {
    expect(classifyKnowledgeBaseUserAction("确认")).toBe("confirm");
    expect(classifyKnowledgeBaseUserAction("OK!")).toBe("confirm");
    expect(classifyKnowledgeBaseUserAction("确认，但请补充海外渠道")).toBe(
      "revise",
    );
    expect(classifyKnowledgeBaseUserAction("补充海外渠道后继续")).toBe(
      "revise",
    );
  });

  it("keeps direct prefill distinct and treats uploads as revisions", () => {
    expect(classifyKnowledgeBaseUserAction("直接预填")).toBe("direct_prefill");
    expect(classifyKnowledgeBaseUserAction("跳过。")).toBe("direct_prefill");
    expect(classifyKnowledgeBaseUserAction("", 1)).toBe("revise");
    expect(classifyKnowledgeBaseUserAction("确认", 1)).toBe("revise");
    expect(classifyKnowledgeBaseUserAction("", 0)).toBe("initial");
  });

  it("does not interpret an ambiguous standalone continuation as confirmation", () => {
    expect(isAmbiguousKnowledgeBaseAdvance("继续")).toBe(true);
    expect(isAmbiguousKnowledgeBaseAdvance("下一步！")).toBe(true);
    expect(isAmbiguousKnowledgeBaseAdvance("补充后继续")).toBe(false);
    expect(classifyKnowledgeBaseUserAction("继续")).toBe("revise");
  });
});

describe("knowledge-base model output boundary", () => {
  it("classifies a terminal receipt as a retryable protocol failure, never content", () => {
    expect(
      isKnowledgeBaseAcknowledgementOnlyOutput([
        { role: "assistant", type: "message", content: "已收到。" },
      ]),
    ).toBe(true);
    expect(
      isKnowledgeBaseAcknowledgementOnlyOutput([
        {
          role: "assistant",
          type: "message",
          content: "## 1.1 一句话定位\n完整知识库正文",
        },
      ]),
    ).toBe(false);
  });

  it("projects only the presentation leaf and removes the prior confirmation", () => {
    const projected = projectKnowledgeBasePresentationMarkdown({
      markdown: [
        "1.1 一句话定位已确认。",
        "",
        "## 1.2 公司主体与基本概况",
        "",
        "北京硅基流动科技股份有限公司。   ",
        "",
        "### 企业形态",
        "",
        "同时提供云服务与本地部署。",
        "",
        "## 1.3 使命、愿景与企业主张",
        "不属于本轮的正文。",
      ].join("\r\n"),
      leafId: "1.2",
      leafTitle: "公司主体与基本概况",
      leafIds: ["1.1", "1.2", "1.3"],
    });

    expect(projected).toBe(
      [
        "## 1.2 公司主体与基本概况",
        "",
        "北京硅基流动科技股份有限公司。",
        "",
        "### 企业形态",
        "",
        "同时提供云服务与本地部署。",
      ].join("\n"),
    );
    expect(projected).not.toContain("1.1 一句话定位已确认");
    expect(projected).not.toContain("1.3 使命");
  });

  it("adds the authoritative leaf heading to a unique heading-less body", () => {
    expect(
      projectKnowledgeBasePresentationMarkdown({
        markdown: "1.1 已确认。\n\n唯一的下一节点正文。",
        leafId: "1.2",
        leafTitle: "公司主体",
        leafIds: ["1.1", "1.2"],
      }),
    ).toBe("## 1.2 公司主体\n\n唯一的下一节点正文。");
  });

  it("never guesses leaf ids from product, standard, or API headings", () => {
    for (const heading of [
      "GMS-11A",
      "GMS_11A",
      "ISO-9001",
      "API-V2",
      "SKU.2026",
    ]) {
      expect(
        projectKnowledgeBasePresentationMarkdown({
          markdown: `### ${heading}\n\n产品或标准说明。`,
          leafId: "3.8",
          leafTitle: "产品能力",
          leafIds: ["3.7", "3.8", "3.9"],
        }),
      ).toBe(`## 3.8 产品能力\n\n### ${heading}\n\n产品或标准说明。`);
    }
  });

  it("rejects duplicate sections and a title that drifted from the manifest", () => {
    expect(() =>
      projectKnowledgeBasePresentationMarkdown({
        markdown: "## 1.2 公司主体\nA\n\n## 1.2 公司主体\nB",
        leafId: "1.2",
        leafTitle: "公司主体",
        leafIds: ["1.1", "1.2"],
      }),
    ).toThrow("重复包含节点 1.2");
    expect(() =>
      projectKnowledgeBasePresentationMarkdown({
        markdown: "## 1.2 错误标题\n正文",
        leafId: "1.2",
        leafTitle: "公司主体",
        leafIds: ["1.1", "1.2"],
      }),
    ).toThrow("标题与知识树不一致");
  });

  it("keeps source appendices out of the customer-visible node body", () => {
    const output = [
      {
        role: "assistant",
        type: "message",
        content: [
          "节点正文",
          "",
          "**参考资料**",
          "[1] https://siliconflow.cn/",
          '<!-- FRONTMIND_KB_PROGRESS {"revision":0} -->',
        ].join("\n"),
      },
    ];

    const raw = assertKnowledgeBaseCustomerOutput(output);
    expect(raw).toContain("FRONTMIND_KB_PROGRESS");
    expect(stripKnowledgeBaseReferenceAppendix(raw)).toBe("节点正文");
  });

  it("uses only the final typed assistant message", () => {
    expect(
      extractFinalKnowledgeBaseAssistantText([
        {
          role: "assistant",
          type: "message",
          content: "较早的 assistant 内容",
        },
        {
          type: "reasoning",
          text: "内部推理不能进入知识库状态机",
        },
        {
          role: "assistant",
          type: "output_message",
          content: [
            {
              type: "output_text",
              text: { value: "最终合法 assistant 内容" },
            },
            {
              type: "output_file",
              file_id: "knowledge-base.zip",
            },
          ],
        },
      ]),
    ).toBe("最终合法 assistant 内容");
  });

  it("keeps the newest protocol response authoritative when plain assistant text follows", () => {
    const protocol = [
      "## 1.2 公司主体与基本概况",
      "节点正文",
      '<!-- FRONTMIND_KB_PROGRESS {"kind":"frontmind.knowledge-base.progress","schemaVersion":1,"revision":0,"transition":{"leafId":"1.1","from":"current","to":"confirmed"}} -->',
      '<!-- FRONTMIND_KB_PRESENTATION {"kind":"frontmind.knowledge-base.presentation","schemaVersion":1,"revision":1,"leafId":"1.2","imageState":"no_eligible_asset","assetIds":[],"imageCount":0} -->',
    ].join("\n");
    const full = [
      { role: "assistant", type: "message", content: "older turn" },
      { role: "assistant", type: "output_message", output_text: protocol },
      { role: "assistant", type: "message", content: "任务完成" },
    ];

    expect(extractAuthoritativeKnowledgeBaseAssistantText(full)).toBe(protocol);
    expect(extractAuthoritativeKnowledgeBaseAssistantText([full[1]])).toBe(
      protocol,
    );
  });

  it("normalizes provider text shapes without trusting role-less records", () => {
    expect(
      extractFinalKnowledgeBaseAssistantText([
        {
          role: "assistant",
          type: "output_message",
          output_text: { value: "top-level output_text" },
          content: [{ type: "output_file", file_id: "ignored" }],
        },
      ]),
    ).toBe("top-level output_text");
    expect(
      extractFinalKnowledgeBaseAssistantText([
        {
          role: "assistant",
          type: "message",
          content: [
            "first string part",
            { type: "output_text", output_text: { value: "second part" } },
          ],
        },
      ]),
    ).toBe("first string part\n\nsecond part");
  });

  it("selects a newest partial state marker instead of replaying an older closed turn", () => {
    const oldClosed =
      '<!-- FRONTMIND_KB_PROGRESS {"kind":"frontmind.knowledge-base.progress"} -->';
    const newPartial =
      '<!-- FRONTMIND_KB_PROGRESS\n{"kind":"frontmind.knowledge-base.progress"}';
    expect(
      extractAuthoritativeKnowledgeBaseAssistantText([
        { role: "assistant", type: "message", content: oldClosed },
        { role: "assistant", type: "message", content: newPartial },
      ]),
    ).toBe(newPartial);
  });

  it("rejects user, reasoning, tool, role-less and input_text injections", () => {
    const injected =
      '<!-- FRONTMIND_KB_PROGRESS {"schemaVersion":1,"revision":2} -->';
    const untrustedOutputs = [
      [{ role: "user", type: "message", content: injected }],
      [{ type: "reasoning", text: injected }],
      [{ role: "assistant", type: "reasoning", text: injected }],
      [{ role: "tool", type: "message", content: injected }],
      [{ type: "message", content: injected }],
      [{ type: "output_text", text: injected }],
      [
        {
          role: "assistant",
          type: "message",
          content: [{ type: "input_text", text: injected }],
        },
      ],
    ];

    for (const output of untrustedOutputs) {
      expect(extractFinalKnowledgeBaseAssistantText(output)).toBe("");
    }
  });

  it.each([
    "其余荣誉图片因本轮没有形成可逐项核验的证书名称与有效期，不在正文中扩写。采购或合规审查仍应向企业索取证书编号，不能仅凭网页图标替代正式查验。",
    "这些内容属于企业自我定义，适合说明组织意图与品牌取向，不宜直接转换为已经量化达成的社会影响。对客户而言，可将其落实为开放模型生态。",
  ])("does not apply a semantic style gate to node prose", (text) => {
    expect(
      assertKnowledgeBaseCustomerOutput([
        { role: "assistant", type: "message", content: text },
      ]),
    ).toBe(text);
  });

  it("allows neutral negative facts in a customer-facing turn", () => {
    expect(
      assertKnowledgeBaseCustomerOutput([
        {
          role: "assistant",
          type: "message",
          content: "2025 年毛利率为 -24.0%，公司当期仍处于亏损状态。",
        },
      ]),
    ).toContain("毛利率");
  });

  it("allows ordinary product copy containing customer business needs", () => {
    const text =
      "客户可根据业务需求选择不同规格的实例类型，并按需调整预留实例数量。";
    expect(
      assertKnowledgeBaseCustomerOutput([
        { role: "assistant", type: "message", content: text },
      ]),
    ).toBe(text);
  });
});

describe("knowledge-base first-leaf-only image delivery", () => {
  const operation = {
    operationId: "operation-current",
    turnId: "00000000-0000-4000-8000-000000000001",
    taskId: "task-current",
    generation: 2,
  };
  const manifestMessage = (operationId: string, turnId: string) => ({
    role: "assistant",
    type: "output_message",
    content: `首轮正文\n<!-- FRONTMIND_KB_MANIFEST\n${JSON.stringify({
      kind: "frontmind.knowledge-base.manifest",
      schemaVersion: 2,
      operationId,
      turnId,
      leaves: [{ id: "1.1", title: "一句话定位" }],
    })}\n-->`,
  });
  const presentation = {
    kind: "frontmind.knowledge-base.presentation" as const,
    schemaVersion: 1 as const,
    revision: 3,
    leafId: "product.api",
    imageState: "attached" as const,
    assetIds: ["asset-product-api"],
    imageCount: 1,
  };

  it("counts snake-case and camel-case managed image outputs once", () => {
    expect(
      collectKnowledgeBaseOutputImageKeys([
        {
          role: "assistant",
          type: "message",
          content: [
            {
              type: "output_image",
              file_id: "image-1",
              file_name: "api.webp",
            },
          ],
        },
        {
          type: "output_file",
          fileId: "image-2",
          fileName: "diagram.png",
        },
      ]),
    ).toEqual(new Set(["image-1", "image-2"]));
  });

  it("authorizes both aliases without double-counting one image", () => {
    const output = [
      {
        type: "output_image",
        file_id: "image-1",
        image_url: "https://cdn.example.test/image-1.webp?token=1",
        file_name: "image-1.webp",
      },
    ];

    expect(collectKnowledgeBaseOutputImageKeys(output)).toEqual(
      new Set(["image-1"]),
    );
    expect(collectKnowledgeBaseOutputImageResourceAliases(output)).toEqual(
      new Set(["image-1", "https://cdn.example.test/image-1.webp?token=1"]),
    );
  });

  it("deduplicates nested file-id and top-level URL projections of one Logo", () => {
    const url = "https://cdn.example.test/logo.webp?signature=one";
    const output = [
      {
        role: "assistant",
        type: "message",
        content: [
          {
            type: "output_image",
            file_id: "logo-file-1",
            image_url: url,
            file_name: "logo.webp",
          },
        ],
      },
      {
        type: "output_image",
        image_url: url,
        file_name: "logo.webp",
      },
    ];
    expect(collectKnowledgeBaseOutputImageKeys(output)).toEqual(
      new Set(["logo-file-1"]),
    );
    expect(() => assertKnowledgeBaseInitialImageDelivery(output)).not.toThrow();
  });

  it("accepts the active operation Logo when its descriptor precedes the Manifest item", () => {
    const output = [
      {
        type: "output_image",
        file_id: "logo-current",
        file_name: "logo.png",
      },
      manifestMessage(operation.operationId, operation.turnId),
    ];

    expect(() =>
      assertKnowledgeBaseInitialImageDelivery(output, operation),
    ).not.toThrow();
  });

  it("accepts the Furuili 46-leaf typed Logo bundle despite a redundant Markdown Logo", () => {
    const leaves = Array.from({ length: 46 }, (_, index) => ({
      id: `${Math.floor(index / 7) + 1}.${(index % 7) + 1}`,
      title: `孚锐利业务节点 ${index + 1}`,
      branchId: `branch-${Math.floor(index / 7) + 1}`,
      branchTitle: `业务维度 ${Math.floor(index / 7) + 1}`,
    }));
    const customerMarkdown = [
      "## 企业身份 / 一句话定位",
      "孚锐利面向乳制品企业提供设备、软件与服务。",
      "![孚锐利官方 Logo](furuili_official_logo.png)",
    ].join("\n\n");
    const output = [
      {
        type: "output_image",
        file_id: "furuili-official-logo",
        file_name: "furuili_official_logo.png",
        // The binding layer trusts decoded bytes, not this model declaration.
        mime_type: "application/octet-stream",
      },
      {
        role: "assistant",
        type: "output_message",
        content: `${customerMarkdown}\n<!-- FRONTMIND_KB_MANIFEST\n${JSON.stringify(
          {
            kind: "frontmind.knowledge-base.manifest",
            schemaVersion: 2,
            operationId: operation.operationId,
            turnId: operation.turnId,
            leaves,
          },
        )}\n-->`,
      },
    ];

    expect(() =>
      assertKnowledgeBaseInitialImageDelivery(output, operation),
    ).not.toThrow();
    const visible = projectKnowledgeBasePresentationMarkdown({
      markdown: customerMarkdown,
      leafId: leaves[0]!.id,
      leafTitle: leaves[0]!.title,
      leafIds: leaves.map((leaf) => leaf.id),
    });
    expect(visible).toContain("孚锐利面向乳制品企业提供设备、软件与服务");
    expect(visible).not.toContain("![孚锐利官方 Logo]");
    expect(leaves).toHaveLength(46);
  });

  it("deduplicates nested and top-level projections within the active Manifest operation", () => {
    const assistant: any = manifestMessage(
      operation.operationId,
      operation.turnId,
    );
    assistant.content = [
      { type: "output_text", text: assistant.content },
      {
        type: "output_image",
        file_id: "logo-current",
        image_url: "https://cdn.example.test/logo.png?one",
        file_name: "logo.png",
      },
    ];
    const output = [
      assistant,
      {
        type: "output_image",
        file_id: "logo-current",
        image_url: "https://cdn.example.test/logo.png?two",
        file_name: "logo.png",
      },
    ];

    expect(() =>
      assertKnowledgeBaseInitialImageDelivery(output, operation),
    ).not.toThrow();
  });

  it("never treats user/tool/reasoning/input images as model resources", () => {
    expect(
      collectKnowledgeBaseOutputImageKeys([
        {
          role: "user",
          type: "output_image",
          file_id: "user-image",
        },
        {
          role: "tool",
          type: "output_image",
          file_id: "tool-image",
        },
        {
          role: "assistant",
          type: "reasoning_image",
          file_id: "reasoning-image",
        },
        {
          role: "assistant",
          type: "input_image",
          file_id: "input-image",
        },
      ]),
    ).toEqual(new Set());
  });

  it("excludes old operations and explicit stale task/generation descriptors", () => {
    const output = [
      manifestMessage("operation-old", "00000000-0000-4000-8000-000000000099"),
      {
        type: "output_image",
        file_id: "logo-old",
        file_name: "old.png",
      },
      {
        type: "output_image",
        file_id: "logo-current",
        file_name: "current.png",
      },
      manifestMessage(operation.operationId, operation.turnId),
      {
        type: "output_image",
        file_id: "logo-stale-task",
        file_name: "stale.png",
        task_id: "task-old",
        build_generation: 1,
      },
    ];
    const scoped = selectKnowledgeBaseProtocolOperationOutput(output, {
      ...operation,
      stateKind: "frontmind.knowledge-base.manifest",
    });

    expect(collectKnowledgeBaseOutputImageKeys(scoped)).toEqual(
      new Set(["logo-current"]),
    );
    expect(() =>
      assertKnowledgeBaseInitialImageDelivery(output, operation),
    ).not.toThrow();
  });

  it("rejects padded protocol and resource identity claims instead of trimming them", () => {
    const paddedAnchorOutput = [
      {
        type: "output_image",
        file_id: "logo-before-padded-anchor",
        file_name: "logo.png",
      },
      manifestMessage(` ${operation.operationId}`, operation.turnId),
    ];
    expect(
      selectKnowledgeBaseProtocolOperationOutput(paddedAnchorOutput, {
        ...operation,
        stateKind: "frontmind.knowledge-base.manifest",
      }),
    ).toEqual([]);

    const paddedResourceOutput = [
      manifestMessage(operation.operationId, operation.turnId),
      {
        role: "assistant",
        type: "output_image",
        operationId: operation.operationId,
        turnId: operation.turnId,
        taskId: ` ${operation.taskId}`,
        buildGeneration: operation.generation,
        file_id: "logo-with-padded-task",
        file_name: "logo.png",
      },
    ];
    expect(
      collectKnowledgeBaseOutputImageKeys(
        selectKnowledgeBaseProtocolOperationOutput(paddedResourceOutput, {
          ...operation,
          stateKind: "frontmind.knowledge-base.manifest",
        }),
      ),
    ).toEqual(new Set());
  });

  it("selects only the active final ZIP when a cumulative snapshot contains an older operation", () => {
    const oldOperation = {
      operationId: "operation-old-final",
      turnId: "00000000-0000-4000-8000-000000000098",
    };
    const progressFor = (identity: typeof operation, revision: number) =>
      formatKnowledgeBaseProgressEnvelope({
        kind: "frontmind.knowledge-base.progress",
        schemaVersion: 2,
        operationId: identity.operationId,
        turnId: identity.turnId,
        revision,
        transition: {
          leafId: `leaf-${revision}`,
          from: "current",
          to: "confirmed",
          reason: "用户明确确认",
        },
      });
    const output = [
      {
        id: "old-final-operation",
        type: "output_message",
        role: "assistant",
        content: [
          { type: "output_text", text: progressFor(oldOperation, 7) },
          {
            type: "output_file",
            file_id: "file-old-final-package",
            file_name: "old.zip",
            mime_type: "application/zip",
          },
        ],
      },
      {
        id: "active-final-operation",
        type: "output_message",
        role: "assistant",
        content: [
          { type: "output_text", text: progressFor(operation, 8) },
          {
            type: "output_file",
            file_id: "file-active-final-package",
            file_name: "current.zip",
            mime_type: "application/zip",
          },
        ],
      },
    ];

    const scoped = selectKnowledgeBaseProtocolOperationOutput(
      output,
      {
        ...operation,
        stateKind: "frontmind.knowledge-base.progress",
      },
      { requireExplicitResourceOperation: true },
    );

    expect(scoped).toHaveLength(1);
    expect(JSON.stringify(scoped)).toContain("file-active-final-package");
    expect(JSON.stringify(scoped)).not.toContain("file-old-final-package");
  });

  it("keeps an explicitly scoped non-ZIP resource in the final operation window", () => {
    const progress = formatKnowledgeBaseProgressEnvelope({
      kind: "frontmind.knowledge-base.progress",
      schemaVersion: 2,
      operationId: operation.operationId,
      turnId: operation.turnId,
      revision: 8,
      transition: {
        leafId: "leaf-8",
        from: "current",
        to: "confirmed",
        reason: "用户明确确认",
      },
    });
    const output = [
      {
        role: "assistant",
        type: "output_message",
        content: [
          { type: "output_text", text: progress },
          {
            type: "output_file",
            file_id: "file-current-final-package",
            file_name: "current.zip",
            mime_type: "application/zip",
          },
        ],
      },
      {
        role: "assistant",
        type: "output_file",
        operationId: operation.operationId,
        turnId: operation.turnId,
        file_id: "file-extra-pdf",
        file_name: "extra.pdf",
        mime_type: "application/pdf",
      },
    ];

    const scoped = selectKnowledgeBaseProtocolOperationOutput(
      output,
      {
        ...operation,
        stateKind: "frontmind.knowledge-base.progress",
      },
      { requireExplicitResourceOperation: true },
    );
    expect(JSON.stringify(scoped)).toContain("file-extra-pdf");
  });

  it("does not attribute a late unscoped ZIP by proximity", () => {
    const progress = formatKnowledgeBaseProgressEnvelope({
      kind: "frontmind.knowledge-base.progress",
      schemaVersion: 2,
      operationId: operation.operationId,
      turnId: operation.turnId,
      revision: 8,
      transition: {
        leafId: "leaf-8",
        from: "current",
        to: "confirmed",
        reason: "用户明确确认",
      },
    });
    const output = [
      {
        role: "assistant",
        type: "output_message",
        content: [{ type: "output_text", text: progress }],
      },
      {
        type: "output_file",
        file_id: "late-old-package",
        file_name: "old.zip",
        mime_type: "application/zip",
      },
    ];
    const scoped = selectKnowledgeBaseProtocolOperationOutput(
      output,
      {
        ...operation,
        stateKind: "frontmind.knowledge-base.progress",
      },
      { requireExplicitResourceOperation: true },
    );
    expect(scoped).toHaveLength(1);
    expect(JSON.stringify(scoped)).not.toContain("package");
  });

  it("rejects image attachments on every non-initial node turn", () => {
    expect(() =>
      assertKnowledgeBaseNodeImageDelivery({
        presentation,
        output: [
          {
            type: "output_image",
            file_id: "image-1",
            file_name: "api.webp",
          },
        ],
      }),
    ).toThrow("图片只允许在首轮第一个节点展示");
  });

  it("rejects an active-turn image descriptor placed before its Progress and Presentation", () => {
    const operationPresentation = {
      ...presentation,
      schemaVersion: 2 as const,
      operationId: operation.operationId,
      turnId: operation.turnId,
    };
    const progress = formatKnowledgeBaseProgressEnvelope({
      kind: "frontmind.knowledge-base.progress",
      schemaVersion: 2,
      operationId: operation.operationId,
      turnId: operation.turnId,
      revision: 2,
      transition: {
        leafId: "product.api",
        from: "current",
        to: "confirmed",
        reason: "用户明确确认",
      },
    });
    const presentationText = formatKnowledgeBasePresentationEnvelope(
      operationPresentation,
    );

    expect(() =>
      assertKnowledgeBaseNodeImageDelivery({
        presentation: operationPresentation,
        output: [
          {
            type: "output_image",
            file_id: "forbidden-later-image",
            file_name: "forbidden.png",
            operation_id: operation.operationId,
            turn_id: operation.turnId,
          },
          {
            type: "output_message",
            role: "assistant",
            content: [
              { type: "output_text", text: `${progress}\n${presentationText}` },
            ],
          },
        ],
      }),
    ).toThrow("图片只允许在首轮第一个节点展示");
  });

  it("rejects an image nested in the matching active-turn protocol item", () => {
    const operationPresentation = {
      ...presentation,
      schemaVersion: 2 as const,
      operationId: operation.operationId,
      turnId: operation.turnId,
    };
    const progress = formatKnowledgeBaseProgressEnvelope({
      kind: "frontmind.knowledge-base.progress",
      schemaVersion: 2,
      operationId: operation.operationId,
      turnId: operation.turnId,
      revision: 2,
      transition: {
        leafId: "product.api",
        from: "current",
        to: "confirmed",
        reason: "用户明确确认",
      },
    });

    expect(() =>
      assertKnowledgeBaseNodeImageDelivery({
        presentation: operationPresentation,
        output: [
          {
            type: "output_message",
            role: "assistant",
            content: [
              {
                type: "output_text",
                text: `${progress}\n${formatKnowledgeBasePresentationEnvelope(
                  operationPresentation,
                )}`,
              },
              {
                type: "output_image",
                file_id: "nested-current-image",
                file_name: "nested.png",
              },
            ],
          },
        ],
      }),
    ).toThrow("图片只允许在首轮第一个节点展示");
  });

  it("ignores an old unscoped image that arrives beside a newer Progress and Presentation", () => {
    const oldOperation = {
      operationId: "operation-old",
      turnId: "00000000-0000-4000-8000-000000000099",
    };
    const currentPresentation = {
      ...presentation,
      schemaVersion: 2 as const,
      operationId: operation.operationId,
      turnId: operation.turnId,
      imageState: "no_eligible_asset" as const,
      assetIds: [],
      imageCount: 0,
    };
    const oldProgress = formatKnowledgeBaseProgressEnvelope({
      kind: "frontmind.knowledge-base.progress",
      schemaVersion: 2,
      operationId: oldOperation.operationId,
      turnId: oldOperation.turnId,
      revision: 1,
      transition: {
        leafId: "company.identity",
        from: "current",
        to: "confirmed",
        reason: "旧轮确认",
      },
    });
    const currentProgress = formatKnowledgeBaseProgressEnvelope({
      kind: "frontmind.knowledge-base.progress",
      schemaVersion: 2,
      operationId: operation.operationId,
      turnId: operation.turnId,
      revision: 2,
      transition: {
        leafId: "product.api",
        from: "current",
        to: "confirmed",
        reason: "当前轮确认",
      },
    });

    expect(() =>
      assertKnowledgeBaseNodeImageDelivery({
        presentation: currentPresentation,
        output: [
          {
            type: "output_message",
            role: "assistant",
            content: [{ type: "output_text", text: oldProgress }],
          },
          {
            type: "output_message",
            role: "assistant",
            content: [
              {
                type: "output_text",
                text: `${currentProgress}\n${formatKnowledgeBasePresentationEnvelope(
                  currentPresentation,
                )}`,
              },
            ],
          },
          {
            type: "output_image",
            file_id: "old-image-arrived-late",
            file_name: "old.png",
          },
        ],
      }),
    ).not.toThrow();
  });

  it("requires an explicit zero-image declaration on later turns", () => {
    expect(() =>
      assertKnowledgeBaseNodeImageDelivery({
        presentation: {
          kind: "frontmind.knowledge-base.presentation",
          schemaVersion: 1,
          revision: 3,
          leafId: "product.api",
        },
        output: [],
      }),
    ).toThrow("缺少图片交付声明");
  });

  it("does not let redundant inline image syntax invalidate a typed delivery", () => {
    for (const content of [
      "![diagram](https://cdn.example.test/diagram.png)",
      '<img src="https://cdn.example.test/diagram.png">',
      "![diagram](data:image/png;base64,AAAA)",
    ]) {
      expect(() =>
        assertKnowledgeBaseNodeImageDelivery({
          presentation: {
            ...presentation,
            imageState: "no_eligible_asset",
            assetIds: [],
            imageCount: 0,
          },
          output: [{ role: "assistant", type: "message", content }],
        }),
      ).not.toThrow();
    }
  });

  it("requires exactly one first-turn Logo output", () => {
    const image = (id: string) => ({
      type: "output_image",
      file_id: id,
      file_name: `${id}.webp`,
    });
    expect(() =>
      assertKnowledgeBaseInitialImageDelivery([
        { role: "assistant", type: "message", content: "1.1 正文" },
        image("logo"),
      ]),
    ).not.toThrow();
    expect(() =>
      assertKnowledgeBaseInitialImageDelivery([
        { role: "assistant", type: "message", content: "1.1 正文" },
        image("logo"),
        image("business-visual"),
      ]),
    ).toThrow("必须只展示一张企业官方主 Logo");
    expect(() =>
      assertKnowledgeBaseInitialImageDelivery([
        { role: "assistant", type: "message", content: "1.1 正文" },
      ]),
    ).toThrow("必须只展示一张企业官方主 Logo");
    expect(
      assertKnowledgeBaseInitialImageDelivery(
        [{ role: "assistant", type: "message", content: "1.1 正文" }],
        undefined,
        { allowMissing: true },
      ),
    ).toBe(0);
    expect(() =>
      assertKnowledgeBaseInitialImageDelivery(
        [
          { role: "assistant", type: "message", content: "1.1 正文" },
          image("logo"),
          image("business-visual"),
        ],
        undefined,
        { allowMissing: true },
      ),
    ).toThrow("必须只展示一张企业官方主 Logo");
  });

  it("keeps a typed output_file with wrong declaration in the v4 first-turn Logo authority", () => {
    const output = [
      { role: "assistant", type: "message", content: "1.1 正文" },
      {
        type: "output_file",
        file_id: "logo-with-png-bytes",
        file_name: "artifact.bin",
        mime_type: "application/octet-stream",
      },
    ];

    expect(
      assertKnowledgeBaseInitialImageDelivery(output, undefined, {
        allowMultiple: true,
      }),
    ).toBe(1);
    expect(collectKnowledgeBaseInitialOutputImageDescriptors(output)).toEqual([
      expect.objectContaining({
        fileId: "logo-with-png-bytes",
        filename: "artifact.bin",
        mimeType: "application/octet-stream",
      }),
    ]);
  });

  it("discards only a server-rejected typed Logo and ignores redundant inline syntax", () => {
    const rejectedImage = {
      type: "output_image",
      file_id: "invalid-logo",
      file_name: "logo.png",
    };
    expect(
      assertKnowledgeBaseInitialImageDelivery(
        [
          { role: "assistant", type: "message", content: "1.1 正文" },
          rejectedImage,
        ],
        undefined,
        { allowMissing: true, discardRejectedImages: true },
      ),
    ).toBe(0);
    expect(() =>
      assertKnowledgeBaseInitialImageDelivery(
        [
          {
            role: "assistant",
            type: "message",
            content: "![inline](https://example.com/logo.png)",
          },
          rejectedImage,
        ],
        undefined,
        { allowMissing: true, discardRejectedImages: true },
      ),
    ).not.toThrow();
  });

  it("discards a conflicting typed Logo identity only with its explicit rejection", () => {
    const conflictingIdentityOutput = [
      {
        role: "assistant",
        type: "output_message",
        content: [
          {
            type: "output_image",
            file_id: "file-logo-a",
            file_url: "https://api.example/v1/files/file-logo-b/content",
            file_name: "logo.png",
            mime_type: "image/png",
          },
        ],
      },
    ];
    const rejectedLogo: KnowledgeBaseRejectedInitialLogoDisposition = {
      rejected: true,
      kind: "logo",
      userId: 42,
      buildId: "build-logo-identity",
      generation: 1,
      turnId: "turn-logo-identity",
      operationKey: "operation-logo-identity",
      taskId: "task-logo-identity",
      expectedStateEpoch: 2,
      expectedRevision: 0,
      descriptorHashes: [],
      rejectionCode: "LOGO_UPLOAD_INVALID",
    };

    expect(() =>
      collectKnowledgeBaseInitialOutputImageDescriptors(
        conflictingIdentityOutput,
      ),
    ).toThrow("相互冲突");
    expect(
      collectKnowledgeBaseInitialOutputImageDescriptors(
        conflictingIdentityOutput,
        rejectedLogo,
      ),
    ).toEqual([]);
    expect(() =>
      collectKnowledgeBaseInitialOutputImageDescriptors(
        conflictingIdentityOutput,
        { ...rejectedLogo, rejectionCode: "ARTIFACT_DOWNLOAD_FAILED" },
      ),
    ).toThrow("相互冲突");
  });

  it("does not count an earlier turn's image in the current presentation", () => {
    expect(() =>
      assertKnowledgeBaseNodeImageDelivery({
        presentation: {
          kind: "frontmind.knowledge-base.presentation",
          schemaVersion: 1,
          revision: 4,
          leafId: "team.research",
          imageState: "no_eligible_asset",
          assetIds: [],
          imageCount: 0,
        },
        output: [
          {
            role: "assistant",
            type: "message",
            content:
              '<!-- FRONTMIND_KB_PRESENTATION {"leafId":"product.api"} -->',
          },
          {
            type: "output_image",
            file_id: "old-image",
            file_name: "old.webp",
          },
          {
            role: "assistant",
            type: "message",
            content:
              '<!-- FRONTMIND_KB_PRESENTATION {"leafId":"team.research"} -->',
          },
        ],
      }),
    ).not.toThrow();
  });
});

describe("knowledge-base durable turn completion", () => {
  it("reads conversation versions from the user-scoped conversation row", () => {
    expect(
      knowledgeBaseObservationConversationStorageId(42, "conversation-1"),
    ).toBe("u42:conversation-1");
  });

  it("releases the active reservation while retaining node provenance", () => {
    expect(
      knowledgeBaseSuccessfulTurnIdentity({
        activeTurnId: "turn-1",
        operationKey: "operation-1",
        lastAppliedOperationKey: null,
      }),
    ).toEqual({
      sourceTurnId: "turn-1",
      activeTurnId: null,
      lastAppliedOperationKey: "operation-1",
    });
  });
});

describe("knowledge-base settled failure debounce", () => {
  it("requires three identical observations spanning at least ten seconds", () => {
    const first = advanceKnowledgeBaseProtocolFailureObservation({
      observationKey: "same-settled-output",
      observedAt: new Date("2026-08-01T00:00:00.000Z"),
    });
    const second = advanceKnowledgeBaseProtocolFailureObservation({
      previous: first.observation,
      observationKey: "same-settled-output",
      observedAt: new Date("2026-08-01T00:00:05.000Z"),
    });
    const third = advanceKnowledgeBaseProtocolFailureObservation({
      previous: second.observation,
      observationKey: "same-settled-output",
      observedAt: new Date("2026-08-01T00:00:10.000Z"),
    });

    expect(first.shouldPersist).toBe(false);
    expect(second.shouldPersist).toBe(false);
    expect(third).toMatchObject({ shouldPersist: true });
    expect(third.observation.count).toBe(3);
  });

  it("resets the window when the complete output observation changes", () => {
    const first = advanceKnowledgeBaseProtocolFailureObservation({
      observationKey: "partial-a",
      observedAt: new Date("2026-08-01T00:00:00.000Z"),
    });
    const replacement = advanceKnowledgeBaseProtocolFailureObservation({
      previous: first.observation,
      observationKey: "complete-b",
      observedAt: new Date("2026-08-01T00:00:20.000Z"),
    });

    expect(replacement.shouldPersist).toBe(false);
    expect(replacement.observation.count).toBe(1);
    expect(replacement.observation.firstObservedAt).toBe(
      "2026-08-01T00:00:20.000Z",
    );
  });

  it.each([
    ["acknowledgement-only first observation", false, false, false],
    ["settled malformed output before debounce", false, false, false],
    ["third stable observation after ten seconds", false, true, true],
    ["provider explicitly failed or cancelled", true, false, true],
  ])("%s terminal=%s", (_case, providerFailed, debounceSatisfied, expected) => {
    expect(
      knowledgeBaseProtocolFailureShouldBecomeTerminal({
        providerFailed,
        debounceSatisfied,
      }),
    ).toBe(expected);
  });
});

describe("knowledge-base operational failure authority", () => {
  it.each([
    [
      "running" as const,
      "requires_user_fix" as const,
      "update_credential" as const,
      "bound",
      "protocol_error",
    ],
    [
      "queued" as const,
      "recoverable_same_turn" as const,
      "reconcile" as const,
      "recovering",
      null,
    ],
  ])(
    "keeps a %s logical turn resumable for %s",
    (turnStatus, failureClass, recoveryAction, dispatchState, buildStatus) => {
      expect(
        knowledgeBaseOperationalFailureAuthority({
          turnStatus,
          failureClass,
          recoveryAction,
        }),
      ).toEqual({
        turnStatus,
        dispatchState,
        failureClass,
        recoveryAction,
        canRegenerate: false,
        buildStatus,
      });
    },
  );
});

describe("knowledge-base staged artifact authority", () => {
  const candidate: KnowledgeBaseStagedArtifactCandidate = {
    staged: true,
    kind: "package",
    userId: 42,
    buildId: "10000000-0000-4000-8000-000000000001",
    generation: 1,
    turnId: "turn-old",
    operationKey: "operation-old",
    taskId: "task-old",
    expectedStateEpoch: 9,
    expectedRevision: 7,
    descriptorHash: "a".repeat(64),
    sourceDescriptorHash: "b".repeat(64),
    storageKey: "candidate/old-package.zip",
    sha256: "c".repeat(64),
    bytes: 321,
    filename: "knowledge-base.zip",
    mimeType: "application/zip",
    packageRevision: 8,
  };

  const rejectedLogo: KnowledgeBaseRejectedInitialLogoDisposition = {
    rejected: true,
    kind: "logo",
    userId: 42,
    buildId: candidate.buildId,
    generation: candidate.generation,
    turnId: candidate.turnId,
    operationKey: candidate.operationKey,
    taskId: candidate.taskId,
    expectedStateEpoch: candidate.expectedStateEpoch,
    expectedRevision: candidate.expectedRevision,
    descriptorHashes: ["d".repeat(64)],
    rejectionCode: "LOGO_UPLOAD_INVALID",
  };

  it("accepts a rejected Logo disposition only for its exact authority and output", () => {
    const build = {
      id: candidate.buildId,
      generation: candidate.generation,
      stateEpoch: candidate.expectedStateEpoch,
      revision: candidate.expectedRevision,
      activeTurnId: candidate.turnId,
      upstreamTaskId: candidate.taskId,
    };
    const activeTurn = {
      id: candidate.turnId,
      operationKey: candidate.operationKey,
      upstreamTaskId: candidate.taskId,
      status: "running" as const,
    };
    const matches = (overrides: Record<string, unknown> = {}) =>
      knowledgeBaseRejectedInitialLogoMatchesAuthority({
        disposition: rejectedLogo,
        userId: 42,
        build,
        activeTurn,
        taskId: candidate.taskId,
        descriptorHashes: ["d".repeat(64)],
        ...overrides,
      });

    expect(matches()).toBe(true);
    expect(matches({ descriptorHashes: ["e".repeat(64)] })).toBe(false);
    expect(matches({ build: { ...build, stateEpoch: 10 } })).toBe(false);
    expect(matches({ activeTurn: { ...activeTurn, status: "failed" } })).toBe(
      false,
    );
  });

  it("accepts only the exact active operation that staged the bytes", () => {
    expect(
      knowledgeBaseStagedArtifactMatchesAuthority({
        candidate,
        kind: "package",
        userId: 42,
        build: {
          id: candidate.buildId,
          generation: candidate.generation,
          stateEpoch: candidate.expectedStateEpoch,
          revision: candidate.expectedRevision,
          activeTurnId: candidate.turnId,
          upstreamTaskId: candidate.taskId,
        },
        activeTurn: {
          id: candidate.turnId,
          operationKey: candidate.operationKey,
          upstreamTaskId: candidate.taskId,
          status: "running",
        },
        taskId: candidate.taskId,
      }),
    ).toBe(true);
  });

  it("makes a late old binder a noop after retry replaces authority", () => {
    expect(
      knowledgeBaseStagedArtifactMatchesAuthority({
        candidate,
        kind: "package",
        userId: 42,
        build: {
          id: candidate.buildId,
          generation: candidate.generation,
          stateEpoch: candidate.expectedStateEpoch + 1,
          revision: candidate.expectedRevision,
          activeTurnId: "turn-retry",
          upstreamTaskId: "task-retry",
        },
        activeTurn: {
          id: "turn-retry",
          operationKey: "operation-retry",
          upstreamTaskId: "task-retry",
          status: "running",
        },
        taskId: candidate.taskId,
      }),
    ).toBe(false);
  });

  it("never promotes bytes through a failed active-turn invariant", () => {
    expect(
      knowledgeBaseStagedArtifactMatchesAuthority({
        candidate,
        kind: "package",
        userId: 42,
        build: {
          id: candidate.buildId,
          generation: candidate.generation,
          stateEpoch: candidate.expectedStateEpoch,
          revision: candidate.expectedRevision,
          activeTurnId: candidate.turnId,
          upstreamTaskId: candidate.taskId,
        },
        activeTurn: {
          id: candidate.turnId,
          operationKey: candidate.operationKey,
          upstreamTaskId: candidate.taskId,
          status: "failed",
        },
        taskId: candidate.taskId,
      }),
    ).toBe(false);
  });
});
