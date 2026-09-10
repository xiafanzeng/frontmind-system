import { projectGeneralExecution } from "./frontmind-general-execution";
import {
  generalExecutionActivity,
  orderExecutionTimeline,
  projectBusinessExecution,
} from "../shared/frontmind-general-execution";
import type { ManusV2MessageEvent } from "./manus-v2-client";
/** Actual saved workflow and provider evidence; no prompt, result body or private thought. */
export function projectBrandQuestionExecution(input: {
  taskId: string;
  status: string;
  createdAt: number;
  updatedAt: number;
  events: readonly ManusV2MessageEvent[];
}) {
  let turn = 0;
  const execution = projectGeneralExecution(
    input.taskId,
    [...input.events]
      .sort(
        (a, b) =>
          Number(a.providerOriginalRank) - Number(b.providerOriginalRank),
      )
      .map((event, rank) => {
        if (event.type === "user_message") turn++;
        return {
          taskId: input.taskId,
          providerEventId: `${turn}:${event.id}`,
          providerTimestampMs: event.timestamp,
          normalizedPayload: {
            kind: "provider_event",
            providerOriginalRank: event.providerOriginalRank ?? rank,
            executionTurn: {
              id: `${input.taskId}:${turn}`,
              userSequence: turn,
            },
            executionActivity: (() => {
              const activity = generalExecutionActivity(
                event.executionActivity,
              );
              return activity?.kind === "tool_result" && activity.callId
                ? { ...activity, callId: `${turn}:${activity.callId}` }
                : activity;
            })(),
          },
        };
      }),
  );
  const terminal = ["succeeded", "failed", "cancelled"].includes(input.status);
  const stages = projectBusinessExecution(input.taskId, [
    {
      id: `${input.taskId}:created`,
      turnId: `${input.taskId}:0`,
      userSequence: 0,
      rank: -1,
      timestamp: input.createdAt,
      phase: "identifying_questions",
      status: input.status === "queued" ? "waiting" : "ended",
    },
    ...(terminal
      ? [
          {
            id: `${input.taskId}:finished`,
            turnId: `${input.taskId}:${turn}`,
            userSequence: turn,
            rank: Number.MAX_SAFE_INTEGER,
            timestamp: input.updatedAt,
            phase: "generating_result" as const,
            status:
              input.status === "succeeded"
                ? ("ended" as const)
                : input.status === "failed"
                  ? ("error" as const)
                  : ("cancelled" as const),
          },
        ]
      : []),
  ]);
  const timeline = orderExecutionTimeline([
    ...execution.timeline,
    ...stages.timeline,
  ]);
  const latest = timeline.at(-1);
  for (const item of timeline)
    item.isCurrent = !terminal && item.id === latest?.id;
  return { ...execution, coverage: "partial" as const, timeline };
}
