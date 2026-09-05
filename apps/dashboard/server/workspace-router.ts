import { protectedProcedure, router } from "./_core/trpc";
import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { toTrpcError } from "./auth-router";
import {
  getDashboardQuestion,
  getDashboardWorkspace,
  getLatestKnowledgeSnapshot,
  toPublicDashboardPayload,
} from "./dashboard-service";
import { getKnowledgeBaseProgress } from "./knowledge-base-progress-service";
import {
  listResponseLogicEntries,
  saveResponseLogicEntry,
} from "./response-logic-service";
import { saveResponseLogicSchema } from "../shared/response-logic";
import { AuthServiceError } from "./auth-service";
import {
  listMonitoringCitationsSchema,
  listMonitoringSampleCitationsSchema,
  listMonitoringSamplesSchema,
  monitoringCitationSummarySchema,
  monitoringFilterOptionsSchema,
} from "../shared/monitoring";
import {
  getMonitoringFilterOptions,
  getMonitoringCitationSummary,
  listMonitoringCitations,
  listMonitoringSampleCitations,
  listMonitoringSamples,
  resolveMonitoringReadQuotaPeriodIds,
} from "./monitoring-service";
import {
  assertServiceCapability,
  confirmWorkspaceQuestionIntent,
  getServicePortal,
  listWorkspaceQuestions,
  requestWorkspaceQuestionSelection,
  ServiceEntitlementError,
} from "./service-entitlement";
import {
  toPublicServicePortal,
  toPublicServicePortalQuestion,
} from "../shared/service-portal";
import {
  createServicePurchaseIntent,
  PurchaseProvisioningError,
} from "./provisioning-v2-service";
import { getHistoricalQuestionResults } from "./historical-results-service";
import {
  addDeliveryTicketMessageSchema,
  createDeliveryTicketSchema,
  deliveryTicketDetailInputSchema,
  deliveryTicketListInputSchema,
} from "../shared/delivery-ticket";
import {
  addDeliveryTicketMessage,
  createDeliveryTicket,
  DeliveryTicketError,
  getDeliveryTicketWorkspace,
  getPublicDeliveryTicketDetail,
  getPublicDeliveryTicketWorkspaceMetadata,
  listWorkspaceDeliveryTickets,
  requestWebsiteStyleRevision,
  selectWebsiteStyleSample,
  toPublicDeliveryTicketCreationResult,
} from "./delivery-ticket-service";
import type { DashboardPayload } from "../shared/dashboard";
import { knowledgeResetReasonSchema } from "../shared/delivery-roles";
import {
  getKnowledgeResetStatus,
  submitKnowledgeReset,
} from "./knowledge-base-reset-service";

export function projectUserDashboardPayload(input: {
  payload: DashboardPayload;
  configured: boolean;
  contentAssetsAllowed: boolean;
}) {
  if (!input.configured) return null;
  const payload = toPublicDashboardPayload(input.payload);
  if (input.contentAssetsAllowed) return payload;
  return {
    ...payload,
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

function toServiceError(error: unknown): never {
  if (error instanceof DeliveryTicketError) {
    throw new TRPCError({
      code:
        error.statusCode === 404
          ? "NOT_FOUND"
          : error.statusCode === 403
            ? "FORBIDDEN"
            : error.statusCode === 400
              ? "BAD_REQUEST"
              : error.statusCode === 503
                ? "INTERNAL_SERVER_ERROR"
                : "CONFLICT",
      message: error.message,
      cause: error,
    });
  }
  if (error instanceof ServiceEntitlementError) {
    throw new TRPCError({
      code:
        error.statusCode === 404
          ? "NOT_FOUND"
          : error.statusCode === 403
            ? "FORBIDDEN"
            : error.statusCode === 400
              ? "BAD_REQUEST"
              : error.statusCode === 503
                ? "INTERNAL_SERVER_ERROR"
                : "CONFLICT",
      message: error.message,
      cause: error,
    });
  }
  if (error instanceof PurchaseProvisioningError) {
    throw new TRPCError({
      code:
        error.status === 404
          ? "NOT_FOUND"
          : error.status === 403
            ? "FORBIDDEN"
            : error.status === 400
              ? "BAD_REQUEST"
              : error.status === 503
                ? "INTERNAL_SERVER_ERROR"
                : "CONFLICT",
      message: error.message,
      cause: error,
    });
  }
  throw toTrpcError(error);
}

export const workspaceRouter = router({
  knowledgeReset: router({
    status: protectedProcedure.query(async ({ ctx }) => {
      try {
        return await getKnowledgeResetStatus(ctx.user.id);
      } catch (error) {
        toServiceError(error);
      }
    }),
    submit: protectedProcedure
      .input(
        z.object({
          reasonCode: knowledgeResetReasonSchema,
          reasonNote: z.string().trim().max(2_000).optional(),
        }),
      )
      .mutation(async ({ ctx, input }) => {
        try {
          return await submitKnowledgeReset({
            actor: ctx.user,
            ...input,
          });
        } catch (error) {
          toServiceError(error);
        }
      }),
  }),
  portal: protectedProcedure.query(async ({ ctx }) => {
    try {
      const [portal, delivery] = await Promise.all([
        getServicePortal(ctx.user.id),
        getPublicDeliveryTicketWorkspaceMetadata(ctx.user.id),
      ]);
      return {
        ...toPublicServicePortal(portal),
        delivery,
      };
    } catch (error) {
      toServiceError(error);
    }
  }),

  deliveryTickets: router({
    workspace: protectedProcedure.query(async ({ ctx }) => {
      try {
        return await getDeliveryTicketWorkspace(ctx.user.id);
      } catch (error) {
        toServiceError(error);
      }
    }),
    overview: protectedProcedure.query(async ({ ctx }) => {
      try {
        return await getDeliveryTicketWorkspace(ctx.user.id);
      } catch (error) {
        toServiceError(error);
      }
    }),
    list: protectedProcedure
      .input(deliveryTicketListInputSchema.optional())
      .query(async ({ ctx, input }) => {
        try {
          return await listWorkspaceDeliveryTickets({
            userId: ctx.user.id,
            value: input,
          });
        } catch (error) {
          toServiceError(error);
        }
      }),
    detail: protectedProcedure
      .input(deliveryTicketDetailInputSchema)
      .query(async ({ ctx, input }) => {
        try {
          return await getPublicDeliveryTicketDetail({
            userId: ctx.user.id,
            ticketId: input.ticketId,
          });
        } catch (error) {
          toServiceError(error);
        }
      }),
    create: protectedProcedure
      .input(createDeliveryTicketSchema)
      .mutation(async ({ ctx, input }) => {
        if (ctx.user.role !== "user") {
          throw new TRPCError({
            code: "FORBIDDEN",
            message: "只有当前用户可以提交交付工单。",
          });
        }
        try {
          return toPublicDeliveryTicketCreationResult(
            await createDeliveryTicket({
              userId: ctx.user.id,
              value: input,
            }),
          );
        } catch (error) {
          toServiceError(error);
        }
      }),
    selectWebsiteStyle: protectedProcedure
      .input(
        z.object({
          sampleId: z.string().uuid(),
          expectedRevision: z.number().int().positive(),
        }),
      )
      .mutation(async ({ ctx, input }) => {
        try {
          return await selectWebsiteStyleSample({
            actor: ctx.user,
            ...input,
          });
        } catch (error) {
          toServiceError(error);
        }
      }),
    requestWebsiteStyleRevision: protectedProcedure
      .input(
        z.object({
          reason: z.string().trim().min(1).max(2_000),
          expectedRevision: z.number().int().positive(),
        }),
      )
      .mutation(async ({ ctx, input }) => {
        try {
          return await requestWebsiteStyleRevision({
            actor: ctx.user,
            ...input,
          });
        } catch (error) {
          toServiceError(error);
        }
      }),
    addMessage: protectedProcedure
      .input(addDeliveryTicketMessageSchema)
      .mutation(async ({ ctx, input }) => {
        if (ctx.user.role !== "user") {
          throw new TRPCError({
            code: "FORBIDDEN",
            message: "只有当前用户可以补充工单资料。",
          });
        }
        try {
          return await addDeliveryTicketMessage({
            actor: ctx.user,
            workspaceUserId: ctx.user.id,
            value: input,
          });
        } catch (error) {
          toServiceError(error);
        }
      }),
  }),

  questionPortfolio: protectedProcedure.query(async ({ ctx }) => {
    try {
      const portal = await getServicePortal(ctx.user.id);
      const quotaPeriodId = portal.quotas?.periodId;
      return {
        questions: quotaPeriodId
          ? (
              await listWorkspaceQuestions({
                userId: ctx.user.id,
                quotaPeriodId,
              })
            ).map(toPublicServicePortalQuestion)
          : [],
      };
    } catch (error) {
      toServiceError(error);
    }
  }),

  purchaseIntent: protectedProcedure
    .input(
      z.object({
        targetPlanCode: z.enum(["basic", "advanced", "luxury"]),
        kind: z.enum(["repeat_basic", "upgrade", "renewal"]),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      if (ctx.user.role !== "user") {
        throw new TRPCError({
          code: "FORBIDDEN",
          message: "只有当前用户可以发起购买意向。",
        });
      }
      try {
        return await createServicePurchaseIntent({
          userId: ctx.user.id,
          ...input,
        });
      } catch (error) {
        toServiceError(error);
      }
    }),

  selectQuestion: protectedProcedure
    .input(
      z.object({
        questionId: z.string().trim().min(1).max(64),
        expectedRevision: z.number().int().positive(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      if (ctx.user.role !== "user") {
        throw new TRPCError({
          code: "FORBIDDEN",
          message: "只有当前用户可以提交目标问题。",
        });
      }
      try {
        await assertServiceCapability(ctx.user.id, "questionSelection");
        const question = await requestWorkspaceQuestionSelection({
          userId: ctx.user.id,
          actorUserId: ctx.user.id,
          questionId: input.questionId,
          expectedRevision: input.expectedRevision,
        });
        return {
          question: toPublicServicePortalQuestion(question),
        };
      } catch (error) {
        toServiceError(error);
      }
    }),

  requestQuestionSelection: protectedProcedure
    .input(
      z.discriminatedUnion("mode", [
        z.object({
          mode: z.literal("candidate"),
          questionId: z.string().trim().min(1).max(64),
          expectedRevision: z.number().int().positive(),
        }),
        z.object({
          mode: z.literal("direct"),
          question: z
            .string()
            .trim()
            .min(2, "目标问题至少需要 2 个字符")
            .max(4_000, "目标问题不能超过 4000 个字符"),
          category: z.enum([
            "industry",
            "competitor_comparison",
            "reputation",
            "product_scenario",
          ]),
        }),
      ]),
    )
    .mutation(async ({ ctx, input }) => {
      if (ctx.user.role !== "user") {
        throw new TRPCError({
          code: "FORBIDDEN",
          message: "只有当前用户可以提交目标问题。",
        });
      }
      try {
        await assertServiceCapability(ctx.user.id, "questionSelection");
        const question =
          input.mode === "candidate"
            ? await requestWorkspaceQuestionSelection({
                userId: ctx.user.id,
                actorUserId: ctx.user.id,
                questionId: input.questionId,
                expectedRevision: input.expectedRevision,
              })
            : await requestWorkspaceQuestionSelection({
                userId: ctx.user.id,
                actorUserId: ctx.user.id,
                question: input.question,
                category: input.category,
              });
        return {
          question: toPublicServicePortalQuestion(question),
        };
      } catch (error) {
        toServiceError(error);
      }
    }),

  confirmQuestionIntent: protectedProcedure
    .input(
      z.object({
        questionId: z.string().trim().min(1).max(64),
        expectedRevision: z.number().int().positive(),
        expectedIntentRevision: z.number().int().positive(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      if (ctx.user.role !== "user") {
        throw new TRPCError({
          code: "FORBIDDEN",
          message: "只有当前用户本人可以确认问题优化结果。",
        });
      }
      try {
        const question = await confirmWorkspaceQuestionIntent({
          userId: ctx.user.id,
          ...input,
        });
        return {
          question: toPublicServicePortalQuestion(question),
        };
      } catch (error) {
        toServiceError(error);
      }
    }),

  dashboard: protectedProcedure.query(async ({ ctx }) => {
    try {
      const [workspace, portal] = await Promise.all([
        getDashboardWorkspace(ctx.user.id),
        getServicePortal(ctx.user.id),
      ]);
      const configured = workspace.revision > 0;
      return {
        ...workspace,
        configured,
        enterpriseName: workspace.payload.brandName,
        payload: projectUserDashboardPayload({
          payload: workspace.payload,
          configured,
          contentAssetsAllowed: portal.capabilities.contentAssets.allowed,
        }),
      };
    } catch (error) {
      throw toTrpcError(error);
    }
  }),

  knowledge: protectedProcedure.query(async ({ ctx }) => {
    try {
      return { snapshot: await getLatestKnowledgeSnapshot(ctx.user.id) };
    } catch (error) {
      throw toTrpcError(error);
    }
  }),

  knowledgeProgress: protectedProcedure
    .input(
      z
        .object({
          conversationId: z.string().trim().min(1).max(191).optional(),
        })
        .optional(),
    )
    .query(async ({ ctx, input }) => {
      try {
        return {
          progress: await getKnowledgeBaseProgress({
            userId: ctx.user.id,
            conversationId: input?.conversationId,
          }),
        };
      } catch (error) {
        throw toTrpcError(error);
      }
    }),

  responseLogic: protectedProcedure.query(async ({ ctx }) => {
    try {
      return { records: await listResponseLogicEntries(ctx.user.id) };
    } catch (error) {
      throw toTrpcError(error);
    }
  }),

  historicalQuestionResults: protectedProcedure
    .input(
      z.object({
        questionId: z.string().trim().min(1).max(191),
      }),
    )
    .query(async ({ ctx, input }) => {
      try {
        return await getHistoricalQuestionResults({
          userId: ctx.user.id,
          questionId: input.questionId,
        });
      } catch (error) {
        toServiceError(error);
      }
    }),

  saveResponseLogic: protectedProcedure
    .input(saveResponseLogicSchema)
    .mutation(async ({ ctx, input }) => {
      try {
        await assertServiceCapability(ctx.user.id, "responseLogic");
        const question = await getDashboardQuestion(
          ctx.user.id,
          input.questionId,
        );
        if (!question) {
          throw new AuthServiceError(
            "INVALID_CREDENTIAL",
            "当前问题未由管理员配置，无法保存应答逻辑",
          );
        }
        return {
          record: await saveResponseLogicEntry({
            userId: ctx.user.id,
            value: {
              ...input,
              ...question,
            },
          }),
        };
      } catch (error) {
        throw toTrpcError(error);
      }
    }),

  monitoring: router({
    filters: protectedProcedure
      .input(monitoringFilterOptionsSchema.optional())
      .query(async ({ ctx, input }) => {
        try {
          return await getMonitoringFilterOptions(
            ctx.user.id,
            await resolveMonitoringReadQuotaPeriodIds(ctx.user.id),
            input ?? {},
          );
        } catch (error) {
          throw toTrpcError(error);
        }
      }),

    samples: protectedProcedure
      .input(listMonitoringSamplesSchema)
      .query(async ({ ctx, input }) => {
        try {
          return await listMonitoringSamples({
            userId: ctx.user.id,
            filters: input,
            quotaPeriodIds: await resolveMonitoringReadQuotaPeriodIds(
              ctx.user.id,
            ),
          });
        } catch (error) {
          throw toTrpcError(error);
        }
      }),

    citations: protectedProcedure
      .input(listMonitoringCitationsSchema)
      .query(async ({ ctx, input }) => {
        try {
          return await listMonitoringCitations({
            userId: ctx.user.id,
            filters: input,
            quotaPeriodIds: await resolveMonitoringReadQuotaPeriodIds(
              ctx.user.id,
            ),
          });
        } catch (error) {
          throw toTrpcError(error);
        }
      }),

    sampleCitations: protectedProcedure
      .input(listMonitoringSampleCitationsSchema)
      .query(async ({ ctx, input }) => {
        try {
          return await listMonitoringSampleCitations({
            userId: ctx.user.id,
            value: input,
            quotaPeriodIds: await resolveMonitoringReadQuotaPeriodIds(
              ctx.user.id,
            ),
          });
        } catch (error) {
          throw toTrpcError(error);
        }
      }),

    citationSummary: protectedProcedure
      .input(monitoringCitationSummarySchema)
      .query(async ({ ctx, input }) => {
        try {
          return await getMonitoringCitationSummary({
            userId: ctx.user.id,
            value: input,
            quotaPeriodIds: await resolveMonitoringReadQuotaPeriodIds(
              ctx.user.id,
            ),
          });
        } catch (error) {
          throw toTrpcError(error);
        }
      }),
  }),
});
