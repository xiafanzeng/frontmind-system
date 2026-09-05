import { createHash, randomUUID } from "node:crypto";
import type { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

import axios from "axios";
import { Router, json, type Response } from "express";
import { z } from "zod";

import { projectOrderProjectIdSchema } from "../shared/project-order-registry";
import { managedAgentProfileModel } from "../shared/manus-agent-profile";
import {
  assertActiveWebsiteProject,
  bindWebsiteLocalAssetToProject,
  bindWebsiteProjectBusinessOwner,
  ensureWebsiteAgentOperation,
  persistWebsiteAgentTaskState,
  persistWebsiteArtifact,
  persistWebsiteLocalAsset,
  persistWebsiteProviderFileLease,
} from "./agent-operation-service";
import { businessOwnerNameSchema } from "./business-owner-name";
import {
  assertSafeExternalUrl,
  safeExternalRequestOptions,
} from "./_core/safe-external-url";
import { FILE_CONTENT_RETENTION_MS } from "./file-content-retention";
import {
  classifyManusV2StructuredResultEnvelope,
  latestManusV2WaitingDetail,
  latestManusV2TaskState,
  ManusV2ApiError,
  ManusV2Client,
  type ManusV2CreatedFile,
  type ManusV2MessageEvent,
} from "./manus-v2-client";
import {
  PRESALES_V2_CAPABILITIES,
  PRESALES_V2_CONTRACT_HASHES,
  PRESALES_V2_CONTRACT_VERSION,
  PRESALES_V2_STRUCTURED_OUTPUT_SCHEMAS,
  PresalesV2ContractError,
  presalesV2ContractSchema,
  presalesV2StructuredPrompt,
  resolvePresalesV2Contract,
  type PresalesV2Contract,
} from "./presales-v2-contracts";
import {
  acquirePresalesV2Asset,
  acquirePresalesV2Task,
  bindPresalesV2AssetProject,
  hashPresalesV2IdempotencyKey,
  hashPresalesV2Request,
  readPresalesV2Artifact,
  readPresalesV2Asset,
  readPresalesV2Task,
  recordPresalesV2Artifact,
  updatePresalesV2Asset,
  updatePresalesV2Task as updatePresalesV2TaskStore,
  type PresalesV2Artifact,
  type PresalesV2AssetRecord,
  type PresalesV2TaskRecord,
} from "./presales-v2-store";
import {
  readStoredPresalesFile,
  recordPresalesFileDescriptor,
  stagePresalesFileContent,
} from "./presales-file-store";
import {
  presalesMonitorRouter,
  getDedicatedMonitorCredentialReadiness,
} from "./presales-monitor";
import {
  getActivePresalesCredential,
  getPresalesCredentialById,
} from "./presales-service";
import { isFrontMindPublicUrlConfigured } from "./public-url";
import { requirePresalesServiceToken } from "./presales-service-auth";
import { assertPresalesV2ZipSafe } from "./presales-v2-zip-safety";
import {
  parseExactJson,
  repairStructuredJsonCandidate,
  type ModelOutputRepairRuleCode,
} from "./model-output-repair";
import { getUpstreamBaseUrl } from "./upstream-config";
import { WebsiteProjectInactiveError } from "./website-project-lifecycle";

const router = Router();
const jsonParser = json({ limit: "4mb" });
const monitorJsonParser = json({ limit: "32kb" });
const MAX_ASSET_BYTES = 100 * 1024 * 1024;
const MAX_TASK_ASSET_BYTES = 100 * 1024 * 1024;
const RESULT_GRACE_MS = 120_000;
// Read-only compatibility for tasks already reserved under the immediately
// preceding forecast transport. New reservations still use the public resolver.
const HISTORICAL_OPTIMIZATION_FORECAST_CONTRACT_HASH =
  "96bdf3df50dbabaca2618e198c7599c2fc53b3e41bff9076b21efcc2a79886b2";

const historicalOptimizationForecastSchema = (() => {
  const current = PRESALES_V2_STRUCTURED_OUTPUT_SCHEMAS[
    "website.optimization-forecast"
  ] as Record<string, unknown>;
  const properties = {
    ...(current.properties as Record<string, unknown>),
  };
  delete properties.brandMentionRateTarget;
  return {
    ...current,
    properties,
    required: Array.isArray(current.required)
      ? current.required.filter((key) => key !== "brandMentionRateTarget")
      : current.required,
  } as NonNullable<PresalesV2Contract["structuredOutputSchema"]>;
})();
const CREATE_RECONCILE_WINDOW_MS = 5 * 60_000;
const PROVIDER_RUN_DEADLINE_MS = 60 * 60_000;
const PROVIDER_TASK_VISIBILITY_GRACE_MS = 180_000;
const PROVIDER_FILE_MINIMUM_USABLE_SECONDS = 15 * 60;
const MAX_PROVIDER_FILE_CANDIDATES = 2;
const MAX_STRUCTURED_RESULT_BYTES = 2 * 1024 * 1024;
const MAX_STRUCTURED_RESULT_DEPTH = 64;
const MAX_STRUCTURED_RESULT_NODES = 100_000;

const TERMINAL_PRESALES_FILE_ERROR_CODES = new Set([
  "FILE_ID_CONFLICT",
  "FILE_IDENTITY_CONFLICT",
  "FILE_BYTES_CONFLICT",
  "FILE_MIME_CONFLICT",
  "FILE_UNUSABLE",
  "FILE_EXPIRING",
  "FILE_BYTES_INVALID",
  "UNSAFE_UPLOAD_URL",
]);

function presalesV2TaskHash(localTaskId: string) {
  return createHash("sha256")
    .update(localTaskId, "utf8")
    .digest("hex")
    .slice(0, 16);
}

function transientPresalesV2FileFailure(error: unknown) {
  if (
    !(error instanceof ManusV2ApiError) ||
    !error.operation.startsWith("file.") ||
    TERMINAL_PRESALES_FILE_ERROR_CODES.has(error.code)
  ) {
    return false;
  }
  if (
    error.code === "FILE_UPLOAD_CONFIRMATION_UNKNOWN" ||
    error.outcomeUnknown
  ) {
    return true;
  }
  return (
    error.retryable &&
    (error.status === null ||
      error.status === 408 ||
      error.status === 425 ||
      error.status === 429 ||
      (typeof error.status === "number" && error.status >= 500))
  );
}

function safePresalesV2FileFailureClass(error: unknown) {
  if (!(error instanceof ManusV2ApiError)) return "local";
  if (TERMINAL_PRESALES_FILE_ERROR_CODES.has(error.code)) return "terminal";
  return transientPresalesV2FileFailure(error) ? "transient" : "rejected";
}

export function presalesV2PreparationFailureState(error: unknown): {
  status: "failed" | "attention_required";
  errorCode: string;
} {
  if (
    error instanceof ManusV2ApiError &&
    error.code === "FILE_UPLOAD_CONFIRMATION_UNKNOWN"
  ) {
    return {
      status: "attention_required",
      errorCode: "FILE_UPLOAD_CONFIRMATION_UNKNOWN",
    };
  }
  if (
    error instanceof ManusV2ApiError &&
    TERMINAL_PRESALES_FILE_ERROR_CODES.has(error.code)
  ) {
    return { status: "failed", errorCode: "FILE_UPLOAD_REJECTED" };
  }
  if (transientPresalesV2FileFailure(error)) {
    return {
      status: "attention_required",
      errorCode: "FILE_UPLOAD_OUTCOME_UNKNOWN",
    };
  }
  if (
    error instanceof PresalesV2HttpError &&
    error.code === "FILE_LEASE_PERSIST_FAILED"
  ) {
    return { status: "failed", errorCode: "FILE_LEASE_PERSIST_FAILED" };
  }
  if (
    (error instanceof PresalesV2HttpError &&
      error.code === "FILE_UPLOAD_REJECTED") ||
    (error instanceof ManusV2ApiError && error.operation.startsWith("file."))
  ) {
    return { status: "failed", errorCode: "FILE_UPLOAD_REJECTED" };
  }
  return { status: "failed", errorCode: "TASK_PREPARATION_FAILED" };
}

async function updatePresalesV2Task(
  localTaskId: string,
  update: (current: PresalesV2TaskRecord) => PresalesV2TaskRecord,
  providerEvents: ReadonlyArray<ManusV2MessageEvent> = [],
) {
  const record = await updatePresalesV2TaskStore(localTaskId, update);
  if (record) await persistWebsiteAgentTaskState(record, providerEvents);
  return record;
}

const assetCreateSchema = z
  .object({
    projectId: projectOrderProjectIdSchema.optional(),
    idempotencyKey: z.string().trim().min(16).max(512),
    filename: z.string().trim().min(1).max(512),
    mimeType: z.string().trim().min(1).max(255).optional(),
    sizeBytes: z.number().int().nonnegative().max(MAX_ASSET_BYTES).optional(),
  })
  .strict();

const taskCreateSchema = z
  .object({
    projectId: projectOrderProjectIdSchema,
    prompt: z.string().trim().min(1).max(2_000_000),
    localAssetIds: z
      .array(
        z
          .object({
            localAssetId: z.string().uuid(),
            filename: z.string().trim().min(1).max(512),
          })
          .strict(),
      )
      .max(20)
      .default([]),
    idempotencyKey: z.string().trim().min(16).max(512),
    contract: presalesV2ContractSchema,
    businessOwnerName: businessOwnerNameSchema.optional(),
  })
  .strict()
  .superRefine((input, context) => {
    const initial = input.contract.name === "website.knowledge-base-candidate";
    if (initial && input.businessOwnerName === undefined) {
      context.addIssue({
        code: "custom",
        path: ["businessOwnerName"],
        message: "Business owner is required for the initial project task",
      });
    }
    if (!initial && input.businessOwnerName !== undefined) {
      context.addIssue({
        code: "custom",
        path: ["businessOwnerName"],
        message: "Business owner may only be supplied for the initial task",
      });
    }
  });

export function parsePresalesV2TaskCreate(value: unknown) {
  return taskCreateSchema.parse(value);
}

export async function bindPresalesV2TaskAssetProject(
  input: {
    asset: PresalesV2AssetRecord;
    projectId: string;
  },
  dependencies: {
    bindLocalRecord: typeof bindPresalesV2AssetProject;
    bindDurableRecord: typeof bindWebsiteLocalAssetToProject;
  } = {
    bindLocalRecord: bindPresalesV2AssetProject,
    bindDurableRecord: bindWebsiteLocalAssetToProject,
  },
) {
  if (
    input.asset.projectId !== null &&
    input.asset.projectId !== input.projectId
  ) {
    throw new PresalesV2HttpError("ASSET_PROJECT_CONFLICT", 409);
  }
  const asset =
    input.asset.projectId === null
      ? await dependencies.bindLocalRecord(
          input.asset.localAssetId,
          input.projectId,
        )
      : input.asset;
  if (!asset || asset.projectId !== input.projectId) {
    throw new PresalesV2HttpError("ASSET_PROJECT_CONFLICT", 409);
  }
  // The filesystem index and SQL ledger are two durable authorities. Always
  // replay the idempotent SQL bind even when the filesystem side was already
  // committed, so a crash between those writes cannot strand an unowned row.
  await dependencies.bindDurableRecord({
    localAssetId: asset.localAssetId,
    projectId: input.projectId,
  });
  return asset;
}

const artifactCreateSchema = z
  .object({
    projectId: projectOrderProjectIdSchema,
    idempotencyKey: z.string().trim().min(16).max(512),
    sourceLocalAssetId: z.string().uuid(),
    filename: z.string().trim().min(1).max(512),
    mimeType: z.literal("application/zip"),
    bytes: z.number().int().positive().max(MAX_ASSET_BYTES),
    sha256: z.string().regex(/^[a-f0-9]{64}$/u),
    kind: z.literal("website-final-knowledge-base"),
  })
  .strict();

class PresalesV2HttpError extends Error {
  constructor(
    public readonly code: string,
    public readonly status: number,
    public readonly retryable = false,
    public readonly operationId?: string,
  ) {
    super(code);
    this.name = "PresalesV2HttpError";
  }
}

type PresalesV2RequestContractErrorCode =
  | "ASSET_CREATE_CONTRACT_INVALID"
  | "TASK_CREATE_CONTRACT_INVALID"
  | "INVALID_REQUEST";

function safeZodIssuePaths(error: z.ZodError) {
  const safeSegment = (value: PropertyKey) => {
    if (typeof value === "number") return String(value);
    const segment = String(value);
    return /^[A-Za-z0-9_-]{1,64}$/u.test(segment) ? segment : "[invalid-key]";
  };
  const paths = new Set<string>();
  for (const issue of error.issues.slice(0, 20)) {
    const base = issue.path.map(safeSegment);
    if (issue.code === "unrecognized_keys") {
      // Unknown property names are attacker-controlled input too: a short
      // secret or customer identifier can be smuggled in as a JSON key. Keep
      // only the schema-owned parent path and a fixed marker.
      paths.add(`$.${[...base, "[unrecognized]"].join(".")}`);
      continue;
    }
    paths.add(base.length > 0 ? `$.${base.join(".")}` : "$");
  }
  return [...paths];
}

function sendError(
  res: Response,
  error: unknown,
  contractErrorCode: PresalesV2RequestContractErrorCode = "INVALID_REQUEST",
) {
  if (error instanceof z.ZodError) {
    console.warn("[Presales v2] request contract invalid", {
      diagnosticCode: contractErrorCode,
      issuePaths: safeZodIssuePaths(error),
    });
    res.status(400).json({
      error: { code: contractErrorCode, status: 400, retryable: false },
    });
    return;
  }
  if (error instanceof PresalesV2ContractError) {
    res.status(error.status).json({
      error: { code: error.code, status: error.status, retryable: false },
    });
    return;
  }
  if (error instanceof WebsiteProjectInactiveError) {
    res.status(410).json({
      error: { code: "PROJECT_DELETED", status: 410, retryable: false },
    });
    return;
  }
  if (error instanceof PresalesV2HttpError) {
    res.status(error.status).json({
      error: {
        code: error.code,
        status: error.status,
        retryable: error.retryable,
        ...(error.operationId ? { operationId: error.operationId } : {}),
      },
    });
    return;
  }
  if (error instanceof ManusV2ApiError) {
    const status = error.status === 401 || error.status === 403 ? 428 : 502;
    res.status(status).json({
      error: {
        code:
          error.status === 401 || error.status === 403
            ? "INVALID_CREDENTIAL"
            : error.code,
        status,
        retryable: error.retryable,
      },
    });
    return;
  }
  console.error("[Presales v2] request failed", {
    diagnosticCode: "PRESALES_V2_INTERNAL_ERROR",
    errorType: error instanceof Error ? error.name : "UnknownError",
  });
  res.status(500).json({
    error: { code: "INTERNAL_ERROR", status: 500, retryable: false },
  });
}

export function presalesV2PublicTask(record: PresalesV2TaskRecord) {
  const safeIsoTimestamp = (value: string | null | undefined) => {
    const parsed = typeof value === "string" ? Date.parse(value) : Number.NaN;
    return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null;
  };
  const providerStartedAt = safeIsoTimestamp(record.providerStartedAt);
  const terminalAt = safeIsoTimestamp(record.terminalAt);
  return {
    localTaskId: record.localTaskId,
    operationId: record.operationId,
    status: record.status,
    ...(providerStartedAt ? { providerStartedAt } : {}),
    ...(terminalAt ? { terminalAt } : {}),
    safeEvents: presalesV2SafeEvents(record.localTaskId, record.safeEvents),
    ...(record.status === "succeeded"
      ? {
          result: {
            ...(record.structuredResult !== null
              ? { structuredResult: record.structuredResult }
              : {}),
            artifacts: record.artifacts,
          },
        }
      : {}),
    ...(record.errorCode
      ? { error: { code: record.errorCode, retryable: false } }
      : {}),
  };
}

async function requireActiveCredential() {
  const credential = await getActivePresalesCredential();
  if (!credential) {
    throw new PresalesV2HttpError("INVALID_CREDENTIAL", 428);
  }
  return credential;
}

async function clientForTask(record: PresalesV2TaskRecord) {
  const credential = await getPresalesCredentialById(record.credentialId);
  if (!credential || credential.version !== record.credentialVersion) {
    throw new PresalesV2HttpError(
      "TASK_CREDENTIAL_UNAVAILABLE",
      410,
      false,
      record.operationId,
    );
  }
  return new ManusV2Client({
    apiKey: credential.apiKey,
    baseUrl: getUpstreamBaseUrl(),
    rateLimitScope: "website-managed-provider",
  });
}

async function readStoredBytes(localAssetId: string) {
  const stored = await readStoredPresalesFile(localAssetId);
  if (!stored) throw new PresalesV2HttpError("ASSET_CONTENT_MISSING", 409);
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const raw of stored.createReadStream()) {
    const chunk = Buffer.isBuffer(raw) ? raw : Buffer.from(raw);
    bytes += chunk.length;
    if (bytes > MAX_TASK_ASSET_BYTES) {
      throw new PresalesV2HttpError("ASSET_SET_TOO_LARGE", 413);
    }
    chunks.push(chunk);
  }
  const value = Buffer.concat(chunks);
  if (stored.sha256) {
    const observed = createHash("sha256").update(value).digest("hex");
    if (observed !== stored.sha256) {
      throw new PresalesV2HttpError("ASSET_HASH_MISMATCH", 409);
    }
  }
  return { stored, bytes: value };
}

const activePresalesV2Dispatches = new Map<string, Promise<void>>();

function isPresalesV2DispatchActive(localTaskId: string) {
  return activePresalesV2Dispatches.has(localTaskId);
}

function startPresalesV2Dispatch(
  localTaskId: string,
  dispatch: () => Promise<void>,
  compensateUnexpectedFailure?: (error: unknown) => Promise<unknown>,
) {
  const existing = activePresalesV2Dispatches.get(localTaskId);
  if (existing) return existing;

  let current: Promise<void>;
  current = Promise.resolve()
    .then(dispatch)
    .catch(async (error) => {
      try {
        await compensateUnexpectedFailure?.(error);
      } catch (compensationError) {
        console.error(
          "[Presales v2] asynchronous dispatch compensation failed",
          {
            diagnosticCode: "PRESALES_V2_ASYNC_DISPATCH_COMPENSATION_FAILED",
            taskHash: presalesV2TaskHash(localTaskId),
            errorType:
              compensationError instanceof Error
                ? compensationError.name
                : "UnknownError",
          },
        );
      }
      // The dispatcher settles every expected Provider outcome itself. This
      // catch is the final unhandled-rejection fence and intentionally logs no
      // customer prompt, filename, Provider response, or credential detail.
      console.error("[Presales v2] asynchronous task dispatch failed", {
        diagnosticCode: "PRESALES_V2_ASYNC_DISPATCH_FAILED",
        taskHash: presalesV2TaskHash(localTaskId),
        errorType: error instanceof Error ? error.name : "UnknownError",
      });
    })
    .finally(() => {
      if (activePresalesV2Dispatches.get(localTaskId) === current) {
        activePresalesV2Dispatches.delete(localTaskId);
      }
    });
  activePresalesV2Dispatches.set(localTaskId, current);
  return current;
}

type PresalesV2DispatchClient = Pick<
  ManusV2Client,
  "uploadFile" | "createTask"
>;

type PresalesV2DispatchPhase = {
  providerCreateAttempted: boolean;
  providerCreateKnownRejection?: ManusV2ApiError | null;
};

class PresalesV2FailurePersistenceError extends Error {
  constructor(
    readonly originalFailure: unknown,
    readonly persistenceError: unknown,
  ) {
    super("Presales v2 failure state persistence failed");
    this.name = "PresalesV2FailurePersistenceError";
  }
}

export type PresalesV2DispatchDependencies = {
  now: () => Date;
  sleep: (ms: number) => Promise<void>;
  createClient: (apiKey: string) => PresalesV2DispatchClient;
  readStoredBytes: typeof readStoredBytes;
  updateTask: typeof updatePresalesV2Task;
  persistProviderFileLease: typeof persistWebsiteProviderFileLease;
};

function dispatchDependencies(
  overrides: Partial<PresalesV2DispatchDependencies> = {},
): PresalesV2DispatchDependencies {
  return {
    now: () => new Date(),
    sleep: (ms) => new Promise<void>((resolve) => setTimeout(resolve, ms)),
    createClient: (apiKey) =>
      new ManusV2Client({
        apiKey,
        baseUrl: getUpstreamBaseUrl(),
        rateLimitScope: "website-managed-provider",
      }),
    readStoredBytes,
    updateTask: updatePresalesV2Task,
    persistProviderFileLease: persistWebsiteProviderFileLease,
    ...overrides,
  };
}

function presalesV2SafeAssetRole(filename: string) {
  if (filename.startsWith("customer-upload-")) return "customer-upload";
  if (filename.endsWith(".skill.zip")) return "skill";
  if (filename.endsWith("-task-input.json")) return "task-input";
  return "customer-upload";
}

async function settlePresalesV2PreparationFailure(
  localTaskId: string,
  error: unknown,
  dependencies: PresalesV2DispatchDependencies,
) {
  const failure = presalesV2PreparationFailureState(error);
  try {
    return await dependencies.updateTask(localTaskId, (current) =>
      current.status === "queued" && !current.providerTaskId
        ? {
            ...current,
            ...failure,
            terminalAt: dependencies.now().toISOString(),
            ...(current.preparation
              ? {
                  preparation: {
                    ...current.preparation,
                    prompt: null,
                  },
                }
              : {}),
          }
        : current,
    );
  } catch (persistenceError) {
    throw new PresalesV2FailurePersistenceError(error, persistenceError);
  }
}

async function settlePresalesV2KnownCreateRejection(
  localTaskId: string,
  error: ManusV2ApiError,
  dependencies: PresalesV2DispatchDependencies,
) {
  try {
    return await dependencies.updateTask(localTaskId, (current) =>
      current.status === "queued" && !current.providerTaskId
        ? {
            ...current,
            status: "failed",
            terminalAt: dependencies.now().toISOString(),
            errorCode: error.code,
          }
        : current,
    );
  } catch (persistenceError) {
    throw new PresalesV2FailurePersistenceError(error, persistenceError);
  }
}

async function compensatePresalesV2DispatchFailure(input: {
  localTaskId: string;
  error: unknown;
  phase: PresalesV2DispatchPhase;
  dependencies?: Partial<PresalesV2DispatchDependencies>;
}) {
  const dependencies = dispatchDependencies(input.dependencies);
  const originalFailure =
    input.error instanceof PresalesV2FailurePersistenceError
      ? input.error.originalFailure
      : input.error;
  if (
    input.phase.providerCreateKnownRejection &&
    originalFailure === input.phase.providerCreateKnownRejection &&
    !input.phase.providerCreateKnownRejection.outcomeUnknown
  ) {
    // This is the sole post-create-attempt failure which is safe to replay:
    // Manus explicitly proved that no Provider task was created.
    return settlePresalesV2KnownCreateRejection(
      input.localTaskId,
      input.phase.providerCreateKnownRejection,
      dependencies,
    );
  }
  if (input.phase.providerCreateAttempted) {
    // The Provider create boundary may already have been crossed. Replaying a
    // failed terminal write could falsely prove that no task exists, so only
    // replay the current durable state into the SQL ledger. A queued record is
    // intentionally left for operation-marker reconciliation.
    return dependencies.updateTask(input.localTaskId, (current) => current);
  }
  // Before createTask, the same conditional failure mutation is safe to replay:
  // updatePresalesV2Task writes the filesystem record before the SQL projection,
  // so this either completes the original transition or republishes its already
  // terminal state without reopening it.
  return settlePresalesV2PreparationFailure(
    input.localTaskId,
    originalFailure,
    dependencies,
  );
}

async function ensureWebsiteAgentOperationAfterReservation(
  record: PresalesV2TaskRecord,
  ensureOperation: typeof ensureWebsiteAgentOperation = ensureWebsiteAgentOperation,
) {
  try {
    return await ensureOperation(record);
  } catch {
    // An acquired and an existing replay can both observe the filesystem task
    // before either sees the SQL ledger row. Replay the idempotent ensure once
    // so the acquired request cannot lose that insert race and strand a queued
    // task which no existing request is allowed to dispatch.
    return ensureOperation(record);
  }
}

async function dispatchPresalesV2Task(
  input: {
    record: PresalesV2TaskRecord;
    assets: PresalesV2AssetRecord[];
    prompt: string;
    contract: PresalesV2Contract;
    apiKey: string;
  },
  dependencyOverrides: Partial<PresalesV2DispatchDependencies> = {},
  phase: PresalesV2DispatchPhase = { providerCreateAttempted: false },
) {
  const dependencies = dispatchDependencies(dependencyOverrides);
  let record = input.record;
  let client: PresalesV2DispatchClient;
  try {
    client = dependencies.createClient(input.apiKey);
  } catch (error) {
    await settlePresalesV2PreparationFailure(
      record.localTaskId,
      error,
      dependencies,
    );
    return;
  }
  const attachments: Array<{ file_id: string; filename: string }> = [];
  const taskHash = presalesV2TaskHash(record.localTaskId);

  try {
    for (const [assetIndex, asset] of input.assets.entries()) {
      const local = await dependencies.readStoredBytes(asset.localAssetId);
      const safeLog = (
        phaseName: string,
        detail: {
          candidateCount?: number;
          failureClass?: ReturnType<typeof safePresalesV2FileFailureClass>;
          diagnosticCode?: string;
        } = {},
      ) => {
        console.info("[Presales v2] provider file preparation", {
          taskHash,
          contractName: record.contract.name,
          assetRole: presalesV2SafeAssetRole(asset.filename),
          ordinal: assetIndex + 1,
          declaredBytes: local.bytes.length,
          phase: phaseName,
          ...(detail.candidateCount !== undefined
            ? { candidateCount: detail.candidateCount }
            : {}),
          ...(detail.failureClass ? { failureClass: detail.failureClass } : {}),
          ...(detail.diagnosticCode
            ? { diagnosticCode: detail.diagnosticCode }
            : {}),
        });
      };
      const rememberLease = async (
        candidate: ManusV2CreatedFile,
        uploadState: PresalesV2TaskRecord["providerFileLeases"][number]["uploadState"],
        expiresAt = candidate.uploadExpiresAt,
      ) => {
        try {
          const updated = await dependencies.updateTask(
            record.localTaskId,
            (current) => {
              if (
                current.status !== "queued" ||
                current.providerTaskId ||
                current.preparation?.providerCreateAttemptedAt
              ) {
                return current;
              }
              const existing = current.providerFileLeases.find(
                (lease) =>
                  lease.localAssetId === asset.localAssetId &&
                  lease.providerFileId === candidate.fileId,
              );
              const lease = {
                localAssetId: asset.localAssetId,
                providerFileId: candidate.fileId,
                filename: candidate.filename,
                expiresAt:
                  Number.isSafeInteger(expiresAt) && expiresAt > 0
                    ? expiresAt
                    : (existing?.expiresAt ?? candidate.uploadExpiresAt),
                providerRequestId:
                  candidate.requestId ?? existing?.providerRequestId ?? null,
                uploadState,
              };
              return {
                ...current,
                providerFileLeases: existing
                  ? current.providerFileLeases.map((item) =>
                      item.localAssetId === asset.localAssetId &&
                      item.providerFileId === candidate.fileId
                        ? lease
                        : item,
                    )
                  : [...current.providerFileLeases, lease],
              };
            },
          );
          if (!updated) {
            throw new PresalesV2HttpError("FILE_LEASE_PERSIST_FAILED", 500);
          }
          record = updated;
          const lease = record.providerFileLeases.find(
            (item) =>
              item.localAssetId === asset.localAssetId &&
              item.providerFileId === candidate.fileId &&
              item.filename === candidate.filename &&
              item.uploadState === uploadState,
          );
          if (!lease) {
            throw new PresalesV2HttpError("FILE_LEASE_PERSIST_FAILED", 500);
          }
          await dependencies.persistProviderFileLease({ record, lease });
          return lease;
        } catch (error) {
          if (
            error instanceof PresalesV2HttpError &&
            error.code === "FILE_LEASE_PERSIST_FAILED"
          ) {
            throw error;
          }
          throw new PresalesV2HttpError("FILE_LEASE_PERSIST_FAILED", 500);
        }
      };
      const rememberUploadedLease = async (
        candidate: ManusV2CreatedFile,
        expiresAt: number,
      ) => {
        const retryDelaysMs = [0, 1_000, 3_000] as const;
        for (const [attempt, delayMs] of retryDelaysMs.entries()) {
          if (delayMs > 0) await dependencies.sleep(delayMs);
          try {
            return await rememberLease(candidate, "uploaded", expiresAt);
          } catch {
            if (attempt === retryDelaysMs.length - 1) {
              throw new PresalesV2HttpError("FILE_LEASE_PERSIST_FAILED", 500);
            }
          }
        }
        throw new PresalesV2HttpError("FILE_LEASE_PERSIST_FAILED", 500);
      };
      const assetLeases = () =>
        record.providerFileLeases.filter(
          (lease) => lease.localAssetId === asset.localAssetId,
        );
      const candidateCount = () =>
        new Set(assetLeases().map((lease) => lease.providerFileId)).size;
      const mismatchedLease = assetLeases().find(
        (lease) => lease.filename !== asset.filename,
      );
      if (mismatchedLease) {
        throw new ManusV2ApiError(
          "file.detail",
          502,
          "FILE_IDENTITY_CONFLICT",
          false,
          false,
        );
      }
      const reusableUploadedLease = [...assetLeases()]
        .reverse()
        .find(
          (lease) =>
            lease.uploadState === "uploaded" &&
            lease.expiresAt -
              Math.floor(dependencies.now().getTime() / 1_000) >=
              PROVIDER_FILE_MINIMUM_USABLE_SECONDS,
        );
      if (reusableUploadedLease) {
        safeLog("lease_reused_uploaded", {
          candidateCount: candidateCount(),
        });
        attachments.push({
          file_id: reusableUploadedLease.providerFileId,
          filename: reusableUploadedLease.filename,
        });
        continue;
      }

      let resumeLease = [...assetLeases()]
        .reverse()
        .find((lease) =>
          ["reserved", "uploading", "uploaded", "outcome_unknown"].includes(
            lease.uploadState,
          ),
        );
      let inMemoryCandidateAttempts = candidateCount();
      let lastTransientFailure: unknown = null;
      let uploaded:
        | Awaited<ReturnType<PresalesV2DispatchClient["uploadFile"]>>
        | undefined;

      const reserveFreshCandidateAttempt = async () => {
        if (!record.preparation) {
          if (inMemoryCandidateAttempts >= MAX_PROVIDER_FILE_CANDIDATES) {
            return null;
          }
          inMemoryCandidateAttempts += 1;
          return inMemoryCandidateAttempts;
        }
        let reservedAttempt: number | null = null;
        const updated = await dependencies.updateTask(
          record.localTaskId,
          (current) => {
            if (
              current.status !== "queued" ||
              current.providerTaskId ||
              current.preparation?.providerCreateAttemptedAt
            ) {
              return current;
            }
            const preparation = current.preparation;
            if (!preparation) return current;
            const preparationAsset = preparation.assets.find(
              (item) => item.localAssetId === asset.localAssetId,
            );
            if (
              !preparationAsset ||
              preparationAsset.filename !== asset.filename ||
              preparationAsset.candidateAttempts >= MAX_PROVIDER_FILE_CANDIDATES
            ) {
              return current;
            }
            reservedAttempt = preparationAsset.candidateAttempts + 1;
            return {
              ...current,
              preparation: {
                ...preparation,
                assets: preparation.assets.map((item) =>
                  item.localAssetId === asset.localAssetId
                    ? { ...item, candidateAttempts: reservedAttempt! }
                    : item,
                ),
              },
            };
          },
        );
        if (!updated) {
          throw new PresalesV2HttpError("FILE_LEASE_PERSIST_FAILED", 500);
        }
        record = updated;
        return reservedAttempt;
      };

      while (!uploaded) {
        const existingCandidate = resumeLease
          ? {
              fileId: resumeLease.providerFileId,
              filename: resumeLease.filename,
            }
          : undefined;
        if (resumeLease) {
          safeLog("lease_confirmation_resumed", {
            candidateCount: candidateCount(),
          });
        } else {
          const freshAttempt = await reserveFreshCandidateAttempt();
          if (freshAttempt === null) {
            throw (
              lastTransientFailure ??
              new ManusV2ApiError(
                "file.detail",
                null,
                "FILE_UPLOAD_CONFIRMATION_UNKNOWN",
                false,
                true,
              )
            );
          }
          safeLog(
            freshAttempt === 1
              ? "candidate_attempt_reserved"
              : "candidate_replacement_reserved",
            {
              candidateCount: Math.max(candidateCount(), freshAttempt),
              ...(freshAttempt === 2
                ? {
                    diagnosticCode:
                      "PRESALES_V2_TRANSIENT_FILE_CANDIDATE_REPLACEMENT",
                  }
                : {}),
            },
          );
        }

        try {
          uploaded = await client.uploadFile({
            filename: asset.filename,
            bytes: local.bytes,
            contentType: asset.mimeType,
            minimumUsableSeconds: PROVIDER_FILE_MINIMUM_USABLE_SECONDS,
            sleep: dependencies.sleep,
            now: () => dependencies.now().getTime(),
            ...(existingCandidate ? { existingCandidate } : {}),
            observer: {
              onCandidateCreated: async (candidate) => {
                await rememberLease(candidate, "reserved");
                safeLog("candidate_reserved", {
                  candidateCount: candidateCount(),
                });
              },
              onPutStarted: async (candidate) => {
                await rememberLease(candidate, "uploading");
                safeLog("put_started", {
                  candidateCount: candidateCount(),
                });
              },
              onPutAccepted: async (candidate) => {
                await rememberLease(candidate, "uploading");
                safeLog("put_accepted", {
                  candidateCount: candidateCount(),
                });
              },
              onPutRejected: async (candidate) => {
                await rememberLease(candidate, "failed");
                safeLog("put_rejected", {
                  candidateCount: candidateCount(),
                });
              },
              onPutOutcomeUnknown: async (candidate) => {
                await rememberLease(candidate, "outcome_unknown");
                safeLog("put_outcome_unknown", {
                  candidateCount: candidateCount(),
                });
              },
              onConfirmationUnknown: async (candidate) => {
                await rememberLease(candidate, "outcome_unknown");
                safeLog("confirmation_unknown", {
                  candidateCount: candidateCount(),
                  failureClass: "transient",
                  diagnosticCode: "PRESALES_V2_FILE_CONFIRMATION_TIMEOUT",
                });
              },
            },
          });
        } catch (error) {
          const failureClass = safePresalesV2FileFailureClass(error);
          safeLog("candidate_failed", {
            candidateCount: candidateCount(),
            failureClass,
            ...(failureClass === "transient"
              ? {
                  diagnosticCode: "PRESALES_V2_PROVIDER_FILE_UNAVAILABLE",
                }
              : {}),
          });
          if (!transientPresalesV2FileFailure(error)) throw error;
          lastTransientFailure = error;
          resumeLease = undefined;
          if (
            candidateCount() >= MAX_PROVIDER_FILE_CANDIDATES ||
            (record.preparation?.assets.find(
              (item) => item.localAssetId === asset.localAssetId,
            )?.candidateAttempts ?? inMemoryCandidateAttempts) >=
              MAX_PROVIDER_FILE_CANDIDATES
          ) {
            throw error;
          }
        }
      }

      safeLog("confirmation_uploaded", {
        candidateCount: candidateCount(),
      });
      await rememberUploadedLease(uploaded, uploaded.detail.expiresAt);
      safeLog("lease_uploaded", { candidateCount: candidateCount() });
      attachments.push({
        file_id: uploaded.fileId,
        filename: uploaded.filename,
      });
    }
  } catch (error) {
    await settlePresalesV2PreparationFailure(
      record.localTaskId,
      error,
      dependencies,
    );
    return;
  }

  const outputInstruction =
    input.contract.output === "structured"
      ? presalesV2StructuredPrompt(input.contract)
      : "Return exactly one complete candidate ZIP as the only assistant attachment. Do not return a Provider file id in text.";
  const providerPrompt = [
    record.operationMarker,
    outputInstruction,
    input.prompt,
  ].join("\n\n");

  // The create-search window describes an attempted Provider create, not the
  // potentially much longer local-file preparation phase. Persist it directly
  // before createTask so an active upload can never age out prematurely.
  try {
    const createAttemptedAt = dependencies.now();
    let ownsProviderCreateBoundary = false;
    const refreshed = await dependencies.updateTask(
      record.localTaskId,
      (current) => {
        if (current.status !== "queued" || current.providerTaskId) {
          return current;
        }
        if (current.preparation?.providerCreateAttemptedAt) {
          return current;
        }
        ownsProviderCreateBoundary = true;
        // Set the phase inside the durable CAS. If the filesystem write lands
        // but its SQL projection fails, outer compensation must still treat the
        // Provider create boundary as crossed and must never reopen dispatch.
        phase.providerCreateAttempted = true;
        return {
          ...current,
          createSearchUntil: new Date(
            createAttemptedAt.getTime() + CREATE_RECONCILE_WINDOW_MS,
          ).toISOString(),
          ...(current.preparation
            ? {
                preparation: {
                  ...current.preparation,
                  prompt: null,
                  providerCreateAttemptedAt: createAttemptedAt.toISOString(),
                },
              }
            : {}),
        };
      },
    );
    if (!refreshed) {
      throw new PresalesV2HttpError("TASK_RESERVATION_MISSING", 500);
    }
    record = refreshed;
    if (!ownsProviderCreateBoundary) return;
  } catch (error) {
    if (phase.providerCreateAttempted) {
      // The durable claim callback ran. The filesystem claim may have landed
      // even when its SQL projection failed, so marker reconciliation is the
      // only safe next action; never write a contradictory pre-create failure.
      return;
    }
    await settlePresalesV2PreparationFailure(
      record.localTaskId,
      error,
      dependencies,
    );
    return;
  }
  if (record.status !== "queued" || record.providerTaskId) return;

  let created: Awaited<ReturnType<PresalesV2DispatchClient["createTask"]>>;
  try {
    console.info("[Presales v2] provider task create", {
      taskHash,
      phase: "sending",
      attachmentCount: attachments.length,
    });
    created = await client.createTask({
      prompt: providerPrompt,
      attachments,
      title: record.providerTitle,
      agentProfile: record.upstreamModel,
      locale: "zh-CN",
      ...(input.contract.output === "structured"
        ? { structuredOutputSchema: input.contract.structuredOutputSchema! }
        : {}),
    });
    console.info("[Presales v2] provider task create", {
      taskHash,
      phase: "acknowledged",
      attachmentCount: attachments.length,
    });
  } catch (error) {
    if (error instanceof ManusV2ApiError && error.outcomeUnknown) return;
    if (error instanceof ManusV2ApiError) {
      phase.providerCreateKnownRejection = error;
      await settlePresalesV2KnownCreateRejection(
        record.localTaskId,
        error,
        dependencies,
      );
      return;
    }
    await dependencies.updateTask(record.localTaskId, (current) =>
      current.status === "queued" && !current.providerTaskId
        ? {
            ...current,
            status: "failed",
            terminalAt: dependencies.now().toISOString(),
            errorCode: "TASK_CREATE_FAILED",
          }
        : current,
    );
    return;
  }

  try {
    const providerStartedAt = dependencies.now().toISOString();
    const bound = await dependencies.updateTask(
      record.localTaskId,
      (current) =>
        current.status === "queued" && !current.providerTaskId
          ? {
              ...current,
              providerTaskId: created.taskId,
              providerRequestId: created.requestId,
              status: "running",
              terminalAt: null,
              providerStartedAt,
              providerRunDeadlineAt: new Date(
                Date.parse(providerStartedAt) + PROVIDER_RUN_DEADLINE_MS,
              ).toISOString(),
            }
          : current,
    );
    if (!bound || bound.providerTaskId !== created.taskId) {
      throw new PresalesV2HttpError("TASK_PROVIDER_BIND_OUTCOME_UNKNOWN", 500);
    }
  } catch (error) {
    // createTask definitely returned a task. Never relabel it failed and never
    // call create again: the queued operation marker remains sufficient for
    // the existing GET reconciliation path to bind the unique Provider task.
    console.error("[Presales v2] Provider task binding persistence failed", {
      diagnosticCode: "PRESALES_V2_PROVIDER_BIND_PERSIST_FAILED",
      taskHash,
      errorType: error instanceof Error ? error.name : "UnknownError",
    });
    throw error;
  }
}

function localSafeEventId(localTaskId: string, providerEventId: string) {
  return `safeevt_${createHash("sha256")
    .update(`${localTaskId}\0${providerEventId}`, "utf8")
    .digest("hex")}`;
}

export function presalesV2SafeEvents(
  localTaskId: string,
  events: ReadonlyArray<Pick<ManusV2MessageEvent, "id" | "type" | "timestamp">>,
) {
  return events.map((event) => ({
    id: /^safeevt_[a-f0-9]{64}$/u.test(event.id)
      ? event.id
      : localSafeEventId(localTaskId, event.id),
    type: event.type,
    timestamp: event.timestamp,
  }));
}

function withRepairStatus(
  record: PresalesV2TaskRecord,
  status: PresalesV2TaskRecord["status"],
) {
  if (!record.repair) return record;
  return {
    ...record,
    repair: {
      ...record.repair,
      status,
      updatedAt: new Date().toISOString(),
    },
  };
}

type PresalesV2StructuredResultSource =
  | "structured_object"
  | "structured_json_string"
  | "structured_recovered_value"
  | "assistant_json_fallback";

export type PresalesV2StructuredResultDecode =
  | {
      kind: "accepted";
      value: Record<string, unknown>;
      source: PresalesV2StructuredResultSource;
      hash: string;
      encodedBytes: number;
      eventId: string;
      eventTimestamp: number;
      structuredEventCount: number;
      validCandidateCount: number;
      repairRules?: ReadonlyArray<ModelOutputRepairRuleCode>;
    }
  | {
      kind: "ambiguous";
      candidateCoordinates: ReadonlyArray<{
        eventId: string;
        eventTimestamp: number;
      }>;
      structuredEventCount: number;
      validCandidateCount: number;
    }
  | {
      kind: "missing";
      structuredEventCount: number;
      validCandidateCount: 0;
    };

function structuredSchemaTypes(schema: Record<string, unknown>) {
  const raw = schema.type;
  return Array.isArray(raw)
    ? raw.filter((item): item is string => typeof item === "string")
    : typeof raw === "string"
      ? [raw]
      : [];
}

function valueMatchesStructuredType(value: unknown, type: string) {
  switch (type) {
    case "null":
      return value === null;
    case "object":
      return (
        value !== null && typeof value === "object" && !Array.isArray(value)
      );
    case "array":
      return Array.isArray(value);
    case "string":
      return typeof value === "string";
    case "boolean":
      return typeof value === "boolean";
    case "number":
      return typeof value === "number" && Number.isFinite(value);
    case "integer":
      return (
        typeof value === "number" &&
        Number.isFinite(value) &&
        Number.isInteger(value)
      );
    default:
      return false;
  }
}

function structuredSchemaAccepts(
  value: unknown,
  schema: Record<string, unknown>,
) {
  let visited = 0;
  const visit = (
    candidate: unknown,
    coordinate: Record<string, unknown>,
    depth: number,
  ): boolean => {
    visited += 1;
    if (
      visited > MAX_STRUCTURED_RESULT_NODES ||
      depth > MAX_STRUCTURED_RESULT_DEPTH
    ) {
      return false;
    }
    const types = structuredSchemaTypes(coordinate);
    if (
      types.length === 0 ||
      !types.some((type) => valueMatchesStructuredType(candidate, type))
    ) {
      return false;
    }
    if (Array.isArray(coordinate.enum)) {
      const matched = coordinate.enum.some(
        (allowed) =>
          allowed === candidate ||
          (typeof allowed === "number" &&
            typeof candidate === "number" &&
            Number.isFinite(allowed) &&
            Object.is(allowed, candidate)),
      );
      if (!matched) return false;
    }
    if (candidate === null) return true;
    if (Array.isArray(candidate)) {
      const items = coordinate.items;
      if (!items || typeof items !== "object" || Array.isArray(items)) {
        return false;
      }
      return candidate.every((item) =>
        visit(item, items as Record<string, unknown>, depth + 1),
      );
    }
    if (typeof candidate === "object") {
      const properties =
        coordinate.properties &&
        typeof coordinate.properties === "object" &&
        !Array.isArray(coordinate.properties)
          ? (coordinate.properties as Record<string, unknown>)
          : {};
      const required = Array.isArray(coordinate.required)
        ? coordinate.required.filter(
            (item): item is string => typeof item === "string",
          )
        : [];
      const record = candidate as Record<string, unknown>;
      if (!required.every((key) => Object.hasOwn(record, key))) return false;
      if (
        coordinate.additionalProperties === false &&
        Object.keys(record).some((key) => !Object.hasOwn(properties, key))
      ) {
        return false;
      }
      return Object.entries(record).every(([key, item]) => {
        const child = properties[key];
        if (child === undefined)
          return coordinate.additionalProperties !== false;
        return (
          typeof child === "object" &&
          !Array.isArray(child) &&
          visit(item, child as Record<string, unknown>, depth + 1)
        );
      });
    }
    return true;
  };
  return visit(value, schema, 0);
}

function canonicalStructuredJson(value: unknown): string {
  if (value === null) return "null";
  if (typeof value === "string" || typeof value === "boolean") {
    return JSON.stringify(value);
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalStructuredJson).join(",")}]`;
  }
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map(
        (key) =>
          `${JSON.stringify(key)}:${canonicalStructuredJson(record[key])}`,
      )
      .join(",")}}`;
  }
  throw new Error("PRESALES_V2_STRUCTURED_VALUE_NOT_JSON");
}

export function decodePresalesV2StructuredResultV2(
  events: ReadonlyArray<ManusV2MessageEvent>,
  schema: Record<string, unknown>,
  options: { requireStoppedAuthority?: boolean } = {},
): PresalesV2StructuredResultDecode {
  const ordered = [...events].sort(
    (left, right) =>
      right.timestamp - left.timestamp || right.id.localeCompare(left.id),
  );
  const structuredEventCount = ordered.filter(
    (event) => event.type === "structured_output_result",
  ).length;
  const statusEvents = options.requireStoppedAuthority
    ? ordered.filter((event) => event.type === "status_update")
    : [];
  const candidates = new Map<
    string,
    {
      value: Record<string, unknown>;
      source: PresalesV2StructuredResultSource;
      encodedBytes: number;
      eventId: string;
      eventTimestamp: number;
    }
  >();
  for (const event of ordered) {
    if (event.type !== "structured_output_result") continue;
    if (
      options.requireStoppedAuthority &&
      latestManusV2TaskState(
        statusEvents.filter((status) => status.timestamp <= event.timestamp),
      ) !== "stopped"
    ) {
      continue;
    }
    const classified = classifyManusV2StructuredResultEnvelope(
      event.structured_output_result,
    );
    if (classified.kind !== "accepted") continue;
    let parsed: unknown = classified.value;
    let source: PresalesV2StructuredResultSource = "structured_object";
    if (typeof parsed === "string") {
      source = "structured_json_string";
      if (Buffer.byteLength(parsed, "utf8") > MAX_STRUCTURED_RESULT_BYTES) {
        continue;
      }
      try {
        parsed = JSON.parse(parsed) as unknown;
      } catch {
        continue;
      }
    }
    if (
      !parsed ||
      typeof parsed !== "object" ||
      Array.isArray(parsed) ||
      !structuredSchemaAccepts(parsed, schema)
    ) {
      continue;
    }
    let canonical: string;
    try {
      canonical = canonicalStructuredJson(parsed);
    } catch {
      continue;
    }
    const encodedBytes = Buffer.byteLength(canonical, "utf8");
    if (encodedBytes > MAX_STRUCTURED_RESULT_BYTES) continue;
    const hash = createHash("sha256").update(canonical, "utf8").digest("hex");
    if (!candidates.has(hash)) {
      candidates.set(hash, {
        value: parsed as Record<string, unknown>,
        source,
        encodedBytes,
        eventId: event.id,
        eventTimestamp: event.timestamp,
      });
    }
  }
  if (candidates.size === 0) {
    return { kind: "missing", structuredEventCount, validCandidateCount: 0 };
  }
  if (candidates.size > 1) {
    return {
      kind: "ambiguous",
      candidateCoordinates: [...candidates.values()].map((candidate) => ({
        eventId: candidate.eventId,
        eventTimestamp: candidate.eventTimestamp,
      })),
      structuredEventCount,
      validCandidateCount: candidates.size,
    };
  }
  const [hash, candidate] = candidates.entries().next().value!;
  return {
    kind: "accepted",
    ...candidate,
    hash,
    structuredEventCount,
    validCandidateCount: 1,
  };
}

type PresalesV2StructuredContractName = Exclude<
  PresalesV2Contract["name"],
  "website.knowledge-base-candidate"
>;

type PresalesV2DecodedCandidate = {
  value: Record<string, unknown>;
  hash: string;
  encodedBytes: number;
  eventId: string;
  eventTimestamp: number;
  repairRules: ModelOutputRepairRuleCode[];
};

const UNSAFE_STRUCTURED_KEYS = new Set([
  "__proto__",
  "prototype",
  "constructor",
]);

function hasUnsafeStructuredKey(value: unknown): boolean {
  let visited = 0;
  const visit = (candidate: unknown, depth: number): boolean => {
    visited += 1;
    if (
      visited > MAX_STRUCTURED_RESULT_NODES ||
      depth > MAX_STRUCTURED_RESULT_DEPTH
    ) {
      return true;
    }
    if (Array.isArray(candidate)) {
      return candidate.some((item) => visit(item, depth + 1));
    }
    if (!candidate || typeof candidate !== "object") return false;
    return Object.entries(candidate as Record<string, unknown>).some(
      ([key, item]) =>
        UNSAFE_STRUCTURED_KEYS.has(key) || visit(item, depth + 1),
    );
  };
  return visit(value, 0);
}

function parsePresalesV2StructuredText(raw: string): {
  value: unknown;
  repairRules: ModelOutputRepairRuleCode[];
} | null {
  if (Buffer.byteLength(raw, "utf8") > MAX_STRUCTURED_RESULT_BYTES) {
    return null;
  }
  try {
    let value = parseExactJson(raw);
    if (typeof value === "string") {
      const nestedRaw = value;
      if (Buffer.byteLength(nestedRaw, "utf8") > MAX_STRUCTURED_RESULT_BYTES) {
        return null;
      }
      try {
        value = parseExactJson(nestedRaw);
      } catch {
        const repaired = repairStructuredJsonCandidate(nestedRaw, {
          maxCharacters: MAX_STRUCTURED_RESULT_BYTES,
        });
        return { value: repaired.value, repairRules: repaired.ruleCodes };
      }
    }
    return { value, repairRules: [] };
  } catch {
    try {
      const repaired = repairStructuredJsonCandidate(raw, {
        maxCharacters: MAX_STRUCTURED_RESULT_BYTES,
      });
      return { value: repaired.value, repairRules: repaired.ruleCodes };
    } catch {
      return null;
    }
  }
}

function cloneStructuredRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  try {
    return JSON.parse(JSON.stringify(value)) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function canonicalValuesEqual(left: unknown, right: unknown) {
  try {
    return canonicalStructuredJson(left) === canonicalStructuredJson(right);
  } catch {
    return false;
  }
}

function providerDefaultStructuredValue(
  schema: Record<string, unknown>,
): unknown {
  const allowed = Array.isArray(schema.enum) ? schema.enum : [];
  if (allowed.length > 0) return allowed[0];
  const types = structuredSchemaTypes(schema);
  const type = types.find((candidate) => candidate !== "null") ?? "null";
  if (type === "null") return null;
  if (type === "string") return "";
  if (type === "number" || type === "integer") return 0;
  if (type === "boolean") return false;
  if (type === "array") return [];
  if (type === "object") {
    const properties =
      schema.properties &&
      typeof schema.properties === "object" &&
      !Array.isArray(schema.properties)
        ? (schema.properties as Record<string, Record<string, unknown>>)
        : {};
    return Object.fromEntries(
      Object.entries(properties).map(([key, child]) => [
        key,
        providerDefaultStructuredValue(child),
      ]),
    );
  }
  return undefined;
}

function isOptimizationForecastProviderDefault(
  value: Record<string, unknown>,
  schema: Record<string, unknown>,
) {
  const candidate = cloneStructuredRecord(value);
  const providerDefault = cloneStructuredRecord(
    providerDefaultStructuredValue(schema),
  );
  if (!candidate || !providerDefault) return false;
  delete candidate.brandMentionRateTarget;
  delete providerDefault.brandMentionRateTarget;
  return canonicalValuesEqual(candidate, providerDefault);
}

function normalizeRecommendationWrapper(value: Record<string, unknown>) {
  const coordinates: unknown[] = [];
  if (Object.hasOwn(value, "questions")) coordinates.push(value.questions);
  if (Object.hasOwn(value, "items")) coordinates.push(value.items);
  if (Object.hasOwn(value, "recommendations")) {
    coordinates.push(value.recommendations);
  }
  const data = cloneStructuredRecord(value.data);
  if (Object.hasOwn(value, "data")) {
    if (
      !data ||
      !Object.hasOwn(data, "questions") ||
      Object.keys(data).some((key) => key !== "questions")
    ) {
      return null;
    }
    coordinates.push(data.questions);
  }
  if (coordinates.length === 0) return value;
  if (
    coordinates.some(
      (candidate) => !canonicalValuesEqual(candidate, coordinates[0]),
    )
  ) {
    return null;
  }
  const wrapperKeys = new Set([
    "questions",
    "items",
    "recommendations",
    "data",
  ]);
  if (Object.keys(value).some((key) => !wrapperKeys.has(key))) return value;
  return { questions: coordinates[0] };
}

function forEachAssessmentIndicator(
  value: Record<string, unknown>,
  apply: (indicator: Record<string, unknown>) => void,
) {
  const dimensions =
    value.dimensions &&
    typeof value.dimensions === "object" &&
    !Array.isArray(value.dimensions)
      ? (value.dimensions as Record<string, unknown>)
      : null;
  if (!dimensions) return;
  for (const dimension of Object.values(dimensions)) {
    const record =
      dimension && typeof dimension === "object" && !Array.isArray(dimension)
        ? (dimension as Record<string, unknown>)
        : null;
    if (!record) continue;
    for (const indicator of Object.values(record)) {
      const item =
        indicator && typeof indicator === "object" && !Array.isArray(indicator)
          ? (indicator as Record<string, unknown>)
          : null;
      if (item) apply(item);
    }
  }
}

function completePresalesV2StructuredCandidate(
  contractName: PresalesV2StructuredContractName,
  input: Record<string, unknown>,
): Record<string, unknown> | null {
  let value = input;
  if (contractName === "website.question-recommendation") {
    const normalized = normalizeRecommendationWrapper(value);
    if (!normalized) return null;
    value = normalized;
    if (!Array.isArray(value.questions) || value.questions.length === 0) {
      return null;
    }
    value.questions = value.questions.map((raw) => {
      const question = cloneStructuredRecord(raw);
      if (!question) return raw;
      for (const key of [
        "questionEnglish",
        "enterpriseAnchor",
        "offeringAnchor",
        "competitorAnchor",
        "qaIntent",
      ]) {
        if (!Object.hasOwn(question, key)) question[key] = null;
      }
      return question;
    });
  } else if (contractName === "website.custom-question-classifier") {
    if (!Object.hasOwn(value, "questionEnglish")) {
      value.questionEnglish = null;
    }
  } else if (contractName === "website.current-state-assessment") {
    forEachAssessmentIndicator(value, (indicator) => {
      if (!Object.hasOwn(indicator, "evidenceRefs")) {
        indicator.evidenceRefs = [];
      }
    });
    if (Array.isArray(value.platformBreakdown)) {
      value.platformBreakdown = value.platformBreakdown.map((raw) => {
        const platform = cloneStructuredRecord(raw);
        if (!platform) return raw;
        if (!Object.hasOwn(platform, "citationCount")) {
          platform.citationCount = null;
        }
        if (!Object.hasOwn(platform, "referenceCount")) {
          platform.referenceCount = null;
        }
        if (!Object.hasOwn(platform, "evidenceRefs")) {
          platform.evidenceRefs = [];
        }
        return platform;
      });
    }
    if (Array.isArray(value.knowledgeVsAnswers)) {
      value.knowledgeVsAnswers = value.knowledgeVsAnswers.map((raw) => {
        const comparison = cloneStructuredRecord(raw);
        if (!comparison) return raw;
        if (!Object.hasOwn(comparison, "kbEvidenceRefs")) {
          comparison.kbEvidenceRefs = [];
        }
        return comparison;
      });
    }
    if (Array.isArray(value.priorityActions)) {
      value.priorityActions = value.priorityActions.map((raw) => {
        const action = cloneStructuredRecord(raw);
        if (!action) return raw;
        if (!Object.hasOwn(action, "evidenceRefs")) {
          action.evidenceRefs = [];
        }
        return action;
      });
    }
  } else if (contractName === "website.optimization-forecast") {
    if (!Object.hasOwn(value, "limitations")) value.limitations = [];
  }
  return value;
}

function acceptedPresalesV2Candidate(input: {
  value: unknown;
  contractName: PresalesV2StructuredContractName;
  schema: Record<string, unknown>;
  eventId: string;
  eventTimestamp: number;
  repairRules?: ModelOutputRepairRuleCode[];
}): PresalesV2DecodedCandidate | null {
  if (hasUnsafeStructuredKey(input.value)) return null;
  const cloned = cloneStructuredRecord(input.value);
  if (!cloned) return null;
  const completed = completePresalesV2StructuredCandidate(
    input.contractName,
    cloned,
  );
  if (
    !completed ||
    hasUnsafeStructuredKey(completed) ||
    !structuredSchemaAccepts(completed, input.schema)
  ) {
    return null;
  }
  if (
    input.contractName === "website.optimization-forecast" &&
    isOptimizationForecastProviderDefault(completed, input.schema)
  ) {
    return null;
  }
  let canonical: string;
  try {
    canonical = canonicalStructuredJson(completed);
  } catch {
    return null;
  }
  const encodedBytes = Buffer.byteLength(canonical, "utf8");
  if (encodedBytes > MAX_STRUCTURED_RESULT_BYTES) return null;
  return {
    value: completed,
    hash: createHash("sha256").update(canonical, "utf8").digest("hex"),
    encodedBytes,
    eventId: input.eventId,
    eventTimestamp: input.eventTimestamp,
    repairRules: input.repairRules ?? [],
  };
}

function eventStructuredEnvelope(event: ManusV2MessageEvent) {
  const raw = event.structured_output_result;
  return raw && typeof raw === "object" && !Array.isArray(raw)
    ? (raw as Record<string, unknown>)
    : null;
}

function hasNonemptyStructuredError(envelope: Record<string, unknown>) {
  const error = envelope.error;
  return (
    error !== undefined &&
    error !== null &&
    (typeof error !== "string" || error.trim().length > 0)
  );
}

function latestAcceptedCandidate(
  candidates: ReadonlyArray<PresalesV2DecodedCandidate>,
) {
  return [...candidates].sort(
    (left, right) =>
      right.eventTimestamp - left.eventTimestamp ||
      right.eventId.localeCompare(left.eventId),
  )[0];
}

function presalesV2LatestOperationSegment(
  events: ReadonlyArray<ManusV2MessageEvent>,
) {
  const latestUserMessage = [...events]
    .filter((event) => event.type === "user_message")
    .sort(
      (left, right) =>
        right.timestamp - left.timestamp || right.id.localeCompare(left.id),
    )[0];
  if (!latestUserMessage) return [...events];
  return events.filter(
    (event) =>
      event.timestamp > latestUserMessage.timestamp ||
      (event.timestamp === latestUserMessage.timestamp &&
        event.id.localeCompare(latestUserMessage.id) >= 0),
  );
}

export function decodePresalesV2StructuredResultV3(
  events: ReadonlyArray<ManusV2MessageEvent>,
  contractName: PresalesV2StructuredContractName,
  schema: Record<string, unknown>,
  options: {
    requireStoppedAuthority?: boolean;
    allowAssistantFallback?: boolean;
  } = {},
): PresalesV2StructuredResultDecode {
  const operationEvents = presalesV2LatestOperationSegment(events);
  const ordered = [...operationEvents].sort(
    (left, right) =>
      right.timestamp - left.timestamp || right.id.localeCompare(left.id),
  );
  const structuredEventCount = ordered.filter(
    (event) => event.type === "structured_output_result",
  ).length;
  const stoppedAuthority = latestManusV2TaskState(ordered) === "stopped";
  if (options.requireStoppedAuthority && !stoppedAuthority) {
    return { kind: "missing", structuredEventCount, validCandidateCount: 0 };
  }
  const tiers: PresalesV2DecodedCandidate[][] = [[], [], [], [], []];

  for (const event of ordered) {
    if (event.type !== "structured_output_result") continue;
    const envelope = eventStructuredEnvelope(event);
    if (!envelope || !Object.hasOwn(envelope, "value")) continue;
    const hasError = hasNonemptyStructuredError(envelope);
    const success = envelope.success;
    const rawValue = envelope.value;
    let parsedValue = rawValue;
    let repairRules: ModelOutputRepairRuleCode[] = [];
    let stringValue = false;
    if (typeof rawValue === "string") {
      stringValue = true;
      const parsed = parsePresalesV2StructuredText(rawValue);
      if (!parsed) continue;
      parsedValue = parsed.value;
      repairRules = parsed.repairRules;
    }
    const accepted = acceptedPresalesV2Candidate({
      value: parsedValue,
      contractName,
      schema,
      eventId: event.id,
      eventTimestamp: event.timestamp,
      repairRules,
    });
    if (!accepted) continue;
    if (success === true && !hasError) {
      tiers[stringValue ? 1 : 0]!.push(accepted);
    } else if (success === undefined && !hasError) {
      tiers[2]!.push(accepted);
    } else if (hasError) {
      tiers[4]!.push(accepted);
    }
  }

  if (options.allowAssistantFallback && stoppedAuthority) {
    for (const event of ordered) {
      if (event.type !== "assistant_message") continue;
      const message =
        event.assistant_message &&
        typeof event.assistant_message === "object" &&
        !Array.isArray(event.assistant_message)
          ? (event.assistant_message as Record<string, unknown>)
          : null;
      if (!message || typeof message.content !== "string") continue;
      const parsed = parsePresalesV2StructuredText(message.content);
      if (!parsed) continue;
      const accepted = acceptedPresalesV2Candidate({
        value: parsed.value,
        contractName,
        schema,
        eventId: event.id,
        eventTimestamp: event.timestamp,
        repairRules: parsed.repairRules,
      });
      if (accepted) tiers[3]!.push(accepted);
    }
  }

  for (let tier = 0; tier < tiers.length; tier += 1) {
    const accepted = latestAcceptedCandidate(tiers[tier]!);
    if (!accepted) continue;
    const source: PresalesV2StructuredResultSource =
      tier === 0
        ? "structured_object"
        : tier === 1 && accepted.repairRules.length === 0
          ? "structured_json_string"
          : tier === 3
            ? "assistant_json_fallback"
            : "structured_recovered_value";
    return {
      kind: "accepted",
      ...accepted,
      source,
      structuredEventCount,
      validCandidateCount: tiers.reduce(
        (count, candidates) => count + candidates.length,
        0,
      ),
    };
  }
  return { kind: "missing", structuredEventCount, validCandidateCount: 0 };
}

export function acceptedPresalesV2StructuredResult(
  events: ReadonlyArray<ManusV2MessageEvent>,
  schema: Record<string, unknown> = { type: "object" },
) {
  const decoded = decodePresalesV2StructuredResultV2(events, schema);
  return decoded.kind === "accepted" ? decoded.value : null;
}

function logPresalesV2ResultObservation(input: {
  localTaskId: string;
  contractName: string;
  providerState: string;
  eventTypeCounts: Readonly<Record<string, number>>;
  decodeKind: PresalesV2StructuredResultDecode["kind"] | "not_decoded";
  resultSource?: PresalesV2StructuredResultSource | null;
  encodedBytes?: number | null;
  validCandidateCount?: number | null;
  repairRules?: ReadonlyArray<ModelOutputRepairRuleCode>;
  repairReason?: NonNullable<PresalesV2TaskRecord["repair"]>["reason"] | null;
  repairStatus?: PresalesV2TaskRecord["status"] | null;
  providerDeadlineExceeded?: boolean;
  decoderRevision?: 2 | 3;
}) {
  const providerState = ["running", "waiting", "error", "stopped"].includes(
    input.providerState,
  )
    ? input.providerState
    : "unknown";
  console.info("[Presales v2] structured result observation", {
    taskHash: createHash("sha256")
      .update(input.localTaskId, "utf8")
      .digest("hex")
      .slice(0, 16),
    contractName: input.contractName,
    decoderRevision: input.decoderRevision ?? 2,
    providerState,
    eventTypeCounts: input.eventTypeCounts,
    decodeKind: input.decodeKind,
    resultSource: input.resultSource ?? null,
    encodedBytes: input.encodedBytes ?? null,
    validCandidateCount: input.validCandidateCount ?? null,
    repairRules: input.repairRules ?? [],
    repairReason: input.repairReason ?? null,
    repairStatus: input.repairStatus ?? null,
    providerDeadlineExceeded: Boolean(input.providerDeadlineExceeded),
  });
}

function presalesV2EventTypeCounts(events: ReadonlyArray<ManusV2MessageEvent>) {
  const counts: Record<string, number> = {};
  const safeTypes = new Set([
    "assistant_message",
    "status_update",
    "structured_output_result",
    "user_message",
  ]);
  for (const event of events) {
    const type = safeTypes.has(event.type) ? event.type : "other";
    counts[type] = (counts[type] ?? 0) + 1;
  }
  return counts;
}

type PresalesV2WaitingClassification =
  | "cascade"
  | "ask_user"
  | "other"
  | "missing";

function classifyPresalesV2Waiting(
  waiting: ReturnType<typeof latestManusV2WaitingDetail>,
): PresalesV2WaitingClassification {
  if (!waiting) return "missing";
  const canonicalType = waiting.eventType
    .replace(/[^a-z]/giu, "")
    .toLowerCase();
  if (canonicalType === "messageaskuser") return "ask_user";
  if (canonicalType === "cascadejobcall") return "cascade";
  return "other";
}

function logPresalesV2WaitingObservation(input: {
  localTaskId: string;
  contractName: string;
  providerState: string;
  waitingClassification: PresalesV2WaitingClassification;
  eventTypeCounts: Readonly<Record<string, number>>;
  decodeConclusion: PresalesV2StructuredResultDecode["kind"] | "not_applicable";
  artifactConclusion: "missing" | "single" | "multiple" | "not_applicable";
}) {
  console.info("[Presales v2] Provider waiting observation", {
    taskHash: createHash("sha256")
      .update(input.localTaskId, "utf8")
      .digest("hex")
      .slice(0, 16),
    contractName: input.contractName,
    providerState: input.providerState === "waiting" ? "waiting" : "unknown",
    waitingClassification: input.waitingClassification,
    eventTypeCounts: input.eventTypeCounts,
    decodeConclusion: input.decodeConclusion,
    artifactConclusion: input.artifactConclusion,
  });
}

type AssistantAttachment = {
  eventId: string;
  attachmentIndex: number;
  filename: string;
  contentType: string;
  url: string;
};

export function presalesV2AssistantAttachments(
  events: ReadonlyArray<ManusV2MessageEvent>,
): AssistantAttachment[] {
  const result: AssistantAttachment[] = [];
  for (const event of events) {
    if (event.type !== "assistant_message") continue;
    const message =
      event.assistant_message &&
      typeof event.assistant_message === "object" &&
      !Array.isArray(event.assistant_message)
        ? (event.assistant_message as Record<string, unknown>)
        : null;
    const attachments = Array.isArray(message?.attachments)
      ? message.attachments
      : [];
    attachments.forEach((raw, attachmentIndex) => {
      const item =
        raw && typeof raw === "object" && !Array.isArray(raw)
          ? (raw as Record<string, unknown>)
          : null;
      if (
        !item ||
        typeof item.filename !== "string" ||
        typeof item.url !== "string" ||
        typeof item.content_type !== "string"
      ) {
        return;
      }
      result.push({
        eventId: event.id,
        attachmentIndex,
        filename: item.filename.slice(0, 512),
        contentType: item.content_type.slice(0, 255),
        url: item.url,
      });
    });
  }
  return result;
}

function artifactIdFor(input: {
  providerTaskId: string;
  eventId: string;
  attachmentIndex: number;
}) {
  return `artifact_${createHash("sha256")
    .update(
      `${input.providerTaskId}\0${input.eventId}\0${input.attachmentIndex}`,
      "utf8",
    )
    .digest("hex")}`;
}

async function firstBytes(stream: Readable, count: number) {
  for await (const raw of stream) {
    return (Buffer.isBuffer(raw) ? raw : Buffer.from(raw)).subarray(0, count);
  }
  return Buffer.alloc(0);
}

async function readStreamBuffer(stream: Readable, maxBytes: number) {
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const raw of stream) {
    const chunk = Buffer.isBuffer(raw) ? raw : Buffer.from(raw);
    bytes += chunk.length;
    if (bytes > maxBytes) {
      throw new PresalesV2HttpError("ARTIFACT_BYTES_EXCEEDED", 413);
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

export function presalesV2ArtifactBeforeRedirect(
  options: Record<string, unknown>,
) {
  try {
    safeExternalRequestOptions.beforeRedirect(options);
  } catch {
    throw new PresalesV2HttpError("UNSAFE_ARTIFACT_URL", 502);
  }
  if (String(options.protocol ?? "") !== "https:") {
    throw new PresalesV2HttpError("UNSAFE_ARTIFACT_URL", 502);
  }
}

async function localizeArtifact(input: {
  record: PresalesV2TaskRecord;
  attachment: AssistantAttachment;
}) {
  const providerTaskId = input.record.providerTaskId;
  if (!providerTaskId) throw new Error("PRESALES_V2_PROVIDER_TASK_MISSING");
  const artifactId = artifactIdFor({
    providerTaskId,
    eventId: input.attachment.eventId,
    attachmentIndex: input.attachment.attachmentIndex,
  });
  const existing = await readPresalesV2Artifact(artifactId);
  if (existing && (await readStoredPresalesFile(artifactId))) {
    await persistWebsiteArtifact(existing);
    return existing;
  }

  const normalizedUrl = assertSafeExternalUrl(input.attachment.url);
  if (new URL(normalizedUrl).protocol !== "https:") {
    throw new PresalesV2HttpError("UNSAFE_ARTIFACT_URL", 502);
  }
  const response = await axios.get<Readable>(normalizedUrl, {
    ...safeExternalRequestOptions,
    // The generic egress helper permits both protocols for unrelated callers.
    // Provider artifacts are HTTPS-only, including every redirect hop.
    beforeRedirect: presalesV2ArtifactBeforeRedirect,
    responseType: "stream",
    timeout: 120_000,
    maxContentLength: MAX_ASSET_BYTES,
    maxBodyLength: MAX_ASSET_BYTES,
    validateStatus: () => true,
  });
  if (response.status !== 200) {
    response.data.destroy();
    throw new PresalesV2HttpError("ARTIFACT_DOWNLOAD_FAILED", 502, true);
  }
  const responseType = String(
    response.headers["content-type"] ?? input.attachment.contentType,
  )
    .split(";", 1)[0]!
    .trim()
    .toLowerCase()
    .slice(0, 255);
  if (
    input.record.contract.name === "website.knowledge-base-candidate" &&
    responseType !== "application/zip" &&
    responseType !== "application/octet-stream"
  ) {
    response.data.destroy();
    throw new PresalesV2HttpError("ARTIFACT_MIME_INVALID", 422);
  }
  await recordPresalesFileDescriptor({
    fileId: artifactId,
    filename: input.attachment.filename,
    mimeType: responseType,
  });
  const staged = await stagePresalesFileContent({
    fileId: artifactId,
    stream: response.data,
    maxBytes: MAX_ASSET_BYTES,
  });
  try {
    if (input.record.contract.name === "website.knowledge-base-candidate") {
      const magic = await firstBytes(staged.createReadStream(), 4);
      if (
        magic.length < 4 ||
        magic[0] !== 0x50 ||
        magic[1] !== 0x4b ||
        ![0x03, 0x05, 0x07].includes(magic[2]!) ||
        ![0x04, 0x06, 0x08].includes(magic[3]!)
      ) {
        throw new PresalesV2HttpError("ARTIFACT_MAGIC_INVALID", 422);
      }
      try {
        await assertPresalesV2ZipSafe(
          await readStreamBuffer(staged.createReadStream(), MAX_ASSET_BYTES),
        );
      } catch (error) {
        if (error instanceof PresalesV2HttpError) throw error;
        throw new PresalesV2HttpError("ARTIFACT_ZIP_UNSAFE", 422);
      }
    }
    const now = Date.now();
    await staged.commit({
      filename: input.attachment.filename,
      mimeType: responseType,
      uploadedAt: now,
      contentExpiresAt: now + FILE_CONTENT_RETENTION_MS,
    });
  } catch (error) {
    await staged.discard().catch(() => undefined);
    throw error;
  }
  const artifact = await recordPresalesV2Artifact({
    schemaVersion: 2,
    localTaskId: input.record.localTaskId,
    operationId: input.record.operationId,
    projectId: input.record.projectId,
    sourceEventId: input.attachment.eventId,
    attachmentIndex: input.attachment.attachmentIndex,
    artifactId,
    filename: input.attachment.filename,
    mimeType: responseType,
    bytes: staged.sizeBytes,
    sha256: staged.sha256,
    createdAt: new Date().toISOString(),
  });
  await persistWebsiteArtifact(artifact);
  return artifact;
}

type PresalesV2ReconcileClient = Pick<
  ManusV2Client,
  "findCreatedTask" | "listAllMessages"
>;

function resumePresalesV2Preparation(record: PresalesV2TaskRecord) {
  const preparation = record.preparation;
  if (
    record.status !== "queued" ||
    record.providerTaskId ||
    !preparation ||
    preparation.providerCreateAttemptedAt
  ) {
    return false;
  }

  const phase: PresalesV2DispatchPhase = { providerCreateAttempted: false };
  startPresalesV2Dispatch(
    record.localTaskId,
    async () => {
      const latest = await readPresalesV2Task(record.localTaskId);
      const latestPreparation = latest?.preparation;
      if (
        !latest ||
        latest.status !== "queued" ||
        latest.providerTaskId ||
        !latestPreparation ||
        latestPreparation.providerCreateAttemptedAt
      ) {
        return;
      }
      if (typeof latestPreparation.prompt !== "string") {
        throw new PresalesV2HttpError(
          "TASK_PREPARATION_INPUT_UNAVAILABLE",
          409,
        );
      }
      const credential = await getPresalesCredentialById(latest.credentialId);
      if (!credential || credential.version !== latest.credentialVersion) {
        throw new PresalesV2HttpError(
          "TASK_CREDENTIAL_UNAVAILABLE",
          410,
          false,
          latest.operationId,
        );
      }
      const assets = await Promise.all(
        latestPreparation.assets.map(async (coordinate) => {
          const asset = await readPresalesV2Asset(coordinate.localAssetId);
          if (
            !asset ||
            asset.status !== "uploaded" ||
            asset.filename !== coordinate.filename ||
            asset.projectId !== latest.projectId
          ) {
            throw new PresalesV2HttpError("ASSET_NOT_AVAILABLE", 409);
          }
          return asset;
        }),
      );
      await dispatchPresalesV2Task(
        {
          record: latest,
          assets,
          prompt: latestPreparation.prompt,
          contract: resolvePresalesV2Contract(latest.contract),
          apiKey: credential.apiKey,
        },
        {},
        phase,
      );
    },
    (error) =>
      compensatePresalesV2DispatchFailure({
        localTaskId: record.localTaskId,
        error,
        phase,
      }),
  );
  return true;
}

export type PresalesV2ReconcileDependencies = {
  now: () => Date;
  readTask: typeof readPresalesV2Task;
  updateTask: typeof updatePresalesV2Task;
  isDispatchActive: (localTaskId: string) => boolean;
  resumePreparation: (record: PresalesV2TaskRecord) => boolean;
  clientForTask: (
    record: PresalesV2TaskRecord,
  ) => Promise<PresalesV2ReconcileClient>;
  localizeArtifact: typeof localizeArtifact;
};

function reconcileDependencies(
  overrides: Partial<PresalesV2ReconcileDependencies> = {},
): PresalesV2ReconcileDependencies {
  return {
    now: () => new Date(),
    readTask: readPresalesV2Task,
    updateTask: updatePresalesV2Task,
    isDispatchActive: isPresalesV2DispatchActive,
    resumePreparation: resumePresalesV2Preparation,
    clientForTask,
    localizeArtifact,
    ...overrides,
  };
}

function validTimestamp(value: string | null | undefined, fallback: number) {
  const parsed = typeof value === "string" ? Date.parse(value) : Number.NaN;
  return Number.isFinite(parsed) ? parsed : fallback;
}

function sameRepairCoordinate(
  left: PresalesV2TaskRecord["repair"],
  right: PresalesV2TaskRecord["repair"],
) {
  if (!left || !right) return left === right;
  return (
    left.reason === right.reason &&
    left.operationId === right.operationId &&
    left.idempotencyHash === right.idempotencyHash &&
    left.requestHash === right.requestHash &&
    left.operationMarker === right.operationMarker &&
    JSON.stringify(left.baselineEventIds) ===
      JSON.stringify(right.baselineEventIds)
  );
}

function canApplyProviderObservation(
  current: PresalesV2TaskRecord,
  observed: PresalesV2TaskRecord,
  options: {
    resultFinalization?: boolean;
  } = {},
) {
  if (current.providerTaskId !== observed.providerTaskId) return false;
  if (current.status === "succeeded" || current.status === "cancelled") {
    return false;
  }
  if (current.status === "failed") {
    return false;
  }
  if (
    current.status === "attention_required" &&
    !(
      options.resultFinalization &&
      current.errorCode === "PROVIDER_RUN_DEADLINE_EXCEEDED"
    )
  ) {
    return false;
  }
  return sameRepairCoordinate(current.repair, observed.repair);
}

function applyProviderObservation(
  current: PresalesV2TaskRecord,
  observed: PresalesV2TaskRecord,
  update: (candidate: PresalesV2TaskRecord) => PresalesV2TaskRecord,
  options: Parameters<typeof canApplyProviderObservation>[2] = {},
) {
  return canApplyProviderObservation(current, observed, options)
    ? update(current)
    : current;
}

function providerTiming(record: PresalesV2TaskRecord, nowMs: number) {
  const createdAt = Date.parse(record.createdAt);
  const startedAtMs = validTimestamp(
    record.providerStartedAt,
    Number.isFinite(createdAt) ? createdAt : nowMs,
  );
  const deadlineAtMs = validTimestamp(
    record.providerRunDeadlineAt,
    startedAtMs + PROVIDER_RUN_DEADLINE_MS,
  );
  return {
    startedAtMs,
    deadlineAtMs,
    providerStartedAt: new Date(startedAtMs).toISOString(),
    providerRunDeadlineAt: new Date(deadlineAtMs).toISOString(),
  };
}

const SAFE_PROVIDER_READ_ERROR_CODES = new Set([
  "not_found",
  "provider_busy",
  "rate_limit_exceeded",
  "rate_limited",
  "request_timeout",
  "service_unavailable",
  "temporary_unavailable",
  "timeout",
  "too_many_requests",
  "transport_pre_dispatch_retry_exhausted",
  "transport_unknown",
  "upstream_unavailable",
]);

const PERMANENT_PROVIDER_READ_ERROR_CODES = new Set([
  "invalid_pagination",
  "invalid_request",
  "invalid_response",
  "task_id_conflict",
]);

function normalizedProviderReadErrorCode(error: ManusV2ApiError) {
  return error.code.trim().toLowerCase().replaceAll("-", "_");
}

function safeProviderReadErrorCode(error: ManusV2ApiError) {
  const code = normalizedProviderReadErrorCode(error);
  return SAFE_PROVIDER_READ_ERROR_CODES.has(code)
    ? code
    : "provider_read_failed";
}

function permanentProviderReadError(code: string) {
  return (
    PERMANENT_PROVIDER_READ_ERROR_CODES.has(code) ||
    /(?:^|_)(?:auth|authentication|authorization|credential|permission|forbidden|config|configuration|contract|schema|validation)(?:_|$)/u.test(
      code,
    )
  );
}

function transientProviderReadError(error: ManusV2ApiError, code: string) {
  if (!error.retryable || permanentProviderReadError(code)) return false;
  if (
    error.status === 408 ||
    error.status === 425 ||
    error.status === 429 ||
    (typeof error.status === "number" && error.status >= 500)
  ) {
    return true;
  }
  if (
    [
      "provider_busy",
      "rate_limit_exceeded",
      "rate_limited",
      "request_timeout",
      "service_unavailable",
      "temporary_unavailable",
      "timeout",
      "too_many_requests",
      "transport_pre_dispatch_retry_exhausted",
      "transport_unknown",
      "upstream_unavailable",
    ].includes(code)
  ) {
    return true;
  }
  return [
    "connection_refused",
    "connection_reset",
    "dns_temporary",
    "host_unreachable",
    "network_unreachable",
    "timeout",
  ].includes(error.transportCause ?? "");
}

function deferTransientProviderRead(input: {
  error: unknown;
  nowMs: number;
  providerStartedAtMs: number;
  providerDeadlineExceeded: boolean;
}) {
  if (
    input.providerDeadlineExceeded ||
    !(input.error instanceof ManusV2ApiError) ||
    input.error.operation !== "task.listMessages"
  ) {
    return false;
  }
  const normalizedCode = normalizedProviderReadErrorCode(input.error);
  const withinVisibilityGrace =
    input.nowMs >= input.providerStartedAtMs &&
    input.nowMs - input.providerStartedAtMs <=
      PROVIDER_TASK_VISIBILITY_GRACE_MS;
  if (normalizedCode === "not_found") return withinVisibilityGrace;
  return transientProviderReadError(input.error, normalizedCode);
}

async function reconcileUnknownCreate(
  record: PresalesV2TaskRecord,
  dependencies: PresalesV2ReconcileDependencies,
) {
  if (record.providerTaskId || record.status !== "queued") return record;
  // A fresh POST owns Provider preparation in this process. Its five-minute
  // create-search deadline does not begin until immediately before createTask,
  // so GET must not race the active uploader or classify it as unknown.
  if (dependencies.isDispatchActive(record.localTaskId)) return record;
  if (
    record.preparation &&
    record.preparation.providerCreateAttemptedAt === null
  ) {
    dependencies.resumePreparation(record);
    return record;
  }
  const client = await dependencies.clientForTask(record);
  const now = dependencies.now();
  const createdAtMs = Date.parse(record.createdAt);
  const createAttemptedAtMs = validTimestamp(
    record.preparation?.providerCreateAttemptedAt,
    Number.isFinite(createdAtMs) ? createdAtMs : now.getTime(),
  );
  const match = await client.findCreatedTask({
    title: record.providerTitle,
    operationToken: record.operationToken,
    createdAfterSeconds: Math.floor(createAttemptedAtMs / 1_000) - 60,
    createdBeforeSeconds: Math.floor(now.getTime() / 1_000) + 60,
  });
  if (match.matches.length > 1) {
    return (
      (await dependencies.updateTask(record.localTaskId, (current) =>
        current.status === "queued" && !current.providerTaskId
          ? {
              ...current,
              status: "attention_required",
              errorCode: "CREATE_RECONCILE_CONFLICT",
              terminalAt: now.toISOString(),
            }
          : current,
      )) ?? record
    );
  }
  if (match.unique) {
    const providerStartedAt = now.toISOString();
    return (
      (await dependencies.updateTask(record.localTaskId, (current) =>
        current.status === "queued" && !current.providerTaskId
          ? {
              ...current,
              providerTaskId: match.unique!.id,
              status: "running",
              terminalAt: null,
              providerStartedAt,
              providerRunDeadlineAt: new Date(
                now.getTime() + PROVIDER_RUN_DEADLINE_MS,
              ).toISOString(),
            }
          : current,
      )) ?? record
    );
  }
  if (now.getTime() >= Date.parse(record.createSearchUntil)) {
    return (
      (await dependencies.updateTask(record.localTaskId, (current) =>
        current.status === "queued" && !current.providerTaskId
          ? {
              ...current,
              status: "attention_required",
              errorCode: "CREATE_OUTCOME_UNKNOWN",
              terminalAt: now.toISOString(),
            }
          : current,
      )) ?? record
    );
  }
  return record;
}

function resolvePresalesV2ReconciliationContract(
  input: PresalesV2TaskRecord["contract"],
): PresalesV2Contract {
  if (
    input.name === "website.optimization-forecast" &&
    input.revision === PRESALES_V2_CONTRACT_VERSION &&
    input.schemaHash === HISTORICAL_OPTIMIZATION_FORECAST_CONTRACT_HASH
  ) {
    return {
      ...input,
      profile: "frontmind-base",
      output: "structured",
      structuredOutputSchema: historicalOptimizationForecastSchema,
    };
  }
  return resolvePresalesV2Contract(input);
}

async function reconcileTask(
  localTaskId: string,
  dependencyOverrides: Partial<PresalesV2ReconcileDependencies> = {},
): Promise<PresalesV2TaskRecord> {
  const dependencies = reconcileDependencies(dependencyOverrides);
  let record = await dependencies.readTask(localTaskId);
  if (!record) throw new PresalesV2HttpError("TASK_NOT_FOUND", 404);
  if (record.resultDecoderRevision !== 3) {
    // Revision 3 is assigned only when a fresh task is reserved. Every
    // historical task remains a read-only snapshot: never reread Provider,
    // reinterpret old messages, or revive an old conversation via repair.
    return record;
  }
  const providerDeadlineRead =
    record.status === "attention_required" &&
    record.errorCode === "PROVIDER_RUN_DEADLINE_EXCEEDED" &&
    Boolean(record.providerTaskId);
  if (
    ["succeeded", "failed", "cancelled", "attention_required"].includes(
      record.status,
    ) &&
    !providerDeadlineRead
  ) {
    return record;
  }
  record = await reconcileUnknownCreate(record, dependencies);
  if (!record.providerTaskId) return record;
  const providerTaskId = record.providerTaskId;

  const now = dependencies.now();
  const timing = providerTiming(record, now.getTime());
  if (
    record.providerStartedAt !== timing.providerStartedAt ||
    record.providerRunDeadlineAt !== timing.providerRunDeadlineAt
  ) {
    record =
      (await dependencies.updateTask(localTaskId, (current) => ({
        ...current,
        providerStartedAt: timing.providerStartedAt,
        providerRunDeadlineAt: timing.providerRunDeadlineAt,
      }))) ?? record;
  }

  const providerDeadlineExceeded =
    providerDeadlineRead || now.getTime() >= timing.deadlineAtMs;
  let events: ManusV2MessageEvent[];
  try {
    const client = await dependencies.clientForTask(record);
    events = await client.listAllMessages({
      taskId: providerTaskId,
      order: "desc",
    });
  } catch (error) {
    const failureNow = dependencies.now();
    const providerDeadlineExceededAtFailure =
      providerDeadlineRead || failureNow.getTime() >= timing.deadlineAtMs;
    if (
      deferTransientProviderRead({
        error,
        nowMs: failureNow.getTime(),
        providerStartedAtMs: timing.startedAtMs,
        providerDeadlineExceeded: providerDeadlineExceededAtFailure,
      })
    ) {
      const providerError = error as ManusV2ApiError;
      console.warn("[Presales v2] transient Provider read deferred", {
        diagnosticCode: "PRESALES_V2_PROVIDER_READ_DEFERRED",
        operation: providerError.operation,
        providerErrorCode: safeProviderReadErrorCode(providerError),
        status: providerError.status,
        retryable: providerError.retryable,
        persistedStateFallback: true,
      });
      return record;
    }
    if (!providerDeadlineExceededAtFailure) throw error;
    logPresalesV2ResultObservation({
      localTaskId,
      contractName: record.contract.name,
      providerState: "unknown",
      eventTypeCounts: {},
      decodeKind: "not_decoded",
      repairReason: record.repair?.reason ?? null,
      repairStatus: record.repair?.status ?? null,
      providerDeadlineExceeded: true,
      decoderRevision: record.resultDecoderRevision ?? 2,
    });
    return (
      (await dependencies.updateTask(localTaskId, (current) =>
        applyProviderObservation(current, record, (candidate) =>
          withRepairStatus(
            {
              ...candidate,
              status: "attention_required",
              errorCode: "PROVIDER_RUN_DEADLINE_EXCEEDED",
              providerRunDeadlineExceededAt:
                candidate.providerRunDeadlineExceededAt ??
                failureNow.toISOString(),
              terminalAt: candidate.terminalAt ?? failureNow.toISOString(),
            },
            "attention_required",
          ),
        ),
      )) ?? record
    );
  }
  const eventSummary = presalesV2SafeEvents(localTaskId, events);
  const relevantEvents = presalesV2LatestOperationSegment(events);
  const state = latestManusV2TaskState(relevantEvents);
  let decodeConclusion:
    | PresalesV2StructuredResultDecode["kind"]
    | "not_applicable" = "not_applicable";
  let artifactConclusion: "missing" | "single" | "multiple" | "not_applicable" =
    "not_applicable";

  if (record.contract.name === "website.knowledge-base-candidate") {
    const candidates = presalesV2AssistantAttachments(relevantEvents).filter(
      (item) =>
        item.filename.toLowerCase().endsWith(".zip") ||
        item.contentType.toLowerCase() === "application/zip",
    );
    artifactConclusion =
      candidates.length === 0
        ? "missing"
        : candidates.length === 1
          ? "single"
          : "multiple";
    if (state === "stopped" && candidates.length === 1) {
      const artifact = await dependencies.localizeArtifact({
        record,
        attachment: candidates[0]!,
      });
      return (
        (await dependencies.updateTask(
          localTaskId,
          (current) =>
            applyProviderObservation(
              current,
              record,
              (candidate) => ({
                ...candidate,
                status: "succeeded",
                errorCode: null,
                safeEvents: eventSummary,
                terminalAt: now.toISOString(),
                artifacts: [
                  {
                    artifactId: artifact.artifactId,
                    filename: artifact.filename,
                    mimeType: artifact.mimeType,
                    bytes: artifact.bytes,
                    sha256: artifact.sha256,
                  },
                ],
              }),
              { resultFinalization: true },
            ),
          events,
        )) ?? record
      );
    }
    if (state === "stopped" && candidates.length > 1) {
      return (
        (await dependencies.updateTask(
          localTaskId,
          (current) =>
            applyProviderObservation(
              current,
              record,
              (candidate) => ({
                ...candidate,
                status: "failed",
                errorCode: "ARTIFACT_CARDINALITY_INVALID",
                safeEvents: eventSummary,
                terminalAt: now.toISOString(),
              }),
              { resultFinalization: true },
            ),
          events,
        )) ?? record
      );
    }
  } else {
    const contract = resolvePresalesV2ReconciliationContract(record.contract);
    const decode = decodePresalesV2StructuredResultV3(
      relevantEvents,
      contract.name as PresalesV2StructuredContractName,
      contract.structuredOutputSchema!,
      {
        requireStoppedAuthority: true,
        allowAssistantFallback: true,
      },
    );
    decodeConclusion = decode.kind;
    if (
      decode.kind !== "missing" ||
      state === "stopped" ||
      providerDeadlineExceeded
    ) {
      logPresalesV2ResultObservation({
        localTaskId,
        contractName: contract.name,
        providerState: state ?? "unknown",
        eventTypeCounts: presalesV2EventTypeCounts(events),
        decodeKind: decode.kind,
        resultSource: decode.kind === "accepted" ? decode.source : null,
        encodedBytes: decode.kind === "accepted" ? decode.encodedBytes : null,
        validCandidateCount: decode.validCandidateCount,
        repairRules: decode.kind === "accepted" ? decode.repairRules : [],
        repairReason: record.repair?.reason ?? null,
        repairStatus: record.repair?.status ?? null,
        providerDeadlineExceeded,
        decoderRevision: 3,
      });
    }
    if (decode.kind === "accepted") {
      return (
        (await dependencies.updateTask(
          localTaskId,
          (current) =>
            applyProviderObservation(
              current,
              record,
              (candidate) =>
                withRepairStatus(
                  {
                    ...candidate,
                    status: "succeeded",
                    errorCode: null,
                    safeEvents: eventSummary,
                    structuredResult: decode.value,
                    resultDeadlineAt: null,
                    resultDecoderRevision: 3,
                    resultSource: decode.source,
                    resultHash: decode.hash,
                    terminalAt: now.toISOString(),
                  },
                  "succeeded",
                ),
              { resultFinalization: true },
            ),
          events,
        )) ?? record
      );
    }
    if (decode.kind === "ambiguous") {
      return (
        (await dependencies.updateTask(
          localTaskId,
          (current) =>
            applyProviderObservation(
              current,
              record,
              (candidate) =>
                withRepairStatus(
                  {
                    ...candidate,
                    status: "failed",
                    errorCode: "RESULT_COORDINATE_AMBIGUOUS",
                    safeEvents: eventSummary,
                    resultDeadlineAt: null,
                    resultDecoderRevision: 3,
                    resultSource: null,
                    resultHash: null,
                    terminalAt: now.toISOString(),
                  },
                  "failed",
                ),
              { resultFinalization: true },
            ),
          events,
        )) ?? record
      );
    }
  }

  if (providerDeadlineExceeded) {
    logPresalesV2ResultObservation({
      localTaskId,
      contractName: record.contract.name,
      providerState: state ?? "unknown",
      eventTypeCounts: presalesV2EventTypeCounts(events),
      decodeKind: "not_decoded",
      repairReason: record.repair?.reason ?? null,
      repairStatus: record.repair?.status ?? null,
      providerDeadlineExceeded: true,
      decoderRevision: record.resultDecoderRevision ?? 2,
    });
    return (
      (await dependencies.updateTask(
        localTaskId,
        (current) =>
          applyProviderObservation(current, record, (candidate) =>
            withRepairStatus(
              {
                ...candidate,
                status: "attention_required",
                errorCode: "PROVIDER_RUN_DEADLINE_EXCEEDED",
                safeEvents: eventSummary,
                providerRunDeadlineExceededAt:
                  candidate.providerRunDeadlineExceededAt ?? now.toISOString(),
                terminalAt: candidate.terminalAt ?? now.toISOString(),
              },
              "attention_required",
            ),
          ),
        events,
      )) ?? record
    );
  }

  if (state === "waiting") {
    const waitingClassification = classifyPresalesV2Waiting(
      latestManusV2WaitingDetail(relevantEvents),
    );
    logPresalesV2WaitingObservation({
      localTaskId,
      contractName: record.contract.name,
      providerState: state,
      waitingClassification,
      eventTypeCounts: presalesV2EventTypeCounts(events),
      decodeConclusion,
      artifactConclusion,
    });
    if (waitingClassification !== "ask_user") {
      return (
        (await dependencies.updateTask(
          localTaskId,
          (current) =>
            applyProviderObservation(current, record, (candidate) =>
              withRepairStatus(
                {
                  ...candidate,
                  status: "running",
                  errorCode: null,
                  safeEvents: eventSummary,
                  terminalAt: null,
                },
                "running",
              ),
            ),
          events,
        )) ?? record
      );
    }
    return (
      (await dependencies.updateTask(
        localTaskId,
        (current) =>
          applyProviderObservation(current, record, (candidate) =>
            withRepairStatus(
              {
                ...candidate,
                status: "attention_required",
                errorCode: "PROVIDER_ACTION_REQUIRED",
                safeEvents: eventSummary,
                terminalAt: now.toISOString(),
              },
              "attention_required",
            ),
          ),
        events,
      )) ?? record
    );
  }
  if (state === "error") {
    return (
      (await dependencies.updateTask(
        localTaskId,
        (current) =>
          applyProviderObservation(current, record, (candidate) =>
            withRepairStatus(
              {
                ...candidate,
                status: "failed",
                errorCode: "PROVIDER_TASK_FAILED",
                safeEvents: eventSummary,
                terminalAt: now.toISOString(),
              },
              "failed",
            ),
          ),
        events,
      )) ?? record
    );
  }
  if (state === "stopped") {
    const defaultResultDeadlineAt = now.getTime() + RESULT_GRACE_MS;
    const resultDeadlineAt = record.resultDeadlineAt
      ? validTimestamp(record.resultDeadlineAt, defaultResultDeadlineAt)
      : defaultResultDeadlineAt;
    // Missing output is terminal after the grace period. Never mutate the
    // Provider conversation; an explicit retry creates a fresh task.
    return (
      (await dependencies.updateTask(
        localTaskId,
        (current) => {
          const status =
            now.getTime() >= resultDeadlineAt ? "failed" : "result_pending";
          return applyProviderObservation(current, record, (candidate) =>
            withRepairStatus(
              {
                ...candidate,
                status,
                errorCode:
                  status === "failed" ? "RESULT_INVALID_OR_MISSING" : null,
                resultDeadlineAt: new Date(resultDeadlineAt).toISOString(),
                safeEvents: eventSummary,
                resultDecoderRevision: 3,
                terminalAt: status === "failed" ? now.toISOString() : null,
              },
              status,
            ),
          );
        },
        events,
      )) ?? record
    );
  }
  return (
    (await dependencies.updateTask(
      localTaskId,
      (current) =>
        applyProviderObservation(current, record, (candidate) =>
          withRepairStatus(
            {
              ...candidate,
              status: "running",
              errorCode: null,
              safeEvents: eventSummary,
              terminalAt: null,
            },
            "running",
          ),
        ),
      events,
    )) ?? record
  );
}

export const presalesV2ReconcileTestHooks = {
  reconcileTask,
  dispatchTask: dispatchPresalesV2Task,
  startDispatch: startPresalesV2Dispatch,
  isDispatchActive: isPresalesV2DispatchActive,
  compensateDispatchFailure: compensatePresalesV2DispatchFailure,
  ensureOperationAfterReservation: ensureWebsiteAgentOperationAfterReservation,
};

router.use(requirePresalesServiceToken);
router.use("/monitor-runs", monitorJsonParser, async (req, res, next) => {
  if (req.method !== "POST") {
    next();
    return;
  }
  try {
    const projectId = projectOrderProjectIdSchema.parse(req.body?.projectId);
    const attribution = await bindWebsiteProjectBusinessOwner({
      projectId,
      businessOwnerName: null,
    });
    if (attribution.state === "missing") {
      throw new PresalesV2HttpError("PROJECT_BUSINESS_OWNER_REQUIRED", 409);
    }
    next();
  } catch (error) {
    sendError(res, error);
  }
});
router.use("/monitor-runs", presalesMonitorRouter);

router.get("/status", async (req, res) => {
  try {
    const [credential, monitor] = await Promise.all([
      getActivePresalesCredential(),
      getDedicatedMonitorCredentialReadiness(process.env, {
        forceRefresh: req.query.monitorCredentialProbe === "fresh",
      }),
    ]);
    res.json({
      ok: Boolean(credential) && monitor.authenticated,
      credentialConfigured: Boolean(credential),
      monitorCredentialConfigured: monitor.configured,
      monitorCredentialAuthenticated: monitor.authenticated,
      publicUrlConfigured: isFrontMindPublicUrlConfigured(),
      presalesContractVersion: PRESALES_V2_CONTRACT_VERSION,
      capabilities: PRESALES_V2_CAPABILITIES,
      contractHashes: PRESALES_V2_CONTRACT_HASHES,
    });
  } catch (error) {
    sendError(res, error);
  }
});

router.post("/assets", jsonParser, async (req, res) => {
  try {
    const input = assetCreateSchema.parse(req.body ?? {});
    const requestHash = hashPresalesV2Request({
      projectId: input.projectId ?? null,
      filename: input.filename,
      mimeType: input.mimeType ?? "application/octet-stream",
      sizeBytes: input.sizeBytes ?? null,
    });
    const acquired = await acquirePresalesV2Asset({
      idempotencyKey: input.idempotencyKey,
      requestHash,
      projectId: input.projectId ?? null,
      filename: input.filename,
      mimeType: input.mimeType ?? "application/octet-stream",
      expectedBytes: input.sizeBytes ?? null,
    });
    if (acquired.state === "conflict") {
      throw new PresalesV2HttpError("IDEMPOTENCY_CONFLICT", 409);
    }
    if (acquired.record.status === "deleted") {
      throw new PresalesV2HttpError("ASSET_TOMBSTONED_RESET_REQUIRED", 409);
    }
    await recordPresalesFileDescriptor({
      fileId: acquired.record.localAssetId,
      filename: acquired.record.filename,
      mimeType: acquired.record.mimeType,
      ...(acquired.record.expectedBytes !== null
        ? { sizeBytes: acquired.record.expectedBytes }
        : {}),
    });
    res.status(acquired.state === "acquired" ? 201 : 200).json({
      localAssetId: acquired.record.localAssetId,
      filename: acquired.record.filename,
      status: acquired.record.status,
    });
  } catch (error) {
    sendError(res, error, "ASSET_CREATE_CONTRACT_INVALID");
  }
});

router.put("/assets/:localAssetId/content", async (req, res) => {
  try {
    const asset = await readPresalesV2Asset(req.params.localAssetId);
    if (!asset || asset.status === "deleted") {
      throw new PresalesV2HttpError("ASSET_NOT_FOUND", 404);
    }
    if (asset.status === "uploaded") {
      res.status(200).json({
        localAssetId: asset.localAssetId,
        status: asset.status,
        bytes: asset.bytes,
        sha256: asset.sha256,
      });
      return;
    }
    const staged = await stagePresalesFileContent({
      fileId: asset.localAssetId,
      stream: req,
      maxBytes: MAX_ASSET_BYTES,
    });
    if (
      asset.expectedBytes !== null &&
      staged.sizeBytes !== asset.expectedBytes
    ) {
      await staged.discard();
      throw new PresalesV2HttpError("ASSET_SIZE_MISMATCH", 409);
    }
    const now = Date.now();
    await staged.commit({
      filename: asset.filename,
      mimeType: asset.mimeType,
      uploadedAt: now,
      contentExpiresAt: now + FILE_CONTENT_RETENTION_MS,
    });
    const updated = await updatePresalesV2Asset(
      asset.localAssetId,
      (current) => ({
        ...current,
        status: "uploaded",
        bytes: staged.sizeBytes,
        sha256: staged.sha256,
      }),
    );
    await persistWebsiteLocalAsset(updated!);
    res.status(200).json({
      localAssetId: updated!.localAssetId,
      status: updated!.status,
      bytes: updated!.bytes,
      sha256: updated!.sha256,
    });
  } catch (error) {
    sendError(res, error);
  }
});

router.get("/assets/:localAssetId", async (req, res) => {
  try {
    const asset = await readPresalesV2Asset(req.params.localAssetId);
    if (!asset || asset.status === "deleted") {
      throw new PresalesV2HttpError("ASSET_NOT_FOUND", 404);
    }
    res.json({
      localAssetId: asset.localAssetId,
      filename: asset.filename,
      mimeType: asset.mimeType,
      bytes: asset.bytes,
      sha256: asset.sha256,
      status: asset.status,
    });
  } catch (error) {
    sendError(res, error);
  }
});

router.get("/assets/:localAssetId/content", async (req, res) => {
  try {
    const asset = await readPresalesV2Asset(req.params.localAssetId);
    const stored = await readStoredPresalesFile(req.params.localAssetId);
    if (!asset || asset.status !== "uploaded" || !stored) {
      throw new PresalesV2HttpError("ASSET_NOT_FOUND", 404);
    }
    res.setHeader("Content-Type", asset.mimeType);
    res.setHeader("Content-Length", String(stored.sizeBytes));
    res.setHeader(
      "Content-Disposition",
      `attachment; filename*=UTF-8''${encodeURIComponent(asset.filename)}`,
    );
    await pipeline(stored.createReadStream(), res);
  } catch (error) {
    if (!res.headersSent) sendError(res, error);
  }
});

router.delete("/assets/:localAssetId", (_req, res) => {
  // Compatibility for Website versions that still compensate a failed local
  // operation with DELETE. Provider and Dashboard evidence are retained; the
  // browser owns project removal and retention cleanup is time-based.
  res.status(204).end();
});

router.post("/tasks", jsonParser, async (req, res) => {
  let reserved: PresalesV2TaskRecord | null = null;
  let ownsFreshReservation = false;
  try {
    const input = parsePresalesV2TaskCreate(req.body ?? {});
    const contract = resolvePresalesV2Contract(input.contract);
    const attribution = await bindWebsiteProjectBusinessOwner({
      projectId: input.projectId,
      businessOwnerName: input.businessOwnerName ?? null,
    });
    if (attribution.state === "conflict") {
      throw new PresalesV2HttpError("PROJECT_BUSINESS_OWNER_CONFLICT", 409);
    }
    if (attribution.state === "missing") {
      throw new PresalesV2HttpError("PROJECT_BUSINESS_OWNER_REQUIRED", 409);
    }
    const assets = await Promise.all(
      input.localAssetIds.map(async (item) => {
        let asset = await readPresalesV2Asset(item.localAssetId);
        if (
          !asset ||
          asset.status !== "uploaded" ||
          asset.filename !== item.filename
        ) {
          throw new PresalesV2HttpError("ASSET_NOT_AVAILABLE", 409);
        }
        asset = await bindPresalesV2TaskAssetProject({
          asset,
          projectId: input.projectId,
        });
        return asset;
      }),
    );
    const totalBytes = assets.reduce(
      (sum, asset) => sum + (asset.bytes ?? 0),
      0,
    );
    if (totalBytes > MAX_TASK_ASSET_BYTES) {
      throw new PresalesV2HttpError("ASSET_SET_TOO_LARGE", 413);
    }
    const credential = await requireActiveCredential();
    const requestHash = hashPresalesV2Request({
      projectId: input.projectId ?? null,
      prompt: input.prompt,
      localAssetIds: input.localAssetIds,
      contract: input.contract,
      ...(input.businessOwnerName
        ? { businessOwnerName: input.businessOwnerName }
        : {}),
    });
    const acquired = await acquirePresalesV2Task({
      idempotencyKey: input.idempotencyKey,
      requestHash,
      projectId: input.projectId ?? null,
      contract: input.contract,
      profile: contract.profile,
      upstreamModel: managedAgentProfileModel(contract.profile),
      credentialId: credential.id,
      credentialVersion: credential.version,
      preparation: {
        prompt: input.prompt,
        assets: input.localAssetIds.map(({ localAssetId, filename }) => ({
          localAssetId,
          filename,
        })),
      },
    });
    if (acquired.state === "conflict") {
      throw new PresalesV2HttpError("IDEMPOTENCY_CONFLICT", 409);
    }
    reserved = acquired.record;
    ownsFreshReservation = acquired.state === "acquired";
    await ensureWebsiteAgentOperationAfterReservation(reserved);
    if (acquired.state === "existing") {
      // A POST replay is read-only. GET owns marker reconciliation after a
      // process restart; a replay must never upload files or create a second
      // Provider task.
      res.status(200).json(presalesV2PublicTask(reserved));
      return;
    }
    // The filesystem task and SQL operation/task ledger are durable at this
    // point. Register exactly one process-local dispatcher and acknowledge the
    // queued task without keeping Website or the browser behind Provider I/O.
    const acceptedTask = reserved;
    const dispatchPhase: PresalesV2DispatchPhase = {
      providerCreateAttempted: false,
    };
    startPresalesV2Dispatch(
      acceptedTask.localTaskId,
      () =>
        dispatchPresalesV2Task(
          {
            record: acceptedTask,
            assets,
            prompt: input.prompt,
            contract,
            apiKey: credential.apiKey,
          },
          {},
          dispatchPhase,
        ),
      (error) =>
        compensatePresalesV2DispatchFailure({
          localTaskId: acceptedTask.localTaskId,
          error,
          phase: dispatchPhase,
        }),
    );
    res.status(202).json(presalesV2PublicTask(acceptedTask));
  } catch (error) {
    if (ownsFreshReservation && reserved && reserved.status === "queued") {
      const failure = presalesV2PreparationFailureState(error);
      reserved =
        (await updatePresalesV2Task(reserved.localTaskId, (current) =>
          current.status === "queued" && !current.providerTaskId
            ? {
                ...current,
                ...failure,
                terminalAt: new Date().toISOString(),
              }
            : current,
        ).catch(() => undefined)) ?? reserved;
      if (failure.status === "attention_required") {
        res.status(202).json(presalesV2PublicTask(reserved));
        return;
      }
    }
    sendError(res, error, "TASK_CREATE_CONTRACT_INVALID");
  }
});

router.post("/tasks/:localTaskId/repair", jsonParser, async (req, res) => {
  try {
    void req;
    throw new PresalesV2HttpError("TASK_REPAIR_NOT_AVAILABLE", 409);
  } catch (error) {
    sendError(res, error);
  }
});

router.get("/tasks/:localTaskId", async (req, res) => {
  try {
    res.json(presalesV2PublicTask(await reconcileTask(req.params.localTaskId)));
  } catch (error) {
    sendError(res, error);
  }
});

router.get("/tasks/:localTaskId/result", async (req, res) => {
  try {
    const task = await reconcileTask(req.params.localTaskId);
    const status = task.status === "succeeded" ? 200 : 202;
    res.status(status).json(presalesV2PublicTask(task));
  } catch (error) {
    sendError(res, error);
  }
});

router.delete("/tasks/:localTaskId", (_req, res) => {
  // Website task records are immutable audit evidence. A local project delete
  // must never stop or delete the corresponding Provider task.
  res.status(204).end();
});

router.delete("/projects/:projectId/tasks", async (req, res) => {
  try {
    const projectId = projectOrderProjectIdSchema.parse(req.params.projectId);
    res.json({
      schemaVersion: 1,
      projectId,
      status: "deleted",
      deletedTasks: 0,
      deletedFiles: 0,
      pendingReservations: 0,
    });
  } catch (error) {
    sendError(res, error);
  }
});

router.post("/artifacts", jsonParser, async (req, res) => {
  try {
    const input = artifactCreateSchema.parse(req.body ?? {});
    await assertActiveWebsiteProject(input.projectId);
    const asset = await readPresalesV2Asset(input.sourceLocalAssetId);
    const stored = await readStoredPresalesFile(input.sourceLocalAssetId);
    if (
      !asset ||
      asset.status !== "uploaded" ||
      asset.projectId !== input.projectId ||
      asset.bytes !== input.bytes ||
      asset.sha256 !== input.sha256 ||
      !stored
    ) {
      throw new PresalesV2HttpError("FINAL_ARTIFACT_SOURCE_INVALID", 409);
    }
    const artifactId = `artifact_${createHash("sha256")
      .update(`${input.projectId}\0${input.kind}\0${input.sha256}`, "utf8")
      .digest("hex")}`;
    const existing = await readPresalesV2Artifact(artifactId);
    if (existing && (await readStoredPresalesFile(artifactId))) {
      await persistWebsiteArtifact(existing);
      res.status(200).json({
        artifactId: existing.artifactId,
        filename: existing.filename,
        mimeType: existing.mimeType,
        bytes: existing.bytes,
        sha256: existing.sha256,
      });
      return;
    }
    await recordPresalesFileDescriptor({
      fileId: artifactId,
      filename: input.filename,
      mimeType: input.mimeType,
      sizeBytes: input.bytes,
    });
    const staged = await stagePresalesFileContent({
      fileId: artifactId,
      stream: stored.createReadStream(),
      maxBytes: MAX_ASSET_BYTES,
    });
    try {
      const magic = await firstBytes(staged.createReadStream(), 4);
      if (
        magic.length < 4 ||
        magic[0] !== 0x50 ||
        magic[1] !== 0x4b ||
        ![0x03, 0x05, 0x07].includes(magic[2]!) ||
        ![0x04, 0x06, 0x08].includes(magic[3]!) ||
        staged.sizeBytes !== input.bytes ||
        staged.sha256 !== input.sha256
      ) {
        throw new PresalesV2HttpError("FINAL_ARTIFACT_BYTES_INVALID", 422);
      }
      try {
        await assertPresalesV2ZipSafe(
          await readStreamBuffer(staged.createReadStream(), MAX_ASSET_BYTES),
        );
      } catch (error) {
        if (error instanceof PresalesV2HttpError) throw error;
        throw new PresalesV2HttpError("FINAL_ARTIFACT_ZIP_UNSAFE", 422);
      }
      const now = Date.now();
      await staged.commit({
        filename: input.filename,
        mimeType: input.mimeType,
        uploadedAt: now,
        contentExpiresAt: now + FILE_CONTENT_RETENTION_MS,
      });
    } catch (error) {
      await staged.discard().catch(() => undefined);
      throw error;
    }
    const artifact = await recordPresalesV2Artifact({
      schemaVersion: 2,
      localTaskId: null,
      operationId: null,
      projectId: input.projectId,
      sourceEventId: `local:${input.sourceLocalAssetId}`,
      attachmentIndex: 0,
      artifactId,
      filename: input.filename,
      mimeType: input.mimeType,
      bytes: staged.sizeBytes,
      sha256: staged.sha256,
      createdAt: new Date().toISOString(),
    });
    await persistWebsiteArtifact(artifact);
    res.status(201).json({
      artifactId: artifact.artifactId,
      filename: artifact.filename,
      mimeType: artifact.mimeType,
      bytes: artifact.bytes,
      sha256: artifact.sha256,
    });
  } catch (error) {
    sendError(res, error);
  }
});

router.get("/artifacts/:artifactId/content", async (req, res) => {
  try {
    const artifact = await readPresalesV2Artifact(req.params.artifactId);
    const stored = await readStoredPresalesFile(req.params.artifactId);
    if (!artifact || !stored) {
      throw new PresalesV2HttpError("ARTIFACT_NOT_FOUND", 404);
    }
    res.setHeader("Content-Type", artifact.mimeType);
    res.setHeader("Content-Length", String(artifact.bytes));
    res.setHeader("ETag", `\"sha256:${artifact.sha256}\"`);
    res.setHeader(
      "Content-Disposition",
      `attachment; filename*=UTF-8''${encodeURIComponent(artifact.filename)}`,
    );
    await pipeline(stored.createReadStream(), res);
  } catch (error) {
    if (!res.headersSent) sendError(res, error);
  }
});

router.use((_req, res) => {
  res.status(404).json({
    error: { code: "NOT_FOUND", status: 404, retryable: false },
  });
});

export default router;
