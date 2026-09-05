import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { once } from "node:events";
import {
  Router,
  json,
  type NextFunction,
  type Request,
  type Response,
} from "express";
import axios from "axios";
import { z } from "zod";

import { AuthServiceError } from "./auth-service";
import {
  acquirePresalesTaskReservation,
  completePresalesTaskReservation,
  finalizePresalesFileUploadRetention,
  getActivePresalesCredential,
  getPresalesCredentialForResource,
  hashPresalesTaskPayload,
  hasPresalesOutputUrlGrant,
  recordPresalesUpstreamResource,
  releasePresalesTaskReservation,
  retainPresalesProjectFilePurgeTarget,
  retainPresalesTaskPurgeTarget,
  reservePresalesFileUploadRetention,
  resolvePresalesTaskCredentialForFiles,
  syncPresalesOutputUrlGrants,
  withPresalesProjectFileCreateGuard,
  type DecryptedPresalesCredential,
} from "./presales-service";
import { projectOrderProjectIdSchema } from "../shared/project-order-registry";
import {
  assertSafeExternalUrl,
  ExternalUrlRejectedError,
  safeExternalRequestOptions,
} from "./_core/safe-external-url";
import { getUpstreamBaseUrl, toUpstreamAgentProfile } from "./upstream-config";
import {
  getDedicatedMonitorCredentialReadiness,
  presalesMonitorRouter,
} from "./presales-monitor";
import { isFrontMindPublicUrlConfigured } from "./public-url";
import {
  acquirePresalesFileCreateReservation,
  completePresalesFileCreateReservation,
  hashPresalesFileCreatePayload,
  readPresalesFileLifecycle,
  readStoredPresalesFile,
  recordPresalesFileDescriptor,
  releasePresalesFileCreateReservation,
  removeStoredPresalesFile,
  removeStoredPresalesFileContent,
  stagePresalesFileContent,
} from "./presales-file-store";
import { FILE_CONTENT_RETENTION_MS } from "./file-content-retention";
import {
  OwnedFileContentError,
  OwnedFileContentResolver,
} from "./owned-file-content-resolver";
import {
  assertUpstreamPromptBudget,
  FRONTMIND_UPSTREAM_PROMPT_MAX_CHARACTERS,
  upstreamPromptCharacterCount,
} from "./upstream-prompt-budget";

const router = Router();
const SERVICE_TOKEN_HEADER = "x-frontmind-service-token";
const MAX_PROXY_UPLOAD_BYTES = 100 * 1024 * 1024;
const MAX_TRUSTED_TASK_ARTIFACTS = 32;
const UPSTREAM_TIMEOUT_MS = 300_000;
const UPLOAD_TICKET_DEFAULT_TTL_MS = 5 * 60 * 1000;
const UPLOAD_TICKET_MAX_TTL_MS = 10 * 60 * 1000;
const fileJsonParser = json({ limit: "16kb" });
const taskJsonParser = json({ limit: "4mb" });
const PUBLIC_PLACEHOLDER_SERVICE_TOKENS = new Set([
  "replace-with-at-least-32-random-characters",
  "replace-with-a-random-service-token",
  "replace-with-the-same-random-token",
  "change-me-change-me-change-me-change-me",
]);
const PUBLIC_PLACEHOLDER_MARKERS = [
  "replace-with",
  "same-random-token",
  "change-me",
];

const fileCreateSchema = z
  .object({
    filename: z.string().trim().min(1).max(512),
    projectId: projectOrderProjectIdSchema.optional(),
    mimeType: z.string().trim().max(255).optional(),
    sizeBytes: z
      .number()
      .int()
      .nonnegative()
      .max(MAX_PROXY_UPLOAD_BYTES)
      .optional(),
    idempotencyKey: z.string().trim().min(16).max(512).optional(),
  })
  .superRefine((value, context) => {
    if (value.projectId && !value.idempotencyKey) {
      context.addIssue({
        code: "custom",
        path: ["idempotencyKey"],
        message: "Project-bound files require an idempotency key",
      });
    }
  });

const attachmentSchema = z.object({
  file_id: z.string().trim().min(1).max(255),
  filename: z.string().trim().min(1).max(512),
});

const presalesAgentProfileSchema = z.enum(["frontmind-base", "frontmind-pro"]);

const taskCreateSchema = z
  .object({
    prompt: z.string().trim().min(1),
    attachments: z.array(attachmentSchema).max(20).optional().default([]),
    idempotencyKey: z.string().trim().min(16).max(512).optional(),
    projectId: z.string().trim().min(8).max(80).optional(),
    agentProfile: presalesAgentProfileSchema
      .optional()
      .default("frontmind-base"),
  })
  .superRefine((value, context) => {
    if (
      upstreamPromptCharacterCount(value.prompt) >
      FRONTMIND_UPSTREAM_PROMPT_MAX_CHARACTERS
    ) {
      context.addIssue({
        code: "custom",
        path: ["prompt"],
        message: `Task prompt must not exceed ${FRONTMIND_UPSTREAM_PROMPT_MAX_CHARACTERS} Unicode characters`,
      });
    }
    if (value.projectId && !value.idempotencyKey) {
      context.addIssue({
        code: "custom",
        path: ["idempotencyKey"],
        message: "Project-bound tasks require an idempotency key",
      });
    }
  });

export function buildPresalesTaskBody(input: {
  prompt: string;
  attachments?: Array<{ file_id: string; filename: string }>;
  agentProfile?: z.infer<typeof presalesAgentProfileSchema>;
}) {
  const prompt = assertUpstreamPromptBudget(input.prompt);
  const agentProfile =
    input.agentProfile === "frontmind-pro" ? "frontmind-pro" : "frontmind-base";
  return {
    prompt,
    attachments: input.attachments ?? [],
    agentProfile: toUpstreamAgentProfile(agentProfile),
    taskMode: "agent" as const,
  };
}

function tokenDigest(value: string) {
  return createHash("sha256").update(value, "utf8").digest();
}

type PresalesUploadTicketPayload = {
  fileId: string;
  target: string;
  expiresAt: number;
};

function uploadTicketSignature(encodedPayload: string, secret: string) {
  return createHmac("sha256", secret)
    .update(`frontmind-presales-upload:v1.${encodedPayload}`, "utf8")
    .digest();
}

function uploadTicketExpiry(value: unknown, now: number) {
  let parsed = Number.NaN;
  if (typeof value === "number") {
    parsed = value < 1_000_000_000_000 ? value * 1000 : value;
  } else if (typeof value === "string" && value.trim()) {
    const numeric = Number(value);
    parsed = Number.isFinite(numeric)
      ? numeric < 1_000_000_000_000
        ? numeric * 1000
        : numeric
      : Date.parse(value);
  }
  const upstreamExpiry =
    Number.isFinite(parsed) && parsed > now
      ? parsed
      : now + UPLOAD_TICKET_DEFAULT_TTL_MS;
  return Math.min(upstreamExpiry, now + UPLOAD_TICKET_MAX_TTL_MS);
}

/**
 * Preserve the create-file upload capability without trusting a later
 * caller-supplied URL. The upstream only guarantees upload_url on creation;
 * its file-detail response may omit that short-lived capability.
 */
export function createPresalesUploadTicket(
  input: { fileId: string; target: string; upstreamExpiresAt?: unknown },
  secret = process.env.FRONTMIND_PRESALES_SERVICE_TOKEN ?? "",
  now = Date.now(),
) {
  const fileId = input.fileId.trim();
  if (
    !isUsablePresalesServiceToken(secret) ||
    !fileId ||
    fileId.length > 255 ||
    input.target.length > 4096
  ) {
    throw new ExternalUrlRejectedError("Invalid presales upload capability");
  }
  const payload: PresalesUploadTicketPayload = {
    fileId,
    target: assertSafeExternalUrl(input.target),
    expiresAt: uploadTicketExpiry(input.upstreamExpiresAt, now),
  };
  const encodedPayload = Buffer.from(JSON.stringify(payload), "utf8").toString(
    "base64url",
  );
  const signature = uploadTicketSignature(encodedPayload, secret).toString(
    "base64url",
  );
  return `v1.${encodedPayload}.${signature}`;
}

export function openPresalesUploadTicket(
  ticket: string,
  expectedFileId: string,
  secret = process.env.FRONTMIND_PRESALES_SERVICE_TOKEN ?? "",
  now = Date.now(),
) {
  if (
    !isUsablePresalesServiceToken(secret) ||
    !ticket ||
    ticket.length > 12_000
  ) {
    throw new ExternalUrlRejectedError("Invalid presales upload capability");
  }
  const [version, encodedPayload, encodedSignature, extra] = ticket.split(".");
  if (version !== "v1" || !encodedPayload || !encodedSignature || extra) {
    throw new ExternalUrlRejectedError("Invalid presales upload capability");
  }
  const expectedSignature = uploadTicketSignature(encodedPayload, secret);
  let suppliedSignature: Buffer;
  try {
    suppliedSignature = Buffer.from(encodedSignature, "base64url");
  } catch {
    throw new ExternalUrlRejectedError("Invalid presales upload capability");
  }
  if (
    suppliedSignature.toString("base64url") !== encodedSignature ||
    suppliedSignature.length !== expectedSignature.length ||
    !timingSafeEqual(suppliedSignature, expectedSignature)
  ) {
    throw new ExternalUrlRejectedError("Invalid presales upload capability");
  }
  let payload: PresalesUploadTicketPayload;
  try {
    const payloadBytes = Buffer.from(encodedPayload, "base64url");
    if (payloadBytes.toString("base64url") !== encodedPayload) {
      throw new Error("Non-canonical upload capability");
    }
    const parsed = JSON.parse(payloadBytes.toString("utf8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("Invalid upload capability payload");
    }
    payload = parsed as PresalesUploadTicketPayload;
  } catch {
    throw new ExternalUrlRejectedError("Invalid presales upload capability");
  }
  if (
    payload.fileId !== expectedFileId ||
    !Number.isSafeInteger(payload.expiresAt) ||
    payload.expiresAt <= now ||
    payload.expiresAt > now + UPLOAD_TICKET_MAX_TTL_MS ||
    typeof payload.target !== "string" ||
    payload.target.length > 4096
  ) {
    throw new ExternalUrlRejectedError("Invalid presales upload capability");
  }
  return assertSafeExternalUrl(payload.target);
}

/** Constant-time service-token validation, including unequal-length inputs. */
export function isValidPresalesServiceToken(
  provided: string | undefined,
  configured = process.env.FRONTMIND_PRESALES_SERVICE_TOKEN,
) {
  const expected = configured ?? "";
  const candidate = provided ?? "";
  const equal = timingSafeEqual(tokenDigest(candidate), tokenDigest(expected));
  return (
    isUsablePresalesServiceToken(expected) && candidate.length > 0 && equal
  );
}

function isUsablePresalesServiceToken(token: string) {
  const normalized = token.trim();
  return (
    normalized.length >= 32 &&
    !PUBLIC_PLACEHOLDER_SERVICE_TOKENS.has(normalized.toLowerCase()) &&
    !PUBLIC_PLACEHOLDER_MARKERS.some((marker) =>
      normalized.toLowerCase().includes(marker),
    )
  );
}

export function assertPresalesProxyConfigured() {
  const token = process.env.FRONTMIND_PRESALES_SERVICE_TOKEN ?? "";
  if (!isUsablePresalesServiceToken(token)) {
    throw new Error(
      "FRONTMIND_PRESALES_SERVICE_TOKEN must be a unique random value with at least 32 characters",
    );
  }
}

export function requirePresalesServiceToken(
  req: Request,
  res: Response,
  next: NextFunction,
) {
  const configured = process.env.FRONTMIND_PRESALES_SERVICE_TOKEN;
  if (!configured || !isUsablePresalesServiceToken(configured)) {
    res.status(503).json({
      error: {
        code: "PRESALES_SERVICE_UNAVAILABLE",
        message: "Presales service authentication is not configured",
      },
    });
    return;
  }
  const header = req.headers[SERVICE_TOKEN_HEADER];
  const provided = Array.isArray(header) ? header[0] : header;
  if (!isValidPresalesServiceToken(provided, configured)) {
    res.status(401).json({
      error: { code: "INVALID_SERVICE_TOKEN", message: "Unauthorized" },
    });
    return;
  }
  res.setHeader("Cache-Control", "no-store");
  next();
}

function upstreamHeaders(apiKey: string) {
  return {
    API_KEY: apiKey,
    Authorization: `Bearer ${apiKey}`,
    Accept: "application/json",
  };
}

const presalesOwnedFileContentResolver = new OwnedFileContentResolver({
  getCredential: async (_ownerUserId, kind, fileId) => {
    const credential = await getPresalesCredentialForResource(kind, fileId);
    if (!credential) return null;
    const contentSource = credential.resource.contentSource;
    if (!contentSource) {
      throw new OwnedFileContentError(
        "SOURCE_UNAVAILABLE",
        "文件来源台账缺失，请联系管理员",
        {
          statusCode: 410,
          retryable: false,
          recoveryAction: "contact_admin",
        },
      );
    }
    const uploadedAt = credential.resource.uploadedAt;
    const contentExpiresAt = credential.resource.contentExpiresAt;
    const uploadReservedAt = credential.resource.uploadReservedAt;
    const hasUploadReservedAt = uploadReservedAt !== null;
    const hasUploadedAt = uploadedAt !== null;
    const hasContentExpiresAt = contentExpiresAt !== null;
    if (
      contentSource === "assistant_output" &&
      (hasUploadReservedAt || hasUploadedAt || hasContentExpiresAt)
    ) {
      throw new OwnedFileContentError(
        "SOURCE_UNAVAILABLE",
        "文件来源与数据库生命周期台账不一致，请联系管理员",
        {
          statusCode: 410,
          retryable: false,
          recoveryAction: "contact_admin",
        },
      );
    }
    if (
      contentSource === "user_upload" &&
      !(
        (!hasUploadReservedAt && !hasUploadedAt && !hasContentExpiresAt) ||
        (hasUploadReservedAt && !hasUploadedAt && !hasContentExpiresAt) ||
        (uploadReservedAt &&
          uploadedAt &&
          contentExpiresAt &&
          Number.isFinite(uploadReservedAt.getTime()) &&
          uploadReservedAt.getTime() === uploadedAt.getTime() &&
          Number.isFinite(contentExpiresAt.getTime()) &&
          contentExpiresAt.getTime() - uploadedAt.getTime() ===
            FILE_CONTENT_RETENTION_MS)
      )
    ) {
      throw new OwnedFileContentError(
        "SOURCE_UNAVAILABLE",
        "文件生命周期数据库台账无效，请联系管理员",
        {
          statusCode: 410,
          retryable: false,
          recoveryAction: "contact_admin",
        },
      );
    }
    if (credential.resource.contentDeletedAt) {
      throw new OwnedFileContentError(
        contentSource === "user_upload"
          ? "SOURCE_EXPIRED"
          : "SOURCE_UNAVAILABLE",
        contentSource === "user_upload"
          ? "文件已超过 30 天或已删除，请重新上传"
          : "文件已删除，无法继续读取",
        {
          statusCode: 410,
          retryable: false,
          recoveryAction: "reupload",
          expiresAt: credential.resource.contentExpiresAt?.getTime(),
        },
      );
    }
    if (contentSource === "assistant_output") {
      let lifecycle;
      try {
        lifecycle = await readPresalesFileLifecycle(fileId);
      } catch {
        throw new OwnedFileContentError(
          "SOURCE_UNAVAILABLE",
          "本地文件生命周期记录损坏，请联系管理员",
          {
            statusCode: 410,
            retryable: false,
            recoveryAction: "contact_admin",
          },
        );
      }
      if (
        lifecycle?.uploadedAt ||
        lifecycle?.contentExpiresAt ||
        lifecycle?.contentDeletedAt ||
        lifecycle?.state === "expired"
      ) {
        throw new OwnedFileContentError(
          "SOURCE_UNAVAILABLE",
          "文件来源与本地生命周期台账不一致，请联系管理员",
          {
            statusCode: 410,
            retryable: false,
            recoveryAction: "contact_admin",
          },
        );
      }
      return {
        id: credential.id,
        apiKey: credential.apiKey,
        resource: {
          createdAt: credential.resource.createdAt,
          parentTaskId: credential.resource.parentTaskId,
          contentSource,
        },
      };
    }

    if (!uploadReservedAt || !uploadedAt || !contentExpiresAt) {
      throw new OwnedFileContentError(
        "SOURCE_UNAVAILABLE",
        "文件尚未上传成功，请重新上传",
        {
          statusCode: 410,
          retryable: false,
          recoveryAction: "reupload",
        },
      );
    }
    let lifecycle;
    try {
      lifecycle = await readPresalesFileLifecycle(fileId);
    } catch {
      // DB is authoritative. A broken manifest is only a damaged cache and
      // must be removed in full so /content can be recaptured with the DB clock.
      await removeStoredPresalesFile(fileId);
      lifecycle = null;
    }
    if (
      lifecycle?.state === "expired" ||
      (lifecycle?.uploadedAt &&
        lifecycle.uploadedAt.getTime() !== uploadedAt.getTime()) ||
      (lifecycle?.contentExpiresAt &&
        lifecycle.contentExpiresAt.getTime() !== contentExpiresAt.getTime())
    ) {
      await removeStoredPresalesFile(fileId);
      lifecycle = null;
    }
    return {
      id: credential.id,
      apiKey: credential.apiKey,
      resource: {
        createdAt: credential.resource.createdAt,
        parentTaskId: credential.resource.parentTaskId,
        contentSource,
        uploadedAt,
        contentExpiresAt,
        contentDeletedAt: credential.resource.contentDeletedAt,
      },
    };
  },
  readStoredFile: readStoredPresalesFile,
  removeStoredFile: removeStoredPresalesFileContent,
  stageStoredFile: stagePresalesFileContent,
  getBaseUrl: getUpstreamBaseUrl,
  request: (url, options) => axios.get(url, options),
});

function safeFilename(value: unknown, fallback = "download") {
  const filename = String(value || fallback)
    .replace(/[\\/\0\r\n]/g, "_")
    .trim();
  return filename || fallback;
}

function upstreamErrorDetail(data: any, fallback: string, apiKey?: string) {
  const detail = String(
    data?.error?.message ?? data?.message ?? fallback,
  ).slice(0, 500);
  return apiKey && detail.includes(apiKey)
    ? detail.split(apiKey).join("[redacted]")
    : detail;
}

function forwardedStatus(value: unknown, fallback = 502) {
  const status = Number(value);
  return Number.isInteger(status) && status >= 400 && status < 600
    ? status
    : fallback;
}

function isDefinitiveFileCreateRejection(status: number) {
  return (
    status >= 400 && status < 500 && ![408, 409, 425, 429].includes(status)
  );
}

function sendKnownError(res: Response, error: unknown) {
  if (error instanceof z.ZodError) {
    res.status(400).json({
      error: {
        code: "INVALID_REQUEST",
        message: error.issues[0]?.message ?? "Invalid request",
      },
    });
    return;
  }
  if (error instanceof AuthServiceError) {
    if (error.retryAfterMs) {
      res.setHeader(
        "Retry-After",
        String(Math.ceil(error.retryAfterMs / 1000)),
      );
    }
    const status =
      error.code === "NOT_FOUND"
        ? 404
        : error.code === "PROJECT_DELETED"
          ? 410
          : error.code === "CONFLICT"
            ? 409
            : error.code === "INVALID_CREDENTIAL"
              ? 428
              : error.code === "IDEMPOTENCY_PENDING"
                ? 425
                : error.code === "UPSTREAM_UNAVAILABLE"
                  ? 502
                  : 503;
    res.status(status).json({
      error: { code: error.code, message: error.message },
    });
    return;
  }
  if (error instanceof ExternalUrlRejectedError) {
    res.status(502).json({
      error: {
        code: "INVALID_UPSTREAM_FILE_URL",
        message: "Upstream file URL is not safe to access",
      },
    });
    return;
  }
  // Transport libraries can embed request headers or serialized bodies in an
  // error message. Keep operation keys, API keys, prompts and attachment
  // metadata out of production logs even on an unexpected failure.
  console.error("[Presales Proxy] Request failed", {
    diagnosticCode: "PRESALES_UPSTREAM_ERROR",
    errorType: error instanceof Error ? error.name : "UnknownError",
  });
  res.status(502).json({
    error: {
      code: "PRESALES_UPSTREAM_ERROR",
      message: "Presales upstream request failed",
    },
  });
}

async function requireActiveCredential() {
  const credential = await getActivePresalesCredential();
  if (!credential) {
    throw new AuthServiceError("INVALID_CREDENTIAL", "售前 API Key 尚未配置");
  }
  return credential;
}

async function requireResourceCredential(kind: "task" | "file", id: string) {
  const credential = await getPresalesCredentialForResource(kind, id);
  if (!credential) {
    throw new AuthServiceError("NOT_FOUND", "Presales resource not found");
  }
  return credential;
}

function normalizeTask(payload: any) {
  if (!payload || typeof payload !== "object") return payload;
  return {
    ...payload,
    id: payload.id ?? payload.task_id,
    status: payload.status === "failed" ? "error" : payload.status,
  };
}

/** Defensive redaction in case a compatible upstream echoes auth material. */
export function redactUpstreamPayload(
  value: unknown,
  apiKey: string,
  depth = 0,
): unknown {
  if (depth > 40) return "[truncated]";
  if (value === null || value === undefined) return value;
  if (typeof value === "string") {
    return apiKey && value.includes(apiKey)
      ? value.split(apiKey).join("[redacted]")
      : value;
  }
  if (typeof value !== "object") return value;
  if (Array.isArray(value)) {
    return value.map((item) => redactUpstreamPayload(item, apiKey, depth + 1));
  }
  const output: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value)) {
    if (key === "apiKey" || key === "api_key" || key === "authorization") {
      continue;
    }
    output[key] = redactUpstreamPayload(child, apiKey, depth + 1);
  }
  return output;
}

export type TaskArtifacts = {
  fileIds: Set<string>;
  strictOutputFileIds: Set<string>;
  urls: Set<string>;
  truncated: boolean;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isOutputFileRecord(value: unknown): value is Record<string, unknown> {
  if (!isRecord(value)) return false;
  const type = String(value.type ?? "").toLowerCase();
  return type === "output_file" || type === "file";
}

function trustedFileIdFromUrl(value: string) {
  const match = value.match(/\/v1\/files\/([^/?#]+)/i);
  if (!match?.[1]) return "";
  try {
    const fileId = decodeURIComponent(match[1]).trim();
    return fileId.length <= 255 ? fileId : "";
  } catch {
    return "";
  }
}

/**
 * Only vendor-typed output-file records are trusted. Text, prompt content,
 * metadata and arbitrary nested objects can never mint file/download grants.
 */
export function collectTaskArtifacts(value: unknown): TaskArtifacts {
  const result: TaskArtifacts = {
    fileIds: new Set(),
    strictOutputFileIds: new Set(),
    urls: new Set(),
    truncated: false,
  };
  if (!isRecord(value) || !Array.isArray(value.output)) return result;

  const candidates: Record<string, unknown>[] = [];
  const addCandidate = (candidate: Record<string, unknown>) => {
    if (candidates.length < MAX_TRUSTED_TASK_ARTIFACTS + 1) {
      candidates.push(candidate);
    } else {
      result.truncated = true;
    }
  };
  for (const item of value.output) {
    if (isOutputFileRecord(item)) {
      addCandidate(item);
      continue;
    }
    if (!isRecord(item)) continue;
    const type = String(item.type ?? "").toLowerCase();
    if (
      (type && type !== "message" && type !== "output_message") ||
      item.role !== "assistant" ||
      !Array.isArray(item.content)
    ) {
      continue;
    }
    for (const content of item.content) {
      if (isOutputFileRecord(content)) addCandidate(content);
    }
  }

  for (const candidate of candidates) {
    if (result.fileIds.size + result.urls.size >= MAX_TRUSTED_TASK_ARTIFACTS) {
      result.truncated = true;
      break;
    }
    const rawFileId = candidate.file_id ?? candidate.fileId;
    const fileIdValue = typeof rawFileId === "string" ? rawFileId.trim() : "";
    const fileId = fileIdValue.length <= 255 ? fileIdValue : "";
    if (fileId) {
      result.fileIds.add(fileId);
      if (String(candidate.type ?? "").toLowerCase() === "output_file") {
        result.strictOutputFileIds.add(fileId);
      }
    }

    const rawUrl =
      candidate.fileUrl ??
      candidate.file_url ??
      candidate.download_url ??
      candidate.url;
    const url = typeof rawUrl === "string" ? rawUrl.trim() : "";
    if (
      !fileId &&
      /^https?:\/\//i.test(url) &&
      result.fileIds.size + result.urls.size < MAX_TRUSTED_TASK_ARTIFACTS
    ) {
      const inferredFileId = trustedFileIdFromUrl(url);
      if (inferredFileId) {
        result.fileIds.add(inferredFileId);
        if (String(candidate.type ?? "").toLowerCase() === "output_file") {
          result.strictOutputFileIds.add(inferredFileId);
        }
      }
    }
    if (
      url.length <= 4096 &&
      /^https?:\/\//i.test(url) &&
      result.fileIds.size + result.urls.size < MAX_TRUSTED_TASK_ARTIFACTS
    ) {
      result.urls.add(url);
    }
  }
  return result;
}

async function registerTaskArtifacts(
  taskId: string,
  task: unknown,
  credential: DecryptedPresalesCredential,
  projectId?: string,
) {
  const artifacts = collectTaskArtifacts(task);
  for (const fileId of artifacts.fileIds) {
    // A model cannot authorize an arbitrary identifier by printing it: the
    // authenticated upstream API must also confirm that the file exists under
    // the exact credential version bound to this task.
    await fetchFileMetadata(fileId, credential);
    try {
      await recordPresalesUpstreamResource({
        ...(projectId ? { projectId } : {}),
        apiCredentialId: credential.id,
        kind: "file",
        upstreamId: fileId,
        parentTaskId: taskId,
        contentSource: "assistant_output",
        verifiedAssistantOutput: artifacts.strictOutputFileIds.has(fileId),
      });
    } catch (error) {
      if (
        !(error instanceof AuthServiceError) ||
        error.code !== "PROJECT_DELETED" ||
        !artifacts.strictOutputFileIds.has(fileId)
      ) {
        throw error;
      }
      if (projectId) {
        await retainPresalesProjectFilePurgeTarget({
          projectId,
          fileId,
          apiCredentialId: credential.id,
        });
      }
      // Project removal is browser-local. Preserve the Provider output and its
      // durable evidence so a late result is adoptable instead of compensating
      // with a destructive Provider DELETE.
      continue;
    }
  }
  const normalizedUrls = new Set<string>();
  for (const value of artifacts.urls) {
    const target = assertSafeExternalUrl(value);
    normalizedUrls.add(target);
  }
  await syncPresalesOutputUrlGrants({
    apiCredentialId: credential.id,
    parentTaskId: taskId,
    urls: [...normalizedUrls].map((url) => ({
      url,
      hostname: new URL(url).hostname,
    })),
  });
  artifacts.urls = normalizedUrls;
  return artifacts;
}

async function retrieveTask(
  taskId: string,
  credential: DecryptedPresalesCredential,
) {
  const response = await axios.get(
    `${getUpstreamBaseUrl()}/v1/tasks/${encodeURIComponent(taskId)}`,
    {
      headers: upstreamHeaders(credential.apiKey),
      timeout: UPSTREAM_TIMEOUT_MS,
      validateStatus: () => true,
    },
  );
  if (response.status < 200 || response.status >= 300) {
    throw new AuthServiceError(
      response.status === 401 || response.status === 403
        ? "INVALID_CREDENTIAL"
        : "UPSTREAM_UNAVAILABLE",
      upstreamErrorDetail(
        response.data,
        `Retrieve task failed (${response.status})`,
        credential.apiKey,
      ),
    );
  }
  const task = normalizeTask(
    redactUpstreamPayload(response.data, credential.apiKey),
  );
  const projectId = (
    credential as DecryptedPresalesCredential & {
      resource?: { projectId?: string | null };
    }
  ).resource?.projectId;
  const artifacts = await registerTaskArtifacts(
    taskId,
    task,
    credential,
    projectId ?? undefined,
  );
  return { task, artifacts };
}

router.use(requirePresalesServiceToken);
router.use("/monitor-runs", presalesMonitorRouter);

router.get("/status", async (req, res) => {
  try {
    const forceMonitorCredentialRefresh =
      req.query.monitorCredentialProbe === "fresh";
    const [credential, monitorCredential] = await Promise.all([
      getActivePresalesCredential(),
      getDedicatedMonitorCredentialReadiness(process.env, {
        forceRefresh: forceMonitorCredentialRefresh,
      }),
    ]);
    res.json({
      // Keep legacy Website builds fail-closed during the rolling upgrade:
      // they understand `ok` but not the new authenticated field. The
      // configured boolean below now retains its literal meaning.
      ok: monitorCredential.authenticated,
      credentialConfigured: Boolean(credential),
      monitorCredentialConfigured: monitorCredential.configured,
      monitorCredentialAuthenticated: monitorCredential.authenticated,
      publicUrlConfigured: isFrontMindPublicUrlConfigured(),
    });
  } catch (error) {
    sendKnownError(res, error);
  }
});

router.post("/files", fileJsonParser, async (req, res) => {
  try {
    const input = fileCreateSchema.parse(req.body ?? {});
    const credential = await requireActiveCredential();
    let reservation: {
      keyHash: string;
      attemptId: string;
    } | null = null;
    if (input.idempotencyKey) {
      const reservationInput = {
        idempotencyKey: input.idempotencyKey,
        requestHash: hashPresalesFileCreatePayload(input),
        compatibleRequestHashes: input.projectId
          ? [hashPresalesFileCreatePayload({ ...input, projectId: undefined })]
          : [],
        projectId: input.projectId,
        apiCredentialId: credential.id,
        credentialVersion: credential.version,
      };
      const acquired = input.projectId
        ? await withPresalesProjectFileCreateGuard(
            input.projectId,
            credential.id,
            () => acquirePresalesFileCreateReservation(reservationInput),
          )
        : await acquirePresalesFileCreateReservation(reservationInput);
      if (acquired.state === "conflict") {
        throw new AuthServiceError(
          "CONFLICT",
          "该幂等键已用于不同的文件请求或 API Key 版本",
        );
      }
      if (acquired.state === "pending") {
        throw new AuthServiceError(
          "IDEMPOTENCY_PENDING",
          "相同文件正在创建中，请稍后重试",
          acquired.retryAfterMs,
        );
      }
      if (acquired.state === "deleted") {
        res.status(410).json({
          error: {
            code: "FILE_OPERATION_RETIRED",
            message: "该文件创建操作已完成清理，不能再次执行",
          },
        });
        return;
      }
      if (acquired.state === "completed") {
        if (input.projectId) {
          await recordPresalesUpstreamResource({
            projectId: input.projectId,
            apiCredentialId: credential.id,
            kind: "file",
            upstreamId: acquired.upstreamFileId,
            contentSource: "user_upload",
          });
        }
        const proxyUploadTicket = acquired.uploadUrl
          ? createPresalesUploadTicket({
              fileId: acquired.upstreamFileId,
              target: acquired.uploadUrl,
              upstreamExpiresAt: acquired.uploadExpiresAt,
            })
          : undefined;
        res.setHeader("Idempotent-Replayed", "true");
        res.status(200).json({
          id: acquired.upstreamFileId,
          filename: acquired.upstreamFilename ?? input.filename,
          status: acquired.upstreamStatus ?? "pending",
          ...(acquired.uploadExpiresAt !== null
            ? { upload_expires_at: acquired.uploadExpiresAt }
            : {}),
          ...(proxyUploadTicket
            ? { proxy_upload_ticket: proxyUploadTicket }
            : {}),
        });
        return;
      }
      reservation = acquired;
    }
    const response = await axios.post(
      `${getUpstreamBaseUrl()}/v1/files`,
      { filename: input.filename },
      {
        headers: {
          ...upstreamHeaders(credential.apiKey),
          "Content-Type": "application/json",
          ...(reservation ? { "Idempotency-Key": reservation.keyHash } : {}),
        },
        timeout: 120_000,
        validateStatus: () => true,
      },
    );
    if (response.status < 200 || response.status >= 300) {
      if (reservation && isDefinitiveFileCreateRejection(response.status)) {
        await releasePresalesFileCreateReservation(reservation);
      }
      return res.status(forwardedStatus(response.status)).json({
        error: {
          code: "UPSTREAM_FILE_CREATE_FAILED",
          message: upstreamErrorDetail(
            response.data,
            "File creation failed",
            credential.apiKey,
          ),
        },
      });
    }
    const id = String(response.data?.id ?? response.data?.file_id ?? "");
    if (!id) {
      throw new AuthServiceError(
        "UPSTREAM_UNAVAILABLE",
        "File creation response did not include an id",
      );
    }
    const payload = redactUpstreamPayload(response.data, credential.apiKey) as
      | Record<string, unknown>
      | undefined;
    const uploadUrl =
      typeof payload?.upload_url === "string" ? payload.upload_url : "";
    if (reservation) {
      await completePresalesFileCreateReservation({
        ...reservation,
        upstreamFileId: id,
        upstreamFilename:
          typeof payload?.filename === "string"
            ? payload.filename
            : input.filename,
        upstreamStatus:
          typeof payload?.status === "string" ? payload.status : "pending",
        ...(uploadUrl ? { uploadUrl } : {}),
        ...(typeof payload?.upload_expires_at === "string" ||
        typeof payload?.upload_expires_at === "number"
          ? { uploadExpiresAt: payload.upload_expires_at }
          : {}),
      });
    }
    try {
      await recordPresalesUpstreamResource({
        projectId: input.projectId,
        apiCredentialId: credential.id,
        kind: "file",
        upstreamId: id,
        contentSource: "user_upload",
      });
    } catch (error) {
      if (
        !(error instanceof AuthServiceError) ||
        error.code !== "PROJECT_DELETED" ||
        !reservation
      ) {
        throw error;
      }
      if (input.projectId) {
        await retainPresalesProjectFilePurgeTarget({
          projectId: input.projectId,
          fileId: id,
          apiCredentialId: credential.id,
        });
      }
      throw error;
    }
    await recordPresalesFileDescriptor({
      fileId: id,
      filename: input.filename,
      mimeType: input.mimeType,
      sizeBytes: input.sizeBytes,
    });
    const proxyUploadTicket = uploadUrl
      ? createPresalesUploadTicket({
          fileId: id,
          target: uploadUrl,
          upstreamExpiresAt: payload?.upload_expires_at,
        })
      : undefined;
    res.status(201).json({
      ...(payload ?? {}),
      id,
      filename: payload?.filename ?? input.filename,
      ...(proxyUploadTicket ? { proxy_upload_ticket: proxyUploadTicket } : {}),
    });
  } catch (error) {
    sendKnownError(res, error);
  }
});

async function fetchFileMetadata(
  fileId: string,
  credential: DecryptedPresalesCredential,
) {
  const response = await axios.get(
    `${getUpstreamBaseUrl()}/v1/files/${encodeURIComponent(fileId)}`,
    {
      headers: upstreamHeaders(credential.apiKey),
      timeout: 30_000,
      validateStatus: () => true,
    },
  );
  if (response.status < 200 || response.status >= 300) {
    throw new AuthServiceError(
      response.status === 401 || response.status === 403
        ? "INVALID_CREDENTIAL"
        : "UPSTREAM_UNAVAILABLE",
      upstreamErrorDetail(
        response.data,
        `File lookup failed (${response.status})`,
        credential.apiKey,
      ),
    );
  }
  return response.data ?? {};
}

export function buildProxyUploadSuccess(upstreamStatus: number) {
  return { ok: true, status: "uploaded", upstreamStatus } as const;
}

router.put("/files/:fileId/content", async (req, res) => {
  try {
    const fileId = String(req.params.fileId || "");
    const credential = await requireResourceCredential("file", fileId);
    const resource = credential.resource;
    const uploadReservedAtMs = resource.uploadReservedAt?.getTime();
    const uploadedAtMs = resource.uploadedAt?.getTime();
    const contentExpiresAtMs = resource.contentExpiresAt?.getTime();
    if (resource.contentSource !== "user_upload") {
      throw new OwnedFileContentError(
        "SOURCE_FORBIDDEN",
        "文件不是可上传的用户文件，请重新创建文件",
        {
          statusCode: 403,
          retryable: false,
          recoveryAction: "reupload",
        },
      );
    }
    const isUnreserved =
      uploadReservedAtMs === undefined &&
      uploadedAtMs === undefined &&
      contentExpiresAtMs === undefined;
    const isReserved =
      uploadReservedAtMs !== undefined &&
      Number.isFinite(uploadReservedAtMs) &&
      uploadedAtMs === undefined &&
      contentExpiresAtMs === undefined;
    const isCompleted =
      uploadReservedAtMs !== undefined &&
      uploadedAtMs !== undefined &&
      contentExpiresAtMs !== undefined &&
      Number.isFinite(uploadReservedAtMs) &&
      uploadReservedAtMs === uploadedAtMs &&
      Number.isFinite(contentExpiresAtMs) &&
      contentExpiresAtMs - uploadedAtMs === FILE_CONTENT_RETENTION_MS;
    if (!isUnreserved && !isReserved && !isCompleted) {
      throw new OwnedFileContentError(
        "SOURCE_UNAVAILABLE",
        "文件生命周期数据库台账无效，请联系管理员",
        {
          statusCode: 410,
          retryable: false,
          recoveryAction: "contact_admin",
        },
      );
    }
    if (
      resource.contentDeletedAt ||
      (contentExpiresAtMs ??
        (uploadReservedAtMs === undefined
          ? undefined
          : uploadReservedAtMs + FILE_CONTENT_RETENTION_MS) ??
        Infinity) <= Date.now()
    ) {
      throw new OwnedFileContentError(
        "SOURCE_EXPIRED",
        "文件已超过 30 天或已删除，请重新上传",
        {
          statusCode: 410,
          retryable: false,
          recoveryAction: "reupload",
          expiresAt: contentExpiresAtMs,
        },
      );
    }
    const contentLength = Number(req.headers["content-length"] ?? 0);
    if (
      Number.isFinite(contentLength) &&
      contentLength > MAX_PROXY_UPLOAD_BYTES
    ) {
      return res.status(413).json({
        error: { code: "FILE_TOO_LARGE", message: "File exceeds 100 MB" },
      });
    }
    const ticketHeader = req.headers["x-frontmind-upload-ticket"];
    const uploadTicket = Array.isArray(ticketHeader)
      ? ticketHeader[0]
      : ticketHeader;
    const ticketTarget = uploadTicket
      ? openPresalesUploadTicket(uploadTicket, fileId)
      : null;
    const staged = await stagePresalesFileContent({
      fileId,
      stream: req,
      maxBytes: MAX_PROXY_UPLOAD_BYTES,
    });
    if (staged.sizeBytes === 0) {
      await staged.discard();
      return res.status(400).json({
        error: { code: "FILE_EMPTY", message: "File content is empty" },
      });
    }
    const originalContentType =
      String(req.headers["x-original-content-type"] ?? "") ||
      String(req.headers["content-type"] ?? "") ||
      "application/octet-stream";
    let response;
    let reservation;
    try {
      const reserveUpload = (executor?: any) =>
        reservePresalesFileUploadRetention(
          {
            fileId,
            apiCredentialId: credential.id,
            // The completed staged copy is the conservative first-attempt clock.
            // It is persisted before the external PUT and every retry reuses it.
            now: new Date(),
          },
          executor,
        );
      reservation = resource.projectId
        ? await withPresalesProjectFileCreateGuard(
            resource.projectId,
            credential.id,
            (tx) => reserveUpload(tx),
          )
        : await reserveUpload();
      const target =
        ticketTarget ??
        assertSafeExternalUrl(
          String(
            (await fetchFileMetadata(fileId, credential)).upload_url ?? "",
          ),
        );
      response = await axios.put(target, staged.createReadStream(), {
        ...safeExternalRequestOptions,
        // SigV4 authenticates the exact request URL; following a redirect would
        // invalidate the signature and surface as a misleading storage error.
        maxRedirects: 0,
        headers: {
          "Content-Type": originalContentType,
          "Content-Length": String(staged.sizeBytes),
        },
        timeout: UPSTREAM_TIMEOUT_MS,
        maxBodyLength: MAX_PROXY_UPLOAD_BYTES,
        maxContentLength: 1024 * 1024,
        validateStatus: () => true,
      });
    } catch (error) {
      await staged.discard();
      throw error;
    }
    if (response.status < 200 || response.status >= 300) {
      await staged.discard();
      return res.status(forwardedStatus(response.status)).json({
        error: {
          code: "UPSTREAM_FILE_UPLOAD_FAILED",
          message: upstreamErrorDetail(
            response.data,
            "File upload failed",
            credential.apiKey,
          ),
        },
      });
    }
    let retention;
    try {
      retention = await finalizePresalesFileUploadRetention({
        fileId,
        apiCredentialId: credential.id,
        now: new Date(),
      });
      await staged.commit({
        mimeType: originalContentType,
        uploadedAt: retention.uploadedAt,
        contentExpiresAt: retention.contentExpiresAt,
      });
    } catch {
      await staged.discard().catch(() => undefined);
      throw new OwnedFileContentError(
        "SOURCE_CAPTURE_FAILED",
        "上游已接收文件，但本地持久化失败，请重试",
        {
          statusCode: 503,
          retryable: true,
          recoveryAction: "retry",
          expiresAt:
            retention?.contentExpiresAt.getTime() ??
            reservation.uploadReservedAt.getTime() + FILE_CONTENT_RETENTION_MS,
        },
      );
    }
    res.status(200).json(buildProxyUploadSuccess(response.status));
  } catch (error) {
    if (error instanceof Error && error.message === "FILE_TOO_LARGE") {
      res.status(413).json({
        error: { code: "FILE_TOO_LARGE", message: "File exceeds 100 MB" },
      });
      return;
    }
    if (error instanceof OwnedFileContentError) {
      sendOwnedPresalesFileError(res, error);
      return;
    }
    sendKnownError(res, error);
  }
});

router.delete("/files/:fileId", (_req, res) => {
  // Rolling compatibility: Website project removal is local-only. Preserve
  // Provider files and Dashboard evidence for retention-based cleanup.
  res.status(204).end();
});

async function releaseTaskReservationSafely(reservation: {
  reservationId: string;
  attemptId: string;
}) {
  try {
    await releasePresalesTaskReservation(reservation);
  } catch (error) {
    console.error(
      "[Presales Proxy] Failed to release task reservation:",
      error instanceof Error ? error.message.slice(0, 200) : "Unknown error",
    );
  }
}

router.post("/tasks", taskJsonParser, async (req, res) => {
  try {
    const input = taskCreateSchema.parse(req.body ?? {});
    const credential = await resolvePresalesTaskCredentialForFiles(
      input.attachments.map((item) => item.file_id),
    );
    if (!credential) {
      throw new AuthServiceError("INVALID_CREDENTIAL", "售前 API Key 尚未配置");
    }
    const taskBody = buildPresalesTaskBody(input);
    let reservation: {
      reservationId: string;
      attemptId: string;
      keyHash: string;
    } | null = null;
    if (input.idempotencyKey) {
      const acquired = await acquirePresalesTaskReservation({
        idempotencyKey: input.idempotencyKey,
        requestHash: hashPresalesTaskPayload({
          projectId: input.projectId ?? null,
          task: taskBody,
        }),
        compatibleRequestHashes: input.projectId
          ? [hashPresalesTaskPayload(taskBody)]
          : [],
        projectId: input.projectId,
        apiCredentialId: credential.id,
        credentialVersion: credential.version,
      });
      if (acquired.state === "completed") {
        if (input.projectId) {
          for (const attachment of input.attachments) {
            await recordPresalesUpstreamResource({
              projectId: input.projectId,
              apiCredentialId: credential.id,
              kind: "file",
              upstreamId: attachment.file_id,
              contentSource: "user_upload",
            });
          }
        }
        // The reservation proves which immutable upstream task belongs to this
        // operation; it does not know the task's execution state. Refresh the
        // task before replaying so a finished translation (including typed
        // assistant output) is not downgraded forever to a synthetic `queued`
        // response.
        const { task } = await retrieveTask(
          acquired.upstreamTaskId,
          credential,
        );
        res.setHeader("Idempotent-Replayed", "true");
        res.status(200).json(task);
        return;
      }
      reservation = acquired;
    }

    // A transport error is ambiguous: the upstream may already have accepted
    // the task. Keep the lease in that case so an immediate retry cannot create
    // a duplicate; an expired lease retries with the same hashed upstream key.
    const response = await axios.post(
      `${getUpstreamBaseUrl()}/v1/tasks`,
      taskBody,
      {
        headers: {
          ...upstreamHeaders(credential.apiKey),
          "Content-Type": "application/json",
          ...(reservation ? { "Idempotency-Key": reservation.keyHash } : {}),
        },
        timeout: 120_000,
        validateStatus: () => true,
      },
    );
    if (response.status < 200 || response.status >= 300) {
      if (reservation) await releaseTaskReservationSafely(reservation);
      return res.status(forwardedStatus(response.status)).json({
        error: {
          code: "UPSTREAM_TASK_CREATE_FAILED",
          message: upstreamErrorDetail(
            response.data,
            "Task creation failed",
            credential.apiKey,
          ),
        },
      });
    }
    const task = normalizeTask(
      redactUpstreamPayload(response.data, credential.apiKey),
    );
    const id = String(task?.id ?? "");
    if (!id) {
      throw new AuthServiceError(
        "UPSTREAM_UNAVAILABLE",
        "Task creation response did not include an id",
      );
    }
    if (reservation) {
      try {
        await completePresalesTaskReservation({
          reservationId: reservation.reservationId,
          attemptId: reservation.attemptId,
          apiCredentialId: credential.id,
          upstreamTaskId: id,
          attachmentFileIds: input.attachments.map((item) => item.file_id),
        });
      } catch {
        await retainPresalesTaskPurgeTarget({
          reservationId: reservation.reservationId,
          attemptId: reservation.attemptId,
          apiCredentialId: credential.id,
          upstreamTaskId: id,
        }).catch(() => undefined);
        throw new AuthServiceError(
          "UPSTREAM_UNAVAILABLE",
          "上游已接收任务，正在等待本地确认",
        );
      }
    } else {
      await recordPresalesUpstreamResource({
        projectId: input.projectId,
        apiCredentialId: credential.id,
        kind: "task",
        upstreamId: id,
      });
      if (input.projectId) {
        for (const attachment of input.attachments) {
          await recordPresalesUpstreamResource({
            projectId: input.projectId,
            apiCredentialId: credential.id,
            kind: "file",
            upstreamId: attachment.file_id,
            contentSource: "user_upload",
          });
        }
      }
    }
    await registerTaskArtifacts(id, task, credential, input.projectId);
    res.status(201).json(task);
  } catch (error) {
    sendKnownError(res, error);
  }
});

async function sendTask(req: Request, res: Response) {
  try {
    const taskId = String(req.params.taskId || "");
    const credential = await requireResourceCredential("task", taskId);
    const { task } = await retrieveTask(taskId, credential);
    res.json(task);
  } catch (error) {
    sendKnownError(res, error);
  }
}

router.get("/tasks/:taskId", sendTask);
router.get("/tasks/:taskId/result", sendTask);

router.delete("/tasks/:taskId", (_req, res) => {
  // Provider task history is immutable from Website cleanup paths.
  res.status(204).end();
});

router.delete("/projects/:projectId/monitor-runs/:runId", async (req, res) => {
  try {
    projectOrderProjectIdSchema.parse(req.params.projectId);
    z.string().uuid().parse(req.params.runId);
    res.status(204).end();
  } catch (error) {
    sendKnownError(res, error);
  }
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
    sendKnownError(res, error);
  }
});

async function streamExternalOutput(
  res: Response,
  target: string,
  filename: string,
) {
  const response = await axios.get(assertSafeExternalUrl(target), {
    ...safeExternalRequestOptions,
    responseType: "stream",
    timeout: UPSTREAM_TIMEOUT_MS,
    maxContentLength: Infinity,
    validateStatus: () => true,
  });
  if (response.status < 200 || response.status >= 300) {
    res.status(forwardedStatus(response.status)).json({
      error: {
        code: "OUTPUT_DOWNLOAD_FAILED",
        message: "Output download failed",
      },
    });
    return;
  }
  res.status(200);
  res.setHeader(
    "Content-Type",
    String(response.headers["content-type"] ?? "application/octet-stream"),
  );
  if (response.headers["content-length"]) {
    res.setHeader("Content-Length", String(response.headers["content-length"]));
  }
  const encoded = encodeURIComponent(safeFilename(filename));
  res.setHeader(
    "Content-Disposition",
    `attachment; filename="${encoded}"; filename*=UTF-8''${encoded}`,
  );
  response.data.pipe(res);
}

function sendOwnedPresalesFileError(res: Response, error: unknown) {
  if (res.headersSent) {
    res.destroy();
    return;
  }
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
  sendKnownError(res, error);
}

async function streamResolvedPresalesFile(
  res: Response,
  resolved: Awaited<ReturnType<OwnedFileContentResolver["resolve"]>>,
) {
  if (
    resolved.sizeBytes !== undefined &&
    (!Number.isSafeInteger(resolved.sizeBytes) ||
      resolved.sizeBytes < 1 ||
      resolved.sizeBytes > MAX_PROXY_UPLOAD_BYTES)
  ) {
    resolved.stream.destroy();
    throw new OwnedFileContentError(
      "SOURCE_CONTENT_TOO_LARGE",
      "文件超过 100 MB，无法下载",
      {
        statusCode: 413,
        retryable: false,
        recoveryAction: "reupload",
        expiresAt: resolved.expiresAt,
      },
    );
  }

  const writeHeaders = () => {
    res.status(200);
    res.setHeader(
      "Content-Type",
      resolved.mimeType || "application/octet-stream",
    );
    if (resolved.sizeBytes !== undefined) {
      res.setHeader("Content-Length", String(resolved.sizeBytes));
    }
    const encoded = encodeURIComponent(
      safeFilename(resolved.filename, resolved.fileId),
    );
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="${encoded}"; filename*=UTF-8''${encoded}`,
    );
  };

  let streamedBytes = 0;
  for await (const value of resolved.stream) {
    const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value);
    if (!chunk.length) continue;
    if (streamedBytes + chunk.length > MAX_PROXY_UPLOAD_BYTES) {
      resolved.stream.destroy();
      throw new OwnedFileContentError(
        "SOURCE_CONTENT_TOO_LARGE",
        "文件超过 100 MB，无法下载",
        {
          statusCode: 413,
          retryable: false,
          recoveryAction: "reupload",
          expiresAt: resolved.expiresAt,
        },
      );
    }
    if (streamedBytes === 0) writeHeaders();
    streamedBytes += chunk.length;
    if (!res.write(chunk)) await once(res, "drain");
  }
  if (streamedBytes < 1) {
    throw new OwnedFileContentError(
      "SOURCE_CONTENT_INVALID",
      "上游未返回有效文件内容，请重新上传",
      {
        statusCode: 422,
        retryable: false,
        recoveryAction: "reupload",
        expiresAt: resolved.expiresAt,
      },
    );
  }
  if (
    resolved.sizeBytes !== undefined &&
    streamedBytes !== resolved.sizeBytes
  ) {
    throw new OwnedFileContentError(
      "SOURCE_DOWNLOAD_FAILED",
      "文件内容读取不完整，请重试",
      {
        statusCode: 503,
        retryable: true,
        recoveryAction: "retry",
        expiresAt: resolved.expiresAt,
      },
    );
  }
  res.end();
}

router.get("/files/:fileId/content", async (req, res) => {
  try {
    const fileId = String(req.params.fileId || "");
    const resolved = await presalesOwnedFileContentResolver.resolve({
      // The service-token boundary owns presales access; the resolver's
      // credential adapter ignores this sentinel and verifies the immutable
      // presales resource/credential binding instead.
      ownerUserId: 0,
      fileId,
    });
    await streamResolvedPresalesFile(res, resolved);
  } catch (error) {
    sendOwnedPresalesFileError(res, error);
  }
});

/** Download an output URL only when it is present in the bound task payload. */
router.get("/tasks/:taskId/output", async (req, res) => {
  try {
    const taskId = String(req.params.taskId || "");
    const target = String(req.query.url || "");
    if (!target || target.length > 4096) {
      return res.status(400).json({
        error: { code: "INVALID_REQUEST", message: "Invalid output URL" },
      });
    }
    const normalizedTarget = assertSafeExternalUrl(target);
    const credential = await requireResourceCredential("task", taskId);
    const { artifacts } = await retrieveTask(taskId, credential);
    if (!artifacts.urls.has(normalizedTarget)) {
      throw new AuthServiceError("NOT_FOUND", "Task output URL not found");
    }
    const authorized = await hasPresalesOutputUrlGrant({
      apiCredentialId: credential.id,
      parentTaskId: taskId,
      url: normalizedTarget,
    });
    if (!authorized) {
      throw new AuthServiceError("NOT_FOUND", "Task output URL not found");
    }
    await streamExternalOutput(
      res,
      normalizedTarget,
      safeFilename(req.query.filename, "frontmind-output"),
    );
  } catch (error) {
    sendKnownError(res, error);
  }
});

// Keep every authenticated internal request inside this router so an unknown
// path can never fall through to the application's larger global parsers.
router.use((_req, res) => {
  res.status(404).json({
    error: { code: "NOT_FOUND", message: "Presales route not found" },
  });
});

export default router;
