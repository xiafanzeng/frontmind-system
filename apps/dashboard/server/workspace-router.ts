import { enterpriseWorkspaceUserId } from "./enterprise-project-context";
import {
  assertDashboardUpdateCapability,
  mergeCustomerDashboardPayload,
  projectUserDashboardPayload,
} from "./dashboard-editing";
import { protectedProcedure, router } from "./_core/trpc";
import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { toTrpcError } from "./auth-router";
import { runtimeErrorForLog } from "./_core/runtime-error-log";
import {
  assertDashboardEnterpriseIdentity,
  updateDashboardWorkspace,
  getDashboardQuestion,
  getDashboardWorkspace,
  getLatestKnowledgeSnapshot,
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
  assertServiceWriteAccess,
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
  toPublicServicePortal,
  toPublicServicePortalQuestion,
} from "../shared/service-portal";
import {
  createServicePurchaseIntent,
  PurchaseProvisioningError,
} from "./provisioning-v2-service";
import { getHistoricalQuestionResults } from "./historical-results-service";
import { dashboardPayloadSchema } from "../shared/dashboard";
import {
  getKnowledgeResetStatus,
  resetKnowledgeBase,
} from "./knowledge-base-reset-service";
import {
  applyQuestionMaintenance,
  applyQuestionMaintenanceSchema,
} from "./question-maintenance-service";
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

export { projectUserDashboardPayload } from "./dashboard-editing";

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
        await assertServiceCapability(enterpriseWorkspaceUserId(ctx.user.id), "brandTracking");
        return await getJenovaBrandTrackingOverview(ctx.user);
      } catch (error) {
        if (error instanceof ServiceEntitlementError) toServiceError(error);
        toBrandTrackingServiceError(error);
      }
    }),
    listSessions: protectedProcedure.query(async ({ ctx }) => {
      try {
        await assertServiceCapability(enterpriseWorkspaceUserId(ctx.user.id), "brandTracking");
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
          await assertServiceCapability(enterpriseWorkspaceUserId(ctx.user.id), "brandTracking");
          return await getJenovaBrandTrackingSession(ctx.user, input.sessionId);
        } catch (error) {
          if (error instanceof ServiceEntitlementError) toServiceError(error);
          toBrandTrackingServiceError(error);
        }
      }),
  }),
  questionMaintenance: router({
    execute: protectedProcedure
      .input(applyQuestionMaintenanceSchema)
      .mutation(async ({ ctx, input }) => {
        try {
          return await applyQuestionMaintenance({
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
        return await getKnowledgeResetStatus(enterpriseWorkspaceUserId(ctx.user.id));
      } catch (error) {
        toServiceError(error);
      }
    }),
    reset: protectedProcedure
      .input(
        z.object({ expectedRevision: z.number().int().nonnegative() }).strict(),
      )
      .mutation(async ({ ctx, input }) => {
        try {
          return await resetKnowledgeBase({ actor: ctx.user, ...input });
        } catch (error) {
          toServiceError(error);
        }
      }),
  }),
  portal: protectedProcedure.query(async ({ ctx }) => {
    try {
      return toPublicServicePortal(await getServicePortal(enterpriseWorkspaceUserId(ctx.user.id)));
    } catch (error) {
      toServiceError(error);
    }
  }),
  saveDashboard: protectedProcedure
    .input(
      z
        .object({
          expectedRevision: z.number().int().nonnegative(),
          payload: dashboardPayloadSchema,
          sourceName: z.string().trim().min(1).max(512).optional(),
          reason: z.string().trim().max(2_000).optional(),
        })
        .strict(),
    )
    .mutation(async ({ ctx, input }) => {
      if (ctx.user.role !== "user")
        throw new TRPCError({
          code: "FORBIDDEN",
          message: "只有客户可以修改自己的看板",
        });
      try {
        const portal = await assertServiceWriteAccess(enterpriseWorkspaceUserId(ctx.user.id));
        const existing = await getDashboardWorkspace(enterpriseWorkspaceUserId(ctx.user.id));
        const contentAssetsVisible =
          portal.capabilities.contentAssets.allowed &&
          servicePortalHasRequiredKnowledge(portal);
        const payload = mergeCustomerDashboardPayload({
          existing: existing.payload,
          submitted: input.payload,
          contentAssetsVisible,
        });
        await assertDashboardUpdateCapability({
          userId: enterpriseWorkspaceUserId(ctx.user.id),
          existing,
          next: payload,
          portal,
        });
        assertDashboardEnterpriseIdentity(existing, payload);
        const updated = await updateDashboardWorkspace({
          userId: enterpriseWorkspaceUserId(ctx.user.id),
          actorUserId: ctx.user.id,
          payload,
          sourceName: input.sourceName || existing.sourceName || "用户编辑",
          reason: input.reason,
          expectedRevision: input.expectedRevision,
          bindEnterpriseIdentity: true,
        });
        const configured = updated.revision > 0;
        return {
          ...updated,
          configured,
          enterpriseName: updated.payload.brandName,
          payload: projectUserDashboardPayload({
            payload: updated.payload,
            configured,
            contentAssetsAllowed: contentAssetsVisible,
          })!,
        };
      } catch (error) {
        toServiceError(error);
      }
    }),

  questionPortfolio: protectedProcedure.query(async ({ ctx }) => {
    try {
      const portal = await getServicePortal(enterpriseWorkspaceUserId(ctx.user.id));
      const quotaPeriodId = portal.quotas?.periodId;
      return {
        questions: portal.mode === "operator" || quotaPeriodId
          ? (
              await listWorkspaceQuestions({
                userId: enterpriseWorkspaceUserId(ctx.user.id),
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
          userId: enterpriseWorkspaceUserId(ctx.user.id),
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
        await assertServiceCapability(enterpriseWorkspaceUserId(ctx.user.id), "questionSelection");
        const question = await requestWorkspaceQuestionSelection({
          userId: enterpriseWorkspaceUserId(ctx.user.id),
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
            question: z.string().trim().min(2).max(4_000),
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
            mode: z.literal("brand_keyword_library"),
            dashboardRevision: z.number().int().positive(),
            tableId: z.string().trim().min(1).max(80),
            rowIndex: z.number().int().nonnegative().max(9_999),
          })
          .strict(),
      ]),
    )
    .mutation(async ({ ctx, input }) => {
      if (ctx.user.role !== "user")
        throw new TRPCError({
          code: "FORBIDDEN",
          message: "只有客户可以选择自己的目标问题",
        });
      try {
        await assertServiceCapability(enterpriseWorkspaceUserId(ctx.user.id), "questionSelection");
        let question;
        if (input.mode === "brand_keyword_library") {
          const dashboard = await getDashboardWorkspace(enterpriseWorkspaceUserId(ctx.user.id));
          const reference = {
            dashboardRevision: input.dashboardRevision,
            tableId: input.tableId,
            rowIndex: input.rowIndex,
          };
          const resolved = resolveBrandKeywordSelection({
            workspace: dashboard,
            reference,
          });
          if (!resolved.ok)
            throw new ServiceEntitlementError(
              "QUESTION_NOT_CURRENT",
              resolved.message,
            );
          question = await confirmWorkspaceBrandKeywordSelection({
            userId: enterpriseWorkspaceUserId(ctx.user.id),
            actorUserId: ctx.user.id,
            ...reference,
            expectedQuestion: resolved.selection.question,
            expectedCategory: resolved.selection.category,
          });
        } else {
          question = await requestWorkspaceQuestionSelection({
            userId: enterpriseWorkspaceUserId(ctx.user.id),
            actorUserId: ctx.user.id,
            ...(input.mode === "candidate"
              ? {
                  questionId: input.questionId,
                  expectedRevision: input.expectedRevision,
                }
              : { question: input.question, category: input.category }),
          });
        }
        return { question: toPublicServicePortalQuestion(question) };
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
          userId: enterpriseWorkspaceUserId(ctx.user.id),
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
        getDashboardWorkspace(enterpriseWorkspaceUserId(ctx.user.id)),
        getServicePortal(enterpriseWorkspaceUserId(ctx.user.id)),
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
      return { snapshot: await getLatestKnowledgeSnapshot(enterpriseWorkspaceUserId(ctx.user.id)) };
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
              userId: enterpriseWorkspaceUserId(ctx.user.id),
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
      return { records: await listResponseLogicEntries(enterpriseWorkspaceUserId(ctx.user.id)) };
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
          userId: enterpriseWorkspaceUserId(ctx.user.id),
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
        await assertServiceCapability(enterpriseWorkspaceUserId(ctx.user.id), "responseLogic");
        const question = await getDashboardQuestion(
          enterpriseWorkspaceUserId(ctx.user.id),
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
            userId: enterpriseWorkspaceUserId(ctx.user.id),
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
            enterpriseWorkspaceUserId(ctx.user.id),
            await resolveMonitoringReadQuotaPeriodIds(enterpriseWorkspaceUserId(ctx.user.id)),
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
            userId: enterpriseWorkspaceUserId(ctx.user.id),
            filters: input,
            quotaPeriodIds: await resolveMonitoringReadQuotaPeriodIds(
              enterpriseWorkspaceUserId(ctx.user.id),
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
            userId: enterpriseWorkspaceUserId(ctx.user.id),
            filters: input,
            quotaPeriodIds: await resolveMonitoringReadQuotaPeriodIds(
              enterpriseWorkspaceUserId(ctx.user.id),
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
            userId: enterpriseWorkspaceUserId(ctx.user.id),
            value: input,
            quotaPeriodIds: await resolveMonitoringReadQuotaPeriodIds(
              enterpriseWorkspaceUserId(ctx.user.id),
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
            userId: enterpriseWorkspaceUserId(ctx.user.id),
            value: input,
            quotaPeriodIds: await resolveMonitoringReadQuotaPeriodIds(
              enterpriseWorkspaceUserId(ctx.user.id),
            ),
          });
        } catch (error) {
          throw toTrpcError(error);
        }
      }),
  }),
});
