import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { agentOperations, agentTasks } from "../drizzle/schema";
import {
  CONTENT_PRODUCTION_CONFIRMATION_ACTIONS,
  contentProductionConfirmationSchema,
  contentProductionStagePosition,
  type ContentProductionConfirmation,
  type ContentProductionDto,
  type ContentProductionMode,
} from "../shared/content-production";
import {
  frozenGeneralAgentPurpose,
  type FrozenGeneralAgentPurpose,
} from "./general-agent-purpose";

const runnerStateSchema = z.object({
  schema_version: z.literal("2.3.0"),
  job_id: z.string().min(1).max(200),
  workflow_mode: z.enum(["prepare", "article"]),
  updated_at: z.string().datetime({ offset: true }),
  current_stage: z.string().regex(/^(S[1-9]|E(?:[1-9]|10))$/u),
  status: z.enum([
    "running",
    "completed",
    "completed_with_limits",
    "blocked",
    "failed",
    "skipped_optional",
    "awaiting_pack_confirmation",
    "awaiting_research_inputs",
    "awaiting_pattern_confirmation",
    "awaiting_blueprint_confirmation",
    "awaiting_title_count",
  ]),
});
export type ContentRunnerObservation = {
  providerRank: number;
  eventId: string;
  artifactId: string;
  sha256: string;
  state: z.infer<typeof runnerStateSchema>;
};
export type ContentProductionProgress = {
  revision: 1;
  lastObservation: ContentRunnerObservation;
  progressPosition: number;
  completedConfirmations: ContentProductionConfirmation[];
};
const confirmationStage: Record<ContentProductionConfirmation, string> = {
  awaiting_pack_confirmation: "S8",
  awaiting_research_inputs: "E1",
  awaiting_pattern_confirmation: "E2",
  awaiting_blueprint_confirmation: "E4",
  awaiting_title_count: "E10",
};

/** Input is the downloaded original Runner state attachment, never an assistant sentence. */
export function parseContentRunnerState(
  bytes: Buffer,
): z.infer<typeof runnerStateSchema> | null {
  if (bytes.length > 256 * 1024) return null;
  try {
    const parsed = runnerStateSchema.safeParse(
      JSON.parse(bytes.toString("utf8")),
    );
    if (!parsed.success) return null;
    const state = parsed.data;
    const confirmation = contentProductionConfirmationSchema.safeParse(
      state.status,
    );
    if (
      confirmation.success &&
      confirmationStage[confirmation.data] !== state.current_stage
    )
      return null;
    if (
      state.current_stage.startsWith("S") !==
      (state.workflow_mode === "prepare")
    )
      return null;
    return state;
  } catch {
    return null;
  }
}

export function reduceContentProductionProgress(
  previous: ContentProductionProgress | null,
  observation: ContentRunnerObservation,
  mode: ContentProductionMode,
): ContentProductionProgress {
  if (previous) {
    const old = previous.lastObservation;
    if (observation.providerRank < old.providerRank) return previous;
    // Native transport may group multiple copied job states into one output event.
    // Preserve their real Runner chronology instead of choosing arbitrary file-list order.
    if (compareContentRunnerObservations(observation, old) <= 0)
      return previous;
  }
  const completed = new Set(previous?.completedConfirmations ?? []);
  const oldConfirmation = contentProductionConfirmationSchema.safeParse(
    previous?.lastObservation.state.status,
  );
  const stagePosition = contentProductionStagePosition(
    observation.state.current_stage,
  );
  if (
    oldConfirmation.success &&
    (stagePosition >
      contentProductionStagePosition(confirmationStage[oldConfirmation.data]) ||
      (observation.state.current_stage ===
        confirmationStage[oldConfirmation.data] &&
        ["completed", "completed_with_limits"].includes(
          observation.state.status,
        )))
  ) {
    completed.add(oldConfirmation.data);
  }
  const finalStage = ["new_reference_pack", "refresh_reference_pack"].includes(
    mode,
  )
    ? "S9"
    : "E10";
  const isComplete =
    observation.state.current_stage === finalStage &&
    ["completed", "completed_with_limits"].includes(observation.state.status);
  return {
    revision: 1,
    lastObservation: observation,
    progressPosition: Math.max(
      previous?.progressPosition ?? 0,
      isComplete ? 20 : stagePosition,
    ),
    completedConfirmations: [...completed],
  };
}

export function compareContentRunnerObservations(
  left: ContentRunnerObservation,
  right: ContentRunnerObservation,
) {
  const time =
    Date.parse(left.state.updated_at) - Date.parse(right.state.updated_at);
  if (time) return time;
  // Python emits UTC microseconds; Date.parse retains only milliseconds.
  const fraction = (value: string) =>
    (value.match(/\.(\d+)(?:Z|[+-]\d{2}:\d{2})$/u)?.[1] ?? "").padEnd(9, "0");
  return fraction(left.state.updated_at).localeCompare(
    fraction(right.state.updated_at),
  );
}

export function contentProductionPublicDto(
  context: FrozenGeneralAgentPurpose | null,
  providerRuntime?: Record<string, unknown> | null,
): ContentProductionDto | undefined {
  if (context?.purpose !== "content_production" || !context.contentProduction)
    return undefined;
  const progress = providerRuntime?.contentProductionProgress as
    | ContentProductionProgress
    | undefined;
  const state =
    progress?.revision === 1 ? progress.lastObservation.state : null;
  const parsed = contentProductionConfirmationSchema.safeParse(state?.status);
  const confirmation = parsed.success ? parsed.data : null;
  return {
    mode: context.contentProduction.mode,
    enterpriseName: context.contentProduction.enterpriseName,
    workflowVersion: "2.3.0",
    workflowStatus: state?.status ?? null,
    currentStage: state?.current_stage ?? null,
    confirmation,
    progressPosition: progress?.progressPosition ?? 0,
    completedConfirmations: progress?.completedConfirmations ?? [],
    availableActions: confirmation
      ? [CONTENT_PRODUCTION_CONFIRMATION_ACTIONS[confirmation]]
      : [],
    knowledgeBase: context.knowledgeBase,
    source: state ? "runner_job_state" : "awaiting_runner",
  };
}

export async function persistContentProductionObservations(input: {
  executor: any;
  taskId: string;
  operationId: string;
  userId: number;
  observations: ContentRunnerObservation[];
}) {
  if (!input.observations.length) return;
  await input.executor.transaction(async (tx: any) => {
    const [row] = await tx
      .select({ task: agentTasks })
      .from(agentTasks)
      .innerJoin(
        agentOperations,
        eq(agentOperations.id, agentTasks.operationId),
      )
      .where(
        and(
          eq(agentTasks.id, input.taskId),
          eq(agentOperations.id, input.operationId),
          eq(agentOperations.scope, "managed_user"),
          eq(agentOperations.accountUserId, input.userId),
        ),
      )
      .limit(1)
      .for("update");
    if (!row) throw new Error("CONTENT_PRODUCTION_TASK_NOT_FOUND");
    const context = frozenGeneralAgentPurpose(row.task, input.userId);
    if (context?.purpose !== "content_production" || !context.contentProduction)
      return;
    const previous = row.task.providerRuntime?.contentProductionProgress as
      | ContentProductionProgress
      | undefined;
    let progress = previous ?? null;
    for (const observation of [...input.observations].sort(
      (left, right) =>
        left.providerRank - right.providerRank ||
        compareContentRunnerObservations(left, right),
    ))
      progress = reduceContentProductionProgress(
        progress,
        observation,
        context.contentProduction.mode,
      );
    if (progress === previous) return;
    await tx
      .update(agentTasks)
      .set({
        providerRuntime: {
          ...row.task.providerRuntime,
          contentProductionProgress: progress,
        },
      })
      .where(eq(agentTasks.id, input.taskId));
  });
}
