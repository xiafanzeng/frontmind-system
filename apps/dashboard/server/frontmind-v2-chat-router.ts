import { generalFinalAnswerEventIds } from "./frontmind-general-execution";
import { lockCustomerProjectBusinessWrite } from "./customer-project-write-access";
import { loadGeneralExecutions } from "./frontmind-general-execution";
import { orderGeneralChatMessages } from "../shared/general-chat-message-order";
import { generalExecutionActivity } from "../shared/frontmind-general-execution";
import { enterpriseConversationStoragePrefix } from "./enterprise-conversation-storage";
import { aiBillingHttpFailure, sendAiBillingError } from "./ai-billing-http";
import { AiBillingError, assertAiAccountFunds } from "./ai-billing-service";
import { generalChatDispatchIsDefinitelyRejected, generalChatHasPersistedPreSendBalanceRefusal, generalChatHttpErrorMessage } from "./general-chat-dispatch-failure";
import { enterpriseProjectPredicate, enterpriseOwnerPredicate, enterpriseProjectUrl } from "./enterprise-project-scope";
import { currentEnterpriseProjectId, enterpriseWorkspaceUserId, getEnterpriseProjectScope } from "./enterprise-project-context";
import { createHash, randomUUID } from "node:crypto";
import type { Readable } from "node:stream";

import axios from "axios";
import { and, desc, eq, gt, gte, inArray, isNull, or } from "drizzle-orm";
import { Router, type Response } from "express";
import { z } from "zod";

import {
  agentEvents,
  agentOperations,
  agentTasks,
  artifacts,
  attachments as conversationAttachments,
  conversations,
  conversationTurns,
  localAssets,
  messages,
  providerFileLeases,
  siteBuilds,
  siteProjects,
} from "../drizzle/schema";
import { getDecryptedCredentialForAccountById } from "./auth-service";
import type { DecryptedCredential } from "./auth-service";
import { createCredentialAgentClient } from "./credential-agent-client";
import { getDb } from "./db";
import {
  latestManusV2WaitingDetail,
  ManusV2ApiError,
  ManusV2Client,
  orderManusV2EventsByProviderRank,
  type ManusV2MessageEvent,
} from "./manus-v2-client";
import {
  currentGeneralChatTurnProviderEvidence,
  generalChatAssistantProjectionShouldBeVisible,
  generalChatProjectionClaimMatches,
  generalChatProjectionSnapshotClaimDecision,
  generalChatProjectionWatermarkScore,
  generalChatTurnBindingFromDispositions,
  generalChatProviderEventEvidence,
  selectGeneralChatProjectionCandidate,
  settleGeneralChatTurn,
  type GeneralChatResolvedTurnBinding,
  type GeneralChatResolvedUserEventDisposition,
  type GeneralChatProjectionClaimState,
  type GeneralChatProjectionSnapshot,
} from "./general-chat-terminal-arbitration";
import {
  arbitrateFirstDurableGeneralChatProviderAttachmentEvidence,
  generalChatProviderEvidenceHasUniqueMatch,
  resolveManusV2GeneralChatUserEventEvidence,
  type GeneralChatLocalAttachmentManifestItem,
  type GeneralChatProviderAttachmentReader,
  type GeneralChatUserEventEvidenceDisposition,
} from "./manus-v2-user-attachment-evidence";
import {
  readStoredPresalesFile,
  recordPresalesFileDescriptor,
  removeStoredPresalesFile,
  stagePresalesFileContent,
  withStoredPresalesFileMutationLock,
} from "./presales-file-store";
import { sealLocalAssetStorageIdentity } from "./local-asset-storage-key";
import {
  KnowledgeBaseLocalAssetCoordinateError,
  knowledgeBaseLocalAssetExistingRowDisposition,
  knowledgeBaseLocalAssetIdentity,
  parseKnowledgeBaseLocalUploadCoordinate,
  type KnowledgeBaseLocalAssetStoredContentState,
} from "./knowledge-base-local-asset-upload";
import {
  assertKnowledgeBaseLocalUploadCoordinate,
  KnowledgeBaseTurnReservationError,
} from "./knowledge-base-turn-service";
import {
  parseSiteOpsComposerLocalUploadCoordinate,
  SiteOpsComposerLocalAssetCoordinateError,
  siteOpsComposerLocalAssetExistingRowDisposition,
  siteOpsComposerLocalAssetIdentity,
} from "./siteops-composer-local-asset-upload";
import {
  OwnedFileContentError,
  ownedFileContentResolver,
} from "./owned-file-content-resolver";
import {
  assertSafeExternalUrl,
  safeExternalRequestOptions,
} from "./_core/safe-external-url";
import { sanitizeFrontMindPublicText } from "../shared/frontmind-public-brand";
import { stripFrontMindGeneralChatOperationContract } from "../shared/frontmind-general-chat-contract";
import {
  canonicalizeGeneralChatAssistantMarkdown,
  type GeneralChatAssistantArtifactBinding,
} from "../shared/frontmind-general-chat-markdown";
import { GENERAL_CHAT_PARTIAL_RESULT_ERROR_CODE } from "../shared/frontmind-general-chat-terminal";
import {
  generalAgentModelProfileSchema,
  type GeneralAgentModelProfile,
} from "../shared/manus-agent-profile";
import {
  generalAgentRuntimeForCredential,
  generalAgentRuntimeForOperation,
  generalAgentRuntimeForSelection,
} from "./general-agent-runtime";
import { getUpstreamBaseUrl } from "./upstream-config";
import {
  createGeneralChatPreparationClaim,
  generalChatPreparationClaimIsStale,
} from "./general-chat-preparation-claim";
import { validateGeneralChatDispatchMetadata } from "./general-chat-dispatch-validation";
import {
  enterpriseQaSystemContext,
  frozenGeneralAgentPurpose,
  generalAgentPurposePublic,
  generalAgentKnowledgeAttachment,
  publishedGeneralAgentKnowledge,
  type FrozenGeneralAgentPurpose,
} from "./general-agent-purpose";
import {
  contentProductionInputSchema,
  contentProductionActionSchema,
} from "../shared/content-production";
import type {
  ContentProductionInput,
  ContentProductionAction,
} from "../shared/content-production";
import { CONTENT_PRODUCTION_LANGUAGE_CONTEXT } from "../shared/content-production-public";
import { contentProductionPresentationArtifact } from "./content-production-artifact-presentation";
import {
  contentProductionSystemAttachments,
  contentProductionSystemContext,
  isContentWorkflowInternalFilename,
  isContentWorkflowStateFilename,
  originalContentWorkflowArchive,
} from "./content-production-runtime";
import {
  contentProductionPublicDto,
  parseContentRunnerState,
  persistContentProductionObservations,
  type ContentRunnerObservation,
} from "./content-production-state";

const router = Router();

const CHAT_CONTRACT = "dashboard.general-chat";
const CHAT_CONTRACT_REVISION = 2;
const CHAT_SCHEMA_HASH = createHash("sha256")
  .update("dashboard.general-chat:v2:local-task-local-message-local-artifact")
  .digest("hex");
const MAX_LOCAL_ASSET_BYTES = 100 * 1024 * 1024;
const MAX_SITEOPS_COMPOSER_ASSET_BYTES = 8 * 1024 * 1024;
const MAX_ARTIFACT_BYTES = 64 * 1024 * 1024;
const LOCAL_CONTENT_RETENTION_MS = 30 * 24 * 60 * 60 * 1_000;
const RESULT_GRACE_MS = 120_000;
const GENERAL_CHAT_TURN_TYPE = "general_chat_v2";
const GENERAL_CHAT_PROJECTION_CLAIM_STALE_MS = 5 * 60_000;

const taskCreateSchema = z
  .object({
    conversationId: z.string().trim().min(1).max(191),
    clientRequestId: z.string().trim().min(1).max(128),
    prompt: z.string().trim().min(1).max(2_000_000),
    modelProfile: generalAgentModelProfileSchema.default("frontmind-base"),
    purpose: z.enum(["enterprise_qa", "content_production"]).optional(),
    contentProduction: contentProductionInputSchema.optional(),
    localAssetIds: z
      .array(z.string().trim().min(1).max(36))
      .max(32)
      .default([]),
  })
  .strict();

const taskMessageSchema = taskCreateSchema
  .omit({
    conversationId: true,
    modelProfile: true,
    purpose: true,
    contentProduction: true,
  })
  .extend({
    conversationId: z.string().trim().min(1).max(191),
    contentProductionAction: contentProductionActionSchema.optional(),
  })
  .strict();

const actionSchema = z
  .object({
    clientRequestId: z.string().trim().min(1).max(128),
    confirmationInput: z.record(z.string(), z.unknown()).optional(),
  })
  .strict();

type Db = NonNullable<Awaited<ReturnType<typeof getDb>>>;
type AgentOperation = typeof agentOperations.$inferSelect;
type AgentTask = typeof agentTasks.$inferSelect;

class ChatV2HttpError extends Error {
  constructor(
    readonly code: string,
    readonly statusCode: number,
    readonly retryable = false,
    readonly dispatchSettled = false,
  ) {
    super(code);
    this.name = "ChatV2HttpError";
  }
}

function assertGeneralAgentActor(user: Express.Request["frontmindUser"]) {
  const allowed =
    user?.role === "user" ||
    user?.role === "delivery_member" ||
    (user?.role === "admin" && (user.adminAccessLevel === "delivery_admin" || Boolean(getEnterpriseProjectScope())));
  if (!allowed) throw new ChatV2HttpError("GENERAL_AGENT_ROLE_FORBIDDEN", 403);
}

function hash(value: string) {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function requestHash(value: unknown) {
  return hash(JSON.stringify(value));
}

function sortedUnique(values: readonly string[]) {
  return [...new Set(values)].sort();
}

function providerAttachmentFileIds(
  attachments: readonly { file_id?: string }[],
) {
  return sortedUnique(
    attachments.flatMap((attachment) =>
      typeof attachment.file_id === "string" ? [attachment.file_id] : [],
    ),
  );
}

function localAssetId() {
  return `asset_${randomUUID().replaceAll("-", "").slice(0, 30)}`;
}

function cleanFilename(value: unknown) {
  const decoded = (() => {
    try {
      return decodeURIComponent(String(value ?? ""));
    } catch {
      return String(value ?? "");
    }
  })();
  const cleaned = decoded.replace(/[\\/\0\r\n]/gu, "_").trim();
  return (cleaned || "attachment.bin").slice(0, 512);
}

function cleanMimeType(value: unknown) {
  const normalized = String(value ?? "application/octet-stream")
    .split(";", 1)[0]!
    .trim()
    .toLowerCase();
  return /^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/u.test(
    normalized,
  )
    ? normalized.slice(0, 255)
    : "application/octet-stream";
}

function knowledgeBaseUploadReservationError(error: unknown) {
  if (!(error instanceof KnowledgeBaseTurnReservationError)) return error;
  if (error.code === "INVALID_REQUEST") {
    return new ChatV2HttpError("KNOWLEDGE_BASE_UPLOAD_COORDINATE_INVALID", 400);
  }
  if (error.code === "KNOWLEDGE_BASE_RESET_REVISION_CHANGED") {
    return new ChatV2HttpError(error.code, 409);
  }
  return new ChatV2HttpError("UPLOAD_OPERATION_CONFLICT", 409);
}

async function storedLocalAssetContentState(input: {
  id: string;
  sizeBytes: number;
  contentSha256: string;
}): Promise<KnowledgeBaseLocalAssetStoredContentState> {
  let stored;
  try {
    stored = await readStoredPresalesFile(input.id);
  } catch (error) {
    if (
      error instanceof Error &&
      [
        "LOCAL_FILE_CONTENT_INVALID",
        "LOCAL_FILE_CONTENT_SIZE_MISMATCH",
        "PRESALES_FILE_RETENTION_INVALID",
      ].includes(error.message)
    ) {
      return "mismatched";
    }
    throw error;
  }
  if (!stored) return "missing";
  if (
    stored.sizeBytes !== input.sizeBytes ||
    (stored.recordedSizeBytes !== null &&
      stored.recordedSizeBytes !== input.sizeBytes) ||
    stored.sha256 !== input.contentSha256
  ) {
    return "mismatched";
  }
  const digest = createHash("sha256");
  let total = 0;
  for await (const chunk of stored.createReadStream()) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += bytes.length;
    if (total > input.sizeBytes || total > MAX_LOCAL_ASSET_BYTES) {
      return "mismatched";
    }
    digest.update(bytes);
  }
  return total === input.sizeBytes &&
    digest.digest("hex") === input.contentSha256
    ? "matching"
    : "mismatched";
}

async function requireDb(): Promise<Db> {
  const db = await getDb();
  if (!db) throw new ChatV2HttpError("DATABASE_UNAVAILABLE", 503, true);
  return db;
}

type SiteOpsComposerUploadEpoch = {
  projectId: string;
  currentTaskStartedAt: Date;
  knowledgeInputEpochId: string;
};

async function currentSiteOpsComposerUploadEpoch(
  db: Db,
  userId: number,
): Promise<SiteOpsComposerUploadEpoch | null> {
  const project = (
    await db
      .select()
      .from(siteProjects)
      .where(enterpriseOwnerPredicate(siteProjects, userId))
      .limit(1)
  )[0];
  if (!project?.currentBuildId || !project.knowledgeInputEpochId) return null;
  const build = (
    await db
      .select()
      .from(siteBuilds)
      .where(
        and(
          eq(siteBuilds.id, project.currentBuildId),
          eq(siteBuilds.projectId, project.id),
          eq(siteBuilds.userId, userId),
          eq(siteBuilds.workflowVersion, "2.9.0"),
          inArray(siteBuilds.status, ["preview_ready", "approved"]),
          gte(siteBuilds.createdAt, project.currentTaskStartedAt),
        ),
      )
      .limit(1)
  )[0];
  if (
    !build?.sourceLocalAssetId ||
    !build.sourceHash ||
    !build.contentPlanLocalAssetId ||
    !build.contentPlanSha256
  ) {
    return null;
  }
  return {
    projectId: project.id,
    currentTaskStartedAt: project.currentTaskStartedAt,
    knowledgeInputEpochId: project.knowledgeInputEpochId,
  };
}

function clientFor(
  credential: DecryptedCredential,
  accountUserId: number,
  operation?: AgentOperation,
  task?: AgentTask,
  intentId?: string,
  contentProductionAction?: ContentProductionAction,
) {
  const purpose = task ? frozenGeneralAgentPurpose(task, accountUserId) : null;
  return createCredentialAgentClient(credential, {
    accountUserId,
    generalIdentity: !purpose && operation?.operationType === CHAT_CONTRACT,
    ...(purpose?.purpose === "enterprise_qa"
      ? {
          systemContext: enterpriseQaSystemContext(purpose),
          systemAttachments: [generalAgentKnowledgeAttachment(purpose)!],
        }
      : {}),
    ...(purpose?.purpose === "content_production"
      ? {
          systemContext: contentProductionSystemContext(purpose),
          systemAttachments: contentProductionSystemAttachments(purpose),
          recoverableStatusArtifact: isContentWorkflowStateFilename,
          turnContext: [
            CONTENT_PRODUCTION_LANGUAGE_CONTEXT,
            contentProductionAction
              ? `The customer submitted this contentProductionAction for the current Runner revision: ${JSON.stringify(contentProductionAction)}. Apply only this original business action with its attached user material; preserve the original user text above.`
              : null,
          ].filter(Boolean).join("\n\n"),
        }
      : {}),
    ...(operation
      ? {
          operationId: operation.id,
          enterpriseProjectId: operation.enterpriseProjectId ?? null,
          intentId: operation.id,
          model: operation.upstreamModel,
          ...(operation.provider === "zhipu"
            ? {
                effort:
                  generalAgentRuntimeForOperation(operation).upstreamEffort,
              }
            : {}),
        }
      : {}),
    ...(task ? { localTaskId: task.id } : {}),
    ...(intentId ? { intentId } : {}),
  });
}

async function findOwnedTask(input: { userId: number; localTaskId: string }) {
  const db = await requireDb();
  const rows = await db
    .select({ operation: agentOperations, task: agentTasks })
    .from(agentTasks)
    .innerJoin(agentOperations, eq(agentTasks.operationId, agentOperations.id))
    .where(
      and(
        eq(agentTasks.id, input.localTaskId),
        eq(agentOperations.scope, "managed_user"),
        eq(agentOperations.accountUserId, input.userId),
            enterpriseProjectPredicate(agentOperations.enterpriseProjectId),
        eq(agentOperations.contractName, CHAT_CONTRACT),
        eq(agentOperations.contractRevision, CHAT_CONTRACT_REVISION),
      ),
    )
    .limit(1);
  if (!rows[0]) throw new ChatV2HttpError("TASK_NOT_FOUND", 404);
  return rows[0];
}

async function readOwnedLocalAssets(input: {
  userId: number;
  localAssetIds: readonly string[];
}) {
  const db = await requireDb();
  const assets = [];
  for (const id of [...new Set(input.localAssetIds)]) {
    const row = (
      await db
        .select()
        .from(localAssets)
        .where(
          and(
            eq(localAssets.id, id),
            eq(localAssets.scope, "managed_user"),
            eq(localAssets.accountUserId, input.userId),
            enterpriseProjectPredicate(localAssets.enterpriseProjectId),
          ),
        )
        .limit(1)
    )[0];
    if (!row) throw new ChatV2HttpError("LOCAL_ASSET_NOT_FOUND", 404);
    const stored = await readStoredPresalesFile(id);
    if (
      !stored ||
      stored.sizeBytes !== row.sizeBytes ||
      stored.sha256 !== row.contentSha256
    ) {
      throw new ChatV2HttpError("LOCAL_ASSET_CONTENT_INVALID", 409);
    }
    assets.push({ row, stored });
  }
  return assets;
}

async function streamToBuffer(stream: Readable, maxBytes: number) {
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const raw of stream) {
    const chunk = Buffer.isBuffer(raw) ? raw : Buffer.from(raw);
    bytes += chunk.length;
    if (bytes > maxBytes) {
      stream.destroy();
      throw new ChatV2HttpError("LOCAL_ASSET_TOO_LARGE", 413);
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks, bytes);
}

async function ensureProviderAttachments(input: {
  operation: AgentOperation;
  task: AgentTask;
  credential: NonNullable<
    Awaited<ReturnType<typeof getDecryptedCredentialForAccountById>>
  >;
  localAssetIds: readonly string[];
}) {
  const db = await requireDb();
  const assets = await readOwnedLocalAssets({
    userId: input.operation.accountUserId!,
    localAssetIds: input.localAssetIds,
  });
  const client = clientFor(
    input.credential,
    input.operation.accountUserId!,
    input.operation,
    input.task,
  );
  const attachments = [];
  for (const asset of assets) {
    const reusable = (
      await db
        .select()
        .from(providerFileLeases)
        .where(
          and(
            eq(providerFileLeases.localAssetId, asset.row.id),
            eq(providerFileLeases.apiCredentialId, input.credential.id),
            eq(providerFileLeases.credentialVersion, input.credential.version),
            eq(providerFileLeases.uploadState, "uploaded"),
            gt(
              providerFileLeases.expiresAt,
              new Date(Date.now() + 15 * 60_000),
            ),
          ),
        )
        .orderBy(desc(providerFileLeases.expiresAt))
        .limit(1)
    )[0];
    if (reusable?.providerFileId) {
      try {
        const detail = await client.fileDetail(reusable.providerFileId);
        const usableUntil = Math.floor(Date.now() / 1_000) + 15 * 60;
        if (
          detail.status === "uploaded" &&
          detail.filename === asset.row.filename &&
          detail.bytes === asset.row.sizeBytes &&
          detail.expiresAt > usableUntil
        ) {
          attachments.push({
            file_id: reusable.providerFileId,
            filename: asset.row.filename,
          });
          continue;
        }
        await db
          .update(providerFileLeases)
          .set({ uploadState: "expired" })
          .where(eq(providerFileLeases.id, reusable.id));
      } catch (error) {
        // A Provider-confirmed missing/deleted lease can always be regenerated
        // from Dashboard's immutable local bytes. Authentication, transport,
        // and malformed-response errors must remain visible rather than being
        // disguised as a fresh upload attempt under the same broken boundary.
        if (
          !(error instanceof ManusV2ApiError) ||
          !(
            error.status === 404 ||
            ["FILE_NOT_FOUND", "NOT_FOUND"].includes(error.code.toUpperCase())
          )
        ) {
          throw error;
        }
        await db
          .update(providerFileLeases)
          .set({ uploadState: "expired" })
          .where(eq(providerFileLeases.id, reusable.id));
      }
    }

    const bytes = await streamToBuffer(
      asset.stored.createReadStream(),
      MAX_LOCAL_ASSET_BYTES,
    );
    const uploaded = await client.uploadFile({
      filename: asset.row.filename,
      contentType: asset.row.mimeType,
      bytes,
    });
    await db.insert(providerFileLeases).values({
      id: randomUUID(),
      localAssetId: asset.row.id,
      apiCredentialId: input.credential.id,
      credentialVersion: input.credential.version,
      providerFileId: uploaded.fileId,
      providerRequestId: uploaded.requestId,
      uploadState: "uploaded",
      uploadedBytes: bytes.length,
      expiresAt: new Date(uploaded.detail.expiresAt * 1_000),
    });
    attachments.push({
      file_id: uploaded.fileId,
      filename: uploaded.filename,
    });
  }
  return attachments;
}

type AssistantAttachment = {
  eventId: string;
  attachmentIndex: number;
  url: string;
  filename: string;
  mimeType: string;
};

function assistantAttachments(event: ManusV2MessageEvent) {
  if (event.type !== "assistant_message") return [];
  const rawMessage =
    event.assistant_message &&
    typeof event.assistant_message === "object" &&
    !Array.isArray(event.assistant_message)
      ? (event.assistant_message as Record<string, unknown>)
      : null;
  const rawAttachments = Array.isArray(rawMessage?.attachments)
    ? rawMessage.attachments
    : [];
  return rawAttachments.flatMap<AssistantAttachment>((raw, attachmentIndex) => {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return [];
    const attachment = raw as Record<string, unknown>;
    const url = String(
      attachment.url ?? attachment.file_url ?? attachment.download_url ?? "",
    ).trim();
    if (!url) return [];
    return [
      {
        eventId: event.id,
        attachmentIndex,
        url,
        filename: cleanFilename(
          attachment.filename ?? attachment.file_name ?? attachment.name,
        ),
        mimeType: cleanMimeType(
          attachment.mime_type ?? attachment.content_type,
        ),
      },
    ];
  });
}

function artifactIdFor(input: {
  providerTaskId: string;
  eventId: string;
  attachmentIndex: number;
}) {
  return `artifact_${hash(
    `${input.providerTaskId}\0${input.eventId}\0${input.attachmentIndex}`,
  )}`;
}

async function localizeArtifact(input: {
  operation: AgentOperation;
  task: AgentTask;
  attachment: AssistantAttachment;
}) {
  if (!input.task.providerTaskId) return null;
  const db = await requireDb();
  const artifactId = artifactIdFor({
    providerTaskId: input.task.providerTaskId,
    eventId: input.attachment.eventId,
    attachmentIndex: input.attachment.attachmentIndex,
  });
  const existing = (
    await db
      .select()
      .from(artifacts)
      .where(eq(artifacts.id, artifactId))
      .limit(1)
  )[0];
  if (existing && (await readStoredPresalesFile(artifactId))) return existing;

  let response: {
    status: number;
    headers: Record<string, unknown>;
    data: Readable;
  };
  if (input.operation.provider === "zhipu") {
    const credential = await getDecryptedCredentialForAccountById(
      input.operation.accountUserId!,
      input.operation.apiCredentialId,
    );
    if (
      !credential ||
      credential.provider !== "zhipu" ||
      credential.version !== input.operation.credentialVersion ||
      !input.attachment.url.startsWith("zhipu-file:")
    ) {
      throw new ChatV2HttpError("TASK_CREDENTIAL_UNAVAILABLE", 409);
    }
    response = await clientFor(
      credential,
      input.operation.accountUserId!,
      input.operation,
      input.task,
    ).downloadArtifact!(input.attachment.url.slice("zhipu-file:".length));
  } else {
    const url = assertSafeExternalUrl(input.attachment.url);
    if (new URL(url).protocol !== "https:") {
      throw new ChatV2HttpError("UNSAFE_ARTIFACT_URL", 502);
    }
    response = await axios.get<Readable>(url, {
      ...safeExternalRequestOptions,
      responseType: "stream",
      timeout: 120_000,
      maxContentLength: MAX_ARTIFACT_BYTES,
      maxBodyLength: MAX_ARTIFACT_BYTES,
      validateStatus: () => true,
    });
  }
  if (response.status !== 200) {
    response.data.destroy();
    throw new ChatV2HttpError("ARTIFACT_DOWNLOAD_FAILED", 502, true);
  }
  const mimeType = cleanMimeType(
    response.headers["content-type"] ?? input.attachment.mimeType,
  );
  await recordPresalesFileDescriptor({
    fileId: artifactId,
    filename: input.attachment.filename,
    mimeType,
  });
  const staged = await stagePresalesFileContent({
    fileId: artifactId,
    stream: response.data,
    maxBytes: MAX_ARTIFACT_BYTES,
  });
  try {
    const now = Date.now();
    await staged.commit({
      filename: input.attachment.filename,
      mimeType,
      uploadedAt: now,
      contentExpiresAt: now + LOCAL_CONTENT_RETENTION_MS,
    });
  } catch (error) {
    await staged.discard().catch(() => undefined);
    throw error;
  }
  await db
    .insert(artifacts)
    .values({
      id: artifactId,
      operationId: input.operation.id,
      taskId: input.task.id,
      sourceEventId: input.attachment.eventId,
      attachmentIndex: input.attachment.attachmentIndex,
      filename: input.attachment.filename,
      mimeType,
      sizeBytes: staged.sizeBytes,
      contentSha256: staged.sha256,
      storageKey: `frontmind-v2:${artifactId}`,
      validationState: "valid",
      refCount: 1,
    })
    .onDuplicateKeyUpdate({
      set: {
        filename: input.attachment.filename,
        mimeType,
        sizeBytes: staged.sizeBytes,
        contentSha256: staged.sha256,
        validationState: "valid",
      },
    });
  return (
    await db
      .select()
      .from(artifacts)
      .where(eq(artifacts.id, artifactId))
      .limit(1)
  )[0]!;
}

function assistantText(event: ManusV2MessageEvent) {
  if (event.type !== "assistant_message") return "";
  const message =
    event.assistant_message &&
    typeof event.assistant_message === "object" &&
    !Array.isArray(event.assistant_message)
      ? (event.assistant_message as Record<string, unknown>)
      : null;
  const content = message?.content;
  const text =
    typeof content === "string"
      ? content
      : Array.isArray(content)
        ? content
            .flatMap((item) =>
              item && typeof item === "object" && !Array.isArray(item)
                ? [String((item as Record<string, unknown>).text ?? "")]
                : [],
            )
            .filter(Boolean)
            .join("\n")
        : "";
  return sanitizeFrontMindPublicText(
    stripFrontMindGeneralChatOperationContract(text),
  ).trim();
}

type GeneralChatProjectionTurn = {
  id: string;
  conversationId: string;
  messageSequence: number;
  attachmentFileIds: string[];
  metadata: Record<string, unknown>;
};

async function generalChatProjectionTurns(input: {
  userId: number;
  localTaskId: string;
}) {
  return (await (
    await requireDb()
  )
    .select({
      id: conversationTurns.id,
      conversationId: conversationTurns.conversationId,
      messageSequence: messages.sequence,
      attachmentFileIds: conversationTurns.attachmentFileIds,
      metadata: conversationTurns.metadata,
    })
    .from(conversationTurns)
    .innerJoin(
      messages,
      and(
        eq(messages.turnId, conversationTurns.id),
        eq(messages.conversationId, conversationTurns.conversationId),
        eq(messages.role, "user"),
      ),
    )
    .where(
      and(
        eq(conversationTurns.userId, input.userId),
        eq(conversationTurns.operationType, GENERAL_CHAT_TURN_TYPE),
        eq(conversationTurns.upstreamTaskId, input.localTaskId),
      ),
    )
    .orderBy(
      messages.sequence,
      conversationTurns.id,
    )) as GeneralChatProjectionTurn[];
}

function projectionTurnWatermark(turn: GeneralChatProjectionTurn) {
  return Array.isArray(turn.metadata.providerEventWatermark)
    ? sortedUnique(
        turn.metadata.providerEventWatermark.filter(
          (value): value is string => typeof value === "string",
        ),
      )
    : [];
}

async function generalChatLocalAttachmentManifests(input: {
  userId: number;
  turns: readonly GeneralChatProjectionTurn[];
}) {
  const ids = sortedUnique(
    input.turns.flatMap((turn) => turn.attachmentFileIds),
  );
  const rows = ids.length
    ? await (
        await requireDb()
      )
        .select({
          id: localAssets.id,
          filename: localAssets.filename,
          mimeType: localAssets.mimeType,
          sizeBytes: localAssets.sizeBytes,
          contentSha256: localAssets.contentSha256,
        })
        .from(localAssets)
        .where(
          and(
            inArray(localAssets.id, ids),
            eq(localAssets.scope, "managed_user"),
            eq(localAssets.accountUserId, input.userId),
            enterpriseProjectPredicate(localAssets.enterpriseProjectId),
            isNull(localAssets.presalesProjectId),
            or(
              isNull(localAssets.retainUntil),
              gt(localAssets.retainUntil, new Date()),
            ),
          ),
        )
    : [];
  const byId = new Map(rows.map((row) => [row.id, row]));
  return new Map(
    input.turns.map((turn) => {
      const turnIds = sortedUnique(turn.attachmentFileIds);
      const manifest = turnIds.flatMap((fileId) => {
        const row = byId.get(fileId);
        return row
          ? ([
              {
                fileId,
                sha256: row.contentSha256,
                sizeBytes: row.sizeBytes,
                filename: row.filename,
                mimeType: row.mimeType,
              },
            ] satisfies GeneralChatLocalAttachmentManifestItem[])
          : [];
      });
      return [
        turn.id,
        manifest.length === turnIds.length ? manifest : null,
      ] as const;
    }),
  );
}

async function generalChatLocalAttachmentManifest(input: {
  userId: number;
  localAssetIds: readonly string[];
}): Promise<GeneralChatLocalAttachmentManifestItem[] | null> {
  const turn: GeneralChatProjectionTurn = {
    id: "manifest-only",
    conversationId: "manifest-only",
    messageSequence: 0,
    attachmentFileIds: [...input.localAssetIds],
    metadata: {},
  };
  return (
    (
      await generalChatLocalAttachmentManifests({
        userId: input.userId,
        turns: [turn],
      })
    ).get(turn.id) ?? null
  );
}

function bindGeneralChatLocalManifestToProviderFiles(
  manifest: readonly GeneralChatLocalAttachmentManifestItem[],
  providerFileIds: readonly string[],
) {
  const ids = sortedUnique(providerFileIds);
  if (manifest.length !== ids.length) return null;
  return manifest.map((item, index) => ({
    ...item,
    fileId: ids[index]!,
  }));
}

type GeneralChatDurableUserEventDisposition = {
  eventId: string;
  kind: "match" | "mismatch" | "unresolved";
  code: string;
};

type GeneralChatProviderEventTurnAssignments = {
  assignments: Map<string, GeneralChatProjectionTurn>;
  bindings: Map<string, GeneralChatResolvedTurnBinding>;
  invalidatedTurnIds: Set<string>;
};

function uniqueLatestProjectionTurn(
  turns: readonly GeneralChatProjectionTurn[],
) {
  if (turns.length === 0) return null;
  return turns.reduce((latest, candidate) =>
    candidate.messageSequence > latest.messageSequence ? candidate : latest,
  );
}

function providerEventTurnAssignments(
  events: readonly ManusV2MessageEvent[],
  turns: readonly GeneralChatProjectionTurn[],
  dispositions: ReadonlyMap<
    string,
    readonly GeneralChatDurableUserEventDisposition[]
  >,
  watermarkAmbiguousTurnIds: ReadonlySet<string> = new Set(),
): GeneralChatProviderEventTurnAssignments {
  const assignments = new Map<string, GeneralChatProjectionTurn>();
  const bindings = new Map<string, GeneralChatResolvedTurnBinding>();
  const matchedUserTurns = new Map<string, GeneralChatProjectionTurn>();
  const invalidatedTurnIds = new Set<string>();
  for (const turn of turns) {
    const binding = watermarkAmbiguousTurnIds.has(turn.id)
      ? {
          binding: "ambiguous" as const,
          matchedUserEventId: null,
          matchCount: 0,
          unresolvedCount: 1,
        }
      : generalChatTurnBindingFromDispositions(
          (dispositions.get(turn.id) ?? []).map(
            ({ eventId, kind }): GeneralChatResolvedUserEventDisposition => ({
              eventId,
              kind,
            }),
          ),
        );
    bindings.set(turn.id, binding);
    if (binding.binding === "bound" && binding.matchedUserEventId) {
      matchedUserTurns.set(binding.matchedUserEventId, turn);
    } else {
      invalidatedTurnIds.add(turn.id);
    }
  }
  let current: GeneralChatProjectionTurn | null = null;
  for (const event of events) {
    if (event.type === "user_message") {
      current = matchedUserTurns.get(event.id) ?? null;
      continue;
    }
    if (current && (event.type === "assistant_message" || generalExecutionActivity(event.executionActivity))) {
      assignments.set(event.id, current);
    }
  }
  return { assignments, bindings, invalidatedTurnIds };
}

function persistedMessageIdForConversation(
  persistedConversationId: string,
  publicMessageId: string,
) {
  const separator = persistedConversationId.indexOf(":");
  return separator >= 0
    ? `${persistedConversationId.slice(0, separator + 1)}${publicMessageId}`
    : publicMessageId;
}

function generalChatAssistantPublicMessageId(input: {
  taskId: string;
  providerEventId: string;
}) {
  return `msg-general-chat-${hash(
    `${input.taskId}\0${input.providerEventId}`,
  )}`;
}

function generalChatProjectionArtifactCount(metadata: unknown) {
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) {
    return 0;
  }
  const record = metadata as Record<string, unknown>;
  return (
    (Array.isArray(record.outputFiles) ? record.outputFiles.length : 0) +
    (Array.isArray(record.inlineImages) ? record.inlineImages.length : 0)
  );
}

function logGeneralChatAssistantProjection(input: {
  taskId: string;
  turnId: string;
  providerEventId: string;
  messageId: string;
  action: "insert" | "update" | "delete";
  artifactCount: number;
  content: string;
}) {
  console.info("[FrontMindV2] general-chat assistant projection", {
    localTaskId: input.taskId,
    turnId: input.turnId,
    providerEventId: input.providerEventId,
    messageId: input.messageId,
    action: input.action,
    artifactCount: input.artifactCount,
    contentHash: hash(input.content),
  });
}

export async function persistAssistantProjection(input: {
  executor: any;
  operation: AgentOperation;
  task: AgentTask;
  event: ManusV2MessageEvent;
  turn: GeneralChatProjectionTurn;
  upstreamOutputId: string;
  text: string;
  rank?: number;
  isFinalAnswer?: boolean;
  localized: Array<{
    artifactId: string;
    filename: string;
    mimeType: string;
    bytes: number;
    sha256: string;
  }>;
}) {
  const userId = input.operation.accountUserId!;
  const publicMessageId = generalChatAssistantPublicMessageId({
    taskId: input.task.id,
    providerEventId: input.event.id,
  });
  const messageId = persistedMessageIdForConversation(
    input.turn.conversationId,
    publicMessageId,
  );
  const outputFiles = input.localized
    .filter((artifact) => !artifact.mimeType.startsWith("image/"))
    .map((artifact) => ({
      fileUrl: enterpriseProjectUrl(`/api/frontmind/v2/artifacts/${encodeURIComponent(artifact.artifactId)}/content`),
      fileName: artifact.filename,
      mimeType: artifact.mimeType,
    }));
  const inlineImages = input.localized
    .filter((artifact) => artifact.mimeType.startsWith("image/"))
    .map((artifact) => ({
      src: enterpriseProjectUrl(`/api/frontmind/v2/artifacts/${encodeURIComponent(artifact.artifactId)}/content`),
      alt: artifact.filename,
    }));
  const metadata = {
    // The polling DTO uses the durable agent_events row id as its output id.
    // Reusing it here lets a later hydrate replace, rather than duplicate,
    // the browser's optimistic projection of the same Provider event.
    upstreamOutputId: input.upstreamOutputId,
    ...(outputFiles.length > 0 ? { outputFiles } : {}),
    ...(inlineImages.length > 0 ? { inlineImages } : {}),
    generalChat: {
      schemaVersion: 1,
      kind: "assistant_projection",
      ...(input.isFinalAnswer === undefined ? {} : { isFinalAnswer: input.isFinalAnswer }),
      turnId: input.turn.id,
      agentTaskId: input.task.id,
      providerEventId: input.event.id,
      ...(typeof input.turn.metadata.userMessageId === "string"
        ? { userMessageId: input.turn.metadata.userMessageId }
        : {}),
      userSequence: input.turn.messageSequence,
      ...(Number.isSafeInteger(input.rank ?? input.event.providerOriginalRank)
        ? { rank: input.rank ?? input.event.providerOriginalRank }
        : {}),
      serverOwned: true,
    },
  };
  const sentAt = new Date(
    input.event.timestamp < 1_000_000_000_000
      ? input.event.timestamp * 1_000
      : input.event.timestamp,
  );
  await input.executor
    .select({ id: conversations.id })
    .from(conversations)
    .where(eq(conversations.id, input.turn.conversationId))
    .limit(1)
    .for("update");
  const existing = (
    await input.executor
      .select({
        id: messages.id,
        content: messages.content,
        metadata: messages.metadata,
        turnId: messages.turnId,
        deletedAt: messages.deletedAt,
      })
      .from(messages)
      .where(eq(messages.id, messageId))
      .limit(1)
  )[0];
  if (existing) {
    const unchanged =
      existing.content === input.text &&
      existing.turnId === input.turn.id &&
      existing.deletedAt === null &&
      requestHash(existing.metadata ?? null) === requestHash(metadata);
    if (unchanged) return;
    await input.executor
      .update(messages)
      .set({
        content: input.text,
        metadata,
        turnId: input.turn.id,
        sentAt,
        deletedAt: null,
      })
      .where(eq(messages.id, messageId));
    logGeneralChatAssistantProjection({
      taskId: input.task.id,
      turnId: input.turn.id,
      providerEventId: input.event.id,
      messageId: publicMessageId,
      action: "update",
      artifactCount: input.localized.length,
      content: input.text,
    });
    return;
  }
  const latest = (
    await input.executor
      .select({ sequence: messages.sequence })
      .from(messages)
      .where(eq(messages.conversationId, input.turn.conversationId))
      .orderBy(desc(messages.sequence))
      .limit(1)
  )[0];
  await input.executor.insert(messages).values({
    id: messageId,
    conversationId: input.turn.conversationId,
    turnId: input.turn.id,
    userId,
    role: "assistant",
    content: input.text,
    sequence: (latest?.sequence ?? -1) + 1,
    metadata,
    sentAt,
    createdAt: sentAt,
  });
  logGeneralChatAssistantProjection({
    taskId: input.task.id,
    turnId: input.turn.id,
    providerEventId: input.event.id,
    messageId: publicMessageId,
    action: "insert",
    artifactCount: input.localized.length,
    content: input.text,
  });
}

const providerAttachmentEvidenceInFlight = new Map<
  string,
  Promise<GeneralChatUserEventEvidenceDisposition>
>();

const rejectGeneralChatProviderAttachmentRead: GeneralChatProviderAttachmentReader =
  async () => {
    throw Object.assign(new Error("Provider attachment network disabled"), {
      code: "ATTACHMENT_NETWORK_DISABLED",
    });
  };

type GeneralChatProjectionClaim = {
  acquired: boolean;
  generation: number;
  claimToken: string | null;
  snapshot: GeneralChatProjectionSnapshot;
  reason: "claimed" | "in_progress" | "stale_candidate";
};

function projectionSnapshotFromPayload(
  payload: Record<string, unknown>,
  prefix: "claim" | "applied",
): GeneralChatProjectionSnapshot | null {
  const rawIds = payload[`${prefix}EventIds`];
  const snapshotHash = payload[`${prefix}SnapshotHash`];
  const maxProviderTimestampMs = payload[`${prefix}MaxProviderTimestampMs`];
  if (
    !Array.isArray(rawIds) ||
    !rawIds.every(
      (eventId): eventId is string =>
        typeof eventId === "string" &&
        eventId.length > 0 &&
        eventId.length <= 512,
    ) ||
    typeof snapshotHash !== "string" ||
    !/^[a-f0-9]{64}$/u.test(snapshotHash) ||
    !Number.isSafeInteger(maxProviderTimestampMs) ||
    Number(maxProviderTimestampMs) < 0
  ) {
    return null;
  }
  return {
    eventIds: sortedUnique(rawIds),
    snapshotHash,
    maxProviderTimestampMs: Number(maxProviderTimestampMs),
  };
}

function projectionClaimState(
  payload: Record<string, unknown>,
): GeneralChatProjectionClaimState | null {
  const generation = payload.generation;
  const status = payload.status;
  if (
    payload.kind !== "local_projection_snapshot" ||
    !Number.isSafeInteger(generation) ||
    Number(generation) < 0 ||
    !["idle", "claimed", "applied"].includes(String(status))
  ) {
    return null;
  }
  const claimedSnapshot = projectionSnapshotFromPayload(payload, "claim");
  const appliedSnapshot = projectionSnapshotFromPayload(payload, "applied");
  const claimToken =
    typeof payload.claimToken === "string" ? payload.claimToken : null;
  const claimStartedAtMs = Number.isSafeInteger(payload.claimStartedAtMs)
    ? Number(payload.claimStartedAtMs)
    : null;
  if (status === "claimed" && (!claimToken || !claimedSnapshot)) return null;
  return {
    generation: Number(generation),
    status: status as GeneralChatProjectionClaimState["status"],
    claimToken,
    claimStartedAtMs,
    claimedSnapshot,
    appliedSnapshot,
  };
}

function projectionSnapshotProviderEventId(taskId: string) {
  return `local-projection-snapshot:${taskId}`;
}

async function claimProviderProjectionSnapshot(input: {
  taskId: string;
  events: readonly ManusV2MessageEvent[];
}): Promise<GeneralChatProjectionClaim> {
  const eventIds = sortedUnique(input.events.map((event) => event.id));
  const snapshot: GeneralChatProjectionSnapshot = {
    eventIds,
    snapshotHash: requestHash({ executionVersion: 1, events: input.events }),
    maxProviderTimestampMs: input.events.reduce(
      (maximum, event) => Math.max(maximum, event.timestamp),
      0,
    ),
  };
  const providerEventId = projectionSnapshotProviderEventId(input.taskId);
  const db = await requireDb();
  await db
    .insert(agentEvents)
    .values({
      id: randomUUID(),
      taskId: input.taskId,
      providerEventId,
      eventType: "local_projection_snapshot",
      providerTimestampMs: Date.now(),
      normalizedPayload: {
        kind: "local_projection_snapshot",
        generation: 0,
        status: "idle",
      },
    })
    .onDuplicateKeyUpdate({ set: { providerEventId } });
  return db.transaction(async (tx) => {
    const row = (
      await tx
        .select()
        .from(agentEvents)
        .where(
          and(
            eq(agentEvents.taskId, input.taskId),
            eq(agentEvents.providerEventId, providerEventId),
          ),
        )
        .limit(1)
        .for("update")
    )[0];
    const payload = row?.normalizedPayload ?? {};
    const state = projectionClaimState(payload);
    if (!row || !state) {
      throw new ChatV2HttpError(
        "GENERAL_CHAT_PROJECTION_CLAIM_INVALID",
        409,
        true,
      );
    }
    const nowMs = Date.now();
    const decision = generalChatProjectionSnapshotClaimDecision({
      candidate: snapshot,
      state,
      nowMs,
      staleAfterMs: GENERAL_CHAT_PROJECTION_CLAIM_STALE_MS,
    });
    if (decision.kind !== "claim") {
      return {
        acquired: false,
        generation: decision.generation,
        claimToken: null,
        snapshot,
        reason: decision.kind,
      };
    }
    const claimToken = randomUUID();
    await tx
      .update(agentEvents)
      .set({
        normalizedPayload: {
          ...payload,
          kind: "local_projection_snapshot",
          generation: decision.generation,
          status: "claimed",
          claimToken,
          claimStartedAtMs: nowMs,
          claimEventIds: snapshot.eventIds,
          claimSnapshotHash: snapshot.snapshotHash,
          claimMaxProviderTimestampMs: snapshot.maxProviderTimestampMs,
        },
      })
      .where(eq(agentEvents.id, row.id));
    return {
      acquired: true,
      generation: decision.generation,
      claimToken,
      snapshot,
      reason: "claimed",
    };
  });
}

async function ensureProviderEventRows(input: {
  taskId: string;
  events: readonly ManusV2MessageEvent[];
}) {
  const db = await requireDb();
  for (const event of input.events) {
    await db
      .insert(agentEvents)
      .values({
        id: randomUUID(),
        taskId: input.taskId,
        providerEventId: event.id,
        eventType: event.type,
        providerTimestampMs: event.timestamp,
        normalizedPayload: { kind: "provider_event_pending" },
      })
      .onDuplicateKeyUpdate({
        // Existing Provider rows are generation-owned. Their mutable wire
        // payload, type and timestamp are updated only after the final claim
        // token check inside applyProviderProjectionSnapshot.
        set: { providerEventId: event.id },
      });
  }
}

async function providerEventRows(input: {
  taskId: string;
  eventIds: readonly string[];
}) {
  if (input.eventIds.length === 0)
    return new Map<string, typeof agentEvents.$inferSelect>();
  const rows = await (
    await requireDb()
  )
    .select()
    .from(agentEvents)
    .where(
      and(
        eq(agentEvents.taskId, input.taskId),
        inArray(agentEvents.providerEventId, [...input.eventIds]),
      ),
    );
  return new Map(rows.map((row) => [row.providerEventId, row]));
}

async function resolveProviderUserEventEvidence(input: {
  taskId: string;
  event: ManusV2MessageEvent;
  promptSha256: string;
  expectedAttachmentFileIds: readonly string[];
  localAttachmentManifest: readonly GeneralChatLocalAttachmentManifestItem[];
  cachedEvidence: unknown;
  allowNetwork: boolean;
}) {
  const resolverInput = {
    event: input.event as unknown as Record<string, unknown>,
    promptSha256: input.promptSha256,
    expectedAttachmentFileIds: input.expectedAttachmentFileIds,
    localAttachmentManifest: input.localAttachmentManifest,
    cachedEvidence: input.cachedEvidence,
  };
  const withoutNetwork = await resolveManusV2GeneralChatUserEventEvidence({
    ...resolverInput,
    readUrl: rejectGeneralChatProviderAttachmentRead,
  });
  if (
    !input.allowNetwork ||
    withoutNetwork.code !== "ATTACHMENT_DOWNLOAD_FAILED"
  ) {
    return withoutNetwork;
  }
  const inFlightKey = hash(
    `${input.taskId}\0${input.event.id}\0${requestHash(input.event)}`,
  );
  const existing = providerAttachmentEvidenceInFlight.get(inFlightKey);
  if (existing) return existing;
  const pending = resolveManusV2GeneralChatUserEventEvidence(
    resolverInput,
  ).finally(() => providerAttachmentEvidenceInFlight.delete(inFlightKey));
  providerAttachmentEvidenceInFlight.set(inFlightKey, pending);
  return pending;
}

async function persistProviderUserEventEvidence(input: {
  taskId: string;
  event: ManusV2MessageEvent;
  promptSha256: string;
  expectedAttachmentFileIds: readonly string[];
  localAttachmentManifest: readonly GeneralChatLocalAttachmentManifestItem[];
  incoming: GeneralChatUserEventEvidenceDisposition;
}): Promise<GeneralChatDurableUserEventDisposition> {
  const db = await requireDb();
  return db.transaction(async (tx) => {
    const row = (
      await tx
        .select()
        .from(agentEvents)
        .where(
          and(
            eq(agentEvents.taskId, input.taskId),
            eq(agentEvents.providerEventId, input.event.id),
          ),
        )
        .limit(1)
        .for("update")
    )[0];
    if (!row) {
      throw new ChatV2HttpError("PROVIDER_EVENT_PERSISTENCE_FAILED", 500, true);
    }
    const payload = row.normalizedPayload ?? {};
    const arbitration =
      arbitrateFirstDurableGeneralChatProviderAttachmentEvidence({
        existing: payload.providerAttachmentEvidence,
        incoming: input.incoming.evidence,
      });
    let durable: GeneralChatUserEventEvidenceDisposition;
    if (arbitration.kind === "conflict") {
      durable = {
        kind: "unresolved",
        code: "ATTACHMENT_DESCRIPTOR_CONFLICT",
        evidence: arbitration.evidence,
      };
    } else if (arbitration.kind === "accepted") {
      durable = await resolveManusV2GeneralChatUserEventEvidence({
        event: input.event as unknown as Record<string, unknown>,
        promptSha256: input.promptSha256,
        expectedAttachmentFileIds: input.expectedAttachmentFileIds,
        localAttachmentManifest: input.localAttachmentManifest,
        cachedEvidence: arbitration.evidence,
        readUrl: rejectGeneralChatProviderAttachmentRead,
      });
    } else {
      durable = input.incoming;
    }
    await tx
      .update(agentEvents)
      .set({
        normalizedPayload: {
          ...payload,
          ...(arbitration.kind === "accepted" && arbitration.evidence
            ? { providerAttachmentEvidence: arbitration.evidence }
            : {}),
          generalChatUserEventEvidence: {
            kind: durable.kind,
            code:
              arbitration.kind === "conflict" ? arbitration.code : durable.code,
          },
        },
      })
      .where(eq(agentEvents.id, row.id));
    return {
      eventId: input.event.id,
      kind: durable.kind,
      code: arbitration.kind === "conflict" ? arbitration.code : durable.code,
    };
  });
}

async function reconcileAssistantProjectionVisibility(input: {
  executor: any;
  taskId: string;
  turns: readonly GeneralChatProjectionTurn[];
  assignments: ReadonlyMap<string, GeneralChatProjectionTurn>;
  invalidatedTurnIds: ReadonlySet<string>;
}) {
  if (input.turns.length === 0) return;
  const expectedByTurn = new Map<string, Set<string>>();
  for (const [providerEventId, turn] of input.assignments) {
    const expected = expectedByTurn.get(turn.id) ?? new Set<string>();
    expected.add(providerEventId);
    expectedByTurn.set(turn.id, expected);
  }
  const rows = await input.executor
    .select({
      id: messages.id,
      turnId: messages.turnId,
      content: messages.content,
      metadata: messages.metadata,
      deletedAt: messages.deletedAt,
    })
    .from(messages)
    .where(
      and(
        eq(messages.role, "assistant"),
        inArray(
          messages.turnId,
          input.turns.map((turn) => turn.id),
        ),
      ),
    );
  for (const row of rows) {
    const generalChat =
      row.metadata?.generalChat &&
      typeof row.metadata.generalChat === "object" &&
      !Array.isArray(row.metadata.generalChat)
        ? (row.metadata.generalChat as Record<string, unknown>)
        : null;
    if (
      !row.turnId ||
      generalChat?.serverOwned !== true ||
      generalChat.kind !== "assistant_projection" ||
      generalChat.agentTaskId !== input.taskId ||
      generalChat.turnId !== row.turnId ||
      typeof generalChat.providerEventId !== "string"
    ) {
      continue;
    }
    const remainsAssigned = generalChatAssistantProjectionShouldBeVisible({
      binding: input.invalidatedTurnIds.has(row.turnId) ? "pending" : "bound",
      providerEventId: generalChat.providerEventId,
      assignedProviderEventIds:
        expectedByTurn.get(row.turnId) ?? new Set<string>(),
    });
    if (!remainsAssigned && row.deletedAt === null) {
      await input.executor
        .update(messages)
        .set({ deletedAt: new Date() })
        .where(eq(messages.id, row.id));
      logGeneralChatAssistantProjection({
        taskId: input.taskId,
        turnId: row.turnId,
        providerEventId: generalChat.providerEventId,
        messageId: generalChatAssistantPublicMessageId({
          taskId: input.taskId,
          providerEventId: generalChat.providerEventId,
        }),
        action: "delete",
        artifactCount: generalChatProjectionArtifactCount(row.metadata),
        content: row.content,
      });
    }
  }
}

type GeneralChatStagedProviderEvent = {
  event: ManusV2MessageEvent;
  normalizedPayload: Record<string, unknown>;
  projectionTurn: GeneralChatProjectionTurn | null;
  canonicalText: string;
  localized: Array<{
    artifactId: string;
    filename: string;
    mimeType: string;
    bytes: number;
    sha256: string;
  }>;
};

async function applyProviderProjectionSnapshot(input: {
  operation: AgentOperation;
  task: AgentTask;
  claim: GeneralChatProjectionClaim;
  turns: readonly GeneralChatProjectionTurn[];
  eventTurnState: GeneralChatProviderEventTurnAssignments;
  stagedEvents: readonly GeneralChatStagedProviderEvent[];
}) {
  const claimToken = input.claim.claimToken;
  if (!input.claim.acquired || !claimToken) return false;
  const db = await requireDb();
  return db.transaction(async (tx) => {
    const claimRow = (
      await tx
        .select()
        .from(agentEvents)
        .where(
          and(
            eq(agentEvents.taskId, input.task.id),
            eq(
              agentEvents.providerEventId,
              projectionSnapshotProviderEventId(input.task.id),
            ),
          ),
        )
        .limit(1)
        .for("update")
    )[0];
    const payload = claimRow?.normalizedPayload ?? {};
    const state = projectionClaimState(payload);
    if (
      !claimRow ||
      !state ||
      !generalChatProjectionClaimMatches({
        expectedGeneration: input.claim.generation,
        expectedClaimToken: claimToken,
        state,
      }) ||
      state.claimedSnapshot?.snapshotHash !== input.claim.snapshot.snapshotHash
    ) {
      return false;
    }
    const stagedEventIds = sortedUnique(
      input.stagedEvents.map(({ event }) => event.id),
    );
    if (
      stagedEventIds.length !== input.claim.snapshot.eventIds.length ||
      !stagedEventIds.every(
        (eventId, index) => eventId === input.claim.snapshot.eventIds[index],
      )
    ) {
      throw new ChatV2HttpError(
        "GENERAL_CHAT_PROJECTION_SNAPSHOT_INVALID",
        409,
        true,
      );
    }
    const persistedEventIds = new Map<string, string>();
    for (const staged of input.stagedEvents) {
      const persistedEvent = (
        await tx
          .select()
          .from(agentEvents)
          .where(
            and(
              eq(agentEvents.taskId, input.task.id),
              eq(agentEvents.providerEventId, staged.event.id),
            ),
          )
          .limit(1)
          .for("update")
      )[0];
      if (!persistedEvent) {
        throw new ChatV2HttpError(
          "PROVIDER_EVENT_PERSISTENCE_FAILED",
          500,
          true,
        );
      }
      const previous = persistedEvent.normalizedPayload ?? {};
      await tx
        .update(agentEvents)
        .set({
          eventType: staged.event.type,
          providerTimestampMs: staged.event.timestamp,
          normalizedPayload: {
            ...staged.normalizedPayload,
            ...(Object.prototype.hasOwnProperty.call(
              previous,
              "providerAttachmentEvidence",
            )
              ? {
                  providerAttachmentEvidence:
                    previous.providerAttachmentEvidence,
                }
              : {}),
            ...(Object.prototype.hasOwnProperty.call(
              previous,
              "generalChatUserEventEvidence",
            )
              ? {
                  generalChatUserEventEvidence:
                    previous.generalChatUserEventEvidence,
                }
              : {}),
          },
        })
        .where(eq(agentEvents.id, persistedEvent.id));
      persistedEventIds.set(staged.event.id, persistedEvent.id);
    }
    await reconcileAssistantProjectionVisibility({
      executor: tx,
      taskId: input.task.id,
      turns: input.turns,
      assignments: input.eventTurnState.assignments,
      invalidatedTurnIds: input.eventTurnState.invalidatedTurnIds,
    });
    const finalAnswerEvents = generalFinalAnswerEventIds(input.stagedEvents.flatMap(staged => staged.projectionTurn ? [{ id: staged.event.id, turnId: staged.projectionTurn.id, type: staged.event.type, rank: Number(staged.normalizedPayload.providerOriginalRank), activity: staged.normalizedPayload.executionActivity, hasContent: Boolean(staged.canonicalText || staged.localized.length) }] : []));
    const turnsWithLifecycle = new Set(input.stagedEvents.filter(staged => staged.projectionTurn && generalExecutionActivity(staged.normalizedPayload.executionActivity)?.kind === "status").map(staged => staged.projectionTurn!.id));
    for (const staged of input.stagedEvents) {
      const persistedEventId = persistedEventIds.get(staged.event.id);
      if (
        !staged.projectionTurn ||
        !persistedEventId ||
        (!staged.canonicalText && staged.localized.length === 0)
      ) {
        continue;
      }
      await persistAssistantProjection({
        executor: tx,
        operation: input.operation,
        task: input.task,
        event: staged.event,
        turn: staged.projectionTurn,
        upstreamOutputId: persistedEventId,
        text: staged.canonicalText,
        rank: Number(staged.normalizedPayload.providerOriginalRank),
        isFinalAnswer: turnsWithLifecycle.has(staged.projectionTurn.id) ? finalAnswerEvents.has(staged.event.id) : undefined,
        localized: staged.localized,
      });
    }
    await tx
      .update(agentEvents)
      .set({
        normalizedPayload: {
          ...payload,
          status: "applied",
          executionVersion: 1,
          appliedGeneration: input.claim.generation,
          appliedEventIds: input.claim.snapshot.eventIds,
          appliedSnapshotHash: input.claim.snapshot.snapshotHash,
          appliedMaxProviderTimestampMs:
            input.claim.snapshot.maxProviderTimestampMs,
          appliedAtMs: Date.now(),
        },
      })
      .where(eq(agentEvents.id, claimRow.id));
    return true;
  });
}

async function persistProviderEvents(input: {
  operation: AgentOperation;
  task: AgentTask;
  events: readonly ManusV2MessageEvent[];
}) {
  const waiting = latestManusV2WaitingDetail(input.events);
  const turns = await generalChatProjectionTurns({
    userId: input.operation.accountUserId!,
    localTaskId: input.task.id,
  });
  // Provider list calls are normally newest-first. Projection must instead
  // walk the wire chronology so each assistant event is bound to the user
  // turn immediately before it and durable message sequence stays monotonic.
  const orderedEvents = orderManusV2EventsByProviderRank(
    input.events,
    "oldest_first",
  );
  const projectionClaim = await claimProviderProjectionSnapshot({
    taskId: input.task.id,
    events: orderedEvents,
  });
  if (!projectionClaim.acquired) {
    return {
      ...providerEventTurnAssignments(
        orderedEvents,
        turns,
        new Map(turns.map((turn) => [turn.id, []])),
      ),
      applied: false,
      claimReason: projectionClaim.reason,
    };
  }
  await ensureProviderEventRows({
    taskId: input.task.id,
    events: orderedEvents,
  });
  const persistedRows = await providerEventRows({
    taskId: input.task.id,
    eventIds: orderedEvents.map((event) => event.id),
  });
  const localManifests = await generalChatLocalAttachmentManifests({
    userId: input.operation.accountUserId!,
    turns,
  });
  const eventIndexes = new Map(
    orderedEvents.map((event, index) => [event.id, index] as const),
  );
  const dispositionByTurn = new Map<
    string,
    GeneralChatDurableUserEventDisposition[]
  >(turns.map((turn) => [turn.id, []]));
  const watermarkAmbiguousTurnIds = new Set<string>();
  const networkEligibleTurn = uniqueLatestProjectionTurn(turns);
  let networkResolutionAttempted = false;
  for (const event of orderedEvents) {
    if (event.type !== "user_message") continue;
    const candidates = turns.filter(
      (turn) =>
        generalChatProjectionWatermarkScore({
          providerEventId: event.id,
          providerEventIndex: eventIndexes,
          providerEventWatermark: projectionTurnWatermark(turn),
        }) !== null,
    );
    const selected = selectGeneralChatProjectionCandidate({
      providerEventId: event.id,
      providerEventIndex: eventIndexes,
      candidates: candidates.map((turn) => ({
        id: turn.id,
        providerEventWatermark: projectionTurnWatermark(turn),
      })),
    });
    if (!selected) {
      if (candidates.length > 1) {
        candidates.forEach((turn) => watermarkAmbiguousTurnIds.add(turn.id));
      }
      continue;
    }
    const turn = candidates.find((candidate) => candidate.id === selected.id)!;
    const promptSha256 =
      typeof turn.metadata.promptSha256 === "string"
        ? turn.metadata.promptSha256
        : null;
    const expectedAttachmentFileIds = Array.isArray(
      turn.metadata.providerAttachmentFileIds,
    )
      ? turn.metadata.providerAttachmentFileIds.filter(
          (value): value is string => typeof value === "string",
        )
      : [];
    const localManifestRows = localManifests.get(turn.id) ?? null;
    const localManifest = localManifestRows
      ? bindGeneralChatLocalManifestToProviderFiles(
          localManifestRows,
          expectedAttachmentFileIds,
        )
      : null;
    let durable: GeneralChatDurableUserEventDisposition;
    if (!promptSha256 || !localManifest) {
      durable = {
        eventId: event.id,
        kind: "unresolved",
        code: "ATTACHMENT_EVIDENCE_INVALID",
      };
    } else {
      const cachedEvidence = persistedRows.get(event.id)?.normalizedPayload
        ?.providerAttachmentEvidence;
      const mayUseNetwork =
        networkEligibleTurn?.id === turn.id && !networkResolutionAttempted;
      let incoming = await resolveProviderUserEventEvidence({
        taskId: input.task.id,
        event,
        promptSha256,
        expectedAttachmentFileIds,
        localAttachmentManifest: localManifest,
        cachedEvidence,
        allowNetwork: false,
      });
      if (mayUseNetwork && incoming.code === "ATTACHMENT_DOWNLOAD_FAILED") {
        networkResolutionAttempted = true;
        incoming = await resolveProviderUserEventEvidence({
          taskId: input.task.id,
          event,
          promptSha256,
          expectedAttachmentFileIds,
          localAttachmentManifest: localManifest,
          cachedEvidence,
          allowNetwork: true,
        });
      }
      durable = await persistProviderUserEventEvidence({
        taskId: input.task.id,
        event,
        promptSha256,
        expectedAttachmentFileIds,
        localAttachmentManifest: localManifest,
        incoming,
      });
    }
    dispositionByTurn.get(turn.id)!.push(durable);
  }
  const eventTurnState = providerEventTurnAssignments(
    orderedEvents,
    turns,
    dispositionByTurn,
    watermarkAmbiguousTurnIds,
  );
  const stagedEvents: GeneralChatStagedProviderEvent[] = [];
  const contentStateObservations: ContentRunnerObservation[] = [];
  const isContentProduction =
    frozenGeneralAgentPurpose(input.task, input.operation.accountUserId!)
      ?.purpose === "content_production";
  // Provider text and its file list can arrive as separate events.
  const internalAttachments = isContentProduction
    ? orderedEvents
        .flatMap(assistantAttachments)
        .filter((attachment) =>
          isContentWorkflowInternalFilename(attachment.filename),
        )
    : [];
  for (const event of orderedEvents) {
    const providerEvidence = generalChatProviderEventEvidence(event);
    const providerErrorContent = providerEvidence.errorContent
      ? sanitizeFrontMindPublicText(
          stripFrontMindGeneralChatOperationContract(
            providerEvidence.errorContent,
          ),
        )
          .trim()
          .slice(0, 4_096)
      : null;
    const localized: Array<{
      artifactId: string;
      filename: string;
      mimeType: string;
      bytes: number;
      sha256: string;
    }> = [];
    const markdownBindings: GeneralChatAssistantArtifactBinding[] =
      internalAttachments.map((attachment) => ({
        artifactId: artifactIdFor({
          providerTaskId: input.task.providerTaskId ?? input.task.id,
          eventId: attachment.eventId,
          attachmentIndex: attachment.attachmentIndex,
        }),
        originalUrl: attachment.url,
        filename: attachment.filename,
        mimeType: attachment.mimeType,
        hidden: true,
      }));
    for (const attachment of assistantAttachments(event)) {
      try {
        const artifact = await localizeArtifact({
          operation: input.operation,
          task: input.task,
          attachment,
        });
        if (artifact) {
          if (
            isContentProduction &&
            isContentWorkflowInternalFilename(artifact.filename)
          ) {
            if (
              isContentWorkflowStateFilename(artifact.filename) &&
              artifact.sizeBytes <= 256 * 1024
            ) {
              const storedState = await readStoredPresalesFile(artifact.id);
              const state = storedState
                ? parseContentRunnerState(
                    await streamToBuffer(
                      storedState.createReadStream(),
                      256 * 1024,
                    ),
                  )
                : null;
              if (state)
                contentStateObservations.push({
                  state,
                  providerRank:
                    event.providerOriginalRank ?? eventIndexes.get(event.id)!,
                  eventId: event.id,
                  artifactId: artifact.id,
                  sha256: artifact.contentSha256,
                });
            }
            // Native state drives progress; the complete Job ZIP preserves current files.
            // Both are private transport, not customer deliverables.
            continue;
          }
          localized.push({
            artifactId: artifact.id,
            filename: artifact.filename,
            mimeType: artifact.mimeType,
            bytes: artifact.sizeBytes,
            sha256: artifact.contentSha256,
          });
          markdownBindings.push({
            artifactId: artifact.id,
            originalUrl: attachment.url,
            filename: artifact.filename,
            mimeType: artifact.mimeType,
          });
        }
      } catch (error) {
        console.warn("[FrontMindV2] artifact localization deferred", {
          code:
            error instanceof ChatV2HttpError
              ? error.code
              : "ARTIFACT_LOCALIZATION_FAILED",
          localTaskId: input.task.id,
        });
      }
    }
    const canonicalMarkdown = canonicalizeGeneralChatAssistantMarkdown(
      assistantText(event),
      markdownBindings,
    );
    const previousProviderEvent =
      persistedRows.get(event.id)?.normalizedPayload ?? {};
    const linkEvidenceChanged =
      previousProviderEvent.text !== canonicalMarkdown.text ||
      requestHash(previousProviderEvent.artifacts ?? []) !==
        requestHash(localized);
    if (
      linkEvidenceChanged &&
      (canonicalMarkdown.rewrittenCount > 0 ||
        canonicalMarkdown.unresolvedCount > 0 ||
        canonicalMarkdown.deduplicatedImageCount > 0)
    ) {
      console.info("[FrontMindV2] general-chat assistant links", {
        localTaskId: input.task.id,
        turnId: eventTurnState.assignments.get(event.id)?.id ?? null,
        providerEventId: event.id,
        rewrittenCount: canonicalMarkdown.rewrittenCount,
        unresolvedCount: canonicalMarkdown.unresolvedCount,
        deduplicatedImageCount: canonicalMarkdown.deduplicatedImageCount,
        matchKinds: sortedUnique(canonicalMarkdown.matchKinds),
        unresolvedKinds: sortedUnique(canonicalMarkdown.unresolvedKinds),
        unresolvedReasons: sortedUnique(canonicalMarkdown.unresolvedReasons),
        pathEvidence: [
          ...canonicalMarkdown.matchedDestinations.map(
            (destination, index) => ({
              kind: canonicalMarkdown.matchKinds[index] ?? "unknown",
              outcome: "matched",
              hash: hash(destination),
            }),
          ),
          ...canonicalMarkdown.unresolvedDestinations.map(
            (destination, index) => ({
              kind: canonicalMarkdown.unresolvedKinds[index] ?? "unknown",
              outcome: canonicalMarkdown.unresolvedReasons[index] ?? "missing",
              hash: hash(destination),
            }),
          ),
        ],
      });
    }
    const normalizedPayload: Record<string, unknown> = {
      kind: "provider_event",
      providerOriginalRank: event.providerOriginalRank ?? eventIndexes.get(event.id),
      executionActivity: generalExecutionActivity(event.executionActivity),
      executionTurn: eventTurnState.assignments.has(event.id)
        ? { id: eventTurnState.assignments.get(event.id)!.id, userSequence: eventTurnState.assignments.get(event.id)!.messageSequence, userMessageId: eventTurnState.assignments.get(event.id)!.metadata.userMessageId }
        : null,
      type: event.type,
      text: canonicalMarkdown.text,
      artifacts: localized,
      ...(providerEvidence.agentStatus
        ? {
            status_update: {
              agent_status: providerEvidence.agentStatus,
            },
          }
        : {}),
      ...(providerEvidence.errorType || providerErrorContent
        ? {
            error_message: {
              error_type: providerEvidence.errorType,
              content: providerErrorContent,
            },
          }
        : {}),
      ...(providerEvidence.userStop ? { user_stop: { observed: true } } : {}),
      ...(waiting?.statusEventId === event.id
        ? {
            action: {
              eventId: waiting.eventId,
              eventType: waiting.eventType,
              description: waiting.description,
              inputSchema: waiting.confirmInputSchema,
            },
          }
        : {}),
    };
    stagedEvents.push({
      event,
      normalizedPayload,
      projectionTurn: eventTurnState.assignments.get(event.id) ?? null,
      canonicalText: canonicalMarkdown.text,
      localized,
    });
  }
  const applied = await applyProviderProjectionSnapshot({
    operation: input.operation,
    task: input.task,
    claim: projectionClaim,
    turns,
    eventTurnState,
    stagedEvents,
  });
  if (applied && contentStateObservations.length)
    await persistContentProductionObservations({
      executor: await requireDb(),
      taskId: input.task.id,
      operationId: input.operation.id,
      userId: input.operation.accountUserId!,
      observations: contentStateObservations,
    });
  return { ...eventTurnState, applied, claimReason: projectionClaim.reason };
}

export async function cachedOutput(taskId: string, executor?: Awaited<ReturnType<typeof requireDb>>) {
  const db = executor ?? await requireDb();
  const turns = await db
      .select({
        id: conversationTurns.id,
        userMessageId: messages.id,
        userSequence: messages.sequence,
        metadata: conversationTurns.metadata,
        conversationId: conversationTurns.conversationId,
      })
      .from(conversationTurns)
      .leftJoin(messages, and(
        eq(messages.turnId, conversationTurns.id),
        eq(messages.conversationId, conversationTurns.conversationId),
        eq(messages.role, "user"),
      ))
      .where(
        and(
          eq(conversationTurns.operationType, GENERAL_CHAT_TURN_TYPE),
          eq(conversationTurns.upstreamTaskId, taskId),
        ),
      );
  const turnIds = turns.map(({ id }) => id);
  const turnsById = new Map(turns.map((turn) => [turn.id, turn]));
  const [rows, projectedMessages] = await Promise.all([
    db
      .select()
      .from(agentEvents)
      .where(eq(agentEvents.taskId, taskId))
      .orderBy(agentEvents.providerTimestampMs, agentEvents.id),
    turnIds.length
      ? db
          .select({
            content: messages.content,
            metadata: messages.metadata,
            sequence: messages.sequence,
            sentAt: messages.sentAt,
          })
          .from(messages)
          .where(
            and(
              eq(messages.role, "assistant"),
              inArray(messages.turnId, turnIds),
              isNull(messages.deletedAt),
            ),
          )
          .orderBy(messages.sequence)
      : Promise.resolve([]),
  ]);
  const eventsById = new Map(rows.map((row) => [row.id, row]));
  const visibleEventProjections = new Map<
    string,
    {
      content: string;
      messageId: string;
      sentAtMs: number;
      sequence: number;
      generalChat: {
        agentTaskId: string;
        turnId: string;
        providerEventId: string;
        userMessageId?: string;
        userSequence?: number;
        rank?: number;
      } & Record<string, unknown>;
    }
  >();
  for (const { content, metadata, sequence, sentAt } of projectedMessages) {
    const generalChat =
      metadata?.generalChat &&
      typeof metadata.generalChat === "object" &&
      !Array.isArray(metadata.generalChat)
        ? (metadata.generalChat as Record<string, unknown>)
        : null;
    if (
      generalChat?.serverOwned === true &&
      generalChat.kind === "assistant_projection" &&
      generalChat.agentTaskId === taskId &&
      typeof generalChat.turnId === "string" &&
      typeof generalChat.providerEventId === "string" &&
      typeof metadata?.upstreamOutputId === "string"
    ) {
      const turn = turnsById.get(generalChat.turnId);
      const prefix = turn?.conversationId.slice(0, turn.conversationId.indexOf(":") + 1);
      const userMessageId = turn && typeof turn.metadata?.userMessageId === "string"
        ? turn.metadata.userMessageId
        : prefix && turn?.userMessageId?.startsWith(prefix)
          ? turn.userMessageId.slice(prefix.length)
          : turn?.userMessageId;
      const event = eventsById.get(metadata.upstreamOutputId);
      const rank = event?.normalizedPayload?.providerOriginalRank;
      const { userMessageId: _oldUser, userSequence: _oldSequence, rank: _oldRank, ...identity } = generalChat;
      visibleEventProjections.set(metadata.upstreamOutputId, {
        content,
        messageId: generalChatAssistantPublicMessageId({
          taskId,
          providerEventId: generalChat.providerEventId,
        }),
        sentAtMs: sentAt.getTime(),
        sequence,
        generalChat: {
          ...identity,
          agentTaskId: taskId,
          turnId: generalChat.turnId,
          providerEventId: generalChat.providerEventId,
          ...(userMessageId ? { userMessageId } : {}),
          ...(turn?.userSequence != null ? { userSequence: turn.userSequence } : {}),
          ...(Number.isSafeInteger(rank) && Number(rank) >= 0 ? { rank: Number(rank) } : {}),
        },
      });
    }
  }
  // A previously deleted/reinserted historical projection may have a late
  // storage sequence. Turn ownership restores its place without rewriting data.
  const visibleRows = orderGeneralChatMessages(rows
    .filter((row) => visibleEventProjections.has(row.id))
    // Preserve the existing history position when a legacy turn has no user
    // anchor; provider timestamps alone must not reshuffle those rows.
    .sort((left, right) =>
      visibleEventProjections.get(left.id)!.sequence -
      visibleEventProjections.get(right.id)!.sequence,
    )
    .map((row) => ({
      ...row,
      role: "assistant",
      serverSequence: visibleEventProjections.get(row.id)!.sequence,
      generalChat: visibleEventProjections.get(row.id)!.generalChat,
    })));
  return visibleRows.flatMap((row) => {
    const payload = row.normalizedPayload ?? {};
    if (payload.kind !== "provider_event") {
      return [];
    }
    const projection = visibleEventProjections.get(row.id)!;
    const content = [];
    const text = projection.content;
    if (text) {
      content.push({ type: "output_text", text });
    }
    const resources = Array.isArray(payload.artifacts) ? payload.artifacts : [];
    resources.forEach((raw) => {
      if (!raw || typeof raw !== "object" || Array.isArray(raw)) return;
      const resource = raw as Record<string, unknown>;
      const artifactId = String(resource.artifactId ?? "");
      if (!artifactId.startsWith("artifact_")) return;
      const mimeType = cleanMimeType(resource.mimeType);
      content.push({
        type: mimeType.startsWith("image/") ? "output_image" : "output_file",
        file_url: enterpriseProjectUrl(`/api/frontmind/v2/artifacts/${encodeURIComponent(artifactId)}/content`),
        file_name: cleanFilename(resource.filename),
        mime_type: mimeType,
      });
    });
    return content.length > 0
      ? [
          {
            id: row.id,
            message_id: projection.messageId,
            sent_at_ms: projection.sentAtMs,
            server_sequence: projection.sequence,
            general_chat: projection.generalChat,
            type: "message",
            role: "assistant",
            content,
          },
        ]
      : [];
  });
}

function publicStatus(status: AgentOperation["status"]) {
  if (status === "succeeded") return "completed" as const;
  if (
    status === "failed" ||
    status === "cancelled" ||
    status === "attention_required"
  ) {
    return "error" as const;
  }
  if (status === "queued") return "pending" as const;
  return "running" as const;
}

async function taskDto(operation: AgentOperation, task: AgentTask) {
  const purpose = frozenGeneralAgentPurpose(task, operation.accountUserId!);
  const contentProduction = contentProductionPublicDto(
    purpose,
    task.providerRuntime,
  );
  const status = publicStatus(operation.status);
  const partialResult =
    operation.errorCode === GENERAL_CHAT_PARTIAL_RESULT_ERROR_CODE;
  return {
    id: task.id,
    object: "frontmind.local_task",
    status,
    model: operation.publicProfile,
    ...generalAgentPurposePublic(purpose),
    ...(contentProduction ? { contentProduction } : {}),
    metadata: {
      task_title:
        purpose?.purpose === "enterprise_qa"
          ? "企业问答"
          : purpose?.purpose === "content_production" ? "FrontMind 内容流程" : "FrontMind 通用智能体",
    },
    output: await cachedOutput(task.id),
    execution: (await loadGeneralExecutions(await requireDb(), [task.id])).get(task.id),
    ...(!task.providerTaskId &&
    ["failed", "cancelled"].includes(operation.status)
      ? { clearTaskPointer: true }
      : {}),
    ...(status === "error" && operation.errorCode
      ? {
          error: {
            message: partialResult ? "部分结果已保留" : "任务未能完成",
            code: operation.errorCode,
            ...(partialResult ? { partialResult: true } : {}),
          },
        }
      : {}),
  };
}

async function updateTaskState(input: {
  operationId: string;
  localTaskId: string;
  status: AgentOperation["status"];
  providerState: string;
  errorCode?: string | null;
  providerTaskId?: string;
  providerRequestId?: string | null;
  resultDeadlineAt?: Date | null;
  clearConversationTaskPointers?: boolean;
  turnId?: string;
  conversationId?: string;
}) {
  if (Boolean(input.turnId) !== Boolean(input.conversationId)) {
    throw new ChatV2HttpError("TASK_STATE_TURN_BOUNDARY_INVALID", 500);
  }
  const db = await requireDb();
  return db.transaction(async (tx) => {
    const explicitBoundary =
      input.turnId && input.conversationId
        ? { id: input.turnId, conversationId: input.conversationId }
        : null;
    if (explicitBoundary) {
      const lockedConversation = (
        await tx
          .select({ id: conversations.id })
          .from(conversations)
          .where(eq(conversations.id, explicitBoundary.conversationId))
          .limit(1)
          .for("update")
      )[0];
      if (!lockedConversation) {
        throw new ChatV2HttpError("TASK_STATE_TURN_BOUNDARY_MISMATCH", 409);
      }
    }
    const targetTurn = explicitBoundary
      ? (
          await tx
            .select({
              id: conversationTurns.id,
              conversationId: conversationTurns.conversationId,
              status: conversationTurns.status,
              messageSequence: messages.sequence,
            })
            .from(conversationTurns)
            .innerJoin(
              messages,
              and(
                eq(messages.turnId, conversationTurns.id),
                eq(messages.conversationId, conversationTurns.conversationId),
                eq(messages.role, "user"),
              ),
            )
            .where(
              and(
                eq(conversationTurns.id, explicitBoundary.id),
                eq(
                  conversationTurns.conversationId,
                  explicitBoundary.conversationId,
                ),
                eq(conversationTurns.upstreamTaskId, input.localTaskId),
                eq(conversationTurns.operationType, GENERAL_CHAT_TURN_TYPE),
              ),
            )
            .limit(1)
            .for("update")
        )[0]
      : (
          await tx
            .select({
              id: conversationTurns.id,
              conversationId: conversationTurns.conversationId,
              status: conversationTurns.status,
              messageSequence: messages.sequence,
            })
            .from(conversationTurns)
            .innerJoin(
              messages,
              and(
                eq(messages.turnId, conversationTurns.id),
                eq(messages.conversationId, conversationTurns.conversationId),
                eq(messages.role, "user"),
              ),
            )
            .where(
              and(
                eq(conversationTurns.upstreamTaskId, input.localTaskId),
                eq(conversationTurns.operationType, GENERAL_CHAT_TURN_TYPE),
              ),
            )
            .orderBy(desc(messages.sequence), desc(conversationTurns.id))
            .limit(1)
            .for("update")
        )[0];
    if (explicitBoundary && !targetTurn) {
      throw new ChatV2HttpError("TASK_STATE_TURN_BOUNDARY_MISMATCH", 409);
    }
    if (explicitBoundary && targetTurn) {
      // The conversation row is locked before this query, matching turn
      // reservation lock order. A newer bound user message therefore cannot
      // appear between the latest-turn check and the state writes below.
      const latestBoundTurn = (
        await tx
          .select({
            id: conversationTurns.id,
            messageSequence: messages.sequence,
          })
          .from(conversationTurns)
          .innerJoin(
            messages,
            and(
              eq(messages.turnId, conversationTurns.id),
              eq(messages.conversationId, conversationTurns.conversationId),
              eq(messages.role, "user"),
            ),
          )
          .where(
            and(
              eq(
                conversationTurns.conversationId,
                explicitBoundary.conversationId,
              ),
              eq(conversationTurns.upstreamTaskId, input.localTaskId),
              eq(conversationTurns.operationType, GENERAL_CHAT_TURN_TYPE),
            ),
          )
          .orderBy(desc(messages.sequence), desc(conversationTurns.id))
          .limit(1)
          .for("update")
      )[0];
      if (!latestBoundTurn || latestBoundTurn.id !== targetTurn.id) {
        // A background GET may have read this turn immediately before the
        // next user message reserved a newer one. The old settlement is now
        // irrelevant: leave every task/operation/conversation row untouched
        // and let the caller return the newly authoritative state.
        return { applied: false as const, superseded: true as const };
      }
    }
    const lockedOperation = (
      await tx
        .select({ status: agentOperations.status })
        .from(agentOperations)
        .where(eq(agentOperations.id, input.operationId))
        .limit(1)
        .for("update")
    )[0];
    if (!lockedOperation) {
      throw new ChatV2HttpError("TASK_STATE_OPERATION_NOT_FOUND", 409);
    }
    const lockedTask = (
      await tx
        .select({ providerState: agentTasks.providerState })
        .from(agentTasks)
        .where(
          and(
            eq(agentTasks.id, input.localTaskId),
            eq(agentTasks.operationId, input.operationId),
          ),
        )
        .limit(1)
        .for("update")
    )[0];
    if (!lockedTask) {
      throw new ChatV2HttpError("TASK_STATE_TASK_NOT_FOUND", 409);
    }
    const preserveSettledSuccess =
      lockedOperation.status === "succeeded" &&
      (!targetTurn || targetTurn.status === "completed") &&
      input.status !== "succeeded";
    const effectiveStatus = preserveSettledSuccess ? "succeeded" : input.status;
    const effectiveErrorCode = preserveSettledSuccess
      ? null
      : (input.errorCode ?? null);
    await tx
      .update(agentOperations)
      .set({ status: effectiveStatus, errorCode: effectiveErrorCode })
      .where(eq(agentOperations.id, input.operationId));
    await tx
      .update(agentTasks)
      .set({
        providerState: preserveSettledSuccess
          ? lockedTask.providerState
          : input.providerState,
        ...(input.providerTaskId
          ? { providerTaskId: input.providerTaskId }
          : {}),
        ...(input.providerRequestId !== undefined
          ? { providerRequestId: input.providerRequestId }
          : {}),
        ...(preserveSettledSuccess
          ? { resultDeadlineAt: null }
          : input.resultDeadlineAt !== undefined
            ? { resultDeadlineAt: input.resultDeadlineAt }
            : {}),
        lastMessageSyncAt: new Date(),
      })
      .where(eq(agentTasks.id, input.localTaskId));
    const turnStatus =
      effectiveStatus === "succeeded"
        ? "completed"
        : ["failed", "attention_required"].includes(effectiveStatus)
          ? "failed"
          : effectiveStatus === "cancelled"
            ? "cancelled"
            : effectiveStatus === "queued"
              ? "queued"
              : "running";
    if (targetTurn) {
      await tx
        .update(conversationTurns)
        .set({
          status: turnStatus,
          errorCode: effectiveErrorCode,
          ...(turnStatus === "completed" ||
          turnStatus === "failed" ||
          turnStatus === "cancelled"
            ? { completedAt: new Date() }
            : { completedAt: null }),
        })
        .where(
          and(
            eq(conversationTurns.id, targetTurn.id),
            eq(conversationTurns.conversationId, targetTurn.conversationId),
            eq(conversationTurns.upstreamTaskId, input.localTaskId),
            eq(conversationTurns.operationType, GENERAL_CHAT_TURN_TYPE),
          ),
        );
    }
    const conversationStatus =
      effectiveStatus === "succeeded"
        ? "completed"
        : ["failed", "cancelled", "attention_required"].includes(
              effectiveStatus,
            )
          ? "error"
          : effectiveStatus === "queued"
            ? "pending"
            : "running";
    if (targetTurn) {
      await tx
        .update(conversations)
        .set({
          status: conversationStatus,
          ...(input.clearConversationTaskPointers
            ? { upstreamTaskId: null, previousResponseId: null }
            : {}),
          ...(conversationStatus === "completed" ||
          conversationStatus === "error"
            ? { completedAt: new Date() }
            : { completedAt: null }),
        })
        .where(eq(conversations.id, targetTurn.conversationId));
    }
    return { applied: true as const, superseded: false as const };
  });
}

type CreateReconcileEvidence = {
  promptSha256: string;
  attachmentFileIds: string[];
  localAssetIds: string[];
};

type CreateReservationStatus =
  | "preparation_failed"
  | "preparing"
  | "sending"
  | "outcome_unknown"
  | "acknowledged"
  | "rejected"
  | "ambiguous";

async function ensureCreatePreparationReservation(input: {
  taskId: string;
  requestHash: string;
  prompt: string;
  localAssetIds: readonly string[];
}) {
  const db = await requireDb();
  const providerEventId = `local-create:${input.taskId}`;
  await db
    .insert(agentEvents)
    .values({
      id: randomUUID(),
      taskId: input.taskId,
      providerEventId,
      eventType: "local_create_reservation",
      providerTimestampMs: Date.now(),
      normalizedPayload: {
        kind: "local_create_reservation",
        requestHash: input.requestHash,
        promptSha256: hash(input.prompt),
        localAssetIds: sortedUnique(input.localAssetIds),
        status: "preparation_failed",
      },
    })
    .onDuplicateKeyUpdate({ set: { providerEventId } });
  const reservation = (
    await db
      .select()
      .from(agentEvents)
      .where(
        and(
          eq(agentEvents.taskId, input.taskId),
          eq(agentEvents.providerEventId, providerEventId),
        ),
      )
      .limit(1)
  )[0];
  if (
    !reservation ||
    reservation.normalizedPayload.kind !== "local_create_reservation" ||
    reservation.normalizedPayload.requestHash !== input.requestHash
  ) {
    throw new ChatV2HttpError("IDEMPOTENCY_CONFLICT", 409);
  }
  return reservation;
}

async function claimCreatePreparation(input: {
  operationId: string;
  taskId: string;
  userId: number;
  requestHash: string;
  prompt: string;
  localAssetIds: readonly string[];
}) {
  await ensureCreatePreparationReservation(input);
  const db = await requireDb();
  const { claimToken, claimUpdatedAtMs } = createGeneralChatPreparationClaim();
  const claim = await db.transaction(async (tx) => {
    const reservation = (
      await tx
        .select()
        .from(agentEvents)
        .where(
          and(
            eq(agentEvents.taskId, input.taskId),
            eq(agentEvents.providerEventId, `local-create:${input.taskId}`),
          ),
        )
        .limit(1)
        .for("update")
    )[0];
    if (
      !reservation ||
      reservation.normalizedPayload.requestHash !== input.requestHash
    ) {
      throw new ChatV2HttpError("IDEMPOTENCY_CONFLICT", 409);
    }
    const status = reservation.normalizedPayload.status;
    const mayTakeOverStaleClaim =
      status === "preparing" &&
      generalChatPreparationClaimIsStale(
        reservation.normalizedPayload.claimUpdatedAtMs,
      );
    if (status !== "preparation_failed" && !mayTakeOverStaleClaim) {
      return {
        acquired: false as const,
        claimToken: null,
        status: typeof status === "string" ? status : ("ambiguous" as const),
      };
    }
    await tx
      .update(agentEvents)
      .set({
        normalizedPayload: {
          ...reservation.normalizedPayload,
          claimToken,
          claimUpdatedAtMs,
          status: "preparing",
        },
      })
      .where(eq(agentEvents.id, reservation.id));
    await tx
      .update(agentOperations)
      .set({ status: "queued", errorCode: null })
      .where(eq(agentOperations.id, input.operationId));
    await tx
      .update(agentTasks)
      .set({ providerState: "preparing" })
      .where(eq(agentTasks.id, input.taskId));
    return {
      acquired: true as const,
      claimToken,
      status: "preparing" as const,
    };
  });
  return claim;
}

async function freezeCreateReconcileEvidence(input: {
  taskId: string;
  userId: number;
  clientRequestId: string;
  requestHash: string;
  claimToken: string;
  prompt: string;
  localAssetIds: readonly string[];
  modelProfile: GeneralAgentModelProfile;
  attachmentFileIds: readonly string[];
}) {
  const db = await requireDb();
  return db.transaction(async (tx) => {
    const reservation = (
      await tx
        .select()
        .from(agentEvents)
        .where(
          and(
            eq(agentEvents.taskId, input.taskId),
            eq(agentEvents.providerEventId, `local-create:${input.taskId}`),
          ),
        )
        .limit(1)
        .for("update")
    )[0];
    const payload = reservation?.normalizedPayload;
    if (
      !reservation ||
      payload?.requestHash !== input.requestHash ||
      payload.status !== "preparing" ||
      payload.claimToken !== input.claimToken ||
      typeof payload.promptSha256 !== "string"
    ) {
      throw new ChatV2HttpError("CREATE_RESERVATION_CONFLICT", 409, true);
    }
    const turn = (
      await tx
        .select({
          id: conversationTurns.id,
          conversationId: conversationTurns.conversationId,
          clientRequestId: conversationTurns.clientRequestId,
          requestHash: conversationTurns.requestHash,
          metadata: conversationTurns.metadata,
        })
        .from(conversationTurns)
        .where(
          and(
            eq(conversationTurns.userId, input.userId),
            eq(conversationTurns.clientRequestId, input.clientRequestId),
            eq(conversationTurns.operationType, GENERAL_CHAT_TURN_TYPE),
            eq(conversationTurns.upstreamTaskId, input.taskId),
          ),
        )
        .limit(1)
        .for("update")
    )[0];
    if (!turn) throw new ChatV2HttpError("GENERAL_CHAT_TURN_NOT_FOUND", 409);
    const localAssetIds = sortedUnique(input.localAssetIds);
    if (
      turn.clientRequestId !== input.clientRequestId ||
      turn.requestHash !== requestHash({ prompt: input.prompt, localAssetIds })
    ) {
      throw new ChatV2HttpError("IDEMPOTENCY_CONFLICT", 409);
    }
    const persistedMessageId = persistedMessageIdForConversation(
      turn.conversationId,
      input.clientRequestId,
    );
    const boundUserMessage = (
      await tx
        .select({
          content: messages.content,
          metadata: messages.metadata,
          turnId: messages.turnId,
        })
        .from(messages)
        .where(
          and(
            eq(messages.id, persistedMessageId),
            eq(messages.conversationId, turn.conversationId),
            eq(messages.userId, input.userId),
            eq(messages.role, "user"),
            eq(messages.turnId, turn.id),
            isNull(messages.deletedAt),
          ),
        )
        .limit(1)
        .for("update")
    )[0];
    if (!boundUserMessage || boundUserMessage.turnId !== turn.id) {
      throw new ChatV2HttpError("USER_MESSAGE_TURN_CONFLICT", 409);
    }
    const dispatchValidation = validateGeneralChatDispatchMetadata({
      metadata: boundUserMessage.metadata,
      clientRequestId: input.clientRequestId,
      providerPrompt: input.prompt,
      localAssetIds,
      originalLocalTaskId: null,
      modelProfile: input.modelProfile,
    });
    if (
      dispatchValidation.kind === "invalid" ||
      (dispatchValidation.kind === "legacy" &&
        stripFrontMindGeneralChatOperationContract(
          boundUserMessage.content,
        ).trim() !== input.prompt.trim())
    ) {
      throw new ChatV2HttpError("USER_MESSAGE_DISPATCH_CONFLICT", 409);
    }
    const attachmentFileIds = sortedUnique(input.attachmentFileIds);
    const frozenPayload = {
      ...payload,
      attachmentFileIds,
      status: "sending",
    };
    await tx
      .update(agentEvents)
      .set({ normalizedPayload: frozenPayload })
      .where(eq(agentEvents.id, reservation.id));
    await tx
      .update(conversationTurns)
      .set({
        metadata: {
          ...(turn.metadata ?? {}),
          providerAttachmentFileIds: attachmentFileIds,
          providerEventWatermark: [],
        },
        status: "running",
        startedAt: new Date(),
      })
      .where(eq(conversationTurns.id, turn.id));
    return {
      promptSha256: payload.promptSha256,
      attachmentFileIds,
      localAssetIds,
    } satisfies CreateReconcileEvidence;
  });
}

async function transitionCreateReservation(input: {
  taskId: string;
  status: CreateReservationStatus;
  expectedStatus?: CreateReservationStatus;
  claimToken?: string;
  rejectionProven?: boolean;
  rejectionCode?: string;
  requirePersistedPreSendBalanceRefusal?: boolean;
}) {
  const db = await requireDb();
  return db.transaction(async (tx) => {
    const reservation = (
      await tx
        .select()
        .from(agentEvents)
        .where(
          and(
            eq(agentEvents.taskId, input.taskId),
            eq(agentEvents.providerEventId, `local-create:${input.taskId}`),
          ),
        )
        .limit(1)
        .for("update")
    )[0];
    if (!reservation) return false;
    const payload = reservation.normalizedPayload;
    if (
      (input.expectedStatus && payload.status !== input.expectedStatus) ||
      (input.claimToken && payload.claimToken !== input.claimToken)
    ) {
      return false;
    }
    if (payload.status === "acknowledged" && input.status !== "acknowledged") {
      return false;
    }
    if (payload.status === "rejected" && payload.rejectionProven === true && input.status !== "rejected") {
      return false;
    }
    if (input.requirePersistedPreSendBalanceRefusal) {
      const [task] = await tx.select({ runtime: agentTasks.providerRuntime, providerTaskId: agentTasks.providerTaskId })
        .from(agentTasks).where(eq(agentTasks.id, input.taskId)).limit(1).for("update");
      if (task?.providerTaskId || !generalChatHasPersistedPreSendBalanceRefusal(task?.runtime)) return false;
    }
    await tx
      .update(agentEvents)
      .set({
        normalizedPayload: {
          ...payload,
          status: input.status,
          ...(input.status === "rejected"
            ? {
                rejectionProven: input.rejectionProven === true,
                ...(input.rejectionCode ? { rejectionCode: input.rejectionCode } : {}),
              }
            : {}),
        },
      })
      .where(eq(agentEvents.id, reservation.id));
    return true;
  });
}

async function readCreateReservation(taskId: string) {
  const payload = (
    await (
      await requireDb()
    )
      .select({ payload: agentEvents.normalizedPayload })
      .from(agentEvents)
      .where(
        and(
          eq(agentEvents.taskId, taskId),
          eq(agentEvents.providerEventId, `local-create:${taskId}`),
        ),
      )
      .limit(1)
  )[0]?.payload;
  if (payload?.kind !== "local_create_reservation") return null;
  const promptSha256 =
    typeof payload.promptSha256 === "string" ? payload.promptSha256 : null;
  const attachmentFileIds = Array.isArray(payload.attachmentFileIds)
    ? payload.attachmentFileIds.filter(
        (value): value is string => typeof value === "string",
      )
    : [];
  const localAssetIds = Array.isArray(payload.localAssetIds)
    ? payload.localAssetIds.filter(
        (value): value is string => typeof value === "string",
      )
    : [];
  return {
    status:
      typeof payload.status === "string"
        ? (payload.status as CreateReservationStatus)
        : null,
    rejectionProven: payload.rejectionProven === true,
    rejectionCode: typeof payload.rejectionCode === "string" ? payload.rejectionCode : undefined,
    evidence: promptSha256
      ? ({
          promptSha256,
          attachmentFileIds,
          localAssetIds,
        } satisfies CreateReconcileEvidence)
      : null,
  };
}

async function assertCreateTaskDtoMaySettle(input: {
  operation: AgentOperation;
  task: AgentTask;
}) {
  let owned = input;
  let reservation = await readCreateReservation(input.task.id);
  if (
    input.task.providerTaskId &&
    (reservation?.status === "sending" ||
      reservation?.status === "outcome_unknown")
  ) {
    await transitionCreateReservation({
      taskId: input.task.id,
      expectedStatus: reservation.status,
      status: "acknowledged",
    });
    reservation = await readCreateReservation(input.task.id);
  }
  if (
    reservation?.status === "rejected" &&
    reservation.rejectionProven &&
    !owned.task.providerTaskId &&
    !["failed", "cancelled"].includes(owned.operation.status)
  ) {
    await updateTaskState({
      operationId: owned.operation.id,
      localTaskId: owned.task.id,
      status: "failed",
      providerState: "failed",
      errorCode: reservation.rejectionCode ?? owned.operation.errorCode ?? "TASK_CREATE_REJECTED",
      clearConversationTaskPointers: true,
    });
    owned = await findOwnedTask({
      userId: owned.operation.accountUserId!,
      localTaskId: owned.task.id,
    });
  }
  const terminalSafe =
    reservation?.status === "rejected" &&
    reservation.rejectionProven &&
    !owned.task.providerTaskId &&
    ["failed", "cancelled"].includes(owned.operation.status);
  if (
    (reservation?.status === "acknowledged" && owned.task.providerTaskId) ||
    terminalSafe
  ) {
    return owned;
  }
  throw new ChatV2HttpError("CREATE_OUTCOME_UNRESOLVED", 409, true);
}

async function reconcileUnknownCreate(input: {
  operation: AgentOperation;
  task: AgentTask;
  credential: NonNullable<
    Awaited<ReturnType<typeof getDecryptedCredentialForAccountById>>
  >;
}) {
  if (input.task.providerTaskId || input.operation.status !== "queued") {
    return input;
  }
  const reservation = await readCreateReservation(input.task.id);
  if (
    !reservation?.evidence ||
    !["sending", "outcome_unknown"].includes(reservation.status ?? "")
  ) {
    return input;
  }
  if (input.operation.provider === "zhipu" && reservation.status === "outcome_unknown" &&
      generalChatHasPersistedPreSendBalanceRefusal(input.task.providerRuntime)) {
    const settled = await transitionCreateReservation({
      taskId: input.task.id,
      expectedStatus: "outcome_unknown",
      status: "rejected",
      rejectionProven: true,
      rejectionCode: "AI_BALANCE_INSUFFICIENT",
      requirePersistedPreSendBalanceRefusal: true,
    });
    if (settled) {
      await updateTaskState({
        operationId: input.operation.id,
        localTaskId: input.task.id,
        status: "failed",
        providerState: "failed",
        errorCode: "AI_BALANCE_INSUFFICIENT",
        clearConversationTaskPointers: true,
      });
    }
    return findOwnedTask({ userId: input.operation.accountUserId!, localTaskId: input.task.id });
  }
  const evidence = reservation.evidence;
  const localAttachmentManifest = await generalChatLocalAttachmentManifest({
    userId: input.operation.accountUserId!,
    localAssetIds: evidence.localAssetIds,
  });
  const attachmentManifest = localAttachmentManifest
    ? bindGeneralChatLocalManifestToProviderFiles(
        localAttachmentManifest,
        evidence.attachmentFileIds,
      )
    : null;
  if (!attachmentManifest) return input;
  const result = await clientFor(
    input.credential,
    input.operation.accountUserId!,
    input.operation,
    input.task,
  ).findCreatedTask({
    title: input.task.title,
    promptSha256: evidence.promptSha256,
    attachmentFileIds: evidence.attachmentFileIds,
    attachmentManifest,
    createdAfterSeconds:
      Math.floor(input.operation.createdAt.getTime() / 1_000) - 60,
    createdBeforeSeconds: Math.floor(Date.now() / 1_000) + 60,
  });
  if (result.matches.length > 1) {
    await transitionCreateReservation({
      taskId: input.task.id,
      status: "ambiguous",
    });
    await updateTaskState({
      operationId: input.operation.id,
      localTaskId: input.task.id,
      status: "attention_required",
      providerState: "attention_required",
      errorCode: "CREATE_RECONCILE_CONFLICT",
    });
  } else if (result.unique) {
    await updateTaskState({
      operationId: input.operation.id,
      localTaskId: input.task.id,
      status: "running",
      providerState: result.unique.status ?? "running",
      providerTaskId: result.unique.id,
      errorCode: null,
    });
    await transitionCreateReservation({
      taskId: input.task.id,
      status: "acknowledged",
    });
  } else {
    const unresolved = await transitionCreateReservation({
      taskId: input.task.id,
      expectedStatus: reservation.status ?? undefined,
      status: "outcome_unknown",
    });
    if (unresolved) await updateTaskState({
      operationId: input.operation.id,
      localTaskId: input.task.id,
      status: "queued",
      providerState: "outcome_unknown",
      errorCode: "CREATE_OUTCOME_UNKNOWN",
    });
  }
  return findOwnedTask({
    userId: input.operation.accountUserId!,
    localTaskId: input.task.id,
  });
}

async function latestGeneralChatTurnSettlementContext(input: {
  userId: number;
  localTaskId: string;
  operationId: string;
}) {
  const db = await requireDb();
  const turn = (
    await db
      .select({
        id: conversationTurns.id,
        conversationId: conversationTurns.conversationId,
        status: conversationTurns.status,
        messageSequence: messages.sequence,
        attachmentFileIds: conversationTurns.attachmentFileIds,
        metadata: conversationTurns.metadata,
      })
      .from(conversationTurns)
      .innerJoin(
        messages,
        and(
          eq(messages.turnId, conversationTurns.id),
          eq(messages.conversationId, conversationTurns.conversationId),
          eq(messages.role, "user"),
        ),
      )
      .where(
        and(
          eq(conversationTurns.userId, input.userId),
          eq(conversationTurns.operationType, GENERAL_CHAT_TURN_TYPE),
          eq(conversationTurns.upstreamTaskId, input.localTaskId),
        ),
      )
      .orderBy(desc(messages.sequence), desc(conversationTurns.id))
      .limit(1)
  )[0];
  if (!turn) return null;
  const metadata = turn.metadata ?? {};
  const promptSha256 =
    typeof metadata.promptSha256 === "string" ? metadata.promptSha256 : null;
  const providerAttachmentFileIds = Array.isArray(
    metadata.providerAttachmentFileIds,
  )
    ? metadata.providerAttachmentFileIds.filter(
        (value): value is string => typeof value === "string",
      )
    : [];
  const providerEventWatermark = Array.isArray(metadata.providerEventWatermark)
    ? metadata.providerEventWatermark.filter(
        (value): value is string => typeof value === "string",
      )
    : [];
  if (
    metadata.agentTaskId !== input.localTaskId ||
    metadata.operationId !== input.operationId ||
    !promptSha256 ||
    metadata.attachmentManifestHash !==
      requestHash(sortedUnique(turn.attachmentFileIds ?? []))
  ) {
    throw new ChatV2HttpError("CURRENT_TURN_SETTLEMENT_METADATA_INVALID", 409);
  }
  const outputRows = await db
    .select({ id: messages.id, metadata: messages.metadata })
    .from(messages)
    .where(
      and(
        eq(messages.turnId, turn.id),
        eq(messages.role, "assistant"),
        isNull(messages.deletedAt),
      ),
    );
  const output = outputRows.filter((row) => {
    const generalChat =
      row.metadata?.generalChat &&
      typeof row.metadata.generalChat === "object" &&
      !Array.isArray(row.metadata.generalChat)
        ? (row.metadata.generalChat as Record<string, unknown>)
        : null;
    return (
      generalChat?.serverOwned === true &&
      generalChat.kind === "assistant_projection" &&
      generalChat.agentTaskId === input.localTaskId &&
      generalChat.turnId === turn.id
    );
  });
  return {
    id: turn.id,
    conversationId: turn.conversationId,
    status: turn.status,
    promptSha256,
    providerAttachmentFileIds,
    providerEventWatermark,
    outputCount: output.length,
    hasOutput: output.length > 0,
  };
}

async function latestGeneralChatTurnLifecycle(input: {
  userId: number;
  localTaskId: string;
}) {
  return (
    await (
      await requireDb()
    )
      .select({
        status: conversationTurns.status,
        messageSequence: messages.sequence,
      })
      .from(conversationTurns)
      .innerJoin(
        messages,
        and(
          eq(messages.turnId, conversationTurns.id),
          eq(messages.conversationId, conversationTurns.conversationId),
          eq(messages.role, "user"),
        ),
      )
      .where(
        and(
          eq(conversationTurns.userId, input.userId),
          eq(conversationTurns.operationType, GENERAL_CHAT_TURN_TYPE),
          eq(conversationTurns.upstreamTaskId, input.localTaskId),
        ),
      )
      .orderBy(desc(messages.sequence), desc(conversationTurns.id))
      .limit(1)
  )[0];
}

async function syncTask(input: { userId: number; localTaskId: string }) {
  let owned = await findOwnedTask(input);
  if (["succeeded", "cancelled"].includes(owned.operation.status)) {
    const latestTurn = await latestGeneralChatTurnLifecycle(input);
    if (!latestTurn || ["completed", "cancelled"].includes(latestTurn.status)) {
      // Old completed conversations need one GET-only projection backfill.
      const execution = (await loadGeneralExecutions(await requireDb(), [owned.task.id])).get(owned.task.id);
      if (execution?.coverage === "complete") return owned;
      const frozenCredential = await getDecryptedCredentialForAccountById(input.userId, owned.operation.apiCredentialId);
      if (frozenCredential && frozenCredential.version === owned.operation.credentialVersion && owned.task.providerTaskId) {
        try {
          const events = await clientFor(frozenCredential, input.userId, owned.operation, owned.task).listAllMessages({ taskId: owned.task.providerTaskId, order: "desc" });
          await persistProviderEvents({ ...owned, events });
        } catch { console.warn("[FrontMindV2] execution history backfill deferred", { localTaskId: owned.task.id }); }
      }
      return owned;
    }
  }
  const credential = await getDecryptedCredentialForAccountById(
    input.userId,
    owned.operation.apiCredentialId,
  );
  if (!credential || credential.version !== owned.operation.credentialVersion) {
    return owned;
  }
  if (!owned.task.providerTaskId && owned.operation.status === "queued") {
    owned = await reconcileUnknownCreate({ ...owned, credential });
  }
  if (!owned.task.providerTaskId) return owned;

  try {
    const client = clientFor(
      credential,
      input.userId,
      owned.operation,
      owned.task,
    );
    const [events, detail] = await Promise.all([
      client.listAllMessages({
        taskId: owned.task.providerTaskId,
        order: "desc",
      }),
      client.taskDetail(owned.task.providerTaskId),
    ]);
    const persisted = await persistProviderEvents({ ...owned, events });
    if (!persisted.applied) {
      console.info("[FrontMindV2] general-chat projection superseded", {
        localTaskId: owned.task.id,
        claimReason: persisted.claimReason,
      });
      return owned;
    }
    const currentTurn = await latestGeneralChatTurnSettlementContext({
      ...input,
      operationId: owned.operation.id,
    });
    const currentEvidence = currentTurn
      ? currentGeneralChatTurnProviderEvidence({
          events,
          promptSha256: currentTurn.promptSha256,
          providerAttachmentFileIds: currentTurn.providerAttachmentFileIds,
          providerEventWatermark: currentTurn.providerEventWatermark,
          resolvedBinding: persisted.bindings.get(currentTurn.id),
        })
      : {
          binding: "pending" as const,
          events: [],
          eventStatus: null,
          hasUserStop: false,
          errorType: null,
          errorContent: null,
        };
    const nowMs = Date.now();
    const settlement = settleGeneralChatTurn({
      previousStatus: owned.operation.status,
      currentTurnAlreadyCompleted: currentTurn?.status === "completed",
      binding: currentEvidence.binding,
      detailStatus: detail.status,
      eventStatus: currentEvidence.eventStatus,
      hasUserStop: currentEvidence.hasUserStop,
      hasCurrentOutput: currentTurn?.hasOutput ?? false,
      resultDeadlineAtMs: owned.task.resultDeadlineAt?.getTime() ?? null,
      nowMs,
      graceMs: RESULT_GRACE_MS,
    });
    const stateUpdate = await updateTaskState({
      operationId: owned.operation.id,
      localTaskId: owned.task.id,
      status: settlement.status,
      providerState: settlement.providerState,
      errorCode: settlement.errorCode,
      resultDeadlineAt:
        settlement.resultDeadlineAtMs === null
          ? null
          : new Date(settlement.resultDeadlineAtMs),
      ...(currentTurn
        ? {
            turnId: currentTurn.id,
            conversationId: currentTurn.conversationId,
          }
        : {}),
    });
    if (stateUpdate.superseded) {
      return findOwnedTask(input);
    }
    const settlementLog = {
      localTaskId: owned.task.id,
      turnId: currentTurn?.id ?? null,
      conversationId: currentTurn?.conversationId ?? null,
      detailStatus: detail.status ?? null,
      currentEventStatus: currentEvidence.eventStatus,
      eventBinding: currentEvidence.binding,
      currentOutputCount: currentTurn?.outputCount ?? 0,
      selectedStatus: settlement.status,
      providerState: settlement.providerState,
      partialResult: settlement.partialResult,
      conflict: settlement.conflict,
      errorType: currentEvidence.errorType,
    };
    if (settlement.conflict && settlement.status !== "result_pending") {
      console.warn(
        "[FrontMindV2] general-chat settlement conflict resolved by task.detail",
        settlementLog,
      );
    } else {
      console.info("[FrontMindV2] general-chat settlement", settlementLog);
    }
    owned = await findOwnedTask(input);
  } catch (error) {
    // Cached local messages and artifacts remain authoritative when a retired
    // or revoked credential can no longer read the provider task.
    console.warn("[FrontMindV2] task reconcile deferred", {
      code: error instanceof ManusV2ApiError ? error.code : "TASK_SYNC_FAILED",
      localTaskId: input.localTaskId,
    });
  }
  return owned;
}

function persistedConversationResourceId(
  userId: number,
  publicId: string,
  projectAssignmentId: string | null,
) {
  const prefix = enterpriseConversationStoragePrefix(userId, projectAssignmentId);
  return publicId.startsWith(prefix) ? publicId : `${prefix}${publicId}`;
}

async function bindPersistedGeneralChatUserMessageTurn(input: {
  executor: any;
  userMessage: typeof messages.$inferSelect;
  persistedConversationId: string;
  turnId: string;
}) {
  if (input.userMessage.turnId === input.turnId) return;
  if (input.userMessage.turnId !== null) {
    throw new ChatV2HttpError("USER_MESSAGE_TURN_CONFLICT", 409);
  }
  await input.executor
    .update(messages)
    .set({ turnId: input.turnId })
    .where(
      and(
        eq(messages.id, input.userMessage.id),
        eq(messages.conversationId, input.persistedConversationId),
        isNull(messages.turnId),
      ),
    );
}

async function reservePersistedGeneralChatTurn(input: {
  executor: any;
  userId: number;
  projectAssignmentId: string | null;
  credentialId: string;
  conversationId: string;
  clientRequestId: string;
  prompt: string;
  localAssetIds: readonly string[];
  operationId: string;
  localTaskId: string;
  model: string;
  modelProfile: GeneralAgentModelProfile | null;
  continuation: boolean;
  purpose?: "enterprise_qa" | "content_production";
  knowledgePrepared?: boolean;
  contentProduction?: ContentProductionInput;
  contentProductionAction?: ContentProductionAction;
  availableContentActions?: ContentProductionAction["kind"][];
  contentRunnerRevision?: number | null;
}) {
  await lockCustomerProjectBusinessWrite(input.executor, input.userId);
  const persistedConversationId = persistedConversationResourceId(
    input.userId,
    input.conversationId,
    input.projectAssignmentId,
  );
  const persistedMessageId = persistedConversationResourceId(
    input.userId,
    input.clientRequestId,
    input.projectAssignmentId,
  );
  const conversation = (
    await input.executor
      .select()
      .from(conversations)
      .where(and(eq(conversations.id, persistedConversationId), enterpriseProjectPredicate(conversations.enterpriseProjectId)))
      .limit(1)
      .for("update")
  )[0] as typeof conversations.$inferSelect | undefined;
  const owned = input.projectAssignmentId
    ? conversation?.projectAssignmentId === input.projectAssignmentId
    : conversation?.userId === input.userId &&
      conversation?.projectAssignmentId == null;
  if (!conversation || !owned || conversation.deletedAt) {
    throw new ChatV2HttpError("CONVERSATION_NOT_SYNCED", 409, true);
  }
  if (conversation.apiCredentialId !== input.credentialId) {
    throw new ChatV2HttpError("CONVERSATION_CREDENTIAL_CONFLICT", 409);
  }
  const conversationTaskPointers = [
    conversation.upstreamTaskId,
    conversation.previousResponseId,
  ].filter(
    (value): value is string => typeof value === "string" && value.length > 0,
  );
  if (
    (input.continuation &&
      (conversationTaskPointers.length === 0 ||
        conversationTaskPointers.some(
          (pointer) => pointer !== input.localTaskId,
        ))) ||
    (!input.continuation &&
      conversationTaskPointers.some((pointer) => pointer !== input.localTaskId))
  ) {
    throw new ChatV2HttpError("CONVERSATION_TASK_CONFLICT", 409);
  }
  if (input.continuation) {
    const authoritativeTaskTurns = (await input.executor
      .select({ conversationId: conversationTurns.conversationId })
      .from(conversationTurns)
      .where(
        and(
          eq(conversationTurns.userId, input.userId),
          eq(conversationTurns.operationType, GENERAL_CHAT_TURN_TYPE),
          eq(conversationTurns.upstreamTaskId, input.localTaskId),
        ),
      )) as Array<{ conversationId: string }>;
    if (
      authoritativeTaskTurns.length === 0 ||
      authoritativeTaskTurns.some(
        (turn) => turn.conversationId !== persistedConversationId,
      )
    ) {
      throw new ChatV2HttpError("CONVERSATION_TASK_CONFLICT", 409);
    }
  }
  const userMessage = (
    await input.executor
      .select()
      .from(messages)
      .where(
        and(
          eq(messages.id, persistedMessageId),
          eq(messages.conversationId, persistedConversationId),
          eq(messages.userId, input.userId),
          eq(messages.role, "user"),
          isNull(messages.deletedAt),
        ),
      )
      .limit(1)
      .for("update")
  )[0] as typeof messages.$inferSelect | undefined;
  if (!userMessage) {
    throw new ChatV2HttpError("USER_MESSAGE_NOT_SYNCED", 409, true);
  }
  const attachmentRows = (await input.executor
    .select({ fileId: conversationAttachments.upstreamFileId })
    .from(conversationAttachments)
    .where(
      and(
        eq(conversationAttachments.userId, input.userId),
        eq(conversationAttachments.conversationId, persistedConversationId),
        eq(conversationAttachments.messageId, persistedMessageId),
        isNull(conversationAttachments.deletedAt),
      ),
    )) as Array<{ fileId: string | null }>;
  const persistedAssetIds = sortedUnique(
    attachmentRows.flatMap(({ fileId }) => (fileId ? [fileId] : [])),
  );
  const requestedAssetIds = sortedUnique(input.localAssetIds);
  if (
    persistedAssetIds.length !== requestedAssetIds.length ||
    !requestedAssetIds.every(
      (assetId, index) => assetId === persistedAssetIds[index],
    )
  ) {
    throw new ChatV2HttpError("MESSAGE_ATTACHMENTS_NOT_SYNCED", 409, true);
  }
  const dispatchValidation = validateGeneralChatDispatchMetadata({
    metadata: userMessage.metadata,
    clientRequestId: input.clientRequestId,
    providerPrompt: input.prompt,
    localAssetIds: requestedAssetIds,
    originalLocalTaskId: input.continuation ? input.localTaskId : null,
    modelProfile: input.modelProfile,
  });
  if (dispatchValidation.kind === "invalid") {
    throw new ChatV2HttpError(dispatchValidation.code, 409);
  }
  if (
    !input.continuation &&
    (dispatchValidation.kind === "valid"
      ? dispatchValidation.dispatch.purpose
      : undefined) !== input.purpose
  ) {
    throw new ChatV2HttpError("GENERAL_CHAT_PURPOSE_CONFLICT", 409);
  }
  if (
    dispatchValidation.kind === "valid" &&
    ((dispatchValidation.dispatch.purpose &&
      dispatchValidation.dispatch.purpose !== input.purpose) ||
      requestHash(dispatchValidation.dispatch.contentProduction ?? null) !==
        requestHash(input.contentProduction ?? null) ||
      requestHash(
        dispatchValidation.dispatch.contentProductionAction ?? null,
      ) !== requestHash(input.contentProductionAction ?? null))
  ) {
    throw new ChatV2HttpError("GENERAL_CHAT_PURPOSE_CONFLICT", 409);
  }
  if (
    dispatchValidation.kind === "legacy" &&
    stripFrontMindGeneralChatOperationContract(userMessage.content).trim() !==
      input.prompt.trim()
  ) {
    // Compatibility only for snapshots written before durable ordinary-chat
    // dispatch metadata existed. A present-but-invalid key is rejected above.
    throw new ChatV2HttpError("USER_MESSAGE_NOT_SYNCED", 409, true);
  }
  const turnRequestHash = requestHash({
    prompt: input.prompt,
    localAssetIds: requestedAssetIds,
    ...(input.contentProductionAction
      ? { contentProductionAction: input.contentProductionAction }
      : {}),
  });
  const operationKey = `chat-turn:${hash(
    `${input.userId}\0${input.conversationId}\0${input.clientRequestId}`,
  )}`;
  const existingTurn = (
    await input.executor
      .select()
      .from(conversationTurns)
      .where(
        and(
          eq(conversationTurns.conversationId, persistedConversationId),
          eq(conversationTurns.clientRequestId, input.clientRequestId),
        ),
      )
      .limit(1)
  )[0] as typeof conversationTurns.$inferSelect | undefined;
  if (existingTurn) {
    const metadata = existingTurn.metadata ?? {};
    if (
      existingTurn.userId !== input.userId ||
      existingTurn.operationType !== GENERAL_CHAT_TURN_TYPE ||
      existingTurn.operationKey !== operationKey ||
      existingTurn.requestHash !== turnRequestHash ||
      existingTurn.upstreamTaskId !== input.localTaskId ||
      metadata.agentTaskId !== input.localTaskId ||
      metadata.operationId !== input.operationId
    ) {
      throw new ChatV2HttpError("IDEMPOTENCY_CONFLICT", 409);
    }
    await bindPersistedGeneralChatUserMessageTurn({
      executor: input.executor,
      userMessage,
      persistedConversationId,
      turnId: existingTurn.id,
    });
    return { conversation, turn: existingTurn, persistedConversationId };
  }
  const turnId = randomUUID();
  if (
    input.contentProductionAction &&
    (!input.availableContentActions?.includes(
      input.contentProductionAction.kind,
    ) ||
      input.contentProductionAction.revision !== input.contentRunnerRevision)
  ) {
    throw new ChatV2HttpError("CONTENT_PRODUCTION_CONFIRMATION_CONFLICT", 409);
  }
  const now = new Date();
  const metadata = {
    schemaVersion: 1,
    agentTaskId: input.localTaskId,
    operationId: input.operationId,
    userMessageId: input.clientRequestId,
    promptSha256: hash(input.prompt),
    attachmentManifestHash: requestHash(requestedAssetIds),
    providerAttachmentFileIds: [],
    providerEventWatermark: [],
  };
  await input.executor.insert(conversationTurns).values({
    id: turnId,
    conversationId: persistedConversationId,
    userId: input.userId,
    apiCredentialId: input.credentialId,
    clientRequestId: input.clientRequestId,
    operationKey,
    operationType: GENERAL_CHAT_TURN_TYPE,
    requestHash: turnRequestHash,
    upstreamIdempotencyKeyHash: hash(operationKey),
    attachmentFileIds: requestedAssetIds,
    metadata,
    model: input.model,
    status: "queued",
    upstreamTaskId: input.localTaskId,
  });
  await bindPersistedGeneralChatUserMessageTurn({
    executor: input.executor,
    userMessage,
    persistedConversationId,
    turnId,
  });
  if (input.purpose) {
    const phases = [input.contentProductionAction ? "confirming_result" : input.purpose === "enterprise_qa" ? "submitting_question" : "preparing_requirements", ...(input.knowledgePrepared ? ["loading_knowledge"] : [])];
    for (const [rank, phase] of phases.entries()) await input.executor.insert(agentEvents).values({
      id: randomUUID(), taskId: input.localTaskId, providerEventId: `business:${turnId}:${phase}`, eventType: "business_execution", providerTimestampMs: now.getTime(),
      normalizedPayload: { kind: "business_event", businessPhase: phase, providerOriginalRank: -2 + rank, executionTurn: { id: turnId, userSequence: userMessage.sequence, userMessageId: input.clientRequestId }, executionActivity: { kind: "status", status: "ended" } },
    });
  }
  await input.executor
    .update(conversations)
    .set({
      upstreamTaskId: input.localTaskId,
      previousResponseId: input.localTaskId,
      status: "running",
      startedAt: conversation.startedAt ?? now,
    })
    .where(and(eq(conversations.id, persistedConversationId), enterpriseProjectPredicate(conversations.enterpriseProjectId)));
  return {
    conversation,
    turn: {
      id: turnId,
      conversationId: persistedConversationId,
      metadata,
    },
    persistedConversationId,
  };
}

async function reserveCreate(input: {
  userId: number;
  projectAssignmentId: string | null;
  credential: NonNullable<Express.Request["frontmindCredential"]>;
  value: z.infer<typeof taskCreateSchema>;
}) {
  const db = await requireDb();
  const idempotencyKeyHash = hash(
    currentEnterpriseProjectId()
      ? `${input.userId}\0${currentEnterpriseProjectId()}\0${input.value.clientRequestId}`
      : `${input.userId}\0${input.value.clientRequestId}`,
  );
  const requestCoordinates = {
    conversationId: input.value.conversationId,
    prompt: input.value.prompt,
    localAssetIds: input.value.localAssetIds,
    modelProfile: input.value.modelProfile,
    ...(input.value.purpose ? { purpose: input.value.purpose } : {}),
    ...(input.value.contentProduction ? { contentProduction: input.value.contentProduction } : {}),
  };
  let frozenRequestHash = requestHash({
    ...(currentEnterpriseProjectId() ? { enterpriseProjectId: currentEnterpriseProjectId() } : {}),
    ...requestCoordinates,
  });
  // Only a migrated default can own a pre-project replay key. New projects
  // always use their own namespace, even for the same client request UUID.
  const legacyIdempotencyKeyHash = getEnterpriseProjectScope()?.isLegacyDefault
    ? hash(`${input.userId}\0${input.value.clientRequestId}`) : null;
  const existingRows = await db
    .select({ operation: agentOperations, task: agentTasks })
    .from(agentOperations)
    .innerJoin(agentTasks, eq(agentTasks.operationId, agentOperations.id))
    .where(and(
      eq(agentOperations.scope, "managed_user"),
      eq(agentOperations.accountUserId, input.userId),
      enterpriseProjectPredicate(agentOperations.enterpriseProjectId),
      or(eq(agentOperations.idempotencyKeyHash, idempotencyKeyHash), legacyIdempotencyKeyHash ? eq(agentOperations.idempotencyKeyHash, legacyIdempotencyKeyHash) : undefined),
    )).limit(2);
  if (existingRows.length > 1) throw new ChatV2HttpError("IDEMPOTENCY_CONFLICT", 409);
  const existing = existingRows[0];
  if (existing && legacyIdempotencyKeyHash && existing.operation.idempotencyKeyHash === legacyIdempotencyKeyHash) {
    frozenRequestHash = requestHash(requestCoordinates);
  }
  if (existing) {
    if (
      existing.operation.accountUserId !== input.userId ||
      (existing.operation.enterpriseProjectId ?? null) !== currentEnterpriseProjectId() ||
      existing.operation.requestHash !== frozenRequestHash
    ) {
      throw new ChatV2HttpError("IDEMPOTENCY_CONFLICT", 409);
    }
    await db.transaction((tx) =>
      reservePersistedGeneralChatTurn({
        executor: tx,
        userId: input.userId,
        projectAssignmentId: input.projectAssignmentId,
        credentialId: input.credential.id,
        conversationId: input.value.conversationId,
        clientRequestId: input.value.clientRequestId,
        prompt: input.value.prompt,
        localAssetIds: input.value.localAssetIds,
        operationId: existing.operation.id,
        localTaskId: existing.task.id,
        model: existing.operation.upstreamModel,
        modelProfile: input.value.modelProfile,
        purpose: input.value.purpose,
        contentProduction: input.value.contentProduction,
        continuation: false,
      }),
    );
    const claim = await claimCreatePreparation({
      operationId: existing.operation.id,
      taskId: existing.task.id,
      userId: input.userId,
      requestHash: frozenRequestHash,
      prompt: input.value.prompt,
      localAssetIds: input.value.localAssetIds,
    });
    const owned = claim.acquired
      ? await findOwnedTask({
          userId: input.userId,
          localTaskId: existing.task.id,
        })
      : existing;
    return { ...owned, ...claim, created: false as const };
  }

  // Refuse an unfunded new task before creating any provider resources. Existing
  // task replays above still reconcile even when their funds are fully reserved.
  await assertAiAccountFunds(input.userId);
  const execution = input.value.purpose
    ? generalAgentRuntimeForCredential(input.credential)
    : generalAgentRuntimeForSelection(input.credential, input.value.modelProfile);
  if (
    Boolean(input.value.contentProduction) !==
    (input.value.purpose === "content_production")
  ) {
    throw new ChatV2HttpError("CONTENT_PRODUCTION_INPUT_REQUIRED", 400);
  }
  if (input.value.contentProduction) {
    originalContentWorkflowArchive();
    const sourceIds = [
      ...input.value.contentProduction.monitoringAnswerAssetIds,
      ...(input.value.contentProduction.sourceWorkbookAssetId
        ? [input.value.contentProduction.sourceWorkbookAssetId]
        : []),
    ];
    if (sourceIds.some((id) => !input.value.localAssetIds.includes(id)))
      throw new ChatV2HttpError("CONTENT_PRODUCTION_INPUT_ASSET_CONFLICT", 400);
  }
  const operationId = randomUUID();
  const localTaskId = randomUUID();
  const createMarker = `chat-create:${operationId}`;
  const title = `FrontMind chat ${localTaskId}`;
  try {
    await db.transaction(async (tx) => {
      await lockCustomerProjectBusinessWrite(tx, input.userId);
      let purposeContext: FrozenGeneralAgentPurpose | null = null;
      if (input.value.purpose) {
        const useKnowledge =
          input.value.purpose === "enterprise_qa" ||
          input.value.contentProduction?.knowledgeSource === "published";
        const knowledge = useKnowledge
          ? await publishedGeneralAgentKnowledge(tx, input.userId)
          : null;
        if (useKnowledge && !knowledge)
          throw new ChatV2HttpError("ENTERPRISE_QA_KNOWLEDGE_REQUIRED", 428);
        purposeContext = {
          revision: 1,
          accountUserId: input.userId,
          enterpriseProjectId: currentEnterpriseProjectId(),
          purpose: input.value.purpose,
          knowledgeBase: knowledge?.knowledgeBase ?? null,
          knowledgeText: knowledge?.knowledgeText ?? null,
          ...(input.value.contentProduction
            ? { contentProduction: input.value.contentProduction }
            : {}),
        };
        if (input.value.contentProduction && input.value.localAssetIds.length) {
          const rows = await tx
            .select({
              localAssetId: localAssets.id,
              filename: localAssets.filename,
            })
            .from(localAssets)
            .where(
              and(
                eq(localAssets.scope, "managed_user"),
                eq(localAssets.accountUserId, input.userId),
            enterpriseProjectPredicate(localAssets.enterpriseProjectId),
                inArray(localAssets.id, input.value.localAssetIds),
              ),
            );
          if (rows.length !== new Set(input.value.localAssetIds).size)
            throw new ChatV2HttpError("LOCAL_ASSET_NOT_FOUND", 404);
          purposeContext.inputFiles = rows;
        }
      }
      await tx.insert(agentOperations).values({
        id: operationId,
        provider: input.credential.provider ?? "zhipu",
        scope: "managed_user",
        accountUserId: input.userId,
        presalesProjectId: null,
        operationType: CHAT_CONTRACT,
        idempotencyKeyHash,
        requestHash: frozenRequestHash,
        contractName: CHAT_CONTRACT,
        contractRevision: CHAT_CONTRACT_REVISION,
        schemaHash: CHAT_SCHEMA_HASH,
        apiCredentialId: input.credential.id,
        credentialVersion: input.credential.version,
        // Freeze the selected general profile or the workflow credential profile.
        publicProfile: execution.publicProfile,
        upstreamModel: execution.upstreamModel,
        status: "queued",
      });
      await tx.insert(agentTasks).values({
        id: localTaskId,
        operationId,
        providerTaskId: null,
        providerRequestId: null,
        createMarker,
        title,
        providerState: "queued",
        ...(purposeContext
          ? { providerRuntime: { generalPurpose: purposeContext } }
          : {}),
      });
      await reservePersistedGeneralChatTurn({
        executor: tx,
        userId: input.userId,
        projectAssignmentId: input.projectAssignmentId,
        credentialId: input.credential.id,
        conversationId: input.value.conversationId,
        clientRequestId: input.value.clientRequestId,
        prompt: input.value.prompt,
        localAssetIds: input.value.localAssetIds,
        operationId,
        localTaskId,
        model: execution.upstreamModel,
        modelProfile: input.value.modelProfile,
        purpose: input.value.purpose,
        knowledgePrepared: Boolean(purposeContext?.knowledgeBase),
        contentProduction: input.value.contentProduction,
        continuation: false,
      });
    });
  } catch (error) {
    const raced = (
      await db
        .select({ operation: agentOperations, task: agentTasks })
        .from(agentOperations)
        .innerJoin(agentTasks, eq(agentTasks.operationId, agentOperations.id))
        .where(
          and(
            eq(agentOperations.scope, "managed_user"),
            eq(agentOperations.idempotencyKeyHash, idempotencyKeyHash),
          ),
        )
        .limit(1)
    )[0];
    if (!raced) throw error;
    if (
      raced.operation.accountUserId !== input.userId ||
      (raced.operation.enterpriseProjectId ?? null) !== currentEnterpriseProjectId() ||
      raced.operation.requestHash !== frozenRequestHash
    ) {
      throw new ChatV2HttpError("IDEMPOTENCY_CONFLICT", 409);
    }
    await db.transaction((tx) =>
      reservePersistedGeneralChatTurn({
        executor: tx,
        userId: input.userId,
        projectAssignmentId: input.projectAssignmentId,
        credentialId: input.credential.id,
        conversationId: input.value.conversationId,
        clientRequestId: input.value.clientRequestId,
        prompt: input.value.prompt,
        localAssetIds: input.value.localAssetIds,
        operationId: raced.operation.id,
        localTaskId: raced.task.id,
        model: raced.operation.upstreamModel,
        modelProfile: input.value.modelProfile,
        purpose: input.value.purpose,
        contentProduction: input.value.contentProduction,
        continuation: false,
      }),
    );
    const claim = await claimCreatePreparation({
      operationId: raced.operation.id,
      taskId: raced.task.id,
      userId: input.userId,
      requestHash: frozenRequestHash,
      prompt: input.value.prompt,
      localAssetIds: input.value.localAssetIds,
    });
    const owned = claim.acquired
      ? await findOwnedTask({
          userId: input.userId,
          localTaskId: raced.task.id,
        })
      : raced;
    return { ...owned, ...claim, created: false as const };
  }
  const claim = await claimCreatePreparation({
    operationId,
    taskId: localTaskId,
    userId: input.userId,
    requestHash: frozenRequestHash,
    prompt: input.value.prompt,
    localAssetIds: input.value.localAssetIds,
  });
  const created = await findOwnedTask({ userId: input.userId, localTaskId });
  return { ...created, ...claim, created: true as const };
}

async function sendProviderMessage(input: {
  operation: AgentOperation;
  task: AgentTask;
  credential: NonNullable<
    Awaited<ReturnType<typeof getDecryptedCredentialForAccountById>>
  >;
  clientRequestId: string;
  prompt: string;
  localAssetIds: readonly string[];
  turnId: string;
  conversationId: string;
  contentProductionAction?: ContentProductionAction;
}) {
  if (!input.task.providerTaskId) {
    throw new ChatV2HttpError("TASK_NOT_READY", 409, true);
  }
  const db = await requireDb();
  const markerHash = hash(
    `${input.operation.accountUserId}\0${input.task.id}\0${input.clientRequestId}`,
  );
  const providerEventId = `local-send:${markerHash}`;
  const frozenRequestHash = requestHash({
    prompt: input.prompt,
    localAssetIds: input.localAssetIds,
    ...(input.contentProductionAction
      ? { contentProductionAction: input.contentProductionAction }
      : {}),
  });
  const eventId = randomUUID();
  const initialClaim = createGeneralChatPreparationClaim();
  const preparingPayload = {
    kind: "local_send_reservation",
    requestHash: frozenRequestHash,
    localAssetIds: sortedUnique(input.localAssetIds),
    ...initialClaim,
    status: "preparing",
  };
  await db
    .insert(agentEvents)
    .values({
      id: eventId,
      taskId: input.task.id,
      providerEventId,
      eventType: "local_send_reservation",
      providerTimestampMs: Date.now(),
      normalizedPayload: preparingPayload,
    })
    .onDuplicateKeyUpdate({ set: { providerEventId } });
  const reservation = (
    await db
      .select()
      .from(agentEvents)
      .where(
        and(
          eq(agentEvents.taskId, input.task.id),
          eq(agentEvents.providerEventId, providerEventId),
        ),
      )
      .limit(1)
  )[0]!;
  let payload = reservation.normalizedPayload ?? {};
  if (payload.requestHash !== frozenRequestHash) {
    throw new ChatV2HttpError("IDEMPOTENCY_CONFLICT", 409);
  }
  let acquired = reservation.id === eventId;
  let activeClaimToken = initialClaim.claimToken;
  if (!acquired && payload.status === "preparing") {
    const takeoverClaim = createGeneralChatPreparationClaim();
    const takeover = await db.transaction(async (tx) => {
      const lockedReservation = (
        await tx
          .select({ normalizedPayload: agentEvents.normalizedPayload })
          .from(agentEvents)
          .where(
            and(
              eq(agentEvents.id, reservation.id),
              eq(agentEvents.taskId, input.task.id),
              eq(agentEvents.providerEventId, providerEventId),
            ),
          )
          .limit(1)
          .for("update")
      )[0];
      const lockedPayload = lockedReservation?.normalizedPayload;
      if (!lockedPayload || lockedPayload.requestHash !== frozenRequestHash) {
        throw new ChatV2HttpError("IDEMPOTENCY_CONFLICT", 409);
      }
      if (
        lockedPayload.status !== "preparing" ||
        !generalChatPreparationClaimIsStale(lockedPayload.claimUpdatedAtMs)
      ) {
        return { acquired: false as const, payload: lockedPayload };
      }
      const claimedPayload = {
        ...lockedPayload,
        ...takeoverClaim,
        status: "preparing",
      };
      await tx
        .update(agentEvents)
        .set({ normalizedPayload: claimedPayload })
        .where(eq(agentEvents.id, reservation.id));
      return { acquired: true as const, payload: claimedPayload };
    });
    payload = takeover.payload;
    if (takeover.acquired) {
      acquired = true;
      activeClaimToken = takeoverClaim.claimToken;
    }
  }
  const client = clientFor(
    input.credential,
    input.operation.accountUserId!,
    input.operation,
    input.task,
    input.turnId,
    input.contentProductionAction,
  );
  const reconcileReservedSend = async (evidence: Record<string, unknown>) => {
    if (evidence.status === "acknowledged") return true;
    const promptSha256 =
      typeof evidence.promptSha256 === "string" ? evidence.promptSha256 : null;
    if (!promptSha256) {
      await updateTaskState({
        operationId: input.operation.id,
        localTaskId: input.task.id,
        status: "attention_required",
        providerState: "attention_required",
        errorCode: "SEND_RECONCILE_EVIDENCE_MISSING",
        turnId: input.turnId,
        conversationId: input.conversationId,
      });
      return false;
    }
    const events = await client.listAllMessages({
      taskId: input.task.providerTaskId!,
      order: "desc",
    });
    const persisted = await persistProviderEvents({
      operation: input.operation,
      task: input.task,
      events,
    });
    if (!persisted.applied) return false;
    const binding = persisted.bindings.get(input.turnId) ?? {
      binding: "pending" as const,
      matchedUserEventId: null,
      matchCount: 0,
      unresolvedCount: 1,
    };
    const uniquelyMatched = generalChatProviderEvidenceHasUniqueMatch({
      matchCount: binding.matchCount,
      unresolvedCount: binding.unresolvedCount,
    });
    if (binding.binding === "bound" && uniquelyMatched) {
      await db
        .update(agentEvents)
        .set({ normalizedPayload: { ...evidence, status: "acknowledged" } })
        .where(eq(agentEvents.id, reservation.id));
      return true;
    }
    if (binding.binding === "ambiguous" || binding.matchCount > 1) {
      await db
        .update(agentEvents)
        .set({ normalizedPayload: { ...evidence, status: "ambiguous" } })
        .where(eq(agentEvents.id, reservation.id));
      await updateTaskState({
        operationId: input.operation.id,
        localTaskId: input.task.id,
        status: "attention_required",
        providerState: "attention_required",
        errorCode: "SEND_RECONCILE_CONFLICT",
        turnId: input.turnId,
        conversationId: input.conversationId,
      });
      return false;
    }
    await db
      .update(agentEvents)
      .set({ normalizedPayload: { ...evidence, status: "outcome_unknown" } })
      .where(eq(agentEvents.id, reservation.id));
    await updateTaskState({
      operationId: input.operation.id,
      localTaskId: input.task.id,
      status: "running",
      providerState: "outcome_unknown",
      errorCode: "SEND_OUTCOME_UNKNOWN",
      turnId: input.turnId,
      conversationId: input.conversationId,
    });
    return false;
  };
  if (!acquired) {
    if (payload.status === "preparing") {
      throw new ChatV2HttpError("SEND_PREPARATION_IN_PROGRESS", 409, true);
    }
    if (payload.status === "rejected") {
      if (payload.rejectionProven === true) {
        if (typeof payload.rejectionCode === "string" && payload.rejectionCode.startsWith("AI_"))
          throw new AiBillingError(payload.rejectionCode);
        throw new ChatV2HttpError(
          typeof payload.rejectionCode === "string" ? payload.rejectionCode : "SEND_REJECTED",
          typeof payload.rejectionStatus === "number" ? payload.rejectionStatus : 422,
          payload.rejectionStatus === 429,
          true,
        );
      }
      throw new ChatV2HttpError("SEND_OUTCOME_UNRESOLVED", 409, true);
    }
    const acknowledged = await reconcileReservedSend(payload);
    if (!acknowledged) {
      throw new ChatV2HttpError("SEND_OUTCOME_UNRESOLVED", 409, true);
    }
    return;
  }

  let attachments: Awaited<ReturnType<typeof ensureProviderAttachments>>;
  let frozenEvidence: Record<string, unknown>;
  try {
    const turnExists = (
      await db
        .select({ id: conversationTurns.id })
        .from(conversationTurns)
        .where(
          and(
            eq(conversationTurns.id, input.turnId),
            eq(conversationTurns.userId, input.operation.accountUserId!),
            eq(conversationTurns.operationType, GENERAL_CHAT_TURN_TYPE),
            eq(conversationTurns.upstreamTaskId, input.task.id),
          ),
        )
        .limit(1)
    )[0];
    if (!turnExists) {
      throw new ChatV2HttpError("GENERAL_CHAT_TURN_NOT_FOUND", 409);
    }
    attachments = await ensureProviderAttachments({
      operation: input.operation,
      task: input.task,
      credential: input.credential,
      localAssetIds: input.localAssetIds,
    });
    const attachmentFileIds = providerAttachmentFileIds(attachments);
    const beforeEvents = await client.listAllMessages({
      taskId: input.task.providerTaskId,
      order: "desc",
    });
    frozenEvidence = {
      ...payload,
      promptSha256: hash(input.prompt),
      attachmentFileIds,
      providerEventWatermark: beforeEvents.map((event) => event.id),
      status: "sending",
    };
    await db.transaction(async (tx) => {
      const lockedReservation = (
        await tx
          .select({ normalizedPayload: agentEvents.normalizedPayload })
          .from(agentEvents)
          .where(
            and(
              eq(agentEvents.id, reservation.id),
              eq(agentEvents.taskId, input.task.id),
              eq(agentEvents.providerEventId, providerEventId),
            ),
          )
          .limit(1)
          .for("update")
      )[0];
      if (
        !lockedReservation ||
        lockedReservation.normalizedPayload.requestHash !== frozenRequestHash ||
        lockedReservation.normalizedPayload.status !== "preparing" ||
        lockedReservation.normalizedPayload.claimToken !== activeClaimToken
      ) {
        throw new ChatV2HttpError("SEND_RESERVATION_CONFLICT", 409, true);
      }
      const turnRow = (
        await tx
          .select({
            conversationId: conversationTurns.conversationId,
            clientRequestId: conversationTurns.clientRequestId,
            requestHash: conversationTurns.requestHash,
            metadata: conversationTurns.metadata,
          })
          .from(conversationTurns)
          .where(
            and(
              eq(conversationTurns.id, input.turnId),
              eq(conversationTurns.userId, input.operation.accountUserId!),
              eq(conversationTurns.operationType, GENERAL_CHAT_TURN_TYPE),
              eq(conversationTurns.upstreamTaskId, input.task.id),
            ),
          )
          .limit(1)
          .for("update")
      )[0];
      if (!turnRow) {
        throw new ChatV2HttpError("GENERAL_CHAT_TURN_NOT_FOUND", 409);
      }
      if (
        turnRow.clientRequestId !== input.clientRequestId ||
        turnRow.requestHash !== frozenRequestHash
      ) {
        throw new ChatV2HttpError("IDEMPOTENCY_CONFLICT", 409);
      }
      const persistedMessageId = persistedMessageIdForConversation(
        turnRow.conversationId,
        input.clientRequestId,
      );
      const boundUserMessage = (
        await tx
          .select({
            content: messages.content,
            metadata: messages.metadata,
            turnId: messages.turnId,
          })
          .from(messages)
          .where(
            and(
              eq(messages.id, persistedMessageId),
              eq(messages.conversationId, turnRow.conversationId),
              eq(messages.userId, input.operation.accountUserId!),
              eq(messages.role, "user"),
              eq(messages.turnId, input.turnId),
              isNull(messages.deletedAt),
            ),
          )
          .limit(1)
          .for("update")
      )[0];
      if (!boundUserMessage || boundUserMessage.turnId !== input.turnId) {
        throw new ChatV2HttpError("USER_MESSAGE_TURN_CONFLICT", 409);
      }
      const dispatchValidation = validateGeneralChatDispatchMetadata({
        metadata: boundUserMessage.metadata,
        clientRequestId: input.clientRequestId,
        providerPrompt: input.prompt,
        localAssetIds: sortedUnique(input.localAssetIds),
        originalLocalTaskId: input.task.id,
        modelProfile: null,
      });
      if (
        dispatchValidation.kind === "invalid" ||
        (dispatchValidation.kind === "legacy" &&
          stripFrontMindGeneralChatOperationContract(
            boundUserMessage.content,
          ).trim() !== input.prompt.trim())
      ) {
        throw new ChatV2HttpError("USER_MESSAGE_DISPATCH_CONFLICT", 409);
      }
      await tx
        .update(agentEvents)
        .set({ normalizedPayload: frozenEvidence })
        .where(eq(agentEvents.id, reservation.id));
      await tx
        .update(conversationTurns)
        .set({
          metadata: {
            ...(turnRow.metadata ?? {}),
            providerAttachmentFileIds: attachmentFileIds,
            providerEventWatermark: beforeEvents.map((event) => event.id),
          },
          status: "running",
          startedAt: new Date(),
        })
        .where(eq(conversationTurns.id, input.turnId));
    });
  } catch (error) {
    await db.transaction(async (tx) => {
      const currentReservation = (
        await tx
          .select({ normalizedPayload: agentEvents.normalizedPayload })
          .from(agentEvents)
          .where(eq(agentEvents.id, reservation.id))
          .limit(1)
          .for("update")
      )[0];
      if (
        currentReservation?.normalizedPayload.requestHash ===
          frozenRequestHash &&
        currentReservation.normalizedPayload.claimToken === activeClaimToken &&
        ["preparing", "sending", "outcome_unknown"].includes(
          String(currentReservation.normalizedPayload.status ?? ""),
        )
      ) {
        await tx.delete(agentEvents).where(eq(agentEvents.id, reservation.id));
      }
    });
    throw error;
  }

  try {
    await client.sendMessage({
      taskId: input.task.providerTaskId,
      prompt: input.prompt,
      attachments,
    });
  } catch (error) {
    if (error instanceof ManusV2ApiError && error.outcomeUnknown) {
      const acknowledged = await reconcileReservedSend(frozenEvidence).catch(() => false);
      if (!acknowledged) {
        throw new ChatV2HttpError("SEND_OUTCOME_UNRESOLVED", 409, true);
      }
      return;
    }
    if (!generalChatDispatchIsDefinitelyRejected(error)) {
      const acknowledged = await reconcileReservedSend(frozenEvidence).catch(() => false);
      if (!acknowledged) throw new ChatV2HttpError("SEND_OUTCOME_UNRESOLVED", 409, true);
      return;
    }
    const rejectionCode = error instanceof Error && "code" in error ? String(error.code) : "SEND_REJECTED";
    const rejectionStatus = error instanceof ManusV2ApiError ? (error.status ?? 422) : (aiBillingHttpFailure(error)?.status ?? 503);
    await db
      .update(agentEvents)
      .set({
        normalizedPayload: {
          ...frozenEvidence,
          status: "rejected",
          rejectionProven: true,
          rejectionCode,
          rejectionStatus,
        },
      })
      .where(eq(agentEvents.id, reservation.id));
    await updateTaskState({
      operationId: input.operation.id,
      localTaskId: input.task.id,
      status: "failed",
      providerState: "failed",
      errorCode: rejectionCode,
      turnId: input.turnId,
      conversationId: input.conversationId,
    });
    if (!(error instanceof ManusV2ApiError)) throw error;
    throw new ChatV2HttpError(rejectionCode, rejectionStatus, error.retryable, true);
  }
  await db
    .update(agentEvents)
    .set({
      normalizedPayload: { ...frozenEvidence, status: "acknowledged" },
    })
    .where(eq(agentEvents.id, reservation.id));
  await updateTaskState({
    operationId: input.operation.id,
    localTaskId: input.task.id,
    status: "running",
    providerState: "running",
    errorCode: null,
    resultDeadlineAt: null,
    turnId: input.turnId,
    conversationId: input.conversationId,
  });
}

function sendError(res: Response, error: unknown) {
  if (sendAiBillingError(res, error)) return;
  if (error instanceof OwnedFileContentError) {
    res.status(error.statusCode).json({
      error: {
        code: error.code,
        message: error.message,
        retryable: error.retryable,
        recoveryAction: error.recoveryAction,
        ...(error.expiresAt !== undefined
          ? { expiresAt: error.expiresAt }
          : {}),
      },
    });
    return;
  }
  if (error instanceof ChatV2HttpError) {
    res.status(error.statusCode).json({
      error: {
        code: error.code,
        message: generalChatHttpErrorMessage(error.code, error.statusCode),
        retryable: error.retryable,
        dispatchSettled: error.dispatchSettled,
      },
    });
    return;
  }
  if (error instanceof z.ZodError) {
    res.status(400).json({
      error: {
        code: "INVALID_REQUEST",
        message: "请求参数无效",
        retryable: false,
      },
    });
    return;
  }
  if (error instanceof ManusV2ApiError) {
    res
      .status(
        error.status && error.status >= 400 && error.status < 500
          ? error.status
          : 502,
      )
      .json({
        error: {
          code: error.code,
          message: "FrontMind 服务暂不可用",
          retryable: error.retryable,
        },
      });
    return;
  }
  console.error("[FrontMindV2] request failed", {
    code: error instanceof Error ? error.name : "UNKNOWN_ERROR",
  });
  res.status(500).json({
    error: {
      code: "INTERNAL_ERROR",
      message: "请求未能完成",
      retryable: false,
    },
  });
}

router.post("/assets", async (req, res) => {
  const traceId = randomUUID();
  const startedAt = Date.now();
  let declaredBytes: number | undefined;
  let receivedBytes = 0;
  let temporaryDiscarded = false;
  let assetCommitted = false;
  const uploadAttempt = Math.max(
    1,
    Math.min(3, Number(req.headers["x-frontmind-upload-attempt"]) || 1),
  );
  let knowledgeCoordinate: ReturnType<
    typeof parseKnowledgeBaseLocalUploadCoordinate
  > = null;
  let siteOpsComposerCoordinate: ReturnType<
    typeof parseSiteOpsComposerLocalUploadCoordinate
  > = null;
  try {
    if (!req.frontmindUser) throw new ChatV2HttpError("UNAUTHORIZED", 401);
    const ownerUserId = enterpriseWorkspaceUserId(req.frontmindUser.id);
    const filename = cleanFilename(req.headers["x-frontmind-filename"]);
    const mimeType = cleanMimeType(
      req.headers["x-frontmind-mime"] ?? req.headers["content-type"],
    );
    declaredBytes = Number(
      req.headers["x-frontmind-size"] ?? req.headers["content-length"],
    );
    if (
      !Number.isSafeInteger(declaredBytes) ||
      declaredBytes <= 0 ||
      declaredBytes > MAX_LOCAL_ASSET_BYTES
    ) {
      throw new ChatV2HttpError("LOCAL_ASSET_SIZE_INVALID", 413);
    }
    try {
      knowledgeCoordinate = parseKnowledgeBaseLocalUploadCoordinate(
        req.headers,
      );
      siteOpsComposerCoordinate = parseSiteOpsComposerLocalUploadCoordinate(
        req.headers,
      );
    } catch (error) {
      if (error instanceof KnowledgeBaseLocalAssetCoordinateError) {
        throw new ChatV2HttpError(error.code, 400);
      }
      if (error instanceof SiteOpsComposerLocalAssetCoordinateError) {
        throw new ChatV2HttpError(error.code, 400);
      }
      throw error;
    }
    if (knowledgeCoordinate && siteOpsComposerCoordinate) {
      throw new ChatV2HttpError("LOCAL_ASSET_COORDINATE_CONFLICT", 400);
    }
    if (
      siteOpsComposerCoordinate &&
      (declaredBytes > MAX_SITEOPS_COMPOSER_ASSET_BYTES ||
        !["image/jpeg", "image/png", "image/webp"].includes(mimeType))
    ) {
      throw new ChatV2HttpError("SITEOPS_COMPOSER_ASSET_INVALID", 400);
    }
    const knowledgeIdentity = knowledgeCoordinate
      ? knowledgeBaseLocalAssetIdentity({
          userId: ownerUserId,
          projectAssignmentId:
            req.frontmindDeliveryProjectContext?.projectAssignmentId ?? null,
          coordinate: knowledgeCoordinate,
          sizeBytes: declaredBytes,
        })
      : null;
    const assertKnowledgeCoordinate = async (
      authoritativeContentSha256?: string,
      onVerified?: (tx: any) => Promise<any>,
    ) => {
      if (!knowledgeCoordinate) return;
      try {
        return await assertKnowledgeBaseLocalUploadCoordinate({
          userId: ownerUserId,
          projectAssignmentId:
            req.frontmindDeliveryProjectContext?.projectAssignmentId ?? null,
          uploadAttemptId: knowledgeCoordinate.uploadAttemptId,
          conversationId: knowledgeCoordinate.conversationId,
          turnId: knowledgeCoordinate.turnId,
          clientRequestId: knowledgeCoordinate.clientRequestId,
          itemId: knowledgeCoordinate.itemId,
          expectedResetRevision: knowledgeCoordinate.expectedResetRevision,
          ordinal: knowledgeCoordinate.ordinal,
          filename,
          mimeType,
          sizeBytes: declaredBytes!,
          contentSha256: knowledgeCoordinate.contentSha256,
          authoritativeContentSha256,
        }, undefined, onVerified);
      } catch (error) {
        throw knowledgeBaseUploadReservationError(error);
      }
    };
    const assertSiteOpsComposerCoordinate = async (
      authoritativeContentSha256?: string,
      expectedEpoch?: SiteOpsComposerUploadEpoch,
    ) => {
      if (!siteOpsComposerCoordinate) return null;
      if (
        authoritativeContentSha256 &&
        authoritativeContentSha256 !== siteOpsComposerCoordinate.contentSha256
      ) {
        throw new ChatV2HttpError("LOCAL_ASSET_SHA256_MISMATCH", 400);
      }
      const db = await requireDb();
      const current = await currentSiteOpsComposerUploadEpoch(db, ownerUserId);
      if (!current) {
        throw new ChatV2HttpError("SITEOPS_COMPOSER_UPLOAD_NOT_AVAILABLE", 409);
      }
      if (
        expectedEpoch &&
        (current.projectId !== expectedEpoch.projectId ||
          current.knowledgeInputEpochId !==
            expectedEpoch.knowledgeInputEpochId ||
          current.currentTaskStartedAt.getTime() !==
            expectedEpoch.currentTaskStartedAt.getTime())
      ) {
        throw new ChatV2HttpError("SITEOPS_COMPOSER_UPLOAD_EPOCH_CHANGED", 409);
      }
      return current;
    };
    // Reject forged, reset or already-dispatched coordinates before consuming
    // a potentially 100 MiB request body.
    await assertKnowledgeCoordinate();
    const siteOpsComposerEpoch = await assertSiteOpsComposerCoordinate();
    const siteOpsComposerIdentity =
      siteOpsComposerCoordinate && siteOpsComposerEpoch
        ? siteOpsComposerLocalAssetIdentity({
            userId: ownerUserId,
            projectId: siteOpsComposerEpoch.projectId,
            currentTaskStartedAt: siteOpsComposerEpoch.currentTaskStartedAt,
            knowledgeInputEpochId: siteOpsComposerEpoch.knowledgeInputEpochId,
            coordinate: siteOpsComposerCoordinate,
            filename,
            mimeType,
            sizeBytes: declaredBytes,
          })
        : null;
    console.info("[FrontMindV2Asset] upload_start", {
      traceId,
      declaredBytes,
      uploadAttempt,
      ...(knowledgeCoordinate
        ? {
            uploadAttemptId: knowledgeCoordinate.uploadAttemptId,
          conversationId: knowledgeCoordinate.conversationId,
            turnId: knowledgeCoordinate.turnId,
            itemId: knowledgeCoordinate.itemId,
            ordinal: knowledgeCoordinate.ordinal,
            expectedResetRevision: knowledgeCoordinate.expectedResetRevision,
          }
        : {}),
      ...(siteOpsComposerCoordinate
        ? { siteOpsComposerOrdinal: siteOpsComposerCoordinate.ordinal }
        : {}),
    });
    const persistUpload = async () => {
      let db = await requireDb();
      const deterministicIdentity =
        knowledgeIdentity ?? siteOpsComposerIdentity;
      const id = deterministicIdentity?.localAssetId || localAssetId();
      const loadExisting = async () =>
        deterministicIdentity
          ? (
              await db
                .select()
                .from(localAssets)
                .where(
                  and(
                    eq(localAssets.id, deterministicIdentity.localAssetId),
                    eq(localAssets.scope, "managed_user"),
                    eq(localAssets.accountUserId, ownerUserId),
            enterpriseProjectPredicate(localAssets.enterpriseProjectId),
                  ),
                )
                .limit(1)
            )[0]
          : undefined;
      const progressThresholds = [25, 50, 75] as const;
      let nextProgressThreshold = 0;
      const staged = await stagePresalesFileContent({
        fileId: id,
        stream: req,
        maxBytes: siteOpsComposerCoordinate
          ? MAX_SITEOPS_COMPOSER_ASSET_BYTES
          : MAX_LOCAL_ASSET_BYTES,
        onProgress: (nextReceivedBytes) => {
          receivedBytes = nextReceivedBytes;
          while (
            nextProgressThreshold < progressThresholds.length &&
            nextReceivedBytes * 100 >=
              declaredBytes! * progressThresholds[nextProgressThreshold]
          ) {
            const percent = progressThresholds[nextProgressThreshold];
            console.info("[FrontMindV2Asset] upload_progress", {
              traceId,
              declaredBytes,
              receivedBytes: nextReceivedBytes,
              percent,
              durationMs: Date.now() - startedAt,
              ...(knowledgeCoordinate
                ? {
                    uploadAttemptId: knowledgeCoordinate.uploadAttemptId,
          conversationId: knowledgeCoordinate.conversationId,
                    turnId: knowledgeCoordinate.turnId,
                    itemId: knowledgeCoordinate.itemId,
                    ordinal: knowledgeCoordinate.ordinal,
                  }
                : {}),
            });
            nextProgressThreshold += 1;
          }
        },
      }).catch((error) => {
        // stagePresalesFileContent guarantees removal of its partial temp.
        temporaryDiscarded = true;
        throw error;
      });
      try {
        if (staged.sizeBytes !== declaredBytes) {
          throw new ChatV2HttpError("LOCAL_ASSET_SIZE_MISMATCH", 400);
        }
        if (
          knowledgeCoordinate?.contentSha256 &&
          staged.sha256 !== knowledgeCoordinate.contentSha256
        ) {
          throw new ChatV2HttpError("LOCAL_ASSET_SHA256_MISMATCH", 400);
        }
        const authoritativeKnowledgeIdentity = knowledgeCoordinate
          ? knowledgeBaseLocalAssetIdentity({
              userId: ownerUserId,
              projectAssignmentId:
                req.frontmindDeliveryProjectContext?.projectAssignmentId ??
                null,
              coordinate: knowledgeCoordinate,
              sizeBytes: declaredBytes!,
              authoritativeContentSha256: staged.sha256,
            })
          : null;
        const authoritativeSiteOpsComposerIdentity =
          siteOpsComposerCoordinate && siteOpsComposerEpoch
            ? siteOpsComposerLocalAssetIdentity({
                userId: ownerUserId,
                projectId: siteOpsComposerEpoch.projectId,
                currentTaskStartedAt: siteOpsComposerEpoch.currentTaskStartedAt,
                knowledgeInputEpochId:
                  siteOpsComposerEpoch.knowledgeInputEpochId,
                coordinate: siteOpsComposerCoordinate,
                filename,
                mimeType,
                sizeBytes: declaredBytes!,
                authoritativeContentSha256: staged.sha256,
              })
            : null;
        const finalizeUpload = async (knowledgeVerified = false) => {
          // Reset/dispatch can advance while the body is in flight. Re-prove
          // the reservation immediately before the short durable commit.
          if (!knowledgeVerified) await assertKnowledgeCoordinate(staged.sha256);
          await assertSiteOpsComposerCoordinate(
            staged.sha256,
            siteOpsComposerEpoch ?? undefined,
          );
          const now = Date.now();
          const replayPayload = async (
            existing: typeof localAssets.$inferSelect,
          ) => {
            const authoritativeIdentity =
              authoritativeKnowledgeIdentity ??
              authoritativeSiteOpsComposerIdentity;
            if (!authoritativeIdentity) {
              throw new ChatV2HttpError("UPLOAD_OPERATION_CONFLICT", 409);
            }
            const storageIdentity = sealLocalAssetStorageIdentity({
              storageKey: authoritativeIdentity.storageKey!,
            });
            const storedContent = await storedLocalAssetContentState({
              id: existing.id,
              sizeBytes: existing.sizeBytes,
              contentSha256: existing.contentSha256,
            });
            const disposition = siteOpsComposerCoordinate
              ? siteOpsComposerLocalAssetExistingRowDisposition({
                  existing,
                  expected: {
                    localAssetId: siteOpsComposerIdentity!.localAssetId,
                    ownerUserId,
                    filename,
                    mimeType,
                    sizeBytes: staged.sizeBytes,
                    contentSha256: staged.sha256,
                    storageKey:
                      authoritativeSiteOpsComposerIdentity!.storageKey,
                    storageKeyHash: storageIdentity.storageKeyHash,
                    currentTaskStartedAt:
                      siteOpsComposerEpoch!.currentTaskStartedAt,
                    knowledgeInputEpochId:
                      siteOpsComposerEpoch!.knowledgeInputEpochId,
                  },
                  storedContent,
                  now,
                })
              : knowledgeBaseLocalAssetExistingRowDisposition({
                  existing,
                  expected: {
                    localAssetId: knowledgeIdentity!.localAssetId,
                    ownerUserId,
                    sizeBytes: staged.sizeBytes,
                    contentSha256: staged.sha256,
                    storageKey: authoritativeKnowledgeIdentity!.storageKey!,
                    storageKeyHash: storageIdentity.storageKeyHash,
                  },
                  storedContent,
                  now,
                });
            if (disposition.action === "conflict") {
              throw new ChatV2HttpError("UPLOAD_OPERATION_CONFLICT", 409);
            }

            const updateExistingRow = async (values: {
              retainUntil?: Date;
              refCount?: number;
            }) => {
              const refreshed = await db
                .update(localAssets)
                .set({ filename, mimeType, ...values })
                .where(
                  and(
                    eq(localAssets.id, existing.id),
                    eq(localAssets.scope, "managed_user"),
                    eq(localAssets.accountUserId, ownerUserId),
            enterpriseProjectPredicate(localAssets.enterpriseProjectId),
                    isNull(localAssets.presalesProjectId),
                    eq(localAssets.filename, existing.filename),
                    eq(localAssets.mimeType, existing.mimeType),
                    eq(localAssets.sizeBytes, existing.sizeBytes),
                    eq(localAssets.contentSha256, existing.contentSha256),
                    eq(localAssets.storageKey, existing.storageKey),
                    eq(localAssets.storageKeyHash, existing.storageKeyHash),
                    existing.siteOpsKnowledgeInputEpochId
                      ? eq(
                          localAssets.siteOpsKnowledgeInputEpochId,
                          existing.siteOpsKnowledgeInputEpochId,
                        )
                      : isNull(localAssets.siteOpsKnowledgeInputEpochId),
                    eq(localAssets.refCount, existing.refCount),
                  ),
                );
              const affectedRows = Number(
                (
                  refreshed as unknown as Array<{
                    affectedRows?: unknown;
                  }>
                )[0]?.affectedRows ?? 0,
              );
              if (affectedRows !== 1) {
                throw new ChatV2HttpError("UPLOAD_OPERATION_CONFLICT", 409);
              }
            };

            if (disposition.action === "rebuild") {
              const expiresAt = now + LOCAL_CONTENT_RETENTION_MS;
              // The frozen manifest, staged digest and immutable row all name
              // the same content. Re-arm only this missing/expired body; a
              // present corrupt file was rejected above and is never replaced.
              await staged.commit({
                filename,
                mimeType,
                uploadedAt: now,
                contentExpiresAt: expiresAt,
                replaceManagedRetention: true,
              });
              await updateExistingRow({
                retainUntil: new Date(expiresAt),
                refCount: Math.max(1, existing.refCount),
              });
              assetCommitted = true;
              return {
                status: disposition.status,
                payload: {
                  localAssetId: existing.id,
                  filename,
                  mimeType,
                  bytes: existing.sizeBytes,
                  sha256: existing.contentSha256,
                  expiresAt,
                  traceId,
                  replayed: false,
                },
              };
            }

            if (
              existing.filename !== filename ||
              existing.mimeType !== mimeType ||
              existing.refCount < 1
            ) {
              await updateExistingRow({
                refCount: Math.max(1, existing.refCount),
              });
              await recordPresalesFileDescriptor({
                fileId: existing.id,
                filename,
                mimeType,
                sizeBytes: existing.sizeBytes,
              });
            }
            await staged.discard();
            temporaryDiscarded = true;
            assetCommitted = true;
            const expiresAt = existing.retainUntil!.getTime();
            return {
              status: disposition.status,
              payload: {
                localAssetId: existing.id,
                filename,
                mimeType,
                bytes: existing.sizeBytes,
                sha256: existing.contentSha256,
                expiresAt,
                traceId,
                replayed: true,
              },
            };
          };

          const existing = await loadExisting();
          if (existing && deterministicIdentity) {
            return replayPayload(existing);
          }

          const storageKey =
            authoritativeKnowledgeIdentity?.storageKey ??
            authoritativeSiteOpsComposerIdentity?.storageKey ??
            `frontmind-v2:${id}`;
          await staged.commit({
            filename,
            mimeType,
            uploadedAt: now,
            contentExpiresAt: now + LOCAL_CONTENT_RETENTION_MS,
          });
          try {
            await db.insert(localAssets).values(
              sealLocalAssetStorageIdentity({
                id,
                scope: "managed_user" as const,
                accountUserId: ownerUserId,
                enterpriseProjectId: currentEnterpriseProjectId(),
                presalesProjectId: null,
                filename,
                mimeType,
                sizeBytes: staged.sizeBytes,
                contentSha256: staged.sha256,
                storageKey,
                siteOpsKnowledgeInputEpochId:
                  siteOpsComposerEpoch?.knowledgeInputEpochId ?? null,
                refCount: 1,
                retainUntil: new Date(now + LOCAL_CONTENT_RETENTION_MS),
              }),
            );
            assetCommitted = true;
          } catch (insertError) {
            // The insert can commit while its response is lost. Re-read under
            // the same cross-process lock; an exact row is the winner and its
            // final file must never be deleted. If the re-read itself fails,
            // retain the possible winner for reconciliation/retention cleanup.
            let winner: typeof localAssets.$inferSelect | undefined;
            try {
              winner = await loadExisting();
            } catch {
              throw insertError;
            }
            if (winner && deterministicIdentity) {
              return replayPayload(winner);
            }
            await removeStoredPresalesFile(id).catch(() => undefined);
            temporaryDiscarded = true;
            throw insertError;
          }
          return {
            status: 201,
            payload: {
              localAssetId: id,
              filename,
              mimeType,
              bytes: staged.sizeBytes,
              sha256: staged.sha256,
              expiresAt: now + LOCAL_CONTENT_RETENTION_MS,
              traceId,
              replayed: false,
            },
          };
        };
        const commitUnderTurnLock = () => knowledgeCoordinate
          ? assertKnowledgeCoordinate(staged.sha256, async (tx) => {
              const previousDb=db; db=tx;
              try { return await finalizeUpload(true); } finally { db=previousDb; }
            })
          : finalizeUpload();
        return deterministicIdentity
          ? withStoredPresalesFileMutationLock(id, commitUnderTurnLock)
          : commitUnderTurnLock();
      } catch (error) {
        await staged.discard().catch(() => undefined);
        temporaryDiscarded = true;
        throw error;
      }
    };
    const completed = await persistUpload();
    res.status(completed.status).json(completed.payload);
    console.info("[FrontMindV2Asset] upload_complete", {
      traceId,
      declaredBytes,
      receivedBytes: completed.payload.bytes,
      durationMs: Date.now() - startedAt,
      status: completed.status,
      requestAborted: req.aborted,
      requestComplete: req.complete,
      requestDestroyed: req.destroyed,
      temporaryDiscarded,
      assetCommitted,
      replayed: completed.payload.replayed,
      ...(knowledgeCoordinate
        ? {
            uploadAttemptId: knowledgeCoordinate.uploadAttemptId,
          conversationId: knowledgeCoordinate.conversationId,
            turnId: knowledgeCoordinate.turnId,
            itemId: knowledgeCoordinate.itemId,
            ordinal: knowledgeCoordinate.ordinal,
          }
        : {}),
    });
  } catch (error) {
    console.warn("[FrontMindV2Asset] upload_failed", {
      traceId,
      declaredBytes,
      receivedBytes,
      durationMs: Date.now() - startedAt,
      requestAborted: req.aborted,
      requestComplete: req.complete,
      requestDestroyed: req.destroyed,
      socketDestroyed: req.socket.destroyed,
      uploadAttempt,
      temporaryDiscarded,
      assetCommitted,
      ...(knowledgeCoordinate
        ? {
            uploadAttemptId: knowledgeCoordinate.uploadAttemptId,
          conversationId: knowledgeCoordinate.conversationId,
            turnId: knowledgeCoordinate.turnId,
            itemId: knowledgeCoordinate.itemId,
            ordinal: knowledgeCoordinate.ordinal,
          }
        : {}),
      code:
        error instanceof ChatV2HttpError
          ? error.code
          : error instanceof Error
            ? error.name
            : "UNKNOWN_ERROR",
      streamErrorCode:
        typeof (error as NodeJS.ErrnoException | null)?.code === "string"
          ? (error as NodeJS.ErrnoException).code
          : null,
    });
    sendError(res, error);
  }
});

router.get("/assets/:localAssetId/content", async (req, res) => {
  try {
    if (!req.frontmindUser) throw new ChatV2HttpError("UNAUTHORIZED", 401);
    const asset = await ownedFileContentResolver.resolve({
      ownerUserId: enterpriseWorkspaceUserId(req.frontmindUser.id),
      fileId: req.params.localAssetId,
      projectAssignmentId:
        req.frontmindDeliveryProjectContext?.projectAssignmentId ?? null,
      expectedSourceKind: "managed_local_asset",
      expectedSourceAuthorityId: req.params.localAssetId,
    });
    res.setHeader("Cache-Control", "private, no-store, max-age=0");
    res.setHeader("Content-Type", asset.mimeType);
    if (asset.sizeBytes !== undefined) {
      res.setHeader("Content-Length", String(asset.sizeBytes));
    }
    if (asset.sha256) res.setHeader("ETag", `\"sha256:${asset.sha256}\"`);
    res.setHeader(
      "Content-Disposition",
      `attachment; filename*=UTF-8''${encodeURIComponent(asset.filename)}`,
    );
    asset.stream.pipe(res);
  } catch (error) {
    sendError(res, error);
  }
});

router.get("/runtime-config", async (req, res) => {
  try {
    if (!req.frontmindUser) throw new ChatV2HttpError("UNAUTHORIZED", 401);
    assertGeneralAgentActor(req.frontmindUser);
    const { localTaskId, purpose } = z
      .object({
        localTaskId: z.string().uuid().optional(),
        purpose: z.enum(["enterprise_qa", "content_production"]).optional(),
      })
      .strict()
      .parse(req.query);
    if (localTaskId) {
      const owned = await findOwnedTask({
        userId: enterpriseWorkspaceUserId(req.frontmindUser.id),
        localTaskId,
      });
      res.json({
        configured: true,
        source: "task",
        ...generalAgentRuntimeForOperation(owned.operation),
        ...generalAgentPurposePublic(
          frozenGeneralAgentPurpose(owned.task, enterpriseWorkspaceUserId(req.frontmindUser.id)),
        ),
      });
      return;
    }
    if (purpose && !currentEnterpriseProjectId()) throw new ChatV2HttpError("ENTERPRISE_PROJECT_REQUIRED", 400);
    const knowledge = purpose
      ? await publishedGeneralAgentKnowledge(
          await requireDb(),
          enterpriseWorkspaceUserId(req.frontmindUser.id),
        )
      : null;
    const purposePublic = purpose
      ? { purpose, knowledgeBase: knowledge?.knowledgeBase ?? null }
      : {};
    if (!req.frontmindCredential) {
      res.json({
        configured: false,
        source: "administrator",
        ...purposePublic,
      });
      return;
    }
    res.json({
      configured: true,
      source: "administrator",
      ...(purpose
        ? generalAgentRuntimeForCredential(req.frontmindCredential)
        : generalAgentRuntimeForSelection(req.frontmindCredential)),
      ...purposePublic,
    });
  } catch (error) {
    sendError(res, error);
  }
});

router.post("/tasks", async (req, res) => {
  try {
    if (!req.frontmindUser) {
      throw new ChatV2HttpError("UNAUTHORIZED", 401);
    }
    assertGeneralAgentActor(req.frontmindUser);
    if (!req.frontmindCredential) {
      throw new ChatV2HttpError("API_CREDENTIAL_REQUIRED", 428);
    }
    const value = taskCreateSchema.parse(req.body ?? {});
    if (Boolean(value.purpose) !== Boolean(currentEnterpriseProjectId())) {
      throw new ChatV2HttpError(value.purpose ? "ENTERPRISE_PROJECT_REQUIRED" : "GENERAL_AGENT_ACCOUNT_SCOPE_REQUIRED", 400);
    }
    const reserved = await reserveCreate({
      userId: enterpriseWorkspaceUserId(req.frontmindUser.id),
      projectAssignmentId:
        req.frontmindDeliveryProjectContext?.projectAssignmentId ?? null,
      credential: req.frontmindCredential,
      value,
    });
    if (!reserved.acquired && reserved.status === "preparing") {
      throw new ChatV2HttpError("CREATE_PREPARATION_IN_PROGRESS", 409, true);
    }
    if (reserved.acquired) {
      if (!reserved.claimToken) {
        throw new ChatV2HttpError("CREATE_RESERVATION_CONFLICT", 409, true);
      }
      let attachments: Awaited<ReturnType<typeof ensureProviderAttachments>>;
      try {
        attachments = await ensureProviderAttachments({
          operation: reserved.operation,
          task: reserved.task,
          credential: req.frontmindCredential,
          localAssetIds: value.localAssetIds,
        });
        await freezeCreateReconcileEvidence({
          taskId: reserved.task.id,
          userId: enterpriseWorkspaceUserId(req.frontmindUser.id),
          clientRequestId: value.clientRequestId,
          requestHash: reserved.operation.requestHash,
          claimToken: reserved.claimToken,
          prompt: value.prompt,
          localAssetIds: value.localAssetIds,
          modelProfile: value.modelProfile,
          attachmentFileIds: providerAttachmentFileIds(attachments),
        });
      } catch (error) {
        let released = await transitionCreateReservation({
          taskId: reserved.task.id,
          expectedStatus: "preparing",
          claimToken: reserved.claimToken,
          status: "preparation_failed",
        });
        if (!released) {
          // This owner has not invoked Provider yet. Even if the evidence
          // transaction committed but its acknowledgement was lost, reverting
          // this exact claim is safe and lets the same request retry.
          released = await transitionCreateReservation({
            taskId: reserved.task.id,
            expectedStatus: "sending",
            claimToken: reserved.claimToken,
            status: "preparation_failed",
          });
        }
        if (!released) {
          released = await transitionCreateReservation({
            taskId: reserved.task.id,
            expectedStatus: "outcome_unknown",
            claimToken: reserved.claimToken,
            status: "preparation_failed",
          });
        }
        if (released) {
          await updateTaskState({
            operationId: reserved.operation.id,
            localTaskId: reserved.task.id,
            status: "queued",
            providerState: "preparation_failed",
            errorCode: "CREATE_PREPARATION_FAILED",
          });
          throw error;
        }
        const reconciled = await reconcileUnknownCreate({
          operation: reserved.operation,
          task: reserved.task,
          credential: req.frontmindCredential,
        }).catch(() => reserved);
        const settled = await assertCreateTaskDtoMaySettle(reconciled);
        res.status(202).json(await taskDto(settled.operation, settled.task));
        return;
      }

      let created: Awaited<ReturnType<ManusV2Client["createTask"]>> | null =
        null;
      try {
        created = await clientFor(
          req.frontmindCredential,
          enterpriseWorkspaceUserId(req.frontmindUser.id),
          reserved.operation,
          reserved.task,
        ).createTask({
          prompt: value.prompt,
          attachments,
          title: reserved.task.title,
          agentProfile: reserved.operation.upstreamModel,
          interactiveMode: true,
          locale: "zh-CN",
        });
      } catch (error) {
        console.warn("[FrontMindV2] create command failed", {
          code: error instanceof Error && "code" in error ? String(error.code) : error instanceof Error ? error.name : "UNKNOWN_ERROR",
          ...(error instanceof ManusV2ApiError ? { operation: error.operation, status: error.status, outcomeUnknown: error.outcomeUnknown } : {}),
        });
        const explicitlyRejected = generalChatDispatchIsDefinitelyRejected(error);
        if (!explicitlyRejected) {
          await transitionCreateReservation({
            taskId: reserved.task.id,
            expectedStatus: "sending",
            status: "outcome_unknown",
          });
          const reconciled = await reconcileUnknownCreate({
            operation: reserved.operation,
            task: reserved.task,
            credential: req.frontmindCredential,
          }).catch(() => reserved);
          const settled = await assertCreateTaskDtoMaySettle(reconciled);
          res.status(202).json(await taskDto(settled.operation, settled.task));
          return;
        }
        await transitionCreateReservation({
          taskId: reserved.task.id,
          expectedStatus: "sending",
          status: "rejected",
          rejectionProven: true,
          rejectionCode: error instanceof Error && "code" in error ? String(error.code) : "TASK_CREATE_FAILED",
        });
        await updateTaskState({
          operationId: reserved.operation.id,
          localTaskId: reserved.task.id,
          status: "failed",
          providerState: "failed",
          errorCode: error instanceof Error && "code" in error ? String(error.code) : "TASK_CREATE_FAILED",
          clearConversationTaskPointers: true,
        });
        // A known refusal must keep its 402/403/429 response. Do not send it
        // through create reconciliation and turn it into an unknown 409.
        if (!(error instanceof ManusV2ApiError)) throw error;
        throw new ChatV2HttpError(error.code, error.status ?? 422, error.retryable, true);
      }
      if (created) {
        await updateTaskState({
          operationId: reserved.operation.id,
          localTaskId: reserved.task.id,
          status: "running",
          providerState: "running",
          providerTaskId: created.taskId,
          providerRequestId: created.requestId,
          errorCode: null,
        });
        await transitionCreateReservation({
          taskId: reserved.task.id,
          expectedStatus: "sending",
          status: "acknowledged",
        });
      }
    }
    const synced = await assertCreateTaskDtoMaySettle(
      await syncTask({
        userId: enterpriseWorkspaceUserId(req.frontmindUser.id),
        localTaskId: reserved.task.id,
      }),
    );
    res
      .status(reserved.created ? 201 : 200)
      .json(await taskDto(synced.operation, synced.task));
  } catch (error) {
    sendError(res, error);
  }
});

router.post("/tasks/:localTaskId/messages", async (req, res) => {
  try {
    if (!req.frontmindUser) throw new ChatV2HttpError("UNAUTHORIZED", 401);
    assertGeneralAgentActor(req.frontmindUser);
    const value = taskMessageSchema.parse(req.body ?? {});
    let owned = await syncTask({
      userId: enterpriseWorkspaceUserId(req.frontmindUser.id),
      localTaskId: req.params.localTaskId,
    });
    const purpose = frozenGeneralAgentPurpose(owned.task, enterpriseWorkspaceUserId(req.frontmindUser.id));
    const contentProduction = contentProductionPublicDto(
      purpose,
      owned.task.providerRuntime,
    );
    if (
      value.contentProductionAction &&
      purpose?.purpose !== "content_production"
    ) {
      throw new ChatV2HttpError("CONTENT_PRODUCTION_TASK_REQUIRED", 400);
    }
    const credential = await getDecryptedCredentialForAccountById(
      enterpriseWorkspaceUserId(req.frontmindUser.id),
      owned.operation.apiCredentialId,
    );
    if (
      !credential ||
      credential.version !== owned.operation.credentialVersion
    ) {
      throw new ChatV2HttpError("TASK_CREDENTIAL_UNAVAILABLE", 409);
    }
    const reservedTurn = await (
      await requireDb()
    ).transaction((tx) =>
      reservePersistedGeneralChatTurn({
        executor: tx,
        userId: enterpriseWorkspaceUserId(req.frontmindUser!.id),
        projectAssignmentId:
          req.frontmindDeliveryProjectContext?.projectAssignmentId ?? null,
        credentialId: credential.id,
        conversationId: value.conversationId,
        clientRequestId: value.clientRequestId,
        prompt: value.prompt,
        localAssetIds: value.localAssetIds,
        operationId: owned.operation.id,
        localTaskId: owned.task.id,
        model: owned.operation.upstreamModel,
        modelProfile: null,
        purpose: purpose?.purpose,
        contentProductionAction: value.contentProductionAction,
        availableContentActions: contentProduction?.availableActions,
        contentRunnerRevision: contentProduction?.runnerRevision,
        continuation: true,
      }),
    );
    await sendProviderMessage({
      ...owned,
      credential,
      clientRequestId: value.clientRequestId,
      prompt: value.prompt,
      localAssetIds: value.localAssetIds,
      turnId: reservedTurn.turn.id,
      conversationId: reservedTurn.persistedConversationId,
      contentProductionAction: value.contentProductionAction,
    });
    owned = await syncTask({
      userId: enterpriseWorkspaceUserId(req.frontmindUser.id),
      localTaskId: req.params.localTaskId,
    });
    res.json(await taskDto(owned.operation, owned.task));
  } catch (error) {
    sendError(res, error);
  }
});

router.get("/tasks/:localTaskId", async (req, res) => {
  try {
    if (!req.frontmindUser) throw new ChatV2HttpError("UNAUTHORIZED", 401);
    assertGeneralAgentActor(req.frontmindUser);
    const owned = await syncTask({
      userId: enterpriseWorkspaceUserId(req.frontmindUser.id),
      localTaskId: req.params.localTaskId,
    });
    res.json(await taskDto(owned.operation, owned.task));
  } catch (error) {
    sendError(res, error);
  }
});

router.get("/tasks", async (req, res) => {
  try {
    if (!req.frontmindUser) throw new ChatV2HttpError("UNAUTHORIZED", 401);
    assertGeneralAgentActor(req.frontmindUser);
    const rows = await (
      await requireDb()
    )
      .select({ operation: agentOperations, task: agentTasks })
      .from(agentOperations)
      .innerJoin(agentTasks, eq(agentTasks.operationId, agentOperations.id))
      .where(
        and(
          eq(agentOperations.scope, "managed_user"),
          eq(agentOperations.accountUserId, enterpriseWorkspaceUserId(req.frontmindUser.id)),
            enterpriseProjectPredicate(agentOperations.enterpriseProjectId),
          eq(agentOperations.contractName, CHAT_CONTRACT),
        ),
      )
      .orderBy(desc(agentOperations.createdAt))
      .limit(Math.min(100, Math.max(1, Number(req.query.limit) || 20)));
    res.json({
      data: await Promise.all(
        rows.map(({ operation, task }) => taskDto(operation, task)),
      ),
      first_id: rows[0]?.task.id ?? "",
      last_id: rows.at(-1)?.task.id ?? "",
      has_more: false,
    });
  } catch (error) {
    sendError(res, error);
  }
});

router.post(
  "/tasks/:localTaskId/actions/:localMessageId/confirm",
  async (req, res) => {
    try {
      if (!req.frontmindUser) throw new ChatV2HttpError("UNAUTHORIZED", 401);
      assertGeneralAgentActor(req.frontmindUser);
      const value = actionSchema.parse(req.body ?? {});
      const owned = await findOwnedTask({
        userId: enterpriseWorkspaceUserId(req.frontmindUser.id),
        localTaskId: req.params.localTaskId,
      });
      if (!owned.task.providerTaskId) {
        throw new ChatV2HttpError("TASK_NOT_READY", 409, true);
      }
      const localEvent = (
        await (
          await requireDb()
        )
          .select()
          .from(agentEvents)
          .where(
            and(
              eq(agentEvents.id, req.params.localMessageId),
              eq(agentEvents.taskId, owned.task.id),
            ),
          )
          .limit(1)
      )[0];
      const action =
        localEvent?.normalizedPayload?.action &&
        typeof localEvent.normalizedPayload.action === "object" &&
        !Array.isArray(localEvent.normalizedPayload.action)
          ? (localEvent.normalizedPayload.action as Record<string, unknown>)
          : null;
      const providerEventId = String(action?.eventId ?? "");
      if (!providerEventId) throw new ChatV2HttpError("ACTION_NOT_FOUND", 404);
      const credential = await getDecryptedCredentialForAccountById(
        enterpriseWorkspaceUserId(req.frontmindUser.id),
        owned.operation.apiCredentialId,
      );
      if (
        !credential ||
        credential.version !== owned.operation.credentialVersion
      ) {
        throw new ChatV2HttpError("TASK_CREDENTIAL_UNAVAILABLE", 409);
      }
      const idempotencyId = `local-action:${hash(
        `${owned.task.id}\0${providerEventId}\0${value.clientRequestId}`,
      )}`;
      const db = await requireDb();
      const markerId = randomUUID();
      await db
        .insert(agentEvents)
        .values({
          id: markerId,
          taskId: owned.task.id,
          providerEventId: idempotencyId,
          eventType: "local_action_reservation",
          providerTimestampMs: Date.now(),
          normalizedPayload: {
            kind: "local_action_reservation",
            requestHash: requestHash(value.confirmationInput ?? {}),
            status: "reserved",
          },
        })
        .onDuplicateKeyUpdate({ set: { providerEventId: idempotencyId } });
      const marker = (
        await db
          .select()
          .from(agentEvents)
          .where(
            and(
              eq(agentEvents.taskId, owned.task.id),
              eq(agentEvents.providerEventId, idempotencyId),
            ),
          )
          .limit(1)
      )[0]!;
      if (
        marker.normalizedPayload.requestHash !==
        requestHash(value.confirmationInput ?? {})
      ) {
        throw new ChatV2HttpError("IDEMPOTENCY_CONFLICT", 409);
      }
      if (marker.id === markerId) {
        try {
          await clientFor(
            credential,
            enterpriseWorkspaceUserId(req.frontmindUser.id),
            owned.operation,
            owned.task,
            marker.id,
          ).confirmAction({
            taskId: owned.task.providerTaskId,
            eventId: providerEventId,
            confirmationInput: value.confirmationInput,
          });
          await db
            .update(agentEvents)
            .set({
              normalizedPayload: {
                ...marker.normalizedPayload,
                status: "acknowledged",
              },
            })
            .where(eq(agentEvents.id, marker.id));
        } catch (error) {
          if (error instanceof ManusV2ApiError && error.outcomeUnknown) {
            await db
              .update(agentEvents)
              .set({
                normalizedPayload: {
                  ...marker.normalizedPayload,
                  status: "outcome_unknown",
                },
              })
              .where(eq(agentEvents.id, marker.id));
            await updateTaskState({
              operationId: owned.operation.id,
              localTaskId: owned.task.id,
              status: "attention_required",
              providerState: "attention_required",
              errorCode: "ACTION_OUTCOME_UNKNOWN",
            });
          } else {
            throw error;
          }
        }
      }
      const synced = await syncTask({
        userId: enterpriseWorkspaceUserId(req.frontmindUser.id),
        localTaskId: owned.task.id,
      });
      res.json(await taskDto(synced.operation, synced.task));
    } catch (error) {
      sendError(res, error);
    }
  },
);

router.get("/artifacts/:artifactId/content", async (req, res) => {
  let localTaskId: string | null = null;
  let projectOwnership: "matched" | "denied_or_missing" = "denied_or_missing";
  let contentPresent = false;
  try {
    if (!req.frontmindUser) throw new ChatV2HttpError("UNAUTHORIZED", 401);
    const projectAssignmentId =
      req.frontmindDeliveryProjectContext?.projectAssignmentId ?? null;
    const owned = (
      await (
        await requireDb()
      )
        .select({
          artifact: artifacts,
          task: agentTasks,
          turnId: conversationTurns.id,
          conversationId: conversations.id,
        })
        .from(artifacts)
        .innerJoin(
          agentOperations,
          and(
            eq(artifacts.operationId, agentOperations.id),
            eq(agentOperations.scope, "managed_user"),
            eq(agentOperations.accountUserId, enterpriseWorkspaceUserId(req.frontmindUser.id)),
            enterpriseProjectPredicate(agentOperations.enterpriseProjectId),
          ),
        )
        .innerJoin(
          agentTasks,
          and(
            eq(artifacts.taskId, agentTasks.id),
            eq(agentTasks.operationId, agentOperations.id),
          ),
        )
        .innerJoin(
          conversationTurns,
          and(
            eq(conversationTurns.upstreamTaskId, agentTasks.id),
            eq(conversationTurns.operationType, GENERAL_CHAT_TURN_TYPE),
            eq(conversationTurns.userId, enterpriseWorkspaceUserId(req.frontmindUser.id)),
          ),
        )
        .innerJoin(
          conversations,
          and(
            eq(conversations.id, conversationTurns.conversationId),
            eq(conversations.userId, enterpriseWorkspaceUserId(req.frontmindUser.id)),
            projectAssignmentId
              ? eq(conversations.projectAssignmentId, projectAssignmentId)
              : isNull(conversations.projectAssignmentId),
            isNull(conversations.deletedAt),
          ),
        )
        .where(
          and(
            eq(artifacts.id, req.params.artifactId),
            eq(artifacts.validationState, "valid"),
          ),
        )
        .limit(1)
    )[0];
    const row = owned?.artifact;
    localTaskId = row?.taskId ?? null;
    projectOwnership = row ? "matched" : "denied_or_missing";
    if (
      owned &&
      frozenGeneralAgentPurpose(owned.task, enterpriseWorkspaceUserId(req.frontmindUser.id))?.purpose ===
        "content_production" &&
      isContentWorkflowInternalFilename(owned.artifact.filename)
    ) {
      throw new ChatV2HttpError("ARTIFACT_NOT_FOUND", 404);
    }
    const stored = row ? await readStoredPresalesFile(row.id) : null;
    contentPresent = Boolean(stored);
    if (!row || !stored) throw new ChatV2HttpError("ARTIFACT_NOT_FOUND", 404);
    const isChinesePresentation = req.query.presentation === "zh" &&
      frozenGeneralAgentPurpose(owned!.task, enterpriseWorkspaceUserId(req.frontmindUser.id))?.purpose === "content_production";
    if (isChinesePresentation) {
      const presentation = contentProductionPresentationArtifact({
        bytes: await streamToBuffer(stored.createReadStream(), MAX_ARTIFACT_BYTES),
        filename: row.filename,
        mimeType: row.mimeType,
      });
      res.setHeader("Cache-Control", "private, no-store, max-age=0");
      res.setHeader("Content-Type", presentation.mimeType);
      res.setHeader("Content-Length", String(presentation.bytes.length));
      res.setHeader("ETag", `\"sha256:${presentation.sha256}\"`);
      res.setHeader("Content-Disposition", `attachment; filename*=UTF-8''${encodeURIComponent(presentation.filename)}`);
      res.end(presentation.bytes);
      return;
    }
    res.setHeader("Cache-Control", "private, no-store, max-age=0");
    res.setHeader("Content-Type", row.mimeType);
    res.setHeader("Content-Length", String(row.sizeBytes));
    res.setHeader("ETag", `\"sha256:${row.contentSha256}\"`);
    res.setHeader(
      "Content-Disposition",
      `attachment; filename*=UTF-8''${encodeURIComponent(row.filename)}`,
    );
    console.info("[FrontMindV2] general-chat artifact download", {
      artifactId: req.params.artifactId,
      localTaskId,
      projectOwnership,
      contentPresent,
      status: 200,
      bytes: row.sizeBytes,
    });
    stored.createReadStream().pipe(res);
  } catch (error) {
    console.info("[FrontMindV2] general-chat artifact download", {
      artifactId: req.params.artifactId,
      localTaskId,
      projectOwnership,
      contentPresent,
      status:
        error instanceof ChatV2HttpError
          ? error.statusCode
          : error instanceof OwnedFileContentError
            ? error.statusCode
            : 500,
      bytes: 0,
    });
    sendError(res, error);
  }
});

export default router;
