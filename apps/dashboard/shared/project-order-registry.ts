import { z } from "zod";

const opaqueIdentifierSchema = z
  .string()
  .min(8)
  .max(128)
  .regex(
    /^[A-Za-z0-9][A-Za-z0-9._:-]*$/,
    "identifier contains unsupported characters",
  );

export const projectOrderProjectIdSchema = z
  .string()
  .min(8)
  .max(80)
  .regex(
    /^[A-Za-z0-9][A-Za-z0-9._:-]*$/,
    "projectId contains unsupported characters",
  );

const sha256DigestSchema = z
  .string()
  .length(64)
  .regex(/^[a-f0-9]{64}$/, "digest must be lowercase SHA-256 hex");

const canonicalUtcTimestampSchema = z
  .string()
  .regex(
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/,
    "timestamp must use canonical UTC millisecond precision",
  )
  .refine(
    (value) => {
      const timestamp = Date.parse(value);
      return (
        Number.isFinite(timestamp) &&
        new Date(timestamp).toISOString() === value
      );
    },
    { message: "timestamp must be valid" },
  );

export const projectOrderStateSchema = z.enum([
  "pending",
  "paid",
  "fulfilling",
  "fulfilled",
  "review_required",
  "terminal_failed",
  "closed",
]);

export const projectOrderSchema = z
  .object({
    orderId: opaqueIdentifierSchema,
    projectId: projectOrderProjectIdSchema,
    purchaseType: z.enum(["monitoring", "service"]),
    amountFen: z.number().int().positive().max(10_000_000),
    authorizationDigest: sha256DigestSchema,
    state: projectOrderStateSchema,
    checkoutExpiresAt: canonicalUtcTimestampSchema,
    eventAt: canonicalUtcTimestampSchema,
    paidAt: canonicalUtcTimestampSchema.optional(),
    fulfilledAt: canonicalUtcTimestampSchema.optional(),
  })
  .strict()
  .superRefine((value, context) => {
    if (!["pending", "closed"].includes(value.state) && !value.paidAt) {
      context.addIssue({
        code: "custom",
        path: ["paidAt"],
        message: "paidAt is required after payment",
      });
    }
    if (value.state === "fulfilled" && !value.fulfilledAt) {
      context.addIssue({
        code: "custom",
        path: ["fulfilledAt"],
        message: "fulfilledAt is required for fulfilled orders",
      });
    }
    if (value.state !== "fulfilled" && value.fulfilledAt) {
      context.addIssue({
        code: "custom",
        path: ["fulfilledAt"],
        message: "fulfilledAt is only valid for fulfilled orders",
      });
    }
    if (value.paidAt && Date.parse(value.paidAt) > Date.parse(value.eventAt)) {
      context.addIssue({
        code: "custom",
        path: ["eventAt"],
        message: "eventAt cannot precede paidAt",
      });
    }
    if (
      value.fulfilledAt &&
      value.paidAt &&
      Date.parse(value.fulfilledAt) < Date.parse(value.paidAt)
    ) {
      context.addIssue({
        code: "custom",
        path: ["fulfilledAt"],
        message: "fulfilledAt cannot precede paidAt",
      });
    }
  });

export const projectOrderWriteRequestSchema = z
  .object({
    schemaVersion: z.literal(1),
    order: projectOrderSchema,
  })
  .strict();

export const projectOrderResponseSchema = z
  .object({
    schemaVersion: z.literal(1),
    order: projectOrderSchema,
  })
  .strict();

export const projectOrderIntentCommitRequestSchema = z
  .object({
    schemaVersion: z.literal(1),
    order: projectOrderSchema,
  })
  .strict()
  .superRefine((value, context) => {
    if (value.order.state !== "pending") {
      context.addIssue({
        code: "custom",
        path: ["order", "state"],
        message: "a committed checkout must begin in pending state",
      });
    }
  });

export const projectOrderIntentCommitResponseSchema = z
  .object({
    schemaVersion: z.literal(1),
    intent: projectOrderSchema,
    order: projectOrderSchema,
  })
  .strict()
  .superRefine((value, context) => {
    if (
      value.intent.state !== "closed" ||
      value.intent.projectId !== value.order.projectId ||
      value.intent.purchaseType !== value.order.purchaseType ||
      value.intent.amountFen !== value.order.amountFen
    ) {
      context.addIssue({
        code: "custom",
        path: ["intent"],
        message: "closed intent does not match the committed checkout",
      });
    }
  });

export const projectOrderProjectResponseSchema = z
  .object({
    schemaVersion: z.literal(1),
    projectId: projectOrderProjectIdSchema,
    blockDeletion: z.boolean(),
    orders: z.array(projectOrderSchema).max(100),
  })
  .strict()
  .superRefine((value, context) => {
    const expected = value.orders.some(
      (order) =>
        !["fulfilled", "terminal_failed", "closed"].includes(order.state),
    );
    if (value.blockDeletion !== expected) {
      context.addIssue({
        code: "custom",
        path: ["blockDeletion"],
        message: "blockDeletion does not match the returned order states",
      });
    }
    for (const [index, order] of value.orders.entries()) {
      if (order.projectId !== value.projectId) {
        context.addIssue({
          code: "custom",
          path: ["orders", index, "projectId"],
          message: "order does not belong to the requested project",
        });
      }
    }
  });

export const projectOrderProjectDeleteResponseSchema = z
  .object({
    schemaVersion: z.literal(1),
    projectId: projectOrderProjectIdSchema,
    deletedOrders: z.number().int().nonnegative(),
  })
  .strict();

export type ProjectOrderState = z.infer<typeof projectOrderStateSchema>;
export type ProjectOrder = z.infer<typeof projectOrderSchema>;
export type ProjectOrderWriteRequest = z.infer<
  typeof projectOrderWriteRequestSchema
>;
export type ProjectOrderResponse = z.infer<typeof projectOrderResponseSchema>;
export type ProjectOrderIntentCommitRequest = z.infer<
  typeof projectOrderIntentCommitRequestSchema
>;
export type ProjectOrderIntentCommitResponse = z.infer<
  typeof projectOrderIntentCommitResponseSchema
>;
export type ProjectOrderProjectResponse = z.infer<
  typeof projectOrderProjectResponseSchema
>;
export type ProjectOrderProjectDeleteResponse = z.infer<
  typeof projectOrderProjectDeleteResponseSchema
>;
