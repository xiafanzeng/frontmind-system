/**
 * Build the authoritative rolling-window query used by usage scanners.
 *
 * The v1 task API accepts second-precision boundaries while the local ledger
 * uses milliseconds. Widen the upstream interval by one second on each side,
 * then keep the existing exact [startAt, endAt) filtering locally.
 */
export function buildRollingUsageTaskParams(input: {
  limit: number;
  startAt: number;
  endAt: number;
  after?: string;
}) {
  const params = new URLSearchParams({
    limit: String(input.limit),
    order: "desc",
    orderBy: "created_at",
    createdAfter: String(Math.max(0, Math.floor(input.startAt / 1_000) - 1)),
    createdBefore: String(Math.ceil(input.endAt / 1_000) + 1),
  });
  if (input.after) params.set("after", input.after);
  return params;
}

/**
 * A single out-of-order task is not a safe pagination sentinel. A complete
 * page whose every dated task is before the window is the minimum safe signal
 * that the descending scan has crossed the rolling-window boundary.
 */
export function usagePageReachedCutoff(input: {
  complete: boolean;
  datedTaskCount: number;
  expiredTaskCount: number;
}) {
  return (
    input.complete &&
    input.datedTaskCount > 0 &&
    input.expiredTaskCount === input.datedTaskCount
  );
}

/**
 * The legacy task list is used only for local account attribution. A malformed
 * success body must therefore degrade attribution to unavailable instead of
 * invalidating an independently verified v2 pool total.
 */
export async function parseRollingUsageTaskPayload(
  response: globalThis.Response,
): Promise<(Record<string, unknown> & { data: any[] }) | null> {
  try {
    const payload = (await response.json()) as unknown;
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
      return null;
    }
    const record = payload as Record<string, unknown>;
    return Array.isArray(record.data)
      ? (record as Record<string, unknown> & { data: any[] })
      : null;
  } catch {
    return null;
  }
}
