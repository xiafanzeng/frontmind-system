import {
  createHmac,
  randomBytes,
  randomUUID,
  timingSafeEqual,
} from "node:crypto";
import { and, eq, isNull, lt } from "drizzle-orm";
import { z } from "zod";

import { dashboardImportPreflights } from "../drizzle/schema";
import {
  dashboardAdminImportModuleSchema,
  type DashboardAdminImportModule,
} from "../shared/dashboard";
import { getDb } from "./db";

const DEFAULT_TTL_SECONDS = 5 * 60;
const MIN_SECRET_LENGTH = 32;
const EPHEMERAL_NON_PRODUCTION_SECRET = randomBytes(48).toString("base64url");

export const securedImportModuleSchema = z.union([
  dashboardAdminImportModuleSchema,
  z.literal("website-content"),
]);
export type SecuredImportModule =
  | DashboardAdminImportModule
  | "website-content";

const preflightTokenPayloadSchema = z
  .object({
    version: z.literal(1),
    nonce: z.string().uuid(),
    actorId: z.number().int().positive(),
    workspaceUserId: z.number().int().positive(),
    module: securedImportModuleSchema,
    revision: z.number().int().nonnegative(),
    fileHash: z.string().regex(/^[a-f0-9]{64}$/),
    sectionId: z.string().trim().min(1).max(80).optional(),
    targetBatchKey: z.string().trim().min(1).max(191).optional(),
    issuedAt: z.number().int().positive(),
    expiresAt: z.number().int().positive(),
  })
  .strict();

type PreflightTokenPayload = z.infer<typeof preflightTokenPayloadSchema>;

export type DashboardImportPreflightBinding = {
  actorId: number;
  workspaceUserId: number;
  module: SecuredImportModule;
  revision: number;
  fileHash: string;
  sectionId?: string;
  targetBatchKey?: string;
};

export type DashboardImportPreflightRecord = DashboardImportPreflightBinding & {
  nonce: string;
  expiresAt: Date;
  consumedAt: Date | null;
};

export type DashboardImportPreflightStore = {
  issue(record: DashboardImportPreflightRecord): Promise<void>;
  consume(
    binding: DashboardImportPreflightRecord,
    now: Date,
  ): Promise<DashboardImportPreflightRecord | null>;
};

export class DashboardImportPreflightError extends Error {
  readonly statusCode = 409;

  constructor(
    readonly code:
      | "DASHBOARD_IMPORT_PREFLIGHT_REQUIRED"
      | "DASHBOARD_IMPORT_PREFLIGHT_INVALID"
      | "DASHBOARD_IMPORT_PREFLIGHT_EXPIRED"
      | "DASHBOARD_IMPORT_PREFLIGHT_BINDING_MISMATCH"
      | "DASHBOARD_IMPORT_PREFLIGHT_REPLAYED",
    message: string,
  ) {
    super(message);
    this.name = "DashboardImportPreflightError";
  }
}

function normalizedOptional(value: string | undefined) {
  const normalized = value?.trim();
  return normalized || undefined;
}

function normalizedBinding(
  input: DashboardImportPreflightBinding,
): DashboardImportPreflightBinding {
  return {
    actorId: input.actorId,
    workspaceUserId: input.workspaceUserId,
    module: securedImportModuleSchema.parse(input.module),
    revision: input.revision,
    fileHash: input.fileHash.trim().toLowerCase(),
    ...(normalizedOptional(input.sectionId)
      ? { sectionId: normalizedOptional(input.sectionId) }
      : {}),
    ...(normalizedOptional(input.targetBatchKey)
      ? { targetBatchKey: normalizedOptional(input.targetBatchKey) }
      : {}),
  };
}

function ttlSeconds(env: NodeJS.ProcessEnv = process.env) {
  const configured = Number(
    env.FRONTMIND_DASHBOARD_IMPORT_PREFLIGHT_TTL_SECONDS,
  );
  if (!Number.isInteger(configured)) return DEFAULT_TTL_SECONDS;
  return Math.max(60, Math.min(15 * 60, configured));
}

export function dashboardImportPreflightSecret(
  env: NodeJS.ProcessEnv = process.env,
) {
  const configured =
    env.FRONTMIND_DASHBOARD_IMPORT_PREFLIGHT_SECRET?.trim() || "";
  if (configured.length >= MIN_SECRET_LENGTH) return configured;
  if (env.NODE_ENV === "production") {
    throw new Error(
      `FRONTMIND_DASHBOARD_IMPORT_PREFLIGHT_SECRET must contain at least ${MIN_SECRET_LENGTH} characters in production`,
    );
  }
  if (configured) {
    throw new Error(
      `FRONTMIND_DASHBOARD_IMPORT_PREFLIGHT_SECRET must contain at least ${MIN_SECRET_LENGTH} characters`,
    );
  }
  return EPHEMERAL_NON_PRODUCTION_SECRET;
}

export function assertDashboardImportPreflightConfigured(
  env: NodeJS.ProcessEnv = process.env,
) {
  dashboardImportPreflightSecret(env);
}

function signature(encodedPayload: string, secret: string) {
  return createHmac("sha256", secret)
    .update(encodedPayload)
    .digest("base64url");
}

function signedToken(payload: PreflightTokenPayload, secret: string) {
  const encodedPayload = Buffer.from(JSON.stringify(payload), "utf8").toString(
    "base64url",
  );
  return `${encodedPayload}.${signature(encodedPayload, secret)}`;
}

function parseSignedToken(token: string, secret: string) {
  const normalized = token.trim();
  if (!normalized || normalized.length > 4_096) {
    throw new DashboardImportPreflightError(
      "DASHBOARD_IMPORT_PREFLIGHT_REQUIRED",
      "发布前必须先完成文件预检。",
    );
  }
  const parts = normalized.split(".");
  if (parts.length !== 2 || !parts[0] || !parts[1]) {
    throw new DashboardImportPreflightError(
      "DASHBOARD_IMPORT_PREFLIGHT_INVALID",
      "预检凭证格式无效，请重新预检文件。",
    );
  }
  const expected = Buffer.from(signature(parts[0], secret));
  const supplied = Buffer.from(parts[1]);
  if (
    expected.length !== supplied.length ||
    !timingSafeEqual(expected, supplied)
  ) {
    throw new DashboardImportPreflightError(
      "DASHBOARD_IMPORT_PREFLIGHT_INVALID",
      "预检凭证签名无效，请重新预检文件。",
    );
  }
  try {
    return preflightTokenPayloadSchema.parse(
      JSON.parse(Buffer.from(parts[0], "base64url").toString("utf8")),
    );
  } catch {
    throw new DashboardImportPreflightError(
      "DASHBOARD_IMPORT_PREFLIGHT_INVALID",
      "预检凭证内容无效，请重新预检文件。",
    );
  }
}

function sameBinding(
  left: DashboardImportPreflightBinding,
  right: DashboardImportPreflightBinding,
) {
  return (
    left.actorId === right.actorId &&
    left.workspaceUserId === right.workspaceUserId &&
    left.module === right.module &&
    left.revision === right.revision &&
    left.fileHash === right.fileHash &&
    normalizedOptional(left.sectionId) ===
      normalizedOptional(right.sectionId) &&
    normalizedOptional(left.targetBatchKey) ===
      normalizedOptional(right.targetBatchKey)
  );
}

export function dashboardImportPreflightStoreForExecutor(
  executor: any,
): DashboardImportPreflightStore {
  return {
    async issue(record) {
      await executor.insert(dashboardImportPreflights).values({
        id: record.nonce,
        actorUserId: record.actorId,
        workspaceUserId: record.workspaceUserId,
        module: record.module,
        dashboardRevision: record.revision,
        fileHash: record.fileHash,
        sectionId: record.sectionId ?? null,
        targetBatchKey: record.targetBatchKey ?? null,
        expiresAt: record.expiresAt,
        consumedAt: record.consumedAt,
      });
    },
    async consume(binding, now) {
      const rows = await executor
        .select()
        .from(dashboardImportPreflights)
        .where(eq(dashboardImportPreflights.id, binding.nonce))
        .limit(1)
        .for("update");
      const row = rows[0];
      if (!row || row.consumedAt || row.expiresAt.getTime() <= now.getTime()) {
        return null;
      }
      const stored: DashboardImportPreflightRecord = {
        nonce: row.id,
        actorId: row.actorUserId,
        workspaceUserId: row.workspaceUserId,
        module: securedImportModuleSchema.parse(row.module),
        revision: row.dashboardRevision,
        fileHash: row.fileHash,
        ...(row.sectionId ? { sectionId: row.sectionId } : {}),
        ...(row.targetBatchKey ? { targetBatchKey: row.targetBatchKey } : {}),
        expiresAt: row.expiresAt,
        consumedAt: row.consumedAt,
      };
      if (
        stored.nonce !== binding.nonce ||
        stored.expiresAt.getTime() !== binding.expiresAt.getTime() ||
        !sameBinding(stored, binding)
      ) {
        return null;
      }
      await executor
        .update(dashboardImportPreflights)
        .set({ consumedAt: now })
        .where(
          and(
            eq(dashboardImportPreflights.id, binding.nonce),
            isNull(dashboardImportPreflights.consumedAt),
          ),
        );
      return { ...stored, consumedAt: now };
    },
  };
}

async function databaseStore(): Promise<DashboardImportPreflightStore> {
  const db = await getDb();
  if (!db) {
    throw new Error(
      "Database is required to issue and consume dashboard import preflight tokens",
    );
  }
  const direct = dashboardImportPreflightStoreForExecutor(db);
  return {
    issue: direct.issue,
    async consume(binding, now) {
      return db.transaction((tx) =>
        dashboardImportPreflightStoreForExecutor(tx).consume(binding, now),
      );
    },
  };
}

export async function issueDashboardImportPreflight(input: {
  binding: DashboardImportPreflightBinding;
  now?: Date;
  ttlSeconds?: number;
  secret?: string;
  store?: DashboardImportPreflightStore;
}) {
  const binding = normalizedBinding(input.binding);
  const now = input.now ?? new Date();
  const configuredTtl = input.ttlSeconds ?? ttlSeconds();
  const expiresAt = new Date(now.getTime() + configuredTtl * 1_000);
  const nonce = randomUUID();
  const payload = preflightTokenPayloadSchema.parse({
    version: 1,
    nonce,
    ...binding,
    issuedAt: Math.floor(now.getTime() / 1_000),
    expiresAt: Math.floor(expiresAt.getTime() / 1_000),
  });
  const store = input.store ?? (await databaseStore());
  await store.issue({
    nonce,
    ...binding,
    expiresAt: new Date(payload.expiresAt * 1_000),
    consumedAt: null,
  });
  return {
    preflightToken: signedToken(
      payload,
      input.secret ?? dashboardImportPreflightSecret(),
    ),
    preflightExpiresAt: new Date(payload.expiresAt * 1_000).toISOString(),
  };
}

export async function consumeDashboardImportPreflight(input: {
  token: string | undefined;
  binding: DashboardImportPreflightBinding;
  now?: Date;
  secret?: string;
  store?: DashboardImportPreflightStore;
}) {
  const now = input.now ?? new Date();
  const payload = parseSignedToken(
    input.token || "",
    input.secret ?? dashboardImportPreflightSecret(),
  );
  if (payload.expiresAt * 1_000 <= now.getTime()) {
    throw new DashboardImportPreflightError(
      "DASHBOARD_IMPORT_PREFLIGHT_EXPIRED",
      "预检凭证已过期，请重新预检文件。",
    );
  }
  const requested = normalizedBinding(input.binding);
  const tokenBinding: DashboardImportPreflightBinding = {
    actorId: payload.actorId,
    workspaceUserId: payload.workspaceUserId,
    module: payload.module,
    revision: payload.revision,
    fileHash: payload.fileHash,
    ...(payload.sectionId ? { sectionId: payload.sectionId } : {}),
    ...(payload.targetBatchKey
      ? { targetBatchKey: payload.targetBatchKey }
      : {}),
  };
  if (!sameBinding(tokenBinding, requested)) {
    throw new DashboardImportPreflightError(
      "DASHBOARD_IMPORT_PREFLIGHT_BINDING_MISMATCH",
      "预检凭证与当前用户、模块、版本或文件不匹配，请重新预检。",
    );
  }
  const store = input.store ?? (await databaseStore());
  const consumed = await store.consume(
    {
      nonce: payload.nonce,
      ...tokenBinding,
      expiresAt: new Date(payload.expiresAt * 1_000),
      consumedAt: null,
    },
    now,
  );
  if (!consumed) {
    throw new DashboardImportPreflightError(
      "DASHBOARD_IMPORT_PREFLIGHT_REPLAYED",
      "预检凭证已使用、已过期或不存在，请重新预检文件。",
    );
  }
  return consumed;
}

export async function cleanupExpiredDashboardImportPreflights(
  now = new Date(),
) {
  const db = await getDb();
  if (!db) return 0;
  const result = await db
    .delete(dashboardImportPreflights)
    .where(lt(dashboardImportPreflights.expiresAt, now));
  const metadata = result as unknown as {
    rowsAffected?: number;
    affectedRows?: number;
  };
  return metadata.rowsAffected ?? metadata.affectedRows ?? 0;
}

export function startDashboardImportPreflightCleanupScheduler() {
  const run = () =>
    cleanupExpiredDashboardImportPreflights().catch((error) => {
      console.error("[Dashboard import preflight] Cleanup failed", error);
    });
  const initial = setTimeout(run, 60_000);
  initial.unref?.();
  const interval = setInterval(run, 6 * 60 * 60 * 1_000);
  interval.unref?.();
  return () => {
    clearTimeout(initial);
    clearInterval(interval);
  };
}
