import { z } from "zod";
import { workspaceQuestionCategorySchema } from "./service-portal";
import {
  monitoringCitationImportSchema,
  monitoringSampleImportSchema,
} from "./monitoring";

export const dashboardMetricSchema = z.object({
  label: z.string().trim().min(1).max(80),
  value: z.union([z.string(), z.number()]),
  unit: z.string().trim().max(24).optional(),
  note: z.string().trim().max(160).optional(),
});

export const dashboardItemSchema = z.object({
  title: z.string().trim().min(1).max(160),
  description: z.string().trim().max(4_000).optional(),
  meta: z.string().trim().max(160).optional(),
  imageUrl: z.string().trim().max(2_048).optional(),
});

export const dashboardTableSchema = z.object({
  id: z.string().trim().min(1).max(80),
  title: z.string().trim().min(1).max(160),
  description: z.string().trim().max(1_000).optional(),
  columns: z.array(z.string().trim().min(1).max(160)).min(1).max(50),
  rows: z
    .array(z.array(z.string().trim().max(8_000)).max(50))
    .max(10_000)
    .default([]),
});

export const dashboardSectionSchema = z.object({
  id: z.string().trim().min(1).max(80),
  title: z.string().trim().min(1).max(160),
  subtitle: z.string().trim().max(300).optional(),
  body: z.string().trim().max(20_000).optional(),
  items: z.array(dashboardItemSchema).max(100).default([]),
  tables: z.array(dashboardTableSchema).max(20).default([]),
});

export const dashboardQuestionSchema = z.object({
  id: z.string().trim().min(1).max(191),
  groupId: z.string().trim().min(1).max(128),
  groupTitle: z.string().trim().min(1).max(255),
  groupSubtitle: z.string().trim().max(300).default(""),
  tone: z.enum(["plum", "teal", "amber", "blue"]).default("plum"),
  question: z.string().trim().min(1).max(2_000),
  intent: z.string().trim().max(8_000).default(""),
  summary: z.string().trim().max(8_000).default(""),
});

export const dashboardMonitoringCitationSchema = z.object({
  id: z.string().trim().min(1).max(191).optional(),
  title: z.string().trim().max(1_000).default(""),
  url: z.string().trim().max(2_048).default(""),
  media: z.string().trim().max(255).default(""),
  publishedAt: z.string().trim().max(64).optional(),
});

export const dashboardMonitoringAnswerSchema = z.object({
  id: z.string().trim().min(1).max(191),
  questionId: z.string().trim().min(1).max(191),
  platform: z.string().trim().min(1).max(128),
  collectedAt: z.string().trim().max(64).default(""),
  answerNo: z.number().int().positive().max(10_000).default(1),
  content: z.string().trim().max(200_000).default(""),
  citationCount: z.number().int().nonnegative().max(100_000).optional(),
  monitorRank: z.number().positive().max(100_000).optional(),
  screenshotUrl: z.string().trim().max(2_048).default(""),
  citations: z.array(dashboardMonitoringCitationSchema).max(200).default([]),
});

export const dashboardCitationRecordSchema = z.object({
  id: z.string().trim().min(1).max(191),
  questionId: z.string().trim().max(191).default(""),
  model: z.string().trim().max(128).default(""),
  question: z.string().trim().max(2_000).default(""),
  title: z.string().trim().max(1_000).default(""),
  url: z.string().trim().max(2_048).default(""),
  media: z.string().trim().max(255).default(""),
  domain: z.string().trim().max(255).default(""),
  date: z.string().trim().max(64).default(""),
});

export const dashboardContentMediaSchema = z.object({
  url: z.string().trim().min(1).max(2_048),
  alt: z.string().trim().max(500).default(""),
  caption: z.string().trim().max(1_000).default(""),
  source: z.string().trim().max(2_048).default(""),
});

export const dashboardContentArticleSectionSchema = z.union([
  z.tuple([z.string().trim().max(500), z.string().trim().max(30_000)]),
  z.object({
    heading: z.string().trim().max(500).default(""),
    body: z.string().trim().max(30_000).default(""),
    media: z.array(dashboardContentMediaSchema).max(50).default([]),
  }),
]);

export const dashboardContentArticleSchema = z.object({
  id: z.string().trim().min(1).max(191),
  title: z.string().trim().min(1).max(500),
  intro: z.string().trim().max(8_000).default(""),
  sections: z.array(dashboardContentArticleSectionSchema).max(100).default([]),
});

export const dashboardContentAssetSchema = z.object({
  id: z.string().trim().min(1).max(80),
  group: z.string().trim().max(255).default("内容资产"),
  name: z.string().trim().min(1).max(255),
  description: z.string().trim().max(2_000).default(""),
  wordRange: z.string().trim().max(128).default(""),
  imageCount: z.number().int().nonnegative().max(100_000).optional(),
  scene: z.string().trim().max(1_000).default(""),
  impact: z.number().min(0).max(100).optional(),
  articles: z.array(dashboardContentArticleSchema).max(500).default([]),
});

const optimizationKpiSchema = z.tuple([
  z.string(),
  z.string(),
  z.string(),
  z.number(),
  z.string(),
]);
const optimizationPlatformSchema = z.tuple([
  z.string(),
  z.string(),
  z.string(),
  z.string(),
  z.string(),
  z.string(),
  z.string(),
]);
const optimizationJourneySchema = z.tuple([
  z.string(),
  z.string(),
  z.string(),
  z.string(),
  z.string(),
]);
const optimizationFourColumnSchema = z.tuple([
  z.string(),
  z.string(),
  z.string(),
  z.string(),
]);
const optimizationRoadmapSchema = z.tuple([z.string(), z.string(), z.string()]);

export const dashboardOptimizationBaselineSchema = z.object({
  id: z.string().trim().max(191).default(""),
  questionId: z.string().trim().max(191).default(""),
  question: z.string().trim().max(2_000).default(""),
  category: z.string().trim().max(120).default(""),
  generatedAt: z.string().trim().max(120).default(""),
  period: z.string().trim().max(500).default(""),
  title: z.string().trim().min(1).max(500),
  subtitle: z.string().trim().max(8_000).default(""),
  scopeLabel: z.string().trim().max(1_000).default(""),
  sample: z
    .object({
      platforms: z.array(z.string().trim().min(1).max(120)).max(20).default([]),
      expectedResponses: z.number().int().nonnegative().max(100_000),
      successfulResponses: z.number().int().nonnegative().max(100_000),
      failedResponses: z.number().int().nonnegative().max(100_000),
    })
    .optional(),
  totalScore: z.number().min(0).max(100).nullable().default(null),
  rawTotalScore: z.number().min(0).max(100).nullable().optional(),
  applicableScore: z.number().min(0).max(100).nullable().optional(),
  applicableMaxScore: z.number().positive().max(100).nullable().optional(),
  structuralExcludedMaxScore: z
    .number()
    .nonnegative()
    .max(100)
    .nullable()
    .optional(),
  coverage: z.number().min(0).max(100).nullable().optional(),
  confidence: z.enum(["high", "medium", "low"]).nullable().optional(),
  grade: z.string().trim().max(20).default(""),
  summary: z.string().trim().max(20_000).default(""),
  dimensions: z
    .array(
      z.object({
        id: z.string().trim().min(1).max(80),
        label: z.string().trim().min(1).max(255),
        score: z.number().min(0).max(100),
        maxScore: z.number().positive().max(100),
        summary: z.string().trim().max(4_000).default(""),
      }),
    )
    .max(20)
    .default([]),
  platforms: z
    .array(
      z.object({
        platform: z.string().trim().min(1).max(120),
        responseCount: z.number().int().nonnegative().max(100_000),
        mentionRate: z.string().trim().max(80).nullable().default(null),
        averageRank: z.string().trim().max(80).nullable().default(null),
        factAccuracy: z.string().trim().max(80).nullable().default(null),
        propositionHitRate: z.string().trim().max(80).nullable().default(null),
        citationCount: z.number().int().nonnegative().max(100_000),
        referenceCount: z.number().int().nonnegative().max(100_000).default(0),
        verdict: z.string().trim().max(8_000).default(""),
        evidenceRefs: z
          .array(z.string().trim().min(1).max(4_000))
          .max(100)
          .default([]),
      }),
    )
    .max(100)
    .default([]),
  findings: z
    .array(
      z.object({
        topic: z.string().trim().min(1).max(500),
        status: z.enum(["aligned", "missing", "conflict", "opportunity"]),
        currentEvidence: z.string().trim().max(8_000).default(""),
        gap: z.string().trim().max(8_000).default(""),
        action: z.string().trim().max(8_000).default(""),
        evidenceRefs: z
          .array(z.string().trim().min(1).max(4_000))
          .max(100)
          .default([]),
      }),
    )
    .max(500)
    .default([]),
  priorityActions: z
    .array(
      z.object({
        priority: z.number().int().positive().max(100),
        dimension: z.string().trim().max(255).default(""),
        action: z.string().trim().min(1).max(8_000),
        expectedImpact: z.string().trim().max(4_000).default(""),
        evidenceRefs: z
          .array(z.string().trim().min(1).max(4_000))
          .max(100)
          .default([]),
      }),
    )
    .max(100)
    .default([]),
  limitations: z.array(z.string().trim().max(4_000)).max(100).default([]),
});

const dashboardOptimizationAnswerScreenshotSchema = z.object({
  id: z.string().trim().max(191).default(""),
  url: z
    .string()
    .trim()
    .min(1)
    .max(4_000)
    .regex(
      /^\/api\/dashboard\/report-assets\/[1-9]\d*\/[0-9a-f-]{36}\.(?:png|jpe?g|webp)$/i,
      "答案截图必须先通过管理员受保护上传入口上传",
    ),
  alt: z.string().trim().max(500).default(""),
});

const dashboardOptimizationQuestionSampleSchema = z.object({
  platform: z.string().trim().max(120).default(""),
  capturedAt: z.string().trim().max(120).default(""),
  content: z.string().trim().max(100_000).default(""),
  screenshots: z
    .array(dashboardOptimizationAnswerScreenshotSchema)
    .max(20)
    .default([]),
});

const dashboardOptimizationAfterEffectSchema = z
  .object({
    released: z.boolean().default(false),
    totalScore: z.number().min(0).max(100).nullable().default(null),
    grade: z.string().trim().max(20).default(""),
    summary: z.string().trim().max(20_000).default(""),
    dimensions: z
      .array(
        z.object({
          id: z.string().trim().min(1).max(80),
          label: z.string().trim().min(1).max(255),
          score: z.number().min(0).max(100),
          maxScore: z.number().positive().max(100),
          summary: z.string().trim().max(4_000).default(""),
        }),
      )
      .max(20)
      .default([]),
    platforms: z
      .array(
        z.object({
          platform: z.string().trim().min(1).max(120),
          responseCount: z.number().int().nonnegative().max(100_000),
          mentionRate: z.string().trim().max(80).nullable().default(null),
          averageRank: z.string().trim().max(80).nullable().default(null),
          factAccuracy: z.string().trim().max(80).nullable().default(null),
          propositionHitRate: z
            .string()
            .trim()
            .max(80)
            .nullable()
            .default(null),
          citationCount: z.number().int().nonnegative().max(100_000),
          referenceCount: z
            .number()
            .int()
            .nonnegative()
            .max(100_000)
            .default(0),
          verdict: z.string().trim().max(8_000).default(""),
        }),
      )
      .max(100)
      .default([]),
    gapFillSummary: z.string().trim().max(20_000).default(""),
    gapClosures: z
      .array(
        z.object({
          topic: z.string().trim().min(1).max(500),
          beforeGap: z.string().trim().max(8_000).default(""),
          result: z.string().trim().max(8_000).default(""),
          status: z.enum(["filled", "partial", "open"]),
        }),
      )
      .max(500)
      .default([]),
  })
  .superRefine((effect, context) => {
    if (!effect.released) return;
    if (effect.totalScore === null) {
      context.addIssue({
        code: "custom",
        path: ["totalScore"],
        message: "开放优化后效果前必须填写优化后语义资产评分",
      });
    }
    if (effect.platforms.length === 0) {
      context.addIssue({
        code: "custom",
        path: ["platforms"],
        message: "开放优化后效果前必须填写至少一个平台的真实复测结果",
      });
    }
    if (!effect.gapFillSummary && effect.gapClosures.length === 0) {
      context.addIssue({
        code: "custom",
        path: ["gapFillSummary"],
        message: "开放优化后效果前必须填写知识事实与模型回答差距的填补结果",
      });
    }
  });

export const dashboardOptimizationQuestionReportSchema = z.object({
  id: z.string().trim().min(1).max(191),
  category: z.string().trim().max(120).default(""),
  question: z.string().trim().min(1).max(2_000),
  summary: z.string().trim().max(8_000).default(""),
  metrics: z
    .array(
      z.object({
        label: z.string().trim().min(1).max(255),
        before: z.string().trim().max(120).default(""),
        after: z.string().trim().max(120).default(""),
        change: z.string().trim().max(120).default(""),
        note: z.string().trim().max(1_000).default(""),
      }),
    )
    .max(50)
    .default([]),
  before: dashboardOptimizationQuestionSampleSchema.default({
    platform: "",
    capturedAt: "",
    content: "",
    screenshots: [],
  }),
  expectedLogic: z.string().trim().max(20_000).default(""),
  gaps: z.array(z.string().trim().max(8_000)).max(100).default([]),
  after: dashboardOptimizationQuestionSampleSchema.default({
    platform: "",
    capturedAt: "",
    content: "",
    screenshots: [],
  }),
  improvements: z.array(z.string().trim().max(8_000)).max(100).default([]),
  analysis: z.string().trim().max(20_000).default(""),
  evidence: z
    .array(
      z.object({
        label: z.string().trim().min(1).max(500),
        source: z.string().trim().max(1_000).default(""),
        url: z.string().trim().max(4_000).default(""),
        capturedAt: z.string().trim().max(120).default(""),
        isOfficial: z.boolean().default(false),
      }),
    )
    .max(100)
    .default([]),
  afterEffect: dashboardOptimizationAfterEffectSchema.optional(),
});

export const dashboardOptimizationReportSchema = z
  .object({
    period: z.string().trim().max(500).default(""),
    title: z.string().trim().min(1).max(500),
    subtitle: z.string().trim().max(8_000).default(""),
    executiveSummary: z
      .array(z.string().trim().max(20_000))
      .max(50)
      .default([]),
    kpis: z.array(optimizationKpiSchema).max(100).default([]),
    platforms: z.array(optimizationPlatformSchema).max(100).default([]),
    journeys: z.array(optimizationJourneySchema).max(100).default([]),
    competitorTiers: z.array(optimizationFourColumnSchema).max(100).default([]),
    sourceMix: z.array(optimizationFourColumnSchema).max(100).default([]),
    risks: z.array(optimizationFourColumnSchema).max(100).default([]),
    roadmap: z.array(optimizationRoadmapSchema).max(100).default([]),
    reportRecords: z.array(optimizationFourColumnSchema).max(500).default([]),
    baseline: dashboardOptimizationBaselineSchema.nullable().optional(),
    questionBaselines: z
      .array(dashboardOptimizationBaselineSchema)
      .max(500)
      .optional(),
    questionReports: z
      .array(dashboardOptimizationQuestionReportSchema)
      .max(500)
      .optional(),
  })
  .superRefine((report, context) => {
    const ensureUnique = (
      values: readonly string[],
      path: "questionBaselines" | "questionReports",
    ) => {
      const seen = new Set<string>();
      values.forEach((value, index) => {
        if (!value || !seen.has(value)) {
          if (value) seen.add(value);
          return;
        }
        context.addIssue({
          code: "custom",
          path: [
            path,
            index,
            path === "questionBaselines" ? "questionId" : "id",
          ],
          message: "同一问题只能发布一份报告",
        });
      });
    };
    ensureUnique(
      (report.questionBaselines ?? []).map(
        (baseline) => baseline.questionId || baseline.id,
      ),
      "questionBaselines",
    );
    ensureUnique(
      (report.questionReports ?? []).map((question) => question.id),
      "questionReports",
    );
  });

export const dashboardTemplateModuleSchema = z.enum([
  "profile",
  "metrics",
  "sections",
  "keywords",
  "questions",
  "monitoring",
  "response-logic",
  "content-assets",
  "optimization-report",
]);

export const dashboardAdminImportModuleSchema = z.enum([
  "profile",
  "metrics",
  "sections",
  "section-table",
  "keywords",
  "questions",
  "monitoring",
  "response-logic",
  "content-assets",
  "optimization-report",
]);

export const dashboardModuleTemplateMetadataSchema = z.object({
  format: z.literal("frontmind.dashboard-module-template.v1"),
  module: dashboardTemplateModuleSchema,
  templateRevision: z.number().int().nonnegative(),
  exportedAt: z.string().trim().min(1).max(120),
});

export const dashboardQuestionTemplateRecordSchema = z.object({
  id: z.string().trim().min(1).max(191),
  revision: z.number().int().positive(),
  category: workspaceQuestionCategorySchema,
  question: z.string().trim().min(1).max(4_000),
  intent: z.string().trim().max(16_000).nullable().default(null),
  rationale: z.string().trim().max(16_000).nullable().default(null),
});

export const dashboardQuestionsTemplateSchema =
  dashboardModuleTemplateMetadataSchema
    .extend({
      module: z.literal("questions"),
      questions: z.array(dashboardQuestionTemplateRecordSchema).max(500),
    })
    .superRefine((template, context) => {
      const seen = new Set<string>();
      template.questions.forEach((question, index) => {
        if (seen.has(question.id)) {
          context.addIssue({
            code: z.ZodIssueCode.custom,
            path: ["questions", index, "id"],
            message: "同一正式问题只能在模板中出现一次",
          });
        }
        seen.add(question.id);
      });
    });

export const dashboardMonitoringTemplateBatchSchema = z
  .object({
    batchKey: z.string().trim().min(1).max(191),
    revision: z.number().int().positive(),
    sourceName: z.string().trim().min(1).max(512),
    collectedAt: z.string().datetime(),
    samples: z.array(monitoringSampleImportSchema).max(100_000),
    citations: z.array(monitoringCitationImportSchema).max(100_000),
  })
  .refine(
    (batch) => batch.samples.length > 0 || batch.citations.length > 0,
    "监控批次不能同时缺少答案和引用记录",
  );

export const dashboardMonitoringCurrentTemplateSchema =
  dashboardModuleTemplateMetadataSchema
    .extend({
      module: z.literal("monitoring"),
      workspaceUserId: z.number().int().positive(),
      batches: z.array(dashboardMonitoringTemplateBatchSchema).max(100),
    })
    .superRefine((template, context) => {
      const batchKeys = new Set<string>();
      template.batches.forEach((batch, batchIndex) => {
        if (batchKeys.has(batch.batchKey)) {
          context.addIssue({
            code: z.ZodIssueCode.custom,
            path: ["batches", batchIndex, "batchKey"],
            message: "同一监控批次只能在当前内容模板中出现一次",
          });
        }
        batchKeys.add(batch.batchKey);
        for (const [field, records] of [
          ["samples", batch.samples],
          ["citations", batch.citations],
        ] as const) {
          const sourceIds = new Set<string>();
          records.forEach((record, recordIndex) => {
            if (sourceIds.has(record.sourceRecordId)) {
              context.addIssue({
                code: z.ZodIssueCode.custom,
                path: [
                  "batches",
                  batchIndex,
                  field,
                  recordIndex,
                  "sourceRecordId",
                ],
                message: "同一批次的记录 ID 不能重复",
              });
            }
            sourceIds.add(record.sourceRecordId);
          });
        }
      });
    });

export const dashboardOptimizationReportTemplateSchema =
  dashboardModuleTemplateMetadataSchema.extend({
    module: z.literal("optimization-report"),
    optimizationReport: dashboardOptimizationReportSchema,
  });

export const dashboardProgressReportVersionSchema = z.object({
  id: z.string().trim().min(1).max(191),
  revision: z.number().int().positive(),
  publishedAt: z.number().int().nonnegative(),
  report: dashboardOptimizationReportSchema,
});

export const dashboardPayloadSchema = z.object({
  brandName: z.string().trim().min(1).max(160),
  headline: z.string().trim().min(1).max(300),
  summary: z.string().trim().max(4_000).default(""),
  metrics: z.array(dashboardMetricSchema).max(24).default([]),
  sections: z.array(dashboardSectionSchema).max(40).default([]),
  keywordTables: z.array(dashboardTableSchema).max(20).default([]),
  questions: z.array(dashboardQuestionSchema).max(500).default([]),
  monitoringAnswers: z
    .array(dashboardMonitoringAnswerSchema)
    .max(100_000)
    .default([]),
  citations: z.array(dashboardCitationRecordSchema).max(100_000).default([]),
  contentAssets: z.array(dashboardContentAssetSchema).max(200).default([]),
  optimizationReport: dashboardOptimizationReportSchema
    .nullable()
    .default(null),
  progressReports: z
    .array(dashboardProgressReportVersionSchema)
    .max(100)
    .default([]),
});

export type DashboardPayload = z.infer<typeof dashboardPayloadSchema>;
export type DashboardProgressReportVersion = z.infer<
  typeof dashboardProgressReportVersionSchema
>;
export type DashboardOptimizationBaseline = z.infer<
  typeof dashboardOptimizationBaselineSchema
>;
export type DashboardOptimizationQuestionReport = z.infer<
  typeof dashboardOptimizationQuestionReportSchema
>;
export type DashboardOptimizationReport = z.infer<
  typeof dashboardOptimizationReportSchema
>;
export type DashboardOptimizationReportTemplate = z.infer<
  typeof dashboardOptimizationReportTemplateSchema
>;
export type DashboardQuestionTemplateRecord = z.infer<
  typeof dashboardQuestionTemplateRecordSchema
>;
export type DashboardQuestionsTemplate = z.infer<
  typeof dashboardQuestionsTemplateSchema
>;
export type DashboardMonitoringCurrentTemplate = z.infer<
  typeof dashboardMonitoringCurrentTemplateSchema
>;
export type DashboardTemplateModule = z.infer<
  typeof dashboardTemplateModuleSchema
>;
export type DashboardAdminImportModule = z.infer<
  typeof dashboardAdminImportModuleSchema
>;

export const dashboardImportRecordStatsSchema = z.object({
  label: z.string().trim().min(1).max(120),
  beforeCount: z.number().int().nonnegative(),
  afterCount: z.number().int().nonnegative(),
  added: z.number().int().nonnegative(),
  updated: z.number().int().nonnegative(),
  removed: z.number().int().nonnegative(),
  unchanged: z.number().int().nonnegative(),
});

export const dashboardImportChangedFieldSchema = z.object({
  field: z.string().trim().min(1).max(120),
  label: z.string().trim().min(1).max(120),
  before: z.string().max(500),
  after: z.string().max(500),
});

export const dashboardImportPreviewMetadataSchema = z.object({
  module: dashboardAdminImportModuleSchema,
  sourceName: z.string().trim().min(1).max(1_000),
  fileHash: z.string().regex(/^[a-f0-9]{64}$/),
  templateRevision: z.number().int().nonnegative(),
  summary: z.array(z.string().trim().min(1).max(1_000)).max(30),
  preflightToken: z.string().trim().min(1).max(4_096).optional(),
  preflightExpiresAt: z.string().datetime().optional(),
  preflightTargetBatchKey: z.string().trim().min(1).max(191).optional(),
});

export const dashboardModuleImportPreviewSchema =
  dashboardImportPreviewMetadataSchema.extend({
    mode: z.literal("dashboard-module"),
    sectionId: z.string().trim().min(1).max(80).optional(),
    recordStats: z.array(dashboardImportRecordStatsSchema).max(20),
    changedFields: z
      .array(dashboardImportChangedFieldSchema)
      .max(30)
      .default([]),
  });

export type DashboardModuleImportPreview = z.infer<
  typeof dashboardModuleImportPreviewSchema
>;

export function createDashboardModuleTemplateMetadata(input: {
  module: DashboardTemplateModule;
  revision: number;
  exportedAt?: string;
}) {
  return dashboardModuleTemplateMetadataSchema.parse({
    format: "frontmind.dashboard-module-template.v1",
    module: input.module,
    templateRevision: input.revision,
    exportedAt: input.exportedAt ?? new Date().toISOString(),
  });
}

export function createDashboardOptimizationReportTemplate(input: {
  revision: number;
  report: DashboardOptimizationReport | null | undefined;
  exportedAt?: string;
}): DashboardOptimizationReportTemplate {
  return dashboardOptimizationReportTemplateSchema.parse({
    ...createDashboardModuleTemplateMetadata({
      module: "optimization-report",
      revision: input.revision,
      exportedAt: input.exportedAt,
    }),
    optimizationReport:
      input.report ??
      dashboardOptimizationReportSchema.parse({
        title: "请填写报告标题",
      }),
  });
}

export type KnowledgeDocument = {
  id?: string;
  path: string;
  title: string;
  content: string;
  kind?: "overview" | "leaf" | "evidence" | "report" | "index" | "other";
  branchId?: string;
  branchTitle?: string;
  order?: number;
  evidenceStatus?:
    | "verified_first_party"
    | "verified_authoritative"
    | "supported_third_party"
    | "inferred"
    | "needs_verification"
    | "not_applicable";
  sourceIds?: string[];
  evidenceDocumentIds?: string[];
  assetIds?: string[];
  customerVisible?: boolean;
  evidenceCharacters?: number;
  requiredFormalCharacters?: number;
  contentStatus?: "complete" | "limited_evidence" | "needs_verification";
  productFamilyId?: string;
};

export type KnowledgeAsset = {
  id?: string;
  key: string;
  path: string;
  mimeType: string;
  size: number;
  url?: string;
  sha256?: string;
  width?: number;
  height?: number;
  caption?: string;
  alt?: string;
  branchId?: string;
  documentIds?: string[];
  sourcePageUrl?: string;
  sourceAssetUrl?: string;
  sourceDocumentPath?: string;
  sourceKind?:
    | "official_web"
    | "official_document"
    | "official_logo_upload"
    | "user_upload";
  sourceUploadIndex?: number;
  sourceUploadFileId?: string;
  sourceUploadSha256?: string;
  sourceUploadFilename?: string;
  sourceUploadMimeType?: string;
  sourceUploadSizeBytes?: number;
  ownership?: "first_party" | "third_party" | "unknown";
  assetType?:
    | "brand_identity"
    | "product_ui"
    | "product_diagram"
    | "case_photo"
    | "team_photo"
    | "environment_photo"
    | "certificate_badge"
    | "document_figure"
    | "customer_supplied"
    | "other";
  displayRole?: "hero" | "inline" | "badge";
};

export function createDefaultDashboardPayload(
  displayName = "企业知识中枢",
): DashboardPayload {
  return {
    brandName: displayName,
    headline: "企业内容与 GEO 工作台",
    summary: "",
    metrics: [],
    keywordTables: [],
    questions: [],
    monitoringAnswers: [],
    citations: [],
    contentAssets: [],
    optimizationReport: null,
    progressReports: [],
    sections: [],
  };
}
