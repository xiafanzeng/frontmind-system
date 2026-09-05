import { createHash, randomUUID } from "node:crypto";
import { createReadStream, createWriteStream, type ReadStream } from "node:fs";
import * as fs from "node:fs/promises";
import path from "node:path";
import { Transform, type Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

type PresalesFileManifest = {
  schemaVersion: 1;
  fileId: string;
  filename: string;
  mimeType: string;
  sizeBytes: number | null;
  sha256: string | null;
  state: "pending" | "stored" | "expired";
  /**
   * Optional for backwards compatibility with pre-retention v1 manifests.
   * Only user-upload content receives these fields; assistant/output files do
   * not, so an age-only sweep cannot accidentally remove them.
   */
  uploadedAt?: string;
  contentExpiresAt?: string;
  contentDeletedAt?: string;
  updatedAt: string;
};

type PresalesFileCreateReservation = {
  schemaVersion: 1;
  keyHash: string;
  requestHash: string;
  apiCredentialId: string;
  credentialVersion: number;
  status: "pending" | "completed" | "deleted";
  attemptId: string;
  leaseExpiresAt: string;
  upstreamFileId: string | null;
  upstreamFilename: string | null;
  upstreamStatus: string | null;
  uploadUrl: string | null;
  uploadExpiresAt: string | number | null;
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
  deletedAt: string | null;
};

type PresalesFileCreateIndex = {
  schemaVersion: 1;
  upstreamFileId: string;
  keyHash: string;
};

export type PresalesFileCreateReservationResult =
  | {
      state: "acquired";
      keyHash: string;
      attemptId: string;
      leaseExpiresAt: Date;
    }
  | {
      state: "completed";
      upstreamFileId: string;
      upstreamFilename: string | null;
      upstreamStatus: string | null;
      uploadUrl: string | null;
      uploadExpiresAt: string | number | null;
    }
  | { state: "deleted"; upstreamFileId: string }
  | { state: "conflict" }
  | { state: "pending"; retryAfterMs: number };

const FILE_CREATE_RESERVATION_LEASE_MS = 60_000;
const FILE_CREATE_LOCK_STALE_MS = 30_000;
const DEFAULT_STALE_UPLOAD_TEMP_MS = 6 * 60 * 60 * 1_000;
const DEFAULT_STALE_MANIFEST_TEMP_MS = 6 * 60 * 60 * 1_000;
const DEFAULT_STORAGE_SWEEP_BATCH_SIZE = 200;
const DEFAULT_STORAGE_SWEEP_MAX_BATCHES = 20;
const DEFAULT_STORED_UPLOAD_RETENTION_MS = 30 * 24 * 60 * 60 * 1_000;
const STORAGE_SWEEP_CURSOR_FILENAME = ".retention-sweep-cursor.json";
const PRESALES_FILE_STORAGE_RESERVE_BYTES = 64 * 1024 * 1024;

export type StagedPresalesFile = {
  sizeBytes: number;
  sha256: string;
  createReadStream: () => ReadStream;
  commit: (input: {
    filename?: string;
    mimeType?: string;
    uploadedAt?: Date | string | number;
    contentExpiresAt?: Date | string | number;
  }) => Promise<void>;
  discard: () => Promise<void>;
};

export type StoredPresalesFile = {
  filename: string;
  mimeType: string;
  /**
   * Size recorded by the durable `stored` manifest. `sizeBytes` below is the
   * current filesystem size, so it cannot by itself prove that the bytes still
   * match the copy which was committed after the upstream upload succeeded.
   */
  recordedSizeBytes: number | null;
  sizeBytes: number;
  sha256: string | null;
  uploadedAt: Date | null;
  contentExpiresAt: Date | null;
  /**
   * Best available timestamp for when the local content bytes first landed.
   * Unlike the descriptor manifest's updatedAt, this is not changed by a
   * later filename/MIME refresh and therefore cannot extend a legacy TTL.
   */
  contentStoredAt: Date | null;
  manifestUpdatedAt: Date | null;
  createReadStream: () => ReadStream;
};

export type PresalesFileLifecycle = {
  state: PresalesFileManifest["state"];
  uploadedAt: Date | null;
  contentExpiresAt: Date | null;
  contentDeletedAt: Date | null;
  contentStoredAt: Date | null;
  manifestUpdatedAt: Date | null;
};

export type PresalesFileStorageSweepResult = {
  scannedEntries: number;
  scannedStoredManifests: number;
  deleted: number;
  expiredFilesDeleted: number;
  bytesReclaimed: number;
  reclaimedBytes: number;
  staleTempsDeleted: number;
  staleUploadTempsDeleted: number;
  staleManifestTempsDeleted: number;
  legacyManifestsBackfilled: number;
  orphanContentsDeleted: number;
  legacyOrUnmanagedManifestsSkipped: number;
  invalidManifestsSkipped: number;
  failures: number;
  hasMore: boolean;
  nextCursor: string | null;
};

export type RetainedPresalesFile = {
  fileId: string;
  uploadedAt: Date;
  contentExpiresAt: Date;
};

function storageRoot() {
  const assetRoot = path.resolve(
    process.env.FRONTMIND_DASHBOARD_ASSET_DIR ||
      path.join(process.cwd(), ".frontmind-dashboard-assets"),
  );
  return path.join(assetRoot, "presales-files");
}

function storageKey(fileId: string) {
  return createHash("sha256").update(fileId, "utf8").digest("hex");
}

function storageSweepCursorPath() {
  return path.join(storageRoot(), STORAGE_SWEEP_CURSOR_FILENAME);
}

async function readStorageSweepCursor() {
  try {
    const parsed = JSON.parse(
      await fs.readFile(storageSweepCursorPath(), "utf8"),
    ) as { schemaVersion?: unknown; cursor?: unknown };
    return parsed.schemaVersion === 1 &&
      typeof parsed.cursor === "string" &&
      parsed.cursor.length <= 512
      ? parsed.cursor
      : null;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    return null;
  }
}

async function writeStorageSweepCursor(cursor: string | null) {
  await writeJsonAtomic(storageSweepCursorPath(), {
    schemaVersion: 1,
    cursor,
    updatedAt: new Date().toISOString(),
  });
}

export async function assertPresalesFileStorageWritable(input?: {
  requiredBytes?: number;
}) {
  const root = storageRoot();
  await ensurePrivateDirectory(root);
  const requiredBytes = Math.max(
    1,
    Number.isSafeInteger(input?.requiredBytes)
      ? Number(input?.requiredBytes)
      : 100 * 1024 * 1024,
  );
  const stats = await fs.statfs(root);
  const availableBytes = Number(stats.bavail) * Number(stats.bsize);
  if (
    !Number.isSafeInteger(availableBytes) ||
    availableBytes < requiredBytes + PRESALES_FILE_STORAGE_RESERVE_BYTES
  ) {
    throw new Error("PRESALES_FILE_STORAGE_INSUFFICIENT");
  }
  const probe = path.join(root, `.${randomUUID()}.write-test`);
  try {
    await fs.writeFile(probe, "ok", { mode: 0o600, flag: "wx" });
  } catch {
    throw new Error("PRESALES_FILE_STORAGE_NOT_WRITABLE");
  } finally {
    await fs.rm(probe, { force: true }).catch(() => undefined);
  }
  return { root, availableBytes, requiredBytes };
}

export function hashPresalesFileIdempotencyKey(value: string) {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

export function hashPresalesFileCreatePayload(input: {
  filename: string;
  mimeType?: string;
  sizeBytes?: number;
}) {
  return createHash("sha256")
    .update(
      JSON.stringify({
        filename: input.filename,
        mimeType: input.mimeType ?? null,
        sizeBytes: input.sizeBytes ?? null,
      }),
      "utf8",
    )
    .digest("hex");
}

function reservationRoot() {
  return path.join(storageRoot(), "create-reservations");
}

function reservationPaths(keyHash: string) {
  const root = reservationRoot();
  return {
    root,
    reservation: path.join(root, `${keyHash}.json`),
    lock: path.join(root, `${keyHash}.lock`),
  };
}

function reservationIndexPath(fileId: string) {
  return path.join(reservationRoot(), "by-file", `${storageKey(fileId)}.json`);
}

async function ensurePrivateDirectory(directory: string) {
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  await fs.chmod(directory, 0o700).catch(() => undefined);
}

async function writeJsonAtomic(target: string, value: unknown) {
  await ensurePrivateDirectory(path.dirname(target));
  const temporary = `${target}.${randomUUID()}.tmp`;
  try {
    await fs.writeFile(temporary, `${JSON.stringify(value)}\n`, {
      encoding: "utf8",
      mode: 0o600,
      flag: "wx",
    });
    await fs.rename(temporary, target);
  } finally {
    await fs.rm(temporary, { force: true }).catch(() => undefined);
  }
}

function parseReservation(
  value: unknown,
  expectedKeyHash: string,
): PresalesFileCreateReservation {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("PRESALES_FILE_RESERVATION_INVALID");
  }
  const record = value as Partial<PresalesFileCreateReservation>;
  if (
    record.schemaVersion !== 1 ||
    record.keyHash !== expectedKeyHash ||
    typeof record.requestHash !== "string" ||
    typeof record.apiCredentialId !== "string" ||
    !Number.isSafeInteger(record.credentialVersion) ||
    (record.status !== "pending" &&
      record.status !== "completed" &&
      record.status !== "deleted") ||
    typeof record.attemptId !== "string" ||
    !Number.isFinite(Date.parse(String(record.leaseExpiresAt))) ||
    (record.upstreamFileId !== null &&
      typeof record.upstreamFileId !== "string") ||
    (record.upstreamFilename !== null &&
      typeof record.upstreamFilename !== "string") ||
    (record.upstreamStatus !== null &&
      typeof record.upstreamStatus !== "string") ||
    (record.uploadUrl !== null && typeof record.uploadUrl !== "string") ||
    (record.uploadExpiresAt !== null &&
      typeof record.uploadExpiresAt !== "string" &&
      typeof record.uploadExpiresAt !== "number") ||
    !Number.isFinite(Date.parse(String(record.createdAt))) ||
    !Number.isFinite(Date.parse(String(record.updatedAt))) ||
    (record.completedAt !== null &&
      !Number.isFinite(Date.parse(String(record.completedAt)))) ||
    (record.deletedAt !== null &&
      !Number.isFinite(Date.parse(String(record.deletedAt))))
  ) {
    throw new Error("PRESALES_FILE_RESERVATION_INVALID");
  }
  return record as PresalesFileCreateReservation;
}

async function readReservation(keyHash: string) {
  const { reservation } = reservationPaths(keyHash);
  try {
    return parseReservation(
      JSON.parse(await fs.readFile(reservation, "utf8")),
      keyHash,
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

async function withReservationLock<T>(
  keyHash: string,
  operation: () => Promise<T>,
): Promise<T> {
  const { root, lock } = reservationPaths(keyHash);
  await ensurePrivateDirectory(root);
  for (let attempt = 0; attempt < 20; attempt += 1) {
    try {
      const handle = await fs.open(lock, "wx", 0o600);
      try {
        return await operation();
      } finally {
        await handle.close().catch(() => undefined);
        await fs.rm(lock, { force: true }).catch(() => undefined);
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const stats = await fs.stat(lock).catch(() => null);
      if (stats && Date.now() - stats.mtimeMs > FILE_CREATE_LOCK_STALE_MS) {
        await fs.rm(lock, { force: true }).catch(() => undefined);
        continue;
      }
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }
  throw new Error("PRESALES_FILE_RESERVATION_LOCKED");
}

function completedReservationResult(
  reservation: PresalesFileCreateReservation,
): PresalesFileCreateReservationResult {
  if (!reservation.upstreamFileId) {
    throw new Error("PRESALES_FILE_RESERVATION_INVALID");
  }
  return {
    state: "completed",
    upstreamFileId: reservation.upstreamFileId,
    upstreamFilename: reservation.upstreamFilename,
    upstreamStatus: reservation.upstreamStatus,
    uploadUrl: reservation.uploadUrl,
    uploadExpiresAt: reservation.uploadExpiresAt,
  };
}

export async function acquirePresalesFileCreateReservation(input: {
  idempotencyKey: string;
  requestHash: string;
  apiCredentialId: string;
  credentialVersion: number;
  now?: Date;
  leaseMs?: number;
}): Promise<PresalesFileCreateReservationResult> {
  const keyHash = hashPresalesFileIdempotencyKey(input.idempotencyKey);
  const now = input.now ?? new Date();
  const leaseMs = input.leaseMs ?? FILE_CREATE_RESERVATION_LEASE_MS;
  const paths = reservationPaths(keyHash);
  await ensurePrivateDirectory(paths.root);

  const createPendingReservation = () => {
    const attemptId = randomUUID();
    const leaseExpiresAt = new Date(now.getTime() + leaseMs);
    const timestamp = now.toISOString();
    return {
      reservation: {
        schemaVersion: 1 as const,
        keyHash,
        requestHash: input.requestHash,
        apiCredentialId: input.apiCredentialId,
        credentialVersion: input.credentialVersion,
        status: "pending" as const,
        attemptId,
        leaseExpiresAt: leaseExpiresAt.toISOString(),
        upstreamFileId: null,
        upstreamFilename: null,
        upstreamStatus: null,
        uploadUrl: null,
        uploadExpiresAt: null,
        createdAt: timestamp,
        updatedAt: timestamp,
        completedAt: null,
        deletedAt: null,
      },
      result: {
        state: "acquired" as const,
        keyHash,
        attemptId,
        leaseExpiresAt,
      },
    };
  };

  const fresh = createPendingReservation();
  try {
    await fs.writeFile(
      paths.reservation,
      `${JSON.stringify(fresh.reservation)}\n`,
      { encoding: "utf8", mode: 0o600, flag: "wx" },
    );
    return fresh.result;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }

  return withReservationLock(keyHash, async () => {
    const current = await readReservation(keyHash);
    if (!current) {
      const replacement = createPendingReservation();
      await writeJsonAtomic(paths.reservation, replacement.reservation);
      return replacement.result;
    }
    if (current.requestHash !== input.requestHash) {
      return { state: "conflict" };
    }
    // A completed operation is immutable. If its HTTP response was lost, a
    // retry after API-key rotation must return the one file already created,
    // rather than conflict or create a second file in another account. The
    // caller will copy that file under a new generation before creating any
    // task with the current credential. Deleted operations keep the same
    // cross-rotation tombstone barrier.
    if (current.status === "completed") {
      return completedReservationResult(current);
    }
    if (current.status === "deleted") {
      if (!current.upstreamFileId) {
        throw new Error("PRESALES_FILE_RESERVATION_INVALID");
      }
      return {
        state: "deleted",
        upstreamFileId: current.upstreamFileId,
      };
    }
    if (
      current.apiCredentialId !== input.apiCredentialId ||
      current.credentialVersion !== input.credentialVersion
    ) {
      return { state: "conflict" };
    }
    const remainingMs = Date.parse(current.leaseExpiresAt) - now.getTime();
    if (remainingMs > 0) {
      return {
        state: "pending",
        retryAfterMs: Math.max(1_000, Math.min(remainingMs, 5_000)),
      };
    }
    const replacement = createPendingReservation();
    await writeJsonAtomic(paths.reservation, {
      ...current,
      attemptId: replacement.reservation.attemptId,
      leaseExpiresAt: replacement.reservation.leaseExpiresAt,
      updatedAt: replacement.reservation.updatedAt,
    });
    return replacement.result;
  });
}

export async function releasePresalesFileCreateReservation(input: {
  keyHash: string;
  attemptId: string;
}) {
  await withReservationLock(input.keyHash, async () => {
    const current = await readReservation(input.keyHash);
    if (
      current?.status === "pending" &&
      current.attemptId === input.attemptId
    ) {
      await fs.rm(reservationPaths(input.keyHash).reservation, { force: true });
    }
  });
}

export async function completePresalesFileCreateReservation(input: {
  keyHash: string;
  attemptId: string;
  upstreamFileId: string;
  upstreamFilename?: string;
  upstreamStatus?: string;
  uploadUrl?: string;
  uploadExpiresAt?: string | number;
  now?: Date;
}) {
  await withReservationLock(input.keyHash, async () => {
    const current = await readReservation(input.keyHash);
    if (!current) throw new Error("PRESALES_FILE_RESERVATION_NOT_FOUND");
    if (current.status === "completed") {
      if (current.upstreamFileId === input.upstreamFileId) return;
      throw new Error("PRESALES_FILE_RESERVATION_CONFLICT");
    }
    if (current.status === "deleted") {
      throw new Error("PRESALES_FILE_RESERVATION_RETIRED");
    }
    if (current.attemptId !== input.attemptId) {
      throw new Error("PRESALES_FILE_RESERVATION_LEASE_LOST");
    }
    const index: PresalesFileCreateIndex = {
      schemaVersion: 1,
      upstreamFileId: input.upstreamFileId,
      keyHash: input.keyHash,
    };
    await writeJsonAtomic(reservationIndexPath(input.upstreamFileId), index);
    const now = input.now ?? new Date();
    await writeJsonAtomic(reservationPaths(input.keyHash).reservation, {
      ...current,
      status: "completed",
      upstreamFileId: input.upstreamFileId,
      upstreamFilename: input.upstreamFilename ?? null,
      upstreamStatus: input.upstreamStatus ?? null,
      uploadUrl: input.uploadUrl ?? null,
      uploadExpiresAt: input.uploadExpiresAt ?? null,
      leaseExpiresAt: now.toISOString(),
      updatedAt: now.toISOString(),
      completedAt: now.toISOString(),
    } satisfies PresalesFileCreateReservation);
  });
}

export async function removePresalesFileCreateReservation(fileId: string) {
  const indexPath = reservationIndexPath(fileId);
  let index: PresalesFileCreateIndex | null = null;
  try {
    const parsed = JSON.parse(
      await fs.readFile(indexPath, "utf8"),
    ) as Partial<PresalesFileCreateIndex>;
    if (
      parsed.schemaVersion === 1 &&
      parsed.upstreamFileId === fileId &&
      typeof parsed.keyHash === "string" &&
      /^[a-f0-9]{64}$/.test(parsed.keyHash)
    ) {
      index = parsed as PresalesFileCreateIndex;
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  if (!index) {
    await fs.rm(indexPath, { force: true });
    return;
  }
  await withReservationLock(index.keyHash, async () => {
    const current = await readReservation(index!.keyHash);
    if (current?.upstreamFileId === fileId) {
      const now = new Date().toISOString();
      // Keep a compact permanent tombstone. Deleting the operation identity
      // would let a delayed retry recreate an already-cleaned temporary file.
      // Signed upload capabilities and filenames are discarded here, while
      // the hashed operation/request binding remains as the reuse barrier.
      await writeJsonAtomic(reservationPaths(index!.keyHash).reservation, {
        ...current,
        status: "deleted",
        upstreamFilename: null,
        upstreamStatus: null,
        uploadUrl: null,
        uploadExpiresAt: null,
        leaseExpiresAt: now,
        updatedAt: now,
        deletedAt: now,
      } satisfies PresalesFileCreateReservation);
    }
    await fs.rm(indexPath, { force: true });
  });
}

function pathsFor(fileId: string) {
  const root = storageRoot();
  const key = storageKey(fileId);
  return {
    root,
    content: path.join(root, `${key}.content`),
    manifest: path.join(root, `${key}.json`),
  };
}

function cleanFilename(value: unknown, fallback: string) {
  const normalized = String(value || "")
    .replace(/[\u0000-\u001f\u007f]/g, "")
    .replace(/[\\/]/g, "_")
    .trim();
  return normalized ? normalized.slice(0, 512) : fallback;
}

function cleanMimeType(value: unknown) {
  const normalized = String(value || "")
    .replace(/[\r\n]/g, "")
    .trim();
  return normalized && normalized.length <= 255
    ? normalized
    : "application/octet-stream";
}

function normalizedRetentionTimestamp(
  value: Date | string | number | null | undefined,
) {
  if (value === null || value === undefined || value === "") return undefined;
  const timestamp =
    value instanceof Date
      ? value.getTime()
      : typeof value === "number"
        ? value
        : Date.parse(value);
  return Number.isFinite(timestamp)
    ? new Date(timestamp).toISOString()
    : undefined;
}

function localFileOriginMs(
  stats:
    | Pick<Awaited<ReturnType<typeof fs.stat>>, "birthtimeMs" | "mtimeMs">
    | null
    | undefined,
) {
  if (!stats) return 0;
  // Node's Stats type can expose nanosecond-capable bigint fields depending
  // on how it was obtained. Normalize at this boundary so retention math is
  // always ordinary epoch milliseconds.
  const rawMtimeMs = Number(stats.mtimeMs);
  const rawBirthtimeMs = Number(stats.birthtimeMs);
  const mtimeMs =
    Number.isFinite(rawMtimeMs) && rawMtimeMs > 0 ? rawMtimeMs : 0;
  const birthtimeMs =
    Number.isFinite(rawBirthtimeMs) && rawBirthtimeMs > 0 ? rawBirthtimeMs : 0;
  // Some filesystems report a synthetic birthtime later than a backdated
  // mtime. Treat that as untrustworthy; otherwise birthtime is the only local
  // timestamp that survives descriptor rewrites and ordinary mtime changes.
  if (birthtimeMs > 0 && (!mtimeMs || birthtimeMs <= mtimeMs + 1_000)) {
    return birthtimeMs;
  }
  return mtimeMs || birthtimeMs;
}

type ManifestRetention =
  | { state: "unmanaged" }
  | { state: "invalid" }
  | { state: "managed"; uploadedAt: string; contentExpiresAt: string };

function manifestRetention(
  manifest: Pick<PresalesFileManifest, "uploadedAt" | "contentExpiresAt">,
): ManifestRetention {
  const hasUploadedAt = manifest.uploadedAt !== undefined;
  const hasContentExpiresAt = manifest.contentExpiresAt !== undefined;
  if (!hasUploadedAt && !hasContentExpiresAt) return { state: "unmanaged" };
  const uploadedAt = normalizedRetentionTimestamp(manifest.uploadedAt);
  const contentExpiresAt = normalizedRetentionTimestamp(
    manifest.contentExpiresAt,
  );
  if (
    !uploadedAt ||
    !contentExpiresAt ||
    Date.parse(contentExpiresAt) <= Date.parse(uploadedAt)
  ) {
    return { state: "invalid" };
  }
  return { state: "managed", uploadedAt, contentExpiresAt };
}

function immutableManifestRetention(
  previous: Partial<PresalesFileManifest> | null,
  input: {
    uploadedAt?: Date | string | number;
    contentExpiresAt?: Date | string | number;
  },
) {
  const previousRetention = previous
    ? manifestRetention(previous)
    : ({ state: "unmanaged" } as const);
  if (previousRetention.state === "managed") {
    return {
      uploadedAt: previousRetention.uploadedAt,
      contentExpiresAt: previousRetention.contentExpiresAt,
    };
  }
  if (previousRetention.state === "invalid") {
    throw new Error("PRESALES_FILE_RETENTION_INVALID");
  }

  const supplied =
    input.uploadedAt !== undefined || input.contentExpiresAt !== undefined;
  if (!supplied) return {};
  const uploadedAt = normalizedRetentionTimestamp(input.uploadedAt);
  const contentExpiresAt = normalizedRetentionTimestamp(input.contentExpiresAt);
  if (
    !uploadedAt ||
    !contentExpiresAt ||
    Date.parse(contentExpiresAt) <= Date.parse(uploadedAt)
  ) {
    throw new Error("PRESALES_FILE_RETENTION_INVALID");
  }
  return { uploadedAt, contentExpiresAt };
}

async function readManifest(fileId: string) {
  const { manifest } = pathsFor(fileId);
  try {
    const parsed = JSON.parse(
      await fs.readFile(manifest, "utf8"),
    ) as Partial<PresalesFileManifest>;
    if (parsed.schemaVersion !== 1 || parsed.fileId !== fileId) return null;
    return parsed;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

async function writeManifest(fileId: string, value: PresalesFileManifest) {
  const { root, manifest } = pathsFor(fileId);
  await fs.mkdir(root, { recursive: true, mode: 0o700 });
  await fs.chmod(root, 0o700).catch(() => undefined);
  const temporary = `${manifest}.${randomUUID()}.tmp`;
  try {
    await fs.writeFile(temporary, `${JSON.stringify(value)}\n`, {
      encoding: "utf8",
      mode: 0o600,
      flag: "wx",
    });
    await fs.rename(temporary, manifest);
  } finally {
    await fs.rm(temporary, { force: true }).catch(() => undefined);
  }
}

export async function recordPresalesFileDescriptor(input: {
  fileId: string;
  filename: string;
  mimeType?: string;
  sizeBytes?: number;
}) {
  const previous = await readManifest(input.fileId);
  const previousStored = previous?.state === "stored";
  const previousExpired = previous?.state === "expired";
  await writeManifest(input.fileId, {
    schemaVersion: 1,
    fileId: input.fileId,
    filename: cleanFilename(input.filename, input.fileId),
    mimeType: cleanMimeType(input.mimeType),
    sizeBytes:
      previousStored && Number.isSafeInteger(previous.sizeBytes)
        ? Number(previous.sizeBytes)
        : Number.isSafeInteger(input.sizeBytes) && Number(input.sizeBytes) >= 0
          ? Number(input.sizeBytes)
          : null,
    sha256:
      previousStored && typeof previous.sha256 === "string"
        ? previous.sha256
        : null,
    state: previousStored ? "stored" : previousExpired ? "expired" : "pending",
    ...immutableManifestRetention(previous, {}),
    ...(previousExpired &&
    normalizedRetentionTimestamp(previous.contentDeletedAt)
      ? {
          contentDeletedAt: normalizedRetentionTimestamp(
            previous.contentDeletedAt,
          ),
        }
      : {}),
    updatedAt: new Date().toISOString(),
  });
}

export async function stagePresalesFileContent(input: {
  fileId: string;
  stream: Readable;
  maxBytes: number;
}): Promise<StagedPresalesFile> {
  await assertPresalesFileStorageWritable({ requiredBytes: input.maxBytes });
  const paths = pathsFor(input.fileId);
  await fs.mkdir(paths.root, { recursive: true, mode: 0o700 });
  await fs.chmod(paths.root, 0o700).catch(() => undefined);
  const temporary = path.join(
    paths.root,
    `${storageKey(input.fileId)}.${randomUUID()}.upload.tmp`,
  );
  let sizeBytes = 0;
  const hash = createHash("sha256");
  const limiter = new Transform({
    transform(chunk, _encoding, callback) {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      sizeBytes += bytes.length;
      if (sizeBytes > input.maxBytes) {
        callback(new Error("FILE_TOO_LARGE"));
        return;
      }
      hash.update(bytes);
      callback(null, bytes);
    },
  });

  try {
    await pipeline(
      input.stream,
      limiter,
      createWriteStream(temporary, { flags: "wx", mode: 0o600 }),
    );
  } catch (error) {
    await fs.rm(temporary, { force: true }).catch(() => undefined);
    throw error;
  }

  const sha256 = hash.digest("hex");
  let consumed = false;
  const discard = async () => {
    if (consumed) return;
    consumed = true;
    await fs.rm(temporary, { force: true }).catch(() => undefined);
  };

  return {
    sizeBytes,
    sha256,
    createReadStream: () => createReadStream(temporary),
    discard,
    commit: async (commitInput) => {
      if (consumed) throw new Error("STAGED_FILE_ALREADY_CONSUMED");
      let renamed = false;
      try {
        const { filename, mimeType } = commitInput;
        const previous = await readManifest(input.fileId);
        const retention = immutableManifestRetention(previous, commitInput);
        const manifest: PresalesFileManifest = {
          schemaVersion: 1,
          fileId: input.fileId,
          filename: cleanFilename(
            filename ?? previous?.filename,
            input.fileId,
          ),
          mimeType: cleanMimeType(mimeType ?? previous?.mimeType),
          sizeBytes,
          sha256,
          state: "stored",
          ...retention,
          updatedAt: new Date().toISOString(),
        };
        await fs.rename(temporary, paths.content);
        renamed = true;
        consumed = true;
        await writeManifest(input.fileId, manifest);
      } catch (error) {
        consumed = true;
        await Promise.all([
          fs.rm(temporary, { force: true }).catch(() => undefined),
          renamed
            ? fs.rm(paths.content, { force: true }).catch(() => undefined)
            : Promise.resolve(),
        ]);
        throw error;
      }
    },
  };
}

export async function readStoredPresalesFile(
  fileId: string,
): Promise<StoredPresalesFile | null> {
  const paths = pathsFor(fileId);
  let stats;
  try {
    stats = await fs.stat(paths.content);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  if (!stats.isFile() || stats.size <= 0) {
    throw new Error("LOCAL_FILE_CONTENT_INVALID");
  }
  const manifest = await readManifest(fileId);
  if (
    manifest?.state === "stored" &&
    Number.isSafeInteger(manifest.sizeBytes) &&
    manifest.sizeBytes !== stats.size
  ) {
    throw new Error("LOCAL_FILE_CONTENT_SIZE_MISMATCH");
  }
  const retention = manifest
    ? manifestRetention(manifest)
    : ({ state: "unmanaged" } as const);
  if (retention.state === "invalid") {
    throw new Error("PRESALES_FILE_RETENTION_INVALID");
  }
  return {
    filename: cleanFilename(manifest?.filename, fileId),
    mimeType: cleanMimeType(manifest?.mimeType),
    recordedSizeBytes:
      manifest?.state === "stored" &&
      Number.isSafeInteger(manifest.sizeBytes) &&
      Number(manifest.sizeBytes) > 0
        ? Number(manifest.sizeBytes)
        : null,
    sizeBytes: stats.size,
    sha256: typeof manifest?.sha256 === "string" ? manifest.sha256 : null,
    uploadedAt:
      retention.state === "managed" ? new Date(retention.uploadedAt) : null,
    contentExpiresAt:
      retention.state === "managed"
        ? new Date(retention.contentExpiresAt)
        : null,
    contentStoredAt: localFileOriginMs(stats)
      ? new Date(localFileOriginMs(stats))
      : null,
    manifestUpdatedAt: normalizedRetentionTimestamp(manifest?.updatedAt)
      ? new Date(String(manifest?.updatedAt))
      : null,
    createReadStream: () => createReadStream(paths.content),
  };
}

/**
 * Reads the compact lifecycle ledger independently of the content bytes.
 * This is the authorization source for internal Website uploads: an expired
 * tombstone must continue to block an upstream re-download after the local
 * bytes have been reclaimed.
 */
export async function readPresalesFileLifecycle(
  fileId: string,
): Promise<PresalesFileLifecycle | null> {
  const manifest = await readManifest(fileId);
  if (!manifest) return null;
  const retention = manifestRetention(manifest);
  if (retention.state === "invalid") {
    throw new Error("PRESALES_FILE_RETENTION_INVALID");
  }
  const contentStats = await fs
    .stat(pathsFor(fileId).content)
    .catch((error) => {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    });
  const updatedAt = normalizedRetentionTimestamp(manifest.updatedAt);
  const deletedAt = normalizedRetentionTimestamp(manifest.contentDeletedAt);
  return {
    state:
      manifest.state === "stored" || manifest.state === "expired"
        ? manifest.state
        : "pending",
    uploadedAt:
      retention.state === "managed" ? new Date(retention.uploadedAt) : null,
    contentExpiresAt:
      retention.state === "managed"
        ? new Date(retention.contentExpiresAt)
        : null,
    contentDeletedAt: deletedAt ? new Date(deletedAt) : null,
    contentStoredAt: localFileOriginMs(contentStats)
      ? new Date(localFileOriginMs(contentStats))
      : null,
    manifestUpdatedAt: updatedAt ? new Date(updatedAt) : null,
  };
}

/**
 * Adds the immutable hard deadline to a legacy stored manifest without
 * rewriting its bytes. Missing content is a normal false result; a write
 * failure is surfaced so a backfill cannot claim durability it did not create.
 */
export async function markStoredPresalesFileRetention(input: {
  fileId: string;
  uploadedAt: Date | string | number;
  contentExpiresAt: Date | string | number;
}) {
  const previous = await readManifest(input.fileId);
  if (previous?.state !== "stored") return false;
  const retention = immutableManifestRetention(previous, input);
  await writeManifest(input.fileId, {
    schemaVersion: 1,
    fileId: input.fileId,
    filename: cleanFilename(previous.filename, input.fileId),
    mimeType: cleanMimeType(previous.mimeType),
    sizeBytes:
      Number.isSafeInteger(previous.sizeBytes) &&
      Number(previous.sizeBytes) >= 0
        ? Number(previous.sizeBytes)
        : null,
    sha256: typeof previous.sha256 === "string" ? previous.sha256 : null,
    state: "stored",
    ...retention,
    // Preserve the original local commit timestamp for auditable backfills.
    updatedAt:
      normalizedRetentionTimestamp(previous.updatedAt) ??
      new Date().toISOString(),
  });
  return true;
}

export async function removeStoredPresalesFile(fileId: string) {
  const paths = pathsFor(fileId);
  await Promise.all([
    fs.rm(paths.content, { force: true }),
    fs.rm(paths.manifest, { force: true }),
  ]);
}

/** Remove damaged bytes while retaining their immutable lifecycle ledger. */
export async function removeStoredPresalesFileContent(fileId: string) {
  await fs.rm(pathsFor(fileId).content, { force: true });
}

function boundedPositiveInteger(
  value: number | undefined,
  fallback: number,
  maximum: number,
) {
  return Number.isSafeInteger(value) && Number(value) > 0
    ? Math.min(Number(value), maximum)
    : fallback;
}

/**
 * Filesystem-only retention fallback. This intentionally does not consult the
 * database, so it can reclaim an expired upload even after its ownership row
 * disappeared through a user/project cascade.
 *
 * Callers can resume a bounded scan with `nextCursor`. A null cursor means the
 * root was fully scanned; a later scheduled run should begin again without a
 * cursor so newly expired files are reconsidered.
 */
export async function sweepPresalesFileStorageRetention(
  input: {
    now?: Date;
    batchSize?: number;
    maxBatches?: number;
    cursor?: string | null;
    /**
     * Production leaves `cursor` undefined and persists progress beside the
     * files. Explicit cursors remain useful for deterministic tests and tools.
     */
    persistCursor?: boolean;
    staleUploadTempMs?: number;
    /**
     * Crash remnants from the atomic manifest writer. The exact UUID-shaped
     * filename is required so unrelated temporary files are never guessed at.
     */
    staleManifestTempMs?: number;
    onRetainedFile?: (input: RetainedPresalesFile) => void | Promise<void>;
    onExpiredFile?: (input: {
      fileId: string;
      sizeBytes: number;
    }) => void | Promise<void>;
    /**
     * Authorizes age-based removal when the filename hash cannot be tied to a
     * trustworthy manifest. A database-aware caller uses this to ensure an
     * owned file has first received (and reached) its hard deadline. Without
     * the hook malformed manifests fail closed; a genuinely manifest-less
     * crash orphan may still use the conservative 30-day fallback.
     */
    canDeleteUnidentifiedFile?: (input: {
      storageKey: string;
      observedAt: Date;
    }) => boolean | Promise<boolean>;
  } = {},
): Promise<PresalesFileStorageSweepResult> {
  const now = input.now ?? new Date();
  if (!Number.isFinite(now.getTime())) {
    throw new Error("PRESALES_FILE_SWEEP_NOW_INVALID");
  }
  const batchSize = boundedPositiveInteger(
    input.batchSize,
    DEFAULT_STORAGE_SWEEP_BATCH_SIZE,
    1_000,
  );
  const maxBatches = boundedPositiveInteger(
    input.maxBatches,
    DEFAULT_STORAGE_SWEEP_MAX_BATCHES,
    100,
  );
  const staleUploadTempMs =
    Number.isFinite(input.staleUploadTempMs) &&
    Number(input.staleUploadTempMs) >= 0
      ? Number(input.staleUploadTempMs)
      : DEFAULT_STALE_UPLOAD_TEMP_MS;
  const staleManifestTempMs =
    Number.isFinite(input.staleManifestTempMs) &&
    Number(input.staleManifestTempMs) >= 0
      ? Number(input.staleManifestTempMs)
      : DEFAULT_STALE_MANIFEST_TEMP_MS;
  const result: PresalesFileStorageSweepResult = {
    scannedEntries: 0,
    scannedStoredManifests: 0,
    deleted: 0,
    expiredFilesDeleted: 0,
    bytesReclaimed: 0,
    reclaimedBytes: 0,
    staleTempsDeleted: 0,
    staleUploadTempsDeleted: 0,
    staleManifestTempsDeleted: 0,
    legacyManifestsBackfilled: 0,
    orphanContentsDeleted: 0,
    legacyOrUnmanagedManifestsSkipped: 0,
    invalidManifestsSkipped: 0,
    failures: 0,
    hasMore: false,
    nextCursor: null,
  };
  const canDeleteUnidentified = async (
    storageHash: string,
    observedAtMs: number,
    fallbackWithoutHook: boolean,
  ) => {
    if (!input.canDeleteUnidentifiedFile) return fallbackWithoutHook;
    try {
      return await input.canDeleteUnidentifiedFile({
        storageKey: storageHash,
        observedAt: new Date(Number(observedAtMs)),
      });
    } catch {
      result.failures += 1;
      return false;
    }
  };

  let entries;
  try {
    entries = await fs.readdir(storageRoot(), { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return result;
    throw error;
  }

  const manifestNames = new Set(
    entries
      .filter(
        (entry) => entry.isFile() && /^[a-f0-9]{64}\.json$/.test(entry.name),
      )
      .map((entry) => entry.name),
  );
  const persistCursor = input.persistCursor ?? input.cursor === undefined;
  const startCursor =
    input.cursor === undefined ? await readStorageSweepCursor() : input.cursor;
  const candidates = entries
    .filter(
      (entry) =>
        entry.isFile() &&
        (/^[a-f0-9]{64}\.json$/.test(entry.name) ||
          /^[a-f0-9]{64}\.content$/.test(entry.name) ||
          entry.name.endsWith(".upload.tmp") ||
          /^[a-f0-9]{64}\.json\.[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.tmp$/.test(
            entry.name,
          )),
    )
    .map((entry) => entry.name)
    .sort()
    .filter((name) => !startCursor || name > startCursor);
  const scanLimit = batchSize * maxBatches;
  const selected = candidates.slice(0, scanLimit);
  result.hasMore = candidates.length > selected.length;
  result.nextCursor = result.hasMore ? (selected.at(-1) ?? null) : null;

  for (const name of selected) {
    result.scannedEntries += 1;
    const entryPath = path.join(storageRoot(), name);
    if (name.endsWith(".upload.tmp")) {
      try {
        const stats = await fs.stat(entryPath);
        if (
          stats.isFile() &&
          stats.mtimeMs <= now.getTime() - staleUploadTempMs
        ) {
          await fs.rm(entryPath, { force: true });
          result.bytesReclaimed += stats.size;
          result.reclaimedBytes += stats.size;
          result.staleTempsDeleted += 1;
          result.staleUploadTempsDeleted += 1;
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
          result.failures += 1;
        }
      }
      continue;
    }

    if (
      /^[a-f0-9]{64}\.json\.[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.tmp$/.test(
        name,
      )
    ) {
      try {
        const stats = await fs.stat(entryPath);
        if (
          stats.isFile() &&
          stats.mtimeMs <= now.getTime() - staleManifestTempMs
        ) {
          await fs.rm(entryPath, { force: true });
          result.bytesReclaimed += stats.size;
          result.reclaimedBytes += stats.size;
          result.staleTempsDeleted += 1;
          result.staleManifestTempsDeleted += 1;
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
          result.failures += 1;
        }
      }
      continue;
    }

    if (name.endsWith(".content")) {
      const key = name.slice(0, -".content".length);
      // A manifest (including one on a later page) owns the lifecycle. Only a
      // truly manifest-less content file is eligible for the age-based crash
      // recovery fallback.
      if (manifestNames.has(`${key}.json`)) continue;
      try {
        const stats = await fs.stat(entryPath);
        if (
          stats.isFile() &&
          stats.mtimeMs <= now.getTime() - DEFAULT_STORED_UPLOAD_RETENTION_MS
        ) {
          const allowed = await canDeleteUnidentified(
            key,
            Number(stats.mtimeMs),
            true,
          );
          if (!allowed) continue;
          await fs.rm(entryPath, { force: true });
          result.deleted += 1;
          result.expiredFilesDeleted += 1;
          result.orphanContentsDeleted += 1;
          result.bytesReclaimed += stats.size;
          result.reclaimedBytes += stats.size;
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
          result.failures += 1;
        }
      }
      continue;
    }

    let manifest: Partial<PresalesFileManifest>;
    try {
      manifest = JSON.parse(
        await fs.readFile(entryPath, "utf8"),
      ) as Partial<PresalesFileManifest>;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      result.invalidManifestsSkipped += 1;
      // A corrupt manifest has no trustworthy file id. Keep anything recent;
      // once both the manifest and same-hash content are at least 30 days old,
      // reclaim them as an abandoned local upload without guessing ownership.
      const contentPath = entryPath.replace(/\.json$/u, ".content");
      try {
        const [manifestStats, contentStats] = await Promise.all([
          fs.stat(entryPath).catch(() => null),
          fs.stat(contentPath).catch(() => null),
        ]);
        const newestMtime = Math.max(
          manifestStats?.mtimeMs ?? 0,
          contentStats?.mtimeMs ?? 0,
        );
        if (
          newestMtime > 0 &&
          newestMtime <= now.getTime() - DEFAULT_STORED_UPLOAD_RETENTION_MS
        ) {
          const storageHash = name.slice(0, -".json".length);
          const allowed = await canDeleteUnidentified(
            storageHash,
            Number(newestMtime),
            false,
          );
          if (!allowed) continue;
          await Promise.all([
            fs.rm(entryPath, { force: true }),
            fs.rm(contentPath, { force: true }),
          ]);
          result.deleted += 1;
          result.expiredFilesDeleted += 1;
          result.orphanContentsDeleted += 1;
          result.bytesReclaimed += contentStats?.size ?? 0;
          result.reclaimedBytes += contentStats?.size ?? 0;
        }
      } catch {
        result.failures += 1;
      }
      continue;
    }
    if (
      manifest.schemaVersion === 1 &&
      manifest.state === "expired" &&
      typeof manifest.fileId === "string" &&
      `${storageKey(manifest.fileId)}.json` === name
    ) {
      const retention = manifestRetention(manifest);
      const deletedAt = normalizedRetentionTimestamp(manifest.contentDeletedAt);
      if (retention.state !== "managed" || !deletedAt) {
        result.invalidManifestsSkipped += 1;
        continue;
      }
      // A compact tombstone is deliberately retained. It is the only durable
      // evidence available to the internal presales resolver after the bytes
      // have been reclaimed, and prevents an expired upstream file from being
      // silently downloaded and granted a fresh lifetime.
      try {
        const contentPath = pathsFor(manifest.fileId).content;
        const contentStats = await fs.stat(contentPath).catch((error) => {
          if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
          throw error;
        });
        if (contentStats?.isFile()) {
          await fs.rm(contentPath, { force: true });
          result.bytesReclaimed += contentStats.size;
          result.reclaimedBytes += contentStats.size;
        }
      } catch {
        result.failures += 1;
      }
      continue;
    }
    if (
      manifest.schemaVersion !== 1 ||
      manifest.state !== "stored" ||
      typeof manifest.fileId !== "string" ||
      `${storageKey(manifest.fileId)}.json` !== name
    ) {
      result.invalidManifestsSkipped += 1;
      // Valid JSON can still be an unusable/foreign manifest. Apply the same
      // conservative crash-recovery rule as malformed JSON: only remove the
      // same-hash pair after both entries have been untouched for 30 days.
      const contentPath = entryPath.replace(/\.json$/u, ".content");
      try {
        const [invalidManifestStats, invalidContentStats] = await Promise.all([
          fs.stat(entryPath).catch(() => null),
          fs.stat(contentPath).catch(() => null),
        ]);
        const newestMtime = Math.max(
          invalidManifestStats?.mtimeMs ?? 0,
          invalidContentStats?.mtimeMs ?? 0,
        );
        if (
          newestMtime > 0 &&
          newestMtime <= now.getTime() - DEFAULT_STORED_UPLOAD_RETENTION_MS
        ) {
          const storageHash = name.slice(0, -".json".length);
          const allowed = await canDeleteUnidentified(
            storageHash,
            Number(newestMtime),
            false,
          );
          if (!allowed) continue;
          await Promise.all([
            fs.rm(entryPath, { force: true }),
            fs.rm(contentPath, { force: true }),
          ]);
          result.deleted += 1;
          result.expiredFilesDeleted += 1;
          result.orphanContentsDeleted += 1;
          result.bytesReclaimed += invalidContentStats?.size ?? 0;
          result.reclaimedBytes += invalidContentStats?.size ?? 0;
        }
      } catch {
        result.failures += 1;
      }
      continue;
    }
    result.scannedStoredManifests += 1;
    const manifestFileId = manifest.fileId;
    const storedPaths = pathsFor(manifestFileId);
    const [manifestStats, contentStats] = await Promise.all([
      fs.stat(entryPath).catch(() => null),
      fs.stat(storedPaths.content).catch((error) => {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
        throw error;
      }),
    ]);
    let retention = manifestRetention(manifest);
    if (retention.state !== "managed") {
      const updatedAt = normalizedRetentionTimestamp(manifest.updatedAt);
      const uploadedAt = normalizedRetentionTimestamp(manifest.uploadedAt);
      // The content file is renamed into place only after the upload stream is
      // complete. Its birthtime (or trustworthy mtime fallback) is therefore
      // the immutable local upload clock. Manifest updatedAt is deliberately
      // excluded because descriptor refreshes may rewrite it months later.
      const originMs =
        localFileOriginMs(contentStats) ||
        (uploadedAt ? Date.parse(uploadedAt) : 0) ||
        localFileOriginMs(manifestStats);
      if (!Number.isFinite(originMs) || originMs <= 0) {
        if (retention.state === "invalid") {
          result.invalidManifestsSkipped += 1;
        } else {
          result.legacyOrUnmanagedManifestsSkipped += 1;
        }
        continue;
      }
      const origin = new Date(originMs);
      const expiry = new Date(originMs + DEFAULT_STORED_UPLOAD_RETENTION_MS);
      const repaired: PresalesFileManifest = {
        schemaVersion: 1,
        fileId: manifestFileId,
        filename: cleanFilename(manifest.filename, manifestFileId),
        mimeType: cleanMimeType(manifest.mimeType),
        sizeBytes:
          Number.isSafeInteger(manifest.sizeBytes) &&
          Number(manifest.sizeBytes) >= 0
            ? Number(manifest.sizeBytes)
            : (contentStats?.size ?? null),
        sha256: typeof manifest.sha256 === "string" ? manifest.sha256 : null,
        state: manifest.state,
        uploadedAt: origin.toISOString(),
        contentExpiresAt: expiry.toISOString(),
        updatedAt: updatedAt ?? origin.toISOString(),
      };
      await writeManifest(manifestFileId, repaired);
      manifest = repaired;
      retention = manifestRetention(repaired);
      result.legacyManifestsBackfilled += 1;
    }
    if (retention.state !== "managed") {
      result.invalidManifestsSkipped += 1;
      continue;
    }
    const retainedUploadedAt = retention.uploadedAt;
    const retainedContentExpiresAt = retention.contentExpiresAt;
    const expired = Date.parse(retainedContentExpiresAt) <= now.getTime();
    if (input.onRetainedFile) {
      try {
        await input.onRetainedFile({
          fileId: manifestFileId,
          uploadedAt: new Date(retainedUploadedAt),
          contentExpiresAt: new Date(retainedContentExpiresAt),
        });
      } catch {
        // Keep the manifest as the durable retry ledger. Deleting bytes before
        // the ownership row learns the deadline would recreate a null-retention
        // orphan that remains readable from upstream.
        result.failures += 1;
        continue;
      }
    } else if (expired) {
      // A valid fileId is potentially recoverable from upstream. If the
      // ownership database is down, deleting the local retry ledger would make
      // a null-retention row readable forever after recovery.
      result.failures += 1;
      continue;
    }
    if (!expired) continue;

    try {
      // The manifest is the retry ledger: retain it until both byte removal
      // and downstream derived-file cleanup have succeeded.
      await fs.rm(storedPaths.content, { force: true });
      result.bytesReclaimed += contentStats?.size ?? 0;
      result.reclaimedBytes += contentStats?.size ?? 0;
      await input.onExpiredFile?.({
        fileId: manifestFileId,
        sizeBytes:
          contentStats?.size ??
          (Number.isSafeInteger(manifest.sizeBytes) &&
          Number(manifest.sizeBytes) >= 0
            ? Number(manifest.sizeBytes)
            : 0),
      });
      await writeManifest(manifestFileId, {
        schemaVersion: 1,
        fileId: manifestFileId,
        filename: cleanFilename(manifest.filename, manifestFileId),
        mimeType: cleanMimeType(manifest.mimeType),
        sizeBytes: null,
        sha256: null,
        state: "expired",
        uploadedAt: retainedUploadedAt,
        contentExpiresAt: retainedContentExpiresAt,
        contentDeletedAt: now.toISOString(),
        updatedAt: now.toISOString(),
      });
      result.deleted += 1;
      result.expiredFilesDeleted += 1;
    } catch {
      result.failures += 1;
    }
  }

  if (persistCursor) {
    await writeStorageSweepCursor(result.nextCursor);
  }

  return result;
}
