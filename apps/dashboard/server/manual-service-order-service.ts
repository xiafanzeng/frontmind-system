import {
  createHash,
  createHmac,
  randomUUID,
  timingSafeEqual,
} from "node:crypto";
import { desc, eq } from "drizzle-orm";

import { websiteManualServiceOrders } from "../drizzle/schema";
import {
  authorizeExternalManualServiceContractSchema,
  confirmManualServiceOrderSignedSchema,
  createManualServiceOrderRequestSchema,
  manualServiceAccountSetupRequestSchema,
  manualServiceOrderResponseSchema,
  manualServicePaymentRequestSchema,
  prepareManualServiceOrderSchema,
  type AuthorizeExternalManualServiceContract,
  type ConfirmManualServiceOrderSigned,
  type CreateManualServiceOrderRequest,
  type ManualServiceAccountSetupRequest,
  type ManualServiceOrderResponse,
  type ManualServicePaymentRequest,
  type ManualServiceSignedArtifact,
  type PrepareManualServiceOrder,
} from "../shared/manual-service-order";
import {
  hashPassword,
  isSupportedPasswordHash,
  normalizeUsername,
} from "./auth-service";
import { getDb } from "./db";
import {
  decideWebsitePurchase,
  getWebsitePurchaseStatus,
  setupWebsiteAccountPassword,
  submitWebsitePurchase,
} from "./provisioning-v2-service";
import {
  lockActiveWebsiteProjectLifecycle,
  WebsiteProjectInactiveError,
} from "./website-project-lifecycle";

export type ManualServiceOrderRecord =
  typeof websiteManualServiceOrders.$inferSelect;
type ManualOrderRow = ManualServiceOrderRecord;
type ManualOrderInsert = typeof websiteManualServiceOrders.$inferInsert;
type ManualOrderPatch = Partial<
  Omit<ManualOrderInsert, "id" | "createdAt" | "idempotencyKeyHash">
>;

export type ManualServiceOrderErrorCode =
  | "MANUAL_ORDER_NOT_FOUND"
  | "MANUAL_ORDER_STATE_CONFLICT"
  | "MANUAL_ORDER_SCOPE_MISMATCH"
  | "MANUAL_ORDER_IDEMPOTENCY_CONFLICT"
  | "MANUAL_ORDER_PROJECT_DELETED"
  | "MANUAL_ORDER_DATABASE_UNAVAILABLE"
  | "MANUAL_ORDER_PROVISIONING_NOT_CONFIGURED";

export class ManualServiceOrderError extends Error {
  constructor(
    public readonly code: ManualServiceOrderErrorCode,
    message: string,
    public readonly status: number,
  ) {
    super(message);
    this.name = "ManualServiceOrderError";
  }
}

export interface ManualServiceOrderRepository {
  find(reference: string): Promise<ManualOrderRow | undefined>;
  findByCreateKey(keyHash: string): Promise<ManualOrderRow | undefined>;
  insert(value: ManualOrderInsert): Promise<ManualOrderRow>;
  list(): Promise<ManualOrderRow[]>;
  mutate(
    reference: string,
    mutation: (
      current: ManualOrderRow,
      executor?: any,
    ) => Promise<ManualOrderPatch | null> | ManualOrderPatch | null,
  ): Promise<ManualOrderRow>;
}

async function lockActiveManualOrderProject(tx: any, projectId: string) {
  try {
    await lockActiveWebsiteProjectLifecycle(tx, projectId);
  } catch (error) {
    if (!(error instanceof WebsiteProjectInactiveError)) throw error;
    throw new ManualServiceOrderError(
      "MANUAL_ORDER_PROJECT_DELETED",
      "The project has been permanently deleted",
      410,
    );
  }
}

type PurchaseResponse = Awaited<ReturnType<typeof submitWebsitePurchase>>;

export type ManualServiceOrderServiceOptions = {
  repository?: ManualServiceOrderRepository;
  secret?: string;
  now?: () => Date;
  submitPurchase?: typeof submitWebsitePurchase;
  readPurchase?: typeof getWebsitePurchaseStatus;
  decidePurchase?: typeof decideWebsitePurchase;
  setupPurchasePassword?: typeof setupWebsiteAccountPassword;
  hashCustomerPassword?: typeof hashPassword;
};

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value) ?? "null";
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(",")}]`;
  }
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .filter((key) => record[key] !== undefined)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
    .join(",")}}`;
}

function sha256(value: string) {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function hmac(value: unknown, secret: string) {
  return createHmac("sha256", secret)
    .update(canonicalJson(value), "utf8")
    .digest("hex");
}

function safeHashEqual(left: string, right: string) {
  const leftBuffer = Buffer.from(left, "hex");
  const rightBuffer = Buffer.from(right, "hex");
  return (
    leftBuffer.length === rightBuffer.length &&
    timingSafeEqual(leftBuffer, rightBuffer)
  );
}

function storedManualCreateHashMatches(
  row: Pick<ManualOrderRow, "requestHash" | "marketEdition">,
  value: CreateManualServiceOrderRequest,
  secret: string,
) {
  if (safeHashEqual(row.requestHash, hmac(value, secret))) return true;
  if (
    row.marketEdition !== "domestic" ||
    (value.marketEdition !== undefined && value.marketEdition !== "domestic")
  ) {
    return false;
  }
  const alternateRequest: CreateManualServiceOrderRequest =
    value.marketEdition === undefined
      ? { ...value, marketEdition: "domestic" }
      : (({ marketEdition: _marketEdition, ...legacyRequest }) =>
          legacyRequest)(value);
  return safeHashEqual(row.requestHash, hmac(alternateRequest, secret));
}

function configuredSecret(explicit?: string) {
  const value =
    explicit?.trim() ||
    process.env.FRONTMIND_PROVISIONING_SERVICE_TOKEN?.trim() ||
    "";
  if (value.length < 32) {
    throw new ManualServiceOrderError(
      "MANUAL_ORDER_PROVISIONING_NOT_CONFIGURED",
      "Website manual service orders are unavailable",
      503,
    );
  }
  return value;
}

function stateConflict(message: string): never {
  throw new ManualServiceOrderError(
    "MANUAL_ORDER_STATE_CONFLICT",
    message,
    409,
  );
}

function scopeMismatch(message: string): never {
  throw new ManualServiceOrderError(
    "MANUAL_ORDER_SCOPE_MISMATCH",
    message,
    409,
  );
}

function sameText(left: string | null, right: string) {
  return (left || "") === right;
}

function sameDate(left: Date | null, right: string | number) {
  return Boolean(left) && left!.getTime() === new Date(right).getTime();
}

function databaseTimestamp(value: string | number | Date) {
  const timestamp = new Date(value).getTime();
  return new Date(Math.floor(timestamp / 1000) * 1000);
}

function sameArtifact(
  row: ManualOrderRow,
  artifact: ManualServiceSignedArtifact,
  kind: "pdf" | "report",
) {
  return kind === "pdf"
    ? sameText(row.signedPdfFileId, artifact.fileId) &&
        sameText(row.signedPdfFilename, artifact.filename) &&
        sameText(row.signedPdfSha256, artifact.sha256.toLowerCase())
    : sameText(row.evidenceReportFileId, artifact.fileId) &&
        sameText(row.evidenceReportFilename, artifact.filename) &&
        sameText(row.evidenceReportSha256, artifact.sha256.toLowerCase());
}

function completeSigningEvidence(row: ManualOrderRow) {
  return Boolean(
    row.externalContractId &&
      row.signingUrl &&
      row.signedPdfFileId &&
      row.signedPdfFilename &&
      /^[a-f0-9]{64}$/i.test(row.signedPdfSha256 || "") &&
      row.signedAt &&
      row.signatoryId &&
      row.signatureNote,
  );
}

function completeExternalContractAuthorization(row: ManualOrderRow) {
  return Boolean(
    row.contractAuthorizationMode === "external_wechat" &&
      row.contractAuthorizationEventReference &&
      row.contractAuthorizedAt,
  );
}

function completeContractEvidence(row: ManualOrderRow) {
  return (
    completeSigningEvidence(row) || completeExternalContractAuthorization(row)
  );
}

function contractEvidenceAt(row: ManualOrderRow) {
  return completeExternalContractAuthorization(row)
    ? row.contractAuthorizedAt
    : row.signedAt;
}

function completePayment(row: ManualOrderRow) {
  return Boolean(
    row.paymentOrderId &&
      row.paymentTradeNo &&
      row.paidAt &&
      row.paymentRequestHash &&
      Number.isInteger(row.amountFen) &&
      (row.amountFen ?? 0) > 0,
  );
}

function completeAccountSetup(row: ManualOrderRow) {
  return Boolean(
    row.accountSetupIdempotencyKeyHash &&
      row.accountSetupRequestHash &&
      row.accountMode &&
      row.requestedUsername &&
      row.requestedDisplayName &&
      row.provisioningReference &&
      (row.accountMode === "bind_existing" ||
        (row.requestedPasswordHash &&
          isSupportedPasswordHash(row.requestedPasswordHash))),
  );
}

function publicMessage(row: ManualOrderRow) {
  switch (row.status) {
    case "pending_admin":
      return "签约资料已提交，等待管理员发起电子签署";
    case "signature_required":
      return "合同已准备，请通过安全签署链接完成电子签署";
    case "payment_required":
      return completeExternalContractAuthorization(row)
        ? "合同已在企业微信确认，可以付款"
        : "管理员已核验签署文件，请完成服务付款";
    case "account_setup_required":
      return "付款已确认，请设置用于登录服务看板的账号和密码";
    case "activation_required":
      return "账号资料已提交，正在自动开通服务";
    case "active":
      return "服务账号与普通版权益已开通";
    case "rejected":
      return row.lastError || "该服务订单已被管理员拒绝";
    case "failed":
      return row.lastError || "服务订单处理失败";
  }
}

function retryable(row: ManualOrderRow) {
  if (row.status === "failed") return true;
  if (row.status === "rejected") return false;
  return undefined;
}

function buildResponse(
  row: ManualOrderRow,
  purchase?: PurchaseResponse,
): ManualServiceOrderResponse {
  const activePurchase =
    row.status === "active" && purchase?.purchase.status === "provisioned"
      ? purchase
      : undefined;
  const account = {
    ...(row.requestedUsername
      ? { username: row.requestedUsername }
      : purchase?.account?.username
        ? { username: purchase.account.username }
        : {}),
    ...(row.requestedDisplayName
      ? { displayName: row.requestedDisplayName }
      : purchase?.account?.displayName
        ? { displayName: purchase.account.displayName }
        : {}),
    ...(activePurchase?.account?.workspaceUrl
      ? { workspaceUrl: activePurchase.account.workspaceUrl }
      : {}),
  };
  return manualServiceOrderResponseSchema.parse({
    schemaVersion: 1,
    order: {
      reference: row.id,
      projectId: row.projectId,
      status: row.status,
      marketEdition: row.marketEdition,
      ...(Number.isInteger(row.amountFen) && (row.amountFen ?? 0) > 0
        ? { amountFen: row.amountFen! }
        : {}),
      ...(row.externalContractId ? { contractId: row.externalContractId } : {}),
      ...(row.signingUrl ? { signingUrl: row.signingUrl } : {}),
      ...(row.signedAt ? { signedAt: row.signedAt.toISOString() } : {}),
      ...(completeExternalContractAuthorization(row)
        ? {
            contractAuthorizationMode: "external_wechat" as const,
            contractAuthorizedAt: row.contractAuthorizedAt!.toISOString(),
          }
        : {}),
      ...(row.provisioningReference
        ? { provisioningReference: row.provisioningReference }
        : {}),
      message: publicMessage(row),
      ...(retryable(row) === undefined ? {} : { retryable: retryable(row) }),
      updatedAt: row.updatedAt.toISOString(),
    },
    ...(Object.keys(account).length ? { account } : {}),
  });
}

async function defaultRepository(): Promise<ManualServiceOrderRepository> {
  const db = await getDb();
  if (!db) {
    throw new ManualServiceOrderError(
      "MANUAL_ORDER_DATABASE_UNAVAILABLE",
      "The manual service order database is unavailable",
      503,
    );
  }
  const find = async (reference: string) => {
    const rows = await db
      .select()
      .from(websiteManualServiceOrders)
      .where(eq(websiteManualServiceOrders.id, reference))
      .limit(1);
    return rows[0];
  };
  return {
    find,
    async findByCreateKey(keyHash) {
      const rows = await db
        .select()
        .from(websiteManualServiceOrders)
        .where(eq(websiteManualServiceOrders.idempotencyKeyHash, keyHash))
        .limit(1);
      return rows[0];
    },
    async insert(value) {
      return db.transaction(async (tx) => {
        await lockActiveManualOrderProject(tx, value.projectId);
        await tx.insert(websiteManualServiceOrders).values(value);
        const rows = await tx
          .select()
          .from(websiteManualServiceOrders)
          .where(eq(websiteManualServiceOrders.id, value.id))
          .limit(1);
        if (!rows[0]) {
          throw new ManualServiceOrderError(
            "MANUAL_ORDER_NOT_FOUND",
            "Manual service order was not persisted",
            500,
          );
        }
        return rows[0];
      });
    },
    async list() {
      return db
        .select()
        .from(websiteManualServiceOrders)
        .orderBy(desc(websiteManualServiceOrders.createdAt));
    },
    async mutate(reference, mutation) {
      const binding = await find(reference);
      if (!binding) {
        throw new ManualServiceOrderError(
          "MANUAL_ORDER_NOT_FOUND",
          "Manual service order not found",
          404,
        );
      }
      return db.transaction(async (tx) => {
        await lockActiveManualOrderProject(tx, binding.projectId);
        const rows = await tx
          .select()
          .from(websiteManualServiceOrders)
          .where(eq(websiteManualServiceOrders.id, reference))
          .limit(1)
          .for("update");
        const current = rows[0];
        if (!current) {
          throw new ManualServiceOrderError(
            "MANUAL_ORDER_NOT_FOUND",
            "Manual service order not found",
            404,
          );
        }
        if (binding.projectId !== current.projectId) {
          throw new ManualServiceOrderError(
            "MANUAL_ORDER_STATE_CONFLICT",
            "Manual service order project binding changed; retry the operation",
            409,
          );
        }
        const patch = await mutation(current, tx);
        if (patch) {
          await tx
            .update(websiteManualServiceOrders)
            .set(patch)
            .where(eq(websiteManualServiceOrders.id, reference));
        }
        const updated = await tx
          .select()
          .from(websiteManualServiceOrders)
          .where(eq(websiteManualServiceOrders.id, reference))
          .limit(1);
        return updated[0]!;
      });
    },
  };
}

function normalizeSigningUrl(value: string) {
  return new URL(value).toString();
}

function paymentMatches(
  row: ManualOrderRow,
  input: ManualServicePaymentRequest,
  secret: string,
) {
  const requestHash = hmac(input, secret);
  return (
    sameText(row.paymentOrderId, input.payment.orderId) &&
    sameText(row.paymentTradeNo, input.payment.tradeNo) &&
    row.amountFen === input.payment.amountFen &&
    sameDate(row.paidAt, databaseTimestamp(input.payment.paidAt).getTime()) &&
    Boolean(row.paymentRequestHash) &&
    safeHashEqual(row.paymentRequestHash!, requestHash)
  );
}

export function createManualServiceOrderService(
  options: ManualServiceOrderServiceOptions = {},
) {
  const now = options.now ?? (() => new Date());
  const submitPurchase = options.submitPurchase ?? submitWebsitePurchase;
  const readPurchase = options.readPurchase ?? getWebsitePurchaseStatus;
  const decidePurchase = options.decidePurchase ?? decideWebsitePurchase;
  const setupPurchasePassword =
    options.setupPurchasePassword ?? setupWebsiteAccountPassword;
  const hashCustomerPassword = options.hashCustomerPassword ?? hashPassword;
  const repository = async () => options.repository ?? defaultRepository();

  const readResponse = async (
    row: ManualOrderRow,
    secret: string,
    knownPurchase?: PurchaseResponse,
  ) => {
    const purchase =
      knownPurchase ??
      (row.provisioningReference
        ? await readPurchase({
            reference: row.provisioningReference,
            secret,
          })
        : undefined);
    return buildResponse(row, purchase);
  };

  const activatePersistedAccount = async (input: {
    reference: string;
    secret: string;
    actorUserId?: number;
  }) => {
    let purchase: PurchaseResponse | undefined;
    const row = await (
      await repository()
    ).mutate(input.reference, async (current, executor) => {
      if (current.status === "active") {
        purchase = current.provisioningReference
          ? await readPurchase({
              reference: current.provisioningReference,
              secret: input.secret,
            })
          : undefined;
        return null;
      }
      const actorUserId = input.actorUserId ?? current.signedByUserId;
      const externallyAuthorized =
        completeExternalContractAuthorization(current);
      if (
        current.status !== "activation_required" ||
        !completeContractEvidence(current) ||
        !completePayment(current) ||
        !completeAccountSetup(current) ||
        (!externallyAuthorized &&
          (!Number.isInteger(actorUserId) || !actorUserId))
      ) {
        return stateConflict(
          "Contract evidence, verified payment, and customer account details are required before activation",
        );
      }
      purchase = await decidePurchase({
        reference: current.provisioningReference!,
        manualOrderReference: current.id,
        ...(actorUserId ? { actorUserId } : {}),
        decision: "confirm",
        ...(externallyAuthorized
          ? {}
          : {
              signedAt: current.signedAt!,
              signatoryId: current.signatoryId!,
              note: current.signatureNote!,
            }),
        ...(current.accountMode === "create"
          ? { manualPasswordHash: current.requestedPasswordHash! }
          : {}),
        secret: input.secret,
        executor,
      });
      if (purchase.purchase.status !== "provisioned") {
        return stateConflict(
          "The provisioning ledger did not complete account activation",
        );
      }
      const activatedAt = now();
      return {
        status: "active",
        requestedPasswordHash: null,
        activatedByUserId: actorUserId ?? null,
        activatedAt,
        lastError: null,
        revision: current.revision + 1,
        updatedAt: activatedAt,
      };
    });
    return readResponse(row, input.secret, purchase);
  };

  return {
    async create(input: {
      idempotencyKey: string;
      request: CreateManualServiceOrderRequest;
      secret?: string;
    }) {
      const value = createManualServiceOrderRequestSchema.parse(input.request);
      const secret = configuredSecret(input.secret ?? options.secret);
      const keyHash = sha256(input.idempotencyKey.trim());
      const requestHash = hmac(value, secret);
      const repo = await repository();
      const existing = await repo.findByCreateKey(keyHash);
      if (existing) {
        if (!storedManualCreateHashMatches(existing, value, secret)) {
          throw new ManualServiceOrderError(
            "MANUAL_ORDER_IDEMPOTENCY_CONFLICT",
            "The idempotency key has already been used for another manual order",
            409,
          );
        }
        return readResponse(existing, secret);
      }
      const createdAt = now();
      const row: ManualOrderInsert = {
        id: randomUUID(),
        schemaVersion: 1,
        idempotencyKeyHash: keyHash,
        requestHash,
        projectId: value.project.id,
        companyName: value.project.companyName,
        marketEdition: value.marketEdition ?? "domestic",
        contractProfile: value.contract.profile,
        serviceCategory: value.service.purchasedQuestion.category,
        planCode: "basic",
        serviceDays: 30,
        questionId: value.service.purchasedQuestion.id,
        question: value.service.purchasedQuestion.question,
        // The commercial amount is established only by the verified payment
        // event; an unpaid order has no amount in the durable record.
        amountFen: null,
        contractTemplateVersion: value.contract.templateVersion,
        status: "pending_admin",
        revision: 1,
        createdAt,
        updatedAt: createdAt,
      };
      try {
        return readResponse(await repo.insert(row), secret);
      } catch (error) {
        const replay = await repo.findByCreateKey(keyHash);
        if (replay && storedManualCreateHashMatches(replay, value, secret)) {
          return readResponse(replay, secret);
        }
        throw error;
      }
    },

    async status(input: { reference: string; secret?: string }) {
      const secret = configuredSecret(input.secret ?? options.secret);
      const row = await (await repository()).find(input.reference);
      if (!row) {
        throw new ManualServiceOrderError(
          "MANUAL_ORDER_NOT_FOUND",
          "Manual service order not found",
          404,
        );
      }
      return readResponse(row, secret);
    },

    async list() {
      return (await (await repository()).list()).map((row) => ({
        reference: row.id,
        projectId: row.projectId,
        companyName: row.companyName,
        contractProfile: row.contractProfile,
        category: row.serviceCategory,
        planCode: row.planCode,
        serviceDays: row.serviceDays,
        marketEdition: row.marketEdition,
        questionId: row.questionId,
        question: row.question,
        contractTemplateVersion: row.contractTemplateVersion,
        contractId: row.externalContractId,
        signingUrl: row.signingUrl,
        signedPdf:
          row.signedPdfFileId && row.signedPdfFilename && row.signedPdfSha256
            ? {
                fileId: row.signedPdfFileId,
                filename: row.signedPdfFilename,
                sha256: row.signedPdfSha256,
              }
            : null,
        evidenceReport:
          row.evidenceReportFileId &&
          row.evidenceReportFilename &&
          row.evidenceReportSha256
            ? {
                fileId: row.evidenceReportFileId,
                filename: row.evidenceReportFilename,
                sha256: row.evidenceReportSha256,
              }
            : null,
        signedAt: row.signedAt?.getTime() ?? null,
        contractAuthorizationMode: row.contractAuthorizationMode,
        contractAuthorizationEventReference:
          row.contractAuthorizationEventReference,
        contractAuthorizedAt: row.contractAuthorizedAt?.getTime() ?? null,
        signatoryId: row.signatoryId,
        signatureNote: row.signatureNote,
        payment:
          row.paymentOrderId && row.paymentTradeNo && row.paidAt
            ? {
                orderId: row.paymentOrderId,
                tradeNo: row.paymentTradeNo,
                amountFen: row.amountFen,
                paidAt: row.paidAt.getTime(),
              }
            : null,
        accountMode: row.accountMode,
        requestedUsername: row.requestedUsername,
        requestedDisplayName: row.requestedDisplayName,
        provisioningReference: row.provisioningReference,
        status: row.status,
        message: publicMessage(row),
        revision: row.revision,
        preparedAt: row.preparedAt?.getTime() ?? null,
        accountSetupAt: row.accountSetupAt?.getTime() ?? null,
        activatedAt: row.activatedAt?.getTime() ?? null,
        rejectedAt: row.rejectedAt?.getTime() ?? null,
        createdAt: row.createdAt.getTime(),
        updatedAt: row.updatedAt.getTime(),
      }));
    },

    async prepare(input: PrepareManualServiceOrder & { actorUserId: number }) {
      const parsed = prepareManualServiceOrderSchema.parse({
        reference: input.reference,
        contractId: input.contractId,
        signingUrl: input.signingUrl,
      });
      const preparedAt = now();
      const signingUrl = normalizeSigningUrl(parsed.signingUrl);
      const row = await (
        await repository()
      ).mutate(parsed.reference, (current) => {
        if (
          current.status === "signature_required" ||
          current.status === "payment_required" ||
          current.status === "account_setup_required" ||
          current.status === "activation_required" ||
          current.status === "active"
        ) {
          if (
            sameText(current.externalContractId, parsed.contractId) &&
            sameText(current.signingUrl, signingUrl)
          ) {
            return null;
          }
          return stateConflict(
            "The manual order has already been prepared with different signing details",
          );
        }
        if (current.status !== "pending_admin") {
          return stateConflict(
            "Only a pending manual order can be prepared for signing",
          );
        }
        return {
          externalContractId: parsed.contractId,
          signingUrl,
          status: "signature_required",
          preparedByUserId: input.actorUserId,
          preparedAt,
          lastError: null,
          revision: current.revision + 1,
          updatedAt: preparedAt,
        };
      });
      return readResponse(row, configuredSecret(options.secret));
    },

    async confirmSigned(
      input: ConfirmManualServiceOrderSigned & { actorUserId: number },
    ) {
      const parsed = confirmManualServiceOrderSignedSchema.parse({
        reference: input.reference,
        signedPdf: input.signedPdf,
        evidenceReport: input.evidenceReport,
        signedAt: input.signedAt,
        signatoryId: input.signatoryId,
        note: input.note,
      });
      const signedAt = databaseTimestamp(parsed.signedAt);
      const updatedAt = now();
      if (signedAt.getTime() > updatedAt.getTime() + 5 * 60 * 1000) {
        scopeMismatch("The signedAt timestamp cannot be in the future");
      }
      const row = await (
        await repository()
      ).mutate(parsed.reference, (current) => {
        if (
          current.status === "payment_required" ||
          current.status === "account_setup_required" ||
          current.status === "activation_required" ||
          current.status === "active"
        ) {
          const sameReport = parsed.evidenceReport
            ? sameArtifact(current, parsed.evidenceReport, "report")
            : !current.evidenceReportFileId &&
              !current.evidenceReportFilename &&
              !current.evidenceReportSha256;
          if (
            sameArtifact(current, parsed.signedPdf, "pdf") &&
            sameReport &&
            sameDate(current.signedAt, signedAt.getTime()) &&
            sameText(current.signatoryId, parsed.signatoryId) &&
            sameText(current.signatureNote, parsed.note)
          ) {
            return null;
          }
          return stateConflict(
            "The signed contract has already been confirmed with different evidence",
          );
        }
        if (
          current.status !== "signature_required" ||
          !current.externalContractId ||
          !current.signingUrl
        ) {
          return stateConflict(
            "The administrator must prepare signing before confirming a signed contract",
          );
        }
        return {
          signedPdfFileId: parsed.signedPdf.fileId,
          signedPdfFilename: parsed.signedPdf.filename,
          signedPdfSha256: parsed.signedPdf.sha256.toLowerCase(),
          evidenceReportFileId: parsed.evidenceReport?.fileId ?? null,
          evidenceReportFilename: parsed.evidenceReport?.filename ?? null,
          evidenceReportSha256:
            parsed.evidenceReport?.sha256.toLowerCase() ?? null,
          signedAt,
          signatoryId: parsed.signatoryId,
          signatureNote: parsed.note,
          signedByUserId: input.actorUserId,
          status: "payment_required",
          lastError: null,
          revision: current.revision + 1,
          updatedAt,
        };
      });
      return readResponse(row, configuredSecret(options.secret));
    },

    async authorizeExternal(input: {
      reference: string;
      request: AuthorizeExternalManualServiceContract;
      secret?: string;
    }) {
      const value = authorizeExternalManualServiceContractSchema.parse(
        input.request,
      );
      const authorizedAt = databaseTimestamp(value.authorization.authorizedAt);
      const updatedAt = now();
      if (authorizedAt.getTime() > updatedAt.getTime() + 5 * 60 * 1000) {
        scopeMismatch(
          "The contract authorization timestamp cannot be in the future",
        );
      }
      const row = await (
        await repository()
      ).mutate(input.reference, (current) => {
        if (
          current.status === "payment_required" ||
          current.status === "account_setup_required" ||
          current.status === "activation_required" ||
          current.status === "active"
        ) {
          if (
            completeExternalContractAuthorization(current) &&
            sameText(
              current.contractAuthorizationEventReference,
              value.authorization.eventReference,
            )
          ) {
            return null;
          }
          return stateConflict(
            "The manual order already contains different contract evidence",
          );
        }
        if (
          current.status !== "pending_admin" &&
          current.status !== "signature_required"
        ) {
          return stateConflict(
            "Only a pending contract can be authorized externally",
          );
        }
        return {
          // The event reference proves that an administrator allowed payment;
          // it is not an electronic-contract identifier and must never be
          // exposed as one.
          externalContractId: null,
          signingUrl: null,
          signedPdfFileId: null,
          signedPdfFilename: null,
          signedPdfSha256: null,
          signedPdfStorageKey: null,
          evidenceReportFileId: null,
          evidenceReportFilename: null,
          evidenceReportSha256: null,
          signedAt: null,
          signatoryId: null,
          signatureNote: null,
          signedByUserId: null,
          contractAuthorizationMode: "external_wechat",
          contractAuthorizationEventReference:
            value.authorization.eventReference,
          contractAuthorizedAt: authorizedAt,
          status: "payment_required",
          lastError: null,
          revision: current.revision + 1,
          updatedAt,
        };
      });
      return readResponse(
        row,
        configuredSecret(input.secret ?? options.secret),
      );
    },

    async recordPayment(input: {
      reference: string;
      idempotencyKey: string;
      request: ManualServicePaymentRequest;
      secret?: string;
    }) {
      const value = manualServicePaymentRequestSchema.parse(input.request);
      const secret = configuredSecret(input.secret ?? options.secret);
      const paymentKeyHash = sha256(input.idempotencyKey.trim());
      const paymentRequestHash = hmac(value, secret);
      const row = await (
        await repository()
      ).mutate(input.reference, async (current) => {
        if (
          current.status === "account_setup_required" ||
          current.status === "activation_required" ||
          current.status === "active"
        ) {
          if (!paymentMatches(current, value, secret)) {
            return stateConflict(
              "The manual order already contains a different verified payment",
            );
          }
          return null;
        }
        if (
          current.status !== "payment_required" ||
          !completeContractEvidence(current)
        ) {
          return stateConflict(
            "Contract confirmation is required before payment can be recorded",
          );
        }
        const evidenceAt = contractEvidenceAt(current);
        if (
          !evidenceAt ||
          Date.parse(value.payment.paidAt) <= evidenceAt.getTime()
        ) {
          return scopeMismatch(
            "The verified payment must occur after contract confirmation",
          );
        }
        const startsAt = databaseTimestamp(value.payment.paidAt);
        if (startsAt.getTime() > now().getTime() + 5 * 60 * 1000) {
          return scopeMismatch(
            "The verified payment timestamp cannot be in the future",
          );
        }
        return {
          paymentIdempotencyKeyHash: paymentKeyHash,
          paymentRequestHash,
          paymentOrderId: value.payment.orderId,
          paymentTradeNo: value.payment.tradeNo,
          amountFen: value.payment.amountFen,
          paidAt: startsAt,
          status: "account_setup_required",
          lastError: null,
          revision: current.revision + 1,
          updatedAt: now(),
        };
      });
      return readResponse(row, secret);
    },

    async setupAccount(input: {
      reference: string;
      idempotencyKey: string;
      request: ManualServiceAccountSetupRequest;
      secret?: string;
    }) {
      const value = manualServiceAccountSetupRequestSchema.parse(input.request);
      const secret = configuredSecret(input.secret ?? options.secret);
      const accountKeyHash = sha256(input.idempotencyKey.trim());
      const accountRequestHash = hmac(value, secret);
      const customerPasswordHash =
        value.account.mode === "create"
          ? await hashCustomerPassword(value.account.password)
          : null;
      let purchase: PurchaseResponse | undefined;
      const row = await (
        await repository()
      ).mutate(input.reference, async (current, executor) => {
        if (
          current.status === "activation_required" ||
          current.status === "active"
        ) {
          const hasAccountReplay =
            Boolean(current.accountSetupIdempotencyKeyHash) &&
            Boolean(current.accountSetupRequestHash);
          if (hasAccountReplay) {
            if (
              !sameText(
                current.accountSetupIdempotencyKeyHash,
                accountKeyHash,
              ) ||
              !safeHashEqual(
                current.accountSetupRequestHash!,
                accountRequestHash,
              )
            ) {
              return stateConflict(
                "The manual order already contains different account details",
              );
            }
            if (current.provisioningReference) {
              purchase = await readPurchase({
                reference: current.provisioningReference,
                secret,
              });
            }
            return null;
          }
          if (
            current.accountSetupIdempotencyKeyHash ||
            current.accountSetupRequestHash ||
            !current.accountMode ||
            !current.provisioningReference ||
            !completeContractEvidence(current) ||
            !completePayment(current) ||
            current.accountMode !== value.account.mode
          ) {
            return stateConflict(
              "The existing account details cannot be migrated automatically",
            );
          }
          purchase = await readPurchase({
            reference: current.provisioningReference,
            secret,
          });
          if (value.account.mode === "create") {
            if (
              normalizeUsername(value.account.username) !==
                normalizeUsername(current.requestedUsername || "") ||
              value.account.displayName.trim() !==
                (current.requestedDisplayName || "").trim()
            ) {
              return stateConflict(
                "The customer credentials must use the account name already reserved for this order",
              );
            }
            if (current.status === "active") {
              const setupUrl = purchase.account?.accountSetupUrl;
              let setupToken: string | null = null;
              try {
                setupToken = setupUrl
                  ? new URL(setupUrl).searchParams.get("token")
                  : null;
              } catch {
                setupToken = null;
              }
              if (!setupToken) {
                return stateConflict(
                  "The existing account setup link is no longer available; a system administrator must reset the password",
                );
              }
              await setupPurchasePassword({
                token: setupToken,
                password: value.account.password,
                secret,
                executor,
              });
            }
          }
          const accountSetupAt = now();
          return {
            accountSetupIdempotencyKeyHash: accountKeyHash,
            accountSetupRequestHash: accountRequestHash,
            requestedPasswordHash:
              current.status === "activation_required"
                ? customerPasswordHash
                : null,
            accountSetupAt,
            revision: current.revision + 1,
            updatedAt: accountSetupAt,
          };
        }
        if (
          current.status !== "account_setup_required" ||
          !completeContractEvidence(current) ||
          !completePayment(current)
        ) {
          return stateConflict(
            "Verified payment is required before account details can be submitted",
          );
        }
        const startsAt = current.paidAt!;
        const endsAt = new Date(startsAt.getTime() + 30 * 24 * 60 * 60 * 1000);
        const account =
          value.account.mode === "create"
            ? {
                mode: "create" as const,
                username: value.account.username,
                displayName: value.account.displayName,
              }
            : value.account;
        purchase = await submitPurchase({
          idempotencyKey: `manual-account:${accountKeyHash}:purchase-v2`,
          manualOrderReference: current.id,
          secret,
          executor,
          request: {
            schemaVersion: 2,
            marketEdition: current.marketEdition,
            project: {
              id: current.projectId,
              companyName: current.companyName,
            },
            order: {
              id: current.paymentOrderId!,
              tradeNo: current.paymentTradeNo!,
              status: "paid",
              amountFen: current.amountFen!,
              paidAt: startsAt.toISOString(),
            },
            service: {
              planCode: "basic",
              serviceDays: 30,
              startsAt: startsAt.toISOString(),
              endsAt: endsAt.toISOString(),
              purchasedQuestion: {
                id: current.questionId,
                category: current.serviceCategory,
                question: current.question,
              },
            },
            contract: completeExternalContractAuthorization(current)
              ? {
                  status: "pending_admin_confirmation" as const,
                  projectId: current.projectId,
                  orderId: current.paymentOrderId!,
                  questionId: current.questionId,
                  templateVersion: current.contractTemplateVersion,
                  evidence: {
                    type: "external_wechat_confirmation" as const,
                    eventReference:
                      current.contractAuthorizationEventReference!,
                    authorizedAt: current.contractAuthorizedAt!.toISOString(),
                  },
                }
              : {
                  id: current.externalContractId!,
                  status: "pending_admin_confirmation" as const,
                  projectId: current.projectId,
                  orderId: current.paymentOrderId!,
                  questionId: current.questionId,
                  templateVersion: current.contractTemplateVersion,
                  evidence: {
                    type: "system_admin_confirmation" as const,
                    artifact: {
                      taskId: null,
                      fileId: current.signedPdfFileId,
                      outputDescriptor: current.signedPdfFilename,
                      sha256: current.signedPdfSha256,
                    },
                  },
                },
            account,
          },
        });
        if (
          purchase.purchase.projectId !== current.projectId ||
          purchase.purchase.orderId !== current.paymentOrderId ||
          purchase.purchase.status !== "pending_confirmation"
        ) {
          scopeMismatch(
            "The provisioning ledger response does not match the manual order",
          );
        }
        const accountSetupAt = now();
        return {
          accountSetupIdempotencyKeyHash: accountKeyHash,
          accountSetupRequestHash: accountRequestHash,
          accountMode: value.account.mode,
          requestedUsername:
            purchase.account?.username ??
            (value.account.mode === "create" ? value.account.username : null),
          requestedDisplayName:
            purchase.account?.displayName ??
            (value.account.mode === "create"
              ? value.account.displayName
              : null),
          requestedPasswordHash: customerPasswordHash,
          provisioningReference: purchase.purchase.reference,
          accountSetupAt,
          status: "activation_required",
          lastError: null,
          revision: current.revision + 1,
          updatedAt: accountSetupAt,
        };
      });
      if (row.status === "activation_required") {
        return activatePersistedAccount({
          reference: input.reference,
          secret,
        });
      }
      return readResponse(row, secret, purchase);
    },

    async activate(input: {
      reference: string;
      actorUserId: number;
      secret?: string;
    }) {
      const secret = configuredSecret(input.secret ?? options.secret);
      return activatePersistedAccount({
        reference: input.reference,
        secret,
        actorUserId: input.actorUserId,
      });
    },

    async reject(input: {
      reference: string;
      actorUserId: number;
      note: string;
      secret?: string;
    }) {
      const secret = configuredSecret(input.secret ?? options.secret);
      let purchase: PurchaseResponse | undefined;
      const row = await (
        await repository()
      ).mutate(input.reference, async (current, executor) => {
        if (current.status === "rejected") return null;
        if (current.status === "active") {
          return stateConflict(
            "An active manual service order cannot be rejected",
          );
        }
        if (current.provisioningReference) {
          purchase = await decidePurchase({
            reference: current.provisioningReference,
            manualOrderReference: current.id,
            actorUserId: input.actorUserId,
            decision: "reject",
            note: input.note,
            secret,
            executor,
          });
          if (purchase.purchase.status === "provisioned") {
            return {
              status: "active",
              activatedByUserId: input.actorUserId,
              activatedAt: now(),
              lastError: null,
              revision: current.revision + 1,
              updatedAt: now(),
            };
          }
        }
        const rejectedAt = now();
        return {
          status: "rejected",
          requestedPasswordHash: null,
          rejectedByUserId: input.actorUserId,
          rejectedAt,
          lastError: input.note,
          revision: current.revision + 1,
          updatedAt: rejectedAt,
        };
      });
      return readResponse(row, secret, purchase);
    },
  };
}

export type ManualServiceOrderService = ReturnType<
  typeof createManualServiceOrderService
>;
