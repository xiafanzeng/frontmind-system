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
    "monitoring_project",
    "monitor",
    "question",
    "knowledge_snapshot",
    "site",
  ]),
  id: z.string().min(1).max(191),
  label: z.string().max(255).optional(),
});
export type WorkbenchResourceRef = z.infer<typeof workbenchResourceSchema>;
/** An append-only index of saved outputs, never a cache of domain status. */
export const workbenchOutputRefSchema = z.object({
  resource: workbenchResourceSchema,
  version: z.string().min(1).max(191).optional(),
  sourceStepId: z.string().min(1).max(128),
  sourceMessageId: z.string().min(1).max(191).optional(),
});
export type WorkbenchOutputRef = z.infer<typeof workbenchOutputRefSchema>;
export function mergeWorkbenchOutputRefs(
  previous: WorkbenchOutputRef[] = [],
  additions: WorkbenchOutputRef[] = [],
): WorkbenchOutputRef[] {
  const refs = new Map<string, WorkbenchOutputRef>();
  for (const ref of [...previous, ...additions]) {
    const key = JSON.stringify([ref.resource.kind, ref.resource.id, ref.version ?? null]);
    if (!refs.has(key)) refs.set(key, ref);
  }
  return [...refs.values()];
}
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
  outputRefs: z.array(workbenchOutputRefSchema).max(500).optional(),
  record: workbenchRecordSchema.optional(),
  records: z.array(workbenchRecordSchema).max(100).optional(),
});
export type WorkbenchStatePatch = z.infer<typeof workbenchStatePatchSchema>;
export const workbenchTaskStateSchema = z.object({
  schemaVersion: z.literal(1),
  agentId: workbenchAgentIdSchema,
  revision: z.number().int().positive(),
  step: z.string().max(128),
  values: workbenchValuesSchema,
  resources: z.array(workbenchResourceSchema).max(100),
  outputRefs: z.array(workbenchOutputRefSchema).max(500).optional(),
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

export function mergeWorkbenchTaskProjection(local?: WorkbenchTaskState, remote?: WorkbenchTaskState) {
  if (!remote) return local;
  if (!local || local.agentId !== remote.agentId) return remote;
  const newest = local.revision > remote.revision ? local : remote;
  const outputRefs = mergeWorkbenchOutputRefs(local.outputRefs, remote.outputRefs);
  return { ...newest, ...(outputRefs.length ? { outputRefs } : {}) };
}

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
