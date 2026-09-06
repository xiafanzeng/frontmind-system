import { z } from "zod";

export const contentProductionModeSchema = z.enum([
  "new_reference_pack",
  "refresh_reference_pack",
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
    question: z.string().trim().max(20_000).optional(),
    monitoringAnswerAssetIds: z
      .array(z.string().trim().min(1).max(36))
      .max(16)
      .default([]),
    sourceWorkbookAssetId: z.string().trim().min(1).max(36).optional(),
  })
  .strict();
export const CONTENT_PRODUCTION_CONFIRMATIONS = [
  "awaiting_pack_confirmation",
  "awaiting_research_inputs",
  "awaiting_pattern_confirmation",
  "awaiting_blueprint_confirmation",
  "awaiting_title_count",
] as const;
export const contentProductionConfirmationSchema = z.enum(
  CONTENT_PRODUCTION_CONFIRMATIONS,
);
export const contentProductionActionSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("confirm_pack") }).strict(),
  z.object({ kind: z.literal("provide_research_inputs") }).strict(),
  z
    .object({
      kind: z.literal("confirm_pattern"),
      selectedPattern: z
        .string()
        .regex(/^P\d{2}$/u)
        .optional(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("confirm_blueprint"),
      blueprintEdits: z.string().trim().max(20_000).optional(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("set_title_count"),
      titleCount: z.number().int().min(1).max(20),
    })
    .strict(),
]);
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
  workflowVersion: "2.3.0";
  workflowStatus: string | null;
  currentStage: string | null;
  confirmation: ContentProductionConfirmation | null;
  /** Monotonic display position, 0 before any Runner state is observed. */
  progressPosition: number;
  completedConfirmations: ContentProductionConfirmation[];
  availableActions: ContentProductionAction["kind"][];
  knowledgeBase: ContentProductionKnowledgeSource | null;
  source: "runner_job_state" | "awaiting_runner";
};

/** POST /v2/tasks: purpose + contentProduction; ordinary prompt and uploads stay unchanged. */
export type ContentProductionCreateFields = {
  purpose: "content_production";
  contentProduction: ContentProductionInput;
};
/** POST /v2/tasks/:id/messages: optional action alongside the original prompt and localAssetIds. */
export type ContentProductionContinueFields = {
  contentProductionAction?: ContentProductionAction;
};

export function contentProductionStagePosition(stage: string | null): number {
  const match = /^(S([1-9])|E([1-9]|10))$/u.exec(stage ?? "");
  return match ? (match[2] ? Number(match[2]) : 9 + Number(match[3])) : 0;
}
export const CONTENT_PRODUCTION_CONFIRMATION_ACTIONS: Record<
  ContentProductionConfirmation,
  ContentProductionAction["kind"]
> = {
  awaiting_pack_confirmation: "confirm_pack",
  awaiting_research_inputs: "provide_research_inputs",
  awaiting_pattern_confirmation: "confirm_pattern",
  awaiting_blueprint_confirmation: "confirm_blueprint",
  awaiting_title_count: "set_title_count",
};
