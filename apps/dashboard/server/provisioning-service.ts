import { createHash, createHmac, randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { z } from "zod";

import {
  userDashboardContents,
  websiteUserProvisions,
  users,
  type WebsiteUserProvision,
} from "../drizzle/schema";
import { createDefaultDashboardPayload } from "../shared/dashboard";
import {
  MAX_PASSWORD_LENGTH,
  MIN_PASSWORD_LENGTH,
} from "../shared/auth-constraints";
import {
  AuthServiceError,
  createManagedUser,
  normalizeUsername,
} from "./auth-service";
import { getDb } from "./db";
import { provisionBasicEntitlement } from "./basic-entitlement-service";

const usernameSchema = z
  .string()
  .trim()
  .min(3, "Username must contain at least 3 characters")
  .max(64, "Username is too long")
  .regex(
    /^[a-zA-Z0-9._-]+$/,
    "Username may only contain letters, numbers, dots, underscores, and hyphens",
  );
const timestampSchema = z.string().datetime({ offset: true });
const serviceCategorySchema = z.enum([
  "product_scenario",
  "reputation",
  "competitor_comparison",
]);
const idempotencyKeySchema = z
  .string()
  .trim()
  .min(16, "Idempotency-Key must contain 16 to 512 characters")
  .max(512, "Idempotency-Key must contain 16 to 512 characters");

export const websiteProvisionRequestSchema = z
  .object({
    schemaVersion: z.literal(1),
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
        paidAt: timestampSchema,
        serviceCategory: serviceCategorySchema,
        questionId: z.string().trim().min(4).max(80),
        question: z.string().trim().min(4).max(500),
      })
      .strict(),
    contract: z
      .object({
        id: z.string().trim().min(8).max(128),
        status: z.literal("signed"),
        projectId: z.string().trim().min(8).max(80),
        orderId: z.string().trim().min(8).max(64),
        questionId: z.string().trim().min(4).max(80),
        templateVersion: z.string().trim().min(1).max(64),
        documentSha256: z
          .string()
          .trim()
          .regex(/^[a-f0-9]{64}$/i, "Contract SHA-256 is invalid"),
        signedAt: timestampSchema,
        signatoryId: z.string().trim().min(1).max(128),
      })
      .strict(),
    account: z
      .object({
        username: usernameSchema,
        password: z
          .string()
          .min(
            MIN_PASSWORD_LENGTH,
            `Password must contain at least ${MIN_PASSWORD_LENGTH} characters`,
          )
          .max(MAX_PASSWORD_LENGTH, "Password is too long"),
        displayName: z.string().trim().min(1).max(128),
      })
      .strict(),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.contract.projectId !== value.project.id) {
      context.addIssue({
        code: "custom",
        path: ["contract", "projectId"],
        message: "Contract project does not match the provisioned project",
      });
    }
    if (value.contract.orderId !== value.order.id) {
      context.addIssue({
        code: "custom",
        path: ["contract", "orderId"],
        message: "Contract order does not match the paid order",
      });
    }
    if (value.contract.questionId !== value.order.questionId) {
      context.addIssue({
        code: "custom",
        path: ["contract", "questionId"],
        message: "Contract question does not match the paid service",
      });
    }
    if (Date.parse(value.contract.signedAt) < Date.parse(value.order.paidAt)) {
      context.addIssue({
        code: "custom",
        path: ["contract", "signedAt"],
        message: "Contract must be signed after payment",
      });
    }
  });

export type WebsiteProvisionRequest = z.infer<
  typeof websiteProvisionRequestSchema
>;

export type ProvisionedWebsiteUser = {
  provision: {
    id: string;
    projectId: string;
    orderId: string;
    contractId: string;
    status: "completed";
    completedAt: string;
  };
  user: {
    id: number;
    username: string;
    displayName: string | null;
    role: "user";
    isActive: boolean;
  };
  replayed: boolean;
};

export type StoredWebsiteProvision = {
  idempotencyKeyHash: string;
  requestHash: string;
  provision: {
    id: string;
    projectId: string;
    orderId: string;
    contractId: string;
    status: "pending" | "completed";
    completedAt: string | null;
  };
  user: {
    id: number;
    username: string;
    displayName: string | null;
    role: "user";
    isActive: boolean;
  } | null;
};

export type CreateProvisionRecord = {
  id: string;
  idempotencyKeyHash: string;
  requestHash: string;
  request: WebsiteProvisionRequest;
  account: {
    username: string;
    password: string;
    displayName: string;
    role: "user";
  };
  now: Date;
};

export interface WebsiteProvisioningRepository {
  findByIdempotencyKeyHash(
    idempotencyKeyHash: string,
  ): Promise<StoredWebsiteProvision | null>;
  createAtomically(
    input: CreateProvisionRecord,
  ): Promise<StoredWebsiteProvision>;
}

export type ProvisionWebsiteUserInput = {
  idempotencyKey: string;
  request: WebsiteProvisionRequest;
};

export type ProvisionWebsiteUserOptions = {
  repository?: WebsiteProvisioningRepository;
  requestHashKey?: string;
  now?: () => Date;
};

export type ProvisioningErrorCode =
  | "PROVISIONING_NOT_CONFIGURED"
  | "IDEMPOTENCY_CONFLICT"
  | "IDEMPOTENCY_PENDING"
  | "PROVISIONING_RESOURCE_CONFLICT"
  | "USERNAME_CONFLICT"
  | "DATABASE_UNAVAILABLE";

export class ProvisioningError extends Error {
  constructor(
    public readonly code: ProvisioningErrorCode,
    message: string,
    public readonly status: number,
    public readonly retryAfterMs?: number,
  ) {
    super(message);
    this.name = "ProvisioningError";
  }
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
  }
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .filter((key) => record[key] !== undefined)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
    .join(",")}}`;
}

export function hashProvisioningIdempotencyKey(value: string) {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

export function hashProvisioningRequest(
  request: WebsiteProvisionRequest,
  secret: string,
) {
  return createHmac("sha256", secret)
    .update(canonicalJson(request), "utf8")
    .digest("hex");
}

function isDuplicateEntry(error: unknown) {
  return (
    Boolean(error) &&
    typeof error === "object" &&
    (error as { code?: string }).code === "ER_DUP_ENTRY"
  );
}

function publicResult(
  stored: StoredWebsiteProvision,
  replayed: boolean,
): ProvisionedWebsiteUser {
  if (
    stored.provision.status !== "completed" ||
    !stored.provision.completedAt ||
    !stored.user
  ) {
    throw new ProvisioningError(
      "IDEMPOTENCY_PENDING",
      "The same account provision is still being processed",
      425,
      1_000,
    );
  }
  return {
    provision: {
      ...stored.provision,
      status: "completed",
      completedAt: stored.provision.completedAt,
    },
    user: stored.user,
    replayed,
  };
}

function resolveReplay(stored: StoredWebsiteProvision, requestHash: string) {
  if (stored.requestHash !== requestHash) {
    throw new ProvisioningError(
      "IDEMPOTENCY_CONFLICT",
      "The idempotency key has already been used for a different request",
      409,
    );
  }
  if (stored.provision.status !== "completed") {
    throw new ProvisioningError(
      "IDEMPOTENCY_PENDING",
      "The same account provision is still being processed",
      425,
      1_000,
    );
  }
  return publicResult(stored, true);
}

export async function provisionWebsiteUser(
  input: ProvisionWebsiteUserInput,
  options: ProvisionWebsiteUserOptions = {},
): Promise<ProvisionedWebsiteUser> {
  const request = websiteProvisionRequestSchema.parse(input.request);
  const idempotencyKey = idempotencyKeySchema.parse(input.idempotencyKey);
  const requestHashKey =
    options.requestHashKey ??
    process.env.FRONTMIND_PROVISIONING_SERVICE_TOKEN?.trim() ??
    "";
  if (requestHashKey.length < 32) {
    throw new ProvisioningError(
      "PROVISIONING_NOT_CONFIGURED",
      "Website account provisioning is not configured",
      503,
    );
  }

  const idempotencyKeyHash = hashProvisioningIdempotencyKey(idempotencyKey);
  const requestHash = hashProvisioningRequest(request, requestHashKey);
  const repository =
    options.repository ?? new DrizzleWebsiteProvisioningRepository();
  const existing =
    await repository.findByIdempotencyKeyHash(idempotencyKeyHash);
  if (existing) return resolveReplay(existing, requestHash);

  try {
    const stored = await repository.createAtomically({
      id: randomUUID(),
      idempotencyKeyHash,
      requestHash,
      request,
      account: {
        username: normalizeUsername(request.account.username),
        password: request.account.password,
        displayName: request.account.displayName.trim(),
        role: "user",
      },
      now: options.now?.() ?? new Date(),
    });
    return publicResult(stored, false);
  } catch (error) {
    if (isDuplicateEntry(error)) {
      const raced =
        await repository.findByIdempotencyKeyHash(idempotencyKeyHash);
      if (raced) return resolveReplay(raced, requestHash);
      throw new ProvisioningError(
        "PROVISIONING_RESOURCE_CONFLICT",
        "The paid order or signed contract has already been provisioned",
        409,
      );
    }
    if (error instanceof AuthServiceError) {
      if (error.code === "CONFLICT") {
        throw new ProvisioningError(
          "USERNAME_CONFLICT",
          "Username already exists",
          409,
        );
      }
      if (error.code === "DATABASE_UNAVAILABLE") {
        throw new ProvisioningError(
          "DATABASE_UNAVAILABLE",
          "The account database is unavailable",
          503,
        );
      }
    }
    throw error;
  }
}

class DrizzleWebsiteProvisioningRepository
  implements WebsiteProvisioningRepository
{
  async findByIdempotencyKeyHash(idempotencyKeyHash: string) {
    const db = await requireProvisioningDb();
    return readStoredProvision(db, idempotencyKeyHash);
  }

  async createAtomically(input: CreateProvisionRecord) {
    const db = await requireProvisioningDb();
    return db.transaction(async (tx) => {
      const request = input.request;
      await tx.insert(websiteUserProvisions).values({
        id: input.id,
        idempotencyKeyHash: input.idempotencyKeyHash,
        requestHash: input.requestHash,
        projectId: request.project.id,
        companyName: request.project.companyName,
        orderId: request.order.id,
        tradeNo: request.order.tradeNo,
        amountFen: request.order.amountFen,
        paidAt: new Date(request.order.paidAt),
        serviceCategory: request.order.serviceCategory,
        questionId: request.order.questionId,
        question: request.order.question,
        contractId: request.contract.id,
        contractTemplateVersion: request.contract.templateVersion,
        contractDocumentSha256: request.contract.documentSha256.toLowerCase(),
        contractSignedAt: new Date(request.contract.signedAt),
        signatoryId: request.contract.signatoryId,
        requestedUsername: input.account.username,
        requestedDisplayName: input.account.displayName,
        status: "pending",
        createdAt: input.now,
        updatedAt: input.now,
      });

      const user = await createManagedUser(
        {
          username: input.account.username,
          password: input.account.password,
          displayName: input.account.displayName,
          role: "user",
        },
        tx,
      );
      await tx.insert(userDashboardContents).values({
        userId: user.id,
        payload: createDefaultDashboardPayload(request.project.companyName),
        sourceName: `官网售前开通 · ${request.project.id}`.slice(0, 512),
        revision: 1,
        updatedByUserId: null,
        createdAt: input.now,
        updatedAt: input.now,
      });
      await provisionBasicEntitlement(tx, {
        userId: user.id,
        orderId: request.order.id,
        projectId: request.project.id,
        questionId: request.order.questionId,
        question: request.order.question,
        category: request.order.serviceCategory,
        startsAt: new Date(request.order.paidAt),
        amountFen: request.order.amountFen,
        currency: "CNY",
        externalContractReference: request.contract.id,
        signedAt: new Date(request.contract.signedAt),
        signatoryId: request.contract.signatoryId,
        signingEvidence: {
          templateVersion: request.contract.templateVersion,
          documentSha256: request.contract.documentSha256,
        },
        actorUserId: null,
        now: input.now,
      });
      const completedAt = new Date();
      await tx
        .update(websiteUserProvisions)
        .set({
          userId: user.id,
          status: "completed",
          completedAt,
          updatedAt: completedAt,
        })
        .where(eq(websiteUserProvisions.id, input.id));

      return {
        idempotencyKeyHash: input.idempotencyKeyHash,
        requestHash: input.requestHash,
        provision: {
          id: input.id,
          projectId: request.project.id,
          orderId: request.order.id,
          contractId: request.contract.id,
          status: "completed" as const,
          completedAt: completedAt.toISOString(),
        },
        user: {
          id: user.id,
          username: user.username,
          displayName: user.displayName,
          role: "user" as const,
          isActive: user.isActive,
        },
      };
    });
  }
}

async function requireProvisioningDb() {
  const db = await getDb();
  if (!db) {
    throw new ProvisioningError(
      "DATABASE_UNAVAILABLE",
      "The account database is unavailable",
      503,
    );
  }
  return db;
}

async function readStoredProvision(
  executor: any,
  idempotencyKeyHash: string,
): Promise<StoredWebsiteProvision | null> {
  const rows = await executor
    .select()
    .from(websiteUserProvisions)
    .where(eq(websiteUserProvisions.idempotencyKeyHash, idempotencyKeyHash))
    .limit(1);
  const provision = rows[0] as WebsiteUserProvision | undefined;
  if (!provision) return null;
  if (!provision.contractId) {
    throw new ProvisioningError(
      "DATABASE_UNAVAILABLE",
      "The legacy provision record is missing its electronic contract id",
      503,
    );
  }
  if (
    provision.status !== "completed" ||
    !provision.userId ||
    !provision.completedAt
  ) {
    return {
      idempotencyKeyHash: provision.idempotencyKeyHash,
      requestHash: provision.requestHash,
      provision: {
        id: provision.id,
        projectId: provision.projectId,
        orderId: provision.orderId,
        contractId: provision.contractId,
        status: "pending",
        completedAt: null,
      },
      user: null,
    };
  }
  const userRows = await executor
    .select({
      id: users.id,
      username: users.username,
      displayName: users.displayName,
      role: users.role,
      isActive: users.isActive,
    })
    .from(users)
    .where(eq(users.id, provision.userId))
    .limit(1);
  const user = userRows[0];
  if (!user || !user.username || user.role !== "user") {
    throw new ProvisioningError(
      "DATABASE_UNAVAILABLE",
      "The provisioned account record is incomplete",
      503,
    );
  }
  return {
    idempotencyKeyHash: provision.idempotencyKeyHash,
    requestHash: provision.requestHash,
    provision: {
      id: provision.id,
      projectId: provision.projectId,
      orderId: provision.orderId,
      contractId: provision.contractId,
      status: "completed",
      completedAt: provision.completedAt.toISOString(),
    },
    user: {
      id: user.id,
      username: user.username,
      displayName: user.displayName,
      role: "user",
      isActive: user.isActive,
    },
  };
}
