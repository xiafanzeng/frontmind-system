import { randomUUID } from "node:crypto";
import { and, desc, eq, gte, inArray, isNull, lt, or } from "drizzle-orm";

import {
  apiCredentials,
  conversationTurns,
  knowledgeBaseBuilds,
  serviceContracts,
  userAdminAssignments,
  userDashboardContents,
  users,
  workspaceAuditEvents,
} from "../drizzle/schema";
import { dashboardPayloadSchema } from "../shared/dashboard";
import {
  hasDeliveryCapability,
  isExplicitAdminAccessLevel,
  type AdminAccessLevel,
} from "../shared/admin-access";
import type { EffectiveServiceStatus } from "../shared/service-portal";
import type { AuthenticatedUser } from "./auth-service";
import { AuthServiceError } from "./auth-service";
import { getDb } from "./db";
import {
  deriveEffectiveServiceStatus,
  selectPortalContract,
  type ServicePortalContractRecord,
} from "./service-entitlement";

export type { AdminAccessLevel };

type AdminIdentity = Pick<
  AuthenticatedUser,
  "id" | "role" | "username" | "adminAccessLevel"
>;

export function getEffectiveAdminAccessLevel(
  user: Pick<AuthenticatedUser, "role" | "username" | "adminAccessLevel">,
): AdminAccessLevel | null {
  if (user.role !== "admin") return null;
  return isExplicitAdminAccessLevel(user.adminAccessLevel)
    ? user.adminAccessLevel
    : null;
}

export function hasSystemAdminAccess(
  user: Pick<AuthenticatedUser, "role" | "username" | "adminAccessLevel">,
) {
  return getEffectiveAdminAccessLevel(user) === "system_admin";
}

export function hasDeliveryAdminAccess(
  user: Pick<AuthenticatedUser, "role" | "adminAccessLevel">,
) {
  return hasDeliveryCapability(user);
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

export async function assertAdminAccessLevelsBackfilled(executor?: any) {
  const db = executor ?? (await requireDb());
  const rows = await db
    .select({ id: users.id, username: users.username })
    .from(users)
    .where(and(eq(users.role, "admin"), isNull(users.adminAccessLevel)))
    .limit(1);
  if (rows[0]) {
    throw new AuthServiceError(
      "CONFLICT",
      "存在未配置 adminAccessLevel 的管理员账号，请先完成权限回填",
    );
  }
}

const SENSITIVE_AUDIT_KEY =
  /(?:^|[_-])(password|passphrase|secret|token|authorization|cookie|encrypted[_-]?key|encryption[_-]?(?:iv|auth[_-]?tag)|api[_-]?key)(?:$|[_-])|(?:password|passphrase|secret|token|apiKey|authorization|cookie|encryptedKey|encryptionIv|encryptionAuthTag|authTag)$/i;

function sanitizeAuditValue(value: unknown, depth: number): unknown {
  if (depth > 6) return "[TRUNCATED]";
  if (
    value === null ||
    typeof value === "boolean" ||
    typeof value === "number"
  ) {
    return value;
  }
  if (typeof value === "string") {
    return value.length > 4_000 ? `${value.slice(0, 4_000)}…` : value;
  }
  if (typeof value === "bigint") return value.toString();
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) {
    return value
      .slice(0, 100)
      .map((item) => sanitizeAuditValue(item, depth + 1));
  }
  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .slice(0, 100)
      .map(([key, item]) => [
        key,
        SENSITIVE_AUDIT_KEY.test(key)
          ? "[REDACTED]"
          : sanitizeAuditValue(item, depth + 1),
      ]);
    return Object.fromEntries(entries);
  }
  return String(value);
}

/** Defense-in-depth: audit callers cannot accidentally persist a credential. */
export function sanitizeAuditMetadata(
  metadata: Record<string, unknown> | undefined,
): Record<string, unknown> {
  return (sanitizeAuditValue(metadata ?? {}, 0) ?? {}) as Record<
    string,
    unknown
  >;
}

export async function writeWorkspaceAuditEvent(
  input: {
    actor: AdminIdentity;
    action: string;
    targetType: string;
    targetId: string | number;
    workspaceUserId?: number | null;
    reason?: string | null;
    metadata?: Record<string, unknown>;
    now?: Date;
  },
  executor?: any,
) {
  const db = executor ?? (await requireDb());
  const event = {
    id: randomUUID(),
    actorUserId: input.actor.id,
    actorUsername: input.actor.username.slice(0, 64),
    actorAccessLevel: getEffectiveAdminAccessLevel(input.actor),
    action: input.action.slice(0, 128),
    targetType: input.targetType.slice(0, 64),
    targetId: String(input.targetId).slice(0, 191),
    workspaceUserId: input.workspaceUserId ?? null,
    reason: input.reason?.trim() || null,
    metadata: sanitizeAuditMetadata(input.metadata),
    createdAt: input.now ?? new Date(),
  };
  await db.insert(workspaceAuditEvents).values(event);
  return event;
}

type WorkspaceAuditEventDto = {
  id: string;
  actorUserId: number;
  actorUsername: string;
  actorAccessLevel: AdminAccessLevel | null;
  action: string;
  targetType: string;
  targetId: string;
  workspaceUserId: number | null;
  reason: string | null;
  metadata: unknown;
  createdAt: number;
};

/**
 * Delivery administrators only need the human-readable audit trail for their
 * assigned workspace. Internal contract identifiers, administrator database
 * IDs and mutation metadata are reserved for system administrators.
 */
export function toDeliveryAdminWorkspaceAuditEvent(
  event: WorkspaceAuditEventDto,
) {
  const { actorUserId: _actorUserId, ...visible } = event;
  return {
    ...visible,
    targetId:
      event.targetType === "service_contract"
        ? event.workspaceUserId
          ? String(event.workspaceUserId)
          : "service"
        : event.targetId,
    metadata: {},
  };
}

export function workspaceAuditEventsForActor(
  actor: AdminIdentity,
  events: WorkspaceAuditEventDto[],
) {
  return hasSystemAdminAccess(actor)
    ? events
    : events.map(toDeliveryAdminWorkspaceAuditEvent);
}

const SERVICE_STATUSES: EffectiveServiceStatus[] = [
  "unconfigured",
  "pending_confirmation",
  "scheduled",
  "active",
  "suspended",
  "expired",
  "cancelled",
];

type OverviewUser = {
  id: number;
  username: string | null;
  displayName: string | null;
  isActive: boolean;
  createdAt: Date;
};

type OverviewDashboard = {
  userId: number;
  payload: Record<string, unknown>;
  sourceName: string | null;
};

type OverviewCredential = {
  userId: number;
  validationStatus: "unverified" | "verified" | "invalid";
  verifiedAt: Date | null;
};

type OverviewKnowledgeBuild = {
  id: string;
  userId: number;
  companyName: string;
  status:
    | "researching"
    | "confirming"
    | "ready_to_publish"
    | "published"
    | "protocol_error"
    | "failed";
  protocolError: string | null;
  updatedAt: Date;
};

type OverviewTaskCount = {
  userId: number;
  status: "queued" | "running" | "completed" | "failed" | "cancelled";
  total: number;
  updatedAt?: Date | null;
};

type OverviewTodo = {
  id: string;
  kind:
    | "customer_configuration"
    | "service"
    | "credential"
    | "knowledge"
    | "task";
  severity: "info" | "warning" | "critical";
  userId: number;
  title: string;
  description: string;
  status: string;
  updatedAt: number | null;
  href: string;
};

export function buildAdminControlPlaneOverview(input: {
  actor: AdminIdentity;
  users: OverviewUser[];
  assignments: Array<{ userId: number; adminId: number }>;
  dashboards: OverviewDashboard[];
  contracts: ServicePortalContractRecord[];
  credentials: OverviewCredential[];
  knowledgeBuilds: OverviewKnowledgeBuild[];
  taskCounts: OverviewTaskCount[];
  now?: Date;
}) {
  const now = input.now ?? new Date();
  const systemAdmin = hasSystemAdminAccess(input.actor);
  const dashboardByUser = new Map(
    input.dashboards.map((dashboard) => [dashboard.userId, dashboard]),
  );
  const credentialByUser = new Map(
    input.credentials.map((credential) => [credential.userId, credential]),
  );
  const contractsByUser = new Map<number, ServicePortalContractRecord[]>();
  for (const contract of input.contracts) {
    const rows = contractsByUser.get(contract.userId) ?? [];
    rows.push(contract);
    contractsByUser.set(contract.userId, rows);
  }

  const serviceStatuses = Object.fromEntries(
    SERVICE_STATUSES.map((status) => [status, 0]),
  ) as Record<EffectiveServiceStatus, number>;
  const credentialMetrics = {
    configured: 0,
    missing: 0,
    verified: 0,
    unverified: 0,
    invalid: 0,
  };
  const knowledgeMetrics = {
    researching: 0,
    confirming: 0,
    readyToPublish: 0,
    published: 0,
    protocolError: 0,
    failed: 0,
  };
  const taskMetrics = {
    queued: 0,
    running: 0,
    completed: 0,
    failed: 0,
    cancelled: 0,
  };
  const todos: OverviewTodo[] = [];
  const latestKnowledgeBuilds = [
    ...input.knowledgeBuilds
      .reduce((latestByUser, build) => {
        const current = latestByUser.get(build.userId);
        if (!current || build.updatedAt > current.updatedAt) {
          latestByUser.set(build.userId, build);
        }
        return latestByUser;
      }, new Map<number, OverviewKnowledgeBuild>())
      .values(),
  ];

  for (const user of input.users) {
    const displayName =
      user.displayName?.trim() || user.username || `用户 ${user.id}`;
    const dashboard = dashboardByUser.get(user.id);
    const parsedDashboard = dashboard
      ? dashboardPayloadSchema.safeParse(dashboard.payload)
      : null;
    const dashboardConfigured = Boolean(
      dashboard?.sourceName && parsedDashboard?.success,
    );
    const userContracts = contractsByUser.get(user.id) ?? [];
    const currentContract = selectPortalContract(userContracts);
    const serviceStatus = deriveEffectiveServiceStatus(currentContract, now);
    const serviceEndsAt = currentContract
      ? new Date(currentContract.endsAt).getTime()
      : null;
    const serviceExpiringSoon =
      serviceStatus === "active" &&
      serviceEndsAt !== null &&
      serviceEndsAt > now.getTime() &&
      serviceEndsAt - now.getTime() <= 14 * 24 * 60 * 60 * 1_000;
    serviceStatuses[serviceStatus] += 1;
    const credential = credentialByUser.get(user.id);

    if (credential) {
      credentialMetrics.configured += 1;
      credentialMetrics[credential.validationStatus] += 1;
    } else {
      credentialMetrics.missing += 1;
    }

    if (user.isActive && !dashboardConfigured) {
      todos.push({
        id: `customer-configuration:${user.id}`,
        kind: "customer_configuration",
        severity: "warning",
        userId: user.id,
        title: `${displayName}待配置交付工作区`,
        description: "尚未发布可校验的企业看板内容。",
        status: "unconfigured",
        updatedAt: user.createdAt.getTime(),
        href: `/admin/customers/${user.id}/service`,
      });
    }
    if (user.isActive && (serviceStatus !== "active" || serviceExpiringSoon)) {
      const critical =
        serviceStatus === "suspended" || serviceStatus === "expired";
      const todoStatus = serviceExpiringSoon ? "expiring_soon" : serviceStatus;
      todos.push({
        id: `service:${user.id}:${todoStatus}`,
        kind: "service",
        severity: critical ? "critical" : "warning",
        userId: user.id,
        title: serviceExpiringSoon
          ? `${displayName}服务即将到期`
          : `${displayName}服务状态待处理`,
        description: serviceExpiringSoon
          ? `当前套餐将在 ${new Date(serviceEndsAt!).toLocaleDateString(
              "zh-CN",
              { timeZone: "Asia/Shanghai" },
            )} 到期。`
          : `当前套餐状态：${serviceStatus}`,
        status: todoStatus,
        updatedAt: currentContract?.createdAt
          ? new Date(currentContract.createdAt).getTime()
          : user.createdAt.getTime(),
        href: `/admin/customers/${user.id}/service`,
      });
    }
    if (
      user.isActive &&
      (!credential || credential.validationStatus !== "verified")
    ) {
      const status = credential?.validationStatus ?? "missing";
      todos.push({
        id: `credential:${user.id}:${status}`,
        kind: "credential",
        severity: status === "invalid" ? "critical" : "warning",
        userId: user.id,
        title: `${displayName} API Key 待处理`,
        description:
          status === "missing"
            ? "尚未配置客户 API Key。"
            : `当前 Key 校验状态：${status}`,
        status,
        updatedAt: credential?.verifiedAt?.getTime() ?? null,
        href: `/admin/customers/${user.id}/credential`,
      });
    }
  }

  for (const build of latestKnowledgeBuilds) {
    const metricKey =
      build.status === "ready_to_publish"
        ? "readyToPublish"
        : build.status === "protocol_error"
          ? "protocolError"
          : build.status;
    knowledgeMetrics[metricKey] += 1;
    if (
      build.status === "ready_to_publish" ||
      build.status === "protocol_error" ||
      build.status === "failed"
    ) {
      todos.push({
        id: `knowledge:${build.id}`,
        kind: "knowledge",
        severity: build.status === "ready_to_publish" ? "info" : "critical",
        userId: build.userId,
        title:
          build.status === "ready_to_publish"
            ? `${build.companyName}知识库待发布`
            : `${build.companyName}知识库任务失败`,
        description:
          build.protocolError?.slice(0, 500) ||
          (build.status === "ready_to_publish"
            ? "知识库构建已完成，等待管理员预览并发布。"
            : `构建状态：${build.status}`),
        status: build.status,
        updatedAt: build.updatedAt.getTime(),
        href: `/admin/customers/${build.userId}/knowledge`,
      });
    }
  }

  for (const row of input.taskCounts) {
    taskMetrics[row.status] += row.total;
    if (row.status === "failed" && row.total > 0) {
      todos.push({
        id: `task:${row.userId}:failed`,
        kind: "task",
        severity: "critical",
        userId: row.userId,
        title: `客户任务失败（${row.total}）`,
        description: "存在失败的智能体执行记录，请进入客户工作区检查并重试。",
        status: "failed",
        updatedAt: row.updatedAt?.getTime() ?? null,
        href: `/admin/customers/${row.userId}/knowledge`,
      });
    }
  }

  const severityRank = { critical: 0, warning: 1, info: 2 } as const;
  todos.sort(
    (left, right) =>
      severityRank[left.severity] - severityRank[right.severity] ||
      (right.updatedAt ?? 0) - (left.updatedAt ?? 0) ||
      left.id.localeCompare(right.id),
  );

  const assignedUserIds = new Set(
    input.assignments.map((assignment) => assignment.userId),
  );
  return {
    generatedAt: now.getTime(),
    access: {
      adminAccessLevel: getEffectiveAdminAccessLevel(input.actor),
      isSystemAdmin: systemAdmin,
    },
    metrics: {
      customers: {
        total: input.users.length,
        active: input.users.filter((user) => user.isActive).length,
        inactive: input.users.filter((user) => !user.isActive).length,
        unassigned: systemAdmin
          ? input.users.filter((user) => !assignedUserIds.has(user.id)).length
          : null,
        pendingDashboardConfiguration: input.users.filter((user) => {
          const dashboard = dashboardByUser.get(user.id);
          return (
            user.isActive &&
            !(
              dashboard?.sourceName &&
              dashboardPayloadSchema.safeParse(dashboard.payload).success
            )
          );
        }).length,
      },
      services: serviceStatuses,
      credentials: credentialMetrics,
      knowledge: knowledgeMetrics,
      tasks: taskMetrics,
    },
    todos: todos.slice(0, 200),
  };
}

export async function getAdminControlPlaneOverview(actor: AuthenticatedUser) {
  if (actor.role !== "admin") {
    throw new AuthServiceError(
      "INVALID_CREDENTIAL",
      "Administrator permission is required",
    );
  }
  const db = await requireDb();
  const systemAdmin = hasSystemAdminAccess(actor);
  const assignments = systemAdmin
    ? await db
        .select({
          userId: userAdminAssignments.userId,
          adminId: userAdminAssignments.adminId,
        })
        .from(userAdminAssignments)
    : await db
        .select({
          userId: userAdminAssignments.userId,
          adminId: userAdminAssignments.adminId,
        })
        .from(userAdminAssignments)
        .where(eq(userAdminAssignments.adminId, actor.id));
  const manageableIds = systemAdmin
    ? null
    : [...new Set(assignments.map((assignment) => assignment.userId))];
  const userRows =
    manageableIds?.length === 0
      ? []
      : await db
          .select({
            id: users.id,
            username: users.username,
            displayName: users.displayName,
            isActive: users.isActive,
            createdAt: users.createdAt,
          })
          .from(users)
          .where(
            manageableIds
              ? and(eq(users.role, "user"), inArray(users.id, manageableIds))
              : eq(users.role, "user"),
          )
          .orderBy(desc(users.createdAt));
  const visibleUserIds = userRows.map((user) => user.id);
  if (visibleUserIds.length === 0) {
    return buildAdminControlPlaneOverview({
      actor,
      users: [],
      assignments,
      dashboards: [],
      contracts: [],
      credentials: [],
      knowledgeBuilds: [],
      taskCounts: [],
    });
  }

  const taskWindowStart = new Date(Date.now() - 30 * 24 * 60 * 60 * 1_000);
  const [
    dashboards,
    contracts,
    credentials,
    knowledgeBuildRows,
    recentTaskRows,
  ] = await Promise.all([
    db
      .select({
        userId: userDashboardContents.userId,
        payload: userDashboardContents.payload,
        sourceName: userDashboardContents.sourceName,
      })
      .from(userDashboardContents)
      .where(inArray(userDashboardContents.userId, visibleUserIds)),
    db
      .select()
      .from(serviceContracts)
      .where(inArray(serviceContracts.userId, visibleUserIds)),
    db
      .select({
        userId: apiCredentials.userId,
        validationStatus: apiCredentials.validationStatus,
        verifiedAt: apiCredentials.verifiedAt,
      })
      .from(apiCredentials)
      .where(
        and(
          inArray(apiCredentials.userId, visibleUserIds),
          eq(apiCredentials.status, "active"),
        ),
      ),
    db
      .select({
        id: knowledgeBaseBuilds.id,
        userId: knowledgeBaseBuilds.userId,
        companyName: knowledgeBaseBuilds.companyName,
        status: knowledgeBaseBuilds.status,
        protocolError: knowledgeBaseBuilds.protocolError,
        updatedAt: knowledgeBaseBuilds.updatedAt,
      })
      .from(knowledgeBaseBuilds)
      .where(inArray(knowledgeBaseBuilds.userId, visibleUserIds)),
    db
      .select({
        id: conversationTurns.id,
        conversationId: conversationTurns.conversationId,
        userId: conversationTurns.userId,
        status: conversationTurns.status,
        updatedAt: conversationTurns.updatedAt,
      })
      .from(conversationTurns)
      .where(
        and(
          inArray(conversationTurns.userId, visibleUserIds),
          gte(conversationTurns.updatedAt, taskWindowStart),
        ),
      )
      .orderBy(desc(conversationTurns.updatedAt), desc(conversationTurns.id)),
  ]);

  const latestTaskByConversation = new Map<
    string,
    (typeof recentTaskRows)[number]
  >();
  for (const row of recentTaskRows) {
    if (!latestTaskByConversation.has(row.conversationId)) {
      latestTaskByConversation.set(row.conversationId, row);
    }
  }
  const taskCountMap = new Map<string, OverviewTaskCount>();
  for (const row of latestTaskByConversation.values()) {
    const key = `${row.userId}:${row.status}`;
    const current = taskCountMap.get(key);
    taskCountMap.set(key, {
      userId: row.userId,
      status: row.status,
      total: (current?.total ?? 0) + 1,
      updatedAt:
        !current?.updatedAt || row.updatedAt > current.updatedAt
          ? row.updatedAt
          : current.updatedAt,
    });
  }

  return buildAdminControlPlaneOverview({
    actor,
    users: userRows,
    assignments,
    dashboards: dashboards as OverviewDashboard[],
    contracts: contracts as ServicePortalContractRecord[],
    credentials,
    knowledgeBuilds: knowledgeBuildRows,
    taskCounts: [...taskCountMap.values()],
  });
}

export async function listWorkspaceAuditEvents(input: {
  actor: AuthenticatedUser;
  workspaceUserId?: number;
  limit?: number;
  cursor?: { createdAt: number; id: string };
}) {
  if (input.actor.role !== "admin") {
    throw new AuthServiceError(
      "INVALID_CREDENTIAL",
      "Administrator permission is required",
    );
  }
  const db = await requireDb();
  const systemAdmin = hasSystemAdminAccess(input.actor);
  const assignedRows = systemAdmin
    ? []
    : await db
        .select({ userId: userAdminAssignments.userId })
        .from(userAdminAssignments)
        .where(eq(userAdminAssignments.adminId, input.actor.id));
  const assignedUserIds = assignedRows.map((row) => row.userId);
  if (
    !systemAdmin &&
    input.workspaceUserId !== undefined &&
    !assignedUserIds.includes(input.workspaceUserId)
  ) {
    throw new AuthServiceError("NOT_FOUND", "User workspace not found");
  }

  const scopeCondition = systemAdmin
    ? undefined
    : assignedUserIds.length > 0
      ? or(
          eq(workspaceAuditEvents.actorUserId, input.actor.id),
          inArray(workspaceAuditEvents.workspaceUserId, assignedUserIds),
        )
      : eq(workspaceAuditEvents.actorUserId, input.actor.id);
  const workspaceCondition =
    input.workspaceUserId === undefined
      ? undefined
      : eq(workspaceAuditEvents.workspaceUserId, input.workspaceUserId);
  const cursorCondition = input.cursor
    ? or(
        lt(workspaceAuditEvents.createdAt, new Date(input.cursor.createdAt)),
        and(
          eq(workspaceAuditEvents.createdAt, new Date(input.cursor.createdAt)),
          lt(workspaceAuditEvents.id, input.cursor.id),
        ),
      )
    : undefined;
  const conditions = [
    scopeCondition,
    workspaceCondition,
    cursorCondition,
  ].filter(Boolean) as NonNullable<
    typeof scopeCondition | typeof workspaceCondition | typeof cursorCondition
  >[];
  const limit = Math.min(Math.max(input.limit ?? 50, 1), 100);
  const rows = await db
    .select()
    .from(workspaceAuditEvents)
    .where(conditions.length ? and(...conditions) : undefined)
    .orderBy(
      desc(workspaceAuditEvents.createdAt),
      desc(workspaceAuditEvents.id),
    )
    .limit(limit + 1);
  const page = rows.slice(0, limit);
  const last = page.at(-1);
  const events = page.map((event) => ({
    ...event,
    createdAt: event.createdAt.getTime(),
  }));
  return {
    events: workspaceAuditEventsForActor(
      input.actor,
      events as WorkspaceAuditEventDto[],
    ),
    nextCursor:
      rows.length > limit && last
        ? { createdAt: last.createdAt.getTime(), id: last.id }
        : null,
  };
}
