import { protectedProcedure, router } from "./_core/trpc";
import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { toTrpcError } from "./auth-router";
import { runtimeErrorForLog } from "./_core/runtime-error-log";
import {
  getDashboardQuestion,
  getDashboardWorkspace,
  getLatestKnowledgeSnapshot,
  toPublicDashboardPayload,
} from "./dashboard-service";
import { getKnowledgeBaseProgress } from "./knowledge-base-progress-service";
import { toKnowledgeBasePublicPayload } from "./knowledge-base-public-projection";
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
  confirmWorkspaceBrandKeywordSelection,
  confirmWorkspaceQuestionIntent,
  getServicePortal,
  listWorkspaceQuestions,
  requestWorkspaceQuestionSelection,
  servicePortalHasRequiredKnowledge,
  ServiceEntitlementError,
} from "./service-entitlement";
import { resolveBrandKeywordSelection } from "./brand-keyword-selection";
import {
  QUESTION_CLASSIFICATION_V2_WRITES_ENABLED,
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
import {
  submitQuestionMaintenance,
  submitQuestionMaintenanceSchema,
  completeQuestionReviewRequest,
  ensureQuestionReviewRequest,
} from "./question-maintenance-service";
import {
  reconcileInitialMonitoringAfterQuestionSelection,
  type InitialMonitoringQuestionSelection,
} from "./delivery-role-service";
import {
  getJenovaBrandTrackingOverview,
  getJenovaBrandTrackingSession,
  listJenovaBrandTrackingSessions,
} from "./jenova-brand-tracking-service";
import {
  siteOpsActInputSchema,
  siteOpsAliyunConnectionInputSchema,
  siteOpsObserveInputSchema,
  siteOpsOpenInputSchema,
  siteOpsSendMessageInputSchema,
} from "../shared/siteops";
import {
  actOnSiteOps,
  actOnSiteOpsFast,
  beginSiteOpsAliyunOAuth,
  disconnectSiteOpsAliyunConnection,
  getSiteOpsAliyunConnection,
  listSiteOpsAliyunDomains,
  observeSiteOps,
  openSiteOps,
  sendSiteOpsMessage,
  SiteOpsServiceError,
} from "./siteops/service";
import { brandQuestionUniverseStartInputSchema } from "../shared/brand-question-universe";
import {
  BrandQuestionUniverseServiceError,
  observeBrandQuestionUniverse,
  startBrandQuestionUniverse,
} from "./brand-question-universe-service";

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
  if (error instanceof BrandQuestionUniverseServiceError) {
    const code =
      error.statusCode === 404
        ? "NOT_FOUND"
        : error.statusCode === 403
          ? "FORBIDDEN"
          : error.statusCode === 400
            ? "BAD_REQUEST"
            : error.statusCode === 412
              ? "PRECONDITION_FAILED"
              : error.statusCode === 503
                ? "SERVICE_UNAVAILABLE"
                : error.statusCode === 500
                  ? "INTERNAL_SERVER_ERROR"
                  : error.statusCode === 502
                    ? "BAD_GATEWAY"
                    : "CONFLICT";
    throw new TRPCError({ code, message: error.message, cause: error });
  }
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

function toBrandTrackingServiceError(error: unknown): never {
  const serviceError = error as { code?: unknown; message?: unknown };
  const code = typeof serviceError?.code === "string" ? serviceError.code : "";
  const message =
    typeof serviceError?.message === "string"
      ? serviceError.message
      : "品牌追踪请求暂时无法完成，请稍后重试";
  const trpcCode =
    code === "UNAUTHORIZED"
      ? "UNAUTHORIZED"
      : code === "FORBIDDEN" || code === "INELIGIBLE"
        ? "FORBIDDEN"
        : code === "NOT_FOUND"
          ? "NOT_FOUND"
          : code === "LIMIT_EXCEEDED"
            ? "TOO_MANY_REQUESTS"
            : code === "IDEMPOTENCY_PENDING" || code === "IDEMPOTENCY_CONFLICT"
              ? "CONFLICT"
              : code === "KEY_REQUIRED"
                ? "PRECONDITION_FAILED"
                : code === "INVALID_INPUT"
                  ? "BAD_REQUEST"
                  : code === "UPSTREAM_UNAVAILABLE"
                    ? "BAD_GATEWAY"
                    : "INTERNAL_SERVER_ERROR";
  throw new TRPCError({ code: trpcCode, message, cause: error });
}

export function toSiteOpsServiceError(error: unknown): never {
  if (!(error instanceof SiteOpsServiceError)) {
    console.error("[SiteOps] unexpected_error", runtimeErrorForLog(error));
    throw toTrpcError(error);
  }
  const code =
    error.statusCode === 404
      ? "NOT_FOUND"
      : error.statusCode === 403
        ? "FORBIDDEN"
        : error.statusCode === 400
          ? "BAD_REQUEST"
          : error.statusCode === 412
            ? "PRECONDITION_FAILED"
            : error.statusCode === 503
              ? "SERVICE_UNAVAILABLE"
              : "CONFLICT";
  throw new TRPCError({ code, message: error.message, cause: error });
}

export const workspaceRouter = router({
  brandQuestionUniverse: router({
    observe: protectedProcedure.query(async ({ ctx }) => {
      try {
        return await observeBrandQuestionUniverse(ctx.user);
      } catch (error) {
        toServiceError(error);
      }
    }),
    start: protectedProcedure
      .input(brandQuestionUniverseStartInputSchema)
      .mutation(async ({ ctx, input }) => {
        try {
          return await startBrandQuestionUniverse({
            actor: ctx.user,
            value: input,
          });
        } catch (error) {
          toServiceError(error);
        }
      }),
  }),
  siteOps: router({
    open: protectedProcedure
      .input(siteOpsOpenInputSchema)
      .mutation(async ({ ctx }) => {
        try {
          return await openSiteOps(ctx.user);
        } catch (error) {
          toSiteOpsServiceError(error);
        }
      }),
    observe: protectedProcedure
      .input(siteOpsObserveInputSchema)
      .query(async ({ ctx, input }) => {
        try {
          return await observeSiteOps(ctx.user, input);
        } catch (error) {
          toSiteOpsServiceError(error);
        }
      }),
    sendMessage: protectedProcedure
      .input(siteOpsSendMessageInputSchema)
      .mutation(async ({ ctx, input }) => {
        try {
          return await sendSiteOpsMessage(ctx.user, input);
        } catch (error) {
          toSiteOpsServiceError(error);
        }
      }),
    act: protectedProcedure
      .input(siteOpsActInputSchema)
      .mutation(async ({ ctx, input }) => {
        try {
          return await actOnSiteOps(ctx.user, input);
        } catch (error) {
          toSiteOpsServiceError(error);
        }
      }),
    actFast: protectedProcedure
      .input(siteOpsActInputSchema)
      .mutation(async ({ ctx, input }) => {
        try {
          return await actOnSiteOpsFast(ctx.user, input);
        } catch (error) {
          toSiteOpsServiceError(error);
        }
      }),
    aliyunConnection: router({
      get: protectedProcedure
        .input(siteOpsAliyunConnectionInputSchema)
        .query(async ({ ctx, input }) => {
          try {
            return await getSiteOpsAliyunConnection(ctx.user, input);
          } catch (error) {
            toSiteOpsServiceError(error);
          }
        }),
      beginOAuth: protectedProcedure
        .input(siteOpsAliyunConnectionInputSchema)
        .mutation(async ({ ctx, input }) => {
          try {
            return await beginSiteOpsAliyunOAuth(ctx.user, input);
          } catch (error) {
            toSiteOpsServiceError(error);
          }
        }),
      listDomains: protectedProcedure
        .input(siteOpsAliyunConnectionInputSchema)
        .query(async ({ ctx, input }) => {
          try {
            return await listSiteOpsAliyunDomains(ctx.user, input);
          } catch (error) {
            toSiteOpsServiceError(error);
          }
        }),
      disconnect: protectedProcedure
        .input(siteOpsAliyunConnectionInputSchema)
        .mutation(async ({ ctx, input }) => {
          try {
            return await disconnectSiteOpsAliyunConnection(ctx.user, input);
          } catch (error) {
            toSiteOpsServiceError(error);
          }
        }),
    }),
  }),
  brandTracking: router({
    overview: protectedProcedure.query(async ({ ctx }) => {
      try {
        await assertServiceCapability(ctx.user.id, "brandTracking");
        return await getJenovaBrandTrackingOverview(ctx.user);
      } catch (error) {
        if (error instanceof ServiceEntitlementError) toServiceError(error);
        toBrandTrackingServiceError(error);
      }
    }),
    listSessions: protectedProcedure.query(async ({ ctx }) => {
      try {
        await assertServiceCapability(ctx.user.id, "brandTracking");
        return await listJenovaBrandTrackingSessions(ctx.user);
      } catch (error) {
        if (error instanceof ServiceEntitlementError) toServiceError(error);
        toBrandTrackingServiceError(error);
      }
    }),
    getSession: protectedProcedure
      .input(z.object({ sessionId: z.string().uuid() }).strict())
      .query(async ({ ctx, input }) => {
        try {
          await assertServiceCapability(ctx.user.id, "brandTracking");
          return await getJenovaBrandTrackingSession(ctx.user, input.sessionId);
        } catch (error) {
          if (error instanceof ServiceEntitlementError) toServiceError(error);
          toBrandTrackingServiceError(error);
        }
      }),
  }),
  questionMaintenance: router({
    submit: protectedProcedure
      .input(submitQuestionMaintenanceSchema)
      .mutation(async ({ ctx, input }) => {
        try {
          return await submitQuestionMaintenance({
            actor: ctx.user,
            value: input,
          });
        } catch (error) {
          toServiceError(error);
        }
      }),
  }),
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
            message: "只有当前用户可以提交交付需求。",
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
            message: "只有当前用户可以补充需求资料。",
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
      z.union([
        z
          .object({
            mode: z.literal("candidate"),
            questionId: z.string().trim().min(1).max(64),
            expectedRevision: z.number().int().positive(),
          })
          .strict(),
        z
          .object({
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
          })
          .strict(),
        z
          .object({
            mode: z.literal("direct"),
            question: z
              .string()
              .trim()
              .min(2, "目标问题至少需要 2 个字符")
              .max(4_000, "目标问题不能超过 4000 个字符"),
            classificationVersion: z.literal(2),
          })
          .strict(),
        z
          .object({
            mode: z.literal("brand_keyword_library"),
            dashboardRevision: z.number().int().positive(),
            tableId: z.string().trim().min(1).max(80),
            rowIndex: z.number().int().nonnegative().max(9_999),
          })
          .strict(),
      ]),
    )
    .mutation(async ({ ctx, input }) => {
      if (ctx.user.role !== "user") {
        throw new TRPCError({
          code: "FORBIDDEN",
          message: "只有当前用户可以提交目标问题。",
        });
      }
      if (
        input.mode === "direct" &&
        "classificationVersion" in input &&
        !QUESTION_CLASSIFICATION_V2_WRITES_ENABLED
      ) {
        throw new TRPCError({
          code: "SERVICE_UNAVAILABLE",
          message: "问题分类能力正在升级，请稍后重试。",
        });
      }
      try {
        await assertServiceCapability(ctx.user.id, "questionSelection");
        let question;
        if (input.mode === "candidate") {
          question = await requestWorkspaceQuestionSelection({
            userId: ctx.user.id,
            actorUserId: ctx.user.id,
            questionId: input.questionId,
            expectedRevision: input.expectedRevision,
          });
        } else if (input.mode === "direct") {
          question = await requestWorkspaceQuestionSelection(
            {
              userId: ctx.user.id,
              actorUserId: ctx.user.id,
              question: input.question,
              ...("category" in input
                ? { category: input.category }
                : { classificationVersion: 2 as const }),
            },
            {
              afterWrite: (executor, pendingQuestion) =>
                ensureQuestionReviewRequest({
                  executor,
                  question: pendingQuestion,
                  actorUserId: ctx.user.id,
                }),
            },
          );
        } else {
          const dashboard = await getDashboardWorkspace(ctx.user.id);
          const reference = {
            dashboardRevision: input.dashboardRevision,
            tableId: input.tableId,
            rowIndex: input.rowIndex,
          };
          const resolved = resolveBrandKeywordSelection({
            workspace: dashboard,
            reference,
          });
          if (!resolved.ok) {
            throw new ServiceEntitlementError(
              "QUESTION_NOT_CURRENT",
              resolved.message,
            );
          }
          const reconcileState: {
            question: InitialMonitoringQuestionSelection | null;
          } = { question: null };
          question = await confirmWorkspaceBrandKeywordSelection(
            {
              userId: ctx.user.id,
              actorUserId: ctx.user.id,
              ...reference,
              expectedQuestion: resolved.selection.question,
              expectedCategory: resolved.selection.category,
            },
            {
              afterWrite: async (executor, selectedQuestion) => {
                reconcileState.question = selectedQuestion;
                await completeQuestionReviewRequest({
                  executor,
                  userId: selectedQuestion.userId,
                  questionId: selectedQuestion.id,
                  actorUserId: ctx.user.id,
                  actorRole: "user",
                  message: "该自主填写问题已从正式品牌词库确认并进入当前服务。",
                });
              },
            },
          );
          if (!reconcileState.question) {
            throw new ServiceEntitlementError(
              "QUESTION_NOT_CURRENT",
              "品牌词库选题结果缺少当前服务范围。",
            );
          }
          await reconcileInitialMonitoringAfterQuestionSelection({
            question: reconcileState.question,
            actorUserId: ctx.user.id,
          });
        }
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
          contentAssetsAllowed:
            portal.capabilities.contentAssets.allowed &&
            servicePortalHasRequiredKnowledge(portal),
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
          progress: toKnowledgeBasePublicPayload(
            await getKnowledgeBaseProgress({
              userId: ctx.user.id,
              conversationId: input?.conversationId,
            }),
          ),
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
            expectedQuestionScope: question.writeScope,
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
