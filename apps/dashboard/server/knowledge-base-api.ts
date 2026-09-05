import axios from "axios";
import {
  and,
  asc,
  eq,
  gt,
  inArray,
  isNotNull,
  isNull,
  lte,
  or,
  sql,
} from "drizzle-orm";
import { Router } from "express";
import { createHash, randomUUID } from "node:crypto";
import { toKnowledgeBasePublicPayload } from "./knowledge-base-public-projection";
import {
  getFrontMindCredentials,
  getUpstreamBaseUrl,
  toUpstreamAgentProfile,
} from "./upstream-config";
import {
  AuthServiceError,
  credentialsUseSameUpstreamApiKey,
  getDecryptedCredentialForKnowledgeBaseReservation,
  getDecryptedCredentialForKnowledgeBaseUploadReservation,
  getEffectiveDecryptedCredentialForAccount,
  getCredentialForUpstreamResource,
  recordUpstreamResource,
} from "./auth-service";
import {
  KnowledgeBaseBuildError,
  assertKnowledgeBaseCustomerOutput,
  assertKnowledgeBaseTaskBinding,
  classifyKnowledgeBaseUserAction,
  extractFinalKnowledgeBaseAssistantText,
  getKnowledgeBaseProgress,
  getKnowledgeBaseObservationProjection,
  hasClosedKnowledgeBasePresentationEnvelope,
  hasClosedKnowledgeBaseStateEnvelope,
  isAmbiguousKnowledgeBaseAdvance,
  isIdempotentKnowledgeBaseReconcileError,
  isKnowledgeBaseAcknowledgementOnlyOutput,
  knowledgeBaseProtocolErrorAllowsSameTaskRecovery,
  observeKnowledgeBaseOperationalFailure,
  observeKnowledgeBaseProtocolFailure,
  reconcileKnowledgeBaseProgress,
  resumeKnowledgeBaseFinalPackageMissing,
} from "./knowledge-base-progress-service";
import {
  getDashboardWorkspace,
  getKnowledgeSnapshotById,
  getLatestKnowledgeSnapshot,
} from "./dashboard-service";
import {
  downloadArchiveBytes,
  KnowledgeArchiveDownloadError,
} from "./dashboard-api";
import {
  assertServiceCapability,
  ServiceEntitlementError,
} from "./service-entitlement";
import type {
  KnowledgeBaseInteractionDto,
  KnowledgeBaseObservationDto,
  KnowledgeBaseProgressDto,
} from "../shared/knowledge-base-progress";
import { normalizeKnowledgeBaseAttachmentMimeType } from "../shared/knowledge-base-attachment";
import {
  apiCredentials,
  conversationTurns,
  conversations,
  knowledgeBaseBuildNodes,
  knowledgeBaseBuilds,
  messages,
  upstreamResources,
} from "../drizzle/schema";
import { getDb } from "./db";
import {
  uploadUpstreamTaskAttachment,
  UpstreamTaskAttachmentContentProofError,
  UpstreamTaskAttachmentPendingError,
} from "./upstream-task-attachment";
import { recordKnowledgeBaseOutputFiles } from "./knowledge-base-output-resource-service";
import { assertKnowledgeBaseWritable } from "./knowledge-base-reset-service";
import { extractKnowledgeBaseProtocolObjects } from "../shared/knowledge-base-output";
import { parseExactJson } from "../shared/model-output-repair";
import {
  classifyKnowledgeBaseUpstreamTaskStatus,
  formatKnowledgeBaseManifestEnvelope,
  formatKnowledgeBasePresentationEnvelope,
  formatKnowledgeBaseProgressEnvelope,
  KNOWLEDGE_BASE_MANIFEST_KIND,
  KNOWLEDGE_BASE_PRESENTATION_KIND,
  KNOWLEDGE_BASE_PROGRESS_KIND,
  KNOWLEDGE_BASE_PROTOCOL_V4_SCHEMA_VERSION,
  parseKnowledgeBasePresentationEnvelope,
  parseKnowledgeBaseProgressEnvelope,
  parseKnowledgeBaseManifestEnvelope,
  validateKnowledgeBaseManifestForTreePolicy,
} from "./knowledge-base-progress";
import { knowledgeBaseInteractionTelemetryEvents } from "./knowledge-base-interaction-telemetry";
import {
  logKnowledgeBaseDispatchPhaseTelemetry,
  logKnowledgeBaseOperationTelemetry,
  type KnowledgeBaseDispatchPhase,
} from "./knowledge-base-operation-telemetry";
import {
  bindKnowledgeBaseFinalPackage,
  bindKnowledgeBaseInitialLogo,
  bindKnowledgeBaseOfficialLogoUpload,
  bindKnowledgeBaseReadyPackage,
  assertKnowledgeBaseOfficialLogoUploadCandidate,
  cleanupKnowledgeBaseStagedArtifactCandidate,
  collectKnowledgeBaseLogoDescriptors,
  KnowledgeBaseArtifactBindingError,
  recoverKnowledgeBaseInitialLogoFromCompletedTurn,
  type KnowledgeBaseInitialLogoDisposition,
  type KnowledgeBaseOfficialLogoUpload,
  type KnowledgeBaseStagedArtifactCandidate,
} from "./knowledge-base-artifact-binding-service";
import {
  collectKnowledgeArchiveDescriptors,
  knowledgeArchivePhysicalDescriptorHash,
} from "./knowledge-base-artifact";
import {
  beginKnowledgeBaseManusV2Dispatch,
  bindKnowledgeBaseManusV2Submission,
  cancelUnpreparedKnowledgeBaseTurn,
  cancelIncompleteKnowledgeBaseStart,
  cancelIncompleteKnowledgeBaseRevision,
  claimKnowledgeBaseDeferredTurnDispatch,
  claimKnowledgeBaseTurnForRecovery,
  completeKnowledgeBaseGeneratedAttachment,
  settleKnowledgeBaseManusV2ExplicitRejection,
  settleKnowledgeBasePreCreateFailureForApprovedReset,
  deferKnowledgeBaseTurnBeforeCreate,
  ensureKnowledgeBaseBuildSkillArchivePin,
  failKnowledgeBaseMaterializedResultForApprovedReset,
  deferKnowledgeBaseMaterializedResultRead,
  findRecoverableKnowledgeBaseTurnIds,
  failKnowledgeBaseTurnDeterministically,
  freezeKnowledgeBaseTurnAttachments,
  hashKnowledgeBaseTurnRequest,
  inspectKnowledgeBaseDeferredAttachmentReplay,
  inspectKnowledgeBaseDeferredDispatchReplay,
  inspectKnowledgeBaseLegacyAttachmentTakeoverReplay,
  inspectKnowledgeBaseLegacyDeferredReservationReplay,
  inspectKnowledgeBaseLegacyStartReplay,
  inspectKnowledgeBaseTurnReplay,
  knowledgeBaseMaterializedRecoveryContractVersion,
  markKnowledgeBaseTurnDispatching,
  markKnowledgeBaseTurnOutcomeUnknown,
  markKnowledgeBaseManusV2OutcomeUnknown,
  deferKnowledgeBaseMaterializedProviderStatus,
  pauseKnowledgeBasePreCreateCredentialUnavailable,
  prepareKnowledgeBaseTurnDispatch,
  promoteKnowledgeBaseGeneratedAttachmentReady,
  replaceUnusableKnowledgeBaseGeneratedAttachment,
  reserveKnowledgeBaseGeneratedAttachment,
  reserveKnowledgeBaseStartBuild,
  reserveKnowledgeBaseTurn,
  rejectAcknowledgedKnowledgeBaseManualLogoTurn,
  rejectUnacknowledgedKnowledgeBaseManualLogoTurn,
  renewKnowledgeBaseTurnLease,
  observeKnowledgeBaseMaterializedResultDiagnostic,
  stageKnowledgeBaseDeferredTurnAttachment,
  stageKnowledgeBaseTurnAttachments,
  KnowledgeBaseTurnReservationError,
  type KnowledgeBaseCreateAttemptState,
  type KnowledgeBaseGeneratedAttachmentReservation,
  type KnowledgeBaseGeneratedAttachmentRole,
  type KnowledgeBasePreparedDispatch,
  type KnowledgeBaseRecoveryClaim,
  type KnowledgeBaseDeferredDispatchClaim,
  type KnowledgeBaseTurnReservation,
  type KnowledgeBaseMaterializedResultDiagnostic,
  knowledgeBaseMaterializedCompletionContractVersion,
} from "./knowledge-base-turn-service";
import {
  findRetainedKnowledgeBaseLocalAsset,
  resumeKnowledgeBaseDeferredTurnAttachments,
} from "./knowledge-base-deferred-upload-recovery";
import {
  inspectKnowledgeBaseDeferredAttachmentStagePolicy,
  knowledgeBaseTurnLogoPolicy,
  requireKnowledgeBaseDeferredAttachmentStageBuild,
} from "./knowledge-base-deferred-attachment-stage-policy";

import {
  appendManusV2KnowledgeBaseOperationContract,
  buildManusV2CreateTaskBody,
  buildManusV2KnowledgeBaseStructuredOutputSchema,
  buildManusV2SendMessageBody,
  latestManusV2TaskState,
  ManusV2ApiError,
  ManusV2Client,
  manusV2EventsContainOperationToken,
  manusV2KnowledgeBaseStructuredResultForOperation,
  normalizeManusV2Output,
  orderManusV2EventsByProviderRank,
  type ManusV2KnowledgeBaseOperationContract,
  type ManusV2MessageEvent,
} from "./manus-v2-client";
import {
  ensureKnowledgeBaseManusV2Attachments,
  isKnowledgeBaseManusV2GeneratedFileCreateRejected,
} from "./knowledge-base-manus-v2-attachments";
import { assertCapturedKnowledgeBaseCustomerImage } from "./knowledge-base-customer-upload";
import { readStoredPresalesFile } from "./presales-file-store";
import {
  persistKnowledgeBaseBuildSource,
  persistKnowledgeBaseGeneratedSource,
  readKnowledgeBaseLocalSource,
} from "./knowledge-base-local-source-store";
import {
  activateInitialKnowledgeBaseWorkingSet,
  applyKnowledgeBaseRevisionWorkingSet,
  bindMaterializedKnowledgeBaseOfficialLogoLocally,
  confirmMaterializedKnowledgeBaseNode,
  KnowledgeBaseMaterializedError,
  MATERIALIZED_KNOWLEDGE_BASE_EXECUTION_MODE,
  readActiveKnowledgeBaseWorkingSet,
  validateKnowledgeBaseRevisionAgainstActiveWorkingSet,
} from "./knowledge-base-materialized-service";
import { isMaterializedBuildPublishable } from "./knowledge-base-materialized-quality";
import {
  KnowledgeBaseMaterializedContractError,
  normalizeMaterializedKnowledgeBaseResult,
  validateKnowledgeBaseWorkingSetArchive,
  type KnowledgeBaseInitialBundleExpectation,
  type KnowledgeBaseNormalizationOutcome,
  type KnowledgeBaseResultProcessingStage,
} from "./knowledge-base-materialized-contract";
import { KNOWLEDGE_BASE_MATERIALIZED_COMPLETION_CONTRACT_VERSION } from "./knowledge-base-materialized-completion-contract";
import { ManagedUploadIntentError } from "./managed-upload-intent";
import {
  assertKnowledgeBaseAttachmentManifestPresent,
  normalizeKnowledgeBaseClientAttachmentManifest,
  normalizeKnowledgeBaseUserAttachments,
  type KnowledgeBaseAttachment,
  type KnowledgeBaseClientAttachmentManifestItem,
} from "./knowledge-base-client-attachment-manifest";
import { assertKnowledgeBaseExpectedGeneration } from "./knowledge-base-turn-coordinates";
import { logKnowledgeBaseRuntimeFailure } from "./knowledge-base-runtime-log";
import {
  matchesAuthoritativeKnowledgeBaseMessageTuple,
  parsedKnowledgeBaseMessageMetadata,
} from "./knowledge-base-authoritative-message";
import {
  getKnowledgeBaseSkillDescriptor,
  KNOWLEDGE_BASE_SKILL_ATTACHMENT_FILENAME,
  knowledgeBasePinnedV4SkillSelection,
  readKnowledgeBaseSkillArchiveAttachment,
} from "./knowledge-base-skill-runtime";
import {
  knowledgeBaseNewBuildPolicyBinding,
  KNOWLEDGE_BASE_MATERIALIZED_V5_SKILL_CONTENT_HASH,
} from "./knowledge-base-tree-policy-rollout";
import {
  buildKnowledgeBasePrefillEvidenceArchive,
  buildKnowledgeBasePrompt,
  KnowledgeBaseEnterpriseIdentityError,
  KNOWLEDGE_BASE_PREFILL_ATTACHMENT_FILENAME,
  resolveKnowledgeBaseEnterpriseIdentity,
} from "./knowledge-base-prompt-contract";
import {
  canonicalizeKnowledgeBaseCompanyName,
  canonicalizeKnowledgeBaseWebsite,
} from "./knowledge-base-company-identity";
import {
  buildKnowledgeBaseInstructionDelivery,
  KNOWLEDGE_BASE_INSTRUCTIONS_FILENAME,
} from "./knowledge-base-prompt-delivery";
import { buildKnowledgeBaseTurnPrompt } from "./knowledge-base-turn-prompt";
import {
  assertKnowledgeBaseCustomerUploadCapacity,
  assertKnowledgeBaseManifestDoesNotRepeatOfficialLogo,
  buildFinalizationInputForTurn,
  knowledgeBaseBuildRequiresOfficialLogo,
  knowledgeBaseManifestRepeatsOfficialLogo,
  knowledgeBaseTurnRequiresFinalPackage,
  loadKnowledgeBaseBuildRecord,
  loadKnowledgeBaseBuildRecordById,
  shouldBindKnowledgeBaseInitialLogo,
} from "./knowledge-base-final-turn-service";
import {
  applyKnowledgeBaseFinalLogoProvenanceObservation,
  assertKnowledgeBaseFinalLogoProvenanceForBuild,
  inspectKnowledgeBaseFinalLogoProvenance,
} from "./knowledge-base-logo-provenance-repair";
import {
  createKnowledgeBaseLogoProvenanceErrorResponder,
  createKnowledgeBaseLogoProvenanceRouter,
} from "./knowledge-base-logo-provenance-api";
import {
  assertUpstreamPromptBudget,
  UpstreamPromptBudgetError,
} from "./upstream-prompt-budget";
import {
  classifyKnowledgeBaseUpstreamCreateFailure,
  knowledgeBaseArtifactFailureNotice,
  KNOWLEDGE_BASE_AGENT_PROFILE,
  KnowledgeBaseAttachmentsProcessingError,
  KnowledgeBaseLocalPreparationError,
  KnowledgeBaseManusV2RolloutDeferredError,
  KnowledgeBaseUpstreamCreateError,
  KNOWLEDGE_BASE_UPSTREAM_CREATE_TIMEOUT_MS,
  type KnowledgeBaseUpstreamCreateFailureClass,
  type KnowledgeBaseProviderReasonCategory,
} from "./knowledge-base-api-errors";
import {
  checkUpstreamFilesReadiness,
  waitForUpstreamFilesReady,
  UpstreamFileReadinessError,
  type UpstreamFilesReadiness,
} from "./upstream-file-readiness";
import {
  assertExpectedUpstreamTaskId,
  canonicalUpstreamTask,
  upstreamTaskId,
} from "./upstream-task-adapter";

export * from "./knowledge-base-api-errors";

export * from "./knowledge-base-client-attachment-manifest";
export * from "./knowledge-base-turn-coordinates";
export * from "./knowledge-base-runtime-log";
export * from "./knowledge-base-prompt-contract";
export { knowledgeBaseTurnLogoPolicy } from "./knowledge-base-deferred-attachment-stage-policy";
export {
  getKnowledgeBaseSkillDescriptor,
  KNOWLEDGE_BASE_SKILL_ATTACHMENT_FILENAME,
  knowledgeBasePinnedV4SkillSelection,
  readKnowledgeBaseSkillArchiveAttachment,
} from "./knowledge-base-skill-runtime";
export {
  knowledgeBaseTurnRequiresFinalPackage,
  shouldBindKnowledgeBaseInitialLogo,
} from "./knowledge-base-final-turn-service";
export { buildKnowledgeBaseTurnPrompt } from "./knowledge-base-turn-prompt";

const router = Router();

// No authenticated knowledge-base response bypasses the customer-safe
// projection, including legacy error branches that predate observation DTOs.
router.use((_req, res, next) => {
  const sendJson = res.json.bind(res);
  res.json = ((body: unknown) =>
    sendJson(toKnowledgeBasePublicPayload(body))) as typeof res.json;
  next();
});

async function requireKnowledgeBuildCapability(
  userId: number,
  res: import("express").Response,
) {
  try {
    await assertServiceCapability(userId, "knowledgeBuild");
    return true;
  } catch (error) {
    if (error instanceof ServiceEntitlementError) {
      res.status(error.statusCode).json({
        error: {
          code: error.code,
          message: error.message,
        },
      });
      return false;
    }
    throw error;
  }
}

interface KnowledgeBaseStartRequest {
  conversationId?: string;
  clientRequestId?: string;
  companyName?: string;
  companyWebsite?: string;
  operatorNotes?: string;
  attachments?: KnowledgeBaseAttachment[];
  expectedResetRevision?: number;
}

function reservationRetryAfterMs(reservation: KnowledgeBaseTurnReservation) {
  return reservation.state === "pending" ? reservation.retryAfterMs : 1_000;
}

export function knowledgeBaseReservationReceipt(
  reservation: Exclude<KnowledgeBaseTurnReservation, { state: "acquired" }>,
  stateEpoch?: number | null,
) {
  const dispatchState =
    reservation.state === "bound"
      ? "bound"
      : reservation.state === "pending"
        ? "recovering"
        : reservation.turn.dispatchState;
  return {
    state: reservation.state,
    dispatchState,
    turnId: reservation.turn.id,
    clientRequestId: reservation.turn.clientRequestId,
    generation: reservation.turn.buildGeneration,
    stateEpoch: stateEpoch ?? null,
    revision: reservation.turn.expectedRevision,
    leafId: reservation.turn.expectedLeafId,
    upstreamTaskId: reservation.turn.upstreamTaskId,
    failureClass: reservation.turn.failureClass,
    recoveryAction: reservation.turn.recoveryAction,
    canRegenerate: reservation.turn.canRegenerate,
    createAttemptState: reservation.turn.createAttemptState,
    traceId: reservation.turn.traceId,
    sourceResetRevision: reservation.turn.sourceResetRevision ?? null,
    stagedAttachmentCount: reservation.turn.stagedUserAttachmentCount,
    expectedAttachmentCount: reservation.turn.expectedUserAttachmentCount,
    requiresUpload:
      reservation.state === "awaiting_attachments" &&
      reservation.turn.stagedUserAttachmentCount <
        reservation.turn.expectedUserAttachmentCount,
  };
}

export function knowledgeBaseAcceptedReservationReceipt(input: {
  turn: KnowledgeBaseRecoveryClaim["turn"];
  stateEpoch?: number | null;
}) {
  return {
    state: "pending" as const,
    // `reserved` is an internal outbox state. Once the HTTP request has been
    // accepted, the only truthful public states are "recovering" (the durable
    // claim is being dispatched/reconciled) or "bound" (a real provider task
    // id is already persisted). Never expose the turn id as a provider id.
    dispatchState: input.turn.upstreamTaskId ? "bound" : "recovering",
    turnId: input.turn.id,
    clientRequestId: input.turn.clientRequestId,
    generation: input.turn.buildGeneration,
    stateEpoch: input.stateEpoch ?? null,
    revision: input.turn.expectedRevision,
    leafId: input.turn.expectedLeafId,
    upstreamTaskId: input.turn.upstreamTaskId,
    failureClass: input.turn.failureClass,
    recoveryAction: input.turn.recoveryAction,
    canRegenerate: input.turn.canRegenerate,
    createAttemptState: input.turn.createAttemptState,
    traceId: input.turn.traceId,
    sourceResetRevision: input.turn.sourceResetRevision ?? null,
    stagedAttachmentCount: input.turn.stagedUserAttachmentCount,
    expectedAttachmentCount: input.turn.expectedUserAttachmentCount,
    requiresUpload: false,
  };
}

export const KNOWLEDGE_BASE_MANUAL_LOGO_PENDING_MESSAGE =
  "FrontMind 已接收 Logo，正在重新呈现当前知识节点";
export const KNOWLEDGE_BASE_MANUAL_LOGO_USER_INSTRUCTION =
  "用户已明确提交一张企业官方主 Logo。请只更新并重新展示当前首节点，不得确认或推进节点。";
export const KNOWLEDGE_BASE_MANUAL_LOGO_DISPLAY_MESSAGE =
  "已提交新的企业官方主 Logo，正在重新呈现当前知识节点。";

export function knowledgeBasePresentationRequiresBoundLogo(input: {
  skillVersion?: string;
  revision: number;
  handled: number;
  logoRequired?: boolean;
  logoAvailable?: boolean;
}) {
  return (
    input.logoAvailable === true &&
    input.skillVersion === "4" &&
    input.revision === 0 &&
    input.handled === 0 &&
    input.logoRequired !== true
  );
}

export function knowledgeBaseManualLogoPendingResponse(input: {
  observation?: KnowledgeBaseObservationDto | null;
  retryAfterMs?: number;
}) {
  return {
    status: 425 as const,
    retryAfterSeconds: String(
      Math.max(1, Math.ceil((input.retryAfterMs ?? 1_000) / 1_000)),
    ),
    body: {
      error: {
        code: "IDEMPOTENCY_PENDING" as const,
        message: KNOWLEDGE_BASE_MANUAL_LOGO_PENDING_MESSAGE,
      },
      ...(input.observation ? { observation: input.observation } : {}),
    },
  };
}

export function knowledgeBaseManualLogoUnclassifiedFailureResponse(input: {
  reservationAcquired: boolean;
  observation?: KnowledgeBaseObservationDto | null;
  retryAfterMs?: number;
}) {
  if (input.reservationAcquired) {
    return knowledgeBaseManualLogoPendingResponse(input);
  }
  return {
    status: 503 as const,
    retryAfterSeconds: String(
      Math.max(1, Math.ceil((input.retryAfterMs ?? 1_000) / 1_000)),
    ),
    body: {
      error: {
        code: "KNOWLEDGE_BASE_LOGO_SUBMISSION_UNCERTAIN" as const,
        message: "Logo 提交结果暂未确认，系统将按同一请求自动重试",
      },
      ...(input.observation ? { observation: input.observation } : {}),
    },
  };
}

export function knowledgeBaseManualLogoTerminalFailure(error: unknown) {
  if (!(error instanceof KnowledgeBaseArtifactBindingError)) return null;
  if (error.code === "LOGO_UPLOAD_INVALID") {
    return {
      status: 422 as const,
      code: "KNOWLEDGE_BASE_LOGO_UPLOAD_INVALID" as const,
      message: error.message,
    };
  }
  if (error.code === "BUILD_CHANGED") {
    return {
      status: 409 as const,
      code: "KNOWLEDGE_BASE_LOGO_UPLOAD_CONFLICT" as const,
      message: error.message,
    };
  }
  return null;
}

export async function assertManualKnowledgeBaseLogoUploadCandidate(
  upload: Omit<KnowledgeBaseOfficialLogoUpload, "verified">,
  validateCapturedImage: typeof assertCapturedKnowledgeBaseCustomerImage = assertCapturedKnowledgeBaseCustomerImage,
) {
  try {
    assertKnowledgeBaseOfficialLogoUploadCandidate(upload);
    await validateCapturedImage({
      fileId: upload.fileId,
      filename: upload.filename,
      mimeType: upload.mimeType,
      sizeBytes: upload.sizeBytes,
      sourceSha256: upload.sourceSha256,
    });
  } catch (error) {
    throw new KnowledgeBaseTurnReservationError(
      "KNOWLEDGE_BASE_LOGO_UPLOAD_INVALID",
      error instanceof KnowledgeBaseArtifactBindingError
        ? error.message
        : "上传的 Logo 原始文件无法安全解码或完整性校验失败，请重新选择原文件",
    );
  }
}

export function knowledgeBaseManualLogoDeterministicCreateFailureStatus(
  error: unknown,
) {
  if (
    !(error instanceof KnowledgeBaseUpstreamCreateError) ||
    error.failureClass !== "deterministic"
  ) {
    return null;
  }
  // A successful provider response without a task id does not prove that the
  // provider rejected the create. Manual Logo submission must reconcile the
  // same reservation instead of reporting a terminal validation failure.
  if (error.failureCode === "UPSTREAM_TASK_ID_MISSING") return null;
  if (error.status === 400) return 400 as const;
  if (error.status === 401 || error.status === 403) return 403 as const;
  if (error.status === 409) return 409 as const;
  if (error.status === 413) return 413 as const;
  if (error.status === 422) return 422 as const;
  return 422 as const;
}

export function knowledgeBaseManualLogoCreateFailureForPersistence(
  error: unknown,
) {
  if (
    error instanceof KnowledgeBaseUpstreamCreateError &&
    error.failureCode === "UPSTREAM_TASK_ID_MISSING"
  ) {
    return new KnowledgeBaseUpstreamCreateError(
      "unknown",
      error.failureCode,
      error.status,
    );
  }
  return error;
}

function respondKnowledgeBaseManualLogoPending(input: {
  observation?: KnowledgeBaseObservationDto | null;
  retryAfterMs?: number;
  res: import("express").Response;
}) {
  const response = knowledgeBaseManualLogoPendingResponse(input);
  input.res.setHeader("Retry-After", response.retryAfterSeconds);
  input.res.status(response.status).json(response.body);
}

function respondKnowledgeBaseManualLogoUnclassifiedFailure(input: {
  reservationAcquired: boolean;
  observation?: KnowledgeBaseObservationDto | null;
  retryAfterMs?: number;
  res: import("express").Response;
}) {
  const response = knowledgeBaseManualLogoUnclassifiedFailureResponse(input);
  input.res.setHeader("Retry-After", response.retryAfterSeconds);
  input.res.status(response.status).json(response.body);
}

export function knowledgeBaseTurnReservationErrorStatus(
  error: KnowledgeBaseTurnReservationError,
) {
  if (error.code === "KNOWLEDGE_BASE_REQUEST_REPLAY_MISMATCH") {
    logKnowledgeBaseOperationTelemetry({
      event: "turn_replay_mismatch",
      reasonCode: error.code,
    });
  } else if (error.code === "STALE_KNOWLEDGE_BASE_PRESENTATION") {
    logKnowledgeBaseOperationTelemetry({
      event: "stale_presentation_submission",
      reasonCode: error.code,
    });
  }
  if (
    error.code === "BUILD_NOT_FOUND" ||
    error.code === "RESERVATION_NOT_FOUND"
  ) {
    return 404;
  }
  if (error.code === "INVALID_REQUEST") return 400;
  if (error.code === "KNOWLEDGE_BASE_RESET_REVISION_CHANGED") return 409;
  if (error.code === "KNOWLEDGE_BASE_LOGO_UPLOAD_INVALID") return 422;
  if (error.code === "IDEMPOTENCY_PENDING") return 425;
  // Stale presentation, immutable replay mismatch and Logo binding conflict
  // are all durable coordinate conflicts, not malformed requests.
  return 409;
}

export function knowledgeBaseTurnReplayHttpStatus(
  state: Exclude<KnowledgeBaseTurnReservation, { state: "acquired" }>["state"],
  terminalStatus = 409,
) {
  if (state === "pending" || state === "bound") return 202;
  if (state === "terminal") return terminalStatus;
  return 200;
}

async function respondKnowledgeBaseTurnReplayReceipt(input: {
  userId: number;
  conversationId: string;
  requestedClientRequestId: string;
  receipt: Exclude<KnowledgeBaseTurnReservation, { state: "acquired" }>;
  replayHit?: boolean;
  requireUpstreamTaskId?: boolean;
  terminalStatus?: number;
  suppressTerminalError?: boolean;
  resumed?: boolean;
  res: import("express").Response;
}) {
  const { receipt, res } = input;
  if (input.replayHit === true) {
    logKnowledgeBaseOperationTelemetry({
      event: "turn_replay_hit",
      buildId: receipt.turn.buildId,
      turnId: receipt.turn.id,
      reasonCode:
        receipt.turn.clientRequestId === input.requestedClientRequestId
          ? "exact_request"
          : "operation_winner",
      adoptedWinner:
        receipt.turn.clientRequestId !== input.requestedClientRequestId,
    });
  }
  const observation = await getKnowledgeBaseObservation({
    userId: input.userId,
    conversationId: input.conversationId,
    upstreamStatus: receipt.state === "completed" ? "completed" : "running",
  }).catch(() => null);
  if (input.requireUpstreamTaskId && receipt.state === "pending") {
    respondKnowledgeBaseManualLogoPending({
      observation,
      retryAfterMs: reservationRetryAfterMs(receipt),
      res,
    });
    return;
  }
  const inFlight = receipt.state === "pending" || receipt.state === "bound";
  if (inFlight) {
    res.setHeader(
      "Retry-After",
      String(Math.ceil(reservationRetryAfterMs(receipt) / 1_000)),
    );
  }
  const taskId =
    receipt.state === "bound" || receipt.state === "completed"
      ? receipt.upstreamTaskId
      : null;
  res
    .status(
      knowledgeBaseTurnReplayHttpStatus(receipt.state, input.terminalStatus),
    )
    .json({
      ...(receipt.state === "terminal" && input.suppressTerminalError !== true
        ? {
            error: {
              code: "KNOWLEDGE_BASE_TURN_TERMINAL",
              message: "本轮提交已结束，请按当前知识库状态重试",
            },
          }
        : {}),
      reservation: knowledgeBaseReservationReceipt(
        receipt,
        observation?.stateEpoch,
      ),
      ...(receipt.turn.clientRequestId !== input.requestedClientRequestId
        ? { adoptedClientRequestId: receipt.turn.clientRequestId }
        : {}),
      ...(taskId
        ? {
            task: {
              id: taskId,
              status: receipt.state === "completed" ? "completed" : "running",
            },
          }
        : {}),
      observation,
      progress: observation?.interaction.progress || null,
      interaction:
        observation?.interaction ||
        deriveKnowledgeBaseInteraction(null, "running"),
      idempotent: true,
      ...(input.resumed === true ? { resumed: true } : {}),
      startedAt: receipt.turn.startedAt?.getTime() || Date.now(),
    });
}

async function respondIfKnowledgeBaseTurnReplay(input: {
  userId: number;
  conversationId: string;
  requestedClientRequestId: string;
  inspect: () => Promise<Exclude<
    KnowledgeBaseTurnReservation,
    { state: "acquired" }
  > | null>;
  requireUpstreamTaskId?: boolean;
  res: import("express").Response;
}) {
  const receipt = await input.inspect();
  if (!receipt) return false;
  await respondKnowledgeBaseTurnReplayReceipt({
    userId: input.userId,
    conversationId: input.conversationId,
    requestedClientRequestId: input.requestedClientRequestId,
    receipt,
    replayHit: true,
    requireUpstreamTaskId: input.requireUpstreamTaskId,
    res: input.res,
  });
  return true;
}

type KnowledgeBaseBuildRecord = Awaited<
  ReturnType<typeof loadKnowledgeBaseBuildRecord>
>;

const MATERIALIZED_BUNDLE_COORDINATE_PATTERN =
  /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;

/**
 * Builds the provider-visible initial bundle contract exclusively from the
 * locked Dashboard build and its server-owned operation id. Every value used
 * on the validator command line is constrained to a shell-safe alphabet
 * before any Provider file or task request can occur.
 */
function knowledgeBaseInitialBundleExpectation(input: {
  build: NonNullable<KnowledgeBaseBuildRecord>;
  operationId: string;
  expectedUploadsRead: number;
}): KnowledgeBaseInitialBundleExpectation {
  const { build, operationId, expectedUploadsRead } = input;
  let companyName: string;
  let companyWebsite: string | null;
  try {
    companyName = canonicalizeKnowledgeBaseCompanyName(build.companyName);
    companyWebsite = canonicalizeKnowledgeBaseWebsite(build.companyWebsite);
  } catch {
    throw new KnowledgeBaseEnterpriseIdentityError(
      "ENTERPRISE_IDENTITY_MISMATCH",
      "知识库物化任务的冻结合同坐标无效",
    );
  }
  if (
    !MATERIALIZED_BUNDLE_COORDINATE_PATTERN.test(operationId) ||
    !MATERIALIZED_BUNDLE_COORDINATE_PATTERN.test(build.id) ||
    !Number.isSafeInteger(build.generation) ||
    build.generation < 1 ||
    !/^[a-f0-9]{64}$/u.test(build.skillContentHash || "") ||
    build.treePolicyVersion !== 2 ||
    !Number.isSafeInteger(expectedUploadsRead) ||
    expectedUploadsRead < 0 ||
    expectedUploadsRead > 100 ||
    !companyName
  ) {
    throw new KnowledgeBaseEnterpriseIdentityError(
      "ENTERPRISE_IDENTITY_MISMATCH",
      "知识库物化任务的冻结合同坐标无效",
    );
  }
  return {
    operationId,
    buildId: build.id,
    generation: build.generation,
    contentVersion: 1,
    skillContentHash: build.skillContentHash!,
    treePolicyVersion: 2,
    companyName,
    companyWebsite,
    expectedUploadsRead,
  };
}

export class KnowledgeBaseMaterializedResultError extends Error {
  constructor(
    readonly code:
      | "KNOWLEDGE_BASE_MATERIALIZED_RESULT_INVALID"
      | "KNOWLEDGE_BASE_MATERIALIZED_RESULT_UNAVAILABLE",
    message: string,
  ) {
    super(message);
    this.name = "KnowledgeBaseMaterializedResultError";
  }
}

const MATERIALIZED_QUOTA_ERROR_TYPES = new Set([
  "insufficient_credits",
  "credit_exhausted",
  "quota_exceeded",
]);

function latestMaterializedErrorType(
  events: ReadonlyArray<ManusV2MessageEvent>,
) {
  const ordered = orderManusV2EventsByProviderRank(events, "oldest_first");
  let latestStatusIndex = -1;
  for (let index = ordered.length - 1; index >= 0; index -= 1) {
    const candidate = ordered[index]!;
    const statusUpdate =
      candidate.status_update &&
      typeof candidate.status_update === "object" &&
      !Array.isArray(candidate.status_update)
        ? (candidate.status_update as Record<string, unknown>)
        : null;
    if (typeof statusUpdate?.agent_status !== "string") continue;
    latestStatusIndex = index;
    break;
  }

  let precedingNonErrorStatusIndex = -1;
  for (let index = latestStatusIndex - 1; index >= 0; index -= 1) {
    const candidate = ordered[index]!;
    const statusUpdate =
      candidate.status_update &&
      typeof candidate.status_update === "object" &&
      !Array.isArray(candidate.status_update)
        ? (candidate.status_update as Record<string, unknown>)
        : null;
    const status =
      typeof statusUpdate?.agent_status === "string"
        ? statusUpdate.agent_status.trim().toLowerCase()
        : "";
    if (!status || status === "error" || status === "failed") continue;
    precedingNonErrorStatusIndex = index;
    break;
  }

  let event: ManusV2MessageEvent | undefined;
  for (
    let index = ordered.length - 1;
    index > precedingNonErrorStatusIndex;
    index -= 1
  ) {
    if (ordered[index]!.type !== "error_message") continue;
    event = ordered[index];
    break;
  }
  const envelope =
    event?.error_message &&
    typeof event.error_message === "object" &&
    !Array.isArray(event.error_message)
      ? (event.error_message as Record<string, unknown>)
      : null;
  const errorType =
    typeof envelope?.error_type === "string"
      ? envelope.error_type.trim().toLowerCase()
      : "";
  return errorType && errorType.length <= 128 ? errorType : null;
}

async function requireMaterializedKnowledgeBaseBuild(input: {
  userId: number;
  conversationId: string;
}) {
  const build = await loadKnowledgeBaseBuildRecord(
    input.userId,
    input.conversationId,
  );
  if (!build) {
    throw new KnowledgeBaseTurnReservationError(
      "BUILD_NOT_FOUND",
      "知识库构建不存在",
    );
  }
  if (
    build.executionMode !== MATERIALIZED_KNOWLEDGE_BASE_EXECUTION_MODE ||
    build.skillVersion !== "5" ||
    build.skillContentHash !==
      KNOWLEDGE_BASE_MATERIALIZED_V5_SKILL_CONTENT_HASH ||
    build.providerProtocol !== "manus_v2" ||
    build.contentVersion === null ||
    knowledgeBaseMaterializedRecoveryContractVersion(build) !== 1 ||
    knowledgeBaseMaterializedCompletionContractVersion(build) !==
      KNOWLEDGE_BASE_MATERIALIZED_COMPLETION_CONTRACT_VERSION
  ) {
    throw new KnowledgeBaseTurnReservationError(
      "RESET_REQUIRED",
      "旧知识库构建不再续跑；请批准重置并重新上传资料",
    );
  }
  return build;
}

export function selectMaterializedKnowledgeBaseAttachmentCredential<T>(input: {
  isStartReservation: boolean;
  startCredential: T | null;
  currentCredential: T | null;
}) {
  return input.isStartReservation
    ? input.startCredential
    : input.currentCredential;
}

export function knowledgeBaseUpstreamModelForCredential(credential: {
  upstreamModel?: unknown;
}) {
  if (
    credential.upstreamModel === "manus-1.6" ||
    credential.upstreamModel === "manus-1.6-max"
  ) {
    return credential.upstreamModel;
  }
  throw new KnowledgeBaseLocalPreparationError(
    "KNOWLEDGE_BASE_CREDENTIAL_PROFILE_MISSING",
    "知识库任务缺少已冻结的 Base/Pro 模型配置",
  );
}

async function readOwnedMaterializedKnowledgeBaseLocalAsset(input: {
  userId: number;
  localAssetId: string;
  filename: string;
  mimeType: string;
  sizeBytes: number;
  /** Optional legacy browser digest; stored bytes remain server-verified. */
  sha256?: string;
}) {
  const retained = await findRetainedKnowledgeBaseLocalAsset({
    ...input,
    includeBytes: true,
  });
  if (!retained?.bytes) {
    throw new KnowledgeBaseTurnReservationError(
      "CONFLICT",
      `附件“${input.filename}”的本地文件已过期或缺失，请重新上传`,
    );
  }
  return {
    bytes: retained.bytes,
    contentSha256: retained.contentSha256,
  };
}

/**
 * Resolve the server-owned build and its parent task from one database
 * snapshot. Accepted dispatch can replace upstreamTaskId without advancing
 * the build revision, so rereading only to compare the derived task ID creates
 * a false conflict for an otherwise valid lost-response replay.
 */
export async function loadKnowledgeBaseTurnAuthority(
  input: { userId: number; conversationId: string },
  loadBuild: typeof loadKnowledgeBaseBuildRecord = loadKnowledgeBaseBuildRecord,
): Promise<{
  build: NonNullable<KnowledgeBaseBuildRecord>;
  taskId: string;
  kind: "bound";
} | null> {
  const build = await loadBuild(input.userId, input.conversationId);
  const taskId = String(build?.canonicalTaskId || build?.upstreamTaskId || "");
  if (!build) return null;
  if (
    build.executionMode !== MATERIALIZED_KNOWLEDGE_BASE_EXECUTION_MODE ||
    build.skillVersion !== "5" ||
    build.providerProtocol !== "manus_v2" ||
    build.contentVersion === null ||
    knowledgeBaseMaterializedRecoveryContractVersion(build) !== 1 ||
    knowledgeBaseMaterializedCompletionContractVersion(build) !==
      KNOWLEDGE_BASE_MATERIALIZED_COMPLETION_CONTRACT_VERSION
  ) {
    throw new KnowledgeBaseBuildError(
      "RESET_REQUIRED",
      "旧知识库构建不再续跑；请批准重置并重新上传资料",
    );
  }
  if (taskId) return { build, taskId, kind: "bound" };
  throw new KnowledgeBaseBuildError(
    "RESET_REQUIRED",
    "未绑定上游任务的知识库构建不再重建；请批准重置并重新上传资料",
  );
}

function outputItemIds(output: unknown[]) {
  return output
    .map((item) =>
      item && typeof item === "object" && "id" in item
        ? String((item as { id?: unknown }).id || "")
        : "",
    )
    .filter(Boolean);
}

export function selectUnreconciledKnowledgeOutput(
  output: unknown[],
  _ledger: { lastOutputLength: number; lastOutputItemIds: string[] },
  _options: { replayStableOutput?: boolean } = {},
) {
  // Correctness never depends on a provider's cumulative-array length or item
  // IDs. Both can be reused/reordered/replaced between polls. The service
  // selects one semantic state candidate from the complete snapshot and makes
  // its application idempotent; the ledger remains telemetry only.
  return output;
}

const COMPLETE_KNOWLEDGE_PROTOCOL_ENVELOPE =
  /<!--\s*FRONTMIND_KB_(?:MANIFEST|PROGRESS|REOPEN)\b[\s\S]*?-->/i;
const COMPLETE_KNOWLEDGE_PROTOCOL_COMMENT =
  /<!--\s*FRONTMIND_KB_[A-Z_]+\b[\s\S]*?-->/i;
const COMPLETE_KNOWLEDGE_MANIFEST =
  /<!--\s*FRONTMIND_KB_MANIFEST\b[\s\S]*?-->/i;
const COMPLETE_KNOWLEDGE_TRANSITION =
  /<!--\s*FRONTMIND_KB_(?:PROGRESS|REOPEN)\b[\s\S]*?-->/i;
const COMPLETE_KNOWLEDGE_PRESENTATION =
  /<!--\s*FRONTMIND_KB_PRESENTATION\b[\s\S]*?-->/i;

function normalizedUpstreamTaskStatus(status: unknown) {
  return classifyKnowledgeBaseUpstreamTaskStatus(status).normalized;
}

const knowledgeInteractionAlertAt = new Map<string, number>();

function observeKnowledgeInteraction(
  progress: KnowledgeBaseProgressDto | null,
  upstreamStatus: unknown,
) {
  const normalized = normalizedUpstreamTaskStatus(upstreamStatus);
  const now = Date.now();
  const alert = (
    kind: string,
    dedupeKey: string,
    metadata: Record<string, unknown>,
  ) => {
    const key = `${progress?.build.id || "unbound"}:${kind}:${dedupeKey}`;
    const lastAlertAt = knowledgeInteractionAlertAt.get(key);
    if (
      lastAlertAt !== undefined &&
      (kind === "active_turn_age_bucket" || lastAlertAt > now - 10 * 60_000)
    ) {
      return;
    }
    knowledgeInteractionAlertAt.set(key, now);
    console.warn(
      `[KnowledgeBaseInteraction] ${kind}`,
      JSON.stringify(metadata),
    );
  };
  for (const event of knowledgeBaseInteractionTelemetryEvents({
    buildId: progress?.build.id,
    awaitingResponseSince: progress?.build.awaitingResponseSince,
    upstreamStatus: normalized,
    now,
  })) {
    alert(event.kind, event.dedupeKey, event.metadata);
  }
  if (knowledgeInteractionAlertAt.size > 1_000) {
    const expiry = now - 24 * 60 * 60_000;
    knowledgeInteractionAlertAt.forEach((lastSeen, key) => {
      if (lastSeen < expiry) knowledgeInteractionAlertAt.delete(key);
    });
  }
}

function upstreamTaskFailed(status: unknown) {
  return classifyKnowledgeBaseUpstreamTaskStatus(status).failed;
}

/**
 * Some providers stop at an interaction-ready status instead of `completed`.
 * At that point a same-ID output replacement is stable and must be replayed,
 * but an incomplete envelope must still remain non-terminal for validation.
 */
export function shouldReplayStableKnowledgeOutput(status: unknown) {
  return classifyKnowledgeBaseUpstreamTaskStatus(status).settled;
}

export function shouldReconcileKnowledgeOutput(
  output: unknown[],
  status: unknown,
  options: { requirePresentation?: boolean } = {},
) {
  const text = extractFinalKnowledgeBaseAssistantText(output);
  const taskStatus = classifyKnowledgeBaseUpstreamTaskStatus(status);
  if (!text) return taskStatus.settled;
  const closedState = hasClosedKnowledgeBaseStateEnvelope(text);
  const closedPresentation = hasClosedKnowledgeBasePresentationEnvelope(text);

  // A running stream may contain parseable JSON before the HTML comment and
  // companion resources are complete. Bare JSON is a legacy terminal-only
  // compatibility path and must never advance a running build.
  if (!taskStatus.settled) {
    if (!closedState) return false;
    if (!options.requirePresentation) return true;
    return COMPLETE_KNOWLEDGE_MANIFEST.test(text) || closedPresentation;
  }
  const rawKinds = new Set(
    extractKnowledgeBaseProtocolObjects(text).map((value) => value.kind),
  );
  if (options.requirePresentation) {
    if (
      COMPLETE_KNOWLEDGE_MANIFEST.test(text) ||
      rawKinds.has("frontmind.knowledge-base.manifest")
    ) {
      return true;
    }
    if (
      (COMPLETE_KNOWLEDGE_TRANSITION.test(text) ||
        rawKinds.has("frontmind.knowledge-base.progress") ||
        rawKinds.has("frontmind.knowledge-base.reopen")) &&
      (COMPLETE_KNOWLEDGE_PRESENTATION.test(text) ||
        rawKinds.has("frontmind.knowledge-base.presentation"))
    ) {
      return true;
    }
    return true;
  }
  if (
    COMPLETE_KNOWLEDGE_PROTOCOL_ENVELOPE.test(text) ||
    COMPLETE_KNOWLEDGE_PROTOCOL_COMMENT.test(text) ||
    rawKinds.has("frontmind.knowledge-base.manifest") ||
    rawKinds.has("frontmind.knowledge-base.progress") ||
    rawKinds.has("frontmind.knowledge-base.reopen")
  ) {
    return true;
  }
  // A terminal provider response without a complete protocol envelope is a
  // protocol failure. Waiting/running output may still be a partial stream, so
  // it must never poison the build or unlock input until a closed envelope is
  // present.
  return true;
}

export function deriveKnowledgeBaseInteraction(
  progress: KnowledgeBaseProgressDto | null,
  upstreamStatus: unknown,
): KnowledgeBaseInteractionDto {
  observeKnowledgeInteraction(progress, upstreamStatus);
  if (progress?.build.status === "published") {
    return {
      progress,
      interactionState: "published",
      canReply: false,
      canPublish: false,
      lockReason: "知识库已发布；后续修改请提交维护需求",
    };
  }
  if (
    progress?.resultQuality?.completeness === "partial" ||
    progress?.resultQuality?.downstreamEligible === false ||
    progress?.resultQuality?.publishable === false
  ) {
    return {
      progress,
      interactionState: "awaiting_input",
      canReply: false,
      canPublish: false,
      lockReason:
        "知识库内容不完整，可查看当前安全内容，但不能确认、修订或发布；请批准重置后重跑",
    };
  }
  if (progress?.build.status === "ready_to_publish") {
    return {
      progress,
      interactionState: "ready_to_publish",
      canReply: false,
      canPublish: progress.packageAllowed,
      lockReason: progress.packageAllowed
        ? "知识库内容与下载包已完成，请执行唯一一次直接更新"
        : "知识库内容已完成，下载包正在后台准备；已完成正文不受影响",
    };
  }
  if (
    progress?.build.status === "protocol_error" ||
    progress?.build.status === "failed"
  ) {
    return {
      progress,
      interactionState: "failed",
      canReply: false,
      canPublish: false,
      lockReason:
        progress?.build.protocolError || "知识库任务执行失败，请重新同步状态",
    };
  }
  if (
    progress?.build.status === "confirming" &&
    progress.build.currentLeafId &&
    progress.build.awaitingResponseSince === null
  ) {
    return {
      progress,
      interactionState: "awaiting_input",
      canReply: true,
      canPublish: false,
      lockReason: null,
    };
  }
  const interactionState =
    normalizedUpstreamTaskStatus(upstreamStatus) === "pending"
      ? "queued"
      : "executing";
  return {
    progress,
    interactionState,
    canReply: false,
    canPublish: false,
    lockReason: upstreamTaskFailed(upstreamStatus)
      ? "正在确认上游失败并保留最后正确正文"
      : "FrontMind 正在整理当前知识节点",
  };
}

/**
 * A fully approved node waiting for the customer's next decision is already a
 * terminal observation of the previous upstream operation. Focus/online
 * wakes may still call reconcile, but they must not reread that completed task
 * or turn a later credential/task outage into a failure of the approved node.
 */
export function isApprovedKnowledgeBaseAwaitingInputObservation(
  observation: KnowledgeBaseObservationDto | null,
) {
  const progress = observation?.interaction.progress;
  const presentation = observation?.approvedPresentation;
  return Boolean(
    observation &&
      observation.activeTurn === null &&
      observation.interaction.interactionState === "awaiting_input" &&
      observation.interaction.canReply === true &&
      progress?.build.status === "confirming" &&
      progress.build.awaitingResponseSince === null &&
      progress.build.currentLeafId &&
      presentation &&
      presentation.visibleMarkdown.trim() &&
      presentation.generation === observation.generation &&
      presentation.revision === progress.build.revision &&
      presentation.leafId === progress.build.currentLeafId,
  );
}

/**
 * Keep an immutable accepted presentation independent from optional Logo and
 * current-node resource projections. Those projections may be repaired
 * locally, but they are not writer authority and must never relock a turn that
 * the build has already made replyable.
 */
export function applyKnowledgeBasePresentationProjectionGuard(input: {
  progress: KnowledgeBaseProgressDto;
  observation: Pick<
    KnowledgeBaseObservationDto,
    | "generation"
    | "activeTurn"
    | "approvedPresentation"
    | "localRestrictions"
    | "notice"
  >;
  interaction: KnowledgeBaseInteractionDto;
}) {
  if (input.interaction.interactionState !== "awaiting_input") {
    return {
      interaction: input.interaction,
      localRestrictions: input.observation.localRestrictions,
      notice: input.observation.notice,
    };
  }

  const presentation = input.observation.approvedPresentation;
  const hasDisplayableAcceptedPresentation = Boolean(
    presentation?.visibleMarkdown.trim() && presentation.leafId.trim(),
  );
  const hasCurrentReplyAuthority = Boolean(
    hasDisplayableAcceptedPresentation &&
      input.observation.activeTurn === null &&
      presentation!.generation === input.observation.generation &&
      presentation!.revision === input.progress.build.revision &&
      presentation!.leafId === input.progress.build.currentLeafId,
  );
  if (!hasCurrentReplyAuthority) {
    return {
      interaction: {
        progress: input.progress,
        interactionState: "executing" as const,
        canReply: false,
        canPublish: false,
        lockReason: input.observation.activeTurn
          ? "FrontMind 正在完成当前操作"
          : "当前知识节点正在完成服务端展示校验",
      },
      localRestrictions: input.observation.localRestrictions,
      notice: input.observation.notice,
    };
  }

  const logoProjectionIncomplete =
    knowledgeBasePresentationRequiresBoundLogo({
      skillVersion: input.progress.build.skillVersion,
      revision: input.progress.build.revision,
      handled: input.progress.summary.handled,
      logoRequired: input.progress.build.logoRequired,
      logoAvailable: input.progress.build.logoAvailable,
    }) &&
    (presentation!.imageState !== "attached" ||
      presentation!.resources.filter((resource) => resource.kind === "logo")
        .length !== 1);
  if (!logoProjectionIncomplete) {
    return {
      interaction: input.interaction,
      localRestrictions: input.observation.localRestrictions,
      notice: input.observation.notice,
    };
  }

  return {
    interaction: input.interaction,
    localRestrictions: Array.from(
      new Set([
        ...(input.observation.localRestrictions || []),
        "logo_projection_repairing",
      ]),
    ),
    // The observation DTO has one notice slot. Never displace an existing
    // operational notice with this optional-resource projection warning.
    notice:
      input.observation.notice ||
      ({
        key: `${input.progress.build.id}:${input.progress.build.revision}:logo-projection-repairing`,
        code: "KNOWLEDGE_BASE_LOGO_PROJECTION_REPAIRING",
        severity: "warning" as const,
        message:
          "企业 Logo 展示资源正在局部恢复；已完成正文与本轮确认不受影响。",
        retryable: false,
        turnId: null,
        createdAt: input.progress.build.updatedAt,
      } satisfies NonNullable<KnowledgeBaseObservationDto["notice"]>),
  };
}

export function knowledgeBaseRetainedStartMayReplaceNotice(
  notice: KnowledgeBaseObservationDto["notice"],
) {
  if (!notice) return true;
  if (
    notice.recoveryAction === "stopped" ||
    notice.code === "FRONTMIND_KB_STOPPED"
  ) {
    return false;
  }
  return !(
    (notice.recoveryAction === "retry_request" ||
      notice.recoveryAction === "start_new_generation") &&
    typeof notice.recoveryToken === "string" &&
    /^[a-f0-9]{64}$/u.test(notice.recoveryToken)
  );
}

export function deriveKnowledgeBaseBusinessResultState(input: {
  progress: KnowledgeBaseProgressDto;
  observation: Pick<
    KnowledgeBaseObservationDto,
    "activeTurn" | "approvedPresentation" | "notice" | "processingPhase"
  >;
}) {
  const fallbackHasDisplayableContent = Boolean(
    input.progress.summary.handled > 0 ||
      input.observation.approvedPresentation?.visibleMarkdown.trim(),
  );
  const contentAvailability =
    input.progress.contentAvailability ??
    (!fallbackHasDisplayableContent
      ? ("none" as const)
      : input.progress.resultQuality?.completeness === "partial"
        ? ("partial" as const)
        : ("complete" as const));
  const materializedV5 =
    input.progress.build.executionMode === "materialized_bundle_v1" &&
    input.progress.build.skillVersion === "5";
  const resetAllowed = Boolean(
    input.progress.resetAllowed === true ||
      input.observation.notice?.recoveryAction === "approve_reset" ||
      (materializedV5 &&
        input.observation.activeTurn === null &&
        (input.progress.build.status === "protocol_error" ||
          input.progress.build.status === "failed")),
  );
  const fallbackOperationState = input.observation.activeTurn
    ? input.observation.processingPhase === "accepting"
      ? ("normalizing" as const)
      : input.observation.activeTurn.createAttemptState === "acknowledged" ||
          Boolean(input.observation.activeTurn.upstreamTaskId)
        ? ("waiting_output" as const)
        : ("creating" as const)
    : contentAvailability !== "none" ||
        input.progress.build.status === "ready_to_publish" ||
        input.progress.build.status === "published"
      ? ("completed" as const)
      : ("creating" as const);
  const operationState = resetAllowed
    ? ("reset_required" as const)
    : (input.progress.operationState ?? fallbackOperationState);
  const warningCodes = Array.from(
    new Set(
      [
        ...(input.progress.resultQuality?.warnings || []).map(
          (warning) => warning.code,
        ),
        ...(input.progress.warningCodes || []),
        input.observation.notice?.severity === "warning" ||
        input.observation.notice?.severity === "error"
          ? input.observation.notice.code
          : null,
      ].filter((value): value is string => Boolean(value)),
    ),
  );
  return {
    contentAvailability,
    operationState,
    resetAllowed,
    warningCodes,
  };
}

export async function getKnowledgeBaseObservation(input: {
  userId: number;
  conversationId: string;
  upstreamStatus: unknown;
}): Promise<KnowledgeBaseObservationDto | null> {
  const projection = await getKnowledgeBaseObservationProjection(input);
  if (!projection) return null;
  const { progress, ...observation } = projection;
  let interaction = deriveKnowledgeBaseInteraction(
    progress,
    input.upstreamStatus,
  );
  if (projection.processingPhase === "uploading") {
    interaction = {
      ...interaction,
      interactionState: "queued",
      canReply: false,
      canPublish: false,
      lockReason: "正在接收并校验本轮资料，任务尚未派发",
    };
  }
  const presentationProjection = applyKnowledgeBasePresentationProjectionGuard({
    progress,
    observation,
    interaction,
  });
  interaction = presentationProjection.interaction;
  observation.localRestrictions = presentationProjection.localRestrictions;
  observation.notice = presentationProjection.notice;
  const finalLogoProvenance = await inspectKnowledgeBaseFinalLogoProvenance({
    userId: input.userId,
    buildId: progress.build.id,
    generation: observation.generation,
  });
  const provenanceObservation =
    applyKnowledgeBaseFinalLogoProvenanceObservation({
      state: finalLogoProvenance,
      progress,
      observation,
      interaction,
    });
  interaction = provenanceObservation.interaction;
  observation.notice = provenanceObservation.notice;
  const businessState = deriveKnowledgeBaseBusinessResultState({
    progress,
    observation,
  });
  if (
    businessState.operationState === "reset_required" &&
    observation.notice &&
    (observation.notice.code === "FRONTMIND_KB_STOPPED" ||
      observation.notice.recoveryAction === "stopped" ||
      observation.notice.recoveryAction === "contact_support")
  ) {
    // Materialized-v5 has one terminal customer action: approve reset and run
    // a fresh task. Never project a Provider "stopped" conclusion alongside
    // content or a Dashboard reset-required state.
    observation.notice = {
      ...observation.notice,
      code: "FRONTMIND_KB_RESET_REQUIRED",
      message:
        "任务已结束，但本轮结果无法安全应用。系统不会自动重试；请申请重置后重新上传资料。",
      retryable: false,
      failureClass: "requires_user_fix",
      recoveryAction: "approve_reset",
      canRegenerate: false,
    };
    businessState.warningCodes = Array.from(
      new Set([
        ...businessState.warningCodes.filter(
          (code) => code !== "FRONTMIND_KB_STOPPED",
        ),
        "FRONTMIND_KB_RESET_REQUIRED",
      ]),
    );
  }
  return {
    ...observation,
    interaction,
    ...businessState,
  };
}

const respondKnowledgeBaseLogoProvenanceError =
  createKnowledgeBaseLogoProvenanceErrorResponder(getKnowledgeBaseObservation);

router.use(
  createKnowledgeBaseLogoProvenanceRouter({
    requireKnowledgeBuildCapability,
    getKnowledgeBaseObservation,
  }),
);

export function knowledgeBaseUpstreamReadFailureAuthority(input: {
  kind: "credential_unavailable" | "transport" | "http";
  status?: number;
}) {
  const credentialFailure =
    input.kind === "credential_unavailable" ||
    (input.kind === "http" && [401, 403].includes(Number(input.status)));
  return credentialFailure
    ? ({
        code:
          input.kind === "credential_unavailable"
            ? "UPSTREAM_CREDENTIAL_UNAVAILABLE"
            : "UPSTREAM_CREDENTIAL_REJECTED",
        failureClass: "requires_user_fix",
        recoveryAction: "update_credential",
        canRegenerate: false,
      } as const)
    : ({
        code: "UPSTREAM_TASK_READ_FAILED",
        failureClass: "recoverable_same_turn",
        recoveryAction: "reconcile",
        canRegenerate: false,
      } as const);
}

export function knowledgeBaseNoticeAllowsSameTaskReconcile(
  notice:
    | Pick<
        NonNullable<KnowledgeBaseObservationDto["notice"]>,
        "canRegenerate" | "recoveryAction"
      >
    | null
    | undefined,
) {
  return (
    notice?.canRegenerate !== true &&
    (notice?.recoveryAction === "reconcile" ||
      notice?.recoveryAction === "update_credential" ||
      notice?.recoveryAction === "top_up")
  );
}

export function knowledgeBasePreCreateUserFixObservationAllowsResume(input: {
  activeTurn: KnowledgeBaseObservationDto["activeTurn"];
  notice: KnowledgeBaseObservationDto["notice"];
  hasCredential: boolean;
}) {
  const { activeTurn, notice } = input;
  const resumableCreateBoundary =
    activeTurn?.createAttemptState === "not_sent" ||
    (activeTurn?.createAttemptState === "rejected" &&
      activeTurn.recoveryAction === "update_credential");
  return Boolean(
    activeTurn &&
      notice &&
      notice.turnId === activeTurn.id &&
      activeTurn.status === "failed" &&
      !activeTurn.upstreamTaskId &&
      activeTurn.failureClass === "requires_user_fix" &&
      activeTurn.canRegenerate === false &&
      resumableCreateBoundary &&
      notice.failureClass === "requires_user_fix" &&
      notice.canRegenerate === false &&
      notice.recoveryAction === activeTurn.recoveryAction &&
      (notice.recoveryAction === "top_up" ||
        notice.recoveryAction === "update_credential") &&
      input.hasCredential,
  );
}

export function knowledgeBaseReconcileFailureStatus(error: unknown) {
  if (error instanceof KnowledgeBaseBuildError) {
    return error.code === "BUILD_NOT_FOUND" ? 404 : 422;
  }
  if (error instanceof KnowledgeBaseTurnReservationError) {
    if (error.code === "BUILD_NOT_FOUND") return 404;
    if (
      error.code === "CONVERSATION_RESET" ||
      error.code === "RESET_REQUIRED" ||
      error.code === "KNOWLEDGE_BASE_RESET_REVISION_CHANGED" ||
      error.code === "TERMINAL"
    ) {
      return 410;
    }
    return 422;
  }
  return 503;
}

async function observeKnowledgeBaseUpstreamFailure(input: {
  userId: number;
  conversationId: string;
  taskId: string;
  code: string;
  message: string;
  failureClass: "recoverable_same_turn" | "requires_user_fix";
  recoveryAction: "reconcile" | "update_credential";
}) {
  await observeKnowledgeBaseOperationalFailure(input);
  const observation = await getKnowledgeBaseObservation({
    userId: input.userId,
    conversationId: input.conversationId,
    upstreamStatus:
      input.failureClass === "requires_user_fix" ? "failed" : "running",
  });
  return {
    observation,
    durable:
      input.failureClass === "requires_user_fix" &&
      (observation?.interaction.progress?.build.status === "protocol_error" ||
        observation?.interaction.progress?.build.status === "failed"),
  };
}

/**
 * Historical v3 could attach three visuals. Never guess which response
 * attachment was the Logo; its final ZIP manifest identifies the unique
 * brand_identity/badge and binds those bytes instead.
 */

async function cleanupUnpromotedKnowledgeBaseArtifactCandidates(
  userId: number,
  conversationId: string,
  candidates: readonly KnowledgeBaseStagedArtifactCandidate[],
) {
  if (candidates.length === 0) return;
  let build;
  try {
    build = await loadKnowledgeBaseBuildRecord(userId, conversationId);
  } catch {
    // A later GC sweep handles candidates left by database/process outages.
    return;
  }
  await Promise.all(
    candidates.map(async (candidate) => {
      const promotedStorageKey =
        candidate.kind === "logo"
          ? build?.logoStorageKey
          : build?.packageStorageKey;
      if (promotedStorageKey === candidate.storageKey) return;
      await cleanupKnowledgeBaseStagedArtifactCandidate(candidate).catch(
        () => undefined,
      );
    }),
  );
}

async function reconcileAvailableKnowledgeOutput(input: {
  userId: number;
  conversationId: string;
  taskId: string;
  output: unknown[];
  upstreamStatus: unknown;
  ledger: { lastOutputLength: number; lastOutputItemIds: string[] };
  artifactAccess?: { apiKey: string; baseUrl: string };
}) {
  const stagedCandidates: KnowledgeBaseStagedArtifactCandidate[] = [];
  const stagedArtifacts: {
    logo?: KnowledgeBaseInitialLogoDisposition;
    package?: KnowledgeBaseStagedArtifactCandidate;
  } = {};
  try {
    let progress = await getKnowledgeBaseProgress({
      userId: input.userId,
      conversationId: input.conversationId,
    });
    const unreconciled = selectUnreconciledKnowledgeOutput(
      input.output,
      input.ledger,
      {
        replayStableOutput: shouldReplayStableKnowledgeOutput(
          input.upstreamStatus,
        ),
      },
    );
    const upstreamPhase = classifyKnowledgeBaseUpstreamTaskStatus(
      input.upstreamStatus,
    );
    if (
      shouldReconcileKnowledgeOutput(unreconciled, input.upstreamStatus, {
        requirePresentation:
          progress?.build.skillVersion === "3" ||
          progress?.build.skillVersion === "4",
      })
    ) {
      if (
        input.artifactAccess &&
        !isKnowledgeBaseAcknowledgementOnlyOutput(unreconciled)
      ) {
        const artifactAccess = input.artifactAccess;
        let boundBuild;
        try {
          boundBuild = await assertKnowledgeBaseTaskBinding({
            userId: input.userId,
            conversationId: input.conversationId,
            taskId: input.taskId,
          });
        } catch (error) {
          if (
            error instanceof KnowledgeBaseBuildError &&
            error.code === "PROGRESS_PROTOCOL_INVALID"
          ) {
            // A delayed resource snapshot from an older task/generation is an
            // expected at-least-once delivery. It must never poison the current
            // authoritative build.
            return progress;
          }
          throw error;
        }
        const finalPackageMissing =
          boundBuild.status === "protocol_error" &&
          boundBuild.protocolErrorCode === "FINAL_PACKAGE_MISSING";
        const archiveDescriptorCount =
          collectKnowledgeArchiveDescriptors(unreconciled).length;
        if (finalPackageMissing && archiveDescriptorCount === 0) {
          // A provider may publish the typed file after the terminal text
          // snapshot. Keep the exact failed turn recoverable and re-read this
          // same task; never replay the final Progress transition by itself.
          return progress;
        }
        if (finalPackageMissing) {
          const resumed = await resumeKnowledgeBaseFinalPackageMissing({
            userId: input.userId,
            conversationId: input.conversationId,
            taskId: input.taskId,
            output: unreconciled,
          });
          if (!resumed) return progress;
          boundBuild = await assertKnowledgeBaseTaskBinding({
            userId: input.userId,
            conversationId: input.conversationId,
            taskId: input.taskId,
          });
        }
        const packageRebindRequired =
          boundBuild.status === "protocol_error" &&
          boundBuild.protocolErrorCode === "PACKAGE_REBIND_REQUIRED";
        if (packageRebindRequired && archiveDescriptorCount === 0) {
          // The historical task remains the sole authority. A partial provider
          // snapshot must keep the rebind notice intact instead of replaying the
          // already-applied final Progress transition or creating a new turn.
          return progress;
        }
        try {
          const bindInitialLogo =
            knowledgeBaseTurnLogoPolicy({
              providerProtocol: boundBuild.providerProtocol,
            }).acceptProviderDiscoveredLogo &&
            (boundBuild.skillVersion === "4"
              ? boundBuild.totalNodeCount === 0
              : shouldBindKnowledgeBaseInitialLogo(
                  boundBuild.skillVersion,
                  collectKnowledgeBaseLogoDescriptors(unreconciled).length,
                ));
          if (bindInitialLogo) {
            const logoBinding = await bindKnowledgeBaseInitialLogo({
              userId: input.userId,
              buildId: boundBuild.id,
              generation: boundBuild.generation,
              taskId: input.taskId,
              output: unreconciled,
              apiKey: artifactAccess.apiKey,
              baseUrl: artifactAccess.baseUrl,
            });
            if ("staged" in logoBinding && logoBinding.staged === true) {
              stagedArtifacts.logo = logoBinding;
              stagedCandidates.push(logoBinding);
            } else if (
              "rejected" in logoBinding &&
              logoBinding.rejected === true
            ) {
              if (!upstreamPhase.settled) return progress;
              stagedArtifacts.logo = logoBinding;
            }
          }
          if (
            (boundBuild.skillVersion === "4" ||
              !boundBuild.packageStorageKey ||
              packageRebindRequired) &&
            collectKnowledgeArchiveDescriptors(unreconciled).length > 0
          ) {
            const bindPackage =
              boundBuild.status === "ready_to_publish" || packageRebindRequired
                ? bindKnowledgeBaseReadyPackage
                : bindKnowledgeBaseFinalPackage;
            const packageBinding = await serializeKnowledgeBasePackageBinding(
              () =>
                bindPackage({
                  userId: input.userId,
                  buildId: boundBuild.id,
                  generation: boundBuild.generation,
                  taskId: input.taskId,
                  output: unreconciled,
                  apiKey: artifactAccess.apiKey,
                  baseUrl: artifactAccess.baseUrl,
                }),
            );
            if ("staged" in packageBinding && packageBinding.staged === true) {
              stagedArtifacts.package = packageBinding;
              stagedCandidates.push(packageBinding);
            }
          }
        } catch (error) {
          if (packageRebindRequired) {
            // Rebinding is a recovery of the same settled task, not a new model
            // turn. Any incomplete/invalid artifact observation leaves the
            // stable PACKAGE_REBIND_REQUIRED notice in place for another
            // reconcile of that same authority.
            return (
              (await getKnowledgeBaseProgress({
                userId: input.userId,
                conversationId: input.conversationId,
              })) || progress
            );
          }
          if (isIdempotentKnowledgeBaseReconcileError(error)) {
            return progress;
          }
          if (
            error instanceof KnowledgeBaseArtifactBindingError &&
            !upstreamPhase.settled
          ) {
            // A resource can appear before its bytes or companion protocol have
            // settled. Keep the authoritative turn locked and retry the same
            // complete snapshot; never advance the accepted cursor.
            return progress;
          }
          if (
            error instanceof KnowledgeBaseArtifactBindingError &&
            error.code === "BUILD_CHANGED"
          ) {
            return progress;
          }
          if (upstreamPhase.settled) {
            const serializedOutput = (() => {
              try {
                return JSON.stringify(unreconciled);
              } catch {
                return "[unserializable-upstream-output]";
              }
            })();
            const errorCode =
              error && typeof error === "object" && "code" in error
                ? String(error.code || "")
                : error instanceof Error
                  ? error.name
                  : "UNKNOWN";
            const observationKey = createHash("sha256")
              .update(
                JSON.stringify({
                  taskId: input.taskId,
                  phase: upstreamPhase.phase,
                  outputSha256: createHash("sha256")
                    .update(serializedOutput, "utf8")
                    .digest("hex"),
                  errorCode,
                }),
                "utf8",
              )
              .digest("hex");
            const failureNotice = knowledgeBaseArtifactFailureNotice(error);
            await observeKnowledgeBaseProtocolFailure({
              userId: input.userId,
              conversationId: input.conversationId,
              taskId: input.taskId,
              observationKey,
              message: failureNotice.message,
              code: upstreamPhase.failed
                ? "UPSTREAM_TASK_FAILED"
                : failureNotice.code,
              status: upstreamPhase.failed ? "failed" : "protocol_error",
              definitive: upstreamPhase.failed,
            });
            return (
              (await getKnowledgeBaseProgress({
                userId: input.userId,
                conversationId: input.conversationId,
              })) || progress
            );
          }
          throw error;
        }
      }
      progress = await reconcileKnowledgeBaseProgress({
        userId: input.userId,
        conversationId: input.conversationId,
        taskId: input.taskId,
        output: unreconciled,
        upstreamStatus: input.upstreamStatus,
        outputState: {
          totalLength: input.output.length,
          itemIds: outputItemIds(input.output),
        },
        stagedArtifacts,
      });
      if (progress && stagedArtifacts.logo) {
        if ("staged" in stagedArtifacts.logo) {
          logKnowledgeBaseOperationTelemetry({
            event: "initial_logo_accepted",
            buildId: stagedArtifacts.logo.buildId,
            turnId: stagedArtifacts.logo.turnId,
          });
        } else if (
          "rejected" in stagedArtifacts.logo &&
          progress.build.logoRequired === true
        ) {
          logKnowledgeBaseOperationTelemetry({
            event: "initial_logo_degraded_to_upload",
            buildId: stagedArtifacts.logo.buildId,
            turnId: stagedArtifacts.logo.turnId,
            reasonCode: stagedArtifacts.logo.rejectionCode,
          });
        }
      }
    }
    return progress;
  } finally {
    await cleanupUnpromotedKnowledgeBaseArtifactCandidates(
      input.userId,
      input.conversationId,
      stagedCandidates,
    );
  }
}

let knowledgeBasePackageBindingTail: Promise<void> = Promise.resolve();

async function serializeKnowledgeBasePackageBinding<T>(
  operation: () => Promise<T>,
): Promise<T> {
  const previous = knowledgeBasePackageBindingTail;
  let release!: () => void;
  knowledgeBasePackageBindingTail = new Promise<void>((resolve) => {
    release = resolve;
  });
  await previous;
  try {
    return await operation();
  } finally {
    release();
  }
}

function recoveryString(
  metadata: Record<string, unknown>,
  key: string,
  fallback = "",
) {
  const value = metadata[key];
  return typeof value === "string" ? value : fallback;
}

function recoveryStringArray(
  metadata: Record<string, unknown>,
  key: string,
): string[] {
  const value = metadata[key];
  return Array.isArray(value) && value.every((item) => typeof item === "string")
    ? value
    : [];
}

function recoveryOfficialLogoUpload(
  metadata: Record<string, unknown>,
): KnowledgeBaseOfficialLogoUpload | undefined {
  const value = metadata.officialLogoUpload;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const upload = value as Record<string, unknown>;
  const index = Number(upload.index);
  const fileId = String(upload.fileId || "");
  const filename = String(upload.filename || "");
  const mimeType = String(upload.mimeType || "");
  const sizeBytes = Number(upload.sizeBytes);
  const sourceSha256 = String(upload.sourceSha256 || "").toLowerCase();
  return upload.verified === true &&
    index === 0 &&
    fileId &&
    filename &&
    mimeType.startsWith("image/") &&
    Number.isSafeInteger(sizeBytes) &&
    sizeBytes > 0 &&
    /^[a-f0-9]{64}$/u.test(sourceSha256)
    ? {
        verified: true,
        index,
        fileId,
        filename,
        mimeType,
        sizeBytes,
        sourceSha256,
      }
    : undefined;
}

type PendingKnowledgeBaseOfficialLogoUpload = Omit<
  KnowledgeBaseOfficialLogoUpload,
  "verified"
> & { verified: false };

function recoveryPendingOfficialLogoUpload(
  metadata: Record<string, unknown>,
): PendingKnowledgeBaseOfficialLogoUpload | undefined {
  const value = metadata.officialLogoUpload;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const upload = value as Record<string, unknown>;
  const index = Number(upload.index);
  const fileId = String(upload.fileId || "");
  const filename = String(upload.filename || "");
  const mimeType = String(upload.mimeType || "");
  const sizeBytes = Number(upload.sizeBytes);
  const sourceSha256 = String(upload.sourceSha256 || "").toLowerCase();
  return upload.verified === false &&
    index === 0 &&
    fileId &&
    filename &&
    mimeType &&
    Number.isSafeInteger(sizeBytes) &&
    sizeBytes > 0 &&
    /^[a-f0-9]{64}$/u.test(sourceSha256)
    ? {
        verified: false,
        index,
        fileId,
        filename,
        mimeType,
        sizeBytes,
        sourceSha256,
      }
    : undefined;
}

async function serverOwnedKnowledgeBaseAttachmentManifest(
  attachments: Array<{ file_id: string; filename: string }>,
) {
  const manifest = [];
  for (const attachment of attachments) {
    const stored = await readStoredPresalesFile(attachment.file_id);
    if (
      !stored ||
      !stored.sha256 ||
      stored.sizeBytes < 1 ||
      stored.filename !== attachment.filename
    ) {
      throw new KnowledgeBaseTurnReservationError(
        "INVALID_REQUEST",
        `附件“${attachment.filename}”的受管上传记录尚未就绪，请重新选择文件后提交`,
      );
    }
    manifest.push({
      filename: stored.filename,
      sizeBytes: stored.sizeBytes,
      mimeType: normalizeKnowledgeBaseAttachmentMimeType(
        stored.filename,
        stored.mimeType,
      ),
      lastModified: 0,
      sha256: stored.sha256.toLowerCase(),
    });
  }
  return manifest;
}

type KnowledgeBaseAuthoritativeAttachmentManifestItem =
  KnowledgeBaseClientAttachmentManifestItem & { sha256: string };

function requireKnowledgeBaseAuthoritativeAttachmentManifest(
  value: unknown,
): KnowledgeBaseAuthoritativeAttachmentManifestItem[] {
  const manifest = normalizeKnowledgeBaseClientAttachmentManifest(value);
  if (
    manifest.some(
      (item) => !item.sha256 || !/^[a-f0-9]{64}$/u.test(item.sha256),
    )
  ) {
    throw new KnowledgeBaseTurnReservationError(
      "INVALID_REQUEST",
      "附件缺少 Dashboard 权威完整性摘要，请重新上传",
    );
  }
  return manifest as KnowledgeBaseAuthoritativeAttachmentManifestItem[];
}

export function knowledgeBaseRecoveryLogoPreparationError(error: unknown) {
  return new KnowledgeBaseLocalPreparationError(
    "KNOWLEDGE_BASE_LOGO_UPLOAD_INVALID",
    error instanceof KnowledgeBaseArtifactBindingError
      ? error.message
      : "企业官方主 Logo 无法从本轮受管上传恢复，请重新上传",
    { cause: error },
  );
}

function recoveredAssistantOutput(value: unknown): unknown[] {
  if (typeof value === "string") {
    return [
      {
        type: "output_message",
        role: "assistant",
        content: [{ type: "output_text", text: value }],
      },
    ];
  }
  if (!value || typeof value !== "object") return [];
  const record = value as Record<string, unknown>;
  if (record.role) return [record];
  const type = String(record.type || "").toLowerCase();
  const hasAssistantText =
    ["message", "output_message", "output_text", "text", ""].includes(type) &&
    (typeof record.text === "string" ||
      typeof record.output_text === "string" ||
      typeof record.value === "string" ||
      typeof record.content === "string" ||
      Array.isArray(record.content));
  return hasAssistantText
    ? [
        {
          ...record,
          role: "assistant",
          ...(typeof record.value === "string" &&
          record.text === undefined &&
          record.output_text === undefined &&
          record.content === undefined
            ? { text: record.value }
            : {}),
        },
      ]
    : [record];
}

function knowledgeBaseUpstreamRecord(value: unknown) {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/**
 * The provider has returned both direct task objects and `{ task: ... }`
 * wrappers. Treat the nested task as authoritative when present so id,
 * status, and output can never be read from different response levels.
 */
export function canonicalKnowledgeBaseUpstreamTask(
  value: unknown,
): Record<string, unknown> {
  const task = canonicalUpstreamTask(value);
  // Even callers which only inspect output must reject conflicting or
  // overlong identity claims before those values can reach durable storage.
  upstreamTaskId(task, false);
  return task;
}

function knowledgeBaseUpstreamString(value: unknown, maxLength: number) {
  if (typeof value !== "string" && typeof value !== "number") return undefined;
  const normalized = String(value).trim();
  return normalized ? normalized.slice(0, maxLength) : undefined;
}

export function normalizeRecoveredTaskOutput(taskData: unknown): unknown[] {
  const record = canonicalKnowledgeBaseUpstreamTask(taskData);
  if (Array.isArray(record.output)) {
    return record.output.flatMap((item) => recoveredAssistantOutput(item));
  }
  if (record.output !== undefined && record.output !== null) {
    return recoveredAssistantOutput(record.output);
  }
  if (record.output_text !== undefined && record.output_text !== null) {
    const outputText =
      typeof record.output_text === "object" && record.output_text !== null
        ? ((record.output_text as Record<string, unknown>).value ??
          (record.output_text as Record<string, unknown>).text)
        : record.output_text;
    return recoveredAssistantOutput(String(outputText ?? ""));
  }
  return [];
}

type RecoveryCredential = NonNullable<
  Awaited<ReturnType<typeof getDecryptedCredentialForKnowledgeBaseReservation>>
>;

const KNOWLEDGE_BASE_READINESS_WAIT_MS = 5_000;
const knowledgeBaseClaimReadinessTimings = new WeakMap<
  KnowledgeBaseRecoveryClaim,
  { startedAt: number; maxDelayMs: number }
>();

function beginKnowledgeBaseClaimReadinessTiming(
  claim: KnowledgeBaseRecoveryClaim,
) {
  const existing = knowledgeBaseClaimReadinessTimings.get(claim);
  if (existing) return existing;
  const timing = { startedAt: Date.now(), maxDelayMs: 0 };
  knowledgeBaseClaimReadinessTimings.set(claim, timing);
  return timing;
}

function knowledgeBaseClaimReadinessDelayMs(claim: KnowledgeBaseRecoveryClaim) {
  const timing = beginKnowledgeBaseClaimReadinessTiming(claim);
  timing.maxDelayMs = Math.max(
    timing.maxDelayMs,
    Math.max(0, Date.now() - timing.startedAt),
  );
  return timing.maxDelayMs;
}

export function knowledgeBaseClaimTraceId(claim: KnowledgeBaseRecoveryClaim) {
  const value = String(
    claim.turn.traceId || claim.recoveryMetadata?.traceId || "",
  ).trim();
  return /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/iu.test(
    value,
  )
    ? value
    : undefined;
}

function knowledgeBaseUserAttachmentIds(claim: KnowledgeBaseRecoveryClaim) {
  const attachments = Array.isArray(claim.recoveryMetadata.attachments)
    ? (claim.recoveryMetadata.attachments as unknown[])
    : [];
  return new Set(
    attachments.flatMap((value) => {
      const record = knowledgeBaseUpstreamRecord(value);
      const fileId = String(record?.file_id || "").trim();
      return fileId ? [fileId] : [];
    }),
  );
}

function logKnowledgeBaseClaimDispatchPhase(
  claim: KnowledgeBaseRecoveryClaim,
  phase: KnowledgeBaseDispatchPhase,
  overrides: {
    errorCode?: string;
    expectedCount?: number;
    stagedCount?: number;
    generatedReservationCount?: number;
    mappingCount?: number;
    createState?: string | null;
  } = {},
) {
  logKnowledgeBaseDispatchPhaseTelemetry({
    phase,
    traceId: knowledgeBaseClaimTraceId(claim),
    userCount: knowledgeBaseUserAttachmentIds(claim).size,
    stagedCount: claim.turn.attachmentFileIds?.length ?? 0,
    generatedReservationCount: Object.keys(
      claim.turn.generatedAttachmentReservations || {},
    ).length,
    mappingCount: Object.keys(claim.turn.manusV2AttachmentMappings || {})
      .length,
    createState: claim.turn.createAttemptState,
    ...overrides,
  });
}

function knowledgeBaseReadinessFailure(
  error: unknown,
  input: {
    attachmentKind: "generated" | "user";
    traceId?: string;
    attachmentCount: number;
  },
) {
  if (error instanceof UpstreamFileReadinessError && error.retryable) {
    return new KnowledgeBaseAttachmentsProcessingError(
      0,
      input.attachmentCount,
      5_000,
      input.traceId,
      { cause: error },
    );
  }
  if (error instanceof UpstreamFileReadinessError) {
    return new KnowledgeBaseLocalPreparationError(
      input.attachmentKind === "user"
        ? "KNOWLEDGE_BASE_USER_ATTACHMENT_INVALID"
        : "KNOWLEDGE_BASE_GENERATED_ATTACHMENT_INVALID",
      input.attachmentKind === "user"
        ? "用户附件尚未通过上游可用性校验"
        : "系统生成附件尚未通过上游可用性校验",
      { cause: error },
    );
  }
  return error;
}

function assertKnowledgeBaseReadinessComplete(
  result: UpstreamFilesReadiness,
  traceId?: string,
) {
  if (result.pending.length > 0) {
    throw new KnowledgeBaseAttachmentsProcessingError(
      result.ready.length,
      result.pending.length,
      5_000,
      traceId,
    );
  }
  return result.files.map((file) => ({
    file_id: file.fileId,
    filename: file.filename,
  }));
}

async function waitForKnowledgeBaseAttachmentGroup(input: {
  baseUrl: string;
  apiKey: string;
  attachments: Array<{ file_id: string; filename: string }>;
  attachmentKind: "generated" | "user";
  filenamePolicy?: "exact" | "provider_authoritative";
  traceId?: string;
  deadlineMs?: number;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
}) {
  if (input.attachments.length === 0) return [];
  try {
    const result = await waitForUpstreamFilesReady({
      baseUrl: input.baseUrl,
      apiKey: input.apiKey,
      files: input.attachments.map((attachment) => ({
        fileId: attachment.file_id,
        filename: attachment.filename,
      })),
      filenamePolicy: input.filenamePolicy,
      deadlineMs: input.deadlineMs ?? KNOWLEDGE_BASE_READINESS_WAIT_MS,
      sleep: input.sleep,
    });
    return assertKnowledgeBaseReadinessComplete(result, input.traceId);
  } catch (error) {
    throw knowledgeBaseReadinessFailure(error, {
      attachmentKind: input.attachmentKind,
      traceId: input.traceId,
      attachmentCount: input.attachments.length,
    });
  }
}

async function checkKnowledgeBaseAttachmentGroup(input: {
  baseUrl: string;
  apiKey: string;
  attachments: Array<{ file_id: string; filename: string }>;
  attachmentKind: "generated" | "user";
  traceId?: string;
}) {
  if (input.attachments.length === 0) return [];
  try {
    const result = await checkUpstreamFilesReadiness({
      baseUrl: input.baseUrl,
      apiKey: input.apiKey,
      files: input.attachments.map((attachment) => ({
        fileId: attachment.file_id,
        filename: attachment.filename,
      })),
      filenamePolicy: "exact",
    });
    return assertKnowledgeBaseReadinessComplete(result, input.traceId);
  } catch (error) {
    throw knowledgeBaseReadinessFailure(error, {
      attachmentKind: input.attachmentKind,
      traceId: input.traceId,
      attachmentCount: input.attachments.length,
    });
  }
}

export async function waitForKnowledgeBaseDispatchAttachments(input: {
  claim: KnowledgeBaseRecoveryClaim;
  credential: RecoveryCredential;
  baseUrl: string;
  attachments: Array<{ file_id: string; filename: string }>;
  readinessDeadlineMs?: number;
  readinessSleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
}) {
  beginKnowledgeBaseClaimReadinessTiming(input.claim);
  const userIds = knowledgeBaseUserAttachmentIds(input.claim);
  const generated = input.attachments.filter(
    (attachment) => !userIds.has(attachment.file_id),
  );
  const user = input.attachments.filter((attachment) =>
    userIds.has(attachment.file_id),
  );
  const traceId = knowledgeBaseClaimTraceId(input.claim);
  const [readyGenerated, readyUser] = await Promise.all([
    waitForKnowledgeBaseAttachmentGroup({
      baseUrl: input.baseUrl,
      apiKey: input.credential.apiKey,
      attachments: generated,
      attachmentKind: "generated",
      filenamePolicy: "exact",
      traceId,
      deadlineMs: input.readinessDeadlineMs,
      sleep: input.readinessSleep,
    }),
    waitForKnowledgeBaseAttachmentGroup({
      baseUrl: input.baseUrl,
      apiKey: input.credential.apiKey,
      attachments: user,
      attachmentKind: "user",
      filenamePolicy: "provider_authoritative",
      traceId,
      deadlineMs: input.readinessDeadlineMs,
      sleep: input.readinessSleep,
    }),
  ]);
  knowledgeBaseClaimReadinessDelayMs(input.claim);
  const canonicalById = new Map(
    [...readyGenerated, ...readyUser].map((attachment) => [
      attachment.file_id,
      attachment,
    ]),
  );
  return input.attachments.map(
    (attachment) => canonicalById.get(attachment.file_id) || attachment,
  );
}

export async function checkKnowledgeBasePreparedAttachments(input: {
  claim: KnowledgeBaseRecoveryClaim;
  credential: RecoveryCredential;
  dispatch: KnowledgeBasePreparedDispatch;
}) {
  beginKnowledgeBaseClaimReadinessTiming(input.claim);
  const userIds = knowledgeBaseUserAttachmentIds(input.claim);
  const generated = input.dispatch.requestBody.attachments.filter(
    (attachment) => !userIds.has(attachment.file_id),
  );
  const user = input.dispatch.requestBody.attachments.filter((attachment) =>
    userIds.has(attachment.file_id),
  );
  const traceId = knowledgeBaseClaimTraceId(input.claim);
  await checkKnowledgeBaseAttachmentGroup({
    baseUrl: input.dispatch.baseUrl,
    apiKey: input.credential.apiKey,
    attachments: generated,
    attachmentKind: "generated",
    traceId,
  });
  await checkKnowledgeBaseAttachmentGroup({
    baseUrl: input.dispatch.baseUrl,
    apiKey: input.credential.apiKey,
    attachments: user,
    attachmentKind: "user",
    traceId,
  });
  knowledgeBaseClaimReadinessDelayMs(input.claim);
}

async function uploadRecoverySkill(input: {
  claim: KnowledgeBaseRecoveryClaim;
  credential: RecoveryCredential;
  baseUrl: string;
  skillVersion: string;
  skillContentHash: string | null;
  skillArchive: Awaited<
    ReturnType<typeof ensureKnowledgeBaseBuildSkillArchivePin>
  >;
  stagedPrefix?: string[];
  boundUpstreamFileId?: string;
}) {
  await renewKnowledgeBaseTurnLease({
    userId: input.claim.turn.userId,
    turnId: input.claim.turn.id,
    leaseToken: input.claim.leaseToken,
  });
  // Provider file ids are short-lived capabilities, not a durable Skill pin.
  // A fresh operation must upload from the locally pinned bytes. The only
  // reusable id is a candidate already reserved by this exact turn/slot.
  const reusableUpstreamFileId = null;
  const uploaded = await uploadKnowledgeBaseSkillArchive({
    baseUrl: input.baseUrl,
    apiKey: input.credential.apiKey,
    skillVersion: input.skillVersion,
    skillContentHash: input.skillContentHash,
    archive: input.skillArchive,
    reusableUpstreamFileId,
    providerProtocol: input.claim.turn.providerProtocol,
    durable: {
      userId: input.claim.turn.userId,
      turnId: input.claim.turn.id,
      leaseToken: input.claim.leaseToken,
      attachmentIndex: input.stagedPrefix?.length ?? 0,
    },
  });
  if (
    input.boundUpstreamFileId &&
    uploaded.fileId !== input.boundUpstreamFileId &&
    input.claim.turn.providerProtocol !== "manus_v2"
  ) {
    throw new Error("Recovered Skill file id changed during byte upload");
  }
  await renewKnowledgeBaseTurnLease({
    userId: input.claim.turn.userId,
    turnId: input.claim.turn.id,
    leaseToken: input.claim.leaseToken,
  });
  await stageKnowledgeBaseTurnAttachments({
    userId: input.claim.turn.userId,
    turnId: input.claim.turn.id,
    leaseToken: input.claim.leaseToken,
    attachmentFileIds: [...(input.stagedPrefix || []), uploaded.fileId],
  });
  if (input.claim.turn.providerProtocol !== "manus_v2") {
    await recordUpstreamResource({
      userId: input.claim.turn.userId,
      apiCredentialId: input.credential.id,
      kind: "file",
      upstreamId: uploaded.fileId,
    });
  }
  return uploaded;
}

const KNOWLEDGE_BASE_GENERATED_ATTACHMENT_LEDGER_CONFLICT =
  "KNOWLEDGE_BASE_GENERATED_ATTACHMENT_LEDGER_CONFLICT";

function knowledgeBaseGeneratedAttachmentLedgerConflict(): never {
  throw new KnowledgeBaseLocalPreparationError(
    KNOWLEDGE_BASE_GENERATED_ATTACHMENT_LEDGER_CONFLICT,
    "知识库附件账本顺序与已保留的原始资料不一致，请联系支持处理",
  );
}

/**
 * Plans the only supported v5 source order: every browser-owned attachment
 * remains an immutable prefix and generated files are appended by role. This
 * pure guard runs before any generated-file or task Provider call, so a truly
 * polluted ledger becomes one stable local failure instead of an endless
 * generic recovery loop.
 */
export function planKnowledgeBaseUserFirstAttachmentLedger(input: {
  userAttachmentIds: readonly string[];
  stagedAttachmentIds: readonly string[];
  generatedRoles: readonly KnowledgeBaseGeneratedAttachmentRole[];
  generatedReservations?: Readonly<
    Record<string, KnowledgeBaseGeneratedAttachmentReservation>
  >;
}) {
  const userAttachmentIds = [...input.userAttachmentIds];
  const stagedAttachmentIds = [...input.stagedAttachmentIds];
  const generatedRoles = [...input.generatedRoles];
  const generatedReservations = input.generatedReservations || {};
  const userCount = userAttachmentIds.length;
  const expectedCount = userCount + generatedRoles.length;
  if (
    new Set(userAttachmentIds).size !== userCount ||
    new Set(stagedAttachmentIds).size !== stagedAttachmentIds.length ||
    stagedAttachmentIds.length < userCount ||
    stagedAttachmentIds.length > expectedCount ||
    userAttachmentIds.some(
      (fileId, index) => !fileId || stagedAttachmentIds[index] !== fileId,
    )
  ) {
    knowledgeBaseGeneratedAttachmentLedgerConflict();
  }

  for (const reservation of Object.values(generatedReservations)) {
    const offset = reservation.attachmentIndex - userCount;
    if (
      offset < 0 ||
      offset >= generatedRoles.length ||
      generatedRoles[offset] !== reservation.role ||
      generatedReservations[
        `${reservation.role}:${reservation.attachmentIndex}`
      ] !== reservation
    ) {
      knowledgeBaseGeneratedAttachmentLedgerConflict();
    }
  }

  const stagedGeneratedIds = stagedAttachmentIds.slice(userCount);
  for (let offset = 0; offset < stagedGeneratedIds.length; offset += 1) {
    const role = generatedRoles[offset]!;
    const attachmentIndex = userCount + offset;
    const reservation = generatedReservations[`${role}:${attachmentIndex}`];
    const expectedSourceId = reservation
      ? reservation.upstreamFileId ||
        `kb-local-${reservation.requestHash.slice(0, 48)}`
      : null;
    if (!expectedSourceId || stagedGeneratedIds[offset] !== expectedSourceId) {
      knowledgeBaseGeneratedAttachmentLedgerConflict();
    }
  }

  return {
    userAttachmentIds,
    stagedGeneratedIds,
    generatedAttachmentIndex(offset: number) {
      if (
        !Number.isSafeInteger(offset) ||
        offset < 0 ||
        offset >= generatedRoles.length
      ) {
        knowledgeBaseGeneratedAttachmentLedgerConflict();
      }
      return userCount + offset;
    },
    attachmentFileIdsForGenerated(generatedFileIds: readonly string[]) {
      if (
        generatedFileIds.length > generatedRoles.length ||
        new Set([...userAttachmentIds, ...generatedFileIds]).size !==
          userAttachmentIds.length + generatedFileIds.length
      ) {
        knowledgeBaseGeneratedAttachmentLedgerConflict();
      }
      return [...userAttachmentIds, ...generatedFileIds];
    },
  };
}

export function planKnowledgeBaseClaimUserFirstAttachmentLedger(
  claim: KnowledgeBaseRecoveryClaim,
  input: Parameters<typeof planKnowledgeBaseUserFirstAttachmentLedger>[0],
) {
  try {
    return planKnowledgeBaseUserFirstAttachmentLedger(input);
  } catch (error) {
    if (
      error instanceof KnowledgeBaseLocalPreparationError &&
      error.code === KNOWLEDGE_BASE_GENERATED_ATTACHMENT_LEDGER_CONFLICT
    ) {
      logKnowledgeBaseClaimDispatchPhase(claim, "validate_ledger", {
        errorCode: error.code,
        expectedCount:
          input.userAttachmentIds.length + input.generatedRoles.length,
        stagedCount: input.stagedAttachmentIds.length,
        generatedReservationCount: Object.keys(
          input.generatedReservations || {},
        ).length,
      });
    }
    throw error;
  }
}

/**
 * Handles the small pre-prepare crash window. Every value needed to recreate
 * the request is pinned in recovery metadata, and every already staged file id
 * is reused. Once prepared, all later retries read the stored exact body.
 */
async function ensureKnowledgeBaseRecoveryDispatch(input: {
  claim: KnowledgeBaseRecoveryClaim;
  credential: RecoveryCredential;
}) {
  const { claim, credential } = input;
  const buildId = claim.turn.buildId;
  if (!buildId) {
    throw new Error("Recovery turn is not bound to a knowledge-base build");
  }
  const pinnedBuild = await loadKnowledgeBaseBuildRecordById(
    claim.turn.userId,
    buildId,
  );
  if (!pinnedBuild || pinnedBuild.generation !== claim.turn.buildGeneration) {
    throw new Error("Recovery build identity changed");
  }
  if (
    pinnedBuild.executionMode !== MATERIALIZED_KNOWLEDGE_BASE_EXECUTION_MODE ||
    pinnedBuild.skillVersion !== "5" ||
    pinnedBuild.skillContentHash !==
      KNOWLEDGE_BASE_MATERIALIZED_V5_SKILL_CONTENT_HASH ||
    pinnedBuild.providerProtocol !== "manus_v2" ||
    pinnedBuild.contentVersion === null ||
    knowledgeBaseMaterializedRecoveryContractVersion(pinnedBuild) !== 1 ||
    knowledgeBaseMaterializedCompletionContractVersion(pinnedBuild) !==
      KNOWLEDGE_BASE_MATERIALIZED_COMPLETION_CONTRACT_VERSION
  ) {
    // The exact fresh-build gate precedes Skill lookup/upload and every
    // Provider operation. No historical provenance can become dispatch
    // authority.
    throw new KnowledgeBaseLocalPreparationError(
      "RESET_REQUIRED",
      "旧知识库构建不再续跑；请批准重置并重新上传资料",
    );
  }
  const skillArchive = await ensureKnowledgeBaseBuildSkillArchivePin({
    userId: claim.turn.userId,
    buildId,
    generation: claim.turn.buildGeneration,
  });
  const recordedSkillVersion = recoveryString(
    claim.recoveryMetadata,
    "skillVersion",
    pinnedBuild.skillVersion,
  );
  const recordedSkillContentHash =
    recoveryString(
      claim.recoveryMetadata,
      "skillContentHash",
      pinnedBuild.skillContentHash || "",
    ) || null;
  if (
    recordedSkillVersion !== pinnedBuild.skillVersion ||
    recordedSkillContentHash !== (pinnedBuild.skillContentHash || null) ||
    skillArchive.contentHash !== (pinnedBuild.skillContentHash || "")
  ) {
    throw new Error("Recovery Skill logical pin does not match the build");
  }
  claim.recoveryMetadata = {
    ...claim.recoveryMetadata,
    skillVersion: pinnedBuild.skillVersion,
    skillContentHash: pinnedBuild.skillContentHash,
    skillArchiveSha256: skillArchive.physicalSha256,
    skillArchiveBytes: skillArchive.archiveBytes,
    skillArchiveStorageKey: skillArchive.storageKey,
  };
  if (claim.preparedDispatch) {
    logKnowledgeBaseClaimDispatchPhase(claim, "prepare", {
      expectedCount: claim.preparedDispatch.requestBody.attachments.length,
      stagedCount: claim.preparedDispatch.requestBody.attachments.length,
    });
    return claim.preparedDispatch;
  }
  const recovery = claim.recoveryMetadata;
  const kind = recoveryString(recovery, "kind");
  const conversationId = recoveryString(recovery, "conversationId");
  const skillVersion = pinnedBuild.skillVersion;
  const skillContentHash = pinnedBuild.skillContentHash || null;
  const finalPackageRequired = recovery.finalPackageRequired === true;
  const providerPackageRequired =
    finalPackageRequired && claim.turn.providerProtocol !== "manus_v2";
  const userAttachments = normalizeKnowledgeBaseUserAttachments(
    Array.isArray(recovery.attachments)
      ? (recovery.attachments as KnowledgeBaseAttachment[])
      : [],
  );
  const baseUrl =
    recoveryString(recovery, "retryBaseUrl") || getUpstreamBaseUrl();
  const agentProfile = knowledgeBaseUpstreamModelForCredential(credential);
  const recordedAgentProfile = recoveryString(recovery, "retryAgentProfile");
  if (recordedAgentProfile && recordedAgentProfile !== agentProfile) {
    throw new KnowledgeBaseLocalPreparationError(
      "KNOWLEDGE_BASE_CREDENTIAL_PROFILE_CHANGED",
      "知识库任务冻结的模型配置与凭证版本不一致",
    );
  }
  const stagedIds = [...claim.turn.attachmentFileIds];
  if (kind === "turn") {
    const materializedRevision =
      pinnedBuild.executionMode === "materialized_bundle_v1" &&
      skillVersion === "5";
    const parentTaskId =
      recoveryString(recovery, "retryParentTaskId") ||
      recoveryString(recovery, "parentTaskId");
    const userMessage = recoveryString(recovery, "userMessage");
    const attachmentManifest = Array.isArray(recovery.attachmentManifest)
      ? requireKnowledgeBaseAuthoritativeAttachmentManifest(
          recovery.attachmentManifest,
        )
      : undefined;
    const recoveryLogoPolicy = knowledgeBaseTurnLogoPolicy({
      providerProtocol: claim.turn.providerProtocol,
      manualLogoSubmission: recovery.manualLogoSubmission === true,
      legacyLogoRequired: knowledgeBaseBuildRequiresOfficialLogo(pinnedBuild),
    });
    let officialLogoUpload = recoveryLogoPolicy.readPersistedLogoSubmission
      ? recoveryOfficialLogoUpload(recovery)
      : undefined;
    const pendingManualLogoUpload =
      recovery.manualLogoSubmission === true
        ? recoveryPendingOfficialLogoUpload(recovery)
        : undefined;
    if (!conversationId || (!parentTaskId && !materializedRevision)) {
      throw new Error("Turn recovery metadata is incomplete");
    }
    if (!officialLogoUpload && !pendingManualLogoUpload) {
      if (
        pinnedBuild.id === claim.turn.buildId &&
        recoveryLogoPolicy.inferOrdinaryAttachmentAsLogo
      ) {
        const manifestItem = attachmentManifest?.[0];
        const attachment = userAttachments[0];
        if (
          attachmentManifest?.length !== 1 ||
          userAttachments.length !== 1 ||
          !manifestItem ||
          !attachment ||
          !claim.turn.expectedLeafId
        ) {
          throw new KnowledgeBaseArtifactBindingError(
            "LOGO_UPLOAD_INVALID",
            "企业官方主 Logo 恢复账本不完整，请重新上传",
          );
        }
        try {
          officialLogoUpload = await bindKnowledgeBaseOfficialLogoUpload({
            userId: claim.turn.userId,
            buildId: claim.turn.buildId,
            generation: claim.turn.buildGeneration,
            turnId: claim.turn.id,
            operationKey: claim.turn.operationKey,
            expectedRevision: claim.turn.expectedRevision,
            expectedLeafId: claim.turn.expectedLeafId,
            upload: {
              index: 0,
              fileId: attachment.file_id,
              filename: manifestItem.filename,
              mimeType: manifestItem.mimeType,
              sizeBytes: manifestItem.sizeBytes,
              sourceSha256: manifestItem.sha256,
            },
          });
          logKnowledgeBaseOperationTelemetry({
            event: "logo_upload_candidate_recovered",
            buildId: claim.turn.buildId,
            turnId: claim.turn.id,
          });
        } catch (error) {
          logKnowledgeBaseOperationTelemetry({
            event: "logo_upload_candidate_rejected",
            buildId: claim.turn.buildId,
            turnId: claim.turn.id,
            reasonCode:
              error instanceof KnowledgeBaseArtifactBindingError
                ? error.code
                : "LOCAL_PREPARATION_FAILED",
          });
          // This binding runs before request preparation or upstream create.
          // Any failure is therefore known-local and must release the turn,
          // never leave it in outcome_unknown recovery.
          throw knowledgeBaseRecoveryLogoPreparationError(error);
        }
        claim.recoveryMetadata = {
          ...claim.recoveryMetadata,
          officialLogoUpload,
        };
      }
    }
    // A manual Logo turn is intentionally prepared from the server-owned copy
    // before that copy is promoted into the build. The real upstream task must
    // be acknowledged first; promotion happens from the dispatch callback.
    const officialLogoUploadForPrompt =
      officialLogoUpload ||
      (pendingManualLogoUpload
        ? { ...pendingManualLogoUpload, verified: true as const }
        : undefined);
    const deferredClientAttachments =
      recovery.deferredClientAttachments === true;
    const stagedUserIds = userAttachments.map(
      (attachment) => attachment.file_id,
    );
    const userFirstGeneratedRoles: KnowledgeBaseGeneratedAttachmentRole[] =
      materializedRevision
        ? ["skill", "working_set", "instructions"]
        : providerPackageRequired
          ? ["skill", "finalization"]
          : ["skill", "instructions"];
    const userFirstLedger = deferredClientAttachments
      ? planKnowledgeBaseClaimUserFirstAttachmentLedger(claim, {
          userAttachmentIds: stagedUserIds,
          stagedAttachmentIds: stagedIds,
          generatedRoles: userFirstGeneratedRoles,
          generatedReservations: claim.turn.generatedAttachmentReservations,
        })
      : null;
    logKnowledgeBaseClaimDispatchPhase(claim, "validate_ledger", {
      expectedCount: stagedUserIds.length + userFirstGeneratedRoles.length,
      stagedCount: stagedIds.length,
    });
    const boundSkillId = deferredClientAttachments
      ? userFirstLedger!.stagedGeneratedIds[0]
      : stagedIds[0];
    const recoveredSkill = await uploadRecoverySkill({
      claim,
      credential,
      baseUrl,
      skillVersion,
      skillContentHash,
      skillArchive,
      stagedPrefix: deferredClientAttachments
        ? userFirstLedger!.userAttachmentIds
        : [],
      ...(boundSkillId ? { boundUpstreamFileId: boundSkillId } : {}),
    });
    const skillId = recoveredSkill.fileId;
    logKnowledgeBaseClaimDispatchPhase(claim, "skill", {
      expectedCount: stagedUserIds.length + userFirstGeneratedRoles.length,
      stagedCount: (deferredClientAttachments ? stagedUserIds.length : 0) + 1,
      generatedReservationCount: Math.max(
        Object.keys(claim.turn.generatedAttachmentReservations || {}).length,
        1,
      ),
    });
    const generatedAttachments: Array<{
      file_id: string;
      filename: string;
    }> = [
      {
        file_id: skillId,
        filename: KNOWLEDGE_BASE_SKILL_ATTACHMENT_FILENAME,
      },
    ];
    let materializedBase:
      | {
          buildId: string;
          generation: number;
          contentVersion: number;
          packageSha256: string;
          filename: string;
        }
      | undefined;
    if (materializedRevision) {
      const active = await readActiveKnowledgeBaseWorkingSet({
        userId: claim.turn.userId,
        buildId: pinnedBuild.id,
        generation: pinnedBuild.generation,
      });
      const filename = "frontmind-kb-active-working-set.zip";
      const attachmentIndex = userFirstLedger?.generatedAttachmentIndex(1) ?? 1;
      const uploaded = await uploadDurableKnowledgeBaseGeneratedAttachment({
        baseUrl,
        apiKey: credential.apiKey,
        filename,
        bytes: active.bytes,
        mimeType: "application/zip",
        providerProtocol: claim.turn.providerProtocol,
        durable: {
          userId: claim.turn.userId,
          turnId: claim.turn.id,
          leaseToken: claim.leaseToken,
          attachmentIndex,
          role: "working_set",
        },
      });
      generatedAttachments.push({
        file_id: uploaded.fileId,
        filename,
      });
      await stageKnowledgeBaseTurnAttachments({
        userId: claim.turn.userId,
        turnId: claim.turn.id,
        leaseToken: claim.leaseToken,
        attachmentFileIds: deferredClientAttachments
          ? userFirstLedger!.attachmentFileIdsForGenerated([
              skillId,
              uploaded.fileId,
            ])
          : [skillId, uploaded.fileId],
      });
      materializedBase = {
        buildId: pinnedBuild.id,
        generation: pinnedBuild.generation,
        contentVersion: active.build.contentVersion,
        packageSha256: active.workingSet.packageSha256,
        filename,
      };
    }
    let finalizationInput:
      | {
          filename: string;
          sha256: string;
          assetCount: number;
        }
      | undefined;
    if (providerPackageRequired) {
      if (String(skillVersion) !== "4" || deferredClientAttachments) {
        throw new Error(
          "Finalization input is only valid for a complete v4 turn",
        );
      }
      const action = classifyKnowledgeBaseUserAction(
        userMessage,
        userAttachments.length,
      );
      if (action !== "confirm" && action !== "direct_prefill") {
        throw new Error("Finalization input requires a final confirmation");
      }
      if (
        !Number.isSafeInteger(claim.turn.expectedRevision) ||
        Number(claim.turn.expectedRevision) < 0 ||
        !Number.isSafeInteger(claim.turn.buildGeneration) ||
        Number(claim.turn.buildGeneration) < 1
      ) {
        throw new Error("Finalization input coordinates are incomplete");
      }
      let archive: Awaited<ReturnType<typeof buildFinalizationInputForTurn>>;
      try {
        archive = await buildFinalizationInputForTurn({
          userId: claim.turn.userId,
          buildId: claim.turn.buildId!,
          generation: Number(claim.turn.buildGeneration),
          operationId: claim.turn.operationKey,
          turnId: claim.turn.id,
          buildRevision: Number(claim.turn.expectedRevision) + 1,
          transitionTarget:
            action === "confirm" ? "confirmed" : "direct_prefilled",
        });
      } catch (error) {
        throw new KnowledgeBaseLocalPreparationError(
          "KNOWLEDGE_BASE_FINALIZATION_INPUT_INVALID",
          `最终交付输入无法通过本地完整性校验：${error instanceof Error ? error.message : "未知错误"}`,
          { cause: error },
        );
      }
      const uploaded = await uploadDurableKnowledgeBaseGeneratedAttachment({
        baseUrl,
        apiKey: credential.apiKey,
        filename: archive.filename,
        bytes: archive.bytes,
        providerProtocol: claim.turn.providerProtocol,
        durable: {
          userId: claim.turn.userId,
          turnId: claim.turn.id,
          leaseToken: claim.leaseToken,
          attachmentIndex: 1,
          role: "finalization",
        },
      });
      await renewKnowledgeBaseTurnLease({
        userId: claim.turn.userId,
        turnId: claim.turn.id,
        leaseToken: claim.leaseToken,
      });
      await stageKnowledgeBaseTurnAttachments({
        userId: claim.turn.userId,
        turnId: claim.turn.id,
        leaseToken: claim.leaseToken,
        attachmentFileIds: [skillId, uploaded.fileId],
      });
      if (claim.turn.providerProtocol !== "manus_v2") {
        await recordUpstreamResource({
          userId: claim.turn.userId,
          apiCredentialId: credential.id,
          kind: "file",
          upstreamId: uploaded.fileId,
        });
      }
      generatedAttachments.push({
        file_id: uploaded.fileId,
        filename: archive.filename,
      });
      finalizationInput = {
        filename: archive.filename,
        sha256: archive.sha256,
        assetCount: archive.assetCount,
      };
    }
    let prompt: string;
    if (providerPackageRequired) {
      prompt = await buildKnowledgeBaseTurnPrompt({
        userId: claim.turn.userId,
        conversationId,
        userMessage,
        attachments: userAttachments,
        attachmentManifest,
        skillVersion,
        skillContentHash,
        officialLogoUpload: officialLogoUploadForPrompt,
        finalizationInput,
        protocolOperation: {
          operationId: claim.turn.operationKey,
          turnId: claim.turn.id,
        },
        materializedBase,
      });
    } else {
      const fullInstructions = await buildKnowledgeBaseTurnPrompt({
        userId: claim.turn.userId,
        conversationId,
        userMessage,
        attachments: userAttachments,
        attachmentManifest,
        skillVersion,
        skillContentHash,
        officialLogoUpload: officialLogoUploadForPrompt,
        contentCompletionOnly:
          finalPackageRequired && claim.turn.providerProtocol === "manus_v2",
        protocolOperation: {
          operationId: claim.turn.operationKey,
          turnId: claim.turn.id,
        },
        materializedBase,
      });
      const instructionDelivery = buildKnowledgeBaseInstructionDelivery({
        instructions: fullInstructions,
        skillVersion,
        treePolicyVersion: pinnedBuild.treePolicyVersion,
        operationId: claim.turn.operationKey,
        turnId: claim.turn.id,
      });
      const instructionIndex =
        userFirstLedger?.generatedAttachmentIndex(
          generatedAttachments.length,
        ) ?? generatedAttachments.length;
      const boundInstructionFileId = stagedIds[instructionIndex];
      const uploadedInstruction =
        await uploadDurableKnowledgeBaseGeneratedAttachment({
          baseUrl,
          apiKey: credential.apiKey,
          filename: instructionDelivery.filename,
          bytes: instructionDelivery.bytes,
          mimeType: instructionDelivery.mimeType,
          providerProtocol: claim.turn.providerProtocol,
          durable: {
            userId: claim.turn.userId,
            turnId: claim.turn.id,
            leaseToken: claim.leaseToken,
            attachmentIndex: instructionIndex,
            role: "instructions",
          },
        });
      const instructionFileId = uploadedInstruction.fileId;
      if (
        boundInstructionFileId &&
        instructionFileId !== boundInstructionFileId &&
        claim.turn.providerProtocol !== "manus_v2"
      ) {
        throw new Error(
          "Recovered instructions file id changed during byte upload",
        );
      }
      await renewKnowledgeBaseTurnLease({
        userId: claim.turn.userId,
        turnId: claim.turn.id,
        leaseToken: claim.leaseToken,
      });
      await stageKnowledgeBaseTurnAttachments({
        userId: claim.turn.userId,
        turnId: claim.turn.id,
        leaseToken: claim.leaseToken,
        attachmentFileIds: deferredClientAttachments
          ? userFirstLedger!.attachmentFileIdsForGenerated([
              ...generatedAttachments.map((item) => item.file_id),
              instructionFileId,
            ])
          : [
              ...generatedAttachments.map((item) => item.file_id),
              instructionFileId,
            ],
      });
      if (claim.turn.providerProtocol !== "manus_v2") {
        await recordUpstreamResource({
          userId: claim.turn.userId,
          apiCredentialId: credential.id,
          kind: "file",
          upstreamId: instructionFileId,
        });
      }
      generatedAttachments.push({
        file_id: instructionFileId,
        filename: KNOWLEDGE_BASE_INSTRUCTIONS_FILENAME,
      });
      logKnowledgeBaseClaimDispatchPhase(claim, "instructions", {
        expectedCount: stagedUserIds.length + userFirstGeneratedRoles.length,
        stagedCount:
          (deferredClientAttachments ? stagedUserIds.length : 0) +
          generatedAttachments.length,
        generatedReservationCount: generatedAttachments.length,
      });
      prompt = instructionDelivery.prompt;
    }
    const attachments = providerPackageRequired
      ? [...generatedAttachments, ...userAttachments]
      : deferredClientAttachments
        ? [...userAttachments, ...generatedAttachments]
        : [...generatedAttachments, ...userAttachments];
    // A v2 operation freezes this ordered source ledger, then the v2
    // attachment mapper uploads exclusively from Dashboard-retained bytes.
    // Historical v1 ids may be 404 and are not a v2 correctness dependency.
    const readyAttachments =
      claim.turn.providerProtocol === "manus_v2"
        ? attachments
        : await waitForKnowledgeBaseDispatchAttachments({
            claim,
            credential,
            baseUrl,
            attachments,
          });
    await freezeKnowledgeBaseTurnAttachments({
      userId: claim.turn.userId,
      turnId: claim.turn.id,
      leaseToken: claim.leaseToken,
      attachmentFileIds: readyAttachments.map(
        (attachment) => attachment.file_id,
      ),
    });
    logKnowledgeBaseClaimDispatchPhase(claim, "freeze", {
      expectedCount: readyAttachments.length,
      stagedCount: readyAttachments.length,
      generatedReservationCount: generatedAttachments.length,
    });
    const prepared = await prepareKnowledgeBaseTurnDispatch({
      userId: claim.turn.userId,
      turnId: claim.turn.id,
      leaseToken: claim.leaseToken,
      baseUrl,
      prompt,
      agentProfile,
      attachments: readyAttachments,
      parentTaskId,
    });
    logKnowledgeBaseClaimDispatchPhase(claim, "prepare", {
      expectedCount: prepared.requestBody.attachments.length,
      stagedCount: prepared.requestBody.attachments.length,
      generatedReservationCount: generatedAttachments.length,
    });
    // Short accepted-path retries must reuse the exact prepared POST instead
    // of rebuilding attachments from the stale in-memory claim.
    claim.preparedDispatch = prepared;
    return prepared;
  }

  if (kind !== "start" || !conversationId) {
    throw new Error("Start recovery metadata is incomplete");
  }
  const companyName = recoveryString(recovery, "companyName");
  const companyWebsite = recoveryString(recovery, "companyWebsite");
  const researchWebsites = recoveryStringArray(recovery, "researchWebsites");
  const operatorNotes = recoveryString(recovery, "operatorNotes");
  const prefillSnapshotId = recoveryString(recovery, "prefillSnapshotId");
  const includePrefill = Boolean(recovery.includePrefill);
  const initialBundleExpectation =
    skillVersion === "5"
      ? knowledgeBaseInitialBundleExpectation({
          build: pinnedBuild,
          operationId: claim.turn.operationKey,
          expectedUploadsRead: claim.turn.expectedUserAttachmentCount,
        })
      : undefined;
  const deferredClientAttachments = recovery.deferredClientAttachments === true;
  const stagedUserIds = userAttachments.map((attachment) => attachment.file_id);
  const startGeneratedRoles: KnowledgeBaseGeneratedAttachmentRole[] =
    includePrefill
      ? ["skill", "prefill", "instructions"]
      : ["skill", "instructions"];
  const userFirstLedger = deferredClientAttachments
    ? planKnowledgeBaseClaimUserFirstAttachmentLedger(claim, {
        userAttachmentIds: stagedUserIds,
        stagedAttachmentIds: stagedIds,
        generatedRoles: startGeneratedRoles,
        generatedReservations: claim.turn.generatedAttachmentReservations,
      })
    : null;
  logKnowledgeBaseClaimDispatchPhase(claim, "validate_ledger", {
    expectedCount: stagedUserIds.length + startGeneratedRoles.length,
    stagedCount: stagedIds.length,
  });
  const prefillKnowledgeSnapshot = prefillSnapshotId
    ? await getKnowledgeSnapshotById({
        userId: claim.turn.userId,
        snapshotId: prefillSnapshotId,
      })
    : null;
  if (includePrefill && !prefillKnowledgeSnapshot) {
    throw new Error("Pinned knowledge-base prefill snapshot is unavailable");
  }

  const boundStartSkillId = userFirstLedger
    ? userFirstLedger.stagedGeneratedIds[0]
    : stagedIds[0];
  const recoveredSkill = await uploadRecoverySkill({
    claim,
    credential,
    baseUrl,
    skillVersion,
    skillContentHash,
    skillArchive,
    stagedPrefix: userFirstLedger?.userAttachmentIds ?? [],
    ...(boundStartSkillId ? { boundUpstreamFileId: boundStartSkillId } : {}),
  });
  const skillId = recoveredSkill.fileId;
  logKnowledgeBaseClaimDispatchPhase(claim, "skill", {
    expectedCount: stagedUserIds.length + startGeneratedRoles.length,
    stagedCount: (deferredClientAttachments ? stagedUserIds.length : 0) + 1,
    generatedReservationCount: Math.max(
      Object.keys(claim.turn.generatedAttachmentReservations || {}).length,
      1,
    ),
  });
  const generatedAttachments = [
    { file_id: skillId, filename: KNOWLEDGE_BASE_SKILL_ATTACHMENT_FILENAME },
  ];
  if (includePrefill) {
    await renewKnowledgeBaseTurnLease({
      userId: claim.turn.userId,
      turnId: claim.turn.id,
      leaseToken: claim.leaseToken,
    });
    const archive = await buildKnowledgeBasePrefillEvidenceArchive(
      prefillKnowledgeSnapshot!,
    );
    const uploaded = await uploadDurableKnowledgeBaseGeneratedAttachment({
      baseUrl,
      apiKey: credential.apiKey,
      filename: KNOWLEDGE_BASE_PREFILL_ATTACHMENT_FILENAME,
      bytes: archive.bytes,
      providerProtocol: claim.turn.providerProtocol,
      durable: {
        userId: claim.turn.userId,
        turnId: claim.turn.id,
        leaseToken: claim.leaseToken,
        attachmentIndex: userFirstLedger?.generatedAttachmentIndex(1) ?? 1,
        role: "prefill",
      },
    });
    const prefillFileId = uploaded.fileId;
    const boundPrefillFileId = userFirstLedger
      ? userFirstLedger.stagedGeneratedIds[1]
      : stagedIds[1];
    if (
      boundPrefillFileId &&
      prefillFileId !== boundPrefillFileId &&
      claim.turn.providerProtocol !== "manus_v2"
    ) {
      throw new Error("Recovered prefill file id changed during byte upload");
    }
    await renewKnowledgeBaseTurnLease({
      userId: claim.turn.userId,
      turnId: claim.turn.id,
      leaseToken: claim.leaseToken,
    });
    await stageKnowledgeBaseTurnAttachments({
      userId: claim.turn.userId,
      turnId: claim.turn.id,
      leaseToken: claim.leaseToken,
      attachmentFileIds: userFirstLedger
        ? userFirstLedger.attachmentFileIdsForGenerated([
            skillId,
            prefillFileId,
          ])
        : [skillId, prefillFileId],
    });
    if (claim.turn.providerProtocol !== "manus_v2") {
      await recordUpstreamResource({
        userId: claim.turn.userId,
        apiCredentialId: credential.id,
        kind: "file",
        upstreamId: prefillFileId,
      });
    }
    generatedAttachments.push({
      file_id: prefillFileId,
      filename: KNOWLEDGE_BASE_PREFILL_ATTACHMENT_FILENAME,
    });
    logKnowledgeBaseClaimDispatchPhase(claim, "prefill", {
      expectedCount: stagedUserIds.length + startGeneratedRoles.length,
      stagedCount: (deferredClientAttachments ? stagedUserIds.length : 0) + 2,
      generatedReservationCount: Math.max(
        Object.keys(claim.turn.generatedAttachmentReservations || {}).length,
        2,
      ),
    });
  }
  const fullInstructions = await buildKnowledgeBasePrompt({
    conversationId,
    companyName,
    companyWebsite,
    researchWebsites,
    operatorNotes,
    attachments: userAttachments,
    prefillKnowledgeSnapshot,
    treePolicyVersion: pinnedBuild.treePolicyVersion,
    protocolOperation: {
      skillVersion,
      operationId: claim.turn.operationKey,
      turnId: claim.turn.id,
    },
    initialBundleExpectation,
  });
  const instructionDelivery = buildKnowledgeBaseInstructionDelivery({
    instructions: fullInstructions,
    skillVersion,
    treePolicyVersion: pinnedBuild.treePolicyVersion,
    operationId: claim.turn.operationKey,
    turnId: claim.turn.id,
  });
  const instructionOffset = includePrefill ? 2 : 1;
  const instructionIndex =
    userFirstLedger?.generatedAttachmentIndex(instructionOffset) ??
    instructionOffset;
  const uploadedInstruction =
    await uploadDurableKnowledgeBaseGeneratedAttachment({
      baseUrl,
      apiKey: credential.apiKey,
      filename: instructionDelivery.filename,
      bytes: instructionDelivery.bytes,
      mimeType: instructionDelivery.mimeType,
      providerProtocol: claim.turn.providerProtocol,
      durable: {
        userId: claim.turn.userId,
        turnId: claim.turn.id,
        leaseToken: claim.leaseToken,
        attachmentIndex: instructionIndex,
        role: "instructions",
      },
    });
  const instructionFileId = uploadedInstruction.fileId;
  if (
    stagedIds[instructionIndex] &&
    instructionFileId !== stagedIds[instructionIndex] &&
    claim.turn.providerProtocol !== "manus_v2"
  ) {
    throw new Error(
      "Recovered instructions file id changed during byte upload",
    );
  }
  await renewKnowledgeBaseTurnLease({
    userId: claim.turn.userId,
    turnId: claim.turn.id,
    leaseToken: claim.leaseToken,
  });
  await stageKnowledgeBaseTurnAttachments({
    userId: claim.turn.userId,
    turnId: claim.turn.id,
    leaseToken: claim.leaseToken,
    attachmentFileIds: userFirstLedger
      ? userFirstLedger.attachmentFileIdsForGenerated([
          ...generatedAttachments.map((attachment) => attachment.file_id),
          instructionFileId,
        ])
      : [
          ...generatedAttachments.map((attachment) => attachment.file_id),
          instructionFileId,
        ],
  });
  if (claim.turn.providerProtocol !== "manus_v2") {
    await recordUpstreamResource({
      userId: claim.turn.userId,
      apiCredentialId: credential.id,
      kind: "file",
      upstreamId: instructionFileId,
    });
  }
  generatedAttachments.push({
    file_id: instructionFileId,
    filename: KNOWLEDGE_BASE_INSTRUCTIONS_FILENAME,
  });
  logKnowledgeBaseClaimDispatchPhase(claim, "instructions", {
    expectedCount: stagedUserIds.length + startGeneratedRoles.length,
    stagedCount:
      (deferredClientAttachments ? stagedUserIds.length : 0) +
      generatedAttachments.length,
    generatedReservationCount: generatedAttachments.length,
  });
  const attachments = userFirstLedger
    ? [...userAttachments, ...generatedAttachments]
    : [...generatedAttachments, ...userAttachments];
  const readyAttachments =
    claim.turn.providerProtocol === "manus_v2"
      ? attachments
      : await waitForKnowledgeBaseDispatchAttachments({
          claim,
          credential,
          baseUrl,
          attachments,
        });
  await freezeKnowledgeBaseTurnAttachments({
    userId: claim.turn.userId,
    turnId: claim.turn.id,
    leaseToken: claim.leaseToken,
    attachmentFileIds: readyAttachments.map((attachment) => attachment.file_id),
  });
  logKnowledgeBaseClaimDispatchPhase(claim, "freeze", {
    expectedCount: readyAttachments.length,
    stagedCount: readyAttachments.length,
    generatedReservationCount: generatedAttachments.length,
  });
  const prepared = await prepareKnowledgeBaseTurnDispatch({
    userId: claim.turn.userId,
    turnId: claim.turn.id,
    leaseToken: claim.leaseToken,
    baseUrl,
    prompt: instructionDelivery.prompt,
    agentProfile,
    attachments: readyAttachments,
  });
  logKnowledgeBaseClaimDispatchPhase(claim, "prepare", {
    expectedCount: prepared.requestBody.attachments.length,
    stagedCount: prepared.requestBody.attachments.length,
    generatedReservationCount: generatedAttachments.length,
  });
  claim.preparedDispatch = prepared;
  return prepared;
}

async function promoteManualKnowledgeBaseLogoAfterTaskAcknowledged(
  claim: KnowledgeBaseRecoveryClaim,
  options: { activation?: "immediate" | "materialized_patch" } = {},
) {
  if (claim.recoveryMetadata.manualLogoSubmission !== true) return;
  if (recoveryOfficialLogoUpload(claim.recoveryMetadata)) return;
  const pending = recoveryPendingOfficialLogoUpload(claim.recoveryMetadata);
  if (!pending || !claim.turn.expectedLeafId) {
    throw new KnowledgeBaseArtifactBindingError(
      "LOGO_UPLOAD_INVALID",
      "企业官方主 Logo 的受管上传记录不完整，请重新上传",
    );
  }
  const verified = await bindKnowledgeBaseOfficialLogoUpload({
    userId: claim.turn.userId,
    buildId: claim.turn.buildId,
    generation: claim.turn.buildGeneration,
    turnId: claim.turn.id,
    operationKey: claim.turn.operationKey,
    expectedRevision: claim.turn.expectedRevision,
    expectedLeafId: claim.turn.expectedLeafId,
    upload: pending,
    allowFirstLeafReplacement: true,
    activation: options.activation,
  });
  claim.recoveryMetadata = {
    ...claim.recoveryMetadata,
    officialLogoUpload: verified,
  };
  logKnowledgeBaseOperationTelemetry({
    event:
      options.activation === "materialized_patch"
        ? "logo_upload_candidate_staged"
        : "logo_upload_candidate_promoted",
    buildId: claim.turn.buildId,
    turnId: claim.turn.id,
    reasonCode: "upstream_task_acknowledged",
  });
}

type ManusV2AssistantProtocolFallback = {
  event: Parameters<typeof normalizeManusV2Output>[0][number];
  text: string;
};

/**
 * Structured extraction can fail after Manus has already emitted the exact
 * closed Dashboard protocol response in an assistant message. Accept that
 * message only for a non-initial stopped operation and only when one unique
 * assistant event proves every frozen coordinate. The ordinary progress
 * transaction remains the final CAS and content validator.
 */
export function manusV2KnowledgeBaseAssistantProtocolFallback(input: {
  events: Parameters<typeof normalizeManusV2Output>[0];
  contract: ManusV2KnowledgeBaseOperationContract;
  taskStatus: string;
}): ManusV2AssistantProtocolFallback | null {
  if (
    input.taskStatus !== "stopped" ||
    input.contract.requiresManifest ||
    input.contract.expectContentCompleted
  ) {
    return null;
  }
  const expectedTransition =
    input.contract.action === "confirm"
      ? "confirmed"
      : input.contract.action === "direct_prefill"
        ? "direct_prefilled"
        : input.contract.action === "revise"
          ? "needs_verification"
          : null;
  if (!expectedTransition || !input.contract.fromLeafId) return null;

  const candidates = input.events.flatMap((event) => {
    if (event.type !== "assistant_message") return [];
    const message =
      event.assistant_message &&
      typeof event.assistant_message === "object" &&
      !Array.isArray(event.assistant_message)
        ? (event.assistant_message as Record<string, unknown>)
        : null;
    const text =
      typeof message?.content === "string" ? message.content.trim() : "";
    if (!text || text.length > 4_000_000) return [];
    try {
      const progressMarkers = text.match(
        /<!--\s*FRONTMIND_KB_PROGRESS\b[\s\S]*?-->/giu,
      );
      const presentationMarkers = text.match(
        /<!--\s*FRONTMIND_KB_PRESENTATION\b[\s\S]*?-->/giu,
      );
      const protocolMarkers = text.match(
        /<!--\s*FRONTMIND_KB_[A-Z_]+\b[\s\S]*?-->/giu,
      );
      if (
        progressMarkers?.length !== 1 ||
        presentationMarkers?.length !== 1 ||
        protocolMarkers?.length !== 2
      ) {
        return [];
      }
      const progress = parseKnowledgeBaseProgressEnvelope(text);
      const presentation = parseKnowledgeBasePresentationEnvelope(text);
      if (
        progress.schemaVersion !== KNOWLEDGE_BASE_PROTOCOL_V4_SCHEMA_VERSION ||
        presentation.schemaVersion !==
          KNOWLEDGE_BASE_PROTOCOL_V4_SCHEMA_VERSION ||
        progress.operationId !== input.contract.operationToken ||
        presentation.operationId !== input.contract.operationToken ||
        progress.turnId !== input.contract.turnId ||
        presentation.turnId !== input.contract.turnId ||
        progress.revision !== input.contract.baseRevision ||
        presentation.revision !== input.contract.baseRevision + 1 ||
        progress.transition.leafId !== input.contract.fromLeafId ||
        progress.transition.to !== expectedTransition ||
        !presentation.leafId ||
        presentation.leafId === input.contract.fromLeafId ||
        presentation.imageState !== "no_eligible_asset" ||
        presentation.imageCount !== 0 ||
        presentation.assetIds?.length !== 0
      ) {
        return [];
      }
      const visibleMarkdown = text
        .replace(
          /<!--\s*FRONTMIND_KB_(?:MANIFEST|PROGRESS|REOPEN|PRESENTATION)\b[\s\S]*?-->/giu,
          "",
        )
        .trim();
      if (!visibleMarkdown) return [];
      return [{ event, text }];
    } catch {
      return [];
    }
  });
  return candidates.length === 1 ? candidates[0]! : null;
}

export async function normalizeManusV2KnowledgeBaseOperationOutput(input: {
  events: Parameters<typeof normalizeManusV2Output>[0];
  contract: ManusV2KnowledgeBaseOperationContract;
  taskStatus?: string;
  allowAssistantProtocolFallback?: boolean;
  build: NonNullable<
    Awaited<ReturnType<typeof loadKnowledgeBaseBuildRecordById>>
  >;
  expectedUploadsRead: number;
}) {
  const structuredResult = manusV2KnowledgeBaseStructuredResultForOperation(
    input.events,
    input.contract,
  );
  const fallback = structuredResult
    ? null
    : input.allowAssistantProtocolFallback === false
      ? null
      : manusV2KnowledgeBaseAssistantProtocolFallback({
          events: input.events,
          contract: input.contract,
          taskStatus: input.taskStatus || "running",
        });
  if (!structuredResult && !fallback) return [];
  if (fallback) {
    return [
      {
        id: fallback.event.id,
        role: "assistant" as const,
        text: fallback.text,
        content: fallback.text,
        timestamp: fallback.event.timestamp,
        files: [],
      },
    ];
  }
  const result = structuredResult!;
  if (
    !input.contract.requiresManifest &&
    !input.contract.expectContentCompleted
  ) {
    const visibleMarkdown = result.value.visibleMarkdown.trim();
    if (!visibleMarkdown) {
      throw new ManusV2ApiError(
        "structured_output",
        502,
        "EMPTY_CORE_CONTENT",
        false,
        false,
      );
    }
  }
  const coreOutput = normalizeManusV2Output(input.events, input.contract);
  const value = result.value;
  let machinePayload: string;
  if (input.contract.requiresManifest) {
    let manifestValue: unknown;
    try {
      manifestValue = parseExactJson(value.manifestJson!);
    } catch {
      throw new ManusV2ApiError(
        "structured_output",
        502,
        "INVALID_MANIFEST_JSON",
        false,
        false,
      );
    }
    const raw =
      manifestValue &&
      typeof manifestValue === "object" &&
      !Array.isArray(manifestValue)
        ? (manifestValue as Record<string, unknown>)
        : {};
    const manifest = validateKnowledgeBaseManifestForTreePolicy(
      parseKnowledgeBaseManifestEnvelope({
        kind: KNOWLEDGE_BASE_MANIFEST_KIND,
        schemaVersion: KNOWLEDGE_BASE_PROTOCOL_V4_SCHEMA_VERSION,
        operationId: input.contract.operationToken,
        turnId: input.contract.turnId,
        leaves: raw.leaves,
        ...(raw.officialLogo === undefined
          ? {}
          : { officialLogo: raw.officialLogo }),
        ...(raw.researchCoverage === undefined
          ? {}
          : { researchCoverage: raw.researchCoverage }),
      }),
      input.build.treePolicyVersion,
      { expectedUploadsRead: input.expectedUploadsRead },
    );
    if (value.nextLeafId !== manifest.leaves[0]?.id) {
      throw new ManusV2ApiError(
        "structured_output",
        409,
        "NEXT_LEAF_CONFLICT",
        false,
        false,
      );
    }
    machinePayload = [
      formatKnowledgeBaseManifestEnvelope(manifest),
      formatKnowledgeBasePresentationEnvelope({
        kind: KNOWLEDGE_BASE_PRESENTATION_KIND,
        schemaVersion: KNOWLEDGE_BASE_PROTOCOL_V4_SCHEMA_VERSION,
        operationId: input.contract.operationToken,
        turnId: input.contract.turnId,
        revision: 0,
        leafId: value.nextLeafId,
        imageState: "no_eligible_asset",
        assetIds: [],
        imageCount: 0,
      }),
    ].join("\n\n");
  } else {
    const db = await getDb();
    if (!db) throw new Error("Database is unavailable for Manus v2 reconcile");
    const nodes = await db
      .select({
        leafId: knowledgeBaseBuildNodes.leafId,
        ordinal: knowledgeBaseBuildNodes.ordinal,
        status: knowledgeBaseBuildNodes.status,
      })
      .from(knowledgeBaseBuildNodes)
      .where(eq(knowledgeBaseBuildNodes.buildId, input.build.id))
      .orderBy(asc(knowledgeBaseBuildNodes.ordinal));
    const currentIndex = nodes.findIndex(
      (node) => node.leafId === input.contract.fromLeafId,
    );
    const currentNode = currentIndex >= 0 ? nodes[currentIndex] : null;
    if (!currentNode) {
      throw new ManusV2ApiError(
        "structured_output",
        409,
        "FROM_LEAF_CONFLICT",
        false,
        false,
      );
    }
    const transitionTarget =
      input.contract.action === "confirm"
        ? "confirmed"
        : input.contract.action === "direct_prefill"
          ? "direct_prefilled"
          : "needs_verification";
    const serverNextLeafId =
      transitionTarget === "needs_verification"
        ? currentNode.leafId
        : nodes
            .slice(currentIndex + 1)
            .find((node) => node.status === "pending")?.leafId || null;
    if (value.nextLeafId !== serverNextLeafId) {
      throw new ManusV2ApiError(
        "structured_output",
        409,
        "NEXT_LEAF_CONFLICT",
        false,
        false,
      );
    }
    if (input.contract.expectContentCompleted !== (serverNextLeafId === null)) {
      throw new ManusV2ApiError(
        "structured_output",
        409,
        "COMPLETION_COORDINATE_CONFLICT",
        false,
        false,
      );
    }
    machinePayload = [
      formatKnowledgeBaseProgressEnvelope({
        kind: KNOWLEDGE_BASE_PROGRESS_KIND,
        schemaVersion: KNOWLEDGE_BASE_PROTOCOL_V4_SCHEMA_VERSION,
        operationId: input.contract.operationToken,
        turnId: input.contract.turnId,
        revision: input.contract.baseRevision,
        transition: {
          leafId: input.contract.fromLeafId!,
          from:
            currentNode.status === "needs_verification"
              ? "needs_verification"
              : "current",
          to: transitionTarget,
          reason: "Dashboard accepted core Manus v2 result",
        },
      }),
      formatKnowledgeBasePresentationEnvelope({
        kind: KNOWLEDGE_BASE_PRESENTATION_KIND,
        schemaVersion: KNOWLEDGE_BASE_PROTOCOL_V4_SCHEMA_VERSION,
        operationId: input.contract.operationToken,
        turnId: input.contract.turnId,
        revision: input.contract.baseRevision + 1,
        leafId: serverNextLeafId,
        imageState:
          serverNextLeafId === null ? "not_applicable" : "no_eligible_asset",
        assetIds: [],
        imageCount: 0,
      }),
    ].join("\n\n");
  }
  return coreOutput.map((entry) => {
    const record = entry as Record<string, unknown>;
    const text = [value.visibleMarkdown, machinePayload]
      .filter(Boolean)
      .join("\n\n");
    return { ...record, text, content: text };
  });
}

async function dispatchMaterializedKnowledgeBaseClaim(input: {
  claim: KnowledgeBaseRecoveryClaim;
  credential: RecoveryCredential;
  build: NonNullable<KnowledgeBaseBuildRecord>;
  ensureDispatch: typeof ensureKnowledgeBaseRecoveryDispatch;
  ensureManusV2Attachments: typeof ensureKnowledgeBaseManusV2Attachments;
  beginDispatch: typeof beginKnowledgeBaseManusV2Dispatch;
  bindSubmission: typeof bindKnowledgeBaseManusV2Submission;
  downloadArchive: typeof downloadArchiveBytes;
  readCandidate: typeof readKnowledgeBaseLocalSource;
  validateInitialCandidate: typeof validateKnowledgeBaseWorkingSetArchive;
  validateRevisionCandidate: typeof validateKnowledgeBaseRevisionAgainstActiveWorkingSet;
  observeResultDiagnostic: typeof observeKnowledgeBaseMaterializedResultDiagnostic;
  persistResultDiagnostics: boolean;
  deferProviderStatus: typeof deferKnowledgeBaseMaterializedProviderStatus;
  activateInitial: typeof activateInitialKnowledgeBaseWorkingSet;
  applyRevision: typeof applyKnowledgeBaseRevisionWorkingSet;
  createClient: (input: {
    baseUrl: string;
    apiKey: string;
  }) => Pick<ManusV2Client, "createTask" | "listAllMessages" | "stopTask">;
}) {
  const { claim, credential, build } = input;
  if (
    claim.turn.materializedRecoveryContractVersion !== 1 ||
    knowledgeBaseMaterializedRecoveryContractVersion(build) !== 1 ||
    claim.turn.materializedCompletionContractVersion !==
      KNOWLEDGE_BASE_MATERIALIZED_COMPLETION_CONTRACT_VERSION ||
    knowledgeBaseMaterializedCompletionContractVersion(build) !==
      KNOWLEDGE_BASE_MATERIALIZED_COMPLETION_CONTRACT_VERSION
  ) {
    throw new KnowledgeBaseLocalPreparationError(
      "RESET_REQUIRED",
      "旧知识库构建不再续跑；请批准重置并重新上传资料",
    );
  }
  if (
    build.executionMode !== "materialized_bundle_v1" ||
    build.skillVersion !== "5" ||
    build.providerProtocol !== "manus_v2"
  ) {
    throw new KnowledgeBaseTurnReservationError(
      "CONFLICT",
      "The build is not a materialized v5 operation",
    );
  }
  if (
    build.skillContentHash !== KNOWLEDGE_BASE_MATERIALIZED_V5_SKILL_CONTENT_HASH
  ) {
    throw new KnowledgeBaseLocalPreparationError(
      "RESET_REQUIRED",
      "旧知识库构建不再续跑；请批准重置并重新上传资料",
    );
  }
  const prepared = await input.ensureDispatch({ claim, credential });
  const title = `FrontMind KB ${build.id} g${build.generation} ${claim.turn.id}`;
  const client = input.createClient({
    baseUrl: prepared.baseUrl,
    apiKey: credential.apiKey,
  });
  let taskId = claim.turn.upstreamTaskId || null;
  if (!taskId && claim.turn.createAttemptState === "not_sent") {
    // Provider attachment identities are dispatch-time proof only. Once a
    // task id is bound, recovery must poll that exact task and must not run
    // the pre-create finalizer again: the finalizer deliberately accepts only
    // `not_sent`, and provider files may also change lifecycle after task
    // create consumes them.
    const attachments = await input.ensureManusV2Attachments({
      claim,
      credential,
      baseUrl: prepared.baseUrl,
    });
    if (attachments.length !== prepared.requestBody.attachments.length) {
      throw new KnowledgeBaseTurnReservationError(
        "CONFLICT",
        "The materialized task attachment ledger is incomplete",
      );
    }
    logKnowledgeBaseClaimDispatchPhase(claim, "map", {
      expectedCount: prepared.requestBody.attachments.length,
      stagedCount: prepared.requestBody.attachments.length,
      mappingCount: attachments.length,
    });
    const frozenBody = buildManusV2CreateTaskBody({
      prompt: prepared.requestBody.prompt,
      attachments,
      title,
      agentProfile: prepared.requestBody.agentProfile,
      locale: "zh-CN",
    });
    const bodyHash = createHash("sha256")
      .update(JSON.stringify(frozenBody))
      .digest("hex");
    const authority = await input.beginDispatch({
      userId: claim.turn.userId,
      turnId: claim.turn.id,
      leaseToken: claim.leaseToken,
      frozenProviderRequestHash: bodyHash,
      expectedMethod: "task.create",
      leaseMs: 300_000,
    });
    if (
      authority.method !== "task.create" ||
      authority.canonicalTaskId ||
      authority.title !== title
    ) {
      throw new KnowledgeBaseTurnReservationError(
        "CONFLICT",
        "Materialized knowledge-base tasks must always create a fresh task",
      );
    }
    claim.turn.providerMethod = "task.create";
    claim.turn.providerAttemptState = "sending";
    logKnowledgeBaseClaimDispatchPhase(claim, "task_create", {
      expectedCount: attachments.length,
      stagedCount: attachments.length,
      mappingCount: attachments.length,
      createState: "sending",
    });
    try {
      const created = await client.createTask({
        prompt: prepared.requestBody.prompt,
        attachments,
        title,
        agentProfile: prepared.requestBody.agentProfile,
        locale: "zh-CN",
      });
      taskId = created.taskId;
      // Provider 2xx has consumed the one allowed create even before the
      // local bind commits. A bind crash is terminal for this build: recovery
      // must never guess or adopt a task by title. The user can approve a
      // reset, which creates a fresh turn and a fresh Provider task.
      claim.turn.createAttemptState = "unknown";
      claim.turn.providerAttemptState = "output_pending";
      await input.bindSubmission({
        userId: claim.turn.userId,
        turnId: claim.turn.id,
        leaseToken: claim.leaseToken,
        method: "task.create",
        taskId,
        taskUrl: created.taskUrl,
        manusRequestId: created.requestId,
      });
      claim.turn.upstreamTaskId = taskId;
      claim.turn.createAttemptState = "acknowledged";
      claim.turn.providerAttemptState = "output_pending";
      logKnowledgeBaseClaimDispatchPhase(claim, "task_create", {
        expectedCount: attachments.length,
        stagedCount: attachments.length,
        mappingCount: attachments.length,
        createState: "acknowledged",
      });
    } catch (error) {
      logKnowledgeBaseClaimDispatchPhase(claim, "task_create", {
        errorCode:
          error instanceof ManusV2ApiError && error.outcomeUnknown
            ? "MANUS_V2_CREATE_OUTCOME_UNKNOWN"
            : error instanceof ManusV2ApiError
              ? "MANUS_V2_CREATE_REJECTED"
              : "MANUS_V2_CREATE_LOCAL_BIND_FAILED",
        expectedCount: attachments.length,
        stagedCount: attachments.length,
        mappingCount: attachments.length,
        createState: claim.turn.createAttemptState,
      });
      // The outer dispatch-failure settlement owns the single durable create
      // outcome-unknown write. Keeping it out of this nested catch prevents
      // one Provider 5xx/timeout from entering the create-only mutation twice
      // through a stale in-memory claim.
      throw error;
    }
  } else if (!taskId) {
    throw new KnowledgeBaseLocalPreparationError(
      "RESET_REQUIRED",
      "上游任务创建结果不确定；请批准重置并重新上传资料",
    );
  }
  if (!taskId) {
    throw new KnowledgeBaseTurnReservationError(
      "CONFLICT",
      "Materialized task acknowledgement is missing",
    );
  }
  // This is deliberately outside the create branch. A process may stop after
  // binding task.create but before staging the Logo; recovery of that same
  // task must repair the local staging ledger without creating another task.
  await promoteManualKnowledgeBaseLogoAfterTaskAcknowledged(claim, {
    activation: "materialized_patch",
  });
  const priorCompletion = claim.turn.materializedCompletion;
  let events: Awaited<ReturnType<typeof client.listAllMessages>> = [];
  // A persisted stop attempt freezes a fully validated local CAS. Recovery of
  // that immutable candidate must not depend on the stopped Provider task
  // still being readable (it may already have been garbage-collected).
  if (!priorCompletion?.stopAttemptState) {
    try {
      events = await client.listAllMessages({ taskId, order: "desc" });
    } catch (error) {
      if (
        error instanceof ManusV2ApiError &&
        error.operation === "task.listMessages" &&
        error.status === 404 &&
        !error.outcomeUnknown
      ) {
        const deferred = await input.deferProviderStatus({
          userId: claim.turn.userId,
          turnId: claim.turn.id,
          leaseToken: claim.leaseToken,
          status: "list_messages_404",
        });
        return {
          taskId,
          rebound: true,
          reconciled: deferred.state === "unavailable",
        };
      }
      throw error;
    }
  }
  let status = latestManusV2TaskState(events) || "unknown";
  let output = normalizeManusV2Output(events);
  let descriptors = collectKnowledgeArchiveDescriptors(output);
  if (
    !priorCompletion?.stopAttemptState &&
    (status === "stopped" ||
      status === "error" ||
      status === "failed" ||
      status === "cancelled") &&
    !descriptors.some((descriptor) => descriptor.url || descriptor.fileId)
  ) {
    // Terminal text/status and the direct assistant file may become visible
    // in separate Provider reads. Confirm the same exact task once more before
    // settling reset; this is read-only and never searches, adopts, sends or
    // creates another task.
    events = await client.listAllMessages({ taskId, order: "desc" });
    status = latestManusV2TaskState(events) || status;
    output = normalizeManusV2Output(events);
    descriptors = collectKnowledgeArchiveDescriptors(output);
  }
  const expectedFilename =
    build.contentVersion === 0
      ? `frontmind-kb-bundle-${claim.turn.operationKey}.zip`
      : `frontmind-kb-patch-${claim.turn.operationKey}.zip`;
  const downloadableDescriptors = descriptors.filter(
    (descriptor) => descriptor.url || descriptor.fileId,
  );
  // `normalizeManusV2Output` and the collector preserve chronological order.
  // Prefer the operation-bound name, but never let a Provider rename hide a
  // safe direct-assistant ZIP. Each group is newest-first, so a bad latest
  // candidate falls through to every older candidate without changing task
  // identity.
  const candidateDescriptors = [
    ...downloadableDescriptors
      .filter((descriptor) => descriptor.filename === expectedFilename)
      .reverse(),
    ...downloadableDescriptors
      .filter((descriptor) => descriptor.filename !== expectedFilename)
      .reverse(),
  ];
  const downloadCandidate = async (
    descriptor: (typeof candidateDescriptors)[number],
  ) => {
    const sources = [descriptor];
    if (descriptor.url && descriptor.fileId) {
      const { url: _url, ...providerFileSource } = descriptor;
      sources.push(providerFileSource);
    }
    let lastError: unknown = null;
    for (const source of sources) {
      for (let attempt = 0; attempt < 3; attempt += 1) {
        try {
          return await input.downloadArchive({
            descriptor: source,
            apiKey: credential.apiKey,
            baseUrl: prepared.baseUrl,
            // The exact current Skill hash is checked before any Provider
            // client or result access. External descriptor URLs never receive
            // these credentials; the authenticated endpoint is a separate
            // file-id fallback inside downloadArchiveBytes.
            allowProviderFileIdFallback: true,
          });
        } catch (error) {
          lastError = error;
          if (
            !(error instanceof KnowledgeArchiveDownloadError) ||
            !error.retryable ||
            attempt === 2
          ) {
            break;
          }
        }
      }
    }
    throw lastError;
  };
  const canonicalCandidateBytes = async (
    archiveBytes: Buffer,
    descriptorFilename = expectedFilename,
  ) => {
    if (build.contentVersion === 0) {
      const authority = knowledgeBaseInitialBundleExpectation({
        build,
        operationId: claim.turn.operationKey,
        expectedUploadsRead: claim.turn.expectedUserAttachmentCount,
      });
      if (
        input.validateInitialCandidate !==
        validateKnowledgeBaseWorkingSetArchive
      ) {
        const validated = await input.validateInitialCandidate(
          archiveBytes,
          authority,
        );
        return { bytes: validated.archiveBytes };
      }
      const normalized = await normalizeMaterializedKnowledgeBaseResult({
        mode: "initial",
        archiveBytes,
        authority,
        provenance: {
          exactBoundTask: true,
          directAssistantOutput: true,
          descriptorFilename,
        },
      });
      if (normalized.kind === "rejected") {
        throw new KnowledgeBaseMaterializedContractError(
          `${normalized.code}:${normalized.stage}`,
          normalized.stage === "manifest_parse" ? "manifest_parse" : "contract",
        );
      }
      return {
        bytes: normalized.canonicalArchiveBytes,
        normalization: normalized,
      };
    }
    if (!claim.turn.expectedLeafId) {
      throw new KnowledgeBaseMaterializedResultError(
        "KNOWLEDGE_BASE_MATERIALIZED_RESULT_INVALID",
        "Revision 缺少目标节点",
      );
    }
    const validated = await input.validateRevisionCandidate({
      userId: claim.turn.userId,
      buildId: build.id,
      generation: build.generation,
      turnId: claim.turn.id,
      providerTaskId: taskId,
      targetLeafId: claim.turn.expectedLeafId,
      operationId: claim.turn.operationKey,
      archiveBytes,
      descriptorFilename,
    });
    return {
      bytes: validated.patch.archiveBytes,
      normalization: validated.normalization,
    };
  };
  const recoverableCandidateError = (error: unknown) =>
    error instanceof KnowledgeBaseMaterializedContractError ||
    error instanceof KnowledgeArchiveDownloadError ||
    (error instanceof KnowledgeBaseMaterializedError &&
      error.code === "PATCH_CONFLICT");
  const deterministicCandidateDiagnostic = (
    error: unknown,
  ): {
    code: string;
    stage: KnowledgeBaseResultProcessingStage;
  } | null => {
    if (error instanceof KnowledgeBaseMaterializedContractError) {
      const encoded = error.message.match(
        /^(KNOWLEDGE_BASE_[A-Z0-9_]+):(descriptor_search|download|archive_safety|manifest_parse|component_projection|canonical_validation|activation|presentation)$/u,
      );
      return {
        code: encoded?.[1] || error.code,
        stage:
          (encoded?.[2] as KnowledgeBaseResultProcessingStage | undefined) ||
          (error.category === "manifest_parse"
            ? "manifest_parse"
            : "canonical_validation"),
      };
    }
    if (
      error instanceof KnowledgeBaseMaterializedError &&
      error.code === "PATCH_CONFLICT"
    ) {
      return { code: error.code, stage: "canonical_validation" };
    }
    return null;
  };
  const persistedDiagnosticError = (
    diagnostic: KnowledgeBaseMaterializedResultDiagnostic,
  ) =>
    new KnowledgeBaseMaterializedContractError(
      `${diagnostic.firstTypedFailureCode || "KNOWLEDGE_BASE_MATERIALIZED_CONTRACT_INVALID"}:${diagnostic.resultProcessingStage}`,
      diagnostic.resultProcessingStage === "manifest_parse"
        ? "manifest_parse"
        : "contract",
    );
  const completionHasCandidate = Boolean(
    priorCompletion?.storageKey &&
      priorCompletion.candidateArchiveSha256 &&
      priorCompletion.sizeBytes,
  );
  const readCanonicalStagedCandidate = async () => {
    if (!completionHasCandidate) return null;
    const staged = await input.readCandidate({
      storageKey: priorCompletion!.storageKey!,
      contentSha256: priorCompletion!.candidateArchiveSha256!,
      sizeBytes: priorCompletion!.sizeBytes!,
    });
    const canonical = await canonicalCandidateBytes(staged);
    if (
      canonical.bytes.length !== priorCompletion!.sizeBytes ||
      createHash("sha256").update(canonical.bytes).digest("hex") !==
        priorCompletion!.candidateArchiveSha256
    ) {
      throw new KnowledgeBaseMaterializedResultError(
        "KNOWLEDGE_BASE_MATERIALIZED_RESULT_INVALID",
        "本地物化 ZIP 候选与已验证 CAS 不一致",
      );
    }
    return canonical;
  };

  let candidateBytes: Buffer | null = null;
  let candidateNormalization:
    | Extract<KnowledgeBaseNormalizationOutcome, { kind: "accepted" }>
    | undefined;
  let selectedResultDiagnostic:
    | { descriptorHash: string; archiveSha: string }
    | undefined;
  let lastCandidateError: unknown = null;
  let candidateAttempted = false;

  // A persisted stop attempt freezes the previously validated local CAS. It
  // is already enough authority to apply the content and must not wait for a
  // later Provider status acknowledgement or a mutable transport descriptor.
  if (priorCompletion?.stopAttemptState) {
    if (!priorCompletion.candidateEventIdHash || !completionHasCandidate) {
      throw new KnowledgeBaseMaterializedResultError(
        "KNOWLEDGE_BASE_MATERIALIZED_RESULT_INVALID",
        "task.stop 后物化 ZIP 候选账本不一致",
      );
    }
    try {
      const candidate = await readCanonicalStagedCandidate();
      candidateBytes = candidate?.bytes ?? null;
      candidateNormalization = candidate?.normalization;
    } catch {
      throw new KnowledgeBaseMaterializedResultError(
        "KNOWLEDGE_BASE_MATERIALIZED_RESULT_INVALID",
        "task.stop 后本地物化 ZIP 候选不可用",
      );
    }
  } else {
    for (const descriptor of candidateDescriptors) {
      candidateAttempted = true;
      try {
        const downloaded = await downloadCandidate(descriptor);
        const archiveSha = createHash("sha256")
          .update(downloaded.buffer)
          .digest("hex");
        const descriptorHash =
          knowledgeArchivePhysicalDescriptorHash(descriptor);
        if (input.persistResultDiagnostics) {
          const observed = await input.observeResultDiagnostic({
            userId: claim.turn.userId,
            turnId: claim.turn.id,
            leaseToken: claim.leaseToken,
            taskId,
            descriptorHash,
            archiveSha,
            resultProcessingStage: "archive_safety",
          });
          if (observed.skipNormalization) {
            lastCandidateError = persistedDiagnosticError(observed.diagnostic);
            continue;
          }
        }
        let candidate: Awaited<ReturnType<typeof canonicalCandidateBytes>>;
        try {
          candidate = await canonicalCandidateBytes(
            downloaded.buffer,
            descriptor.filename,
          );
        } catch (error) {
          const diagnostic = deterministicCandidateDiagnostic(error);
          if (diagnostic && input.persistResultDiagnostics) {
            await input.observeResultDiagnostic({
              userId: claim.turn.userId,
              turnId: claim.turn.id,
              leaseToken: claim.leaseToken,
              taskId,
              descriptorHash,
              archiveSha,
              resultProcessingStage: diagnostic.stage,
              firstTypedFailureCode: diagnostic.code,
              deterministicFailure: true,
            });
          }
          throw error;
        }
        candidateBytes = candidate.bytes;
        candidateNormalization = candidate.normalization;
        selectedResultDiagnostic = { descriptorHash, archiveSha };
        break;
      } catch (error) {
        if (!recoverableCandidateError(error)) throw error;
        lastCandidateError = error;
      }
    }
    if (!candidateBytes && completionHasCandidate) {
      candidateAttempted = true;
      try {
        const candidate = await readCanonicalStagedCandidate();
        candidateBytes = candidate?.bytes ?? null;
        candidateNormalization = candidate?.normalization;
      } catch (error) {
        if (!recoverableCandidateError(error)) throw error;
        lastCandidateError = error;
      }
    }
  }

  if (!candidateBytes) {
    if (
      lastCandidateError instanceof KnowledgeBaseMaterializedContractError ||
      (lastCandidateError instanceof KnowledgeBaseMaterializedError &&
        lastCandidateError.code === "PATCH_CONFLICT") ||
      (lastCandidateError instanceof KnowledgeArchiveDownloadError &&
        !lastCandidateError.retryable)
    ) {
      // The exact candidate has already produced a deterministic result. End
      // the turn once instead of re-running the same validator every sweep.
      throw lastCandidateError;
    }
    if (
      downloadableDescriptors.length === 0 &&
      (status === "stopped" ||
        status === "error" ||
        status === "failed" ||
        status === "cancelled")
    ) {
      throw new KnowledgeBaseMaterializedResultError(
        "KNOWLEDGE_BASE_MATERIALIZED_RESULT_UNAVAILABLE",
        "上游任务已结束，但连续两次读取均未返回可下载的知识库 ZIP",
      );
    }
    if (status === "cancelled") {
      throw new KnowledgeBaseMaterializedResultError(
        "KNOWLEDGE_BASE_MATERIALIZED_RESULT_UNAVAILABLE",
        "全量物化任务已取消，无法读取最终结果",
      );
    }
    if (status === "stopped") {
      if (lastCandidateError) throw lastCandidateError;
      throw new KnowledgeBaseMaterializedResultError(
        "KNOWLEDGE_BASE_MATERIALIZED_RESULT_INVALID",
        `物化任务未返回符合当前操作的可下载 ZIP；期望文件名 ${expectedFilename}`,
      );
    }
    const errorType =
      status === "error" || status === "failed"
        ? latestMaterializedErrorType(events)
        : null;
    const providerStatus =
      status === "waiting"
        ? "waiting"
        : status === "error" || status === "failed"
          ? errorType && MATERIALIZED_QUOTA_ERROR_TYPES.has(errorType)
            ? "quota_error"
            : "error"
          : status === "running"
            ? "running"
            : "unknown";
    const deferred = await input.deferProviderStatus({
      userId: claim.turn.userId,
      turnId: claim.turn.id,
      leaseToken: claim.leaseToken,
      status: providerStatus,
      resetCandidate: candidateAttempted || downloadableDescriptors.length > 0,
    });
    return {
      taskId,
      rebound: true,
      reconciled: deferred.state === "unavailable",
    };
  }

  // Activation/application performs the authoritative transaction and repeats
  // all archive, coordinate, ownership and CAS checks. Provider cleanup only
  // starts after that transaction has durably made the content displayable.
  if (input.persistResultDiagnostics && selectedResultDiagnostic) {
    await input.observeResultDiagnostic({
      userId: claim.turn.userId,
      turnId: claim.turn.id,
      leaseToken: claim.leaseToken,
      taskId,
      ...selectedResultDiagnostic,
      resultProcessingStage: "activation",
    });
  }
  if (build.contentVersion === 0) {
    await input.activateInitial({
      userId: claim.turn.userId,
      buildId: build.id,
      generation: build.generation,
      turnId: claim.turn.id,
      operationKey: claim.turn.operationKey,
      providerTaskId: taskId,
      archiveBytes: candidateBytes,
      initialBundleExpectation: knowledgeBaseInitialBundleExpectation({
        build,
        operationId: claim.turn.operationKey,
        expectedUploadsRead: claim.turn.expectedUserAttachmentCount,
      }),
      ...(candidateNormalization?.mode === "initial"
        ? { normalization: candidateNormalization }
        : {}),
    });
  } else {
    if (!claim.turn.expectedLeafId) {
      throw new KnowledgeBaseMaterializedResultError(
        "KNOWLEDGE_BASE_MATERIALIZED_RESULT_INVALID",
        "Revision 缺少目标节点",
      );
    }
    await input.applyRevision({
      userId: claim.turn.userId,
      buildId: build.id,
      generation: build.generation,
      turnId: claim.turn.id,
      operationId: claim.turn.operationKey,
      providerTaskId: taskId,
      targetLeafId: claim.turn.expectedLeafId,
      archiveBytes: candidateBytes,
      ...(candidateNormalization?.mode === "patch"
        ? { normalization: candidateNormalization }
        : {}),
    });
  }
  if (
    !priorCompletion?.stopAttemptState &&
    (status === "running" || status === "waiting" || status === "unknown") &&
    typeof client.stopTask === "function"
  ) {
    try {
      void Promise.resolve(client.stopTask(taskId)).catch((error) => {
        logKnowledgeBaseRuntimeFailure({
          level: "warn",
          event: "[KnowledgeBaseRecovery] materialized_cleanup_stop_failed",
          userId: claim.turn.userId,
          buildId: build.id,
          turnId: claim.turn.id,
          taskId,
          error,
          additionalSecrets: [credential.apiKey],
        });
      });
    } catch (error) {
      logKnowledgeBaseRuntimeFailure({
        level: "warn",
        event: "[KnowledgeBaseRecovery] materialized_cleanup_stop_failed",
        userId: claim.turn.userId,
        buildId: build.id,
        turnId: claim.turn.id,
        taskId,
        error,
        additionalSecrets: [credential.apiKey],
      });
    }
  }
  return { taskId, rebound: true, reconciled: true };
}

async function dispatchKnowledgeBaseRecoveryClaim(
  claim: KnowledgeBaseRecoveryClaim,
  credential: RecoveryCredential,
  dependencies: {
    loadBuild?: typeof loadKnowledgeBaseBuildRecordById;
    ensureDispatch?: typeof ensureKnowledgeBaseRecoveryDispatch;
    ensureManusV2Attachments?: typeof ensureKnowledgeBaseManusV2Attachments;
    beginDispatch?: typeof beginKnowledgeBaseManusV2Dispatch;
    markManusV2OutcomeUnknown?: typeof markKnowledgeBaseManusV2OutcomeUnknown;
    downloadArchive?: typeof downloadArchiveBytes;
    readCandidate?: typeof readKnowledgeBaseLocalSource;
    validateInitialCandidate?: typeof validateKnowledgeBaseWorkingSetArchive;
    validateRevisionCandidate?: typeof validateKnowledgeBaseRevisionAgainstActiveWorkingSet;
    observeResultDiagnostic?: typeof observeKnowledgeBaseMaterializedResultDiagnostic;
    deferProviderStatus?: typeof deferKnowledgeBaseMaterializedProviderStatus;
    activateInitial?: typeof activateInitialKnowledgeBaseWorkingSet;
    applyRevision?: typeof applyKnowledgeBaseRevisionWorkingSet;
    createClient?: (input: {
      baseUrl: string;
      apiKey: string;
    }) => Pick<ManusV2Client, "createTask" | "listAllMessages" | "stopTask">;
    bindSubmission?: typeof bindKnowledgeBaseManusV2Submission;
  } = {},
) {
  beginKnowledgeBaseClaimReadinessTiming(claim);
  const loadBuild = dependencies.loadBuild ?? loadKnowledgeBaseBuildRecordById;
  const ensureDispatch =
    dependencies.ensureDispatch ?? ensureKnowledgeBaseRecoveryDispatch;
  const ensureManusV2Attachments =
    dependencies.ensureManusV2Attachments ??
    ensureKnowledgeBaseManusV2Attachments;
  const beginDispatch =
    dependencies.beginDispatch ?? beginKnowledgeBaseManusV2Dispatch;
  const createClient =
    dependencies.createClient ?? ((input) => new ManusV2Client(input));
  const bindSubmission =
    dependencies.bindSubmission ?? bindKnowledgeBaseManusV2Submission;
  const downloadArchive = dependencies.downloadArchive ?? downloadArchiveBytes;
  const readCandidate =
    dependencies.readCandidate ?? readKnowledgeBaseLocalSource;
  const validateInitialCandidate =
    dependencies.validateInitialCandidate ??
    validateKnowledgeBaseWorkingSetArchive;
  const validateRevisionCandidate =
    dependencies.validateRevisionCandidate ??
    validateKnowledgeBaseRevisionAgainstActiveWorkingSet;
  const observeResultDiagnostic =
    dependencies.observeResultDiagnostic ??
    observeKnowledgeBaseMaterializedResultDiagnostic;
  const persistResultDiagnostics =
    dependencies.observeResultDiagnostic !== undefined ||
    (dependencies.validateInitialCandidate === undefined &&
      dependencies.validateRevisionCandidate === undefined);
  const deferProviderStatus =
    dependencies.deferProviderStatus ??
    deferKnowledgeBaseMaterializedProviderStatus;
  const activateInitial =
    dependencies.activateInitial ?? activateInitialKnowledgeBaseWorkingSet;
  const applyRevision =
    dependencies.applyRevision ?? applyKnowledgeBaseRevisionWorkingSet;
  const existingBuild = await loadBuild(claim.turn.userId, claim.turn.buildId);
  if (!existingBuild) {
    throw new KnowledgeBaseTurnReservationError(
      "BUILD_NOT_FOUND",
      "知识库构建不存在",
    );
  }
  if (
    existingBuild.executionMode !==
      MATERIALIZED_KNOWLEDGE_BASE_EXECUTION_MODE ||
    existingBuild.skillVersion !== "5" ||
    existingBuild.providerProtocol !== "manus_v2" ||
    existingBuild.contentVersion === null ||
    knowledgeBaseMaterializedRecoveryContractVersion(existingBuild) !== 1
  ) {
    // This is the final Provider boundary for both accepted HTTP work and the
    // recovery sweep. Old rows can contain v2-looking task metadata after a
    // historical handoff attempt; only the exact materialized-v5 triple is
    // allowed to reach attachment preparation or the Provider client.
    throw new KnowledgeBaseLocalPreparationError(
      "RESET_REQUIRED",
      "旧知识库构建不再续跑；请批准重置并重新上传资料",
    );
  }
  return dispatchMaterializedKnowledgeBaseClaim({
    claim,
    credential,
    build: existingBuild,
    ensureDispatch,
    ensureManusV2Attachments,
    beginDispatch,
    bindSubmission,
    downloadArchive,
    readCandidate,
    validateInitialCandidate,
    validateRevisionCandidate,
    observeResultDiagnostic,
    persistResultDiagnostics,
    deferProviderStatus,
    activateInitial,
    applyRevision,
    createClient,
  });
}

/** Fresh materialized-v5 dispatch seam; no legacy task adoption/rebuild path. */
export const knowledgeBaseTerminalAnchorRecoveryTestHooks = {
  dispatchKnowledgeBaseRecoveryClaim,
};

export async function persistKnowledgeBaseDispatchFailure(
  input: {
    claim: KnowledgeBaseRecoveryClaim;
    error: unknown;
    outcomeUnknownCode: string;
    recoveryDelayMs?: number;
    traceId?: string;
  },
  dependencies: {
    markManusV2OutcomeUnknown?: typeof markKnowledgeBaseManusV2OutcomeUnknown;
    persistCreateFailure?: typeof persistKnowledgeBaseCreateFailure;
    failMaterializedResult?: typeof failKnowledgeBaseMaterializedResultForApprovedReset;
    deferMaterializedResultRead?: typeof deferKnowledgeBaseMaterializedResultRead;
  } = {},
) {
  const markManusV2OutcomeUnknown =
    dependencies.markManusV2OutcomeUnknown ??
    markKnowledgeBaseManusV2OutcomeUnknown;
  const persistCreateFailure =
    dependencies.persistCreateFailure ?? persistKnowledgeBaseCreateFailure;
  const failMaterializedResult =
    dependencies.failMaterializedResult ??
    failKnowledgeBaseMaterializedResultForApprovedReset;
  const deferMaterializedResultRead =
    dependencies.deferMaterializedResultRead ??
    deferKnowledgeBaseMaterializedResultRead;
  if (input.error instanceof KnowledgeArchiveDownloadError) {
    if (input.error.retryable) {
      const disposition = await deferMaterializedResultRead({
        userId: input.claim.turn.userId,
        turnId: input.claim.turn.id,
        leaseToken: input.claim.leaseToken,
        lastErrorKind: input.error.status
          ? `archive_${input.error.kind}_${input.error.status}`
          : `archive_${input.error.kind}`,
      });
      return disposition.state === "deferred"
        ? ("retriable" as const)
        : ("deterministic" as const);
    }
    await failMaterializedResult({
      userId: input.claim.turn.userId,
      turnId: input.claim.turn.id,
      leaseToken: input.claim.leaseToken,
      code: "KNOWLEDGE_BASE_MATERIALIZED_RESULT_UNAVAILABLE",
    });
    return "deterministic" as const;
  }
  if (
    input.error instanceof KnowledgeBaseMaterializedContractError ||
    input.error instanceof KnowledgeBaseMaterializedResultError
  ) {
    await failMaterializedResult({
      userId: input.claim.turn.userId,
      turnId: input.claim.turn.id,
      leaseToken: input.claim.leaseToken,
      code:
        input.error instanceof KnowledgeBaseMaterializedContractError
          ? "KNOWLEDGE_BASE_MATERIALIZED_CONTRACT_INVALID"
          : input.error.code,
    });
    return "deterministic" as const;
  }
  const v2Error = input.error instanceof ManusV2ApiError ? input.error : null;
  const acknowledgedMaterializedResult =
    input.claim.turn.providerProtocol === "manus_v2" &&
    input.claim.turn.materializedRecoveryContractVersion === 1 &&
    (input.claim.turn.createAttemptState === "acknowledged" ||
      Boolean(input.claim.turn.upstreamTaskId));
  if (acknowledgedMaterializedResult) {
    // Result processing is a separate failure domain from task.create. A
    // transport failure while reading the exact bound task may retry that
    // read, but no post-ack error is ever allowed to call the create
    // outcome-unknown mutation or discover/adopt another task.
    if (
      v2Error &&
      v2Error.operation === "task.listMessages" &&
      (v2Error.outcomeUnknown ||
        v2Error.retryable ||
        v2Error.status === null ||
        v2Error.status === 408 ||
        v2Error.status === 425 ||
        v2Error.status === 429 ||
        (v2Error.status !== null && v2Error.status >= 500))
    ) {
      const disposition = await deferMaterializedResultRead({
        userId: input.claim.turn.userId,
        turnId: input.claim.turn.id,
        leaseToken: input.claim.leaseToken,
        lastErrorKind: "task_list_messages_transport",
      });
      return disposition.state === "deferred"
        ? ("retriable" as const)
        : ("deterministic" as const);
    }
    await failMaterializedResult({
      userId: input.claim.turn.userId,
      turnId: input.claim.turn.id,
      leaseToken: input.claim.leaseToken,
      code: "KNOWLEDGE_BASE_RESULT_PROCESSING_FAILED",
    });
    return "deterministic" as const;
  }
  const isCurrentExplicitV2Rejection =
    input.claim.turn.providerProtocol === "manus_v2" &&
    v2Error !== null &&
    !v2Error.outcomeUnknown &&
    v2Error.operation === "task.create" &&
    input.claim.turn.providerAttemptState === "sending";
  if (isCurrentExplicitV2Rejection && v2Error) {
    const requestShape = (
      v2Error as ManusV2ApiError & {
        frontmindRequestShape?: {
          promptUtf8Bytes: number;
          titleUtf8Bytes: number;
          attachmentCount: number;
          agentProfile: string | null;
          hasAgentProfile: boolean;
          hasStructuredOutputSchema: boolean;
          structuredOutputSchemaUtf8Bytes: number;
          structuredOutputSchemaSha256: string | null;
          compatibilityMode: "standard" | "minimal_v2_create";
        };
      }
    ).frontmindRequestShape;
    const settled = await settleKnowledgeBaseManusV2ExplicitRejection({
      userId: input.claim.turn.userId,
      turnId: input.claim.turn.id,
      leaseToken: input.claim.leaseToken,
      code: "MANUS_V2_CREATE_REJECTED",
      // A fresh materialized operation has exactly one task.create attempt.
      // Even an explicit retryable Provider rejection requires approved reset
      // rather than reusing this turn for a second create.
      retryable: false,
      providerCode: v2Error.code,
      providerStatus: v2Error.status,
      providerRequestRef: v2Error.providerRequestId,
      providerField: v2Error.providerField,
      providerPath: v2Error.providerPath,
      ...(requestShape ? { providerRequestShape: requestShape } : {}),
      ...(v2Error.retryAfterMs !== null
        ? { recoveryDelayMs: v2Error.retryAfterMs }
        : {}),
    });
    return settled.retryScheduled
      ? ("retriable" as const)
      : ("deterministic" as const);
  }
  if (
    input.claim.turn.providerProtocol === "manus_v2" &&
    input.error instanceof ManusV2ApiError &&
    input.error.outcomeUnknown
  ) {
    await markManusV2OutcomeUnknown({
      userId: input.claim.turn.userId,
      turnId: input.claim.turn.id,
      leaseToken: input.claim.leaseToken,
      code: input.outcomeUnknownCode,
      ...(input.recoveryDelayMs
        ? { recoveryDelayMs: input.recoveryDelayMs }
        : {}),
    });
    return "retriable" as const;
  }
  if (
    input.claim.turn.providerProtocol === "manus_v2" &&
    (input.claim.turn.providerAttemptState === "output_pending" ||
      input.claim.turn.providerAttemptState === "outcome_unknown")
  ) {
    // A task.create may have returned 2xx before its exact local binding
    // committed. Persist only the ambiguity marker: an unbound result is
    // converted to RESET_REQUIRED by the next locked recovery claim, while a
    // bound task remains eligible only for exact task.listMessages polling.
    await markManusV2OutcomeUnknown({
      userId: input.claim.turn.userId,
      turnId: input.claim.turn.id,
      leaseToken: input.claim.leaseToken,
      code: input.outcomeUnknownCode,
      ...(input.recoveryDelayMs
        ? { recoveryDelayMs: input.recoveryDelayMs }
        : {}),
    });
    return "retriable" as const;
  }
  return persistCreateFailure({
    userId: input.claim.turn.userId,
    turnId: input.claim.turn.id,
    leaseToken: input.claim.leaseToken,
    error: input.error,
    outcomeUnknownCode: input.outcomeUnknownCode,
    ...(input.recoveryDelayMs
      ? { recoveryDelayMs: input.recoveryDelayMs }
      : {}),
    ...(input.traceId ? { traceId: input.traceId } : {}),
  });
}

async function withKnowledgeBaseRecoveryLeaseHeartbeat<T>(input: {
  claim: KnowledgeBaseRecoveryClaim;
  operation: () => Promise<T>;
}) {
  const leaseMs = 300_000;
  let renewal: Promise<void> = Promise.resolve();
  let leaseError: unknown;
  const renew = () => {
    renewal = renewal.then(async () => {
      if (leaseError) return;
      try {
        await renewKnowledgeBaseTurnLease({
          userId: input.claim.turn.userId,
          turnId: input.claim.turn.id,
          leaseToken: input.claim.leaseToken,
          leaseMs,
        });
      } catch (error) {
        leaseError = error;
      }
    });
  };
  const timer = setInterval(renew, 60_000);
  timer.unref();
  try {
    const result = await input.operation();
    await renewal;
    if (leaseError) {
      throw new KnowledgeBaseTurnReservationError(
        "CONFLICT",
        "Knowledge-base recovery lease was lost",
      );
    }
    return result;
  } finally {
    clearInterval(timer);
    await renewal.catch(() => undefined);
  }
}

export async function recoverExpiredKnowledgeBaseTurns(options?: {
  limit?: number;
  concurrency?: number;
  includeClaimedTurnIds?: boolean;
}) {
  const limit = Math.min(200, Math.max(1, Math.trunc(options?.limit ?? 50)));
  const concurrency = Math.min(
    8,
    Math.max(1, Math.trunc(options?.concurrency ?? 3)),
  );
  const candidates = await findRecoverableKnowledgeBaseTurnIds({
    limit,
  });
  const result = {
    scanned: candidates.length,
    claimed: 0,
    claimedTurnIds: [] as string[],
    rebound: 0,
    reconciled: 0,
    credentialPaused: 0,
    skipped: 0,
    failed: 0,
  };
  let cursor = 0;
  const worker = async () => {
    while (cursor < candidates.length) {
      const candidate = candidates[cursor++];
      let claim: KnowledgeBaseRecoveryClaim | null = null;
      let recoveryApiKey: string | undefined;
      try {
        claim = await claimKnowledgeBaseTurnForRecovery({
          turnId: candidate.turnId,
          leaseMs: 300_000,
        });
        if (!claim) {
          result.skipped += 1;
          continue;
        }
        const ownedClaim = claim;
        result.claimed += 1;
        if (options?.includeClaimedTurnIds) {
          result.claimedTurnIds.push(ownedClaim.turn.id);
        }
        await assertKnowledgeBaseWritable(ownedClaim.turn.userId);
        let credential: Awaited<
          ReturnType<typeof getDecryptedCredentialForKnowledgeBaseReservation>
        > = null;
        let credentialUnavailable = !ownedClaim.turn.apiCredentialId;
        if (!credentialUnavailable) {
          try {
            credential =
              await getDecryptedCredentialForKnowledgeBaseReservation({
                userId: ownedClaim.turn.userId,
                turnId: ownedClaim.turn.id,
                buildId: ownedClaim.turn.buildId!,
                buildGeneration: ownedClaim.turn.buildGeneration!,
                apiCredentialId: ownedClaim.turn.apiCredentialId!,
              });
            credentialUnavailable = credential === null;
          } catch (error) {
            credentialUnavailable =
              error instanceof AuthServiceError &&
              error.code === "INVALID_CREDENTIAL";
            if (!credentialUnavailable) throw error;
          }
        }
        if (credentialUnavailable) {
          const paused = await pauseKnowledgeBasePreCreateCredentialUnavailable(
            {
              userId: ownedClaim.turn.userId,
              turnId: ownedClaim.turn.id,
              leaseToken: ownedClaim.leaseToken,
            },
          );
          if (paused) {
            result.credentialPaused += 1;
            continue;
          }
          throw new Error("Reserved credential version is unavailable");
        }
        if (!credential) {
          throw new Error("Reserved credential resolution was inconclusive");
        }
        recoveryApiKey = credential.apiKey;
        const recovered = await withKnowledgeBaseRecoveryLeaseHeartbeat({
          claim: ownedClaim,
          operation: () =>
            dispatchKnowledgeBaseRecoveryClaim(ownedClaim, credential),
        });
        if (recovered.rebound) result.rebound += 1;
        if (recovered.reconciled) result.reconciled += 1;
      } catch (error) {
        result.failed += 1;
        let manualLogoFailureSettled = false;
        let failureDisposition: "deferred" | "settled" = "deferred";
        let failureToPersist = error;
        if (claim) {
          const terminalLogoFailure =
            claim.recoveryMetadata.manualLogoSubmission === true
              ? knowledgeBaseManualLogoTerminalFailure(error)
              : null;
          if (terminalLogoFailure) {
            try {
              await rejectAcknowledgedKnowledgeBaseManualLogoTurn({
                userId: claim.turn.userId,
                buildId: claim.turn.buildId,
                buildGeneration: claim.turn.buildGeneration,
                turnId: claim.turn.id,
                clientRequestId: claim.turn.clientRequestId,
                leaseToken: claim.leaseToken,
                code: terminalLogoFailure.code,
                message: terminalLogoFailure.message,
              });
              manualLogoFailureSettled = true;
              failureDisposition = "settled";
            } catch (persistenceError) {
              // The child task may already exist. Never fall through to the
              // generic invalid-upload cancellation, which only accepts an
              // unbound turn and would leave this recovery poisoned forever.
              manualLogoFailureSettled = true;
              await markKnowledgeBaseTurnOutcomeUnknown({
                userId: claim.turn.userId,
                turnId: claim.turn.id,
                leaseToken: claim.leaseToken,
                code: "MANUAL_LOGO_REJECTION_DEFERRED",
                recoveryDelayMs: 1_000,
              }).catch(() => undefined);
              logKnowledgeBaseRuntimeFailure({
                level: "warn",
                event:
                  "[KnowledgeBaseTurnRecovery] manual_logo_rejection_persistence_deferred",
                userId: claim.turn.userId,
                buildId: claim.turn.buildId,
                turnId: claim.turn.id,
                error: persistenceError,
                additionalSecrets: [recoveryApiKey],
              });
            }
          } else if (claim.recoveryMetadata.manualLogoSubmission === true) {
            const deterministicCreateStatus =
              knowledgeBaseManualLogoDeterministicCreateFailureStatus(error);
            if (
              deterministicCreateStatus &&
              error instanceof KnowledgeBaseUpstreamCreateError
            ) {
              try {
                await rejectUnacknowledgedKnowledgeBaseManualLogoTurn({
                  userId: claim.turn.userId,
                  buildId: claim.turn.buildId,
                  buildGeneration: claim.turn.buildGeneration,
                  turnId: claim.turn.id,
                  clientRequestId: claim.turn.clientRequestId,
                  leaseToken: claim.leaseToken,
                  code: error.failureCode,
                  message:
                    deterministicKnowledgeBaseCreateFailureMessage(error),
                });
                manualLogoFailureSettled = true;
                failureDisposition = "settled";
              } catch (persistenceError) {
                manualLogoFailureSettled = true;
                await markKnowledgeBaseTurnOutcomeUnknown({
                  userId: claim.turn.userId,
                  turnId: claim.turn.id,
                  leaseToken: claim.leaseToken,
                  code: "MANUAL_LOGO_REJECTION_DEFERRED",
                  recoveryDelayMs: 1_000,
                }).catch(() => undefined);
                logKnowledgeBaseRuntimeFailure({
                  level: "warn",
                  event:
                    "[KnowledgeBaseTurnRecovery] manual_logo_create_rejection_persistence_deferred",
                  userId: claim.turn.userId,
                  buildId: claim.turn.buildId,
                  turnId: claim.turn.id,
                  error: persistenceError,
                  additionalSecrets: [recoveryApiKey],
                });
              }
            } else {
              failureToPersist =
                knowledgeBaseManualLogoCreateFailureForPersistence(error);
            }
          }
          if (!manualLogoFailureSettled) {
            const localAuthoritySettled =
              await knowledgeBaseLocalRehydrateAuthorityFailureForPersistence({
                userId: claim.turn.userId,
                turnId: claim.turn.id,
                leaseToken: claim.leaseToken,
                error: failureToPersist,
              }).catch(() => false);
            if (localAuthoritySettled) failureDisposition = "settled";
            if (!localAuthoritySettled) {
              const persisted = await persistKnowledgeBaseDispatchFailure({
                claim,
                error: failureToPersist,
                outcomeUnknownCode: "RECOVERY_DEFERRED",
              }).catch(() => undefined);
              if (persisted === "deterministic") {
                failureDisposition = "settled";
              }
            }
          }
        }
        const safeResultFailure =
          error instanceof KnowledgeBaseMaterializedContractError
            ? new Error("KNOWLEDGE_BASE_MATERIALIZED_CONTRACT_INVALID")
            : error instanceof KnowledgeBaseMaterializedResultError
              ? new Error(error.code)
              : error;
        logKnowledgeBaseRuntimeFailure({
          level: "warn",
          event:
            failureDisposition === "settled"
              ? "[KnowledgeBaseTurnRecovery] settled"
              : "[KnowledgeBaseTurnRecovery] deferred",
          turnId: candidate.turnId,
          buildId: candidate.buildId,
          error: safeResultFailure,
          additionalSecrets: [recoveryApiKey],
        });
      }
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(concurrency, candidates.length) }, worker),
  );
  return result;
}

type DurableKnowledgeBaseGeneratedAttachment = {
  userId: number;
  turnId: string;
  leaseToken: string;
  attachmentIndex: number;
  role: "skill" | "prefill" | "instructions" | "working_set" | "finalization";
};

export function knowledgeBaseGeneratedAttachmentFailureForPersistence(
  error: unknown,
) {
  if (
    error instanceof UpstreamTaskAttachmentPendingError ||
    (error instanceof UpstreamFileReadinessError && error.retryable) ||
    (error instanceof UpstreamTaskAttachmentContentProofError &&
      error.retryable)
  ) {
    return new KnowledgeBaseAttachmentsProcessingError(0, 1, 5_000, undefined, {
      cause: error,
    });
  }
  if (
    error instanceof UpstreamFileReadinessError ||
    error instanceof UpstreamTaskAttachmentContentProofError
  ) {
    return new KnowledgeBaseLocalPreparationError(
      "KNOWLEDGE_BASE_GENERATED_ATTACHMENT_INVALID",
      "系统生成附件无法通过上游内容完整性校验，请联系支持处理",
      { cause: error },
    );
  }
  return error;
}

export async function knowledgeBaseLocalRehydrateAuthorityFailureForPersistence(
  input: {
    userId: number;
    turnId: string;
    leaseToken: string;
    error: unknown;
  },
  dependencies: {
    failDeterministically?: typeof failKnowledgeBaseTurnDeterministically;
  } = {},
) {
  if (
    !(input.error instanceof KnowledgeBaseLocalPreparationError) ||
    input.error.code !== "KNOWLEDGE_BASE_LOCAL_REHYDRATE_AUTHORITY_INVALID"
  ) {
    return false;
  }
  await (
    dependencies.failDeterministically ?? failKnowledgeBaseTurnDeterministically
  )({
    userId: input.userId,
    turnId: input.turnId,
    leaseToken: input.leaseToken,
    code: input.error.code,
    message: `${input.error.message}。未向上游创建任务`,
    failureClass: "terminal_nonregenerable",
    recoveryAction: "contact_support",
    canRegenerate: false,
  });
  return true;
}

async function uploadDurableKnowledgeBaseGeneratedAttachment(input: {
  baseUrl: string;
  apiKey: string;
  filename: string;
  bytes: Buffer;
  mimeType?: string;
  reusableUpstreamFileId?: string | null;
  durable: DurableKnowledgeBaseGeneratedAttachment;
  providerProtocol?: "legacy_v1" | "manus_v2";
  replacementAttempted?: boolean;
}) {
  const mimeType = input.mimeType || "application/zip";
  // Install the exact generated bytes before the first provider file POST.
  // Provider file ids can expire; this immutable source is the recovery fact.
  const localSource = await persistKnowledgeBaseGeneratedSource(input.bytes);
  const reservation = await reserveKnowledgeBaseGeneratedAttachment({
    userId: input.durable.userId,
    turnId: input.durable.turnId,
    leaseToken: input.durable.leaseToken,
    role: input.durable.role,
    attachmentIndex: input.durable.attachmentIndex,
    filename: input.filename,
    mimeType,
    sizeBytes: input.bytes.length,
    contentSha256: localSource.contentSha256,
    localStorageKey: localSource.storageKey,
  });
  if (input.providerProtocol === "manus_v2") {
    // v2 task files must originate in /v2. This source id is only an ordered
    // Dashboard ledger coordinate and is never sent to Manus. If a legacy
    // migration already staged a v1 id in this exact slot, retain it solely
    // as the frozen source coordinate so recovery does not rewrite history.
    const localSourceId =
      reservation.upstreamFileId ||
      `kb-local-${reservation.requestHash.slice(0, 48)}`;
    return {
      attachment: { file_id: localSourceId, filename: input.filename },
      fileId: localSourceId,
      removeOrphan: async () => undefined,
    };
  }
  const reusableUpstreamFileId = String(
    input.reusableUpstreamFileId || "",
  ).trim();
  if (
    reusableUpstreamFileId &&
    reservation.upstreamFileId === reusableUpstreamFileId
  ) {
    await waitForKnowledgeBaseAttachmentGroup({
      baseUrl: input.baseUrl,
      apiKey: input.apiKey,
      attachments: [
        { file_id: reusableUpstreamFileId, filename: input.filename },
      ],
      attachmentKind: "generated",
      filenamePolicy: "exact",
    });
    await promoteKnowledgeBaseGeneratedAttachmentReady({
      userId: input.durable.userId,
      turnId: input.durable.turnId,
      leaseToken: input.durable.leaseToken,
      role: input.durable.role,
      attachmentIndex: input.durable.attachmentIndex,
      requestHash: reservation.requestHash,
      upstreamFileId: reusableUpstreamFileId,
    });
    return {
      attachment: {
        file_id: reusableUpstreamFileId,
        filename: input.filename,
      },
      fileId: reusableUpstreamFileId,
      // The file belongs to an already completed turn and may be shared by
      // later turns in this build. A failed continuation must never delete it.
      removeOrphan: async () => undefined,
    };
  }
  try {
    // `uploadUpstreamTaskAttachment` resolves only after readiness (and, for
    // recovered candidates, byte-for-byte content proof). Promote after it
    // returns so a candidate can never leak into a task body prematurely.
    const uploaded = await uploadUpstreamTaskAttachment({
      baseUrl: input.baseUrl,
      apiKey: input.apiKey,
      filename: input.filename,
      bytes: input.bytes,
      mimeType,
      idempotencyKey: reservation.idempotencyKey,
      readinessDeadlineMs: KNOWLEDGE_BASE_READINESS_WAIT_MS,
      ...(reservation.upstreamFileId
        ? { existingFileId: reservation.upstreamFileId }
        : {}),
      onFileResolved: async (upstreamFileId) => {
        await completeKnowledgeBaseGeneratedAttachment({
          userId: input.durable.userId,
          turnId: input.durable.turnId,
          leaseToken: input.durable.leaseToken,
          role: input.durable.role,
          attachmentIndex: input.durable.attachmentIndex,
          requestHash: reservation.requestHash,
          upstreamFileId,
        });
      },
    });
    await promoteKnowledgeBaseGeneratedAttachmentReady({
      userId: input.durable.userId,
      turnId: input.durable.turnId,
      leaseToken: input.durable.leaseToken,
      role: input.durable.role,
      attachmentIndex: input.durable.attachmentIndex,
      requestHash: reservation.requestHash,
      upstreamFileId: uploaded.fileId,
    });
    return uploaded;
  } catch (error) {
    const definitelyUnusableCandidate =
      reservation.upstreamFileId &&
      ((error instanceof UpstreamFileReadinessError &&
        !error.retryable &&
        error.code === "UPSTREAM_FILE_UNUSABLE") ||
        (error instanceof UpstreamTaskAttachmentContentProofError &&
          !error.retryable &&
          error.httpStatus === 404));
    if (definitelyUnusableCandidate && !input.replacementAttempted) {
      await replaceUnusableKnowledgeBaseGeneratedAttachment({
        userId: input.durable.userId,
        turnId: input.durable.turnId,
        leaseToken: input.durable.leaseToken,
        role: input.durable.role,
        attachmentIndex: input.durable.attachmentIndex,
        requestHash: reservation.requestHash,
        upstreamFileId: reservation.upstreamFileId!,
      });
      return uploadDurableKnowledgeBaseGeneratedAttachment({
        ...input,
        reusableUpstreamFileId: null,
        replacementAttempted: true,
      });
    }
    throw knowledgeBaseGeneratedAttachmentFailureForPersistence(error);
  }
}

export async function uploadKnowledgeBaseSkillArchive({
  baseUrl,
  apiKey,
  skillVersion = "5",
  skillContentHash,
  archive: pinnedArchive,
  reusableUpstreamFileId,
  durable,
  providerProtocol,
}: {
  baseUrl: string;
  apiKey: string;
  skillVersion?: string;
  skillContentHash?: string | null;
  archive?: Awaited<ReturnType<typeof ensureKnowledgeBaseBuildSkillArchivePin>>;
  reusableUpstreamFileId?: string | null;
  durable?: Omit<DurableKnowledgeBaseGeneratedAttachment, "role">;
  providerProtocol?: "legacy_v1" | "manus_v2";
}) {
  const archive =
    pinnedArchive ||
    (await readKnowledgeBaseSkillArchiveAttachment({
      version: skillVersion,
      contentHash: skillContentHash,
    }));
  if (
    pinnedArchive &&
    String(skillContentHash || "") !== pinnedArchive.contentHash
  ) {
    throw new Error(
      "Pinned Skill archive does not match the logical build pin",
    );
  }
  const uploaded = durable
    ? await uploadDurableKnowledgeBaseGeneratedAttachment({
        baseUrl,
        apiKey,
        filename: archive.filename,
        bytes: archive.bytes,
        reusableUpstreamFileId,
        providerProtocol,
        durable: { ...durable, role: "skill" },
      })
    : await uploadUpstreamTaskAttachment({
        baseUrl,
        apiKey,
        filename: archive.filename,
        bytes: archive.bytes,
      });
  return { ...uploaded, contentHash: archive.contentHash };
}

export async function createFrontMindTask({
  baseUrl,
  apiKey,
  prompt,
  agentProfile,
  attachments,
  taskId: existingTaskId,
  idempotencyKey,
  requestBody,
  traceId,
}: {
  baseUrl: string;
  apiKey: string;
  prompt?: string;
  agentProfile?: "manus-1.6" | "manus-1.6-max";
  attachments?: Array<{ file_id: string; filename: string }>;
  taskId?: string;
  idempotencyKey?: string;
  /** Exact credential-free body persisted before the first POST. */
  requestBody?: KnowledgeBasePreparedDispatch["requestBody"];
  traceId?: string;
}) {
  if (!requestBody && !agentProfile) {
    throw new KnowledgeBaseLocalPreparationError(
      "KNOWLEDGE_BASE_CREDENTIAL_PROFILE_MISSING",
      "创建知识库任务必须显式冻结 Base/Pro 模型配置",
    );
  }
  const body =
    requestBody ||
    ({
      prompt: String(prompt || ""),
      agentProfile: agentProfile!,
      attachments: attachments || [],
    } satisfies KnowledgeBasePreparedDispatch["requestBody"]);
  void existingTaskId;
  assertUpstreamPromptBudget(body.prompt);
  // Kept only as a frozen operation coordinate. Provider idempotency is
  // reconciled through the durable v2 operation marker, never a blind retry.
  void idempotencyKey;
  let taskResponse: {
    status: number;
    headers: Record<string, string | undefined>;
    data: Record<string, unknown> & {
      request_id?: unknown;
      code?: unknown;
      message?: unknown;
      error?: {
        code?: unknown;
        message?: unknown;
        request_id?: unknown;
      };
    };
  };
  try {
    const created = await new ManusV2Client({ baseUrl, apiKey }).createTask({
      prompt: body.prompt,
      attachments: body.attachments,
      agentProfile: body.agentProfile,
      locale: "zh-CN",
      interactiveMode: false,
    });
    taskResponse = {
      status: 200,
      headers: {},
      data: {
        ok: true,
        task_id: created.taskId,
        task_url: created.taskUrl,
        task_title: created.taskTitle,
        status: "running",
        output: [],
        request_id: created.requestId,
      },
    };
  } catch (error) {
    if (
      error instanceof ManusV2ApiError &&
      !error.outcomeUnknown &&
      error.status
    ) {
      taskResponse = {
        status: error.status,
        headers: {},
        data: {
          ok: false,
          error: {
            code: error.code,
            message: error.message,
            request_id: error.providerRequestId,
          },
        },
      };
    } else {
      return {
        ok: false as const,
        status: 503,
        detail: "Upstream task creation result is unknown",
        failureClass: classifyKnowledgeBaseUpstreamCreateFailure({
          transportError: true,
        }),
        failureCode: "UPSTREAM_CREATE_TRANSPORT_UNKNOWN" as const,
        reasonCategory: "TRANSPORT_UNKNOWN" as const,
        traceId,
      };
    }
  }

  const rawProviderRequestRef =
    taskResponse.headers?.["x-request-id"] ??
    taskResponse.headers?.["request-id"] ??
    taskResponse.headers?.["x-amzn-requestid"] ??
    taskResponse.data?.request_id ??
    taskResponse.data?.error?.request_id;
  const normalizedProviderRequestRef = String(rawProviderRequestRef || "")
    .trim()
    .slice(0, 512);
  const providerRequestRef = normalizedProviderRequestRef
    ? `sha256:${createHash("sha256")
        .update(normalizedProviderRequestRef)
        .digest("hex")
        .slice(0, 24)}`
    : undefined;

  if (taskResponse.status < 200 || taskResponse.status >= 300) {
    const upstreamErrorCode =
      taskResponse.data?.error?.code || taskResponse.data?.code;
    const providerCodeCandidate = knowledgeBaseUpstreamString(
      upstreamErrorCode,
      7,
    );
    const safeNumericProviderCode =
      providerCodeCandidate && /^[0-9]{1,6}$/u.test(providerCodeCandidate)
        ? providerCodeCandidate
        : undefined;
    const providerText = String(
      taskResponse.data?.error?.message || taskResponse.data?.message || "",
    ).toUpperCase();
    const providerCode = String(upstreamErrorCode || "").toUpperCase();
    const reasonCategory: KnowledgeBaseProviderReasonCategory =
      taskResponse.status === 401 || taskResponse.status === 403
        ? "CREDENTIAL_REJECTED"
        : taskResponse.status === 402 ||
            /(?:QUOTA|CREDIT|BALANCE)/u.test(providerCode + providerText)
          ? "QUOTA_REJECTED"
          : /(?:ATTACHMENT|FILE)/u.test(providerCode + providerText)
            ? "ATTACHMENT_INVALID"
            : /(?:PROFILE|AGENT_PROFILE)/u.test(providerCode + providerText)
              ? "PROFILE_INVALID"
              : taskResponse.status === 400 || taskResponse.status === 422
                ? providerCode === "3" ||
                  /(?:INVALID_ARGUMENT)/u.test(providerCode + providerText)
                  ? "UNKNOWN_INVALID_ARGUMENT"
                  : "PAYLOAD_INVALID"
                : taskResponse.status >= 500
                  ? "UPSTREAM_UNAVAILABLE"
                  : "UNKNOWN_PROVIDER_REJECTION";
    return {
      ok: false as const,
      status: taskResponse.status,
      detail: "Upstream task creation was rejected",
      failureClass: classifyKnowledgeBaseUpstreamCreateFailure({
        status: taskResponse.status,
        code: upstreamErrorCode,
      }),
      failureCode: safeNumericProviderCode
        ? `UPSTREAM_CREATE_${safeNumericProviderCode}`
        : `UPSTREAM_CREATE_HTTP_${taskResponse.status}`,
      reasonCategory,
      providerRequestRef,
      traceId,
    };
  }

  let taskData: Record<string, unknown>;
  let taskId: string | null;
  try {
    taskData = canonicalKnowledgeBaseUpstreamTask(taskResponse.data);
    taskId = upstreamTaskId(taskData, false);
  } catch {
    taskData = {};
    taskId = null;
  }
  if (!taskId) {
    return {
      ok: false as const,
      status: 502,
      detail: "Upstream task creation result is missing its task id",
      failureClass: classifyKnowledgeBaseUpstreamCreateFailure({
        missingTaskId: true,
      }),
      failureCode: "UPSTREAM_TASK_ID_MISSING" as const,
      reasonCategory: "TASK_ID_MISSING" as const,
      providerRequestRef,
      traceId,
    };
  }

  const taskMetadata = knowledgeBaseUpstreamRecord(taskData.metadata) || {};
  const rawStatus = knowledgeBaseUpstreamString(taskData.status, 64);
  return {
    ok: true as const,
    status: taskResponse.status,
    task: {
      id: taskId,
      status: rawStatus === "failed" ? "error" : rawStatus || "running",
      taskUrl: knowledgeBaseUpstreamString(
        taskData.task_url ?? taskMetadata.task_url,
        2_048,
      ),
      title: knowledgeBaseUpstreamString(
        taskData.task_title ?? taskMetadata.task_title,
        255,
      ),
      output: normalizeRecoveredTaskOutput(taskData),
    },
    providerRequestRef,
    traceId,
  };
}

function logKnowledgeBaseTaskCreateDiagnostic(input: {
  claim: KnowledgeBaseRecoveryClaim;
  dispatch: KnowledgeBasePreparedDispatch;
  result: Awaited<ReturnType<typeof createFrontMindTask>>;
}) {
  const safeIdentifier = (value: unknown) => {
    const normalized = String(value || "");
    return normalized.length <= 255 && /^[A-Za-z0-9._:-]+$/u.test(normalized)
      ? normalized
      : undefined;
  };
  const traceId = safeIdentifier(knowledgeBaseClaimTraceId(input.claim));
  const reasonCategory = safeIdentifier(
    input.result.ok ? "ACKNOWLEDGED" : input.result.reasonCategory,
  );
  const failureCode = input.result.ok
    ? undefined
    : safeIdentifier(input.result.failureCode);
  const providerRequestRef = safeIdentifier(input.result.providerRequestRef);
  console[input.result.ok ? "info" : "warn"](
    "[KnowledgeBaseTaskCreate] result",
    JSON.stringify({
      buildId: safeIdentifier(input.claim.turn.buildId),
      turnId: safeIdentifier(input.claim.turn.id),
      ...(traceId ? { traceId } : {}),
      schemaVersion: input.dispatch.schemaVersion,
      bodySha256: input.dispatch.bodySha256,
      attachmentCount: input.dispatch.requestBody.attachments.length,
      readyCount: input.dispatch.requestBody.attachments.length,
      pendingCount: 0,
      errorCount: 0,
      maxReadinessDelayMs: knowledgeBaseClaimReadinessDelayMs(input.claim),
      status: input.result.status,
      ...(reasonCategory ? { reasonCategory } : {}),
      ...(failureCode ? { failureCode } : {}),
      ...(providerRequestRef ? { providerRequestRef } : {}),
    }),
  );
}

function knowledgeBaseUpstreamCreateError(
  failure: Extract<
    Awaited<ReturnType<typeof createFrontMindTask>>,
    { ok: false }
  >,
) {
  return new KnowledgeBaseUpstreamCreateError(
    failure.failureClass,
    failure.failureCode,
    failure.status,
    failure.reasonCategory,
    failure.providerRequestRef,
    failure.traceId,
  );
}

function deterministicKnowledgeBaseCreateFailureMessage(
  error: KnowledgeBaseUpstreamCreateError,
) {
  if (error.failureCode === "UPSTREAM_TASK_ID_MISSING") {
    return "上游任务编号暂不可读，系统正在使用同一请求标识核对本轮结果";
  }
  if (error.status === 401 || error.status === 403) {
    return "上游已明确拒绝使用当前 API 凭证创建任务；本轮不会再次提交，请更新凭证后新建知识库构建";
  }
  if (error.status === 413) {
    return "上游已明确拒绝本轮附件合同；本轮不会再次提交，请调整资料后新建知识库构建";
  }
  return "上游已明确拒绝创建本轮任务，当前内容和附件均已保留；本轮不会再次提交，请新建知识库构建";
}

function knowledgeBaseCreateUserRecoveryAction() {
  // A deterministic provider rejection has already consumed the one allowed
  // Task Create attempt. Same-turn actions are reserved for failures that
  // occurred while createAttemptState was still exactly `not_sent`.
  return "contact_support" as const;
}

export async function persistKnowledgeBaseCreateFailure(
  input: {
    userId: number;
    turnId: string;
    leaseToken: string;
    error: unknown;
    outcomeUnknownCode: string;
    recoveryDelayMs?: number;
    traceId?: string;
  },
  dependencies: {
    cancelUnprepared?: typeof cancelUnpreparedKnowledgeBaseTurn;
    failDeterministically?: typeof failKnowledgeBaseTurnDeterministically;
    markOutcomeUnknown?: typeof markKnowledgeBaseTurnOutcomeUnknown;
    deferBeforeCreate?: typeof deferKnowledgeBaseTurnBeforeCreate;
    settlePreCreateFailure?: typeof settleKnowledgeBasePreCreateFailureForApprovedReset;
  } = {},
) {
  const cancelUnprepared =
    dependencies.cancelUnprepared ?? cancelUnpreparedKnowledgeBaseTurn;
  const failDeterministically =
    dependencies.failDeterministically ??
    failKnowledgeBaseTurnDeterministically;
  const markOutcomeUnknown =
    dependencies.markOutcomeUnknown ?? markKnowledgeBaseTurnOutcomeUnknown;
  const deferBeforeCreate =
    dependencies.deferBeforeCreate ?? deferKnowledgeBaseTurnBeforeCreate;
  const settlePreCreateFailure =
    dependencies.settlePreCreateFailure ??
    settleKnowledgeBasePreCreateFailureForApprovedReset;
  if (input.error instanceof KnowledgeBaseAttachmentsProcessingError) {
    await deferBeforeCreate({
      userId: input.userId,
      turnId: input.turnId,
      leaseToken: input.leaseToken,
      code: input.error.code,
      recoveryDelayMs: input.error.retryAfterMs,
      traceId: input.error.traceId || input.traceId,
    });
    return "retriable" as const;
  }
  if (
    input.error instanceof KnowledgeBaseTurnReservationError &&
    input.error.code === "RESET_REQUIRED"
  ) {
    const settled = await settlePreCreateFailure({
      userId: input.userId,
      turnId: input.turnId,
      leaseToken: input.leaseToken,
      code: input.error.code,
      message: input.error.message,
      failureStage: "provider_file_registration",
    });
    if (settled === null) {
      await failDeterministically({
        userId: input.userId,
        turnId: input.turnId,
        leaseToken: input.leaseToken,
        code: input.error.code,
        message: input.error.message,
        failureClass: "requires_user_fix",
        recoveryAction: "approve_reset",
        canRegenerate: false,
      });
    }
    return "deterministic" as const;
  }
  if (input.error instanceof KnowledgeBaseLocalPreparationError) {
    if (
      input.error.code === KNOWLEDGE_BASE_GENERATED_ATTACHMENT_LEDGER_CONFLICT
    ) {
      const settled = await settlePreCreateFailure({
        userId: input.userId,
        turnId: input.turnId,
        leaseToken: input.leaseToken,
        code: input.error.code,
        message: input.error.message,
        failureStage: "provider_file_registration",
      });
      if (settled === null) {
        await failDeterministically({
          userId: input.userId,
          turnId: input.turnId,
          leaseToken: input.leaseToken,
          code: input.error.code,
          message: input.error.message,
          failureClass: "requires_user_fix",
          recoveryAction: "approve_reset",
          canRegenerate: false,
        });
      }
      return "deterministic" as const;
    }
    if (input.error.code === "RESET_REQUIRED") {
      const settled = await settlePreCreateFailure({
        userId: input.userId,
        turnId: input.turnId,
        leaseToken: input.leaseToken,
        code: input.error.code,
        message: input.error.message,
        failureStage: "provider_file_registration",
      });
      if (settled === null) {
        await failDeterministically({
          userId: input.userId,
          turnId: input.turnId,
          leaseToken: input.leaseToken,
          code: input.error.code,
          message: input.error.message,
          failureClass: "requires_user_fix",
          recoveryAction: "approve_reset",
          canRegenerate: false,
        });
      }
      return "deterministic" as const;
    }
    if (isKnowledgeBaseManusV2GeneratedFileCreateRejected(input.error)) {
      // file.upload explicitly rejected this server-generated source before
      // task.create/sendMessage. The durable create_rejected row is the
      // at-most-once proof used by the next claim to switch only that small
      // Skill/instructions slot to official Manus v2 inline file_data.
      await deferBeforeCreate({
        userId: input.userId,
        turnId: input.turnId,
        leaseToken: input.leaseToken,
        code: "KNOWLEDGE_BASE_MANUS_V2_INLINE_SYSTEM_ATTACHMENT",
        recoveryDelayMs: 1_000,
        traceId: input.traceId,
      });
      return "retriable" as const;
    }
    if (input.error.code === "KNOWLEDGE_BASE_LOGO_UPLOAD_INVALID") {
      // Logo has its own first-node re-upload flow. Releasing this unbound
      // child is intentional so a new Logo byte identity gets a new provider
      // operation key without poisoning the parent presentation.
      await cancelUnprepared({
        userId: input.userId,
        turnId: input.turnId,
        leaseToken: input.leaseToken,
        code: input.error.code,
        message: `${input.error.message}。未向上游创建任务，请重新上传 Logo 原图`,
      });
    } else {
      // A fresh materialized-v5 operation has not crossed task.create. Retire
      // it atomically and expose the one supported recovery: approved reset,
      // fresh upload and a fresh task. This also clears activeTurnId so the
      // page cannot mislabel a local/provider-file failure as task stopped.
      const settled = await settlePreCreateFailure({
        userId: input.userId,
        turnId: input.turnId,
        leaseToken: input.leaseToken,
        code: input.error.code,
        message: input.error.message,
        failureStage: "provider_file_registration",
      });
      if (settled === null) {
        const attachmentRepair = /(?:CLIENT|USER)_ATTACHMENT/u.test(
          input.error.code,
        );
        await failDeterministically({
          userId: input.userId,
          turnId: input.turnId,
          leaseToken: input.leaseToken,
          code: input.error.code,
          message: `${input.error.message}。未向上游创建任务`,
          failureClass: attachmentRepair
            ? "requires_user_fix"
            : "terminal_nonregenerable",
          recoveryAction: attachmentRepair
            ? "fix_attachments"
            : "contact_support",
          canRegenerate: false,
        });
      }
    }
    return "deterministic" as const;
  }
  if (input.error instanceof UpstreamPromptBudgetError) {
    await failDeterministically({
      userId: input.userId,
      turnId: input.turnId,
      leaseToken: input.leaseToken,
      code: "KNOWLEDGE_BASE_PROMPT_BUDGET_EXCEEDED",
      message:
        "知识库系统输入超过安全预算，未向上游创建任务；请联系支持处理后继续本轮",
      failureClass: "terminal_nonregenerable",
      recoveryAction: "contact_support",
      canRegenerate: false,
    });
    return "deterministic" as const;
  }
  if (input.error instanceof KnowledgeBaseArtifactBindingError) {
    if (input.error.code === "LOGO_UPLOAD_INVALID") {
      await cancelUnprepared({
        userId: input.userId,
        turnId: input.turnId,
        leaseToken: input.leaseToken,
        code: "KNOWLEDGE_BASE_LOGO_UPLOAD_INVALID",
        message: input.error.message,
      });
      return "deterministic" as const;
    }
    await markOutcomeUnknown({
      userId: input.userId,
      turnId: input.turnId,
      leaseToken: input.leaseToken,
      code: input.error.code,
      recoveryDelayMs: input.recoveryDelayMs ?? 30_000,
    });
    return "retriable" as const;
  }
  const createError =
    input.error instanceof KnowledgeBaseUpstreamCreateError
      ? input.error
      : new KnowledgeBaseUpstreamCreateError(
          classifyKnowledgeBaseUpstreamCreateFailure({ transportError: true }),
          input.outcomeUnknownCode,
        );
  if (createError.failureClass === "deterministic") {
    await failDeterministically({
      userId: input.userId,
      turnId: input.turnId,
      leaseToken: input.leaseToken,
      code: createError.failureCode,
      message: deterministicKnowledgeBaseCreateFailureMessage(createError),
      failureClass: "terminal_nonregenerable",
      recoveryAction: knowledgeBaseCreateUserRecoveryAction(),
      canRegenerate: false,
      createAttemptRejected: true,
      reasonCategory: createError.reasonCategory,
      providerRequestRef: createError.providerRequestRef,
    });
    return "deterministic" as const;
  }
  await markOutcomeUnknown({
    userId: input.userId,
    turnId: input.turnId,
    leaseToken: input.leaseToken,
    code:
      createError.failureClass === "retriable"
        ? createError.failureCode
        : input.outcomeUnknownCode,
    traceId: createError.traceId || input.traceId,
    reasonCategory: createError.reasonCategory,
    providerRequestRef: createError.providerRequestRef,
    ...(input.recoveryDelayMs
      ? { recoveryDelayMs: input.recoveryDelayMs }
      : {}),
  });
  return createError.failureClass;
}

const KNOWLEDGE_BASE_ACCEPTED_DISPATCH_RETRY_DELAYS_MS = [
  500, 1_500, 3_000,
] as const;

function knowledgeBaseDispatchRetryable(error: unknown) {
  if (
    error instanceof KnowledgeBaseTurnReservationError ||
    error instanceof KnowledgeBaseBuildError ||
    error instanceof KnowledgeBaseArtifactBindingError
  ) {
    return false;
  }
  if (error instanceof KnowledgeBaseUpstreamCreateError) {
    // Once task.create begins, no automatic retry is safe: the provider does
    // not document Idempotency-Key for this endpoint.
    return false;
  }
  if (error instanceof KnowledgeBaseAttachmentsProcessingError) return false;
  if (axios.isAxiosError(error)) return true;
  return (
    error instanceof Error &&
    /^Task attachment (?:creation|upload|upload URL lookup) failed:/u.test(
      error.message,
    )
  );
}

/**
 * The browser request only commits the durable turn. External file/task calls
 * continue after the 202 response, with the same lease and idempotency keys.
 * Short transient failures are retried here so the normal path never depends
 * on the 30-second disaster-recovery sweep.
 */
async function dispatchAcceptedKnowledgeBaseClaim(input: {
  claim: KnowledgeBaseRecoveryClaim;
  credential: RecoveryCredential;
}) {
  return withKnowledgeBaseRecoveryLeaseHeartbeat({
    claim: input.claim,
    operation: async () => {
      let lastError: unknown;
      for (
        let attempt = 0;
        attempt <= KNOWLEDGE_BASE_ACCEPTED_DISPATCH_RETRY_DELAYS_MS.length;
        attempt += 1
      ) {
        try {
          return await dispatchKnowledgeBaseRecoveryClaim(
            input.claim,
            input.credential,
          );
        } catch (error) {
          lastError = error;
          const delayMs =
            KNOWLEDGE_BASE_ACCEPTED_DISPATCH_RETRY_DELAYS_MS[attempt];
          if (!knowledgeBaseDispatchRetryable(error) || delayMs === undefined) {
            throw error;
          }
          await new Promise((resolve) => setTimeout(resolve, delayMs));
        }
      }
      throw lastError;
    },
  });
}

function launchAcceptedKnowledgeBaseClaim(input: {
  claim: KnowledgeBaseRecoveryClaim;
  credential: RecoveryCredential;
  outcomeUnknownCode: string;
}) {
  void dispatchAcceptedKnowledgeBaseClaim(input).catch(async (error) => {
    const persisted = await persistKnowledgeBaseDispatchFailure({
      claim: input.claim,
      error,
      outcomeUnknownCode: input.outcomeUnknownCode,
      recoveryDelayMs: 1_000,
      traceId: knowledgeBaseClaimTraceId(input.claim),
    }).catch(() => undefined);
    if (
      persisted === "retriable" &&
      error instanceof KnowledgeBaseAttachmentsProcessingError
    ) {
      console.info(
        "[KnowledgeBaseAttachmentReadiness] deferred",
        JSON.stringify({
          buildId: input.claim.turn.buildId,
          turnId: input.claim.turn.id,
          ...(knowledgeBaseClaimTraceId(input.claim)
            ? { traceId: knowledgeBaseClaimTraceId(input.claim) }
            : {}),
          readyCount: error.readyCount,
          pendingCount: error.pendingCount,
          errorCount: 0,
          maxReadinessDelayMs: knowledgeBaseClaimReadinessDelayMs(input.claim),
          retryAfterMs: error.retryAfterMs,
          createAttemptState: "not_sent",
        }),
      );
      const timer = setTimeout(() => {
        void claimKnowledgeBaseTurnForRecovery({
          turnId: input.claim.turn.id,
          leaseMs: 300_000,
        })
          .then((claim) => {
            if (!claim) return;
            launchAcceptedKnowledgeBaseClaim({
              claim,
              credential: input.credential,
              outcomeUnknownCode: input.outcomeUnknownCode,
            });
          })
          .catch(() => undefined);
      }, error.retryAfterMs + 50);
      timer.unref();
    }
    logKnowledgeBaseRuntimeFailure({
      level: "warn",
      event: "[KnowledgeBaseAcceptedDispatch] deferred",
      userId: input.claim.turn.userId,
      buildId: input.claim.turn.buildId,
      turnId: input.claim.turn.id,
      error,
      additionalSecrets: [input.credential.apiKey],
    });
  });
}

/**
 * Commits the Dashboard build and logical start turn before the browser sends
 * file bytes. This endpoint deliberately performs no provider file/task call;
 * `/turn/dispatch` is the only route that may acquire a worker lease.
 */
router.post("/start/reserve", async (req, res) => {
  const body = (req.body || {}) as KnowledgeBaseStartRequest & {
    attachmentManifest?: unknown;
  };
  const conversationId = String(body.conversationId || "").trim();
  const clientRequestId = String(body.clientRequestId || "").trim();
  const requestedCompanyName = String(body.companyName || "").trim();
  const companyWebsite = String(body.companyWebsite || "").trim();
  const operatorNotes = String(body.operatorNotes || "").trim();
  const expectedResetRevision = Number(body.expectedResetRevision);
  if (
    !conversationId ||
    conversationId.length > 191 ||
    !clientRequestId ||
    clientRequestId.length > 128 ||
    !Number.isSafeInteger(expectedResetRevision) ||
    expectedResetRevision < 0
  ) {
    res.status(400).json({
      error: {
        code: "INVALID_KNOWLEDGE_BASE_START_RESERVATION",
        message: "知识库启动预约参数无效",
      },
      reservationCreated: false,
    });
    return;
  }
  if (
    !req.frontmindUser ||
    !(await requireKnowledgeBuildCapability(req.frontmindUser.id, res))
  ) {
    return;
  }
  if (!req.frontmindCredential) {
    res.status(401).json({
      error: {
        code: "CUSTOMER_KEY_REQUIRED",
        message: "请先配置 API Key",
      },
      reservationCreated: false,
    });
    return;
  }

  const requestTraceId = randomUUID();
  let reservationCreated = false;
  try {
    await assertKnowledgeBaseWritable(req.frontmindUser.id);
    const attachmentManifest =
      Array.isArray(body.attachmentManifest) &&
      body.attachmentManifest.length === 0
        ? []
        : normalizeKnowledgeBaseClientAttachmentManifest(
            body.attachmentManifest,
          );
    const workspace = await getDashboardWorkspace(req.frontmindUser.id);
    const companyName = resolveKnowledgeBaseEnterpriseIdentity({
      sourceName: workspace.sourceName,
      brandName: workspace.payload.brandName,
      requestedCompanyName,
    });
    const existingBuild = await getKnowledgeBaseProgress({
      userId: req.frontmindUser.id,
      conversationId,
    });
    if (
      existingBuild &&
      (existingBuild.build.executionMode !==
        MATERIALIZED_KNOWLEDGE_BASE_EXECUTION_MODE ||
        existingBuild.build.skillVersion !== "5")
    ) {
      res.status(409).json({
        traceId: requestTraceId,
        error: {
          code: "RESET_REQUIRED",
          message: "旧知识库构建不再续跑；请批准重置后重新上传资料",
        },
        reservationCreated: false,
      });
      return;
    }
    if (existingBuild?.build.status === "published") {
      res.status(409).json({
        traceId: requestTraceId,
        error: {
          code: "KNOWLEDGE_BASE_LOCKED",
          message: "知识库已发布；后续修改请提交维护需求",
        },
        reservationCreated: false,
      });
      return;
    }
    const newBuildPolicy = knowledgeBaseNewBuildPolicyBinding();
    const [prefillKnowledgeSnapshot, latestSkillDescriptor] = await Promise.all(
      [
        getLatestKnowledgeSnapshot(req.frontmindUser.id),
        getKnowledgeBaseSkillDescriptor({
          version: newBuildPolicy.skillVersion,
          contentHash: newBuildPolicy.skillContentHash,
        }),
      ],
    );
    const start = await reserveKnowledgeBaseStartBuild({
      userId: req.frontmindUser.id,
      conversationId,
      clientRequestId,
      companyName,
      companyWebsite,
      skillName: latestSkillDescriptor.name,
      skillVersion: latestSkillDescriptor.version,
      skillContentHash: latestSkillDescriptor.contentHash,
      skillArchiveSha256: latestSkillDescriptor.physicalSha256,
      skillArchiveBytes: latestSkillDescriptor.archiveBytes,
      skillArchiveStorageKey: latestSkillDescriptor.storageKey,
      treePolicyVersion: newBuildPolicy.treePolicyVersion,
      apiCredentialId: req.frontmindCredential.id,
      userText: "开始构建企业知识库",
      userAttachmentCount: attachmentManifest.length,
      expectedAttachmentCount:
        attachmentManifest.length + 2 + (prefillKnowledgeSnapshot ? 1 : 0),
      prefillSnapshotId: prefillKnowledgeSnapshot?.id || null,
      deferDispatchUntilAttachments: true,
      clientAttachmentManifest: attachmentManifest,
      expectedResetRevision,
      requestPayload: {
        companyName,
        companyWebsite,
        operatorNotes,
        sourceResetRevision: expectedResetRevision,
        attachments: [],
        attachmentManifest,
        skillVersion: latestSkillDescriptor.version,
        skillContentHash: latestSkillDescriptor.contentHash,
        prefillSnapshotId: prefillKnowledgeSnapshot?.id || null,
      },
      recoveryMetadata: {
        traceId: requestTraceId,
        kind: "start",
        conversationId,
        sourceResetRevision: expectedResetRevision,
        companyName,
        companyWebsite,
        operatorNotes,
        attachments: [],
        attachmentManifest,
        capturedClientAttachments: true,
        deferredClientAttachments: true,
        skillVersion: latestSkillDescriptor.version,
        skillContentHash: latestSkillDescriptor.contentHash,
        skillArchiveSha256: latestSkillDescriptor.physicalSha256,
        skillArchiveBytes: latestSkillDescriptor.archiveBytes,
        skillArchiveStorageKey: latestSkillDescriptor.storageKey,
        includePrefill: Boolean(prefillKnowledgeSnapshot),
        prefillSnapshotId: prefillKnowledgeSnapshot?.id || null,
        instructionsAttachmentRequired: true,
      },
    });
    reservationCreated = true;
    const progress = await getKnowledgeBaseProgress({
      userId: req.frontmindUser.id,
      conversationId,
    });
    const observation = await getKnowledgeBaseObservation({
      userId: req.frontmindUser.id,
      conversationId,
      upstreamStatus: "running",
    });
    res.status(start.createdBuild ? 201 : 200).json({
      traceId: start.reservation.turn.traceId || requestTraceId,
      reservation: knowledgeBaseReservationReceipt(
        start.reservation as Exclude<
          KnowledgeBaseTurnReservation,
          { state: "acquired" }
        >,
        observation?.stateEpoch,
      ),
      observation,
      progress: observation?.interaction.progress || progress,
      interaction:
        observation?.interaction ||
        deriveKnowledgeBaseInteraction(progress, "running"),
      accepted: true,
      reservationCreated: true,
      idempotent: !start.createdBuild,
      startedAt: start.reservation.turn.createdAt.getTime(),
    });
  } catch (error) {
    if (error instanceof KnowledgeBaseTurnReservationError) {
      res.status(knowledgeBaseTurnReservationErrorStatus(error)).json({
        traceId: requestTraceId,
        error: { code: error.code, message: error.message },
        reservationCreated,
      });
      return;
    }
    if (error instanceof KnowledgeBaseEnterpriseIdentityError) {
      res.status(error.code === "ENTERPRISE_NOT_CONFIGURED" ? 422 : 409).json({
        traceId: requestTraceId,
        error: { code: error.code, message: error.message },
        reservationCreated,
      });
      return;
    }
    logKnowledgeBaseRuntimeFailure({
      level: "error",
      event: "[KnowledgeBaseStartReserve] failed",
      error,
      additionalSecrets: [req.frontmindCredential?.apiKey],
    });
    res.status(503).json({
      traceId: requestTraceId,
      error: {
        code: "KNOWLEDGE_BASE_START_RESERVATION_FAILED",
        message: "启动预约失败，请稍后重试同一请求",
      },
      reservationCreated: false,
    });
  }
});

/**
 * Customer-requested release of an incomplete browser upload batch. This
 * route performs no Provider work; the service repeats every no-dispatch and
 * reset-epoch proof under locks before releasing the start operation slot.
 */
router.post("/start/cancel", async (req, res) => {
  const body = (req.body || {}) as Record<string, unknown>;
  const conversationId = String(body.conversationId || "").trim();
  const turnId = String(body.turnId || "").trim();
  const clientRequestId = String(body.clientRequestId || "").trim();
  const expectedResetRevision = Number(body.expectedResetRevision);
  if (
    !conversationId ||
    conversationId.length > 191 ||
    !turnId ||
    turnId.length > 36 ||
    !clientRequestId ||
    clientRequestId.length > 128 ||
    !Number.isSafeInteger(expectedResetRevision) ||
    expectedResetRevision < 0
  ) {
    res.status(400).json({
      error: {
        code: "INVALID_KNOWLEDGE_BASE_START_CANCELLATION",
        message: "知识库资料批次取消参数无效",
      },
    });
    return;
  }
  if (
    !req.frontmindUser ||
    !(await requireKnowledgeBuildCapability(req.frontmindUser.id, res))
  ) {
    return;
  }
  try {
    await assertKnowledgeBaseWritable(req.frontmindUser.id);
    const cancelled = await cancelIncompleteKnowledgeBaseStart({
      userId: req.frontmindUser.id,
      conversationId,
      turnId,
      clientRequestId,
      expectedResetRevision,
    });
    res.status(200).json({
      cancelled: true,
      resetRevision: cancelled.resetRevision,
      idempotent: cancelled.idempotent,
    });
  } catch (error) {
    if (error instanceof KnowledgeBaseTurnReservationError) {
      res.status(knowledgeBaseTurnReservationErrorStatus(error)).json({
        error: { code: error.code, message: error.message },
      });
      return;
    }
    throw error;
  }
});

router.post("/start/recover", (_req, res) => {
  res.status(410).json({
    error: {
      code: "RESET_REQUIRED",
      message: "请批准重置后重新上传完整资料并创建全新知识库任务",
    },
  });
});

router.post("/recovery/execute", (_req, res) => {
  res.status(410).json({
    error: {
      code: "RESET_REQUIRED",
      message: "旧恢复操作已停用；请批准重置后重新上传完整资料",
    },
  });
});

router.post("/canonical/recover-from-snapshot", (_req, res) => {
  res.status(410).json({
    error: {
      code: "RESET_REQUIRED",
      message: "旧会话快照重建已停用；请批准重置后重新上传完整资料",
    },
  });
});

router.post("/start", (_req, res) => {
  res.status(410).json({
    error: {
      code: "KNOWLEDGE_BASE_START_RESERVATION_REQUIRED",
      message: "客户端版本已更新，请刷新页面后重新开始上传",
    },
    reservationCreated: false,
  });
});

router.post("/confirm", async (req, res) => {
  const body = (req.body || {}) as {
    conversationId?: unknown;
    clientRequestId?: unknown;
    expectedGeneration?: unknown;
    expectedResetRevision?: unknown;
    expectedStateEpoch?: unknown;
    expectedRevision?: unknown;
    expectedLeafId?: unknown;
    expectedPresentationKey?: unknown;
    expectedContentVersion?: unknown;
  };
  const conversationId = String(body.conversationId || "").trim();
  const clientRequestId = String(body.clientRequestId || "").trim();
  const expectedLeafId = String(body.expectedLeafId || "").trim();
  const expectedPresentationKey = String(
    body.expectedPresentationKey || "",
  ).trim();
  const expectedGeneration = Number(body.expectedGeneration);
  const expectedStateEpoch = Number(body.expectedStateEpoch);
  const expectedRevision = Number(body.expectedRevision);
  const expectedContentVersion = Number(body.expectedContentVersion);
  const expectedResetRevision =
    body.expectedResetRevision === undefined
      ? undefined
      : Number(body.expectedResetRevision);
  if (
    !conversationId ||
    conversationId.length > 191 ||
    !clientRequestId ||
    clientRequestId.length > 128 ||
    !expectedLeafId ||
    expectedLeafId.length > 191 ||
    !expectedPresentationKey ||
    expectedPresentationKey.length > 191 ||
    !Number.isSafeInteger(expectedGeneration) ||
    expectedGeneration < 1 ||
    !Number.isSafeInteger(expectedStateEpoch) ||
    expectedStateEpoch < 0 ||
    !Number.isSafeInteger(expectedRevision) ||
    expectedRevision < 0 ||
    !Number.isSafeInteger(expectedContentVersion) ||
    expectedContentVersion < 1 ||
    (expectedResetRevision !== undefined &&
      (!Number.isSafeInteger(expectedResetRevision) ||
        expectedResetRevision < 0))
  ) {
    res.status(400).json({
      error: {
        code: "INVALID_KNOWLEDGE_BASE_CONFIRMATION",
        message: "当前知识节点确认坐标无效，请刷新后重试",
      },
    });
    return;
  }
  if (
    !req.frontmindUser ||
    !(await requireKnowledgeBuildCapability(req.frontmindUser.id, res))
  ) {
    return;
  }
  try {
    await assertKnowledgeBaseWritable(req.frontmindUser.id);
    const receipt = await confirmMaterializedKnowledgeBaseNode({
      userId: req.frontmindUser.id,
      conversationId,
      clientRequestId,
      expectedGeneration,
      expectedResetRevision,
      expectedStateEpoch,
      expectedRevision,
      expectedLeafId,
      expectedPresentationKey,
      expectedContentVersion,
    });
    const observation = await getKnowledgeBaseObservation({
      userId: req.frontmindUser.id,
      conversationId,
      upstreamStatus: "local",
    });
    res.json({ ...receipt, observation });
  } catch (error) {
    if (error instanceof KnowledgeBaseMaterializedError) {
      const status =
        error.code === "DATABASE_UNAVAILABLE"
          ? 503
          : error.code === "BUILD_NOT_FOUND"
            ? 404
            : 409;
      const observation = await getKnowledgeBaseObservation({
        userId: req.frontmindUser.id,
        conversationId,
        upstreamStatus: "local",
      }).catch(() => null);
      res.status(status).json({
        error: { code: error.code, message: error.message },
        ...(observation ? { observation } : {}),
      });
      return;
    }
    logKnowledgeBaseRuntimeFailure({
      level: "error",
      event: "[KnowledgeBaseLocalConfirm] failed",
      userId: req.frontmindUser.id,
      error,
    });
    res.status(503).json({
      error: {
        code: "KNOWLEDGE_BASE_LOCAL_CONFIRM_FAILED",
        message: "当前节点确认失败，请使用相同请求重试",
      },
    });
  }
});

router.post("/turn/reserve", async (req, res) => {
  const body = (req.body || {}) as {
    conversationId?: string;
    clientRequestId?: string;
    userMessage?: string;
    attachmentManifest?: unknown;
    resumeExisting?: boolean;
    expectedGeneration?: number;
    expectedRevision?: number;
    expectedResetRevision?: number;
    expectedLeafId?: string;
    expectedPresentationKey?: string;
  };
  const conversationId = String(body.conversationId || "").trim();
  const clientRequestId = String(body.clientRequestId || "").trim();
  const userMessage = String(body.userMessage || "").slice(0, 2_000_000);
  const expectedGeneration = body.expectedGeneration;
  const expectedRevision = body.expectedRevision;
  const expectedResetRevision = Number(body.expectedResetRevision);
  const expectedLeafId = String(body.expectedLeafId || "").trim();
  const expectedPresentationKey =
    body.expectedPresentationKey === undefined
      ? undefined
      : String(body.expectedPresentationKey || "").trim();
  if (
    !conversationId ||
    !clientRequestId ||
    clientRequestId.length > 128 ||
    !Number.isSafeInteger(expectedGeneration) ||
    Number(expectedGeneration) < 1 ||
    !Number.isSafeInteger(expectedRevision) ||
    Number(expectedRevision) < 0 ||
    !Number.isSafeInteger(expectedResetRevision) ||
    expectedResetRevision < 0 ||
    !expectedLeafId ||
    (expectedPresentationKey !== undefined &&
      (!expectedPresentationKey || expectedPresentationKey.length > 191)) ||
    (body.resumeExisting === true && Boolean(userMessage.trim()))
  ) {
    res.status(400).json({
      error: {
        code: "INVALID_KNOWLEDGE_BASE_TURN_RESERVATION",
        message: "当前知识节点或附件预约参数无效，请刷新后重试",
      },
    });
    return;
  }
  if (
    !req.frontmindUser ||
    !(await requireKnowledgeBuildCapability(req.frontmindUser.id, res))
  ) {
    return;
  }

  let replayAfterMutableFailure: (() => Promise<boolean>) | null = null;
  try {
    await assertKnowledgeBaseWritable(req.frontmindUser.id);
    const boundBuild = await requireMaterializedKnowledgeBaseBuild({
      userId: req.frontmindUser.id,
      conversationId,
    });
    const attachmentManifest = normalizeKnowledgeBaseClientAttachmentManifest(
      body.attachmentManifest,
    );
    const clientIntent = {
      schemaVersion: 1,
      flow: "deferred",
      conversationId,
      userMessage,
      attachmentManifest,
      expectedGeneration: Number(expectedGeneration),
      expectedRevision: Number(expectedRevision),
      expectedResetRevision,
      expectedLeafId,
      expectedPresentationKey: expectedPresentationKey ?? null,
    };
    const action = classifyKnowledgeBaseUserAction(
      userMessage,
      attachmentManifest.length,
    );
    if (action === "confirm") {
      res.status(409).json({
        error: {
          code: "KNOWLEDGE_BASE_CONFIRM_ENDPOINT_REQUIRED",
          message: "确认操作必须使用 Dashboard 本地确认接口",
        },
        confirmPath: "/api/knowledge-base/confirm",
      });
      return;
    }
    replayAfterMutableFailure = () =>
      respondIfKnowledgeBaseTurnReplay({
        userId: req.frontmindUser!.id,
        conversationId,
        requestedClientRequestId: clientRequestId,
        inspect: () =>
          body.resumeExisting === true
            ? inspectKnowledgeBaseLegacyDeferredReservationReplay({
                userId: req.frontmindUser!.id,
                conversationId,
                clientRequestId,
                clientAttachmentManifest: attachmentManifest,
                operationType: action === "initial" ? "revise" : action,
                expectedGeneration: Number(expectedGeneration),
                expectedRevision: Number(expectedRevision),
                expectedLeafId,
                expectedPresentationKey,
              })
            : inspectKnowledgeBaseTurnReplay({
                userId: req.frontmindUser!.id,
                conversationId,
                clientRequestId,
                clientIntent,
                expectedGeneration: Number(expectedGeneration),
                expectedRevision: Number(expectedRevision),
                expectedLeafId,
              }),
        res,
      });
    if (await replayAfterMutableFailure()) {
      return;
    }
    const deferredLogoPolicy = knowledgeBaseTurnLogoPolicy({
      providerProtocol: boundBuild.providerProtocol,
      legacyLogoRequired: knowledgeBaseBuildRequiresOfficialLogo(boundBuild),
    });
    if (deferredLogoPolicy.rejectRepeatedOfficialLogo) {
      assertKnowledgeBaseManifestDoesNotRepeatOfficialLogo(
        boundBuild,
        attachmentManifest,
      );
    }
    await assertKnowledgeBaseCustomerUploadCapacity({
      userId: req.frontmindUser.id,
      buildId: boundBuild.id,
      generation: boundBuild.generation,
      officialLogoSha256: boundBuild.logoSha256,
      officialLogoRequired: deferredLogoPolicy.requiresOfficialLogo,
      attachmentManifest,
    });
    if (
      deferredLogoPolicy.requiresOfficialLogo &&
      (attachmentManifest.length !== 1 ||
        ![
          "image/avif",
          "image/gif",
          "image/jpeg",
          "image/png",
          "image/webp",
        ].includes(attachmentManifest[0]!.mimeType))
    ) {
      throw new KnowledgeBaseTurnReservationError(
        "INVALID_REQUEST",
        "当前知识库正在等待企业主 Logo。请只上传一张 PNG、JPEG、WebP、AVIF 或 GIF 原图",
      );
    }
    const taskCredential = req.frontmindCredential;
    if (!taskCredential) {
      if (await replayAfterMutableFailure()) return;
      const observation = await getKnowledgeBaseObservation({
        userId: req.frontmindUser.id,
        conversationId,
        upstreamStatus: "running",
      }).catch(() => null);
      res.status(403).json({
        error: {
          code: "UPSTREAM_RESOURCE_FORBIDDEN",
          message: "当前知识库任务不属于此账号",
        },
        ...(observation ? { observation } : {}),
      });
      return;
    }
    const finalPackageRequired =
      boundBuild.executionMode === "materialized_bundle_v1"
        ? false
        : knowledgeBaseTurnRequiresFinalPackage({
            skillVersion: boundBuild.skillVersion,
            currentLeafId: boundBuild.currentLeafId,
            totalNodeCount: boundBuild.totalNodeCount,
            confirmedCount: boundBuild.confirmedCount,
            directPrefilledCount: boundBuild.directPrefilledCount,
            action,
          });
    if (finalPackageRequired && deferredLogoPolicy.assertFinalLogoProvenance) {
      await assertKnowledgeBaseFinalLogoProvenanceForBuild(
        req.frontmindUser.id,
        boundBuild,
      );
    }
    if (finalPackageRequired) {
      knowledgeBasePinnedV4SkillSelection({
        skillVersion: boundBuild.skillVersion,
        skillContentHash: boundBuild.skillContentHash,
      });
    }
    const skillDescriptor = {
      version: boundBuild.skillVersion,
      contentHash: boundBuild.skillContentHash,
    };
    const skillVersion = skillDescriptor.version;
    const skillContentHash = skillDescriptor.contentHash;
    const reservation = await reserveKnowledgeBaseTurn({
      userId: req.frontmindUser.id,
      buildId: boundBuild.id,
      clientRequestId,
      operationType: action === "initial" ? "revise" : action,
      expectedGeneration: Number(expectedGeneration),
      expectedRevision: Number(expectedRevision),
      expectedLeafId,
      expectedPresentationKey,
      requestPayload: {
        userMessage,
        attachmentManifest,
        expectedPresentationKey: expectedPresentationKey ?? null,
        sourceResetRevision: expectedResetRevision,
        skillVersion,
        skillContentHash,
      },
      clientIntent: body.resumeExisting === true ? undefined : clientIntent,
      apiCredentialId: taskCredential.id,
      userText: userMessage,
      userAttachmentCount: attachmentManifest.length,
      expectedAttachmentCount:
        attachmentManifest.length + (boundBuild.skillVersion === "5" ? 3 : 2),
      deferDispatchUntilAttachments: true,
      clientAttachmentManifest: attachmentManifest,
      sourceResetRevision: expectedResetRevision,
      resumeDeferredReservation: body.resumeExisting === true,
      recoveryMetadata: {
        kind: "turn",
        conversationId,
        parentTaskId: null,
        userMessage,
        attachments: [],
        attachmentManifest,
        capturedClientAttachments: true,
        deferredClientAttachments: true,
        sourceResetRevision: expectedResetRevision,
        skillVersion,
        skillContentHash,
        ...(finalPackageRequired
          ? { finalPackageRequired: true }
          : { instructionsAttachmentRequired: true }),
      },
    });
    if (reservation.state === "acquired") {
      throw new KnowledgeBaseTurnReservationError(
        "CONFLICT",
        "Deferred attachment reservation unexpectedly acquired a worker lease",
      );
    }
    await respondKnowledgeBaseTurnReplayReceipt({
      userId: req.frontmindUser.id,
      conversationId,
      requestedClientRequestId: clientRequestId,
      receipt: reservation,
      res,
    });
  } catch (caught) {
    let error = caught;
    if (replayAfterMutableFailure) {
      try {
        if (await replayAfterMutableFailure()) return;
      } catch (replayError) {
        error = replayError;
      }
    }
    if (
      await respondKnowledgeBaseLogoProvenanceError(
        error,
        req.frontmindUser?.id,
        conversationId,
        res,
      )
    )
      return;
    if (error instanceof KnowledgeBaseTurnReservationError) {
      const observation = req.frontmindUser
        ? await getKnowledgeBaseObservation({
            userId: req.frontmindUser.id,
            conversationId,
            upstreamStatus: "running",
          }).catch(() => null)
        : null;
      res.status(knowledgeBaseTurnReservationErrorStatus(error)).json({
        error: { code: error.code, message: error.message },
        ...(observation ? { observation } : {}),
      });
      return;
    }
    const observation = req.frontmindUser
      ? await getKnowledgeBaseObservation({
          userId: req.frontmindUser.id,
          conversationId,
          upstreamStatus: "running",
        }).catch(() => null)
      : null;
    res.status(503).json({
      error: {
        code: "KNOWLEDGE_BASE_TURN_RESERVATION_FAILED",
        message: "当前知识节点预约遇到服务端并发冲突，系统将继续恢复本轮",
      },
      ...(observation ? { observation } : {}),
    });
  }
});

router.post("/turn/attachments/resume", async (req, res) => {
  const body = (req.body || {}) as {
    conversationId?: string;
    turnId?: string;
    clientRequestId?: string;
    expectedResetRevision?: number;
  };
  const conversationId = String(body.conversationId || "").trim();
  const turnId = String(body.turnId || "").trim();
  const clientRequestId = String(body.clientRequestId || "").trim();
  const expectedResetRevision = Number(body.expectedResetRevision);
  if (
    !conversationId ||
    conversationId.length > 191 ||
    !turnId ||
    turnId.length > 36 ||
    !clientRequestId ||
    clientRequestId.length > 128 ||
    !Number.isSafeInteger(expectedResetRevision) ||
    expectedResetRevision < 0
  ) {
    res.status(400).json({
      error: {
        code: "INVALID_KNOWLEDGE_BASE_ATTACHMENT_RESUME",
        message: "附件恢复参数无效，请刷新后重试",
      },
    });
    return;
  }
  if (
    !req.frontmindUser ||
    !(await requireKnowledgeBuildCapability(req.frontmindUser.id, res))
  ) {
    return;
  }

  try {
    await assertKnowledgeBaseWritable(req.frontmindUser.id);
    const result = await resumeKnowledgeBaseDeferredTurnAttachments({
      userId: req.frontmindUser.id,
      projectAssignmentId:
        req.frontmindDeliveryProjectContext?.projectAssignmentId ?? null,
      conversationId,
      turnId,
      clientRequestId,
      expectedResetRevision,
    });
    const knowledgeObservation = await getKnowledgeBaseObservation({
      userId: req.frontmindUser.id,
      conversationId,
      upstreamStatus: "running",
    });
    res.json({ ...result, knowledgeObservation });
  } catch (error) {
    const knowledgeObservation = await getKnowledgeBaseObservation({
      userId: req.frontmindUser.id,
      conversationId,
      upstreamStatus: "running",
    }).catch(() => null);
    if (error instanceof KnowledgeBaseTurnReservationError) {
      res.status(knowledgeBaseTurnReservationErrorStatus(error)).json({
        error: { code: error.code, message: error.message },
        knowledgeObservation,
      });
      return;
    }
    res.status(503).json({
      error: {
        code: "KNOWLEDGE_BASE_ATTACHMENT_RESUME_FAILED",
        message: "附件恢复暂时不可用，请刷新后重试",
      },
      knowledgeObservation,
    });
  }
});

router.post("/turn/attachments/cancel", async (req, res) => {
  const body = (req.body || {}) as {
    conversationId?: string;
    turnId?: string;
    clientRequestId?: string;
    expectedResetRevision?: number;
  };
  const conversationId = String(body.conversationId || "").trim();
  const turnId = String(body.turnId || "").trim();
  const clientRequestId = String(body.clientRequestId || "").trim();
  const expectedResetRevision = Number(body.expectedResetRevision);
  if (
    !conversationId ||
    conversationId.length > 191 ||
    !turnId ||
    turnId.length > 36 ||
    !clientRequestId ||
    clientRequestId.length > 128 ||
    !Number.isSafeInteger(expectedResetRevision) ||
    expectedResetRevision < 0
  ) {
    res.status(400).json({
      error: {
        code: "INVALID_KNOWLEDGE_BASE_ATTACHMENT_CANCEL",
        message: "放弃本轮补充的参数无效，请刷新后重试",
      },
    });
    return;
  }
  if (
    !req.frontmindUser ||
    !(await requireKnowledgeBuildCapability(req.frontmindUser.id, res))
  ) {
    return;
  }

  try {
    await assertKnowledgeBaseWritable(req.frontmindUser.id);
    await cancelIncompleteKnowledgeBaseRevision({
      userId: req.frontmindUser.id,
      conversationId,
      turnId,
      clientRequestId,
      expectedResetRevision,
    });
    const knowledgeObservation = await getKnowledgeBaseObservation({
      userId: req.frontmindUser.id,
      conversationId,
      upstreamStatus: "running",
    });
    res.json({ cancelled: true, knowledgeObservation });
  } catch (error) {
    const knowledgeObservation = await getKnowledgeBaseObservation({
      userId: req.frontmindUser.id,
      conversationId,
      upstreamStatus: "running",
    }).catch(() => null);
    if (error instanceof KnowledgeBaseTurnReservationError) {
      res.status(knowledgeBaseTurnReservationErrorStatus(error)).json({
        error: { code: error.code, message: error.message },
        knowledgeObservation,
      });
      return;
    }
    res.status(503).json({
      error: {
        code: "KNOWLEDGE_BASE_ATTACHMENT_CANCEL_FAILED",
        message: "暂时无法放弃本轮补充，请刷新后重试",
      },
      knowledgeObservation,
    });
  }
});

router.post("/turn/attachments/stage", async (req, res) => {
  const body = (req.body || {}) as {
    conversationId?: string;
    turnId?: string;
    clientRequestId?: string;
    attachmentManifest?: unknown;
    index?: number;
    attachment?: KnowledgeBaseAttachment;
    expectedResetRevision?: number;
  };
  const conversationId = String(body.conversationId || "").trim();
  const turnId = String(body.turnId || "").trim();
  const clientRequestId = String(body.clientRequestId || "").trim();
  const expectedResetRevision = Number(body.expectedResetRevision);
  if (
    !conversationId ||
    !turnId ||
    !clientRequestId ||
    clientRequestId.length > 128 ||
    !Number.isSafeInteger(expectedResetRevision) ||
    expectedResetRevision < 0 ||
    !Number.isSafeInteger(body.index) ||
    Number(body.index) < 0
  ) {
    res.status(400).json({
      error: {
        code: "INVALID_KNOWLEDGE_BASE_ATTACHMENT_STAGE",
        message: "附件提交参数无效，请重新提交本轮",
      },
    });
    return;
  }
  if (
    !req.frontmindUser ||
    !(await requireKnowledgeBuildCapability(req.frontmindUser.id, res))
  ) {
    return;
  }

  let replayAfterMutableFailure: (() => Promise<boolean>) | null = null;
  try {
    await assertKnowledgeBaseWritable(req.frontmindUser.id);
    const manifest = normalizeKnowledgeBaseClientAttachmentManifest(
      body.attachmentManifest,
    );
    const index = Number(body.index);
    const attachment = normalizeKnowledgeBaseUserAttachments(
      body.attachment ? [body.attachment] : [],
    )[0];
    const manifestItem = manifest[index];
    if (
      !attachment ||
      !manifestItem ||
      !manifestItem.itemId ||
      manifestItem.ordinal !== index + 1 ||
      manifestItem.total !== manifest.length ||
      attachment.filename !== manifestItem.filename
    ) {
      throw new KnowledgeBaseTurnReservationError(
        "CONFLICT",
        "上传文件与本轮附件清单不一致",
      );
    }
    replayAfterMutableFailure = () =>
      respondIfKnowledgeBaseTurnReplay({
        userId: req.frontmindUser!.id,
        conversationId,
        requestedClientRequestId: clientRequestId,
        inspect: () =>
          inspectKnowledgeBaseDeferredAttachmentReplay({
            userId: req.frontmindUser!.id,
            conversationId,
            turnId,
            clientRequestId,
            clientAttachmentManifest: manifest,
            expectedResetRevision,
            index,
            attachment,
          }),
        res,
      });
    if (await replayAfterMutableFailure()) {
      return;
    }
    const build = await requireKnowledgeBaseDeferredAttachmentStageBuild({
      userId: req.frontmindUser.id,
      conversationId,
    });
    const projectAssignmentId =
      req.frontmindDeliveryProjectContext?.projectAssignmentId;
    // Browser submissions carry only a Dashboard localAssetId. Re-read the
    // account-owned row and its retained stream, then prove size/SHA/bytes
    // before mutating the turn. Frozen filename/MIME remain display labels,
    // not a second content gate. A Provider file lease does not exist yet.
    const localAsset = await readOwnedMaterializedKnowledgeBaseLocalAsset({
      userId: req.frontmindUser.id,
      localAssetId: attachment.file_id,
      filename: manifestItem.filename,
      mimeType: manifestItem.mimeType,
      sizeBytes: manifestItem.sizeBytes,
      sha256: manifestItem.sha256,
    });
    const stagePolicyRejection =
      await inspectKnowledgeBaseDeferredAttachmentStagePolicy({
        build,
        turnId,
        attachmentManifest: manifest,
        index,
        fileId: attachment.file_id,
        filename: manifestItem.filename,
        mimeType: manifestItem.mimeType,
        sizeBytes: manifestItem.sizeBytes,
        contentSha256: localAsset.contentSha256,
      });
    if (stagePolicyRejection) {
      if (await replayAfterMutableFailure()) return;
      await cancelUnpreparedKnowledgeBaseTurn({
        userId: req.frontmindUser.id,
        turnId,
        clientRequestId,
        code: stagePolicyRejection.code,
        message: stagePolicyRejection.message,
      });
      throw new KnowledgeBaseTurnReservationError(
        stagePolicyRejection.code,
        stagePolicyRejection.message,
      );
    }
    // Retain the verified bytes and stage the ledger while the service holds
    // the same live reset fence. This endpoint never claims or launches a
    // Provider task; `/turn/dispatch` is the sole dispatch boundary.
    const turn = await stageKnowledgeBaseDeferredTurnAttachment({
      userId: req.frontmindUser.id,
      buildId: build.id,
      turnId,
      clientRequestId,
      clientAttachmentManifest: manifest,
      expectedResetRevision,
      index,
      attachment,
      managedUploadProof: {
        intentId: `local-asset:${attachment.file_id}`,
        itemId: manifestItem.itemId,
        mimeType: manifestItem.mimeType,
        sizeBytes: manifestItem.sizeBytes,
        contentSha256: localAsset.contentSha256,
      },
      managedUploadBytes: localAsset.bytes,
      projectAssignmentId: projectAssignmentId ?? null,
    });
    const observation = await getKnowledgeBaseObservation({
      userId: req.frontmindUser.id,
      conversationId,
      upstreamStatus: "running",
    });
    res.json({
      reservation: {
        state: "awaiting_attachments",
        turnId: turn.id,
        clientRequestId: turn.clientRequestId,
        stagedAttachmentCount: turn.stagedUserAttachmentCount,
        expectedAttachmentCount: turn.expectedUserAttachmentCount,
        sourceResetRevision: turn.sourceResetRevision ?? null,
        requiresUpload:
          turn.stagedUserAttachmentCount < turn.expectedUserAttachmentCount,
      },
      observation,
    });
  } catch (caught) {
    let error = caught;
    if (replayAfterMutableFailure) {
      try {
        if (await replayAfterMutableFailure()) return;
      } catch (replayError) {
        error = replayError;
      }
    }
    if (
      await respondKnowledgeBaseLogoProvenanceError(
        error,
        req.frontmindUser?.id,
        conversationId,
        res,
      )
    )
      return;
    if (error instanceof ManagedUploadIntentError) {
      const observation = req.frontmindUser
        ? await getKnowledgeBaseObservation({
            userId: req.frontmindUser.id,
            conversationId,
            upstreamStatus: "running",
          }).catch(() => null)
        : null;
      res.status(error.statusCode).json({
        error: { code: error.code, message: error.message },
        ...(observation ? { observation } : {}),
      });
      return;
    }
    if (error instanceof KnowledgeBaseTurnReservationError) {
      const observation = await getKnowledgeBaseObservation({
        userId: req.frontmindUser.id,
        conversationId,
        upstreamStatus: "running",
      }).catch(() => null);
      if (error.retryAfterMs) {
        res.setHeader(
          "Retry-After",
          String(Math.max(1, Math.ceil(error.retryAfterMs / 1_000))),
        );
      }
      res.status(knowledgeBaseTurnReservationErrorStatus(error)).json({
        error: { code: error.code, message: error.message },
        ...(observation ? { observation } : {}),
      });
      return;
    }
    const observation = req.frontmindUser
      ? await getKnowledgeBaseObservation({
          userId: req.frontmindUser.id,
          conversationId,
          upstreamStatus: "running",
        }).catch(() => null)
      : null;
    res.status(503).json({
      error: {
        code: "KNOWLEDGE_BASE_ATTACHMENT_STAGE_FAILED",
        message: "附件提交失败，请重新提交本轮",
      },
      ...(observation ? { observation } : {}),
    });
  }
});

router.post("/turn/dispatch", async (req, res) => {
  const body = (req.body || {}) as {
    conversationId?: string;
    turnId?: string;
    clientRequestId?: string;
    attachmentManifest?: unknown;
    expectedResetRevision?: number;
  };
  const conversationId = String(body.conversationId || "").trim();
  const turnId = String(body.turnId || "").trim();
  const clientRequestId = String(body.clientRequestId || "").trim();
  const expectedResetRevision = Number(body.expectedResetRevision);
  if (
    !conversationId ||
    !turnId ||
    !clientRequestId ||
    clientRequestId.length > 128 ||
    !Number.isSafeInteger(expectedResetRevision) ||
    expectedResetRevision < 0
  ) {
    res.status(400).json({
      error: {
        code: "INVALID_KNOWLEDGE_BASE_TURN_DISPATCH",
        message: "附件提交参数无效，请重新提交本轮",
      },
    });
    return;
  }
  if (
    !req.frontmindUser ||
    !(await requireKnowledgeBuildCapability(req.frontmindUser.id, res))
  ) {
    return;
  }

  let acquiredClaim: KnowledgeBaseDeferredDispatchClaim | null = null;
  let replayAfterMutableFailure: (() => Promise<boolean>) | null = null;
  try {
    await assertKnowledgeBaseWritable(req.frontmindUser.id);
    const attachmentManifest =
      Array.isArray(body.attachmentManifest) &&
      body.attachmentManifest.length === 0
        ? []
        : normalizeKnowledgeBaseClientAttachmentManifest(
            body.attachmentManifest,
          );
    replayAfterMutableFailure = () =>
      respondIfKnowledgeBaseTurnReplay({
        userId: req.frontmindUser!.id,
        conversationId,
        requestedClientRequestId: clientRequestId,
        inspect: () =>
          inspectKnowledgeBaseDeferredDispatchReplay({
            userId: req.frontmindUser!.id,
            conversationId,
            turnId,
            clientRequestId,
            clientAttachmentManifest: attachmentManifest,
            expectedResetRevision,
          }),
        res,
      });
    if (await replayAfterMutableFailure()) {
      return;
    }
    const build = await loadKnowledgeBaseBuildRecord(
      req.frontmindUser.id,
      conversationId,
    );
    if (
      !build ||
      build.executionMode !== MATERIALIZED_KNOWLEDGE_BASE_EXECUTION_MODE ||
      build.skillVersion !== "5" ||
      build.providerProtocol !== "manus_v2"
    ) {
      throw new KnowledgeBaseTurnReservationError(
        build ? "RESET_REQUIRED" : "BUILD_NOT_FOUND",
        build
          ? "旧知识库构建不再续跑；请批准重置并重新上传资料"
          : "知识库构建不存在",
      );
    }
    const isStartReservation = Boolean(
      build &&
        build.activeTurnId === turnId &&
        build.revision === 0 &&
        build.currentLeafId === null,
    );
    // Run before claimKnowledgeBaseDeferredTurnDispatch mutates the lease. The
    // assertion is a no-op outside the final v4 coordinate.
    const dispatchLogoPolicy = knowledgeBaseTurnLogoPolicy({
      providerProtocol: build.providerProtocol,
      legacyLogoRequired:
        !isStartReservation && knowledgeBaseBuildRequiresOfficialLogo(build),
    });
    if (!isStartReservation && dispatchLogoPolicy.assertFinalLogoProvenance) {
      await assertKnowledgeBaseFinalLogoProvenanceForBuild(
        req.frontmindUser.id,
        build,
      );
    }
    const projectAssignmentId =
      req.frontmindDeliveryProjectContext?.projectAssignmentId;
    const startCredential = isStartReservation
      ? await getDecryptedCredentialForKnowledgeBaseUploadReservation({
          userId: req.frontmindUser.id,
          conversationId,
          turnId,
          projectAssignmentId: projectAssignmentId ?? null,
        })
      : null;
    const taskCredential = selectMaterializedKnowledgeBaseAttachmentCredential({
      isStartReservation,
      startCredential,
      currentCredential: req.frontmindCredential ?? null,
    });
    if (!taskCredential) {
      if (await replayAfterMutableFailure()) return;
      const observation = await getKnowledgeBaseObservation({
        userId: req.frontmindUser.id,
        conversationId,
        upstreamStatus: "running",
      }).catch(() => null);
      res.status(403).json({
        error: {
          code: "UPSTREAM_RESOURCE_FORBIDDEN",
          message: "当前知识库任务不属于此账号",
        },
        ...(observation ? { observation } : {}),
      });
      return;
    }
    acquiredClaim = await claimKnowledgeBaseDeferredTurnDispatch({
      userId: req.frontmindUser.id,
      buildId: build.id,
      turnId,
      clientRequestId,
      clientAttachmentManifest: attachmentManifest,
      expectedResetRevision,
    });
    if (acquiredClaim.state !== "acquired") {
      await respondKnowledgeBaseTurnReplayReceipt({
        userId: req.frontmindUser.id,
        conversationId,
        requestedClientRequestId: clientRequestId,
        receipt: acquiredClaim,
        res,
      });
      return;
    }

    let authoritativeAttachmentManifest: ReturnType<
      typeof normalizeKnowledgeBaseClientAttachmentManifest
    >;
    try {
      authoritativeAttachmentManifest =
        normalizeKnowledgeBaseClientAttachmentManifest(
          acquiredClaim.recoveryMetadata.attachmentManifest,
        );
    } catch {
      authoritativeAttachmentManifest = [];
    }
    if (
      authoritativeAttachmentManifest.length !== attachmentManifest.length ||
      authoritativeAttachmentManifest.some(
        (item) => !item.sha256 || !/^[a-f0-9]{64}$/u.test(item.sha256),
      )
    ) {
      const message = "客户附件的服务端完整性账本不完整，请重新上传";
      await cancelUnpreparedKnowledgeBaseTurn({
        userId: req.frontmindUser.id,
        turnId: acquiredClaim.turn.id,
        clientRequestId,
        leaseToken: acquiredClaim.leaseToken,
        code: "KNOWLEDGE_BASE_CLIENT_ATTACHMENT_INVALID",
        message,
      });
      throw new KnowledgeBaseTurnReservationError("CONFLICT", message);
    }

    const officialLogoRequired = dispatchLogoPolicy.requiresOfficialLogo;
    if (
      !officialLogoRequired &&
      knowledgeBaseManifestRepeatsOfficialLogo(
        build,
        authoritativeAttachmentManifest,
      )
    ) {
      const message =
        "该图片与已绑定的企业主 Logo 完全相同，无需作为普通补图再次上传";
      await cancelUnpreparedKnowledgeBaseTurn({
        userId: req.frontmindUser.id,
        turnId: acquiredClaim.turn.id,
        clientRequestId,
        leaseToken: acquiredClaim.leaseToken,
        code: "KNOWLEDGE_BASE_LOGO_UPLOAD_CONFLICT",
        message,
      });
      throw new KnowledgeBaseTurnReservationError(
        "KNOWLEDGE_BASE_LOGO_UPLOAD_CONFLICT",
        message,
      );
    }

    try {
      await assertKnowledgeBaseCustomerUploadCapacity({
        userId: req.frontmindUser.id,
        buildId: build.id,
        generation: acquiredClaim.turn.buildGeneration,
        officialLogoSha256: build.logoSha256,
        officialLogoRequired,
        attachmentManifest: authoritativeAttachmentManifest,
      });
    } catch (error) {
      const message =
        error instanceof Error
          ? error.message
          : "客户补充图片超过当前知识库容量，请重新选择附件";
      await cancelUnpreparedKnowledgeBaseTurn({
        userId: req.frontmindUser.id,
        turnId: acquiredClaim.turn.id,
        clientRequestId,
        leaseToken: acquiredClaim.leaseToken,
        code: "KNOWLEDGE_BASE_CUSTOMER_UPLOAD_CAPACITY_EXCEEDED",
        message,
      });
      throw error;
    }

    let acceptedClaim: KnowledgeBaseRecoveryClaim = acquiredClaim;
    if (officialLogoRequired) {
      const stagedAttachments = normalizeKnowledgeBaseUserAttachments(
        Array.isArray(acquiredClaim.recoveryMetadata.attachments)
          ? (acquiredClaim.recoveryMetadata
              .attachments as KnowledgeBaseAttachment[])
          : [],
      );
      const manifestItem = authoritativeAttachmentManifest[0];
      const attachment = stagedAttachments[0];
      if (
        authoritativeAttachmentManifest.length !== 1 ||
        stagedAttachments.length !== 1 ||
        !manifestItem ||
        !attachment
      ) {
        await cancelUnpreparedKnowledgeBaseTurn({
          userId: req.frontmindUser.id,
          turnId: acquiredClaim.turn.id,
          clientRequestId,
          leaseToken: acquiredClaim.leaseToken,
          code: "KNOWLEDGE_BASE_LOGO_UPLOAD_INVALID",
          message: "企业官方主 Logo 上传账本不完整，请重新上传",
        });
        throw new KnowledgeBaseTurnReservationError(
          "KNOWLEDGE_BASE_LOGO_UPLOAD_INVALID",
          "企业官方主 Logo 上传账本不完整，请重新上传",
        );
      }
      try {
        const verifiedLogo = await bindKnowledgeBaseOfficialLogoUpload({
          userId: req.frontmindUser.id,
          buildId: build.id,
          generation: acquiredClaim.turn.buildGeneration,
          turnId: acquiredClaim.turn.id,
          operationKey: acquiredClaim.turn.operationKey,
          expectedRevision: acquiredClaim.turn.expectedRevision,
          expectedLeafId: acquiredClaim.turn.expectedLeafId!,
          upload: {
            index: 0,
            fileId: attachment.file_id,
            filename: manifestItem.filename,
            mimeType: manifestItem.mimeType,
            sizeBytes: manifestItem.sizeBytes,
            sourceSha256: manifestItem.sha256!,
          },
        });
        logKnowledgeBaseOperationTelemetry({
          event: "logo_upload_candidate_promoted",
          buildId: build.id,
          turnId: acquiredClaim.turn.id,
        });
        acceptedClaim = {
          ...acquiredClaim,
          recoveryMetadata: {
            ...acquiredClaim.recoveryMetadata,
            officialLogoUpload: verifiedLogo,
          },
        };
      } catch (error) {
        logKnowledgeBaseOperationTelemetry({
          event: "logo_upload_candidate_rejected",
          buildId: build.id,
          turnId: acquiredClaim.turn.id,
          reasonCode:
            error instanceof KnowledgeBaseArtifactBindingError
              ? error.code
              : "LOCAL_PREPARATION_FAILED",
        });
        const message =
          error instanceof Error
            ? error.message
            : "企业官方主 Logo 校验失败，请重新上传";
        if (error instanceof KnowledgeBaseArtifactBindingError) {
          await cancelUnpreparedKnowledgeBaseTurn({
            userId: req.frontmindUser.id,
            turnId: acquiredClaim.turn.id,
            clientRequestId,
            leaseToken: acquiredClaim.leaseToken,
            code:
              error.code === "LOGO_UPLOAD_INVALID"
                ? "KNOWLEDGE_BASE_LOGO_UPLOAD_INVALID"
                : "KNOWLEDGE_BASE_LOGO_UPLOAD_CONFLICT",
            message,
          });
        }
        throw new KnowledgeBaseTurnReservationError(
          error instanceof KnowledgeBaseArtifactBindingError &&
          error.code === "LOGO_UPLOAD_INVALID"
            ? "KNOWLEDGE_BASE_LOGO_UPLOAD_INVALID"
            : "KNOWLEDGE_BASE_LOGO_UPLOAD_CONFLICT",
          message,
        );
      }
    }

    const observation = await getKnowledgeBaseObservation({
      userId: req.frontmindUser.id,
      conversationId,
      upstreamStatus: "running",
    }).catch(() => null);
    res.status(202).json({
      reservation: knowledgeBaseAcceptedReservationReceipt({
        turn: acceptedClaim.turn,
        stateEpoch: observation?.stateEpoch,
      }),
      observation,
      progress: observation?.interaction.progress || null,
      interaction:
        observation?.interaction ||
        deriveKnowledgeBaseInteraction(null, "running"),
      accepted: true,
      startedAt: acquiredClaim.turn.createdAt.getTime(),
    });
    launchAcceptedKnowledgeBaseClaim({
      claim: acceptedClaim,
      credential: taskCredential!,
      outcomeUnknownCode: "TURN_DISPATCH_OUTCOME_UNKNOWN",
    });
  } catch (caught) {
    let error = caught;
    if (replayAfterMutableFailure && !acquiredClaim) {
      try {
        if (await replayAfterMutableFailure()) return;
      } catch (replayError) {
        error = replayError;
      }
    }
    if (
      await respondKnowledgeBaseLogoProvenanceError(
        error,
        req.frontmindUser?.id,
        conversationId,
        res,
      )
    )
      return;
    if (error instanceof KnowledgeBaseTurnReservationError) {
      const observation = req.frontmindUser
        ? await getKnowledgeBaseObservation({
            userId: req.frontmindUser.id,
            conversationId,
            upstreamStatus: "running",
          }).catch(() => null)
        : null;
      res.status(knowledgeBaseTurnReservationErrorStatus(error)).json({
        error: { code: error.code, message: error.message },
        ...(observation ? { observation } : {}),
      });
      return;
    }
    const observation = req.frontmindUser
      ? await getKnowledgeBaseObservation({
          userId: req.frontmindUser.id,
          conversationId,
          upstreamStatus: "running",
        }).catch(() => null)
      : null;
    res.status(503).json({
      error: {
        code: "KNOWLEDGE_BASE_TURN_DISPATCH_FAILED",
        message: "本轮提交失败，请稍后重试",
      },
      ...(observation ? { observation } : {}),
    });
  }
});

router.post("/turn", async (req, res) => {
  const body = (req.body || {}) as {
    conversationId?: string;
    clientRequestId?: string;
    userMessage?: string;
    attachments?: KnowledgeBaseAttachment[];
    resumeLegacyAttachments?: boolean;
    attachmentManifest?: unknown;
    expectedGeneration?: number;
    expectedRevision?: number;
    expectedLeafId?: string;
    expectedPresentationKey?: string;
    submissionKind?: "message" | "logo";
  };
  const conversationId = String(body.conversationId || "").trim();
  const clientRequestId = String(body.clientRequestId || "").trim();
  const userMessage = String(body.userMessage || "").slice(0, 2_000_000);
  const expectedGeneration = body.expectedGeneration;
  const expectedRevision = body.expectedRevision;
  const expectedLeafId = String(body.expectedLeafId || "").trim();
  const expectedPresentationKey =
    body.expectedPresentationKey === undefined
      ? undefined
      : String(body.expectedPresentationKey || "").trim();
  const submissionKind = String(body.submissionKind || "message").trim();
  const manualLogoSubmission = submissionKind === "logo";
  const turnUserMessage = manualLogoSubmission
    ? KNOWLEDGE_BASE_MANUAL_LOGO_USER_INSTRUCTION
    : userMessage;
  const turnDisplayMessage = manualLogoSubmission
    ? KNOWLEDGE_BASE_MANUAL_LOGO_DISPLAY_MESSAGE
    : turnUserMessage;
  if (
    !conversationId ||
    !clientRequestId ||
    clientRequestId.length > 128 ||
    (!userMessage.trim() && !body.attachments?.length)
  ) {
    res.status(400).json({
      error: {
        code: "INVALID_KNOWLEDGE_BASE_TURN",
        message: "请输入当前节点的确认、修订或补充资料",
      },
    });
    return;
  }
  if (submissionKind !== "message" && submissionKind !== "logo") {
    res.status(400).json({
      error: {
        code: "INVALID_KNOWLEDGE_BASE_SUBMISSION_KIND",
        message: "本轮提交类型无效，请刷新后重试",
      },
    });
    return;
  }
  if (
    expectedGeneration !== undefined &&
    (!Number.isSafeInteger(expectedGeneration) || expectedGeneration < 1)
  ) {
    res.status(400).json({
      error: {
        code: "INVALID_KNOWLEDGE_BASE_GENERATION",
        message: "当前知识库代次无效，请刷新后重试",
      },
    });
    return;
  }
  if (
    expectedRevision !== undefined &&
    (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0)
  ) {
    res.status(400).json({
      error: {
        code: "INVALID_KNOWLEDGE_BASE_REVISION",
        message: "当前知识节点版本无效，请刷新后重试",
      },
    });
    return;
  }
  if (
    expectedPresentationKey !== undefined &&
    (!expectedPresentationKey || expectedPresentationKey.length > 191)
  ) {
    res.status(400).json({
      error: {
        code: "INVALID_KNOWLEDGE_BASE_PRESENTATION",
        message: "当前知识节点展示版本无效，请刷新后重试",
      },
    });
    return;
  }
  if (
    !req.frontmindUser ||
    !(await requireKnowledgeBuildCapability(req.frontmindUser.id, res))
  ) {
    return;
  }
  if (
    !body.attachments?.length &&
    isAmbiguousKnowledgeBaseAdvance(userMessage)
  ) {
    const observation = await getKnowledgeBaseObservation({
      userId: req.frontmindUser.id,
      conversationId,
      upstreamStatus: "running",
    }).catch(() => null);
    res.status(422).json({
      error: {
        code: "AMBIGUOUS_KNOWLEDGE_BASE_ACTION",
        message:
          "“继续/下一步”不会推进知识节点。请点击“确认当前内容”；如需修改，请直接输入意见或上传资料。",
      },
      ...(observation ? { observation } : {}),
    });
    return;
  }

  let replayAfterMutableFailure: (() => Promise<boolean>) | null = null;
  let reservationAcquiredByThisRequest = false;
  let acquiredManualLogoClaim: KnowledgeBaseRecoveryClaim | null = null;
  try {
    await assertKnowledgeBaseWritable(req.frontmindUser!.id);
    const boundBuild = await requireMaterializedKnowledgeBaseBuild({
      userId: req.frontmindUser!.id,
      conversationId,
    });
    if (!isMaterializedBuildPublishable(boundBuild)) {
      throw new KnowledgeBaseTurnReservationError(
        "RESET_REQUIRED",
        "当前知识库内容或研究覆盖不完整；可继续查看，但不能创建修订任务，请批准重置后重跑",
      );
    }
    const attachments = normalizeKnowledgeBaseUserAttachments(body.attachments);
    const resumeLegacyAttachments = body.resumeLegacyAttachments === true;
    const attachmentManifest = attachments.length
      ? manualLogoSubmission
        ? await serverOwnedKnowledgeBaseAttachmentManifest(attachments)
        : body.attachmentManifest === undefined
          ? undefined
          : requireKnowledgeBaseAuthoritativeAttachmentManifest(
              body.attachmentManifest,
            )
      : undefined;
    if (
      manualLogoSubmission &&
      (attachments.length !== 1 ||
        attachmentManifest?.length !== 1 ||
        !attachmentManifest[0]!.mimeType.startsWith("image/"))
    ) {
      throw new KnowledgeBaseTurnReservationError(
        "INVALID_REQUEST",
        "企业主 Logo 本轮只接受一张图片原文件，请重新选择后提交",
      );
    }
    if (
      attachmentManifest &&
      (attachmentManifest.length !== attachments.length ||
        attachmentManifest.some(
          (entry, index) => entry.filename !== attachments[index]?.filename,
        ))
    ) {
      throw new KnowledgeBaseTurnReservationError(
        "INVALID_REQUEST",
        "Attachment manifest does not match the uploaded file order",
      );
    }
    const clientIntent = {
      schemaVersion: 1,
      flow: "direct",
      ...(manualLogoSubmission ? { submissionKind: "logo" } : {}),
      conversationId,
      userMessage: turnUserMessage,
      attachments,
      attachmentManifest: attachmentManifest ?? null,
      resumeLegacyAttachments,
      expectedGeneration: expectedGeneration ?? null,
      expectedRevision: expectedRevision ?? null,
      expectedLeafId: expectedLeafId || null,
      expectedPresentationKey: expectedPresentationKey ?? null,
    };
    const action = classifyKnowledgeBaseUserAction(
      turnUserMessage,
      attachments.length,
    );
    if (action === "confirm") {
      const observation = await getKnowledgeBaseObservation({
        userId: req.frontmindUser.id,
        conversationId,
        upstreamStatus: "local",
      }).catch(() => null);
      res.status(409).json({
        error: {
          code: "KNOWLEDGE_BASE_CONFIRM_ENDPOINT_REQUIRED",
          message: "确认操作必须使用 Dashboard 本地确认接口",
        },
        confirmPath: "/api/knowledge-base/confirm",
        ...(observation ? { observation } : {}),
      });
      return;
    }
    if (manualLogoSubmission) {
      assertKnowledgeBaseExpectedGeneration({
        expectedGeneration,
        actualGeneration: boundBuild.generation,
      });
      if (
        boundBuild.status !== "confirming" ||
        !boundBuild.currentLeafId ||
        !boundBuild.currentPresentationKey ||
        boundBuild.confirmedCount !== 0 ||
        boundBuild.directPrefilledCount !== 0
      ) {
        throw new KnowledgeBaseTurnReservationError(
          "KNOWLEDGE_BASE_LOGO_UPLOAD_CONFLICT",
          "仅可在第一个知识节点待确认时提交或更换企业主 Logo，请刷新当前节点后重试",
        );
      }
      const manifestItem = attachmentManifest?.[0];
      const attachment = attachments[0];
      if (!manifestItem || !attachment) {
        throw new KnowledgeBaseTurnReservationError(
          "INVALID_REQUEST",
          "企业主 Logo 本轮只接受一张图片原文件，请重新选择后提交",
        );
      }
      const officialLogoUploadCandidate = {
        index: 0,
        fileId: attachment.file_id,
        filename: manifestItem.filename,
        mimeType: manifestItem.mimeType,
        sizeBytes: manifestItem.sizeBytes,
        sourceSha256: manifestItem.sha256,
      };
      await assertManualKnowledgeBaseLogoUploadCandidate(
        officialLogoUploadCandidate,
      );
      const local = await readOwnedMaterializedKnowledgeBaseLocalAsset({
        userId: req.frontmindUser.id,
        localAssetId: attachment.file_id,
        filename: manifestItem.filename,
        mimeType: manifestItem.mimeType,
        sizeBytes: manifestItem.sizeBytes,
        sha256: manifestItem.sha256,
      });
      const receipt = await bindMaterializedKnowledgeBaseOfficialLogoLocally({
        userId: req.frontmindUser.id,
        conversationId,
        buildId: boundBuild.id,
        clientRequestId,
        expectedGeneration: expectedGeneration ?? boundBuild.generation,
        expectedRevision: expectedRevision ?? boundBuild.revision,
        expectedLeafId: expectedLeafId || boundBuild.currentLeafId,
        expectedPresentationKey:
          expectedPresentationKey ?? boundBuild.currentPresentationKey,
        upload: {
          fileId: attachment.file_id,
          filename: manifestItem.filename,
          mimeType: manifestItem.mimeType,
          sizeBytes: manifestItem.sizeBytes,
          sourceSha256: manifestItem.sha256,
        },
        bytes: local.bytes,
      });
      const observation = await getKnowledgeBaseObservation({
        userId: req.frontmindUser.id,
        conversationId,
        upstreamStatus: "local",
      }).catch((error) => {
        // The local transaction is already authoritative. A transient
        // projection/read failure must not turn a committed Logo binding into
        // an uncertain Provider-style failure or invite a second mutation.
        logKnowledgeBaseRuntimeFailure({
          level: "warn",
          event: "[KnowledgeBaseLocalLogo] observation_deferred",
          userId: req.frontmindUser?.id,
          buildId: boundBuild.id,
          error,
        });
        return null;
      });
      res.status(200).json({ ...receipt, observation });
      return;
    }
    replayAfterMutableFailure = () =>
      respondIfKnowledgeBaseTurnReplay({
        userId: req.frontmindUser!.id,
        conversationId,
        requestedClientRequestId: clientRequestId,
        inspect: () => {
          if (!resumeLegacyAttachments) {
            return inspectKnowledgeBaseTurnReplay({
              userId: req.frontmindUser!.id,
              conversationId,
              clientRequestId,
              clientIntent,
              expectedGeneration,
              expectedRevision,
              expectedLeafId: expectedLeafId || undefined,
            });
          }
          if (
            !Number.isSafeInteger(expectedGeneration) ||
            !Number.isSafeInteger(expectedRevision) ||
            !expectedLeafId ||
            !attachmentManifest
          ) {
            return Promise.resolve(null);
          }
          return inspectKnowledgeBaseLegacyAttachmentTakeoverReplay({
            userId: req.frontmindUser!.id,
            conversationId,
            clientRequestId,
            clientAttachmentManifest: attachmentManifest,
            attachments,
            operationType: action === "initial" ? "revise" : action,
            expectedGeneration: Number(expectedGeneration),
            expectedRevision: Number(expectedRevision),
            expectedLeafId,
            expectedPresentationKey,
          });
        },
        requireUpstreamTaskId: manualLogoSubmission,
        res,
      });
    if (await replayAfterMutableFailure()) {
      return;
    }
    const directLogoPolicy = knowledgeBaseTurnLogoPolicy({
      providerProtocol: boundBuild.providerProtocol,
      manualLogoSubmission,
      legacyLogoRequired: knowledgeBaseBuildRequiresOfficialLogo(boundBuild),
    });
    assertKnowledgeBaseExpectedGeneration({
      expectedGeneration,
      actualGeneration: boundBuild.generation,
    });
    if (
      manualLogoSubmission &&
      (!["4", "5"].includes(boundBuild.skillVersion) ||
        boundBuild.status !== "confirming" ||
        !boundBuild.currentLeafId ||
        boundBuild.confirmedCount !== 0 ||
        boundBuild.directPrefilledCount !== 0)
    ) {
      throw new KnowledgeBaseTurnReservationError(
        "KNOWLEDGE_BASE_LOGO_UPLOAD_CONFLICT",
        "仅可在第一个知识节点待确认时提交或更换企业主 Logo，请刷新当前节点后重试",
      );
    }
    // Every materialized revision, including an explicit Logo replacement,
    // is a new v2 operation under the current credential. It must never
    // inherit the credential or context of a prior Provider task.
    const taskCredential = req.frontmindCredential;
    if (!taskCredential) {
      if (await replayAfterMutableFailure()) return;
      const observation = await getKnowledgeBaseObservation({
        userId: req.frontmindUser!.id,
        conversationId,
        upstreamStatus: "running",
      }).catch(() => null);
      res.status(403).json({
        error: {
          code: "UPSTREAM_RESOURCE_FORBIDDEN",
          message: "当前知识库任务不属于此账号",
        },
        ...(observation ? { observation } : {}),
      });
      return;
    }
    assertKnowledgeBaseAttachmentManifestPresent({
      skillVersion: boundBuild.skillVersion,
      attachmentCount: attachments.length,
      attachmentManifest,
    });
    const attachmentSourceProofs: Array<{
      index: number;
      fileId: string;
      filename: string;
      localAssetId: string;
      mimeType: string;
      sizeBytes: number;
      contentSha256: string;
      localStorageKey: string;
    }> = [];
    if (attachmentManifest) {
      for (let index = 0; index < attachments.length; index += 1) {
        const attachment = attachments[index]!;
        const expected = attachmentManifest[index]!;
        const local = await readOwnedMaterializedKnowledgeBaseLocalAsset({
          userId: req.frontmindUser!.id,
          localAssetId: attachment.file_id,
          filename: expected.filename,
          mimeType: expected.mimeType,
          sizeBytes: expected.sizeBytes,
          sha256: expected.sha256,
        });
        const retained = await persistKnowledgeBaseBuildSource({
          userId: req.frontmindUser!.id,
          buildId: boundBuild.id,
          generation: boundBuild.generation,
          bytes: local.bytes,
        });
        attachmentSourceProofs.push({
          index,
          fileId: attachment.file_id,
          filename: expected.filename,
          localAssetId: attachment.file_id,
          mimeType: expected.mimeType,
          sizeBytes: expected.sizeBytes,
          contentSha256: local.contentSha256,
          localStorageKey: retained.storageKey,
        });
        if (expected.mimeType.startsWith("image/")) {
          try {
            await assertCapturedKnowledgeBaseCustomerImage({
              fileId: attachment.file_id,
              filename: expected.filename,
              mimeType: expected.mimeType,
              sizeBytes: expected.sizeBytes,
              sourceSha256: expected.sha256,
            });
          } catch {
            throw new KnowledgeBaseTurnReservationError(
              "INVALID_REQUEST",
              `附件“${expected.filename}”不是可安全保留的图片，请重新选择原文件`,
            );
          }
        }
      }

      const officialLogoRequired = directLogoPolicy.requiresOfficialLogo;
      if (
        officialLogoRequired &&
        (attachments.length !== 1 ||
          attachmentManifest.length !== 1 ||
          ![
            "image/avif",
            "image/gif",
            "image/jpeg",
            "image/png",
            "image/webp",
          ].includes(attachmentManifest[0]!.mimeType))
      ) {
        throw new KnowledgeBaseTurnReservationError(
          "INVALID_REQUEST",
          "当前知识库正在等待企业主 Logo。请只上传一张 PNG、JPEG、WebP、AVIF 或 GIF 原图",
        );
      }
      assertKnowledgeBaseManifestDoesNotRepeatOfficialLogo(
        boundBuild,
        attachmentManifest,
      );
      await assertKnowledgeBaseCustomerUploadCapacity({
        userId: req.frontmindUser!.id,
        buildId: boundBuild.id,
        generation: boundBuild.generation,
        officialLogoSha256: boundBuild.logoSha256,
        officialLogoRequired,
        attachmentManifest,
      });
    }

    const officialLogoUploadCandidate:
      | Omit<KnowledgeBaseOfficialLogoUpload, "verified">
      | undefined =
      directLogoPolicy.validateManualLogoSubmission &&
      attachmentManifest?.[0] &&
      attachments[0]
        ? {
            index: 0,
            fileId: attachments[0].file_id,
            filename: attachmentManifest[0].filename,
            mimeType: attachmentManifest[0].mimeType,
            sizeBytes: attachmentManifest[0].sizeBytes,
            sourceSha256: attachmentManifest[0].sha256,
          }
        : directLogoPolicy.inferOrdinaryAttachmentAsLogo &&
            attachmentManifest?.length === 1 &&
            attachments.length === 1
          ? {
              index: 0,
              fileId: attachments[0]!.file_id,
              filename: attachmentManifest[0]!.filename,
              mimeType: attachmentManifest[0]!.mimeType,
              sizeBytes: attachmentManifest[0]!.sizeBytes,
              sourceSha256: attachmentManifest[0]!.sha256,
            }
          : undefined;
    if (directLogoPolicy.requiresOfficialLogo && !officialLogoUploadCandidate) {
      throw new KnowledgeBaseTurnReservationError(
        "INVALID_REQUEST",
        "请先上传一张合格的企业官方主 Logo，再继续确认第一个知识节点",
      );
    }
    if (
      directLogoPolicy.validateManualLogoSubmission &&
      officialLogoUploadCandidate
    ) {
      await assertManualKnowledgeBaseLogoUploadCandidate(
        officialLogoUploadCandidate,
      );
    }

    const finalPackageRequired =
      boundBuild.executionMode === "materialized_bundle_v1"
        ? false
        : knowledgeBaseTurnRequiresFinalPackage({
            skillVersion: boundBuild.skillVersion,
            currentLeafId: boundBuild.currentLeafId,
            totalNodeCount: boundBuild.totalNodeCount,
            confirmedCount: boundBuild.confirmedCount,
            directPrefilledCount: boundBuild.directPrefilledCount,
            action,
          });
    // Keep the direct path aligned with deferred reserve/stage/dispatch: a
    // final-coordinate build with missing provenance is repair-only.
    if (finalPackageRequired && directLogoPolicy.assertFinalLogoProvenance) {
      await assertKnowledgeBaseFinalLogoProvenanceForBuild(
        req.frontmindUser!.id,
        boundBuild,
      );
    }
    if (finalPackageRequired) {
      knowledgeBasePinnedV4SkillSelection({
        skillVersion: boundBuild.skillVersion,
        skillContentHash: boundBuild.skillContentHash,
      });
    }
    const currentSkillDescriptor = {
      version: boundBuild.skillVersion,
      contentHash: boundBuild.skillContentHash,
    };
    const recoveryMetadata = {
      kind: "turn",
      conversationId,
      parentTaskId: null,
      userMessage: turnUserMessage,
      attachments,
      attachmentSourceProofs,
      ...(manualLogoSubmission ? { manualLogoSubmission: true } : {}),
      skillVersion: currentSkillDescriptor.version,
      skillContentHash: currentSkillDescriptor.contentHash,
      ...(finalPackageRequired
        ? { finalPackageRequired: true }
        : { instructionsAttachmentRequired: true }),
      ...(attachmentManifest
        ? {
            attachmentManifest,
            capturedClientAttachments: true,
            ...(officialLogoUploadCandidate
              ? {
                  officialLogoUpload: {
                    ...officialLogoUploadCandidate,
                    verified: false,
                  },
                }
              : {}),
            ...(resumeLegacyAttachments
              ? { legacyUploadFirstTakeover: true }
              : {}),
          }
        : {}),
    };
    const reservation = await reserveKnowledgeBaseTurn({
      userId: req.frontmindUser!.id,
      buildId: boundBuild.id,
      clientRequestId,
      operationType: action === "initial" ? "revise" : action,
      expectedGeneration: expectedGeneration ?? boundBuild.generation,
      expectedRevision: expectedRevision ?? boundBuild.revision,
      expectedLeafId: expectedLeafId || boundBuild.currentLeafId,
      expectedPresentationKey,
      requestPayload: {
        submissionKind: manualLogoSubmission ? "logo" : "message",
        userMessage: turnUserMessage,
        attachments,
        ...(attachmentManifest ? { attachmentManifest } : {}),
        expectedPresentationKey: expectedPresentationKey ?? null,
        skillVersion: currentSkillDescriptor.version,
        skillContentHash: currentSkillDescriptor.contentHash,
      },
      clientIntent: resumeLegacyAttachments ? undefined : clientIntent,
      operationInstanceId: manualLogoSubmission ? clientRequestId : undefined,
      apiCredentialId: taskCredential.id,
      userText: turnDisplayMessage,
      userAttachmentCount: attachments.length,
      expectedAttachmentCount:
        attachments.length + (boundBuild.skillVersion === "5" ? 3 : 2),
      clientAttachmentManifest: attachmentManifest,
      resumeLegacyAttachmentTakeover: resumeLegacyAttachments,
      recoveryMetadata,
    });
    reservationAcquiredByThisRequest = reservation.state === "acquired";
    if (reservation.state !== "acquired") {
      await respondKnowledgeBaseTurnReplayReceipt({
        userId: req.frontmindUser!.id,
        conversationId,
        requestedClientRequestId: clientRequestId,
        receipt: reservation,
        requireUpstreamTaskId: manualLogoSubmission,
        res,
      });
      return;
    }
    let verifiedOfficialLogoUpload: KnowledgeBaseOfficialLogoUpload | undefined;
    if (officialLogoUploadCandidate && !manualLogoSubmission) {
      try {
        verifiedOfficialLogoUpload = await bindKnowledgeBaseOfficialLogoUpload({
          userId: req.frontmindUser!.id,
          buildId: boundBuild.id,
          generation: reservation.turn.buildGeneration,
          turnId: reservation.turn.id,
          operationKey: reservation.turn.operationKey,
          expectedRevision: reservation.turn.expectedRevision,
          expectedLeafId: reservation.turn.expectedLeafId!,
          upload: officialLogoUploadCandidate,
        });
        logKnowledgeBaseOperationTelemetry({
          event: "logo_upload_candidate_promoted",
          buildId: boundBuild.id,
          turnId: reservation.turn.id,
        });
      } catch (error) {
        logKnowledgeBaseOperationTelemetry({
          event: "logo_upload_candidate_rejected",
          buildId: boundBuild.id,
          turnId: reservation.turn.id,
          reasonCode:
            error instanceof KnowledgeBaseArtifactBindingError
              ? error.code
              : "LOCAL_PREPARATION_FAILED",
        });
        const message =
          error instanceof Error
            ? error.message
            : "企业官方主 Logo 校验失败，请重新上传";
        if (error instanceof KnowledgeBaseArtifactBindingError) {
          await cancelUnpreparedKnowledgeBaseTurn({
            userId: req.frontmindUser!.id,
            turnId: reservation.turn.id,
            clientRequestId,
            leaseToken: reservation.leaseToken,
            code:
              error.code === "LOGO_UPLOAD_INVALID"
                ? "KNOWLEDGE_BASE_LOGO_UPLOAD_INVALID"
                : "KNOWLEDGE_BASE_LOGO_UPLOAD_CONFLICT",
            message,
          });
        }
        if (
          error instanceof KnowledgeBaseArtifactBindingError &&
          error.code === "LOGO_UPLOAD_INVALID"
        ) {
          const observation = await getKnowledgeBaseObservation({
            userId: req.frontmindUser!.id,
            conversationId,
            upstreamStatus: "awaiting_input",
          }).catch(() => null);
          res.status(422).json({
            error: {
              code: "KNOWLEDGE_BASE_LOGO_UPLOAD_INVALID",
              message,
            },
            ...(observation ? { observation } : {}),
          });
          return;
        }
        if (error instanceof KnowledgeBaseArtifactBindingError) {
          throw new KnowledgeBaseTurnReservationError(
            "KNOWLEDGE_BASE_LOGO_UPLOAD_CONFLICT",
            message,
          );
        }
        throw error;
      }
    }
    const acceptedClaim: KnowledgeBaseRecoveryClaim = {
      turn: reservation.turn,
      leaseToken: reservation.leaseToken,
      leaseExpiresAt: reservation.leaseExpiresAt,
      upstreamIdempotencyKey: reservation.upstreamIdempotencyKey,
      recoveryMetadata: verifiedOfficialLogoUpload
        ? {
            ...(reservation.recoveryMetadata ?? recoveryMetadata),
            officialLogoUpload: verifiedOfficialLogoUpload,
          }
        : (reservation.recoveryMetadata ?? recoveryMetadata),
      preparedDispatch: null,
    };
    if (manualLogoSubmission) {
      acquiredManualLogoClaim = acceptedClaim;
      let dispatched: Awaited<
        ReturnType<typeof dispatchAcceptedKnowledgeBaseClaim>
      >;
      try {
        dispatched = await dispatchAcceptedKnowledgeBaseClaim({
          claim: acceptedClaim,
          credential: taskCredential,
        });
      } catch (error) {
        const terminalLogoFailure =
          knowledgeBaseManualLogoTerminalFailure(error);
        if (terminalLogoFailure) {
          let rejectionPersisted = false;
          try {
            await rejectAcknowledgedKnowledgeBaseManualLogoTurn({
              userId: acceptedClaim.turn.userId,
              buildId: acceptedClaim.turn.buildId,
              buildGeneration: acceptedClaim.turn.buildGeneration,
              turnId: acceptedClaim.turn.id,
              clientRequestId,
              leaseToken: acceptedClaim.leaseToken,
              code: terminalLogoFailure.code,
              message: terminalLogoFailure.message,
            });
            rejectionPersisted = true;
          } catch (persistenceError) {
            logKnowledgeBaseRuntimeFailure({
              level: "warn",
              event: "[KnowledgeBaseManualLogo] rejection_persistence_deferred",
              userId: acceptedClaim.turn.userId,
              buildId: acceptedClaim.turn.buildId,
              turnId: acceptedClaim.turn.id,
              error: persistenceError,
              additionalSecrets: [taskCredential.apiKey],
            });
            await markKnowledgeBaseTurnOutcomeUnknown({
              userId: acceptedClaim.turn.userId,
              turnId: acceptedClaim.turn.id,
              leaseToken: acceptedClaim.leaseToken,
              code: "MANUAL_LOGO_REJECTION_DEFERRED",
              recoveryDelayMs: 1_000,
            }).catch(() => undefined);
          }
          if (!rejectionPersisted) {
            const observation = await getKnowledgeBaseObservation({
              userId: req.frontmindUser!.id,
              conversationId,
              upstreamStatus: "running",
            }).catch(() => null);
            respondKnowledgeBaseManualLogoPending({
              observation,
              retryAfterMs: 1_000,
              res,
            });
            return;
          }
          const observation = await getKnowledgeBaseObservation({
            userId: req.frontmindUser!.id,
            conversationId,
            upstreamStatus: "awaiting_input",
          }).catch(() => null);
          res.status(terminalLogoFailure.status).json({
            error: {
              code: terminalLogoFailure.code,
              message: terminalLogoFailure.message,
            },
            ...(observation ? { observation } : {}),
          });
          return;
        }
        // If the provider acknowledged the task but post-ack Logo promotion was
        // interrupted, that real task remains the winner. Return it instead of
        // inviting a second logical submission.
        const receipt = await inspectKnowledgeBaseTurnReplay({
          userId: req.frontmindUser!.id,
          conversationId,
          clientRequestId,
          clientIntent,
          expectedGeneration,
          expectedRevision,
          expectedLeafId: expectedLeafId || undefined,
        }).catch(() => null);
        if (receipt?.state === "bound") {
          await respondKnowledgeBaseTurnReplayReceipt({
            userId: req.frontmindUser!.id,
            conversationId,
            requestedClientRequestId: clientRequestId,
            receipt,
            requireUpstreamTaskId: true,
            res,
          });
          return;
        }
        const deterministicCreateStatus =
          knowledgeBaseManualLogoDeterministicCreateFailureStatus(error);
        if (
          deterministicCreateStatus &&
          error instanceof KnowledgeBaseUpstreamCreateError
        ) {
          let rejectionPersisted = false;
          try {
            await rejectUnacknowledgedKnowledgeBaseManualLogoTurn({
              userId: acceptedClaim.turn.userId,
              buildId: acceptedClaim.turn.buildId,
              buildGeneration: acceptedClaim.turn.buildGeneration,
              turnId: acceptedClaim.turn.id,
              clientRequestId,
              leaseToken: acceptedClaim.leaseToken,
              code: error.failureCode,
              message: deterministicKnowledgeBaseCreateFailureMessage(error),
            });
            rejectionPersisted = true;
          } catch (persistenceError) {
            logKnowledgeBaseRuntimeFailure({
              level: "warn",
              event:
                "[KnowledgeBaseManualLogo] create_rejection_persistence_deferred",
              userId: acceptedClaim.turn.userId,
              buildId: acceptedClaim.turn.buildId,
              turnId: acceptedClaim.turn.id,
              error: persistenceError,
              additionalSecrets: [taskCredential.apiKey],
            });
            await markKnowledgeBaseTurnOutcomeUnknown({
              userId: acceptedClaim.turn.userId,
              turnId: acceptedClaim.turn.id,
              leaseToken: acceptedClaim.leaseToken,
              code: "MANUAL_LOGO_REJECTION_DEFERRED",
              recoveryDelayMs: 1_000,
            }).catch(() => undefined);
          }
          if (!rejectionPersisted) {
            const observation = await getKnowledgeBaseObservation({
              userId: req.frontmindUser!.id,
              conversationId,
              upstreamStatus: "running",
            }).catch(() => null);
            respondKnowledgeBaseManualLogoPending({
              observation,
              retryAfterMs: 1_000,
              res,
            });
            return;
          }
          const observation = await getKnowledgeBaseObservation({
            userId: req.frontmindUser!.id,
            conversationId,
            upstreamStatus: "awaiting_input",
          }).catch(() => null);
          res.status(deterministicCreateStatus).json({
            error: {
              code: error.failureCode,
              message: deterministicKnowledgeBaseCreateFailureMessage(error),
            },
            reservationCreated: true,
            ...(observation ? { observation } : {}),
          });
          return;
        }
        let failureClass: KnowledgeBaseUpstreamCreateFailureClass = "unknown";
        const failureToPersist =
          knowledgeBaseManualLogoCreateFailureForPersistence(error);
        try {
          failureClass = await persistKnowledgeBaseDispatchFailure({
            claim: acceptedClaim,
            error: failureToPersist,
            outcomeUnknownCode: "TURN_DISPATCH_OUTCOME_UNKNOWN",
            recoveryDelayMs: 1_000,
          });
        } catch (persistenceError) {
          logKnowledgeBaseRuntimeFailure({
            level: "warn",
            event: "[KnowledgeBaseManualLogo] failure_persistence_deferred",
            userId: acceptedClaim.turn.userId,
            buildId: acceptedClaim.turn.buildId,
            turnId: acceptedClaim.turn.id,
            error: persistenceError,
            additionalSecrets: [taskCredential.apiKey],
          });
        }
        const persistedDeterministicCreateStatus =
          failureClass === "deterministic"
            ? knowledgeBaseManualLogoDeterministicCreateFailureStatus(error)
            : null;
        if (
          persistedDeterministicCreateStatus &&
          error instanceof KnowledgeBaseUpstreamCreateError
        ) {
          const observation = await getKnowledgeBaseObservation({
            userId: req.frontmindUser!.id,
            conversationId,
            upstreamStatus: "failed",
          }).catch(() => null);
          res.status(persistedDeterministicCreateStatus).json({
            error: {
              code: error.failureCode,
              message: deterministicKnowledgeBaseCreateFailureMessage(error),
            },
            reservationCreated: true,
            ...(observation ? { observation } : {}),
          });
          return;
        }
        if (failureClass !== "deterministic") {
          const pendingReceipt = await inspectKnowledgeBaseTurnReplay({
            userId: req.frontmindUser!.id,
            conversationId,
            clientRequestId,
            clientIntent,
            expectedGeneration,
            expectedRevision,
            expectedLeafId: expectedLeafId || undefined,
          }).catch(() => null);
          if (pendingReceipt) {
            await respondKnowledgeBaseTurnReplayReceipt({
              userId: req.frontmindUser!.id,
              conversationId,
              requestedClientRequestId: clientRequestId,
              receipt: pendingReceipt,
              requireUpstreamTaskId: true,
              res,
            });
            return;
          }
          const observation = await getKnowledgeBaseObservation({
            userId: req.frontmindUser!.id,
            conversationId,
            upstreamStatus: "running",
          }).catch(() => null);
          respondKnowledgeBaseManualLogoPending({
            observation,
            retryAfterMs: 1_000,
            res,
          });
          return;
        }
        throw error;
      }
      const observation = await getKnowledgeBaseObservation({
        userId: req.frontmindUser!.id,
        conversationId,
        upstreamStatus: "running",
      }).catch(() => null);
      res.status(202).json({
        task: { id: dispatched.taskId, status: "running" },
        progress: observation?.interaction.progress || null,
        interaction:
          observation?.interaction ||
          deriveKnowledgeBaseInteraction(null, "running"),
        observation,
        accepted: true,
        startedAt: reservation.turn.createdAt.getTime(),
      });
      return;
    }
    const observation = await getKnowledgeBaseObservation({
      userId: req.frontmindUser!.id,
      conversationId,
      upstreamStatus: "running",
    }).catch(() => null);
    res.status(202).json({
      reservation: knowledgeBaseAcceptedReservationReceipt({
        turn: acceptedClaim.turn,
        stateEpoch: observation?.stateEpoch,
      }),
      progress: observation?.interaction.progress || null,
      interaction:
        observation?.interaction ||
        deriveKnowledgeBaseInteraction(null, "running"),
      observation,
      accepted: true,
      startedAt: reservation.turn.createdAt.getTime(),
    });
    launchAcceptedKnowledgeBaseClaim({
      claim: acceptedClaim,
      credential: taskCredential,
      outcomeUnknownCode: "TURN_DISPATCH_OUTCOME_UNKNOWN",
    });
  } catch (caught) {
    let error = caught;
    if (replayAfterMutableFailure && !reservationAcquiredByThisRequest) {
      try {
        if (await replayAfterMutableFailure()) return;
      } catch (replayError) {
        error = replayError;
      }
    }
    if (
      await respondKnowledgeBaseLogoProvenanceError(
        error,
        req.frontmindUser?.id,
        conversationId,
        res,
      )
    )
      return;
    if (error instanceof KnowledgeBaseTurnReservationError) {
      const observation = req.frontmindUser
        ? await getKnowledgeBaseObservation({
            userId: req.frontmindUser.id,
            conversationId,
            upstreamStatus: "running",
          }).catch(() => null)
        : null;
      if (error.retryAfterMs) {
        res.setHeader(
          "Retry-After",
          String(Math.max(1, Math.ceil(error.retryAfterMs / 1_000))),
        );
      }
      res.status(knowledgeBaseTurnReservationErrorStatus(error)).json({
        error: { code: error.code, message: error.message },
        ...(observation ? { observation } : {}),
      });
      return;
    }
    if (error instanceof KnowledgeBaseMaterializedError) {
      const observation = req.frontmindUser
        ? await getKnowledgeBaseObservation({
            userId: req.frontmindUser.id,
            conversationId,
            upstreamStatus: "local",
          }).catch(() => null)
        : null;
      const status =
        error.code === "DATABASE_UNAVAILABLE"
          ? 503
          : error.code === "BUILD_NOT_FOUND"
            ? 404
            : 409;
      res.status(status).json({
        error: { code: error.code, message: error.message },
        ...(observation ? { observation } : {}),
      });
      return;
    }
    const terminalManualLogoFailure = manualLogoSubmission
      ? knowledgeBaseManualLogoTerminalFailure(error)
      : null;
    if (terminalManualLogoFailure) {
      const observation = req.frontmindUser
        ? await getKnowledgeBaseObservation({
            userId: req.frontmindUser.id,
            conversationId,
            upstreamStatus: "awaiting_input",
          }).catch(() => null)
        : null;
      res.status(terminalManualLogoFailure.status).json({
        error: {
          code: terminalManualLogoFailure.code,
          message: terminalManualLogoFailure.message,
        },
        ...(observation ? { observation } : {}),
      });
      return;
    }
    if (error instanceof KnowledgeBaseBuildError) {
      const status = error.code === "BUILD_NOT_FOUND" ? 404 : 422;
      const observation = req.frontmindUser
        ? await getKnowledgeBaseObservation({
            userId: req.frontmindUser.id,
            conversationId,
            upstreamStatus: "running",
          }).catch(() => null)
        : null;
      res.status(status).json({
        error: { code: error.code, message: error.message },
        ...(observation ? { observation } : {}),
      });
      return;
    }
    if (manualLogoSubmission) {
      logKnowledgeBaseRuntimeFailure({
        level: "warn",
        event: reservationAcquiredByThisRequest
          ? "[KnowledgeBaseManualLogo] post_reservation_unclassified_failure"
          : "[KnowledgeBaseManualLogo] pre_reservation_unclassified_failure",
        userId: req.frontmindUser?.id,
        error,
      });
      if (reservationAcquiredByThisRequest && acquiredManualLogoClaim) {
        try {
          await markKnowledgeBaseTurnOutcomeUnknown({
            userId: acquiredManualLogoClaim.turn.userId,
            turnId: acquiredManualLogoClaim.turn.id,
            leaseToken: acquiredManualLogoClaim.leaseToken,
            code: "MANUAL_LOGO_UNCLASSIFIED_FAILURE",
            recoveryDelayMs: 1_000,
          });
        } catch (persistenceError) {
          logKnowledgeBaseRuntimeFailure({
            level: "warn",
            event:
              "[KnowledgeBaseManualLogo] unclassified_failure_persistence_deferred",
            userId: req.frontmindUser?.id,
            turnId: acquiredManualLogoClaim.turn.id,
            error: persistenceError,
          });
        }
      }
      if (reservationAcquiredByThisRequest && replayAfterMutableFailure) {
        try {
          if (await replayAfterMutableFailure()) return;
        } catch (replayError) {
          logKnowledgeBaseRuntimeFailure({
            level: "warn",
            event: "[KnowledgeBaseManualLogo] post_reservation_replay_deferred",
            userId: req.frontmindUser?.id,
            error: replayError,
          });
        }
      }
      const observation = req.frontmindUser
        ? await getKnowledgeBaseObservation({
            userId: req.frontmindUser.id,
            conversationId,
            upstreamStatus: "running",
          }).catch(() => null)
        : null;
      respondKnowledgeBaseManualLogoUnclassifiedFailure({
        reservationAcquired: reservationAcquiredByThisRequest,
        observation,
        retryAfterMs: 1_000,
        res,
      });
      return;
    }
    const observation = req.frontmindUser
      ? await getKnowledgeBaseObservation({
          userId: req.frontmindUser.id,
          conversationId,
          upstreamStatus: "running",
        }).catch(() => null)
      : null;
    res.status(503).json({
      error: {
        code: "KNOWLEDGE_BASE_TURN_FAILED",
        message: "当前知识节点提交遇到服务端异常，系统将继续核对同一轮次",
      },
      ...(observation ? { observation } : {}),
    });
  }
});

router.post("/turn/replace-attachments", (_req, res) => {
  res.status(410).json({
    error: {
      code: "RESET_REQUIRED",
      message: "旧知识库轮次不再替换附件；请批准重置并重新上传资料",
    },
  });
});

router.post("/retry", (_req, res) => {
  res.status(410).json({
    error: {
      code: "RESET_REQUIRED",
      message: "旧知识库失败轮次不再重新生成；请批准重置并重新上传资料",
    },
  });
});

router.get("/progress/:conversationId", async (req, res) => {
  try {
    const observation = await getKnowledgeBaseObservation({
      userId: req.frontmindUser!.id,
      conversationId: req.params.conversationId,
      upstreamStatus: "running",
    });
    res.json({
      progress: observation?.interaction.progress || null,
      interaction:
        observation?.interaction ||
        deriveKnowledgeBaseInteraction(null, "running"),
      observation,
    });
  } catch (error) {
    logKnowledgeBaseRuntimeFailure({
      level: "error",
      event: "[KnowledgeBaseProgress] read_failed",
      error,
    });
    res.status(503).json({
      error: {
        code: "KNOWLEDGE_BASE_PROGRESS_UNAVAILABLE",
        message: "读取知识库进度失败，请稍后重试",
      },
    });
  }
});

router.post("/progress/reconcile", async (req, res) => {
  const body = (req.body || {}) as {
    conversationId?: string;
    taskId?: string;
  };
  try {
    const conversationId = String(body.conversationId || "");
    const requestedTaskId = String(body.taskId || "");
    if (
      !req.frontmindUser ||
      !(await requireKnowledgeBuildCapability(req.frontmindUser.id, res))
    ) {
      return;
    }
    await assertKnowledgeBaseWritable(req.frontmindUser.id);
    const runtimeBuild = await requireMaterializedKnowledgeBaseBuild({
      userId: req.frontmindUser.id,
      conversationId,
    });
    const currentObservation = await getKnowledgeBaseObservation({
      userId: req.frontmindUser.id,
      conversationId,
      upstreamStatus: "running",
    });
    const immutableStatus =
      currentObservation?.interaction.progress?.build.status;
    const logoRecoveryRequired =
      currentObservation?.interaction.progress?.build.logoRequired === true;
    const recoverableArtifactNotice =
      knowledgeBaseProtocolErrorAllowsSameTaskRecovery(
        currentObservation?.notice?.code,
      );
    const recoverableOperationalNotice =
      knowledgeBaseNoticeAllowsSameTaskReconcile(currentObservation?.notice);
    const immutableProjection =
      immutableStatus === "ready_to_publish" ||
      immutableStatus === "published" ||
      (!recoverableArtifactNotice &&
        !recoverableOperationalNotice &&
        (immutableStatus === "protocol_error" || immutableStatus === "failed"));
    if (currentObservation && immutableProjection) {
      res.json({
        progress: currentObservation.interaction.progress,
        interaction: currentObservation.interaction,
        observation: currentObservation,
      });
      return;
    }
    if (
      isApprovedKnowledgeBaseAwaitingInputObservation(currentObservation) &&
      !logoRecoveryRequired
    ) {
      // The previous operation has already committed its presentation and
      // released activeTurnId. Reconcile wakes are now observation-only until
      // the customer creates the next server reservation.
      res.json({
        progress: currentObservation!.interaction.progress,
        interaction: currentObservation!.interaction,
        observation: currentObservation,
      });
      return;
    }
    const taskId = currentObservation?.authoritativeTaskId || requestedTaskId;
    if (!taskId) {
      if (currentObservation) {
        res.json({
          progress: currentObservation.interaction.progress,
          interaction: currentObservation.interaction,
          observation: currentObservation,
        });
        return;
      }
      res.status(404).json({
        error: {
          code: "KNOWLEDGE_BASE_NOT_FOUND",
          message: "当前对话没有知识库构建记录",
        },
      });
      return;
    }
    if (
      requestedTaskId &&
      currentObservation?.authoritativeTaskId &&
      requestedTaskId !== currentObservation.authoritativeTaskId
    ) {
      // A delayed poll from an older build generation is expected under tab
      // restore and network retry. Return the current authority as a no-op;
      // never turn it into a protocol error bubble.
      res.json({
        progress: currentObservation.interaction.progress,
        interaction: currentObservation.interaction,
        observation: currentObservation,
      });
      return;
    }
    const boundBuild = await assertKnowledgeBaseTaskBinding({
      userId: req.frontmindUser!.id,
      conversationId,
      taskId,
    });
    if (
      boundBuild.id !== runtimeBuild.id ||
      boundBuild.executionMode !== MATERIALIZED_KNOWLEDGE_BASE_EXECUTION_MODE ||
      boundBuild.skillVersion !== "5" ||
      boundBuild.providerProtocol !== "manus_v2"
    ) {
      throw new KnowledgeBaseBuildError(
        "RESET_REQUIRED",
        "旧知识库任务不再回读；请批准重置并重新上传资料",
      );
    }
    if (boundBuild.status === "published") {
      const observation = await getKnowledgeBaseObservation({
        userId: req.frontmindUser!.id,
        conversationId,
        upstreamStatus: "completed",
      });
      res.json({
        progress: observation?.interaction.progress || null,
        interaction:
          observation?.interaction ||
          deriveKnowledgeBaseInteraction(null, "completed"),
        observation,
      });
      return;
    }
    // Browser polling is projection-only. The launch path and the durable
    // recovery worker own the single task.create/reconcile lease; a browser
    // refresh can therefore never create, continue or repair a Provider task.
    const materializedObservation = await getKnowledgeBaseObservation({
      userId: req.frontmindUser!.id,
      conversationId,
      upstreamStatus: "running",
    });
    res.json({
      progress: materializedObservation?.interaction.progress || null,
      interaction:
        materializedObservation?.interaction ||
        deriveKnowledgeBaseInteraction(null, "running"),
      observation: materializedObservation,
    });
    return;
  } catch (error) {
    const semanticError =
      error instanceof KnowledgeBaseBuildError ||
      error instanceof KnowledgeBaseTurnReservationError;
    const status = knowledgeBaseReconcileFailureStatus(error);
    const observation =
      req.frontmindUser && String(body.conversationId || "").trim()
        ? await getKnowledgeBaseObservation({
            userId: req.frontmindUser.id,
            conversationId: String(body.conversationId || "").trim(),
            upstreamStatus: "running",
          }).catch(() => null)
        : null;
    if (!semanticError) {
      logKnowledgeBaseRuntimeFailure({
        level: "error",
        event: "[KnowledgeBaseReconcile] runtime_failed",
        error,
        additionalSecrets: [req.frontmindCredential?.apiKey],
      });
    }
    res.status(status).json({
      error: {
        code: semanticError
          ? error.code
          : "KNOWLEDGE_BASE_RECONCILE_UNAVAILABLE",
        message: semanticError
          ? error.message
          : "知识库状态同步暂时不可用，系统将继续恢复本轮",
      },
      observation,
      progress: observation?.interaction.progress || null,
      interaction: observation?.interaction || null,
    });
  }
});

export default router;
