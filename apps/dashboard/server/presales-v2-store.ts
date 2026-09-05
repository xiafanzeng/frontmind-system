import { createHash, randomUUID } from "node:crypto";
import * as fs from "node:fs/promises";
import path from "node:path";

import type { PresalesV2ContractName } from "./presales-v2-contracts";
import type { ManagedAgentProfile } from "../shared/manus-agent-profile";

export type PresalesV2TaskStatus =
  | "queued"
  | "running"
  | "result_pending"
  | "succeeded"
  | "failed"
  | "cancelled"
  | "attention_required";

export type PresalesV2SafeEvent = {
  id: string;
  type: string;
  timestamp: number;
};

export type PresalesV2Artifact = {
  artifactId: string;
  filename: string;
  mimeType: string;
  bytes: number;
  sha256: string;
};

export type PresalesV2ArtifactIndex = PresalesV2Artifact & {
  schemaVersion: 2;
  localTaskId: string | null;
  operationId: string | null;
  projectId: string | null;
  sourceEventId: string;
  attachmentIndex: number;
  createdAt: string;
  deletedAt?: string | null;
};

export type PresalesV2RepairRecord = {
  reason?: "business_invalid_result" | "transport_missing_result";
  operationId: string;
  idempotencyHash: string;
  requestHash: string;
  operationMarker: string;
  baselineEventIds: string[];
  status: PresalesV2TaskStatus;
  providerRequestId: string | null;
  sendAttemptedAt: string | null;
  reconcileUntil: string;
  createdAt: string;
  updatedAt: string;
};

export type PresalesV2PreparationRecord = {
  /**
   * Kept only until the Provider create boundary is durably claimed. This is
   * private dispatch input and is never included in the public task view.
   */
  prompt: string | null;
  assets: Array<{
    localAssetId: string;
    filename: string;
    /** A fresh Provider file candidate is reserved at most twice. */
    candidateAttempts: number;
  }>;
  /** Once set, createTask is reconcile-only and must never be called again. */
  providerCreateAttemptedAt: string | null;
};

export type PresalesV2TaskRecord = {
  schemaVersion: 2;
  localTaskId: string;
  operationId: string;
  idempotencyHash: string;
  requestHash: string;
  projectId: string | null;
  contract: {
    name: PresalesV2ContractName;
    revision: 2;
    schemaHash: string;
  };
  profile: ManagedAgentProfile;
  upstreamModel: string;
  operationToken: string;
  operationMarker: string;
  providerTitle: string;
  credentialId: string;
  credentialVersion: number;
  providerTaskId: string | null;
  providerRequestId: string | null;
  providerFileLeases: Array<{
    localAssetId: string;
    providerFileId: string;
    filename: string;
    expiresAt: number;
    providerRequestId: string | null;
    uploadState:
      | "reserved"
      | "uploading"
      | "uploaded"
      | "failed"
      | "outcome_unknown";
  }>;
  status: PresalesV2TaskStatus;
  safeEvents: PresalesV2SafeEvent[];
  structuredResult: unknown | null;
  artifacts: PresalesV2Artifact[];
  errorCode: string | null;
  resultDeadlineAt: string | null;
  resultDecoderRevision?: 2 | 3;
  resultSource?:
    | "structured_object"
    | "structured_json_string"
    | "structured_recovered_value"
    | "assistant_json_fallback"
    | null;
  resultHash?: string | null;
  providerStartedAt?: string | null;
  providerRunDeadlineAt?: string | null;
  providerRunDeadlineExceededAt?: string | null;
  terminalAt?: string | null;
  createSearchUntil: string;
  repair?: PresalesV2RepairRecord | null;
  providerDeleteAt?: string | null;
  providerCleanupDisposition?:
    | "completed"
    | "terminal_unavailable"
    | "outcome_unknown"
    | null;
  providerCleanupErrorCode?: string | null;
  projectCleanupAt?: string | null;
  /** Optional so pre-existing revision-3 records keep their frozen behavior. */
  preparation?: PresalesV2PreparationRecord;
  createdAt: string;
  updatedAt: string;
};

type PresalesV2IdempotencyIndex = {
  schemaVersion: 2;
  idempotencyHash: string;
  requestHash: string;
  localTaskId: string;
};

export type PresalesV2AssetRecord = {
  schemaVersion: 2;
  localAssetId: string;
  idempotencyHash: string;
  requestHash: string;
  projectId: string | null;
  filename: string;
  mimeType: string;
  expectedBytes: number | null;
  bytes: number | null;
  sha256: string | null;
  status: "pending" | "uploaded" | "deleted";
  createdAt: string;
  updatedAt: string;
};

const LOCK_STALE_MS = 30_000;
const LOCK_WAIT_MS = 5_000;

function rootDirectory() {
  const assetRoot = path.resolve(
    process.env.FRONTMIND_DASHBOARD_ASSET_DIR ||
      path.join(process.cwd(), ".frontmind-dashboard-assets"),
  );
  return path.join(assetRoot, "presales-v2");
}

function safeKey(value: string) {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function taskPath(localTaskId: string) {
  return path.join(rootDirectory(), "tasks", `${safeKey(localTaskId)}.json`);
}

function indexPath(idempotencyHash: string) {
  return path.join(
    rootDirectory(),
    "idempotency",
    `${safeKey(idempotencyHash)}.json`,
  );
}

function assetPath(localAssetId: string) {
  return path.join(rootDirectory(), "assets", `${safeKey(localAssetId)}.json`);
}

function assetIndexPath(idempotencyHash: string) {
  return path.join(
    rootDirectory(),
    "asset-idempotency",
    `${safeKey(idempotencyHash)}.json`,
  );
}

function artifactPath(artifactId: string) {
  return path.join(rootDirectory(), "artifacts", `${safeKey(artifactId)}.json`);
}

async function ensurePrivateDirectory(directory: string) {
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  await fs.chmod(directory, 0o700).catch(() => undefined);
}

async function writeJsonAtomic(target: string, value: unknown) {
  await ensurePrivateDirectory(path.dirname(target));
  const temporary = `${target}.${randomUUID()}.tmp`;
  try {
    const handle = await fs.open(temporary, "wx", 0o600);
    try {
      await handle.writeFile(`${JSON.stringify(value)}\n`, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    await fs.rename(temporary, target);
    const directory = await fs.open(path.dirname(target), "r");
    try {
      await directory.sync();
    } finally {
      await directory.close();
    }
  } finally {
    await fs.rm(temporary, { force: true }).catch(() => undefined);
  }
}

async function readJson<T>(target: string): Promise<T | null> {
  try {
    return JSON.parse(await fs.readFile(target, "utf8")) as T;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

async function readJsonDirectory<T>(directory: string): Promise<T[]> {
  const target = path.join(rootDirectory(), directory);
  const names = await fs.readdir(target).catch((error) => {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  });
  const records: T[] = [];
  for (const name of names) {
    if (!name.endsWith(".json")) continue;
    const record = await readJson<T>(path.join(target, name));
    if (record !== null) records.push(record);
  }
  return records;
}

async function pause(milliseconds: number) {
  await new Promise<void>((resolve) => setTimeout(resolve, milliseconds));
}

async function withLock<T>(key: string, action: () => Promise<T>) {
  const lock = path.join(rootDirectory(), "locks", safeKey(key));
  await ensurePrivateDirectory(path.dirname(lock));
  const deadline = Date.now() + LOCK_WAIT_MS;
  while (true) {
    try {
      await fs.mkdir(lock, { mode: 0o700 });
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const stat = await fs.stat(lock).catch(() => null);
      if (stat && Date.now() - stat.mtimeMs > LOCK_STALE_MS) {
        await fs.rm(lock, { recursive: true, force: true });
        continue;
      }
      if (Date.now() >= deadline) throw new Error("PRESALES_V2_STORE_BUSY");
      await pause(25);
    }
  }
  try {
    return await action();
  } finally {
    await fs.rm(lock, { recursive: true, force: true });
  }
}

export function hashPresalesV2IdempotencyKey(value: string) {
  return safeKey(value.trim());
}

export function hashPresalesV2Request(value: unknown) {
  return safeKey(JSON.stringify(value));
}

export async function acquirePresalesV2Asset(input: {
  idempotencyKey: string;
  requestHash: string;
  projectId: string | null;
  filename: string;
  mimeType: string;
  expectedBytes: number | null;
}): Promise<
  | { state: "acquired" | "existing"; record: PresalesV2AssetRecord }
  | { state: "conflict" }
> {
  const idempotencyHash = hashPresalesV2IdempotencyKey(input.idempotencyKey);
  return withLock(`asset-idempotency:${idempotencyHash}`, async () => {
    const existing = await readJson<PresalesV2IdempotencyIndex>(
      assetIndexPath(idempotencyHash),
    );
    if (existing) {
      if (existing.requestHash !== input.requestHash)
        return { state: "conflict" };
      const record = await readPresalesV2Asset(existing.localTaskId);
      if (!record) throw new Error("PRESALES_V2_ASSET_INDEX_DANGLING");
      return { state: "existing", record };
    }
    const now = new Date().toISOString();
    const record: PresalesV2AssetRecord = {
      schemaVersion: 2,
      localAssetId: randomUUID(),
      idempotencyHash,
      requestHash: input.requestHash,
      projectId: input.projectId,
      filename: input.filename,
      mimeType: input.mimeType,
      expectedBytes: input.expectedBytes,
      bytes: null,
      sha256: null,
      status: "pending",
      createdAt: now,
      updatedAt: now,
    };
    await writeJsonAtomic(assetPath(record.localAssetId), record);
    await writeJsonAtomic(assetIndexPath(idempotencyHash), {
      schemaVersion: 2,
      idempotencyHash,
      requestHash: input.requestHash,
      localTaskId: record.localAssetId,
    } satisfies PresalesV2IdempotencyIndex);
    return { state: "acquired", record };
  });
}

export async function readPresalesV2Asset(localAssetId: string) {
  const record = await readJson<PresalesV2AssetRecord>(assetPath(localAssetId));
  return record?.schemaVersion === 2 && record.localAssetId === localAssetId
    ? record
    : null;
}

export async function updatePresalesV2Asset(
  localAssetId: string,
  update: (current: PresalesV2AssetRecord) => PresalesV2AssetRecord,
) {
  return withLock(`asset:${localAssetId}`, async () => {
    const current = await readPresalesV2Asset(localAssetId);
    if (!current) return null;
    const next = update(current);
    if (
      next.localAssetId !== current.localAssetId ||
      next.idempotencyHash !== current.idempotencyHash ||
      next.requestHash !== current.requestHash ||
      next.projectId !== current.projectId
    ) {
      throw new Error("PRESALES_V2_FROZEN_ASSET_MUTATION");
    }
    const persisted = { ...next, updatedAt: new Date().toISOString() };
    await writeJsonAtomic(assetPath(localAssetId), persisted);
    return persisted;
  });
}

/** A browser upload may precede project creation; bind it exactly once. */
export async function bindPresalesV2AssetProject(
  localAssetId: string,
  projectId: string,
) {
  return withLock(`asset:${localAssetId}`, async () => {
    const current = await readPresalesV2Asset(localAssetId);
    if (!current) return null;
    if (current.projectId && current.projectId !== projectId) {
      throw new Error("PRESALES_V2_ASSET_PROJECT_CONFLICT");
    }
    if (current.projectId === projectId) return current;
    const persisted = {
      ...current,
      projectId,
      updatedAt: new Date().toISOString(),
    };
    await writeJsonAtomic(assetPath(localAssetId), persisted);
    return persisted;
  });
}

export async function recordPresalesV2Artifact(
  record: PresalesV2ArtifactIndex,
) {
  const target = artifactPath(record.artifactId);
  return withLock(`artifact:${record.artifactId}`, async () => {
    const existing = await readJson<PresalesV2ArtifactIndex>(target);
    if (existing) {
      if (
        existing.localTaskId !== record.localTaskId ||
        existing.sourceEventId !== record.sourceEventId ||
        existing.attachmentIndex !== record.attachmentIndex ||
        existing.sha256 !== record.sha256 ||
        existing.bytes !== record.bytes
      ) {
        throw new Error("PRESALES_V2_ARTIFACT_IDENTITY_CONFLICT");
      }
      return existing;
    }
    await writeJsonAtomic(target, record);
    return record;
  });
}

export async function readPresalesV2Artifact(artifactId: string) {
  const record = await readJson<PresalesV2ArtifactIndex>(
    artifactPath(artifactId),
  );
  return record?.schemaVersion === 2 &&
    record.artifactId === artifactId &&
    !record.deletedAt
    ? record
    : null;
}

export async function markPresalesV2ArtifactDeleted(artifactId: string) {
  return withLock(`artifact:${artifactId}`, async () => {
    const target = artifactPath(artifactId);
    const current = await readJson<PresalesV2ArtifactIndex>(target);
    if (!current || current.artifactId !== artifactId) return null;
    if (current.deletedAt) return current;
    const persisted = { ...current, deletedAt: new Date().toISOString() };
    await writeJsonAtomic(target, persisted);
    return persisted;
  });
}

export async function acquirePresalesV2Task(input: {
  idempotencyKey: string;
  requestHash: string;
  projectId: string | null;
  contract: PresalesV2TaskRecord["contract"];
  profile: ManagedAgentProfile;
  upstreamModel: string;
  credentialId: string;
  credentialVersion: number;
  preparation?: {
    prompt: string;
    assets: Array<{ localAssetId: string; filename: string }>;
  };
}): Promise<
  | { state: "acquired"; record: PresalesV2TaskRecord }
  | { state: "existing"; record: PresalesV2TaskRecord }
  | { state: "conflict" }
> {
  const idempotencyHash = hashPresalesV2IdempotencyKey(input.idempotencyKey);
  return withLock(`idempotency:${idempotencyHash}`, async () => {
    const existing = await readJson<PresalesV2IdempotencyIndex>(
      indexPath(idempotencyHash),
    );
    if (existing) {
      if (existing.requestHash !== input.requestHash)
        return { state: "conflict" };
      const record = await readPresalesV2Task(existing.localTaskId);
      if (!record) throw new Error("PRESALES_V2_TASK_INDEX_DANGLING");
      return { state: "existing", record };
    }
    const now = new Date().toISOString();
    const localTaskId = randomUUID();
    const operationId = randomUUID();
    const record: PresalesV2TaskRecord = {
      schemaVersion: 2,
      localTaskId,
      operationId,
      idempotencyHash,
      requestHash: input.requestHash,
      projectId: input.projectId,
      contract: input.contract,
      profile: input.profile,
      upstreamModel: input.upstreamModel,
      operationToken: operationId,
      operationMarker: `FRONTMIND_MANUS_V2_OPERATION_CONTRACT=${JSON.stringify({ operationToken: operationId, operationId, contractName: input.contract.name, contractRevision: input.contract.revision, schemaHash: input.contract.schemaHash })}`,
      providerTitle: `FrontMind Website ${input.contract.name} ${operationId}`,
      credentialId: input.credentialId,
      credentialVersion: input.credentialVersion,
      providerTaskId: null,
      providerRequestId: null,
      providerFileLeases: [],
      status: "queued",
      safeEvents: [],
      structuredResult: null,
      artifacts: [],
      errorCode: null,
      resultDeadlineAt: null,
      resultDecoderRevision: 3,
      resultSource: null,
      resultHash: null,
      providerStartedAt: null,
      providerRunDeadlineAt: null,
      providerRunDeadlineExceededAt: null,
      terminalAt: null,
      createSearchUntil: new Date(Date.now() + 5 * 60_000).toISOString(),
      ...(input.preparation
        ? {
            preparation: {
              prompt: input.preparation.prompt,
              assets: input.preparation.assets.map((asset) => ({
                ...asset,
                candidateAttempts: 0,
              })),
              providerCreateAttemptedAt: null,
            },
          }
        : {}),
      createdAt: now,
      updatedAt: now,
    };
    await writeJsonAtomic(taskPath(record.localTaskId), record);
    await writeJsonAtomic(indexPath(idempotencyHash), {
      schemaVersion: 2,
      idempotencyHash,
      requestHash: input.requestHash,
      localTaskId: record.localTaskId,
    } satisfies PresalesV2IdempotencyIndex);
    return { state: "acquired", record };
  });
}

export async function readPresalesV2Task(localTaskId: string) {
  const record = await readJson<PresalesV2TaskRecord>(taskPath(localTaskId));
  return record?.schemaVersion === 2 && record.localTaskId === localTaskId
    ? record
    : null;
}

export async function updatePresalesV2Task(
  localTaskId: string,
  update: (current: PresalesV2TaskRecord) => PresalesV2TaskRecord,
) {
  return withLock(`task:${localTaskId}`, async () => {
    const current = await readPresalesV2Task(localTaskId);
    if (!current) return null;
    const next = update(current);
    const currentPreparation = current.preparation;
    const nextPreparation = next.preparation;
    const preparationIdentityChanged = (() => {
      if (!currentPreparation || !nextPreparation) {
        return currentPreparation !== nextPreparation;
      }
      if (
        currentPreparation.assets.length !== nextPreparation.assets.length ||
        currentPreparation.assets.some((asset, index) => {
          const candidate = nextPreparation.assets[index];
          return (
            !candidate ||
            candidate.localAssetId !== asset.localAssetId ||
            candidate.filename !== asset.filename ||
            !Number.isSafeInteger(candidate.candidateAttempts) ||
            candidate.candidateAttempts < asset.candidateAttempts ||
            candidate.candidateAttempts > 2
          );
        })
      ) {
        return true;
      }
      if (
        currentPreparation.prompt === null
          ? nextPreparation.prompt !== null
          : nextPreparation.prompt !== currentPreparation.prompt &&
            nextPreparation.prompt !== null
      ) {
        return true;
      }
      return currentPreparation.providerCreateAttemptedAt
        ? nextPreparation.providerCreateAttemptedAt !==
            currentPreparation.providerCreateAttemptedAt
        : nextPreparation.providerCreateAttemptedAt !== null &&
            (typeof nextPreparation.providerCreateAttemptedAt !== "string" ||
              !Number.isFinite(
                Date.parse(nextPreparation.providerCreateAttemptedAt),
              ));
    })();
    const deadlineResultFinalization =
      current.status === "attention_required" &&
      current.errorCode === "PROVIDER_RUN_DEADLINE_EXCEEDED" &&
      (next.status === "succeeded" || next.status === "failed");
    const terminalStatusRegression =
      (current.status === "succeeded" && next.status !== "succeeded") ||
      (current.status === "failed" && next.status !== "failed") ||
      (current.status === "cancelled" && next.status !== "cancelled") ||
      (current.status === "attention_required" &&
        next.status !== "attention_required" &&
        !deadlineResultFinalization);
    if (terminalStatusRegression) {
      throw new Error("PRESALES_V2_TERMINAL_STATUS_REGRESSION");
    }
    if (
      next.localTaskId !== current.localTaskId ||
      next.operationId !== current.operationId ||
      next.requestHash !== current.requestHash ||
      next.credentialId !== current.credentialId ||
      next.credentialVersion !== current.credentialVersion ||
      next.profile !== current.profile ||
      next.upstreamModel !== current.upstreamModel ||
      next.operationToken !== current.operationToken ||
      next.operationMarker !== current.operationMarker ||
      next.providerTitle !== current.providerTitle ||
      preparationIdentityChanged ||
      (current.repair !== undefined &&
        current.repair !== null &&
        (!next.repair ||
          next.repair.reason !== current.repair.reason ||
          next.repair.operationId !== current.repair.operationId ||
          next.repair.idempotencyHash !== current.repair.idempotencyHash ||
          next.repair.requestHash !== current.repair.requestHash ||
          next.repair.operationMarker !== current.repair.operationMarker ||
          JSON.stringify(next.repair.baselineEventIds) !==
            JSON.stringify(current.repair.baselineEventIds)))
    ) {
      throw new Error("PRESALES_V2_FROZEN_OPERATION_MUTATION");
    }
    const persisted = { ...next, updatedAt: new Date().toISOString() };
    await writeJsonAtomic(taskPath(localTaskId), persisted);
    return persisted;
  });
}

export type PresalesV2ProjectResourceSnapshot = {
  tasks: PresalesV2TaskRecord[];
  assets: PresalesV2AssetRecord[];
  artifacts: PresalesV2ArtifactIndex[];
};

/**
 * Project deletion reconciles the durable local indexes instead of trusting
 * browser-held IDs. Tombstoned records remain readable to this scanner so a
 * retry can prove that no live resource was skipped.
 */
export async function readPresalesV2ProjectResourceSnapshot(
  projectId: string,
): Promise<PresalesV2ProjectResourceSnapshot> {
  const [tasks, assets, artifacts] = await Promise.all([
    readJsonDirectory<PresalesV2TaskRecord>("tasks"),
    readJsonDirectory<PresalesV2AssetRecord>("assets"),
    readJsonDirectory<PresalesV2ArtifactIndex>("artifacts"),
  ]);
  return {
    tasks: tasks.filter(
      (record) =>
        record.schemaVersion === 2 &&
        record.projectId === projectId &&
        !record.projectCleanupAt,
    ),
    assets: assets.filter(
      (record) =>
        record.schemaVersion === 2 &&
        record.projectId === projectId &&
        record.status !== "deleted",
    ),
    artifacts: artifacts.filter(
      (record) =>
        record.schemaVersion === 2 &&
        record.projectId === projectId &&
        !record.deletedAt,
    ),
  };
}
