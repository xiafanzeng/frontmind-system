import axios from "axios";
import { createHash } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import JSZip from "jszip";

import { canonicalKnowledgeBaseSkillArchiveHash } from "../shared/knowledge-base-skill-archive-hash.js";

import {
  KnowledgeBaseEnterpriseIdentityError,
  KnowledgeBaseMaterializedResultError,
  KnowledgeBaseUpstreamCreateError,
  KNOWLEDGE_BASE_AGENT_PROFILE,
  KNOWLEDGE_BASE_MANUAL_LOGO_DISPLAY_MESSAGE,
  KNOWLEDGE_BASE_MANUAL_LOGO_PENDING_MESSAGE,
  KNOWLEDGE_BASE_MANUAL_LOGO_USER_INSTRUCTION,
  KNOWLEDGE_BASE_PREFILL_ATTACHMENT_FILENAME,
  KNOWLEDGE_BASE_SKILL_ATTACHMENT_FILENAME,
  KNOWLEDGE_BASE_UPSTREAM_CREATE_TIMEOUT_MS,
  buildKnowledgeBasePrompt,
  buildKnowledgeBaseTurnPrompt,
  buildKnowledgeBasePrefillEvidenceArchive,
  buildKnowledgePrefillExcerpt,
  canonicalKnowledgeBaseUpstreamTask,
  assertKnowledgeBaseAttachmentManifestPresent,
  assertKnowledgeBaseExpectedGeneration,
  assertManualKnowledgeBaseLogoUploadCandidate,
  applyKnowledgeBasePresentationProjectionGuard,
  classifyKnowledgeBaseUpstreamCreateFailure,
  classifyKnowledgeBaseOpenRecoveryFailure,
  createFrontMindTask,
  checkKnowledgeBasePreparedAttachments,
  deriveKnowledgeBaseInteraction,
  deriveKnowledgeBaseBusinessResultState,
  getKnowledgeBaseSkillDescriptor,
  knowledgeBasePinnedV4SkillSelection,
  isApprovedKnowledgeBaseAwaitingInputObservation,
  knowledgeBaseArtifactFailureNotice,
  knowledgeBaseClaimTraceId,
  knowledgeBaseGeneratedAttachmentFailureForPersistence,
  knowledgeBaseLocalRehydrateAuthorityFailureForPersistence,
  knowledgeBaseManualLogoCreateFailureForPersistence,
  knowledgeBaseManualLogoUnclassifiedFailureResponse,
  knowledgeBaseNoticeAllowsSameTaskReconcile,
  knowledgeBasePreCreateUserFixObservationAllowsResume,
  knowledgeBaseManualLogoPendingResponse,
  knowledgeBaseManualLogoDeterministicCreateFailureStatus,
  knowledgeBaseManualLogoTerminalFailure,
  knowledgeBaseTerminalAnchorRecoveryTestHooks,
  knowledgeBasePresentationRequiresBoundLogo,
  knowledgeBaseTurnLogoPolicy,
  knowledgeBaseTurnReplayHttpStatus,
  knowledgeBaseTurnReservationErrorStatus,
  knowledgeBaseUpstreamReadFailureAuthority,
  knowledgeBaseRecoveryLogoPreparationError,
  knowledgeBaseRetainedStartMayReplaceNotice,
  knowledgeBaseReconcileFailureStatus,
  knowledgeBaseAcceptedReservationReceipt,
  knowledgeBaseReservationReceipt,
  loadKnowledgeBaseTurnAuthority,
  logKnowledgeBaseRuntimeFailure,
  normalizeRecoveredTaskOutput,
  manusV2KnowledgeBaseAssistantProtocolFallback,
  normalizeManusV2KnowledgeBaseOperationOutput,
  normalizeKnowledgeBaseClientAttachmentManifest,
  persistKnowledgeBaseDispatchFailure,
  persistKnowledgeBaseCreateFailure,
  planKnowledgeBaseClaimUserFirstAttachmentLedger,
  planKnowledgeBaseUserFirstAttachmentLedger,
  readKnowledgeBaseSkillArchiveAttachment,
  resolveKnowledgeBaseEnterpriseIdentity,
  selectMaterializedKnowledgeBaseAttachmentCredential,
  selectUnreconciledKnowledgeOutput,
  shouldReplayStableKnowledgeOutput,
  shouldBindKnowledgeBaseInitialLogo,
  shouldReconcileKnowledgeOutput,
  uploadKnowledgeBaseSkillArchive,
  waitForKnowledgeBaseDispatchAttachments,
} from "./knowledge-base-api";
import { KNOWLEDGE_BASE_MATERIALIZED_V5_SKILL_CONTENT_HASH } from "./knowledge-base-tree-policy-rollout";
import { buildManusV2CreateTaskBody, ManusV2ApiError } from "./manus-v2-client";
import {
  KnowledgeBaseAttachmentsProcessingError,
  KnowledgeBaseLocalPreparationError,
} from "./knowledge-base-api-errors";
import { KnowledgeBaseTurnReservationError } from "./knowledge-base-turn-service";
import { KnowledgeBaseArtifactBindingError } from "./knowledge-base-artifact-binding-service";
import { KnowledgeBaseBuildError } from "./knowledge-base-progress-service";
import { knowledgeBaseLogoRepairFileIsOwned } from "./knowledge-base-logo-provenance-api";
import { applyKnowledgeBaseFinalLogoProvenanceObservation } from "./knowledge-base-logo-provenance-repair";
import { knowledgeBaseBuildRequiresOfficialLogo } from "./knowledge-base-final-turn-service";
import { UpstreamTaskAttachmentContentProofError } from "./upstream-task-attachment";
import { KnowledgeBaseMaterializedContractError } from "./knowledge-base-materialized-contract";
import { KnowledgeArchiveDownloadError } from "./knowledge-archive-download-error";

function mockManusV2Post(
  ...responses: Array<{ status: number; data: unknown; headers?: unknown }>
) {
  const post = vi.fn();
  for (const response of responses) {
    post.mockResolvedValueOnce({ headers: {}, ...response });
  }
  vi.spyOn(axios, "create").mockReturnValue({
    post,
  } as unknown as ReturnType<typeof axios.create>);
  return post;
}

describe("knowledge-base business result projection", () => {
  it("preserves the durable progress projection when legacy summary fields have not caught up", () => {
    expect(
      deriveKnowledgeBaseBusinessResultState({
        progress: {
          summary: { handled: 0 },
          contentAvailability: "complete",
          operationState: "normalizing",
          resetAllowed: false,
          warningCodes: ["OPTIONAL_BINARY_EVIDENCE_SKIPPED"],
          build: {
            executionMode: "materialized_bundle_v1",
            skillVersion: "5",
            status: "researching",
          },
        } as any,
        observation: {
          activeTurn: null,
          approvedPresentation: null,
          notice: null,
          processingPhase: null,
        },
      }),
    ).toEqual({
      contentAvailability: "complete",
      operationState: "normalizing",
      resetAllowed: false,
      warningCodes: ["OPTIONAL_BINARY_EVIDENCE_SKIPPED"],
    });
  });
});

describe("knowledge-base user-first generated attachment ledger", () => {
  const userIds = Array.from({ length: 9 }, (_, index) => `asset-${index}`);
  const reservation = (
    role: "skill" | "prefill" | "instructions",
    attachmentIndex: number,
    fill: string,
  ) => {
    const requestHash = fill.repeat(64);
    return {
      sourceId: `kb-local-${requestHash.slice(0, 48)}`,
      value: {
        schemaVersion: 1,
        role,
        attachmentIndex,
        requestHash,
        idempotencyKeyHash: "f".repeat(64),
        filename: `${role}.bin`,
        mimeType: "application/octet-stream",
        sizeBytes: 1,
        contentSha256: "e".repeat(64),
        status: "reserved",
        reservedAt: "2026-08-15T00:00:00.000Z",
      } as const,
    };
  };

  it.each([
    { userAttachmentIds: [] as string[], expected: [0, 1] },
    { userAttachmentIds: ["asset-only"], expected: [1, 2] },
  ])(
    "offsets generated slots after N=$userAttachmentIds.length users",
    (test) => {
      const plan = planKnowledgeBaseUserFirstAttachmentLedger({
        userAttachmentIds: test.userAttachmentIds,
        stagedAttachmentIds: test.userAttachmentIds,
        generatedRoles: ["skill", "instructions"],
      });
      expect([0, 1].map(plan.generatedAttachmentIndex)).toEqual(test.expected);
    },
  );

  it("recovers the accepted nine-file start at generated slots 9 and 10", () => {
    const plan = planKnowledgeBaseUserFirstAttachmentLedger({
      userAttachmentIds: userIds,
      stagedAttachmentIds: userIds,
      generatedRoles: ["skill", "instructions"],
    });

    expect(plan.generatedAttachmentIndex(0)).toBe(9);
    expect(plan.generatedAttachmentIndex(1)).toBe(10);
    expect(
      plan.attachmentFileIdsForGenerated(["local-skill", "local-instructions"]),
    ).toEqual([...userIds, "local-skill", "local-instructions"]);
  });

  it("keeps the same user prefix when a prefill adds a third system slot", () => {
    const plan = planKnowledgeBaseUserFirstAttachmentLedger({
      userAttachmentIds: userIds,
      stagedAttachmentIds: userIds,
      generatedRoles: ["skill", "prefill", "instructions"],
    });

    expect([0, 1, 2].map(plan.generatedAttachmentIndex)).toEqual([9, 10, 11]);
  });

  it("rejects a truly polluted prefix with the stable local error", () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => undefined);
    const claim = {
      turn: {
        traceId: "10470000-0000-4000-8000-000000000000",
        attachmentFileIds: userIds,
        generatedAttachmentReservations: {},
        manusV2AttachmentMappings: {},
        createAttemptState: "not_sent",
      },
      recoveryMetadata: {
        attachments: userIds.map((file_id) => ({ file_id })),
      },
    } as any;
    expect(() =>
      planKnowledgeBaseClaimUserFirstAttachmentLedger(claim, {
        userAttachmentIds: userIds,
        stagedAttachmentIds: [userIds[1]!, userIds[0]!, ...userIds.slice(2)],
        generatedRoles: ["skill", "instructions"],
      }),
    ).toThrowError(
      expect.objectContaining({
        code: "KNOWLEDGE_BASE_GENERATED_ATTACHMENT_LEDGER_CONFLICT",
      }),
    );
    expect(info).toHaveBeenCalledWith(
      "[KnowledgeBaseDispatch] validate_ledger",
      JSON.stringify({
        event: "dispatch_phase",
        phase: "validate_ledger",
        traceId: "10470000-0000-4000-8000-000000000000",
        errorCode: "KNOWLEDGE_BASE_GENERATED_ATTACHMENT_LEDGER_CONFLICT",
        userCount: 9,
        expected: 11,
        staged: 9,
        generatedReservation: 0,
        mapping: 0,
        createState: "not_sent",
      }),
    );
    info.mockRestore();
  });

  it("accepts a crash-recovered generated slot only with its durable reservation", () => {
    const requestHash = "a".repeat(64);
    const localSkillId = `kb-local-${requestHash.slice(0, 48)}`;
    const reservation = {
      schemaVersion: 1,
      role: "skill",
      attachmentIndex: 9,
      requestHash,
      idempotencyKeyHash: "b".repeat(64),
      filename: "skill.zip",
      mimeType: "application/zip",
      sizeBytes: 1,
      contentSha256: "c".repeat(64),
      status: "reserved",
      reservedAt: "2026-08-15T00:00:00.000Z",
    } as const;
    const plan = planKnowledgeBaseUserFirstAttachmentLedger({
      userAttachmentIds: userIds,
      stagedAttachmentIds: [...userIds, localSkillId],
      generatedRoles: ["skill", "instructions"],
      generatedReservations: { "skill:9": reservation },
    });

    expect(plan.stagedGeneratedIds).toEqual([localSkillId]);
    expect(plan.generatedAttachmentIndex(1)).toBe(10);
  });

  it("replays a fully staged skill/prefill/instructions ledger without changing order", () => {
    const skill = reservation("skill", 9, "a");
    const prefill = reservation("prefill", 10, "b");
    const instructions = reservation("instructions", 11, "c");
    const stagedGenerated = [
      skill.sourceId,
      prefill.sourceId,
      instructions.sourceId,
    ];
    const plan = planKnowledgeBaseUserFirstAttachmentLedger({
      userAttachmentIds: userIds,
      stagedAttachmentIds: [...userIds, ...stagedGenerated],
      generatedRoles: ["skill", "prefill", "instructions"],
      generatedReservations: {
        "skill:9": skill.value,
        "prefill:10": prefill.value,
        "instructions:11": instructions.value,
      },
    });

    expect(plan.stagedGeneratedIds).toEqual(stagedGenerated);
    expect(plan.attachmentFileIdsForGenerated(stagedGenerated)).toEqual([
      ...userIds,
      ...stagedGenerated,
    ]);
  });
});

describe("materialized knowledge-base attachment revision authority", () => {
  it("uses the current exact credential for a revision with no parent task or file credential", () => {
    const currentCredential = { id: "credential-current", version: 7 };
    const selected = selectMaterializedKnowledgeBaseAttachmentCredential({
      isStartReservation: false,
      startCredential: null,
      currentCredential,
    });

    expect(selected).toBe(currentCredential);
    expect(selected?.id).toBe("credential-current");
  });
});

function expectEnterpriseIdentityError(
  action: () => unknown,
  code: KnowledgeBaseEnterpriseIdentityError["code"],
) {
  try {
    action();
    throw new Error("Expected KnowledgeBaseEnterpriseIdentityError");
  } catch (error) {
    expect(error).toBeInstanceOf(KnowledgeBaseEnterpriseIdentityError);
    expect((error as KnowledgeBaseEnterpriseIdentityError).code).toBe(code);
  }
}

describe("knowledge-base turn HTTP outcomes", () => {
  it("never replaces an explicit or stopped recovery token with retained-start preview", () => {
    for (const recoveryAction of [
      "retry_request",
      "start_new_generation",
    ] as const) {
      expect(
        knowledgeBaseRetainedStartMayReplaceNotice({
          code: "FRONTMIND_KB_RETRY_AVAILABLE",
          recoveryAction,
          recoveryToken: "a".repeat(64),
        } as any),
      ).toBe(false);
    }
    expect(
      knowledgeBaseRetainedStartMayReplaceNotice({
        code: "FRONTMIND_KB_STOPPED",
        recoveryAction: "stopped",
        recoveryToken: null,
      } as any),
    ).toBe(false);
    expect(
      knowledgeBaseRetainedStartMayReplaceNotice({
        code: "UPSTREAM_CREATE_3",
        recoveryAction: "reconcile",
      } as any),
    ).toBe(true);
  });

  it("keeps all in-flight receipts on 202 and terminal receipts on 409", () => {
    expect(knowledgeBaseTurnReplayHttpStatus("pending")).toBe(202);
    expect(knowledgeBaseTurnReplayHttpStatus("bound")).toBe(202);
    expect(knowledgeBaseTurnReplayHttpStatus("awaiting_attachments")).toBe(200);
    expect(knowledgeBaseTurnReplayHttpStatus("completed")).toBe(200);
    expect(knowledgeBaseTurnReplayHttpStatus("terminal")).toBe(409);
    expect(knowledgeBaseTurnReplayHttpStatus("terminal", 200)).toBe(200);
  });

  it("accepts only strict RFC4122 trace ids from durable turn authority", () => {
    const claim = (traceId: string) =>
      ({
        turn: { traceId },
        recoveryMetadata: {},
      }) as any;
    expect(
      knowledgeBaseClaimTraceId(claim("a0c7502e-4c1f-4d06-8ab6-407e8a82c138")),
    ).toBe("a0c7502e-4c1f-4d06-8ab6-407e8a82c138");
    expect(
      knowledgeBaseClaimTraceId(claim("a0c7502e-4c1f-0d06-8ab6-407e8a82c138")),
    ).toBeUndefined();
    expect(
      knowledgeBaseClaimTraceId(claim("a0c7502e-4c1f-4d06-7ab6-407e8a82c138")),
    ).toBeUndefined();
  });

  it("returns one authoritative reservation receipt without inventing a task id", () => {
    const turn = {
      id: "turn-reserved",
      clientRequestId: "request-reserved",
      buildGeneration: 4,
      expectedRevision: 8,
      expectedLeafId: "1.4",
      upstreamTaskId: null,
      dispatchState: "reserved",
      failureClass: "recoverable_same_turn",
      recoveryAction: "reconcile",
      canRegenerate: false,
      sourceResetRevision: 4,
      stagedUserAttachmentCount: 0,
      expectedUserAttachmentCount: 0,
    } as any;

    expect(
      knowledgeBaseReservationReceipt(
        {
          state: "pending",
          turn,
          retryAfterMs: 1_000,
        } as any,
        11,
      ),
    ).toMatchObject({
      state: "pending",
      dispatchState: "recovering",
      turnId: "turn-reserved",
      upstreamTaskId: null,
      stateEpoch: 11,
      canRegenerate: false,
      sourceResetRevision: 4,
    });
    expect(
      knowledgeBaseAcceptedReservationReceipt({ turn, stateEpoch: 11 }),
    ).toMatchObject({
      state: "pending",
      dispatchState: "recovering",
      turnId: "turn-reserved",
      upstreamTaskId: null,
      stateEpoch: 11,
      canRegenerate: false,
      sourceResetRevision: 4,
    });
    expect(
      knowledgeBaseAcceptedReservationReceipt({
        turn: {
          ...turn,
          id: "turn-bound",
          upstreamTaskId: "provider-task-bound",
          dispatchState: "reserved",
        },
      }),
    ).toMatchObject({
      dispatchState: "bound",
      turnId: "turn-bound",
      upstreamTaskId: "provider-task-bound",
    });

    expect(
      knowledgeBaseReservationReceipt({
        state: "terminal",
        turn: {
          ...turn,
          id: "turn-legacy-terminal",
          upstreamTaskId: "provider-task-legacy-terminal",
          dispatchState: "failed",
          failureClass: "terminal_nonregenerable",
          recoveryAction: "contact_support",
          canRegenerate: false,
        },
      } as any),
    ).toMatchObject({
      state: "terminal",
      dispatchState: "failed",
      upstreamTaskId: "provider-task-legacy-terminal",
      failureClass: "terminal_nonregenerable",
      recoveryAction: "contact_support",
      canRegenerate: false,
    });
  });

  it("never grants same-turn recovery after a deterministic Task Create rejection", async () => {
    const failDeterministically = vi.fn().mockResolvedValue(undefined);
    const cancelUnprepared = vi.fn().mockResolvedValue(undefined);
    const markOutcomeUnknown = vi.fn().mockResolvedValue(undefined);
    const settlePreCreateFailure = vi.fn().mockResolvedValue(undefined);
    const common = {
      userId: 7,
      turnId: "turn-attachment-repair",
      leaseToken: "lease-attachment-repair",
      outcomeUnknownCode: "SHOULD_NOT_BE_USED",
    };

    for (const [status, code] of [
      [401, "UPSTREAM_CREATE_HTTP_401"],
      [402, "UPSTREAM_CREATE_HTTP_402"],
      [403, "UPSTREAM_CREATE_HTTP_403"],
      [413, "UPSTREAM_CREATE_HTTP_413"],
    ] as const) {
      failDeterministically.mockClear();
      await expect(
        persistKnowledgeBaseCreateFailure(
          {
            ...common,
            error: new KnowledgeBaseUpstreamCreateError(
              "deterministic",
              code,
              status,
            ),
          },
          {
            failDeterministically,
            cancelUnprepared,
            markOutcomeUnknown,
          },
        ),
      ).resolves.toBe("deterministic");
      expect(failDeterministically).toHaveBeenCalledWith(
        expect.objectContaining({
          turnId: common.turnId,
          failureClass: "terminal_nonregenerable",
          recoveryAction: "contact_support",
          canRegenerate: false,
          createAttemptRejected: true,
        }),
      );
      expect(failDeterministically).not.toHaveBeenCalledWith(
        expect.objectContaining({
          recoveryAction: expect.stringMatching(
            /^(?:top_up|update_credential|fix_attachments)$/u,
          ),
        }),
      );
    }
    expect(cancelUnprepared).not.toHaveBeenCalled();
    expect(markOutcomeUnknown).not.toHaveBeenCalled();

    failDeterministically.mockClear();
    await persistKnowledgeBaseCreateFailure(
      {
        ...common,
        error: new KnowledgeBaseLocalPreparationError(
          "KNOWLEDGE_BASE_CLIENT_ATTACHMENT_INVALID",
          "受管附件完整性校验失败",
        ),
      },
      {
        failDeterministically,
        cancelUnprepared,
        markOutcomeUnknown,
        settlePreCreateFailure,
      },
    );
    expect(settlePreCreateFailure).toHaveBeenCalledWith(
      expect.objectContaining({
        turnId: common.turnId,
        code: "KNOWLEDGE_BASE_CLIENT_ATTACHMENT_INVALID",
        failureStage: "provider_file_registration",
      }),
    );
    expect(failDeterministically).not.toHaveBeenCalled();
  });

  it("defers pending attachments for five seconds without marking task-create unknown", async () => {
    const deferBeforeCreate = vi.fn().mockResolvedValue(undefined);
    const markOutcomeUnknown = vi.fn().mockResolvedValue(undefined);
    const failDeterministically = vi.fn().mockResolvedValue(undefined);

    await expect(
      persistKnowledgeBaseCreateFailure(
        {
          userId: 7,
          turnId: "turn-attachments-processing",
          leaseToken: "lease-attachments-processing",
          outcomeUnknownCode: "SHOULD_NOT_BE_USED",
          error: new KnowledgeBaseAttachmentsProcessingError(
            6,
            1,
            5_000,
            "a0c7502e-4c1f-4d06-8ab6-407e8a82c138",
          ),
        },
        {
          deferBeforeCreate,
          markOutcomeUnknown,
          failDeterministically,
        },
      ),
    ).resolves.toBe("retriable");
    expect(deferBeforeCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        code: "KNOWLEDGE_BASE_ATTACHMENTS_PROCESSING",
        recoveryDelayMs: 5_000,
      }),
    );
    expect(markOutcomeUnknown).not.toHaveBeenCalled();
    expect(failDeterministically).not.toHaveBeenCalled();
  });

  it("keeps a provider-acknowledged v2 operation on read-only reconciliation after local persistence fails", async () => {
    const markManusV2OutcomeUnknown = vi.fn().mockResolvedValue(undefined);
    const persistCreateFailure = vi.fn().mockResolvedValue("unknown");
    const claim = {
      turn: {
        id: "turn-v2-post-ack-bind-failure",
        userId: 7,
        providerProtocol: "manus_v2",
        providerMethod: "task.create",
        providerAttemptState: "output_pending",
      },
      leaseToken: "lease-v2-post-ack-bind-failure",
    } as any;

    await expect(
      persistKnowledgeBaseDispatchFailure(
        {
          claim,
          error: new Error("temporary database failure after provider 2xx"),
          outcomeUnknownCode: "MANUS_V2_BIND_PERSISTENCE_UNKNOWN",
          recoveryDelayMs: 1_000,
        },
        { markManusV2OutcomeUnknown, persistCreateFailure },
      ),
    ).resolves.toBe("retriable");
    expect(markManusV2OutcomeUnknown).toHaveBeenCalledTimes(1);
    expect(markManusV2OutcomeUnknown).toHaveBeenCalledWith({
      userId: 7,
      turnId: claim.turn.id,
      leaseToken: claim.leaseToken,
      code: "MANUS_V2_BIND_PERSISTENCE_UNKNOWN",
      recoveryDelayMs: 1_000,
    });
    expect(persistCreateFailure).not.toHaveBeenCalled();
  });

  it("settles a deterministic materialized ZIP contract failure before the generic output-pending branch", async () => {
    const failMaterializedResult = vi.fn().mockResolvedValue({
      turn: {},
      deduplicated: false,
    });
    const deferMaterializedResultRead = vi.fn();
    const markManusV2OutcomeUnknown = vi.fn();
    const persistCreateFailure = vi.fn();
    const claim = {
      turn: {
        id: "turn-materialized-contract-invalid",
        userId: 7,
        providerProtocol: "manus_v2",
        providerAttemptState: "output_pending",
      },
      leaseToken: "lease-materialized-contract-invalid",
    } as any;

    await expect(
      persistKnowledgeBaseDispatchFailure(
        {
          claim,
          error: new KnowledgeBaseMaterializedContractError(
            "skill.contentHash 与任务坐标不一致",
          ),
          outcomeUnknownCode: "RECOVERY_DEFERRED",
        },
        {
          failMaterializedResult,
          deferMaterializedResultRead,
          markManusV2OutcomeUnknown,
          persistCreateFailure,
        },
      ),
    ).resolves.toBe("deterministic");
    expect(failMaterializedResult).toHaveBeenCalledWith({
      userId: 7,
      turnId: claim.turn.id,
      leaseToken: claim.leaseToken,
      code: "KNOWLEDGE_BASE_MATERIALIZED_CONTRACT_INVALID",
    });
    expect(deferMaterializedResultRead).not.toHaveBeenCalled();
    expect(markManusV2OutcomeUnknown).not.toHaveBeenCalled();
    expect(persistCreateFailure).not.toHaveBeenCalled();
  });

  it("settles an acknowledged result-processing exception without reopening task.create", async () => {
    const failMaterializedResult = vi.fn().mockResolvedValue({
      turn: {},
      deduplicated: false,
    });
    const markManusV2OutcomeUnknown = vi.fn();
    const persistCreateFailure = vi.fn();
    const claim = {
      turn: {
        id: "turn-materialized-presentation-exception",
        userId: 7,
        providerProtocol: "manus_v2",
        materializedRecoveryContractVersion: 1,
        createAttemptState: "acknowledged",
        providerAttemptState: "output_pending",
        upstreamTaskId: "bound-materialized-task",
      },
      leaseToken: "lease-materialized-presentation-exception",
    } as any;

    await expect(
      persistKnowledgeBaseDispatchFailure(
        {
          claim,
          error: new TypeError("presentation encoder failed"),
          outcomeUnknownCode: "MUST_NOT_BE_USED",
        },
        {
          failMaterializedResult,
          markManusV2OutcomeUnknown,
          persistCreateFailure,
        },
      ),
    ).resolves.toBe("deterministic");
    expect(failMaterializedResult).toHaveBeenCalledWith({
      userId: 7,
      turnId: claim.turn.id,
      leaseToken: claim.leaseToken,
      code: "KNOWLEDGE_BASE_RESULT_PROCESSING_FAILED",
    });
    expect(markManusV2OutcomeUnknown).not.toHaveBeenCalled();
    expect(persistCreateFailure).not.toHaveBeenCalled();
  });

  it("bounds transient archive reads and terminalizes deterministic download failures without replacing the task", async () => {
    const claim = {
      turn: {
        id: "turn-materialized-download",
        userId: 7,
        providerProtocol: "manus_v2",
        providerAttemptState: "output_pending",
      },
      leaseToken: "lease-materialized-download",
    } as any;
    const failMaterializedResult = vi.fn().mockResolvedValue({
      turn: {},
      deduplicated: false,
    });
    const deferMaterializedResultRead = vi.fn().mockResolvedValue({
      state: "deferred",
      firstObservedAt: "2026-08-15T00:00:00.000Z",
      attempt: 1,
      nextRetryAt: "2026-08-15T00:00:15.000Z",
      retryAfterMs: 15_000,
      deduplicated: false,
    });
    const markManusV2OutcomeUnknown = vi.fn();

    await expect(
      persistKnowledgeBaseDispatchFailure(
        {
          claim,
          error: new KnowledgeArchiveDownloadError(
            "http_status",
            "知识库 ZIP 暂不可读",
            503,
          ),
          outcomeUnknownCode: "RECOVERY_DEFERRED",
        },
        {
          failMaterializedResult,
          deferMaterializedResultRead,
          markManusV2OutcomeUnknown,
        },
      ),
    ).resolves.toBe("retriable");
    expect(deferMaterializedResultRead).toHaveBeenCalledWith({
      userId: 7,
      turnId: claim.turn.id,
      leaseToken: claim.leaseToken,
      lastErrorKind: "archive_http_status_503",
    });
    expect(markManusV2OutcomeUnknown).not.toHaveBeenCalled();

    await expect(
      persistKnowledgeBaseDispatchFailure(
        {
          claim,
          error: new KnowledgeArchiveDownloadError(
            "missing_url",
            "知识库 ZIP 缺少下载地址",
          ),
          outcomeUnknownCode: "RECOVERY_DEFERRED",
        },
        {
          failMaterializedResult,
          deferMaterializedResultRead,
          markManusV2OutcomeUnknown,
        },
      ),
    ).resolves.toBe("deterministic");
    expect(failMaterializedResult).toHaveBeenCalledWith({
      userId: 7,
      turnId: claim.turn.id,
      leaseToken: claim.leaseToken,
      code: "KNOWLEDGE_BASE_MATERIALIZED_RESULT_UNAVAILABLE",
    });
    expect(markManusV2OutcomeUnknown).not.toHaveBeenCalled();
  });

  it("keeps a not-sent v2 preparation failure on the pre-create failure path", async () => {
    const markManusV2OutcomeUnknown = vi.fn().mockResolvedValue(undefined);
    const persistCreateFailure = vi.fn().mockResolvedValue("retriable");
    const claim = {
      turn: {
        id: "turn-v2-not-sent-local-failure",
        userId: 7,
        providerProtocol: "manus_v2",
        providerAttemptState: "not_sent",
      },
      leaseToken: "lease-v2-not-sent-local-failure",
    } as any;
    const error = new Error("local preparation failed before provider POST");

    await expect(
      persistKnowledgeBaseDispatchFailure(
        {
          claim,
          error,
          outcomeUnknownCode: "SHOULD_NOT_BE_USED",
        },
        { markManusV2OutcomeUnknown, persistCreateFailure },
      ),
    ).resolves.toBe("retriable");
    expect(markManusV2OutcomeUnknown).not.toHaveBeenCalled();
    expect(persistCreateFailure).toHaveBeenCalledWith({
      userId: 7,
      turnId: claim.turn.id,
      leaseToken: claim.leaseToken,
      error,
      outcomeUnknownCode: "SHOULD_NOT_BE_USED",
    });
  });

  it("terminalizes a drifted local-rehydrate authority instead of rescanning it forever", async () => {
    const failDeterministically = vi.fn().mockResolvedValue(undefined);
    const error = new KnowledgeBaseLocalPreparationError(
      "KNOWLEDGE_BASE_LOCAL_REHYDRATE_AUTHORITY_INVALID",
      "local rehydrate coordinate drifted",
    );

    await expect(
      knowledgeBaseLocalRehydrateAuthorityFailureForPersistence(
        {
          userId: 7,
          turnId: "turn-local-rehydrate-drift",
          leaseToken: "lease-local-rehydrate-drift",
          error,
        },
        { failDeterministically },
      ),
    ).resolves.toBe(true);
    expect(failDeterministically).toHaveBeenCalledOnce();
    expect(failDeterministically).toHaveBeenCalledWith({
      userId: 7,
      turnId: "turn-local-rehydrate-drift",
      leaseToken: "lease-local-rehydrate-drift",
      code: "KNOWLEDGE_BASE_LOCAL_REHYDRATE_AUTHORITY_INVALID",
      message: "local rehydrate coordinate drifted。未向上游创建任务",
      failureClass: "terminal_nonregenerable",
      recoveryAction: "contact_support",
      canRegenerate: false,
    });
  });

  it("settles a polluted generated ledger as reset-required without a provider side effect", async () => {
    const failDeterministically = vi.fn().mockResolvedValue(undefined);
    const settlePreCreateFailure = vi.fn().mockResolvedValue(undefined);
    const markOutcomeUnknown = vi.fn().mockResolvedValue(undefined);
    const deferBeforeCreate = vi.fn().mockResolvedValue(undefined);
    const taskPost = vi.spyOn(axios, "post");
    const error = new KnowledgeBaseLocalPreparationError(
      "KNOWLEDGE_BASE_GENERATED_ATTACHMENT_LEDGER_CONFLICT",
      "safe ledger conflict",
    );

    await expect(
      persistKnowledgeBaseCreateFailure(
        {
          userId: 7,
          turnId: "turn-ledger-conflict",
          leaseToken: "lease-ledger-conflict",
          outcomeUnknownCode: "SHOULD_NOT_BE_USED",
          error,
        },
        {
          failDeterministically,
          settlePreCreateFailure,
          markOutcomeUnknown,
          deferBeforeCreate,
        },
      ),
    ).resolves.toBe("deterministic");
    expect(settlePreCreateFailure).toHaveBeenCalledWith({
      userId: 7,
      turnId: "turn-ledger-conflict",
      leaseToken: "lease-ledger-conflict",
      code: "KNOWLEDGE_BASE_GENERATED_ATTACHMENT_LEDGER_CONFLICT",
      message: "safe ledger conflict",
      failureStage: "provider_file_registration",
    });
    expect(failDeterministically).not.toHaveBeenCalled();
    expect(markOutcomeUnknown).not.toHaveBeenCalled();
    expect(deferBeforeCreate).not.toHaveBeenCalled();
    expect(taskPost).not.toHaveBeenCalled();
    taskPost.mockRestore();
  });

  it("settles a reset-only dispatch fence as approved-reset authority", async () => {
    const failDeterministically = vi.fn().mockResolvedValue(undefined);
    const settlePreCreateFailure = vi.fn().mockResolvedValue(undefined);
    const markOutcomeUnknown = vi.fn();

    await expect(
      persistKnowledgeBaseCreateFailure(
        {
          userId: 7,
          turnId: "turn-reset-required",
          leaseToken: "lease-reset-required",
          outcomeUnknownCode: "SHOULD_NOT_BE_USED",
          error: new KnowledgeBaseTurnReservationError(
            "RESET_REQUIRED",
            "approved reset required",
          ),
        },
        {
          failDeterministically,
          settlePreCreateFailure,
          markOutcomeUnknown,
        },
      ),
    ).resolves.toBe("deterministic");
    expect(settlePreCreateFailure).toHaveBeenCalledWith({
      userId: 7,
      turnId: "turn-reset-required",
      leaseToken: "lease-reset-required",
      code: "RESET_REQUIRED",
      message: "approved reset required",
      failureStage: "provider_file_registration",
    });
    expect(failDeterministically).not.toHaveBeenCalled();
    expect(markOutcomeUnknown).not.toHaveBeenCalled();
  });

  it("keeps an explicitly classified old reset-only contract on its legacy terminal path", async () => {
    const failDeterministically = vi.fn().mockResolvedValue(undefined);
    const settlePreCreateFailure = vi.fn().mockResolvedValue(null);

    await expect(
      persistKnowledgeBaseCreateFailure(
        {
          userId: 7,
          turnId: "turn-old-reset-required",
          leaseToken: "lease-old-reset-required",
          outcomeUnknownCode: "SHOULD_NOT_BE_USED",
          error: new KnowledgeBaseTurnReservationError(
            "RESET_REQUIRED",
            "old contract requires reset",
          ),
        },
        { failDeterministically, settlePreCreateFailure },
      ),
    ).resolves.toBe("deterministic");
    expect(failDeterministically).toHaveBeenCalledWith(
      expect.objectContaining({
        code: "RESET_REQUIRED",
        recoveryAction: "approve_reset",
      }),
    );
  });

  it("keeps generated-file content proof failures before task create and never asks users to repair PDFs", async () => {
    const taskPost = vi.spyOn(axios, "post");
    const deferBeforeCreate = vi.fn().mockResolvedValue(undefined);
    const markOutcomeUnknown = vi.fn().mockResolvedValue(undefined);
    const failDeterministically = vi.fn().mockResolvedValue(undefined);
    const settlePreCreateFailure = vi.fn().mockResolvedValue(undefined);
    const common = {
      userId: 7,
      turnId: "turn-generated-content-proof",
      leaseToken: "lease-generated-content-proof",
      outcomeUnknownCode: "SHOULD_NOT_BE_USED",
    };

    const transient = knowledgeBaseGeneratedAttachmentFailureForPersistence(
      new UpstreamTaskAttachmentContentProofError(
        "transient",
        "http_status",
        503,
      ),
    );
    expect(transient).toBeInstanceOf(KnowledgeBaseAttachmentsProcessingError);
    await expect(
      persistKnowledgeBaseCreateFailure(
        { ...common, error: transient },
        {
          deferBeforeCreate,
          markOutcomeUnknown,
          failDeterministically,
          settlePreCreateFailure,
        },
      ),
    ).resolves.toBe("retriable");
    expect(deferBeforeCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        turnId: common.turnId,
        code: "KNOWLEDGE_BASE_ATTACHMENTS_PROCESSING",
        recoveryDelayMs: 5_000,
      }),
    );
    expect(markOutcomeUnknown).not.toHaveBeenCalled();
    expect(failDeterministically).not.toHaveBeenCalled();
    expect(taskPost).not.toHaveBeenCalled();

    deferBeforeCreate.mockClear();
    const deterministic = knowledgeBaseGeneratedAttachmentFailureForPersistence(
      new UpstreamTaskAttachmentContentProofError(
        "deterministic",
        "sha256_mismatch",
      ),
    );
    expect(deterministic).toMatchObject({
      code: "KNOWLEDGE_BASE_GENERATED_ATTACHMENT_INVALID",
    });
    await expect(
      persistKnowledgeBaseCreateFailure(
        { ...common, error: deterministic },
        {
          deferBeforeCreate,
          markOutcomeUnknown,
          failDeterministically,
          settlePreCreateFailure,
        },
      ),
    ).resolves.toBe("deterministic");
    expect(settlePreCreateFailure).toHaveBeenCalledWith(
      expect.objectContaining({
        turnId: common.turnId,
        code: "KNOWLEDGE_BASE_GENERATED_ATTACHMENT_INVALID",
        failureStage: "provider_file_registration",
      }),
    );
    expect(failDeterministically).not.toHaveBeenCalledWith(
      expect.objectContaining({ recoveryAction: "fix_attachments" }),
    );
    expect(deferBeforeCreate).not.toHaveBeenCalled();
    expect(markOutcomeUnknown).not.toHaveBeenCalled();
    expect(taskPost).not.toHaveBeenCalled();
    taskPost.mockRestore();
  });

  it("keeps Logo re-upload separate and never labels server finalization as attachment repair", async () => {
    const failDeterministically = vi.fn().mockResolvedValue(undefined);
    const cancelUnprepared = vi.fn().mockResolvedValue(undefined);
    const settlePreCreateFailure = vi.fn().mockResolvedValue(undefined);
    const dependencies = {
      failDeterministically,
      cancelUnprepared,
      settlePreCreateFailure,
      markOutcomeUnknown: vi.fn().mockResolvedValue(undefined),
    };
    const common = {
      userId: 7,
      turnId: "turn-local-preparation",
      leaseToken: "lease-local-preparation",
      outcomeUnknownCode: "SHOULD_NOT_BE_USED",
    };

    await persistKnowledgeBaseCreateFailure(
      {
        ...common,
        error: new KnowledgeBaseLocalPreparationError(
          "KNOWLEDGE_BASE_LOGO_UPLOAD_INVALID",
          "Logo 字节不可解码",
        ),
      },
      dependencies,
    );
    expect(cancelUnprepared).toHaveBeenCalledWith(
      expect.objectContaining({
        turnId: common.turnId,
        code: "KNOWLEDGE_BASE_LOGO_UPLOAD_INVALID",
      }),
    );
    expect(failDeterministically).not.toHaveBeenCalled();

    cancelUnprepared.mockClear();
    await persistKnowledgeBaseCreateFailure(
      {
        ...common,
        error: new KnowledgeBaseLocalPreparationError(
          "KNOWLEDGE_BASE_FINALIZATION_INPUT_INVALID",
          "最终交付输入损坏",
        ),
      },
      dependencies,
    );
    expect(settlePreCreateFailure).toHaveBeenCalledWith(
      expect.objectContaining({
        turnId: common.turnId,
        code: "KNOWLEDGE_BASE_FINALIZATION_INPUT_INVALID",
        failureStage: "provider_file_registration",
      }),
    );
    expect(failDeterministically).not.toHaveBeenCalled();
    expect(cancelUnprepared).not.toHaveBeenCalled();
  });

  it("exposes stable stale/replay/Logo status mappings", () => {
    expect(
      knowledgeBaseTurnReservationErrorStatus(
        new KnowledgeBaseTurnReservationError(
          "STALE_KNOWLEDGE_BASE_PRESENTATION",
          "stale",
        ),
      ),
    ).toBe(409);
    expect(
      knowledgeBaseTurnReservationErrorStatus(
        new KnowledgeBaseTurnReservationError(
          "KNOWLEDGE_BASE_REQUEST_REPLAY_MISMATCH",
          "mismatch",
        ),
      ),
    ).toBe(409);
    expect(
      knowledgeBaseTurnReservationErrorStatus(
        new KnowledgeBaseTurnReservationError(
          "KNOWLEDGE_BASE_LOGO_UPLOAD_CONFLICT",
          "conflict",
        ),
      ),
    ).toBe(409);
    expect(
      knowledgeBaseTurnReservationErrorStatus(
        new KnowledgeBaseTurnReservationError(
          "KNOWLEDGE_BASE_LOGO_UPLOAD_INVALID",
          "invalid",
        ),
      ),
    ).toBe(422);
    expect(
      knowledgeBaseTurnReservationErrorStatus(
        new KnowledgeBaseTurnReservationError(
          "IDEMPOTENCY_PENDING",
          "pending",
          1_000,
        ),
      ),
    ).toBe(425);
  });

  it("returns a branded 425 contract while a manual Logo reservation is recoverable", () => {
    const observation = { stateEpoch: 7 } as any;
    const response = knowledgeBaseManualLogoPendingResponse({
      observation,
      retryAfterMs: 1_250,
    });

    expect(response).toEqual({
      status: 425,
      retryAfterSeconds: "2",
      body: {
        error: {
          code: "IDEMPOTENCY_PENDING",
          message: "FrontMind 已接收 Logo，正在重新呈现当前知识节点",
        },
        observation,
      },
    });
    expect(response.body.error.message).toBe(
      KNOWLEDGE_BASE_MANUAL_LOGO_PENDING_MESSAGE,
    );
    expect(JSON.stringify(response.body)).not.toMatch(/manus/iu);
  });

  it("keeps the upstream Logo instruction out of the customer-visible message", () => {
    expect(KNOWLEDGE_BASE_MANUAL_LOGO_DISPLAY_MESSAGE).toBe(
      "已提交新的企业官方主 Logo，正在重新呈现当前知识节点。",
    );
    expect(KNOWLEDGE_BASE_MANUAL_LOGO_DISPLAY_MESSAGE).not.toContain(
      "不得确认或推进节点",
    );
    expect(KNOWLEDGE_BASE_MANUAL_LOGO_USER_INSTRUCTION).toContain(
      "不得确认或推进节点",
    );
  });

  it("keeps unclassified manual Logo failures recoverable without claiming a pre-reservation submit", () => {
    const observation = { generation: 4, stateEpoch: 9 } as any;
    expect(
      knowledgeBaseManualLogoUnclassifiedFailureResponse({
        reservationAcquired: true,
        observation,
        retryAfterMs: 1_250,
      }),
    ).toEqual({
      status: 425,
      retryAfterSeconds: "2",
      body: {
        error: {
          code: "IDEMPOTENCY_PENDING",
          message: "FrontMind 已接收 Logo，正在重新呈现当前知识节点",
        },
        observation,
      },
    });
    expect(
      knowledgeBaseManualLogoUnclassifiedFailureResponse({
        reservationAcquired: false,
        observation,
        retryAfterMs: 1_250,
      }),
    ).toEqual({
      status: 503,
      retryAfterSeconds: "2",
      body: {
        error: {
          code: "KNOWLEDGE_BASE_LOGO_SUBMISSION_UNCERTAIN",
          message: "Logo 提交结果暂未确认，系统将按同一请求自动重试",
        },
        observation,
      },
    });
  });

  it("keeps deterministic manual Logo validation and coordinate failures terminal", () => {
    expect(
      knowledgeBaseManualLogoTerminalFailure(
        new KnowledgeBaseArtifactBindingError(
          "LOGO_UPLOAD_INVALID",
          "Logo 原始字节无效",
        ),
      ),
    ).toEqual({
      status: 422,
      code: "KNOWLEDGE_BASE_LOGO_UPLOAD_INVALID",
      message: "Logo 原始字节无效",
    });
    expect(
      knowledgeBaseManualLogoTerminalFailure(
        new KnowledgeBaseArtifactBindingError(
          "BUILD_CHANGED",
          "当前节点坐标已变化",
        ),
      ),
    ).toEqual({
      status: 409,
      code: "KNOWLEDGE_BASE_LOGO_UPLOAD_CONFLICT",
      message: "当前节点坐标已变化",
    });
    expect(
      knowledgeBaseManualLogoTerminalFailure(
        new KnowledgeBaseArtifactBindingError(
          "ARTIFACT_DOWNLOAD_FAILED",
          "临时读取失败",
        ),
      ),
    ).toBeNull();
  });

  it.each([
    [400, 400],
    [401, 403],
    [403, 403],
    [404, 422],
    [409, 409],
    [413, 413],
    [422, 422],
    [502, 422],
  ])(
    "maps deterministic manual Logo provider status %i to public status %i",
    (providerStatus, publicStatus) => {
      expect(
        knowledgeBaseManualLogoDeterministicCreateFailureStatus(
          new KnowledgeBaseUpstreamCreateError(
            "deterministic",
            `UPSTREAM_CREATE_HTTP_${providerStatus}`,
            providerStatus,
          ),
        ),
      ).toBe(publicStatus);
    },
  );

  it.each([
    [425, "UPSTREAM_CREATE_HTTP_425"],
    [409, "UPSTREAM_CREATE_HTTP_409"],
    [503, "UPSTREAM_CREATE_HTTP_503"],
  ])(
    "does not map recoverable manual Logo provider status %i to a terminal response",
    (status, code) => {
      expect(
        knowledgeBaseManualLogoDeterministicCreateFailureStatus(
          new KnowledgeBaseUpstreamCreateError("retriable", code, status),
        ),
      ).toBeNull();
    },
  );

  it("keeps a successful create response without a task id pending for manual Logo reconciliation", () => {
    const missingTaskId = new KnowledgeBaseUpstreamCreateError(
      "deterministic",
      "UPSTREAM_TASK_ID_MISSING",
      502,
    );

    expect(
      knowledgeBaseManualLogoDeterministicCreateFailureStatus(missingTaskId),
    ).toBeNull();
    expect(
      knowledgeBaseManualLogoCreateFailureForPersistence(missingTaskId),
    ).toMatchObject({
      failureClass: "unknown",
      failureCode: "UPSTREAM_TASK_ID_MISSING",
      status: 502,
    });
  });

  it("validates a managed manual Logo before a turn can be reserved", async () => {
    const candidate = {
      index: 0,
      fileId: "managed-logo-file",
      filename: "official-logo.png",
      mimeType: "image/png",
      sizeBytes: 128,
      sourceSha256: "a".repeat(64),
    };
    const validateCapturedImage = vi.fn().mockResolvedValue({
      width: 100,
      height: 100,
      aspectRatio: 1,
      pixels: Buffer.alloc(0),
    });

    await expect(
      assertManualKnowledgeBaseLogoUploadCandidate(
        candidate,
        validateCapturedImage,
      ),
    ).resolves.toBeUndefined();
    expect(validateCapturedImage).toHaveBeenCalledWith({
      fileId: candidate.fileId,
      filename: candidate.filename,
      mimeType: candidate.mimeType,
      sizeBytes: candidate.sizeBytes,
      sourceSha256: candidate.sourceSha256,
    });

    validateCapturedImage.mockClear();
    await expect(
      assertManualKnowledgeBaseLogoUploadCandidate(
        { ...candidate, mimeType: "image/bmp" },
        validateCapturedImage,
      ),
    ).rejects.toMatchObject({
      code: "KNOWLEDGE_BASE_LOGO_UPLOAD_INVALID",
    });
    expect(validateCapturedImage).not.toHaveBeenCalled();

    validateCapturedImage.mockRejectedValueOnce(new Error("decode failed"));
    await expect(
      assertManualKnowledgeBaseLogoUploadCandidate(
        candidate,
        validateCapturedImage,
      ),
    ).rejects.toMatchObject({
      code: "KNOWLEDGE_BASE_LOGO_UPLOAD_INVALID",
    });
  });
});

describe("knowledge-base upstream read failure authority", () => {
  it.each([
    [
      { kind: "credential_unavailable" as const },
      "requires_user_fix",
      "update_credential",
      "UPSTREAM_CREDENTIAL_UNAVAILABLE",
    ],
    [
      { kind: "http" as const, status: 401 },
      "requires_user_fix",
      "update_credential",
      "UPSTREAM_CREDENTIAL_REJECTED",
    ],
    [
      { kind: "http" as const, status: 403 },
      "requires_user_fix",
      "update_credential",
      "UPSTREAM_CREDENTIAL_REJECTED",
    ],
    [
      { kind: "transport" as const },
      "recoverable_same_turn",
      "reconcile",
      "UPSTREAM_TASK_READ_FAILED",
    ],
    [
      { kind: "http" as const, status: 429 },
      "recoverable_same_turn",
      "reconcile",
      "UPSTREAM_TASK_READ_FAILED",
    ],
    [
      { kind: "http" as const, status: 503 },
      "recoverable_same_turn",
      "reconcile",
      "UPSTREAM_TASK_READ_FAILED",
    ],
  ])(
    "classifies $0 without granting regeneration",
    (input, failureClass, recoveryAction, code) => {
      expect(knowledgeBaseUpstreamReadFailureAuthority(input)).toEqual({
        code,
        failureClass,
        recoveryAction,
        canRegenerate: false,
      });
    },
  );

  it("reopens the exact bound task after credentials are updated", () => {
    expect(
      knowledgeBaseNoticeAllowsSameTaskReconcile({
        recoveryAction: "update_credential",
        canRegenerate: false,
      }),
    ).toBe(true);
    expect(
      knowledgeBaseNoticeAllowsSameTaskReconcile({
        recoveryAction: "regenerate_turn",
        canRegenerate: true,
      }),
    ).toBe(false);
  });

  it("allows only an unbound rejected credential create to rearm through reconcile", () => {
    const activeTurn = {
      id: "turn-rejected-create",
      status: "failed",
      upstreamTaskId: null,
      failureClass: "requires_user_fix",
      recoveryAction: "update_credential",
      canRegenerate: false,
      createAttemptState: "rejected",
    } as any;
    const notice = {
      turnId: activeTurn.id,
      failureClass: "requires_user_fix",
      recoveryAction: "update_credential",
      canRegenerate: false,
    } as any;
    const input = { activeTurn, notice, hasCredential: true };

    expect(knowledgeBasePreCreateUserFixObservationAllowsResume(input)).toBe(
      true,
    );
    expect(
      knowledgeBasePreCreateUserFixObservationAllowsResume({
        ...input,
        activeTurn: { ...activeTurn, upstreamTaskId: "old-task" },
      }),
    ).toBe(false);
    expect(
      knowledgeBasePreCreateUserFixObservationAllowsResume({
        ...input,
        activeTurn: { ...activeTurn, recoveryAction: "top_up" },
        notice: { ...notice, recoveryAction: "top_up" },
      }),
    ).toBe(false);
    expect(
      knowledgeBasePreCreateUserFixObservationAllowsResume({
        ...input,
        hasCredential: false,
      }),
    ).toBe(false);
  });

  it("reserves 422 for semantic protocol failures and reports runtime/database failures as 503", () => {
    expect(
      knowledgeBaseReconcileFailureStatus(
        new KnowledgeBaseBuildError("PROGRESS_PROTOCOL_INVALID", "invalid"),
      ),
    ).toBe(422);
    expect(
      knowledgeBaseReconcileFailureStatus(
        new KnowledgeBaseBuildError("BUILD_NOT_FOUND", "missing"),
      ),
    ).toBe(404);
    expect(
      knowledgeBaseReconcileFailureStatus(
        new KnowledgeBaseTurnReservationError("BUILD_NOT_FOUND", "missing"),
      ),
    ).toBe(404);
    expect(
      knowledgeBaseReconcileFailureStatus(
        new KnowledgeBaseTurnReservationError("CONVERSATION_RESET", "reset"),
      ),
    ).toBe(410);
    expect(
      knowledgeBaseReconcileFailureStatus(
        new KnowledgeBaseTurnReservationError("RESET_REQUIRED", "reset"),
      ),
    ).toBe(410);
    expect(
      knowledgeBaseReconcileFailureStatus(
        Object.assign(new Error("deadlock"), { code: "ER_LOCK_DEADLOCK" }),
      ),
    ).toBe(503);
    expect(
      knowledgeBaseReconcileFailureStatus(
        Object.assign(new Error("timeout"), { code: "ETIMEDOUT" }),
      ),
    ).toBe(503);
  });
});

describe("knowledge base execution contract", () => {
  afterEach(() => {
    delete process.env.FRONTMIND_KB_MANUS_V2_WRITER;
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("keeps dashboard knowledge-base builds on the Pro model", () => {
    expect(KNOWLEDGE_BASE_AGENT_PROFILE).toBe("frontmind-pro");
  });

  it("does not let optional Logo provenance replace the authoritative observation", () => {
    const progress = {
      build: {
        id: "build-final",
        conversationId: "conversation-final",
        companyName: "企业",
        skillVersion: "4",
        status: "protocol_error" as const,
        revision: 50,
        currentLeafId: "7.5",
        protocolError: "旧的最终 ZIP 错误",
        awaitingResponseSince: null,
        updatedAt: 123,
      },
      summary: {
        total: 50,
        handled: 49,
        confirmed: 49,
        directPrefilled: 0,
        pending: 0,
        current: 1,
        needsVerification: 0,
      },
      branches: [],
      packageAllowed: false,
    };
    const ordinary = deriveKnowledgeBaseInteraction(progress, "failed");
    const projected = applyKnowledgeBaseFinalLogoProvenanceObservation({
      state: "missing",
      progress,
      interaction: ordinary,
      observation: {
        generation: 3,
        activeTurn: null,
        notice: {
          key: "old",
          code: "FINAL_PACKAGE_INVALID",
          severity: "error",
          message: "旧错误",
          retryable: true,
          turnId: null,
          createdAt: 1,
        },
      },
    });
    expect(projected.notice).toEqual({
      key: "old",
      code: "FINAL_PACKAGE_INVALID",
      severity: "error",
      message: "旧错误",
      retryable: true,
      turnId: null,
      createdAt: 1,
    });
    expect(projected.interaction).toEqual(ordinary);
  });

  it("authorizes a newly owned repair upload without comparing its credential to the historical task", () => {
    expect(
      knowledgeBaseLogoRepairFileIsOwned({ id: "fresh-credential-version" }),
    ).toBe(true);
    expect(knowledgeBaseLogoRepairFileIsOwned(null)).toBe(false);
  });

  it("treats an exact approved awaiting-input projection as observation-only", () => {
    const observation = {
      stateEpoch: 7,
      generation: 2,
      authoritativeTaskId: "task-completed-1",
      activeTurn: null,
      approvedPresentation: {
        turnId: "turn-completed-1",
        clientRequestId: "request-1",
        presentationKey: "presentation-1",
        generation: 2,
        revision: 1,
        leafId: "1.2",
        visibleMarkdown: "## 1.2 企业主体\n\n已批准正文。",
        contentSha256: "a".repeat(64),
        imageState: "no_eligible_asset",
        resources: [],
      },
      package: null,
      notice: null,
      conversationVersion: 4,
      interaction: {
        interactionState: "awaiting_input",
        canReply: true,
        canPublish: false,
        lockReason: null,
        progress: {
          build: {
            id: "build-1",
            conversationId: "conversation-1",
            companyName: "FrontMind超前智能",
            status: "confirming",
            revision: 1,
            currentLeafId: "1.2",
            protocolError: null,
            awaitingResponseSince: null,
            updatedAt: 1,
          },
          summary: {} as any,
          branches: [],
          packageAllowed: false,
        },
      },
    } as const;

    expect(
      isApprovedKnowledgeBaseAwaitingInputObservation(observation as any),
    ).toBe(true);
    expect(
      isApprovedKnowledgeBaseAwaitingInputObservation({
        ...observation,
        approvedPresentation: {
          ...observation.approvedPresentation,
          revision: 0,
        },
      } as any),
    ).toBe(false);
    expect(
      isApprovedKnowledgeBaseAwaitingInputObservation({
        ...observation,
        approvedPresentation: {
          ...observation.approvedPresentation,
          generation: 1,
        },
      } as any),
    ).toBe(false);
    expect(
      isApprovedKnowledgeBaseAwaitingInputObservation({
        ...observation,
        activeTurn: { id: "turn-active" },
      } as any),
    ).toBe(false);
  });

  it("keeps an accepted first-node presentation replyable while its optional Logo projection repairs", () => {
    const progress = {
      build: {
        id: "build-logo-projection-repair",
        conversationId: "conversation-logo-projection-repair",
        companyName: "Projection Fixture",
        skillVersion: "4",
        generation: 1,
        status: "confirming",
        revision: 0,
        currentLeafId: "1.1",
        protocolError: null,
        awaitingResponseSince: null,
        logoRequired: false,
        logoAvailable: true,
        updatedAt: 123,
      },
      summary: {
        total: 40,
        handled: 0,
        confirmed: 0,
        directPrefilled: 0,
        pending: 39,
        current: 1,
        needsVerification: 0,
      },
      branches: [],
      packageAllowed: false,
    } as any;
    const interaction = deriveKnowledgeBaseInteraction(
      progress,
      "awaiting_input",
    );
    const approvedPresentation = {
      turnId: "turn-first-node",
      clientRequestId: "request-first-node",
      presentationKey: "presentation-first-node",
      generation: 1,
      revision: 0,
      leafId: "1.1",
      visibleMarkdown: "## 1.1 企业主体\n\n已接受并展示的正文。",
      contentSha256: "a".repeat(64),
      // Simulate an immutable receipt that remains valid while the optional
      // Logo/current-node resource projection is absent.
      imageState: "no_eligible_asset" as const,
      resources: [],
    };

    const guarded = applyKnowledgeBasePresentationProjectionGuard({
      progress,
      observation: {
        generation: 1,
        activeTurn: null,
        approvedPresentation,
        localRestrictions: [],
        notice: null,
      },
      interaction,
    });

    expect(approvedPresentation.visibleMarkdown).toContain(
      "已接受并展示的正文",
    );
    expect(guarded.interaction).toMatchObject({
      interactionState: "awaiting_input",
      canReply: true,
      lockReason: null,
    });
    expect(guarded.localRestrictions).toContain("logo_projection_repairing");
    expect(guarded.notice).toMatchObject({
      code: "KNOWLEDGE_BASE_LOGO_PROJECTION_REPAIRING",
      severity: "warning",
      retryable: false,
    });

    const existingNotice = {
      key: "existing-higher-priority-notice",
      code: "KNOWLEDGE_BASE_CANONICAL_TASK_RECOVERING",
      severity: "warning" as const,
      message: "系统正在恢复当前操作。已完成内容不受影响。",
      retryable: true,
      turnId: null,
      createdAt: 122,
    };
    expect(
      applyKnowledgeBasePresentationProjectionGuard({
        progress,
        observation: {
          generation: 1,
          activeTurn: null,
          approvedPresentation,
          localRestrictions: ["canonical_task_repairing"],
          notice: existingNotice,
        },
        interaction,
      }).notice,
    ).toBe(existingNotice);
  });

  it("keeps accepted text visible but locks reply authority for an active or stale coordinate", () => {
    const progress = {
      build: {
        id: "build-active-turn",
        conversationId: "conversation-active-turn",
        companyName: "Projection Fixture",
        skillVersion: "4",
        generation: 7,
        status: "confirming",
        revision: 11,
        currentLeafId: "3.2",
        protocolError: null,
        awaitingResponseSince: null,
        logoRequired: false,
        logoAvailable: false,
        updatedAt: 123,
      },
      summary: {
        total: 40,
        handled: 11,
        confirmed: 10,
        directPrefilled: 0,
        pending: 28,
        current: 1,
        needsVerification: 1,
      },
      branches: [],
      packageAllowed: false,
    } as any;
    const interaction = deriveKnowledgeBaseInteraction(
      progress,
      "awaiting_input",
    );
    const approvedPresentation = {
      turnId: "turn-visible",
      clientRequestId: "request-visible",
      presentationKey: "presentation-visible",
      generation: 7,
      revision: 11,
      leafId: "3.2",
      visibleMarkdown: "## 3.2\n\n已接受正文仍可显示。",
      contentSha256: "a".repeat(64),
      imageState: "no_eligible_asset" as const,
      resources: [],
    };

    const active = applyKnowledgeBasePresentationProjectionGuard({
      progress,
      observation: {
        generation: 7,
        activeTurn: { id: "hidden-anchor-turn" } as any,
        approvedPresentation,
        localRestrictions: [],
        notice: null,
      },
      interaction,
    });
    expect(approvedPresentation.visibleMarkdown).toContain("已接受正文");
    expect(active.interaction).toMatchObject({
      interactionState: "executing",
      canReply: false,
    });

    const stale = applyKnowledgeBasePresentationProjectionGuard({
      progress,
      observation: {
        generation: 7,
        activeTurn: null,
        approvedPresentation: { ...approvedPresentation, generation: 6 },
        localRestrictions: [],
        notice: null,
      },
      interaction,
    });
    expect(stale.interaction).toMatchObject({
      interactionState: "executing",
      canReply: false,
    });
  });

  it("accepts digest-free reservations while preserving legacy SHA manifests", () => {
    expect(
      normalizeKnowledgeBaseClientAttachmentManifest([
        {
          name: "facts.pdf",
          size: 12,
          type: "application/pdf",
          lastModified: 10,
          sha256: "a".repeat(64),
        },
      ]),
    ).toEqual([
      {
        filename: "facts.pdf",
        sizeBytes: 12,
        mimeType: "application/pdf",
        lastModified: 10,
        sha256: "a".repeat(64),
      },
    ]);
    expect(
      normalizeKnowledgeBaseClientAttachmentManifest([
        {
          filename: "FrontMind_logo.svg",
          sizeBytes: 42,
          mimeType: "application/octet-stream",
          lastModified: 11,
          sha256: "b".repeat(64),
        },
      ])[0]?.mimeType,
    ).toBe("image/svg+xml");
    expect(() =>
      normalizeKnowledgeBaseClientAttachmentManifest([
        { filename: "facts.pdf", mimeType: "application/pdf" },
      ]),
    ).toThrow("manifest entry 1 is invalid");
    expect(
      normalizeKnowledgeBaseClientAttachmentManifest([
        {
          filename: "facts.pdf",
          sizeBytes: 12,
          mimeType: "application/pdf",
          lastModified: 10,
        },
      ]),
    ).toEqual([
      {
        filename: "facts.pdf",
        sizeBytes: 12,
        mimeType: "application/pdf",
        lastModified: 10,
      },
    ]);
    expect(() =>
      normalizeKnowledgeBaseClientAttachmentManifest([
        {
          filename: "facts.pdf",
          sizeBytes: 12,
          mimeType: "application/pdf",
          lastModified: 10,
          sha256: "not-a-digest",
        },
      ]),
    ).toThrow("manifest entry 1 is invalid");
  });

  it("requires the reservation manifest for every v4 attachment", () => {
    expect(() =>
      assertKnowledgeBaseAttachmentManifestPresent({
        skillVersion: "4",
        attachmentCount: 1,
        attachmentManifest: undefined,
      }),
    ).toThrow("必须包含完整预约清单");
    expect(() =>
      assertKnowledgeBaseAttachmentManifestPresent({
        skillVersion: "4",
        attachmentCount: 1,
        attachmentManifest: [
          {
            filename: "proof.jpg",
            sizeBytes: 12,
            mimeType: "image/jpeg",
            lastModified: 10,
            sha256: "a".repeat(64),
          },
        ],
      }),
    ).not.toThrow();
    expect(() =>
      assertKnowledgeBaseAttachmentManifestPresent({
        skillVersion: "3",
        attachmentCount: 1,
        attachmentManifest: undefined,
      }),
    ).not.toThrow();
  });

  it("rejects a stale optional generation before reserving a turn", () => {
    expect(() =>
      assertKnowledgeBaseExpectedGeneration({
        expectedGeneration: 3,
        actualGeneration: 4,
      }),
    ).toThrow("已重置或进入新一代构建");
    expect(() =>
      assertKnowledgeBaseExpectedGeneration({
        expectedGeneration: 4,
        actualGeneration: 4,
      }),
    ).not.toThrow();
    expect(() =>
      assertKnowledgeBaseExpectedGeneration({
        expectedGeneration: undefined,
        actualGeneration: 4,
      }),
    ).not.toThrow();
  });

  it("derives a turn build and parent task from one server-owned snapshot", async () => {
    let currentBuild = {
      id: "build-1",
      userId: 7,
      conversationId: "conversation-1",
      executionMode: "materialized_bundle_v1",
      skillVersion: "5",
      providerProtocol: "manus_v2",
      contentVersion: 1,
      handoffProvenance: {
        materializedRecoveryContractVersion: 1,
        materializedCompletionContractVersion: 2,
      },
      upstreamTaskId: "task-parent",
      revision: 3,
    };
    const loadBuild = vi.fn(async () => ({ ...currentBuild }) as any);

    const pendingAuthority = loadKnowledgeBaseTurnAuthority(
      { userId: 7, conversationId: "conversation-1" },
      loadBuild,
    );
    currentBuild = {
      ...currentBuild,
      upstreamTaskId: "task-newly-bound",
    };

    await expect(pendingAuthority).resolves.toMatchObject({
      build: {
        id: "build-1",
        userId: 7,
        conversationId: "conversation-1",
        upstreamTaskId: "task-parent",
        revision: 3,
      },
      taskId: "task-parent",
      kind: "bound",
    });
    expect(loadBuild).toHaveBeenCalledOnce();
    expect(loadBuild).toHaveBeenCalledWith(7, "conversation-1");
  });

  it("rejects a historical local-preprovider release instead of rehydrating it", async () => {
    const releasedBuild = {
      id: "build-released",
      userId: 7,
      conversationId: "conversation-released",
      executionMode: "legacy_conversational",
      skillVersion: "4",
      providerProtocol: "manus_v2",
      canonicalTaskId: null,
      upstreamTaskId: null,
    } as any;
    const loadBuild = vi.fn(async () => releasedBuild);
    const loadUnboundAuthority = vi.fn(async () => ({
      kind: "failed_confirm_preprovider_release" as const,
      sourceTurnId: "turn-released",
      generation: 3,
      revision: 7,
      leafId: "1.8",
      presentationKey: "presentation-7",
    }));

    await expect(
      loadKnowledgeBaseTurnAuthority(
        { userId: 7, conversationId: "conversation-released" },
        loadBuild,
        loadUnboundAuthority,
      ),
    ).rejects.toMatchObject({ code: "RESET_REQUIRED" });
    expect(loadUnboundAuthority).not.toHaveBeenCalled();
  });

  it("treats a nullable pre-0062 content version as RESET_REQUIRED", async () => {
    const legacyNullBuild = {
      id: "build-pre-0062",
      userId: 7,
      conversationId: "conversation-pre-0062",
      executionMode: "materialized_bundle_v1",
      skillVersion: "5",
      providerProtocol: "manus_v2",
      contentVersion: null,
      canonicalTaskId: "task-must-not-be-read",
      upstreamTaskId: null,
    };
    const loadBuild = vi.fn().mockResolvedValue(legacyNullBuild);
    const loadUnboundAuthority = vi.fn();

    await expect(
      loadKnowledgeBaseTurnAuthority(
        { userId: 7, conversationId: "conversation-pre-0062" },
        loadBuild,
        loadUnboundAuthority,
      ),
    ).rejects.toMatchObject({ code: "RESET_REQUIRED" });
    expect(loadUnboundAuthority).not.toHaveBeenCalled();
  });

  it("routes only unrecoverable ready packages to explicit rebind", () => {
    expect(classifyKnowledgeBaseOpenRecoveryFailure("ready_to_publish")).toBe(
      "package_rebind_required",
    );
    expect(classifyKnowledgeBaseOpenRecoveryFailure("researching")).toBe(
      "fatal",
    );
    expect(classifyKnowledgeBaseOpenRecoveryFailure("confirming")).toBe(
      "fatal",
    );
    expect(
      classifyKnowledgeBaseOpenRecoveryFailure(
        "protocol_error",
        "PACKAGE_REBIND_REQUIRED",
      ),
    ).toBe("package_rebind_required");
    expect(
      classifyKnowledgeBaseOpenRecoveryFailure(
        "protocol_error",
        "PROGRESS_PROTOCOL_INVALID",
      ),
    ).toBe("fatal");
  });

  it("never writes upstream error detail, API keys or customer body to console", () => {
    const apiKey = "sk-sensitive-runtime-key-1234567890";
    const customerBody = "尚未公开的企业知识库正文-绝密";
    const error = Object.assign(
      new Error(`upstream detail ${apiKey} ${customerBody}`),
      {
        name: "AxiosError",
        code: "ERR_BAD_RESPONSE",
        response: {
          status: 502,
          data: { message: customerBody, API_KEY: apiKey },
        },
      },
    );
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    logKnowledgeBaseRuntimeFailure({
      level: "warn",
      event: "[KnowledgeBaseTest] upstream_failed",
      buildId: "build-1",
      turnId: "turn-1",
      taskId: "task-1",
      error,
      additionalSecrets: [apiKey],
    });

    const serialized = JSON.stringify(warn.mock.calls);
    expect(serialized).toContain("KNOWLEDGE_BASE_RUNTIME_ERROR");
    expect(serialized).not.toContain("ERR_BAD_RESPONSE");
    expect(serialized).toContain("build-1");
    expect(serialized).toContain("turn-1");
    expect(serialized).toContain("task-1");
    expect(serialized).toContain("502");
    expect(serialized).not.toContain(apiKey);
    expect(serialized).not.toContain(customerBody);
    expect(serialized).not.toContain("upstream detail");
    expect(serialized).not.toContain("response");
    expect(serialized).not.toContain("API_KEY");
  });

  it("normalizes every supported top-level provider text shape as an assistant output", () => {
    for (const task of [
      { output: "字符串正文" },
      { output: { value: "对象 value 正文" } },
      { output: { type: "output_text", text: "对象 text 正文" } },
      { output: ["数组字符串正文"] },
      { output: [{ value: "数组对象 value 正文" }] },
      { output_text: "顶层 output_text 正文" },
      { output_text: { value: "顶层 value 正文" } },
    ]) {
      expect(normalizeRecoveredTaskOutput(task)).toEqual([
        expect.objectContaining({ role: "assistant" }),
      ]);
    }
  });

  it("uses one canonical nested task for id, terminal status, and output", () => {
    const wrapped = {
      id: "stale-wrapper-id",
      status: "running",
      output: "stale wrapper output",
      task: {
        id: "authoritative-task-id",
        status: "finished",
        output: "authoritative nested output",
      },
    };

    expect(canonicalKnowledgeBaseUpstreamTask(wrapped)).toEqual(wrapped.task);
    expect(normalizeRecoveredTaskOutput(wrapped)).toEqual([
      expect.objectContaining({
        role: "assistant",
        content: [{ type: "output_text", text: "authoritative nested output" }],
      }),
    ]);
  });

  it("treats every ambiguous create outcome as unknown without replay authority", () => {
    for (const status of [400, 401, 403, 404, 409, 413, 422]) {
      expect(classifyKnowledgeBaseUpstreamCreateFailure({ status })).toBe(
        "deterministic",
      );
    }
    for (const status of [408, 425, 429, 500, 502, 503]) {
      expect(classifyKnowledgeBaseUpstreamCreateFailure({ status })).toBe(
        "unknown",
      );
    }
    expect(
      classifyKnowledgeBaseUpstreamCreateFailure({
        status: 409,
        code: "idempotency_pending",
      }),
    ).toBe("unknown");
    expect(
      classifyKnowledgeBaseUpstreamCreateFailure({
        status: 422,
        code: "IDEMPOTENCY_PENDING",
      }),
    ).toBe("unknown");
    expect(
      classifyKnowledgeBaseUpstreamCreateFailure({ transportError: true }),
    ).toBe("unknown");
    expect(
      classifyKnowledgeBaseUpstreamCreateFailure({
        status: 200,
        missingTaskId: true,
      }),
    ).toBe("unknown");
  });

  it("keeps the Pro prompt compact while preserving depth and one-by-one traversal", async () => {
    const prompt = await buildKnowledgeBasePrompt({
      companyName: "验收企业",
      companyWebsite:
        "https://company.example.invalid/\nhttps://evidence.example.invalid/",
      operatorNotes: "覆盖全部产品线",
      attachments: [{ file_id: "file-1", filename: "catalog.pdf" }],
      protocolOperation: {
        skillVersion: "4",
        operationId: "operation-1",
        turnId: "turn-1",
      },
      treePolicyVersion: 2,
    });

    expect(prompt).toContain(
      "不得开启、调用、切换或推荐 Wide Research / Deep Research",
    );
    expect(prompt).toContain(KNOWLEDGE_BASE_SKILL_ATTACHMENT_FILENAME);
    expect(prompt).toContain("先解压 ZIP 并完整读取根目录 SKILL.md");
    expect(prompt).toContain(
      "用户已在 FrontMind Dashboard 发起并授权本轮企业知识库构建",
    );
    expect(prompt).toContain("不要求环境预装同名 Skill");
    expect(prompt).toContain(
      "只有 customerAttachments 中明确列出的文件属于客户事实资料",
    );
    expect(prompt).toContain("30-115");
    expect(prompt).toContain("普通企业目标 40-55");
    expect(prompt).toContain("references/knowledge-tree.md");
    expect(prompt).toContain("至少成功解析 12 个官网页面并执行 6 次公开查询");
    expect(prompt).toContain("120 个成功官网页、200 个访问链接");
    expect(prompt).toContain("不得为数量、字数或图片数填充内容");
    expect(prompt).toContain("一级分支数量不设固定值");
    expect(prompt).not.toContain("恰好 7 个一级分支");
    expect(prompt).not.toContain("7 universal top-level branches");
    expect(prompt).toContain("处理最后节点且本轮状态提交后将达到 100%");
    expect(prompt).toContain("每次被接受后加 1");
    expect(prompt).toContain("https://company.example.invalid/");
    expect(prompt).toContain("https://evidence.example.invalid/");
    expect(prompt).toContain("catalog.pdf");
    expect(prompt).toContain("FRONTMIND_KB_MANIFEST");
    expect(prompt).toContain("FRONTMIND_KB_PROGRESS");
    expect(prompt).toContain("FRONTMIND_KB_PRESENTATION");
    expect(prompt).toContain(
      "输出前先自行解析每个机器信封，并按给定 schema、operationId 与 turnId 范围完成校验",
    );
    expect(prompt).toContain("只输出一次唯一合法结构");
    expect(prompt).toContain("服务端严格校验仍为最终权威");
    expect(prompt).not.toContain("FRONTMIND_KB_REOPEN");
    expect(prompt).toContain("禁止输出 SOCRATIC_KB_STATE");
    expect(prompt).toContain("补充、修订、问题或上传资料");
    expect(prompt).toContain("to 必须为 needs_verification");
    expect(prompt).toContain("(confirmed + direct_prefilled) / total");
    expect(prompt).toContain("不得输出参考资料、参考来源");
    expect(prompt).toContain("可见正文结束后直接附机器信封");
    expect(prompt).toContain("有界全网搜索中寻找企业官方主 Logo");
    expect(prompt).toContain("不得采集或打包品牌主视觉、业务图");
    expect(prompt).toContain("取得合格 Logo 后立即停止所有网页图片发现");
    expect(prompt).toContain("仍没有合格真实 Logo");
    expect(prompt).toContain("完整 Manifest 和第一个叶子正文，但返回零张图片");
    expect(prompt).toContain("等待用户上传企业主 Logo");
    expect(prompt).toContain("sourceAssetUrl 可指向 SVG");
    expect(prompt).toContain("该 URL 只记录官方来源");
    expect(prompt).toContain("不要求源文件与返回栅格原字节相同");
    expect(prompt).toContain("Dashboard 将绑定该返回字节");
    expect(prompt).toContain("official_logo_upload 原样保留");
    expect(prompt).toContain("official_logo_upload");
    expect(prompt).toContain("资料采集状态只由 Dashboard 展示");
    expect(prompt).toContain("不得复述、输出或以“正在采集”“处理中”");
    expect(prompt).toContain("不得先发送或以“已收到”“好的”“开始处理”");
    expect(prompt).not.toContain(
      "FrontMind 正在按业务分支进行资料采集。此阶段无需逐项确认，完成后将直接生成可核验知识库。",
    );
    expect(prompt).toContain("imageState=no_eligible_asset");
    expect(Buffer.byteLength(prompt, "utf8")).toBeLessThanOrEqual(20_000);
    expect(prompt).not.toContain("# Skill");
    expect(prompt).not.toContain("current Pro Agent");
    expect(prompt).not.toContain("# FILE: references/");
    expect(prompt).not.toContain("# FILE: scripts/validate_archive.py");
    expect(prompt).not.toContain("def validate_archive");
    expect(prompt).not.toContain("360–480");
    expect(prompt).not.toContain("300,000");
    for (const forbiddenPhrase of [
      "系统附件",
      "服务端系统附件",
      "系统输入",
      "优先级",
      "最高优先级",
      "覆盖任务历史",
      "旧 Skill、旧回复或旧协议示例",
      "pasted_content",
      "严格执行",
    ]) {
      expect(prompt).not.toContain(forbiddenPhrase);
    }

    const manifestMatch = prompt.match(
      /<!-- FRONTMIND_KB_MANIFEST\n([^\n]+)\n-->/u,
    );
    expect(manifestMatch).not.toBeNull();
    const manifestExample = JSON.parse(manifestMatch![1]!);
    expect(manifestExample.leaves).toHaveLength(40);
    expect(
      new Set(manifestExample.leaves.map((leaf: any) => leaf.branchId)).size,
    ).toBe(7);
    expect(manifestExample.researchCoverage).toMatchObject({
      officialPages: {
        discovered: 18,
        attempted: 16,
        succeeded: 14,
        failed: 2,
      },
      publicQueries: 6,
      officialDocuments: 4,
      uploadsRead: 1,
      stopReason: "coverage_complete",
    });
    expect(manifestExample.researchCoverage.dimensions).toHaveLength(7);

    const archive = await readKnowledgeBaseSkillArchiveAttachment();
    expect(archive.filename).toBe("socratic-kb-builder-v5.skill.zip");
    expect(archive.bytes.subarray(0, 4).toString("hex")).toBe("504b0304");
    const zip = await JSZip.loadAsync(archive.bytes);
    const skill = await zip.file("SKILL.md")?.async("string");
    const normalizedSkill = String(skill || "").replace(/\s+/gu, " ");
    for (const invariant of [
      "Socratic Enterprise Knowledge Base Builder v5",
      "materialize_initial_bundle",
      "revise_leaf_bundle",
      "Every operation is a new top-level Manus v2 task",
      "120 successfully parsed official pages",
      "200 visited links",
      "30 useful official documents",
      "30 public queries",
      "30–115-leaf tree",
      "40–55 leaves",
      "3,000,000",
      "customer-visible Markdown only",
      "Do not emit formal-content markers",
      "1,500 ZIP files",
      "30 MiB",
      "assetType",
      "displayRole",
      "256×256",
      "verification gaps",
      "frontmind-kb-bundle-<operationId>.zip",
      "frontmind-kb-patch-<operationId>.zip",
      "references/output-format.md",
      "--expected-skill-content-hash",
      "VALID frontmind.kb-working-set.v1",
      "已完成，知识库 ZIP 已附上。",
      "end the current task immediately",
    ]) {
      expect(normalizedSkill).toContain(invariant);
    }
    for (const removedContinuationContract of [
      "current Pro Agent",
      "One leaf per turn",
      "FINALIZATION_INPUT",
      "task.sendMessage",
    ]) {
      expect(normalizedSkill).not.toContain(removedContinuationContract);
    }
  });

  it("keeps historical v4 builds on the legacy tree contract", async () => {
    const prompt = await buildKnowledgeBasePrompt({
      companyName: "历史企业",
      companyWebsite: "",
      operatorNotes: "",
      attachments: [],
      protocolOperation: {
        skillVersion: "4",
        operationId: "operation-legacy",
        turnId: "turn-legacy",
      },
      treePolicyVersion: 1,
    });
    const manifestMatch = prompt.match(
      /<!-- FRONTMIND_KB_MANIFEST\n([^\n]+)\n-->/u,
    );
    expect(manifestMatch).not.toBeNull();
    const manifestExample = JSON.parse(manifestMatch![1]!);
    expect(manifestExample.leaves).toHaveLength(8);
    expect(manifestExample.researchCoverage).toBeUndefined();
    expect(prompt).toContain("8-115");
    expect(prompt).not.toContain("普通企业目标 40-55");
    expect(prompt).not.toContain("researchCoverage 必须记录真实研究账本");
  });

  it("keeps an uploaded official Logo on the first leaf with exact provenance", async () => {
    const sha256 = "a".repeat(64);
    const prompt = await buildKnowledgeBaseTurnPrompt({
      userId: 0,
      conversationId: "official-logo-supplement",
      userMessage: "",
      attachments: [
        { file_id: "file-official-logo", filename: "brand-logo.png" },
      ],
      attachmentManifest: [
        {
          filename: "brand-logo.png",
          mimeType: "image/png",
          sizeBytes: 4096,
          sha256,
        },
      ],
      officialLogoUpload: {
        verified: true,
        index: 0,
        fileId: "file-official-logo",
        filename: "brand-logo.png",
        mimeType: "image/png",
        sizeBytes: 4096,
        sourceSha256: sha256,
      },
      skillVersion: "4",
      protocolOperation: {
        operationId: "logo-operation",
        turnId: "logo-turn",
      },
      progressOverride: {
        build: { revision: 0, currentLeafId: "1.1" },
        branches: [
          {
            leaves: [
              {
                id: "1.1",
                title: "一句话定位",
                branchTitle: "企业身份",
                status: "current",
              },
              {
                id: "1.2",
                title: "企业名称",
                branchTitle: "企业身份",
                status: "pending",
              },
            ],
          },
        ],
      },
    });

    expect(prompt).toContain("首节点 Logo 补料轮");
    expect(prompt).toContain("保持当前首节点为 needs_verification");
    expect(prompt).toContain("不得确认或前进");
    expect(prompt).toContain("sourceKind=official_logo_upload");
    expect(prompt).toContain("imageSelection.method 必须为 customer_upload");
    expect(prompt).toContain(`"sourceUploadSha256":"${sha256}"`);
    expect(prompt).toContain('"sourceUploadFileId":"file-official-logo"');
    expect(prompt).toContain('"leafId":"1.1"');
    expect(prompt).toContain('"to":"needs_verification"');
    expect(prompt).not.toContain('"to":"confirmed"');
  });

  it("pins every confirmation to the exact canonical transition envelopes", async () => {
    const prompt = await buildKnowledgeBaseTurnPrompt({
      userId: 0,
      conversationId: "turn-contract",
      userMessage: "确认",
      attachments: [],
      skillVersion: "3",
      progressOverride: {
        build: { revision: 4, currentLeafId: "1.2" },
        branches: [
          {
            leaves: [
              {
                id: "1.2",
                title: "企业名称",
                branchTitle: "企业身份",
                status: "current",
              },
              {
                id: "1.3",
                title: "使命愿景",
                branchTitle: "企业身份",
                status: "pending",
              },
            ],
          },
        ],
      },
    });

    expect(prompt).toContain(
      '{"kind":"frontmind.knowledge-base.progress","schemaVersion":1,"revision":4,"transition":{"leafId":"1.2","from":"current","to":"confirmed","reason":"用户明确确认"}}',
    );
    expect(prompt).toContain(
      '{"kind":"frontmind.knowledge-base.presentation","schemaVersion":1,"revision":5,"leafId":"1.3","imageState":"no_eligible_asset","assetIds":[],"imageCount":0}',
    );
    expect(prompt).toContain("不得把 action、leafId、status 放在顶层");
    expect(prompt).not.toContain('"action":"confirm"');
    expect(
      prompt
        .trim()
        .endsWith(
          '<!-- FRONTMIND_KB_PRESENTATION\n{"kind":"frontmind.knowledge-base.presentation","schemaVersion":1,"revision":5,"leafId":"1.3","imageState":"no_eligible_asset","assetIds":[],"imageCount":0}\n-->',
        ),
    ).toBe(true);
    expect(prompt).toContain("用户已授权继续完成 FrontMind Dashboard");
    expect(prompt).toContain("不要求环境预装同名 Skill");
    expect(prompt).toContain("# 本轮回复结尾要求");
    for (const forbiddenPhrase of [
      "系统附件",
      "系统输入",
      "优先级",
      "最高优先级",
      "覆盖任务历史",
      "旧 Skill、旧回复或旧协议示例",
      "pasted_content",
      "严格执行",
    ]) {
      expect(prompt).not.toContain(forbiddenPhrase);
    }
  });

  it("forces the last confirmation to attach one scoped ZIP before ending", async () => {
    const prompt = await buildKnowledgeBaseTurnPrompt({
      userId: 0,
      conversationId: "final-package-contract",
      userMessage: "确认",
      attachments: [],
      skillVersion: "4",
      protocolOperation: {
        operationId: "final-package-operation",
        turnId: "final-package-turn",
      },
      finalizationInput: {
        filename: "frontmind-kb-finalization-input-aaaaaaaaaaaaaaaa.zip",
        sha256: "a".repeat(64),
        assetCount: 2,
      },
      progressOverride: {
        build: { revision: 46, currentLeafId: "7.2" },
        branches: [
          {
            leaves: [
              {
                id: "7.2",
                title: "极长节点标题".repeat(2_000),
                branchTitle: "极长分支标题".repeat(2_000),
                status: "current",
              },
            ],
          },
        ],
      },
    });

    expect(prompt.length).toBeLessThanOrEqual(3_000);
    expect(prompt).not.toContain("极长节点标题");
    expect(prompt).not.toContain("极长分支标题");
    expect(prompt).toContain("完成最终交付");
    expect(prompt).toContain("用户已授权继续完成 FrontMind Dashboard");
    expect(prompt).toContain("应用管理的工作流输入");
    expect(prompt).toContain("不属于 customerAttachments");
    expect(prompt).toContain("当前状态坐标记录的动作是 confirm");
    expect(prompt).toContain("application/zip");
    expect(prompt).toContain(
      "frontmind-kb-finalization-input-aaaaaaaaaaaaaaaa.zip",
    );
    expect(prompt).toContain(`SHA-256=${"a".repeat(64)}`);
    expect(prompt).toContain("2 个必须物理打包的图片素材");
    expect(prompt).toContain("references/output-format.md");
    expect(prompt).toContain("python3 scripts/validate_archive.py FINAL.zip");
    expect(prompt).toContain(
      "--finalization-input frontmind-kb-finalization-input-aaaaaaaaaaaaaaaa.zip",
    );
    expect(prompt).toContain(
      `--expected-finalization-sha256 ${"a".repeat(64)}`,
    );
    expect(prompt).toContain("--expected-operation-id final-package-operation");
    expect(prompt).toContain("--expected-turn-id final-package-turn");
    expect(prompt).toContain("requiredManifest 必须逐字段原样复制");
    expect(prompt).toContain("不得从任务历史生成 sourceUpload*");
    expect(prompt).toContain("Dashboard 已绑定的栅格字节");
    expect(prompt).toContain("未提供来源字段时保持省略");
    expect(prompt).toContain("不得猜测或补造");
    expect(prompt).toContain("official_logo_upload 必须与客户原始上传字节一致");
    expect(prompt).not.toContain("内部证据工作区");
    expect(prompt).toContain("VALID dashboard-enterprise-v1 archive");
    expect(prompt).toContain("README/TXT 素材占位");
    expect(prompt).toContain("唯一一个 type=output_file、MIME=application/zip");
    expect(prompt).toContain("operationId=final-package-operation");
    expect(prompt).toContain("turnId=final-package-turn");
    expect(prompt).toContain("成品 buildRevision=47");
    expect(prompt).toContain("资源进入 output 前不得结束");
    for (const forbiddenPhrase of [
      "系统附件",
      "系统输入",
      "优先级",
      "最高优先级",
      "覆盖任务历史",
      "旧 Skill、旧回复和旧协议示例",
      "pasted_content",
      "严格执行",
    ]) {
      expect(prompt).not.toContain(forbiddenPhrase);
    }
    expect(prompt.match(/<!-- FRONTMIND_KB_PROGRESS/gu)).toHaveLength(1);
    expect(prompt.match(/<!-- FRONTMIND_KB_PRESENTATION/gu)).toHaveLength(1);
    expect(prompt).not.toContain("# 本轮上传资料");
    expect(
      prompt
        .trim()
        .endsWith(
          '<!-- FRONTMIND_KB_PRESENTATION\n{"kind":"frontmind.knowledge-base.presentation","schemaVersion":2,"operationId":"final-package-operation","turnId":"final-package-turn","revision":47,"leafId":null,"imageState":"not_applicable","assetIds":[],"imageCount":0}\n-->',
        ),
    ).toBe(true);
  });

  it("accepts a Manus v2 final content transition without Logo or provider ZIP", async () => {
    const prompt = await buildKnowledgeBaseTurnPrompt({
      userId: 0,
      conversationId: "v2-content-completion-contract",
      userMessage: "确认",
      attachments: [],
      skillVersion: "4",
      contentCompletionOnly: true,
      protocolOperation: {
        operationId: "v2-content-operation",
        turnId: "v2-content-turn",
      },
      progressOverride: {
        build: { revision: 46, currentLeafId: "7.2" },
        branches: [
          {
            leaves: [
              {
                id: "7.2",
                title: "最终节点",
                branchTitle: "最终分支",
                status: "current",
              },
            ],
          },
        ],
      },
    });

    expect(prompt).toContain("FrontMind 内容完成轮");
    expect(prompt).toContain("Dashboard 在内容接受后异步生成");
    expect(prompt).toContain("不得创建或返回 ZIP、Logo、图片");
    expect(prompt).not.toContain("application/zip");
    expect(prompt).not.toContain("FINAL.zip");
    expect(prompt).not.toContain("finalization-input");
  });

  it("never turns an optional Logo into a Manus v2 confirmation gate", () => {
    const firstNodeWithoutLogo = {
      skillVersion: "4",
      status: "confirming",
      revision: 0,
      currentLeafId: "1.1",
      totalNodeCount: 40,
      confirmedCount: 0,
      directPrefilledCount: 0,
      logoSha256: null,
    };

    expect(knowledgeBaseBuildRequiresOfficialLogo(firstNodeWithoutLogo)).toBe(
      true,
    );
    expect(
      knowledgeBaseBuildRequiresOfficialLogo({
        ...firstNodeWithoutLogo,
        providerProtocol: "manus_v2",
      }),
    ).toBe(false);
  });

  it("keeps first and final Manus v2 turns non-blocking when Logo is absent", () => {
    const firstConfirm = knowledgeBaseTurnLogoPolicy({
      providerProtocol: "manus_v2",
      legacyLogoRequired: true,
    });
    const finalConfirm = knowledgeBaseTurnLogoPolicy({
      providerProtocol: "manus_v2",
      legacyLogoRequired: true,
    });

    for (const policy of [firstConfirm, finalConfirm]) {
      expect(policy.requiresOfficialLogo).toBe(false);
      expect(policy.inferOrdinaryAttachmentAsLogo).toBe(false);
      expect(policy.assertFinalLogoProvenance).toBe(false);
    }
    expect(
      knowledgeBasePresentationRequiresBoundLogo({
        skillVersion: "4",
        revision: 0,
        handled: 0,
        logoRequired: false,
        logoAvailable: false,
      }),
    ).toBe(false);
  });

  it("never infers an ordinary Manus v2 image attachment as Logo", () => {
    expect(
      knowledgeBaseTurnLogoPolicy({
        providerProtocol: "manus_v2",
        manualLogoSubmission: false,
        legacyLogoRequired: true,
      }),
    ).toMatchObject({
      requiresOfficialLogo: false,
      inferOrdinaryAttachmentAsLogo: false,
      readPersistedLogoSubmission: false,
      rejectRepeatedOfficialLogo: true,
    });
  });

  it("validates only explicit manual Logo submissions on Manus v2", () => {
    expect(
      knowledgeBaseTurnLogoPolicy({
        providerProtocol: "manus_v2",
        manualLogoSubmission: true,
        legacyLogoRequired: false,
      }),
    ).toMatchObject({
      requiresOfficialLogo: false,
      inferOrdinaryAttachmentAsLogo: false,
      validateManualLogoSubmission: true,
      readPersistedLogoSubmission: true,
      assertFinalLogoProvenance: false,
    });
  });

  it("preserves the legacy v1 Logo requirement and ordinary-image inference", () => {
    expect(
      knowledgeBaseTurnLogoPolicy({
        providerProtocol: "legacy_v1",
        manualLogoSubmission: false,
        legacyLogoRequired: true,
      }),
    ).toMatchObject({
      requiresOfficialLogo: true,
      inferOrdinaryAttachmentAsLogo: true,
      validateManualLogoSubmission: false,
      readPersistedLogoSubmission: true,
      acceptProviderDiscoveredLogo: true,
      assertFinalLogoProvenance: true,
    });
    expect(
      knowledgeBasePresentationRequiresBoundLogo({
        skillVersion: "4",
        revision: 0,
        handled: 0,
        logoRequired: false,
        logoAvailable: true,
      }),
    ).toBe(true);
  });

  it("preserves the actionable v4 archive failure instead of hiding it", () => {
    expect(
      knowledgeBaseArtifactFailureNotice(
        new KnowledgeBaseArtifactBindingError(
          "PACKAGE_INVALID",
          "新版知识库 ZIP 包含不支持的文件类型：assets/official_logo_README.txt",
        ),
      ),
    ).toEqual({
      code: "FINAL_PACKAGE_INVALID",
      message:
        "最终知识库 ZIP 不符合 Dashboard v4 归档合同：新版知识库 ZIP 包含不支持的文件类型：assets/official_logo_README.txt。本轮未推进；请重试本轮，系统会重新提供权威正文与全部素材，并要求生成端通过同一校验器后再交付。",
    });
  });

  it("classifies every pre-upstream recovery Logo failure as deterministic local preparation", () => {
    const invalid = knowledgeBaseRecoveryLogoPreparationError(
      new KnowledgeBaseArtifactBindingError(
        "LOGO_UPLOAD_INVALID",
        "上传的 Logo 原始字节校验失败，请重新上传",
      ),
    );
    expect(invalid).toMatchObject({
      name: "KnowledgeBaseLocalPreparationError",
      code: "KNOWLEDGE_BASE_LOGO_UPLOAD_INVALID",
      message: "上传的 Logo 原始字节校验失败，请重新上传",
    });

    const stale = knowledgeBaseRecoveryLogoPreparationError(
      new KnowledgeBaseArtifactBindingError(
        "BUILD_CHANGED",
        "当前首个知识节点状态已变化，请刷新后重新上传 Logo",
      ),
    );
    expect(stale).toMatchObject({
      name: "KnowledgeBaseLocalPreparationError",
      code: "KNOWLEDGE_BASE_LOGO_UPLOAD_INVALID",
    });

    const unreadable = knowledgeBaseRecoveryLogoPreparationError(
      new Error("sensitive storage detail"),
    );
    expect(unreadable).toMatchObject({
      name: "KnowledgeBaseLocalPreparationError",
      code: "KNOWLEDGE_BASE_LOGO_UPLOAD_INVALID",
      message: "企业官方主 Logo 无法从本轮受管上传恢复，请重新上传",
    });
    expect(unreadable.message).not.toContain("sensitive storage detail");
  });

  it("formats a retry with only the new operation and turn envelope identity", async () => {
    const prompt = await buildKnowledgeBaseTurnPrompt({
      userId: 0,
      conversationId: "retry-contract",
      userMessage: "确认",
      attachments: [],
      skillVersion: "4",
      protocolOperation: {
        operationId: "new-retry-operation",
        turnId: "new-retry-turn",
      },
      progressOverride: {
        build: { revision: 4, currentLeafId: "1.2" },
        branches: [
          {
            leaves: [
              {
                id: "1.2",
                title: "企业名称",
                branchTitle: "企业身份",
                status: "current",
              },
              {
                id: "1.3",
                title: "使命愿景",
                branchTitle: "企业身份",
                status: "pending",
              },
            ],
          },
        ],
      },
    });

    expect(prompt).toContain('"operationId":"new-retry-operation"');
    expect(prompt).toContain('"turnId":"new-retry-turn"');
    expect(prompt).not.toContain("failed-task-must-not-be-reused");
    expect(prompt).not.toContain("old-operation");
  });

  it("balances historical prefill across branches and caps it at 80,000 characters", () => {
    const documents = [
      {
        path: "01_identity/overview.md",
        title: "企业概览",
        content: "甲".repeat(30_000),
      },
      {
        path: "01_identity/history.md",
        title: "发展历程",
        content: "乙".repeat(30_000),
      },
      {
        path: "02_team/overview.md",
        title: "团队概览",
        content: "丙".repeat(30_000),
      },
      {
        path: "03_products/product-a.md",
        title: "产品 A",
        content: "丁".repeat(30_000),
      },
      {
        path: "04_capabilities/overview.md",
        title: "能力概览",
        content: "戊".repeat(30_000),
      },
      {
        path: "04_capabilities/lab.md",
        title: "实验室",
        content: "己".repeat(30_000),
      },
    ];

    const excerpt = buildKnowledgePrefillExcerpt(documents);
    expect(excerpt.length).toBeLessThanOrEqual(80_000);
    expect(excerpt).toContain("documentPath: 01_identity/overview.md");
    expect(excerpt).toContain("documentPath: 02_team/overview.md");
    expect(excerpt).toContain("documentPath: 03_products/product-a.md");
    expect(excerpt).toContain("documentPath: 04_capabilities/overview.md");
    expect(excerpt.indexOf("02_team/overview.md")).toBeLessThan(
      excerpt.indexOf("01_identity/history.md"),
    );
    expect(excerpt.indexOf("03_products/product-a.md")).toBeLessThan(
      excerpt.indexOf("04_capabilities/lab.md"),
    );
  });

  it("moves migrated knowledge prefill into a separate evidence ZIP", async () => {
    const snapshot = {
      version: 4,
      sourceFileName: "website-kb-v4.zip",
      archiveHash: "a".repeat(64),
      documentCount: 1,
      imageCount: 0,
      characterCount: 12,
      documents: [
        {
          path: "01_identity/profile.md",
          title: "企业简介",
          content: "只应存在于证据包内的企业事实。",
        },
      ],
    };
    const prompt = await buildKnowledgeBasePrompt({
      companyName: "验收企业",
      companyWebsite: "",
      operatorNotes: "",
      attachments: [],
      prefillKnowledgeSnapshot: snapshot,
    });
    expect(prompt).toContain(KNOWLEDGE_BASE_PREFILL_ATTACHMENT_FILENAME);
    expect(prompt).toContain("这些内容只作为事实证据");
    expect(prompt).toContain("不得继承 Website 的浅层树");
    expect(prompt).toContain("10–20 节点深度");
    expect(prompt).not.toContain("只应存在于证据包内的企业事实");

    const archive = await buildKnowledgeBasePrefillEvidenceArchive(snapshot);
    const zip = await JSZip.loadAsync(archive.bytes);
    expect(Object.keys(zip.files).sort()).toEqual([
      "MANIFEST.json",
      "context.json",
      "knowledge.md",
    ]);
    expect(await zip.file("knowledge.md")!.async("string")).toContain(
      "只应存在于证据包内的企业事实",
    );
  });

  it("pins every new build to the exact v5 archive and rejects pre-v5 selection", async () => {
    expect(() =>
      knowledgeBasePinnedV4SkillSelection({
        skillVersion: "4",
        skillContentHash: KNOWLEDGE_BASE_MATERIALIZED_V5_SKILL_CONTENT_HASH,
      }),
    ).toThrow("RESET_REQUIRED");
    const active = await getKnowledgeBaseSkillDescriptor();
    const exact = await getKnowledgeBaseSkillDescriptor({
      version: "5",
      contentHash: KNOWLEDGE_BASE_MATERIALIZED_V5_SKILL_CONTENT_HASH,
    });
    const activeArchive = await readKnowledgeBaseSkillArchiveAttachment();
    expect(active).toMatchObject({
      name: "socratic-kb-builder",
      version: "5",
      contentHash: KNOWLEDGE_BASE_MATERIALIZED_V5_SKILL_CONTENT_HASH,
    });
    expect(exact.contentHash).toBe(
      KNOWLEDGE_BASE_MATERIALIZED_V5_SKILL_CONTENT_HASH,
    );
    expect(active.contentHash).toBe(
      await canonicalKnowledgeBaseSkillArchiveHash(activeArchive.bytes),
    );
    for (const version of ["1", "2", "3", "4"]) {
      await expect(
        getKnowledgeBaseSkillDescriptor({ version }),
      ).rejects.toThrow("RESET_REQUIRED");
    }
  });

  it("resolves only the exact current v5 logical hash", async () => {
    await expect(
      getKnowledgeBaseSkillDescriptor({
        version: "5",
        contentHash: KNOWLEDGE_BASE_MATERIALIZED_V5_SKILL_CONTENT_HASH,
      }),
    ).resolves.toMatchObject({
      version: "5",
      contentHash: KNOWLEDGE_BASE_MATERIALIZED_V5_SKILL_CONTENT_HASH,
    });
    await expect(
      getKnowledgeBaseSkillDescriptor({
        version: "5",
        contentHash: "0".repeat(64),
      }),
    ).rejects.toThrow();
  });

  it("defers ambiguous v3 response images to the ZIP manifest without weakening v4", () => {
    expect(shouldBindKnowledgeBaseInitialLogo("3", 3)).toBe(false);
    expect(shouldBindKnowledgeBaseInitialLogo("3", 1)).toBe(false);
    expect(shouldBindKnowledgeBaseInitialLogo("4", 3)).toBe(true);
    expect(shouldBindKnowledgeBaseInitialLogo("4", 0)).toBe(false);
  });

  it("uploads the Skill ZIP through the exact signed URL without auth headers", async () => {
    const archive = await readKnowledgeBaseSkillArchiveAttachment();
    const uploadUrl =
      "https://uploads.example.test/socratic.skill.zip?X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Signature=abc";
    const apiPost = vi.fn().mockResolvedValue({
      status: 200,
      data: {
        ok: true,
        file: {
          id: "skill-file-1",
          filename: "socratic-kb-builder-v5.skill.zip",
        },
        upload_url: uploadUrl,
        upload_expires_at: Math.floor(Date.now() / 1_000) + 180,
      },
    });
    const put = vi.spyOn(axios, "put").mockResolvedValue({
      status: 200,
      data: "",
    });
    const apiGet = vi.fn().mockResolvedValue({
      status: 200,
      data: {
        ok: true,
        file: {
          id: "skill-file-1",
          filename: "socratic-kb-builder-v5.skill.zip",
          status: "uploaded",
          bytes: archive.bytes.length,
          content_type: "application/zip",
          expires_at: Math.floor(Date.now() / 1_000) + 48 * 60 * 60,
        },
      },
    });
    vi.spyOn(axios, "create").mockReturnValue({
      post: apiPost,
      get: apiGet,
    } as unknown as ReturnType<typeof axios.create>);

    const uploaded = await uploadKnowledgeBaseSkillArchive({
      baseUrl: "https://api.example.test",
      apiKey: "secret-test-key",
    });

    expect(uploaded.attachment).toEqual({
      file_id: "skill-file-1",
      filename: "socratic-kb-builder-v5.skill.zip",
    });
    expect(apiPost).toHaveBeenCalledWith(
      "https://api.example.test/v2/file.upload",
      { filename: "socratic-kb-builder-v5.skill.zip" },
      { headers: { "Content-Type": "application/json" } },
    );
    expect(put).toHaveBeenCalledTimes(1);
    expect(put.mock.calls[0]?.[0]).toBe(uploadUrl);
    expect(put.mock.calls[0]?.[2]).toMatchObject({
      maxRedirects: 0,
      headers: {
        "Content-Type": "application/zip",
      },
    });
    expect(put.mock.calls[0]?.[2]?.headers).not.toHaveProperty("Authorization");
    expect(put.mock.calls[0]?.[2]?.headers).not.toHaveProperty("API_KEY");
  });

  it("creates an isolated v2 task without leaking legacy task coordinates", async () => {
    const requestBody = {
      prompt: "固定的恢复提示词",
      agentProfile: "manus-1.6-max",
      taskMode: "agent" as const,
      attachments: [
        {
          file_id: "frozen-skill-file",
          filename: "socratic-kb-builder-v5.skill.zip",
        },
        { file_id: "frozen-facts-file", filename: "facts.pdf" },
      ],
      taskId: "parent-task",
    };
    const post = mockManusV2Post({
      status: 200,
      data: { ok: true, task_id: "original-task" },
    });

    const result = await createFrontMindTask({
      baseUrl: "https://api.example.test",
      apiKey: "credential-value",
      requestBody,
      idempotencyKey: "frontmind-kb-v2:operation-one",
    });

    expect(result).toMatchObject({
      ok: true,
      task: { id: "original-task", status: "running" },
    });
    expect(post).toHaveBeenCalledTimes(1);
    expect(post.mock.calls[0]?.[0]).toBe(
      "https://api.example.test/v2/task.create",
    );
    expect(post.mock.calls[0]?.[1]).toEqual(
      buildManusV2CreateTaskBody({
        prompt: requestBody.prompt,
        attachments: requestBody.attachments,
        agentProfile: requestBody.agentProfile,
        locale: "zh-CN",
        interactiveMode: false,
      }),
    );
    expect(post.mock.calls[0]?.[2]).toMatchObject({
      headers: { "Content-Type": "application/json" },
    });
    expect(axios.create).toHaveBeenCalledWith(
      expect.objectContaining({
        headers: { "x-manus-api-key": "credential-value" },
      }),
    );
    expect(JSON.stringify(post.mock.calls[0]?.[1])).not.toContain(
      "parent-task",
    );
  });

  it("keeps seven or eight attachments behind both readiness barriers and preserves five-user order", async () => {
    const userAttachments = Array.from({ length: 5 }, (_, index) => ({
      file_id: `user-file-${index + 1}`,
      filename: `client-${index + 1}.pdf`,
    }));
    const generatedAttachments = [
      { file_id: "skill-file", filename: "skill.zip" },
      { file_id: "instructions-file", filename: "instructions.txt" },
      { file_id: "prefill-file", filename: "prefill.txt" },
    ];
    const attachments = [
      generatedAttachments[0]!,
      generatedAttachments[1]!,
      ...userAttachments,
    ];
    let userThreePending = true;
    const get = vi.fn().mockImplementation(async (_url, config) => {
      const fileId = String(config?.params?.file_id || "");
      const userIndex = userAttachments.findIndex(
        (attachment) => attachment.file_id === fileId,
      );
      const generated = generatedAttachments.find(
        (attachment) => attachment.file_id === fileId,
      );
      return {
        status: 200,
        data: {
          ok: true,
          file: {
            id: fileId,
            filename:
              userIndex >= 0
                ? `provider-${userIndex + 1}.pdf`
                : generated?.filename,
            status:
              fileId === "user-file-3" && userThreePending
                ? "pending"
                : "uploaded",
            bytes: null,
            expires_at: Math.floor(Date.now() / 1_000) + 48 * 60 * 60,
          },
        },
      } as any;
    });
    const post = vi.fn().mockResolvedValue({
      status: 201,
      data: { ok: true, task_id: "task-seven-attachments" },
    });
    vi.spyOn(axios, "create").mockReturnValue({
      get,
      post,
    } as unknown as ReturnType<typeof axios.create>);
    const claim = {
      turn: {
        id: "turn-seven-attachments",
        buildId: "build-seven-attachments",
        traceId: "a0c7502e-4c1f-4d06-8ab6-407e8a82c138",
      },
      recoveryMetadata: { attachments: userAttachments },
    } as any;
    const credential = { apiKey: "credential-value" } as any;

    await expect(
      waitForKnowledgeBaseDispatchAttachments({
        claim,
        credential,
        baseUrl: "https://api.example.test",
        attachments,
        readinessDeadlineMs: 0,
      }),
    ).rejects.toMatchObject({
      code: "KNOWLEDGE_BASE_ATTACHMENTS_PROCESSING",
      pendingCount: 1,
    });
    expect(post).not.toHaveBeenCalled();

    userThreePending = false;
    const canonical = await waitForKnowledgeBaseDispatchAttachments({
      claim,
      credential,
      baseUrl: "https://api.example.test",
      attachments,
      readinessDeadlineMs: 0,
    });
    expect(canonical.map((attachment) => attachment.file_id)).toEqual(
      attachments.map((attachment) => attachment.file_id),
    );
    expect(canonical.slice(2).map((attachment) => attachment.filename)).toEqual(
      Array.from({ length: 5 }, (_, index) => `provider-${index + 1}.pdf`),
    );
    const dispatch = {
      schemaVersion: 2 as const,
      baseUrl: "https://api.example.test",
      requestBody: {
        prompt: "documented task body",
        agentProfile: "manus-1.6-max",
        attachments: canonical,
      },
      bodySha256: "d".repeat(64),
      preparedAt: "2026-08-11T00:00:00.000Z",
    };
    await checkKnowledgeBasePreparedAttachments({
      claim,
      credential,
      dispatch,
    });
    await expect(
      createFrontMindTask({
        baseUrl: dispatch.baseUrl,
        apiKey: credential.apiKey,
        requestBody: dispatch.requestBody,
      }),
    ).resolves.toMatchObject({ ok: true });
    expect(post).toHaveBeenCalledTimes(1);
    expect(post.mock.calls[0]?.[0]).toBe(
      "https://api.example.test/v2/task.create",
    );

    post.mockClear();
    const eightAttachments = [
      generatedAttachments[0]!,
      generatedAttachments[2]!,
      generatedAttachments[1]!,
      ...userAttachments,
    ];
    const canonicalWithPrefill = await waitForKnowledgeBaseDispatchAttachments({
      claim,
      credential,
      baseUrl: "https://api.example.test",
      attachments: eightAttachments,
      readinessDeadlineMs: 0,
    });
    expect(
      canonicalWithPrefill.map((attachment) => attachment.file_id),
    ).toEqual(eightAttachments.map((attachment) => attachment.file_id));
    expect(
      canonicalWithPrefill.slice(3).map((attachment) => attachment.filename),
    ).toEqual(
      Array.from({ length: 5 }, (_, index) => `provider-${index + 1}.pdf`),
    );
    const prefillDispatch = {
      ...dispatch,
      requestBody: {
        ...dispatch.requestBody,
        attachments: canonicalWithPrefill,
      },
    };
    await checkKnowledgeBasePreparedAttachments({
      claim,
      credential,
      dispatch: prefillDispatch,
    });
    await expect(
      createFrontMindTask({
        baseUrl: prefillDispatch.baseUrl,
        apiKey: credential.apiKey,
        requestBody: prefillDispatch.requestBody,
      }),
    ).resolves.toMatchObject({ ok: true });
    expect(post).toHaveBeenCalledTimes(1);
    expect(post.mock.calls[0]?.[1]).toEqual(
      buildManusV2CreateTaskBody({
        prompt: prefillDispatch.requestBody.prompt,
        attachments: prefillDispatch.requestBody.attachments,
        agentProfile: prefillDispatch.requestBody.agentProfile,
        locale: "zh-CN",
        interactiveMode: false,
      }),
    );
    expect(get).toHaveBeenCalled();
  });

  it("accepts the v2 task id and treats a 2xx response without it as outcome-unknown", async () => {
    const post = mockManusV2Post(
      {
        status: 201,
        data: { ok: true, task_id: "v2-task-id" },
      },
      {
        status: 200,
        data: { ok: true },
      },
    );

    await expect(
      createFrontMindTask({
        baseUrl: "https://api.example.test",
        apiKey: "credential-value",
        agentProfile: "manus-1.6-max",
        prompt: "wrapped",
      }),
    ).resolves.toMatchObject({
      ok: true,
      task: {
        id: "v2-task-id",
        status: "running",
      },
    });
    await expect(
      createFrontMindTask({
        baseUrl: "https://api.example.test",
        apiKey: "credential-value",
        agentProfile: "manus-1.6-max",
        prompt: "missing id",
      }),
    ).resolves.toMatchObject({
      ok: false,
      failureClass: "unknown",
      failureCode: "UPSTREAM_CREATE_TRANSPORT_UNKNOWN",
    });
    expect(post).toHaveBeenCalledTimes(2);
  });

  it.each([
    {
      status: 425,
      data: { error: { code: "IDEMPOTENCY_PENDING" } },
      expectedFailureClass: "unknown",
      expectedFailureCode: "UPSTREAM_CREATE_HTTP_425",
    },
    {
      status: 409,
      data: { error: { code: "IDEMPOTENCY_PENDING" } },
      expectedFailureClass: "unknown",
      expectedFailureCode: "UPSTREAM_CREATE_HTTP_409",
    },
    {
      status: 409,
      data: { error: { code: "TASK_STATE_CONFLICT" } },
      expectedFailureClass: "deterministic",
      expectedFailureCode: "UPSTREAM_CREATE_HTTP_409",
    },
    {
      status: 422,
      data: { error: { code: "IDEMPOTENCY_PENDING" } },
      expectedFailureClass: "unknown",
      expectedFailureCode: "UPSTREAM_CREATE_HTTP_422",
    },
    {
      status: 422,
      data: { error: { code: "INVALID_ATTACHMENT" } },
      expectedFailureClass: "deterministic",
      expectedFailureCode: "UPSTREAM_CREATE_HTTP_422",
    },
  ] as const)(
    "classifies upstream HTTP $status as $expectedFailureClass only from its explicit contract",
    async ({ status, data, expectedFailureClass, expectedFailureCode }) => {
      mockManusV2Post({
        status,
        data: { ok: false, ...data },
      });

      await expect(
        createFrontMindTask({
          baseUrl: "https://api.example.test",
          apiKey: "credential-value",
          agentProfile: "manus-1.6-max",
          prompt: "manual Logo",
          idempotencyKey: "frontmind-kb-v2:manual-logo-operation",
        }),
      ).resolves.toMatchObject({
        ok: false,
        status,
        failureClass: expectedFailureClass,
        failureCode: expectedFailureCode,
      });
    },
  );

  it("keeps numeric provider code 3 but never persists an arbitrary provider code", async () => {
    const post = mockManusV2Post(
      {
        status: 400,
        data: {
          ok: false,
          error: { code: "3", message: "invalid argument" },
        },
      },
      {
        status: 422,
        data: {
          ok: false,
          error: {
            code: "FILE_ID_CUSTOMER_SECRET_ABC123",
            message: "attachment rejected",
          },
        },
      },
    );

    const numeric = await createFrontMindTask({
      baseUrl: "https://api.example.test",
      apiKey: "credential-value",
      agentProfile: "manus-1.6-max",
      prompt: "numeric provider code",
    });
    expect(numeric).toMatchObject({
      ok: false,
      failureCode: "UPSTREAM_CREATE_3",
      reasonCategory: "UNKNOWN_INVALID_ARGUMENT",
    });

    const malicious = await createFrontMindTask({
      baseUrl: "https://api.example.test",
      apiKey: "credential-value",
      agentProfile: "manus-1.6-max",
      prompt: "untrusted provider code",
    });
    expect(malicious).toMatchObject({
      ok: false,
      failureCode: "UPSTREAM_CREATE_HTTP_422",
      reasonCategory: "ATTACHMENT_INVALID",
    });
    expect(JSON.stringify(malicious)).not.toContain(
      "FILE_ID_CUSTOMER_SECRET_ABC123",
    );

    const failDeterministically = vi.fn().mockResolvedValue(undefined);
    const markOutcomeUnknown = vi.fn().mockResolvedValue(undefined);
    await persistKnowledgeBaseCreateFailure(
      {
        userId: 7,
        turnId: "turn-provider-code-safety",
        leaseToken: "lease-provider-code-safety",
        outcomeUnknownCode: "SHOULD_NOT_BE_USED",
        error: new KnowledgeBaseUpstreamCreateError(
          (malicious as any).failureClass,
          (malicious as any).failureCode,
          (malicious as any).status,
          (malicious as any).reasonCategory,
        ),
      },
      { failDeterministically, markOutcomeUnknown },
    );
    expect(failDeterministically).toHaveBeenCalledWith(
      expect.objectContaining({
        code: "UPSTREAM_CREATE_HTTP_422",
        recoveryAction: "contact_support",
      }),
    );
    expect(JSON.stringify(failDeterministically.mock.calls)).not.toContain(
      "FILE_ID_CUSTOMER_SECRET_ABC123",
    );
    expect(markOutcomeUnknown).not.toHaveBeenCalled();
    expect(post).toHaveBeenCalledTimes(2);
  });

  it("freezes and sends zh-CN on every fresh materialized v5 task create", async () => {
    const operationKey = "e".repeat(64);
    const turnId = "00000000-0000-4000-8000-0000000000e5";
    const build = {
      id: "00000000-0000-4000-8000-0000000000b5",
      userId: 7,
      conversationId: "conversation-materialized-zh-cn",
      generation: 2,
      revision: 4,
      executionMode: "materialized_bundle_v1",
      skillVersion: "5",
      skillContentHash: KNOWLEDGE_BASE_MATERIALIZED_V5_SKILL_CONTENT_HASH,
      providerProtocol: "manus_v2",
      contentVersion: 1,
      handoffProvenance: {
        materializedRecoveryContractVersion: 1,
        materializedCompletionContractVersion: 2,
      },
    } as any;
    const claim = {
      turn: {
        id: turnId,
        userId: 7,
        conversationId: build.conversationId,
        buildId: build.id,
        buildGeneration: build.generation,
        expectedRevision: build.revision,
        expectedLeafId: "2.1",
        operationType: "revise",
        operationKey,
        operationToken: operationKey,
        status: "running",
        upstreamTaskId: null,
        providerProtocol: "manus_v2",
        providerMethod: "task.create",
        materializedRecoveryContractVersion: 1,
        materializedCompletionContractVersion: 2,
        providerAttemptState: "not_sent",
        createAttemptState: "not_sent",
      },
      leaseToken: "lease-materialized-zh-cn",
      upstreamIdempotencyKey: `frontmind-kb-v2:${operationKey}`,
      recoveryMetadata: {
        kind: "turn",
        conversationId: build.conversationId,
        parentTaskId: null,
      },
      preparedDispatch: null,
    } as any;
    const prepared = {
      schemaVersion: 2 as const,
      baseUrl: "https://api.example.test",
      requestBody: {
        prompt: "只返回本轮 Patch ZIP",
        agentProfile: "manus-1.6",
        attachments: [],
      },
      bodySha256: "b".repeat(64),
      preparedAt: "2026-08-14T00:00:00.000Z",
    };
    const title = `FrontMind KB ${build.id} g${build.generation} ${turnId}`;
    const createTask = vi.fn().mockResolvedValue({
      taskId: "materialized-task-zh-cn",
      taskUrl: null,
      requestId: "request-materialized-zh-cn",
    });
    const sendMessage = vi.fn();
    const beginDispatch = vi.fn().mockResolvedValue({
      method: "task.create",
      canonicalTaskId: null,
      operationToken: operationKey,
      title,
    });
    const bindSubmission = vi.fn().mockResolvedValue(undefined);

    await expect(
      knowledgeBaseTerminalAnchorRecoveryTestHooks.dispatchKnowledgeBaseRecoveryClaim(
        claim,
        { id: "credential-base", apiKey: "base-secret" } as any,
        {
          loadBuild: vi.fn().mockResolvedValue(build),
          ensureDispatch: vi.fn().mockResolvedValue(prepared),
          ensureManusV2Attachments: vi.fn().mockResolvedValue([]),
          beginDispatch,
          bindSubmission,
          deferProviderStatus: vi.fn().mockResolvedValue({
            state: "deferred",
            retryAfterMs: 15_000,
            ledger: { schemaVersion: 1 },
          }),
          createClient: vi.fn().mockReturnValue({
            createTask,
            sendMessage,
            updateTaskVisibility: vi.fn(),
            findCreatedTask: vi.fn(),
            listAllMessages: vi.fn().mockResolvedValue([]),
          }),
        } as any,
      ),
    ).resolves.toEqual({
      taskId: "materialized-task-zh-cn",
      rebound: true,
      reconciled: false,
    });

    expect(sendMessage).not.toHaveBeenCalled();
    expect(createTask).toHaveBeenCalledWith({
      prompt: prepared.requestBody.prompt,
      attachments: [],
      title,
      agentProfile: "manus-1.6",
      locale: "zh-CN",
    });
    const frozenBodyHash = createHash("sha256")
      .update(
        JSON.stringify(
          buildManusV2CreateTaskBody(createTask.mock.calls[0]![0]),
        ),
      )
      .digest("hex");
    expect(beginDispatch).toHaveBeenCalledWith(
      expect.objectContaining({
        expectedMethod: "task.create",
        frozenProviderRequestHash: frozenBodyHash,
      }),
    );
    expect(bindSubmission).toHaveBeenCalledWith(
      expect.objectContaining({
        method: "task.create",
        taskId: "materialized-task-zh-cn",
      }),
    );
  });

  it("activates a valid running ZIP before a best-effort task.stop", async () => {
    const operationKey = "7".repeat(64);
    const taskId = "materialized-task-contract-v2-running";
    const turnId = "00000000-0000-4000-8000-0000000000f7";
    const build = {
      id: "00000000-0000-4000-8000-0000000000c7",
      userId: 7,
      conversationId: "conversation-materialized-contract-v2-running",
      companyName: "Completion Company",
      companyWebsite: "https://completion.example.test",
      generation: 1,
      revision: 0,
      treePolicyVersion: 2,
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
    const claim = {
      turn: {
        id: turnId,
        userId: 7,
        conversationId: build.conversationId,
        buildId: build.id,
        buildGeneration: 1,
        expectedRevision: 0,
        expectedLeafId: null,
        expectedUserAttachmentCount: 0,
        operationType: "start",
        operationKey,
        operationToken: operationKey,
        status: "running",
        upstreamTaskId: taskId,
        providerProtocol: "manus_v2",
        providerMethod: "task.create",
        materializedRecoveryContractVersion: 1,
        materializedCompletionContractVersion: 2,
        materializedCompletion: null,
        providerAttemptState: "output_pending",
        createAttemptState: "acknowledged",
      },
      leaseToken: "lease-materialized-contract-v2-running",
      recoveryMetadata: { kind: "start", conversationId: build.conversationId },
      preparedDispatch: null,
    } as any;
    const expectedFilename = `frontmind-kb-bundle-${operationKey}.zip`;
    const events = [
      {
        id: "assistant-contract-v2-zip",
        type: "assistant_message",
        timestamp: 10,
        assistant_message: {
          // The sentence helps Manus converge naturally, but Dashboard only
          // consumes and validates the ZIP.
          content: "",
          attachments: [
            {
              type: "file",
              filename: "manus-materialized-result.zip",
              content_type: "application/zip",
              url: "https://downloads.example.test/contract-v2.zip",
            },
          ],
        },
      },
      {
        id: "status-contract-v2-running",
        type: "status_update",
        timestamp: 11,
        status_update: { agent_status: "running" },
      },
    ];
    const prepared = {
      schemaVersion: 2 as const,
      baseUrl: "https://api.example.test",
      requestBody: {
        prompt: "bundle",
        agentProfile: "manus-1.6",
        attachments: [],
      },
      bodySha256: "b".repeat(64),
      preparedAt: "2026-08-15T00:00:00.000Z",
    };
    const archive = Buffer.from("fully-validated-running-bundle");
    const retained = {
      storageKey: "knowledge-base/build-sources/7/candidate.bin",
      contentSha256: createHash("sha256").update(archive).digest("hex"),
      sizeBytes: archive.length,
    };
    const stopTask = vi.fn().mockResolvedValue({
      taskId,
      requestId: "stop-request-contract-v2",
    });
    const createTask = vi.fn();
    const findCreatedTask = vi.fn();
    const sendMessage = vi.fn();
    const deleteTask = vi.fn();
    const settleStop = vi.fn().mockResolvedValue(undefined);
    const activateInitial = vi.fn();

    await expect(
      knowledgeBaseTerminalAnchorRecoveryTestHooks.dispatchKnowledgeBaseRecoveryClaim(
        claim,
        { id: "credential-base", apiKey: "base-secret" } as any,
        {
          loadBuild: vi.fn().mockResolvedValue(build),
          ensureDispatch: vi.fn().mockResolvedValue(prepared),
          ensureManusV2Attachments: vi.fn(),
          beginDispatch: vi.fn(),
          bindSubmission: vi.fn(),
          downloadArchive: vi.fn().mockResolvedValue({
            buffer: archive,
            contentType: "application/zip",
          }),
          validateInitialCandidate: vi
            .fn()
            .mockResolvedValue({ archiveBytes: archive }),
          persistCandidate: vi.fn().mockResolvedValue(retained),
          observeCandidate: vi.fn().mockResolvedValue({
            disposition: "stop_due",
            ledger: {
              schemaVersion: 1,
              candidateEventIdHash: "c".repeat(64),
              storageKey: retained.storageKey,
              candidateArchiveSha256: retained.contentSha256,
              sizeBytes: retained.sizeBytes,
              firstObservedAt: "2026-08-15T00:00:00.000Z",
              lastObservedAt: "2026-08-15T00:02:30.000Z",
              stableAt: "2026-08-15T00:00:30.000Z",
              naturalStopDeadlineAt: "2026-08-15T00:02:30.000Z",
            },
            deduplicated: true,
          }),
          beginStop: vi.fn().mockResolvedValue({
            send: true,
            ledger: { schemaVersion: 1, stopAttemptState: "sending" },
          }),
          settleStop,
          activateInitial,
          createClient: vi.fn().mockReturnValue({
            createTask,
            findCreatedTask,
            listAllMessages: vi.fn().mockResolvedValue(events),
            stopTask,
            sendMessage,
            deleteTask,
          }),
        } as any,
      ),
    ).resolves.toEqual({ taskId, rebound: true, reconciled: true });

    expect(stopTask).toHaveBeenCalledOnce();
    expect(stopTask).toHaveBeenCalledWith(taskId);
    expect(settleStop).not.toHaveBeenCalled();
    expect(activateInitial).toHaveBeenCalledOnce();
    expect(activateInitial.mock.invocationCallOrder[0]).toBeLessThan(
      stopTask.mock.invocationCallOrder[0]!,
    );
    expect(createTask).not.toHaveBeenCalled();
    expect(findCreatedTask).not.toHaveBeenCalled();
    expect(sendMessage).not.toHaveBeenCalled();
    expect(deleteTask).not.toHaveBeenCalled();

    const ambiguousStop = vi
      .fn()
      .mockRejectedValue(
        new ManusV2ApiError("task.stop", null, "timeout", true, true),
      );
    const settleUnknown = vi.fn().mockResolvedValue(undefined);
    const activateDespiteStopFailure = vi.fn().mockResolvedValue(undefined);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    await expect(
      knowledgeBaseTerminalAnchorRecoveryTestHooks.dispatchKnowledgeBaseRecoveryClaim(
        claim,
        { id: "credential-base", apiKey: "base-secret" } as any,
        {
          loadBuild: vi.fn().mockResolvedValue(build),
          ensureDispatch: vi.fn().mockResolvedValue(prepared),
          downloadArchive: vi.fn().mockResolvedValue({
            buffer: archive,
            contentType: "application/zip",
          }),
          validateInitialCandidate: vi
            .fn()
            .mockResolvedValue({ archiveBytes: archive }),
          persistCandidate: vi.fn().mockResolvedValue(retained),
          observeCandidate: vi.fn().mockResolvedValue({
            disposition: "stop_due",
            ledger: {
              schemaVersion: 1,
              candidateEventIdHash: "c".repeat(64),
              storageKey: retained.storageKey,
              candidateArchiveSha256: retained.contentSha256,
              sizeBytes: retained.sizeBytes,
              stableAt: "2026-08-15T00:00:30.000Z",
              naturalStopDeadlineAt: "2026-08-15T00:02:30.000Z",
            },
            deduplicated: true,
          }),
          beginStop: vi.fn().mockResolvedValue({
            send: true,
            ledger: { schemaVersion: 1, stopAttemptState: "sending" },
          }),
          settleStop: settleUnknown,
          activateInitial: activateDespiteStopFailure,
          createClient: vi.fn().mockReturnValue({
            createTask: vi.fn(),
            findCreatedTask: vi.fn(),
            listAllMessages: vi.fn().mockResolvedValue(events),
            stopTask: ambiguousStop,
            sendMessage: vi.fn(),
            deleteTask: vi.fn(),
          }),
        } as any,
      ),
    ).resolves.toEqual({ taskId, rebound: true, reconciled: true });
    await Promise.resolve();
    expect(ambiguousStop).toHaveBeenCalledOnce();
    expect(settleUnknown).not.toHaveBeenCalled();
    expect(activateDespiteStopFailure).toHaveBeenCalledOnce();
    warn.mockRestore();
  });

  it("applies the latest verifiable running PATCH when several ZIP descriptors exist", async () => {
    const operationKey = "8".repeat(64);
    const taskId = "materialized-task-multiple-patches";
    const turnId = "00000000-0000-4000-8000-0000000000f8";
    const expectedFilename = `frontmind-kb-patch-${operationKey}.zip`;
    const build = {
      id: "00000000-0000-4000-8000-0000000000c8",
      userId: 7,
      conversationId: "conversation-materialized-multiple-patches",
      generation: 2,
      revision: 3,
      executionMode: "materialized_bundle_v1",
      skillVersion: "5",
      skillContentHash: KNOWLEDGE_BASE_MATERIALIZED_V5_SKILL_CONTENT_HASH,
      providerProtocol: "manus_v2",
      contentVersion: 4,
      handoffProvenance: {
        materializedRecoveryContractVersion: 1,
        materializedCompletionContractVersion: 2,
      },
    } as any;
    const claim = {
      turn: {
        id: turnId,
        userId: 7,
        conversationId: build.conversationId,
        buildId: build.id,
        buildGeneration: build.generation,
        expectedRevision: build.revision,
        expectedLeafId: "2.1",
        expectedUserAttachmentCount: 1,
        operationType: "revise",
        operationKey,
        operationToken: operationKey,
        status: "running",
        upstreamTaskId: taskId,
        providerProtocol: "manus_v2",
        providerMethod: "task.create",
        materializedRecoveryContractVersion: 1,
        materializedCompletionContractVersion: 2,
        materializedCompletion: null,
        providerAttemptState: "output_pending",
        createAttemptState: "acknowledged",
      },
      leaseToken: "lease-materialized-multiple-patches",
      recoveryMetadata: { kind: "turn" },
      preparedDispatch: null,
    } as any;
    const descriptorEvent = (
      id: string,
      timestamp: number,
      filename: string,
      url: string,
    ) => ({
      id,
      type: "assistant_message",
      timestamp,
      assistant_message: {
        content: "",
        attachments: [
          {
            type: "file",
            filename,
            content_type: "application/zip",
            url,
          },
        ],
      },
    });
    const events = [
      descriptorEvent(
        "assistant-older-valid-patch",
        10,
        expectedFilename,
        "https://downloads.example.test/older-valid.zip",
      ),
      descriptorEvent(
        "assistant-unrelated-zip",
        11,
        "unrelated-export.zip",
        "https://downloads.example.test/unrelated.zip",
      ),
      descriptorEvent(
        "assistant-newer-invalid-patch",
        12,
        expectedFilename,
        "https://downloads.example.test/newer-invalid.zip",
      ),
      {
        id: "status-multiple-patches-running",
        type: "status_update",
        timestamp: 13,
        status_update: { agent_status: "running" },
      },
    ];
    const validPatch = Buffer.from("valid-revision-patch");
    const invalidPatch = Buffer.from("invalid-revision-patch");
    const downloadArchive = vi
      .fn()
      .mockImplementation(async ({ descriptor }) => ({
        buffer: descriptor.url.endsWith("newer-invalid.zip")
          ? invalidPatch
          : validPatch,
        contentType: "application/zip",
      }));
    const validateRevisionCandidate = vi
      .fn()
      .mockImplementation(async ({ archiveBytes }) => {
        if (archiveBytes.equals(invalidPatch)) {
          throw new KnowledgeBaseMaterializedContractError(
            "invalid latest candidate",
          );
        }
        return { patch: { archiveBytes: validPatch } };
      });
    const applyRevision = vi.fn().mockResolvedValue(undefined);
    const stopTask = vi.fn().mockReturnValue(new Promise(() => undefined));
    const deferProviderStatus = vi.fn();
    let deterministicArchiveSha: string | null = null;
    const observeResultDiagnostic = vi
      .fn()
      .mockImplementation(async (input: any) => {
        const skipNormalization =
          input.resultProcessingStage === "archive_safety" &&
          input.archiveSha === deterministicArchiveSha;
        if (input.deterministicFailure) {
          deterministicArchiveSha = input.archiveSha;
        }
        return {
          skipNormalization,
          diagnostic: {
            descriptorHash: input.descriptorHash,
            archiveSha: input.archiveSha,
            resultProcessingStage: skipNormalization
              ? "canonical_validation"
              : input.resultProcessingStage,
            ...(skipNormalization || input.firstTypedFailureCode
              ? {
                  firstTypedFailureCode:
                    input.firstTypedFailureCode ||
                    "KNOWLEDGE_BASE_MATERIALIZED_CONTRACT_INVALID",
                }
              : {}),
            ...(skipNormalization || input.deterministicFailure
              ? { deterministicFailure: true }
              : {}),
            normalizationAttemptId: "n".repeat(64),
            normalizationStartedAt: "2026-08-15T00:00:00.000Z",
            firstObservedAt: "2026-08-15T00:00:00.000Z",
            lastObservedAt: "2026-08-15T00:00:00.000Z",
          },
        };
      });

    await expect(
      knowledgeBaseTerminalAnchorRecoveryTestHooks.dispatchKnowledgeBaseRecoveryClaim(
        claim,
        { id: "credential-base", apiKey: "base-secret" } as any,
        {
          loadBuild: vi.fn().mockResolvedValue(build),
          ensureDispatch: vi.fn().mockResolvedValue({
            schemaVersion: 2,
            baseUrl: "https://api.example.test",
            requestBody: {
              prompt: "patch",
              agentProfile: "manus-1.6",
              attachments: [],
            },
            bodySha256: "b".repeat(64),
            preparedAt: "2026-08-15T00:00:00.000Z",
          }),
          downloadArchive,
          validateRevisionCandidate,
          observeResultDiagnostic,
          applyRevision,
          deferProviderStatus,
          createClient: vi.fn().mockReturnValue({
            createTask: vi.fn(),
            findCreatedTask: vi.fn(),
            listAllMessages: vi.fn().mockResolvedValue(events),
            stopTask,
          }),
        } as any,
      ),
    ).resolves.toEqual({ taskId, rebound: true, reconciled: true });
    await expect(
      knowledgeBaseTerminalAnchorRecoveryTestHooks.dispatchKnowledgeBaseRecoveryClaim(
        claim,
        { id: "credential-base", apiKey: "base-secret" } as any,
        {
          loadBuild: vi.fn().mockResolvedValue(build),
          ensureDispatch: vi.fn().mockResolvedValue({
            schemaVersion: 2,
            baseUrl: "https://api.example.test",
            requestBody: {
              prompt: "patch",
              agentProfile: "manus-1.6",
              attachments: [],
            },
            bodySha256: "b".repeat(64),
            preparedAt: "2026-08-15T00:00:00.000Z",
          }),
          downloadArchive,
          validateRevisionCandidate,
          observeResultDiagnostic,
          applyRevision,
          deferProviderStatus,
          createClient: vi.fn().mockReturnValue({
            createTask: vi.fn(),
            findCreatedTask: vi.fn(),
            listAllMessages: vi.fn().mockResolvedValue(events),
            stopTask,
          }),
        } as any,
      ),
    ).resolves.toEqual({ taskId, rebound: true, reconciled: true });

    expect(
      downloadArchive.mock.calls.map(([value]) => value.descriptor.url),
    ).toEqual([
      "https://downloads.example.test/newer-invalid.zip",
      "https://downloads.example.test/older-valid.zip",
      "https://downloads.example.test/newer-invalid.zip",
      "https://downloads.example.test/older-valid.zip",
    ]);
    expect(
      validateRevisionCandidate.mock.calls.map(([value]) =>
        value.archiveBytes.toString("utf8"),
      ),
    ).toEqual([
      invalidPatch.toString("utf8"),
      validPatch.toString("utf8"),
      validPatch.toString("utf8"),
    ]);
    expect(applyRevision).toHaveBeenCalledWith(
      expect.objectContaining({
        archiveBytes: validPatch,
        operationId: operationKey,
        providerTaskId: taskId,
        targetLeafId: "2.1",
      }),
    );
    expect(applyRevision.mock.invocationCallOrder[0]).toBeLessThan(
      stopTask.mock.invocationCallOrder[0]!,
    );
    expect(observeResultDiagnostic).toHaveBeenCalledWith(
      expect.objectContaining({
        archiveSha: createHash("sha256").update(invalidPatch).digest("hex"),
        resultProcessingStage: "canonical_validation",
        firstTypedFailureCode: "KNOWLEDGE_BASE_MATERIALIZED_CONTRACT_INVALID",
        deterministicFailure: true,
      }),
    );
    expect(observeResultDiagnostic).toHaveBeenCalledWith(
      expect.objectContaining({
        archiveSha: createHash("sha256").update(validPatch).digest("hex"),
        resultProcessingStage: "activation",
      }),
    );
    expect(stopTask).toHaveBeenCalledTimes(2);
    expect(stopTask).toHaveBeenCalledWith(taskId);
    expect(deferProviderStatus).not.toHaveBeenCalled();
  });

  it("applies a persisted CAS-valid candidate without waiting for stop settlement", async () => {
    const operationKey = "2".repeat(64);
    const taskId = "materialized-task-persisted-stop-sending";
    const eventId = "assistant-persisted-stop-sending";
    const attachmentItemId = `v2-attachment-${createHash("sha256")
      .update(`${eventId}\0${0}`, "utf8")
      .digest("hex")}`;
    const candidateEventIdHash = createHash("sha256")
      .update(JSON.stringify([attachmentItemId]), "utf8")
      .digest("hex");
    const archive = Buffer.from("persisted-stop-sending-archive");
    const contentSha256 = createHash("sha256").update(archive).digest("hex");
    const storageKey = "knowledge-base/build-sources/7/sending-candidate.bin";
    const build = {
      id: "00000000-0000-4000-8000-0000000000c2",
      userId: 7,
      conversationId: "conversation-materialized-persisted-stop-sending",
      companyName: "Sending Company",
      companyWebsite: "https://sending.example.test",
      generation: 1,
      revision: 0,
      treePolicyVersion: 2,
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
    const claim = {
      turn: {
        id: "00000000-0000-4000-8000-0000000000f2",
        userId: 7,
        conversationId: build.conversationId,
        buildId: build.id,
        buildGeneration: 1,
        expectedRevision: 0,
        expectedLeafId: null,
        expectedUserAttachmentCount: 0,
        operationType: "start",
        operationKey,
        operationToken: operationKey,
        status: "running",
        upstreamTaskId: taskId,
        providerProtocol: "manus_v2",
        providerMethod: "task.create",
        materializedRecoveryContractVersion: 1,
        materializedCompletionContractVersion: 2,
        providerAttemptState: "output_pending",
        createAttemptState: "acknowledged",
        materializedCompletion: {
          schemaVersion: 1,
          candidateEventIdHash,
          storageKey,
          candidateArchiveSha256: contentSha256,
          sizeBytes: archive.length,
          firstObservedAt: "2026-08-15T00:00:00.000Z",
          lastObservedAt: "2026-08-15T00:02:30.000Z",
          stableAt: "2026-08-15T00:00:30.000Z",
          naturalStopDeadlineAt: "2026-08-15T00:02:30.000Z",
          stopAttemptState: "sending",
          stopAttemptedAt: "2026-08-15T00:02:30.000Z",
          stopSettleDeadlineAt: "2026-08-15T00:04:30.000Z",
        },
      },
      leaseToken: "lease-materialized-persisted-stop-sending",
      recoveryMetadata: { kind: "start" },
      preparedDispatch: null,
    } as any;
    const settleStop = vi.fn().mockResolvedValue(undefined);
    const observeCandidate = vi.fn().mockResolvedValue({
      disposition: "stop_pending",
      ledger: {
        ...claim.turn.materializedCompletion,
        stopAttemptState: "outcome_unknown",
        stopSettleDeadlineAt: "2026-08-15T00:12:30.000Z",
      },
      deduplicated: true,
    });
    const beginStop = vi.fn();
    const stopTask = vi.fn();
    const activateInitial = vi.fn().mockResolvedValue(undefined);
    const listAllMessages = vi
      .fn()
      .mockRejectedValue(
        new ManusV2ApiError(
          "task.listMessages",
          404,
          "task already removed",
          false,
          false,
        ),
      );

    await expect(
      knowledgeBaseTerminalAnchorRecoveryTestHooks.dispatchKnowledgeBaseRecoveryClaim(
        claim,
        { id: "credential-base", apiKey: "base-secret" } as any,
        {
          loadBuild: vi.fn().mockResolvedValue(build),
          ensureDispatch: vi.fn().mockResolvedValue({
            schemaVersion: 2,
            baseUrl: "https://api.example.test",
            requestBody: {
              prompt: "bundle",
              agentProfile: "manus-1.6",
              attachments: [],
            },
            bodySha256: "b".repeat(64),
            preparedAt: "2026-08-15T00:00:00.000Z",
          }),
          downloadArchive: vi.fn().mockResolvedValue({
            buffer: archive,
            contentType: "application/zip",
          }),
          validateInitialCandidate: vi
            .fn()
            .mockResolvedValue({ archiveBytes: archive }),
          readCandidate: vi.fn().mockResolvedValue(archive),
          persistCandidate: vi.fn(),
          observeCandidate,
          beginStop,
          settleStop,
          activateInitial,
          createClient: vi.fn().mockReturnValue({
            createTask: vi.fn(),
            findCreatedTask: vi.fn(),
            listAllMessages,
            stopTask,
          }),
        } as any,
      ),
    ).resolves.toEqual({ taskId, rebound: true, reconciled: true });

    expect(activateInitial).toHaveBeenCalledWith(
      expect.objectContaining({ archiveBytes: archive }),
    );
    expect(settleStop).not.toHaveBeenCalled();
    expect(observeCandidate).not.toHaveBeenCalled();
    expect(beginStop).not.toHaveBeenCalled();
    expect(listAllMessages).not.toHaveBeenCalled();
    expect(stopTask).not.toHaveBeenCalled();
  });

  it("does not re-run normalization after a process exits behind a durable start fence", async () => {
    const operationKey = "1".repeat(64);
    const taskId = "materialized-task-normalizer-crash-fence";
    const build = {
      id: "00000000-0000-4000-8000-0000000000d1",
      userId: 7,
      conversationId: "conversation-materialized-normalizer-crash-fence",
      companyName: "Crash Fence Company",
      companyWebsite: "https://crash-fence.example.test",
      generation: 1,
      revision: 0,
      treePolicyVersion: 2,
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
    const claimForLease = (leaseToken: string) =>
      ({
        turn: {
          id: "00000000-0000-4000-8000-0000000000e1",
          userId: 7,
          conversationId: build.conversationId,
          buildId: build.id,
          buildGeneration: 1,
          expectedRevision: 0,
          expectedLeafId: null,
          expectedUserAttachmentCount: 0,
          operationType: "start",
          operationKey,
          operationToken: operationKey,
          status: "running",
          upstreamTaskId: taskId,
          providerProtocol: "manus_v2",
          providerMethod: "task.create",
          materializedRecoveryContractVersion: 1,
          materializedCompletionContractVersion: 2,
          materializedCompletion: null,
          providerAttemptState: "output_pending",
          createAttemptState: "acknowledged",
        },
        leaseToken,
        recoveryMetadata: { kind: "start" },
        preparedDispatch: null,
      }) as any;
    const events = [
      {
        id: "assistant-normalizer-crash-zip",
        type: "assistant_message",
        timestamp: 10,
        assistant_message: {
          content: "",
          attachments: [
            {
              type: "file",
              filename: `frontmind-kb-bundle-${operationKey}.zip`,
              content_type: "application/zip",
              url: "https://downloads.example.test/normalizer-crash.zip",
            },
          ],
        },
      },
      {
        id: "status-normalizer-crash-running",
        type: "status_update",
        timestamp: 11,
        status_update: { agent_status: "running" },
      },
    ];
    const archive = Buffer.from("normalizer-crash-archive");
    const archiveSha = createHash("sha256").update(archive).digest("hex");
    let startedLease: string | null = null;
    const observeResultDiagnostic = vi
      .fn()
      .mockImplementation(async (input: any) => {
        if (!startedLease) startedLease = input.leaseToken;
        const interrupted = startedLease !== input.leaseToken;
        return {
          skipNormalization: interrupted,
          diagnostic: {
            descriptorHash: input.descriptorHash,
            archiveSha: input.archiveSha,
            resultProcessingStage: "archive_safety",
            ...(interrupted
              ? {
                  firstTypedFailureCode:
                    "KNOWLEDGE_BASE_RESULT_PROCESSING_INTERRUPTED",
                  deterministicFailure: true,
                }
              : {}),
            normalizationAttemptId: "a".repeat(64),
            normalizationStartedAt: "2026-08-17T00:00:00.000Z",
            firstObservedAt: "2026-08-17T00:00:00.000Z",
            lastObservedAt: "2026-08-17T00:00:01.000Z",
          },
        };
      });
    const validateInitialCandidate = vi
      .fn()
      .mockRejectedValueOnce(new Error("simulated process exit in normalizer"))
      .mockResolvedValueOnce({ archiveBytes: archive });
    const commonDependencies = {
      loadBuild: vi.fn().mockResolvedValue(build),
      ensureDispatch: vi.fn().mockResolvedValue({
        schemaVersion: 2,
        baseUrl: "https://api.example.test",
        requestBody: {
          prompt: "bundle",
          agentProfile: "manus-1.6",
          attachments: [],
        },
        bodySha256: "b".repeat(64),
        preparedAt: "2026-08-17T00:00:00.000Z",
      }),
      downloadArchive: vi.fn().mockResolvedValue({
        buffer: archive,
        contentType: "application/zip",
      }),
      validateInitialCandidate,
      observeResultDiagnostic,
      createClient: vi.fn().mockReturnValue({
        createTask: vi.fn(),
        findCreatedTask: vi.fn(),
        listAllMessages: vi.fn().mockResolvedValue(events),
        stopTask: vi.fn(),
      }),
    } as any;
    const firstClaim = claimForLease("lease-before-normalizer-crash");
    let firstError: unknown;
    try {
      await knowledgeBaseTerminalAnchorRecoveryTestHooks.dispatchKnowledgeBaseRecoveryClaim(
        firstClaim,
        { id: "credential-base", apiKey: "base-secret" } as any,
        commonDependencies,
      );
    } catch (error) {
      firstError = error;
    }
    expect(firstError).toMatchObject({
      message: "simulated process exit in normalizer",
    });
    const failedSettlement = vi
      .fn()
      .mockRejectedValue(new Error("simulated settlement persistence exit"));
    await expect(
      persistKnowledgeBaseDispatchFailure(
        {
          claim: firstClaim,
          error: firstError,
          outcomeUnknownCode: "MUST_NOT_REOPEN_CREATE",
        },
        { failMaterializedResult: failedSettlement },
      ),
    ).rejects.toThrow("simulated settlement persistence exit");

    const restartedClaim = claimForLease("lease-after-normalizer-crash");
    let restartedError: unknown;
    try {
      await knowledgeBaseTerminalAnchorRecoveryTestHooks.dispatchKnowledgeBaseRecoveryClaim(
        restartedClaim,
        { id: "credential-base", apiKey: "base-secret" } as any,
        commonDependencies,
      );
    } catch (error) {
      restartedError = error;
    }
    expect(restartedError).toBeInstanceOf(
      KnowledgeBaseMaterializedContractError,
    );
    expect(validateInitialCandidate).toHaveBeenCalledOnce();
    expect(observeResultDiagnostic).toHaveBeenLastCalledWith(
      expect.objectContaining({ archiveSha }),
    );
    const stableReset = vi.fn().mockResolvedValue({
      turn: {},
      deduplicated: false,
    });
    await expect(
      persistKnowledgeBaseDispatchFailure(
        {
          claim: restartedClaim,
          error: restartedError,
          outcomeUnknownCode: "MUST_NOT_REOPEN_CREATE",
        },
        { failMaterializedResult: stableReset },
      ),
    ).resolves.toBe("deterministic");
    expect(stableReset).toHaveBeenCalledWith(
      expect.objectContaining({
        code: "KNOWLEDGE_BASE_MATERIALIZED_CONTRACT_INVALID",
      }),
    );
  });

  it("applies the immutable staged CAS across descriptor changes and rejects corrupt local bytes", async () => {
    const operationKey = "3".repeat(64);
    const taskId = "materialized-task-stop-proof-mutation";
    const eventId = "assistant-stop-proof-mutation";
    const attachmentItemId = `v2-attachment-${createHash("sha256")
      .update(`${eventId}\0${0}`, "utf8")
      .digest("hex")}`;
    const candidateEventIdHash = createHash("sha256")
      .update(JSON.stringify([attachmentItemId]), "utf8")
      .digest("hex");
    const archive = Buffer.from("immutable-stop-proof-archive");
    const contentSha256 = createHash("sha256").update(archive).digest("hex");
    const storageKey = "knowledge-base/build-sources/7/immutable.bin";
    const build = {
      id: "00000000-0000-4000-8000-0000000000c3",
      userId: 7,
      conversationId: "conversation-materialized-stop-proof-mutation",
      companyName: "Immutable Company",
      companyWebsite: "https://immutable.example.test",
      generation: 1,
      revision: 0,
      treePolicyVersion: 2,
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
    const claim = {
      turn: {
        id: "00000000-0000-4000-8000-0000000000f3",
        userId: 7,
        conversationId: build.conversationId,
        buildId: build.id,
        buildGeneration: 1,
        expectedRevision: 0,
        expectedLeafId: null,
        expectedUserAttachmentCount: 0,
        operationType: "start",
        operationKey,
        operationToken: operationKey,
        status: "running",
        upstreamTaskId: taskId,
        providerProtocol: "manus_v2",
        providerMethod: "task.create",
        materializedRecoveryContractVersion: 1,
        materializedCompletionContractVersion: 2,
        providerAttemptState: "output_pending",
        createAttemptState: "acknowledged",
        materializedCompletion: {
          schemaVersion: 1,
          candidateEventIdHash,
          storageKey,
          candidateArchiveSha256: contentSha256,
          sizeBytes: archive.length,
          stableAt: "2026-08-15T00:00:30.000Z",
          naturalStopDeadlineAt: "2026-08-15T00:02:30.000Z",
          stopAttemptState: "acknowledged",
          stopAttemptedAt: "2026-08-15T00:02:30.000Z",
          stopSettleDeadlineAt: "2026-08-15T00:04:30.000Z",
        },
      },
      leaseToken: "lease-materialized-stop-proof-mutation",
      recoveryMetadata: { kind: "start" },
      preparedDispatch: null,
    } as any;
    const eventsFor = (candidateEventId: string) => [
      {
        id: candidateEventId,
        type: "assistant_message",
        timestamp: 10,
        assistant_message: {
          content: "",
          attachments: [
            {
              type: "file",
              filename: `frontmind-kb-bundle-${operationKey}.zip`,
              content_type: "application/zip",
              url: "https://downloads.example.test/immutable.zip",
            },
          ],
        },
      },
      {
        id: "status-stop-proof-running",
        type: "status_update",
        timestamp: 11,
        status_update: { agent_status: "running" },
      },
    ];
    const prepared = {
      schemaVersion: 2,
      baseUrl: "https://api.example.test",
      requestBody: {
        prompt: "bundle",
        agentProfile: "manus-1.6",
        attachments: [],
      },
      bodySha256: "b".repeat(64),
      preparedAt: "2026-08-15T00:00:00.000Z",
    };
    const exercise = async (input: {
      candidateEventId?: string;
      downloaded?: Buffer;
      staged?: Buffer;
      expectFailure?: boolean;
    }) => {
      const persistCandidate = vi.fn();
      const observeCandidate = vi.fn().mockResolvedValue({
        disposition: "stop_pending",
        ledger: claim.turn.materializedCompletion,
        deduplicated: true,
      });
      const beginStop = vi.fn();
      const stopTask = vi.fn();
      const activateInitial = vi.fn().mockResolvedValue(undefined);
      const result =
        knowledgeBaseTerminalAnchorRecoveryTestHooks.dispatchKnowledgeBaseRecoveryClaim(
          claim,
          { id: "credential-base", apiKey: "base-secret" } as any,
          {
            loadBuild: vi.fn().mockResolvedValue(build),
            ensureDispatch: vi.fn().mockResolvedValue(prepared),
            downloadArchive: vi.fn().mockResolvedValue({
              buffer: input.downloaded ?? archive,
              contentType: "application/zip",
            }),
            readCandidate: vi.fn().mockResolvedValue(input.staged ?? archive),
            validateInitialCandidate: vi
              .fn()
              .mockImplementation(async (bytes: Buffer) => ({
                archiveBytes: bytes,
              })),
            persistCandidate,
            observeCandidate,
            beginStop,
            activateInitial,
            createClient: vi.fn().mockReturnValue({
              createTask: vi.fn(),
              findCreatedTask: vi.fn(),
              listAllMessages: vi
                .fn()
                .mockResolvedValue(
                  eventsFor(input.candidateEventId ?? eventId),
                ),
              stopTask,
            }),
          } as any,
        );
      if (input.expectFailure) {
        await expect(result).rejects.toMatchObject({
          code: "KNOWLEDGE_BASE_MATERIALIZED_RESULT_INVALID",
        });
      } else {
        await expect(result).resolves.toEqual({
          taskId,
          rebound: true,
          reconciled: true,
        });
      }
      expect(persistCandidate).not.toHaveBeenCalled();
      expect(observeCandidate).not.toHaveBeenCalled();
      if (input.expectFailure) expect(activateInitial).not.toHaveBeenCalled();
      else expect(activateInitial).toHaveBeenCalledOnce();
      expect(beginStop).not.toHaveBeenCalled();
      expect(stopTask).not.toHaveBeenCalled();
    };

    await exercise({ candidateEventId: "assistant-replaced-after-stop" });
    await exercise({
      downloaded: Buffer.from("changed-after-stop"),
    });
    await exercise({
      staged: Buffer.from("corrupt-local-staging"),
      expectFailure: true,
    });
  });

  it("retries transient candidate reads but terminalizes deterministic unavailability", async () => {
    const operationKey = "4".repeat(64);
    const taskId = "materialized-task-running-download-unavailable";
    const build = {
      id: "00000000-0000-4000-8000-0000000000c4",
      userId: 7,
      conversationId: "conversation-materialized-download-unavailable",
      companyName: "Download Company",
      companyWebsite: "https://download.example.test",
      generation: 1,
      revision: 0,
      treePolicyVersion: 2,
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
    const claim = {
      turn: {
        id: "00000000-0000-4000-8000-0000000000f4",
        userId: 7,
        conversationId: build.conversationId,
        buildId: build.id,
        buildGeneration: 1,
        expectedRevision: 0,
        expectedLeafId: null,
        expectedUserAttachmentCount: 0,
        operationType: "start",
        operationKey,
        operationToken: operationKey,
        status: "running",
        upstreamTaskId: taskId,
        providerProtocol: "manus_v2",
        providerMethod: "task.create",
        materializedRecoveryContractVersion: 1,
        materializedCompletionContractVersion: 2,
        materializedCompletion: null,
        providerAttemptState: "output_pending",
        createAttemptState: "acknowledged",
      },
      leaseToken: "lease-materialized-download-unavailable",
      recoveryMetadata: { kind: "start" },
      preparedDispatch: null,
    } as any;
    const events = [
      {
        id: "assistant-running-download-unavailable",
        type: "assistant_message",
        timestamp: 10,
        assistant_message: {
          content: "",
          attachments: [
            {
              type: "file",
              filename: `frontmind-kb-bundle-${operationKey}.zip`,
              content_type: "application/zip",
              url: "https://downloads.example.test/unavailable.zip",
            },
          ],
        },
      },
      {
        id: "status-running-download-unavailable",
        type: "status_update",
        timestamp: 11,
        status_update: { agent_status: "running" },
      },
    ];

    for (const error of [
      new KnowledgeArchiveDownloadError(
        "http_status",
        "candidate download forbidden",
        403,
      ),
      new KnowledgeArchiveDownloadError(
        "http_status",
        "candidate download temporarily unavailable",
        503,
      ),
    ]) {
      const deferProviderStatus = vi.fn().mockResolvedValue({
        state: "deferred",
        retryAfterMs: 15_000,
        ledger: { schemaVersion: 1 },
      });
      const persistCandidate = vi.fn();
      const observeCandidate = vi.fn();
      const beginStop = vi.fn();
      const stopTask = vi.fn();
      const createTask = vi.fn();
      const sendMessage = vi.fn();
      const deleteTask = vi.fn();

      const downloadArchive = vi.fn().mockRejectedValue(error);
      const result =
        knowledgeBaseTerminalAnchorRecoveryTestHooks.dispatchKnowledgeBaseRecoveryClaim(
          claim,
          { id: "credential-base", apiKey: "base-secret" } as any,
          {
            loadBuild: vi.fn().mockResolvedValue(build),
            ensureDispatch: vi.fn().mockResolvedValue({
              schemaVersion: 2,
              baseUrl: "https://api.example.test",
              requestBody: {
                prompt: "bundle",
                agentProfile: "manus-1.6",
                attachments: [],
              },
              bodySha256: "b".repeat(64),
              preparedAt: "2026-08-15T00:00:00.000Z",
            }),
            downloadArchive,
            persistCandidate,
            observeCandidate,
            beginStop,
            deferProviderStatus,
            createClient: vi.fn().mockReturnValue({
              createTask,
              findCreatedTask: vi.fn(),
              listAllMessages: vi.fn().mockResolvedValue(events),
              stopTask,
              sendMessage,
              deleteTask,
            }),
          } as any,
        );
      if (error.retryable) {
        await expect(result).resolves.toEqual({
          taskId,
          rebound: true,
          reconciled: false,
        });
        expect(deferProviderStatus).toHaveBeenCalledWith(
          expect.objectContaining({
            status: "running",
            resetCandidate: true,
          }),
        );
        expect(downloadArchive).toHaveBeenCalledTimes(3);
      } else {
        await expect(result).rejects.toBe(error);
        expect(deferProviderStatus).not.toHaveBeenCalled();
        expect(downloadArchive).toHaveBeenCalledOnce();
      }
      expect(persistCandidate).not.toHaveBeenCalled();
      expect(observeCandidate).not.toHaveBeenCalled();
      expect(beginStop).not.toHaveBeenCalled();
      expect(stopTask).not.toHaveBeenCalled();
      expect(createTask).not.toHaveBeenCalled();
      expect(sendMessage).not.toHaveBeenCalled();
      expect(deleteTask).not.toHaveBeenCalled();
    }
  });

  it("routes a marker-missing historical task to reset without Provider reads or writes", async () => {
    const operationKey = "8".repeat(64);
    const taskId = "materialized-task-historical-running-zip";
    const expectedFilename = `frontmind-kb-bundle-${operationKey}.zip`;
    const stopTask = vi.fn();
    const downloadArchive = vi.fn();
    const ensureDispatch = vi.fn();
    const createClient = vi.fn();
    const build = {
      id: "00000000-0000-4000-8000-0000000000c8",
      userId: 7,
      conversationId: "conversation-materialized-historical-running",
      generation: 1,
      revision: 0,
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
    const claim = {
      turn: {
        id: "00000000-0000-4000-8000-0000000000f8",
        userId: 7,
        conversationId: build.conversationId,
        buildId: build.id,
        buildGeneration: 1,
        expectedRevision: 0,
        expectedLeafId: null,
        expectedUserAttachmentCount: 0,
        operationType: "start",
        operationKey,
        operationToken: operationKey,
        status: "running",
        upstreamTaskId: taskId,
        providerProtocol: "manus_v2",
        providerMethod: "task.create",
        materializedRecoveryContractVersion: 1,
        materializedCompletionContractVersion: null,
        providerAttemptState: "output_pending",
        createAttemptState: "acknowledged",
      },
      leaseToken: "lease-materialized-historical-running",
      recoveryMetadata: { kind: "start" },
      preparedDispatch: null,
    } as any;

    await expect(
      knowledgeBaseTerminalAnchorRecoveryTestHooks.dispatchKnowledgeBaseRecoveryClaim(
        claim,
        { id: "credential-base", apiKey: "base-secret" } as any,
        {
          loadBuild: vi.fn().mockResolvedValue(build),
          ensureDispatch,
          downloadArchive,
          createClient: createClient.mockReturnValue({
            createTask: vi.fn(),
            findCreatedTask: vi.fn(),
            listAllMessages: vi.fn().mockResolvedValue([
              {
                id: "assistant-historical-zip",
                type: "assistant_message",
                timestamp: 10,
                assistant_message: {
                  content: "",
                  attachments: [
                    {
                      type: "file",
                      filename: expectedFilename,
                      content_type: "application/zip",
                      url: "https://downloads.example.test/historical.zip",
                    },
                  ],
                },
              },
              {
                id: "status-historical-running",
                type: "status_update",
                timestamp: 11,
                status_update: { agent_status: "running" },
              },
            ]),
            stopTask,
          }),
        } as any,
      ),
    ).rejects.toMatchObject({ code: "RESET_REQUIRED" });

    expect(ensureDispatch).not.toHaveBeenCalled();
    expect(createClient).not.toHaveBeenCalled();
    expect(downloadArchive).not.toHaveBeenCalled();
    expect(stopTask).not.toHaveBeenCalled();
  });

  it("classifies Provider status when the reported ZIP is not yet readable", async () => {
    const operationKey = "6".repeat(64);
    const taskId = "materialized-task-contract-v2-status-classification";
    const expectedFilename = `frontmind-kb-bundle-${operationKey}.zip`;
    const build = {
      id: "00000000-0000-4000-8000-0000000000c6",
      userId: 7,
      conversationId: "conversation-materialized-status-classification",
      companyName: "Status Company",
      companyWebsite: "https://status.example.test",
      generation: 1,
      revision: 0,
      treePolicyVersion: 2,
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
    const claim = {
      turn: {
        id: "00000000-0000-4000-8000-0000000000f6",
        userId: 7,
        conversationId: build.conversationId,
        buildId: build.id,
        buildGeneration: 1,
        expectedRevision: 0,
        expectedLeafId: null,
        expectedUserAttachmentCount: 0,
        operationType: "start",
        operationKey,
        operationToken: operationKey,
        status: "running",
        upstreamTaskId: taskId,
        providerProtocol: "manus_v2",
        providerMethod: "task.create",
        materializedRecoveryContractVersion: 1,
        materializedCompletionContractVersion: 2,
        materializedCompletion: null,
        providerAttemptState: "output_pending",
        createAttemptState: "acknowledged",
      },
      leaseToken: "lease-materialized-status-classification",
      recoveryMetadata: { kind: "start" },
      preparedDispatch: null,
    } as any;
    const archiveEvent = {
      id: "assistant-status-classification-zip",
      type: "assistant_message",
      timestamp: 10,
      assistant_message: {
        content: "",
        attachments: [
          {
            type: "file",
            filename: expectedFilename,
            content_type: "application/zip",
            url: "https://downloads.example.test/status.zip",
          },
        ],
      },
    };
    const cases = [
      {
        label: "waiting",
        events: [
          archiveEvent,
          {
            id: "status-waiting",
            type: "status_update",
            timestamp: 12,
            status_update: { agent_status: "waiting" },
          },
        ],
        expectedStatus: "waiting",
      },
      {
        label: "typed quota",
        events: [
          archiveEvent,
          {
            id: "quota-envelope",
            type: "error_message",
            timestamp: 11,
            error_message: { error_type: "insufficient_credits" },
          },
          {
            id: "status-quota-error",
            type: "status_update",
            timestamp: 12,
            status_update: { agent_status: "error" },
          },
        ],
        expectedStatus: "quota_error",
      },
      {
        label: "unknown typed error",
        events: [
          archiveEvent,
          {
            id: "unknown-error-envelope",
            type: "error_message",
            timestamp: 11,
            error_message: {
              error_type: "provider_internal",
              content: "insufficient credits must not be inferred from text",
            },
          },
          {
            id: "status-unknown-error",
            type: "status_update",
            timestamp: 12,
            status_update: { agent_status: "error" },
          },
        ],
        expectedStatus: "error",
      },
      {
        label: "stale quota envelope before a later error",
        events: [
          archiveEvent,
          {
            id: "old-quota-envelope",
            type: "error_message",
            timestamp: 4,
            error_message: { error_type: "quota_exceeded" },
          },
          {
            id: "old-quota-status",
            type: "status_update",
            timestamp: 5,
            status_update: { agent_status: "error" },
          },
          {
            id: "continued-running-status",
            type: "status_update",
            timestamp: 11,
            status_update: { agent_status: "running" },
          },
          {
            id: "later-untyped-error-status",
            type: "status_update",
            timestamp: 12,
            status_update: { agent_status: "error" },
          },
        ],
        expectedStatus: "error",
      },
      {
        label:
          "same-timestamp stale quota before a later running and error status",
        events: [
          archiveEvent,
          {
            id: "zzz-older-quota-envelope",
            type: "error_message",
            timestamp: 12,
            error_message: { error_type: "quota_exceeded" },
          },
          {
            id: "middle-running-status",
            type: "status_update",
            timestamp: 12,
            status_update: { agent_status: "running" },
          },
          {
            id: "000-newer-untyped-error-status",
            type: "status_update",
            timestamp: 12,
            status_update: { agent_status: "error" },
          },
        ],
        expectedStatus: "error",
      },
      {
        label: "same-timestamp quota after the latest running boundary",
        events: [
          archiveEvent,
          {
            id: "zzz-older-running-status",
            type: "status_update",
            timestamp: 12,
            providerOriginalRank: 30,
            status_update: { agent_status: "running" },
          },
          {
            id: "middle-quota-envelope",
            type: "error_message",
            timestamp: 12,
            providerOriginalRank: 31,
            error_message: { error_type: "quota_exceeded" },
          },
          {
            id: "000-newer-quota-status",
            type: "status_update",
            timestamp: 12,
            providerOriginalRank: 32,
            status_update: { agent_status: "error" },
          },
        ],
        expectedStatus: "quota_error",
      },
      {
        label: "missing status",
        events: [archiveEvent],
        expectedStatus: "unknown",
      },
    ] as const;

    for (const fixture of cases) {
      const deferProviderStatus = vi.fn().mockResolvedValue({
        state: "deferred",
        retryAfterMs: 15_000,
        ledger: { schemaVersion: 1 },
      });
      const downloadArchive = vi
        .fn()
        .mockRejectedValue(
          new KnowledgeArchiveDownloadError(
            "http_status",
            "candidate is not readable yet",
            503,
          ),
        );
      const observeCandidate = vi.fn();
      const stopTask = vi.fn();
      const createTask = vi.fn();
      const sendMessage = vi.fn();
      const deleteTask = vi.fn();

      await expect(
        knowledgeBaseTerminalAnchorRecoveryTestHooks.dispatchKnowledgeBaseRecoveryClaim(
          claim,
          { id: "credential-base", apiKey: "base-secret" } as any,
          {
            loadBuild: vi.fn().mockResolvedValue(build),
            ensureDispatch: vi.fn().mockResolvedValue({
              schemaVersion: 2,
              baseUrl: "https://api.example.test",
              requestBody: {
                prompt: "bundle",
                agentProfile: "manus-1.6",
                attachments: [],
              },
              bodySha256: "b".repeat(64),
              preparedAt: "2026-08-15T00:00:00.000Z",
            }),
            downloadArchive,
            observeCandidate,
            deferProviderStatus,
            createClient: vi.fn().mockReturnValue({
              createTask,
              findCreatedTask: vi.fn(),
              listAllMessages: vi.fn().mockResolvedValue(fixture.events),
              stopTask,
              sendMessage,
              deleteTask,
            }),
          } as any,
        ),
        fixture.label,
      ).resolves.toEqual({ taskId, rebound: true, reconciled: false });

      expect(deferProviderStatus, fixture.label).toHaveBeenCalledWith(
        expect.objectContaining({
          status: fixture.expectedStatus,
          resetCandidate: true,
        }),
      );
      expect(downloadArchive, fixture.label).toHaveBeenCalledTimes(3);
      expect(observeCandidate, fixture.label).not.toHaveBeenCalled();
      expect(stopTask, fixture.label).not.toHaveBeenCalled();
      expect(createTask, fixture.label).not.toHaveBeenCalled();
      expect(sendMessage, fixture.label).not.toHaveBeenCalled();
      expect(deleteTask, fixture.label).not.toHaveBeenCalled();
    }
  });

  it("activates a stopped contract-v2 candidate directly from its verified local CAS", async () => {
    const operationKey = "9".repeat(64);
    const taskId = "materialized-task-contract-v2-stopped";
    const turnId = "00000000-0000-4000-8000-0000000000f9";
    const eventId = "assistant-contract-v2-stopped-zip";
    const attachmentItemId = `v2-attachment-${createHash("sha256")
      .update(`${eventId}\0${0}`, "utf8")
      .digest("hex")}`;
    const candidateEventIdHash = createHash("sha256")
      .update(JSON.stringify([attachmentItemId]), "utf8")
      .digest("hex");
    const archive = Buffer.from("same-staged-and-stopped-bundle");
    const contentSha256 = createHash("sha256").update(archive).digest("hex");
    const storageKey = "knowledge-base/build-sources/7/stopped-candidate.bin";
    const expectedFilename = `frontmind-kb-bundle-${operationKey}.zip`;
    const build = {
      id: "00000000-0000-4000-8000-0000000000c9",
      userId: 7,
      conversationId: "conversation-materialized-contract-v2-stopped",
      companyName: "Completion Company",
      companyWebsite: "https://completion.example.test",
      generation: 1,
      revision: 0,
      treePolicyVersion: 2,
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
    const claim = {
      turn: {
        id: turnId,
        userId: 7,
        conversationId: build.conversationId,
        buildId: build.id,
        buildGeneration: 1,
        expectedRevision: 0,
        expectedLeafId: null,
        expectedUserAttachmentCount: 0,
        operationType: "start",
        operationKey,
        operationToken: operationKey,
        status: "running",
        upstreamTaskId: taskId,
        providerProtocol: "manus_v2",
        providerMethod: "task.create",
        materializedRecoveryContractVersion: 1,
        materializedCompletionContractVersion: 2,
        providerAttemptState: "output_pending",
        createAttemptState: "acknowledged",
        materializedCompletion: {
          schemaVersion: 1,
          candidateEventIdHash,
          storageKey,
          candidateArchiveSha256: contentSha256,
          sizeBytes: archive.length,
          firstObservedAt: "2026-08-15T00:00:00.000Z",
          lastObservedAt: "2026-08-15T00:02:30.000Z",
          stableAt: "2026-08-15T00:00:30.000Z",
          naturalStopDeadlineAt: "2026-08-15T00:02:30.000Z",
          stopAttemptState: "acknowledged",
          stopAttemptedAt: "2026-08-15T00:02:30.000Z",
          stopSettleDeadlineAt: "2026-08-15T00:04:30.000Z",
        },
      },
      leaseToken: "lease-materialized-contract-v2-stopped",
      recoveryMetadata: { kind: "start" },
      preparedDispatch: null,
    } as any;
    const activateInitial = vi.fn().mockResolvedValue(undefined);
    const stopTask = vi.fn();
    const stoppedEvents = [
      {
        id: eventId,
        type: "assistant_message",
        timestamp: 10,
        assistant_message: {
          content: "",
          attachments: [
            {
              type: "file",
              filename: expectedFilename,
              content_type: "application/zip",
              url: "https://downloads.example.test/stopped.zip",
            },
          ],
        },
      },
      {
        id: "status-contract-v2-stopped",
        type: "status_update",
        timestamp: 11,
        status_update: { agent_status: "stopped" },
      },
    ];

    await expect(
      knowledgeBaseTerminalAnchorRecoveryTestHooks.dispatchKnowledgeBaseRecoveryClaim(
        claim,
        { id: "credential-base", apiKey: "base-secret" } as any,
        {
          loadBuild: vi.fn().mockResolvedValue(build),
          ensureDispatch: vi.fn().mockResolvedValue({
            schemaVersion: 2,
            baseUrl: "https://api.example.test",
            requestBody: {
              prompt: "bundle",
              agentProfile: "manus-1.6",
              attachments: [],
            },
            bodySha256: "b".repeat(64),
            preparedAt: "2026-08-15T00:00:00.000Z",
          }),
          downloadArchive: vi.fn().mockResolvedValue({
            buffer: archive,
            contentType: "application/zip",
          }),
          validateInitialCandidate: vi
            .fn()
            .mockResolvedValue({ archiveBytes: archive }),
          readCandidate: vi.fn().mockResolvedValue(archive),
          activateInitial,
          createClient: vi.fn().mockReturnValue({
            createTask: vi.fn(),
            findCreatedTask: vi.fn(),
            listAllMessages: vi.fn().mockResolvedValue(stoppedEvents),
            stopTask,
          }),
        } as any,
      ),
    ).resolves.toEqual({ taskId, rebound: true, reconciled: true });

    expect(stopTask).not.toHaveBeenCalled();
    expect(activateInitial).toHaveBeenCalledOnce();
    expect(activateInitial).toHaveBeenCalledWith(
      expect.objectContaining({
        archiveBytes: archive,
        providerTaskId: taskId,
      }),
    );
  });

  it("accepts an interrupted task after a manual continue and activates its valid ZIP without another Provider POST", async () => {
    const operationKey = "e".repeat(64);
    const taskId = "materialized-task-manual-continue";
    const build = {
      id: "00000000-0000-4000-8000-0000000000c6",
      userId: 7,
      conversationId: "conversation-materialized-manual-continue",
      companyName: "Manual Continue Company",
      companyWebsite: "https://manual-continue.example.test",
      generation: 1,
      revision: 0,
      treePolicyVersion: 2,
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
    const claim = {
      turn: {
        id: "00000000-0000-4000-8000-0000000000f6",
        userId: 7,
        conversationId: build.conversationId,
        buildId: build.id,
        buildGeneration: build.generation,
        expectedRevision: build.revision,
        expectedLeafId: null,
        expectedUserAttachmentCount: 0,
        operationType: "start",
        operationKey,
        operationToken: operationKey,
        status: "running",
        upstreamTaskId: taskId,
        providerProtocol: "manus_v2",
        providerMethod: "task.create",
        materializedRecoveryContractVersion: 1,
        materializedCompletionContractVersion: 2,
        materializedCompletion: null,
        providerAttemptState: "output_pending",
        createAttemptState: "acknowledged",
      },
      leaseToken: "lease-materialized-manual-continue",
      recoveryMetadata: {
        kind: "start",
        conversationId: build.conversationId,
      },
      preparedDispatch: null,
    } as any;
    const prepared = {
      schemaVersion: 2 as const,
      baseUrl: "https://api.example.test",
      requestBody: {
        prompt: "只返回本轮 Bundle ZIP",
        agentProfile: "manus-1.6",
        attachments: [],
      },
      bodySha256: "b".repeat(64),
      preparedAt: "2026-08-15T00:00:00.000Z",
    };
    const expectedFilename = `frontmind-kb-bundle-${operationKey}.zip`;
    const listAllMessages = vi
      .fn()
      .mockResolvedValueOnce([
        {
          id: "error-credit-interrupted",
          type: "error_message",
          timestamp: 9,
          error_message: { error_type: "credit_exhausted" },
        },
        {
          id: "status-credit-interrupted",
          type: "status_update",
          timestamp: 10,
          status_update: { agent_status: "error" },
        },
      ])
      .mockResolvedValueOnce([
        {
          id: "status-credit-interrupted",
          type: "status_update",
          timestamp: 10,
          status_update: { agent_status: "error" },
        },
        {
          id: "status-manual-continue-running",
          type: "status_update",
          timestamp: 20,
          status_update: { agent_status: "running" },
        },
        {
          id: "assistant-valid-bundle",
          type: "assistant_message",
          timestamp: 29,
          assistant_message: {
            content: "",
            attachments: [
              {
                type: "file",
                filename: expectedFilename,
                content_type: "application/zip",
                url: "https://downloads.example.test/manual-continue.zip",
              },
            ],
          },
        },
        {
          id: "status-manual-continue-stopped",
          type: "status_update",
          timestamp: 30,
          status_update: { agent_status: "stopped" },
        },
      ]);
    const createTask = vi.fn();
    const findCreatedTask = vi.fn();
    const ensureManusV2Attachments = vi.fn();
    const beginDispatch = vi.fn();
    const bindSubmission = vi.fn();
    const downloadArchive = vi.fn().mockResolvedValue({
      buffer: Buffer.from("valid-bundle"),
      contentType: "application/zip",
    });
    const activateInitial = vi.fn().mockResolvedValue(undefined);
    const deferProviderStatus = vi.fn().mockResolvedValue({
      state: "deferred",
      retryAfterMs: 15_000,
      ledger: { schemaVersion: 1 },
    });
    const stopTask = vi.fn();
    const sendMessage = vi.fn();
    const deleteTask = vi.fn();
    const dependencies = {
      loadBuild: vi.fn().mockResolvedValue(build),
      ensureDispatch: vi.fn().mockResolvedValue(prepared),
      ensureManusV2Attachments,
      beginDispatch,
      bindSubmission,
      downloadArchive,
      validateInitialCandidate: vi
        .fn()
        .mockImplementation(async (bytes: Buffer) => ({
          archiveBytes: bytes,
        })),
      activateInitial,
      deferProviderStatus,
      createClient: vi.fn().mockReturnValue({
        createTask,
        findCreatedTask,
        listAllMessages,
        stopTask,
        sendMessage,
        deleteTask,
      }),
    } as any;

    await expect(
      knowledgeBaseTerminalAnchorRecoveryTestHooks.dispatchKnowledgeBaseRecoveryClaim(
        claim,
        { id: "credential-base", apiKey: "base-secret" } as any,
        dependencies,
      ),
    ).resolves.toEqual({ taskId, rebound: true, reconciled: true });

    expect(createTask).not.toHaveBeenCalled();
    expect(findCreatedTask).not.toHaveBeenCalled();
    expect(ensureManusV2Attachments).not.toHaveBeenCalled();
    expect(beginDispatch).not.toHaveBeenCalled();
    expect(bindSubmission).not.toHaveBeenCalled();
    expect(listAllMessages).toHaveBeenCalledTimes(2);
    expect(listAllMessages).toHaveBeenNthCalledWith(1, {
      taskId,
      order: "desc",
    });
    expect(listAllMessages).toHaveBeenNthCalledWith(2, {
      taskId,
      order: "desc",
    });
    expect(deferProviderStatus).not.toHaveBeenCalled();
    expect(downloadArchive).toHaveBeenCalledOnce();
    expect(downloadArchive).toHaveBeenCalledWith(
      expect.objectContaining({ allowProviderFileIdFallback: true }),
    );
    expect(activateInitial).toHaveBeenCalledWith(
      expect.objectContaining({
        providerTaskId: taskId,
        operationKey,
        initialBundleExpectation: {
          operationId: operationKey,
          buildId: build.id,
          generation: 1,
          contentVersion: 1,
          skillContentHash: build.skillContentHash,
          treePolicyVersion: 2,
          companyName: build.companyName,
          companyWebsite: `${build.companyWebsite}/`,
          expectedUploadsRead: 0,
        },
      }),
    );
    expect(stopTask).not.toHaveBeenCalled();
    expect(sendMessage).not.toHaveBeenCalled();
    expect(deleteTask).not.toHaveBeenCalled();
  });

  it("requires an approved reset after a Provider 2xx-to-local-bind crash", async () => {
    const operationKey = "9".repeat(64);
    const taskId = "materialized-task-created-before-bind-crash";
    const build = {
      id: "00000000-0000-4000-8000-0000000000b7",
      userId: 7,
      conversationId: "conversation-materialized-bind-crash",
      generation: 1,
      revision: 0,
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
    const claim = {
      turn: {
        id: "00000000-0000-4000-8000-0000000000e7",
        userId: 7,
        conversationId: build.conversationId,
        buildId: build.id,
        buildGeneration: build.generation,
        expectedRevision: build.revision,
        expectedLeafId: null,
        expectedUserAttachmentCount: 0,
        operationType: "start",
        operationKey,
        operationToken: operationKey,
        status: "running",
        upstreamTaskId: null,
        providerProtocol: "manus_v2",
        providerMethod: "task.create",
        materializedRecoveryContractVersion: 1,
        materializedCompletionContractVersion: 2,
        providerAttemptState: "not_sent",
        createAttemptState: "not_sent",
      },
      leaseToken: "lease-materialized-bind-crash",
      recoveryMetadata: { kind: "start", parentTaskId: null },
      preparedDispatch: null,
    } as any;
    const prepared = {
      schemaVersion: 2 as const,
      baseUrl: "https://api.example.test",
      requestBody: {
        prompt: "只返回本轮 Bundle ZIP",
        agentProfile: "manus-1.6",
        attachments: [],
      },
      bodySha256: "b".repeat(64),
      preparedAt: "2026-08-15T00:00:00.000Z",
    };
    const createTask = vi.fn().mockResolvedValue({
      taskId,
      taskUrl: `https://manus.im/app/${taskId}`,
      requestId: "request-created-before-bind-crash",
    });
    const findCreatedTask = vi.fn();
    const listAllMessages = vi.fn();
    const bindSubmission = vi
      .fn()
      .mockRejectedValueOnce(new Error("local bind transaction failed"))
      .mockResolvedValueOnce(undefined);
    const ensureManusV2Attachments = vi.fn().mockResolvedValue([]);
    const dependencies = {
      loadBuild: vi.fn().mockResolvedValue(build),
      ensureDispatch: vi.fn().mockResolvedValue(prepared),
      ensureManusV2Attachments,
      beginDispatch: vi.fn().mockResolvedValue({
        method: "task.create",
        canonicalTaskId: null,
        operationToken: operationKey,
        title: `FrontMind KB ${build.id} g${build.generation} ${claim.turn.id}`,
      }),
      bindSubmission,
      deferProviderStatus: vi.fn().mockResolvedValue({
        state: "deferred",
        retryAfterMs: 15_000,
        ledger: { schemaVersion: 1 },
      }),
      createClient: vi.fn().mockReturnValue({
        createTask,
        findCreatedTask,
        listAllMessages,
      }),
    } as any;

    await expect(
      knowledgeBaseTerminalAnchorRecoveryTestHooks.dispatchKnowledgeBaseRecoveryClaim(
        claim,
        { id: "credential-base", apiKey: "base-secret" } as any,
        dependencies,
      ),
    ).rejects.toThrow("local bind transaction failed");
    expect(claim.turn).toMatchObject({
      upstreamTaskId: null,
      createAttemptState: "unknown",
      providerAttemptState: "output_pending",
    });

    const markManusV2OutcomeUnknown = vi.fn().mockResolvedValue(undefined);
    await expect(
      persistKnowledgeBaseDispatchFailure(
        {
          claim,
          error: new Error("local bind transaction failed"),
          outcomeUnknownCode: "MANUS_V2_BIND_PERSISTENCE_UNKNOWN",
          recoveryDelayMs: 1_000,
        },
        { markManusV2OutcomeUnknown },
      ),
    ).resolves.toBe("retriable");
    expect(markManusV2OutcomeUnknown).toHaveBeenCalledOnce();

    claim.turn.providerAttemptState = "outcome_unknown";
    await expect(
      knowledgeBaseTerminalAnchorRecoveryTestHooks.dispatchKnowledgeBaseRecoveryClaim(
        claim,
        { id: "credential-base", apiKey: "base-secret" } as any,
        dependencies,
      ),
    ).rejects.toMatchObject({ code: "RESET_REQUIRED" });
    expect(createTask).toHaveBeenCalledOnce();
    expect(findCreatedTask).not.toHaveBeenCalled();
    expect(listAllMessages).not.toHaveBeenCalled();
    expect(bindSubmission).toHaveBeenCalledOnce();
    expect(ensureManusV2Attachments).toHaveBeenCalledOnce();
  });

  it("reads one terminal exact task twice before settling a no-ZIP reset", async () => {
    const operationKey = "f".repeat(64);
    const taskId = "materialized-terminal-no-zip";
    const build = {
      id: "00000000-0000-4000-8000-0000000000bf",
      userId: 7,
      conversationId: "conversation-materialized-terminal-no-zip",
      companyName: "No ZIP Company",
      companyWebsite: "https://no-zip.example.test",
      generation: 1,
      revision: 0,
      treePolicyVersion: 2,
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
    const claim = {
      turn: {
        id: "00000000-0000-4000-8000-0000000000ef",
        userId: 7,
        conversationId: build.conversationId,
        buildId: build.id,
        buildGeneration: 1,
        expectedRevision: 0,
        expectedLeafId: null,
        expectedUserAttachmentCount: 0,
        operationType: "start",
        operationKey,
        operationToken: operationKey,
        status: "running",
        upstreamTaskId: taskId,
        providerProtocol: "manus_v2",
        providerMethod: "task.create",
        materializedRecoveryContractVersion: 1,
        materializedCompletionContractVersion: 2,
        materializedCompletion: null,
        providerAttemptState: "output_pending",
        createAttemptState: "acknowledged",
      },
      leaseToken: "lease-materialized-terminal-no-zip",
      recoveryMetadata: { kind: "start" },
      preparedDispatch: null,
    } as any;
    const stoppedEvents = [
      {
        id: "status-terminal-no-zip",
        type: "status_update",
        timestamp: 10,
        status_update: { agent_status: "stopped" },
      },
    ];
    const listAllMessages = vi.fn().mockResolvedValue(stoppedEvents);
    const createTask = vi.fn();
    const findCreatedTask = vi.fn();
    const sendMessage = vi.fn();
    const deferProviderStatus = vi.fn();

    await expect(
      knowledgeBaseTerminalAnchorRecoveryTestHooks.dispatchKnowledgeBaseRecoveryClaim(
        claim,
        { id: "credential-base", apiKey: "base-secret" } as any,
        {
          loadBuild: vi.fn().mockResolvedValue(build),
          ensureDispatch: vi.fn().mockResolvedValue({
            schemaVersion: 2,
            baseUrl: "https://api.example.test",
            requestBody: {
              prompt: "bundle",
              agentProfile: "manus-1.6",
              attachments: [],
            },
            bodySha256: "b".repeat(64),
            preparedAt: "2026-08-17T00:00:00.000Z",
          }),
          deferProviderStatus,
          createClient: vi.fn().mockReturnValue({
            createTask,
            findCreatedTask,
            listAllMessages,
            sendMessage,
            stopTask: vi.fn(),
          }),
        } as any,
      ),
    ).rejects.toMatchObject({
      code: "KNOWLEDGE_BASE_MATERIALIZED_RESULT_UNAVAILABLE",
    });
    expect(listAllMessages).toHaveBeenCalledTimes(2);
    expect(listAllMessages).toHaveBeenNthCalledWith(1, {
      taskId,
      order: "desc",
    });
    expect(listAllMessages).toHaveBeenNthCalledWith(2, {
      taskId,
      order: "desc",
    });
    expect(createTask).not.toHaveBeenCalled();
    expect(findCreatedTask).not.toHaveBeenCalled();
    expect(sendMessage).not.toHaveBeenCalled();
    expect(deferProviderStatus).not.toHaveBeenCalled();
  });

  it("rejects a pre-cutover materialized turn before prepare or any Provider call", async () => {
    const ensureDispatch = vi.fn();
    const ensureManusV2Attachments = vi.fn();
    const beginDispatch = vi.fn();
    const createClient = vi.fn();

    await expect(
      knowledgeBaseTerminalAnchorRecoveryTestHooks.dispatchKnowledgeBaseRecoveryClaim(
        {
          turn: {
            id: "turn-materialized-reset-required",
            userId: 7,
            buildId: "build-materialized-reset-required",
            buildGeneration: 1,
            materializedRecoveryContractVersion: null,
          },
        } as any,
        { id: "credential-current", apiKey: "current-secret-key" } as any,
        {
          loadBuild: vi.fn().mockResolvedValue({
            id: "build-materialized-reset-required",
            executionMode: "materialized_bundle_v1",
            skillVersion: "5",
            providerProtocol: "manus_v2",
            contentVersion: 0,
            handoffProvenance: null,
          }),
          ensureDispatch,
          ensureManusV2Attachments,
          beginDispatch,
          createClient,
        } as any,
      ),
    ).rejects.toMatchObject({ code: "RESET_REQUIRED" });

    expect(ensureDispatch).not.toHaveBeenCalled();
    expect(ensureManusV2Attachments).not.toHaveBeenCalled();
    expect(beginDispatch).not.toHaveBeenCalled();
    expect(createClient).not.toHaveBeenCalled();
  });

  it("rejects an old-hash unfinished v5 build before any Provider I/O", async () => {
    const ensureDispatch = vi.fn();
    const ensureManusV2Attachments = vi.fn();
    const beginDispatch = vi.fn();
    const createClient = vi.fn();

    await expect(
      knowledgeBaseTerminalAnchorRecoveryTestHooks.dispatchKnowledgeBaseRecoveryClaim(
        {
          turn: {
            id: "turn-materialized-old-hash",
            userId: 7,
            buildId: "build-materialized-old-hash",
            buildGeneration: 1,
            materializedRecoveryContractVersion: 1,
            materializedCompletionContractVersion: 2,
          },
        } as any,
        { id: "credential-current", apiKey: "current-secret-key" } as any,
        {
          loadBuild: vi.fn().mockResolvedValue({
            id: "build-materialized-old-hash",
            executionMode: "materialized_bundle_v1",
            skillVersion: "5",
            skillContentHash: "a".repeat(64),
            providerProtocol: "manus_v2",
            contentVersion: 0,
            handoffProvenance: {
              materializedRecoveryContractVersion: 1,
              materializedCompletionContractVersion: 2,
            },
          }),
          ensureDispatch,
          ensureManusV2Attachments,
          beginDispatch,
          createClient,
        } as any,
      ),
    ).rejects.toMatchObject({ code: "RESET_REQUIRED" });

    expect(ensureDispatch).not.toHaveBeenCalled();
    expect(ensureManusV2Attachments).not.toHaveBeenCalled();
    expect(beginDispatch).not.toHaveBeenCalled();
    expect(createClient).not.toHaveBeenCalled();
  });

  it("rejects an explicitly legacy build before preparing files or creating a Provider task", async () => {
    const ensureDispatch = vi.fn();
    const ensureManusV2Attachments = vi.fn();
    const createTask = vi.fn();
    const sendMessage = vi.fn();

    await expect(
      knowledgeBaseTerminalAnchorRecoveryTestHooks.dispatchKnowledgeBaseRecoveryClaim(
        {
          turn: {
            id: "turn-legacy-reset-required",
            userId: 7,
            buildId: "build-legacy-reset-required",
            buildGeneration: 1,
          },
        } as any,
        { id: "credential-current", apiKey: "current-secret-key" } as any,
        {
          loadBuild: vi.fn().mockResolvedValue({
            id: "build-legacy-reset-required",
            executionMode: "legacy_conversational",
            skillVersion: "4",
            providerProtocol: "manus_v2",
          }),
          ensureDispatch,
          ensureManusV2Attachments,
          createClient: vi.fn().mockReturnValue({ createTask, sendMessage }),
        } as any,
      ),
    ).rejects.toMatchObject({ code: "RESET_REQUIRED" });
    expect(ensureDispatch).not.toHaveBeenCalled();
    expect(ensureManusV2Attachments).not.toHaveBeenCalled();
    expect(createTask).not.toHaveBeenCalled();
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it("rejects a missing build before preparing files or creating a Provider task", async () => {
    const ensureDispatch = vi.fn();
    const ensureManusV2Attachments = vi.fn();
    const beginDispatch = vi.fn();
    const createTask = vi.fn();
    const sendMessage = vi.fn();
    const createClient = vi.fn().mockReturnValue({ createTask, sendMessage });

    await expect(
      knowledgeBaseTerminalAnchorRecoveryTestHooks.dispatchKnowledgeBaseRecoveryClaim(
        {
          turn: {
            id: "turn-missing-build",
            userId: 7,
            buildId: "build-missing",
            buildGeneration: 1,
          },
        } as any,
        { id: "credential-current", apiKey: "current-secret-key" } as any,
        {
          loadBuild: vi.fn().mockResolvedValue(null),
          ensureDispatch,
          ensureManusV2Attachments,
          beginDispatch,
          createClient,
        } as any,
      ),
    ).rejects.toMatchObject({ code: "BUILD_NOT_FOUND" });
    expect(ensureDispatch).not.toHaveBeenCalled();
    expect(ensureManusV2Attachments).not.toHaveBeenCalled();
    expect(beginDispatch).not.toHaveBeenCalled();
    expect(createClient).not.toHaveBeenCalled();
    expect(createTask).not.toHaveBeenCalled();
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it("fails a compatible create closed when the build already has a canonical task", async () => {
    const operationKey = "b".repeat(64);
    const claim = {
      turn: {
        id: "turn-compatible-state-changed",
        userId: 7,
        conversationId: "conversation-compatible-state-changed",
        buildId: "build-compatible-state-changed",
        buildGeneration: 3,
        expectedRevision: 7,
        expectedLeafId: "1.8",
        operationType: "confirm",
        operationKey,
        operationToken: operationKey,
        status: "running",
        upstreamTaskId: null,
        providerProtocol: "manus_v2",
        providerMethod: "task.create",
        providerAttemptState: "not_sent",
        createAttemptState: "not_sent",
      },
      leaseToken: "lease-compatible-state-changed",
      recoveryMetadata: {
        kind: "turn",
        conversationId: "conversation-compatible-state-changed",
        compatibilityMode: "minimal_v2_create",
      },
      preparedDispatch: null,
    } as any;
    const beginDispatch = vi.fn();
    const ensureDispatch = vi.fn();
    const ensureManusV2Attachments = vi.fn();
    const createTask = vi.fn();
    const sendMessage = vi.fn();

    await expect(
      knowledgeBaseTerminalAnchorRecoveryTestHooks.dispatchKnowledgeBaseRecoveryClaim(
        claim,
        { id: "credential-current", apiKey: "current-secret-key" } as any,
        {
          loadBuild: vi.fn().mockResolvedValue({
            id: claim.turn.buildId,
            userId: claim.turn.userId,
            generation: claim.turn.buildGeneration,
            providerProtocol: "manus_v2",
            canonicalTaskId: "canonical-task-created-concurrently",
          }),
          ensureDispatch,
          ensureManusV2Attachments,
          beginDispatch,
          createClient: vi.fn().mockReturnValue({
            createTask,
            sendMessage,
          }),
        } as any,
      ),
    ).rejects.toMatchObject({ code: "RESET_REQUIRED" });
    expect(ensureDispatch).not.toHaveBeenCalled();
    expect(ensureManusV2Attachments).not.toHaveBeenCalled();
    expect(beginDispatch).not.toHaveBeenCalled();
    expect(createTask).not.toHaveBeenCalled();
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it("rejects a retired compatible-create reservation before any Provider work", async () => {
    process.env.FRONTMIND_KB_MANUS_V2_WRITER = "true";
    const operationKey = "c".repeat(64);
    const claim = {
      turn: {
        id: "turn-compatible-create",
        userId: 7,
        conversationId: "conversation-compatible-create",
        buildId: "build-compatible-create",
        buildGeneration: 3,
        expectedRevision: 7,
        expectedLeafId: "1.8",
        operationType: "confirm",
        operationKey,
        operationToken: operationKey,
        status: "running",
        upstreamTaskId: null,
        providerProtocol: "manus_v2",
        providerMethod: "task.create",
        providerAttemptState: "not_sent",
        createAttemptState: "not_sent",
      },
      leaseToken: "lease-compatible-create",
      upstreamIdempotencyKey: `frontmind-kb-v2:${operationKey}`,
      recoveryMetadata: {
        kind: "turn",
        conversationId: "conversation-compatible-create",
        compatibilityMode: "minimal_v2_create",
      },
      preparedDispatch: null,
    } as any;
    const build = {
      id: claim.turn.buildId,
      userId: claim.turn.userId,
      executionMode: "legacy_conversational",
      generation: claim.turn.buildGeneration,
      revision: claim.turn.expectedRevision,
      contentVersion: null,
      currentLeafId: claim.turn.expectedLeafId,
      status: "confirming",
      providerProtocol: "manus_v2",
      activeTurnId: claim.turn.id,
      canonicalTaskId: null,
      canonicalTaskUrl: null,
      canonicalTaskState: "unbound",
      upstreamTaskId: null,
      totalNodeCount: 8,
      confirmedCount: 7,
      directPrefilledCount: 0,
      lastTurnAttachmentCount: 0,
      skillVersion: "4",
      handoffProvenance: {},
    } as any;
    const prepared = {
      schemaVersion: 2 as const,
      baseUrl: "https://api.example.test",
      requestBody: {
        prompt: "确认当前节点",
        agentProfile: "manus-1.6-max",
        attachments: [],
      },
      bodySha256: "f".repeat(64),
      preparedAt: "2026-08-14T00:00:00.000Z",
    };
    const beginDispatch = vi.fn().mockResolvedValue({
      method: "task.create",
      canonicalTaskId: null,
      title: `FrontMind KB ${build.id} g${build.generation}`,
      operationToken: operationKey,
    });
    const createTask = vi.fn().mockResolvedValue({
      taskId: "compatible-canonical-task",
      taskUrl: null,
      requestId: "request-compatible-create",
    });
    const sendMessage = vi.fn();
    const ensureDispatch = vi.fn().mockResolvedValue(prepared);
    const ensureManusV2Attachments = vi.fn().mockResolvedValue([]);
    const createClient = vi.fn().mockReturnValue({
      createTask,
      sendMessage,
      updateTaskVisibility: vi.fn().mockResolvedValue(undefined),
      findCreatedTask: vi.fn(),
      listAllMessages: vi.fn(),
    });

    try {
      await expect(
        knowledgeBaseTerminalAnchorRecoveryTestHooks.dispatchKnowledgeBaseRecoveryClaim(
          claim,
          { id: "credential-current", apiKey: "current-secret-key" } as any,
          {
            loadBuild: vi.fn().mockResolvedValue(build),
            ensureDispatch,
            ensureManusV2Attachments,
            beginDispatch,
            createClient,
            bindSubmission: vi.fn().mockResolvedValue(undefined),
            reconcileTask: vi.fn().mockResolvedValue(false),
          } as any,
        ),
      ).rejects.toMatchObject({ code: "RESET_REQUIRED" });
    } finally {
      delete process.env.FRONTMIND_KB_MANUS_V2_WRITER;
    }

    expect(ensureDispatch).not.toHaveBeenCalled();
    expect(ensureManusV2Attachments).not.toHaveBeenCalled();
    expect(beginDispatch).not.toHaveBeenCalled();
    expect(createClient).not.toHaveBeenCalled();
    expect(createTask).not.toHaveBeenCalled();
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it("rejects a retired local-rehydrate reservation before any Provider work", async () => {
    process.env.FRONTMIND_KB_MANUS_V2_WRITER = "true";
    const operationKey = "a".repeat(64);
    const claim = {
      turn: {
        id: "turn-local-rehydrate",
        userId: 7,
        conversationId: "conversation-local-rehydrate",
        buildId: "build-local-rehydrate",
        buildGeneration: 3,
        expectedRevision: 7,
        expectedLeafId: "1.8",
        operationType: "confirm",
        operationKey,
        operationToken: operationKey,
        status: "running",
        upstreamTaskId: null,
        providerProtocol: "manus_v2",
        providerMethod: null,
        providerAttemptState: "not_sent",
        createAttemptState: "not_sent",
        attachmentsFrozen: false,
      },
      leaseToken: "lease-local-rehydrate",
      leaseExpiresAt: new Date("2026-08-14T00:05:00.000Z"),
      upstreamIdempotencyKey: `frontmind-kb-v2:${operationKey}`,
      recoveryMetadata: {
        kind: "turn",
        conversationId: "conversation-local-rehydrate",
        localRehydrateAuthority: "local_rehydrate_unbound",
      },
      preparedDispatch: null,
    } as any;
    const build = {
      id: claim.turn.buildId,
      userId: claim.turn.userId,
      executionMode: "legacy_conversational",
      generation: claim.turn.buildGeneration,
      revision: claim.turn.expectedRevision,
      contentVersion: null,
      currentLeafId: claim.turn.expectedLeafId,
      status: "confirming",
      providerProtocol: "manus_v2",
      activeTurnId: claim.turn.id,
      canonicalTaskId: null,
      canonicalTaskUrl: null,
      upstreamTaskId: null,
      totalNodeCount: 8,
      confirmedCount: 7,
      directPrefilledCount: 0,
      lastTurnAttachmentCount: 0,
      skillVersion: "4",
      handoffProvenance: {
        localRehydrateRequired: {
          reason: "generated_attachment_invalid_preprovider",
          sourceTurnId: "released-source-turn",
        },
      },
    } as any;
    const prepared = {
      schemaVersion: 2 as const,
      baseUrl: "https://api.example.test",
      requestBody: {
        prompt: "确认当前节点",
        agentProfile: "manus-1.6-max",
        attachments: [{ file_id: "local-skill", filename: "skill.zip" }],
      },
      bodySha256: "f".repeat(64),
      preparedAt: "2026-08-14T00:00:00.000Z",
    };
    const handoff = {
      snapshot: {} as any,
      json: JSON.stringify({
        schemaVersion: 1,
        purpose: "legacy_to_manus_v2_handoff",
        build: { id: build.id, revision: 7 },
        nodes: [{ leafId: "1.8", contentMarkdown: "已完成正文" }],
        acceptedReceipts: [],
        pendingOperation: { action: "confirm" },
      }),
      sha256: "e".repeat(64),
    };
    const loadPreproviderAuthority = vi.fn().mockResolvedValue({
      sourceTurnId: "released-source-turn",
    });
    const ensureDispatch = vi.fn().mockResolvedValue(prepared);
    const ensureManusV2Attachments = vi.fn().mockResolvedValue([
      {
        file_data: "data:application/zip;base64,UEsDBAoAAAAA",
        filename: "skill.zip",
        mime_type: "application/zip",
      },
    ]);
    const beginDispatch = vi.fn().mockResolvedValue({
      method: "task.create",
      canonicalTaskId: null,
      title: `FrontMind KB ${build.id} g${build.generation}`,
      operationToken: operationKey,
    });
    const createTask = vi.fn().mockResolvedValue({
      taskId: "new-canonical-task",
      taskUrl: "https://example.test/task/new-canonical-task",
      requestId: "request-new-canonical-task",
    });
    const sendMessage = vi.fn();
    const client = {
      createTask,
      sendMessage,
      updateTaskVisibility: vi.fn().mockResolvedValue(undefined),
      findCreatedTask: vi.fn(),
      listAllMessages: vi.fn().mockResolvedValue([]),
    };
    const bindSubmission = vi.fn().mockImplementation(async ({ taskId }) => {
      build.canonicalTaskId = taskId;
      claim.turn.upstreamTaskId = taskId;
    });
    const dependencies = {
      loadBuild: vi.fn().mockImplementation(async () => build),
      loadPreproviderAuthority,
      buildHandoffSnapshot: vi.fn().mockResolvedValue(handoff),
      ensureDispatch,
      ensureManusV2Attachments,
      beginDispatch,
      createClient: vi.fn().mockReturnValue(client),
      bindSubmission,
      reconcileTask: vi.fn().mockResolvedValue(false),
    } as any;

    await expect(
      knowledgeBaseTerminalAnchorRecoveryTestHooks.dispatchKnowledgeBaseRecoveryClaim(
        claim,
        { id: "credential-current", apiKey: "current-secret-key" } as any,
        dependencies,
      ),
    ).rejects.toMatchObject({ code: "RESET_REQUIRED" });
    expect(loadPreproviderAuthority).not.toHaveBeenCalled();
    expect(ensureDispatch).not.toHaveBeenCalled();
    expect(ensureManusV2Attachments).not.toHaveBeenCalled();
    expect(beginDispatch).not.toHaveBeenCalled();
    expect(dependencies.createClient).not.toHaveBeenCalled();
    expect(createTask).not.toHaveBeenCalled();
    expect(sendMessage).not.toHaveBeenCalled();
    delete process.env.FRONTMIND_KB_MANUS_V2_WRITER;
  });

  it("uses the configured workspace enterprise and rejects client identity changes", () => {
    expect(
      resolveKnowledgeBaseEnterpriseIdentity({
        sourceName: "管理员结构化编辑",
        brandName: " 验收企业 ",
        requestedCompanyName: "验收企业",
      }),
    ).toBe("验收企业");

    expect(
      resolveKnowledgeBaseEnterpriseIdentity({
        sourceName: null,
        brandName: "验收企业",
        requestedCompanyName: "验收企业",
      }),
    ).toBe("验收企业");

    expectEnterpriseIdentityError(
      () =>
        resolveKnowledgeBaseEnterpriseIdentity({
          sourceName: "dashboard.json",
          brandName: "验收企业",
          requestedCompanyName: "另一家企业",
        }),
      "ENTERPRISE_IDENTITY_MISMATCH",
    );
  });

  it("allows a compatible client to omit the repeated company name", () => {
    expect(
      resolveKnowledgeBaseEnterpriseIdentity({
        sourceName: "dashboard.csv",
        brandName: "验收企业",
      }),
    ).toBe("验收企业");
  });

  it("always reconciles the full snapshot regardless of cursor or reused IDs", () => {
    const cumulative = [
      { id: "out-1", role: "assistant", content: "first" },
      { id: "out-2", role: "assistant", content: "second" },
    ];
    expect(
      selectUnreconciledKnowledgeOutput(cumulative, {
        lastOutputLength: 1,
        lastOutputItemIds: ["out-1"],
      }),
    ).toEqual(cumulative);

    const currentTurn = [
      { id: "out-9", role: "assistant", content: "current only" },
    ];
    expect(
      selectUnreconciledKnowledgeOutput(currentTurn, {
        lastOutputLength: 8,
        lastOutputItemIds: ["out-1", "out-8"],
      }),
    ).toEqual(currentTurn);

    expect(
      selectUnreconciledKnowledgeOutput(cumulative, {
        lastOutputLength: cumulative.length,
        lastOutputItemIds: ["out-1", "out-2"],
      }),
    ).toEqual(cumulative);

    const replacedTerminalTurn = [
      {
        id: "out-2",
        role: "assistant",
        content: "same provider ID, replaced terminal content",
      },
    ];
    expect(
      selectUnreconciledKnowledgeOutput(
        replacedTerminalTurn,
        {
          lastOutputLength: 1,
          lastOutputItemIds: ["out-2"],
        },
        { replayStableOutput: true },
      ),
    ).toEqual(replacedTerminalTurn);
  });

  it("requires closed envelopes while active and validates partial settled output", () => {
    const partial = [
      {
        id: "partial",
        role: "assistant",
        content: '<!-- FRONTMIND_KB_MANIFEST\n{"kind":',
      },
    ];
    const closedInvalid = [
      {
        id: "closed",
        role: "assistant",
        content: "<!-- FRONTMIND_KB_UNKNOWN\n{} \n-->",
      },
    ];

    expect(shouldReconcileKnowledgeOutput(partial, "running")).toBe(false);
    expect(shouldReconcileKnowledgeOutput(partial, "awaiting_user")).toBe(true);
    expect(shouldReconcileKnowledgeOutput(closedInvalid, "running")).toBe(
      false,
    );
    expect(shouldReconcileKnowledgeOutput(partial, "completed")).toBe(true);
  });

  it("replays same-ID output when the provider is waiting for the next user turn", () => {
    expect(shouldReplayStableKnowledgeOutput("awaiting_user")).toBe(true);
    expect(shouldReplayStableKnowledgeOutput("input_required")).toBe(true);
    for (const status of [
      "completed",
      "complete",
      "succeeded",
      "success",
      "done",
      "finished",
      "failed",
      "error",
      "cancelled",
      "canceled",
    ]) {
      expect(shouldReplayStableKnowledgeOutput(status)).toBe(true);
    }
    expect(shouldReplayStableKnowledgeOutput("running")).toBe(false);

    const replacedOutput = [
      {
        id: "reused-output",
        role: "assistant",
        content: "new closed knowledge envelope",
      },
    ];
    expect(
      selectUnreconciledKnowledgeOutput(
        replacedOutput,
        {
          lastOutputLength: 1,
          lastOutputItemIds: ["reused-output"],
        },
        {
          replayStableOutput:
            shouldReplayStableKnowledgeOutput("awaiting_user"),
        },
      ),
    ).toEqual(replacedOutput);
  });

  it("waits for both v3 transition and presentation envelopes", () => {
    const transitionOnly = [
      {
        id: "transition",
        role: "assistant",
        content:
          '<!-- FRONTMIND_KB_PROGRESS\n{"kind":"frontmind.knowledge-base.progress"}\n-->',
      },
    ];
    const complete = [
      {
        id: "complete",
        role: "assistant",
        content:
          transitionOnly[0].content +
          '\n<!-- FRONTMIND_KB_PRESENTATION\n{"kind":"frontmind.knowledge-base.presentation"}\n-->',
      },
    ];

    expect(
      shouldReconcileKnowledgeOutput(transitionOnly, "running", {
        requirePresentation: true,
      }),
    ).toBe(false);
    expect(
      shouldReconcileKnowledgeOutput(complete, "running", {
        requirePresentation: true,
      }),
    ).toBe(true);
    expect(
      shouldReconcileKnowledgeOutput(transitionOnly, "completed", {
        requirePresentation: true,
      }),
    ).toBe(true);
  });

  it("routes a terminal acknowledgement-only response into protocol validation", () => {
    const acknowledgement = [
      {
        id: "ack-only",
        role: "assistant",
        type: "message",
        content: "已收到。",
      },
    ];
    expect(
      shouldReconcileKnowledgeOutput(acknowledgement, "running", {
        requirePresentation: true,
      }),
    ).toBe(false);
    expect(
      shouldReconcileKnowledgeOutput(acknowledgement, "completed", {
        requirePresentation: true,
      }),
    ).toBe(true);
  });

  it("accepts legacy bare JSON only after the task has settled", () => {
    const bareManifest = [
      {
        id: "raw-manifest",
        role: "assistant",
        type: "message",
        content: JSON.stringify({
          kind: "frontmind.knowledge-base.manifest",
          schemaVersion: 1,
          leaves: [],
        }),
      },
    ];
    const bareTransition = [
      {
        id: "raw-transition",
        role: "assistant",
        type: "message",
        content: [
          JSON.stringify({
            kind: "frontmind.knowledge-base.progress",
            schemaVersion: 1,
          }),
          JSON.stringify({
            kind: "frontmind.knowledge-base.presentation",
            schemaVersion: 1,
          }),
        ].join("\n"),
      },
    ];

    expect(
      shouldReconcileKnowledgeOutput(bareManifest, "running", {
        requirePresentation: true,
      }),
    ).toBe(false);
    expect(
      shouldReconcileKnowledgeOutput(bareTransition, "running", {
        requirePresentation: true,
      }),
    ).toBe(false);
    expect(
      shouldReconcileKnowledgeOutput(bareManifest, "completed", {
        requirePresentation: true,
      }),
    ).toBe(true);
    expect(
      shouldReconcileKnowledgeOutput(bareTransition, "awaiting_input", {
        requirePresentation: true,
      }),
    ).toBe(true);
  });

  it("lets an authoritative confirming build override a still-running upstream task", () => {
    const progress = {
      build: {
        id: "build-1",
        conversationId: "conversation-1",
        companyName: "验收企业",
        status: "confirming",
        revision: 0,
        currentLeafId: "identity.name",
        protocolError: null,
        awaitingResponseSince: null,
        updatedAt: Date.now(),
      },
      summary: {
        total: 8,
        handled: 0,
        confirmed: 0,
        directPrefilled: 0,
        pending: 7,
        current: 1,
        needsVerification: 0,
        overallPercent: 0,
      },
      branches: [],
      packageAllowed: false,
    } as const;

    expect(deriveKnowledgeBaseInteraction(progress, "running")).toMatchObject({
      interactionState: "awaiting_input",
      canReply: true,
      canPublish: false,
    });

    expect(
      deriveKnowledgeBaseInteraction(
        {
          ...progress,
          build: {
            ...progress.build,
            status: "researching",
            awaitingResponseSince: Date.now(),
          },
        },
        "failed",
      ),
    ).toMatchObject({
      interactionState: "executing",
      canReply: false,
      lockReason: "正在确认上游失败并保留最后正确正文",
    });
  });
});
