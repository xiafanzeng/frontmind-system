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
} from "drizzle-orm";
import { Router } from "express";
import { createHash } from "node:crypto";
import {
  getFrontMindCredentials,
  getUpstreamBaseUrl,
  toUpstreamAgentProfile,
} from "./upstream-config";
import {
  credentialsUseSameUpstreamApiKey,
  getDecryptedCredentialForKnowledgeBaseReservation,
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
  assertServiceCapability,
  ServiceEntitlementError,
} from "./service-entitlement";
import type {
  KnowledgeBaseInteractionDto,
  KnowledgeBaseObservationDto,
  KnowledgeBaseProgressDto,
} from "../shared/knowledge-base-progress";
import { knowledgeBaseBuilds } from "../drizzle/schema";
import { getDb } from "./db";
import { uploadUpstreamTaskAttachment } from "./upstream-task-attachment";
import { assertKnowledgeBaseWritable } from "./knowledge-base-reset-service";
import { extractKnowledgeBaseProtocolObjects } from "../shared/knowledge-base-output";
import { collectUpstreamOutputFileIds } from "./upstream-output-resources";
import {
  classifyKnowledgeBaseUpstreamTaskStatus,
  formatKnowledgeBaseManifestEnvelope,
  formatKnowledgeBasePresentationEnvelope,
  formatKnowledgeBaseProgressEnvelope,
  KNOWLEDGE_BASE_MANIFEST_KIND,
  KNOWLEDGE_BASE_PRESENTATION_KIND,
  KNOWLEDGE_BASE_PROGRESS_KIND,
  KNOWLEDGE_BASE_PROTOCOL_V4_SCHEMA_VERSION,
} from "./knowledge-base-progress";
import {
  bindKnowledgeBaseFinalPackage,
  bindKnowledgeBaseInitialLogo,
  bindKnowledgeBaseOfficialLogoUpload,
  bindKnowledgeBaseReadyPackage,
  cleanupKnowledgeBaseStagedArtifactCandidate,
  collectKnowledgeBaseLogoDescriptors,
  KnowledgeBaseArtifactBindingError,
  type KnowledgeBaseOfficialLogoUpload,
  type KnowledgeBaseStagedArtifactCandidate,
} from "./knowledge-base-artifact-binding-service";
import { collectKnowledgeArchiveDescriptors } from "./knowledge-base-artifact";
import {
  bindKnowledgeBaseTurnUpstreamTask,
  cancelUnpreparedKnowledgeBaseTurn,
  claimKnowledgeBaseDeferredTurnDispatch,
  claimKnowledgeBaseTurnForRecovery,
  completeKnowledgeBaseGeneratedAttachment,
  findRecoverableKnowledgeBaseTurnIds,
  failKnowledgeBaseTurnDeterministically,
  findReusableKnowledgeBaseSkillFileId,
  freezeKnowledgeBaseTurnAttachments,
  markKnowledgeBaseTurnDispatching,
  markKnowledgeBaseTurnOutcomeUnknown,
  prepareKnowledgeBaseTurnDispatch,
  reserveKnowledgeBaseGeneratedAttachment,
  reserveKnowledgeBaseRetryTurn,
  reserveKnowledgeBaseStartBuild,
  reserveKnowledgeBaseTurn,
  renewKnowledgeBaseTurnLease,
  stageAndClaimKnowledgeBaseDeferredTurnAttachment,
  stageKnowledgeBaseTurnAttachments,
  KnowledgeBaseTurnReservationError,
  type KnowledgeBasePreparedDispatch,
  type KnowledgeBaseRecoveryClaim,
  type KnowledgeBaseDeferredDispatchClaim,
  type KnowledgeBaseTurnReservation,
} from "./knowledge-base-turn-service";
import {
  claimKnowledgeBaseOpenRecoveryBuild,
  releaseKnowledgeBaseOpenRecoveryLease,
  renewKnowledgeBaseOpenRecoveryLease,
  type KnowledgeBaseOpenRecoveryClaim,
} from "./knowledge-base-open-recovery-lease";
import {
  MAX_KNOWLEDGE_BASE_CUSTOMER_UPLOAD_IMAGES,
  assertCapturedKnowledgeBaseCustomerImage,
  declaredKnowledgeBaseCustomerUploadsForBuild,
} from "./knowledge-base-customer-upload";
import { readStoredPresalesFile } from "./presales-file-store";
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
  getKnowledgeBaseSkillDescriptor,
  loadKnowledgeBaseSkillArchive as loadSkillArchive,
  KNOWLEDGE_BASE_SKILL_ATTACHMENT_FILENAME,
  readKnowledgeBaseSkillArchiveAttachment,
} from "./knowledge-base-skill-runtime";
import {
  buildKnowledgeBasePrefillEvidenceArchive,
  buildKnowledgeBasePrompt,
  KnowledgeBaseEnterpriseIdentityError,
  KNOWLEDGE_BASE_PREFILL_ATTACHMENT_FILENAME,
  resolveKnowledgeBaseEnterpriseIdentity,
} from "./knowledge-base-prompt-contract";

export * from "./knowledge-base-client-attachment-manifest";
export * from "./knowledge-base-turn-coordinates";
export * from "./knowledge-base-runtime-log";
export * from "./knowledge-base-prompt-contract";
export {
  getKnowledgeBaseSkillDescriptor,
  KNOWLEDGE_BASE_SKILL_ATTACHMENT_FILENAME,
  readKnowledgeBaseSkillArchiveAttachment,
} from "./knowledge-base-skill-runtime";

const router = Router();

async function recordKnowledgeBaseOutputFiles(input: {
  userId: number;
  apiCredentialId: string;
  output: unknown;
}) {
  for (const fileId of collectUpstreamOutputFileIds(input.output)) {
    const registration = {
      userId: input.userId,
      apiCredentialId: input.apiCredentialId,
      kind: "file" as const,
      upstreamId: fileId,
    };
    let lastError: unknown;
    let recorded = false;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        await recordUpstreamResource(registration);
        recorded = true;
        break;
      } catch (error) {
        lastError = error;
        if (attempt < 2) {
          await new Promise((resolve) =>
            setTimeout(resolve, 50 * 2 ** attempt),
          );
        }
      }
    }
    if (recorded) continue;

    // The upstream task has already been created. Do not turn a metadata
    // registration fault into a duplicate billable task on client retry.
    logKnowledgeBaseRuntimeFailure({
      level: "error",
      event: "[KnowledgeBaseOutputResource] registration_pending",
      userId: input.userId,
      error: lastError,
    });
    const retryTimer = setTimeout(() => {
      void recordUpstreamResource(registration).catch((error) => {
        logKnowledgeBaseRuntimeFailure({
          level: "error",
          event: "[KnowledgeBaseOutputResource] retry_failed",
          userId: input.userId,
          error,
        });
      });
    }, 1_000);
    retryTimer.unref?.();
  }
}

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
}

async function loadKnowledgeBaseBuildRecord(
  userId: number,
  conversationId: string,
) {
  const db = await getDb();
  if (!db) throw new Error("数据库暂不可用");
  return (
    await db
      .select()
      .from(knowledgeBaseBuilds)
      .where(
        and(
          eq(knowledgeBaseBuilds.userId, userId),
          eq(knowledgeBaseBuilds.conversationId, conversationId),
        ),
      )
      .limit(1)
  )[0];
}

function reservationRetryAfterMs(reservation: KnowledgeBaseTurnReservation) {
  return reservation.state === "pending" ? reservation.retryAfterMs : 1_000;
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
  const knownStatuses = new Set([
    "created",
    "queued",
    "pending",
    "running",
    "in_progress",
    "awaiting_input",
    "awaiting_user",
    "awaiting_user_input",
    "waiting",
    "paused",
    "requires_action",
    "input_required",
    "completed",
    "complete",
    "succeeded",
    "success",
    "done",
    "finished",
    "error",
    "failed",
    "errored",
    "cancelled",
    "canceled",
  ]);
  const alert = (kind: string, metadata: Record<string, unknown>) => {
    const key = `${progress?.build.id || "unbound"}:${kind}:${normalized}`;
    if ((knowledgeInteractionAlertAt.get(key) || 0) > now - 10 * 60_000) {
      return;
    }
    knowledgeInteractionAlertAt.set(key, now);
    console.warn(
      `[KnowledgeBaseInteraction] ${kind}`,
      JSON.stringify(metadata),
    );
  };
  if (!knownStatuses.has(normalized)) {
    alert("unknown_upstream_status", {
      buildId: progress?.build.id || null,
      upstreamPhase: "unknown",
    });
  }
  const awaitingSince = progress?.build.awaitingResponseSince;
  if (
    typeof awaitingSince === "number" &&
    now - awaitingSince > 2 * 60 * 60_000
  ) {
    alert("execution_timeout", {
      buildId: progress?.build.id || null,
      // Provider-controlled status strings can contain arbitrary response
      // fragments. Keep alerts within the explicit status allowlist.
      upstreamStatus: knownStatuses.has(normalized) ? normalized : "unknown",
      waitMs: now - awaitingSince,
    });
  }
  if (knowledgeInteractionAlertAt.size > 1_000) {
    const expiry = now - 60 * 60_000;
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
      lockReason: "知识库已发布；后续修改请提交维护工单",
    };
  }
  if (
    progress?.packageAllowed &&
    progress.build.status === "ready_to_publish"
  ) {
    return {
      progress,
      interactionState: "ready_to_publish",
      canReply: false,
      canPublish: true,
      lockReason: "知识库已完成，请执行唯一一次直接更新",
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
      presentation.revision === progress.build.revision &&
      presentation.leafId === progress.build.currentLeafId,
  );
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
  if (
    interaction.interactionState === "awaiting_input" &&
    (!observation.approvedPresentation ||
      observation.approvedPresentation.revision !== progress.build.revision ||
      observation.approvedPresentation.leafId !==
        progress.build.currentLeafId ||
      (progress.build.skillVersion === "4" &&
        progress.build.revision === 0 &&
        progress.summary.handled === 0 &&
        progress.build.logoRequired !== true &&
        (observation.approvedPresentation.imageState !== "attached" ||
          observation.approvedPresentation.resources.filter(
            (resource) => resource.kind === "logo",
          ).length !== 1)))
  ) {
    interaction = {
      progress,
      interactionState: "executing",
      canReply: false,
      canPublish: false,
      lockReason: "当前知识节点正在完成服务端展示校验",
    };
  }
  return {
    ...observation,
    interaction,
  };
}

async function observeKnowledgeBaseUpstreamFailure(input: {
  userId: number;
  conversationId: string;
  taskId: string;
  code: string;
  message: string;
  status?: "protocol_error" | "failed";
}) {
  await observeKnowledgeBaseProtocolFailure({
    userId: input.userId,
    conversationId: input.conversationId,
    observationKey: createHash("sha256")
      .update(
        JSON.stringify({
          taskId: input.taskId,
          code: input.code,
          status: input.status || "protocol_error",
        }),
        "utf8",
      )
      .digest("hex"),
    message: input.message,
    code: input.code,
    status: input.status,
    taskId: input.taskId,
  });
  const observation = await getKnowledgeBaseObservation({
    userId: input.userId,
    conversationId: input.conversationId,
    upstreamStatus: "running",
  });
  return {
    observation,
    durable:
      observation?.interaction.progress?.build.status === "protocol_error" ||
      observation?.interaction.progress?.build.status === "failed",
  };
}

/**
 * Historical v3 could attach three visuals. Never guess which response
 * attachment was the Logo; its final ZIP manifest identifies the unique
 * brand_identity/badge and binds those bytes instead.
 */
export function shouldBindKnowledgeBaseInitialLogo(
  skillVersion: string,
  descriptorCount: number,
) {
  return descriptorCount > 0 && skillVersion !== "3";
}

function knowledgeBaseBuildRequiresOfficialLogo(build: {
  skillVersion: string;
  status: string;
  revision: number;
  currentLeafId: string | null;
  totalNodeCount: number;
  confirmedCount: number;
  directPrefilledCount: number;
  logoSha256: string | null;
}) {
  return (
    build.skillVersion === "4" &&
    build.status === "confirming" &&
    build.revision === 0 &&
    Boolean(build.currentLeafId) &&
    build.totalNodeCount > 0 &&
    build.confirmedCount === 0 &&
    build.directPrefilledCount === 0 &&
    !build.logoSha256
  );
}

function knowledgeBaseManifestRepeatsOfficialLogo(
  build: { logoSha256: string | null },
  manifest: readonly KnowledgeBaseClientAttachmentManifestItem[],
) {
  const logoSha256 = String(build.logoSha256 || "")
    .trim()
    .toLowerCase();
  return Boolean(
    logoSha256 && manifest.some((item) => item.sha256 === logoSha256),
  );
}

function assertKnowledgeBaseManifestDoesNotRepeatOfficialLogo(
  build: { logoSha256: string | null },
  manifest: readonly KnowledgeBaseClientAttachmentManifestItem[],
) {
  if (knowledgeBaseManifestRepeatsOfficialLogo(build, manifest)) {
    throw new KnowledgeBaseTurnReservationError(
      "INVALID_REQUEST",
      "该图片与已绑定的企业主 Logo 完全相同，无需作为普通补图再次上传",
    );
  }
}

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
    logo?: KnowledgeBaseStagedArtifactCandidate;
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
          const logoDescriptors =
            collectKnowledgeBaseLogoDescriptors(unreconciled);
          if (
            boundBuild.skillVersion === "4"
              ? boundBuild.totalNodeCount === 0 && logoDescriptors.length > 0
              : shouldBindKnowledgeBaseInitialLogo(
                  boundBuild.skillVersion,
                  logoDescriptors.length,
                )
          ) {
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
            await observeKnowledgeBaseProtocolFailure({
              userId: input.userId,
              conversationId: input.conversationId,
              taskId: input.taskId,
              observationKey,
              message: "知识库资源校验未通过，本轮内容尚未更新",
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

export function classifyKnowledgeBaseOpenRecoveryFailure(
  status:
    | "researching"
    | "confirming"
    | "ready_to_publish"
    | "published"
    | "protocol_error"
    | "failed",
  protocolErrorCode?: string | null,
) {
  return status === "ready_to_publish" ||
    (status === "protocol_error" &&
      protocolErrorCode === "PACKAGE_REBIND_REQUIRED")
    ? ("package_rebind_required" as const)
    : ("fatal" as const);
}

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

export class KnowledgeBaseOpenRecoveryLeaseError extends Error {
  readonly code = "KNOWLEDGE_BASE_OPEN_RECOVERY_LEASE_LOST";

  constructor(
    message = "Knowledge-base open recovery lease was lost",
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "KnowledgeBaseOpenRecoveryLeaseError";
  }
}

export async function withKnowledgeBaseOpenRecoveryLeaseHeartbeat<T>(input: {
  claim: KnowledgeBaseOpenRecoveryClaim;
  leaseMs: number;
  operation: () => Promise<T>;
  /** Test seam; production always uses the database-backed renewer. */
  renewLease?: typeof renewKnowledgeBaseOpenRecoveryLease;
}) {
  const renewLease = input.renewLease ?? renewKnowledgeBaseOpenRecoveryLease;
  let renewalTail: Promise<void> = Promise.resolve();
  let leaseFailure: KnowledgeBaseOpenRecoveryLeaseError | null = null;
  const recordLeaseFailure = (error: unknown) => {
    if (leaseFailure) return;
    leaseFailure =
      error instanceof KnowledgeBaseOpenRecoveryLeaseError
        ? error
        : new KnowledgeBaseOpenRecoveryLeaseError(
            "Knowledge-base open recovery lease renewal failed",
            { cause: error },
          );
  };
  const renew = () => {
    if (leaseFailure) return;
    // Attach the rejection handler in the same turn in which the renewal is
    // scheduled. A database/network rejection must never sit unobserved while
    // a long artifact operation is still running.
    renewalTail = renewalTail
      .then(async () => {
        if (leaseFailure) return;
        const renewed = await renewLease({
          buildId: input.claim.build.id,
          generation: input.claim.build.generation,
          leaseToken: input.claim.leaseToken,
          leaseMs: input.leaseMs,
        });
        if (!renewed) {
          throw new KnowledgeBaseOpenRecoveryLeaseError();
        }
      })
      .catch(recordLeaseFailure);
  };
  const timer = setInterval(
    renew,
    Math.max(250, Math.min(60_000, Math.trunc(input.leaseMs / 3))),
  );
  timer.unref();
  let result!: T;
  let operationFailed = false;
  let operationFailure: unknown;
  try {
    result = await input.operation();
  } catch (error) {
    operationFailed = true;
    operationFailure = error;
  } finally {
    clearInterval(timer);
    // The tail is rejection-safe by construction. Awaiting it also closes the
    // final tick that may already have been queued when the timer was cleared.
    await renewalTail;
  }
  if (leaseFailure) {
    throw leaseFailure;
  }
  if (operationFailed) throw operationFailure;
  return result;
}

export async function recoverOpenKnowledgeBaseTasks(options?: {
  limit?: number;
  concurrency?: number;
  afterBuildId?: string;
  leaseMs?: number;
}) {
  const db = await getDb();
  if (!db) {
    return {
      scanned: 0,
      claimed: 0,
      reconciled: 0,
      skipped: 0,
      failed: 0,
      packageRebindRequired: 0,
      nextCursor: null,
      hasMore: false,
    };
  }
  const limit = Math.min(500, Math.max(1, Math.trunc(options?.limit ?? 100)));
  const concurrency = Math.min(
    8,
    Math.max(1, Math.trunc(options?.concurrency ?? 3)),
  );
  const scanNow = new Date();
  const builds = await db
    .select({
      id: knowledgeBaseBuilds.id,
      userId: knowledgeBaseBuilds.userId,
      conversationId: knowledgeBaseBuilds.conversationId,
      status: knowledgeBaseBuilds.status,
      generation: knowledgeBaseBuilds.generation,
      stateEpoch: knowledgeBaseBuilds.stateEpoch,
      protocolErrorCode: knowledgeBaseBuilds.protocolErrorCode,
      upstreamTaskId: knowledgeBaseBuilds.upstreamTaskId,
      lastOutputLength: knowledgeBaseBuilds.lastOutputLength,
      lastOutputItemIds: knowledgeBaseBuilds.lastOutputItemIds,
    })
    .from(knowledgeBaseBuilds)
    .where(
      and(
        isNotNull(knowledgeBaseBuilds.upstreamTaskId),
        isNull(knowledgeBaseBuilds.activeTurnId),
        or(
          isNull(knowledgeBaseBuilds.recoveryLeaseExpiresAt),
          lte(knowledgeBaseBuilds.recoveryLeaseExpiresAt, scanNow),
        ),
        or(
          and(
            inArray(knowledgeBaseBuilds.status, ["researching", "confirming"]),
            or(
              eq(knowledgeBaseBuilds.status, "researching"),
              isNotNull(knowledgeBaseBuilds.awaitingResponseSince),
            ),
          ),
          and(
            eq(knowledgeBaseBuilds.status, "ready_to_publish"),
            isNull(knowledgeBaseBuilds.packageStorageKey),
          ),
          and(
            eq(knowledgeBaseBuilds.status, "protocol_error"),
            eq(
              knowledgeBaseBuilds.protocolErrorCode,
              "PACKAGE_REBIND_REQUIRED",
            ),
            isNull(knowledgeBaseBuilds.packageStorageKey),
          ),
        ),
        options?.afterBuildId
          ? gt(knowledgeBaseBuilds.id, options.afterBuildId)
          : undefined,
      ),
    )
    .orderBy(asc(knowledgeBaseBuilds.id))
    .limit(limit);

  const result = {
    scanned: builds.length,
    claimed: 0,
    reconciled: 0,
    skipped: 0,
    failed: 0,
    packageRebindRequired: 0,
    nextCursor: builds.length ? builds[builds.length - 1]!.id : null,
    hasMore: builds.length === limit,
  };
  let cursor = 0;
  const baseUrl = getUpstreamBaseUrl();
  const worker = async () => {
    while (cursor < builds.length) {
      const candidate = builds[cursor++];
      let claim: KnowledgeBaseOpenRecoveryClaim | null = null;
      let taskId = String(candidate.upstreamTaskId || "");
      let deferToPackageRebind = false;
      let recoveryApiKey: string | undefined;
      try {
        claim = await claimKnowledgeBaseOpenRecoveryBuild({
          buildId: candidate.id,
          expectedGeneration: candidate.generation,
          expectedStateEpoch: candidate.stateEpoch,
          expectedTaskId: taskId,
          leaseMs: options?.leaseMs,
        });
        if (!claim) {
          result.skipped += 1;
          continue;
        }
        result.claimed += 1;
        const build = claim.build;
        taskId = String(build.upstreamTaskId || "");
        deferToPackageRebind = claim.kind === "package_rebind";
        await withKnowledgeBaseOpenRecoveryLeaseHeartbeat({
          claim,
          leaseMs: options?.leaseMs ?? 300_000,
          operation: async () => {
            await assertKnowledgeBaseWritable(build.userId);
            const credential = await getCredentialForUpstreamResource(
              build.userId,
              "task",
              taskId,
            );
            if (!credential) {
              if (deferToPackageRebind) result.packageRebindRequired += 1;
              else result.skipped += 1;
              logKnowledgeBaseRuntimeFailure({
                level: "warn",
                event: deferToPackageRebind
                  ? "[KnowledgeBaseRecovery] package_rebind_credential_unavailable"
                  : "[KnowledgeBaseRecovery] credential_unavailable",
                buildId: build.id,
                taskId,
                error: null,
              });
              return;
            }
            recoveryApiKey = credential.apiKey;
            const taskResponse = await axios.get(
              `${baseUrl}/v1/tasks/${encodeURIComponent(taskId)}`,
              {
                headers: {
                  API_KEY: credential.apiKey,
                  Authorization: `Bearer ${credential.apiKey}`,
                },
                timeout: 120000,
                validateStatus: () => true,
              },
            );
            if (taskResponse.status < 200 || taskResponse.status >= 300) {
              if (deferToPackageRebind) result.packageRebindRequired += 1;
              else result.failed += 1;
              logKnowledgeBaseRuntimeFailure({
                level: "warn",
                event: deferToPackageRebind
                  ? "[KnowledgeBaseRecovery] package_rebind_task_unavailable"
                  : "[KnowledgeBaseRecovery] task_read_failed",
                buildId: build.id,
                taskId,
                error: { status: taskResponse.status },
                additionalSecrets: [credential.apiKey],
              });
              return;
            }
            const taskData = canonicalKnowledgeBaseUpstreamTask(
              taskResponse.data,
            );
            const output = normalizeRecoveredTaskOutput(taskData);
            await recordKnowledgeBaseOutputFiles({
              userId: build.userId,
              apiCredentialId: credential.id,
              output,
            });
            const taskStatus = normalizedUpstreamTaskStatus(taskData.status);
            if (!shouldReconcileKnowledgeOutput(output, taskStatus)) {
              observeKnowledgeInteraction(
                await getKnowledgeBaseProgress({
                  userId: build.userId,
                  conversationId: build.conversationId,
                }),
                taskStatus,
              );
              if (deferToPackageRebind) result.packageRebindRequired += 1;
              else result.skipped += 1;
              return;
            }
            await reconcileAvailableKnowledgeOutput({
              userId: build.userId,
              conversationId: build.conversationId,
              taskId,
              output,
              upstreamStatus: taskStatus,
              ledger: {
                lastOutputLength: build.lastOutputLength,
                lastOutputItemIds: build.lastOutputItemIds,
              },
              artifactAccess: { apiKey: credential.apiKey, baseUrl },
            });
            result.reconciled += 1;
          },
        });
      } catch (error) {
        if (deferToPackageRebind) result.packageRebindRequired += 1;
        else result.failed += 1;
        logKnowledgeBaseRuntimeFailure({
          level: "warn",
          event: deferToPackageRebind
            ? "[KnowledgeBaseRecovery] package_rebind_reconcile_failed"
            : "[KnowledgeBaseRecovery] reconcile_failed",
          buildId: candidate.id,
          taskId,
          error,
          additionalSecrets: [recoveryApiKey],
        });
      } finally {
        if (claim) {
          await releaseKnowledgeBaseOpenRecoveryLease({
            buildId: claim.build.id,
            generation: claim.build.generation,
            leaseToken: claim.leaseToken,
          }).catch((error) => {
            logKnowledgeBaseRuntimeFailure({
              level: "warn",
              event: "[KnowledgeBaseRecovery] lease_release_failed",
              buildId: claim!.build.id,
              taskId,
              error,
            });
          });
        }
      }
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(concurrency, builds.length) }, worker),
  );
  return result;
}

function recoveryString(
  metadata: Record<string, unknown>,
  key: string,
  fallback = "",
) {
  const value = metadata[key];
  return typeof value === "string" ? value : fallback;
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
  const direct = knowledgeBaseUpstreamRecord(value) || {};
  return knowledgeBaseUpstreamRecord(direct.task) || direct;
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

async function loadKnowledgeBaseBuildRecordById(
  userId: number,
  buildId: string,
) {
  const db = await getDb();
  if (!db) throw new Error("数据库暂不可用");
  return (
    await db
      .select()
      .from(knowledgeBaseBuilds)
      .where(
        and(
          eq(knowledgeBaseBuilds.id, buildId),
          eq(knowledgeBaseBuilds.userId, userId),
        ),
      )
      .limit(1)
  )[0];
}

type RecoveryCredential = NonNullable<
  Awaited<ReturnType<typeof getDecryptedCredentialForKnowledgeBaseReservation>>
>;

async function uploadRecoverySkill(input: {
  claim: KnowledgeBaseRecoveryClaim;
  credential: RecoveryCredential;
  baseUrl: string;
  skillVersion: string;
  skillContentHash: string | null;
  stagedPrefix?: string[];
}) {
  await renewKnowledgeBaseTurnLease({
    userId: input.claim.turn.userId,
    turnId: input.claim.turn.id,
    leaseToken: input.claim.leaseToken,
  });
  const skillArchive = await readKnowledgeBaseSkillArchiveAttachment({
    version: input.skillVersion,
    contentHash: input.skillContentHash,
  });
  const reusableUpstreamFileId = await findReusableKnowledgeBaseSkillFileId({
    userId: input.claim.turn.userId,
    buildId: input.claim.turn.buildId!,
    apiCredentialId: input.credential.id,
    contentSha256: createHash("sha256")
      .update(skillArchive.bytes)
      .digest("hex"),
  }).catch(() => null);
  const uploaded = await uploadKnowledgeBaseSkillArchive({
    baseUrl: input.baseUrl,
    apiKey: input.credential.apiKey,
    skillVersion: input.skillVersion,
    skillContentHash: input.skillContentHash,
    reusableUpstreamFileId,
    durable: {
      userId: input.claim.turn.userId,
      turnId: input.claim.turn.id,
      leaseToken: input.claim.leaseToken,
      attachmentIndex: input.stagedPrefix?.length ?? 0,
    },
  });
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
  await recordUpstreamResource({
    userId: input.claim.turn.userId,
    apiCredentialId: input.credential.id,
    kind: "file",
    upstreamId: uploaded.fileId,
  });
  return uploaded;
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
  if (input.claim.preparedDispatch) return input.claim.preparedDispatch;
  const { claim, credential } = input;
  const recovery = claim.recoveryMetadata;
  const kind = recoveryString(recovery, "kind");
  const conversationId = recoveryString(recovery, "conversationId");
  const skillVersion = recoveryString(recovery, "skillVersion", "4");
  const skillContentHash = recoveryString(recovery, "skillContentHash") || null;
  const userAttachments = normalizeKnowledgeBaseUserAttachments(
    Array.isArray(recovery.attachments)
      ? (recovery.attachments as KnowledgeBaseAttachment[])
      : [],
  );
  const retryAttachments = normalizeKnowledgeBaseUserAttachments(
    Array.isArray(recovery.retryAttachments)
      ? (recovery.retryAttachments as KnowledgeBaseAttachment[])
      : [],
  );
  const baseUrl =
    recoveryString(recovery, "retryBaseUrl") || getUpstreamBaseUrl();
  const agentProfile =
    recoveryString(recovery, "retryAgentProfile") ||
    toUpstreamAgentProfile(KNOWLEDGE_BASE_AGENT_PROFILE);
  const stagedIds = [...claim.turn.attachmentFileIds];

  if (kind === "turn") {
    const parentTaskId =
      recoveryString(recovery, "retryParentTaskId") ||
      recoveryString(recovery, "parentTaskId");
    const userMessage = recoveryString(recovery, "userMessage");
    const attachmentManifest = Array.isArray(recovery.attachmentManifest)
      ? normalizeKnowledgeBaseClientAttachmentManifest(
          recovery.attachmentManifest,
        )
      : undefined;
    let officialLogoUpload = recoveryOfficialLogoUpload(recovery);
    if (!conversationId || !parentTaskId) {
      throw new Error("Turn recovery metadata is incomplete");
    }
    if (!officialLogoUpload) {
      const recoveryBuild = await loadKnowledgeBaseBuildRecord(
        claim.turn.userId,
        conversationId,
      );
      if (
        recoveryBuild?.id === claim.turn.buildId &&
        recoveryBuild.generation === claim.turn.buildGeneration &&
        knowledgeBaseBuildRequiresOfficialLogo(recoveryBuild)
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
        claim.recoveryMetadata = {
          ...claim.recoveryMetadata,
          officialLogoUpload,
        };
      }
    }
    const deferredClientAttachments =
      recovery.deferredClientAttachments === true;
    const stagedUserIds = userAttachments.map(
      (attachment) => attachment.file_id,
    );
    if (
      deferredClientAttachments &&
      (stagedIds.length < stagedUserIds.length ||
        stagedUserIds.some((fileId, index) => stagedIds[index] !== fileId) ||
        stagedIds.length > stagedUserIds.length + 1)
    ) {
      throw new Error("Deferred turn attachment ledger is inconsistent");
    }
    let skillId = deferredClientAttachments
      ? stagedIds[stagedUserIds.length]
      : stagedIds[0];
    if (!skillId) {
      const uploaded = await uploadRecoverySkill({
        claim,
        credential,
        baseUrl,
        skillVersion,
        skillContentHash,
        stagedPrefix: deferredClientAttachments ? stagedUserIds : [],
      });
      skillId = uploaded.fileId;
    } else {
      await recordUpstreamResource({
        userId: claim.turn.userId,
        apiCredentialId: credential.id,
        kind: "file",
        upstreamId: skillId,
      });
    }
    const attachments =
      retryAttachments.length > 0
        ? retryAttachments
        : deferredClientAttachments
          ? [
              ...userAttachments,
              {
                file_id: skillId,
                filename: KNOWLEDGE_BASE_SKILL_ATTACHMENT_FILENAME,
              },
            ]
          : [
              {
                file_id: skillId,
                filename: KNOWLEDGE_BASE_SKILL_ATTACHMENT_FILENAME,
              },
              ...userAttachments,
            ];
    await freezeKnowledgeBaseTurnAttachments({
      userId: claim.turn.userId,
      turnId: claim.turn.id,
      leaseToken: claim.leaseToken,
      attachmentFileIds: attachments.map((attachment) => attachment.file_id),
    });
    const prompt = await buildKnowledgeBaseTurnPrompt({
      userId: claim.turn.userId,
      conversationId,
      userMessage,
      attachments: userAttachments,
      attachmentManifest,
      skillVersion,
      skillContentHash,
      officialLogoUpload,
      protocolOperation: {
        operationId: claim.turn.operationKey,
        turnId: claim.turn.id,
      },
    });
    const prepared = await prepareKnowledgeBaseTurnDispatch({
      userId: claim.turn.userId,
      turnId: claim.turn.id,
      leaseToken: claim.leaseToken,
      baseUrl,
      prompt,
      agentProfile,
      attachments,
      parentTaskId,
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
  const operatorNotes = recoveryString(recovery, "operatorNotes");
  const prefillSnapshotId = recoveryString(recovery, "prefillSnapshotId");
  const includePrefill = Boolean(recovery.includePrefill);
  const prefillKnowledgeSnapshot = prefillSnapshotId
    ? await getKnowledgeSnapshotById({
        userId: claim.turn.userId,
        snapshotId: prefillSnapshotId,
      })
    : null;
  if (includePrefill && !prefillKnowledgeSnapshot) {
    throw new Error("Pinned knowledge-base prefill snapshot is unavailable");
  }

  let skillId = stagedIds[0];
  if (!skillId) {
    const uploaded = await uploadRecoverySkill({
      claim,
      credential,
      baseUrl,
      skillVersion,
      skillContentHash,
    });
    skillId = uploaded.fileId;
  } else {
    await recordUpstreamResource({
      userId: claim.turn.userId,
      apiCredentialId: credential.id,
      kind: "file",
      upstreamId: skillId,
    });
  }
  const generatedAttachments = [
    { file_id: skillId, filename: KNOWLEDGE_BASE_SKILL_ATTACHMENT_FILENAME },
  ];
  if (includePrefill) {
    let prefillFileId = stagedIds[1];
    if (!prefillFileId) {
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
        durable: {
          userId: claim.turn.userId,
          turnId: claim.turn.id,
          leaseToken: claim.leaseToken,
          attachmentIndex: 1,
          role: "prefill",
        },
      });
      prefillFileId = uploaded.fileId;
      await renewKnowledgeBaseTurnLease({
        userId: claim.turn.userId,
        turnId: claim.turn.id,
        leaseToken: claim.leaseToken,
      });
      await stageKnowledgeBaseTurnAttachments({
        userId: claim.turn.userId,
        turnId: claim.turn.id,
        leaseToken: claim.leaseToken,
        attachmentFileIds: [skillId, prefillFileId],
      });
    }
    await recordUpstreamResource({
      userId: claim.turn.userId,
      apiCredentialId: credential.id,
      kind: "file",
      upstreamId: prefillFileId,
    });
    generatedAttachments.push({
      file_id: prefillFileId,
      filename: KNOWLEDGE_BASE_PREFILL_ATTACHMENT_FILENAME,
    });
  }
  const attachments =
    retryAttachments.length > 0
      ? retryAttachments
      : [...generatedAttachments, ...userAttachments];
  await freezeKnowledgeBaseTurnAttachments({
    userId: claim.turn.userId,
    turnId: claim.turn.id,
    leaseToken: claim.leaseToken,
    attachmentFileIds: attachments.map((attachment) => attachment.file_id),
  });
  const prompt = await buildKnowledgeBasePrompt({
    conversationId,
    companyName,
    companyWebsite,
    operatorNotes,
    attachments: userAttachments,
    prefillKnowledgeSnapshot,
    protocolOperation: {
      skillVersion,
      operationId: claim.turn.operationKey,
      turnId: claim.turn.id,
    },
  });
  const prepared = await prepareKnowledgeBaseTurnDispatch({
    userId: claim.turn.userId,
    turnId: claim.turn.id,
    leaseToken: claim.leaseToken,
    baseUrl,
    prompt,
    agentProfile,
    attachments,
  });
  claim.preparedDispatch = prepared;
  return prepared;
}

async function reconcileRecoveredKnowledgeBaseTask(input: {
  claim: KnowledgeBaseRecoveryClaim;
  credential: RecoveryCredential;
  taskId: string;
  taskData?: Record<string, unknown>;
}) {
  const { claim, credential, taskId } = input;
  await recordUpstreamResource({
    userId: claim.turn.userId,
    apiCredentialId: credential.id,
    kind: "task",
    upstreamId: taskId,
  });
  const baseUrl = claim.preparedDispatch?.baseUrl || getUpstreamBaseUrl();
  let taskData = input.taskData;
  if (!taskData) {
    const response = await axios.get(
      `${baseUrl}/v1/tasks/${encodeURIComponent(taskId)}`,
      {
        headers: {
          API_KEY: credential.apiKey,
          Authorization: `Bearer ${credential.apiKey}`,
        },
        timeout: 120_000,
        validateStatus: () => true,
      },
    );
    if (response.status < 200 || response.status >= 300) {
      throw new Error(`Recovered task read failed (${response.status})`);
    }
    taskData = canonicalKnowledgeBaseUpstreamTask(response.data);
  }
  const build = await loadKnowledgeBaseBuildRecordById(
    claim.turn.userId,
    claim.turn.buildId,
  );
  if (!build || build.generation !== claim.turn.buildGeneration) return false;
  const output = normalizeRecoveredTaskOutput(taskData);
  await recordKnowledgeBaseOutputFiles({
    userId: claim.turn.userId,
    apiCredentialId: credential.id,
    output,
  });
  const status = normalizedUpstreamTaskStatus(taskData.status);
  if (!shouldReconcileKnowledgeOutput(output, status)) return false;
  await reconcileAvailableKnowledgeOutput({
    userId: claim.turn.userId,
    conversationId: build.conversationId,
    taskId,
    output,
    upstreamStatus: status,
    ledger: {
      lastOutputLength: build.lastOutputLength,
      lastOutputItemIds: build.lastOutputItemIds,
    },
    artifactAccess: { apiKey: credential.apiKey, baseUrl },
  });
  return true;
}

export async function recoverKnowledgeBaseTurnClaimTask(input: {
  claim: KnowledgeBaseRecoveryClaim;
  ensureDispatch: () => Promise<KnowledgeBasePreparedDispatch>;
  createTask: (
    dispatch: KnowledgeBasePreparedDispatch,
    idempotencyKey: string,
  ) => Promise<{ taskId: string; taskData?: Record<string, unknown> }>;
  bindTask: (taskId: string) => Promise<void>;
  registerTask: (taskId: string) => Promise<void>;
  reconcileTask: (
    taskId: string,
    taskData?: Record<string, unknown>,
  ) => Promise<boolean>;
}) {
  let taskId = input.claim.turn.upstreamTaskId;
  let taskData: Record<string, unknown> | undefined;
  let rebound = false;
  if (!taskId) {
    const dispatch = await input.ensureDispatch();
    const created = await input.createTask(
      dispatch,
      input.claim.upstreamIdempotencyKey,
    );
    taskId = created.taskId;
    taskData = created.taskData;
    await input.bindTask(taskId);
    rebound = true;
  }
  // This intentionally runs for both newly-bound and already-bound turns. A
  // crash between bind and ownership registration is repaired here without a
  // second upstream create.
  await input.registerTask(taskId);
  const reconciled = await input.reconcileTask(taskId, taskData);
  return { taskId, rebound, reconciled };
}

async function dispatchKnowledgeBaseRecoveryClaim(
  claim: KnowledgeBaseRecoveryClaim,
  credential: RecoveryCredential,
) {
  return recoverKnowledgeBaseTurnClaimTask({
    claim,
    ensureDispatch: () =>
      ensureKnowledgeBaseRecoveryDispatch({ claim, credential }),
    createTask: async (prepared, idempotencyKey) => {
      await markKnowledgeBaseTurnDispatching({
        userId: claim.turn.userId,
        turnId: claim.turn.id,
        leaseToken: claim.leaseToken,
        leaseMs: 300_000,
      });
      const created = await createFrontMindTask({
        baseUrl: prepared.baseUrl,
        apiKey: credential.apiKey,
        requestBody: prepared.requestBody,
        idempotencyKey,
      });
      if (!created.ok) {
        throw knowledgeBaseUpstreamCreateError(created);
      }
      return {
        taskId: String(created.task.id),
        taskData: created.task as unknown as Record<string, unknown>,
      };
    },
    bindTask: async (taskId) => {
      await bindKnowledgeBaseTurnUpstreamTask({
        userId: claim.turn.userId,
        turnId: claim.turn.id,
        leaseToken: claim.leaseToken,
        upstreamTaskId: taskId,
      });
    },
    registerTask: async (taskId) => {
      await recordUpstreamResource({
        userId: claim.turn.userId,
        apiCredentialId: credential.id,
        kind: "task",
        upstreamId: taskId,
      });
    },
    reconcileTask: (taskId, taskData) =>
      reconcileRecoveredKnowledgeBaseTask({
        claim,
        credential,
        taskId,
        taskData,
      }),
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
  const candidates = await findRecoverableKnowledgeBaseTurnIds({ limit });
  const result = {
    scanned: candidates.length,
    claimed: 0,
    claimedTurnIds: [] as string[],
    rebound: 0,
    reconciled: 0,
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
        if (!ownedClaim.turn.apiCredentialId) {
          throw new Error("Turn reservation has no credential binding");
        }
        const credential =
          await getDecryptedCredentialForKnowledgeBaseReservation({
            userId: ownedClaim.turn.userId,
            turnId: ownedClaim.turn.id,
            buildId: ownedClaim.turn.buildId!,
            buildGeneration: ownedClaim.turn.buildGeneration!,
            apiCredentialId: ownedClaim.turn.apiCredentialId,
          });
        if (!credential) {
          throw new Error("Reserved credential version is unavailable");
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
        if (claim) {
          await persistKnowledgeBaseCreateFailure({
            userId: claim.turn.userId,
            turnId: claim.turn.id,
            leaseToken: claim.leaseToken,
            error,
            outcomeUnknownCode: "RECOVERY_DEFERRED",
          }).catch(() => undefined);
        }
        logKnowledgeBaseRuntimeFailure({
          level: "warn",
          event: "[KnowledgeBaseTurnRecovery] deferred",
          turnId: candidate.turnId,
          buildId: candidate.buildId,
          error,
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

export const KNOWLEDGE_BASE_AGENT_PROFILE = "frontmind-pro" as const;
export const KNOWLEDGE_BASE_UPSTREAM_CREATE_TIMEOUT_MS = 120_000;

export type KnowledgeBaseUpstreamCreateFailureClass =
  | "deterministic"
  | "retriable"
  | "unknown";

/**
 * Only failures which might have been accepted by the provider stay in the
 * idempotent recovery loop. All other HTTP responses prove that the request
 * was rejected and can be settled immediately as a retryable application
 * failure.
 */
export function classifyKnowledgeBaseUpstreamCreateFailure(input: {
  status?: unknown;
  missingTaskId?: boolean;
  transportError?: boolean;
}): KnowledgeBaseUpstreamCreateFailureClass {
  if (input.missingTaskId) return "deterministic";
  if (input.transportError) return "unknown";
  const status = Number(input.status);
  if (!Number.isInteger(status) || status <= 0) return "unknown";
  return status === 408 || status === 429 || status >= 500
    ? "retriable"
    : "deterministic";
}

export class KnowledgeBaseUpstreamCreateError extends Error {
  constructor(
    public readonly failureClass: KnowledgeBaseUpstreamCreateFailureClass,
    public readonly failureCode: string,
    public readonly status?: number,
  ) {
    super("Knowledge-base upstream task creation failed");
    this.name = "KnowledgeBaseUpstreamCreateError";
  }
}

type DurableKnowledgeBaseGeneratedAttachment = {
  userId: number;
  turnId: string;
  leaseToken: string;
  attachmentIndex: number;
  role: "skill" | "prefill";
};

async function uploadDurableKnowledgeBaseGeneratedAttachment(input: {
  baseUrl: string;
  apiKey: string;
  filename: string;
  bytes: Buffer;
  mimeType?: string;
  reusableUpstreamFileId?: string | null;
  durable: DurableKnowledgeBaseGeneratedAttachment;
}) {
  const mimeType = input.mimeType || "application/zip";
  const reservation = await reserveKnowledgeBaseGeneratedAttachment({
    userId: input.durable.userId,
    turnId: input.durable.turnId,
    leaseToken: input.durable.leaseToken,
    role: input.durable.role,
    attachmentIndex: input.durable.attachmentIndex,
    filename: input.filename,
    mimeType,
    sizeBytes: input.bytes.length,
    contentSha256: createHash("sha256").update(input.bytes).digest("hex"),
  });
  const reusableUpstreamFileId = String(
    input.reusableUpstreamFileId || "",
  ).trim();
  if (
    reusableUpstreamFileId &&
    (!reservation.upstreamFileId ||
      reservation.upstreamFileId === reusableUpstreamFileId)
  ) {
    if (!reservation.upstreamFileId) {
      await completeKnowledgeBaseGeneratedAttachment({
        userId: input.durable.userId,
        turnId: input.durable.turnId,
        leaseToken: input.durable.leaseToken,
        role: input.durable.role,
        attachmentIndex: input.durable.attachmentIndex,
        requestHash: reservation.requestHash,
        upstreamFileId: reusableUpstreamFileId,
      });
    }
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
  return uploadUpstreamTaskAttachment({
    baseUrl: input.baseUrl,
    apiKey: input.apiKey,
    filename: input.filename,
    bytes: input.bytes,
    mimeType,
    idempotencyKey: reservation.idempotencyKey,
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
}

export async function uploadKnowledgeBaseSkillArchive({
  baseUrl,
  apiKey,
  skillVersion = "4",
  skillContentHash,
  reusableUpstreamFileId,
  durable,
}: {
  baseUrl: string;
  apiKey: string;
  skillVersion?: string;
  skillContentHash?: string | null;
  reusableUpstreamFileId?: string | null;
  durable?: Omit<DurableKnowledgeBaseGeneratedAttachment, "role">;
}) {
  const archive = await readKnowledgeBaseSkillArchiveAttachment({
    version: skillVersion,
    contentHash: skillContentHash,
  });
  const uploaded = durable
    ? await uploadDurableKnowledgeBaseGeneratedAttachment({
        baseUrl,
        apiKey,
        filename: archive.filename,
        bytes: archive.bytes,
        reusableUpstreamFileId,
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
  attachments,
  taskId: existingTaskId,
  idempotencyKey,
  requestBody,
}: {
  baseUrl: string;
  apiKey: string;
  prompt?: string;
  attachments?: Array<{ file_id: string; filename: string }>;
  taskId?: string;
  idempotencyKey?: string;
  /** Exact credential-free body persisted before the first POST. */
  requestBody?: KnowledgeBasePreparedDispatch["requestBody"];
}) {
  const body =
    requestBody ||
    ({
      prompt: String(prompt || ""),
      agentProfile: toUpstreamAgentProfile(KNOWLEDGE_BASE_AGENT_PROFILE),
      taskMode: "agent",
      attachments: attachments || [],
      ...(existingTaskId ? { taskId: existingTaskId } : {}),
    } satisfies KnowledgeBasePreparedDispatch["requestBody"]);
  const taskResponse = await axios.post(`${baseUrl}/v1/tasks`, body, {
    headers: {
      "Content-Type": "application/json",
      API_KEY: apiKey,
      Authorization: `Bearer ${apiKey}`,
      ...(idempotencyKey ? { "Idempotency-Key": idempotencyKey } : {}),
    },
    timeout: KNOWLEDGE_BASE_UPSTREAM_CREATE_TIMEOUT_MS,
    validateStatus: () => true,
  });

  if (taskResponse.status < 200 || taskResponse.status >= 300) {
    const detail =
      taskResponse.data?.error?.message ||
      taskResponse.data?.message ||
      `Create task failed (${taskResponse.status})`;
    return {
      ok: false as const,
      status: taskResponse.status,
      detail,
      failureClass: classifyKnowledgeBaseUpstreamCreateFailure({
        status: taskResponse.status,
      }),
      failureCode: `UPSTREAM_CREATE_HTTP_${taskResponse.status}`,
    };
  }

  const taskData = canonicalKnowledgeBaseUpstreamTask(taskResponse.data);
  const taskId = knowledgeBaseUpstreamString(
    taskData.id ?? taskData.task_id,
    255,
  );
  if (!taskId) {
    return {
      ok: false as const,
      status: 502,
      detail: "Create task failed: missing task id",
      failureClass: "deterministic" as const,
      failureCode: "UPSTREAM_TASK_ID_MISSING" as const,
    };
  }

  const taskMetadata = knowledgeBaseUpstreamRecord(taskData.metadata) || {};
  const rawStatus = knowledgeBaseUpstreamString(taskData.status, 64);
  return {
    ok: true as const,
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
  };
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
  );
}

function deterministicKnowledgeBaseCreateFailureMessage(
  error: KnowledgeBaseUpstreamCreateError,
) {
  if (error.failureCode === "UPSTREAM_TASK_ID_MISSING") {
    return "上游未返回可识别的任务编号，本轮未创建；请重试本轮";
  }
  if (error.status === 401 || error.status === 403) {
    return "上游拒绝了当前 API 凭证，请更新凭证后重试本轮";
  }
  if (error.status === 413) {
    return "本轮附件超过上游限制，请减少或压缩附件后重试本轮";
  }
  return "上游已明确拒绝创建本轮任务，当前内容和附件均已保留；请重试本轮";
}

async function persistKnowledgeBaseCreateFailure(input: {
  userId: number;
  turnId: string;
  leaseToken: string;
  error: unknown;
  outcomeUnknownCode: string;
  recoveryDelayMs?: number;
}) {
  if (input.error instanceof KnowledgeBaseArtifactBindingError) {
    if (input.error.code === "LOGO_UPLOAD_INVALID") {
      await cancelUnpreparedKnowledgeBaseTurn({
        userId: input.userId,
        turnId: input.turnId,
        leaseToken: input.leaseToken,
        code: "KNOWLEDGE_BASE_LOGO_UPLOAD_INVALID",
        message: input.error.message,
      });
      return "deterministic" as const;
    }
    await markKnowledgeBaseTurnOutcomeUnknown({
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
    await failKnowledgeBaseTurnDeterministically({
      userId: input.userId,
      turnId: input.turnId,
      leaseToken: input.leaseToken,
      code: createError.failureCode,
      message: deterministicKnowledgeBaseCreateFailureMessage(createError),
    });
    return "deterministic" as const;
  }
  await markKnowledgeBaseTurnOutcomeUnknown({
    userId: input.userId,
    turnId: input.turnId,
    leaseToken: input.leaseToken,
    code:
      createError.failureClass === "retriable"
        ? createError.failureCode
        : input.outcomeUnknownCode,
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
    return error.failureClass !== "deterministic";
  }
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
    await persistKnowledgeBaseCreateFailure({
      userId: input.claim.turn.userId,
      turnId: input.claim.turn.id,
      leaseToken: input.claim.leaseToken,
      error,
      outcomeUnknownCode: input.outcomeUnknownCode,
      recoveryDelayMs: 1_000,
    }).catch(() => undefined);
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

export async function buildKnowledgeBaseTurnPrompt(input: {
  userId: number;
  conversationId: string;
  userMessage: string;
  attachments: Array<{ file_id: string; filename: string }>;
  attachmentManifest?: KnowledgeBaseClientAttachmentManifestItem[];
  skillVersion?: string;
  skillContentHash?: string | null;
  officialLogoUpload?: KnowledgeBaseOfficialLogoUpload;
  protocolOperation?: {
    operationId: string;
    turnId: string;
  };
  progressOverride?: {
    build: {
      revision: number;
      currentLeafId: string | null;
    };
    branches: Array<{
      leaves: Array<{
        id: string;
        title: string;
        branchTitle: string;
        status:
          | "pending"
          | "current"
          | "confirmed"
          | "direct_prefilled"
          | "needs_verification";
      }>;
    }>;
  };
}) {
  await loadSkillArchive({
    version: input.skillVersion || "3",
    contentHash: input.skillContentHash,
  });
  const progress =
    input.progressOverride ||
    (await getKnowledgeBaseProgress({
      userId: input.userId,
      conversationId: input.conversationId,
    }));
  if (!progress) {
    throw new KnowledgeBaseBuildError(
      "BUILD_NOT_FOUND",
      "当前对话没有知识库构建记录",
    );
  }
  const leaves = progress.branches.flatMap((branch) => branch.leaves);
  const current = leaves.find(
    (leaf) => leaf.id === progress.build.currentLeafId,
  );
  const currentIndex = current
    ? leaves.findIndex((leaf) => leaf.id === current.id)
    : -1;
  const nextPending = current
    ? leaves
        .slice(currentIndex + 1)
        .find((leaf) => leaf.status === "pending") || null
    : null;
  const action = classifyKnowledgeBaseUserAction(
    input.userMessage,
    input.attachments.length,
  );
  const postRevision = progress.build.revision + 1;
  const isV4 = input.skillVersion === "4";
  const isOfficialLogoUpload = isV4 && Boolean(input.officialLogoUpload);
  const requiresPresentation = (input.skillVersion || "3") === "3" || isV4;
  const protocolIdentity = isV4
    ? {
        operationId: input.protocolOperation?.operationId || "",
        turnId: input.protocolOperation?.turnId || "",
      }
    : {};
  const transitionTarget =
    action === "confirm"
      ? "confirmed"
      : action === "direct_prefill"
        ? "direct_prefilled"
        : "needs_verification";
  const presentationLeafId =
    action === "confirm" || action === "direct_prefill"
      ? nextPending?.id || null
      : current?.id || null;
  const finalPackageRequired = Boolean(
    current &&
      !nextPending &&
      (action === "confirm" || action === "direct_prefill"),
  );
  const progressEnvelopeExample = current
    ? formatKnowledgeBaseProgressEnvelope({
        kind: KNOWLEDGE_BASE_PROGRESS_KIND,
        schemaVersion: isV4 ? KNOWLEDGE_BASE_PROTOCOL_V4_SCHEMA_VERSION : 1,
        ...protocolIdentity,
        revision: progress.build.revision,
        transition: {
          leafId: current.id,
          from:
            current.status === "needs_verification"
              ? "needs_verification"
              : "current",
          to: transitionTarget,
          reason:
            action === "confirm"
              ? "用户明确确认"
              : action === "direct_prefill"
                ? "用户明确采用预填"
                : "用户补充或修订当前节点",
        },
      })
    : "";
  const presentationEnvelopeExample = requiresPresentation
    ? formatKnowledgeBasePresentationEnvelope({
        kind: KNOWLEDGE_BASE_PRESENTATION_KIND,
        schemaVersion: isV4 ? KNOWLEDGE_BASE_PROTOCOL_V4_SCHEMA_VERSION : 1,
        ...protocolIdentity,
        revision: postRevision,
        leafId: presentationLeafId,
        imageState:
          presentationLeafId === null ? "not_applicable" : "no_eligible_asset",
        assetIds: [],
        imageCount: 0,
      })
    : "";
  const stateReminder = current
    ? [
        `当前 revision=${progress.build.revision}`,
        `当前且唯一可处理节点：${current.id}｜${current.branchTitle} / ${current.title}`,
        `当前节点状态：${current.status}`,
        `服务端判定本轮动作：${action}`,
        isOfficialLogoUpload
          ? "本轮唯一附件是 Dashboard 已完成原始字节、SHA-256、MIME、尺寸及首节点绑定校验的企业官方主 Logo。必须按补充/修订处理，保持当前首节点为 needs_verification；不得确认或前进。"
          : "只要本轮包含附件，无论文字是否包含“确认”，都必须按补充/修订处理，保持 needs_verification。",
        "回复末尾只能附一个 FRONTMIND_KB_PROGRESS 信封；HTML 注释开头和结尾是信封的一部分，不得省略或改成裸 JSON。",
        "FRONTMIND_KB_PROGRESS 必须逐字段使用下面这个当轮唯一结构；不得把 action、leafId、status 放在顶层，不得把 revision 改成提交后的值：",
        progressEnvelopeExample,
        action === "confirm" || action === "direct_prefill"
          ? nextPending
            ? `先简短确认已处理 ${current.id}，正文主体随后完整展示下一节点 ${nextPending.id}｜${nextPending.branchTitle} / ${nextPending.title}。不得再次把 ${current.id} 作为主体。`
            : `这是最后一个节点。简短确认 ${current.id} 后必须在本轮实际创建并返回唯一最终 ZIP，不再展示节点正文；不得只说“即将生成”“稍后生成”或“进入交付阶段”。`
          : `更新并完整重新展示当前节点 ${current.id}；不得展示或推进到后续节点。`,
        requiresPresentation
          ? `回复末尾还必须附且只能附一个 FRONTMIND_KB_PRESENTATION 信封：revision=${postRevision}，leafId=${
              presentationLeafId || "null"
            }。这是非首轮：leafId 非 null 时必须固定声明 imageState=no_eligible_asset、assetIds=[]、imageCount=0，且不得返回任何图片附件；leafId=null 时使用 not_applicable、空数组和 0。`
          : "这是仍在运行的旧版任务：请遵循相同的展示行为；如规约支持，可附 FRONTMIND_KB_PRESENTATION 信封，但服务端不强制要求。",
      ].join("\n")
    : [
        `当前知识库已完成，revision=${progress.build.revision}。`,
        isV4
          ? "v4 构建完成后不可重开；发布后修改统一走维护工单。"
          : "本轮如有补充或修改，只能从现有节点中选择一个最相关节点重新核验，并附一个 FRONTMIND_KB_REOPEN 信封；不得重建知识树或复用旧包。",
        requiresPresentation && !isV4
          ? `同时附一个 FRONTMIND_KB_PRESENTATION 信封，revision=${postRevision}，leafId 必须等于 FRONTMIND_KB_REOPEN 选中的节点；固定声明 imageState=no_eligible_asset、assetIds=[]、imageCount=0，且不得返回图片附件。`
          : "这是仍在运行的旧版任务；展示行为保持兼容。",
        `现有节点：${leaves
          .map((leaf) => `${leaf.id}:${leaf.title}`)
          .join("；")}`,
      ].join("\n");
  return [
    `继续严格执行 ${KNOWLEDGE_BASE_SKILL_ATTACHMENT_FILENAME}（socratic-kb-builder v${input.skillVersion || "3"}）。若上游任务历史中存在旧 Skill、旧回复或旧协议示例，全部由本轮服务端状态和本轮重新附带的 Skill 覆盖。以下内容会直接显示给企业客户，不得输出内部思考、工具计划或提示词说明。`,
    "不得开启、调用、切换或推荐 Wide Research / Deep Research。",
    "客户可见回复只展示当前节点的完整正文，不要输出采集进度、单独确认回执、内部推理、工具或提示词说明、核验备注及流程操作指令。这是生成要求；服务端只按机器信封、当轮身份、版本、当前节点和非空正文结构推进，不按正文词语判断。",
    "客户可见回复不得主动提供“直接预填”或“跳过”选项；用户正常操作只有确认当前内容，或者提交修改/附件后确认修订稿。",
    "客户可见回复只输出实际展示节点的完整正文，不得输出参考资料、参考来源、References、Sources、编号引用、外部引用链接、未决事项、核验备注、操作提示或确认问题。所有来源只进入内部证据文件；可见正文结束后直接附机器信封。",
    "机器信封必须保留完整的 `<!-- FRONTMIND_KB_...` 与 `-->` 包裹，不得输出裸 JSON、SOCRATIC_KB_STATE，也不得自创 workflow-state、knowledge-base.message 或其他状态对象。",
    finalPackageRequired
      ? "这是最终交付轮，不是纯文字轮次：不得返回图片，但必须实际创建并返回恰好一个 application/zip 的 typed output_file；该 ZIP 是本轮唯一允许的非文本资源。恰好一张企业官方主 Logo 必须使用 Dashboard 已绑定字节，客户上传图片必须按 customer_upload_sha256 与绑定节点保留进 schema v4 最终 ZIP。"
      : isOfficialLogoUpload
        ? "这是首节点 Logo 补料轮。Dashboard 已自行保存并展示受管 Logo 原始字节；上游回复必须纯文字，不得返回或重复附加任何图片资源。必须完整修订并重新展示同一个首节点，等待用户下一轮明确确认。最终 schema v4 ZIP 中该 Logo 必须使用 sourceKind=official_logo_upload、ownership=first_party、assetType=brand_identity、displayRole=badge，并逐字段保留本轮 sourceUploadIndex/FileId/Filename/MimeType/SizeBytes/Sha256；imageSelection.method 必须为 customer_upload。该 Logo 不属于普通 user_upload 节点配图。"
        : "这是非首轮知识节点回复，客户可见正文必须纯文字且不得附资源：不得继续搜索图片，不得返回、重复或重新附加任何 output_image、image MIME output_file、包内图片路径或官网/CDN 热链。恰好一张企业官方主 Logo 只允许在首轮第一个叶子展示；客户主动上传的节点图片由 Dashboard 从受管原始字节自行回显，你只负责把它按 customer_upload_sha256 与绑定节点保留进 schema v4 最终 ZIP。",
    "",
    "# 当前知识库状态",
    stateReminder,
    "",
    "# 本轮上传资料",
    input.attachments.length
      ? input.attachments
          .map((file, index) => {
            const manifest = input.attachmentManifest?.[index];
            return manifest
              ? isOfficialLogoUpload &&
                index === input.officialLogoUpload?.index
                ? `- ${file.filename}｜用途=企业官方主 Logo｜sourceUploadIndex=${input.officialLogoUpload.index}｜sourceUploadFileId=${input.officialLogoUpload.fileId}｜sourceUploadFilename=${input.officialLogoUpload.filename}｜sourceUploadMimeType=${input.officialLogoUpload.mimeType}｜sourceUploadSizeBytes=${input.officialLogoUpload.sizeBytes}｜sourceUploadSha256=${input.officialLogoUpload.sourceSha256}｜绑定节点=${current?.id || "unknown"}`
                : `- ${file.filename}｜customer_upload_sha256=${manifest.sha256}｜mime=${manifest.mimeType}｜bytes=${manifest.sizeBytes}｜绑定节点=${current?.id || "unknown"}`
              : `- ${file.filename}`;
          })
          .join("\n")
      : "- 无",
    "",
    "# 企业本轮回复",
    input.userMessage.trim() || "请继续完成当前知识节点。",
    "",
    ...(current
      ? [
          "# 最终输出锁（最高优先级，必须作为回复结尾）",
          `服务端已将本轮动作确定为 ${action}；不得自行改成其他动作。`,
          action === "confirm" || action === "direct_prefill"
            ? nextPending
              ? `可见正文主体必须是 ${nextPending.id}｜${nextPending.title}，不得再次把 ${current.id} 作为主体。`
              : `只简短确认 ${current.id} 并完成最终交付，不得再次输出 ${current.id} 正文。`
            : `可见正文主体必须继续是 ${current.id}｜${current.title}。`,
          ...(finalPackageRequired
            ? [
                "# 最终 ZIP 文件锁（同级最高优先级）",
                "必须在结束本轮前，把恰好一个 type=output_file、MIME=application/zip 的最终知识库 ZIP 实际加入任务 output；不得只输出文件名、路径、下载承诺或“即将生成/稍后生成”的文字。",
                `ZIP 必须与本轮 operationId=${input.protocolOperation?.operationId || ""}、turnId=${input.protocolOperation?.turnId || ""} 属于同一 assistant output item，或在资源描述中显式携带完全相同的 operationId 与 turnId。`,
                `ZIP 内 00_package_manifest.json 的 buildRevision 必须为 ${postRevision}，并完整绑定当前知识树、首轮 Logo 原始字节与全部客户上传资源。`,
                `ZIP 中每个 kind=leaf 文档 id 必须逐字使用当前知识树原始节点 id（${leaves.map((leaf) => leaf.id).join("、")}），不得添加 leaf-、node- 等前后缀；所有素材 documentIds 必须引用同一组原始 id。`,
                "schemaVersion=4 只属于 ZIP 内 00_package_manifest.json；本轮 FRONTMIND_KB_PROGRESS 与 FRONTMIND_KB_PRESENTATION 仍必须保留下面服务端给定的 schemaVersion=2、operationId、turnId 和字段层级。不得用 action=final_package、packageSha256、packageBytes 或 VALID 摘要替代这两个信封。",
                "在 ZIP 文件资源已经进入任务 output 之前不得结束任务；Progress 和 Presentation 文本信封不能替代 ZIP 文件。",
              ]
            : []),
          "可见正文结束后，FRONTMIND_KB_PROGRESS 必须逐字采用下面的字段层级和值；旧版顶层 action、leafId、status 一律无效：",
          progressEnvelopeExample,
          ...(requiresPresentation
            ? [
                "随后紧接且只接下面这个 FRONTMIND_KB_PRESENTATION；不得更改 revision、leafId 或图片字段：",
                presentationEnvelopeExample,
              ]
            : []),
        ]
      : []),
  ].join("\n");
}

router.post("/start", async (req, res) => {
  const body = (req.body || {}) as KnowledgeBaseStartRequest;
  const conversationId = String(body.conversationId || "").trim();
  const clientRequestId = String(body.clientRequestId || "").trim();
  const requestedCompanyName = String(body.companyName || "").trim();
  const companyWebsite = String(body.companyWebsite || "").trim();
  const operatorNotes = String(body.operatorNotes || "").trim();

  if (
    !conversationId ||
    conversationId.length > 191 ||
    !clientRequestId ||
    clientRequestId.length > 128
  ) {
    res.status(400).json({ error: "知识库对话标识缺失或无效" });
    return;
  }
  if (
    !req.frontmindUser ||
    !(await requireKnowledgeBuildCapability(req.frontmindUser.id, res))
  ) {
    return;
  }
  if (!req.frontmindUser || !req.frontmindCredential) {
    res.status(401).json({ error: "请先登录并配置 API Key" });
    return;
  }

  const { apiKey, baseUrl } = getFrontMindCredentials(req);
  if (!apiKey) {
    res.status(401).json({ error: "当前账号尚未配置可用的 API Key" });
    return;
  }

  let reservationCreated = false;
  try {
    await assertKnowledgeBaseWritable(req.frontmindUser.id);
    const existingBuild = await getKnowledgeBaseProgress({
      userId: req.frontmindUser.id,
      conversationId,
    });
    if (existingBuild?.build.status === "published") {
      res.status(409).json({
        error: {
          code: "KNOWLEDGE_BASE_LOCKED",
          message: "知识库已发布；后续修改请提交维护工单",
        },
      });
      return;
    }
    const [workspace, prefillKnowledgeSnapshot] = await Promise.all([
      getDashboardWorkspace(req.frontmindUser.id),
      getLatestKnowledgeSnapshot(req.frontmindUser.id),
    ]);
    const companyName = resolveKnowledgeBaseEnterpriseIdentity({
      sourceName: workspace.sourceName,
      brandName: workspace.payload.brandName,
      requestedCompanyName,
    });
    const latestSkillDescriptor = await getKnowledgeBaseSkillDescriptor();
    const userAttachments = normalizeKnowledgeBaseUserAttachments(
      body.attachments,
    );
    for (const attachment of userAttachments) {
      const fileCredential = await getCredentialForUpstreamResource(
        req.frontmindUser.id,
        "file",
        attachment.file_id,
      );
      if (
        !fileCredential ||
        !credentialsUseSameUpstreamApiKey(
          fileCredential,
          req.frontmindCredential,
        )
      ) {
        res.status(403).json({
          error: "上传资料与当前账号不匹配，请重新上传",
        });
        return;
      }
    }
    const startReservation = await reserveKnowledgeBaseStartBuild({
      userId: req.frontmindUser.id,
      conversationId,
      clientRequestId,
      companyName,
      companyWebsite,
      skillName: latestSkillDescriptor.name,
      skillVersion: latestSkillDescriptor.version,
      skillContentHash: latestSkillDescriptor.contentHash,
      requestPayload: {
        companyName,
        companyWebsite,
        operatorNotes,
        attachments: userAttachments,
        skillVersion: latestSkillDescriptor.version,
        skillContentHash: latestSkillDescriptor.contentHash,
        prefillSnapshotId: prefillKnowledgeSnapshot?.id || null,
      },
      apiCredentialId: req.frontmindCredential.id,
      userText: "开始构建企业知识库",
      userAttachmentCount: userAttachments.length,
      expectedAttachmentCount:
        1 + userAttachments.length + (prefillKnowledgeSnapshot ? 1 : 0),
      recoveryMetadata: {
        kind: "start",
        conversationId,
        companyName,
        companyWebsite,
        operatorNotes,
        attachments: userAttachments,
        skillVersion: latestSkillDescriptor.version,
        skillContentHash: latestSkillDescriptor.contentHash,
        includePrefill: Boolean(prefillKnowledgeSnapshot),
        prefillSnapshotId: prefillKnowledgeSnapshot?.id || null,
      },
    });
    reservationCreated = true;
    const { build, reservation } = startReservation;
    // The build and first turn commit together; legacy builds keep their pinned Skill contract.
    const skillDescriptor = {
      name: build.skillName,
      version: build.skillVersion,
      contentHash: build.skillContentHash,
    };
    let progress = await getKnowledgeBaseProgress({
      userId: req.frontmindUser.id,
      conversationId,
    });
    if (!progress) throw new Error("知识库构建 reservation 创建失败");
    if (reservation.state !== "acquired") {
      const observation = await getKnowledgeBaseObservation({
        userId: req.frontmindUser.id,
        conversationId,
        upstreamStatus:
          reservation.state === "completed" ? "completed" : "running",
      });
      res
        .status(reservation.state === "pending" ? 202 : 200)
        .setHeader(
          "Retry-After",
          String(Math.ceil(reservationRetryAfterMs(reservation) / 1_000)),
        )
        .json({
          ...(observation?.authoritativeTaskId
            ? {
                task: {
                  id: observation.authoritativeTaskId,
                  status:
                    reservation.state === "completed" ? "completed" : "running",
                },
              }
            : {}),
          progress: observation?.interaction.progress || progress,
          interaction:
            observation?.interaction ||
            deriveKnowledgeBaseInteraction(progress, "running"),
          observation,
          idempotent: true,
          resumed: true,
          startedAt: reservation.turn.startedAt?.getTime() || Date.now(),
        });
      return;
    }
    const { turn, leaseToken, upstreamIdempotencyKey } = reservation;
    const prompt = await buildKnowledgeBasePrompt({
      conversationId,
      companyName: build.companyName,
      companyWebsite: build.companyWebsite || "",
      operatorNotes,
      attachments: userAttachments,
      prefillKnowledgeSnapshot,
      protocolOperation: {
        skillVersion: skillDescriptor.version,
        operationId: turn.operationKey,
        turnId: turn.id,
      },
    });
    const generatedAttachments: Array<{
      attachment: { file_id: string; filename: string };
      fileId: string;
      removeOrphan: () => Promise<void>;
    }> = [];
    let created: Awaited<ReturnType<typeof createFrontMindTask>>;
    try {
      const skillArchive = await uploadKnowledgeBaseSkillArchive({
        baseUrl,
        apiKey,
        skillVersion: skillDescriptor.version,
        skillContentHash: skillDescriptor.contentHash,
        durable: {
          userId: req.frontmindUser.id,
          turnId: turn.id,
          leaseToken,
          attachmentIndex: 0,
        },
      });
      generatedAttachments.push(skillArchive);
      await renewKnowledgeBaseTurnLease({
        userId: req.frontmindUser.id,
        turnId: turn.id,
        leaseToken,
      });
      await stageKnowledgeBaseTurnAttachments({
        userId: req.frontmindUser.id,
        turnId: turn.id,
        leaseToken,
        attachmentFileIds: [skillArchive.fileId],
      });
      await recordUpstreamResource({
        userId: req.frontmindUser.id,
        apiCredentialId: req.frontmindCredential.id,
        kind: "file",
        upstreamId: skillArchive.fileId,
      });
      if (prefillKnowledgeSnapshot) {
        const prefillArchive = await buildKnowledgeBasePrefillEvidenceArchive(
          prefillKnowledgeSnapshot,
        );
        const uploaded = await uploadDurableKnowledgeBaseGeneratedAttachment({
          baseUrl,
          apiKey,
          filename: KNOWLEDGE_BASE_PREFILL_ATTACHMENT_FILENAME,
          bytes: prefillArchive.bytes,
          durable: {
            userId: req.frontmindUser.id,
            turnId: turn.id,
            leaseToken,
            attachmentIndex: 1,
            role: "prefill",
          },
        });
        generatedAttachments.push(uploaded);
        await renewKnowledgeBaseTurnLease({
          userId: req.frontmindUser.id,
          turnId: turn.id,
          leaseToken,
        });
        await stageKnowledgeBaseTurnAttachments({
          userId: req.frontmindUser.id,
          turnId: turn.id,
          leaseToken,
          attachmentFileIds: generatedAttachments.map(
            (attachment) => attachment.fileId,
          ),
        });
        await recordUpstreamResource({
          userId: req.frontmindUser.id,
          apiCredentialId: req.frontmindCredential.id,
          kind: "file",
          upstreamId: uploaded.fileId,
        });
      }
      const frozenAttachmentIds = [
        ...generatedAttachments.map((attachment) => attachment.fileId),
        ...userAttachments.map((attachment) => attachment.file_id),
      ];
      await freezeKnowledgeBaseTurnAttachments({
        userId: req.frontmindUser.id,
        turnId: turn.id,
        leaseToken,
        attachmentFileIds: frozenAttachmentIds,
      });
      const preparedDispatch = await prepareKnowledgeBaseTurnDispatch({
        userId: req.frontmindUser.id,
        turnId: turn.id,
        leaseToken,
        baseUrl,
        prompt,
        agentProfile: toUpstreamAgentProfile(KNOWLEDGE_BASE_AGENT_PROFILE),
        attachments: [
          ...generatedAttachments.map((item) => item.attachment),
          ...userAttachments,
        ],
      });
      await markKnowledgeBaseTurnDispatching({
        userId: req.frontmindUser.id,
        turnId: turn.id,
        leaseToken,
      });
      created = await createFrontMindTask({
        baseUrl,
        apiKey,
        requestBody: preparedDispatch.requestBody,
        idempotencyKey: upstreamIdempotencyKey,
      });
    } catch (error) {
      await persistKnowledgeBaseCreateFailure({
        userId: req.frontmindUser.id,
        turnId: turn.id,
        leaseToken,
        error,
        outcomeUnknownCode: "START_DISPATCH_OUTCOME_UNKNOWN",
      }).catch(() => undefined);
      throw error;
    }

    if (!created.ok) {
      const createError = knowledgeBaseUpstreamCreateError(created);
      const failureClass = await persistKnowledgeBaseCreateFailure({
        userId: req.frontmindUser.id,
        turnId: turn.id,
        leaseToken,
        error: createError,
        outcomeUnknownCode: "START_DISPATCH_OUTCOME_UNKNOWN",
      });
      logKnowledgeBaseRuntimeFailure({
        level: "warn",
        event: "[KnowledgeBaseStart] upstream_create_failed",
        buildId: progress?.build.id,
        turnId: turn.id,
        error: { status: created.status },
        additionalSecrets: [apiKey],
      });
      const observation =
        failureClass === "deterministic"
          ? await getKnowledgeBaseObservation({
              userId: req.frontmindUser.id,
              conversationId,
              upstreamStatus: "failed",
            })
          : null;
      res.status(created.status).json({
        error: {
          code: createError.failureCode,
          message:
            failureClass === "deterministic"
              ? deterministicKnowledgeBaseCreateFailureMessage(createError)
              : "创建企业知识库任务失败，系统将按原预约自动恢复",
        },
        reservationCreated: true,
        ...(observation
          ? {
              observation,
              progress: observation.interaction.progress,
              interaction: observation.interaction,
            }
          : {}),
      });
      return;
    }
    await bindKnowledgeBaseTurnUpstreamTask({
      userId: req.frontmindUser.id,
      turnId: turn.id,
      leaseToken,
      upstreamTaskId: String(created.task.id),
    });
    assertKnowledgeBaseCustomerOutput(created.task.output);

    await recordUpstreamResource({
      userId: req.frontmindUser.id,
      apiCredentialId: req.frontmindCredential.id,
      kind: "task",
      upstreamId: String(created.task.id),
    });
    await recordKnowledgeBaseOutputFiles({
      userId: req.frontmindUser.id,
      apiCredentialId: req.frontmindCredential.id,
      output: created.task.output,
    });
    if (Array.isArray(created.task.output) && created.task.output.length > 0) {
      try {
        progress =
          (await reconcileAvailableKnowledgeOutput({
            userId: req.frontmindUser.id,
            conversationId,
            taskId: String(created.task.id),
            output: created.task.output,
            upstreamStatus: created.task.status,
            ledger: {
              lastOutputLength: 0,
              lastOutputItemIds: [],
            },
            artifactAccess: { apiKey, baseUrl },
          })) || progress;
      } catch (error) {
        logKnowledgeBaseRuntimeFailure({
          level: "warn",
          event: "[KnowledgeBaseStart] initial_progress_rejected",
          buildId: progress?.build.id,
          turnId: turn.id,
          taskId: String(created.task.id),
          error,
          additionalSecrets: [apiKey],
        });
        progress =
          (await getKnowledgeBaseProgress({
            userId: req.frontmindUser.id,
            conversationId,
          })) || progress;
      }
    }

    const observation = await getKnowledgeBaseObservation({
      userId: req.frontmindUser.id,
      conversationId,
      upstreamStatus: created.task.status,
    });
    res.json({
      visibleMessage: "开始构建企业知识库",
      task: {
        id: String(created.task.id),
        status: created.task.status,
        taskUrl: created.task.taskUrl,
        title: created.task.title,
      },
      progress: observation?.interaction.progress || progress,
      interaction:
        observation?.interaction ||
        deriveKnowledgeBaseInteraction(progress, created.task.status),
      observation,
      startedAt: Date.now(),
    });
  } catch (error: any) {
    if (error instanceof KnowledgeBaseTurnReservationError) {
      const status =
        error.code === "BUILD_NOT_FOUND"
          ? 404
          : error.code === "INVALID_REQUEST"
            ? 400
            : 409;
      const observation =
        status === 409 && req.frontmindUser
          ? await getKnowledgeBaseObservation({
              userId: req.frontmindUser.id,
              conversationId,
              upstreamStatus: "running",
            }).catch(() => null)
          : null;
      res.status(status).json({
        error: { code: error.code, message: error.message },
        reservationCreated: false,
        ...(observation
          ? {
              observation,
              progress: observation.interaction.progress,
              interaction: observation.interaction,
            }
          : {}),
      });
      return;
    }
    if (error instanceof KnowledgeBaseEnterpriseIdentityError) {
      res.status(error.code === "ENTERPRISE_NOT_CONFIGURED" ? 422 : 409).json({
        error: error.message,
        code: error.code,
        reservationCreated,
      });
      return;
    }
    if (error instanceof KnowledgeBaseBuildError) {
      res.status(422).json({
        error: {
          code: error.code,
          message: error.message,
        },
        reservationCreated,
      });
      return;
    }
    logKnowledgeBaseRuntimeFailure({
      level: "error",
      event: "[KnowledgeBaseStart] failed",
      error,
      additionalSecrets: [apiKey, req.frontmindCredential?.apiKey],
    });
    res.status(500).json({
      error: {
        code: "KNOWLEDGE_BASE_START_FAILED",
        message: "启动企业知识库任务失败，请稍后重试",
      },
      reservationCreated,
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
    expectedLeafId?: string;
  };
  const conversationId = String(body.conversationId || "").trim();
  const clientRequestId = String(body.clientRequestId || "").trim();
  const userMessage = String(body.userMessage || "").slice(0, 2_000_000);
  const expectedGeneration = body.expectedGeneration;
  const expectedRevision = body.expectedRevision;
  const expectedLeafId = String(body.expectedLeafId || "").trim();
  if (
    !conversationId ||
    !clientRequestId ||
    clientRequestId.length > 128 ||
    !Number.isSafeInteger(expectedGeneration) ||
    Number(expectedGeneration) < 1 ||
    !Number.isSafeInteger(expectedRevision) ||
    Number(expectedRevision) < 0 ||
    !expectedLeafId ||
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

  try {
    await assertKnowledgeBaseWritable(req.frontmindUser.id);
    const attachmentManifest = normalizeKnowledgeBaseClientAttachmentManifest(
      body.attachmentManifest,
    );
    const authoritativeBuild = await loadKnowledgeBaseBuildRecord(
      req.frontmindUser.id,
      conversationId,
    );
    const parentTaskId = String(authoritativeBuild?.upstreamTaskId || "");
    if (!authoritativeBuild || !parentTaskId) {
      throw new KnowledgeBaseTurnReservationError(
        "CONFLICT",
        "当前知识库尚未绑定可恢复任务，请先同步状态",
      );
    }
    const boundBuild = await assertKnowledgeBaseTaskBinding({
      userId: req.frontmindUser.id,
      conversationId,
      taskId: parentTaskId,
    });
    assertKnowledgeBaseManifestDoesNotRepeatOfficialLogo(
      boundBuild,
      attachmentManifest,
    );
    if (
      knowledgeBaseBuildRequiresOfficialLogo(boundBuild) &&
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
    const taskCredential = await getCredentialForUpstreamResource(
      req.frontmindUser.id,
      "task",
      parentTaskId,
    );
    if (!taskCredential) {
      res.status(403).json({
        error: {
          code: "UPSTREAM_RESOURCE_FORBIDDEN",
          message: "当前知识库任务不属于此账号",
        },
      });
      return;
    }
    const action = classifyKnowledgeBaseUserAction(
      userMessage,
      attachmentManifest.length,
    );
    const skillVersion = boundBuild.skillVersion;
    const skillContentHash = boundBuild.skillContentHash;
    const reservation = await reserveKnowledgeBaseTurn({
      userId: req.frontmindUser.id,
      buildId: boundBuild.id,
      clientRequestId,
      operationType: action === "initial" ? "revise" : action,
      expectedGeneration: Number(expectedGeneration),
      expectedRevision: Number(expectedRevision),
      expectedLeafId,
      requestPayload: {
        userMessage,
        attachmentManifest,
        skillVersion,
        skillContentHash,
      },
      apiCredentialId: taskCredential.id,
      userText: userMessage,
      userAttachmentCount: attachmentManifest.length,
      expectedAttachmentCount: attachmentManifest.length + 1,
      deferDispatchUntilAttachments: true,
      clientAttachmentManifest: attachmentManifest,
      resumeDeferredReservation: body.resumeExisting === true,
      recoveryMetadata: {
        kind: "turn",
        conversationId,
        parentTaskId,
        userMessage,
        attachments: [],
        attachmentManifest,
        capturedClientAttachments: true,
        deferredClientAttachments: true,
        skillVersion,
        skillContentHash,
      },
    });
    if (reservation.state === "acquired") {
      throw new KnowledgeBaseTurnReservationError(
        "CONFLICT",
        "Deferred attachment reservation unexpectedly acquired a worker lease",
      );
    }
    const observation = await getKnowledgeBaseObservation({
      userId: req.frontmindUser.id,
      conversationId,
      upstreamStatus:
        reservation.state === "completed" ? "completed" : "running",
    });
    res
      .status(reservation.state === "pending" ? 202 : 200)
      .setHeader(
        "Retry-After",
        String(Math.ceil(reservationRetryAfterMs(reservation) / 1_000)),
      )
      .json({
        reservation: {
          state: reservation.state,
          turnId: reservation.turn.id,
          clientRequestId: reservation.turn.clientRequestId,
          generation: reservation.turn.buildGeneration,
          revision: reservation.turn.expectedRevision,
          leafId: reservation.turn.expectedLeafId,
          stagedAttachmentCount: reservation.turn.stagedUserAttachmentCount,
          expectedAttachmentCount: reservation.turn.expectedUserAttachmentCount,
          requiresUpload: reservation.state === "awaiting_attachments",
        },
        ...(observation?.authoritativeTaskId
          ? {
              task: {
                id: observation.authoritativeTaskId,
                status:
                  reservation.state === "completed" ? "completed" : "running",
              },
            }
          : {}),
        observation,
        progress: observation?.interaction.progress || null,
        interaction:
          observation?.interaction ||
          deriveKnowledgeBaseInteraction(null, "running"),
        idempotent: reservation.state !== "awaiting_attachments",
      });
  } catch (error) {
    if (error instanceof KnowledgeBaseTurnReservationError) {
      const observation = req.frontmindUser
        ? await getKnowledgeBaseObservation({
            userId: req.frontmindUser.id,
            conversationId,
            upstreamStatus: "running",
          }).catch(() => null)
        : null;
      res
        .status(
          error.code === "BUILD_NOT_FOUND"
            ? 404
            : error.code === "INVALID_REQUEST"
              ? 400
              : 409,
        )
        .json({
          error: { code: error.code, message: error.message },
          ...(observation ? { observation } : {}),
        });
      return;
    }
    res.status(422).json({
      error: {
        code: "KNOWLEDGE_BASE_TURN_RESERVATION_FAILED",
        message:
          error instanceof Error
            ? error.message
            : "当前知识节点预约失败，请稍后重试",
      },
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
  };
  const conversationId = String(body.conversationId || "").trim();
  const turnId = String(body.turnId || "").trim();
  const clientRequestId = String(body.clientRequestId || "").trim();
  if (
    !conversationId ||
    !turnId ||
    !clientRequestId ||
    clientRequestId.length > 128 ||
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
      attachment.filename !== manifestItem.filename
    ) {
      throw new KnowledgeBaseTurnReservationError(
        "CONFLICT",
        "上传文件与本轮附件清单不一致",
      );
    }
    const build = await loadKnowledgeBaseBuildRecord(
      req.frontmindUser.id,
      conversationId,
    );
    const parentTaskId = String(build?.upstreamTaskId || "");
    if (!build || !parentTaskId) {
      throw new KnowledgeBaseTurnReservationError(
        "CONFLICT",
        "当前知识库尚未绑定可恢复任务，请先同步状态",
      );
    }
    const taskCredential = await getCredentialForUpstreamResource(
      req.frontmindUser.id,
      "task",
      parentTaskId,
    );
    const fileCredential = await getCredentialForUpstreamResource(
      req.frontmindUser.id,
      "file",
      attachment.file_id,
    );
    if (
      !taskCredential ||
      !fileCredential ||
      !credentialsUseSameUpstreamApiKey(fileCredential, taskCredential)
    ) {
      res.status(403).json({
        error: {
          code: "KNOWLEDGE_BASE_FILE_FORBIDDEN",
          message: "上传资料与当前知识库任务不匹配，请重新上传",
        },
      });
      return;
    }
    const deferredOfficialLogoRequired =
      knowledgeBaseBuildRequiresOfficialLogo(build);
    if (knowledgeBaseManifestRepeatsOfficialLogo(build, manifest)) {
      const message =
        "该图片与已绑定的企业主 Logo 完全相同，无需作为普通补图再次上传";
      await cancelUnpreparedKnowledgeBaseTurn({
        userId: req.frontmindUser.id,
        turnId,
        clientRequestId,
        code: "KNOWLEDGE_BASE_DUPLICATE_LOGO_UPLOAD",
        message,
      });
      throw new KnowledgeBaseTurnReservationError("INVALID_REQUEST", message);
    }
    if (deferredOfficialLogoRequired) {
      const rejectDeferredLogo = async (message: string) => {
        await cancelUnpreparedKnowledgeBaseTurn({
          userId: req.frontmindUser!.id,
          turnId,
          clientRequestId,
          code: "KNOWLEDGE_BASE_LOGO_UPLOAD_INVALID",
          message,
        });
        throw new KnowledgeBaseTurnReservationError("INVALID_REQUEST", message);
      };
      if (
        manifest.length !== 1 ||
        index !== 0 ||
        ![
          "image/avif",
          "image/gif",
          "image/jpeg",
          "image/png",
          "image/webp",
        ].includes(manifestItem.mimeType)
      ) {
        await rejectDeferredLogo(
          "当前知识库正在等待企业主 Logo，请只上传一张受支持的图片原文件",
        );
      }
      let image: { width: number; height: number };
      try {
        image = await assertCapturedKnowledgeBaseCustomerImage({
          fileId: attachment.file_id,
          filename: manifestItem.filename,
          mimeType: manifestItem.mimeType,
          sizeBytes: manifestItem.sizeBytes,
          sourceSha256: manifestItem.sha256,
        });
      } catch {
        await rejectDeferredLogo(
          "上传文件不是可安全解码的企业主 Logo 图片，请重新选择原文件",
        );
        return;
      }
      if (image.width < 256 || image.height < 256) {
        await rejectDeferredLogo(
          `企业主 Logo 位图宽高均需至少 256 像素；当前为 ${image.width}×${image.height}`,
        );
      }
    }
    // uploadFile only calls this route after the signed PUT has completed.
    // Bind that already-owned file id immediately, as the OEM client does.
    // Re-downloading the entire object here made submission time depend on
    // object-store read-after-write visibility and incorrectly rejected slow
    // or large uploads after an arbitrary verification window.
    const dispatchClaim =
      await stageAndClaimKnowledgeBaseDeferredTurnAttachment({
        userId: req.frontmindUser.id,
        buildId: build.id,
        turnId,
        clientRequestId,
        clientAttachmentManifest: manifest,
        index,
        attachment,
      });
    const turn = dispatchClaim.turn;
    if (dispatchClaim.state !== "awaiting_attachments") {
      if (dispatchClaim.state === "acquired") {
        let acceptedClaim: KnowledgeBaseRecoveryClaim = dispatchClaim;
        if (deferredOfficialLogoRequired) {
          let verifiedLogo: KnowledgeBaseOfficialLogoUpload;
          try {
            verifiedLogo = await bindKnowledgeBaseOfficialLogoUpload({
              userId: req.frontmindUser.id,
              buildId: build.id,
              generation: dispatchClaim.turn.buildGeneration,
              turnId: dispatchClaim.turn.id,
              operationKey: dispatchClaim.turn.operationKey,
              expectedRevision: dispatchClaim.turn.expectedRevision,
              expectedLeafId: dispatchClaim.turn.expectedLeafId!,
              upload: {
                index: 0,
                fileId: attachment.file_id,
                filename: manifestItem.filename,
                mimeType: manifestItem.mimeType,
                sizeBytes: manifestItem.sizeBytes,
                sourceSha256: manifestItem.sha256,
              },
            });
          } catch (error) {
            const message =
              error instanceof Error
                ? error.message
                : "企业官方主 Logo 校验失败，请重新上传";
            if (
              error instanceof KnowledgeBaseArtifactBindingError &&
              error.code === "LOGO_UPLOAD_INVALID"
            ) {
              await cancelUnpreparedKnowledgeBaseTurn({
                userId: req.frontmindUser.id,
                turnId: dispatchClaim.turn.id,
                clientRequestId,
                leaseToken: dispatchClaim.leaseToken,
                code: "KNOWLEDGE_BASE_LOGO_UPLOAD_INVALID",
                message,
              });
            }
            throw new KnowledgeBaseTurnReservationError(
              error instanceof KnowledgeBaseArtifactBindingError &&
              error.code === "LOGO_UPLOAD_INVALID"
                ? "INVALID_REQUEST"
                : "CONFLICT",
              message,
            );
          }
          acceptedClaim = {
            ...dispatchClaim,
            recoveryMetadata: {
              ...dispatchClaim.recoveryMetadata,
              officialLogoUpload: verifiedLogo,
            },
          };
        }
        const observation = await getKnowledgeBaseObservation({
          userId: req.frontmindUser.id,
          conversationId,
          upstreamStatus: "running",
        }).catch(() => null);
        res.status(202).json({
          reservation: {
            state: "pending",
            turnId: dispatchClaim.turn.id,
            clientRequestId: dispatchClaim.turn.clientRequestId,
            stagedAttachmentCount: dispatchClaim.turn.stagedUserAttachmentCount,
            expectedAttachmentCount:
              dispatchClaim.turn.expectedUserAttachmentCount,
            requiresUpload: false,
          },
          task: { id: dispatchClaim.turn.id, status: "running" },
          observation,
          accepted: true,
        });
        launchAcceptedKnowledgeBaseClaim({
          claim: acceptedClaim,
          credential: taskCredential,
          outcomeUnknownCode: "TURN_DISPATCH_OUTCOME_UNKNOWN",
        });
        return;
      }
      const observation = await getKnowledgeBaseObservation({
        userId: req.frontmindUser.id,
        conversationId,
        upstreamStatus:
          dispatchClaim.state === "completed" ? "completed" : "running",
      }).catch(() => null);
      res
        .status(dispatchClaim.state === "pending" ? 202 : 200)
        .setHeader(
          "Retry-After",
          String(Math.ceil(reservationRetryAfterMs(dispatchClaim) / 1_000)),
        )
        .json({
          reservation: {
            state: dispatchClaim.state,
            turnId: dispatchClaim.turn.id,
            clientRequestId: dispatchClaim.turn.clientRequestId,
            stagedAttachmentCount: dispatchClaim.turn.stagedUserAttachmentCount,
            expectedAttachmentCount:
              dispatchClaim.turn.expectedUserAttachmentCount,
            requiresUpload: false,
          },
          observation,
          idempotent: true,
        });
      return;
    }
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
        requiresUpload:
          turn.stagedUserAttachmentCount < turn.expectedUserAttachmentCount,
      },
      observation,
    });
  } catch (error) {
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
      res
        .status(
          error.code === "RESERVATION_NOT_FOUND"
            ? 404
            : error.code === "INVALID_REQUEST"
              ? 400
              : error.code === "IDEMPOTENCY_PENDING"
                ? 425
                : 409,
        )
        .json({
          error: { code: error.code, message: error.message },
          ...(observation ? { observation } : {}),
        });
      return;
    }
    res.status(422).json({
      error: {
        code: "KNOWLEDGE_BASE_ATTACHMENT_STAGE_FAILED",
        message: "附件提交失败，请重新提交本轮",
      },
    });
  }
});

router.post("/turn/dispatch", async (req, res) => {
  const body = (req.body || {}) as {
    conversationId?: string;
    turnId?: string;
    clientRequestId?: string;
    attachmentManifest?: unknown;
  };
  const conversationId = String(body.conversationId || "").trim();
  const turnId = String(body.turnId || "").trim();
  const clientRequestId = String(body.clientRequestId || "").trim();
  if (
    !conversationId ||
    !turnId ||
    !clientRequestId ||
    clientRequestId.length > 128
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
  try {
    await assertKnowledgeBaseWritable(req.frontmindUser.id);
    const attachmentManifest = normalizeKnowledgeBaseClientAttachmentManifest(
      body.attachmentManifest,
    );
    const build = await loadKnowledgeBaseBuildRecord(
      req.frontmindUser.id,
      conversationId,
    );
    const parentTaskId = String(build?.upstreamTaskId || "");
    if (!build || !parentTaskId) {
      throw new KnowledgeBaseTurnReservationError(
        "CONFLICT",
        "当前知识库尚未绑定可恢复任务，请先同步状态",
      );
    }
    const taskCredential = await getCredentialForUpstreamResource(
      req.frontmindUser.id,
      "task",
      parentTaskId,
    );
    if (!taskCredential) {
      res.status(403).json({
        error: {
          code: "UPSTREAM_RESOURCE_FORBIDDEN",
          message: "当前知识库任务不属于此账号",
        },
      });
      return;
    }
    acquiredClaim = await claimKnowledgeBaseDeferredTurnDispatch({
      userId: req.frontmindUser.id,
      buildId: build.id,
      turnId,
      clientRequestId,
      clientAttachmentManifest: attachmentManifest,
    });
    if (acquiredClaim.state !== "acquired") {
      const observation = await getKnowledgeBaseObservation({
        userId: req.frontmindUser.id,
        conversationId,
        upstreamStatus:
          acquiredClaim.state === "completed" ? "completed" : "running",
      });
      res
        .status(acquiredClaim.state === "pending" ? 202 : 200)
        .setHeader(
          "Retry-After",
          String(Math.ceil(reservationRetryAfterMs(acquiredClaim) / 1_000)),
        )
        .json({
          ...(observation?.authoritativeTaskId
            ? {
                task: {
                  id: observation.authoritativeTaskId,
                  status:
                    acquiredClaim.state === "completed"
                      ? "completed"
                      : "running",
                },
              }
            : {}),
          observation,
          progress: observation?.interaction.progress || null,
          interaction:
            observation?.interaction ||
            deriveKnowledgeBaseInteraction(null, "running"),
          idempotent: true,
        });
      return;
    }

    const officialLogoRequired = knowledgeBaseBuildRequiresOfficialLogo(build);
    if (
      !officialLogoRequired &&
      knowledgeBaseManifestRepeatsOfficialLogo(build, attachmentManifest)
    ) {
      const message =
        "该图片与已绑定的企业主 Logo 完全相同，无需作为普通补图再次上传";
      await cancelUnpreparedKnowledgeBaseTurn({
        userId: req.frontmindUser.id,
        turnId: acquiredClaim.turn.id,
        clientRequestId,
        leaseToken: acquiredClaim.leaseToken,
        code: "KNOWLEDGE_BASE_DUPLICATE_LOGO_UPLOAD",
        message,
      });
      throw new KnowledgeBaseTurnReservationError("INVALID_REQUEST", message);
    }

    let acceptedClaim: KnowledgeBaseRecoveryClaim = acquiredClaim;
    if (officialLogoRequired) {
      const stagedAttachments = normalizeKnowledgeBaseUserAttachments(
        Array.isArray(acquiredClaim.recoveryMetadata.attachments)
          ? (acquiredClaim.recoveryMetadata
              .attachments as KnowledgeBaseAttachment[])
          : [],
      );
      const manifestItem = attachmentManifest[0];
      const attachment = stagedAttachments[0];
      if (
        attachmentManifest.length !== 1 ||
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
          "INVALID_REQUEST",
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
            sourceSha256: manifestItem.sha256,
          },
        });
        acceptedClaim = {
          ...acquiredClaim,
          recoveryMetadata: {
            ...acquiredClaim.recoveryMetadata,
            officialLogoUpload: verifiedLogo,
          },
        };
      } catch (error) {
        const message =
          error instanceof Error
            ? error.message
            : "企业官方主 Logo 校验失败，请重新上传";
        if (
          error instanceof KnowledgeBaseArtifactBindingError &&
          error.code === "LOGO_UPLOAD_INVALID"
        ) {
          await cancelUnpreparedKnowledgeBaseTurn({
            userId: req.frontmindUser.id,
            turnId: acquiredClaim.turn.id,
            clientRequestId,
            leaseToken: acquiredClaim.leaseToken,
            code: "KNOWLEDGE_BASE_LOGO_UPLOAD_INVALID",
            message,
          });
        }
        throw new KnowledgeBaseTurnReservationError(
          error instanceof KnowledgeBaseArtifactBindingError &&
          error.code === "LOGO_UPLOAD_INVALID"
            ? "INVALID_REQUEST"
            : "CONFLICT",
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
      task: { id: acquiredClaim.turn.id, status: "running" },
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
      credential: taskCredential,
      outcomeUnknownCode: "TURN_DISPATCH_OUTCOME_UNKNOWN",
    });
  } catch (error) {
    if (error instanceof KnowledgeBaseTurnReservationError) {
      const observation = req.frontmindUser
        ? await getKnowledgeBaseObservation({
            userId: req.frontmindUser.id,
            conversationId,
            upstreamStatus: "running",
          }).catch(() => null)
        : null;
      res
        .status(
          error.code === "RESERVATION_NOT_FOUND"
            ? 404
            : error.code === "INVALID_REQUEST"
              ? 400
              : 409,
        )
        .json({
          error: { code: error.code, message: error.message },
          ...(observation ? { observation } : {}),
        });
      return;
    }
    res.status(502).json({
      error: {
        code: "KNOWLEDGE_BASE_TURN_DISPATCH_FAILED",
        message: "本轮提交失败，请稍后重试",
      },
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
  };
  const conversationId = String(body.conversationId || "").trim();
  const clientRequestId = String(body.clientRequestId || "").trim();
  const userMessage = String(body.userMessage || "").slice(0, 2_000_000);
  const expectedGeneration = body.expectedGeneration;
  const expectedRevision = body.expectedRevision;
  const expectedLeafId = String(body.expectedLeafId || "").trim();
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
    !req.frontmindUser ||
    !(await requireKnowledgeBuildCapability(req.frontmindUser.id, res))
  ) {
    return;
  }
  if (
    !body.attachments?.length &&
    isAmbiguousKnowledgeBaseAdvance(userMessage)
  ) {
    res.status(422).json({
      error: {
        code: "AMBIGUOUS_KNOWLEDGE_BASE_ACTION",
        message:
          "“继续/下一步”不会推进知识节点。请点击“确认当前内容”；如需修改，请直接输入意见或上传资料。",
      },
    });
    return;
  }

  try {
    await assertKnowledgeBaseWritable(req.frontmindUser!.id);
    const authoritativeBuild = await loadKnowledgeBaseBuildRecord(
      req.frontmindUser!.id,
      conversationId,
    );
    const taskId = String(authoritativeBuild?.upstreamTaskId || "");
    if (!authoritativeBuild || !taskId) {
      res.status(409).json({
        error: {
          code: "KNOWLEDGE_BASE_TASK_NOT_BOUND",
          message: "当前知识库尚未绑定可恢复任务，请先同步状态",
        },
      });
      return;
    }
    const boundBuild = await assertKnowledgeBaseTaskBinding({
      userId: req.frontmindUser!.id,
      conversationId,
      taskId,
    });
    assertKnowledgeBaseExpectedGeneration({
      expectedGeneration,
      actualGeneration: boundBuild.generation,
    });
    const taskCredential = await getCredentialForUpstreamResource(
      req.frontmindUser!.id,
      "task",
      taskId,
    );
    if (!taskCredential) {
      res.status(403).json({
        error: {
          code: "UPSTREAM_RESOURCE_FORBIDDEN",
          message: "当前知识库任务不属于此账号",
        },
      });
      return;
    }
    const attachments = normalizeKnowledgeBaseUserAttachments(body.attachments);
    const resumeLegacyAttachments = body.resumeLegacyAttachments === true;
    const attachmentManifest = attachments.length
      ? body.attachmentManifest === undefined
        ? undefined
        : normalizeKnowledgeBaseClientAttachmentManifest(
            body.attachmentManifest,
          )
      : undefined;
    assertKnowledgeBaseAttachmentManifestPresent({
      skillVersion: boundBuild.skillVersion,
      attachmentCount: attachments.length,
      attachmentManifest,
    });
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
    for (const attachment of attachments) {
      const fileCredential = await getCredentialForUpstreamResource(
        req.frontmindUser!.id,
        "file",
        attachment.file_id,
      );
      if (
        !fileCredential ||
        !credentialsUseSameUpstreamApiKey(fileCredential, taskCredential)
      ) {
        res.status(403).json({
          error: {
            code: "KNOWLEDGE_BASE_FILE_FORBIDDEN",
            message: "上传资料与当前知识库任务不匹配，请重新上传",
          },
        });
        return;
      }
    }
    const capturedImageMetadata = new Map<
      number,
      { width: number; height: number }
    >();
    if (attachmentManifest) {
      for (let index = 0; index < attachments.length; index += 1) {
        const attachment = attachments[index]!;
        const expected = attachmentManifest[index]!;
        const stored = await readStoredPresalesFile(attachment.file_id);
        if (
          !stored ||
          stored.filename !== expected.filename ||
          stored.sizeBytes !== expected.sizeBytes ||
          stored.sha256?.toLowerCase() !== expected.sha256
        ) {
          throw new KnowledgeBaseTurnReservationError(
            "INVALID_REQUEST",
            `附件“${expected.filename}”的本地完整性记录不匹配，请重新上传`,
          );
        }
        if (expected.mimeType.startsWith("image/")) {
          try {
            const image = await assertCapturedKnowledgeBaseCustomerImage({
              fileId: attachment.file_id,
              filename: expected.filename,
              mimeType: expected.mimeType,
              sizeBytes: expected.sizeBytes,
              sourceSha256: expected.sha256,
            });
            capturedImageMetadata.set(index, {
              width: image.width,
              height: image.height,
            });
          } catch {
            throw new KnowledgeBaseTurnReservationError(
              "INVALID_REQUEST",
              `附件“${expected.filename}”不是可安全保留的图片，请重新选择原文件`,
            );
          }
        }
      }

      const officialLogoRequired =
        knowledgeBaseBuildRequiresOfficialLogo(boundBuild);
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
      if (officialLogoRequired) {
        const image = capturedImageMetadata.get(0);
        if (!image || image.width < 256 || image.height < 256) {
          throw new KnowledgeBaseTurnReservationError(
            "INVALID_REQUEST",
            `企业主 Logo 位图宽高均需至少 256 像素；当前为 ${image?.width || 0}×${image?.height || 0}`,
          );
        }
      }
      assertKnowledgeBaseManifestDoesNotRepeatOfficialLogo(
        boundBuild,
        attachmentManifest,
      );

      const incomingImageHashes = attachmentManifest
        .filter(
          (entry) =>
            entry.mimeType.startsWith("image/") &&
            !(
              officialLogoRequired &&
              entry.sha256 === attachmentManifest[0]?.sha256
            ),
        )
        .map((entry) => entry.sha256);
      if (incomingImageHashes.length > 0) {
        const existingCustomerUploads =
          await declaredKnowledgeBaseCustomerUploadsForBuild({
            userId: req.frontmindUser!.id,
            buildId: boundBuild.id,
            generation: boundBuild.generation,
            officialLogoSha256: boundBuild.logoSha256,
          });
        const uniqueHashes = new Set(
          existingCustomerUploads.map((entry) => entry.sourceSha256),
        );
        incomingImageHashes.forEach((sha256) => uniqueHashes.add(sha256));
        if (uniqueHashes.size > MAX_KNOWLEDGE_BASE_CUSTOMER_UPLOAD_IMAGES) {
          throw new KnowledgeBaseTurnReservationError(
            "INVALID_REQUEST",
            `单个知识库最多保留 ${MAX_KNOWLEDGE_BASE_CUSTOMER_UPLOAD_IMAGES} 张不同的客户补充图片`,
          );
        }
      }
    }

    const officialLogoUploadCandidate:
      | Omit<KnowledgeBaseOfficialLogoUpload, "verified">
      | undefined =
      knowledgeBaseBuildRequiresOfficialLogo(boundBuild) &&
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
    if (
      knowledgeBaseBuildRequiresOfficialLogo(boundBuild) &&
      !officialLogoUploadCandidate
    ) {
      throw new KnowledgeBaseTurnReservationError(
        "INVALID_REQUEST",
        "请先上传一张合格的企业官方主 Logo，再继续确认第一个知识节点",
      );
    }

    const action = classifyKnowledgeBaseUserAction(
      userMessage,
      attachments.length,
    );
    const currentSkillDescriptor = {
      version: boundBuild.skillVersion,
      contentHash: boundBuild.skillContentHash,
    };
    const recoveryMetadata = {
      kind: "turn",
      conversationId,
      parentTaskId: taskId,
      userMessage,
      attachments,
      skillVersion: currentSkillDescriptor.version,
      skillContentHash: currentSkillDescriptor.contentHash,
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
      requestPayload: {
        userMessage,
        attachments,
        ...(attachmentManifest ? { attachmentManifest } : {}),
        skillVersion: currentSkillDescriptor.version,
        skillContentHash: currentSkillDescriptor.contentHash,
      },
      apiCredentialId: taskCredential.id,
      userText: userMessage,
      userAttachmentCount: attachments.length,
      expectedAttachmentCount: attachments.length + 1,
      clientAttachmentManifest: attachmentManifest,
      resumeLegacyAttachmentTakeover: resumeLegacyAttachments,
      recoveryMetadata,
    });
    if (reservation.state !== "acquired") {
      const observation = await getKnowledgeBaseObservation({
        userId: req.frontmindUser!.id,
        conversationId,
        upstreamStatus:
          reservation.state === "completed" ? "completed" : "running",
      });
      res
        .status(reservation.state === "pending" ? 202 : 200)
        .setHeader(
          "Retry-After",
          String(Math.ceil(reservationRetryAfterMs(reservation) / 1_000)),
        )
        .json({
          ...(observation?.authoritativeTaskId
            ? {
                task: {
                  id: observation.authoritativeTaskId,
                  status:
                    reservation.state === "completed" ? "completed" : "running",
                },
              }
            : {}),
          progress: observation?.interaction.progress || null,
          interaction:
            observation?.interaction ||
            deriveKnowledgeBaseInteraction(null, "running"),
          observation,
          idempotent: true,
          startedAt: reservation.turn.startedAt?.getTime() || Date.now(),
        });
      return;
    }
    let verifiedOfficialLogoUpload: KnowledgeBaseOfficialLogoUpload | undefined;
    if (officialLogoUploadCandidate) {
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
      } catch (error) {
        const message =
          error instanceof Error
            ? error.message
            : "企业官方主 Logo 校验失败，请重新上传";
        if (
          error instanceof KnowledgeBaseArtifactBindingError &&
          error.code === "LOGO_UPLOAD_INVALID"
        ) {
          await cancelUnpreparedKnowledgeBaseTurn({
            userId: req.frontmindUser!.id,
            turnId: reservation.turn.id,
            clientRequestId,
            leaseToken: reservation.leaseToken,
            code: "KNOWLEDGE_BASE_LOGO_UPLOAD_INVALID",
            message,
          });
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
        throw error;
      }
    }
    const observation = await getKnowledgeBaseObservation({
      userId: req.frontmindUser!.id,
      conversationId,
      upstreamStatus: "running",
    }).catch(() => null);
    res.status(202).json({
      task: { id: reservation.turn.id, status: "running" },
      progress: observation?.interaction.progress || null,
      interaction:
        observation?.interaction ||
        deriveKnowledgeBaseInteraction(null, "running"),
      observation,
      accepted: true,
      startedAt: reservation.turn.createdAt.getTime(),
    });
    launchAcceptedKnowledgeBaseClaim({
      claim: {
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
      },
      credential: taskCredential,
      outcomeUnknownCode: "TURN_DISPATCH_OUTCOME_UNKNOWN",
    });
  } catch (error) {
    if (error instanceof KnowledgeBaseTurnReservationError) {
      res
        .status(
          error.code === "BUILD_NOT_FOUND"
            ? 404
            : error.code === "INVALID_REQUEST"
              ? 400
              : 409,
        )
        .json({
          error: { code: error.code, message: error.message },
        });
      return;
    }
    const status =
      error instanceof KnowledgeBaseBuildError &&
      error.code === "BUILD_NOT_FOUND"
        ? 404
        : 422;
    res.status(status).json({
      error: {
        code:
          error instanceof KnowledgeBaseBuildError
            ? error.code
            : "KNOWLEDGE_BASE_TURN_FAILED",
        message:
          error instanceof Error
            ? error.message
            : "当前知识节点提交失败，请稍后重试",
      },
    });
  }
});

router.post("/retry", async (req, res) => {
  const body = (req.body || {}) as {
    conversationId?: string;
    clientRequestId?: string;
    expectedGeneration?: number;
    expectedRevision?: number;
    expectedLeafId?: string | null;
  };
  const conversationId = String(body.conversationId || "").trim();
  const clientRequestId = String(body.clientRequestId || "").trim();
  const expectedGeneration = body.expectedGeneration;
  const expectedRevision = body.expectedRevision;
  const hasExpectedLeaf = Object.prototype.hasOwnProperty.call(
    body,
    "expectedLeafId",
  );
  const expectedLeafId =
    body.expectedLeafId === null
      ? null
      : String(body.expectedLeafId || "").trim() || null;
  if (
    !conversationId ||
    !clientRequestId ||
    clientRequestId.length > 128 ||
    !Number.isSafeInteger(expectedGeneration) ||
    Number(expectedGeneration) < 1 ||
    !Number.isSafeInteger(expectedRevision) ||
    Number(expectedRevision) < 0 ||
    !hasExpectedLeaf
  ) {
    res.status(400).json({
      error: {
        code: "INVALID_KNOWLEDGE_BASE_RETRY",
        message: "重试坐标无效，请刷新知识库状态后再试",
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
    const retry = await reserveKnowledgeBaseRetryTurn({
      userId: req.frontmindUser.id,
      conversationId,
      clientRequestId,
      expectedGeneration: Number(expectedGeneration),
      expectedRevision: Number(expectedRevision),
      expectedLeafId,
    });
    const { reservation } = retry;
    if (reservation.state !== "acquired") {
      const observation = await getKnowledgeBaseObservation({
        userId: req.frontmindUser.id,
        conversationId,
        upstreamStatus:
          reservation.state === "completed" ? "completed" : "running",
      });
      res
        .status(reservation.state === "pending" ? 202 : 200)
        .setHeader(
          "Retry-After",
          String(Math.ceil(reservationRetryAfterMs(reservation) / 1_000)),
        )
        .json({
          ...(observation?.authoritativeTaskId
            ? {
                task: {
                  id: observation.authoritativeTaskId,
                  status:
                    reservation.state === "completed" ? "completed" : "running",
                },
              }
            : {}),
          progress: observation?.interaction.progress || null,
          interaction:
            observation?.interaction ||
            deriveKnowledgeBaseInteraction(null, "running"),
          observation,
          idempotent: true,
          startedAt: reservation.turn.startedAt?.getTime() || Date.now(),
        });
      return;
    }
    if (!reservation.turn.apiCredentialId) {
      throw new KnowledgeBaseTurnReservationError(
        "CONFLICT",
        "失败任务缺少可恢复的凭证绑定",
      );
    }
    const credential = await getDecryptedCredentialForKnowledgeBaseReservation({
      userId: req.frontmindUser.id,
      turnId: reservation.turn.id,
      buildId: reservation.turn.buildId!,
      buildGeneration: reservation.turn.buildGeneration!,
      apiCredentialId: reservation.turn.apiCredentialId,
    });
    if (!credential) {
      throw new KnowledgeBaseTurnReservationError(
        "CONFLICT",
        "失败任务使用的 API 凭证版本已不可用",
      );
    }
    const claim: KnowledgeBaseRecoveryClaim = {
      turn: reservation.turn,
      leaseToken: reservation.leaseToken,
      leaseExpiresAt: reservation.leaseExpiresAt,
      upstreamIdempotencyKey: reservation.upstreamIdempotencyKey,
      recoveryMetadata: retry.recoveryMetadata,
      preparedDispatch: retry.preparedDispatch,
    };
    let dispatched: Awaited<
      ReturnType<typeof dispatchKnowledgeBaseRecoveryClaim>
    >;
    try {
      dispatched = await dispatchKnowledgeBaseRecoveryClaim(claim, credential);
    } catch (error) {
      await persistKnowledgeBaseCreateFailure({
        userId: req.frontmindUser.id,
        turnId: reservation.turn.id,
        leaseToken: reservation.leaseToken,
        error,
        outcomeUnknownCode: "RETRY_DISPATCH_OUTCOME_UNKNOWN",
      }).catch(() => undefined);
      throw error;
    }
    const observation = await getKnowledgeBaseObservation({
      userId: req.frontmindUser.id,
      conversationId,
      upstreamStatus: "running",
    });
    res.json({
      task: { id: dispatched.taskId, status: "running" },
      progress: observation?.interaction.progress || null,
      interaction:
        observation?.interaction ||
        deriveKnowledgeBaseInteraction(null, "running"),
      observation,
      retried: true,
      startedAt: Date.now(),
    });
  } catch (error) {
    if (error instanceof KnowledgeBaseUpstreamCreateError) {
      const observation = await getKnowledgeBaseObservation({
        userId: req.frontmindUser!.id,
        conversationId,
        upstreamStatus:
          error.failureClass === "deterministic" ? "failed" : "running",
      }).catch(() => null);
      res.status(error.status || 502).json({
        error: {
          code: error.failureCode,
          message:
            error.failureClass === "deterministic"
              ? deterministicKnowledgeBaseCreateFailureMessage(error)
              : "当前知识节点重试结果暂不明确，系统将按原预约自动恢复",
        },
        ...(observation ? { observation } : {}),
      });
      return;
    }
    if (error instanceof KnowledgeBaseTurnReservationError) {
      res
        .status(
          error.code === "BUILD_NOT_FOUND"
            ? 404
            : error.code === "INVALID_REQUEST"
              ? 400
              : 409,
        )
        .json({ error: { code: error.code, message: error.message } });
      return;
    }
    res.status(502).json({
      error: {
        code: "KNOWLEDGE_BASE_RETRY_FAILED",
        message:
          error instanceof Error
            ? error.message
            : "当前知识节点重试失败，请稍后重试",
      },
    });
  }
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
    res.status(400).json({
      error: error instanceof Error ? error.message : "读取知识库进度失败",
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
    const currentObservation = await getKnowledgeBaseObservation({
      userId: req.frontmindUser.id,
      conversationId,
      upstreamStatus: "running",
    });
    const immutableStatus =
      currentObservation?.interaction.progress?.build.status;
    const recoverableArtifactNotice =
      knowledgeBaseProtocolErrorAllowsSameTaskRecovery(
        currentObservation?.notice?.code,
      );
    const immutableProjection =
      immutableStatus === "ready_to_publish" ||
      immutableStatus === "published" ||
      (!recoverableArtifactNotice &&
        (immutableStatus === "protocol_error" || immutableStatus === "failed"));
    const preserveRecoverableArtifactObservation = () => {
      if (!recoverableArtifactNotice || !currentObservation) return false;
      res.json({
        progress: currentObservation.interaction.progress,
        interaction: currentObservation.interaction,
        observation: currentObservation,
      });
      return true;
    };
    if (currentObservation && immutableProjection) {
      res.json({
        progress: currentObservation.interaction.progress,
        interaction: currentObservation.interaction,
        observation: currentObservation,
      });
      return;
    }
    if (isApprovedKnowledgeBaseAwaitingInputObservation(currentObservation)) {
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
    const credential = await getCredentialForUpstreamResource(
      req.frontmindUser!.id,
      "task",
      taskId,
    );
    if (!credential) {
      if (preserveRecoverableArtifactObservation()) return;
      const failure = await observeKnowledgeBaseUpstreamFailure({
        userId: req.frontmindUser!.id,
        conversationId,
        taskId,
        code: "UPSTREAM_CREDENTIAL_UNAVAILABLE",
        message: "知识库任务凭证已失效，请重新配置凭证后联系管理员恢复本轮",
        status: "failed",
      });
      if (failure.durable && failure.observation) {
        res.json({
          progress: failure.observation.interaction.progress,
          interaction: failure.observation.interaction,
          observation: failure.observation,
        });
      } else {
        res.status(503).json({
          error: {
            code: "UPSTREAM_CREDENTIAL_UNAVAILABLE",
            message: "知识库任务凭证暂不可用，正在保留并复核当前状态",
          },
        });
      }
      return;
    }
    let taskResponse;
    try {
      taskResponse = await axios.get(
        `${getUpstreamBaseUrl(req)}/v1/tasks/${encodeURIComponent(taskId)}`,
        {
          headers: {
            API_KEY: credential.apiKey,
            Authorization: `Bearer ${credential.apiKey}`,
          },
          timeout: 120000,
          validateStatus: () => true,
        },
      );
    } catch {
      taskResponse = null;
    }
    if (!taskResponse) {
      if (preserveRecoverableArtifactObservation()) return;
      const failure = await observeKnowledgeBaseUpstreamFailure({
        userId: req.frontmindUser!.id,
        conversationId,
        taskId,
        code: "UPSTREAM_TASK_READ_FAILED",
        message: "读取知识库任务结果持续失败，本轮状态和最后正确正文已保留",
      });
      if (failure.durable && failure.observation) {
        res.json({
          progress: failure.observation.interaction.progress,
          interaction: failure.observation.interaction,
          observation: failure.observation,
        });
      } else {
        res.status(503).json({
          error: {
            code: "UPSTREAM_TASK_READ_FAILED",
            message: "读取知识库任务结果失败，正在自动重试",
          },
        });
      }
      return;
    }
    if (taskResponse.status < 200 || taskResponse.status >= 300) {
      if (preserveRecoverableArtifactObservation()) return;
      const credentialFailure = [401, 403].includes(taskResponse.status);
      const failure = await observeKnowledgeBaseUpstreamFailure({
        userId: req.frontmindUser!.id,
        conversationId,
        taskId,
        code: credentialFailure
          ? "UPSTREAM_CREDENTIAL_REJECTED"
          : "UPSTREAM_TASK_READ_FAILED",
        message: credentialFailure
          ? "上游已拒绝当前知识库任务凭证，请重新配置后联系管理员恢复"
          : "读取知识库任务结果持续失败，本轮状态和最后正确正文已保留",
        status: credentialFailure ? "failed" : "protocol_error",
      });
      if (failure.durable && failure.observation) {
        res.json({
          progress: failure.observation.interaction.progress,
          interaction: failure.observation.interaction,
          observation: failure.observation,
        });
      } else {
        res.status(503).json({
          error: {
            code: credentialFailure
              ? "UPSTREAM_CREDENTIAL_REJECTED"
              : "UPSTREAM_TASK_READ_FAILED",
            message: "读取知识库任务结果失败，正在自动重试",
          },
        });
      }
      return;
    }
    const taskData = canonicalKnowledgeBaseUpstreamTask(taskResponse.data);
    const taskStatus = normalizedUpstreamTaskStatus(taskData.status);
    const fullOutput = normalizeRecoveredTaskOutput(taskData);
    await recordKnowledgeBaseOutputFiles({
      userId: req.frontmindUser!.id,
      apiCredentialId: credential.id,
      output: fullOutput,
    });
    const progress = await reconcileAvailableKnowledgeOutput({
      userId: req.frontmindUser!.id,
      conversationId,
      taskId,
      output: fullOutput,
      upstreamStatus: taskStatus,
      ledger: {
        lastOutputLength: boundBuild.lastOutputLength,
        lastOutputItemIds: boundBuild.lastOutputItemIds,
      },
      artifactAccess: {
        apiKey: credential.apiKey,
        baseUrl: getUpstreamBaseUrl(req),
      },
    });
    const observation = await getKnowledgeBaseObservation({
      userId: req.frontmindUser!.id,
      conversationId,
      upstreamStatus: taskStatus,
    });
    res.json({
      progress: observation?.interaction.progress || progress,
      interaction:
        observation?.interaction ||
        deriveKnowledgeBaseInteraction(progress, taskStatus),
      observation,
    });
  } catch (error) {
    const status =
      error instanceof KnowledgeBaseBuildError &&
      error.code === "BUILD_NOT_FOUND"
        ? 404
        : 422;
    res.status(status).json({
      error: {
        code:
          error instanceof KnowledgeBaseBuildError
            ? error.code
            : "PROGRESS_PROTOCOL_INVALID",
        message:
          error instanceof Error ? error.message : "知识库节点状态未通过校验",
      },
    });
  }
});

export default router;
