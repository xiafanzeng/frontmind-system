import { z } from "zod";

export const servicePlanCodeSchema = z.enum(["basic", "advanced", "luxury"]);
export type ServicePlanCode = z.infer<typeof servicePlanCodeSchema>;

export const provisionableServicePlanCodeSchema = servicePlanCodeSchema;
export type ProvisionableServicePlanCode = z.infer<
  typeof provisionableServicePlanCodeSchema
>;

export const workspaceQuestionCategorySchema = z.enum([
  "industry",
  "competitor_comparison",
  "reputation",
  "product_scenario",
]);
export type WorkspaceQuestionCategory = z.infer<
  typeof workspaceQuestionCategorySchema
>;

export const serviceContractSourceSchema = z.enum([
  "website",
  "offline",
  "admin",
]);
export type ServiceContractSource = z.infer<typeof serviceContractSourceSchema>;

export const serviceCapabilityKeySchema = z.enum([
  "knowledgeBuild",
  "knowledgeDisplay",
  "globalKeywords",
  "questionSelection",
  "intentOptimization",
  "responseLogic",
  "monitoring",
  "channelDistribution",
  "progressReport",
  "contentAssets",
]);
export type ServiceCapabilityKey = z.infer<typeof serviceCapabilityKeySchema>;

export const serviceQuotaLimitsSchema = z.object({
  industryLimit: z.number().int().nonnegative(),
  competitorComparisonLimit: z.number().int().nonnegative(),
  reputationLimit: z.number().int().nonnegative(),
  productScenarioLimit: z.number().int().nonnegative(),
  totalQuestionLimit: z.number().int().nonnegative(),
});
export type ServiceQuotaLimits = z.infer<typeof serviceQuotaLimitsSchema>;

export const serviceQuotaUsageSchema = z.object({
  industry: z.number().int().nonnegative(),
  competitorComparison: z.number().int().nonnegative(),
  reputation: z.number().int().nonnegative(),
  productScenario: z.number().int().nonnegative(),
  total: z.number().int().nonnegative(),
});
export type ServiceQuotaUsage = z.infer<typeof serviceQuotaUsageSchema>;

export const EMPTY_SERVICE_QUOTA_USAGE: ServiceQuotaUsage = Object.freeze({
  industry: 0,
  competitorComparison: 0,
  reputation: 0,
  productScenario: 0,
  total: 0,
});

export const SERVICE_QUESTION_CATEGORY_LIMIT_KEYS = {
  industry: "industryLimit",
  competitor_comparison: "competitorComparisonLimit",
  reputation: "reputationLimit",
  product_scenario: "productScenarioLimit",
} as const satisfies Record<
  WorkspaceQuestionCategory,
  keyof Omit<ServiceQuotaLimits, "totalQuestionLimit">
>;

export type IncludedServiceCapabilities = Record<ServiceCapabilityKey, boolean>;

export type ServicePlanDefinition = {
  code: ServicePlanCode;
  name: string;
  description: string;
  planVersion: 1;
  contractTerm: { unit: "day" | "month"; count: number };
  quotaCadence: "contract" | "quarter" | "month";
  prepaidMonths: number | null;
  billingLabel: string;
  limits: ServiceQuotaLimits;
  includedCapabilities: IncludedServiceCapabilities;
};

const FULL_SERVICE_CAPABILITIES: IncludedServiceCapabilities = Object.freeze({
  knowledgeBuild: true,
  knowledgeDisplay: true,
  globalKeywords: true,
  questionSelection: true,
  intentOptimization: true,
  responseLogic: true,
  monitoring: true,
  channelDistribution: true,
  progressReport: true,
  contentAssets: true,
});

export const SERVICE_PLAN_CATALOG: Readonly<
  Record<ServicePlanCode, ServicePlanDefinition>
> = Object.freeze({
  basic: {
    code: "basic",
    name: "普通版",
    description: "30 天内交付一个已购买的非行业问题及知识库展示。",
    planVersion: 1,
    contractTerm: { unit: "day", count: 30 },
    quotaCadence: "contract",
    prepaidMonths: null,
    billingLabel: "30 天单题服务",
    // Each permitted non-industry category has a ceiling of one, while the
    // shared total ceiling guarantees that Basic can select only one of them.
    limits: {
      industryLimit: 0,
      competitorComparisonLimit: 1,
      reputationLimit: 1,
      productScenarioLimit: 1,
      totalQuestionLimit: 1,
    },
    includedCapabilities: {
      knowledgeBuild: false,
      knowledgeDisplay: true,
      globalKeywords: false,
      questionSelection: false,
      intentOptimization: true,
      responseLogic: true,
      monitoring: true,
      channelDistribution: true,
      progressReport: true,
      contentAssets: true,
    },
  },
  advanced: {
    code: "advanced",
    name: "进阶版",
    description: "按季度交付行业、竞品、美誉与产品场景问题。",
    planVersion: 1,
    contractTerm: { unit: "month", count: 3 },
    quotaCadence: "quarter",
    prepaidMonths: 3,
    billingLabel: "季度服务",
    limits: {
      industryLimit: 1,
      competitorComparisonLimit: 1,
      reputationLimit: 1,
      productScenarioLimit: 5,
      totalQuestionLimit: 8,
    },
    includedCapabilities: { ...FULL_SERVICE_CAPABILITIES },
  },
  luxury: {
    code: "luxury",
    name: "豪华版",
    description: "提供豪华版完整服务。",
    planVersion: 1,
    contractTerm: { unit: "month", count: 3 },
    quotaCadence: "month",
    prepaidMonths: 3,
    billingLabel: "季度服务",
    limits: {
      industryLimit: 4,
      competitorComparisonLimit: 4,
      reputationLimit: 4,
      productScenarioLimit: 20,
      totalQuestionLimit: 32,
    },
    includedCapabilities: { ...FULL_SERVICE_CAPABILITIES },
  },
});

export function getServicePlanDefinition(
  planCode: ServicePlanCode,
): ServicePlanDefinition {
  return SERVICE_PLAN_CATALOG[planCode];
}

export const effectiveServiceStatusSchema = z.enum([
  "unconfigured",
  "pending_confirmation",
  "scheduled",
  "active",
  "suspended",
  "expired",
  "cancelled",
]);
export type EffectiveServiceStatus = z.infer<
  typeof effectiveServiceStatusSchema
>;

export const serviceCapabilityAccessSchema = z.object({
  allowed: z.boolean(),
  effectiveStatus: z.enum([
    "available",
    "not_in_plan",
    "service_unconfigured",
    "service_pending_confirmation",
    "service_scheduled",
    "service_suspended",
    "service_expired",
    "service_cancelled",
  ]),
  reason: z.string().nullable(),
});
export type ServiceCapabilityAccess = z.infer<
  typeof serviceCapabilityAccessSchema
>;

export const serviceCapabilitiesSchema = z.object({
  knowledgeBuild: serviceCapabilityAccessSchema,
  knowledgeDisplay: serviceCapabilityAccessSchema,
  globalKeywords: serviceCapabilityAccessSchema,
  questionSelection: serviceCapabilityAccessSchema,
  intentOptimization: serviceCapabilityAccessSchema,
  responseLogic: serviceCapabilityAccessSchema,
  monitoring: serviceCapabilityAccessSchema,
  channelDistribution: serviceCapabilityAccessSchema,
  progressReport: serviceCapabilityAccessSchema,
  contentAssets: serviceCapabilityAccessSchema,
});
export type ServiceCapabilities = z.infer<typeof serviceCapabilitiesSchema>;

export const serviceNextActionKindSchema = z.enum([
  "await_service_configuration",
  "await_service_confirmation",
  "await_service_start",
  "contact_service_support",
  "renew_service",
  "await_knowledge_import",
  "view_knowledge",
  "resume_knowledge_build",
  "start_knowledge_build",
  "await_question_import",
  "await_question_catalog",
  // Retained for parsing responses issued by older deployments.
  "generate_question_candidates",
  "select_service_questions",
  "await_question_confirmation",
  "optimize_service_questions",
  "build_response_logic",
  "await_monitoring_data",
  "await_channel_distribution",
  "await_progress_report",
  "view_progress_report",
]);
export type ServiceNextActionKind = z.infer<typeof serviceNextActionKindSchema>;

export const serviceNextActionSchema = z.object({
  kind: serviceNextActionKindSchema,
  label: z.string().min(1),
  href: z.string().nullable(),
});
export type ServiceNextAction = z.infer<typeof serviceNextActionSchema>;

export const serviceWorkflowStepSchema = z.object({
  id: z.enum([
    "knowledge",
    "question",
    "intent_optimization",
    "response_logic",
    "monitoring",
    "channel_distribution",
    "progress_report",
  ]),
  label: z.string().min(1),
  status: z.enum(["complete", "ready", "locked"]),
  lockedReason: z.string().nullable(),
  href: z.string().nullable(),
  nextAction: serviceNextActionSchema.nullable().default(null),
});
export type ServiceWorkflowStep = z.infer<typeof serviceWorkflowStepSchema>;

export const servicePortalQuestionSchema = z.object({
  id: z.string(),
  contractId: z.string().nullable(),
  quotaPeriodId: z.string(),
  externalQuestionId: z.string().nullable(),
  sourceQuestionId: z.string().nullable(),
  category: workspaceQuestionCategorySchema,
  question: z.string(),
  intent: z.string().nullable(),
  intentRevision: z.number().int().positive(),
  intentConfirmedRevision: z.number().int().positive().nullable(),
  intentConfirmedAt: z.number().int().nonnegative().nullable(),
  intentConfirmed: z.boolean(),
  rationale: z.string().nullable(),
  evidence: z.array(
    z.object({
      documentPath: z.string(),
      excerpt: z.string(),
      relevance: z.string(),
    }),
  ),
  risks: z.array(z.string()),
  source: z.enum(["model", "website", "offline", "admin", "user"]),
  status: z.enum(["candidate", "selected", "archived"]),
  selectionApprovalStatus: z.enum(["not_requested", "pending", "approved"]),
  selectionRequestedAt: z.number().int().nonnegative().nullable(),
  selectionApprovedAt: z.number().int().nonnegative().nullable(),
  locked: z.boolean(),
  revision: z.number().int().positive(),
});
export type ServicePortalQuestion = z.infer<typeof servicePortalQuestionSchema>;

export const servicePortalQuotaPeriodSchema = z.object({
  periodId: z.string(),
  contractId: z.string(),
  validFrom: z.number().int(),
  validUntil: z.number().int(),
  revision: z.number().int().positive(),
  limits: serviceQuotaLimitsSchema,
  usage: serviceQuotaUsageSchema,
  remaining: serviceQuotaUsageSchema,
});
export type ServicePortalQuotaPeriod = z.infer<
  typeof servicePortalQuotaPeriodSchema
>;

export const servicePortalSchema = z.object({
  schemaVersion: z.literal(1),
  revision: z.number().int().nonnegative(),
  entitlementRollout: z.object({
    mode: z.enum(["compatibility", "enforced"]),
    pendingUserCount: z.number().int().nonnegative(),
  }),
  account: z
    .object({
      userId: z.number().int().positive(),
      username: z.string().nullable(),
      displayName: z.string().nullable(),
    })
    .nullable(),
  service: z.object({
    contractId: z.string().nullable(),
    planCode: servicePlanCodeSchema.nullable(),
    planName: z.string(),
    status: effectiveServiceStatusSchema,
    validFrom: z.number().int().nullable(),
    validUntil: z.number().int().nullable(),
    billingLabel: z.string(),
    source: serviceContractSourceSchema.nullable(),
  }),
  quotas: servicePortalQuotaPeriodSchema.nullable(),
  quotaPeriods: z.array(servicePortalQuotaPeriodSchema),
  purchases: z.array(
    z.object({
      id: z.string(),
      planCode: servicePlanCodeSchema,
      planName: z.string(),
      purchasedAt: z.number().int(),
      validFrom: z.number().int(),
      validUntil: z.number().int(),
      status: z.enum([
        "pending_confirmation",
        "scheduled",
        "active",
        "suspended",
        "expired",
        "cancelled",
        "superseded",
      ]),
      amountFen: z.number().int().nonnegative().nullable(),
      currency: z.string().length(3),
      prepaidMonths: z.number().int().positive().nullable(),
      orderReference: z.string().nullable(),
      contractReference: z.string().nullable(),
      signedAt: z.number().int().nullable(),
      signatoryId: z.string().nullable(),
      hasSigningEvidence: z.boolean(),
      revision: z.number().int().positive(),
    }),
  ),
  knowledge: z.object({
    version: z.number().int().positive().nullable(),
    authenticatedVersion: z.number().int().positive().nullable(),
    authenticatedForCurrentService: z.boolean(),
    status: z.enum(["display_ready", "importing", "missing", "failed"]),
    latestImportStatus: z
      .enum(["pending", "processing", "completed", "failed"])
      .nullable(),
  }),
  purchasedQuestions: z.array(servicePortalQuestionSchema),
  historicalQuestions: z.array(servicePortalQuestionSchema),
  capabilities: serviceCapabilitiesSchema,
  workflowSteps: z.array(serviceWorkflowStepSchema),
  nextAction: serviceNextActionSchema,
});
export type ServicePortal = z.infer<typeof servicePortalSchema>;

/**
 * User-facing service portal contract.
 *
 * The full ServicePortal remains the internal/admin representation because
 * entitlement and audit workflows still need contract and purchase metadata.
 * User endpoints must project through this schema so historical commercial
 * fields cannot accidentally leak when the internal DTO grows.
 */
export const publicServicePortalQuestionSchema =
  servicePortalQuestionSchema.omit({
    contractId: true,
    quotaPeriodId: true,
  });
export type PublicServicePortalQuestion = z.infer<
  typeof publicServicePortalQuestionSchema
>;

export function toPublicServicePortalQuestion(
  question: ServicePortalQuestion,
): PublicServicePortalQuestion {
  return publicServicePortalQuestionSchema.parse(question);
}

export const publicServicePortalQuotaPeriodSchema =
  servicePortalQuotaPeriodSchema.omit({
    contractId: true,
  });

export const publicServicePortalSchema = servicePortalSchema
  .omit({
    entitlementRollout: true,
    quotaPeriods: true,
    purchases: true,
  })
  .extend({
    service: servicePortalSchema.shape.service.omit({
      contractId: true,
      source: true,
    }),
    quotas: publicServicePortalQuotaPeriodSchema.nullable(),
    purchasedQuestions: z.array(publicServicePortalQuestionSchema),
    historicalQuestions: z.array(publicServicePortalQuestionSchema),
  });

export type PublicServicePortal = z.infer<typeof publicServicePortalSchema>;

export function toPublicServicePortal(
  portal: ServicePortal,
): PublicServicePortal {
  return publicServicePortalSchema.parse(portal);
}
