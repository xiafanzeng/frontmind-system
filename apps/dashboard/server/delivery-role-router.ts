import { TRPCError } from "@trpc/server";
import { z } from "zod";

import {
  BRAND_TRACKING_CREDITS_INPUT_PATTERN,
  brandTrackingCreditsToAmount,
} from "../shared/brand-tracking-credits";
import { deliveryRoleTypeSchema } from "../shared/delivery-roles";
import {
  adjustQuestionQuotaSchema,
  workspaceQuestionCategorySchema,
} from "../shared/service-portal";
import { toTrpcError } from "./auth-router";
import {
  approveMySiteOpsRebuild,
  approveMyCustomerQuestionSelection,
  getMyCustomerBrandTrackingUsage,
  getMyDeliveryHistory,
  getMyDeliveryTickets,
  getMyDeliveryTicketDetail,
  getMyDeliveryWorkbench,
  listDeliveryRoleManagement,
  listMyProjectAssignments,
  publishWebsiteStyleSamples,
  rejectMyCustomerQuestionSelection,
  setProjectEngineer,
  updateMyCustomerBrandTrackingLimit,
  updateMyDeliveryTicket,
} from "./delivery-role-service";
import { adminProcedure, protectedProcedure, router } from "./_core/trpc";
import {
  decideKnowledgeReset,
  previewKnowledgeReset,
} from "./knowledge-base-reset-service";
import { adjustMyCustomerQuestionQuota } from "./question-quota-service";
import {
  decideQuestionMaintenance,
  decideQuestionMaintenanceSchema,
} from "./question-maintenance-service";
import {
  JenovaBrandTrackingError,
  toJenovaBrandTrackingAuthError,
} from "./jenova-brand-tracking-service";

function serviceCall<T>(callback: () => Promise<T>) {
  return callback().catch((error) => {
    throw toTrpcError(error);
  });
}

function jenovaServiceCall<T>(callback: () => Promise<T>) {
  return callback().catch((error) => {
    if (
      error instanceof JenovaBrandTrackingError &&
      ["UNAUTHORIZED", "FORBIDDEN", "INELIGIBLE"].includes(error.code)
    ) {
      throw new TRPCError({
        code: error.code === "UNAUTHORIZED" ? "UNAUTHORIZED" : "FORBIDDEN",
        message: error.message,
        cause: error,
      });
    }
    throw toTrpcError(toJenovaBrandTrackingAuthError(error));
  });
}

const jenovaCreditsAmountError =
  "积分上限必须是非负数，最多 15 位整数和 5 位小数";

const jenovaCreditsAmountSchema = z
  .string()
  .trim()
  .regex(BRAND_TRACKING_CREDITS_INPUT_PATTERN, jenovaCreditsAmountError)
  .transform((value, context) => {
    const amount = brandTrackingCreditsToAmount(value);
    if (amount !== null) return amount;
    context.addIssue({ code: "custom", message: jenovaCreditsAmountError });
    return z.NEVER;
  });

export const deliveryRoleRouter = router({
  management: router({
    overview: adminProcedure.query(({ ctx }) =>
      serviceCall(() => listDeliveryRoleManagement(ctx.user)),
    ),
    setProjectEngineer: adminProcedure
      .input(
        z.object({
          customerUserId: z.number().int().positive(),
          roleType: deliveryRoleTypeSchema,
          engineerUserId: z.number().int().positive().nullable(),
          expectedRevision: z.number().int().nonnegative(),
        }),
      )
      .mutation(({ ctx, input }) =>
        serviceCall(() => setProjectEngineer({ actor: ctx.user, ...input })),
      ),
  }),
  mine: router({
    assignments: protectedProcedure.query(({ ctx }) =>
      serviceCall(() => listMyProjectAssignments(ctx.user)),
    ),
    workbench: protectedProcedure
      .input(z.object({ projectAssignmentId: z.string().uuid() }))
      .query(({ ctx, input }) =>
        serviceCall(() =>
          getMyDeliveryWorkbench({ actor: ctx.user, ...input }),
        ),
      ),
    tickets: protectedProcedure
      .input(
        z
          .object({
            customerUserId: z.number().int().positive().optional(),
            projectAssignmentId: z.string().uuid().optional(),
            statusGroup: z.enum(["pending", "completed"]).optional(),
            limit: z.number().int().min(1).max(100).default(50),
            cursor: z
              .object({
                actionRank: z.number().int().min(0).max(4),
                updatedAt: z.number().int().nonnegative(),
                id: z.string().uuid(),
              })
              .optional(),
          })
          .default({ limit: 50 }),
      )
      .query(({ ctx, input }) =>
        serviceCall(() => getMyDeliveryTickets({ actor: ctx.user, ...input })),
      ),
    approveQuestionSelection: protectedProcedure
      .input(
        z.object({
          projectAssignmentId: z.string().uuid(),
          questionId: z.string().trim().min(1).max(64),
          expectedRevision: z.number().int().positive(),
          category: workspaceQuestionCategorySchema.optional(),
        }),
      )
      .mutation(({ ctx, input }) =>
        serviceCall(() =>
          approveMyCustomerQuestionSelection({
            actor: ctx.user,
            ...input,
          }),
        ),
      ),
    rejectQuestionSelection: protectedProcedure
      .input(
        z.object({
          projectAssignmentId: z.string().uuid(),
          questionId: z.string().trim().min(1).max(64),
          expectedRevision: z.number().int().positive(),
          reason: z.string().trim().min(1).max(2_000),
        }),
      )
      .mutation(({ ctx, input }) =>
        serviceCall(() =>
          rejectMyCustomerQuestionSelection({
            actor: ctx.user,
            ...input,
          }),
        ),
      ),
    adjustQuestionQuota: protectedProcedure
      .input(adjustQuestionQuotaSchema)
      .mutation(({ ctx, input }) =>
        serviceCall(() =>
          adjustMyCustomerQuestionQuota({
            actor: ctx.user,
            value: input,
          }),
        ),
      ),
    brandTrackingUsage: protectedProcedure
      .input(
        z
          .object({
            projectAssignmentId: z.string().uuid(),
          })
          .strict(),
      )
      .query(({ ctx, input }) =>
        jenovaServiceCall(() =>
          getMyCustomerBrandTrackingUsage({
            actor: ctx.user,
            ...input,
          }),
        ),
      ),
    updateBrandTrackingLimit: protectedProcedure
      .input(
        z
          .object({
            projectAssignmentId: z.string().uuid(),
            limitCredits: jenovaCreditsAmountSchema,
          })
          .strict(),
      )
      .mutation(({ ctx, input }) =>
        jenovaServiceCall(() =>
          updateMyCustomerBrandTrackingLimit({
            actor: ctx.user,
            projectAssignmentId: input.projectAssignmentId,
            limit: input.limitCredits,
          }),
        ),
      ),
    history: protectedProcedure
      .input(
        z
          .object({
            status: z.enum(["completed", "rejected", "cancelled"]).optional(),
            customerUserId: z.number().int().positive().optional(),
            operation: z.string().trim().min(1).max(64).optional(),
            limit: z.number().int().min(1).max(50).default(20),
            cursor: z
              .object({
                resolvedAt: z.number().int().nonnegative(),
                id: z.string().uuid(),
              })
              .optional(),
          })
          .default({ limit: 20 }),
      )
      .query(({ ctx, input }) =>
        serviceCall(() => getMyDeliveryHistory({ actor: ctx.user, ...input })),
      ),
    ticketDetail: protectedProcedure
      .input(z.object({ ticketId: z.string().uuid() }))
      .query(({ ctx, input }) =>
        serviceCall(() =>
          getMyDeliveryTicketDetail({ actor: ctx.user, ...input }),
        ),
      ),
    publishWebsiteStyleSamples: protectedProcedure
      .input(
        z.object({
          projectAssignmentId: z.string().uuid(),
          ticketId: z.string().uuid(),
          expectedWorkflowRevision: z.number().int().positive(),
          engineerNote: z.string().trim().max(2_000).optional(),
          samples: z
            .array(
              z.object({
                fileId: z.string().trim().min(1).max(255),
                filename: z.string().trim().min(1).max(512),
                mimeType: z.string().trim().min(1).max(255),
                sizeBytes: z
                  .number()
                  .int()
                  .positive()
                  .max(10 * 1024 * 1024),
                sha256: z
                  .string()
                  .regex(/^[a-f0-9]{64}$/i)
                  .optional(),
                label: z.string().trim().min(1).max(160),
                note: z.string().trim().max(2_000).optional(),
              }),
            )
            .length(3),
        }),
      )
      .mutation(({ ctx, input }) =>
        serviceCall(() =>
          publishWebsiteStyleSamples({ actor: ctx.user, ...input }),
        ),
      ),
    knowledgeResetPreview: protectedProcedure
      .input(
        z.object({
          projectAssignmentId: z.string().uuid(),
          requestId: z.string().uuid(),
        }),
      )
      .query(({ ctx, input }) =>
        serviceCall(() => previewKnowledgeReset({ actor: ctx.user, ...input })),
      ),
    decideKnowledgeReset: protectedProcedure
      .input(
        z.object({
          projectAssignmentId: z.string().uuid(),
          requestId: z.string().uuid(),
          expectedRevision: z.number().int().positive(),
          decision: z.enum(["approve", "reject"]),
          decisionNote: z.string().trim().max(2_000).optional(),
        }),
      )
      .mutation(({ ctx, input }) =>
        serviceCall(() => decideKnowledgeReset({ actor: ctx.user, ...input })),
      ),
    decideQuestionMaintenance: protectedProcedure
      .input(decideQuestionMaintenanceSchema)
      .mutation(({ ctx, input }) =>
        serviceCall(() =>
          decideQuestionMaintenance({ actor: ctx.user, ...input }),
        ),
      ),
    approveSiteRebuild: protectedProcedure
      .input(
        z
          .object({
            projectAssignmentId: z.string().uuid(),
            ticketId: z.string().uuid(),
            expectedRevision: z.number().int().positive(),
          })
          .strict(),
      )
      .mutation(({ ctx, input }) =>
        serviceCall(() =>
          approveMySiteOpsRebuild({ actor: ctx.user, ...input }),
        ),
      ),
    updateTicket: protectedProcedure
      .input(
        z
          .object({
            projectAssignmentId: z.string().uuid(),
            ticketId: z.string().uuid(),
            expectedRevision: z.number().int().positive(),
            status: z.enum([
              "in_progress",
              "needs_information",
              "completed",
              "rejected",
              "cancelled",
            ]),
            message: z.string().trim().max(8_000).optional(),
            publicUrl: z.string().url().max(4_096).optional(),
            previewVerified: z.literal(true).optional(),
            handoff: z
              .object({
                monitoringBatchKey: z.string().trim().max(191).optional(),
                optimizationQuestionIds: z
                  .array(z.string().trim().min(1).max(191))
                  .max(100)
                  .optional(),
                responseLogicRevision: z.number().int().positive().optional(),
                contentAssetIds: z
                  .array(z.string().trim().min(1).max(191))
                  .max(500)
                  .optional(),
                targetMedia: z.string().trim().min(1).max(64).optional(),
                publishTargets: z
                  .array(z.enum(["media", "website"]))
                  .max(2)
                  .optional(),
                websiteOperation: z
                  .enum([
                    "company_facts",
                    "product_case_docs",
                    "industry_news",
                    "company_news",
                    "faq_content",
                  ])
                  .optional(),
                needsFurtherOptimization: z.boolean().optional(),
                domain: z.string().trim().max(512).optional(),
                icpServiceCode: z.string().trim().max(512).optional(),
                icpProvince: z.string().trim().max(64).optional(),
                icpNumber: z.string().trim().max(128).optional(),
                icpNotRequired: z.boolean().optional(),
                siteCheck: z
                  .object({
                    key: z.string().trim().min(1).max(64),
                    label: z.string().trim().min(1).max(160),
                    status: z.enum([
                      "passed",
                      "warning",
                      "failed",
                      "not_applicable",
                    ]),
                    summary: z.string().trim().max(8_000).optional(),
                    evidence: z.string().trim().max(8_000).optional(),
                    source: z.string().trim().min(1).max(4_096).optional(),
                  })
                  .strict()
                  .optional(),
              })
              .strict()
              .optional(),
          })
          .strict(),
      )
      .mutation(({ ctx, input }) =>
        serviceCall(() =>
          updateMyDeliveryTicket({ actor: ctx.user, ...input }),
        ),
      ),
  }),
});
