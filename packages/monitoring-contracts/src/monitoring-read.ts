import { z } from "zod";
import { idSchema } from "./monitoring.js";
import {
  attemptStatusSchema,
  clientTypeSchema,
  monitorStatusSchema,
  providerModeSchema,
  sentimentSchema,
} from "./statuses.js";
import { citationProvenanceSchema } from "./results.js";

const MAX_MONITORING_SCOPE_DURATION_MS = 366 * 86_400_000;

export const monitoringSubjectSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("self") }),
  z.object({
    kind: z.literal("competitor"),
    name: z.string().trim().min(1).max(120),
  }),
]);
export type MonitoringSubject = z.infer<typeof monitoringSubjectSchema>;

/**
 * Every monitoring read is explicitly time-bound. The repository also checks
 * that optional dimensions and competitor subjects belong to the monitor's
 * current immutable configuration version.
 */
export const monitoringScopeSchema = z
  .object({
    monitorId: idSchema,
    from: z.coerce.date(),
    to: z.coerce.date(),
    questionId: idSchema.optional(),
    platformId: idSchema.optional(),
    subject: monitoringSubjectSchema,
  })
  .superRefine((value, ctx) => {
    if (value.from >= value.to) {
      ctx.addIssue({
        code: "custom",
        path: ["to"],
        message: "The end date must be later than the start date",
      });
    }
    if (
      value.to.getTime() - value.from.getTime() >
      MAX_MONITORING_SCOPE_DURATION_MS
    ) {
      ctx.addIssue({
        code: "custom",
        path: ["to"],
        message: "The date range must not exceed 366 days",
      });
    }
  });
export type MonitoringScope = z.infer<typeof monitoringScopeSchema>;

export const monitoringAnswersListInputSchema = z.object({
  scope: monitoringScopeSchema,
  cursor: z.string().trim().min(1).max(2_048).optional(),
  limit: z.number().int().min(1).max(50).default(20),
});
export type MonitoringAnswersListInput = z.infer<
  typeof monitoringAnswersListInputSchema
>;

export const monitoringAnswerGetInputSchema = z.object({
  monitorId: idSchema,
  answerId: idSchema,
  subject: monitoringSubjectSchema.default({ kind: "self" }),
});

export const monitoringAnalysisKindSchema = z.enum([
  "metrics",
  "trends",
  "competitors",
  "citations",
  "sources",
]);
export const monitoringAnalysisInputSchema = z.object({
  scope: monitoringScopeSchema,
  kind: monitoringAnalysisKindSchema,
});
export type MonitoringAnalysisInput = z.infer<
  typeof monitoringAnalysisInputSchema
>;

const nonnegativeIntegerSchema = z.number().int().nonnegative();
const nullableRateSchema = z.number().min(0).max(1).nullable();

export const monitoringMetricSetOutputSchema = z.object({
  runs: nonnegativeIntegerSchema,
  attempts: nonnegativeIntegerSchema,
  answers: nonnegativeIntegerSchema,
  mentionedAnswers: nonnegativeIntegerSchema,
  mentionRate: nullableRateSchema,
  averagePosition: z.number().positive().nullable(),
  top1Rate: nullableRateSchema,
  top3Rate: nullableRateSchema,
  top10Rate: nullableRateSchema,
  citationCount: nonnegativeIntegerSchema,
  discoveredSourceCount: nonnegativeIntegerSchema,
  uniqueDomainCount: nonnegativeIntegerSchema,
  sentiments: z
    .object({
      positive: nonnegativeIntegerSchema,
      neutral: nonnegativeIntegerSchema,
      negative: nonnegativeIntegerSchema,
      unknown: nonnegativeIntegerSchema,
    })
    .nullable(),
});

export const monitoringSummaryOutputSchema = z.object({
  monitor: z.object({
    id: idSchema,
    name: z.string(),
    status: monitorStatusSchema,
    activeVersionId: idSchema.nullable(),
    activeVersion: z.number().int().positive().nullable(),
  }),
  filters: z.object({
    questions: z.array(
      z.object({
        id: idSchema,
        ordinal: nonnegativeIntegerSchema,
        label: z.string(),
      }),
    ),
    platforms: z.array(
      z.object({
        id: idSchema,
        ordinal: nonnegativeIntegerSchema,
        providerCode: z.string().trim().min(1).max(64),
        displayName: z.string(),
        clientType: clientTypeSchema,
        mode: providerModeSchema,
      }),
    ),
    subjects: z.array(
      z.discriminatedUnion("kind", [
        z.object({ kind: z.literal("self"), label: z.string() }),
        z.object({
          kind: z.literal("competitor"),
          name: z.string(),
          label: z.string(),
        }),
      ]),
    ),
  }),
  metrics: monitoringMetricSetOutputSchema,
});

const monitoringPlatformViewOutputSchema = z.object({
  id: idSchema,
  providerCode: z.string().trim().min(1).max(64),
  displayName: z.string(),
  clientType: clientTypeSchema,
  mode: providerModeSchema,
});

export const monitoringAnswersListOutputSchema = z.object({
  items: z.array(
    z.object({
      answerId: idSchema,
      runId: idSchema,
      runCreatedAt: z.coerce.date(),
      questionId: idSchema,
      question: z.string(),
      platform: monitoringPlatformViewOutputSchema,
      repetition: z.number().int().positive(),
      status: attemptStatusSchema,
      result: z
        .object({
          answerPreview: z.string(),
          sentiment: sentimentSchema,
          mentioned: z.boolean(),
          position: z.number().int().positive().nullable(),
          citationProvenance: citationProvenanceSchema,
          citationCount: nonnegativeIntegerSchema,
          referenceCount: nonnegativeIntegerSchema,
          screenshotCount: nonnegativeIntegerSchema,
          updatedAt: z.coerce.date(),
        })
        .nullable(),
    }),
  ),
  nextCursor: z.string().nullable(),
});

const monitoringCitationOutputSchema = z.object({
  id: idSchema,
  ordinal: nonnegativeIntegerSchema,
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
  citedText: z.string().nullable(),
});

const monitoringReferenceOutputSchema = monitoringCitationOutputSchema
  .omit({ citedText: true })
  .extend({ isCited: z.boolean() });

export const monitoringAnswerDetailOutputSchema = z.object({
  answerId: idSchema,
  runId: idSchema,
  runCreatedAt: z.coerce.date(),
  questionId: idSchema,
  question: z.string(),
  platform: monitoringPlatformViewOutputSchema,
  repetition: z.number().int().positive(),
  status: attemptStatusSchema,
  answerMarkdown: z.string(),
  reasoningMarkdown: z.string().nullable(),
  searchKeywords: z.array(z.string()),
  sentiment: sentimentSchema,
  mentioned: z.boolean(),
  position: z.number().int().positive().nullable(),
  rankings: z.array(
    z.object({
      subject: z.discriminatedUnion("kind", [
        z.object({ kind: z.literal("self"), name: z.string() }),
        z.object({ kind: z.literal("competitor"), name: z.string() }),
      ]),
      mentioned: z.boolean(),
      position: z.number().int().positive().nullable(),
    }),
  ),
  citationProvenance: citationProvenanceSchema,
  citationList: z.array(monitoringCitationOutputSchema),
  referenceList: z.array(monitoringReferenceOutputSchema),
  archivedScreenshots: z.array(
    z.object({
      id: idSchema,
      ordinal: nonnegativeIntegerSchema,
      archiveStatus: z.enum([
        "pending",
        "archived",
        "failed",
        "not_applicable",
      ]),
      accessPath: z.string().startsWith("/api/monitoring/media/").nullable(),
      thumbnailAccessPath: z.string().startsWith("/api/monitoring/media/").nullable(),
      mimeType: z.string().nullable(),
      sizeBytes: nonnegativeIntegerSchema.nullable(),
    }),
  ),
});

const monitoringCompetitorMetricOutputSchema = z.object({
  name: z.string(),
  appearances: nonnegativeIntegerSchema,
  answerCount: nonnegativeIntegerSchema,
  mentionRate: nullableRateSchema,
  averagePosition: z.number().positive().nullable(),
  highPositionExposure: nullableRateSchema,
});

const monitoringDomainMetricOutputSchema = z.object({
  domain: z.string(),
  count: nonnegativeIntegerSchema,
});

export const monitoringAnalysisOutputSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("metrics"),
    metrics: monitoringMetricSetOutputSchema,
    rows: z.array(
      z.object({
        questionId: idSchema,
        question: z.string(),
        ordinal: nonnegativeIntegerSchema,
        metrics: monitoringMetricSetOutputSchema,
      }),
    ),
  }),
  z.object({
    kind: z.literal("trends"),
    granularity: z.literal("day"),
    points: z.array(
      z.object({
        date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/u),
        metrics: monitoringMetricSetOutputSchema,
      }),
    ),
  }),
  z.object({
    kind: z.literal("competitors"),
    items: z.array(monitoringCompetitorMetricOutputSchema),
  }),
  z.object({
    kind: z.literal("citations"),
    total: nonnegativeIntegerSchema,
    items: z.array(monitoringDomainMetricOutputSchema),
    contents: z.array(
      z.object({
        title: z.string(),
        url: z.string().url(),
        domain: z.string(),
        count: nonnegativeIntegerSchema,
      }),
    ),
  }),
  z.object({
    kind: z.literal("sources"),
    total: nonnegativeIntegerSchema,
    cited: nonnegativeIntegerSchema,
    publicationTimeBuckets: z.array(
      z.object({
        bucket: z.enum([
          "last_7_days",
          "last_30_days",
          "last_90_days",
          "older",
          "unknown",
        ]),
        discoveredCount: nonnegativeIntegerSchema,
        citedCount: nonnegativeIntegerSchema,
      }),
    ),
    items: z.array(
      z.object({
        domain: z.string(),
        discoveredCount: nonnegativeIntegerSchema,
        citedCount: nonnegativeIntegerSchema,
      }),
    ),
  }),
]);
