import { z } from "zod";

export const contentProductionModeSchema = z.enum([
  "new_reference_pack",
  "refresh_reference_pack",
  "p0",
  // Existing conversation metadata remains readable; new tasks use the P0 route.
  "foundation_article",
  "import_foundation",
  "single_article",
]);
export const contentProductionInputSchema = z
  .object({
    mode: contentProductionModeSchema,
    enterpriseName: z.string().trim().min(1).max(200),
    knowledgeSource: z.enum(["published", "files"]),
    entry: z
      .enum([
        "industry_ranking",
        "competitor_comparison",
        "reputation",
        "product_scenario",
      ])
      .optional(),
    questionId: z.string().trim().min(1).max(200).optional(),
    question: z.string().trim().max(20_000).optional(),
    monitoringAnswerAssetIds: z
      .array(z.string().trim().min(1).max(36))
      .max(16)
      .default([]),
    sourceWorkbookAssetId: z.string().trim().min(1).max(36).optional(),
  })
  .strict();

export const CONTENT_PRODUCTION_CONFIRMATIONS = [
  "awaiting_reference_pack_route",
  "awaiting_reference_pack_input",
  "awaiting_question_research_inputs",
  "awaiting_competitor_selection",
  "awaiting_core_positioning_direction",
  "awaiting_core_positioning_confirmation",
  "awaiting_p0_route",
  "awaiting_p0_example_confirmation",
  "awaiting_p0_blueprint_confirmation",
  "awaiting_response_brief",
  "awaiting_pattern_confirmation",
  "awaiting_example_confirmation",
  "awaiting_question_positioning_confirmation",
  "awaiting_blueprint_confirmation",
] as const;
export const contentProductionConfirmationSchema = z.enum(
  CONTENT_PRODUCTION_CONFIRMATIONS,
);
const revision = z.number().int().min(0);
const text = z.string().trim().min(1).max(20_000);
export const contentProductionActionSchema = z
  .discriminatedUnion("kind", [
    z
      .object({
        kind: z.literal("choose_reference_pack_route"),
        revision,
        route: z.enum(["use", "create"]),
      })
      .strict(),
    z
      .object({ kind: z.literal("provide_reference_pack_inputs"), revision })
      .strict(),
    z
      .object({ kind: z.literal("provide_question_research_inputs"), revision })
      .strict(),
    z
      .object({
        kind: z.literal("update_competitor_selection"),
        revision,
        selection: text,
      })
      .strict(),
    z.object({ kind: z.literal("confirm_competitors"), revision }).strict(),
    z
      .object({
        kind: z.literal("choose_core_positioning_direction"),
        revision,
        direction: text,
      })
      .strict(),
    z
      .object({ kind: z.literal("confirm_core_positioning"), revision })
      .strict(),
    z
      .object({
        kind: z.literal("choose_p0_route"),
        revision,
        route: z.enum(["create", "import"]),
      })
      .strict(),
    z
      .object({
        kind: z.literal("choose_p0_examples"),
        revision,
        route: z.enum(["top20", "workflow"]),
      })
      .strict(),
    z
      .object({
        kind: z.literal("confirm_p0_blueprint"),
        revision,
        blueprintEdits: text.optional(),
      })
      .strict(),
    z
      .object({
        kind: z.literal("submit_response_brief"),
        revision,
        requirements: text.optional(),
        noExtraRequirements: z.boolean().optional(),
        aiBrandRecognition: z.enum(["sufficient", "insufficient", "uncertain"]),
      })
      .strict(),
    z
      .object({
        kind: z.literal("confirm_pattern"),
        revision,
        selectedPattern: z
          .string()
          .regex(/^P0[1-6]$/u)
          .optional(),
      })
      .strict(),
    z
      .object({
        kind: z.literal("choose_examples"),
        revision,
        route: z.enum(["A", "B"]),
      })
      .strict(),
    z
      .object({ kind: z.literal("confirm_question_positioning"), revision })
      .strict(),
    z
      .object({
        kind: z.literal("confirm_blueprint"),
        revision,
        blueprintEdits: text.optional(),
      })
      .strict(),
    z
      .object({
        kind: z.literal("revise_current_step"),
        revision,
        instructions: text,
      })
      .strict(),
  ])
  .superRefine((action, ctx) => {
    if (
      action.kind === "submit_response_brief" &&
      Boolean(action.requirements) === (action.noExtraRequirements === true)
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "提交额外要求或明确无额外要求，两者只能选择一个。",
      });
    }
  });
export type ContentProductionMode = z.infer<typeof contentProductionModeSchema>;
export type ContentProductionInput = z.infer<
  typeof contentProductionInputSchema
>;
export type ContentProductionConfirmation = z.infer<
  typeof contentProductionConfirmationSchema
>;
export type ContentProductionAction = z.infer<
  typeof contentProductionActionSchema
>;
export type ContentProductionJobKind =
  | "reference_pack"
  | "reference_pack_refresh"
  | "p0"
  | "article";
export type ContentProductionKnowledgeSource = {
  snapshotId: string;
  version: number;
  sourceFileName: string;
  documentCount: number;
  contentHash: string;
};
export type ContentProductionDto = {
  mode: ContentProductionMode;
  enterpriseName: string;
  workflowVersion: "4.11.0";
  workflowStatus: string | null;
  currentStage: string | null;
  jobKind: ContentProductionJobKind | null;
  runnerRevision: number | null;
  pauseTitle: string | null;
  choices: string[];
  productionStep: string | null;
  confirmation: ContentProductionConfirmation | null;
  /** Highest observed position; corrections keep their actual current pause. */
  progressPosition: number;
  completedConfirmations: ContentProductionConfirmation[];
  availableActions: ContentProductionAction["kind"][];
  knowledgeBase: ContentProductionKnowledgeSource | null;
  source: "runner_job_state" | "awaiting_runner";
};
export type ContentProductionCreateFields = {
  purpose: "content_production";
  contentProduction: ContentProductionInput;
};
export type ContentProductionContinueFields = {
  contentProductionAction?: ContentProductionAction;
};

export const CONTENT_PRODUCTION_CONFIRMATION_ACTIONS: Record<
  ContentProductionConfirmation,
  ContentProductionAction["kind"][]
> = {
  awaiting_reference_pack_route: [
    "choose_reference_pack_route",
    "revise_current_step",
  ],
  awaiting_reference_pack_input: [
    "provide_reference_pack_inputs",
    "revise_current_step",
  ],
  awaiting_question_research_inputs: [
    "provide_question_research_inputs",
    "revise_current_step",
  ],
  awaiting_competitor_selection: [
    "update_competitor_selection",
    "confirm_competitors",
    "revise_current_step",
  ],
  awaiting_core_positioning_direction: [
    "choose_core_positioning_direction",
    "revise_current_step",
  ],
  awaiting_core_positioning_confirmation: [
    "confirm_core_positioning",
    "revise_current_step",
  ],
  awaiting_p0_route: ["choose_p0_route", "revise_current_step"],
  awaiting_p0_example_confirmation: [
    "choose_p0_examples",
    "revise_current_step",
  ],
  awaiting_p0_blueprint_confirmation: [
    "confirm_p0_blueprint",
    "revise_current_step",
  ],
  awaiting_response_brief: ["submit_response_brief", "revise_current_step"],
  awaiting_pattern_confirmation: ["confirm_pattern", "revise_current_step"],
  awaiting_example_confirmation: ["choose_examples", "revise_current_step"],
  awaiting_question_positioning_confirmation: [
    "confirm_question_positioning",
    "revise_current_step",
  ],
  awaiting_blueprint_confirmation: ["confirm_blueprint", "revise_current_step"],
};

const STATUS_POSITIONS: Record<string, number> = {
  awaiting_reference_pack_route: 1,
  awaiting_reference_pack_input: 1,
  running_reference_material_intake: 2,
  running_positioning_market_research: 3,
  awaiting_competitor_selection: 4,
  running_positioning_value_synthesis: 5,
  running_positioning_competitive_tiering: 3,
  running_positioning_brand_placement: 3,
  running_positioning_positioning_polish: 5,
  running_positioning_choice_map: 3,
  running_positioning_direction_generation: 5,
  running_positioning_direction_critique: 5,
  awaiting_core_positioning_direction: 5,
  running_core_positioning_synthesis: 5,
  running_core_positioning_critique: 5,
  awaiting_core_positioning_confirmation: 6,
  running_reference_pack_assembly: 7,
  positioning_ready: 7,
  awaiting_p0_route: 8,
  running_p0_example_discovery: 9,
  awaiting_p0_example_confirmation: 9,
  running_p0_blueprint: 10,
  awaiting_p0_blueprint_confirmation: 10,
  running_p0_production: 11,
  running_reference_pack_p0_commit: 12,
  p0_ready: 12,
  awaiting_question_research_inputs: 13,
  awaiting_response_brief: 14,
  running_answer_analysis: 15,
  awaiting_pattern_confirmation: 15,
  awaiting_example_confirmation: 16,
  running_question_positioning: 17,
  awaiting_question_positioning_confirmation: 17,
  running_article_blueprint: 18,
  awaiting_blueprint_confirmation: 18,
  running_article_production: 19,
  completed: 20,
};
export const CONTENT_PRODUCTION_RUNNER_STATUSES = Object.keys(STATUS_POSITIONS);
export function contentProductionStagePosition(
  stage: string | null,
  status?: string | null,
): number {
  if (status && STATUS_POSITIONS[status] !== undefined)
    return STATUS_POSITIONS[status];
  const stages: Record<string, number> = {
    intake: 1,
    reference_pack_route: 1,
    reference_pack_input: 1,
    positioning_research: 3,
    positioning: 5,
    reference_pack_assembly: 7,
    reference_pack: 7,
    p0_route: 8,
    p0_examples: 9,
    p0_blueprint: 10,
    p0_production: 11,
    p0_commit: 12,
    question_research: 13,
    E1: 14,
    E2: 15,
    examples: 16,
    question_positioning: 17,
    blueprint: 18,
    article_blueprint: 18,
    article_production: 19,
    E10: 20,
  };
  return stages[stage ?? ""] ?? 0;
}
