import { createHash } from "node:crypto";
import type { Readable } from "node:stream";

import axios, { type AxiosInstance, type AxiosResponse } from "axios";

import {
  classifyProviderValidationCoordinate,
  safeProviderRequestReference,
} from "./provider-diagnostic-safety";
import {
  upstreamAliasedIdentity,
  upstreamTaskRecord,
} from "./upstream-task-adapter";
import { classifyManusV2StructuredResultEnvelope } from "./manus-v2-structured-result";
import { stripFrontMindGeneralChatOperationContract } from "../shared/frontmind-general-chat-contract";
import {
  generalChatProviderEvidenceHasUniqueMatch,
  resolveManusV2GeneralChatUserEventEvidence,
  type GeneralChatLocalAttachmentManifestItem,
  type GeneralChatProviderAttachmentReader,
} from "./manus-v2-user-attachment-evidence";

export {
  classifyManusV2StructuredResultEnvelope,
  type ManusV2StructuredResultEnvelope,
} from "./manus-v2-structured-result";

const DEFAULT_TIMEOUT_MS = 120_000;
const MAX_RESPONSE_BYTES = 8 * 1024 * 1024;
const MAX_PAGES = 100;
const MANUS_V2_RATE_LIMIT_WINDOW_MS = 60_000;

export const MANUS_V2_DEFAULT_RATE_LIMIT_SCOPE = "manus-account:unknown-global";

export const MANUS_V2_RATE_LIMITS = Object.freeze({
  /** Manus documents 10 create/send requests per minute. Keep 10% headroom. */
  taskWrite: 9,
  /** Manus documents 100 task/file reads per minute. Keep 10% headroom. */
  read: 90,
  /** Manus documents 40 file writes per minute. Keep 10% headroom. */
  fileWrite: 36,
});

export type ManusV2RateLimitLane = keyof typeof MANUS_V2_RATE_LIMITS;

export type ManusV2RateLimiter = {
  acquire(input: { scope: string; lane: ManusV2RateLimitLane }): Promise<void>;
};

type ManusV2RateLimitState = {
  acceptedAt: number[];
  tail: Promise<void>;
};

/**
 * Process-wide, account-scoped sliding-window limiter. A scope is deliberately
 * independent of API-key identity: rotating or adding a key must not create a
 * fresh provider allowance. The default scope therefore puts every caller
 * that has not yet resolved its Manus account into one conservative bucket.
 */
export function createManusV2AccountRateLimiter(
  input: {
    now?: () => number;
    sleep?: (ms: number) => Promise<void>;
    windowMs?: number;
  } = {},
): ManusV2RateLimiter {
  const now = input.now ?? Date.now;
  const sleep =
    input.sleep ??
    ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const windowMs = input.windowMs ?? MANUS_V2_RATE_LIMIT_WINDOW_MS;
  if (!Number.isSafeInteger(windowMs) || windowMs < 1) {
    throw new Error("Invalid Manus v2 rate-limit window");
  }
  const states = new Map<string, ManusV2RateLimitState>();

  return {
    async acquire({ scope, lane }) {
      const key = `${scope}\0${lane}`;
      let state = states.get(key);
      if (!state) {
        state = { acceptedAt: [], tail: Promise.resolve() };
        states.set(key, state);
      }

      // Serialize admission for one account/lane. This makes concurrent
      // callers deterministic and prevents a burst from all observing the
      // same last free slot.
      const previous = state.tail.catch(() => undefined);
      let release!: () => void;
      state.tail = new Promise<void>((resolve) => {
        release = resolve;
      });
      await previous;
      try {
        for (;;) {
          const observedNow = now();
          if (!Number.isSafeInteger(observedNow) || observedNow < 0) {
            throw new Error("Invalid Manus v2 rate-limit clock");
          }
          const cutoff = observedNow - windowMs;
          while (
            state.acceptedAt.length > 0 &&
            state.acceptedAt[0]! <= cutoff
          ) {
            state.acceptedAt.shift();
          }
          const limit = MANUS_V2_RATE_LIMITS[lane];
          if (state.acceptedAt.length < limit) {
            state.acceptedAt.push(observedNow);
            return;
          }
          const retryAt = state.acceptedAt[0]! + windowMs;
          await sleep(Math.max(1, retryAt - observedNow));
        }
      } finally {
        release();
      }
    },
  };
}

const sharedManusV2AccountRateLimiter = createManusV2AccountRateLimiter();
const noopManusV2RateLimiter: ManusV2RateLimiter = {
  async acquire() {},
};

function normalizeManusV2RateLimitScope(value: string | undefined) {
  if (value === undefined) return MANUS_V2_DEFAULT_RATE_LIMIT_SCOPE;
  const scope = requiredString(value, "rateLimitScope", 255);
  if (!/^[A-Za-z0-9][A-Za-z0-9:._/-]*$/u.test(scope)) {
    throw new Error("Invalid Manus v2 rate-limit scope");
  }
  return scope;
}

function manusV2RateLimitLane(
  operation: string,
  sideEffect: boolean,
): ManusV2RateLimitLane {
  if (operation.startsWith("file.") && sideEffect) return "fileWrite";
  return sideEffect ? "taskWrite" : "read";
}

export type ManusV2Attachment =
  | {
      file_id: string;
      filename: string;
      file_data?: never;
      mime_type?: never;
    }
  | {
      /** Official Manus v2 inline-file data URL (decoded payload <= 20 MiB). */
      file_data: string;
      filename: string;
      mime_type: string;
      file_id?: never;
    };

export type ManusV2CreatedFile = {
  fileId: string;
  filename: string;
  uploadUrl: string;
  uploadExpiresAt: number;
  requestId: string | null;
};

/**
 * Durable callers use these awaited boundaries to journal the provider file
 * before any signed-URL PUT can begin. Observer failures deliberately abort
 * the upload: the caller's earlier `creating` fence then prevents a second
 * file.create after a database outage or process crash.
 */
export type ManusV2FileUploadObserver = {
  onCandidateCreated?: (file: ManusV2CreatedFile) => Promise<void>;
  onPutStarted?: (file: ManusV2CreatedFile) => Promise<void>;
  onPutAccepted?: (file: ManusV2CreatedFile) => Promise<void>;
  onPutRejected?: (
    file: ManusV2CreatedFile,
    rejection: { status: number; code: string },
  ) => Promise<void>;
  onPutRetryWait?: (
    file: ManusV2CreatedFile,
    rejection: {
      status: number;
      code: string;
      retryAfterMs: number | null;
      rejectionCount: number;
      nextRetryAt: string;
    },
  ) => Promise<void>;
  onPutOutcomeUnknown?: (file: ManusV2CreatedFile) => Promise<void>;
  /**
   * The PUT candidate is durable, but Provider readiness could not be proven
   * inside the bounded confirmation window. This is intentionally distinct
   * from a lost PUT response so durable callers can journal the exact phase.
   */
  onConfirmationUnknown?: (file: ManusV2CreatedFile) => Promise<void>;
};

export type ManusV2ProviderFileDetail = {
  fileId: string;
  filename: string;
  status: "pending" | "uploaded" | "deleted" | "error";
  bytes: number | null;
  expiresAt: number;
  contentType: string | null;
  /**
   * Provider MIME is optional diagnostic evidence. Keeping its parse status
   * separate lets frozen-source consumers distinguish a missing value from a
   * malformed value without rejecting the otherwise valid file envelope.
   */
  contentTypeParseStatus: "valid" | "missing" | "invalid";
  requestId: string | null;
};

export type ManusV2FileConfirmationPolicy =
  | "strict"
  | "kb_frozen_source_advisory";

export type ProviderMimeDisposition =
  | "exact"
  | "generic"
  | "missing"
  | "invalid"
  | "different";

export type ManusV2WaitForExactProviderFileInput = {
  fileId: string;
  filename: string;
  expectedBytes: number;
  expectedContentType: string;
  confirmationPolicy?: ManusV2FileConfirmationPolicy;
  minimumUsableSeconds?: number;
  readinessDeadlineMs?: number;
  detailAttemptTimeoutMs?: number;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  observer?: ManusV2FileUploadObserver;
  candidate?: ManusV2CreatedFile;
};

export type ManusV2StructuredOutputSchema = Record<string, unknown>;

export const MANUS_V2_KNOWLEDGE_BASE_RESULT_SCHEMA_VERSION = 1;

export type ManusV2KnowledgeBaseAction =
  | "start"
  | "confirm"
  | "direct_prefill"
  | "revise"
  | "retry"
  | "legacy_reconcile";

export type ManusV2KnowledgeBaseOperationContract = {
  operationToken: string;
  turnId: string;
  generation: number;
  baseRevision: number;
  action: ManusV2KnowledgeBaseAction;
  fromLeafId: string | null;
  expectContentCompleted: boolean;
  requiresManifest: boolean;
};

export type ManusV2KnowledgeBaseStructuredResult = {
  schemaVersion: typeof MANUS_V2_KNOWLEDGE_BASE_RESULT_SCHEMA_VERSION;
  operationToken: string;
  turnId: string;
  generation: number;
  baseRevision: number;
  action: ManusV2KnowledgeBaseAction;
  fromLeafId: string | null;
  nextLeafId: string | null;
  visibleMarkdown: string;
  contentCompleted: boolean;
  /** Required only for an uninitialized build; null on every later turn. */
  manifestJson: string | null;
};

export type ManusV2MessageEvent = Record<string, unknown> & {
  id: string;
  type: string;
  timestamp: number;
  /**
   * Canonical oldest-to-newest position supplied by task.listMessages after
   * pagination and de-duplication. Provider event ids are opaque identities,
   * not clocks, so every equal-timestamp decision must use this rank (or the
   * caller's stable array order for fixtures/legacy callers) instead.
   */
  providerOriginalRank?: number;
};

export type ManusV2TaskSummary = {
  id: string;
  title: string;
  taskUrl: string | null;
  createdAt: number | null;
  updatedAt: number | null;
  creditUsage: number | null;
  status: string | null;
};

export type ManusV2TaskListPage = {
  data: Array<{
    id: string;
    task_id: string;
    title: string;
    instructions: string;
    task_url: string | null;
    created_at: number | null;
    updated_at: number | null;
    credit_usage: number | null;
    status: string | null;
    metadata: { task_title: string; credit_usage: number | null };
  }>;
  has_more: boolean;
  next_cursor: string | null;
  request_id: string | null;
};

export type ManusV2WaitingDetail = {
  eventId: string;
  eventType: string;
  description: string | null;
  confirmInputSchema: Record<string, unknown> | null;
  statusEventId: string;
};

export type ManusV2TransportCause =
  | "dns_temporary"
  | "dns_not_found"
  | "connection_refused"
  | "network_unreachable"
  | "host_unreachable"
  | "connection_reset"
  | "timeout"
  | "tls"
  | "unknown";

export type ManusV2TransportPhase =
  | "dns"
  | "connect"
  | "request"
  | "tls"
  | "timeout"
  | "unknown";

export type ManusV2FileCreateRetryPolicy = "response_logic_pre_dispatch_only";

export class ManusV2ApiError extends Error {
  constructor(
    public readonly operation: string,
    public readonly status: number | null,
    public readonly code: string,
    public readonly retryable: boolean,
    public readonly outcomeUnknown: boolean,
    public readonly providerRequestId: string | null = null,
    /**
     * Only populated when Manus actually supplied a parseable Retry-After
     * header for an explicit rejection.  It is deliberately absent for
     * response-loss/ambiguous responses: those requests must be reconciled,
     * never resent.
     */
    public readonly retryAfterMs: number | null = null,
    public readonly providerField: string | null = null,
    public readonly providerPath: string | null = null,
    public readonly transportCause: ManusV2TransportCause | null = null,
    public readonly transportPhase: ManusV2TransportPhase | null = null,
    public readonly transportAttempt: number | null = null,
    public readonly transportElapsedMs: number | null = null,
    public readonly transportBytesWritten: number | null = null,
  ) {
    super(`Manus v2 ${operation} failed (${code})`);
    this.name = "ManusV2ApiError";
  }
}

type ManusV2TransportDiagnostic = {
  cause: ManusV2TransportCause;
  phase: ManusV2TransportPhase;
  bytesWritten: number | null;
  provablyNotDispatched: boolean;
};

function objectRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

const SAFE_TRANSPORT_CODES = new Set([
  "EAI_AGAIN",
  "ENOTFOUND",
  "ECONNREFUSED",
  "ENETUNREACH",
  "EHOSTUNREACH",
  "ECONNRESET",
  "EPIPE",
  "ETIMEDOUT",
  "ECONNABORTED",
  "EPROTO",
]);

function safeTransportCode(error: unknown) {
  const record = objectRecord(error);
  const cause = objectRecord(record?.cause);
  // Axios may wrap the Node errno in `cause` while exposing a generic
  // ERR_NETWORK code itself. Prefer the lower-level cause when it is safe.
  const candidates = [cause?.code, record?.code].filter(
    (candidate): candidate is string =>
      typeof candidate === "string" &&
      /^[A-Z][A-Z0-9_]{1,63}$/u.test(candidate),
  );
  return (
    candidates.find(
      (candidate) =>
        SAFE_TRANSPORT_CODES.has(candidate) || candidate.startsWith("ERR_TLS_"),
    ) ??
    candidates[0] ??
    null
  );
}

function transportBytesWritten(error: unknown) {
  const record = objectRecord(error);
  const request = objectRecord(record?.request);
  const currentRequest = objectRecord(request?._currentRequest);
  if (request?.reusedSocket === true || currentRequest?.reusedSocket === true) {
    return null;
  }
  const candidates = [
    request?.bytesWritten,
    currentRequest?.bytesWritten,
    objectRecord(request?.socket)?.bytesWritten,
    objectRecord(currentRequest?.socket)?.bytesWritten,
  ].filter(
    (value): value is number =>
      Number.isSafeInteger(value) && Number(value) >= 0,
  );
  if (candidates.length === 0) return null;
  // A positive observation anywhere means the request may have crossed the
  // side-effect boundary. Only unanimous zero observations are safe to replay.
  return candidates.every((value) => value === 0) ? 0 : Math.max(...candidates);
}

function classifyTransportFailure(error: unknown): ManusV2TransportDiagnostic {
  const code = safeTransportCode(error);
  const bytesWritten = transportBytesWritten(error);
  const classified = (() => {
    switch (code) {
      case "EAI_AGAIN":
        return { cause: "dns_temporary", phase: "dns" } as const;
      case "ENOTFOUND":
        return { cause: "dns_not_found", phase: "dns" } as const;
      case "ECONNREFUSED":
        return { cause: "connection_refused", phase: "connect" } as const;
      case "ENETUNREACH":
        return { cause: "network_unreachable", phase: "connect" } as const;
      case "EHOSTUNREACH":
        return { cause: "host_unreachable", phase: "connect" } as const;
      case "ECONNRESET":
      case "EPIPE":
        return { cause: "connection_reset", phase: "request" } as const;
      case "ETIMEDOUT":
      case "ECONNABORTED":
        return { cause: "timeout", phase: "timeout" } as const;
      default:
        if (code?.startsWith("ERR_TLS_") || code === "EPROTO") {
          return { cause: "tls", phase: "tls" } as const;
        }
        return { cause: "unknown", phase: "unknown" } as const;
    }
  })();
  return {
    ...classified,
    bytesWritten,
    provablyNotDispatched:
      // DNS lookup failures happen before a connection exists, so a missing
      // socket counter is itself expected evidence. Connect failures require
      // an explicit zero counter. Any positive/unknown request-phase signal
      // remains ambiguous and is never replayed.
      (classified.phase === "dns" &&
        (bytesWritten === null || bytesWritten === 0)) ||
      (classified.phase === "connect" && bytesWritten === 0),
  };
}

function fileCreateRetryDelayMs(attempt: number) {
  const base = attempt === 1 ? 250 : 1_000;
  const seed =
    createHash("sha256").update(`file.upload:${attempt}`, "utf8").digest()[0] ??
    0;
  return base + Math.floor((base * (seed % 13)) / 100);
}

function requiredString(value: unknown, label: string, maxLength = 2_048) {
  if (typeof value !== "string") {
    throw new ManusV2ApiError(label, 502, "INVALID_RESPONSE", false, false);
  }
  const normalized = value.trim();
  if (!normalized || normalized !== value || normalized.length > maxLength) {
    throw new ManusV2ApiError(label, 502, "INVALID_RESPONSE", false, false);
  }
  return normalized;
}

function requiredInteger(value: unknown, label: string, minimum: number) {
  if (!Number.isSafeInteger(value) || Number(value) < minimum) {
    throw new ManusV2ApiError(label, 502, "INVALID_RESPONSE", false, false);
  }
  return Number(value);
}

function canonicalProviderFilename(value: unknown) {
  return requiredString(
    typeof value === "string" ? value.replace(/[\\/\0]/gu, "_") : value,
    "filename",
    512,
  );
}

function canonicalMediaType(value: unknown) {
  if (typeof value !== "string") return null;
  const mediaType = value.split(";", 1)[0]?.trim().toLowerCase() ?? "";
  return /^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/u.test(mediaType)
    ? mediaType
    : null;
}

function isOoxmlContainer(filename: string, expectedContentType: string) {
  const normalizedFilename = filename.trim().toLowerCase();
  return (
    (normalizedFilename.endsWith(".pptx") &&
      expectedContentType ===
        "application/vnd.openxmlformats-officedocument.presentationml.presentation") ||
    (normalizedFilename.endsWith(".docx") &&
      expectedContentType ===
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document") ||
    (normalizedFilename.endsWith(".xlsx") &&
      expectedContentType ===
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet")
  );
}

export function classifyManusV2ProviderFileMime(input: {
  filename: string;
  expectedContentType: string;
  providerContentType: string | null;
  providerContentTypeParseStatus?: "valid" | "missing" | "invalid";
}): ProviderMimeDisposition {
  const expected = canonicalMediaType(input.expectedContentType);
  if (!expected) return "invalid";
  const providerParseStatus =
    input.providerContentTypeParseStatus ??
    (input.providerContentType === null ? "missing" : "valid");
  if (providerParseStatus === "invalid") return "invalid";
  const provider = canonicalMediaType(input.providerContentType);
  if (providerParseStatus === "missing" || !input.providerContentType) {
    return "missing";
  }
  if (!provider) return "invalid";
  if (provider === expected) return "exact";
  if (
    provider === "application/octet-stream" ||
    provider === "binary/octet-stream" ||
    (provider === "application/zip" &&
      isOoxmlContainer(input.filename, expected))
  ) {
    return "generic";
  }
  return "different";
}

/**
 * Strict is the default for generic Manus consumers. Knowledge-base uploads
 * may opt into the advisory policy only after Dashboard has revalidated its
 * frozen local bytes, hash, size, filename and canonical MIME.
 */
export function isManusV2ProviderFileMimeUsable(input: {
  filename: string;
  expectedContentType: string;
  providerContentType: string | null;
  providerContentTypeParseStatus?: "valid" | "missing" | "invalid";
  confirmationPolicy?: ManusV2FileConfirmationPolicy;
}) {
  const expected = canonicalMediaType(input.expectedContentType);
  if (!expected) return false;
  const disposition = classifyManusV2ProviderFileMime(input);
  if (input.confirmationPolicy === "kb_frozen_source_advisory") return true;
  if (disposition === "exact") return true;
  if (disposition !== "generic") return false;
  const provider = canonicalMediaType(input.providerContentType);
  const filename = String(input.filename || "")
    .trim()
    .toLowerCase();
  if (provider === "application/zip" && isOoxmlContainer(filename, expected)) {
    return true;
  }
  if (provider !== "application/octet-stream") return false;
  return (
    (filename.endsWith(".zip") &&
      (expected === "application/zip" ||
        expected === "application/x-zip-compressed")) ||
    (filename.endsWith(".txt") && expected === "text/plain")
  );
}

const TERMINAL_FILE_DETAIL_CODES = new Set([
  "FILE_ID_CONFLICT",
  "FILE_IDENTITY_CONFLICT",
  "FILE_BYTES_CONFLICT",
  "FILE_MIME_CONFLICT",
  "FILE_UNUSABLE",
  "FILE_EXPIRING",
]);

function retryableFileDetailFailure(error: unknown) {
  if (!(error instanceof ManusV2ApiError)) return true;
  if (TERMINAL_FILE_DETAIL_CODES.has(error.code)) return false;
  return (
    error.code === "TRANSPORT_UNKNOWN" ||
    error.code === "INVALID_RESPONSE" ||
    error.retryable ||
    error.status === null ||
    error.status === 408 ||
    error.status === 425 ||
    error.status === 429 ||
    (error.status !== null && error.status >= 500)
  );
}

function optionalString(value: unknown, maxLength = 2_048) {
  if (value === undefined || value === null || value === "") return null;
  return requiredString(value, "response", maxLength);
}

function providerRequestId(record: Record<string, unknown>) {
  // Provider request ids are diagnostic only. A malformed optional field
  // must never discard an otherwise usable task/file acknowledgement.
  return safeProviderRequestReference(record.request_id);
}

function providerResponseRequestId(
  response: AxiosResponse,
  record: Record<string, unknown> | null,
) {
  const bodyRequestId = record ? providerRequestId(record) : null;
  if (bodyRequestId) return bodyRequestId;
  const headers = response.headers as
    | { get?: (name: string) => unknown; [key: string]: unknown }
    | undefined;
  for (const name of ["x-request-id", "request-id", "x-correlation-id"]) {
    const raw = headers?.get?.(name) ?? headers?.[name];
    const value = Array.isArray(raw) ? raw[0] : raw;
    const requestId = safeProviderRequestReference(value);
    if (requestId) return requestId;
  }
  return null;
}

function acknowledgedSideEffectTaskId(
  operation: string,
  record: Record<string, unknown>,
) {
  try {
    const taskId = upstreamAliasedIdentity({
      record,
      aliases: ["task_id", "id"],
      label: "Manus v2 task id",
      maxLength: 255,
      required: true,
    });
    if (!taskId) throw new Error("missing task id");
    return taskId;
  } catch {
    throw new ManusV2ApiError(
      operation,
      200,
      "INVALID_RESPONSE",
      false,
      true,
      providerRequestId(record),
    );
  }
}

function providerErrorCode(record: Record<string, unknown>, status: number) {
  const error = upstreamTaskRecord(record.error);
  const value = optionalString(error?.code ?? record.code, 128);
  return value || `HTTP_${status}`;
}

function providerValidationCoordinates(record: Record<string, unknown>) {
  const error = upstreamTaskRecord(record.error);
  const firstDetail = Array.isArray(error?.details)
    ? upstreamTaskRecord(error.details[0])
    : null;
  return {
    field: classifyProviderValidationCoordinate(
      error?.field ?? firstDetail?.field,
    ),
    path: classifyProviderValidationCoordinate(
      error?.path ?? firstDetail?.path,
    ),
  };
}

function retryableStatus(status: number) {
  return status === 408 || status === 425 || status === 429 || status >= 500;
}

function retryAfterMs(response: AxiosResponse) {
  // Retry-After is advisory only for explicit rejections. Axios exposes
  // headers differently across its node/browser adapters, so tolerate both
  // shapes without ever inventing a provider instruction.
  const headers = response.headers as
    | { get?: (name: string) => unknown; [key: string]: unknown }
    | undefined;
  const raw = headers?.get?.("retry-after") ?? headers?.["retry-after"];
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (typeof value !== "string" && typeof value !== "number") return null;
  const normalized = String(value).trim();
  if (!normalized || normalized.length > 128) return null;
  const seconds = Number(normalized);
  if (Number.isFinite(seconds) && seconds >= 0) {
    return Math.min(60 * 60 * 1000, Math.round(seconds * 1_000));
  }
  const at = Date.parse(normalized);
  if (!Number.isFinite(at)) return null;
  return Math.min(60 * 60 * 1000, Math.max(0, at - Date.now()));
}

function explicitFilePutRetryDelayMs(input: {
  rejectionCount: number;
  retryAfterMs: number | null;
  fileId: string;
}) {
  if (input.retryAfterMs !== null) return input.retryAfterMs;
  const base = Math.min(
    30_000,
    500 * 2 ** Math.min(input.rejectionCount - 1, 5),
  );
  const seed =
    createHash("sha256")
      .update(`${input.fileId}:${input.rejectionCount}`, "utf8")
      .digest()[0] ?? 0;
  return base + Math.floor((base * (seed % 21)) / 100);
}

function assertOk(
  operation: string,
  response: AxiosResponse,
  sideEffect: boolean,
): Record<string, unknown> {
  const record = upstreamTaskRecord(response.data);
  if (response.status < 200 || response.status >= 300) {
    // Receiving an HTTP 4xx response proves the provider rejected this
    // request, even when its validation-error body omits `ok:false`. Treating
    // such a response as outcome-unknown would leave a known task.create 400
    // in reconciliation forever. A 5xx without an explicit rejection remains
    // ambiguous because the side effect may have happened before the error.
    const explicitRejection =
      (response.status >= 400 && response.status < 500) || record?.ok === false;
    const coordinates = record
      ? providerValidationCoordinates(record)
      : { field: null, path: null };
    throw new ManusV2ApiError(
      operation,
      response.status,
      record
        ? providerErrorCode(record, response.status)
        : `HTTP_${response.status}`,
      explicitRejection && retryableStatus(response.status),
      sideEffect && !explicitRejection,
      providerResponseRequestId(response, record),
      explicitRejection ? retryAfterMs(response) : null,
      coordinates.field,
      coordinates.path,
    );
  }
  // Once a side-effect endpoint returned 2xx, an empty/non-object body or a
  // body that does not explicitly acknowledge `ok: true` cannot prove that
  // the request was not accepted. Reconcile it; never classify it as a safe
  // rejection and never POST the business operation again.
  if (!record || record.ok !== true) {
    throw new ManusV2ApiError(
      operation,
      response.status,
      "INVALID_RESPONSE",
      false,
      sideEffect,
      providerResponseRequestId(response, record),
    );
  }
  return record;
}

function normalizeBaseUrl(baseUrl: string) {
  const parsed = new URL(baseUrl);
  if (
    parsed.protocol !== "https:" ||
    parsed.username ||
    parsed.password ||
    parsed.search ||
    parsed.hash
  ) {
    throw new Error("Unsafe Manus v2 base URL");
  }
  if (
    process.env.NODE_ENV === "production" &&
    (parsed.origin !== "https://api.manus.ai" || parsed.pathname !== "/")
  ) {
    throw new Error("Unsafe Manus v2 production base URL");
  }
  return parsed.toString().replace(/\/+$/u, "");
}

function safeAttachment(attachment: ManusV2Attachment) {
  const filename = requiredString(
    attachment.filename.replace(/[\\/\0]/gu, "_"),
    "filename",
    512,
  );
  if ("file_id" in attachment && attachment.file_id) {
    return {
      type: "file" as const,
      file_id: requiredString(attachment.file_id, "file_id", 512),
      filename,
    };
  }
  if (!("file_data" in attachment) || !attachment.file_data) {
    throw new Error("Manus v2 attachment requires exactly one file source");
  }
  const mimeType = requiredString(attachment.mime_type, "mime_type", 255);
  const prefix = `data:${mimeType};base64,`;
  if (!attachment.file_data.startsWith(prefix)) {
    throw new Error("Manus v2 inline attachment data URL is invalid");
  }
  const encoded = attachment.file_data.slice(prefix.length);
  if (
    !encoded ||
    encoded.length > Math.ceil((20 * 1024 * 1024 * 4) / 3) + 4 ||
    !/^[A-Za-z0-9+/]+={0,2}$/u.test(encoded)
  ) {
    throw new Error("Manus v2 inline attachment exceeds its safe limit");
  }
  const decoded = Buffer.from(encoded, "base64");
  if (
    decoded.length < 1 ||
    decoded.length > 20 * 1024 * 1024 ||
    decoded.toString("base64") !== encoded
  ) {
    throw new Error("Manus v2 inline attachment base64 is invalid");
  }
  return {
    type: "file" as const,
    file_data: attachment.file_data,
    filename,
    mime_type: mimeType,
  };
}

export function buildManusV2MessageContent(
  prompt: string,
  attachments: ReadonlyArray<ManusV2Attachment>,
) {
  const content: Array<
    | { type: "text"; text: string }
    | { type: "file"; file_id: string; filename: string }
    | {
        type: "file";
        file_data: string;
        filename: string;
        mime_type: string;
      }
  > = [{ type: "text", text: requiredString(prompt, "prompt", 2_000_000) }];
  for (const attachment of attachments.map(safeAttachment)) {
    content.push(attachment);
  }
  return content;
}

export type ManusV2CreateTaskInput = {
  prompt: string;
  attachments?: ReadonlyArray<ManusV2Attachment>;
  title?: string;
  agentProfile?: string;
  locale?: string;
  interactiveMode?: boolean;
  structuredOutputSchema?: ManusV2StructuredOutputSchema;
  taskReferences?: string[];
};

export function buildManusV2CreateTaskBody(input: ManusV2CreateTaskInput) {
  return {
    message: {
      content: buildManusV2MessageContent(
        input.prompt,
        input.attachments ?? [],
      ),
      ...(input.taskReferences?.length
        ? { task_references: input.taskReferences }
        : {}),
    },
    ...(input.title
      ? { title: requiredString(input.title, "title", 255) }
      : {}),
    interactive_mode: input.interactiveMode ?? false,
    ...(input.locale
      ? { locale: requiredString(input.locale, "locale", 32) }
      : {}),
    // FrontMind tasks stay private but are always visible to their owner.
    // Pinning this at the wire boundary prevents any business flow from
    // silently creating a task that disappears from the Manus task list.
    hide_in_task_list: false,
    share_visibility: "private",
    ...(input.agentProfile
      ? {
          agent_profile: requiredString(input.agentProfile, "agentProfile", 64),
        }
      : {}),
    ...(input.structuredOutputSchema
      ? { structured_output_schema: input.structuredOutputSchema }
      : {}),
  };
}

export type ManusV2SendMessageInput = {
  taskId: string;
  prompt: string;
  attachments?: ReadonlyArray<ManusV2Attachment>;
  structuredOutputSchema?: ManusV2StructuredOutputSchema;
};

export function buildManusV2SendMessageBody(input: ManusV2SendMessageInput) {
  return {
    task_id: requiredString(input.taskId, "taskId", 255),
    message: {
      content: buildManusV2MessageContent(
        input.prompt,
        input.attachments ?? [],
      ),
    },
    ...(input.structuredOutputSchema
      ? { structured_output_schema: input.structuredOutputSchema }
      : {}),
  };
}

function normalizeEvent(
  value: unknown,
  providerOriginalRank?: number,
): ManusV2MessageEvent | null {
  const record = upstreamTaskRecord(value);
  if (!record) return null;
  try {
    const id = requiredString(record.id, "message.id", 512);
    const type = requiredString(record.type, "message.type", 64);
    const timestamp = Number(record.timestamp);
    if (!Number.isSafeInteger(timestamp) || timestamp < 0) return null;
    return {
      ...record,
      id,
      type,
      timestamp,
      ...(Number.isSafeInteger(providerOriginalRank) &&
      Number(providerOriginalRank) >= 0
        ? { providerOriginalRank }
        : {}),
    };
  } catch {
    return null;
  }
}

/**
 * Preserve the Provider's event order when timestamps collide. Event ids are
 * opaque identifiers and therefore cannot be used to invent chronology.
 * Fixtures and older callers without a durable Provider rank retain their
 * stable input-array order.
 */
export function orderManusV2EventsByProviderRank(
  events: ReadonlyArray<ManusV2MessageEvent>,
  direction: "oldest_first" | "newest_first",
) {
  const hasCompleteProviderRanks = events.every(
    (event) =>
      Number.isSafeInteger(event.providerOriginalRank) &&
      Number(event.providerOriginalRank) >= 0,
  );
  return events
    .map((event, originalIndex) => ({
      event,
      originalIndex,
      providerRank: hasCompleteProviderRanks
        ? Number(event.providerOriginalRank)
        : originalIndex,
    }))
    .sort((left, right) => {
      const timestampOrder =
        direction === "oldest_first"
          ? left.event.timestamp - right.event.timestamp
          : right.event.timestamp - left.event.timestamp;
      if (timestampOrder) return timestampOrder;
      const rankOrder =
        direction === "oldest_first"
          ? left.providerRank - right.providerRank
          : right.providerRank - left.providerRank;
      if (rankOrder) return rankOrder;
      return direction === "oldest_first"
        ? left.originalIndex - right.originalIndex
        : right.originalIndex - left.originalIndex;
    })
    .map(({ event }) => event);
}

export function manusV2EventUserText(event: ManusV2MessageEvent) {
  if (event.type !== "user_message") return null;
  const message = upstreamTaskRecord(event.user_message);
  if (typeof message?.content === "string") return message.content;
  if (!Array.isArray(message?.content)) return null;
  const text = message.content.flatMap((item) => {
    const record = upstreamTaskRecord(item);
    return typeof record?.text === "string" ? [record.text] : [];
  });
  return text.length > 0 ? text.join("\n") : null;
}

export function manusV2EventUserAttachmentFileIds(event: ManusV2MessageEvent) {
  if (event.type !== "user_message") return [];
  const message = upstreamTaskRecord(event.user_message);
  const raw = [
    ...(Array.isArray(message?.attachments) ? message.attachments : []),
    ...(Array.isArray(message?.content) ? message.content : []),
  ];
  return Array.from(
    new Set(
      raw.flatMap((attachment) => {
        const record = upstreamTaskRecord(attachment);
        const value = record?.file_id ?? record?.fileId;
        return typeof value === "string" && value.trim() ? [value.trim()] : [];
      }),
    ),
  ).sort();
}

export function manusV2EventMatchesGeneralChatRequest(
  event: ManusV2MessageEvent,
  input: { promptSha256: string; attachmentFileIds: readonly string[] },
) {
  const text = manusV2EventUserText(event);
  if (text === null) return false;
  const promptSha256 = createHash("sha256")
    .update(stripFrontMindGeneralChatOperationContract(text), "utf8")
    .digest("hex");
  if (promptSha256 !== input.promptSha256) return false;
  const expected = [...new Set(input.attachmentFileIds)].sort();
  const observed = manusV2EventUserAttachmentFileIds(event);
  return (
    expected.length === observed.length &&
    expected.every((fileId, index) => fileId === observed[index])
  );
}

export function manusV2EventsContainOperationToken(
  events: ReadonlyArray<ManusV2MessageEvent>,
  operationToken: string,
) {
  const token = requiredString(operationToken, "operationToken", 256);
  return events.some((event) => manusV2EventOperationToken(event) === token);
}

const MANUS_V2_OPERATION_CONTRACT_LINE =
  /^FRONTMIND_MANUS_V2_OPERATION_CONTRACT=(\{[^\r\n]+\})\s*$/mu;

export function manusV2EventOperationToken(event: ManusV2MessageEvent) {
  const text = manusV2EventUserText(event);
  if (!text) return null;
  const candidate = MANUS_V2_OPERATION_CONTRACT_LINE.exec(text)?.[1];
  if (!candidate) return null;
  try {
    const record = upstreamTaskRecord(JSON.parse(candidate));
    return typeof record?.operationToken === "string"
      ? record.operationToken
      : null;
  } catch {
    return null;
  }
}

export function latestManusV2TaskState(
  events: ReadonlyArray<ManusV2MessageEvent>,
) {
  const ordered = orderManusV2EventsByProviderRank(events, "newest_first");
  for (const event of ordered) {
    if (event.type !== "status_update") continue;
    const update = upstreamTaskRecord(event.status_update);
    const state = optionalString(update?.agent_status, 64);
    if (state) return state;
  }
  return null;
}

/** Return only the newest pending waiting event; historical waits are inert. */
export function latestManusV2WaitingDetail(
  events: ReadonlyArray<ManusV2MessageEvent>,
): ManusV2WaitingDetail | null {
  const ordered = orderManusV2EventsByProviderRank(events, "newest_first");
  for (const event of ordered) {
    if (event.type !== "status_update") continue;
    const update = upstreamTaskRecord(event.status_update);
    if (optionalString(update?.agent_status, 64) !== "waiting") return null;
    const detail = upstreamTaskRecord(update?.status_detail);
    if (!detail) return null;
    try {
      const schema = upstreamTaskRecord(detail.confirm_input_schema);
      return {
        eventId: requiredString(
          detail.waiting_for_event_id,
          "waiting_for_event_id",
          512,
        ),
        eventType: requiredString(
          detail.waiting_for_event_type,
          "waiting_for_event_type",
          128,
        ),
        description: optionalString(detail.waiting_description, 4_096),
        confirmInputSchema: schema ? { ...schema } : null,
        statusEventId: event.id,
      };
    } catch {
      return null;
    }
  }
  return null;
}

function normalizedContractString(value: unknown, label: string, max: number) {
  return requiredString(value, label, max);
}

function normalizeNullableContractString(
  value: unknown,
  label: string,
  max: number,
) {
  if (value === null) return null;
  return normalizedContractString(value, label, max);
}

function exactSafeInteger(value: unknown, label: string) {
  const normalized = Number(value);
  if (!Number.isSafeInteger(normalized) || normalized < 0) {
    throw new ManusV2ApiError(
      "structured_output",
      502,
      `INVALID_${label.toUpperCase()}`,
      false,
      false,
    );
  }
  return normalized;
}

/**
 * The schema is deliberately small. Dashboard remains authoritative for the
 * tree, counters and assets; Manus only returns transition coordinates and
 * the visible body. The one exception is the initial tree manifest. Singleton enums
 * make the frozen operation coordinates part of each create/send request.
 */
export function buildManusV2KnowledgeBaseStructuredOutputSchema(
  input: ManusV2KnowledgeBaseOperationContract,
): ManusV2StructuredOutputSchema {
  const operationToken = normalizedContractString(
    input.operationToken,
    "operationToken",
    128,
  );
  const turnId = normalizedContractString(input.turnId, "turnId", 36);
  const generation = exactSafeInteger(input.generation, "generation");
  const baseRevision = exactSafeInteger(input.baseRevision, "baseRevision");
  const fromLeafId = input.fromLeafId
    ? normalizedContractString(input.fromLeafId, "fromLeafId", 191)
    : null;
  return {
    type: "object",
    properties: {
      schemaVersion: {
        type: "integer",
        enum: [MANUS_V2_KNOWLEDGE_BASE_RESULT_SCHEMA_VERSION],
      },
      operationToken: { type: "string", enum: [operationToken] },
      turnId: { type: "string", enum: [turnId] },
      generation: { type: "integer", enum: [generation] },
      baseRevision: { type: "integer", enum: [baseRevision] },
      action: { type: "string", enum: [input.action] },
      fromLeafId:
        fromLeafId === null
          ? { type: ["string", "null"], enum: [null] }
          : { type: ["string", "null"], enum: [fromLeafId] },
      nextLeafId: { type: ["string", "null"] },
      visibleMarkdown: { type: "string" },
      contentCompleted: {
        type: "boolean",
        enum: [input.expectContentCompleted],
      },
      ...(input.requiresManifest ? { manifestJson: { type: "string" } } : {}),
    },
    required: [
      "schemaVersion",
      "operationToken",
      "turnId",
      "generation",
      "baseRevision",
      "action",
      "fromLeafId",
      "nextLeafId",
      "visibleMarkdown",
      "contentCompleted",
      ...(input.requiresManifest ? ["manifestJson"] : []),
    ],
    additionalProperties: false,
  };
}

/** Repeats the operation contract in-band for response-loss reconciliation. */
export function appendManusV2KnowledgeBaseOperationContract(
  prompt: string,
  input: ManusV2KnowledgeBaseOperationContract,
) {
  const contract = {
    schemaVersion: MANUS_V2_KNOWLEDGE_BASE_RESULT_SCHEMA_VERSION,
    operationToken: normalizedContractString(
      input.operationToken,
      "operationToken",
      128,
    ),
    turnId: normalizedContractString(input.turnId, "turnId", 36),
    generation: exactSafeInteger(input.generation, "generation"),
    baseRevision: exactSafeInteger(input.baseRevision, "baseRevision"),
    action: input.action,
    fromLeafId: input.fromLeafId,
    contentCompleted: input.expectContentCompleted,
    requiresManifest: input.requiresManifest,
  };
  return [
    requiredString(prompt, "prompt", 2_000_000),
    "",
    "# FrontMind operation contract",
    `FRONTMIND_MANUS_V2_OPERATION_CONTRACT=${JSON.stringify(contract)}`,
    input.requiresManifest
      ? "Put only the customer-facing first-node body in visibleMarkdown. Put the initial manifest object (leaves and researchCoverage, plus optional officialLogo) as JSON text in manifestJson. Dashboard owns and synthesizes all machine envelopes. nextLeafId must be the first manifest leaf id."
      : "Put only the customer-facing node body in visibleMarkdown. Dashboard owns and synthesizes all machine envelopes. nextLeafId is the leaf displayed after this transition, or null when content is complete.",
  ].join("\n");
}

function normalizeKnowledgeBaseStructuredResult(
  value: unknown,
  expected?: ManusV2KnowledgeBaseOperationContract,
): ManusV2KnowledgeBaseStructuredResult {
  let decoded = value;
  if (typeof decoded === "string") {
    try {
      decoded = JSON.parse(decoded);
    } catch {
      decoded = null;
    }
  }
  const record = upstreamTaskRecord(decoded);
  if (!record) {
    throw new ManusV2ApiError(
      "structured_output",
      502,
      "INVALID_CORE_SCHEMA",
      false,
      false,
    );
  }
  const schemaVersion = exactSafeInteger(record.schemaVersion, "schemaVersion");
  const operationToken = normalizedContractString(
    record.operationToken,
    "operationToken",
    128,
  );
  const turnId = normalizedContractString(record.turnId, "turnId", 36);
  const generation = exactSafeInteger(record.generation, "generation");
  const baseRevision = exactSafeInteger(record.baseRevision, "baseRevision");
  const action = normalizedContractString(record.action, "action", 32);
  if (
    ![
      "start",
      "confirm",
      "direct_prefill",
      "revise",
      "retry",
      "legacy_reconcile",
    ].includes(action)
  ) {
    throw new ManusV2ApiError(
      "structured_output",
      502,
      "INVALID_ACTION",
      false,
      false,
    );
  }
  const fromLeafId = normalizeNullableContractString(
    record.fromLeafId,
    "fromLeafId",
    191,
  );
  const nextLeafId = normalizeNullableContractString(
    record.nextLeafId,
    "nextLeafId",
    191,
  );
  if (typeof record.visibleMarkdown !== "string") {
    throw new ManusV2ApiError(
      "structured_output",
      502,
      "INVALID_VISIBLE_MARKDOWN",
      false,
      false,
    );
  }
  const visibleMarkdown = record.visibleMarkdown.trim();
  if (typeof record.contentCompleted !== "boolean") {
    throw new ManusV2ApiError(
      "structured_output",
      502,
      "INVALID_COMPLETION_FLAG",
      false,
      false,
    );
  }
  const manifestJson = normalizeNullableContractString(
    record.manifestJson === undefined ? null : record.manifestJson,
    "manifestJson",
    2_000_000,
  );
  if (schemaVersion !== MANUS_V2_KNOWLEDGE_BASE_RESULT_SCHEMA_VERSION) {
    throw new ManusV2ApiError(
      "structured_output",
      502,
      "UNSUPPORTED_CORE_SCHEMA",
      false,
      false,
    );
  }
  if (!record.contentCompleted && !visibleMarkdown) {
    throw new ManusV2ApiError(
      "structured_output",
      502,
      "EMPTY_CORE_CONTENT",
      false,
      false,
    );
  }
  if (
    expected &&
    (operationToken !== expected.operationToken ||
      turnId !== expected.turnId ||
      generation !== expected.generation ||
      baseRevision !== expected.baseRevision ||
      action !== expected.action ||
      fromLeafId !== expected.fromLeafId ||
      record.contentCompleted !== expected.expectContentCompleted ||
      (expected.requiresManifest ? !manifestJson : manifestJson !== null))
  ) {
    throw new ManusV2ApiError(
      "structured_output",
      409,
      "OPERATION_COORDINATE_CONFLICT",
      false,
      false,
    );
  }
  return {
    schemaVersion: MANUS_V2_KNOWLEDGE_BASE_RESULT_SCHEMA_VERSION,
    operationToken,
    turnId,
    generation,
    baseRevision,
    action: action as ManusV2KnowledgeBaseAction,
    fromLeafId,
    nextLeafId,
    visibleMarkdown,
    contentCompleted: record.contentCompleted,
    manifestJson,
  };
}

export function manusV2KnowledgeBaseStructuredResultForOperation(
  events: ReadonlyArray<ManusV2MessageEvent>,
  expected: ManusV2KnowledgeBaseOperationContract,
) {
  const candidates = orderManusV2EventsByProviderRank(
    events.filter((event) => event.type === "structured_output_result"),
    "newest_first",
  );
  for (const event of candidates) {
    const result = classifyManusV2StructuredResultEnvelope(
      event.structured_output_result,
    );
    if (result.kind !== "accepted") continue;
    let decoded = result.value;
    if (typeof decoded === "string") {
      try {
        decoded = JSON.parse(decoded);
      } catch {
        decoded = null;
      }
    }
    const value = upstreamTaskRecord(decoded);
    if (!value || value.operationToken !== expected.operationToken) continue;
    return {
      event,
      value: normalizeKnowledgeBaseStructuredResult(value, expected),
    };
  }
  return null;
}

export function normalizeManusV2KnowledgeBaseCoreOutput(
  events: ReadonlyArray<ManusV2MessageEvent>,
  expected: ManusV2KnowledgeBaseOperationContract,
) {
  return normalizeManusV2Output(events, expected);
}

export function normalizeManusV2Output(
  events: ReadonlyArray<ManusV2MessageEvent>,
  expected?: ManusV2KnowledgeBaseOperationContract,
) {
  type NormalizedOutput =
    | {
        id: string;
        role: "assistant";
        text: string;
        content: string;
        timestamp: number;
        files?: unknown[];
        structuredOutput?: true;
      }
    | {
        id: string;
        role: "assistant";
        type: "file";
        filename: unknown;
        content_type: unknown;
        url: unknown;
        file_id?: unknown;
        timestamp: number;
      };
  if (expected) {
    const exact = manusV2KnowledgeBaseStructuredResultForOperation(
      events,
      expected,
    );
    if (!exact) return [];
    const text = exact.value.visibleMarkdown;
    return [
      {
        id: exact.event.id,
        role: "assistant" as const,
        text,
        content: text,
        timestamp: exact.event.timestamp,
        // Provider assets are deliberately not part of the core acceptance
        // record. Dashboard-owned source/package workers reconcile them
        // separately so an optional Logo/ZIP cannot reject valid正文.
        files: [],
        structuredOutput: true as const,
      },
    ];
  }
  return orderManusV2EventsByProviderRank(
    events,
    "oldest_first",
  ).flatMap<NormalizedOutput>((event) => {
    if (event.type === "structured_output_result") {
      const result = classifyManusV2StructuredResultEnvelope(
        event.structured_output_result,
      );
      if (result.kind !== "accepted") return [];
      let value: ManusV2KnowledgeBaseStructuredResult;
      try {
        value = normalizeKnowledgeBaseStructuredResult(result.value);
      } catch {
        return [];
      }
      const text = value.visibleMarkdown;
      return [
        {
          id: event.id,
          role: "assistant",
          text,
          content: text,
          timestamp: event.timestamp,
          structuredOutput: true,
        },
      ];
    }
    if (event.type !== "assistant_message") return [];
    const message = upstreamTaskRecord(event.assistant_message);
    const text = typeof message?.content === "string" ? message.content : "";
    const attachments = Array.isArray(message?.attachments)
      ? message.attachments
      : [];
    // Materialized knowledge-base tasks intentionally return one ZIP and no
    // prose. Preserve that assistant event so the archive validator can see
    // the attachment; only a truly empty event is noise.
    if (!text && attachments.length === 0) return [];
    const typedAttachments = attachments.flatMap((attachment, index) => {
      const record = upstreamTaskRecord(attachment);
      if (!record) return [];
      // task.listMessages identifies an output attachment by the immutable
      // Provider event and its array position. Project each attachment once
      // into the typed-file shape already consumed by the archive boundary;
      // keep the ordinary assistant message separately for visible text.
      const id = `v2-attachment-${createHash("sha256")
        .update(`${event.id}\0${index}`, "utf8")
        .digest("hex")}`;
      return [
        {
          id,
          role: "assistant" as const,
          type: "file" as const,
          filename:
            record.filename ?? record.file_name ?? record.fileName ?? "",
          content_type:
            record.content_type ?? record.mime_type ?? record.mimeType ?? "",
          url: record.url ?? record.file_url ?? record.fileUrl ?? "",
          ...(record.file_id !== undefined || record.fileId !== undefined
            ? { file_id: record.file_id ?? record.fileId }
            : {}),
          timestamp: event.timestamp,
        },
      ];
    });
    return [
      {
        id: event.id,
        role: "assistant",
        text,
        content: text,
        files: attachments,
        timestamp: event.timestamp,
      },
      ...typedAttachments,
    ];
  });
}

export class ManusV2Client {
  private readonly baseUrl: string;
  private readonly api: AxiosInstance;
  private readonly rateLimitScope: string;
  private readonly rateLimiter: ManusV2RateLimiter;

  constructor(input: {
    baseUrl: string;
    apiKey: string;
    axiosInstance?: AxiosInstance;
    timeoutMs?: number;
    /** Stable Manus-account identity, never an API-key fingerprint. */
    rateLimitScope?: string;
    /** Deterministic injection used by Gateway tests with an explicit mock URL. */
    rateLimiter?: ManusV2RateLimiter;
  }) {
    this.baseUrl = normalizeBaseUrl(input.baseUrl);
    this.rateLimitScope = normalizeManusV2RateLimitScope(input.rateLimitScope);
    // Production egress is pinned to api.manus.ai. Explicit mock origins do
    // not consume the process-global production allowance unless a test
    // injects a limiter intentionally.
    this.rateLimiter =
      input.rateLimiter ??
      (new URL(this.baseUrl).hostname === "api.manus.ai"
        ? sharedManusV2AccountRateLimiter
        : noopManusV2RateLimiter);
    const apiKey = requiredString(input.apiKey, "apiKey", 8_192);
    const timeoutMs = input.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1) {
      throw new Error("Invalid Manus v2 timeout");
    }
    this.api =
      input.axiosInstance ??
      axios.create({
        headers: { "x-manus-api-key": apiKey },
        timeout: timeoutMs,
        maxRedirects: 0,
        maxContentLength: MAX_RESPONSE_BYTES,
        validateStatus: () => true,
      });
  }

  private async request(
    operation: string,
    request: () => Promise<AxiosResponse>,
    sideEffect: boolean,
    options: {
      fileCreateRetryPolicy?: ManusV2FileCreateRetryPolicy;
      sleep?: (ms: number) => Promise<void>;
      now?: () => number;
    } = {},
  ) {
    const now = options.now ?? Date.now;
    const sleep =
      options.sleep ??
      ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
    const startedAt = now();
    const maxAttempts =
      operation === "file.upload" &&
      options.fileCreateRetryPolicy === "response_logic_pre_dispatch_only"
        ? 3
        : 1;
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      // Every wire attempt consumes Provider allowance. Waiting in the local
      // limiter is outside the transport boundary and cannot make an outcome
      // unknown.
      await this.rateLimiter.acquire({
        scope: this.rateLimitScope,
        lane: manusV2RateLimitLane(operation, sideEffect),
      });
      try {
        const response = await request();
        return assertOk(operation, response, sideEffect);
      } catch (error) {
        if (error instanceof ManusV2ApiError) throw error;
        const transport = classifyTransportFailure(error);
        const elapsedMs = Math.max(0, now() - startedAt);
        const mayRetry =
          maxAttempts > 1 &&
          attempt < maxAttempts &&
          transport.provablyNotDispatched;
        if (mayRetry) {
          const delayMs = fileCreateRetryDelayMs(attempt);
          console.warn("[Manus v2] safe pre-dispatch retry", {
            operation,
            transportCause: transport.cause,
            transportPhase: transport.phase,
            transportAttempt: attempt,
            transportElapsedMs: elapsedMs,
            transportBytesWritten: transport.bytesWritten,
            delayMs,
          });
          await sleep(delayMs);
          continue;
        }
        const retryExhausted =
          maxAttempts > 1 && transport.provablyNotDispatched;
        throw new ManusV2ApiError(
          operation,
          null,
          retryExhausted
            ? "TRANSPORT_PRE_DISPATCH_RETRY_EXHAUSTED"
            : "TRANSPORT_UNKNOWN",
          retryExhausted,
          retryExhausted ? false : sideEffect,
          null,
          null,
          null,
          null,
          transport.cause,
          transport.phase,
          attempt,
          elapsedMs,
          transport.bytesWritten,
        );
      }
    }
    throw new Error("Unreachable Manus v2 request state");
  }

  async createTask(input: ManusV2CreateTaskInput) {
    const body = buildManusV2CreateTaskBody(input);
    const result = await this.request(
      "task.create",
      () =>
        this.api.post(`${this.baseUrl}/v2/task.create`, body, {
          headers: { "Content-Type": "application/json" },
        }),
      true,
    );
    const taskId = acknowledgedSideEffectTaskId("task.create", result);
    return {
      taskId,
      taskUrl: optionalString(result.task_url, 2_048),
      taskTitle: optionalString(result.task_title, 255),
      requestId: providerRequestId(result),
      raw: result,
    };
  }

  async sendMessage(input: ManusV2SendMessageInput) {
    const body = buildManusV2SendMessageBody(input);
    const taskId = body.task_id;
    const result = await this.request(
      "task.sendMessage",
      () =>
        this.api.post(`${this.baseUrl}/v2/task.sendMessage`, body, {
          headers: { "Content-Type": "application/json" },
        }),
      true,
    );
    const returnedTaskId = acknowledgedSideEffectTaskId(
      "task.sendMessage",
      result,
    );
    if (returnedTaskId !== taskId) {
      throw new ManusV2ApiError(
        "task.sendMessage",
        502,
        "TASK_ID_CONFLICT",
        false,
        true,
        providerRequestId(result),
      );
    }
    return { taskId, requestId: providerRequestId(result), raw: result };
  }

  async taskDetail(taskId: string) {
    const expectedTaskId = requiredString(taskId, "taskId", 255);
    const result = await this.request(
      "task.detail",
      () =>
        this.api.get(`${this.baseUrl}/v2/task.detail`, {
          params: { task_id: expectedTaskId },
        }),
      false,
    );
    const task = upstreamTaskRecord(result.task ?? result.data ?? result);
    if (!task) {
      throw new ManusV2ApiError(
        "task.detail",
        502,
        "INVALID_RESPONSE",
        false,
        false,
        providerRequestId(result),
      );
    }
    const actualTaskId = upstreamAliasedIdentity({
      record: task,
      aliases: ["task_id", "id"],
      label: "Manus v2 task id",
      maxLength: 255,
      required: true,
    });
    if (actualTaskId !== expectedTaskId) {
      throw new ManusV2ApiError(
        "task.detail",
        502,
        "TASK_ID_CONFLICT",
        false,
        false,
        providerRequestId(result),
      );
    }
    return {
      taskId: expectedTaskId,
      status: optionalString(task.status, 64),
      title: optionalString(task.title, 255),
      taskUrl: optionalString(task.task_url, 2_048),
      createdAt: Number.isSafeInteger(Number(task.created_at))
        ? Number(task.created_at)
        : null,
      updatedAt: Number.isSafeInteger(Number(task.updated_at))
        ? Number(task.updated_at)
        : null,
      requestId: providerRequestId(result),
      raw: task,
    };
  }

  async stopTask(taskId: string) {
    const expectedTaskId = requiredString(taskId, "taskId", 255);
    const result = await this.request(
      "task.stop",
      () =>
        this.api.post(
          `${this.baseUrl}/v2/task.stop`,
          { task_id: expectedTaskId },
          { headers: { "Content-Type": "application/json" } },
        ),
      true,
    );
    // The official v2 task.stop success envelope contains only ok/request_id.
    // The request body already freezes the target; requiring a response task
    // identity would reject every valid stop acknowledgement.
    return { taskId: expectedTaskId, requestId: providerRequestId(result) };
  }

  async deleteTask(taskId: string) {
    const expectedTaskId = requiredString(taskId, "taskId", 255);
    const result = await this.request(
      "task.delete",
      () =>
        this.api.post(
          `${this.baseUrl}/v2/task.delete`,
          { task_id: expectedTaskId },
          { headers: { "Content-Type": "application/json" } },
        ),
      true,
    );
    let actualTaskId: string;
    try {
      actualTaskId = requiredString(result.id, "task.delete.id", 255);
    } catch {
      throw new ManusV2ApiError(
        "task.delete",
        200,
        "INVALID_RESPONSE",
        false,
        true,
        providerRequestId(result),
      );
    }
    if (actualTaskId !== expectedTaskId) {
      throw new ManusV2ApiError(
        "task.delete",
        502,
        "TASK_ID_CONFLICT",
        false,
        true,
        providerRequestId(result),
      );
    }
    if (result.deleted !== true) {
      throw new ManusV2ApiError(
        "task.delete",
        200,
        "INVALID_RESPONSE",
        false,
        true,
        providerRequestId(result),
      );
    }
    return { taskId: expectedTaskId, requestId: providerRequestId(result) };
  }

  async confirmAction(input: {
    taskId: string;
    eventId: string;
    confirmationInput?: Record<string, unknown>;
  }) {
    const taskId = requiredString(input.taskId, "taskId", 255);
    const eventId = requiredString(input.eventId, "eventId", 512);
    const result = await this.request(
      "task.confirmAction",
      () =>
        this.api.post(
          `${this.baseUrl}/v2/task.confirmAction`,
          {
            task_id: taskId,
            event_id: eventId,
            ...(input.confirmationInput
              ? { input: { ...input.confirmationInput } }
              : {}),
          },
          { headers: { "Content-Type": "application/json" } },
        ),
      true,
    );
    // A 2xx response proves only that the side-effect request reached Manus.
    // Missing/malformed acknowledgement fields cannot prove that the action
    // was rejected, so classify every such response as outcome-unknown. This
    // keeps the durable lifecycle ledger on its read/reconcile-only path and
    // prevents a second confirmation POST.
    const returnedTaskId = acknowledgedSideEffectTaskId(
      "task.confirmAction",
      result,
    );
    if (returnedTaskId !== taskId) {
      throw new ManusV2ApiError(
        "task.confirmAction",
        502,
        "TASK_ID_CONFLICT",
        false,
        true,
        providerRequestId(result),
      );
    }
    if (result.confirmed !== true) {
      throw new ManusV2ApiError(
        "task.confirmAction",
        502,
        "INVALID_RESPONSE",
        false,
        true,
        providerRequestId(result),
      );
    }
    return { taskId, eventId, requestId: providerRequestId(result) };
  }

  async listMessagesPage(input: {
    taskId: string;
    cursor?: string | null;
    order?: "asc" | "desc";
    limit?: number;
  }) {
    const taskId = requiredString(input.taskId, "taskId", 255);
    const result = await this.request(
      "task.listMessages",
      () =>
        this.api.get(`${this.baseUrl}/v2/task.listMessages`, {
          params: {
            task_id: taskId,
            limit: Math.min(200, Math.max(1, input.limit ?? 200)),
            order: input.order ?? "asc",
            ...(input.cursor ? { cursor: input.cursor } : {}),
          },
        }),
      false,
    );
    const responseTaskId = requiredString(result.task_id, "task_id", 255);
    if (responseTaskId !== taskId) {
      throw new ManusV2ApiError(
        "task.listMessages",
        502,
        "TASK_ID_CONFLICT",
        false,
        false,
        providerRequestId(result),
      );
    }
    return {
      taskId,
      messages: Array.isArray(result.messages)
        ? result.messages.flatMap((event, index, source) => {
            const normalized = normalizeEvent(
              event,
              (input.order ?? "asc") === "desc"
                ? source.length - 1 - index
                : index,
            );
            return normalized ? [normalized] : [];
          })
        : [],
      hasMore: result.has_more === true,
      nextCursor: optionalString(result.next_cursor, 2_048),
      requestId: providerRequestId(result),
    };
  }

  async listAllMessages(input: {
    taskId: string;
    order?: "asc" | "desc";
    stopAfterOperationToken?: string;
  }): Promise<ManusV2MessageEvent[]> {
    const order = input.order ?? "desc";
    const events = new Map<string, ManusV2MessageEvent>();
    const seenCursors = new Set<string>();
    let cursor: string | null = null;
    let providerEncounterRank = 0;
    for (let page = 0; page < MAX_PAGES; page += 1) {
      const result = await this.listMessagesPage({
        taskId: input.taskId,
        order,
        cursor,
      });
      for (const event of result.messages) {
        const rankedEvent: ManusV2MessageEvent = {
          ...event,
          providerOriginalRank: providerEncounterRank++,
        };
        // Desc pagination observes the newest representation first. If the
        // Provider repeats an updated event on a later/older page, never let
        // that stale copy overwrite the authoritative first observation. Asc
        // pagination has the inverse page order, so the later copy wins.
        if (order === "desc" && events.has(event.id)) continue;
        events.set(event.id, rankedEvent);
      }
      if (
        input.stopAfterOperationToken &&
        manusV2EventsContainOperationToken(
          [...events.values()],
          input.stopAfterOperationToken,
        )
      ) {
        break;
      }
      if (!result.hasMore) break;
      if (!result.nextCursor || seenCursors.has(result.nextCursor)) {
        throw new ManusV2ApiError(
          "task.listMessages",
          502,
          "INVALID_PAGINATION",
          false,
          false,
        );
      }
      seenCursors.add(result.nextCursor);
      cursor = result.nextCursor;
    }
    const chronological = [...events.values()].sort((left, right) => {
      const timestampOrder = left.timestamp - right.timestamp;
      if (timestampOrder) return timestampOrder;
      const leftRank = Number(left.providerOriginalRank);
      const rightRank = Number(right.providerOriginalRank);
      return order === "asc" ? leftRank - rightRank : rightRank - leftRank;
    });
    return chronological.map<ManusV2MessageEvent>(
      (event, providerOriginalRank) => ({
        ...event,
        providerOriginalRank,
      }),
    );
  }

  async listTasks(
    input: {
      apiKeyId?: string;
      order?: "asc" | "desc";
    } = {},
  ) {
    const tasks = new Map<string, ManusV2TaskSummary>();
    const seenCursors = new Set<string>();
    let cursor: string | null = null;
    for (let page = 0; page < MAX_PAGES; page += 1) {
      const result = await this.listTasksPage({
        apiKeyId: input.apiKeyId,
        order: input.order,
        cursor,
      });
      for (const task of result.data) {
        tasks.set(task.id, {
          id: task.id,
          title: task.title,
          taskUrl: task.task_url,
          createdAt: task.created_at,
          updatedAt: task.updated_at,
          creditUsage: task.credit_usage,
          status: task.status,
        });
      }
      if (!result.has_more) break;
      const nextCursor = result.next_cursor;
      if (!nextCursor || seenCursors.has(nextCursor)) {
        throw new ManusV2ApiError(
          "task.list",
          502,
          "INVALID_PAGINATION",
          false,
          false,
        );
      }
      seenCursors.add(nextCursor);
      cursor = nextCursor;
    }
    return [...tasks.values()];
  }

  /**
   * One exact Manus v2 task.list page in the legacy-neutral shape consumed by
   * the rolling task-fact ledger. Cursor semantics are kept intact so callers
   * can persist coverage checkpoints without ever touching a v1 endpoint.
   */
  async listTasksPage(
    input: {
      apiKeyId?: string;
      order?: "asc" | "desc";
      cursor?: string | null;
      limit?: number;
    } = {},
  ): Promise<ManusV2TaskListPage> {
    const result = await this.request(
      "task.list",
      () =>
        this.api.get(`${this.baseUrl}/v2/task.list`, {
          params: {
            limit: Math.min(100, Math.max(1, input.limit ?? 100)),
            order: input.order ?? "desc",
            scope: "standard",
            ...(input.apiKeyId ? { api_key_id: input.apiKeyId } : {}),
            ...(input.cursor ? { cursor: input.cursor } : {}),
          },
        }),
      false,
    );
    const data = (Array.isArray(result.data) ? result.data : []).flatMap(
      (value) => {
        const record = upstreamTaskRecord(value);
        if (!record) return [];
        try {
          const id = requiredString(record.id, "task.id", 255);
          const title = requiredString(record.title, "task.title", 255);
          const numericCredit =
            record.credit_usage === undefined || record.credit_usage === null
              ? null
              : Number(record.credit_usage);
          if (
            numericCredit !== null &&
            (!Number.isSafeInteger(numericCredit) || numericCredit < 0)
          ) {
            return [];
          }
          return [
            {
              id,
              task_id: id,
              title,
              instructions: title,
              task_url: optionalString(record.task_url, 2_048),
              created_at: Number.isSafeInteger(Number(record.created_at))
                ? Number(record.created_at)
                : null,
              updated_at: Number.isSafeInteger(Number(record.updated_at))
                ? Number(record.updated_at)
                : null,
              credit_usage: numericCredit,
              status: optionalString(record.status, 64),
              metadata: { task_title: title, credit_usage: numericCredit },
            },
          ];
        } catch {
          return [];
        }
      },
    );
    return {
      data,
      has_more: result.has_more === true,
      next_cursor: optionalString(result.next_cursor, 2_048),
      request_id: providerRequestId(result),
    };
  }

  async probeCredential() {
    const result = await this.request(
      "task.list",
      () =>
        this.api.get(`${this.baseUrl}/v2/task.list`, {
          params: { limit: 1, order: "desc", scope: "standard" },
        }),
      false,
    );
    return { ok: true as const, requestId: providerRequestId(result) };
  }

  async findCreatedTask(input: {
    title: string;
    operationToken?: string;
    promptSha256?: string;
    attachmentFileIds?: readonly string[];
    attachmentManifest?: readonly GeneralChatLocalAttachmentManifestItem[];
    attachmentEvidenceReader?: GeneralChatProviderAttachmentReader;
    createdAfterSeconds?: number;
    createdBeforeSeconds?: number;
    apiKeyId?: string;
  }) {
    const title = requiredString(input.title, "title", 255);
    const candidates = (
      await this.listTasks({ apiKeyId: input.apiKeyId })
    ).filter(
      (task) =>
        task.title === title &&
        (input.createdAfterSeconds === undefined ||
          task.createdAt === null ||
          task.createdAt >= input.createdAfterSeconds) &&
        (input.createdBeforeSeconds === undefined ||
          task.createdAt === null ||
          task.createdAt <= input.createdBeforeSeconds),
    );
    if (!input.operationToken && !input.promptSha256) {
      throw new Error("findCreatedTask requires reconciliation evidence");
    }
    const matches: ManusV2TaskSummary[] = [];
    const unresolved: ManusV2TaskSummary[] = [];
    for (const candidate of candidates) {
      const events = await this.listAllMessages({
        taskId: candidate.id,
        order: "asc",
        ...(input.operationToken
          ? { stopAfterOperationToken: input.operationToken }
          : {}),
      });
      if (
        input.operationToken &&
        manusV2EventsContainOperationToken(events, input.operationToken)
      ) {
        matches.push(candidate);
        continue;
      }
      if (!input.promptSha256) continue;
      let candidateMatched = false;
      let candidateUnresolved = false;
      for (const event of events) {
        const disposition = await resolveManusV2GeneralChatUserEventEvidence({
          event,
          promptSha256: input.promptSha256,
          expectedAttachmentFileIds: input.attachmentFileIds ?? [],
          localAttachmentManifest: input.attachmentManifest,
          readUrl: input.attachmentEvidenceReader,
        });
        if (disposition.kind === "match") {
          candidateMatched = true;
        }
        if (disposition.kind === "unresolved") candidateUnresolved = true;
      }
      if (candidateMatched) {
        matches.push(candidate);
      }
      if (candidateUnresolved) {
        unresolved.push(candidate);
      }
    }
    return {
      candidates,
      matches,
      unresolved,
      unresolvedEvidenceCount: unresolved.length,
      unique: generalChatProviderEvidenceHasUniqueMatch({
        matchCount: matches.length,
        unresolvedCount: unresolved.length,
      })
        ? matches[0]!
        : null,
    };
  }

  async updateTaskVisibility(taskId: string, visible: boolean) {
    const normalizedTaskId = requiredString(taskId, "taskId", 255);
    await this.request(
      "task.update",
      () =>
        this.api.post(
          `${this.baseUrl}/v2/task.update`,
          {
            task_id: normalizedTaskId,
            enable_visible_in_task_list: visible,
          },
          { headers: { "Content-Type": "application/json" } },
        ),
      true,
    );
  }

  async createFile(
    filename: string,
    options: {
      retryPolicy?: ManusV2FileCreateRetryPolicy;
      sleep?: (ms: number) => Promise<void>;
      now?: () => number;
    } = {},
  ) {
    const normalizedFilename = requiredString(
      filename.replace(/[\\/\0]/gu, "_"),
      "filename",
      512,
    );
    const result = await this.request(
      "file.upload",
      () =>
        this.api.post(
          `${this.baseUrl}/v2/file.upload`,
          { filename: normalizedFilename },
          { headers: { "Content-Type": "application/json" } },
        ),
      true,
      {
        fileCreateRetryPolicy: options.retryPolicy,
        sleep: options.sleep,
        now: options.now,
      },
    );
    const file = upstreamTaskRecord(result.file);
    if (!file) {
      throw new ManusV2ApiError(
        "file.upload",
        502,
        "INVALID_RESPONSE",
        false,
        true,
        providerRequestId(result),
      );
    }
    const uploadExpiresAt = Number(result.upload_expires_at);
    if (!Number.isSafeInteger(uploadExpiresAt) || uploadExpiresAt <= 0) {
      throw new ManusV2ApiError(
        "file.upload",
        502,
        "INVALID_RESPONSE",
        false,
        true,
        providerRequestId(result),
      );
    }
    try {
      return {
        fileId: requiredString(file.id, "file.id", 512),
        filename: requiredString(file.filename, "file.filename", 512),
        uploadUrl: requiredString(result.upload_url, "upload_url", 8_192),
        uploadExpiresAt,
        requestId: providerRequestId(result),
      };
    } catch (error) {
      if (error instanceof ManusV2ApiError) {
        throw new ManusV2ApiError(
          "file.upload",
          200,
          "INVALID_RESPONSE",
          false,
          true,
          providerRequestId(result),
        );
      }
      throw error;
    }
  }

  async waitForExactProviderFile(
    input: ManusV2WaitForExactProviderFileInput,
  ): Promise<ManusV2ProviderFileDetail> {
    const expectedFileId = requiredString(input.fileId, "fileId", 512);
    const expectedFilename = canonicalProviderFilename(input.filename);
    const expectedBytes = requiredInteger(
      input.expectedBytes,
      "expectedBytes",
      0,
    );
    const expectedContentType = canonicalMediaType(input.expectedContentType);
    if (!expectedContentType) {
      throw new ManusV2ApiError(
        "contentType",
        502,
        "INVALID_RESPONSE",
        false,
        false,
      );
    }
    const minimumUsableSeconds = requiredInteger(
      input.minimumUsableSeconds ?? 15 * 60,
      "minimumUsableSeconds",
      1,
    );
    const readinessDeadlineMs = requiredInteger(
      input.readinessDeadlineMs ?? 5 * 60_000,
      "readinessDeadlineMs",
      1,
    );
    const detailAttemptTimeoutMs = requiredInteger(
      input.detailAttemptTimeoutMs ?? 20_000,
      "detailAttemptTimeoutMs",
      1,
    );
    const now = input.now ?? Date.now;
    const sleep =
      input.sleep ??
      ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
    const startedAt = now();
    if (!Number.isSafeInteger(startedAt) || startedAt < 0) {
      throw new Error("Invalid Manus v2 file confirmation clock");
    }
    const readinessDeadline = startedAt + readinessDeadlineMs;
    let elapsedBySleeps = 0;

    const confirmationUnknown = async () => {
      if (!input.observer?.onConfirmationUnknown || !input.candidate) return;
      try {
        await input.observer.onConfirmationUnknown(input.candidate);
      } catch (observerError) {
        console.error("[Manus v2] file confirmation journal failed", {
          diagnosticCode: "MANUS_V2_FILE_CONFIRMATION_JOURNAL_FAILED",
          errorType:
            observerError instanceof Error
              ? observerError.name
              : "UnknownError",
        });
      }
    };

    for (let attempt = 0; ; attempt += 1) {
      console.info("[Manus v2] provider file confirmation", {
        phase: "detail_attempt",
        detailAttempt: attempt + 1,
        declaredBytes: expectedBytes,
      });
      try {
        const detail = await this.fileDetail(expectedFileId, {
          signal: AbortSignal.timeout(detailAttemptTimeoutMs),
        });
        if (
          detail.fileId !== expectedFileId ||
          detail.filename !== expectedFilename
        ) {
          throw new ManusV2ApiError(
            "file.detail",
            502,
            "FILE_IDENTITY_CONFLICT",
            false,
            false,
          );
        }
        if (detail.status === "uploaded") {
          if (detail.bytes !== expectedBytes) {
            throw new ManusV2ApiError(
              "file.detail",
              502,
              "FILE_BYTES_CONFLICT",
              false,
              false,
            );
          }
          if (
            !isManusV2ProviderFileMimeUsable({
              filename: expectedFilename,
              expectedContentType,
              providerContentType: detail.contentType,
              providerContentTypeParseStatus: detail.contentTypeParseStatus,
              confirmationPolicy: input.confirmationPolicy ?? "strict",
            })
          ) {
            throw new ManusV2ApiError(
              "file.detail",
              502,
              "FILE_MIME_CONFLICT",
              false,
              false,
            );
          }
          const observedNow = Math.max(now(), startedAt + elapsedBySleeps);
          if (
            detail.expiresAt - Math.floor(observedNow / 1_000) <
            minimumUsableSeconds
          ) {
            throw new ManusV2ApiError(
              "file.detail",
              409,
              "FILE_EXPIRING",
              false,
              false,
            );
          }
          return detail;
        }
        if (detail.status === "deleted" || detail.status === "error") {
          throw new ManusV2ApiError(
            "file.detail",
            409,
            "FILE_UNUSABLE",
            false,
            false,
          );
        }
      } catch (error) {
        if (!retryableFileDetailFailure(error)) throw error;
      }

      const observedNow = Math.max(now(), startedAt + elapsedBySleeps);
      if (observedNow >= readinessDeadline) {
        await confirmationUnknown();
        throw new ManusV2ApiError(
          "file.detail",
          null,
          "FILE_UPLOAD_CONFIRMATION_UNKNOWN",
          false,
          true,
        );
      }
      const delayMs = Math.min(
        readinessDeadline - observedNow,
        3_000,
        500 * 2 ** Math.min(attempt, 3),
      );
      await sleep(delayMs);
      elapsedBySleeps += delayMs;
    }
  }

  async uploadFile(
    input: {
      filename: string;
      contentType: string;
      confirmationPolicy?: ManusV2FileConfirmationPolicy;
      minimumUsableSeconds?: number;
      readinessDeadlineMs?: number;
      detailAttemptTimeoutMs?: number;
      sleep?: (ms: number) => Promise<void>;
      now?: () => number;
      /** Disabled by default; only response-logic file intent creation opts in. */
      fileCreateRetryPolicy?: ManusV2FileCreateRetryPolicy;
      observer?: ManusV2FileUploadObserver;
      /** Resume a durable provider id after a crash/response-loss boundary. */
      existingCandidate?: {
        fileId: string;
        filename: string;
        /** Resume a durably known no-PUT candidate (0) or rejected PUT (1..3). */
        uploadUrl?: string;
        uploadExpiresAt?: number;
        resumePutRejectionCount?: number;
      };
    } & (
      | {
          bytes: Buffer;
          byteLength?: never;
          createReadStream?: never;
        }
      | {
          bytes?: never;
          byteLength: number;
          /** A PUT retry must receive a new, unread stream every time. */
          createReadStream: () => Readable;
        }
    ),
  ) {
    const expectedFilename = canonicalProviderFilename(input.filename);
    const expectedContentType = canonicalMediaType(input.contentType);
    if (!expectedContentType) {
      throw new ManusV2ApiError(
        "contentType",
        502,
        "INVALID_RESPONSE",
        false,
        false,
      );
    }
    const expectedBytes =
      input.bytes !== undefined
        ? input.bytes.length
        : requiredInteger(input.byteLength, "byteLength", 1);
    if (expectedBytes < 1) {
      throw new ManusV2ApiError(
        "file.upload.content",
        null,
        "FILE_BYTES_INVALID",
        false,
        false,
      );
    }
    const now = input.now ?? Date.now;
    const sleep =
      input.sleep ??
      ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
    const waitForExact = async (candidate: ManusV2CreatedFile) =>
      this.waitForExactProviderFile({
        fileId: candidate.fileId,
        filename: expectedFilename,
        expectedBytes,
        expectedContentType,
        confirmationPolicy: input.confirmationPolicy,
        minimumUsableSeconds: input.minimumUsableSeconds,
        readinessDeadlineMs: input.readinessDeadlineMs,
        detailAttemptTimeoutMs: input.detailAttemptTimeoutMs,
        sleep,
        now,
        observer: input.observer,
        candidate,
      });

    if (input.existingCandidate && !input.existingCandidate.uploadUrl) {
      const candidate: ManusV2CreatedFile = {
        fileId: requiredString(input.existingCandidate.fileId, "fileId", 512),
        filename: canonicalProviderFilename(input.existingCandidate.filename),
        uploadUrl: "",
        uploadExpiresAt: 0,
        requestId: null,
      };
      if (candidate.filename !== expectedFilename) {
        throw new ManusV2ApiError(
          "file.detail",
          502,
          "FILE_IDENTITY_CONFLICT",
          false,
          false,
        );
      }
      const detail = await waitForExact(candidate);
      return { ...candidate, requestId: detail.requestId, detail };
    }

    const resumedUpload = Boolean(input.existingCandidate?.uploadUrl);
    const created: ManusV2CreatedFile = resumedUpload
      ? {
          fileId: requiredString(
            input.existingCandidate!.fileId,
            "fileId",
            512,
          ),
          filename: canonicalProviderFilename(
            input.existingCandidate!.filename,
          ),
          uploadUrl: requiredString(
            input.existingCandidate!.uploadUrl,
            "uploadUrl",
            8_192,
          ),
          uploadExpiresAt: requiredInteger(
            input.existingCandidate!.uploadExpiresAt,
            "uploadExpiresAt",
            1,
          ),
          requestId: null,
        }
      : await this.createFile(expectedFilename, {
          retryPolicy: input.fileCreateRetryPolicy,
          sleep,
          now,
        });
    if (created.filename !== expectedFilename) {
      throw new ManusV2ApiError(
        "file.upload",
        502,
        "FILE_IDENTITY_CONFLICT",
        false,
        false,
      );
    }
    if (!resumedUpload) {
      await input.observer?.onCandidateCreated?.(created);
    }
    const uploadTarget = new URL(created.uploadUrl);
    if (
      uploadTarget.protocol !== "https:" ||
      uploadTarget.username ||
      uploadTarget.password
    ) {
      throw new ManusV2ApiError(
        "file.upload.content",
        null,
        "UNSAFE_UPLOAD_URL",
        false,
        false,
      );
    }
    const uploadDeadlineMs = created.uploadExpiresAt * 1_000 - 5_000;
    if (now() >= uploadDeadlineMs) {
      throw new ManusV2ApiError(
        "file.upload.content",
        null,
        "UPLOAD_URL_EXPIRED",
        false,
        false,
      );
    }
    const resumedRejectionCount = resumedUpload
      ? requiredInteger(
          input.existingCandidate!.resumePutRejectionCount,
          "resumePutRejectionCount",
          0,
        )
      : 0;
    if (resumedRejectionCount > 3) {
      throw new ManusV2ApiError(
        "file.upload.content",
        null,
        "PUT_RETRY_LIMIT_EXCEEDED",
        false,
        false,
      );
    }
    let putOutcomeUnknown = false;
    for (let putAttempt = resumedRejectionCount; ; putAttempt += 1) {
      await input.observer?.onPutStarted?.(created);
      // Axios consumes Node streams. Build the body outside the network
      // try/catch so a local stream-open failure is not misclassified as an
      // outcome-unknown PUT, and create a fresh stream for every retry.
      const uploadBody =
        input.bytes !== undefined ? input.bytes : input.createReadStream();
      let response: AxiosResponse;
      try {
        response = await axios.put(created.uploadUrl, uploadBody, {
          headers: {
            "Content-Type": expectedContentType,
            "Content-Length": String(expectedBytes),
          },
          timeout: Math.max(1, uploadDeadlineMs - now()),
          maxRedirects: 0,
          maxBodyLength: expectedBytes,
          maxContentLength: 1024 * 1024,
          validateStatus: () => true,
        });
      } catch {
        try {
          await input.observer?.onPutOutcomeUnknown?.(created);
        } catch (observerError) {
          console.error("[Manus v2] file outcome journal failed", {
            diagnosticCode: "MANUS_V2_FILE_OUTCOME_JOURNAL_FAILED",
            errorType:
              observerError instanceof Error
                ? observerError.name
                : "UnknownError",
          });
        }
        putOutcomeUnknown = true;
        break;
      }
      if (response.status >= 200 && response.status < 300) break;
      const rejectionCount = putAttempt + 1;
      const providerRetryAfterMs = retryAfterMs(response);
      const mayRetry = retryableStatus(response.status) && rejectionCount <= 3;
      if (!mayRetry) {
        await input.observer?.onPutRejected?.(created, {
          status: response.status,
          code: `HTTP_${response.status}`,
        });
        throw new ManusV2ApiError(
          "file.upload.content",
          response.status,
          `HTTP_${response.status}`,
          retryableStatus(response.status),
          false,
          null,
          providerRetryAfterMs,
        );
      }
      const delayMs = explicitFilePutRetryDelayMs({
        rejectionCount,
        retryAfterMs: providerRetryAfterMs,
        fileId: created.fileId,
      });
      const nextRetryAt = new Date(now() + delayMs).toISOString();
      await input.observer?.onPutRetryWait?.(created, {
        status: response.status,
        code: `HTTP_${response.status}`,
        retryAfterMs: providerRetryAfterMs,
        rejectionCount,
        nextRetryAt,
      });
      await sleep(delayMs);
      if (now() >= uploadDeadlineMs) {
        await input.observer?.onPutRejected?.(created, {
          status: 408,
          code: "UPLOAD_URL_EXPIRED",
        });
        throw new ManusV2ApiError(
          "file.upload.content",
          408,
          "UPLOAD_URL_EXPIRED",
          false,
          false,
        );
      }
    }
    if (!putOutcomeUnknown) {
      await input.observer?.onPutAccepted?.(created);
    }
    const detail = await waitForExact(created);
    return { ...created, detail };
  }

  async fileDetail(
    fileId: string,
    options?: { signal?: AbortSignal },
  ): Promise<ManusV2ProviderFileDetail> {
    const expectedFileId = requiredString(fileId, "fileId", 512);
    const result = await this.request(
      "file.detail",
      () =>
        this.api.get(`${this.baseUrl}/v2/file.detail`, {
          params: { file_id: expectedFileId },
          signal: options?.signal,
        }),
      false,
    );
    const file = upstreamTaskRecord(result.file);
    if (!file) {
      throw new ManusV2ApiError(
        "file.detail",
        502,
        "INVALID_RESPONSE",
        false,
        true,
        providerRequestId(result),
      );
    }
    let actualFileId: string;
    let status: string;
    let filename: string;
    let bytes: number | null;
    let expiresAt: number;
    let contentType: string | null;
    let contentTypeParseStatus: "valid" | "missing" | "invalid";
    try {
      actualFileId = requiredString(file.id, "file.id", 512);
      status = requiredString(file.status, "file.status", 32);
      filename = requiredString(file.filename, "file.filename", 512);
      bytes = file.bytes === null ? null : Number(file.bytes);
      expiresAt = Number(file.expires_at);
      if (
        file.content_type === undefined ||
        file.content_type === null ||
        file.content_type === ""
      ) {
        contentType = null;
        contentTypeParseStatus = "missing";
      } else if (
        typeof file.content_type === "string" &&
        file.content_type.length <= 255
      ) {
        contentType = canonicalMediaType(file.content_type);
        contentTypeParseStatus = contentType ? "valid" : "invalid";
      } else {
        contentType = null;
        contentTypeParseStatus = "invalid";
      }
    } catch (error) {
      if (error instanceof ManusV2ApiError) {
        throw new ManusV2ApiError(
          "file.detail",
          502,
          "INVALID_RESPONSE",
          false,
          true,
          providerRequestId(result),
        );
      }
      throw error;
    }
    if (actualFileId !== expectedFileId) {
      throw new ManusV2ApiError(
        "file.detail",
        502,
        "FILE_ID_CONFLICT",
        false,
        true,
        providerRequestId(result),
      );
    }
    if (!["pending", "uploaded", "deleted", "error"].includes(status)) {
      throw new ManusV2ApiError(
        "file.detail",
        502,
        "INVALID_RESPONSE",
        false,
        true,
        providerRequestId(result),
      );
    }
    if (
      !Number.isSafeInteger(expiresAt) ||
      expiresAt <= 0 ||
      (bytes !== null && (!Number.isSafeInteger(bytes) || bytes < 0))
    ) {
      throw new ManusV2ApiError(
        "file.detail",
        502,
        "INVALID_RESPONSE",
        false,
        true,
        providerRequestId(result),
      );
    }
    return {
      fileId: actualFileId,
      filename,
      status: status as "pending" | "uploaded" | "deleted" | "error",
      bytes,
      expiresAt,
      contentType,
      contentTypeParseStatus,
      requestId: providerRequestId(result),
    };
  }

  async deleteFile(fileId: string) {
    const expectedFileId = requiredString(fileId, "fileId", 512);
    const result = await this.request(
      "file.delete",
      () =>
        this.api.post(
          `${this.baseUrl}/v2/file.delete`,
          { file_id: expectedFileId },
          { headers: { "Content-Type": "application/json" } },
        ),
      true,
    );
    const file = upstreamTaskRecord(result.file ?? result.data ?? result);
    const actualFileId = file
      ? upstreamAliasedIdentity({
          record: file,
          aliases: ["file_id", "id"],
          label: "Manus v2 file id",
          maxLength: 512,
          required: false,
        })
      : optionalString(result.file_id, 512);
    if (actualFileId && actualFileId !== expectedFileId) {
      throw new ManusV2ApiError(
        "file.delete",
        502,
        "FILE_ID_CONFLICT",
        false,
        true,
        providerRequestId(result),
      );
    }
    return { fileId: expectedFileId, requestId: providerRequestId(result) };
  }
}
