import { z } from "zod";

import { responseLogicDraftSchema } from "./response-logic";
import { publicServicePortalQuestionSchema } from "./service-portal";

export const historicalResponseLogicResultSchema = z.object({
  recordId: z.string(),
  questionId: z.string(),
  status: z.enum(["confirmed", "draft"]),
  version: z.number().int().nonnegative(),
  updatedAt: z.number().int(),
  content: responseLogicDraftSchema,
});

export const historicalMonitoringSampleSchema = z.object({
  id: z.string(),
  sourceRecordId: z.string(),
  questionId: z.string(),
  platform: z.string(),
  answerNo: z.number().int().positive(),
  content: z.string(),
  citationCount: z.number().int().nonnegative(),
  monitorRank: z.number().nullable(),
  screenshotUrl: z.string().nullable(),
  collectedAt: z.number().int(),
  batchKey: z.string(),
  sourceName: z.string(),
  batchRevision: z.number().int().positive(),
});

export const historicalMonitoringCitationSchema = z.object({
  id: z.string(),
  sourceRecordId: z.string(),
  sampleId: z.string().nullable(),
  questionId: z.string(),
  question: z.string(),
  model: z.string(),
  title: z.string(),
  url: z.string(),
  media: z.string(),
  domain: z.string(),
  publishedAt: z.number().int().nullable(),
  collectedAt: z.number().int(),
  batchKey: z.string(),
  sourceName: z.string(),
  batchRevision: z.number().int().positive(),
});

/**
 * Deliberately contains no conversation or task identifiers and has no
 * companion mutation. It is the only DTO consumed by the historical-results
 * page.
 */
export const historicalQuestionResultsSchema = z.object({
  readOnly: z.literal(true),
  question: publicServicePortalQuestionSchema,
  lineageQuestionIds: z.array(z.string()).min(1),
  responseLogic: z.array(historicalResponseLogicResultSchema).max(100),
  monitoring: z.object({
    samples: z.array(historicalMonitoringSampleSchema).max(100),
    sampleTotal: z.number().int().nonnegative(),
    citations: z.array(historicalMonitoringCitationSchema).max(100),
    citationTotal: z.number().int().nonnegative(),
  }),
});

export type HistoricalQuestionResults = z.infer<
  typeof historicalQuestionResultsSchema
>;
