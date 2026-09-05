import { createHash, randomUUID } from "node:crypto";
import {
  and,
  asc,
  desc,
  eq,
  gte,
  inArray,
  isNull,
  lte,
  or,
  sql,
} from "drizzle-orm";
import { z } from "zod";

import {
  deliveryProjectAssignments,
  deliveryTicketEvents,
  deliveryTickets,
  jenovaBrandTrackingAssignments,
  jenovaBrandTrackingCredentials,
  jenovaBrandTrackingPolicies,
  jenovaBrandTrackingSessions,
  jenovaBrandTrackingTurns,
  users,
  type JenovaBrandTrackingCredential,
  type JenovaBrandTrackingSession,
  type JenovaBrandTrackingTurn,
} from "../drizzle/schema";
import { hasSystemAdminAccess } from "./admin-control-plane-service";
import {
  AuthServiceError,
  decryptCredentialSecret,
  encryptCredentialSecret,
  type AuthenticatedUser,
} from "./auth-service";
import {
  toBrandTrackingPublicCode,
  toBrandTrackingPublicEvent,
  toBrandTrackingPublicRecord,
  toBrandTrackingPublicText,
} from "./brand-tracking-public-projection";
import { getDb } from "./db";
import { getDashboardWorkspace } from "./dashboard-service";
import {
  JenovaBrandTrackingClient,
  JenovaClientError,
  jenovaBrandTrackingClient,
  normalizeJenovaDecimal,
  type JenovaStreamEvent,
} from "./jenova-brand-tracking-client";

export const JENOVA_DEFAULT_ROLLING_LIMIT = "10.00000000";
export const JENOVA_SESSION_CREATION_FEE = "0.01000000";
export const JENOVA_ROLLING_WINDOW_MS = 30 * 24 * 60 * 60 * 1_000;
const ZERO = "0.00000000";
const ACTIVE_CREDENTIAL_TICKET_STATUSES = [
  "submitted",
  "needs_information",
  "scheduled",
  "in_progress",
] as const;
const JENOVA_CREDENTIAL_COMPLETION_SUMMARY =
  "Jenova 品牌追踪 API 密钥已由系统管理员配置并通过连接验证。";

export type JenovaBrandTrackingErrorCode =
  | "UNAUTHORIZED"
  | "FORBIDDEN"
  | "INELIGIBLE"
  | "NOT_FOUND"
  | "KEY_REQUIRED"
  | "LIMIT_EXCEEDED"
  | "CONFLICT"
  | "IDEMPOTENCY_PENDING"
  | "IDEMPOTENCY_CONFLICT"
  | "BRAND_IDENTITY_REQUIRED"
  | "INVALID_INPUT"
  | "UPSTREAM_UNAVAILABLE"
  | "USAGE_UNKNOWN"
  | "DATABASE_UNAVAILABLE";

export class JenovaBrandTrackingError extends Error {
  constructor(
    public readonly code: JenovaBrandTrackingErrorCode,
    message: string,
    public readonly statusCode: number,
    public readonly retryAfterMs?: number,
  ) {
    super(message);
    this.name = "JenovaBrandTrackingError";
  }
}

export function jenovaBrandTrackingHttpStatus(error: unknown) {
  return error instanceof JenovaBrandTrackingError ? error.statusCode : 500;
}

/** Adapter for existing tRPC routers that already use auth-router.toTrpcError. */
export function toJenovaBrandTrackingAuthError(error: unknown) {
  if (!(error instanceof JenovaBrandTrackingError)) {
    return new AuthServiceError(
      "UPSTREAM_UNAVAILABLE",
      "品牌追踪服务暂时不可用",
    );
  }
  const code =
    error.code === "NOT_FOUND"
      ? "NOT_FOUND"
      : error.code === "CONFLICT"
        ? "CONFLICT"
        : error.code === "LIMIT_EXCEEDED"
          ? "RATE_LIMITED"
          : error.code === "IDEMPOTENCY_PENDING"
            ? "IDEMPOTENCY_PENDING"
            : error.code === "IDEMPOTENCY_CONFLICT"
              ? "CONFLICT"
              : error.code === "DATABASE_UNAVAILABLE"
                ? "DATABASE_UNAVAILABLE"
                : error.code === "UPSTREAM_UNAVAILABLE" ||
                    error.code === "USAGE_UNKNOWN"
                  ? "UPSTREAM_UNAVAILABLE"
                  : "INVALID_CREDENTIAL";
  return new AuthServiceError(code, error.message, error.retryAfterMs);
}

export type JenovaBrandTrackingUsageDto = {
  rolling30DayCost: string;
  lifetimeCost: string;
  limit: string;
  remaining: string;
  exceededBy: string;
  windowStartedAt: string;
  windowEndsAt: string;
  pendingReconciliationCount: number;
  hasUnknownUsage: boolean;
  keyConfigured: boolean;
  blocked: boolean;
  blockReason: string | null;
};

export type BrandTrackingOverviewDto = {
  eligible: boolean;
  keyConfigured: boolean;
  blocked: boolean;
  blockReason: string | null;
  activeSessionId: string | null;
  usage: JenovaBrandTrackingUsageDto;
};

export type BrandTrackingSessionSummaryDto = {
  sessionId: string;
  title: string;
  status: "active" | "archived";
  createdAt: string;
  updatedAt: string;
  lastMessagePreview?: string;
};

export type BrandTrackingMessageDto = {
  messageId: string;
  role: "user" | "assistant";
  content: string;
  status: "streaming" | "completed" | "failed" | "pending_reconciliation";
  createdAt: string;
  usageCost?: string;
};

export type BrandTrackingSessionDto = {
  session: BrandTrackingSessionSummaryDto;
  messages: BrandTrackingMessageDto[];
};

export type BrandTrackingSseEvent =
  | {
      event: "session";
      data: {
        sessionId: string;
        title: string;
        status: "active" | "archived";
        messageId: string;
      };
    }
  | {
      event: "delta";
      data: { messageId: string; text: string; content: string };
    }
  | {
      event: "progress";
      data: { messageId: string; message: string } & Record<string, unknown>;
    }
  | {
      event: "warning";
      data: { messageId: string; code: string | null; message: string };
    }
  | {
      event: "usage";
      data: {
        messageId: string;
        cost: string;
        usageCost: string;
        sessionFee: string;
        totalCost: string;
      };
    }
  | {
      event: "error";
      data: {
        code: string;
        message: string;
        recoverable: boolean;
      };
    }
  | {
      event: "end";
      data: {
        sessionId: string;
        messageId: string;
        status: "completed" | "failed" | "pending_reconciliation";
      };
    };

function brandTrackingPublicEmitter(
  emit: (event: BrandTrackingSseEvent) => void | Promise<void>,
) {
  return (event: BrandTrackingSseEvent) =>
    emit(toBrandTrackingPublicEvent(event));
}

export type JenovaCredentialAssignmentRowDto = {
  userId: number;
  username: string;
  displayName: string | null;
  keyConfigured: boolean;
  credentialId: string | null;
  fingerprint: string | null;
  rolling30DayCost: string;
  lifetimeCost: string;
  sharedKeyAttributedCost: string;
  sharedAccountCount: number;
  balance: string | null;
  balanceSyncedAt: string | null;
  limit: string;
  status: "active" | "revoked" | null;
  pendingReconciliationCount: number;
};

type Database = NonNullable<Awaited<ReturnType<typeof getDb>>>;
type ServiceClient = Pick<
  JenovaBrandTrackingClient,
  | "validateKey"
  | "getBalance"
  | "streamMessage"
  | "getSessionRun"
  | "listSessionMessages"
>;

export type JenovaBrandTrackingDependencies = {
  getDatabase?: typeof getDb;
  getDashboardWorkspace?: typeof getDashboardWorkspace;
  client?: ServiceClient;
  now?: () => Date;
  randomId?: () => string;
};

const clientRequestSchema = z.string().uuid();
const messageSchema = z.string().trim().min(1).max(20_000);
const userIdsSchema = z.array(z.number().int().positive()).min(1).max(5_000);
const limitSchema = z
  .string()
  .trim()
  .regex(/^(?:0|[1-9]\d{0,11})(?:\.\d{1,8})?$/)
  .transform(normalizeJenovaDecimal);

function deps(input: JenovaBrandTrackingDependencies = {}) {
  return {
    getDatabase: input.getDatabase ?? getDb,
    getDashboardWorkspace: input.getDashboardWorkspace ?? getDashboardWorkspace,
    client: input.client ?? jenovaBrandTrackingClient,
    now: input.now ?? (() => new Date()),
    randomId: input.randomId ?? randomUUID,
  };
}

export function normalizeJenovaBrandTrackingIdentity(value: unknown) {
  if (typeof value !== "string") {
    throw new JenovaBrandTrackingError(
      "BRAND_IDENTITY_REQUIRED",
      "请先在看板绑定有效的品牌名称",
      422,
    );
  }
  const normalized = value
    .normalize("NFKC")
    .replace(/\p{Cc}+/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
  const length = Array.from(normalized).length;
  if (length < 1 || length > 160) {
    throw new JenovaBrandTrackingError(
      "BRAND_IDENTITY_REQUIRED",
      "请先在看板绑定有效的品牌名称",
      422,
    );
  }
  return normalized;
}

export function buildJenovaBrandTrackingKickoff(brandName: unknown) {
  const brand = normalizeJenovaBrandTrackingIdentity(brandName);
  return [
    "请按以下设置直接启动品牌追踪：",
    `1. 要追踪的品牌、产品或公司名称：${brand}`,
    "2. 名称变体：不确定",
    "3. 平台：全部",
    "4. 时间范围：过去7天",
  ].join("\n");
}

async function requireDatabase(getDatabase: typeof getDb) {
  const db = await getDatabase();
  if (!db) {
    throw new JenovaBrandTrackingError(
      "DATABASE_UNAVAILABLE",
      "数据库暂不可用",
      503,
    );
  }
  return db;
}

function moneyUnits(value: string | number | null | undefined): bigint {
  const normalized = normalizeJenovaDecimal(value ?? ZERO);
  const [whole, fraction] = normalized.split(".");
  return BigInt(whole) * 100_000_000n + BigInt(fraction);
}

function moneyString(value: bigint) {
  const nonNegative = value < 0n ? 0n : value;
  const whole = nonNegative / 100_000_000n;
  const fraction = (nonNegative % 100_000_000n).toString().padStart(8, "0");
  return `${whole}.${fraction}`;
}

export function addJenovaMoney(...values: (string | null | undefined)[]) {
  return moneyString(
    values.reduce((sum, value) => sum + moneyUnits(value), 0n),
  );
}

export function isWithinJenovaRollingWindow(createdAt: Date, now: Date) {
  const startedAt = now.getTime() - JENOVA_ROLLING_WINDOW_MS;
  const timestamp = createdAt.getTime();
  return timestamp >= startedAt && timestamp <= now.getTime();
}

function subtractMoney(left: string, right: string) {
  return moneyString(moneyUnits(left) - moneyUnits(right));
}

function isAtLeast(left: string, right: string) {
  return moneyUnits(left) >= moneyUnits(right);
}

function credentialAad(credentialId: string) {
  return `frontmind-jenova-brand-tracker-credential:v1:${credentialId}`;
}

function encryptJenovaKey(credentialId: string, apiKey: string) {
  return encryptCredentialSecret(credentialAad(credentialId), apiKey.trim());
}

function decryptJenovaKey(
  credential: Pick<
    JenovaBrandTrackingCredential,
    | "id"
    | "encryptionVersion"
    | "encryptedKey"
    | "encryptionIv"
    | "encryptionAuthTag"
  >,
) {
  return decryptCredentialSecret(credentialAad(credential.id), credential);
}

export function jenovaCredentialFingerprint(apiKey: string) {
  return `jfp_${createHash("sha256")
    .update(apiKey.trim(), "utf8")
    .digest("hex")
    .slice(0, 24)}`;
}

export function assertJenovaCredentialPoolCapacity(
  activeCredentialCount: number,
  credentialAlreadyActive: boolean,
) {
  if (!credentialAlreadyActive && activeCredentialCount >= 10) {
    throw new JenovaBrandTrackingError(
      "LIMIT_EXCEEDED",
      "Jenova 最多只能配置 10 把有效物理 Key",
      409,
    );
  }
}

export function projectedJenovaActiveCredentialCount(
  activeCredentialCount: number,
  reclaimableCredentialCount: number,
) {
  return Math.max(0, activeCredentialCount - reclaimableCredentialCount);
}

export function isJenovaBrandTrackingEligibleActor(
  actor: Pick<AuthenticatedUser, "role" | "isActive" | "marketEdition">,
) {
  return (
    actor.role === "user" &&
    actor.isActive === true &&
    actor.marketEdition === "overseas"
  );
}

function assertEligibleActor(actor: AuthenticatedUser) {
  if (!isJenovaBrandTrackingEligibleActor(actor)) {
    throw new JenovaBrandTrackingError(
      "INELIGIBLE",
      "品牌追踪仅向有效的海外版用户开放",
      403,
    );
  }
}

export function assertJenovaBrandTrackingSystemAdmin(actor: AuthenticatedUser) {
  if (!actor.isActive || !hasSystemAdminAccess(actor)) {
    throw new JenovaBrandTrackingError(
      "FORBIDDEN",
      "只有系统管理员可以管理 Jenova Brand Tracker Key",
      403,
    );
  }
}

function toDate(value: Date | string) {
  return value instanceof Date ? value : new Date(value);
}

function toIso(value: Date | string) {
  return toDate(value).toISOString();
}

function costSql() {
  return sql<string>`COALESCE(SUM(${jenovaBrandTrackingTurns.sessionFee} + CASE WHEN ${jenovaBrandTrackingTurns.costState} = 'confirmed' THEN COALESCE(${jenovaBrandTrackingTurns.usageCost}, 0.00000000) ELSE 0.00000000 END), 0.00000000)`;
}

async function loadUsageNumbers(db: any, userId: number, now: Date) {
  const windowStartedAt = new Date(now.getTime() - JENOVA_ROLLING_WINDOW_MS);
  // Keep transaction-scoped reads serial: mysql2 pins a transaction to one
  // connection and does not support concurrent commands on that connection.
  const policyRows = await db
    .select({ limit: jenovaBrandTrackingPolicies.rolling30DayLimit })
    .from(jenovaBrandTrackingPolicies)
    .where(eq(jenovaBrandTrackingPolicies.userId, userId))
    .limit(1);
  const rollingRows = await db
    .select({
      cost: costSql(),
      pending: sql<number>`SUM(CASE WHEN ${jenovaBrandTrackingTurns.status} IN ('pending', 'streaming', 'recovering') OR ${jenovaBrandTrackingTurns.costState} IN ('pending', 'unknown') THEN 1 ELSE 0 END)`,
    })
    .from(jenovaBrandTrackingTurns)
    .where(
      and(
        eq(jenovaBrandTrackingTurns.userId, userId),
        gte(jenovaBrandTrackingTurns.createdAt, windowStartedAt),
        lte(jenovaBrandTrackingTurns.createdAt, now),
      ),
    );
  const lifetimeRows = await db
    .select({ cost: costSql() })
    .from(jenovaBrandTrackingTurns)
    .where(eq(jenovaBrandTrackingTurns.userId, userId));
  const assignmentRows = await db
    .select({ credentialId: jenovaBrandTrackingCredentials.id })
    .from(jenovaBrandTrackingAssignments)
    .innerJoin(
      jenovaBrandTrackingCredentials,
      eq(
        jenovaBrandTrackingAssignments.credentialId,
        jenovaBrandTrackingCredentials.id,
      ),
    )
    .where(
      and(
        eq(jenovaBrandTrackingAssignments.userId, userId),
        eq(jenovaBrandTrackingCredentials.status, "active"),
        eq(jenovaBrandTrackingCredentials.validationStatus, "verified"),
      ),
    )
    .limit(1);
  return {
    rolling30DayCost: normalizeJenovaDecimal(rollingRows[0]?.cost ?? ZERO),
    lifetimeCost: normalizeJenovaDecimal(lifetimeRows[0]?.cost ?? ZERO),
    limit: normalizeJenovaDecimal(
      policyRows[0]?.limit ?? JENOVA_DEFAULT_ROLLING_LIMIT,
    ),
    pendingReconciliationCount: Number(rollingRows[0]?.pending ?? 0),
    keyConfigured: Boolean(assignmentRows[0]),
    windowStartedAt,
    windowEndsAt: now,
  };
}

export function buildJenovaBrandTrackingUsageDto(
  numbers: Awaited<ReturnType<typeof loadUsageNumbers>>,
  eligibility = true,
): JenovaBrandTrackingUsageDto {
  const exceeded = isAtLeast(numbers.rolling30DayCost, numbers.limit);
  const hasUnknownUsage = numbers.pendingReconciliationCount > 0;
  const blocked =
    !eligibility || !numbers.keyConfigured || hasUnknownUsage || exceeded;
  const blockReason = !eligibility
    ? "当前账号不是有效的海外版用户"
    : !numbers.keyConfigured
      ? "系统管理员尚未配置品牌追踪 Key"
      : hasUnknownUsage
        ? "上一轮积分仍在核对，暂时不能发送新消息"
        : exceeded
          ? "最近 30 天品牌追踪积分已达到上限"
          : null;
  return {
    rolling30DayCost: numbers.rolling30DayCost,
    lifetimeCost: numbers.lifetimeCost,
    limit: numbers.limit,
    remaining: subtractMoney(numbers.limit, numbers.rolling30DayCost),
    exceededBy: subtractMoney(numbers.rolling30DayCost, numbers.limit),
    windowStartedAt: numbers.windowStartedAt.toISOString(),
    windowEndsAt: numbers.windowEndsAt.toISOString(),
    pendingReconciliationCount: numbers.pendingReconciliationCount,
    hasUnknownUsage,
    keyConfigured: numbers.keyConfigured,
    blocked,
    blockReason,
  };
}

export async function getJenovaBrandTrackingOverview(
  actor: AuthenticatedUser,
  dependencies: JenovaBrandTrackingDependencies = {},
): Promise<BrandTrackingOverviewDto> {
  assertEligibleActor(actor);
  const resolved = deps(dependencies);
  const db = await requireDatabase(resolved.getDatabase);
  const eligible = true;
  const numbers = await loadUsageNumbers(db, actor.id, resolved.now());
  const activeSession = eligible
    ? await db
        .select({ id: jenovaBrandTrackingSessions.id })
        .from(jenovaBrandTrackingSessions)
        .where(
          and(
            eq(jenovaBrandTrackingSessions.userId, actor.id),
            eq(jenovaBrandTrackingSessions.status, "active"),
          ),
        )
        .orderBy(desc(jenovaBrandTrackingSessions.updatedAt))
        .limit(1)
    : [];
  const usage = buildJenovaBrandTrackingUsageDto(numbers, eligible);
  return {
    eligible,
    keyConfigured: usage.keyConfigured,
    blocked: usage.blocked,
    blockReason: usage.blockReason
      ? toBrandTrackingPublicText(usage.blockReason)
      : null,
    activeSessionId: activeSession[0]?.id ?? null,
    usage: {
      ...usage,
      blockReason: usage.blockReason
        ? toBrandTrackingPublicText(usage.blockReason)
        : null,
    },
  };
}

function sessionSummary(
  session: Pick<
    JenovaBrandTrackingSession,
    "id" | "title" | "status" | "createdAt" | "updatedAt"
  >,
  lastMessagePreview?: string,
): BrandTrackingSessionSummaryDto {
  return {
    sessionId: session.id,
    title: toBrandTrackingPublicText(session.title),
    status: session.status,
    createdAt: toIso(session.createdAt),
    updatedAt: toIso(session.updatedAt),
    ...(lastMessagePreview
      ? { lastMessagePreview: toBrandTrackingPublicText(lastMessagePreview) }
      : {}),
  };
}

export async function listJenovaBrandTrackingSessions(
  actor: AuthenticatedUser,
  dependencies: JenovaBrandTrackingDependencies = {},
) {
  assertEligibleActor(actor);
  const resolved = deps(dependencies);
  const db = await requireDatabase(resolved.getDatabase);
  const sessions = await db
    .select()
    .from(jenovaBrandTrackingSessions)
    .where(eq(jenovaBrandTrackingSessions.userId, actor.id))
    .orderBy(desc(jenovaBrandTrackingSessions.updatedAt));
  if (sessions.length === 0) return { sessions: [] };
  const turns = await db
    .select({
      sessionId: jenovaBrandTrackingTurns.sessionId,
      assistantContent: jenovaBrandTrackingTurns.assistantContent,
      userContent: jenovaBrandTrackingTurns.userContent,
      hiddenKickoff: jenovaBrandTrackingTurns.hiddenKickoff,
      createdAt: jenovaBrandTrackingTurns.createdAt,
    })
    .from(jenovaBrandTrackingTurns)
    .where(
      inArray(
        jenovaBrandTrackingTurns.sessionId,
        sessions.map((item: JenovaBrandTrackingSession) => item.id),
      ),
    )
    .orderBy(desc(jenovaBrandTrackingTurns.createdAt));
  const previews = new Map<string, string>();
  for (const turn of turns) {
    if (previews.has(turn.sessionId)) continue;
    const content =
      turn.assistantContent || (turn.hiddenKickoff ? "" : turn.userContent);
    if (content) previews.set(turn.sessionId, content.slice(0, 160));
  }
  return {
    sessions: sessions.map((session: JenovaBrandTrackingSession) =>
      sessionSummary(session, previews.get(session.id)),
    ),
  };
}

function messageStatus(
  status: JenovaBrandTrackingTurn["status"],
): BrandTrackingMessageDto["status"] {
  if (status === "completed") return "completed";
  if (status === "failed") return "failed";
  if (status === "recovering") return "pending_reconciliation";
  return "streaming";
}

function turnTotalCost(
  turn: Pick<JenovaBrandTrackingTurn, "usageCost" | "sessionFee">,
) {
  return addJenovaMoney(turn.usageCost, turn.sessionFee);
}

export async function getJenovaBrandTrackingSession(
  actor: AuthenticatedUser,
  sessionId: string,
  dependencies: JenovaBrandTrackingDependencies = {},
): Promise<BrandTrackingSessionDto> {
  assertEligibleActor(actor);
  const resolved = deps(dependencies);
  const db = await requireDatabase(resolved.getDatabase);
  const sessionRows = await db
    .select()
    .from(jenovaBrandTrackingSessions)
    .where(
      and(
        eq(jenovaBrandTrackingSessions.id, sessionId),
        eq(jenovaBrandTrackingSessions.userId, actor.id),
      ),
    )
    .limit(1);
  const session = sessionRows[0];
  if (!session) {
    throw new JenovaBrandTrackingError("NOT_FOUND", "品牌追踪会话不存在", 404);
  }
  const turns = await db
    .select()
    .from(jenovaBrandTrackingTurns)
    .where(eq(jenovaBrandTrackingTurns.sessionId, session.id))
    .orderBy(asc(jenovaBrandTrackingTurns.createdAt));
  const messages: BrandTrackingMessageDto[] = [];
  for (const turn of turns) {
    const status = messageStatus(turn.status);
    if (!turn.hiddenKickoff) {
      messages.push({
        messageId: `${turn.id}:user`,
        role: "user",
        content: toBrandTrackingPublicText(turn.userContent),
        status: turn.status === "failed" ? "failed" : "completed",
        createdAt: toIso(turn.createdAt),
      });
    }
    messages.push({
      messageId: `${turn.id}:assistant`,
      role: "assistant",
      content: toBrandTrackingPublicText(turn.assistantContent),
      status,
      createdAt: toIso(turn.createdAt),
      ...(turn.costState === "confirmed"
        ? { usageCost: turnTotalCost(turn) }
        : {}),
    });
  }
  return { session: sessionSummary(session), messages };
}

async function listCredentialRows(
  db: any,
  now: Date,
  userIds?: number[],
): Promise<JenovaCredentialAssignmentRowDto[]> {
  const userConditions = [
    eq(users.role, "user"),
    eq(users.marketEdition, "overseas"),
  ];
  if (userIds) userConditions.push(inArray(users.id, userIds));
  const targetUsers = await db
    .select({
      userId: users.id,
      username: users.username,
      displayName: users.displayName,
      credentialId: jenovaBrandTrackingCredentials.id,
      fingerprint: jenovaBrandTrackingCredentials.fingerprint,
      credentialStatus: jenovaBrandTrackingCredentials.status,
      validationStatus: jenovaBrandTrackingCredentials.validationStatus,
      balance: jenovaBrandTrackingCredentials.lastBalance,
      balanceSyncedAt: jenovaBrandTrackingCredentials.balanceSyncedAt,
      limit: jenovaBrandTrackingPolicies.rolling30DayLimit,
    })
    .from(users)
    .leftJoin(
      jenovaBrandTrackingAssignments,
      eq(jenovaBrandTrackingAssignments.userId, users.id),
    )
    .leftJoin(
      jenovaBrandTrackingCredentials,
      eq(
        jenovaBrandTrackingAssignments.credentialId,
        jenovaBrandTrackingCredentials.id,
      ),
    )
    .leftJoin(
      jenovaBrandTrackingPolicies,
      eq(jenovaBrandTrackingPolicies.userId, users.id),
    )
    .where(and(...userConditions))
    .orderBy(asc(users.id));
  if (targetUsers.length === 0) return [];

  const ids = targetUsers.map((item: { userId: number }) => item.userId);
  const credentialIds = targetUsers
    .map((item: { credentialId: string | null }) => item.credentialId)
    .filter((item: string | null): item is string => Boolean(item));
  const windowStartedAt = new Date(now.getTime() - JENOVA_ROLLING_WINDOW_MS);
  const [userCosts, sharedCosts, accountCounts] = await Promise.all([
    db
      .select({
        userId: jenovaBrandTrackingTurns.userId,
        rollingCost: sql<string>`COALESCE(SUM(CASE WHEN ${jenovaBrandTrackingTurns.createdAt} >= ${windowStartedAt} AND ${jenovaBrandTrackingTurns.createdAt} <= ${now} THEN ${jenovaBrandTrackingTurns.sessionFee} + CASE WHEN ${jenovaBrandTrackingTurns.costState} = 'confirmed' THEN COALESCE(${jenovaBrandTrackingTurns.usageCost}, 0.00000000) ELSE 0.00000000 END ELSE 0.00000000 END), 0.00000000)`,
        lifetimeCost: costSql(),
        pending: sql<number>`SUM(CASE WHEN ${jenovaBrandTrackingTurns.status} IN ('pending', 'streaming', 'recovering') OR ${jenovaBrandTrackingTurns.costState} IN ('pending', 'unknown') THEN 1 ELSE 0 END)`,
      })
      .from(jenovaBrandTrackingTurns)
      .where(inArray(jenovaBrandTrackingTurns.userId, ids))
      .groupBy(jenovaBrandTrackingTurns.userId),
    credentialIds.length
      ? db
          .select({
            credentialId: jenovaBrandTrackingTurns.credentialId,
            cost: costSql(),
          })
          .from(jenovaBrandTrackingTurns)
          .where(inArray(jenovaBrandTrackingTurns.credentialId, credentialIds))
          .groupBy(jenovaBrandTrackingTurns.credentialId)
      : Promise.resolve([]),
    credentialIds.length
      ? db
          .select({
            credentialId: jenovaBrandTrackingAssignments.credentialId,
            count: sql<number>`COUNT(*)`,
          })
          .from(jenovaBrandTrackingAssignments)
          .where(
            inArray(jenovaBrandTrackingAssignments.credentialId, credentialIds),
          )
          .groupBy(jenovaBrandTrackingAssignments.credentialId)
      : Promise.resolve([]),
  ]);
  const userCostMap = new Map<
    number,
    { rollingCost: string; lifetimeCost: string; pending: number }
  >(userCosts.map((item: any) => [item.userId, item] as const));
  const sharedCostMap = new Map<string, string>(
    sharedCosts.map((item: any) => [item.credentialId, item.cost] as const),
  );
  const accountCountMap = new Map<string, number>(
    accountCounts.map(
      (item: any) => [item.credentialId, Number(item.count)] as const,
    ),
  );
  return targetUsers.map((item: any) => {
    const costs = userCostMap.get(item.userId);
    const keyConfigured =
      item.credentialStatus === "active" &&
      item.validationStatus === "verified";
    return {
      userId: item.userId,
      username: item.username ?? `user-${item.userId}`,
      displayName: item.displayName,
      keyConfigured,
      credentialId: item.credentialId,
      fingerprint: item.fingerprint,
      rolling30DayCost: normalizeJenovaDecimal(costs?.rollingCost ?? ZERO),
      lifetimeCost: normalizeJenovaDecimal(costs?.lifetimeCost ?? ZERO),
      sharedKeyAttributedCost: normalizeJenovaDecimal(
        item.credentialId
          ? (sharedCostMap.get(item.credentialId) ?? ZERO)
          : ZERO,
      ),
      sharedAccountCount: item.credentialId
        ? (accountCountMap.get(item.credentialId) ?? 0)
        : 0,
      balance: item.balance ? normalizeJenovaDecimal(item.balance) : null,
      balanceSyncedAt: item.balanceSyncedAt
        ? toIso(item.balanceSyncedAt)
        : null,
      limit: normalizeJenovaDecimal(item.limit ?? JENOVA_DEFAULT_ROLLING_LIMIT),
      status: item.credentialStatus,
      pendingReconciliationCount: Number(costs?.pending ?? 0),
    };
  });
}

export async function listJenovaBrandTrackingCredentialAssignments(input: {
  actor: AuthenticatedUser;
  dependencies?: JenovaBrandTrackingDependencies;
}) {
  assertJenovaBrandTrackingSystemAdmin(input.actor);
  const resolved = deps(input.dependencies);
  const db = await requireDatabase(resolved.getDatabase);
  return { users: await listCredentialRows(db, resolved.now()) };
}

async function assertOverseasTargets(executor: any, userIds: number[]) {
  const rows = await executor
    .select({
      id: users.id,
      role: users.role,
      marketEdition: users.marketEdition,
      isActive: users.isActive,
    })
    .from(users)
    .where(inArray(users.id, userIds))
    .for("update");
  if (
    rows.length !== userIds.length ||
    rows.some(
      (row: any) =>
        row.role !== "user" ||
        row.marketEdition !== "overseas" ||
        !row.isActive,
    )
  ) {
    throw new JenovaBrandTrackingError(
      "INELIGIBLE",
      "只能为有效的海外版客户配置品牌追踪 Key",
      403,
    );
  }
}

type ActiveJenovaCredentialTicket = {
  id: string;
  userId: number;
  credentialTargetUserId: number | null;
  credentialRequestKind: string | null;
  status: string;
};

export function resolveJenovaCredentialTicketsToComplete(input: {
  userIds: number[];
  activeTickets: ActiveJenovaCredentialTicket[];
  relatedTicketId?: string;
}) {
  const ticketsByTarget = new Map<number, ActiveJenovaCredentialTicket[]>();
  for (const ticket of input.activeTickets) {
    if (ticket.credentialTargetUserId === null) continue;
    const targetTickets =
      ticketsByTarget.get(ticket.credentialTargetUserId) ?? [];
    targetTickets.push(ticket);
    ticketsByTarget.set(ticket.credentialTargetUserId, targetTickets);
  }
  for (const userId of input.userIds) {
    if ((ticketsByTarget.get(userId)?.length ?? 0) > 1) {
      throw new JenovaBrandTrackingError(
        "CONFLICT",
        "同一客户存在多个有效的 Jenova 品牌追踪凭据需求，请先清理重复工单",
        409,
      );
    }
  }
  if (input.relatedTicketId) {
    const exactTicket =
      input.userIds.length === 1
        ? ticketsByTarget.get(input.userIds[0]!)?.[0]
        : undefined;
    if (exactTicket?.id !== input.relatedTicketId) {
      throw new JenovaBrandTrackingError(
        "CONFLICT",
        "关联品牌追踪凭据需求不存在、目标账号不匹配或已经关闭",
        409,
      );
    }
  }
  return input.userIds.flatMap((userId) => ticketsByTarget.get(userId) ?? []);
}

async function configureCredentialForUsers(input: {
  actor: AuthenticatedUser;
  userIds: number[];
  apiKey: string;
  relatedTicketId?: string;
  dependencies?: JenovaBrandTrackingDependencies;
}) {
  assertJenovaBrandTrackingSystemAdmin(input.actor);
  const userIds = [...new Set(userIdsSchema.parse(input.userIds))].sort(
    (left, right) => left - right,
  );
  const apiKey = input.apiKey.trim();
  const resolved = deps(input.dependencies);
  let validation: Awaited<ReturnType<ServiceClient["validateKey"]>>;
  try {
    validation = await resolved.client.validateKey(apiKey);
  } catch (error) {
    throw mapClientError(error);
  }
  const db = await requireDatabase(resolved.getDatabase);
  const now = resolved.now();
  await db.transaction(async (tx: any) => {
    await assertOverseasTargets(tx, userIds);
    const activeCredentialTickets = (await tx
      .select({
        id: deliveryTickets.id,
        userId: deliveryTickets.userId,
        credentialTargetUserId: deliveryTickets.credentialTargetUserId,
        credentialRequestKind: deliveryTickets.credentialRequestKind,
        status: deliveryTickets.status,
      })
      .from(deliveryTickets)
      .where(
        and(
          eq(deliveryTickets.credentialRequestKind, "jenova_brand_tracking"),
          inArray(deliveryTickets.credentialTargetUserId, userIds),
          inArray(deliveryTickets.status, ACTIVE_CREDENTIAL_TICKET_STATUSES),
        ),
      )
      .for("update")) as ActiveJenovaCredentialTicket[];
    const relatedTickets = resolveJenovaCredentialTicketsToComplete({
      userIds,
      activeTickets: activeCredentialTickets,
      relatedTicketId: input.relatedTicketId,
    });
    const oldAssignments = await tx
      .select({
        userId: jenovaBrandTrackingAssignments.userId,
        credentialId: jenovaBrandTrackingAssignments.credentialId,
      })
      .from(jenovaBrandTrackingAssignments)
      .where(inArray(jenovaBrandTrackingAssignments.userId, userIds))
      .for("update");
    const fingerprint = jenovaCredentialFingerprint(apiKey);
    const existingRows = await tx
      .select()
      .from(jenovaBrandTrackingCredentials)
      .where(eq(jenovaBrandTrackingCredentials.fingerprint, fingerprint))
      .limit(1)
      .for("update");
    const existing = existingRows[0] as
      | JenovaBrandTrackingCredential
      | undefined;
    let credentialId = existing?.id;
    if (!existing || existing.status !== "active") {
      const activeRows = await tx
        .select({ id: jenovaBrandTrackingCredentials.id })
        .from(jenovaBrandTrackingCredentials)
        .where(eq(jenovaBrandTrackingCredentials.status, "active"))
        .for("update");
      const oldCredentialIds = [
        ...new Set<string>(
          oldAssignments.map((row: any) => String(row.credentialId)),
        ),
      ];
      const allOldAssignments = oldCredentialIds.length
        ? await tx
            .select({
              userId: jenovaBrandTrackingAssignments.userId,
              credentialId: jenovaBrandTrackingAssignments.credentialId,
            })
            .from(jenovaBrandTrackingAssignments)
            .where(
              inArray(
                jenovaBrandTrackingAssignments.credentialId,
                oldCredentialIds,
              ),
            )
            .for("update")
        : [];
      const activeIds = new Set<string>(
        activeRows.map((row: any) => String(row.id)),
      );
      const targetIds = new Set(userIds);
      const reclaimableCount = oldCredentialIds.filter(
        (oldCredentialId) =>
          oldCredentialId !== credentialId &&
          activeIds.has(oldCredentialId) &&
          !allOldAssignments.some(
            (assignment: any) =>
              String(assignment.credentialId) === oldCredentialId &&
              !targetIds.has(Number(assignment.userId)),
          ),
      ).length;
      assertJenovaCredentialPoolCapacity(
        projectedJenovaActiveCredentialCount(
          activeRows.length,
          reclaimableCount,
        ),
        false,
      );
    }
    if (!credentialId) credentialId = resolved.randomId();
    const encrypted = encryptJenovaKey(credentialId, apiKey);
    if (existing) {
      await tx
        .update(jenovaBrandTrackingCredentials)
        .set({
          ...encrypted,
          status: "active",
          validationStatus: "verified",
          lastBalance: validation.balance,
          validatedAt: now,
          balanceSyncedAt: now,
          revokedAt: null,
          updatedAt: now,
        })
        .where(eq(jenovaBrandTrackingCredentials.id, credentialId));
    } else {
      await tx.insert(jenovaBrandTrackingCredentials).values({
        id: credentialId,
        ...encrypted,
        fingerprint,
        status: "active",
        validationStatus: "verified",
        lastBalance: validation.balance,
        validatedAt: now,
        balanceSyncedAt: now,
        createdByUserId: input.actor.id,
        createdAt: now,
        updatedAt: now,
      });
    }
    const changedUserIds = userIds.filter(
      (userId) =>
        oldAssignments.find((row: any) => row.userId === userId)
          ?.credentialId !== credentialId,
    );
    if (changedUserIds.length) {
      await tx
        .update(jenovaBrandTrackingSessions)
        .set({
          status: "archived",
          archivedReason: "credential_changed",
          archivedAt: now,
          updatedAt: now,
        })
        .where(
          and(
            inArray(jenovaBrandTrackingSessions.userId, changedUserIds),
            eq(jenovaBrandTrackingSessions.status, "active"),
          ),
        );
    }
    for (const userId of userIds) {
      await tx
        .insert(jenovaBrandTrackingAssignments)
        .values({
          userId,
          credentialId,
          assignedByUserId: input.actor.id,
          createdAt: now,
          updatedAt: now,
        })
        .onDuplicateKeyUpdate({
          set: {
            credentialId,
            assignedByUserId: input.actor.id,
            updatedAt: now,
          },
        });
      await tx
        .insert(jenovaBrandTrackingPolicies)
        .values({
          userId,
          rolling30DayLimit: JENOVA_DEFAULT_ROLLING_LIMIT,
          updatedByUserId: input.actor.id,
          createdAt: now,
          updatedAt: now,
        })
        .onDuplicateKeyUpdate({
          set: { userId: sql`${jenovaBrandTrackingPolicies.userId}` },
        });
    }
    const replacedCredentialIds: string[] = Array.from(
      new Set<string>(
        oldAssignments
          .map((row: any): string => String(row.credentialId))
          .filter((id: string) => id !== credentialId),
      ),
    );
    for (const replacedCredentialId of replacedCredentialIds) {
      const remaining = await tx
        .select({ userId: jenovaBrandTrackingAssignments.userId })
        .from(jenovaBrandTrackingAssignments)
        .where(
          eq(jenovaBrandTrackingAssignments.credentialId, replacedCredentialId),
        )
        .limit(1)
        .for("update");
      if (!remaining[0]) {
        await tx
          .update(jenovaBrandTrackingCredentials)
          .set({ status: "revoked", revokedAt: now, updatedAt: now })
          .where(eq(jenovaBrandTrackingCredentials.id, replacedCredentialId));
      }
    }
    for (const relatedTicket of relatedTickets) {
      await tx
        .update(deliveryTickets)
        .set({
          status: "completed",
          quotaState: "consumed",
          publicSummary: JENOVA_CREDENTIAL_COMPLETION_SUMMARY,
          resolvedAt: now,
          technicalDedupeKey: null,
          revision: sql`${deliveryTickets.revision} + 1`,
          updatedByUserId: input.actor.id,
          updatedAt: now,
        })
        .where(eq(deliveryTickets.id, relatedTicket.id));
      await tx.insert(deliveryTicketEvents).values({
        id: resolved.randomId(),
        ticketId: relatedTicket.id,
        userId: relatedTicket.userId,
        actorUserId: input.actor.id,
        actorRole: "admin",
        kind: "status_change",
        visibility: "customer",
        message: JENOVA_CREDENTIAL_COMPLETION_SUMMARY,
        fromStatus: relatedTicket.status,
        toStatus: "completed",
        createdAt: now,
      });
    }
  });
  return { users: await listCredentialRows(db, now, userIds) };
}

export async function configureJenovaBrandTrackingCredential(input: {
  actor: AuthenticatedUser;
  userId: number;
  apiKey: string;
  relatedTicketId?: string;
  dependencies?: JenovaBrandTrackingDependencies;
}) {
  return configureCredentialForUsers({ ...input, userIds: [input.userId] });
}

export async function bulkAssignJenovaBrandTrackingCredential(input: {
  actor: AuthenticatedUser;
  userIds: number[];
  apiKey: string;
  dependencies?: JenovaBrandTrackingDependencies;
}) {
  return configureCredentialForUsers(input);
}

export async function revokeJenovaBrandTrackingCredentialAssignment(input: {
  actor: AuthenticatedUser;
  userId: number;
  dependencies?: JenovaBrandTrackingDependencies;
}) {
  assertJenovaBrandTrackingSystemAdmin(input.actor);
  const resolved = deps(input.dependencies);
  const db = await requireDatabase(resolved.getDatabase);
  const now = resolved.now();
  await db.transaction(async (tx: any) => {
    const assignmentRows = await tx
      .select({ credentialId: jenovaBrandTrackingAssignments.credentialId })
      .from(jenovaBrandTrackingAssignments)
      .where(eq(jenovaBrandTrackingAssignments.userId, input.userId))
      .limit(1)
      .for("update");
    const credentialId = assignmentRows[0]?.credentialId;
    if (!credentialId) return;
    await tx
      .update(jenovaBrandTrackingSessions)
      .set({
        status: "archived",
        archivedReason: "credential_revoked",
        archivedAt: now,
        updatedAt: now,
      })
      .where(
        and(
          eq(jenovaBrandTrackingSessions.userId, input.userId),
          eq(jenovaBrandTrackingSessions.status, "active"),
        ),
      );
    await tx
      .delete(jenovaBrandTrackingAssignments)
      .where(eq(jenovaBrandTrackingAssignments.userId, input.userId));
    const remaining = await tx
      .select({ userId: jenovaBrandTrackingAssignments.userId })
      .from(jenovaBrandTrackingAssignments)
      .where(eq(jenovaBrandTrackingAssignments.credentialId, credentialId))
      .limit(1)
      .for("update");
    if (!remaining[0]) {
      await tx
        .update(jenovaBrandTrackingCredentials)
        .set({ status: "revoked", revokedAt: now, updatedAt: now })
        .where(eq(jenovaBrandTrackingCredentials.id, credentialId));
    }
  });
  return { users: await listCredentialRows(db, now, [input.userId]) };
}

export async function syncJenovaBrandTrackingCredentialBalance(input: {
  actor: AuthenticatedUser;
  credentialId: string;
  dependencies?: JenovaBrandTrackingDependencies;
}) {
  assertJenovaBrandTrackingSystemAdmin(input.actor);
  const resolved = deps(input.dependencies);
  const db = await requireDatabase(resolved.getDatabase);
  const rows = await db
    .select()
    .from(jenovaBrandTrackingCredentials)
    .where(
      and(
        eq(jenovaBrandTrackingCredentials.id, input.credentialId),
        eq(jenovaBrandTrackingCredentials.status, "active"),
      ),
    )
    .limit(1);
  const credential = rows[0];
  if (!credential) {
    throw new JenovaBrandTrackingError("NOT_FOUND", "Jenova Key 不存在", 404);
  }
  let balance: string;
  try {
    balance = await resolved.client.getBalance(decryptJenovaKey(credential));
  } catch (error) {
    throw mapClientError(error);
  }
  const now = resolved.now();
  await db
    .update(jenovaBrandTrackingCredentials)
    .set({ lastBalance: balance, balanceSyncedAt: now, updatedAt: now })
    .where(eq(jenovaBrandTrackingCredentials.id, credential.id));
  const assignmentRows = await db
    .select({ userId: jenovaBrandTrackingAssignments.userId })
    .from(jenovaBrandTrackingAssignments)
    .where(eq(jenovaBrandTrackingAssignments.credentialId, credential.id));
  const affectedIds = assignmentRows.map((row: any) => row.userId);
  return {
    credentialId: credential.id,
    balance,
    balanceSyncedAt: now.toISOString(),
    users: affectedIds.length
      ? await listCredentialRows(db, now, affectedIds)
      : [],
  };
}

function mapClientError(error: unknown) {
  if (error instanceof JenovaBrandTrackingError) return error;
  if (error instanceof z.ZodError) {
    return new JenovaBrandTrackingError(
      "INVALID_INPUT",
      "品牌追踪请求参数无效",
      400,
    );
  }
  if (error instanceof JenovaClientError) {
    if (error.code === "INVALID_KEY" || error.code === "AGENT_UNAVAILABLE") {
      return new JenovaBrandTrackingError(
        "INVALID_INPUT",
        error.message,
        error.statusCode === 401 || error.statusCode === 403
          ? 422
          : error.statusCode,
      );
    }
    return new JenovaBrandTrackingError(
      "UPSTREAM_UNAVAILABLE",
      error.message,
      error.statusCode >= 500 ? 503 : 502,
    );
  }
  return new JenovaBrandTrackingError(
    "UPSTREAM_UNAVAILABLE",
    "品牌追踪服务暂时不可用",
    503,
  );
}

type LimitAuthority = {
  customerUserId: number;
  engineerUserId: number | null;
  roleType:
    | "ai_operations_engineer"
    | "monitoring_optimization_engineer"
    | "content_distribution_engineer";
  customerRole: "user" | "admin" | "delivery_member";
  customerMarketEdition: "domestic" | "overseas";
  customerIsActive: boolean;
};

export function assertCanManageJenovaBrandTrackingLimit(input: {
  actor: AuthenticatedUser;
  authority: LimitAuthority;
}) {
  const systemAdmin = hasSystemAdminAccess(input.actor);
  const assignedAiOperationsEngineer =
    input.actor.isActive &&
    input.actor.role === "delivery_member" &&
    input.actor.engineerRoleType === "ai_operations_engineer" &&
    input.authority.roleType === "ai_operations_engineer" &&
    input.authority.engineerUserId === input.actor.id;
  if (!systemAdmin && !assignedAiOperationsEngineer) {
    throw new JenovaBrandTrackingError(
      "FORBIDDEN",
      "只有负责当前客户的 AI 运营工程师或系统管理员可以调整品牌追踪积分上限",
      403,
    );
  }
  if (
    input.authority.customerRole !== "user" ||
    input.authority.customerMarketEdition !== "overseas" ||
    !input.authority.customerIsActive
  ) {
    throw new JenovaBrandTrackingError(
      "INELIGIBLE",
      "目标客户不是有效的海外版用户",
      403,
    );
  }
}

async function loadProjectAuthority(
  executor: any,
  projectAssignmentId: string,
  lock = false,
) {
  let query = executor
    .select({
      customerUserId: deliveryProjectAssignments.customerUserId,
      engineerUserId: deliveryProjectAssignments.engineerUserId,
      roleType: deliveryProjectAssignments.roleType,
      customerRole: users.role,
      customerMarketEdition: users.marketEdition,
      customerIsActive: users.isActive,
    })
    .from(deliveryProjectAssignments)
    .innerJoin(users, eq(deliveryProjectAssignments.customerUserId, users.id))
    .where(eq(deliveryProjectAssignments.id, projectAssignmentId))
    .limit(1);
  if (lock) query = query.for("update");
  const rows = await query;
  if (!rows[0]) {
    throw new JenovaBrandTrackingError("NOT_FOUND", "客户项目分配不存在", 404);
  }
  return rows[0] as LimitAuthority;
}

export async function getJenovaBrandTrackingUsageForProject(input: {
  actor: AuthenticatedUser;
  projectAssignmentId: string;
  dependencies?: JenovaBrandTrackingDependencies;
}) {
  if (!input.actor.isActive) {
    throw new JenovaBrandTrackingError("FORBIDDEN", "账号已停用", 403);
  }
  const resolved = deps(input.dependencies);
  const db = await requireDatabase(resolved.getDatabase);
  const authority = await loadProjectAuthority(db, input.projectAssignmentId);
  assertCanManageJenovaBrandTrackingLimit({ actor: input.actor, authority });
  const usage = buildJenovaBrandTrackingUsageDto(
    await loadUsageNumbers(db, authority.customerUserId, resolved.now()),
    true,
  );
  return { customerUserId: authority.customerUserId, usage };
}

export async function updateJenovaBrandTrackingLimit(input: {
  actor: AuthenticatedUser;
  projectAssignmentId: string;
  limit: string;
  dependencies?: JenovaBrandTrackingDependencies;
}) {
  if (!input.actor.isActive) {
    throw new JenovaBrandTrackingError("FORBIDDEN", "账号已停用", 403);
  }
  let limit: string;
  try {
    limit = limitSchema.parse(input.limit);
  } catch (error) {
    throw mapClientError(error);
  }
  const resolved = deps(input.dependencies);
  const db = await requireDatabase(resolved.getDatabase);
  let customerUserId = 0;
  const now = resolved.now();
  await db.transaction(async (tx: any) => {
    const authority = await loadProjectAuthority(
      tx,
      input.projectAssignmentId,
      true,
    );
    assertCanManageJenovaBrandTrackingLimit({ actor: input.actor, authority });
    customerUserId = authority.customerUserId;
    await tx
      .insert(jenovaBrandTrackingPolicies)
      .values({
        userId: customerUserId,
        rolling30DayLimit: limit,
        updatedByUserId: input.actor.id,
        createdAt: now,
        updatedAt: now,
      })
      .onDuplicateKeyUpdate({
        set: {
          rolling30DayLimit: limit,
          updatedByUserId: input.actor.id,
          updatedAt: now,
        },
      });
  });
  const usage = buildJenovaBrandTrackingUsageDto(
    await loadUsageNumbers(db, customerUserId, now),
    true,
  );
  return { customerUserId, usage };
}

type ReservedTurn = {
  session: JenovaBrandTrackingSession;
  turn: JenovaBrandTrackingTurn;
  credential: JenovaBrandTrackingCredential;
  replayed: boolean;
};

function assertSpendAllowed(
  numbers: Awaited<ReturnType<typeof loadUsageNumbers>>,
) {
  if (!numbers.keyConfigured) {
    throw new JenovaBrandTrackingError(
      "KEY_REQUIRED",
      "系统管理员尚未配置品牌追踪 Key",
      428,
    );
  }
  if (numbers.pendingReconciliationCount > 0) {
    throw new JenovaBrandTrackingError(
      "USAGE_UNKNOWN",
      "上一轮积分仍在核对，暂时不能发送新消息",
      503,
    );
  }
  if (isAtLeast(numbers.rolling30DayCost, numbers.limit)) {
    throw new JenovaBrandTrackingError(
      "LIMIT_EXCEEDED",
      "最近 30 天品牌追踪积分已达到上限",
      429,
    );
  }
}

async function loadLockedEligibleUser(executor: any, actor: AuthenticatedUser) {
  const rows = await executor
    .select({
      id: users.id,
      role: users.role,
      isActive: users.isActive,
      marketEdition: users.marketEdition,
    })
    .from(users)
    .where(eq(users.id, actor.id))
    .limit(1)
    .for("update");
  const user = rows[0];
  if (
    !user ||
    user.role !== "user" ||
    !user.isActive ||
    user.marketEdition !== "overseas"
  ) {
    throw new JenovaBrandTrackingError(
      "INELIGIBLE",
      "品牌追踪仅向有效的海外版用户开放",
      403,
    );
  }
}

async function loadAssignedCredential(executor: any, userId: number) {
  const rows = await executor
    .select({ credential: jenovaBrandTrackingCredentials })
    .from(jenovaBrandTrackingAssignments)
    .innerJoin(
      jenovaBrandTrackingCredentials,
      eq(
        jenovaBrandTrackingAssignments.credentialId,
        jenovaBrandTrackingCredentials.id,
      ),
    )
    .where(
      and(
        eq(jenovaBrandTrackingAssignments.userId, userId),
        eq(jenovaBrandTrackingCredentials.status, "active"),
        eq(jenovaBrandTrackingCredentials.validationStatus, "verified"),
      ),
    )
    .limit(1)
    .for("update");
  const credential = rows[0]?.credential as
    | JenovaBrandTrackingCredential
    | undefined;
  if (!credential) {
    throw new JenovaBrandTrackingError(
      "KEY_REQUIRED",
      "系统管理员尚未配置品牌追踪 Key",
      428,
    );
  }
  return credential;
}

async function loadReplay(
  executor: any,
  userId: number,
  clientRequestId: string,
  expected: { sessionId?: string; content?: string; hiddenKickoff: boolean },
): Promise<ReservedTurn | null> {
  const rows = await executor
    .select({
      turn: jenovaBrandTrackingTurns,
      session: jenovaBrandTrackingSessions,
      credential: jenovaBrandTrackingCredentials,
    })
    .from(jenovaBrandTrackingTurns)
    .innerJoin(
      jenovaBrandTrackingSessions,
      eq(jenovaBrandTrackingTurns.sessionId, jenovaBrandTrackingSessions.id),
    )
    .innerJoin(
      jenovaBrandTrackingCredentials,
      eq(
        jenovaBrandTrackingTurns.credentialId,
        jenovaBrandTrackingCredentials.id,
      ),
    )
    .where(
      and(
        eq(jenovaBrandTrackingTurns.userId, userId),
        eq(jenovaBrandTrackingTurns.clientRequestId, clientRequestId),
      ),
    )
    .limit(1)
    .for("update");
  const row = rows[0];
  if (!row) return null;
  if (
    (expected.content !== undefined &&
      row.turn.userContent !== expected.content) ||
    row.turn.hiddenKickoff !== expected.hiddenKickoff ||
    (expected.sessionId && row.session.id !== expected.sessionId)
  ) {
    throw new JenovaBrandTrackingError(
      "IDEMPOTENCY_CONFLICT",
      "clientRequestId 已用于另一条品牌追踪消息",
      409,
    );
  }
  if (row.turn.status === "pending" || row.turn.status === "streaming") {
    throw new JenovaBrandTrackingError(
      "IDEMPOTENCY_PENDING",
      "相同请求仍在运行，请稍后刷新会话",
      409,
      1_000,
    );
  }
  return { ...row, replayed: true } as ReservedTurn;
}

async function loadExistingNewSessionReplay(input: {
  actor: AuthenticatedUser;
  clientRequestId: string;
  dependencies: ReturnType<typeof deps>;
}) {
  const db = await requireDatabase(input.dependencies.getDatabase);
  return db.transaction(async (tx: any) => {
    await loadLockedEligibleUser(tx, input.actor);
    return loadReplay(tx, input.actor.id, input.clientRequestId, {
      hiddenKickoff: true,
    });
  });
}

async function reserveNewSession(input: {
  actor: AuthenticatedUser;
  clientRequestId: string;
  kickoff: string;
  dependencies: ReturnType<typeof deps>;
}): Promise<ReservedTurn> {
  const db = await requireDatabase(input.dependencies.getDatabase);
  const now = input.dependencies.now();
  return db.transaction(async (tx: any) => {
    await loadLockedEligibleUser(tx, input.actor);
    const replay = await loadReplay(tx, input.actor.id, input.clientRequestId, {
      hiddenKickoff: true,
    });
    if (replay) return replay;
    const credential = await loadAssignedCredential(tx, input.actor.id);
    assertSpendAllowed(await loadUsageNumbers(tx, input.actor.id, now));

    await tx
      .update(jenovaBrandTrackingSessions)
      .set({
        status: "archived",
        archivedReason: "new_tracking",
        archivedAt: now,
        updatedAt: now,
      })
      .where(
        and(
          eq(jenovaBrandTrackingSessions.userId, input.actor.id),
          eq(jenovaBrandTrackingSessions.status, "active"),
        ),
      );
    const sessionId = input.dependencies.randomId();
    const turnId = input.dependencies.randomId();
    const idempotencyKey = `brand-tracking:${input.actor.id}:${input.clientRequestId}`;
    const session = {
      id: sessionId,
      userId: input.actor.id,
      credentialId: credential.id,
      clientRequestId: input.clientRequestId,
      upstreamSessionId: null,
      title: "品牌追踪会话",
      status: "active" as const,
      archivedReason: null,
      archivedAt: null,
      createdAt: now,
      updatedAt: now,
    };
    const turn = {
      id: turnId,
      sessionId,
      userId: input.actor.id,
      credentialId: credential.id,
      clientRequestId: input.clientRequestId,
      idempotencyKey,
      upstreamRunId: null,
      hiddenKickoff: true,
      userContent: input.kickoff,
      assistantContent: "",
      status: "pending" as const,
      costState: "pending" as const,
      usageCost: null,
      sessionFee: ZERO,
      progress: null,
      warnings: null,
      stopReason: null,
      errorCode: null,
      errorMessage: null,
      startedAt: null,
      completedAt: null,
      createdAt: now,
      updatedAt: now,
    };
    await tx.insert(jenovaBrandTrackingSessions).values(session);
    await tx.insert(jenovaBrandTrackingTurns).values(turn);
    return { session, turn, credential, replayed: false } as ReservedTurn;
  });
}

async function reserveMessage(input: {
  actor: AuthenticatedUser;
  sessionId: string;
  clientRequestId: string;
  content: string;
  dependencies: ReturnType<typeof deps>;
}): Promise<ReservedTurn> {
  const db = await requireDatabase(input.dependencies.getDatabase);
  const now = input.dependencies.now();
  return db.transaction(async (tx: any) => {
    await loadLockedEligibleUser(tx, input.actor);
    const replay = await loadReplay(tx, input.actor.id, input.clientRequestId, {
      sessionId: input.sessionId,
      content: input.content,
      hiddenKickoff: false,
    });
    if (replay) return replay;
    const credential = await loadAssignedCredential(tx, input.actor.id);
    assertSpendAllowed(await loadUsageNumbers(tx, input.actor.id, now));
    const sessionRows = await tx
      .select()
      .from(jenovaBrandTrackingSessions)
      .where(
        and(
          eq(jenovaBrandTrackingSessions.id, input.sessionId),
          eq(jenovaBrandTrackingSessions.userId, input.actor.id),
        ),
      )
      .limit(1)
      .for("update");
    const session = sessionRows[0] as JenovaBrandTrackingSession | undefined;
    if (!session) {
      throw new JenovaBrandTrackingError(
        "NOT_FOUND",
        "品牌追踪会话不存在",
        404,
      );
    }
    if (session.status !== "active") {
      throw new JenovaBrandTrackingError(
        "IDEMPOTENCY_CONFLICT",
        "已归档会话不能继续发送消息",
        409,
      );
    }
    if (!session.upstreamSessionId || session.credentialId !== credential.id) {
      throw new JenovaBrandTrackingError(
        "IDEMPOTENCY_CONFLICT",
        "会话凭据已更换，请新建品牌追踪",
        409,
      );
    }
    const turnId = input.dependencies.randomId();
    const turn = {
      id: turnId,
      sessionId: session.id,
      userId: input.actor.id,
      credentialId: credential.id,
      clientRequestId: input.clientRequestId,
      idempotencyKey: `brand-tracking:${input.actor.id}:${input.clientRequestId}`,
      upstreamRunId: null,
      hiddenKickoff: false,
      userContent: input.content,
      assistantContent: "",
      status: "pending" as const,
      costState: "pending" as const,
      usageCost: null,
      sessionFee: ZERO,
      progress: null,
      warnings: null,
      stopReason: null,
      errorCode: null,
      errorMessage: null,
      startedAt: null,
      completedAt: null,
      createdAt: now,
      updatedAt: now,
    };
    await tx.insert(jenovaBrandTrackingTurns).values(turn);
    await tx
      .update(jenovaBrandTrackingSessions)
      .set({ updatedAt: now })
      .where(eq(jenovaBrandTrackingSessions.id, session.id));
    return {
      session: { ...session, updatedAt: now },
      turn,
      credential,
      replayed: false,
    } as ReservedTurn;
  });
}

function assistantMessageId(turnId: string) {
  return `${turnId}:assistant`;
}

async function replayReservedTurn(
  reservation: ReservedTurn,
  emit: (event: BrandTrackingSseEvent) => void | Promise<void>,
) {
  const messageId = assistantMessageId(reservation.turn.id);
  await emit({
    event: "session",
    data: {
      sessionId: reservation.session.id,
      title: reservation.session.title,
      status: reservation.session.status,
      messageId,
    },
  });
  if (reservation.turn.assistantContent) {
    await emit({
      event: "delta",
      data: {
        messageId,
        text: reservation.turn.assistantContent,
        content: reservation.turn.assistantContent,
      },
    });
  }
  if (reservation.turn.costState === "confirmed") {
    const cost = turnTotalCost(reservation.turn);
    await emit({
      event: "usage",
      data: {
        messageId,
        cost,
        usageCost: reservation.turn.usageCost ?? ZERO,
        sessionFee: reservation.turn.sessionFee,
        totalCost: cost,
      },
    });
  }
  const status =
    reservation.turn.status === "recovering"
      ? "pending_reconciliation"
      : reservation.turn.status === "failed"
        ? "failed"
        : "completed";
  await emit({
    event: "end",
    data: { sessionId: reservation.session.id, messageId, status },
  });
}

async function persistUpstreamIdentity(input: {
  db: any;
  reservation: ReservedTurn;
  sessionId: string | null;
  runId: string | null;
  now: Date;
}) {
  const needsSession =
    Boolean(input.sessionId) &&
    input.reservation.session.upstreamSessionId !== input.sessionId;
  const needsRun =
    Boolean(input.runId) &&
    input.reservation.turn.upstreamRunId !== input.runId;
  const needsSessionFee =
    input.reservation.turn.hiddenKickoff &&
    Boolean(input.sessionId) &&
    input.reservation.turn.sessionFee !== JENOVA_SESSION_CREATION_FEE;
  if (!needsSession && !needsRun && !needsSessionFee) return;
  await input.db.transaction(async (tx: any) => {
    if (needsSession) {
      await tx
        .update(jenovaBrandTrackingSessions)
        .set({ upstreamSessionId: input.sessionId, updatedAt: input.now })
        .where(
          eq(jenovaBrandTrackingSessions.id, input.reservation.session.id),
        );
    }
    const changes: Record<string, unknown> = { updatedAt: input.now };
    if (needsRun) changes.upstreamRunId = input.runId;
    if (needsSessionFee) {
      changes.sessionFee = JENOVA_SESSION_CREATION_FEE;
    }
    await tx
      .update(jenovaBrandTrackingTurns)
      .set(changes)
      .where(eq(jenovaBrandTrackingTurns.id, input.reservation.turn.id));
  });
  if (input.sessionId) {
    input.reservation.session.upstreamSessionId = input.sessionId;
  }
  if (input.runId) input.reservation.turn.upstreamRunId = input.runId;
  if (input.reservation.turn.hiddenKickoff && input.sessionId) {
    input.reservation.turn.sessionFee = JENOVA_SESSION_CREATION_FEE;
  }
}

export function classifyJenovaTurnCompletion(input: {
  success: boolean | null;
  usageCost: string | null;
  hasStreamError: boolean;
}) {
  const usageKnown = input.usageCost !== null;
  return {
    usageKnown,
    status: usageKnown
      ? input.success === false || input.hasStreamError
        ? ("failed" as const)
        : ("completed" as const)
      : ("recovering" as const),
    costState: usageKnown ? ("confirmed" as const) : ("unknown" as const),
  };
}

export function isKnownJenovaPreRunRejection(input: {
  error: unknown;
  sawUpstreamEvent: boolean;
  upstreamRunId: string | null;
}) {
  return (
    input.error instanceof JenovaClientError &&
    (input.error.code === "UPSTREAM_REJECTED" ||
      input.error.code === "INVALID_KEY") &&
    input.error.statusCode >= 400 &&
    input.error.statusCode < 500 &&
    input.error.statusCode !== 409 &&
    !input.sawUpstreamEvent &&
    !input.upstreamRunId
  );
}

export function jenovaRejectedUsageCost(error: unknown) {
  if (!(error instanceof JenovaClientError)) return null;
  const details = error.details;
  const nested = objectValue(details.error);
  const data = objectValue(details.data);
  const dataError = objectValue(data.error);
  const usage = objectValue(
    details.usage ?? nested.usage ?? data.usage ?? dataError.usage,
  );
  if (usage.cost === undefined || usage.cost === null) return null;
  try {
    return normalizeJenovaDecimal(usage.cost);
  } catch {
    return null;
  }
}

export function jenovaErrorIdentity(error: unknown) {
  if (!(error instanceof JenovaClientError)) {
    return { sessionId: null, runId: null };
  }
  const details = error.details;
  const nested = objectValue(details.error);
  const data = objectValue(details.data);
  const dataError = objectValue(data.error);
  const idempotency = objectValue(details.idempotency);
  const nestedIdempotency = objectValue(nested.idempotency);
  const dataIdempotency = objectValue(data.idempotency);
  const dataErrorIdempotency = objectValue(dataError.idempotency);
  return {
    sessionId: stringValue(
      details.session_id ??
        nested.session_id ??
        data.session_id ??
        dataError.session_id ??
        idempotency.session_id ??
        nestedIdempotency.session_id ??
        dataIdempotency.session_id ??
        dataErrorIdempotency.session_id,
    ),
    runId: stringValue(
      details.run_id ??
        nested.run_id ??
        data.run_id ??
        dataError.run_id ??
        idempotency.run_id ??
        nestedIdempotency.run_id ??
        dataIdempotency.run_id ??
        dataErrorIdempotency.run_id,
    ),
  };
}

async function streamReservedTurn(input: {
  actor: Pick<AuthenticatedUser, "id">;
  reservation: ReservedTurn;
  emit: (event: BrandTrackingSseEvent) => void | Promise<void>;
  dependencies: ReturnType<typeof deps>;
}) {
  if (input.reservation.replayed) {
    await replayReservedTurn(input.reservation, input.emit);
    return input.reservation;
  }
  const db = await requireDatabase(input.dependencies.getDatabase);
  const messageId = assistantMessageId(input.reservation.turn.id);
  await input.emit({
    event: "session",
    data: {
      sessionId: input.reservation.session.id,
      title: input.reservation.session.title,
      status: input.reservation.session.status,
      messageId,
    },
  });
  const startedAt = input.dependencies.now();
  await db
    .update(jenovaBrandTrackingTurns)
    .set({ status: "streaming", startedAt, updatedAt: startedAt })
    .where(eq(jenovaBrandTrackingTurns.id, input.reservation.turn.id));
  input.reservation.turn.status = "streaming";
  input.reservation.turn.startedAt = startedAt;

  let sawUpstreamEvent = false;
  let streamEnded = false;
  const streamFailure: {
    current: {
      code: string;
      message: string;
      usageCost: string | null;
    } | null;
  } = { current: null };
  const progress: Record<string, unknown>[] = [];
  const warnings: Record<string, unknown>[] = [];
  try {
    await input.dependencies.client.streamMessage({
      apiKey: decryptJenovaKey(input.reservation.credential),
      userId: `frontmind-user-${input.actor.id}`,
      content: input.reservation.turn.userContent,
      idempotencyKey: input.reservation.turn.idempotencyKey,
      sessionId: input.reservation.turn.hiddenKickoff
        ? undefined
        : input.reservation.session.upstreamSessionId,
      sessionName: input.reservation.session.title,
      onEvent: async (event: JenovaStreamEvent) => {
        sawUpstreamEvent = true;
        const eventNow = input.dependencies.now();
        await persistUpstreamIdentity({
          db,
          reservation: input.reservation,
          sessionId: event.sessionId,
          runId: event.runId,
          now: eventNow,
        });
        if (event.type === "started" || event.type === "message_completed") {
          return;
        }
        if (event.type === "delta") {
          const publicText = toBrandTrackingPublicText(event.text);
          input.reservation.turn.assistantContent += publicText;
          await db
            .update(jenovaBrandTrackingTurns)
            .set({
              assistantContent: sql`CONCAT(COALESCE(${jenovaBrandTrackingTurns.assistantContent}, ''), ${publicText})`,
              updatedAt: eventNow,
            })
            .where(eq(jenovaBrandTrackingTurns.id, input.reservation.turn.id));
          if (publicText) {
            await input.emit({
              event: "delta",
              data: { messageId, text: publicText, content: publicText },
            });
          }
          return;
        }
        if (event.type === "progress") {
          const publicMessage = toBrandTrackingPublicText(event.message);
          const publicProgress: Record<string, unknown> = {
            ...toBrandTrackingPublicRecord(event.raw),
            message: publicMessage,
          };
          progress.push(publicProgress);
          if (progress.length > 100) progress.shift();
          await db
            .update(jenovaBrandTrackingTurns)
            .set({ progress, updatedAt: eventNow })
            .where(eq(jenovaBrandTrackingTurns.id, input.reservation.turn.id));
          await input.emit({
            event: "progress",
            data: {
              messageId,
              message: publicMessage,
              ...(typeof publicProgress.label === "string"
                ? { label: publicProgress.label }
                : {}),
              ...(typeof publicProgress.detail === "string"
                ? { detail: publicProgress.detail }
                : {}),
            },
          });
          return;
        }
        if (event.type === "warning") {
          const publicCode = toBrandTrackingPublicCode(event.code, null);
          const publicMessage = toBrandTrackingPublicText(event.message);
          warnings.push({
            ...toBrandTrackingPublicRecord(event.raw),
            code: publicCode,
            message: publicMessage,
          });
          if (warnings.length > 100) warnings.shift();
          await db
            .update(jenovaBrandTrackingTurns)
            .set({ warnings, updatedAt: eventNow })
            .where(eq(jenovaBrandTrackingTurns.id, input.reservation.turn.id));
          await input.emit({
            event: "warning",
            data: {
              messageId,
              code: publicCode,
              message: publicMessage,
            },
          });
          return;
        }
        if (event.type === "error") {
          const publicCode =
            toBrandTrackingPublicCode(event.code, "UPSTREAM_UNAVAILABLE") ??
            "UPSTREAM_UNAVAILABLE";
          const publicMessage = toBrandTrackingPublicText(event.message);
          streamFailure.current = {
            code: publicCode,
            message: publicMessage,
            usageCost: event.usageCost,
          };
          await db
            .update(jenovaBrandTrackingTurns)
            .set({
              errorCode: publicCode,
              errorMessage: publicMessage,
              ...(event.usageCost
                ? {
                    usageCost: event.usageCost,
                    costState: "confirmed" as const,
                  }
                : {}),
              updatedAt: eventNow,
            })
            .where(eq(jenovaBrandTrackingTurns.id, input.reservation.turn.id));
          await input.emit({
            event: "error",
            data: {
              code: publicCode,
              message: publicMessage,
              recoverable: true,
            },
          });
          return;
        }

        streamEnded = true;
        const finalUsageCost =
          event.usageCost ?? streamFailure.current?.usageCost ?? null;
        const { usageKnown, status, costState } = classifyJenovaTurnCompletion({
          success: event.success,
          usageCost: finalUsageCost,
          hasStreamError: Boolean(streamFailure.current),
        });
        const completedAt = eventNow;
        const publicStopReason = event.stopReason
          ? toBrandTrackingPublicText(event.stopReason)
          : null;
        await db
          .update(jenovaBrandTrackingTurns)
          .set({
            status,
            costState,
            usageCost: finalUsageCost,
            stopReason: publicStopReason,
            errorCode: streamFailure.current?.code ?? null,
            errorMessage: streamFailure.current?.message ?? null,
            completedAt,
            updatedAt: completedAt,
          })
          .where(eq(jenovaBrandTrackingTurns.id, input.reservation.turn.id));
        input.reservation.turn = {
          ...input.reservation.turn,
          status,
          costState,
          usageCost: finalUsageCost,
          stopReason: publicStopReason,
          completedAt,
          updatedAt: completedAt,
        };
        if (usageKnown) {
          const totalCost = addJenovaMoney(
            finalUsageCost,
            input.reservation.turn.sessionFee,
          );
          await input.emit({
            event: "usage",
            data: {
              messageId,
              cost: totalCost,
              usageCost: finalUsageCost!,
              sessionFee: input.reservation.turn.sessionFee,
              totalCost,
            },
          });
        }
        await input.emit({
          event: "end",
          data: {
            sessionId: input.reservation.session.id,
            messageId,
            status:
              status === "recovering"
                ? "pending_reconciliation"
                : status === "failed"
                  ? "failed"
                  : "completed",
          },
        });
      },
    });
  } catch (error) {
    if (streamEnded) return input.reservation;
    const errorIdentity = jenovaErrorIdentity(error);
    if (errorIdentity.sessionId || errorIdentity.runId) {
      await persistUpstreamIdentity({
        db,
        reservation: input.reservation,
        sessionId: errorIdentity.sessionId,
        runId: errorIdentity.runId,
        now: input.dependencies.now(),
      });
    }
    if (error instanceof JenovaClientError && error.statusCode === 409) {
      const recovered = await reconcileReservedTurn(
        db,
        input.reservation,
        input.dependencies.client,
        input.dependencies.now(),
      );
      if (recovered) {
        input.reservation.turn = recovered;
        await replayReservedTurn(
          { ...input.reservation, turn: recovered, replayed: true },
          input.emit,
        );
        return input.reservation;
      }
    }

    const knownRejectedBeforeRun = isKnownJenovaPreRunRejection({
      error,
      sawUpstreamEvent,
      upstreamRunId: input.reservation.turn.upstreamRunId,
    });
    const failedAt = input.dependencies.now();
    const rejectedUsageCost =
      jenovaRejectedUsageCost(error) ??
      streamFailure.current?.usageCost ??
      null;
    const definiteFailed = knownRejectedBeforeRun || rejectedUsageCost !== null;
    const status = definiteFailed ? "failed" : "recovering";
    const costState = definiteFailed ? "confirmed" : "unknown";
    const serviceError = mapClientError(error);
    const publicErrorCode =
      toBrandTrackingPublicCode(
        error instanceof JenovaClientError ? error.code : serviceError.code,
        "UPSTREAM_UNAVAILABLE",
      ) ?? "UPSTREAM_UNAVAILABLE";
    const publicErrorMessage = toBrandTrackingPublicText(serviceError.message);
    await db
      .update(jenovaBrandTrackingTurns)
      .set({
        status,
        costState,
        usageCost: definiteFailed ? (rejectedUsageCost ?? ZERO) : null,
        errorCode: publicErrorCode,
        errorMessage: publicErrorMessage,
        completedAt: definiteFailed ? failedAt : null,
        updatedAt: failedAt,
      })
      .where(eq(jenovaBrandTrackingTurns.id, input.reservation.turn.id));
    input.reservation.turn = {
      ...input.reservation.turn,
      status,
      costState,
      usageCost: definiteFailed ? (rejectedUsageCost ?? ZERO) : null,
      errorCode: publicErrorCode,
      errorMessage: publicErrorMessage,
      completedAt: definiteFailed ? failedAt : null,
      updatedAt: failedAt,
    };
    await input.emit({
      event: "error",
      data: {
        code: publicErrorCode,
        message: publicErrorMessage,
        recoverable: !definiteFailed,
      },
    });
    if (definiteFailed) {
      const usageCost = rejectedUsageCost ?? ZERO;
      const totalCost = addJenovaMoney(
        usageCost,
        input.reservation.turn.sessionFee,
      );
      await input.emit({
        event: "usage",
        data: {
          messageId,
          cost: totalCost,
          usageCost,
          sessionFee: input.reservation.turn.sessionFee,
          totalCost,
        },
      });
    }
    await input.emit({
      event: "end",
      data: {
        sessionId: input.reservation.session.id,
        messageId,
        status: definiteFailed ? "failed" : "pending_reconciliation",
      },
    });
    if (!definiteFailed) {
      queueJenovaTurnReconciliation(input.reservation, input.dependencies);
    }
  }
  return input.reservation;
}

export async function startJenovaBrandTrackingSession(input: {
  actor: AuthenticatedUser;
  clientRequestId: string;
  emit: (event: BrandTrackingSseEvent) => void | Promise<void>;
  dependencies?: JenovaBrandTrackingDependencies;
}) {
  assertEligibleActor(input.actor);
  const emit = brandTrackingPublicEmitter(input.emit);
  let clientRequestId: string;
  try {
    clientRequestId = clientRequestSchema.parse(input.clientRequestId);
  } catch (error) {
    throw mapClientError(error);
  }
  const resolved = deps(input.dependencies);
  const replay = await loadExistingNewSessionReplay({
    actor: input.actor,
    clientRequestId,
    dependencies: resolved,
  });
  if (replay) {
    return streamReservedTurn({
      actor: input.actor,
      reservation: replay,
      emit,
      dependencies: resolved,
    });
  }
  let kickoff: string;
  try {
    const workspace = await resolved.getDashboardWorkspace(input.actor.id);
    kickoff = buildJenovaBrandTrackingKickoff(workspace.payload.brandName);
  } catch (error) {
    if (error instanceof JenovaBrandTrackingError) throw error;
    if (error instanceof AuthServiceError) {
      throw new JenovaBrandTrackingError(
        error.code === "DATABASE_UNAVAILABLE"
          ? "DATABASE_UNAVAILABLE"
          : "UPSTREAM_UNAVAILABLE",
        "暂时无法读取看板品牌信息",
        503,
      );
    }
    throw new JenovaBrandTrackingError(
      "UPSTREAM_UNAVAILABLE",
      "暂时无法读取看板品牌信息",
      503,
    );
  }
  const reservation = await reserveNewSession({
    actor: input.actor,
    clientRequestId,
    kickoff,
    dependencies: resolved,
  });
  return streamReservedTurn({
    actor: input.actor,
    reservation,
    emit,
    dependencies: resolved,
  });
}

export async function sendJenovaBrandTrackingMessage(input: {
  actor: AuthenticatedUser;
  sessionId: string;
  content: string;
  clientRequestId: string;
  emit: (event: BrandTrackingSseEvent) => void | Promise<void>;
  dependencies?: JenovaBrandTrackingDependencies;
}) {
  assertEligibleActor(input.actor);
  const emit = brandTrackingPublicEmitter(input.emit);
  let clientRequestId: string;
  let content: string;
  try {
    clientRequestId = clientRequestSchema.parse(input.clientRequestId);
    content = messageSchema.parse(input.content);
  } catch (error) {
    throw mapClientError(error);
  }
  const resolved = deps(input.dependencies);
  const reservation = await reserveMessage({
    actor: input.actor,
    sessionId: input.sessionId,
    clientRequestId,
    content,
    dependencies: resolved,
  });
  return streamReservedTurn({
    actor: input.actor,
    reservation,
    emit,
    dependencies: resolved,
  });
}

function objectValue(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value ? value : null;
}

function runPayload(value: Record<string, unknown>) {
  const data = objectValue(value.data);
  const run = objectValue(value.run);
  return Object.keys(run).length
    ? run
    : Object.keys(data).length
      ? objectValue(data.run ?? data)
      : value;
}

function recoveredUsageCost(value: Record<string, unknown>) {
  const payload = runPayload(value);
  const usage = objectValue(payload.usage);
  if (usage.cost === undefined || usage.cost === null) return null;
  try {
    return normalizeJenovaDecimal(usage.cost);
  } catch {
    return null;
  }
}

function recoveredContent(value: Record<string, unknown>) {
  const payload = runPayload(value);
  const message = objectValue(payload.message);
  const output = objectValue(payload.output);
  const contentValue = payload.content ?? message.content ?? output.content;
  const arrayContent = Array.isArray(contentValue)
    ? contentValue
        .map((item) => {
          if (typeof item === "string") return item;
          const part = objectValue(item);
          return stringValue(part.text ?? part.content) ?? "";
        })
        .join("")
    : null;
  return (
    stringValue(contentValue) ??
    arrayContent ??
    stringValue(payload.output_text) ??
    null
  );
}

function recoveredTerminalState(value: Record<string, unknown>) {
  const payload = runPayload(value);
  const status = stringValue(payload.status)?.toLowerCase() ?? null;
  const success =
    typeof payload.success === "boolean" ? payload.success : undefined;
  const terminal =
    recoveredUsageCost(value) !== null ||
    success !== undefined ||
    (status !== null &&
      ["completed", "failed", "cancelled", "canceled", "error"].includes(
        status,
      ));
  const failed =
    success === false ||
    (status !== null &&
      ["failed", "cancelled", "canceled", "error"].includes(status));
  return {
    terminal,
    failed,
    stopReason: stringValue(payload.stop_reason),
    errorCode: stringValue(objectValue(payload.error).code),
    errorMessage: stringValue(objectValue(payload.error).message),
  };
}

function recoveredMessageTimestamp(message: Record<string, unknown>) {
  const raw =
    message.created_at ??
    message.createdAt ??
    message.time ??
    message.timestamp;
  if (typeof raw === "number" && Number.isFinite(raw)) {
    return raw < 1_000_000_000_000 ? raw * 1_000 : raw;
  }
  if (typeof raw === "string") {
    if (/^\d+(?:\.\d+)?$/.test(raw)) {
      const numeric = Number(raw);
      return numeric < 1_000_000_000_000 ? numeric * 1_000 : numeric;
    }
    const parsed = Date.parse(raw);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function isRecoveredAgentMessage(message: Record<string, unknown>) {
  const role = stringValue(message.role)?.toLowerCase();
  const senderType = stringValue(objectValue(message.from).type)?.toLowerCase();
  return role === "assistant" || senderType === "agent";
}

export function findRecoveredJenovaMessage(
  messages: Record<string, unknown>[],
  turn: Pick<
    JenovaBrandTrackingTurn,
    "upstreamRunId" | "startedAt" | "createdAt" | "userContent"
  >,
) {
  const matching = turn.upstreamRunId
    ? messages.find(
        (message) =>
          isRecoveredAgentMessage(message) &&
          (stringValue(message.run_id) === turn.upstreamRunId ||
            stringValue(objectValue(message.run).id) === turn.upstreamRunId),
      )
    : null;
  if (matching) return matching;
  const startedAt = toDate(turn.startedAt ?? turn.createdAt).getTime();
  const candidates = messages
    .map((message, originalIndex) => ({
      message,
      originalIndex,
      timestamp: recoveredMessageTimestamp(message),
    }))
    .filter(
      (item): item is typeof item & { timestamp: number } =>
        item.timestamp !== null && item.timestamp >= startedAt,
    )
    .sort(
      (left, right) =>
        left.timestamp - right.timestamp ||
        left.originalIndex - right.originalIndex,
    );
  const userIndex = candidates.findIndex(
    (item) =>
      !isRecoveredAgentMessage(item.message) &&
      recoveredContent(item.message)?.trim() === turn.userContent.trim(),
  );
  if (userIndex >= 0) {
    return candidates
      .slice(userIndex + 1)
      .find((item) => isRecoveredAgentMessage(item.message))?.message;
  }
  // Without a run/message id or the exact external prompt, a session-level
  // "latest agent message" is ambiguous and must remain unreconciled.
  return undefined;
}

async function reconcileReservedTurn(
  db: any,
  reservation: ReservedTurn,
  client: ServiceClient,
  now: Date,
): Promise<JenovaBrandTrackingTurn | null> {
  const upstreamSessionId = reservation.session.upstreamSessionId;
  if (!upstreamSessionId) return null;
  if (
    reservation.turn.hiddenKickoff &&
    reservation.turn.sessionFee !== JENOVA_SESSION_CREATION_FEE
  ) {
    await db
      .update(jenovaBrandTrackingTurns)
      .set({ sessionFee: JENOVA_SESSION_CREATION_FEE, updatedAt: now })
      .where(eq(jenovaBrandTrackingTurns.id, reservation.turn.id));
    reservation.turn.sessionFee = JENOVA_SESSION_CREATION_FEE;
  }
  const apiKey = decryptJenovaKey(reservation.credential);
  let record: Record<string, unknown> | null = null;
  if (reservation.turn.upstreamRunId) {
    try {
      record = await client.getSessionRun(
        apiKey,
        upstreamSessionId,
        reservation.turn.upstreamRunId,
        `frontmind-user-${reservation.turn.userId}`,
      );
    } catch (error) {
      if (!(error instanceof JenovaClientError) || error.statusCode !== 404) {
        return null;
      }
    }
  }
  if (!record) {
    try {
      const messages = await client.listSessionMessages(
        apiKey,
        upstreamSessionId,
        `frontmind-user-${reservation.turn.userId}`,
      );
      record = findRecoveredJenovaMessage(messages, reservation.turn) ?? null;
    } catch {
      return null;
    }
  }
  if (!record) return null;
  const terminal = recoveredTerminalState(record);
  const recovered = recoveredContent(record);
  const content = recovered ? toBrandTrackingPublicText(recovered) : null;
  if (!terminal.terminal) {
    if (content) {
      await db
        .update(jenovaBrandTrackingTurns)
        .set({
          assistantContent: content,
          costState: "unknown",
          status: "recovering",
          updatedAt: now,
        })
        .where(eq(jenovaBrandTrackingTurns.id, reservation.turn.id));
    }
    return null;
  }
  const usageCost = recoveredUsageCost(record);
  if (!usageCost) {
    await db
      .update(jenovaBrandTrackingTurns)
      .set({
        ...(content ? { assistantContent: content } : {}),
        costState: "unknown",
        status: "recovering",
        updatedAt: now,
      })
      .where(eq(jenovaBrandTrackingTurns.id, reservation.turn.id));
    return null;
  }
  const completedContent = toBrandTrackingPublicText(
    content ?? reservation.turn.assistantContent,
  );
  const status = terminal.failed ? "failed" : "completed";
  const publicStopReason = terminal.stopReason
    ? toBrandTrackingPublicText(terminal.stopReason)
    : null;
  const publicErrorCode = toBrandTrackingPublicCode(
    terminal.errorCode,
    terminal.errorCode ? "UPSTREAM_UNAVAILABLE" : null,
  );
  const publicErrorMessage = terminal.errorMessage
    ? toBrandTrackingPublicText(terminal.errorMessage)
    : null;
  await db
    .update(jenovaBrandTrackingTurns)
    .set({
      assistantContent: completedContent,
      status,
      costState: "confirmed",
      usageCost,
      stopReason: publicStopReason,
      errorCode: publicErrorCode,
      errorMessage: publicErrorMessage,
      completedAt: now,
      updatedAt: now,
    })
    .where(eq(jenovaBrandTrackingTurns.id, reservation.turn.id));
  return {
    ...reservation.turn,
    assistantContent: completedContent,
    status,
    costState: "confirmed",
    usageCost,
    stopReason: publicStopReason,
    errorCode: publicErrorCode,
    errorMessage: publicErrorMessage,
    completedAt: now,
    updatedAt: now,
  };
}

/**
 * Startup-safe reconciliation. Jenova cannot replay SSE, so accepted turns are
 * recovered through the persisted session/run identifiers and then the
 * session message list. Missing usage remains unknown and continues blocking
 * further spend; it is never coerced to zero.
 */
export async function recoverJenovaBrandTrackingTurns(
  dependencies: JenovaBrandTrackingDependencies = {},
  limit = 50,
) {
  const resolved = deps(dependencies);
  const db = await requireDatabase(resolved.getDatabase);
  const now = resolved.now();
  await revokeOrphanedJenovaBrandTrackingCredentials(db, now);
  const staleAt = new Date(now.getTime() - 2 * 60 * 1_000);
  const rows = await db
    .select({
      turn: jenovaBrandTrackingTurns,
      session: jenovaBrandTrackingSessions,
      credential: jenovaBrandTrackingCredentials,
    })
    .from(jenovaBrandTrackingTurns)
    .innerJoin(
      jenovaBrandTrackingSessions,
      eq(jenovaBrandTrackingTurns.sessionId, jenovaBrandTrackingSessions.id),
    )
    .innerJoin(
      jenovaBrandTrackingCredentials,
      eq(
        jenovaBrandTrackingTurns.credentialId,
        jenovaBrandTrackingCredentials.id,
      ),
    )
    .where(
      or(
        eq(jenovaBrandTrackingTurns.status, "recovering"),
        and(
          inArray(jenovaBrandTrackingTurns.status, ["pending", "streaming"]),
          lte(jenovaBrandTrackingTurns.updatedAt, staleAt),
        ),
      ),
    )
    .orderBy(asc(jenovaBrandTrackingTurns.updatedAt))
    .limit(Math.max(1, Math.min(limit, 500)));
  let completed = 0;
  let failed = 0;
  let unresolved = 0;
  for (const row of rows) {
    const reservation = { ...row, replayed: true } as ReservedTurn;
    if (
      row.turn.status === "pending" &&
      !row.session.upstreamSessionId &&
      !row.turn.upstreamRunId
    ) {
      await db
        .update(jenovaBrandTrackingTurns)
        .set({
          status: "failed",
          costState: "confirmed",
          usageCost: ZERO,
          errorCode: "dispatch_not_started",
          errorMessage: "服务重启前尚未发出请求",
          completedAt: now,
          updatedAt: now,
        })
        .where(eq(jenovaBrandTrackingTurns.id, row.turn.id));
      failed += 1;
      continue;
    }
    if (
      row.turn.costState === "confirmed" &&
      row.turn.usageCost !== null &&
      row.turn.errorCode &&
      row.turn.status !== "completed" &&
      row.turn.status !== "failed"
    ) {
      await db
        .update(jenovaBrandTrackingTurns)
        .set({ status: "failed", completedAt: now, updatedAt: now })
        .where(eq(jenovaBrandTrackingTurns.id, row.turn.id));
      failed += 1;
      continue;
    }
    if (!row.session.upstreamSessionId && !row.turn.upstreamRunId) {
      // The request crossed the durable `streaming` boundary, but no Jenova
      // identity was observed. Do not POST again: upstream idempotency has no
      // guaranteed permanent TTL, so a restart-time replay could create a
      // second paid session. This remains unknown for manual/upstream
      // reconciliation and continues blocking new spend.
      await db
        .update(jenovaBrandTrackingTurns)
        .set(
          row.turn.status === "streaming"
            ? {
                status: "recovering",
                costState: "unknown",
                errorCode: "identity_missing",
                errorMessage: "请求接收状态未知，等待人工核验",
                updatedAt: now,
              }
            : { updatedAt: now },
        )
        .where(eq(jenovaBrandTrackingTurns.id, row.turn.id));
      unresolved += 1;
      continue;
    }
    const recovered = await reconcileReservedTurn(
      db,
      reservation,
      resolved.client,
      now,
    );
    if (!recovered) {
      // Move unresolved work behind older rows so a permanently ambiguous turn
      // cannot monopolize the bounded recovery batch and starve newer users.
      await db
        .update(jenovaBrandTrackingTurns)
        .set({ updatedAt: now })
        .where(eq(jenovaBrandTrackingTurns.id, row.turn.id));
      unresolved += 1;
    } else if (recovered.status === "failed") {
      failed += 1;
    } else {
      completed += 1;
    }
  }
  return { scanned: rows.length, completed, failed, unresolved };
}

export async function revokeOrphanedJenovaBrandTrackingCredentials(
  database?: Database,
  now = new Date(),
) {
  const db = database ?? (await requireDatabase(getDb));
  const result = await db
    .update(jenovaBrandTrackingCredentials)
    .set({ status: "revoked", revokedAt: now, updatedAt: now })
    .where(
      and(
        eq(jenovaBrandTrackingCredentials.status, "active"),
        sql`NOT EXISTS (SELECT 1 FROM ${jenovaBrandTrackingAssignments} WHERE ${jenovaBrandTrackingAssignments.credentialId} = ${jenovaBrandTrackingCredentials.id})`,
      ),
    );
  return result;
}

export const recoverJenovaBrandTrackingAtStartup =
  recoverJenovaBrandTrackingTurns;

const queuedReconciliations = new Set<string>();

function queueJenovaTurnReconciliation(
  reservation: ReservedTurn,
  dependencies: ReturnType<typeof deps>,
) {
  if (queuedReconciliations.has(reservation.turn.id)) return;
  queuedReconciliations.add(reservation.turn.id);
  const delays = [2_000, 5_000, 15_000, 60_000];
  const runAttempt = (attempt: number) => {
    const timer = setTimeout(async () => {
      try {
        const db = await requireDatabase(dependencies.getDatabase);
        const recovered = await reconcileReservedTurn(
          db,
          reservation,
          dependencies.client,
          dependencies.now(),
        );
        if (recovered) {
          queuedReconciliations.delete(reservation.turn.id);
          return;
        }
      } catch {
        // The periodic durable sweep will retry without exposing key material.
      }
      if (attempt + 1 < delays.length) runAttempt(attempt + 1);
      else queuedReconciliations.delete(reservation.turn.id);
    }, delays[attempt]);
    timer.unref?.();
  };
  runAttempt(0);
}

/** Runs durable reconciliation repeatedly for active and unknown Jenova runs. */
export function startJenovaBrandTrackingRecoveryScheduler(
  dependencies: JenovaBrandTrackingDependencies = {},
  intervalMs = 60_000,
) {
  let running = false;
  const sweep = async () => {
    if (running) return;
    running = true;
    try {
      await recoverJenovaBrandTrackingTurns(dependencies);
    } catch (error) {
      console.warn(
        "[Jenova Brand Tracking] Recovery sweep failed",
        error instanceof Error ? error.message : "unknown error",
      );
    } finally {
      running = false;
    }
  };
  void sweep();
  const timer = setInterval(() => void sweep(), Math.max(10_000, intervalMs));
  timer.unref?.();
  return () => clearInterval(timer);
}
