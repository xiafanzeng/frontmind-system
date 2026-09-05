import {
  createHash,
  createHmac,
  randomBytes,
  randomUUID,
  timingSafeEqual,
} from "node:crypto";
import { and, desc, eq, gt } from "drizzle-orm";

import {
  purchaseIntents,
  serviceContracts,
  userDashboardContents,
  users,
  websiteUserProvisions,
} from "../drizzle/schema";
import { createDefaultDashboardPayload } from "../shared/dashboard";
import { type ServicePlanCode } from "../shared/service-portal";
import {
  websitePurchaseRequestV2Schema,
  websitePurchaseResponseV2Schema,
  type WebsitePurchaseRequestV2,
  type WebsitePurchaseResponseV2,
} from "../shared/provisioning-v2";
import {
  AuthServiceError,
  consumeAllUserPasswordSetupTokensInExecutor,
  createManagedUser,
  createManagedUserWithPasswordHash,
  hashPassword,
  isSupportedPasswordHash,
  normalizeUsername,
  revokeAllUserSessionsInExecutor,
} from "./auth-service";
import { getDb } from "./db";
import { provisionBasicEntitlement } from "./basic-entitlement-service";
import {
  lockActiveWebsiteProjectLifecycle,
  WebsiteProjectInactiveError,
} from "./website-project-lifecycle";

const ACCOUNT_SETUP_TTL_MS = 48 * 60 * 60 * 1000;
const PURCHASE_INTENT_TTL_MS = 30 * 60 * 1000;

export type PurchaseProvisioningErrorCode =
  | "PROVISIONING_NOT_CONFIGURED"
  | "IDEMPOTENCY_CONFLICT"
  | "PURCHASE_INTENT_INVALID"
  | "PURCHASE_INTENT_CONFLICT"
  | "PURCHASE_NOT_FOUND"
  | "PURCHASE_ALREADY_DECIDED"
  | "PURCHASE_MANUAL_WORKFLOW_REQUIRED"
  | "ENTERPRISE_IDENTITY_MISMATCH"
  | "ACCOUNT_EDITION_MISMATCH"
  | "USERNAME_CONFLICT"
  | "PROJECT_DELETED"
  | "ACCOUNT_SETUP_INVALID"
  | "DATABASE_UNAVAILABLE";

export class PurchaseProvisioningError extends Error {
  constructor(
    public readonly code: PurchaseProvisioningErrorCode,
    message: string,
    public readonly status: number,
  ) {
    super(message);
    this.name = "PurchaseProvisioningError";
  }
}

async function lockActivePurchaseProject(tx: any, projectId: string) {
  try {
    await lockActiveWebsiteProjectLifecycle(tx, projectId);
  } catch (error) {
    if (!(error instanceof WebsiteProjectInactiveError)) throw error;
    throw new PurchaseProvisioningError(
      "PROJECT_DELETED",
      "The project has been permanently deleted",
      410,
    );
  }
}

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

function requestHash(value: WebsitePurchaseRequestV2, secret: string) {
  return createHmac("sha256", secret)
    .update(canonicalJson(value), "utf8")
    .digest("hex");
}

function storedRequestHashMatches(
  value: WebsitePurchaseRequestV2,
  stored: Pick<
    typeof websiteUserProvisions.$inferSelect,
    "requestHash" | "marketEdition"
  >,
  secret: string,
) {
  if (stored.requestHash === requestHash(value, secret)) return true;
  if (
    value.marketEdition !== undefined &&
    value.marketEdition !== stored.marketEdition
  ) {
    return false;
  }
  if (
    stored.marketEdition !== "domestic" &&
    value.account.mode !== "bind_existing"
  ) {
    return false;
  }
  const alternateRequest: WebsitePurchaseRequestV2 =
    value.marketEdition === undefined
      ? { ...value, marketEdition: stored.marketEdition }
      : (({ marketEdition: _marketEdition, ...legacyRequest }) =>
          legacyRequest)(value);
  return stored.requestHash === requestHash(alternateRequest, secret);
}

function requireProvisioningSecret(secret?: string) {
  const value =
    secret?.trim() ||
    process.env.FRONTMIND_PROVISIONING_SERVICE_TOKEN?.trim() ||
    "";
  if (value.length < 32) {
    throw new PurchaseProvisioningError(
      "PROVISIONING_NOT_CONFIGURED",
      "Website account provisioning is unavailable",
      503,
    );
  }
  return value;
}

async function requireProvisioningDb() {
  const db = await getDb();
  if (!db) {
    throw new PurchaseProvisioningError(
      "DATABASE_UNAVAILABLE",
      "The account database is unavailable",
      503,
    );
  }
  return db;
}

function publicBaseUrl() {
  const configured = process.env.FRONTMIND_PUBLIC_URL?.trim().replace(
    /\/$/,
    "",
  );
  if (configured) return configured;
  if (process.env.NODE_ENV !== "production") return "http://127.0.0.1:3001";
  return null;
}

function setupToken(input: {
  provisionId: string;
  expiresAt: Date;
  secret: string;
}) {
  const payload = Buffer.from(
    JSON.stringify({
      v: 1,
      provisionId: input.provisionId,
      exp: input.expiresAt.getTime(),
    }),
  ).toString("base64url");
  const signature = createHmac("sha256", input.secret)
    .update(payload)
    .digest("base64url");
  return `${payload}.${signature}`;
}

function verifySetupToken(token: string, secret: string) {
  const [payload, signature, extra] = token.split(".");
  if (!payload || !signature || extra) {
    throw new PurchaseProvisioningError(
      "ACCOUNT_SETUP_INVALID",
      "账号设置链接无效或已过期",
      400,
    );
  }
  const expected = createHmac("sha256", secret).update(payload).digest();
  let actual: Buffer;
  try {
    actual = Buffer.from(signature, "base64url");
  } catch {
    actual = Buffer.alloc(0);
  }
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
    throw new PurchaseProvisioningError(
      "ACCOUNT_SETUP_INVALID",
      "账号设置链接无效或已过期",
      400,
    );
  }
  try {
    const parsed = JSON.parse(
      Buffer.from(payload, "base64url").toString("utf8"),
    ) as { v?: number; provisionId?: string; exp?: number };
    if (parsed.v !== 1 || !parsed.provisionId || !Number.isFinite(parsed.exp)) {
      throw new Error("invalid payload");
    }
    return {
      provisionId: parsed.provisionId,
      expiresAt: new Date(parsed.exp!),
    };
  } catch {
    throw new PurchaseProvisioningError(
      "ACCOUNT_SETUP_INVALID",
      "账号设置链接无效或已过期",
      400,
    );
  }
}

function purchaseResponse(
  row: typeof websiteUserProvisions.$inferSelect,
  secret: string,
): WebsitePurchaseResponseV2 {
  const status =
    row.status === "completed"
      ? "provisioned"
      : row.status === "failed" || row.contractConfirmationStatus === "rejected"
        ? "failed"
        : "pending_confirmation";
  const baseUrl = publicBaseUrl();
  const account: WebsitePurchaseResponseV2["account"] = {
    username: row.requestedUsername,
    displayName: row.requestedDisplayName,
    ...(baseUrl && status === "provisioned"
      ? { workspaceUrl: `${baseUrl}/` }
      : {}),
  };
  if (
    baseUrl &&
    status === "provisioned" &&
    row.accountMode === "create" &&
    row.accountSetupTokenExpiresAt &&
    !row.accountSetupTokenConsumedAt &&
    row.accountSetupTokenExpiresAt.getTime() > Date.now()
  ) {
    const token = setupToken({
      provisionId: row.id,
      expiresAt: row.accountSetupTokenExpiresAt,
      secret,
    });
    if (
      row.accountSetupTokenHash &&
      sha256(token) === row.accountSetupTokenHash
    ) {
      account.accountSetupUrl = `${baseUrl}/setup-password?token=${encodeURIComponent(token)}`;
    }
  }
  return websitePurchaseResponseV2Schema.parse({
    schemaVersion: 2,
    purchase: {
      reference: row.id,
      projectId: row.projectId,
      orderId: row.orderId,
      status,
      marketEdition: row.marketEdition,
      updatedAt: row.updatedAt.toISOString(),
      ...(status === "failed"
        ? {
            retryable: false,
            errorCode: "PURCHASE_CONFIRMATION_FAILED",
            message: row.lastError || "服务合同未通过确认",
          }
        : {}),
    },
    account,
  });
}

function enterpriseKey(value: string) {
  return value.normalize("NFKC").trim().replace(/\s+/g, "").toLowerCase();
}

function manualOrderReferenceFromEvidence(evidence: unknown) {
  if (!evidence || typeof evidence !== "object" || Array.isArray(evidence)) {
    return undefined;
  }
  const value = (evidence as Record<string, unknown>).manualOrderReference;
  return typeof value === "string" && value.length >= 4 && value.length <= 128
    ? value
    : undefined;
}

export async function submitWebsitePurchase(input: {
  idempotencyKey: string;
  request: WebsitePurchaseRequestV2;
  manualOrderReference?: string;
  secret?: string;
  now?: Date;
  executor?: any;
}) {
  const value = websitePurchaseRequestV2Schema.parse(input.request);
  const manualOrderReference = input.manualOrderReference?.trim();
  if (
    input.manualOrderReference !== undefined &&
    (!manualOrderReference ||
      manualOrderReference.length < 4 ||
      manualOrderReference.length > 128)
  ) {
    throw new PurchaseProvisioningError(
      "PURCHASE_MANUAL_WORKFLOW_REQUIRED",
      "Invalid manual signing order reference",
      400,
    );
  }
  const secret = requireProvisioningSecret(input.secret);
  const keyHash = sha256(input.idempotencyKey.trim());
  const hash = requestHash(value, secret);
  const db = input.executor ?? (await requireProvisioningDb());
  const now = input.now ?? new Date();

  const write = async (tx: any) => {
    await lockActivePurchaseProject(tx, value.project.id);
    const existingRows = await tx
      .select()
      .from(websiteUserProvisions)
      .where(eq(websiteUserProvisions.idempotencyKeyHash, keyHash))
      .limit(1)
      .for("update");
    const existing = existingRows[0];
    if (existing) {
      if (
        !storedRequestHashMatches(value, existing, secret) ||
        existing.schemaVersion !== 2 ||
        manualOrderReferenceFromEvidence(existing.contractEvidence) !==
          manualOrderReference
      ) {
        throw new PurchaseProvisioningError(
          "IDEMPOTENCY_CONFLICT",
          "The idempotency key has already been used for another purchase",
          409,
        );
      }
      return existing;
    }

    let userId: number | null = null;
    let purchaseIntentId: string | null = null;
    let requestedUsername: string;
    let requestedDisplayName: string;
    let marketEdition = value.marketEdition ?? "domestic";
    if (value.account.mode === "bind_existing") {
      const intentHash = sha256(value.account.purchaseIntent);
      const intents = await tx
        .select()
        .from(purchaseIntents)
        .where(
          and(
            eq(purchaseIntents.tokenHash, intentHash),
            eq(purchaseIntents.status, "pending"),
            gt(purchaseIntents.expiresAt, now),
          ),
        )
        .limit(1)
        .for("update");
      const intent = intents[0];
      if (!intent || intent.targetPlanCode !== "basic") {
        throw new PurchaseProvisioningError(
          "PURCHASE_INTENT_INVALID",
          "购买绑定凭证无效或已过期",
          403,
        );
      }
      if (intent.externalOrderId && intent.externalOrderId !== value.order.id) {
        throw new PurchaseProvisioningError(
          "PURCHASE_INTENT_CONFLICT",
          "购买绑定凭证已用于其他订单",
          409,
        );
      }
      const accounts = await tx
        .select({
          id: users.id,
          username: users.username,
          displayName: users.displayName,
          marketEdition: users.marketEdition,
        })
        .from(users)
        .where(eq(users.id, intent.userId))
        .limit(1);
      const account = accounts[0];
      if (!account?.username) {
        throw new PurchaseProvisioningError(
          "PURCHASE_INTENT_INVALID",
          "购买绑定账号不存在",
          404,
        );
      }
      if (
        value.marketEdition !== undefined &&
        value.marketEdition !== account.marketEdition
      ) {
        throw new PurchaseProvisioningError(
          "ACCOUNT_EDITION_MISMATCH",
          "购买版本与绑定账号版本不一致",
          409,
        );
      }
      marketEdition = account.marketEdition;
      const dashboards = await tx
        .select({ payload: userDashboardContents.payload })
        .from(userDashboardContents)
        .where(eq(userDashboardContents.userId, account.id))
        .limit(1);
      const brandName = dashboards[0]?.payload?.brandName;
      if (
        typeof brandName === "string" &&
        brandName &&
        enterpriseKey(brandName) !== enterpriseKey(value.project.companyName)
      ) {
        throw new PurchaseProvisioningError(
          "ENTERPRISE_IDENTITY_MISMATCH",
          "不同企业必须使用新的 FrontMind 账号",
          409,
        );
      }
      userId = account.id;
      purchaseIntentId = intent.id;
      requestedUsername = account.username;
      requestedDisplayName = account.displayName || value.project.companyName;
      await tx
        .update(purchaseIntents)
        .set({
          status: "consumed",
          externalOrderId: value.order.id,
          consumedAt: now,
          revision: intent.revision + 1,
          updatedAt: now,
        })
        .where(eq(purchaseIntents.id, intent.id));
    } else {
      requestedUsername = normalizeUsername(value.account.username);
      requestedDisplayName = value.account.displayName.trim();
      const accounts = await tx
        .select({ id: users.id })
        .from(users)
        .where(eq(users.username, requestedUsername))
        .limit(1);
      if (accounts[0]) {
        throw new PurchaseProvisioningError(
          "USERNAME_CONFLICT",
          "Username already exists",
          409,
        );
      }
    }

    const id = randomUUID();
    const evidenceHash = sha256(canonicalJson(value.contract.evidence));
    const contractEvidence = manualOrderReference
      ? {
          ...value.contract.evidence,
          manualOrderReference,
        }
      : value.contract.evidence;
    await tx.insert(websiteUserProvisions).values({
      id,
      schemaVersion: 2,
      idempotencyKeyHash: keyHash,
      requestHash: hash,
      projectId: value.project.id,
      companyName: value.project.companyName,
      marketEdition,
      orderId: value.order.id,
      tradeNo: value.order.tradeNo,
      amountFen: value.order.amountFen,
      paidAt: new Date(value.order.paidAt),
      serviceCategory: value.service.purchasedQuestion.category,
      planCode: "basic",
      questionId: value.service.purchasedQuestion.id,
      question: value.service.purchasedQuestion.question,
      contractId: "id" in value.contract ? value.contract.id : null,
      contractTemplateVersion: value.contract.templateVersion,
      contractDocumentSha256: evidenceHash,
      contractEvidence,
      contractConfirmationStatus: "pending_confirmation",
      contractSignedAt: null,
      signatoryId: null,
      accountMode:
        value.account.mode === "bind_existing" ? "bind_existing" : "create",
      purchaseIntentId,
      requestedUsername,
      requestedDisplayName,
      userId,
      status: "pending_confirmation",
      accountSetupTokenHash: null,
      accountSetupTokenExpiresAt: null,
      accountSetupTokenConsumedAt: null,
      lastError: null,
      completedAt: null,
      createdAt: now,
      updatedAt: now,
    });
    const rows = await tx
      .select()
      .from(websiteUserProvisions)
      .where(eq(websiteUserProvisions.id, id))
      .limit(1);
    return rows[0]!;
  };
  const stored = input.executor ? await write(db) : await db.transaction(write);
  return purchaseResponse(stored, secret);
}

export async function getWebsitePurchaseStatus(input: {
  reference: string;
  secret?: string;
}) {
  const secret = requireProvisioningSecret(input.secret);
  const db = await requireProvisioningDb();
  const rows = await db
    .select()
    .from(websiteUserProvisions)
    .where(
      and(
        eq(websiteUserProvisions.id, input.reference),
        eq(websiteUserProvisions.schemaVersion, 2),
      ),
    )
    .limit(1);
  if (!rows[0]) {
    throw new PurchaseProvisioningError(
      "PURCHASE_NOT_FOUND",
      "Purchase reference not found",
      404,
    );
  }
  return purchaseResponse(rows[0], secret);
}

export async function listPendingWebsitePurchases() {
  const db = await requireProvisioningDb();
  const rows = await db
    .select()
    .from(websiteUserProvisions)
    .where(
      and(
        eq(websiteUserProvisions.schemaVersion, 2),
        eq(websiteUserProvisions.status, "pending_confirmation"),
      ),
    )
    .orderBy(desc(websiteUserProvisions.createdAt));
  return rows
    .filter((row) => !manualOrderReferenceFromEvidence(row.contractEvidence))
    .map((row) => ({
      reference: row.id,
      projectId: row.projectId,
      companyName: row.companyName,
      orderId: row.orderId,
      questionId: row.questionId,
      question: row.question,
      category: row.serviceCategory,
      requestedUsername: row.requestedUsername,
      requestedDisplayName: row.requestedDisplayName,
      accountMode: row.accountMode,
      marketEdition: row.marketEdition,
      contractId: row.contractId,
      contractTemplateVersion: row.contractTemplateVersion,
      contractEvidence: row.contractEvidence,
      paidAt: row.paidAt.getTime(),
      createdAt: row.createdAt.getTime(),
    }));
}

export async function decideWebsitePurchase(input: {
  reference: string;
  manualOrderReference?: string;
  actorUserId?: number;
  decision: "confirm" | "reject";
  signedAt?: Date;
  signatoryId?: string;
  note?: string;
  manualPasswordHash?: string;
  secret?: string;
  now?: Date;
  executor?: any;
}) {
  const secret = requireProvisioningSecret(input.secret);
  const db = input.executor ?? (await requireProvisioningDb());
  const now = input.now ?? new Date();
  const projectBindings = await db
    .select({ projectId: websiteUserProvisions.projectId })
    .from(websiteUserProvisions)
    .where(
      and(
        eq(websiteUserProvisions.id, input.reference),
        eq(websiteUserProvisions.schemaVersion, 2),
      ),
    )
    .limit(1);
  if (!projectBindings[0]) {
    throw new PurchaseProvisioningError(
      "PURCHASE_NOT_FOUND",
      "Purchase reference not found",
      404,
    );
  }
  const write = async (tx: any) => {
    await lockActivePurchaseProject(tx, projectBindings[0].projectId);
    const rows = await tx
      .select()
      .from(websiteUserProvisions)
      .where(
        and(
          eq(websiteUserProvisions.id, input.reference),
          eq(websiteUserProvisions.schemaVersion, 2),
        ),
      )
      .limit(1)
      .for("update");
    const row = rows[0];
    if (!row) {
      throw new PurchaseProvisioningError(
        "PURCHASE_NOT_FOUND",
        "Purchase reference not found",
        404,
      );
    }
    const manualOwner = manualOrderReferenceFromEvidence(row.contractEvidence);
    if (manualOwner && input.manualOrderReference !== manualOwner) {
      throw new PurchaseProvisioningError(
        "PURCHASE_MANUAL_WORKFLOW_REQUIRED",
        "This purchase must be activated from its manual signing order",
        409,
      );
    }
    if (
      input.manualOrderReference &&
      input.manualOrderReference !== manualOwner
    ) {
      throw new PurchaseProvisioningError(
        "PURCHASE_MANUAL_WORKFLOW_REQUIRED",
        "The manual signing order does not own this purchase",
        409,
      );
    }
    if (
      input.manualPasswordHash !== undefined &&
      (input.decision !== "confirm" ||
        !manualOwner ||
        row.accountMode !== "create" ||
        !isSupportedPasswordHash(input.manualPasswordHash))
    ) {
      throw new PurchaseProvisioningError(
        "PURCHASE_MANUAL_WORKFLOW_REQUIRED",
        "A customer-selected password hash is only valid for its manual account activation",
        409,
      );
    }
    if (row.status === "completed" || row.status === "failed") return row;
    if (row.status !== "pending_confirmation") {
      throw new PurchaseProvisioningError(
        "PURCHASE_ALREADY_DECIDED",
        "Purchase is not awaiting confirmation",
        409,
      );
    }
    if (input.decision === "reject") {
      await tx
        .update(websiteUserProvisions)
        .set({
          contractConfirmationStatus: "rejected",
          status: "failed",
          lastError: (input.note || "系统管理员未确认签署证据").slice(0, 2000),
          updatedAt: now,
        })
        .where(eq(websiteUserProvisions.id, row.id));
      const rejected = await tx
        .select()
        .from(websiteUserProvisions)
        .where(eq(websiteUserProvisions.id, row.id))
        .limit(1);
      return rejected[0]!;
    }

    const submittedEvidence =
      row.contractEvidence &&
      typeof row.contractEvidence === "object" &&
      !Array.isArray(row.contractEvidence)
        ? row.contractEvidence
        : {};
    const externallyAuthorized =
      submittedEvidence.type === "external_wechat_confirmation";
    const externalEventReference =
      typeof submittedEvidence.eventReference === "string"
        ? submittedEvidence.eventReference.trim()
        : "";
    const externalAuthorizedAt =
      typeof submittedEvidence.authorizedAt === "string"
        ? new Date(submittedEvidence.authorizedAt)
        : undefined;
    if (
      externallyAuthorized &&
      (!manualOwner ||
        externalEventReference.length < 4 ||
        externalEventReference.length > 128 ||
        !externalAuthorizedAt ||
        !Number.isFinite(externalAuthorizedAt.getTime()) ||
        row.paidAt.getTime() <= externalAuthorizedAt.getTime() ||
        externalAuthorizedAt.getTime() > now.getTime() + 5 * 60 * 1000)
    ) {
      throw new PurchaseProvisioningError(
        "PURCHASE_ALREADY_DECIDED",
        "企业微信合同确认记录无效",
        400,
      );
    }
    const signedAt = externallyAuthorized ? undefined : (input.signedAt ?? now);
    const signatoryId = externallyAuthorized
      ? undefined
      : input.signatoryId?.trim();
    if (
      !externallyAuthorized &&
      (!signatoryId || !Number.isInteger(input.actorUserId))
    ) {
      throw new PurchaseProvisioningError(
        "PURCHASE_ALREADY_DECIDED",
        "确认签署证据时必须填写签署主体标识",
        400,
      );
    }
    const artifact =
      submittedEvidence.artifact &&
      typeof submittedEvidence.artifact === "object" &&
      !Array.isArray(submittedEvidence.artifact)
        ? (submittedEvidence.artifact as Record<string, unknown>)
        : {};
    const artifactSha256 =
      typeof artifact.sha256 === "string" ? artifact.sha256.trim() : "";
    const manualEvidenceNote = input.note?.trim() || "";
    if (
      !externallyAuthorized &&
      !/^[a-f0-9]{64}$/i.test(artifactSha256) &&
      manualEvidenceNote.length < 8
    ) {
      throw new PurchaseProvisioningError(
        "PURCHASE_ALREADY_DECIDED",
        "缺少可验证签署产物时，必须填写不少于 8 个字的人工核验依据",
        400,
      );
    }
    const confirmedEvidence = externallyAuthorized
      ? {
          ...submittedEvidence,
          externalAuthorizationConfirmation: {
            mode: "external_wechat",
            eventReference: externalEventReference,
            authorizedAt: externalAuthorizedAt!.toISOString(),
          },
        }
      : {
          ...submittedEvidence,
          manualConfirmation: {
            actorUserId: input.actorUserId!,
            signedAt: signedAt!.toISOString(),
            signatoryId: signatoryId!,
            note: manualEvidenceNote || null,
          },
        };

    let userId = row.userId;
    if (row.accountMode === "create") {
      if (manualOwner && !input.manualPasswordHash) {
        throw new PurchaseProvisioningError(
          "PURCHASE_MANUAL_WORKFLOW_REQUIRED",
          "The customer must choose account credentials before manual activation",
          409,
        );
      }
      const existingUsers = await tx
        .select({ id: users.id })
        .from(users)
        .where(eq(users.username, row.requestedUsername))
        .limit(1);
      if (existingUsers[0]) {
        throw new PurchaseProvisioningError(
          "USERNAME_CONFLICT",
          "Username already exists",
          409,
        );
      }
      const user = input.manualPasswordHash
        ? await createManagedUserWithPasswordHash(
            {
              username: row.requestedUsername,
              passwordHash: input.manualPasswordHash,
              displayName: row.requestedDisplayName,
              role: "user",
              marketEdition: row.marketEdition,
              now,
            },
            tx,
          )
        : await createManagedUser(
            {
              username: row.requestedUsername,
              password: randomBytes(48).toString("base64url"),
              displayName: row.requestedDisplayName,
              role: "user",
              marketEdition: row.marketEdition,
            },
            tx,
          );
      userId = user.id;
    }
    if (!userId) {
      throw new PurchaseProvisioningError(
        "PURCHASE_INTENT_INVALID",
        "绑定账号不存在",
        409,
      );
    }
    const dashboards = await tx
      .select({ userId: userDashboardContents.userId })
      .from(userDashboardContents)
      .where(eq(userDashboardContents.userId, userId))
      .limit(1);
    if (!dashboards[0]) {
      await tx.insert(userDashboardContents).values({
        userId,
        payload: createDefaultDashboardPayload(row.companyName),
        sourceName: `官网普通版开通 · ${row.projectId}`.slice(0, 512),
        revision: 1,
        updatedByUserId: input.actorUserId,
        createdAt: now,
        updatedAt: now,
      });
    }

    const startsAt = row.paidAt;
    const contractId = await provisionBasicEntitlement(tx, {
      userId,
      orderId: row.orderId,
      projectId: row.projectId,
      questionId: row.questionId,
      question: row.question,
      category: row.serviceCategory,
      startsAt,
      amountFen: row.amountFen,
      currency: "CNY",
      externalContractReference: row.contractId,
      signedAt: signedAt ?? null,
      signatoryId: signatoryId ?? null,
      signingEvidence: confirmedEvidence,
      actorUserId: input.actorUserId,
      now,
    });

    if (row.purchaseIntentId) {
      const intents = await tx
        .select()
        .from(purchaseIntents)
        .where(eq(purchaseIntents.id, row.purchaseIntentId))
        .limit(1)
        .for("update");
      const intent = intents[0];
      const boundAtCheckout =
        intent?.status === "consumed" && intent.externalOrderId === row.orderId;
      const legacyPendingBinding =
        intent?.status === "pending" &&
        intent.expiresAt.getTime() > now.getTime() &&
        (!intent.externalOrderId || intent.externalOrderId === row.orderId);
      if (
        !intent ||
        intent.userId !== userId ||
        (!boundAtCheckout && !legacyPendingBinding)
      ) {
        throw new PurchaseProvisioningError(
          "PURCHASE_INTENT_INVALID",
          "购买绑定凭证已过期或被使用",
          409,
        );
      }
      await tx
        .update(purchaseIntents)
        .set({
          status: "consumed",
          resultingContractId: contractId,
          consumedAt: intent.consumedAt ?? now,
          revision: intent.revision + 1,
          updatedAt: now,
        })
        .where(eq(purchaseIntents.id, intent.id));
    }

    const setupExpiresAt =
      row.accountMode === "create" && !input.manualPasswordHash
        ? new Date(now.getTime() + ACCOUNT_SETUP_TTL_MS)
        : null;
    const rawSetupToken = setupExpiresAt
      ? setupToken({
          provisionId: row.id,
          expiresAt: setupExpiresAt,
          secret,
        })
      : null;
    await tx
      .update(websiteUserProvisions)
      .set({
        userId,
        contractConfirmationStatus: "confirmed",
        contractSignedAt: signedAt ?? null,
        signatoryId: signatoryId ?? null,
        contractEvidence: confirmedEvidence,
        status: "completed",
        accountSetupTokenHash: rawSetupToken ? sha256(rawSetupToken) : null,
        accountSetupTokenExpiresAt: setupExpiresAt,
        accountSetupTokenConsumedAt: null,
        lastError: null,
        completedAt: now,
        updatedAt: now,
      })
      .where(eq(websiteUserProvisions.id, row.id));
    const completed = await tx
      .select()
      .from(websiteUserProvisions)
      .where(eq(websiteUserProvisions.id, row.id))
      .limit(1);
    return completed[0]!;
  };
  const stored = input.executor ? await write(db) : await db.transaction(write);
  return purchaseResponse(stored, secret);
}

export async function setupWebsiteAccountPassword(input: {
  token: string;
  password: string;
  secret?: string;
  now?: Date;
  executor?: any;
}) {
  const secret = requireProvisioningSecret(input.secret);
  const parsed = verifySetupToken(input.token, secret);
  const now = input.now ?? new Date();
  if (parsed.expiresAt.getTime() <= now.getTime()) {
    throw new PurchaseProvisioningError(
      "ACCOUNT_SETUP_INVALID",
      "账号设置链接无效或已过期",
      400,
    );
  }
  const db = input.executor ?? (await requireProvisioningDb());
  const passwordHash = await hashPassword(input.password);
  const projectBindings = await db
    .select({ projectId: websiteUserProvisions.projectId })
    .from(websiteUserProvisions)
    .where(eq(websiteUserProvisions.id, parsed.provisionId))
    .limit(1);
  if (!projectBindings[0]) {
    throw new PurchaseProvisioningError(
      "ACCOUNT_SETUP_INVALID",
      "账号设置链接无效或已过期",
      400,
    );
  }
  const write = async (tx: any) => {
    await lockActivePurchaseProject(tx, projectBindings[0].projectId);
    const rows = await tx
      .select()
      .from(websiteUserProvisions)
      .where(eq(websiteUserProvisions.id, parsed.provisionId))
      .limit(1)
      .for("update");
    const row = rows[0];
    if (
      !row?.userId ||
      row.status !== "completed" ||
      row.accountMode !== "create" ||
      row.accountSetupTokenConsumedAt ||
      !row.accountSetupTokenExpiresAt ||
      row.accountSetupTokenExpiresAt.getTime() <= now.getTime() ||
      row.accountSetupTokenHash !== sha256(input.token)
    ) {
      throw new PurchaseProvisioningError(
        "ACCOUNT_SETUP_INVALID",
        "账号设置链接无效或已过期",
        400,
      );
    }
    const accountRows = await tx
      .select({
        id: users.id,
        username: users.username,
        role: users.role,
        isActive: users.isActive,
      })
      .from(users)
      .where(eq(users.id, row.userId))
      .limit(1)
      .for("update");
    const account = accountRows[0];
    if (
      !account ||
      account.role !== "user" ||
      !account.isActive ||
      account.username !== row.requestedUsername
    ) {
      throw new PurchaseProvisioningError(
        "ACCOUNT_SETUP_INVALID",
        "账号设置链接无效或已过期",
        400,
      );
    }
    await tx
      .update(users)
      .set({ passwordHash, passwordChangedAt: now, updatedAt: now })
      .where(eq(users.id, account.id));
    await consumeAllUserPasswordSetupTokensInExecutor(tx, account.id, now);
    await revokeAllUserSessionsInExecutor(tx, account.id, now);
    return {
      success: true as const,
      username: row.requestedUsername,
      workspaceUrl: publicBaseUrl() ? `${publicBaseUrl()}/login` : "/login",
    };
  };
  return input.executor ? write(db) : db.transaction(write);
}

export async function validateWebsiteAccountSetupToken(input: {
  token: string;
  secret?: string;
  now?: Date;
}) {
  const secret = requireProvisioningSecret(input.secret);
  const parsed = verifySetupToken(input.token, secret);
  const now = input.now ?? new Date();
  if (parsed.expiresAt.getTime() <= now.getTime()) {
    throw new PurchaseProvisioningError(
      "ACCOUNT_SETUP_INVALID",
      "账号设置链接无效、已过期或已使用",
      400,
    );
  }
  const db = await requireProvisioningDb();
  const rows = await db
    .select()
    .from(websiteUserProvisions)
    .where(eq(websiteUserProvisions.id, parsed.provisionId))
    .limit(1);
  const row = rows[0];
  if (
    !row?.userId ||
    row.status !== "completed" ||
    row.accountMode !== "create" ||
    row.accountSetupTokenConsumedAt ||
    !row.accountSetupTokenExpiresAt ||
    row.accountSetupTokenExpiresAt.getTime() <= now.getTime() ||
    row.accountSetupTokenHash !== sha256(input.token)
  ) {
    throw new PurchaseProvisioningError(
      "ACCOUNT_SETUP_INVALID",
      "账号设置链接无效、已过期或已使用",
      400,
    );
  }
  return {
    valid: true as const,
    username: row.requestedUsername,
    displayName: row.requestedDisplayName,
    expiresAt: row.accountSetupTokenExpiresAt.getTime(),
  };
}

export async function createServicePurchaseIntent(input: {
  userId: number;
  targetPlanCode: ServicePlanCode;
  kind: "repeat_basic" | "upgrade" | "renewal";
  now?: Date;
  ttlMs?: number;
}) {
  const db = await requireProvisioningDb();
  const now = input.now ?? new Date();
  const targetPlanCode = input.targetPlanCode;
  if (input.kind === "repeat_basic" && targetPlanCode !== "basic") {
    throw new PurchaseProvisioningError(
      "PURCHASE_INTENT_CONFLICT",
      "普通版复购凭证只能购买普通版",
      400,
    );
  }
  const accounts = await db
    .select({ id: users.id })
    .from(users)
    .where(eq(users.id, input.userId))
    .limit(1);
  if (!accounts[0]) {
    throw new PurchaseProvisioningError(
      "PURCHASE_INTENT_INVALID",
      "账号不存在",
      404,
    );
  }
  const contracts = await db
    .select({ id: serviceContracts.id })
    .from(serviceContracts)
    .where(eq(serviceContracts.userId, input.userId))
    .orderBy(desc(serviceContracts.revision))
    .limit(1);
  const token = randomBytes(32).toString("base64url");
  const expiresAt = new Date(
    now.getTime() + (input.ttlMs ?? PURCHASE_INTENT_TTL_MS),
  );
  const id = randomUUID();
  await db.insert(purchaseIntents).values({
    id,
    userId: input.userId,
    sourceContractId: contracts[0]?.id ?? null,
    resultingContractId: null,
    targetPlanCode,
    kind: input.kind,
    status: "pending",
    tokenHash: sha256(token),
    externalOrderId: null,
    revision: 1,
    expiresAt,
    consumedAt: null,
    createdAt: now,
    updatedAt: now,
  });
  const websiteUrl =
    process.env.FRONTMIND_WEBSITE_URL?.trim().replace(/\/$/, "") ||
    "https://www.frontmind.net";
  const purchaseUrl =
    input.kind === "repeat_basic"
      ? `${websiteUrl}/?purchaseIntent=${encodeURIComponent(token)}#geo-builder`
      : `${websiteUrl}/contact`;
  return {
    id,
    targetPlanCode,
    kind: input.kind,
    expiresAt: expiresAt.getTime(),
    purchaseUrl,
  };
}
