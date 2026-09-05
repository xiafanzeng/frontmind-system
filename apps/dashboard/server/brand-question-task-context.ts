import { createHmac, timingSafeEqual } from "node:crypto";

import { z } from "zod";

import { servicePlanCodeSchema } from "../shared/service-portal";

const brandQuestionTaskContextSchema = z
  .object({
    v: z.literal(1),
    userId: z.number().int().positive(),
    taskId: z.string().trim().min(1).max(255),
    snapshotId: z.string().trim().min(1).max(191),
    snapshotHash: z.string().trim().min(1).max(191),
    quotaPeriodId: z.string().trim().min(1).max(191),
    planCode: servicePlanCodeSchema,
    exp: z.number().int().positive(),
  })
  .strict();

export type BrandQuestionTaskContext = z.infer<
  typeof brandQuestionTaskContextSchema
>;

export class BrandQuestionTaskContextError extends Error {
  constructor(
    public readonly code:
      | "BRAND_QUESTION_TASK_CONTEXT_INVALID"
      | "BRAND_QUESTION_TASK_CONTEXT_EXPIRED"
      | "BRAND_QUESTION_TASK_STALE",
    message: string,
  ) {
    super(message);
    this.name = "BrandQuestionTaskContextError";
  }
}

function signature(payload: string, secret: string) {
  if (!secret) {
    throw new BrandQuestionTaskContextError(
      "BRAND_QUESTION_TASK_CONTEXT_INVALID",
      "候选词任务缺少服务端凭证上下文",
    );
  }
  return createHmac("sha256", secret).update(payload).digest();
}

export function createBrandQuestionTaskContextToken(input: {
  userId: number;
  taskId: string;
  snapshotId: string;
  snapshotHash: string;
  quotaPeriodId: string;
  planCode: "advanced" | "luxury";
  secret: string;
  now?: Date;
  ttlMs?: number;
}) {
  const now = input.now ?? new Date();
  const context = brandQuestionTaskContextSchema.parse({
    v: 1,
    userId: input.userId,
    taskId: input.taskId,
    snapshotId: input.snapshotId,
    snapshotHash: input.snapshotHash,
    quotaPeriodId: input.quotaPeriodId,
    planCode: input.planCode,
    exp: now.getTime() + (input.ttlMs ?? 24 * 60 * 60 * 1_000),
  });
  const payload = Buffer.from(JSON.stringify(context), "utf8").toString(
    "base64url",
  );
  return `${payload}.${signature(payload, input.secret).toString("base64url")}`;
}

export function verifyBrandQuestionTaskContextToken(input: {
  token: string;
  secret: string;
  now?: Date;
  expected: {
    userId: number;
    taskId: string;
    snapshotId: string;
    snapshotHash: string;
    quotaPeriodId: string;
    planCode: "advanced" | "luxury";
  };
}) {
  const [payload, encodedSignature, extra] = input.token.split(".");
  if (!payload || !encodedSignature || extra) {
    throw new BrandQuestionTaskContextError(
      "BRAND_QUESTION_TASK_CONTEXT_INVALID",
      "候选词任务上下文无效，请重新生成",
    );
  }
  const expectedSignature = signature(payload, input.secret);
  let actualSignature: Buffer;
  try {
    actualSignature = Buffer.from(encodedSignature, "base64url");
  } catch {
    actualSignature = Buffer.alloc(0);
  }
  if (
    actualSignature.length !== expectedSignature.length ||
    !timingSafeEqual(actualSignature, expectedSignature)
  ) {
    throw new BrandQuestionTaskContextError(
      "BRAND_QUESTION_TASK_CONTEXT_INVALID",
      "候选词任务上下文无效，请重新生成",
    );
  }
  let context: BrandQuestionTaskContext;
  try {
    context = brandQuestionTaskContextSchema.parse(
      JSON.parse(Buffer.from(payload, "base64url").toString("utf8")),
    );
  } catch {
    throw new BrandQuestionTaskContextError(
      "BRAND_QUESTION_TASK_CONTEXT_INVALID",
      "候选词任务上下文无效，请重新生成",
    );
  }
  if (context.exp <= (input.now ?? new Date()).getTime()) {
    throw new BrandQuestionTaskContextError(
      "BRAND_QUESTION_TASK_CONTEXT_EXPIRED",
      "候选词任务已过期，请重新生成",
    );
  }
  const expected = input.expected;
  if (
    context.userId !== expected.userId ||
    context.taskId !== expected.taskId ||
    context.snapshotId !== expected.snapshotId ||
    context.snapshotHash !== expected.snapshotHash ||
    context.quotaPeriodId !== expected.quotaPeriodId ||
    context.planCode !== expected.planCode
  ) {
    throw new BrandQuestionTaskContextError(
      "BRAND_QUESTION_TASK_STALE",
      "知识库内容、服务周期或候选词任务已变化，请重新生成",
    );
  }
  return context;
}

export function classifyBrandQuestionTaskStatus(value: unknown) {
  const status = String(value ?? "")
    .trim()
    .toLowerCase();
  if (["completed", "complete", "succeeded", "success"].includes(status)) {
    return "completed" as const;
  }
  if (
    ["failed", "error", "cancelled", "canceled", "expired"].includes(status)
  ) {
    return "failed" as const;
  }
  return "running" as const;
}
