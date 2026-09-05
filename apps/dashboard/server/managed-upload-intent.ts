import axios from "axios";
import {
  createHash,
  createHmac,
  hkdfSync,
  randomUUID,
  timingSafeEqual,
} from "node:crypto";
import { createReadStream } from "node:fs";
import * as fs from "node:fs/promises";
import path from "node:path";
import type { Request } from "express";

import {
  AuthServiceError,
  discardUnboundUpstreamFile,
  getDecryptedCredentialForManagedUploadIntent,
  recordUpstreamResource,
} from "./auth-service";
import {
  assertSafeExternalUrl,
  safeExternalRequestOptions,
} from "./_core/safe-external-url";
import { markUploadedFileRetention } from "./file-content-retention";
import { ManusV2ApiError, ManusV2Client } from "./manus-v2-client";
import {
  installStoredPresalesFileFromPath,
  readStoredPresalesFile,
  removeStoredPresalesFile,
} from "./presales-file-store";
import { getUpstreamBaseUrl } from "./upstream-config";
import {
  checkUpstreamFileReadiness,
  UpstreamFileReadinessError,
} from "./upstream-file-readiness";
import {
  acquireManagedUploadScopeGuards,
  assertManagedUploadScopesAvailable,
  ManagedUploadDeletionFenceError,
  reconcileDeletedManagedUploadAccountRetirements,
  type ManagedUploadFenceScope,
} from "./managed-upload-intent-fence";

export const MANAGED_UPLOAD_INTENT_MAX_BYTES = 100 * 1024 * 1024;
export const MANAGED_UPLOAD_INTENT_PART_RETENTION_MS = 6 * 60 * 60 * 1_000;
export const MANAGED_UPLOAD_INTENT_SEALED_RETENTION_MS =
  30 * 24 * 60 * 60 * 1_000;
export const MANAGED_UPLOAD_INTENT_TOMBSTONE_RETENTION_MS =
  30 * 24 * 60 * 60 * 1_000;
export const MANAGED_UPLOAD_CREATE_UNKNOWN_WAIT_MS = 195_000;
const MANAGED_UPLOAD_INTENT_TICKET_TTL_MS = 6 * 60 * 60 * 1_000;
const MANAGED_UPLOAD_PROVIDER_MIN_TTL_MS = 15_000;
const MANAGED_UPLOAD_PROVIDER_SAFETY_MS = 5_000;
const MANAGED_UPLOAD_PROVIDER_PUT_MAX_MS = 4 * 60_000;
const MANAGED_UPLOAD_LEASE_MS = 21 * 60_000;
const MANAGED_UPLOAD_LOCK_STALE_MS = 22 * 60_000;
const MANAGED_UPLOAD_OPERATION_LOCK_STALE_MS = 30_000;
const STORAGE_RESERVE_BYTES = 64 * 1024 * 1024;
const TICKET_VERSION = "mi1" as const;
const TICKET_KIND = "managed_upload_intent" as const;
const TICKET_DOMAIN = "frontmind-dashboard/managed-upload-intent-ticket:v1.";
const TICKET_SALT = Buffer.from(
  "frontmind-dashboard/managed-upload-intent-ticket/salt/v1",
  "utf8",
);
const TICKET_INFO = Buffer.from(
  "frontmind-dashboard/managed-upload-intent-ticket/signing/v1",
  "utf8",
);

export type ManagedUploadIntentPhase =
  | "receiving"
  | "sealed"
  | "creating_provider"
  | "uploading_provider"
  | "waiting_provider"
  | "finalizing"
  | "cleanup_pending";

type ProviderGenerationState =
  | "not_sent"
  | "create_sending"
  | "create_unknown"
  | "create_rejected"
  | "created"
  | "put_sending"
  | "put_unknown"
  | "put_rejected"
  | "put_complete"
  | "waiting"
  | "uploaded"
  | "discard_sending"
  | "discarded";

type ProviderGeneration = {
  generation: 1 | 2;
  state: ProviderGenerationState;
  ownershipRecorded: boolean;
  createStartedAt: string | null;
  createUnknownAt: string | null;
  retryNotBefore: string | null;
  fileId: string | null;
  filename: string | null;
  providerStatus: string | null;
  uploadExpiresAt: string | null;
  putStartedAt: string | null;
  putReplayed: boolean;
  putResponse2xx: boolean;
  updatedAt: string;
};

export type ManagedUploadIntentReceipt = {
  fileId: string;
  sizeBytes: number;
  uploadedAt: number;
  providerReadyAt: number;
  expiresAt: number;
  replayed: boolean;
  recreated: boolean;
  traceId: string;
};

export type ManagedUploadResumeScope = {
  kind: "knowledge_base";
  conversationId: string;
  turnId: string;
  clientRequestId: string;
};

export type ManagedUploadIntentManifest = {
  schemaVersion: 1 | 2;
  intentId: string;
  operationId: string;
  requestHash: string;
  batchId: string;
  ordinal: number;
  total: number;
  resumeScope: ManagedUploadResumeScope | null;
  userId: number;
  projectAssignmentId: string | null;
  credentialId: string;
  credentialOwnerUserId: number;
  credentialVersion: number;
  filename: string;
  mimeType: string;
  declaredSizeBytes: number;
  sizeBytes: number | null;
  sha256: string | null;
  state:
    | "awaiting_browser"
    | "receiving"
    | "sealed"
    | "processing"
    | "uploaded"
    | "cleanup_pending"
    | "cancelled"
    | "expired"
    | "failed";
  phase: ManagedUploadIntentPhase | null;
  revision: number;
  leaseOwner: string | null;
  leaseExpiresAt: string | null;
  providerGeneration: 0 | 1 | 2;
  provider: ProviderGeneration[];
  receipt: Omit<ManagedUploadIntentReceipt, "traceId"> | null;
  safeErrorCode: string | null;
  createdAt: string;
  sealedAt: string | null;
  updatedAt: string;
  completedAt: string | null;
  deletedAt: string | null;
};

export type ManagedUploadIntentStatus =
  | {
      state: "processing";
      phase: ManagedUploadIntentPhase;
      intentId: string;
      sizeBytes: number;
      retryAfterMs: number;
      traceId: string;
    }
  | {
      state: "needs_browser_body";
      intentId: string;
      retryable: true;
      traceId: string;
    }
  | ({ state: "uploaded"; intentId: string } & ManagedUploadIntentReceipt);

export class ManagedUploadIntentError extends Error {
  constructor(
    readonly statusCode: number,
    readonly code: string,
    message: string,
    readonly retryable: boolean,
    readonly recoveryAction:
      | "retry_same_file"
      | "check_status"
      | "discard_and_recreate"
      | "refresh_page"
      | "contact_admin",
    readonly retryAfterMs?: number,
  ) {
    super(message);
    this.name = "ManagedUploadIntentError";
  }
}

class ManagedUploadCleanupRequestedError extends Error {
  constructor() {
    super("Managed upload cleanup was requested");
  }
}

type IntentTicketClaims = {
  v: 1;
  kind: typeof TICKET_KIND;
  intentId: string;
  ownerUserId: number;
  projectAssignmentId: string | null;
  credentialId: string;
  credentialOwnerUserId: number;
  requestHash: string;
  iat: number;
  exp: number;
};

type CreateManagedUploadIntentInput = {
  operationId: string;
  batchId: string;
  ordinal: number;
  total: number;
  filename: string;
  mimeType: string;
  sizeBytes: number;
  userId: number;
  projectAssignmentId?: string | null;
  credentialId: string;
  credentialOwnerUserId: number;
  credentialVersion: number;
  resumeScope?: ManagedUploadResumeScope | null;
};

type ProviderCreateResult = {
  fileId: string;
  filename: string;
  status: string;
  uploadUrl: string | null;
  uploadExpiresAt: number | null;
  capabilityErrorCode: string | null;
};

function assetRoot() {
  return path.resolve(
    process.env.FRONTMIND_DASHBOARD_ASSET_DIR ||
      path.join(process.cwd(), ".frontmind-dashboard-assets"),
  );
}

export function managedUploadIntentStorageRoot() {
  return path.join(assetRoot(), "managed-upload-intents");
}

function storageKey(value: string) {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function intentPaths(intentId: string) {
  const directory = path.join(
    managedUploadIntentStorageRoot(),
    storageKey(intentId),
  );
  return {
    directory,
    manifest: path.join(directory, "manifest.json"),
    part: path.join(directory, "upload.part"),
    content: path.join(directory, "upload.content"),
    cleanupRequest: path.join(directory, "cleanup-request.json"),
    lock: path.join(directory, "intent.lock"),
  };
}

function operationIndexPath(input: {
  userId: number;
  projectAssignmentId: string | null;
  operationId: string;
}) {
  const key = storageKey(
    JSON.stringify([
      input.userId,
      input.projectAssignmentId,
      input.operationId,
    ]),
  );
  return path.join(
    managedUploadIntentStorageRoot(),
    "by-operation",
    `${key}.json`,
  );
}

function resumeScopeIndexPath(input: {
  userId: number;
  projectAssignmentId: string | null;
  resumeScope: ManagedUploadResumeScope;
}) {
  const key = storageKey(
    JSON.stringify([
      input.userId,
      input.projectAssignmentId,
      input.resumeScope.kind,
      input.resumeScope.conversationId,
      input.resumeScope.turnId,
    ]),
  );
  return path.join(
    managedUploadIntentStorageRoot(),
    "by-resume-scope",
    `${key}.json`,
  );
}

function managedUploadIntentIndexAuthority(
  manifest: Pick<
    ManagedUploadIntentManifest,
    | "userId"
    | "credentialOwnerUserId"
    | "projectAssignmentId"
    | "operationId"
    | "resumeScope"
  >,
) {
  return {
    userId: manifest.userId,
    credentialOwnerUserId: manifest.credentialOwnerUserId,
    projectAssignmentId: manifest.projectAssignmentId,
    operationId: manifest.operationId,
    resumeScope: manifest.resumeScope,
  };
}

function managedUploadIntentDeletionAuthorityPath(intentId: string) {
  return path.join(
    managedUploadIntentStorageRoot(),
    "deletion-fences",
    "intent-authority",
    `${storageKey(intentId)}.json`,
  );
}

async function persistManagedUploadIntentDeletionAuthority(
  manifest: ManagedUploadIntentManifest,
) {
  await writeJsonAtomic(
    managedUploadIntentDeletionAuthorityPath(manifest.intentId),
    {
      schemaVersion: 1,
      intentId: manifest.intentId,
      requestHash: manifest.requestHash,
      authority: managedUploadIntentIndexAuthority(manifest),
      updatedAt: nowIso(),
    },
  );
}

async function ensurePrivateDirectory(directory: string) {
  const resolved = path.resolve(directory);
  const firstCreated = await fs.mkdir(resolved, {
    recursive: true,
    mode: 0o700,
  });
  await fs.chmod(directory, 0o700).catch(() => undefined);
  if (firstCreated) {
    let created = path.resolve(firstCreated);
    for (;;) {
      await fsyncDirectory(path.dirname(created));
      if (created === resolved) break;
      const next = path.relative(created, resolved).split(path.sep)[0];
      if (!next || next === "..") {
        throw new Error("MANAGED_UPLOAD_DIRECTORY_DURABILITY_INVALID");
      }
      created = path.join(created, next);
    }
  }
}

async function fsyncDirectory(directory: string) {
  const handle = await fs.open(directory, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function writeJsonAtomic(target: string, value: unknown) {
  const directory = path.dirname(target);
  await ensurePrivateDirectory(directory);
  const temporary = path.join(directory, `.${randomUUID()}.tmp`);
  const handle = await fs.open(temporary, "wx", 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(value)}\n`, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await fs.rename(temporary, target);
    await fsyncDirectory(directory);
  } finally {
    await fs.rm(temporary, { force: true }).catch(() => undefined);
  }
}

function validIdentifier(value: unknown, max = 255) {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    Buffer.byteLength(value, "utf8") <= max &&
    !/[\0\r\n]/u.test(value)
  );
}

function assertManifest(value: unknown, expectedIntentId?: string) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("MANAGED_UPLOAD_INTENT_MANIFEST_INVALID");
  }
  const rawManifest = value as Partial<ManagedUploadIntentManifest>;
  // Schema 1 predates cross-device discovery. Normalize it in memory while
  // preserving its on-disk version so old durable intents remain readable.
  const manifest = {
    ...rawManifest,
    ...(rawManifest.schemaVersion === 1 &&
    !Object.prototype.hasOwnProperty.call(rawManifest, "resumeScope")
      ? { resumeScope: null }
      : {}),
  } as Partial<ManagedUploadIntentManifest>;
  const manifestKeys = [
    "batchId",
    "completedAt",
    "createdAt",
    "credentialId",
    "credentialOwnerUserId",
    "credentialVersion",
    "declaredSizeBytes",
    "deletedAt",
    "filename",
    "intentId",
    "leaseExpiresAt",
    "leaseOwner",
    "mimeType",
    "operationId",
    "ordinal",
    "phase",
    "projectAssignmentId",
    "provider",
    "providerGeneration",
    "receipt",
    "requestHash",
    "resumeScope",
    "revision",
    "safeErrorCode",
    "schemaVersion",
    "sealedAt",
    "sha256",
    "sizeBytes",
    "state",
    "total",
    "updatedAt",
    "userId",
  ];
  const states: ManagedUploadIntentManifest["state"][] = [
    "awaiting_browser",
    "receiving",
    "sealed",
    "processing",
    "uploaded",
    "cleanup_pending",
    "cancelled",
    "expired",
    "failed",
  ];
  const phases: ManagedUploadIntentPhase[] = [
    "receiving",
    "sealed",
    "creating_provider",
    "uploading_provider",
    "waiting_provider",
    "finalizing",
    "cleanup_pending",
  ];
  const providerStates: ProviderGenerationState[] = [
    "not_sent",
    "create_sending",
    "create_unknown",
    "create_rejected",
    "created",
    "put_sending",
    "put_unknown",
    "put_rejected",
    "put_complete",
    "waiting",
    "uploaded",
    "discard_sending",
    "discarded",
  ];
  const timestampOrNull = (candidate: unknown) =>
    candidate === null ||
    (typeof candidate === "string" && Number.isFinite(Date.parse(candidate)));
  const providersValid =
    Array.isArray(manifest.provider) &&
    manifest.provider.length <= 2 &&
    manifest.provider.every((entry, index) => {
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
        return false;
      }
      const record = entry as ProviderGeneration;
      const expectedProviderKeys = [
        "createStartedAt",
        "createUnknownAt",
        "fileId",
        "filename",
        "generation",
        "ownershipRecorded",
        "providerStatus",
        "putReplayed",
        "putResponse2xx",
        "putStartedAt",
        "retryNotBefore",
        "state",
        "updatedAt",
        "uploadExpiresAt",
      ];
      return (
        Object.keys(record).sort().join("\0") ===
          expectedProviderKeys.join("\0") &&
        record.generation === index + 1 &&
        (record.generation === 1 || record.generation === 2) &&
        providerStates.includes(record.state) &&
        typeof record.ownershipRecorded === "boolean" &&
        timestampOrNull(record.createStartedAt) &&
        timestampOrNull(record.createUnknownAt) &&
        timestampOrNull(record.retryNotBefore) &&
        timestampOrNull(record.uploadExpiresAt) &&
        timestampOrNull(record.putStartedAt) &&
        timestampOrNull(record.updatedAt) &&
        (record.fileId === null || validIdentifier(record.fileId)) &&
        (record.filename === null || validIdentifier(record.filename, 512)) &&
        (record.providerStatus === null ||
          validIdentifier(record.providerStatus)) &&
        typeof record.putReplayed === "boolean" &&
        typeof record.putResponse2xx === "boolean" &&
        (record.state === "create_unknown"
          ? record.createUnknownAt !== null
          : true) &&
        ([
          "created",
          "put_sending",
          "put_unknown",
          "put_rejected",
          "put_complete",
          "waiting",
          "uploaded",
          "discard_sending",
          "discarded",
        ].includes(record.state)
          ? record.fileId !== null && record.filename !== null
          : true) &&
        (!record.ownershipRecorded || record.fileId !== null) &&
        (record.state === "create_sending"
          ? record.createStartedAt !== null
          : true) &&
        (record.state === "put_sending" ? record.putStartedAt !== null : true)
      );
    });
  const receiptValid =
    manifest.receipt === null ||
    (typeof manifest.receipt === "object" &&
      !Array.isArray(manifest.receipt) &&
      Object.keys(manifest.receipt).sort().join("\0") ===
        [
          "expiresAt",
          "fileId",
          "providerReadyAt",
          "recreated",
          "replayed",
          "sizeBytes",
          "uploadedAt",
        ].join("\0") &&
      validIdentifier(manifest.receipt.fileId) &&
      Number.isSafeInteger(manifest.receipt.sizeBytes) &&
      Number.isFinite(manifest.receipt.uploadedAt) &&
      Number.isFinite(manifest.receipt.providerReadyAt) &&
      Number.isFinite(manifest.receipt.expiresAt) &&
      manifest.receipt.expiresAt > manifest.receipt.uploadedAt &&
      typeof manifest.receipt.replayed === "boolean" &&
      typeof manifest.receipt.recreated === "boolean");
  if (
    Object.keys(manifest).sort().join("\0") !== manifestKeys.join("\0") ||
    ![1, 2].includes(Number(manifest.schemaVersion)) ||
    !validIdentifier(manifest.intentId) ||
    (expectedIntentId !== undefined &&
      manifest.intentId !== expectedIntentId) ||
    !validIdentifier(manifest.operationId) ||
    typeof manifest.requestHash !== "string" ||
    !/^[a-f\d]{64}$/u.test(manifest.requestHash) ||
    typeof manifest.userId !== "number" ||
    !Number.isSafeInteger(manifest.userId) ||
    manifest.userId < 1 ||
    !validIdentifier(manifest.batchId) ||
    !(
      manifest.resumeScope === null ||
      (manifest.schemaVersion === 2 &&
        manifest.resumeScope?.kind === "knowledge_base" &&
        validIdentifier(manifest.resumeScope.conversationId, 191) &&
        validIdentifier(manifest.resumeScope.turnId, 36) &&
        validIdentifier(manifest.resumeScope.clientRequestId, 191))
    ) ||
    !Number.isSafeInteger(manifest.ordinal) ||
    !Number.isSafeInteger(manifest.total) ||
    Number(manifest.ordinal) < 1 ||
    Number(manifest.total) < Number(manifest.ordinal) ||
    Number(manifest.total) > 1_000 ||
    (manifest.projectAssignmentId !== null &&
      !validIdentifier(manifest.projectAssignmentId)) ||
    !validIdentifier(manifest.credentialId) ||
    !Number.isSafeInteger(manifest.credentialOwnerUserId) ||
    Number(manifest.credentialOwnerUserId) < 1 ||
    !Number.isSafeInteger(manifest.credentialVersion) ||
    !validIdentifier(manifest.filename, 512) ||
    !validIdentifier(manifest.mimeType, 255) ||
    !Number.isSafeInteger(manifest.declaredSizeBytes) ||
    Number(manifest.declaredSizeBytes) < 1 ||
    Number(manifest.declaredSizeBytes) > MANAGED_UPLOAD_INTENT_MAX_BYTES ||
    (manifest.sizeBytes !== null &&
      (!Number.isSafeInteger(manifest.sizeBytes) ||
        manifest.sizeBytes !== manifest.declaredSizeBytes)) ||
    (manifest.sha256 !== null &&
      (typeof manifest.sha256 !== "string" ||
        !/^[a-f\d]{64}$/u.test(manifest.sha256))) ||
    !states.includes(manifest.state!) ||
    (manifest.phase !== null &&
      !phases.includes(manifest.phase as ManagedUploadIntentPhase)) ||
    !Number.isSafeInteger(manifest.revision) ||
    Number(manifest.revision) < 1 ||
    (manifest.leaseOwner !== null && !validIdentifier(manifest.leaseOwner)) ||
    !timestampOrNull(manifest.leaseExpiresAt) ||
    (manifest.leaseOwner === null) !== (manifest.leaseExpiresAt === null) ||
    ![0, 1, 2].includes(Number(manifest.providerGeneration)) ||
    Number(manifest.providerGeneration) !== manifest.provider?.length ||
    !providersValid ||
    (manifest.providerGeneration === 2 &&
      !["create_unknown", "discarded"].includes(
        String(manifest.provider?.[0]?.state),
      )) ||
    !receiptValid ||
    (manifest.safeErrorCode !== null &&
      !validIdentifier(manifest.safeErrorCode)) ||
    !timestampOrNull(manifest.sealedAt) ||
    !timestampOrNull(manifest.completedAt) ||
    !timestampOrNull(manifest.deletedAt) ||
    !Number.isFinite(Date.parse(String(manifest.createdAt))) ||
    !Number.isFinite(Date.parse(String(manifest.updatedAt))) ||
    (["sealed", "processing", "uploaded", "failed"].includes(
      String(manifest.state),
    ) &&
      (!manifest.sealedAt ||
        manifest.sizeBytes !== manifest.declaredSizeBytes ||
        !manifest.sha256)) ||
    (manifest.state === "uploaded" && !manifest.receipt) ||
    (manifest.receipt !== null &&
      manifest.state !== "uploaded" &&
      !(manifest.state === "processing" && manifest.phase === "finalizing") &&
      !(
        manifest.state === "cleanup_pending" &&
        manifest.phase === "cleanup_pending"
      ))
  ) {
    throw new Error("MANAGED_UPLOAD_INTENT_MANIFEST_INVALID");
  }
  return manifest as ManagedUploadIntentManifest;
}

export async function readManagedUploadIntent(intentId: string) {
  if (!validIdentifier(intentId)) return null;
  try {
    return assertManifest(
      JSON.parse(await fs.readFile(intentPaths(intentId).manifest, "utf8")),
      intentId,
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

async function withIntentLock<T>(
  intentId: string,
  operation: () => Promise<T>,
) {
  const paths = intentPaths(intentId);
  await ensurePrivateDirectory(paths.directory);
  const release = await acquireOwnedFilesystemLock(
    paths.lock,
    MANAGED_UPLOAD_LOCK_STALE_MS,
    40,
  );
  try {
    return await operation();
  } finally {
    await release();
  }
}

async function acquireOwnedFilesystemLock(
  target: string,
  staleMs: number,
  maxAttempts: number,
) {
  await ensurePrivateDirectory(path.dirname(target));
  const nonce = randomUUID();
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    try {
      const handle = await fs.open(target, "wx", 0o600);
      try {
        await handle.writeFile(`${nonce}\n`, "utf8");
        await handle.sync();
      } finally {
        await handle.close();
      }
      await fsyncDirectory(path.dirname(target));
      let heartbeat = Promise.resolve();
      const timer = setInterval(
        () => {
          heartbeat = heartbeat
            .then(async () => {
              const current = await fs.readFile(target, "utf8").catch(() => "");
              if (current.trim() !== nonce) return;
              const now = new Date();
              await fs.utimes(target, now, now);
            })
            .catch(() => undefined);
        },
        Math.max(1_000, Math.floor(staleMs / 3)),
      );
      timer.unref?.();
      return async () => {
        clearInterval(timer);
        await heartbeat;
        const current = await fs.readFile(target, "utf8").catch(() => "");
        if (current.trim() === nonce) {
          await fs.rm(target, { force: true });
          await fsyncDirectory(path.dirname(target));
        }
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const stats = await fs.stat(target).catch(() => null);
      if (stats && Date.now() - stats.mtimeMs > staleMs) {
        const quarantine = `${target}.stale.${randomUUID()}`;
        try {
          await fs.rename(target, quarantine);
          const moved = await fs.stat(quarantine);
          if (Date.now() - moved.mtimeMs > staleMs) {
            await fs.rm(quarantine, { force: true });
            await fsyncDirectory(path.dirname(target));
            continue;
          }
          await fs.rename(quarantine, target).catch(async () => {
            await fs.rm(quarantine, { force: true });
          });
        } catch (moveError) {
          if ((moveError as NodeJS.ErrnoException).code !== "ENOENT") {
            throw moveError;
          }
        }
      }
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }
  throw new ManagedUploadIntentError(
    409,
    "UPLOAD_IN_PROGRESS",
    "该文件仍在上传处理中，请稍后重试",
    true,
    "check_status",
  );
}

async function replaceManifest(
  previous: ManagedUploadIntentManifest,
  update: (current: ManagedUploadIntentManifest) => ManagedUploadIntentManifest,
) {
  return withIntentLock(previous.intentId, async () => {
    const current = await readManagedUploadIntent(previous.intentId);
    if (!current || current.revision !== previous.revision) {
      throw new ManagedUploadIntentError(
        409,
        "UPLOAD_INTENT_CONFLICT",
        "上传状态已由其他请求推进，请重新检查",
        true,
        "check_status",
      );
    }
    const next = update(current);
    if (
      next.intentId !== current.intentId ||
      next.revision !== current.revision + 1
    ) {
      throw new Error("MANAGED_UPLOAD_INTENT_CAS_INVALID");
    }
    await writeJsonAtomic(intentPaths(current.intentId).manifest, next);
    return next;
  });
}

function nowIso() {
  return new Date().toISOString();
}

function requestHash(input: CreateManagedUploadIntentInput) {
  return createHash("sha256")
    .update(
      JSON.stringify({
        operationId: input.operationId,
        batchId: input.batchId,
        ordinal: input.ordinal,
        total: input.total,
        filename: input.filename.trim(),
        mimeType: input.mimeType.trim(),
        sizeBytes: input.sizeBytes,
        userId: input.userId,
        projectAssignmentId: input.projectAssignmentId ?? null,
        resumeScope: input.resumeScope ?? null,
      }),
      "utf8",
    )
    .digest("hex");
}

function decodeMasterKey(value: string) {
  const trimmed = value.trim();
  let decoded: Buffer;
  if (trimmed.startsWith("base64:")) {
    decoded = Buffer.from(trimmed.slice("base64:".length), "base64");
  } else if (trimmed.startsWith("hex:")) {
    decoded = Buffer.from(trimmed.slice("hex:".length), "hex");
  } else if (/^[a-f\d]{64}$/iu.test(trimmed)) {
    decoded = Buffer.from(trimmed, "hex");
  } else {
    decoded = Buffer.from(trimmed, "base64");
  }
  if (decoded.length !== 32) {
    throw new ManagedUploadIntentError(
      503,
      "UPLOAD_INTENT_SECRET_UNAVAILABLE",
      "上传服务配置不可用，请联系管理员",
      false,
      "contact_admin",
    );
  }
  return decoded;
}

export function deriveManagedUploadIntentTicketKey(encodedMasterKey: string) {
  return Buffer.from(
    hkdfSync(
      "sha256",
      decodeMasterKey(encodedMasterKey),
      TICKET_SALT,
      TICKET_INFO,
      32,
    ),
  );
}

function ticketKey() {
  const configured = process.env.FRONTMIND_CREDENTIAL_ENCRYPTION_KEY?.trim();
  if (!configured) {
    throw new ManagedUploadIntentError(
      503,
      "UPLOAD_INTENT_SECRET_UNAVAILABLE",
      "上传服务配置不可用，请联系管理员",
      false,
      "contact_admin",
    );
  }
  return deriveManagedUploadIntentTicketKey(configured);
}

function signTicket(
  encoded: string,
  key: Buffer<ArrayBufferLike> = ticketKey(),
) {
  return createHmac("sha256", key)
    .update(`${TICKET_DOMAIN}${encoded}`, "utf8")
    .digest();
}

export function createManagedUploadIntentTicket(
  manifest: ManagedUploadIntentManifest,
  options: { now?: number; key?: Buffer<ArrayBufferLike> } = {},
) {
  const now = options.now ?? Date.now();
  const claims: IntentTicketClaims = {
    v: 1,
    kind: TICKET_KIND,
    intentId: manifest.intentId,
    ownerUserId: manifest.userId,
    projectAssignmentId: manifest.projectAssignmentId,
    credentialId: manifest.credentialId,
    credentialOwnerUserId: manifest.credentialOwnerUserId,
    requestHash: manifest.requestHash,
    iat: Math.floor(now / 1_000),
    exp: Math.floor((now + MANAGED_UPLOAD_INTENT_TICKET_TTL_MS) / 1_000),
  };
  const encoded = Buffer.from(JSON.stringify(claims), "utf8").toString(
    "base64url",
  );
  const signature = signTicket(encoded, options.key).toString("base64url");
  return {
    ticket: `${TICKET_VERSION}.${encoded}.${signature}`,
    expiresAt: claims.exp * 1_000,
  };
}

export function openManagedUploadIntentTicket(
  raw: string,
  manifest: ManagedUploadIntentManifest,
  options: {
    now?: number;
    key?: Buffer<ArrayBufferLike>;
    allowExpired?: boolean;
  } = {},
) {
  if (!raw || raw !== raw.trim() || Buffer.byteLength(raw, "utf8") > 4_096) {
    throw new ManagedUploadIntentError(
      403,
      "UPLOAD_INTENT_INVALID",
      "上传凭证无效，请刷新页面后重试",
      false,
      "refresh_page",
    );
  }
  const [version, encoded, supplied, ...rest] = raw.split(".");
  if (version !== TICKET_VERSION || !encoded || !supplied || rest.length > 0) {
    throw new ManagedUploadIntentError(
      403,
      "UPLOAD_INTENT_INVALID",
      "上传凭证无效，请刷新页面后重试",
      false,
      "refresh_page",
    );
  }
  const expected = signTicket(encoded, options.key);
  const signature = Buffer.from(supplied, "base64url");
  if (
    signature.toString("base64url") !== supplied ||
    signature.length !== expected.length ||
    !timingSafeEqual(signature, expected)
  ) {
    throw new ManagedUploadIntentError(
      403,
      "UPLOAD_INTENT_INVALID",
      "上传凭证无效，请刷新页面后重试",
      false,
      "refresh_page",
    );
  }
  let claims: IntentTicketClaims;
  try {
    const bytes = Buffer.from(encoded, "base64url");
    if (bytes.toString("base64url") !== encoded)
      throw new Error("non-canonical");
    claims = JSON.parse(bytes.toString("utf8")) as IntentTicketClaims;
  } catch {
    throw new ManagedUploadIntentError(
      403,
      "UPLOAD_INTENT_INVALID",
      "上传凭证无效，请刷新页面后重试",
      false,
      "refresh_page",
    );
  }
  if (
    claims.v !== 1 ||
    claims.kind !== TICKET_KIND ||
    claims.intentId !== manifest.intentId ||
    claims.ownerUserId !== manifest.userId ||
    claims.projectAssignmentId !== manifest.projectAssignmentId ||
    claims.credentialId !== manifest.credentialId ||
    claims.credentialOwnerUserId !== manifest.credentialOwnerUserId ||
    claims.requestHash !== manifest.requestHash ||
    !Number.isSafeInteger(claims.iat) ||
    !Number.isSafeInteger(claims.exp) ||
    claims.exp <= claims.iat ||
    claims.exp - claims.iat >
      Math.ceil(MANAGED_UPLOAD_INTENT_TICKET_TTL_MS / 1_000)
  ) {
    throw new ManagedUploadIntentError(
      403,
      "UPLOAD_INTENT_INVALID",
      "上传凭证与当前文件不匹配",
      false,
      "refresh_page",
    );
  }
  if (
    !options.allowExpired &&
    claims.exp <= Math.floor((options.now ?? Date.now()) / 1_000)
  ) {
    throw new ManagedUploadIntentError(
      410,
      "UPLOAD_INTENT_EXPIRED",
      "本地上传凭证已过期，请重新选择文件",
      false,
      "refresh_page",
    );
  }
  return claims;
}

function validateCreateInput(input: CreateManagedUploadIntentInput) {
  if (
    !validIdentifier(input.operationId) ||
    !validIdentifier(input.batchId) ||
    !Number.isSafeInteger(input.ordinal) ||
    !Number.isSafeInteger(input.total) ||
    input.ordinal < 1 ||
    input.total < input.ordinal ||
    input.total > 1_000 ||
    !validIdentifier(input.filename, 512) ||
    input.filename.trim().length < 1 ||
    !validIdentifier(input.mimeType, 255) ||
    input.mimeType.trim().length < 1 ||
    !Number.isSafeInteger(input.sizeBytes) ||
    input.sizeBytes < 1 ||
    input.sizeBytes > MANAGED_UPLOAD_INTENT_MAX_BYTES ||
    !Number.isSafeInteger(input.userId) ||
    !validIdentifier(input.credentialId) ||
    !Number.isSafeInteger(input.credentialOwnerUserId) ||
    input.credentialOwnerUserId < 1 ||
    !Number.isSafeInteger(input.credentialVersion) ||
    !(
      input.resumeScope === undefined ||
      input.resumeScope === null ||
      (input.resumeScope.kind === "knowledge_base" &&
        validIdentifier(input.resumeScope.conversationId, 191) &&
        validIdentifier(input.resumeScope.turnId, 36) &&
        validIdentifier(input.resumeScope.clientRequestId, 191))
    )
  ) {
    throw new ManagedUploadIntentError(
      400,
      "INVALID_MANAGED_UPLOAD_REQUEST",
      "文件上传参数无效",
      false,
      "refresh_page",
    );
  }
}

async function assertStorageWritable(sizeBytes: number) {
  const root = managedUploadIntentStorageRoot();
  await ensurePrivateDirectory(root);
  const stats = await fs.statfs(root);
  const available = Number(stats.bavail) * Number(stats.bsize);
  if (
    !Number.isSafeInteger(available) ||
    available < sizeBytes + STORAGE_RESERVE_BYTES
  ) {
    throw new ManagedUploadIntentError(
      507,
      "UPLOAD_STORAGE_UNAVAILABLE",
      "Dashboard 本地暂存空间不足，请联系管理员",
      false,
      "contact_admin",
    );
  }
  const probe = path.join(root, `.${randomUUID()}.write-test`);
  const handle = await fs.open(probe, "wx", 0o600).catch(() => null);
  if (!handle) {
    throw new ManagedUploadIntentError(
      503,
      "UPLOAD_STORAGE_UNAVAILABLE",
      "Dashboard 本地暂存不可写，请联系管理员",
      false,
      "contact_admin",
    );
  }
  try {
    await handle.sync();
  } catch {
    throw new ManagedUploadIntentError(
      503,
      "UPLOAD_STORAGE_UNAVAILABLE",
      "Dashboard 本地暂存无法持久写入，请联系管理员",
      false,
      "contact_admin",
    );
  } finally {
    await handle.close().catch(() => undefined);
    await fs.rm(probe, { force: true }).catch(() => undefined);
    await fsyncDirectory(root).catch(() => undefined);
  }
  await fsyncDirectory(root);
}

async function findManagedUploadIntentsByOperation(input: {
  userId: number;
  projectAssignmentId: string | null;
  operationId: string;
}) {
  const root = managedUploadIntentStorageRoot();
  const entries = await fs
    .readdir(root, { withFileTypes: true })
    .catch((error) => {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    });
  const matches: ManagedUploadIntentManifest[] = [];
  for (const entry of entries) {
    if (
      !entry.isDirectory() ||
      entry.name === "by-operation" ||
      entry.name === "by-resume-scope" ||
      entry.name === "deletion-fences"
    ) {
      continue;
    }
    const raw = await fs.readFile(
      path.join(root, entry.name, "manifest.json"),
      "utf8",
    );
    const manifest = assertManifest(JSON.parse(raw));
    if (entry.name !== storageKey(manifest.intentId)) {
      throw new Error("MANAGED_UPLOAD_INTENT_DIRECTORY_MISMATCH");
    }
    if (
      manifest.userId === input.userId &&
      manifest.projectAssignmentId === input.projectAssignmentId &&
      manifest.operationId === input.operationId
    ) {
      matches.push(manifest);
    }
  }
  return matches;
}

function managedUploadScopes(input: {
  userId: number;
  credentialId: string;
  credentialOwnerUserId: number;
  projectAssignmentId?: string | null;
}): ManagedUploadFenceScope[] {
  return [
    { kind: "user", userId: input.userId },
    ...(input.credentialOwnerUserId !== input.userId
      ? [{ kind: "user" as const, userId: input.credentialOwnerUserId }]
      : []),
    {
      kind: "credential",
      userId: input.userId,
      credentialId: input.credentialId,
    },
    ...(input.projectAssignmentId
      ? [
          {
            kind: "project" as const,
            userId: input.userId,
            projectAssignmentId: input.projectAssignmentId,
          },
        ]
      : []),
  ];
}

async function acquireManagedUploadGuardsOrThrow(
  scopes: ManagedUploadFenceScope[],
  message: string,
) {
  try {
    return await acquireManagedUploadScopeGuards(scopes);
  } catch (error) {
    if (error instanceof ManagedUploadDeletionFenceError) {
      throw new ManagedUploadIntentError(
        409,
        "UPLOAD_IDENTITY_DELETION_IN_PROGRESS",
        message,
        false,
        "refresh_page",
      );
    }
    throw error;
  }
}

async function assertManagedUploadScopesAvailableOrThrow(
  scopes: ManagedUploadFenceScope[],
  message: string,
) {
  try {
    await assertManagedUploadScopesAvailable(scopes);
  } catch (error) {
    if (error instanceof ManagedUploadDeletionFenceError) {
      throw new ManagedUploadIntentError(
        410,
        "UPLOAD_IDENTITY_DELETION_IN_PROGRESS",
        message,
        false,
        "refresh_page",
      );
    }
    throw error;
  }
}

async function createManagedUploadIntentUnderOperationLock(
  input: CreateManagedUploadIntentInput,
) {
  validateCreateInput(input);
  const projectAssignmentId = input.projectAssignmentId ?? null;
  const hash = requestHash(input);
  const indexPath = operationIndexPath({
    userId: input.userId,
    projectAssignmentId,
    operationId: input.operationId,
  });
  await ensurePrivateDirectory(path.dirname(indexPath));
  const indexLock = `${indexPath}.lock`;
  const releaseOperationLock = await acquireOwnedFilesystemLock(
    indexLock,
    MANAGED_UPLOAD_OPERATION_LOCK_STALE_MS,
    40,
  );
  try {
    const existingIndex = await fs
      .readFile(indexPath, "utf8")
      .then(
        (value) =>
          JSON.parse(value) as {
            state?: unknown;
            intentId?: unknown;
            requestHash?: unknown;
          },
      )
      .catch((error) => {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
        throw error;
      });
    if (existingIndex) {
      if (existingIndex.state === "retired") {
        throw new ManagedUploadIntentError(
          410,
          "UPLOAD_OPERATION_RETIRED",
          "该上传操作已结束，请重新选择文件",
          false,
          "refresh_page",
        );
      }
      if (
        existingIndex.requestHash !== hash ||
        typeof existingIndex.intentId !== "string"
      ) {
        throw new ManagedUploadIntentError(
          409,
          "UPLOAD_OPERATION_CONFLICT",
          "同一上传操作已绑定不同文件",
          false,
          "refresh_page",
        );
      }
      const existing = await readManagedUploadIntent(existingIndex.intentId);
      if (!existing) throw new Error("MANAGED_UPLOAD_INTENT_INDEX_DANGLING");
      return existing;
    }
    // Reconcile the crash window where the durable manifest reached disk but
    // the operation index did not. Never allocate a second intent for the
    // same idempotency coordinate.
    const unindexed = await findManagedUploadIntentsByOperation({
      userId: input.userId,
      projectAssignmentId,
      operationId: input.operationId,
    });
    if (unindexed.length > 1) {
      throw new ManagedUploadIntentError(
        503,
        "UPLOAD_OPERATION_LEDGER_AMBIGUOUS",
        "上传操作账本存在冲突，请联系管理员",
        false,
        "contact_admin",
      );
    }
    if (unindexed[0]) {
      if (unindexed[0].requestHash !== hash) {
        throw new ManagedUploadIntentError(
          409,
          "UPLOAD_OPERATION_CONFLICT",
          "同一上传操作已绑定不同文件",
          false,
          "refresh_page",
        );
      }
      await writeJsonAtomic(indexPath, {
        schemaVersion: 1,
        intentId: unindexed[0].intentId,
        requestHash: hash,
      });
      await persistManagedUploadIntentDeletionAuthority(unindexed[0]);
      if (unindexed[0].resumeScope) {
        await appendManagedUploadResumeScopeIndex(unindexed[0]);
      }
      return unindexed[0];
    }
    await assertStorageWritable(input.sizeBytes);
    const timestamp = nowIso();
    const intentId = `mui_${randomUUID()}`;
    const manifest: ManagedUploadIntentManifest = {
      schemaVersion: input.resumeScope ? 2 : 1,
      intentId,
      operationId: input.operationId,
      requestHash: hash,
      batchId: input.batchId,
      ordinal: input.ordinal,
      total: input.total,
      resumeScope: input.resumeScope ?? null,
      userId: input.userId,
      projectAssignmentId,
      credentialId: input.credentialId,
      credentialOwnerUserId: input.credentialOwnerUserId,
      credentialVersion: input.credentialVersion,
      filename: input.filename.trim(),
      mimeType: input.mimeType.trim(),
      declaredSizeBytes: input.sizeBytes,
      sizeBytes: null,
      sha256: null,
      state: "awaiting_browser",
      phase: null,
      revision: 1,
      leaseOwner: null,
      leaseExpiresAt: null,
      providerGeneration: 0,
      provider: [],
      receipt: null,
      safeErrorCode: null,
      createdAt: timestamp,
      sealedAt: null,
      updatedAt: timestamp,
      completedAt: null,
      deletedAt: null,
    };
    await ensurePrivateDirectory(intentPaths(intentId).directory);
    await writeJsonAtomic(intentPaths(intentId).manifest, manifest);
    await writeJsonAtomic(indexPath, {
      schemaVersion: 1,
      intentId,
      requestHash: hash,
    });
    await persistManagedUploadIntentDeletionAuthority(manifest);
    if (manifest.resumeScope) {
      await appendManagedUploadResumeScopeIndex(manifest);
    }
    return manifest;
  } finally {
    await releaseOperationLock();
  }
}

async function appendManagedUploadResumeScopeIndex(
  manifest: ManagedUploadIntentManifest,
) {
  if (!manifest.resumeScope) return;
  const resumeIndex = resumeScopeIndexPath({
    userId: manifest.userId,
    projectAssignmentId: manifest.projectAssignmentId,
    resumeScope: manifest.resumeScope,
  });
  const lock = `${resumeIndex}.lock`;
  const release = await acquireOwnedFilesystemLock(
    lock,
    MANAGED_UPLOAD_OPERATION_LOCK_STALE_MS,
    40,
  );
  try {
    const current = await fs
      .readFile(resumeIndex, "utf8")
      .then((raw) => JSON.parse(raw) as { intentIds?: unknown })
      .catch((error) => {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
        throw error;
      });
    const intentIds = Array.isArray(current?.intentIds)
      ? current.intentIds.filter((id): id is string => validIdentifier(id))
      : [];
    await writeJsonAtomic(resumeIndex, {
      schemaVersion: 1,
      intentIds: [...new Set([...intentIds, manifest.intentId])],
      updatedAt: nowIso(),
    });
  } finally {
    await release();
  }
}

export async function createManagedUploadIntent(
  input: CreateManagedUploadIntentInput,
) {
  validateCreateInput(input);
  // The guard covers both allocation and idempotent replay. Otherwise an old
  // operation index could be replayed after account deletion established its
  // durable tombstone.
  const releaseScopes = await acquireManagedUploadGuardsOrThrow(
    managedUploadScopes(input),
    "账号、项目或上传凭证正在删除，不能创建或恢复上传",
  );
  try {
    return await createManagedUploadIntentUnderOperationLock(input);
  } finally {
    await releaseScopes();
  }
}

/**
 * Resolve a KB upload proof only through its exact durable operation index.
 * This deliberately does not use the directory reconciliation scan: callers
 * validating stage/dispatch authority must never adopt a fuzzy match.
 */
export async function readKnowledgeBaseManagedUploadIntentByOperation(input: {
  userId: number;
  projectAssignmentId?: string | null;
  operationId: string;
}): Promise<ManagedUploadIntentManifest | null> {
  if (
    !Number.isSafeInteger(input.userId) ||
    input.userId < 1 ||
    !validIdentifier(input.operationId)
  ) {
    throw new ManagedUploadIntentError(
      400,
      "INVALID_MANAGED_UPLOAD_REQUEST",
      "上传凭据查询参数无效",
      false,
      "refresh_page",
    );
  }
  await assertManagedUploadScopesAvailableOrThrow(
    [
      { kind: "user", userId: input.userId },
      ...(input.projectAssignmentId
        ? [
            {
              kind: "project" as const,
              userId: input.userId,
              projectAssignmentId: input.projectAssignmentId,
            },
          ]
        : []),
    ],
    "账号或项目已删除，旧上传操作不可恢复",
  );
  const projectAssignmentId = input.projectAssignmentId ?? null;
  const indexPath = operationIndexPath({
    userId: input.userId,
    projectAssignmentId,
    operationId: input.operationId,
  });
  const index = await fs
    .readFile(indexPath, "utf8")
    .then(
      (raw) =>
        JSON.parse(raw) as {
          state?: unknown;
          intentId?: unknown;
          requestHash?: unknown;
        },
    )
    .catch((error) => {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    });
  if (!index) return null;
  if (index.state === "retired") {
    throw new ManagedUploadIntentError(
      410,
      "UPLOAD_OPERATION_RETIRED",
      "该上传操作已结束",
      false,
      "refresh_page",
    );
  }
  if (
    typeof index.intentId !== "string" ||
    !validIdentifier(index.intentId) ||
    typeof index.requestHash !== "string" ||
    !/^[a-f0-9]{64}$/u.test(index.requestHash)
  ) {
    throw new Error("MANAGED_UPLOAD_INTENT_INDEX_INVALID");
  }
  const manifest = await readManagedUploadIntent(index.intentId);
  if (!manifest) throw new Error("MANAGED_UPLOAD_INTENT_INDEX_DANGLING");
  if (
    manifest.requestHash !== index.requestHash ||
    manifest.userId !== input.userId ||
    manifest.projectAssignmentId !== projectAssignmentId ||
    manifest.operationId !== input.operationId ||
    manifest.schemaVersion !== 2 ||
    manifest.resumeScope?.kind !== "knowledge_base"
  ) {
    throw new Error("MANAGED_UPLOAD_INTENT_INDEX_MISMATCH");
  }
  await assertManagedUploadScopesAvailableOrThrow(
    managedUploadScopes(manifest),
    "账号、项目或上传凭证已删除，旧上传操作不可恢复",
  );
  return manifest;
}

export type KnowledgeBaseManagedUploadStageProof = {
  intentId: string;
  operationId: string;
  fileId: string;
  filename: string;
  mimeType: string;
  bytes: Buffer;
  sizeBytes: number;
  sha256: string;
  storageDescriptor: {
    kind: "presales_file";
    fileId: string;
    filename: string;
    mimeType: string;
    sizeBytes: number;
    sha256: string;
    contentExpiresAt: Date | null;
  };
};

/**
 * Re-proves the complete browser-to-provider-to-retained-byte chain before a
 * KB attachment can be staged. The provider receipt is necessary but not
 * sufficient: the retained stream is read to EOF and rehashed on every proof.
 */
export async function proveKnowledgeBaseManagedUploadForStage(input: {
  userId: number;
  projectAssignmentId?: string | null;
  conversationId: string;
  turnId: string;
  clientRequestId: string;
  credential: { id: string; userId: number; version: number };
  manifestItem: {
    itemId: string;
    filename: string;
    mimeType: string;
    sizeBytes: number;
    sha256: string;
    ordinal?: number;
    total?: number;
  };
  index: number;
  total: number;
  fileId: string;
}): Promise<KnowledgeBaseManagedUploadStageProof> {
  const expectedOrdinal = input.index + 1;
  const expectedSha256 = input.manifestItem.sha256.toLowerCase();
  if (
    !Number.isSafeInteger(input.index) ||
    input.index < 0 ||
    !Number.isSafeInteger(input.total) ||
    input.total < 1 ||
    expectedOrdinal > input.total ||
    !validIdentifier(input.conversationId, 191) ||
    !validIdentifier(input.turnId, 36) ||
    !validIdentifier(input.clientRequestId, 191) ||
    !validIdentifier(input.credential.id) ||
    !Number.isSafeInteger(input.credential.userId) ||
    input.credential.userId < 1 ||
    !Number.isSafeInteger(input.credential.version) ||
    input.credential.version < 1 ||
    !validIdentifier(input.manifestItem.itemId) ||
    !validIdentifier(input.manifestItem.filename, 512) ||
    input.manifestItem.filename !== input.manifestItem.filename.trim() ||
    !validIdentifier(input.manifestItem.mimeType, 255) ||
    input.manifestItem.mimeType !== input.manifestItem.mimeType.trim() ||
    !Number.isSafeInteger(input.manifestItem.sizeBytes) ||
    input.manifestItem.sizeBytes < 1 ||
    !/^[a-f0-9]{64}$/u.test(expectedSha256) ||
    (input.manifestItem.ordinal !== undefined &&
      input.manifestItem.ordinal !== expectedOrdinal) ||
    (input.manifestItem.total !== undefined &&
      input.manifestItem.total !== input.total) ||
    !validIdentifier(input.fileId)
  ) {
    throw new ManagedUploadIntentError(
      400,
      "INVALID_MANAGED_UPLOAD_REQUEST",
      "知识库附件证明参数无效",
      false,
      "refresh_page",
    );
  }
  const manifest = await readKnowledgeBaseManagedUploadIntentByOperation({
    userId: input.userId,
    projectAssignmentId: input.projectAssignmentId,
    operationId: input.manifestItem.itemId,
  });
  const receipt = manifest?.receipt;
  const provider = manifest?.provider.find(
    (generation) => generation.generation === manifest.providerGeneration,
  );
  if (
    !manifest ||
    manifest.resumeScope?.conversationId !== input.conversationId ||
    manifest.resumeScope.turnId !== input.turnId ||
    manifest.resumeScope.clientRequestId !== input.clientRequestId ||
    manifest.credentialId !== input.credential.id ||
    manifest.credentialOwnerUserId !== input.credential.userId ||
    manifest.credentialVersion !== input.credential.version ||
    manifest.ordinal !== expectedOrdinal ||
    manifest.total !== input.total ||
    manifest.filename !== input.manifestItem.filename ||
    manifest.mimeType !== input.manifestItem.mimeType ||
    manifest.declaredSizeBytes !== input.manifestItem.sizeBytes ||
    manifest.sizeBytes !== input.manifestItem.sizeBytes ||
    manifest.sha256 !== expectedSha256 ||
    manifest.state !== "uploaded" ||
    !receipt ||
    receipt.fileId !== input.fileId ||
    receipt.sizeBytes !== input.manifestItem.sizeBytes ||
    !provider ||
    provider.state !== "uploaded" ||
    provider.fileId !== input.fileId ||
    !provider.filename ||
    provider.providerStatus !== "uploaded" ||
    provider.ownershipRecorded !== true ||
    provider.putResponse2xx !== true
  ) {
    throw new ManagedUploadIntentError(
      409,
      "UPLOAD_STAGE_PROOF_MISMATCH",
      "知识库附件与上传预约证明不一致",
      false,
      "refresh_page",
    );
  }
  const stored = await readStoredPresalesFile(input.fileId);
  if (
    !stored ||
    stored.filename !== provider.filename ||
    stored.mimeType !== input.manifestItem.mimeType ||
    stored.recordedSizeBytes !== input.manifestItem.sizeBytes ||
    stored.sizeBytes !== input.manifestItem.sizeBytes ||
    stored.sha256 !== expectedSha256
  ) {
    throw new ManagedUploadIntentError(
      409,
      "UPLOAD_STAGE_RETAINED_BYTES_MISMATCH",
      "Dashboard 留存文件与上传预约不一致",
      false,
      "refresh_page",
    );
  }
  const chunks: Buffer[] = [];
  const hash = createHash("sha256");
  let sizeBytes = 0;
  const stream = stored.createReadStream();
  try {
    for await (const rawChunk of stream) {
      const chunk = Buffer.isBuffer(rawChunk)
        ? rawChunk
        : Buffer.from(rawChunk as Uint8Array);
      sizeBytes += chunk.length;
      if (sizeBytes > input.manifestItem.sizeBytes) {
        throw new Error("MANAGED_UPLOAD_RETAINED_STREAM_OVERSIZE");
      }
      hash.update(chunk);
      chunks.push(chunk);
    }
  } catch (error) {
    stream.destroy();
    if (error instanceof ManagedUploadIntentError) throw error;
    throw new ManagedUploadIntentError(
      409,
      "UPLOAD_STAGE_RETAINED_BYTES_MISMATCH",
      "Dashboard 留存文件无法完成校验",
      false,
      "refresh_page",
    );
  }
  const sha256 = hash.digest("hex");
  if (sizeBytes !== input.manifestItem.sizeBytes || sha256 !== expectedSha256) {
    throw new ManagedUploadIntentError(
      409,
      "UPLOAD_STAGE_RETAINED_BYTES_MISMATCH",
      "Dashboard 留存文件字节校验失败",
      false,
      "refresh_page",
    );
  }
  const bytes = Buffer.concat(chunks, sizeBytes);
  return {
    intentId: manifest.intentId,
    operationId: manifest.operationId,
    fileId: input.fileId,
    filename: input.manifestItem.filename,
    mimeType: input.manifestItem.mimeType,
    bytes,
    sizeBytes,
    sha256,
    storageDescriptor: {
      kind: "presales_file",
      fileId: input.fileId,
      filename: input.manifestItem.filename,
      mimeType: input.manifestItem.mimeType,
      sizeBytes,
      sha256,
      contentExpiresAt: stored.contentExpiresAt,
    },
  };
}

export async function listManagedUploadIntentsByResumeScope(input: {
  userId: number;
  projectAssignmentId?: string | null;
  conversationId: string;
  turnId: string;
  credentialId?: string;
  credentialOwnerUserId?: number;
  credentialVersion?: number;
}) {
  const resumeScope: ManagedUploadResumeScope = {
    kind: "knowledge_base",
    conversationId: input.conversationId,
    turnId: input.turnId,
    // Not part of the index coordinate; each manifest carries the exact value.
    clientRequestId: "lookup",
  };
  if (
    !Number.isSafeInteger(input.userId) ||
    !validIdentifier(input.conversationId, 191) ||
    !validIdentifier(input.turnId, 36)
  ) {
    throw new ManagedUploadIntentError(
      400,
      "INVALID_MANAGED_UPLOAD_REQUEST",
      "上传恢复参数无效",
      false,
      "refresh_page",
    );
  }
  await assertManagedUploadScopesAvailableOrThrow(
    [
      { kind: "user", userId: input.userId },
      ...(input.projectAssignmentId
        ? [
            {
              kind: "project" as const,
              userId: input.userId,
              projectAssignmentId: input.projectAssignmentId,
            },
          ]
        : []),
    ],
    "账号或项目已删除，旧上传恢复入口不可用",
  );
  const indexPath = resumeScopeIndexPath({
    userId: input.userId,
    projectAssignmentId: input.projectAssignmentId ?? null,
    resumeScope,
  });
  const index = await fs
    .readFile(indexPath, "utf8")
    .then((raw) => JSON.parse(raw) as { intentIds?: unknown })
    .catch((error) => {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    });
  const intentIds = Array.isArray(index?.intentIds)
    ? index.intentIds.filter((id): id is string => validIdentifier(id))
    : [];
  if (!index || intentIds.length === 0) {
    // An existing scope under a different owner/project must be reported as
    // forbidden, not disguised as an empty successful discovery. Hashing the
    // owner into the normal index remains the fast path; this bounded scan is
    // used only for a miss and never returns another scope's metadata.
    const directory = path.join(
      managedUploadIntentStorageRoot(),
      "by-resume-scope",
    );
    const entries = await fs.readdir(directory).catch((error) => {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    });
    for (const entry of entries) {
      if (!entry.endsWith(".json")) continue;
      const foreign = await fs
        .readFile(path.join(directory, entry), "utf8")
        .then((raw) => JSON.parse(raw) as { intentIds?: unknown })
        .catch(() => null);
      const foreignIds = Array.isArray(foreign?.intentIds)
        ? foreign.intentIds.filter((id): id is string => validIdentifier(id))
        : [];
      for (const intentId of foreignIds) {
        const manifest = await readManagedUploadIntent(intentId);
        if (
          manifest?.resumeScope?.kind === "knowledge_base" &&
          manifest.resumeScope.conversationId === input.conversationId &&
          manifest.resumeScope.turnId === input.turnId &&
          (manifest.userId !== input.userId ||
            manifest.projectAssignmentId !==
              (input.projectAssignmentId ?? null))
        ) {
          throw new ManagedUploadIntentError(
            403,
            "UPLOAD_INTENT_FORBIDDEN",
            "上传记录不属于当前账号或项目",
            false,
            "refresh_page",
          );
        }
      }
    }
  }
  const manifests = (
    await Promise.all(
      intentIds.map((intentId) => readManagedUploadIntent(intentId)),
    )
  ).filter((manifest): manifest is ManagedUploadIntentManifest =>
    Boolean(manifest),
  );
  if (
    input.credentialId &&
    manifests.some(
      (manifest) =>
        manifest.credentialId !== input.credentialId ||
        manifest.credentialOwnerUserId !== input.credentialOwnerUserId ||
        manifest.credentialVersion !== input.credentialVersion,
    )
  ) {
    throw new ManagedUploadIntentError(
      403,
      "UPLOAD_INTENT_FORBIDDEN",
      "上传预约的固定凭证与当前知识库轮次不匹配",
      false,
      "refresh_page",
    );
  }
  for (const manifest of manifests) {
    await assertManagedUploadScopesAvailableOrThrow(
      managedUploadScopes(manifest),
      "账号、项目或上传凭证已删除，旧上传恢复入口不可用",
    );
  }
  return manifests
    .filter(
      (manifest) =>
        manifest.userId === input.userId &&
        manifest.projectAssignmentId === (input.projectAssignmentId ?? null) &&
        manifest.resumeScope?.kind === "knowledge_base" &&
        manifest.resumeScope.conversationId === input.conversationId &&
        manifest.resumeScope.turnId === input.turnId,
    )
    .sort((left, right) => left.ordinal - right.ordinal)
    .map((manifest) => {
      const resumeScope = manifest.resumeScope;
      if (!resumeScope) {
        throw new Error("MANAGED_UPLOAD_RESUME_SCOPE_MISSING");
      }
      const ticket = createManagedUploadIntentTicket(manifest);
      return {
        intentId: manifest.intentId,
        intentTicket: ticket.ticket,
        ticketExpiresAt: ticket.expiresAt,
        batchId: manifest.batchId,
        ordinal: manifest.ordinal,
        total: manifest.total,
        filename: manifest.filename,
        mimeType: manifest.mimeType,
        sizeBytes: manifest.declaredSizeBytes,
        state: manifest.state,
        phase: manifest.phase,
        receipt: manifest.receipt,
        clientRequestId: resumeScope.clientRequestId,
      };
    });
}

function assertIntentOwner(
  manifest: ManagedUploadIntentManifest,
  input: { userId: number; projectAssignmentId?: string | null },
) {
  if (
    manifest.userId !== input.userId ||
    manifest.projectAssignmentId !== (input.projectAssignmentId ?? null)
  ) {
    throw new ManagedUploadIntentError(
      403,
      "UPLOAD_INTENT_FORBIDDEN",
      "上传记录不属于当前账号或项目",
      false,
      "refresh_page",
    );
  }
}

async function acquireLease(
  intentId: string,
  owner: string,
  allowedStates: ManagedUploadIntentManifest["state"][],
) {
  return withIntentLock(intentId, async () => {
    let current = await readManagedUploadIntent(intentId);
    if (!current) {
      throw new ManagedUploadIntentError(
        404,
        "UPLOAD_INTENT_NOT_FOUND",
        "上传记录不存在",
        false,
        "refresh_page",
      );
    }
    const leaseActive =
      current.leaseOwner &&
      current.leaseOwner !== owner &&
      Date.parse(String(current.leaseExpiresAt)) > Date.now();
    // A cleanup request cannot revoke the authority of an in-flight worker:
    // that worker may still be inside a Provider call and must get one final
    // CAS to record any returned file identity. Its updateLeased fence then
    // persists cleanup_pending and stops before the next Provider step.
    if (leaseActive) return { state: "busy" as const, manifest: current };
    const cleanupRequested = await fs
      .stat(intentPaths(intentId).cleanupRequest)
      .then(() => true)
      .catch((error) => {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
        throw error;
      });
    if (
      cleanupRequested &&
      current.state !== "cancelled" &&
      current.state !== "cleanup_pending"
    ) {
      const timestamp = nowIso();
      current = {
        ...current,
        state: "cleanup_pending",
        phase: "cleanup_pending",
        safeErrorCode: "UPLOAD_CUSTOMER_CANCELLATION",
        revision: current.revision + 1,
        leaseOwner: null,
        leaseExpiresAt: null,
        updatedAt: timestamp,
      };
      await writeJsonAtomic(intentPaths(intentId).manifest, current);
    }
    if (!allowedStates.includes(current.state))
      return { state: "not_allowed" as const, manifest: current };
    const timestamp = nowIso();
    const next: ManagedUploadIntentManifest = {
      ...current,
      revision: current.revision + 1,
      leaseOwner: owner,
      leaseExpiresAt: new Date(
        Date.now() + MANAGED_UPLOAD_LEASE_MS,
      ).toISOString(),
      updatedAt: timestamp,
    };
    await writeJsonAtomic(intentPaths(intentId).manifest, next);
    return { state: "acquired" as const, manifest: next };
  });
}

async function updateLeased(
  previous: ManagedUploadIntentManifest,
  owner: string,
  update: (
    manifest: ManagedUploadIntentManifest,
  ) => Partial<ManagedUploadIntentManifest>,
) {
  return withIntentLock(previous.intentId, async () => {
    const current = await readManagedUploadIntent(previous.intentId);
    if (!current || current.revision !== previous.revision) {
      throw new ManagedUploadIntentError(
        409,
        "UPLOAD_INTENT_CONFLICT",
        "上传状态已由其他请求推进，请重新检查",
        true,
        "check_status",
      );
    }
    if (current.leaseOwner !== owner) {
      throw new ManagedUploadIntentError(
        409,
        "UPLOAD_INTENT_LEASE_LOST",
        "上传状态已由其他请求接管",
        true,
        "check_status",
      );
    }
    const delta = update(current);
    const cleanupRequested =
      current.state === "cleanup_pending"
        ? false
        : await fs
            .stat(intentPaths(current.intentId).cleanupRequest)
            .then(() => true)
            .catch((error) => {
              if ((error as NodeJS.ErrnoException).code === "ENOENT")
                return false;
              throw error;
            });
    if (cleanupRequested && delta.state !== "cancelled") {
      const next: ManagedUploadIntentManifest = {
        ...current,
        ...delta,
        state: "cleanup_pending",
        phase: "cleanup_pending",
        safeErrorCode: "UPLOAD_CUSTOMER_CANCELLATION",
        revision: current.revision + 1,
        leaseOwner: null,
        leaseExpiresAt: null,
        updatedAt: nowIso(),
      };
      await writeJsonAtomic(intentPaths(current.intentId).manifest, next);
      throw new ManagedUploadCleanupRequestedError();
    }
    const releasing = delta.leaseOwner === null;
    const next: ManagedUploadIntentManifest = {
      ...current,
      ...delta,
      revision: current.revision + 1,
      leaseOwner: releasing ? null : owner,
      leaseExpiresAt: releasing
        ? null
        : new Date(Date.now() + MANAGED_UPLOAD_LEASE_MS).toISOString(),
      updatedAt: nowIso(),
    };
    await writeJsonAtomic(intentPaths(current.intentId).manifest, next);
    return next;
  });
}

/**
 * Durably requests cleanup without waiting for Provider deletion. This is the
 * cancellation boundary used after a pristine KB start reservation has been
 * retired: the customer may immediately start over, while the existing
 * managed-upload worker remains responsible for every known Provider file.
 */
export async function scheduleManagedUploadIntentCleanup(input: {
  intentId: string;
  ticket: string;
  userId: number;
  projectAssignmentId?: string | null;
}) {
  return withIntentLock(input.intentId, async () => {
    const manifest = await readManagedUploadIntent(input.intentId);
    if (!manifest) {
      return { scheduled: true as const, state: "cancelled" as const };
    }
    assertIntentOwner(manifest, input);
    openManagedUploadIntentTicket(input.ticket, manifest, {
      allowExpired: true,
    });
    if (manifest.state === "cancelled") {
      await fs.rm(intentPaths(input.intentId).cleanupRequest, { force: true });
      return { scheduled: true as const, state: "cancelled" as const };
    }
    if (manifest.state === "cleanup_pending") {
      return { scheduled: true as const, state: "cleanup_pending" as const };
    }
    const leaseActive =
      Boolean(manifest.leaseOwner) &&
      Date.parse(String(manifest.leaseExpiresAt)) > Date.now();
    await writeJsonAtomic(intentPaths(input.intentId).cleanupRequest, {
      schemaVersion: 1,
      requestedAt: nowIso(),
    });
    const next: ManagedUploadIntentManifest = {
      ...manifest,
      state: leaseActive ? manifest.state : "cleanup_pending",
      phase: leaseActive ? manifest.phase : "cleanup_pending",
      safeErrorCode: leaseActive
        ? manifest.safeErrorCode
        : "UPLOAD_CUSTOMER_CANCELLATION",
      revision: manifest.revision + 1,
      leaseOwner: leaseActive ? manifest.leaseOwner : null,
      leaseExpiresAt: leaseActive ? manifest.leaseExpiresAt : null,
      updatedAt: nowIso(),
    };
    if (!leaseActive) {
      await writeJsonAtomic(intentPaths(input.intentId).manifest, next);
    }
    return {
      scheduled: true as const,
      state: leaseActive ? ("cleanup_pending" as const) : next.state,
    };
  });
}

async function releaseLease(
  previous: ManagedUploadIntentManifest,
  owner: string,
) {
  if (previous.leaseOwner !== owner) return previous;
  return updateLeased(previous, owner, () => ({
    leaseOwner: null,
    leaseExpiresAt: null,
  }));
}

async function hashManagedUploadContent(contentPath: string) {
  const hash = createHash("sha256");
  let sizeBytes = 0;
  const stream = createReadStream(contentPath);
  for await (const raw of stream) {
    const chunk = Buffer.isBuffer(raw) ? raw : Buffer.from(raw);
    sizeBytes += chunk.length;
    if (sizeBytes > MANAGED_UPLOAD_INTENT_MAX_BYTES) break;
    hash.update(chunk);
  }
  return { sizeBytes, sha256: hash.digest("hex") };
}

/**
 * Repairs the two durable ingress crash windows without ever contacting the
 * provider. A renamed `.content` is authoritative only after exact size/hash
 * verification; stale partial state is reset so the browser may send once
 * more. An active receiving lease is never disturbed.
 */
async function reconcileInterruptedIngress(
  manifest: ManagedUploadIntentManifest,
) {
  if (!["awaiting_browser", "receiving"].includes(manifest.state)) {
    return manifest;
  }
  if (
    manifest.state === "receiving" &&
    manifest.leaseOwner &&
    Date.parse(String(manifest.leaseExpiresAt)) > Date.now()
  ) {
    return manifest;
  }
  const paths = intentPaths(manifest.intentId);
  const [contentStats, partStats] = await Promise.all([
    fs.stat(paths.content).catch((error) => {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }),
    fs.stat(paths.part).catch((error) => {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }),
  ]);
  if (
    contentStats?.isFile() &&
    contentStats.size === manifest.declaredSizeBytes
  ) {
    const verified = await hashManagedUploadContent(paths.content);
    if (verified.sizeBytes === manifest.declaredSizeBytes) {
      const sealedAt = nowIso();
      return replaceManifest(manifest, (current) => ({
        ...current,
        state: "sealed",
        phase: "sealed",
        sizeBytes: verified.sizeBytes,
        sha256: verified.sha256,
        sealedAt,
        leaseOwner: null,
        leaseExpiresAt: null,
        safeErrorCode: null,
        revision: current.revision + 1,
        updatedAt: sealedAt,
      }));
    }
  }
  if (!contentStats && !partStats && manifest.state === "awaiting_browser") {
    return manifest;
  }
  // Invalid renamed content and stale partial bytes are never used for an
  // upstream side effect. Reset only after deletion has succeeded.
  await Promise.all([
    fs.rm(paths.content, { force: true }),
    fs.rm(paths.part, { force: true }),
  ]);
  return replaceManifest(manifest, (current) => ({
    ...current,
    state: "awaiting_browser",
    phase: null,
    sizeBytes: null,
    sha256: null,
    sealedAt: null,
    leaseOwner: null,
    leaseExpiresAt: null,
    safeErrorCode: "UPLOAD_BROWSER_BODY_INCOMPLETE",
    revision: current.revision + 1,
    updatedAt: nowIso(),
  }));
}

type ReceiveManagedUploadIntentBodyInput = {
  intentId: string;
  ticket: string;
  userId: number;
  projectAssignmentId?: string | null;
  contentLength: number;
  request: Pick<Request, "complete"> & AsyncIterable<unknown>;
  /** Test seam for storage failures after the receiving CAS. */
  onBeforePartOpen?: () => Promise<void>;
};

export async function receiveManagedUploadIntentBody(
  input: ReceiveManagedUploadIntentBodyInput,
) {
  const initial = await readManagedUploadIntent(input.intentId);
  if (!initial) {
    throw new ManagedUploadIntentError(
      404,
      "UPLOAD_INTENT_NOT_FOUND",
      "上传记录不存在",
      false,
      "refresh_page",
    );
  }
  assertIntentOwner(initial, input);
  const releaseScopes = await acquireManagedUploadGuardsOrThrow(
    managedUploadScopes(initial),
    "账号、项目或上传凭证正在删除，不能继续接收文件",
  );
  try {
    return await receiveManagedUploadIntentBodyUnderScopeGuard(input);
  } finally {
    await releaseScopes();
  }
}

async function receiveManagedUploadIntentBodyUnderScopeGuard(
  input: ReceiveManagedUploadIntentBodyInput,
) {
  let initial = await readManagedUploadIntent(input.intentId);
  if (!initial)
    throw new ManagedUploadIntentError(
      404,
      "UPLOAD_INTENT_NOT_FOUND",
      "上传记录不存在",
      false,
      "refresh_page",
    );
  assertIntentOwner(initial, input);
  openManagedUploadIntentTicket(input.ticket, initial);
  initial = await reconcileInterruptedIngress(initial);
  if (input.contentLength !== initial.declaredSizeBytes) {
    throw new ManagedUploadIntentError(
      400,
      "UPLOAD_CONTENT_LENGTH_MISMATCH",
      "文件大小与创建上传记录时不一致",
      false,
      "refresh_page",
    );
  }
  if (initial.state !== "awaiting_browser") {
    if (["sealed", "processing", "uploaded"].includes(initial.state)) {
      throw new ManagedUploadIntentError(
        409,
        "UPLOAD_BODY_ALREADY_RECEIVED",
        "Dashboard 已完整接收该文件，请检查云端状态",
        true,
        "check_status",
      );
    }
    throw new ManagedUploadIntentError(
      409,
      "UPLOAD_IN_PROGRESS",
      "该文件仍在上传处理中",
      true,
      "check_status",
    );
  }
  const owner = randomUUID();
  const acquired = await acquireLease(input.intentId, owner, [
    "awaiting_browser",
  ]);
  if (acquired.state !== "acquired") {
    throw new ManagedUploadIntentError(
      409,
      "UPLOAD_IN_PROGRESS",
      "该文件仍在上传处理中",
      true,
      "check_status",
    );
  }
  let manifest = await updateLeased(acquired.manifest, owner, () => ({
    state: "receiving",
    phase: "receiving",
  }));
  const paths = intentPaths(input.intentId);
  let handle: fs.FileHandle | null = null;
  const hash = createHash("sha256");
  let sizeBytes = 0;
  try {
    await input.onBeforePartOpen?.();
    handle = await fs.open(paths.part, "wx", 0o600).catch((error) => {
      throw new ManagedUploadIntentError(
        503,
        "UPLOAD_STORAGE_UNAVAILABLE",
        "Dashboard 本地暂存不可写，请联系管理员",
        false,
        "contact_admin",
      );
    });
    for await (const value of input.request) {
      const chunk = Buffer.isBuffer(value)
        ? value
        : Buffer.from(value as Uint8Array | string);
      sizeBytes += chunk.length;
      if (
        sizeBytes > initial.declaredSizeBytes ||
        sizeBytes > MANAGED_UPLOAD_INTENT_MAX_BYTES
      ) {
        throw new ManagedUploadIntentError(
          413,
          "UPLOAD_TOO_LARGE",
          "文件超过 100 MiB 限制",
          false,
          "refresh_page",
        );
      }
      let offset = 0;
      while (offset < chunk.length) {
        const written = await handle.write(
          chunk,
          offset,
          chunk.length - offset,
        );
        if (written.bytesWritten < 1) {
          throw new Error("MANAGED_UPLOAD_INTENT_SHORT_WRITE");
        }
        offset += written.bytesWritten;
      }
      hash.update(chunk);
    }
    if (!input.request.complete || sizeBytes !== initial.declaredSizeBytes) {
      throw new ManagedUploadIntentError(
        400,
        "UPLOAD_CONTENT_LENGTH_MISMATCH",
        "浏览器上传未完整结束，请重新发送该文件",
        true,
        "retry_same_file",
      );
    }
    await handle.sync();
    await handle.close();
    handle = null;
    await fs.rename(paths.part, paths.content);
    await fsyncDirectory(paths.directory);
    const sealedAt = nowIso();
    manifest = await updateLeased(manifest, owner, () => ({
      state: "sealed",
      phase: "sealed",
      sizeBytes,
      sha256: hash.digest("hex"),
      sealedAt,
      safeErrorCode: null,
    }));
    manifest = await releaseLease(manifest, owner);
    return manifest;
  } catch (error) {
    await handle?.close().catch(() => undefined);
    await fs.rm(paths.part, { force: true }).catch(() => undefined);
    const current = await readManagedUploadIntent(input.intentId).catch(
      () => null,
    );
    if (current?.leaseOwner === owner && current.state === "receiving") {
      await updateLeased(current, owner, () => ({
        state: "awaiting_browser",
        phase: null,
        leaseOwner: null,
        leaseExpiresAt: null,
        safeErrorCode: "UPLOAD_BROWSER_BODY_INCOMPLETE",
      })).catch(() => undefined);
    }
    throw error;
  }
}

function parseEpoch(value: unknown) {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value < 1_000_000_000_000 ? value * 1_000 : value;
  }
  if (typeof value !== "string" || !value.trim()) return null;
  const numeric = Number(value);
  if (Number.isFinite(numeric))
    return numeric < 1_000_000_000_000 ? numeric * 1_000 : numeric;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

export function parseManagedUploadSignedUrlExpiry(target: string) {
  const parsed = new URL(target);
  const signedAt = parsed.searchParams
    .get("X-Amz-Date")
    ?.match(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/u);
  const expires = parsed.searchParams.get("X-Amz-Expires");
  if (!signedAt || !expires || !/^\d+$/u.test(expires)) return null;
  const year = Number(signedAt[1]);
  const month = Number(signedAt[2]);
  const day = Number(signedAt[3]);
  const hour = Number(signedAt[4]);
  const minute = Number(signedAt[5]);
  const second = Number(signedAt[6]);
  const signedAtMs = Date.UTC(year, month - 1, day, hour, minute, second);
  const normalized = new Date(signedAtMs);
  if (
    normalized.getUTCFullYear() !== year ||
    normalized.getUTCMonth() !== month - 1 ||
    normalized.getUTCDate() !== day ||
    normalized.getUTCHours() !== hour ||
    normalized.getUTCMinutes() !== minute ||
    normalized.getUTCSeconds() !== second
  ) {
    return null;
  }
  const seconds = Number(expires);
  return Number.isSafeInteger(seconds) ? signedAtMs + seconds * 1_000 : null;
}

function providerExpiry(target: string, explicit: unknown) {
  const candidates = [
    parseEpoch(explicit),
    parseManagedUploadSignedUrlExpiry(target),
  ].filter((value): value is number => value !== null);
  if (candidates.length < 1) {
    throw new ManagedUploadIntentError(
      502,
      "UPLOAD_PROVIDER_RESPONSE_INVALID",
      "云端上传地址缺少可靠过期时间",
      false,
      "contact_admin",
    );
  }
  return Math.min(...candidates);
}

async function createProviderFile(input: {
  apiKey: string;
  filename: string;
  signal?: AbortSignal;
}): Promise<ProviderCreateResult> {
  if (input.signal?.aborted) {
    throw input.signal.reason ?? new Error("Managed upload cancelled");
  }
  let created;
  try {
    created = await new ManusV2Client({
      baseUrl: getUpstreamBaseUrl(),
      apiKey: input.apiKey,
    }).createFile(input.filename);
  } catch (error) {
    if (input.signal?.aborted) {
      throw input.signal.reason ?? new Error("Managed upload cancelled");
    }
    if (
      error instanceof ManusV2ApiError &&
      error.retryable &&
      !error.outcomeUnknown
    ) {
      throw new ManagedUploadIntentError(
        503,
        "UPLOAD_PROVIDER_CREATE_RETRYABLE",
        "云端暂未接受文件记录创建，Dashboard 将稍后重试",
        true,
        "check_status",
        error.retryAfterMs ?? 3_000,
      );
    }
    if (
      error instanceof ManusV2ApiError &&
      !error.outcomeUnknown &&
      !error.retryable
    ) {
      throw new ManagedUploadIntentError(
        502,
        "UPLOAD_PROVIDER_CREATE_REJECTED",
        "云端拒绝创建文件记录，请联系管理员",
        false,
        "contact_admin",
      );
    }
    throw new ManagedUploadIntentError(
      503,
      "UPLOAD_PROVIDER_CREATE_UNKNOWN",
      "云端文件记录创建结果未知，Dashboard 将安全恢复",
      true,
      "check_status",
    );
  }
  const fileId = created.fileId;
  const providerFilename = created.filename;
  const status = "pending";
  const rawTarget = created.uploadUrl;
  if (!validIdentifier(fileId)) {
    // A successful response without an identity may have created a record,
    // but Dashboard cannot address or clean it. Treat the result as unknown
    // and apply the same 195-second generation fence.
    throw new ManagedUploadIntentError(
      503,
      "UPLOAD_PROVIDER_CREATE_UNKNOWN",
      "云端文件记录创建结果未知，Dashboard 将安全恢复",
      true,
      "check_status",
    );
  }
  // Once a valid identity is returned it must escape this function even when
  // the one-shot capability is malformed. The caller first persists/owns the
  // identity and can then durably discard it; throwing here would create an
  // addressable but untracked provider orphan.
  const filename = validIdentifier(providerFilename, 512)
    ? providerFilename
    : input.filename;
  const statusAccepted = status === "pending";
  let uploadUrl: string | null = null;
  let uploadExpiresAt: number | null = null;
  let capabilityErrorCode: string | null = null;
  try {
    uploadUrl = assertSafeExternalUrl(rawTarget);
    if (new URL(uploadUrl).protocol !== "https:") throw new Error("not https");
  } catch {
    uploadUrl = null;
    capabilityErrorCode = "UPLOAD_PROVIDER_RESPONSE_INVALID";
  }
  if (!validIdentifier(providerFilename, 512) || !statusAccepted) {
    capabilityErrorCode = "UPLOAD_PROVIDER_RESPONSE_INVALID";
  }
  if (uploadUrl) {
    try {
      uploadExpiresAt = providerExpiry(uploadUrl, created.uploadExpiresAt);
      if (uploadExpiresAt - Date.now() < MANAGED_UPLOAD_PROVIDER_MIN_TTL_MS) {
        capabilityErrorCode = "UPLOAD_PROVIDER_CAPABILITY_EXPIRED";
      }
    } catch {
      capabilityErrorCode = "UPLOAD_PROVIDER_RESPONSE_INVALID";
    }
  }
  if (capabilityErrorCode) {
    uploadUrl = null;
    uploadExpiresAt = null;
  }
  return {
    fileId,
    filename,
    status: statusAccepted ? status : "invalid",
    uploadUrl,
    uploadExpiresAt,
    capabilityErrorCode,
  };
}

async function putProviderContent(input: {
  target: string;
  expiresAt: number;
  contentPath: string;
  sizeBytes: number;
  mimeType: string;
  signal?: AbortSignal;
}) {
  const startedAt = Date.now();
  const ttlAtStartMs = input.expiresAt - startedAt;
  const remaining = managedUploadProviderPutDeadlineMs(
    input.expiresAt,
    startedAt,
  );
  if (remaining < 1) {
    return {
      status: null as number | null,
      unknown: false,
      expired: true,
      bytesForwarded: 0,
      requestBodyComplete: false,
      ttlAtStartMs,
    };
  }
  const timeout = remaining;
  const deadlineSignal = AbortSignal.timeout(timeout);
  const requestSignal = input.signal
    ? AbortSignal.any([input.signal, deadlineSignal])
    : deadlineSignal;
  const stream = createReadStream(input.contentPath);
  let bytesForwarded = 0;
  let requestBodyComplete = false;
  stream.on("data", (chunk: Buffer | string) => {
    bytesForwarded += Buffer.byteLength(chunk);
  });
  stream.once("end", () => {
    requestBodyComplete = bytesForwarded === input.sizeBytes;
  });
  try {
    const response = await axios.put(input.target, stream, {
      ...safeExternalRequestOptions,
      headers: {
        "Content-Type": input.mimeType,
        "Content-Length": String(input.sizeBytes),
      },
      // Axios' timeout is an inactivity timer. The AbortSignal above is the
      // authoritative absolute deadline bounded by provider expiry - 5s.
      timeout: 0,
      maxRedirects: 0,
      maxBodyLength: input.sizeBytes,
      maxContentLength: 1024 * 1024,
      signal: requestSignal,
      validateStatus: () => true,
    });
    return {
      status: response.status,
      unknown: !requestBodyComplete,
      expired: false,
      bytesForwarded,
      requestBodyComplete,
      ttlAtStartMs,
    };
  } catch {
    return {
      status: null as number | null,
      unknown: true,
      expired:
        Date.now() >= input.expiresAt - MANAGED_UPLOAD_PROVIDER_SAFETY_MS,
      bytesForwarded,
      requestBodyComplete,
      ttlAtStartMs,
    };
  } finally {
    stream.destroy();
  }
}

export function managedUploadProviderPutDeadlineMs(
  expiresAt: number,
  now = Date.now(),
) {
  return Math.max(
    0,
    Math.min(
      MANAGED_UPLOAD_PROVIDER_PUT_MAX_MS,
      expiresAt - MANAGED_UPLOAD_PROVIDER_SAFETY_MS - now,
    ),
  );
}

async function providerMetadata(input: {
  apiKey: string;
  fileId: string;
  filename: string;
  signal?: AbortSignal;
}) {
  return checkUpstreamFileReadiness({
    baseUrl: getUpstreamBaseUrl(),
    apiKey: input.apiKey,
    file: { fileId: input.fileId, filename: input.filename },
    filenamePolicy: "provider_authoritative",
    signal: input.signal,
  });
}

async function proveProviderContent(input: {
  apiKey: string;
  fileId: string;
  sizeBytes: number;
  sha256: string;
  signal?: AbortSignal;
}) {
  if (input.signal?.aborted) {
    throw input.signal.reason ?? new Error("Managed upload cancelled");
  }
  // Manus v2 exposes metadata, not an authenticated /content endpoint. The
  // sealed Dashboard bytes (and their SHA-256 above) remain authoritative;
  // the provider lease is accepted only when v2 reports uploaded with the
  // exact byte count for this one locally owned PUT.
  let detail;
  try {
    detail = await new ManusV2Client({
      baseUrl: getUpstreamBaseUrl(),
      apiKey: input.apiKey,
    }).fileDetail(input.fileId);
  } catch {
    throw new ManagedUploadIntentError(
      503,
      "UPLOAD_PROVIDER_PROOF_UNAVAILABLE",
      "暂时无法核验云端文件记录",
      true,
      "check_status",
    );
  }
  if (detail.status !== "uploaded" || detail.bytes !== input.sizeBytes) {
    throw new ManagedUploadIntentError(
      409,
      "UPLOAD_PROVIDER_IDENTITY_MISMATCH",
      "云端文件记录与 Dashboard 本地副本不一致",
      false,
      "contact_admin",
    );
  }
  // Keep the hash parameter intentional: callers must already have a sealed
  // local integrity record before a provider lease can be proven.
  if (!/^[a-f0-9]{64}$/u.test(input.sha256)) {
    throw new ManagedUploadIntentError(
      409,
      "UPLOAD_PROVIDER_IDENTITY_MISMATCH",
      "Dashboard 本地文件完整性记录无效",
      false,
      "contact_admin",
    );
  }
}

function generationRecord(generation: 1 | 2): ProviderGeneration {
  return {
    generation,
    state: "not_sent",
    ownershipRecorded: false,
    createStartedAt: null,
    createUnknownAt: null,
    retryNotBefore: null,
    fileId: null,
    filename: null,
    providerStatus: null,
    uploadExpiresAt: null,
    putStartedAt: null,
    putReplayed: false,
    putResponse2xx: false,
    updatedAt: nowIso(),
  };
}

async function ensureGenerationOwnership(input: {
  manifest: ManagedUploadIntentManifest;
  owner: string;
  generation: ProviderGeneration;
}) {
  if (!input.generation.fileId || input.generation.ownershipRecorded) {
    return input.manifest;
  }
  const resource = await recordUpstreamResource({
    userId: input.manifest.userId,
    apiCredentialId: input.manifest.credentialId,
    kind: "file",
    upstreamId: input.generation.fileId,
    projectAssignmentId: input.manifest.projectAssignmentId,
  });
  if (resource.apiCredentialId !== input.manifest.credentialId) {
    // recordUpstreamResource intentionally preserves legacy same-scope
    // idempotency. Managed intents are stricter: a provider identity collision
    // across frozen credentials must never authorize a PUT.
    throw new ManagedUploadIntentError(
      409,
      "UPLOAD_PROVIDER_CREDENTIAL_IDENTITY_MISMATCH",
      "云端文件记录与上传凭证身份不一致",
      false,
      "contact_admin",
    );
  }
  return updateLeased(input.manifest, input.owner, (current) => ({
    provider: replaceGeneration(current, input.generation.generation, {
      ownershipRecorded: true,
    }),
  }));
}

function replaceGeneration(
  manifest: ManagedUploadIntentManifest,
  generation: number,
  update: Partial<ProviderGeneration>,
) {
  return manifest.provider.map((item) =>
    item.generation === generation
      ? { ...item, ...update, updatedAt: nowIso() }
      : item,
  );
}

function currentGeneration(manifest: ManagedUploadIntentManifest) {
  return (
    manifest.provider.find(
      (item) => item.generation === manifest.providerGeneration,
    ) ?? null
  );
}

async function discardKnownProvider(input: {
  manifest: ManagedUploadIntentManifest;
  apiKey: string;
  owner: string;
}) {
  const generation = currentGeneration(input.manifest);
  if (!generation?.fileId) return input.manifest;
  return discardProviderGeneration({
    ...input,
    generation: generation.generation,
    removeStoredCopy: false,
  });
}

async function providerFileIsMissing(input: {
  apiKey: string;
  fileId: string;
}) {
  try {
    const detail = await new ManusV2Client({
      baseUrl: getUpstreamBaseUrl(),
      apiKey: input.apiKey,
    }).fileDetail(input.fileId);
    return detail.status === "deleted";
  } catch (error) {
    if (error instanceof ManusV2ApiError && error.status === 404) return true;
    throw new ManagedUploadIntentError(
      503,
      "UPLOAD_PROVIDER_DISCARD_PROOF_UNAVAILABLE",
      "暂时无法核验旧云端文件记录是否已移除",
      true,
      "check_status",
    );
  }
}

/**
 * Durable, crash-reentrant provider discard. `discard_sending` is written
 * before the provider/DB/filesystem transaction. If that transaction commits
 * and the process dies before the final manifest CAS, the missing ownership
 * row is accepted only together with an official provider 404 proof.
 */
async function discardProviderGeneration(input: {
  manifest: ManagedUploadIntentManifest;
  apiKey: string;
  owner: string;
  generation: 1 | 2;
  removeStoredCopy: boolean;
}) {
  let manifest = input.manifest;
  let generation = manifest.provider.find(
    (item) => item.generation === input.generation,
  );
  if (!generation?.fileId || generation.state === "discarded") return manifest;
  if (generation.state !== "discard_sending") {
    manifest = await updateLeased(manifest, input.owner, (current) => ({
      provider: replaceGeneration(current, input.generation, {
        state: "discard_sending",
      }),
    }));
    generation = manifest.provider.find(
      (item) => item.generation === input.generation,
    );
  }
  const fileId = generation!.fileId!;
  let discarded: { discarded: boolean };
  try {
    discarded = await discardUnboundUpstreamFile({
      userId: manifest.userId,
      fileId,
      projectAssignmentId: manifest.projectAssignmentId ?? undefined,
      discard: async (context) => {
        try {
          await new ManusV2Client({
            baseUrl: getUpstreamBaseUrl(),
            apiKey: context.apiKey,
          }).deleteFile(fileId);
        } catch (error) {
          if (!(error instanceof ManusV2ApiError && error.status === 404)) {
            throw new Error("PROVIDER_DISCARD_FAILED");
          }
        }
        if (input.removeStoredCopy) {
          await removeStoredPresalesFile(fileId);
        }
      },
    });
  } catch (error) {
    if (error instanceof AuthServiceError && error.code === "CONFLICT") {
      throw new ManagedUploadIntentError(
        409,
        "UPLOAD_ALREADY_BOUND",
        "文件已被会话或知识库引用，不能移除",
        false,
        "refresh_page",
      );
    }
    throw new ManagedUploadIntentError(
      503,
      "UPLOAD_PROVIDER_DISCARD_FAILED",
      "旧云端文件记录暂时无法安全移除",
      true,
      "check_status",
    );
  }
  if (!discarded.discarded) {
    // The ownership row may be absent only because a previous discard fully
    // committed before the process wrote `discarded`. Never infer deletion
    // from the missing row alone.
    if (!(await providerFileIsMissing({ apiKey: input.apiKey, fileId }))) {
      throw new ManagedUploadIntentError(
        503,
        "UPLOAD_PROVIDER_DISCARD_FAILED",
        "旧云端文件记录仍存在但所有权证明缺失",
        false,
        "contact_admin",
      );
    }
    if (input.removeStoredCopy) {
      await removeStoredPresalesFile(fileId);
    }
  }
  return updateLeased(manifest, input.owner, (current) => ({
    provider: replaceGeneration(current, input.generation, {
      state: "discarded",
      ownershipRecorded: false,
    }),
  }));
}

async function completeIntentCleanup(input: {
  manifest: ManagedUploadIntentManifest;
  owner: string;
  apiKey: string;
}) {
  let manifest = input.manifest;
  for (const generation of [...manifest.provider].reverse()) {
    if (!generation.fileId || generation.state === "discarded") continue;
    manifest = await discardProviderGeneration({
      manifest,
      owner: input.owner,
      apiKey: input.apiKey,
      generation: generation.generation,
      removeStoredCopy: true,
    });
  }
  const paths = intentPaths(manifest.intentId);
  // Removing the durable request before the terminal CAS prevents the
  // updateLeased cancellation fence from recursively re-scheduling the
  // cleanup which this worker has just completed. A crash before that CAS is
  // still safe: the manifest remains cleanup_pending and the next worker
  // repeats the idempotent local/provider cleanup.
  await fs.rm(paths.cleanupRequest, { force: true });
  await fsyncDirectory(paths.directory);
  await Promise.all([
    fs.rm(paths.part, { force: true }),
    fs.rm(paths.content, { force: true }),
  ]);
  await fsyncDirectory(paths.directory);
  return updateLeased(manifest, input.owner, () => ({
    state: "cancelled",
    phase: null,
    leaseOwner: null,
    leaseExpiresAt: null,
    receipt: null,
    deletedAt: nowIso(),
    safeErrorCode: null,
  }));
}

async function assertProviderGenerationUnbound(input: {
  manifest: ManagedUploadIntentManifest;
  generation: ProviderGeneration;
}) {
  if (!input.generation.fileId) return;
  const proven = new Error("MANAGED_UPLOAD_UNBOUND_PREFLIGHT_PROVEN");
  try {
    const result = await discardUnboundUpstreamFile({
      userId: input.manifest.userId,
      fileId: input.generation.fileId,
      projectAssignmentId: input.manifest.projectAssignmentId ?? undefined,
      // Throwing from inside the locked transaction proves all durable bind
      // checks passed while forcing the transaction to roll back before any
      // provider callback or ownership deletion.
      discard: async () => {
        throw proven;
      },
    });
    if (!result.discarded) {
      throw new ManagedUploadIntentError(
        503,
        "UPLOAD_PROVIDER_OWNERSHIP_MISSING",
        "文件所有权证明缺失，不能安全移除",
        false,
        "contact_admin",
      );
    }
  } catch (error) {
    if (error === proven) return;
    if (error instanceof ManagedUploadIntentError) throw error;
    if (error instanceof AuthServiceError && error.code === "CONFLICT") {
      throw new ManagedUploadIntentError(
        409,
        "UPLOAD_ALREADY_BOUND",
        "文件已被会话或知识库引用，不能移除",
        false,
        "refresh_page",
      );
    }
    throw error;
  }
}

async function finalizeIntent(input: {
  manifest: ManagedUploadIntentManifest;
  owner: string;
  apiKey: string;
  traceId: string;
  authoritativeFilename: string;
}) {
  const generation = currentGeneration(input.manifest);
  if (
    !generation?.fileId ||
    input.manifest.sizeBytes === null ||
    !input.manifest.sha256
  ) {
    throw new Error("MANAGED_UPLOAD_INTENT_FINALIZE_INVALID");
  }
  const fileId = generation.fileId;
  const sizeBytes = input.manifest.sizeBytes;
  const sha256 = input.manifest.sha256;
  let manifest = await updateLeased(input.manifest, input.owner, () => ({
    state: "processing",
    phase: "finalizing",
  }));
  const uploadedAt = new Date();
  const localContentExpiresAt = new Date(
    uploadedAt.getTime() + MANAGED_UPLOAD_INTENT_SEALED_RETENTION_MS,
  );
  // Bytes become durable in the final file-id namespace before the database
  // advertises uploaded retention. A crash here is safe to replay: the
  // hard-link installer verifies the existing size/hash.
  await installStoredPresalesFileFromPath({
    fileId,
    sourcePath: intentPaths(manifest.intentId).content,
    filename: input.authoritativeFilename,
    mimeType: manifest.mimeType,
    sizeBytes,
    sha256,
    uploadedAt,
    contentExpiresAt: localContentExpiresAt,
  });
  const retention = await markUploadedFileRetention({
    userId: manifest.userId,
    fileId,
    uploadedAt,
  });
  if (!retention.contentExpiresAt) {
    throw new Error("MANAGED_UPLOAD_INTENT_RETENTION_INVALID");
  }
  const receipt: Omit<ManagedUploadIntentReceipt, "traceId"> = {
    fileId,
    sizeBytes,
    uploadedAt: uploadedAt.getTime(),
    providerReadyAt: Date.now(),
    expiresAt: retention.contentExpiresAt.getTime(),
    replayed: manifest.provider.some((item) => item.putReplayed),
    recreated: manifest.providerGeneration === 2,
  };
  // Persist the final receipt while still reporting `processing/finalizing`.
  // Only after the source hard-link is removed may the intent advertise
  // uploaded; otherwise a crash would retain a second inode link forever and
  // outlive the final content retention record.
  manifest = await updateLeased(manifest, input.owner, (current) => ({
    state: "processing",
    phase: "finalizing",
    provider: replaceGeneration(current, generation.generation, {
      state: "uploaded",
      providerStatus: "uploaded",
      filename: input.authoritativeFilename,
    }),
    receipt,
    safeErrorCode: null,
  }));
  await fs.rm(intentPaths(manifest.intentId).content, { force: true });
  await fsyncDirectory(intentPaths(manifest.intentId).directory);
  manifest = await updateLeased(manifest, input.owner, () => ({
    state: "uploaded",
    phase: null,
    completedAt: nowIso(),
  }));
  manifest = await releaseLease(manifest, input.owner);
  return manifest;
}

function statusFromManifest(
  manifest: ManagedUploadIntentManifest,
  traceId: string,
): ManagedUploadIntentStatus {
  if (manifest.state === "uploaded" && manifest.receipt) {
    return {
      state: "uploaded",
      intentId: manifest.intentId,
      ...manifest.receipt,
      traceId,
    };
  }
  if (manifest.state === "awaiting_browser" || manifest.state === "receiving") {
    return manifest.state === "awaiting_browser"
      ? {
          state: "needs_browser_body",
          intentId: manifest.intentId,
          retryable: true,
          traceId,
        }
      : {
          state: "processing",
          phase: "receiving",
          intentId: manifest.intentId,
          sizeBytes: manifest.declaredSizeBytes,
          retryAfterMs: 3_000,
          traceId,
        };
  }
  return {
    state: "processing",
    phase:
      manifest.phase ??
      (manifest.state === "sealed" ? "sealed" : "waiting_provider"),
    intentId: manifest.intentId,
    sizeBytes: manifest.sizeBytes ?? manifest.declaredSizeBytes,
    retryAfterMs: 3_000,
    traceId,
  };
}

type ProcessManagedUploadIntentInput = {
  intentId: string;
  userId: number;
  projectAssignmentId?: string | null;
  traceId: string;
  signal?: AbortSignal;
};

export async function processManagedUploadIntent(
  input: ProcessManagedUploadIntentInput,
): Promise<ManagedUploadIntentStatus> {
  const initial = await readManagedUploadIntent(input.intentId);
  if (!initial) {
    throw new ManagedUploadIntentError(
      404,
      "UPLOAD_INTENT_NOT_FOUND",
      "上传记录不存在",
      false,
      "refresh_page",
    );
  }
  assertIntentOwner(initial, input);
  if (
    initial.state === "cleanup_pending" &&
    [
      "UPLOAD_ACCOUNT_DELETED",
      "UPLOAD_ACCOUNT_DELETION_CLEANUP_PENDING",
    ].includes(initial.safeErrorCode ?? "")
  ) {
    throw new ManagedUploadIntentError(
      410,
      "UPLOAD_INTENT_CANCELLED",
      "上传记录已由账号删除或知识库重置永久退休",
      false,
      "refresh_page",
    );
  }
  await assertManagedUploadScopesAvailableOrThrow(
    managedUploadScopes(initial),
    "账号、项目或上传凭证正在删除，云端上传已终止",
  );
  if (
    initial.leaseOwner &&
    initial.leaseExpiresAt &&
    Date.parse(initial.leaseExpiresAt) > Date.now()
  ) {
    return statusFromManifest(initial, input.traceId);
  }
  // Hold the same locks deletion must acquire across Provider create/PUT,
  // ownership recording and the final manifest CAS. Deletion therefore
  // happens entirely before or entirely after a side effect, never between
  // the remote response and its durable local result.
  const releaseScopes = await acquireManagedUploadGuardsOrThrow(
    managedUploadScopes(initial),
    "账号、项目或上传凭证正在删除，云端上传已终止",
  );
  try {
    return await processManagedUploadIntentUnderScopeGuard(input);
  } finally {
    await releaseScopes();
  }
}

async function processManagedUploadIntentUnderScopeGuard(
  input: ProcessManagedUploadIntentInput,
): Promise<ManagedUploadIntentStatus> {
  let initial = await readManagedUploadIntent(input.intentId);
  if (!initial)
    throw new ManagedUploadIntentError(
      404,
      "UPLOAD_INTENT_NOT_FOUND",
      "上传记录不存在",
      false,
      "refresh_page",
    );
  assertIntentOwner(initial, input);
  initial = await reconcileInterruptedIngress(initial);
  if (initial.state === "uploaded")
    return statusFromManifest(initial, input.traceId);
  if (initial.state === "awaiting_browser" || initial.state === "receiving")
    return statusFromManifest(initial, input.traceId);
  if (initial.state === "cancelled")
    throw new ManagedUploadIntentError(
      410,
      "UPLOAD_INTENT_CANCELLED",
      "上传记录已取消",
      false,
      "refresh_page",
    );
  if (initial.state === "expired") {
    throw new ManagedUploadIntentError(
      410,
      "UPLOAD_LOCAL_COPY_EXPIRED_RECREATE_REQUIRED",
      "Dashboard 本地副本已超过保留期，请移除记录后重新选择文件",
      false,
      "discard_and_recreate",
    );
  }
  if (
    initial.state !== "cleanup_pending" &&
    (!initial.sealedAt ||
      initial.sizeBytes !== initial.declaredSizeBytes ||
      !initial.sha256)
  ) {
    throw new ManagedUploadIntentError(
      409,
      "UPLOAD_INTENT_NOT_SEALED",
      "Dashboard 尚未完整接收该文件",
      true,
      "retry_same_file",
    );
  }
  const owner = randomUUID();
  const acquired = await acquireLease(initial.intentId, owner, [
    "sealed",
    "processing",
    "cleanup_pending",
    "failed",
  ]);
  if (acquired.state === "busy")
    return statusFromManifest(acquired.manifest, input.traceId);
  if (acquired.state !== "acquired")
    return statusFromManifest(acquired.manifest, input.traceId);
  let manifest = acquired.manifest;
  try {
    await assertManagedUploadScopesAvailable(
      managedUploadScopes(manifest),
    ).catch((error) => {
      if (error instanceof ManagedUploadDeletionFenceError) {
        throw new ManagedUploadIntentError(
          409,
          "UPLOAD_IDENTITY_DELETION_IN_PROGRESS",
          "账号、项目或上传凭证正在删除，云端上传已暂停",
          true,
          "check_status",
        );
      }
      throw error;
    });
    const credential = await getDecryptedCredentialForManagedUploadIntent({
      credentialId: manifest.credentialId,
      credentialOwnerUserId: manifest.credentialOwnerUserId,
      credentialVersion: manifest.credentialVersion,
    });
    if (!credential) {
      throw new ManagedUploadIntentError(
        503,
        "UPLOAD_CREDENTIAL_UNAVAILABLE",
        "该上传绑定的原 API Key 已不可用",
        false,
        "contact_admin",
      );
    }
    if (manifest.state === "cleanup_pending") {
      manifest = await completeIntentCleanup({
        manifest,
        owner,
        apiKey: credential.apiKey,
      });
      return statusFromManifest(manifest, input.traceId);
    }
    if (
      manifest.state === "processing" &&
      manifest.phase === "finalizing" &&
      manifest.receipt &&
      currentGeneration(manifest)?.state === "uploaded"
    ) {
      await fs.rm(intentPaths(manifest.intentId).content, { force: true });
      await fsyncDirectory(intentPaths(manifest.intentId).directory);
      manifest = await updateLeased(manifest, owner, () => ({
        state: "uploaded",
        phase: null,
        completedAt: nowIso(),
      }));
      manifest = await releaseLease(manifest, owner);
      return statusFromManifest(manifest, input.traceId);
    }
    let generation = currentGeneration(manifest);
    if (!generation) {
      const next = generationRecord(1);
      manifest = await updateLeased(manifest, owner, () => ({
        state: "processing",
        phase: "creating_provider",
        providerGeneration: 1,
        provider: [next],
      }));
      generation = next;
    }

    if (generation.state === "create_sending") {
      const createStartedAt = generation.createStartedAt ?? nowIso();
      manifest = await updateLeased(manifest, owner, (current) => ({
        provider: replaceGeneration(current, generation!.generation, {
          state: "create_unknown",
          createUnknownAt: createStartedAt,
        }),
        phase: "waiting_provider",
        safeErrorCode: "UPLOAD_PROVIDER_CREATE_UNKNOWN",
      }));
      generation = currentGeneration(manifest)!;
    }

    if (generation.state === "create_rejected") {
      throw new ManagedUploadIntentError(
        502,
        manifest.safeErrorCode || "UPLOAD_PROVIDER_CREATE_REJECTED",
        "云端拒绝创建文件记录，请联系管理员",
        false,
        "contact_admin",
      );
    }

    if (generation.state === "put_rejected") {
      throw new ManagedUploadIntentError(
        502,
        manifest.safeErrorCode || "UPLOAD_PROVIDER_PUT_REJECTED",
        "云端明确拒绝文件内容上传，请联系管理员",
        false,
        "contact_admin",
      );
    }

    if (generation.state === "create_unknown") {
      const unknownAt = Date.parse(String(generation.createUnknownAt));
      if (
        !Number.isFinite(unknownAt) ||
        Date.now() < unknownAt + MANAGED_UPLOAD_CREATE_UNKNOWN_WAIT_MS
      ) {
        manifest = await releaseLease(manifest, owner);
        return statusFromManifest(manifest, input.traceId);
      }
      if (generation.generation === 2) {
        throw new ManagedUploadIntentError(
          503,
          "UPLOAD_PROVIDER_CREATE_UNKNOWN_FINAL",
          "两次云端文件记录创建结果均未知，请联系管理员",
          false,
          "contact_admin",
        );
      }
      const next = generationRecord(2);
      manifest = await updateLeased(manifest, owner, () => ({
        phase: "creating_provider",
        providerGeneration: 2,
        provider: [...manifest.provider, next],
      }));
      generation = next;
    }

    if (
      generation.state === "discard_sending" ||
      generation.state === "discarded"
    ) {
      if (generation.state === "discard_sending") {
        manifest = await discardKnownProvider({
          manifest,
          apiKey: credential.apiKey,
          owner,
        });
        generation = currentGeneration(manifest)!;
      }
      if (generation.generation === 1) {
        const next = generationRecord(2);
        manifest = await updateLeased(manifest, owner, () => ({
          phase: "creating_provider",
          providerGeneration: 2,
          provider: [...manifest.provider, next],
        }));
        generation = next;
      } else {
        throw new ManagedUploadIntentError(
          503,
          manifest.safeErrorCode || "UPLOAD_PROVIDER_CAPABILITY_LOST",
          "替代云端文件记录不可用，请联系管理员",
          false,
          "contact_admin",
        );
      }
    }

    let liveCapability: ProviderCreateResult | null = null;
    if (generation.state === "not_sent") {
      if (
        generation.retryNotBefore &&
        Date.parse(generation.retryNotBefore) > Date.now()
      ) {
        manifest = await releaseLease(manifest, owner);
        return statusFromManifest(manifest, input.traceId);
      }
      const createStartedAt = nowIso();
      manifest = await updateLeased(manifest, owner, (current) => ({
        state: "processing",
        phase: "creating_provider",
        provider: replaceGeneration(current, current.providerGeneration, {
          state: "create_sending",
          createStartedAt,
          retryNotBefore: null,
        }),
      }));
      try {
        liveCapability = await createProviderFile({
          apiKey: credential.apiKey,
          filename: manifest.filename,
          signal: input.signal,
        });
      } catch (error) {
        if (
          error instanceof ManagedUploadIntentError &&
          error.code === "UPLOAD_PROVIDER_CREATE_UNKNOWN"
        ) {
          manifest = await updateLeased(manifest, owner, (current) => ({
            provider: replaceGeneration(current, current.providerGeneration, {
              state: "create_unknown",
              createUnknownAt: nowIso(),
            }),
            phase: "waiting_provider",
            safeErrorCode: error.code,
          }));
          manifest = await releaseLease(manifest, owner);
          return statusFromManifest(manifest, input.traceId);
        }
        if (
          error instanceof ManagedUploadIntentError &&
          error.code === "UPLOAD_PROVIDER_CREATE_RETRYABLE"
        ) {
          manifest = await updateLeased(manifest, owner, (current) => ({
            provider: replaceGeneration(current, current.providerGeneration, {
              state: "not_sent",
              createStartedAt: null,
              retryNotBefore: new Date(
                Date.now() + (error.retryAfterMs ?? 3_000),
              ).toISOString(),
            }),
            phase: "creating_provider",
            safeErrorCode: error.code,
          }));
          manifest = await releaseLease(manifest, owner);
          return statusFromManifest(manifest, input.traceId);
        }
        if (error instanceof ManagedUploadIntentError && !error.retryable) {
          manifest = await updateLeased(manifest, owner, (current) => ({
            state: "failed",
            phase: null,
            provider: replaceGeneration(current, current.providerGeneration, {
              state: "create_rejected",
              createStartedAt: null,
            }),
            safeErrorCode: error.code,
          }));
          manifest = await releaseLease(manifest, owner);
        }
        throw error;
      }
      manifest = await updateLeased(manifest, owner, (current) => ({
        provider: replaceGeneration(current, current.providerGeneration, {
          state: "created",
          createStartedAt: null,
          retryNotBefore: null,
          fileId: liveCapability!.fileId,
          filename: liveCapability!.filename,
          providerStatus: liveCapability!.status,
          uploadExpiresAt:
            liveCapability!.uploadExpiresAt === null
              ? null
              : new Date(liveCapability!.uploadExpiresAt).toISOString(),
        }),
      }));
      generation = currentGeneration(manifest)!;
    }

    generation = currentGeneration(manifest)!;
    manifest = await ensureGenerationOwnership({
      manifest,
      owner,
      generation,
    });
    generation = currentGeneration(manifest)!;
    if (
      generation.fileId &&
      ["put_sending", "put_complete", "waiting", "put_unknown"].includes(
        generation.state,
      )
    ) {
      let providerRecordUnusable = false;
      try {
        const metadata = await providerMetadata({
          apiKey: credential.apiKey,
          fileId: generation.fileId,
          filename: generation.filename!,
          signal: input.signal,
        });
        if (metadata.state === "uploaded") {
          if (
            generation.state === "put_unknown" ||
            generation.state === "put_sending"
          ) {
            await proveProviderContent({
              apiKey: credential.apiKey,
              fileId: generation.fileId,
              sizeBytes: manifest.sizeBytes!,
              sha256: manifest.sha256!,
              signal: input.signal,
            });
          }
          return statusFromManifest(
            await finalizeIntent({
              manifest,
              owner,
              apiKey: credential.apiKey,
              traceId: input.traceId,
              authoritativeFilename: metadata.filename,
            }),
            input.traceId,
          );
        }
        if (
          generation.state === "put_complete" ||
          generation.state === "waiting"
        ) {
          manifest = await updateLeased(manifest, owner, (current) => ({
            phase: "waiting_provider",
            provider: replaceGeneration(current, generation!.generation, {
              state: "waiting",
              providerStatus: "pending",
            }),
          }));
          manifest = await releaseLease(manifest, owner);
          return statusFromManifest(manifest, input.traceId);
        }
      } catch (error) {
        if (error instanceof UpstreamFileReadinessError && error.retryable) {
          manifest = await releaseLease(manifest, owner);
          return statusFromManifest(manifest, input.traceId);
        }
        if (
          !(error instanceof UpstreamFileReadinessError) ||
          error.code !== "UPSTREAM_FILE_UNUSABLE"
        )
          throw error;
        providerRecordUnusable = true;
      }
      // A recovery process cannot reconstruct a lost signed URL. Safely remove
      // the known empty/pending record before the sole replacement.
      if (generation.generation === 1) {
        manifest = await discardKnownProvider({
          manifest,
          apiKey: credential.apiKey,
          owner,
        });
        const next = generationRecord(2);
        manifest = await updateLeased(manifest, owner, () => ({
          phase: "creating_provider",
          providerGeneration: 2,
          provider: [...manifest.provider, next],
        }));
        generation = next;
        liveCapability = null;
      } else if (
        providerRecordUnusable ||
        generation.state === "put_unknown" ||
        generation.state === "put_sending"
      ) {
        throw new ManagedUploadIntentError(
          503,
          providerRecordUnusable
            ? "UPLOAD_PROVIDER_RECREATE_EXHAUSTED"
            : "UPLOAD_PROVIDER_RESULT_UNKNOWN_FINAL",
          providerRecordUnusable
            ? "替代云端文件记录仍不可用，请联系管理员"
            : "云端上传结果仍未知，请联系管理员",
          false,
          "contact_admin",
        );
      }
    }

    generation = currentGeneration(manifest)!;
    if (generation.state === "not_sent") {
      // This only occurs after a safe generation-1 discard.
      if (
        generation.retryNotBefore &&
        Date.parse(generation.retryNotBefore) > Date.now()
      ) {
        manifest = await releaseLease(manifest, owner);
        return statusFromManifest(manifest, input.traceId);
      }
      const createStartedAt = nowIso();
      manifest = await updateLeased(manifest, owner, (current) => ({
        provider: replaceGeneration(current, current.providerGeneration, {
          state: "create_sending",
          createStartedAt,
          retryNotBefore: null,
        }),
      }));
      try {
        liveCapability = await createProviderFile({
          apiKey: credential.apiKey,
          filename: manifest.filename,
          signal: input.signal,
        });
      } catch (error) {
        if (
          error instanceof ManagedUploadIntentError &&
          error.code === "UPLOAD_PROVIDER_CREATE_UNKNOWN"
        ) {
          manifest = await updateLeased(manifest, owner, (current) => ({
            provider: replaceGeneration(current, current.providerGeneration, {
              state: "create_unknown",
              createUnknownAt: createStartedAt,
            }),
            phase: "waiting_provider",
            safeErrorCode: error.code,
          }));
          manifest = await releaseLease(manifest, owner);
          return statusFromManifest(manifest, input.traceId);
        }
        if (
          error instanceof ManagedUploadIntentError &&
          error.code === "UPLOAD_PROVIDER_CREATE_RETRYABLE"
        ) {
          manifest = await updateLeased(manifest, owner, (current) => ({
            provider: replaceGeneration(current, current.providerGeneration, {
              state: "not_sent",
              createStartedAt: null,
              retryNotBefore: new Date(
                Date.now() + (error.retryAfterMs ?? 3_000),
              ).toISOString(),
            }),
            safeErrorCode: error.code,
          }));
          manifest = await releaseLease(manifest, owner);
          return statusFromManifest(manifest, input.traceId);
        }
        if (error instanceof ManagedUploadIntentError && !error.retryable) {
          manifest = await updateLeased(manifest, owner, (current) => ({
            state: "failed",
            phase: null,
            provider: replaceGeneration(current, current.providerGeneration, {
              state: "create_rejected",
              createStartedAt: null,
            }),
            safeErrorCode: error.code,
          }));
          manifest = await releaseLease(manifest, owner);
        }
        throw error;
      }
      manifest = await updateLeased(manifest, owner, (current) => ({
        provider: replaceGeneration(current, current.providerGeneration, {
          state: "created",
          createStartedAt: null,
          retryNotBefore: null,
          fileId: liveCapability!.fileId,
          filename: liveCapability!.filename,
          providerStatus: liveCapability!.status,
          uploadExpiresAt:
            liveCapability!.uploadExpiresAt === null
              ? null
              : new Date(liveCapability!.uploadExpiresAt).toISOString(),
        }),
      }));
      manifest = await ensureGenerationOwnership({
        manifest,
        owner,
        generation: currentGeneration(manifest)!,
      });
      generation = currentGeneration(manifest)!;
    }

    if (generation.state === "created") {
      if (
        liveCapability?.fileId === generation.fileId &&
        liveCapability.capabilityErrorCode ===
          "UPLOAD_PROVIDER_RESPONSE_INVALID"
      ) {
        // A deterministic contract violation (missing/unknown status,
        // malformed filename or unsafe URL) will not improve by creating a
        // second record. Persist/own/discard the known identity, then stop.
        manifest = await discardKnownProvider({
          manifest,
          apiKey: credential.apiKey,
          owner,
        });
        manifest = await updateLeased(manifest, owner, () => ({
          state: "failed",
          phase: null,
          safeErrorCode: "UPLOAD_PROVIDER_RESPONSE_INVALID",
        }));
        manifest = await releaseLease(manifest, owner);
        throw new ManagedUploadIntentError(
          502,
          "UPLOAD_PROVIDER_RESPONSE_INVALID",
          "云端文件记录响应不符合官方合同，请联系管理员",
          false,
          "contact_admin",
        );
      }
      if (
        !liveCapability ||
        liveCapability.fileId !== generation.fileId ||
        liveCapability.uploadUrl === null ||
        liveCapability.uploadExpiresAt === null ||
        liveCapability.capabilityErrorCode !== null
      ) {
        // The process crashed after persisting the provider record and before
        // completing the PUT; the URL is deliberately not durable.
        if (generation.generation === 1) {
          manifest = await discardKnownProvider({
            manifest,
            apiKey: credential.apiKey,
            owner,
          });
          const next = generationRecord(2);
          manifest = await updateLeased(manifest, owner, () => ({
            phase: "creating_provider",
            providerGeneration: 2,
            provider: [...manifest.provider, next],
          }));
          const createStartedAt = nowIso();
          manifest = await updateLeased(manifest, owner, (current) => ({
            provider: replaceGeneration(current, 2, {
              state: "create_sending",
              createStartedAt,
              retryNotBefore: null,
            }),
          }));
          try {
            liveCapability = await createProviderFile({
              apiKey: credential.apiKey,
              filename: manifest.filename,
              signal: input.signal,
            });
          } catch (error) {
            if (
              error instanceof ManagedUploadIntentError &&
              error.code === "UPLOAD_PROVIDER_CREATE_UNKNOWN"
            ) {
              manifest = await updateLeased(manifest, owner, (current) => ({
                provider: replaceGeneration(current, 2, {
                  state: "create_unknown",
                  createUnknownAt: createStartedAt,
                }),
                phase: "waiting_provider",
                safeErrorCode: error.code,
              }));
              manifest = await releaseLease(manifest, owner);
              return statusFromManifest(manifest, input.traceId);
            }
            if (
              error instanceof ManagedUploadIntentError &&
              error.code === "UPLOAD_PROVIDER_CREATE_RETRYABLE"
            ) {
              manifest = await updateLeased(manifest, owner, (current) => ({
                provider: replaceGeneration(current, 2, {
                  state: "not_sent",
                  createStartedAt: null,
                  retryNotBefore: new Date(
                    Date.now() + (error.retryAfterMs ?? 3_000),
                  ).toISOString(),
                }),
                safeErrorCode: error.code,
              }));
              manifest = await releaseLease(manifest, owner);
              return statusFromManifest(manifest, input.traceId);
            }
            if (error instanceof ManagedUploadIntentError && !error.retryable) {
              manifest = await updateLeased(manifest, owner, (current) => ({
                state: "failed",
                phase: null,
                provider: replaceGeneration(current, 2, {
                  state: "create_rejected",
                  createStartedAt: null,
                }),
                safeErrorCode: error.code,
              }));
              manifest = await releaseLease(manifest, owner);
            }
            throw error;
          }
          manifest = await updateLeased(manifest, owner, (current) => ({
            provider: replaceGeneration(current, 2, {
              state: "created",
              createStartedAt: null,
              retryNotBefore: null,
              fileId: liveCapability!.fileId,
              filename: liveCapability!.filename,
              providerStatus: liveCapability!.status,
              uploadExpiresAt:
                liveCapability!.uploadExpiresAt === null
                  ? null
                  : new Date(liveCapability!.uploadExpiresAt).toISOString(),
            }),
          }));
          manifest = await ensureGenerationOwnership({
            manifest,
            owner,
            generation: currentGeneration(manifest)!,
          });
          generation = currentGeneration(manifest)!;
          if (
            liveCapability.uploadUrl === null ||
            liveCapability.uploadExpiresAt === null ||
            liveCapability.capabilityErrorCode !== null
          ) {
            const errorCode =
              liveCapability.capabilityErrorCode ??
              "UPLOAD_PROVIDER_RESPONSE_INVALID";
            manifest = await discardKnownProvider({
              manifest,
              apiKey: credential.apiKey,
              owner,
            });
            throw new ManagedUploadIntentError(
              502,
              errorCode,
              "云端上传能力无效，已安全移除替代记录",
              false,
              "contact_admin",
            );
          }
        } else {
          if (generation.fileId) {
            const errorCode =
              liveCapability?.capabilityErrorCode ??
              "UPLOAD_PROVIDER_CAPABILITY_LOST";
            manifest = await discardKnownProvider({
              manifest,
              apiKey: credential.apiKey,
              owner,
            });
            throw new ManagedUploadIntentError(
              503,
              errorCode,
              "云端上传地址已丢失，替代记录已安全移除",
              false,
              "contact_admin",
            );
          }
          throw new ManagedUploadIntentError(
            503,
            "UPLOAD_PROVIDER_CAPABILITY_LOST",
            "云端上传地址已丢失，请联系管理员",
            false,
            "contact_admin",
          );
        }
      }
      if (
        !liveCapability?.uploadUrl ||
        liveCapability.uploadExpiresAt === null
      ) {
        throw new ManagedUploadIntentError(
          503,
          "UPLOAD_PROVIDER_CAPABILITY_LOST",
          "云端上传地址已丢失，请联系管理员",
          false,
          "contact_admin",
        );
      }
      manifest = await updateLeased(manifest, owner, (current) => ({
        state: "processing",
        phase: "uploading_provider",
        provider: replaceGeneration(current, current.providerGeneration, {
          state: "put_sending",
          putStartedAt: nowIso(),
        }),
      }));
      let put = await putProviderContent({
        target: liveCapability.uploadUrl,
        expiresAt: liveCapability.uploadExpiresAt,
        contentPath: intentPaths(manifest.intentId).content,
        sizeBytes: manifest.sizeBytes!,
        mimeType: manifest.mimeType,
        signal: input.signal,
      });
      const accepted =
        put.status !== null &&
        put.status >= 200 &&
        put.status < 300 &&
        put.requestBodyComplete &&
        put.bytesForwarded === manifest.sizeBytes;
      const putRejected =
        put.status !== null &&
        put.status >= 400 &&
        put.status < 500 &&
        ![403, 408, 425, 429].includes(put.status);
      manifest = await updateLeased(manifest, owner, (current) => ({
        phase: "waiting_provider",
        provider: replaceGeneration(current, current.providerGeneration, {
          state: accepted
            ? "put_complete"
            : putRejected
              ? "put_rejected"
              : "put_unknown",
          putResponse2xx: accepted,
        }),
        safeErrorCode:
          put.status === 403
            ? put.ttlAtStartMs < MANAGED_UPLOAD_PROVIDER_MIN_TTL_MS
              ? "UPLOAD_PROVIDER_CAPABILITY_EXPIRED"
              : "UPLOAD_PROVIDER_PUT_FORBIDDEN"
            : putRejected
              ? "UPLOAD_PROVIDER_PUT_REJECTED"
              : current.safeErrorCode,
      }));
      generation = currentGeneration(manifest)!;
      let metadata;
      try {
        metadata = await providerMetadata({
          apiKey: credential.apiKey,
          fileId: generation.fileId!,
          filename: generation.filename!,
          signal: input.signal,
        });
        if (metadata.state === "uploaded") {
          if (!generation.putResponse2xx) {
            await proveProviderContent({
              apiKey: credential.apiKey,
              fileId: generation.fileId!,
              sizeBytes: manifest.sizeBytes!,
              sha256: manifest.sha256!,
              signal: input.signal,
            });
          }
          return statusFromManifest(
            await finalizeIntent({
              manifest,
              owner,
              apiKey: credential.apiKey,
              traceId: input.traceId,
              authoritativeFilename: metadata.filename,
            }),
            input.traceId,
          );
        }
      } catch (error) {
        if (error instanceof UpstreamFileReadinessError && error.retryable) {
          manifest = await releaseLease(manifest, owner);
          return statusFromManifest(manifest, input.traceId);
        }
        if (
          !(error instanceof UpstreamFileReadinessError) ||
          error.code !== "UPSTREAM_FILE_UNUSABLE"
        ) {
          throw error;
        }
        if (generation.generation === 2) {
          throw new ManagedUploadIntentError(
            503,
            "UPLOAD_PROVIDER_RECREATE_EXHAUSTED",
            "替代云端文件记录仍不可用，请联系管理员",
            false,
            "contact_admin",
          );
        }
        // The browser body is already sealed locally. Retire the unusable
        // first provider record and let recovery/worker create generation 2
        // from that same durable copy. Never surface a browser-body retry.
        manifest = await discardKnownProvider({
          manifest,
          apiKey: credential.apiKey,
          owner,
        });
        const next = generationRecord(2);
        manifest = await updateLeased(manifest, owner, (current) => ({
          state: "processing",
          phase: "creating_provider",
          providerGeneration: 2,
          provider: [...current.provider, next],
          safeErrorCode: "UPLOAD_PROVIDER_RECORD_UNUSABLE",
        }));
        manifest = await releaseLease(manifest, owner);
        return statusFromManifest(manifest, input.traceId);
      }
      const retryablePut =
        put.status === null ||
        put.status === 408 ||
        put.status === 425 ||
        put.status === 429 ||
        !put.requestBodyComplete ||
        (put.status !== null && put.status >= 500);
      if (metadata.state === "pending" && putRejected) {
        throw new ManagedUploadIntentError(
          502,
          "UPLOAD_PROVIDER_PUT_REJECTED",
          "云端明确拒绝文件内容上传，请联系管理员",
          false,
          "contact_admin",
        );
      }
      if (
        metadata.state === "pending" &&
        !accepted &&
        retryablePut &&
        !generation.putReplayed &&
        !put.expired &&
        liveCapability.uploadExpiresAt - Date.now() >=
          MANAGED_UPLOAD_PROVIDER_MIN_TTL_MS
      ) {
        // The same-id metadata check above proved pending before this sole
        // replay. The browser body is never involved.
        manifest = await updateLeased(manifest, owner, (current) => ({
          phase: "uploading_provider",
          provider: replaceGeneration(current, current.providerGeneration, {
            state: "put_sending",
            putStartedAt: nowIso(),
            putReplayed: true,
          }),
        }));
        put = await putProviderContent({
          target: liveCapability.uploadUrl,
          expiresAt: liveCapability.uploadExpiresAt,
          contentPath: intentPaths(manifest.intentId).content,
          sizeBytes: manifest.sizeBytes!,
          mimeType: manifest.mimeType,
          signal: input.signal,
        });
        const replayAccepted =
          put.status !== null &&
          put.status >= 200 &&
          put.status < 300 &&
          put.requestBodyComplete &&
          put.bytesForwarded === manifest.sizeBytes;
        const replayRejected =
          put.status !== null &&
          put.status >= 400 &&
          put.status < 500 &&
          ![403, 408, 425, 429].includes(put.status);
        manifest = await updateLeased(manifest, owner, (current) => ({
          phase: "waiting_provider",
          provider: replaceGeneration(current, current.providerGeneration, {
            state: replayAccepted
              ? "put_complete"
              : replayRejected
                ? "put_rejected"
                : "put_unknown",
            putResponse2xx: replayAccepted,
            putReplayed: true,
          }),
          safeErrorCode:
            put.status === 403
              ? put.ttlAtStartMs < MANAGED_UPLOAD_PROVIDER_MIN_TTL_MS
                ? "UPLOAD_PROVIDER_CAPABILITY_EXPIRED"
                : "UPLOAD_PROVIDER_PUT_FORBIDDEN"
              : replayRejected
                ? "UPLOAD_PROVIDER_PUT_REJECTED"
                : current.safeErrorCode,
        }));
        generation = currentGeneration(manifest)!;
        try {
          metadata = await providerMetadata({
            apiKey: credential.apiKey,
            fileId: generation.fileId!,
            filename: generation.filename!,
            signal: input.signal,
          });
          if (metadata.state === "uploaded") {
            if (!generation.putResponse2xx) {
              await proveProviderContent({
                apiKey: credential.apiKey,
                fileId: generation.fileId!,
                sizeBytes: manifest.sizeBytes!,
                sha256: manifest.sha256!,
                signal: input.signal,
              });
            }
            return statusFromManifest(
              await finalizeIntent({
                manifest,
                owner,
                apiKey: credential.apiKey,
                traceId: input.traceId,
                authoritativeFilename: metadata.filename,
              }),
              input.traceId,
            );
          }
          if (metadata.state === "pending" && replayRejected) {
            throw new ManagedUploadIntentError(
              502,
              "UPLOAD_PROVIDER_PUT_REJECTED",
              "云端明确拒绝文件内容上传，请联系管理员",
              false,
              "contact_admin",
            );
          }
        } catch (error) {
          if (error instanceof UpstreamFileReadinessError && error.retryable) {
            manifest = await releaseLease(manifest, owner);
            return statusFromManifest(manifest, input.traceId);
          }
          if (
            !(error instanceof UpstreamFileReadinessError) ||
            error.code !== "UPSTREAM_FILE_UNUSABLE"
          ) {
            throw error;
          }
          if (generation.generation === 2) {
            throw new ManagedUploadIntentError(
              503,
              "UPLOAD_PROVIDER_RECREATE_EXHAUSTED",
              "替代云端文件记录仍不可用，请联系管理员",
              false,
              "contact_admin",
            );
          }
          manifest = await discardKnownProvider({
            manifest,
            apiKey: credential.apiKey,
            owner,
          });
          const next = generationRecord(2);
          manifest = await updateLeased(manifest, owner, (current) => ({
            state: "processing",
            phase: "creating_provider",
            providerGeneration: 2,
            provider: [...current.provider, next],
            safeErrorCode: "UPLOAD_PROVIDER_RECORD_UNUSABLE",
          }));
          manifest = await releaseLease(manifest, owner);
          return statusFromManifest(manifest, input.traceId);
        }
      }
      manifest = await updateLeased(manifest, owner, (current) => ({
        phase: "waiting_provider",
        provider: replaceGeneration(current, current.providerGeneration, {
          state: generation!.putResponse2xx ? "waiting" : "put_unknown",
        }),
      }));
    }
    manifest = await releaseLease(manifest, owner);
    return statusFromManifest(manifest, input.traceId);
  } catch (error) {
    if (error instanceof ManagedUploadCleanupRequestedError) {
      const cleanupPending = await readManagedUploadIntent(
        input.intentId,
      ).catch(() => null);
      if (cleanupPending?.state === "cleanup_pending") {
        return statusFromManifest(cleanupPending, input.traceId);
      }
      throw error;
    }
    const current = await readManagedUploadIntent(input.intentId).catch(
      () => null,
    );
    if (current?.leaseOwner === owner) {
      const terminal =
        error instanceof ManagedUploadIntentError && !error.retryable;
      const preserveRecoveryState =
        current.state === "cleanup_pending" ||
        (current.state === "processing" &&
          current.phase === "finalizing" &&
          current.receipt !== null);
      await updateLeased(current, owner, () =>
        current.state === "cleanup_pending" &&
        current.receipt &&
        error instanceof ManagedUploadIntentError &&
        error.code === "UPLOAD_ALREADY_BOUND"
          ? {
              state: "uploaded",
              phase: null,
              provider: current.provider.map((generation) =>
                generation.fileId === current.receipt!.fileId
                  ? {
                      ...generation,
                      state: "uploaded" as const,
                      ownershipRecorded: true,
                      providerStatus: "uploaded",
                      updatedAt: nowIso(),
                    }
                  : generation,
              ),
              leaseOwner: null,
              leaseExpiresAt: null,
              safeErrorCode: null,
            }
          : preserveRecoveryState
            ? {
                leaseOwner: null,
                leaseExpiresAt: null,
                safeErrorCode:
                  error instanceof ManagedUploadIntentError
                    ? error.code
                    : "UPLOAD_INTERNAL_ERROR",
              }
            : {
                state:
                  current.state === "uploaded"
                    ? "uploaded"
                    : terminal
                      ? "failed"
                      : "processing",
                phase:
                  current.state === "uploaded" || terminal
                    ? null
                    : "waiting_provider",
                leaseOwner: null,
                leaseExpiresAt: null,
                safeErrorCode:
                  error instanceof ManagedUploadIntentError
                    ? error.code
                    : "UPLOAD_INTERNAL_ERROR",
              },
      ).catch(() => undefined);
    }
    throw error;
  }
}

export async function recoverManagedUploadIntent(input: {
  intentId: string;
  ticket: string;
  userId: number;
  projectAssignmentId?: string | null;
  traceId: string;
  signal?: AbortSignal;
}) {
  const manifest = await readManagedUploadIntent(input.intentId);
  if (!manifest)
    throw new ManagedUploadIntentError(
      404,
      "UPLOAD_INTENT_NOT_FOUND",
      "上传记录不存在",
      false,
      "refresh_page",
    );
  assertIntentOwner(manifest, input);
  openManagedUploadIntentTicket(input.ticket, manifest, { allowExpired: true });
  return processManagedUploadIntent(input);
}

export async function deleteManagedUploadIntent(input: {
  intentId: string;
  ticket: string;
  userId: number;
  projectAssignmentId?: string | null;
}) {
  const manifest = await readManagedUploadIntent(input.intentId);
  if (!manifest) return;
  assertIntentOwner(manifest, input);
  openManagedUploadIntentTicket(input.ticket, manifest, { allowExpired: true });
  if (manifest.state === "cancelled") return manifest;
  if (
    manifest.leaseOwner &&
    Date.parse(String(manifest.leaseExpiresAt)) > Date.now()
  ) {
    throw new ManagedUploadIntentError(
      409,
      "UPLOAD_IN_PROGRESS",
      "该文件仍在上传处理中，请稍后再移除",
      true,
      "check_status",
    );
  }
  const owner = randomUUID();
  const acquired = await acquireLease(manifest.intentId, owner, [
    "awaiting_browser",
    "sealed",
    "processing",
    "cleanup_pending",
    "failed",
    "uploaded",
    "expired",
  ]);
  if (acquired.state !== "acquired")
    throw new ManagedUploadIntentError(
      409,
      "UPLOAD_IN_PROGRESS",
      "该文件仍在上传处理中，请稍后再移除",
      true,
      "check_status",
    );
  let current = acquired.manifest;
  const originalUploaded =
    current.state === "uploaded" && current.receipt
      ? {
          receipt: current.receipt,
          provider: current.provider,
          completedAt: current.completedAt,
        }
      : null;
  try {
    if (originalUploaded) {
      const finalGeneration = current.provider.find(
        (item) => item.fileId === originalUploaded.receipt.fileId,
      );
      if (!finalGeneration) {
        throw new ManagedUploadIntentError(
          503,
          "UPLOAD_PROVIDER_IDENTITY_MISMATCH",
          "最终文件记录身份不一致，不能安全移除",
          false,
          "contact_admin",
        );
      }
      await assertProviderGenerationUnbound({
        manifest: current,
        generation: finalGeneration,
      });
    }
    // The cancellation intent and receipt withdrawal are durable before any
    // provider, ownership or byte deletion. Worker/recovery can safely resume
    // from this exact state after every external crash point.
    if (current.state !== "cleanup_pending") {
      current = await updateLeased(current, owner, () => ({
        state: "cleanup_pending",
        phase: "cleanup_pending",
        safeErrorCode: null,
      }));
    }
    const credential = await getDecryptedCredentialForManagedUploadIntent({
      credentialId: current.credentialId,
      credentialOwnerUserId: current.credentialOwnerUserId,
      credentialVersion: current.credentialVersion,
    });
    if (!credential) {
      throw new ManagedUploadIntentError(
        503,
        "UPLOAD_CREDENTIAL_UNAVAILABLE",
        "该上传绑定的原 API Key 已不可用",
        false,
        "contact_admin",
      );
    }
    return await completeIntentCleanup({
      manifest: current,
      owner,
      apiKey: credential.apiKey,
    });
  } catch (error) {
    const latest = await readManagedUploadIntent(input.intentId).catch(
      () => null,
    );
    if (latest?.leaseOwner === owner) {
      const durableReceipt =
        latest.receipt ?? originalUploaded?.receipt ?? null;
      const boundConflict =
        error instanceof ManagedUploadIntentError &&
        error.code === "UPLOAD_ALREADY_BOUND";
      await updateLeased(latest, owner, () =>
        boundConflict && durableReceipt
          ? {
              state: "uploaded",
              phase: null,
              leaseOwner: null,
              leaseExpiresAt: null,
              receipt: durableReceipt,
              provider: latest.provider.map((generation) =>
                generation.fileId === durableReceipt.fileId
                  ? {
                      ...generation,
                      state: "uploaded" as const,
                      ownershipRecorded: true,
                      providerStatus: "uploaded",
                      updatedAt: nowIso(),
                    }
                  : generation,
              ),
              completedAt:
                latest.completedAt ?? originalUploaded?.completedAt ?? nowIso(),
              safeErrorCode: null,
            }
          : latest.state === "cleanup_pending"
            ? {
                state: "cleanup_pending",
                phase: "cleanup_pending",
                leaseOwner: null,
                leaseExpiresAt: null,
                safeErrorCode:
                  error instanceof ManagedUploadIntentError
                    ? error.code
                    : "UPLOAD_PROVIDER_DISCARD_FAILED",
              }
            : {
                leaseOwner: null,
                leaseExpiresAt: null,
              },
      ).catch(() => undefined);
    }
    throw error;
  }
}

export async function sweepManagedUploadIntents(now = Date.now()) {
  const root = managedUploadIntentStorageRoot();
  const sweepTimestamp = new Date(now).toISOString();
  const entries = await fs
    .readdir(root, { withFileTypes: true })
    .catch((error) => {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    });
  let removedParts = 0;
  let removedSealed = 0;
  let compacted = 0;
  const candidates = entries
    .filter(
      (entry) =>
        entry.isDirectory() &&
        entry.name !== "by-operation" &&
        entry.name !== "by-resume-scope" &&
        entry.name !== "deletion-fences",
    )
    .sort((left, right) => left.name.localeCompare(right.name));
  const start = candidates.length > 0 ? sweeperCursor % candidates.length : 0;
  const selected = [
    ...candidates.slice(start),
    ...candidates.slice(0, start),
  ].slice(0, 500);
  if (candidates.length > 0) {
    sweeperCursor = (start + selected.length) % candidates.length;
  }
  for (const entry of selected) {
    if (
      !entry.isDirectory() ||
      entry.name === "by-operation" ||
      entry.name === "by-resume-scope" ||
      entry.name === "deletion-fences"
    )
      continue;
    const manifestPath = path.join(root, entry.name, "manifest.json");
    let manifest = await fs
      .readFile(manifestPath, "utf8")
      .then((raw) => assertManifest(JSON.parse(raw)))
      .catch(() => null);
    if (
      !manifest ||
      entry.name !== storageKey(manifest.intentId) ||
      (manifest.leaseOwner && Date.parse(String(manifest.leaseExpiresAt)) > now)
    )
      continue;
    if (["awaiting_browser", "receiving"].includes(manifest.state)) {
      manifest = await reconcileInterruptedIngress(manifest).catch(() => null);
      if (!manifest) continue;
    }
    if (
      ["awaiting_browser", "receiving"].includes(manifest.state) &&
      now - Date.parse(manifest.createdAt) >=
        MANAGED_UPLOAD_INTENT_PART_RETENTION_MS
    ) {
      const tombstone = await replaceManifest(manifest, (current) => ({
        ...current,
        state: "expired",
        phase: null,
        leaseOwner: null,
        leaseExpiresAt: null,
        safeErrorCode: "UPLOAD_BROWSER_STAGE_EXPIRED",
        revision: current.revision + 1,
        updatedAt: sweepTimestamp,
      })).catch(() => null);
      if (!tombstone) continue;
      manifest = tombstone;
    }
    if (
      !["uploaded", "cancelled"].includes(manifest.state) &&
      manifest.sealedAt &&
      now - Date.parse(manifest.sealedAt) >=
        MANAGED_UPLOAD_INTENT_SEALED_RETENTION_MS
    ) {
      const hasKnownProvider = manifest.provider.some(
        (generation) =>
          Boolean(generation.fileId) && generation.state !== "discarded",
      );
      if (hasKnownProvider) {
        // Never unlink the only local proof while a Manus record/ownership row
        // is still live. Durable cleanup_pending lets the regular lease/CAS
        // worker perform the authorized discard before byte retirement.
        if (manifest.state !== "cleanup_pending") {
          const pendingCleanup = await replaceManifest(manifest, (current) => ({
            ...current,
            state: "cleanup_pending",
            phase: "cleanup_pending",
            leaseOwner: null,
            leaseExpiresAt: null,
            safeErrorCode: "UPLOAD_LOCAL_COPY_RETENTION_CLEANUP",
            revision: current.revision + 1,
            updatedAt: sweepTimestamp,
          })).catch(() => null);
          if (pendingCleanup) manifest = pendingCleanup;
        }
        continue;
      }
      if (manifest.state !== "expired") {
        const tombstone = await replaceManifest(manifest, (current) => ({
          ...current,
          state: "expired",
          phase: null,
          leaseOwner: null,
          leaseExpiresAt: null,
          safeErrorCode: "UPLOAD_LOCAL_COPY_EXPIRED_RECREATE_REQUIRED",
          revision: current.revision + 1,
          updatedAt: sweepTimestamp,
        })).catch(() => null);
        if (!tombstone) continue;
        manifest = tombstone;
      }
    }

    // File deletion is itself crash-reentrant. A previous sweep may have
    // persisted the tombstone and died before unlink/fsync.
    if (manifest.state === "expired") {
      const part = path.join(root, entry.name, "upload.part");
      const content = path.join(root, entry.name, "upload.content");
      const partExisted = await fs
        .stat(part)
        .then(() => true)
        .catch(() => false);
      const contentExisted = await fs
        .stat(content)
        .then(() => true)
        .catch(() => false);
      await fs.rm(part, { force: true });
      await fs.rm(content, { force: true });
      await fsyncDirectory(path.join(root, entry.name));
      if (partExisted) removedParts += 1;
      if (contentExisted) removedSealed += 1;
    } else if (manifest.state === "uploaded") {
      // Defensive recovery for a crash after durable receipt publication but
      // before source hard-link cleanup. The final retained copy has its own
      // inode link and manifest.
      const content = path.join(root, entry.name, "upload.content");
      const contentExisted = await fs
        .stat(content)
        .then(() => true)
        .catch(() => false);
      if (contentExisted) {
        await fs.rm(content, { force: true });
        await fsyncDirectory(path.join(root, entry.name));
        removedSealed += 1;
      }
    }

    const terminalAt =
      manifest.state === "uploaded"
        ? manifest.completedAt
        : manifest.state === "cancelled"
          ? manifest.deletedAt
          : manifest.state === "expired"
            ? manifest.updatedAt
            : null;
    if (
      terminalAt &&
      now - Date.parse(terminalAt) >=
        MANAGED_UPLOAD_INTENT_TOMBSTONE_RETENTION_MS
    ) {
      const indexPath = operationIndexPath({
        userId: manifest.userId,
        projectAssignmentId: manifest.projectAssignmentId,
        operationId: manifest.operationId,
      });
      await writeJsonAtomic(indexPath, {
        schemaVersion: 1,
        state: "retired",
        requestHash: manifest.requestHash,
        retiredAt: new Date(now).toISOString(),
      });
      await fs.rm(path.join(root, entry.name), {
        recursive: true,
        force: true,
      });
      await fsyncDirectory(root);
      compacted += 1;
    }
  }

  // Retired operation tombstones preserve lost-response idempotency without
  // retaining intent/file/provider identity forever.
  const indexRoot = path.join(root, "by-operation");
  const indexes = await fs
    .readdir(indexRoot, { withFileTypes: true })
    .catch((error) => {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    });
  for (const index of indexes.slice(0, 500)) {
    if (!index.isFile() || !index.name.endsWith(".json")) continue;
    const target = path.join(indexRoot, index.name);
    const value = await fs
      .readFile(target, "utf8")
      .then((raw) => JSON.parse(raw) as Record<string, unknown>)
      .catch(() => null);
    if (
      value?.state === "retired" &&
      typeof value.retiredAt === "string" &&
      Number.isFinite(Date.parse(value.retiredAt)) &&
      now - Date.parse(value.retiredAt) >=
        MANAGED_UPLOAD_INTENT_TOMBSTONE_RETENTION_MS
    ) {
      await fs.rm(target, { force: true });
      await fsyncDirectory(indexRoot);
    }
  }
  return { removedParts, removedSealed, compacted };
}

let sweeperCursor = 0;
let workerScanCursor = 0;

type ManagedUploadIntentWorkerReadiness = {
  started: boolean;
  storageReady: boolean;
  tickRunning: boolean;
  lastRunAt: string | null;
  lastSuccessAt: string | null;
  lastErrorAt: string | null;
  scans: number;
  scheduled: number;
  completed: number;
  failed: number;
  corruptManifests: number;
  sweeper: {
    runs: number;
    failed: number;
    removedParts: number;
    removedSealed: number;
  };
};

let workerTimer: NodeJS.Timeout | null = null;
let workerTickPromise: Promise<void> | null = null;
const workerReadiness: ManagedUploadIntentWorkerReadiness = {
  started: false,
  storageReady: false,
  tickRunning: false,
  lastRunAt: null,
  lastSuccessAt: null,
  lastErrorAt: null,
  scans: 0,
  scheduled: 0,
  completed: 0,
  failed: 0,
  corruptManifests: 0,
  sweeper: {
    runs: 0,
    failed: 0,
    removedParts: 0,
    removedSealed: 0,
  },
};

export function getManagedUploadIntentWorkerReadiness(): ManagedUploadIntentWorkerReadiness {
  return {
    ...workerReadiness,
    sweeper: { ...workerReadiness.sweeper },
  };
}

async function prepareManagedUploadIntentWorkerStorage() {
  const root = managedUploadIntentStorageRoot();
  await ensurePrivateDirectory(root);
  await ensurePrivateDirectory(path.join(root, "by-operation"));
  await ensurePrivateDirectory(path.join(root, "by-resume-scope"));
  // Prove that the configured durable volume is writable before the listener
  // advertises readiness. The probe follows the same create/fsync/remove rules
  // as intent state without leaving a reusable capability behind.
  const probe = path.join(root, `.worker-preflight-${randomUUID()}`);
  const handle = await fs.open(probe, "wx", 0o600);
  try {
    await handle.writeFile("managed-upload-intent-worker\n", "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  await fs.rm(probe, { force: true });
  await fsyncDirectory(root);
  await reconcileDeletedManagedUploadAccountRetirements().catch(
    () => undefined,
  );
  workerReadiness.storageReady = true;
}

async function runManagedUploadIntentWorkerTick() {
  if (workerTickPromise) return workerTickPromise;
  workerTickPromise = (async () => {
    workerReadiness.tickRunning = true;
    workerReadiness.lastRunAt = nowIso();
    workerReadiness.scans += 1;
    let tickFailed = false;
    try {
      const root = managedUploadIntentStorageRoot();
      const entries = (await fs.readdir(root, { withFileTypes: true }))
        .filter(
          (entry) =>
            entry.isDirectory() &&
            entry.name !== "by-operation" &&
            entry.name !== "by-resume-scope" &&
            entry.name !== "deletion-fences",
        )
        .sort((left, right) => left.name.localeCompare(right.name));
      const start = entries.length > 0 ? workerScanCursor % entries.length : 0;
      const selected = [
        ...entries.slice(start),
        ...entries.slice(0, start),
      ].slice(0, 100);
      if (entries.length > 0) {
        workerScanCursor = (start + selected.length) % entries.length;
      }
      const active = new Set<Promise<void>>();
      for (const entry of selected) {
        let manifest: ManagedUploadIntentManifest;
        try {
          manifest = assertManifest(
            JSON.parse(
              await fs.readFile(
                path.join(root, entry.name, "manifest.json"),
                "utf8",
              ),
            ),
          );
          if (entry.name !== storageKey(manifest.intentId)) {
            throw new Error("MANAGED_UPLOAD_INTENT_DIRECTORY_MISMATCH");
          }
        } catch {
          // Corrupt or relocated state is never executed. Expose only a count;
          // the directory, intent and filename are intentionally not logged.
          workerReadiness.corruptManifests += 1;
          tickFailed = true;
          continue;
        }
        if (
          !["receiving", "sealed", "processing", "cleanup_pending"].includes(
            manifest.state,
          )
        ) {
          continue;
        }
        workerReadiness.scheduled += 1;
        // Reconciliation/processing is awaited before the sweeper sees this
        // intent. In particular a >6h receiving manifest with an already
        // renamed, complete `.content` cannot be expired concurrently with
        // crash recovery.
        const job = processManagedUploadIntent({
          intentId: manifest.intentId,
          userId: manifest.userId,
          projectAssignmentId: manifest.projectAssignmentId,
          traceId: randomUUID(),
        })
          .then(() => {
            workerReadiness.completed += 1;
          })
          .catch(() => {
            workerReadiness.failed += 1;
            workerReadiness.lastErrorAt = nowIso();
            tickFailed = true;
          })
          .finally(() => {
            active.delete(job);
          });
        active.add(job);
        if (active.size >= 4) {
          await Promise.race(active);
        }
      }
      await Promise.all(active);
      try {
        const swept = await sweepManagedUploadIntents();
        workerReadiness.sweeper.runs += 1;
        workerReadiness.sweeper.removedParts += swept.removedParts;
        workerReadiness.sweeper.removedSealed += swept.removedSealed;
      } catch {
        workerReadiness.sweeper.failed += 1;
        tickFailed = true;
      }
      if (tickFailed) {
        workerReadiness.lastErrorAt = nowIso();
      } else {
        workerReadiness.lastSuccessAt = nowIso();
      }
    } catch {
      workerReadiness.lastErrorAt = nowIso();
      workerReadiness.failed += 1;
    } finally {
      workerReadiness.tickRunning = false;
      workerTickPromise = null;
    }
  })();
  return workerTickPromise;
}

export async function ensureManagedUploadIntentWorker(options?: {
  intervalMs?: number;
  runImmediately?: boolean;
  allowInTest?: boolean;
}) {
  if (process.env.NODE_ENV === "test" && !options?.allowInTest) {
    return getManagedUploadIntentWorkerReadiness();
  }
  if (workerReadiness.started) {
    return getManagedUploadIntentWorkerReadiness();
  }
  await prepareManagedUploadIntentWorkerStorage();
  workerReadiness.started = true;
  const intervalMs = Math.max(250, options?.intervalMs ?? 5_000);
  workerTimer = setInterval(
    () => void runManagedUploadIntentWorkerTick(),
    intervalMs,
  );
  workerTimer.unref?.();
  if (options?.runImmediately !== false) {
    void runManagedUploadIntentWorkerTick();
  }
  return getManagedUploadIntentWorkerReadiness();
}

export async function stopManagedUploadIntentWorkerForTests() {
  if (process.env.NODE_ENV !== "test") return;
  if (workerTimer) clearInterval(workerTimer);
  workerTimer = null;
  await workerTickPromise;
  workerReadiness.started = false;
  workerReadiness.storageReady = false;
  workerReadiness.tickRunning = false;
}
