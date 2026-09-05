import { createHash, randomBytes, randomUUID } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { access } from "node:fs/promises";
import { createRequire } from "node:module";
import { type Readable } from "node:stream";
import axios from "axios";
import { and, desc, eq, inArray, ne } from "drizzle-orm";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import {
  StreamableHTTPClientTransport,
  StreamableHTTPError,
} from "@modelcontextprotocol/sdk/client/streamableHttp.js";

import {
  presalesApiCredentials,
  siteBuilds,
  siteOperations,
  websiteStyleSampleBatches,
  type PresalesApiCredential,
} from "../drizzle/schema";
import {
  AuthServiceError,
  decryptCredentialSecret,
  encryptCredentialSecret,
  getApiKeyFingerprint,
} from "./auth-service";
import { getDb } from "./db";
import {
  assertSafeExternalUrl,
  safeExternalRequestOptions,
} from "./_core/safe-external-url";

export const TWENTY_FIRST_CREDENTIAL_SLOT = "site_builder_21st";
export const TWENTY_FIRST_MCP_ENDPOINT = "https://21st.dev/api/mcp";
export const TWENTY_FIRST_API_ORIGIN = "https://21st.dev";
export const TWENTY_FIRST_CODELOAD_ORIGIN = "https://codeload.github.com";

const TWENTY_FIRST_REQUEST_TIMEOUT_MS = 12_000;
const TWENTY_FIRST_TOTAL_TIMEOUT_MS = 90_000;
const TWENTY_FIRST_MAX_RESPONSE_BYTES = 1_000_000;
const TWENTY_FIRST_MAX_JSON_DEPTH = 32;
const TWENTY_FIRST_MAX_RETRY_AFTER_MS = 2_000;
const TWENTY_FIRST_MAX_HTTP_RETRIES = 1;
const TWENTY_FIRST_MAX_TOOL_PAGES = 3;
const TWENTY_FIRST_MAX_TOOLS = 100;
const TWENTY_FIRST_TEMPLATE_CATALOG_LIMIT = 60;
const TWENTY_FIRST_TEMPLATE_DISCOVERY_LIMIT = 32;
const TWENTY_FIRST_TEMPLATE_JSON_MAX_BYTES = 256_000;
// Bound each immutable Marketplace source download. Candidate generation
// treats the archive as inert data, validates its ZIP envelope, and stores it
// inside the selected V6 artifact; provider code is not executed here.
const TWENTY_FIRST_TEMPLATE_ARCHIVE_MAX_BYTES = 50 * 1024 * 1024;
const TWENTY_FIRST_TEMPLATE_DIRECT_TIMEOUT_MS = 30_000;
// Saving a credential performs the full live Template probe and seeds this
// cache. Keep status reads from repeatedly spending the provider's metered
// search allowance; generation still revalidates catalog and download access.
const TWENTY_FIRST_STATUS_REVALIDATION_TTL_MS = 6 * 60 * 60_000;
const TWENTY_FIRST_MARKETPLACE_CATALOG_PATH = "/api/trpc/templates.list";

export type TwentyFirstCapabilities = {
  search: boolean;
  getComponent: boolean;
  getUsage: boolean | null;
  getTheme: boolean | null;
};

export type TwentyFirstNativeVisualReadiness =
  | "ready"
  | "missing_get_component"
  | "source_contract_incompatible"
  | "usage_unavailable"
  | "unverified";

export type TwentyFirstNativeTemplateReadiness =
  | "ready"
  | "plan_ineligible"
  | "catalog_unavailable"
  | "download_unavailable"
  | "compiler_unavailable"
  | "unverified";

export type TwentyFirstCredentialStatus = {
  configured: boolean;
  revocationPending: boolean;
  fingerprint: string | null;
  status: "active" | "retired" | "invalid" | null;
  version: number | null;
  verifiedAt: number | null;
  updatedAt: number | null;
  capabilities: TwentyFirstCapabilities;
  nativeVisualReadiness: TwentyFirstNativeVisualReadiness;
  nativeTemplateReadiness: TwentyFirstNativeTemplateReadiness;
};

export type TwentyFirstConnectionResult = {
  ok: true;
  endpoint: typeof TWENTY_FIRST_MCP_ENDPOINT;
  capabilities: TwentyFirstCapabilities;
  nativeVisualReadiness: TwentyFirstNativeVisualReadiness;
  nativeTemplateReadiness: TwentyFirstNativeTemplateReadiness;
  server: { name: string; version: string } | null;
};

export type TwentyFirstNativeTemplateSummary = {
  templateId: TwentyFirstProviderItemId;
  slug: string;
  name: string;
  version: string | null;
  verified: boolean;
  includedWithPlan: boolean;
  sortRank: number;
  previewUrl: string;
  sourceOwner: string;
  sourceRepo: string;
  sourceCommitSha: string;
  sourceSubdirectory: string | null;
  sourceLicense: "MIT" | "Apache-2.0";
};

export type TwentyFirstNativeTemplateArchive = {
  templateId: TwentyFirstProviderItemId;
  slug: string;
  version: string | null;
  archive: Uint8Array;
  sha256: string;
  contentType: "application/zip";
  sourceUrlOrigin: typeof TWENTY_FIRST_CODELOAD_ORIGIN;
  sourceSubdirectory: string | null;
};

export type TwentyFirstNativeTemplateFailureCategory =
  | "catalog_unavailable"
  | "plan_ineligible"
  | "download_unavailable";

export class TwentyFirstNativeTemplateError extends AuthServiceError {
  constructor(
    public readonly category: TwentyFirstNativeTemplateFailureCategory,
    /** Only transport/read failures may be retried by the bounded pool fetch. */
    public readonly retryable = false,
  ) {
    super(
      "UPSTREAM_UNAVAILABLE",
      category === "plan_ineligible"
        ? "当前 21st 账号没有可下载的完整 Template 权限"
        : category === "download_unavailable"
          ? "21st 完整 Template 下载暂不可用"
          : "21st 完整 Template 目录暂不可用",
    );
    this.name = "TwentyFirstNativeTemplateError";
  }
}

type TwentyFirstTemplateBinaryFetch = (input: {
  url: string;
  mode: "probe" | "full";
  signal: AbortSignal;
  maxBytes: number;
}) => Promise<Uint8Array>;

type TwentyFirstTemplateCompilerProbe = () => Promise<boolean>;

export type TwentyFirstActiveConsumerProbe = (
  credentialIds: readonly string[],
  executor: any,
) => Promise<boolean>;

export const TWENTY_FIRST_ACTIVE_OPERATION_STATUSES = [
  "queued",
  "running",
  "outcome_unknown",
] as const;

export async function hasActiveTwentyFirstConsumers(
  credentialIds: readonly string[],
  executor: any,
) {
  if (credentialIds.length === 0) return false;
  const [providerOperations, credentialBuilds, awaitingSelectionBoards] =
    await Promise.all([
      executor
        .select({ id: siteOperations.id })
        .from(siteOperations)
        .where(
          and(
            eq(siteOperations.provider, "21st"),
            inArray(
              siteOperations.status,
              TWENTY_FIRST_ACTIVE_OPERATION_STATUSES,
            ),
          ),
        )
        .limit(1)
        .for("update"),
      executor
        .select({ id: siteBuilds.id })
        .from(siteBuilds)
        .where(
          and(
            inArray(siteBuilds.twentyFirstCredentialId, [...credentialIds]),
            inArray(siteBuilds.status, [
              "preparing",
              "visual_searching",
              "awaiting_visual_selection",
              "design_compiling",
            ]),
          ),
        )
        .limit(1)
        .for("update"),
      // A published board is a durable output whose frozen credential version
      // must remain referenceable until the customer selects or re-searches.
      executor
        .select({ id: websiteStyleSampleBatches.id })
        .from(websiteStyleSampleBatches)
        .where(
          and(
            eq(websiteStyleSampleBatches.sourceKind, "siteops_21st"),
            eq(websiteStyleSampleBatches.status, "published"),
          ),
        )
        .limit(1)
        .for("update"),
    ]);
  return Boolean(
    providerOperations[0] || credentialBuilds[0] || awaitingSelectionBoards[0],
  );
}

async function requireDb() {
  const db = await getDb();
  if (!db) {
    throw new AuthServiceError(
      "DATABASE_UNAVAILABLE",
      "Database is not configured",
    );
  }
  return db;
}

function twentyFirstCredentialAad(credentialId: string) {
  return `frontmind-21st-api-credential:v1:${TWENTY_FIRST_CREDENTIAL_SLOT}:${credentialId}`;
}

export function encryptTwentyFirstApiKey(credentialId: string, apiKey: string) {
  return encryptCredentialSecret(
    twentyFirstCredentialAad(credentialId),
    apiKey,
  );
}

export function decryptTwentyFirstApiKey(
  credential: Pick<
    PresalesApiCredential,
    | "id"
    | "encryptionVersion"
    | "encryptedKey"
    | "encryptionIv"
    | "encryptionAuthTag"
  >,
) {
  return decryptCredentialSecret(
    twentyFirstCredentialAad(credential.id),
    credential,
  );
}

export function validateTwentyFirstApiKeyInput(apiKey: string) {
  const value = apiKey.trim();
  if (value.length < 8) {
    throw new AuthServiceError(
      "INVALID_CREDENTIAL",
      "21st API Key 至少需要 8 个字符",
    );
  }
  if (value.length > 4_096) {
    throw new AuthServiceError(
      "INVALID_CREDENTIAL",
      "21st API Key 不能超过 4096 个字符",
    );
  }
  if (/[\u0000-\u001f\u007f]/u.test(value)) {
    throw new AuthServiceError(
      "INVALID_CREDENTIAL",
      "21st API Key 包含无效控制字符",
    );
  }
  return value;
}

function createBoundedFetch(
  fetchImpl: typeof fetch,
  timeoutMs: number,
  maxResponseBytes: number,
  options: {
    maxRetries?: number;
    maxRetryAfterMs?: number;
    sleep?: (milliseconds: number) => Promise<void>;
  } = {},
) {
  return async (url: string | URL, init?: RequestInit) => {
    const maxRetries = Math.max(
      0,
      Math.min(options.maxRetries ?? TWENTY_FIRST_MAX_HTTP_RETRIES, 2),
    );
    const maxRetryAfterMs = Math.max(
      0,
      Math.min(
        options.maxRetryAfterMs ?? TWENTY_FIRST_MAX_RETRY_AFTER_MS,
        5_000,
      ),
    );
    const sleep =
      options.sleep ??
      ((milliseconds: number) =>
        new Promise<void>((resolve) => setTimeout(resolve, milliseconds)));
    let response: Response | null = null;
    for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
      const timeoutSignal = AbortSignal.timeout(timeoutMs);
      const signal = init?.signal
        ? AbortSignal.any([init.signal, timeoutSignal])
        : timeoutSignal;
      response = await fetchImpl(url, { ...init, signal });
      if (response.status !== 429 || attempt === maxRetries) break;
      const header = response.headers.get("retry-after");
      const seconds = header ? Number(header) : Number.NaN;
      const absolute = header ? Date.parse(header) : Number.NaN;
      const requestedDelay = Number.isFinite(seconds)
        ? seconds * 1_000
        : Number.isFinite(absolute)
          ? Math.max(0, absolute - Date.now())
          : 250;
      await response.body?.cancel().catch(() => undefined);
      await sleep(Math.min(Math.max(0, requestedDelay), maxRetryAfterMs));
    }
    if (!response) throw new Error("21st response missing");
    const declaredBytes = Number(response.headers.get("content-length"));
    if (Number.isFinite(declaredBytes) && declaredBytes > maxResponseBytes) {
      throw new Error("21st response exceeded the configured size limit");
    }
    if (!response.body) return response;

    let receivedBytes = 0;
    const boundedBody = response.body.pipeThrough(
      new TransformStream<Uint8Array, Uint8Array>({
        transform(chunk, controller) {
          receivedBytes += chunk.byteLength;
          if (receivedBytes > maxResponseBytes) {
            controller.error(
              new Error("21st response exceeded the configured size limit"),
            );
            return;
          }
          controller.enqueue(chunk);
        },
      }),
    );
    return new Response(boundedBody, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    });
  };
}

type TwentyFirstAdvertisedTool = {
  name: string;
  inputSchema: {
    type: "object";
    properties?: Record<string, object>;
    required?: string[];
    [key: string]: unknown;
  };
  annotations?: {
    readOnlyHint?: boolean;
    destructiveHint?: boolean;
    [key: string]: unknown;
  };
};

export type TwentyFirstProviderItemId = string | number;

export type TwentyFirstSearchRequest = {
  query: string;
  type: "template" | "component";
  limit: number;
  tag?: "hero";
  sort?: "recommended" | "popular";
};

export type TwentyFirstReadOnlySession = {
  /** Maximum search depth actually accepted by the live advertised schema. */
  effectiveSearchLimit?: number;
  /** Prefer complete page/template sources when the live catalog supports them. */
  preferredSearchType?: TwentyFirstSearchRequest["type"];
  /** Present only when tools/list explicitly enumerates the ranking value. */
  preferredTemplateSort?: "popular";
  search(input: TwentyFirstSearchRequest): Promise<unknown>;
  getComponent?: (
    providerItemId: TwentyFirstProviderItemId,
  ) => Promise<unknown>;
};

export class TwentyFirstToolContractError extends AuthServiceError {
  constructor() {
    super("UPSTREAM_UNAVAILABLE", "21st 工具参数协议暂不兼容");
    this.name = "TwentyFirstToolContractError";
  }
}

export type TwentyFirstNativeSourceContractCode =
  | "NATIVE_SOURCE_CONTRACT_UNAVAILABLE"
  | "NATIVE_SOURCE_CANDIDATES_UNAVAILABLE"
  | "NATIVE_SOURCE_QUOTA_UNAVAILABLE";

/**
 * A stable, non-reflective classification for get_component failures. The
 * AuthServiceError code remains part of the existing transport contract while
 * nativeCode lets the SiteOps provider distinguish quota, catalog misses and
 * a changed MCP payload without inspecting provider text.
 */
export class TwentyFirstNativeSourceContractError extends AuthServiceError {
  constructor(public readonly nativeCode: TwentyFirstNativeSourceContractCode) {
    super(
      "UPSTREAM_UNAVAILABLE",
      nativeCode === "NATIVE_SOURCE_QUOTA_UNAVAILABLE"
        ? "21st 原生源码读取额度暂不可用"
        : nativeCode === "NATIVE_SOURCE_CANDIDATES_UNAVAILABLE"
          ? "21st 原生源码候选暂不可用"
          : "21st 原生源码返回协议暂不兼容",
    );
    this.name = "TwentyFirstNativeSourceContractError";
  }
}

function canonicalToolInputKey(value: string) {
  return value.toLocaleLowerCase("en-US").replace(/[^a-z0-9]/gu, "");
}

function findToolInputKey(
  tool: TwentyFirstAdvertisedTool,
  candidates: readonly string[],
) {
  const wanted = new Set(candidates.map(canonicalToolInputKey));
  return Object.keys(tool.inputSchema.properties ?? {}).find((key) =>
    wanted.has(canonicalToolInputKey(key)),
  );
}

function compatibleEnumValue(
  property: object | undefined,
  candidates: readonly string[],
) {
  const declared = Array.isArray(
    (property as { enum?: unknown } | undefined)?.enum,
  );
  const values = declared
    ? ((property as { enum: unknown[] }).enum ?? [])
    : null;
  return values
    ? candidates.find((candidate) => values.includes(candidate))
    : candidates[0];
}

function preferredTemplateSortForTool(
  tool: TwentyFirstAdvertisedTool,
): "popular" | undefined {
  const sortKey = findToolInputKey(tool, ["sort"]);
  if (!sortKey) return undefined;
  const values = (
    tool.inputSchema.properties?.[sortKey] as { enum?: unknown } | undefined
  )?.enum;
  return Array.isArray(values) && values.includes("popular")
    ? "popular"
    : undefined;
}

function boundedSearchLimit(property: object | undefined, requested: number) {
  if (!Number.isFinite(requested)) throw new TwentyFirstToolContractError();
  const constraint = (property ?? {}) as {
    minimum?: unknown;
    maximum?: unknown;
  };
  const minimum =
    typeof constraint.minimum === "number" &&
    Number.isFinite(constraint.minimum)
      ? Math.ceil(constraint.minimum)
      : 1;
  const maximum =
    typeof constraint.maximum === "number" &&
    Number.isFinite(constraint.maximum)
      ? Math.floor(constraint.maximum)
      : 18;
  const lower = Math.max(1, minimum);
  const upper = Math.min(18, maximum);
  if (lower > upper) throw new TwentyFirstToolContractError();
  return Math.max(lower, Math.min(Math.trunc(requested), upper));
}

function advertisedJsonTypes(property: object | undefined) {
  if (!property) return new Set<string>();
  const candidate = property as {
    type?: unknown;
    anyOf?: unknown;
    oneOf?: unknown;
  };
  const types = new Set<string>();
  const add = (value: unknown) => {
    if (typeof value === "string") types.add(value);
    else if (Array.isArray(value)) value.forEach(add);
  };
  add(candidate.type);
  for (const variants of [candidate.anyOf, candidate.oneOf]) {
    if (!Array.isArray(variants)) continue;
    for (const variant of variants) {
      if (variant && typeof variant === "object") {
        add((variant as { type?: unknown }).type);
      }
    }
  }
  return types;
}

function assertAdvertisedPrimitive(
  property: object | undefined,
  value: string | number,
) {
  const types = advertisedJsonTypes(property);
  if (types.size === 0) return;
  const accepted =
    typeof value === "string"
      ? types.has("string")
      : types.has("number") ||
        (types.has("integer") && Number.isSafeInteger(value));
  const enumValues = Array.isArray(
    (property as { enum?: unknown } | undefined)?.enum,
  )
    ? (property as { enum: unknown[] }).enum
    : null;
  if (!accepted || (enumValues && !enumValues.includes(value))) {
    throw new TwentyFirstToolContractError();
  }
}

function adaptProviderItemIdToAdvertisedSchema(
  property: object | undefined,
  value: TwentyFirstProviderItemId,
) {
  const types = advertisedJsonTypes(property);
  if (types.size === 0) return value;
  const acceptsString = types.has("string");
  const acceptsNumber = types.has("number") || types.has("integer");
  if (
    typeof value === "string" &&
    !acceptsString &&
    acceptsNumber &&
    /^(?:0|[1-9][0-9]*)$/u.test(value)
  ) {
    const numeric = Number(value);
    if (Number.isSafeInteger(numeric)) return numeric;
  }
  if (typeof value === "number" && !acceptsNumber && acceptsString) {
    return String(value);
  }
  return value;
}

/**
 * Builds arguments from the server-advertised JSON schema. Only exact,
 * allowlisted semantic fields are populated; an incompatible schema fails
 * closed instead of guessing or calling another tool.
 */
export function buildTwentyFirstToolArguments(input: {
  operation: "search" | "get_component";
  tool: TwentyFirstAdvertisedTool;
  value: string | TwentyFirstProviderItemId;
  limit?: number;
  searchType?: TwentyFirstSearchRequest["type"];
  searchOptions?: Pick<TwentyFirstSearchRequest, "tag" | "sort">;
}) {
  const properties = input.tool.inputSchema.properties ?? {};
  const valueKey =
    input.operation === "search"
      ? findToolInputKey(input.tool, [
          "query",
          "searchQuery",
          "search_query",
          "q",
          "term",
          "keywords",
        ])
      : findToolInputKey(input.tool, [
          "id",
          "componentId",
          "component_id",
          "itemId",
          "item_id",
          "slug",
          "name",
        ]);
  if (!valueKey) {
    throw new TwentyFirstToolContractError();
  }
  if (input.operation === "search" && typeof input.value !== "string") {
    throw new TwentyFirstToolContractError();
  }
  const advertisedValue =
    input.operation === "get_component"
      ? adaptProviderItemIdToAdvertisedSchema(
          properties[valueKey],
          input.value as TwentyFirstProviderItemId,
        )
      : input.value;
  assertAdvertisedPrimitive(properties[valueKey], advertisedValue);
  const args: Record<string, unknown> = { [valueKey]: advertisedValue };
  if (input.operation === "search") {
    const limitKey = findToolInputKey(input.tool, [
      "limit",
      "take",
      "pageSize",
      "page_size",
    ]);
    if (limitKey) {
      const limit = boundedSearchLimit(properties[limitKey], input.limit ?? 10);
      assertAdvertisedPrimitive(properties[limitKey], limit);
      args[limitKey] = limit;
    }
    const typeKey = findToolInputKey(input.tool, ["type", "kind"]);
    if (input.searchType === "template" && !typeKey) {
      throw new TwentyFirstToolContractError();
    }
    if (typeKey) {
      const requestedType = input.searchType ?? "component";
      const declaredEnum = (
        properties[typeKey] as { enum?: unknown } | undefined
      )?.enum;
      if (requestedType === "template" && !Array.isArray(declaredEnum)) {
        throw new TwentyFirstToolContractError();
      }
      const typeValue = compatibleEnumValue(
        properties[typeKey],
        requestedType === "template"
          ? ["template", "templates", "page", "pages"]
          : ["component", "components", "c"],
      );
      if (!typeValue) throw new TwentyFirstToolContractError();
      assertAdvertisedPrimitive(properties[typeKey], typeValue);
      args[typeKey] = typeValue;
    }
    for (const [semanticKey, requested] of [
      ["tag", input.searchOptions?.tag],
      ["sort", input.searchOptions?.sort],
    ] as const) {
      if (!requested) continue;
      const advertisedKey = findToolInputKey(input.tool, [semanticKey]);
      if (!advertisedKey) continue;
      const property = properties[advertisedKey];
      const declaredEnum = Array.isArray(
        (property as { enum?: unknown } | undefined)?.enum,
      )
        ? (property as { enum: unknown[] }).enum
        : null;
      // Ranking values are provider-owned capabilities. In particular,
      // `popular` is never guessed when the live schema does not enumerate
      // it; omitting sort preserves the provider's default ordering.
      if (
        (semanticKey === "sort" && !declaredEnum) ||
        (declaredEnum && !declaredEnum.includes(requested))
      ) {
        continue;
      }
      assertAdvertisedPrimitive(property, requested);
      args[advertisedKey] = requested;
    }
  }
  const required = new Set(input.tool.inputSchema.required ?? []);
  const missingRequired = [...required].filter(
    (key) => !Object.prototype.hasOwnProperty.call(args, key),
  );
  if (missingRequired.length > 0) {
    throw new TwentyFirstToolContractError();
  }
  return args;
}

function preferredSearchTypeForTool(
  _tool: TwentyFirstAdvertisedTool,
): TwentyFirstSearchRequest["type"] {
  // The live get_component contract accepts component search IDs. A search
  // enum advertising template/page does not imply that those IDs can be read
  // through get_component; template preference can be enabled only alongside
  // a separately advertised and implemented read-only source tool.
  return "component";
}

function getComponentContractProbeValue(tool: TwentyFirstAdvertisedTool) {
  const key = findToolInputKey(tool, [
    "id",
    "componentId",
    "component_id",
    "itemId",
    "item_id",
    "slug",
    "name",
  ]);
  if (!key) throw new TwentyFirstToolContractError();
  const property = tool.inputSchema.properties?.[key];
  const types = advertisedJsonTypes(property);
  const enumValues = Array.isArray(
    (property as { enum?: unknown } | undefined)?.enum,
  )
    ? (property as { enum: unknown[] }).enum
    : [];
  const advertisedValue = enumValues.find(
    (value): value is string | number =>
      typeof value === "string" || typeof value === "number",
  );
  if (advertisedValue !== undefined) return advertisedValue;
  if (types.has("number") || types.has("integer")) return 1;
  if (types.has("string")) return "frontmind-contract-probe";
  // MCP schemas sometimes omit a primitive type. Preserve compatibility with
  // the official numeric get_component coordinate while still validating all
  // required fields through buildTwentyFirstToolArguments below.
  return 1;
}

function nativeVisualReadinessForTools(
  search: TwentyFirstAdvertisedTool,
  getComponent: TwentyFirstAdvertisedTool | undefined,
): TwentyFirstNativeVisualReadiness {
  if (!getComponent || getComponent.annotations?.destructiveHint === true) {
    return "missing_get_component";
  }
  try {
    const searchType = preferredSearchTypeForTool(search);
    buildTwentyFirstToolArguments({
      operation: "search",
      tool: search,
      value: "frontmind contract probe",
      limit: 1,
      searchType,
    });
    buildTwentyFirstToolArguments({
      operation: "get_component",
      tool: getComponent,
      value: getComponentContractProbeValue(getComponent),
    });
    return "ready";
  } catch {
    return "source_contract_incompatible";
  }
}

function parseToolTextPayload(text: string) {
  const value = text.trim();
  if (
    !value ||
    Buffer.byteLength(value, "utf8") > TWENTY_FIRST_MAX_RESPONSE_BYTES
  ) {
    return null;
  }
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return null;
  }
}

function boundedProviderSourceText(text: string) {
  if (
    !text.trim() ||
    Buffer.byteLength(text, "utf8") > TWENTY_FIRST_MAX_RESPONSE_BYTES ||
    // Source may legitimately contain tabs and newlines. Other literal C0
    // controls cannot be valid TSX/CSS source and are rejected before the
    // value crosses the MCP boundary.
    /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(text)
  ) {
    return null;
  }
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

function payloadRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function sourcePayloadProjection(value: unknown, depth = 0): unknown | null {
  const record = payloadRecord(value);
  if (!record) return null;
  if (
    [
      "files",
      "sourceFiles",
      "source_files",
      "componentCode",
      "component_code",
      "sourceCode",
      "source_code",
      "demoCode",
      "demo_code",
      "previewCode",
      "preview_code",
    ].some((key) => Object.prototype.hasOwnProperty.call(record, key))
  ) {
    return value;
  }
  if (depth >= 4) return null;
  for (const key of [
    "data",
    "result",
    "payload",
    "output",
    "component",
    "structuredContent",
  ]) {
    const nested = sourcePayloadProjection(record[key], depth + 1);
    if (nested) return nested;
  }
  return null;
}

function safeProviderItemId(value: unknown): TwentyFirstProviderItemId | null {
  if (typeof value === "number") {
    return Number.isSafeInteger(value) && value >= 0 ? value : null;
  }
  if (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= 191 &&
    !/[\u0000-\u001f\u007f]/u.test(value)
  ) {
    return value;
  }
  return null;
}

function firstProviderItemId(value: unknown) {
  const projection = resultsProjection(value);
  for (const item of projection?.results ?? []) {
    const record = payloadRecord(item);
    if (!record) continue;
    for (const key of [
      "id",
      "componentId",
      "component_id",
      "itemId",
      "item_id",
      "providerItemId",
      "provider_item_id",
      "slug",
    ]) {
      const candidate = safeProviderItemId(record[key]);
      if (candidate !== null) return candidate;
    }
  }
  return null;
}

const QUOTA_EXHAUSTED_VALUES = new Set([
  "credits_exhausted",
  "insufficient_credits",
  "locked",
  "quota_exceeded",
  "usage_exhausted",
  "upgrade_required",
]);

function isExplicitQuotaExhaustion(value: unknown, depth = 0): boolean {
  const record = payloadRecord(value);
  if (!record || depth > 3) return false;
  if (record.locked === true) return true;
  for (const key of ["code", "reason", "status"]) {
    const candidate = record[key];
    if (
      typeof candidate === "string" &&
      QUOTA_EXHAUSTED_VALUES.has(candidate.trim().toLocaleLowerCase("en-US"))
    ) {
      return true;
    }
  }
  for (const key of [
    "remaining",
    "creditsRemaining",
    "credits_remaining",
    "sourceReadsRemaining",
    "source_reads_remaining",
  ]) {
    if (typeof record[key] === "number" && record[key] <= 0) return true;
  }
  return ["data", "result", "payload", "usage", "quota"].some((key) =>
    isExplicitQuotaExhaustion(record[key], depth + 1),
  );
}

function usageResultShowsExhaustion(result: Record<string, unknown>) {
  if (isExplicitQuotaExhaustion(result.structuredContent)) return true;
  const content = Array.isArray(result.content) ? result.content : [];
  return content.some((item) => {
    if (
      !item ||
      typeof item !== "object" ||
      (item as { type?: unknown }).type !== "text" ||
      typeof (item as { text?: unknown }).text !== "string"
    ) {
      return false;
    }
    const parsed = parseToolTextPayload((item as { text: string }).text);
    return parsed !== null && isExplicitQuotaExhaustion(parsed);
  });
}

function supportsZeroArgumentCall(tool: TwentyFirstAdvertisedTool) {
  return (tool.inputSchema.required?.length ?? 0) === 0;
}

function resultsProjection(
  value: unknown,
  depth = 0,
): { results: unknown[] } | null {
  if (
    value &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Array.isArray((value as { results?: unknown }).results)
  ) {
    return { results: (value as { results: unknown[] }).results };
  }
  if (
    depth < 4 &&
    value &&
    typeof value === "object" &&
    !Array.isArray(value)
  ) {
    const record = value as Record<string, unknown>;
    for (const key of [
      "data",
      "result",
      "payload",
      "output",
      "structuredContent",
    ]) {
      const nested = resultsProjection(record[key], depth + 1);
      if (nested) return nested;
    }
  }
  return null;
}

function safeTemplateText(value: unknown, maxLength: number) {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > maxLength ||
    /[\u0000-\u001f\u007f]/u.test(value)
  ) {
    return null;
  }
  return value.trim() || null;
}

function safeTemplateSlug(value: unknown) {
  const slug = safeTemplateText(value, 191);
  return slug && /^[a-z0-9](?:[a-z0-9._-]*[a-z0-9])?$/iu.test(slug)
    ? slug
    : null;
}

function safeTemplateVersion(value: unknown) {
  if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) {
    return String(value);
  }
  return safeTemplateText(value, 64);
}

function templateSlugFromRecord(record: Record<string, unknown>) {
  const explicit = safeTemplateSlug(
    firstRecordValue(record, ["slug", "templateSlug", "template_slug"]),
  );
  if (explicit) return explicit;
  const installCommand = safeTemplateText(
    firstRecordValue(record, ["installCommand", "install_command"]),
    1_024,
  );
  const commandSlug = installCommand?.match(
    /(?:^|\s)template\s+add\s+["']?([a-z0-9][a-z0-9._-]*)(?:["'\s]|$)/iu,
  )?.[1];
  if (commandSlug) return safeTemplateSlug(commandSlug);
  const rawUrl = safeTemplateText(
    firstRecordValue(record, ["url", "templateUrl", "template_url"]),
    8_192,
  );
  if (!rawUrl) return null;
  try {
    const url = new URL(rawUrl);
    if (url.origin !== TWENTY_FIRST_API_ORIGIN) return null;
    const slug = url.pathname.match(
      /^\/community\/templates\/([a-z0-9][a-z0-9._-]*)\/?$/iu,
    )?.[1];
    return safeTemplateSlug(slug);
  } catch {
    return null;
  }
}

function firstRecordValue(
  record: Record<string, unknown>,
  keys: readonly string[],
) {
  for (const key of keys) {
    if (Object.prototype.hasOwnProperty.call(record, key)) return record[key];
  }
  return undefined;
}

type TwentyFirstLegacyNativeTemplateSummary = Pick<
  TwentyFirstNativeTemplateSummary,
  | "templateId"
  | "slug"
  | "name"
  | "version"
  | "verified"
  | "includedWithPlan"
  | "sortRank"
>;

export function projectTwentyFirstNativeTemplateSummaries(
  value: unknown,
  startRank = 0,
  options: { templateFilteredSearch?: boolean } = {},
): TwentyFirstLegacyNativeTemplateSummary[] {
  const projection = resultsProjection(value);
  if (!projection) return [];
  const summaries: TwentyFirstLegacyNativeTemplateSummary[] = [];
  for (const item of projection.results) {
    const record = payloadRecord(item);
    if (!record) continue;
    const advertisedType = safeTemplateText(
      firstRecordValue(record, ["type", "kind", "entityType", "entity_type"]),
      32,
    )?.toLocaleLowerCase("en-US");
    // The official CLI treats an individual result's `type` as optional. An
    // untyped coordinate is accepted only when the live tools/list schema has
    // already advertised Template search and this exact call used that filter.
    // An explicitly non-Template result is always rejected.
    if (
      (advertisedType &&
        !["template", "templates", "page", "pages"].includes(advertisedType)) ||
      (!advertisedType && !options.templateFilteredSearch)
    ) {
      continue;
    }
    const templateId = safeProviderItemId(
      firstRecordValue(record, [
        "id",
        "templateId",
        "template_id",
        "providerTemplateId",
        "provider_template_id",
      ]),
    );
    const slug =
      templateSlugFromRecord(record) ??
      (typeof templateId === "string"
        ? safeTemplateSlug(templateId.replace(/^template:/iu, ""))
        : null);
    if (templateId === null || !slug) continue;
    const name =
      safeTemplateText(
        firstRecordValue(record, ["name", "title", "templateName"]),
        200,
      ) ?? slug;
    const verified =
      firstRecordValue(record, ["verified", "isVerified", "is_verified"]) ===
      true;
    summaries.push({
      templateId,
      slug,
      name,
      version: safeTemplateVersion(
        firstRecordValue(record, ["version", "templateVersion"]),
      ),
      verified,
      includedWithPlan: false,
      sortRank: startRank + summaries.length,
    });
  }
  return summaries;
}

function safeGithubOwner(value: unknown) {
  const owner = safeTemplateText(value, 39);
  return owner && /^[a-z0-9](?:[a-z0-9-]{0,37}[a-z0-9])?$/iu.test(owner)
    ? owner
    : null;
}

function safeGithubRepo(value: unknown) {
  const repo = safeTemplateText(value, 100);
  return repo &&
    /^[a-z0-9](?:[a-z0-9._-]{0,98}[a-z0-9])?$/iu.test(repo) &&
    !repo.includes("..")
    ? repo
    : null;
}

function safeGithubCommitSha(value: unknown) {
  const commit = safeTemplateText(value, 40);
  return commit && /^[a-f0-9]{40}$/iu.test(commit)
    ? commit.toLocaleLowerCase("en-US")
    : null;
}

function safeSourceSubdirectory(value: unknown) {
  if (value === null || value === undefined) return null;
  const path = safeTemplateText(value, 1_024);
  if (
    !path ||
    path.startsWith("/") ||
    path.endsWith("/") ||
    path.includes("\\")
  ) {
    return undefined;
  }
  const segments = path.split("/");
  return segments.every(
    (segment) =>
      segment !== "." &&
      segment !== ".." &&
      /^[a-z0-9](?:[a-z0-9._-]*[a-z0-9])?$/iu.test(segment),
  )
    ? path
    : undefined;
}

function safeMarketplacePreviewUrl(value: unknown) {
  const raw = safeTemplateText(value, 8_192);
  if (!raw) return null;
  try {
    const url = new URL(assertSafeExternalUrl(raw));
    const hostname = url.hostname.toLocaleLowerCase("en-US");
    if (
      url.protocol !== "https:" ||
      url.username ||
      url.password ||
      (url.port && url.port !== "443") ||
      (hostname !== "21st.dev" && !hostname.endsWith(".21st.dev"))
    ) {
      return null;
    }
    url.hash = "";
    return url.toString();
  } catch {
    return null;
  }
}

function marketplaceItemsProjection(value: unknown) {
  const root = payloadRecord(value);
  const result = root ? payloadRecord(root.result) : null;
  const data = result ? payloadRecord(result.data) : null;
  const json = data ? payloadRecord(data.json) : null;
  return json && Array.isArray(json.items) ? json.items : null;
}

/** Strictly projects the first-party Marketplace `templates.list` contract. */
export function projectTwentyFirstMarketplaceTemplateSummaries(
  value: unknown,
): TwentyFirstNativeTemplateSummary[] {
  const items = marketplaceItemsProjection(value);
  if (!items) throw new TwentyFirstNativeTemplateError("catalog_unavailable");
  const summaries: TwentyFirstNativeTemplateSummary[] = [];
  const seenIds = new Set<string>();
  const seenSlugs = new Set<string>();
  for (const item of items.slice(0, TWENTY_FIRST_TEMPLATE_CATALOG_LIMIT)) {
    const record = payloadRecord(item);
    const source = record ? payloadRecord(record.source) : null;
    if (
      !record ||
      !source ||
      record.hosting !== "hosted" ||
      record.verified !== true
    ) {
      continue;
    }
    const templateId = safeProviderItemId(record.id);
    const slug = safeTemplateSlug(record.template_slug);
    const name = safeTemplateText(record.name, 200);
    const previewUrl = safeMarketplacePreviewUrl(record.preview_url);
    const sourceOwner = safeGithubOwner(source.owner);
    const sourceRepo = safeGithubRepo(source.repo);
    const sourceCommitSha = safeGithubCommitSha(source.commitSha);
    const sourceSubdirectory = safeSourceSubdirectory(source.subdir);
    const sourceLicense =
      source.license === "MIT" || source.license === "Apache-2.0"
        ? source.license
        : null;
    if (
      templateId === null ||
      !slug ||
      !name ||
      !previewUrl ||
      !sourceOwner ||
      !sourceRepo ||
      !sourceCommitSha ||
      sourceSubdirectory === undefined ||
      !sourceLicense
    ) {
      continue;
    }
    const idKey = `${typeof templateId}:${String(templateId)}`;
    const slugKey = slug.toLocaleLowerCase("en-US");
    if (seenIds.has(idKey) || seenSlugs.has(slugKey)) continue;
    seenIds.add(idKey);
    seenSlugs.add(slugKey);
    summaries.push({
      templateId,
      slug,
      name,
      version: sourceCommitSha,
      verified: true,
      includedWithPlan: true,
      sortRank: summaries.length,
      previewUrl,
      sourceOwner,
      sourceRepo,
      sourceCommitSha,
      sourceSubdirectory,
      sourceLicense,
    });
    // Keep the complete, bounded provider page here. Callers apply historical
    // exclusions before taking their requested window, so stopping at the UI
    // page size would make excluded early rows permanently hide valid later
    // templates.
    if (summaries.length >= TWENTY_FIRST_TEMPLATE_CATALOG_LIMIT) break;
  }
  return summaries;
}

function hasZipLocalFileHeader(value: Uint8Array) {
  return (
    value.byteLength >= 4 &&
    value[0] === 0x50 &&
    value[1] === 0x4b &&
    value[2] === 0x03 &&
    value[3] === 0x04
  );
}

/**
 * A local-only readiness probe for the exact Template build toolchain. It does
 * not execute provider code, install packages or open the network. The
 * injectable client option keeps unit tests deterministic while production
 * validates the controlled Vite compiler. Browser rendering is an operation
 * concern and deliberately does not gate catalog/download readiness. Vite is
 * resolved without importing it into the long-lived Dashboard
 * server: the isolated native-template compiler imports that exact resolved
 * entrypoint inside its credential-free child process.
 */
export async function probeTwentyFirstTemplateCompilerEnvironment() {
  try {
    const require = createRequire(import.meta.url);
    const viteEntrypoint = require.resolve("vite");
    await access(viteEntrypoint, fsConstants.R_OK);
    return true;
  } catch {
    return false;
  }
}

async function defaultTemplateBinaryFetch(input: {
  url: string;
  mode: "probe" | "full";
  signal: AbortSignal;
  maxBytes: number;
}) {
  const safeUrl = assertSafeExternalUrl(input.url);
  const response = await axios.get<Readable>(safeUrl, {
    ...safeExternalRequestOptions,
    beforeRedirect: (...args) => {
      const [redirectOptions] = args;
      if (
        String(redirectOptions.protocol ?? "") !== "https:" ||
        (redirectOptions.port && String(redirectOptions.port) !== "443")
      ) {
        throw new TwentyFirstNativeTemplateError("download_unavailable");
      }
      safeExternalRequestOptions.beforeRedirect(redirectOptions);
    },
    method: "GET",
    responseType: "stream",
    signal: input.signal,
    timeout: TWENTY_FIRST_TEMPLATE_DIRECT_TIMEOUT_MS,
    headers: input.mode === "probe" ? { Range: "bytes=0-4095" } : undefined,
    validateStatus: (status) => status === 200 || status === 206,
  });
  const declared = Number(response.headers["content-length"]);
  if (
    input.mode === "full" &&
    Number.isFinite(declared) &&
    declared > input.maxBytes
  ) {
    response.data.destroy();
    throw new TwentyFirstNativeTemplateError("download_unavailable");
  }
  return await new Promise<Uint8Array>((resolve, reject) => {
    const chunks: Buffer[] = [];
    let received = 0;
    let settled = false;
    const finish = (value: Uint8Array) => {
      if (settled) return;
      settled = true;
      response.data.destroy();
      resolve(value);
    };
    response.data.on("data", (raw: Buffer | Uint8Array | string) => {
      const chunk = Buffer.isBuffer(raw) ? raw : Buffer.from(raw);
      received += chunk.byteLength;
      if (received > input.maxBytes) {
        if (!settled) {
          settled = true;
          response.data.destroy();
          reject(new TwentyFirstNativeTemplateError("download_unavailable"));
        }
        return;
      }
      chunks.push(chunk);
      if (input.mode === "probe" && received >= 4) {
        finish(Buffer.concat(chunks).subarray(0, 4));
      }
    });
    response.data.once("end", () => finish(Buffer.concat(chunks)));
    response.data.once("error", () => {
      if (settled) return;
      settled = true;
      reject(new TwentyFirstNativeTemplateError("download_unavailable", true));
    });
  });
}

/** Returns the provider payload only to the current bounded request. */
export function projectTwentyFirstToolPayload(
  result: Record<string, unknown>,
  operation?: "search" | "get_component",
) {
  if (operation === "get_component") {
    const status = payloadRecord(result.structuredContent);
    if (isExplicitQuotaExhaustion(status)) {
      throw new TwentyFirstNativeSourceContractError(
        "NATIVE_SOURCE_QUOTA_UNAVAILABLE",
      );
    }
    if (status?.found === false) {
      throw new TwentyFirstNativeSourceContractError(
        "NATIVE_SOURCE_CANDIDATES_UNAVAILABLE",
      );
    }
    if (result.isError === true) {
      throw new TwentyFirstNativeSourceContractError(
        "NATIVE_SOURCE_CONTRACT_UNAVAILABLE",
      );
    }
    const structuredSource = sourcePayloadProjection(result.structuredContent);
    if (structuredSource) return structuredSource;
    const content = Array.isArray(result.content) ? result.content : [];
    const textItems = content.filter(
      (item): item is { type: "text"; text: string } =>
        Boolean(
          item &&
            typeof item === "object" &&
            (item as { type?: unknown }).type === "text" &&
            typeof (item as { text?: unknown }).text === "string",
        ),
    );
    const totalTextBytes = textItems.reduce(
      (sum, item) => sum + Buffer.byteLength(item.text, "utf8"),
      0,
    );
    if (totalTextBytes <= TWENTY_FIRST_MAX_RESPONSE_BYTES) {
      for (const item of textItems) {
        const parsed = parseToolTextPayload(item.text);
        const projected = sourcePayloadProjection(parsed);
        if (projected) return projected;
      }
      const rawItems = textItems
        .filter((item) => parseToolTextPayload(item.text) === null)
        .map((item) => boundedProviderSourceText(item.text))
        .filter((item): item is string => item !== null);
      if (rawItems.length === 1) {
        return {
          contractKind: "twenty_first_get_component_v1" as const,
          status: {
            found: status?.found !== false,
            locked: false,
          },
          sourceText: rawItems[0],
        };
      }
    }
    throw new TwentyFirstNativeSourceContractError(
      "NATIVE_SOURCE_CONTRACT_UNAVAILABLE",
    );
  }
  const structuredResults = resultsProjection(result.structuredContent);
  if (structuredResults) return structuredResults;
  const textItems = Array.isArray(result.content)
    ? result.content.filter((item): item is { type: "text"; text: string } =>
        Boolean(
          item &&
            typeof item === "object" &&
            (item as { type?: unknown }).type === "text" &&
            typeof (item as { text?: unknown }).text === "string",
        ),
      )
    : [];
  const totalTextBytes = textItems.reduce(
    (sum, item) => sum + Buffer.byteLength(item.text, "utf8"),
    0,
  );
  const parsed =
    totalTextBytes <= TWENTY_FIRST_MAX_RESPONSE_BYTES
      ? textItems
          .map((item) => parseToolTextPayload(item.text))
          .filter((item) => item !== null)
      : [];
  const textResults = parsed.flatMap(
    (item) => resultsProjection(item)?.results ?? [],
  );
  if (textResults.length > 0) return { results: textResults };
  if (operation === "search") {
    throw new TwentyFirstToolContractError();
  }
  if (parsed.length === 1) return parsed[0];
  if (parsed.length > 1) return { items: parsed };
  return result.structuredContent &&
    typeof result.structuredContent === "object"
    ? result.structuredContent
    : {};
}

function toTwentyFirstConnectionError(error: unknown): AuthServiceError {
  if (error instanceof AuthServiceError) return error;
  if (
    error instanceof StreamableHTTPError &&
    (error.code === 401 || error.code === 403)
  ) {
    return new AuthServiceError(
      "INVALID_CREDENTIAL",
      "21st API Key 无效或已被撤销",
    );
  }
  return new AuthServiceError(
    "UPSTREAM_UNAVAILABLE",
    "21st 服务暂时不可用，请稍后重试",
  );
}

export function assertTwentyFirstJsonDepth(
  value: unknown,
  maxDepth = TWENTY_FIRST_MAX_JSON_DEPTH,
) {
  const pending: Array<{ value: unknown; depth: number }> = [
    { value, depth: 0 },
  ];
  while (pending.length > 0) {
    const current = pending.pop()!;
    if (current.depth > maxDepth) {
      throw new AuthServiceError(
        "UPSTREAM_UNAVAILABLE",
        "21st 服务返回的数据结构过深",
      );
    }
    if (!current.value || typeof current.value !== "object") continue;
    const children = Array.isArray(current.value)
      ? current.value
      : Object.values(current.value as Record<string, unknown>);
    for (const child of children) {
      pending.push({ value: child, depth: current.depth + 1 });
    }
  }
}

/**
 * A deliberately narrow MCP client. Credential validation discovers the live
 * schema and performs one bounded, non-customer, read-only source probe. It
 * never invokes a mutating or generative provider tool.
 */
export class TwentyFirstClient {
  private readonly nativeTemplateCatalog = new Map<
    string,
    TwentyFirstNativeTemplateSummary
  >();

  constructor(
    private readonly options: {
      fetchImpl?: typeof fetch;
      timeoutMs?: number;
      totalTimeoutMs?: number;
      maxResponseBytes?: number;
      maxHttpRetries?: number;
      maxRetryAfterMs?: number;
      sleep?: (milliseconds: number) => Promise<void>;
      templateBinaryFetch?: TwentyFirstTemplateBinaryFetch;
      templateCompilerProbe?: TwentyFirstTemplateCompilerProbe;
    } = {},
  ) {}

  private createTransport(apiKey: string) {
    const timeoutMs = this.options.timeoutMs ?? TWENTY_FIRST_REQUEST_TIMEOUT_MS;
    return new StreamableHTTPClientTransport(
      new URL(TWENTY_FIRST_MCP_ENDPOINT),
      {
        requestInit: { headers: { "x-api-key": apiKey } },
        fetch: createBoundedFetch(
          this.options.fetchImpl ?? fetch,
          timeoutMs,
          this.options.maxResponseBytes ?? TWENTY_FIRST_MAX_RESPONSE_BYTES,
          {
            maxRetries: this.options.maxHttpRetries,
            maxRetryAfterMs: this.options.maxRetryAfterMs,
            sleep: this.options.sleep,
          },
        ),
        reconnectionOptions: {
          initialReconnectionDelay: 250,
          maxReconnectionDelay: 1_000,
          reconnectionDelayGrowFactor: 1.5,
          maxRetries: 0,
        },
      },
    );
  }

  private requestOptions(totalSignal: AbortSignal) {
    const timeoutMs = this.options.timeoutMs ?? TWENTY_FIRST_REQUEST_TIMEOUT_MS;
    return {
      timeout: timeoutMs,
      maxTotalTimeout: timeoutMs,
      signal: AbortSignal.any([totalSignal, AbortSignal.timeout(timeoutMs)]),
    } as const;
  }

  private async listAdvertisedTools(client: Client, totalSignal: AbortSignal) {
    const tools: TwentyFirstAdvertisedTool[] = [];
    const seenCursors = new Set<string>();
    let cursor: string | undefined;
    for (
      let page = 0;
      page < TWENTY_FIRST_MAX_TOOL_PAGES &&
      tools.length < TWENTY_FIRST_MAX_TOOLS;
      page += 1
    ) {
      const listed = await client.listTools(
        cursor ? { cursor } : {},
        this.requestOptions(totalSignal),
      );
      assertTwentyFirstJsonDepth(listed);
      tools.push(
        ...(listed.tools.slice(
          0,
          TWENTY_FIRST_MAX_TOOLS - tools.length,
        ) as TwentyFirstAdvertisedTool[]),
      );
      const next =
        typeof listed.nextCursor === "string" && listed.nextCursor.trim()
          ? listed.nextCursor
          : undefined;
      if (!next || seenCursors.has(next)) break;
      seenCursors.add(next);
      cursor = next;
    }
    return tools;
  }

  private nativeTemplateCacheKey(
    templateId: TwentyFirstProviderItemId,
    slug: string,
  ) {
    return `${typeof templateId}:${String(templateId)}:${slug.toLocaleLowerCase("en-US")}`;
  }

  private rememberNativeTemplates(
    templates: readonly TwentyFirstNativeTemplateSummary[],
  ) {
    for (const template of templates) {
      this.nativeTemplateCatalog.set(
        this.nativeTemplateCacheKey(template.templateId, template.slug),
        template,
      );
    }
  }

  private async requestMarketplaceCatalog(signal: AbortSignal) {
    const request = createBoundedFetch(
      this.options.fetchImpl ?? fetch,
      this.options.timeoutMs ?? TWENTY_FIRST_REQUEST_TIMEOUT_MS,
      TWENTY_FIRST_TEMPLATE_JSON_MAX_BYTES,
      {
        maxRetries: this.options.maxHttpRetries,
        maxRetryAfterMs: this.options.maxRetryAfterMs,
        sleep: this.options.sleep,
      },
    );
    const url = new URL(
      TWENTY_FIRST_MARKETPLACE_CATALOG_PATH,
      TWENTY_FIRST_API_ORIGIN,
    );
    url.searchParams.set(
      "input",
      JSON.stringify({
        json: {
          lane: "included",
          sortBy: "recommended",
          limit: TWENTY_FIRST_TEMPLATE_CATALOG_LIMIT,
        },
      }),
    );
    let response: Response;
    try {
      response = await request(url, {
        method: "GET",
        headers: { accept: "application/json" },
        redirect: "error",
        signal,
      });
    } catch {
      throw new TwentyFirstNativeTemplateError("catalog_unavailable");
    }
    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined);
      throw new TwentyFirstNativeTemplateError("catalog_unavailable");
    }
    try {
      const value = (await response.json()) as unknown;
      assertTwentyFirstJsonDepth(value);
      const templates = projectTwentyFirstMarketplaceTemplateSummaries(value);
      if (templates.length === 0) {
        throw new TwentyFirstNativeTemplateError("catalog_unavailable");
      }
      this.nativeTemplateCatalog.clear();
      this.rememberNativeTemplates(templates);
      return templates;
    } catch {
      throw new TwentyFirstNativeTemplateError("catalog_unavailable");
    }
  }

  private nativeTemplateSourceUrl(template: TwentyFirstNativeTemplateSummary) {
    return `${TWENTY_FIRST_CODELOAD_ORIGIN}/${encodeURIComponent(template.sourceOwner)}/${encodeURIComponent(template.sourceRepo)}/zip/${template.sourceCommitSha}`;
  }

  private async probeNativeTemplateReadiness(input: {
    totalSignal: AbortSignal;
  }): Promise<TwentyFirstNativeTemplateReadiness> {
    try {
      const templates = await this.requestMarketplaceCatalog(input.totalSignal);
      const template = templates[0]!;
      const prefix = await (
        this.options.templateBinaryFetch ?? defaultTemplateBinaryFetch
      )({
        url: this.nativeTemplateSourceUrl(template),
        mode: "probe",
        signal: input.totalSignal,
        maxBytes: 4_096,
      });
      if (!hasZipLocalFileHeader(prefix)) return "download_unavailable";
      // Catalog readiness means that the immutable Template source can be
      // fetched as data. It must not depend on Vite or Chromium: candidate
      // generation does not execute provider source, and the selected output
      // is compiled only after Manus returns it through the hard-safety gate.
      return "ready";
    } catch (error) {
      if (error instanceof TwentyFirstNativeTemplateError) {
        return error.category;
      }
      if (error instanceof AuthServiceError) throw error;
      if (error instanceof TwentyFirstToolContractError) {
        return "catalog_unavailable";
      }
      return "unverified";
    }
  }

  private async probeNativeVisualReadiness(input: {
    client: Client;
    totalSignal: AbortSignal;
    search: TwentyFirstAdvertisedTool;
    getComponent: TwentyFirstAdvertisedTool | undefined;
    getUsage: TwentyFirstAdvertisedTool | undefined;
  }): Promise<TwentyFirstNativeVisualReadiness> {
    const advertisedReadiness = nativeVisualReadinessForTools(
      input.search,
      input.getComponent,
    );
    if (advertisedReadiness !== "ready" || !input.getComponent) {
      return advertisedReadiness;
    }
    const call = async (
      tool: TwentyFirstAdvertisedTool,
      args: Record<string, unknown>,
    ) => {
      const result = await input.client.callTool(
        { name: tool.name, arguments: args },
        undefined,
        this.requestOptions(input.totalSignal),
      );
      assertTwentyFirstJsonDepth(result);
      return result as Record<string, unknown>;
    };

    if (
      input.getUsage &&
      input.getUsage.annotations?.destructiveHint !== true &&
      supportsZeroArgumentCall(input.getUsage)
    ) {
      try {
        const usage = await call(input.getUsage, {});
        if (usageResultShowsExhaustion(usage)) return "usage_unavailable";
        // Human-readable/unknown usage text is deliberately not interpreted.
        // The source probe below remains the authoritative readiness check.
      } catch {
        // get_usage is optional and its output contract is not stable. A
        // failed usage read must not replace the concrete source probe.
      }
    }

    try {
      const searchType = preferredSearchTypeForTool(input.search);
      const searchArgs = buildTwentyFirstToolArguments({
        operation: "search",
        tool: input.search,
        value: "responsive enterprise landing page",
        limit: 1,
        searchType,
      });
      const searchResult = await call(input.search, searchArgs);
      if (searchResult.isError === true) return "unverified";
      const searchPayload = projectTwentyFirstToolPayload(
        searchResult,
        "search",
      );
      const providerItemId = firstProviderItemId(searchPayload);
      if (providerItemId === null) return "unverified";
      const componentArgs = buildTwentyFirstToolArguments({
        operation: "get_component",
        tool: input.getComponent,
        value: providerItemId,
      });
      const componentResult = await call(input.getComponent, componentArgs);
      const sourcePayload = projectTwentyFirstToolPayload(
        componentResult,
        "get_component",
      );
      if (
        sourcePayload &&
        typeof sourcePayload === "object" &&
        !Array.isArray(sourcePayload) &&
        "sourceText" in sourcePayload
      ) {
        const sourceText = (sourcePayload as { sourceText?: unknown })
          .sourceText;
        if (
          typeof sourceText !== "string" ||
          !/```(?:tsx|jsx|ts|js)(?:[^\r\n]*)\r?\n[\s\S]+?\r?\n```/u.test(
            sourceText,
          )
        ) {
          return "source_contract_incompatible";
        }
      }
      return "ready";
    } catch (error) {
      if (error instanceof TwentyFirstNativeSourceContractError) {
        if (error.nativeCode === "NATIVE_SOURCE_QUOTA_UNAVAILABLE") {
          return "usage_unavailable";
        }
        if (error.nativeCode === "NATIVE_SOURCE_CANDIDATES_UNAVAILABLE") {
          return "unverified";
        }
        return "source_contract_incompatible";
      }
      if (error instanceof TwentyFirstToolContractError) {
        return "source_contract_incompatible";
      }
      return "unverified";
    }
  }

  async inspectCapabilities(
    apiKey: string,
  ): Promise<TwentyFirstConnectionResult> {
    const value = validateTwentyFirstApiKeyInput(apiKey);
    const timeoutMs = this.options.timeoutMs ?? TWENTY_FIRST_REQUEST_TIMEOUT_MS;
    const client = new Client(
      { name: "frontmind-dashboard", version: "1.1.0" },
      { capabilities: {} },
    );
    const transport = this.createTransport(value);
    try {
      const totalSignal = AbortSignal.timeout(
        this.options.totalTimeoutMs ?? TWENTY_FIRST_TOTAL_TIMEOUT_MS,
      );
      await client.connect(transport, this.requestOptions(totalSignal));
      const tools = await this.listAdvertisedTools(client, totalSignal);
      const byName = new Map<string, TwentyFirstAdvertisedTool>();
      for (const tool of tools) {
        if (!byName.has(tool.name)) byName.set(tool.name, tool);
      }
      const search = byName.get("search");
      if (!search || search.annotations?.destructiveHint === true) {
        throw new AuthServiceError(
          "INVALID_CREDENTIAL",
          "当前 21st 连接缺少安全的 search 能力",
        );
      }
      const getComponent = byName.get("get_component");
      // The component readiness projection is retained only for legacy V5
      // consumers. New native website candidates use the independently
      // advertised Template catalog and never read get_component here.
      const nativeVisualReadiness = nativeVisualReadinessForTools(
        search,
        getComponent,
      );
      const nativeTemplateReadiness = await this.probeNativeTemplateReadiness({
        totalSignal,
      });
      const optionalCapability = (name: string) => {
        const tool = byName.get(name);
        return Boolean(tool && tool.annotations?.destructiveHint !== true);
      };
      const server = client.getServerVersion();
      return {
        ok: true,
        endpoint: TWENTY_FIRST_MCP_ENDPOINT,
        capabilities: {
          search: true,
          getComponent: optionalCapability("get_component"),
          getUsage: optionalCapability("get_usage"),
          getTheme: optionalCapability("get_theme"),
        },
        nativeVisualReadiness,
        nativeTemplateReadiness,
        server: server ? { name: server.name, version: server.version } : null,
      };
    } catch (error) {
      // Template catalog callers need the closed entitlement/catalog category
      // to render an actionable retry state. This class carries no provider
      // payload or secret, so preserve it across the shared MCP session.
      if (error instanceof TwentyFirstNativeTemplateError) throw error;
      throw toTwentyFirstConnectionError(error);
    } finally {
      await client.close().catch(() => undefined);
    }
  }

  /**
   * Lists verified, hosted Templates from 21st's first-party Marketplace
   * directory. The request is fixed to the included/recommended lane and never
   * contains customer, Brief or knowledge-base text.
   */
  async listNativeTemplates(
    apiKey: string,
    options: {
      limit?: number;
      signal?: AbortSignal;
      excludeTemplateIds?: readonly string[];
      excludeSlugs?: readonly string[];
    } = {},
  ): Promise<TwentyFirstNativeTemplateSummary[]> {
    validateTwentyFirstApiKeyInput(apiKey);
    const requestedLimit =
      options.limit ?? TWENTY_FIRST_TEMPLATE_DISCOVERY_LIMIT;
    if (
      !Number.isSafeInteger(requestedLimit) ||
      requestedLimit < 1 ||
      requestedLimit > TWENTY_FIRST_TEMPLATE_CATALOG_LIMIT
    ) {
      throw new AuthServiceError(
        "INVALID_CREDENTIAL",
        "21st Template 目录数量参数无效",
      );
    }
    const limit = requestedLimit as number;
    const timeoutSignal = AbortSignal.timeout(
      this.options.totalTimeoutMs ?? TWENTY_FIRST_TOTAL_TIMEOUT_MS,
    );
    const signal = options.signal
      ? AbortSignal.any([options.signal, timeoutSignal])
      : timeoutSignal;
    const excludedTemplateIds = new Set(
      (options.excludeTemplateIds ?? [])
        .filter((value) => typeof value === "string" && value.length <= 191)
        .slice(0, TWENTY_FIRST_TEMPLATE_CATALOG_LIMIT),
    );
    const excludedSlugs = new Set(
      (options.excludeSlugs ?? [])
        .map((value) => safeTemplateSlug(value))
        .filter((value): value is string => Boolean(value))
        .map((value) => value.toLocaleLowerCase("en-US"))
        .slice(0, TWENTY_FIRST_TEMPLATE_CATALOG_LIMIT),
    );
    const catalog = await this.requestMarketplaceCatalog(signal);
    const filtered = catalog.filter(
      (template) =>
        !excludedTemplateIds.has(String(template.templateId)) &&
        !excludedSlugs.has(template.slug.toLocaleLowerCase("en-US")),
    );
    if (filtered.length === 0) {
      throw new TwentyFirstNativeTemplateError("catalog_unavailable");
    }
    return filtered
      .slice(0, limit)
      .map((template, sortRank) => ({ ...template, sortRank }));
  }

  /** Downloads an immutable Marketplace source archive at its exact commit. */
  async downloadNativeTemplate(
    apiKey: string,
    input: {
      templateId: TwentyFirstProviderItemId;
      slug: string;
      version?: string | null;
      sourceOwner?: string;
      sourceRepo?: string;
      sourceCommitSha?: string;
      sourceSubdirectory?: string | null;
      sourceLicense?: "MIT" | "Apache-2.0";
      signal?: AbortSignal;
    },
  ): Promise<TwentyFirstNativeTemplateArchive> {
    validateTwentyFirstApiKeyInput(apiKey);
    const templateId = safeProviderItemId(input.templateId);
    const slug = safeTemplateSlug(input.slug);
    const expectedVersion =
      input.version === null || input.version === undefined
        ? null
        : safeTemplateVersion(input.version);
    if (
      templateId === null ||
      !slug ||
      (input.version !== null &&
        input.version !== undefined &&
        expectedVersion === null)
    ) {
      throw new TwentyFirstNativeTemplateError("download_unavailable");
    }
    const timeoutSignal = AbortSignal.timeout(
      this.options.totalTimeoutMs ?? TWENTY_FIRST_TEMPLATE_DIRECT_TIMEOUT_MS,
    );
    const signal = input.signal
      ? AbortSignal.any([input.signal, timeoutSignal])
      : timeoutSignal;
    const cacheKey = this.nativeTemplateCacheKey(templateId, slug);
    let template = this.nativeTemplateCatalog.get(cacheKey);
    if (!template) {
      const catalog = await this.requestMarketplaceCatalog(signal);
      template = catalog.find(
        (candidate) =>
          String(candidate.templateId) === String(templateId) &&
          candidate.slug === slug,
      );
    }
    const inputSubdirectory = safeSourceSubdirectory(input.sourceSubdirectory);
    if (
      !template ||
      (expectedVersion !== null &&
        template.sourceCommitSha !== expectedVersion) ||
      (input.sourceOwner !== undefined &&
        safeGithubOwner(input.sourceOwner) !== template.sourceOwner) ||
      (input.sourceRepo !== undefined &&
        safeGithubRepo(input.sourceRepo) !== template.sourceRepo) ||
      (input.sourceCommitSha !== undefined &&
        safeGithubCommitSha(input.sourceCommitSha) !==
          template.sourceCommitSha) ||
      (input.sourceSubdirectory !== undefined &&
        inputSubdirectory !== template.sourceSubdirectory) ||
      (input.sourceLicense !== undefined &&
        input.sourceLicense !== template.sourceLicense)
    ) {
      throw new TwentyFirstNativeTemplateError("download_unavailable");
    }
    let archive: Uint8Array;
    try {
      archive = await (
        this.options.templateBinaryFetch ?? defaultTemplateBinaryFetch
      )({
        url: this.nativeTemplateSourceUrl(template),
        mode: "full",
        signal,
        maxBytes: TWENTY_FIRST_TEMPLATE_ARCHIVE_MAX_BYTES,
      });
    } catch (error) {
      if (error instanceof TwentyFirstNativeTemplateError) throw error;
      throw new TwentyFirstNativeTemplateError("download_unavailable", true);
    }
    if (
      archive.byteLength === 0 ||
      archive.byteLength > TWENTY_FIRST_TEMPLATE_ARCHIVE_MAX_BYTES ||
      !hasZipLocalFileHeader(archive)
    ) {
      throw new TwentyFirstNativeTemplateError("download_unavailable");
    }
    return {
      templateId,
      slug,
      version: template.sourceCommitSha,
      archive,
      sha256: createHash("sha256").update(archive).digest("hex"),
      contentType: "application/zip",
      sourceUrlOrigin: TWENTY_FIRST_CODELOAD_ORIGIN,
      sourceSubdirectory: template.sourceSubdirectory,
    };
  }

  /**
   * Opens one bounded read-only MCP session. The callback can invoke only the
   * exact existing-catalog tools discovered from tools/list. Optional catalog
   * capabilities are exposed only when the server advertises them as
   * non-destructive. SiteOps workflow 2.5 requires get_component to retrieve
   * the source behind a candidate; immutable older workflows remain
   * search-preview based.
   */
  async withReadOnlySession<T>(
    apiKey: string,
    use: (session: TwentyFirstReadOnlySession) => Promise<T>,
    options: { signal?: AbortSignal } = {},
  ): Promise<T> {
    const value = validateTwentyFirstApiKeyInput(apiKey);
    const totalTimeoutMs =
      this.options.totalTimeoutMs ?? TWENTY_FIRST_TOTAL_TIMEOUT_MS;
    const totalTimeout = AbortSignal.timeout(totalTimeoutMs);
    const totalSignal = options.signal
      ? AbortSignal.any([options.signal, totalTimeout])
      : totalTimeout;
    const client = new Client(
      { name: "frontmind-dashboard-siteops", version: "1.1.0" },
      { capabilities: {} },
    );
    const transport = this.createTransport(value);
    try {
      await client.connect(transport, this.requestOptions(totalSignal));
      const tools = await this.listAdvertisedTools(client, totalSignal);
      const byName = new Map<string, TwentyFirstAdvertisedTool>();
      for (const tool of tools) {
        if (!byName.has(tool.name)) byName.set(tool.name, tool);
      }
      const search = byName.get("search");
      const getComponent = byName.get("get_component");
      if (!search) {
        throw new AuthServiceError(
          "INVALID_CREDENTIAL",
          "当前 21st 连接缺少 search 能力",
        );
      }
      if (search.annotations?.destructiveHint === true) {
        throw new AuthServiceError(
          "UPSTREAM_UNAVAILABLE",
          "21st 只读工具声明异常",
        );
      }
      const safeGetComponent =
        getComponent?.annotations?.destructiveHint === true
          ? undefined
          : getComponent;
      const preferredSearchType = preferredSearchTypeForTool(search);
      const preferredTemplateSort = preferredTemplateSortForTool(search);
      const searchLimitKey = findToolInputKey(search, [
        "limit",
        "take",
        "pageSize",
        "page_size",
      ]);
      const effectiveSearchLimit = searchLimitKey
        ? boundedSearchLimit(
            search.inputSchema.properties?.[searchLimitKey],
            18,
          )
        : 18;
      const call = async (
        operation: "search" | "get_component",
        tool: TwentyFirstAdvertisedTool,
        argumentValue: string | TwentyFirstProviderItemId,
        limit?: number,
        searchOptions?: Pick<TwentyFirstSearchRequest, "tag" | "sort">,
        searchType?: TwentyFirstSearchRequest["type"],
      ) => {
        const args = buildTwentyFirstToolArguments({
          operation,
          tool,
          value: argumentValue,
          limit,
          searchType,
          searchOptions,
        });
        const result = await client.callTool(
          { name: tool.name, arguments: args },
          undefined,
          this.requestOptions(totalSignal),
        );
        assertTwentyFirstJsonDepth(result);
        if (result.isError === true && operation === "search") {
          throw new AuthServiceError(
            "UPSTREAM_UNAVAILABLE",
            "21st 目录查询暂时不可用",
          );
        }
        const payload = projectTwentyFirstToolPayload(
          result as Record<string, unknown>,
          operation,
        );
        assertTwentyFirstJsonDepth(payload);
        return payload;
      };
      return await use({
        effectiveSearchLimit,
        preferredSearchType,
        preferredTemplateSort,
        search: (input) => {
          return call(
            "search",
            search,
            input.query,
            input.limit,
            { tag: input.tag, sort: input.sort },
            input.type,
          );
        },
        ...(safeGetComponent
          ? {
              getComponent: (providerItemId: TwentyFirstProviderItemId) =>
                call("get_component", safeGetComponent, providerItemId),
            }
          : {}),
      });
    } catch (error) {
      if (error instanceof TwentyFirstNativeTemplateError) throw error;
      throw toTwentyFirstConnectionError(error);
    } finally {
      await client.close().catch(() => undefined);
    }
  }
}

type TwentyFirstCredentialInspectionCache = {
  credentialId: string;
  version: number;
  fingerprint: string;
  connection: TwentyFirstConnectionResult;
  checkedAt: number;
};

let twentyFirstCredentialInspectionCache:
  | TwentyFirstCredentialInspectionCache
  | undefined;

function rememberTwentyFirstCredentialInspection(
  credential: Pick<PresalesApiCredential, "id" | "version" | "fingerprint">,
  connection: TwentyFirstConnectionResult,
) {
  twentyFirstCredentialInspectionCache = {
    credentialId: credential.id,
    version: credential.version,
    fingerprint: credential.fingerprint,
    connection,
    checkedAt: Date.now(),
  };
}

function cachedTwentyFirstCredentialInspection(
  credential: Pick<PresalesApiCredential, "id" | "version" | "fingerprint">,
) {
  const cached = twentyFirstCredentialInspectionCache;
  return cached &&
    cached.credentialId === credential.id &&
    cached.version === credential.version &&
    cached.fingerprint === credential.fingerprint &&
    Date.now() - cached.checkedAt <= TWENTY_FIRST_STATUS_REVALIDATION_TTL_MS
    ? cached.connection
    : null;
}

function toCredentialStatus(
  credential?: PresalesApiCredential | null,
  capabilities?: TwentyFirstCapabilities,
  nativeVisualReadiness: TwentyFirstNativeVisualReadiness = "unverified",
  nativeTemplateReadiness: TwentyFirstNativeTemplateReadiness = "unverified",
): TwentyFirstCredentialStatus {
  const visible = Boolean(credential && credential.status !== "deleted");
  const configured = Boolean(
    credential &&
      credential.status === "active" &&
      credential.validationStatus === "verified",
  );
  const status =
    !credential || credential.status === "deleted"
      ? null
      : credential.validationStatus === "invalid"
        ? "invalid"
        : credential.status;
  return {
    configured,
    revocationPending: Boolean(
      credential &&
        credential.status !== "deleted" &&
        credential.validationStatus === "invalid",
    ),
    fingerprint: visible ? (credential?.fingerprint ?? null) : null,
    status,
    version: visible ? (credential?.version ?? null) : null,
    verifiedAt: visible ? (credential?.verifiedAt?.getTime() ?? null) : null,
    updatedAt: visible ? (credential?.updatedAt?.getTime() ?? null) : null,
    nativeVisualReadiness,
    nativeTemplateReadiness,
    capabilities:
      capabilities ??
      (configured
        ? {
            search: true,
            getComponent: false,
            getUsage: null,
            getTheme: null,
          }
        : {
            search: false,
            getComponent: false,
            getUsage: null,
            getTheme: null,
          }),
  };
}

export async function getTwentyFirstCredentialStatus(
  inspect: (apiKey: string) => Promise<TwentyFirstConnectionResult> = (value) =>
    new TwentyFirstClient().inspectCapabilities(value),
) {
  const db = await requireDb();
  const rows = await db
    .select()
    .from(presalesApiCredentials)
    .where(
      and(
        eq(presalesApiCredentials.slot, TWENTY_FIRST_CREDENTIAL_SLOT),
        ne(presalesApiCredentials.status, "deleted"),
      ),
    )
    .orderBy(desc(presalesApiCredentials.version))
    .limit(1);
  const credential = rows[0];
  if (
    !credential ||
    credential.status !== "active" ||
    credential.validationStatus !== "verified"
  ) {
    return toCredentialStatus(credential);
  }
  const cached = cachedTwentyFirstCredentialInspection(credential);
  if (cached) {
    return toCredentialStatus(
      credential,
      cached.capabilities,
      cached.nativeVisualReadiness,
      cached.nativeTemplateReadiness,
    );
  }
  try {
    const connection = await inspect(decryptTwentyFirstApiKey(credential));
    rememberTwentyFirstCredentialInspection(credential, connection);
    return toCredentialStatus(
      credential,
      connection.capabilities,
      connection.nativeVisualReadiness,
      connection.nativeTemplateReadiness,
    );
  } catch (error) {
    const nativeTemplateReadiness =
      error instanceof TwentyFirstNativeTemplateError
        ? error.category
        : "unverified";
    return toCredentialStatus(
      credential,
      undefined,
      "unverified",
      nativeTemplateReadiness,
    );
  }
}

export async function replaceTwentyFirstApiCredential(
  actorUserId: number,
  apiKey: string,
  inspect: (apiKey: string) => Promise<TwentyFirstConnectionResult> = (value) =>
    new TwentyFirstClient().inspectCapabilities(value),
) {
  const value = validateTwentyFirstApiKeyInput(apiKey);
  const connection = await inspect(value);
  if (connection.nativeTemplateReadiness !== "ready") {
    throw new AuthServiceError(
      connection.nativeTemplateReadiness === "plan_ineligible"
        ? "INVALID_CREDENTIAL"
        : "UPSTREAM_UNAVAILABLE",
      connection.nativeTemplateReadiness === "plan_ineligible"
        ? "当前 21st 账号没有可下载的完整 Template 权限"
        : connection.nativeTemplateReadiness === "download_unavailable"
          ? "当前 21st 完整 Template 下载暂不可用"
          : connection.nativeTemplateReadiness === "compiler_unavailable"
            ? "当前环境无法编译 21st 完整 Template"
            : "当前 21st 完整 Template 目录暂不可用",
    );
  }
  const db = await requireDb();
  const existingRows = await db
    .select()
    .from(presalesApiCredentials)
    .where(
      and(
        eq(presalesApiCredentials.slot, TWENTY_FIRST_CREDENTIAL_SLOT),
        eq(presalesApiCredentials.status, "active"),
      ),
    )
    .orderBy(desc(presalesApiCredentials.version))
    .limit(1);
  const existing = existingRows[0];
  const credentialId = randomUUID();
  const encrypted = encryptTwentyFirstApiKey(credentialId, value);
  const fingerprint = getApiKeyFingerprint(value);
  const now = new Date();

  const inserted = await db.transaction(async (tx) => {
    const active = await tx
      .select({ id: presalesApiCredentials.id })
      .from(presalesApiCredentials)
      .where(
        and(
          eq(presalesApiCredentials.slot, TWENTY_FIRST_CREDENTIAL_SLOT),
          eq(presalesApiCredentials.status, "active"),
        ),
      )
      .orderBy(desc(presalesApiCredentials.version))
      .limit(1)
      .for("update");
    if ((active[0]?.id ?? null) !== (existing?.id ?? null)) {
      throw new AuthServiceError(
        "CONFLICT",
        "21st API Key 状态已变化，请刷新后重试。",
      );
    }
    const latest = await tx
      .select()
      .from(presalesApiCredentials)
      .where(eq(presalesApiCredentials.slot, TWENTY_FIRST_CREDENTIAL_SLOT))
      .orderBy(desc(presalesApiCredentials.version))
      .limit(1)
      .for("update");
    const nextVersion = (latest[0]?.version ?? 0) + 1;
    await tx
      .update(presalesApiCredentials)
      .set({ status: "retired", retiredAt: now })
      .where(
        and(
          eq(presalesApiCredentials.slot, TWENTY_FIRST_CREDENTIAL_SLOT),
          eq(presalesApiCredentials.status, "active"),
        ),
      );
    const credential = {
      id: credentialId,
      slot: TWENTY_FIRST_CREDENTIAL_SLOT,
      version: nextVersion,
      ...encrypted,
      fingerprint,
      status: "active" as const,
      validationStatus: "verified" as const,
      createdByUserId: actorUserId,
      verifiedAt: now,
      retiredAt: null,
      deletedAt: null,
      createdAt: now,
      updatedAt: now,
    };
    await tx.insert(presalesApiCredentials).values(credential);
    return credential;
  });
  rememberTwentyFirstCredentialInspection(inserted, connection);
  return toCredentialStatus(
    inserted,
    connection.capabilities,
    connection.nativeVisualReadiness,
    connection.nativeTemplateReadiness,
  );
}

export async function getActiveTwentyFirstCredential() {
  const db = await requireDb();
  const rows = await db
    .select()
    .from(presalesApiCredentials)
    .where(
      and(
        eq(presalesApiCredentials.slot, TWENTY_FIRST_CREDENTIAL_SLOT),
        eq(presalesApiCredentials.status, "active"),
        eq(presalesApiCredentials.validationStatus, "verified"),
      ),
    )
    .orderBy(desc(presalesApiCredentials.version))
    .limit(1);
  const credential = rows[0];
  if (!credential) return null;
  return {
    id: credential.id,
    version: credential.version,
    fingerprint: credential.fingerprint,
    apiKey: decryptTwentyFirstApiKey(credential),
  };
}

export async function getTwentyFirstCredentialById(credentialId: string) {
  const db = await requireDb();
  const rows = await db
    .select()
    .from(presalesApiCredentials)
    .where(
      and(
        eq(presalesApiCredentials.id, credentialId),
        eq(presalesApiCredentials.slot, TWENTY_FIRST_CREDENTIAL_SLOT),
        ne(presalesApiCredentials.status, "deleted"),
      ),
    )
    .limit(1);
  const credential = rows[0];
  if (!credential) return null;
  return {
    id: credential.id,
    version: credential.version,
    fingerprint: credential.fingerprint,
    apiKey: decryptTwentyFirstApiKey(credential),
  };
}

export async function testTwentyFirstApiCredential(
  apiKey?: string,
  inspect: (apiKey: string) => Promise<TwentyFirstConnectionResult> = (value) =>
    new TwentyFirstClient().inspectCapabilities(value),
) {
  const credential = apiKey ? null : await getActiveTwentyFirstCredential();
  const value = apiKey?.trim() || credential?.apiKey;
  if (!value) {
    throw new AuthServiceError("NOT_FOUND", "请先配置 21st API Key");
  }
  return inspect(value);
}

/**
 * SiteOps supplies a probe backed by its operation table. Keeping the probe
 * injectable avoids coupling the service-wide credential store to SiteOps'
 * lease/state implementation while still making deletion fail closed.
 */
export async function deleteTwentyFirstApiCredential(
  hasActiveConsumers: TwentyFirstActiveConsumerProbe = hasActiveTwentyFirstConsumers,
  executor?: any,
) {
  const db = executor ?? (await requireDb());
  const remove = async (tx: any) => {
    const retainedRows = await tx
      .select({
        id: presalesApiCredentials.id,
        status: presalesApiCredentials.status,
      })
      .from(presalesApiCredentials)
      .where(
        and(
          eq(presalesApiCredentials.slot, TWENTY_FIRST_CREDENTIAL_SLOT),
          ne(presalesApiCredentials.status, "deleted"),
        ),
      )
      .for("update");
    if (retainedRows.length === 0) {
      return { deleted: false, pending: false } as const;
    }
    const retainedIds = retainedRows.map((row: { id: string }) => row.id);
    const now = new Date();
    if (await hasActiveConsumers(retainedIds, tx)) {
      await tx
        .update(presalesApiCredentials)
        .set({ validationStatus: "invalid", updatedAt: now })
        .where(
          and(
            eq(presalesApiCredentials.slot, TWENTY_FIRST_CREDENTIAL_SLOT),
            ne(presalesApiCredentials.status, "deleted"),
            inArray(presalesApiCredentials.id, retainedIds),
          ),
        );
      return { deleted: false, pending: true } as const;
    }
    await tx
      .update(presalesApiCredentials)
      .set({
        status: "deleted",
        validationStatus: "unverified",
        deletedAt: now,
        encryptedKey: randomBytes(32).toString("base64"),
        encryptionIv: randomBytes(12).toString("base64"),
        encryptionAuthTag: randomBytes(16).toString("base64"),
      })
      .where(
        and(
          eq(presalesApiCredentials.slot, TWENTY_FIRST_CREDENTIAL_SLOT),
          ne(presalesApiCredentials.status, "deleted"),
          inArray(presalesApiCredentials.id, retainedIds),
        ),
      );
    return { deleted: true, pending: false } as const;
  };
  if (executor) return remove(db);
  return db.transaction(remove);
}

/**
 * Completes an already requested revocation after every frozen visual task is
 * terminal. Only versions marked invalid by the prior delete request are
 * shredded, so a newer replacement credential can never be removed here.
 */
export async function finalizePendingTwentyFirstCredentialRevocations(
  hasActiveConsumers: TwentyFirstActiveConsumerProbe = hasActiveTwentyFirstConsumers,
  executor?: any,
) {
  const db = executor ?? (await requireDb());
  const finalize = async (tx: any) => {
    const rows = await tx
      .select({ id: presalesApiCredentials.id })
      .from(presalesApiCredentials)
      .where(
        and(
          eq(presalesApiCredentials.slot, TWENTY_FIRST_CREDENTIAL_SLOT),
          eq(presalesApiCredentials.validationStatus, "invalid"),
          ne(presalesApiCredentials.status, "deleted"),
        ),
      )
      .for("update");
    const ids = rows.map((row: { id: string }) => row.id);
    if (ids.length === 0) return { deleted: 0, pending: false };
    if (await hasActiveConsumers(ids, tx)) {
      return { deleted: 0, pending: true };
    }
    const now = new Date();
    await tx
      .update(presalesApiCredentials)
      .set({
        status: "deleted",
        validationStatus: "unverified",
        deletedAt: now,
        encryptedKey: randomBytes(32).toString("base64"),
        encryptionIv: randomBytes(12).toString("base64"),
        encryptionAuthTag: randomBytes(16).toString("base64"),
        updatedAt: now,
      })
      .where(
        and(
          eq(presalesApiCredentials.slot, TWENTY_FIRST_CREDENTIAL_SLOT),
          inArray(presalesApiCredentials.id, ids),
        ),
      );
    return { deleted: ids.length, pending: false };
  };
  if (executor) return finalize(db);
  return db.transaction(finalize);
}
