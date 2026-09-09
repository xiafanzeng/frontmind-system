import { z } from "zod";

export const WORKBENCH_AGENT_IDS = [
  "general",
  "knowledge",
  "keywords",
  "questions",
  "response-logic",
  "monitoring",
  "reports",
  "content",
  "publishing",
  "articles",
  "media",
  "enterprise-qa",
  "website",
  "content-insights",
] as const;
export const workbenchAgentIdSchema = z.enum(WORKBENCH_AGENT_IDS);
export type WorkbenchAgentId = z.infer<typeof workbenchAgentIdSchema>;
export const workbenchResourceSchema = z.object({
  kind: z.enum([
    "article",
    "article_version",
    "publication_draft",
    "publication_batch",
    "monitoring_run",
    "question",
    "knowledge_snapshot",
    "site",
  ]),
  id: z.string().min(1).max(191),
  label: z.string().max(255).optional(),
});
export type WorkbenchResourceRef = z.infer<typeof workbenchResourceSchema>;
export const workbenchRecordSchema = z.object({
  id: z.string().min(1).max(128),
  label: z.string().min(1).max(255),
  status: z.enum(["completed", "failed", "pending"]),
  detail: z.string().max(2000).optional(),
});
export const workbenchValuesSchema = z
  .record(z.string(), z.unknown())
  .refine((value) => JSON.stringify(value).length <= 100_000, "任务草稿过大");
export const workbenchStatePatchSchema = z.object({
  step: z.string().min(1).max(128).optional(),
  values: workbenchValuesSchema.optional(),
  resources: z.array(workbenchResourceSchema).max(100).optional(),
  record: workbenchRecordSchema.optional(),
});
export type WorkbenchStatePatch = z.infer<typeof workbenchStatePatchSchema>;
export const workbenchTaskStateSchema = z.object({
  schemaVersion: z.literal(1),
  agentId: workbenchAgentIdSchema,
  revision: z.number().int().positive(),
  step: z.string().max(128),
  values: workbenchValuesSchema,
  resources: z.array(workbenchResourceSchema).max(100),
  records: z
    .array(
      workbenchRecordSchema.extend({
        timestamp: z.number(),
        targetTask: z
          .object({
            conversationId: z.string(),
            agentId: workbenchAgentIdSchema,
          })
          .optional(),
      }),
    )
    .max(500),
  source: z
    .object({ conversationId: z.string(), agentId: workbenchAgentIdSchema })
    .optional(),
  updatedAt: z.number(),
});
export type WorkbenchTaskState = z.infer<typeof workbenchTaskStateSchema>;

/** Only presentation state lives here. Domain mutations still verify their own facts. */
export function initialWorkbenchTaskState(
  agentId: WorkbenchAgentId,
  now = Date.now(),
): WorkbenchTaskState {
  return {
    schemaVersion: 1,
    agentId,
    revision: 1,
    step: "start",
    values: {},
    resources: [],
    records: [],
    updatedAt: now,
  };
}
