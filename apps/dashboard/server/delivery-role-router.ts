import { TRPCError } from "@trpc/server";

import { z } from "zod";

import {
  BRAND_TRACKING_CREDITS_INPUT_PATTERN,
  brandTrackingCreditsToAmount,
} from "../shared/brand-tracking-credits";

import { deliveryRoleTypeSchema } from "../shared/delivery-roles";

import { adjustQuestionQuotaSchema } from "../shared/service-portal";

import { toTrpcError } from "./auth-router";

import {
  getMyCustomerBrandTrackingUsage,
  getMyDeliveryWorkbench,
  listDeliveryRoleManagement,
  listMyProjectAssignments,
  setProjectEngineer,
  updateMyCustomerBrandTrackingLimit,
} from "./delivery-role-service";

import { adminProcedure, protectedProcedure, router } from "./_core/trpc";

import { adjustMyCustomerQuestionQuota } from "./question-quota-service";

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
  }),
});
