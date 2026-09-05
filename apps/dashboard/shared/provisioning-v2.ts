import { z } from "zod";

const serviceCategorySchema = z.enum([
  "product_scenario",
  "reputation",
  "competitor_comparison",
]);
const isoDateTimeSchema = z.string().datetime({ offset: true });
const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/i);
const identifierSchema = z.string().trim().min(4).max(128);
const purchaseContractBaseShape = {
  status: z.literal("pending_admin_confirmation"),
  projectId: z.string().trim().min(8).max(80),
  orderId: z.string().trim().min(8).max(64),
  questionId: z.string().trim().min(4).max(80),
  templateVersion: z.string().trim().min(1).max(64),
};

export const websitePurchaseRequestV2Schema = z
  .object({
    schemaVersion: z.literal(2),
    project: z
      .object({
        id: z.string().trim().min(8).max(80),
        companyName: z.string().trim().min(1).max(200),
      })
      .strict(),
    order: z
      .object({
        id: z.string().trim().min(8).max(64),
        tradeNo: z.string().trim().min(1).max(128),
        status: z.literal("paid"),
        amountFen: z.number().int().positive().max(10_000_000),
        paidAt: isoDateTimeSchema,
      })
      .strict(),
    service: z
      .object({
        planCode: z.literal("basic"),
        serviceDays: z.literal(30),
        startsAt: isoDateTimeSchema,
        endsAt: isoDateTimeSchema,
        purchasedQuestion: z
          .object({
            id: z.string().trim().min(4).max(80),
            category: serviceCategorySchema,
            question: z.string().trim().min(4).max(500),
          })
          .strict(),
      })
      .strict(),
    contract: z.union([
      z
        .object({
          ...purchaseContractBaseShape,
          id: identifierSchema,
          evidence: z
            .object({
              type: z.literal("system_admin_confirmation"),
              artifact: z
                .object({
                  taskId: z.string().trim().min(1).max(128).nullable(),
                  fileId: z.string().trim().min(1).max(128).nullable(),
                  outputDescriptor: z
                    .string()
                    .trim()
                    .min(1)
                    .max(500)
                    .nullable(),
                  sha256: sha256Schema.nullable(),
                })
                .strict(),
            })
            .strict(),
        })
        .strict(),
      z
        .object({
          ...purchaseContractBaseShape,
          evidence: z
            .object({
              type: z.literal("external_wechat_confirmation"),
              eventReference: identifierSchema,
              authorizedAt: isoDateTimeSchema,
            })
            .strict(),
        })
        .strict(),
    ]),
    account: z.discriminatedUnion("mode", [
      z
        .object({
          mode: z.literal("create"),
          username: z
            .string()
            .trim()
            .min(3)
            .max(64)
            .regex(/^[a-zA-Z0-9._-]+$/),
          displayName: z.string().trim().min(2).max(128),
        })
        .strict(),
      z
        .object({
          mode: z.literal("bind_existing"),
          purchaseIntent: z.string().trim().min(16).max(4096),
        })
        .strict(),
    ]),
  })
  .strict()
  .superRefine((value, context) => {
    const expectedDuration = 30 * 24 * 60 * 60 * 1000;
    if (
      Date.parse(value.service.endsAt) - Date.parse(value.service.startsAt) !==
      expectedDuration
    ) {
      context.addIssue({
        code: "custom",
        path: ["service", "endsAt"],
        message: "basic service must cover exactly 30 days",
      });
    }
    const checks: Array<[boolean, (string | number)[], string]> = [
      [
        value.contract.projectId === value.project.id,
        ["contract", "projectId"],
        "contract projectId must match project.id",
      ],
      [
        value.contract.orderId === value.order.id,
        ["contract", "orderId"],
        "contract orderId must match order.id",
      ],
      [
        value.contract.questionId === value.service.purchasedQuestion.id,
        ["contract", "questionId"],
        "contract questionId must match purchased question",
      ],
      [
        value.service.startsAt === value.order.paidAt,
        ["service", "startsAt"],
        "service startsAt must match order paidAt",
      ],
    ];
    for (const [valid, path, message] of checks) {
      if (!valid) context.addIssue({ code: "custom", path, message });
    }
    if (
      value.contract.evidence.type === "external_wechat_confirmation" &&
      Date.parse(value.order.paidAt) <=
        Date.parse(value.contract.evidence.authorizedAt)
    ) {
      context.addIssue({
        code: "custom",
        path: ["order", "paidAt"],
        message:
          "order paidAt must be later than external contract authorizedAt",
      });
    }
  });

export type WebsitePurchaseRequestV2 = z.infer<
  typeof websitePurchaseRequestV2Schema
>;

const purchaseStatusSchema = z.enum([
  "pending_confirmation",
  "provisioned",
  "failed",
]);

export const websitePurchaseResponseV2Schema = z
  .object({
    schemaVersion: z.literal(2),
    purchase: z
      .object({
        reference: identifierSchema,
        projectId: z.string().trim().min(8).max(80),
        orderId: z.string().trim().min(8).max(64),
        status: purchaseStatusSchema,
        updatedAt: isoDateTimeSchema,
        retryable: z.boolean().optional(),
        message: z.string().trim().min(1).max(1000).optional(),
        errorCode: z.string().trim().min(1).max(128).optional(),
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
    if (
      value.account?.accountSetupUrl &&
      value.purchase.status !== "provisioned"
    ) {
      context.addIssue({
        code: "custom",
        path: ["account", "accountSetupUrl"],
        message: "accountSetupUrl is only valid after provisioning",
      });
    }
  });

export type WebsitePurchaseResponseV2 = z.infer<
  typeof websitePurchaseResponseV2Schema
>;
