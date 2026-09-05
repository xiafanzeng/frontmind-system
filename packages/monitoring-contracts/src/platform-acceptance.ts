import { z } from "zod";
import { idSchema } from "./monitoring.js";
import {
  clientTypeSchema,
  providerModeSchema,
  screenshotPolicySchema,
} from "./statuses.js";

export const platformAcceptanceStatuses = [
  "pending",
  "running",
  "passed",
  "failed",
  "unsupported",
  "stale",
] as const;

export const platformAcceptanceStatusSchema = z.enum(
  platformAcceptanceStatuses,
);

export const platformAcceptanceDimensions = [
  "search_default",
  "reasoning_search",
  "screenshot_mention",
  "screenshot_all",
  "region_default",
  "region_domestic",
  "region_overseas",
  "mobile_no_region",
] as const;

export const platformAcceptanceDimensionSchema = z.enum(
  platformAcceptanceDimensions,
);

const moneyStringSchema = z.string().regex(/^\d+$/u);

export const platformAcceptancePlanInputSchema = z.object({
  ownerId: idSchema,
  projectId: idSchema,
  platformIds: z.array(idSchema).min(1).max(100).optional(),
  question: z.string().trim().min(1).max(4_000),
  domesticRegionCode: z.string().trim().min(1).max(64).nullable().default(null),
  overseasRegionCode: z.string().trim().min(1).max(64).nullable().default(null),
});

export type PlatformAcceptancePlanInput = z.infer<
  typeof platformAcceptancePlanInputSchema
>;

export const platformAcceptanceCheckPlanSchema = z.object({
  platformId: idSchema,
  providerCode: z.string(),
  displayName: z.string(),
  clientType: clientTypeSchema,
  platformFingerprint: z.string().length(64),
  dimension: platformAcceptanceDimensionSchema,
  mode: providerModeSchema,
  screenshot: screenshotPolicySchema,
  regionCode: z.string().nullable(),
  unitAmountTenThousandths: moneyStringSchema,
});

export const platformAcceptancePlanOutputSchema = z.object({
  planFingerprint: z.string().length(64),
  currency: z.literal("CNY"),
  scale: z.literal(4),
  attemptCount: z.number().int().positive().max(500),
  totalAmountTenThousandths: moneyStringSchema,
  checks: z.array(platformAcceptanceCheckPlanSchema).min(1).max(500),
});

export type PlatformAcceptancePlanOutput = z.infer<
  typeof platformAcceptancePlanOutputSchema
>;

export const platformAcceptanceStartInputSchema =
  platformAcceptancePlanInputSchema.extend({
    planFingerprint: z.string().length(64),
    confirmedTotalAmountTenThousandths: moneyStringSchema,
    idempotencyKey: z
      .string()
      .trim()
      .min(8)
      .max(128)
      .regex(/^[A-Za-z0-9:_-]+$/u),
  });

export type PlatformAcceptanceStartInput = z.infer<
  typeof platformAcceptanceStartInputSchema
>;

export const platformAcceptanceCheckOutputSchema = z.object({
  id: idSchema,
  batchId: idSchema,
  platformId: idSchema,
  providerCode: z.string(),
  displayName: z.string(),
  clientType: clientTypeSchema,
  platformFingerprint: z.string().length(64),
  dimension: platformAcceptanceDimensionSchema,
  mode: providerModeSchema,
  screenshot: screenshotPolicySchema,
  regionCode: z.string().nullable(),
  status: platformAcceptanceStatusSchema,
  runId: idSchema.nullable(),
  attemptId: idSchema.nullable(),
  resultHash: z.string().nullable(),
  screenshotHash: z.string().nullable(),
  errorCode: z.string().nullable(),
  errorSummary: z.string().nullable(),
  startedAt: z.coerce.date().nullable(),
  completedAt: z.coerce.date().nullable(),
  createdAt: z.coerce.date(),
  updatedAt: z.coerce.date(),
});

export const platformAcceptanceBatchOutputSchema = z.object({
  id: idSchema,
  ownerId: idSchema,
  projectId: idSchema,
  requestedBy: idSchema,
  planFingerprint: z.string().length(64),
  questionHash: z.string().length(64),
  status: platformAcceptanceStatusSchema,
  attemptCount: z.number().int().positive().max(500),
  totalAmountTenThousandths: moneyStringSchema,
  idempotencyKey: z.string(),
  startedAt: z.coerce.date().nullable(),
  completedAt: z.coerce.date().nullable(),
  createdAt: z.coerce.date(),
  updatedAt: z.coerce.date(),
  checks: z.array(platformAcceptanceCheckOutputSchema),
});

export type PlatformAcceptanceBatchOutput = z.infer<
  typeof platformAcceptanceBatchOutputSchema
>;

export const platformAcceptanceListInputSchema = z.object({
  limit: z.number().int().min(1).max(100).default(30),
});

export const platformAcceptanceGetInputSchema = z.object({
  batchId: idSchema,
});
