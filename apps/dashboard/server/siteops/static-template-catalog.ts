import { createHash, randomUUID } from "node:crypto";
import { createReadStream, createWriteStream, type ReadStream } from "node:fs";
import {
  lstat,
  mkdir,
  open,
  readFile,
  rename,
  rm,
  rmdir,
  stat,
  unlink,
  utimes,
  writeFile,
  type FileHandle,
} from "node:fs/promises";
import path from "node:path";
import { Readable, Transform, Writable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createInflateRaw, inflateRawSync } from "node:zlib";
import sharp from "sharp";
import { z } from "zod";

import {
  FROZEN_STATIC_TEMPLATE_CATALOG,
  STATIC_TEMPLATE_CATALOG_ENTRY_COUNT,
  STATIC_TEMPLATE_CATALOG_PAGE_COUNT,
  STATIC_TEMPLATE_CATALOG_PAGE_SIZE,
  STATIC_TEMPLATE_CATALOG_VERSION,
  STATIC_TEMPLATE_CATALOG_WORKFLOW_VERSION,
  type FrozenStaticTemplateDefinition,
} from "./static-template-catalog-manifest";
import {
  NATIVE_RUNTIME_CONTRACT_V1_SHA256,
  NATIVE_RUNTIME_EXECUTION_SHELL_V1_SHA256,
} from "./native-react-source";

export {
  FROZEN_STATIC_TEMPLATE_CATALOG,
  STATIC_TEMPLATE_CATALOG_ENTRY_COUNT,
  STATIC_TEMPLATE_CATALOG_PAGE_COUNT,
  STATIC_TEMPLATE_CATALOG_PAGE_SIZE,
  STATIC_TEMPLATE_CATALOG_VERSION,
  STATIC_TEMPLATE_CATALOG_WORKFLOW_VERSION,
} from "./static-template-catalog-manifest";

export const STATIC_TEMPLATE_SOURCE_MAX_BYTES = 192 * 1024 * 1024;
export const STATIC_TEMPLATE_PREVIEW_MAX_BYTES = 16 * 1024 * 1024;

const CATALOG_SCHEMA_VERSION = "frontmind-static-template-catalog-v2";
const LEGACY_CATALOG_SCHEMA_VERSION = "frontmind-static-template-catalog-v1";
const ACTIVE_SCHEMA_VERSION = "frontmind-static-template-catalog-active-v1";
const INTEGRITY_SCHEMA_VERSION =
  "frontmind-static-template-catalog-integrity-v1";
const CATALOG_RELATIVE_ROOT = "siteops/static-template-catalog";
const SOURCE_DOWNLOAD_TIMEOUT_MS = 8 * 60_000;
const PREVIEW_DOWNLOAD_TIMEOUT_MS = 2 * 60_000;
const MAX_ARCHIVE_ENTRIES = 100_000;
const MAX_ARCHIVE_EXPANDED_BYTES = 3 * 1024 * 1024 * 1024;
const MAX_ARCHIVE_ENTRY_EXPANDED_BYTES = 768 * 1024 * 1024;
const MAX_ARCHIVE_COMPRESSION_RATIO = 1_000;
const SEED_CONCURRENCY = 3;
const STALE_LOCK_MS = 20 * 60_000;
const SHA256 = /^[a-f0-9]{64}$/u;
const CATALOG_VERSION = /^[a-z0-9][a-z0-9._-]{0,190}$/u;
const WORKFLOW_VERSION = /^[0-9]+\.[0-9]+\.[0-9]+$/u;
const CANDIDATE_ID =
  /^static-template-[0-9]{2,3}-[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/u;
const DECIMAL_BIGINT = /^(?:0|[1-9][0-9]*)$/u;

const executionBindingSchema = z
  .object({
    catalogVersion: z.string().regex(CATALOG_VERSION),
    candidateId: z.string().regex(CANDIDATE_ID),
    rawSourceSha256: z.string().regex(SHA256),
  })
  .strict();

type StaticTemplateAdmissionDigestInput = {
  catalogVersion: string;
  candidateId: string;
  rawSourceSha256: string;
  normalizedSourceSha256: string;
  sourceTreeSha256: string;
  runtimeContractSha256: string;
  executionShellSha256: string;
  deliveryContractSha256: string;
  distSha256: string;
  qaSha256: string;
  browserReceiptSha256: string;
  qaStatus: "passed" | "passed_with_warnings";
};

/** Canonical cross-layer binding for every cryptographic admission receipt. */
export function staticTemplateAdmissionEvidenceSha256(
  input: StaticTemplateAdmissionDigestInput,
) {
  return createHash("sha256")
    .update(
      JSON.stringify({
        schemaVersion: 1,
        catalogVersion: input.catalogVersion,
        candidateId: input.candidateId,
        rawSourceSha256: input.rawSourceSha256,
        normalizedSourceSha256: input.normalizedSourceSha256,
        sourceTreeSha256: input.sourceTreeSha256,
        runtimeContractSha256: input.runtimeContractSha256,
        executionShellSha256: input.executionShellSha256,
        deliveryContractSha256: input.deliveryContractSha256,
        distSha256: input.distSha256,
        qaSha256: input.qaSha256,
        browserReceiptSha256: input.browserReceiptSha256,
        qaStatus: input.qaStatus,
      }),
    )
    .digest("hex");
}

const admittedExecutionSchema = z
  .object({
    status: z.literal("admitted"),
    binding: executionBindingSchema,
    framework: z.literal("vite_react"),
    normalizedSourceAssetId: z.string().min(1).max(512),
    normalizedSourcePath: z.string().min(1).max(1_024),
    normalizedSourceSha256: z.string().regex(SHA256),
    normalizedSourceBytes: z
      .number()
      .int()
      .min(1)
      .max(STATIC_TEMPLATE_SOURCE_MAX_BYTES),
    normalizedSourceFileCount: z.number().int().min(1).max(MAX_ARCHIVE_ENTRIES),
    normalizedSourceExpandedBytes: z
      .number()
      .int()
      .min(1)
      .max(MAX_ARCHIVE_EXPANDED_BYTES),
    sourceTreeSha256: z.string().regex(SHA256),
    runtimeContractSha256: z.literal(NATIVE_RUNTIME_CONTRACT_V1_SHA256),
    executionShellSha256: z.literal(NATIVE_RUNTIME_EXECUTION_SHELL_V1_SHA256),
    deliveryContractAssetId: z.string().min(1).max(512),
    deliveryContractPath: z.string().min(1).max(1_024),
    deliveryContractSha256: z.string().regex(SHA256),
    deliveryContractBytes: z
      .number()
      .int()
      .min(1)
      .max(4 * 1024 * 1024),
    distAssetId: z.string().min(1).max(512),
    distPath: z.string().min(1).max(1_024),
    distSha256: z.string().regex(SHA256),
    distBytes: z
      .number()
      .int()
      .min(1)
      .max(64 * 1024 * 1024),
    qaAssetId: z.string().min(1).max(512),
    qaPath: z.string().min(1).max(1_024),
    qaSha256: z.string().regex(SHA256),
    qaBytes: z
      .number()
      .int()
      .min(1)
      .max(4 * 1024 * 1024),
    browserReceiptAssetId: z.string().min(1).max(512),
    browserReceiptPath: z.string().min(1).max(1_024),
    browserReceiptSha256: z.string().regex(SHA256),
    browserReceiptBytes: z
      .number()
      .int()
      .min(1)
      .max(4 * 1024 * 1024),
    qaStatus: z.enum(["passed", "passed_with_warnings"]),
    admissionEvidenceSha256: z.string().regex(SHA256),
  })
  .strict();

const unavailableExecutionSchema = z
  .object({
    status: z.literal("unavailable"),
    binding: executionBindingSchema,
    code: z.string().regex(/^[A-Z0-9_]{3,120}$/u),
    reason: z.string().trim().min(1).max(500),
  })
  .strict();

const executionAdmissionSchema = z.discriminatedUnion("status", [
  admittedExecutionSchema,
  unavailableExecutionSchema,
]);

const entrySchema = z
  .object({
    order: z.number().int().min(1).max(512),
    page: z.number().int().min(1).max(64),
    pageIndex: z.number().int().min(0).max(63),
    candidateId: z.string().regex(CANDIDATE_ID),
    providerTemplateId: z.string().min(1).max(191),
    providerSlug: z.string().min(1).max(191),
    providerName: z.string().min(1).max(200),
    providerDescription: z.string().min(1).max(2_000),
    providerVersion: z.string().regex(/^[a-f0-9]{40}$/u),
    sourceOwner: z.string().min(1).max(100),
    sourceRepo: z.string().min(1).max(100),
    sourceCommitSha: z.string().regex(/^[a-f0-9]{40}$/u),
    sourceSubdirectory: z.string().min(1).max(1_024).nullable(),
    sourceLicense: z.enum(["MIT", "Apache-2.0"]),
    rawSourceAssetId: z.string().min(1).max(512),
    rawSourcePath: z.string().min(1).max(1_024),
    rawSourceSha256: z.string().regex(SHA256),
    rawSourceBytes: z
      .number()
      .int()
      .min(1)
      .max(STATIC_TEMPLATE_SOURCE_MAX_BYTES),
    rawSourceFileCount: z.number().int().min(1).max(MAX_ARCHIVE_ENTRIES),
    rawSourceExpandedBytes: z
      .number()
      .int()
      .min(1)
      .max(MAX_ARCHIVE_EXPANDED_BYTES),
    sourceAssetId: z.string().min(1).max(512),
    sourcePath: z.string().min(1).max(1_024),
    sourceSha256: z.string().regex(SHA256),
    sourceBytes: z.number().int().min(1).max(STATIC_TEMPLATE_SOURCE_MAX_BYTES),
    sourceFileCount: z.number().int().min(1).max(MAX_ARCHIVE_ENTRIES),
    sourceExpandedBytes: z
      .number()
      .int()
      .min(1)
      .max(MAX_ARCHIVE_EXPANDED_BYTES),
    previewAssetId: z.string().min(1).max(512),
    previewPath: z.string().min(1).max(1_024),
    previewSha256: z.string().regex(SHA256),
    previewBytes: z
      .number()
      .int()
      .min(1)
      .max(STATIC_TEMPLATE_PREVIEW_MAX_BYTES),
    previewMimeType: z.enum(["image/jpeg", "image/png", "image/webp"]),
    previewWidth: z.number().int().min(1).max(50_000),
    previewHeight: z.number().int().min(1).max(50_000),
    tags: z.array(z.string().min(1).max(80)).max(12),
    executionAdmission: executionAdmissionSchema,
  })
  .strict();

const legacyEntrySchema = entrySchema.omit({
  rawSourceAssetId: true,
  rawSourcePath: true,
  rawSourceSha256: true,
  rawSourceBytes: true,
  rawSourceFileCount: true,
  rawSourceExpandedBytes: true,
  executionAdmission: true,
});

const legacyCatalogSchema = z
  .object({
    schemaVersion: z.literal(LEGACY_CATALOG_SCHEMA_VERSION),
    workflowVersion: z.string().regex(WORKFLOW_VERSION),
    catalogVersion: z.string().regex(CATALOG_VERSION),
    pageSize: z.number().int().min(1).max(64),
    pageCount: z.number().int().min(1).max(64),
    entryCount: z.number().int().min(1).max(512),
    entries: z.array(legacyEntrySchema).min(1).max(512),
  })
  .strict();

const catalogSchema = z
  .object({
    schemaVersion: z.literal(CATALOG_SCHEMA_VERSION),
    workflowVersion: z.string().regex(WORKFLOW_VERSION),
    catalogVersion: z.string().regex(CATALOG_VERSION),
    pageSize: z.number().int().min(1).max(64),
    pageCount: z.number().int().min(1).max(64),
    entryCount: z.number().int().min(1).max(512),
    entries: z.array(entrySchema).min(1).max(512),
  })
  .strict();

const readableCatalogSchema = z.union([catalogSchema, legacyCatalogSchema]);

const integrityAssetSchema = z
  .object({
    candidateId: z.string().regex(CANDIDATE_ID),
    kind: z.enum([
      "raw_source",
      "normalized_source",
      "preview",
      "delivery_contract",
      "dist",
      "qa",
      "browser_receipt",
    ]),
    path: z.string().min(1).max(1_024),
    sha256: z.string().regex(SHA256),
    bytes: z.number().int().min(1).max(STATIC_TEMPLATE_SOURCE_MAX_BYTES),
    inode: z.string().regex(DECIMAL_BIGINT),
    modifiedNs: z.string().regex(DECIMAL_BIGINT),
    changedNs: z.string().regex(DECIMAL_BIGINT),
  })
  .strict();

const legacyIntegrityAssetSchema = integrityAssetSchema.extend({
  kind: z.enum(["source", "preview"]),
});

const integritySchema = z
  .object({
    schemaVersion: z.literal(INTEGRITY_SCHEMA_VERSION),
    workflowVersion: z.string().regex(WORKFLOW_VERSION),
    catalogVersion: z.string().regex(CATALOG_VERSION),
    manifestSha256: z.string().regex(SHA256),
    assets: z.array(integrityAssetSchema).min(2).max(1_024),
  })
  .strict();

const legacyIntegritySchema = integritySchema.extend({
  assets: z.array(legacyIntegrityAssetSchema).min(2).max(1_024),
});

const activeSchema = z
  .object({
    schemaVersion: z.literal(ACTIVE_SCHEMA_VERSION),
    workflowVersion: z.string().regex(WORKFLOW_VERSION),
    catalogVersion: z.string().regex(CATALOG_VERSION),
    manifestPath: z.string().min(1).max(1_024),
    manifestSha256: z.string().regex(SHA256),
    integrityPath: z.string().min(1).max(1_024),
    integritySha256: z.string().regex(SHA256),
  })
  .strict();

export type StaticTemplateCatalogEntry = z.infer<typeof entrySchema>;
export type StaticTemplateCatalog = z.infer<typeof catalogSchema>;
export type LegacyStaticTemplateCatalogEntry = z.infer<
  typeof legacyEntrySchema
>;
export type ReadableStaticTemplateCatalog =
  | StaticTemplateCatalog
  | z.infer<typeof legacyCatalogSchema>;
export type StaticTemplateExecutionAdmission = z.infer<
  typeof executionAdmissionSchema
>;

export type StaticTemplateExecutionAdmissionMaterial =
  | {
      status: "unavailable";
      code: string;
      reason: string;
    }
  | {
      status: "admitted";
      framework: "vite_react";
      normalizedSource: Buffer;
      sourceTreeSha256: string;
      runtimeContractSha256: string;
      executionShellSha256: string;
      contract: Buffer;
      dist: Buffer;
      qa: Buffer;
      browserReceipt: Buffer;
      qaStatus: "passed" | "passed_with_warnings";
    };

export type StaticTemplateExecutionAdmissionBuilder = (input: {
  catalogVersion: string;
  definition: FrozenStaticTemplateDefinition;
  rawSourcePath: string;
  rawSourceSha256: string;
  rawSourceBytes: number;
  signal: AbortSignal;
}) => Promise<StaticTemplateExecutionAdmissionMaterial>;

export class StaticTemplateCatalogError extends Error {
  constructor(public readonly code: string) {
    super(code);
    this.name = "StaticTemplateCatalogError";
  }
}

type CatalogOptions = {
  rootDir?: string;
  verifyAssetHashes?: boolean;
  verifyIntegrityStats?: boolean;
};

type SeedOptions = CatalogOptions & {
  fetchImpl?: typeof fetch;
  concurrency?: number;
  executionAdmissionBuilder?: StaticTemplateExecutionAdmissionBuilder;
};

type DownloadResult = { sha256: string; bytes: number };
type ArchiveInspection = { fileCount: number; expandedBytes: number };
type ZipArchiveEntry = {
  rawName: string;
  filename: string;
  isDirectory: boolean;
  versionMadeBy: number;
  versionNeeded: number;
  flags: number;
  compressionMethod: number;
  modifiedTime: number;
  modifiedDate: number;
  crc32: number;
  compressedBytes: number;
  uncompressedBytes: number;
  internalAttributes: number;
  externalAttributes: number;
  localHeaderOffset: number;
  dataOffset: number;
};
type ParsedZipArchive = ArchiveInspection & {
  archiveBytes: number;
  entries: ZipArchiveEntry[];
};
type PreviewInspection = {
  mimeType: StaticTemplateCatalogEntry["previewMimeType"];
  width: number;
  height: number;
};

const HIRAEL_TEMPLATE_SUPPORT_PATHS = Object.freeze([
  "package.json",
  "pnpm-lock.yaml",
  "pnpm-workspace.yaml",
  "tsconfig.json",
  "next.config.ts",
  "postcss.config.mjs",
  "components.json",
  "registry.json",
  "LICENSE",
  "README.md",
  "lib/utils.ts",
]);

function projectionSupportPaths(definition: FrozenStaticTemplateDefinition) {
  return definition.sourceOwner === "MohammadShehadeh" &&
    definition.sourceRepo === "hirael" &&
    definition.sourceCommitSha === "85b198f0ab19238ac3bdfe410cd9766d065b1974"
    ? HIRAEL_TEMPLATE_SUPPORT_PATHS
    : [];
}

function assetRoot(options: CatalogOptions = {}) {
  const configured =
    options.rootDir ?? process.env.FRONTMIND_DASHBOARD_ASSET_DIR?.trim();
  if (!configured && process.env.NODE_ENV === "production") {
    throw new StaticTemplateCatalogError(
      "STATIC_TEMPLATE_CATALOG_ASSET_DIR_REQUIRED",
    );
  }
  const root = path.resolve(
    configured || path.join(process.cwd(), ".frontmind-dashboard-assets"),
  );
  if (root === path.parse(root).root) {
    throw new StaticTemplateCatalogError(
      "STATIC_TEMPLATE_CATALOG_ASSET_DIR_INVALID",
    );
  }
  return root;
}

function catalogRoot(root: string) {
  return path.join(root, CATALOG_RELATIVE_ROOT);
}

function safeCatalogVersion(catalogVersion: string) {
  if (!CATALOG_VERSION.test(catalogVersion)) {
    throw new StaticTemplateCatalogError(
      "STATIC_TEMPLATE_CATALOG_VERSION_INVALID",
    );
  }
  return catalogVersion;
}

function catalogVersionDirectory(root: string, catalogVersion: string) {
  return path.join(
    catalogRoot(root),
    "catalogs",
    safeCatalogVersion(catalogVersion),
  );
}

function finalCatalogDirectory(root: string) {
  return catalogVersionDirectory(root, STATIC_TEMPLATE_CATALOG_VERSION);
}

function stagingCatalogDirectory(root: string) {
  return path.join(
    catalogRoot(root),
    "catalogs",
    `.${STATIC_TEMPLATE_CATALOG_VERSION}.staging`,
  );
}

function relativeAssetPath(root: string, absolutePath: string) {
  const relative = path.relative(root, absolutePath).split(path.sep).join("/");
  if (!relative || relative.startsWith("../") || path.isAbsolute(relative)) {
    throw new StaticTemplateCatalogError(
      "STATIC_TEMPLATE_CATALOG_PATH_INVALID",
    );
  }
  return relative;
}

function resolveCatalogAssetPath(root: string, relativePath: string) {
  if (
    !relativePath ||
    relativePath.includes("\\") ||
    path.posix.isAbsolute(relativePath) ||
    relativePath
      .split("/")
      .some((part) => part === "" || part === "." || part === "..")
  ) {
    throw new StaticTemplateCatalogError(
      "STATIC_TEMPLATE_CATALOG_PATH_INVALID",
    );
  }
  const resolved = path.resolve(root, ...relativePath.split("/"));
  if (!resolved.startsWith(`${root}${path.sep}`)) {
    throw new StaticTemplateCatalogError(
      "STATIC_TEMPLATE_CATALOG_PATH_INVALID",
    );
  }
  return resolved;
}

async function writeAtomicJson(target: string, value: unknown) {
  const bytes = Buffer.from(`${JSON.stringify(value, null, 2)}\n`, "utf8");
  await mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
  const temporary = `${target}.tmp-${randomUUID()}`;
  const handle = await open(temporary, "wx", 0o600);
  try {
    await handle.writeFile(bytes);
    await handle.sync();
  } finally {
    await handle.close();
  }
  await rename(temporary, target);
  return { bytes, sha256: createHash("sha256").update(bytes).digest("hex") };
}

async function readJson(target: string) {
  const bytes = await readFile(target);
  return { bytes, value: JSON.parse(bytes.toString("utf8")) as unknown };
}

async function regularFileSize(target: string) {
  const info = await lstat(target);
  if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1) {
    throw new StaticTemplateCatalogError(
      "STATIC_TEMPLATE_CATALOG_ASSET_INVALID",
    );
  }
  return info.size;
}

async function regularFileSignature(target: string) {
  const info = await lstat(target, { bigint: true });
  if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1n) {
    throw new StaticTemplateCatalogError(
      "STATIC_TEMPLATE_CATALOG_ASSET_INVALID",
    );
  }
  const bytes = Number(info.size);
  if (!Number.isSafeInteger(bytes)) {
    throw new StaticTemplateCatalogError(
      "STATIC_TEMPLATE_CATALOG_ASSET_INVALID",
    );
  }
  return {
    bytes,
    inode: info.ino.toString(10),
    modifiedNs: info.mtimeNs.toString(10),
    changedNs: info.ctimeNs.toString(10),
  };
}

function sameFileSignature(
  left: Awaited<ReturnType<typeof regularFileSignature>>,
  right: Awaited<ReturnType<typeof regularFileSignature>>,
) {
  return (
    left.bytes === right.bytes &&
    left.inode === right.inode &&
    left.modifiedNs === right.modifiedNs &&
    left.changedNs === right.changedNs
  );
}

async function hashFile(target: string): Promise<DownloadResult> {
  const expectedBytes = await regularFileSize(target);
  const hash = createHash("sha256");
  let bytes = 0;
  for await (const chunk of createReadStream(target)) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    bytes += buffer.byteLength;
    hash.update(buffer);
  }
  if (bytes !== expectedBytes) {
    throw new StaticTemplateCatalogError(
      "STATIC_TEMPLATE_CATALOG_ASSET_READ_INCOMPLETE",
    );
  }
  return { sha256: hash.digest("hex"), bytes };
}

function safeDownloadUrl(raw: string, kind: "source" | "preview") {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new StaticTemplateCatalogError(
      "STATIC_TEMPLATE_CATALOG_DOWNLOAD_URL_INVALID",
    );
  }
  const host = url.hostname.toLocaleLowerCase("en-US");
  const validHost =
    kind === "source"
      ? host === "codeload.github.com"
      : host === "21st.dev" || host.endsWith(".21st.dev");
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    (url.port && url.port !== "443") ||
    !validHost
  ) {
    throw new StaticTemplateCatalogError(
      "STATIC_TEMPLATE_CATALOG_DOWNLOAD_URL_INVALID",
    );
  }
  url.hash = "";
  return url;
}

async function streamDownload(input: {
  fetchImpl: typeof fetch;
  url: URL;
  target: string;
  maxBytes: number;
  timeoutMs: number;
}) {
  await mkdir(path.dirname(input.target), { recursive: true, mode: 0o700 });
  let lastError: unknown;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const temporary = `${input.target}.download-${randomUUID()}`;
    try {
      const response = await input.fetchImpl(input.url, {
        method: "GET",
        headers: { accept: "application/octet-stream" },
        redirect: "error",
        signal: AbortSignal.timeout(input.timeoutMs),
      });
      if (!response.ok || !response.body) {
        await response.body?.cancel().catch(() => undefined);
        throw new StaticTemplateCatalogError(
          "STATIC_TEMPLATE_CATALOG_DOWNLOAD_FAILED",
        );
      }
      const declared = Number(response.headers.get("content-length"));
      if (Number.isFinite(declared) && declared > input.maxBytes) {
        await response.body.cancel().catch(() => undefined);
        throw new StaticTemplateCatalogError(
          "STATIC_TEMPLATE_CATALOG_DOWNLOAD_TOO_LARGE",
        );
      }
      const hash = createHash("sha256");
      let bytes = 0;
      const limiter = new Transform({
        transform(chunk: Buffer, _encoding, callback) {
          const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
          bytes += buffer.byteLength;
          if (bytes > input.maxBytes) {
            callback(
              new StaticTemplateCatalogError(
                "STATIC_TEMPLATE_CATALOG_DOWNLOAD_TOO_LARGE",
              ),
            );
            return;
          }
          hash.update(buffer);
          callback(null, buffer);
        },
      });
      await pipeline(
        Readable.fromWeb(response.body as never),
        limiter,
        createWriteStream(temporary, { flags: "wx", mode: 0o600 }),
      );
      if (bytes === 0) {
        throw new StaticTemplateCatalogError(
          "STATIC_TEMPLATE_CATALOG_DOWNLOAD_EMPTY",
        );
      }
      await rename(temporary, input.target);
      return { sha256: hash.digest("hex"), bytes };
    } catch (error) {
      lastError = error;
      await unlink(temporary).catch(() => undefined);
      if (
        error instanceof StaticTemplateCatalogError &&
        (error.code === "STATIC_TEMPLATE_CATALOG_DOWNLOAD_TOO_LARGE" ||
          error.code === "STATIC_TEMPLATE_CATALOG_DOWNLOAD_EMPTY")
      ) {
        throw error;
      }
    }
  }
  if (lastError instanceof StaticTemplateCatalogError) throw lastError;
  throw new StaticTemplateCatalogError(
    "STATIC_TEMPLATE_CATALOG_DOWNLOAD_FAILED",
  );
}

async function readExactly(
  handle: FileHandle,
  length: number,
  position: number,
) {
  const buffer = Buffer.allocUnsafe(length);
  const result = await handle.read(buffer, 0, length, position);
  if (result.bytesRead !== length) {
    throw new StaticTemplateCatalogError("STATIC_TEMPLATE_CATALOG_ZIP_INVALID");
  }
  return buffer;
}

function safeArchivePath(rawName: string) {
  if (
    !rawName ||
    rawName.includes("\0") ||
    rawName.includes("\\") ||
    path.posix.isAbsolute(rawName) ||
    /^[a-z]:/iu.test(rawName)
  ) {
    throw new StaticTemplateCatalogError(
      "STATIC_TEMPLATE_CATALOG_ZIP_PATH_UNSAFE",
    );
  }
  const parts = rawName.split("/");
  const meaningful = rawName.endsWith("/") ? parts.slice(0, -1) : parts;
  if (
    meaningful.length === 0 ||
    meaningful.some((part) => !part || part === "." || part === "..")
  ) {
    throw new StaticTemplateCatalogError(
      "STATIC_TEMPLATE_CATALOG_ZIP_PATH_UNSAFE",
    );
  }
  return meaningful.join("/");
}

function archivePathLooksSecret(filename: string) {
  const lower = filename.toLocaleLowerCase("en-US");
  const basename = path.posix.basename(lower);
  const isExampleEnv = /\.(?:example|sample|template|dist)$/u.test(basename);
  return (
    ((basename === ".env" || basename.startsWith(".env.")) && !isExampleEnv) ||
    [".pypirc", ".netrc", "id_rsa", "id_ed25519", "credentials.json"].includes(
      basename,
    ) ||
    /(?:^|\/)\.aws\/credentials$/u.test(lower) ||
    /(?:^|\/)\.ssh\//u.test(lower) ||
    /(?:service[-_]?account|firebase[-_]?admin)[^/]*\.json$/u.test(basename) ||
    /\.(?:key|pem|p12|pfx)$/u.test(basename)
  );
}

function archivePathNeedsCredentialScan(filename: string) {
  return path.posix.basename(filename).toLocaleLowerCase("en-US") === ".npmrc";
}

function npmrcContainsEmbeddedCredential(value: string) {
  if (
    /\b(?:npm_[A-Za-z0-9]{24,}|github_pat_[A-Za-z0-9_]{30,}|gh[pousr]_[A-Za-z0-9]{30,})\b/u.test(
      value,
    )
  ) {
    return true;
  }
  for (const line of value.split(/\r?\n/u)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#") || trimmed.startsWith(";"))
      continue;
    const separator = trimmed.indexOf("=");
    if (separator < 0) continue;
    const key = trimmed.slice(0, separator).trim().toLocaleLowerCase("en-US");
    if (!/(?:_auth(?:token)?|password)$/u.test(key)) continue;
    const credential = trimmed.slice(separator + 1).trim();
    if (
      credential &&
      !/^\$(?:\{[A-Z_][A-Z0-9_]*\}|[A-Z_][A-Z0-9_]*)$/u.test(credential)
    ) {
      return true;
    }
  }
  return false;
}

async function readBoundedZipEntryPayload(input: {
  handle: FileHandle;
  dataOffset: number;
  compressedBytes: number;
  uncompressedBytes: number;
  compressionMethod: number;
  archiveBytes: number;
  maxBytes: number;
  errorCode: string;
}) {
  if (
    input.compressedBytes > input.maxBytes ||
    input.uncompressedBytes > input.maxBytes ||
    input.dataOffset + input.compressedBytes > input.archiveBytes
  ) {
    throw new StaticTemplateCatalogError(input.errorCode);
  }
  const compressed = await readExactly(
    input.handle,
    input.compressedBytes,
    input.dataOffset,
  );
  let payload: Buffer;
  try {
    payload =
      input.compressionMethod === 0
        ? compressed
        : inflateRawSync(compressed, { maxOutputLength: input.maxBytes });
  } catch {
    throw new StaticTemplateCatalogError(input.errorCode);
  }
  if (payload.byteLength !== input.uncompressedBytes) {
    throw new StaticTemplateCatalogError(input.errorCode);
  }
  return payload;
}

const CRC32_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let index = 0; index < table.length; index += 1) {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1) {
      value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    }
    table[index] = value >>> 0;
  }
  return table;
})();

function updateCrc32(current: number, chunk: Buffer) {
  let value = current;
  for (const byte of chunk) {
    value = CRC32_TABLE[(value ^ byte) & 0xff]! ^ (value >>> 8);
  }
  return value >>> 0;
}

async function verifyZipEntryCrc(input: {
  archivePath: string;
  handle: FileHandle;
  entry: ZipArchiveEntry;
}) {
  if (input.entry.compressedBytes === 0) {
    if (input.entry.uncompressedBytes !== 0 || input.entry.crc32 !== 0) {
      throw new StaticTemplateCatalogError(
        "STATIC_TEMPLATE_CATALOG_ZIP_CRC_INVALID",
      );
    }
    return;
  }
  let crc = 0xffffffff;
  let expandedBytes = 0;
  const sink = new Writable({
    write(chunk: Buffer, _encoding, callback) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      expandedBytes += buffer.byteLength;
      if (expandedBytes > input.entry.uncompressedBytes) {
        callback(
          new StaticTemplateCatalogError(
            "STATIC_TEMPLATE_CATALOG_ZIP_CRC_INVALID",
          ),
        );
        return;
      }
      crc = updateCrc32(crc, buffer);
      callback();
    },
  });
  const compressed = createReadStream(input.archivePath, {
    fd: input.handle.fd,
    autoClose: false,
    start: input.entry.dataOffset,
    end: input.entry.dataOffset + input.entry.compressedBytes - 1,
  });
  try {
    if (input.entry.compressionMethod === 8) {
      await pipeline(compressed, createInflateRaw(), sink);
    } else {
      await pipeline(compressed, sink);
    }
  } catch (error) {
    if (error instanceof StaticTemplateCatalogError) throw error;
    throw new StaticTemplateCatalogError(
      "STATIC_TEMPLATE_CATALOG_ZIP_CRC_INVALID",
    );
  }
  const actualCrc = (crc ^ 0xffffffff) >>> 0;
  if (
    expandedBytes !== input.entry.uncompressedBytes ||
    actualCrc !== input.entry.crc32
  ) {
    throw new StaticTemplateCatalogError(
      "STATIC_TEMPLATE_CATALOG_ZIP_CRC_INVALID",
    );
  }
}

async function readZipSymlinkTarget(input: {
  handle: FileHandle;
  dataOffset: number;
  compressedBytes: number;
  uncompressedBytes: number;
  compressionMethod: number;
  archiveBytes: number;
}) {
  const target = await readBoundedZipEntryPayload({
    ...input,
    maxBytes: 4_096,
    errorCode: "STATIC_TEMPLATE_CATALOG_ZIP_SYMLINK_INVALID",
  });
  if (target.byteLength === 0 || target.byteLength > 4_096) {
    throw new StaticTemplateCatalogError(
      "STATIC_TEMPLATE_CATALOG_ZIP_SYMLINK_INVALID",
    );
  }
  const value = target.toString("utf8");
  if (value.includes("\uFFFD") || value.includes("\0")) {
    throw new StaticTemplateCatalogError(
      "STATIC_TEMPLATE_CATALOG_ZIP_SYMLINK_INVALID",
    );
  }
  return value;
}

async function parseAndVerifyStaticTemplateSourceArchive(
  archivePath: string,
  options: { skipSecretCheck?: boolean } = {},
): Promise<ParsedZipArchive> {
  const archiveBytes = await regularFileSize(archivePath);
  if (archiveBytes < 22 || archiveBytes > STATIC_TEMPLATE_SOURCE_MAX_BYTES) {
    throw new StaticTemplateCatalogError("STATIC_TEMPLATE_CATALOG_ZIP_INVALID");
  }
  const handle = await open(archivePath, "r");
  try {
    const tailLength = Math.min(archiveBytes, 65_557);
    const tailOffset = archiveBytes - tailLength;
    const tail = await readExactly(handle, tailLength, tailOffset);
    let eocdIndex = -1;
    for (let index = tail.length - 22; index >= 0; index -= 1) {
      if (tail.readUInt32LE(index) === 0x06054b50) {
        const commentLength = tail.readUInt16LE(index + 20);
        if (index + 22 + commentLength === tail.length) {
          eocdIndex = index;
          break;
        }
      }
    }
    if (eocdIndex < 0) {
      throw new StaticTemplateCatalogError(
        "STATIC_TEMPLATE_CATALOG_ZIP_INVALID",
      );
    }
    const disk = tail.readUInt16LE(eocdIndex + 4);
    const centralDisk = tail.readUInt16LE(eocdIndex + 6);
    const diskEntries = tail.readUInt16LE(eocdIndex + 8);
    const totalEntries = tail.readUInt16LE(eocdIndex + 10);
    const centralBytes = tail.readUInt32LE(eocdIndex + 12);
    const centralOffset = tail.readUInt32LE(eocdIndex + 16);
    const eocdOffset = tailOffset + eocdIndex;
    if (
      disk !== 0 ||
      centralDisk !== 0 ||
      diskEntries !== totalEntries ||
      totalEntries < 1 ||
      totalEntries > MAX_ARCHIVE_ENTRIES ||
      totalEntries === 0xffff ||
      centralBytes === 0xffffffff ||
      centralOffset === 0xffffffff ||
      centralOffset + centralBytes !== eocdOffset
    ) {
      throw new StaticTemplateCatalogError(
        "STATIC_TEMPLATE_CATALOG_ZIP_INVALID",
      );
    }
    let cursor = centralOffset;
    let expandedBytes = 0;
    const seenPaths = new Set<string>();
    const entries: ZipArchiveEntry[] = [];
    for (let index = 0; index < totalEntries; index += 1) {
      const fixed = await readExactly(handle, 46, cursor);
      if (fixed.readUInt32LE(0) !== 0x02014b50) {
        throw new StaticTemplateCatalogError(
          "STATIC_TEMPLATE_CATALOG_ZIP_INVALID",
        );
      }
      const versionMadeBy = fixed.readUInt16LE(4);
      const versionNeeded = fixed.readUInt16LE(6);
      const flags = fixed.readUInt16LE(8);
      const compressionMethod = fixed.readUInt16LE(10);
      const modifiedTime = fixed.readUInt16LE(12);
      const modifiedDate = fixed.readUInt16LE(14);
      const crc32 = fixed.readUInt32LE(16);
      const compressedBytes = fixed.readUInt32LE(20);
      const uncompressedBytes = fixed.readUInt32LE(24);
      const nameLength = fixed.readUInt16LE(28);
      const extraLength = fixed.readUInt16LE(30);
      const commentLength = fixed.readUInt16LE(32);
      const diskStart = fixed.readUInt16LE(34);
      const internalAttributes = fixed.readUInt16LE(36);
      const externalAttributes = fixed.readUInt32LE(38);
      const localHeaderOffset = fixed.readUInt32LE(42);
      if (
        diskStart !== 0 ||
        flags & 0x1 ||
        (compressionMethod !== 0 && compressionMethod !== 8) ||
        compressedBytes === 0xffffffff ||
        uncompressedBytes === 0xffffffff ||
        localHeaderOffset === 0xffffffff ||
        nameLength < 1
      ) {
        throw new StaticTemplateCatalogError(
          "STATIC_TEMPLATE_CATALOG_ZIP_INVALID",
        );
      }
      const variableLength = nameLength + extraLength + commentLength;
      if (cursor + 46 + variableLength > centralOffset + centralBytes) {
        throw new StaticTemplateCatalogError(
          "STATIC_TEMPLATE_CATALOG_ZIP_INVALID",
        );
      }
      const variable = await readExactly(handle, variableLength, cursor + 46);
      const rawNameBytes = variable.subarray(0, nameLength);
      const rawName = rawNameBytes.toString("utf8");
      if (rawName.includes("\uFFFD")) {
        throw new StaticTemplateCatalogError(
          "STATIC_TEMPLATE_CATALOG_ZIP_PATH_UNSAFE",
        );
      }
      const filename = safeArchivePath(rawName);
      const isDirectory = rawName.endsWith("/");
      if (seenPaths.has(filename)) {
        throw new StaticTemplateCatalogError(
          "STATIC_TEMPLATE_CATALOG_ZIP_PATH_UNSAFE",
        );
      }
      seenPaths.add(filename);
      if (
        !options.skipSecretCheck &&
        !isDirectory &&
        archivePathLooksSecret(filename)
      ) {
        throw new StaticTemplateCatalogError(
          "STATIC_TEMPLATE_CATALOG_ZIP_SECRET_FILE",
        );
      }
      if (
        uncompressedBytes > MAX_ARCHIVE_ENTRY_EXPANDED_BYTES ||
        expandedBytes + uncompressedBytes > MAX_ARCHIVE_EXPANDED_BYTES ||
        (compressedBytes > 0 &&
          uncompressedBytes > 10 * 1024 * 1024 &&
          uncompressedBytes / compressedBytes > MAX_ARCHIVE_COMPRESSION_RATIO)
      ) {
        throw new StaticTemplateCatalogError(
          "STATIC_TEMPLATE_CATALOG_ZIP_BOMB",
        );
      }
      expandedBytes += uncompressedBytes;
      if (localHeaderOffset >= centralOffset) {
        throw new StaticTemplateCatalogError(
          "STATIC_TEMPLATE_CATALOG_ZIP_INVALID",
        );
      }
      const local = await readExactly(handle, 30, localHeaderOffset);
      if (
        local.readUInt32LE(0) !== 0x04034b50 ||
        local.readUInt16LE(8) !== compressionMethod ||
        local.readUInt16LE(6) & 0x1
      ) {
        throw new StaticTemplateCatalogError(
          "STATIC_TEMPLATE_CATALOG_ZIP_INVALID",
        );
      }
      const localNameLength = local.readUInt16LE(26);
      const localExtraLength = local.readUInt16LE(28);
      if (localNameLength !== nameLength) {
        throw new StaticTemplateCatalogError(
          "STATIC_TEMPLATE_CATALOG_ZIP_INVALID",
        );
      }
      const localName = await readExactly(
        handle,
        localNameLength,
        localHeaderOffset + 30,
      );
      if (!localName.equals(rawNameBytes)) {
        throw new StaticTemplateCatalogError(
          "STATIC_TEMPLATE_CATALOG_ZIP_INVALID",
        );
      }
      const dataOffset =
        localHeaderOffset + 30 + localNameLength + localExtraLength;
      if (dataOffset + compressedBytes > centralOffset) {
        throw new StaticTemplateCatalogError(
          "STATIC_TEMPLATE_CATALOG_ZIP_INVALID",
        );
      }
      entries.push({
        rawName,
        filename,
        isDirectory,
        versionMadeBy,
        versionNeeded,
        flags,
        compressionMethod,
        modifiedTime,
        modifiedDate,
        crc32,
        compressedBytes,
        uncompressedBytes,
        internalAttributes,
        externalAttributes,
        localHeaderOffset,
        dataOffset,
      });
      cursor += 46 + variableLength;
    }
    if (cursor !== centralOffset + centralBytes || expandedBytes < 1) {
      throw new StaticTemplateCatalogError(
        "STATIC_TEMPLATE_CATALOG_ZIP_INVALID",
      );
    }
    const dataRanges = entries
      .filter((entry) => entry.compressedBytes > 0)
      .map(
        (entry) =>
          [entry.dataOffset, entry.dataOffset + entry.compressedBytes] as const,
      )
      .sort((left, right) => left[0] - right[0]);
    for (let index = 1; index < dataRanges.length; index += 1) {
      if (dataRanges[index]![0] < dataRanges[index - 1]![1]) {
        throw new StaticTemplateCatalogError(
          "STATIC_TEMPLATE_CATALOG_ZIP_INVALID",
        );
      }
    }
    for (const entry of entries) {
      await verifyZipEntryCrc({ archivePath, handle, entry });
      if (
        !options.skipSecretCheck &&
        !entry.isDirectory &&
        archivePathNeedsCredentialScan(entry.filename)
      ) {
        const payload = await readBoundedZipEntryPayload({
          handle,
          dataOffset: entry.dataOffset,
          compressedBytes: entry.compressedBytes,
          uncompressedBytes: entry.uncompressedBytes,
          compressionMethod: entry.compressionMethod,
          archiveBytes,
          maxBytes: 64 * 1024,
          errorCode: "STATIC_TEMPLATE_CATALOG_ZIP_SECRET_FILE",
        });
        const value = payload.toString("utf8");
        if (
          value.includes("\uFFFD") ||
          value.includes("\0") ||
          npmrcContainsEmbeddedCredential(value)
        ) {
          throw new StaticTemplateCatalogError(
            "STATIC_TEMPLATE_CATALOG_ZIP_SECRET_FILE",
          );
        }
      }
      const unixMode = entry.externalAttributes >>> 16;
      if ((unixMode & 0o170000) !== 0o120000) continue;
      const target = await readZipSymlinkTarget({
        handle,
        dataOffset: entry.dataOffset,
        compressedBytes: entry.compressedBytes,
        uncompressedBytes: entry.uncompressedBytes,
        compressionMethod: entry.compressionMethod,
        archiveBytes,
      });
      if (target.includes("\\") || path.posix.isAbsolute(target)) {
        throw new StaticTemplateCatalogError(
          "STATIC_TEMPLATE_CATALOG_ZIP_SYMLINK_ESCAPES",
        );
      }
      const resolved = path.posix.normalize(
        path.posix.join(path.posix.dirname(entry.filename), target),
      );
      if (resolved === ".." || resolved.startsWith("../")) {
        throw new StaticTemplateCatalogError(
          "STATIC_TEMPLATE_CATALOG_ZIP_SYMLINK_ESCAPES",
        );
      }
    }
    return { archiveBytes, entries, fileCount: totalEntries, expandedBytes };
  } finally {
    await handle.close();
  }
}

/**
 * Inspects only the ZIP envelope and bounded symlink payloads. Provider source
 * remains inert data: spaces, @types, catch-all routes and API routes are not
 * interpreted or rejected here. The selected Manus result goes through the
 * existing full source/build/browser safety gate later.
 */
export async function inspectStaticTemplateSourceArchive(
  archivePath: string,
): Promise<ArchiveInspection> {
  const parsed = await parseAndVerifyStaticTemplateSourceArchive(archivePath);
  return { fileCount: parsed.fileCount, expandedBytes: parsed.expandedBytes };
}

async function writeFully(
  handle: FileHandle,
  buffer: Buffer,
  position: number,
) {
  let written = 0;
  while (written < buffer.byteLength) {
    const result = await handle.write(
      buffer,
      written,
      buffer.byteLength - written,
      position + written,
    );
    if (result.bytesWritten < 1) {
      throw new StaticTemplateCatalogError(
        "STATIC_TEMPLATE_CATALOG_ASSET_WRITE_INCOMPLETE",
      );
    }
    written += result.bytesWritten;
  }
}

async function copyArchiveRange(input: {
  archivePath: string;
  sourceHandle: FileHandle;
  targetHandle: FileHandle;
  sourceOffset: number;
  bytes: number;
  targetOffset: number;
}) {
  if (input.bytes === 0) return;
  let copied = 0;
  const stream = createReadStream(input.archivePath, {
    fd: input.sourceHandle.fd,
    autoClose: false,
    start: input.sourceOffset,
    end: input.sourceOffset + input.bytes - 1,
  });
  for await (const chunk of stream) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    await writeFully(input.targetHandle, buffer, input.targetOffset + copied);
    copied += buffer.byteLength;
  }
  if (copied !== input.bytes) {
    throw new StaticTemplateCatalogError(
      "STATIC_TEMPLATE_CATALOG_ASSET_READ_INCOMPLETE",
    );
  }
}

function selectProjectedArchiveEntries(
  archive: ParsedZipArchive,
  sourceSubdirectory: string,
  supportPaths: readonly string[],
) {
  const subdirectory = safeArchivePath(sourceSubdirectory);
  if (sourceSubdirectory.endsWith("/")) {
    throw new StaticTemplateCatalogError(
      "STATIC_TEMPLATE_CATALOG_SOURCE_SUBDIRECTORY_INVALID",
    );
  }
  const roots = new Set(
    archive.entries.map((entry) => entry.filename.split("/", 1)[0]!),
  );
  if (roots.size !== 1) {
    throw new StaticTemplateCatalogError(
      "STATIC_TEMPLATE_CATALOG_SOURCE_SUBDIRECTORY_INVALID",
    );
  }
  const archiveRoot = [...roots][0]!;
  const selectedRoot = `${archiveRoot}/${subdirectory}`;
  const ancestorDirectories = new Set<string>([archiveRoot]);
  const parts = subdirectory.split("/");
  for (let index = 1; index <= parts.length; index += 1) {
    ancestorDirectories.add(
      `${archiveRoot}/${parts.slice(0, index).join("/")}`,
    );
  }
  const requiredSupportFiles = new Set<string>();
  for (const supportPath of supportPaths) {
    const safeSupportPath = safeArchivePath(supportPath);
    if (supportPath.endsWith("/")) {
      throw new StaticTemplateCatalogError(
        "STATIC_TEMPLATE_CATALOG_SOURCE_SUPPORT_INVALID",
      );
    }
    requiredSupportFiles.add(`${archiveRoot}/${safeSupportPath}`);
    const supportParts = safeSupportPath.split("/");
    for (let index = 1; index < supportParts.length; index += 1) {
      ancestorDirectories.add(
        `${archiveRoot}/${supportParts.slice(0, index).join("/")}`,
      );
    }
  }
  const selected = archive.entries.filter(
    (entry) =>
      entry.filename === selectedRoot ||
      entry.filename.startsWith(`${selectedRoot}/`) ||
      requiredSupportFiles.has(entry.filename) ||
      (entry.isDirectory && ancestorDirectories.has(entry.filename)),
  );
  if (
    !selected.some(
      (entry) =>
        !entry.isDirectory && entry.filename.startsWith(`${selectedRoot}/`),
    )
  ) {
    throw new StaticTemplateCatalogError(
      "STATIC_TEMPLATE_CATALOG_SOURCE_SUBDIRECTORY_MISSING",
    );
  }
  for (const required of requiredSupportFiles) {
    if (
      !selected.some(
        (entry) => entry.filename === required && !entry.isDirectory,
      )
    ) {
      throw new StaticTemplateCatalogError(
        "STATIC_TEMPLATE_CATALOG_SOURCE_SUPPORT_MISSING",
      );
    }
  }
  return selected;
}

/**
 * Produces a deterministic candidate-specific ZIP without inflating source
 * files into Node memory. Compressed entry payloads are range-copied from the
 * already verified upstream archive and only the selected repository subtree
 * is retained. This is what makes monorepo templates independent, durable
 * source assets instead of nine aliases of the same repository ZIP.
 */
async function projectStaticTemplateSourceArchive(input: {
  archivePath: string;
  archive: ParsedZipArchive;
  sourceSubdirectory: string;
  supportPaths: readonly string[];
  target: string;
}) {
  const entries = selectProjectedArchiveEntries(
    input.archive,
    input.sourceSubdirectory,
    input.supportPaths,
  );
  if (entries.length > 0xfffe) {
    throw new StaticTemplateCatalogError("STATIC_TEMPLATE_CATALOG_ZIP_INVALID");
  }
  const projectedBytes =
    entries.reduce(
      (total, entry) =>
        total +
        30 +
        Buffer.byteLength(entry.rawName, "utf8") +
        entry.compressedBytes,
      0,
    ) +
    entries.reduce(
      (total, entry) => total + 46 + Buffer.byteLength(entry.rawName, "utf8"),
      0,
    ) +
    22;
  if (projectedBytes > STATIC_TEMPLATE_SOURCE_MAX_BYTES) {
    throw new StaticTemplateCatalogError(
      "STATIC_TEMPLATE_CATALOG_DOWNLOAD_TOO_LARGE",
    );
  }
  await mkdir(path.dirname(input.target), { recursive: true, mode: 0o700 });
  const temporary = `${input.target}.project-${randomUUID()}`;
  const sourceHandle = await open(input.archivePath, "r");
  const targetHandle = await open(temporary, "wx", 0o600);
  let completed = false;
  try {
    let outputOffset = 0;
    const centralRecords: Buffer[] = [];
    for (const entry of entries) {
      const name = Buffer.from(entry.rawName, "utf8");
      const localOffset = outputOffset;
      const local = Buffer.alloc(30);
      local.writeUInt32LE(0x04034b50, 0);
      local.writeUInt16LE(entry.versionNeeded, 4);
      local.writeUInt16LE(0x0800, 6);
      local.writeUInt16LE(entry.compressionMethod, 8);
      local.writeUInt16LE(entry.modifiedTime, 10);
      local.writeUInt16LE(entry.modifiedDate, 12);
      local.writeUInt32LE(entry.crc32, 14);
      local.writeUInt32LE(entry.compressedBytes, 18);
      local.writeUInt32LE(entry.uncompressedBytes, 22);
      local.writeUInt16LE(name.byteLength, 26);
      local.writeUInt16LE(0, 28);
      await writeFully(targetHandle, local, outputOffset);
      outputOffset += local.byteLength;
      await writeFully(targetHandle, name, outputOffset);
      outputOffset += name.byteLength;
      await copyArchiveRange({
        archivePath: input.archivePath,
        sourceHandle,
        targetHandle,
        sourceOffset: entry.dataOffset,
        bytes: entry.compressedBytes,
        targetOffset: outputOffset,
      });
      outputOffset += entry.compressedBytes;

      const central = Buffer.alloc(46 + name.byteLength);
      central.writeUInt32LE(0x02014b50, 0);
      central.writeUInt16LE(entry.versionMadeBy, 4);
      central.writeUInt16LE(entry.versionNeeded, 6);
      central.writeUInt16LE(0x0800, 8);
      central.writeUInt16LE(entry.compressionMethod, 10);
      central.writeUInt16LE(entry.modifiedTime, 12);
      central.writeUInt16LE(entry.modifiedDate, 14);
      central.writeUInt32LE(entry.crc32, 16);
      central.writeUInt32LE(entry.compressedBytes, 20);
      central.writeUInt32LE(entry.uncompressedBytes, 24);
      central.writeUInt16LE(name.byteLength, 28);
      central.writeUInt16LE(0, 30);
      central.writeUInt16LE(0, 32);
      central.writeUInt16LE(0, 34);
      central.writeUInt16LE(entry.internalAttributes, 36);
      central.writeUInt32LE(entry.externalAttributes, 38);
      central.writeUInt32LE(localOffset, 42);
      name.copy(central, 46);
      centralRecords.push(central);
    }
    const centralOffset = outputOffset;
    for (const central of centralRecords) {
      await writeFully(targetHandle, central, outputOffset);
      outputOffset += central.byteLength;
    }
    const centralBytes = outputOffset - centralOffset;
    const eocd = Buffer.alloc(22);
    eocd.writeUInt32LE(0x06054b50, 0);
    eocd.writeUInt16LE(0, 4);
    eocd.writeUInt16LE(0, 6);
    eocd.writeUInt16LE(entries.length, 8);
    eocd.writeUInt16LE(entries.length, 10);
    eocd.writeUInt32LE(centralBytes, 12);
    eocd.writeUInt32LE(centralOffset, 16);
    eocd.writeUInt16LE(0, 20);
    await writeFully(targetHandle, eocd, outputOffset);
    outputOffset += eocd.byteLength;
    if (outputOffset !== projectedBytes) {
      throw new StaticTemplateCatalogError(
        "STATIC_TEMPLATE_CATALOG_ASSET_WRITE_INCOMPLETE",
      );
    }
    await targetHandle.sync();
    completed = true;
  } finally {
    await Promise.allSettled([sourceHandle.close(), targetHandle.close()]);
    if (!completed) await unlink(temporary).catch(() => undefined);
  }
  await rename(temporary, input.target);
  return parseAndVerifyStaticTemplateSourceArchive(input.target);
}

async function copyStaticTemplateSourceArchive(input: {
  source: string;
  target: string;
}) {
  await mkdir(path.dirname(input.target), { recursive: true, mode: 0o700 });
  const temporary = `${input.target}.copy-${randomUUID()}`;
  const sourceHandle = await open(input.source, "r");
  const targetHandle = await open(temporary, "wx", 0o600);
  let completed = false;
  try {
    const bytes = await regularFileSize(input.source);
    await copyArchiveRange({
      archivePath: input.source,
      sourceHandle,
      targetHandle,
      sourceOffset: 0,
      bytes,
      targetOffset: 0,
    });
    await targetHandle.sync();
    completed = true;
  } finally {
    await Promise.allSettled([sourceHandle.close(), targetHandle.close()]);
    if (!completed) await unlink(temporary).catch(() => undefined);
  }
  await rename(temporary, input.target);
}

async function inspectPreview(previewPath: string): Promise<PreviewInspection> {
  const bytes = await regularFileSize(previewPath);
  if (bytes < 16 || bytes > STATIC_TEMPLATE_PREVIEW_MAX_BYTES) {
    throw new StaticTemplateCatalogError(
      "STATIC_TEMPLATE_CATALOG_PREVIEW_INVALID",
    );
  }
  let metadata: Awaited<ReturnType<ReturnType<typeof sharp>["metadata"]>>;
  try {
    metadata = await sharp(previewPath, { animated: false }).metadata();
  } catch {
    throw new StaticTemplateCatalogError(
      "STATIC_TEMPLATE_CATALOG_PREVIEW_INVALID",
    );
  }
  const mimeType =
    metadata.format === "jpeg"
      ? "image/jpeg"
      : metadata.format === "png"
        ? "image/png"
        : metadata.format === "webp"
          ? "image/webp"
          : null;
  if (
    !mimeType ||
    !Number.isSafeInteger(metadata.width) ||
    !Number.isSafeInteger(metadata.height) ||
    !metadata.width ||
    !metadata.height ||
    metadata.width > 50_000 ||
    metadata.height > 50_000
  ) {
    throw new StaticTemplateCatalogError(
      "STATIC_TEMPLATE_CATALOG_PREVIEW_INVALID",
    );
  }
  return { mimeType, width: metadata.width, height: metadata.height };
}

function sourceUrl(definition: FrozenStaticTemplateDefinition) {
  return safeDownloadUrl(
    `https://codeload.github.com/${encodeURIComponent(definition.sourceOwner)}/${encodeURIComponent(definition.sourceRepo)}/zip/${definition.sourceCommitSha}`,
    "source",
  );
}

function sourceFilename(definition: FrozenStaticTemplateDefinition) {
  return `${definition.candidateId}.zip`;
}

function previewFilename(definition: FrozenStaticTemplateDefinition) {
  return `${definition.candidateId}.preview`;
}

type UpstreamSourceArchive = {
  path: string;
  archive: ParsedZipArchive;
};

function sourceCoordinateKey(definition: FrozenStaticTemplateDefinition) {
  return [
    definition.sourceOwner,
    definition.sourceRepo,
    definition.sourceCommitSha,
  ].join("/");
}

async function loadOrDownloadUpstreamSourceArchive(input: {
  stagingDirectory: string;
  definition: FrozenStaticTemplateDefinition;
  fetchImpl: typeof fetch;
}) {
  const coordinate = sourceCoordinateKey(input.definition);
  const cacheName = `${createHash("sha256").update(coordinate).digest("hex")}.zip`;
  const target = path.join(input.stagingDirectory, ".upstream", cacheName);
  try {
    return {
      path: target,
      archive: await parseAndVerifyStaticTemplateSourceArchive(target, {
        skipSecretCheck: Boolean(input.definition.sourceSubdirectory),
      }),
    } satisfies UpstreamSourceArchive;
  } catch {
    await unlink(target).catch(() => undefined);
  }
  await streamDownload({
    fetchImpl: input.fetchImpl,
    url: sourceUrl(input.definition),
    target,
    maxBytes: STATIC_TEMPLATE_SOURCE_MAX_BYTES,
    timeoutMs: SOURCE_DOWNLOAD_TIMEOUT_MS,
  });
  return {
    path: target,
    archive: await parseAndVerifyStaticTemplateSourceArchive(target, {
      skipSecretCheck: Boolean(input.definition.sourceSubdirectory),
    }),
  } satisfies UpstreamSourceArchive;
}

function getUpstreamSourceArchive(input: {
  sourceArchives: Map<string, Promise<UpstreamSourceArchive>>;
  stagingDirectory: string;
  definition: FrozenStaticTemplateDefinition;
  fetchImpl: typeof fetch;
}) {
  const key = sourceCoordinateKey(input.definition);
  const existing = input.sourceArchives.get(key);
  if (existing) return existing;
  const loading = loadOrDownloadUpstreamSourceArchive(input);
  input.sourceArchives.set(key, loading);
  return loading;
}

function unavailableExecutionAdmission(input: {
  definition: FrozenStaticTemplateDefinition;
  rawSourceSha256: string;
  code?: string;
  reason?: string;
}): StaticTemplateExecutionAdmission {
  return unavailableExecutionSchema.parse({
    status: "unavailable",
    binding: {
      catalogVersion: STATIC_TEMPLATE_CATALOG_VERSION,
      candidateId: input.definition.candidateId,
      rawSourceSha256: input.rawSourceSha256,
    },
    code: input.code ?? "STATIC_TEMPLATE_EXECUTION_NOT_ADMITTED",
    reason:
      input.reason ??
      "该模板尚未完成 FrontMind 受控 Vite 构建与浏览器验收，当前不可选择。",
  });
}

async function writeAdmissionAsset(target: string, bytes: Buffer) {
  await mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
  await writeFile(target, bytes, { mode: 0o600 });
  return {
    bytes: bytes.byteLength,
    sha256: createHash("sha256").update(bytes).digest("hex"),
  };
}

async function materializeExecutionAdmission(input: {
  root: string;
  stagingDirectory: string;
  definition: FrozenStaticTemplateDefinition;
  rawSourcePath: string;
  rawSourceSha256: string;
  rawSourceBytes: number;
  builder?: StaticTemplateExecutionAdmissionBuilder;
}) {
  if (!input.builder) return unavailableExecutionAdmission(input);
  const controller = new AbortController();
  let material: StaticTemplateExecutionAdmissionMaterial;
  try {
    material = await input.builder({
      catalogVersion: STATIC_TEMPLATE_CATALOG_VERSION,
      definition: input.definition,
      rawSourcePath: input.rawSourcePath,
      rawSourceSha256: input.rawSourceSha256,
      rawSourceBytes: input.rawSourceBytes,
      signal: controller.signal,
    });
  } catch (error) {
    if (
      input.definition.candidateId ===
      "static-template-22-hirael-agency-landing"
    ) {
      throw error;
    }
    return unavailableExecutionAdmission({
      ...input,
      code: "STATIC_TEMPLATE_EXECUTION_ADMISSION_FAILED",
      reason:
        "该模板未通过 FrontMind 受控 Vite 构建或浏览器验收，当前不可选择。",
    });
  } finally {
    controller.abort();
  }
  if (material.status === "unavailable") {
    return unavailableExecutionAdmission({
      ...input,
      code: material.code,
      reason: material.reason,
    });
  }
  const base = path.join(
    input.stagingDirectory,
    "admissions",
    input.definition.candidateId,
  );
  const normalizedTarget = path.join(base, "normalized-source.zip");
  const [normalized, contract, dist, qa, browserReceipt] = await Promise.all([
    writeAdmissionAsset(normalizedTarget, material.normalizedSource),
    writeAdmissionAsset(
      path.join(base, "delivery-contract.json"),
      material.contract,
    ),
    writeAdmissionAsset(path.join(base, "dist.zip"), material.dist),
    writeAdmissionAsset(path.join(base, "qa.json"), material.qa),
    writeAdmissionAsset(
      path.join(base, "browser-receipt.json"),
      material.browserReceipt,
    ),
  ]);
  const normalizedArchive =
    await inspectStaticTemplateSourceArchive(normalizedTarget);
  const finalBase = path.join(
    finalCatalogDirectory(input.root),
    "admissions",
    input.definition.candidateId,
  );
  const assetId = (kind: string) =>
    `${STATIC_TEMPLATE_CATALOG_VERSION}/admission/${input.definition.candidateId}/${kind}`;
  const admitted = {
    status: "admitted",
    binding: {
      catalogVersion: STATIC_TEMPLATE_CATALOG_VERSION,
      candidateId: input.definition.candidateId,
      rawSourceSha256: input.rawSourceSha256,
    },
    framework: material.framework,
    normalizedSourceAssetId: assetId("normalized-source"),
    normalizedSourcePath: relativeAssetPath(
      input.root,
      path.join(finalBase, "normalized-source.zip"),
    ),
    normalizedSourceSha256: normalized.sha256,
    normalizedSourceBytes: normalized.bytes,
    normalizedSourceFileCount: normalizedArchive.fileCount,
    normalizedSourceExpandedBytes: normalizedArchive.expandedBytes,
    sourceTreeSha256: material.sourceTreeSha256,
    runtimeContractSha256: material.runtimeContractSha256,
    executionShellSha256: material.executionShellSha256,
    deliveryContractAssetId: assetId("delivery-contract"),
    deliveryContractPath: relativeAssetPath(
      input.root,
      path.join(finalBase, "delivery-contract.json"),
    ),
    deliveryContractSha256: contract.sha256,
    deliveryContractBytes: contract.bytes,
    distAssetId: assetId("dist"),
    distPath: relativeAssetPath(input.root, path.join(finalBase, "dist.zip")),
    distSha256: dist.sha256,
    distBytes: dist.bytes,
    qaAssetId: assetId("qa"),
    qaPath: relativeAssetPath(input.root, path.join(finalBase, "qa.json")),
    qaSha256: qa.sha256,
    qaBytes: qa.bytes,
    browserReceiptAssetId: assetId("browser-receipt"),
    browserReceiptPath: relativeAssetPath(
      input.root,
      path.join(finalBase, "browser-receipt.json"),
    ),
    browserReceiptSha256: browserReceipt.sha256,
    browserReceiptBytes: browserReceipt.bytes,
    qaStatus: material.qaStatus,
  } as const;
  return admittedExecutionSchema.parse({
    ...admitted,
    admissionEvidenceSha256: staticTemplateAdmissionEvidenceSha256({
      catalogVersion: admitted.binding.catalogVersion,
      candidateId: admitted.binding.candidateId,
      rawSourceSha256: admitted.binding.rawSourceSha256,
      normalizedSourceSha256: admitted.normalizedSourceSha256,
      sourceTreeSha256: admitted.sourceTreeSha256,
      runtimeContractSha256: admitted.runtimeContractSha256,
      executionShellSha256: admitted.executionShellSha256,
      deliveryContractSha256: admitted.deliveryContractSha256,
      distSha256: admitted.distSha256,
      qaSha256: admitted.qaSha256,
      browserReceiptSha256: admitted.browserReceiptSha256,
      qaStatus: admitted.qaStatus,
    }),
  });
}

async function materializeEntry(input: {
  root: string;
  stagingDirectory: string;
  definition: FrozenStaticTemplateDefinition;
  fetchImpl: typeof fetch;
  sourceArchives: Map<string, Promise<UpstreamSourceArchive>>;
  executionAdmissionBuilder?: StaticTemplateExecutionAdmissionBuilder;
}) {
  const sourceTarget = path.join(
    input.stagingDirectory,
    "sources",
    sourceFilename(input.definition),
  );
  const previewTarget = path.join(
    input.stagingDirectory,
    "previews",
    previewFilename(input.definition),
  );
  let sourceHash: DownloadResult;
  let archive: ArchiveInspection;
  if (input.definition.sourceSubdirectory) {
    const upstream = await getUpstreamSourceArchive(input);
    archive = await projectStaticTemplateSourceArchive({
      archivePath: upstream.path,
      archive: upstream.archive,
      sourceSubdirectory: input.definition.sourceSubdirectory,
      supportPaths: projectionSupportPaths(input.definition),
      target: sourceTarget,
    });
    sourceHash = await hashFile(sourceTarget);
  } else {
    try {
      sourceHash = await hashFile(sourceTarget);
      archive = await inspectStaticTemplateSourceArchive(sourceTarget);
    } catch {
      await unlink(sourceTarget).catch(() => undefined);
      const upstream = await getUpstreamSourceArchive(input);
      await copyStaticTemplateSourceArchive({
        source: upstream.path,
        target: sourceTarget,
      });
      sourceHash = await hashFile(sourceTarget);
      archive = await inspectStaticTemplateSourceArchive(sourceTarget);
    }
  }
  let previewHash: DownloadResult;
  let preview: PreviewInspection;
  try {
    previewHash = await hashFile(previewTarget);
    preview = await inspectPreview(previewTarget);
  } catch {
    await unlink(previewTarget).catch(() => undefined);
    previewHash = await streamDownload({
      fetchImpl: input.fetchImpl,
      url: safeDownloadUrl(input.definition.previewUrl, "preview"),
      target: previewTarget,
      maxBytes: STATIC_TEMPLATE_PREVIEW_MAX_BYTES,
      timeoutMs: PREVIEW_DOWNLOAD_TIMEOUT_MS,
    });
    preview = await inspectPreview(previewTarget);
  }
  const finalDirectory = finalCatalogDirectory(input.root);
  const rawSourcePath = relativeAssetPath(
    input.root,
    path.join(finalDirectory, "sources", sourceFilename(input.definition)),
  );
  const previewPath = relativeAssetPath(
    input.root,
    path.join(finalDirectory, "previews", previewFilename(input.definition)),
  );
  const executionAdmission = await materializeExecutionAdmission({
    root: input.root,
    stagingDirectory: input.stagingDirectory,
    definition: input.definition,
    rawSourcePath: sourceTarget,
    rawSourceSha256: sourceHash.sha256,
    rawSourceBytes: sourceHash.bytes,
    builder: input.executionAdmissionBuilder,
  });
  const executionSource =
    executionAdmission.status === "admitted"
      ? {
          assetId: executionAdmission.normalizedSourceAssetId,
          path: executionAdmission.normalizedSourcePath,
          sha256: executionAdmission.normalizedSourceSha256,
          bytes: executionAdmission.normalizedSourceBytes,
          fileCount: executionAdmission.normalizedSourceFileCount,
          expandedBytes: executionAdmission.normalizedSourceExpandedBytes,
        }
      : {
          assetId: `${STATIC_TEMPLATE_CATALOG_VERSION}/source/${input.definition.candidateId}`,
          path: rawSourcePath,
          sha256: sourceHash.sha256,
          bytes: sourceHash.bytes,
          fileCount: archive.fileCount,
          expandedBytes: archive.expandedBytes,
        };
  const entry = entrySchema.parse({
    order: input.definition.order,
    page: Math.ceil(input.definition.order / STATIC_TEMPLATE_CATALOG_PAGE_SIZE),
    pageIndex: (input.definition.order - 1) % STATIC_TEMPLATE_CATALOG_PAGE_SIZE,
    candidateId: input.definition.candidateId,
    providerTemplateId: input.definition.providerTemplateId,
    providerSlug: input.definition.providerSlug,
    providerName: input.definition.providerName,
    providerDescription: input.definition.providerDescription,
    providerVersion: input.definition.sourceCommitSha,
    sourceOwner: input.definition.sourceOwner,
    sourceRepo: input.definition.sourceRepo,
    sourceCommitSha: input.definition.sourceCommitSha,
    sourceSubdirectory: input.definition.sourceSubdirectory,
    sourceLicense: input.definition.sourceLicense,
    rawSourceAssetId: `${STATIC_TEMPLATE_CATALOG_VERSION}/raw-source/${input.definition.candidateId}`,
    rawSourcePath,
    rawSourceSha256: sourceHash.sha256,
    rawSourceBytes: sourceHash.bytes,
    rawSourceFileCount: archive.fileCount,
    rawSourceExpandedBytes: archive.expandedBytes,
    sourceAssetId: executionSource.assetId,
    sourcePath: executionSource.path,
    sourceSha256: executionSource.sha256,
    sourceBytes: executionSource.bytes,
    sourceFileCount: executionSource.fileCount,
    sourceExpandedBytes: executionSource.expandedBytes,
    previewAssetId: `${STATIC_TEMPLATE_CATALOG_VERSION}/preview/${input.definition.candidateId}`,
    previewPath,
    previewSha256: previewHash.sha256,
    previewBytes: previewHash.bytes,
    previewMimeType: preview.mimeType,
    previewWidth: preview.width,
    previewHeight: preview.height,
    tags: [...input.definition.tags],
    executionAdmission,
  });
  await writeAtomicJson(
    path.join(input.stagingDirectory, "records", `${entry.candidateId}.json`),
    entry,
  );
  return entry;
}

function assertCatalogCoordinates(catalog: StaticTemplateCatalog) {
  safeCatalogVersion(catalog.catalogVersion);
  const strictCurrent =
    catalog.catalogVersion === STATIC_TEMPLATE_CATALOG_VERSION;
  if (
    catalog.entryCount !== catalog.entries.length ||
    catalog.pageCount !== Math.ceil(catalog.entryCount / catalog.pageSize) ||
    (strictCurrent &&
      (catalog.workflowVersion !== STATIC_TEMPLATE_CATALOG_WORKFLOW_VERSION ||
        catalog.entryCount !== STATIC_TEMPLATE_CATALOG_ENTRY_COUNT ||
        catalog.pageSize !== STATIC_TEMPLATE_CATALOG_PAGE_SIZE ||
        catalog.pageCount !== STATIC_TEMPLATE_CATALOG_PAGE_COUNT))
  ) {
    throw new StaticTemplateCatalogError(
      "STATIC_TEMPLATE_CATALOG_MANIFEST_INVALID",
    );
  }
  const candidateIds = new Set<string>();
  const providerIds = new Set<string>();
  const rawSourceAssetIds = new Set<string>();
  const sourceAssetIds = new Set<string>();
  const previewAssetIds = new Set<string>();
  const rawSourcePaths = new Set<string>();
  const sourcePaths = new Set<string>();
  const previewPaths = new Set<string>();
  const rawSourceHashes = new Set<string>();
  const sourceHashes = new Set<string>();
  const previewHashes = new Set<string>();
  const catalogPathPrefix = `${CATALOG_RELATIVE_ROOT}/catalogs/${catalog.catalogVersion}`;
  const pathIsSafe = (value: string) =>
    !value.includes("\\") &&
    !path.posix.isAbsolute(value) &&
    value
      .split("/")
      .every((part) => part !== "" && part !== "." && part !== "..");
  for (let index = 0; index < catalog.entries.length; index += 1) {
    const entry = catalog.entries[index]!;
    const admission = entry.executionAdmission;
    const definition = strictCurrent
      ? FROZEN_STATIC_TEMPLATE_CATALOG[index]
      : undefined;
    if (entry.sourceSubdirectory) {
      if (
        entry.sourceSubdirectory.endsWith("/") ||
        safeArchivePath(entry.sourceSubdirectory) !== entry.sourceSubdirectory
      ) {
        throw new StaticTemplateCatalogError(
          "STATIC_TEMPLATE_CATALOG_MANIFEST_INVALID",
        );
      }
    }
    if (
      entry.order !== index + 1 ||
      entry.page !== Math.floor(index / catalog.pageSize) + 1 ||
      entry.page > catalog.pageCount ||
      entry.pageIndex !== index % catalog.pageSize ||
      entry.providerVersion !== entry.sourceCommitSha ||
      entry.rawSourceAssetId !==
        `${catalog.catalogVersion}/raw-source/${entry.candidateId}` ||
      admission.binding.catalogVersion !== catalog.catalogVersion ||
      admission.binding.candidateId !== entry.candidateId ||
      admission.binding.rawSourceSha256 !== entry.rawSourceSha256 ||
      (admission.status === "unavailable" &&
        (entry.sourceAssetId !==
          `${catalog.catalogVersion}/source/${entry.candidateId}` ||
          entry.sourcePath !== entry.rawSourcePath ||
          entry.sourceSha256 !== entry.rawSourceSha256 ||
          entry.sourceBytes !== entry.rawSourceBytes ||
          entry.sourceFileCount !== entry.rawSourceFileCount ||
          entry.sourceExpandedBytes !== entry.rawSourceExpandedBytes)) ||
      (admission.status === "admitted" &&
        (entry.sourceAssetId !== admission.normalizedSourceAssetId ||
          entry.sourcePath !== admission.normalizedSourcePath ||
          entry.sourceSha256 !== admission.normalizedSourceSha256 ||
          entry.sourceBytes !== admission.normalizedSourceBytes ||
          entry.sourceFileCount !== admission.normalizedSourceFileCount ||
          entry.sourceExpandedBytes !==
            admission.normalizedSourceExpandedBytes ||
          admission.admissionEvidenceSha256 !==
            staticTemplateAdmissionEvidenceSha256({
              catalogVersion: admission.binding.catalogVersion,
              candidateId: admission.binding.candidateId,
              rawSourceSha256: admission.binding.rawSourceSha256,
              normalizedSourceSha256: admission.normalizedSourceSha256,
              sourceTreeSha256: admission.sourceTreeSha256,
              runtimeContractSha256: admission.runtimeContractSha256,
              executionShellSha256: admission.executionShellSha256,
              deliveryContractSha256: admission.deliveryContractSha256,
              distSha256: admission.distSha256,
              qaSha256: admission.qaSha256,
              browserReceiptSha256: admission.browserReceiptSha256,
              qaStatus: admission.qaStatus,
            }))) ||
      entry.previewAssetId !==
        `${catalog.catalogVersion}/preview/${entry.candidateId}` ||
      !pathIsSafe(entry.rawSourcePath) ||
      !pathIsSafe(entry.sourcePath) ||
      !pathIsSafe(entry.previewPath) ||
      !entry.rawSourcePath.startsWith(`${catalogPathPrefix}/sources/`) ||
      (admission.status === "unavailable"
        ? !entry.sourcePath.startsWith(`${catalogPathPrefix}/sources/`)
        : !entry.sourcePath.startsWith(`${catalogPathPrefix}/admissions/`)) ||
      !entry.previewPath.startsWith(`${catalogPathPrefix}/previews/`) ||
      candidateIds.has(entry.candidateId) ||
      providerIds.has(entry.providerTemplateId) ||
      rawSourceAssetIds.has(entry.rawSourceAssetId) ||
      sourceAssetIds.has(entry.sourceAssetId) ||
      previewAssetIds.has(entry.previewAssetId) ||
      rawSourcePaths.has(entry.rawSourcePath) ||
      sourcePaths.has(entry.sourcePath) ||
      previewPaths.has(entry.previewPath) ||
      rawSourceHashes.has(entry.rawSourceSha256) ||
      sourceHashes.has(entry.sourceSha256) ||
      previewHashes.has(entry.previewSha256) ||
      (definition !== undefined &&
        (entry.candidateId !== definition.candidateId ||
          entry.providerTemplateId !== definition.providerTemplateId ||
          entry.providerSlug !== definition.providerSlug ||
          entry.providerName !== definition.providerName ||
          entry.providerDescription !== definition.providerDescription ||
          entry.sourceOwner !== definition.sourceOwner ||
          entry.sourceRepo !== definition.sourceRepo ||
          entry.sourceCommitSha !== definition.sourceCommitSha ||
          entry.sourceSubdirectory !== definition.sourceSubdirectory ||
          entry.sourceLicense !== definition.sourceLicense ||
          entry.rawSourcePath !==
            `${catalogPathPrefix}/sources/${sourceFilename(definition)}` ||
          entry.previewPath !==
            `${catalogPathPrefix}/previews/${previewFilename(definition)}` ||
          entry.tags.length !== definition.tags.length ||
          entry.tags.some(
            (tag, tagIndex) => tag !== definition.tags[tagIndex],
          )))
    ) {
      throw new StaticTemplateCatalogError(
        "STATIC_TEMPLATE_CATALOG_MANIFEST_INVALID",
      );
    }
    candidateIds.add(entry.candidateId);
    providerIds.add(entry.providerTemplateId);
    rawSourceAssetIds.add(entry.rawSourceAssetId);
    sourceAssetIds.add(entry.sourceAssetId);
    previewAssetIds.add(entry.previewAssetId);
    rawSourcePaths.add(entry.rawSourcePath);
    sourcePaths.add(entry.sourcePath);
    previewPaths.add(entry.previewPath);
    rawSourceHashes.add(entry.rawSourceSha256);
    sourceHashes.add(entry.sourceSha256);
    previewHashes.add(entry.previewSha256);
  }
  if (
    strictCurrent &&
    catalog.entries.find(
      (entry) =>
        entry.candidateId === "static-template-22-hirael-agency-landing",
    )?.executionAdmission.status !== "admitted"
  ) {
    throw new StaticTemplateCatalogError(
      "STATIC_TEMPLATE_CATALOG_REQUIRED_ADMISSION_MISSING",
    );
  }
}

function assertReadableCatalogCoordinates(
  catalog: ReadableStaticTemplateCatalog,
) {
  if (catalog.schemaVersion === CATALOG_SCHEMA_VERSION) {
    assertCatalogCoordinates(catalog);
    return;
  }
  safeCatalogVersion(catalog.catalogVersion);
  if (
    catalog.entryCount !== catalog.entries.length ||
    catalog.pageCount !== Math.ceil(catalog.entryCount / catalog.pageSize)
  ) {
    throw new StaticTemplateCatalogError(
      "STATIC_TEMPLATE_CATALOG_MANIFEST_INVALID",
    );
  }
  const candidateIds = new Set<string>();
  for (let index = 0; index < catalog.entries.length; index += 1) {
    const entry = catalog.entries[index]!;
    if (
      entry.order !== index + 1 ||
      entry.page !== Math.floor(index / catalog.pageSize) + 1 ||
      entry.pageIndex !== index % catalog.pageSize ||
      entry.providerVersion !== entry.sourceCommitSha ||
      candidateIds.has(entry.candidateId)
    ) {
      throw new StaticTemplateCatalogError(
        "STATIC_TEMPLATE_CATALOG_MANIFEST_INVALID",
      );
    }
    candidateIds.add(entry.candidateId);
  }
}

async function validateCatalogAssets(
  root: string,
  catalog: ReadableStaticTemplateCatalog,
) {
  assertReadableCatalogCoordinates(catalog);
  await Promise.all(
    expectedCatalogAssets(catalog).map(async (asset) => {
      if (
        (await regularFileSize(resolveCatalogAssetPath(root, asset.path))) !==
        asset.bytes
      ) {
        throw new StaticTemplateCatalogError(asset.sizeMismatchCode);
      }
    }),
  );
}

function expectedCatalogAssets(catalog: ReadableStaticTemplateCatalog) {
  if (catalog.schemaVersion === LEGACY_CATALOG_SCHEMA_VERSION) {
    return catalog.entries.flatMap((entry) => [
      {
        candidateId: entry.candidateId,
        kind: "source" as const,
        path: entry.sourcePath,
        sha256: entry.sourceSha256,
        bytes: entry.sourceBytes,
        mismatchCode: "STATIC_TEMPLATE_CATALOG_SOURCE_HASH_MISMATCH",
        sizeMismatchCode: "STATIC_TEMPLATE_CATALOG_SOURCE_SIZE_MISMATCH",
      },
      {
        candidateId: entry.candidateId,
        kind: "preview" as const,
        path: entry.previewPath,
        sha256: entry.previewSha256,
        bytes: entry.previewBytes,
        mismatchCode: "STATIC_TEMPLATE_CATALOG_PREVIEW_HASH_MISMATCH",
        sizeMismatchCode: "STATIC_TEMPLATE_CATALOG_PREVIEW_SIZE_MISMATCH",
      },
    ]);
  }
  return catalog.entries.flatMap((entry) => {
    const assets = [
      {
        candidateId: entry.candidateId,
        kind: "raw_source" as const,
        path: entry.rawSourcePath,
        sha256: entry.rawSourceSha256,
        bytes: entry.rawSourceBytes,
        mismatchCode: "STATIC_TEMPLATE_CATALOG_RAW_SOURCE_HASH_MISMATCH",
        sizeMismatchCode: "STATIC_TEMPLATE_CATALOG_RAW_SOURCE_SIZE_MISMATCH",
      },
      {
        candidateId: entry.candidateId,
        kind: "preview" as const,
        path: entry.previewPath,
        sha256: entry.previewSha256,
        bytes: entry.previewBytes,
        mismatchCode: "STATIC_TEMPLATE_CATALOG_PREVIEW_HASH_MISMATCH",
        sizeMismatchCode: "STATIC_TEMPLATE_CATALOG_PREVIEW_SIZE_MISMATCH",
      },
    ];
    if (entry.executionAdmission.status !== "admitted") return assets;
    const admission = entry.executionAdmission;
    return [
      assets[0]!,
      {
        candidateId: entry.candidateId,
        kind: "normalized_source" as const,
        path: admission.normalizedSourcePath,
        sha256: admission.normalizedSourceSha256,
        bytes: admission.normalizedSourceBytes,
        mismatchCode: "STATIC_TEMPLATE_CATALOG_SOURCE_HASH_MISMATCH",
        sizeMismatchCode: "STATIC_TEMPLATE_CATALOG_SOURCE_SIZE_MISMATCH",
      },
      assets[1]!,
      ...(
        [
          [
            "delivery_contract",
            admission.deliveryContractPath,
            admission.deliveryContractSha256,
            admission.deliveryContractBytes,
          ],
          [
            "dist",
            admission.distPath,
            admission.distSha256,
            admission.distBytes,
          ],
          ["qa", admission.qaPath, admission.qaSha256, admission.qaBytes],
          [
            "browser_receipt",
            admission.browserReceiptPath,
            admission.browserReceiptSha256,
            admission.browserReceiptBytes,
          ],
        ] as const
      ).map(([kind, assetPath, sha256, bytes]) => ({
        candidateId: entry.candidateId,
        kind,
        path: assetPath,
        sha256,
        bytes,
        mismatchCode: "STATIC_TEMPLATE_CATALOG_ADMISSION_HASH_MISMATCH",
        sizeMismatchCode: "STATIC_TEMPLATE_CATALOG_ADMISSION_SIZE_MISMATCH",
      })),
    ];
  });
}

async function verifyCatalogAssetHashes(
  root: string,
  catalog: ReadableStaticTemplateCatalog,
) {
  const expected = expectedCatalogAssets(catalog);
  const verified = new Array<
    | z.infer<typeof integrityAssetSchema>
    | z.infer<typeof legacyIntegrityAssetSchema>
  >(expected.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: 2 }, async () => {
      while (true) {
        const index = next;
        next += 1;
        if (index >= expected.length) return;
        const asset = expected[index]!;
        const target = resolveCatalogAssetPath(root, asset.path);
        const before = await regularFileSignature(target);
        const actual = await hashFile(target);
        const after = await regularFileSignature(target);
        if (
          !sameFileSignature(before, after) ||
          actual.bytes !== asset.bytes ||
          actual.sha256 !== asset.sha256
        ) {
          throw new StaticTemplateCatalogError(asset.mismatchCode);
        }
        const assetSchema =
          catalog.schemaVersion === LEGACY_CATALOG_SCHEMA_VERSION
            ? legacyIntegrityAssetSchema
            : integrityAssetSchema;
        verified[index] = assetSchema.parse({
          candidateId: asset.candidateId,
          kind: asset.kind,
          path: asset.path,
          sha256: asset.sha256,
          bytes: asset.bytes,
          inode: after.inode,
          modifiedNs: after.modifiedNs,
          changedNs: after.changedNs,
        });
      }
    }),
  );
  return verified;
}

async function validateIntegrityReceipt(input: {
  root: string;
  catalog: ReadableStaticTemplateCatalog;
  manifestSha256: string;
  integrityPath: string;
  integritySha256?: string;
  verifyStats?: boolean;
}) {
  let receipt:
    | z.infer<typeof integritySchema>
    | z.infer<typeof legacyIntegritySchema>;
  try {
    const loaded = await readJson(
      resolveCatalogAssetPath(input.root, input.integrityPath),
    );
    if (
      input.integritySha256 &&
      createHash("sha256").update(loaded.bytes).digest("hex") !==
        input.integritySha256
    ) {
      throw new StaticTemplateCatalogError(
        "STATIC_TEMPLATE_CATALOG_INTEGRITY_HASH_MISMATCH",
      );
    }
    receipt = (
      input.catalog.schemaVersion === LEGACY_CATALOG_SCHEMA_VERSION
        ? legacyIntegritySchema
        : integritySchema
    ).parse(loaded.value);
  } catch (error) {
    if (error instanceof StaticTemplateCatalogError) throw error;
    throw new StaticTemplateCatalogError(
      "STATIC_TEMPLATE_CATALOG_INTEGRITY_INVALID",
    );
  }
  if (
    receipt.manifestSha256 !== input.manifestSha256 ||
    receipt.catalogVersion !== input.catalog.catalogVersion ||
    receipt.workflowVersion !== input.catalog.workflowVersion ||
    receipt.assets.length !== expectedCatalogAssets(input.catalog).length
  ) {
    throw new StaticTemplateCatalogError(
      "STATIC_TEMPLATE_CATALOG_INTEGRITY_INVALID",
    );
  }
  const expected = expectedCatalogAssets(input.catalog);
  await Promise.all(
    receipt.assets.map(async (asset, index) => {
      const coordinate = expected[index];
      if (
        !coordinate ||
        asset.candidateId !== coordinate.candidateId ||
        asset.kind !== coordinate.kind ||
        asset.path !== coordinate.path ||
        asset.sha256 !== coordinate.sha256 ||
        asset.bytes !== coordinate.bytes
      ) {
        throw new StaticTemplateCatalogError(
          "STATIC_TEMPLATE_CATALOG_INTEGRITY_INVALID",
        );
      }
      if (input.verifyStats !== false) {
        const current = await regularFileSignature(
          resolveCatalogAssetPath(input.root, asset.path),
        );
        if (
          current.bytes !== asset.bytes ||
          current.inode !== asset.inode ||
          current.modifiedNs !== asset.modifiedNs ||
          current.changedNs !== asset.changedNs
        ) {
          throw new StaticTemplateCatalogError(
            "STATIC_TEMPLATE_CATALOG_INTEGRITY_STAT_MISMATCH",
          );
        }
      }
    }),
  );
}

async function writeCatalogIntegrityReceipt(input: {
  root: string;
  catalog: StaticTemplateCatalog;
  manifestSha256: string;
  verifiedAssets?: z.infer<typeof integrityAssetSchema>[];
}) {
  const receipt = integritySchema.parse({
    schemaVersion: INTEGRITY_SCHEMA_VERSION,
    workflowVersion: STATIC_TEMPLATE_CATALOG_WORKFLOW_VERSION,
    catalogVersion: STATIC_TEMPLATE_CATALOG_VERSION,
    manifestSha256: input.manifestSha256,
    assets:
      input.verifiedAssets ??
      (await verifyCatalogAssetHashes(input.root, input.catalog)),
  });
  return writeAtomicJson(
    path.join(finalCatalogDirectory(input.root), "integrity.json"),
    receipt,
  );
}

async function loadCatalogManifestAt(
  root: string,
  manifestPath: string,
  options: { verifyAssetHashes?: boolean; verifyAssetSizes?: boolean } = {},
) {
  const resolved = resolveCatalogAssetPath(root, manifestPath);
  const { bytes, value } = await readJson(resolved);
  const catalog = readableCatalogSchema.parse(value);
  assertReadableCatalogCoordinates(catalog);
  if (options.verifyAssetSizes) {
    await validateCatalogAssets(root, catalog);
  }
  const verifiedAssets = options.verifyAssetHashes
    ? await verifyCatalogAssetHashes(root, catalog)
    : undefined;
  return {
    catalog,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    verifiedAssets,
  };
}

function catalogVersionRelativePath(
  root: string,
  catalogVersion: string,
  filename: "manifest.json" | "integrity.json",
) {
  return relativeAssetPath(
    root,
    path.join(catalogVersionDirectory(root, catalogVersion), filename),
  );
}

/**
 * Loads one immutable catalog version directly. It never consults active.json,
 * so a project frozen to v1 keeps resolving v1 after a future catalog becomes
 * active for new tasks.
 */
export async function loadStaticTemplateCatalogVersion(
  catalogVersion: string,
  options: CatalogOptions = {},
): Promise<ReadableStaticTemplateCatalog | null> {
  const version = safeCatalogVersion(catalogVersion);
  const root = assetRoot(options);
  const manifestPath = catalogVersionRelativePath(
    root,
    version,
    "manifest.json",
  );
  let loaded: Awaited<ReturnType<typeof loadCatalogManifestAt>>;
  try {
    loaded = await loadCatalogManifestAt(root, manifestPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === "ENOENT") return null;
    if (error instanceof SyntaxError || error instanceof z.ZodError) {
      throw new StaticTemplateCatalogError(
        "STATIC_TEMPLATE_CATALOG_MANIFEST_INVALID",
      );
    }
    throw error;
  }
  if (loaded.catalog.catalogVersion !== version) {
    throw new StaticTemplateCatalogError(
      "STATIC_TEMPLATE_CATALOG_VERSION_MISMATCH",
    );
  }
  await validateIntegrityReceipt({
    root,
    catalog: loaded.catalog,
    manifestSha256: loaded.sha256,
    integrityPath: catalogVersionRelativePath(root, version, "integrity.json"),
    verifyStats: Boolean(
      options.verifyIntegrityStats || options.verifyAssetHashes,
    ),
  });
  if (options.verifyAssetHashes) {
    await verifyCatalogAssetHashes(root, loaded.catalog);
  }
  return loaded.catalog;
}

export async function requireStaticTemplateCatalogVersion(
  catalogVersion: string,
  options: CatalogOptions = {},
) {
  const catalog = await loadStaticTemplateCatalogVersion(
    catalogVersion,
    options,
  );
  if (!catalog) {
    throw new StaticTemplateCatalogError(
      "STATIC_TEMPLATE_CATALOG_VERSION_NOT_FOUND",
    );
  }
  return catalog;
}

export async function loadActiveStaticTemplateCatalog(
  options: CatalogOptions = {},
): Promise<StaticTemplateCatalog | null> {
  const root = assetRoot(options);
  const activePath = path.join(catalogRoot(root), "active.json");
  let activeValue: unknown;
  try {
    activeValue = (await readJson(activePath)).value;
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === "ENOENT") return null;
    if (error instanceof SyntaxError) {
      throw new StaticTemplateCatalogError(
        "STATIC_TEMPLATE_CATALOG_MANIFEST_INVALID",
      );
    }
    throw error;
  }
  try {
    const active = activeSchema.parse(activeValue);
    if (
      active.catalogVersion !== STATIC_TEMPLATE_CATALOG_VERSION ||
      active.workflowVersion !== STATIC_TEMPLATE_CATALOG_WORKFLOW_VERSION
    ) {
      throw new StaticTemplateCatalogError(
        "STATIC_TEMPLATE_CATALOG_VERSION_MISMATCH",
      );
    }
    const expectedManifestPath = catalogVersionRelativePath(
      root,
      active.catalogVersion,
      "manifest.json",
    );
    const expectedIntegrityPath = catalogVersionRelativePath(
      root,
      active.catalogVersion,
      "integrity.json",
    );
    if (
      active.manifestPath !== expectedManifestPath ||
      active.integrityPath !== expectedIntegrityPath
    ) {
      throw new StaticTemplateCatalogError(
        "STATIC_TEMPLATE_CATALOG_ACTIVE_POINTER_INVALID",
      );
    }
    const loaded = await loadCatalogManifestAt(root, active.manifestPath);
    if (loaded.catalog.schemaVersion !== CATALOG_SCHEMA_VERSION) {
      throw new StaticTemplateCatalogError(
        "STATIC_TEMPLATE_CATALOG_VERSION_MISMATCH",
      );
    }
    if (loaded.sha256 !== active.manifestSha256) {
      throw new StaticTemplateCatalogError(
        "STATIC_TEMPLATE_CATALOG_MANIFEST_HASH_MISMATCH",
      );
    }
    if (options.verifyIntegrityStats || options.verifyAssetHashes) {
      await validateIntegrityReceipt({
        root,
        catalog: loaded.catalog,
        manifestSha256: loaded.sha256,
        integrityPath: active.integrityPath,
        integritySha256: active.integritySha256,
      });
    }
    if (options.verifyAssetHashes) {
      await verifyCatalogAssetHashes(root, loaded.catalog);
    }
    return loaded.catalog;
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === "ENOENT") {
      throw new StaticTemplateCatalogError(
        "STATIC_TEMPLATE_CATALOG_ASSET_MISSING",
      );
    }
    if (error instanceof SyntaxError || error instanceof z.ZodError) {
      throw new StaticTemplateCatalogError(
        "STATIC_TEMPLATE_CATALOG_MANIFEST_INVALID",
      );
    }
    throw error;
  }
}

export async function requireActiveStaticTemplateCatalog(
  options: CatalogOptions = {},
) {
  const catalog = await loadActiveStaticTemplateCatalog(options);
  if (!catalog) {
    throw new StaticTemplateCatalogError("STATIC_TEMPLATE_CATALOG_NOT_ACTIVE");
  }
  return catalog;
}

export async function getActiveStaticTemplateCatalogEntry(
  candidateId: string,
  options: CatalogOptions = {},
) {
  if (!CANDIDATE_ID.test(candidateId)) {
    throw new StaticTemplateCatalogError(
      "STATIC_TEMPLATE_CATALOG_CANDIDATE_INVALID",
    );
  }
  const catalog = await requireActiveStaticTemplateCatalog(options);
  const entry = catalog.entries.find(
    (candidate) => candidate.candidateId === candidateId,
  );
  if (!entry) {
    throw new StaticTemplateCatalogError(
      "STATIC_TEMPLATE_CATALOG_CANDIDATE_NOT_FOUND",
    );
  }
  return entry;
}

export async function getStaticTemplateCatalogVersionEntry(
  catalogVersion: string,
  candidateId: string,
  options: CatalogOptions = {},
) {
  if (!CANDIDATE_ID.test(candidateId)) {
    throw new StaticTemplateCatalogError(
      "STATIC_TEMPLATE_CATALOG_CANDIDATE_INVALID",
    );
  }
  const catalog = await requireStaticTemplateCatalogVersion(
    catalogVersion,
    options,
  );
  const entry = catalog.entries.find(
    (candidate) => candidate.candidateId === candidateId,
  );
  if (!entry) {
    throw new StaticTemplateCatalogError(
      "STATIC_TEMPLATE_CATALOG_CANDIDATE_NOT_FOUND",
    );
  }
  return entry;
}

export async function openStaticTemplateCatalogVersionSource(
  catalogVersion: string,
  candidateId: string,
  options: CatalogOptions = {},
): Promise<{
  entry: StaticTemplateCatalogEntry | LegacyStaticTemplateCatalogEntry;
  path: string;
  stream: ReadStream;
}> {
  const root = assetRoot(options);
  const entry = await getStaticTemplateCatalogVersionEntry(
    catalogVersion,
    candidateId,
    options,
  );
  if (
    "executionAdmission" in entry &&
    (entry as StaticTemplateCatalogEntry).executionAdmission.status !==
      "admitted"
  ) {
    throw new StaticTemplateCatalogError(
      "STATIC_TEMPLATE_CATALOG_EXECUTION_NOT_ADMITTED",
    );
  }
  const sourcePath = resolveCatalogAssetPath(root, entry.sourcePath);
  const actual = await hashFile(sourcePath);
  if (
    actual.bytes !== entry.sourceBytes ||
    actual.sha256 !== entry.sourceSha256
  ) {
    throw new StaticTemplateCatalogError(
      "STATIC_TEMPLATE_CATALOG_SOURCE_HASH_MISMATCH",
    );
  }
  return { entry, path: sourcePath, stream: createReadStream(sourcePath) };
}

export async function openStaticTemplateCatalogVersionPreview(
  catalogVersion: string,
  candidateId: string,
  options: CatalogOptions = {},
): Promise<{
  entry: StaticTemplateCatalogEntry | LegacyStaticTemplateCatalogEntry;
  path: string;
  stream: ReadStream;
}> {
  const root = assetRoot(options);
  const entry = await getStaticTemplateCatalogVersionEntry(
    catalogVersion,
    candidateId,
    options,
  );
  const previewPath = resolveCatalogAssetPath(root, entry.previewPath);
  const actual = await hashFile(previewPath);
  if (
    actual.bytes !== entry.previewBytes ||
    actual.sha256 !== entry.previewSha256
  ) {
    throw new StaticTemplateCatalogError(
      "STATIC_TEMPLATE_CATALOG_PREVIEW_HASH_MISMATCH",
    );
  }
  return { entry, path: previewPath, stream: createReadStream(previewPath) };
}

export async function readStaticTemplateCatalogVersionPreview(
  catalogVersion: string,
  candidateId: string,
  options: CatalogOptions = {},
) {
  const opened = await openStaticTemplateCatalogVersionPreview(
    catalogVersion,
    candidateId,
    options,
  );
  opened.stream.destroy();
  return { entry: opened.entry, bytes: await readFile(opened.path) };
}

export async function openStaticTemplateCatalogSource(
  candidateId: string,
  options: CatalogOptions = {},
): Promise<{
  entry: StaticTemplateCatalogEntry;
  path: string;
  stream: ReadStream;
}> {
  const root = assetRoot(options);
  const entry = await getActiveStaticTemplateCatalogEntry(candidateId, options);
  if (entry.executionAdmission.status !== "admitted") {
    throw new StaticTemplateCatalogError(
      "STATIC_TEMPLATE_CATALOG_EXECUTION_NOT_ADMITTED",
    );
  }
  const sourcePath = resolveCatalogAssetPath(root, entry.sourcePath);
  const actual = await hashFile(sourcePath);
  if (
    actual.bytes !== entry.sourceBytes ||
    actual.sha256 !== entry.sourceSha256
  ) {
    throw new StaticTemplateCatalogError(
      "STATIC_TEMPLATE_CATALOG_SOURCE_HASH_MISMATCH",
    );
  }
  return { entry, path: sourcePath, stream: createReadStream(sourcePath) };
}

export async function openStaticTemplateCatalogPreview(
  candidateId: string,
  options: CatalogOptions = {},
): Promise<{
  entry: StaticTemplateCatalogEntry;
  path: string;
  stream: ReadStream;
}> {
  const root = assetRoot(options);
  const entry = await getActiveStaticTemplateCatalogEntry(candidateId, options);
  const previewPath = resolveCatalogAssetPath(root, entry.previewPath);
  const actual = await hashFile(previewPath);
  if (
    actual.bytes !== entry.previewBytes ||
    actual.sha256 !== entry.previewSha256
  ) {
    throw new StaticTemplateCatalogError(
      "STATIC_TEMPLATE_CATALOG_PREVIEW_HASH_MISMATCH",
    );
  }
  return { entry, path: previewPath, stream: createReadStream(previewPath) };
}

export async function readStaticTemplateCatalogPreview(
  candidateId: string,
  options: CatalogOptions = {},
) {
  const opened = await openStaticTemplateCatalogPreview(candidateId, options);
  opened.stream.destroy();
  return { entry: opened.entry, bytes: await readFile(opened.path) };
}

async function acquireSeedLock(root: string) {
  const lockPath = path.join(catalogRoot(root), ".seed-lock");
  await mkdir(catalogRoot(root), { recursive: true, mode: 0o700 });
  try {
    await mkdir(lockPath, { mode: 0o700 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code !== "EEXIST") throw error;
    const lockStat = await stat(lockPath);
    if (Date.now() - lockStat.mtimeMs <= STALE_LOCK_MS) {
      throw new StaticTemplateCatalogError(
        "STATIC_TEMPLATE_CATALOG_SEED_IN_PROGRESS",
      );
    }
    await rename(lockPath, `${lockPath}.stale-${randomUUID()}`);
    await mkdir(lockPath, { mode: 0o700 });
  }
  await writeFile(
    path.join(lockPath, "owner.json"),
    `${JSON.stringify({ pid: process.pid, catalogVersion: STATIC_TEMPLATE_CATALOG_VERSION })}\n`,
    { flag: "wx", mode: 0o600 },
  );
  const heartbeat = async () => {
    const now = new Date();
    await utimes(lockPath, now, now);
  };
  const release = async () => {
    await unlink(path.join(lockPath, "owner.json")).catch(() => undefined);
    await rmdir(lockPath).catch(() => undefined);
  };
  return { heartbeat, release };
}

async function activateCatalog(
  root: string,
  manifestSha256: string,
  integritySha256: string,
) {
  const manifestPath = relativeAssetPath(
    root,
    path.join(finalCatalogDirectory(root), "manifest.json"),
  );
  const integrityPath = relativeAssetPath(
    root,
    path.join(finalCatalogDirectory(root), "integrity.json"),
  );
  await writeAtomicJson(path.join(catalogRoot(root), "active.json"), {
    schemaVersion: ACTIVE_SCHEMA_VERSION,
    workflowVersion: STATIC_TEMPLATE_CATALOG_WORKFLOW_VERSION,
    catalogVersion: STATIC_TEMPLATE_CATALOG_VERSION,
    manifestPath,
    manifestSha256,
    integrityPath,
    integritySha256,
  });
}

async function activateExistingFinalCatalog(root: string) {
  const manifestPath = relativeAssetPath(
    root,
    path.join(finalCatalogDirectory(root), "manifest.json"),
  );
  const loaded = await loadCatalogManifestAt(root, manifestPath, {
    verifyAssetHashes: true,
  });
  if (loaded.catalog.schemaVersion !== CATALOG_SCHEMA_VERSION) {
    throw new StaticTemplateCatalogError(
      "STATIC_TEMPLATE_CATALOG_VERSION_CONFLICT",
    );
  }
  const integrity = await writeCatalogIntegrityReceipt({
    root,
    catalog: loaded.catalog,
    manifestSha256: loaded.sha256,
  });
  await activateCatalog(root, loaded.sha256, integrity.sha256);
  return loaded.catalog;
}

async function loadVerifiedActiveCatalog(root: string) {
  try {
    return await loadActiveStaticTemplateCatalog({
      rootDir: root,
      verifyAssetHashes: true,
    });
  } catch (error) {
    if (error instanceof StaticTemplateCatalogError) return null;
    throw error;
  }
}

function isRecoverableCatalogCorruption(error: unknown) {
  return (
    error instanceof StaticTemplateCatalogError ||
    error instanceof SyntaxError ||
    error instanceof z.ZodError ||
    (error as NodeJS.ErrnoException)?.code === "ENOENT"
  );
}

export async function seedStaticTemplateCatalog(options: SeedOptions = {}) {
  const root = assetRoot(options);
  const existing = await loadVerifiedActiveCatalog(root);
  if (existing?.catalogVersion === STATIC_TEMPLATE_CATALOG_VERSION) {
    return { catalog: existing, reused: true } as const;
  }
  const lock = await acquireSeedLock(root);
  try {
    const rechecked = await loadVerifiedActiveCatalog(root);
    if (rechecked?.catalogVersion === STATIC_TEMPLATE_CATALOG_VERSION) {
      return { catalog: rechecked, reused: true } as const;
    }
    const finalDirectory = finalCatalogDirectory(root);
    if (
      await stat(finalDirectory)
        .then(() => true)
        .catch(() => false)
    ) {
      try {
        return {
          catalog: await activateExistingFinalCatalog(root),
          reused: true,
        } as const;
      } catch (error) {
        if (!isRecoverableCatalogCorruption(error)) throw error;
        throw new StaticTemplateCatalogError(
          "STATIC_TEMPLATE_CATALOG_VERSION_CONFLICT",
        );
      }
    }
    const stagingDirectory = stagingCatalogDirectory(root);
    await mkdir(path.join(stagingDirectory, "sources"), {
      recursive: true,
      mode: 0o700,
    });
    await mkdir(path.join(stagingDirectory, "previews"), {
      recursive: true,
      mode: 0o700,
    });
    await mkdir(path.join(stagingDirectory, "records"), {
      recursive: true,
      mode: 0o700,
    });
    const entries = new Array<StaticTemplateCatalogEntry>(
      STATIC_TEMPLATE_CATALOG_ENTRY_COUNT,
    );
    const sourceArchives = new Map<string, Promise<UpstreamSourceArchive>>();
    let next = 0;
    const concurrency = Math.max(
      1,
      Math.min(options.concurrency ?? SEED_CONCURRENCY, SEED_CONCURRENCY),
    );
    let workerFailed = false;
    let firstWorkerError: unknown;
    const workers = Array.from({ length: concurrency }, async () => {
      while (true) {
        if (workerFailed) return;
        const index = next;
        next += 1;
        if (index >= FROZEN_STATIC_TEMPLATE_CATALOG.length) return;
        try {
          await lock.heartbeat();
          entries[index] = await materializeEntry({
            root,
            stagingDirectory,
            definition: FROZEN_STATIC_TEMPLATE_CATALOG[index]!,
            fetchImpl: options.fetchImpl ?? fetch,
            sourceArchives,
            executionAdmissionBuilder: options.executionAdmissionBuilder,
          });
        } catch (error) {
          if (!workerFailed) {
            workerFailed = true;
            firstWorkerError = error;
          }
          return;
        }
      }
    });
    await Promise.all(workers);
    if (workerFailed) throw firstWorkerError;
    await rm(path.join(stagingDirectory, ".upstream"), {
      recursive: true,
      force: true,
    });
    const catalog = catalogSchema.parse({
      schemaVersion: CATALOG_SCHEMA_VERSION,
      workflowVersion: STATIC_TEMPLATE_CATALOG_WORKFLOW_VERSION,
      catalogVersion: STATIC_TEMPLATE_CATALOG_VERSION,
      pageSize: STATIC_TEMPLATE_CATALOG_PAGE_SIZE,
      pageCount: STATIC_TEMPLATE_CATALOG_PAGE_COUNT,
      entryCount: STATIC_TEMPLATE_CATALOG_ENTRY_COUNT,
      entries,
    });
    assertCatalogCoordinates(catalog);
    const manifest = await writeAtomicJson(
      path.join(stagingDirectory, "manifest.json"),
      catalog,
    );
    await rename(stagingDirectory, finalDirectory);
    const integrity = await writeCatalogIntegrityReceipt({
      root,
      catalog,
      manifestSha256: manifest.sha256,
    });
    await activateCatalog(root, manifest.sha256, integrity.sha256);
    return { catalog, reused: false } as const;
  } finally {
    await lock.release();
  }
}

export async function getStaticTemplateCatalogReadiness(
  options: CatalogOptions = {},
) {
  try {
    const catalog = await loadActiveStaticTemplateCatalog({
      ...options,
      verifyIntegrityStats: true,
    });
    return catalog
      ? (() => {
          const admittedCount = catalog.entries.filter(
            (entry) => entry.executionAdmission.status === "admitted",
          ).length;
          const requiredAdmissionReady =
            catalog.entries.find(
              (entry) =>
                entry.candidateId ===
                "static-template-22-hirael-agency-landing",
            )?.executionAdmission.status === "admitted";
          return {
            ready: true as const,
            expectedCatalogVersion: STATIC_TEMPLATE_CATALOG_VERSION,
            activeCatalogVersion: catalog.catalogVersion,
            workflowVersion: catalog.workflowVersion,
            entryCount: catalog.entryCount,
            pageSize: catalog.pageSize,
            pageCount: catalog.pageCount,
            admittedCount,
            unavailableCount: catalog.entryCount - admittedCount,
            requiredAdmissionReady,
          };
        })()
      : {
          ready: false as const,
          expectedCatalogVersion: STATIC_TEMPLATE_CATALOG_VERSION,
          activeCatalogVersion: null,
          admittedCount: 0,
          unavailableCount: STATIC_TEMPLATE_CATALOG_ENTRY_COUNT,
          requiredAdmissionReady: false,
          code: "STATIC_TEMPLATE_CATALOG_NOT_ACTIVE",
        };
  } catch (error) {
    return {
      ready: false as const,
      expectedCatalogVersion: STATIC_TEMPLATE_CATALOG_VERSION,
      activeCatalogVersion: null,
      admittedCount: 0,
      unavailableCount: STATIC_TEMPLATE_CATALOG_ENTRY_COUNT,
      requiredAdmissionReady: false,
      code:
        error instanceof StaticTemplateCatalogError
          ? error.code
          : "STATIC_TEMPLATE_CATALOG_INVALID",
    };
  }
}
