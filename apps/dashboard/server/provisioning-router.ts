import { createHash, timingSafeEqual } from "node:crypto";
import express, { type Request, type Response } from "express";
import { z } from "zod";

import {
  ProvisioningError,
  provisionWebsiteUser,
  websiteProvisionRequestSchema,
  type ProvisionWebsiteUserInput,
  type ProvisionedWebsiteUser,
} from "./provisioning-service";
import {
  importWebsiteKnowledgeArtifact,
  KnowledgeImportError,
  websiteKnowledgeImportSchema,
  type WebsiteKnowledgeImport,
} from "./knowledge-import-service";
import {
  getWebsitePurchaseStatus,
  PurchaseProvisioningError,
  submitWebsitePurchase,
} from "./provisioning-v2-service";
import { WEBSITE_PROJECT_PHYSICAL_DELETE_ENABLED } from "./website-project-lifecycle";
import {
  createPaymentReceiptLedgerService,
  PaymentReceiptLedgerError,
  type PaymentReceiptLedgerService,
} from "./payment-receipt-ledger-service";
import {
  createProjectOrderRegistryService,
  ProjectOrderRegistryError,
  type ProjectOrderRegistryService,
} from "./project-order-registry-service";
import {
  createManualServiceOrderService,
  ManualServiceOrderError,
  type ManualServiceOrderService,
} from "./manual-service-order-service";
import {
  authorizeExternalManualServiceContractSchema,
  createManualServiceOrderRequestSchema,
  manualServiceAccountSetupRequestSchema,
  manualServicePaymentRequestSchema,
  type ManualServiceOrderResponse,
} from "../shared/manual-service-order";
import {
  paymentReceiptReadQuerySchema,
  paymentReceiptReadRequestSchema,
} from "../shared/payment-receipt";
import {
  projectOrderIntentCommitRequestSchema,
  projectOrderProjectIdSchema,
  projectOrderWriteRequestSchema,
} from "../shared/project-order-registry";
import type {
  WebsitePurchaseRequestV2,
  WebsitePurchaseResponseV2,
} from "../shared/provisioning-v2";

const PROVISIONING_TOKEN_HEADER = "x-frontmind-provisioning-token";
export const MARKET_EDITION_RESPONSE_HEADER =
  "x-frontmind-market-edition-response";
const PUBLIC_PLACEHOLDER_MARKERS = [
  "replace-with",
  "replace_with",
  "change-me",
  "change_me",
  "placeholder",
  "example",
  "your-token",
  "your_token",
];

type ProvisioningRouterOptions = {
  env?: NodeJS.ProcessEnv;
  provisionUser?: (
    input: ProvisionWebsiteUserInput,
  ) => Promise<ProvisionedWebsiteUser>;
  importKnowledge?: (input: {
    projectId: string;
    idempotencyKey: string;
    value: WebsiteKnowledgeImport;
  }) => Promise<{
    status: "completed";
    replayed: boolean;
    receiptId: string;
    snapshot: unknown;
  }>;
  submitPurchase?: (input: {
    idempotencyKey: string;
    request: WebsitePurchaseRequestV2;
    secret?: string;
  }) => Promise<WebsitePurchaseResponseV2>;
  readPurchase?: (input: {
    reference: string;
    secret?: string;
  }) => Promise<WebsitePurchaseResponseV2>;
  manualOrders?: ManualServiceOrderService;
  paymentReceipts?: PaymentReceiptLedgerService;
  projectOrders?: ProjectOrderRegistryService;
};

function tokenDigest(value: string) {
  return createHash("sha256").update(value, "utf8").digest();
}

export function isUsableProvisioningServiceToken(value: string | undefined) {
  const normalized = value?.trim() ?? "";
  const lower = normalized.toLowerCase();
  return (
    normalized.length >= 32 &&
    !PUBLIC_PLACEHOLDER_MARKERS.some((marker) => lower.includes(marker))
  );
}

export function isValidProvisioningServiceToken(
  provided: string | undefined,
  configured: string | undefined,
) {
  const expected = configured?.trim() ?? "";
  const candidate = provided?.trim() ?? "";
  const equal = timingSafeEqual(tokenDigest(candidate), tokenDigest(expected));
  return (
    isUsableProvisioningServiceToken(expected) && candidate.length > 0 && equal
  );
}

export function assertProvisioningConfigured(
  env: NodeJS.ProcessEnv = process.env,
) {
  if (
    !isUsableProvisioningServiceToken(env.FRONTMIND_PROVISIONING_SERVICE_TOKEN)
  ) {
    throw new Error(
      "FRONTMIND_PROVISIONING_SERVICE_TOKEN must be a unique random value with at least 32 characters",
    );
  }
}

function requestHeader(req: Request, name: string) {
  const value = req.headers[name];
  return Array.isArray(value) ? value[0] : value;
}

function marketEditionResponseRequested(req: Request) {
  return requestHeader(req, MARKET_EDITION_RESPONSE_HEADER)?.trim() === "1";
}

function purchaseResponseForRequest(
  req: Request,
  response: WebsitePurchaseResponseV2,
): WebsitePurchaseResponseV2 {
  if (marketEditionResponseRequested(req)) return response;
  const { marketEdition: _marketEdition, ...purchase } = response.purchase;
  return { ...response, purchase };
}

function manualOrderResponseForRequest(
  req: Request,
  response: ManualServiceOrderResponse,
): ManualServiceOrderResponse {
  if (marketEditionResponseRequested(req)) return response;
  const { marketEdition: _marketEdition, ...order } = response.order;
  return { ...response, order };
}

export function createProvisioningRouter(
  options: ProvisioningRouterOptions = {},
) {
  const env = options.env ?? process.env;
  const configuredToken = env.FRONTMIND_PROVISIONING_SERVICE_TOKEN;
  const provisionUser =
    options.provisionUser ??
    ((input: ProvisionWebsiteUserInput) =>
      provisionWebsiteUser(input, { requestHashKey: configuredToken }));
  const importKnowledge =
    options.importKnowledge ?? importWebsiteKnowledgeArtifact;
  const submitPurchase = options.submitPurchase ?? submitWebsitePurchase;
  const readPurchase = options.readPurchase ?? getWebsitePurchaseStatus;
  const manualOrders =
    options.manualOrders ??
    createManualServiceOrderService({ secret: configuredToken });
  const paymentReceipts =
    options.paymentReceipts ?? createPaymentReceiptLedgerService();
  const projectOrders =
    options.projectOrders ?? createProjectOrderRegistryService();
  const router = express.Router();

  router.use((req, res, next) => {
    res.setHeader("Cache-Control", "private, no-store");
    if (!isUsableProvisioningServiceToken(configuredToken)) {
      res.status(503).json({
        error: {
          code: "PROVISIONING_NOT_CONFIGURED",
          message: "Website account provisioning is unavailable",
        },
      });
      return;
    }
    if (
      !isValidProvisioningServiceToken(
        requestHeader(req, PROVISIONING_TOKEN_HEADER),
        configuredToken,
      )
    ) {
      res.status(401).json({
        error: { code: "INVALID_SERVICE_TOKEN", message: "Unauthorized" },
      });
      return;
    }
    next();
  });

  router.post(
    "/payment-receipts",
    express.json({ limit: "16kb", strict: true, type: "application/json" }),
    async (req, res) => {
      try {
        const result = await paymentReceipts.record(req.body);
        if (result.replayed) {
          res.setHeader("Idempotent-Replayed", "true");
        }
        res.status(result.replayed ? 200 : 201).json(result.response);
      } catch (error) {
        sendProvisioningError(res, error);
      }
    },
  );

  router.get("/payment-receipts/ready", async (_req, res) => {
    try {
      res.json(await paymentReceipts.ready());
    } catch (error) {
      sendProvisioningError(res, error);
    }
  });

  router.get("/payment-receipts/:orderId", async (req, res) => {
    try {
      const query = paymentReceiptReadQuerySchema.parse(req.query);
      const request = paymentReceiptReadRequestSchema.parse({
        orderId: req.params.orderId,
        ...query,
      });
      res.json(await paymentReceipts.read(request));
    } catch (error) {
      sendProvisioningError(res, error);
    }
  });

  router.put(
    "/project-orders/:orderId",
    express.json({ limit: "16kb", strict: true, type: "application/json" }),
    async (req, res) => {
      try {
        const request = projectOrderWriteRequestSchema.parse(req.body);
        if (request.order.orderId !== req.params.orderId) {
          res.status(400).json({
            error: {
              code: "INVALID_REQUEST",
              message: "Path orderId must match the request body",
            },
          });
          return;
        }
        const result = await projectOrders.record(request);
        if (result.replayed) {
          res.setHeader("Idempotent-Replayed", "true");
        }
        res.status(result.replayed ? 200 : 201).json(result.response);
      } catch (error) {
        sendProvisioningError(res, error);
      }
    },
  );

  router.post(
    "/project-order-intents/:intentOrderId/commit",
    express.json({ limit: "16kb", strict: true, type: "application/json" }),
    async (req, res) => {
      try {
        const request = projectOrderIntentCommitRequestSchema.parse(req.body);
        const result = await projectOrders.commitIntent(
          req.params.intentOrderId,
          request,
        );
        if (result.replayed) {
          res.setHeader("Idempotent-Replayed", "true");
        }
        res.status(result.replayed ? 200 : 201).json(result.response);
      } catch (error) {
        sendProvisioningError(res, error);
      }
    },
  );

  router.get("/project-orders/ready", async (_req, res) => {
    try {
      res.json(await projectOrders.ready());
    } catch (error) {
      sendProvisioningError(res, error);
    }
  });

  router.get("/project-orders/projects/:projectId", async (req, res) => {
    try {
      const projectId = projectOrderProjectIdSchema.parse(req.params.projectId);
      res.json(await projectOrders.readProject(projectId));
    } catch (error) {
      sendProvisioningError(res, error);
    }
  });

  router.delete("/project-orders/projects/:projectId", async (req, res) => {
    if (!WEBSITE_PROJECT_PHYSICAL_DELETE_ENABLED) {
      res.status(503).json({
        error: {
          code: "PROJECT_DELETE_DISABLED",
          message: "Website project physical deletion is not enabled",
        },
      });
      return;
    }
    try {
      const projectId = projectOrderProjectIdSchema.parse(req.params.projectId);
      const result = await projectOrders.deleteProject(projectId);
      if (result.replayed) {
        res.setHeader("Idempotent-Replayed", "true");
      }
      res.json(result.response);
    } catch (error) {
      sendProvisioningError(res, error);
    }
  });

  router.post(
    "/users",
    express.json({ limit: "32kb", strict: true, type: "application/json" }),
    async (req, res) => {
      try {
        const idempotencyKey = z
          .string()
          .trim()
          .min(16)
          .max(512)
          .parse(requestHeader(req, "idempotency-key"));
        const request = websiteProvisionRequestSchema.parse(req.body);
        const result = await provisionUser({ idempotencyKey, request });
        if (result.replayed) res.setHeader("Idempotent-Replayed", "true");
        res.status(result.replayed ? 200 : 201).json({
          provision: result.provision,
          user: result.user,
        });
      } catch (error) {
        sendProvisioningError(res, error);
      }
    },
  );

  router.post(
    "/manual-orders",
    express.json({ limit: "64kb", strict: true, type: "application/json" }),
    async (req, res) => {
      try {
        const idempotencyKey = z
          .string()
          .trim()
          .min(16)
          .max(512)
          .parse(requestHeader(req, "idempotency-key"));
        const request = createManualServiceOrderRequestSchema.parse(req.body);
        res.status(201).json(
          manualOrderResponseForRequest(
            req,
            await manualOrders.create({
              idempotencyKey,
              request,
              secret: configuredToken,
            }),
          ),
        );
      } catch (error) {
        sendProvisioningError(res, error);
      }
    },
  );

  router.get("/manual-orders/:reference/status", async (req, res) => {
    try {
      const reference = z
        .string()
        .trim()
        .min(4)
        .max(128)
        .parse(req.params.reference);
      res.json(
        manualOrderResponseForRequest(
          req,
          await manualOrders.status({
            reference,
            secret: configuredToken,
          }),
        ),
      );
    } catch (error) {
      sendProvisioningError(res, error);
    }
  });

  router.post(
    "/manual-orders/:reference/external-contract",
    express.json({ limit: "16kb", strict: true, type: "application/json" }),
    async (req, res) => {
      try {
        const reference = z
          .string()
          .trim()
          .min(4)
          .max(128)
          .parse(req.params.reference);
        const request = authorizeExternalManualServiceContractSchema.parse(
          req.body,
        );
        res.json(
          manualOrderResponseForRequest(
            req,
            await manualOrders.authorizeExternal({
              reference,
              request,
              secret: configuredToken,
            }),
          ),
        );
      } catch (error) {
        sendProvisioningError(res, error);
      }
    },
  );

  router.post(
    "/manual-orders/:reference/payment",
    express.json({ limit: "64kb", strict: true, type: "application/json" }),
    async (req, res) => {
      try {
        const reference = z
          .string()
          .trim()
          .min(4)
          .max(128)
          .parse(req.params.reference);
        const idempotencyKey = z
          .string()
          .trim()
          .min(16)
          .max(512)
          .parse(requestHeader(req, "idempotency-key"));
        const request = manualServicePaymentRequestSchema.parse(req.body);
        const result = await manualOrders.recordPayment({
          reference,
          idempotencyKey,
          request,
          secret: configuredToken,
        });
        res
          .status(result.order.status === "active" ? 200 : 202)
          .json(manualOrderResponseForRequest(req, result));
      } catch (error) {
        sendProvisioningError(res, error);
      }
    },
  );

  router.post(
    "/manual-orders/:reference/account",
    express.json({ limit: "32kb", strict: true, type: "application/json" }),
    async (req, res) => {
      try {
        const reference = z
          .string()
          .trim()
          .min(4)
          .max(128)
          .parse(req.params.reference);
        const idempotencyKey = z
          .string()
          .trim()
          .min(16)
          .max(512)
          .parse(requestHeader(req, "idempotency-key"));
        const request = manualServiceAccountSetupRequestSchema.parse(req.body);
        const result = await manualOrders.setupAccount({
          reference,
          idempotencyKey,
          request,
          secret: configuredToken,
        });
        res
          .status(result.order.status === "active" ? 200 : 202)
          .json(manualOrderResponseForRequest(req, result));
      } catch (error) {
        sendProvisioningError(res, error);
      }
    },
  );

  router.post(
    "/purchases",
    express.json({ limit: "64kb", strict: true, type: "application/json" }),
    async (req, res) => {
      try {
        const idempotencyKey = z
          .string()
          .trim()
          .min(16)
          .max(512)
          .parse(requestHeader(req, "idempotency-key"));
        const result = await submitPurchase({
          idempotencyKey,
          request: req.body,
          secret: configuredToken,
        });
        res
          .status(result.purchase.status === "pending_confirmation" ? 202 : 200)
          .json(purchaseResponseForRequest(req, result));
      } catch (error) {
        sendProvisioningError(res, error);
      }
    },
  );

  router.get("/purchases/:reference/status", async (req, res) => {
    try {
      const reference = z
        .string()
        .trim()
        .min(4)
        .max(128)
        .parse(req.params.reference);
      res.json(
        purchaseResponseForRequest(
          req,
          await readPurchase({
            reference,
            secret: configuredToken,
          }),
        ),
      );
    } catch (error) {
      sendProvisioningError(res, error);
    }
  });

  router.post(
    "/projects/:projectId/knowledge-imports",
    express.json({ limit: "64kb", strict: true, type: "application/json" }),
    async (req, res) => {
      try {
        const projectId = z
          .string()
          .trim()
          .min(8)
          .max(80)
          .parse(req.params.projectId);
        const idempotencyKey = z
          .string()
          .trim()
          .min(16)
          .max(512)
          .parse(requestHeader(req, "idempotency-key"));
        const value = websiteKnowledgeImportSchema.parse(req.body);
        const result = await importKnowledge({
          projectId,
          idempotencyKey,
          value,
        });
        if (result.replayed) {
          res.setHeader("Idempotent-Replayed", "true");
        }
        const configuredWorkspaceUrl =
          process.env.FRONTMIND_PUBLIC_URL?.trim().replace(/\/$/, "");
        res.status(result.replayed ? 200 : 201).json({
          schemaVersion: value.schemaVersion,
          knowledgeImport: {
            id: result.receiptId,
            projectId,
            status: "ready",
            updatedAt: new Date().toISOString(),
            retryable: false,
            ...(configuredWorkspaceUrl
              ? { workspaceUrl: `${configuredWorkspaceUrl}/` }
              : {}),
          },
        });
      } catch (error) {
        sendProvisioningError(res, error);
      }
    },
  );

  return router;
}

function sendProvisioningError(res: Response, error: unknown) {
  const databaseError = error as
    | { message?: unknown; sqlMessage?: unknown }
    | null
    | undefined;
  if (
    [databaseError?.message, databaseError?.sqlMessage].some((message) =>
      String(message ?? "").includes("WEBSITE_PROJECT_DELETED"),
    )
  ) {
    res.status(410).json({
      error: {
        code: "PROJECT_DELETED",
        message: "项目已进入永久删除流程，不能再写入履约记录",
      },
    });
    return;
  }
  if (error instanceof z.ZodError) {
    res.status(400).json({
      error: {
        code: "INVALID_REQUEST",
        message: error.issues[0]?.message ?? "Invalid request",
      },
    });
    return;
  }
  if (error instanceof ProvisioningError) {
    if (error.retryAfterMs) {
      res.setHeader(
        "Retry-After",
        String(Math.ceil(error.retryAfterMs / 1000)),
      );
    }
    res.status(error.status).json({
      error: { code: error.code, message: error.message },
    });
    return;
  }
  if (error instanceof KnowledgeImportError) {
    if (error.retryAfterMs) {
      res.setHeader(
        "Retry-After",
        String(Math.ceil(error.retryAfterMs / 1000)),
      );
    }
    res.status(error.status).json({
      error: { code: error.code, message: error.message },
    });
    return;
  }
  if (error instanceof PurchaseProvisioningError) {
    res.status(error.status).json({
      error: { code: error.code, message: error.message },
    });
    return;
  }
  if (error instanceof ManualServiceOrderError) {
    res.status(error.status).json({
      error: { code: error.code, message: error.message },
    });
    return;
  }
  if (error instanceof PaymentReceiptLedgerError) {
    res.status(error.status).json({
      error: { code: error.code, message: error.message },
    });
    return;
  }
  if (error instanceof ProjectOrderRegistryError) {
    res.status(error.status).json({
      error: { code: error.code, message: error.message },
    });
    return;
  }
  console.error(
    "[Provisioning] Request failed:",
    error instanceof Error ? error.message.slice(0, 300) : "Unknown error",
  );
  res.status(500).json({
    error: {
      code: "INTERNAL_SERVER_ERROR",
      message: "The account could not be provisioned",
    },
  });
}

export default createProvisioningRouter();
