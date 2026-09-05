import { z } from "zod";
import {
  clientTypeSchema,
  providerModeSchema,
  scheduleTypeSchema,
  screenshotPolicySchema,
} from "./statuses.js";

export const idSchema = z.string().uuid();
export const idempotencyKeySchema = z
  .string()
  .trim()
  .min(8)
  .max(128)
  .regex(/^[A-Za-z0-9:_-]+$/);
export const timezoneSchema = z
  .string()
  .trim()
  .min(1)
  .max(64)
  .refine((value) => {
    try {
      Intl.DateTimeFormat(undefined, { timeZone: value });
      return true;
    } catch {
      return false;
    }
  }, "Invalid IANA time zone");

export const brandAliasSchema = z.string().trim().min(1).max(120);
export const competitorInputSchema = z.object({
  name: z.string().trim().min(1).max(120),
  aliases: z.array(brandAliasSchema).max(50).default([]),
});

export const projectCreateInputSchema = z.object({
  name: z.string().trim().min(1).max(120),
  mainBrand: z.string().trim().min(1).max(120),
  aliases: z.array(brandAliasSchema).max(50).default([]),
  competitors: z.array(competitorInputSchema).max(50).default([]),
  timezone: timezoneSchema.default("Asia/Shanghai"),
});
export type ProjectCreateInput = z.infer<typeof projectCreateInputSchema>;

export const projectBrandUpdateInputSchema = projectCreateInputSchema
  .pick({ mainBrand: true, aliases: true, competitors: true })
  .extend({ projectId: idSchema });
export type ProjectBrandUpdateInput = z.infer<
  typeof projectBrandUpdateInputSchema
>;

export const projectUpdateInputSchema = projectCreateInputSchema.extend({
  projectId: idSchema,
});
export type ProjectUpdateInput = z.infer<typeof projectUpdateInputSchema>;

export const scheduleInputSchema = z
  .object({
    type: scheduleTypeSchema,
    timezone: timezoneSchema.default("Asia/Shanghai"),
    localTime: z
      .string()
      .regex(/^([01]\d|2[0-3]):[0-5]\d$/)
      .default("09:00"),
    weekday: z.number().int().min(1).max(7).nullable().default(null),
  })
  .superRefine((value, ctx) => {
    if (value.type === "weekly" && value.weekday === null) {
      ctx.addIssue({
        code: "custom",
        path: ["weekday"],
        message: "Weekly schedules require a weekday",
      });
    }
    if (value.type !== "weekly" && value.weekday !== null) {
      ctx.addIssue({
        code: "custom",
        path: ["weekday"],
        message: "Weekday is only valid for weekly schedules",
      });
    }
  });
export type ScheduleInput = z.infer<typeof scheduleInputSchema>;

export const platformSelectionSchema = z.object({
  platformId: idSchema,
  providerCode: z.string().trim().min(1).max(64),
  clientType: clientTypeSchema,
  mode: providerModeSchema,
  screenshot: screenshotPolicySchema.default(1),
  regionCode: z.string().trim().min(1).max(64).nullable().default(null),
});
export type PlatformSelection = z.infer<typeof platformSelectionSchema>;

export const monitorConfigurationSchema = z
  .object({
    name: z.string().trim().min(1).max(120),
    brandAliases: z.array(brandAliasSchema).max(50).default([]),
    competitors: z.array(competitorInputSchema).max(50).default([]),
    questions: z.array(z.string().trim().min(1).max(4_000)).min(1).max(50),
    platforms: z.array(platformSelectionSchema).min(1).max(50),
    repetitions: z.number().int().min(1).max(10).default(5),
    schedule: scheduleInputSchema.default({
      type: "none",
      timezone: "Asia/Shanghai",
      localTime: "09:00",
      weekday: null,
    }),
  })
  .transform((value) => ({
    ...value,
    questions: normalizeQuestions(value.questions),
  }))
  .superRefine((value, ctx) => {
    if (value.questions.length === 0) {
      ctx.addIssue({
        code: "custom",
        path: ["questions"],
        message: "At least one non-empty question is required",
      });
    }
    if (value.questions.length > 50) {
      ctx.addIssue({
        code: "custom",
        path: ["questions"],
        message: "A monitor may contain at most 50 questions",
      });
    }
    const attempts = calculateAttemptCount(
      value.questions.length,
      value.platforms.length,
      value.repetitions,
    );
    if (attempts > 500) {
      ctx.addIssue({
        code: "custom",
        path: ["repetitions"],
        message: `A run may contain at most 500 attempts; received ${attempts}`,
      });
    }
    const duplicatePlatforms = new Set<string>();
    const seen = new Set<string>();
    for (const platform of value.platforms) {
      const key = `${platform.providerCode}:${platform.clientType}`;
      if (seen.has(key)) duplicatePlatforms.add(key);
      seen.add(key);
      if (platform.clientType === "mobile" && platform.regionCode !== null) {
        ctx.addIssue({
          code: "custom",
          path: ["platforms"],
          message: "Mobile platforms must use the provider default region",
        });
      }
    }
    if (duplicatePlatforms.size > 0) {
      ctx.addIssue({
        code: "custom",
        path: ["platforms"],
        message: "A platform can only be selected once",
      });
    }
  });
export type MonitorConfiguration = z.infer<typeof monitorConfigurationSchema>;

export const monitorCreateInputSchema = z.object({
  projectId: idSchema,
  configuration: monitorConfigurationSchema,
  runImmediately: z.boolean().default(false),
  idempotencyKey: idempotencyKeySchema.optional(),
});
export type MonitorCreateInput = z.infer<typeof monitorCreateInputSchema>;

export const monitorUpdateInputSchema = z.object({
  monitorId: idSchema,
  configuration: monitorConfigurationSchema,
  runImmediately: z.boolean().default(false),
  idempotencyKey: idempotencyKeySchema.optional(),
});
export type MonitorUpdateInput = z.infer<typeof monitorUpdateInputSchema>;

export const runNowInputSchema = z.object({
  monitorId: idSchema,
  idempotencyKey: idempotencyKeySchema,
});
export type RunNowInput = z.infer<typeof runNowInputSchema>;

export const listInputSchema = z.object({
  cursor: idSchema.optional(),
  limit: z.number().int().min(1).max(100).default(30),
});

export function normalizeQuestions(lines: readonly string[]): string[] {
  const seen = new Set<string>();
  const normalized: string[] = [];
  for (const line of lines.flatMap((value) => value.split(/\r?\n/u))) {
    const question = line.trim();
    if (question.length === 0 || seen.has(question)) continue;
    seen.add(question);
    normalized.push(question);
  }
  return normalized;
}

export function calculateAttemptCount(
  questionCount: number,
  platformCount: number,
  repetitions: number,
): number {
  if (
    ![questionCount, platformCount, repetitions].every(Number.isSafeInteger)
  ) {
    throw new TypeError("Attempt dimensions must be safe integers");
  }
  if (questionCount < 0 || platformCount < 0 || repetitions < 0) {
    throw new RangeError("Attempt dimensions cannot be negative");
  }
  return questionCount * platformCount * repetitions;
}
