import { createHash, randomUUID } from "node:crypto";
import { isIP } from "node:net";
import axios from "axios";
import { and, eq, isNull } from "drizzle-orm";
import { json, Router, type Response } from "express";
import { z } from "zod";

import {
  presalesMonitorRuns,
  type InsertPresalesMonitorRun,
  type PresalesMonitorRun,
} from "../drizzle/schema";
import { getDb } from "./db";
import {
  getActivePresalesCredential,
  getPresalesCredentialById,
  type DecryptedPresalesCredential,
} from "./presales-service";

export const MONITOR_PLATFORMS = [
  "doubao",
  "yuanbao",
  "deepseek",
  "baiduai",
  "qianwen",
  "kimi",
] as const;
export type MonitorPlatform = (typeof MONITOR_PLATFORMS)[number];

const UPSTREAM_MONITOR_PLATFORM_IDS: Record<MonitorPlatform, string> = {
  doubao: "doubao",
  yuanbao: "yuanbao",
  deepseek: "deepseek",
  baiduai: "baiduai",
  qianwen: "qianwen",
  kimi: "kimi",
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
const MAX_MONITOR_RESPONSE_BYTES = 12 * 1024 * 1024;
const MAX_ANSWER_CHARACTERS = 200_000;
const MAX_SOURCE_ITEMS = 200;
const MAX_EVIDENCE_CANDIDATES = 2_000;
const MAX_MEDIA_ITEMS = 24;
const DEFAULT_MONITOR_BASE_URL_B64 =
  "aHR0cHM6Ly9idXNpbmVzcy1hcGkubW9saXpoaXNodS5jb20vYXBpL2J1c2luZXNzL21vbml0b3I=";
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
  })
  .strict();

export type MonitorCreateInput = z.infer<typeof monitorCreateSchema>;

type MonitorScope = { platform: MonitorPlatform; runIndex: number };
type MonitorEvidence =
  | string
  | {
      index?: number;
      title?: string;
      name?: string;
      url?: string;
      source?: string;
      domain?: string;
      summary?: string;
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
  /** Legacy checkpoint fields are read only when recovering pre-v2 runs. */
  citations?: MonitorEvidence[];
  references?: MonitorEvidence[];
  error?: string;
  completedAt?: string;
};

type MonitorCheckpoint = {
  items: MonitorCheckpointItem[];
};

export type PublicMonitorRecord = {
  recordId: string;
  platform: MonitorPlatform;
  runIndex: number;
  status: string;
  answerText?: string;
  media: MonitorMedia[];
  sources: MonitorEvidence[];
  error?: string;
  completedAt?: string;
};

export type PublicMonitorRun = {
  runId: string;
  status: PresalesMonitorRun["status"];
  question: string;
  platforms: MonitorPlatform[];
  repeatPerPlatform: 5;
  expectedItems: number;
  completedItems: number;
  failedItems: number;
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

class MonitorRemoteError extends Error {
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
}

export type MonitorReservation =
  | { state: "acquired"; run: PresalesMonitorRun }
  | { state: "replay"; run: PresalesMonitorRun };

export type MonitorPollLease = {
  run: PresalesMonitorRun;
  leaseId: string;
};

export interface MonitorRepository {
  reserve(input: {
    idempotencyKeyHash: string;
    requestHash: string;
    credential: DecryptedPresalesCredential;
    question: string;
    platforms: MonitorPlatform[];
    expectedItems: number;
    now: Date;
  }): Promise<MonitorReservation>;
  get(runId: string): Promise<PresalesMonitorRun | null>;
  markSubmissionUnknown(
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
}) {
  return {
    prompts: Array.from(
      { length: MONITOR_REPEAT_PER_PLATFORM },
      () => input.question,
    ),
    platforms: input.platforms.map((platform) => ({
      platform: toUpstreamMonitorPlatform(platform),
      mode: "search" as const,
      screenshot: 0 as const,
    })),
  };
}

function requestHash(input: {
  question: string;
  platforms: readonly MonitorPlatform[];
}) {
  return sha256(
    canonicalJson({
      schema: "frontmind-presales-monitor-v1",
      payload: buildMonitorSubmitPayload(input),
    }),
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function normalizedText(value: unknown) {
  return typeof value === "string" ? value.trim() : "";
}

function inlineCitationPattern() {
  return /\uE3A0cite\uE3A3web_search:[0-9]+#([0-9]{1,9})\uE3A8/gi;
}

function inlineCitationIndexes(value: unknown): number[] {
  if (typeof value !== "string") return [];
  const indexes: number[] = [];
  const seen = new Set<number>();
  for (const match of value.matchAll(inlineCitationPattern())) {
    const index = Number.parseInt(match[1], 10);
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
      if (index !== null) object.index = index;
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
      const rawUrl = normalizedText(entry.url ?? entry.href ?? entry.link);
      if (title)
        object.title = sanitizeMonitorPublicText(title).slice(0, 1_000);
      if (source)
        object.source = sanitizeMonitorPublicText(source).slice(0, 1_000);
      if (domain)
        object.domain = sanitizeMonitorPublicText(domain).slice(0, 255);
      if (summary)
        object.summary = sanitizeMonitorPublicText(summary).slice(0, 2_000);
      if (rawUrl) {
        const url = normalizeMonitorSourceUrl(rawUrl);
        if (!url) continue;
        object.url = url;
      }
      if (
        object.title ||
        object.source ||
        object.domain ||
        object.summary ||
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
  const canonicalPositions = new Map<string, number>();
  const indexes = new Set<number>();
  const urlPositions = new Map<string, number>();
  for (const item of [...primary, ...explicitInline]) {
    const canonicalKey = canonicalJson(item);
    const index = typeof item === "string" ? null : (item.index ?? null);
    const url = typeof item === "string" ? "" : (item.url ?? "");
    const duplicatePosition =
      canonicalPositions.get(canonicalKey) ??
      (url ? urlPositions.get(url) : undefined);
    if (duplicatePosition !== undefined) {
      result[duplicatePosition] = mergeMonitorEvidenceItem(
        result[duplicatePosition],
        item,
      );
      continue;
    }
    if (index !== null && indexes.has(index)) continue;
    const position = result.length;
    canonicalPositions.set(canonicalKey, position);
    if (index !== null) indexes.add(index);
    if (url) urlPositions.set(url, position);
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
  const title = (item.title || item.name || item.source || "")
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
    domain: preferred.domain ?? secondary.domain,
    summary: preferred.summary ?? secondary.summary,
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

function checkpointItemSources(item: MonitorCheckpointItem) {
  if (Object.prototype.hasOwnProperty.call(item, "sources")) {
    return mergeUnifiedSources(
      sanitizeEvidence(item.sources, MAX_EVIDENCE_CANDIDATES),
    );
  }
  return mergeUnifiedSources(
    sanitizeEvidence(item.citations, MAX_EVIDENCE_CANDIDATES),
    sanitizeEvidence(item.references, MAX_EVIDENCE_CANDIDATES),
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
  knownInlineCitationIndexes?: ReadonlySet<number>,
): string {
  if (typeof value !== "string") return "";
  let text = value.slice(0, MAX_ANSWER_CHARACTERS * 2);
  text = text
    .replace(inlineCitationPattern(), (_marker, indexText: string) => {
      const index = Number.parseInt(indexText, 10);
      if (
        knownInlineCitationIndexes &&
        !knownInlineCitationIndexes.has(index)
      ) {
        return " ";
      }
      return `〔来源 ${index}〕`;
    })
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
    const references = sanitizeEvidence(
      child.referenceList,
      MAX_EVIDENCE_CANDIDATES,
    );
    const inlineCitations = citationsFromInlineMarkers(
      child.answerContent,
      child.referenceList,
    );
    const citations = mergeCitationEvidence(
      sanitizeEvidence(child.citationList, MAX_EVIDENCE_CANDIDATES),
      inlineCitations,
    );
    const canonicalSources = canonicalMonitorSourceValue(child);
    const sources = canonicalSources.present
      ? mergeUnifiedSources(
          sanitizeEvidence(canonicalSources.value, MAX_EVIDENCE_CANDIDATES),
        )
      : mergeUnifiedSources(citations, references);
    const knownInlineCitationIndexes = new Set(
      citations.flatMap((item) =>
        typeof item !== "string" && item.index !== undefined
          ? [item.index]
          : [],
      ),
    );
    const answer = sanitizeMonitorAnswerText(
      child.answerContent,
      knownInlineCitationIndexes,
    );
    const media = sanitizeMonitorMedia(child.mediaContent, child.answerContent);
    const error = normalizedText(child.errorMessage) ? "本次回答未成功" : "";
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
      ...(error ? { error } : {}),
      ...(normalizeTimestamp(child.time)
        ? { completedAt: normalizeTimestamp(child.time) }
        : {}),
    });
  }
  return { checkpoint: { items }, remoteStatus, totalItems };
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
    const priorFinal = CHILD_FINAL_STATUSES.has(prior.status);
    const nextFinal = CHILD_FINAL_STATUSES.has(next.status);
    byId.set(next.subTaskId, {
      ...prior,
      status: priorFinal ? prior.status : next.status || prior.status,
      answerText:
        (next.answerText?.length ?? 0) > (prior.answerText?.length ?? 0)
          ? next.answerText
          : prior.answerText,
      media: mergeMedia(prior.media, next.media),
      sources: mergeUnifiedSources(
        checkpointItemSources(prior),
        checkpointItemSources(next),
      ),
      error:
        priorFinal && nextFinal ? prior.error : (next.error ?? prior.error),
      completedAt: next.completedAt ?? prior.completedAt,
    });
  }
  return { items: [...byId.values()] };
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
  return {
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

function publicRecordId(runId: string, subTaskId: string) {
  return `mr_${sha256(`${runId}:${subTaskId}`).slice(0, 24)}`;
}

function buildFinalResult(
  run: PresalesMonitorRun,
  checkpoint: MonitorCheckpoint,
  partial: boolean,
) {
  const scopes = jsonScopeMap(run.subtaskScopes);
  const byId = new Map(checkpoint.items.map((item) => [item.subTaskId, item]));
  const records: PublicMonitorRecord[] = [];
  for (const subTaskId of jsonStringArray(run.initialSubtaskIds)) {
    const scope = scopes[subTaskId];
    const item = byId.get(subTaskId);
    if (!scope || !item) continue;
    records.push({
      recordId: publicRecordId(run.id, subTaskId),
      platform: scope.platform,
      runIndex: scope.runIndex,
      status: item.status,
      ...(item.answerText ? { answerText: item.answerText } : {}),
      media: item.media ?? [],
      sources: checkpointItemSources(item),
      ...(item.error ? { error: item.error } : {}),
      ...(item.completedAt ? { completedAt: item.completedAt } : {}),
    });
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
      [...checkpoint.items].sort((a, b) =>
        a.subTaskId.localeCompare(b.subTaskId),
      ),
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
  const final = isRecord(run.finalResult) ? run.finalResult : null;
  const checkpointResult =
    includeResult && !final && POLLABLE_LOCAL_STATUSES.has(run.status)
      ? buildCheckpointResult(run, monitorCheckpoint(run.checkpoint))
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
        const legacyRecord = record as unknown as MonitorCheckpointItem;
        return [
          {
            recordId: normalizedText(record.recordId),
            platform,
            runIndex: positiveInteger(record.runIndex) || 1,
            status: normalizedText(record.status),
            ...(normalizedText(record.answerText)
              ? { answerText: normalizedText(record.answerText) }
              : {}),
            media: Array.isArray(record.media)
              ? (record.media as MonitorMedia[])
              : [],
            sources: checkpointItemSources(legacyRecord),
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
    question: run.question,
    platforms,
    repeatPerPlatform: MONITOR_REPEAT_PER_PLATFORM,
    expectedItems: run.expectedItems,
    completedItems: run.completedItems,
    failedItems: run.failedItems,
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

export class DrizzleMonitorRepository implements MonitorRepository {
  async reserve(
    input: Parameters<MonitorRepository["reserve"]>[0],
  ): Promise<MonitorReservation> {
    const db = await requireDb();
    const run: InsertPresalesMonitorRun = {
      id: randomUUID(),
      idempotencyKeyHash: input.idempotencyKeyHash,
      requestHash: input.requestHash,
      apiCredentialId: input.credential.id,
      credentialVersion: input.credential.version,
      question: input.question,
      platforms: [...input.platforms],
      expectedItems: input.expectedItems,
      status: "submission_in_progress",
      completedItems: 0,
      failedItems: 0,
      shapeMismatch: false,
      terminalStableCount: 0,
      createdAt: input.now,
      updatedAt: input.now,
    };
    try {
      await db.insert(presalesMonitorRuns).values(run);
      const inserted = await this.get(run.id);
      if (!inserted) throw new Error("Inserted monitor run was not found");
      return { state: "acquired", run: inserted };
    } catch (error) {
      const mysqlError = error as { code?: string };
      if (mysqlError.code !== "ER_DUP_ENTRY") throw error;
    }
    const existing = await db
      .select()
      .from(presalesMonitorRuns)
      .where(
        eq(presalesMonitorRuns.idempotencyKeyHash, input.idempotencyKeyHash),
      )
      .limit(1);
    const row = existing[0];
    if (!row) {
      throw new PresalesMonitorError(
        "IDEMPOTENCY_PENDING",
        425,
        "监控幂等预留正在建立，请稍后重试",
        1_000,
      );
    }
    if (
      row.requestHash !== input.requestHash ||
      row.apiCredentialId !== input.credential.id ||
      row.credentialVersion !== input.credential.version
    ) {
      throw new PresalesMonitorError(
        "IDEMPOTENCY_CONFLICT",
        409,
        "该幂等键已绑定另一组监控问题、平台或凭据版本",
      );
    }
    if (row.deletedAt) {
      throw new PresalesMonitorError(
        "IDEMPOTENCY_RETIRED",
        409,
        "该幂等键对应的监控任务已删除，不能再次用于付费提交",
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

  async markSubmissionUnknown(runId: string, error: string, now: Date) {
    return this.updateAndRead(runId, {
      status: "submission_unknown",
      lastError: error,
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
    return db.transaction(async (tx: any) => {
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
      if (
        !run ||
        !POLLABLE_LOCAL_STATUSES.has(run.status) ||
        !run.upstreamTaskId ||
        (run.nextPollAt && run.nextPollAt.getTime() > now.getTime()) ||
        (run.pollLeaseId &&
          run.pollLeaseExpiresAt &&
          run.pollLeaseExpiresAt.getTime() > now.getTime())
      ) {
        return null;
      }
      const leaseId = randomUUID();
      const nextPollAt = new Date(now.getTime() + MONITOR_POLL_INTERVAL_MS);
      const pollLeaseExpiresAt = new Date(
        now.getTime() + MONITOR_POLL_LEASE_MS,
      );
      await tx
        .update(presalesMonitorRuns)
        .set({
          status: "polling",
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
    await db
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
    const run = await this.get(runId);
    if (!run)
      throw new PresalesMonitorError("NOT_FOUND", 404, "监控任务不存在");
    return run;
  }

  async remove(runId: string) {
    const db = await requireDb();
    await db
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
  }

  private async updateAndRead(
    runId: string,
    patch: Partial<InsertPresalesMonitorRun>,
  ) {
    const db = await requireDb();
    await db
      .update(presalesMonitorRuns)
      .set(patch)
      .where(eq(presalesMonitorRuns.id, runId));
    const run = await this.get(runId);
    if (!run)
      throw new PresalesMonitorError("NOT_FOUND", 404, "监控任务不存在");
    return run;
  }
}

export function monitorBaseUrl(env: NodeJS.ProcessEnv = process.env) {
  const raw =
    env.FRONTMIND_MONITOR_API_BASE_URL?.trim() ||
    Buffer.from(DEFAULT_MONITOR_BASE_URL_B64, "base64").toString("utf8");
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new PresalesMonitorError(
      "MONITOR_NOT_CONFIGURED",
      503,
      "监控 API 地址无效",
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
      "监控 API 地址必须使用安全协议且不能包含凭据、查询或片段",
    );
  }
  return parsed.toString().replace(/\/+$/, "");
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

class AxiosMonitorTransport implements MonitorTransport {
  private async request(
    method: "POST" | "GET",
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
          ...(method === "POST" ? { "Content-Type": "application/json" } : {}),
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
    if (response.status < 200 || response.status >= 300) {
      throw new MonitorRemoteError(
        message,
        method === "GET" &&
          [408, 425, 429, 500, 502, 503, 504].includes(response.status),
      );
    }
    if (!isRecord(response.data) || response.data.success !== true) {
      throw new MonitorRemoteError(message, false);
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
  ) {}

  async create(rawInput: unknown) {
    const input = monitorCreateSchema.parse(rawInput);
    const credential = await this.activeCredential();
    if (!credential) {
      throw new PresalesMonitorError(
        "INVALID_CREDENTIAL",
        428,
        "FrontMind 监控服务暂未启用，请联系技术人员",
      );
    }
    const platforms = [...input.platforms];
    const expectedItems = platforms.length * MONITOR_REPEAT_PER_PLATFORM;
    const reservation = await this.repository.reserve({
      idempotencyKeyHash: sha256(input.idempotencyKey),
      requestHash: requestHash({ question: input.question, platforms }),
      credential,
      question: input.question,
      platforms,
      expectedItems,
      now: this.now(),
    });
    if (reservation.state === "replay") {
      return { replayed: true, run: publicMonitorRun(reservation.run, false) };
    }

    const payload = buildMonitorSubmitPayload({
      question: input.question,
      platforms,
    });
    try {
      const response = await this.transport.submit(payload, credential);
      const validated = validateMonitorSubmitResponse(response, {
        question: input.question,
        platforms,
        expectedItems,
      });
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
          ? safeError(error.message, "监控提交结果未知")
          : "监控提交结果未知";
      const run = await this.repository.markSubmissionUnknown(
        reservation.run.id,
        message,
        this.now(),
      );
      throw new PresalesMonitorError(
        "MONITOR_SUBMISSION_UNKNOWN",
        502,
        "监控任务可能已提交，但无法确认任务 ID；为避免重复计费，系统不会自动重发",
      );
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

  private async refreshIfDue(run: PresalesMonitorRun) {
    if (!POLLABLE_LOCAL_STATUSES.has(run.status)) return run;
    const lease = await this.repository.acquirePoll(run.id, this.now());
    if (!lease) return (await this.repository.get(run.id)) ?? run;
    const credential = await this.credentialById(lease.run.apiCredentialId);
    if (!credential || credential.version !== lease.run.credentialVersion) {
      return this.repository.finishPoll(run.id, lease.leaseId, {
        status: "remote_failed",
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
      const previousDone = lease.run.completedItems + lease.run.failedItems;
      const currentDone = status.completedItems + status.failedItems;
      const shouldFetchResult =
        currentDone > previousDone ||
        MAIN_FINAL_STATUSES.has(status.remoteStatus);
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
      const allTerminal = checkpoint.items.every((item) =>
        CHILD_FINAL_STATUSES.has(item.status),
      );
      const remoteTerminal =
        MAIN_FINAL_STATUSES.has(status.remoteStatus) &&
        MAIN_FINAL_STATUSES.has(snapshot.remoteStatus);
      const complete =
        remoteTerminal &&
        exactIds &&
        checkpoint.items.length === lease.run.expectedItems &&
        allTerminal;
      const signature = checkpointSignature(checkpoint);
      const stableCount =
        remoteTerminal && signature === lease.run.terminalSnapshotHash
          ? lease.run.terminalStableCount + 1
          : remoteTerminal
            ? 1
            : 0;
      const successful = checkpoint.items.filter(isSuccessful).length;
      if (complete) {
        const finalResult = buildFinalResult(lease.run, checkpoint, false);
        return this.repository.finishPoll(run.id, lease.leaseId, {
          status: successful > 0 ? "completed" : "remote_failed",
          remoteStatus: snapshot.remoteStatus || status.remoteStatus,
          totalItems: status.totalItems,
          completedItems: status.completedItems,
          failedItems: status.failedItems,
          checkpoint,
          finalResult,
          terminalSnapshotHash: signature,
          terminalStableCount: stableCount,
          lastError: successful > 0 ? null : "监控任务没有返回成功文字答案",
          completedAt: this.now(),
        });
      }
      if (remoteTerminal && stableCount >= 2) {
        const finalResult = buildFinalResult(lease.run, checkpoint, true);
        return this.repository.finishPoll(run.id, lease.leaseId, {
          status: successful > 0 ? "partial_review_required" : "remote_failed",
          remoteStatus: snapshot.remoteStatus || status.remoteStatus,
          totalItems: status.totalItems,
          completedItems: status.completedItems,
          failedItems: status.failedItems,
          checkpoint,
          finalResult,
          terminalSnapshotHash: signature,
          terminalStableCount: stableCount,
          lastError:
            successful > 0
              ? "远端终态结果连续两次仍未覆盖全部初始子任务"
              : "监控任务没有返回成功文字答案",
          completedAt: this.now(),
        });
      }
      return this.repository.finishPoll(run.id, lease.leaseId, {
        status: "polling",
        remoteStatus: snapshot.remoteStatus || status.remoteStatus,
        totalItems: status.totalItems,
        completedItems: status.completedItems,
        failedItems: status.failedItems,
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
