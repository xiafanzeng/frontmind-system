import { z } from "zod";

const opaqueIdentifierSchema = z
  .string()
  .min(8)
  .max(128)
  .regex(
    /^[A-Za-z0-9][A-Za-z0-9._:-]*$/,
    "identifier contains unsupported characters",
  );

const sha256DigestSchema = z
  .string()
  .length(64)
  .regex(/^[a-f0-9]{64}$/, "digest must be lowercase SHA-256 hex");

const paidAtSchema = z
  .string()
  .regex(
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/,
    "paidAt must be a canonical UTC timestamp with millisecond precision",
  )
  .refine(
    (value) => {
      const timestamp = Date.parse(value);
      return (
        Number.isFinite(timestamp) &&
        new Date(timestamp).toISOString() === value
      );
    },
    { message: "paidAt must be a valid timestamp" },
  );

export const paymentReceiptSchema = z
  .object({
    orderId: opaqueIdentifierSchema,
    tradeNo: opaqueIdentifierSchema,
    amountFen: z.number().int().positive().max(10_000_000),
    paidAt: paidAtSchema,
    purchaseType: z.enum(["monitoring", "service"]),
    scopeHash: sha256DigestSchema,
    authorizationDigest: sha256DigestSchema,
    reviewRequired: z.boolean(),
  })
  .strict();

export const paymentReceiptWriteRequestSchema = z
  .object({
    schemaVersion: z.literal(1),
    receipt: paymentReceiptSchema,
  })
  .strict();

export const paymentReceiptReadQuerySchema = z
  .object({
    scopeHash: sha256DigestSchema,
    authorizationDigest: sha256DigestSchema,
  })
  .strict();

export const paymentReceiptReadRequestSchema = paymentReceiptReadQuerySchema
  .extend({
    orderId: opaqueIdentifierSchema,
  })
  .strict();

export const paymentReceiptResponseSchema = z
  .object({
    schemaVersion: z.literal(1),
    receipt: paymentReceiptSchema,
  })
  .strict();

export const paymentReceiptReadyResponseSchema = z
  .object({
    schemaVersion: z.literal(1),
    ready: z.literal(true),
  })
  .strict();

export type PaymentReceipt = z.infer<typeof paymentReceiptSchema>;
export type PaymentReceiptWriteRequest = z.infer<
  typeof paymentReceiptWriteRequestSchema
>;
export type PaymentReceiptReadRequest = z.infer<
  typeof paymentReceiptReadRequestSchema
>;
export type PaymentReceiptResponse = z.infer<
  typeof paymentReceiptResponseSchema
>;
