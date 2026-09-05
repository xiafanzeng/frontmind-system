import axios from "axios";
import { createHash, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { createReadStream } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { Worker } from "node:worker_threads";
import type { Readable } from "node:stream";
import {
  assertSafeExternalUrl,
  ExternalUrlRejectedError,
  safeExternalRequestOptions,
} from "./_core/safe-external-url";
import {
  OWNED_FILE_CONTENT_RESOLVER_VERSION,
  OwnedFileContentError,
  ownedFileContentResolver,
  type FileContentRecoveryAction,
} from "./owned-file-content-resolver";
import { resolveDownloadTokenSecret } from "./signed-download-token";

export type PreparedFilePhase =
  | "queued"
  | "downloading"
  | "sanitizing"
  | "optimizing"
  | "ready"
  | "failed";

export type PreparedFileStatus = "queued" | "processing" | "ready" | "failed";

type PreparedFileSource =
  | { kind: "file"; fileId: string }
  | { kind: "external"; url: string };

export interface PreparedFileManifest {
  version: 1;
  sourceResolverVersion?: number;
  id: string;
  ownerUserId: number;
  /** Legacy Provider authority; absent for Dashboard-managed local assets. */
  credentialId?: string;
  sourceKind?: "managed_local_asset" | "provider_file" | "external";
  sourceAuthorityId?: string;
  projectAssignmentId?: string | null;
  source: PreparedFileSource;
  filename: string;
  mimeType: "application/pdf";
  status: PreparedFileStatus;
  phase: PreparedFilePhase;
  createdAt: number;
  updatedAt: number;
  lastAccessedAt: number;
  sourceBytes?: number;
  size?: number;
  pageCount?: number;
  etag?: string;
  errorCode?: string;
  errorMessage?: string;
  retryable?: boolean;
  recoveryAction?: FileContentRecoveryAction | null;
  sourceExpiresAt?: number;
  expiresAt?: number;
}

export interface PreparedFilePublicStatus {
  assetId: string;
  filename: string;
  mimeType: string;
  status: PreparedFileStatus;
  phase: PreparedFilePhase;
  size?: number;
  sourceBytes?: number;
  pageCount?: number;
  errorCode?: string;
  errorMessage?: string;
  retryAfterMs?: number;
  retryable: boolean;
  recoveryAction: FileContentRecoveryAction | null;
  expiresAt?: number;
  contentUrl: string;
  downloadTokenUrl: string;
}

export interface PreparedFileOrphanSweepResult {
  scannedEntries: number;
  candidateAssets: number;
  deletedEntries: number;
  bytesReclaimed: number;
  orphanPdfsDeleted: number;
  orphanManifestsDeleted: number;
  staleTempsDeleted: number;
  staleWorkDirectoriesDeleted: number;
  skippedClaimedAssets: number;
  skippedDeletionRequestedAssets: number;
  failures: number;
  completedAt: number;
}

interface RegisterFileInput {
  ownerUserId: number;
  credentialId?: string;
  sourceKind?: "managed_local_asset" | "provider_file";
  sourceAuthorityId?: string;
  projectAssignmentId?: string | null;
  fileId: string;
  filename: string;
  expiresAt?: number;
}

interface RegisterExternalInput {
  ownerUserId: number;
  credentialId: string;
  projectAssignmentId?: string | null;
  url: string;
  filename: string;
}

interface WorkerProgress {
  type: "progress";
  phase: "sanitizing" | "optimizing";
  page?: number;
  pageCount?: number;
}

interface WorkerComplete {
  type: "complete";
  pageCount: number;
  wasSanitized: boolean;
}

interface WorkerFailure {
  type: "error";
  code?: string;
  message: string;
}

type WorkerMessage = WorkerProgress | WorkerComplete | WorkerFailure;

const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;
const FIVE_MINUTES_MS = 5 * 60 * 1000;
const FIVE_GIB = 5 * 1024 * 1024 * 1024;
const DISK_CHECK_INTERVAL_BYTES = 64 * 1024 * 1024;
const DEFAULT_LARGE_PDF_THRESHOLD_BYTES = 64 * 1024 * 1024;
const DEFAULT_PROCESSING_CLAIM_STALE_MS = 10 * 60 * 1000;
const PROCESSING_CLAIM_HEARTBEAT_MS = 30 * 1000;
const SHARED_STATE_RECONCILIATION_MS = 60 * 1000;
const DEFAULT_ORPHAN_SWEEP_MIN_AGE_MS = 24 * 60 * 60 * 1000;

type PreparedStorageCandidateKind = "manifest" | "pdf" | "temporary" | "work";

type PreparedStorageCandidate = {
  assetId: string;
  name: string;
  kind: PreparedStorageCandidateKind;
  isDirectory: boolean;
};

type PreparedFileProcessingClaim = {
  owner: string;
  workspaceKey: string;
  assertOwned: () => Promise<void>;
  release: () => Promise<void>;
};

type PreparedManifestWriteOptions = {
  /** Only the first registration may create a previously absent manifest. */
  allowCreate?: boolean;
  /** Revision observed before a non-worker mutation was calculated. */
  expectedUpdatedAt?: number;
};

type PreparedFileFilesystemStats = {
  bavail: number;
  bsize: number;
  blocks: number;
};

export class PreparedFileError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly options: {
      retryable?: boolean;
      recoveryAction?: FileContentRecoveryAction | null;
      expiresAt?: number;
      statusCode?: number;
    } = {},
  ) {
    super(message);
    this.name = "PreparedFileError";
  }

  get retryable() {
    return this.options.retryable ?? preparedFailurePolicy(this.code).retryable;
  }

  get recoveryAction() {
    return (
      this.options.recoveryAction ??
      preparedFailurePolicy(this.code).recoveryAction
    );
  }

  get expiresAt() {
    return this.options.expiresAt;
  }
}

function preparedFailurePolicy(code: string): {
  retryable: boolean;
  recoveryAction: FileContentRecoveryAction;
} {
  if (
    [
      "SOURCE_EXPIRED",
      "SOURCE_UNAVAILABLE",
      "ASSET_EXPIRED",
      "INVALID_PDF",
      "SOURCE_CONTENT_INVALID",
    ].includes(code)
  ) {
    return { retryable: false, recoveryAction: "reupload" };
  }
  if (
    [
      "SOURCE_FORBIDDEN",
      "INSUFFICIENT_STORAGE",
      "PDF_TOOLING_UNAVAILABLE",
      "PREPARED_FILE_STORAGE_NOT_WRITABLE",
    ].includes(code)
  ) {
    return { retryable: false, recoveryAction: "contact_admin" };
  }
  return { retryable: true, recoveryAction: "retry" };
}

function preparedErrorFromOwned(error: OwnedFileContentError) {
  return new PreparedFileError(error.code, error.message, {
    retryable: error.retryable,
    recoveryAction: error.recoveryAction,
    expiresAt: error.expiresAt,
    statusCode: error.statusCode,
  });
}

export function preparedExternalUpstreamFailure(
  status: number,
): PreparedFileError {
  if ([401, 403, 404, 410].includes(status)) {
    return new PreparedFileError(
      "SOURCE_UNAVAILABLE",
      `外部文件来源已失效或不可用 (${status})`,
      {
        retryable: false,
        recoveryAction: "reupload",
        statusCode: 410,
      },
    );
  }
  const retryable = status === 408 || status === 429 || status >= 500;
  return new PreparedFileError(
    "SOURCE_DOWNLOAD_FAILED",
    `上游文件下载失败 (${status})`,
    {
      retryable,
      recoveryAction: retryable ? "retry" : "contact_admin",
      statusCode: retryable ? 503 : 502,
    },
  );
}

export function preparedExternalRequestFailure(error: unknown) {
  const cause =
    error && typeof error === "object" && "cause" in error
      ? (error as { cause?: unknown }).cause
      : undefined;
  if (
    error instanceof ExternalUrlRejectedError ||
    cause instanceof ExternalUrlRejectedError
  ) {
    return new PreparedFileError(
      "SOURCE_REDIRECT_REJECTED",
      "外部文件重定向地址不安全",
      {
        retryable: false,
        recoveryAction: "contact_admin",
        statusCode: 502,
      },
    );
  }
  return new PreparedFileError(
    "SOURCE_DOWNLOAD_FAILED",
    error instanceof Error ? error.message : "上游文件下载失败",
    {
      retryable: true,
      recoveryAction: "retry",
      statusCode: 503,
    },
  );
}

export function evaluatePreparedFileStorage(
  stats: PreparedFileFilesystemStats,
) {
  const totalBytes = stats.blocks * stats.bsize;
  const availableBytes = stats.bavail * stats.bsize;
  if (
    !Number.isSafeInteger(totalBytes) ||
    totalBytes <= 0 ||
    !Number.isSafeInteger(availableBytes) ||
    availableBytes < 0
  ) {
    throw new PreparedFileError(
      "PREPARED_FILE_STORAGE_STATS_INVALID",
      "PDF 持久卷空间信息无效",
    );
  }
  const reserveBytes = Math.max(Math.floor(totalBytes * 0.1), FIVE_GIB);
  if (availableBytes < reserveBytes) {
    throw new PreparedFileError(
      "INSUFFICIENT_STORAGE",
      "服务器可用磁盘空间不足，请清理缓存后重试",
    );
  }
  return { totalBytes, availableBytes, reserveBytes };
}

export async function assertPreparedFileStoreWritable(rootDir: string) {
  const root = await fs.lstat(rootDir);
  if (!root.isDirectory() || root.isSymbolicLink()) {
    throw new PreparedFileError(
      "PREPARED_FILE_STORAGE_ROOT_INVALID",
      "PDF 持久卷必须是真实目录",
    );
  }
  const probePath = path.join(
    rootDir,
    `.frontmind-readiness-${process.pid}-${randomUUID()}.tmp`,
  );
  const expected = `frontmind-prepared-file-readiness:${randomUUID()}\n`;
  try {
    await fs.writeFile(probePath, expected, {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600,
    });
    const actual = await fs.readFile(probePath, "utf8");
    if (actual !== expected) {
      throw new Error("PREPARED_FILE_STORAGE_PROBE_MISMATCH");
    }
  } catch (error) {
    if (error instanceof PreparedFileError) throw error;
    throw new PreparedFileError(
      "PREPARED_FILE_STORAGE_NOT_WRITABLE",
      "PDF 持久卷无法完成无损读写探针",
    );
  } finally {
    await fs.rm(probePath, { force: true }).catch(() => undefined);
  }
}

function normalizeFilename(filename: string) {
  const safe = String(filename || "document.pdf")
    .replace(/[\\/\0]/g, "_")
    .trim();
  const withExtension = safe.toLowerCase().endsWith(".pdf")
    ? safe
    : `${safe || "document"}.pdf`;
  return withExtension || "document.pdf";
}

function stableExternalIdentity(url: string) {
  const parsed = new URL(url);
  const names = new Set(
    [...parsed.searchParams.keys()].map((name) => name.toLowerCase()),
  );
  // Generic parameters such as `token`, `signature`, or `expires` can select
  // the actual business object. Removing them unconditionally aliases distinct
  // PDFs. Strip only a complete, recognizable provider signing envelope; all
  // other query parameters remain part of the content identity.
  const legacySigningEnvelopes = [
    {
      identity: "googleaccessid",
      fields: new Set(["googleaccessid", "signature", "expires"]),
    },
    {
      identity: "awsaccesskeyid",
      fields: new Set(["awsaccesskeyid", "signature", "expires"]),
    },
    {
      identity: "ossaccesskeyid",
      fields: new Set(["ossaccesskeyid", "signature", "expires"]),
    },
  ];
  const activeLegacyEnvelope = legacySigningEnvelopes.find(
    ({ identity, fields }) =>
      names.has(identity) && [...fields].every((field) => names.has(field)),
  );
  const cloudFrontEnvelope =
    names.has("signature") &&
    names.has("key-pair-id") &&
    (names.has("policy") || names.has("expires"));
  const stableParameters = [...parsed.searchParams.entries()]
    .filter(([name]) => {
      const lower = name.toLowerCase();
      if (
        lower.startsWith("x-amz-") ||
        lower.startsWith("x-goog-") ||
        lower.startsWith("x-oss-")
      ) {
        return false;
      }
      if (activeLegacyEnvelope?.fields.has(lower)) return false;
      if (
        cloudFrontEnvelope &&
        ["signature", "key-pair-id", "policy", "expires"].includes(lower)
      ) {
        return false;
      }
      return true;
    })
    .sort(([leftName, leftValue], [rightName, rightValue]) =>
      leftName === rightName
        ? leftValue.localeCompare(rightValue)
        : leftName.localeCompare(rightName),
    );
  const stableQuery = new URLSearchParams(stableParameters).toString();
  return `${parsed.protocol}//${parsed.host}${parsed.pathname}${
    stableQuery ? `?${stableQuery}` : ""
  }`;
}

export function createPreparedAssetId(
  ownerUserId: number,
  credentialId: string,
  source: PreparedFileSource,
  projectAssignmentId?: string | null,
) {
  const sourceIdentity =
    source.kind === "file"
      ? `file:${source.fileId}`
      : `external:${stableExternalIdentity(source.url)}`;
  return createHash("sha256")
    .update(
      `frontmind-pdf-v1\0${ownerUserId}\0${credentialId}\0${sourceIdentity}${
        projectAssignmentId ? `\0project-assignment:${projectAssignmentId}` : ""
      }`,
    )
    .digest("hex")
    .slice(0, 40);
}

export function preparedFilePublicStatus(
  manifest: PreparedFileManifest,
): PreparedFilePublicStatus {
  const policy = manifest.errorCode
    ? preparedFailurePolicy(manifest.errorCode)
    : undefined;
  return {
    assetId: manifest.id,
    filename: manifest.filename,
    mimeType: manifest.mimeType,
    status: manifest.status,
    phase: manifest.phase,
    size: manifest.size,
    sourceBytes: manifest.sourceBytes,
    pageCount: manifest.pageCount,
    errorCode: manifest.errorCode,
    errorMessage: manifest.errorMessage,
    retryable:
      manifest.status === "failed"
        ? (manifest.retryable ?? policy?.retryable ?? true)
        : false,
    recoveryAction:
      manifest.status === "failed"
        ? (manifest.recoveryAction ?? policy?.recoveryAction ?? "retry")
        : null,
    expiresAt: manifest.expiresAt,
    retryAfterMs:
      manifest.status === "queued" || manifest.status === "processing"
        ? 2_000
        : undefined,
    contentUrl: `/api/frontmind/assets/${manifest.id}/content`,
    downloadTokenUrl: `/api/frontmind/assets/${manifest.id}/download-token`,
  };
}

export function migratePreparedManifestResolver(
  manifest: PreparedFileManifest,
  now = Date.now(),
) {
  if (
    manifest.source.kind !== "file" ||
    manifest.sourceResolverVersion === OWNED_FILE_CONTENT_RESOLVER_VERSION
  ) {
    return { changed: false, requeued: false };
  }

  manifest.sourceResolverVersion = OWNED_FILE_CONTENT_RESOLVER_VERSION;
  manifest.updatedAt = now;
  let requeued = false;
  // Ready output is already a locally verified PDF and does not need rebuilding.
  // Failed/abandoned work from the upload_url reader gets exactly one attempt
  // through the local-first resolver, then the version is persisted.
  if (manifest.status === "failed" || manifest.status === "processing") {
    manifest.status = "queued";
    manifest.phase = "queued";
    delete manifest.errorCode;
    delete manifest.errorMessage;
    delete manifest.retryable;
    delete manifest.recoveryAction;
    requeued = true;
  }
  return { changed: true, requeued };
}

export function preparedManifestMatchesOwnedFileSource(
  manifest: PreparedFileManifest,
  input: {
    ownerUserId: number;
    fileId: string;
    projectAssignmentId?: string | null;
  },
) {
  if (
    manifest.source.kind !== "file" ||
    manifest.source.fileId !== input.fileId
  ) {
    return false;
  }
  const projectAssignmentId = input.projectAssignmentId ?? null;
  return projectAssignmentId
    ? manifest.projectAssignmentId === projectAssignmentId
    : manifest.ownerUserId === input.ownerUserId &&
        (manifest.projectAssignmentId ?? null) === null;
}

export function preparedManifestMatchesFileSource(
  manifest: PreparedFileManifest,
  fileId: string,
) {
  return manifest.source.kind === "file" && manifest.source.fileId === fileId;
}

function finitePositiveInteger(value: string | undefined, fallback: number) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

async function fileExists(filePath: string) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function pathSize(targetPath: string): Promise<number> {
  try {
    const stat = await fs.stat(targetPath);
    if (stat.isFile()) return stat.size;
    if (!stat.isDirectory()) return 0;
    const entries = await fs.readdir(targetPath);
    let total = 0;
    for (const entry of entries) {
      total += await pathSize(path.join(targetPath, entry));
    }
    return total;
  } catch {
    return 0;
  }
}

async function commandAvailable(command: string, args: string[]) {
  return new Promise<boolean>((resolve) => {
    const child = spawn(command, args, { stdio: "ignore" });
    child.on("error", () => resolve(false));
    child.on("exit", (code) => resolve(code === 0));
  });
}

async function hashFile(filePath: string) {
  return new Promise<string>((resolve, reject) => {
    const hash = createHash("sha256");
    const stream = createReadStream(filePath);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("error", reject);
    stream.on("end", () => resolve(hash.digest("hex")));
  });
}

function preparedStorageCandidate(
  name: string,
  entryType: { isFile: () => boolean; isDirectory: () => boolean },
): PreparedStorageCandidate | null {
  if (entryType.isFile()) {
    let match = /^([a-f0-9]{40})\.json$/.exec(name);
    if (match) {
      return {
        assetId: match[1],
        name,
        kind: "manifest",
        isDirectory: false,
      };
    }
    match = /^([a-f0-9]{40})\.pdf$/.exec(name);
    if (match) {
      return {
        assetId: match[1],
        name,
        kind: "pdf",
        isDirectory: false,
      };
    }
    match =
      /^([a-f0-9]{40})(?:\.[a-f0-9]{16})?\.(?:source|prepared)\.tmp$/.exec(
        name,
      ) ||
      /^([a-f0-9]{40})\.json\.tmp$/.exec(name) ||
      /^([a-f0-9]{40})\.json\.\d+\.[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.tmp$/.exec(
        name,
      );
    if (match) {
      return {
        assetId: match[1],
        name,
        kind: "temporary",
        isDirectory: false,
      };
    }
  }
  if (entryType.isDirectory()) {
    const match =
      /^([a-f0-9]{40})(?:\.[a-f0-9]{16})?\.work$/.exec(name) ||
      /^([a-f0-9]{40})(?:\.[a-f0-9]{16})?\.tmp-work$/.exec(name);
    if (match) {
      return {
        assetId: match[1],
        name,
        kind: "work",
        isDirectory: true,
      };
    }
  }
  return null;
}

export class PreparedFileService {
  readonly rootDir: string;

  private readonly manifests = new Map<string, PreparedFileManifest>();
  private readonly queue: string[] = [];
  private readonly queued = new Set<string>();
  private readonly active = new Set<string>();
  private readonly pendingDelete = new Set<string>();
  private readonly manifestWrites = new Map<string, Promise<void>>();
  private readonly claimRecoveryTimers = new Map<string, NodeJS.Timeout>();
  private readonly workerConcurrency: number;
  private readonly retentionMs: number;
  private readonly largePdfThresholdBytes: number;
  private readonly processingClaimStaleMs: number;
  private readonly orphanSweepMinAgeMs: number;
  private readonly skipToolingCheck: boolean;
  private readonly instanceId = `${process.pid}:${randomUUID()}`;
  private initPromise: Promise<void> | null = null;
  private processing = 0;
  private cleanupTimer: NodeJS.Timeout | null = null;
  private reconciliationTimer: NodeJS.Timeout | null = null;
  private reconciliationPromise: Promise<void> | null = null;
  private lastOrphanSweep: PreparedFileOrphanSweepResult | null = null;

  constructor(
    rootDir?: string,
    options: {
      skipToolingCheck?: boolean;
      workerConcurrency?: number;
      retentionMs?: number;
      processingClaimStaleMs?: number;
      orphanSweepMinAgeMs?: number;
    } = {},
  ) {
    this.rootDir =
      rootDir ||
      process.env.FRONTMIND_PREPARED_FILE_DIR ||
      (process.env.NODE_ENV === "production"
        ? "/var/lib/frontmind/prepared-files"
        : path.resolve(process.cwd(), ".frontmind-prepared-files"));
    this.workerConcurrency =
      options.workerConcurrency ??
      finitePositiveInteger(process.env.FRONTMIND_PDF_WORKERS, 1);
    this.retentionMs =
      options.retentionMs ??
      finitePositiveInteger(
        process.env.FRONTMIND_PREPARED_FILE_TTL_MS,
        THIRTY_DAYS_MS,
      );
    this.largePdfThresholdBytes = finitePositiveInteger(
      process.env.FRONTMIND_LARGE_PDF_THRESHOLD_BYTES,
      DEFAULT_LARGE_PDF_THRESHOLD_BYTES,
    );
    this.processingClaimStaleMs =
      options.processingClaimStaleMs ?? DEFAULT_PROCESSING_CLAIM_STALE_MS;
    this.orphanSweepMinAgeMs = Math.max(
      this.processingClaimStaleMs,
      options.orphanSweepMinAgeMs ??
        finitePositiveInteger(
          process.env.FRONTMIND_PREPARED_ORPHAN_MIN_AGE_MS,
          DEFAULT_ORPHAN_SWEEP_MIN_AGE_MS,
        ),
    );
    this.skipToolingCheck = options.skipToolingCheck ?? false;
  }

  async initialize() {
    if (!this.initPromise) {
      this.initPromise = this.initializeOnce();
    }
    return this.initPromise;
  }

  private async initializeOnce() {
    // The app invokes prepared-file initialization during startup. Validating
    // here makes every production instance fail readiness before it can issue
    // instance-incompatible download links.
    resolveDownloadTokenSecret();
    await fs.mkdir(this.rootDir, { recursive: true, mode: 0o700 });
    await fs.chmod(this.rootDir, 0o700).catch(() => undefined);
    if (!this.skipToolingCheck) {
      const tooling = await Promise.all([
        commandAvailable("pdfinfo", ["-v"]),
        commandAvailable("pdftotext", ["-v"]),
        commandAvailable("pdfseparate", ["-v"]),
        commandAvailable("pdfunite", ["-v"]),
        commandAvailable("gs", ["--version"]),
      ]);
      if (tooling.some((available) => !available)) {
        throw new PreparedFileError(
          "PDF_TOOLING_UNAVAILABLE",
          "PDF 服务依赖不完整，请安装 poppler-utils 与 ghostscript",
        );
      }
    }

    const entries = await fs.readdir(this.rootDir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isFile() || !/^[a-f0-9]{40}\.json$/.test(entry.name)) {
        continue;
      }

      await this.loadSharedManifest(entry.name.slice(0, -5));
    }

    await this.cleanup();
    this.reconciliationTimer = setInterval(
      () =>
        void this.reconcileSharedState().catch((error) => {
          // The durable marker remains on disk, so a later scan can retry.
          console.error(
            "[PreparedFiles] Shared-state reconciliation failed",
            error,
          );
        }),
      SHARED_STATE_RECONCILIATION_MS,
    );
    this.reconciliationTimer.unref();
    this.cleanupTimer = setInterval(
      () => void this.cleanup(),
      24 * 60 * 60 * 1000,
    );
    this.cleanupTimer.unref();
  }

  private async hasLiveProcessingClaim(assetId: string) {
    try {
      const stat = await fs.stat(this.claimPath(assetId));
      return Date.now() - stat.mtimeMs < this.processingClaimStaleMs;
    } catch {
      return false;
    }
  }

  private async readSharedManifest(assetId: string) {
    if (!/^[a-f0-9]{40}$/.test(assetId)) return null;
    try {
      const parsed = JSON.parse(
        await fs.readFile(this.manifestPath(assetId), "utf8"),
      ) as PreparedFileManifest;
      if (
        parsed.version !== 1 ||
        parsed.id !== assetId ||
        !["queued", "processing", "ready", "failed"].includes(parsed.status)
      ) {
        throw new Error("PREPARED_FILE_MANIFEST_INVALID");
      }
      return parsed;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        console.warn(
          `[PreparedFiles] Ignoring invalid manifest ${assetId}.json`,
          error,
        );
      }
      return null;
    }
  }

  /**
   * The in-memory map is only a per-process acceleration layer. Reloading from
   * the shared volume on every ownership boundary lets an instance initialized
   * before another writer discover newly registered and newly completed files.
   */
  private async loadSharedManifest(assetId: string) {
    const parsed = await this.readSharedManifest(assetId);
    if (!parsed) {
      this.manifests.delete(assetId);
      return null;
    }
    let changed = false;
    const expectedUpdatedAt = parsed.updatedAt;
    const liveProcessingClaim = await this.hasLiveProcessingClaim(assetId);
    if (!liveProcessingClaim && !Number.isFinite(parsed.expiresAt)) {
      parsed.expiresAt = parsed.lastAccessedAt + this.retentionMs;
      changed = true;
    }
    // Never rewrite a manifest that is currently owned by another live worker.
    // Legacy processing jobs are migrated only after their claim has gone
    // stale, so the migration cannot create two concurrent publishers.
    const resolverMigration = liveProcessingClaim
      ? { changed: false, requeued: false }
      : migratePreparedManifestResolver(parsed);
    changed ||= resolverMigration.changed;
    if (parsed.status === "processing" && !liveProcessingClaim) {
      parsed.status = "queued";
      parsed.phase = "queued";
      parsed.updatedAt = Date.now();
      changed = true;
    }
    this.manifests.set(assetId, parsed);
    if (changed) {
      await this.persistManifest(parsed, undefined, { expectedUpdatedAt });
    }
    if (
      parsed.status === "queued" &&
      !(await this.isSharedDeletionRequested(assetId))
    ) {
      this.enqueue(assetId);
    }
    return parsed;
  }

  private async refreshSharedManifests() {
    const entries = await fs.readdir(this.rootDir, { withFileTypes: true });
    const sharedAssetIds = new Set<string>();
    for (const entry of entries) {
      if (entry.isFile() && /^[a-f0-9]{40}\.json$/.test(entry.name)) {
        const assetId = entry.name.slice(0, -5);
        sharedAssetIds.add(assetId);
        await this.loadSharedManifest(assetId);
      }
    }
    // A different instance may have completed a deletion since this process's
    // last request. The map is only a cache and must not retain absent shared
    // manifests as authoritative state.
    for (const assetId of this.manifests.keys()) {
      if (!sharedAssetIds.has(assetId)) this.manifests.delete(assetId);
    }
    for (const entry of entries) {
      if (entry.isFile() && /^[a-f0-9]{40}\.delete$/.test(entry.name)) {
        await this.deleteAsset(entry.name.slice(0, -7));
      }
    }
    await this.sweepOrphanedStorage();
  }

  /**
   * Reclaims only files produced by this service and only after a conservative
   * age threshold. Every asset group is fenced with the same shared claim used
   * by writers/deleters, then its manifest is read again while the claim is
   * held. A valid manifest always protects the canonical JSON/PDF; only stale
   * scratch entries may be removed from a still-owned asset.
   */
  async sweepOrphanedStorage(
    now = Date.now(),
  ): Promise<PreparedFileOrphanSweepResult> {
    if (!Number.isFinite(now)) {
      throw new Error("PREPARED_FILE_ORPHAN_SWEEP_NOW_INVALID");
    }
    const result: PreparedFileOrphanSweepResult = {
      scannedEntries: 0,
      candidateAssets: 0,
      deletedEntries: 0,
      bytesReclaimed: 0,
      orphanPdfsDeleted: 0,
      orphanManifestsDeleted: 0,
      staleTempsDeleted: 0,
      staleWorkDirectoriesDeleted: 0,
      skippedClaimedAssets: 0,
      skippedDeletionRequestedAssets: 0,
      failures: 0,
      completedAt: now,
    };
    await fs.mkdir(this.rootDir, { recursive: true, mode: 0o700 });
    const entries = await fs.readdir(this.rootDir, { withFileTypes: true });
    const cutoff = now - this.orphanSweepMinAgeMs;
    const candidatesByAsset = new Map<string, PreparedStorageCandidate[]>();

    for (const entry of entries) {
      result.scannedEntries += 1;
      const candidate = preparedStorageCandidate(entry.name, entry);
      if (!candidate) continue;
      const candidatePath = path.join(this.rootDir, candidate.name);
      try {
        const stats = await fs.lstat(candidatePath);
        const expectedType = candidate.isDirectory
          ? stats.isDirectory() && !stats.isSymbolicLink()
          : stats.isFile() && !stats.isSymbolicLink();
        if (!expectedType || stats.mtimeMs > cutoff) continue;
        const grouped = candidatesByAsset.get(candidate.assetId) ?? [];
        grouped.push(candidate);
        candidatesByAsset.set(candidate.assetId, grouped);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
          result.failures += 1;
        }
      }
    }

    result.candidateAssets = candidatesByAsset.size;
    for (const [assetId, candidates] of candidatesByAsset) {
      // Avoid taking a claim every minute for an old but healthy canonical
      // pair. This pre-check only skips deletion, so a race can at worst defer
      // reclamation until the next scan.
      if (
        candidates.every(
          (candidate) =>
            candidate.kind === "manifest" || candidate.kind === "pdf",
        ) &&
        (await this.readSharedManifest(assetId))
      ) {
        continue;
      }
      if (await this.isSharedDeletionRequested(assetId)) {
        result.skippedDeletionRequestedAssets += 1;
        continue;
      }
      const claim = await this.acquireProcessingClaim(assetId);
      if (!claim) {
        result.skippedClaimedAssets += 1;
        continue;
      }
      try {
        await claim.assertOwned();
        if (await this.isSharedDeletionRequested(assetId)) {
          result.skippedDeletionRequestedAssets += 1;
          continue;
        }
        const validManifest = await this.readSharedManifest(assetId);
        for (const candidate of candidates) {
          if (
            validManifest &&
            (candidate.kind === "manifest" || candidate.kind === "pdf")
          ) {
            continue;
          }
          const candidatePath = path.join(this.rootDir, candidate.name);
          await claim.assertOwned();
          let currentStats;
          try {
            currentStats = await fs.lstat(candidatePath);
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
            result.failures += 1;
            continue;
          }
          const expectedType = candidate.isDirectory
            ? currentStats.isDirectory() && !currentStats.isSymbolicLink()
            : currentStats.isFile() && !currentStats.isSymbolicLink();
          if (!expectedType || currentStats.mtimeMs > cutoff) continue;
          const reclaimedBytes = candidate.isDirectory
            ? await pathSize(candidatePath)
            : currentStats.size;
          try {
            await fs.rm(candidatePath, {
              recursive: candidate.isDirectory,
              force: true,
            });
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
              result.failures += 1;
            }
            continue;
          }
          await claim.assertOwned();
          result.deletedEntries += 1;
          result.bytesReclaimed += reclaimedBytes;
          if (candidate.kind === "pdf") result.orphanPdfsDeleted += 1;
          if (candidate.kind === "manifest") {
            result.orphanManifestsDeleted += 1;
          }
          if (candidate.kind === "temporary") result.staleTempsDeleted += 1;
          if (candidate.kind === "work") {
            result.staleWorkDirectoriesDeleted += 1;
          }
        }
      } catch {
        // Losing a claim stops this asset immediately; remaining paths are
        // retried by a later reconciliation pass.
        result.failures += 1;
      } finally {
        await claim.release();
      }
    }
    result.completedAt = Date.now();
    this.lastOrphanSweep = { ...result };
    return result;
  }

  /**
   * Reconcile durable delete markers and manifests created by other instances.
   * The marker is the recovery authority: if the process which requested a
   * deletion crashes, another live instance will finish it within one scan.
   */
  async reconcileSharedState() {
    if (this.reconciliationPromise) return this.reconciliationPromise;
    const operation = this.refreshSharedManifests().finally(() => {
      if (this.reconciliationPromise === operation) {
        this.reconciliationPromise = null;
      }
    });
    this.reconciliationPromise = operation;
    return operation;
  }

  private async acquireProcessingClaim(assetId: string) {
    const claimPath = this.claimPath(assetId);
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        const handle = await fs.open(claimPath, "wx", 0o600);
        const claimOwner = `${this.instanceId}:${randomUUID()}`;
        const workspaceKey = createHash("sha256")
          .update(claimOwner)
          .digest("hex")
          .slice(0, 16);
        const claim = `${JSON.stringify({
          version: 1,
          owner: claimOwner,
          claimedAt: Date.now(),
        })}\n`;
        await handle.writeFile(claim, "utf8");
        await handle.sync();
        const heartbeat = setInterval(() => {
          const now = new Date();
          void handle.utimes(now, now).catch(() => undefined);
        }, PROCESSING_CLAIM_HEARTBEAT_MS);
        heartbeat.unref();
        const assertOwned = async () => {
          try {
            const current = JSON.parse(
              await fs.readFile(claimPath, "utf8"),
            ) as {
              owner?: unknown;
            };
            if (current.owner !== claimOwner) {
              throw new Error("PREPARED_FILE_PROCESSING_CLAIM_LOST");
            }
          } catch (error) {
            if (
              error instanceof Error &&
              error.message === "PREPARED_FILE_PROCESSING_CLAIM_LOST"
            ) {
              throw error;
            }
            throw new Error("PREPARED_FILE_PROCESSING_CLAIM_LOST");
          }
        };
        return {
          owner: claimOwner,
          workspaceKey,
          assertOwned,
          release: async () => {
            clearInterval(heartbeat);
            await handle.close().catch(() => undefined);
            try {
              await assertOwned();
              await fs.rm(claimPath, { force: true });
            } catch {
              // A stale-claim takeover may already have moved this inode.
            }
          },
        };
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        if (await this.hasLiveProcessingClaim(assetId)) return null;
        const quarantine = `${claimPath}.stale.${process.pid}.${randomUUID()}`;
        try {
          // rename is the atomic stale-claim takeover: only one contender can
          // move the old path and proceed to create the replacement claim.
          await fs.rename(claimPath, quarantine);
          await fs.rm(quarantine, { force: true });
        } catch {
          return null;
        }
      }
    }
    return null;
  }

  private async requestSharedDeletion(assetId: string) {
    let handle: Awaited<ReturnType<typeof fs.open>> | null = null;
    try {
      handle = await fs.open(this.deleteMarkerPath(assetId), "wx", 0o600);
      await handle.writeFile(`${Date.now()}\n`, "utf8");
      await handle.sync();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    } finally {
      await handle?.close().catch(() => undefined);
    }
  }

  private isSharedDeletionRequested(assetId: string) {
    return fileExists(this.deleteMarkerPath(assetId));
  }

  async shutdown() {
    if (this.cleanupTimer) clearInterval(this.cleanupTimer);
    this.cleanupTimer = null;
    if (this.reconciliationTimer) clearInterval(this.reconciliationTimer);
    this.reconciliationTimer = null;
    for (const timer of this.claimRecoveryTimers.values()) clearTimeout(timer);
    this.claimRecoveryTimers.clear();
    await Promise.allSettled([...this.manifestWrites.values()]);
  }

  async registerFile(input: RegisterFileInput) {
    await this.initialize();
    const source: PreparedFileSource = { kind: "file", fileId: input.fileId };
    const sourceKind = input.sourceKind ?? "provider_file";
    const sourceAuthorityId = input.sourceAuthorityId ?? input.credentialId;
    if (!sourceAuthorityId) {
      throw new PreparedFileError(
        "SOURCE_FORBIDDEN",
        "文件缺少可信的所有权来源",
      );
    }
    return this.register({
      id: createPreparedAssetId(
        input.ownerUserId,
        sourceAuthorityId,
        source,
        input.projectAssignmentId,
      ),
      ownerUserId: input.ownerUserId,
      credentialId: input.credentialId,
      sourceKind,
      sourceAuthorityId,
      projectAssignmentId: input.projectAssignmentId ?? null,
      source,
      filename: normalizeFilename(input.filename),
      sourceExpiresAt: input.expiresAt,
    });
  }

  async registerExternal(input: RegisterExternalInput) {
    await this.initialize();
    const source: PreparedFileSource = {
      kind: "external",
      url: assertSafeExternalUrl(input.url),
    };
    return this.register({
      id: createPreparedAssetId(
        input.ownerUserId,
        input.credentialId,
        source,
        input.projectAssignmentId,
      ),
      ownerUserId: input.ownerUserId,
      credentialId: input.credentialId,
      sourceKind: "external",
      sourceAuthorityId: input.credentialId,
      projectAssignmentId: input.projectAssignmentId ?? null,
      source,
      filename: normalizeFilename(input.filename),
    });
  }

  private async register(input: {
    id: string;
    ownerUserId: number;
    credentialId?: string;
    sourceKind: "managed_local_asset" | "provider_file" | "external";
    sourceAuthorityId: string;
    projectAssignmentId: string | null;
    source: PreparedFileSource;
    filename: string;
    sourceExpiresAt?: number;
  }) {
    const now = Date.now();
    const existing =
      (await this.loadSharedManifest(input.id)) ?? this.manifests.get(input.id);
    if (existing) {
      if (
        (existing.projectAssignmentId ?? null) !== input.projectAssignmentId
      ) {
        throw new PreparedFileError(
          "SOURCE_FORBIDDEN",
          "文件不属于当前客户项目",
        );
      }
      // A queued/processing manifest is already immutable with respect to its
      // ownership and source identity. Avoid a cross-instance metadata write
      // racing the worker's claim-fenced phase updates.
      if (
        existing.status === "queued" ||
        (existing.status === "processing" &&
          (await this.hasLiveProcessingClaim(existing.id)))
      ) {
        return preparedFilePublicStatus(existing);
      }
      const expectedUpdatedAt = existing.updatedAt;
      existing.filename = input.filename;
      existing.credentialId = input.credentialId;
      existing.sourceKind = input.sourceKind;
      existing.sourceAuthorityId = input.sourceAuthorityId;
      existing.lastAccessedAt = now;
      existing.sourceExpiresAt = input.sourceExpiresAt;
      existing.updatedAt = now;
      this.refreshExpiry(existing, now);
      if (input.source.kind === "external") {
        // Refresh an expiring signed URL without changing the stable asset id.
        existing.source = input.source;
        if (
          existing.status === "failed" &&
          ["SOURCE_EXPIRED", "SOURCE_UNAVAILABLE"].includes(
            existing.errorCode || "",
          )
        ) {
          existing.status = "queued";
          existing.phase = "queued";
          existing.updatedAt = now;
          delete existing.errorCode;
          delete existing.errorMessage;
          delete existing.retryable;
          delete existing.recoveryAction;
          this.enqueue(existing.id);
        }
      }
      await this.persistManifest(existing, undefined, { expectedUpdatedAt });
      return preparedFilePublicStatus(existing);
    }

    const manifest: PreparedFileManifest = {
      version: 1,
      sourceResolverVersion:
        input.source.kind === "file"
          ? OWNED_FILE_CONTENT_RESOLVER_VERSION
          : undefined,
      id: input.id,
      ownerUserId: input.ownerUserId,
      credentialId: input.credentialId,
      sourceKind: input.sourceKind,
      sourceAuthorityId: input.sourceAuthorityId,
      projectAssignmentId: input.projectAssignmentId,
      source: input.source,
      filename: input.filename,
      mimeType: "application/pdf",
      status: "queued",
      phase: "queued",
      createdAt: now,
      updatedAt: now,
      lastAccessedAt: now,
      sourceExpiresAt: input.sourceExpiresAt,
      expiresAt: Math.min(
        now + this.retentionMs,
        input.sourceExpiresAt ?? Number.POSITIVE_INFINITY,
      ),
    };
    this.manifests.set(manifest.id, manifest);
    await this.persistManifest(manifest, undefined, { allowCreate: true });
    this.enqueue(manifest.id);
    return preparedFilePublicStatus(manifest);
  }

  async getStatus(
    assetId: string,
    ownerUserId: number,
    projectAssignmentId?: string | null,
  ) {
    const manifest = await this.requireOwned(
      assetId,
      ownerUserId,
      projectAssignmentId,
    );
    await this.touch(manifest);
    return preparedFilePublicStatus(manifest);
  }

  async getReadyManifest(
    assetId: string,
    ownerUserId: number,
    projectAssignmentId?: string | null,
  ) {
    const manifest = await this.requireOwned(
      assetId,
      ownerUserId,
      projectAssignmentId,
    );
    await this.touch(manifest);
    if (manifest.status !== "ready") return manifest;
    if (!(await fileExists(this.pdfPath(assetId)))) {
      const expectedUpdatedAt = manifest.updatedAt;
      manifest.status = "queued";
      manifest.phase = "queued";
      manifest.updatedAt = Date.now();
      delete manifest.size;
      delete manifest.etag;
      await this.persistManifest(manifest, undefined, { expectedUpdatedAt });
      this.enqueue(assetId);
    }
    return manifest;
  }

  async retry(
    assetId: string,
    ownerUserId: number,
    projectAssignmentId?: string | null,
  ) {
    const manifest = await this.requireOwned(
      assetId,
      ownerUserId,
      projectAssignmentId,
    );
    if (
      manifest.status === "ready" ||
      manifest.status === "queued" ||
      manifest.status === "processing"
    ) {
      return preparedFilePublicStatus(manifest);
    }
    if (
      manifest.status === "failed" &&
      preparedFilePublicStatus(manifest).retryable === false
    ) {
      throw new PreparedFileError(
        manifest.errorCode || "RECOVERY_REUPLOAD_REQUIRED",
        manifest.errorMessage || "该文件需要重新上传",
        {
          retryable: false,
          recoveryAction: manifest.recoveryAction || "reupload",
          expiresAt: manifest.expiresAt,
          statusCode: 409,
        },
      );
    }
    const expectedUpdatedAt = manifest.updatedAt;
    manifest.status = "queued";
    manifest.phase = "queued";
    manifest.updatedAt = Date.now();
    delete manifest.errorCode;
    delete manifest.errorMessage;
    delete manifest.retryable;
    delete manifest.recoveryAction;
    await this.persistManifest(manifest, undefined, { expectedUpdatedAt });
    this.enqueue(assetId);
    return preparedFilePublicStatus(manifest);
  }

  contentPath(assetId: string) {
    return this.pdfPath(assetId);
  }

  beginUse(assetId: string) {
    this.active.add(assetId);
  }

  endUse(assetId: string) {
    this.active.delete(assetId);
    if (this.pendingDelete.has(assetId)) {
      void this.deleteAsset(assetId);
    }
  }

  async deleteByOwnedFileSource(input: {
    ownerUserId: number;
    fileId: string;
    projectAssignmentId?: string | null;
  }) {
    await this.initialize();
    await this.refreshSharedManifests();
    const matches = [...this.manifests.values()].filter((manifest) =>
      preparedManifestMatchesOwnedFileSource(manifest, input),
    );
    for (const manifest of matches) {
      await this.deleteAsset(manifest.id);
    }
    return matches.length;
  }

  /**
   * Internal filesystem-reconciliation path used after an ownership ledger was
   * already removed by an account/project cascade. It intentionally has no
   * HTTP exposure and matches only the opaque upstream file id.
   */
  async deleteByFileSource(fileId: string) {
    await this.initialize();
    await this.refreshSharedManifests();
    const matches = [...this.manifests.values()].filter((manifest) =>
      preparedManifestMatchesFileSource(manifest, fileId),
    );
    for (const manifest of matches) {
      await this.deleteAsset(manifest.id);
    }
    return matches.length;
  }

  async health() {
    await this.initialize();
    const stats = await fs.statfs(this.rootDir);
    const storage = evaluatePreparedFileStorage(stats);
    await assertPreparedFileStoreWritable(this.rootDir);
    return {
      cacheDirectory: this.rootDir,
      availableBytes: storage.availableBytes,
      totalBytes: storage.totalBytes,
      reserveBytes: storage.reserveBytes,
      queueLength: this.queue.length,
      activeWorkers: this.processing,
      orphanSweep: this.lastOrphanSweep ? { ...this.lastOrphanSweep } : null,
    };
  }

  private async requireOwned(
    assetId: string,
    ownerUserId: number,
    projectAssignmentId?: string | null,
  ) {
    await this.initialize();
    if (!/^[a-f0-9]{40}$/.test(assetId)) {
      throw new PreparedFileError("ASSET_NOT_FOUND", "文件不存在");
    }
    const manifest =
      (await this.loadSharedManifest(assetId)) ?? this.manifests.get(assetId);
    const owned = projectAssignmentId
      ? manifest?.projectAssignmentId === projectAssignmentId
      : manifest?.ownerUserId === ownerUserId &&
        (manifest.projectAssignmentId ?? null) === null;
    if (!manifest || !owned) {
      throw new PreparedFileError("ASSET_NOT_FOUND", "文件不存在");
    }
    if (await this.isSharedDeletionRequested(assetId)) {
      throw new PreparedFileError(
        "SOURCE_EXPIRED",
        "文件已超过 30 天，请重新上传",
        {
          retryable: false,
          recoveryAction: "reupload",
          expiresAt: manifest.sourceExpiresAt ?? manifest.expiresAt,
          statusCode: 410,
        },
      );
    }
    if (manifest.source.kind === "file") {
      try {
        const authorization = await ownedFileContentResolver.authorize({
          ownerUserId,
          fileId: manifest.source.fileId,
          projectAssignmentId,
          expectedCredentialId: manifest.sourceKind
            ? undefined
            : manifest.credentialId,
          expectedSourceKind:
            manifest.sourceKind === "external"
              ? undefined
              : manifest.sourceKind,
          expectedSourceAuthorityId: manifest.sourceAuthorityId,
        });
        manifest.sourceExpiresAt = authorization.expiresAt;
        this.refreshExpiry(manifest, manifest.lastAccessedAt);
      } catch (error) {
        if (error instanceof OwnedFileContentError) {
          throw preparedErrorFromOwned(error);
        }
        throw error;
      }
    }
    if (
      Number.isFinite(manifest.expiresAt) &&
      Number(manifest.expiresAt) <= Date.now()
    ) {
      throw new PreparedFileError(
        "SOURCE_EXPIRED",
        "文件已超过 30 天，请重新上传",
        {
          retryable: false,
          recoveryAction: "reupload",
          expiresAt: manifest.expiresAt,
          statusCode: 410,
        },
      );
    }
    return manifest;
  }

  private enqueue(assetId: string) {
    if (this.queued.has(assetId)) return;
    this.queued.add(assetId);
    this.queue.push(assetId);
    queueMicrotask(() => void this.drainQueue());
  }

  private scheduleClaimRecovery(assetId: string) {
    if (this.claimRecoveryTimers.has(assetId)) return;
    const timer = setTimeout(() => {
      this.claimRecoveryTimers.delete(assetId);
      void this.isSharedDeletionRequested(assetId).then(
        async (deleteRequested) => {
          if (deleteRequested) await this.deleteAsset(assetId);
          else await this.loadSharedManifest(assetId);
        },
      );
    }, this.processingClaimStaleMs + 100);
    timer.unref();
    this.claimRecoveryTimers.set(assetId, timer);
  }

  private async drainQueue() {
    while (this.processing < this.workerConcurrency && this.queue.length > 0) {
      const assetId = this.queue.shift();
      if (!assetId) return;
      this.queued.delete(assetId);
      const manifest = this.manifests.get(assetId);
      if (!manifest || manifest.status !== "queued") continue;
      this.processing += 1;
      void this.processAsset(assetId)
        .catch((error) => {
          console.error(
            `[PreparedFiles] Unhandled job error for ${assetId}`,
            error,
          );
        })
        .finally(() => {
          this.processing -= 1;
          void this.drainQueue();
        });
    }
  }

  private async assertPublishStillAllowed(manifest: PreparedFileManifest) {
    if (await this.isSharedDeletionRequested(manifest.id)) {
      throw new PreparedFileError(
        "ASSET_DELETE_REQUESTED",
        "文件内容已进入清理流程",
        {
          retryable: false,
          recoveryAction: "reupload",
          expiresAt: manifest.sourceExpiresAt ?? manifest.expiresAt,
          statusCode: 410,
        },
      );
    }
    if (manifest.source.kind === "file") {
      try {
        const authorization = await ownedFileContentResolver.authorize({
          ownerUserId: manifest.ownerUserId,
          fileId: manifest.source.fileId,
          projectAssignmentId: manifest.projectAssignmentId,
          expectedCredentialId: manifest.sourceKind
            ? undefined
            : manifest.credentialId,
          expectedSourceKind:
            manifest.sourceKind === "external"
              ? undefined
              : manifest.sourceKind,
          expectedSourceAuthorityId: manifest.sourceAuthorityId,
        });
        manifest.sourceExpiresAt = authorization.expiresAt;
        this.refreshExpiry(manifest, manifest.lastAccessedAt);
      } catch (error) {
        if (error instanceof OwnedFileContentError) {
          throw preparedErrorFromOwned(error);
        }
        throw error;
      }
    }
    if (
      manifest.sourceExpiresAt !== undefined &&
      manifest.sourceExpiresAt <= Date.now()
    ) {
      throw new PreparedFileError(
        "SOURCE_EXPIRED",
        "文件已超过 30 天，请重新上传",
        {
          retryable: false,
          recoveryAction: "reupload",
          expiresAt: manifest.sourceExpiresAt,
          statusCode: 410,
        },
      );
    }
  }

  private async processAsset(assetId: string) {
    const claim = await this.acquireProcessingClaim(assetId);
    if (!claim) {
      await this.loadSharedManifest(assetId);
      this.scheduleClaimRecovery(assetId);
      return;
    }
    const manifest =
      (await this.loadSharedManifest(assetId)) ?? this.manifests.get(assetId);
    if (
      !manifest ||
      (manifest.status !== "queued" && manifest.status !== "processing")
    ) {
      await claim.release();
      return;
    }
    // Every claim owns distinct scratch paths. After a stale-claim takeover,
    // the old worker's finally block can therefore never delete the new
    // worker's partial download, prepared output, or work directory.
    const sourcePath = this.sourcePath(assetId, claim.workspaceKey);
    const preparedTempPath = this.preparedTempPath(assetId, claim.workspaceKey);
    const workDir = this.workPath(assetId, claim.workspaceKey);
    let published = false;
    this.active.add(assetId);

    try {
      await claim.assertOwned();
      manifest.status = "processing";
      manifest.phase = "downloading";
      manifest.updatedAt = Date.now();
      delete manifest.errorCode;
      delete manifest.errorMessage;
      delete manifest.retryable;
      delete manifest.recoveryAction;
      await this.persistManifest(manifest, claim);

      await this.ensureDiskSpace();
      const sourceBytes = await this.downloadSource(
        manifest,
        sourcePath,
        async (downloadedBytes) => {
          await claim.assertOwned();
          manifest.sourceBytes = downloadedBytes;
          manifest.updatedAt = Date.now();
          await this.persistManifest(manifest, claim);
        },
      );
      manifest.sourceBytes = sourceBytes;
      manifest.phase = "sanitizing";
      manifest.updatedAt = Date.now();
      await claim.assertOwned();
      await this.persistManifest(manifest, claim);

      const result = await this.runWorker(
        manifest,
        sourcePath,
        preparedTempPath,
        workDir,
        claim,
      );
      manifest.phase = "optimizing";
      manifest.updatedAt = Date.now();
      await claim.assertOwned();
      await this.persistManifest(manifest, claim);

      const outputStat = await fs.stat(preparedTempPath);
      if (outputStat.size < 5) {
        throw new PreparedFileError("INVALID_PDF", "处理后的 PDF 文件为空");
      }
      const handle = await fs.open(preparedTempPath, "r");
      try {
        const header = Buffer.alloc(5);
        await handle.read(header, 0, 5, 0);
        if (header.toString("ascii") !== "%PDF-") {
          throw new PreparedFileError("INVALID_PDF", "处理结果不是有效的 PDF");
        }
      } finally {
        await handle.close();
      }

      const etag = await hashFile(preparedTempPath);
      await claim.assertOwned();
      await this.assertPublishStillAllowed(manifest);
      await claim.assertOwned();
      await fs.rename(preparedTempPath, this.pdfPath(assetId));
      await fs.chmod(this.pdfPath(assetId), 0o600).catch(() => undefined);
      // A cleanup request can race the rename. Recheck the shared marker and
      // immutable source clock before publishing a ready manifest.
      await claim.assertOwned();
      await this.assertPublishStillAllowed(manifest);

      manifest.status = "ready";
      manifest.phase = "ready";
      manifest.size = outputStat.size;
      manifest.pageCount = result.pageCount;
      manifest.etag = etag;
      manifest.updatedAt = Date.now();
      manifest.lastAccessedAt = Date.now();
      this.refreshExpiry(manifest, manifest.lastAccessedAt);
      await claim.assertOwned();
      await this.persistManifest(manifest, claim);
      published = true;
      await this.cleanup();
    } catch (error) {
      const preparedError =
        error instanceof PreparedFileError
          ? error
          : new PreparedFileError(
              "PDF_PREPARATION_FAILED",
              error instanceof Error ? error.message : "PDF 处理失败",
            );
      let stillOwnsClaim = true;
      await claim.assertOwned().catch(() => {
        stillOwnsClaim = false;
      });
      if (stillOwnsClaim && !(await this.isSharedDeletionRequested(assetId))) {
        manifest.status = "failed";
        manifest.phase = "failed";
        manifest.errorCode = preparedError.code;
        manifest.errorMessage = preparedError.message;
        manifest.retryable = preparedError.retryable;
        manifest.recoveryAction = preparedError.recoveryAction;
        if (preparedError.expiresAt !== undefined) {
          manifest.sourceExpiresAt = preparedError.expiresAt;
          manifest.expiresAt = preparedError.expiresAt;
        }
        manifest.updatedAt = Date.now();
        await this.persistManifest(manifest, claim);
      }
      console.error(
        `[PreparedFiles] Failed to prepare ${manifest.id}: ${preparedError.code} ${preparedError.message}`,
      );
    } finally {
      this.active.delete(assetId);
      await fs.rm(sourcePath, { force: true }).catch(() => undefined);
      await fs.rm(preparedTempPath, { force: true }).catch(() => undefined);
      await fs
        .rm(workDir, { recursive: true, force: true })
        .catch(() => undefined);
      if (!published) {
        // A fenced-out worker must not remove the canonical PDF produced by
        // its replacement after takeover.
        const stillOwnsClaim = await claim.assertOwned().then(
          () => true,
          () => false,
        );
        if (stillOwnsClaim) {
          await fs
            .rm(this.pdfPath(assetId), { force: true })
            .catch(() => undefined);
        }
      }
      const deletionRequested =
        this.pendingDelete.has(assetId) ||
        (await this.isSharedDeletionRequested(assetId));
      await claim.release();
      if (deletionRequested) {
        await this.deleteAsset(assetId);
      }
    }
  }

  private async downloadSource(
    manifest: PreparedFileManifest,
    destination: string,
    persistProgress: (bytes: number) => Promise<void>,
  ) {
    let sourceStream: Readable;
    let expectedSize: number | undefined;
    const controller = new AbortController();
    let lastProgressAt = Date.now();
    if (manifest.source.kind === "file") {
      try {
        const resolved = await ownedFileContentResolver.resolve({
          ownerUserId: manifest.ownerUserId,
          fileId: manifest.source.fileId,
          projectAssignmentId: manifest.projectAssignmentId,
          expectedCredentialId: manifest.sourceKind
            ? undefined
            : manifest.credentialId,
          expectedSourceKind:
            manifest.sourceKind === "external"
              ? undefined
              : manifest.sourceKind,
          expectedSourceAuthorityId: manifest.sourceAuthorityId,
        });
        manifest.filename = normalizeFilename(resolved.filename);
        manifest.sourceExpiresAt = resolved.expiresAt;
        this.refreshExpiry(manifest, manifest.lastAccessedAt);
        sourceStream = resolved.stream;
        expectedSize = resolved.sizeBytes;
      } catch (error) {
        if (error instanceof OwnedFileContentError) {
          throw preparedErrorFromOwned(error);
        }
        throw error;
      }
    } else {
      try {
        const sourceUrl = assertSafeExternalUrl(manifest.source.url);
        const response = await axios.get(sourceUrl, {
          ...safeExternalRequestOptions,
          responseType: "stream",
          timeout: FIVE_MINUTES_MS,
          maxContentLength: Infinity,
          signal: controller.signal,
          validateStatus: () => true,
        });
        if (response.status !== 200) {
          throw preparedExternalUpstreamFailure(response.status);
        }
        sourceStream = response.data as Readable;
        const declaredSize = Number(response.headers?.["content-length"]);
        if (Number.isSafeInteger(declaredSize) && declaredSize > 0) {
          expectedSize = declaredSize;
        }
      } catch (error) {
        if (error instanceof PreparedFileError) throw error;
        throw preparedExternalRequestFailure(error);
      }
    }

    const watchdog = setInterval(() => {
      if (Date.now() - lastProgressAt >= FIVE_MINUTES_MS) {
        const stalled = new PreparedFileError(
          "SOURCE_STALLED",
          "文件下载连续 5 分钟没有进展",
          { retryable: true, recoveryAction: "retry", statusCode: 503 },
        );
        controller.abort(stalled);
        sourceStream.destroy(stalled);
      }
    }, 30_000);
    watchdog.unref();

    try {
      const output = await fs.open(destination, "w", 0o600);
      let total = 0;
      let nextDiskCheck = DISK_CHECK_INTERVAL_BYTES;
      let nextPersist = DISK_CHECK_INTERVAL_BYTES;
      try {
        for await (const rawChunk of sourceStream) {
          const chunk = Buffer.isBuffer(rawChunk)
            ? rawChunk
            : Buffer.from(rawChunk);
          await output.write(chunk);
          total += chunk.length;
          lastProgressAt = Date.now();
          if (total >= nextPersist) {
            await persistProgress(total);
            nextPersist = total + DISK_CHECK_INTERVAL_BYTES;
          }
          if (total >= nextDiskCheck) {
            await this.ensureDiskSpace();
            nextDiskCheck = total + DISK_CHECK_INTERVAL_BYTES;
          }
        }
      } finally {
        await output.close();
      }
      if (total < 1) {
        throw new PreparedFileError(
          "SOURCE_CONTENT_INVALID",
          "文件内容为空，请重新上传",
          { retryable: false, recoveryAction: "reupload", statusCode: 422 },
        );
      }
      if (expectedSize !== undefined && total !== expectedSize) {
        throw new PreparedFileError(
          "SOURCE_DOWNLOAD_FAILED",
          "文件内容读取不完整，请重试",
          { retryable: true, recoveryAction: "retry", statusCode: 503 },
        );
      }
      await persistProgress(total);
      return total;
    } catch (error: any) {
      if (controller.signal.aborted) {
        const reason = controller.signal.reason;
        if (reason instanceof PreparedFileError) throw reason;
        throw new PreparedFileError(
          "SOURCE_STALLED",
          "文件下载连续 5 分钟没有进展",
        );
      }
      if (error instanceof PreparedFileError) throw error;
      throw new PreparedFileError(
        "SOURCE_DOWNLOAD_FAILED",
        error?.message || "上游文件下载失败",
      );
    } finally {
      clearInterval(watchdog);
    }
  }

  private async runWorker(
    manifest: PreparedFileManifest,
    inputPath: string,
    outputPath: string,
    workDir: string,
    claim: PreparedFileProcessingClaim,
  ) {
    await fs.mkdir(workDir, { recursive: true, mode: 0o700 });
    const production = process.env.NODE_ENV === "production";
    const workerUrl = new URL(
      production
        ? "./pdf-prepare-worker.js"
        : "./pdf-prepare-worker-bootstrap.mjs",
      import.meta.url,
    );

    return new Promise<WorkerComplete>((resolve, reject) => {
      let settled = false;
      let lastProgressAt = Date.now();
      let lastProgressPersistedAt = 0;
      let checkingDisk = false;
      const worker = new Worker(workerUrl, {
        workerData: {
          inputPath,
          outputPath,
          workDir,
          largePdfThresholdBytes: this.largePdfThresholdBytes,
        },
        execArgv: [],
      });

      const finish = (callback: () => void) => {
        if (settled) return;
        settled = true;
        clearInterval(watchdog);
        callback();
      };

      const watchdog = setInterval(() => {
        if (Date.now() - lastProgressAt >= FIVE_MINUTES_MS) {
          void worker.terminate();
          finish(() =>
            reject(
              new PreparedFileError(
                "PDF_PROCESSING_STALLED",
                "PDF 处理连续 5 分钟没有进展",
              ),
            ),
          );
          return;
        }
        if (checkingDisk) return;
        checkingDisk = true;
        void this.ensureDiskSpace()
          .catch((error) => {
            void worker.terminate();
            finish(() =>
              reject(
                error instanceof PreparedFileError
                  ? error
                  : new PreparedFileError(
                      "INSUFFICIENT_STORAGE",
                      "服务器可用磁盘空间不足，请清理缓存后重试",
                    ),
              ),
            );
          })
          .finally(() => {
            checkingDisk = false;
          });
      }, 30_000);
      watchdog.unref();

      worker.on("message", (message: WorkerMessage) => {
        lastProgressAt = Date.now();
        if (message.type === "progress") {
          manifest.phase = message.phase;
          manifest.updatedAt = Date.now();
          if (message.pageCount) manifest.pageCount = message.pageCount;
          if (
            Date.now() - lastProgressPersistedAt >= 1_000 ||
            (message.pageCount && message.page === message.pageCount)
          ) {
            lastProgressPersistedAt = Date.now();
            void this.persistManifest(manifest, claim).catch((error) => {
              void worker.terminate();
              finish(() => reject(error));
            });
          }
          return;
        }
        if (message.type === "complete") {
          finish(() => resolve(message));
          return;
        }
        finish(() =>
          reject(
            new PreparedFileError(
              message.code || "PDF_PREPARATION_FAILED",
              message.message,
            ),
          ),
        );
      });
      worker.on("error", (error) => {
        finish(() =>
          reject(
            new PreparedFileError(
              "PDF_WORKER_FAILED",
              error.message || "PDF Worker 启动失败",
            ),
          ),
        );
      });
      worker.on("exit", (code) => {
        if (code !== 0) {
          finish(() =>
            reject(
              new PreparedFileError(
                "PDF_WORKER_FAILED",
                `PDF Worker 异常退出 (${code})`,
              ),
            ),
          );
        }
      });
    });
  }

  private async touch(manifest: PreparedFileManifest) {
    if (manifest.status === "queued" || manifest.status === "processing") {
      return;
    }
    const now = Date.now();
    if (now - manifest.lastAccessedAt < 60 * 60 * 1000) return;
    const expectedUpdatedAt = manifest.updatedAt;
    manifest.lastAccessedAt = now;
    manifest.updatedAt = now;
    this.refreshExpiry(manifest, now);
    await this.persistManifest(manifest, undefined, { expectedUpdatedAt });
  }

  private refreshExpiry(manifest: PreparedFileManifest, accessedAt: number) {
    manifest.expiresAt = Math.min(
      accessedAt + this.retentionMs,
      manifest.sourceExpiresAt ?? Number.POSITIVE_INFINITY,
    );
  }

  private persistManifest(
    manifest: PreparedFileManifest,
    claim?: PreparedFileProcessingClaim,
    options: PreparedManifestWriteOptions = {},
  ): Promise<void> {
    if (!claim) {
      return this.persistManifestWithClaim(manifest, options);
    }
    const destination = this.manifestPath(manifest.id);
    // A process-unique temporary path avoids instance A renaming or cleaning
    // instance B's in-flight manifest write on a shared persistent volume.
    const temporary = `${destination}.${process.pid}.${randomUUID()}.tmp`;
    const snapshot = `${JSON.stringify(manifest)}\n`;
    const previous = this.manifestWrites.get(manifest.id) || Promise.resolve();
    const operation = previous
      .catch(() => undefined)
      .then(async () => {
        try {
          // The check happens inside the serialized write operation, not when
          // it is enqueued. A paused old worker therefore cannot flush a stale
          // snapshot after a newer instance has fenced it out.
          await claim.assertOwned();
          if (await this.isSharedDeletionRequested(manifest.id)) {
            throw new PreparedFileError(
              "ASSET_DELETE_REQUESTED",
              "文件内容已进入清理流程",
              {
                retryable: false,
                recoveryAction: "reupload",
                expiresAt: manifest.sourceExpiresAt ?? manifest.expiresAt,
                statusCode: 410,
              },
            );
          }
          const current = await this.readSharedManifest(manifest.id);
          if (!options.allowCreate && !current) {
            throw new PreparedFileError(
              "ASSET_NOT_FOUND",
              "文件准备记录已被删除",
              { retryable: false, recoveryAction: "reupload", statusCode: 410 },
            );
          }
          if (
            options.expectedUpdatedAt !== undefined &&
            current?.updatedAt !== options.expectedUpdatedAt
          ) {
            throw new PreparedFileError(
              "PREPARED_FILE_MANIFEST_CONFLICT",
              "文件准备状态已被其他实例更新，请重试",
              { retryable: true, recoveryAction: "retry", statusCode: 409 },
            );
          }
          await fs.writeFile(temporary, snapshot, {
            encoding: "utf8",
            mode: 0o600,
            flag: "wx",
          });
          await claim.assertOwned();
          if (await this.isSharedDeletionRequested(manifest.id)) {
            throw new PreparedFileError(
              "ASSET_DELETE_REQUESTED",
              "文件内容已进入清理流程",
              {
                retryable: false,
                recoveryAction: "reupload",
                expiresAt: manifest.sourceExpiresAt ?? manifest.expiresAt,
                statusCode: 410,
              },
            );
          }
          await fs.rename(temporary, destination);
          await claim.assertOwned();
          if (await this.isSharedDeletionRequested(manifest.id)) {
            throw new PreparedFileError(
              "ASSET_DELETE_REQUESTED",
              "文件内容已进入清理流程",
              {
                retryable: false,
                recoveryAction: "reupload",
                expiresAt: manifest.sourceExpiresAt ?? manifest.expiresAt,
                statusCode: 410,
              },
            );
          }
        } finally {
          await fs.rm(temporary, { force: true }).catch(() => undefined);
        }
      });
    this.manifestWrites.set(manifest.id, operation);
    return operation.finally(() => {
      if (this.manifestWrites.get(manifest.id) === operation) {
        this.manifestWrites.delete(manifest.id);
      }
    });
  }

  private async persistManifestWithClaim(
    manifest: PreparedFileManifest,
    options: PreparedManifestWriteOptions,
  ): Promise<void> {
    if (await this.isSharedDeletionRequested(manifest.id)) {
      throw new PreparedFileError(
        "ASSET_DELETE_REQUESTED",
        "文件内容已进入清理流程",
        {
          retryable: false,
          recoveryAction: "reupload",
          expiresAt: manifest.sourceExpiresAt ?? manifest.expiresAt,
          statusCode: 410,
        },
      );
    }
    const claim = await this.acquireProcessingClaim(manifest.id);
    if (!claim) {
      throw new PreparedFileError(
        "PREPARED_FILE_MANIFEST_BUSY",
        "文件准备状态正在由其他实例更新，请稍后重试",
        { retryable: true, recoveryAction: "retry", statusCode: 409 },
      );
    }
    try {
      return await this.persistManifest(manifest, claim, options);
    } finally {
      await claim.release();
    }
  }

  private async ensureDiskSpace() {
    const stats = await fs.statfs(this.rootDir);
    const totalBytes = stats.blocks * stats.bsize;
    const availableBytes = stats.bavail * stats.bsize;
    const reserveBytes = Math.max(Math.floor(totalBytes * 0.1), FIVE_GIB);
    const maximumCacheBytes = Math.min(
      Math.floor(totalBytes * 0.8),
      Math.max(0, totalBytes - reserveBytes),
    );
    const cacheBytes = await this.cacheSize();
    if (availableBytes >= reserveBytes && cacheBytes <= maximumCacheBytes) {
      return;
    }
    await this.cleanup();
    const refreshed = await fs.statfs(this.rootDir);
    const refreshedAvailable = refreshed.bavail * refreshed.bsize;
    const refreshedCacheBytes = await this.cacheSize();
    if (
      refreshedAvailable < reserveBytes ||
      refreshedCacheBytes > maximumCacheBytes
    ) {
      throw new PreparedFileError(
        "INSUFFICIENT_STORAGE",
        "服务器可用磁盘空间不足，请清理缓存后重试",
      );
    }
  }

  async cleanup() {
    await fs.mkdir(this.rootDir, { recursive: true, mode: 0o700 });
    await this.refreshSharedManifests();
    const now = Date.now();
    const candidates = [...this.manifests.values()]
      .filter((manifest) => !this.active.has(manifest.id))
      .sort((a, b) => a.lastAccessedAt - b.lastAccessedAt);

    for (const manifest of candidates) {
      if (now - manifest.lastAccessedAt <= this.retentionMs) continue;
      await this.deleteAsset(manifest.id);
    }

    const stats = await fs.statfs(this.rootDir);
    const totalBytes = stats.blocks * stats.bsize;
    const reserveBytes = Math.max(Math.floor(totalBytes * 0.1), FIVE_GIB);
    const maximumCacheBytes = Math.min(
      Math.floor(totalBytes * 0.8),
      Math.max(0, totalBytes - reserveBytes),
    );
    let cacheBytes = await this.cacheSize();
    let availableBytes = stats.bavail * stats.bsize;
    if (cacheBytes <= maximumCacheBytes && availableBytes >= reserveBytes) {
      return;
    }

    for (const manifest of candidates) {
      if (cacheBytes <= maximumCacheBytes && availableBytes >= reserveBytes) {
        break;
      }
      if (
        this.active.has(manifest.id) ||
        manifest.status === "processing" ||
        manifest.status === "queued"
      ) {
        continue;
      }
      const before = await this.assetSize(manifest.id);
      await this.deleteAsset(manifest.id);
      cacheBytes = Math.max(0, cacheBytes - before);
      const refreshed = await fs.statfs(this.rootDir);
      availableBytes = refreshed.bavail * refreshed.bsize;
    }
  }

  private async assetSize(assetId: string) {
    let size = 0;
    for (const filePath of await this.assetStoragePaths(assetId)) {
      size += await pathSize(filePath);
    }
    return size;
  }

  private async cacheSize() {
    return pathSize(this.rootDir);
  }

  private async deleteAsset(assetId: string) {
    await this.requestSharedDeletion(assetId);
    if (this.active.has(assetId)) {
      this.pendingDelete.add(assetId);
      return;
    }
    // Use the same cross-process claim as the worker. If another instance is
    // active, the durable delete marker makes it discard rather than publish.
    const claim = await this.acquireProcessingClaim(assetId);
    if (!claim) {
      this.pendingDelete.add(assetId);
      this.scheduleClaimRecovery(assetId);
      return;
    }
    try {
      await claim.assertOwned();
      this.pendingDelete.delete(assetId);
      this.manifests.delete(assetId);
      this.queued.delete(assetId);
      const recoveryTimer = this.claimRecoveryTimers.get(assetId);
      if (recoveryTimer) clearTimeout(recoveryTimer);
      this.claimRecoveryTimers.delete(assetId);
      const queueIndex = this.queue.indexOf(assetId);
      if (queueIndex >= 0) this.queue.splice(queueIndex, 1);
      await Promise.all(
        (await this.assetStoragePaths(assetId)).map((targetPath) =>
          fs.rm(targetPath, { recursive: true, force: true }),
        ),
      );
      await claim.assertOwned();
    } finally {
      await claim.release();
    }
    // The marker is cleared only after every physical deletion succeeds. A
    // disk/I/O failure leaves durable work for the next reconciliation scan.
    await fs.rm(this.deleteMarkerPath(assetId), { force: true });
  }

  private async assetStoragePaths(assetId: string) {
    const entries = await fs.readdir(this.rootDir, { withFileTypes: true });
    const fixed = new Set([
      this.manifestPath(assetId),
      this.pdfPath(assetId),
      this.sourcePath(assetId),
      this.preparedTempPath(assetId),
      this.workPath(assetId),
    ]);
    const escapedAssetId = assetId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const scratchPattern = new RegExp(
      `^${escapedAssetId}\\.[a-f0-9]{16}\\.(?:source|prepared)\\.tmp$|^${escapedAssetId}\\.[a-f0-9]{16}\\.work$`,
    );
    for (const entry of entries) {
      if (scratchPattern.test(entry.name)) {
        fixed.add(path.join(this.rootDir, entry.name));
      }
    }
    return [...fixed];
  }

  private manifestPath(assetId: string) {
    return path.join(this.rootDir, `${assetId}.json`);
  }

  private sourcePath(assetId: string, workspaceKey?: string) {
    return path.join(
      this.rootDir,
      `${assetId}${workspaceKey ? `.${workspaceKey}` : ""}.source.tmp`,
    );
  }

  private preparedTempPath(assetId: string, workspaceKey?: string) {
    return path.join(
      this.rootDir,
      `${assetId}${workspaceKey ? `.${workspaceKey}` : ""}.prepared.tmp`,
    );
  }

  private pdfPath(assetId: string) {
    return path.join(this.rootDir, `${assetId}.pdf`);
  }

  private workPath(assetId: string, workspaceKey?: string) {
    return path.join(
      this.rootDir,
      `${assetId}${workspaceKey ? `.${workspaceKey}` : ""}.work`,
    );
  }

  private claimPath(assetId: string) {
    return path.join(this.rootDir, `${assetId}.claim`);
  }

  private deleteMarkerPath(assetId: string) {
    return path.join(this.rootDir, `${assetId}.delete`);
  }
}

export const preparedFileService = new PreparedFileService();
