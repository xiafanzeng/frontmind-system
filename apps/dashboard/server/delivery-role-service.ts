import { randomUUID } from "node:crypto";

import { and, asc, desc, eq, gt, inArray, lte, or, sql } from "drizzle-orm";

import {
  apiCredentials,
  deliveryMemberOrigins,
  deliveryProjectAssignments,
  monitoringBatches,
  serviceContracts,
  serviceQuotaPeriods,
  userDashboardContents,
  userUsageOwners,
  users,
  workspaceQuestions,
} from "../drizzle/schema";

import {
  DELIVERY_ROLE_LABELS,
  type DeliveryRoleType,
} from "../shared/delivery-roles";

import { hasExplicitAdminRole } from "../shared/admin-access";

import { dashboardPayloadSchema } from "../shared/dashboard";

import {
  acquireActiveApiCredentialDeletionFence,
  AuthServiceError,
  completeActiveApiCredentialDeletionFence,
  createManagedUser,
  deleteActiveApiCredentialInTransaction,
  replaceApiCredentialInTransaction,
  rollbackActiveApiCredentialDeletionFence,
  startActiveApiCredentialDeletionFenceHeartbeat,
  validateUpstreamApiKey,
  type AuthenticatedUser,
} from "./auth-service";

import {
  hasSystemAdminAccess,
  writeWorkspaceAuditEvent,
} from "./admin-control-plane-service";

import {
  getJenovaBrandTrackingUsageForProject,
  updateJenovaBrandTrackingLimit,
} from "./jenova-brand-tracking-service";

import { getLatestKnowledgeSnapshot } from "./dashboard-service";

import { getDb } from "./db";

import { getKnowledgeBaseProgress } from "./knowledge-base-progress-service";

import { toKnowledgeBasePublicPayload } from "./knowledge-base-public-projection";

import { getQuestionQuotaState } from "./question-quota-service";

import { questionCategoryForPublic } from "./question-selection-policy";

import { listResponseLogicEntriesByQuestionIds } from "./response-logic-service";

import {
  SERVICE_QUESTION_QUOTA_ANCHOR_ORDINAL,
  deriveEffectiveServiceStatus,
  getServicePortal,
  isOperationalServiceQuotaPeriod,
  isProgressiveLuxuryContract,
  resolveCurrentServiceQuotaScope,
  selectCurrentServiceContractIds,
  selectPortalContract,
  type ServicePortalContractRecord,
} from "./service-entitlement";

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

function requireDeliveryManager(actor: AuthenticatedUser) {
  if (!hasExplicitAdminRole(actor)) {
    throw new AuthServiceError("INVALID_CREDENTIAL", "需要交付管理权限");
  }
}

function requireSystemAdminCredentialManagement(actor: AuthenticatedUser) {
  if (!hasSystemAdminAccess(actor)) {
    throw new AuthServiceError(
      "INVALID_CREDENTIAL",
      "API Key 仅由系统管理员统一维护",
    );
  }
}

export function decideEngineerCredentialManagementScope(input: {
  systemAdmin: boolean;
  actorUserId: number;
  assignmentAdminIds: Array<number | null>;
  createdByAdminId: number | null;
}) {
  const managerAdminIds = Array.from(
    new Set(
      input.assignmentAdminIds.filter(
        (id: number | null): id is number => typeof id === "number",
      ),
    ),
  );
  if (input.systemAdmin) {
    return { manageable: true, reason: null, managerAdminIds };
  }
  return {
    manageable: false,
    reason: "工程师 API Key 仅由系统管理员统一维护，避免跨项目 Key 归属冲突。",
    managerAdminIds,
  };
}

export function assertDeliveryMemberCredentialVersion(input: {
  actualVersion: number;
  expectedVersion: number;
}) {
  if (input.actualVersion !== input.expectedVersion) {
    throw new AuthServiceError(
      "CONFLICT",
      "工程师 API Key 状态已变化，请刷新后重试",
    );
  }
}

function requiredRolesForPlan(planCode: string | null | undefined) {
  const roles: DeliveryRoleType[] = [
    "monitoring_optimization_engineer",
    "content_distribution_engineer",
  ];
  if (planCode === "advanced" || planCode === "luxury") {
    roles.unshift("ai_operations_engineer");
  }
  return roles;
}

function requiredRolesForCustomer(
  planCode: string | null | undefined,
  marketEdition: "domestic" | "overseas",
) {
  const roles = requiredRolesForPlan(planCode);
  if (
    marketEdition === "overseas" &&
    !roles.includes("ai_operations_engineer")
  ) {
    roles.unshift("ai_operations_engineer");
  }
  return roles;
}

function deliveryRoleEnabledForCustomer(input: {
  roleType: DeliveryRoleType;
  planCode: string | null | undefined;
  marketEdition: "domestic" | "overseas";
}) {
  return requiredRolesForCustomer(input.planCode, input.marketEdition).includes(
    input.roleType,
  );
}

async function assertCanManageProject(input: {
  executor: any;
  actor: AuthenticatedUser;
  customerUserId: number;
}) {
  if (input.actor.adminAccessLevel === "system_admin") return;
  const ownerRows = await input.executor
    .select({ deliveryAdminId: userUsageOwners.deliveryAdminId })
    .from(userUsageOwners)
    .where(
      and(
        eq(userUsageOwners.userId, input.customerUserId),
        eq(userUsageOwners.deliveryAdminId, input.actor.id),
      ),
    )
    .limit(1)
    .for("update");
  if (!ownerRows[0]) {
    throw new AuthServiceError(
      "INVALID_CREDENTIAL",
      "只能管理由当前交付管理员负责的客户项目",
    );
  }
}

async function engineerCredentialManagementScope(input: {
  executor: any;
  actor: AuthenticatedUser;
  engineerUserId: number;
}) {
  const [assignmentRows, originRows] = await Promise.all([
    input.executor
      .select({
        customerUserId: deliveryProjectAssignments.customerUserId,
        deliveryAdminId: userUsageOwners.deliveryAdminId,
      })
      .from(deliveryProjectAssignments)
      .leftJoin(
        userUsageOwners,
        eq(userUsageOwners.userId, deliveryProjectAssignments.customerUserId),
      )
      .where(
        eq(deliveryProjectAssignments.engineerUserId, input.engineerUserId),
      ),
    input.executor
      .select({ createdByAdminId: deliveryMemberOrigins.createdByAdminId })
      .from(deliveryMemberOrigins)
      .where(eq(deliveryMemberOrigins.engineerUserId, input.engineerUserId))
      .limit(1),
  ]);
  const customerUserIds = Array.from(
    new Set(
      assignmentRows.map(
        (row: { customerUserId: number }) => row.customerUserId,
      ),
    ),
  );
  const createdByAdminId = originRows[0]?.createdByAdminId ?? null;
  return {
    ...decideEngineerCredentialManagementScope({
      systemAdmin: input.actor.adminAccessLevel === "system_admin",
      actorUserId: input.actor.id,
      assignmentAdminIds: assignmentRows.map(
        (row: { deliveryAdminId: number | null }) => row.deliveryAdminId,
      ),
      createdByAdminId,
    }),
    customerUserIds,
  };
}

async function requireEngineerCredentialManagement(input: {
  executor: any;
  actor: AuthenticatedUser;
  engineerUserId: number;
}) {
  requireDeliveryManager(input.actor);
  const rows = await input.executor
    .select({ role: users.role })
    .from(users)
    .where(eq(users.id, input.engineerUserId))
    .limit(1);
  if (rows[0]?.role !== "delivery_member") {
    throw new AuthServiceError("NOT_FOUND", "工程师不存在");
  }
  const scope = await engineerCredentialManagementScope(input);
  if (!scope.manageable) {
    throw new AuthServiceError(
      "INVALID_CREDENTIAL",
      scope.reason || "无权维护该工程师 API Key",
    );
  }
  return scope;
}

export async function listDeliveryRoleManagement(actor: AuthenticatedUser) {
  requireDeliveryManager(actor);
  const db = await requireDb();
  const [
    allCustomers,
    contracts,
    ownerRows,
    adminRows,
    engineers,
    credentials,
    allAssignmentRows,
    originRows,
  ] = await Promise.all([
    db
      .select({
        id: users.id,
        username: users.username,
        displayName: users.displayName,
        marketEdition: users.marketEdition,
        isActive: users.isActive,
      })
      .from(users)
      .where(eq(users.role, "user"))
      .orderBy(desc(users.createdAt)),
    db.select().from(serviceContracts).orderBy(desc(serviceContracts.revision)),
    db.select().from(userUsageOwners),
    db
      .select({
        id: users.id,
        username: users.username,
        displayName: users.displayName,
        adminAccessLevel: users.adminAccessLevel,
        isActive: users.isActive,
      })
      .from(users)
      .where(eq(users.role, "admin")),
    db
      .select({
        id: users.id,
        username: users.username,
        displayName: users.displayName,
        isActive: users.isActive,
        engineerRoleType: users.engineerRoleType,
      })
      .from(users)
      .where(eq(users.role, "delivery_member"))
      .orderBy(desc(users.createdAt)),
    db
      .select({
        userId: apiCredentials.userId,
        version: apiCredentials.version,
        status: apiCredentials.status,
      })
      .from(apiCredentials),
    db.select().from(deliveryProjectAssignments),
    db.select().from(deliveryMemberOrigins),
  ]);
  const visibleCustomers =
    actor.adminAccessLevel === "system_admin"
      ? allCustomers
      : allCustomers.filter((customer) =>
          ownerRows.some(
            (owner) =>
              owner.userId === customer.id &&
              owner.deliveryAdminId === actor.id,
          ),
        );
  const customerIds = visibleCustomers.map((customer) => customer.id);
  const assignmentRows = allAssignmentRows.filter((assignment) =>
    customerIds.includes(assignment.customerUserId),
  );
  const adminById = new Map(adminRows.map((admin) => [admin.id, admin]));
  const contractByCustomer = new Map<number, (typeof contracts)[number]>();
  for (const customer of visibleCustomers) {
    const contract = selectPortalContract(
      contracts.filter(
        (candidate) => candidate.userId === customer.id,
      ) as ServicePortalContractRecord[],
    );
    if (contract) {
      contractByCustomer.set(
        customer.id,
        contract as (typeof contracts)[number],
      );
    }
  }
  const configuredEngineerIds = new Set(
    credentials
      .filter((credential) => credential.status === "active")
      .map((credential) => credential.userId),
  );
  const credentialVersionByEngineerId = new Map<number, number>();
  for (const credential of credentials) {
    credentialVersionByEngineerId.set(
      credential.userId,
      Math.max(
        credential.version,
        credentialVersionByEngineerId.get(credential.userId) ?? 0,
      ),
    );
  }
  const engineerById = new Map(
    engineers.map((engineer) => [engineer.id, engineer]),
  );
  const projects = visibleCustomers.map((customer) => {
    const contract = contractByCustomer.get(customer.id);
    const owner = ownerRows.find((row) => row.userId === customer.id);
    const manager = owner ? adminById.get(owner.deliveryAdminId) : null;
    return {
      ...customer,
      planCode: contract?.planCode ?? null,
      contractStatus: deriveEffectiveServiceStatus(contract),
      contractStartsAt: contract?.startsAt?.getTime() ?? null,
      contractEndsAt: contract?.endsAt?.getTime() ?? null,
      managerId: manager?.id ?? null,
      managerUsername: manager?.username ?? null,
      managerDisplayName: manager?.displayName ?? null,
      requiredRoleTypes: requiredRolesForCustomer(
        contract?.planCode,
        customer.marketEdition,
      ),
    };
  });
  const assignments = assignmentRows.map((assignment) => {
    const engineer =
      assignment.engineerUserId == null
        ? null
        : engineerById.get(assignment.engineerUserId);
    return {
      ...assignment,
      engineerUsername: engineer?.username ?? null,
      engineerDisplayName: engineer?.displayName ?? null,
      engineerApiKeyConfigured:
        assignment.engineerUserId != null &&
        configuredEngineerIds.has(assignment.engineerUserId),
    };
  });
  const enrichedEngineers = engineers.map((engineer) => {
    const engineerAssignments = allAssignmentRows.filter(
      (assignment) => assignment.engineerUserId === engineer.id,
    );
    const assignmentAdminIds = engineerAssignments.map(
      (assignment) =>
        ownerRows.find((owner) => owner.userId === assignment.customerUserId)
          ?.deliveryAdminId ?? null,
    );
    const originAdminId =
      originRows.find((origin) => origin.engineerUserId === engineer.id)
        ?.createdByAdminId ?? null;
    const managementScope = decideEngineerCredentialManagementScope({
      systemAdmin: actor.adminAccessLevel === "system_admin",
      actorUserId: actor.id,
      assignmentAdminIds,
      createdByAdminId: originAdminId,
    });
    return {
      ...engineer,
      apiKeyConfigured: configuredEngineerIds.has(engineer.id),
      apiKeyVersion: credentialVersionByEngineerId.get(engineer.id) ?? 0,
      apiKeyManageable: managementScope.manageable,
      apiKeyManageReason: managementScope.reason,
    };
  });
  return { projects, assignments, engineers: enrichedEngineers };
}

export function deliveryExecutionActorRole(
  actor: Pick<AuthenticatedUser, "role" | "username" | "adminAccessLevel">,
) {
  if (hasSystemAdminAccess(actor)) return "admin" as const;
  if (actor.role === "delivery_member") return "delivery_member" as const;
  return null;
}

type CurrentDeliveryQuotaScope = NonNullable<
  Awaited<ReturnType<typeof resolveCurrentServiceQuotaScope>>
>;

type ActiveDeliveryQuotaSelection = {
  primaryContract: ServicePortalContractRecord;
  scopes: CurrentDeliveryQuotaScope[];
};

async function resolveActiveDeliveryQuotaScopes(input: {
  executor: any;
  userId: number;
  now?: Date;
}): Promise<ActiveDeliveryQuotaSelection | null> {
  const now = input.now ?? new Date();
  const contractRows = (await input.executor
    .select()
    .from(serviceContracts)
    .where(eq(serviceContracts.userId, input.userId))
    .orderBy(desc(serviceContracts.revision))) as ServicePortalContractRecord[];
  const { contract: primaryContract, contractIds } =
    selectCurrentServiceContractIds(contractRows, now);
  if (
    !primaryContract ||
    deriveEffectiveServiceStatus(primaryContract, now) !== "active"
  ) {
    return null;
  }
  const periodRows = await input.executor
    .select()
    .from(serviceQuotaPeriods)
    .where(
      and(
        eq(serviceQuotaPeriods.userId, input.userId),
        inArray(serviceQuotaPeriods.contractId, contractIds),
        gt(serviceQuotaPeriods.ordinal, SERVICE_QUESTION_QUOTA_ANCHOR_ORDINAL),
        lte(serviceQuotaPeriods.startsAt, now),
        gt(serviceQuotaPeriods.endsAt, now),
      ),
    )
    .orderBy(asc(serviceQuotaPeriods.ordinal));
  const contractById = new Map(contractRows.map((row) => [row.id, row]));
  const scopes = periodRows
    .filter(isOperationalServiceQuotaPeriod)
    .flatMap((period: typeof serviceQuotaPeriods.$inferSelect) => {
      const contract = contractById.get(period.contractId);
      return contract ? [{ contract, period }] : [];
    });
  return scopes.length ? { primaryContract, scopes } : null;
}

function effectiveActiveDeliveryQuotaScopes(
  selection: ActiveDeliveryQuotaSelection,
) {
  return selection.scopes;
}

type DeliveryQuestionWorkflowScope = {
  progressiveLuxury: boolean;
  contractId: string;
  quotaPeriodId: string;
  startsAt: Date;
  endsAt: Date;
};

function deliveryQuestionWorkflowScope(
  scope: CurrentDeliveryQuotaScope,
): DeliveryQuestionWorkflowScope {
  const progressiveLuxury = isProgressiveLuxuryContract(scope.contract);
  return {
    progressiveLuxury,
    contractId: scope.contract.id,
    quotaPeriodId: scope.period.id,
    startsAt: progressiveLuxury
      ? new Date(scope.contract.startsAt)
      : new Date(scope.period.startsAt),
    endsAt: progressiveLuxury
      ? new Date(scope.contract.endsAt)
      : new Date(scope.period.endsAt),
  };
}

function workspaceQuestionDeliveryScopeCondition(
  scope: DeliveryQuestionWorkflowScope,
) {
  return scope.progressiveLuxury
    ? eq(workspaceQuestions.contractId, scope.contractId)
    : eq(workspaceQuestions.quotaPeriodId, scope.quotaPeriodId);
}

function workspaceQuestionDeliveryScopesCondition(
  scopes: DeliveryQuestionWorkflowScope[],
) {
  return or(
    ...scopes.map((scope) => workspaceQuestionDeliveryScopeCondition(scope)),
  );
}

export async function createDeliveryEngineer(input: {
  actor: AuthenticatedUser;
  username: string;
  password: string;
  displayName?: string;
  engineerRoleType: DeliveryRoleType;
  apiKey?: string;
}) {
  requireDeliveryManager(input.actor);
  const apiKey = input.apiKey?.trim() || null;
  if (apiKey) {
    requireSystemAdminCredentialManagement(input.actor);
  }
  if (apiKey) await validateUpstreamApiKey(apiKey);
  const db = await requireDb();
  return db.transaction(async (tx) => {
    const user = await createManagedUser(
      {
        username: input.username,
        password: input.password,
        displayName: input.displayName,
        role: "delivery_member",
        engineerRoleType: input.engineerRoleType,
      },
      tx,
    );
    if (apiKey) {
      await replaceApiCredentialInTransaction({
        executor: tx,
        userId: user.id,
        apiKey,
        agentProfile: null,
      });
    }
    await tx.insert(deliveryMemberOrigins).values({
      engineerUserId: user.id,
      createdByAdminId: input.actor.id,
      createdAt: new Date(),
    });
    await writeWorkspaceAuditEvent(
      {
        actor: input.actor,
        action: "account.created",
        targetType: "user",
        targetId: user.id,
        workspaceUserId: null,
        metadata: {
          role: "delivery_member",
          engineerRoleType: input.engineerRoleType,
          apiKeyConfigured: Boolean(apiKey),
        },
      },
      tx,
    );
    return user;
  });
}

export async function setProjectEngineer(input: {
  actor: AuthenticatedUser;
  customerUserId: number;
  roleType: DeliveryRoleType;
  engineerUserId: number | null;
  expectedRevision: number;
}) {
  requireDeliveryManager(input.actor);
  const db = await requireDb();
  let result;
  try {
    result = await db.transaction(async (tx) => {
      const customerRows = await tx
        .select({
          role: users.role,
          marketEdition: users.marketEdition,
          isActive: users.isActive,
        })
        .from(users)
        .where(eq(users.id, input.customerUserId))
        .limit(1)
        .for("update");
      if (customerRows[0]?.role !== "user" || !customerRows[0]?.isActive) {
        throw new AuthServiceError("NOT_FOUND", "客户项目不存在或已停用");
      }
      await assertCanManageProject({
        executor: tx,
        actor: input.actor,
        customerUserId: input.customerUserId,
      });
      const contractRows = await tx
        .select()
        .from(serviceContracts)
        .where(eq(serviceContracts.userId, input.customerUserId));
      const currentContract = selectPortalContract(
        contractRows as ServicePortalContractRecord[],
      );
      if (
        input.engineerUserId != null &&
        !deliveryRoleEnabledForCustomer({
          roleType: input.roleType,
          planCode: currentContract?.planCode,
          marketEdition: customerRows[0].marketEdition,
        })
      ) {
        throw new AuthServiceError("CONFLICT", "当前套餐未启用该工程师岗位");
      }
      if (input.engineerUserId != null) {
        const engineerRows = await tx
          .select({
            role: users.role,
            isActive: users.isActive,
            engineerRoleType: users.engineerRoleType,
          })
          .from(users)
          .where(eq(users.id, input.engineerUserId))
          .limit(1)
          .for("update");
        const engineer = engineerRows[0];
        if (
          engineer?.role !== "delivery_member" ||
          !engineer.isActive ||
          engineer.engineerRoleType !== input.roleType
        ) {
          throw new AuthServiceError(
            "CONFLICT",
            "请选择岗位匹配且已启用的工程师账号",
          );
        }
      }
      const existingRows = await tx
        .select()
        .from(deliveryProjectAssignments)
        .where(
          and(
            eq(deliveryProjectAssignments.customerUserId, input.customerUserId),
            eq(deliveryProjectAssignments.roleType, input.roleType),
          ),
        )
        .limit(1)
        .for("update");
      const existing = existingRows[0] ?? null;
      if ((existing?.revision ?? 0) !== input.expectedRevision) {
        throw new AuthServiceError("CONFLICT", "项目团队已变化，请刷新后重试");
      }
      if (input.engineerUserId == null) {
        if (!existing) return { success: true as const, assignment: null };
        const nextRevision = existing.revision + 1;
        await tx
          .update(deliveryProjectAssignments)
          .set({
            engineerUserId: null,
            assignedByUserId: input.actor.id,
            revision: nextRevision,
            updatedAt: new Date(),
          })
          .where(eq(deliveryProjectAssignments.id, existing.id));
        await writeWorkspaceAuditEvent(
          {
            actor: input.actor,
            action: "delivery.project_engineer.unassigned",
            targetType: "workspace",
            targetId: input.customerUserId,
            workspaceUserId: input.customerUserId,
            metadata: {
              roleType: input.roleType,
              previousEngineerUserId: existing.engineerUserId,
            },
          },
          tx,
        );
        return {
          success: true as const,
          assignment: { id: existing.id, revision: nextRevision },
        };
      }
      const assignmentId = existing?.id ?? randomUUID();
      if (existing) {
        await tx
          .update(deliveryProjectAssignments)
          .set({
            engineerUserId: input.engineerUserId,
            assignedByUserId: input.actor.id,
            revision: existing.revision + 1,
            updatedAt: new Date(),
          })
          .where(eq(deliveryProjectAssignments.id, existing.id));
      } else {
        await tx.insert(deliveryProjectAssignments).values({
          id: assignmentId,
          customerUserId: input.customerUserId,
          roleType: input.roleType,
          engineerUserId: input.engineerUserId,
          assignedByUserId: input.actor.id,
        });
      }
      await writeWorkspaceAuditEvent(
        {
          actor: input.actor,
          action: "delivery.project_engineer.assigned",
          targetType: "workspace",
          targetId: input.customerUserId,
          workspaceUserId: input.customerUserId,
          metadata: {
            roleType: input.roleType,
            previousEngineerUserId: existing?.engineerUserId ?? null,
            engineerUserId: input.engineerUserId,
            projectAssignmentId: assignmentId,
          },
        },
        tx,
      );
      return {
        success: true as const,
        assignment: {
          id: assignmentId,
          revision: existing ? existing.revision + 1 : 1,
        },
      };
    });
  } catch (error) {
    if ((error as { code?: string } | null)?.code === "ER_DUP_ENTRY") {
      throw new AuthServiceError("CONFLICT", "项目团队已变化，请刷新后重试");
    }
    throw error;
  }
  return result;
}

export async function listMyProjectAssignments(actor: AuthenticatedUser) {
  if (!deliveryExecutionActorRole(actor)) {
    throw new AuthServiceError(
      "INVALID_CREDENTIAL",
      "该工作台仅对工程师或系统管理员开放",
    );
  }
  const systemAdmin = hasSystemAdminAccess(actor);
  const db = await requireDb();
  const rows = await db
    .select({
      projectAssignmentId: deliveryProjectAssignments.id,
      customerUserId: deliveryProjectAssignments.customerUserId,
      customerUsername: users.username,
      customerName: users.displayName,
      roleType: deliveryProjectAssignments.roleType,
      engineerUserId: deliveryProjectAssignments.engineerUserId,
      marketEdition: users.marketEdition,
    })
    .from(deliveryProjectAssignments)
    .innerJoin(users, eq(users.id, deliveryProjectAssignments.customerUserId))
    .where(
      and(
        systemAdmin
          ? undefined
          : eq(deliveryProjectAssignments.engineerUserId, actor.id),
        systemAdmin
          ? undefined
          : actor.engineerRoleType
            ? eq(deliveryProjectAssignments.roleType, actor.engineerRoleType)
            : sql`false`,
        eq(users.role, "user"),
        eq(users.isActive, true),
      ),
    )
    .orderBy(users.displayName, users.username);
  const contracts = rows.length
    ? await db
        .select()
        .from(serviceContracts)
        .where(
          inArray(serviceContracts.userId, [
            ...new Set(rows.map((row) => row.customerUserId)),
          ]),
        )
    : [];
  return rows
    .filter((row) => {
      const currentContract = selectPortalContract(
        contracts.filter(
          (contract) => contract.userId === row.customerUserId,
        ) as ServicePortalContractRecord[],
      );
      return deliveryRoleEnabledForCustomer({
        roleType: row.roleType,
        planCode: currentContract?.planCode,
        marketEdition: row.marketEdition,
      });
    })
    .map((row) => ({
      ...row,
      customerName:
        row.customerName ||
        row.customerUsername ||
        `客户 ${row.customerUserId}`,
      roleLabel: DELIVERY_ROLE_LABELS[row.roleType],
    }));
}

export function deliveryHistoryTimestamp(value: unknown): number {
  const timestamp =
    value instanceof Date
      ? value.getTime()
      : typeof value === "number"
        ? value
        : typeof value === "string" && value.trim()
          ? new Date(value).getTime()
          : Number.NaN;
  if (!Number.isFinite(timestamp)) {
    throw new AuthServiceError(
      "UPSTREAM_UNAVAILABLE",
      "任务记录的时间数据无效，请稍后重试",
    );
  }
  return timestamp;
}

export async function assertDeliveryProjectContext(input: {
  actor: AuthenticatedUser;
  projectAssignmentId: string;
  customerUserId?: number;
  expectedRoleType?: DeliveryRoleType;
  executor?: any;
}) {
  const actorRole = deliveryExecutionActorRole(input.actor);
  if (!actorRole) {
    throw new AuthServiceError(
      "INVALID_CREDENTIAL",
      "需要工程师或系统管理员权限",
    );
  }
  const systemAdmin = actorRole === "admin";
  const db = input.executor ?? (await requireDb());
  const rows = await db
    .select({
      projectAssignmentId: deliveryProjectAssignments.id,
      customerUserId: deliveryProjectAssignments.customerUserId,
      roleType: deliveryProjectAssignments.roleType,
      customerUsername: users.username,
      customerName: users.displayName,
      marketEdition: users.marketEdition,
    })
    .from(deliveryProjectAssignments)
    .innerJoin(users, eq(users.id, deliveryProjectAssignments.customerUserId))
    .where(
      and(
        eq(deliveryProjectAssignments.id, input.projectAssignmentId),
        systemAdmin
          ? undefined
          : eq(deliveryProjectAssignments.engineerUserId, input.actor.id),
        eq(users.role, "user"),
        eq(users.isActive, true),
      ),
    )
    .limit(1);
  const role = rows[0];
  if (
    !role ||
    (!systemAdmin && role.roleType !== input.actor.engineerRoleType) ||
    (input.expectedRoleType && role.roleType !== input.expectedRoleType)
  ) {
    throw new AuthServiceError("NOT_FOUND", "当前客户项目岗位不存在");
  }
  if (
    input.customerUserId !== undefined &&
    input.customerUserId !== role.customerUserId
  ) {
    throw new AuthServiceError("NOT_FOUND", "客户与当前项目岗位不匹配");
  }
  const contractRows = await db
    .select()
    .from(serviceContracts)
    .where(eq(serviceContracts.userId, role.customerUserId));
  const currentContract = selectPortalContract(
    contractRows as ServicePortalContractRecord[],
  );
  if (
    !deliveryRoleEnabledForCustomer({
      roleType: role.roleType,
      planCode: currentContract?.planCode,
      marketEdition: role.marketEdition,
    })
  ) {
    throw new AuthServiceError("NOT_FOUND", "当前套餐未启用该工程师岗位");
  }
  return {
    ...role,
    customerName:
      role.customerName ||
      role.customerUsername ||
      `客户 ${role.customerUserId}`,
  };
}

export function formalMonitoringBatchOptionsScope(input: {
  userId: number;
  scopes: Array<{ contractId: string; quotaPeriodId: string }>;
}) {
  return and(
    eq(monitoringBatches.userId, input.userId),
    or(
      ...input.scopes.map((scope) =>
        and(
          eq(monitoringBatches.contractId, scope.contractId),
          eq(monitoringBatches.quotaPeriodId, scope.quotaPeriodId),
        ),
      ),
    ),
    gt(monitoringBatches.sampleCount, 0),
  );
}

export async function listFormalMonitoringBatchOptions(input: {
  executor: any;
  userId: number;
  activeQuotaSelection?: ActiveDeliveryQuotaSelection | null;
}) {
  const activeQuotaSelection =
    input.activeQuotaSelection === undefined
      ? await resolveActiveDeliveryQuotaScopes({
          executor: input.executor,
          userId: input.userId,
        })
      : input.activeQuotaSelection;
  if (!activeQuotaSelection) return [];
  const activeScopes = effectiveActiveDeliveryQuotaScopes(activeQuotaSelection);
  if (!activeScopes.length) return [];
  const rows = await input.executor
    .select({
      batchKey: monitoringBatches.batchKey,
      sourceName: monitoringBatches.sourceName,
      collectedAt: monitoringBatches.collectedAt,
      sampleCount: monitoringBatches.sampleCount,
    })
    .from(monitoringBatches)
    .where(
      formalMonitoringBatchOptionsScope({
        userId: input.userId,
        scopes: activeScopes.map((scope) => ({
          contractId: scope.contract.id,
          quotaPeriodId: scope.period.id,
        })),
      }),
    )
    .orderBy(desc(monitoringBatches.collectedAt), desc(monitoringBatches.id));
  const seenBatchKeys = new Set<string>();
  return rows.flatMap(
    (row: {
      batchKey: string;
      sourceName: string;
      collectedAt: unknown;
      sampleCount: number;
    }) => {
      if (seenBatchKeys.has(row.batchKey)) return [];
      seenBatchKeys.add(row.batchKey);
      return [
        {
          batchKey: row.batchKey,
          sourceName: row.sourceName,
          collectedAt: deliveryHistoryTimestamp(row.collectedAt),
          sampleCount: row.sampleCount,
        },
      ];
    },
  );
}

export async function getMyDeliveryWorkbench(input: {
  actor: AuthenticatedUser;
  projectAssignmentId: string;
}) {
  const role = await assertDeliveryProjectContext(input);
  const db = await requireDb();
  const customerIds = [role.customerUserId];
  const activeQuotaSelection = await resolveActiveDeliveryQuotaScopes({
    executor: db,
    userId: role.customerUserId,
  });
  const questionScopes = activeQuotaSelection
    ? effectiveActiveDeliveryQuotaScopes(activeQuotaSelection).map(
        deliveryQuestionWorkflowScope,
      )
    : [];
  const [
    customers,
    questions,
    dashboards,
    knowledgeProgress,
    knowledgeSnapshot,
    questionQuota,
    servicePortal,
    brandTrackingUsage,
    formalMonitoringBatches,
  ] = await Promise.all([
    customerIds.length
      ? db
          .select({
            id: users.id,
            username: users.username,
            displayName: users.displayName,
            marketEdition: users.marketEdition,
          })
          .from(users)
          .where(inArray(users.id, customerIds))
      : [],
    customerIds.length && questionScopes.length
      ? db
          .select({
            id: workspaceQuestions.id,
            userId: workspaceQuestions.userId,
            externalQuestionId: workspaceQuestions.externalQuestionId,
            sourceQuestionId: workspaceQuestions.sourceQuestionId,
            candidateKey: workspaceQuestions.candidateKey,
            category: workspaceQuestions.category,
            question: workspaceQuestions.question,
            intent: workspaceQuestions.intent,
            rationale: workspaceQuestions.rationale,
            source: workspaceQuestions.source,
            status: workspaceQuestions.status,
            selectionApprovalStatus: workspaceQuestions.selectionApprovalStatus,
            selectionRequestedAt: workspaceQuestions.selectionRequestedAt,
            locked: workspaceQuestions.locked,
            revision: workspaceQuestions.revision,
          })
          .from(workspaceQuestions)
          .where(
            and(
              inArray(workspaceQuestions.userId, customerIds),
              workspaceQuestionDeliveryScopesCondition(questionScopes),
            ),
          )
      : [],
    customerIds.length
      ? db
          .select({
            userId: userDashboardContents.userId,
            payload: userDashboardContents.payload,
            revision: userDashboardContents.revision,
            sourceName: userDashboardContents.sourceName,
            updatedAt: userDashboardContents.updatedAt,
          })
          .from(userDashboardContents)
          .where(inArray(userDashboardContents.userId, customerIds))
      : [],
    role.roleType === "ai_operations_engineer"
      ? getKnowledgeBaseProgress({ userId: role.customerUserId })
      : null,
    role.roleType === "ai_operations_engineer"
      ? getLatestKnowledgeSnapshot(role.customerUserId)
      : null,
    role.roleType === "monitoring_optimization_engineer"
      ? getQuestionQuotaState({
          executor: db,
          customerUserId: role.customerUserId,
        })
      : null,
    getServicePortal(role.customerUserId),
    role.roleType === "ai_operations_engineer" &&
    role.marketEdition === "overseas"
      ? getJenovaBrandTrackingUsageForProject({
          actor: input.actor,
          projectAssignmentId: input.projectAssignmentId,
        })
      : null,
    role.roleType === "monitoring_optimization_engineer"
      ? listFormalMonitoringBatchOptions({
          executor: db,
          userId: role.customerUserId,
          activeQuotaSelection,
        })
      : [],
  ]);
  const dashboardRecord = dashboards.find(
    (dashboard) => dashboard.userId === role.customerUserId,
  );
  const authoritativeQuestionIds = questions
    .filter(
      (question) =>
        question.status === "selected" &&
        question.selectionApprovalStatus === "approved" &&
        Boolean(question.category),
    )
    .map((question) => question.id);
  const responseLogicRecords =
    role.roleType === "monitoring_optimization_engineer" &&
    authoritativeQuestionIds.length
      ? (
          await listResponseLogicEntriesByQuestionIds(
            role.customerUserId,
            authoritativeQuestionIds,
          )
        ).flatMap((record) =>
          record.confirmed
            ? [
                {
                  ...record,
                  // The embedded delivery view is read-only. Never expose a
                  // newer unpublished draft alongside the confirmed version.
                  draft: record.confirmed,
                },
              ]
            : [],
        )
      : [];
  const parsedDashboard = dashboardRecord
    ? dashboardPayloadSchema.safeParse(dashboardRecord.payload)
    : null;
  return {
    assignment: role,
    customers,
    customerQuestions: questions.map((question) => ({
      ...question,
      category: questionCategoryForPublic(question),
      selectionRequestedAt: question.selectionRequestedAt?.getTime?.() ?? null,
    })),
    responseLogicRecords,
    dashboard:
      dashboardRecord && parsedDashboard?.success
        ? {
            payload: parsedDashboard.data,
            revision: dashboardRecord.revision,
            sourceName: dashboardRecord.sourceName,
            updatedAt: dashboardRecord.updatedAt.getTime(),
          }
        : null,
    aiOperationsPreview:
      role.roleType === "ai_operations_engineer"
        ? {
            knowledgeProgress: toKnowledgeBasePublicPayload(knowledgeProgress),
            knowledgeSnapshot,
          }
        : null,
    questionQuota,
    servicePortal,
    monitoringBatches: formalMonitoringBatches,
    brandTrackingUsage: brandTrackingUsage?.usage ?? null,
  };
}

export async function getMyCustomerBrandTrackingUsage(input: {
  actor: AuthenticatedUser;
  projectAssignmentId: string;
}) {
  return getJenovaBrandTrackingUsageForProject(input);
}

export async function updateMyCustomerBrandTrackingLimit(input: {
  actor: AuthenticatedUser;
  projectAssignmentId: string;
  limit: string;
}) {
  const result = await updateJenovaBrandTrackingLimit(input);
  return { success: true as const, ...result };
}

export async function setDeliveryMemberCredential(input: {
  actor: AuthenticatedUser;
  memberUserId: number;
  apiKey: string;
  expectedVersion: number;
}) {
  requireDeliveryManager(input.actor);
  requireSystemAdminCredentialManagement(input.actor);
  await validateUpstreamApiKey(input.apiKey);
  const db = await requireDb();
  return db.transaction(async (tx) => {
    const scope = await requireEngineerCredentialManagement({
      executor: tx,
      actor: input.actor,
      engineerUserId: input.memberUserId,
    });
    const credentialRows = await tx
      .select()
      .from(apiCredentials)
      .where(eq(apiCredentials.userId, input.memberUserId))
      .orderBy(desc(apiCredentials.version))
      .limit(1)
      .for("update");
    const latest = credentialRows[0];
    const previous = latest?.status === "active" ? latest : undefined;
    const actualVersion = latest?.version ?? 0;
    assertDeliveryMemberCredentialVersion({
      actualVersion,
      expectedVersion: input.expectedVersion,
    });
    const credential = await replaceApiCredentialInTransaction({
      executor: tx,
      userId: input.memberUserId,
      apiKey: input.apiKey,
      agentProfile: null,
    });
    await writeWorkspaceAuditEvent(
      {
        actor: input.actor,
        action: "delivery.engineer_credential.replaced",
        targetType: "user",
        targetId: input.memberUserId,
        workspaceUserId: null,
        metadata: {
          previouslyConfigured: Boolean(previous),
          previousVersion: actualVersion,
          credentialVersion: credential.version,
          configured: credential.configured,
          managerAdminIds: scope.managerAdminIds,
          affectedCustomerUserIds: scope.customerUserIds,
        },
      },
      tx,
    );
    return credential;
  });
}

export async function revokeDeliveryMemberCredential(input: {
  actor: AuthenticatedUser;
  memberUserId: number;
  expectedVersion: number;
}) {
  requireDeliveryManager(input.actor);
  requireSystemAdminCredentialManagement(input.actor);
  const fence = await acquireActiveApiCredentialDeletionFence(
    input.memberUserId,
  );
  if (!fence) {
    throw new AuthServiceError("CONFLICT", "工程师 API Key 尚未配置");
  }
  const db = await requireDb();
  const stopFenceHeartbeat =
    startActiveApiCredentialDeletionFenceHeartbeat(fence);
  let transactionCommitted = false;
  try {
    const result = await db.transaction(async (tx) => {
      const scope = await requireEngineerCredentialManagement({
        executor: tx,
        actor: input.actor,
        engineerUserId: input.memberUserId,
      });
      const credentialRows = await tx
        .select()
        .from(apiCredentials)
        .where(eq(apiCredentials.userId, input.memberUserId))
        .orderBy(desc(apiCredentials.version))
        .limit(1)
        .for("update");
      const latest = credentialRows[0];
      const previous = latest?.status === "active" ? latest : undefined;
      const actualVersion = latest?.version ?? 0;
      assertDeliveryMemberCredentialVersion({
        actualVersion,
        expectedVersion: input.expectedVersion,
      });
      if (!previous) {
        throw new AuthServiceError("CONFLICT", "工程师 API Key 尚未配置");
      }
      const deletion = await deleteActiveApiCredentialInTransaction({
        executor: tx,
        userId: input.memberUserId,
        fenceToken: fence,
      });
      await writeWorkspaceAuditEvent(
        {
          actor: input.actor,
          action: "delivery.engineer_credential.revoked",
          targetType: "user",
          targetId: input.memberUserId,
          workspaceUserId: null,
          metadata: {
            previouslyConfigured: Boolean(previous),
            previousVersion: actualVersion,
            credentialVersion: deletion.version,
            configured: false,
            managerAdminIds: scope.managerAdminIds,
            affectedCustomerUserIds: scope.customerUserIds,
          },
        },
        tx,
      );
      return { success: true as const };
    });
    transactionCommitted = true;
    await stopFenceHeartbeat();
    await completeActiveApiCredentialDeletionFence(fence);
    return result;
  } catch (error) {
    await stopFenceHeartbeat().catch(() => undefined);
    if (!transactionCommitted) {
      await rollbackActiveApiCredentialDeletionFence(fence).catch(
        () => undefined,
      );
    }
    throw error;
  }
}

async function requireDeliveryAdminCredentialTarget(input: {
  executor: any;
  adminUserId: number;
}) {
  const rows = await input.executor
    .select({
      id: users.id,
      role: users.role,
      adminAccessLevel: users.adminAccessLevel,
    })
    .from(users)
    .where(eq(users.id, input.adminUserId))
    .limit(1)
    .for("update");
  const target = rows[0];
  if (
    !target ||
    target.role !== "admin" ||
    target.adminAccessLevel !== "delivery_admin"
  ) {
    throw new AuthServiceError("NOT_FOUND", "交付管理员不存在");
  }
  return target;
}

export async function setDeliveryAdminCredential(input: {
  actor: AuthenticatedUser;
  adminUserId: number;
  apiKey: string;
  expectedVersion: number;
}) {
  requireDeliveryManager(input.actor);
  requireSystemAdminCredentialManagement(input.actor);
  await validateUpstreamApiKey(input.apiKey);
  const db = await requireDb();
  return db.transaction(async (tx) => {
    await requireDeliveryAdminCredentialTarget({
      executor: tx,
      adminUserId: input.adminUserId,
    });
    const credentialRows = await tx
      .select()
      .from(apiCredentials)
      .where(eq(apiCredentials.userId, input.adminUserId))
      .orderBy(desc(apiCredentials.version))
      .limit(1)
      .for("update");
    const latest = credentialRows[0];
    const actualVersion = latest?.version ?? 0;
    if (actualVersion !== input.expectedVersion) {
      throw new AuthServiceError(
        "CONFLICT",
        "交付管理员 API Key 状态已变化，请刷新后重试",
      );
    }
    const credential = await replaceApiCredentialInTransaction({
      executor: tx,
      userId: input.adminUserId,
      apiKey: input.apiKey,
      agentProfile: null,
    });
    await writeWorkspaceAuditEvent(
      {
        actor: input.actor,
        action: "delivery.admin_credential.replaced",
        targetType: "user",
        targetId: input.adminUserId,
        workspaceUserId: null,
        metadata: {
          previouslyConfigured: latest?.status === "active",
          previousVersion: actualVersion,
          credentialVersion: credential.version,
          configured: credential.configured,
        },
      },
      tx,
    );
    return credential;
  });
}

export async function revokeDeliveryAdminCredential(input: {
  actor: AuthenticatedUser;
  adminUserId: number;
  expectedVersion: number;
}) {
  requireDeliveryManager(input.actor);
  requireSystemAdminCredentialManagement(input.actor);
  const fence = await acquireActiveApiCredentialDeletionFence(
    input.adminUserId,
  );
  if (!fence) {
    throw new AuthServiceError("CONFLICT", "交付管理员 API Key 尚未配置");
  }
  const db = await requireDb();
  const stopFenceHeartbeat =
    startActiveApiCredentialDeletionFenceHeartbeat(fence);
  let transactionCommitted = false;
  try {
    const result = await db.transaction(async (tx) => {
      await requireDeliveryAdminCredentialTarget({
        executor: tx,
        adminUserId: input.adminUserId,
      });
      const credentialRows = await tx
        .select()
        .from(apiCredentials)
        .where(eq(apiCredentials.userId, input.adminUserId))
        .orderBy(desc(apiCredentials.version))
        .limit(1)
        .for("update");
      const latest = credentialRows[0];
      const actualVersion = latest?.version ?? 0;
      if (actualVersion !== input.expectedVersion) {
        throw new AuthServiceError(
          "CONFLICT",
          "交付管理员 API Key 状态已变化，请刷新后重试",
        );
      }
      if (latest?.status !== "active") {
        throw new AuthServiceError("CONFLICT", "交付管理员 API Key 尚未配置");
      }
      const deletion = await deleteActiveApiCredentialInTransaction({
        executor: tx,
        userId: input.adminUserId,
        fenceToken: fence,
      });
      await writeWorkspaceAuditEvent(
        {
          actor: input.actor,
          action: "delivery.admin_credential.revoked",
          targetType: "user",
          targetId: input.adminUserId,
          workspaceUserId: null,
          metadata: {
            previouslyConfigured: true,
            previousVersion: actualVersion,
            credentialVersion: deletion.version,
            configured: false,
          },
        },
        tx,
      );
      return { success: true as const };
    });
    transactionCommitted = true;
    await stopFenceHeartbeat();
    await completeActiveApiCredentialDeletionFence(fence);
    return result;
  } catch (error) {
    await stopFenceHeartbeat().catch(() => undefined);
    if (!transactionCommitted) {
      await rollbackActiveApiCredentialDeletionFence(fence).catch(
        () => undefined,
      );
    }
    throw error;
  }
}
