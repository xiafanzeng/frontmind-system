import { createHash, randomUUID } from "node:crypto";
import { isIP } from "node:net";
import axios from "axios";
import {
  and,
  desc,
  eq,
  gte,
  inArray,
  isNotNull,
  isNull,
  lt,
  ne,
  or,
  sql,
} from "drizzle-orm";
import { json, Router, type Response } from "express";
import { z } from "zod";

import {
  presalesMonitorRuns,
  users,
  websiteProjectDeletionTombstones,
  type InsertPresalesMonitorRun,
  type PresalesMonitorRun,
} from "../drizzle/schema";
import { getDb } from "./db";
import {
  getActivePresalesCredential,
  getPresalesCredentialById,
  type DecryptedPresalesCredential,
} from "./presales-service";
import {
  assertWebsiteProjectPhysicalDeleteEnabled,
  lockActiveWebsiteProjectLifecycle,
  WebsiteProjectInactiveError,
} from "./website-project-lifecycle";

export const MONITOR_PLATFORMS = [
  "doubao",
  "yuanbao",
  "deepseek",
  "baiduai",
  "qianwen",
  "kimi",
  "chatgpt",
] as const;
export type MonitorPlatform = (typeof MONITOR_PLATFORMS)[number];

const WORKSPACE_MONITOR_PROJECT_PREFIX = "dashboard-brand-tracking-user:";

export function workspaceMonitorProjectId(userId: number) {
  if (!Number.isInteger(userId) || userId <= 0) {
    throw new PresalesMonitorError("NOT_FOUND", 404, "监控任务不存在");
  }
  return `${WORKSPACE_MONITOR_PROJECT_PREFIX}${userId}`;
}

function isWorkspaceMonitorProjectId(projectId: string | null | undefined) {
  return Boolean(projectId?.startsWith(WORKSPACE_MONITOR_PROJECT_PREFIX));
}

function isWebsiteMonitorProjectId(
  projectId: string | null | undefined,
): projectId is string {
  return Boolean(projectId) && !isWorkspaceMonitorProjectId(projectId);
}

const UPSTREAM_MONITOR_PLATFORM_IDS: Record<MonitorPlatform, string> = {
  doubao: "doubao",
  yuanbao: "yuanbao",
  deepseek: "deepseek",
  baiduai: "baiduai",
  qianwen: "qianwen",
  kimi: "kimi",
  chatgpt: "chatgpt",
};
const PUBLIC_MONITOR_PLATFORM_IDS = new Map(
  Object.entries(UPSTREAM_MONITOR_PLATFORM_IDS).map(
    ([publicId, upstreamId]) => [upstreamId, publicId as MonitorPlatform],
  ),
);

export const MONITOR_REPEAT_PER_PLATFORM = 5;
export const MONITOR_POLL_INTERVAL_MS = 10_000;
const MONITOR_POLL_LEASE_MS = 120_000;
const MONITOR_HTTP_TIMEOUT_MS = 60_000;
// Readiness reports this optional provider dependency but does not gate the
// Dashboard. Keep a cold probe comfortably below the deploy controller's
// five-second local readiness timeout.
const MONITOR_CREDENTIAL_PROBE_TIMEOUT_MS = 1_500;
const MONITOR_CREDENTIAL_PROBE_TASK_ID = "00000000-0000-4000-8000-000000000000";
const MONITOR_CREDENTIAL_READY_CACHE_MS = 5 * 60_000;
const MONITOR_CREDENTIAL_FAILED_CACHE_MS = 15_000;
const MONITOR_CREDENTIAL_RECENT_ATTESTATION_MS = 30 * 60_000;
const MAX_MONITOR_RESPONSE_BYTES = 12 * 1024 * 1024;
const MAX_ANSWER_CHARACTERS = 200_000;
const MAX_SOURCE_ITEMS = 200;
const MAX_CITATION_ITEMS = 100;
const MAX_EVIDENCE_CANDIDATES = 2_000;
const MAX_MEDIA_ITEMS = 24;
const MAX_SEARCH_KEYWORDS = 50;
const MAX_RECOMMENDED_QUESTIONS = 20;
const MAX_KEYWORD_EVALUATIONS = 100;
const MAX_MONITOR_LIST_ITEM_CHARACTERS = 500;
const MAX_MONITOR_EVALUATION_KEYWORD_CHARACTERS = 200;
const MAX_MONITOR_SOURCE_INDEX = 1_000_000_000;
const MAX_MONITOR_RANK = 1_000_000;
const MAX_MONITOR_PUBLISH_TIME_CHARACTERS = 80;
const MAX_REGION_CATALOG_BYTES = 512 * 1024;
const MAX_SCREENSHOT_BYTES = 8 * 1024 * 1024;
const MONITOR_CATALOG_HTTP_TIMEOUT_MS = 5_000;
const MONITOR_SCREENSHOT_HTTP_TIMEOUT_MS = 15_000;
const MONITOR_RECOVERY_WINDOW_MS = 6 * 60 * 60_000;
const DEFAULT_MONITOR_BASE_URL_B64 =
  "aHR0cHM6Ly9idXNpbmVzcy1hcGkubW9saXpoaXNodS5jb20vYXBpL2J1c2luZXNzL21vbml0b3I=";
const MONITOR_SCREENSHOT_HOSTS_B64 = [
  "aW1nLm1vbGl6aGlzaHUuY29t",
  "YWlnZW8tanAub3NzLWFwLW5vcnRoZWFzdC0xLmFsaXl1bmNzLmNvbQ==",
] as const;
const ENV_MONITOR_CREDENTIAL_PREFIX = "env-";
const MONITOR_CREDENTIAL_PLACEHOLDER_MARKERS = [
  "replace-with",
  "change-me",
  "your-api-key",
];
const MAIN_FINAL_STATUSES = new Set([
  "completed",
  "partial_completed",
  "failed",
  "stopped",
]);
const CHILD_FINAL_STATUSES = new Set([
  "completed",
  "failed",
  "stopped",
  "error",
]);
const POLLABLE_LOCAL_STATUSES = new Set<PresalesMonitorRun["status"]>([
  "submitted",
  "polling",
]);
const TERMINAL_LOCAL_STATUSES = new Set<PresalesMonitorRun["status"]>([
  "completed",
  "partial_review_required",
  "remote_failed",
  "shape_mismatch",
]);
const RECOVERABLE_TERMINAL_LOCAL_STATUSES = new Set<
  PresalesMonitorRun["status"]
>(["completed", "partial_review_required", "remote_failed"]);
const RECOVERABLE_REMOTE_STATUSES = new Set(["completed", "partial_completed"]);
// Provider submission is bounded by MONITOR_HTTP_TIMEOUT_MS. Keep the local
// reservation for an additional full timeout so project deletion never drops
// the only retry target while a normal submit request can still return.
const MONITOR_SUBMISSION_DELETE_GRACE_MS = MONITOR_HTTP_TIMEOUT_MS * 2;

const monitorCreateSchema = z
  .object({
    question: z.string().trim().min(1).max(2_000),
    platforms: z
      .array(z.enum(MONITOR_PLATFORMS))
      .min(1)
      .max(MONITOR_PLATFORMS.length)
      .refine((items) => new Set(items).size === items.length, {
        message: "platforms must not contain duplicates",
      }),
    idempotencyKey: z.string().trim().min(16).max(512),
    monitorKeyword: z.string().trim().min(1).max(2_000).optional(),
    screenshot: z.union([z.literal(0), z.literal(1)]).optional(),
    region: z
      .object({
        scope: z.enum(["domestic", "overseas"]),
        code: z.string().trim().min(1).max(64),
      })
      .strict()
      .optional(),
    projectId: z
      .string()
      .trim()
      .min(8)
      .max(80)
      .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/)
      .optional(),
  })
  .strict();

export type MonitorCreateInput = z.infer<typeof monitorCreateSchema>;

export type MonitorRegionScope = "domestic" | "overseas";

export type PublicMonitorRegion = {
  scope: MonitorRegionScope;
  code: string;
  label: string;
};

type MonitorRequestRegion = PublicMonitorRegion;

type MonitorRunRequestSnapshot = {
  consumerTaskId: string;
  screenshot: 0 | 1;
  monitorKeyword?: string;
  region?: MonitorRequestRegion;
};

type MonitorScope = { platform: MonitorPlatform; runIndex: number };
type MonitorEvidence =
  | string
  | {
      index?: number;
      title?: string;
      name?: string;
      url?: string;
      source?: string;
      site?: string;
      domain?: string;
      summary?: string;
      publishTime?: string;
    };

export type MonitorMedia = {
  type: "image" | "video" | "audio" | "link";
  url: string;
  title?: string;
  thumbnailUrl?: string;
};

type MonitorCheckpointItem = {
  subTaskId: string;
  prompt: string;
  platform: MonitorPlatform;
  mode: "search";
  status: string;
  answerText?: string;
  media: MonitorMedia[];
  /** Canonical, deduplicated union of every source returned for the answer. */
  sources?: MonitorEvidence | MonitorEvidence[];
  citationList?: MonitorEvidence[];
  referenceList?: MonitorEvidence[];
  /** Legacy checkpoint field names remain readable for existing runs. */
  citations?: MonitorEvidence[];
  references?: MonitorEvidence[];
  searchKeywords?: string[];
  recommendedQuestions?: string[];
  mentionPosition?: number | null;
  mentionContext?: string;
  sentiment?: "positive" | "negative" | "neutral" | null;
  categoryRanking?: { categoryName: string; rank: number } | null;
  keywordEvaluations?: Array<{
    keyword: string;
    nature: "positive" | "negative" | "neutral";
    context: string;
  }>;
  /** Provider URL remains private and is only dereferenced by the proxy route. */
  pageScreenshot?: string;
  error?: string;
  completedAt?: string;
};

type MonitorCheckpoint = {
  request?: MonitorRunRequestSnapshot;
  items: MonitorCheckpointItem[];
};

export type PublicMonitorScreenshot = {
  available: boolean;
};

export type PublicMonitorRecord = {
  recordId: string;
  platform: MonitorPlatform;
  runIndex: number;
  status: string;
  answerText?: string;
  media: MonitorMedia[];
  sources: MonitorEvidence[];
  citationList?: MonitorEvidence[];
  referenceList?: MonitorEvidence[];
  searchKeywords?: string[];
  recommendedQuestions?: string[];
  mentionPosition?: number | null;
  mentionContext?: string;
  sentiment?: "positive" | "negative" | "neutral" | null;
  categoryRanking?: { categoryName: string; rank: number } | null;
  keywordEvaluations?: Array<{
    keyword: string;
    nature: "positive" | "negative" | "neutral";
    context: string;
  }>;
  screenshot?: PublicMonitorScreenshot;
  error?: string;
  completedAt?: string;
};

export type PublicMonitorRun = {
  runId: string;
  status: PresalesMonitorRun["status"];
  createdAt: string;
  question: string;
  platforms: MonitorPlatform[];
  repeatPerPlatform: 5;
  expectedItems: number;
  completedItems: number;
  failedItems: number;
  monitorKeyword?: string;
  screenshot?: 0 | 1;
  region?: PublicMonitorRegion;
  submittedAt?: string;
  nextPollAt?: string;
  complete?: boolean;
  records?: PublicMonitorRecord[];
};

export class PresalesMonitorError extends Error {
  constructor(
    public readonly code: string,
    public readonly status: number,
    message: string,
    public readonly retryAfterMs?: number,
  ) {
    super(message);
    this.name = "PresalesMonitorError";
  }
}

export class MonitorRemoteError extends Error {
  constructor(
    message: string,
    public readonly recoverable: boolean,
  ) {
    super(message);
    this.name = "MonitorRemoteError";
  }
}

export interface MonitorTransport {
  submit(
    payload: ReturnType<typeof buildMonitorSubmitPayload>,
    credential: DecryptedPresalesCredential,
  ): Promise<unknown>;
  status(
    taskId: string,
    credential: DecryptedPresalesCredential,
  ): Promise<unknown>;
  result(
    taskId: string,
    credential: DecryptedPresalesCredential,
  ): Promise<unknown>;
  stop(
    taskId: string,
    credential: DecryptedPresalesCredential,
  ): Promise<unknown>;
}

export interface MonitorRegionCatalog {
  list(scope: MonitorRegionScope): Promise<PublicMonitorRegion[]>;
}

export type MonitorScreenshotResponse = {
  contentType: "image/gif" | "image/jpeg" | "image/png" | "image/webp";
  data: Buffer;
};

export interface MonitorScreenshotTransport {
  fetch(url: string): Promise<MonitorScreenshotResponse>;
}

export type MonitorReservation =
  | { state: "acquired"; run: PresalesMonitorRun }
  | { state: "replay"; run: PresalesMonitorRun };

export type MonitorPollLease = {
  run: PresalesMonitorRun;
  leaseId: string;
};

export type WorkspaceMonitorQuotaWindow = {
  userId: number;
  windowStartedAt: Date;
  windowEndsAt: Date;
};

export type WorkspaceMonitorQuotaUsage = {
  limit: number | null;
  used: number;
};

export interface MonitorRepository {
  reserve(input: {
    projectId?: string;
    idempotencyKeyHash: string;
    requestHash: string;
    compatibleRequestHashes?: readonly string[];
    credential: DecryptedPresalesCredential;
    question: string;
    platforms: MonitorPlatform[];
    expectedItems: number;
    checkpoint: MonitorCheckpoint;
    now: Date;
    workspaceQuota?: WorkspaceMonitorQuotaWindow;
  }): Promise<MonitorReservation>;
  get(runId: string): Promise<PresalesMonitorRun | null>;
  getLatestByProject(projectId: string): Promise<PresalesMonitorRun | null>;
  getWorkspaceQuota(
    input: WorkspaceMonitorQuotaWindow,
  ): Promise<WorkspaceMonitorQuotaUsage | null>;
  markSubmissionUnknown(
    runId: string,
    error: string,
    now: Date,
  ): Promise<PresalesMonitorRun>;
  markSubmissionCleanupPending(
    runId: string,
    upstreamTaskId: string,
    error: string,
    now: Date,
  ): Promise<PresalesMonitorRun>;
  markSubmissionRejected(
    runId: string,
    error: string,
    now: Date,
  ): Promise<PresalesMonitorRun>;
  markSubmitted(
    runId: string,
    input: {
      upstreamTaskId: string;
      submitTotalItems: number;
      initialSubtaskIds: string[];
      subtaskScopes: Record<string, MonitorScope>;
      now: Date;
    },
  ): Promise<PresalesMonitorRun>;
  acquirePoll(runId: string, now: Date): Promise<MonitorPollLease | null>;
  finishPoll(
    runId: string,
    leaseId: string,
    patch: Partial<InsertPresalesMonitorRun>,
  ): Promise<PresalesMonitorRun>;
  remove(runId: string): Promise<boolean>;
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value) ?? "null";
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
  }
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .filter((key) => record[key] !== undefined)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
    .join(",")}}`;
}

function sha256(value: string) {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

/**
 * MySQL errors thrown through Drizzle are commonly wrapped in one or more
 * `cause` objects. Keep this deliberately bounded and cycle-safe so an
 * idempotent replay cannot be mistaken for a new upstream submission merely
 * because the driver error was wrapped.
 */
export function isMonitorDuplicateReservationError(error: unknown) {
  const visited = new Set<object>();
  let candidate: unknown = error;
  for (let depth = 0; depth < 8; depth += 1) {
    if (!candidate || typeof candidate !== "object") return false;
    if (visited.has(candidate)) return false;
    visited.add(candidate);
    const record = candidate as {
      code?: unknown;
      errno?: unknown;
      cause?: unknown;
    };
    if (record.code === "ER_DUP_ENTRY" || record.errno === 1062) return true;
    candidate = record.cause;
  }
  return false;
}

/**
 * Turn the dedicated server-side monitor key into a deterministic credential
 * binding. Only the digest-derived ID/version are persisted with a run; the
 * key itself remains in process memory and never enters the public contract.
 */
export function monitorCredentialFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): DecryptedPresalesCredential | null {
  const apiKey = env.FRONTMIND_MONITOR_API_KEY?.trim();
  if (
    !apiKey ||
    apiKey.length < 16 ||
    MONITOR_CREDENTIAL_PLACEHOLDER_MARKERS.some((marker) =>
      apiKey.toLocaleLowerCase("en-US").includes(marker),
    )
  ) {
    return null;
  }
  const digest = sha256(apiKey);
  const version =
    (Number.parseInt(digest.slice(32, 40), 16) % 2_147_483_646) + 1;
  return {
    id: `${ENV_MONITOR_CREDENTIAL_PREFIX}${digest.slice(0, 32)}`,
    version,
    apiKey,
    fingerprint: digest.slice(0, 32),
    status: "active",
    verifiedAt: null,
    retiredAt: null,
  };
}

export function isDedicatedMonitorCredentialConfigured(
  env: NodeJS.ProcessEnv = process.env,
) {
  return monitorCredentialFromEnv(env) !== null;
}

export function assertDedicatedMonitorCredentialConfigured(
  env: NodeJS.ProcessEnv = process.env,
) {
  if (!isDedicatedMonitorCredentialConfigured(env)) {
    throw new Error(
      "FRONTMIND_MONITOR_API_KEY must be configured with a dedicated non-placeholder credential in production",
    );
  }
}

export type DedicatedMonitorCredentialReadiness = {
  configured: boolean;
  authenticated: boolean;
  ready: boolean;
  status: "missing" | "authenticated" | "rejected" | "unavailable";
};

export type MonitorCredentialProbeRequester = (input: {
  url: string;
  apiKey: string;
  timeoutMs: number;
}) => Promise<{ status: number; data: unknown }>;

const requestMonitorCredentialProbe: MonitorCredentialProbeRequester = async (
  input,
) => {
  const response = await axios.request({
    method: "GET",
    url: input.url,
    headers: {
      Authorization: `Bearer ${input.apiKey}`,
      Accept: "application/json",
    },
    timeout: input.timeoutMs,
    maxRedirects: 0,
    maxContentLength: 64 * 1024,
    validateStatus: () => true,
  });
  return { status: response.status, data: response.data };
};

function probeResponseRejectsCredential(status: number, data: unknown) {
  if (status === 401 || status === 403) return true;
  if (!isRecord(data)) return false;
  const code = normalizedText(data.code).toLowerCase();
  if (
    [
      "401",
      "403",
      "invalid_token",
      "token_invalid",
      "token_expired",
      "unauthorized",
      "forbidden",
    ].includes(code)
  ) {
    return true;
  }
  const error = isRecord(data.error) ? data.error : null;
  const text = [
    data.message,
    data.msg,
    typeof data.error === "string" ? data.error : undefined,
    error?.code,
    error?.message,
  ]
    .map(normalizedText)
    .filter(Boolean)
    .join(" ");
  return (
    /(token|api[\s_-]*key|credential|authorization|auth|鉴权|认证|密钥|凭据)/iu.test(
      text,
    ) &&
    /(invalid|expired|revoked|unauthori[sz]ed|forbidden|missing|失效|无效|过期|撤销|错误|未授权|禁止|缺失|不存在)/iu.test(
      text,
    )
  );
}

function probeResponseProvesAuthentication(data: Record<string, unknown>) {
  const error = isRecord(data.error) ? data.error : null;
  const text = [data.code, data.message, data.msg, error?.code, error?.message]
    .map(normalizedText)
    .filter(Boolean)
    .join(" ");
  return /(?:任务.{0,12}(?:不存在|未找到)|task.{0,16}(?:not[\s_-]*found|does[\s_-]*not[\s_-]*exist)|task[\s_-]*not[\s_-]*found)/iu.test(
    text,
  );
}

function monitorResponseContainsTaskIdentity(
  value: unknown,
  seen = new Set<object>(),
  depth = 0,
): boolean {
  if (!value || typeof value !== "object" || depth > 8) return false;
  if (seen.has(value)) return false;
  seen.add(value);
  if (Array.isArray(value)) {
    return value.some((item) =>
      monitorResponseContainsTaskIdentity(item, seen, depth + 1),
    );
  }
  for (const [key, child] of Object.entries(value)) {
    const normalizedKey = key.toLowerCase().replace(/[^a-z0-9]/g, "");
    if (
      (normalizedKey === "taskid" || normalizedKey === "subtaskid") &&
      normalizedText(child)
    ) {
      return true;
    }
    if (monitorResponseContainsTaskIdentity(child, seen, depth + 1)) {
      return true;
    }
  }
  return false;
}

/**
 * A paid POST is safe to reacquire only when the response proves that
 * authentication was rejected before a task identity existed. Generic
 * `success:false` responses remain unknown because the provider has no
 * upstream idempotency key and could have created work before responding.
 */
export function monitorResponseExplicitlyRejectsSubmission(data: unknown) {
  return (
    isRecord(data) &&
    data.success === false &&
    !monitorResponseContainsTaskIdentity(data) &&
    probeResponseRejectsCredential(200, data)
  );
}

/**
 * Verify the dedicated credential with a read-only lookup against an
 * intentionally nonexistent task. A structured "task not found" response is
 * sufficient proof that authentication ran; no task or billable work is ever
 * created by this probe.
 */
export async function probeDedicatedMonitorCredential(
  options: {
    env?: NodeJS.ProcessEnv;
    request?: MonitorCredentialProbeRequester;
  } = {},
): Promise<DedicatedMonitorCredentialReadiness> {
  const env = options.env ?? process.env;
  const credential = monitorCredentialFromEnv(env);
  if (!credential) {
    return {
      configured: false,
      authenticated: false,
      ready: false,
      status: "missing",
    };
  }
  try {
    const response = await (options.request ?? requestMonitorCredentialProbe)({
      url: buildMonitorRequestUrl(
        `/task/status/${MONITOR_CREDENTIAL_PROBE_TASK_ID}`,
        env,
      ),
      apiKey: credential.apiKey,
      timeoutMs: MONITOR_CREDENTIAL_PROBE_TIMEOUT_MS,
    });
    if (probeResponseRejectsCredential(response.status, response.data)) {
      return {
        configured: true,
        authenticated: false,
        ready: false,
        status: "rejected",
      };
    }
    if (
      !(
        (response.status >= 200 && response.status < 300) ||
        response.status === 404
      ) ||
      !isRecord(response.data) ||
      !probeResponseProvesAuthentication(response.data)
    ) {
      return {
        configured: true,
        authenticated: false,
        ready: false,
        status: "unavailable",
      };
    }
    return {
      configured: true,
      authenticated: true,
      ready: true,
      status: "authenticated",
    };
  } catch {
    return {
      configured: true,
      authenticated: false,
      ready: false,
      status: "unavailable",
    };
  }
}

let monitorCredentialReadinessCache:
  | {
      binding: string;
      expiresAt: number;
      value: DedicatedMonitorCredentialReadiness;
    }
  | undefined;
let monitorCredentialRecentAttestation:
  | {
      binding: string;
      authenticatedAt: number;
    }
  | undefined;

export async function getDedicatedMonitorCredentialReadiness(
  env: NodeJS.ProcessEnv = process.env,
  options: {
    request?: MonitorCredentialProbeRequester;
    now?: () => number;
    forceRefresh?: boolean;
  } = {},
) {
  const credential = monitorCredentialFromEnv(env);
  if (!credential) {
    monitorCredentialReadinessCache = undefined;
    monitorCredentialRecentAttestation = undefined;
    return probeDedicatedMonitorCredential({ env, request: options.request });
  }
  const binding = `${credential.id}:${credential.version}:${env.FRONTMIND_MONITOR_API_BASE_URL ?? "default"}`;
  const now = (options.now ?? Date.now)();
  if (
    monitorCredentialRecentAttestation &&
    monitorCredentialRecentAttestation.binding !== binding
  ) {
    monitorCredentialRecentAttestation = undefined;
  }
  if (
    options.forceRefresh !== true &&
    monitorCredentialReadinessCache?.binding === binding &&
    monitorCredentialReadinessCache.expiresAt > now
  ) {
    return monitorCredentialReadinessCache.value;
  }
  const value = await probeDedicatedMonitorCredential({
    env,
    request: options.request,
  });
  if (value.status === "authenticated") {
    monitorCredentialRecentAttestation = {
      binding,
      authenticatedAt: now,
    };
  } else if (value.status === "rejected") {
    monitorCredentialRecentAttestation = undefined;
  } else if (
    value.status === "unavailable" &&
    monitorCredentialRecentAttestation?.binding === binding
  ) {
    const attestationExpiresAt =
      monitorCredentialRecentAttestation.authenticatedAt +
      MONITOR_CREDENTIAL_RECENT_ATTESTATION_MS;
    if (
      monitorCredentialRecentAttestation.authenticatedAt <= now &&
      attestationExpiresAt > now
    ) {
      const fallbackValue: DedicatedMonitorCredentialReadiness = {
        configured: true,
        authenticated: true,
        ready: true,
        status: "authenticated",
      };
      console.warn(
        "[Presales Monitor] credential readiness used recent authentication",
        {
          diagnosticCode: "MONITOR_CREDENTIAL_RECENT_ATTESTATION_FALLBACK",
          probeStatus: "unavailable",
          recentAttestationFallback: true,
        },
      );
      monitorCredentialReadinessCache = {
        binding,
        expiresAt: Math.min(
          now + MONITOR_CREDENTIAL_FAILED_CACHE_MS,
          attestationExpiresAt,
        ),
        value: fallbackValue,
      };
      return fallbackValue;
    }
    monitorCredentialRecentAttestation = undefined;
  }
  monitorCredentialReadinessCache = {
    binding,
    expiresAt:
      now +
      (value.ready
        ? MONITOR_CREDENTIAL_READY_CACHE_MS
        : MONITOR_CREDENTIAL_FAILED_CACHE_MS),
    value,
  };
  return value;
}

async function getActiveMonitorCredential() {
  const dedicatedCredential = monitorCredentialFromEnv();
  if (dedicatedCredential) return dedicatedCredential;
  if (process.env.NODE_ENV === "production") return null;
  return getActivePresalesCredential();
}

async function getMonitorCredentialById(credentialId: string) {
  const envCredential = monitorCredentialFromEnv();
  if (envCredential?.id === credentialId) return envCredential;
  if (credentialId.startsWith(ENV_MONITOR_CREDENTIAL_PREFIX)) return null;
  if (process.env.NODE_ENV === "production") return null;
  return getPresalesCredentialById(credentialId);
}

function toUpstreamMonitorPlatform(platform: MonitorPlatform) {
  return UPSTREAM_MONITOR_PLATFORM_IDS[platform];
}

function toPublicMonitorPlatform(value: unknown): MonitorPlatform | null {
  const platform = normalizedText(value).toLowerCase();
  return PUBLIC_MONITOR_PLATFORM_IDS.get(platform) ?? null;
}

export function buildMonitorSubmitPayload(input: {
  question: string;
  platforms: readonly MonitorPlatform[];
  consumerTaskId?: string;
  monitorKeyword?: string;
  screenshot?: 0 | 1;
  region?: Pick<MonitorRequestRegion, "code">;
}) {
  return {
    prompts: Array.from(
      { length: MONITOR_REPEAT_PER_PLATFORM },
      () => input.question,
    ),
    platforms: input.platforms.map((platform) => ({
      platform: toUpstreamMonitorPlatform(platform),
      mode: "search" as const,
      screenshot: input.screenshot ?? (0 as const),
    })),
    ...(input.consumerTaskId ? { consumerTaskId: input.consumerTaskId } : {}),
    ...(input.monitorKeyword ? { monitorKeywords: input.monitorKeyword } : {}),
    ...(input.region ? { regionCode: [input.region.code] } : {}),
  };
}

function requestHash(input: {
  projectId?: string;
  question: string;
  platforms: readonly MonitorPlatform[];
  monitorKeyword?: string;
  screenshot?: 0 | 1;
  region?: Pick<MonitorRequestRegion, "scope" | "code">;
}) {
  return sha256(
    canonicalJson({
      schema: "frontmind-presales-monitor-v1",
      projectId: input.projectId ?? null,
      payload: buildMonitorSubmitPayload(input),
      ...(input.region ? { regionScope: input.region.scope } : {}),
    }),
  );
}

function monitorConsumerTaskId(idempotencyKeyHash: string) {
  return `fm${sha256(`frontmind-monitor:${idempotencyKeyHash}`).slice(0, 62)}`;
}

function initialMonitorCheckpoint(input: {
  consumerTaskId: string;
  monitorKeyword?: string;
  screenshot: 0 | 1;
  region?: MonitorRequestRegion;
}): MonitorCheckpoint {
  return {
    request: {
      consumerTaskId: input.consumerTaskId,
      screenshot: input.screenshot,
      ...(input.monitorKeyword ? { monitorKeyword: input.monitorKeyword } : {}),
      ...(input.region ? { region: input.region } : {}),
    },
    items: [],
  };
}

function sameMonitorRequestSnapshot(
  left: MonitorRunRequestSnapshot | undefined,
  right: MonitorRunRequestSnapshot | undefined,
) {
  return Boolean(
    left &&
      right &&
      left.consumerTaskId === right.consumerTaskId &&
      left.screenshot === right.screenshot &&
      (left.monitorKeyword ?? "") === (right.monitorKeyword ?? "") &&
      (left.region?.scope ?? "") === (right.region?.scope ?? "") &&
      (left.region?.code ?? "") === (right.region?.code ?? ""),
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function normalizedText(value: unknown) {
  return typeof value === "string" ? value.trim() : "";
}

function normalizeMonitorRequestSnapshot(
  checkpointValue: unknown,
): MonitorRunRequestSnapshot | undefined {
  if (!isRecord(checkpointValue) || !isRecord(checkpointValue.request)) {
    return undefined;
  }
  const value = checkpointValue.request;
  const consumerTaskId = normalizedText(value.consumerTaskId);
  const screenshot = value.screenshot;
  if (
    !/^[A-Za-z0-9]{8,64}$/.test(consumerTaskId) ||
    (screenshot !== 0 && screenshot !== 1)
  ) {
    return undefined;
  }
  const monitorKeyword = normalizedText(value.monitorKeyword).slice(0, 2_000);
  const rawRegion = isRecord(value.region) ? value.region : null;
  const scope = rawRegion?.scope;
  const code = normalizedText(rawRegion?.code);
  const label = sanitizeMonitorPublicText(
    normalizedText(rawRegion?.label),
  ).slice(0, 100);
  const region: PublicMonitorRegion | undefined =
    (scope === "domestic" || scope === "overseas") &&
    code.length >= 1 &&
    code.length <= 64 &&
    label
      ? { scope, code, label }
      : undefined;
  return {
    consumerTaskId,
    screenshot,
    ...(monitorKeyword ? { monitorKeyword } : {}),
    ...(region ? { region } : {}),
  };
}

function providerInlineCitationPattern() {
  return /\uE3A0cite\uE3A3web_search:[0-9]+#([0-9]{1,9})\uE3A8/gi;
}

function bracketInlineCitationPattern() {
  return /\[citation:([0-9]{1,9})\]/gi;
}

function anyInlineCitationPattern() {
  return /\uE3A0cite\uE3A3web_search:[0-9]+#([0-9]{1,9})\uE3A8|\[citation:([0-9]{1,9})\]/gi;
}

function inlineCitationIndexes(value: unknown): number[] {
  if (typeof value !== "string") return [];
  const indexes: number[] = [];
  const seen = new Set<number>();
  for (const match of value.matchAll(anyInlineCitationPattern())) {
    const index = Number.parseInt(match[1] ?? match[2], 10);
    if (!Number.isSafeInteger(index) || index < 0 || seen.has(index)) continue;
    seen.add(index);
    indexes.push(index);
  }
  return indexes;
}

function monitorProviderIdentity() {
  const defaultUrl = Buffer.from(
    DEFAULT_MONITOR_BASE_URL_B64,
    "base64",
  ).toString("utf8");
  const hostnames = [
    defaultUrl,
    process.env.FRONTMIND_MONITOR_API_BASE_URL,
  ].flatMap((value) => {
    if (!value) return [];
    try {
      return [new URL(value).hostname.toLowerCase()];
    } catch {
      return [];
    }
  });
  const defaultHostname = hostnames[0] ?? "";
  const sourceLabel = defaultHostname.split(".").at(-2) ?? "";
  return {
    hostnames,
    sourceLabel,
    sourceNameCn: Buffer.from("6a2U5Yqb5pm65pWw", "base64").toString("utf8"),
  };
}

function escapeMonitorPattern(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function sanitizeMonitorPublicText(value: string) {
  const { hostnames, sourceLabel, sourceNameCn } = monitorProviderIdentity();
  let output = value;
  for (const source of [...hostnames, sourceLabel, sourceNameCn].filter(
    Boolean,
  )) {
    output = output.replace(
      new RegExp(escapeMonitorPattern(source), "gi"),
      "FrontMind",
    );
  }
  return output;
}

function containsPrivateMonitorIdentity(value: string) {
  return sanitizeMonitorPublicText(value) !== value;
}

function isMonitorProviderHostname(hostname: string) {
  const normalized = hostname.toLowerCase();
  const { hostnames, sourceLabel } = monitorProviderIdentity();
  return (
    hostnames.includes(normalized) ||
    Boolean(sourceLabel && normalized.split(".").includes(sourceLabel))
  );
}

const MONITOR_TRACKING_PARAMETERS = new Set([
  "fbclid",
  "gclid",
  "dclid",
  "msclkid",
  "mc_cid",
  "mc_eid",
  "igshid",
  "ref_src",
]);

function isPrivateSourceHostname(value: string) {
  const hostname = value
    .toLowerCase()
    .replace(/^\[|\]$/g, "")
    .replace(/\.$/, "");
  if (
    hostname === "localhost" ||
    hostname.endsWith(".localhost") ||
    hostname.endsWith(".local") ||
    hostname.endsWith(".internal")
  ) {
    return true;
  }
  if (isIP(hostname) === 4) {
    const octets = hostname.split(".").map(Number);
    return (
      octets[0] === 0 ||
      octets[0] === 10 ||
      octets[0] === 127 ||
      (octets[0] === 169 && octets[1] === 254) ||
      (octets[0] === 172 && octets[1] >= 16 && octets[1] <= 31) ||
      (octets[0] === 192 && octets[1] === 168) ||
      octets[0] >= 224
    );
  }
  if (isIP(hostname) === 6) {
    const mappedIpv4 = (() => {
      const match = /^::ffff:(.+)$/i.exec(hostname);
      if (!match) return undefined;
      if (isIP(match[1]) === 4) return match[1];
      const groups = match[1].split(":");
      if (
        groups.length !== 2 ||
        groups.some((group) => !/^[a-f0-9]{1,4}$/i.test(group))
      ) {
        return undefined;
      }
      const high = Number.parseInt(groups[0], 16);
      const low = Number.parseInt(groups[1], 16);
      return [high >> 8, high & 0xff, low >> 8, low & 0xff].join(".");
    })();
    if (mappedIpv4 && isPrivateSourceHostname(mappedIpv4)) return true;
    return (
      hostname === "::" ||
      hostname === "::1" ||
      hostname.startsWith("fc") ||
      hostname.startsWith("fd") ||
      /^fe[89ab]/.test(hostname)
    );
  }
  return false;
}

function normalizeMonitorSourceUrl(value: string) {
  try {
    const url = new URL(value.replace(/&amp;/gi, "&"));
    if (
      !["http:", "https:"].includes(url.protocol) ||
      url.username ||
      url.password ||
      isMonitorProviderHostname(url.hostname) ||
      isPrivateSourceHostname(url.hostname) ||
      containsPrivateMonitorIdentity(url.toString())
    ) {
      return undefined;
    }
    url.hash = "";
    for (const key of Array.from(url.searchParams.keys())) {
      if (
        key.toLowerCase().startsWith("utm_") ||
        MONITOR_TRACKING_PARAMETERS.has(key.toLowerCase())
      ) {
        url.searchParams.delete(key);
      }
    }
    url.searchParams.sort();
    return url.toString().slice(0, 4_096);
  } catch {
    return undefined;
  }
}

function positiveInteger(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) && value > 0
    ? value
    : null;
}

function nonnegativeInteger(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) && value >= 0
    ? value
    : null;
}

function monitorTaskId(value: unknown) {
  const taskId = normalizedText(value);
  if (!/^[A-Za-z0-9_-]{8,128}$/.test(taskId)) {
    throw new PresalesMonitorError(
      "MONITOR_SUBMISSION_UNKNOWN",
      502,
      "监控提交响应缺少有效任务 ID；为避免重复计费，本次不会自动重发",
    );
  }
  return taskId;
}

function responseTaskIds(payload: unknown) {
  if (!isRecord(payload) || !isRecord(payload.data)) return new Set<string>();
  const ids = new Set<string>();
  const parentId = normalizedText(payload.data.taskId);
  if (parentId) ids.add(parentId);
  const children = payload.data.subTaskList;
  if (Array.isArray(children)) {
    for (const child of children) {
      if (!isRecord(child)) continue;
      const id = normalizedText(child.taskId);
      if (id) ids.add(id);
    }
  }
  return ids;
}

function assertResponseOwner(
  payload: unknown,
  taskId: string,
  source: string,
  requireTopLevel = false,
) {
  if (!isRecord(payload) || !isRecord(payload.data)) {
    throw new PresalesMonitorError(
      "MONITOR_SHAPE_MISMATCH",
      502,
      `${source}不是有效 JSON 对象`,
    );
  }
  const topLevel = normalizedText(payload.data.taskId);
  const ids = responseTaskIds(payload);
  if ((requireTopLevel && !topLevel) || ids.size === 0) {
    throw new PresalesMonitorError(
      "MONITOR_SHAPE_MISMATCH",
      502,
      `${source}缺少任务归属`,
    );
  }
  if ([...ids].some((id) => id !== taskId)) {
    throw new PresalesMonitorError(
      "MONITOR_SHAPE_MISMATCH",
      502,
      `${source}返回了不同任务的记录`,
    );
  }
}

export function validateMonitorSubmitResponse(
  payload: unknown,
  input: {
    question: string;
    platforms: readonly MonitorPlatform[];
    expectedItems: number;
  },
) {
  if (
    !isRecord(payload) ||
    payload.success !== true ||
    !isRecord(payload.data)
  ) {
    throw new PresalesMonitorError(
      "MONITOR_SUBMISSION_UNKNOWN",
      502,
      "监控提交响应不可确认；为避免重复计费，本次不会自动重发",
    );
  }
  const taskId = monitorTaskId(payload.data.taskId);
  assertResponseOwner(payload, taskId, "监控提交响应", true);
  const totalTask = positiveInteger(payload.data.totalTask);
  const children = payload.data.subTaskList;
  if (
    totalTask !== input.expectedItems ||
    !Array.isArray(children) ||
    children.length !== input.expectedItems
  ) {
    throw new PresalesMonitorError(
      "MONITOR_SUBMISSION_UNKNOWN",
      502,
      "监控提交数量与本地预期不一致；为避免重复计费，本次不会自动重发",
    );
  }

  const selected = new Set(input.platforms);
  const counts = new Map<MonitorPlatform, number>();
  const ids: string[] = [];
  const scopes: Record<string, MonitorScope> = {};
  for (const child of children) {
    if (!isRecord(child)) {
      throw new PresalesMonitorError(
        "MONITOR_SUBMISSION_UNKNOWN",
        502,
        "监控提交子任务结构无效；本次不会自动重发",
      );
    }
    const subTaskId = normalizedText(child.subTaskId);
    const platform = toPublicMonitorPlatform(child.platform);
    const childTaskId = normalizedText(child.taskId);
    if (
      !subTaskId ||
      subTaskId.length > 255 ||
      scopes[subTaskId] ||
      child.prompt !== input.question ||
      !platform ||
      !selected.has(platform) ||
      normalizedText(child.mode).toLowerCase() !== "search" ||
      (childTaskId && childTaskId !== taskId)
    ) {
      throw new PresalesMonitorError(
        "MONITOR_SUBMISSION_UNKNOWN",
        502,
        "监控提交子任务范围与请求不一致；本次不会自动重发",
      );
    }
    const runIndex = (counts.get(platform) ?? 0) + 1;
    if (runIndex > MONITOR_REPEAT_PER_PLATFORM) {
      throw new PresalesMonitorError(
        "MONITOR_SUBMISSION_UNKNOWN",
        502,
        "监控提交包含超出约定次数的子任务；本次不会自动重发",
      );
    }
    counts.set(platform, runIndex);
    ids.push(subTaskId);
    scopes[subTaskId] = { platform, runIndex };
  }
  if (
    input.platforms.some(
      (platform) => counts.get(platform) !== MONITOR_REPEAT_PER_PLATFORM,
    )
  ) {
    throw new PresalesMonitorError(
      "MONITOR_SUBMISSION_UNKNOWN",
      502,
      "监控提交没有覆盖每个平台五次回答；本次不会自动重发",
    );
  }
  return { taskId, totalTask, initialSubtaskIds: ids, subtaskScopes: scopes };
}

export function sanitizeMonitorErrorText(
  value: unknown,
  secret = "",
  fallback = "监控接口请求失败",
) {
  const text = normalizedText(value).replace(/[\r\n]+/g, " ");
  const redacted = secret
    ? (text || fallback).split(secret).join("[redacted]")
    : text || fallback;
  return sanitizeMonitorPublicText(redacted).slice(0, 500);
}

function safeError(value: unknown, fallback = "监控接口请求失败") {
  return sanitizeMonitorErrorText(value, "", fallback);
}

function sanitizeEvidence(value: unknown, maxItems: number): MonitorEvidence[] {
  const entries = Array.isArray(value)
    ? value
    : value === null || value === undefined
      ? []
      : [value];
  const result: MonitorEvidence[] = [];
  const seen = new Set<string>();
  for (const entry of entries.slice(0, MAX_EVIDENCE_CANDIDATES)) {
    let cleaned: MonitorEvidence | null = null;
    if (typeof entry === "string") {
      const raw = entry.trim().slice(0, 4_096);
      const text = (() => {
        const normalizedUrl = normalizeMonitorSourceUrl(raw);
        if (normalizedUrl) return normalizedUrl;
        if (/^[a-z][a-z0-9+.-]*:/i.test(raw)) return "";
        return sanitizeMonitorPublicText(raw);
      })();
      if (text) cleaned = text;
    } else if (isRecord(entry)) {
      const object: Exclude<MonitorEvidence, string> = {};
      const index = nonnegativeInteger(entry.index);
      if (index !== null && index <= MAX_MONITOR_SOURCE_INDEX) {
        object.index = index;
      }
      const title = normalizedText(entry.title ?? entry.name ?? entry.label);
      const source = normalizedText(
        entry.source ?? entry.site ?? entry.siteName ?? entry.publisher,
      );
      const domain = normalizedText(
        entry.domain ?? entry.hostname ?? entry.host,
      );
      const summary = normalizedText(
        entry.summary ?? entry.snippet ?? entry.description,
      );
      const publishTime = normalizedText(
        entry.publishTime ?? entry.publishedAt ?? entry.publish_time,
      );
      const rawUrl = normalizedText(entry.url ?? entry.href ?? entry.link);
      if (title)
        object.title = sanitizeMonitorPublicText(title).slice(0, 1_000);
      if (source)
        object.site = sanitizeMonitorPublicText(source).slice(0, 1_000);
      if (domain)
        object.domain = sanitizeMonitorPublicText(domain).slice(0, 255);
      if (summary)
        object.summary = sanitizeMonitorPublicText(summary).slice(0, 2_000);
      if (publishTime)
        object.publishTime = sanitizeMonitorPublicText(publishTime).slice(
          0,
          MAX_MONITOR_PUBLISH_TIME_CHARACTERS,
        );
      if (rawUrl) {
        const url = normalizeMonitorSourceUrl(rawUrl);
        if (!url) continue;
        object.url = url;
      }
      if (
        object.title ||
        object.site ||
        object.domain ||
        object.summary ||
        object.publishTime ||
        object.url
      ) {
        cleaned = object;
      }
    }
    if (cleaned === null) continue;
    const digest = canonicalJson(cleaned);
    if (seen.has(digest)) continue;
    seen.add(digest);
    result.push(cleaned);
    if (result.length >= maxItems) break;
  }
  return result;
}

function sanitizeMonitorStringList(value: unknown, maxItems: number): string[] {
  if (!Array.isArray(value)) return [];
  const result: string[] = [];
  const seen = new Set<string>();
  for (const item of value.slice(0, maxItems)) {
    const text = sanitizeMonitorPublicText(normalizedText(item)).slice(
      0,
      MAX_MONITOR_LIST_ITEM_CHARACTERS,
    );
    if (!text || seen.has(text)) continue;
    seen.add(text);
    result.push(text);
  }
  return result;
}

function sanitizeMonitorSentiment(
  value: unknown,
): "positive" | "negative" | "neutral" | null | undefined {
  if (value === null) return null;
  const text = normalizedText(value).toLowerCase();
  return text === "positive" || text === "negative" || text === "neutral"
    ? text
    : undefined;
}

function sanitizeCategoryRanking(
  value: unknown,
): { categoryName: string; rank: number } | null | undefined {
  if (value === null) return null;
  if (!isRecord(value)) return undefined;
  const categoryName = sanitizeMonitorPublicText(
    normalizedText(value.categoryName),
  ).slice(0, 500);
  const rank = positiveInteger(value.rank);
  return categoryName && rank !== null && rank <= MAX_MONITOR_RANK
    ? { categoryName, rank }
    : undefined;
}

function sanitizeKeywordEvaluations(value: unknown) {
  if (!Array.isArray(value)) return [];
  return value.slice(0, MAX_KEYWORD_EVALUATIONS).flatMap((item) => {
    if (!isRecord(item)) return [];
    const keyword = sanitizeMonitorPublicText(
      normalizedText(item.keyword),
    ).slice(0, MAX_MONITOR_EVALUATION_KEYWORD_CHARACTERS);
    const nature = sanitizeMonitorSentiment(item.nature);
    const context = sanitizeMonitorPublicText(
      normalizedText(item.context),
    ).slice(0, 2_000);
    return keyword && nature ? [{ keyword, nature, context }] : [];
  });
}

/**
 * Some completed answers expose only explicit inline source indexes while
 * leaving citationList empty. Resolve those markers against referenceList by
 * the remote numeric index only; list position and nearby entries are never
 * used as guesses. Conflicting duplicate indexes are treated as ambiguous.
 */
function citationsFromInlineMarkers(
  answerContent: unknown,
  referenceList: unknown,
): MonitorEvidence[] {
  const requestedIndexes = inlineCitationIndexes(answerContent);
  if (requestedIndexes.length === 0) return [];
  const requested = new Set(requestedIndexes);
  const entries = Array.isArray(referenceList)
    ? referenceList
    : referenceList === null || referenceList === undefined
      ? []
      : [referenceList];
  const byIndex = new Map<number, MonitorEvidence | null>();
  for (const entry of entries.slice(0, MAX_EVIDENCE_CANDIDATES)) {
    if (!isRecord(entry)) continue;
    const index = nonnegativeInteger(entry.index);
    if (index === null || !requested.has(index)) continue;
    const sanitized = sanitizeEvidence(entry, 1)[0];
    if (!sanitized) continue;
    const existing = byIndex.get(index);
    if (existing === undefined) {
      byIndex.set(index, sanitized);
    } else if (
      existing !== null &&
      canonicalJson(existing) !== canonicalJson(sanitized)
    ) {
      byIndex.set(index, null);
    }
  }
  return requestedIndexes.flatMap((index) => {
    const evidence = byIndex.get(index);
    return evidence ? [evidence] : [];
  });
}

function mergeCitationEvidence(
  primary: MonitorEvidence[],
  explicitInline: MonitorEvidence[],
  maxItems = MAX_EVIDENCE_CANDIDATES,
): MonitorEvidence[] {
  const result: MonitorEvidence[] = [];
  const canonicalItems = new Set<string>();
  const primaryIndexes = new Set(
    primary.flatMap((item) =>
      typeof item !== "string" && item.index !== undefined ? [item.index] : [],
    ),
  );
  for (const item of primary) {
    const canonicalKey = canonicalJson(item);
    if (canonicalItems.has(canonicalKey)) continue;
    canonicalItems.add(canonicalKey);
    result.push(item);
    if (result.length >= maxItems) break;
  }
  for (const item of explicitInline) {
    const index = typeof item === "string" ? undefined : item.index;
    if (index !== undefined && primaryIndexes.has(index)) continue;
    const canonicalKey = canonicalJson(item);
    if (canonicalItems.has(canonicalKey)) continue;
    canonicalItems.add(canonicalKey);
    result.push(item);
    if (result.length >= maxItems) break;
  }
  return result;
}

function monitorEvidenceIdentity(item: MonitorEvidence) {
  if (typeof item === "string") {
    const url = normalizeMonitorSourceUrl(item);
    return url
      ? `url:${url}`
      : `label:${item.trim().toLocaleLowerCase("en-US")}\u0000`;
  }
  if (item.url) return `url:${item.url}`;
  const title = (item.title || item.name || item.site || item.source || "")
    .trim()
    .toLocaleLowerCase("en-US");
  const domain = (item.domain || "").trim().toLocaleLowerCase("en-US");
  if (title || domain) return `label:${title}\u0000${domain}`;
  return `object:${canonicalJson(item)}`;
}

function mergeMonitorEvidenceItem(
  existing: MonitorEvidence,
  incoming: MonitorEvidence,
): MonitorEvidence {
  if (typeof existing === "string") {
    return typeof incoming === "string" ? existing : incoming;
  }
  if (typeof incoming === "string") return existing;
  const completeness = (item: Record<string, unknown>) => {
    const populated = Object.values(item).filter(
      (value) =>
        value !== undefined &&
        value !== null &&
        (typeof value !== "string" || value.trim().length > 0),
    );
    return (
      populated.length * 10_000 +
      populated.reduce<number>(
        (total, value) =>
          total + (typeof value === "string" ? value.length : 1),
        0,
      )
    );
  };
  const incomingIsMoreComplete =
    completeness(incoming) > completeness(existing);
  const preferred = incomingIsMoreComplete ? incoming : existing;
  const secondary = incomingIsMoreComplete ? existing : incoming;
  return {
    ...secondary,
    ...preferred,
    index: preferred.index ?? secondary.index,
    title: preferred.title ?? secondary.title,
    name: preferred.name ?? secondary.name,
    url: preferred.url ?? secondary.url,
    source: preferred.source ?? secondary.source,
    site: preferred.site ?? secondary.site,
    domain: preferred.domain ?? secondary.domain,
    summary: preferred.summary ?? secondary.summary,
    publishTime: preferred.publishTime ?? secondary.publishTime,
  };
}

function mergeUnifiedSources(
  ...collections: Array<MonitorEvidence[] | undefined>
): MonitorEvidence[] {
  const byIdentity = new Map<string, MonitorEvidence>();
  let candidateCount = 0;
  for (const collection of collections) {
    for (const item of collection ?? []) {
      if (candidateCount >= MAX_EVIDENCE_CANDIDATES) {
        return Array.from(byIdentity.values()).slice(0, MAX_SOURCE_ITEMS);
      }
      candidateCount += 1;
      const identity = monitorEvidenceIdentity(item);
      const existing = byIdentity.get(identity);
      byIdentity.set(
        identity,
        existing ? mergeMonitorEvidenceItem(existing, item) : item,
      );
    }
  }
  return Array.from(byIdentity.values()).slice(0, MAX_SOURCE_ITEMS);
}

function checkpointItemCitationList(item: MonitorCheckpointItem) {
  if (Object.prototype.hasOwnProperty.call(item, "citationList")) {
    return sanitizeEvidence(item.citationList, MAX_CITATION_ITEMS);
  }
  if (Object.prototype.hasOwnProperty.call(item, "citations")) {
    return sanitizeEvidence(item.citations, MAX_CITATION_ITEMS);
  }
  return undefined;
}

function checkpointItemReferenceList(item: MonitorCheckpointItem) {
  if (Object.prototype.hasOwnProperty.call(item, "referenceList")) {
    return sanitizeEvidence(item.referenceList, MAX_SOURCE_ITEMS);
  }
  if (Object.prototype.hasOwnProperty.call(item, "references")) {
    return sanitizeEvidence(item.references, MAX_SOURCE_ITEMS);
  }
  return undefined;
}

function checkpointItemSources(item: MonitorCheckpointItem) {
  if (Object.prototype.hasOwnProperty.call(item, "sources")) {
    return mergeUnifiedSources(
      sanitizeEvidence(item.sources, MAX_EVIDENCE_CANDIDATES),
    );
  }
  return mergeUnifiedSources(
    checkpointItemCitationList(item),
    checkpointItemReferenceList(item),
  );
}

function canonicalMonitorSourceValue(record: Record<string, unknown>) {
  for (const field of ["sources", "sourceList", "source_list"] as const) {
    if (Object.prototype.hasOwnProperty.call(record, field)) {
      return { present: true as const, value: record[field] };
    }
  }
  return { present: false as const, value: undefined };
}

function safeMediaUrl(value: unknown): string | undefined {
  const text = normalizedText(value);
  if (!text || text.length > 4_096) return undefined;
  try {
    const url = new URL(text.replace(/&amp;/gi, "&"));
    if (
      !["http:", "https:"].includes(url.protocol) ||
      url.username ||
      url.password ||
      isMonitorProviderHostname(url.hostname) ||
      containsPrivateMonitorIdentity(url.toString())
    ) {
      return undefined;
    }
    return url.toString();
  } catch {
    return undefined;
  }
}

function mediaTypeFrom(value: unknown, url: string): MonitorMedia["type"] {
  const hint = normalizedText(value).toLowerCase();
  if (hint.includes("image") || hint === "img" || hint === "picture")
    return "image";
  if (hint.includes("video") || hint === "movie") return "video";
  if (hint.includes("audio") || hint.includes("podcast")) return "audio";
  const pathname = (() => {
    try {
      return new URL(url).pathname.toLowerCase();
    } catch {
      return "";
    }
  })();
  if (/\.(?:avif|gif|jpe?g|png|svg|webp)$/.test(pathname)) return "image";
  if (/\.(?:m3u8|mov|mp4|m4v|webm)$/.test(pathname)) return "video";
  if (/\.(?:aac|m4a|mp3|ogg|wav)$/.test(pathname)) return "audio";
  return "link";
}

function firstMediaUrl(
  record: Record<string, unknown>,
  keys: readonly string[],
): string | undefined {
  for (const key of keys) {
    const direct = safeMediaUrl(record[key]);
    if (direct) return direct;
    const nested = record[key];
    if (isRecord(nested)) {
      for (const nestedKey of ["url", "src", "href"]) {
        const candidate = safeMediaUrl(nested[nestedKey]);
        if (candidate) return candidate;
      }
    }
  }
  return undefined;
}

function normalizeMediaCandidate(value: unknown): MonitorMedia | undefined {
  if (typeof value === "string") {
    const url = safeMediaUrl(value);
    return url ? { type: mediaTypeFrom(undefined, url), url } : undefined;
  }
  if (!isRecord(value)) return undefined;
  const url = firstMediaUrl(value, [
    "url",
    "href",
    "src",
    "mediaUrl",
    "media_url",
    "contentUrl",
    "content_url",
    "videoUrl",
    "video_url",
    "imageUrl",
    "image_url",
    "audioUrl",
    "audio_url",
    "playUrl",
    "play_url",
  ]);
  if (!url) return undefined;
  const type = mediaTypeFrom(
    value.type ?? value.mediaType ?? value.media_type ?? value.mimeType,
    url,
  );
  const title = normalizedText(
    value.title ?? value.name ?? value.alt ?? value.description ?? value.desc,
  );
  const thumbnailUrl = firstMediaUrl(value, [
    "thumbnailUrl",
    "thumbnail_url",
    "thumbnail",
    "posterUrl",
    "poster_url",
    "poster",
    "coverUrl",
    "cover_url",
    "cover",
  ]);
  return {
    type,
    url,
    ...(title ? { title: sanitizeMonitorPublicText(title).slice(0, 500) } : {}),
    ...(thumbnailUrl ? { thumbnailUrl } : {}),
  };
}

function htmlAttribute(tag: string, name: string): string | undefined {
  const match = tag.match(
    new RegExp(`\\b${name}\\s*=\\s*(["'])([\\s\\S]*?)\\1`, "i"),
  );
  return match?.[2];
}

function mediaFromAnswerHtml(answerContent: unknown): MonitorMedia[] {
  if (typeof answerContent !== "string") return [];
  const html = answerContent.slice(0, MAX_ANSWER_CHARACTERS * 2);
  const media: MonitorMedia[] = [];
  for (const match of html.matchAll(/<(img|video|audio|source)\b[^>]*>/gi)) {
    const tag = match[0];
    const tagName = match[1].toLowerCase();
    const url = safeMediaUrl(htmlAttribute(tag, "src"));
    if (!url) continue;
    const type =
      tagName === "img"
        ? "image"
        : tagName === "audio"
          ? "audio"
          : tagName === "video"
            ? "video"
            : mediaTypeFrom(htmlAttribute(tag, "type"), url);
    const title = sanitizeMonitorPublicText(
      normalizedText(htmlAttribute(tag, "alt") ?? htmlAttribute(tag, "title")),
    ).slice(0, 500);
    const thumbnailUrl =
      type === "video" ? safeMediaUrl(htmlAttribute(tag, "poster")) : undefined;
    media.push({
      type,
      url,
      ...(title ? { title } : {}),
      ...(thumbnailUrl ? { thumbnailUrl } : {}),
    });
  }
  for (const match of html.matchAll(
    /!\[([^\]]*)\]\((https?:\/\/[^\s)]+)\)/gi,
  )) {
    const url = safeMediaUrl(match[2]);
    if (!url) continue;
    const title = sanitizeMonitorPublicText(normalizedText(match[1])).slice(
      0,
      500,
    );
    media.push({ type: "image", url, ...(title ? { title } : {}) });
  }
  for (const block of html.matchAll(
    /<div\b[^>]*class=["'][^"']*media-video-grid[^"']*["'][^>]*>[\s\S]*?<\/div\s*>/gi,
  )) {
    for (const link of block[0].matchAll(
      /<a\b[^>]*href\s*=\s*(["'])([\s\S]*?)\1[^>]*>/gi,
    )) {
      const url = safeMediaUrl(link[2]);
      if (url) media.push({ type: mediaTypeFrom("video", url), url });
    }
  }
  return media;
}

/**
 * Convert untrusted provider media to a small allowlisted structure. Page
 * screenshots are deliberately not accepted here and hidden reasoning remains
 * outside the customer result contract.
 */
export function sanitizeMonitorMedia(
  value: unknown,
  answerContent?: unknown,
): MonitorMedia[] {
  const rawItems = Array.isArray(value) ? value : [value];
  const candidates = rawItems.map(normalizeMediaCandidate);
  const embedded = rawItems.flatMap((item) => {
    if (typeof item === "string") return mediaFromAnswerHtml(item);
    if (!isRecord(item)) return [];
    return mediaFromAnswerHtml(item.html ?? item.content ?? item.markup);
  });
  const result: MonitorMedia[] = [];
  const seen = new Set<string>();
  for (const item of [
    ...candidates,
    ...embedded,
    ...mediaFromAnswerHtml(answerContent),
  ]) {
    if (!item) continue;
    const key = `${item.type}:${item.url}`;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(item);
    if (result.length >= MAX_MEDIA_ITEMS) break;
  }
  return result;
}

/** Convert rich provider output into display-safe text. */
export function sanitizeMonitorAnswerText(
  value: unknown,
  _knownInlineCitationIndexes?: ReadonlySet<number>,
): string {
  if (typeof value !== "string") return "";
  let text = value.slice(0, MAX_ANSWER_CHARACTERS * 2);
  text = text
    .replace(
      providerInlineCitationPattern(),
      (_marker, indexText: string) =>
        `〔来源 ${Number.parseInt(indexText, 10)}〕`,
    )
    .replace(
      bracketInlineCitationPattern(),
      (_marker, indexText: string) =>
        `〔来源 ${Number.parseInt(indexText, 10)}〕`,
    )
    .replace(/<script\b[^>]*>[\s\S]*?<\/script\s*>/gi, " ")
    .replace(/<style\b[^>]*>[\s\S]*?<\/style\s*>/gi, " ")
    .replace(
      /<div\b[^>]*class=["'][^"']*media-video-grid[^"']*["'][^>]*>[\s\S]*?<\/div\s*>/gi,
      " ",
    )
    .replace(
      /<(?:picture|video|audio|iframe|svg|canvas)\b[^>]*>[\s\S]*?<\/(?:picture|video|audio|iframe|svg|canvas)\s*>/gi,
      " ",
    )
    .replace(/<(?:img|source|track)\b[^>]*\/?\s*>/gi, " ")
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\[([^\]\r\n]+)\]\([^)]*\)/g, "$1")
    .replace(/data:image\/[a-z0-9.+-]+;base64,[a-z0-9+/=]+/gi, " ")
    .replace(
      /https?:\/\/[^\s<>()]+\.(?:avif|gif|jpe?g|png|svg|webp)(?:\?[^\s<>()]*)?/gi,
      " ",
    )
    .replace(/<br\s*\/?\s*>/gi, "\n")
    .replace(/<\/(?:div|p|li|section|article|h[1-6])\s*>/gi, "\n")
    .replace(/<\/?[A-Za-z][^>]*>/g, " ")
    .replace(/&#x([0-9a-f]{1,6});/gi, (_match, hex: string) => {
      const codePoint = Number.parseInt(hex, 16);
      return codePoint <= 0x10ffff ? String.fromCodePoint(codePoint) : "";
    })
    .replace(/&#([0-9]{1,7});/g, (_match, digits: string) => {
      const codePoint = Number.parseInt(digits, 10);
      return codePoint <= 0x10ffff ? String.fromCodePoint(codePoint) : "";
    })
    .replace(/&(nbsp|amp|lt|gt|quot|apos);/gi, (entity) => {
      const decoded: Record<string, string> = {
        "&nbsp;": " ",
        "&amp;": "&",
        "&lt;": "<",
        "&gt;": ">",
        "&quot;": '"',
        "&apos;": "'",
      };
      return decoded[entity.toLowerCase()] ?? " ";
    })
    .replace(/<\/?[A-Za-z][^>]*>/g, " ")
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "")
    .trim();
  return sanitizeMonitorPublicText(text).slice(0, MAX_ANSWER_CHARACTERS);
}

function normalizeTimestamp(value: unknown): string | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
  }
  const text = normalizedText(value);
  if (!text) return undefined;
  const date = new Date(text);
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
}

function normalizeResultSnapshot(
  payload: unknown,
  run: PresalesMonitorRun,
): { checkpoint: MonitorCheckpoint; remoteStatus: string; totalItems: number } {
  const taskId = normalizedText(run.upstreamTaskId);
  if (!taskId) {
    throw new PresalesMonitorError(
      "MONITOR_SHAPE_MISMATCH",
      502,
      "监控台账缺少任务 ID",
    );
  }
  if (
    !isRecord(payload) ||
    payload.success !== true ||
    !isRecord(payload.data)
  ) {
    throw new MonitorRemoteError("监控结果接口未返回有效 JSON", true);
  }
  assertResponseOwner(payload, taskId, "监控结果", true);
  const request = normalizeMonitorRequestSnapshot(run.checkpoint);
  const totalItems = positiveInteger(payload.data.totalItems);
  if (totalItems !== run.expectedItems) {
    throw new PresalesMonitorError(
      "MONITOR_SHAPE_MISMATCH",
      502,
      "监控结果总数与提交范围不一致",
    );
  }
  const remoteStatus = normalizedText(payload.data.status).toLowerCase();
  if (!remoteStatus) {
    throw new PresalesMonitorError(
      "MONITOR_SHAPE_MISMATCH",
      502,
      "监控结果缺少主任务状态",
    );
  }
  const children = payload.data.subTaskList;
  if (!Array.isArray(children)) {
    throw new PresalesMonitorError(
      "MONITOR_SHAPE_MISMATCH",
      502,
      "监控结果缺少子任务列表",
    );
  }
  const initialIds = new Set(jsonStringArray(run.initialSubtaskIds));
  const scopes = jsonScopeMap(run.subtaskScopes);
  if (
    initialIds.size !== run.expectedItems ||
    Object.keys(scopes).length !== run.expectedItems
  ) {
    throw new PresalesMonitorError(
      "MONITOR_SHAPE_MISMATCH",
      502,
      "监控台账中的初始子任务范围不完整",
    );
  }
  const seen = new Set<string>();
  const items: MonitorCheckpointItem[] = [];
  for (const child of children) {
    if (!isRecord(child)) {
      throw new PresalesMonitorError(
        "MONITOR_SHAPE_MISMATCH",
        502,
        "监控结果包含无法归属的子任务",
      );
    }
    const subTaskId = normalizedText(child.subTaskId);
    const scope = scopes[subTaskId];
    const childTaskId = normalizedText(child.taskId);
    const responsePlatform = toPublicMonitorPlatform(child.platform);
    if (
      !subTaskId ||
      seen.has(subTaskId) ||
      !initialIds.has(subTaskId) ||
      !scope ||
      child.prompt !== run.question ||
      responsePlatform !== scope.platform ||
      normalizedText(child.mode).toLowerCase() !== "search" ||
      (childTaskId && childTaskId !== taskId)
    ) {
      throw new PresalesMonitorError(
        "MONITOR_SHAPE_MISMATCH",
        502,
        "监控结果的任务 ID、问题或平台范围发生冲突",
      );
    }
    seen.add(subTaskId);
    const hasCitationList = Object.prototype.hasOwnProperty.call(
      child,
      "citationList",
    );
    const hasReferenceList = Object.prototype.hasOwnProperty.call(
      child,
      "referenceList",
    );
    const references = hasReferenceList
      ? sanitizeEvidence(child.referenceList, MAX_EVIDENCE_CANDIDATES)
      : undefined;
    const citations = hasCitationList
      ? mergeCitationEvidence(
          sanitizeEvidence(child.citationList, MAX_EVIDENCE_CANDIDATES),
          citationsFromInlineMarkers(child.answerContent, child.referenceList),
        )
      : undefined;
    const canonicalSources = canonicalMonitorSourceValue(child);
    const sources = canonicalSources.present
      ? mergeUnifiedSources(
          sanitizeEvidence(canonicalSources.value, MAX_EVIDENCE_CANDIDATES),
        )
      : mergeUnifiedSources(citations, references);
    const answer = sanitizeMonitorAnswerText(child.answerContent);
    const media = sanitizeMonitorMedia(child.mediaContent, child.answerContent);
    const error = normalizedText(child.errorMessage) ? "本次回答未成功" : "";
    const sentiment = Object.prototype.hasOwnProperty.call(child, "sentiment")
      ? sanitizeMonitorSentiment(child.sentiment)
      : undefined;
    const categoryRanking = Object.prototype.hasOwnProperty.call(
      child,
      "categoryRanking",
    )
      ? sanitizeCategoryRanking(child.categoryRanking)
      : undefined;
    items.push({
      subTaskId,
      prompt: run.question,
      platform: scope.platform,
      mode: "search",
      status:
        sanitizeMonitorPublicText(
          normalizedText(child.status).toLowerCase(),
        ).slice(0, 64) || "unknown",
      ...(answer ? { answerText: answer } : {}),
      media,
      sources,
      ...(citations !== undefined
        ? { citationList: citations.slice(0, MAX_CITATION_ITEMS) }
        : {}),
      ...(references !== undefined
        ? { referenceList: references.slice(0, MAX_SOURCE_ITEMS) }
        : {}),
      ...(Array.isArray(child.searchKeywords)
        ? {
            searchKeywords: sanitizeMonitorStringList(
              child.searchKeywords,
              MAX_SEARCH_KEYWORDS,
            ),
          }
        : {}),
      ...(Array.isArray(child.recommendedQuestions)
        ? {
            recommendedQuestions: sanitizeMonitorStringList(
              child.recommendedQuestions,
              MAX_RECOMMENDED_QUESTIONS,
            ),
          }
        : {}),
      ...(child.mentionPosition === null
        ? { mentionPosition: null }
        : positiveInteger(child.mentionPosition) !== null
          ? { mentionPosition: positiveInteger(child.mentionPosition)! }
          : {}),
      ...(normalizedText(child.mentionContext)
        ? {
            mentionContext: sanitizeMonitorPublicText(
              normalizedText(child.mentionContext),
            ).slice(0, 2_000),
          }
        : {}),
      ...(sentiment !== undefined ? { sentiment } : {}),
      ...(categoryRanking !== undefined ? { categoryRanking } : {}),
      ...(Array.isArray(child.keywordEvaluations)
        ? {
            keywordEvaluations: sanitizeKeywordEvaluations(
              child.keywordEvaluations,
            ),
          }
        : {}),
      ...(request?.screenshot === 1 &&
      safeMonitorScreenshotUrl(child.pageScreenshot)
        ? { pageScreenshot: safeMonitorScreenshotUrl(child.pageScreenshot)! }
        : {}),
      ...(error ? { error } : {}),
      ...(normalizeTimestamp(child.time)
        ? { completedAt: normalizeTimestamp(child.time) }
        : {}),
    });
  }
  return {
    checkpoint: {
      ...(request ? { request } : {}),
      items,
    },
    remoteStatus,
    totalItems,
  };
}

function mergeCheckpoints(
  existingValue: unknown,
  incoming: MonitorCheckpoint,
): MonitorCheckpoint {
  const existing = monitorCheckpoint(existingValue);
  const byId = new Map(existing.items.map((item) => [item.subTaskId, item]));
  for (const next of incoming.items) {
    const prior = byId.get(next.subTaskId);
    if (!prior) {
      byId.set(next.subTaskId, next);
      continue;
    }
    const nextFinal = CHILD_FINAL_STATUSES.has(next.status);
    const priorSuccessful = isSuccessful(prior);
    const nextSuccessful = isSuccessful(next);
    const priorCitations = checkpointItemCitationList(prior);
    const nextCitations = checkpointItemCitationList(next);
    const priorReferences = checkpointItemReferenceList(prior);
    const nextReferences = checkpointItemReferenceList(next);
    const answerText =
      priorSuccessful && nextSuccessful
        ? (next.answerText?.length ?? 0) > (prior.answerText?.length ?? 0)
          ? next.answerText
          : prior.answerText
        : nextSuccessful
          ? next.answerText
          : priorSuccessful
            ? prior.answerText
            : nextFinal
              ? (next.answerText ?? prior.answerText)
              : next.answerText;
    const error =
      priorSuccessful || nextSuccessful || !nextFinal
        ? undefined
        : (next.error ?? prior.error);
    const completedAt = priorSuccessful
      ? prior.completedAt
      : nextSuccessful
        ? (next.completedAt ?? prior.completedAt)
        : nextFinal
          ? (next.completedAt ?? prior.completedAt)
          : undefined;
    byId.set(next.subTaskId, {
      ...prior,
      status:
        priorSuccessful && !nextSuccessful
          ? prior.status
          : next.status || prior.status,
      answerText,
      media: mergeMedia(prior.media, next.media),
      sources: mergeUnifiedSources(
        checkpointItemSources(prior),
        checkpointItemSources(next),
      ),
      ...(nextCitations !== undefined
        ? {
            citationList: sanitizeEvidence(nextCitations, MAX_CITATION_ITEMS),
          }
        : priorCitations !== undefined
          ? { citationList: priorCitations }
          : {}),
      ...(nextReferences !== undefined
        ? {
            referenceList: sanitizeEvidence(nextReferences, MAX_SOURCE_ITEMS),
          }
        : priorReferences !== undefined
          ? { referenceList: priorReferences }
          : {}),
      ...(Object.prototype.hasOwnProperty.call(next, "searchKeywords")
        ? {
            searchKeywords: sanitizeMonitorStringList(
              next.searchKeywords,
              MAX_SEARCH_KEYWORDS,
            ),
          }
        : Object.prototype.hasOwnProperty.call(prior, "searchKeywords")
          ? {
              searchKeywords: sanitizeMonitorStringList(
                prior.searchKeywords,
                MAX_SEARCH_KEYWORDS,
              ),
            }
          : {}),
      ...(Object.prototype.hasOwnProperty.call(next, "recommendedQuestions")
        ? {
            recommendedQuestions: sanitizeMonitorStringList(
              next.recommendedQuestions,
              MAX_RECOMMENDED_QUESTIONS,
            ),
          }
        : Object.prototype.hasOwnProperty.call(prior, "recommendedQuestions")
          ? {
              recommendedQuestions: sanitizeMonitorStringList(
                prior.recommendedQuestions,
                MAX_RECOMMENDED_QUESTIONS,
              ),
            }
          : {}),
      ...(Object.prototype.hasOwnProperty.call(next, "mentionPosition")
        ? { mentionPosition: next.mentionPosition }
        : Object.prototype.hasOwnProperty.call(prior, "mentionPosition")
          ? { mentionPosition: prior.mentionPosition }
          : {}),
      ...(next.mentionContext || prior.mentionContext
        ? { mentionContext: next.mentionContext ?? prior.mentionContext }
        : {}),
      ...(Object.prototype.hasOwnProperty.call(next, "sentiment")
        ? { sentiment: next.sentiment }
        : Object.prototype.hasOwnProperty.call(prior, "sentiment")
          ? { sentiment: prior.sentiment }
          : {}),
      ...(Object.prototype.hasOwnProperty.call(next, "categoryRanking")
        ? { categoryRanking: next.categoryRanking }
        : Object.prototype.hasOwnProperty.call(prior, "categoryRanking")
          ? { categoryRanking: prior.categoryRanking }
          : {}),
      ...(Object.prototype.hasOwnProperty.call(next, "keywordEvaluations")
        ? { keywordEvaluations: next.keywordEvaluations }
        : Object.prototype.hasOwnProperty.call(prior, "keywordEvaluations")
          ? { keywordEvaluations: prior.keywordEvaluations }
          : {}),
      ...(next.pageScreenshot || prior.pageScreenshot
        ? { pageScreenshot: next.pageScreenshot ?? prior.pageScreenshot }
        : {}),
      error,
      completedAt,
    });
  }
  const request = existing.request ?? incoming.request;
  return {
    ...(request ? { request } : {}),
    items: [...byId.values()],
  };
}

function mergeMedia(
  first: MonitorMedia[] | undefined,
  second: MonitorMedia[] | undefined,
): MonitorMedia[] {
  const result: MonitorMedia[] = [];
  const seen = new Set<string>();
  for (const item of [...(first ?? []), ...(second ?? [])]) {
    const key = `${item.type}:${item.url}`;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(item);
    if (result.length >= MAX_MEDIA_ITEMS) break;
  }
  return result;
}

function monitorCheckpoint(value: unknown): MonitorCheckpoint {
  if (!isRecord(value) || !Array.isArray(value.items)) return { items: [] };
  const request = normalizeMonitorRequestSnapshot(value);
  return {
    ...(request ? { request } : {}),
    items: value.items.filter(isRecord) as unknown as MonitorCheckpointItem[],
  };
}

function jsonStringArray(value: unknown): string[] {
  const parsed =
    typeof value === "string"
      ? (() => {
          try {
            return JSON.parse(value) as unknown;
          } catch {
            return [];
          }
        })()
      : value;
  return Array.isArray(parsed)
    ? parsed.filter((item): item is string => typeof item === "string")
    : [];
}

function jsonScopeMap(value: unknown): Record<string, MonitorScope> {
  const parsed =
    typeof value === "string"
      ? (() => {
          try {
            return JSON.parse(value) as unknown;
          } catch {
            return {};
          }
        })()
      : value;
  if (!isRecord(parsed)) return {};
  const result: Record<string, MonitorScope> = {};
  for (const [id, scope] of Object.entries(parsed)) {
    if (!isRecord(scope)) continue;
    const platform = toPublicMonitorPlatform(scope.platform);
    const runIndex = positiveInteger(scope.runIndex);
    if (
      platform &&
      runIndex !== null &&
      runIndex <= MONITOR_REPEAT_PER_PLATFORM
    ) {
      result[id] = { platform, runIndex };
    }
  }
  return result;
}

function isSuccessful(item: MonitorCheckpointItem) {
  return (
    item.status === "completed" &&
    Boolean(item.answerText?.trim()) &&
    !item.error
  );
}

function isFailedCheckpointItem(item: MonitorCheckpointItem) {
  return (
    ["failed", "error", "stopped"].includes(item.status) ||
    (item.status === "completed" && !isSuccessful(item))
  );
}

function checkpointProgress(
  run: PresalesMonitorRun,
  checkpoint: MonitorCheckpoint,
) {
  const initialIds = new Set(jsonStringArray(run.initialSubtaskIds));
  const items = checkpoint.items.filter(
    (item) => initialIds.size === 0 || initialIds.has(item.subTaskId),
  );
  return {
    successfulItems: items.filter(isSuccessful).length,
    failedItems: items.filter(isFailedCheckpointItem).length,
  };
}

function finalizeIncompleteCheckpoint(
  run: PresalesMonitorRun,
  checkpoint: MonitorCheckpoint,
  now: Date,
): MonitorCheckpoint {
  const byId = new Map(checkpoint.items.map((item) => [item.subTaskId, item]));
  const scopes = jsonScopeMap(run.subtaskScopes);
  const items = jsonStringArray(run.initialSubtaskIds).flatMap(
    (subTaskId): MonitorCheckpointItem[] => {
      const existing = byId.get(subTaskId);
      if (existing && isSuccessful(existing)) return [existing];
      if (
        existing &&
        ["failed", "error", "stopped"].includes(existing.status)
      ) {
        return [
          {
            ...existing,
            error: existing.error ?? "自动补采窗口内未返回有效回答",
            completedAt: existing.completedAt ?? now.toISOString(),
          },
        ];
      }
      const scope = scopes[subTaskId];
      if (!scope) return [];
      const { answerText: _incompleteAnswer, ...retained } = existing ?? {
        subTaskId,
        prompt: run.question,
        platform: scope.platform,
        mode: "search" as const,
        media: [],
        sources: [],
      };
      return [
        {
          ...retained,
          subTaskId,
          prompt: run.question,
          platform: scope.platform,
          mode: "search",
          status: "failed",
          error: "自动补采窗口内未返回有效回答",
          completedAt: now.toISOString(),
        },
      ];
    },
  );
  return {
    ...(checkpoint.request ? { request: checkpoint.request } : {}),
    items,
  };
}

function monitorRecoveryDeadline(run: PresalesMonitorRun) {
  return run.submittedAt
    ? new Date(run.submittedAt.getTime() + MONITOR_RECOVERY_WINDOW_MS)
    : null;
}

function isPrematureMonitorTerminal(run: PresalesMonitorRun, now: Date) {
  if (
    !RECOVERABLE_TERMINAL_LOCAL_STATUSES.has(run.status) ||
    !run.upstreamTaskId ||
    !run.submittedAt ||
    !run.completedAt ||
    !RECOVERABLE_REMOTE_STATUSES.has(
      normalizedText(run.remoteStatus).toLowerCase(),
    )
  ) {
    return false;
  }
  const deadline = monitorRecoveryDeadline(run);
  if (!deadline || run.completedAt.getTime() >= deadline.getTime()) {
    return false;
  }
  const checkpoint = monitorCheckpoint(run.checkpoint);
  if (checkpoint.items.length === 0) return false;
  const successful = checkpointProgress(run, checkpoint).successfulItems;
  return (
    successful < run.expectedItems && now.getTime() >= run.completedAt.getTime()
  );
}

function isMonitorPollEligible(run: PresalesMonitorRun, now: Date) {
  return (
    POLLABLE_LOCAL_STATUSES.has(run.status) ||
    isPrematureMonitorTerminal(run, now)
  );
}

function publicRecordId(runId: string, subTaskId: string) {
  return `mr_${sha256(`${runId}:${subTaskId}`).slice(0, 24)}`;
}

function publicMonitorRecordFromItem(
  run: PresalesMonitorRun,
  scope: MonitorScope,
  item: MonitorCheckpointItem,
  request?: MonitorRunRequestSnapshot,
): PublicMonitorRecord {
  const recordId = publicRecordId(run.id, item.subTaskId);
  const citationList = checkpointItemCitationList(item);
  const referenceList = checkpointItemReferenceList(item);
  const screenshotAvailable = Boolean(
    request?.screenshot === 1 && safeMonitorScreenshotUrl(item.pageScreenshot),
  );
  return {
    recordId,
    platform: scope.platform,
    runIndex: scope.runIndex,
    status: normalizedText(item.status),
    ...(normalizedText(item.answerText)
      ? { answerText: normalizedText(item.answerText) }
      : {}),
    media: sanitizeMonitorMedia(item.media),
    sources: checkpointItemSources(item),
    ...(citationList ? { citationList } : {}),
    ...(referenceList ? { referenceList } : {}),
    ...(Object.prototype.hasOwnProperty.call(item, "searchKeywords")
      ? {
          searchKeywords: sanitizeMonitorStringList(
            item.searchKeywords,
            MAX_SEARCH_KEYWORDS,
          ),
        }
      : {}),
    ...(Object.prototype.hasOwnProperty.call(item, "recommendedQuestions")
      ? {
          recommendedQuestions: sanitizeMonitorStringList(
            item.recommendedQuestions,
            MAX_RECOMMENDED_QUESTIONS,
          ),
        }
      : {}),
    ...(Object.prototype.hasOwnProperty.call(item, "mentionPosition")
      ? { mentionPosition: item.mentionPosition }
      : {}),
    ...(normalizedText(item.mentionContext)
      ? { mentionContext: normalizedText(item.mentionContext) }
      : {}),
    ...(Object.prototype.hasOwnProperty.call(item, "sentiment")
      ? { sentiment: item.sentiment }
      : {}),
    ...(Object.prototype.hasOwnProperty.call(item, "categoryRanking")
      ? { categoryRanking: item.categoryRanking }
      : {}),
    ...(Object.prototype.hasOwnProperty.call(item, "keywordEvaluations")
      ? {
          keywordEvaluations: sanitizeKeywordEvaluations(
            item.keywordEvaluations,
          ),
        }
      : {}),
    ...(request?.screenshot === 1
      ? {
          screenshot: {
            available: screenshotAvailable,
          },
        }
      : {}),
    ...(normalizedText(item.error)
      ? { error: normalizedText(item.error) }
      : {}),
    ...(normalizedText(item.completedAt)
      ? { completedAt: normalizedText(item.completedAt) }
      : {}),
  };
}

function buildFinalResult(
  run: PresalesMonitorRun,
  checkpoint: MonitorCheckpoint,
  partial: boolean,
) {
  const scopes = jsonScopeMap(run.subtaskScopes);
  const byId = new Map(checkpoint.items.map((item) => [item.subTaskId, item]));
  const request = checkpoint.request;
  const records: PublicMonitorRecord[] = [];
  for (const subTaskId of jsonStringArray(run.initialSubtaskIds)) {
    const scope = scopes[subTaskId];
    const item = byId.get(subTaskId);
    if (!scope || !item) continue;
    records.push(publicMonitorRecordFromItem(run, scope, item, request));
  }
  records.sort(
    (a, b) =>
      MONITOR_PLATFORMS.indexOf(a.platform) -
        MONITOR_PLATFORMS.indexOf(b.platform) || a.runIndex - b.runIndex,
  );
  const successful = checkpoint.items.filter(isSuccessful).length;
  return {
    complete: !partial,
    partial,
    successfulItems: successful,
    records,
  };
}

function buildCheckpointResult(
  run: PresalesMonitorRun,
  checkpoint: MonitorCheckpoint,
) {
  return buildFinalResult(
    run,
    {
      ...(checkpoint.request ? { request: checkpoint.request } : {}),
      items: checkpoint.items.filter((item) => {
        if (!CHILD_FINAL_STATUSES.has(item.status)) return false;
        if (item.status !== "completed") return true;
        return Boolean(item.answerText?.trim() || item.error);
      }),
    },
    true,
  );
}

function checkpointSignature(checkpoint: MonitorCheckpoint) {
  return sha256(
    canonicalJson(
      [...checkpoint.items]
        .sort((a, b) => a.subTaskId.localeCompare(b.subTaskId))
        .map(({ pageScreenshot: _volatileScreenshot, ...item }) => item),
    ),
  );
}

function publicMonitorRun(
  run: PresalesMonitorRun,
  includeResult: boolean,
): PublicMonitorRun {
  const platforms = jsonStringArray(run.platforms)
    .map(toPublicMonitorPlatform)
    .filter((item): item is MonitorPlatform => item !== null)
    .filter((item, index, items) => items.indexOf(item) === index);
  const checkpoint = monitorCheckpoint(run.checkpoint);
  const request = checkpoint.request;
  const checkpointByRecordId = new Map(
    checkpoint.items.map((item) => [
      publicRecordId(run.id, item.subTaskId),
      item,
    ]),
  );
  const final = isRecord(run.finalResult) ? run.finalResult : null;
  const checkpointResult =
    includeResult && !final && POLLABLE_LOCAL_STATUSES.has(run.status)
      ? buildCheckpointResult(run, checkpoint)
      : null;
  const result =
    includeResult && final && Array.isArray(final.records)
      ? final
      : checkpointResult;
  const records = Array.isArray(result?.records)
    ? result.records.flatMap((record): PublicMonitorRecord[] => {
        if (!isRecord(record)) return [];
        const platform = toPublicMonitorPlatform(record.platform);
        if (!platform) return [];
        const storedRecordId = normalizedText(record.recordId);
        const sourceRecord =
          checkpointByRecordId.get(storedRecordId) ??
          (record as unknown as MonitorCheckpointItem);
        const citationList = checkpointItemCitationList(sourceRecord);
        const referenceList = checkpointItemReferenceList(sourceRecord);
        const screenshotAvailable = Boolean(
          request?.screenshot === 1 &&
            safeMonitorScreenshotUrl(sourceRecord.pageScreenshot),
        );
        return [
          {
            recordId: storedRecordId,
            platform,
            runIndex: positiveInteger(record.runIndex) || 1,
            status: normalizedText(record.status),
            ...(normalizedText(record.answerText)
              ? { answerText: normalizedText(record.answerText) }
              : {}),
            media: sanitizeMonitorMedia(record.media),
            sources: checkpointItemSources(sourceRecord),
            ...(citationList ? { citationList } : {}),
            ...(referenceList ? { referenceList } : {}),
            ...(Object.prototype.hasOwnProperty.call(
              sourceRecord,
              "searchKeywords",
            )
              ? {
                  searchKeywords: sanitizeMonitorStringList(
                    sourceRecord.searchKeywords,
                    MAX_SEARCH_KEYWORDS,
                  ),
                }
              : {}),
            ...(Object.prototype.hasOwnProperty.call(
              sourceRecord,
              "recommendedQuestions",
            )
              ? {
                  recommendedQuestions: sanitizeMonitorStringList(
                    sourceRecord.recommendedQuestions,
                    MAX_RECOMMENDED_QUESTIONS,
                  ),
                }
              : {}),
            ...(Object.prototype.hasOwnProperty.call(
              sourceRecord,
              "mentionPosition",
            )
              ? { mentionPosition: sourceRecord.mentionPosition }
              : {}),
            ...(normalizedText(sourceRecord.mentionContext)
              ? { mentionContext: normalizedText(sourceRecord.mentionContext) }
              : {}),
            ...(Object.prototype.hasOwnProperty.call(sourceRecord, "sentiment")
              ? { sentiment: sourceRecord.sentiment }
              : {}),
            ...(Object.prototype.hasOwnProperty.call(
              sourceRecord,
              "categoryRanking",
            )
              ? { categoryRanking: sourceRecord.categoryRanking }
              : {}),
            ...(Object.prototype.hasOwnProperty.call(
              sourceRecord,
              "keywordEvaluations",
            )
              ? {
                  keywordEvaluations: sanitizeKeywordEvaluations(
                    sourceRecord.keywordEvaluations,
                  ),
                }
              : {}),
            ...(request?.screenshot === 1
              ? {
                  screenshot: {
                    available: screenshotAvailable,
                  },
                }
              : {}),
            ...(normalizedText(record.error)
              ? { error: normalizedText(record.error) }
              : {}),
            ...(normalizedText(record.completedAt)
              ? { completedAt: normalizedText(record.completedAt) }
              : {}),
          },
        ];
      })
    : undefined;
  return {
    runId: run.id,
    status: run.status,
    createdAt: run.createdAt.toISOString(),
    question: run.question,
    platforms,
    repeatPerPlatform: MONITOR_REPEAT_PER_PLATFORM,
    expectedItems: run.expectedItems,
    completedItems: run.completedItems,
    failedItems: run.failedItems,
    ...(request?.monitorKeyword
      ? { monitorKeyword: request.monitorKeyword }
      : {}),
    ...(request ? { screenshot: request.screenshot } : {}),
    ...(request?.region ? { region: request.region } : {}),
    ...(run.submittedAt ? { submittedAt: run.submittedAt.toISOString() } : {}),
    ...(run.nextPollAt ? { nextPollAt: run.nextPollAt.toISOString() } : {}),
    ...(result ? { complete: result.complete === true } : {}),
    ...(records?.length ? { records } : {}),
  };
}

function statusData(payload: unknown, run: PresalesMonitorRun) {
  const taskId = normalizedText(run.upstreamTaskId);
  if (!taskId) {
    throw new PresalesMonitorError(
      "MONITOR_SHAPE_MISMATCH",
      502,
      "监控台账缺少任务 ID",
    );
  }
  if (
    !isRecord(payload) ||
    payload.success !== true ||
    !isRecord(payload.data)
  ) {
    throw new MonitorRemoteError("监控状态接口未返回有效 JSON", true);
  }
  assertResponseOwner(payload, taskId, "监控状态");
  const totalItems = positiveInteger(payload.data.totalItems);
  const completedItems = nonnegativeInteger(payload.data.completedItems);
  const failedItems = nonnegativeInteger(payload.data.failedItems);
  const remoteStatus = normalizedText(payload.data.status).toLowerCase();
  if (
    totalItems !== run.expectedItems ||
    completedItems === null ||
    failedItems === null ||
    completedItems + failedItems > run.expectedItems ||
    !remoteStatus
  ) {
    throw new PresalesMonitorError(
      "MONITOR_SHAPE_MISMATCH",
      502,
      "监控状态的数量或状态字段无效",
    );
  }
  return { totalItems, completedItems, failedItems, remoteStatus };
}

async function requireDb() {
  const db = await getDb();
  if (!db) {
    throw new PresalesMonitorError(
      "DATABASE_UNAVAILABLE",
      503,
      "监控台账数据库尚未配置",
    );
  }
  return db;
}

async function assertMonitorProjectActive(tx: any, projectId: string) {
  try {
    await lockActiveWebsiteProjectLifecycle(tx, projectId);
  } catch (error) {
    if (!(error instanceof WebsiteProjectInactiveError)) throw error;
    throw new PresalesMonitorError(
      "PROJECT_DELETED",
      410,
      "项目已进入永久删除流程，不能再创建监控任务",
    );
  }
}

type WorkspaceQuotaAccount = {
  id: number;
  limit: number | null;
};

async function loadWorkspaceQuotaAccount(
  executor: any,
  userId: number,
  lock: boolean,
): Promise<WorkspaceQuotaAccount | null> {
  const query = executor
    .select({
      id: users.id,
      role: users.role,
      marketEdition: users.marketEdition,
      isActive: users.isActive,
      limit: users.brandTrackingMonthlyLimit,
    })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);
  const rows = lock ? await query.for("update") : await query;
  const row = rows[0] as
    | {
        id: number;
        role: string;
        marketEdition: string;
        isActive: boolean;
        limit: number | null;
      }
    | undefined;
  if (
    !row ||
    row.role !== "user" ||
    row.marketEdition !== "overseas" ||
    row.isActive !== true
  ) {
    return null;
  }
  const limit = row.limit === null ? null : Number(row.limit);
  if (limit !== null && (!Number.isInteger(limit) || limit < 0)) {
    throw new PresalesMonitorError(
      "DATABASE_UNAVAILABLE",
      503,
      "品牌追踪额度配置无效",
    );
  }
  return { id: Number(row.id), limit };
}

function billedWorkspaceRunWhere(
  projectId: string,
  window: Pick<WorkspaceMonitorQuotaWindow, "windowStartedAt" | "windowEndsAt">,
) {
  return and(
    eq(presalesMonitorRuns.projectId, projectId),
    gte(presalesMonitorRuns.createdAt, window.windowStartedAt),
    lt(presalesMonitorRuns.createdAt, window.windowEndsAt),
    // An explicit provider rejection with no task identity is not billable.
    // Ambiguous submissions remain reserved because the provider may have
    // accepted them before the response was lost.
    or(
      ne(presalesMonitorRuns.status, "remote_failed"),
      isNotNull(presalesMonitorRuns.upstreamTaskId),
    ),
  );
}

async function readWorkspaceMonitorUsed(
  executor: any,
  projectId: string,
  window: Pick<WorkspaceMonitorQuotaWindow, "windowStartedAt" | "windowEndsAt">,
  lock = false,
) {
  let used: number;
  if (lock) {
    // This is deliberately a locking row read rather than an aggregate
    // consistent-snapshot read. The users row is locked first, so every
    // workspace reservation observes the preceding committed reservation even
    // under MySQL REPEATABLE READ.
    const rows = await executor
      .select({ expectedItems: presalesMonitorRuns.expectedItems })
      .from(presalesMonitorRuns)
      .where(billedWorkspaceRunWhere(projectId, window))
      .for("update");
    used = rows.reduce(
      (sum: number, row: { expectedItems: number }) =>
        sum + Number(row.expectedItems),
      0,
    );
  } else {
    const rows = await executor
      .select({
        used: sql<number>`coalesce(sum(${presalesMonitorRuns.expectedItems}), 0)`,
      })
      .from(presalesMonitorRuns)
      .where(billedWorkspaceRunWhere(projectId, window));
    used = Number(rows[0]?.used ?? 0);
  }
  if (!Number.isSafeInteger(used) || used < 0) {
    throw new PresalesMonitorError(
      "DATABASE_UNAVAILABLE",
      503,
      "品牌追踪额度使用量无效",
    );
  }
  return used;
}

export function assertWorkspaceMonitorQuotaAvailable(input: {
  limit: number | null;
  used: number;
  expectedItems: number;
}) {
  if (input.limit !== null && input.used + input.expectedItems > input.limit) {
    throw new PresalesMonitorError(
      "MONITOR_QUOTA_EXCEEDED",
      429,
      `本月品牌追踪额度不足，本次需要 ${input.expectedItems} 次，当前剩余 ${Math.max(0, input.limit - input.used)} 次`,
    );
  }
}

export class DrizzleMonitorRepository implements MonitorRepository {
  async reserve(
    input: Parameters<MonitorRepository["reserve"]>[0],
  ): Promise<MonitorReservation> {
    const db = await requireDb();
    const run: InsertPresalesMonitorRun = {
      id: randomUUID(),
      projectId: input.projectId ?? null,
      idempotencyKeyHash: input.idempotencyKeyHash,
      requestHash: input.requestHash,
      apiCredentialId: input.credential.id,
      credentialVersion: input.credential.version,
      question: input.question,
      platforms: [...input.platforms],
      expectedItems: input.expectedItems,
      checkpoint: input.checkpoint,
      status: "submission_in_progress",
      completedItems: 0,
      failedItems: 0,
      shapeMismatch: false,
      terminalStableCount: 0,
      createdAt: input.now,
      updatedAt: input.now,
    };
    if (input.workspaceQuota) {
      return this.reserveWorkspace(db, input, run);
    }
    try {
      if (input.projectId) {
        await db.transaction(async (tx: any) => {
          await assertMonitorProjectActive(tx, input.projectId!);
          await tx.insert(presalesMonitorRuns).values(run);
        });
      } else {
        await db.insert(presalesMonitorRuns).values(run);
      }
      const inserted = await this.get(run.id);
      if (!inserted) throw new Error("Inserted monitor run was not found");
      return { state: "acquired", run: inserted };
    } catch (error) {
      if (!isMonitorDuplicateReservationError(error)) throw error;
    }
    return db.transaction(async (tx: any) => {
      if (input.projectId) {
        await assertMonitorProjectActive(tx, input.projectId);
      }
      const existing = await tx
        .select()
        .from(presalesMonitorRuns)
        .where(
          eq(presalesMonitorRuns.idempotencyKeyHash, input.idempotencyKeyHash),
        )
        .limit(1)
        .for("update");
      const row = existing[0] as PresalesMonitorRun | undefined;
      if (!row) {
        throw new PresalesMonitorError(
          "IDEMPOTENCY_PENDING",
          425,
          "监控幂等预留正在建立，请稍后重试",
          1_000,
        );
      }
      const legacyProjectBinding =
        row.projectId === null &&
        Boolean(input.projectId) &&
        row.requestHash !== input.requestHash &&
        (input.compatibleRequestHashes ?? []).includes(row.requestHash);
      if (row.requestHash !== input.requestHash && !legacyProjectBinding) {
        throw new PresalesMonitorError(
          "IDEMPOTENCY_CONFLICT",
          409,
          "该幂等键已绑定另一组监控问题或平台",
        );
      }
      if (
        row.projectId &&
        input.projectId &&
        row.projectId !== input.projectId
      ) {
        throw new PresalesMonitorError(
          "IDEMPOTENCY_CONFLICT",
          409,
          "该幂等键已绑定另一项目",
        );
      }
      if (legacyProjectBinding) {
        await tx
          .update(presalesMonitorRuns)
          .set({ projectId: input.projectId, updatedAt: input.now })
          .where(eq(presalesMonitorRuns.id, row.id));
        row.projectId = input.projectId ?? null;
      }
      if (row.deletedAt) {
        throw new PresalesMonitorError(
          "IDEMPOTENCY_RETIRED",
          409,
          "该幂等键对应的监控任务已删除，不能再次用于付费提交",
        );
      }
      const credentialChanged =
        row.apiCredentialId !== input.credential.id ||
        row.credentialVersion !== input.credential.version;
      const existingRequest = normalizeMonitorRequestSnapshot(row.checkpoint);
      const incomingRequest = input.checkpoint.request;
      if (
        !credentialChanged &&
        row.status === "submission_unknown" &&
        !row.upstreamTaskId &&
        sameMonitorRequestSnapshot(existingRequest, incomingRequest)
      ) {
        const retryPatch: Partial<InsertPresalesMonitorRun> = {
          status: "submission_in_progress",
          lastError: null,
          updatedAt: input.now,
        };
        await tx
          .update(presalesMonitorRuns)
          .set(retryPatch)
          .where(eq(presalesMonitorRuns.id, row.id));
        return {
          state: "acquired" as const,
          run: { ...row, ...retryPatch } as PresalesMonitorRun,
        };
      }
      if (
        credentialChanged &&
        row.status === "remote_failed" &&
        !row.upstreamTaskId
      ) {
        const retryPatch: Partial<InsertPresalesMonitorRun> = {
          apiCredentialId: input.credential.id,
          credentialVersion: input.credential.version,
          checkpoint: input.checkpoint,
          status: "submission_in_progress",
          lastError: null,
          completedAt: null,
          updatedAt: input.now,
        };
        await tx
          .update(presalesMonitorRuns)
          .set(retryPatch)
          .where(eq(presalesMonitorRuns.id, row.id));
        return {
          state: "acquired" as const,
          run: { ...row, ...retryPatch } as PresalesMonitorRun,
        };
      }
      if (credentialChanged) {
        throw new PresalesMonitorError(
          "IDEMPOTENCY_CONFLICT",
          409,
          "该幂等键已绑定另一监控凭据版本",
        );
      }
      return { state: "replay" as const, run: row };
    });
  }

  private async reserveWorkspace(
    db: any,
    input: Parameters<MonitorRepository["reserve"]>[0],
    run: InsertPresalesMonitorRun,
  ): Promise<MonitorReservation> {
    const quota = input.workspaceQuota!;
    const projectId = workspaceMonitorProjectId(quota.userId);
    if (input.projectId !== projectId) {
      throw new PresalesMonitorError("NOT_FOUND", 404, "监控任务不存在");
    }

    const reserve = () =>
      db.transaction(async (tx: any): Promise<MonitorReservation> => {
        // The account row is the per-workspace quota mutex and must be the
        // transaction's first database read. This prevents a prior transaction
        // from becoming invisible through a REPEATABLE READ snapshot.
        const account = await loadWorkspaceQuotaAccount(tx, quota.userId, true);
        if (!account) {
          throw new PresalesMonitorError(
            "NOT_FOUND",
            404,
            "当前账号无法使用品牌追踪",
          );
        }
        const existingRows = await tx
          .select()
          .from(presalesMonitorRuns)
          .where(
            eq(
              presalesMonitorRuns.idempotencyKeyHash,
              input.idempotencyKeyHash,
            ),
          )
          .limit(1)
          .for("update");
        const existing = existingRows[0] as PresalesMonitorRun | undefined;
        if (existing) {
          return this.resolveWorkspaceReservationReplay(
            tx,
            input,
            existing,
            account,
          );
        }
        const used = await readWorkspaceMonitorUsed(tx, projectId, quota, true);
        assertWorkspaceMonitorQuotaAvailable({
          limit: account.limit,
          used,
          expectedItems: input.expectedItems,
        });
        await tx.insert(presalesMonitorRuns).values(run);
        return {
          state: "acquired",
          run: run as PresalesMonitorRun,
        };
      });

    try {
      return await reserve();
    } catch (error) {
      if (!isMonitorDuplicateReservationError(error)) throw error;
      // A same-key concurrent transaction won the unique insert. Re-enter the
      // transaction and resolve it as a replay; no second quota reservation or
      // provider POST is allowed.
      return db.transaction(async (tx: any): Promise<MonitorReservation> => {
        const account = await loadWorkspaceQuotaAccount(tx, quota.userId, true);
        if (!account) {
          throw new PresalesMonitorError(
            "NOT_FOUND",
            404,
            "当前账号无法使用品牌追踪",
          );
        }
        const rows = await tx
          .select()
          .from(presalesMonitorRuns)
          .where(
            eq(
              presalesMonitorRuns.idempotencyKeyHash,
              input.idempotencyKeyHash,
            ),
          )
          .limit(1)
          .for("update");
        const existing = rows[0] as PresalesMonitorRun | undefined;
        if (!existing) {
          throw new PresalesMonitorError(
            "IDEMPOTENCY_PENDING",
            425,
            "监控幂等预留正在建立，请稍后重试",
            1_000,
          );
        }
        return this.resolveWorkspaceReservationReplay(
          tx,
          input,
          existing,
          account,
        );
      });
    }
  }

  private async resolveWorkspaceReservationReplay(
    tx: any,
    input: Parameters<MonitorRepository["reserve"]>[0],
    row: PresalesMonitorRun,
    account: WorkspaceQuotaAccount,
  ): Promise<MonitorReservation> {
    const quota = input.workspaceQuota!;
    const projectId = workspaceMonitorProjectId(quota.userId);
    if (row.projectId !== projectId) {
      throw new PresalesMonitorError("NOT_FOUND", 404, "监控任务不存在");
    }
    if (row.requestHash !== input.requestHash) {
      throw new PresalesMonitorError(
        "IDEMPOTENCY_CONFLICT",
        409,
        "该幂等键已绑定另一组监控问题或平台",
      );
    }
    if (row.deletedAt) {
      throw new PresalesMonitorError(
        "IDEMPOTENCY_RETIRED",
        409,
        "该幂等键对应的监控任务已删除，不能再次用于付费提交",
      );
    }
    const credentialChanged =
      row.apiCredentialId !== input.credential.id ||
      row.credentialVersion !== input.credential.version;
    const existingRequest = normalizeMonitorRequestSnapshot(row.checkpoint);
    const incomingRequest = input.checkpoint.request;
    if (
      !credentialChanged &&
      row.status === "submission_unknown" &&
      !row.upstreamTaskId &&
      sameMonitorRequestSnapshot(existingRequest, incomingRequest)
    ) {
      const retryPatch: Partial<InsertPresalesMonitorRun> = {
        status: "submission_in_progress",
        lastError: null,
        updatedAt: input.now,
      };
      await tx
        .update(presalesMonitorRuns)
        .set(retryPatch)
        .where(eq(presalesMonitorRuns.id, row.id));
      return {
        state: "acquired",
        run: { ...row, ...retryPatch } as PresalesMonitorRun,
      };
    }
    if (
      credentialChanged &&
      row.status === "remote_failed" &&
      !row.upstreamTaskId
    ) {
      const used = await readWorkspaceMonitorUsed(tx, projectId, quota, true);
      assertWorkspaceMonitorQuotaAvailable({
        limit: account.limit,
        used,
        expectedItems: input.expectedItems,
      });
      const retryPatch: Partial<InsertPresalesMonitorRun> = {
        apiCredentialId: input.credential.id,
        credentialVersion: input.credential.version,
        checkpoint: input.checkpoint,
        status: "submission_in_progress",
        lastError: null,
        completedAt: null,
        createdAt: input.now,
        updatedAt: input.now,
      };
      await tx
        .update(presalesMonitorRuns)
        .set(retryPatch)
        .where(eq(presalesMonitorRuns.id, row.id));
      return {
        state: "acquired",
        run: { ...row, ...retryPatch } as PresalesMonitorRun,
      };
    }
    if (credentialChanged) {
      throw new PresalesMonitorError(
        "IDEMPOTENCY_CONFLICT",
        409,
        "该幂等键已绑定另一监控凭据版本",
      );
    }
    return { state: "replay", run: row };
  }

  async get(runId: string) {
    const db = await requireDb();
    const rows = await db
      .select()
      .from(presalesMonitorRuns)
      .where(
        and(
          eq(presalesMonitorRuns.id, runId),
          isNull(presalesMonitorRuns.deletedAt),
        ),
      )
      .limit(1);
    return rows[0] ?? null;
  }

  async getLatestByProject(projectId: string) {
    const db = await requireDb();
    const rows = await db
      .select()
      .from(presalesMonitorRuns)
      .where(
        and(
          eq(presalesMonitorRuns.projectId, projectId),
          isNull(presalesMonitorRuns.deletedAt),
        ),
      )
      .orderBy(
        desc(presalesMonitorRuns.createdAt),
        desc(presalesMonitorRuns.id),
      )
      .limit(1);
    return rows[0] ?? null;
  }

  async getWorkspaceQuota(input: WorkspaceMonitorQuotaWindow) {
    const db = await requireDb();
    const account = await loadWorkspaceQuotaAccount(db, input.userId, false);
    if (!account) return null;
    return {
      limit: account.limit,
      used: await readWorkspaceMonitorUsed(
        db,
        workspaceMonitorProjectId(input.userId),
        input,
      ),
    };
  }

  async markSubmissionUnknown(runId: string, error: string, now: Date) {
    return this.updateAndRead(runId, {
      status: "submission_unknown",
      lastError: error,
      updatedAt: now,
    });
  }

  async markSubmissionCleanupPending(
    runId: string,
    upstreamTaskId: string,
    error: string,
    now: Date,
  ) {
    return this.updateAndRead(
      runId,
      {
        status: "submission_unknown",
        upstreamTaskId,
        lastError: error,
        updatedAt: now,
      },
      true,
    );
  }

  async markSubmissionRejected(runId: string, error: string, now: Date) {
    return this.updateAndRead(runId, {
      status: "remote_failed",
      lastError: error,
      completedAt: now,
      updatedAt: now,
    });
  }

  async markSubmitted(
    runId: string,
    input: Parameters<MonitorRepository["markSubmitted"]>[1],
  ) {
    return this.updateAndRead(runId, {
      status: "submitted",
      upstreamTaskId: input.upstreamTaskId,
      submitTotalItems: input.submitTotalItems,
      initialSubtaskIds: input.initialSubtaskIds,
      subtaskScopes: input.subtaskScopes,
      submittedAt: input.now,
      nextPollAt: new Date(input.now.getTime() + MONITOR_POLL_INTERVAL_MS),
      lastError: null,
      updatedAt: input.now,
    });
  }

  async acquirePoll(runId: string, now: Date) {
    const db = await requireDb();
    const binding = await db
      .select({ projectId: presalesMonitorRuns.projectId })
      .from(presalesMonitorRuns)
      .where(eq(presalesMonitorRuns.id, runId))
      .limit(1);
    return db.transaction(async (tx: any) => {
      if (isWebsiteMonitorProjectId(binding[0]?.projectId)) {
        await assertMonitorProjectActive(tx, binding[0].projectId);
      }
      const rows = await tx
        .select()
        .from(presalesMonitorRuns)
        .where(
          and(
            eq(presalesMonitorRuns.id, runId),
            isNull(presalesMonitorRuns.deletedAt),
          ),
        )
        .limit(1)
        .for("update");
      const run = rows[0] as PresalesMonitorRun | undefined;
      if (run?.projectId && run.projectId !== binding[0]?.projectId) {
        throw new PresalesMonitorError(
          "IDEMPOTENCY_PENDING",
          425,
          "监控项目归属刚刚更新，请稍后重试",
          1_000,
        );
      }
      if (
        !run ||
        !isMonitorPollEligible(run, now) ||
        !run.upstreamTaskId ||
        (run.nextPollAt && run.nextPollAt.getTime() > now.getTime()) ||
        (run.pollLeaseId &&
          run.pollLeaseExpiresAt &&
          run.pollLeaseExpiresAt.getTime() > now.getTime())
      ) {
        return null;
      }
      const reopening = !POLLABLE_LOCAL_STATUSES.has(run.status);
      const leaseId = randomUUID();
      const nextPollAt = new Date(now.getTime() + MONITOR_POLL_INTERVAL_MS);
      const pollLeaseExpiresAt = new Date(
        now.getTime() + MONITOR_POLL_LEASE_MS,
      );
      await tx
        .update(presalesMonitorRuns)
        .set({
          status: "polling",
          ...(reopening
            ? {
                finalResult: null,
                completedAt: null,
                lastError: null,
                terminalSnapshotHash: null,
                terminalStableCount: 0,
              }
            : {}),
          lastPollStartedAt: now,
          nextPollAt,
          pollLeaseId: leaseId,
          pollLeaseExpiresAt,
          updatedAt: now,
        })
        .where(eq(presalesMonitorRuns.id, runId));
      return {
        leaseId,
        run: {
          ...run,
          status: "polling",
          ...(reopening
            ? {
                finalResult: null,
                completedAt: null,
                lastError: null,
                terminalSnapshotHash: null,
                terminalStableCount: 0,
              }
            : {}),
          lastPollStartedAt: now,
          nextPollAt,
          pollLeaseId: leaseId,
          pollLeaseExpiresAt,
          updatedAt: now,
        },
      } satisfies MonitorPollLease;
    });
  }

  async finishPoll(
    runId: string,
    leaseId: string,
    patch: Partial<InsertPresalesMonitorRun>,
  ) {
    const db = await requireDb();
    const binding = await db
      .select({ projectId: presalesMonitorRuns.projectId })
      .from(presalesMonitorRuns)
      .where(eq(presalesMonitorRuns.id, runId))
      .limit(1);
    return db.transaction(async (tx: any) => {
      if (isWebsiteMonitorProjectId(binding[0]?.projectId)) {
        await assertMonitorProjectActive(tx, binding[0].projectId);
      }
      const rows = await tx
        .select()
        .from(presalesMonitorRuns)
        .where(eq(presalesMonitorRuns.id, runId))
        .limit(1)
        .for("update");
      const current = rows[0] as PresalesMonitorRun | undefined;
      if (!current) {
        throw new PresalesMonitorError("NOT_FOUND", 404, "监控任务不存在");
      }
      if (current.projectId && current.projectId !== binding[0]?.projectId) {
        throw new PresalesMonitorError(
          "IDEMPOTENCY_PENDING",
          425,
          "监控项目归属刚刚更新，请稍后重试",
          1_000,
        );
      }
      await tx
        .update(presalesMonitorRuns)
        .set({
          ...patch,
          pollLeaseId: null,
          pollLeaseExpiresAt: null,
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(presalesMonitorRuns.id, runId),
            eq(presalesMonitorRuns.pollLeaseId, leaseId),
            isNull(presalesMonitorRuns.deletedAt),
          ),
        );
      const updated = await tx
        .select()
        .from(presalesMonitorRuns)
        .where(eq(presalesMonitorRuns.id, runId))
        .limit(1);
      return updated[0]!;
    });
  }

  async remove(runId: string) {
    const db = await requireDb();
    const binding = await db
      .select({ projectId: presalesMonitorRuns.projectId })
      .from(presalesMonitorRuns)
      .where(eq(presalesMonitorRuns.id, runId))
      .limit(1);
    return db.transaction(async (tx: any) => {
      if (isWebsiteMonitorProjectId(binding[0]?.projectId)) {
        await assertMonitorProjectActive(tx, binding[0].projectId);
      }
      const rows = await tx
        .select({ projectId: presalesMonitorRuns.projectId })
        .from(presalesMonitorRuns)
        .where(eq(presalesMonitorRuns.id, runId))
        .limit(1)
        .for("update");
      if (rows[0]?.projectId && rows[0].projectId !== binding[0]?.projectId) {
        throw new PresalesMonitorError(
          "IDEMPOTENCY_PENDING",
          425,
          "监控项目归属刚刚更新，请稍后重试",
          1_000,
        );
      }
      await tx
        .update(presalesMonitorRuns)
        .set({
          deletedAt: new Date(),
          pollLeaseId: null,
          pollLeaseExpiresAt: null,
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(presalesMonitorRuns.id, runId),
            isNull(presalesMonitorRuns.deletedAt),
          ),
        );
      return true;
    });
  }

  private async updateAndRead(
    runId: string,
    patch: Partial<InsertPresalesMonitorRun>,
    allowInactiveCleanup = false,
  ) {
    const db = await requireDb();
    const binding = await db
      .select({ projectId: presalesMonitorRuns.projectId })
      .from(presalesMonitorRuns)
      .where(eq(presalesMonitorRuns.id, runId))
      .limit(1);
    return db.transaction(async (tx: any) => {
      if (isWebsiteMonitorProjectId(binding[0]?.projectId)) {
        if (allowInactiveCleanup) {
          const lifecycle = await tx
            .select({ status: websiteProjectDeletionTombstones.status })
            .from(websiteProjectDeletionTombstones)
            .where(
              eq(
                websiteProjectDeletionTombstones.projectId,
                binding[0].projectId,
              ),
            )
            .limit(1)
            .for("update");
          if (!lifecycle[0]) {
            await assertMonitorProjectActive(tx, binding[0].projectId);
          }
        } else {
          await assertMonitorProjectActive(tx, binding[0].projectId);
        }
      }
      const rows = await tx
        .select()
        .from(presalesMonitorRuns)
        .where(
          and(
            eq(presalesMonitorRuns.id, runId),
            isNull(presalesMonitorRuns.deletedAt),
          ),
        )
        .limit(1)
        .for("update");
      const current = rows[0] as PresalesMonitorRun | undefined;
      if (!current) {
        throw new PresalesMonitorError("NOT_FOUND", 404, "监控任务不存在");
      }
      if (current.projectId && current.projectId !== binding[0]?.projectId) {
        throw new PresalesMonitorError(
          "IDEMPOTENCY_PENDING",
          425,
          "监控项目归属刚刚更新，请稍后重试",
          1_000,
        );
      }
      await tx
        .update(presalesMonitorRuns)
        .set(patch)
        .where(
          and(
            eq(presalesMonitorRuns.id, runId),
            isNull(presalesMonitorRuns.deletedAt),
          ),
        );
      return { ...current, ...patch } as PresalesMonitorRun;
    });
  }
}

function validatedMonitorBaseUrl(raw: string, label: string) {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new PresalesMonitorError(
      "MONITOR_NOT_CONFIGURED",
      503,
      `${label}地址无效`,
    );
  }
  const loopback = new Set(["localhost", "127.0.0.1", "::1"]);
  if (
    (parsed.protocol !== "https:" &&
      !(parsed.protocol === "http:" && loopback.has(parsed.hostname))) ||
    parsed.username ||
    parsed.password ||
    parsed.search ||
    parsed.hash ||
    /[?#]/.test(raw)
  ) {
    throw new PresalesMonitorError(
      "MONITOR_NOT_CONFIGURED",
      503,
      `${label}地址必须使用安全协议且不能包含凭据、查询或片段`,
    );
  }
  return parsed.toString().replace(/\/+$/, "");
}

export function monitorBaseUrl(env: NodeJS.ProcessEnv = process.env) {
  const raw =
    env.FRONTMIND_MONITOR_API_BASE_URL?.trim() ||
    Buffer.from(DEFAULT_MONITOR_BASE_URL_B64, "base64").toString("utf8");
  return validatedMonitorBaseUrl(raw, "监控 API ");
}

export function buildMonitorRegionCatalogUrl(
  scope: MonitorRegionScope,
  env: NodeJS.ProcessEnv = process.env,
) {
  const base = new URL(monitorBaseUrl(env));
  base.pathname = base.pathname.replace(/\/+$/, "").replace(/\/[^/]*$/, "/");
  const path =
    scope === "domestic"
      ? "eip-edge/ports/city-info"
      : "eip-edge/regions/overseas";
  return new URL(path, base).toString();
}

export function buildMonitorRequestUrl(
  path: string,
  env: NodeJS.ProcessEnv = process.env,
) {
  const normalizedPath = path.replace(/^\/+/, "");
  if (!normalizedPath || /[?#\\]/.test(normalizedPath)) {
    throw new PresalesMonitorError(
      "MONITOR_NOT_CONFIGURED",
      503,
      "监控 API 请求路径无效",
    );
  }
  return new URL(normalizedPath, `${monitorBaseUrl(env)}/`).toString();
}

export type MonitorRegionCatalogRequester = (input: {
  url: string;
  timeoutMs: number;
  maxContentLength: number;
}) => Promise<{ status: number; data: unknown }>;

const requestMonitorRegionCatalog: MonitorRegionCatalogRequester = async (
  input,
) => {
  const response = await axios.request({
    method: "GET",
    url: input.url,
    headers: { Accept: "application/json" },
    timeout: input.timeoutMs,
    maxRedirects: 0,
    maxContentLength: input.maxContentLength,
    validateStatus: () => true,
  });
  return { status: response.status, data: response.data };
};

function normalizeMonitorRegionCatalog(
  scope: MonitorRegionScope,
  payload: unknown,
): PublicMonitorRegion[] {
  if (
    !isRecord(payload) ||
    payload.success !== true ||
    !Array.isArray(payload.data) ||
    payload.data.length > 1_000
  ) {
    throw new PresalesMonitorError(
      "REGION_CATALOG_UNAVAILABLE",
      503,
      "监控地区列表暂时不可用",
    );
  }
  const result: PublicMonitorRegion[] = [];
  const seen = new Set<string>();
  for (const raw of payload.data) {
    if (!isRecord(raw) || !Array.isArray(raw.regionCode)) continue;
    const label = normalizedText(
      scope === "domestic" ? raw.province : raw.name,
    );
    if (!label || label.length > 100 || raw.regionCode.length > 20) continue;
    for (const value of raw.regionCode) {
      const code = normalizedText(value);
      if (!code || code.length > 64) continue;
      const key = `${scope}:${code}`;
      if (seen.has(key)) continue;
      seen.add(key);
      result.push({
        scope,
        code,
        label: sanitizeMonitorPublicText(label).slice(0, 100),
      });
    }
  }
  if (result.length === 0) {
    throw new PresalesMonitorError(
      "REGION_CATALOG_UNAVAILABLE",
      503,
      "监控地区列表暂时不可用",
    );
  }
  return result;
}

export class AxiosMonitorRegionCatalog implements MonitorRegionCatalog {
  constructor(
    private readonly request: MonitorRegionCatalogRequester = requestMonitorRegionCatalog,
    private readonly env: NodeJS.ProcessEnv = process.env,
  ) {}

  async list(scope: MonitorRegionScope) {
    let response: { status: number; data: unknown };
    try {
      response = await this.request({
        url: buildMonitorRegionCatalogUrl(scope, this.env),
        timeoutMs: MONITOR_CATALOG_HTTP_TIMEOUT_MS,
        maxContentLength: MAX_REGION_CATALOG_BYTES,
      });
    } catch {
      throw new PresalesMonitorError(
        "REGION_CATALOG_UNAVAILABLE",
        503,
        "监控地区列表暂时不可用",
      );
    }
    if (response.status < 200 || response.status >= 300) {
      throw new PresalesMonitorError(
        "REGION_CATALOG_UNAVAILABLE",
        503,
        "监控地区列表暂时不可用",
      );
    }
    return normalizeMonitorRegionCatalog(scope, response.data);
  }
}

function safeMonitorScreenshotUrl(value: unknown) {
  const text = normalizedText(value);
  if (!text || text.length > 4_096) return undefined;
  try {
    const url = new URL(text);
    const allowedHosts = new Set(
      MONITOR_SCREENSHOT_HOSTS_B64.map((value) =>
        Buffer.from(value, "base64").toString("utf8"),
      ),
    );
    if (
      url.protocol !== "https:" ||
      !allowedHosts.has(url.hostname.toLowerCase()) ||
      url.username ||
      url.password
    ) {
      return undefined;
    }
    return url.toString();
  } catch {
    return undefined;
  }
}

export type MonitorScreenshotRequester = (input: {
  url: string;
  timeoutMs: number;
  maxContentLength: number;
}) => Promise<{
  status: number;
  data: unknown;
  headers?: Record<string, unknown>;
}>;

const requestMonitorScreenshot: MonitorScreenshotRequester = async (input) => {
  const response = await axios.request({
    method: "GET",
    url: input.url,
    headers: { Accept: "image/avif,image/webp,image/png,image/jpeg,image/gif" },
    responseType: "arraybuffer",
    timeout: input.timeoutMs,
    maxRedirects: 0,
    maxContentLength: input.maxContentLength,
    validateStatus: () => true,
  });
  return {
    status: response.status,
    data: response.data,
    headers: response.headers as Record<string, unknown>,
  };
};

export class AxiosMonitorScreenshotTransport
  implements MonitorScreenshotTransport
{
  constructor(
    private readonly request: MonitorScreenshotRequester = requestMonitorScreenshot,
  ) {}

  async fetch(rawUrl: string): Promise<MonitorScreenshotResponse> {
    const url = safeMonitorScreenshotUrl(rawUrl);
    if (!url) {
      throw new PresalesMonitorError(
        "SCREENSHOT_NOT_AVAILABLE",
        404,
        "监控截图不可用",
      );
    }
    let response: Awaited<ReturnType<MonitorScreenshotRequester>>;
    try {
      response = await this.request({
        url,
        timeoutMs: MONITOR_SCREENSHOT_HTTP_TIMEOUT_MS,
        maxContentLength: MAX_SCREENSHOT_BYTES,
      });
    } catch {
      throw new PresalesMonitorError(
        "SCREENSHOT_UPSTREAM_UNAVAILABLE",
        502,
        "监控截图暂时无法读取",
      );
    }
    if (response.status === 404 || response.status === 410) {
      throw new PresalesMonitorError(
        "SCREENSHOT_NOT_AVAILABLE",
        404,
        "监控截图不可用",
      );
    }
    if (response.status < 200 || response.status >= 300) {
      throw new PresalesMonitorError(
        "SCREENSHOT_UPSTREAM_UNAVAILABLE",
        502,
        "监控截图暂时无法读取",
      );
    }
    const contentType = normalizedText(response.headers?.["content-type"])
      .split(";", 1)[0]
      .toLowerCase();
    if (
      !["image/gif", "image/jpeg", "image/png", "image/webp"].includes(
        contentType,
      )
    ) {
      throw new PresalesMonitorError(
        "SCREENSHOT_NOT_AVAILABLE",
        404,
        "监控截图不可用",
      );
    }
    const data = Buffer.isBuffer(response.data)
      ? response.data
      : Buffer.from(response.data as ArrayBuffer);
    if (data.length === 0 || data.length > MAX_SCREENSHOT_BYTES) {
      throw new PresalesMonitorError(
        "SCREENSHOT_NOT_AVAILABLE",
        404,
        "监控截图不可用",
      );
    }
    return {
      contentType: contentType as MonitorScreenshotResponse["contentType"],
      data,
    };
  }
}

export class AxiosMonitorTransport implements MonitorTransport {
  private async request(
    method: "POST" | "GET" | "PUT",
    path: string,
    credential: DecryptedPresalesCredential,
    payload?: unknown,
  ) {
    let response;
    try {
      response = await axios.request({
        method,
        url: buildMonitorRequestUrl(path),
        data: payload,
        headers: {
          Authorization: `Bearer ${credential.apiKey}`,
          Accept: "application/json",
          ...(method === "GET" ? {} : { "Content-Type": "application/json" }),
        },
        timeout: MONITOR_HTTP_TIMEOUT_MS,
        maxRedirects: 0,
        maxContentLength: MAX_MONITOR_RESPONSE_BYTES,
        maxBodyLength: 64 * 1024,
        validateStatus: () => true,
      });
    } catch (error) {
      throw new MonitorRemoteError(
        sanitizeMonitorErrorText(
          error instanceof Error ? error.message : undefined,
          credential.apiKey,
          "监控接口网络请求失败",
        ),
        true,
      );
    }
    const message = sanitizeMonitorErrorText(
      isRecord(response.data) ? response.data.message : undefined,
      credential.apiKey,
      `监控接口返回 HTTP ${response.status}`,
    );
    const stopAlreadyTerminal =
      method === "PUT" &&
      (response.status === 404 ||
        /(?:completed|finished|stopped|not found|已完成|已结束|已停止|不存在)/iu.test(
          message,
        ));
    if (response.status < 200 || response.status >= 300) {
      if (stopAlreadyTerminal) return { success: true, alreadyTerminal: true };
      throw new MonitorRemoteError(
        message,
        [408, 425, 429, 500, 502, 503, 504].includes(response.status),
      );
    }
    if (!isRecord(response.data) || response.data.success !== true) {
      if (stopAlreadyTerminal) return { success: true, alreadyTerminal: true };
      // A malformed/empty or generic failure response does not prove that a
      // POST was rejected: the provider may have accepted it before losing
      // the response envelope. Only a credential rejection with no task
      // identity is safe to retry after credential rotation.
      throw new MonitorRemoteError(
        message,
        !monitorResponseExplicitlyRejectsSubmission(response.data),
      );
    }
    return redactExactSecret(response.data, credential.apiKey);
  }

  submit(
    payload: ReturnType<typeof buildMonitorSubmitPayload>,
    credential: DecryptedPresalesCredential,
  ) {
    return this.request("POST", "/task/batch/shared", credential, payload);
  }

  status(taskId: string, credential: DecryptedPresalesCredential) {
    return this.request(
      "GET",
      `/task/status/${encodeURIComponent(taskId)}`,
      credential,
    );
  }

  result(taskId: string, credential: DecryptedPresalesCredential) {
    return this.request(
      "GET",
      `/task/result/${encodeURIComponent(taskId)}`,
      credential,
    );
  }

  stop(taskId: string, credential: DecryptedPresalesCredential) {
    return this.request(
      "PUT",
      `/task/${encodeURIComponent(taskId)}/stop`,
      credential,
    );
  }
}

type MonitorPurgeTarget = Pick<
  PresalesMonitorRun,
  | "id"
  | "projectId"
  | "apiCredentialId"
  | "credentialVersion"
  | "status"
  | "upstreamTaskId"
  | "createdAt"
>;

function monitorPurgeWhere(projectId: string, runIds: readonly string[]) {
  return runIds.length > 0
    ? inArray(presalesMonitorRuns.id, [...runIds])
    : eq(presalesMonitorRuns.projectId, projectId);
}

async function lockMonitorProjectDeletion(tx: any, projectId: string) {
  const lifecycle = await tx
    .select({ status: websiteProjectDeletionTombstones.status })
    .from(websiteProjectDeletionTombstones)
    .where(eq(websiteProjectDeletionTombstones.projectId, projectId))
    .limit(1)
    .for("update");
  if (!lifecycle[0] || lifecycle[0].status === "active") {
    throw new PresalesMonitorError(
      "PROJECT_NOT_DELETING",
      409,
      "项目尚未进入永久删除流程",
    );
  }
}

function assertMonitorPurgeOwnership(
  projectId: string,
  rows: readonly MonitorPurgeTarget[],
) {
  if (rows.some((row) => row.projectId && row.projectId !== projectId)) {
    throw new PresalesMonitorError(
      "MONITOR_PROJECT_CONFLICT",
      409,
      "监控任务属于另一个项目",
    );
  }
}

function monitorSubmissionStillInFlight(row: MonitorPurgeTarget, now: Date) {
  return (
    !row.upstreamTaskId &&
    !TERMINAL_LOCAL_STATUSES.has(row.status) &&
    row.createdAt.getTime() + MONITOR_SUBMISSION_DELETE_GRACE_MS > now.getTime()
  );
}

/**
 * Stops every known non-terminal provider task before physically deleting its
 * local project row. Explicit run IDs cover legacy rows created before the
 * projectId lineage column existed; a row already owned by another project is
 * never accepted. A fresh submission with no provider ID remains retryable
 * until its bounded HTTP request window has elapsed.
 */
export async function purgePresalesProjectMonitorRuns(
  input: { projectId: string; runIds?: readonly string[] },
  options: {
    executor?: any;
    transport?: MonitorTransport;
    credentialById?: (
      id: string,
    ) => Promise<DecryptedPresalesCredential | null>;
    now?: () => Date;
  } = {},
) {
  assertWebsiteProjectPhysicalDeleteEnabled();
  const db = options.executor ?? (await requireDb());
  const transport = options.transport ?? new AxiosMonitorTransport();
  const credentialById = options.credentialById ?? getMonitorCredentialById;
  const now = options.now ?? (() => new Date());
  const runIds = [...new Set(input.runIds ?? [])];
  const snapshot = await db.transaction(async (tx: any) => {
    await lockMonitorProjectDeletion(tx, input.projectId);
    const rows = (await tx
      .select({
        id: presalesMonitorRuns.id,
        projectId: presalesMonitorRuns.projectId,
        apiCredentialId: presalesMonitorRuns.apiCredentialId,
        credentialVersion: presalesMonitorRuns.credentialVersion,
        status: presalesMonitorRuns.status,
        upstreamTaskId: presalesMonitorRuns.upstreamTaskId,
        createdAt: presalesMonitorRuns.createdAt,
      })
      .from(presalesMonitorRuns)
      .where(monitorPurgeWhere(input.projectId, runIds))
      .for("update")) as MonitorPurgeTarget[];
    assertMonitorPurgeOwnership(input.projectId, rows);
    return rows;
  });

  const stopped = new Set<string>();
  for (const row of snapshot) {
    if (!row.upstreamTaskId) continue;
    const credential = await credentialById(row.apiCredentialId);
    if (!credential || credential.version !== row.credentialVersion) {
      throw new PresalesMonitorError(
        "MONITOR_CREDENTIAL_UNAVAILABLE",
        503,
        "监控任务的 API Key 版本不可用，无法停止上游任务",
      );
    }
    try {
      await transport.stop(row.upstreamTaskId, credential);
    } catch (error) {
      throw new PresalesMonitorError(
        "MONITOR_STOP_FAILED",
        502,
        error instanceof Error
          ? safeError(error.message, "上游监控任务停止失败")
          : "上游监控任务停止失败",
      );
    }
    stopped.add(`${row.id}:${row.upstreamTaskId}`);
  }

  return db.transaction(async (tx: any) => {
    await lockMonitorProjectDeletion(tx, input.projectId);
    const current = (await tx
      .select({
        id: presalesMonitorRuns.id,
        projectId: presalesMonitorRuns.projectId,
        apiCredentialId: presalesMonitorRuns.apiCredentialId,
        credentialVersion: presalesMonitorRuns.credentialVersion,
        status: presalesMonitorRuns.status,
        upstreamTaskId: presalesMonitorRuns.upstreamTaskId,
        createdAt: presalesMonitorRuns.createdAt,
      })
      .from(presalesMonitorRuns)
      .where(monitorPurgeWhere(input.projectId, runIds))
      .for("update")) as MonitorPurgeTarget[];
    assertMonitorPurgeOwnership(input.projectId, current);

    const deleteIds: string[] = [];
    let pendingRuns = 0;
    const currentTime = now();
    for (const row of current) {
      if (monitorSubmissionStillInFlight(row, currentTime)) {
        pendingRuns += 1;
        continue;
      }
      if (
        row.upstreamTaskId &&
        !stopped.has(`${row.id}:${row.upstreamTaskId}`)
      ) {
        // The provider ID arrived after the initial snapshot. Keep it so the
        // next idempotent project-delete attempt can stop that exact task.
        pendingRuns += 1;
        continue;
      }
      deleteIds.push(row.id);
    }
    if (deleteIds.length > 0) {
      await tx
        .delete(presalesMonitorRuns)
        .where(inArray(presalesMonitorRuns.id, deleteIds));
    }
    return { deletedRuns: deleteIds.length, pendingRuns };
  });
}

function redactExactSecret(value: unknown, secret: string, depth = 0): unknown {
  if (depth > 40) return "[truncated]";
  if (typeof value === "string") {
    return secret && value.includes(secret)
      ? value.split(secret).join("[redacted]")
      : value;
  }
  if (Array.isArray(value)) {
    return value.map((item) => redactExactSecret(item, secret, depth + 1));
  }
  if (!isRecord(value)) return value;
  const output: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value)) {
    if (["authorization", "apiKey", "api_key"].includes(key)) continue;
    output[key] = redactExactSecret(child, secret, depth + 1);
  }
  return output;
}

export class PresalesMonitorService {
  constructor(
    private readonly repository: MonitorRepository = new DrizzleMonitorRepository(),
    private readonly transport: MonitorTransport = new AxiosMonitorTransport(),
    private readonly activeCredential: () => Promise<DecryptedPresalesCredential | null> = getActiveMonitorCredential,
    private readonly credentialById: (
      id: string,
    ) => Promise<DecryptedPresalesCredential | null> = getMonitorCredentialById,
    private readonly now: () => Date = () => new Date(),
    private readonly regionCatalog: MonitorRegionCatalog = new AxiosMonitorRegionCatalog(),
    private readonly screenshotTransport: MonitorScreenshotTransport = new AxiosMonitorScreenshotTransport(),
  ) {}

  async create(rawInput: unknown) {
    return this.createMonitor(monitorCreateSchema.parse(rawInput));
  }

  async createForWorkspace(input: {
    userId: number;
    question: string;
    idempotencyKey: string;
    reservationAt: Date;
    windowStartedAt: Date;
    windowEndsAt: Date;
  }) {
    const projectId = workspaceMonitorProjectId(input.userId);
    const parsed = monitorCreateSchema.parse({
      question: input.question,
      platforms: ["chatgpt"],
      idempotencyKey: input.idempotencyKey,
      projectId,
    });
    const reservationAt = new Date(input.reservationAt.getTime());
    const windowStartedAt = new Date(input.windowStartedAt.getTime());
    const windowEndsAt = new Date(input.windowEndsAt.getTime());
    if (
      !Number.isFinite(reservationAt.getTime()) ||
      !Number.isFinite(windowStartedAt.getTime()) ||
      !Number.isFinite(windowEndsAt.getTime()) ||
      windowStartedAt.getTime() >= windowEndsAt.getTime() ||
      reservationAt.getTime() < windowStartedAt.getTime() ||
      reservationAt.getTime() >= windowEndsAt.getTime()
    ) {
      throw new PresalesMonitorError(
        "INVALID_REQUEST",
        400,
        "品牌追踪额度周期或预留时间无效",
      );
    }
    return this.createMonitor(parsed, {
      reservationAt,
      workspaceQuota: {
        userId: input.userId,
        windowStartedAt,
        windowEndsAt,
      },
    });
  }

  async getWorkspaceQuota(input: WorkspaceMonitorQuotaWindow) {
    return this.repository.getWorkspaceQuota(input);
  }

  async regions(scope: MonitorRegionScope) {
    return this.regionCatalog.list(scope);
  }

  async latestForWorkspace(userId: number) {
    const projectId = workspaceMonitorProjectId(userId);
    const run = await this.repository.getLatestByProject(projectId);
    if (!run) return null;
    if (run.projectId !== projectId) {
      throw new PresalesMonitorError("NOT_FOUND", 404, "监控任务不存在");
    }
    return publicMonitorRun(await this.refreshIfDue(run), true);
  }

  async getForWorkspace(userId: number, runId: string) {
    const run = await this.refreshIfDue(
      await this.requireWorkspaceRun(userId, runId),
    );
    return publicMonitorRun(run, false);
  }

  async resultForWorkspace(userId: number, runId: string) {
    const run = await this.refreshIfDue(
      await this.requireWorkspaceRun(userId, runId),
    );
    return publicMonitorRun(run, true);
  }

  private async createMonitor(
    input: MonitorCreateInput,
    workspaceContext?: {
      reservationAt: Date;
      workspaceQuota: WorkspaceMonitorQuotaWindow;
    },
  ) {
    const platforms = [...input.platforms];
    const expectedItems = platforms.length * MONITOR_REPEAT_PER_PLATFORM;
    const idempotencyKeyHash = sha256(input.idempotencyKey);
    const consumerTaskId = monitorConsumerTaskId(idempotencyKeyHash);
    const screenshot = input.screenshot ?? 0;
    let region: MonitorRequestRegion | undefined;
    if (input.region) {
      const regions = await this.regionCatalog.list(input.region.scope);
      region = regions.find((item) => item.code === input.region!.code);
      if (!region) {
        throw new PresalesMonitorError(
          "REGION_UNAVAILABLE",
          422,
          "所选监控地区已不可用，请刷新地区列表后重试",
        );
      }
    }
    const credential = await this.activeCredential();
    if (!credential) {
      throw new PresalesMonitorError(
        "INVALID_CREDENTIAL",
        428,
        "FrontMind 监控服务暂未启用，请联系技术人员",
      );
    }
    const checkpoint = initialMonitorCheckpoint({
      consumerTaskId,
      monitorKeyword: input.monitorKeyword,
      screenshot,
      region,
    });
    const reservation = await this.repository.reserve({
      projectId: input.projectId,
      idempotencyKeyHash,
      requestHash: requestHash({
        projectId: input.projectId,
        question: input.question,
        platforms,
        monitorKeyword: input.monitorKeyword,
        screenshot,
        region,
      }),
      compatibleRequestHashes:
        input.projectId && !workspaceContext
          ? [
              requestHash({
                question: input.question,
                platforms,
                monitorKeyword: input.monitorKeyword,
                screenshot,
                region,
              }),
            ]
          : [],
      credential,
      question: input.question,
      platforms,
      expectedItems,
      checkpoint,
      now: workspaceContext?.reservationAt ?? this.now(),
      workspaceQuota: workspaceContext?.workspaceQuota,
    });
    if (reservation.state === "replay") {
      if (
        reservation.run.status === "remote_failed" &&
        !reservation.run.upstreamTaskId
      ) {
        throw new PresalesMonitorError(
          "MONITOR_SUBMISSION_REJECTED",
          502,
          "监控服务已明确拒绝本次提交，未创建任务；修复服务配置后可安全重试",
        );
      }
      return { replayed: true, run: publicMonitorRun(reservation.run, false) };
    }

    const payload = buildMonitorSubmitPayload({
      question: input.question,
      platforms,
      consumerTaskId,
      monitorKeyword: input.monitorKeyword,
      screenshot,
      region,
    });
    let validated: ReturnType<typeof validateMonitorSubmitResponse>;
    try {
      const response = await this.transport.submit(payload, credential);
      validated = validateMonitorSubmitResponse(response, {
        question: input.question,
        platforms,
        expectedItems,
      });
    } catch (error) {
      const message =
        error instanceof Error
          ? safeError(error.message, "监控提交结果未知")
          : "监控提交结果未知";
      if (error instanceof MonitorRemoteError && !error.recoverable) {
        await this.repository.markSubmissionRejected(
          reservation.run.id,
          message,
          this.now(),
        );
        throw new PresalesMonitorError(
          "MONITOR_SUBMISSION_REJECTED",
          502,
          "监控服务已明确拒绝本次提交，未创建任务；修复服务配置后可安全重试",
        );
      }
      await this.repository.markSubmissionUnknown(
        reservation.run.id,
        message,
        this.now(),
      );
      throw new PresalesMonitorError(
        "MONITOR_SUBMISSION_UNKNOWN",
        502,
        "监控任务可能已提交，但无法确认任务 ID；请使用相同幂等键安全重试",
      );
    }

    try {
      const run = await this.repository.markSubmitted(reservation.run.id, {
        upstreamTaskId: validated.taskId,
        submitTotalItems: validated.totalTask,
        initialSubtaskIds: validated.initialSubtaskIds,
        subtaskScopes: validated.subtaskScopes,
        now: this.now(),
      });
      return { replayed: false, run: publicMonitorRun(run, false) };
    } catch (error) {
      const message =
        error instanceof Error
          ? safeError(error.message, "监控任务本地登记失败")
          : "监控任务本地登记失败";
      try {
        await this.transport.stop(validated.taskId, credential);
        try {
          await this.repository.markSubmissionRejected(
            reservation.run.id,
            message,
            this.now(),
          );
        } catch {
          // A concurrent project purge may already have physically removed
          // the reservation. The known provider task has still been stopped.
        }
        throw new PresalesMonitorError(
          "PROJECT_DELETED",
          410,
          "项目已进入永久删除流程，监控任务已停止",
        );
      } catch (stopError) {
        if (
          stopError instanceof PresalesMonitorError &&
          stopError.code === "PROJECT_DELETED"
        ) {
          throw stopError;
        }
        try {
          await this.repository.markSubmissionCleanupPending(
            reservation.run.id,
            validated.taskId,
            message,
            this.now(),
          );
        } catch {
          // The project fence still prevents replay even when the row was
          // concurrently removed after its bounded submission grace window.
        }
        throw new PresalesMonitorError(
          "MONITOR_STOP_FAILED",
          502,
          "监控任务已创建但停止失败，请稍后重试项目删除",
        );
      }
    }
  }

  async get(runId: string) {
    const run = await this.refreshIfDue(await this.requireRun(runId));
    return publicMonitorRun(run, false);
  }

  async result(runId: string) {
    const run = await this.refreshIfDue(await this.requireRun(runId));
    return publicMonitorRun(run, true);
  }

  async screenshot(runId: string, recordId: string) {
    if (!/^mr_[a-f0-9]{24}$/.test(recordId)) {
      throw new PresalesMonitorError(
        "SCREENSHOT_NOT_AVAILABLE",
        404,
        "监控截图不可用",
      );
    }
    const run = await this.requireRun(runId);
    const checkpoint = monitorCheckpoint(run.checkpoint);
    if (checkpoint.request?.screenshot !== 1) {
      throw new PresalesMonitorError(
        "SCREENSHOT_NOT_AVAILABLE",
        404,
        "监控截图不可用",
      );
    }
    const item = checkpoint.items.find(
      (candidate) => publicRecordId(run.id, candidate.subTaskId) === recordId,
    );
    const url = safeMonitorScreenshotUrl(item?.pageScreenshot);
    if (!url) {
      throw new PresalesMonitorError(
        "SCREENSHOT_NOT_AVAILABLE",
        404,
        "监控截图不可用",
      );
    }
    return this.screenshotTransport.fetch(url);
  }

  async remove(runId: string) {
    await this.requireRun(runId);
    await this.repository.remove(runId);
  }

  private async requireRun(runId: string) {
    if (!/^[0-9a-f-]{36}$/i.test(runId)) {
      throw new PresalesMonitorError("NOT_FOUND", 404, "监控任务不存在");
    }
    const run = await this.repository.get(runId);
    if (!run)
      throw new PresalesMonitorError("NOT_FOUND", 404, "监控任务不存在");
    return run;
  }

  private async requireWorkspaceRun(userId: number, runId: string) {
    const run = await this.requireRun(runId);
    if (run.projectId !== workspaceMonitorProjectId(userId)) {
      throw new PresalesMonitorError("NOT_FOUND", 404, "监控任务不存在");
    }
    return run;
  }

  private async refreshIfDue(run: PresalesMonitorRun) {
    const pollStartedAt = this.now();
    if (!isMonitorPollEligible(run, pollStartedAt)) return run;
    if (!POLLABLE_LOCAL_STATUSES.has(run.status)) {
      const recoveryCredential = await this.credentialById(run.apiCredentialId);
      if (
        !recoveryCredential ||
        recoveryCredential.version !== run.credentialVersion
      ) {
        return run;
      }
    }
    const lease = await this.repository.acquirePoll(run.id, pollStartedAt);
    if (!lease) return (await this.repository.get(run.id)) ?? run;
    const credential = await this.credentialById(lease.run.apiCredentialId);
    if (!credential || credential.version !== lease.run.credentialVersion) {
      return this.repository.finishPoll(run.id, lease.leaseId, {
        status: "remote_failed",
        remoteStatus: "credential_changed",
        lastError: "创建任务时使用的监控凭据已变更，任务已停止自动查询",
        completedAt: this.now(),
      });
    }

    try {
      const statusPayload = await this.transport.status(
        String(lease.run.upstreamTaskId),
        credential,
      );
      const status = statusData(statusPayload, lease.run);
      const recoveryDeadline = monitorRecoveryDeadline(lease.run);
      const recoveryExpired = Boolean(
        recoveryDeadline &&
          pollStartedAt.getTime() >= recoveryDeadline.getTime(),
      );
      const existingCheckpoint = monitorCheckpoint(lease.run.checkpoint);
      const statusChanged =
        status.remoteStatus !==
          normalizedText(lease.run.remoteStatus).toLowerCase() ||
        status.totalItems !== lease.run.totalItems ||
        status.completedItems !== lease.run.completedItems ||
        status.failedItems !== lease.run.failedItems;
      const shouldFetchResult =
        statusChanged ||
        MAIN_FINAL_STATUSES.has(status.remoteStatus) ||
        recoveryExpired ||
        existingCheckpoint.items.length === 0;
      if (!shouldFetchResult) {
        return this.repository.finishPoll(run.id, lease.leaseId, {
          status: "polling",
          remoteStatus: status.remoteStatus,
          totalItems: status.totalItems,
          completedItems: status.completedItems,
          failedItems: status.failedItems,
          lastError: null,
        });
      }

      const resultPayload = await this.transport.result(
        String(lease.run.upstreamTaskId),
        credential,
      );
      const snapshot = normalizeResultSnapshot(resultPayload, lease.run);
      const checkpoint = mergeCheckpoints(
        lease.run.checkpoint,
        snapshot.checkpoint,
      );
      const initialIds = new Set(jsonStringArray(lease.run.initialSubtaskIds));
      const checkpointIds = new Set(
        checkpoint.items.map((item) => item.subTaskId),
      );
      const exactIds =
        checkpointIds.size === initialIds.size &&
        [...checkpointIds].every((id) => initialIds.has(id));
      const remoteTerminal =
        MAIN_FINAL_STATUSES.has(status.remoteStatus) &&
        MAIN_FINAL_STATUSES.has(snapshot.remoteStatus);
      const progress = checkpointProgress(lease.run, checkpoint);
      const complete =
        remoteTerminal &&
        exactIds &&
        checkpoint.items.length === lease.run.expectedItems &&
        progress.successfulItems === lease.run.expectedItems;
      const signature = checkpointSignature(checkpoint);
      const stableCount =
        remoteTerminal && signature === lease.run.terminalSnapshotHash
          ? lease.run.terminalStableCount + 1
          : remoteTerminal
            ? 1
            : 0;
      if (complete) {
        const finalResult = buildFinalResult(lease.run, checkpoint, false);
        return this.repository.finishPoll(run.id, lease.leaseId, {
          status: "completed",
          remoteStatus: snapshot.remoteStatus || status.remoteStatus,
          totalItems: status.totalItems,
          completedItems: progress.successfulItems,
          failedItems: Math.max(
            progress.failedItems,
            lease.run.expectedItems - progress.successfulItems,
          ),
          checkpoint,
          finalResult,
          terminalSnapshotHash: signature,
          terminalStableCount: stableCount,
          lastError: null,
          completedAt: this.now(),
        });
      }
      const hardRemoteStatus = ["stopped", "failed"].find(
        (candidate) =>
          status.remoteStatus === candidate ||
          snapshot.remoteStatus === candidate,
      );
      const hardRemoteTerminal = remoteTerminal && Boolean(hardRemoteStatus);
      if (recoveryExpired || (hardRemoteTerminal && stableCount >= 2)) {
        const completedAt = this.now();
        const terminalCheckpoint = finalizeIncompleteCheckpoint(
          lease.run,
          checkpoint,
          completedAt,
        );
        const terminalProgress = checkpointProgress(
          lease.run,
          terminalCheckpoint,
        );
        const finalResult = buildFinalResult(
          lease.run,
          terminalCheckpoint,
          true,
        );
        return this.repository.finishPoll(run.id, lease.leaseId, {
          status:
            terminalProgress.successfulItems > 0
              ? "partial_review_required"
              : "remote_failed",
          remoteStatus:
            hardRemoteStatus ?? snapshot.remoteStatus ?? status.remoteStatus,
          totalItems: status.totalItems,
          completedItems: terminalProgress.successfulItems,
          failedItems: Math.max(
            terminalProgress.failedItems,
            lease.run.expectedItems - terminalProgress.successfulItems,
          ),
          checkpoint: terminalCheckpoint,
          finalResult,
          terminalSnapshotHash: checkpointSignature(terminalCheckpoint),
          terminalStableCount: stableCount,
          lastError:
            terminalProgress.successfulItems > 0
              ? "自动补采窗口结束，仍有回答未成功返回"
              : "监控任务没有返回成功文字答案",
          completedAt,
        });
      }
      return this.repository.finishPoll(run.id, lease.leaseId, {
        status: "polling",
        remoteStatus: snapshot.remoteStatus || status.remoteStatus,
        totalItems: status.totalItems,
        completedItems: progress.successfulItems,
        failedItems: progress.failedItems,
        checkpoint,
        terminalSnapshotHash: remoteTerminal ? signature : null,
        terminalStableCount: stableCount,
        lastError: null,
      });
    } catch (error) {
      if (error instanceof PresalesMonitorError) {
        return this.repository.finishPoll(run.id, lease.leaseId, {
          status: "shape_mismatch",
          shapeMismatch: true,
          lastError: error.message,
          completedAt: this.now(),
        });
      }
      if (error instanceof MonitorRemoteError && error.recoverable) {
        return this.repository.finishPoll(run.id, lease.leaseId, {
          status: "polling",
          lastError: error.message,
        });
      }
      return this.repository.finishPoll(run.id, lease.leaseId, {
        status: "remote_failed",
        remoteStatus: "failed",
        lastError:
          error instanceof Error
            ? safeError(error.message)
            : "监控接口返回不可恢复错误",
        completedAt: this.now(),
      });
    }
  }
}

function sendMonitorError(res: Response, error: unknown) {
  if (error instanceof z.ZodError) {
    res.status(400).json({
      error: {
        code: "INVALID_REQUEST",
        message: error.issues[0]?.message ?? "Invalid request",
      },
    });
    return;
  }
  if (error instanceof PresalesMonitorError) {
    if (error.retryAfterMs) {
      res.setHeader(
        "Retry-After",
        String(Math.ceil(error.retryAfterMs / 1_000)),
      );
    }
    res.status(error.status).json({
      error: { code: error.code, message: error.message },
    });
    return;
  }
  console.error(
    "[Presales Monitor] Request failed:",
    error instanceof Error ? error.name : "Unknown error",
  );
  res.status(502).json({
    error: {
      code: "MONITOR_UPSTREAM_ERROR",
      message: "监控服务请求失败",
    },
  });
}

export function createPresalesMonitorRouter(
  service = new PresalesMonitorService(),
) {
  const router = Router();
  const parser = json({ limit: "32kb" });

  router.get("/regions", async (req, res) => {
    res.setHeader("Cache-Control", "no-store");
    try {
      const parsedScope = z
        .enum(["domestic", "overseas"])
        .safeParse(req.query.scope);
      if (!parsedScope.success) {
        throw new PresalesMonitorError(
          "INVALID_REQUEST",
          400,
          "必须指定 domestic 或 overseas 地区范围",
        );
      }
      const regions = await service.regions(parsedScope.data);
      res.json({
        scope: parsedScope.data,
        regions: regions.map(({ code, label }) => ({ code, label })),
      });
    } catch (error) {
      sendMonitorError(res, error);
    }
  });

  router.post("/", parser, async (req, res) => {
    try {
      const outcome = await service.create(req.body ?? {});
      if (outcome.replayed) res.setHeader("Idempotent-Replayed", "true");
      const pending = ["submission_in_progress", "submission_unknown"].includes(
        outcome.run.status,
      );
      res.status(outcome.replayed ? (pending ? 202 : 200) : 201).json({
        run: outcome.run,
      });
    } catch (error) {
      sendMonitorError(res, error);
    }
  });

  router.get("/:runId", async (req, res) => {
    try {
      res.json({ run: await service.get(String(req.params.runId || "")) });
    } catch (error) {
      sendMonitorError(res, error);
    }
  });

  router.get("/:runId/result", async (req, res) => {
    try {
      const run = await service.result(String(req.params.runId || ""));
      const pending = POLLABLE_LOCAL_STATUSES.has(run.status);
      res.status(pending ? 202 : 200).json({ run });
    } catch (error) {
      sendMonitorError(res, error);
    }
  });

  router.get("/:runId/records/:recordId/screenshot", async (req, res) => {
    res.setHeader("Cache-Control", "private, no-store");
    res.setHeader("X-Content-Type-Options", "nosniff");
    try {
      const screenshot = await service.screenshot(
        String(req.params.runId || ""),
        String(req.params.recordId || ""),
      );
      res.type(screenshot.contentType).status(200).send(screenshot.data);
    } catch (error) {
      sendMonitorError(res, error);
    }
  });

  router.delete("/:runId", async (req, res) => {
    try {
      await service.remove(String(req.params.runId || ""));
      res.status(204).end();
    } catch (error) {
      sendMonitorError(res, error);
    }
  });

  return router;
}

export const presalesMonitorRouter = createPresalesMonitorRouter();
