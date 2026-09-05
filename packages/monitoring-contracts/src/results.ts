import { z } from "zod";
import { idSchema } from "./monitoring.js";
import {
  attemptStatusSchema,
  runStatusSchema,
  sentimentSchema,
} from "./statuses.js";

export const providerRegionSchema = z.object({
  code: z.string().min(1).max(64),
  scope: z.enum(["domestic", "overseas"]),
  name: z.string().min(1).max(120),
  syncedAt: z.coerce.date(),
});
export type ProviderRegion = z.infer<typeof providerRegionSchema>;

export const keywordNatureSchema = z.enum(["positive", "neutral", "negative"]);
export type KeywordNature = z.infer<typeof keywordNatureSchema>;

export const citationProvenanceSchema = z.enum([
  "explicit",
  "legacy_assumed",
  "unavailable",
]);
export type CitationProvenance = z.infer<typeof citationProvenanceSchema>;

export const keywordEvaluationSchema = z.object({
  keyword: z.string().trim().min(1),
  nature: keywordNatureSchema,
  context: z.string().nullable(),
});
export type KeywordEvaluation = z.infer<typeof keywordEvaluationSchema>;

export const sourceSchema = z.object({
  id: idSchema,
  ordinal: z.number().int().nonnegative(),
  providerPosition: z.number().int().positive().nullable(),
  url: z.string().url(),
  title: z.string(),
  domain: z.string(),
  siteName: z.string().nullable(),
  summary: z.string().nullable(),
  publishedAt: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/u)
    .nullable(),
  citationProvenance: citationProvenanceSchema,
  citedText: z.string().nullable(),
});

export const discoveredSourceSchema = sourceSchema
  .omit({ citedText: true })
  .extend({
    isCited: z.boolean(),
  });

export const mediaSchema = z.object({
  id: idSchema,
  type: z.enum(["screenshot", "image", "video", "goods", "raw_response"]),
  ordinal: z.number().int().nonnegative(),
  archiveStatus: z.enum(["pending", "archived", "failed", "not_applicable"]),
  accessPath: z.string().startsWith("/api/media/").nullable(),
  thumbnailAccessPath: z.string().startsWith("/api/media/").nullable(),
  mimeType: z.string().nullable(),
  sizeBytes: z.number().int().nonnegative().nullable(),
});

export const attemptResultSchema = z.object({
  answerMarkdown: z.string(),
  reasoningMarkdown: z.string().nullable(),
  searchKeywords: z.array(z.string()),
  sentiment: sentimentSchema,
  brandMentioned: z.boolean(),
  mentionPosition: z.number().int().positive().nullable(),
  sources: z.array(sourceSchema),
  media: z.array(mediaSchema),
  competitorRankings: z.array(z.record(z.string(), z.unknown())),
  keywordEvaluations: z.array(keywordEvaluationSchema),
  citationProvenance: citationProvenanceSchema,
  revision: z.number().int().positive(),
  contentHash: z.string(),
  updatedAt: z.string().datetime(),
});

export const attemptViewSchema = z.object({
  id: idSchema,
  question: z.string(),
  providerCode: z.string(),
  repetition: z.number().int().positive(),
  status: attemptStatusSchema,
  errorMessage: z.string().nullable(),
  result: attemptResultSchema.nullable(),
});

export const runSummarySchema = z.object({
  id: idSchema,
  monitorId: idSchema,
  status: runStatusSchema,
  expectedAttempts: z.number().int().nonnegative(),
  completedAttempts: z.number().int().nonnegative(),
  failedAttempts: z.number().int().nonnegative(),
  stoppedAttempts: z.number().int().nonnegative(),
  startedAt: z.string().datetime().nullable(),
  completedAt: z.string().datetime().nullable(),
  createdAt: z.string().datetime(),
});
