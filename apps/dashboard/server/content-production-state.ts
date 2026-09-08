import { enterpriseAccountOwnerPredicate } from "./enterprise-project-scope";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { agentOperations, agentTasks } from "../drizzle/schema";
import {
  CONTENT_PRODUCTION_CONFIRMATION_ACTIONS,
  CONTENT_PRODUCTION_RUNNER_STATUSES,
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
import {
  contentProductionPauseTitle,
  contentProductionPublicText,
} from "../shared/content-production-public";

const decision = z.object({
  revision: z.number().int().min(0).optional(),
  confirmed: z.boolean().optional(),
});
const runnerStateSchema = z.object({
  schema_version: z.literal("4.11"),
  artifact_type: z.literal("frontmind_content_job_state"),
  workflow_version: z.literal("4.11"),
  job_id: z.string().min(1).max(200),
  job_kind: z.enum([
    "reference_pack",
    "reference_pack_refresh",
    "p0",
    "article",
  ]),
  updated_at: z.string().datetime({ offset: true }),
  stage: z.string().min(1).max(200),
  status: z
    .string()
    .refine((value) => CONTENT_PRODUCTION_RUNNER_STATUSES.includes(value)),
  revision: z.number().int().min(0),
  current_pause: z
    .object({
      pause_type: contentProductionConfirmationSchema,
      title: z.string().max(1000),
      available_choices: z.array(z.string().max(5000)).max(100),
      revision: z.number().int().min(0),
      requires_user_input: z.literal(true),
      user_pause: z.literal(true),
      must_stop: z.literal(true),
    })
    .nullable(),
  pending_action: z.object({ action: z.string().min(1).max(200) }).nullable(),
  flags: z.object({
    p0_production_step: z
      .enum(["draft", "edit", "titles", "deliver"])
      .optional(),
    article_production_step: z
      .enum(["draft", "edit", "titles", "deliver"])
      .optional(),
  }),
  decisions: z.object({
    reference_pack_route: decision.optional(),
    comparison_scope: decision.optional(),
    positioning_direction: decision.optional(),
    core_positioning_confirmation: decision.optional(),
    example_route: decision.optional(),
    p0_blueprint_confirmation: decision.optional(),
    response_brief_confirmation: decision.optional(),
    pattern: decision.optional(),
    question_positioning_confirmation: decision.optional(),
    article_blueprint_confirmation: decision.optional(),
  }),
  p0_route: z.enum(["create", "import"]).nullable(),
});
export type ContentRunnerObservation = {
  providerRank: number;
  eventId: string;
  artifactId: string;
  sha256: string;
  state: z.infer<typeof runnerStateSchema>;
};
export type ContentProductionProgress = {
  revision: 2;
  lastObservation: ContentRunnerObservation;
  progressPosition: number;
  completedConfirmations: ContentProductionConfirmation[];
};

/** Read original Runner bytes, retaining only fields used by the UI projection. */
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
    const paused = contentProductionConfirmationSchema.safeParse(state.status);
    if (paused.success) {
      if (
        !state.current_pause ||
        state.current_pause.pause_type !== paused.data ||
        state.current_pause.revision !== state.revision ||
        state.pending_action !== null
      )
        return null;
    } else if (state.current_pause !== null) return null;
    if (["positioning_ready", "p0_ready", "completed"].includes(state.status)) {
      if (state.pending_action !== null) return null;
      if (
        state.status === "completed" &&
        (state.job_kind !== "article" || state.stage !== "E10")
      )
        return null;
      if (
        state.status === "p0_ready" &&
        (state.job_kind !== "p0" || state.stage !== "reference_pack")
      )
        return null;
      if (
        state.status === "positioning_ready" &&
        (!["reference_pack", "reference_pack_refresh"].includes(
          state.job_kind,
        ) ||
          state.stage !== "reference_pack")
      )
        return null;
    }
    return state;
  } catch {
    return null;
  }
}

function completedRunnerConfirmations(
  state: ContentRunnerObservation["state"],
): ContentProductionConfirmation[] {
  const result: ContentProductionConfirmation[] = [];
  const decisions = state.decisions;
  if (decisions.reference_pack_route)
    result.push("awaiting_reference_pack_route");
  if (decisions.comparison_scope?.confirmed)
    result.push("awaiting_competitor_selection");
  if (decisions.positioning_direction)
    result.push("awaiting_core_positioning_direction");
  if (decisions.core_positioning_confirmation?.confirmed)
    result.push("awaiting_core_positioning_confirmation");
  if (state.p0_route) result.push("awaiting_p0_route");
  if (decisions.example_route)
    result.push(
      state.job_kind === "p0"
        ? "awaiting_p0_example_confirmation"
        : "awaiting_example_confirmation",
    );
  if (decisions.p0_blueprint_confirmation)
    result.push("awaiting_p0_blueprint_confirmation");
  if (decisions.response_brief_confirmation)
    result.push("awaiting_response_brief");
  if (decisions.pattern) result.push("awaiting_pattern_confirmation");
  if (decisions.question_positioning_confirmation?.confirmed)
    result.push("awaiting_question_positioning_confirmation");
  if (decisions.article_blueprint_confirmation)
    result.push("awaiting_blueprint_confirmation");
  return result.filter((status) => status !== state.status);
}

export function reduceContentProductionProgress(
  previous: ContentProductionProgress | null,
  observation: ContentRunnerObservation,
  mode: ContentProductionMode,
): ContentProductionProgress {
  // v2.3 observations describe a different Runner and must not claim v4.11 progress.
  const current = previous?.revision === 2 ? previous : null;
  if (current) {
    const old = current.lastObservation;
    if (
      // A Session owns one original Job. A native P0/article route may change
      // job_kind to reference_pack, but must never replace its job_id or rewind
      // the revision to adopt another task's confirmation or terminal result.
      observation.state.job_id !== old.state.job_id ||
      observation.state.revision < old.state.revision ||
      observation.providerRank < old.providerRank ||
      compareContentRunnerObservations(observation, old) <= 0
    )
      return current;
  }
  const state = observation.state;
  const position = contentProductionStagePosition(state.stage, state.status);
  const expectedKind = [
    "new_reference_pack",
    "refresh_reference_pack",
  ].includes(mode)
    ? "reference_pack"
    : ["p0", "foundation_article", "import_foundation"].includes(mode)
      ? "p0"
      : "article";
  const isComplete =
    expectedKind === "reference_pack"
      ? ["reference_pack", "reference_pack_refresh"].includes(state.job_kind) &&
        state.status === "positioning_ready"
      : state.job_kind === expectedKind &&
        state.status === (expectedKind === "p0" ? "p0_ready" : "completed");
  return {
    revision: 2,
    lastObservation: observation,
    progressPosition: Math.max(
      current?.progressPosition ?? 0,
      isComplete ? 20 : Math.min(position, 19),
    ),
    completedConfirmations: completedRunnerConfirmations(state),
  };
}

export function compareContentRunnerObservations(
  left: ContentRunnerObservation,
  right: ContentRunnerObservation,
) {
  const time =
    Date.parse(left.state.updated_at) - Date.parse(right.state.updated_at);
  if (time) return time;
  // Python emits UTC microseconds, beyond Date.parse's millisecond resolution.
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
  const stored = providerRuntime?.contentProductionProgress as
    | ContentProductionProgress
    | undefined;
  const progress = stored?.revision === 2 ? stored : null;
  const state = progress?.lastObservation.state ?? null;
  const parsed = contentProductionConfirmationSchema.safeParse(state?.status);
  const confirmation = parsed.success ? parsed.data : null;
  return {
    mode: context.contentProduction.mode,
    enterpriseName: context.contentProduction.enterpriseName,
    workflowVersion: "4.11.0",
    workflowStatus: state?.status ?? null,
    currentStage: state?.stage ?? null,
    jobKind: state?.job_kind ?? null,
    runnerRevision: state?.revision ?? null,
    pauseTitle: contentProductionPauseTitle(
      confirmation,
      state?.current_pause?.title ?? null,
    ),
    choices: (state?.current_pause?.available_choices ?? []).map((choice) =>
      confirmation === "awaiting_core_positioning_direction"
        ? choice
        : contentProductionPublicText(choice),
    ),
    productionStep:
      state?.flags.p0_production_step ??
      state?.flags.article_production_step ??
      null,
    confirmation,
    progressPosition: progress?.progressPosition ?? 0,
    completedConfirmations: progress?.completedConfirmations ?? [],
    availableActions: confirmation
      ? CONTENT_PRODUCTION_CONFIRMATION_ACTIONS[confirmation]
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
          enterpriseAccountOwnerPredicate(agentOperations, input.userId),
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
