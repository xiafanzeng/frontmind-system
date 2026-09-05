import { z } from "zod";

import { deliveryRoleTypeSchema } from "../shared/delivery-roles";
import { toTrpcError } from "./auth-router";
import {
  approveMyCustomerQuestionSelection,
  getMyDeliveryHistory,
  getMyDeliveryTickets,
  getMyDeliveryTicketDetail,
  getMyDeliveryWorkbench,
  listDeliveryRoleManagement,
  listMyProjectAssignments,
  publishWebsiteStyleSamples,
  setProjectEngineer,
  updateMyDeliveryTicket,
} from "./delivery-role-service";
import { adminProcedure, protectedProcedure, router } from "./_core/trpc";
import {
  decideKnowledgeReset,
  previewKnowledgeReset,
} from "./knowledge-base-reset-service";

function serviceCall<T>(callback: () => Promise<T>) {
  return callback().catch((error) => {
    throw toTrpcError(error);
  });
}

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
    updateTicket: protectedProcedure
      .input(
        z.object({
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
                  source: z.string().trim().max(4_096).optional(),
                })
                .optional(),
            })
            .optional(),
        }),
      )
      .mutation(({ ctx, input }) =>
        serviceCall(() =>
          updateMyDeliveryTicket({ actor: ctx.user, ...input }),
        ),
      ),
  }),
});
