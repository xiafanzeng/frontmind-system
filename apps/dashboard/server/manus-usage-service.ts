import { getUpstreamBaseUrl } from "./upstream-config";

const MANUS_USAGE_PAGE_LIMIT = 100;
// 100 pages cover 10,000 rolling-window records while retaining a fail-closed
// bound against a provider that returns endlessly changing cursors.
const MANUS_USAGE_MAX_PAGES = 100;

export type ApiUsageSyncIssueCode =
  | "CREDENTIAL_REJECTED"
  | "RATE_LIMITED"
  | "TIMEOUT"
  | "UPSTREAM_UNAVAILABLE"
  | "RESPONSE_INVALID"
  | "PAGINATION_INVALID"
  | "PAGE_DRIFT"
  | "PARTIAL_USAGE_SCAN";

export class ManusUsageSyncError extends Error {
  constructor(
    public readonly code: ApiUsageSyncIssueCode,
    message: string,
  ) {
    super(message);
    this.name = "ManusUsageSyncError";
  }
}

type FetchLike = (
  input: string | URL | globalThis.Request,
  init?: globalThis.RequestInit,
) => Promise<globalThis.Response>;

function parseUsageChangedAt(value: unknown) {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value > 1_000_000_000_000 ? value : value * 1_000;
  }
  if (typeof value !== "string" || !value.trim()) return null;
  const numeric = Number(value);
  if (Number.isFinite(numeric)) {
    return numeric > 1_000_000_000_000 ? numeric : numeric * 1_000;
  }
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

export function aggregateManusUsageChangePage(input: {
  entries: any[];
  startAt: number;
  endAt: number;
  seenTaskIds?: Set<string>;
  seenTaskEntries?: Map<string, string>;
}) {
  let netUsed = 0;
  let complete = true;
  let issueCode: ApiUsageSyncIssueCode | undefined;
  let datedEntryCount = 0;
  let expiredEntryCount = 0;

  const markPartial = (code: ApiUsageSyncIssueCode) => {
    complete = false;
    if (code === "PAGE_DRIFT" || !issueCode) issueCode = code;
  };

  for (const entry of input.entries) {
    const type = typeof entry?.type === "string" ? entry.type : "";
    if (type !== "grant" && type !== "cost" && type !== "refund") {
      markPartial("PARTIAL_USAGE_SCAN");
      continue;
    }
    const changedAt = parseUsageChangedAt(entry?.created_at);
    if (changedAt === null) {
      markPartial("PARTIAL_USAGE_SCAN");
      continue;
    }
    datedEntryCount += 1;
    if (changedAt < input.startAt) {
      expiredEntryCount += 1;
      continue;
    }
    if (changedAt >= input.endAt) continue;

    const hasCredits = Object.prototype.hasOwnProperty.call(entry, "credits");
    const credits =
      !hasCredits && (type === "cost" || type === "refund")
        ? 0
        : entry?.credits;
    if (typeof credits !== "number" || !Number.isFinite(credits)) {
      markPartial("PARTIAL_USAGE_SCAN");
      continue;
    }
    if (type === "grant") {
      // Grants increase the balance; they are not usage.
      if (credits < 0) markPartial("PARTIAL_USAGE_SCAN");
      continue;
    }
    const taskId = String(entry?.task_id ?? "").trim();
    if (!taskId) {
      // Consumption/refund rows affect the total and therefore require a
      // stable session identity for cross-page deduplication. Account-level
      // grants legitimately omit task_id and were already excluded above.
      markPartial("PARTIAL_USAGE_SCAN");
      continue;
    }
    // A refunded session can legitimately expose both one cost row and one
    // refund row with the same task_id. Treat those as separate accounting
    // slots while still deduplicating an identical row repeated across cursor
    // pages.
    const taskEntryKey = `${taskId}\0${type}`;
    const entrySignature = JSON.stringify([credits, changedAt]);
    const priorSignature = input.seenTaskEntries?.get(taskEntryKey);
    if (priorSignature !== undefined) {
      if (priorSignature !== entrySignature) markPartial("PAGE_DRIFT");
      // Identical rows may appear on adjacent cursor pages. Count them once
      // without degrading an otherwise complete authoritative scan.
      continue;
    }
    if (input.seenTaskIds?.has(taskId)) {
      // Legacy Set callers cannot prove that the repeated row is identical.
      markPartial("PAGE_DRIFT");
      continue;
    }
    input.seenTaskEntries?.set(taskEntryKey, entrySignature);
    input.seenTaskIds?.add(taskId);
    if (
      (type === "cost" && credits > 0) ||
      (type === "refund" && credits < 0)
    ) {
      markPartial("PARTIAL_USAGE_SCAN");
    }
    // Manus reports costs as negative changes and refunds as positive changes.
    // Negating both gives net credit consumption for the selected window.
    netUsed -= credits;
  }

  return {
    netUsed,
    complete,
    reachedCutoff:
      complete && datedEntryCount > 0 && expiredEntryCount === datedEntryCount,
    ...(issueCode ? { issueCode } : {}),
  };
}

function isTimeoutError(error: unknown) {
  return (
    error instanceof Error &&
    (error.name === "AbortError" || error.name === "TimeoutError")
  );
}

async function scanManusRollingCreditUsage(input: {
  apiKey: string;
  startAt: number;
  endAt: number;
  fetchImpl: FetchLike;
  baseUrl: string;
  maxPages: number;
}) {
  let cursor: string | undefined;
  let netUsed = 0;
  let complete = true;
  let issueCode: ApiUsageSyncIssueCode | undefined;
  const seenCursors = new Set<string>();
  const seenTaskEntries = new Map<string, string>();

  for (let pageIndex = 0; pageIndex < input.maxPages; pageIndex += 1) {
    const params = new URLSearchParams({
      limit: String(MANUS_USAGE_PAGE_LIMIT),
    });
    if (cursor) params.set("cursor", cursor);

    let response: globalThis.Response;
    try {
      response = await input.fetchImpl(
        `${input.baseUrl}/v2/usage.list?${params.toString()}`,
        {
          headers: {
            "x-manus-api-key": input.apiKey,
            Accept: "application/json",
          },
          redirect: "error",
          signal: AbortSignal.timeout(30_000),
        },
      );
    } catch (error) {
      throw new ManusUsageSyncError(
        isTimeoutError(error) ? "TIMEOUT" : "UPSTREAM_UNAVAILABLE",
        "暂时无法读取 Key 的积分变更记录",
      );
    }

    if (!response.ok) {
      const code: ApiUsageSyncIssueCode =
        response.status === 401 || response.status === 403
          ? "CREDENTIAL_REJECTED"
          : response.status === 429
            ? "RATE_LIMITED"
            : "UPSTREAM_UNAVAILABLE";
      throw new ManusUsageSyncError(code, "暂时无法读取 Key 的积分变更记录");
    }

    let payload: any;
    try {
      payload = await response.json();
    } catch {
      throw new ManusUsageSyncError(
        "RESPONSE_INVALID",
        "Key 积分变更记录返回异常",
      );
    }
    if (payload?.ok !== true || !Array.isArray(payload?.data)) {
      throw new ManusUsageSyncError(
        "RESPONSE_INVALID",
        "Key 积分变更记录返回异常",
      );
    }

    const page = aggregateManusUsageChangePage({
      entries: payload.data,
      startAt: input.startAt,
      endAt: input.endAt,
      seenTaskEntries,
    });
    netUsed += page.netUsed;
    if (!page.complete) {
      complete = false;
      issueCode = page.issueCode ?? "PARTIAL_USAGE_SCAN";
    }
    if (page.issueCode === "PAGE_DRIFT") {
      return {
        totalUsed: Math.max(0, netUsed),
        complete: false,
        issueCode,
      };
    }

    const hasMore = payload?.has_more === true;
    if (page.reachedCutoff || !hasMore) {
      return {
        totalUsed: Math.max(0, netUsed),
        complete,
        ...(issueCode ? { issueCode } : {}),
      };
    }

    const nextCursor = String(payload?.next_cursor ?? "").trim();
    if (!nextCursor || seenCursors.has(nextCursor)) {
      return {
        totalUsed: Math.max(0, netUsed),
        complete: false,
        issueCode: "PAGINATION_INVALID" as const,
      };
    }
    seenCursors.add(nextCursor);
    cursor = nextCursor;

    if (pageIndex === input.maxPages - 1) {
      return {
        totalUsed: Math.max(0, netUsed),
        complete: false,
        issueCode: "PARTIAL_USAGE_SCAN" as const,
      };
    }
  }

  return {
    totalUsed: Math.max(0, netUsed),
    complete: false,
    issueCode: "PARTIAL_USAGE_SCAN" as const,
  };
}

export async function getManusRollingCreditUsage(input: {
  apiKey: string;
  startAt: number;
  endAt: number;
  fetchImpl?: FetchLike;
  baseUrl?: string;
  maxPages?: number;
}) {
  const fetchImpl = input.fetchImpl ?? fetch;
  const baseUrl = (input.baseUrl ?? getUpstreamBaseUrl()).replace(/\/$/, "");
  const maxPages = Math.max(
    1,
    Math.min(
      MANUS_USAGE_MAX_PAGES,
      Number.isInteger(input.maxPages)
        ? Number(input.maxPages)
        : MANUS_USAGE_MAX_PAGES,
    ),
  );
  let result = await scanManusRollingCreditUsage({
    ...input,
    fetchImpl,
    baseUrl,
    maxPages,
  });
  // Cursor pagination may briefly shift while new usage rows are inserted.
  // Retry one complete scan before surfacing a stable PAGE_DRIFT result.
  if (result.issueCode === "PAGE_DRIFT") {
    result = await scanManusRollingCreditUsage({
      ...input,
      fetchImpl,
      baseUrl,
      maxPages,
    });
  }
  return result;
}
