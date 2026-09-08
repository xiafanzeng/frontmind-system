import { z } from "zod";

const dateOnly = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .refine((value) => {
    const parsed = new Date(`${value}T00:00:00Z`);
    return (
      Number.isFinite(parsed.getTime()) &&
      parsed.toISOString().slice(0, 10) === value
    );
  }, "请输入有效日期");
export const aiUsageReportInput = z
  .object({
    from: dateOnly,
    to: dateOnly,
    scope: z.enum(["all", "website_frontend", "managed_user"]).default("all"),
    fingerprint: z
      .string()
      .regex(/^fp_[a-f0-9]{16}$/)
      .optional(),
    model: z
      .string()
      .regex(/^[a-zA-Z0-9._-]{1,64}$/)
      .optional(),
    owner: z
      .discriminatedUnion("kind", [
        z.object({ kind: z.literal("unassigned") }),
        z.object({
          kind: z.literal("name"),
          value: z.string().trim().min(1).max(255),
        }),
      ])
      .optional(),
    state: z.string().min(1).max(64).optional(),
    page: z.number().int().min(1).max(10000).default(1),
  })
  .refine((input) => {
    const span = Date.parse(input.to) - Date.parse(input.from);
    return span >= 0 && span < 366 * 86400000;
  }, "开始日期须早于结束日期，最多查询 366 天");
export type AiUsageReportInput = z.infer<typeof aiUsageReportInput>;
export function aiUsageReportWindow(
  input: Pick<AiUsageReportInput, "from" | "to">,
) {
  return {
    startAt: Date.parse(`${input.from}T00:00:00+08:00`),
    endAt: Date.parse(`${input.to}T00:00:00+08:00`) + 86400000,
  };
}
export function chinaDate(now: number) {
  return new Date(now + 8 * 3600000).toISOString().slice(0, 10);
}

export const aiUsageTaskEventsInput = aiUsageReportInput.and(
  z.object({
    taskId: z.string().min(1).max(128),
    eventPage: z.number().int().min(1).max(100000).default(1),
  }),
);
