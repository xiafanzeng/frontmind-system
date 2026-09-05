import { AuthServiceError } from "./auth-service";
import { getUpstreamBaseUrl } from "./upstream-config";

const MANUS_USAGE_PAGE_LIMIT = 100;
// 100 pages cover 10,000 rolling-window records while retaining a fail-closed
// bound against a provider that returns endlessly changing cursors.
const MANUS_USAGE_MAX_PAGES = 100;

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
}) {
  let netUsed = 0;
  let complete = true;
  let datedEntryCount = 0;
  let expiredEntryCount = 0;

  for (const entry of input.entries) {
    const changedAt = parseUsageChangedAt(entry?.created_at);
    if (changedAt === null) {
      complete = false;
      continue;
    }
    datedEntryCount += 1;
    if (changedAt < input.startAt) {
      expiredEntryCount += 1;
      continue;
    }
    if (changedAt >= input.endAt) continue;

    const credits = Number(entry?.credits);
    if (!Number.isFinite(credits)) {
      complete = false;
      continue;
    }
    const type = String(entry?.type ?? "");
    if (type === "grant") {
      // Grants increase the balance; they are not usage.
      if (credits < 0) complete = false;
      continue;
    }
    if (type !== "cost" && type !== "refund") {
      complete = false;
      continue;
    }
    const taskId = String(entry?.task_id ?? "").trim();
    if (!taskId || input.seenTaskIds?.has(taskId)) {
      // Consumption/refund rows affect the total and therefore require a
      // stable session identity for cross-page deduplication. Account-level
      // grants legitimately omit task_id and were already excluded above.
      complete = false;
      continue;
    }
    input.seenTaskIds?.add(taskId);
    if (
      (type === "cost" && credits > 0) ||
      (type === "refund" && credits < 0)
    ) {
      complete = false;
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
  let cursor: string | undefined;
  let netUsed = 0;
  let complete = true;
  const seenCursors = new Set<string>();
  const seenTaskIds = new Set<string>();

  for (let pageIndex = 0; pageIndex < maxPages; pageIndex += 1) {
    const params = new URLSearchParams({
      limit: String(MANUS_USAGE_PAGE_LIMIT),
    });
    if (cursor) params.set("cursor", cursor);

    let response: globalThis.Response;
    try {
      response = await fetchImpl(
        `${baseUrl}/v2/usage.list?${params.toString()}`,
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
      throw new AuthServiceError(
        "UPSTREAM_UNAVAILABLE",
        "暂时无法读取 Key 的积分变更记录",
      );
    }

    if (!response.ok) {
      throw new AuthServiceError(
        response.status === 401 || response.status === 403
          ? "INVALID_CREDENTIAL"
          : "UPSTREAM_UNAVAILABLE",
        "暂时无法读取 Key 的积分变更记录",
      );
    }

    const payload = (await response.json()) as any;
    if (payload?.ok !== true || !Array.isArray(payload?.data)) {
      throw new AuthServiceError(
        "UPSTREAM_UNAVAILABLE",
        "Key 积分变更记录返回异常",
      );
    }

    const page = aggregateManusUsageChangePage({
      entries: payload.data,
      startAt: input.startAt,
      endAt: input.endAt,
      seenTaskIds,
    });
    netUsed += page.netUsed;
    if (!page.complete) complete = false;

    const hasMore = payload?.has_more === true;
    if (page.reachedCutoff || !hasMore) {
      return {
        totalUsed: Math.max(0, netUsed),
        complete,
      };
    }

    const nextCursor = String(payload?.next_cursor ?? "").trim();
    if (!nextCursor || seenCursors.has(nextCursor)) {
      return {
        totalUsed: Math.max(0, netUsed),
        complete: false,
      };
    }
    seenCursors.add(nextCursor);
    cursor = nextCursor;

    if (pageIndex === maxPages - 1) {
      return {
        totalUsed: Math.max(0, netUsed),
        complete: false,
      };
    }
  }

  return {
    totalUsed: Math.max(0, netUsed),
    complete: false,
  };
}
