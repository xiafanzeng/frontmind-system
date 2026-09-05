import { z } from "zod";
import {
  siteBriefSchema,
  siteOpsBuildStatusSchema,
  siteOpsCardSchema,
  siteOpsProjectStatusSchema,
  siteOpsVisualFailureCategorySchema,
  SITEOPS_VISUAL_CANDIDATE_MAX_PAGES,
  SITEOPS_VISUAL_CANDIDATE_PAGE_SIZE,
} from "./siteops";

/** Stable, public-safe delivery coordinate for a valid content patch whose
 * invalid child slots were replaced with values from the frozen Brief. The
 * UI projects this code to fixed copy and must never expose provider details. */
export const SITEOPS_CONTENT_PATCH_PARTIAL_DEFAULTS_WARNING_CODE =
  "SITEOPS_CONTENT_PATCH_PARTIAL_DEFAULTS" as const;

export const siteOpsKnowledgeSnapshotSchema = z
  .object({
    id: z.string().uuid(),
    label: z.string().trim().min(1).max(255),
    sourceProfile: z.string().trim().min(1).max(64).nullable().default(null),
    createdAt: z.string().datetime(),
    active: z.boolean().default(false),
  })
  .strict();

export const siteOpsProjectProjectionSchema = z
  .object({
    id: z.string().uuid(),
    conversationId: z.string().trim().min(1).max(191),
    revision: z.number().int().positive(),
    status: siteOpsProjectStatusSchema,
    currentKnowledgeSnapshotId: z.string().uuid().nullable(),
    primaryLanguage: z.string().trim().min(2).max(32),
    canonicalHostname: z.string().trim().max(255).nullable(),
    updatedAt: z.string().datetime(),
  })
  .strict();

export const siteOpsMessageProjectionSchema = z
  .object({
    id: z.string().trim().min(1).max(191),
    role: z.enum(["user", "assistant", "system"]),
    content: z.string().max(100_000),
    sequence: z.number().int().nonnegative(),
    metadata: z
      .object({
        siteOps: siteOpsCardSchema.optional(),
      })
      .passthrough()
      .nullable()
      .default(null),
    sentAt: z.string().datetime(),
  })
  .strict();

export const siteOpsVisualCandidateProjectionSchema = z
  .object({
    id: z.string().trim().min(1).max(191),
    label: z.string().regex(/^[A-I]$/),
    title: z.string().trim().min(1).max(255),
    previewUrl: z.string().min(1).max(2_048),
    note: z.string().trim().max(2_000).nullable().default(null),
    visualFamily: z
      .enum([
        "floating_orbit",
        "split_media",
        "editorial",
        "bento",
        "feature_grid",
        "centered_dual_cta",
        "immersive_visual",
        "product_stage",
        "full_bleed_statement",
      ])
      .nullable()
      .default(null),
    selected: z.boolean().default(false),
    executionAdmitted: z.boolean().optional(),
    executionUnavailableReason: z
      .string()
      .trim()
      .min(1)
      .max(500)
      .nullable()
      .optional(),
  })
  .strict();

export const siteOpsVisualCandidatePageProjectionSchema = z
  .object({
    batchId: z.string().uuid(),
    page: z.number().int().min(1).max(4),
    candidates: z
      .array(siteOpsVisualCandidateProjectionSchema)
      .refine(
        (candidates) =>
          candidates.length === 8 ||
          candidates.length === SITEOPS_VISUAL_CANDIDATE_PAGE_SIZE,
        "Visual candidate page must contain 8 static or 9 historical candidates",
      ),
  })
  .strict();

export const siteOpsVisualGenerationProjectionSchema = z
  .object({
    status: z.enum(["idle", "generating", "retryable_error"]).default("idle"),
    targetPage: z
      .union([z.literal(1), z.literal(2), z.literal(3), z.literal(4)])
      .nullable()
      .default(null),
    generatedPages: z.number().int().min(0).max(4),
    availablePages: z.number().int().min(0).max(4).optional(),
    reservedPages: z.number().int().min(0).max(4).optional(),
    maxPages: z.union([
      z.literal(SITEOPS_VISUAL_CANDIDATE_MAX_PAGES),
      z.literal(4),
    ]),
    workflowVersion: z.string().trim().min(1).max(32).optional(),
    catalogVersion: z.string().trim().min(1).max(191).optional(),
    pageSize: z.union([z.literal(8), z.literal(9)]).optional(),
    pageCount: z.union([z.literal(3), z.literal(4)]).optional(),
    canGenerateMore: z.boolean(),
    canSelectExisting: z.boolean().default(true),
    retryAction: z.enum(["start", "supplemental"]).nullable().optional(),
    failureCategory: siteOpsVisualFailureCategorySchema.nullable().optional(),
  })
  .strict();

/** Public state for one immutable build in the current logical task. */
export const siteOpsBuildProjectionSchema = z
  .object({
    id: z.string().uuid(),
    ordinal: z.number().int().positive(),
    parentBuildId: z.string().uuid().nullable(),
    status: siteOpsBuildStatusSchema,
    previewUrl: z.string().max(2_048).nullable().default(null),
    sourceUrl: z.string().max(2_048).nullable().default(null),
    contentPlan: z
      .object({
        status: z.enum(["pending", "ready"]),
        sha256: z
          .string()
          .regex(/^[a-f0-9]{64}$/u)
          .nullable(),
      })
      .strict()
      .optional(),
    revisionInputs: z
      .array(
        z
          .object({
            filename: z.string().trim().min(1).max(512),
            mimeType: z.enum(["image/png", "image/jpeg", "image/webp"]),
            sizeBytes: z.number().int().positive().max(8 * 1024 * 1024),
            publicPath: z
              .string()
              .regex(
                /^\/frontmind-user-media\/[a-f0-9]{64}\.(?:png|jpg|webp)$/u,
              ),
          })
          .strict(),
      )
      .max(8)
      .optional(),
    buildDelivery: z
      .object({
        renderMode: z.enum([
          "primary",
          "content_patch",
          "trusted_fallback",
          "twenty_first_native",
        ]),
        qaStatus: z.enum(["passed", "passed_with_warnings", "partial"]),
        warningCodes: z.array(z.string().trim().min(1).max(128)).max(100),
      })
      .strict()
      .nullable()
      .default(null),
    buildPhase: z
      .enum([
        "source_waiting",
        "source_repairing",
        "provider_sync_delayed",
        "source_validating",
        "compiling",
        "persisting_preview",
      ])
      .nullable()
      .optional(),
    recoverable: z.boolean().optional(),
    previewWarning: z.string().trim().min(1).max(500).nullable().optional(),
    needsHelp: z.boolean().default(false),
    createdAt: z.string().datetime(),
    updatedAt: z.string().datetime(),
  })
  .strict();

export const siteOpsExecutionStepProjectionSchema = z
  .object({
    id: z.string().trim().min(1).max(255),
    operationKind: z.enum([
      "visual_search",
      "site_build",
      "build_revision",
      "deploy",
    ]),
    buildId: z.string().uuid().nullable(),
    stage: z.enum([
      "visual_searching",
      "preparing",
      "design_compiling",
      "content_building",
      "qa_running",
      "completed",
    ]),
    label: z.string().trim().min(1).max(100),
    status: z.enum([
      "queued",
      "running",
      "succeeded",
      "failed",
      "attention_required",
      "cancelled",
    ]),
    startedAt: z.string().datetime(),
    completedAt: z.string().datetime().nullable(),
  })
  .strict();

export const siteOpsDeploymentProjectionSchema = z
  .object({
    id: z.string().uuid(),
    buildId: z.string().uuid(),
    target: z.enum(["global_excluding_cn", "mainland_cn"]),
    status: z.enum([
      "reserved",
      "deploying",
      "verifying",
      "active",
      "failed",
      "attention_required",
      "superseded",
    ]),
    publicUrl: z.string().max(2_048).nullable().default(null),
    createdAt: z.string().datetime(),
  })
  .strict();

export const siteOpsSocialPackageProjectionSchema = z
  .object({
    id: z.string().uuid(),
    channel: z.enum(["wechat", "xiaohongshu"]),
    status: z.enum([
      "queued",
      "building",
      "qa_running",
      "ready",
      "failed",
      "attention_required",
      "cancelled",
    ]),
    archiveUrl: z.string().max(2_048).nullable().default(null),
    createdAt: z.string().datetime(),
  })
  .strict();

export const siteOpsAliyunConnectionProjectionSchema = z
  .object({
    configured: z.boolean(),
    status: z.enum([
      "not_connected",
      "authorization_required",
      "active",
      "attention_required",
    ]),
    verifiedAt: z.string().datetime().nullable(),
    canDisconnect: z.boolean().default(true),
  })
  .strict();

export const siteOpsDomainStateProjectionSchema = z
  .object({
    domain: z.string().max(255).nullable(),
    displayDomain: z.string().max(255).nullable(),
    revision: z.number().int().positive(),
    ownershipStatus: z.string().max(64).nullable(),
    dnsStatus: z.string().max(64).nullable(),
    icpStatus: z.enum([
      "not_submitted",
      "preparing",
      "submitted",
      "approved",
      "rejected",
      "not_required",
    ]),
    icpDomainRevision: z.number().int().positive().nullable(),
    icpVerifiedAt: z.string().datetime().nullable(),
  })
  .strict();

export const siteOpsInteractionStateSchema = z.enum([
  "select_snapshot",
  "collecting_brief",
  "visual_searching",
  "awaiting_visual_selection",
  "building",
  "preview_ready",
  "approved",
  "live",
  "attention_required",
  "failed",
  "cancelled",
]);

export const siteOpsObservationV1Schema = z
  .object({
    schemaVersion: z.literal(1).default(1),
    executionKind: z.literal("site_ops"),
    serviceReadiness: z
      .object({
        visuals: z
          .object({
            status: z.enum([
              "configured",
              "not_configured",
              "attention_required",
            ]),
            reason: z.string().max(1_000).optional(),
          })
          .strict(),
        website: z
          .object({
            status: z.enum([
              "configured",
              "not_configured",
              "attention_required",
            ]),
            reason: z.string().max(1_000).optional(),
          })
          .strict(),
        publishing: z
          .object({
            status: z.enum([
              "configured",
              "not_configured",
              "attention_required",
            ]),
            reason: z.string().max(1_000).optional(),
          })
          .strict(),
        domain: z
          .object({
            status: z.enum([
              "configured",
              "not_configured",
              "attention_required",
            ]),
            reason: z.string().max(1_000).optional(),
          })
          .strict(),
      })
      .strict(),
    aliyunConnection: siteOpsAliyunConnectionProjectionSchema,
    domainState: siteOpsDomainStateProjectionSchema.nullable(),
    project: siteOpsProjectProjectionSchema,
    brief: siteBriefSchema.nullable(),
    knowledgeSnapshots: z
      .array(siteOpsKnowledgeSnapshotSchema)
      .max(200)
      .default([]),
    messages: z.array(siteOpsMessageProjectionSchema).max(1_000),
    visualCandidates: z
      .array(siteOpsVisualCandidateProjectionSchema)
      .max(9)
      .default([]),
    visualCandidatePages: z
      .array(siteOpsVisualCandidatePageProjectionSchema)
      .max(4)
      .default([]),
    visualGeneration: siteOpsVisualGenerationProjectionSchema.default({
      status: "idle",
      targetPage: null,
      generatedPages: 0,
      maxPages: SITEOPS_VISUAL_CANDIDATE_MAX_PAGES,
      canGenerateMore: false,
      canSelectExisting: true,
    }),
    executionSteps: z
      .array(siteOpsExecutionStepProjectionSchema)
      .max(300)
      .default([]),
    builds: z.array(siteOpsBuildProjectionSchema).max(100).default([]),
    deployments: z
      .array(siteOpsDeploymentProjectionSchema)
      .max(100)
      .default([]),
    socialPackages: z
      .array(siteOpsSocialPackageProjectionSchema)
      .max(100)
      .default([]),
    rebuildRequest: z
      .object({
        allowed: z.boolean(),
        ticketId: z.string().uuid().nullable(),
        status: z
          .enum([
            "submitted",
            "needs_information",
            "scheduled",
            "in_progress",
            "completed",
            "rejected",
            "cancelled",
          ])
          .nullable(),
        resetApplied: z.boolean(),
        // Optional for one rolling-release window; the server always emits it
        // and older cached observations safely behave as `false`.
        resetPending: z.boolean().optional(),
        resetSourceBuildId: z.string().uuid().nullable(),
      })
      .strict(),
    interactionState: siteOpsInteractionStateSchema,
    latestSequence: z.number().int().nonnegative(),
  })
  .strict()
  .superRefine((value, context) => {
    const staticCatalog =
      value.visualGeneration.workflowVersion === "2.8.0" ||
      value.visualGeneration.workflowVersion === "2.9.0";
    const expectedPageSize = staticCatalog
      ? 8
      : SITEOPS_VISUAL_CANDIDATE_PAGE_SIZE;
    value.visualCandidatePages.forEach((page, index) => {
      if (page.candidates.length !== expectedPageSize) {
        context.addIssue({
          code: "custom",
          path: ["visualCandidatePages", index, "candidates"],
          message: staticCatalog
            ? "Static catalog visual pages must contain exactly 8 candidates"
            : "Historical visual pages must contain exactly 9 candidates",
        });
      }
    });
  });

export type SiteOpsKnowledgeSnapshot = z.infer<
  typeof siteOpsKnowledgeSnapshotSchema
>;
export type SiteOpsProjectProjection = z.infer<
  typeof siteOpsProjectProjectionSchema
>;
export type SiteOpsMessageProjection = z.infer<
  typeof siteOpsMessageProjectionSchema
>;
export type SiteOpsPublicVisualCandidate = z.infer<
  typeof siteOpsVisualCandidateProjectionSchema
>;
export type SiteOpsVisualCandidatePage = z.infer<
  typeof siteOpsVisualCandidatePageProjectionSchema
>;
export type SiteOpsBuildProjection = z.infer<
  typeof siteOpsBuildProjectionSchema
>;
export type SiteOpsExecutionStep = z.infer<
  typeof siteOpsExecutionStepProjectionSchema
>;
export type SiteOpsObservationV1 = z.infer<typeof siteOpsObservationV1Schema>;
