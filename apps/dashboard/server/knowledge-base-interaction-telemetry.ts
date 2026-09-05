const KNOWLEDGE_BASE_UPSTREAM_STATUS_ALLOWLIST = new Set([
  "created",
  "queued",
  "pending",
  "running",
  "in_progress",
  "processing",
  "collecting",
  "awaiting_input",
  "awaiting_user",
  "awaiting_user_input",
  "waiting",
  "paused",
  "requires_action",
  "input_required",
  "completed",
  "complete",
  "succeeded",
  "success",
  "done",
  "finished",
  "error",
  "failed",
  "errored",
  "cancelled",
  "canceled",
]);

export type KnowledgeBaseActiveTurnAgeBucketMinutes = 10 | 30 | 120;

const KNOWLEDGE_BASE_ACTIVE_TURN_AGE_BUCKETS_DESCENDING = [
  120, 30, 10,
] as const satisfies readonly KnowledgeBaseActiveTurnAgeBucketMinutes[];

export type KnowledgeBaseInteractionTelemetryEvent =
  | {
      kind: "unknown_upstream_status";
      dedupeKey: "unknown";
      metadata: {
        buildId: string | null;
        upstreamPhase: "unknown";
      };
    }
  | {
      kind: "active_turn_age_bucket";
      dedupeKey: `age_${KnowledgeBaseActiveTurnAgeBucketMinutes}`;
      metadata: {
        buildId: string;
        upstreamStatus: string;
        waitBucketMinutes: KnowledgeBaseActiveTurnAgeBucketMinutes;
      };
    };

function safeKnowledgeBaseUpstreamStatus(status: unknown) {
  const normalized = String(status || "running")
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, "_");
  return KNOWLEDGE_BASE_UPSTREAM_STATUS_ALLOWLIST.has(normalized)
    ? normalized
    : "unknown";
}

export function knowledgeBaseActiveTurnAgeBucket(input: {
  awaitingResponseSince: number | null | undefined;
  now: number;
}): KnowledgeBaseActiveTurnAgeBucketMinutes | null {
  if (
    typeof input.awaitingResponseSince !== "number" ||
    !Number.isFinite(input.awaitingResponseSince) ||
    input.awaitingResponseSince > input.now
  ) {
    return null;
  }
  const waitMinutes = (input.now - input.awaitingResponseSince) / 60_000;
  return (
    KNOWLEDGE_BASE_ACTIVE_TURN_AGE_BUCKETS_DESCENDING.find(
      (bucket) => waitMinutes >= bucket,
    ) || null
  );
}

/**
 * Produces observation-only telemetry facts. `awaitingResponseSince` is the
 * durable build marker for an accepted active turn and is cleared when that
 * turn releases authority. No provider text, customer content, URL or task
 * mutation is accepted or returned here.
 */
export function knowledgeBaseInteractionTelemetryEvents(input: {
  buildId: string | null | undefined;
  awaitingResponseSince: number | null | undefined;
  upstreamStatus: unknown;
  now?: number;
}): KnowledgeBaseInteractionTelemetryEvent[] {
  const now = input.now ?? Date.now();
  const safeUpstreamStatus = safeKnowledgeBaseUpstreamStatus(
    input.upstreamStatus,
  );
  const events: KnowledgeBaseInteractionTelemetryEvent[] = [];
  if (safeUpstreamStatus === "unknown") {
    events.push({
      kind: "unknown_upstream_status",
      dedupeKey: "unknown",
      metadata: {
        buildId: input.buildId || null,
        upstreamPhase: "unknown",
      },
    });
  }

  const buildId = String(input.buildId || "").trim();
  const waitBucketMinutes = knowledgeBaseActiveTurnAgeBucket({
    awaitingResponseSince: input.awaitingResponseSince,
    now,
  });
  if (buildId && waitBucketMinutes !== null) {
    events.push({
      kind: "active_turn_age_bucket",
      dedupeKey: `age_${waitBucketMinutes}`,
      metadata: {
        buildId,
        upstreamStatus: safeUpstreamStatus,
        waitBucketMinutes,
      },
    });
  }
  return events;
}
