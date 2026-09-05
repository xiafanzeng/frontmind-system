import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
  randomUUID,
  scrypt as nodeScrypt,
  timingSafeEqual,
} from "node:crypto";
import { parse as parseCookieHeader } from "cookie";
import {
  and,
  asc,
  desc,
  eq,
  gt,
  inArray,
  isNotNull,
  isNull,
  ne,
  or,
  sql,
} from "drizzle-orm";
import type { Request } from "express";
import { COOKIE_NAME } from "../shared/const";
import {
  DEFAULT_MANAGED_AGENT_PROFILE,
  managedAgentProfileModel,
  normalizeManagedAgentProfile,
  type ManagedAgentProfile,
} from "../shared/manus-agent-profile";
import {
  isExplicitAdminAccessLevel,
  isProtectedBuiltinAdminUsername,
} from "../shared/admin-access";
import {
  agentOperations,
  apiCredentials,
  apiKeyOwnership,
  attachments,
  conversations,
  conversationTurns,
  deliveryProjectAssignments,
  deliveryRedirectPreviews,
  deliveryTicketAttachments,
  deliveryTickets,
  knowledgeBaseBuilds,
  knowledgeBaseResetRequests,
  presalesApiCredentials,
  providerFileLeases,
  sessions,
  upstreamResources,
  userAdminAssignments,
  userPasswordSetupTokens,
  userUsageOwners,
  users,
  visualCandidatePools,
  websiteStyleSampleBatches,
  websiteStyleSamples,
  websiteUserProvisions,
  workspaceAuditEvents,
  type ApiCredential,
  type UpstreamResource,
  type User,
} from "../drizzle/schema";
import { getDb } from "./db";
import { isFileResourceContentExpired } from "./file-content-retention";
import { removeStoredPresalesFile } from "./presales-file-store";
import { getUpstreamBaseUrl } from "./upstream-config";
import { ManusV2ApiError, ManusV2Client } from "./manus-v2-client";
import {
  acquireManagedUploadDeletionFence,
  advanceManagedUploadAccountDeletionFence,
  assertManagedUploadScopesAvailable,
  assertCredentialDeletionFenceToken,
  completeManagedUploadDeletionFence,
  listManagedUploadCredentialDeletionFenceScopes,
  listManagedUploadUserDeletionFences,
  ManagedUploadDeletionFenceError,
  reconcileStaleManagedUploadDeletionFence,
  replayManagedUploadRetirementForDeletedAccount,
  retireManagedUploadIntentsForAccountDeletion,
  rollbackManagedUploadDeletionFence,
  startManagedUploadDeletionFenceHeartbeat,
  type ManagedUploadDeletionFenceToken,
  type ManagedUploadAccountProviderCleanupTarget,
} from "./managed-upload-intent-fence";

export const SESSION_DURATION_MS = 30 * 24 * 60 * 60 * 1000;
export const MANAGED_ACCOUNT_SETUP_DURATION_MS = 48 * 60 * 60 * 1000;

const SCRYPT_VERSION = "v1";
const SCRYPT_N = 16_384;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const SCRYPT_KEY_LENGTH = 64;
const LOGIN_WINDOW_MS = 15 * 60 * 1000;
const LOGIN_MAX_FAILURES = 5;
const DUMMY_PASSWORD_HASH =
  "scrypt$v1$16384$8$1$RnJvbnRNaW5kRHVtbXkwMQ==$v5gxAmM2/2xmlb6BhcM2tE6ivMw+PG8CtewPcO0jJcY86Ak1/I0770tV9pqMocaZiA4z4hu7Obq9HgC6hFn4qw==";

export type AuthServiceErrorCode =
  | "ACCOUNT_DISABLED"
  | "CONFLICT"
  | "DATABASE_UNAVAILABLE"
  | "INVALID_CREDENTIAL"
  | "IDEMPOTENCY_PENDING"
  | "INVALID_MASTER_KEY"
  | "INVALID_PASSWORD"
  | "LAST_ADMIN"
  | "NOT_FOUND"
  | "PROJECT_DELETED"
  | "RATE_LIMITED"
  | "UPSTREAM_UNAVAILABLE";

export class AuthServiceError extends Error {
  constructor(
    public readonly code: AuthServiceErrorCode,
    message: string,
    public readonly retryAfterMs?: number,
  ) {
    super(message);
    this.name = "AuthServiceError";
  }
}

export type UsageOwnerAdminMutation =
  | "change_access_level"
  | "deactivate"
  | "delete";

/**
 * An administrator may be the runtime credential and billing parent for rows
 * in `user_usage_owners`. That relationship must be transferred explicitly
 * before the administrator account can be disabled or deleted.
 */
export function assertAdminHasNoUsageOwnedUsers(input: {
  ownedUserCount: number;
  mutation: UsageOwnerAdminMutation;
}) {
  if (input.ownedUserCount <= 0) return;

  const actionLabel =
    input.mutation === "change_access_level"
      ? "调整管理员权限"
      : input.mutation === "deactivate"
        ? "停用管理员"
        : "删除管理员";
  throw new AuthServiceError(
    "CONFLICT",
    `该管理员仍负责用户，请先转移这些用户的 Key 与积分归属，再${actionLabel}`,
  );
}

export function assertAdminHasNoHistoricalCredentialResources(
  referencedResourceCount: number,
) {
  if (referencedResourceCount <= 0) return;
  throw new AuthServiceError(
    "CONFLICT",
    "该管理员的历史 Key 仍关联客户任务或文件，不能永久删除；可以停用账号并保留历史成果",
  );
}

export type AuthenticatedUser = Omit<
  Pick<
    User,
    | "id"
    | "openId"
    | "username"
    | "displayName"
    | "name"
    | "email"
    | "loginMethod"
    | "role"
    | "isActive"
    | "createdAt"
    | "updatedAt"
    | "lastSignedIn"
  >,
  "username" | "displayName"
> & {
  username: string;
  displayName: string | null;
  /** Missing or null values never confer administrator access. */
  adminAccessLevel?: User["adminAccessLevel"];
  engineerRoleType?: User["engineerRoleType"];
  marketEdition?: User["marketEdition"];
};

export type DecryptedCredential = {
  id: string;
  userId: number;
  version: number;
  apiKey: string;
  fingerprint: string;
  status: "active" | "retired";
  verifiedAt: Date | null;
  agentProfile: ManagedAgentProfile;
  upstreamModel: "manus-1.6" | "manus-1.6-max";
};

export type KnowledgeBaseUploadReservationCredential = DecryptedCredential & {
  reservation: {
    clientRequestId: string;
    sourceResetRevision: number;
    attachmentManifest: Array<{
      filename: string;
      sizeBytes: number;
      mimeType: string;
      lastModified: number;
      sha256: string;
      itemId?: string;
      ordinal?: number;
      total?: number;
    }>;
    stagedAttachmentCount: number;
  };
};

export type CredentialStatus = {
  configured: boolean;
  version: number;
  fingerprint: string | null;
  status: "active" | "retired" | "invalid" | null;
  verifiedAt: number | null;
  agentProfile: ManagedAgentProfile;
  upstreamModel: "manus-1.6" | "manus-1.6-max";
};

type LoginAttempt = {
  failures: number;
  resetAt: number;
};

const loginAttempts = new Map<string, LoginAttempt>();

function toAuthenticatedUser(user: User): AuthenticatedUser {
  const username = user.username ?? user.openId ?? `legacy-${user.id}`;
  return {
    id: user.id,
    openId: user.openId,
    username,
    displayName: user.displayName ?? user.name ?? username,
    name: user.name,
    email: user.email,
    loginMethod: user.loginMethod,
    role: user.role,
    adminAccessLevel: user.adminAccessLevel,
    engineerRoleType: user.engineerRoleType,
    marketEdition: user.marketEdition,
    isActive: user.isActive,
    createdAt: user.createdAt,
    updatedAt: user.updatedAt,
    lastSignedIn: user.lastSignedIn,
  };
}

async function requireDb() {
  const db = await getDb();
  if (!db) {
    throw new AuthServiceError(
      "DATABASE_UNAVAILABLE",
      "Database is not configured",
    );
  }
  return db;
}

function runScrypt(password: string, salt: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    nodeScrypt(
      password,
      salt,
      SCRYPT_KEY_LENGTH,
      {
        N: SCRYPT_N,
        r: SCRYPT_R,
        p: SCRYPT_P,
        maxmem: 64 * 1024 * 1024,
      },
      (error, derivedKey) => {
        if (error) reject(error);
        else resolve(derivedKey);
      },
    );
  });
}

export function normalizeUsername(username: string) {
  return username.normalize("NFKC").trim().toLowerCase();
}

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const derivedKey = await runScrypt(password, salt);
  return [
    "scrypt",
    SCRYPT_VERSION,
    SCRYPT_N,
    SCRYPT_R,
    SCRYPT_P,
    salt.toString("base64"),
    derivedKey.toString("base64"),
  ].join("$");
}

export function isSupportedPasswordHash(encodedHash: string): boolean {
  const parts = encodedHash.split("$");
  if (
    parts.length !== 7 ||
    parts[0] !== "scrypt" ||
    parts[1] !== SCRYPT_VERSION ||
    Number(parts[2]) !== SCRYPT_N ||
    Number(parts[3]) !== SCRYPT_R ||
    Number(parts[4]) !== SCRYPT_P
  ) {
    return false;
  }
  try {
    const canonicalBase64 = (value: string, length: number) => {
      if (!/^[A-Za-z0-9+/]+={0,2}$/.test(value)) return false;
      const decoded = Buffer.from(value, "base64");
      return decoded.length === length && decoded.toString("base64") === value;
    };
    return (
      canonicalBase64(parts[5]!, 16) &&
      canonicalBase64(parts[6]!, SCRYPT_KEY_LENGTH)
    );
  } catch {
    return false;
  }
}

export async function verifyPassword(
  password: string,
  encodedHash: string,
): Promise<boolean> {
  if (!isSupportedPasswordHash(encodedHash)) return false;
  const parts = encodedHash.split("$");

  try {
    const salt = Buffer.from(parts[5]!, "base64");
    const expected = Buffer.from(parts[6]!, "base64");
    if (salt.length !== 16 || expected.length !== SCRYPT_KEY_LENGTH)
      return false;
    const actual = await runScrypt(password, salt);
    return timingSafeEqual(actual, expected);
  } catch {
    return false;
  }
}

export function hashSessionToken(token: string) {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

export function getSessionTokenFromRequest(req: Request): string | null {
  try {
    const cookies = parseCookieHeader(req.headers.cookie ?? "");
    return cookies[COOKIE_NAME] || null;
  } catch {
    return null;
  }
}

export async function createSession(userId: number) {
  const db = await requireDb();
  return createSessionInExecutor(db, userId);
}

async function createSessionInExecutor(executor: any, userId: number) {
  const token = randomBytes(32).toString("base64url");
  const now = Date.now();
  const session = {
    id: randomUUID(),
    userId,
    tokenHash: hashSessionToken(token),
    expiresAt: new Date(now + SESSION_DURATION_MS),
    lastSeenAt: new Date(now),
  };

  await executor.insert(sessions).values(session);
  return { token, session };
}

export async function authenticateRequest(
  req: Request,
): Promise<AuthenticatedUser | null> {
  const token = getSessionTokenFromRequest(req);
  if (!token) return null;

  const db = await getDb();
  if (!db) return null;

  const tokenHash = hashSessionToken(token);
  const rows = await db
    .select({
      user: users,
      lastSeenAt: sessions.lastSeenAt,
      sessionCreatedAt: sessions.createdAt,
    })
    .from(sessions)
    .innerJoin(users, eq(sessions.userId, users.id))
    .where(
      and(
        eq(sessions.tokenHash, tokenHash),
        isNull(sessions.revokedAt),
        gt(sessions.expiresAt, new Date()),
        eq(users.isActive, true),
      ),
    )
    .limit(1);

  const row = rows[0];
  if (!row) return null;
  if (
    sessionPredatesPasswordChange(
      row.sessionCreatedAt,
      row.user.passwordChangedAt,
    )
  ) {
    return null;
  }
  if (
    row.user.role === "admin" &&
    !isExplicitAdminAccessLevel(row.user.adminAccessLevel)
  ) {
    return null;
  }

  if (Date.now() - row.lastSeenAt.getTime() > 5 * 60 * 1000) {
    await db
      .update(sessions)
      .set({ lastSeenAt: new Date() })
      .where(eq(sessions.tokenHash, tokenHash));
  }

  return toAuthenticatedUser(row.user);
}

export async function revokeSessionToken(token: string | null | undefined) {
  if (!token) return;
  const db = await getDb();
  if (!db) return;
  await db
    .update(sessions)
    .set({ revokedAt: new Date() })
    .where(
      and(
        eq(sessions.tokenHash, hashSessionToken(token)),
        isNull(sessions.revokedAt),
      ),
    );
}

export async function revokeAllUserSessions(userId: number) {
  const db = await requireDb();
  await revokeAllUserSessionsInExecutor(db, userId);
}

export function sessionPredatesPasswordChange(
  sessionCreatedAt: Date,
  passwordChangedAt: Date | null,
) {
  return Boolean(
    passwordChangedAt &&
      sessionCreatedAt.getTime() < passwordChangedAt.getTime(),
  );
}

export async function revokeAllUserSessionsInExecutor(
  executor: any,
  userId: number,
  now = new Date(),
) {
  const conditions = [eq(sessions.userId, userId), isNull(sessions.revokedAt)];
  await executor
    .update(sessions)
    .set({ revokedAt: now })
    .where(and(...conditions));
}

/**
 * Password-setup capabilities are issued by both the Dashboard managed-user
 * flow and the Website purchase flow. A committed password change must retire
 * every outstanding capability from both protocols in the same transaction;
 * otherwise an older setup URL could overwrite the newer password later.
 */
export async function consumeAllUserPasswordSetupTokensInExecutor(
  executor: any,
  userId: number,
  now = new Date(),
) {
  await executor
    .update(userPasswordSetupTokens)
    .set({ consumedAt: now, updatedAt: now })
    .where(
      and(
        eq(userPasswordSetupTokens.userId, userId),
        isNull(userPasswordSetupTokens.consumedAt),
      ),
    );
  await executor
    .update(websiteUserProvisions)
    .set({ accountSetupTokenConsumedAt: now, updatedAt: now })
    .where(
      and(
        eq(websiteUserProvisions.userId, userId),
        isNotNull(websiteUserProvisions.accountSetupTokenHash),
        isNull(websiteUserProvisions.accountSetupTokenConsumedAt),
      ),
    );
}

function loginAttemptKey(username: string, clientAddress: string) {
  return `${normalizeUsername(username)}\u0000${clientAddress}`;
}

function assertLoginAllowed(key: string) {
  const attempt = loginAttempts.get(key);
  if (!attempt) return;
  const now = Date.now();
  if (now >= attempt.resetAt) {
    loginAttempts.delete(key);
    return;
  }
  if (attempt.failures >= LOGIN_MAX_FAILURES) {
    throw new AuthServiceError(
      "RATE_LIMITED",
      "Too many login attempts",
      attempt.resetAt - now,
    );
  }
}

function recordLoginFailure(key: string) {
  const now = Date.now();
  const current = loginAttempts.get(key);
  if (!current || now >= current.resetAt) {
    loginAttempts.set(key, { failures: 1, resetAt: now + LOGIN_WINDOW_MS });
  } else {
    current.failures += 1;
  }

  // Bound memory if a public endpoint is sprayed with distinct identifiers.
  if (loginAttempts.size > 10_000) {
    for (const [entryKey, value] of loginAttempts) {
      if (now >= value.resetAt) loginAttempts.delete(entryKey);
      if (loginAttempts.size <= 8_000) break;
    }
  }
}

export async function loginWithPassword(
  username: string,
  password: string,
  clientAddress: string,
) {
  const normalizedUsername = normalizeUsername(username);
  const attemptKey = loginAttemptKey(normalizedUsername, clientAddress);
  assertLoginAllowed(attemptKey);

  const db = await requireDb();
  return db.transaction(async (tx) => {
    const rows = await tx
      .select()
      .from(users)
      .where(eq(users.username, normalizedUsername))
      .limit(1)
      .for("update");
    const user = rows[0];
    const passwordHash = user?.passwordHash ?? DUMMY_PASSWORD_HASH;
    const passwordMatches = await verifyPassword(password, passwordHash);

    if (!user || !passwordMatches) {
      recordLoginFailure(attemptKey);
      throw new AuthServiceError("INVALID_PASSWORD", "用户名或密码不正确");
    }
    if (!user.isActive) {
      recordLoginFailure(attemptKey);
      throw new AuthServiceError("ACCOUNT_DISABLED", "账号已停用");
    }
    if (
      user.role === "admin" &&
      !isExplicitAdminAccessLevel(user.adminAccessLevel)
    ) {
      recordLoginFailure(attemptKey);
      throw new AuthServiceError("ACCOUNT_DISABLED", "管理员权限尚未配置");
    }

    loginAttempts.delete(attemptKey);
    const lastSignedIn = new Date();
    await tx.update(users).set({ lastSignedIn }).where(eq(users.id, user.id));
    const created = await createSessionInExecutor(tx, user.id);
    return {
      user: toAuthenticatedUser({ ...user, lastSignedIn }),
      ...created,
    };
  });
}

export async function changeOwnPassword(
  userId: number,
  currentPassword: string,
  newPassword: string,
) {
  const db = await requireDb();
  const passwordHash = await hashPassword(newPassword);
  await db.transaction(async (tx) => {
    const rows = await tx
      .select()
      .from(users)
      .where(eq(users.id, userId))
      .limit(1)
      .for("update");
    const user = rows[0];
    if (
      !user?.passwordHash ||
      !(await verifyPassword(currentPassword, user.passwordHash))
    ) {
      throw new AuthServiceError(
        "INVALID_PASSWORD",
        "Current password is incorrect",
      );
    }
    const now = new Date();
    await tx
      .update(users)
      .set({ passwordHash, passwordChangedAt: now, updatedAt: now })
      .where(eq(users.id, userId));
    await consumeAllUserPasswordSetupTokensInExecutor(tx, userId, now);
    await revokeAllUserSessionsInExecutor(tx, userId, now);
  });
}

export async function listManagedUsers(): Promise<
  Array<
    AuthenticatedUser & {
      engineerApiKeyConfigured: boolean;
      engineerApiKeyVersion: number;
    }
  >
> {
  const db = await requireDb();
  const [rows, credentialRows] = await Promise.all([
    db.select().from(users).orderBy(desc(users.createdAt)),
    db
      .select({
        userId: apiCredentials.userId,
        version: apiCredentials.version,
        status: apiCredentials.status,
      })
      .from(apiCredentials),
  ]);
  const configuredUserIds = new Set(
    credentialRows
      .filter((row) => row.status === "active")
      .map((row) => row.userId),
  );
  const credentialVersionByUserId = new Map<number, number>();
  for (const credential of credentialRows) {
    credentialVersionByUserId.set(
      credential.userId,
      Math.max(
        credential.version,
        credentialVersionByUserId.get(credential.userId) ?? 0,
      ),
    );
  }
  return rows.map((row) => ({
    ...toAuthenticatedUser(row),
    engineerApiKeyConfigured:
      row.role === "delivery_member" && configuredUserIds.has(row.id),
    engineerApiKeyVersion:
      row.role === "delivery_member"
        ? (credentialVersionByUserId.get(row.id) ?? 0)
        : 0,
  }));
}

export async function getManagedUser(userId: number) {
  const db = await requireDb();
  const rows = await db
    .select()
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);
  return rows[0] ? toAuthenticatedUser(rows[0]) : null;
}

export async function createManagedUser(
  input: {
    username: string;
    password: string;
    displayName?: string | null;
    role: "user" | "admin" | "delivery_member";
    adminAccessLevel?: "system_admin" | "delivery_admin";
    engineerRoleType?: User["engineerRoleType"];
    marketEdition?: "domestic" | "overseas";
  },
  executor?: any,
) {
  const passwordHash = await hashPassword(input.password);
  return createManagedUserWithPasswordHash(
    {
      username: input.username,
      passwordHash,
      displayName: input.displayName,
      role: input.role,
      adminAccessLevel: input.adminAccessLevel,
      engineerRoleType: input.engineerRoleType,
      marketEdition: input.marketEdition,
    },
    executor,
  );
}

/**
 * Creates a login account from a password hash produced by `hashPassword`.
 * This is intentionally an internal server path so multi-step workflows can
 * hash a customer password immediately and never persist or replay plaintext.
 */
export async function createManagedUserWithPasswordHash(
  input: {
    username: string;
    passwordHash: string;
    displayName?: string | null;
    role: "user" | "admin" | "delivery_member";
    adminAccessLevel?: "system_admin" | "delivery_admin";
    engineerRoleType?: User["engineerRoleType"];
    marketEdition?: "domestic" | "overseas";
    now?: Date;
  },
  executor?: any,
) {
  if (!isSupportedPasswordHash(input.passwordHash)) {
    throw new AuthServiceError(
      "INVALID_PASSWORD",
      "Unsupported password hash format",
    );
  }
  const db = executor ?? (await requireDb());
  if (input.role === "delivery_member" && !input.engineerRoleType) {
    throw new AuthServiceError(
      "CONFLICT",
      "创建工程师账号时必须选择工程师岗位",
    );
  }
  if (input.role !== "delivery_member" && input.engineerRoleType) {
    throw new AuthServiceError("CONFLICT", "只有工程师账号可以设置工程师岗位");
  }
  const username = normalizeUsername(input.username);
  const existing = await db
    .select({ id: users.id })
    .from(users)
    .where(eq(users.username, username))
    .limit(1);
  if (existing.length > 0) {
    throw new AuthServiceError("CONFLICT", "Username already exists");
  }

  const now = input.now ?? new Date();
  try {
    await db.insert(users).values({
      username,
      passwordHash: input.passwordHash,
      displayName: input.displayName?.trim() || null,
      name: input.displayName?.trim() || null,
      loginMethod: "password",
      role: input.role,
      adminAccessLevel:
        input.role === "admin"
          ? (input.adminAccessLevel ?? "delivery_admin")
          : null,
      engineerRoleType:
        input.role === "delivery_member" ? input.engineerRoleType : null,
      marketEdition:
        input.role === "user"
          ? (input.marketEdition ?? "domestic")
          : "domestic",
      isActive: true,
      passwordChangedAt: now,
    });
  } catch (error) {
    const mysqlError = error as { code?: string };
    if (mysqlError.code === "ER_DUP_ENTRY") {
      throw new AuthServiceError("CONFLICT", "Username already exists");
    }
    throw error;
  }

  const created = await db
    .select()
    .from(users)
    .where(eq(users.username, username))
    .limit(1);
  if (!created[0]) {
    throw new AuthServiceError("NOT_FOUND", "Created user could not be loaded");
  }
  return toAuthenticatedUser(created[0]);
}

export async function createManagedUserWithSetupToken(
  input: {
    username: string;
    displayName?: string | null;
    createdByUserId: number;
    now?: Date;
    ttlMs?: number;
  },
  executor?: any,
) {
  const db = executor ?? (await requireDb());
  const now = input.now ?? new Date();
  const username = normalizeUsername(input.username);
  const token = randomBytes(32).toString("base64url");
  const placeholderPassword = randomBytes(48).toString("base64url");
  const passwordHash = await hashPassword(placeholderPassword);
  const expiresAt = new Date(
    now.getTime() + (input.ttlMs ?? MANAGED_ACCOUNT_SETUP_DURATION_MS),
  );

  const create = async (tx: any) => {
    const existing = await tx
      .select({ id: users.id })
      .from(users)
      .where(eq(users.username, username))
      .limit(1);
    if (existing.length > 0) {
      throw new AuthServiceError("CONFLICT", "Username already exists");
    }

    try {
      await tx.insert(users).values({
        username,
        passwordHash,
        displayName: input.displayName?.trim() || null,
        name: input.displayName?.trim() || null,
        loginMethod: "password",
        role: "user",
        isActive: true,
        passwordChangedAt: null,
        createdAt: now,
        updatedAt: now,
      });
    } catch (error) {
      if ((error as { code?: string })?.code === "ER_DUP_ENTRY") {
        throw new AuthServiceError("CONFLICT", "Username already exists");
      }
      throw error;
    }

    const created = await tx
      .select()
      .from(users)
      .where(eq(users.username, username))
      .limit(1);
    if (!created[0]) {
      throw new AuthServiceError(
        "NOT_FOUND",
        "Created user could not be loaded",
      );
    }
    await tx.insert(userPasswordSetupTokens).values({
      id: randomUUID(),
      userId: created[0].id,
      tokenHash: hashSessionToken(token),
      expiresAt,
      consumedAt: null,
      createdByUserId: input.createdByUserId,
      createdAt: now,
      updatedAt: now,
    });
    return {
      user: toAuthenticatedUser(created[0]),
      setupToken: token,
      setupExpiresAt: expiresAt,
    };
  };

  return typeof db.transaction === "function"
    ? db.transaction(create)
    : create(db);
}

function assertUsableManagedSetupToken(
  row: typeof userPasswordSetupTokens.$inferSelect | undefined,
  now: Date,
) {
  if (!row || row.consumedAt || row.expiresAt.getTime() <= now.getTime()) {
    throw new AuthServiceError(
      "INVALID_CREDENTIAL",
      "账号设置链接无效、已过期或已使用",
    );
  }
  return row;
}

export async function validateManagedAccountSetupToken(input: {
  token: string;
  now?: Date;
}) {
  const db = await requireDb();
  const now = input.now ?? new Date();
  const rows = await db
    .select()
    .from(userPasswordSetupTokens)
    .where(eq(userPasswordSetupTokens.tokenHash, hashSessionToken(input.token)))
    .limit(1);
  const setup = assertUsableManagedSetupToken(rows[0], now);
  const accountRows = await db
    .select({
      username: users.username,
      displayName: users.displayName,
      role: users.role,
      isActive: users.isActive,
    })
    .from(users)
    .where(eq(users.id, setup.userId))
    .limit(1);
  const account = accountRows[0];
  if (!account || account.role !== "user" || !account.isActive) {
    throw new AuthServiceError(
      "INVALID_CREDENTIAL",
      "账号设置链接无效、已过期或已使用",
    );
  }
  return {
    valid: true as const,
    username: account.username ?? "",
    displayName: account.displayName ?? null,
    expiresAt: setup.expiresAt.getTime(),
  };
}

export async function setupManagedUserPassword(input: {
  token: string;
  password: string;
  now?: Date;
}) {
  const db = await requireDb();
  const now = input.now ?? new Date();
  const passwordHash = await hashPassword(input.password);
  return db.transaction(async (tx) => {
    const rows = await tx
      .select()
      .from(userPasswordSetupTokens)
      .where(
        eq(userPasswordSetupTokens.tokenHash, hashSessionToken(input.token)),
      )
      .limit(1)
      .for("update");
    const setup = assertUsableManagedSetupToken(rows[0], now);
    const accountRows = await tx
      .select()
      .from(users)
      .where(eq(users.id, setup.userId))
      .limit(1)
      .for("update");
    const account = accountRows[0];
    if (!account || account.role !== "user" || !account.isActive) {
      throw new AuthServiceError(
        "INVALID_CREDENTIAL",
        "账号设置链接无效、已过期或已使用",
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
      username: account.username ?? "",
      workspaceUrl: "/login",
    };
  });
}

export async function resetManagedUserPassword(
  userId: number,
  newPassword: string,
) {
  const db = await requireDb();
  const passwordHash = await hashPassword(newPassword);
  const now = new Date();
  await db.transaction(async (tx) => {
    const existing = await tx
      .select({ id: users.id })
      .from(users)
      .where(eq(users.id, userId))
      .limit(1)
      .for("update");
    if (!existing[0]) {
      throw new AuthServiceError("NOT_FOUND", "User not found");
    }
    await tx
      .update(users)
      .set({ passwordHash, passwordChangedAt: now, updatedAt: now })
      .where(eq(users.id, userId));
    await consumeAllUserPasswordSetupTokensInExecutor(tx, userId, now);
    await revokeAllUserSessionsInExecutor(tx, userId, now);
  });
}

export async function setManagedUserActive(userId: number, isActive: boolean) {
  const db = await requireDb();
  await db.transaction(async (tx) => {
    const rows = await tx
      .select()
      .from(users)
      .where(eq(users.id, userId))
      .limit(1)
      .for("update");
    const user = rows[0];
    if (!user) throw new AuthServiceError("NOT_FOUND", "User not found");
    if (
      !isActive &&
      user.isActive &&
      isProtectedBuiltinAdminUsername(user.username)
    ) {
      throw new AuthServiceError(
        "CONFLICT",
        "内置 admin 必须保持为已启用的系统管理员",
      );
    }

    if (!isActive && user.isActive && user.role === "admin") {
      const ownedUsers = await tx
        .select({ userId: userUsageOwners.userId })
        .from(userUsageOwners)
        .where(eq(userUsageOwners.deliveryAdminId, userId))
        .limit(1)
        .for("update");
      assertAdminHasNoUsageOwnedUsers({
        ownedUserCount: ownedUsers.length,
        mutation: "deactivate",
      });

      const administrators = await tx
        .select({
          id: users.id,
          adminAccessLevel: users.adminAccessLevel,
          isActive: users.isActive,
        })
        .from(users)
        .where(eq(users.role, "admin"))
        .orderBy(asc(users.id))
        .for("update");
      const disablingSystemAdmin =
        user.adminAccessLevel === "system_admin" &&
        administrators.every(
          (administrator) =>
            administrator.id === user.id ||
            !administrator.isActive ||
            administrator.adminAccessLevel !== "system_admin",
        );
      if (disablingSystemAdmin) {
        throw new AuthServiceError(
          "LAST_ADMIN",
          "至少需要保留一个已启用的系统管理员",
        );
      }
    }
    if (!isActive && user.isActive && user.role === "delivery_member") {
      const [assignmentRows, ticketRows] = await Promise.all([
        tx
          .select({ id: deliveryProjectAssignments.id })
          .from(deliveryProjectAssignments)
          .where(eq(deliveryProjectAssignments.engineerUserId, userId))
          .limit(1)
          .for("update"),
        tx
          .select({ id: deliveryTickets.id })
          .from(deliveryTickets)
          .where(
            and(
              eq(deliveryTickets.assignedMemberId, userId),
              inArray(deliveryTickets.status, [
                "submitted",
                "needs_information",
                "scheduled",
                "in_progress",
              ]),
            ),
          )
          .limit(1)
          .for("update"),
      ]);
      if (assignmentRows[0] || ticketRows[0]) {
        throw new AuthServiceError(
          "CONFLICT",
          "该工程师仍负责客户项目或未结束需求，请先完成转交",
        );
      }
    }

    await tx.update(users).set({ isActive }).where(eq(users.id, userId));
    if (!isActive) {
      const now = new Date();
      await consumeAllUserPasswordSetupTokensInExecutor(tx, userId, now);
      await revokeAllUserSessionsInExecutor(tx, userId, now);
    }
  });
  const updated = await getManagedUser(userId);
  if (!updated) throw new AuthServiceError("NOT_FOUND", "User not found");
  return updated;
}

export async function permanentlyDeleteManagedUserRows(
  executor: any,
  userId: number,
) {
  // Candidate pools reference style batches, operations, credentials and
  // snapshots restrictively. Delete the account-owned root first; pages and
  // items cascade from it before any of those parent rows are removed.
  await executor
    .delete(visualCandidatePools)
    .where(eq(visualCandidatePools.userId, userId));
  const styleBatchRows = await executor
    .select({ id: websiteStyleSampleBatches.id })
    .from(websiteStyleSampleBatches)
    .where(eq(websiteStyleSampleBatches.userId, userId))
    .for("update");
  const styleBatchIds = styleBatchRows.map((row: { id: string }) => row.id);
  if (styleBatchIds.length > 0) {
    // Samples restrict deletion of their attachment, while both the batch and
    // attachment otherwise cascade from the same ticket. Break that cross-FK
    // edge before deleting either parent.
    await executor
      .delete(websiteStyleSamples)
      .where(inArray(websiteStyleSamples.batchId, styleBatchIds));
    await executor
      .delete(websiteStyleSampleBatches)
      .where(inArray(websiteStyleSampleBatches.id, styleBatchIds));
  }
  // Reset requests restrict deletion of their delivery tickets, while the
  // tickets in turn restrict deletion of their contract/quota parents. Remove
  // this account-owned chain explicitly before deleting the user so MySQL does
  // not depend on an unsafe cascade order.
  await executor
    .delete(knowledgeBaseResetRequests)
    .where(eq(knowledgeBaseResetRequests.userId, userId));
  await executor
    .delete(deliveryRedirectPreviews)
    .where(eq(deliveryRedirectPreviews.userId, userId));
  await executor
    .delete(deliveryTicketAttachments)
    .where(eq(deliveryTicketAttachments.workspaceUserId, userId));
  await executor
    .delete(deliveryTickets)
    .where(eq(deliveryTickets.userId, userId));
  // These security-ledger rows also use restrictive foreign keys. All
  // remaining account-owned rows cascade from users, conversations, and
  // messages.
  await executor
    .delete(upstreamResources)
    .where(eq(upstreamResources.userId, userId));
  await executor
    .delete(apiKeyOwnership)
    .where(eq(apiKeyOwnership.userId, userId));
  await executor.delete(users).where(eq(users.id, userId));
}

/**
 * Invoked only from the deletion-fence retirement channel, which durably
 * claims each Provider file before this callback. Resolve the exact frozen
 * credential and make one idempotent delete attempt; local retained bytes are
 * removed independently of the remote outcome.
 */
export async function discardManagedUploadProviderFileForRetirement(
  target: ManagedUploadAccountProviderCleanupTarget,
  executor?: any,
) {
  try {
    const credential = await getDecryptedCredentialForManagedUploadIntent(
      {
        credentialId: target.credentialId,
        credentialOwnerUserId: target.credentialOwnerUserId,
        credentialVersion: target.credentialVersion,
      },
      executor,
    );
    if (!credential) {
      throw new Error("MANAGED_UPLOAD_RETIREMENT_CREDENTIAL_UNAVAILABLE");
    }
    try {
      await new ManusV2Client({
        baseUrl: getUpstreamBaseUrl(),
        apiKey: credential.apiKey,
        timeoutMs: 5_000,
      }).deleteFile(target.fileId);
    } catch (error) {
      if (!(error instanceof ManusV2ApiError && error.status === 404)) {
        throw error;
      }
    }
  } finally {
    await removeStoredPresalesFile(target.fileId).catch(() => undefined);
  }
}

/**
 * Startup-only, bounded reconciliation for process exit around the final user
 * deletion commit. Database absence is the authority for converting a
 * `deleting` fence to `deleted`; local replay never contacts Provider APIs or
 * reconstructs conversations.
 */
export async function reconcileManagedUploadAccountDeletionFencesOnStartup(
  limit = 25,
) {
  const db = await requireDb();
  const fences = await listManagedUploadUserDeletionFences(limit);
  let deleted = 0;
  let active = 0;
  let failed = 0;
  for (const fence of fences) {
    try {
      const user = await db.transaction(async (tx) => {
        const rows = await tx
          .select({
            id: users.id,
            username: users.username,
            isActive: users.isActive,
          })
          .from(users)
          .where(eq(users.id, fence.scope.userId))
          .limit(1)
          .for("update");
        return rows[0] ?? null;
      });
      if (!user) {
        await reconcileStaleManagedUploadDeletionFence(fence.scope, "deleted");
        await replayManagedUploadRetirementForDeletedAccount(
          fence.scope.userId,
        );
        deleted += 1;
        continue;
      }
      if (
        fence.purpose === "account_deletion" &&
        (fence.accountDeletionPhase === "prepared" ||
          fence.accountDeletionPhase === "retired") &&
        user.isActive === false &&
        !isProtectedBuiltinAdminUsername(user.username)
      ) {
        const token = await acquireManagedUploadDeletionFence(fence.scope, {
          disposition: "cancel_active_intents",
          purpose: "account_deletion",
        });
        // Startup continuation is deliberately local-only. Provider cleanup
        // was either claimed before the crash or remains best-effort; it is
        // never replayed without the initiating administrator's live
        // credential context.
        await retireManagedUploadIntentsForAccountDeletion({
          userId: fence.scope.userId,
          token,
        });
        await advanceManagedUploadAccountDeletionFence(token, "retired");
        const removed = await db.transaction(async (tx) => {
          const rows = await tx
            .select({
              id: users.id,
              username: users.username,
              isActive: users.isActive,
            })
            .from(users)
            .where(eq(users.id, fence.scope.userId))
            .limit(1)
            .for("update");
          const current = rows[0];
          if (!current) return false;
          if (
            current.isActive !== false ||
            isProtectedBuiltinAdminUsername(current.username)
          ) {
            throw new AuthServiceError(
              "CONFLICT",
              "Prepared account deletion no longer has safe startup authority",
            );
          }
          await permanentlyDeleteManagedUserRows(tx, fence.scope.userId);
          await tx.insert(workspaceAuditEvents).values({
            id: randomUUID(),
            actorUserId: null,
            actorUsername: "signed-image-maintenance",
            actorAccessLevel: null,
            action: "account.deleted_after_crash_recovery",
            targetType: "user",
            targetId: String(fence.scope.userId),
            workspaceUserId: fence.scope.userId,
            reason: "durable_account_deletion_fence",
            metadata: {
              disposition: "permanently_deleted",
              recovery: "startup_local_only",
              priorPhase: fence.accountDeletionPhase,
            },
            createdAt: new Date(),
          });
          return true;
        });
        if (removed) {
          await completeManagedUploadDeletionFence(token);
          await replayManagedUploadRetirementForDeletedAccount(
            fence.scope.userId,
          );
          deleted += 1;
          continue;
        }
      }
      if (
        fence.state === "deleting" &&
        fence.leaseExpiresAt &&
        Date.parse(fence.leaseExpiresAt) <= Date.now()
      ) {
        // A permanent-account deletion fence is a resumable tombstone, not a
        // temporary worker lease. Clearing it would re-enable upload
        // capabilities for an account whose preparation transaction may
        // already have disabled login and retired local intents. Any system
        // administrator can resume it through deleteManagedUser.
        if (fence.purpose !== "account_deletion") {
          await reconcileStaleManagedUploadDeletionFence(fence.scope, "active");
        }
      }
      active += 1;
    } catch {
      failed += 1;
    }
  }
  return { scanned: fences.length, deleted, active, failed };
}

export async function deleteManagedUser(
  actorUserId: number,
  targetUserId: number,
  options: {
    onResultInTransaction?: (
      result: {
        disposition: "deactivated_for_history" | "permanently_deleted";
      },
      executor: any,
    ) => Promise<void>;
  } = {},
) {
  if (actorUserId === targetUserId) {
    throw new AuthServiceError(
      "CONFLICT",
      "The current administrator account cannot be deleted",
    );
  }

  const db = await requireDb();
  const scope = { kind: "user" as const, userId: targetUserId };
  let fence: ManagedUploadDeletionFenceToken;
  try {
    fence = await acquireManagedUploadDeletionFence(scope, {
      disposition: "cancel_active_intents",
      purpose: "account_deletion",
    });
  } catch (error) {
    if (error instanceof ManagedUploadDeletionFenceError) {
      const existing = await db.transaction(async (tx) => {
        const rows = await tx
          .select({ id: users.id })
          .from(users)
          .where(eq(users.id, targetUserId))
          .limit(1)
          .for("update");
        await reconcileStaleManagedUploadDeletionFence(
          scope,
          rows[0] ? "active" : "deleted",
        ).catch((reconcileError) => {
          if (
            reconcileError instanceof ManagedUploadDeletionFenceError &&
            reconcileError.code === "DELETION_IN_PROGRESS" &&
            rows[0]
          ) {
            return;
          }
          throw reconcileError;
        });
        return rows[0];
      });
      if (!existing) {
        await replayManagedUploadRetirementForDeletedAccount(
          targetUserId,
        ).catch(() => undefined);
        return {
          disposition: "permanently_deleted" as const,
          replayed: true as const,
        };
      }
      if (error.code === "STALE_DELETION_FENCE") {
        fence = await acquireManagedUploadDeletionFence(scope, {
          disposition: "cancel_active_intents",
          purpose: "account_deletion",
        });
      } else {
        throw new AuthServiceError(
          "CONFLICT",
          "该账号的永久删除正在进行，请稍后重试",
        );
      }
    } else {
      throw error;
    }
  }
  const resumedPermanentDeletion = fence.resumed === true;
  const stopFenceHeartbeat = startManagedUploadDeletionFenceHeartbeat(fence);
  let finalDeletionCommitted = false;
  let permanentDeletionPrepared = false;
  try {
    const preparation = await db.transaction(async (tx) => {
      const transactionResult = await (async () => {
        const rows = await tx
          .select()
          .from(users)
          .where(eq(users.id, targetUserId))
          .limit(1)
          .for("update");
        const user = rows[0];
        if (!user) {
          return {
            disposition: "permanently_deleted" as const,
            replayed: true as const,
          };
        }
        if (isProtectedBuiltinAdminUsername(user.username)) {
          throw new AuthServiceError(
            "CONFLICT",
            "内置 admin 系统管理员不能被删除",
          );
        }
        if (user.role === "delivery_member") {
          const [
            assignmentRows,
            ticketRows,
            projectResourceRows,
            projectConversationRows,
          ] = await Promise.all([
            tx
              .select({ id: deliveryProjectAssignments.id })
              .from(deliveryProjectAssignments)
              .where(
                eq(deliveryProjectAssignments.engineerUserId, targetUserId),
              )
              .limit(1)
              .for("update"),
            tx
              .select({ id: deliveryTickets.id })
              .from(deliveryTickets)
              .where(
                and(
                  eq(deliveryTickets.assignedMemberId, targetUserId),
                  inArray(deliveryTickets.status, [
                    "submitted",
                    "needs_information",
                    "scheduled",
                    "in_progress",
                  ]),
                ),
              )
              .limit(1)
              .for("update"),
            tx
              .select({ id: upstreamResources.id })
              .from(upstreamResources)
              .where(
                and(
                  eq(upstreamResources.userId, targetUserId),
                  isNotNull(upstreamResources.projectAssignmentId),
                ),
              )
              .limit(1)
              .for("update"),
            tx
              .select({ id: conversations.id })
              .from(conversations)
              .where(
                and(
                  eq(conversations.userId, targetUserId),
                  isNotNull(conversations.projectAssignmentId),
                ),
              )
              .limit(1)
              .for("update"),
          ]);
          if (assignmentRows[0] || ticketRows[0]) {
            throw new AuthServiceError(
              "CONFLICT",
              "该工程师仍负责客户项目或未结束需求，请先完成转交",
            );
          }
          if (projectResourceRows[0] || projectConversationRows[0]) {
            const now = new Date();
            await tx
              .update(users)
              .set({ isActive: false, updatedAt: now })
              .where(eq(users.id, targetUserId));
            await consumeAllUserPasswordSetupTokensInExecutor(
              tx,
              targetUserId,
              now,
            );
            await revokeAllUserSessionsInExecutor(tx, targetUserId, now);
            return { disposition: "deactivated_for_history" as const };
          }
        }

        if (user.role === "admin") {
          const protectedAdminRows = await tx
            .select({
              id: users.id,
              adminAccessLevel: users.adminAccessLevel,
              isActive: users.isActive,
            })
            .from(users)
            .where(eq(users.username, "admin"))
            .limit(1)
            .for("update");
          const protectedAdmin = protectedAdminRows[0];
          if (
            !protectedAdmin ||
            protectedAdmin.adminAccessLevel !== "system_admin" ||
            !protectedAdmin.isActive
          ) {
            throw new AuthServiceError(
              "CONFLICT",
              "内置 admin 未保持启用的系统管理员状态，无法安全交接客户",
            );
          }
          const ownedUsers = await tx
            .select({
              userId: userUsageOwners.userId,
              revision: userUsageOwners.revision,
            })
            .from(userUsageOwners)
            .where(eq(userUsageOwners.deliveryAdminId, targetUserId))
            .for("update");
          const assignedUsers = await tx
            .select({ userId: userAdminAssignments.userId })
            .from(userAdminAssignments)
            .where(eq(userAdminAssignments.adminId, targetUserId))
            .for("update");
          const historicalResources = await tx
            .select({ id: upstreamResources.id })
            .from(upstreamResources)
            .innerJoin(
              apiCredentials,
              eq(upstreamResources.apiCredentialId, apiCredentials.id),
            )
            .where(
              and(
                eq(apiCredentials.userId, targetUserId),
                ne(upstreamResources.userId, targetUserId),
              ),
            )
            .limit(1)
            .for("update");
          const retainHistoricalAccount = historicalResources.length > 0;

          if (user.isActive) {
            const administrators = await tx
              .select({
                id: users.id,
                adminAccessLevel: users.adminAccessLevel,
                isActive: users.isActive,
              })
              .from(users)
              .where(eq(users.role, "admin"))
              .orderBy(asc(users.id))
              .for("update");
            const deletingLastActiveSystemAdmin =
              user.adminAccessLevel === "system_admin" &&
              administrators.every(
                (administrator) =>
                  administrator.id === user.id ||
                  !administrator.isActive ||
                  administrator.adminAccessLevel !== "system_admin",
              );
            if (deletingLastActiveSystemAdmin) {
              throw new AuthServiceError(
                "LAST_ADMIN",
                "至少需要保留一个已启用的系统管理员",
              );
            }
          }

          for (const owner of ownedUsers) {
            await tx
              .update(userUsageOwners)
              .set({
                deliveryAdminId: protectedAdmin.id,
                revision: owner.revision + 1,
                updatedAt: new Date(),
              })
              .where(eq(userUsageOwners.userId, owner.userId));
          }
          const reassignedUserIds = [
            ...new Set([
              ...ownedUsers.map((owner) => owner.userId),
              ...assignedUsers.map((assignment) => assignment.userId),
            ]),
          ];
          if (reassignedUserIds.length > 0) {
            await tx
              .insert(userAdminAssignments)
              .values(
                reassignedUserIds.map((userId) => ({
                  userId,
                  adminId: protectedAdmin.id,
                  assignedByUserId: actorUserId,
                })),
              )
              .onDuplicateKeyUpdate({
                set: { assignedByUserId: actorUserId },
              });
          }

          if (retainHistoricalAccount) {
            const now = new Date();
            await tx
              .update(users)
              .set({ isActive: false, updatedAt: now })
              .where(eq(users.id, targetUserId));
            await consumeAllUserPasswordSetupTokensInExecutor(
              tx,
              targetUserId,
              now,
            );
            await revokeAllUserSessionsInExecutor(tx, targetUserId, now);
            return { disposition: "deactivated_for_history" as const };
          }
        }

        // Website provisions retain their audit row with ON DELETE SET NULL. Mark
        // both setup-token protocols consumed before deleting the account so the
        // durable ledger does not preserve a misleading live capability.
        const now = new Date();
        await tx
          .update(users)
          .set({ isActive: false, updatedAt: now })
          .where(eq(users.id, targetUserId));
        await consumeAllUserPasswordSetupTokensInExecutor(
          tx,
          targetUserId,
          now,
        );
        await revokeAllUserSessionsInExecutor(tx, targetUserId, now);
        return { disposition: "permanently_deleted" as const };
      })();
      if (transactionResult.disposition === "deactivated_for_history") {
        await options.onResultInTransaction?.(transactionResult, tx);
      }
      return transactionResult;
    });
    if (preparation.disposition === "deactivated_for_history") {
      await stopFenceHeartbeat().catch(() => undefined);
      await rollbackManagedUploadDeletionFence(fence);
      return preparation;
    }
    permanentDeletionPrepared = true;
    await advanceManagedUploadAccountDeletionFence(fence, "prepared");

    // No transaction is held across filesystem retirement or Provider I/O.
    // The preparation transaction has already disabled the account and
    // revoked sessions, while the user fence excludes every upload worker.
    await retireManagedUploadIntentsForAccountDeletion({
      userId: targetUserId,
      token: fence,
      discardProviderFile: discardManagedUploadProviderFileForRetirement,
    });
    await advanceManagedUploadAccountDeletionFence(fence, "retired");

    const result = await db.transaction(async (tx) => {
      const rows = await tx
        .select({ id: users.id })
        .from(users)
        .where(eq(users.id, targetUserId))
        .limit(1)
        .for("update");
      const userExisted = Boolean(rows[0]);
      if (userExisted) {
        await permanentlyDeleteManagedUserRows(tx, targetUserId);
      }
      const deletionResult = {
        disposition: "permanently_deleted" as const,
        ...("replayed" in preparation && preparation.replayed
          ? { replayed: true as const }
          : {}),
      };
      // A concurrent/resumed caller that finds the row already gone must not
      // duplicate the original account.deleted audit event.
      if (userExisted) {
        await options.onResultInTransaction?.(deletionResult, tx);
      }
      return deletionResult;
    });
    finalDeletionCommitted = true;
    await stopFenceHeartbeat().catch(() => undefined);
    // Once the final transaction removed the account, filesystem/provider
    // tail failure cannot change the public deletion result. Startup replay
    // consumes this durable tombstone without reissuing Provider calls.
    await completeManagedUploadDeletionFence(fence).catch(() => undefined);
    return result;
  } catch (error) {
    await stopFenceHeartbeat().catch(() => undefined);
    if (
      !finalDeletionCommitted &&
      (permanentDeletionPrepared || resumedPermanentDeletion)
    ) {
      const userStillExists = await db
        .transaction(async (tx) => {
          const rows = await tx
            .select({ id: users.id })
            .from(users)
            .where(eq(users.id, targetUserId))
            .limit(1)
            .for("update");
          return Boolean(rows[0]);
        })
        .catch(() => true);
      if (!userStillExists) {
        await reconcileStaleManagedUploadDeletionFence(scope, "deleted").catch(
          () => undefined,
        );
        await replayManagedUploadRetirementForDeletedAccount(
          targetUserId,
        ).catch(() => undefined);
        return {
          disposition: "permanently_deleted" as const,
          replayed: true as const,
        };
      }
    }
    if (
      !finalDeletionCommitted &&
      !permanentDeletionPrepared &&
      !resumedPermanentDeletion
    ) {
      await rollbackManagedUploadDeletionFence(fence).catch(() => undefined);
    }
    throw error;
  }
}

function decodeMasterKey(value: string): Buffer {
  const trimmed = value.trim();
  let decoded: Buffer;

  if (trimmed.startsWith("base64:")) {
    decoded = Buffer.from(trimmed.slice(7), "base64");
  } else if (trimmed.startsWith("hex:")) {
    decoded = Buffer.from(trimmed.slice(4), "hex");
  } else if (/^[a-f\d]{64}$/i.test(trimmed)) {
    decoded = Buffer.from(trimmed, "hex");
  } else {
    decoded = Buffer.from(trimmed, "base64");
  }

  if (decoded.length !== 32) {
    throw new AuthServiceError(
      "INVALID_MASTER_KEY",
      "FRONTMIND_CREDENTIAL_ENCRYPTION_KEY must encode exactly 32 bytes",
    );
  }
  return decoded;
}

function getCredentialMasterKey() {
  const configured = process.env.FRONTMIND_CREDENTIAL_ENCRYPTION_KEY;
  if (!configured) {
    throw new AuthServiceError(
      "INVALID_MASTER_KEY",
      "FRONTMIND_CREDENTIAL_ENCRYPTION_KEY is not configured",
    );
  }
  return decodeMasterKey(configured);
}

/** Fail-fast validation used by the production entrypoint. */
export function assertCredentialEncryptionConfigured() {
  getCredentialMasterKey();
}

function credentialAad(userId: number, credentialId: string) {
  return Buffer.from(
    `frontmind-api-credential:v1:${userId}:${credentialId}`,
    "utf8",
  );
}

/** Encrypt a server-side credential with domain-separated authenticated data. */
export function encryptCredentialSecret(aad: string, secret: string) {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", getCredentialMasterKey(), iv);
  cipher.setAAD(Buffer.from(aad, "utf8"));
  const encrypted = Buffer.concat([
    cipher.update(secret, "utf8"),
    cipher.final(),
  ]);
  return {
    encryptionVersion: 1,
    encryptedKey: encrypted.toString("base64"),
    encryptionIv: iv.toString("base64"),
    encryptionAuthTag: cipher.getAuthTag().toString("base64"),
  };
}

/** Decrypt a server-side credential previously sealed by encryptCredentialSecret. */
export function decryptCredentialSecret(
  aad: string,
  credential: Pick<
    ApiCredential,
    "encryptionVersion" | "encryptedKey" | "encryptionIv" | "encryptionAuthTag"
  >,
) {
  try {
    if (credential.encryptionVersion !== 1) {
      throw new AuthServiceError(
        "INVALID_CREDENTIAL",
        "Credential encryption version is not supported",
      );
    }
    const decipher = createDecipheriv(
      "aes-256-gcm",
      getCredentialMasterKey(),
      Buffer.from(credential.encryptionIv, "base64"),
    );
    decipher.setAAD(Buffer.from(aad, "utf8"));
    decipher.setAuthTag(Buffer.from(credential.encryptionAuthTag, "base64"));
    return Buffer.concat([
      decipher.update(Buffer.from(credential.encryptedKey, "base64")),
      decipher.final(),
    ]).toString("utf8");
  } catch (error) {
    if (error instanceof AuthServiceError) throw error;
    throw new AuthServiceError(
      "INVALID_CREDENTIAL",
      "Credential cannot be decrypted",
    );
  }
}

export function getApiKeyFingerprint(apiKey: string) {
  return `fp_${createHash("sha256").update(apiKey, "utf8").digest("hex").slice(0, 16)}`;
}

/**
 * API credentials are stored once per FrontMind account, but the underlying
 * upstream key may intentionally be shared by several accounts. Resource
 * ownership remains account-scoped; this helper is only used to decide whether
 * two credential versions can access the same upstream task or file.
 */
export function credentialsUseSameUpstreamApiKey(
  left: Pick<DecryptedCredential, "apiKey" | "fingerprint">,
  right: Pick<DecryptedCredential, "apiKey" | "fingerprint">,
) {
  if (left.fingerprint !== right.fingerprint) return false;
  const leftBytes = Buffer.from(left.apiKey, "utf8");
  const rightBytes = Buffer.from(right.apiKey, "utf8");
  return (
    leftBytes.length === rightBytes.length &&
    timingSafeEqual(leftBytes, rightBytes)
  );
}

export function encryptApiKey(
  userId: number,
  credentialId: string,
  apiKey: string,
) {
  return encryptCredentialSecret(
    credentialAad(userId, credentialId).toString("utf8"),
    apiKey,
  );
}

export function decryptApiKey(
  credential: Pick<
    ApiCredential,
    | "id"
    | "userId"
    | "encryptionVersion"
    | "encryptedKey"
    | "encryptionIv"
    | "encryptionAuthTag"
  >,
) {
  return decryptCredentialSecret(
    credentialAad(credential.userId, credential.id).toString("utf8"),
    credential,
  );
}

export async function validateUpstreamApiKey(apiKey: string) {
  try {
    await new ManusV2Client({
      baseUrl: getUpstreamBaseUrl(),
      apiKey,
    }).probeCredential();
  } catch (error) {
    if (
      error instanceof ManusV2ApiError &&
      (error.status === 401 || error.status === 403)
    ) {
      throw new AuthServiceError(
        "INVALID_CREDENTIAL",
        "API credential is invalid",
      );
    }
    throw new AuthServiceError(
      "UPSTREAM_UNAVAILABLE",
      "Unable to validate the API credential",
    );
  }
}

function credentialAgentProfile(credential?: unknown): ManagedAgentProfile {
  return normalizeManagedAgentProfile(
    credential && typeof credential === "object"
      ? (credential as { agentProfile?: unknown }).agentProfile
      : undefined,
  );
}

function credentialProfileProjection(credential?: unknown) {
  const agentProfile = credentialAgentProfile(credential);
  return {
    agentProfile,
    upstreamModel: managedAgentProfileModel(agentProfile),
  } as const;
}

function toCredentialStatus(
  credential?: ApiCredential | null,
): CredentialStatus {
  const status =
    credential?.status === "deleted"
      ? null
      : credential?.validationStatus === "invalid"
        ? "invalid"
        : (credential?.status ?? null);
  return {
    configured: Boolean(credential && credential.status === "active"),
    version: credential?.version ?? 0,
    fingerprint: credential?.fingerprint ?? null,
    status,
    verifiedAt: credential?.verifiedAt?.getTime() ?? null,
    ...credentialProfileProjection(credential),
  };
}

export async function getApiCredentialStatus(userId: number) {
  const db = await requireDb();
  const rows = await db
    .select()
    .from(apiCredentials)
    .where(eq(apiCredentials.userId, userId))
    .orderBy(desc(apiCredentials.version))
    .limit(1);
  return toCredentialStatus(rows[0]);
}

export async function getEffectiveApiCredentialStatus(accountId: number) {
  return {
    ...(await getApiCredentialStatus(accountId)),
    ownerUserId: accountId,
    inherited: false,
  };
}

export async function replaceApiCredentialInTransaction(input: {
  executor: any;
  userId: number;
  apiKey: string;
  now?: Date;
  credentialId?: string;
  agentProfile?: ManagedAgentProfile | null;
}): Promise<CredentialStatus> {
  // Permanent account deletion fences the credential owner before enumerating
  // all key generations. Check inside every transactional rotation path so a
  // new generation cannot appear outside that frozen set. Ordinary rotation
  // remains unaffected when no deletion fence exists.
  await assertManagedUploadScopesAvailable([
    { kind: "user", userId: input.userId },
  ]).catch((error) => {
    if (error instanceof ManagedUploadDeletionFenceError) {
      throw new AuthServiceError(
        "CONFLICT",
        "账号正在永久删除，不能轮换 API Key",
      );
    }
    throw error;
  });
  const fingerprint = getApiKeyFingerprint(input.apiKey);
  const credentialId = input.credentialId ?? randomUUID();
  const encrypted = encryptApiKey(input.userId, credentialId, input.apiKey);
  const now = input.now ?? new Date();
  const agentProfile =
    input.agentProfile === null
      ? null
      : (input.agentProfile ?? DEFAULT_MANAGED_AGENT_PROFILE);
  const tx = input.executor;

  const ownerRows = await tx
    .select({ id: users.id })
    .from(users)
    .where(eq(users.id, input.userId))
    .limit(1)
    .for("update");
  if (!ownerRows[0]) {
    throw new AuthServiceError("NOT_FOUND", "User not found");
  }
  const latest = await tx
    .select()
    .from(apiCredentials)
    .where(eq(apiCredentials.userId, input.userId))
    .orderBy(desc(apiCredentials.version))
    .limit(1);
  const nextVersion = (latest[0]?.version ?? 0) + 1;

  await tx
    .update(apiCredentials)
    .set({ status: "retired", retiredAt: now, updatedAt: now })
    .where(
      and(
        eq(apiCredentials.userId, input.userId),
        eq(apiCredentials.status, "active"),
      ),
    );

  const inserted = {
    id: credentialId,
    userId: input.userId,
    version: nextVersion,
    ...encrypted,
    fingerprint,
    agentProfile,
    status: "active" as const,
    validationStatus: "verified" as const,
    verifiedAt: now,
    createdAt: now,
    updatedAt: now,
    retiredAt: null,
    deletedAt: null,
  };
  await tx.insert(apiCredentials).values(inserted as any);
  return toCredentialStatus(inserted);
}

export async function replaceApiCredential(
  userId: number,
  apiKey: string,
  agentProfile: ManagedAgentProfile = DEFAULT_MANAGED_AGENT_PROFILE,
  validator: (apiKey: string) => Promise<void> = validateUpstreamApiKey,
): Promise<CredentialStatus> {
  const db = await requireDb();
  await validator(apiKey);
  return db.transaction((tx) =>
    replaceApiCredentialInTransaction({
      executor: tx,
      userId,
      apiKey,
      agentProfile,
    }),
  );
}

export async function deleteActiveApiCredential(userId: number) {
  const fence = await acquireActiveApiCredentialDeletionFence(userId);
  if (!fence) return;
  const db = await requireDb();
  const stopFenceHeartbeat = startManagedUploadDeletionFenceHeartbeat(fence);
  let transactionCommitted = false;
  try {
    await db.transaction((tx) =>
      deleteActiveApiCredentialInTransaction({
        executor: tx,
        userId,
        fenceToken: fence,
      }),
    );
    transactionCommitted = true;
    await stopFenceHeartbeat();
    await completeManagedUploadDeletionFence(fence);
  } catch (error) {
    await stopFenceHeartbeat().catch(() => undefined);
    if (!transactionCommitted) {
      await rollbackManagedUploadDeletionFence(fence).catch(() => undefined);
    }
    throw error;
  }
}

export async function acquireActiveApiCredentialDeletionFence(userId: number) {
  const db = await requireDb();
  const pendingScopes =
    await listManagedUploadCredentialDeletionFenceScopes(userId);
  for (const pendingScope of pendingScopes) {
    await db.transaction(async (tx) => {
      const rows = await tx
        .select({ status: apiCredentials.status })
        .from(apiCredentials)
        .where(
          and(
            eq(apiCredentials.userId, userId),
            eq(apiCredentials.id, pendingScope.credentialId),
          ),
        )
        .limit(1)
        .for("update");
      await reconcileStaleManagedUploadDeletionFence(
        pendingScope,
        !rows[0] || rows[0].status === "deleted" ? "deleted" : "active",
      ).catch((error) => {
        if (
          error instanceof ManagedUploadDeletionFenceError &&
          error.code === "DELETION_IN_PROGRESS"
        ) {
          throw new AuthServiceError(
            "CONFLICT",
            "API Key 删除正在进行，请稍后重试",
          );
        }
        throw error;
      });
    });
  }
  const rows = await db
    .select({ id: apiCredentials.id, status: apiCredentials.status })
    .from(apiCredentials)
    .where(eq(apiCredentials.userId, userId))
    .orderBy(desc(apiCredentials.version))
    .limit(1);
  const latest = rows[0];
  if (!latest) return null;
  const scope = {
    kind: "credential" as const,
    userId,
    credentialId: latest.id,
  };
  if (latest.status !== "active") {
    await reconcileStaleManagedUploadDeletionFence(scope, "deleted").catch(
      (error) => {
        if (
          error instanceof ManagedUploadDeletionFenceError &&
          error.code === "DELETION_IN_PROGRESS"
        ) {
          throw new AuthServiceError(
            "CONFLICT",
            "API Key 删除正在收口，请稍后重试",
          );
        }
        throw error;
      },
    );
    return null;
  }
  try {
    return await acquireManagedUploadDeletionFence(scope);
  } catch (error) {
    if (
      error instanceof ManagedUploadDeletionFenceError &&
      error.code === "STALE_DELETION_FENCE"
    ) {
      await reconcileStaleManagedUploadDeletionFence(scope, "active");
      return acquireManagedUploadDeletionFence(scope);
    }
    if (error instanceof ManagedUploadDeletionFenceError) {
      throw new AuthServiceError(
        "CONFLICT",
        "当前 API Key 仍有本地上传记录正在接收、恢复或清理；请先完成或取消上传，普通 Key 轮换不受影响",
      );
    }
    throw error;
  }
}

export async function completeActiveApiCredentialDeletionFence(
  token: ManagedUploadDeletionFenceToken,
) {
  await completeManagedUploadDeletionFence(token);
}

export async function rollbackActiveApiCredentialDeletionFence(
  token: ManagedUploadDeletionFenceToken,
) {
  await rollbackManagedUploadDeletionFence(token);
}

export function startActiveApiCredentialDeletionFenceHeartbeat(
  token: ManagedUploadDeletionFenceToken,
) {
  return startManagedUploadDeletionFenceHeartbeat(token);
}

export async function deleteActiveApiCredentialInTransaction(input: {
  executor: any;
  userId: number;
  fenceToken: ManagedUploadDeletionFenceToken;
  now?: Date;
}) {
  const now = input.now ?? new Date();
  const latestRows = await input.executor
    .select()
    .from(apiCredentials)
    .where(eq(apiCredentials.userId, input.userId))
    .orderBy(desc(apiCredentials.version))
    .limit(1)
    .for("update");
  const latest = latestRows[0];
  if (!latest || latest.status !== "active") {
    return { version: latest?.version ?? 0, deleted: false as const };
  }
  assertCredentialDeletionFenceToken(input.fenceToken, {
    userId: input.userId,
    credentialId: latest.id,
  });
  // Reservation creation locks the exact credential before the build. Keep the
  // same credential -> build lock order here so deletion cannot race a new
  // active turn into existence after this check.
  const activeKnowledgeBaseReferences = await input.executor
    .select({ turnId: conversationTurns.id })
    .from(conversationTurns)
    .innerJoin(
      knowledgeBaseBuilds,
      and(
        eq(knowledgeBaseBuilds.activeTurnId, conversationTurns.id),
        eq(knowledgeBaseBuilds.generation, conversationTurns.buildGeneration),
      ),
    )
    .where(
      and(
        eq(conversationTurns.apiCredentialId, latest.id),
        inArray(knowledgeBaseBuilds.status, [
          "researching",
          "confirming",
          "protocol_error",
        ]),
      ),
    )
    .limit(1)
    .for("update");
  if (activeKnowledgeBaseReferences[0]) {
    throw new AuthServiceError(
      "CONFLICT",
      "当前 API Key 仍被在建或可重试的知识库轮次使用；请等待任务完成或先完成知识库重置，再删除该 Key",
    );
  }

  // Generic upstream resources do not carry a trustworthy terminal marker in
  // the local ledger. Cryptoshredding their only credential could strand an
  // Agent task, attachment, download, or recovery flow after the UI has
  // already accepted the revoke. Fail closed; rotation remains available and
  // safely retains the referenced version as retired.
  const boundUpstreamResources = await input.executor
    .select({
      kind: upstreamResources.kind,
      upstreamId: upstreamResources.upstreamId,
    })
    .from(upstreamResources)
    .where(eq(upstreamResources.apiCredentialId, latest.id))
    .for("update");
  if (boundUpstreamResources[0]) {
    throw new AuthServiceError(
      "CONFLICT",
      "当前 API Key 仍绑定已有任务或文件，无法安全撤销；请改用替换 Key，系统会保留旧版本供在途任务恢复",
    );
  }

  // v2-only chat and materialized knowledge-base work is represented by the
  // durable operation/lease tables rather than upstream_resources. Deleting
  // the frozen credential while either side effect is non-terminal would
  // strand reconciliation or an upload whose outcome is still unknown.
  const activeAgentOperations = await input.executor
    .select({ id: agentOperations.id })
    .from(agentOperations)
    .where(
      and(
        eq(agentOperations.apiCredentialId, latest.id),
        inArray(agentOperations.status, [
          "queued",
          "running",
          "result_pending",
          "attention_required",
        ]),
      ),
    )
    .limit(1)
    .for("update");
  const activeProviderFileLeases = await input.executor
    .select({ id: providerFileLeases.id })
    .from(providerFileLeases)
    .where(
      and(
        eq(providerFileLeases.apiCredentialId, latest.id),
        inArray(providerFileLeases.uploadState, [
          "reserved",
          "uploading",
          "outcome_unknown",
        ]),
      ),
    )
    .limit(1)
    .for("update");
  if (activeAgentOperations[0] || activeProviderFileLeases[0]) {
    throw new AuthServiceError(
      "CONFLICT",
      "当前 API Key 仍被 v2 任务或文件上传使用，无法安全撤销；请等待任务完成或改用替换 Key。",
    );
  }

  // Historical state-machine migrations can leave a completed build without
  // an active turn while its sole authoritative ZIP still has to be rebound
  // from the pinned upstream task.  That is just as live a credential
  // dependency as an active turn: cryptoshredding the credential would make
  // the retryable PACKAGE_REBIND_REQUIRED state permanent.  Lock the build
  // after the credential (the same credential -> build order used above),
  // then lock the matching turn/resource coordinates before deciding.
  // Coordinate discovery is intentionally cross-account: a delivery/usage
  // owner's credential can be pinned by a managed customer's build.
  const credentialTurnCoordinates = await input.executor
    .select({
      buildId: conversationTurns.buildId,
      buildGeneration: conversationTurns.buildGeneration,
      upstreamTaskId: conversationTurns.upstreamTaskId,
      status: conversationTurns.status,
    })
    .from(conversationTurns)
    .where(eq(conversationTurns.apiCredentialId, latest.id));
  if (
    credentialTurnCoordinates.some(
      (turn: any) => turn.status === "queued" || turn.status === "running",
    )
  ) {
    throw new AuthServiceError(
      "CONFLICT",
      "当前 API Key 仍被已预约或运行中的任务使用，无法安全撤销；请改用替换 Key，系统会保留旧版本供任务继续恢复。",
    );
  }
  const credentialResourceCoordinates = await input.executor
    .select({
      kind: upstreamResources.kind,
      upstreamId: upstreamResources.upstreamId,
    })
    .from(upstreamResources)
    .where(eq(upstreamResources.apiCredentialId, latest.id));
  const credentialBuildIds = Array.from(
    new Set<string>(
      credentialTurnCoordinates
        .map((turn: any) => turn.buildId)
        .filter(
          (value: unknown): value is string =>
            typeof value === "string" && value.length > 0,
        ),
    ),
  );
  const credentialTaskIds = Array.from(
    new Set<string>([
      ...credentialTurnCoordinates
        .map((turn: any) => turn.upstreamTaskId)
        .filter(
          (value: unknown): value is string =>
            typeof value === "string" && value.length > 0,
        ),
      ...credentialResourceCoordinates
        .filter((resource: any) => resource.kind === "task")
        .map((resource: any) => resource.upstreamId)
        .filter(
          (value: unknown): value is string =>
            typeof value === "string" && value.length > 0,
        ),
    ]),
  );
  const credentialFileIds = Array.from(
    new Set<string>(
      credentialResourceCoordinates
        .filter((resource: any) => resource.kind === "file")
        .map((resource: any) => resource.upstreamId)
        .filter(
          (value: unknown): value is string =>
            typeof value === "string" && value.length > 0,
        ),
    ),
  );
  const credentialBuildCoordinate = or(
    eq(knowledgeBaseBuilds.userId, input.userId),
    ...(credentialBuildIds.length > 0
      ? [inArray(knowledgeBaseBuilds.id, credentialBuildIds)]
      : []),
    ...(credentialTaskIds.length > 0
      ? [
          inArray(knowledgeBaseBuilds.upstreamTaskId, credentialTaskIds),
          inArray(knowledgeBaseBuilds.packageTaskId, credentialTaskIds),
        ]
      : []),
    ...(credentialFileIds.length > 0
      ? [inArray(knowledgeBaseBuilds.packageFileId, credentialFileIds)]
      : []),
  );
  const artifactRecoveryBuilds = await input.executor
    .select({
      id: knowledgeBaseBuilds.id,
      generation: knowledgeBaseBuilds.generation,
      status: knowledgeBaseBuilds.status,
      protocolErrorCode: knowledgeBaseBuilds.protocolErrorCode,
      skillVersion: knowledgeBaseBuilds.skillVersion,
      upstreamTaskId: knowledgeBaseBuilds.upstreamTaskId,
      packageTaskId: knowledgeBaseBuilds.packageTaskId,
      packageFileId: knowledgeBaseBuilds.packageFileId,
      packageStorageKey: knowledgeBaseBuilds.packageStorageKey,
      packageArchiveSha256: knowledgeBaseBuilds.packageArchiveSha256,
      packageSizeBytes: knowledgeBaseBuilds.packageSizeBytes,
      logoStorageKey: knowledgeBaseBuilds.logoStorageKey,
      logoSha256: knowledgeBaseBuilds.logoSha256,
      logoBytes: knowledgeBaseBuilds.logoBytes,
    })
    .from(knowledgeBaseBuilds)
    .where(
      and(
        credentialBuildCoordinate,
        or(
          eq(knowledgeBaseBuilds.status, "protocol_error"),
          eq(knowledgeBaseBuilds.status, "ready_to_publish"),
        ),
      ),
    )
    .for("update");
  const recoveryDependencies = artifactRecoveryBuilds.filter((build: any) => {
    const packageDurable = Boolean(
      build.packageStorageKey &&
        /^[a-f0-9]{64}$/u.test(String(build.packageArchiveSha256 || "")) &&
        Number(build.packageSizeBytes) > 0,
    );
    const logoDurable = Boolean(
      build.logoStorageKey &&
        /^[a-f0-9]{64}$/u.test(String(build.logoSha256 || "")) &&
        Number(build.logoBytes) > 0,
    );
    return (
      (build.status === "protocol_error" &&
        build.protocolErrorCode === "PACKAGE_REBIND_REQUIRED") ||
      (build.status === "ready_to_publish" &&
        (build.skillVersion === "3" || build.skillVersion === "4") &&
        (!packageDurable || (build.skillVersion === "4" && !logoDurable)))
    );
  });
  if (recoveryDependencies.length > 0) {
    const buildIds = recoveryDependencies.map((build: any) => build.id);
    const pinnedTurns = await input.executor
      .select({
        buildId: conversationTurns.buildId,
        buildGeneration: conversationTurns.buildGeneration,
        upstreamTaskId: conversationTurns.upstreamTaskId,
      })
      .from(conversationTurns)
      .where(
        and(
          eq(conversationTurns.apiCredentialId, latest.id),
          inArray(conversationTurns.buildId, buildIds),
        ),
      )
      .for("update");
    const taskIds: string[] = Array.from(
      new Set<string>(
        recoveryDependencies
          .flatMap((build: any) => [build.packageTaskId, build.upstreamTaskId])
          .filter(
            (value: unknown): value is string =>
              typeof value === "string" && value.length > 0,
          ) as string[],
      ),
    );
    const fileIds: string[] = Array.from(
      new Set<string>(
        recoveryDependencies
          .map((build: any) => build.packageFileId)
          .filter(
            (value: unknown): value is string =>
              typeof value === "string" && value.length > 0,
          ) as string[],
      ),
    );
    const resourceCoordinate =
      taskIds.length > 0 || fileIds.length > 0
        ? or(
            ...(taskIds.length > 0
              ? [
                  and(
                    eq(upstreamResources.kind, "task"),
                    inArray(upstreamResources.upstreamId, taskIds),
                  ),
                ]
              : []),
            ...(fileIds.length > 0
              ? [
                  and(
                    eq(upstreamResources.kind, "file"),
                    inArray(upstreamResources.upstreamId, fileIds),
                  ),
                ]
              : []),
          )
        : undefined;
    const pinnedResources = resourceCoordinate
      ? await input.executor
          .select({
            kind: upstreamResources.kind,
            upstreamId: upstreamResources.upstreamId,
          })
          .from(upstreamResources)
          .where(
            and(
              eq(upstreamResources.apiCredentialId, latest.id),
              resourceCoordinate,
            ),
          )
          .for("update")
      : [];
    const pinnedByTurn = recoveryDependencies.some((build: any) =>
      pinnedTurns.some(
        (turn: any) =>
          turn.buildId === build.id &&
          turn.buildGeneration === build.generation &&
          (!turn.upstreamTaskId ||
            turn.upstreamTaskId === build.packageTaskId ||
            turn.upstreamTaskId === build.upstreamTaskId),
      ),
    );
    if (pinnedByTurn || pinnedResources.length > 0) {
      throw new AuthServiceError(
        "CONFLICT",
        "当前 API Key 仍是历史知识库 ZIP/Logo 权威重绑所需的唯一凭证；请先完成成品固化与重新绑定，或先轮换 Key 保留该凭证版本",
      );
    }
  }
  await input.executor
    .update(apiCredentials)
    .set({
      status: "deleted",
      deletedAt: now,
      encryptedKey: randomBytes(32).toString("base64"),
      encryptionIv: randomBytes(12).toString("base64"),
      encryptionAuthTag: randomBytes(16).toString("base64"),
      updatedAt: now,
    })
    .where(
      and(
        eq(apiCredentials.userId, input.userId),
        eq(apiCredentials.status, "active"),
      ),
    );
  const tombstoneVersion = latest.version + 1;
  await input.executor.insert(apiCredentials).values({
    id: randomUUID(),
    userId: input.userId,
    version: tombstoneVersion,
    encryptionVersion: 1,
    encryptedKey: randomBytes(32).toString("base64"),
    encryptionIv: randomBytes(12).toString("base64"),
    encryptionAuthTag: randomBytes(16).toString("base64"),
    fingerprint: randomBytes(16).toString("hex"),
    agentProfile:
      typeof (latest as { agentProfile?: unknown }).agentProfile === "string"
        ? (latest as { agentProfile: string }).agentProfile
        : null,
    status: "deleted",
    validationStatus: "unverified",
    verifiedAt: null,
    retiredAt: null,
    deletedAt: now,
    createdAt: now,
    updatedAt: now,
  });
  return { version: tombstoneVersion, deleted: true as const };
}

export async function getDecryptedCredentialForUser(
  userId: number,
  credentialId?: string | null,
): Promise<DecryptedCredential | null> {
  const db = await requireDb();
  const conditions = [
    eq(apiCredentials.userId, userId),
    ne(apiCredentials.status, "deleted"),
  ];
  if (credentialId) conditions.push(eq(apiCredentials.id, credentialId));
  else conditions.push(eq(apiCredentials.status, "active"));

  const rows = await db
    .select()
    .from(apiCredentials)
    .where(and(...conditions))
    .orderBy(desc(apiCredentials.version))
    .limit(1);
  const credential = rows[0];
  if (!credential || credential.status === "deleted") return null;

  return {
    id: credential.id,
    userId: credential.userId,
    version: credential.version,
    apiKey: decryptApiKey(credential),
    fingerprint: credential.fingerprint,
    status: credential.status,
    verifiedAt: credential.verifiedAt,
    ...credentialProfileProjection(credential),
  };
}

/**
 * Resolves the exact credential version captured by a durable background
 * reservation. This differs from the ordinary "active credential" lookup:
 * rotating a Key must not move an in-flight idempotency operation into a new
 * upstream credential namespace.
 */
export async function getDecryptedCredentialForAccountById(
  accountId: number,
  credentialId: string,
): Promise<DecryptedCredential | null> {
  const db = await requireDb();
  if (!(await credentialMayServeAccount(db, accountId, credentialId))) {
    return null;
  }
  const rows = await db
    .select()
    .from(apiCredentials)
    .where(
      and(
        eq(apiCredentials.id, credentialId),
        ne(apiCredentials.status, "deleted"),
      ),
    )
    .limit(1);
  const credential = rows[0];
  if (!credential || credential.status === "deleted") return null;
  return {
    id: credential.id,
    userId: credential.userId,
    version: credential.version,
    apiKey: decryptApiKey(credential),
    fingerprint: credential.fingerprint,
    status: credential.status,
    verifiedAt: credential.verifiedAt,
    ...credentialProfileProjection(credential),
  };
}

/**
 * Resolve the immutable credential identity captured by one sealed managed
 * upload intent. Unlike the ordinary account resolver this intentionally does
 * not consult the account's current usage-owner assignment: that relationship
 * may change after Dashboard has durably accepted the browser body. The
 * intent's authenticated actor/project/ticket checks and deletion fences are
 * the authorization boundary; this lookup only proves that the exact owner,
 * credential and version still exist and remain decryptable.
 */
export async function getDecryptedCredentialForManagedUploadIntent(
  input: {
    credentialId: string;
    credentialOwnerUserId: number;
    credentialVersion: number;
  },
  executor?: any,
): Promise<DecryptedCredential | null> {
  const db = executor ?? (await requireDb());
  const rows = await db
    .select()
    .from(apiCredentials)
    .where(
      and(
        eq(apiCredentials.id, input.credentialId),
        eq(apiCredentials.userId, input.credentialOwnerUserId),
        eq(apiCredentials.version, input.credentialVersion),
        inArray(apiCredentials.status, ["active", "retired"]),
      ),
    )
    .limit(1);
  const credential = rows[0];
  if (
    !credential ||
    credential.id !== input.credentialId ||
    credential.userId !== input.credentialOwnerUserId ||
    credential.version !== input.credentialVersion ||
    (credential.status !== "active" && credential.status !== "retired")
  ) {
    return null;
  }
  return {
    id: credential.id,
    userId: credential.userId,
    version: credential.version,
    apiKey: decryptApiKey(credential),
    fingerprint: credential.fingerprint,
    status: credential.status,
    verifiedAt: credential.verifiedAt,
    ...credentialProfileProjection(credential),
  };
}

/**
 * Resolve the credential pinned to one already-authoritative knowledge-base
 * reservation. This is deliberately not a general cross-account credential
 * lookup: the credential, build and active turn are locked in the global
 * credential -> build -> turn order and every persisted coordinate must match
 * the caller's claim. The durable turn remains the historical authority after
 * a managed account is reassigned from usage owner A to B.
 */
export async function getDecryptedCredentialForKnowledgeBaseReservation(
  input: {
    userId: number;
    turnId: string;
    buildId: string;
    buildGeneration: number;
    apiCredentialId: string;
  },
  executor?: any,
): Promise<DecryptedCredential | null> {
  const db = executor ?? (await requireDb());
  return db.transaction(async (tx: any) => {
    const credential = (
      await tx
        .select()
        .from(apiCredentials)
        .where(eq(apiCredentials.id, input.apiCredentialId))
        .limit(1)
        .for("update")
    )[0] as ApiCredential | undefined;
    if (
      !credential ||
      (credential.status !== "active" && credential.status !== "retired")
    ) {
      return null;
    }

    const build = (
      await tx
        .select({
          id: knowledgeBaseBuilds.id,
          userId: knowledgeBaseBuilds.userId,
          generation: knowledgeBaseBuilds.generation,
          activeTurnId: knowledgeBaseBuilds.activeTurnId,
          status: knowledgeBaseBuilds.status,
        })
        .from(knowledgeBaseBuilds)
        .where(
          and(
            eq(knowledgeBaseBuilds.id, input.buildId),
            eq(knowledgeBaseBuilds.userId, input.userId),
            eq(knowledgeBaseBuilds.generation, input.buildGeneration),
          ),
        )
        .limit(1)
        .for("update")
    )[0];
    if (
      !build ||
      build.activeTurnId !== input.turnId ||
      !["researching", "confirming", "protocol_error"].includes(
        String(build.status),
      )
    ) {
      return null;
    }

    const turn = (
      await tx
        .select({
          id: conversationTurns.id,
          userId: conversationTurns.userId,
          buildId: conversationTurns.buildId,
          buildGeneration: conversationTurns.buildGeneration,
          apiCredentialId: conversationTurns.apiCredentialId,
          status: conversationTurns.status,
        })
        .from(conversationTurns)
        .where(
          and(
            eq(conversationTurns.id, input.turnId),
            eq(conversationTurns.userId, input.userId),
            eq(conversationTurns.buildId, input.buildId),
            eq(conversationTurns.buildGeneration, input.buildGeneration),
            eq(conversationTurns.apiCredentialId, input.apiCredentialId),
          ),
        )
        .limit(1)
        .for("update")
    )[0];
    if (!turn || (turn.status !== "queued" && turn.status !== "running")) {
      return null;
    }

    return {
      id: credential.id,
      userId: credential.userId,
      version: credential.version,
      apiKey: decryptApiKey(credential),
      fingerprint: credential.fingerprint,
      status: credential.status,
      verifiedAt: credential.verifiedAt,
      ...credentialProfileProjection(credential),
    };
  });
}

/**
 * Resolve the exact credential frozen by a knowledge-base upload reservation.
 * Unlike the dispatch resolver, this permits the active turn to still be in
 * `awaitingClientAttachments`; no provider operation has started yet. It is
 * intentionally scoped by owner + public conversation + turn and accepts a
 * retired credential so key rotation cannot strand a reserved upload batch.
 */
export async function getDecryptedCredentialForKnowledgeBaseUploadReservation(
  input: {
    userId: number;
    conversationId: string;
    turnId: string;
    projectAssignmentId?: string | null;
  },
  executor?: any,
): Promise<KnowledgeBaseUploadReservationCredential | null> {
  const db = executor ?? (await requireDb());
  const storedConversationId = `u${input.userId}:${input.conversationId}`;
  return db.transaction(async (tx: any) => {
    const turn = (
      await tx
        .select({
          id: conversationTurns.id,
          clientRequestId: conversationTurns.clientRequestId,
          userId: conversationTurns.userId,
          conversationId: conversationTurns.conversationId,
          buildId: conversationTurns.buildId,
          buildGeneration: conversationTurns.buildGeneration,
          apiCredentialId: conversationTurns.apiCredentialId,
          status: conversationTurns.status,
          metadata: conversationTurns.metadata,
        })
        .from(conversationTurns)
        .where(
          and(
            eq(conversationTurns.id, input.turnId),
            eq(conversationTurns.userId, input.userId),
            eq(conversationTurns.conversationId, storedConversationId),
          ),
        )
        .limit(1)
        .for("update")
    )[0];
    const metadata =
      turn?.metadata &&
      typeof turn.metadata === "object" &&
      !Array.isArray(turn.metadata)
        ? turn.metadata
        : {};
    const recovery =
      metadata.recovery &&
      typeof metadata.recovery === "object" &&
      !Array.isArray(metadata.recovery)
        ? (metadata.recovery as Record<string, unknown>)
        : {};
    const rawAttachmentManifest = Array.isArray(recovery.attachmentManifest)
      ? recovery.attachmentManifest
      : [];
    const attachmentManifest = rawAttachmentManifest
      .map((value, index) => {
        const item =
          value && typeof value === "object" && !Array.isArray(value)
            ? (value as Record<string, unknown>)
            : {};
        const filename = String(item.filename || "").trim();
        const sizeBytes = Number(item.sizeBytes);
        const mimeType = String(item.mimeType || "").trim();
        const lastModified = Number(item.lastModified);
        const sha256 = String(item.sha256 || "")
          .trim()
          .toLowerCase();
        const itemId = String(item.itemId || "").trim();
        const ordinal = Number(item.ordinal);
        const total = Number(item.total);
        const hasStarterCoordinate = Boolean(itemId);
        if (
          !filename ||
          !Number.isSafeInteger(sizeBytes) ||
          sizeBytes < 0 ||
          !mimeType ||
          !Number.isSafeInteger(lastModified) ||
          lastModified < 0 ||
          !/^[a-f0-9]{64}$/u.test(sha256) ||
          (hasStarterCoordinate &&
            (!Number.isSafeInteger(ordinal) ||
              ordinal !== index + 1 ||
              !Number.isSafeInteger(total) ||
              total !== rawAttachmentManifest.length))
        ) {
          return null;
        }
        return {
          filename,
          sizeBytes,
          mimeType,
          lastModified,
          sha256,
          ...(hasStarterCoordinate ? { itemId, ordinal, total } : {}),
        };
      })
      .filter(
        (
          item,
        ): item is KnowledgeBaseUploadReservationCredential["reservation"]["attachmentManifest"][number] =>
          Boolean(item),
      );
    if (
      !turn?.buildId ||
      !turn.buildGeneration ||
      !turn.clientRequestId ||
      !turn.apiCredentialId ||
      (turn.status !== "queued" && turn.status !== "running") ||
      metadata.awaitingClientAttachments !== true
    ) {
      return null;
    }
    const declaredUserAttachmentCount = Number(metadata.userAttachmentCount);
    const sourceResetRevision = Number(metadata.sourceResetRevision);
    if (
      !Number.isSafeInteger(declaredUserAttachmentCount) ||
      declaredUserAttachmentCount < 0 ||
      !Number.isSafeInteger(sourceResetRevision) ||
      sourceResetRevision < 0 ||
      attachmentManifest.length !== declaredUserAttachmentCount
    ) {
      return null;
    }
    const build = (
      await tx
        .select({
          id: knowledgeBaseBuilds.id,
          userId: knowledgeBaseBuilds.userId,
          conversationId: knowledgeBaseBuilds.conversationId,
          generation: knowledgeBaseBuilds.generation,
          activeTurnId: knowledgeBaseBuilds.activeTurnId,
          status: knowledgeBaseBuilds.status,
        })
        .from(knowledgeBaseBuilds)
        .where(
          and(
            eq(knowledgeBaseBuilds.id, turn.buildId),
            eq(knowledgeBaseBuilds.userId, input.userId),
            eq(knowledgeBaseBuilds.conversationId, input.conversationId),
            eq(knowledgeBaseBuilds.generation, turn.buildGeneration),
          ),
        )
        .limit(1)
        .for("update")
    )[0];
    if (
      !build ||
      build.activeTurnId !== turn.id ||
      !["researching", "confirming", "protocol_error"].includes(
        String(build.status),
      )
    ) {
      return null;
    }
    const conversation = (
      await tx
        .select({
          id: conversations.id,
          userId: conversations.userId,
          projectAssignmentId: conversations.projectAssignmentId,
          deletedAt: conversations.deletedAt,
        })
        .from(conversations)
        .where(
          and(
            eq(conversations.id, storedConversationId),
            eq(conversations.userId, input.userId),
          ),
        )
        .limit(1)
        .for("update")
    )[0];
    if (
      !conversation ||
      conversation.deletedAt ||
      (conversation.projectAssignmentId ?? null) !==
        (input.projectAssignmentId ?? null)
    ) {
      return null;
    }
    const credential = (
      await tx
        .select()
        .from(apiCredentials)
        .where(eq(apiCredentials.id, turn.apiCredentialId))
        .limit(1)
        .for("update")
    )[0] as ApiCredential | undefined;
    if (
      !credential ||
      (credential.status !== "active" && credential.status !== "retired")
    ) {
      return null;
    }
    return {
      id: credential.id,
      userId: credential.userId,
      version: credential.version,
      apiKey: decryptApiKey(credential),
      fingerprint: credential.fingerprint,
      status: credential.status,
      verifiedAt: credential.verifiedAt,
      ...credentialProfileProjection(credential),
      reservation: {
        clientRequestId: turn.clientRequestId,
        sourceResetRevision,
        attachmentManifest,
        stagedAttachmentCount: Array.isArray(metadata.clientStagedAttachments)
          ? metadata.clientStagedAttachments.length
          : 0,
      },
    };
  });
}

/** Returns only the account's own active runtime credential. */
export async function getEffectiveDecryptedCredentialForAccount(
  accountId: number,
): Promise<DecryptedCredential | null> {
  return getDecryptedCredentialForUser(accountId);
}

export async function credentialMayServeAccount(
  executor: any,
  accountId: number,
  credentialId: string,
) {
  const credentialRows = await executor
    .select({
      ownerUserId: apiCredentials.userId,
      status: apiCredentials.status,
    })
    .from(apiCredentials)
    .where(eq(apiCredentials.id, credentialId))
    .limit(1);
  const credential = credentialRows[0];
  if (!credential || credential.status === "deleted") return false;
  return credential.ownerUserId === accountId;
}

export async function getCredentialForUpstreamResource(
  userId: number,
  kind: "task" | "file",
  upstreamId: string,
  projectAssignmentId?: string,
  options?: { allowExpiredFileContent?: boolean },
): Promise<(DecryptedCredential & { resource: UpstreamResource }) | null> {
  const db = await requireDb();
  const rows = await db
    .select({ resource: upstreamResources, credential: apiCredentials })
    .from(upstreamResources)
    .innerJoin(
      apiCredentials,
      eq(upstreamResources.apiCredentialId, apiCredentials.id),
    )
    .where(
      and(
        projectAssignmentId
          ? eq(upstreamResources.projectAssignmentId, projectAssignmentId)
          : and(
              eq(upstreamResources.userId, userId),
              isNull(upstreamResources.projectAssignmentId),
            ),
        eq(upstreamResources.kind, kind),
        eq(upstreamResources.upstreamId, upstreamId),
        ne(apiCredentials.status, "deleted"),
      ),
    )
    .limit(1);
  const row = rows[0];
  if (!row || row.credential.status === "deleted") return null;
  if (
    kind === "file" &&
    !options?.allowExpiredFileContent &&
    isFileResourceContentExpired(row.resource)
  ) {
    return null;
  }

  return {
    id: row.credential.id,
    userId: row.credential.userId,
    version: row.credential.version,
    apiKey: decryptApiKey(row.credential),
    fingerprint: row.credential.fingerprint,
    status: row.credential.status,
    verifiedAt: row.credential.verifiedAt,
    ...credentialProfileProjection(row.credential),
    resource: row.resource,
  };
}

export type UnboundUpstreamFileDiscardContext = {
  fileId: string;
  userId: number;
  projectAssignmentId: string | null;
  apiCredentialId: string;
  apiKey: string;
};

/**
 * Locks an owned file record, proves that no durable conversation surface has
 * bound it, performs the caller's idempotent provider/filesystem cleanup, and
 * only then removes the ownership row in the same transaction. Holding the
 * resource row lock is intentional: conversation persistence takes the same
 * lock before setting conversationId, so cancellation cannot delete a file
 * while a turn is binding it.
 */
export async function discardUnboundUpstreamFileInTransaction(input: {
  executor: any;
  userId: number;
  fileId: string;
  projectAssignmentId?: string | null;
  discard: (context: UnboundUpstreamFileDiscardContext) => Promise<void>;
}) {
  const projectAssignmentId = input.projectAssignmentId ?? null;
  const rows = await input.executor
    .select({ resource: upstreamResources, credential: apiCredentials })
    .from(upstreamResources)
    .innerJoin(
      apiCredentials,
      eq(upstreamResources.apiCredentialId, apiCredentials.id),
    )
    .where(
      and(
        eq(upstreamResources.kind, "file"),
        eq(upstreamResources.upstreamId, input.fileId),
      ),
    )
    .limit(1)
    .for("update");
  const row = rows[0];
  const owned = projectAssignmentId
    ? row?.resource.projectAssignmentId === projectAssignmentId
    : row?.resource.userId === input.userId &&
      row?.resource.projectAssignmentId == null;
  if (!row || !owned || row.credential.status === "deleted") {
    return { discarded: false as const };
  }
  if (row.resource.conversationId) {
    throw new AuthServiceError(
      "CONFLICT",
      "UPLOAD_ALREADY_BOUND: file is already bound to a conversation",
    );
  }

  const liveAttachments = await input.executor
    .select({ id: attachments.id })
    .from(attachments)
    .where(
      and(
        eq(attachments.upstreamFileId, input.fileId),
        isNull(attachments.deletedAt),
      ),
    )
    .limit(1);
  if (liveAttachments[0]) {
    throw new AuthServiceError(
      "CONFLICT",
      "UPLOAD_ALREADY_BOUND: file has a live attachment reference",
    );
  }

  const turnReferences = await input.executor
    .select({ id: conversationTurns.id })
    .from(conversationTurns)
    .where(
      sql`JSON_CONTAINS(${conversationTurns.attachmentFileIds}, JSON_QUOTE(${input.fileId}), '$')`,
    )
    .limit(1);
  if (turnReferences[0]) {
    throw new AuthServiceError(
      "CONFLICT",
      "UPLOAD_ALREADY_BOUND: file has a knowledge turn reference",
    );
  }

  const deliveryAttachmentReferences = await input.executor
    .select({ id: deliveryTicketAttachments.id })
    .from(deliveryTicketAttachments)
    .where(eq(deliveryTicketAttachments.upstreamFileId, input.fileId))
    .limit(1);
  const redirectPreviewReferences = deliveryAttachmentReferences[0]
    ? []
    : await input.executor
        .select({ id: deliveryRedirectPreviews.id })
        .from(deliveryRedirectPreviews)
        .where(eq(deliveryRedirectPreviews.upstreamFileId, input.fileId))
        .limit(1);
  const knowledgeBuildReferences =
    deliveryAttachmentReferences[0] || redirectPreviewReferences[0]
      ? []
      : await input.executor
          .select({ id: knowledgeBaseBuilds.id })
          .from(knowledgeBaseBuilds)
          .where(eq(knowledgeBaseBuilds.packageFileId, input.fileId))
          .limit(1);
  if (
    deliveryAttachmentReferences[0] ||
    redirectPreviewReferences[0] ||
    knowledgeBuildReferences[0]
  ) {
    throw new AuthServiceError(
      "CONFLICT",
      "UPLOAD_ALREADY_BOUND: file has a durable workspace reference",
    );
  }

  await input.discard({
    fileId: input.fileId,
    userId: row.resource.userId,
    projectAssignmentId: row.resource.projectAssignmentId,
    apiCredentialId: row.resource.apiCredentialId,
    apiKey: decryptApiKey(row.credential),
  });
  await input.executor
    .delete(upstreamResources)
    .where(
      and(
        eq(upstreamResources.id, row.resource.id),
        isNull(upstreamResources.conversationId),
      ),
    );
  return { discarded: true as const };
}

export async function discardUnboundUpstreamFile(input: {
  userId: number;
  fileId: string;
  projectAssignmentId?: string | null;
  discard: (context: UnboundUpstreamFileDiscardContext) => Promise<void>;
}) {
  const db = await requireDb();
  return db.transaction((executor) =>
    discardUnboundUpstreamFileInTransaction({ ...input, executor }),
  );
}

export async function getOwnedUpstreamResourceIds(
  userId: number,
  kind: "task" | "file",
  upstreamIds: string[],
  projectAssignmentId?: string,
) {
  const uniqueIds = [...new Set(upstreamIds.filter(Boolean))];
  if (uniqueIds.length === 0) return new Set<string>();
  const db = await requireDb();
  const rows = await db
    .select({
      upstreamId: upstreamResources.upstreamId,
      createdAt: upstreamResources.createdAt,
      uploadedAt: upstreamResources.uploadedAt,
      contentExpiresAt: upstreamResources.contentExpiresAt,
      contentDeletedAt: upstreamResources.contentDeletedAt,
    })
    .from(upstreamResources)
    .where(
      and(
        projectAssignmentId
          ? eq(upstreamResources.projectAssignmentId, projectAssignmentId)
          : and(
              eq(upstreamResources.userId, userId),
              isNull(upstreamResources.projectAssignmentId),
            ),
        eq(upstreamResources.kind, kind),
        inArray(upstreamResources.upstreamId, uniqueIds),
      ),
    );
  return new Set(
    rows
      .filter((row) => kind !== "file" || !isFileResourceContentExpired(row))
      .map((row) => row.upstreamId),
  );
}

export async function isUpstreamApiKeyShared(
  userId: number,
  fingerprint: string,
) {
  const db = await requireDb();
  const [otherAccounts, website] = await Promise.all([
    db
      .select({ id: apiCredentials.id })
      .from(apiCredentials)
      .where(
        and(
          eq(apiCredentials.fingerprint, fingerprint),
          ne(apiCredentials.userId, userId),
          ne(apiCredentials.status, "deleted"),
        ),
      )
      .limit(1),
    db
      .select({ id: presalesApiCredentials.id })
      .from(presalesApiCredentials)
      .where(
        and(
          eq(presalesApiCredentials.slot, "website"),
          eq(presalesApiCredentials.fingerprint, fingerprint),
          ne(presalesApiCredentials.status, "deleted"),
        ),
      )
      .limit(1),
  ]);
  return Boolean(otherAccounts[0] || website[0]);
}

export async function recordUpstreamResource(input: {
  userId: number;
  apiCredentialId: string;
  kind: "task" | "file";
  upstreamId: string;
  conversationId?: string | null;
  projectAssignmentId?: string | null;
}): Promise<UpstreamResource> {
  const db = await requireDb();
  const projectAssignmentId = input.projectAssignmentId ?? null;
  const existing = await db
    .select()
    .from(upstreamResources)
    .where(
      and(
        eq(upstreamResources.kind, input.kind),
        eq(upstreamResources.upstreamId, input.upstreamId),
      ),
    )
    .limit(1);
  if (existing[0]) {
    const ownedByRequestedScope = projectAssignmentId
      ? existing[0].projectAssignmentId === projectAssignmentId
      : existing[0].userId === input.userId &&
        existing[0].projectAssignmentId == null;
    if (!ownedByRequestedScope) {
      throw new AuthServiceError(
        "CONFLICT",
        "Upstream resource is already owned by another account or project",
      );
    }
    return existing[0];
  }

  if (projectAssignmentId) {
    const assignmentRows = await db
      .select({ id: deliveryProjectAssignments.id })
      .from(deliveryProjectAssignments)
      .where(
        and(
          eq(deliveryProjectAssignments.id, projectAssignmentId),
          eq(deliveryProjectAssignments.engineerUserId, input.userId),
        ),
      )
      .limit(1);
    if (!assignmentRows[0]) {
      throw new AuthServiceError(
        "NOT_FOUND",
        "Customer project assignment not found",
      );
    }
  }

  const credentialMayServeCurrentEngineer = await credentialMayServeAccount(
    db,
    input.userId,
    input.apiCredentialId,
  );
  const credentialAlreadyBoundToProject =
    projectAssignmentId && !credentialMayServeCurrentEngineer
      ? await db
          .select({ id: upstreamResources.id })
          .from(upstreamResources)
          .innerJoin(
            apiCredentials,
            eq(upstreamResources.apiCredentialId, apiCredentials.id),
          )
          .where(
            and(
              eq(upstreamResources.projectAssignmentId, projectAssignmentId),
              eq(upstreamResources.apiCredentialId, input.apiCredentialId),
              ne(apiCredentials.status, "deleted"),
            ),
          )
          .limit(1)
      : [];
  if (
    !credentialMayServeCurrentEngineer &&
    !credentialAlreadyBoundToProject[0]
  ) {
    throw new AuthServiceError("NOT_FOUND", "API credential not found");
  }

  if (input.conversationId) {
    const conversation = await db
      .select({ id: conversations.id })
      .from(conversations)
      .where(
        and(
          eq(conversations.id, input.conversationId),
          projectAssignmentId
            ? eq(conversations.projectAssignmentId, projectAssignmentId)
            : and(
                eq(conversations.userId, input.userId),
                isNull(conversations.projectAssignmentId),
              ),
        ),
      )
      .limit(1);
    if (!conversation[0]) {
      throw new AuthServiceError("NOT_FOUND", "Conversation not found");
    }
  }

  const resource: UpstreamResource = {
    id: randomUUID(),
    userId: input.userId,
    apiCredentialId: input.apiCredentialId,
    projectAssignmentId,
    kind: input.kind,
    upstreamId: input.upstreamId,
    conversationId: input.conversationId ?? null,
    createdAt: new Date(),
    uploadedAt: null,
    contentExpiresAt: null,
    contentDeletedAt: null,
  };
  try {
    await db.insert(upstreamResources).values(resource);
    return resource;
  } catch (error) {
    const mysqlError = error as { code?: string };
    if (mysqlError.code !== "ER_DUP_ENTRY") throw error;

    const raced = await db
      .select()
      .from(upstreamResources)
      .where(
        and(
          eq(upstreamResources.kind, input.kind),
          eq(upstreamResources.upstreamId, input.upstreamId),
          projectAssignmentId
            ? eq(upstreamResources.projectAssignmentId, projectAssignmentId)
            : and(
                eq(upstreamResources.userId, input.userId),
                isNull(upstreamResources.projectAssignmentId),
              ),
        ),
      )
      .limit(1);
    if (raced[0]) return raced[0];
    throw new AuthServiceError(
      "CONFLICT",
      "Upstream resource is already owned by another account or project",
    );
  }
}
