import { z } from "zod";
import { MAX_PASSWORD_LENGTH } from "./auth-constraints";

const serviceCategorySchema = z.enum([
  "product_scenario",
  "reputation",
  "competitor_comparison",
]);
const isoDateTimeSchema = z.string().datetime({ offset: true });
const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/i);
const identifierSchema = z.string().trim().min(4).max(128);
const usernameSchema = z
  .string()
  .trim()
  .min(3)
  .max(64)
  .regex(/^[a-zA-Z0-9._-]+$/);

export const manualServiceOrderStatusSchema = z.enum([
  "pending_admin",
  "signature_required",
  "payment_required",
  "account_setup_required",
  "activation_required",
  "active",
  "rejected",
  "failed",
]);

export type ManualServiceOrderStatus = z.infer<
  typeof manualServiceOrderStatusSchema
>;

export const manualServiceContractProfileSchema = z
  .object({
    legalName: z.string().trim().min(2).max(200),
    creditCode: z
      .string()
      .trim()
      .toUpperCase()
      .regex(/^[0-9A-HJ-NPQRTUWXY]{18}$/),
    address: z.string().trim().min(5).max(500),
    signatoryName: z.string().trim().min(2).max(128),
    signatoryTitle: z.string().trim().min(2).max(128),
    mobile: z
      .string()
      .trim()
      .regex(/^1\d{10}$/),
    email: z.string().trim().email().max(320),
    authorized: z.literal(true),
  })
  .strict();

export const manualServiceAccountTargetSchema = z.discriminatedUnion("mode", [
  z
    .object({
      mode: z.literal("create"),
      username: usernameSchema,
      displayName: z.string().trim().min(2).max(128),
      password: z
        .string()
        .min(8, "密码至少需要 8 个字符")
        .max(MAX_PASSWORD_LENGTH, `密码不能超过 ${MAX_PASSWORD_LENGTH} 个字符`),
    })
    .strict(),
  z
    .object({
      mode: z.literal("bind_existing"),
      purchaseIntent: z.string().trim().min(16).max(4096),
    })
    .strict(),
]);

export const createManualServiceOrderRequestSchema = z
  .object({
    schemaVersion: z.literal(1),
    project: z
      .object({
        id: z.string().trim().min(8).max(80),
        companyName: z.string().trim().min(1).max(200),
      })
      .strict(),
    service: z
      .object({
        planCode: z.literal("basic"),
        serviceDays: z.literal(30),
        purchasedQuestion: z
          .object({
            id: z.string().trim().min(4).max(80),
            category: serviceCategorySchema,
            question: z.string().trim().min(4).max(500),
          })
          .strict(),
      })
      .strict(),
    contract: z
      .object({
        templateVersion: z.string().trim().min(1).max(64),
        profile: manualServiceContractProfileSchema,
      })
      .strict(),
  })
  .strict()
  .superRefine((value, context) => {
    const normalize = (text: string) =>
      text.normalize("NFKC").replace(/\s+/g, "").toLowerCase();
    if (
      normalize(value.project.companyName) !==
      normalize(value.contract.profile.legalName)
    ) {
      context.addIssue({
        code: "custom",
        path: ["contract", "profile", "legalName"],
        message: "contract legalName must match project companyName",
      });
    }
  });

export const manualServicePaymentRequestSchema = z
  .object({
    schemaVersion: z.literal(1),
    payment: z
      .object({
        orderId: z.string().trim().min(8).max(64),
        tradeNo: z.string().trim().min(1).max(128),
        amountFen: z.number().int().positive().max(10_000_000),
        paidAt: isoDateTimeSchema,
      })
      .strict(),
  })
  .strict();

export const manualServiceAccountSetupRequestSchema = z
  .object({
    schemaVersion: z.literal(1),
    account: manualServiceAccountTargetSchema,
  })
  .strict();

export const prepareManualServiceOrderSchema = z
  .object({
    reference: identifierSchema,
    contractId: identifierSchema,
    signingUrl: z
      .string()
      .url()
      .max(2048)
      .refine((value) => new URL(value).protocol === "https:", {
        message: "signingUrl must use HTTPS",
      }),
  })
  .strict();

const signedArtifactSchema = z
  .object({
    fileId: z.string().trim().min(1).max(128),
    filename: z
      .string()
      .trim()
      .min(1)
      .max(500)
      .refine(
        (value) =>
          !value.includes("/") &&
          !value.includes("\\") &&
          !/[\u0000-\u001f\u007f]/.test(value),
        { message: "filename must be a plain file name" },
      ),
    sha256: sha256Schema,
  })
  .strict();

export const confirmManualServiceOrderSignedSchema = z
  .object({
    reference: identifierSchema,
    signedPdf: signedArtifactSchema,
    evidenceReport: signedArtifactSchema.optional(),
    signedAt: z.number().int().positive().max(8_640_000_000_000_000),
    signatoryId: z.string().trim().min(1).max(128),
    note: z.string().trim().min(8).max(2000),
  })
  .strict();

export const authorizeExternalManualServiceContractSchema = z
  .object({
    schemaVersion: z.literal(1),
    authorization: z
      .object({
        mode: z.literal("external_wechat"),
        eventReference: identifierSchema,
        authorizedAt: isoDateTimeSchema,
      })
      .strict(),
  })
  .strict();

export const activateManualServiceOrderSchema = z
  .object({ reference: identifierSchema })
  .strict();

export const rejectManualServiceOrderSchema = z
  .object({
    reference: identifierSchema,
    note: z.string().trim().min(4).max(2000),
  })
  .strict();

export const manualServiceOrderResponseSchema = z
  .object({
    schemaVersion: z.literal(1),
    order: z
      .object({
        reference: identifierSchema,
        projectId: z.string().trim().min(8).max(80),
        status: manualServiceOrderStatusSchema,
        amountFen: z.number().int().positive().max(10_000_000).optional(),
        contractId: identifierSchema.optional(),
        signingUrl: z.string().url().max(2048).optional(),
        signedAt: isoDateTimeSchema.optional(),
        contractAuthorizationMode: z.literal("external_wechat").optional(),
        contractAuthorizedAt: isoDateTimeSchema.optional(),
        provisioningReference: identifierSchema.optional(),
        message: z.string().trim().min(1).max(1000).optional(),
        retryable: z.boolean().optional(),
        updatedAt: isoDateTimeSchema,
      })
      .strict(),
    account: z
      .object({
        username: z.string().trim().min(1).max(64).optional(),
        displayName: z.string().trim().min(1).max(128).optional(),
        accountSetupUrl: z.string().url().max(2048).optional(),
        workspaceUrl: z.string().url().max(2048).optional(),
      })
      .strict()
      .optional(),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.account?.accountSetupUrl && value.order.status !== "active") {
      context.addIssue({
        code: "custom",
        path: ["account", "accountSetupUrl"],
        message: "accountSetupUrl is only valid for an active order",
      });
    }
  });

export type CreateManualServiceOrderRequest = z.infer<
  typeof createManualServiceOrderRequestSchema
>;
export type ManualServicePaymentRequest = z.infer<
  typeof manualServicePaymentRequestSchema
>;
export type ManualServiceAccountSetupRequest = z.infer<
  typeof manualServiceAccountSetupRequestSchema
>;
export type PrepareManualServiceOrder = z.infer<
  typeof prepareManualServiceOrderSchema
>;
export type ConfirmManualServiceOrderSigned = z.infer<
  typeof confirmManualServiceOrderSignedSchema
>;
export type AuthorizeExternalManualServiceContract = z.infer<
  typeof authorizeExternalManualServiceContractSchema
>;
export type ManualServiceOrderResponse = z.infer<
  typeof manualServiceOrderResponseSchema
>;
export type ManualServiceAccountTarget = z.infer<
  typeof manualServiceAccountTargetSchema
>;
export type ManualServiceContractProfile = z.infer<
  typeof manualServiceContractProfileSchema
>;
export type ManualServiceSignedArtifact = z.infer<typeof signedArtifactSchema>;
