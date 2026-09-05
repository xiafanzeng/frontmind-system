import { z } from "zod";
import {
  clientTypeSchema,
  roleSchema,
  runStatusSchema,
  userStatusSchema,
} from "./statuses.js";
import { idSchema, listInputSchema } from "./monitoring.js";

export const usernameSchema = z
  .string()
  .trim()
  .min(3)
  .max(64)
  .regex(
    /^[A-Za-z0-9._-]+$/,
    "Username may only contain letters, numbers, dot, underscore and dash",
  );
export const passwordSchema = z.string().min(12).max(256);
const loginPasswordSchema = z.string().min(1).max(256);

export const loginInputSchema = z.object({
  username: usernameSchema,
  password: loginPasswordSchema,
});
export type LoginInput = z.infer<typeof loginInputSchema>;

export const adminCreateUserInputSchema = z.object({
  username: usernameSchema,
  password: passwordSchema,
  role: roleSchema.default("user"),
});
export type AdminCreateUserInput = z.infer<typeof adminCreateUserInputSchema>;

export const adminUserViewSchema = z.object({
  id: idSchema,
  username: usernameSchema,
  role: roleSchema,
  status: userStatusSchema,
  createdAt: z.coerce.date(),
});
export type AdminUserView = z.infer<typeof adminUserViewSchema>;

export const adminSetUserStatusInputSchema = z.object({
  userId: idSchema,
  status: userStatusSchema,
});
export const adminResetPasswordInputSchema = z.object({
  userId: idSchema,
  password: passwordSchema,
});
export const changePasswordInputSchema = z.object({
  currentPassword: passwordSchema,
  newPassword: passwordSchema,
});

export const quotaAdjustmentInputSchema = z.object({
  userId: idSchema,
  units: z
    .number()
    .int()
    .min(-2_147_483_647)
    .max(2_147_483_647)
    .refine((value) => value !== 0),
  reason: z.string().trim().min(3).max(240),
  idempotencyKey: z.string().trim().min(8).max(128),
});

export const platformCapabilityInputSchema = z.object({
  platformId: idSchema.optional(),
  providerCode: z.string().trim().min(1).max(64),
  displayName: z.string().trim().min(1).max(100),
  clientType: clientTypeSchema,
  enabled: z.boolean(),
  verified: z.boolean(),
  supportsReasoning: z.boolean(),
  supportsScreenshot: z.boolean(),
  supportsDomesticRegion: z.boolean(),
  supportsOverseasRegion: z.boolean(),
  pricingClass: z.enum(["domestic", "overseas"]).nullable().optional(),
});

export const auditListInputSchema = listInputSchema
  .extend({
    actorId: idSchema.optional(),
    action: z.string().trim().max(120).optional(),
    domain: z.enum(["monitoring", "media_publishing"]).optional(),
    from: z.coerce.date().optional(),
    to: z.coerce.date().optional(),
  })
  .superRefine(validateDateRange);

export const adminOperationsListInputSchema = listInputSchema
  .extend({
    userId: idSchema.optional(),
    status: runStatusSchema.optional(),
    from: z.coerce.date().optional(),
    to: z.coerce.date().optional(),
  })
  .superRefine(validateDateRange);
export type AdminOperationsListInput = z.infer<
  typeof adminOperationsListInputSchema
>;

function validateDateRange(
  value: { from?: Date; to?: Date },
  ctx: z.RefinementCtx,
) {
  if (value.from && value.to && value.from > value.to) {
    ctx.addIssue({
      code: "custom",
      path: ["to"],
      message: "The end date must not be earlier than the start date",
    });
  }
}
