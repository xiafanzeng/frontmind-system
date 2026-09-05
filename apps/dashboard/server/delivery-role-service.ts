import { createHash, randomUUID } from "node:crypto";
import {
  and,
  asc,
  count,
  desc,
  eq,
  gte,
  gt,
  inArray,
  isNotNull,
  isNull,
  lt,
  lte,
  or,
  sql,
} from "drizzle-orm";

import {
  apiCredentials,
  deliveryMemberOrigins,
  deliveryProjectAssignments,
  deliveryTicketAttachments,
  deliveryTicketEvents,
  deliveryTickets,
  deliveryWorkflowMilestones,
  knowledgeBaseResetRequests,
  knowledgeBaseBuilds,
  knowledgeBaseSnapshots,
  monitoringBatches,
  monitoringSamples,
  responseLogicEntries,
  serviceContracts,
  serviceQuotaPeriods,
  siteOperations,
  upstreamResources,
  userAdminAssignments,
  userDashboardContents,
  userUsageOwners,
  users,
  workspaceQuestions,
  workspaceSiteChecks,
  workspaceSiteProfiles,
  websiteStyleSampleBatches,
  websiteStyleSamples,
  websiteStyleWorkflows,
} from "../drizzle/schema";
import {
  DELIVERY_ROLE_LABELS,
  deliveryOperationTriggersMonitoringRetest,
  deliveryRoleOwnsOperation,
  deliveryWorkflowOperationSchema,
  type DeliveryRoleType,
} from "../shared/delivery-roles";
import { hasExplicitAdminRole } from "../shared/admin-access";
import { dashboardPayloadSchema } from "../shared/dashboard";
import { contentAssetMediaOptionsForMarketEdition } from "../shared/delivery-catalog";
import {
  deliveryOperationAllowedEvidence,
  getDeliveryOperationSpec,
} from "../shared/delivery-operation-spec";
import { deliveryTicketPresentationTitle } from "../shared/delivery-ticket-presentation";
import { deliverySummaryLooksLikeCredentialSecret } from "../shared/delivery-ticket-security";
import type { WorkspaceQuestionCategory } from "../shared/service-portal";
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
import {
  assertExistingDeliveryTicketSettlementScope,
  deriveTicketQuotaTransition,
  DeliveryTicketError,
  getDeliveryTicketWorkspace,
} from "./delivery-ticket-service";
import { getKnowledgeBaseProgress } from "./knowledge-base-progress-service";
import { toKnowledgeBasePublicPayload } from "./knowledge-base-public-projection";
import {
  approveSiteOpsRebuildTicket,
  projectSiteOpsRebuildReset,
  siteOpsRebuildResetApplied,
  siteOpsRebuildResetOperationId,
  siteOpsRebuildResetPending,
  type SiteOpsRebuildResetProjection,
  type SiteOpsRebuildResetState,
  SiteOpsRebuildTicketError,
} from "./siteops/rebuild-ticket";
import { getQuestionQuotaState } from "./question-quota-service";
import { questionCategoryForPublic } from "./question-selection-policy";
import { listResponseLogicEntriesByQuestionIds } from "./response-logic-service";
import {
  SERVICE_QUESTION_QUOTA_ANCHOR_ORDINAL,
  approveWorkspaceQuestionSelection,
  deriveEffectiveServiceStatus,
  getServicePortal,
  isOperationalServiceQuotaPeriod,
  isProgressiveLuxuryContract,
  resolveCurrentServiceQuotaScope,
  ServiceEntitlementError,
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

async function getActiveDeliveryProjectOwner(
  executor: any,
  customerUserId: number,
  roleType: DeliveryRoleType,
) {
  const rows = await executor
    .select({
      projectAssignmentId: deliveryProjectAssignments.id,
      engineerUserId: deliveryProjectAssignments.engineerUserId,
    })
    .from(deliveryProjectAssignments)
    .innerJoin(users, eq(users.id, deliveryProjectAssignments.engineerUserId))
    .where(
      and(
        eq(deliveryProjectAssignments.customerUserId, customerUserId),
        eq(deliveryProjectAssignments.roleType, roleType),
        eq(users.role, "delivery_member"),
        eq(users.engineerRoleType, roleType),
        eq(users.isActive, true),
      ),
    )
    .limit(1)
    .for("update");
  return rows[0] ?? null;
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
  const statisticsTickets = customerIds.length
    ? await db
        .select()
        .from(deliveryTickets)
        .where(inArray(deliveryTickets.userId, customerIds))
        .orderBy(desc(deliveryTickets.updatedAt))
    : [];
  const publicTickets = statisticsTickets
    .map((ticket) => ({
      ...ticket,
      managementStatus: deliveryTicketStatusGroup(ticket.status),
    }))
    .filter(
      (
        ticket,
      ): ticket is typeof ticket & {
        managementStatus: "pending" | "completed";
      } => ticket.managementStatus !== null,
    );
  const activeTickets = publicTickets.filter(
    (ticket) => ticket.managementStatus === "pending",
  );
  const completedTickets = statisticsTickets.filter(
    (ticket) => ticket.status === "completed",
  );
  const terminalTickets = publicTickets.filter(
    (ticket) => ticket.managementStatus === "completed",
  );
  const dispatchTicketIds = activeTickets.map((ticket) => ticket.id);
  const ticketEvents = dispatchTicketIds.length
    ? await db
        .select({
          id: deliveryTicketEvents.id,
          ticketId: deliveryTicketEvents.ticketId,
          actorUserId: deliveryTicketEvents.actorUserId,
          actorRole: deliveryTicketEvents.actorRole,
          kind: deliveryTicketEvents.kind,
          message: deliveryTicketEvents.message,
          fromStatus: deliveryTicketEvents.fromStatus,
          toStatus: deliveryTicketEvents.toStatus,
          createdAt: deliveryTicketEvents.createdAt,
        })
        .from(deliveryTicketEvents)
        .where(inArray(deliveryTicketEvents.ticketId, dispatchTicketIds))
        .orderBy(desc(deliveryTicketEvents.createdAt))
    : [];
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
  const roleStats = Object.fromEntries(
    (
      [
        "ai_operations_engineer",
        "monitoring_optimization_engineer",
        "content_distribution_engineer",
      ] as const
    ).map((roleType) => {
      const rows = statisticsTickets.filter(
        (ticket) => ticket.workflowDomain === roleType,
      );
      const activeRows = rows.filter((ticket) =>
        ACTIVE_DELIVERY_STATUSES.includes(ticket.status as any),
      );
      const overdueCutoff = Date.now() - 72 * 60 * 60 * 1000;
      return [
        roleType,
        {
          pendingAssignment: activeRows.filter(
            (ticket) => ticket.assignedMemberId == null,
          ).length,
          processing: activeRows.filter(
            (ticket) =>
              ticket.assignedMemberId != null &&
              ["submitted", "scheduled", "in_progress"].includes(ticket.status),
          ).length,
          waitingUser: activeRows.filter(
            (ticket) => ticket.status === "needs_information",
          ).length,
          overdue: activeRows.filter(
            (ticket) => ticket.updatedAt.getTime() < overdueCutoff,
          ).length,
          completed: rows.filter((ticket) => ticket.status === "completed")
            .length,
        },
      ];
    }),
  ) as Record<
    DeliveryRoleType,
    {
      pendingAssignment: number;
      processing: number;
      waitingUser: number;
      overdue: number;
      completed: number;
    }
  >;
  return {
    projects,
    assignments,
    engineers: enrichedEngineers,
    tickets: activeTickets,
    completedTickets,
    terminalTickets,
    ticketEvents,
    roleStats,
  };
}

const ACTIVE_DELIVERY_STATUSES = [
  "submitted",
  "needs_information",
  "scheduled",
  "in_progress",
] as const;

export function deliveryExecutionActorRole(
  actor: Pick<AuthenticatedUser, "role" | "username" | "adminAccessLevel">,
) {
  if (hasSystemAdminAccess(actor)) return "admin" as const;
  if (actor.role === "delivery_member") return "delivery_member" as const;
  return null;
}

function deliveryRoleTicketScope(actor: AuthenticatedUser) {
  return hasSystemAdminAccess(actor)
    ? and(
        isNotNull(deliveryTickets.workflowDomain),
        isNotNull(deliveryTickets.assignedProjectAssignmentId),
      )
    : eq(deliveryTickets.assignedMemberId, actor.id);
}

export const MY_DELIVERY_TICKET_LIMIT = 50;

const INITIAL_MONITORING_DEPENDENCY_MESSAGE =
  "请先完成“配置品牌词库”并确认至少一条优化问题，随后才能开始首次监控。";

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

function selectActiveDeliveryQuotaScope(input: {
  selection: ActiveDeliveryQuotaSelection;
  record?: { contractId: string; quotaPeriodId: string } | null;
}) {
  const scopes = effectiveActiveDeliveryQuotaScopes(input.selection);
  if (input.record) {
    const exact = findActiveDeliveryQuotaScope({
      selection: input.selection,
      record: input.record,
    });
    if (exact) return exact;
  }
  return (
    scopes.find(
      (scope) => scope.contract.id === input.selection.primaryContract.id,
    ) ??
    scopes[0] ??
    null
  );
}

function findActiveDeliveryQuotaScope(input: {
  selection: ActiveDeliveryQuotaSelection;
  record: { contractId: string; quotaPeriodId: string };
}) {
  return effectiveActiveDeliveryQuotaScopes(input.selection).find((scope) =>
    isProgressiveLuxuryContract(scope.contract)
      ? scope.contract.id === input.record.contractId
      : scope.contract.id === input.record.contractId &&
        scope.period.id === input.record.quotaPeriodId,
  );
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

export function deliveryQuestionWorkflowScopeKey(input: {
  progressiveLuxury: boolean;
  contractId: string;
  quotaPeriodId: string;
}) {
  return input.progressiveLuxury
    ? `contract:${input.contractId}`
    : `period:${input.quotaPeriodId}`;
}

export function deliveryWorkflowMilestoneIsReusable(input: {
  completedAt: Date;
  startsAt: Date;
  endsAt: Date;
}) {
  const completedAt = input.completedAt.getTime();
  return (
    input.startsAt.getTime() <= completedAt &&
    completedAt < input.endsAt.getTime()
  );
}

export function questionCatalogReviewAllowed(input: {
  progressiveLuxury: boolean;
  hasActiveCatalog: boolean;
  hasCompletedCatalog: boolean;
  hasReusableCatalogMilestone: boolean;
}) {
  return (
    input.hasActiveCatalog ||
    input.hasCompletedCatalog ||
    input.hasReusableCatalogMilestone
  );
}

function deliveryTicketQuestionScopeCondition(
  scope: DeliveryQuestionWorkflowScope,
) {
  return scope.progressiveLuxury
    ? eq(deliveryTickets.contractId, scope.contractId)
    : eq(deliveryTickets.quotaPeriodId, scope.quotaPeriodId);
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

function deliveryRecordMatchesQuestionWorkflowScope(
  record: { contractId: string; quotaPeriodId: string },
  scope: DeliveryQuestionWorkflowScope,
) {
  return scope.progressiveLuxury
    ? record.contractId === scope.contractId
    : record.quotaPeriodId === scope.quotaPeriodId;
}

function deliveryWorkflowMilestoneScopeCondition(
  scope: DeliveryQuestionWorkflowScope,
) {
  return and(
    gte(deliveryWorkflowMilestones.completedAt, scope.startsAt),
    lt(deliveryWorkflowMilestones.completedAt, scope.endsAt),
  );
}

async function resolveDeliveryTicketQuestionWorkflowScope(input: {
  executor: any;
  ticket: Pick<
    typeof deliveryTickets.$inferSelect,
    "userId" | "contractId" | "quotaPeriodId"
  >;
}) {
  const [contractRows, periodRows] = await Promise.all([
    input.executor
      .select({
        id: serviceContracts.id,
        planCode: serviceContracts.planCode,
        planVersion: serviceContracts.planVersion,
        startsAt: serviceContracts.startsAt,
        endsAt: serviceContracts.endsAt,
      })
      .from(serviceContracts)
      .where(
        and(
          eq(serviceContracts.id, input.ticket.contractId),
          eq(serviceContracts.userId, input.ticket.userId),
        ),
      )
      .limit(1),
    input.executor
      .select({
        id: serviceQuotaPeriods.id,
        contractId: serviceQuotaPeriods.contractId,
        startsAt: serviceQuotaPeriods.startsAt,
        endsAt: serviceQuotaPeriods.endsAt,
      })
      .from(serviceQuotaPeriods)
      .where(
        and(
          eq(serviceQuotaPeriods.id, input.ticket.quotaPeriodId),
          eq(serviceQuotaPeriods.userId, input.ticket.userId),
          eq(serviceQuotaPeriods.contractId, input.ticket.contractId),
        ),
      )
      .limit(1),
  ]);
  const contract = contractRows[0];
  const period = periodRows[0];
  if (!contract || !period) return null;
  const progressiveLuxury = isProgressiveLuxuryContract(contract);
  return {
    progressiveLuxury,
    contractId: contract.id,
    quotaPeriodId: period.id,
    startsAt: progressiveLuxury ? contract.startsAt : period.startsAt,
    endsAt: progressiveLuxury ? contract.endsAt : period.endsAt,
  } satisfies DeliveryQuestionWorkflowScope;
}

export function deliveryTicketActionRank(status: string) {
  switch (status) {
    case "in_progress":
      return 0;
    case "submitted":
      return 1;
    case "scheduled":
      return 2;
    case "needs_information":
      return 3;
    default:
      return 4;
  }
}

export function deliveryTicketDependencyState(input: {
  operation: string | null;
  status: string;
  hasCompletedQuestionCatalog: boolean;
  hasApprovedQuestion: boolean;
}) {
  const blocked =
    input.operation === "initial_monitoring" &&
    ACTIVE_DELIVERY_STATUSES.includes(input.status as any) &&
    (!input.hasCompletedQuestionCatalog || !input.hasApprovedQuestion);
  return {
    dependencySatisfied: !blocked,
    dependencyBlockReason: blocked
      ? INITIAL_MONITORING_DEPENDENCY_MESSAGE
      : null,
  };
}

export function deliveryTicketStatusGroup(status: string) {
  return ACTIVE_DELIVERY_STATUSES.includes(status as any)
    ? ("pending" as const)
    : (["completed", "rejected", "cancelled"] as const).includes(status as any)
      ? ("completed" as const)
      : null;
}

export function knowledgeMonitoringHandoffOperations() {
  return ["question_catalog"] as const;
}

export function knowledgeMonitoringHandoffReusableTicketStatuses() {
  return [...ACTIVE_DELIVERY_STATUSES, "completed"] as const;
}

export function visibleInitialMonitoringTicketScope() {
  return sql<boolean>`(
    ${deliveryTickets.operation} IS NULL
    OR ${deliveryTickets.operation} <> 'initial_monitoring'
    OR ${deliveryTickets.status} NOT IN ('submitted', 'needs_information', 'scheduled', 'in_progress')
    OR (
      EXISTS (
        SELECT 1
        FROM service_contracts AS dependency_contract
        WHERE dependency_contract.id = ${deliveryTickets.contractId}
          AND dependency_contract.planCode = 'luxury'
          AND dependency_contract.planVersion >= 2
          AND (
            EXISTS (
              SELECT 1
              FROM delivery_tickets AS completed_catalog
              WHERE completed_catalog.userId = ${deliveryTickets.userId}
                AND completed_catalog.contractId = ${deliveryTickets.contractId}
                AND completed_catalog.operation = 'question_catalog'
                AND completed_catalog.status = 'completed'
            )
            OR EXISTS (
              SELECT 1
              FROM delivery_workflow_milestones AS archived_catalog
              WHERE archived_catalog.userId = ${deliveryTickets.userId}
                AND archived_catalog.operation = 'question_catalog'
                AND archived_catalog.completedAt >= dependency_contract.startsAt
                AND archived_catalog.completedAt < dependency_contract.endsAt
            )
          )
          AND EXISTS (
            SELECT 1
            FROM workspace_questions AS approved_question
            WHERE approved_question.userId = ${deliveryTickets.userId}
              AND approved_question.contractId = ${deliveryTickets.contractId}
              AND approved_question.status = 'selected'
              AND approved_question.selectionApprovalStatus = 'approved'
          )
      )
      OR EXISTS (
        SELECT 1
        FROM service_quota_periods AS dependency_period
        WHERE dependency_period.id = ${deliveryTickets.quotaPeriodId}
          AND NOT EXISTS (
            SELECT 1
            FROM service_contracts AS progressive_contract
            WHERE progressive_contract.id = ${deliveryTickets.contractId}
              AND progressive_contract.planCode = 'luxury'
              AND progressive_contract.planVersion >= 2
          )
          AND (
            EXISTS (
              SELECT 1
              FROM delivery_tickets AS completed_catalog
              WHERE completed_catalog.userId = ${deliveryTickets.userId}
                AND completed_catalog.quotaPeriodId = ${deliveryTickets.quotaPeriodId}
                AND completed_catalog.operation = 'question_catalog'
                AND completed_catalog.status = 'completed'
            )
            OR EXISTS (
              SELECT 1
              FROM delivery_workflow_milestones AS archived_catalog
              WHERE archived_catalog.userId = ${deliveryTickets.userId}
                AND archived_catalog.operation = 'question_catalog'
            )
          )
          AND EXISTS (
            SELECT 1
            FROM workspace_questions AS approved_question
            WHERE approved_question.userId = ${deliveryTickets.userId}
              AND approved_question.quotaPeriodId = ${deliveryTickets.quotaPeriodId}
              AND approved_question.status = 'selected'
              AND approved_question.selectionApprovalStatus = 'approved'
          )
      )
    )
  )`;
}

export function reusableInitialMonitoringTicketScope(input: {
  userId: number;
  scope?: DeliveryQuestionWorkflowScope;
}) {
  return and(
    eq(deliveryTickets.userId, input.userId),
    eq(deliveryTickets.operation, "initial_monitoring"),
    input.scope ? deliveryTicketQuestionScopeCondition(input.scope) : undefined,
    inArray(deliveryTickets.status, [...ACTIVE_DELIVERY_STATUSES, "completed"]),
  );
}

export function initialMonitoringExistingTicketAction(input: {
  status: string;
  ticketQuotaPeriodId: string;
  sourceQuotaPeriodId: string;
  dependencySatisfied: boolean;
}) {
  if (
    input.status === "completed" ||
    input.ticketQuotaPeriodId === input.sourceQuotaPeriodId ||
    input.dependencySatisfied
  ) {
    return "reuse" as const;
  }
  return "replace_stale" as const;
}

const EMPTY_DELIVERY_SITE_REBUILD_RESET_PROJECTION = {
  siteRebuildResetState: null,
  siteRebuildResetIssue: null,
  siteRebuildCanRecheck: false,
} as const satisfies SiteOpsRebuildResetProjection;

type DeliverySiteRebuildTicketCoordinate = Pick<
  typeof deliveryTickets.$inferSelect,
  "id" | "userId" | "operation" | "internalNote"
>;

type DeliverySiteRebuildOperationCoordinate = Parameters<
  typeof projectSiteOpsRebuildReset
>[0]["operation"];

function deliverySiteRebuildResetProjection(
  ticket: DeliverySiteRebuildTicketCoordinate,
  operationById: ReadonlyMap<
    string,
    NonNullable<DeliverySiteRebuildOperationCoordinate>
  >,
) {
  if (ticket.operation !== "site_rebuild") {
    return EMPTY_DELIVERY_SITE_REBUILD_RESET_PROJECTION;
  }
  const operationId = siteOpsRebuildResetOperationId(ticket.internalNote);
  return projectSiteOpsRebuildReset({
    ticketId: ticket.id,
    userId: ticket.userId,
    internalNote: ticket.internalNote,
    operation: operationId ? operationById.get(operationId) : null,
  });
}

async function loadDeliverySiteRebuildResetOperations(
  executor: any,
  tickets: DeliverySiteRebuildTicketCoordinate[],
) {
  const operationIds = Array.from(
    new Set(
      tickets.flatMap((ticket) => {
        if (ticket.operation !== "site_rebuild") return [];
        const operationId = siteOpsRebuildResetOperationId(ticket.internalNote);
        return operationId ? [operationId] : [];
      }),
    ),
  );
  if (operationIds.length === 0) {
    return new Map<
      string,
      NonNullable<DeliverySiteRebuildOperationCoordinate>
    >();
  }
  const rows = await executor
    .select({
      id: siteOperations.id,
      projectId: siteOperations.projectId,
      userId: siteOperations.userId,
      kind: siteOperations.kind,
      provider: siteOperations.provider,
      status: siteOperations.status,
      input: siteOperations.input,
      result: siteOperations.result,
      errorCode: siteOperations.errorCode,
      attempt: siteOperations.attempt,
      providerOperationId: siteOperations.providerOperationId,
      providerTaskId: siteOperations.providerTaskId,
    })
    .from(siteOperations)
    .where(inArray(siteOperations.id, operationIds));
  return new Map<string, NonNullable<DeliverySiteRebuildOperationCoordinate>>(
    rows.map((row: any) => [row.id, row] as const),
  );
}

type ReconciledDeliveryTicketTerminal = {
  status: "completed" | "cancelled";
  publicSummary: string;
  quotaState: "reserved" | "consumed" | "released";
  quotaReleasedAt: Date | null;
  technicalDedupeKey: null;
  resolvedAt: Date;
  revision: number;
  updatedAt: Date;
};

const SITE_REBUILD_COMPLETED_SUMMARY =
  "官网重置已完成，企业知识库保持不变；客户可从知识库开始建站。";
const SITE_REBUILD_INVALIDATED_SUMMARY =
  "原官网重置申请已失效，项目状态已变化；请客户重新提交重置申请。";

/**
 * Repairs only a historical presentation gap: the reset note and its exact
 * operation either prove the fresh-root transaction completed or prove the
 * pinned coordinates became invalid. This never calls a provider or mutates
 * the SiteOps project. Each terminal class is repaired through one bounded,
 * revision-bound CAS statement.
 */
export async function reconcileTerminalSiteRebuildTickets(input: {
  executor: any;
  actorUserId: number;
  tickets: Array<
    DeliverySiteRebuildTicketCoordinate & {
      status: string;
      revision: number;
      internalNote: string | null;
    }
  >;
  operationById: ReadonlyMap<
    string,
    NonNullable<DeliverySiteRebuildOperationCoordinate>
  >;
}) {
  const candidates = input.tickets.flatMap((ticket) => {
    if (ticket.status !== "in_progress") return [];
    const resetState = deliverySiteRebuildResetProjection(
      ticket,
      input.operationById,
    ).siteRebuildResetState;
    return resetState === "completed" || resetState === "invalidated"
      ? [{ ticket, resetState }]
      : [];
  });
  if (candidates.length === 0) {
    return new Map<string, ReconciledDeliveryTicketTerminal>();
  }
  const now = new Date();
  const updateTerminalCandidates = async (
    resetState: "completed" | "invalidated",
  ) => {
    const selected = candidates.filter(
      (candidate) => candidate.resetState === resetState,
    );
    if (selected.length === 0) return;
    const coordinateConditions = selected.map(({ ticket }) =>
      and(
        eq(deliveryTickets.id, ticket.id),
        eq(deliveryTickets.revision, ticket.revision),
        eq(deliveryTickets.internalNote, ticket.internalNote!),
      ),
    );
    const completed = resetState === "completed";
    await input.executor
      .update(deliveryTickets)
      .set({
        status: completed ? "completed" : "cancelled",
        publicSummary: completed
          ? SITE_REBUILD_COMPLETED_SUMMARY
          : SITE_REBUILD_INVALIDATED_SUMMARY,
        quotaState: completed
          ? "consumed"
          : sql`CASE WHEN ${deliveryTickets.quotaState} = 'reserved' THEN 'released' ELSE ${deliveryTickets.quotaState} END`,
        quotaReleasedAt: completed
          ? null
          : sql`CASE WHEN ${deliveryTickets.quotaState} = 'reserved' THEN ${now} ELSE ${deliveryTickets.quotaReleasedAt} END`,
        technicalDedupeKey: null,
        resolvedAt: now,
        revision: sql`${deliveryTickets.revision} + 1`,
        updatedByUserId: input.actorUserId,
        updatedAt: now,
      })
      .where(
        and(
          eq(deliveryTickets.status, "in_progress"),
          or(...coordinateConditions),
        ),
      );
  };
  await updateTerminalCandidates("completed");
  await updateTerminalCandidates("invalidated");
  const repairedRows = await input.executor
    .select({
      id: deliveryTickets.id,
      status: deliveryTickets.status,
      publicSummary: deliveryTickets.publicSummary,
      quotaState: deliveryTickets.quotaState,
      quotaReleasedAt: deliveryTickets.quotaReleasedAt,
      technicalDedupeKey: deliveryTickets.technicalDedupeKey,
      resolvedAt: deliveryTickets.resolvedAt,
      revision: deliveryTickets.revision,
      updatedAt: deliveryTickets.updatedAt,
    })
    .from(deliveryTickets)
    .where(
      inArray(
        deliveryTickets.id,
        candidates.map(({ ticket }) => ticket.id),
      ),
    );
  return new Map<string, ReconciledDeliveryTicketTerminal>(
    repairedRows.flatMap((row: any) => {
      const expectedSummary =
        row.status === "completed"
          ? SITE_REBUILD_COMPLETED_SUMMARY
          : row.status === "cancelled"
            ? SITE_REBUILD_INVALIDATED_SUMMARY
            : null;
      return expectedSummary &&
        row.publicSummary === expectedSummary &&
        ["reserved", "consumed", "released"].includes(row.quotaState) &&
        row.technicalDedupeKey == null &&
        row.resolvedAt instanceof Date &&
        row.updatedAt instanceof Date
        ? [[row.id, row as ReconciledDeliveryTicketTerminal] as const]
        : [];
    }),
  );
}

function effectiveReconciledDeliveryTicket<T extends { id: string }>(
  ticket: T,
  reconciledById: ReadonlyMap<string, ReconciledDeliveryTicketTerminal>,
) {
  const reconciled = reconciledById.get(ticket.id);
  return reconciled ? { ...ticket, ...reconciled } : ticket;
}

export function deliveryTicketCountsAfterResetRepair(input: {
  pending: number;
  completed: number;
  repairedTicketCount: number;
}) {
  return {
    pending: Math.max(0, input.pending - input.repairedTicketCount),
    completed: input.completed + input.repairedTicketCount,
  };
}

/**
 * Lists the signed-in engineer's own tickets across every assigned customer.
 * System administrators use the same projection, limited to tickets anchored
 * to a workflow role and project assignment. The bounded result and all
 * supporting filters/counts are loaded in a fixed number of batched queries.
 */
export async function getMyDeliveryTickets(input: {
  actor: AuthenticatedUser;
  customerUserId?: number;
  projectAssignmentId?: string;
  statusGroup?: "pending" | "completed";
  limit?: number;
  cursor?: { actionRank: number; updatedAt: number; id: string };
}) {
  if (!deliveryExecutionActorRole(input.actor)) {
    throw new AuthServiceError(
      "INVALID_CREDENTIAL",
      "该需求池仅对工程师或系统管理员开放",
    );
  }
  const db = await requireDb();
  const actorTicketScope = deliveryRoleTicketScope(input.actor);
  const visibleInitialMonitoringScope = visibleInitialMonitoringTicketScope();
  const visibleActorTicketScope = and(
    actorTicketScope,
    visibleInitialMonitoringScope,
  );
  const statusFilter =
    input.statusGroup === "pending"
      ? ACTIVE_DELIVERY_STATUSES
      : input.statusGroup === "completed"
        ? TERMINAL_DELIVERY_STATUSES
        : [...ACTIVE_DELIVERY_STATUSES, ...TERMINAL_DELIVERY_STATUSES];
  const ownershipFilter = and(
    visibleActorTicketScope,
    inArray(deliveryTickets.status, statusFilter),
    input.customerUserId
      ? eq(deliveryTickets.userId, input.customerUserId)
      : undefined,
    input.projectAssignmentId
      ? eq(
          deliveryTickets.assignedProjectAssignmentId,
          input.projectAssignmentId,
        )
      : undefined,
  );
  const actionRank = sql<number>`CASE ${deliveryTickets.status}
    WHEN 'in_progress' THEN 0
    WHEN 'submitted' THEN 1
    WHEN 'scheduled' THEN 2
    WHEN 'needs_information' THEN 3
    ELSE 4 END`;
  const cursorDate = input.cursor
    ? new Date(input.cursor.updatedAt)
    : undefined;
  const pageLimit = input.limit ?? MY_DELIVERY_TICKET_LIMIT;
  const cursorFilter =
    input.cursor && cursorDate
      ? or(
          gt(actionRank, input.cursor.actionRank),
          and(
            eq(actionRank, input.cursor.actionRank),
            or(
              lt(deliveryTickets.updatedAt, cursorDate),
              and(
                eq(deliveryTickets.updatedAt, cursorDate),
                lt(deliveryTickets.id, input.cursor.id),
              ),
            ),
          ),
        )
      : undefined;

  const [ticketRows, customerRows, countRows, nextPendingRows] =
    await Promise.all([
      db
        .select({
          ticket: deliveryTickets,
          customerUsername: users.username,
          customerName: users.displayName,
          customerMarketEdition: users.marketEdition,
        })
        .from(deliveryTickets)
        .innerJoin(users, eq(users.id, deliveryTickets.userId))
        .where(and(ownershipFilter, cursorFilter))
        .orderBy(
          asc(actionRank),
          desc(deliveryTickets.updatedAt),
          desc(deliveryTickets.id),
        )
        .limit(pageLimit + 1),
      db
        .selectDistinct({
          id: users.id,
          name: users.displayName,
          username: users.username,
        })
        .from(deliveryTickets)
        .innerJoin(users, eq(users.id, deliveryTickets.userId))
        .where(visibleActorTicketScope)
        .orderBy(asc(users.displayName), asc(users.username), asc(users.id)),
      db
        .select({ status: deliveryTickets.status, value: count() })
        .from(deliveryTickets)
        .where(
          and(
            visibleActorTicketScope,
            inArray(deliveryTickets.status, [
              ...ACTIVE_DELIVERY_STATUSES,
              ...TERMINAL_DELIVERY_STATUSES,
            ]),
            input.customerUserId
              ? eq(deliveryTickets.userId, input.customerUserId)
              : undefined,
            input.projectAssignmentId
              ? eq(
                  deliveryTickets.assignedProjectAssignmentId,
                  input.projectAssignmentId,
                )
              : undefined,
          ),
        )
        .groupBy(deliveryTickets.status),
      db
        .select({
          ticket: deliveryTickets,
          customerUsername: users.username,
          customerName: users.displayName,
        })
        .from(deliveryTickets)
        .innerJoin(users, eq(users.id, deliveryTickets.userId))
        .where(
          and(
            visibleActorTicketScope,
            inArray(deliveryTickets.status, ACTIVE_DELIVERY_STATUSES),
            input.customerUserId
              ? eq(deliveryTickets.userId, input.customerUserId)
              : undefined,
            input.projectAssignmentId
              ? eq(
                  deliveryTickets.assignedProjectAssignmentId,
                  input.projectAssignmentId,
                )
              : undefined,
          ),
        )
        .orderBy(
          asc(actionRank),
          desc(deliveryTickets.updatedAt),
          desc(deliveryTickets.id),
        )
        .limit(MY_DELIVERY_TICKET_LIMIT),
    ]);

  const hasMore = ticketRows.length > pageLimit;
  const selectedRows = ticketRows.slice(0, pageLimit);
  const resetOperationById = await loadDeliverySiteRebuildResetOperations(
    db,
    [...selectedRows, ...nextPendingRows].map((row) => row.ticket),
  );
  const reconciledTicketById = await reconcileTerminalSiteRebuildTickets({
    executor: db,
    actorUserId: input.actor.id,
    tickets: [...selectedRows, ...nextPendingRows].map((row) => row.ticket),
    operationById: resetOperationById,
  });
  const effectiveSelectedRows = selectedRows.map((row) => ({
    ...row,
    ticket: effectiveReconciledDeliveryTicket(row.ticket, reconciledTicketById),
  }));
  const effectiveNextPendingRows = nextPendingRows.map((row) => ({
    ...row,
    ticket: effectiveReconciledDeliveryTicket(row.ticket, reconciledTicketById),
  }));
  const customerIds = [
    ...new Set([
      ...effectiveSelectedRows.map((row) => row.ticket.userId),
      ...effectiveNextPendingRows.map((row) => row.ticket.userId),
    ]),
  ];
  const [
    dashboardRows,
    styleWorkflowRows,
    contractRows,
    quotaPeriodRows,
    completedCatalogRows,
    archivedCatalogRows,
    approvedQuestionRows,
  ] = customerIds.length
    ? await Promise.all([
        db
          .select({
            userId: userDashboardContents.userId,
            revision: userDashboardContents.revision,
          })
          .from(userDashboardContents)
          .where(inArray(userDashboardContents.userId, customerIds)),
        db
          .select({
            userId: websiteStyleWorkflows.userId,
            revision: websiteStyleWorkflows.revision,
            status: websiteStyleWorkflows.status,
          })
          .from(websiteStyleWorkflows)
          .where(inArray(websiteStyleWorkflows.userId, customerIds)),
        db
          .select({
            id: serviceContracts.id,
            planCode: serviceContracts.planCode,
            planVersion: serviceContracts.planVersion,
            startsAt: serviceContracts.startsAt,
            endsAt: serviceContracts.endsAt,
          })
          .from(serviceContracts)
          .where(inArray(serviceContracts.userId, customerIds)),
        db
          .select({
            id: serviceQuotaPeriods.id,
            startsAt: serviceQuotaPeriods.startsAt,
            endsAt: serviceQuotaPeriods.endsAt,
          })
          .from(serviceQuotaPeriods)
          .where(inArray(serviceQuotaPeriods.userId, customerIds)),
        db
          .selectDistinct({
            userId: deliveryTickets.userId,
            contractId: deliveryTickets.contractId,
            quotaPeriodId: deliveryTickets.quotaPeriodId,
          })
          .from(deliveryTickets)
          .where(
            and(
              inArray(deliveryTickets.userId, customerIds),
              eq(deliveryTickets.operation, "question_catalog"),
              eq(deliveryTickets.status, "completed"),
            ),
          ),
        db
          .select({
            userId: deliveryWorkflowMilestones.userId,
            completedAt: deliveryWorkflowMilestones.completedAt,
          })
          .from(deliveryWorkflowMilestones)
          .where(
            and(
              inArray(deliveryWorkflowMilestones.userId, customerIds),
              eq(deliveryWorkflowMilestones.operation, "question_catalog"),
            ),
          ),
        db
          .selectDistinct({
            userId: workspaceQuestions.userId,
            contractId: workspaceQuestions.contractId,
            quotaPeriodId: workspaceQuestions.quotaPeriodId,
          })
          .from(workspaceQuestions)
          .where(
            and(
              inArray(workspaceQuestions.userId, customerIds),
              eq(workspaceQuestions.status, "selected"),
              eq(workspaceQuestions.selectionApprovalStatus, "approved"),
            ),
          ),
      ])
    : [[], [], [], [], [], [], []];
  const dashboardRevisionByUser = new Map(
    dashboardRows.map((row) => [row.userId, row.revision]),
  );
  const styleWorkflowByUser = new Map(
    styleWorkflowRows.map((row) => [row.userId, row]),
  );
  const contractById = new Map(contractRows.map((row) => [row.id, row]));
  const quotaPeriodById = new Map(quotaPeriodRows.map((row) => [row.id, row]));
  const catalogScopeKey = (input: {
    userId: number;
    contractId: string;
    quotaPeriodId: string;
  }) => {
    const contract = contractById.get(input.contractId);
    return `${input.userId}:${deliveryQuestionWorkflowScopeKey({
      progressiveLuxury: isProgressiveLuxuryContract(contract),
      contractId: input.contractId,
      quotaPeriodId: input.quotaPeriodId,
    })}`;
  };
  const completedCatalogScopes = new Set(
    completedCatalogRows.map((row) => catalogScopeKey(row)),
  );
  const catalogMilestonesByUser = new Map<number, Date[]>();
  for (const row of archivedCatalogRows) {
    const milestones = catalogMilestonesByUser.get(row.userId) ?? [];
    milestones.push(row.completedAt);
    catalogMilestonesByUser.set(row.userId, milestones);
  }
  const approvedQuestionScopes = new Set(
    approvedQuestionRows.map((row) => catalogScopeKey(row)),
  );
  const dependencyForTicket = (ticket: typeof deliveryTickets.$inferSelect) => {
    const contract = contractById.get(ticket.contractId);
    const period = quotaPeriodById.get(ticket.quotaPeriodId);
    const progressiveLuxury = isProgressiveLuxuryContract(contract);
    const milestoneWindow = progressiveLuxury ? contract : period;
    const hasReusableCatalogMilestone = Boolean(
      progressiveLuxury
        ? milestoneWindow &&
            catalogMilestonesByUser.get(ticket.userId)?.some((completedAt) =>
              deliveryWorkflowMilestoneIsReusable({
                completedAt,
                startsAt: milestoneWindow.startsAt,
                endsAt: milestoneWindow.endsAt,
              }),
            )
        : catalogMilestonesByUser.get(ticket.userId)?.length,
    );
    const key = catalogScopeKey(ticket);
    return deliveryTicketDependencyState({
      operation: ticket.operation,
      status: ticket.status,
      hasCompletedQuestionCatalog:
        completedCatalogScopes.has(key) || hasReusableCatalogMilestone,
      hasApprovedQuestion: approvedQuestionScopes.has(key),
    });
  };
  const counts = { pending: 0, completed: 0 };
  for (const row of countRows) {
    const group = deliveryTicketStatusGroup(row.status);
    if (group) counts[group] += Number(row.value);
  }
  // The batched read repair runs after the initial aggregate query. Reflect
  // those exact CAS-terminal tickets in this same response so the item and
  // counters cannot disagree for one refresh cycle.
  const repairedTicketCount = reconciledTicketById.size;
  if (repairedTicketCount > 0) {
    Object.assign(
      counts,
      deliveryTicketCountsAfterResetRepair({
        ...counts,
        repairedTicketCount,
      }),
    );
  }

  const items = effectiveSelectedRows.map(
    ({ ticket, customerName, customerUsername, customerMarketEdition }) => {
      const styleWorkflow = styleWorkflowByUser.get(ticket.userId);
      return {
        ...ticket,
        customerName:
          customerName || customerUsername || `客户 ${ticket.userId}`,
        customerUsername,
        statusGroup: deliveryTicketStatusGroup(ticket.status),
        dashboardRevision: dashboardRevisionByUser.get(ticket.userId) ?? 0,
        websiteStyleWorkflowRevision: styleWorkflow?.revision ?? 0,
        websiteStyleState: styleWorkflow?.status ?? null,
        marketEdition: customerMarketEdition ?? null,
        siteRebuildResetApplied:
          ticket.operation === "site_rebuild" &&
          siteOpsRebuildResetApplied(ticket.internalNote),
        siteRebuildResetPending:
          ticket.operation === "site_rebuild" &&
          siteOpsRebuildResetPending(ticket.internalNote),
        ...deliverySiteRebuildResetProjection(ticket, resetOperationById),
        ...dependencyForTicket(ticket),
      };
    },
  );
  const last = effectiveSelectedRows.at(-1)?.ticket;
  const nextPendingRow = effectiveNextPendingRows.find(
    (row) => dependencyForTicket(row.ticket).dependencySatisfied,
  );
  return {
    items,
    nextPending: nextPendingRow
      ? {
          id: nextPendingRow.ticket.id,
          userId: nextPendingRow.ticket.userId,
          title: nextPendingRow.ticket.title,
          operation: nextPendingRow.ticket.operation,
          status: nextPendingRow.ticket.status,
          siteRebuildResetApplied:
            nextPendingRow.ticket.operation === "site_rebuild" &&
            siteOpsRebuildResetApplied(nextPendingRow.ticket.internalNote),
          siteRebuildResetPending:
            nextPendingRow.ticket.operation === "site_rebuild" &&
            siteOpsRebuildResetPending(nextPendingRow.ticket.internalNote),
          ...deliverySiteRebuildResetProjection(
            nextPendingRow.ticket,
            resetOperationById,
          ),
          customerName:
            nextPendingRow.customerName ||
            nextPendingRow.customerUsername ||
            `客户 ${nextPendingRow.ticket.userId}`,
          customerUsername: nextPendingRow.customerUsername,
        }
      : null,
    filters: {
      customers: customerRows.map((customer) => ({
        ...customer,
        name: customer.name || customer.username || `客户 ${customer.id}`,
      })),
    },
    counts,
    nextCursor:
      hasMore && last
        ? {
            actionRank: deliveryTicketActionRank(last.status),
            updatedAt: last.updatedAt.getTime(),
            id: last.id,
          }
        : null,
    limit: pageLimit,
  };
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
        const [ticketRows, resetRows] = await Promise.all([
          tx
            .select({ id: deliveryTickets.id })
            .from(deliveryTickets)
            .where(
              and(
                eq(deliveryTickets.userId, input.customerUserId),
                eq(deliveryTickets.workflowDomain, input.roleType),
                inArray(deliveryTickets.status, ACTIVE_DELIVERY_STATUSES),
              ),
            )
            .limit(1),
          input.roleType === "ai_operations_engineer"
            ? tx
                .select({ id: knowledgeBaseResetRequests.id })
                .from(knowledgeBaseResetRequests)
                .where(
                  and(
                    eq(knowledgeBaseResetRequests.userId, input.customerUserId),
                    eq(knowledgeBaseResetRequests.status, "pending"),
                  ),
                )
                .limit(1)
            : Promise.resolve([]),
        ]);
        if (ticketRows[0] || resetRows[0]) {
          throw new AuthServiceError(
            "CONFLICT",
            "该岗位仍有未结束任务，不能解除负责人，请直接更换工程师",
          );
        }
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
      await tx
        .update(deliveryTickets)
        .set({
          assignedProjectAssignmentId: assignmentId,
          assignedMemberId: input.engineerUserId,
          updatedByUserId: input.actor.id,
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(deliveryTickets.userId, input.customerUserId),
            eq(deliveryTickets.workflowDomain, input.roleType),
            inArray(deliveryTickets.status, ACTIVE_DELIVERY_STATUSES),
          ),
        );
      if (input.roleType === "ai_operations_engineer") {
        await tx
          .update(knowledgeBaseResetRequests)
          .set({
            assignedProjectAssignmentId: assignmentId,
            assignedMemberId: input.engineerUserId,
            updatedAt: new Date(),
          })
          .where(
            and(
              eq(knowledgeBaseResetRequests.userId, input.customerUserId),
              eq(knowledgeBaseResetRequests.status, "pending"),
            ),
          );
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
  if (
    input.engineerUserId != null &&
    input.roleType === "monitoring_optimization_engineer"
  ) {
    await createProjectMonitoringHandoffIfReady({
      customerUserId: input.customerUserId,
      roleType: input.roleType,
      actorUserId: input.actor.id,
    });
  }
  return result;
}

export async function createProjectMonitoringHandoffIfReady(input: {
  customerUserId: number;
  roleType: DeliveryRoleType;
  actorUserId: number;
}) {
  const db = await requireDb();
  if (input.roleType === "monitoring_optimization_engineer") {
    const snapshotRows = await db
      .select({ id: knowledgeBaseSnapshots.id })
      .from(knowledgeBaseSnapshots)
      .where(eq(knowledgeBaseSnapshots.userId, input.customerUserId))
      .limit(1);
    if (snapshotRows[0]) {
      await createKnowledgeMonitoringHandoff({
        userId: input.customerUserId,
        actorUserId: input.actorUserId,
      });
    }
    await reconcileInitialMonitoringForCurrentService({
      userId: input.customerUserId,
      actorUserId: input.actorUserId,
    });
  }
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
  const [contracts, activeTickets] = rows.length
    ? await Promise.all([
        db
          .select()
          .from(serviceContracts)
          .where(
            inArray(serviceContracts.userId, [
              ...new Set(rows.map((row) => row.customerUserId)),
            ]),
          ),
        db
          .select({
            assignedProjectAssignmentId:
              deliveryTickets.assignedProjectAssignmentId,
          })
          .from(deliveryTickets)
          .where(
            and(
              inArray(
                deliveryTickets.assignedProjectAssignmentId,
                rows.map((row) => row.projectAssignmentId),
              ),
              inArray(deliveryTickets.status, ACTIVE_DELIVERY_STATUSES),
            ),
          ),
      ])
    : [[], []];
  const activeAssignmentIds = new Set(
    activeTickets
      .map((ticket) => ticket.assignedProjectAssignmentId)
      .filter((id): id is string => Boolean(id)),
  );
  return rows
    .filter((row) => {
      const currentContract = selectPortalContract(
        contracts.filter(
          (contract) => contract.userId === row.customerUserId,
        ) as ServicePortalContractRecord[],
      );
      return (
        deliveryRoleEnabledForCustomer({
          roleType: row.roleType,
          planCode: currentContract?.planCode,
          marketEdition: row.marketEdition,
        }) || activeAssignmentIds.has(row.projectAssignmentId)
      );
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

const TERMINAL_DELIVERY_STATUSES = [
  "completed",
  "rejected",
  "cancelled",
] as const;

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

export function deliveryHistoryTicketTitle(input: {
  title?: string | null;
  type?: string | null;
  operation?: string | null;
  category?: string | null;
}) {
  return deliveryTicketPresentationTitle(input);
}

export async function getMyDeliveryHistory(input: {
  actor: AuthenticatedUser;
  status?: (typeof TERMINAL_DELIVERY_STATUSES)[number];
  customerUserId?: number;
  operation?: string;
  limit: number;
  cursor?: { resolvedAt: number; id: string };
}) {
  if (!deliveryExecutionActorRole(input.actor)) {
    throw new AuthServiceError(
      "INVALID_CREDENTIAL",
      "该记录仅对工程师或系统管理员开放",
    );
  }
  const db = await requireDb();
  const actorTicketScope = deliveryRoleTicketScope(input.actor);
  const cursorDate = input.cursor
    ? new Date(input.cursor.resolvedAt)
    : undefined;
  const resolvedSortAt =
    sql<Date>`COALESCE(${deliveryTickets.resolvedAt}, ${deliveryTickets.updatedAt})`.mapWith(
      deliveryTickets.updatedAt,
    );
  const [rows, customerRows, operationRows] = await Promise.all([
    db
      .select({
        ticket: deliveryTickets,
        customerUsername: users.username,
        customerName: users.displayName,
        resolvedSortAt,
      })
      .from(deliveryTickets)
      .innerJoin(users, eq(users.id, deliveryTickets.userId))
      .where(
        and(
          actorTicketScope,
          input.status
            ? eq(deliveryTickets.status, input.status)
            : inArray(deliveryTickets.status, TERMINAL_DELIVERY_STATUSES),
          input.customerUserId
            ? eq(deliveryTickets.userId, input.customerUserId)
            : undefined,
          input.operation
            ? eq(deliveryTickets.operation, input.operation)
            : undefined,
          cursorDate
            ? or(
                lt(resolvedSortAt, cursorDate),
                and(
                  eq(resolvedSortAt, cursorDate),
                  lt(deliveryTickets.id, input.cursor!.id),
                ),
              )
            : undefined,
        ),
      )
      .orderBy(desc(resolvedSortAt), desc(deliveryTickets.id))
      .limit(input.limit + 1),
    db
      .selectDistinct({
        id: users.id,
        name: users.displayName,
        username: users.username,
      })
      .from(deliveryTickets)
      .innerJoin(users, eq(users.id, deliveryTickets.userId))
      .where(
        and(
          actorTicketScope,
          inArray(deliveryTickets.status, TERMINAL_DELIVERY_STATUSES),
        ),
      )
      .orderBy(asc(users.displayName), asc(users.username), asc(users.id)),
    db
      .selectDistinct({ operation: deliveryTickets.operation })
      .from(deliveryTickets)
      .where(
        and(
          actorTicketScope,
          inArray(deliveryTickets.status, TERMINAL_DELIVERY_STATUSES),
        ),
      )
      .orderBy(asc(deliveryTickets.operation)),
  ]);
  const hasMore = rows.length > input.limit;
  const selected = rows.slice(0, input.limit);
  const items = selected.map(
    ({ ticket, customerName, customerUsername, resolvedSortAt }) => ({
      id: ticket.id,
      customerUserId: ticket.userId,
      customerName: customerName || customerUsername || `客户 ${ticket.userId}`,
      customerUsername,
      projectAssignmentId: ticket.assignedProjectAssignmentId,
      title: deliveryHistoryTicketTitle({
        title: ticket.title,
        type: ticket.type,
        operation: ticket.operation,
        category: ticket.category,
      }),
      operation: ticket.operation,
      status: ticket.status,
      publicSummary: ticket.publicSummary,
      resultExcerpt:
        ticket.publicSummary ||
        ticket.internalNote ||
        ticket.description ||
        "已完成处理，点击查看详细记录。",
      resolvedAt: deliveryHistoryTimestamp(resolvedSortAt),
      updatedAt: ticket.updatedAt.getTime(),
    }),
  );
  const last = selected.at(-1);
  return {
    items,
    filters: {
      customers: customerRows.map((customer) => ({
        ...customer,
        name: customer.name || customer.username || `客户 ${customer.id}`,
      })),
      operations: operationRows
        .map((row) => row.operation)
        .filter((operation): operation is string => Boolean(operation)),
    },
    nextCursor:
      hasMore && last
        ? {
            resolvedAt: deliveryHistoryTimestamp(last.resolvedSortAt),
            id: last.ticket.id,
          }
        : null,
  };
}

export async function getMyDeliveryTicketDetail(input: {
  actor: AuthenticatedUser;
  ticketId: string;
}) {
  if (!deliveryExecutionActorRole(input.actor)) {
    throw new AuthServiceError(
      "INVALID_CREDENTIAL",
      "该记录仅对工程师或系统管理员开放",
    );
  }
  const db = await requireDb();
  const rows = await db
    .select({
      ticket: deliveryTickets,
      customerUsername: users.username,
      customerName: users.displayName,
    })
    .from(deliveryTickets)
    .innerJoin(users, eq(users.id, deliveryTickets.userId))
    .where(
      and(
        eq(deliveryTickets.id, input.ticketId),
        deliveryRoleTicketScope(input.actor),
      ),
    )
    .limit(1);
  const row = rows[0];
  if (!row) {
    throw new AuthServiceError("NOT_FOUND", "任务记录不存在");
  }
  const resetOperationId =
    row.ticket.operation === "site_rebuild"
      ? siteOpsRebuildResetOperationId(row.ticket.internalNote)
      : null;
  const [
    events,
    attachments,
    resetRows,
    rootRows,
    rootAttachmentRows,
    siteRebuildResetOperationRows,
  ] = await Promise.all([
    db
      .select()
      .from(deliveryTicketEvents)
      .where(eq(deliveryTicketEvents.ticketId, row.ticket.id))
      .orderBy(asc(deliveryTicketEvents.createdAt)),
    db
      .select()
      .from(deliveryTicketAttachments)
      .where(eq(deliveryTicketAttachments.ticketId, row.ticket.id))
      .orderBy(asc(deliveryTicketAttachments.createdAt)),
    row.ticket.operation === "knowledge_reset"
      ? db
          .select()
          .from(knowledgeBaseResetRequests)
          .where(eq(knowledgeBaseResetRequests.ticketId, row.ticket.id))
          .limit(1)
      : Promise.resolve([]),
    row.ticket.rootTicketId
      ? db
          .select()
          .from(deliveryTickets)
          .where(
            and(
              eq(deliveryTickets.id, row.ticket.rootTicketId),
              eq(deliveryTickets.userId, row.ticket.userId),
              eq(deliveryTickets.isWorkflowContainer, true),
            ),
          )
          .limit(1)
      : Promise.resolve([]),
    row.ticket.rootTicketId
      ? db
          .select()
          .from(deliveryTicketAttachments)
          .where(
            eq(deliveryTicketAttachments.ticketId, row.ticket.rootTicketId),
          )
          .orderBy(asc(deliveryTicketAttachments.createdAt))
      : Promise.resolve([]),
    resetOperationId
      ? db
          .select({
            id: siteOperations.id,
            projectId: siteOperations.projectId,
            userId: siteOperations.userId,
            kind: siteOperations.kind,
            provider: siteOperations.provider,
            status: siteOperations.status,
            input: siteOperations.input,
            result: siteOperations.result,
            errorCode: siteOperations.errorCode,
            attempt: siteOperations.attempt,
            providerOperationId: siteOperations.providerOperationId,
            providerTaskId: siteOperations.providerTaskId,
          })
          .from(siteOperations)
          .where(eq(siteOperations.id, resetOperationId))
          .limit(1)
      : Promise.resolve([]),
  ]);
  const siteRebuildResetOperationById = new Map<
    string,
    NonNullable<DeliverySiteRebuildOperationCoordinate>
  >(
    siteRebuildResetOperationRows.map((operation) => [operation.id, operation]),
  );
  const reconciledTicketById = await reconcileTerminalSiteRebuildTickets({
    executor: db,
    actorUserId: input.actor.id,
    tickets: [row.ticket],
    operationById: siteRebuildResetOperationById,
  });
  const effectiveTicket = effectiveReconciledDeliveryTicket(
    row.ticket,
    reconciledTicketById,
  );
  const reset = resetRows[0];
  const rootTicket = rootRows[0];
  return {
    ticket: {
      ...effectiveTicket,
      siteRebuildResetApplied:
        effectiveTicket.operation === "site_rebuild" &&
        siteOpsRebuildResetApplied(effectiveTicket.internalNote),
      siteRebuildResetPending:
        effectiveTicket.operation === "site_rebuild" &&
        siteOpsRebuildResetPending(effectiveTicket.internalNote),
      ...deliverySiteRebuildResetProjection(
        effectiveTicket,
        siteRebuildResetOperationById,
      ),
      createdAt: effectiveTicket.createdAt.getTime(),
      updatedAt: effectiveTicket.updatedAt.getTime(),
      resolvedAt: effectiveTicket.resolvedAt?.getTime() ?? null,
      scheduledAt: effectiveTicket.scheduledAt?.getTime() ?? null,
    },
    customer: {
      id: row.ticket.userId,
      name:
        row.customerName || row.customerUsername || `客户 ${row.ticket.userId}`,
      username: row.customerUsername,
    },
    events: events.map((event) => ({
      ...event,
      createdAt: event.createdAt.getTime(),
    })),
    attachments: attachments.map((attachment) => ({
      ...attachment,
      createdAt: attachment.createdAt.getTime(),
      downloadUrl: `/api/delivery-ticket-attachments/${attachment.id}/content`,
    })),
    rootContext: rootTicket
      ? {
          ticket: {
            id: rootTicket.id,
            type: rootTicket.type,
            category: rootTicket.category,
            topic: rootTicket.topic,
            title: rootTicket.title,
            description: rootTicket.description,
            preferredMedia: rootTicket.preferredMedia,
            targetPage: rootTicket.targetPage,
            materialUrls: rootTicket.materialUrls,
            createdAt: rootTicket.createdAt.getTime(),
            updatedAt: rootTicket.updatedAt.getTime(),
          },
          attachments: rootAttachmentRows.map((attachment) => ({
            id: attachment.id,
            filename: attachment.filename,
            mimeType: attachment.mimeType,
            sizeBytes: attachment.sizeBytes,
            purpose: attachment.purpose,
            authorization: attachment.authorization,
            copyrightNote: attachment.copyrightNote,
            createdAt: attachment.createdAt.getTime(),
          })),
        }
      : null,
    knowledgeReset: reset
      ? {
          id: reset.id,
          reasonCode: reset.reasonCode,
          reasonNote: reset.reasonNote,
          status: reset.status,
          decisionNote: reset.decisionNote,
          cleanupSummary: reset.cleanupSummary,
          decidedAt: reset.decidedAt?.getTime() ?? null,
          createdAt: reset.createdAt.getTime(),
        }
      : null,
  };
}

export async function publishWebsiteStyleSamples(input: {
  actor: AuthenticatedUser;
  projectAssignmentId: string;
  ticketId: string;
  expectedWorkflowRevision: number;
  engineerNote?: string;
  samples: Array<{
    fileId: string;
    filename: string;
    mimeType: string;
    sizeBytes: number;
    sha256?: string;
    label: string;
    note?: string;
  }>;
}) {
  const actorRole = deliveryExecutionActorRole(input.actor);
  if (!actorRole) {
    throw new AuthServiceError(
      "INVALID_CREDENTIAL",
      "需要工程师或系统管理员权限",
    );
  }
  const systemAdmin = actorRole === "admin";
  if (input.samples.length !== 3) {
    throw new AuthServiceError("CONFLICT", "每批必须提交恰好三张图片样例");
  }
  if (
    new Set(input.samples.map((sample) => sample.fileId)).size !==
    input.samples.length
  ) {
    throw new AuthServiceError("CONFLICT", "三张图片样例不能重复");
  }
  for (const sample of input.samples) {
    if (
      !/^image\/(?:png|jpeg|webp)$/i.test(sample.mimeType) ||
      sample.sizeBytes <= 0 ||
      sample.sizeBytes > 10 * 1024 * 1024
    ) {
      throw new AuthServiceError(
        "CONFLICT",
        "样例仅支持 10MB 以内的 PNG、JPEG 或 WebP 图片",
      );
    }
  }
  const db = await requireDb();
  return db.transaction(async (tx) => {
    const ticketRows = await tx
      .select()
      .from(deliveryTickets)
      .where(eq(deliveryTickets.id, input.ticketId))
      .limit(1)
      .for("update");
    const ticket = ticketRows[0];
    if (
      !ticket ||
      ticket.operation !== "website_style_samples" ||
      (!systemAdmin && ticket.assignedMemberId !== input.actor.id) ||
      ticket.assignedProjectAssignmentId !== input.projectAssignmentId ||
      !["submitted", "in_progress"].includes(ticket.status)
    ) {
      throw new AuthServiceError("NOT_FOUND", "官网风格样例任务不存在");
    }
    await assertDeliveryProjectContext({
      actor: input.actor,
      projectAssignmentId: input.projectAssignmentId,
      customerUserId: ticket.userId,
      expectedRoleType: "ai_operations_engineer",
      executor: tx,
    });
    const workflowRows = await tx
      .select()
      .from(websiteStyleWorkflows)
      .where(eq(websiteStyleWorkflows.userId, ticket.userId))
      .limit(1)
      .for("update");
    const workflow = workflowRows[0];
    if (
      !workflow ||
      workflow.revision !== input.expectedWorkflowRevision ||
      !["waiting_samples", "revision_requested"].includes(workflow.status)
    ) {
      throw new AuthServiceError(
        "CONFLICT",
        "官网风格选择状态已变化，请刷新后重试",
      );
    }
    const resourceRows = await tx
      .select({ upstreamId: upstreamResources.upstreamId })
      .from(upstreamResources)
      .where(
        and(
          eq(upstreamResources.userId, input.actor.id),
          systemAdmin
            ? undefined
            : eq(
                upstreamResources.projectAssignmentId,
                input.projectAssignmentId,
              ),
          eq(upstreamResources.kind, "file"),
          inArray(
            upstreamResources.upstreamId,
            input.samples.map((sample) => sample.fileId),
          ),
        ),
      );
    if (
      new Set(resourceRows.map((resource) => resource.upstreamId)).size !== 3
    ) {
      throw new AuthServiceError(
        "INVALID_CREDENTIAL",
        systemAdmin
          ? "样例图片不属于当前系统管理员账号"
          : "样例图片不属于当前工程师客户项目",
      );
    }
    const latestBatchRows = await tx
      .select({ ordinal: websiteStyleSampleBatches.ordinal })
      .from(websiteStyleSampleBatches)
      .where(eq(websiteStyleSampleBatches.userId, ticket.userId))
      .orderBy(desc(websiteStyleSampleBatches.ordinal))
      .limit(1);
    const now = new Date();
    const eventId = randomUUID();
    const batchId = randomUUID();
    const attachmentIds = input.samples.map(() => randomUUID());
    if (workflow.currentBatchId) {
      await tx
        .update(websiteStyleSampleBatches)
        .set({ status: "superseded", updatedAt: now })
        .where(eq(websiteStyleSampleBatches.id, workflow.currentBatchId));
    }
    await tx.insert(deliveryTicketEvents).values({
      id: eventId,
      ticketId: ticket.id,
      userId: ticket.userId,
      actorUserId: input.actor.id,
      actorRole,
      kind: "attachment",
      visibility: "customer",
      message:
        input.engineerNote?.trim() ||
        "交付团队已提交三张官网图片风格样例，请选择一张或退回重做。",
      fromStatus: ticket.status,
      toStatus: "needs_information",
      actorContext: {
        projectAssignmentId: input.projectAssignmentId,
        customerUserId: ticket.userId,
        roleType: "ai_operations_engineer",
      },
      createdAt: now,
    });
    await tx.insert(deliveryTicketAttachments).values(
      input.samples.map((sample, index) => ({
        id: attachmentIds[index]!,
        ticketId: ticket.id,
        eventId,
        workspaceUserId: ticket.userId,
        ownerUserId: input.actor.id,
        kind: "deliverable" as const,
        upstreamFileId: sample.fileId,
        filename: sample.filename,
        mimeType: sample.mimeType,
        sizeBytes: sample.sizeBytes,
        sha256: sample.sha256 || null,
        purpose: "官网图片风格样例",
        authorization: "owned" as const,
        createdAt: now,
      })),
    );
    await tx.insert(websiteStyleSampleBatches).values({
      id: batchId,
      userId: ticket.userId,
      ticketId: ticket.id,
      ordinal: (latestBatchRows[0]?.ordinal ?? 0) + 1,
      status: "published",
      engineerNote: input.engineerNote?.trim() || null,
      publishedByUserId: input.actor.id,
      publishedAt: now,
      createdAt: now,
      updatedAt: now,
    });
    await tx.insert(websiteStyleSamples).values(
      input.samples.map((sample, index) => ({
        id: randomUUID(),
        batchId,
        attachmentId: attachmentIds[index]!,
        label: sample.label.trim(),
        note: sample.note?.trim() || null,
        sortOrder: index + 1,
        createdAt: now,
      })),
    );
    await tx
      .update(websiteStyleWorkflows)
      .set({
        status: "awaiting_selection",
        currentBatchId: batchId,
        selectedSampleId: null,
        selectedByUserId: null,
        selectedAt: null,
        revision: workflow.revision + 1,
        updatedAt: now,
      })
      .where(eq(websiteStyleWorkflows.userId, ticket.userId));
    await tx
      .update(deliveryTickets)
      .set({
        status: "needs_information",
        publicSummary: "已提供三张官网图片风格样例，等待客户选择或退回重做。",
        revision: sql`${deliveryTickets.revision} + 1`,
        updatedByUserId: input.actor.id,
        updatedAt: now,
      })
      .where(eq(deliveryTickets.id, ticket.id));
    if (systemAdmin) {
      await writeWorkspaceAuditEvent(
        {
          actor: input.actor,
          action: "delivery_ticket.system_admin_override",
          targetType: "delivery_ticket",
          targetId: ticket.id,
          workspaceUserId: ticket.userId,
          metadata: {
            command: "publish_website_style_samples",
            projectAssignmentId: input.projectAssignmentId,
            workflowDomain: ticket.workflowDomain,
            assignedMemberId: ticket.assignedMemberId,
            fromStatus: ticket.status,
            toStatus: "needs_information",
            batchId,
            sampleCount: input.samples.length,
          },
          now,
        },
        tx,
      );
    }
    return {
      batchId,
      workflowRevision: workflow.revision + 1,
      status: "awaiting_selection" as const,
    };
  });
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
    const activeTicketRows = await db
      .select({ id: deliveryTickets.id })
      .from(deliveryTickets)
      .where(
        and(
          eq(
            deliveryTickets.assignedProjectAssignmentId,
            role.projectAssignmentId,
          ),
          inArray(deliveryTickets.status, ACTIVE_DELIVERY_STATUSES),
        ),
      )
      .limit(1);
    if (!activeTicketRows[0]) {
      throw new AuthServiceError("NOT_FOUND", "当前套餐未启用该工程师岗位");
    }
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
    websiteWorkspace,
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
      ? getDeliveryTicketWorkspace(role.customerUserId)
      : null,
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
            websiteWorkspace,
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

async function resolveQuestionCatalogReviewAccess(input: {
  executor: any;
  userId: number;
  questionId: string;
  lock?: boolean;
}) {
  const activeQuotaSelection = await resolveActiveDeliveryQuotaScopes({
    executor: input.executor,
    userId: input.userId,
  });
  if (!activeQuotaSelection) {
    return { allowed: false, questionScope: null } as const;
  }
  let questionQuery = input.executor
    .select({
      contractId: workspaceQuestions.contractId,
      quotaPeriodId: workspaceQuestions.quotaPeriodId,
    })
    .from(workspaceQuestions)
    .where(
      and(
        eq(workspaceQuestions.userId, input.userId),
        eq(workspaceQuestions.id, input.questionId),
      ),
    )
    .limit(1);
  if (input.lock) questionQuery = questionQuery.for("update");
  const questionRows = await questionQuery;
  const activeQuestionScope = questionRows[0]
    ? findActiveDeliveryQuotaScope({
        selection: activeQuotaSelection,
        record: questionRows[0],
      })
    : null;
  if (!activeQuestionScope) {
    return { allowed: false, questionScope: null } as const;
  }
  const questionScope = deliveryQuestionWorkflowScope(activeQuestionScope);
  let ticketQuery = input.executor
    .select({ status: deliveryTickets.status })
    .from(deliveryTickets)
    .where(
      and(
        eq(deliveryTickets.userId, input.userId),
        deliveryTicketQuestionScopeCondition(questionScope),
        eq(deliveryTickets.operation, "question_catalog"),
        inArray(deliveryTickets.status, [
          ...ACTIVE_DELIVERY_STATUSES,
          "completed",
        ]),
      ),
    );
  if (input.lock) ticketQuery = ticketQuery.for("update");
  const ticketRows = await ticketQuery;
  const milestoneRows = await input.executor
    .select({ id: deliveryWorkflowMilestones.id })
    .from(deliveryWorkflowMilestones)
    .where(
      and(
        eq(deliveryWorkflowMilestones.userId, input.userId),
        eq(deliveryWorkflowMilestones.operation, "question_catalog"),
        deliveryWorkflowMilestoneScopeCondition(questionScope),
      ),
    )
    .limit(1);
  return {
    allowed: questionCatalogReviewAllowed({
      progressiveLuxury: questionScope.progressiveLuxury,
      hasActiveCatalog: ticketRows.some((row: { status: string }) =>
        ACTIVE_DELIVERY_STATUSES.includes(row.status as any),
      ),
      hasCompletedCatalog: ticketRows.some(
        (row: { status: string }) => row.status === "completed",
      ),
      hasReusableCatalogMilestone: Boolean(milestoneRows[0]),
    }),
    questionScope,
  } as const;
}

export async function approveMyCustomerQuestionSelection(input: {
  actor: AuthenticatedUser;
  projectAssignmentId: string;
  questionId: string;
  expectedRevision: number;
  category?: WorkspaceQuestionCategory;
}) {
  const role = await assertDeliveryProjectContext(input);
  if (role.roleType !== "monitoring_optimization_engineer") {
    throw new AuthServiceError(
      "INVALID_CREDENTIAL",
      "只有问题监控与优化岗位工作台可以审核客户提交的问题",
    );
  }
  const db = await requireDb();
  try {
    const approval = await db.transaction(async (tx) => {
      const reconcileState: {
        question: InitialMonitoringQuestionSelection | null;
      } = { question: null };
      await tx
        .select({ id: deliveryProjectAssignments.id })
        .from(deliveryProjectAssignments)
        .where(eq(deliveryProjectAssignments.id, input.projectAssignmentId))
        .limit(1)
        .for("update");
      const lockedRole = await assertDeliveryProjectContext({
        actor: input.actor,
        projectAssignmentId: input.projectAssignmentId,
        expectedRoleType: "monitoring_optimization_engineer",
        executor: tx,
      });
      const catalogAccess = await resolveQuestionCatalogReviewAccess({
        executor: tx,
        userId: lockedRole.customerUserId,
        questionId: input.questionId,
        lock: true,
      });
      if (!catalogAccess.allowed) {
        throw new AuthServiceError(
          "CONFLICT",
          "配置品牌词库需求尚未解锁、完成或形成可复用里程碑",
        );
      }
      const question = await approveWorkspaceQuestionSelection(
        {
          userId: lockedRole.customerUserId,
          questionId: input.questionId,
          expectedRevision: input.expectedRevision,
          category: input.category,
          actorUserId: input.actor.id,
        },
        {
          executor: tx,
          afterWrite: async (executor, approvedQuestion) => {
            reconcileState.question = approvedQuestion;
            const reviewRows = await executor
              .select()
              .from(deliveryTickets)
              .where(
                and(
                  eq(deliveryTickets.userId, lockedRole.customerUserId),
                  eq(deliveryTickets.sourceQuestionId, approvedQuestion.id),
                  eq(deliveryTickets.operation, "question_maintenance"),
                  eq(deliveryTickets.category, "question_review"),
                  inArray(deliveryTickets.status, ACTIVE_DELIVERY_STATUSES),
                ),
              )
              .limit(1)
              .for("update");
            const review = reviewRows[0];
            if (review) {
              const now = new Date();
              const message = "自主填写问题已通过专业审核并进入当前服务。";
              await executor
                .update(deliveryTickets)
                .set({
                  status: "completed",
                  publicSummary: message,
                  technicalDedupeKey: null,
                  resolvedAt: now,
                  revision: sql`${deliveryTickets.revision} + 1`,
                  updatedByUserId: input.actor.id,
                  updatedAt: now,
                })
                .where(
                  and(
                    eq(deliveryTickets.id, review.id),
                    eq(deliveryTickets.revision, review.revision),
                  ),
                );
              await executor.insert(deliveryTicketEvents).values({
                id: randomUUID(),
                ticketId: review.id,
                userId: lockedRole.customerUserId,
                actorUserId: input.actor.id,
                actorRole:
                  input.actor.role === "admin" ? "admin" : "delivery_member",
                actorContext: {
                  projectAssignmentId: lockedRole.projectAssignmentId,
                  customerUserId: lockedRole.customerUserId,
                  roleType: lockedRole.roleType,
                },
                kind: "status_change",
                visibility: "customer",
                message,
                fromStatus: review.status,
                toStatus: "completed",
                createdAt: now,
              });
            }
          },
        },
      );
      return {
        question,
        reconcileQuestion: reconcileState.question,
      };
    });
    if (!approval.reconcileQuestion) {
      throw new AuthServiceError("CONFLICT", "问题审核结果缺少当前服务范围");
    }
    await reconcileInitialMonitoringAfterQuestionSelection({
      question: approval.reconcileQuestion,
      actorUserId: input.actor.id,
    });
    return approval.question;
  } catch (error) {
    if (error instanceof ServiceEntitlementError) {
      throw new AuthServiceError("CONFLICT", error.message);
    }
    throw error;
  }
}

export async function rejectMyCustomerQuestionSelection(input: {
  actor: AuthenticatedUser;
  projectAssignmentId: string;
  questionId: string;
  expectedRevision: number;
  reason: string;
}) {
  const reason = input.reason.trim();
  if (!reason) {
    throw new AuthServiceError("CONFLICT", "拒绝时必须填写原因");
  }
  const db = await requireDb();
  return db.transaction(async (tx) => {
    // Keep the assignment authorization and the rejection write in one lock
    // scope. Otherwise a reassigned engineer could race the authorization
    // read and still end the customer's review ticket afterward.
    await tx
      .select({ id: deliveryProjectAssignments.id })
      .from(deliveryProjectAssignments)
      .where(eq(deliveryProjectAssignments.id, input.projectAssignmentId))
      .limit(1)
      .for("update");
    const role = await assertDeliveryProjectContext({
      actor: input.actor,
      projectAssignmentId: input.projectAssignmentId,
      expectedRoleType: "monitoring_optimization_engineer",
      executor: tx,
    });
    const catalogAccess = await resolveQuestionCatalogReviewAccess({
      executor: tx,
      userId: role.customerUserId,
      questionId: input.questionId,
      lock: true,
    });
    if (!catalogAccess.allowed || !catalogAccess.questionScope) {
      throw new AuthServiceError(
        "CONFLICT",
        "配置品牌词库需求尚未解锁、完成或形成可复用里程碑",
      );
    }
    const questionRows = await tx
      .select()
      .from(workspaceQuestions)
      .where(
        and(
          eq(workspaceQuestions.id, input.questionId),
          eq(workspaceQuestions.userId, role.customerUserId),
          workspaceQuestionDeliveryScopeCondition(catalogAccess.questionScope),
        ),
      )
      .limit(1)
      .for("update");
    const question = questionRows[0];
    if (
      !question ||
      question.status !== "candidate" ||
      question.selectionApprovalStatus !== "pending" ||
      question.revision !== input.expectedRevision
    ) {
      throw new AuthServiceError("CONFLICT", "待审核问题已变化，请刷新后重试");
    }
    const reviewRows = await tx
      .select()
      .from(deliveryTickets)
      .where(
        and(
          eq(deliveryTickets.userId, role.customerUserId),
          eq(deliveryTickets.sourceQuestionId, question.id),
          eq(deliveryTickets.operation, "question_maintenance"),
          eq(deliveryTickets.category, "question_review"),
          inArray(deliveryTickets.status, ACTIVE_DELIVERY_STATUSES),
        ),
      )
      .limit(1)
      .for("update");
    const review = reviewRows[0];
    if (!review) {
      throw new AuthServiceError("NOT_FOUND", "对应的问题审核需求不存在");
    }
    const now = new Date();
    const publicSummary = `自主填写问题未通过专业审核：${reason}`;
    await tx
      .update(workspaceQuestions)
      .set({
        status: "archived",
        selectionApprovalStatus: "not_requested",
        locked: false,
        revision: sql`${workspaceQuestions.revision} + 1`,
        updatedAt: now,
      })
      .where(
        and(
          eq(workspaceQuestions.id, question.id),
          eq(workspaceQuestions.revision, input.expectedRevision),
        ),
      );
    await tx
      .update(deliveryTickets)
      .set({
        status: "rejected",
        publicSummary,
        technicalDedupeKey: null,
        resolvedAt: now,
        revision: sql`${deliveryTickets.revision} + 1`,
        updatedByUserId: input.actor.id,
        updatedAt: now,
      })
      .where(eq(deliveryTickets.id, review.id));
    await tx.insert(deliveryTicketEvents).values({
      id: randomUUID(),
      ticketId: review.id,
      userId: role.customerUserId,
      actorUserId: input.actor.id,
      actorRole: input.actor.role === "admin" ? "admin" : "delivery_member",
      actorContext: {
        projectAssignmentId: role.projectAssignmentId,
        customerUserId: role.customerUserId,
        roleType: role.roleType,
      },
      kind: "status_change",
      visibility: "customer",
      message: publicSummary,
      fromStatus: review.status,
      toStatus: "rejected",
      createdAt: now,
    });
    if (input.actor.role === "admin") {
      await writeWorkspaceAuditEvent(
        {
          actor: input.actor,
          action: "delivery_ticket.system_admin_override",
          targetType: "delivery_ticket",
          targetId: review.id,
          workspaceUserId: role.customerUserId,
          metadata: {
            command: "reject_question_selection",
            projectAssignmentId: role.projectAssignmentId,
            questionId: question.id,
            reason,
          },
          now,
        },
        tx,
      );
    }
    return { success: true as const, revision: question.revision + 1 };
  });
}

const MEMBER_TICKET_TRANSITIONS: Record<string, readonly string[]> = {
  submitted: ["in_progress", "needs_information", "rejected", "cancelled"],
  scheduled: ["in_progress", "cancelled"],
  in_progress: ["needs_information", "completed", "rejected", "cancelled"],
  needs_information: ["in_progress", "cancelled"],
};

type DeliveryExecutionTransitionStatus =
  | "in_progress"
  | "needs_information"
  | "completed"
  | "rejected"
  | "cancelled";

export function assertGenericDeliveryTicketTransition(input: {
  operation: string | null;
  nextStatus: DeliveryExecutionTransitionStatus;
}) {
  if (input.operation === "site_rebuild") {
    throw new AuthServiceError(
      "CONFLICT",
      "官网重制需求必须使用“通过重置需求”专用操作。",
    );
  }
  if (
    input.operation === "brand_tracking_setup" &&
    ["rejected", "cancelled"].includes(input.nextStatus)
  ) {
    throw new AuthServiceError(
      "CONFLICT",
      "舆情监控启用需求不能拒绝或取消；请完成客户独立凭证配置后显式完成",
    );
  }
  if (input.operation === "question_maintenance") {
    throw new AuthServiceError(
      "CONFLICT",
      "问题与应答逻辑维护必须使用专用审批操作",
    );
  }
  if (
    input.operation === "website_style_samples" &&
    input.nextStatus === "completed"
  ) {
    throw new AuthServiceError(
      "CONFLICT",
      "官网风格样例必须由客户通过专用选择操作确认，不能直接完成需求",
    );
  }
  if (
    input.operation === "website_build" &&
    (input.nextStatus === "rejected" || input.nextStatus === "cancelled")
  ) {
    throw new AuthServiceError(
      "CONFLICT",
      "官网构建工单不能拒绝或取消；如需客户补充资料，请设为等待补充后继续处理",
    );
  }
}

export function assertDeliveryCompletionSummary(input: {
  nextStatus: DeliveryExecutionTransitionStatus;
  message?: string;
}) {
  if (input.nextStatus === "completed" && !input.message?.trim()) {
    throw new AuthServiceError(
      "CONFLICT",
      "完成需求前必须填写客户可见的结果摘要",
    );
  }
  if (
    input.nextStatus === "completed" &&
    input.message &&
    deliverySummaryLooksLikeCredentialSecret(input.message)
  ) {
    throw new AuthServiceError(
      "CONFLICT",
      "结果摘要疑似包含密钥或令牌，请仅填写已配置、已验证等非敏感结论",
    );
  }
}

export function assertLegacyDeliverySummaryClose(input: {
  nextStatus: DeliveryExecutionTransitionStatus;
  message?: string;
  publicUrl?: string;
  previewVerified?: boolean;
  handoff?: DeliveryTicketHandoff;
}) {
  const message = input.message?.trim() || "";
  if (input.nextStatus !== "completed") {
    throw new AuthServiceError(
      "CONFLICT",
      "历史需求只支持填写非敏感摘要后关闭",
    );
  }
  if (
    input.publicUrl !== undefined ||
    input.previewVerified !== undefined ||
    input.handoff !== undefined
  ) {
    throw new AuthServiceError(
      "CONFLICT",
      "历史需求关闭时不能提交链接、验收标记或结构化交接数据",
    );
  }
  if (!message) {
    throw new AuthServiceError("CONFLICT", "关闭历史需求时必须填写结果摘要");
  }
  if (deliverySummaryLooksLikeCredentialSecret(message)) {
    throw new AuthServiceError(
      "CONFLICT",
      "结果摘要疑似包含密钥或令牌，请仅填写已配置、已验证等非敏感结论",
    );
  }
}

function submittedDeliveryHandoffKeys(
  handoff: DeliveryTicketHandoff | undefined,
) {
  if (!handoff) return [] as Array<keyof DeliveryTicketHandoff>;
  return (Object.keys(handoff) as Array<keyof DeliveryTicketHandoff>).filter(
    (key) => handoff[key] !== undefined,
  );
}

function submittedDeliveryEvidencePaths(input: {
  message?: string;
  publicUrl?: string;
  previewVerified?: boolean;
  handoff?: DeliveryTicketHandoff;
}) {
  const paths: string[] = [];
  if (input.message !== undefined) paths.push("message");
  if (input.publicUrl !== undefined) paths.push("publicUrl");
  if (input.previewVerified !== undefined) paths.push("previewVerified");
  for (const key of submittedDeliveryHandoffKeys(input.handoff)) {
    paths.push(`handoff.${key}`);
  }
  return paths;
}

export function assertDeliveryCompletionContract(input: {
  operation: string | null;
  nextStatus: DeliveryExecutionTransitionStatus;
  message?: string;
  publicUrl?: string;
  previewVerified?: boolean;
  handoff?: DeliveryTicketHandoff;
}) {
  const handoffKeys = submittedDeliveryHandoffKeys(input.handoff);
  const spec = getDeliveryOperationSpec(input.operation);
  if (!spec) {
    assertLegacyDeliverySummaryClose(input);
    return;
  }
  if (spec.completion.mode === "system_readonly") {
    throw new AuthServiceError("CONFLICT", "该记录只能由系统流程关闭");
  }
  if (input.nextStatus !== "completed") {
    if (
      input.publicUrl !== undefined ||
      input.previewVerified !== undefined ||
      handoffKeys.length
    ) {
      throw new AuthServiceError(
        "CONFLICT",
        "处理中、待补充、拒绝或取消时只能填写说明，不能提交交付结果字段",
      );
    }
    return;
  }
  if (spec.completion.mode !== "form") {
    throw new AuthServiceError(
      "CONFLICT",
      "该需求必须使用专用处理流程，不能通过普通完成操作关闭",
    );
  }
  const allowedEvidence = new Set<string>(
    deliveryOperationAllowedEvidence(input.operation),
  );
  const disallowedPaths = submittedDeliveryEvidencePaths(input).filter(
    (path) => !allowedEvidence.has(path),
  );
  if (disallowedPaths.length) {
    throw new AuthServiceError(
      "CONFLICT",
      `当前需求不接收以下交付字段：${disallowedPaths.join("、")}`,
    );
  }
  const publicUrl = input.publicUrl?.trim();
  if (spec.completion.publicUrl === "hidden" && publicUrl) {
    throw new AuthServiceError("CONFLICT", "当前需求不接收公开链接");
  }
  if (spec.completion.publicUrl === "required" && !publicUrl) {
    throw new AuthServiceError("CONFLICT", "发布完成时必须登记公开链接");
  }
  if (
    spec.completion.previewVerification === "hidden" &&
    input.previewVerified
  ) {
    throw new AuthServiceError("CONFLICT", "当前需求不接收页面验收标记");
  }
  if (
    spec.completion.previewVerification === "required" &&
    input.previewVerified !== true
  ) {
    throw new AuthServiceError(
      "CONFLICT",
      "完成官网构建前必须确认已核验用户实际页面",
    );
  }
  if (
    input.operation === "channel_distribution" &&
    !input.handoff?.targetMedia?.trim()
  ) {
    throw new AuthServiceError(
      "CONFLICT",
      "完成渠道分发前必须选择实际发布媒体",
    );
  }
  if (
    ["initial_monitoring", "monitoring_import", "monitoring_retest"].includes(
      input.operation || "",
    ) &&
    !input.handoff?.monitoringBatchKey?.trim()
  ) {
    throw new AuthServiceError(
      "CONFLICT",
      "完成监控需求前必须绑定已发布的正式监控批次",
    );
  }
  if (
    input.operation === "stage_report" &&
    typeof input.handoff?.needsFurtherOptimization !== "boolean"
  ) {
    throw new AuthServiceError(
      "CONFLICT",
      "完成阶段报告前必须明确是否需要继续优化",
    );
  }
  if (
    input.operation === "response_logic" &&
    (!Number.isInteger(input.handoff?.responseLogicRevision) ||
      Number(input.handoff?.responseLogicRevision) < 1)
  ) {
    throw new AuthServiceError("CONFLICT", "完成应答逻辑前必须登记正式版本");
  }
  if (
    (input.operation === "content_asset_publish" ||
      [
        "company_facts",
        "product_case_docs",
        "industry_news",
        "company_news",
        "faq_content",
      ].includes(input.operation || "")) &&
    !input.handoff?.contentAssetIds?.some((id) => id.trim())
  ) {
    throw new AuthServiceError(
      "CONFLICT",
      "完成内容交付前必须绑定正式内容资产 ID",
    );
  }
  if (
    input.operation === "domain_application" &&
    !input.handoff?.domain?.trim()
  ) {
    throw new AuthServiceError("CONFLICT", "完成域名需求前必须填写客户域名");
  }
  if (
    input.operation === "icp_filing" &&
    typeof input.handoff?.icpNotRequired !== "boolean"
  ) {
    throw new AuthServiceError("CONFLICT", "完成 ICP 备案前必须明确备案结果");
  }
  if (
    input.operation === "site_check" &&
    !input.handoff?.siteCheck?.source?.trim()
  ) {
    throw new AuthServiceError(
      "CONFLICT",
      "站点检查必须登记被检查页面或检查来源",
    );
  }
  assertDeliveryCompletionEvidence({
    operation: input.operation,
    nextStatus: input.nextStatus,
    linkRequired: spec.completion.publicUrl === "required",
    publicUrl,
    previewVerified: input.previewVerified,
  });
}

export function assertDeliveryCompletionEvidence(input: {
  operation: string | null;
  nextStatus: DeliveryExecutionTransitionStatus;
  linkRequired: boolean;
  publicUrl?: string;
  previewVerified?: boolean;
}) {
  if (input.nextStatus !== "completed") return;
  if (input.linkRequired && !input.publicUrl) {
    throw new AuthServiceError("CONFLICT", "发布完成时必须登记公开链接");
  }
  if (input.publicUrl) {
    let parsed: URL;
    try {
      parsed = new URL(input.publicUrl);
    } catch {
      throw new AuthServiceError(
        "CONFLICT",
        "公开链接必须是有效的 http(s) 地址",
      );
    }
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      throw new AuthServiceError(
        "CONFLICT",
        "公开链接必须是有效的 http(s) 地址",
      );
    }
  }
  if (input.operation === "website_build" && input.previewVerified !== true) {
    throw new AuthServiceError(
      "CONFLICT",
      "完成官网构建前必须确认已核验用户实际页面",
    );
  }
}

export function deriveDeliveryExecutionTransition(input: {
  currentQuotaState: "reserved" | "consumed" | "released";
  scheduledAt: Date | null;
  quotaReleasedAt: Date | null;
  technicalDedupeKey: string | null;
  nextStatus: DeliveryExecutionTransitionStatus;
  now: Date;
}) {
  const quotaState = deriveTicketQuotaTransition({
    currentState: input.currentQuotaState,
    scheduledAt: input.scheduledAt,
    nextStatus: input.nextStatus,
  });
  const terminal = ["completed", "rejected", "cancelled"].includes(
    input.nextStatus,
  );
  const hasEnteredExecution = ["in_progress", "completed"].includes(
    input.nextStatus,
  );
  return {
    quotaState,
    scheduledAt:
      hasEnteredExecution && !input.scheduledAt ? input.now : input.scheduledAt,
    quotaReleasedAt:
      quotaState === "released" && input.currentQuotaState !== "released"
        ? input.now
        : input.quotaReleasedAt,
    technicalDedupeKey: terminal ? null : input.technicalDedupeKey,
    resolvedAt: terminal ? input.now : null,
  };
}

export function monitoringRetestTechnicalDedupeKey(
  sourceQuestionId: string,
  quotaScopeKey?: string,
) {
  const normalizedSourceQuestionId = sourceQuestionId.trim();
  if (!normalizedSourceQuestionId) {
    throw new AuthServiceError("CONFLICT", "效果复测必须绑定来源问题 ID");
  }
  return `monitoring-retest:${createHash("sha256")
    .update(
      quotaScopeKey
        ? `${quotaScopeKey}\u0000${normalizedSourceQuestionId}`
        : normalizedSourceQuestionId,
    )
    .digest("hex")
    .slice(0, 46)}`;
}

export async function createMonitoringRetestTicket(input: {
  executor: any;
  sourceTicket: typeof deliveryTickets.$inferSelect;
  actorUserId: number;
}) {
  const sourceQuestionId = input.sourceTicket.sourceQuestionId?.trim();
  if (!sourceQuestionId) return null;
  const activeQuotaSelection = await resolveActiveDeliveryQuotaScopes({
    executor: input.executor,
    userId: input.sourceTicket.userId,
  });
  const currentScope = activeQuotaSelection
    ? selectActiveDeliveryQuotaScope({
        selection: activeQuotaSelection,
        record: input.sourceTicket,
      })
    : null;
  if (!currentScope) return null;
  const questionScope = deliveryQuestionWorkflowScope(currentScope);
  const technicalDedupeKey = monitoringRetestTechnicalDedupeKey(
    sourceQuestionId,
    questionScope.progressiveLuxury
      ? deliveryQuestionWorkflowScopeKey(questionScope)
      : undefined,
  );
  const owner = await getActiveDeliveryProjectOwner(
    input.executor,
    input.sourceTicket.userId,
    "monitoring_optimization_engineer",
  );
  if (!owner) return null;
  const existingRows = await input.executor
    .select({ id: deliveryTickets.id })
    .from(deliveryTickets)
    .where(
      and(
        eq(deliveryTickets.userId, input.sourceTicket.userId),
        eq(deliveryTickets.operation, "monitoring_retest"),
        eq(deliveryTickets.sourceQuestionId, sourceQuestionId),
        questionScope.progressiveLuxury
          ? deliveryTicketQuestionScopeCondition(questionScope)
          : undefined,
        inArray(deliveryTickets.status, ACTIVE_DELIVERY_STATUSES),
      ),
    )
    .limit(1)
    .for("update");
  if (existingRows[0]) return existingRows[0].id;
  const { contract, period } = currentScope;
  const proposedId = randomUUID();
  await input.executor
    .insert(deliveryTickets)
    .values({
      id: proposedId,
      userId: input.sourceTicket.userId,
      contractId: contract.id,
      quotaPeriodId: period.id,
      type: "website_operation",
      quotaPool: null,
      ordinal: 0,
      clientRequestId: randomUUID(),
      category: "monitoring_retest",
      title: "发布效果复测",
      description: "内容或官网页面已发布，请按原问题完成效果复测。",
      workflowDomain: "monitoring_optimization_engineer",
      operation: "monitoring_retest",
      assignedProjectAssignmentId: owner.projectAssignmentId,
      assignedMemberId: owner.engineerUserId,
      sourceQuestionId,
      monitoringBatchKey: input.sourceTicket.monitoringBatchKey,
      responseLogicRevision: input.sourceTicket.responseLogicRevision,
      contentAssetIds: input.sourceTicket.contentAssetIds,
      technicalDedupeKey,
      quotaState: "consumed",
      status: "submitted",
      createdByUserId: input.actorUserId,
      updatedByUserId: input.actorUserId,
    })
    .onDuplicateKeyUpdate({
      set: {
        technicalDedupeKey: sql`${deliveryTickets.technicalDedupeKey}`,
      },
    });
  const winnerRows = await input.executor
    .select({ id: deliveryTickets.id })
    .from(deliveryTickets)
    .where(
      and(
        eq(deliveryTickets.userId, input.sourceTicket.userId),
        eq(deliveryTickets.technicalDedupeKey, technicalDedupeKey),
        questionScope.progressiveLuxury
          ? deliveryTicketQuestionScopeCondition(questionScope)
          : undefined,
        inArray(deliveryTickets.status, ACTIVE_DELIVERY_STATUSES),
      ),
    )
    .limit(1)
    .for("update");
  const id = winnerRows[0]?.id;
  if (!id) {
    throw new AuthServiceError(
      "CONFLICT",
      "效果复测需求并发创建失败，请刷新后重试",
    );
  }
  if (id !== proposedId) return id;
  await input.executor.insert(deliveryTicketEvents).values({
    id: randomUUID(),
    ticketId: id,
    userId: input.sourceTicket.userId,
    actorUserId: input.actorUserId,
    actorRole: "system",
    kind: "created",
    visibility: "customer",
    message: "发布结果已登记，系统自动创建对应问题的效果复测需求。",
    toStatus: "submitted",
    createdAt: new Date(),
  });
  return id;
}

type DeliveryTicketHandoff = {
  monitoringBatchKey?: string;
  optimizationQuestionIds?: string[];
  responseLogicRevision?: number;
  contentAssetIds?: string[];
  targetMedia?: string;
  publishTargets?: Array<"media" | "website">;
  websiteOperation?:
    | "company_facts"
    | "product_case_docs"
    | "industry_news"
    | "company_news"
    | "faq_content";
  needsFurtherOptimization?: boolean;
  domain?: string;
  icpServiceCode?: string;
  icpProvince?: string;
  icpNumber?: string;
  icpNotRequired?: boolean;
  siteCheck?: {
    key: string;
    label: string;
    status: "passed" | "warning" | "failed" | "not_applicable";
    summary?: string;
    evidence?: string;
    source?: string;
  };
};

type WorkflowBillingTicket = Pick<
  typeof deliveryTickets.$inferSelect,
  | "id"
  | "rootTicketId"
  | "isWorkflowContainer"
  | "userId"
  | "contractId"
  | "quotaPeriodId"
>;

export function resolveAssignedWorkflowBillingScope(input: {
  sourceTicket: WorkflowBillingTicket;
  rootTicket?: WorkflowBillingTicket | null;
  latestPeriod?: { id: string; contractId: string } | null;
}) {
  const expectedRootTicketId =
    input.sourceTicket.rootTicketId ||
    (input.sourceTicket.isWorkflowContainer ? input.sourceTicket.id : null);
  if (!expectedRootTicketId) {
    if (!input.latestPeriod) {
      throw new AuthServiceError(
        "CONFLICT",
        "客户服务周期尚未配置，不能创建下游需求",
      );
    }
    return {
      rootTicketId: null,
      contractId: input.latestPeriod.contractId,
      quotaPeriodId: input.latestPeriod.id,
    };
  }

  const root = input.rootTicket;
  const sourceBelongsToRoot = input.sourceTicket.isWorkflowContainer
    ? input.sourceTicket.id === expectedRootTicketId
    : input.sourceTicket.rootTicketId === expectedRootTicketId;
  if (
    !root ||
    root.id !== expectedRootTicketId ||
    !root.isWorkflowContainer ||
    root.userId !== input.sourceTicket.userId ||
    !sourceBelongsToRoot
  ) {
    throw new AuthServiceError(
      "CONFLICT",
      "工单工作流根关系无效，请联系系统管理员修复后重试",
    );
  }
  return {
    rootTicketId: root.id,
    contractId: root.contractId,
    quotaPeriodId: root.quotaPeriodId,
  };
}

type WorkflowRootAttachmentMetadata = Pick<
  typeof deliveryTicketAttachments.$inferSelect,
  | "workspaceUserId"
  | "ownerUserId"
  | "kind"
  | "upstreamFileId"
  | "filename"
  | "mimeType"
  | "sizeBytes"
  | "sha256"
  | "purpose"
  | "authorization"
  | "copyrightNote"
>;

export function workflowChildAttachmentMetadataRows(input: {
  attachments: readonly WorkflowRootAttachmentMetadata[];
  ticketId: string;
  eventId: string;
  createdAt: Date;
}) {
  return input.attachments.map((attachment) => ({
    id: randomUUID(),
    ticketId: input.ticketId,
    eventId: input.eventId,
    workspaceUserId: attachment.workspaceUserId,
    ownerUserId: attachment.ownerUserId,
    kind: attachment.kind,
    upstreamFileId: attachment.upstreamFileId,
    filename: attachment.filename,
    mimeType: attachment.mimeType,
    sizeBytes: attachment.sizeBytes,
    sha256: attachment.sha256,
    purpose: attachment.purpose,
    authorization: attachment.authorization,
    copyrightNote: attachment.copyrightNote,
    createdAt: input.createdAt,
  }));
}

export function deliveryWorkflowStageKey(
  operation: string,
  discriminator?: string | null,
) {
  return `${operation}:${discriminator?.trim() || "default"}`;
}

export async function createAssignedWorkflowTicket(input: {
  executor: any;
  sourceTicket: typeof deliveryTickets.$inferSelect;
  actorUserId: number;
  actorRoleContext: {
    projectAssignmentId: string;
    customerUserId: number;
    roleType: DeliveryRoleType;
    eventActorRole: "admin" | "delivery_member";
  };
  workflowDomain: DeliveryRoleType;
  operation:
    | "response_logic"
    | "content_asset_publish"
    | "channel_distribution"
    | "company_facts"
    | "product_case_docs"
    | "industry_news"
    | "company_news"
    | "faq_content"
    | "stage_report"
    | "site_check";
  title: string;
  description: string;
  sourceQuestionId?: string | null;
  monitoringBatchKey?: string | null;
  responseLogicRevision?: number | null;
  contentAssetIds?: string[];
}) {
  const owner = await getActiveDeliveryProjectOwner(
    input.executor,
    input.sourceTicket.userId,
    input.workflowDomain,
  );
  if (!owner) {
    throw new AuthServiceError(
      "CONFLICT",
      `${DELIVERY_ROLE_LABELS[input.workflowDomain]}尚未配置主负责人，不能创建下游需求`,
    );
  }
  const sourceQuestionId =
    input.sourceQuestionId?.trim() ||
    input.sourceTicket.sourceQuestionId ||
    null;
  const rootTicketId =
    input.sourceTicket.rootTicketId ||
    (input.sourceTicket.isWorkflowContainer ? input.sourceTicket.id : null);
  const relationshipScoped = Boolean(rootTicketId);
  const workflowStageKey = deliveryWorkflowStageKey(
    input.operation,
    sourceQuestionId,
  );
  let billingScope: ReturnType<
    typeof resolveAssignedWorkflowBillingScope
  > | null = null;
  let fallbackQuestionScope: DeliveryQuestionWorkflowScope | null = null;
  if (rootTicketId) {
    const rootRows = await input.executor
      .select({
        id: deliveryTickets.id,
        rootTicketId: deliveryTickets.rootTicketId,
        isWorkflowContainer: deliveryTickets.isWorkflowContainer,
        userId: deliveryTickets.userId,
        contractId: deliveryTickets.contractId,
        quotaPeriodId: deliveryTickets.quotaPeriodId,
      })
      .from(deliveryTickets)
      .where(eq(deliveryTickets.id, rootTicketId))
      .limit(1)
      .for("update");
    billingScope = resolveAssignedWorkflowBillingScope({
      sourceTicket: input.sourceTicket,
      rootTicket: rootRows[0] ?? null,
    });
  } else {
    const activeQuotaSelection = await resolveActiveDeliveryQuotaScopes({
      executor: input.executor,
      userId: input.sourceTicket.userId,
    });
    const currentScope = activeQuotaSelection
      ? selectActiveDeliveryQuotaScope({
          selection: activeQuotaSelection,
          record: input.sourceTicket,
        })
      : null;
    fallbackQuestionScope = currentScope
      ? deliveryQuestionWorkflowScope(currentScope)
      : null;
    billingScope = resolveAssignedWorkflowBillingScope({
      sourceTicket: input.sourceTicket,
      latestPeriod: currentScope
        ? {
            id: currentScope.period.id,
            contractId: currentScope.contract.id,
          }
        : null,
    });
  }
  const existingRows = await input.executor
    .select({ id: deliveryTickets.id })
    .from(deliveryTickets)
    .where(
      and(
        eq(deliveryTickets.userId, input.sourceTicket.userId),
        eq(deliveryTickets.operation, input.operation),
        ...(relationshipScoped
          ? [eq(deliveryTickets.parentTicketId, input.sourceTicket.id)]
          : []),
        sourceQuestionId
          ? eq(deliveryTickets.sourceQuestionId, sourceQuestionId)
          : isNull(deliveryTickets.sourceQuestionId),
        ...(relationshipScoped
          ? []
          : [
              fallbackQuestionScope
                ? deliveryTicketQuestionScopeCondition(fallbackQuestionScope)
                : undefined,
              inArray(deliveryTickets.status, ACTIVE_DELIVERY_STATUSES),
            ]),
      ),
    )
    .limit(1);
  if (existingRows[0]) return existingRows[0].id;
  const id = randomUUID();
  const eventId = randomUUID();
  const now = new Date();
  await input.executor.insert(deliveryTickets).values({
    id,
    parentTicketId: input.sourceTicket.id,
    rootTicketId,
    workflowStageKey,
    isWorkflowContainer: false,
    userId: input.sourceTicket.userId,
    contractId: billingScope.contractId,
    quotaPeriodId: billingScope.quotaPeriodId,
    type:
      input.workflowDomain === "content_distribution_engineer"
        ? "content_asset"
        : "website_operation",
    quotaPool: null,
    ordinal: 0,
    clientRequestId: randomUUID(),
    category: input.operation,
    title: input.title,
    description: input.description,
    workflowDomain: input.workflowDomain,
    operation: input.operation,
    assignedProjectAssignmentId: owner.projectAssignmentId,
    assignedMemberId: owner.engineerUserId,
    sourceQuestionId,
    monitoringBatchKey:
      input.monitoringBatchKey ?? input.sourceTicket.monitoringBatchKey ?? null,
    responseLogicRevision:
      input.responseLogicRevision ??
      input.sourceTicket.responseLogicRevision ??
      null,
    contentAssetIds:
      input.contentAssetIds ?? input.sourceTicket.contentAssetIds ?? [],
    preferredMedia:
      input.operation === "channel_distribution"
        ? input.sourceTicket.preferredMedia
        : null,
    targetPage:
      input.operation === "site_check"
        ? input.sourceTicket.deliveryLinks?.[0]?.url ||
          input.sourceTicket.targetPage ||
          null
        : null,
    quotaState: "consumed",
    status: "submitted",
    createdByUserId: input.actorUserId,
    updatedByUserId: input.actorUserId,
    createdAt: now,
    updatedAt: now,
  });
  await input.executor.insert(deliveryTicketEvents).values({
    id: eventId,
    ticketId: id,
    userId: input.sourceTicket.userId,
    actorUserId: input.actorUserId,
    actorRole: input.actorRoleContext.eventActorRole,
    kind: "created",
    visibility: "internal",
    message: input.description,
    toStatus: "submitted",
    actorContext: {
      projectAssignmentId: input.actorRoleContext.projectAssignmentId,
      customerUserId: input.actorRoleContext.customerUserId,
      roleType: input.actorRoleContext.roleType,
      sourceTicketId: input.sourceTicket.id,
      assignedProjectAssignmentId: owner.projectAssignmentId,
      assignedMemberId: owner.engineerUserId,
    },
    createdAt: now,
  });
  if (rootTicketId) {
    const rootAttachments = await input.executor
      .select({
        workspaceUserId: deliveryTicketAttachments.workspaceUserId,
        ownerUserId: deliveryTicketAttachments.ownerUserId,
        kind: deliveryTicketAttachments.kind,
        upstreamFileId: deliveryTicketAttachments.upstreamFileId,
        filename: deliveryTicketAttachments.filename,
        mimeType: deliveryTicketAttachments.mimeType,
        sizeBytes: deliveryTicketAttachments.sizeBytes,
        sha256: deliveryTicketAttachments.sha256,
        purpose: deliveryTicketAttachments.purpose,
        authorization: deliveryTicketAttachments.authorization,
        copyrightNote: deliveryTicketAttachments.copyrightNote,
      })
      .from(deliveryTicketAttachments)
      .where(
        and(
          eq(deliveryTicketAttachments.ticketId, rootTicketId),
          eq(
            deliveryTicketAttachments.workspaceUserId,
            input.sourceTicket.userId,
          ),
        ),
      )
      .orderBy(asc(deliveryTicketAttachments.createdAt));
    const childAttachments = workflowChildAttachmentMetadataRows({
      attachments: rootAttachments,
      ticketId: id,
      eventId,
      createdAt: now,
    });
    if (childAttachments.length) {
      await input.executor
        .insert(deliveryTicketAttachments)
        .values(childAttachments);
    }
  }
  return id;
}

type WorkflowAggregateStatus = (typeof deliveryTickets.$inferSelect)["status"];

export function deriveWorkflowContainerStatus(
  statuses: readonly WorkflowAggregateStatus[],
): WorkflowAggregateStatus {
  if (!statuses.length) return "submitted";
  if (statuses.includes("rejected")) return "rejected";
  if (statuses.includes("cancelled")) return "cancelled";
  if (statuses.every((status) => status === "completed")) return "completed";
  if (statuses.includes("needs_information")) return "needs_information";
  if (statuses.includes("in_progress") || statuses.includes("completed")) {
    return "in_progress";
  }
  if (statuses.includes("scheduled")) return "scheduled";
  return "submitted";
}

function mergeWorkflowDeliveryLinks(
  values: Array<Array<{ label: string; url: string }> | null | undefined>,
) {
  const links = new Map<string, { label: string; url: string }>();
  for (const value of values) {
    for (const link of value ?? []) {
      const label = link?.label?.trim();
      const url = link?.url?.trim();
      if (label && url && !links.has(url)) links.set(url, { label, url });
    }
  }
  return [...links.values()];
}

type WorkflowGraphTicket = Pick<
  typeof deliveryTickets.$inferSelect,
  "id" | "parentTicketId" | "rootTicketId" | "isWorkflowContainer" | "userId"
>;

export function workflowContainerChildrenScope(input: {
  rootTicketId: string;
  userId: number;
}) {
  return and(
    eq(deliveryTickets.rootTicketId, input.rootTicketId),
    eq(deliveryTickets.userId, input.userId),
  );
}

export function assertWorkflowGraphIntegrity(input: {
  root: WorkflowGraphTicket;
  sourceTicket: Pick<WorkflowGraphTicket, "id" | "rootTicketId" | "userId">;
  children: readonly WorkflowGraphTicket[];
}) {
  const invalidRoot =
    !input.root.isWorkflowContainer ||
    input.sourceTicket.rootTicketId !== input.root.id ||
    input.sourceTicket.userId !== input.root.userId;
  const childIds = new Set(input.children.map((child) => child.id));
  const invalidChildren =
    childIds.size !== input.children.length ||
    !childIds.has(input.sourceTicket.id) ||
    input.children.some(
      (child) =>
        child.id === input.root.id ||
        child.isWorkflowContainer ||
        child.rootTicketId !== input.root.id ||
        child.userId !== input.root.userId ||
        !child.parentTicketId ||
        (child.parentTicketId !== input.root.id &&
          !childIds.has(child.parentTicketId)),
    );
  if (invalidRoot || invalidChildren) {
    throw new AuthServiceError(
      "CONFLICT",
      "工单工作流根关系无效，请联系系统管理员修复后重试",
    );
  }
}

async function syncWorkflowContainer(input: {
  executor: any;
  sourceTicket: typeof deliveryTickets.$inferSelect;
  actorUserId: number;
  actorRole: "admin" | "delivery_member";
  actorContext: {
    projectAssignmentId: string;
    customerUserId: number;
    roleType: DeliveryRoleType;
  };
  message?: string;
  now: Date;
}) {
  const rootTicketId = input.sourceTicket.rootTicketId;
  if (!rootTicketId) return null;
  const rootRows = await input.executor
    .select()
    .from(deliveryTickets)
    .where(eq(deliveryTickets.id, rootTicketId))
    .limit(1)
    .for("update");
  const root = rootRows[0];
  if (
    !root ||
    !root.isWorkflowContainer ||
    root.userId !== input.sourceTicket.userId
  ) {
    throw new AuthServiceError(
      "CONFLICT",
      "工单工作流根关系无效，请联系系统管理员修复后重试",
    );
  }
  const children = await input.executor
    .select({
      id: deliveryTickets.id,
      parentTicketId: deliveryTickets.parentTicketId,
      rootTicketId: deliveryTickets.rootTicketId,
      isWorkflowContainer: deliveryTickets.isWorkflowContainer,
      userId: deliveryTickets.userId,
      status: deliveryTickets.status,
      publicSummary: deliveryTickets.publicSummary,
      deliveryLinks: deliveryTickets.deliveryLinks,
      contentAssetIds: deliveryTickets.contentAssetIds,
    })
    .from(deliveryTickets)
    .where(
      workflowContainerChildrenScope({
        rootTicketId: root.id,
        userId: root.userId,
      }),
    );
  assertWorkflowGraphIntegrity({
    root,
    sourceTicket: input.sourceTicket,
    children,
  });
  const nextStatus = deriveWorkflowContainerStatus(
    children.map((child: { status: WorkflowAggregateStatus }) => child.status),
  );
  const deliveryLinks = mergeWorkflowDeliveryLinks([
    root.deliveryLinks,
    ...children.map(
      (child: { deliveryLinks: Array<{ label: string; url: string }> }) =>
        child.deliveryLinks,
    ),
  ]);
  const contentAssetIds = Array.from(
    new Set(
      children.flatMap(
        (child: { contentAssetIds: string[] }) => child.contentAssetIds ?? [],
      ),
    ),
  );
  const summary =
    input.message?.trim() ||
    [...children]
      .reverse()
      .find((child: { publicSummary: string | null }) =>
        Boolean(child.publicSummary?.trim()),
      )
      ?.publicSummary?.trim() ||
    root.publicSummary;
  const quotaState = deriveTicketQuotaTransition({
    currentState: root.quotaState,
    scheduledAt: root.scheduledAt,
    nextStatus,
  });
  const terminal = ["completed", "rejected", "cancelled"].includes(nextStatus);
  const started = ["in_progress", "completed"].includes(nextStatus);
  await input.executor
    .update(deliveryTickets)
    .set({
      status: nextStatus,
      quotaState,
      publicSummary: summary,
      deliveryLinks,
      contentAssetIds,
      scheduledAt: started && !root.scheduledAt ? input.now : root.scheduledAt,
      resolvedAt: terminal ? input.now : null,
      quotaReleasedAt:
        quotaState === "released" && root.quotaState !== "released"
          ? input.now
          : root.quotaReleasedAt,
      revision: sql`${deliveryTickets.revision} + 1`,
      updatedByUserId: input.actorUserId,
      updatedAt: input.now,
    })
    .where(eq(deliveryTickets.id, root.id));
  await input.executor.insert(deliveryTicketEvents).values({
    id: randomUUID(),
    ticketId: root.id,
    userId: root.userId,
    actorUserId: input.actorUserId,
    actorRole: input.actorRole,
    kind: root.status === nextStatus ? "delivery_result" : "status_change",
    visibility: "customer",
    message: summary,
    fromStatus: root.status,
    toStatus: nextStatus,
    actorContext: {
      ...input.actorContext,
      sourceTicketId: input.sourceTicket.id,
    },
    createdAt: input.now,
  });
  return { rootTicketId: root.id, status: nextStatus };
}

export async function ensureInitialMonitoringWorkflowTicket(input: {
  executor: any;
  sourceTicket: Pick<
    typeof deliveryTickets.$inferSelect,
    "userId" | "contractId" | "quotaPeriodId"
  > &
    Partial<Pick<typeof deliveryTickets.$inferSelect, "id">>;
  actorUserId: number;
}) {
  const now = new Date();
  const activeQuotaSelection = await resolveActiveDeliveryQuotaScopes({
    executor: input.executor,
    userId: input.sourceTicket.userId,
    now,
  });
  const currentScope = activeQuotaSelection
    ? findActiveDeliveryQuotaScope({
        selection: activeQuotaSelection,
        record: input.sourceTicket,
      })
    : null;
  if (!currentScope) {
    return { id: null, created: false as const };
  }
  const questionScope = deliveryQuestionWorkflowScope(currentScope);
  if (
    questionScope.progressiveLuxury &&
    input.sourceTicket.contractId !== questionScope.contractId
  ) {
    return { id: null, created: false as const };
  }
  const sourceQuestionScope = await resolveDeliveryTicketQuestionWorkflowScope({
    executor: input.executor,
    ticket: input.sourceTicket,
  });
  const dependencyScope = questionScope.progressiveLuxury
    ? questionScope
    : (sourceQuestionScope ?? questionScope);
  const [
    existingTickets,
    completedCatalogRows,
    initialMonitoringMilestoneRows,
    catalogMilestoneRows,
    approvedQuestionRows,
  ] = await Promise.all([
    input.executor
      .select({
        id: deliveryTickets.id,
        contractId: deliveryTickets.contractId,
        quotaPeriodId: deliveryTickets.quotaPeriodId,
        status: deliveryTickets.status,
        revision: deliveryTickets.revision,
      })
      .from(deliveryTickets)
      .where(
        reusableInitialMonitoringTicketScope({
          userId: input.sourceTicket.userId,
        }),
      )
      .orderBy(desc(deliveryTickets.updatedAt), desc(deliveryTickets.id))
      .limit(10)
      .for("update"),
    input.executor
      .select({ id: deliveryTickets.id })
      .from(deliveryTickets)
      .where(
        and(
          eq(deliveryTickets.userId, input.sourceTicket.userId),
          deliveryTicketQuestionScopeCondition(dependencyScope),
          eq(deliveryTickets.operation, "question_catalog"),
          eq(deliveryTickets.status, "completed"),
        ),
      )
      .limit(1),
    input.executor
      .select({
        id: deliveryWorkflowMilestones.id,
        completedAt: deliveryWorkflowMilestones.completedAt,
      })
      .from(deliveryWorkflowMilestones)
      .where(
        and(
          eq(deliveryWorkflowMilestones.userId, input.sourceTicket.userId),
          eq(deliveryWorkflowMilestones.operation, "initial_monitoring"),
          questionScope.progressiveLuxury
            ? deliveryWorkflowMilestoneScopeCondition(questionScope)
            : undefined,
        ),
      )
      .limit(1),
    input.executor
      .select({
        id: deliveryWorkflowMilestones.id,
        completedAt: deliveryWorkflowMilestones.completedAt,
      })
      .from(deliveryWorkflowMilestones)
      .where(
        and(
          eq(deliveryWorkflowMilestones.userId, input.sourceTicket.userId),
          eq(deliveryWorkflowMilestones.operation, "question_catalog"),
          deliveryWorkflowMilestoneScopeCondition(dependencyScope),
        ),
      )
      .limit(1),
    input.executor
      .select({ id: workspaceQuestions.id })
      .from(workspaceQuestions)
      .where(
        and(
          eq(workspaceQuestions.userId, input.sourceTicket.userId),
          workspaceQuestionDeliveryScopeCondition(dependencyScope),
          eq(workspaceQuestions.status, "selected"),
          eq(workspaceQuestions.selectionApprovalStatus, "approved"),
        ),
      )
      .limit(1),
  ]);
  if (initialMonitoringMilestoneRows[0]) {
    return { id: null, created: false as const };
  }

  const ticketMatchesCurrentScope = (
    ticket: (typeof existingTickets)[number],
  ) =>
    questionScope.progressiveLuxury
      ? ticket.contractId === questionScope.contractId
      : true;
  const scopedExistingTickets = existingTickets.filter(
    ticketMatchesCurrentScope,
  );
  const completedTicket = scopedExistingTickets.find(
    (ticket: (typeof scopedExistingTickets)[number]) =>
      ticket.status === "completed",
  );
  if (completedTicket) {
    return { id: completedTicket.id, created: false as const };
  }
  const dependencySatisfied =
    Boolean(completedCatalogRows[0] || catalogMilestoneRows[0]) &&
    Boolean(approvedQuestionRows[0]);
  if (!dependencySatisfied) {
    return { id: null, created: false as const };
  }
  const owner = await getActiveDeliveryProjectOwner(
    input.executor,
    input.sourceTicket.userId,
    "monitoring_optimization_engineer",
  );
  if (!owner) {
    // Question approval and keyword-catalog completion are independent
    // business writes. A missing assignee must never roll either one back;
    // assignment reconciliation will call this helper again later.
    return { id: null, created: false as const };
  }
  const reusableTicket = scopedExistingTickets.find(
    (ticket: (typeof scopedExistingTickets)[number]) =>
      initialMonitoringExistingTicketAction({
        status: ticket.status,
        ticketQuotaPeriodId: ticket.quotaPeriodId,
        sourceQuotaPeriodId: dependencyScope.quotaPeriodId,
        dependencySatisfied,
      }) === "reuse",
  );
  const staleTickets = existingTickets.filter(
    (ticket: (typeof existingTickets)[number]) =>
      ACTIVE_DELIVERY_STATUSES.includes(ticket.status as any) &&
      (!ticketMatchesCurrentScope(ticket) ||
        initialMonitoringExistingTicketAction({
          status: ticket.status,
          ticketQuotaPeriodId: ticket.quotaPeriodId,
          sourceQuotaPeriodId: dependencyScope.quotaPeriodId,
          dependencySatisfied,
        }) === "replace_stale"),
  );
  for (const staleTicket of staleTickets) {
    await input.executor
      .update(deliveryTickets)
      .set({
        status: "cancelled",
        technicalDedupeKey: null,
        resolvedAt: now,
        revision: sql`${deliveryTickets.revision} + 1`,
        updatedByUserId: input.actorUserId,
        updatedAt: now,
      })
      .where(
        and(
          eq(deliveryTickets.id, staleTicket.id),
          eq(deliveryTickets.revision, staleTicket.revision),
          inArray(deliveryTickets.status, ACTIVE_DELIVERY_STATUSES),
        ),
      );
    await input.executor.insert(deliveryTicketEvents).values({
      id: randomUUID(),
      ticketId: staleTicket.id,
      userId: input.sourceTicket.userId,
      actorUserId: input.actorUserId,
      actorRole: "system",
      kind: "status_change",
      visibility: "customer",
      message:
        "旧周期提前创建的首次问题监控需求已关闭；当前周期满足前置条件后已重新创建。",
      fromStatus: staleTicket.status,
      toStatus: "cancelled",
      actorContext: {
        projectAssignmentId: owner.projectAssignmentId,
        customerUserId: input.sourceTicket.userId,
        roleType: "monitoring_optimization_engineer",
        ...(input.sourceTicket.id
          ? { sourceTicketId: input.sourceTicket.id }
          : {}),
        assignedProjectAssignmentId: owner.projectAssignmentId,
        assignedMemberId: owner.engineerUserId,
      },
      createdAt: now,
    });
  }
  if (reusableTicket) {
    return { id: reusableTicket.id, created: false as const };
  }

  const ticketId = randomUUID();
  await input.executor
    .insert(deliveryTickets)
    .values({
      id: ticketId,
      userId: input.sourceTicket.userId,
      contractId: currentScope.contract.id,
      quotaPeriodId: currentScope.period.id,
      type: "website_operation",
      quotaPool: null,
      ordinal: 0,
      clientRequestId: randomUUID(),
      category: "initial_monitoring",
      title: "执行首次问题监控",
      description:
        "品牌词库配置已经完成，且至少一条优化问题已确认；请执行首次问题监控。",
      workflowDomain: "monitoring_optimization_engineer",
      operation: "initial_monitoring",
      assignedProjectAssignmentId: owner.projectAssignmentId,
      assignedMemberId: owner.engineerUserId,
      technicalDedupeKey: "initial-monitoring",
      quotaState: "consumed",
      status: "submitted",
      createdByUserId: input.actorUserId,
      updatedByUserId: input.actorUserId,
      createdAt: now,
      updatedAt: now,
    })
    .onDuplicateKeyUpdate({
      set: {
        technicalDedupeKey: sql`${deliveryTickets.technicalDedupeKey}`,
      },
    });
  const winnerRows = await input.executor
    .select({ id: deliveryTickets.id })
    .from(deliveryTickets)
    .where(
      and(
        eq(deliveryTickets.userId, input.sourceTicket.userId),
        eq(deliveryTickets.technicalDedupeKey, "initial-monitoring"),
        inArray(deliveryTickets.status, ACTIVE_DELIVERY_STATUSES),
      ),
    )
    .limit(1)
    .for("update");
  const winnerId = winnerRows[0]?.id;
  if (!winnerId) {
    throw new AuthServiceError(
      "CONFLICT",
      "首次问题监控需求并发创建失败，请刷新后重试",
    );
  }
  if (winnerId !== ticketId) {
    return { id: winnerId, created: false as const };
  }
  await input.executor.insert(deliveryTicketEvents).values({
    id: randomUUID(),
    ticketId: winnerId,
    userId: input.sourceTicket.userId,
    actorUserId: input.actorUserId,
    actorRole: "system",
    kind: "created",
    visibility: "customer",
    message: "优化问题已确认且品牌词库配置已完成，首次问题监控需求现已创建。",
    toStatus: "submitted",
    actorContext: {
      projectAssignmentId: owner.projectAssignmentId,
      customerUserId: input.sourceTicket.userId,
      roleType: "monitoring_optimization_engineer",
      ...(input.sourceTicket.id
        ? { sourceTicketId: input.sourceTicket.id }
        : {}),
      assignedProjectAssignmentId: owner.projectAssignmentId,
      assignedMemberId: owner.engineerUserId,
    },
    createdAt: now,
  });
  return { id: winnerId, created: true as const };
}

export async function ensureInitialMonitoringAfterQuestionSelection(input: {
  executor: any;
  question: Pick<
    typeof workspaceQuestions.$inferSelect,
    | "userId"
    | "contractId"
    | "quotaPeriodId"
    | "status"
    | "selectionApprovalStatus"
  >;
  actorUserId: number;
}) {
  if (
    input.question.status !== "selected" ||
    input.question.selectionApprovalStatus !== "approved"
  ) {
    return { id: null, created: false as const };
  }
  return ensureInitialMonitoringWorkflowTicket({
    executor: input.executor,
    sourceTicket: {
      userId: input.question.userId,
      contractId: input.question.contractId,
      quotaPeriodId: input.question.quotaPeriodId,
    },
    actorUserId: input.actorUserId,
  });
}

export type InitialMonitoringQuestionSelection = Pick<
  typeof workspaceQuestions.$inferSelect,
  | "userId"
  | "contractId"
  | "quotaPeriodId"
  | "status"
  | "selectionApprovalStatus"
>;

export async function reconcileInitialMonitoringForScope(input: {
  userId: number;
  contractId: string;
  quotaPeriodId: string;
  actorUserId: number;
}) {
  const db = await requireDb();
  return db.transaction((tx) =>
    ensureInitialMonitoringWorkflowTicket({
      executor: tx,
      sourceTicket: {
        userId: input.userId,
        contractId: input.contractId,
        quotaPeriodId: input.quotaPeriodId,
      },
      actorUserId: input.actorUserId,
    }),
  );
}

/**
 * Reconcile only after the question transaction has committed. This makes the
 * dependency reads current even when catalog completion and question approval
 * happen concurrently, and prevents monitoring-ticket failures from rolling
 * back the customer's selection itself.
 */
export async function reconcileInitialMonitoringAfterQuestionSelection(input: {
  question: InitialMonitoringQuestionSelection;
  actorUserId: number;
}) {
  if (
    input.question.status !== "selected" ||
    input.question.selectionApprovalStatus !== "approved"
  ) {
    return { id: null, created: false as const };
  }
  return reconcileInitialMonitoringForScope({
    userId: input.question.userId,
    contractId: input.question.contractId,
    quotaPeriodId: input.question.quotaPeriodId,
    actorUserId: input.actorUserId,
  });
}

/** Re-run the same idempotent handoff when a monitoring owner is assigned. */
export async function reconcileInitialMonitoringForCurrentService(input: {
  userId: number;
  actorUserId: number;
}) {
  const db = await requireDb();
  return db.transaction(async (tx) => {
    const selection = await resolveActiveDeliveryQuotaScopes({
      executor: tx,
      userId: input.userId,
    });
    const scope = selection
      ? selectActiveDeliveryQuotaScope({ selection })
      : null;
    if (!scope) return { id: null, created: false as const };
    return ensureInitialMonitoringWorkflowTicket({
      executor: tx,
      sourceTicket: {
        userId: input.userId,
        contractId: scope.contract.id,
        quotaPeriodId: scope.period.id,
      },
      actorUserId: input.actorUserId,
    });
  });
}

async function ensureWebsiteStyleWorkflowTicket(input: {
  executor: any;
  sourceTicket: typeof deliveryTickets.$inferSelect;
  actorUserId: number;
}) {
  const overseasDomainConfirmed =
    input.sourceTicket.operation === "domain_application";
  const existingWorkflow = await input.executor
    .select()
    .from(websiteStyleWorkflows)
    .where(eq(websiteStyleWorkflows.userId, input.sourceTicket.userId))
    .limit(1)
    .for("update");
  if (existingWorkflow[0]) return existingWorkflow[0].currentBatchId;

  const owner = await getActiveDeliveryProjectOwner(
    input.executor,
    input.sourceTicket.userId,
    "ai_operations_engineer",
  );
  if (!owner) {
    throw new AuthServiceError(
      "CONFLICT",
      overseasDomainConfirmed
        ? "域名已确认，但尚未分配 AI 运维工程师，无法创建官网风格样例任务"
        : "备案已通过，但尚未分配 AI 运维工程师，无法创建官网风格样例任务",
    );
  }
  const now = new Date();
  const ticketId = randomUUID();
  await input.executor.insert(websiteStyleWorkflows).values({
    userId: input.sourceTicket.userId,
    status: "waiting_samples",
    currentBatchId: null,
    selectedSampleId: null,
    selectedByUserId: null,
    selectedAt: null,
    revision: 1,
    createdAt: now,
    updatedAt: now,
  });
  await input.executor.insert(deliveryTickets).values({
    id: ticketId,
    userId: input.sourceTicket.userId,
    contractId: input.sourceTicket.contractId,
    quotaPeriodId: input.sourceTicket.quotaPeriodId,
    type: "website_operation",
    quotaPool: null,
    ordinal: 0,
    clientRequestId: randomUUID(),
    category: "website_style_samples",
    title: "提供 AI 专用官网图片风格样例",
    description: overseasDomainConfirmed
      ? "海外版企业域名已确认，请提供三张图片风格样例供客户选择；客户确认后系统会创建官网构建工单。"
      : "ICP备案已确认，请提供三张图片风格样例供客户选择；客户确认后系统会创建官网构建工单。",
    workflowDomain: "ai_operations_engineer",
    operation: "website_style_samples",
    assignedProjectAssignmentId: owner.projectAssignmentId,
    assignedMemberId: owner.engineerUserId,
    technicalDedupeKey: `website-style:${input.sourceTicket.userId}`,
    quotaState: "consumed",
    status: "submitted",
    createdByUserId: input.actorUserId,
    updatedByUserId: input.actorUserId,
    createdAt: now,
    updatedAt: now,
  });
  await input.executor.insert(deliveryTicketEvents).values({
    id: randomUUID(),
    ticketId,
    userId: input.sourceTicket.userId,
    actorUserId: input.actorUserId,
    actorRole: "system",
    kind: "created",
    visibility: "customer",
    message: overseasDomainConfirmed
      ? "海外版企业域名已确认，正在等待工程师提供三张官网图片风格样例。"
      : "备案结果已确认，正在等待工程师提供三张官网图片风格样例。",
    toStatus: "submitted",
    createdAt: now,
  });
  return ticketId;
}

const SITE_REBUILD_APPROVABLE_STATUSES = [
  "submitted",
  "needs_information",
  "scheduled",
  "in_progress",
] as const;

function deliveryMutationAffectedRows(result: unknown) {
  return Number(
    (Array.isArray(result)
      ? (result[0] as { affectedRows?: unknown } | undefined)?.affectedRows
      : (result as { affectedRows?: unknown } | undefined)?.affectedRows) ?? 0,
  );
}

export function siteOpsRebuildTerminalDisposition(input: {
  ticketStatus: string;
  resetState: SiteOpsRebuildResetState | null;
}) {
  if (input.resetState === "completed") {
    if (input.ticketStatus === "completed") return "completed_replay" as const;
    if (input.ticketStatus === "in_progress") return "complete" as const;
  }
  if (input.resetState === "invalidated") {
    if (input.ticketStatus === "cancelled") {
      return "invalidated_replay" as const;
    }
    if (input.ticketStatus === "in_progress") return "invalidate" as const;
  }
  return null;
}

export function siteOpsRebuildApprovalDisposition(input: {
  status: string;
  resetApplied: boolean;
  resetPending?: boolean;
  revision: number;
  expectedRevision: number;
}) {
  if (
    !SITE_REBUILD_APPROVABLE_STATUSES.includes(
      input.status as (typeof SITE_REBUILD_APPROVABLE_STATUSES)[number],
    )
  ) {
    throw new AuthServiceError(
      "CONFLICT",
      "当前官网重制需求已经结束，不能再次通过重置。",
    );
  }
  if (input.resetApplied && input.status === "in_progress") {
    return "replay" as const;
  }
  if (input.resetPending && input.status === "in_progress") {
    // The exact V4 operation must be inspected under lock: active states are
    // idempotent replays, while a narrowly retryable pre-mutation failure may
    // be CAS-requeued by a current administrator approval.
    return "pending_inspect" as const;
  }
  if (input.revision !== input.expectedRevision) {
    throw new AuthServiceError("CONFLICT", "需求已被更新，请刷新后重试");
  }
  return "approve" as const;
}

export async function approveMySiteOpsRebuild(input: {
  actor: AuthenticatedUser;
  projectAssignmentId: string;
  ticketId: string;
  expectedRevision: number;
}) {
  const eventActorRole = deliveryExecutionActorRole(input.actor);
  if (!eventActorRole) {
    throw new AuthServiceError(
      "INVALID_CREDENTIAL",
      "需要工程师或系统管理员权限",
    );
  }
  const systemAdmin = eventActorRole === "admin";
  const db = await requireDb();
  return db.transaction(async (tx) => {
    const ticketRows = await tx
      .select()
      .from(deliveryTickets)
      .where(eq(deliveryTickets.id, input.ticketId))
      .limit(1)
      .for("update");
    const ticket = ticketRows[0];
    if (
      !ticket ||
      ticket.operation !== "site_rebuild" ||
      ticket.workflowDomain !== "ai_operations_engineer" ||
      !ticket.assignedProjectAssignmentId ||
      (!systemAdmin && ticket.assignedMemberId !== input.actor.id)
    ) {
      throw new AuthServiceError(
        "NOT_FOUND",
        "官网重制需求不属于当前项目岗位或无权处理",
      );
    }
    if (ticket.assignedProjectAssignmentId !== input.projectAssignmentId) {
      throw new AuthServiceError("NOT_FOUND", "需求不属于当前客户项目岗位");
    }
    const role = await assertDeliveryProjectContext({
      actor: input.actor,
      projectAssignmentId: ticket.assignedProjectAssignmentId,
      customerUserId: ticket.userId,
      expectedRoleType: "ai_operations_engineer",
      executor: tx,
    });
    if (
      ticket.assignedProjectAssignmentId !== role.projectAssignmentId ||
      !deliveryRoleOwnsOperation(role.roleType, "site_rebuild")
    ) {
      throw new AuthServiceError("NOT_FOUND", "需求不属于当前客户项目岗位");
    }
    const resetOperationId = siteOpsRebuildResetOperationId(
      ticket.internalNote,
    );
    const resetOperationRows = resetOperationId
      ? await tx
          .select()
          .from(siteOperations)
          .where(eq(siteOperations.id, resetOperationId))
          .limit(1)
          .for("update")
      : [];
    const resetProjection = projectSiteOpsRebuildReset({
      ticketId: ticket.id,
      userId: ticket.userId,
      internalNote: ticket.internalNote,
      operation: resetOperationRows[0],
    });
    const terminalDisposition = siteOpsRebuildTerminalDisposition({
      ticketStatus: ticket.status,
      resetState: resetProjection.siteRebuildResetState,
    });
    if (
      terminalDisposition === "completed_replay" ||
      terminalDisposition === "invalidated_replay"
    ) {
      return {
        success: true as const,
        ticketId: ticket.id,
        status: ticket.status as "completed" | "cancelled",
        revision: ticket.revision,
        resetApplied: terminalDisposition === "completed_replay",
        resetPending: false as const,
        ...resetProjection,
      };
    }
    if (
      terminalDisposition === "complete" ||
      terminalDisposition === "invalidate"
    ) {
      const now = new Date();
      const completed = terminalDisposition === "complete";
      const terminalStatus = completed ? "completed" : "cancelled";
      const message = completed
        ? "官网重置已完成，企业知识库保持不变；客户可从知识库开始建站。"
        : "原官网重置申请已失效，项目状态已变化；请客户重新提交重置申请。";
      const terminalUpdate = await tx
        .update(deliveryTickets)
        .set({
          status: terminalStatus,
          publicSummary: message,
          quotaState: completed
            ? "consumed"
            : ticket.quotaState === "reserved"
              ? "released"
              : ticket.quotaState,
          quotaReleasedAt:
            !completed && ticket.quotaState === "reserved"
              ? now
              : ticket.quotaReleasedAt,
          technicalDedupeKey: null,
          resolvedAt: now,
          revision: ticket.revision + 1,
          updatedByUserId: input.actor.id,
          updatedAt: now,
        })
        .where(
          and(
            eq(deliveryTickets.id, ticket.id),
            eq(deliveryTickets.status, "in_progress"),
            eq(deliveryTickets.revision, ticket.revision),
          ),
        );
      if (deliveryMutationAffectedRows(terminalUpdate) !== 1) {
        throw new AuthServiceError(
          "CONFLICT",
          "需求已被更新，请刷新后重新检查官网重置状态",
        );
      }
      await tx.insert(deliveryTicketEvents).values({
        id: randomUUID(),
        ticketId: ticket.id,
        userId: ticket.userId,
        actorUserId: input.actor.id,
        actorRole: eventActorRole,
        kind: "status_change",
        visibility: "customer",
        message,
        fromStatus: ticket.status,
        toStatus: terminalStatus,
        actorContext: {
          projectAssignmentId: input.projectAssignmentId,
          customerUserId: role.customerUserId,
          roleType: role.roleType,
        },
        createdAt: now,
      });
      return {
        success: true as const,
        ticketId: ticket.id,
        status: terminalStatus,
        revision: ticket.revision + 1,
        resetApplied: completed,
        resetPending: false as const,
        ...resetProjection,
      };
    }
    const approvalDisposition = siteOpsRebuildApprovalDisposition({
      status: ticket.status,
      resetApplied: siteOpsRebuildResetApplied(ticket.internalNote),
      resetPending: siteOpsRebuildResetPending(ticket.internalNote),
      revision: ticket.revision,
      expectedRevision: input.expectedRevision,
    });
    if (approvalDisposition === "replay") {
      return {
        success: true as const,
        ticketId: ticket.id,
        status: "in_progress" as const,
        revision: ticket.revision,
        resetApplied: true as const,
        resetPending: false as const,
        ...resetProjection,
      };
    }
    const now = new Date();
    let approval: Awaited<ReturnType<typeof approveSiteOpsRebuildTicket>>;
    try {
      approval = await approveSiteOpsRebuildTicket(tx, {
        ticket,
        actorUserId: input.actor.id,
        now,
        reapply: siteOpsRebuildResetApplied(ticket.internalNote),
        allowPendingRetry: ticket.revision === input.expectedRevision,
      });
    } catch (error) {
      if (error instanceof SiteOpsRebuildTicketError) {
        throw new AuthServiceError("CONFLICT", error.message);
      }
      throw error;
    }
    if (!approval) {
      throw new AuthServiceError("CONFLICT", "官网重制需求无法执行重置。");
    }
    if ("pendingReplay" in approval && approval.pendingReplay) {
      return {
        success: true as const,
        ticketId: ticket.id,
        status: "in_progress" as const,
        revision: ticket.revision,
        resetApplied: false as const,
        resetPending: true as const,
        ...resetProjection,
      };
    }
    const resetPending = approval.resetPending === true;
    const resetRequeued =
      "resetRequeued" in approval && approval.resetRequeued === true;
    const message = resetPending
      ? resetRequeued
        ? "官网重置下线已重新排队；完成后企业知识库保持不变。"
        : "官网重制需求已通过，正在安全下线旧网站；完成后企业知识库保持不变。"
      : "官网重制需求已通过，旧网站已下线；客户可从知识库开始建站。";
    const ticketUpdate = await tx
      .update(deliveryTickets)
      .set({
        status: "in_progress",
        publicSummary: message,
        internalNote: approval.internalNote,
        resolvedAt: null,
        revision: ticket.revision + 1,
        updatedByUserId: input.actor.id,
        updatedAt: now,
      })
      .where(
        and(
          eq(deliveryTickets.id, ticket.id),
          eq(deliveryTickets.revision, ticket.revision),
        ),
      );
    if (deliveryMutationAffectedRows(ticketUpdate) !== 1) {
      throw new AuthServiceError(
        "CONFLICT",
        "需求已被更新，官网重置下线未排队，请刷新后重试",
      );
    }
    await tx.insert(deliveryTicketEvents).values({
      id: randomUUID(),
      ticketId: ticket.id,
      userId: ticket.userId,
      actorUserId: input.actor.id,
      actorRole: eventActorRole,
      kind: "status_change",
      visibility: "customer",
      message,
      fromStatus: ticket.status,
      toStatus: "in_progress",
      actorContext: {
        projectAssignmentId: input.projectAssignmentId,
        customerUserId: role.customerUserId,
        roleType: role.roleType,
      },
      createdAt: now,
    });
    return {
      success: true as const,
      ticketId: ticket.id,
      status: "in_progress" as const,
      revision: ticket.revision + 1,
      resetApplied: !resetPending,
      resetPending,
      siteRebuildResetState: resetPending ? ("queued" as const) : null,
      siteRebuildResetIssue: null,
      siteRebuildCanRecheck: false,
      ...(resetRequeued ? { resetRequeued: true as const } : {}),
      ...(!resetPending
        ? {
            resetAppliedProjectRevision: approval.resetAppliedProjectRevision,
          }
        : {}),
    };
  });
}

export async function updateMyDeliveryTicket(input: {
  actor: AuthenticatedUser;
  projectAssignmentId: string;
  ticketId: string;
  expectedRevision: number;
  status:
    | "in_progress"
    | "needs_information"
    | "completed"
    | "rejected"
    | "cancelled";
  message?: string;
  publicUrl?: string;
  previewVerified?: boolean;
  handoff?: DeliveryTicketHandoff;
}) {
  const eventActorRole = deliveryExecutionActorRole(input.actor);
  if (!eventActorRole) {
    throw new AuthServiceError(
      "INVALID_CREDENTIAL",
      "需要工程师或系统管理员权限",
    );
  }
  const systemAdmin = eventActorRole === "admin";
  const db = await requireDb();
  const transactionResult = await db.transaction(async (tx) => {
    const catalogCompletion: {
      scope: {
        userId: number;
        contractId: string;
        quotaPeriodId: string;
      } | null;
    } = { scope: null };
    const ticketRows = await tx
      .select()
      .from(deliveryTickets)
      .where(eq(deliveryTickets.id, input.ticketId))
      .limit(1)
      .for("update");
    const ticket = ticketRows[0];
    if (
      !ticket ||
      !ticket.workflowDomain ||
      !ticket.assignedProjectAssignmentId ||
      (!systemAdmin && ticket.assignedMemberId !== input.actor.id)
    ) {
      throw new AuthServiceError(
        "NOT_FOUND",
        "需求不属于当前项目岗位或无权处理",
      );
    }
    if (ticket.assignedProjectAssignmentId !== input.projectAssignmentId) {
      throw new AuthServiceError("NOT_FOUND", "需求不属于当前客户项目岗位");
    }
    const role = await assertDeliveryProjectContext({
      actor: input.actor,
      projectAssignmentId: ticket.assignedProjectAssignmentId,
      customerUserId: ticket.userId,
      expectedRoleType: ticket.workflowDomain,
      executor: tx,
    });
    if (ticket.assignedProjectAssignmentId !== role.projectAssignmentId) {
      throw new AuthServiceError("NOT_FOUND", "需求不属于当前客户项目岗位");
    }
    const operation = deliveryWorkflowOperationSchema.safeParse(
      ticket.operation,
    );
    if (ticket.credentialTargetUserId) {
      throw new AuthServiceError(
        "CONFLICT",
        "凭据异常需求只能由系统管理员在统一 API Key 管理入口完成配置后自动关闭",
      );
    }
    if (ticket.operation === "knowledge_delivery") {
      throw new AuthServiceError(
        "CONFLICT",
        "知识库交付记录只能由系统发布流程创建和关闭",
      );
    }
    if (operation.success) {
      if (!deliveryRoleOwnsOperation(role.roleType, operation.data)) {
        throw new AuthServiceError(
          "CONFLICT",
          "需求不属于当前项目岗位，不能执行交付操作",
        );
      }
    }
    if (ticket.revision !== input.expectedRevision) {
      throw new AuthServiceError("CONFLICT", "需求已被更新，请刷新后重试");
    }
    if (ticket.operation === "knowledge_reset") {
      throw new AuthServiceError("CONFLICT", "知识库重置必须使用专用审批操作");
    }
    assertGenericDeliveryTicketTransition({
      operation: ticket.operation,
      nextStatus: input.status,
    });
    if (
      !(MEMBER_TICKET_TRANSITIONS[ticket.status] ?? []).includes(input.status)
    ) {
      throw new AuthServiceError("CONFLICT", "当前需求状态不能执行该操作");
    }
    assertDeliveryCompletionSummary({
      nextStatus: input.status,
      message: input.message,
    });
    assertDeliveryCompletionContract({
      operation: ticket.operation,
      nextStatus: input.status,
      message: input.message,
      publicUrl: input.publicUrl,
      previewVerified: input.previewVerified,
      handoff: input.handoff,
    });
    if (
      input.handoff?.targetMedia &&
      ticket.operation !== "channel_distribution"
    ) {
      throw new AuthServiceError("CONFLICT", "发布媒体只允许用于渠道分发需求");
    }
    if (
      ticket.operation === "content_asset_publish" &&
      (input.publicUrl ||
        input.handoff?.publishTargets?.length ||
        input.handoff?.websiteOperation)
    ) {
      throw new AuthServiceError(
        "CONFLICT",
        "内容资产发布只登记正式资产，不接收公开链接或人工指定下游路径",
      );
    }
    try {
      await assertExistingDeliveryTicketSettlementScope({
        executor: tx,
        userId: ticket.userId,
        ticket,
      });
    } catch (error) {
      if (error instanceof DeliveryTicketError) {
        throw new AuthServiceError(
          error.statusCode === 404 ? "NOT_FOUND" : "CONFLICT",
          error.message,
        );
      }
      throw error;
    }
    const now = new Date();
    let currentQuotaScope:
      | Awaited<ReturnType<typeof resolveCurrentServiceQuotaScope>>
      | undefined;
    const loadCurrentQuotaScope = async () => {
      if (currentQuotaScope !== undefined) return currentQuotaScope;
      const activeQuotaSelection = await resolveActiveDeliveryQuotaScopes({
        executor: tx,
        userId: ticket.userId,
        now,
      });
      currentQuotaScope = activeQuotaSelection
        ? (findActiveDeliveryQuotaScope({
            selection: activeQuotaSelection,
            record: ticket,
          }) ?? null)
        : null;
      return currentQuotaScope;
    };
    const siteCheckFailed =
      input.status === "completed" &&
      ticket.operation === "site_check" &&
      input.handoff?.siteCheck?.status === "failed";
    const effectiveStatus: DeliveryExecutionTransitionStatus = input.status;
    const transition = deriveDeliveryExecutionTransition({
      currentQuotaState: ticket.quotaState,
      scheduledAt: ticket.scheduledAt,
      quotaReleasedAt: ticket.quotaReleasedAt,
      technicalDedupeKey: ticket.technicalDedupeKey,
      nextStatus: effectiveStatus,
      now,
    });
    const deliveryLinks = input.publicUrl
      ? [{ label: "公开链接", url: input.publicUrl }]
      : ticket.deliveryLinks;
    const monitoringBatchKey =
      input.handoff?.monitoringBatchKey?.trim() ||
      ticket.monitoringBatchKey ||
      null;
    const responseLogicRevision =
      input.handoff?.responseLogicRevision ??
      ticket.responseLogicRevision ??
      null;
    const contentAssetIds = Array.from(
      new Set(
        (input.handoff?.contentAssetIds ?? ticket.contentAssetIds ?? [])
          .map((id) => id.trim())
          .filter(Boolean),
      ),
    );
    const targetMedia =
      input.handoff?.targetMedia?.trim() || ticket.preferredMedia || null;
    let publishedDashboard:
      | ReturnType<typeof dashboardPayloadSchema.parse>
      | null
      | undefined;
    const loadPublishedDashboard = async () => {
      if (publishedDashboard !== undefined) return publishedDashboard;
      const dashboardRows = await tx
        .select({ payload: userDashboardContents.payload })
        .from(userDashboardContents)
        .where(eq(userDashboardContents.userId, ticket.userId))
        .limit(1);
      const parsed = dashboardPayloadSchema.safeParse(
        dashboardRows[0]?.payload,
      );
      publishedDashboard = parsed.success ? parsed.data : null;
      return publishedDashboard;
    };

    if (
      input.status === "completed" &&
      ticket.operation === "question_catalog"
    ) {
      const dashboard = await loadPublishedDashboard();
      if (!dashboard?.keywordTables.length) {
        throw new AuthServiceError(
          "CONFLICT",
          "完成品牌词库配置前必须先发布正式品牌词库",
        );
      }
    }

    if (
      ["in_progress", "completed"].includes(input.status) &&
      ticket.operation === "initial_monitoring"
    ) {
      const questionScope = await resolveDeliveryTicketQuestionWorkflowScope({
        executor: tx,
        ticket,
      });
      const [completedCatalogRows, archivedCatalogRows, approvedQuestionRows] =
        await Promise.all([
          tx
            .select({ id: deliveryTickets.id })
            .from(deliveryTickets)
            .where(
              and(
                eq(deliveryTickets.userId, ticket.userId),
                questionScope
                  ? deliveryTicketQuestionScopeCondition(questionScope)
                  : sql<boolean>`FALSE`,
                eq(deliveryTickets.operation, "question_catalog"),
                eq(deliveryTickets.status, "completed"),
              ),
            )
            .limit(1),
          tx
            .select({ id: deliveryWorkflowMilestones.id })
            .from(deliveryWorkflowMilestones)
            .where(
              and(
                eq(deliveryWorkflowMilestones.userId, ticket.userId),
                eq(deliveryWorkflowMilestones.operation, "question_catalog"),
                questionScope?.progressiveLuxury
                  ? deliveryWorkflowMilestoneScopeCondition(questionScope)
                  : questionScope
                    ? undefined
                    : sql<boolean>`FALSE`,
              ),
            )
            .limit(1),
          tx
            .select({ id: workspaceQuestions.id })
            .from(workspaceQuestions)
            .where(
              and(
                eq(workspaceQuestions.userId, ticket.userId),
                questionScope
                  ? workspaceQuestionDeliveryScopeCondition(questionScope)
                  : sql<boolean>`FALSE`,
                eq(workspaceQuestions.status, "selected"),
                eq(workspaceQuestions.selectionApprovalStatus, "approved"),
              ),
            )
            .limit(1),
        ]);
      if (
        !questionScope ||
        (!completedCatalogRows[0] && !archivedCatalogRows[0]) ||
        !approvedQuestionRows[0]
      ) {
        throw new AuthServiceError(
          "CONFLICT",
          "请先完成品牌词库配置并审核通过客户选择的问题",
        );
      }
    }

    if (
      input.status === "completed" &&
      ["initial_monitoring", "monitoring_import", "monitoring_retest"].includes(
        ticket.operation || "",
      )
    ) {
      const quotaScope = await loadCurrentQuotaScope();
      const questionScope = quotaScope
        ? deliveryQuestionWorkflowScope(quotaScope)
        : null;
      if (!monitoringBatchKey) {
        throw new AuthServiceError(
          "CONFLICT",
          "完成监控需求前必须绑定已发布的正式监控批次",
        );
      }
      if (
        ticket.operation === "monitoring_retest" &&
        monitoringBatchKey === ticket.monitoringBatchKey
      ) {
        throw new AuthServiceError(
          "CONFLICT",
          "效果复测必须绑定新的监控批次，不能继续使用复测前基线",
        );
      }
      const batchRows = await tx
        .select({
          id: monitoringBatches.id,
          sampleCount: monitoringBatches.sampleCount,
        })
        .from(monitoringBatches)
        .where(
          and(
            eq(monitoringBatches.userId, ticket.userId),
            eq(monitoringBatches.batchKey, monitoringBatchKey),
            quotaScope
              ? eq(monitoringBatches.contractId, quotaScope.contract.id)
              : sql<boolean>`FALSE`,
            quotaScope
              ? eq(monitoringBatches.quotaPeriodId, quotaScope.period.id)
              : sql<boolean>`FALSE`,
          ),
        )
        .orderBy(desc(monitoringBatches.collectedAt))
        .limit(1);
      const monitoringBatch = batchRows[0];
      if (
        !questionScope ||
        !deliveryRecordMatchesQuestionWorkflowScope(ticket, questionScope) ||
        !monitoringBatch ||
        monitoringBatch.sampleCount < 1
      ) {
        throw new AuthServiceError(
          "CONFLICT",
          "所填监控批次尚未发布正式答案，请先完成导入并在用户预览中核对",
        );
      }

      const optimizationQuestionIds = Array.from(
        new Set(
          (input.handoff?.optimizationQuestionIds ?? [])
            .map((id) => id.trim())
            .filter(Boolean),
        ),
      );
      if (optimizationQuestionIds.length) {
        const [questionRows, sampleRows] = await Promise.all([
          tx
            .select({ id: workspaceQuestions.id })
            .from(workspaceQuestions)
            .where(
              and(
                eq(workspaceQuestions.userId, ticket.userId),
                workspaceQuestionDeliveryScopeCondition(questionScope),
                eq(workspaceQuestions.status, "selected"),
                eq(workspaceQuestions.selectionApprovalStatus, "approved"),
                inArray(workspaceQuestions.id, optimizationQuestionIds),
              ),
            ),
          tx
            .select({ questionId: monitoringSamples.questionId })
            .from(monitoringSamples)
            .where(
              and(
                eq(monitoringSamples.userId, ticket.userId),
                eq(monitoringSamples.batchId, monitoringBatch.id),
                inArray(monitoringSamples.questionId, optimizationQuestionIds),
              ),
            ),
        ]);
        const validQuestionIds = new Set(questionRows.map((row) => row.id));
        const monitoredQuestionIds = new Set(
          sampleRows.map((row) => row.questionId),
        );
        const invalidQuestionIds = optimizationQuestionIds.filter(
          (id) => !validQuestionIds.has(id) || !monitoredQuestionIds.has(id),
        );
        if (invalidQuestionIds.length) {
          throw new AuthServiceError(
            "CONFLICT",
            `以下待优化问题未被客户确认或不属于该监控批次：${invalidQuestionIds.join("、")}`,
          );
        }
      }
    }

    if (input.status === "completed" && ticket.operation === "response_logic") {
      if (!ticket.sourceQuestionId || !responseLogicRevision) {
        throw new AuthServiceError(
          "CONFLICT",
          "完成应答逻辑前必须绑定来源问题和正式版本",
        );
      }
      const responseRows = await tx
        .select({
          status: responseLogicEntries.status,
          version: responseLogicEntries.version,
        })
        .from(responseLogicEntries)
        .where(
          and(
            eq(responseLogicEntries.userId, ticket.userId),
            eq(responseLogicEntries.questionId, ticket.sourceQuestionId),
          ),
        )
        .limit(1);
      const responseLogic = responseRows[0];
      if (
        !responseLogic ||
        responseLogic.status !== "confirmed" ||
        responseLogic.version !== responseLogicRevision
      ) {
        throw new AuthServiceError(
          "CONFLICT",
          `应答逻辑 V${responseLogicRevision} 尚未作为该问题的正式版本发布`,
        );
      }
    }

    if (
      input.status === "completed" &&
      (ticket.operation === "content_asset_publish" ||
        ticket.operation === "channel_distribution")
    ) {
      if (!contentAssetIds.length) {
        throw new AuthServiceError(
          "CONFLICT",
          "完成内容发布或渠道分发前必须绑定正式内容资产 ID",
        );
      }
      const dashboard = await loadPublishedDashboard();
      const publishedAssetIds = new Set(
        dashboard?.contentAssets.map((asset) => asset.id) ?? [],
      );
      const missingAssetIds = contentAssetIds.filter(
        (id) => !publishedAssetIds.has(id),
      );
      if (missingAssetIds.length) {
        throw new AuthServiceError(
          "CONFLICT",
          `以下内容资产尚未进入客户正式看板：${missingAssetIds.join("、")}`,
        );
      }
    }
    if (
      input.status === "completed" &&
      ticket.operation === "channel_distribution"
    ) {
      if (!targetMedia) {
        throw new AuthServiceError(
          "CONFLICT",
          "完成渠道分发前必须选择实际发布媒体",
        );
      }
      const accountRows = await tx
        .select({ marketEdition: users.marketEdition })
        .from(users)
        .where(eq(users.id, ticket.userId))
        .limit(1);
      const allowedMedia = new Set<string>(
        contentAssetMediaOptionsForMarketEdition(
          accountRows[0]?.marketEdition ?? "domestic",
        ),
      );
      if (!allowedMedia.has(targetMedia)) {
        throw new AuthServiceError(
          "CONFLICT",
          "所选发布媒体不属于当前客户版本，请刷新后重新选择",
        );
      }
    }

    if (input.status === "completed" && ticket.operation === "stage_report") {
      const dashboard = await loadPublishedDashboard();
      if (!dashboard?.optimizationReport) {
        throw new AuthServiceError(
          "CONFLICT",
          "完成阶段报告需求前必须先发布客户可见的正式优化报告",
        );
      }
    }
    const icpServiceCode = input.handoff?.icpServiceCode?.trim() || "";
    let domainApplicationOverseas = false;
    if (
      input.status === "completed" &&
      ticket.operation === "domain_application"
    ) {
      const accountRows = await tx
        .select({ marketEdition: users.marketEdition })
        .from(users)
        .where(eq(users.id, ticket.userId))
        .limit(1);
      domainApplicationOverseas = accountRows[0]?.marketEdition === "overseas";
    }
    const websiteContentOperations = [
      "company_facts",
      "product_case_docs",
      "industry_news",
      "company_news",
      "faq_content",
    ];
    if (
      input.status === "completed" &&
      ticket.workflowDomain === "ai_operations_engineer" &&
      websiteContentOperations.includes(ticket.operation || "")
    ) {
      if (!contentAssetIds.length) {
        throw new AuthServiceError(
          "CONFLICT",
          "官网内容发布前必须绑定已发布的内容资产",
        );
      }
      const [publishedRows, archivedPublishedRows] = await Promise.all([
        tx
          .select({ contentAssetIds: deliveryTickets.contentAssetIds })
          .from(deliveryTickets)
          .where(
            and(
              eq(deliveryTickets.userId, ticket.userId),
              eq(
                deliveryTickets.workflowDomain,
                "content_distribution_engineer",
              ),
              eq(deliveryTickets.operation, "content_asset_publish"),
              eq(deliveryTickets.status, "completed"),
            ),
          ),
        tx
          .select({
            contentAssetIds: deliveryWorkflowMilestones.contentAssetIds,
          })
          .from(deliveryWorkflowMilestones)
          .where(
            and(
              eq(deliveryWorkflowMilestones.userId, ticket.userId),
              eq(deliveryWorkflowMilestones.operation, "content_asset_publish"),
            ),
          ),
      ]);
      const publishedAssetIds = new Set(
        [...publishedRows, ...archivedPublishedRows].flatMap(
          (row) => row.contentAssetIds ?? [],
        ),
      );
      const unverifiedIds = contentAssetIds.filter(
        (id) => !publishedAssetIds.has(id),
      );
      if (unverifiedIds.length) {
        throw new AuthServiceError(
          "CONFLICT",
          `以下内容资产尚未完成内容分发发布：${unverifiedIds.join("、")}`,
        );
      }
    }
    if (
      input.status === "completed" &&
      ticket.operation === "knowledge_maintenance"
    ) {
      const replacementRows = await tx
        .select({ id: knowledgeBaseSnapshots.id })
        .from(knowledgeBaseSnapshots)
        .where(
          and(
            eq(knowledgeBaseSnapshots.userId, ticket.userId),
            eq(knowledgeBaseSnapshots.status, "active"),
            eq(knowledgeBaseSnapshots.maintenanceTicketId, ticket.id),
          ),
        )
        .limit(1);
      if (!replacementRows[0]) {
        throw new AuthServiceError(
          "CONFLICT",
          "完成维护需求前必须先上传并发布通过校验的新知识库版本",
        );
      }
    }
    if (
      input.status === "completed" &&
      ticket.operation === "domain_application"
    ) {
      const domainInput = input.handoff?.domain?.trim() || "";
      if (!domainApplicationOverseas && !icpServiceCode) {
        throw new AuthServiceError(
          "CONFLICT",
          "完成域名需求前必须填写要返回给客户的备案服务码",
        );
      }
      let domain: string;
      try {
        domain = new URL(
          /^https?:\/\//i.test(domainInput)
            ? domainInput
            : `https://${domainInput}`,
        ).hostname.toLowerCase();
      } catch {
        throw new AuthServiceError(
          "CONFLICT",
          "完成域名核验前必须填写有效域名",
        );
      }
      if (!domain) {
        throw new AuthServiceError(
          "CONFLICT",
          "完成域名核验前必须填写有效域名",
        );
      }
      const profileRows = await tx
        .select()
        .from(workspaceSiteProfiles)
        .where(eq(workspaceSiteProfiles.userId, ticket.userId))
        .limit(1)
        .for("update");
      const profile = profileRows[0];
      if (profile) {
        await tx
          .update(workspaceSiteProfiles)
          .set({
            domain,
            domainStatus: "completed",
            domainVerifiedAt: profile.domainVerifiedAt ?? now,
            ...(domainApplicationOverseas
              ? {
                  icpNumber: null,
                  icpStatus: "not_required" as const,
                  icpVerifiedAt: now,
                }
              : {}),
            revision: profile.revision + 1,
            updatedByUserId: input.actor.id,
            updatedAt: now,
          })
          .where(eq(workspaceSiteProfiles.userId, ticket.userId));
      } else {
        await tx.insert(workspaceSiteProfiles).values({
          userId: ticket.userId,
          domain,
          siteMode: "unknown",
          domainStatus: "completed",
          domainVerifiedAt: now,
          icpStatus: domainApplicationOverseas
            ? "not_required"
            : "not_submitted",
          icpVerifiedAt: domainApplicationOverseas ? now : null,
          revision: 1,
          updatedByUserId: input.actor.id,
          createdAt: now,
          updatedAt: now,
        });
      }
      if (domainApplicationOverseas) {
        await ensureWebsiteStyleWorkflowTicket({
          executor: tx,
          sourceTicket: ticket,
          actorUserId: input.actor.id,
        });
      }
    }
    if (input.status === "completed" && ticket.operation === "icp_filing") {
      const accountRows = await tx
        .select({ marketEdition: users.marketEdition })
        .from(users)
        .where(eq(users.id, ticket.userId))
        .limit(1);
      const profileRows = await tx
        .select()
        .from(workspaceSiteProfiles)
        .where(eq(workspaceSiteProfiles.userId, ticket.userId))
        .limit(1)
        .for("update");
      const profile = profileRows[0];
      if (!profile || profile.domainStatus !== "completed") {
        throw new AuthServiceError(
          "CONFLICT",
          "必须先完成域名核验，才能完成 ICP 备案需求",
        );
      }
      const notRequired = input.handoff?.icpNotRequired === true;
      if (notRequired && accountRows[0]?.marketEdition !== "overseas") {
        throw new AuthServiceError(
          "CONFLICT",
          "国内版官网必须填写已通过的 ICP 备案结果",
        );
      }
      const icpNumber = input.handoff?.icpNumber?.trim() || null;
      if (!notRequired && !icpNumber) {
        throw new AuthServiceError(
          "CONFLICT",
          "完成 ICP 备案时必须填写备案号，或明确选择无需备案",
        );
      }
      await tx
        .update(workspaceSiteProfiles)
        .set({
          icpProvince:
            input.handoff?.icpProvince?.trim() || profile.icpProvince || null,
          icpNumber: notRequired ? null : icpNumber,
          icpStatus: notRequired ? "not_required" : "approved",
          icpDomainRevision: notRequired ? null : profile.domainRevision,
          icpVerifiedAt: now,
          revision: profile.revision + 1,
          updatedByUserId: input.actor.id,
          updatedAt: now,
        })
        .where(eq(workspaceSiteProfiles.userId, ticket.userId));
      await ensureWebsiteStyleWorkflowTicket({
        executor: tx,
        sourceTicket: ticket,
        actorUserId: input.actor.id,
      });
    }
    if (input.status === "completed" && ticket.operation === "site_check") {
      const check = input.handoff?.siteCheck;
      if (!check) {
        throw new AuthServiceError(
          "CONFLICT",
          "完成站点检查前必须登记检查结果",
        );
      }
      if (!check.source?.trim()) {
        throw new AuthServiceError(
          "CONFLICT",
          "站点检查必须登记被检查页面或检查来源",
        );
      }
      const checkRows = await tx
        .select()
        .from(workspaceSiteChecks)
        .where(
          and(
            eq(workspaceSiteChecks.userId, ticket.userId),
            eq(workspaceSiteChecks.key, check.key),
          ),
        )
        .limit(1)
        .for("update");
      const current = checkRows[0];
      const values = {
        label: check.label,
        status: check.status,
        summary: check.summary?.trim() || null,
        evidence: check.evidence?.trim() || null,
        source: check.source?.trim() || ticket.targetPage?.trim() || null,
        checkedAt: now,
        revision: (current?.revision ?? 0) + 1,
        updatedByUserId: input.actor.id,
        updatedAt: now,
      };
      if (current) {
        await tx
          .update(workspaceSiteChecks)
          .set(values)
          .where(eq(workspaceSiteChecks.id, current.id));
      } else {
        await tx.insert(workspaceSiteChecks).values({
          id: randomUUID(),
          userId: ticket.userId,
          key: check.key,
          ...values,
          createdAt: now,
        });
      }
    }
    await tx
      .update(deliveryTickets)
      .set({
        status: effectiveStatus,
        quotaState: transition.quotaState,
        publicSummary:
          effectiveStatus === "completed" &&
          ticket.operation === "domain_application"
            ? domainApplicationOverseas
              ? "海外版域名已核验；中国香港或海外节点无需办理工信部 ICP 备案。"
              : `备案服务码：${icpServiceCode}`
            : input.message?.trim() || ticket.publicSummary,
        deliveryLinks,
        monitoringBatchKey,
        responseLogicRevision,
        contentAssetIds,
        preferredMedia: targetMedia,
        scheduledAt: transition.scheduledAt,
        quotaReleasedAt: transition.quotaReleasedAt,
        resolvedAt: transition.resolvedAt,
        technicalDedupeKey: transition.technicalDedupeKey,
        revision: sql`${deliveryTickets.revision} + 1`,
        updatedByUserId: input.actor.id,
        updatedAt: now,
      })
      .where(eq(deliveryTickets.id, ticket.id));
    await tx.insert(deliveryTicketEvents).values({
      id: randomUUID(),
      ticketId: ticket.id,
      userId: ticket.userId,
      actorUserId: input.actor.id,
      actorRole: eventActorRole,
      kind: "status_change",
      visibility: ticket.rootTicketId ? "internal" : "customer",
      message: input.message?.trim() || null,
      fromStatus: ticket.status,
      toStatus: effectiveStatus,
      actorContext: {
        projectAssignmentId: input.projectAssignmentId,
        customerUserId: role.customerUserId,
        roleType: role.roleType,
        ...(effectiveStatus === "completed" &&
        ticket.operation === "website_build"
          ? { previewVerified: input.previewVerified === true }
          : {}),
      },
      createdAt: now,
    });
    const sourceTicket = {
      ...ticket,
      monitoringBatchKey,
      responseLogicRevision,
      contentAssetIds,
      deliveryLinks,
      preferredMedia: targetMedia,
    };
    const actorRoleContext = {
      projectAssignmentId: input.projectAssignmentId,
      customerUserId: role.customerUserId,
      roleType: role.roleType,
      eventActorRole,
    };
    const handoffTicketIds: string[] = [];
    if (effectiveStatus === "completed") {
      if (ticket.operation === "question_catalog") {
        catalogCompletion.scope = {
          userId: ticket.userId,
          contractId: ticket.contractId,
          quotaPeriodId: ticket.quotaPeriodId,
        };
      } else if (
        ticket.operation === "initial_monitoring" ||
        ticket.operation === "monitoring_import"
      ) {
        const questionIds = Array.from(
          new Set(
            (input.handoff?.optimizationQuestionIds ?? [])
              .map((id) => id.trim())
              .filter(Boolean),
          ),
        );
        for (const questionId of questionIds) {
          handoffTicketIds.push(
            await createAssignedWorkflowTicket({
              executor: tx,
              sourceTicket,
              actorUserId: input.actor.id,
              actorRoleContext,
              workflowDomain: "content_distribution_engineer",
              operation: "response_logic",
              title: `制作问题 ${questionId} 的应答逻辑`,
              description:
                "首次监控已确认该问题需要优化，请基于已发布监控批次制作应答逻辑。",
              sourceQuestionId: questionId,
              monitoringBatchKey,
              responseLogicRevision: 1,
            }),
          );
        }
      } else if (ticket.operation === "response_logic") {
        handoffTicketIds.push(
          await createAssignedWorkflowTicket({
            executor: tx,
            sourceTicket,
            actorUserId: input.actor.id,
            actorRoleContext,
            workflowDomain: "content_distribution_engineer",
            operation: "content_asset_publish",
            title: "制作并发布 AI 友好内容资产",
            description: "应答逻辑已经确认，请据此生成、校验并发布内容资产。",
            responseLogicRevision:
              responseLogicRevision ?? (ticket.responseLogicRevision ?? 0) + 1,
          }),
        );
      } else if (ticket.operation === "content_asset_publish") {
        const rootRows = ticket.rootTicketId
          ? await tx
              .select({
                id: deliveryTickets.id,
                type: deliveryTickets.type,
                category: deliveryTickets.category,
                isWorkflowContainer: deliveryTickets.isWorkflowContainer,
              })
              .from(deliveryTickets)
              .where(eq(deliveryTickets.id, ticket.rootTicketId))
              .limit(1)
          : [];
        const workflowRoot = rootRows[0];
        const rootWebsiteOperation =
          workflowRoot?.isWorkflowContainer &&
          workflowRoot.type === "website_operation" &&
          websiteContentOperations.includes(workflowRoot.category || "")
            ? (workflowRoot.category as DeliveryTicketHandoff["websiteOperation"])
            : undefined;
        const targets: Array<"media" | "website"> = workflowRoot
          ? workflowRoot.type === "website_operation"
            ? ["website"]
            : ["media"]
          : input.handoff?.publishTargets?.length
            ? Array.from(new Set(input.handoff.publishTargets))
            : ["media"];
        if (targets.includes("media")) {
          handoffTicketIds.push(
            await createAssignedWorkflowTicket({
              executor: tx,
              sourceTicket,
              actorUserId: input.actor.id,
              actorRoleContext,
              workflowDomain: "content_distribution_engineer",
              operation: "channel_distribution",
              title: "登记媒体渠道分发结果",
              description: "内容资产已发布，请完成媒体渠道分发并登记公开链接。",
              contentAssetIds,
            }),
          );
        }
        if (targets.includes("website")) {
          if (!contentAssetIds.length) {
            throw new AuthServiceError(
              "CONFLICT",
              "创建官网发布需求前必须绑定已确认的内容资产 ID",
            );
          }
          const websiteOperation =
            rootWebsiteOperation || input.handoff?.websiteOperation;
          if (!websiteOperation) {
            throw new AuthServiceError("CONFLICT", "请选择官网内容需求类型");
          }
          handoffTicketIds.push(
            await createAssignedWorkflowTicket({
              executor: tx,
              sourceTicket,
              actorUserId: input.actor.id,
              actorRoleContext,
              workflowDomain: "ai_operations_engineer",
              operation: websiteOperation,
              title: "将已确认内容发布到客户官网",
              description:
                "内容资产已经确认，请按绑定资产发布官网页面并登记公开链接。",
              contentAssetIds,
            }),
          );
        }
      } else if (ticket.operation === "monitoring_retest") {
        handoffTicketIds.push(
          await createAssignedWorkflowTicket({
            executor: tx,
            sourceTicket,
            actorUserId: input.actor.id,
            actorRoleContext,
            workflowDomain: "monitoring_optimization_engineer",
            operation: "stage_report",
            title: "发布阶段效果报告",
            description: "效果复测已经完成，请汇总优化前后结果并发布阶段报告。",
          }),
        );
      } else if (
        ticket.operation === "stage_report" &&
        input.handoff?.needsFurtherOptimization
      ) {
        if (!sourceTicket.sourceQuestionId) {
          throw new AuthServiceError(
            "CONFLICT",
            "继续优化前必须绑定来源问题 ID",
          );
        }
        handoffTicketIds.push(
          await createAssignedWorkflowTicket({
            executor: tx,
            sourceTicket,
            actorUserId: input.actor.id,
            actorRoleContext,
            workflowDomain: "content_distribution_engineer",
            operation: "response_logic",
            title: `继续优化问题 ${sourceTicket.sourceQuestionId}`,
            description:
              "阶段复测仍未达到目标，请基于最新监控结论修订应答逻辑和内容。",
            responseLogicRevision: (responseLogicRevision ?? 0) + 1,
          }),
        );
      } else if (
        ticket.workflowDomain === "ai_operations_engineer" &&
        websiteContentOperations.includes(ticket.operation || "")
      ) {
        handoffTicketIds.push(
          await createAssignedWorkflowTicket({
            executor: tx,
            sourceTicket,
            actorUserId: input.actor.id,
            actorRoleContext,
            workflowDomain: "ai_operations_engineer",
            operation: "site_check",
            title: "检查已发布官网页面",
            description:
              "官网内容已经发布，请检查目标页面可访问性、内容呈现与基础站点状态。",
            contentAssetIds,
          }),
        );
      } else if (ticket.operation === "site_check" && siteCheckFailed) {
        const parentRows = ticket.parentTicketId
          ? await tx
              .select()
              .from(deliveryTickets)
              .where(eq(deliveryTickets.id, ticket.parentTicketId))
              .limit(1)
          : [];
        const websiteParent = parentRows[0];
        if (
          !websiteParent ||
          !websiteContentOperations.includes(websiteParent.operation || "")
        ) {
          throw new AuthServiceError(
            "CONFLICT",
            "站点检查未通过，但无法定位需修正的官网发布子任务",
          );
        }
        handoffTicketIds.push(
          await createAssignedWorkflowTicket({
            executor: tx,
            sourceTicket,
            actorUserId: input.actor.id,
            actorRoleContext,
            workflowDomain: "ai_operations_engineer",
            operation: websiteParent.operation as
              | "company_facts"
              | "product_case_docs"
              | "industry_news"
              | "company_news"
              | "faq_content",
            title: "修正未通过站点检查的官网内容",
            description:
              "站点检查已记录为失败，请修正原官网页面并重新登记可访问链接；完成后系统会再次创建站点检查。",
            contentAssetIds,
          }),
        );
      }
    }
    let retestTicketId: string | null = null;
    if (
      effectiveStatus === "completed" &&
      !siteCheckFailed &&
      operation.success &&
      deliveryOperationTriggersMonitoringRetest(operation.data)
    ) {
      retestTicketId = await createMonitoringRetestTicket({
        executor: tx,
        sourceTicket,
        actorUserId: input.actor.id,
      });
    }
    const containerUpdate = await syncWorkflowContainer({
      executor: tx,
      sourceTicket: {
        ...sourceTicket,
        status: effectiveStatus,
        publicSummary: input.message?.trim() || sourceTicket.publicSummary,
        deliveryLinks,
      },
      actorUserId: input.actor.id,
      actorRole: eventActorRole,
      actorContext: {
        projectAssignmentId: input.projectAssignmentId,
        customerUserId: role.customerUserId,
        roleType: role.roleType,
      },
      message: input.message,
      now,
    });
    if (systemAdmin) {
      await writeWorkspaceAuditEvent(
        {
          actor: input.actor,
          action: "delivery_ticket.system_admin_override",
          targetType: "delivery_ticket",
          targetId: ticket.id,
          workspaceUserId: ticket.userId,
          metadata: {
            command: "update_ticket",
            projectAssignmentId: ticket.assignedProjectAssignmentId,
            workflowDomain: ticket.workflowDomain,
            assignedMemberId: ticket.assignedMemberId,
            operation: ticket.operation,
            fromStatus: ticket.status,
            toStatus: effectiveStatus,
            fromRevision: ticket.revision,
            toRevision: ticket.revision + 1,
            handoffTicketIds,
            retestTicketId,
            rootTicketId: containerUpdate?.rootTicketId ?? null,
            rootStatus: containerUpdate?.status ?? null,
          },
          now,
        },
        tx,
      );
    }
    return {
      result: {
        success: true as const,
        revision: ticket.revision + 1,
        retestTicketId,
        handoffTicketIds,
        rootTicketId: containerUpdate?.rootTicketId ?? null,
        rootStatus: containerUpdate?.status ?? null,
      },
      completedCatalogScope: catalogCompletion.scope,
    };
  });
  const { result, completedCatalogScope } = transactionResult;
  if (completedCatalogScope) {
    const handoff = await reconcileInitialMonitoringForScope({
      ...completedCatalogScope,
      actorUserId: input.actor.id,
    });
    if (handoff.created && handoff.id) {
      result.handoffTicketIds.push(handoff.id);
    }
  }
  return result;
}

export async function createKnowledgeMonitoringHandoff(input: {
  userId: number;
  actorUserId: number;
  knowledgeSnapshotId?: string;
}) {
  const db = await requireDb();
  return db.transaction(async (tx) => {
    const activeQuotaSelection = await resolveActiveDeliveryQuotaScopes({
      executor: tx,
      userId: input.userId,
    });
    const currentScope = activeQuotaSelection
      ? (activeQuotaSelection.scopes.find(
          (scope) =>
            scope.contract.id === activeQuotaSelection.primaryContract.id,
        ) ?? null)
      : null;
    if (!currentScope) {
      return {
        created: [] as string[],
        assigned: false as const,
        knowledgeTicketId: null,
      };
    }
    const { contract, period } = currentScope;
    const questionScope = deliveryQuestionWorkflowScope(currentScope);
    const snapshotRows = input.knowledgeSnapshotId
      ? await tx
          .select({
            id: knowledgeBaseSnapshots.id,
            maintenanceTicketId: knowledgeBaseSnapshots.maintenanceTicketId,
          })
          .from(knowledgeBaseSnapshots)
          .where(
            and(
              eq(knowledgeBaseSnapshots.id, input.knowledgeSnapshotId),
              eq(knowledgeBaseSnapshots.userId, input.userId),
              eq(knowledgeBaseSnapshots.status, "active"),
            ),
          )
          .limit(1)
      : await tx
          .select({
            id: knowledgeBaseSnapshots.id,
            maintenanceTicketId: knowledgeBaseSnapshots.maintenanceTicketId,
          })
          .from(knowledgeBaseSnapshots)
          .where(
            and(
              eq(knowledgeBaseSnapshots.userId, input.userId),
              eq(knowledgeBaseSnapshots.status, "active"),
            ),
          )
          .orderBy(desc(knowledgeBaseSnapshots.version))
          .limit(1);
    const snapshotId = snapshotRows[0]?.id ?? null;
    const snapshotIsMaintenance = Boolean(snapshotRows[0]?.maintenanceTicketId);
    const aiOwner = await getActiveDeliveryProjectOwner(
      tx,
      input.userId,
      "ai_operations_engineer",
    );
    let knowledgeTicketId: string | null = null;
    if (snapshotId && !snapshotIsMaintenance) {
      const existingKnowledgeTickets = await tx
        .select({ id: deliveryTickets.id })
        .from(deliveryTickets)
        .where(
          and(
            eq(deliveryTickets.userId, input.userId),
            eq(deliveryTickets.type, "knowledge_base"),
            eq(deliveryTickets.operation, "knowledge_delivery"),
            eq(deliveryTickets.knowledgeSnapshotId, snapshotId),
          ),
        )
        .limit(1);
      knowledgeTicketId = existingKnowledgeTickets[0]?.id ?? randomUUID();
      if (!existingKnowledgeTickets[0]) {
        const now = new Date();
        await tx.insert(deliveryTickets).values({
          id: knowledgeTicketId,
          userId: input.userId,
          contractId: contract.id,
          quotaPeriodId: period.id,
          type: "knowledge_base",
          quotaPool: null,
          ordinal: 0,
          clientRequestId: randomUUID(),
          category: "knowledge_delivery",
          title: "品牌全域知识库",
          description: "知识库构建完成后由系统自动生成的交付记录。",
          knowledgeSnapshotId: snapshotId,
          workflowDomain: "ai_operations_engineer",
          operation: "knowledge_delivery",
          assignedProjectAssignmentId: aiOwner?.projectAssignmentId ?? null,
          assignedMemberId: aiOwner?.engineerUserId ?? null,
          technicalDedupeKey: `knowledge-delivery:${snapshotId}`,
          quotaState: "consumed",
          status: "completed",
          publicSummary: "品牌全域知识库已完成构建并发布。",
          createdByUserId: input.actorUserId,
          updatedByUserId: input.actorUserId,
          resolvedAt: now,
          createdAt: now,
          updatedAt: now,
        });
        await tx.insert(deliveryTicketEvents).values({
          id: randomUUID(),
          ticketId: knowledgeTicketId,
          userId: input.userId,
          actorUserId: input.actorUserId,
          actorRole: "system",
          kind: "status_change",
          visibility: "customer",
          message: "品牌全域知识库已完成构建并发布，交付记录已自动归档。",
          fromStatus: "submitted",
          toStatus: "completed",
          createdAt: now,
        });
      }
    }
    const owner = await getActiveDeliveryProjectOwner(
      tx,
      input.userId,
      "monitoring_optimization_engineer",
    );
    // Publishing the knowledge base unlocks only the catalog work. The first
    // monitoring ticket is created later, atomically with successful catalog
    // completion, after at least one optimization question is confirmed.
    const operations = knowledgeMonitoringHandoffOperations();
    const reusableTicketStatuses =
      knowledgeMonitoringHandoffReusableTicketStatuses();
    const [existingTickets, existingMilestones] = await Promise.all([
      tx
        .select({ operation: deliveryTickets.operation })
        .from(deliveryTickets)
        .where(
          and(
            eq(deliveryTickets.userId, input.userId),
            inArray(deliveryTickets.operation, [...operations]),
            questionScope.progressiveLuxury
              ? deliveryTicketQuestionScopeCondition(questionScope)
              : undefined,
            inArray(deliveryTickets.status, [...reusableTicketStatuses]),
          ),
        ),
      tx
        .select({ operation: deliveryWorkflowMilestones.operation })
        .from(deliveryWorkflowMilestones)
        .where(
          and(
            eq(deliveryWorkflowMilestones.userId, input.userId),
            inArray(deliveryWorkflowMilestones.operation, [...operations]),
            questionScope.progressiveLuxury
              ? deliveryWorkflowMilestoneScopeCondition(questionScope)
              : undefined,
          ),
        ),
    ]);
    const existingOperations = new Set(
      [...existingTickets, ...existingMilestones].map((row) => row.operation),
    );
    const created: string[] = [];
    for (const operation of operations) {
      if (existingOperations.has(operation)) continue;
      const id = randomUUID();
      created.push(id);
      await tx.insert(deliveryTickets).values({
        id,
        userId: input.userId,
        contractId: contract.id,
        quotaPeriodId: period.id,
        type: "website_operation",
        quotaPool: null,
        ordinal: 0,
        clientRequestId: randomUUID(),
        category: operation,
        title: "配置品牌词库",
        workflowDomain: "monitoring_optimization_engineer",
        operation,
        assignedProjectAssignmentId: owner?.projectAssignmentId ?? null,
        assignedMemberId: owner?.engineerUserId ?? null,
        quotaState: "consumed",
        status: "submitted",
        createdByUserId: input.actorUserId,
        updatedByUserId: input.actorUserId,
      });
      await tx.insert(deliveryTicketEvents).values({
        id: randomUUID(),
        ticketId: id,
        userId: input.userId,
        actorUserId: input.actorUserId,
        actorRole: "system",
        kind: "created",
        visibility: "customer",
        message: "知识库已发布，品牌词库配置需求已解锁。",
        toStatus: "submitted",
        createdAt: new Date(),
      });
    }
    return {
      created,
      assigned: Boolean(owner),
      knowledgeTicketId,
    };
  });
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
