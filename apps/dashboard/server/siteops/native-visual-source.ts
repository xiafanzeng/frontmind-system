import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { once } from "node:events";
import { tmpdir } from "node:os";
import path from "node:path";

import JSZip from "jszip";
import JSON5 from "json5";
import { chromium, type Page } from "playwright";
import sharp from "sharp";
import { z } from "zod";

import {
  visualCandidateStyleTokensV1Schema,
  visualSelectionBundleV5Schema,
  visualSelectionBundleV6Schema,
  visualSelectionBundleV7Schema,
  type VisualCandidateStyleTokensV1,
  type VisualSelectionBundleV5,
  type VisualSelectionBundleV6,
  type VisualSelectionBundleV7,
} from "../../shared/siteops";
import {
  canonicalJson,
  canonicalSha256,
  providerItemKey,
  type NormalizedTwentyFirstCandidate,
} from "../../shared/siteops-workflow";
import {
  NATIVE_RUNTIME_CONTRACT_FILENAME,
  NATIVE_RUNTIME_CONTRACT_V1_BYTES,
  NATIVE_RUNTIME_EXECUTION_SHELL_FILENAME,
  NATIVE_RUNTIME_EXECUTION_SHELL_V1,
  NATIVE_RUNTIME_EXECUTION_SHELL_V1_BYTES,
  NATIVE_RUNTIME_ROUTE_MODULE,
  NATIVE_SOURCE_ALLOWED_DEPENDENCIES,
  NATIVE_SOURCE_DEFAULT_LIMITS,
  NATIVE_SOURCE_TAILWIND_V3_CONFIG_PATH,
  installedNativeSourceDependencyVersion,
  validateNativeReactSourceArchive,
} from "./native-react-source";
import {
  NativeReactBuildError,
  compileValidatedNativeReactSource,
} from "./native-react-build-runtime";
import {
  fetchPinnedPublicHttps,
  fetchSafeVisualPreview,
} from "./remote-preview";

export const SITEOPS_NATIVE_VISUAL_WORKFLOW_VERSION = "2.5.0" as const;
export const SITEOPS_NATIVE_TEMPLATE_WORKFLOW_VERSION = "2.7.0" as const;
export const SITEOPS_STATIC_TEMPLATE_WORKFLOW_VERSION = "2.8.0" as const;
export const SITEOPS_DYNAMIC_IA_WORKFLOW_VERSION = "2.9.0" as const;

/** Native 2.5 remains readable for immutable replay; every newly admitted
 * complete-Template operation uses 2.7. */
export function isSiteOpsNativeVisualWorkflowVersion(workflowVersion: string) {
  return (
    workflowVersion === SITEOPS_NATIVE_VISUAL_WORKFLOW_VERSION ||
    workflowVersion === SITEOPS_NATIVE_TEMPLATE_WORKFLOW_VERSION ||
    workflowVersion === SITEOPS_STATIC_TEMPLATE_WORKFLOW_VERSION ||
    workflowVersion === SITEOPS_DYNAMIC_IA_WORKFLOW_VERSION
  );
}
export const VISUAL_SELECTION_BUNDLE_V5_MIME_TYPE = "application/zip" as const;
export const VISUAL_SELECTION_BUNDLE_V5_MAX_BYTES = 25 * 1024 * 1024;
export const VISUAL_SELECTION_BUNDLE_V6_MIME_TYPE = "application/zip" as const;
export const VISUAL_SELECTION_BUNDLE_V6_MAX_BYTES = 100 * 1024 * 1024;
export const NATIVE_VISUAL_SOURCE_ARCHIVE_MAX_BYTES = 24 * 1024 * 1024;
export const VISUAL_SELECTION_BUNDLE_V6_SOURCE_ARCHIVE_MAX_BYTES =
  52 * 1024 * 1024;
export const VISUAL_SELECTION_BUNDLE_V7_MIME_TYPE = "application/json" as const;
export const VISUAL_SELECTION_BUNDLE_V7_MAX_BYTES = 512 * 1024;
export const NATIVE_TEMPLATE_PROVIDER_ARCHIVE_MAX_BYTES = 50 * 1024 * 1024;

const NATIVE_SOURCE_DIRECTORY = "source";
const NATIVE_SOURCE_MANIFEST_PATH = "frontmind-native-source-v1.json";
const NATIVE_SOURCE_MANIFEST_ARCHIVE_PATH = `${NATIVE_SOURCE_DIRECTORY}/${NATIVE_SOURCE_MANIFEST_PATH}`;
const V5_SELECTION_MANIFEST_PATH = "visual-selection-v5.json";
const V6_SELECTION_MANIFEST_PATH = "visual-selection-v6.json";
const V6_PROVIDER_SOURCE_MANIFEST_PATH =
  "frontmind-provider-template-source-v1.json";
const V6_PROVIDER_SOURCE_ARCHIVE_PATH = "provider-source.zip";
const MAX_SOURCE_FILES = 512;
const MAX_SOURCE_FILE_BYTES = 8 * 1024 * 1024;
const MAX_SOURCE_TOTAL_BYTES = 48 * 1024 * 1024;
const MAX_DEPENDENCIES = 80;
const MAX_GET_COMPONENT_SOURCE_TEXT_BYTES = 1024 * 1024;
const MAX_STATIC_MEDIA_ASSETS = 64;
const MAX_REMOTE_STYLESHEETS = 8;
const MAX_REMOTE_STYLESHEET_BYTES = 256 * 1024;
const MAX_REMOTE_FONT_BYTES = 3 * 1024 * 1024;
const MAX_REMOTE_STYLE_ASSET_BYTES = 12 * 1024 * 1024;
const MAX_REMOTE_VIDEO_BYTES = 8 * 1024 * 1024;
const MAX_REMOTE_VIDEO_TOTAL_BYTES = 12 * 1024 * 1024;
const MAX_TEMPLATE_ARCHIVE_ENTRIES = 4096;
const MAX_OPAQUE_TEMPLATE_FILE_BYTES = 32 * 1024 * 1024;
const MAX_OPAQUE_TEMPLATE_EXPANDED_BYTES = 192 * 1024 * 1024;
const FIXED_ZIP_DATE = new Date("1980-01-01T00:00:00.000Z");
const CONTROLLED_HTML_ENTRYPOINT = "index.html";
const CONTROLLED_APP_ENTRYPOINT = "src/main.tsx";
const CONTROLLED_TAILWIND_STYLESHEET = "src/frontmind-tailwind.css";
const CONTROLLED_PACKAGE_MANIFEST = "package.json";
const CONTROLLED_SOURCE_PATHS = new Set([
  CONTROLLED_HTML_ENTRYPOINT,
  CONTROLLED_APP_ENTRYPOINT,
  CONTROLLED_TAILWIND_STYLESHEET,
  CONTROLLED_PACKAGE_MANIFEST,
  NATIVE_SOURCE_TAILWIND_V3_CONFIG_PATH,
  NATIVE_SOURCE_MANIFEST_PATH,
]);
const CONTROLLED_COMPILER_DEPENDENCIES = [
  "@tailwindcss/vite",
  "@vitejs/plugin-react",
  "tailwindcss",
  "tw-animate-css",
  "vite",
] as const;

const sourcePathSchema = z
  .string()
  .trim()
  .min(1)
  .max(240)
  .regex(
    /^(?:(?:(?:[a-zA-Z0-9_.-]+|\([a-zA-Z0-9_-]+\)|\[[a-zA-Z0-9_-]+\])\/)*(?:[a-zA-Z0-9_.-]+|\([a-zA-Z0-9_-]+\)|\[[a-zA-Z0-9_-]+\])\.(?:[cm]?[jt]sx?|css|html|json|svg|png|jpe?g|webp|avif|gif|ico|woff2?|eot|otf|ttf|mp3|mp4|ogg|wav|webm)|(?:LICENSE|NOTICE)(?:\.(?:md|txt))?)$/u,
  );

const nativeSourceManifestV1Schema = z
  .object({
    schemaVersion: z.literal(1),
    renderer: z.literal("twenty_first_native_react_v1"),
    providerItemKey: z.string().trim().min(3).max(514),
    providerVersion: z.string().trim().min(1).max(191).nullable(),
    entrypoint: sourcePathSchema,
    demoEntrypoint: sourcePathSchema,
    dependencies: z
      .array(
        z
          .object({
            name: z.string().trim().min(1).max(191),
            installedVersion: z
              .string()
              .regex(/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u),
          })
          .strict(),
      )
      .max(MAX_DEPENDENCIES),
    htmlEntrypoint: z.literal(CONTROLLED_HTML_ENTRYPOINT),
    appEntrypoint: z.literal(CONTROLLED_APP_ENTRYPOINT),
    files: z
      .array(
        z
          .object({
            path: sourcePathSchema,
            sha256: z.string().regex(/^[a-f0-9]{64}$/u),
            bytes: z.number().int().positive().max(MAX_SOURCE_FILE_BYTES),
          })
          .strict(),
      )
      .min(1)
      .max(MAX_SOURCE_FILES),
    sourceTreeSha256: z.string().regex(/^[a-f0-9]{64}$/u),
  })
  .strict();

const providerTemplateSourceManifestV1Schema = z
  .object({
    schemaVersion: z.literal(1),
    sourceFormat: z.literal("provider_archive_v1"),
    providerTemplateId: z.string().trim().min(1).max(191),
    providerSlug: z
      .string()
      .trim()
      .min(1)
      .max(191)
      .regex(/^[a-zA-Z0-9]+(?:[._\/-][a-zA-Z0-9]+)*$/u),
    providerVersion: z.string().trim().min(1).max(191).nullable(),
    sourceSubdirectory: z.string().trim().min(1).max(240).nullable(),
    framework: z.enum(["vite_react", "next_static"]),
    sourceDirectory: z.literal(NATIVE_SOURCE_DIRECTORY),
    entrypoint: sourcePathSchema,
    providerArchiveSha256: z.string().regex(/^[a-f0-9]{64}$/u),
    sourceTreeSha256: z.string().regex(/^[a-f0-9]{64}$/u),
  })
  .strict();

type ProviderTemplateSourceManifestV1 = z.infer<
  typeof providerTemplateSourceManifestV1Schema
>;

export type NativeSourceManifestV1 = z.infer<
  typeof nativeSourceManifestV1Schema
>;

export type NativeSourceFile = {
  path: string;
  bytes: Buffer;
};

export type NativeSourceDependency = {
  name: string;
  installedVersion: string;
};

export type NormalizedTwentyFirstNativeSource = {
  providerItemKey: string;
  providerVersion: string | null;
  entrypoint: string;
  demoEntrypoint: string;
  dependencies: NativeSourceDependency[];
  htmlEntrypoint: typeof CONTROLLED_HTML_ENTRYPOINT;
  appEntrypoint: typeof CONTROLLED_APP_ENTRYPOINT;
  files: NativeSourceFile[];
  sourceTreeSha256: string;
};

export type PreparedNativeVisualCandidate =
  NormalizedTwentyFirstNativeSource & {
    sourceArchive: Buffer;
    sourceArchiveSha256: string;
    preview: Buffer;
    previewSha256: string;
  };

export type NativeTemplateFramework = "vite_react" | "next_static";

export type PreparedNativeTemplateCandidate = PreparedNativeVisualCandidate & {
  templateId: string;
  templateSlug: string;
  framework: NativeTemplateFramework;
  sourceDirectory: typeof NATIVE_SOURCE_DIRECTORY;
  sourceFormat: "normalized_v1" | "provider_archive_v1";
  styleTokens: VisualCandidateStyleTokensV1;
};

export type NativeTemplateStaticAsset = {
  buffer: Buffer;
  mimeType: string;
  finalUrl: string;
};

export type FetchNativeTemplateStaticAsset = (input: {
  url: string;
  kind: "css" | "font";
  signal: AbortSignal;
}) => Promise<NativeTemplateStaticAsset>;

export type FetchNativeTemplateRuntimeMedia = (input: {
  url: string;
  kind: "video";
  signal: AbortSignal;
}) => Promise<NativeTemplateStaticAsset>;

export type FrozenNativeTemplateRuntimeMedia = Readonly<{
  kind: "image" | "video";
  url: string;
  sha256: string;
  bytes: number;
}>;

type PayloadRecord = Record<string, unknown>;

type BoundedZipEntry = JSZip.JSZipObject & {
  unsafeOriginalName?: string;
  _data?: { uncompressedSize?: number };
};

export type NativeVisualFailureCategory =
  | "provider_quota"
  | "get_component_contract"
  | "source_incomplete"
  | "dependency_unsupported"
  | "source_unsafe"
  | "compile_failed"
  | "browser_unavailable"
  | "render_failed"
  | "deadline_exhausted";

export type NativeTemplateRuntimeFailureCategory =
  | "download_failed"
  | "dependency_unsupported"
  | "source_unsafe"
  | "compile_failed"
  | "browser_unavailable"
  | "render_failed"
  | "deadline_exhausted";

export class NativeVisualSourceError extends Error {
  constructor(
    public readonly code: string,
    cause?: unknown,
  ) {
    super(code, cause === undefined ? undefined : { cause });
    this.name = "NativeVisualSourceError";
  }
}

export function assertVisualSelectionBundleV6SourceArchiveSize(
  bytes: Uint8Array,
) {
  if (
    bytes.byteLength < 1 ||
    bytes.byteLength > VISUAL_SELECTION_BUNDLE_V6_SOURCE_ARCHIVE_MAX_BYTES
  ) {
    throw new NativeVisualSourceError("V6_SOURCE_ARCHIVE_SIZE_INVALID");
  }
}

function safeErrorCode(error: unknown) {
  if (!error || typeof error !== "object" || !("code" in error)) return "";
  const code = String(error.code);
  return /^[A-Z0-9_]{1,96}$/u.test(code) ? code : "";
}

/** Reduce implementation errors to the closed, customer-safe provider
 * contract. Messages, source paths and Provider payload values never cross
 * this boundary. */
export function classifyNativeVisualFailure(
  error: unknown,
): NativeVisualFailureCategory {
  const values = new Set<string>();
  let current: unknown = error;
  for (let depth = 0; depth < 5 && current; depth += 1) {
    const code = safeErrorCode(current);
    if (code) values.add(code);
    if (current instanceof Error) values.add(current.message);
    current =
      current && typeof current === "object" && "cause" in current
        ? current.cause
        : null;
  }
  const joined = [...values].join(":");
  if (/(?:ABORT|TIMEOUT|DEADLINE)/u.test(joined)) {
    return "deadline_exhausted";
  }
  if (
    /(?:PROVIDER_QUOTA|QUOTA|RATE_LIMIT|USAGE_EXHAUSTED|CREDITS_EXHAUSTED)/u.test(
      joined,
    )
  ) {
    return "provider_quota";
  }
  if (/(?:SOURCE_CONTRACT|GET_COMPONENT_CONTRACT)/u.test(joined)) {
    return "get_component_contract";
  }
  if (
    /(?:BROWSER_UNAVAILABLE|Executable doesn't exist|browserType\.launch)/u.test(
      joined,
    )
  ) {
    return "browser_unavailable";
  }
  if (/(?:PREVIEW|RENDER|ROUTE_FAILED)/u.test(joined)) {
    return "render_failed";
  }
  if (/(?:COMPILE|BUILD_RUNTIME|BUILD_LOG)/u.test(joined)) {
    return "compile_failed";
  }
  if (/(?:DEPENDENCY|PACKAGE|LIFECYCLE)/u.test(joined)) {
    return "dependency_unsupported";
  }
  if (
    /(?:UNSAFE|FORBIDDEN|SECRET|NETWORK|EXECUTION|TRAVERSAL|SYMLINK|PATH_COLLISION|PATH_INVALID)/u.test(
      joined,
    )
  ) {
    return "source_unsafe";
  }
  return "source_incomplete";
}

export function classifyNativeTemplateRuntimeFailure(
  error: unknown,
): NativeTemplateRuntimeFailureCategory {
  const native = classifyNativeVisualFailure(error);
  if (native === "dependency_unsupported") return "dependency_unsupported";
  if (native === "source_unsafe") return "source_unsafe";
  if (native === "compile_failed") return "compile_failed";
  if (native === "browser_unavailable") return "browser_unavailable";
  if (native === "render_failed") return "render_failed";
  if (native === "deadline_exhausted") return "deadline_exhausted";
  const code = error instanceof Error ? error.message : safeErrorCode(error);
  if (/NATIVE_TEMPLATE_(?:DEPENDENCY|LIFECYCLE)/u.test(code)) {
    return "dependency_unsupported";
  }
  if (
    /(?:NATIVE_SOURCE_STATIC_MEDIA_UNSUPPORTED|VISUAL_SELECTION_BUNDLE_V6_SOURCE_ARCHIVE_SIZE_INVALID)/u.test(
      code,
    )
  ) {
    return "dependency_unsupported";
  }
  if (/NATIVE_TEMPLATE_SOURCE_UNSAFE/u.test(code)) return "source_unsafe";
  return "download_failed";
}

function sha256(bytes: Uint8Array | string) {
  return createHash("sha256").update(bytes).digest("hex");
}

function zipEntryIsSymlink(entry: BoundedZipEntry) {
  const permissions = entry.unixPermissions;
  const mode =
    typeof permissions === "number"
      ? permissions
      : typeof permissions === "string" && /^[0-7]+$/u.test(permissions)
        ? Number.parseInt(permissions, 8)
        : 0;
  return Boolean(mode && (mode & 0o170000) === 0o120000);
}

function cleanVersion(value: unknown) {
  if (typeof value !== "string") return null;
  const normalized = value
    .normalize("NFKC")
    .replace(/[\u0000-\u001f\u007f]/gu, "")
    .trim();
  return normalized && normalized.length <= 191 ? normalized : null;
}

function normalizedSourcePath(value: unknown) {
  if (typeof value !== "string") return null;
  const candidate = value.trim().replaceAll("\\", "/").replace(/^\.\//u, "");
  if (
    candidate.startsWith("/") ||
    candidate.includes("\0") ||
    candidate
      .split("/")
      .some((segment) => segment === "" || segment === "." || segment === "..")
  ) {
    return null;
  }
  const parsed = sourcePathSchema.safeParse(candidate);
  return parsed.success ? parsed.data : null;
}

function collectRecords(
  value: unknown,
  depth = 0,
  records: PayloadRecord[] = [],
) {
  if (depth > 6 || !value || typeof value !== "object") return records;
  if (Array.isArray(value)) {
    value
      .slice(0, 160)
      .forEach((item) => collectRecords(item, depth + 1, records));
    return records;
  }
  const record = value as PayloadRecord;
  records.push(record);
  for (const key of [
    "data",
    "result",
    "payload",
    "component",
    "detail",
    "source",
    "demo",
    "structuredContent",
  ]) {
    collectRecords(record[key], depth + 1, records);
  }
  // Registry dependencies may be returned as nested objects keyed by a
  // registry slug. Traverse only the documented source-bearing containers;
  // arbitrary Provider fields remain opaque.
  for (const key of [
    "registryDependencies",
    "registry_dependencies",
    "supportFiles",
    "support_files",
  ]) {
    const nested = record[key];
    collectRecords(nested, depth + 1, records);
    if (nested && typeof nested === "object" && !Array.isArray(nested)) {
      Object.values(nested as PayloadRecord)
        .slice(0, 160)
        .forEach((item) => collectRecords(item, depth + 1, records));
    }
  }
  return records;
}

function firstString(
  records: readonly PayloadRecord[],
  keys: readonly string[],
) {
  for (const record of records) {
    for (const key of keys) {
      const value = record[key];
      if (typeof value === "string" && value.trim()) return value;
    }
  }
  return null;
}

function parseDependencyName(value: string) {
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > 191 || /[\s\\]/u.test(trimmed)) return null;
  if (trimmed.startsWith("@")) {
    const slash = trimmed.indexOf("/");
    if (slash < 2) return null;
    const versionAt = trimmed.indexOf("@", slash);
    return versionAt > slash ? trimmed.slice(0, versionAt) : trimmed;
  }
  const versionAt = trimmed.indexOf("@");
  return versionAt > 0 ? trimmed.slice(0, versionAt) : trimmed;
}

// Keep candidate admission and the final source-archive validator on one
// pinned dependency allowlist. This includes the common 21st/shadcn packages
// already installed in the controlled compiler image.
const ALLOWED_NATIVE_DEPENDENCIES: ReadonlySet<string> = new Set<string>(
  NATIVE_SOURCE_ALLOWED_DEPENDENCIES,
);

function collectDependencies(
  records: readonly PayloadRecord[],
  providerFiles: ReadonlyMap<string, Buffer>,
) {
  const names = new Set<string>([
    "react",
    "react-dom",
    ...CONTROLLED_COMPILER_DEPENDENCIES,
  ]);
  for (const record of records) {
    for (const key of ["dependencies", "dependency", "npmDependencies"]) {
      const value = record[key];
      const candidates = Array.isArray(value)
        ? value
        : value && typeof value === "object"
          ? Object.keys(value as Record<string, unknown>)
          : typeof value === "string"
            ? value.split(/[\s,]+/u)
            : [];
      for (const candidate of candidates) {
        if (typeof candidate !== "string") continue;
        const name = parseDependencyName(candidate);
        if (name) names.add(name);
      }
    }
  }
  // The official text response carries code and demos but may omit a separate
  // dependency array. Imports are safe to use only as names: every inferred
  // package must still pass the closed allowlist and installed-version pin.
  for (const [filename, bytes] of providerFiles) {
    if (!/\.[cm]?[jt]sx?$/u.test(filename)) continue;
    for (const specifier of sourceImports(bytes.toString("utf8"))) {
      const name = packageNameForImport(specifier);
      if (name) names.add(name);
    }
  }
  const dependencies = [...names].sort();
  if (
    dependencies.length > MAX_DEPENDENCIES ||
    dependencies.some(
      (dependency) => !ALLOWED_NATIVE_DEPENDENCIES.has(dependency),
    )
  ) {
    throw new NativeVisualSourceError("NATIVE_SOURCE_DEPENDENCY_UNSAFE");
  }
  return dependencies.map((name) => ({
    name,
    installedVersion: installedNativeSourceDependencyVersion(name),
  }));
}

function isTextSourcePath(filename: string) {
  return (
    /\.(?:[cm]?[jt]sx?|css|html|json|svg)$/u.test(filename) ||
    /^(?:LICENSE|NOTICE)(?:\.(?:md|txt))?$/u.test(filename)
  );
}

function bytesFromFileValue(value: unknown, filename: string) {
  if (typeof value === "string") return Buffer.from(value, "utf8");
  if (!value || typeof value !== "object") return null;
  const record = value as PayloadRecord;
  for (const key of ["content", "code", "source", "text"]) {
    if (typeof record[key] === "string")
      return Buffer.from(record[key], "utf8");
  }
  if (typeof record.base64 === "string" && !isTextSourcePath(filename)) {
    try {
      return Buffer.from(record.base64, "base64");
    } catch {
      return null;
    }
  }
  return null;
}

function collectProviderFiles(records: readonly PayloadRecord[]) {
  const files = new Map<string, Buffer>();
  for (const record of records) {
    for (const raw of [
      record.files,
      record.sourceFiles,
      record.source_files,
      record.supportFiles,
      record.support_files,
    ]) {
      if (Array.isArray(raw)) {
        for (const item of raw.slice(0, MAX_SOURCE_FILES)) {
          if (!item || typeof item !== "object") continue;
          const row = item as PayloadRecord;
          const filename = normalizedSourcePath(
            row.path ?? row.filename ?? row.name,
          );
          if (!filename)
            throw new NativeVisualSourceError("NATIVE_SOURCE_PATH_UNSAFE");
          const bytes = bytesFromFileValue(row, filename);
          if (!bytes) continue;
          files.set(filename, bytes);
        }
      } else if (raw && typeof raw === "object") {
        for (const [rawPath, value] of Object.entries(
          raw as PayloadRecord,
        ).slice(0, MAX_SOURCE_FILES)) {
          const filename = normalizedSourcePath(rawPath);
          if (!filename)
            throw new NativeVisualSourceError("NATIVE_SOURCE_PATH_UNSAFE");
          const bytes = bytesFromFileValue(value, filename);
          if (bytes) files.set(filename, bytes);
        }
      }
    }
  }
  return files;
}

const OFFICIAL_GET_COMPONENT_CONTRACT =
  "twenty_first_get_component_v1" as const;

function officialGetComponentStatus(records: readonly PayloadRecord[]) {
  const envelope = records.find(
    (record) => record.contractKind === OFFICIAL_GET_COMPONENT_CONTRACT,
  );
  if (!envelope) return null;
  const status =
    envelope.status &&
    typeof envelope.status === "object" &&
    !Array.isArray(envelope.status)
      ? (envelope.status as PayloadRecord)
      : null;
  if (!status) {
    throw new NativeVisualSourceError("NATIVE_SOURCE_CONTRACT_INVALID");
  }
  const reason =
    typeof status.reason === "string"
      ? status.reason.trim().toLocaleLowerCase("en-US")
      : "";
  if (
    status.locked === true ||
    [
      "locked",
      "quota_exceeded",
      "usage_exhausted",
      "credits_exhausted",
      "upgrade_required",
    ].includes(reason)
  ) {
    throw new NativeVisualSourceError("NATIVE_SOURCE_PROVIDER_QUOTA");
  }
  if (
    status.found === false ||
    ["not_found", "missing", "deleted"].includes(reason)
  ) {
    throw new NativeVisualSourceError("NATIVE_SOURCE_FILES_INCOMPLETE");
  }
  if (status.found !== true || status.locked !== false) {
    throw new NativeVisualSourceError("NATIVE_SOURCE_CONTRACT_INVALID");
  }
  if (
    typeof envelope.sourceText !== "string" ||
    Buffer.byteLength(envelope.sourceText, "utf8") >
      MAX_GET_COMPONENT_SOURCE_TEXT_BYTES
  ) {
    throw new NativeVisualSourceError("NATIVE_SOURCE_CONTRACT_INVALID");
  }
  return { envelope, sourceText: envelope.sourceText };
}

/** Validate the metered get_component availability envelope before any local
 * compilation work is queued. Legacy structured payloads intentionally pass
 * through and remain subject to the full normalizer. */
export function assertTwentyFirstNativeSourcePayloadAvailable(
  payload: unknown,
) {
  officialGetComponentStatus(collectRecords(payload));
}

function sourcePathFromFenceContext(value: string) {
  const matches = value.match(
    /(?:^|[\s`"'])([a-zA-Z0-9_.-]+(?:\/[a-zA-Z0-9_.-]+)*\.(?:[cm]?[jt]sx?|css|svg|json))(?:$|[\s`"'])/u,
  );
  return normalizedSourcePath(matches?.[1]);
}

/** Parse only the bounded, documented get_component fenced-code response.
 * It deliberately does not scrape arbitrary prose or treat the whole response
 * as TSX. Explicit file labels win; otherwise the first two React fences are
 * the component and demo, followed by a single optional CSS fence. */
function collectOfficialFencedSource(sourceText: string) {
  const files = new Map<string, Buffer>();
  const reactBlocks: Array<{ context: string; bytes: Buffer }> = [];
  const cssBlocks: Array<{ context: string; bytes: Buffer }> = [];
  const fence = /```([a-zA-Z0-9_-]*)([^\r\n]*)\r?\n([\s\S]*?)\r?\n```/gu;
  let match: RegExpExecArray | null;
  while ((match = fence.exec(sourceText))) {
    const language = match[1]!.toLocaleLowerCase("en-US");
    if (!new Set(["tsx", "jsx", "ts", "js", "css"]).has(language)) {
      continue;
    }
    const body = match[3]!;
    if (!body.trim()) continue;
    const previousLine =
      sourceText
        .slice(Math.max(0, match.index - 240), match.index)
        .split(/\r?\n/u)
        .reverse()
        .find((line) => line.trim()) ?? "";
    const context = `${previousLine}\n${match[2] ?? ""}`;
    const explicitPath = sourcePathFromFenceContext(context);
    const bytes = Buffer.from(body, "utf8");
    if (bytes.length > MAX_SOURCE_FILE_BYTES) {
      throw new NativeVisualSourceError("NATIVE_SOURCE_SIZE_EXCEEDED");
    }
    if (explicitPath) {
      if (files.has(explicitPath)) {
        throw new NativeVisualSourceError("NATIVE_SOURCE_PATH_COLLISION");
      }
      files.set(explicitPath, bytes);
    } else if (language === "css") {
      cssBlocks.push({ context, bytes });
    } else {
      reactBlocks.push({ context, bytes });
    }
  }
  for (const block of reactBlocks) {
    const normalized = block.context.toLocaleLowerCase("en-US");
    const fallback = /\bdemo|preview|example\b/u.test(normalized)
      ? "src/provider/demo.tsx"
      : files.has("src/provider/component.tsx")
        ? "src/provider/demo.tsx"
        : "src/provider/component.tsx";
    if (files.has(fallback)) {
      throw new NativeVisualSourceError("NATIVE_SOURCE_CONTRACT_INVALID");
    }
    files.set(fallback, block.bytes);
  }
  for (const block of cssBlocks) {
    const fallback = "src/provider/globals.css";
    if (files.has(fallback)) {
      throw new NativeVisualSourceError("NATIVE_SOURCE_CONTRACT_INVALID");
    }
    files.set(fallback, block.bytes);
  }
  const fallbackComponent = files.get("src/provider/component.tsx");
  const fallbackDemo = files.get("src/provider/demo.tsx");
  if (fallbackComponent && fallbackDemo) {
    const missingLocalImports = sourceImports(fallbackDemo.toString("utf8"))
      .filter((specifier) => specifier.startsWith("."))
      .flatMap((specifier) =>
        localImportCandidates("src/provider/demo.tsx", specifier),
      )
      .filter((candidate) => !files.has(candidate));
    const inferredComponentPath =
      missingLocalImports.find((candidate) => candidate.endsWith(".tsx")) ??
      missingLocalImports.find((candidate) => candidate.endsWith(".jsx")) ??
      missingLocalImports.find((candidate) => /\.[cm]?[jt]s$/u.test(candidate));
    if (inferredComponentPath) {
      files.delete("src/provider/component.tsx");
      files.set(inferredComponentPath, fallbackComponent);
    }
  }
  if (
    ![...files.keys()].some((filename) => /\.[cm]?[jt]sx?$/u.test(filename))
  ) {
    throw new NativeVisualSourceError("NATIVE_SOURCE_CONTRACT_INVALID");
  }
  return files;
}

function inferCodePath(input: {
  records: readonly PayloadRecord[];
  keys: readonly string[];
  pathKeys: readonly string[];
  fallback: string;
}) {
  const source = firstString(input.records, input.keys);
  if (!source) return null;
  const advertisedPath = normalizedSourcePath(
    firstString(input.records, input.pathKeys),
  );
  return {
    path: advertisedPath ?? input.fallback,
    bytes: Buffer.from(source, "utf8"),
  };
}

function sourceImports(text: string) {
  // Type-only imports disappear before runtime and must not force a package
  // into the controlled browser dependency closure (for example Next.js'
  // `Metadata` type in an otherwise static page).
  const runtimeText = text
    .replace(
      /\bimport\s+type\b[\s\S]{0,4096}?\bfrom\s*["'][^"']+["']\s*;?/gu,
      "",
    )
    .replace(
      /\bexport\s+type\b[\s\S]{0,4096}?\bfrom\s*["'][^"']+["']\s*;?/gu,
      "",
    );
  return [
    ...runtimeText.matchAll(
      /(?:\bfrom\s*|\bimport\s*\(|\brequire\s*\()\s*["']([^"']+)["']/gu,
    ),
    ...runtimeText.matchAll(/\bimport\s*["']([^"']+)["']/gu),
  ].map((match) => match[1]!);
}

function staticRemoteMediaPattern() {
  return /(?:(?:["']?(?:src|poster|image|imageUrl|avatar|logo)["']?)\s*(?:=|:)\s*["'](https:\/\/[^"'\s]+)["']|\burl\(\s*["']?(https:\/\/[^"')\s]+)["']?\s*\))/giu;
}

function staticRemoteMediaUrls(text: string) {
  const urls = new Set<string>();
  for (const match of text.matchAll(staticRemoteMediaPattern())) {
    const value = match[1] ?? match[2];
    if (value) urls.add(value);
  }
  for (const match of text.matchAll(
    /\bconst\s+([A-Z][A-Z0-9_]*)\s*=\s*["'](https:\/\/[^"'\s]+)["']\s*;/gu,
  )) {
    const binding = match[1]!;
    const escaped = binding.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
    if (
      new RegExp(
        `<(?:img|video|source)\\b[^>]{0,2048}\\b(?:src|poster)\\s*=\\s*\\{\\s*${escaped}\\s*\\}`,
        "iu",
      ).test(text)
    ) {
      urls.add(match[2]!);
    }
  }
  return [...urls];
}

function withoutAllowedStaticRemoteMedia(text: string) {
  let safe = text
    .replace(staticRemoteMediaPattern(), (matched, first, second) =>
      matched.replace(String(first ?? second ?? ""), ""),
    )
    .replace(/@import\s+(?:url\(\s*)?["']https:\/\/[^;\r\n]{1,2048};/giu, "");
  for (const url of staticRemoteMediaUrls(text)) {
    safe = safe.replaceAll(url, "");
  }
  return safe;
}

function remoteCssImportPattern() {
  return /@import\s+(?:url\(\s*)?(?:"([^"]+)"|'([^']+)'|([^"'\s;)]+))\s*\)?\s*;/giu;
}

function remoteFontExtension(raw: string) {
  let pathname: string;
  try {
    pathname = new URL(raw).pathname.toLowerCase();
  } catch {
    return null;
  }
  const matched = /\.(woff2?|eot|otf|ttf)$/u.exec(pathname);
  return matched?.[1] ?? null;
}

function remoteRuntimeMediaIsUnsupported(raw: string) {
  try {
    return /\.(?:m3u8|mp3|mp4|ogg|wav|webm)$/u.test(
      new URL(raw).pathname.toLowerCase(),
    );
  } catch {
    return true;
  }
}

function remoteRuntimeVideoExtension(raw: string) {
  try {
    return new URL(raw).pathname.toLowerCase().endsWith(".mp4") ? "mp4" : null;
  } catch {
    return null;
  }
}

const NATIVE_TEMPLATE_OPTIONAL_MEDIA_PLACEHOLDER = Buffer.from(
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 320 240"><rect width="320" height="240" rx="24" fill="#e2e8f0"/><circle cx="160" cy="94" r="42" fill="#94a3b8"/><path d="M72 224c12-55 43-82 88-82s76 27 88 82" fill="#94a3b8"/></svg>',
  "utf8",
);

function optionalStaticMediaMayUsePlaceholder(
  files: readonly NativeSourceFile[],
  url: string,
) {
  try {
    const parsed = new URL(url);
    if (
      parsed.hostname === "i.pravatar.cc" ||
      parsed.hostname === "avatars.githubusercontent.com" ||
      parsed.hostname === "notion-avatars.netlify.app" ||
      (parsed.hostname === "ui.shadcn.com" &&
        parsed.pathname === "/placeholder.svg") ||
      (parsed.hostname === "github.com" && /\.png$/iu.test(parsed.pathname))
    ) {
      return true;
    }
  } catch {
    return false;
  }
  const references = files.filter(
    (file) => isTextSourcePath(file.path) && file.bytes.includes(url),
  );
  if (references.length < 1) return false;
  return references.every((file) => {
    if (/(?:avatar|testimonial|team|partner|sponsor|logo)/iu.test(file.path)) {
      return true;
    }
    const escaped = url.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
    return new RegExp(
      `["']?(?:avatar|logo)["']?\\s*:\\s*(?:assetUrl\\(\\s*)?["']${escaped}["']`,
      "iu",
    ).test(file.bytes.toString("utf8"));
  });
}

async function readBoundedStaticAssetBody(
  response: Response,
  maxBytes: number,
) {
  if (!response.body) {
    throw new NativeVisualSourceError("NATIVE_SOURCE_STATIC_MEDIA_UNAVAILABLE");
  }
  const declaredHeader = response.headers.get("content-length");
  const declared =
    declaredHeader === null ? Number.NaN : Number(declaredHeader);
  if (Number.isFinite(declared) && (declared <= 0 || declared > maxBytes)) {
    throw new NativeVisualSourceError("NATIVE_SOURCE_STATIC_MEDIA_LIMIT");
  }
  const reader = response.body.getReader();
  const chunks: Buffer[] = [];
  let bytes = 0;
  try {
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      bytes += part.value.byteLength;
      if (bytes > maxBytes) {
        throw new NativeVisualSourceError("NATIVE_SOURCE_STATIC_MEDIA_LIMIT");
      }
      chunks.push(Buffer.from(part.value));
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
  if (bytes < 1) {
    throw new NativeVisualSourceError("NATIVE_SOURCE_STATIC_MEDIA_UNAVAILABLE");
  }
  return Buffer.concat(chunks, bytes);
}

async function fetchSafeNativeTemplateStaticAsset(input: {
  url: string;
  kind: "css" | "font";
  signal: AbortSignal;
}): Promise<NativeTemplateStaticAsset> {
  const timeout = AbortSignal.timeout(12_000);
  const signal = AbortSignal.any([input.signal, timeout]);
  const fetched = await fetchPinnedPublicHttps({
    url: input.url,
    signal,
    maxRedirects: 3,
    headers: {
      Accept:
        input.kind === "css"
          ? "text/css"
          : "font/woff2,font/woff,application/font-woff,application/octet-stream",
      "User-Agent": "FrontMind-SiteOps-Template-Asset/1.0",
    },
  });
  if (!fetched.response.ok) {
    await fetched.response.body?.cancel().catch(() => undefined);
    throw new NativeVisualSourceError("NATIVE_SOURCE_STATIC_MEDIA_UNAVAILABLE");
  }
  const mimeType = (fetched.response.headers.get("content-type") ?? "")
    .split(";", 1)[0]!
    .trim()
    .toLowerCase();
  const allowedMime =
    input.kind === "css"
      ? mimeType === "text/css"
      : new Set([
          "application/font-woff",
          "application/octet-stream",
          "font/otf",
          "font/ttf",
          "font/woff",
          "font/woff2",
        ]).has(mimeType);
  if (!allowedMime) {
    await fetched.response.body?.cancel().catch(() => undefined);
    throw new NativeVisualSourceError("NATIVE_SOURCE_STATIC_MEDIA_UNAVAILABLE");
  }
  const buffer = await readBoundedStaticAssetBody(
    fetched.response,
    input.kind === "css" ? MAX_REMOTE_STYLESHEET_BYTES : MAX_REMOTE_FONT_BYTES,
  );
  return {
    buffer,
    mimeType,
    finalUrl: fetched.finalUrl.toString(),
  };
}

async function fetchSafeNativeTemplateRuntimeMedia(input: {
  url: string;
  kind: "video";
  signal: AbortSignal;
}): Promise<NativeTemplateStaticAsset> {
  const timeout = AbortSignal.timeout(30_000);
  const signal = AbortSignal.any([input.signal, timeout]);
  const fetched = await fetchPinnedPublicHttps({
    url: input.url,
    signal,
    maxRedirects: 3,
    headers: {
      Accept: "video/mp4",
      "User-Agent": "FrontMind-SiteOps-Template-Media/1.0",
    },
  });
  if (!fetched.response.ok) {
    await fetched.response.body?.cancel().catch(() => undefined);
    throw new NativeVisualSourceError("NATIVE_SOURCE_STATIC_MEDIA_UNAVAILABLE");
  }
  const mimeType = (fetched.response.headers.get("content-type") ?? "")
    .split(";", 1)[0]!
    .trim()
    .toLowerCase();
  if (mimeType !== "video/mp4") {
    await fetched.response.body?.cancel().catch(() => undefined);
    throw new NativeVisualSourceError("NATIVE_SOURCE_STATIC_MEDIA_UNAVAILABLE");
  }
  const buffer = await readBoundedStaticAssetBody(
    fetched.response,
    MAX_REMOTE_VIDEO_BYTES,
  );
  return {
    buffer,
    mimeType,
    finalUrl: fetched.finalUrl.toString(),
  };
}

function withoutSafeExternalNavigation(text: string) {
  return text.replace(
    /(<(?:a|Link)\b[^>]{0,512}\bhref\s*=\s*["'])https:\/\/[^"'\s>]+(["'])/giu,
    "$1$2",
  );
}

function withoutSafeMarkupNamespaces(text: string) {
  let result = text;
  for (const namespace of [
    "http://www.w3.org/1999/xlink",
    "http://www.w3.org/1998/Math/MathML",
    "http://www.w3.org/1999/xhtml",
    "http://www.w3.org/2000/svg",
    "http://www.w3.org/2000/xmlns/",
    "http://www.w3.org/2001/XMLSchema-instance",
    "http://www.w3.org/XML/1998/namespace",
  ]) {
    result = result.replaceAll(namespace, "");
  }
  return result;
}

function withoutJavaScriptComments(text: string) {
  let output = "";
  let quote: '"' | "'" | "`" | null = null;
  let escaped = false;
  for (let index = 0; index < text.length; index += 1) {
    const current = text[index]!;
    const next = text[index + 1] ?? "";
    if (quote) {
      output += current;
      if (escaped) escaped = false;
      else if (current === "\\") escaped = true;
      else if (current === quote) quote = null;
      continue;
    }
    if (current === '"' || current === "'" || current === "`") {
      quote = current;
      output += current;
      continue;
    }
    if (current === "/" && next === "/") {
      output += "  ";
      index += 2;
      while (index < text.length && !/[\r\n]/u.test(text[index]!)) {
        output += " ";
        index += 1;
      }
      if (index < text.length) output += text[index];
      continue;
    }
    if (current === "/" && next === "*") {
      output += "  ";
      index += 2;
      while (
        index < text.length &&
        !(text[index] === "*" && text[index + 1] === "/")
      ) {
        output += /[\r\n]/u.test(text[index]!) ? text[index] : " ";
        index += 1;
      }
      if (index < text.length) {
        output += "  ";
        index += 1;
      }
      continue;
    }
    output += current;
  }
  return output;
}

function javascriptCodeOnly(text: string) {
  let output = "";
  let quote: '"' | "'" | null = null;
  let escaped = false;
  for (const current of text) {
    if (quote) {
      if (escaped) escaped = false;
      else if (current === "\\") escaped = true;
      else if (current === quote) quote = null;
      output += /[\r\n]/u.test(current) ? current : " ";
      continue;
    }
    if (current === '"' || current === "'") {
      quote = current;
      output += " ";
      continue;
    }
    output += current;
  }
  return output;
}

function packageNameForImport(specifier: string) {
  if (specifier.startsWith("@/")) return null;
  if (specifier.startsWith(".")) return null;
  if (specifier.startsWith("@"))
    return specifier.split("/").slice(0, 2).join("/");
  return specifier.split("/")[0]!;
}

function localImportCandidates(from: string, specifier: string) {
  const roots = specifier.startsWith("@/")
    ? [specifier.slice(2), `src/${specifier.slice(2)}`]
    : [
        path.posix.normalize(
          path.posix.join(path.posix.dirname(from), specifier),
        ),
      ];
  return roots.flatMap((root) => {
    if (/\.[a-zA-Z0-9]+$/u.test(root)) return [root];
    return [
      root,
      ...[
        "ts",
        "tsx",
        "js",
        "jsx",
        "css",
        "json",
        "svg",
        "png",
        "jpg",
        "jpeg",
        "webp",
        "avif",
        "gif",
        "woff",
        "woff2",
      ].map((extension) => `${root}.${extension}`),
      ...["ts", "tsx", "js", "jsx"].map(
        (extension) => `${root}/index.${extension}`,
      ),
    ];
  });
}

function assertLocalSourceImportClosure(
  providerFiles: ReadonlyMap<string, Buffer>,
) {
  const paths = new Set(providerFiles.keys());
  for (const [filename, bytes] of providerFiles) {
    if (!/\.[cm]?[jt]sx?$/u.test(filename)) continue;
    for (const specifier of sourceImports(bytes.toString("utf8"))) {
      if (!specifier.startsWith(".") && !specifier.startsWith("@/")) continue;
      if (
        !localImportCandidates(filename, specifier).some((candidate) =>
          paths.has(candidate),
        )
      ) {
        throw new NativeVisualSourceError(
          specifier.startsWith("@/")
            ? "NATIVE_SOURCE_REGISTRY_DEPENDENCY_UNRESOLVED"
            : "NATIVE_SOURCE_FILES_INCOMPLETE",
        );
      }
    }
  }
}

function assertHardSourceSafety(
  files: readonly NativeSourceFile[],
  dependencies: readonly NativeSourceDependency[],
  options: { allowStaticRemoteMedia?: boolean } = {},
) {
  const declared = new Set(dependencies.map((dependency) => dependency.name));
  const declaredVersions = new Map(
    dependencies.map((dependency) => [
      dependency.name,
      dependency.installedVersion,
    ]),
  );
  for (const file of files) {
    if (!isTextSourcePath(file.path)) continue;
    const text = file.bytes.toString("utf8");
    const withoutControlledShellScript =
      file.path === CONTROLLED_HTML_ENTRYPOINT
        ? text.replace(
            '<script type="module" src="/src/main.tsx"></script>',
            "",
          )
        : text;
    const mediaSafeText = options.allowStaticRemoteMedia
      ? withoutAllowedStaticRemoteMedia(withoutControlledShellScript)
      : withoutControlledShellScript;
    const markupSafeText = withoutSafeMarkupNamespaces(
      withoutSafeExternalNavigation(mediaSafeText),
    );
    const safetyText = /\.[cm]?[jt]sx?$/u.test(file.path)
      ? withoutJavaScriptComments(markupSafeText)
      : markupSafeText;
    const codeSafetyText = /\.[cm]?[jt]sx?$/u.test(file.path)
      ? javascriptCodeOnly(safetyText)
      : safetyText;
    if (Buffer.from(text, "utf8").length !== file.bytes.length) {
      throw new NativeVisualSourceError("NATIVE_SOURCE_TEXT_ENCODING_INVALID");
    }
    if (
      /-----BEGIN (?:EC |OPENSSH |RSA )?PRIVATE KEY-----|\bAKIA[A-Z0-9]{16}\b|\bLTAI[A-Za-z0-9]{12,}\b|\bsk-(?:live|proj)?-?[A-Za-z0-9_-]{20,}\b/u.test(
        safetyText,
      ) ||
      /\b(?:eval|Function)\s*\(|\bnew\s+Function\b|\bimport\s*\(|\brequire\s*\([^"']/u.test(
        codeSafetyText,
      ) ||
      /\b(?:fetch|XMLHttpRequest|WebSocket|EventSource)\s*\(|navigator\.sendBeacon\s*\(/u.test(
        codeSafetyText,
      ) ||
      /dangerouslySetInnerHTML|\b(?:node:)?(?:fs|child_process|worker_threads|vm|net|tls|dgram|cluster)\b/u.test(
        codeSafetyText,
      ) ||
      /<\s*(?:script|iframe|object|embed)\b/iu.test(codeSafetyText) ||
      /(?:javascript|vbscript|data\s*:\s*text\/html)\s*:/iu.test(safetyText) ||
      /https?:\/\//iu.test(safetyText) ||
      /\bprocess\s*\.|\bglobalThis\s*\[|\bdocument\.cookie\b/u.test(
        codeSafetyText,
      )
    ) {
      throw new NativeVisualSourceError("NATIVE_SOURCE_EXECUTION_UNSAFE");
    }
    if (
      file.path.endsWith(".css") &&
      /(?:@import\s+|url\s*\()\s*["']?(?:\.\.\/|\/\/|https?:)/iu.test(
        safetyText,
      )
    ) {
      throw new NativeVisualSourceError("NATIVE_SOURCE_IMPORT_UNSAFE");
    }
    if (path.posix.basename(file.path) === "package.json") {
      let manifest: unknown;
      try {
        manifest = JSON.parse(text);
      } catch {
        throw new NativeVisualSourceError("NATIVE_SOURCE_PACKAGE_INVALID");
      }
      if (
        !manifest ||
        typeof manifest !== "object" ||
        Array.isArray(manifest)
      ) {
        throw new NativeVisualSourceError("NATIVE_SOURCE_PACKAGE_INVALID");
      }
      const record = manifest as Record<string, unknown>;
      if (
        record.scripts !== undefined ||
        record.optionalDependencies !== undefined ||
        record.bundledDependencies !== undefined
      ) {
        throw new NativeVisualSourceError("NATIVE_SOURCE_LIFECYCLE_UNSAFE");
      }
      for (const key of [
        "dependencies",
        "devDependencies",
        "peerDependencies",
      ] as const) {
        const value = record[key];
        if (value === undefined) continue;
        if (!value || typeof value !== "object" || Array.isArray(value)) {
          throw new NativeVisualSourceError("NATIVE_SOURCE_PACKAGE_INVALID");
        }
        for (const [name, version] of Object.entries(
          value as Record<string, unknown>,
        )) {
          if (
            !ALLOWED_NATIVE_DEPENDENCIES.has(name) ||
            typeof version !== "string" ||
            /(?:file|git|github|https?|link|workspace):/iu.test(version) ||
            declaredVersions.get(name) !== version
          ) {
            throw new NativeVisualSourceError(
              "NATIVE_SOURCE_DEPENDENCY_UNSAFE",
            );
          }
        }
      }
      const packagedDependencies = new Set<string>();
      for (const key of ["dependencies", "devDependencies"] as const) {
        const value = record[key];
        if (value && typeof value === "object" && !Array.isArray(value)) {
          Object.keys(value as Record<string, unknown>).forEach((name) =>
            packagedDependencies.add(name),
          );
        }
      }
      if (
        packagedDependencies.size !== declared.size ||
        [...declared].some((name) => !packagedDependencies.has(name))
      ) {
        throw new NativeVisualSourceError("NATIVE_SOURCE_PACKAGE_INVALID");
      }
    }
    // JSON manifests and the inert Tailwind-v3 marker can legitimately contain
    // keys such as `from`; dependency discovery is only meaningful for
    // executable TypeScript/JavaScript modules.
    if (!/\.[cm]?[jt]sx?$/u.test(file.path)) continue;
    for (const specifier of sourceImports(text)) {
      if (specifier.startsWith("@/")) {
        if (specifier.split("/").some((segment) => segment === "..")) {
          throw new NativeVisualSourceError("NATIVE_SOURCE_IMPORT_UNSAFE");
        }
        continue;
      }
      if (specifier.startsWith(".")) {
        if (
          specifier.includes("..") &&
          path.posix
            .normalize(
              path.posix.join(path.posix.dirname(file.path), specifier),
            )
            .startsWith("../")
        ) {
          throw new NativeVisualSourceError("NATIVE_SOURCE_IMPORT_UNSAFE");
        }
        continue;
      }
      const dependency = packageNameForImport(specifier);
      if (
        !dependency ||
        !declared.has(dependency) ||
        !ALLOWED_NATIVE_DEPENDENCIES.has(dependency)
      ) {
        throw new NativeVisualSourceError("NATIVE_SOURCE_DEPENDENCY_UNSAFE");
      }
    }
  }
}

export function nativeSourceTreeSha256(files: readonly NativeSourceFile[]) {
  return canonicalSha256(
    [...files]
      .sort((left, right) => left.path.localeCompare(right.path))
      .map((file) => ({
        path: file.path,
        bytes: file.bytes.length,
        sha256: sha256(file.bytes),
      })),
  );
}

function relativeSourceImport(
  from: string,
  target: string,
  stripCodeExtension = true,
) {
  let value = path.posix.relative(path.posix.dirname(from), target);
  if (!value.startsWith(".")) value = `./${value}`;
  return stripCodeExtension ? value.replace(/\.(?:tsx?|jsx?)$/u, "") : value;
}

function controlledSourceProject(input: {
  providerFiles: readonly NativeSourceFile[];
  demoEntrypoint: string;
  dependencies: readonly NativeSourceDependency[];
  tailwindV3Config?: Record<string, unknown> | null;
}) {
  if (
    input.providerFiles.some((file) => CONTROLLED_SOURCE_PATHS.has(file.path))
  ) {
    throw new NativeVisualSourceError("NATIVE_SOURCE_SHELL_COLLISION");
  }
  const providerFiles = input.providerFiles;
  if (input.tailwindV3Config) {
    const directiveStylesheets = providerFiles.filter(
      (file) =>
        file.path.endsWith(".css") &&
        /@tailwind\s+(?:base|components|utilities)\s*;/iu.test(
          file.bytes.toString("utf8"),
        ),
    );
    if (directiveStylesheets.length !== 1) {
      throw new NativeVisualSourceError(
        "NATIVE_TEMPLATE_DEPENDENCY_UNSUPPORTED",
      );
    }
  }
  const cssImports = providerFiles
    .filter((file) => file.path.endsWith(".css"))
    .map(
      (file) =>
        `import ${JSON.stringify(
          relativeSourceImport(CONTROLLED_APP_ENTRYPOINT, file.path, false),
        )};`,
    );
  const sourceRoots = new Set<string>(["src"]);
  for (const file of providerFiles) {
    if (!/\.(?:[cm]?[jt]sx?|html)$/u.test(file.path)) continue;
    const firstSegment = file.path.split("/")[0]!;
    sourceRoots.add(file.path.includes("/") ? firstSegment : file.path);
  }
  const tailwindSourceLines = ["index.html", ...sourceRoots]
    .sort()
    .map((sourcePath) => `@source "../${sourcePath}";`);
  const packageDependencies = Object.fromEntries(
    input.dependencies.map((dependency) => [
      dependency.name,
      dependency.installedVersion,
    ]),
  );
  const controlledFiles: NativeSourceFile[] = [
    {
      path: CONTROLLED_PACKAGE_MANIFEST,
      bytes: Buffer.from(
        `${canonicalJson({
          name: "frontmind-twenty-first-native-source",
          private: true,
          version: "1.0.0",
          type: "module",
          dependencies: packageDependencies,
        })}\n`,
        "utf8",
      ),
    },
    {
      path: CONTROLLED_HTML_ENTRYPOINT,
      bytes: Buffer.from(
        '<!doctype html><html lang="zh-CN"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>FrontMind visual candidate</title></head><body><div id="root"></div><script type="module" src="/src/main.tsx"></script></body></html>\n',
        "utf8",
      ),
    },
    {
      path: CONTROLLED_APP_ENTRYPOINT,
      bytes: Buffer.from(
        [
          'import React from "react";',
          'import { createRoot } from "react-dom/client";',
          'import "./frontmind-tailwind.css";',
          ...cssImports,
          `import NativePreview from ${JSON.stringify(
            relativeSourceImport(
              CONTROLLED_APP_ENTRYPOINT,
              input.demoEntrypoint,
            ),
          )};`,
          'createRoot(document.getElementById("root")!).render(<React.StrictMode><NativePreview /></React.StrictMode>);',
          "",
        ].join("\n"),
        "utf8",
      ),
    },
    {
      path: CONTROLLED_TAILWIND_STYLESHEET,
      bytes: Buffer.from(
        input.tailwindV3Config
          ? [
              // Tailwind v3 requires its @tailwind directives and @layer
              // blocks to be processed in the same provider global CSS file.
              // The host stylesheet therefore adds only the fixed shell rule.
              "html,body,#root{min-height:100%;margin:0}",
              "",
            ].join("\n")
          : [
              '@import "tailwindcss";',
              ...tailwindSourceLines,
              "html,body,#root{min-height:100%;margin:0}",
              "",
            ].join("\n"),
        "utf8",
      ),
    },
    ...(input.tailwindV3Config
      ? [
          {
            path: NATIVE_SOURCE_TAILWIND_V3_CONFIG_PATH,
            bytes: Buffer.from(
              `${canonicalJson({ schemaVersion: 1, config: input.tailwindV3Config })}\n`,
              "utf8",
            ),
          },
        ]
      : []),
  ];
  return [...providerFiles, ...controlledFiles].sort((left, right) =>
    left.path.localeCompare(right.path),
  );
}

export function normalizeTwentyFirstNativeSource(input: {
  candidate: Pick<
    NormalizedTwentyFirstCandidate,
    "providerItemId" | "providerItemKey"
  >;
  payload: unknown;
  /** Only the preparation pipeline may defer static media checks while it
   * mirrors those URLs through the pinned SSRF-safe image transport. */
  allowStaticRemoteMedia?: boolean;
}): NormalizedTwentyFirstNativeSource {
  const records = collectRecords(input.payload);
  const official = officialGetComponentStatus(records);
  const responseId = firstString(records, ["providerItemKey"]);
  if (responseId && responseId !== input.candidate.providerItemKey) {
    throw new NativeVisualSourceError("NATIVE_SOURCE_PROVIDER_ID_MISMATCH");
  }
  for (const record of records) {
    for (const key of [
      "providerItemId",
      "componentId",
      "component_id",
      "itemId",
      "item_id",
      "id",
      "slug",
    ]) {
      const value = record[key];
      if (
        (typeof value === "string" || typeof value === "number") &&
        providerItemKey(value) !== input.candidate.providerItemKey
      ) {
        continue;
      }
      if (typeof value === "string" || typeof value === "number") {
        // A matching coordinate was found. Nested records may carry unrelated
        // IDs, so only an explicit top-level mismatch is rejected below.
        break;
      }
    }
  }
  const top =
    input.payload &&
    typeof input.payload === "object" &&
    !Array.isArray(input.payload)
      ? (input.payload as PayloadRecord)
      : null;
  const topId = top
    ? (top.providerItemId ??
      top.componentId ??
      top.component_id ??
      top.itemId ??
      top.item_id ??
      top.id ??
      top.slug)
    : null;
  if (
    (typeof topId === "string" || typeof topId === "number") &&
    providerItemKey(topId) !== input.candidate.providerItemKey
  ) {
    throw new NativeVisualSourceError("NATIVE_SOURCE_PROVIDER_ID_MISMATCH");
  }

  const files = official
    ? collectOfficialFencedSource(official.sourceText)
    : collectProviderFiles(records);
  const component = inferCodePath({
    records,
    keys: ["componentCode", "component_code", "sourceCode", "source_code"],
    pathKeys: ["componentPath", "component_path", "entrypoint", "entryPoint"],
    fallback: "src/provider/component.tsx",
  });
  if (component && !files.has(component.path))
    files.set(component.path, component.bytes);
  const demo = inferCodePath({
    records,
    keys: ["demoCode", "demo_code", "previewCode", "preview_code"],
    pathKeys: ["demoPath", "demo_path", "demoEntrypoint", "demo_entrypoint"],
    fallback: "src/provider/demo.tsx",
  });
  if (demo && !files.has(demo.path)) files.set(demo.path, demo.bytes);
  const css = inferCodePath({
    records,
    keys: ["globalsCss", "globalCss", "global_css", "css", "styles"],
    pathKeys: ["cssPath", "stylePath", "stylesheet"],
    fallback: "src/provider/globals.css",
  });
  if (css && !files.has(css.path)) files.set(css.path, css.bytes);

  if (files.size < 1 || files.size > MAX_SOURCE_FILES) {
    throw new NativeVisualSourceError("NATIVE_SOURCE_FILES_INCOMPLETE");
  }
  const providerFiles = [...files]
    .map(([filename, bytes]) => ({ path: filename, bytes: Buffer.from(bytes) }))
    .sort((left, right) => left.path.localeCompare(right.path));
  if (
    new Set(
      providerFiles.map((file) =>
        file.path.normalize("NFKC").toLocaleLowerCase("en-US"),
      ),
    ).size !== providerFiles.length
  ) {
    throw new NativeVisualSourceError("NATIVE_SOURCE_PATH_COLLISION");
  }
  const advertisedEntrypoint = normalizedSourcePath(
    firstString(records, [
      "entrypoint",
      "entryPoint",
      "componentPath",
      "component_path",
    ]),
  );
  const advertisedDemo = normalizedSourcePath(
    firstString(records, [
      "demoEntrypoint",
      "demo_entrypoint",
      "demoPath",
      "demo_path",
    ]),
  );
  const entrypoint =
    advertisedEntrypoint ??
    component?.path ??
    providerFiles.find((file) =>
      /(?:^|\/)component\.[cm]?[jt]sx?$/u.test(file.path),
    )?.path ??
    providerFiles.find(
      (file) =>
        /\.[cm]?[jt]sx?$/u.test(file.path) &&
        !/(?:^|\/)(?:demo|preview|example)\.[cm]?[jt]sx?$/u.test(file.path),
    )?.path ??
    providerFiles.find((file) => /\.[jt]sx$/u.test(file.path))?.path;
  const demoEntrypoint =
    advertisedDemo ??
    demo?.path ??
    providerFiles.find((file) => /(?:^|\/)demo\.[cm]?[jt]sx?$/u.test(file.path))
      ?.path ??
    entrypoint;
  if (
    !entrypoint ||
    !demoEntrypoint ||
    !files.has(entrypoint) ||
    !files.has(demoEntrypoint)
  ) {
    throw new NativeVisualSourceError("NATIVE_SOURCE_ENTRYPOINT_MISSING");
  }
  const dependencies = collectDependencies(records, files);
  assertLocalSourceImportClosure(files);
  const projectFiles = controlledSourceProject({
    providerFiles,
    demoEntrypoint,
    dependencies,
  });
  const totalBytes = projectFiles.reduce(
    (sum, file) => sum + file.bytes.length,
    0,
  );
  if (
    projectFiles.length > MAX_SOURCE_FILES ||
    totalBytes > MAX_SOURCE_TOTAL_BYTES ||
    projectFiles.some(
      (file) =>
        file.bytes.length < 1 || file.bytes.length > MAX_SOURCE_FILE_BYTES,
    )
  ) {
    throw new NativeVisualSourceError("NATIVE_SOURCE_SIZE_EXCEEDED");
  }
  assertHardSourceSafety(projectFiles, dependencies, {
    allowStaticRemoteMedia: input.allowStaticRemoteMedia,
  });
  return {
    providerItemKey: input.candidate.providerItemKey,
    providerVersion: cleanVersion(
      firstString(records, [
        "version",
        "componentVersion",
        "revision",
        "updatedAt",
      ]),
    ),
    entrypoint,
    demoEntrypoint,
    dependencies,
    htmlEntrypoint: CONTROLLED_HTML_ENTRYPOINT,
    appEntrypoint: CONTROLLED_APP_ENTRYPOINT,
    files: projectFiles,
    sourceTreeSha256: nativeSourceTreeSha256(projectFiles),
  };
}

type NativeTemplateZipEntry = BoundedZipEntry;

const TEMPLATE_RUNTIME_FILE_PATTERN =
  /\.(?:[cm]?[jt]sx?|css|html|json|svg|png|jpe?g|webp|avif|gif|ico|woff2?|eot|otf|ttf|mp3|mp4|ogg|wav|webm)$/iu;
const TEMPLATE_ROOT_LICENSE_PATTERN = /^(?:LICENSE|NOTICE)(?:\.(?:md|txt))?$/u;
const TEMPLATE_IGNORED_PATH_PATTERN =
  /(?:^|\/)(?:node_modules|\.git|\.github|\.next|dist|out|build|coverage|\.turbo|\.vercel)(?:\/|$)/u;
const TEMPLATE_IGNORED_BUILD_FILE_PATTERN =
  /(?:^|\/)(?:package-lock\.json|(?:eslint|prettier)(?:\.config)?\.[cm]?[jt]s|tsconfig(?:\.[a-zA-Z0-9_-]+)?\.json)$/u;
const NEXT_STATIC_ENTRYPOINTS = [
  "app/page.tsx",
  "app/page.jsx",
  "src/app/page.tsx",
  "src/app/page.jsx",
  "pages/index.tsx",
  "pages/index.jsx",
  "src/pages/index.tsx",
  "src/pages/index.jsx",
] as const;
const VITE_APP_ENTRYPOINTS = [
  "src/app/landing/page.tsx",
  "src/app/landing/page.jsx",
  "src/pages/index.tsx",
  "src/pages/index.jsx",
  "src/App.tsx",
  "src/App.jsx",
  "src/app.tsx",
  "src/app.jsx",
] as const;
const NEXT_STATIC_MODULE_REWRITES = new Map([
  ["next", "@/frontmind-next/types"],
  ["next/image", "@/frontmind-next/image"],
  ["next/dynamic", "@/frontmind-next/dynamic"],
  ["next/link", "@/frontmind-next/link"],
  ["next/head", "@/frontmind-next/head"],
  ["next/navigation", "@/frontmind-next/navigation"],
  ["next/font/google", "@/frontmind-next/font-google"],
  ["next/font/local", "@/frontmind-next/font-local"],
]);

function cleanTemplateCoordinate(value: unknown, fallback: string) {
  const clean = cleanVersion(String(value ?? ""));
  if (!clean || !/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,190}$/u.test(clean)) {
    throw new NativeVisualSourceError(fallback);
  }
  return clean;
}

function safeTemplateArchivePath(value: string) {
  const normalized = value
    .normalize("NFKC")
    .replaceAll("\\", "/")
    .replace(/^\.\//u, "")
    .replace(/\/$/u, "");
  if (
    !normalized ||
    normalized.startsWith("/") ||
    normalized.includes("\0") ||
    Buffer.byteLength(normalized, "utf8") > 240 ||
    normalized
      .split("/")
      .some((segment) => !segment || segment === "." || segment === "..")
  ) {
    return null;
  }
  return normalized;
}

function packageManifestFromTemplateFiles(files: ReadonlyMap<string, Buffer>) {
  const bytes = files.get(CONTROLLED_PACKAGE_MANIFEST);
  if (!bytes) {
    throw new NativeVisualSourceError("NATIVE_TEMPLATE_ARCHIVE_INVALID");
  }
  try {
    const value = JSON.parse(bytes.toString("utf8")) as unknown;
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new Error("manifest");
    }
    return value as PayloadRecord;
  } catch (error) {
    throw new NativeVisualSourceError("NATIVE_TEMPLATE_ARCHIVE_INVALID", error);
  }
}

function assertTemplatePackageIsInert(manifest: PayloadRecord) {
  const scripts = manifest.scripts;
  if (scripts !== undefined) {
    if (!scripts || typeof scripts !== "object" || Array.isArray(scripts)) {
      throw new NativeVisualSourceError("NATIVE_TEMPLATE_SOURCE_UNSAFE");
    }
    for (const [name, command] of Object.entries(scripts as PayloadRecord)) {
      if (
        !/^[a-zA-Z0-9:_-]{1,96}$/u.test(name) ||
        typeof command !== "string" ||
        Buffer.byteLength(command, "utf8") > 4096
      ) {
        throw new NativeVisualSourceError("NATIVE_TEMPLATE_SOURCE_UNSAFE");
      }
    }
  }
  if (
    manifest.optionalDependencies !== undefined ||
    manifest.bundledDependencies !== undefined ||
    manifest.bundleDependencies !== undefined
  ) {
    throw new NativeVisualSourceError("NATIVE_TEMPLATE_DEPENDENCY_UNSUPPORTED");
  }
  for (const key of ["dependencies", "devDependencies", "peerDependencies"]) {
    const value = manifest[key];
    if (value === undefined) continue;
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new NativeVisualSourceError("NATIVE_TEMPLATE_ARCHIVE_INVALID");
    }
    for (const [name, version] of Object.entries(value as PayloadRecord)) {
      if (
        !/^(?:@[a-z0-9._-]+\/)?[a-z0-9._-]+$/u.test(name) ||
        typeof version !== "string" ||
        /(?:file|git|github|https?|link|workspace|portal|patch):/iu.test(
          version,
        )
      ) {
        throw new NativeVisualSourceError(
          "NATIVE_TEMPLATE_DEPENDENCY_UNSUPPORTED",
        );
      }
    }
  }
}

function templateManifestHasReact(manifest: PayloadRecord) {
  const names = new Set<string>();
  for (const key of ["dependencies", "devDependencies", "peerDependencies"]) {
    const value = manifest[key];
    if (!value || typeof value !== "object" || Array.isArray(value)) continue;
    Object.keys(value as PayloadRecord).forEach((name) => names.add(name));
  }
  return names.has("react") && names.has("react-dom");
}

const STATIC_TAILWIND_V3_TOP_LEVEL_KEYS = new Set([
  "content",
  "corePlugins",
  "darkMode",
  "important",
  "plugins",
  "prefix",
  "safelist",
  "separator",
  "theme",
]);
const TAILWIND_ANIMATE_PLUGIN_SENTINEL =
  "__frontmind_tailwindcss_animate__" as const;

function boundedStaticConfigurationValue(
  value: unknown,
  state: { nodes: number },
  depth = 0,
): unknown {
  state.nodes += 1;
  if (state.nodes > 5_000 || depth > 16) {
    throw new NativeVisualSourceError("NATIVE_TEMPLATE_DEPENDENCY_UNSUPPORTED");
  }
  if (
    value === null ||
    typeof value === "boolean" ||
    (typeof value === "number" && Number.isFinite(value))
  ) {
    return value;
  }
  if (typeof value === "string") {
    if (Buffer.byteLength(value, "utf8") > 16_384) {
      throw new NativeVisualSourceError(
        "NATIVE_TEMPLATE_DEPENDENCY_UNSUPPORTED",
      );
    }
    return value;
  }
  if (Array.isArray(value)) {
    if (value.length > 1_000) {
      throw new NativeVisualSourceError(
        "NATIVE_TEMPLATE_DEPENDENCY_UNSUPPORTED",
      );
    }
    return value.map((item) =>
      boundedStaticConfigurationValue(item, state, depth + 1),
    );
  }
  if (!value || typeof value !== "object") {
    throw new NativeVisualSourceError("NATIVE_TEMPLATE_DEPENDENCY_UNSUPPORTED");
  }
  const result: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    if (
      !/^[^\u0000-\u001f\u007f]{1,191}$/u.test(key) ||
      ["__proto__", "constructor", "prototype"].includes(key)
    ) {
      throw new NativeVisualSourceError(
        "NATIVE_TEMPLATE_DEPENDENCY_UNSUPPORTED",
      );
    }
    result[key] = boundedStaticConfigurationValue(item, state, depth + 1);
  }
  return result;
}

function staticTailwindV3Config(files: ReadonlyMap<string, Buffer>) {
  const usesV3Directives = [...files]
    .filter(([filename]) => filename.endsWith(".css"))
    .some(([, bytes]) =>
      /@tailwind\s+(?:base|components|utilities)\s*;/iu.test(
        bytes.toString("utf8"),
      ),
    );
  if (!usesV3Directives) return null;
  const configPath = [
    "tailwind.config.js",
    "tailwind.config.cjs",
    "tailwind.config.mjs",
    "tailwind.config.ts",
  ].find((candidate) => files.has(candidate));
  if (!configPath) return {};
  const bytes = files.get(configPath)!;
  if (bytes.length > 128 * 1024) {
    throw new NativeVisualSourceError("NATIVE_TEMPLATE_DEPENDENCY_UNSUPPORTED");
  }
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes).trim();
  } catch (error) {
    throw new NativeVisualSourceError(
      "NATIVE_TEMPLATE_DEPENDENCY_UNSUPPORTED",
      error,
    );
  }
  text = text.replace(/^\uFEFF/u, "");
  text = text.replace(/^\s*import\s+type\s+[^;\r\n]+;?\s*/gmu, "");
  const animateAlias =
    /^\s*const\s+([A-Za-z_$][\w$]*)\s*=\s*require\(\s*["']tailwindcss-animate["']\s*\)\s*;?\s*/u.exec(
      text,
    );
  if (animateAlias) {
    const alias = animateAlias[1]!;
    text = text.slice(animateAlias[0].length);
    const pluginsPattern = new RegExp(
      `(plugins\\s*:\\s*\\[\\s*)${alias}(\\s*,?\\s*\\])`,
      "u",
    );
    if (!pluginsPattern.test(text)) {
      throw new NativeVisualSourceError(
        "NATIVE_TEMPLATE_DEPENDENCY_UNSUPPORTED",
      );
    }
    text = text.replace(
      pluginsPattern,
      `$1${JSON.stringify(TAILWIND_ANIMATE_PLUGIN_SENTINEL)}$2`,
    );
    if (new RegExp(`\\b${alias}\\b`, "u").test(text)) {
      throw new NativeVisualSourceError(
        "NATIVE_TEMPLATE_DEPENDENCY_UNSUPPORTED",
      );
    }
  }
  text = text.replace(
    /require\(\s*["']tailwindcss-animate["']\s*\)/gu,
    JSON.stringify(TAILWIND_ANIMATE_PLUGIN_SENTINEL),
  );
  // Strip documentation-only comments before locating the single exported
  // object. JSON5 then performs the actual non-executing parse; executable
  // expressions (functions, imports, spread, templates, `new`, remaining
  // requires) are not JSON5 values and are rejected without evaluation.
  text = text.replace(
    /^(?:\s*\/\*[\s\S]*?\*\/\s*|\s*\/\/[^\r\n]*(?:\r?\n|$))+/u,
    "",
  );
  if (/^\s*module\.exports\s*=/u.test(text)) {
    text = text.replace(/^\s*module\.exports\s*=\s*/u, "");
  } else if (/^\s*export\s+default\s+/u.test(text)) {
    text = text.replace(/^\s*export\s+default\s+/u, "");
  } else {
    throw new NativeVisualSourceError("NATIVE_TEMPLATE_DEPENDENCY_UNSUPPORTED");
  }
  text = text.replace(/\s+satisfies\s+[A-Za-z_$][\w$]*\s*;?\s*$/u, "");
  text = text.replace(/;\s*$/u, "");
  let parsed: unknown;
  try {
    parsed = JSON5.parse(text);
  } catch (error) {
    throw new NativeVisualSourceError(
      "NATIVE_TEMPLATE_DEPENDENCY_UNSUPPORTED",
      error,
    );
  }
  const bounded = boundedStaticConfigurationValue(parsed, { nodes: 0 });
  if (!bounded || typeof bounded !== "object" || Array.isArray(bounded)) {
    throw new NativeVisualSourceError("NATIVE_TEMPLATE_DEPENDENCY_UNSUPPORTED");
  }
  const record = bounded as Record<string, unknown>;
  if (
    Object.keys(record).some(
      (key) => !STATIC_TAILWIND_V3_TOP_LEVEL_KEYS.has(key),
    )
  ) {
    throw new NativeVisualSourceError("NATIVE_TEMPLATE_DEPENDENCY_UNSUPPORTED");
  }
  if (
    record.plugins !== undefined &&
    (!Array.isArray(record.plugins) ||
      record.plugins.some(
        (plugin) => plugin !== TAILWIND_ANIMATE_PLUGIN_SENTINEL,
      ))
  ) {
    throw new NativeVisualSourceError("NATIVE_TEMPLATE_DEPENDENCY_UNSUPPORTED");
  }
  delete record.content;
  return record;
}

function normalizedTemplateRootHint(value: string | null | undefined) {
  if (value === null || value === undefined || value === "") return null;
  const normalized = safeTemplateArchivePath(value);
  if (
    !normalized ||
    normalized !== value.replaceAll("\\", "/").replace(/^\.\//u, "") ||
    normalized.split("/").some((segment) => segment === "." || segment === "..")
  ) {
    throw new NativeVisualSourceError("NATIVE_TEMPLATE_SOURCE_UNSAFE");
  }
  return normalized;
}

async function extractNativeTemplateFiles(
  archive: Buffer,
  sourceSubdirectory?: string | null,
  templateSlug?: string,
) {
  if (
    archive.length < 1 ||
    archive.length > NATIVE_TEMPLATE_PROVIDER_ARCHIVE_MAX_BYTES
  ) {
    throw new NativeVisualSourceError("NATIVE_TEMPLATE_ARCHIVE_INVALID");
  }
  let zip: JSZip;
  try {
    zip = await JSZip.loadAsync(archive, {
      checkCRC32: true,
      createFolders: false,
    });
  } catch (error) {
    throw new NativeVisualSourceError("NATIVE_TEMPLATE_ARCHIVE_INVALID", error);
  }
  const entries = Object.values(zip.files) as NativeTemplateZipEntry[];
  if (entries.length > MAX_TEMPLATE_ARCHIVE_ENTRIES) {
    throw new NativeVisualSourceError("NATIVE_TEMPLATE_ARCHIVE_INVALID");
  }
  const safeEntries: Array<{ entry: NativeTemplateZipEntry; path: string }> =
    [];
  for (const entry of entries) {
    const rawPath = entry.unsafeOriginalName ?? entry.name;
    const safePath = safeTemplateArchivePath(rawPath);
    if (!safePath || rawPath !== entry.name || zipEntryIsSymlink(entry)) {
      throw new NativeVisualSourceError("NATIVE_TEMPLATE_SOURCE_UNSAFE");
    }
    if (!entry.dir) safeEntries.push({ entry, path: safePath });
  }
  const rootHint = normalizedTemplateRootHint(sourceSubdirectory);
  const allPackagePaths = safeEntries
    .map(({ path: filename }) => filename)
    .filter(
      (filename) =>
        (filename === "package.json" || filename.endsWith("/package.json")) &&
        !TEMPLATE_IGNORED_PATH_PATTERN.test(filename),
    )
    .sort((left, right) => {
      const depth = left.split("/").length - right.split("/").length;
      return depth || left.localeCompare(right);
    });
  const hintedSuffix = rootHint ? `/${rootHint}/package.json` : null;
  const packagePaths = hintedSuffix
    ? (() => {
        const nestedPackagePaths = allPackagePaths.filter(
          (filename) =>
            filename === `${rootHint}/package.json` ||
            filename.endsWith(hintedSuffix),
        );
        if (nestedPackagePaths.length > 0) return nestedPackagePaths;
        // Registry templates commonly share one repository-root package.json
        // while the selected visual root lives below
        // registry/<registry>/templates/<template>. The catalog projection
        // intentionally retains that root manifest plus only the selected
        // registry subtree. Bind the hint to the unique package root that
        // actually contains it; never fall back to an unrelated workspace.
        return allPackagePaths.filter((packagePath) => {
          const rootPrefix = packagePath.slice(0, -"package.json".length);
          const selectedPrefix = `${rootPrefix}${rootHint}/`;
          return safeEntries.some(({ path: filename }) =>
            filename.startsWith(selectedPrefix),
          );
        });
      })()
    : allPackagePaths;
  if (rootHint && packagePaths.length !== 1) {
    throw new NativeVisualSourceError("NATIVE_TEMPLATE_SOURCE_UNSAFE");
  }
  if (packagePaths.length === 0) {
    throw new NativeVisualSourceError("NATIVE_TEMPLATE_ARCHIVE_INVALID");
  }
  const failures: NativeVisualSourceError[] = [];
  const buildableRoots: Array<{
    files: Map<string, Buffer>;
    frameworkRank: number;
    depth: number;
    packagePath: string;
  }> = [];
  for (const packagePath of packagePaths) {
    const rootPrefix = packagePath.slice(0, -"package.json".length);
    const nestedRootPrefixes = packagePaths
      .filter(
        (candidate) =>
          candidate !== packagePath &&
          candidate.startsWith(rootPrefix) &&
          candidate.length > packagePath.length,
      )
      .map((candidate) => candidate.slice(0, -"package.json".length));
    try {
      const files = new Map<string, Buffer>();
      let expandedBytes = 0;
      for (const { entry, path: archivePath } of safeEntries) {
        if (
          !archivePath.startsWith(rootPrefix) ||
          nestedRootPrefixes.some((prefix) => archivePath.startsWith(prefix))
        ) {
          continue;
        }
        const filename = archivePath.slice(rootPrefix.length);
        if (
          !filename ||
          TEMPLATE_IGNORED_PATH_PATTERN.test(filename) ||
          TEMPLATE_IGNORED_BUILD_FILE_PATTERN.test(filename) ||
          (!TEMPLATE_RUNTIME_FILE_PATTERN.test(filename) &&
            !TEMPLATE_ROOT_LICENSE_PATTERN.test(filename) &&
            filename !== CONTROLLED_PACKAGE_MANIFEST)
        ) {
          continue;
        }
        const normalized = normalizedSourcePath(filename);
        if (!normalized) {
          throw new NativeVisualSourceError("NATIVE_TEMPLATE_SOURCE_UNSAFE");
        }
        const declared = Number(entry._data?.uncompressedSize ?? 0);
        if (
          Number.isFinite(declared) &&
          declared > NATIVE_SOURCE_DEFAULT_LIMITS.maxSingleFileBytes
        ) {
          throw new NativeVisualSourceError("NATIVE_TEMPLATE_ARCHIVE_INVALID");
        }
        const bytes = await entry.async("nodebuffer");
        expandedBytes += bytes.length;
        if (
          bytes.length > NATIVE_SOURCE_DEFAULT_LIMITS.maxSingleFileBytes ||
          expandedBytes > NATIVE_SOURCE_DEFAULT_LIMITS.maxExpandedBytes
        ) {
          throw new NativeVisualSourceError("NATIVE_TEMPLATE_ARCHIVE_INVALID");
        }
        const collisionKey = normalized
          .normalize("NFKC")
          .toLocaleLowerCase("en-US");
        if (
          [...files.keys()].some(
            (existing) =>
              existing.normalize("NFKC").toLocaleLowerCase("en-US") ===
              collisionKey,
          )
        ) {
          throw new NativeVisualSourceError("NATIVE_TEMPLATE_SOURCE_UNSAFE");
        }
        files.set(normalized, Buffer.from(bytes));
      }
      if (
        files.size < 2 ||
        files.size > NATIVE_SOURCE_DEFAULT_LIMITS.maxFiles
      ) {
        continue;
      }
      const packageManifest = packageManifestFromTemplateFiles(files);
      assertTemplatePackageIsInert(packageManifest);
      if (!templateManifestHasReact(packageManifest)) continue;
      const hasViteRoot =
        files.has("index.html") && Boolean(findViteEntrypoint(files));
      const hasRegistryRoot = Boolean(
        templateSlug && findRegistryTemplateEntrypoint(files, templateSlug),
      );
      const hasNextRoot =
        hasRegistryRoot || Boolean(findNextStaticEntrypoint(files));
      if (!hasViteRoot && !hasNextRoot) continue;
      buildableRoots.push({
        files,
        frameworkRank: hasViteRoot ? 0 : 1,
        depth: packagePath.split("/").length,
        packagePath,
      });
    } catch (error) {
      if (error instanceof NativeVisualSourceError) {
        failures.push(error);
        continue;
      }
      throw error;
    }
  }
  buildableRoots.sort(
    (left, right) =>
      left.frameworkRank - right.frameworkRank ||
      left.depth - right.depth ||
      left.packagePath.localeCompare(right.packagePath),
  );
  const selected = buildableRoots[0];
  if (selected) return selected.files;
  throw (
    failures[0] ??
    new NativeVisualSourceError("NATIVE_TEMPLATE_ARCHIVE_INVALID")
  );
}

/**
 * Some verified Marketplace entries are individual templates inside a
 * registry repository rather than the repository homepage. 21st exposes the
 * immutable repository coordinate and a slug, while the repository itself is
 * the authoritative manifest for the template path. Resolve only the exact,
 * unique content-defined convention
 * `registry/<registry>/templates/<name>/<name>.tsx`; never guess an arbitrary
 * file from the slug.
 */
function findRegistryTemplateEntrypoint(
  files: ReadonlyMap<string, Buffer>,
  templateSlug: string,
) {
  const matches = [...files.keys()].filter((filename) => {
    const matched =
      /^registry\/([a-z0-9._-]+)\/templates\/([a-z0-9._-]+)\/\2\.(?:tsx|jsx)$/iu.exec(
        filename,
      );
    if (!matched) return false;
    const registry = matched[1]!.toLocaleLowerCase("en-US");
    const template = matched[2]!.toLocaleLowerCase("en-US");
    const slug = templateSlug.toLocaleLowerCase("en-US");
    return slug === template || slug === `${registry}-${template}`;
  });
  return matches.length === 1 ? matches[0]! : null;
}

function findViteEntrypoint(files: ReadonlyMap<string, Buffer>) {
  for (const candidate of VITE_APP_ENTRYPOINTS) {
    if (files.has(candidate)) return candidate;
  }
  for (const main of [
    "src/main.tsx",
    "src/main.jsx",
    "src/main.ts",
    "src/main.js",
  ]) {
    const source = files.get(main)?.toString("utf8");
    if (!source) continue;
    for (const match of source.matchAll(
      /\bimport\s+[A-Za-z_$][\w$]*\s+from\s+["']([^"']+)["']/gu,
    )) {
      const specifier = match[1]!;
      if (!specifier.startsWith(".")) continue;
      const resolved = localImportCandidates(main, specifier).find((value) =>
        files.has(value),
      );
      if (
        resolved &&
        /(?:^|\/)(?:app|home|page)\.[cm]?[jt]sx?$/iu.test(resolved)
      ) {
        return resolved;
      }
    }
  }
  return null;
}

function findNextStaticEntrypoint(files: ReadonlyMap<string, Buffer>) {
  for (const candidate of NEXT_STATIC_ENTRYPOINTS) {
    if (files.has(candidate)) return candidate;
  }
  const groupedPages = [...files.keys()].filter((filename) => {
    const matched = /^(src\/)?app\/(.+)\/page\.(?:tsx|jsx)$/u.exec(filename);
    if (!matched) return false;
    const segments = matched[2]!.split("/");
    return (
      segments.length > 0 &&
      segments.every((segment) => /^\([a-zA-Z0-9_-]+\)$/u.test(segment))
    );
  });
  groupedPages.sort((left, right) => {
    const depth = left.split("/").length - right.split("/").length;
    return depth || left.localeCompare(right);
  });
  return groupedPages[0] ?? null;
}

function nextStaticLayoutEntrypoints(
  files: ReadonlyMap<string, Buffer>,
  pageEntrypoint: string,
) {
  const pageDirectory = path.posix.dirname(pageEntrypoint);
  const appRoot = pageEntrypoint.startsWith("src/app/") ? "src/app" : "app";
  const relative = path.posix.relative(appRoot, pageDirectory);
  const segments = relative === "." ? [] : relative.split("/");
  const directories = [appRoot];
  let current = appRoot;
  for (const segment of segments) {
    current = path.posix.join(current, segment);
    directories.push(current);
  }
  return directories.flatMap((directory) => {
    for (const extension of ["tsx", "jsx"] as const) {
      const candidate = `${directory}/layout.${extension}`;
      if (files.has(candidate)) return [candidate];
    }
    return [];
  });
}

function localStylesheetReferences(from: string, text: string) {
  const values: string[] = [];
  for (const match of text.matchAll(
    /@import\s+(?:url\(\s*)?(?:"([^"]+)"|'([^']+)'|([^"'\s;)]+))/giu,
  )) {
    const value = match[1] ?? match[2] ?? match[3];
    if (value?.startsWith(".")) values.push(value);
  }
  for (const match of text.matchAll(
    /url\(\s*(?:"([^"]+)"|'([^']+)'|([^"')\s]+))\s*\)/giu,
  )) {
    const value = match[1] ?? match[2] ?? match[3];
    if (value?.startsWith(".")) values.push(value);
  }
  return values.flatMap((value) => localImportCandidates(from, value));
}

function nextStaticRuntimeClosure(
  files: ReadonlyMap<string, Buffer>,
  roots: readonly string[],
) {
  const selected = new Set<string>();
  const queue = [...roots];
  while (queue.length > 0) {
    const filename = queue.shift()!;
    if (selected.has(filename) || !files.has(filename)) continue;
    selected.add(filename);
    const bytes = files.get(filename)!;
    const references = /\.[cm]?[jt]sx?$/u.test(filename)
      ? sourceImports(bytes.toString("utf8")).flatMap((specifier) =>
          specifier.startsWith(".") || specifier.startsWith("@/")
            ? localImportCandidates(filename, specifier)
            : [],
        )
      : filename.endsWith(".css")
        ? localStylesheetReferences(filename, bytes.toString("utf8"))
        : [];
    for (const candidate of references) {
      if (files.has(candidate) && !selected.has(candidate))
        queue.push(candidate);
    }
  }
  const retained = new Map<string, Buffer>();
  for (const [filename, bytes] of files) {
    if (
      selected.has(filename) ||
      filename === CONTROLLED_PACKAGE_MANIFEST ||
      filename === "index.html" ||
      TEMPLATE_ROOT_LICENSE_PATTERN.test(filename) ||
      filename.startsWith("public/") ||
      /^(?:tailwind|postcss)\.config\.[cm]?[jt]s$/u.test(filename)
    ) {
      retained.set(filename, Buffer.from(bytes));
    }
  }
  return retained;
}

function nextFontNames(files: ReadonlyMap<string, Buffer>) {
  const names = new Set<string>();
  for (const [filename, bytes] of files) {
    if (!/\.[cm]?[jt]sx?$/u.test(filename)) continue;
    for (const match of bytes
      .toString("utf8")
      .matchAll(
        /\bimport\s*\{([^}]+)\}\s*from\s*["']next\/font\/google["']/gu,
      )) {
      for (const raw of match[1]!.split(",")) {
        const imported = raw.trim().split(/\s+as\s+/u, 1)[0];
        if (imported && /^[A-Za-z_$][\w$]*$/u.test(imported))
          names.add(imported);
      }
    }
  }
  return [...names].sort();
}

function rewriteNextStaticImports(files: ReadonlyMap<string, Buffer>) {
  const rewritten = new Map<string, Buffer>();
  for (const [filename, bytes] of files) {
    if (!/\.[cm]?[jt]sx?$/u.test(filename)) {
      rewritten.set(filename, Buffer.from(bytes));
      continue;
    }
    let text = bytes.toString("utf8");
    const importsShadersReact = sourceImports(text).includes("shaders/react");
    // A statically named local export wrapped by next/dynamic({ ssr:false })
    // has no runtime variability. Convert that exact form to an eager ESM
    // import so the controlled Vite build never executes dynamic import while
    // retaining the same component and complete local dependency closure.
    text = text.replace(
      /\b(?:const|let)\s+([A-Za-z_$][\w$]*)\s*=\s*dynamic\(\s*\(\s*\)\s*=>\s*import\(\s*(["'])([^"']+)\2\s*\)\.then\(\s*\(\s*([A-Za-z_$][\w$]*)\s*\)\s*=>\s*\4\.([A-Za-z_$][\w$]*)\s*\)\s*,\s*\{\s*ssr\s*:\s*false\s*,?\s*\}\s*,?\s*\)\s*;?/gu,
      (
        _matched,
        localName: string,
        _quote: string,
        specifier: string,
        _moduleName: string,
        exportName: string,
      ) => {
        return localName === exportName
          ? `import { ${exportName} } from ${JSON.stringify(specifier)};`
          : `import { ${exportName} as ${localName} } from ${JSON.stringify(specifier)};`;
      },
    );
    if (!/\bdynamic\s*\(/u.test(text)) {
      text = text.replace(
        /\bimport\s+dynamic\s+from\s*["']next\/dynamic["']\s*;?\s*/gu,
        "",
      );
    }
    const nextImports = sourceImports(text).filter((value) =>
      value.startsWith("next/"),
    );
    if (nextImports.some((value) => !NEXT_STATIC_MODULE_REWRITES.has(value))) {
      throw new NativeVisualSourceError(
        "NATIVE_TEMPLATE_DEPENDENCY_UNSUPPORTED",
      );
    }
    for (const [source, replacement] of NEXT_STATIC_MODULE_REWRITES) {
      text = text.replaceAll(`"${source}"`, `"${replacement}"`);
      text = text.replaceAll(`'${source}'`, `'${replacement}'`);
    }
    text = text
      .replaceAll('"@devnomic/marquee"', '"@/frontmind-next/marquee"')
      .replaceAll("'@devnomic/marquee'", "'@/frontmind-next/marquee'")
      .replaceAll(
        '"@devnomic/marquee/dist/index.css"',
        '"@/frontmind-next/marquee.css"',
      )
      .replaceAll(
        "'@devnomic/marquee/dist/index.css'",
        "'@/frontmind-next/marquee.css'",
      )
      // `shaders/react` is a barrel over the package's complete component
      // graph. Its supported bundled export has the same public React API and
      // visual implementation, while keeping the controlled 512 MB compiler
      // from loading hundreds of unrelated shader modules during tree-shake.
      .replaceAll('"shaders/react"', '"shaders/react/bundle"')
      .replaceAll("'shaders/react'", "'shaders/react/bundle'");
    if (importsShadersReact) {
      // Catalog execution is always offline. Keep the exact shader component
      // stack while explicitly disabling the package's opt-out telemetry.
      text = text.replace(
        /<Shader(?![^>]*\bdisableTelemetry\s*=)(?=\s|>)/gu,
        "<Shader disableTelemetry={true}",
      );
    }
    rewritten.set(filename, Buffer.from(text, "utf8"));
  }
  return rewritten;
}

function removeTemplateExternalNavigation(files: ReadonlyMap<string, Buffer>) {
  const rewritten = new Map<string, Buffer>();
  for (const [filename, bytes] of files) {
    if (!isTextSourcePath(filename)) {
      rewritten.set(filename, Buffer.from(bytes));
      continue;
    }
    const text = bytes
      .toString("utf8")
      .replace(
        /(<(?:a|Link)\b[^>]{0,512}\bhref\s*=\s*["'])https:\/\/[^"'\s>]+(["'])/giu,
        "$1#$2",
      )
      .replace(
        /(["']?(?:href|link|url|site|locationLink)["']?\s*:\s*["'])https:\/\/[^"'\s]+(["'])/giu,
        "$1#$2",
      )
      .replace(/(\bimages\s*:\s*\[\s*["'])https:\/\/[^"'\s]+(["'])/giu, "$1#$2")
      .replace(/\]\(https:\/\/[^)\s]+\)/giu, "](#)")
      .replace(/\bprocess\.env\.NEXT_PUBLIC_[A-Z0-9_]+\b/gu, "undefined");
    const metadataSafeText = /(?:^|\/)metadata\.[cm]?[jt]sx?$/u.test(filename)
      ? text
          .replace(
            /new\s+URL\(\s*["']https:\/\/[^"']+["']\s*\)/gu,
            'new URL("about:blank")',
          )
          .replace(/(["'])https:\/\/[^"'\s]+\1/gu, '"about:blank"')
      : text;
    const interactionSafeText = metadataSafeText.replace(
      /window\.open\(\s*["']https:\/\/[^"']+["']\s*(?:,\s*["'][^"']*["'])?\s*\)/gu,
      "void 0",
    );
    const compatibleRuntimeText =
      /import\s*\{\s*icons\s*\}\s*from\s*["']lucide-react["']/u.test(
        interactionSafeText,
      )
        ? interactionSafeText.replace(
            /(const\s+[A-Za-z_$][\w$]*\s*=\s*icons\s*\[[^;\r\n]+\])(\s*;)/gu,
            "$1 ?? icons.Circle$2",
          )
        : interactionSafeText;
    rewritten.set(filename, Buffer.from(compatibleRuntimeText, "utf8"));
  }
  return rewritten;
}

function nextStaticShimFiles(input: {
  pageEntrypoint: string;
  layoutEntrypoints: readonly string[];
  fontNames: readonly string[];
}): NativeSourceFile[] {
  const pageImport = relativeSourceImport(
    "src/frontmind-next/root.tsx",
    input.pageEntrypoint,
  );
  const layoutImports = input.layoutEntrypoints.map((entrypoint) =>
    relativeSourceImport("src/frontmind-next/root.tsx", entrypoint),
  );
  let renderedPage = "<Page />";
  for (let index = layoutImports.length - 1; index >= 0; index -= 1) {
    renderedPage = `<Layout${index}>${renderedPage}</Layout${index}>`;
  }
  const fontExports = input.fontNames.map(
    (name) =>
      `export const ${name} = (_options?: unknown) => ({ className: "", variable: "", style: {} });`,
  );
  return [
    {
      path: "src/frontmind-next/root.tsx",
      bytes: Buffer.from(
        [
          'import React from "react";',
          `import Page from ${JSON.stringify(pageImport)};`,
          ...layoutImports.map(
            (entrypoint, index) =>
              `import Layout${index} from ${JSON.stringify(entrypoint)};`,
          ),
          `export default function FrontMindTemplateRoot(){return ${renderedPage}}`,
          "",
        ].join("\n"),
        "utf8",
      ),
    },
    {
      path: "src/frontmind-next/image.tsx",
      bytes: Buffer.from(
        'import React from "react";\ntype Props=React.ImgHTMLAttributes<HTMLImageElement>&{fill?:boolean;priority?:boolean;quality?:number;src:string|{src:string}};\nexport default function Image({fill:_,priority:__,quality:___,src,...props}:Props){return <img src={typeof src==="string"?src:src.src} {...props} />}\n',
        "utf8",
      ),
    },
    {
      path: "src/frontmind-next/dynamic.tsx",
      bytes: Buffer.from(
        'import React from "react";\ntype Loader=()=>Promise<unknown>;\nexport default function dynamic(loader:Loader,options?:{loading?:React.ComponentType}){const Lazy=React.lazy(async()=>{const loaded:any=await loader();return {default:loaded?.default??loaded}});return function DynamicComponent(props:Record<string,unknown>){const fallback=options?.loading?React.createElement(options.loading):null;return <React.Suspense fallback={fallback}><Lazy {...props}/></React.Suspense>}}\n',
        "utf8",
      ),
    },
    {
      path: "src/frontmind-next/link.tsx",
      bytes: Buffer.from(
        'import React from "react";\nexport default function Link(props:React.AnchorHTMLAttributes<HTMLAnchorElement>){return <a {...props} />}\n',
        "utf8",
      ),
    },
    {
      path: "src/frontmind-next/head.tsx",
      bytes: Buffer.from(
        'import React from "react";\nexport default function Head({children}:{children?:React.ReactNode}){return <>{children}</>}\n',
        "utf8",
      ),
    },
    {
      path: "src/frontmind-next/navigation.ts",
      bytes: Buffer.from(
        'export const usePathname=()=>"/"; export const useSearchParams=()=>new URLSearchParams(); export const useRouter=()=>({push:()=>undefined,replace:()=>undefined,back:()=>undefined,refresh:()=>undefined,prefetch:async()=>undefined});\n',
        "utf8",
      ),
    },
    {
      path: "src/frontmind-next/types.ts",
      bytes: Buffer.from(
        "export type Metadata=Record<string,unknown>; export type Viewport=Record<string,unknown>;\n",
        "utf8",
      ),
    },
    {
      path: "src/frontmind-next/font-google.ts",
      bytes: Buffer.from(`${fontExports.join("\n")}\n`, "utf8"),
    },
    {
      path: "src/frontmind-next/font-local.ts",
      bytes: Buffer.from(
        'export default function localFont(_options?:unknown){return {className:"",variable:"",style:{}}}\n',
        "utf8",
      ),
    },
    {
      path: "src/frontmind-next/marquee.tsx",
      bytes: Buffer.from(
        'import React from "react";\nexport function Marquee({children,direction="left",pauseOnHover=false,reverse=false,fade=false,className="",innerClassName="",numberOfCopies=2,...rest}:React.HTMLAttributes<HTMLDivElement>&{children:React.ReactNode;direction?:"left"|"up";pauseOnHover?:boolean;reverse?:boolean;fade?:boolean;innerClassName?:string;numberOfCopies?:number}){const outer=["group flex gap-[1rem] overflow-hidden",direction==="left"?"flex-row":"flex-col",className].filter(Boolean).join(" ");const inner=["flex justify-around gap-[1rem] [--gap:1rem] shrink-0",direction==="left"?"animate-marquee-left flex-row":"animate-marquee-up flex-col",pauseOnHover?"group-hover:[animation-play-state:paused]":"",reverse?"direction-reverse":"",innerClassName].filter(Boolean).join(" ");const gradient=fade?`linear-gradient(${direction==="left"?"to right":"to bottom"},transparent 0%,rgba(0,0,0,1) 10%,rgba(0,0,0,1) 90%,transparent 100%)`:undefined;return <div className={outer} style={{maskImage:gradient,WebkitMaskImage:gradient}} {...rest}>{Array.from({length:numberOfCopies},(_,index)=><div key={index} className={inner}>{children}</div>)}</div>}\n',
        "utf8",
      ),
    },
    {
      path: "src/frontmind-next/marquee.css",
      bytes: Buffer.from(
        "@keyframes marquee-left{from{transform:translateX(0)}to{transform:translateX(calc(-100% - var(--gap)))}}.animate-marquee-left{animation:marquee-left var(--duration,40s) linear infinite}@keyframes marquee-up{from{transform:translateY(0)}to{transform:translateY(calc(-100% - var(--gap)))}}.animate-marquee-up{animation:marquee-up var(--duration,40s) linear infinite}\n",
        "utf8",
      ),
    },
  ];
}

function nativeTemplateDependencies(files: ReadonlyMap<string, Buffer>) {
  try {
    return collectDependencies([], files);
  } catch (error) {
    if (error instanceof NativeVisualSourceError) {
      throw new NativeVisualSourceError(
        "NATIVE_TEMPLATE_DEPENDENCY_UNSUPPORTED",
        error,
      );
    }
    throw error;
  }
}

/** Converts a complete 21st Template ZIP into the same controlled, immutable
 * source archive contract used after selection and by Manus. Provider package
 * scripts/config are never executed. Next.js static pages are rendered through
 * local compatibility shims, while their components, CSS and assets remain the
 * selected source baseline. */
export async function normalizeTwentyFirstNativeTemplateArchive(input: {
  templateId: string | number;
  slug: string;
  version: string | null;
  archive: Uint8Array;
  expectedArchiveSha256?: string;
  sourceSubdirectory?: string | null;
}): Promise<
  NormalizedTwentyFirstNativeSource & {
    templateId: string;
    templateSlug: string;
    framework: NativeTemplateFramework;
    sourceDirectory: typeof NATIVE_SOURCE_DIRECTORY;
  }
> {
  const templateId = cleanTemplateCoordinate(
    input.templateId,
    "NATIVE_TEMPLATE_COORDINATE_INVALID",
  );
  const templateSlug = cleanTemplateCoordinate(
    input.slug,
    "NATIVE_TEMPLATE_COORDINATE_INVALID",
  );
  const archive = Buffer.from(input.archive);
  if (
    input.expectedArchiveSha256 &&
    sha256(archive) !== input.expectedArchiveSha256
  ) {
    throw new NativeVisualSourceError("NATIVE_TEMPLATE_ARCHIVE_HASH_MISMATCH");
  }
  let templateFiles = await extractNativeTemplateFiles(
    archive,
    input.sourceSubdirectory,
    templateSlug,
  );
  const manifest = packageManifestFromTemplateFiles(templateFiles);
  assertTemplatePackageIsInert(manifest);
  if (
    [...templateFiles.keys()].some((filename) =>
      /(?:^|\/)(?:app|pages)\/(?:[^/]+\/)*api(?:\/|$)/u.test(filename),
    )
  ) {
    throw new NativeVisualSourceError("NATIVE_TEMPLATE_DEPENDENCY_UNSUPPORTED");
  }
  const registryTemplateEntrypoint = findRegistryTemplateEntrypoint(
    templateFiles,
    templateSlug,
  );
  const nextEntrypoint =
    registryTemplateEntrypoint ?? findNextStaticEntrypoint(templateFiles);
  const framework: NativeTemplateFramework = nextEntrypoint
    ? "next_static"
    : "vite_react";
  let entrypoint: string;
  let demoEntrypoint: string;
  if (framework === "next_static") {
    entrypoint = nextEntrypoint!;
    // A registry template is already a complete visual root. Wrapping it in
    // the registry website's documentation layout would show the marketplace
    // shell instead of the selected template.
    const originalLayoutEntrypoints = registryTemplateEntrypoint
      ? []
      : nextStaticLayoutEntrypoints(templateFiles, entrypoint);
    const registryGlobalStyles = registryTemplateEntrypoint
      ? ["app/globals.css", "src/app/globals.css"].filter((filename) =>
          templateFiles.has(filename),
        )
      : [];
    templateFiles = nextStaticRuntimeClosure(templateFiles, [
      entrypoint,
      ...originalLayoutEntrypoints,
      ...registryGlobalStyles,
    ]);
    const fontNames = nextFontNames(templateFiles);
    templateFiles = rewriteNextStaticImports(templateFiles);
    const layoutEntrypoints = nextStaticLayoutEntrypoints(
      templateFiles,
      entrypoint,
    );
    const shims = nextStaticShimFiles({
      pageEntrypoint: entrypoint,
      layoutEntrypoints,
      fontNames,
    });
    for (const file of shims) templateFiles.set(file.path, file.bytes);
    demoEntrypoint = "src/frontmind-next/root.tsx";
  } else {
    const detected = findViteEntrypoint(templateFiles);
    if (!detected || !templateFiles.has("index.html")) {
      throw new NativeVisualSourceError("NATIVE_TEMPLATE_ENTRYPOINT_MISSING");
    }
    entrypoint = detected;
    demoEntrypoint = detected;
    // Keep only the selected page's local runtime closure. Template archives
    // frequently contain docs, lockfiles and server examples that are not part
    // of the homepage and must not affect the controlled static build. The
    // original bootstrap is included only while computing this closure so its
    // global CSS imports survive; it is discarded before the fixed host shell
    // is written and is never executed.
    const bootstrapEntrypoints = [
      "src/main.tsx",
      "src/main.jsx",
      "src/main.ts",
      "src/main.js",
    ].filter((candidate) => templateFiles.has(candidate));
    const bootstrapStylesheets = bootstrapEntrypoints.flatMap((bootstrap) =>
      sourceImports(templateFiles.get(bootstrap)!.toString("utf8")).flatMap(
        (specifier) =>
          specifier.startsWith(".") && specifier.endsWith(".css")
            ? localImportCandidates(bootstrap, specifier).filter((candidate) =>
                templateFiles.has(candidate),
              )
            : [],
      ),
    );
    templateFiles = nextStaticRuntimeClosure(templateFiles, [
      detected,
      ...bootstrapStylesheets,
    ]);
  }
  templateFiles = removeTemplateExternalNavigation(templateFiles);
  const tailwindV3Config = staticTailwindV3Config(templateFiles);
  for (const controlled of [
    CONTROLLED_HTML_ENTRYPOINT,
    CONTROLLED_PACKAGE_MANIFEST,
    CONTROLLED_APP_ENTRYPOINT,
    CONTROLLED_TAILWIND_STYLESHEET,
    NATIVE_SOURCE_MANIFEST_PATH,
  ]) {
    templateFiles.delete(controlled);
  }
  // The original entry bootstrap/config is inert and intentionally omitted;
  // the selected components, CSS and assets are compiled by FrontMind's fixed
  // shell without invoking Provider scripts.
  for (const filename of [...templateFiles.keys()]) {
    if (
      /(?:^|\/)(?:vite|next|postcss|tailwind)\.config\.[cm]?[jt]s$/u.test(
        filename,
      ) ||
      /(?:^|\/)src\/main\.[cm]?[jt]sx?$/u.test(filename)
    ) {
      templateFiles.delete(filename);
    }
  }
  if (!templateFiles.has(entrypoint) || !templateFiles.has(demoEntrypoint)) {
    throw new NativeVisualSourceError("NATIVE_TEMPLATE_ENTRYPOINT_MISSING");
  }
  assertLocalSourceImportClosure(templateFiles);
  const dependencies = nativeTemplateDependencies(templateFiles);
  const providerFiles = [...templateFiles]
    .filter(([, bytes]) => bytes.length > 0)
    .map(([filename, bytes]) => ({ path: filename, bytes: Buffer.from(bytes) }))
    .sort((left, right) => left.path.localeCompare(right.path));
  const projectFiles = controlledSourceProject({
    providerFiles,
    demoEntrypoint,
    dependencies,
    tailwindV3Config,
  });
  const totalBytes = projectFiles.reduce(
    (sum, file) => sum + file.bytes.length,
    0,
  );
  if (
    projectFiles.length > MAX_SOURCE_FILES ||
    totalBytes > MAX_SOURCE_TOTAL_BYTES ||
    projectFiles.some((file) => file.bytes.length > MAX_SOURCE_FILE_BYTES)
  ) {
    throw new NativeVisualSourceError("NATIVE_TEMPLATE_ARCHIVE_INVALID");
  }
  assertHardSourceSafety(projectFiles, dependencies, {
    allowStaticRemoteMedia: true,
  });
  return {
    templateId,
    templateSlug,
    framework,
    sourceDirectory: NATIVE_SOURCE_DIRECTORY,
    providerItemKey: `t:${templateId}:${templateSlug}`,
    providerVersion: cleanVersion(input.version),
    entrypoint,
    demoEntrypoint,
    dependencies,
    htmlEntrypoint: CONTROLLED_HTML_ENTRYPOINT,
    appEntrypoint: CONTROLLED_APP_ENTRYPOINT,
    files: projectFiles,
    sourceTreeSha256: nativeSourceTreeSha256(projectFiles),
  };
}

function decodeStaticStylesheet(bytes: Buffer) {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch (error) {
    throw new NativeVisualSourceError(
      "NATIVE_SOURCE_STATIC_MEDIA_UNAVAILABLE",
      error,
    );
  }
}

function absolutizeRemoteStylesheetUrls(text: string, baseUrl: string) {
  return text.replace(
    /url\(\s*(?:"([^"]+)"|'([^']+)'|([^"')\s]+))\s*\)/giu,
    (matched, doubleQuoted, singleQuoted, bare) => {
      const raw = String(doubleQuoted ?? singleQuoted ?? bare ?? "").trim();
      if (!raw || raw.startsWith("data:") || raw.startsWith("#")) {
        return matched;
      }
      let resolved: URL;
      try {
        resolved = new URL(raw, baseUrl);
      } catch (error) {
        throw new NativeVisualSourceError(
          "NATIVE_SOURCE_STATIC_MEDIA_UNAVAILABLE",
          error,
        );
      }
      if (resolved.protocol !== "https:") {
        throw new NativeVisualSourceError(
          "NATIVE_SOURCE_STATIC_MEDIA_UNAVAILABLE",
        );
      }
      resolved.hash = "";
      return `url(${JSON.stringify(resolved.toString())})`;
    },
  );
}

async function inlineRemoteTemplateStylesheets(input: {
  files: readonly NativeSourceFile[];
  signal: AbortSignal;
  fetchRemoteStyleAsset: FetchNativeTemplateStaticAsset;
}) {
  const active = new Set<string>();
  const cache = new Map<string, string>();
  let stylesheetCount = 0;
  let fetchedBytes = 0;
  const load = async (rawUrl: string, depth: number): Promise<string> => {
    if (depth > 1 || input.signal.aborted) {
      throw (
        input.signal.reason ??
        new NativeVisualSourceError("NATIVE_SOURCE_STATIC_MEDIA_UNAVAILABLE")
      );
    }
    let url: URL;
    try {
      url = new URL(rawUrl);
    } catch (error) {
      throw new NativeVisualSourceError(
        "NATIVE_SOURCE_STATIC_MEDIA_UNAVAILABLE",
        error,
      );
    }
    if (url.protocol !== "https:") {
      throw new NativeVisualSourceError(
        "NATIVE_SOURCE_STATIC_MEDIA_UNAVAILABLE",
      );
    }
    const cacheKey = url.toString();
    const cached = cache.get(cacheKey);
    if (cached !== undefined) return cached;
    if (active.has(cacheKey)) {
      throw new NativeVisualSourceError(
        "NATIVE_SOURCE_STATIC_MEDIA_UNAVAILABLE",
      );
    }
    active.add(cacheKey);
    stylesheetCount += 1;
    if (stylesheetCount > MAX_REMOTE_STYLESHEETS) {
      throw new NativeVisualSourceError("NATIVE_SOURCE_STATIC_MEDIA_LIMIT");
    }
    try {
      const fetched = await input.fetchRemoteStyleAsset({
        url: cacheKey,
        kind: "css",
        signal: input.signal,
      });
      fetchedBytes += fetched.buffer.length;
      if (fetchedBytes > MAX_REMOTE_STYLE_ASSET_BYTES) {
        throw new NativeVisualSourceError("NATIVE_SOURCE_STATIC_MEDIA_LIMIT");
      }
      let text = decodeStaticStylesheet(fetched.buffer);
      const imports = [...text.matchAll(remoteCssImportPattern())];
      if (imports.length > 0 && depth >= 1) {
        throw new NativeVisualSourceError(
          "NATIVE_SOURCE_STATIC_MEDIA_UNAVAILABLE",
        );
      }
      for (const match of imports) {
        const specifier = match[1] ?? match[2] ?? match[3];
        if (!specifier) {
          throw new NativeVisualSourceError(
            "NATIVE_SOURCE_STATIC_MEDIA_UNAVAILABLE",
          );
        }
        const nestedUrl = new URL(specifier, fetched.finalUrl);
        if (nestedUrl.protocol !== "https:") {
          throw new NativeVisualSourceError(
            "NATIVE_SOURCE_STATIC_MEDIA_UNAVAILABLE",
          );
        }
        const nested = await load(nestedUrl.toString(), depth + 1);
        text = text.replace(match[0], nested);
      }
      const resolved = absolutizeRemoteStylesheetUrls(text, fetched.finalUrl);
      cache.set(cacheKey, resolved);
      return resolved;
    } finally {
      active.delete(cacheKey);
    }
  };

  const files: NativeSourceFile[] = [];
  for (const file of input.files) {
    if (!file.path.endsWith(".css")) {
      files.push(file);
      continue;
    }
    let text = file.bytes.toString("utf8");
    for (const match of [...text.matchAll(remoteCssImportPattern())]) {
      const specifier = match[1] ?? match[2] ?? match[3];
      if (!specifier?.startsWith("https://")) continue;
      const imported = await load(specifier, 0);
      text = text.replace(match[0], imported);
    }
    files.push({ path: file.path, bytes: Buffer.from(text, "utf8") });
  }
  return { files, fetchedBytes };
}

function assertMirroredFontBytes(bytes: Buffer, extension: string) {
  const signature = bytes.subarray(0, 4).toString("latin1");
  const valid =
    (extension === "woff" && signature === "wOFF") ||
    (extension === "woff2" && signature === "wOF2") ||
    (extension === "otf" && signature === "OTTO") ||
    (extension === "ttf" &&
      bytes.length >= 4 &&
      bytes[0] === 0 &&
      bytes[1] === 1 &&
      bytes[2] === 0 &&
      bytes[3] === 0) ||
    (extension === "eot" && bytes.length >= 82);
  if (!valid) {
    throw new NativeVisualSourceError("NATIVE_SOURCE_STATIC_MEDIA_UNAVAILABLE");
  }
}

async function mirrorNativeStaticMedia(input: {
  source: NormalizedTwentyFirstNativeSource;
  signal: AbortSignal;
  fetchRemoteAsset: typeof fetchSafeVisualPreview;
  fetchRemoteStyleAsset: FetchNativeTemplateStaticAsset;
  fetchRemoteRuntimeMedia: FetchNativeTemplateRuntimeMedia;
  frozenRuntimeMedia?: ReadonlyMap<
    string,
    Readonly<{ kind: "image" | "video"; sha256: string; bytes: number }>
  >;
}) {
  const inlined = await inlineRemoteTemplateStylesheets({
    files: input.source.files,
    signal: input.signal,
    fetchRemoteStyleAsset: input.fetchRemoteStyleAsset,
  });
  const urls = new Set<string>();
  for (const file of inlined.files) {
    if (!isTextSourcePath(file.path)) continue;
    staticRemoteMediaUrls(file.bytes.toString("utf8")).forEach((url) =>
      urls.add(url),
    );
  }
  if (urls.size === 0) {
    if (input.frozenRuntimeMedia?.size) {
      throw new NativeVisualSourceError(
        "NATIVE_SOURCE_STATIC_MEDIA_INTEGRITY_MISMATCH",
      );
    }
    const files = [...inlined.files].sort((left, right) =>
      left.path.localeCompare(right.path),
    );
    assertHardSourceSafety(files, input.source.dependencies);
    return {
      ...input.source,
      files,
      sourceTreeSha256: nativeSourceTreeSha256(files),
    };
  }
  if (urls.size > MAX_STATIC_MEDIA_ASSETS) {
    throw new NativeVisualSourceError("NATIVE_SOURCE_STATIC_MEDIA_LIMIT");
  }
  const replacements = new Map<string, string>();
  const assets: NativeSourceFile[] = [];
  const consumedFrozenRuntimeMedia = new Set<string>();
  let fetchedStaticBytes = inlined.fetchedBytes;
  let fetchedRuntimeMediaBytes = 0;
  for (const url of [...urls].sort()) {
    if (input.signal.aborted) throw input.signal.reason;
    const frozen = input.frozenRuntimeMedia?.get(url);
    if (input.frozenRuntimeMedia && !frozen) {
      throw new NativeVisualSourceError(
        "NATIVE_SOURCE_STATIC_MEDIA_INTEGRITY_MISMATCH",
      );
    }
    const videoExtension = remoteRuntimeVideoExtension(url);
    if (videoExtension) {
      if (frozen && frozen.kind !== "video") {
        throw new NativeVisualSourceError(
          "NATIVE_SOURCE_STATIC_MEDIA_INTEGRITY_MISMATCH",
        );
      }
      let fetched: NativeTemplateStaticAsset;
      try {
        fetched = await input.fetchRemoteRuntimeMedia({
          url,
          kind: "video",
          signal: input.signal,
        });
      } catch (error) {
        throw new NativeVisualSourceError(
          "NATIVE_SOURCE_STATIC_MEDIA_UNAVAILABLE",
          error,
        );
      }
      let finalUrl: URL;
      try {
        finalUrl = new URL(fetched.finalUrl);
      } catch (error) {
        throw new NativeVisualSourceError(
          "NATIVE_SOURCE_STATIC_MEDIA_UNAVAILABLE",
          error,
        );
      }
      if (
        finalUrl.protocol !== "https:" ||
        fetched.mimeType.toLowerCase() !== "video/mp4" ||
        fetched.buffer.length < 12 ||
        fetched.buffer.length > MAX_REMOTE_VIDEO_BYTES ||
        fetched.buffer.subarray(4, 8).toString("latin1") !== "ftyp"
      ) {
        throw new NativeVisualSourceError(
          "NATIVE_SOURCE_STATIC_MEDIA_UNAVAILABLE",
        );
      }
      if (
        frozen &&
        (fetched.buffer.length !== frozen.bytes ||
          sha256(fetched.buffer) !== frozen.sha256)
      ) {
        throw new NativeVisualSourceError(
          "NATIVE_SOURCE_STATIC_MEDIA_INTEGRITY_MISMATCH",
        );
      }
      if (frozen) consumedFrozenRuntimeMedia.add(url);
      fetchedRuntimeMediaBytes += fetched.buffer.length;
      if (fetchedRuntimeMediaBytes > MAX_REMOTE_VIDEO_TOTAL_BYTES) {
        throw new NativeVisualSourceError("NATIVE_SOURCE_STATIC_MEDIA_LIMIT");
      }
      const filename = `public/frontmind-native-media/${sha256(fetched.buffer)}.${videoExtension}`;
      replacements.set(url, `/${filename.slice("public/".length)}`);
      if (!assets.some((asset) => asset.path === filename)) {
        assets.push({ path: filename, bytes: Buffer.from(fetched.buffer) });
      }
      continue;
    }
    if (remoteRuntimeMediaIsUnsupported(url)) {
      throw new NativeVisualSourceError(
        "NATIVE_SOURCE_STATIC_MEDIA_UNSUPPORTED",
      );
    }
    const fontExtension = remoteFontExtension(url);
    if (fontExtension) {
      let fetched: NativeTemplateStaticAsset;
      try {
        fetched = await input.fetchRemoteStyleAsset({
          url,
          kind: "font",
          signal: input.signal,
        });
      } catch (error) {
        throw new NativeVisualSourceError(
          "NATIVE_SOURCE_STATIC_MEDIA_UNAVAILABLE",
          error,
        );
      }
      fetchedStaticBytes += fetched.buffer.length;
      if (fetchedStaticBytes > MAX_REMOTE_STYLE_ASSET_BYTES) {
        throw new NativeVisualSourceError("NATIVE_SOURCE_STATIC_MEDIA_LIMIT");
      }
      assertMirroredFontBytes(fetched.buffer, fontExtension);
      const filename = `public/frontmind-native-media/${sha256(fetched.buffer)}.${fontExtension}`;
      replacements.set(url, `/${filename.slice("public/".length)}`);
      if (!assets.some((asset) => asset.path === filename)) {
        assets.push({ path: filename, bytes: Buffer.from(fetched.buffer) });
      }
      continue;
    }
    let bytes: Buffer;
    let extension = "webp";
    try {
      const fetched = await input.fetchRemoteAsset({
        url,
        signal: input.signal,
      });
      if (
        frozen &&
        (frozen.kind !== "image" ||
          fetched.buffer.length !== frozen.bytes ||
          sha256(fetched.buffer) !== frozen.sha256)
      ) {
        throw new NativeVisualSourceError(
          "NATIVE_SOURCE_STATIC_MEDIA_INTEGRITY_MISMATCH",
        );
      }
      if (frozen) consumedFrozenRuntimeMedia.add(url);
      bytes = await sharp(fetched.buffer)
        .rotate()
        .resize({
          width: 1600,
          height: 1200,
          fit: "inside",
          withoutEnlargement: true,
        })
        .webp({ quality: 80, effort: 4 })
        .toBuffer();
      if (bytes.length > MAX_SOURCE_FILE_BYTES) {
        bytes = await sharp(fetched.buffer)
          .rotate()
          .resize({
            width: 1280,
            height: 960,
            fit: "inside",
            withoutEnlargement: true,
          })
          .webp({ quality: 62, effort: 4 })
          .toBuffer();
      }
    } catch (error) {
      if (frozen) {
        throw new NativeVisualSourceError(
          "NATIVE_SOURCE_STATIC_MEDIA_INTEGRITY_MISMATCH",
          error,
        );
      }
      if (!optionalStaticMediaMayUsePlaceholder(inlined.files, url)) {
        throw new NativeVisualSourceError(
          "NATIVE_SOURCE_STATIC_MEDIA_UNAVAILABLE",
          error,
        );
      }
      bytes = Buffer.from(NATIVE_TEMPLATE_OPTIONAL_MEDIA_PLACEHOLDER);
      extension = "svg";
    }
    if (bytes.length < 1 || bytes.length > MAX_SOURCE_FILE_BYTES) {
      throw new NativeVisualSourceError("NATIVE_SOURCE_STATIC_MEDIA_LIMIT");
    }
    const filename = `public/frontmind-native-media/${sha256(bytes)}.${extension}`;
    replacements.set(url, `/${filename.slice("public/".length)}`);
    if (!assets.some((asset) => asset.path === filename)) {
      assets.push({ path: filename, bytes });
    }
  }
  if (
    input.frozenRuntimeMedia &&
    consumedFrozenRuntimeMedia.size !== input.frozenRuntimeMedia.size
  ) {
    throw new NativeVisualSourceError(
      "NATIVE_SOURCE_STATIC_MEDIA_INTEGRITY_MISMATCH",
    );
  }
  const files = inlined.files.map((file) => {
    if (!isTextSourcePath(file.path)) return file;
    let text = file.bytes.toString("utf8");
    for (const [url, replacement] of replacements) {
      text = text.replaceAll(url, replacement);
    }
    return { path: file.path, bytes: Buffer.from(text, "utf8") };
  });
  files.push(...assets);
  files.sort((left, right) => left.path.localeCompare(right.path));
  const totalBytes = files.reduce((sum, file) => sum + file.bytes.length, 0);
  if (
    files.length > MAX_SOURCE_FILES ||
    totalBytes > MAX_SOURCE_TOTAL_BYTES ||
    files.some(
      (file) =>
        file.bytes.length < 1 || file.bytes.length > MAX_SOURCE_FILE_BYTES,
    )
  ) {
    throw new NativeVisualSourceError("NATIVE_SOURCE_SIZE_EXCEEDED");
  }
  assertHardSourceSafety(files, input.source.dependencies);
  return {
    ...input.source,
    files,
    sourceTreeSha256: nativeSourceTreeSha256(files),
  };
}

function zipFileOptions() {
  return {
    date: FIXED_ZIP_DATE,
    createFolders: false,
    unixPermissions: 0o100600,
  } as const;
}

function sourceManifest(
  source: NormalizedTwentyFirstNativeSource,
): NativeSourceManifestV1 {
  return nativeSourceManifestV1Schema.parse({
    schemaVersion: 1,
    renderer: "twenty_first_native_react_v1",
    providerItemKey: source.providerItemKey,
    providerVersion: source.providerVersion,
    entrypoint: source.entrypoint,
    demoEntrypoint: source.demoEntrypoint,
    dependencies: source.dependencies,
    htmlEntrypoint: source.htmlEntrypoint,
    appEntrypoint: source.appEntrypoint,
    files: source.files.map((file) => ({
      path: file.path,
      sha256: sha256(file.bytes),
      bytes: file.bytes.length,
    })),
    sourceTreeSha256: source.sourceTreeSha256,
  });
}

export async function createNativeSourceArchive(
  source: NormalizedTwentyFirstNativeSource,
) {
  if (nativeSourceTreeSha256(source.files) !== source.sourceTreeSha256) {
    throw new NativeVisualSourceError("NATIVE_SOURCE_TREE_HASH_MISMATCH");
  }
  const zip = new JSZip();
  zip.file(
    NATIVE_SOURCE_MANIFEST_ARCHIVE_PATH,
    canonicalJson(sourceManifest(source)),
    zipFileOptions(),
  );
  for (const file of source.files) {
    zip.file(
      `${NATIVE_SOURCE_DIRECTORY}/${file.path}`,
      file.bytes,
      zipFileOptions(),
    );
  }
  const bytes = await zip.generateAsync({
    type: "nodebuffer",
    compression: "DEFLATE",
    compressionOptions: { level: 9 },
    platform: "UNIX",
  });
  if (bytes.length > NATIVE_VISUAL_SOURCE_ARCHIVE_MAX_BYTES) {
    throw new NativeVisualSourceError("NATIVE_SOURCE_ARCHIVE_TOO_LARGE");
  }
  return bytes;
}

export async function readNativeSourceArchive(bytes: Buffer) {
  if (
    bytes.length < 1 ||
    bytes.length > NATIVE_VISUAL_SOURCE_ARCHIVE_MAX_BYTES
  ) {
    throw new NativeVisualSourceError("NATIVE_SOURCE_ARCHIVE_SIZE_INVALID");
  }
  const zip = await JSZip.loadAsync(bytes, {
    checkCRC32: true,
    createFolders: false,
  });
  const entries = Object.values(zip.files) as BoundedZipEntry[];
  if (
    entries.some(
      (entry) =>
        entry.dir ||
        zipEntryIsSymlink(entry) ||
        (entry.unsafeOriginalName ?? entry.name) !== entry.name,
    )
  ) {
    throw new NativeVisualSourceError("NATIVE_SOURCE_ARCHIVE_PATH_UNSAFE");
  }
  const manifestEntry = zip.file(NATIVE_SOURCE_MANIFEST_ARCHIVE_PATH);
  if (!manifestEntry)
    throw new NativeVisualSourceError("NATIVE_SOURCE_MANIFEST_MISSING");
  const manifestText = await manifestEntry.async("string");
  if (Buffer.byteLength(manifestText, "utf8") > 128_000) {
    throw new NativeVisualSourceError("NATIVE_SOURCE_MANIFEST_TOO_LARGE");
  }
  let manifestValue: unknown;
  try {
    manifestValue = JSON.parse(manifestText);
  } catch {
    throw new NativeVisualSourceError("NATIVE_SOURCE_MANIFEST_INVALID");
  }
  const manifest = nativeSourceManifestV1Schema.parse(manifestValue);
  const expectedEntryNames = new Set([
    NATIVE_SOURCE_MANIFEST_ARCHIVE_PATH,
    ...manifest.files.map((file) => `${NATIVE_SOURCE_DIRECTORY}/${file.path}`),
  ]);
  if (
    entries.length !== expectedEntryNames.size ||
    entries.some((entry) => !expectedEntryNames.has(entry.name))
  ) {
    throw new NativeVisualSourceError("NATIVE_SOURCE_ARCHIVE_UNEXPECTED_ENTRY");
  }
  const files: NativeSourceFile[] = [];
  for (const item of manifest.files) {
    const entry = zip.file(`${NATIVE_SOURCE_DIRECTORY}/${item.path}`);
    if (!entry) throw new NativeVisualSourceError("NATIVE_SOURCE_FILE_MISSING");
    const declared = Number(
      (entry as BoundedZipEntry)._data?.uncompressedSize ?? 0,
    );
    if (Number.isFinite(declared) && declared > item.bytes) {
      throw new NativeVisualSourceError("NATIVE_SOURCE_FILE_SIZE_MISMATCH");
    }
    const fileBytes = await entry.async("nodebuffer");
    if (fileBytes.length !== item.bytes || sha256(fileBytes) !== item.sha256) {
      throw new NativeVisualSourceError("NATIVE_SOURCE_FILE_HASH_MISMATCH");
    }
    files.push({ path: item.path, bytes: fileBytes });
  }
  if (nativeSourceTreeSha256(files) !== manifest.sourceTreeSha256) {
    throw new NativeVisualSourceError("NATIVE_SOURCE_TREE_HASH_MISMATCH");
  }
  if (
    manifest.htmlEntrypoint !== CONTROLLED_HTML_ENTRYPOINT ||
    manifest.appEntrypoint !== CONTROLLED_APP_ENTRYPOINT ||
    !files.some((file) => file.path === manifest.htmlEntrypoint) ||
    !files.some((file) => file.path === manifest.appEntrypoint) ||
    !files.some((file) => file.path === CONTROLLED_TAILWIND_STYLESHEET) ||
    !files.some((file) => file.path === CONTROLLED_PACKAGE_MANIFEST)
  ) {
    throw new NativeVisualSourceError("NATIVE_SOURCE_SHELL_MISSING");
  }
  for (const dependency of manifest.dependencies) {
    if (
      dependency.installedVersion !==
      installedNativeSourceDependencyVersion(dependency.name)
    ) {
      throw new NativeVisualSourceError("NATIVE_SOURCE_DEPENDENCY_DRIFT");
    }
  }
  assertHardSourceSafety(files, manifest.dependencies);
  return { manifest, files };
}

const MAX_STYLE_SIGNAL_SOURCE_BYTES = 2 * 1024 * 1024;
const MAX_STYLE_SIGNAL_FILE_BYTES = 256 * 1024;
const MAX_STYLE_SIGNAL_FILES = 64;

function countMatches(text: string, pattern: RegExp) {
  let count = 0;
  for (const _match of text.matchAll(pattern)) {
    count += 1;
    if (count >= 1_000) break;
  }
  return count;
}

function deriveOpaqueTemplateStyleSignals(
  records: readonly {
    path: string;
    bytes: Buffer;
    symlink: boolean;
  }[],
  scope: {
    sourceSubdirectory: string | null;
    entrypoint: string;
  },
): Pick<VisualCandidateStyleTokensV1, "typeSystem" | "density"> {
  const fragments: string[] = [];
  let totalBytes = 0;
  const entrypointDirectory = path.posix.dirname(scope.entrypoint);
  const styleRoot =
    entrypointDirectory !== "." &&
    (!scope.sourceSubdirectory ||
      entrypointDirectory === scope.sourceSubdirectory ||
      entrypointDirectory.startsWith(`${scope.sourceSubdirectory}/`))
      ? entrypointDirectory
      : scope.sourceSubdirectory;
  const candidates = records
    .filter((record) => {
      return (
        !record.symlink &&
        record.bytes.length > 0 &&
        record.bytes.length <= MAX_STYLE_SIGNAL_FILE_BYTES &&
        (!styleRoot ||
          record.path === styleRoot ||
          record.path.startsWith(`${styleRoot}/`)) &&
        /\.(?:css|scss|sass|less|html|[cm]?[jt]sx?)$/iu.test(record.path)
      );
    })
    .sort((left, right) => left.path.localeCompare(right.path))
    .slice(0, MAX_STYLE_SIGNAL_FILES);
  for (const record of candidates) {
    if (totalBytes + record.bytes.length > MAX_STYLE_SIGNAL_SOURCE_BYTES) {
      break;
    }
    try {
      fragments.push(
        new TextDecoder("utf-8", { fatal: true })
          .decode(record.bytes)
          .toLowerCase(),
      );
      totalBytes += record.bytes.length;
    } catch {
      // Binary or malformed text cannot contribute a trusted style signal.
    }
  }
  const text = fragments.join("\n");
  const declarations = Array.from(
    text.matchAll(/font-family\s*:\s*([^;{}]{1,200})/gu),
    (match) => match[1] ?? "",
  ).join(" ");
  const serifDeclarations = declarations.replace(/sans-serif/gu, "");
  const scores = {
    editorial_serif:
      countMatches(text, /\bfont-serif\b/gu) +
      countMatches(
        serifDeclarations,
        /\b(?:serif|georgia|times(?: new roman)?|playfair|merriweather|cormorant|lora|baskerville)\b/gu,
      ),
    technical_sans:
      countMatches(text, /\bfont-mono\b/gu) +
      countMatches(
        declarations,
        /\b(?:monospace|mono|consolas|menlo|monaco|courier|jetbrains mono|source code pro)\b/gu,
      ),
    humanist_sans: countMatches(
      declarations,
      /\b(?:trebuchet|avenir|lato|nunito|frutiger|gill sans|humanist)\b/gu,
    ),
    display_sans:
      countMatches(text, /\bfont-sans\b/gu) +
      countMatches(
        declarations,
        /\b(?:sans-serif|inter|arial|helvetica|roboto|system-ui|ui-sans-serif)\b/gu,
      ),
  } as const;
  const rankedTypeSystems = Object.entries(scores).sort(
    ([leftName, leftScore], [rightName, rightScore]) =>
      rightScore - leftScore || leftName.localeCompare(rightName),
  ) as Array<
    [Exclude<VisualCandidateStyleTokensV1["typeSystem"], "unknown">, number]
  >;
  const typeSystem =
    (rankedTypeSystems[0]?.[1] ?? 0) > 0
      ? rankedTypeSystems[0]![0]
      : ("unknown" as const);

  let compactScore = 0;
  let spaciousScore = 0;
  for (const match of text.matchAll(
    /(?:padding(?:-(?:block|inline|top|right|bottom|left))?|gap|row-gap|column-gap)\s*:\s*(\d+(?:\.\d+)?)(px|rem)\b/gu,
  )) {
    const value = Number(match[1]);
    const pixels = match[2] === "rem" ? value * 16 : value;
    if (pixels > 0 && pixels <= 16) compactScore += 1;
    if (pixels >= 32) spaciousScore += 1;
  }
  for (const match of text.matchAll(
    /\b(?:p[xytrbl]?|gap(?:-[xy])?|space-[xy])-(\d+(?:\.\d+)?)\b/gu,
  )) {
    const scale = Number(match[1]);
    if (scale > 0 && scale <= 4) compactScore += 1;
    if (scale >= 8) spaciousScore += 1;
  }
  const density =
    compactScore === 0 && spaciousScore === 0
      ? ("balanced" as const)
      : spaciousScore > compactScore
        ? ("spacious" as const)
        : compactScore > spaciousScore
          ? ("compact" as const)
          : ("balanced" as const);
  return { typeSystem, density };
}

async function inspectOpaqueProviderTemplateArchive(input: {
  archive: Buffer;
  expectedSha256?: string;
}) {
  const { archive } = input;
  if (
    archive.length < 1 ||
    archive.length > NATIVE_TEMPLATE_PROVIDER_ARCHIVE_MAX_BYTES ||
    (input.expectedSha256 !== undefined &&
      sha256(archive) !== input.expectedSha256)
  ) {
    throw new NativeVisualSourceError(
      input.expectedSha256 === undefined
        ? "NATIVE_TEMPLATE_ARCHIVE_INVALID"
        : "NATIVE_TEMPLATE_ARCHIVE_HASH_MISMATCH",
    );
  }
  let zip: JSZip;
  try {
    zip = await JSZip.loadAsync(archive, {
      checkCRC32: true,
      createFolders: false,
    });
  } catch (error) {
    throw new NativeVisualSourceError("NATIVE_TEMPLATE_ARCHIVE_INVALID", error);
  }
  const entries = Object.values(zip.files) as BoundedZipEntry[];
  if (entries.length < 1 || entries.length > MAX_TEMPLATE_ARCHIVE_ENTRIES) {
    throw new NativeVisualSourceError("NATIVE_TEMPLATE_ARCHIVE_INVALID");
  }
  const records: Array<{
    entry: BoundedZipEntry;
    path: string;
    bytes: Buffer | null;
    symlink: boolean;
  }> = [];
  const seen = new Set<string>();
  let expandedBytes = 0;
  for (const entry of entries) {
    const rawPath = entry.unsafeOriginalName ?? entry.name;
    const withoutDirectoryMarker = rawPath.replace(/\/$/u, "");
    const safePath = safeTemplateArchivePath(withoutDirectoryMarker);
    if (!safePath || rawPath !== entry.name || seen.has(safePath)) {
      throw new NativeVisualSourceError("NATIVE_TEMPLATE_SOURCE_UNSAFE");
    }
    seen.add(safePath);
    if (entry.dir) {
      records.push({ entry, path: safePath, bytes: null, symlink: false });
      continue;
    }
    const declared = Number(entry._data?.uncompressedSize ?? 0);
    if (
      !Number.isFinite(declared) ||
      declared < 0 ||
      declared > MAX_OPAQUE_TEMPLATE_FILE_BYTES ||
      expandedBytes + declared > MAX_OPAQUE_TEMPLATE_EXPANDED_BYTES
    ) {
      throw new NativeVisualSourceError("NATIVE_TEMPLATE_ARCHIVE_INVALID");
    }
    const file = Buffer.from(await entry.async("uint8array"));
    if (
      file.byteLength > MAX_OPAQUE_TEMPLATE_FILE_BYTES ||
      (declared > 0 && file.byteLength !== declared)
    ) {
      throw new NativeVisualSourceError("NATIVE_TEMPLATE_ARCHIVE_INVALID");
    }
    expandedBytes += file.byteLength;
    if (expandedBytes > MAX_OPAQUE_TEMPLATE_EXPANDED_BYTES) {
      throw new NativeVisualSourceError("NATIVE_TEMPLATE_ARCHIVE_INVALID");
    }
    records.push({
      entry,
      path: safePath,
      bytes: file,
      symlink: zipEntryIsSymlink(entry),
    });
  }
  const fileRecords = records
    .filter((record) => record.bytes !== null)
    .map((record) => ({ ...record, bytes: record.bytes! }));
  const paths = fileRecords.map((record) => record.path);
  if (paths.length < 1) {
    throw new NativeVisualSourceError("NATIVE_TEMPLATE_ARCHIVE_INVALID");
  }
  const firstSegments = new Set(
    paths.map((filename) => filename.split("/")[0]),
  );
  const sharedArchiveRoot =
    firstSegments.size === 1 &&
    paths.every((filename) => filename.includes("/"))
      ? [...firstSegments][0]!
      : null;
  const logicalPathFor = (filename: string) =>
    sharedArchiveRoot && filename.startsWith(`${sharedArchiveRoot}/`)
      ? filename.slice(sharedArchiveRoot.length + 1)
      : filename;
  const logicalPaths = paths.map(logicalPathFor);
  const logicalPathByArchivePath = new Map(
    records
      .map((record) => [record.path, logicalPathFor(record.path)] as const)
      .filter(([, logicalPath]) => Boolean(logicalPath)),
  );
  const archivePathByLogicalPath = new Map(
    [...logicalPathByArchivePath].map(([archivePath, logicalPath]) => [
      logicalPath,
      archivePath,
    ]),
  );
  const documentationNamePattern =
    /^(?:AGENTS|CLAUDE|CONTRIBUTING|CODE_OF_CONDUCT|README|SECURITY)(?:\.(?:md|mdx|txt))$/iu;
  const runtimeOrConfigurationPathPattern =
    /(?:^|\/)(?:app|assets?|components?|fonts?|images?|pages|public|registry|src|static|styles?)(?:\/|$)|(?:^|\/)(?:Dockerfile|docker-compose(?:\.[a-z0-9_-]+)?\.ya?ml|package\.json|pnpm-workspace\.yaml|turbo\.json|vercel\.json|(?:bun|npm|pnpm|yarn)\.lock|package-lock\.json|yarn\.lock|tsconfig(?:\.[a-z0-9_-]+)?\.json|(?:eslint|next|postcss|prettier|tailwind|vite)\.config\.[cm]?[jt]s|\.env(?:\.[a-z0-9_-]+)?)(?:$|\/)|\.(?:[cm]?[jt]sx?|css|html|json|svg|png|jpe?g|webp|avif|gif|ico|woff2?|eot|otf|ttf|mp3|mp4|ogg|wav|webm)$/iu;
  const referenceTextPathPattern =
    /\.(?:[cm]?[jt]sx?|css|html|json|ya?ml|toml)$/iu;
  const symlinks = fileRecords.filter((record) => record.symlink);
  for (const symlink of symlinks) {
    const logicalPath = logicalPathByArchivePath.get(symlink.path)!;
    const basename = path.posix.basename(logicalPath);
    if (
      !documentationNamePattern.test(basename) ||
      runtimeOrConfigurationPathPattern.test(logicalPath)
    ) {
      throw new NativeVisualSourceError("NATIVE_TEMPLATE_SOURCE_UNSAFE");
    }
    let target: string;
    try {
      target = new TextDecoder("utf-8", { fatal: true })
        .decode(symlink.bytes)
        .trim();
    } catch (error) {
      throw new NativeVisualSourceError("NATIVE_TEMPLATE_SOURCE_UNSAFE", error);
    }
    const targetSegments = target.split("/");
    if (
      !target ||
      Buffer.byteLength(target, "utf8") > 240 ||
      target.startsWith("/") ||
      target.includes("\\") ||
      target.includes("\0") ||
      targetSegments.some(
        (segment) => !segment || segment === "." || segment === "..",
      )
    ) {
      throw new NativeVisualSourceError("NATIVE_TEMPLATE_SOURCE_UNSAFE");
    }
    const resolvedLogicalPath = path.posix.normalize(
      path.posix.join(path.posix.dirname(logicalPath), target),
    );
    const resolvedBasename = path.posix.basename(resolvedLogicalPath);
    if (
      !documentationNamePattern.test(resolvedBasename) ||
      runtimeOrConfigurationPathPattern.test(resolvedLogicalPath)
    ) {
      throw new NativeVisualSourceError("NATIVE_TEMPLATE_SOURCE_UNSAFE");
    }
    const targetArchivePath = archivePathByLogicalPath.get(resolvedLogicalPath);
    let targetRecord: (typeof records)[number] | undefined;
    if (targetArchivePath) {
      targetRecord = records.find(
        (record) => record.path === targetArchivePath,
      );
      if (
        !targetRecord ||
        targetRecord.bytes === null ||
        targetRecord.symlink
      ) {
        throw new NativeVisualSourceError("NATIVE_TEMPLATE_SOURCE_UNSAFE");
      }
    }
    const referenceNeedles = [
      logicalPath,
      basename,
      ...(targetRecord ? [] : [resolvedLogicalPath, resolvedBasename]),
    ];
    for (const record of fileRecords) {
      if (
        record.symlink ||
        !referenceTextPathPattern.test(
          logicalPathByArchivePath.get(record.path)!,
        )
      ) {
        continue;
      }
      let text: string;
      try {
        text = new TextDecoder("utf-8", { fatal: true }).decode(record.bytes);
      } catch {
        continue;
      }
      if (referenceNeedles.some((needle) => text.includes(needle))) {
        throw new NativeVisualSourceError("NATIVE_TEMPLATE_SOURCE_UNSAFE");
      }
    }
  }
  let providerArchive = archive;
  if (symlinks.length > 0) {
    const repacked = new JSZip();
    for (const record of fileRecords
      .filter((candidate) => !candidate.symlink)
      .sort((left, right) => left.path.localeCompare(right.path))) {
      repacked.file(record.path, record.bytes, zipFileOptions());
    }
    providerArchive = await repacked.generateAsync({
      type: "nodebuffer",
      compression: "DEFLATE",
      compressionOptions: { level: 9 },
      platform: "UNIX",
    });
    if (
      providerArchive.length < 1 ||
      providerArchive.length > NATIVE_TEMPLATE_PROVIDER_ARCHIVE_MAX_BYTES
    ) {
      throw new NativeVisualSourceError("NATIVE_TEMPLATE_ARCHIVE_INVALID");
    }
  }
  const retainedLogicalPaths = fileRecords
    .filter((record) => !record.symlink)
    .map((record) => logicalPathByArchivePath.get(record.path)!);
  return {
    providerArchive,
    providerArchiveSha256: sha256(providerArchive),
    paths: retainedLogicalPaths,
    styleSignalFiles: fileRecords
      .filter((record) => !record.symlink)
      .map((record) => ({
        path: logicalPathByArchivePath.get(record.path)!,
        bytes: record.bytes,
        symlink: false,
      })),
  };
}

function opaqueTemplateEntrypoint(input: {
  paths: readonly string[];
  slug: string;
  sourceSubdirectory?: string | null;
}) {
  const pathMap = new Map(
    input.paths.map((filename) => [filename, Buffer.alloc(0)]),
  );
  const registryEntrypoint = findRegistryTemplateEntrypoint(
    pathMap,
    input.slug,
  );
  if (registryEntrypoint) {
    return {
      framework: "next_static" as const,
      entrypoint: registryEntrypoint,
    };
  }
  const sourceSubdirectory = normalizedTemplateRootHint(
    input.sourceSubdirectory,
  );
  const scoped = sourceSubdirectory
    ? input.paths.filter(
        (filename) =>
          filename === sourceSubdirectory ||
          filename.startsWith(`${sourceSubdirectory}/`),
      )
    : [...input.paths];
  const choose = (suffixes: readonly string[]) => {
    for (const suffix of suffixes) {
      const matched = scoped
        .filter(
          (filename) => filename === suffix || filename.endsWith(`/${suffix}`),
        )
        .sort(
          (left, right) =>
            left.split("/").length - right.split("/").length ||
            left.localeCompare(right),
        )[0];
      if (matched) return matched;
    }
    return null;
  };
  const nextEntrypoint = choose([
    "app/page.tsx",
    "app/page.jsx",
    "src/app/page.tsx",
    "src/app/page.jsx",
    "pages/index.tsx",
    "pages/index.jsx",
    "src/pages/index.tsx",
    "src/pages/index.jsx",
  ]);
  if (nextEntrypoint) {
    return { framework: "next_static" as const, entrypoint: nextEntrypoint };
  }
  const viteEntrypoint = choose([
    "src/main.tsx",
    "src/main.jsx",
    "src/App.tsx",
    "src/App.jsx",
  ]);
  return {
    framework: "vite_react" as const,
    // This is an immutable selection coordinate, not an instruction to execute
    // the archive during candidate generation. Manus receives the entire ZIP
    // and returns the normalized, buildable source through the existing hard
    // safety/compile boundary.
    entrypoint: viteEntrypoint ?? "package.json",
  };
}

async function createProviderTemplateSourceArchive(input: {
  manifest: ProviderTemplateSourceManifestV1;
  providerArchive: Buffer;
}) {
  const manifest = providerTemplateSourceManifestV1Schema.parse(input.manifest);
  if (sha256(input.providerArchive) !== manifest.providerArchiveSha256) {
    throw new NativeVisualSourceError("V6_PROVIDER_ARCHIVE_HASH_MISMATCH");
  }
  const zip = new JSZip();
  zip.file(
    V6_PROVIDER_SOURCE_MANIFEST_PATH,
    canonicalJson(manifest),
    zipFileOptions(),
  );
  zip.file(V6_PROVIDER_SOURCE_ARCHIVE_PATH, input.providerArchive, {
    ...zipFileOptions(),
    compression: "STORE",
  });
  const bytes = await zip.generateAsync({
    type: "nodebuffer",
    compression: "DEFLATE",
    compressionOptions: { level: 9 },
    platform: "UNIX",
  });
  assertVisualSelectionBundleV6SourceArchiveSize(bytes);
  return bytes;
}

async function readProviderTemplateSourceArchive(bytes: Buffer) {
  assertVisualSelectionBundleV6SourceArchiveSize(bytes);
  let zip: JSZip;
  try {
    zip = await JSZip.loadAsync(bytes, {
      checkCRC32: true,
      createFolders: false,
    });
  } catch (error) {
    throw new NativeVisualSourceError(
      "V6_PROVIDER_SOURCE_ARCHIVE_INVALID",
      error,
    );
  }
  const entries = Object.values(zip.files) as BoundedZipEntry[];
  const expected = new Set([
    V6_PROVIDER_SOURCE_MANIFEST_PATH,
    V6_PROVIDER_SOURCE_ARCHIVE_PATH,
  ]);
  if (
    entries.length !== expected.size ||
    entries.some(
      (entry) =>
        entry.dir ||
        zipEntryIsSymlink(entry) ||
        (entry.unsafeOriginalName ?? entry.name) !== entry.name ||
        !expected.has(entry.name),
    )
  ) {
    throw new NativeVisualSourceError("V6_PROVIDER_SOURCE_ARCHIVE_INVALID");
  }
  const manifestEntry = zip.file(V6_PROVIDER_SOURCE_MANIFEST_PATH);
  const providerEntry = zip.file(V6_PROVIDER_SOURCE_ARCHIVE_PATH);
  if (!manifestEntry || !providerEntry) {
    throw new NativeVisualSourceError("V6_PROVIDER_SOURCE_ARCHIVE_INVALID");
  }
  const manifestText = await manifestEntry.async("string");
  if (Buffer.byteLength(manifestText, "utf8") > 32_000) {
    throw new NativeVisualSourceError("V6_PROVIDER_SOURCE_MANIFEST_INVALID");
  }
  let manifestValue: unknown;
  try {
    manifestValue = JSON.parse(manifestText);
  } catch (error) {
    throw new NativeVisualSourceError(
      "V6_PROVIDER_SOURCE_MANIFEST_INVALID",
      error,
    );
  }
  const manifest = providerTemplateSourceManifestV1Schema.parse(manifestValue);
  const declared = Number(
    (providerEntry as BoundedZipEntry)._data?.uncompressedSize ?? 0,
  );
  if (
    Number.isFinite(declared) &&
    declared > NATIVE_TEMPLATE_PROVIDER_ARCHIVE_MAX_BYTES
  ) {
    throw new NativeVisualSourceError("V6_PROVIDER_SOURCE_ARCHIVE_INVALID");
  }
  const providerArchive = await providerEntry.async("nodebuffer");
  const inspected = await inspectOpaqueProviderTemplateArchive({
    archive: providerArchive,
    expectedSha256: manifest.providerArchiveSha256,
  });
  const expectedSourceTreeSha256 = canonicalSha256({
    schemaVersion: 1,
    sourceFormat: manifest.sourceFormat,
    providerTemplateId: manifest.providerTemplateId,
    providerSlug: manifest.providerSlug,
    providerVersion: manifest.providerVersion,
    sourceSubdirectory: manifest.sourceSubdirectory,
    framework: manifest.framework,
    entrypoint: manifest.entrypoint,
    providerArchiveSha256: inspected.providerArchiveSha256,
  });
  if (expectedSourceTreeSha256 !== manifest.sourceTreeSha256) {
    throw new NativeVisualSourceError("V6_PROVIDER_SOURCE_COORDINATE_MISMATCH");
  }
  return { manifest, providerArchive };
}

async function serveDirectory(root: string) {
  const server = createServer(async (request, response) => {
    try {
      const url = new URL(request.url ?? "/", "http://127.0.0.1");
      const decoded = decodeURIComponent(url.pathname);
      if (
        decoded.includes("\\") ||
        decoded.includes("\0") ||
        decoded.split("/").some((part) => part === "..")
      ) {
        response.writeHead(400).end();
        return;
      }
      const relative = decoded.replace(/^\/+|\/+$/gu, "");
      const filename = path.join(root, relative || "index.html");
      const body = await readFile(filename).catch(() => null);
      if (!body) {
        response.writeHead(404).end();
        return;
      }
      const extension = path.extname(filename);
      const mime =
        extension === ".html"
          ? "text/html; charset=utf-8"
          : extension === ".css"
            ? "text/css; charset=utf-8"
            : extension === ".js"
              ? "text/javascript; charset=utf-8"
              : extension === ".svg"
                ? "image/svg+xml"
                : extension === ".png"
                  ? "image/png"
                  : "application/octet-stream";
      response.writeHead(200, {
        "Content-Type": mime,
        "Content-Length": body.length,
        "Cache-Control": "no-store",
        "Content-Security-Policy":
          "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'none'; frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'",
      });
      response.end(body);
    } catch {
      response.writeHead(400).end();
    }
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string")
    throw new NativeVisualSourceError("NATIVE_PREVIEW_SERVER_FAILED");
  return { server, origin: `http://127.0.0.1:${address.port}` };
}

type NativePreviewRuntimeFailureCode = "NATIVE_PREVIEW_PAGE_ERROR";

async function assertNativePreviewRendered(
  page: Page,
  runtimeFailureCodes: ReadonlySet<NativePreviewRuntimeFailureCode>,
) {
  await page.waitForTimeout(250);
  if (runtimeFailureCodes.size > 0) {
    throw new NativeVisualSourceError("NATIVE_PREVIEW_RENDER_FAILED");
  }
  const rootState = await page.evaluate(() => {
    const root = document.querySelector("#root");
    if (!root) {
      return {
        exists: false,
        hasContent: false,
        hasLayout: false,
        hasVisibleContent: false,
      };
    }
    const visible = (element: Element) => {
      const bounds = element.getBoundingClientRect();
      if (bounds.width <= 0 || bounds.height <= 0) return false;
      let current: Element | null = element;
      while (current) {
        const style = window.getComputedStyle(current);
        if (
          style.display === "none" ||
          style.visibility === "hidden" ||
          style.contentVisibility === "hidden" ||
          Number.parseFloat(style.opacity) === 0
        ) {
          return false;
        }
        current = current.parentElement;
      }
      return true;
    };
    const rootBounds = root.getBoundingClientRect();
    const hasDirectText = [...root.childNodes].some(
      (node) =>
        node.nodeType === Node.TEXT_NODE && Boolean(node.textContent?.trim()),
    );
    return {
      exists: true,
      hasContent: hasDirectText || root.children.length > 0,
      hasLayout: rootBounds.width > 0 && rootBounds.height > 0,
      hasVisibleContent:
        (hasDirectText && visible(root)) ||
        [...root.querySelectorAll("*")].some(visible),
    };
  });
  if (
    runtimeFailureCodes.size > 0 ||
    !rootState.exists ||
    !rootState.hasContent ||
    !rootState.hasLayout ||
    !rootState.hasVisibleContent
  ) {
    throw new NativeVisualSourceError("NATIVE_PREVIEW_RENDER_FAILED");
  }
}

export async function renderNativeReactSourcePreview(input: {
  sourceArchive: Buffer;
  signal: AbortSignal;
}) {
  if (input.signal.aborted) throw input.signal.reason;
  const archivedSource = await readNativeSourceArchive(input.sourceArchive);
  const archiveSha256 = sha256(input.sourceArchive);
  const validationToken = "frontmind-native-candidate-archive-validation";
  const validatedSource = await validateNativeReactSourceArchive({
    archive: input.sourceArchive,
    receipt: {
      operationToken: validationToken,
      baseSourceSha256: archiveSha256,
      archiveSha256,
      fileCount: archivedSource.files.length + 1,
    },
    expectedOperationToken: validationToken,
    expectedBaseSourceSha256: archiveSha256,
  });
  const root = await realpath(
    await mkdtemp(path.join(tmpdir(), "frontmind-21st-native-")),
  );
  const outputRoot = path.join(root, "dist");
  let server: ReturnType<typeof createServer> | null = null;
  let browser: Awaited<ReturnType<typeof chromium.launch>> | null = null;
  let renderTimer: ReturnType<typeof setTimeout> | null = null;
  let renderDeadlineExceeded = false;
  const abortBrowser = () => {
    void browser?.close().catch(() => undefined);
  };
  let runtimeStage: "compile" | "browser" | "render" = "compile";
  try {
    await compileValidatedNativeReactSource({
      root,
      source: validatedSource,
      timeoutMs: 60_000,
      abortSignal: input.signal,
    });
    if (input.signal.aborted) throw input.signal.reason;
    runtimeStage = "browser";
    const served = await serveDirectory(outputRoot);
    server = served.server;
    try {
      browser = await chromium.launch({
        headless: true,
        chromiumSandbox: false,
        timeout: 15_000,
        args: ["--disable-background-networking", "--disable-sync"],
        env: {
          HOME: root,
          LANG: "C.UTF-8",
          TZ: "UTC",
          PATH: path.dirname(process.execPath),
        },
      });
    } catch (error) {
      throw new NativeVisualSourceError(
        "NATIVE_PREVIEW_BROWSER_UNAVAILABLE",
        error,
      );
    }
    runtimeStage = "render";
    input.signal.addEventListener("abort", abortBrowser, { once: true });
    renderTimer = setTimeout(() => {
      renderDeadlineExceeded = true;
      abortBrowser();
    }, 30_000);
    const context = await browser.newContext({
      viewport: { width: 1440, height: 1000 },
      reducedMotion: "no-preference",
      serviceWorkers: "block",
    });
    const page = await context.newPage();
    const runtimeFailureCodes = new Set<NativePreviewRuntimeFailureCode>();
    let networkViolationDetected = false;
    page.on("pageerror", () => {
      runtimeFailureCodes.add("NATIVE_PREVIEW_PAGE_ERROR");
    });
    await page.exposeBinding("__frontmindNativePolicyViolation", () => {
      networkViolationDetected = true;
    });
    await page.addInitScript(() => {
      const scope = globalThis as typeof globalThis & {
        __frontmindNativePolicyViolation: () => Promise<void>;
      };
      document.addEventListener("securitypolicyviolation", (event) => {
        const blocked = event.blockedURI;
        if (
          /^(?:https?:)?\/\//iu.test(blocked) &&
          new URL(blocked, window.location.href).origin !==
            window.location.origin
        ) {
          void scope.__frontmindNativePolicyViolation();
        }
      });
    });
    await page.route("**/*", async (route) => {
      const url = new URL(route.request().url());
      if (url.origin === served.origin) await route.continue();
      else {
        networkViolationDetected = true;
        await route.abort("blockedbyclient");
      }
    });
    const response = await page.goto(served.origin, {
      waitUntil: "networkidle",
      timeout: 15_000,
    });
    if (!response?.ok())
      throw new NativeVisualSourceError("NATIVE_PREVIEW_ROUTE_FAILED");
    if (networkViolationDetected) {
      throw new NativeVisualSourceError("NATIVE_SOURCE_EXECUTION_UNSAFE");
    }
    await assertNativePreviewRendered(page, runtimeFailureCodes);
    if (networkViolationDetected) {
      throw new NativeVisualSourceError("NATIVE_SOURCE_EXECUTION_UNSAFE");
    }
    const screenshot = await page.screenshot({
      type: "png",
      fullPage: false,
      animations: "disabled",
      timeout: 10_000,
    });
    await context.close();
    return Buffer.from(screenshot);
  } catch (error) {
    if (error instanceof NativeVisualSourceError) throw error;
    if (renderDeadlineExceeded) {
      throw new NativeVisualSourceError("NATIVE_PREVIEW_RENDER_FAILED", error);
    }
    if (input.signal.aborted) {
      throw new NativeVisualSourceError(
        "NATIVE_SOURCE_DEADLINE_EXHAUSTED",
        error,
      );
    }
    if (error instanceof NativeReactBuildError) {
      if (
        error.code === "NATIVE_BUILD_ABORTED" ||
        error.code === "NATIVE_BUILD_TIMEOUT"
      ) {
        throw new NativeVisualSourceError(
          "NATIVE_SOURCE_DEADLINE_EXHAUSTED",
          error,
        );
      }
      if (error.code === "NATIVE_BUILD_DEPENDENCY_UNAVAILABLE") {
        throw new NativeVisualSourceError(
          "NATIVE_SOURCE_DEPENDENCY_UNAVAILABLE",
          error,
        );
      }
      if (error.code === "NATIVE_BUILD_RENDER_FAILED") {
        throw new NativeVisualSourceError(
          "NATIVE_PREVIEW_RENDER_FAILED",
          error,
        );
      }
    }
    throw new NativeVisualSourceError(
      runtimeStage === "render"
        ? "NATIVE_PREVIEW_RENDER_FAILED"
        : runtimeStage === "browser"
          ? "NATIVE_PREVIEW_BROWSER_UNAVAILABLE"
          : "NATIVE_SOURCE_COMPILE_FAILED",
      error,
    );
  } finally {
    if (renderTimer) clearTimeout(renderTimer);
    input.signal.removeEventListener("abort", abortBrowser);
    await browser?.close().catch(() => undefined);
    if (server?.listening)
      await new Promise<void>((resolve) => server!.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
  }
}

export async function prepareNativeVisualCandidate(input: {
  candidate: NormalizedTwentyFirstCandidate;
  payload: unknown;
  signal: AbortSignal;
  fetchRemoteAsset?: typeof fetchSafeVisualPreview;
  fetchRemoteStyleAsset?: FetchNativeTemplateStaticAsset;
  fetchRemoteRuntimeMedia?: FetchNativeTemplateRuntimeMedia;
}): Promise<PreparedNativeVisualCandidate> {
  const normalized = normalizeTwentyFirstNativeSource({
    candidate: input.candidate,
    payload: input.payload,
    allowStaticRemoteMedia: true,
  });
  const source = await mirrorNativeStaticMedia({
    source: normalized,
    signal: input.signal,
    fetchRemoteAsset: input.fetchRemoteAsset ?? fetchSafeVisualPreview,
    fetchRemoteStyleAsset:
      input.fetchRemoteStyleAsset ?? fetchSafeNativeTemplateStaticAsset,
    fetchRemoteRuntimeMedia:
      input.fetchRemoteRuntimeMedia ?? fetchSafeNativeTemplateRuntimeMedia,
  });
  const sourceArchive = await createNativeSourceArchive(source);
  const preview = await renderNativeReactSourcePreview({
    sourceArchive,
    signal: input.signal,
  });
  return {
    ...source,
    sourceArchive,
    sourceArchiveSha256: sha256(sourceArchive),
    preview,
    previewSha256: sha256(preview),
  };
}

async function renderedPreviewVisualSignals(preview: Buffer) {
  const stats = await sharp(preview, {
    failOn: "error",
    limitInputPixels: 20_000_000,
  })
    .stats()
    .catch((error) => {
      throw new NativeVisualSourceError("NATIVE_PREVIEW_RENDER_FAILED", error);
    });
  const channels = stats.channels.slice(0, 3);
  const brightness =
    channels.reduce((sum, channel) => sum + channel.mean, 0) /
    Math.max(1, channels.length);
  const contrast =
    channels.reduce((sum, channel) => sum + channel.stdev, 0) /
    Math.max(1, channels.length);
  return {
    dominantHex: `#${[stats.dominant.r, stats.dominant.g, stats.dominant.b]
      .map((value) => Math.round(value).toString(16).padStart(2, "0"))
      .join("")}`,
    brightness,
    contrast,
  };
}

/** Worker-facing V6 catalog boundary. Every admitted 2.7 Template keeps the
 * complete Provider ZIP as its immutable source input. FrontMind derives a
 * controlled build view from that exact ZIP, mirrors its static media, then
 * completes production build and browser checks. The Marketplace screenshot
 * is never substituted for build evidence, while Manus still receives the
 * complete original project rather than the host-only build closure. */
export async function prepareNativeTemplateCandidate(input: {
  templateId: string | number;
  slug: string;
  version: string | null;
  archive: Uint8Array;
  expectedArchiveSha256?: string;
  sourceSubdirectory?: string | null;
  previewUrl?: string | null;
  signal: AbortSignal;
  fetchRemoteAsset?: typeof fetchSafeVisualPreview;
  fetchRemoteStyleAsset?: FetchNativeTemplateStaticAsset;
  fetchRemoteRuntimeMedia?: FetchNativeTemplateRuntimeMedia;
  renderPreview?: typeof renderNativeReactSourcePreview;
}): Promise<PreparedNativeTemplateCandidate> {
  if (input.signal.aborted) throw input.signal.reason;
  const templateId = cleanTemplateCoordinate(
    input.templateId,
    "NATIVE_TEMPLATE_ID_INVALID",
  );
  const templateSlug = cleanTemplateCoordinate(
    input.slug,
    "NATIVE_TEMPLATE_SLUG_INVALID",
  );
  const providerVersion = cleanVersion(input.version);
  if (input.version !== null && !providerVersion) {
    throw new NativeVisualSourceError("NATIVE_TEMPLATE_VERSION_INVALID");
  }
  const downloadedProviderArchive = Buffer.from(input.archive);
  const inspected = await inspectOpaqueProviderTemplateArchive({
    archive: downloadedProviderArchive,
    expectedSha256: input.expectedArchiveSha256,
  });
  const providerArchive = inspected.providerArchive;
  // 2.7 freezes the complete project. A ZIP that required symlink removal is
  // not that exact safe project and therefore cannot enter the candidate pool.
  if (!providerArchive.equals(downloadedProviderArchive)) {
    throw new NativeVisualSourceError("NATIVE_TEMPLATE_SOURCE_UNSAFE");
  }
  const sourceSubdirectory = normalizedTemplateRootHint(
    input.sourceSubdirectory,
  );
  const coordinate = opaqueTemplateEntrypoint({
    paths: inspected.paths,
    slug: templateSlug,
    sourceSubdirectory,
  });
  const sourceTreeSha256 = canonicalSha256({
    schemaVersion: 1,
    sourceFormat: "provider_archive_v1",
    providerTemplateId: templateId,
    providerSlug: templateSlug,
    providerVersion,
    sourceSubdirectory,
    framework: coordinate.framework,
    entrypoint: coordinate.entrypoint,
    providerArchiveSha256: inspected.providerArchiveSha256,
  });
  const normalized = await normalizeTwentyFirstNativeTemplateArchive({
    templateId,
    slug: templateSlug,
    version: providerVersion,
    archive: providerArchive,
    expectedArchiveSha256: inspected.providerArchiveSha256,
    sourceSubdirectory,
  });
  const source = await mirrorNativeStaticMedia({
    source: normalized,
    signal: input.signal,
    fetchRemoteAsset: input.fetchRemoteAsset ?? fetchSafeVisualPreview,
    fetchRemoteStyleAsset:
      input.fetchRemoteStyleAsset ?? fetchSafeNativeTemplateStaticAsset,
    fetchRemoteRuntimeMedia:
      input.fetchRemoteRuntimeMedia ?? fetchSafeNativeTemplateRuntimeMedia,
  });
  const buildArchive = await createNativeSourceArchive(source);
  const preview = await (input.renderPreview ?? renderNativeReactSourcePreview)(
    {
      sourceArchive: buildArchive,
      signal: input.signal,
    },
  );
  const styleSignals = deriveOpaqueTemplateStyleSignals(
    source.files.map((file) => ({ ...file, symlink: false })),
    {
      sourceSubdirectory: null,
      entrypoint: source.entrypoint,
    },
  );
  const previewSignals = await renderedPreviewVisualSignals(preview);
  const previewSha256 = sha256(preview);
  const styleTokens = visualCandidateStyleTokensV1Schema.parse({
    schemaVersion: 1,
    derivation: "normalized-preview-bounded-source-v1",
    previewSha256,
    sourceTreeSha256,
    dominantHex: previewSignals.dominantHex.toLowerCase(),
    canvasTone: previewSignals.brightness < 128 ? "dark" : "light",
    contrast:
      previewSignals.contrast >= 60
        ? "high"
        : previewSignals.contrast < 35
          ? "low"
          : "balanced",
    typeSystem: styleSignals.typeSystem,
    density: styleSignals.density,
  });
  const sourceArchive = await createProviderTemplateSourceArchive({
    manifest: {
      schemaVersion: 1,
      sourceFormat: "provider_archive_v1",
      providerTemplateId: templateId,
      providerSlug: templateSlug,
      providerVersion,
      sourceSubdirectory,
      framework: coordinate.framework,
      sourceDirectory: NATIVE_SOURCE_DIRECTORY,
      entrypoint: coordinate.entrypoint,
      providerArchiveSha256: inspected.providerArchiveSha256,
      sourceTreeSha256,
    },
    providerArchive,
  });
  return {
    providerItemKey: `t:${templateId}:${templateSlug}`,
    providerVersion,
    entrypoint: coordinate.entrypoint,
    demoEntrypoint: coordinate.entrypoint,
    dependencies: [],
    htmlEntrypoint: CONTROLLED_HTML_ENTRYPOINT,
    appEntrypoint: CONTROLLED_APP_ENTRYPOINT,
    files: [],
    sourceTreeSha256,
    templateId,
    templateSlug,
    framework: coordinate.framework,
    sourceDirectory: NATIVE_SOURCE_DIRECTORY,
    sourceFormat: "provider_archive_v1",
    sourceArchive,
    sourceArchiveSha256: sha256(sourceArchive),
    preview,
    previewSha256,
    styleTokens,
  };
}

/** Catalog admission boundary. Unlike the V7 raw-provider attachment path,
 * this returns the exact mirrored, controlled Vite archive that passed the
 * FrontMind normalizer. Callers must still validate and materialize this
 * immutable archive before marking a catalog entry admitted. */
export async function prepareStaticTemplateExecutionSource(input: {
  templateId: string | number;
  slug: string;
  version: string | null;
  archive: Uint8Array;
  expectedArchiveSha256: string;
  sourceSubdirectory?: string | null;
  signal: AbortSignal;
  fetchRemoteAsset?: typeof fetchSafeVisualPreview;
  fetchRemoteStyleAsset?: FetchNativeTemplateStaticAsset;
  fetchRemoteRuntimeMedia?: FetchNativeTemplateRuntimeMedia;
  frozenRuntimeMedia?: readonly FrozenNativeTemplateRuntimeMedia[];
}) {
  const normalized = await normalizeTwentyFirstNativeTemplateArchive({
    templateId: input.templateId,
    slug: input.slug,
    version: input.version,
    archive: input.archive,
    expectedArchiveSha256: input.expectedArchiveSha256,
    sourceSubdirectory: input.sourceSubdirectory,
  });
  const mirrored = await mirrorNativeStaticMedia({
    source: normalized,
    signal: input.signal,
    fetchRemoteAsset: input.fetchRemoteAsset ?? fetchSafeVisualPreview,
    fetchRemoteStyleAsset:
      input.fetchRemoteStyleAsset ?? fetchSafeNativeTemplateStaticAsset,
    fetchRemoteRuntimeMedia:
      input.fetchRemoteRuntimeMedia ?? fetchSafeNativeTemplateRuntimeMedia,
    frozenRuntimeMedia: input.frozenRuntimeMedia
      ? new Map(
          input.frozenRuntimeMedia.map((asset) => [
            asset.url,
            {
              kind: asset.kind,
              sha256: asset.sha256,
              bytes: asset.bytes,
            },
          ]),
        )
      : undefined,
  });
  const shellFiles = new Map(
    NATIVE_RUNTIME_EXECUTION_SHELL_V1.files.map((file) => [
      file.path,
      Buffer.from(file.text, "utf8"),
    ]),
  );
  const replacedPaths = new Set<string>([
    ...shellFiles.keys(),
    NATIVE_RUNTIME_ROUTE_MODULE,
    NATIVE_RUNTIME_CONTRACT_FILENAME,
    NATIVE_RUNTIME_EXECUTION_SHELL_FILENAME,
  ]);
  const retainedFiles = mirrored.files.filter(
    (file) => !replacedPaths.has(file.path),
  );
  const stylesheetImports = retainedFiles
    .filter((file) => file.path.endsWith(".css"))
    .sort((left, right) => left.path.localeCompare(right.path))
    .map(
      (file) =>
        `import ${JSON.stringify(
          relativeSourceImport(NATIVE_RUNTIME_ROUTE_MODULE, file.path, false),
        )};`,
    );
  const routeModule = Buffer.from(
    [
      ...stylesheetImports,
      `import NativeTemplate from ${JSON.stringify(
        relativeSourceImport(
          NATIVE_RUNTIME_ROUTE_MODULE,
          mirrored.demoEntrypoint,
        ),
      )};`,
      "",
      'export const FRONTMIND_ROUTE_PATHS = ["/"] as const;',
      "",
      "export default function FrontMindRoutes() {",
      "  return <NativeTemplate />;",
      "}",
      "",
    ].join("\n"),
    "utf8",
  );
  const dependencies = [...mirrored.dependencies]
    .sort((left, right) => left.name.localeCompare(right.name))
    .map((dependency) => ({
      name: dependency.name,
      installedVersion: installedNativeSourceDependencyVersion(dependency.name),
    }));
  const packageJson = Buffer.from(
    `${canonicalJson({
      name: "frontmind-native-site",
      private: true,
      version: "1.0.0",
      scripts: { build: "vite build" },
      dependencies: Object.fromEntries(
        dependencies.map((dependency) => [
          dependency.name,
          dependency.installedVersion,
        ]),
      ),
    })}\n`,
    "utf8",
  );
  const files: NativeSourceFile[] = [
    ...retainedFiles,
    { path: "package.json", bytes: packageJson },
    ...[...shellFiles]
      .filter(([pathname]) => pathname !== "package.json")
      .map(([pathname, bytes]) => ({ path: pathname, bytes })),
    { path: NATIVE_RUNTIME_ROUTE_MODULE, bytes: routeModule },
    {
      path: NATIVE_RUNTIME_CONTRACT_FILENAME,
      bytes: Buffer.from(NATIVE_RUNTIME_CONTRACT_V1_BYTES),
    },
    {
      path: NATIVE_RUNTIME_EXECUTION_SHELL_FILENAME,
      bytes: Buffer.from(NATIVE_RUNTIME_EXECUTION_SHELL_V1_BYTES),
    },
  ].sort((left, right) => left.path.localeCompare(right.path));
  const executionSource: NormalizedTwentyFirstNativeSource = {
    ...mirrored,
    entrypoint: NATIVE_RUNTIME_ROUTE_MODULE,
    demoEntrypoint: NATIVE_RUNTIME_ROUTE_MODULE,
    dependencies,
    files,
    sourceTreeSha256: nativeSourceTreeSha256(files),
  };
  const sourceArchive = await createNativeSourceArchive(executionSource);
  return {
    framework: "vite_react" as const,
    sourceArchive,
    sourceArchiveSha256: sha256(sourceArchive),
    sourceTreeSha256: executionSource.sourceTreeSha256,
    files: executionSource.files,
  };
}

/** Exact 2.5 V6 preparation retained for immutable replay. New 2.7
 * operations must use prepareNativeTemplateCandidate above so their previews
 * are produced by the frozen source build rather than this Marketplace image. */
export async function prepareLegacyNativeTemplateCandidate(input: {
  templateId: string | number;
  slug: string;
  version: string | null;
  archive: Uint8Array;
  expectedArchiveSha256?: string;
  sourceSubdirectory?: string | null;
  previewUrl?: string | null;
  signal: AbortSignal;
  fetchRemoteAsset?: typeof fetchSafeVisualPreview;
  fetchRemoteStyleAsset?: FetchNativeTemplateStaticAsset;
}): Promise<PreparedNativeTemplateCandidate> {
  if (input.signal.aborted) throw input.signal.reason;
  if (!input.previewUrl) {
    throw new NativeVisualSourceError("NATIVE_TEMPLATE_PREVIEW_UNAVAILABLE");
  }
  const templateId = cleanTemplateCoordinate(
    input.templateId,
    "NATIVE_TEMPLATE_ID_INVALID",
  );
  const templateSlug = cleanTemplateCoordinate(
    input.slug,
    "NATIVE_TEMPLATE_SLUG_INVALID",
  );
  const providerVersion = cleanVersion(input.version);
  if (input.version !== null && !providerVersion) {
    throw new NativeVisualSourceError("NATIVE_TEMPLATE_VERSION_INVALID");
  }
  const downloadedProviderArchive = Buffer.from(input.archive);
  const inspected = await inspectOpaqueProviderTemplateArchive({
    archive: downloadedProviderArchive,
    expectedSha256: input.expectedArchiveSha256,
  });
  const providerArchive = inspected.providerArchive;
  const sourceSubdirectory = normalizedTemplateRootHint(
    input.sourceSubdirectory,
  );
  const coordinate = opaqueTemplateEntrypoint({
    paths: inspected.paths,
    slug: templateSlug,
    sourceSubdirectory,
  });
  const sourceTreeSha256 = canonicalSha256({
    schemaVersion: 1,
    sourceFormat: "provider_archive_v1",
    providerTemplateId: templateId,
    providerSlug: templateSlug,
    providerVersion,
    sourceSubdirectory,
    framework: coordinate.framework,
    entrypoint: coordinate.entrypoint,
    providerArchiveSha256: inspected.providerArchiveSha256,
  });
  const styleSignals = deriveOpaqueTemplateStyleSignals(
    inspected.styleSignalFiles,
    {
      sourceSubdirectory,
      entrypoint: coordinate.entrypoint,
    },
  );
  const sourceArchive = await createProviderTemplateSourceArchive({
    manifest: {
      schemaVersion: 1,
      sourceFormat: "provider_archive_v1",
      providerTemplateId: templateId,
      providerSlug: templateSlug,
      providerVersion,
      sourceSubdirectory,
      framework: coordinate.framework,
      sourceDirectory: NATIVE_SOURCE_DIRECTORY,
      entrypoint: coordinate.entrypoint,
      providerArchiveSha256: inspected.providerArchiveSha256,
      sourceTreeSha256,
    },
    providerArchive,
  });
  const fetchedPreview = await (
    input.fetchRemoteAsset ?? fetchSafeVisualPreview
  )({
    url: input.previewUrl,
    signal: input.signal,
  });
  const preview = fetchedPreview.buffer;
  const previewSha256 = sha256(preview);
  const styleTokens = visualCandidateStyleTokensV1Schema.parse({
    schemaVersion: 1,
    derivation: "normalized-preview-bounded-source-v1",
    previewSha256,
    sourceTreeSha256,
    dominantHex: fetchedPreview.visualSignals.dominantHex.toLowerCase(),
    canvasTone:
      fetchedPreview.visualSignals.brightness < 128 ? "dark" : "light",
    contrast:
      fetchedPreview.visualSignals.contrast >= 60
        ? "high"
        : fetchedPreview.visualSignals.contrast < 35
          ? "low"
          : "balanced",
    typeSystem: styleSignals.typeSystem,
    density: styleSignals.density,
  });
  return {
    providerItemKey: `t:${templateId}:${templateSlug}`,
    providerVersion,
    entrypoint: coordinate.entrypoint,
    demoEntrypoint: coordinate.entrypoint,
    dependencies: [],
    htmlEntrypoint: CONTROLLED_HTML_ENTRYPOINT,
    appEntrypoint: CONTROLLED_APP_ENTRYPOINT,
    files: [],
    sourceTreeSha256,
    templateId,
    templateSlug,
    framework: coordinate.framework,
    sourceDirectory: NATIVE_SOURCE_DIRECTORY,
    sourceFormat: "provider_archive_v1",
    sourceArchive,
    sourceArchiveSha256: sha256(sourceArchive),
    preview,
    previewSha256,
    styleTokens,
  };
}

export async function createVisualSelectionBundleV5Artifact(input: {
  bundle: VisualSelectionBundleV5;
  sourceArchives: ReadonlyMap<string, Buffer>;
}) {
  const bundle = visualSelectionBundleV5Schema.parse(input.bundle);
  const zip = new JSZip();
  zip.file(V5_SELECTION_MANIFEST_PATH, canonicalJson(bundle), zipFileOptions());
  for (const candidate of bundle.candidates) {
    const archive = input.sourceArchives.get(candidate.id);
    if (!archive || sha256(archive) !== candidate.sourceArchiveSha256) {
      throw new NativeVisualSourceError("V5_SOURCE_ARCHIVE_HASH_MISMATCH");
    }
    const inspected = await readNativeSourceArchive(archive);
    if (
      inspected.manifest.sourceTreeSha256 !== candidate.sourceTreeSha256 ||
      inspected.manifest.entrypoint !== candidate.entrypoint ||
      inspected.manifest.demoEntrypoint !== candidate.demoEntrypoint ||
      inspected.manifest.providerItemKey !== candidate.providerItemKey
    ) {
      throw new NativeVisualSourceError("V5_SOURCE_COORDINATE_MISMATCH");
    }
    zip.file(candidate.sourceArchivePath, archive, {
      ...zipFileOptions(),
      compression: "STORE",
    });
  }
  const bytes = await zip.generateAsync({
    type: "nodebuffer",
    compression: "DEFLATE",
    compressionOptions: { level: 9 },
    platform: "UNIX",
  });
  if (bytes.length > VISUAL_SELECTION_BUNDLE_V5_MAX_BYTES) {
    throw new NativeVisualSourceError("V5_SELECTION_BUNDLE_TOO_LARGE");
  }
  return bytes;
}

function expectedV6ProviderItemKey(candidate: {
  providerTemplateId: string;
  providerSlug: string;
}) {
  return `t:${candidate.providerTemplateId}:${candidate.providerSlug}`;
}

async function inspectV6SourceCoordinates(input: {
  candidate: VisualSelectionBundleV6["candidates"][number];
  archive: Buffer;
}) {
  const { candidate, archive } = input;
  if (candidate.sourceFormat === "provider_archive_v1") {
    const source = await readProviderTemplateSourceArchive(archive);
    const { manifest } = source;
    if (
      manifest.providerTemplateId !== candidate.providerTemplateId ||
      manifest.providerSlug !== candidate.providerSlug ||
      manifest.providerVersion !== candidate.providerVersion ||
      manifest.framework !== candidate.framework ||
      manifest.sourceDirectory !== candidate.sourceDirectory ||
      manifest.entrypoint !== candidate.entrypoint ||
      manifest.sourceTreeSha256 !== candidate.sourceTreeSha256
    ) {
      throw new NativeVisualSourceError("V6_SOURCE_COORDINATE_MISMATCH");
    }
    return { sourceFormat: "provider_archive_v1" as const, ...source };
  }
  const source = await readNativeSourceArchive(archive);
  const nextStaticEntrypoint =
    /^(?:src\/)?app\/(?:\([a-zA-Z0-9_-]+\)\/)*page\.[cm]?[jt]sx?$/u.test(
      candidate.entrypoint,
    ) || /^(?:src\/)?pages\/index\.[cm]?[jt]sx?$/u.test(candidate.entrypoint);
  const entrypointIsFrameworkCompatible =
    candidate.framework === "next_static"
      ? nextStaticEntrypoint
      : !nextStaticEntrypoint;
  if (
    candidate.sourceDirectory !== NATIVE_SOURCE_DIRECTORY ||
    !entrypointIsFrameworkCompatible ||
    source.manifest.sourceTreeSha256 !== candidate.sourceTreeSha256 ||
    source.manifest.entrypoint !== candidate.entrypoint ||
    source.manifest.providerVersion !== candidate.providerVersion ||
    source.manifest.providerItemKey !== expectedV6ProviderItemKey(candidate)
  ) {
    throw new NativeVisualSourceError("V6_SOURCE_COORDINATE_MISMATCH");
  }
  return { sourceFormat: "normalized_v1" as const, ...source };
}

export async function createVisualSelectionBundleV6Artifact(input: {
  bundle: VisualSelectionBundleV6;
  sourceArchives: ReadonlyMap<string, Buffer>;
}) {
  const bundle = visualSelectionBundleV6Schema.parse(input.bundle);
  const zip = new JSZip();
  zip.file(V6_SELECTION_MANIFEST_PATH, canonicalJson(bundle), zipFileOptions());
  for (const candidate of bundle.candidates) {
    const archive =
      input.sourceArchives.get(candidate.sampleId) ??
      input.sourceArchives.get(candidate.id);
    if (!archive || sha256(archive) !== candidate.sourceArchiveSha256) {
      throw new NativeVisualSourceError("V6_SOURCE_ARCHIVE_HASH_MISMATCH");
    }
    assertVisualSelectionBundleV6SourceArchiveSize(archive);
    await inspectV6SourceCoordinates({ candidate, archive });
    zip.file(candidate.sourceArchivePath, archive, {
      ...zipFileOptions(),
      compression: "STORE",
    });
  }
  const bytes = await zip.generateAsync({
    type: "nodebuffer",
    compression: "DEFLATE",
    compressionOptions: { level: 9 },
    platform: "UNIX",
  });
  if (bytes.length > VISUAL_SELECTION_BUNDLE_V6_MAX_BYTES) {
    throw new NativeVisualSourceError("V6_SELECTION_BUNDLE_TOO_LARGE");
  }
  return bytes;
}

export function createVisualSelectionBundleV7Artifact(
  input: VisualSelectionBundleV7,
) {
  const bundle = visualSelectionBundleV7Schema.parse(input);
  const bytes = Buffer.from(`${canonicalJson(bundle)}\n`, "utf8");
  if (bytes.length < 1 || bytes.length > VISUAL_SELECTION_BUNDLE_V7_MAX_BYTES) {
    throw new NativeVisualSourceError("V7_SELECTION_BUNDLE_SIZE_INVALID");
  }
  return bytes;
}

export function readVisualSelectionBundleV7Artifact(bytes: Buffer) {
  if (bytes.length < 1 || bytes.length > VISUAL_SELECTION_BUNDLE_V7_MAX_BYTES) {
    throw new NativeVisualSourceError("V7_SELECTION_BUNDLE_SIZE_INVALID");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(bytes.toString("utf8"));
  } catch {
    throw new NativeVisualSourceError("V7_SELECTION_MANIFEST_INVALID");
  }
  return visualSelectionBundleV7Schema.parse(parsed);
}

export async function readVisualSelectionBundleArtifact(bytes: Buffer) {
  if (bytes.length < 1 || bytes.length > VISUAL_SELECTION_BUNDLE_V6_MAX_BYTES) {
    throw new NativeVisualSourceError("VISUAL_SELECTION_BUNDLE_SIZE_INVALID");
  }
  const zip = await JSZip.loadAsync(bytes, {
    checkCRC32: true,
    createFolders: false,
  });
  const entries = Object.values(zip.files) as BoundedZipEntry[];
  if (
    entries.some(
      (entry) =>
        entry.dir ||
        zipEntryIsSymlink(entry) ||
        (entry.unsafeOriginalName ?? entry.name) !== entry.name,
    )
  ) {
    throw new NativeVisualSourceError("VISUAL_SELECTION_BUNDLE_PATH_UNSAFE");
  }
  const v6Manifest = zip.file(V6_SELECTION_MANIFEST_PATH);
  const v5Manifest = zip.file(V5_SELECTION_MANIFEST_PATH);
  if (Boolean(v6Manifest) === Boolean(v5Manifest)) {
    throw new NativeVisualSourceError("VISUAL_SELECTION_MANIFEST_MISSING");
  }
  const manifestEntry = v6Manifest ?? v5Manifest;
  if (!manifestEntry)
    throw new NativeVisualSourceError("VISUAL_SELECTION_MANIFEST_MISSING");
  const manifestText = await manifestEntry.async("string");
  if (Buffer.byteLength(manifestText, "utf8") > 512_000) {
    throw new NativeVisualSourceError("VISUAL_SELECTION_MANIFEST_TOO_LARGE");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(manifestText);
  } catch {
    throw new NativeVisualSourceError("VISUAL_SELECTION_MANIFEST_INVALID");
  }
  const bundle = v6Manifest
    ? visualSelectionBundleV6Schema.parse(parsed)
    : visualSelectionBundleV5Schema.parse(parsed);
  if (
    bundle.schemaVersion === 5 &&
    bytes.length > VISUAL_SELECTION_BUNDLE_V5_MAX_BYTES
  ) {
    throw new NativeVisualSourceError("V5_SELECTION_BUNDLE_SIZE_INVALID");
  }
  const manifestPath =
    bundle.schemaVersion === 6
      ? V6_SELECTION_MANIFEST_PATH
      : V5_SELECTION_MANIFEST_PATH;
  const expected = new Set([
    manifestPath,
    ...bundle.candidates.map((candidate) => candidate.sourceArchivePath),
  ]);
  if (
    entries.length !== expected.size ||
    entries.some((entry) => !expected.has(entry.name))
  ) {
    throw new NativeVisualSourceError(
      "VISUAL_SELECTION_BUNDLE_UNEXPECTED_ENTRY",
    );
  }
  const archives = new Map<string, Buffer>();
  for (const candidate of bundle.candidates) {
    const entry = zip.file(candidate.sourceArchivePath);
    if (!entry)
      throw new NativeVisualSourceError("VISUAL_SOURCE_ARCHIVE_MISSING");
    const declared = Number(
      (entry as BoundedZipEntry)._data?.uncompressedSize ?? 0,
    );
    const archiveLimit =
      bundle.schemaVersion === 6
        ? VISUAL_SELECTION_BUNDLE_V6_SOURCE_ARCHIVE_MAX_BYTES
        : NATIVE_VISUAL_SOURCE_ARCHIVE_MAX_BYTES;
    if (Number.isFinite(declared) && declared > archiveLimit) {
      throw new NativeVisualSourceError("VISUAL_SOURCE_ARCHIVE_TOO_LARGE");
    }
    const archive = await entry.async("nodebuffer");
    if (bundle.schemaVersion === 6) {
      assertVisualSelectionBundleV6SourceArchiveSize(archive);
    }
    if (sha256(archive) !== candidate.sourceArchiveSha256) {
      throw new NativeVisualSourceError(
        bundle.schemaVersion === 6
          ? "V6_SOURCE_ARCHIVE_HASH_MISMATCH"
          : "V5_SOURCE_ARCHIVE_HASH_MISMATCH",
      );
    }
    if (bundle.schemaVersion === 6) {
      if (!("providerTemplateId" in candidate)) {
        throw new NativeVisualSourceError("VISUAL_SOURCE_COORDINATE_MISMATCH");
      }
      await inspectV6SourceCoordinates({ candidate, archive });
    } else {
      const source = await readNativeSourceArchive(archive);
      if (!("providerItemKey" in candidate)) {
        throw new NativeVisualSourceError("VISUAL_SOURCE_COORDINATE_MISMATCH");
      }
      if (
        source.manifest.sourceTreeSha256 !== candidate.sourceTreeSha256 ||
        source.manifest.entrypoint !== candidate.entrypoint ||
        source.manifest.demoEntrypoint !== candidate.demoEntrypoint ||
        source.manifest.providerItemKey !== candidate.providerItemKey
      ) {
        throw new NativeVisualSourceError("V5_SOURCE_COORDINATE_MISMATCH");
      }
    }
    archives.set(candidate.id, archive);
  }
  return { bundle, archives };
}

export async function selectedNativeSourceArchive(input: {
  artifactBytes: Buffer;
  selectedCandidateId: string;
}) {
  const artifact = await readVisualSelectionBundleArtifact(input.artifactBytes);
  const candidate = artifact.bundle.candidates.find(
    (item) => item.id === input.selectedCandidateId,
  );
  if (!candidate)
    throw new NativeVisualSourceError("VISUAL_SELECTED_CANDIDATE_MISSING");
  const frozenArchiveBytes = artifact.archives.get(candidate.id)!;
  if (
    artifact.bundle.schemaVersion === 6 &&
    "sourceFormat" in candidate &&
    candidate.sourceFormat === "provider_archive_v1"
  ) {
    const source = await inspectV6SourceCoordinates({
      candidate,
      archive: frozenArchiveBytes,
    });
    if (source.sourceFormat !== "provider_archive_v1") {
      throw new NativeVisualSourceError("V6_SOURCE_FORMAT_MISMATCH");
    }
    return {
      bundle: artifact.bundle,
      candidate,
      archiveBytes: source.providerArchive,
      archiveSha256: source.manifest.providerArchiveSha256,
      manifest: source.manifest,
      files: [] as NativeSourceFile[],
    };
  }
  const source = await readNativeSourceArchive(frozenArchiveBytes);
  return {
    bundle: artifact.bundle,
    candidate,
    archiveBytes: frozenArchiveBytes,
    archiveSha256: candidate.sourceArchiveSha256,
    manifest: source.manifest,
    files: source.files,
  };
}
