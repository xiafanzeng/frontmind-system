import { and, asc, desc, eq, gt, inArray, lte, or } from "drizzle-orm";

import {
  deliveryProjectAssignments,
  serviceContracts,
  serviceQuotaPeriods,
  users,
  workspaceQuestions,
} from "../drizzle/schema";
import type {
  AdjustQuestionQuotaInput,
  ServiceQuotaLimits,
  ServiceQuotaUsage,
} from "../shared/service-portal";
import { AuthServiceError, type AuthenticatedUser } from "./auth-service";
import {
  hasSystemAdminAccess,
  writeWorkspaceAuditEvent,
} from "./admin-control-plane-service";
import { getDb } from "./db";
import {
  SERVICE_QUESTION_QUOTA_ANCHOR_ORDINAL,
  deriveEffectiveServiceStatus,
  isOperationalServiceQuotaPeriod,
  isProgressiveLuxuryContract,
  resolveEffectiveServiceQuestionQuotaLimits,
  resolveServiceQuestionQuotaScope,
  resolveServiceQuestionQuotaUnlockMetadata,
  selectPortalContract,
  type ServicePortalContractRecord,
} from "./service-entitlement";
import { isUserQuestionPendingClassification } from "./question-selection-policy";

const QUESTION_QUOTA_ROLE = "monitoring_optimization_engineer" as const;

function isEditableQuestionPlan(value: string) {
  return value === "advanced" || value === "luxury";
}

type QuestionQuotaUsageRow = {
  category:
    | "industry"
    | "competitor_comparison"
    | "reputation"
    | "product_scenario"
    | null;
  source?: "model" | "website" | "offline" | "admin" | "user";
  candidateKey?: string | null;
  status: "candidate" | "selected" | "archived";
  selectionApprovalStatus: "not_requested" | "pending" | "approved";
};

export type QuestionQuotaState = {
  periodId: string;
  revision: number;
  validFrom: number;
  validUntil: number;
  limits: ServiceQuotaLimits;
  unlockedLimits: ServiceQuotaLimits;
  unlockStage: { current: number; total: number };
  nextUnlockAt: number | null;
  progressiveUnlock: boolean;
  selectedUsage: ServiceQuotaUsage;
  reservedUsage: ServiceQuotaUsage;
  remaining: ServiceQuotaUsage;
};

function emptyUsage(): ServiceQuotaUsage {
  return {
    industry: 0,
    competitorComparison: 0,
    reputation: 0,
    productScenario: 0,
    total: 0,
  };
}

function addQuestionUsage(
  usage: ServiceQuotaUsage,
  category: QuestionQuotaUsageRow["category"],
) {
  usage.total += 1;
  if (category === "competitor_comparison") {
    usage.competitorComparison += 1;
  } else if (category === "product_scenario") {
    usage.productScenario += 1;
  } else if (category === "industry" || category === "reputation") {
    usage[category] += 1;
  }
}

/** Selected rows are consumed; pending approvals are an additional soft hold. */
export function countQuestionQuotaUsage(
  rows: QuestionQuotaUsageRow[],
  options?: { reserveUnclassifiedAcrossCategories?: boolean },
) {
  const selectedUsage = emptyUsage();
  const reservedUsage = emptyUsage();
  for (const row of rows) {
    if (row.status === "archived") continue;
    if (row.status === "selected") {
      addQuestionUsage(selectedUsage, row.category);
      addQuestionUsage(reservedUsage, row.category);
    } else if (row.selectionApprovalStatus === "pending") {
      if (
        row.category === null ||
        (row.source !== undefined &&
          isUserQuestionPendingClassification({
            candidateKey: row.candidateKey,
            source: row.source,
            status: row.status,
            selectionApprovalStatus: row.selectionApprovalStatus,
          }))
      ) {
        reservedUsage.total += 1;
        if (options?.reserveUnclassifiedAcrossCategories) {
          reservedUsage.industry += 1;
          reservedUsage.competitorComparison += 1;
          reservedUsage.reputation += 1;
          reservedUsage.productScenario += 1;
        }
      } else {
        addQuestionUsage(reservedUsage, row.category);
      }
    }
  }
  return { selectedUsage, reservedUsage };
}

function quotaLimits(
  value: Pick<
    typeof serviceQuotaPeriods.$inferSelect,
    | "industryLimit"
    | "competitorComparisonLimit"
    | "reputationLimit"
    | "productScenarioLimit"
    | "totalQuestionLimit"
  >,
): ServiceQuotaLimits {
  return {
    industryLimit: value.industryLimit,
    competitorComparisonLimit: value.competitorComparisonLimit,
    reputationLimit: value.reputationLimit,
    productScenarioLimit: value.productScenarioLimit,
    totalQuestionLimit: value.totalQuestionLimit,
  };
}

function quotaRemaining(
  limits: ServiceQuotaLimits,
  usage: ServiceQuotaUsage,
): ServiceQuotaUsage {
  return {
    industry: Math.max(0, limits.industryLimit - usage.industry),
    competitorComparison: Math.max(
      0,
      limits.competitorComparisonLimit - usage.competitorComparison,
    ),
    reputation: Math.max(0, limits.reputationLimit - usage.reputation),
    productScenario: Math.max(
      0,
      limits.productScenarioLimit - usage.productScenario,
    ),
    total: Math.max(0, limits.totalQuestionLimit - usage.total),
  };
}

function toQuestionQuotaState(input: {
  contract: ServicePortalContractRecord;
  period: typeof serviceQuotaPeriods.$inferSelect;
  rows: QuestionQuotaUsageRow[];
  now: Date;
  storedLimits?: ServiceQuotaLimits;
  revision?: number;
}): QuestionQuotaState {
  const period = input.storedLimits
    ? { ...input.period, ...input.storedLimits }
    : input.period;
  const limits = resolveEffectiveServiceQuestionQuotaLimits({
    contract: input.contract,
    period,
    now: input.now,
  });
  const unlock = resolveServiceQuestionQuotaUnlockMetadata({
    contract: input.contract,
    period,
    now: input.now,
  });
  const usage = countQuestionQuotaUsage(input.rows, {
    reserveUnclassifiedAcrossCategories: isProgressiveLuxuryContract(
      input.contract,
    ),
  });
  return {
    periodId: input.period.id,
    revision: input.revision ?? input.period.revision,
    validFrom: input.period.startsAt.getTime(),
    validUntil: input.period.endsAt.getTime(),
    limits,
    unlockedLimits: unlock.unlockedLimits,
    unlockStage: unlock.unlockStage,
    nextUnlockAt: unlock.nextUnlockAt,
    progressiveUnlock: isProgressiveLuxuryContract(input.contract),
    selectedUsage: usage.selectedUsage,
    reservedUsage: usage.reservedUsage,
    remaining: quotaRemaining(limits, usage.reservedUsage),
  };
}

function questionQuotaUsageMinimums(usage: ServiceQuotaUsage) {
  return {
    industryLimit: usage.industry,
    competitorComparisonLimit: usage.competitorComparison,
    reputationLimit: usage.reputation,
    productScenarioLimit: usage.productScenario,
    totalQuestionLimit: usage.total,
  } satisfies ServiceQuotaLimits;
}

export function validateQuestionQuotaAdjustment(input: {
  expectedRevision: number;
  currentRevision: number;
  limits: Omit<ServiceQuotaLimits, "totalQuestionLimit">;
  maximumLimits?: ServiceQuotaLimits;
  reservedUsage: ServiceQuotaUsage;
}) {
  if (input.expectedRevision !== input.currentRevision) {
    throw new AuthServiceError(
      "CONFLICT",
      "问题额度已被其他人更新，请刷新后重试",
    );
  }
  const limits: ServiceQuotaLimits = {
    ...input.limits,
    totalQuestionLimit:
      input.limits.industryLimit +
      input.limits.competitorComparisonLimit +
      input.limits.reputationLimit +
      input.limits.productScenarioLimit,
  };
  const minimums = questionQuotaUsageMinimums(input.reservedUsage);
  const labels: Array<[keyof ServiceQuotaLimits, string]> = [
    ["industryLimit", "行业排名词"],
    ["competitorComparisonLimit", "竞品对比词"],
    ["reputationLimit", "美誉舆情词"],
    ["productScenarioLimit", "产品场景词"],
    ["totalQuestionLimit", "问题总数"],
  ];
  for (const [key, label] of labels) {
    if (input.maximumLimits && limits[key] > input.maximumLimits[key]) {
      throw new AuthServiceError(
        "CONFLICT",
        `${label}额度不能超过当前已解锁上限 ${input.maximumLimits[key]}`,
      );
    }
    if (limits[key] < minimums[key]) {
      throw new AuthServiceError(
        "CONFLICT",
        `${label}额度不能低于当前已确认与待审核预留数量 ${minimums[key]}`,
      );
    }
  }
  return { limits, revision: input.currentRevision + 1 };
}

function questionUsageRows(
  executor: any,
  userId: number,
  scope: ReturnType<typeof resolveServiceQuestionQuotaScope>,
) {
  return executor
    .select({
      category: workspaceQuestions.category,
      candidateKey: workspaceQuestions.candidateKey,
      source: workspaceQuestions.source,
      status: workspaceQuestions.status,
      selectionApprovalStatus: workspaceQuestions.selectionApprovalStatus,
    })
    .from(workspaceQuestions)
    .where(
      and(
        eq(workspaceQuestions.userId, userId),
        scope.kind === "contract"
          ? eq(workspaceQuestions.contractId, scope.contractId)
          : eq(workspaceQuestions.quotaPeriodId, scope.periodId),
        inArray(workspaceQuestions.status, ["candidate", "selected"]),
        or(
          eq(workspaceQuestions.status, "selected"),
          eq(workspaceQuestions.selectionApprovalStatus, "pending"),
        ),
      ),
    );
}

/** Returns only the period-bound fields needed by an engineer workbench. */
export async function getQuestionQuotaState(input: {
  executor: any;
  customerUserId: number;
  now?: Date;
}): Promise<QuestionQuotaState | null> {
  const now = input.now ?? new Date();
  const contractRows = await input.executor
    .select()
    .from(serviceContracts)
    .where(eq(serviceContracts.userId, input.customerUserId))
    .orderBy(desc(serviceContracts.revision));
  const contract = selectPortalContract(
    contractRows as ServicePortalContractRecord[],
    now,
  );
  if (
    !contract ||
    deriveEffectiveServiceStatus(contract, now) !== "active" ||
    !isEditableQuestionPlan(contract.planCode)
  ) {
    return null;
  }
  const periodRows = await input.executor
    .select()
    .from(serviceQuotaPeriods)
    .where(
      and(
        eq(serviceQuotaPeriods.userId, input.customerUserId),
        eq(serviceQuotaPeriods.contractId, contract.id),
        gt(serviceQuotaPeriods.ordinal, SERVICE_QUESTION_QUOTA_ANCHOR_ORDINAL),
        lte(serviceQuotaPeriods.startsAt, now),
        gt(serviceQuotaPeriods.endsAt, now),
      ),
    )
    .orderBy(asc(serviceQuotaPeriods.ordinal))
    .limit(1);
  const period = periodRows.find(isOperationalServiceQuotaPeriod);
  if (!period) return null;
  const scope = resolveServiceQuestionQuotaScope(contract, period);
  const rows = (await questionUsageRows(
    input.executor,
    input.customerUserId,
    scope,
  )) as QuestionQuotaUsageRow[];
  return toQuestionQuotaState({ contract, period, rows, now });
}

type QuestionQuotaDependencies = {
  getDatabase?: typeof getDb;
  writeAudit?: typeof writeWorkspaceAuditEvent;
  now?: () => Date;
};

function affectedRows(value: unknown) {
  const header = Array.isArray(value) ? value[0] : value;
  return Number(
    (header as { affectedRows?: number } | null)?.affectedRows ?? 0,
  );
}

function assertEligibleActor(actor: AuthenticatedUser) {
  if (!actor.isActive) {
    throw new AuthServiceError("ACCOUNT_DISABLED", "账号已停用");
  }
  if (hasSystemAdminAccess(actor)) return;
  if (
    actor.role !== "delivery_member" ||
    actor.engineerRoleType !== QUESTION_QUOTA_ROLE
  ) {
    throw new AuthServiceError(
      "INVALID_CREDENTIAL",
      "只有负责当前客户的 AI 监控与优化工程师或系统管理员可以调整问题额度",
    );
  }
}

export async function adjustMyCustomerQuestionQuota(input: {
  actor: AuthenticatedUser;
  value: AdjustQuestionQuotaInput;
  dependencies?: QuestionQuotaDependencies;
}) {
  assertEligibleActor(input.actor);
  const getDatabase = input.dependencies?.getDatabase ?? getDb;
  const db = await getDatabase();
  if (!db) {
    throw new AuthServiceError("DATABASE_UNAVAILABLE", "数据库暂时不可用");
  }
  const audit = input.dependencies?.writeAudit ?? writeWorkspaceAuditEvent;
  const now = input.dependencies?.now?.() ?? new Date();
  const systemAdmin = hasSystemAdminAccess(input.actor);

  return db.transaction(async (tx) => {
    const assignmentRows = await tx
      .select({
        projectAssignmentId: deliveryProjectAssignments.id,
        customerUserId: deliveryProjectAssignments.customerUserId,
        roleType: deliveryProjectAssignments.roleType,
        engineerUserId: deliveryProjectAssignments.engineerUserId,
      })
      .from(deliveryProjectAssignments)
      .innerJoin(users, eq(users.id, deliveryProjectAssignments.customerUserId))
      .where(
        and(
          eq(deliveryProjectAssignments.id, input.value.projectAssignmentId),
          eq(deliveryProjectAssignments.roleType, QUESTION_QUOTA_ROLE),
          systemAdmin
            ? undefined
            : eq(deliveryProjectAssignments.engineerUserId, input.actor.id),
          eq(users.role, "user"),
          eq(users.isActive, true),
        ),
      )
      .limit(1)
      .for("update");
    const assignment = assignmentRows[0];
    if (
      !assignment ||
      assignment.roleType !== QUESTION_QUOTA_ROLE ||
      (!systemAdmin && assignment.engineerUserId !== input.actor.id)
    ) {
      throw new AuthServiceError("NOT_FOUND", "当前客户问题项目不存在");
    }

    // Match the selection workflow lock order: customer -> period -> contract
    // -> question rows. This keeps quota edits and concurrent selections safe.
    const periodRows = await tx
      .select()
      .from(serviceQuotaPeriods)
      .where(
        and(
          eq(serviceQuotaPeriods.id, input.value.quotaPeriodId),
          eq(serviceQuotaPeriods.userId, assignment.customerUserId),
        ),
      )
      .limit(1)
      .for("update");
    const period = periodRows[0];
    if (!period) {
      throw new AuthServiceError("NOT_FOUND", "当前问题额度周期不存在");
    }

    const contractRows = await tx
      .select()
      .from(serviceContracts)
      .where(eq(serviceContracts.userId, assignment.customerUserId))
      .orderBy(desc(serviceContracts.revision))
      .for("update");
    const currentContract = selectPortalContract(
      contractRows as ServicePortalContractRecord[],
      now,
    );
    if (
      !currentContract ||
      currentContract.id !== period.contractId ||
      deriveEffectiveServiceStatus(currentContract, now) !== "active" ||
      !isEditableQuestionPlan(currentContract.planCode) ||
      (isProgressiveLuxuryContract(currentContract) &&
        !isOperationalServiceQuotaPeriod(period)) ||
      period.startsAt.getTime() > now.getTime() ||
      period.endsAt.getTime() <= now.getTime()
    ) {
      throw new AuthServiceError(
        "CONFLICT",
        "只有服务中的进阶版或豪华版当前周期可以调整问题额度",
      );
    }

    const scope = resolveServiceQuestionQuotaScope(currentContract, period);
    const rows = (await questionUsageRows(
      tx,
      assignment.customerUserId,
      scope,
    ).for("update")) as QuestionQuotaUsageRow[];
    const usage = countQuestionQuotaUsage(rows, {
      reserveUnclassifiedAcrossCategories:
        isProgressiveLuxuryContract(currentContract),
    });
    const unlock = resolveServiceQuestionQuotaUnlockMetadata({
      contract: currentContract,
      period,
      now,
    });
    const next = validateQuestionQuotaAdjustment({
      expectedRevision: input.value.expectedRevision,
      currentRevision: period.revision,
      limits: {
        industryLimit: input.value.industryLimit,
        competitorComparisonLimit: input.value.competitorComparisonLimit,
        reputationLimit: input.value.reputationLimit,
        productScenarioLimit: input.value.productScenarioLimit,
      },
      maximumLimits: isProgressiveLuxuryContract(currentContract)
        ? unlock.unlockedLimits
        : undefined,
      reservedUsage: usage.reservedUsage,
    });

    const updateResult = await tx
      .update(serviceQuotaPeriods)
      .set({
        ...next.limits,
        revision: next.revision,
        updatedAt: now,
      })
      .where(
        and(
          eq(serviceQuotaPeriods.id, period.id),
          eq(serviceQuotaPeriods.userId, assignment.customerUserId),
          eq(serviceQuotaPeriods.revision, period.revision),
        ),
      );
    if (affectedRows(updateResult) !== 1) {
      throw new AuthServiceError(
        "CONFLICT",
        "问题额度已被其他人更新，请刷新后重试",
      );
    }

    await audit(
      {
        actor: input.actor,
        action: "service_quota_period.question_limits_adjusted",
        targetType: "service_quota_period",
        targetId: period.id,
        workspaceUserId: assignment.customerUserId,
        reason: input.value.reason,
        metadata: {
          projectAssignmentId: assignment.projectAssignmentId,
          planCode: currentContract.planCode,
          previousRevision: period.revision,
          revision: next.revision,
          previousLimits: quotaLimits(period),
          unlockedLimits: unlock.unlockedLimits,
          limits: next.limits,
          selectedUsage: usage.selectedUsage,
          reservedUsage: usage.reservedUsage,
        },
      },
      tx,
    );

    return {
      success: true as const,
      questionQuota: toQuestionQuotaState({
        contract: currentContract,
        period,
        rows,
        now,
        storedLimits: next.limits,
        revision: next.revision,
      }),
    };
  });
}
