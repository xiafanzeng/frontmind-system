import { assertCustomerProjectBusinessWrite } from "./customer-project-write-access";
import { aiUsageReportInput, aiUsageTaskEventsInput } from "../shared/ai-usage-report";
import { readAiUsageReport, exportAiUsageReport, readAiUsageTaskEvents } from "./ai-usage-report";
import { getMonitoringRuntime } from "./monitoring-module";
import { ensureDashboardAccountLink } from "@frontmind/monitoring-db";
import { assertWorkspaceAccess } from "./dashboard-service";
import { assertDashboardUpdateCapability } from "./dashboard-editing";
import { z } from "zod";
import { adminProcedure, router } from "./_core/trpc";
import {
  createManagedUser,
  deleteManagedUser,
  listManagedUsers,
  resetManagedUserPassword,
  setManagedUserActive,
} from "./auth-service";
import { passwordSchema, toTrpcError } from "./auth-router";
import {
  deletePresalesApiCredential,
  getPresalesCredentialStatus,
  getPresalesCreditUsageSnapshot,
  replacePresalesApiCredential,
  testPresalesApiCredential,
} from "./presales-service";
import {
  deleteTwentyFirstApiCredential,
  getTwentyFirstCredentialStatus,
  replaceTwentyFirstApiCredential,
  testTwentyFirstApiCredential,
} from "./twenty-first-service";
import {
  aliyunOAuthCredentialInputSchema,
  deleteAliyunPlatformCredentials,
  getAliyunPlatformCredentialStatus,
  replaceAliyunOAuthCredential,
  testAliyunPlatformCredentials,
} from "./siteops/aliyun-platform-service";
import {
  assertDashboardEnterpriseIdentity,
  getDashboardContentRevision,
  getDashboardWorkspace,
  getLatestKnowledgeSnapshot,
  getManagedCredentialStatus,
  getManagedUserCreditUsage,
  listDashboardContentRevisions,
  listManagedWorkspaceUsers,
  isSystemAdmin,
  rollbackDashboardContentRevision,
  setWorkspaceAssignments,
  updateDashboardWorkspace,
} from "./dashboard-service";
import { getKnowledgeBaseProgress } from "./knowledge-base-progress-service";
import { toKnowledgeBasePublicPayload } from "./knowledge-base-public-projection";
import {
  listMonitoringCitationsSchema,
  listMonitoringSampleCitationsSchema,
  listMonitoringSamplesSchema,
  monitoringCitationSummarySchema,
  monitoringFilterOptionsSchema,
  replaceMonitoringBatchSchema,
} from "../shared/monitoring";
import {
  getMonitoringCitationSummary,
  getMonitoringFilterOptions,
  listMonitoringCitations,
  listMonitoringSampleCitations,
  listMonitoringSamples,
  replaceMonitoringBatch,
  resolveMonitoringReadQuotaPeriodIds,
} from "./monitoring-service";
import { dashboardPayloadSchema } from "../shared/dashboard";
import {
  approveWorkspaceQuestionSelection,
  assertServiceCapability,
  getServiceEntitlementRolloutState,
  getServicePortal,
  listWorkspaceQuestions,
  ServiceEntitlementError,
  updateWorkspaceQuestionBySystemAdmin,
  upsertServiceContract,
} from "./service-entitlement";
import {
  decideWebsitePurchase,
  listPendingWebsitePurchases,
  PurchaseProvisioningError,
} from "./provisioning-v2-service";
import {
  createManualServiceOrderService,
  ManualServiceOrderError,
} from "./manual-service-order-service";
import {
  activateManualServiceOrderSchema,
  confirmManualServiceOrderSignedSchema,
  prepareManualServiceOrderSchema,
  rejectManualServiceOrderSchema,
} from "../shared/manual-service-order";
import { TRPCError } from "@trpc/server";
import {
  getAdminControlPlaneOverview,
  listWorkspaceAuditEvents,
  writeWorkspaceAuditEvent,
} from "./admin-control-plane-service";
import { listResponseLogicEntries } from "./response-logic-service";
import {
  getManagedKnowledgeActivity,
  getManagedTaskActivity,
} from "./admin-delivery-service";
import { setManagedAdminAccessLevel } from "./admin-access-management-service";
import {
  bulkReplaceManagedApiKeyTargets,
  getAdminApiUsageHierarchy,
  getApiUsageAlertOverview,
  replaceManagedApiKeyTarget,
  revokeManagedApiKeyTarget,
  syncApiUsageSnapshots,
  updateApiUsagePolicy,
} from "./api-usage-snapshot-service";
import {
  provisionableServicePlanCodeSchema,
  servicePlanCodeSchema,
  toPublicServicePortal,
  toPublicServicePortalQuestion,
  workspaceQuestionCategorySchema,
  type ServicePortal,
  type ServicePortalQuestion,
} from "../shared/service-portal";
import { accountMarketEditionSchema } from "../shared/account-edition";
import { deliveryRoleTypeSchema } from "../shared/delivery-roles";
import { createDeliveryEngineer } from "./delivery-role-service";
import {
  completeManagedServiceUserProvisioning,
  createManagedServiceUser,
  createManagedOperatorUser,
} from "./managed-user-onboarding-service";
import {
  bulkAssignJenovaBrandTrackingCredential,
  configureJenovaBrandTrackingCredential,
  JenovaBrandTrackingError,
  listJenovaBrandTrackingCredentialAssignments,
  revokeJenovaBrandTrackingCredentialAssignment,
  syncJenovaBrandTrackingCredentialBalance,
  toJenovaBrandTrackingAuthError,
} from "./jenova-brand-tracking-service";

const manualServiceOrders = createManualServiceOrderService();

function requireSystemAdmin(user: Parameters<typeof isSystemAdmin>[0]) {
  if (!isSystemAdmin(user)) {
    throw new TRPCError({
      code: "FORBIDDEN",
      message: "只有系统管理员可以执行此操作",
    });
  }
}

export function adminWorkspaceServiceValue(
  actor: Parameters<typeof isSystemAdmin>[0],
  portal: ServicePortal,
) {
  return isSystemAdmin(actor) ? portal : toPublicServicePortal(portal);
}

export function adminWorkspaceQuestionValue(
  actor: Parameters<typeof isSystemAdmin>[0],
  question: ServicePortalQuestion,
) {
  return isSystemAdmin(actor)
    ? question
    : toPublicServicePortalQuestion(question);
}

function throwServiceAdminError(error: unknown): never {
  if (
    error instanceof ServiceEntitlementError ||
    error instanceof PurchaseProvisioningError ||
    error instanceof ManualServiceOrderError
  ) {
    const status =
      error instanceof ServiceEntitlementError
        ? error.statusCode
        : error.status;
    throw new TRPCError({
      code:
        status === 404
          ? "NOT_FOUND"
          : status === 403
            ? "FORBIDDEN"
            : status === 400
              ? "BAD_REQUEST"
              : status === 503
                ? "INTERNAL_SERVER_ERROR"
                : "CONFLICT",
      message: error.message,
      cause: error,
    });
  }
  throw toTrpcError(error);
}

function throwJenovaBrandTrackingAdminError(error: unknown): never {
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
}

const usernameSchema = z
  .string()
  .trim()
  .min(3, "用户名至少需要 3 个字符")
  .max(64, "用户名不能超过 64 个字符")
  .regex(/^[a-zA-Z0-9._-]+$/, "用户名只能包含字母、数字、点、下划线和连字符");

const presalesApiKeySchema = z
  .string()
  .trim()
  .min(8, "API Key 至少需要 8 个字符")
  .max(4096, "API Key 不能超过 4096 个字符");

const twentyFirstApiKeySchema = z
  .string()
  .trim()
  .min(8, "21st API Key 至少需要 8 个字符")
  .max(4096, "21st API Key 不能超过 4096 个字符")
  .refine(
    (value) => !/[\u0000-\u001f\u007f]/u.test(value),
    "21st API Key 包含无效控制字符",
  );

const managedApiKeyReplaceShape = {
  userId: z.number().int().positive(),
  apiKey: presalesApiKeySchema,
  upstreamEffort: z.enum(["high", "max"]).optional(),
  expectedVersion: z.number().int().nonnegative(),
  reason: z.string().trim().min(1).max(2_000),
  confirmation: z.literal("REPLACE_API_KEY"),
} as const;

export const adminUpdateServiceSchema = z
  .object({
    userId: z.number().int().positive(),
    expectedRevision: z.number().int().nonnegative(),
    planCode: servicePlanCodeSchema,
    startsAt: z.number().int().optional(),
    status: z
      .enum([
        "pending_confirmation",
        "scheduled",
        "active",
        "suspended",
        "cancelled",
      ])
      .default("active"),
    sourceReference: z.string().trim().max(191).optional(),
    prepaidMonths: z.number().int().positive().max(120).nullable().optional(),
    orderReference: z.string().trim().max(128).optional(),
    contractReference: z.string().trim().max(128).optional(),
    signedAt: z.number().int().optional(),
    signatoryId: z.string().trim().max(128).optional(),
    signingEvidence: z.record(z.string(), z.unknown()).optional(),
    sourceContractIds: z
      .array(z.string().trim().min(1).max(36))
      .max(100)
      .optional(),
    carryQuestionIds: z
      .array(z.string().trim().min(1).max(36))
      .max(100)
      .optional(),
    reason: z.string().trim().max(2_000).optional(),
  })
  .strict();

export function managedMonitoringCitationSummaryValue(input: {
  batchKey?: string;
  questionId: string;
  model?: string;
  from?: string;
  to?: string;
}) {
  return {
    batchKey: input.batchKey,
    questionId: input.questionId,
    model: input.model,
    from: input.from,
    to: input.to,
  };
}

export const adminRouter = router({
  aiUsage: router({
    taskEvents: adminProcedure.input(aiUsageTaskEventsInput).query(async ({ ctx, input }) => {
      requireSystemAdmin(ctx.user);
      return readAiUsageTaskEvents(input);
    }),
    report: adminProcedure.input(aiUsageReportInput).query(async ({ ctx, input }) => {
      requireSystemAdmin(ctx.user);
      return readAiUsageReport(input);
    }),
    export: adminProcedure.input(aiUsageReportInput).query(async ({ ctx, input }) => {
      requireSystemAdmin(ctx.user);
      return exportAiUsageReport(input);
    }),
  }),
  brandTrackingCredentials: router({
    list: adminProcedure.query(async ({ ctx }) => {
      requireSystemAdmin(ctx.user);
      try {
        return await listJenovaBrandTrackingCredentialAssignments({
          actor: ctx.user,
        });
      } catch (error) {
        throwJenovaBrandTrackingAdminError(error);
      }
    }),
    configure: adminProcedure
      .input(
        z
          .object({
            userId: z.number().int().positive(),
            apiKey: presalesApiKeySchema,
          })
          .strict(),
      )
      .mutation(async ({ ctx, input }) => {
        requireSystemAdmin(ctx.user);
        try {
          return await configureJenovaBrandTrackingCredential({
            actor: ctx.user,
            ...input,
          });
        } catch (error) {
          throwJenovaBrandTrackingAdminError(error);
        }
      }),
    bulkAssign: adminProcedure
      .input(
        z
          .object({
            userIds: z
              .array(z.number().int().positive())
              .min(1)
              .max(5_000)
              .refine(
                (userIds) => new Set(userIds).size === userIds.length,
                "海外客户账号不能重复",
              ),
            apiKey: presalesApiKeySchema,
          })
          .strict(),
      )
      .mutation(async ({ ctx, input }) => {
        requireSystemAdmin(ctx.user);
        try {
          return await bulkAssignJenovaBrandTrackingCredential({
            actor: ctx.user,
            ...input,
          });
        } catch (error) {
          throwJenovaBrandTrackingAdminError(error);
        }
      }),
    revoke: adminProcedure
      .input(z.object({ userId: z.number().int().positive() }).strict())
      .mutation(async ({ ctx, input }) => {
        requireSystemAdmin(ctx.user);
        try {
          return await revokeJenovaBrandTrackingCredentialAssignment({
            actor: ctx.user,
            userId: input.userId,
          });
        } catch (error) {
          throwJenovaBrandTrackingAdminError(error);
        }
      }),
    refreshBalance: adminProcedure
      .input(z.object({ credentialId: z.string().uuid() }).strict())
      .mutation(async ({ ctx, input }) => {
        requireSystemAdmin(ctx.user);
        try {
          return await syncJenovaBrandTrackingCredentialBalance({
            actor: ctx.user,
            credentialId: input.credentialId,
          });
        } catch (error) {
          throwJenovaBrandTrackingAdminError(error);
        }
      }),
  }),
  apiKeyUsageAlerts: router({
    hierarchy: adminProcedure.query(async ({ ctx }) => {
      requireSystemAdmin(ctx.user);
      try {
        return await getAdminApiUsageHierarchy(ctx.user);
      } catch (error) {
        throw toTrpcError(error);
      }
    }),
    overview: adminProcedure.query(async ({ ctx }) => {
      requireSystemAdmin(ctx.user);
      try {
        return await getApiUsageAlertOverview(ctx.user);
      } catch (error) {
        throw toTrpcError(error);
      }
    }),
    sync: adminProcedure.mutation(async ({ ctx }) => {
      requireSystemAdmin(ctx.user);
      try {
        return await syncApiUsageSnapshots(ctx.user);
      } catch (error) {
        throw toTrpcError(error);
      }
    }),
    bulkReplaceTargetCredentials: adminProcedure
      .input(
        z
          .object({
            scope: z.discriminatedUnion("kind", [
              z.object({ kind: z.literal("all") }).strict(),
              z
                .object({
                  kind: z.literal("delivery_admin"),
                  deliveryAdminId: z.number().int().positive(),
                })
                .strict(),
              z
                .object({
                  kind: z.literal("engineers"),
                  engineerIds: z
                    .array(z.number().int().positive())
                    .min(1)
                    .max(5_000),
                })
                .strict(),
            ]),
            targets: z
              .array(
                z
                  .object({
                    userId: z.number().int().positive(),
                    expectedVersion: z.number().int().nonnegative(),
                  })
                  .strict(),
              )
              .min(1)
              .max(5_000),
            applyMode: z
              .enum(["unconfigured_only", "replace_all"])
              .default("unconfigured_only"),
            apiKey: presalesApiKeySchema,
            upstreamEffort: z.enum(["high", "max"]).optional(),
            reason: z.string().trim().min(1).max(2_000),
            confirmation: z.literal("BULK_REPLACE_API_KEYS"),
          })
          .strict(),
      )
      .mutation(async ({ ctx, input }) => {
        requireSystemAdmin(ctx.user);
        try {
          return await bulkReplaceManagedApiKeyTargets({
            actor: ctx.user,
            scope: input.scope,
            targets: input.targets,
            applyMode: input.applyMode,
            apiKey: input.apiKey,
            upstreamEffort: input.upstreamEffort,
            reason: input.reason,
          });
        } catch (error) {
          throw toTrpcError(error);
        }
      }),
    replaceTargetCredential: adminProcedure
      .input(
        z.discriminatedUnion("kind", [
          z
            .object({
              ...managedApiKeyReplaceShape,
              kind: z.literal("customer"),
            })
            .strict(),
          z
            .object({
              ...managedApiKeyReplaceShape,
              kind: z.literal("delivery_admin"),
            })
            .strict(),
          z
            .object({
              ...managedApiKeyReplaceShape,
              kind: z.literal("engineer"),
            })
            .strict(),
        ]),
      )
      .mutation(async ({ ctx, input }) => {
        requireSystemAdmin(ctx.user);
        try {
          return await replaceManagedApiKeyTarget({
            actor: ctx.user,
            kind: input.kind,
            userId: input.userId,
            apiKey: input.apiKey,
            upstreamEffort: input.upstreamEffort,
            expectedVersion: input.expectedVersion,
            reason: input.reason,
          });
        } catch (error) {
          throw toTrpcError(error);
        }
      }),
    revokeTargetCredential: adminProcedure
      .input(
        z
          .object({
            kind: z.enum(["customer", "delivery_admin", "engineer"]),
            userId: z.number().int().positive(),
            expectedVersion: z.number().int().nonnegative(),
            reason: z.string().trim().min(1).max(2_000),
            confirmation: z.literal("REVOKE_API_KEY"),
          })
          .strict(),
      )
      .mutation(async ({ ctx, input }) => {
        requireSystemAdmin(ctx.user);
        try {
          return await revokeManagedApiKeyTarget({
            actor: ctx.user,
            kind: input.kind,
            userId: input.userId,
            expectedVersion: input.expectedVersion,
            reason: input.reason,
          });
        } catch (error) {
          throw toTrpcError(error);
        }
      }),
    updatePolicy: adminProcedure
      .input(
        z.object({
          policyId: z.string().uuid(),
          limit: z.number().int().positive().max(2_000_000_000),
          warningRatio: z.number().min(0.01).max(1),
          windowDays: z.literal(30),
        }),
      )
      .mutation(async ({ ctx, input }) => {
        requireSystemAdmin(ctx.user);
        try {
          return await updateApiUsagePolicy({
            actor: ctx.user,
            ...input,
          });
        } catch (error) {
          throw toTrpcError(error);
        }
      }),
  }),
  controlPlane: router({
    overview: adminProcedure.query(async ({ ctx }) => {
      try {
        return await getAdminControlPlaneOverview(ctx.user);
      } catch (error) {
        throw toTrpcError(error);
      }
    }),

    audit: adminProcedure
      .input(
        z
          .object({
            workspaceUserId: z.number().int().positive().optional(),
            limit: z.number().int().min(1).max(100).optional(),
            cursor: z
              .object({
                createdAt: z.number().int().nonnegative(),
                id: z.string().uuid(),
              })
              .optional(),
          })
          .optional(),
      )
      .query(async ({ ctx, input }) => {
        try {
          return await listWorkspaceAuditEvents({
            actor: ctx.user,
            workspaceUserId: input?.workspaceUserId,
            limit: input?.limit,
            cursor: input?.cursor,
          });
        } catch (error) {
          throw toTrpcError(error);
        }
      }),
  }),

  workspace: router({
    accountBalance: adminProcedure.input(z.object({userId:z.number().int().positive()})).query(async({ctx,input})=>{
      try {
        await assertWorkspaceAccess(ctx.user,input.userId);
        const runtime=getMonitoringRuntime();
        const link=await ensureDashboardAccountLink(runtime.repository.db,input.userId);
        return runtime.repository.getBillingSummary(link.monitoringUserId);
      } catch(error) { throw toTrpcError(error); }
    }),
    list: adminProcedure.query(async ({ ctx }) => {
      try {
        return await listManagedWorkspaceUsers(ctx.user);
      } catch (error) {
        throw toTrpcError(error);
      }
    }),

    content: router({
      history: adminProcedure
        .input(
          z.object({
            userId: z.number().int().positive(),
            limit: z.number().int().min(1).max(100).optional(),
            beforeRevision: z.number().int().positive().optional(),
          }),
        )
        .query(async ({ ctx, input }) => {
          try {
            return await listDashboardContentRevisions({
              actor: ctx.user,
              ...input,
            });
          } catch (error) {
            throw toTrpcError(error);
          }
        }),

      version: adminProcedure
        .input(
          z.object({
            userId: z.number().int().positive(),
            revision: z.number().int().positive(),
          }),
        )
        .query(async ({ ctx, input }) => {
          try {
            return await getDashboardContentRevision({
              actor: ctx.user,
              ...input,
            });
          } catch (error) {
            throw toTrpcError(error);
          }
        }),

      rollback: adminProcedure
        .input(
          z.object({
            userId: z.number().int().positive(),
            targetRevision: z.number().int().positive(),
            expectedRevision: z.number().int().positive(),
            reason: z.string().trim().max(2_000).optional(),
          }),
        )
        .mutation(async ({ ctx, input }) => {
          await assertCustomerProjectBusinessWrite(ctx.user, input.userId);
          try {
            await getManagedCredentialStatus(ctx.user, input.userId);
            await assertServiceCapability(input.userId, "contentAssets");
            const result = await rollbackDashboardContentRevision({
              actor: ctx.user,
              ...input,
            });
            return result;
          } catch (error) {
            throw toTrpcError(error);
          }
        }),
    }),

    assignments: adminProcedure
      .input(
        z.object({
          userId: z.number().int().positive(),
          adminIds: z.array(z.number().int().positive()).max(100),
          usageOwnerAdminId: z.number().int().positive().nullable().optional(),
          reason: z.string().trim().max(2_000).optional(),
        }),
      )
      .mutation(async ({ ctx, input }) => {
        requireSystemAdmin(ctx.user);
        try {
          return await setWorkspaceAssignments({
            actor: ctx.user,
            userId: input.userId,
            adminIds: input.adminIds,
            usageOwnerAdminId: input.usageOwnerAdminId,
            reason: input.reason,
          });
        } catch (error) {
          throw toTrpcError(error);
        }
      }),

    dashboard: adminProcedure
      .input(z.object({ userId: z.number().int().positive() }))
      .query(async ({ ctx, input }) => {
        try {
          await getManagedCredentialStatus(ctx.user, input.userId);
          return await getDashboardWorkspace(input.userId);
        } catch (error) {
          throw toTrpcError(error);
        }
      }),

    service: adminProcedure
      .input(z.object({ userId: z.number().int().positive() }))
      .query(async ({ ctx, input }) => {
        try {
          await getManagedCredentialStatus(ctx.user, input.userId);
          return adminWorkspaceServiceValue(
            ctx.user,
            await getServicePortal(input.userId),
          );
        } catch (error) {
          throwServiceAdminError(error);
        }
      }),

    questionPortfolio: adminProcedure
      .input(z.object({ userId: z.number().int().positive() }))
      .query(async ({ ctx, input }) => {
        try {
          await getManagedCredentialStatus(ctx.user, input.userId);
          return {
            questions: (
              await listWorkspaceQuestions({
                userId: input.userId,
              })
            ).map((question) =>
              adminWorkspaceQuestionValue(ctx.user, question),
            ),
          };
        } catch (error) {
          throwServiceAdminError(error);
        }
      }),

    updateQuestion: adminProcedure
      .input(
        z
          .object({
            userId: z.number().int().positive(),
            questionId: z.string().trim().min(1).max(64),
            expectedRevision: z.number().int().positive(),
            question: z.string().trim().min(1).max(4_000).optional(),
            intent: z.string().trim().max(16_000).nullable().optional(),
            rationale: z.string().trim().max(16_000).nullable().optional(),
            locked: z.boolean().optional(),
            reason: z.string().trim().max(2_000).optional(),
          })
          .refine(
            (value) =>
              value.question !== undefined ||
              value.intent !== undefined ||
              value.rationale !== undefined ||
              value.locked !== undefined,
            "没有可更新的候选问题字段",
          ),
      )
      .mutation(async ({ ctx, input }) => {
        await assertCustomerProjectBusinessWrite(ctx.user, input.userId);
        try {
          await getManagedCredentialStatus(ctx.user, input.userId);
          await assertServiceCapability(input.userId, "questionSelection");
          const question = await updateWorkspaceQuestionBySystemAdmin({
            ...input,
            actorUserId: ctx.user.id,
          });
          await writeWorkspaceAuditEvent({
            actor: ctx.user,
            action: "workspace.question.updated",
            targetType: "workspace_question",
            targetId: input.questionId,
            workspaceUserId: input.userId,
            reason: input.reason,
            metadata: {
              expectedRevision: input.expectedRevision,
              revision: question.revision,
              changedFields: [
                input.question !== undefined ? "question" : null,
                input.intent !== undefined ? "intent" : null,
                input.rationale !== undefined ? "rationale" : null,
                input.locked !== undefined ? "locked" : null,
              ].filter(Boolean),
            },
          });
          return {
            question: adminWorkspaceQuestionValue(ctx.user, question),
          };
        } catch (error) {
          throwServiceAdminError(error);
        }
      }),

    confirmQuestionSelection: adminProcedure
      .input(
        z.object({
          userId: z.number().int().positive(),
          questionId: z.string().trim().min(1).max(64),
          expectedRevision: z.number().int().positive(),
          category: workspaceQuestionCategorySchema.optional(),
          reason: z.string().trim().max(2_000).optional(),
        }),
      )
      .mutation(async ({ ctx, input }) => {
        await assertCustomerProjectBusinessWrite(ctx.user, input.userId);
        try {
          await getManagedCredentialStatus(ctx.user, input.userId);
          await assertServiceCapability(input.userId, "questionSelection");
          const question = await approveWorkspaceQuestionSelection({
            ...input,
            actorUserId: ctx.user.id,
          });
          await writeWorkspaceAuditEvent({
            actor: ctx.user,
            action: "workspace.question.selection_confirmed",
            targetType: "workspace_question",
            targetId: input.questionId,
            workspaceUserId: input.userId,
            reason: input.reason,
            metadata: {
              expectedRevision: input.expectedRevision,
              revision: question.revision,
            },
          });
          return {
            question: adminWorkspaceQuestionValue(ctx.user, question),
          };
        } catch (error) {
          throwServiceAdminError(error);
        }
      }),

    updateService: adminProcedure
      .input(adminUpdateServiceSchema)
      .mutation(async ({ ctx, input }) => {
        requireSystemAdmin(ctx.user);
        const commerciallyActive =
          input.status === "active" || input.status === "scheduled";
        if (
          (input.planCode === "basic" && input.prepaidMonths != null) ||
          (input.planCode !== "basic" && input.prepaidMonths !== 3)
        ) {
          throw new TRPCError({
            code: "BAD_REQUEST",
            message:
              input.planCode === "basic"
                ? "普通版为连续 30 天单题服务，不设置预付月份"
                : input.planCode === "advanced"
                  ? "进阶版按 3 个月服务周期建立"
                  : "豪华版为 12 个月权益周期，预付月份按 3 个月记录，并按季度自动解锁额度",
          });
        }
        if (
          commerciallyActive &&
          (!input.signatoryId?.trim() || !input.signedAt)
        ) {
          throw new TRPCError({
            code: "BAD_REQUEST",
            message: "生效或待生效合同必须包含签署主体与签署时间",
          });
        }
        try {
          const service = await upsertServiceContract({
            userId: input.userId,
            planCode: input.planCode,
            expectedRevision: input.expectedRevision,
            startsAt:
              input.startsAt === undefined
                ? undefined
                : new Date(input.startsAt),
            status: input.status,
            source: "admin",
            sourceReference: input.sourceReference,
            prepaidMonths: input.prepaidMonths,
            orderReference: input.orderReference,
            externalContractReference: input.contractReference,
            signedAt:
              input.signedAt === undefined
                ? undefined
                : new Date(input.signedAt),
            signatoryId: input.signatoryId,
            signingEvidence: input.signingEvidence,
            sourceContractIds: input.sourceContractIds,
            carryQuestionIds: input.carryQuestionIds,
            updatedByUserId: ctx.user.id,
            preserveConcurrentBasic: false,
          });
          await writeWorkspaceAuditEvent({
            actor: ctx.user,
            action: "workspace.service.updated",
            targetType: "service_contract",
            targetId: service.service.contractId ?? input.userId,
            workspaceUserId: input.userId,
            reason: input.reason,
            metadata: {
              expectedRevision: input.expectedRevision,
              revision: service.revision,
              planCode: input.planCode,
              status: input.status,
              source: "admin",
            },
          });
          return service;
        } catch (error) {
          throwServiceAdminError(error);
        }
      }),

    bulkConfigureServices: adminProcedure
      .input(
        z.object({
          assignments: z
            .array(
              z.object({
                userId: z.number().int().positive(),
                expectedRevision: z.number().int().nonnegative(),
                planCode: servicePlanCodeSchema,
                startsAt: z.number().int().optional(),
                reason: z.string().trim().max(2_000).optional(),
              }),
            )
            .min(1)
            .max(200),
        }),
      )
      .mutation(async ({ ctx, input }) => {
        requireSystemAdmin(ctx.user);
        if (
          new Set(input.assignments.map((assignment) => assignment.userId))
            .size !== input.assignments.length
        ) {
          throw new TRPCError({
            code: "BAD_REQUEST",
            message: "同一批次不能重复配置同一用户",
          });
        }
        const results = [];
        for (const assignment of input.assignments) {
          try {
            const portal = await upsertServiceContract({
              userId: assignment.userId,
              planCode: assignment.planCode,
              expectedRevision: assignment.expectedRevision,
              startsAt:
                assignment.startsAt === undefined
                  ? undefined
                  : new Date(assignment.startsAt),
              status: "pending_confirmation",
              source: "admin",
              sourceReference: `rollout:${assignment.userId}:${assignment.expectedRevision}:${assignment.planCode}`,
              updatedByUserId: ctx.user.id,
              preserveConcurrentBasic: false,
            });
            await writeWorkspaceAuditEvent({
              actor: ctx.user,
              action: "workspace.service.updated",
              targetType: "service_contract",
              targetId: portal.service.contractId ?? assignment.userId,
              workspaceUserId: assignment.userId,
              reason: assignment.reason,
              metadata: {
                expectedRevision: assignment.expectedRevision,
                revision: portal.revision,
                planCode: assignment.planCode,
                status: "pending_confirmation",
                source: "admin_bulk",
              },
            });
            results.push({
              userId: assignment.userId,
              status: "configured" as const,
              planCode: assignment.planCode,
              revision: portal.revision,
            });
          } catch (error) {
            results.push({
              userId: assignment.userId,
              status: "failed" as const,
              planCode: assignment.planCode,
              revision: assignment.expectedRevision,
              code:
                error instanceof ServiceEntitlementError
                  ? error.code
                  : "BULK_CONFIGURATION_FAILED",
              message: error instanceof Error ? error.message : "批量配置失败",
            });
          }
        }
        return {
          results,
          rollout: await getServiceEntitlementRolloutState(),
        };
      }),

    updateDashboard: adminProcedure
      .input(
        z.object({
          userId: z.number().int().positive(),
          expectedRevision: z.number().int().nonnegative(),
          payload: dashboardPayloadSchema,
          reason: z.string().trim().max(2_000).optional(),
        }),
      )
      .mutation(async ({ ctx, input }) => {
        await assertCustomerProjectBusinessWrite(ctx.user, input.userId);
        try {
          await getManagedCredentialStatus(ctx.user, input.userId);
          const existing = await getDashboardWorkspace(input.userId);
          await assertDashboardUpdateCapability({
            userId: input.userId,
            existing,
            next: input.payload,
          });
          assertDashboardEnterpriseIdentity(existing, input.payload);
          const dashboard = await updateDashboardWorkspace({
            businessSubmission: true,
            userId: input.userId,
            actorUserId: ctx.user.id,
            payload: {
              ...input.payload,
              contentAssets: existing.payload.contentAssets,
              monitoringAnswers: existing.payload.monitoringAnswers,
              citations: existing.payload.citations,
            },
            sourceName: existing.sourceName || "管理员结构化编辑",
            reason: input.reason,
            bindEnterpriseIdentity: true,
            expectedRevision: input.expectedRevision,
            afterWrite: async (tx, writeContext) => {
              await writeWorkspaceAuditEvent(
                {
                  actor: ctx.user,
                  action: "workspace.dashboard.updated",
                  targetType: "dashboard",
                  targetId: input.userId,
                  workspaceUserId: input.userId,
                  reason: input.reason,
                  metadata: {
                    expectedRevision: input.expectedRevision,
                    revision: writeContext.nextRevision,
                    sourceName: writeContext.sourceName,
                  },
                },
                tx,
              );
            },
          });
          return dashboard;
        } catch (error) {
          throwServiceAdminError(error);
        }
      }),

    knowledge: adminProcedure
      .input(z.object({ userId: z.number().int().positive() }))
      .query(async ({ ctx, input }) => {
        try {
          await getManagedCredentialStatus(ctx.user, input.userId);
          return {
            snapshot: await getLatestKnowledgeSnapshot(input.userId),
          };
        } catch (error) {
          throw toTrpcError(error);
        }
      }),

    progress: adminProcedure
      .input(
        z.object({
          userId: z.number().int().positive(),
          conversationId: z.string().trim().min(1).max(191).optional(),
        }),
      )
      .query(async ({ ctx, input }) => {
        try {
          await getManagedCredentialStatus(ctx.user, input.userId);
          return {
            progress: toKnowledgeBasePublicPayload(
              await getKnowledgeBaseProgress({
                userId: input.userId,
                conversationId: input.conversationId,
              }),
            ),
          };
        } catch (error) {
          throw toTrpcError(error);
        }
      }),

    responseLogic: adminProcedure
      .input(z.object({ userId: z.number().int().positive() }))
      .query(async ({ ctx, input }) => {
        try {
          await getManagedCredentialStatus(ctx.user, input.userId);
          return {
            records: await listResponseLogicEntries(input.userId),
          };
        } catch (error) {
          throw toTrpcError(error);
        }
      }),

    knowledgeActivity: adminProcedure
      .input(z.object({ userId: z.number().int().positive() }))
      .query(async ({ ctx, input }) => {
        try {
          await getManagedCredentialStatus(ctx.user, input.userId);
          return toKnowledgeBasePublicPayload(
            await getManagedKnowledgeActivity(input.userId),
          );
        } catch (error) {
          throw toTrpcError(error);
        }
      }),

    taskActivity: adminProcedure
      .input(z.object({ userId: z.number().int().positive() }))
      .query(async ({ ctx, input }) => {
        try {
          await getManagedCredentialStatus(ctx.user, input.userId);
          return await getManagedTaskActivity(input.userId);
        } catch (error) {
          throw toTrpcError(error);
        }
      }),

    credentialStatus: adminProcedure
      .input(z.object({ userId: z.number().int().positive() }))
      .query(async ({ ctx, input }) => {
        requireSystemAdmin(ctx.user);
        try {
          return await getManagedCredentialStatus(ctx.user, input.userId);
        } catch (error) {
          throw toTrpcError(error);
        }
      }),

    completeProvisioning: adminProcedure
      .input(
        z.object({
          userId: z.number().int().positive(),
          expectedRevision: z.number().int().positive(),
          deliveryAdminId: z.number().int().positive(),
          apiKey: presalesApiKeySchema,
        }),
      )
      .mutation(async ({ ctx, input }) => {
        requireSystemAdmin(ctx.user);
        try {
          return await completeManagedServiceUserProvisioning({
            actor: ctx.user,
            ...input,
          });
        } catch (error) {
          throw toTrpcError(error);
        }
      }),

    creditUsage: adminProcedure
      .input(z.object({ userId: z.number().int().positive() }))
      .query(async ({ ctx, input }) => {
        requireSystemAdmin(ctx.user);
        try {
          return await getManagedUserCreditUsage(ctx.user, input.userId);
        } catch (error) {
          throw toTrpcError(error);
        }
      }),

    monitoring: router({
      filters: adminProcedure
        .input(
          monitoringFilterOptionsSchema.safeExtend({
            userId: z.number().int().positive(),
          }),
        )
        .query(async ({ ctx, input }) => {
          try {
            await getManagedCredentialStatus(ctx.user, input.userId);
            const { userId, ...filters } = input;
            return await getMonitoringFilterOptions(
              userId,
              await resolveMonitoringReadQuotaPeriodIds(userId),
              filters,
            );
          } catch (error) {
            throw toTrpcError(error);
          }
        }),

      samples: adminProcedure
        .input(
          listMonitoringSamplesSchema.safeExtend({
            userId: z.number().int().positive(),
          }),
        )
        .query(async ({ ctx, input }) => {
          try {
            await getManagedCredentialStatus(ctx.user, input.userId);
            const { userId, ...filters } = input;
            return await listMonitoringSamples({
              userId,
              filters,
              quotaPeriodIds: await resolveMonitoringReadQuotaPeriodIds(
                input.userId,
              ),
            });
          } catch (error) {
            throw toTrpcError(error);
          }
        }),

      citations: adminProcedure
        .input(
          listMonitoringCitationsSchema.safeExtend({
            userId: z.number().int().positive(),
          }),
        )
        .query(async ({ ctx, input }) => {
          try {
            await getManagedCredentialStatus(ctx.user, input.userId);
            const { userId, ...filters } = input;
            return await listMonitoringCitations({
              userId,
              filters,
              quotaPeriodIds: await resolveMonitoringReadQuotaPeriodIds(
                input.userId,
              ),
            });
          } catch (error) {
            throw toTrpcError(error);
          }
        }),

      sampleCitations: adminProcedure
        .input(
          listMonitoringSampleCitationsSchema.safeExtend({
            userId: z.number().int().positive(),
          }),
        )
        .query(async ({ ctx, input }) => {
          try {
            await getManagedCredentialStatus(ctx.user, input.userId);
            const { userId, ...value } = input;
            return await listMonitoringSampleCitations({
              userId,
              value,
              quotaPeriodIds: await resolveMonitoringReadQuotaPeriodIds(userId),
            });
          } catch (error) {
            throw toTrpcError(error);
          }
        }),

      citationSummary: adminProcedure
        .input(
          monitoringCitationSummarySchema.safeExtend({
            userId: z.number().int().positive(),
          }),
        )
        .query(async ({ ctx, input }) => {
          try {
            await getManagedCredentialStatus(ctx.user, input.userId);
            return await getMonitoringCitationSummary({
              userId: input.userId,
              value: managedMonitoringCitationSummaryValue(input),
              quotaPeriodIds: await resolveMonitoringReadQuotaPeriodIds(
                input.userId,
              ),
            });
          } catch (error) {
            throw toTrpcError(error);
          }
        }),

      replaceBatch: adminProcedure
        .input(replaceMonitoringBatchSchema)
        .mutation(async ({ ctx, input }) => {
          try {
            const batch = await replaceMonitoringBatch({
              actor: ctx.user,
              value: input,
              afterWrite: async (tx, result) => {
                if (!result || result.idempotent) return;
                await writeWorkspaceAuditEvent({
                  actor: ctx.user,
                  action: "workspace.monitoring_batch.replaced",
                  targetType: "monitoring_batch",
                  targetId: result.batchId,
                  workspaceUserId: input.userId,
                  metadata: { batchKey: result.batchKey, revision: result.revision, sampleCount: result.sampleCount, citationCount: result.citationCount },
                }, tx);
              },
            });
            return batch;
          } catch (error) {
            throw toTrpcError(error);
          }
        }),
    }),
  }),

  purchases: router({
    pending: adminProcedure.query(async ({ ctx }) => {
      requireSystemAdmin(ctx.user);
      try {
        return { purchases: await listPendingWebsitePurchases() };
      } catch (error) {
        throwServiceAdminError(error);
      }
    }),

    decide: adminProcedure
      .input(
        z.object({
          reference: z.string().trim().min(4).max(128),
          decision: z.enum(["confirm", "reject"]),
          signedAt: z.number().int().optional(),
          signatoryId: z.string().trim().min(1).max(128).optional(),
          note: z.string().trim().max(2000).optional(),
        }),
      )
      .mutation(async ({ ctx, input }) => {
        requireSystemAdmin(ctx.user);
        try {
          return await decideWebsitePurchase({
            reference: input.reference,
            actorUserId: ctx.user.id,
            decision: input.decision,
            signedAt:
              input.signedAt === undefined
                ? undefined
                : new Date(input.signedAt),
            signatoryId: input.signatoryId,
            note: input.note,
          });
        } catch (error) {
          throwServiceAdminError(error);
        }
      }),
  }),

  manualOrders: router({
    list: adminProcedure.query(async ({ ctx }) => {
      requireSystemAdmin(ctx.user);
      try {
        return { orders: await manualServiceOrders.list() };
      } catch (error) {
        throwServiceAdminError(error);
      }
    }),

    prepare: adminProcedure
      .input(prepareManualServiceOrderSchema)
      .mutation(async ({ ctx, input }) => {
        requireSystemAdmin(ctx.user);
        try {
          return await manualServiceOrders.prepare({
            ...input,
            actorUserId: ctx.user.id,
          });
        } catch (error) {
          throwServiceAdminError(error);
        }
      }),

    confirmSigned: adminProcedure
      .input(confirmManualServiceOrderSignedSchema)
      .mutation(async ({ ctx, input }) => {
        requireSystemAdmin(ctx.user);
        try {
          return await manualServiceOrders.confirmSigned({
            ...input,
            actorUserId: ctx.user.id,
          });
        } catch (error) {
          throwServiceAdminError(error);
        }
      }),

    activate: adminProcedure
      .input(activateManualServiceOrderSchema)
      .mutation(async ({ ctx, input }) => {
        requireSystemAdmin(ctx.user);
        try {
          return await manualServiceOrders.activate({
            ...input,
            actorUserId: ctx.user.id,
          });
        } catch (error) {
          throwServiceAdminError(error);
        }
      }),

    reject: adminProcedure
      .input(rejectManualServiceOrderSchema)
      .mutation(async ({ ctx, input }) => {
        requireSystemAdmin(ctx.user);
        try {
          return await manualServiceOrders.reject({
            ...input,
            actorUserId: ctx.user.id,
          });
        } catch (error) {
          throwServiceAdminError(error);
        }
      }),
  }),

  presales: router({
    status: adminProcedure.query(async ({ ctx }) => {
      requireSystemAdmin(ctx.user);
      try {
        return await getPresalesCredentialStatus();
      } catch (error) {
        throw toTrpcError(error);
      }
    }),

    set: adminProcedure
      .input(
        z.object({
          apiKey: presalesApiKeySchema,
          reason: z.string().trim().max(2_000).optional(),
        }),
      )
      .mutation(async ({ ctx, input }) => {
        requireSystemAdmin(ctx.user);
        try {
          const credential = await replacePresalesApiCredential(
            ctx.user.id,
            input.apiKey,
          );
          await writeWorkspaceAuditEvent({
            actor: ctx.user,
            action: "presales.credential.replaced",
            targetType: "presales_api_credential",
            targetId: "website",
            reason: input.reason,
            metadata: {
              fingerprint: credential.fingerprint,
              status: credential.status,
            },
          });
          void syncApiUsageSnapshots(ctx.user).catch(() => {
            console.error("[Presales usage] asynchronous refresh failed");
          });
          return credential;
        } catch (error) {
          throw toTrpcError(error);
        }
      }),

    replace: adminProcedure
      .input(
        z.object({
          apiKey: presalesApiKeySchema,
          reason: z.string().trim().max(2_000).optional(),
        }),
      )
      .mutation(async ({ ctx, input }) => {
        requireSystemAdmin(ctx.user);
        try {
          const credential = await replacePresalesApiCredential(
            ctx.user.id,
            input.apiKey,
          );
          await writeWorkspaceAuditEvent({
            actor: ctx.user,
            action: "presales.credential.replaced",
            targetType: "presales_api_credential",
            targetId: "website",
            reason: input.reason,
            metadata: {
              fingerprint: credential.fingerprint,
              status: credential.status,
            },
          });
          void syncApiUsageSnapshots(ctx.user).catch(() => {
            console.error("[Presales usage] asynchronous refresh failed");
          });
          return credential;
        } catch (error) {
          throw toTrpcError(error);
        }
      }),

    test: adminProcedure
      .input(z.object({ apiKey: presalesApiKeySchema.optional() }))
      .mutation(async ({ ctx, input }) => {
        requireSystemAdmin(ctx.user);
        try {
          return await testPresalesApiCredential(input.apiKey);
        } catch (error) {
          throw toTrpcError(error);
        }
      }),

    delete: adminProcedure
      .input(
        z
          .object({ reason: z.string().trim().max(2_000).optional() })
          .optional(),
      )
      .mutation(async ({ ctx, input }) => {
        requireSystemAdmin(ctx.user);
        try {
          await deletePresalesApiCredential();
          await writeWorkspaceAuditEvent({
            actor: ctx.user,
            action: "presales.credential.deleted",
            targetType: "presales_api_credential",
            targetId: "website",
            reason: input?.reason,
          });
          return { success: true } as const;
        } catch (error) {
          throw toTrpcError(error);
        }
      }),

    usage: adminProcedure
      .input(
        z
          .object({
            windowDays: z.literal(30),
          })
          .optional(),
      )
      .query(async ({ ctx, input }) => {
        requireSystemAdmin(ctx.user);
        try {
          return await getPresalesCreditUsageSnapshot();
        } catch (error) {
          throw toTrpcError(error);
        }
      }),

    twentyFirst: router({
      status: adminProcedure.query(async ({ ctx }) => {
        requireSystemAdmin(ctx.user);
        try {
          return await getTwentyFirstCredentialStatus();
        } catch (error) {
          throw toTrpcError(error);
        }
      }),

      test: adminProcedure
        .input(
          z.object({ apiKey: twentyFirstApiKeySchema.optional() }).strict(),
        )
        .mutation(async ({ ctx, input }) => {
          requireSystemAdmin(ctx.user);
          try {
            return await testTwentyFirstApiCredential(input.apiKey);
          } catch (error) {
            throw toTrpcError(error);
          }
        }),

      replace: adminProcedure
        .input(
          z
            .object({
              apiKey: twentyFirstApiKeySchema,
              reason: z.string().trim().max(2_000).optional(),
            })
            .strict(),
        )
        .mutation(async ({ ctx, input }) => {
          requireSystemAdmin(ctx.user);
          try {
            const credential = await replaceTwentyFirstApiCredential(
              ctx.user.id,
              input.apiKey,
            );
            await writeWorkspaceAuditEvent({
              actor: ctx.user,
              action: "siteops.twenty_first_credential.replaced",
              targetType: "presales_api_credential",
              targetId: "site_builder_21st",
              reason: input.reason,
              metadata: {
                fingerprint: credential.fingerprint,
                version: credential.version,
              },
            });
            return credential;
          } catch (error) {
            throw toTrpcError(error);
          }
        }),

      delete: adminProcedure
        .input(
          z
            .object({ reason: z.string().trim().max(2_000).optional() })
            .strict()
            .optional(),
        )
        .mutation(async ({ ctx, input }) => {
          requireSystemAdmin(ctx.user);
          try {
            const result = await deleteTwentyFirstApiCredential();
            await writeWorkspaceAuditEvent({
              actor: ctx.user,
              action: result.pending
                ? "siteops.twenty_first_credential.revocation_pending"
                : "siteops.twenty_first_credential.deleted",
              targetType: "presales_api_credential",
              targetId: "site_builder_21st",
              reason: input?.reason,
            });
            return {
              success: result.deleted || !result.pending,
              pending: result.pending,
            };
          } catch (error) {
            throw toTrpcError(error);
          }
        }),
    }),

    aliyun: router({
      status: adminProcedure.query(async ({ ctx }) => {
        requireSystemAdmin(ctx.user);
        try {
          return await getAliyunPlatformCredentialStatus();
        } catch (error) {
          throw toTrpcError(error);
        }
      }),

      test: adminProcedure.mutation(async ({ ctx }) => {
        requireSystemAdmin(ctx.user);
        try {
          return await testAliyunPlatformCredentials();
        } catch (error) {
          throw toTrpcError(error);
        }
      }),

      replaceOAuth: adminProcedure
        .input(
          aliyunOAuthCredentialInputSchema
            .extend({
              reason: z.string().trim().max(2_000).optional(),
            })
            .strict(),
        )
        .mutation(async ({ ctx, input }) => {
          requireSystemAdmin(ctx.user);
          try {
            const { reason, ...credentialInput } = input;
            const credential = await replaceAliyunOAuthCredential(
              ctx.user.id,
              credentialInput,
            );
            await writeWorkspaceAuditEvent({
              actor: ctx.user,
              action: "siteops.aliyun_oauth_credential.replaced",
              targetType: "presales_api_credential",
              targetId: "siteops_aliyun_oauth",
              reason,
              metadata: {
                fingerprint: credential.fingerprint,
                version: credential.version,
              },
            });
            return credential;
          } catch (error) {
            throw toTrpcError(error);
          }
        }),

      delete: adminProcedure
        .input(
          z
            .object({
              reason: z.string().trim().max(2_000).optional(),
            })
            .strict()
            .optional(),
        )
        .mutation(async ({ ctx, input }) => {
          requireSystemAdmin(ctx.user);
          try {
            const result = await deleteAliyunPlatformCredentials();
            await writeWorkspaceAuditEvent({
              actor: ctx.user,
              action: "siteops.aliyun_platform_credential.deleted",
              targetType: "presales_api_credential",
              targetId: "siteops_aliyun_oauth",
              reason: input?.reason,
            });
            return { success: result.deleted };
          } catch (error) {
            throw toTrpcError(error);
          }
        }),
    }),
  }),

  users: router({
    list: adminProcedure.query(async ({ ctx }) => {
      requireSystemAdmin(ctx.user);
      try {
        return { users: await listManagedUsers() };
      } catch (error) {
        throw toTrpcError(error);
      }
    }),

    create: adminProcedure
      .input(
        z.discriminatedUnion("role", [
          z.object({
            username: usernameSchema,
            password: passwordSchema,
            displayName: z.string().trim().max(128).optional(),
            role: z.literal("user"),
            planCode: provisionableServicePlanCodeSchema.optional(),
            marketEdition: accountMarketEditionSchema,
            deliveryAdminId: z.number().int().positive(),
            apiKey: presalesApiKeySchema.optional(),
          }),
          z.object({
            username: usernameSchema,
            password: passwordSchema,
            displayName: z.string().trim().max(128).optional(),
            role: z.literal("admin"),
            adminAccessLevel: z
              .enum(["system_admin", "delivery_admin"])
              .default("delivery_admin"),
          }),
          z.object({
            username: usernameSchema,
            password: passwordSchema,
            displayName: z.string().trim().max(128).optional(),
            role: z.literal("delivery_member"),
            engineerRoleType: deliveryRoleTypeSchema,
            apiKey: presalesApiKeySchema.optional(),
          }),
        ]),
      )
      .mutation(async ({ ctx, input }) => {
        if (input.role === "admin") {
          requireSystemAdmin(ctx.user);
        }
        try {
          if (input.role === "admin") {
            const user = await createManagedUser(input);
            await writeWorkspaceAuditEvent({
              actor: ctx.user,
              action: "account.created",
              targetType: "user",
              targetId: user.id,
              workspaceUserId: user.role === "user" ? user.id : null,
              metadata: {
                role: user.role,
                adminAccessLevel: user.adminAccessLevel ?? null,
              },
            });
            return {
              user,
              setupUrl: null,
              setupExpiresAt: null,
              contract: null,
              assignedToCreator: false,
            };
          }
          if (input.role === "delivery_member") {
            const user = await createDeliveryEngineer({
              actor: ctx.user,
              username: input.username,
              password: input.password,
              displayName: input.displayName,
              engineerRoleType: input.engineerRoleType,
              apiKey: input.apiKey,
            });
            return {
              user,
              setupUrl: null,
              setupExpiresAt: null,
              contract: null,
              assignedToCreator: false,
            };
          }
          const result = await createManagedOperatorUser({
            actor: ctx.user,
            username: input.username,
            password: input.password,
            displayName: input.displayName,
            marketEdition: input.marketEdition,
            deliveryAdminId: isSystemAdmin(ctx.user)
              ? input.deliveryAdminId
              : ctx.user.id,
            apiKey: input.apiKey,
          });
          return {
            user: result.user,
            setupUrl: null,
            setupExpiresAt: null,
            contract: null,
            assignedToCreator: result.assignedToCreator,
            assignedDeliveryAdminId: result.assignedDeliveryAdminId,
          };
        } catch (error) {
          throw toTrpcError(error);
        }
      }),

    resetPassword: adminProcedure
      .input(
        z.object({
          userId: z.number().int().positive(),
          newPassword: passwordSchema,
          reason: z.string().trim().max(2_000).optional(),
        }),
      )
      .mutation(async ({ ctx, input }) => {
        requireSystemAdmin(ctx.user);
        try {
          await resetManagedUserPassword(input.userId, input.newPassword);
          await writeWorkspaceAuditEvent({
            actor: ctx.user,
            action: "account.password_reset",
            targetType: "user",
            targetId: input.userId,
            workspaceUserId: input.userId,
            reason: input.reason,
          });
          return { success: true } as const;
        } catch (error) {
          throw toTrpcError(error);
        }
      }),

    setActive: adminProcedure
      .input(
        z.object({
          userId: z.number().int().positive(),
          isActive: z.boolean(),
          reason: z.string().trim().max(2_000).optional(),
        }),
      )
      .mutation(async ({ ctx, input }) => {
        requireSystemAdmin(ctx.user);
        try {
          const user = await setManagedUserActive(input.userId, input.isActive);
          await writeWorkspaceAuditEvent({
            actor: ctx.user,
            action: "account.status_updated",
            targetType: "user",
            targetId: input.userId,
            workspaceUserId: user.role === "user" ? user.id : null,
            reason: input.reason,
            metadata: { isActive: input.isActive, role: user.role },
          });
          return { user };
        } catch (error) {
          throw toTrpcError(error);
        }
      }),

    setAdminAccessLevel: adminProcedure
      .input(
        z.object({
          userId: z.number().int().positive(),
          adminAccessLevel: z.enum(["system_admin", "delivery_admin"]),
          reason: z.string().trim().max(2_000).optional(),
        }),
      )
      .mutation(async ({ ctx, input }) => {
        requireSystemAdmin(ctx.user);
        try {
          return await setManagedAdminAccessLevel({
            actor: ctx.user,
            targetUserId: input.userId,
            adminAccessLevel: input.adminAccessLevel,
            reason: input.reason,
          });
        } catch (error) {
          throw toTrpcError(error);
        }
      }),

    delete: adminProcedure
      .input(
        z.object({
          userId: z.number().int().positive(),
          reason: z.string().trim().max(2_000).optional(),
        }),
      )
      .mutation(async ({ ctx, input }) => {
        requireSystemAdmin(ctx.user);
        try {
          const result = await deleteManagedUser(ctx.user.id, input.userId, {
            onResultInTransaction: async (transactionResult, tx) => {
              const retainedForHistory =
                transactionResult.disposition === "deactivated_for_history";
              await writeWorkspaceAuditEvent(
                {
                  actor: ctx.user,
                  action: retainedForHistory
                    ? "account.deactivated_for_history"
                    : "account.deleted",
                  targetType: "user",
                  targetId: input.userId,
                  workspaceUserId: input.userId,
                  reason: input.reason,
                  metadata: {
                    disposition: transactionResult.disposition,
                  },
                },
                tx,
              );
            },
          });
          return {
            success: true,
            disposition: result.disposition,
          } as const;
        } catch (error) {
          throw toTrpcError(error);
        }
      }),
  }),
});
