import { inArray } from "drizzle-orm";
import { agentEvents } from "../drizzle/schema";
import {
  generalExecutionActivity,
  orderExecutionTimeline,
  businessExecutionLabels,
  type BusinessExecutionPhase,
  generalThinkingText,
  type GeneralExecutionDto,
  type GeneralExecutionEntry,
} from "../shared/frontmind-general-execution";

type ExecutionRow = {
  taskId: string;
  providerEventId: string | null;
  providerTimestampMs: number | null;
  normalizedPayload: Record<string, unknown> | null;
};

/** Only generation-owned, positively turn-bound evidence can become public. */
export function projectGeneralExecution(
  taskId: string,
  rows: readonly ExecutionRow[],
): GeneralExecutionDto {
  const own = rows.filter((row) => row.taskId === taskId);
  const complete = own.some(
    (row) =>
      row.normalizedPayload?.kind === "local_projection_snapshot" &&
      row.normalizedPayload.executionVersion === 1 &&
      row.normalizedPayload.status === "applied",
  );
  const entries: GeneralExecutionEntry[] = [];
  const calls = new Map<
    string,
    Extract<GeneralExecutionEntry, { kind: "tool" }>
  >();
  const ordered = own
    .filter((row) => ["provider_event", "business_event"].includes(String(row.normalizedPayload?.kind)))
    .sort(
      (a, b) =>
        Number(
          a.normalizedPayload?.providerOriginalRank ?? Number.MAX_SAFE_INTEGER,
        ) -
          Number(
            b.normalizedPayload?.providerOriginalRank ??
              Number.MAX_SAFE_INTEGER,
          ) || Number(a.providerTimestampMs) - Number(b.providerTimestampMs),
    );
  const seen = new Set<string>();
  const prepared = ordered.flatMap((row) => {
    const p = row.normalizedPayload!;
    const turn = p.executionTurn as
      | { id?: unknown; userSequence?: unknown; userMessageId?: unknown }
      | undefined;
    if (
      !row.providerEventId ||
      !turn ||
      typeof turn.id !== "string" ||
      !Number.isSafeInteger(turn.userSequence) ||
      !Number.isSafeInteger(p.providerOriginalRank)
    )
      return [];
    if (row.providerTimestampMs === null) return [];
    const eventKey = JSON.stringify([turn.id, row.providerEventId]);
    if (seen.has(eventKey)) return [];
    seen.add(eventKey);
    const timestamp = Number(row.providerTimestampMs);
    if (!Number.isFinite(timestamp)) return [];
    const base = {
      id: `execution:${taskId}:${turn.id}:${row.providerEventId}`,
      turnId: turn.id,
      userSequence: Number(turn.userSequence),
      ...(typeof turn.userMessageId === "string" &&
      turn.userMessageId.length <= 128
        ? { userMessageId: turn.userMessageId }
        : {}),
      timestamp: timestamp < 1e12 ? timestamp * 1000 : timestamp,
      rank: Number(p.providerOriginalRank),
    };
    const activity = generalExecutionActivity(p.executionActivity);
    if (activity?.kind === "tool_use")
      calls.set(`${turn.id}:${row.providerEventId}`, {
        ...base,
        kind: "tool",
        label: activity.label,
        toolKind: activity.toolKind,
        status: "running",
      });
    return [{ row, p, turnId: turn.id, base, activity }];
  });
  // Linkage is explicit: build all calls before folding results, including
  // a result observed before its call in an out-of-order native snapshot.
  for (const { row, p, turnId, base, activity } of prepared) {
    if (
      p.type === "assistant_message" &&
      (p.text || (Array.isArray(p.artifacts) && p.artifacts.length))
    )
      entries.push({
        ...base,
        kind: "message",
        providerEventId: row.providerEventId!,
      });
    if (activity?.kind === "tool_use") {
      entries.push(calls.get(`${turnId}:${row.providerEventId}`)!);
    } else if (activity?.kind === "tool_result") {
      const call = activity.callId
        ? calls.get(`${turnId}:${activity.callId}`)
        : undefined;
      const status =
        activity.isError === true
          ? "failed"
          : activity.isError === false
            ? "completed"
            : "returned";
      if (call) {
        call.status = status;
        // A reordered snapshot may report a result timestamp before its call.
        // Preserve the result status without inventing a negative duration.
        if (base.timestamp >= call.timestamp) call.finishedAt = base.timestamp;
      } else
        entries.push({
          ...base,
          kind: "tool",
          label: "工具结果",
          status,
          finishedAt: base.timestamp,
          resultOnly: true,
        });
    } else if (activity?.kind === "status") {
      entries.push({
        ...base,
        kind: "status",
        status: activity.status,
        ...(p.kind === "business_event" && typeof p.businessPhase === "string" && Object.hasOwn(businessExecutionLabels, p.businessPhase)
          ? { runId: taskId, phase: p.businessPhase as BusinessExecutionPhase, label: businessExecutionLabels[p.businessPhase as BusinessExecutionPhase] } : {}),
        ...(activity.status === "thinking"
          ? generalThinkingText(activity)
          : {}),
      });
      for (const call of calls.values()) {
        if (call.turnId !== turnId || call.rank > base.rank) continue;
        if (
          activity.status === "waiting" &&
          activity.waitingIds?.some(
            (id) => calls.get(`${turnId}:${id}`) === call,
          ) &&
          call.status === "running"
        )
          call.status = "waiting";
        if (activity.status === "running" && call.status === "waiting")
          call.status = "running";
        if (
          ["ended", "cancelled", "error"].includes(activity.status) &&
          ["running", "waiting"].includes(call.status)
        )
          call.status = "unconfirmed";
      }
    }
  }
  return {
    schemaVersion: 1,
    taskId,
    coverage: complete ? "complete" : "pending",
    runId: taskId,
    timeline: orderExecutionTimeline(entries),
  };
}

/** Caller supplies already-owned task IDs; batch local reads keep hydrate cheap. */
export async function loadGeneralExecutions(
  executor: any,
  taskIds: readonly string[],
) {
  const ids = [...new Set(taskIds)];
  if (!ids.length) return new Map<string, GeneralExecutionDto>();
  const rows: ExecutionRow[] = await executor
    .select({
      taskId: agentEvents.taskId,
      providerEventId: agentEvents.providerEventId,
      providerTimestampMs: agentEvents.providerTimestampMs,
      normalizedPayload: agentEvents.normalizedPayload,
    })
    .from(agentEvents)
    .where(inArray(agentEvents.taskId, ids));
  return new Map(ids.map((id) => [id, projectGeneralExecution(id, rows)]));
}
