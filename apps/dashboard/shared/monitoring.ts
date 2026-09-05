import { z } from "zod";

const identifierSchema = z.string().trim().min(1).max(191);
const boundedDateSchema = z
  .string()
  .trim()
  .min(1)
  .max(64)
  .refine((value) => Number.isFinite(Date.parse(value)), "日期格式无效");

export const monitoringSampleImportSchema = z
  .object({
    sourceRecordId: identifierSchema,
    questionId: identifierSchema,
    platform: z.string().trim().min(1).max(128),
    answerNo: z.number().int().positive().max(10_000).default(1),
    content: z.string().trim().max(200_000).default(""),
    citationCount: z.number().int().nonnegative().max(100_000).optional(),
    monitorRank: z.number().int().positive().max(100_000).optional(),
    screenshotUrl: z.string().trim().max(2_048).default(""),
    collectedAt: boundedDateSchema.optional(),
  })
  .strict();

export const monitoringCitationImportSchema = z
  .object({
    sourceRecordId: identifierSchema,
    questionId: identifierSchema,
    sampleSourceRecordId: identifierSchema.optional(),
    model: z.string().trim().min(1).max(128),
    title: z.string().trim().max(1_000).default(""),
    url: z.string().trim().max(2_048).default(""),
    media: z.string().trim().max(255).default(""),
    domain: z.string().trim().max(255).default(""),
    publishedAt: boundedDateSchema.optional(),
    collectedAt: boundedDateSchema.optional(),
  })
  .strict();

export const replaceMonitoringBatchSchema = z
  .object({
    userId: z.number().int().positive(),
    batchKey: identifierSchema,
    sourceName: z.string().trim().min(1).max(512),
    collectedAt: boundedDateSchema,
    samples: z.array(monitoringSampleImportSchema).max(100_000).default([]),
    citations: z.array(monitoringCitationImportSchema).max(100_000).default([]),
  })
  .strict()
  .refine(
    (value) => value.samples.length > 0 || value.citations.length > 0,
    "监控样本和引用记录不能同时为空",
  );

const listBaseSchema = z
  .object({
    questionId: identifierSchema.optional(),
    batchKey: identifierSchema.optional(),
    from: boundedDateSchema.optional(),
    to: boundedDateSchema.optional(),
    query: z.string().trim().max(500).default(""),
    page: z.number().int().positive().max(1_000_000).default(1),
    pageSize: z.number().int().positive().max(100).default(25),
  })
  .strict();

export const listMonitoringSamplesSchema = listBaseSchema.extend({
  /** @deprecated Use model. Kept for existing clients and imported data. */
  platform: z.string().trim().min(1).max(128).optional(),
  model: z.string().trim().min(1).max(128).optional(),
  sortOrder: z.enum(["asc", "desc"]).default("desc"),
});

export const listMonitoringCitationsSchema = listBaseSchema.extend({
  sampleId: identifierSchema.optional(),
  model: z.string().trim().min(1).max(128).optional(),
  media: z.string().trim().min(1).max(255).optional(),
  domain: z.string().trim().min(1).max(255).optional(),
  sortBy: z
    .enum(["collectedAt", "publishedAt", "question", "model", "title", "media"])
    .default("collectedAt"),
  sortOrder: z.enum(["asc", "desc"]).default("desc"),
});

export const monitoringCitationSummarySchema = z
  .object({
    batchKey: identifierSchema.optional(),
    questionId: identifierSchema,
    model: z.string().trim().min(1).max(128).optional(),
    from: boundedDateSchema.optional(),
    to: boundedDateSchema.optional(),
  })
  .strict()
  .refine(
    (value) =>
      !value.from ||
      !value.to ||
      new Date(value.from).getTime() <= new Date(value.to).getTime(),
    {
      message: "监控日期区间无效",
      path: ["to"],
    },
  );

export const monitoringFilterOptionsSchema = z
  .object({
    batchKey: identifierSchema.optional(),
    questionId: identifierSchema.optional(),
  })
  .strict();

export const listMonitoringSampleCitationsSchema = z
  .object({
    batchKey: identifierSchema,
    questionId: identifierSchema,
    /** Server-generated monitoring_samples.id. Source record IDs are rejected. */
    sampleId: z.string().uuid(),
    cursor: z.string().uuid().optional(),
    limit: z.number().int().positive().max(100).default(50),
  })
  .strict();

export type MonitoringSampleImport = z.infer<
  typeof monitoringSampleImportSchema
>;
export type MonitoringCitationImport = z.infer<
  typeof monitoringCitationImportSchema
>;
export type ReplaceMonitoringBatchInput = z.infer<
  typeof replaceMonitoringBatchSchema
>;
export type ListMonitoringSamplesInput = z.infer<
  typeof listMonitoringSamplesSchema
>;
export type ListMonitoringCitationsInput = z.infer<
  typeof listMonitoringCitationsSchema
>;
export type MonitoringCitationSummaryInput = z.infer<
  typeof monitoringCitationSummarySchema
>;
export type MonitoringFilterOptionsInput = z.infer<
  typeof monitoringFilterOptionsSchema
>;
export type ListMonitoringSampleCitationsInput = z.infer<
  typeof listMonitoringSampleCitationsSchema
>;
