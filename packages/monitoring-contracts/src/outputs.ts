import { z } from "zod";
import {
  attemptStatusSchema,
  clientTypeSchema,
  jobTypeSchema,
  monitorStatusSchema,
  providerModeSchema,
  quotaEntryTypeSchema,
  roleSchema,
  runStatusSchema,
  runTriggerSchema,
  scheduleTypeSchema,
  sentimentSchema,
  userStatusSchema,
} from "./statuses.js";
import { competitorInputSchema, idSchema } from "./monitoring.js";
import { usernameSchema } from "./admin.js";
import {
  citationProvenanceSchema,
  keywordEvaluationSchema,
} from "./results.js";
import { billingSummaryOutputSchema } from "./billing.js";

const dateSchema = z.coerce.date();
const nullableDateSchema = dateSchema.nullable();
const nonnegativeIntegerSchema = z.number().int().nonnegative();

export const publicUserSchema = z.object({
  id: idSchema,
  username: usernameSchema,
  role: roleSchema,
  status: userStatusSchema,
});

export const quotaSummaryOutputSchema = z.object({
  userId: idSchema,
  grantedUnits: nonnegativeIntegerSchema,
  consumedUnits: nonnegativeIntegerSchema,
  reservedUnits: nonnegativeIntegerSchema,
  // A late successful provider result can consume quota after a reservation was
  // released. The ledger remains authoritative, so availability may truthfully
  // be negative until an administrator grants more quota.
  availableUnits: z.number().int(),
});

export const authMeOutputSchema = z.object({
  user: publicUserSchema,
  billing: billingSummaryOutputSchema,
  features: z
    .object({
      mediaPublishing: z.boolean(),
    })
    .optional(),
});

export const projectOutputSchema = z.object({
  id: idSchema,
  name: z.string(),
  timezone: z.string(),
  createdAt: dateSchema,
  brandVersionId: idSchema.optional(),
  brandVersion: nonnegativeIntegerSchema.optional(),
  mainBrand: z.string(),
  aliases: z.array(z.string()),
  competitors: z.array(competitorInputSchema),
});

export const deletedProjectOutputSchema = z.object({
  id: idSchema,
  name: z.string(),
  deletedAt: dateSchema,
  purgeAfter: nullableDateSchema,
});

export const platformOutputSchema = z.object({
  id: idSchema,
  providerCode: z.string(),
  displayName: z.string(),
  clientType: clientTypeSchema,
  pricingClass: z.enum(["domestic", "overseas"]).nullable(),
  enabled: z.boolean(),
  verified: z.boolean(),
  supportsReasoning: z.boolean(),
  supportsScreenshot: z.boolean(),
  supportsDomesticRegion: z.boolean(),
  supportsOverseasRegion: z.boolean(),
  acceptanceRequired: z.boolean().optional().default(false),
  acceptance: z
    .object({
      catalogFingerprint: z.string().length(64).nullable(),
      searchDefault: z.enum([
        "pending",
        "running",
        "passed",
        "failed",
        "unsupported",
        "stale",
      ]),
      reasoningSearch: z.enum([
        "pending",
        "running",
        "passed",
        "failed",
        "unsupported",
        "stale",
      ]),
      screenshotMention: z.enum([
        "pending",
        "running",
        "passed",
        "failed",
        "unsupported",
        "stale",
      ]),
      screenshotAll: z.enum([
        "pending",
        "running",
        "passed",
        "failed",
        "unsupported",
        "stale",
      ]),
      regionDefault: z.enum([
        "pending",
        "running",
        "passed",
        "failed",
        "unsupported",
        "stale",
      ]),
      regionDomestic: z.enum([
        "pending",
        "running",
        "passed",
        "failed",
        "unsupported",
        "stale",
      ]),
      regionOverseas: z.enum([
        "pending",
        "running",
        "passed",
        "failed",
        "unsupported",
        "stale",
      ]),
      mobileNoRegion: z.enum([
        "pending",
        "running",
        "passed",
        "failed",
        "unsupported",
        "stale",
      ]),
    })
    .optional(),
  discoveredAt: dateSchema,
  verifiedAt: nullableDateSchema,
});

export const regionOutputSchema = z.object({
  code: z.string(),
  scope: z.enum(["domestic", "overseas"]),
  name: z.string(),
  syncedAt: dateSchema,
});

export const monitorListOutputSchema = z.object({
  id: idSchema,
  projectId: idSchema,
  name: z.string(),
  status: monitorStatusSchema,
  activeVersionId: idSchema.nullable(),
  scheduleType: scheduleTypeSchema,
  scheduleTimezone: z.string(),
  scheduleLocalTime: z.string(),
  scheduleWeekday: z.number().int().nullable(),
  nextRunAt: nullableDateSchema,
  createdAt: dateSchema,
  activeVersion: z.number().int().nullable(),
  expectedAttempts: z.number().int().nullable(),
  repetitions: z.number().int().nullable(),
  questionsCount: z.coerce.number().int().nonnegative(),
  platformsCount: z.coerce.number().int().nonnegative(),
  lastRunId: idSchema.nullable(),
  lastRunStatus: z.string().nullable(),
  lastRunCompletedAttempts: z.coerce.number().int().nonnegative().nullable(),
  lastRunExpectedAttempts: z.coerce.number().int().nonnegative().nullable(),
  lastRunCompletedAt: nullableDateSchema,
  waitingQuotaOccurrences: z.coerce.number().int().nonnegative(),
});

export const deletedMonitorOutputSchema = z.object({
  id: idSchema,
  projectId: idSchema,
  name: z.string(),
  deletedAt: dateSchema,
  purgeAfter: nullableDateSchema,
});

const monitorRecordOutputSchema = z.object({
  id: idSchema,
  projectId: idSchema,
  name: z.string(),
  status: monitorStatusSchema,
  activeVersionId: idSchema.nullable(),
  scheduleType: scheduleTypeSchema,
  scheduleTimezone: z.string(),
  scheduleLocalTime: z.string(),
  scheduleWeekday: z.number().int().nullable(),
  nextRunAt: nullableDateSchema,
  createdAt: dateSchema,
  updatedAt: dateSchema,
});

const monitorVersionOutputSchema = z.object({
  id: idSchema,
  monitorId: idSchema,
  projectBrandVersionId: idSchema,
  version: z.number().int().positive(),
  name: z.string(),
  brandAliases: z.array(z.string()),
  competitors: z.array(competitorInputSchema),
  repetitions: z.number().int().positive(),
  expectedAttempts: nonnegativeIntegerSchema,
  createdAt: dateSchema,
});

const monitorQuestionOutputSchema = z.object({
  monitorVersionId: idSchema,
  ordinal: nonnegativeIntegerSchema,
  questionId: idSchema,
  questionSnapshot: z.string(),
});

const monitorPlatformOutputSchema = z.object({
  monitorVersionId: idSchema,
  ordinal: nonnegativeIntegerSchema,
  platformId: idSchema,
  providerCodeSnapshot: z.string(),
  clientType: clientTypeSchema,
  mode: providerModeSchema,
  screenshot: z.number().int().min(0).max(2),
  regionCode: z.string().nullable(),
});

export const monitorDetailOutputSchema = z.object({
  monitor: monitorRecordOutputSchema,
  version: monitorVersionOutputSchema,
  questions: z.array(monitorQuestionOutputSchema),
  platforms: z.array(monitorPlatformOutputSchema),
});

export const runRecordOutputSchema = z.object({
  id: idSchema,
  projectId: idSchema,
  projectBrandVersionId: idSchema,
  monitorId: idSchema,
  monitorVersionId: idSchema,
  trigger: runTriggerSchema,
  status: runStatusSchema,
  expectedAttempts: nonnegativeIntegerSchema,
  completedAttempts: nonnegativeIntegerSchema,
  failedAttempts: nonnegativeIntegerSchema,
  stoppedAttempts: nonnegativeIntegerSchema,
  submittedAttempts: nonnegativeIntegerSchema,
  startedAt: nullableDateSchema,
  completedAt: nullableDateSchema,
  cancelRequestedAt: nullableDateSchema,
  createdAt: dateSchema,
  updatedAt: dateSchema,
});

export const runCreationResultOutputSchema = z.object({
  run: runRecordOutputSchema,
  duplicate: z.boolean(),
});

export const monitorMutationOutputSchema = z.object({
  monitorId: idSchema,
  versionId: idSchema,
  version: z.number().int().positive().optional(),
  expectedAttempts: nonnegativeIntegerSchema,
  run: runCreationResultOutputSchema.nullable(),
});

const runModelMetricOutputSchema = z.object({
  platformId: idSchema,
  providerCode: z.string(),
  clientType: clientTypeSchema,
  mode: providerModeSchema,
  effectiveAnswers: nonnegativeIntegerSchema,
  brandMentionedAnswers: nonnegativeIntegerSchema,
  mentionPositionSum: nonnegativeIntegerSchema,
  mentionPositionCount: nonnegativeIntegerSchema,
  citationCount: nonnegativeIntegerSchema,
  positiveCount: nonnegativeIntegerSchema,
  neutralCount: nonnegativeIntegerSchema,
  negativeCount: nonnegativeIntegerSchema,
  unknownCount: nonnegativeIntegerSchema,
});

const runCompetitorMetricOutputSchema = z.object({
  name: z.string(),
  appearances: nonnegativeIntegerSchema,
  positionSum: nonnegativeIntegerSchema,
  positionCount: nonnegativeIntegerSchema,
});

export const runListOutputSchema = runRecordOutputSchema.extend({
  configurationVersion: z.number().int().positive(),
  metrics: z.object({
    effectiveAnswers: nonnegativeIntegerSchema,
    brandMentionedAnswers: nonnegativeIntegerSchema,
    averageMentionPosition: z.number().nonnegative().nullable(),
    citationCount: nonnegativeIntegerSchema,
    uniqueDomainCount: nonnegativeIntegerSchema,
    positiveCount: nonnegativeIntegerSchema,
    neutralCount: nonnegativeIntegerSchema,
    negativeCount: nonnegativeIntegerSchema,
    unknownCount: nonnegativeIntegerSchema,
    modelMetrics: z.array(runModelMetricOutputSchema),
    competitorMetrics: z.array(runCompetitorMetricOutputSchema),
  }),
});

export const deletedRunOutputSchema = z.object({
  id: idSchema,
  monitorId: idSchema,
  status: runStatusSchema,
  deletedAt: dateSchema,
  purgeAfter: nullableDateSchema,
  createdAt: dateSchema,
});

const attemptOutputSchema = z.object({
  id: idSchema,
  monitorQuestionOrdinal: nonnegativeIntegerSchema,
  monitorPlatformOrdinal: nonnegativeIntegerSchema,
  repetition: z.number().int().positive(),
  question: z.string(),
  platformId: idSchema,
  providerCode: z.string(),
  clientType: clientTypeSchema,
  mode: providerModeSchema,
  screenshot: z.number().int().min(0).max(2),
  regionCode: z.string().nullable(),
  status: attemptStatusSchema,
  errorMessage: z.string().nullable(),
  submittedAt: nullableDateSchema,
  terminalAt: nullableDateSchema,
  createdAt: dateSchema,
  updatedAt: dateSchema,
});

const attemptResultOutputSchema = z.object({
  attemptId: idSchema,
  currentRevisionId: idSchema,
  revision: z.number().int().positive(),
  answerMarkdown: z.string(),
  reasoningMarkdown: z.string().nullable(),
  searchKeywords: z.array(z.string()),
  sentiment: sentimentSchema,
  brandMentioned: z.boolean(),
  mentionPosition: z.number().int().positive().nullable(),
  competitorRankings: z.array(z.record(z.string(), z.unknown())),
  keywordEvaluations: z.array(keywordEvaluationSchema),
  citationProvenance: citationProvenanceSchema,
  categoryRanking: z.record(z.string(), z.unknown()).nullable(),
  createdAt: dateSchema,
  updatedAt: dateSchema,
});

const runSourceOutputSchema = z.object({
  id: idSchema,
  revisionId: idSchema,
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
  citationProvenance: citationProvenanceSchema,
  citedText: z.string().nullable(),
  createdAt: dateSchema,
});

const runDiscoveredSourceOutputSchema = runSourceOutputSchema
  .omit({ citedText: true })
  .extend({ isCited: z.boolean() });

const runMediaOutputSchema = z.object({
  id: idSchema,
  revisionId: idSchema,
  type: z.enum(["screenshot", "image", "video", "goods", "raw_response"]),
  ordinal: nonnegativeIntegerSchema,
  mimeType: z.string().nullable(),
  sizeBytes: nonnegativeIntegerSchema.nullable(),
  archiveStatus: z.enum(["pending", "archived", "failed", "not_applicable"]),
  accessPath: z.string().startsWith("/api/media/").nullable(),
  thumbnailAccessPath: z.string().startsWith("/api/media/").nullable(),
});

const runConfigurationPlatformOutputSchema = monitorPlatformOutputSchema.extend(
  {
    displayName: z.string().nullable(),
  },
);

const brandSnapshotOutputSchema = z.object({
  id: idSchema,
  projectId: idSchema,
  version: z.number().int().positive(),
  mainBrand: z.string(),
  aliases: z.array(z.string()),
  competitors: z.array(competitorInputSchema),
  createdAt: dateSchema,
});

export const runDetailOutputSchema = z.object({
  run: runRecordOutputSchema,
  attempts: z.array(
    z.object({
      attempt: attemptOutputSchema,
      result: attemptResultOutputSchema.nullable(),
    }),
  ),
  sources: z.array(runSourceOutputSchema),
  discoveredSources: z.array(runDiscoveredSourceOutputSchema),
  media: z.array(runMediaOutputSchema),
  configuration: z.object({
    version: monitorVersionOutputSchema,
    brand: brandSnapshotOutputSchema,
    questions: z.array(monitorQuestionOutputSchema),
    platforms: z.array(runConfigurationPlatformOutputSchema),
  }),
});

export const adminUserListOutputSchema = z.object({
  id: idSchema,
  username: usernameSchema,
  role: roleSchema,
  status: userStatusSchema,
  lastLoginAt: nullableDateSchema,
  createdAt: dateSchema,
  grantedUnits: nonnegativeIntegerSchema.nullable(),
  consumedUnits: nonnegativeIntegerSchema.nullable(),
  reservedUnits: nonnegativeIntegerSchema.nullable(),
});

export const quotaLedgerOutputSchema = z.object({
  id: idSchema,
  type: quotaEntryTypeSchema,
  units: z.number().int(),
  reason: z.string().nullable(),
  createdAt: dateSchema,
});

const safeBalanceSchema = z.union([
  z.string(),
  z.number(),
  z.object({
    balance: z.union([z.string(), z.number()]).optional(),
    amount: z.union([z.string(), z.number()]).optional(),
    availableBalance: z.union([z.string(), z.number()]).optional(),
  }),
]);

export const adminOverviewOutputSchema = z.object({
  jobs: z.record(z.string(), z.number()),
  runs: z.record(z.string(), z.number()),
  oldestReadyAt: nullableDateSchema,
  providerCost: z.object({
    totalAmount: z.string(),
    unreconciled: z.coerce.number().int().nonnegative(),
  }),
  provider: z
    .object({
      id: z.string(),
      balance: safeBalanceSchema.nullable(),
      reconciledAt: nullableDateSchema,
      updatedAt: dateSchema,
    })
    .nullable(),
  workers: z.array(
    z.object({
      workerId: z.string(),
      heartbeatAt: dateSchema,
      createdAt: dateSchema,
      updatedAt: dateSchema,
    }),
  ),
  executionService: z.object({
    status: z.enum(["online", "offline", "never_seen"]),
    lastHeartbeatAt: nullableDateSchema,
    observedAt: dateSchema,
    ageSeconds: nonnegativeIntegerSchema.nullable(),
    thresholdSeconds: z.literal(90),
  }),
  providerAuthentication: z.object({
    status: z.enum(["healthy", "unhealthy", "unknown"]),
    verifiedAt: nullableDateSchema,
    failedAt: nullableDateSchema,
  }),
  submissionUnknownCount: nonnegativeIntegerSchema,
  mediaArchiveFailureCount: nonnegativeIntegerSchema,
  recentDeadJobs: z.array(
    z.object({
      id: idSchema,
      type: jobTypeSchema,
      lastErrorCode: z.string().nullable(),
      lastErrorMessage: z.string().nullable(),
      updatedAt: dateSchema,
    }),
  ),
});

export const adminRunListOutputSchema = z.object({
  run: runRecordOutputSchema,
  username: usernameSchema,
  monitorName: z.string(),
});

export const adminOperationListItemOutputSchema =
  adminRunListOutputSchema.extend({
    userId: idSchema,
  });

export const adminOperationsListOutputSchema = z.object({
  items: z.array(adminOperationListItemOutputSchema),
  summary: z.object({
    totalRuns: nonnegativeIntegerSchema,
    runsByStatus: z.record(z.string(), nonnegativeIntegerSchema),
    expectedAttempts: nonnegativeIntegerSchema,
    submittedAttempts: nonnegativeIntegerSchema,
    completedAttempts: nonnegativeIntegerSchema,
    failedAttempts: nonnegativeIntegerSchema,
    stoppedAttempts: nonnegativeIntegerSchema,
  }),
  nextCursor: idSchema.nullable(),
});

const adminOperationAttemptOutputSchema = z.object({
  id: idSchema,
  monitorQuestionOrdinal: nonnegativeIntegerSchema,
  monitorPlatformOrdinal: nonnegativeIntegerSchema,
  repetition: z.number().int().positive(),
  question: z.string(),
  platformId: idSchema,
  providerCode: z.string(),
  clientType: clientTypeSchema,
  mode: providerModeSchema,
  status: attemptStatusSchema,
  providerTaskId: z.string().nullable(),
  providerSubTaskId: z.string().nullable(),
  errorCode: z.string().nullable(),
  errorMessage: z.string().nullable(),
  submittedAt: nullableDateSchema,
  terminalAt: nullableDateSchema,
  createdAt: dateSchema,
  updatedAt: dateSchema,
});

export const adminOperationDetailOutputSchema = z.object({
  run: runRecordOutputSchema,
  userId: idSchema,
  username: usernameSchema,
  monitorName: z.string(),
  attempts: z.array(adminOperationAttemptOutputSchema),
});

export const adminProviderCostOutputSchema = z.object({
  id: idSchema,
  attemptId: idSchema.nullable(),
  providerTaskId: z.string(),
  amount: z.string(),
  currency: z.string(),
  providerRecordId: z.string().nullable(),
  occurredAt: dateSchema,
  reconciledAt: nullableDateSchema,
  createdAt: dateSchema,
});

export const adminAuditOutputSchema = z.object({
  id: idSchema,
  actorId: idSchema.nullable(),
  actorRole: roleSchema.nullable(),
  action: z.string(),
  targetType: z.string(),
  targetIdHash: z.string().nullable(),
  createdAt: dateSchema,
});

export const booleanResultOutputSchemas = {
  passwordChanged: z.object({
    changed: z.literal(true),
    loginRequired: z.literal(true),
  }),
  deleted: z.object({ deleted: z.literal(true) }),
  projectRestored: z.object({
    restored: z.literal(true),
    schedulesPaused: z.literal(true),
  }),
  monitorPaused: z.object({ paused: z.boolean() }),
  monitorRestored: z.object({
    restored: z.literal(true),
    schedulePaused: z.literal(true),
  }),
  restored: z.object({ restored: z.literal(true) }),
  updated: z.object({ updated: z.literal(true) }),
  reset: z.object({ reset: z.literal(true) }),
  queued: z.object({ queued: z.literal(true) }),
} as const;
