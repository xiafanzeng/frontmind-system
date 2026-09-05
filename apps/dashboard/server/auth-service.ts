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
} from "drizzle-orm";
import type { Request } from "express";
import { COOKIE_NAME } from "../shared/const";
import {
  isExplicitAdminAccessLevel,
  isProtectedBuiltinAdminUsername,
} from "../shared/admin-access";
import {
  apiCredentials,
  apiKeyOwnership,
  conversations,
  conversationTurns,
  deliveryProjectAssignments,
  deliveryRedirectPreviews,
  deliveryTicketAttachments,
  deliveryTickets,
  knowledgeBaseBuilds,
  knowledgeBaseResetRequests,
  presalesApiCredentials,
  sessions,
  upstreamResources,
  userAdminAssignments,
  userPasswordSetupTokens,
  userUsageOwners,
  users,
  websiteStyleSampleBatches,
  websiteStyleSamples,
  websiteUserProvisions,
  type ApiCredential,
  type UpstreamResource,
  type User,
} from "../drizzle/schema";
import { getDb } from "./db";
import { isFileResourceContentExpired } from "./file-content-retention";
import { getUpstreamBaseUrl } from "./upstream-config";

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
};

export type CredentialStatus = {
  configured: boolean;
  version: number;
  fingerprint: string | null;
  status: "active" | "retired" | "invalid" | null;
  verifiedAt: number | null;
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
          "该工程师仍负责客户项目或未结束工单，请先完成转交",
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

export async function deleteManagedUser(
  actorUserId: number,
  targetUserId: number,
) {
  if (actorUserId === targetUserId) {
    throw new AuthServiceError(
      "CONFLICT",
      "The current administrator account cannot be deleted",
    );
  }

  const db = await requireDb();
  const result = await db.transaction(async (tx) => {
    const rows = await tx
      .select()
      .from(users)
      .where(eq(users.id, targetUserId))
      .limit(1)
      .for("update");
    const user = rows[0];
    if (!user) throw new AuthServiceError("NOT_FOUND", "User not found");
    if (isProtectedBuiltinAdminUsername(user.username)) {
      throw new AuthServiceError("CONFLICT", "内置 admin 系统管理员不能被删除");
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
          .where(eq(deliveryProjectAssignments.engineerUserId, targetUserId))
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
          "该工程师仍负责客户项目或未结束工单，请先完成转交",
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
    await consumeAllUserPasswordSetupTokensInExecutor(tx, targetUserId, now);
    await revokeAllUserSessionsInExecutor(tx, targetUserId, now);
    await permanentlyDeleteManagedUserRows(tx, targetUserId);
    return { disposition: "permanently_deleted" as const };
  });
  return result;
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
  let response: globalThis.Response;
  try {
    response = await fetch(`${getUpstreamBaseUrl()}/v1/tasks?limit=1`, {
      method: "GET",
      redirect: "error",
      headers: {
        API_KEY: apiKey,
        Authorization: `Bearer ${apiKey}`,
        Accept: "application/json",
      },
      signal: AbortSignal.timeout(15_000),
    });
  } catch {
    throw new AuthServiceError(
      "UPSTREAM_UNAVAILABLE",
      "Unable to validate the API credential",
    );
  }

  if (response.status === 401 || response.status === 403) {
    throw new AuthServiceError(
      "INVALID_CREDENTIAL",
      "API credential is invalid",
    );
  }
  if (!response.ok) {
    throw new AuthServiceError(
      "UPSTREAM_UNAVAILABLE",
      "Upstream service could not validate the API credential",
    );
  }
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
  const db = await requireDb();
  const directStatus = await getApiCredentialStatus(accountId);
  if (directStatus.configured) {
    return {
      ...directStatus,
      ownerUserId: accountId,
      inherited: false,
    };
  }
  const ownerRows = await db
    .select({ deliveryAdminId: userUsageOwners.deliveryAdminId })
    .from(userUsageOwners)
    .where(eq(userUsageOwners.userId, accountId))
    .limit(1);
  const ownerUserId = ownerRows[0]?.deliveryAdminId ?? accountId;
  return {
    ...(await getApiCredentialStatus(ownerUserId)),
    ownerUserId,
    inherited: ownerUserId !== accountId,
  };
}

export async function replaceApiCredentialInTransaction(input: {
  executor: any;
  userId: number;
  apiKey: string;
  now?: Date;
  credentialId?: string;
}): Promise<CredentialStatus> {
  const fingerprint = getApiKeyFingerprint(input.apiKey);
  const credentialId = input.credentialId ?? randomUUID();
  const encrypted = encryptApiKey(input.userId, credentialId, input.apiKey);
  const now = input.now ?? new Date();
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
    status: "active" as const,
    validationStatus: "verified" as const,
    verifiedAt: now,
    createdAt: now,
    updatedAt: now,
    retiredAt: null,
    deletedAt: null,
  };
  await tx.insert(apiCredentials).values(inserted);
  return toCredentialStatus(inserted);
}

export async function replaceApiCredential(
  userId: number,
  apiKey: string,
  validator: (apiKey: string) => Promise<void> = validateUpstreamApiKey,
): Promise<CredentialStatus> {
  const db = await requireDb();
  await validator(apiKey);
  return db.transaction((tx) =>
    replaceApiCredentialInTransaction({
      executor: tx,
      userId,
      apiKey,
    }),
  );
}

export async function deleteActiveApiCredential(userId: number) {
  const db = await requireDb();
  await db.transaction((tx) =>
    deleteActiveApiCredentialInTransaction({
      executor: tx,
      userId,
    }),
  );
}

export async function deleteActiveApiCredentialInTransaction(input: {
  executor: any;
  userId: number;
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
    };
  });
}

/**
 * Returns the active runtime credential for an account. A customer-owned
 * credential always wins. Legacy customers without one may temporarily
 * inherit the credential of their assigned usage owner.
 */
export async function getEffectiveDecryptedCredentialForAccount(
  accountId: number,
): Promise<DecryptedCredential | null> {
  const db = await requireDb();
  const accountRows = await db
    .select({ role: users.role })
    .from(users)
    .where(eq(users.id, accountId))
    .limit(1);
  const account = accountRows[0];
  if (!account) return null;
  const directCredential = await getDecryptedCredentialForUser(accountId);
  if (directCredential || account.role === "admin") return directCredential;
  const ownerRows = await db
    .select({ deliveryAdminId: userUsageOwners.deliveryAdminId })
    .from(userUsageOwners)
    .where(eq(userUsageOwners.userId, accountId))
    .limit(1);
  const ownerId = ownerRows[0]?.deliveryAdminId;
  return ownerId ? getDecryptedCredentialForUser(ownerId) : null;
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
  if (credential.ownerUserId === accountId) return true;
  const ownerRows = await executor
    .select({ deliveryAdminId: userUsageOwners.deliveryAdminId })
    .from(userUsageOwners)
    .where(eq(userUsageOwners.userId, accountId))
    .limit(1);
  return ownerRows[0]?.deliveryAdminId === credential.ownerUserId;
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
    resource: row.resource,
  };
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
