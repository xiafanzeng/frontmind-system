import { createHash, randomUUID } from "node:crypto";

import {
  and,
  asc,
  desc,
  eq,
  gt,
  inArray,
  isNotNull,
  lte,
  or,
  sql,
} from "drizzle-orm";

import {
  knowledgeBaseBuilds,
  knowledgeBaseSnapshots,
  knowledgeImportReceipts,
  deliveryTicketEvents,
  deliveryTickets,
  monitoringBatches,
  monitoringCitationRecords,
  monitoringSamples,
  responseLogicEntries,
  serviceContracts,
  serviceProgressReports,
  serviceQuotaPeriods,
  userDashboardContents,
  users,
  workspaceQuestions,
  type WorkspaceQuestion,
  type WorkspaceQuestionEvidenceRecord,
} from "../drizzle/schema";
import {
  EMPTY_SERVICE_QUOTA_USAGE,
  QUESTION_CLASSIFICATION_V2_WRITES_ENABLED,
  SERVICE_PLAN_CATALOG,
  SERVICE_QUESTION_CATEGORY_LIMIT_KEYS,
  serviceCapabilityKeySchema,
  servicePlanCodeSchema,
  workspaceQuestionCategorySchema,
  type EffectiveServiceStatus,
  type ServiceCapabilityKey,
  type ServiceContractSource,
  type ServicePlanCode,
  type ServicePortal,
  type ServicePortalQuestion,
  type SelectedServicePortalQuestion,
  type ServiceQuotaLimits,
  type ServiceQuotaUsage,
  type WorkspaceQuestionCategory,
} from "../shared/service-portal";
import { DELIVERY_TICKET_LIMITS } from "../shared/delivery-ticket";
import { dashboardPayloadSchema } from "../shared/dashboard";
import {
  resolveBrandKeywordSelection,
  type BrandKeywordSelectionReference,
} from "./brand-keyword-selection";
import { getDb } from "./db";
import { getLatestAuthenticatedKnowledgeSnapshot } from "./authenticated-knowledge-service";
import {
  isUserQuestionPendingClassification,
  questionCategoryForPublic,
  UNCLASSIFIED_QUESTION_CANDIDATE_KEY,
  UNCLASSIFIED_QUESTION_STORAGE_CATEGORY,
} from "./question-selection-policy";

export type PersistedServiceContractStatus =
  | "pending_confirmation"
  | "scheduled"
  | "active"
  | "suspended"
  | "cancelled"
  | "superseded";

export type KnowledgeImportStatus =
  | "pending"
  | "processing"
  | "completed"
  | "failed";

type DateValue = Date | number | string;

export type ServicePortalContractRecord = {
  id: string;
  userId: number;
  planCode: ServicePlanCode;
  planVersion: number;
  status: PersistedServiceContractStatus;
  startsAt: DateValue;
  endsAt: DateValue;
  source: ServiceContractSource;
  amountFen?: number | null;
  currency?: string | null;
  prepaidMonths?: number | null;
  orderReference?: string | null;
  externalContractReference?: string | null;
  signedAt?: DateValue | null;
  signatoryId?: string | null;
  signingEvidence?: Record<string, unknown> | null;
  replacesContractIds?: string[] | null;
  sourceReference?: string | null;
  revision: number;
  createdAt: DateValue;
};

export type ServicePortalQuotaPeriodRecord = {
  id: string;
  contractId: string;
  userId: number;
  ordinal: number;
  startsAt: DateValue;
  endsAt: DateValue;
  industryLimit: number;
  competitorComparisonLimit: number;
  reputationLimit: number;
  productScenarioLimit: number;
  totalQuestionLimit: number;
  revision: number;
};

type ServicePortalQuestionRecord = Pick<
  WorkspaceQuestion,
  | "id"
  | "quotaPeriodId"
  | "candidateKey"
  | "category"
  | "question"
  | "source"
  | "status"
  | "selectionApprovalStatus"
  | "selectionRequestedAt"
  | "selectionApprovedAt"
  | "locked"
  | "revision"
> &
  Partial<
    Pick<
      WorkspaceQuestion,
      | "contractId"
      | "externalQuestionId"
      | "sourceQuestionId"
      | "intent"
      | "intentRevision"
      | "intentConfirmedRevision"
      | "intentConfirmedAt"
      | "intentConfirmedByUserId"
      | "rationale"
      | "evidence"
      | "risks"
    >
  >;

export type ServicePortalStateInput = {
  userId: number;
  now?: DateValue;
  account?: {
    userId: number;
    username: string | null;
    displayName: string | null;
  } | null;
  contract?: ServicePortalContractRecord | null;
  contracts?: ServicePortalContractRecord[];
  quotaPeriod?: ServicePortalQuotaPeriodRecord | null;
  quotaPeriods?: ServicePortalQuotaPeriodRecord[];
  selectedQuestions?: ServicePortalQuestionRecord[];
  historicalQuestions?: ServicePortalQuestionRecord[];
  knowledgeVersion?: number | null;
  authenticatedKnowledgeVersion?: number | null;
  hasActiveKnowledgeBuild?: boolean;
  latestImportStatus?: KnowledgeImportStatus | null;
  currentPeriodCandidateCount?: number;
  currentPeriodPendingApprovalCount?: number;
  /**
   * @deprecated The active workflow no longer has an intent-optimization
   * gate. Retained only so older repository adapters can keep supplying the
   * field while they migrate; portal derivation intentionally ignores it.
   */
  optimizedQuestionIds?: string[];
  confirmedResponseLogicQuestionIds?: string[];
  monitoringQuestionIds?: string[];
  channelDistributionQuestionIds?: string[];
  hasProgressReport?: boolean;
  entitlementRollout?: ServiceEntitlementRolloutState;
};

export type ServiceEntitlementRolloutState = {
  mode: "compatibility" | "enforced";
  pendingUserCount: number;
};

export interface ServiceEntitlementRepository {
  loadPortalState(userId: number, now: Date): Promise<ServicePortalStateInput>;
}

export type ServiceEntitlementErrorCode =
  | "DATABASE_UNAVAILABLE"
  | "SERVICE_PLAN_UNCONFIGURED"
  | "SERVICE_PLAN_PENDING_CONFIRMATION"
  | "SERVICE_PLAN_NOT_STARTED"
  | "SERVICE_PLAN_SUSPENDED"
  | "SERVICE_PLAN_EXPIRED"
  | "CAPABILITY_UPGRADE_REQUIRED"
  | "SERVICE_REVISION_CONFLICT"
  | "QUOTA_PERIOD_NOT_FOUND"
  | "QUESTION_NOT_FOUND"
  | "QUESTION_NOT_CURRENT"
  | "QUESTION_REVISION_CONFLICT"
  | "QUESTION_INTENT_NOT_READY"
  | "QUESTION_INTENT_REVISION_CONFLICT"
  | "QUESTION_SELECTION_CONFIRMATION_REQUIRED"
  | "QUESTION_CATEGORY_QUOTA_EXCEEDED"
  | "QUESTION_TOTAL_QUOTA_EXCEEDED"
  | "QUESTION_GENERATION_CONFLICT"
  | "QUESTION_GENERATION_CONTEXT_STALE"
  | "UPGRADE_RECONCILIATION_REQUIRED"
  | "KNOWLEDGE_SNAPSHOT_NOT_FOUND"
  | "SERVICE_WORKFLOW_PREREQUISITE_REQUIRED";

export class ServiceEntitlementError extends Error {
  constructor(
    public readonly code: ServiceEntitlementErrorCode,
    message: string,
    public readonly statusCode = 409,
  ) {
    super(message);
    this.name = "ServiceEntitlementError";
  }
}

const DAY_MS = 24 * 60 * 60 * 1_000;
const SHANGHAI_UTC_OFFSET_MS = 8 * 60 * 60 * 1_000;
export const PROGRESSIVE_LUXURY_PLAN_VERSION = 2;
export const PROGRESSIVE_LUXURY_UNLOCK_STAGE_TOTAL = 4;
/**
 * Compatibility sentinel understood by the previous Dashboard image as the
 * one annual question quota period. Luxury v2 keeps operational work on the
 * positive monthly ordinals and stores every question on this anchor so a
 * rollback can still read the cohort and conservatively reject excess writes.
 */
export const SERVICE_QUESTION_QUOTA_ANCHOR_ORDINAL = 0;
const ACTIVE_BUILD_STATUSES = [
  "researching",
  "confirming",
  "ready_to_publish",
] as const;

function asDate(value: DateValue): Date {
  const date =
    value instanceof Date ? new Date(value.getTime()) : new Date(value);
  if (!Number.isFinite(date.getTime())) {
    throw new TypeError("Invalid service date");
  }
  return date;
}

function epoch(value: DateValue): number {
  return asDate(value).getTime();
}

export type WorkspaceQuestionIntentConfirmationRecord = {
  intent?: string | null;
  intentRevision?: number | null;
  intentConfirmedRevision?: number | null;
  intentConfirmedAt?: DateValue | null;
  intentConfirmedByUserId?: number | null;
};

/**
 * Generated and admin-authored intent text remains a suggestion until the
 * account owner explicitly confirms that exact suggestion revision.
 */
export function isWorkspaceQuestionIntentExplicitlyConfirmed(
  question: WorkspaceQuestionIntentConfirmationRecord,
): boolean {
  const intentRevision = question.intentRevision ?? 1;
  return Boolean(
    question.intent?.trim() &&
      question.intentConfirmedAt &&
      question.intentConfirmedByUserId &&
      question.intentConfirmedRevision === intentRevision,
  );
}

/**
 * Adds calendar months in UTC and clamps end-of-month dates. Calculating every
 * boundary from the original start avoids Jan 31 -> Feb 28 -> Mar 28 drift.
 */
export function addServiceCalendarMonths(
  value: DateValue,
  count: number,
): Date {
  const source = asDate(value);
  const year = source.getUTCFullYear();
  const month = source.getUTCMonth() + count;
  const day = source.getUTCDate();
  const lastDay = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
  return new Date(
    Date.UTC(
      year,
      month,
      Math.min(day, lastDay),
      source.getUTCHours(),
      source.getUTCMinutes(),
      source.getUTCSeconds(),
      source.getUTCMilliseconds(),
    ),
  );
}

/**
 * Adds calendar months in the Asia/Shanghai business calendar. Shanghai has
 * no daylight-saving transition, so shifting the instant by UTC+08:00 lets us
 * reuse UTC calendar arithmetic without relying on the host timezone.
 */
export function addServiceShanghaiCalendarMonths(
  value: DateValue,
  count: number,
): Date {
  const shifted = new Date(asDate(value).getTime() + SHANGHAI_UTC_OFFSET_MS);
  const shiftedResult = addServiceCalendarMonths(shifted, count);
  return new Date(shiftedResult.getTime() - SHANGHAI_UTC_OFFSET_MS);
}

type ServicePlanVersionOptions = { planVersion?: number };

function resolvedServicePlanVersion(
  planCode: ServicePlanCode,
  options?: ServicePlanVersionOptions,
) {
  return options?.planVersion ?? SERVICE_PLAN_CATALOG[planCode].planVersion;
}

export function isProgressiveLuxuryContract(
  contract:
    | Pick<ServicePortalContractRecord, "planCode" | "planVersion">
    | null
    | undefined,
): boolean {
  return Boolean(
    contract?.planCode === "luxury" &&
      contract.planVersion >= PROGRESSIVE_LUXURY_PLAN_VERSION,
  );
}

export function getServiceContractTermEnd(
  planCode: ServicePlanCode,
  startsAt: DateValue,
  options?: ServicePlanVersionOptions,
): Date {
  const plan = SERVICE_PLAN_CATALOG[planCode];
  const start = asDate(startsAt);
  const planVersion = resolvedServicePlanVersion(planCode, options);
  if (planCode === "luxury" && planVersion < PROGRESSIVE_LUXURY_PLAN_VERSION) {
    return addServiceCalendarMonths(start, 3);
  }
  return plan.contractTerm.unit === "day"
    ? new Date(start.getTime() + plan.contractTerm.count * DAY_MS)
    : planCode === "luxury" && planVersion >= PROGRESSIVE_LUXURY_PLAN_VERSION
      ? addServiceShanghaiCalendarMonths(start, plan.contractTerm.count)
      : addServiceCalendarMonths(start, plan.contractTerm.count);
}

export type ServiceQuotaWindow = {
  ordinal: number;
  startsAt: Date;
  endsAt: Date;
  limits: ServiceQuotaLimits;
};

export function isServiceQuestionQuotaAnchor(
  period: Pick<ServiceQuotaWindow, "ordinal">,
): boolean {
  return period.ordinal === SERVICE_QUESTION_QUOTA_ANCHOR_ORDINAL;
}

export function isOperationalServiceQuotaPeriod(
  period: Pick<ServiceQuotaWindow, "ordinal">,
): boolean {
  return period.ordinal > SERVICE_QUESTION_QUOTA_ANCHOR_ORDINAL;
}

export function serviceQuotaWindowDeliveryLimits(
  planCode: ServicePlanCode,
  window: Pick<ServiceQuotaWindow, "ordinal">,
) {
  if (isServiceQuestionQuotaAnchor(window)) {
    return {
      contentAssetPublishLimit: 0,
      websiteContentPublishLimit: 0,
    };
  }
  return {
    contentAssetPublishLimit:
      DELIVERY_TICKET_LIMITS[planCode].content_asset_publish,
    websiteContentPublishLimit:
      DELIVERY_TICKET_LIMITS[planCode].website_content_publish,
  };
}

export function createServiceQuotaWindows(
  planCode: ServicePlanCode,
  startsAt: DateValue,
  options?: ServicePlanVersionOptions,
): ServiceQuotaWindow[] {
  const plan = SERVICE_PLAN_CATALOG[planCode];
  const start = asDate(startsAt);
  const planVersion = resolvedServicePlanVersion(planCode, options);
  const contractEnd = getServiceContractTermEnd(planCode, start, {
    planVersion,
  });
  if (planCode === "luxury" && planVersion >= PROGRESSIVE_LUXURY_PLAN_VERSION) {
    const compatibilityAnchor: ServiceQuotaWindow = {
      ordinal: SERVICE_QUESTION_QUOTA_ANCHOR_ORDINAL,
      startsAt: start,
      endsAt: contractEnd,
      // The previous image reads persisted limits without understanding the
      // quarterly unlock schedule. Persist only Q1 so rollback is fail-closed.
      limits: progressiveLuxuryUnlockedLimits(1),
    };
    const operationalWindows = Array.from({ length: 12 }, (_, index) => {
      const ordinal = index + 1;
      const unlockStage = Math.min(
        PROGRESSIVE_LUXURY_UNLOCK_STAGE_TOTAL,
        Math.ceil(ordinal / 3),
      );
      const limits = Object.fromEntries(
        Object.entries(plan.limits).map(([key, value]) => [
          key,
          Math.floor(
            (value * unlockStage) / PROGRESSIVE_LUXURY_UNLOCK_STAGE_TOTAL,
          ),
        ]),
      ) as ServiceQuotaLimits;
      return {
        ordinal,
        startsAt: addServiceShanghaiCalendarMonths(start, index),
        endsAt:
          index === 11
            ? contractEnd
            : addServiceShanghaiCalendarMonths(start, index + 1),
        limits,
      };
    });
    return [compatibilityAnchor, ...operationalWindows];
  }
  if (plan.quotaCadence !== "month") {
    return [
      {
        ordinal: 1,
        startsAt: start,
        endsAt: contractEnd,
        limits: { ...plan.limits },
      },
    ];
  }
  const windowCount =
    planCode === "luxury" && planVersion < PROGRESSIVE_LUXURY_PLAN_VERSION
      ? 3
      : (plan.prepaidMonths ?? 1);
  return Array.from({ length: windowCount }, (_, index) => ({
    ordinal: index + 1,
    startsAt: addServiceCalendarMonths(start, index),
    endsAt:
      index === windowCount - 1
        ? contractEnd
        : addServiceCalendarMonths(start, index + 1),
    limits: { ...plan.limits },
  }));
}

export function selectServiceQuotaWindowAt(
  windows: ServiceQuotaWindow[],
  value: DateValue,
) {
  const operationalWindows = windows.filter(isOperationalServiceQuotaPeriod);
  if (!operationalWindows.length) return null;
  const timestamp = epoch(value);
  return (
    operationalWindows.find(
      (window) =>
        epoch(window.startsAt) <= timestamp && timestamp < epoch(window.endsAt),
    ) ??
    (timestamp < epoch(operationalWindows[0]!.startsAt)
      ? operationalWindows[0]!
      : operationalWindows.at(-1)!)
  );
}

export function selectServiceQuestionStoragePeriod<
  T extends Pick<
    ServicePortalQuotaPeriodRecord,
    "id" | "contractId" | "ordinal"
  >,
>(input: {
  contract: Pick<
    ServicePortalContractRecord,
    "id" | "planCode" | "planVersion"
  >;
  operationalPeriod: T;
  contractPeriods: T[];
}): T | null {
  if (!isProgressiveLuxuryContract(input.contract)) {
    return input.operationalPeriod;
  }
  if (!isOperationalServiceQuotaPeriod(input.operationalPeriod)) return null;
  return (
    input.contractPeriods.find(
      (period) =>
        period.contractId === input.contract.id &&
        isServiceQuestionQuotaAnchor(period),
    ) ?? null
  );
}

type ServiceQuestionQuotaPeriod = Pick<
  ServicePortalQuotaPeriodRecord,
  | "id"
  | "contractId"
  | "ordinal"
  | "startsAt"
  | "endsAt"
  | "industryLimit"
  | "competitorComparisonLimit"
  | "reputationLimit"
  | "productScenarioLimit"
  | "totalQuestionLimit"
>;

export type ServiceQuestionQuotaScope =
  | { kind: "contract"; contractId: string }
  | { kind: "period"; periodId: string };

export function resolveServiceQuestionQuotaScope(
  contract: Pick<
    ServicePortalContractRecord,
    "id" | "planCode" | "planVersion"
  >,
  period: Pick<ServicePortalQuotaPeriodRecord, "id">,
): ServiceQuestionQuotaScope {
  return isProgressiveLuxuryContract(contract)
    ? { kind: "contract", contractId: contract.id }
    : { kind: "period", periodId: period.id };
}

async function loadServiceQuestionStoragePeriod(input: {
  executor: any;
  userId: number;
  contract: Pick<
    ServicePortalContractRecord,
    "id" | "planCode" | "planVersion"
  >;
  operationalPeriod: typeof serviceQuotaPeriods.$inferSelect;
}) {
  if (!isProgressiveLuxuryContract(input.contract)) {
    return input.operationalPeriod;
  }
  if (!isOperationalServiceQuotaPeriod(input.operationalPeriod)) return null;
  const anchorRows = await input.executor
    .select()
    .from(serviceQuotaPeriods)
    .where(
      and(
        eq(serviceQuotaPeriods.userId, input.userId),
        eq(serviceQuotaPeriods.contractId, input.contract.id),
        eq(serviceQuotaPeriods.ordinal, SERVICE_QUESTION_QUOTA_ANCHOR_ORDINAL),
      ),
    )
    .limit(1);
  return selectServiceQuestionStoragePeriod({
    contract: input.contract,
    operationalPeriod: input.operationalPeriod,
    contractPeriods: anchorRows,
  });
}

export function isQuestionInServiceQuotaScope(
  question: { contractId?: string | null; quotaPeriodId: string },
  scope: ServiceQuestionQuotaScope,
): boolean {
  return scope.kind === "contract"
    ? question.contractId === scope.contractId
    : question.quotaPeriodId === scope.periodId;
}

function persistedServiceQuestionQuotaLimits(
  period: ServiceQuestionQuotaPeriod,
): ServiceQuotaLimits {
  return {
    industryLimit: period.industryLimit,
    competitorComparisonLimit: period.competitorComparisonLimit,
    reputationLimit: period.reputationLimit,
    productScenarioLimit: period.productScenarioLimit,
    totalQuestionLimit: period.totalQuestionLimit,
  };
}

function progressiveLuxuryUnlockedLimits(stage: number): ServiceQuotaLimits {
  const entitlement = SERVICE_PLAN_CATALOG.luxury.limits;
  const safeStage = Math.max(
    1,
    Math.min(PROGRESSIVE_LUXURY_UNLOCK_STAGE_TOTAL, Math.trunc(stage)),
  );
  return {
    industryLimit: Math.floor(
      (entitlement.industryLimit * safeStage) /
        PROGRESSIVE_LUXURY_UNLOCK_STAGE_TOTAL,
    ),
    competitorComparisonLimit: Math.floor(
      (entitlement.competitorComparisonLimit * safeStage) /
        PROGRESSIVE_LUXURY_UNLOCK_STAGE_TOTAL,
    ),
    reputationLimit: Math.floor(
      (entitlement.reputationLimit * safeStage) /
        PROGRESSIVE_LUXURY_UNLOCK_STAGE_TOTAL,
    ),
    productScenarioLimit: Math.floor(
      (entitlement.productScenarioLimit * safeStage) /
        PROGRESSIVE_LUXURY_UNLOCK_STAGE_TOTAL,
    ),
    totalQuestionLimit: Math.floor(
      (entitlement.totalQuestionLimit * safeStage) /
        PROGRESSIVE_LUXURY_UNLOCK_STAGE_TOTAL,
    ),
  };
}

export function resolveServiceQuestionQuotaUnlockMetadata(input: {
  contract: Pick<
    ServicePortalContractRecord,
    "planCode" | "planVersion" | "startsAt" | "endsAt"
  >;
  period: ServiceQuestionQuotaPeriod;
  now?: DateValue;
}) {
  const persistedLimits = persistedServiceQuestionQuotaLimits(input.period);
  if (!isProgressiveLuxuryContract(input.contract)) {
    return {
      entitlementLimits: persistedLimits,
      unlockedLimits: persistedLimits,
      unlockStage: { current: 1, total: 1 },
      nextUnlockAt: null,
    };
  }

  const now = asDate(input.now ?? new Date());
  const startsAt = asDate(input.contract.startsAt);
  let current = 1;
  for (
    let stage = 2;
    stage <= PROGRESSIVE_LUXURY_UNLOCK_STAGE_TOTAL;
    stage += 1
  ) {
    const boundary = addServiceShanghaiCalendarMonths(
      startsAt,
      (stage - 1) * 3,
    );
    if (now.getTime() >= boundary.getTime()) current = stage;
  }
  const nextUnlockAt =
    current < PROGRESSIVE_LUXURY_UNLOCK_STAGE_TOTAL
      ? addServiceShanghaiCalendarMonths(startsAt, current * 3).getTime()
      : null;
  return {
    entitlementLimits: { ...SERVICE_PLAN_CATALOG.luxury.limits },
    unlockedLimits: progressiveLuxuryUnlockedLimits(current),
    unlockStage: {
      current,
      total: PROGRESSIVE_LUXURY_UNLOCK_STAGE_TOTAL,
    },
    nextUnlockAt,
  };
}

export function resolveEffectiveServiceQuestionQuotaLimits(input: {
  contract: Pick<
    ServicePortalContractRecord,
    "planCode" | "planVersion" | "startsAt" | "endsAt"
  >;
  period: ServiceQuestionQuotaPeriod;
  now?: DateValue;
}): ServiceQuotaLimits {
  const persisted = persistedServiceQuestionQuotaLimits(input.period);
  const unlocked =
    resolveServiceQuestionQuotaUnlockMetadata(input).unlockedLimits;
  return {
    industryLimit: Math.min(persisted.industryLimit, unlocked.industryLimit),
    competitorComparisonLimit: Math.min(
      persisted.competitorComparisonLimit,
      unlocked.competitorComparisonLimit,
    ),
    reputationLimit: Math.min(
      persisted.reputationLimit,
      unlocked.reputationLimit,
    ),
    productScenarioLimit: Math.min(
      persisted.productScenarioLimit,
      unlocked.productScenarioLimit,
    ),
    totalQuestionLimit: Math.min(
      persisted.totalQuestionLimit,
      unlocked.totalQuestionLimit,
    ),
  };
}

export function resolveServiceQuestionQuotaCapacityState(input: {
  remaining: ServiceQuotaUsage;
  nextUnlockAt: number | null;
}): "available" | "awaiting_unlock" | "exhausted" {
  if (input.remaining.total > 0) return "available";
  return input.nextUnlockAt === null ? "exhausted" : "awaiting_unlock";
}

export function progressiveLuxuryCompatibilityAnchorValues() {
  return {
    ...progressiveLuxuryUnlockedLimits(1),
    contentAssetPublishLimit: 0,
    websiteContentPublishLimit: 0,
  };
}

/**
 * Repairs a privileged edit made while the previous image was active. The
 * anchor is compatibility-only, so its conservative Q1/zero-delivery values
 * are canonical and must never inherit an operational override.
 */
export async function reconcileProgressiveLuxuryCompatibilityAnchors(input: {
  executor: any;
  contractIds: string[];
  now?: Date;
}) {
  const contractIds = [...new Set(input.contractIds)];
  if (!contractIds.length) return;
  const canonical = progressiveLuxuryCompatibilityAnchorValues();
  await input.executor
    .update(serviceQuotaPeriods)
    .set({
      ...canonical,
      revision: sql`${serviceQuotaPeriods.revision} + 1`,
      updatedAt: input.now ?? new Date(),
    })
    .where(
      and(
        inArray(serviceQuotaPeriods.contractId, contractIds),
        eq(serviceQuotaPeriods.ordinal, SERVICE_QUESTION_QUOTA_ANCHOR_ORDINAL),
        sql`(
          ${serviceQuotaPeriods.industryLimit} <> ${canonical.industryLimit}
          OR ${serviceQuotaPeriods.competitorComparisonLimit} <> ${canonical.competitorComparisonLimit}
          OR ${serviceQuotaPeriods.reputationLimit} <> ${canonical.reputationLimit}
          OR ${serviceQuotaPeriods.productScenarioLimit} <> ${canonical.productScenarioLimit}
          OR ${serviceQuotaPeriods.totalQuestionLimit} <> ${canonical.totalQuestionLimit}
          OR ${serviceQuotaPeriods.contentAssetPublishLimit} <> 0
          OR ${serviceQuotaPeriods.websiteContentPublishLimit} <> 0
        )`,
      ),
    );
}

export function deriveEffectiveServiceStatus(
  contract: ServicePortalContractRecord | null | undefined,
  now: DateValue = new Date(),
): EffectiveServiceStatus {
  if (!contract) return "unconfigured";
  if (contract.status === "cancelled" || contract.status === "superseded") {
    return "cancelled";
  }
  if (epoch(contract.endsAt) <= epoch(now)) return "expired";
  if (contract.status === "pending_confirmation") {
    return "pending_confirmation";
  }
  if (contract.status === "suspended") return "suspended";
  if (epoch(contract.startsAt) > epoch(now)) return "scheduled";
  // A persisted "scheduled" row becomes effective at startsAt without a
  // background status rewrite.
  return "active";
}

/**
 * Selects the contract whose plan should label the workspace. Active paid
 * plans win over future/inactive rows, and higher plans win when a user buys
 * an additional Basic question while retaining an Advanced/Luxury workspace.
 */
export function selectPortalContract(
  contracts: ServicePortalContractRecord[],
  now: DateValue = new Date(),
): ServicePortalContractRecord | null {
  const statusRank: Record<EffectiveServiceStatus, number> = {
    active: 6,
    pending_confirmation: 5,
    scheduled: 4,
    suspended: 3,
    expired: 2,
    cancelled: 1,
    unconfigured: 0,
  };
  const planRank: Record<ServicePlanCode, number> = {
    basic: 1,
    advanced: 2,
    luxury: 3,
  };
  return (
    [...contracts].sort((left, right) => {
      const statusDifference =
        statusRank[deriveEffectiveServiceStatus(right, now)] -
        statusRank[deriveEffectiveServiceStatus(left, now)];
      if (statusDifference) return statusDifference;
      const planDifference = planRank[right.planCode] - planRank[left.planCode];
      if (planDifference) return planDifference;
      return right.revision - left.revision;
    })[0] ?? null
  );
}

export function selectCurrentServiceContractIds(
  contracts: ServicePortalContractRecord[],
  now: DateValue = new Date(),
) {
  const contract = selectPortalContract(contracts, now);
  if (!contract) return { contract: null, contractIds: [] as string[] };
  const replacedIds = new Set(contract.replacesContractIds ?? []);
  const supplementalBasicIds = contracts
    .filter(
      (value) =>
        value.planCode === "basic" &&
        value.id !== contract.id &&
        !replacedIds.has(value.id) &&
        deriveEffectiveServiceStatus(value, now) === "active",
    )
    .map((value) => value.id);
  return {
    contract,
    contractIds: [contract.id, ...supplementalBasicIds],
  };
}

export async function resolveCurrentServiceQuotaScope(input: {
  executor: any;
  userId: number;
  now?: Date;
}) {
  const now = input.now ?? new Date();
  const contractRows = (await input.executor
    .select()
    .from(serviceContracts)
    .where(eq(serviceContracts.userId, input.userId))
    .orderBy(desc(serviceContracts.revision))) as ServicePortalContractRecord[];
  const contract = selectPortalContract(contractRows, now);
  if (!contract || deriveEffectiveServiceStatus(contract, now) !== "active") {
    return null;
  }
  const periodRows = await input.executor
    .select()
    .from(serviceQuotaPeriods)
    .where(
      and(
        eq(serviceQuotaPeriods.userId, input.userId),
        eq(serviceQuotaPeriods.contractId, contract.id),
        gt(serviceQuotaPeriods.ordinal, SERVICE_QUESTION_QUOTA_ANCHOR_ORDINAL),
        lte(serviceQuotaPeriods.startsAt, now),
        gt(serviceQuotaPeriods.endsAt, now),
      ),
    )
    .orderBy(asc(serviceQuotaPeriods.ordinal))
    .limit(1);
  const period = periodRows.find(isOperationalServiceQuotaPeriod);
  return period ? { contract, period } : null;
}

function publicQuestion(
  row: NonNullable<ServicePortalStateInput["selectedQuestions"]>[number],
  confirmedResponseLogicQuestionIds: ReadonlySet<string> = new Set(),
): ServicePortalQuestion {
  return {
    id: row.id,
    contractId: row.contractId ?? null,
    quotaPeriodId: row.quotaPeriodId,
    externalQuestionId: row.externalQuestionId ?? null,
    sourceQuestionId: row.sourceQuestionId ?? null,
    category: questionCategoryForPublic({
      ...row,
      category: workspaceQuestionCategorySchema.parse(row.category),
    }),
    question: row.question,
    intent: row.intent ?? null,
    intentRevision: Math.max(1, row.intentRevision ?? 1),
    intentConfirmedRevision: row.intentConfirmedRevision ?? null,
    intentConfirmedAt: row.intentConfirmedAt
      ? epoch(row.intentConfirmedAt)
      : null,
    intentConfirmed: isWorkspaceQuestionIntentExplicitlyConfirmed(row),
    // A replacement question is a new delivery unit. `sourceQuestionId` is
    // lineage metadata for the historical page, never an output alias: using
    // it here would make the replacement inherit the archived question's
    // confirmed response logic.
    responseLogicConfirmed: confirmedResponseLogicQuestionIds.has(row.id),
    rationale: row.rationale ?? null,
    evidence: row.evidence ?? [],
    risks: row.risks ?? [],
    source: row.source,
    status: row.status,
    selectionApprovalStatus: row.selectionApprovalStatus ?? "not_requested",
    selectionRequestedAt: row.selectionRequestedAt
      ? epoch(row.selectionRequestedAt)
      : null,
    selectionApprovedAt: row.selectionApprovedAt
      ? epoch(row.selectionApprovedAt)
      : null,
    locked: row.locked,
    revision: Math.max(1, row.revision),
  };
}

function publicSelectedQuestion(
  row: NonNullable<ServicePortalStateInput["selectedQuestions"]>[number],
  confirmedResponseLogicQuestionIds: ReadonlySet<string> = new Set(),
): SelectedServicePortalQuestion {
  if (!["selected", "archived"].includes(row.status) || row.category === null) {
    throw new ServiceEntitlementError(
      "QUESTION_GENERATION_CONFLICT",
      "已确认的问题缺少有效分类，请联系服务团队处理。",
    );
  }
  return {
    ...publicQuestion(row, confirmedResponseLogicQuestionIds),
    category: workspaceQuestionCategorySchema.parse(row.category),
  };
}

/**
 * Keeps historical delivery results visible without allowing them to leak into
 * the current quota period or any model-backed workflow. The caller passes all
 * selected workspace questions; only rows belonging to the effective
 * contract(s) and current quota window are returned as current questions.
 */
export function partitionSelectedQuestionsForPortal(input: {
  questions: ServicePortalQuestionRecord[];
  currentContractIds: string[];
  activePeriodIds: string[];
  effectiveStatus: EffectiveServiceStatus;
  contract?: Pick<
    ServicePortalContractRecord,
    "id" | "planCode" | "planVersion"
  > | null;
}) {
  const currentContractIds = new Set(input.currentContractIds);
  const activePeriodIds = new Set(input.activePeriodIds);
  const canHaveCurrentQuestions = ![
    "expired",
    "cancelled",
    "unconfigured",
  ].includes(input.effectiveStatus);
  const current: ServicePortalQuestionRecord[] = [];
  const historical: ServicePortalQuestionRecord[] = [];

  for (const question of input.questions) {
    if (question.status === "archived") {
      if (
        question.selectionApprovalStatus === "approved" &&
        question.category !== null
      ) {
        historical.push(question);
      }
      continue;
    }
    if (question.status !== "selected") continue;
    const belongsToCurrentContract = Boolean(
      question.contractId && currentContractIds.has(question.contractId),
    );
    const belongsToCurrentPeriod =
      (isProgressiveLuxuryContract(input.contract) &&
        question.contractId === input.contract?.id) ||
      activePeriodIds.size === 0 ||
      activePeriodIds.has(question.quotaPeriodId);
    if (
      canHaveCurrentQuestions &&
      belongsToCurrentContract &&
      belongsToCurrentPeriod
    ) {
      current.push(question);
    } else {
      historical.push(question);
    }
  }

  return { current, historical };
}

export function countSelectedQuestionUsage(
  questions: Array<
    Pick<WorkspaceQuestion, "status" | "quotaPeriodId" | "category"> &
      Partial<Pick<WorkspaceQuestion, "contractId">>
  > = [],
  quotaPeriodIdOrScope?: string | ServiceQuestionQuotaScope,
): ServiceQuotaUsage {
  const usage: ServiceQuotaUsage = { ...EMPTY_SERVICE_QUOTA_USAGE };
  const scope =
    typeof quotaPeriodIdOrScope === "string"
      ? ({ kind: "period", periodId: quotaPeriodIdOrScope } as const)
      : quotaPeriodIdOrScope;
  for (const question of questions) {
    if (
      question.status !== "selected" ||
      (scope && !isQuestionInServiceQuotaScope(question, scope))
    ) {
      continue;
    }
    const category = workspaceQuestionCategorySchema.safeParse(
      question.category,
    );
    if (!category.success) {
      throw new ServiceEntitlementError(
        "QUESTION_GENERATION_CONFLICT",
        "已确认的问题缺少有效分类，请联系服务团队处理。",
      );
    }
    if (category.data === "industry") usage.industry += 1;
    if (category.data === "competitor_comparison") {
      usage.competitorComparison += 1;
    }
    if (category.data === "reputation") usage.reputation += 1;
    if (category.data === "product_scenario") {
      usage.productScenario += 1;
    }
    usage.total += 1;
  }
  return usage;
}

function remainingQuota(
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

function contractPurchaseStatus(
  contract: ServicePortalContractRecord,
  now: DateValue,
  effectivelyReplacedContractIds: ReadonlySet<string> = new Set(),
): ServicePortal["purchases"][number]["status"] {
  if (effectivelyReplacedContractIds.has(contract.id)) return "superseded";
  if (contract.status === "superseded") return "superseded";
  if (contract.status === "cancelled") return "cancelled";
  if (epoch(contract.endsAt) <= epoch(now)) return "expired";
  if (contract.status === "pending_confirmation") {
    return "pending_confirmation";
  }
  if (contract.status === "suspended") return "suspended";
  if (epoch(contract.startsAt) > epoch(now)) return "scheduled";
  return "active";
}

function capabilityReason(
  status: EffectiveServiceStatus,
  included: boolean,
): string | null {
  if (status === "unconfigured") return "当前账号的服务版本尚未配置。";
  if (status === "pending_confirmation") return "服务合同尚待确认。";
  if (status === "scheduled") return "服务将在约定日期自动生效。";
  if (status === "suspended") return "服务当前已暂停，请联系服务顾问。";
  if (status === "expired" || status === "cancelled") {
    return "当前服务已到期或取消，请续费后继续使用。";
  }
  return included ? null : "当前版本不包含此能力，可升级进阶版或豪华版解锁。";
}

function deriveCapabilities(
  status: EffectiveServiceStatus,
  planCode: ServicePlanCode | null,
): ServicePortal["capabilities"] {
  const output = {} as ServicePortal["capabilities"];
  const historyReadableCapabilities = new Set<ServiceCapabilityKey>([
    "knowledgeDisplay",
    "globalKeywords",
    "intentOptimization",
    "responseLogic",
    "monitoring",
    "channelDistribution",
    "progressReport",
    "brandTracking",
    "contentAssets",
  ]);
  for (const key of serviceCapabilityKeySchema.options) {
    const included = planCode
      ? SERVICE_PLAN_CATALOG[planCode].includedCapabilities[key]
      : false;
    const historicalRead =
      (status === "expired" || status === "cancelled") &&
      historyReadableCapabilities.has(key);
    const allowed = (status === "active" || historicalRead) && included;
    const effectiveStatus = allowed
      ? "available"
      : status === "active"
        ? included
          ? "available"
          : "not_in_plan"
        : status === "unconfigured"
          ? "service_unconfigured"
          : status === "pending_confirmation"
            ? "service_pending_confirmation"
            : status === "scheduled"
              ? "service_scheduled"
              : status === "suspended"
                ? "service_suspended"
                : status === "expired"
                  ? "service_expired"
                  : "service_cancelled";
    output[key] = {
      allowed,
      effectiveStatus,
      reason: allowed ? null : capabilityReason(status, included),
    };
  }
  return output;
}

function deriveWorkflowSteps(input: {
  status: EffectiveServiceStatus;
  planCode: ServicePlanCode | null;
  hasKnowledge: boolean;
  questionSelectionComplete: boolean;
  responseLogicStarted: boolean;
  responseLogicComplete: boolean;
  monitoringComplete: boolean;
  channelDistributionComplete: boolean;
  progressReportComplete: boolean;
  nextAction: ServicePortal["nextAction"];
}): ServicePortal["workflowSteps"] {
  const serviceBlock =
    input.status === "active"
      ? null
      : (capabilityReason(input.status, false) ?? "服务当前不可用。");
  const knowledgeReason = serviceBlock
    ? serviceBlock
    : input.planCode === "basic"
      ? "正在等待官网知识库迁移完成。"
      : null;
  const questionReason = serviceBlock
    ? serviceBlock
    : !input.hasKnowledge
      ? input.planCode === "basic"
        ? "请先等待官网知识库同步完成。"
        : "请先通过知识库智能体完成全部节点，并联系管理员开启品牌全域词库。"
      : input.planCode === "basic"
        ? "正在等待已购问题从官网同步。"
        : null;
  const responseReason = serviceBlock
    ? serviceBlock
    : !input.hasKnowledge
      ? input.planCode === "basic"
        ? "请先等待官网知识库同步完成。"
        : "请先通过知识库智能体完成全部节点并发布知识库。"
      : !input.questionSelectionComplete
        ? "请先完成当前服务周期的选题。"
        : null;
  const monitoringReason =
    responseReason ??
    (!input.responseLogicStarted
      ? "请先在应答逻辑智能体确认至少一个问题。"
      : null);
  const distributionReason =
    monitoringReason ??
    (!input.monitoringComplete ? "请等待真实问题监控数据写入。" : null);
  const reportReason = monitoringReason;
  const item = (
    id: ServicePortal["workflowSteps"][number]["id"],
    label: string,
    complete: boolean,
    reason: string | null,
    href: string | null,
  ): ServicePortal["workflowSteps"][number] => ({
    id,
    label,
    status: complete ? "complete" : reason ? "locked" : "ready",
    lockedReason: complete ? null : reason,
    href,
    // Every unfinished step points to the same server-derived earliest valid
    // action. This prevents a later locked page from suggesting a shortcut.
    nextAction: complete ? null : input.nextAction,
  });
  return [
    item(
      "knowledge",
      input.planCode === "basic" ? "知识库展示" : "知识库智能体",
      input.hasKnowledge,
      input.hasKnowledge ? null : knowledgeReason,
      "/knowledge-base",
    ),
    item(
      "question",
      input.planCode === "basic" ? "已购问题" : "品牌全域词库与选题",
      input.questionSelectionComplete,
      input.questionSelectionComplete ? null : questionReason,
      "/brand-question-portfolio",
    ),
    item(
      "response_logic",
      "应答逻辑",
      input.responseLogicComplete,
      input.responseLogicComplete ? null : responseReason,
      "/response-logic",
    ),
    item(
      "monitoring",
      "问题监控",
      input.monitoringComplete,
      input.monitoringComplete ? null : monitoringReason,
      "/question-monitoring",
    ),
    item(
      "channel_distribution",
      "渠道分发",
      input.channelDistributionComplete,
      input.channelDistributionComplete ? null : distributionReason,
      "/channel-distribution",
    ),
    item(
      "progress_report",
      "进度报告",
      input.progressReportComplete,
      input.progressReportComplete ? null : reportReason,
      "/progress-report",
    ),
  ];
}

function deriveNextAction(input: {
  status: EffectiveServiceStatus;
  planCode: ServicePlanCode | null;
  hasKnowledge: boolean;
  hasActiveKnowledgeBuild: boolean;
  currentPeriodCandidateCount: number;
  currentPeriodPendingApprovalCount: number;
  questionSelectionComplete: boolean;
  responseLogicComplete: boolean;
  monitoringComplete: boolean;
  channelDistributionComplete: boolean;
  progressReportComplete: boolean;
}): ServicePortal["nextAction"] {
  if (input.status === "unconfigured") {
    return {
      kind: "await_service_configuration",
      label: "等待管理员配置服务版本",
      href: null,
    };
  }
  if (input.status === "pending_confirmation") {
    return {
      kind: "await_service_confirmation",
      label: "确认服务合同",
      href: null,
    };
  }
  if (input.status === "scheduled") {
    return {
      kind: "await_service_start",
      label: "等待服务生效",
      href: null,
    };
  }
  if (input.status === "suspended") {
    return {
      kind: "contact_service_support",
      label: "联系服务顾问",
      href: null,
    };
  }
  if (input.status === "expired" || input.status === "cancelled") {
    return { kind: "renew_service", label: "续费或升级服务", href: null };
  }
  if (!input.hasKnowledge && input.planCode === "basic") {
    return {
      kind: "await_knowledge_import",
      label: "等待知识库迁移",
      href: null,
    };
  }
  if (!input.hasKnowledge && input.hasActiveKnowledgeBuild) {
    return {
      kind: "resume_knowledge_build",
      label: "继续知识库智能体",
      href: "/knowledge-base",
    };
  }
  if (!input.hasKnowledge) {
    return {
      kind: "start_knowledge_build",
      label: "开始知识库智能体",
      href: "/knowledge-base",
    };
  }
  if (!input.questionSelectionComplete) {
    if (input.planCode === "basic") {
      return {
        kind: "await_question_import",
        label: "等待已购问题同步",
        href: null,
      };
    }
    if (input.currentPeriodPendingApprovalCount > 0) {
      return {
        kind: "await_question_confirmation",
        label: "等待监控工程师确认启动问题",
        href: "/brand-question-portfolio",
      };
    }
    if (input.currentPeriodCandidateCount > 0) {
      return {
        kind: "select_service_questions",
        label: "选择本周期服务问题",
        href: "/brand-question-portfolio",
      };
    }
    return {
      kind: "await_question_catalog",
      label: "查看品牌词库配置进度",
      href: "/brand-question-portfolio",
    };
  }
  if (!input.responseLogicComplete) {
    return {
      kind: "build_response_logic",
      label: "逐题确认应答逻辑",
      href: "/response-logic",
    };
  }
  if (!input.monitoringComplete) {
    return {
      kind: "await_monitoring_data",
      label: "等待问题监控数据",
      href: "/question-monitoring",
    };
  }
  if (!input.channelDistributionComplete) {
    return {
      kind: "await_channel_distribution",
      label: "等待渠道引用数据",
      href: "/channel-distribution",
    };
  }
  if (!input.progressReportComplete) {
    return {
      kind: "await_progress_report",
      label: "等待进度报告发布",
      href: "/progress-report",
    };
  }
  return {
    kind: "view_progress_report",
    label: "查看最新进度报告",
    href: "/progress-report",
  };
}

function everyQuestionHasOutput(
  questions: ServicePortalQuestion[],
  outputQuestionIds: string[] | undefined,
) {
  if (questions.length === 0) return false;
  const ids = new Set(outputQuestionIds ?? []);
  // Output tables are normalized to the authoritative workspace-question id.
  // External/source ids identify provenance only and must not carry old
  // response logic or monitoring results into a replacement question.
  return questions.every((question) => ids.has(question.id));
}

export function everyActiveQuotaPeriodHasProgressReport(
  activePeriodIds: string[],
  reportPeriodIds: Array<string | null>,
) {
  if (activePeriodIds.length === 0) return false;
  const published = new Set(
    reportPeriodIds.filter((value): value is string => Boolean(value)),
  );
  return activePeriodIds.every((periodId) => published.has(periodId));
}

export function deriveServicePortalState(
  input: ServicePortalStateInput,
): ServicePortal {
  const now = input.now ?? new Date();
  const contracts = input.contracts ?? (input.contract ? [input.contract] : []);
  const contract = input.contract ?? selectPortalContract(contracts, now);
  const planCode = contract?.planCode ?? null;
  const plan = planCode ? SERVICE_PLAN_CATALOG[planCode] : null;
  const status = deriveEffectiveServiceStatus(contract, now);
  const entitlementRollout = input.entitlementRollout ?? {
    mode: "enforced" as const,
    pendingUserCount: 0,
  };
  const confirmedResponseLogicQuestionIds = new Set(
    input.confirmedResponseLogicQuestionIds ?? [],
  );
  const selectedQuestions = (input.selectedQuestions ?? []).map((question) =>
    publicSelectedQuestion(question, confirmedResponseLogicQuestionIds),
  );
  const selectedQuestionIds = new Set(
    selectedQuestions.map((question) => question.id),
  );
  const historicalQuestions = (input.historicalQuestions ?? [])
    .map((question) => publicSelectedQuestion(question))
    .filter((question) => !selectedQuestionIds.has(question.id));
  const periods =
    input.quotaPeriods ?? (input.quotaPeriod ? [input.quotaPeriod] : []);
  const period =
    input.quotaPeriod ??
    periods.find((value) => value.contractId === contract?.id) ??
    periods[0] ??
    null;
  const quotaDtos = periods.map((value) => {
    const quotaContract =
      contracts.find((candidate) => candidate.id === value.contractId) ??
      contract;
    const metadata = quotaContract
      ? resolveServiceQuestionQuotaUnlockMetadata({
          contract: quotaContract,
          period: value,
          now,
        })
      : {
          entitlementLimits: persistedServiceQuestionQuotaLimits(value),
          unlockedLimits: persistedServiceQuestionQuotaLimits(value),
          unlockStage: { current: 1, total: 1 },
          nextUnlockAt: null,
        };
    const limits = quotaContract
      ? resolveEffectiveServiceQuestionQuotaLimits({
          contract: quotaContract,
          period: value,
          now,
        })
      : persistedServiceQuestionQuotaLimits(value);
    const scope = quotaContract
      ? resolveServiceQuestionQuotaScope(quotaContract, value)
      : ({ kind: "period", periodId: value.id } as const);
    const usage = countSelectedQuestionUsage(input.selectedQuestions, scope);
    const remaining = remainingQuota(limits, usage);
    return {
      periodId: value.id,
      contractId: value.contractId,
      validFrom: epoch(value.startsAt),
      validUntil: epoch(value.endsAt),
      revision: Math.max(1, value.revision),
      limits,
      entitlementLimits: metadata.entitlementLimits,
      unlockStage: metadata.unlockStage,
      nextUnlockAt: metadata.nextUnlockAt,
      capacityState: resolveServiceQuestionQuotaCapacityState({
        remaining,
        nextUnlockAt: metadata.nextUnlockAt,
      }),
      usage,
      remaining,
    };
  });
  let quota = period
    ? (quotaDtos.find((value) => value.periodId === period.id) ?? null)
    : null;
  const hasDisplayKnowledge = Number.isInteger(input.knowledgeVersion);
  const authenticatedKnowledgeVersion =
    input.authenticatedKnowledgeVersion ?? null;
  const hasKnowledge =
    planCode === "basic"
      ? hasDisplayKnowledge
      : Number.isInteger(authenticatedKnowledgeVersion);
  const capabilities = deriveCapabilities(status, planCode);
  if (
    status === "active" &&
    capabilities.contentAssets.allowed &&
    !hasKnowledge
  ) {
    capabilities.contentAssets = {
      allowed: false,
      effectiveStatus: "workflow_prerequisite",
      reason:
        planCode === "basic"
          ? "请先等待 Website 流程自动同步或服务团队补录知识库；知识库展示完成后解锁 AI 友好内容资产。"
          : "请先在知识库智能体中完成全部节点并发布当前服务的认证知识库；知识库展示完成后解锁 AI 友好内容资产。",
    };
  }
  const effectivelyReplacedContractIds = new Set(
    contracts.flatMap((value) =>
      deriveEffectiveServiceStatus(value, now) === "active"
        ? (value.replacesContractIds ?? [])
        : [],
    ),
  );
  const activeBasicContracts =
    planCode === "basic" && status === "active"
      ? contracts.filter(
          (value) =>
            value.planCode === "basic" &&
            deriveEffectiveServiceStatus(value, now) === "active",
        )
      : [];
  const serviceContractsForValidity = activeBasicContracts.length
    ? activeBasicContracts
    : contract
      ? [contract]
      : [];
  if (planCode === "basic" && quotaDtos.length > 1 && contract) {
    quota = {
      periodId: `basic-aggregate:${contract.id}`,
      contractId: contract.id,
      validFrom: Math.min(...quotaDtos.map((value) => value.validFrom)),
      validUntil: Math.max(...quotaDtos.map((value) => value.validUntil)),
      revision: Math.max(...quotaDtos.map((value) => value.revision)),
      limits: quotaDtos.reduce<ServiceQuotaLimits>(
        (sum, value) => ({
          industryLimit: sum.industryLimit + value.limits.industryLimit,
          competitorComparisonLimit:
            sum.competitorComparisonLimit +
            value.limits.competitorComparisonLimit,
          reputationLimit: sum.reputationLimit + value.limits.reputationLimit,
          productScenarioLimit:
            sum.productScenarioLimit + value.limits.productScenarioLimit,
          totalQuestionLimit:
            sum.totalQuestionLimit + value.limits.totalQuestionLimit,
        }),
        {
          industryLimit: 0,
          competitorComparisonLimit: 0,
          reputationLimit: 0,
          productScenarioLimit: 0,
          totalQuestionLimit: 0,
        },
      ),
      entitlementLimits: quotaDtos.reduce<ServiceQuotaLimits>(
        (sum, value) => ({
          industryLimit:
            sum.industryLimit + value.entitlementLimits.industryLimit,
          competitorComparisonLimit:
            sum.competitorComparisonLimit +
            value.entitlementLimits.competitorComparisonLimit,
          reputationLimit:
            sum.reputationLimit + value.entitlementLimits.reputationLimit,
          productScenarioLimit:
            sum.productScenarioLimit +
            value.entitlementLimits.productScenarioLimit,
          totalQuestionLimit:
            sum.totalQuestionLimit + value.entitlementLimits.totalQuestionLimit,
        }),
        {
          industryLimit: 0,
          competitorComparisonLimit: 0,
          reputationLimit: 0,
          productScenarioLimit: 0,
          totalQuestionLimit: 0,
        },
      ),
      unlockStage: { current: 1, total: 1 },
      nextUnlockAt: null,
      capacityState: "available" as const,
      usage: quotaDtos.reduce<ServiceQuotaUsage>(
        (sum, value) => ({
          industry: sum.industry + value.usage.industry,
          competitorComparison:
            sum.competitorComparison + value.usage.competitorComparison,
          reputation: sum.reputation + value.usage.reputation,
          productScenario: sum.productScenario + value.usage.productScenario,
          total: sum.total + value.usage.total,
        }),
        { ...EMPTY_SERVICE_QUOTA_USAGE },
      ),
      remaining: quotaDtos.reduce<ServiceQuotaUsage>(
        (sum, value) => ({
          industry: sum.industry + value.remaining.industry,
          competitorComparison:
            sum.competitorComparison + value.remaining.competitorComparison,
          reputation: sum.reputation + value.remaining.reputation,
          productScenario:
            sum.productScenario + value.remaining.productScenario,
          total: sum.total + value.remaining.total,
        }),
        { ...EMPTY_SERVICE_QUOTA_USAGE },
      ),
    };
    quota.capacityState = resolveServiceQuestionQuotaCapacityState({
      remaining: quota.remaining,
      nextUnlockAt: null,
    });
  }
  // Each approved question can enter optimization immediately. Filling every
  // purchased slot remains possible throughout the period, but it must not
  // block work already approved by an administrator.
  const questionSelectionComplete = selectedQuestions.length > 0;
  const responseLogicStarted = selectedQuestions.some(
    (question) => question.responseLogicConfirmed,
  );
  const responseLogicComplete =
    questionSelectionComplete &&
    everyQuestionHasOutput(
      selectedQuestions,
      input.confirmedResponseLogicQuestionIds,
    );
  const monitoringComplete =
    responseLogicComplete &&
    everyQuestionHasOutput(selectedQuestions, input.monitoringQuestionIds);
  const channelDistributionComplete =
    monitoringComplete &&
    everyQuestionHasOutput(
      selectedQuestions,
      input.channelDistributionQuestionIds,
    );
  const progressReportComplete =
    responseLogicStarted && Boolean(input.hasProgressReport);
  const nextAction = deriveNextAction({
    status,
    planCode,
    hasKnowledge,
    hasActiveKnowledgeBuild: input.hasActiveKnowledgeBuild ?? false,
    currentPeriodCandidateCount: input.currentPeriodCandidateCount ?? 0,
    currentPeriodPendingApprovalCount:
      input.currentPeriodPendingApprovalCount ?? 0,
    questionSelectionComplete,
    responseLogicComplete,
    monitoringComplete,
    channelDistributionComplete,
    progressReportComplete,
  });
  const workflowSteps = deriveWorkflowSteps({
    status,
    planCode,
    hasKnowledge,
    questionSelectionComplete,
    responseLogicStarted,
    responseLogicComplete,
    monitoringComplete,
    channelDistributionComplete,
    progressReportComplete,
    nextAction,
  });

  const portal: ServicePortal = {
    schemaVersion: 1,
    revision: contracts.reduce(
      (maximum, value) => Math.max(maximum, value.revision),
      contract?.revision ?? 0,
    ),
    entitlementRollout,
    account: input.account ?? null,
    service: {
      contractId: contract?.id ?? null,
      planCode,
      planVersion: contract?.planVersion ?? null,
      planName: plan?.name ?? "待配置",
      status,
      validFrom: serviceContractsForValidity.length
        ? Math.min(
            ...serviceContractsForValidity.map((value) =>
              epoch(value.startsAt),
            ),
          )
        : null,
      validUntil: serviceContractsForValidity.length
        ? Math.max(
            ...serviceContractsForValidity.map((value) => epoch(value.endsAt)),
          )
        : null,
      billingLabel: plan?.billingLabel ?? "服务版本待配置",
      source: contract?.source ?? null,
    },
    quotas: quota,
    quotaPeriods: quotaDtos,
    purchases: [...contracts]
      .sort((left, right) => right.revision - left.revision)
      .map((purchase) => ({
        id: purchase.id,
        planCode: purchase.planCode,
        planName: SERVICE_PLAN_CATALOG[purchase.planCode].name,
        purchasedAt: epoch(purchase.createdAt),
        validFrom: epoch(purchase.startsAt),
        validUntil: epoch(purchase.endsAt),
        status: contractPurchaseStatus(
          purchase,
          now,
          effectivelyReplacedContractIds,
        ),
        amountFen: purchase.amountFen ?? null,
        currency: purchase.currency ?? "CNY",
        prepaidMonths:
          purchase.prepaidMonths ??
          SERVICE_PLAN_CATALOG[purchase.planCode].prepaidMonths,
        orderReference: purchase.orderReference ?? null,
        contractReference: purchase.externalContractReference ?? null,
        signedAt: purchase.signedAt ? epoch(purchase.signedAt) : null,
        signatoryId: purchase.signatoryId ?? null,
        hasSigningEvidence: Boolean(purchase.signingEvidence),
        revision: Math.max(1, purchase.revision),
      })),
    knowledge: {
      version: input.knowledgeVersion ?? null,
      authenticatedVersion: authenticatedKnowledgeVersion,
      authenticatedForCurrentService: Number.isInteger(
        authenticatedKnowledgeVersion,
      ),
      status: hasDisplayKnowledge
        ? "display_ready"
        : input.latestImportStatus === "pending" ||
            input.latestImportStatus === "processing"
          ? "importing"
          : input.latestImportStatus === "failed"
            ? "failed"
            : "missing",
      latestImportStatus: input.latestImportStatus ?? null,
    },
    purchasedQuestions: selectedQuestions,
    historicalQuestions,
    capabilities,
    workflowSteps,
    nextAction,
  };
  return portal;
}

export function isMissingServicePortalTableError(error: unknown): boolean {
  let cursor: unknown = error;
  for (let depth = 0; depth < 5 && cursor; depth += 1) {
    if (typeof cursor !== "object") break;
    const value = cursor as {
      code?: unknown;
      errno?: unknown;
      message?: unknown;
      cause?: unknown;
    };
    if (
      value.code === "ER_NO_SUCH_TABLE" ||
      value.errno === 1146 ||
      (typeof value.message === "string" &&
        /(?:doesn't exist|no such table)/i.test(value.message))
    ) {
      return true;
    }
    cursor = value.cause;
  }
  return false;
}

export function resolveServiceEntitlementRolloutState(input: {
  configuredMode?: string | null;
  pendingUserCount: number;
}): ServiceEntitlementRolloutState {
  const configuredMode = String(input.configuredMode ?? "auto")
    .trim()
    .toLowerCase();
  if (
    configuredMode === "enforced" ||
    configuredMode === "force" ||
    configuredMode === "true" ||
    configuredMode === "1"
  ) {
    return { mode: "enforced", pendingUserCount: input.pendingUserCount };
  }
  if (
    configuredMode === "compatibility" ||
    configuredMode === "legacy" ||
    configuredMode === "false" ||
    configuredMode === "0"
  ) {
    return {
      mode: "compatibility",
      pendingUserCount: input.pendingUserCount,
    };
  }
  // The default rollout cannot enforce commercial entitlements until the
  // system-admin migration queue is empty.
  return {
    mode: input.pendingUserCount === 0 ? "enforced" : "compatibility",
    pendingUserCount: input.pendingUserCount,
  };
}

async function loadServiceEntitlementRolloutState(
  db: NonNullable<Awaited<ReturnType<typeof getDb>>>,
) {
  const [userRows, contractOwnerRows] = await Promise.all([
    db
      .select({ userId: users.id })
      .from(users)
      .where(and(eq(users.role, "user"), eq(users.isActive, true))),
    db.select({ userId: serviceContracts.userId }).from(serviceContracts),
  ]);
  const configuredUserIds = new Set(contractOwnerRows.map((row) => row.userId));
  const pendingUserCount = userRows.filter(
    (row) => !configuredUserIds.has(row.userId),
  ).length;
  return resolveServiceEntitlementRolloutState({
    configuredMode:
      process.env.FRONTMIND_SERVICE_ENTITLEMENT_ENFORCEMENT ?? "auto",
    pendingUserCount,
  });
}

export async function getServiceEntitlementRolloutState() {
  const db = await getDb();
  if (!db) {
    return {
      mode: "compatibility",
      pendingUserCount: 1,
    } satisfies ServiceEntitlementRolloutState;
  }
  return loadServiceEntitlementRolloutState(db);
}

async function loadPortalStateFromDatabase(
  userId: number,
  now: Date,
): Promise<ServicePortalStateInput> {
  const db = await getDb();
  if (!db) return { userId, now, account: null };

  const accounts = await db
    .select({
      userId: users.id,
      username: users.username,
      displayName: users.displayName,
    })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);
  const base: ServicePortalStateInput = {
    userId,
    now,
    account: accounts[0] ?? null,
    entitlementRollout: {
      mode: "compatibility",
      pendingUserCount: 1,
    },
  };
  try {
    const [contractRows, entitlementRollout] = await Promise.all([
      db
        .select()
        .from(serviceContracts)
        .where(eq(serviceContracts.userId, userId))
        .orderBy(desc(serviceContracts.revision)),
      loadServiceEntitlementRolloutState(db),
    ]);
    base.entitlementRollout = entitlementRollout;
    const currentSelection = selectCurrentServiceContractIds(
      contractRows as ServicePortalContractRecord[],
      now,
    );
    const contract = currentSelection.contract;
    if (!contract) return base;
    const currentContractIds = currentSelection.contractIds;
    const progressiveQuestionScope = isProgressiveLuxuryContract(contract);

    const queriedPeriodRows = await db
      .select()
      .from(serviceQuotaPeriods)
      .where(
        and(
          inArray(serviceQuotaPeriods.contractId, currentContractIds),
          gt(
            serviceQuotaPeriods.ordinal,
            SERVICE_QUESTION_QUOTA_ANCHOR_ORDINAL,
          ),
          lte(serviceQuotaPeriods.startsAt, now),
          gt(serviceQuotaPeriods.endsAt, now),
        ),
      )
      .orderBy(
        asc(serviceQuotaPeriods.startsAt),
        asc(serviceQuotaPeriods.ordinal),
      );
    const periodRows = queriedPeriodRows.filter(
      isOperationalServiceQuotaPeriod,
    );
    const activePeriodIds = periodRows.map((period) => period.id);
    const [
      allQuestionRows,
      candidateRows,
      snapshotRows,
      authenticatedSnapshot,
      buildRows,
      receiptRows,
      responseRows,
      monitoringRows,
      citationRows,
      progressReportRows,
      dashboardRows,
    ] = await Promise.all([
      db
        .select()
        .from(workspaceQuestions)
        .where(
          and(
            eq(workspaceQuestions.userId, userId),
            or(
              eq(workspaceQuestions.status, "selected"),
              and(
                eq(workspaceQuestions.status, "archived"),
                eq(workspaceQuestions.selectionApprovalStatus, "approved"),
              ),
            ),
          ),
        )
        .orderBy(
          desc(workspaceQuestions.selectedAt),
          asc(workspaceQuestions.ordinal),
        ),
      db
        .select({
          id: workspaceQuestions.id,
          selectionApprovalStatus: workspaceQuestions.selectionApprovalStatus,
        })
        .from(workspaceQuestions)
        .where(
          and(
            eq(workspaceQuestions.userId, userId),
            inArray(workspaceQuestions.contractId, currentContractIds),
            ...(progressiveQuestionScope
              ? [
                  activePeriodIds.length
                    ? or(
                        eq(workspaceQuestions.contractId, contract.id),
                        inArray(
                          workspaceQuestions.quotaPeriodId,
                          activePeriodIds,
                        ),
                      )
                    : eq(workspaceQuestions.contractId, contract.id),
                ]
              : activePeriodIds.length
                ? [inArray(workspaceQuestions.quotaPeriodId, activePeriodIds)]
                : []),
            eq(workspaceQuestions.status, "candidate"),
          ),
        ),
      db
        .select({ version: knowledgeBaseSnapshots.version })
        .from(knowledgeBaseSnapshots)
        .where(
          and(
            eq(knowledgeBaseSnapshots.userId, userId),
            eq(knowledgeBaseSnapshots.status, "active"),
          ),
        )
        .orderBy(desc(knowledgeBaseSnapshots.version))
        .limit(1),
      getLatestAuthenticatedKnowledgeSnapshot({
        userId,
        notBefore: asDate(contract.startsAt),
      }),
      db
        .select({ status: knowledgeBaseBuilds.status })
        .from(knowledgeBaseBuilds)
        .where(
          and(
            eq(knowledgeBaseBuilds.userId, userId),
            inArray(knowledgeBaseBuilds.status, ACTIVE_BUILD_STATUSES),
          ),
        )
        .orderBy(desc(knowledgeBaseBuilds.updatedAt))
        .limit(1),
      db
        .select({ status: knowledgeImportReceipts.status })
        .from(knowledgeImportReceipts)
        .where(eq(knowledgeImportReceipts.userId, userId))
        .orderBy(desc(knowledgeImportReceipts.createdAt))
        .limit(1),
      db
        .select({ questionId: responseLogicEntries.questionId })
        .from(responseLogicEntries)
        .where(
          and(
            eq(responseLogicEntries.userId, userId),
            eq(responseLogicEntries.status, "confirmed"),
          ),
        ),
      activePeriodIds.length
        ? db
            .select({ questionId: monitoringSamples.questionId })
            .from(monitoringSamples)
            .innerJoin(
              monitoringBatches,
              and(
                eq(monitoringBatches.id, monitoringSamples.batchId),
                eq(monitoringBatches.userId, userId),
                inArray(monitoringBatches.quotaPeriodId, activePeriodIds),
              ),
            )
            .where(eq(monitoringSamples.userId, userId))
        : Promise.resolve([]),
      activePeriodIds.length
        ? db
            .select({ questionId: monitoringCitationRecords.questionId })
            .from(monitoringCitationRecords)
            .innerJoin(
              monitoringBatches,
              and(
                eq(monitoringBatches.id, monitoringCitationRecords.batchId),
                eq(monitoringBatches.userId, userId),
                inArray(monitoringBatches.quotaPeriodId, activePeriodIds),
              ),
            )
            .where(eq(monitoringCitationRecords.userId, userId))
        : Promise.resolve([]),
      activePeriodIds.length
        ? db
            .select({ quotaPeriodId: serviceProgressReports.quotaPeriodId })
            .from(serviceProgressReports)
            .where(
              and(
                eq(serviceProgressReports.userId, userId),
                inArray(serviceProgressReports.quotaPeriodId, activePeriodIds),
              ),
            )
        : Promise.resolve([]),
      db
        .select({ payload: userDashboardContents.payload })
        .from(userDashboardContents)
        .where(eq(userDashboardContents.userId, userId))
        .limit(1),
    ]);
    const questionCollections = partitionSelectedQuestionsForPortal({
      questions: allQuestionRows,
      currentContractIds,
      activePeriodIds,
      effectiveStatus: deriveEffectiveServiceStatus(
        contract as ServicePortalContractRecord,
        now,
      ),
      contract,
    });
    const questionRows = questionCollections.current;
    const dashboardPayload = dashboardPayloadSchema.safeParse(
      dashboardRows[0]?.payload,
    );

    return {
      ...base,
      contract: contract as ServicePortalContractRecord,
      contracts: contractRows as ServicePortalContractRecord[],
      quotaPeriod:
        (periodRows.find((value) => value.contractId === contract.id) as
          | ServicePortalQuotaPeriodRecord
          | undefined) ??
        (periodRows[0] as ServicePortalQuotaPeriodRecord | undefined) ??
        null,
      quotaPeriods: periodRows as ServicePortalQuotaPeriodRecord[],
      selectedQuestions: questionRows,
      historicalQuestions: questionCollections.historical,
      knowledgeVersion: snapshotRows[0]?.version ?? null,
      authenticatedKnowledgeVersion: authenticatedSnapshot?.version ?? null,
      hasActiveKnowledgeBuild: Boolean(buildRows[0]),
      latestImportStatus: receiptRows[0]?.status ?? null,
      currentPeriodCandidateCount: candidateRows.length,
      currentPeriodPendingApprovalCount: candidateRows.filter(
        (row) => row.selectionApprovalStatus === "pending",
      ).length,
      confirmedResponseLogicQuestionIds: responseRows.map(
        (row) => row.questionId,
      ),
      monitoringQuestionIds: monitoringRows.map((row) => row.questionId),
      channelDistributionQuestionIds: citationRows.map((row) => row.questionId),
      hasProgressReport: everyActiveQuotaPeriodHasProgressReport(
        activePeriodIds,
        progressReportRows.map((report) => report.quotaPeriodId),
      ),
    };
  } catch (error) {
    if (isMissingServicePortalTableError(error)) return base;
    throw error;
  }
}

const DATABASE_REPOSITORY: ServiceEntitlementRepository = {
  loadPortalState: loadPortalStateFromDatabase,
};

export type ServiceContractLifecycleReconciliationResult = {
  scannedContractCount: number;
  reconciledContractCount: number;
  supersededSourceContractCount: number;
  archivedPendingQuestionCount: number;
  cancelledQuestionWorkflowTicketCount: number;
};

const EMPTY_SERVICE_CONTRACT_LIFECYCLE_RESULT =
  (): ServiceContractLifecycleReconciliationResult => ({
    scannedContractCount: 0,
    reconciledContractCount: 0,
    supersededSourceContractCount: 0,
    archivedPendingQuestionCount: 0,
    cancelledQuestionWorkflowTicketCount: 0,
  });

function addServiceContractLifecycleResult(
  target: ServiceContractLifecycleReconciliationResult,
  value: ServiceContractLifecycleReconciliationResult,
) {
  target.scannedContractCount += value.scannedContractCount;
  target.reconciledContractCount += value.reconciledContractCount;
  target.supersededSourceContractCount += value.supersededSourceContractCount;
  target.archivedPendingQuestionCount += value.archivedPendingQuestionCount;
  target.cancelledQuestionWorkflowTicketCount +=
    value.cancelledQuestionWorkflowTicketCount;
}

/**
 * Activates one due annual Luxury v2 renewal and terminates only source-year
 * work that cannot legally cross the annual cohort boundary. The user row and
 * target contract serialize duplicate workers. Ticket/question locks skip an
 * already-running terminal decision; a later sweep then observes its terminal
 * result. Every write predicate is terminal-state aware, so reruns are no-ops.
 */
export async function reconcileActivatedProgressiveLuxuryRenewal(input: {
  executor: any;
  userId: number;
  targetContractId: string;
  now?: Date;
}): Promise<ServiceContractLifecycleReconciliationResult> {
  const result = EMPTY_SERVICE_CONTRACT_LIFECYCLE_RESULT();
  result.scannedContractCount = 1;
  const now = input.now ?? new Date();
  const ownerRows = await input.executor
    .select({ id: users.id })
    .from(users)
    .where(eq(users.id, input.userId))
    .limit(1)
    .for("update");
  if (!ownerRows[0]) return result;

  const targetRows = await input.executor
    .select()
    .from(serviceContracts)
    .where(
      and(
        eq(serviceContracts.id, input.targetContractId),
        eq(serviceContracts.userId, input.userId),
      ),
    )
    .limit(1)
    .for("update");
  const target = targetRows[0] as ServicePortalContractRecord | undefined;
  if (
    !target ||
    !isProgressiveLuxuryContract(target) ||
    !(["active", "scheduled"] as PersistedServiceContractStatus[]).includes(
      target.status,
    ) ||
    epoch(target.startsAt) > now.getTime() ||
    !(target.replacesContractIds ?? []).length
  ) {
    return result;
  }

  const sourceRows = (await input.executor
    .select()
    .from(serviceContracts)
    .where(
      and(
        eq(serviceContracts.userId, input.userId),
        inArray(serviceContracts.id, target.replacesContractIds ?? []),
      ),
    )) as ServicePortalContractRecord[];
  const renewalSources = sourceRows.filter(
    (source) =>
      source.planCode === "luxury" &&
      epoch(target.startsAt) >= epoch(source.endsAt),
  );
  if (!renewalSources.length) return result;
  const renewalSourceIds = renewalSources.map((source) => source.id);

  const terminatedQuestionWork = await terminateContractQuestionWork({
    executor: input.executor,
    userId: input.userId,
    contractIds: renewalSourceIds,
    now,
    message:
      "原豪华版年度服务已结束，本需求随年度续费自动关闭；如仍需处理，请在新合同中重新提交。",
    lockMode: "skip_locked",
  });
  result.archivedPendingQuestionCount =
    terminatedQuestionWork.archivedPendingQuestionCount;
  result.cancelledQuestionWorkflowTicketCount =
    terminatedQuestionWork.cancelledQuestionWorkflowTicketCount;

  const sourceContractsToSupersede = renewalSources.filter((source) =>
    (
      [
        "pending_confirmation",
        "scheduled",
        "active",
        "suspended",
      ] as PersistedServiceContractStatus[]
    ).includes(source.status),
  );
  if (sourceContractsToSupersede.length) {
    await input.executor
      .update(serviceContracts)
      .set({ status: "superseded", updatedAt: now })
      .where(
        and(
          eq(serviceContracts.userId, input.userId),
          inArray(
            serviceContracts.id,
            sourceContractsToSupersede.map((source) => source.id),
          ),
          inArray(serviceContracts.status, [
            "pending_confirmation",
            "scheduled",
            "active",
            "suspended",
          ] as const),
        ),
      );
    result.supersededSourceContractCount = sourceContractsToSupersede.length;
  }
  if (target.status === "scheduled") {
    await input.executor
      .update(serviceContracts)
      .set({ status: "active", updatedAt: now })
      .where(
        and(
          eq(serviceContracts.id, target.id),
          eq(serviceContracts.status, "scheduled"),
        ),
      );
  }
  result.reconciledContractCount =
    result.supersededSourceContractCount ||
    result.archivedPendingQuestionCount ||
    result.cancelledQuestionWorkflowTicketCount ||
    target.status === "scheduled"
      ? 1
      : 0;
  return result;
}

export function selectDueProgressiveLuxuryRenewalCandidates<
  Candidate extends {
    id: string;
    userId: number;
    startsAt: DateValue;
    replacesContractIds: string[];
  },
>(input: {
  candidates: Candidate[];
  sources: Array<{
    id: string;
    userId: number;
    planCode: ServicePlanCode;
    status: PersistedServiceContractStatus;
    endsAt: DateValue;
  }>;
  sourceContractIdsWithOutstandingQuestionWork?: ReadonlySet<string>;
}) {
  const sourceByUserAndId = new Map(
    input.sources.map((source) => [`${source.userId}:${source.id}`, source]),
  );
  const outstanding =
    input.sourceContractIdsWithOutstandingQuestionWork ?? new Set<string>();
  return input.candidates.filter((candidate) =>
    candidate.replacesContractIds.some((sourceId) => {
      const source = sourceByUserAndId.get(`${candidate.userId}:${sourceId}`);
      return (
        source?.planCode === "luxury" &&
        epoch(candidate.startsAt) >= epoch(source.endsAt) &&
        (!(
          ["superseded", "cancelled"] as PersistedServiceContractStatus[]
        ).includes(source.status) ||
          outstanding.has(source.id))
      );
    }),
  );
}

/** Bounded by the small immutable contract ledger; each due candidate is
 * filtered read-only, then fenced again in its own mutation transaction. */
export async function reconcileActivatedProgressiveLuxuryRenewals(
  input: {
    now?: Date;
    userId?: number;
    database?: NonNullable<Awaited<ReturnType<typeof getDb>>>;
  } = {},
): Promise<ServiceContractLifecycleReconciliationResult> {
  const db = input.database ?? (await getDb());
  if (!db) return EMPTY_SERVICE_CONTRACT_LIFECYCLE_RESULT();
  const now = input.now ?? new Date();
  const candidates = await db
    .select({
      id: serviceContracts.id,
      userId: serviceContracts.userId,
      startsAt: serviceContracts.startsAt,
      replacesContractIds: serviceContracts.replacesContractIds,
    })
    .from(serviceContracts)
    .where(
      and(
        eq(serviceContracts.planCode, "luxury"),
        sql`${serviceContracts.planVersion} >= ${PROGRESSIVE_LUXURY_PLAN_VERSION}`,
        inArray(serviceContracts.status, ["active", "scheduled"]),
        lte(serviceContracts.startsAt, now),
        ...(input.userId === undefined
          ? []
          : [eq(serviceContracts.userId, input.userId)]),
      ),
    )
    .orderBy(asc(serviceContracts.startsAt));
  await reconcileProgressiveLuxuryCompatibilityAnchors({
    executor: db,
    contractIds: candidates.map((candidate) => candidate.id),
    now,
  });
  const replacedContractIds = [
    ...new Set(
      candidates.flatMap((candidate) => candidate.replacesContractIds),
    ),
  ];
  if (!replacedContractIds.length) {
    return EMPTY_SERVICE_CONTRACT_LIFECYCLE_RESULT();
  }
  const sourceRows = await db
    .select({
      id: serviceContracts.id,
      userId: serviceContracts.userId,
      planCode: serviceContracts.planCode,
      status: serviceContracts.status,
      endsAt: serviceContracts.endsAt,
    })
    .from(serviceContracts)
    .where(inArray(serviceContracts.id, replacedContractIds));
  const [activeQuestionWorkflowRows, pendingQuestionRows] = await Promise.all([
    db
      .select({ contractId: deliveryTickets.contractId })
      .from(deliveryTickets)
      .where(
        and(
          inArray(deliveryTickets.contractId, replacedContractIds),
          questionWorkflowTicketCondition(),
          inArray(
            deliveryTickets.status,
            ACTIVE_QUESTION_WORKFLOW_TICKET_STATUSES,
          ),
        ),
      ),
    db
      .select({ contractId: workspaceQuestions.contractId })
      .from(workspaceQuestions)
      .where(
        and(
          inArray(workspaceQuestions.contractId, replacedContractIds),
          inArray(workspaceQuestions.status, ["candidate", "selected"]),
          eq(workspaceQuestions.selectionApprovalStatus, "pending"),
        ),
      ),
  ]);
  const sourceContractIdsWithOutstandingQuestionWork = new Set([
    ...activeQuestionWorkflowRows.map((row) => row.contractId),
    ...pendingQuestionRows.map((row) => row.contractId),
  ]);
  const dueAnnualRenewals = selectDueProgressiveLuxuryRenewalCandidates({
    candidates,
    sources: sourceRows,
    sourceContractIdsWithOutstandingQuestionWork,
  });
  const result = EMPTY_SERVICE_CONTRACT_LIFECYCLE_RESULT();
  for (const candidate of dueAnnualRenewals) {
    const value = await db.transaction((tx) =>
      reconcileActivatedProgressiveLuxuryRenewal({
        executor: tx,
        userId: candidate.userId,
        targetContractId: candidate.id,
        now,
      }),
    );
    addServiceContractLifecycleResult(result, value);
  }
  return result;
}

export function startServiceContractLifecycleReconciliationScheduler(
  input: {
    intervalMs?: number;
    run?: () => Promise<ServiceContractLifecycleReconciliationResult>;
  } = {},
) {
  let running = false;
  const runReconciliation =
    input.run ?? (() => reconcileActivatedProgressiveLuxuryRenewals());
  const sweep = async () => {
    if (running) return;
    running = true;
    try {
      await runReconciliation();
    } catch {
      console.error("[ServiceContractLifecycle] reconciliation_failed");
    } finally {
      running = false;
    }
  };
  void sweep();
  const timer = setInterval(
    () => void sweep(),
    Math.max(60_000, input.intervalMs ?? 5 * 60_000),
  );
  timer.unref?.();
  return () => clearInterval(timer);
}

export async function getServicePortal(
  userId: number,
  options: {
    now?: Date;
    repository?: ServiceEntitlementRepository;
  } = {},
): Promise<ServicePortal> {
  const now = options.now ?? new Date();
  if (!options.repository) {
    try {
      await reconcileActivatedProgressiveLuxuryRenewals({
        userId,
        now,
      });
    } catch (error) {
      if (!isMissingServicePortalTableError(error)) {
        // Entitlement reads stay available while the periodic fenced sweep
        // retries. Never expose raw database/provider text in this event.
        console.error("[ServiceContractLifecycle] lazy_reconciliation_failed");
      }
    }
  }
  const state = await (
    options.repository ?? DATABASE_REPOSITORY
  ).loadPortalState(userId, now);
  return deriveServicePortalState({ ...state, userId, now });
}

export function assertWritableServicePortal(portal: ServicePortal) {
  if (portal.service.status === "unconfigured") {
    if (portal.entitlementRollout.mode === "compatibility") {
      return portal;
    }
    throw new ServiceEntitlementError(
      "SERVICE_PLAN_UNCONFIGURED",
      "当前账号的服务版本尚未配置，请联系管理员。",
      403,
    );
  }
  if (portal.service.status === "pending_confirmation") {
    throw new ServiceEntitlementError(
      "SERVICE_PLAN_PENDING_CONFIRMATION",
      "服务合同尚待确认，确认后即可继续。",
      403,
    );
  }
  if (portal.service.status === "scheduled") {
    throw new ServiceEntitlementError(
      "SERVICE_PLAN_NOT_STARTED",
      "服务尚未到约定生效日期。",
      403,
    );
  }
  if (portal.service.status === "suspended") {
    throw new ServiceEntitlementError(
      "SERVICE_PLAN_SUSPENDED",
      "服务当前已暂停，请联系服务顾问。",
      403,
    );
  }
  if (
    portal.service.status === "expired" ||
    portal.service.status === "cancelled"
  ) {
    throw new ServiceEntitlementError(
      "SERVICE_PLAN_EXPIRED",
      "当前服务已到期或取消，请续费后继续使用。",
      403,
    );
  }
  return portal;
}

/** Guards generic write transports without pretending they belong to a
 * particular workflow capability. Historical reads remain available. */
export async function assertServiceWriteAccess(
  userId: number,
  options: {
    now?: Date;
    repository?: ServiceEntitlementRepository;
  } = {},
) {
  return assertWritableServicePortal(await getServicePortal(userId, options));
}

export async function assertServiceCapability(
  userId: number,
  capability: ServiceCapabilityKey,
  options: {
    now?: Date;
    repository?: ServiceEntitlementRepository;
  } = {},
): Promise<ServicePortal> {
  serviceCapabilityKeySchema.parse(capability);
  const portal = assertWritableServicePortal(
    await getServicePortal(userId, options),
  );
  if (
    capability === "contentAssets" &&
    portal.capabilities[capability].effectiveStatus === "not_in_plan"
  ) {
    throw new ServiceEntitlementError(
      "CAPABILITY_UPGRADE_REQUIRED",
      "当前版本不包含此能力，可升级进阶版或豪华版解锁。",
      403,
    );
  }
  if (
    capability === "contentAssets" &&
    !servicePortalHasRequiredKnowledge(portal)
  ) {
    throw new ServiceEntitlementError(
      "KNOWLEDGE_SNAPSHOT_NOT_FOUND",
      portal.service.planCode === "basic"
        ? "请先等待 Website 流程自动同步或服务团队补录知识库；知识库展示完成后解锁 AI 友好内容资产。"
        : "请先在知识库智能体中完成全部节点并发布当前服务的认证知识库；知识库展示完成后解锁 AI 友好内容资产。",
      409,
    );
  }
  if (
    portal.service.status === "unconfigured" &&
    portal.entitlementRollout.mode === "compatibility"
  ) {
    return portal;
  }
  if (!portal.capabilities[capability].allowed) {
    throw new ServiceEntitlementError(
      "CAPABILITY_UPGRADE_REQUIRED",
      "当前版本不包含此能力，可升级进阶版或豪华版解锁。",
      403,
    );
  }
  if (
    (capability === "globalKeywords" || capability === "questionSelection") &&
    (portal.service.planCode === "advanced" ||
      portal.service.planCode === "luxury") &&
    !portal.knowledge.authenticatedForCurrentService
  ) {
    throw new ServiceEntitlementError(
      "KNOWLEDGE_SNAPSHOT_NOT_FOUND",
      "请先在知识库智能体中逐项完成 8–115 个节点，并发布当前套餐使用的认证知识库。",
      409,
    );
  }
  const workflowStepByCapability: Partial<
    Record<ServiceCapabilityKey, ServicePortal["workflowSteps"][number]["id"]>
  > = {
    knowledgeBuild: "knowledge",
    globalKeywords: "question",
    questionSelection: "question",
    // Keep the legacy capability key/API compatible while enforcing the
    // current prerequisite chain. There is no longer an active
    // `intent_optimization` workflow step: selected questions proceed
    // directly to response-logic confirmation.
    intentOptimization: "response_logic",
    responseLogic: "response_logic",
    monitoring: "monitoring",
    channelDistribution: "channel_distribution",
    progressReport: "progress_report",
  };
  const workflowStepId = workflowStepByCapability[capability];
  const workflowStep = workflowStepId
    ? portal.workflowSteps.find((step) => step.id === workflowStepId)
    : undefined;
  if (workflowStep?.status === "locked") {
    throw new ServiceEntitlementError(
      "SERVICE_WORKFLOW_PREREQUISITE_REQUIRED",
      workflowStep.lockedReason || "请先完成当前步骤的前置服务。",
      409,
    );
  }
  return portal;
}

/**
 * Basic uses the administrator-published display snapshot, while Advanced
 * and Luxury require the knowledge-agent snapshot authenticated for the
 * current service. The knowledge workflow step already projects that exact
 * product distinction, so it is the primary source of truth.
 */
export function servicePortalHasRequiredKnowledge(portal: ServicePortal) {
  if (portal.knowledge?.status !== "display_ready") return false;
  const knowledgeStep = portal.workflowSteps?.find(
    (step) => step.id === "knowledge",
  );
  if (portal.service.planCode === "basic") {
    return !knowledgeStep || knowledgeStep.status === "complete";
  }
  return (
    portal.knowledge.authenticatedForCurrentService === true &&
    (!knowledgeStep || knowledgeStep.status === "complete")
  );
}

async function requireServiceDb() {
  const db = await getDb();
  if (!db) {
    throw new ServiceEntitlementError(
      "DATABASE_UNAVAILABLE",
      "数据库尚未配置。",
      503,
    );
  }
  return db;
}

export type UpsertServiceContractInput = {
  userId: number;
  planCode: ServicePlanCode;
  expectedRevision: number;
  startsAt?: Date;
  status?: Exclude<PersistedServiceContractStatus, "superseded">;
  source?: ServiceContractSource;
  sourceReference?: string | null;
  amountFen?: number | null;
  currency?: string;
  prepaidMonths?: number | null;
  orderReference?: string | null;
  externalContractReference?: string | null;
  signedAt?: Date | null;
  signatoryId?: string | null;
  signingEvidence?: Record<string, unknown> | null;
  updatedByUserId?: number | null;
  /**
   * Basic purchases are additive by default: every order retains its own
   * 30-day entitlement and one-question quota. Set false only for an explicit
   * administrative correction that replaces prior service.
   */
  preserveConcurrentBasic?: boolean;
  /**
   * Contracts explicitly replaced by an upgrade/correction. When omitted, the
   * current primary contract is used; a Basic-only workspace includes every
   * concurrently active Basic order.
   */
  sourceContractIds?: string[];
  /**
   * Selected source questions that should continue in the new plan. If omitted,
   * every source question is carried only when the complete set fits; otherwise
   * the transaction stops and requires an explicit reconciliation selection.
   */
  carryQuestionIds?: string[];
  now?: Date;
};

export function shouldCarryServiceQuestionsByDefault(input: {
  targetPlanCode: ServicePlanCode;
  targetPlanVersion: number;
  startsAt: DateValue;
  sourceContracts: Array<
    Pick<ServicePortalContractRecord, "planCode" | "endsAt">
  >;
}) {
  return !isProgressiveLuxuryRenewal(input);
}

export function isProgressiveLuxuryRenewal(input: {
  targetPlanCode: ServicePlanCode;
  targetPlanVersion: number;
  startsAt: DateValue;
  sourceContracts: Array<
    Pick<ServicePortalContractRecord, "planCode" | "endsAt">
  >;
}) {
  return (
    input.targetPlanCode === "luxury" &&
    input.targetPlanVersion >= PROGRESSIVE_LUXURY_PLAN_VERSION &&
    input.sourceContracts.some(
      (contract) =>
        contract.planCode === "luxury" &&
        epoch(input.startsAt) >= epoch(contract.endsAt),
    )
  );
}

const ACTIVE_QUESTION_WORKFLOW_TICKET_STATUSES = [
  "submitted",
  "needs_information",
  "scheduled",
  "in_progress",
] as const;
const CONTRACT_SCOPED_QUESTION_WORKFLOW_OPERATIONS = [
  "question_catalog",
  "initial_monitoring",
  "monitoring_import",
] as const;

function questionWorkflowTicketCondition() {
  return or(
    isNotNull(deliveryTickets.sourceQuestionId),
    inArray(
      deliveryTickets.operation,
      CONTRACT_SCOPED_QUESTION_WORKFLOW_OPERATIONS,
    ),
  );
}

/**
 * A same-plan overlapping replacement is an administrative correction, not a
 * new entitlement cohort. It must preserve the source question workflow. A
 * cancelled target is an explicit termination and must never be trapped behind
 * question-workflow reconciliation.
 */
export function isSamePlanOverlappingServiceCorrection(input: {
  targetPlanCode: ServicePlanCode;
  targetPlanVersion: number;
  targetStatus: Exclude<PersistedServiceContractStatus, "superseded">;
  startsAt: DateValue;
  sourceContracts: Array<
    Pick<ServicePortalContractRecord, "planCode" | "planVersion" | "endsAt">
  >;
}) {
  if (input.targetStatus === "cancelled") return false;
  return input.sourceContracts.some(
    (contract) =>
      contract.planCode === input.targetPlanCode &&
      contract.planVersion === input.targetPlanVersion &&
      epoch(input.startsAt) < epoch(contract.endsAt),
  );
}

export function isBlockingQuestionWorkflowTicketStatus(status: string) {
  return (
    ACTIVE_QUESTION_WORKFLOW_TICKET_STATUSES as readonly string[]
  ).includes(status);
}

export function assertServiceContractCancellationTiming(input: {
  status: Exclude<PersistedServiceContractStatus, "superseded">;
  startsAt: DateValue;
  now: DateValue;
}) {
  if (
    input.status === "cancelled" &&
    epoch(input.startsAt) > epoch(input.now)
  ) {
    throw new ServiceEntitlementError(
      "UPGRADE_RECONCILIATION_REQUIRED",
      "服务取消必须立即生效，不能预约未来日期。",
    );
  }
}

function isServiceContractLifecycleLockContention(error: unknown) {
  let cursor: unknown = error;
  for (let depth = 0; depth < 5 && cursor; depth += 1) {
    if (typeof cursor !== "object") break;
    const value = cursor as {
      code?: unknown;
      errno?: unknown;
      cause?: unknown;
    };
    if (
      value.code === "ER_LOCK_NOWAIT" ||
      value.code === "ER_LOCK_WAIT_TIMEOUT" ||
      value.code === "ER_LOCK_DEADLOCK" ||
      value.errno === 3572 ||
      value.errno === 1205 ||
      value.errno === 1213
    ) {
      return true;
    }
    cursor = value.cause;
  }
  return false;
}

async function withServiceContractLifecycleNoWaitLock<T>(
  operation: () => Promise<T>,
) {
  try {
    return await operation();
  } catch (error) {
    if (!isServiceContractLifecycleLockContention(error)) throw error;
    throw new ServiceEntitlementError(
      "UPGRADE_RECONCILIATION_REQUIRED",
      "问题工作流正在更新，请稍后重试服务合同操作。",
    );
  }
}

type TerminateContractQuestionWorkResult = {
  archivedPendingQuestionCount: number;
  cancelledQuestionWorkflowTicketCount: number;
};

async function terminateContractQuestionWork(input: {
  executor: any;
  userId: number;
  contractIds: string[];
  now: Date;
  message: string;
  lockMode: "no_wait" | "skip_locked";
}): Promise<TerminateContractQuestionWorkResult> {
  if (!input.contractIds.length) {
    return {
      archivedPendingQuestionCount: 0,
      cancelledQuestionWorkflowTicketCount: 0,
    };
  }
  const ticketQuery = input.executor
    .select()
    .from(deliveryTickets)
    .where(
      and(
        eq(deliveryTickets.userId, input.userId),
        inArray(deliveryTickets.contractId, input.contractIds),
        questionWorkflowTicketCondition(),
        inArray(
          deliveryTickets.status,
          ACTIVE_QUESTION_WORKFLOW_TICKET_STATUSES,
        ),
      ),
    );
  const activeQuestionWorkflowRows =
    input.lockMode === "skip_locked"
      ? await ticketQuery.for("update", { skipLocked: true })
      : await withServiceContractLifecycleNoWaitLock(() =>
          ticketQuery.for("update", { noWait: true }),
        );
  const questionQuery = input.executor
    .select({ id: workspaceQuestions.id })
    .from(workspaceQuestions)
    .where(
      and(
        eq(workspaceQuestions.userId, input.userId),
        inArray(workspaceQuestions.contractId, input.contractIds),
        inArray(workspaceQuestions.status, ["candidate", "selected"]),
        eq(workspaceQuestions.selectionApprovalStatus, "pending"),
      ),
    );
  const pendingQuestionRows =
    input.lockMode === "skip_locked"
      ? await questionQuery.for("update", { skipLocked: true })
      : await withServiceContractLifecycleNoWaitLock(() =>
          questionQuery.for("update", { noWait: true }),
        );

  if (activeQuestionWorkflowRows.length) {
    const ticketIds = activeQuestionWorkflowRows.map(
      (ticket: { id: string }) => ticket.id,
    );
    await input.executor
      .update(deliveryTickets)
      .set({
        status: "cancelled",
        publicSummary: input.message,
        technicalDedupeKey: null,
        resolvedAt: input.now,
        revision: sql`${deliveryTickets.revision} + 1`,
        updatedByUserId: null,
        updatedAt: input.now,
      })
      .where(
        and(
          inArray(deliveryTickets.id, ticketIds),
          inArray(
            deliveryTickets.status,
            ACTIVE_QUESTION_WORKFLOW_TICKET_STATUSES,
          ),
        ),
      );
    await input.executor.insert(deliveryTicketEvents).values(
      activeQuestionWorkflowRows.map(
        (ticket: {
          id: string;
          status: (typeof ACTIVE_QUESTION_WORKFLOW_TICKET_STATUSES)[number];
        }) => ({
          id: randomUUID(),
          ticketId: ticket.id,
          userId: input.userId,
          actorUserId: null,
          actorRole: "system" as const,
          kind: "status_change" as const,
          visibility: "customer" as const,
          message: input.message,
          fromStatus: ticket.status,
          toStatus: "cancelled" as const,
          createdAt: input.now,
        }),
      ),
    );
  }
  if (pendingQuestionRows.length) {
    await input.executor
      .update(workspaceQuestions)
      .set({
        status: "archived",
        selectionApprovalStatus: "not_requested",
        locked: false,
        archivedAt: input.now,
        revision: sql`${workspaceQuestions.revision} + 1`,
        updatedAt: input.now,
      })
      .where(
        and(
          inArray(
            workspaceQuestions.id,
            pendingQuestionRows.map((question: { id: string }) => question.id),
          ),
          inArray(workspaceQuestions.status, ["candidate", "selected"]),
          eq(workspaceQuestions.selectionApprovalStatus, "pending"),
        ),
      );
  }
  return {
    archivedPendingQuestionCount: pendingQuestionRows.length,
    cancelledQuestionWorkflowTicketCount: activeQuestionWorkflowRows.length,
  };
}

export function terminateCancelledServiceContractQuestionWork(input: {
  executor: any;
  userId: number;
  contractIds: string[];
  now: Date;
}) {
  return terminateContractQuestionWork({
    ...input,
    message:
      "服务合同已终止，当前问题工作流已自动关闭；如需恢复服务，请先配置新的有效合同。",
    lockMode: "no_wait",
  });
}

export function resolveTargetServicePlanVersion(input: {
  targetPlanCode: ServicePlanCode;
  startsAt: DateValue;
  sourceContracts: Array<
    Pick<ServicePortalContractRecord, "planCode" | "planVersion" | "endsAt">
  >;
}) {
  if (
    input.targetPlanCode === "luxury" &&
    input.sourceContracts.some(
      (contract) =>
        contract.planCode === "luxury" &&
        contract.planVersion < PROGRESSIVE_LUXURY_PLAN_VERSION &&
        epoch(input.startsAt) < epoch(contract.endsAt),
    )
  ) {
    return 1;
  }
  return SERVICE_PLAN_CATALOG[input.targetPlanCode].planVersion;
}

export async function upsertServiceContract(
  input: UpsertServiceContractInput,
): Promise<ServicePortal> {
  const db = await requireServiceDb();
  const planCode = servicePlanCodeSchema.parse(input.planCode);
  const mutationTime = input.now ?? new Date();
  const startsAt = input.startsAt ?? mutationTime;
  assertServiceContractCancellationTiming({
    status: input.status ?? "active",
    startsAt,
    now: mutationTime,
  });
  const newContractId = randomUUID();
  const source = input.source ?? "admin";
  const sourceReference = input.sourceReference?.trim() || null;

  await db.transaction(async (tx) => {
    const targetUsers = await tx
      .select({ id: users.id })
      .from(users)
      .where(eq(users.id, input.userId))
      .limit(1)
      .for("update");
    if (!targetUsers[0]) {
      throw new ServiceEntitlementError(
        "SERVICE_PLAN_UNCONFIGURED",
        "用户不存在，无法配置服务版本。",
        404,
      );
    }
    const existingRows = await tx
      .select()
      .from(serviceContracts)
      .where(eq(serviceContracts.userId, input.userId))
      .orderBy(desc(serviceContracts.revision))
      .for("update");
    const currentRevision = existingRows[0]?.revision ?? 0;
    const idempotentContract = sourceReference
      ? existingRows.find(
          (value) =>
            value.source === source &&
            value.sourceReference === sourceReference,
        )
      : undefined;
    if (idempotentContract) {
      if (idempotentContract.planCode !== planCode) {
        throw new ServiceEntitlementError(
          "SERVICE_REVISION_CONFLICT",
          "该订单引用已绑定到另一服务版本。",
        );
      }
      return;
    }
    if (input.expectedRevision !== currentRevision) {
      throw new ServiceEntitlementError(
        "SERVICE_REVISION_CONFLICT",
        "服务版本已被其他操作更新，请刷新后重试。",
      );
    }
    const primaryContract = selectPortalContract(
      existingRows as ServicePortalContractRecord[],
      input.now ?? startsAt,
    );
    const shouldReplaceExisting =
      planCode !== "basic" || input.preserveConcurrentBasic === false;
    const explicitSourceIds = input.sourceContractIds
      ? [...new Set(input.sourceContractIds)]
      : null;
    let sourceContracts: typeof existingRows = [];
    if (shouldReplaceExisting && existingRows.length) {
      if (explicitSourceIds) {
        sourceContracts = existingRows.filter((contract) =>
          explicitSourceIds.includes(contract.id),
        );
        if (sourceContracts.length !== explicitSourceIds.length) {
          throw new ServiceEntitlementError(
            "SERVICE_REVISION_CONFLICT",
            "待替换的来源合同已变化，请刷新后重试。",
          );
        }
      } else {
        const primary = primaryContract;
        if (primary?.planCode === "basic") {
          const activeBasicContracts = existingRows.filter(
            (contract) =>
              contract.planCode === "basic" &&
              deriveEffectiveServiceStatus(
                contract as ServicePortalContractRecord,
                input.now ?? startsAt,
              ) === "active",
          );
          sourceContracts = activeBasicContracts.length
            ? activeBasicContracts
            : existingRows.filter((contract) => contract.id === primary.id);
        } else {
          sourceContracts = primary
            ? existingRows.filter((contract) => contract.id === primary.id)
            : [];
        }
      }
    }
    const sourceContractIds = sourceContracts.map((contract) => contract.id);
    const targetPlanVersion = resolveTargetServicePlanVersion({
      targetPlanCode: planCode,
      startsAt,
      sourceContracts: sourceContracts as ServicePortalContractRecord[],
    });
    const samePlanOverlappingCorrection =
      isSamePlanOverlappingServiceCorrection({
        targetPlanCode: planCode,
        targetPlanVersion,
        targetStatus: input.status ?? "active",
        startsAt,
        sourceContracts: sourceContracts as ServicePortalContractRecord[],
      });
    if (samePlanOverlappingCorrection && sourceContractIds.length) {
      const pendingSourceQuestionRows =
        await withServiceContractLifecycleNoWaitLock(() =>
          tx
            .select({ id: workspaceQuestions.id })
            .from(workspaceQuestions)
            .where(
              and(
                eq(workspaceQuestions.userId, input.userId),
                inArray(workspaceQuestions.contractId, sourceContractIds),
                inArray(workspaceQuestions.status, ["candidate", "selected"]),
                eq(workspaceQuestions.selectionApprovalStatus, "pending"),
              ),
            )
            .limit(1)
            .for("update", { noWait: true }),
        );
      const activeQuestionWorkflowRows =
        await withServiceContractLifecycleNoWaitLock(() =>
          tx
            .select({ id: deliveryTickets.id })
            .from(deliveryTickets)
            .where(
              and(
                eq(deliveryTickets.userId, input.userId),
                inArray(deliveryTickets.contractId, sourceContractIds),
                questionWorkflowTicketCondition(),
                inArray(
                  deliveryTickets.status,
                  ACTIVE_QUESTION_WORKFLOW_TICKET_STATUSES,
                ),
              ),
            )
            .limit(1)
            .for("update", { noWait: true }),
        );
      if (pendingSourceQuestionRows[0] || activeQuestionWorkflowRows[0]) {
        throw new ServiceEntitlementError(
          "UPGRADE_RECONCILIATION_REQUIRED",
          "来源合同仍有待审核问题或正在处理的问题工作流，请先完成或取消后再更正服务合同。",
        );
      }
    }
    const endsAt = getServiceContractTermEnd(planCode, startsAt, {
      planVersion: targetPlanVersion,
    });
    const windows = createServiceQuotaWindows(planCode, startsAt, {
      planVersion: targetPlanVersion,
    });
    const quotaRows = windows.map((window) => ({
      id: randomUUID(),
      contractId: newContractId,
      userId: input.userId,
      ordinal: window.ordinal,
      startsAt: window.startsAt,
      endsAt: window.endsAt,
      ...window.limits,
      ...serviceQuotaWindowDeliveryLimits(planCode, window),
      revision: 1,
    }));
    let sourceQuestions: WorkspaceQuestion[] = [];
    if (sourceContractIds.length) {
      sourceQuestions = await tx
        .select()
        .from(workspaceQuestions)
        .where(
          and(
            eq(workspaceQuestions.userId, input.userId),
            inArray(workspaceQuestions.contractId, sourceContractIds),
            eq(workspaceQuestions.status, "selected"),
          ),
        )
        .orderBy(desc(workspaceQuestions.selectedAt))
        .for("update");
    }
    const explicitCarryIds = input.carryQuestionIds
      ? [...new Set(input.carryQuestionIds)]
      : null;
    // Progressive Luxury renewal begins a new annual problem cohort and does
    // not silently carry the mature prior-year set into Q1. Cross-plan upgrades
    // retain the legacy default unless an administrator supplies an explicit
    // carry selection.
    const progressiveLuxuryRenewal = isProgressiveLuxuryRenewal({
      targetPlanCode: planCode,
      targetPlanVersion,
      startsAt,
      sourceContracts: sourceContracts as ServicePortalContractRecord[],
    });
    if (progressiveLuxuryRenewal && explicitCarryIds?.length) {
      throw new ServiceEntitlementError(
        "UPGRADE_RECONCILIATION_REQUIRED",
        "豪华版年度续费从第一季度重新解锁，旧合同问题只能保留为历史。",
      );
    }
    const carryByDefault = shouldCarryServiceQuestionsByDefault({
      targetPlanCode: planCode,
      targetPlanVersion,
      startsAt,
      sourceContracts: sourceContracts as ServicePortalContractRecord[],
    });
    const carryoverQuestions =
      input.status === "cancelled"
        ? []
        : progressiveLuxuryRenewal
          ? []
          : explicitCarryIds
            ? sourceQuestions.filter((question) =>
                explicitCarryIds.includes(question.id),
              )
            : carryByDefault
              ? sourceQuestions
              : [];
    if (
      input.status !== "cancelled" &&
      explicitCarryIds &&
      carryoverQuestions.length !== explicitCarryIds.length
    ) {
      throw new ServiceEntitlementError(
        "UPGRADE_RECONCILIATION_REQUIRED",
        "需保留的问题已变化，请刷新后重新选择。",
      );
    }
    const targetWindow = selectServiceQuotaWindowAt(windows, mutationTime);
    const targetLimits =
      planCode === "luxury" &&
      targetPlanVersion >= PROGRESSIVE_LUXURY_PLAN_VERSION
        ? targetWindow!.limits
        : SERVICE_PLAN_CATALOG[planCode].limits;
    const carryUsage: ServiceQuotaUsage = { ...EMPTY_SERVICE_QUOTA_USAGE };
    try {
      for (const question of carryoverQuestions) {
        const category = workspaceQuestionCategorySchema.parse(
          question.category,
        );
        assertQuestionSelectionWithinQuota({
          limits: targetLimits,
          usage: carryUsage,
          category,
        });
        if (category === "industry") carryUsage.industry += 1;
        if (category === "competitor_comparison") {
          carryUsage.competitorComparison += 1;
        }
        if (category === "reputation") carryUsage.reputation += 1;
        if (category === "product_scenario") {
          carryUsage.productScenario += 1;
        }
        carryUsage.total += 1;
      }
    } catch (error) {
      if (error instanceof ServiceEntitlementError) {
        throw new ServiceEntitlementError(
          "UPGRADE_RECONCILIATION_REQUIRED",
          explicitCarryIds
            ? "所选保留问题超过新套餐分类额度，请重新选择。"
            : "已有服务问题超过新套餐额度，请先明确选择继续服务的问题。",
        );
      }
      throw error;
    }
    // Administrative corrections create a new immutable contract revision.
    // Omitted commercial fields inherit from the replaced contract so a
    // status/date edit cannot silently erase or fabricate signing evidence.
    const commercialSource =
      sourceContracts.find(
        (contract) =>
          contract.signedAt || contract.signatoryId || contract.signingEvidence,
      ) ?? sourceContracts[0];
    const resolvedAmountFen =
      input.amountFen === undefined
        ? (commercialSource?.amountFen ?? null)
        : input.amountFen;
    const resolvedCurrency =
      input.currency === undefined
        ? (commercialSource?.currency ?? "CNY")
        : input.currency.trim().toUpperCase() || "CNY";
    const resolvedPrepaidMonths =
      input.prepaidMonths === undefined
        ? (commercialSource?.prepaidMonths ??
          SERVICE_PLAN_CATALOG[planCode].prepaidMonths)
        : input.prepaidMonths;
    const resolvedOrderReference =
      input.orderReference === undefined
        ? (commercialSource?.orderReference ?? null)
        : input.orderReference?.trim() || null;
    const resolvedContractReference =
      input.externalContractReference === undefined
        ? (commercialSource?.externalContractReference ?? null)
        : input.externalContractReference?.trim() || null;
    const resolvedSignedAt =
      input.signedAt === undefined
        ? (commercialSource?.signedAt ?? null)
        : input.signedAt;
    const resolvedSignatoryId =
      input.signatoryId === undefined
        ? (commercialSource?.signatoryId ?? null)
        : input.signatoryId?.trim() || null;
    const resolvedSigningEvidence =
      input.signingEvidence === undefined
        ? (commercialSource?.signingEvidence ?? null)
        : input.signingEvidence;
    if (
      sourceContractIds.length &&
      shouldReplaceExisting &&
      startsAt.getTime() <= mutationTime.getTime()
    ) {
      if (input.status === "cancelled") {
        await terminateCancelledServiceContractQuestionWork({
          executor: tx,
          userId: input.userId,
          contractIds: sourceContractIds,
          now: mutationTime,
        });
      }
      await tx
        .update(serviceContracts)
        .set({ status: "superseded", updatedAt: mutationTime })
        .where(
          and(
            eq(serviceContracts.userId, input.userId),
            inArray(serviceContracts.id, sourceContractIds),
            inArray(serviceContracts.status, [
              "pending_confirmation",
              "scheduled",
              "active",
              "suspended",
            ] as const),
          ),
        );
    }
    await tx.insert(serviceContracts).values({
      id: newContractId,
      userId: input.userId,
      planCode,
      planVersion: targetPlanVersion,
      status: input.status ?? "active",
      startsAt,
      endsAt,
      source,
      amountFen: resolvedAmountFen,
      currency: resolvedCurrency,
      prepaidMonths: resolvedPrepaidMonths,
      orderReference: resolvedOrderReference,
      externalContractReference: resolvedContractReference,
      signedAt: resolvedSignedAt,
      signatoryId: resolvedSignatoryId,
      signingEvidence: resolvedSigningEvidence,
      replacesContractIds: sourceContractIds,
      sourceReference,
      revision: currentRevision + 1,
      createdByUserId: input.updatedByUserId ?? null,
    });
    await tx.insert(serviceQuotaPeriods).values(quotaRows);
    const targetOperationalPeriod = quotaRows.find(
      (period) => period.ordinal === targetWindow?.ordinal,
    );
    const targetQuotaPeriod = targetOperationalPeriod
      ? selectServiceQuestionStoragePeriod({
          contract: {
            id: newContractId,
            planCode,
            planVersion: targetPlanVersion,
          },
          operationalPeriod: targetOperationalPeriod,
          contractPeriods: quotaRows,
        })
      : null;
    if (targetQuotaPeriod && carryoverQuestions.length) {
      const carriedRows = carryoverQuestions.map((question, ordinal) => ({
        id: randomUUID(),
        userId: input.userId,
        contractId: newContractId,
        quotaPeriodId: targetQuotaPeriod.id,
        externalQuestionId: question.externalQuestionId,
        sourceQuestionId: question.sourceQuestionId ?? question.id,
        candidateKey: `carryover:${newContractId}:${question.id}`,
        category: workspaceQuestionCategorySchema.parse(question.category),
        question: question.question,
        intent: question.intent,
        rationale:
          question.rationale ??
          "从上一服务周期保留；确认继续服务后计入新套餐额度。",
        evidence: question.evidence,
        risks: question.risks,
        source: "admin" as const,
        status: "selected" as const,
        selectionApprovalStatus: "approved" as const,
        selectionRequestedAt: mutationTime,
        selectionRequestedByUserId: input.updatedByUserId ?? null,
        selectionApprovedAt: mutationTime,
        selectionApprovedByUserId: input.updatedByUserId ?? null,
        locked: true,
        sourceTaskId: null,
        knowledgeSnapshotId: question.knowledgeSnapshotId,
        ordinal,
        revision: 1,
        selectedAt: mutationTime,
        archivedAt: null,
        createdByUserId: input.updatedByUserId ?? null,
        createdAt: mutationTime,
        updatedAt: mutationTime,
      }));
      await tx.insert(workspaceQuestions).values(carriedRows);
      const responseRows = await tx
        .select()
        .from(responseLogicEntries)
        .where(
          and(
            eq(responseLogicEntries.userId, input.userId),
            inArray(
              responseLogicEntries.questionId,
              carryoverQuestions.map((question) => question.id),
            ),
          ),
        )
        .for("update");
      const responseByQuestion = new Map(
        responseRows.map((entry) => [entry.questionId, entry]),
      );
      const carriedResponseRows = carriedRows.flatMap((question, index) => {
        const sourceQuestion = carryoverQuestions[index];
        const sourceResponse = sourceQuestion
          ? responseByQuestion.get(sourceQuestion.id)
          : undefined;
        if (!sourceResponse) return [];
        return [
          {
            ...sourceResponse,
            id: randomUUID(),
            questionId: question.id,
            question: question.question,
            intent: question.intent ?? sourceResponse.intent,
            summary: question.rationale ?? sourceResponse.summary,
            conversationId: null,
            lastTaskId: null,
            revision: 1,
            createdAt: mutationTime,
            updatedAt: mutationTime,
          },
        ];
      });
      if (carriedResponseRows.length) {
        await tx.insert(responseLogicEntries).values(carriedResponseRows);
      }
    }
  });
  return getServicePortal(input.userId, { now: input.now });
}

export type GeneratedQuestionCandidate = {
  candidateKey?: string;
  externalQuestionId?: string | null;
  category: WorkspaceQuestionCategory;
  question: string;
  intent?: string | null;
  rationale?: string | null;
  evidence?: WorkspaceQuestionEvidenceRecord[];
  risks?: string[];
};

export type ReplaceGeneratedQuestionCandidatesInput = {
  userId: number;
  quotaPeriodId: string;
  candidates: GeneratedQuestionCandidate[];
  sourceTaskId: string;
  knowledgeSnapshotId?: string | null;
  expectedQuotaContext: {
    revision: number;
    remaining: {
      industry: number;
      competitorComparison: number;
      reputation: number;
      productScenario: number;
    };
  };
};

export function assertGeneratedQuestionQuotaContextCurrent(input: {
  period: Pick<
    ServicePortalQuotaPeriodRecord,
    | "revision"
    | "industryLimit"
    | "competitorComparisonLimit"
    | "reputationLimit"
    | "productScenarioLimit"
    | "totalQuestionLimit"
  > &
    Partial<
      Pick<
        ServicePortalQuotaPeriodRecord,
        "id" | "contractId" | "ordinal" | "startsAt" | "endsAt"
      >
    >;
  contract?: Pick<
    ServicePortalContractRecord,
    "planCode" | "planVersion" | "startsAt" | "endsAt"
  >;
  now?: DateValue;
  selectedUsage: ServiceQuotaUsage;
  expected: ReplaceGeneratedQuestionCandidatesInput["expectedQuotaContext"];
}) {
  const limits = input.contract
    ? resolveEffectiveServiceQuestionQuotaLimits({
        contract: input.contract,
        period: input.period as ServiceQuestionQuotaPeriod,
        now: input.now,
      })
    : persistedServiceQuestionQuotaLimits(
        input.period as ServiceQuestionQuotaPeriod,
      );
  const remaining = remainingQuota(limits, input.selectedUsage);
  if (
    input.period.revision !== input.expected.revision ||
    remaining.industry !== input.expected.remaining.industry ||
    remaining.competitorComparison !==
      input.expected.remaining.competitorComparison ||
    remaining.reputation !== input.expected.remaining.reputation ||
    remaining.productScenario !== input.expected.remaining.productScenario
  ) {
    throw new ServiceEntitlementError(
      "QUESTION_GENERATION_CONTEXT_STALE",
      "问题额度或可选问题数量已变化，请重新生成品牌全域候选词。",
    );
  }
  return remaining;
}

function normalizeCandidateText(value: string, field: string, max: number) {
  const normalized = String(value ?? "")
    .normalize("NFC")
    .trim();
  if (!normalized || normalized.length > max) {
    throw new ServiceEntitlementError(
      "QUESTION_GENERATION_CONFLICT",
      `${field}无效。`,
      400,
    );
  }
  return normalized;
}

function normalizeOptionalCandidateText(
  value: string | null | undefined,
  field: string,
  max: number,
) {
  return value == null || !value.trim()
    ? null
    : normalizeCandidateText(value, field, max);
}

function candidateKey(candidate: GeneratedQuestionCandidate) {
  const provided = candidate.candidateKey?.trim();
  if (provided) return normalizeCandidateText(provided, "候选问题标识", 191);
  return createHash("sha256")
    .update(
      `${candidate.category}\0${candidate.question.normalize("NFKC").trim()}`,
    )
    .digest("hex");
}

export function normalizeGeneratedQuestionCandidates(
  values: GeneratedQuestionCandidate[],
) {
  if (!values.length) {
    throw new ServiceEntitlementError(
      "QUESTION_GENERATION_CONFLICT",
      "候选问题不能为空。",
      400,
    );
  }
  const candidates = values.map((candidate, ordinal) => {
    const category = workspaceQuestionCategorySchema.safeParse(
      candidate.category,
    );
    if (!category.success) {
      throw new ServiceEntitlementError(
        "QUESTION_GENERATION_CONFLICT",
        "候选问题类型无效。",
        400,
      );
    }
    if ((candidate.evidence?.length ?? 0) > 100) {
      throw new ServiceEntitlementError(
        "QUESTION_GENERATION_CONFLICT",
        "单个候选问题最多保留 100 条证据。",
        400,
      );
    }
    const evidence = (candidate.evidence ?? []).map((item) => ({
      documentPath: normalizeCandidateText(
        item.documentPath,
        "证据文档路径",
        1_024,
      ),
      excerpt: normalizeCandidateText(item.excerpt, "证据摘录", 8_000),
      relevance: normalizeCandidateText(item.relevance, "证据关联说明", 2_000),
    }));
    if ((candidate.risks?.length ?? 0) > 100) {
      throw new ServiceEntitlementError(
        "QUESTION_GENERATION_CONFLICT",
        "单个候选问题最多保留 100 条风险说明。",
        400,
      );
    }
    const risks = (candidate.risks ?? []).map((risk) =>
      normalizeCandidateText(risk, "风险说明", 2_000),
    );
    return {
      candidateKey: candidateKey(candidate),
      externalQuestionId: normalizeOptionalCandidateText(
        candidate.externalQuestionId,
        "外部问题标识",
        191,
      ),
      category: category.data,
      question: normalizeCandidateText(candidate.question, "候选问题", 4_000),
      intent: normalizeOptionalCandidateText(
        candidate.intent,
        "问题意图",
        16_000,
      ),
      rationale: normalizeOptionalCandidateText(
        candidate.rationale,
        "推荐理由",
        16_000,
      ),
      evidence,
      risks,
      ordinal,
    };
  });
  if (
    new Set(candidates.map((item) => item.candidateKey)).size !==
    candidates.length
  ) {
    throw new ServiceEntitlementError(
      "QUESTION_GENERATION_CONFLICT",
      "同一批次包含重复的候选问题。",
      400,
    );
  }
  return candidates;
}

function evidenceSignature(
  evidence: WorkspaceQuestionEvidenceRecord[] | null | undefined,
) {
  return JSON.stringify(
    (evidence ?? []).map((item) => ({
      documentPath: item.documentPath,
      excerpt: item.excerpt,
      relevance: item.relevance,
    })),
  );
}

export function isReplaceableModelCandidate(
  question: Pick<
    WorkspaceQuestion,
    "source" | "status" | "selectionApprovalStatus" | "locked"
  >,
): boolean {
  return (
    question.source === "model" &&
    question.status === "candidate" &&
    question.selectionApprovalStatus === "not_requested" &&
    !question.locked
  );
}

function toPublicWorkspaceQuestion(
  row: WorkspaceQuestion,
): ServicePortalQuestion {
  return publicQuestion(row);
}

export async function replaceGeneratedQuestionCandidates(
  input: ReplaceGeneratedQuestionCandidatesInput,
): Promise<ServicePortalQuestion[]> {
  const db = await requireServiceDb();
  const sourceTaskId = normalizeCandidateText(
    input.sourceTaskId,
    "生成任务标识",
    255,
  );
  const candidates = normalizeGeneratedQuestionCandidates(input.candidates);
  const now = new Date();

  return db.transaction(async (tx) => {
    const targetUsers = await tx
      .select({ id: users.id })
      .from(users)
      .where(eq(users.id, input.userId))
      .limit(1)
      .for("update");
    if (!targetUsers[0]) {
      throw new ServiceEntitlementError(
        "SERVICE_PLAN_UNCONFIGURED",
        "用户不存在。",
        404,
      );
    }
    const periodRows = await tx
      .select()
      .from(serviceQuotaPeriods)
      .where(
        and(
          eq(serviceQuotaPeriods.id, input.quotaPeriodId),
          eq(serviceQuotaPeriods.userId, input.userId),
        ),
      )
      .limit(1)
      .for("update");
    const period = periodRows.find(isOperationalServiceQuotaPeriod);
    if (!period) {
      throw new ServiceEntitlementError(
        "QUOTA_PERIOD_NOT_FOUND",
        "当前问题额度周期不存在。",
        404,
      );
    }
    const contractRows = await tx
      .select()
      .from(serviceContracts)
      .where(
        and(
          eq(serviceContracts.id, period.contractId),
          eq(serviceContracts.userId, input.userId),
        ),
      )
      .limit(1)
      .for("update");
    const contract = contractRows[0];
    if (
      !contract ||
      deriveEffectiveServiceStatus(
        contract as ServicePortalContractRecord,
        now,
      ) !== "active" ||
      period.startsAt.getTime() > now.getTime() ||
      period.endsAt.getTime() <= now.getTime()
    ) {
      throw new ServiceEntitlementError(
        "QUESTION_GENERATION_CONTEXT_STALE",
        "服务周期或问题额度已变化，请重新生成品牌全域候选词。",
      );
    }
    const questionStoragePeriod = await loadServiceQuestionStoragePeriod({
      executor: tx,
      userId: input.userId,
      contract,
      operationalPeriod: period,
    });
    if (!questionStoragePeriod) {
      throw new ServiceEntitlementError(
        "QUESTION_GENERATION_CONTEXT_STALE",
        "问题额度兼容锚点缺失，请联系服务团队修复后重新生成。",
      );
    }
    const scope = resolveServiceQuestionQuotaScope(contract, period);
    const selectedRows = await tx
      .select({
        contractId: workspaceQuestions.contractId,
        quotaPeriodId: workspaceQuestions.quotaPeriodId,
        category: workspaceQuestions.category,
        status: workspaceQuestions.status,
      })
      .from(workspaceQuestions)
      .where(
        and(
          eq(workspaceQuestions.userId, input.userId),
          scope.kind === "contract"
            ? eq(workspaceQuestions.contractId, scope.contractId)
            : eq(workspaceQuestions.quotaPeriodId, scope.periodId),
          eq(workspaceQuestions.status, "selected"),
        ),
      )
      .for("update");
    assertGeneratedQuestionQuotaContextCurrent({
      period,
      contract,
      now,
      selectedUsage: countSelectedQuestionUsage(selectedRows, scope),
      expected: input.expectedQuotaContext,
    });
    if (input.knowledgeSnapshotId) {
      const snapshots = await tx
        .select({ id: knowledgeBaseSnapshots.id })
        .from(knowledgeBaseSnapshots)
        .where(
          and(
            eq(knowledgeBaseSnapshots.id, input.knowledgeSnapshotId),
            eq(knowledgeBaseSnapshots.userId, input.userId),
          ),
        )
        .limit(1);
      if (!snapshots[0]) {
        throw new ServiceEntitlementError(
          "KNOWLEDGE_SNAPSHOT_NOT_FOUND",
          "生成问题所用的知识库内容不存在。",
          404,
        );
      }
    }
    const sameTaskRows = await tx
      .select()
      .from(workspaceQuestions)
      .where(
        and(
          eq(workspaceQuestions.userId, input.userId),
          eq(workspaceQuestions.quotaPeriodId, questionStoragePeriod.id),
          eq(workspaceQuestions.sourceTaskId, sourceTaskId),
          eq(workspaceQuestions.source, "model"),
        ),
      )
      .orderBy(asc(workspaceQuestions.ordinal))
      .for("update");
    if (sameTaskRows.length) {
      const same =
        sameTaskRows.length === candidates.length &&
        sameTaskRows.every((row, index) => {
          const candidate = candidates[index];
          return (
            row.candidateKey === candidate.candidateKey &&
            row.category === candidate.category &&
            row.question === candidate.question &&
            row.intent === candidate.intent &&
            row.rationale === candidate.rationale &&
            evidenceSignature(row.evidence) ===
              evidenceSignature(candidate.evidence) &&
            JSON.stringify(row.risks) === JSON.stringify(candidate.risks)
          );
        });
      if (!same) {
        throw new ServiceEntitlementError(
          "QUESTION_GENERATION_CONFLICT",
          "该生成任务已绑定另一组候选问题。",
        );
      }
      return sameTaskRows.map(toPublicWorkspaceQuestion);
    }

    const replaceableRows = await tx
      .select({
        id: workspaceQuestions.id,
        revision: workspaceQuestions.revision,
      })
      .from(workspaceQuestions)
      .where(
        and(
          eq(workspaceQuestions.userId, input.userId),
          eq(workspaceQuestions.quotaPeriodId, questionStoragePeriod.id),
          eq(workspaceQuestions.source, "model"),
          eq(workspaceQuestions.status, "candidate"),
          eq(workspaceQuestions.selectionApprovalStatus, "not_requested"),
          eq(workspaceQuestions.locked, false),
        ),
      )
      .for("update");
    const archivedAt = new Date();
    for (const row of replaceableRows) {
      await tx
        .update(workspaceQuestions)
        .set({
          status: "archived",
          archivedAt,
          revision: row.revision + 1,
          updatedAt: archivedAt,
        })
        .where(eq(workspaceQuestions.id, row.id));
    }

    const rows: WorkspaceQuestion[] = candidates.map((candidate) => ({
      id: randomUUID(),
      userId: input.userId,
      contractId: period.contractId,
      quotaPeriodId: questionStoragePeriod.id,
      externalQuestionId: candidate.externalQuestionId,
      sourceQuestionId: null,
      candidateKey: candidate.candidateKey,
      category: candidate.category,
      question: candidate.question,
      intent: candidate.intent,
      intentRevision: 1,
      intentConfirmedRevision: null,
      intentConfirmedAt: null,
      intentConfirmedByUserId: null,
      rationale: candidate.rationale,
      evidence: candidate.evidence,
      risks: candidate.risks,
      source: "model",
      status: "candidate",
      selectionApprovalStatus: "not_requested",
      selectionRequestedAt: null,
      selectionRequestedByUserId: null,
      selectionApprovedAt: null,
      selectionApprovedByUserId: null,
      locked: false,
      sourceTaskId,
      knowledgeSnapshotId: input.knowledgeSnapshotId ?? null,
      ordinal: candidate.ordinal,
      revision: 1,
      selectedAt: null,
      archivedAt: null,
      createdByUserId: null,
      createdAt: archivedAt,
      updatedAt: archivedAt,
    }));
    await tx.insert(workspaceQuestions).values(rows);
    return rows.map(toPublicWorkspaceQuestion);
  });
}

export function assertQuestionSelectionWithinQuota(input: {
  limits: ServiceQuotaLimits;
  usage: ServiceQuotaUsage;
  category: WorkspaceQuestionCategory;
}): void {
  const category = workspaceQuestionCategorySchema.parse(input.category);
  const limitKey = SERVICE_QUESTION_CATEGORY_LIMIT_KEYS[category];
  const usageKey =
    category === "competitor_comparison"
      ? "competitorComparison"
      : category === "product_scenario"
        ? "productScenario"
        : category;
  if (input.usage[usageKey] >= input.limits[limitKey]) {
    throw new ServiceEntitlementError(
      "QUESTION_CATEGORY_QUOTA_EXCEEDED",
      "该类问题已达到当前服务周期的额度上限。",
    );
  }
  if (input.usage.total >= input.limits.totalQuestionLimit) {
    throw new ServiceEntitlementError(
      "QUESTION_TOTAL_QUOTA_EXCEEDED",
      "已达到当前服务周期的问题总额度。",
    );
  }
}

export async function listWorkspaceQuestions(input: {
  userId: number;
  quotaPeriodId?: string;
  includeArchived?: boolean;
}): Promise<ServicePortalQuestion[]> {
  const db = await requireServiceDb();
  const predicates = [eq(workspaceQuestions.userId, input.userId)];
  if (input.quotaPeriodId) {
    const periodRows = await db
      .select()
      .from(serviceQuotaPeriods)
      .where(
        and(
          eq(serviceQuotaPeriods.id, input.quotaPeriodId),
          eq(serviceQuotaPeriods.userId, input.userId),
        ),
      )
      .limit(1);
    const period = periodRows.find(isOperationalServiceQuotaPeriod);
    if (!period) return [];
    const contractRows = await db
      .select()
      .from(serviceContracts)
      .where(
        and(
          eq(serviceContracts.id, period.contractId),
          eq(serviceContracts.userId, input.userId),
        ),
      )
      .limit(1);
    const contract = contractRows[0];
    if (!contract) return [];
    const scope = resolveServiceQuestionQuotaScope(contract, period);
    predicates.push(
      scope.kind === "contract"
        ? eq(workspaceQuestions.contractId, scope.contractId)
        : eq(workspaceQuestions.quotaPeriodId, scope.periodId),
    );
  }
  if (!input.includeArchived) {
    predicates.push(
      inArray(workspaceQuestions.status, ["candidate", "selected"]),
    );
  }
  const rows = await db
    .select()
    .from(workspaceQuestions)
    .where(and(...predicates))
    .orderBy(
      desc(workspaceQuestions.updatedAt),
      asc(workspaceQuestions.ordinal),
    );
  return rows.map(toPublicWorkspaceQuestion);
}

export async function updateWorkspaceQuestionBySystemAdmin(input: {
  userId: number;
  questionId: string;
  expectedRevision: number;
  question?: string;
  intent?: string | null;
  rationale?: string | null;
  locked?: boolean;
  actorUserId: number;
}): Promise<ServicePortalQuestion> {
  if (
    input.question === undefined &&
    input.intent === undefined &&
    input.rationale === undefined &&
    input.locked === undefined
  ) {
    throw new ServiceEntitlementError(
      "QUESTION_GENERATION_CONFLICT",
      "没有可更新的候选问题字段。",
      400,
    );
  }
  const db = await requireServiceDb();
  return db.transaction(async (tx) => {
    const targetUsers = await tx
      .select({ id: users.id })
      .from(users)
      .where(eq(users.id, input.userId))
      .limit(1)
      .for("update");
    if (!targetUsers[0]) {
      throw new ServiceEntitlementError(
        "SERVICE_PLAN_UNCONFIGURED",
        "用户不存在。",
        404,
      );
    }
    const rows = await tx
      .select()
      .from(workspaceQuestions)
      .where(
        and(
          eq(workspaceQuestions.id, input.questionId),
          eq(workspaceQuestions.userId, input.userId),
        ),
      )
      .limit(1)
      .for("update");
    const current = rows[0];
    if (!current || current.status === "archived") {
      throw new ServiceEntitlementError(
        "QUESTION_NOT_FOUND",
        "候选问题不存在或已归档。",
        404,
      );
    }
    if (current.revision !== input.expectedRevision) {
      throw new ServiceEntitlementError(
        "QUESTION_REVISION_CONFLICT",
        "候选问题已更新，请刷新后重试。",
      );
    }
    if (
      current.selectionApprovalStatus === "pending" &&
      input.locked === true
    ) {
      throw new ServiceEntitlementError(
        "QUESTION_SELECTION_CONFIRMATION_REQUIRED",
        "待确认问题只能通过“确认启动”锁定并计入额度。",
        409,
      );
    }
    const updatedAt = new Date();
    const revision = current.revision + 1;
    const question =
      input.question === undefined
        ? current.question
        : normalizeCandidateText(input.question, "候选问题", 4_000);
    const intent =
      input.intent === undefined
        ? current.intent
        : normalizeOptionalCandidateText(input.intent, "问题意图", 16_000);
    const rationale =
      input.rationale === undefined
        ? current.rationale
        : normalizeOptionalCandidateText(input.rationale, "推荐理由", 16_000);
    const suggestionChanged =
      question !== current.question ||
      intent !== current.intent ||
      rationale !== current.rationale;
    const intentRevision = suggestionChanged
      ? current.intentRevision + 1
      : current.intentRevision;
    const values = {
      question,
      intent,
      intentRevision,
      intentConfirmedRevision: suggestionChanged
        ? null
        : current.intentConfirmedRevision,
      intentConfirmedAt: suggestionChanged ? null : current.intentConfirmedAt,
      intentConfirmedByUserId: suggestionChanged
        ? null
        : current.intentConfirmedByUserId,
      rationale,
      locked: input.locked ?? current.locked,
      createdByUserId: input.actorUserId,
      revision,
      updatedAt,
    };
    await tx
      .update(workspaceQuestions)
      .set(values)
      .where(
        and(
          eq(workspaceQuestions.id, current.id),
          eq(workspaceQuestions.revision, current.revision),
        ),
      );
    return toPublicWorkspaceQuestion({
      ...current,
      ...values,
    });
  });
}

export type WorkspaceQuestionBatchUpdate = {
  questionId: string;
  expectedRevision: number;
  category: WorkspaceQuestionCategory;
  question: string;
  intent: string | null;
  rationale: string | null;
};

type WorkspaceQuestionBatchTransactionHook = (
  tx: any,
  questions?: ServicePortalQuestion[],
) => Promise<void>;

/**
 * Applies a revision-bound current-content template to the authoritative
 * workspace question rows. Every row is locked and validated before the first
 * update. Optional hooks keep the import preflight and audit event in the same
 * transaction as the formal question changes.
 */
export async function updateWorkspaceQuestionsByAdminBatch(input: {
  userId: number;
  actorUserId: number;
  entries: WorkspaceQuestionBatchUpdate[];
  beforeWrite?: WorkspaceQuestionBatchTransactionHook;
  afterWrite?: WorkspaceQuestionBatchTransactionHook;
}): Promise<ServicePortalQuestion[]> {
  if (input.entries.length === 0) {
    throw new ServiceEntitlementError(
      "QUESTION_GENERATION_CONFLICT",
      "正式问题模板不能为空。",
      400,
    );
  }
  const questionIds = input.entries.map((entry) => entry.questionId);
  if (new Set(questionIds).size !== questionIds.length) {
    throw new ServiceEntitlementError(
      "QUESTION_GENERATION_CONFLICT",
      "正式问题模板包含重复问题。",
      400,
    );
  }
  const db = await requireServiceDb();
  return db.transaction(async (tx) => {
    const targetUsers = await tx
      .select({ id: users.id })
      .from(users)
      .where(eq(users.id, input.userId))
      .limit(1)
      .for("update");
    if (!targetUsers[0]) {
      throw new ServiceEntitlementError(
        "SERVICE_PLAN_UNCONFIGURED",
        "用户不存在。",
        404,
      );
    }
    await input.beforeWrite?.(tx);
    const rows = await tx
      .select()
      .from(workspaceQuestions)
      .where(
        and(
          eq(workspaceQuestions.userId, input.userId),
          inArray(workspaceQuestions.id, questionIds),
        ),
      )
      .for("update");
    const currentById = new Map(rows.map((row) => [row.id, row]));
    for (const entry of input.entries) {
      const current = currentById.get(entry.questionId);
      if (!current || current.status !== "selected") {
        throw new ServiceEntitlementError(
          "QUESTION_NOT_FOUND",
          `正式问题 ${entry.questionId} 不存在或不属于当前服务。`,
          404,
        );
      }
      if (current.revision !== entry.expectedRevision) {
        throw new ServiceEntitlementError(
          "QUESTION_REVISION_CONFLICT",
          `正式问题 ${entry.questionId} 已更新，请重新下载当前内容模板。`,
        );
      }
      if (current.category !== entry.category) {
        throw new ServiceEntitlementError(
          "QUESTION_GENERATION_CONFLICT",
          `正式问题 ${entry.questionId} 的问题类型不能通过内容模板修改。`,
          400,
        );
      }
    }

    const updatedAt = new Date();
    const updatedQuestions: ServicePortalQuestion[] = [];
    for (const entry of input.entries) {
      const current = currentById.get(entry.questionId)!;
      const question = normalizeCandidateText(
        entry.question,
        "正式问题",
        4_000,
      );
      const intent = normalizeOptionalCandidateText(
        entry.intent,
        "问题意图",
        16_000,
      );
      const rationale = normalizeOptionalCandidateText(
        entry.rationale,
        "推荐理由",
        16_000,
      );
      const changed =
        question !== current.question ||
        intent !== current.intent ||
        rationale !== current.rationale;
      if (!changed) continue;
      const revision = current.revision + 1;
      const values = {
        question,
        intent,
        intentRevision: current.intentRevision + 1,
        intentConfirmedRevision: null,
        intentConfirmedAt: null,
        intentConfirmedByUserId: null,
        rationale,
        createdByUserId: input.actorUserId,
        revision,
        updatedAt,
      };
      await tx
        .update(workspaceQuestions)
        .set(values)
        .where(
          and(
            eq(workspaceQuestions.id, current.id),
            eq(workspaceQuestions.userId, input.userId),
            eq(workspaceQuestions.revision, current.revision),
          ),
        );
      updatedQuestions.push(
        toPublicWorkspaceQuestion({
          ...current,
          ...values,
        }),
      );
    }
    if (updatedQuestions.length === 0) {
      throw new ServiceEntitlementError(
        "QUESTION_GENERATION_CONFLICT",
        "正式问题模板与当前内容一致，无需发布。",
        400,
      );
    }
    await input.afterWrite?.(tx, updatedQuestions);
    return updatedQuestions;
  });
}

export async function confirmWorkspaceQuestionIntent(input: {
  userId: number;
  questionId: string;
  expectedRevision: number;
  expectedIntentRevision: number;
  now?: Date;
}): Promise<ServicePortalQuestion> {
  const now = input.now ?? new Date();
  const portal = await assertServiceCapability(
    input.userId,
    "intentOptimization",
    { now },
  );
  const currentPortalQuestion = portal.purchasedQuestions.find(
    (question) => question.id === input.questionId,
  );
  if (!currentPortalQuestion) {
    throw new ServiceEntitlementError(
      "QUESTION_NOT_CURRENT",
      "只能确认当前有效服务周期内已选中的问题。",
      403,
    );
  }

  const db = await requireServiceDb();
  return db.transaction(async (tx) => {
    const targetUsers = await tx
      .select({ id: users.id })
      .from(users)
      .where(eq(users.id, input.userId))
      .limit(1)
      .for("update");
    if (!targetUsers[0]) {
      throw new ServiceEntitlementError(
        "SERVICE_PLAN_UNCONFIGURED",
        "用户不存在。",
        404,
      );
    }

    const initialRows = await tx
      .select()
      .from(workspaceQuestions)
      .where(
        and(
          eq(workspaceQuestions.id, input.questionId),
          eq(workspaceQuestions.userId, input.userId),
        ),
      )
      .limit(1);
    const initialQuestion = initialRows[0];
    if (!initialQuestion || initialQuestion.status !== "selected") {
      throw new ServiceEntitlementError(
        "QUESTION_NOT_CURRENT",
        "只能确认当前有效服务周期内已选中的问题。",
        403,
      );
    }

    const periodRows = await tx
      .select()
      .from(serviceQuotaPeriods)
      .where(
        and(
          eq(serviceQuotaPeriods.id, initialQuestion.quotaPeriodId),
          eq(serviceQuotaPeriods.userId, input.userId),
        ),
      )
      .limit(1)
      .for("update");
    const period = periodRows[0];
    if (!period || period.contractId !== initialQuestion.contractId) {
      throw new ServiceEntitlementError(
        "QUESTION_NOT_CURRENT",
        "问题所属额度周期不存在或已失效。",
        403,
      );
    }

    const questionRows = await tx
      .select()
      .from(workspaceQuestions)
      .where(
        and(
          eq(workspaceQuestions.id, input.questionId),
          eq(workspaceQuestions.userId, input.userId),
        ),
      )
      .limit(1)
      .for("update");
    const question = questionRows[0];
    if (
      !question ||
      question.status !== "selected" ||
      question.contractId !== currentPortalQuestion.contractId ||
      question.quotaPeriodId !== currentPortalQuestion.quotaPeriodId ||
      period.contractId !== question.contractId
    ) {
      throw new ServiceEntitlementError(
        "QUESTION_NOT_CURRENT",
        "问题已不属于当前有效服务周期，请刷新后重试。",
        403,
      );
    }

    const contractRows = await tx
      .select()
      .from(serviceContracts)
      .where(
        and(
          eq(serviceContracts.id, question.contractId),
          eq(serviceContracts.userId, input.userId),
        ),
      )
      .limit(1)
      .for("update");
    const contract = contractRows[0];
    if (!contract) {
      throw new ServiceEntitlementError(
        "QUESTION_NOT_CURRENT",
        "问题所属服务合同不存在。",
        403,
      );
    }
    const status = deriveEffectiveServiceStatus(
      contract as ServicePortalContractRecord,
      now,
    );
    if (status !== "active") {
      throw new ServiceEntitlementError(
        status === "suspended"
          ? "SERVICE_PLAN_SUSPENDED"
          : status === "pending_confirmation"
            ? "SERVICE_PLAN_PENDING_CONFIRMATION"
            : status === "scheduled"
              ? "SERVICE_PLAN_NOT_STARTED"
              : "SERVICE_PLAN_EXPIRED",
        capabilityReason(status, false) ?? "当前服务不可编辑。",
        403,
      );
    }
    if (
      !isProgressiveLuxuryContract(contract) &&
      (period.startsAt.getTime() > now.getTime() ||
        period.endsAt.getTime() <= now.getTime())
    ) {
      throw new ServiceEntitlementError(
        "QUESTION_NOT_CURRENT",
        "当前问题不在有效额度周期内。",
        403,
      );
    }
    if (question.revision !== input.expectedRevision) {
      throw new ServiceEntitlementError(
        "QUESTION_REVISION_CONFLICT",
        "问题已更新，请刷新后重新确认。",
      );
    }
    if (question.intentRevision !== input.expectedIntentRevision) {
      throw new ServiceEntitlementError(
        "QUESTION_INTENT_REVISION_CONFLICT",
        "问题优化建议已更新，请阅读最新版本后重新确认。",
      );
    }
    if (!question.intent?.trim()) {
      throw new ServiceEntitlementError(
        "QUESTION_INTENT_NOT_READY",
        "当前问题尚无可确认的优化建议，请等待服务团队补充。",
      );
    }
    if (isWorkspaceQuestionIntentExplicitlyConfirmed(question)) {
      return toPublicWorkspaceQuestion(question);
    }

    const revision = question.revision + 1;
    await tx
      .update(workspaceQuestions)
      .set({
        intentConfirmedRevision: question.intentRevision,
        intentConfirmedAt: now,
        intentConfirmedByUserId: input.userId,
        revision,
        updatedAt: now,
      })
      .where(
        and(
          eq(workspaceQuestions.id, question.id),
          eq(workspaceQuestions.revision, question.revision),
          eq(workspaceQuestions.intentRevision, question.intentRevision),
        ),
      );
    return toPublicWorkspaceQuestion({
      ...question,
      intentConfirmedRevision: question.intentRevision,
      intentConfirmedAt: now,
      intentConfirmedByUserId: input.userId,
      revision,
      updatedAt: now,
    });
  });
}

type WorkspaceQuestionSelectionRequest =
  | {
      userId: number;
      actorUserId: number;
      questionId: string;
      expectedRevision: number;
      question?: never;
      category?: never;
      classificationVersion?: never;
      now?: Date;
    }
  | {
      userId: number;
      actorUserId: number;
      question: string;
      category: WorkspaceQuestionCategory;
      classificationVersion?: never;
      questionId?: never;
      expectedRevision?: never;
      now?: Date;
    }
  | {
      userId: number;
      actorUserId: number;
      question: string;
      classificationVersion: 2;
      category?: never;
      questionId?: never;
      expectedRevision?: never;
      now?: Date;
    };

export type WorkspaceQuestionTransactionHook = (
  executor: any,
  question: WorkspaceQuestion,
) => Promise<void>;

function comparableQuestionText(value: string) {
  return value.normalize("NFKC").trim().replace(/\s+/g, " ");
}

function mutationAffectedRows(value: unknown) {
  const header = Array.isArray(value) ? value[0] : value;
  return Number(
    (header as { affectedRows?: number } | null)?.affectedRows ?? 0,
  );
}

export function countReservedQuestionUsage(
  questions: Array<
    Pick<
      WorkspaceQuestion,
      | "quotaPeriodId"
      | "status"
      | "selectionApprovalStatus"
      | "candidateKey"
      | "category"
      | "source"
    > &
      Partial<Pick<WorkspaceQuestion, "contractId">>
  >,
  quotaPeriodIdOrScope: string | ServiceQuestionQuotaScope,
  options?: { reserveUnclassifiedAcrossCategories?: boolean },
): ServiceQuotaUsage {
  const usage: ServiceQuotaUsage = { ...EMPTY_SERVICE_QUOTA_USAGE };
  const scope =
    typeof quotaPeriodIdOrScope === "string"
      ? ({ kind: "period", periodId: quotaPeriodIdOrScope } as const)
      : quotaPeriodIdOrScope;
  for (const question of questions) {
    if (
      !isQuestionInServiceQuotaScope(question, scope) ||
      (question.status !== "selected" &&
        question.selectionApprovalStatus !== "pending")
    ) {
      continue;
    }
    usage.total += 1;
    if (isUserQuestionPendingClassification(question)) {
      if (options?.reserveUnclassifiedAcrossCategories) {
        usage.industry += 1;
        usage.competitorComparison += 1;
        usage.reputation += 1;
        usage.productScenario += 1;
      }
      continue;
    }
    if (question.category === "competitor_comparison") {
      usage.competitorComparison += 1;
    } else if (question.category === "product_scenario") {
      usage.productScenario += 1;
    } else if (
      question.category === "industry" ||
      question.category === "reputation"
    ) {
      usage[question.category] += 1;
    }
  }
  return usage;
}

export function resolveWorkspaceQuestionApprovalCategory(input: {
  currentCategory: WorkspaceQuestionCategory | null;
  requestedCategory?: WorkspaceQuestionCategory;
}): WorkspaceQuestionCategory {
  if (
    input.currentCategory &&
    input.requestedCategory &&
    input.currentCategory !== input.requestedCategory
  ) {
    throw new ServiceEntitlementError(
      "QUESTION_GENERATION_CONFLICT",
      "已分类问题不能在审核时改为其他问题类型。",
      409,
    );
  }
  const category = input.currentCategory ?? input.requestedCategory;
  if (!category) {
    throw new ServiceEntitlementError(
      "QUESTION_SELECTION_CONFIRMATION_REQUIRED",
      "自主填写的问题必须先由服务团队选择问题类型。",
      409,
    );
  }
  return category;
}

function assertQuestionSelectionWithinTotalQuota(input: {
  limits: ServiceQuotaLimits;
  usage: ServiceQuotaUsage;
}) {
  if (input.usage.total >= input.limits.totalQuestionLimit) {
    throw new ServiceEntitlementError(
      "QUESTION_TOTAL_QUOTA_EXCEEDED",
      "已达到当前服务周期的问题总额度。",
    );
  }
}

/**
 * Records a user's choice without consuming the authoritative service quota.
 * Pending requests are soft-reserved so concurrent submissions cannot exceed
 * the purchased limits. Only an assigned administrator's later approval moves
 * the row to selected+approved and makes it count in portal quota usage.
 */
export async function requestWorkspaceQuestionSelection(
  input: WorkspaceQuestionSelectionRequest,
  options?: { afterWrite?: WorkspaceQuestionTransactionHook },
): Promise<ServicePortalQuestion> {
  if (
    "question" in input &&
    input.classificationVersion === 2 &&
    !QUESTION_CLASSIFICATION_V2_WRITES_ENABLED
  ) {
    throw new ServiceEntitlementError(
      "QUESTION_NOT_CURRENT",
      "问题分类能力正在升级，请稍后重试。",
      503,
    );
  }
  const now = input.now ?? new Date();
  const portal = await assertServiceCapability(
    input.userId,
    "questionSelection",
    { now },
  );
  const currentPeriod = portal.quotas;
  if (!currentPeriod || !portal.service.contractId) {
    throw new ServiceEntitlementError(
      "QUOTA_PERIOD_NOT_FOUND",
      "当前服务周期尚未建立问题额度。",
      404,
    );
  }

  const db = await requireServiceDb();
  return db.transaction(async (tx) => {
    const pendingClassificationV2 =
      "question" in input && input.classificationVersion === 2;
    const targetUsers = await tx
      .select({ id: users.id })
      .from(users)
      .where(eq(users.id, input.userId))
      .limit(1)
      .for("update");
    if (!targetUsers[0]) {
      throw new ServiceEntitlementError(
        "SERVICE_PLAN_UNCONFIGURED",
        "用户不存在。",
        404,
      );
    }

    const periodRows = await tx
      .select()
      .from(serviceQuotaPeriods)
      .where(
        and(
          eq(serviceQuotaPeriods.id, currentPeriod.periodId),
          eq(serviceQuotaPeriods.userId, input.userId),
        ),
      )
      .limit(1)
      .for("update");
    const period = periodRows.find(isOperationalServiceQuotaPeriod);
    if (!period) {
      throw new ServiceEntitlementError(
        "QUOTA_PERIOD_NOT_FOUND",
        "当前问题额度周期不存在。",
        404,
      );
    }

    const contractRows = await tx
      .select()
      .from(serviceContracts)
      .where(
        and(
          eq(serviceContracts.id, period.contractId),
          eq(serviceContracts.userId, input.userId),
        ),
      )
      .limit(1)
      .for("update");
    const contract = contractRows[0];
    if (
      !contract ||
      deriveEffectiveServiceStatus(
        contract as ServicePortalContractRecord,
        now,
      ) !== "active" ||
      period.startsAt.getTime() > now.getTime() ||
      period.endsAt.getTime() <= now.getTime()
    ) {
      throw new ServiceEntitlementError(
        "QUESTION_NOT_CURRENT",
        "当前问题额度周期已失效，请刷新服务状态后重试。",
        403,
      );
    }

    const questionStoragePeriod = await loadServiceQuestionStoragePeriod({
      executor: tx,
      userId: input.userId,
      contract,
      operationalPeriod: period,
    });
    if (!questionStoragePeriod) {
      throw new ServiceEntitlementError(
        "QUOTA_PERIOD_NOT_FOUND",
        "当前问题额度兼容锚点不存在，请联系服务团队。",
        404,
      );
    }

    const quotaScope = resolveServiceQuestionQuotaScope(contract, period);
    const activeRows = await tx
      .select()
      .from(workspaceQuestions)
      .where(
        and(
          eq(workspaceQuestions.userId, input.userId),
          quotaScope.kind === "contract"
            ? eq(workspaceQuestions.contractId, quotaScope.contractId)
            : eq(workspaceQuestions.quotaPeriodId, quotaScope.periodId),
          inArray(workspaceQuestions.status, ["candidate", "selected"]),
        ),
      )
      .for("update");

    let question: WorkspaceQuestion | undefined;
    if ("questionId" in input) {
      question = activeRows.find((row) => row.id === input.questionId);
      if (
        !question ||
        question.contractId !== period.contractId ||
        question.status === "archived" ||
        (question.status === "candidate" &&
          question.selectionApprovalStatus !== "pending" &&
          question.quotaPeriodId !== questionStoragePeriod.id)
      ) {
        throw new ServiceEntitlementError(
          "QUESTION_NOT_FOUND",
          "候选问题不存在、已被替换或不属于当前服务周期。",
          404,
        );
      }
      if (question.status === "selected") {
        return toPublicWorkspaceQuestion(question);
      }
      if (question.selectionApprovalStatus === "pending") {
        await options?.afterWrite?.(tx, question);
        return toPublicWorkspaceQuestion(question);
      }
      if (question.revision !== input.expectedRevision) {
        throw new ServiceEntitlementError(
          "QUESTION_REVISION_CONFLICT",
          "候选问题已更新，请刷新后重试。",
        );
      }
    } else {
      const normalizedQuestion = normalizeCandidateText(
        input.question,
        "目标问题",
        4_000,
      );
      const comparable = comparableQuestionText(normalizedQuestion);
      const comparableRows = activeRows.filter(
        (row) => comparableQuestionText(row.question) === comparable,
      );
      const duplicate =
        comparableRows.find(
          (row) =>
            row.status === "selected" ||
            row.selectionApprovalStatus === "pending",
        ) ??
        comparableRows.find(
          (row) => row.quotaPeriodId === questionStoragePeriod.id,
        );
      if (duplicate?.status === "selected") {
        return toPublicWorkspaceQuestion(duplicate);
      }
      if (
        duplicate?.selectionApprovalStatus === "pending" &&
        duplicate.source === "user"
      ) {
        await options?.afterWrite?.(tx, duplicate);
        return toPublicWorkspaceQuestion(duplicate);
      }
      if (duplicate) {
        question = duplicate;
      } else {
        question = {
          id: randomUUID(),
          userId: input.userId,
          contractId: period.contractId,
          quotaPeriodId: questionStoragePeriod.id,
          externalQuestionId: null,
          sourceQuestionId: null,
          candidateKey: pendingClassificationV2
            ? UNCLASSIFIED_QUESTION_CANDIDATE_KEY
            : null,
          category: pendingClassificationV2
            ? UNCLASSIFIED_QUESTION_STORAGE_CATEGORY
            : workspaceQuestionCategorySchema.parse(input.category),
          question: normalizedQuestion,
          intent: null,
          intentRevision: 1,
          intentConfirmedRevision: null,
          intentConfirmedAt: null,
          intentConfirmedByUserId: null,
          rationale: null,
          evidence: [],
          risks: [],
          source: "user",
          status: "candidate",
          selectionApprovalStatus: "not_requested",
          selectionRequestedAt: null,
          selectionRequestedByUserId: null,
          selectionApprovedAt: null,
          selectionApprovedByUserId: null,
          locked: false,
          sourceTaskId: null,
          knowledgeSnapshotId: null,
          ordinal: activeRows.length,
          revision: 1,
          selectedAt: null,
          archivedAt: null,
          createdByUserId: input.actorUserId,
          createdAt: now,
          updatedAt: now,
        };
      }
    }

    const limits = resolveEffectiveServiceQuestionQuotaLimits({
      contract,
      period,
      now,
    });
    const questionAlreadyExists = activeRows.some(
      (row) => row.id === question!.id,
    );
    const reservedUsage = countReservedQuestionUsage(
      questionAlreadyExists
        ? activeRows.filter((row) => row.id !== question!.id)
        : activeRows,
      quotaScope,
      {
        reserveUnclassifiedAcrossCategories:
          isProgressiveLuxuryContract(contract),
      },
    );
    if ("questionId" in input) {
      const category = workspaceQuestionCategorySchema.parse(question.category);
      assertQuestionSelectionWithinQuota({
        limits,
        usage: reservedUsage,
        category,
      });
    } else if (pendingClassificationV2) {
      assertQuestionSelectionWithinTotalQuota({ limits, usage: reservedUsage });
      if (isProgressiveLuxuryContract(contract)) {
        for (const category of [
          "industry",
          "competitor_comparison",
          "reputation",
          "product_scenario",
        ] as const) {
          assertQuestionSelectionWithinQuota({
            limits,
            usage: reservedUsage,
            category,
          });
        }
      }
    } else {
      assertQuestionSelectionWithinQuota({
        limits,
        usage: reservedUsage,
        category: workspaceQuestionCategorySchema.parse(input.category),
      });
    }

    if (questionAlreadyExists) {
      const revision = question.revision + 1;
      await tx
        .update(workspaceQuestions)
        .set({
          ...("question" in input
            ? {
                candidateKey: pendingClassificationV2
                  ? UNCLASSIFIED_QUESTION_CANDIDATE_KEY
                  : null,
                category: pendingClassificationV2
                  ? UNCLASSIFIED_QUESTION_STORAGE_CATEGORY
                  : workspaceQuestionCategorySchema.parse(input.category),
                question: normalizeCandidateText(
                  input.question!,
                  "目标问题",
                  4_000,
                ),
                source: "user" as const,
              }
            : {}),
          selectionApprovalStatus: "pending",
          selectionRequestedAt: now,
          selectionRequestedByUserId: input.actorUserId,
          selectionApprovedAt: null,
          selectionApprovedByUserId: null,
          revision,
          updatedAt: now,
        })
        .where(
          and(
            eq(workspaceQuestions.id, question.id),
            eq(workspaceQuestions.revision, question.revision),
          ),
        );
      const updatedQuestion: WorkspaceQuestion = {
        ...question,
        ...("question" in input
          ? {
              candidateKey: pendingClassificationV2
                ? UNCLASSIFIED_QUESTION_CANDIDATE_KEY
                : null,
              category: pendingClassificationV2
                ? UNCLASSIFIED_QUESTION_STORAGE_CATEGORY
                : workspaceQuestionCategorySchema.parse(input.category),
              question: normalizeCandidateText(
                input.question!,
                "目标问题",
                4_000,
              ),
              source: "user" as const,
            }
          : {}),
        selectionApprovalStatus: "pending",
        selectionRequestedAt: now,
        selectionRequestedByUserId: input.actorUserId,
        revision,
        updatedAt: now,
      };
      await options?.afterWrite?.(tx, updatedQuestion);
      return toPublicWorkspaceQuestion(updatedQuestion);
    }

    const pendingQuestion: WorkspaceQuestion = {
      ...question,
      selectionApprovalStatus: "pending",
      selectionRequestedAt: now,
      selectionRequestedByUserId: input.actorUserId,
    };
    await tx.insert(workspaceQuestions).values(pendingQuestion);
    await options?.afterWrite?.(tx, pendingQuestion);
    return toPublicWorkspaceQuestion(pendingQuestion);
  });
}

/**
 * Confirms one question from the immutable coordinates of the currently
 * published brand keyword library. The published row is re-read while the
 * quota period is locked, so neither question text nor category is trusted
 * from the browser and selection is atomic with quota consumption.
 */
export async function confirmWorkspaceBrandKeywordSelection(
  input: BrandKeywordSelectionReference & {
    userId: number;
    actorUserId: number;
    expectedQuestion: string;
    expectedCategory: WorkspaceQuestionCategory;
    now?: Date;
  },
  options?: { afterWrite?: WorkspaceQuestionTransactionHook },
): Promise<ServicePortalQuestion> {
  const now = input.now ?? new Date();
  const portal = await assertServiceCapability(
    input.userId,
    "questionSelection",
    { now },
  );
  const currentPeriod = portal.quotas;
  if (!currentPeriod || !portal.service.contractId) {
    throw new ServiceEntitlementError(
      "QUOTA_PERIOD_NOT_FOUND",
      "当前服务周期尚未建立问题额度。",
      404,
    );
  }

  const db = await requireServiceDb();
  return db.transaction(async (tx) => {
    const targetUsers = await tx
      .select({ id: users.id })
      .from(users)
      .where(eq(users.id, input.userId))
      .limit(1)
      .for("update");
    if (!targetUsers[0]) {
      throw new ServiceEntitlementError(
        "SERVICE_PLAN_UNCONFIGURED",
        "用户不存在。",
        404,
      );
    }

    const periodRows = await tx
      .select()
      .from(serviceQuotaPeriods)
      .where(
        and(
          eq(serviceQuotaPeriods.id, currentPeriod.periodId),
          eq(serviceQuotaPeriods.userId, input.userId),
        ),
      )
      .limit(1)
      .for("update");
    const period = periodRows.find(isOperationalServiceQuotaPeriod);
    if (!period) {
      throw new ServiceEntitlementError(
        "QUOTA_PERIOD_NOT_FOUND",
        "当前问题额度周期不存在。",
        404,
      );
    }

    const contractRows = await tx
      .select()
      .from(serviceContracts)
      .where(
        and(
          eq(serviceContracts.id, period.contractId),
          eq(serviceContracts.userId, input.userId),
        ),
      )
      .limit(1)
      .for("update");
    const contract = contractRows[0];
    if (
      !contract ||
      deriveEffectiveServiceStatus(
        contract as ServicePortalContractRecord,
        now,
      ) !== "active" ||
      period.startsAt.getTime() > now.getTime() ||
      period.endsAt.getTime() <= now.getTime()
    ) {
      throw new ServiceEntitlementError(
        "QUESTION_NOT_CURRENT",
        "当前问题额度周期已失效，请刷新服务状态后重试。",
        403,
      );
    }

    const questionStoragePeriod = await loadServiceQuestionStoragePeriod({
      executor: tx,
      userId: input.userId,
      contract,
      operationalPeriod: period,
    });
    if (!questionStoragePeriod) {
      throw new ServiceEntitlementError(
        "QUOTA_PERIOD_NOT_FOUND",
        "当前问题额度兼容锚点不存在，请联系服务团队。",
        404,
      );
    }

    const dashboardRows = await tx
      .select({
        revision: userDashboardContents.revision,
        payload: userDashboardContents.payload,
      })
      .from(userDashboardContents)
      .where(eq(userDashboardContents.userId, input.userId))
      .limit(1)
      .for("update");
    const dashboard = dashboardRows[0];
    const parsedPayload = dashboardPayloadSchema.safeParse(dashboard?.payload);
    if (!dashboard || !parsedPayload.success) {
      throw new ServiceEntitlementError(
        "QUESTION_NOT_CURRENT",
        "品牌全域词库尚未发布，请刷新后重试。",
        409,
      );
    }
    const resolved = resolveBrandKeywordSelection({
      workspace: {
        revision: dashboard.revision,
        payload: parsedPayload.data,
      },
      reference: input,
    });
    if (!resolved.ok) {
      throw new ServiceEntitlementError(
        "QUESTION_NOT_CURRENT",
        resolved.message,
      );
    }
    if (
      comparableQuestionText(resolved.selection.question) !==
        comparableQuestionText(input.expectedQuestion) ||
      resolved.selection.category !== input.expectedCategory
    ) {
      throw new ServiceEntitlementError(
        "QUESTION_NOT_CURRENT",
        "品牌全域词库已更新，请刷新后重新选择。",
      );
    }

    const quotaScope = resolveServiceQuestionQuotaScope(contract, period);
    const activeRows = await tx
      .select()
      .from(workspaceQuestions)
      .where(
        and(
          eq(workspaceQuestions.userId, input.userId),
          quotaScope.kind === "contract"
            ? eq(workspaceQuestions.contractId, quotaScope.contractId)
            : eq(workspaceQuestions.quotaPeriodId, quotaScope.periodId),
          inArray(workspaceQuestions.status, ["candidate", "selected"]),
        ),
      )
      .for("update");
    const canonicalCandidateKey = `brand-keyword:${input.tableId}:${input.rowIndex}`;
    const canonicalSourceTaskId = `dashboard:${input.dashboardRevision}`;
    const generationRows = await tx
      .select()
      .from(workspaceQuestions)
      .where(
        and(
          eq(workspaceQuestions.userId, input.userId),
          eq(workspaceQuestions.quotaPeriodId, questionStoragePeriod.id),
          eq(workspaceQuestions.sourceTaskId, canonicalSourceTaskId),
          eq(workspaceQuestions.candidateKey, canonicalCandidateKey),
        ),
      )
      .for("update");
    const comparable = comparableQuestionText(resolved.selection.question);
    const comparableRows = activeRows.filter(
      (row) => comparableQuestionText(row.question) === comparable,
    );
    const existing =
      comparableRows.find(
        (row) =>
          row.status === "selected" ||
          row.selectionApprovalStatus === "pending",
      ) ??
      comparableRows.find(
        (row) => row.quotaPeriodId === questionStoragePeriod.id,
      );
    const canonicalGeneration = generationRows[0];
    if (
      generationRows.length > 1 ||
      (canonicalGeneration?.status !== undefined &&
        canonicalGeneration.status !== "archived" &&
        canonicalGeneration.id !== existing?.id)
    ) {
      throw new ServiceEntitlementError(
        "QUESTION_GENERATION_CONFLICT",
        "该品牌词库问题已有其他活动记录，请刷新后重试。",
      );
    }
    if (existing?.status === "selected") {
      if (existing.category !== resolved.selection.category) {
        throw new ServiceEntitlementError(
          "QUESTION_GENERATION_CONFLICT",
          "该问题已按其他类型进入服务，请联系服务团队处理。",
        );
      }
      await options?.afterWrite?.(tx, existing);
      return toPublicWorkspaceQuestion(existing);
    }

    const limits = resolveEffectiveServiceQuestionQuotaLimits({
      contract,
      period,
      now,
    });
    const reservedUsage = countReservedQuestionUsage(
      existing
        ? activeRows.filter((question) => question.id !== existing.id)
        : activeRows,
      quotaScope,
      {
        reserveUnclassifiedAcrossCategories:
          isProgressiveLuxuryContract(contract),
      },
    );
    assertQuestionSelectionWithinQuota({
      limits,
      usage: reservedUsage,
      category: resolved.selection.category,
    });

    const selectedAt = now;
    if (existing) {
      const revision = existing.revision + 1;
      const values = {
        category: resolved.selection.category,
        question: resolved.selection.question,
        source: "admin" as const,
        status: "selected" as const,
        selectionApprovalStatus: "approved" as const,
        selectionRequestedAt: existing.selectionRequestedAt ?? selectedAt,
        selectionRequestedByUserId:
          existing.selectionRequestedByUserId ?? input.actorUserId,
        selectionApprovedAt: selectedAt,
        selectionApprovedByUserId: input.actorUserId,
        locked: true,
        selectedAt,
        revision,
        updatedAt: selectedAt,
      };
      await tx
        .update(workspaceQuestions)
        .set(values)
        .where(
          and(
            eq(workspaceQuestions.id, existing.id),
            eq(workspaceQuestions.revision, existing.revision),
          ),
        );
      const updatedQuestion: WorkspaceQuestion = { ...existing, ...values };
      await options?.afterWrite?.(tx, updatedQuestion);
      return toPublicWorkspaceQuestion(updatedQuestion);
    }

    if (canonicalGeneration?.status === "archived") {
      const retiredCandidateKey = `${canonicalCandidateKey}:archived:${canonicalGeneration.id}`;
      const retirementResult = await tx
        .update(workspaceQuestions)
        .set({
          candidateKey: retiredCandidateKey,
          revision: canonicalGeneration.revision + 1,
          updatedAt: selectedAt,
        })
        .where(
          and(
            eq(workspaceQuestions.id, canonicalGeneration.id),
            eq(workspaceQuestions.userId, input.userId),
            eq(workspaceQuestions.quotaPeriodId, questionStoragePeriod.id),
            eq(workspaceQuestions.sourceTaskId, canonicalSourceTaskId),
            eq(workspaceQuestions.candidateKey, canonicalCandidateKey),
            eq(workspaceQuestions.status, "archived"),
            eq(workspaceQuestions.revision, canonicalGeneration.revision),
          ),
        );
      if (mutationAffectedRows(retirementResult) !== 1) {
        throw new ServiceEntitlementError(
          "QUESTION_GENERATION_CONFLICT",
          "品牌词库历史记录已更新，请刷新后重试。",
        );
      }
    }

    const question: WorkspaceQuestion = {
      id: randomUUID(),
      userId: input.userId,
      contractId: period.contractId,
      quotaPeriodId: questionStoragePeriod.id,
      externalQuestionId: null,
      sourceQuestionId: null,
      candidateKey: canonicalCandidateKey,
      category: resolved.selection.category,
      question: resolved.selection.question,
      intent: null,
      intentRevision: 1,
      intentConfirmedRevision: null,
      intentConfirmedAt: null,
      intentConfirmedByUserId: null,
      rationale: null,
      evidence: [],
      risks: [],
      source: "admin",
      status: "selected",
      selectionApprovalStatus: "approved",
      selectionRequestedAt: selectedAt,
      selectionRequestedByUserId: input.actorUserId,
      selectionApprovedAt: selectedAt,
      selectionApprovedByUserId: input.actorUserId,
      locked: true,
      sourceTaskId: canonicalSourceTaskId,
      knowledgeSnapshotId: null,
      ordinal: activeRows.length,
      revision: 1,
      selectedAt,
      archivedAt: null,
      createdByUserId: input.actorUserId,
      createdAt: selectedAt,
      updatedAt: selectedAt,
    };
    await tx.insert(workspaceQuestions).values(question);
    await options?.afterWrite?.(tx, question);
    return toPublicWorkspaceQuestion(question);
  });
}

export async function approveWorkspaceQuestionSelection(
  input: {
    userId: number;
    questionId: string;
    expectedRevision: number;
    actorUserId: number;
    category?: WorkspaceQuestionCategory;
    now?: Date;
  },
  options?: {
    executor?: any;
    afterWrite?: WorkspaceQuestionTransactionHook;
  },
): Promise<ServicePortalQuestion> {
  const now = input.now ?? new Date();
  const execute = async (tx: any) => {
    const targetUsers = await tx
      .select({ id: users.id })
      .from(users)
      .where(eq(users.id, input.userId))
      .limit(1)
      .for("update");
    if (!targetUsers[0]) {
      throw new ServiceEntitlementError(
        "SERVICE_PLAN_UNCONFIGURED",
        "用户不存在。",
        404,
      );
    }
    const candidateRows = await tx
      .select()
      .from(workspaceQuestions)
      .where(
        and(
          eq(workspaceQuestions.id, input.questionId),
          eq(workspaceQuestions.userId, input.userId),
        ),
      )
      .limit(1);
    const candidate = candidateRows[0];
    if (!candidate || candidate.status === "archived") {
      throw new ServiceEntitlementError(
        "QUESTION_NOT_FOUND",
        "候选问题不存在或已被替换。",
        404,
      );
    }
    const contractPreviewRows = await tx
      .select()
      .from(serviceContracts)
      .where(
        and(
          eq(serviceContracts.id, candidate.contractId),
          eq(serviceContracts.userId, input.userId),
        ),
      )
      .limit(1);
    const contractPreview = contractPreviewRows[0];
    if (!contractPreview) {
      throw new ServiceEntitlementError(
        "QUOTA_PERIOD_NOT_FOUND",
        "当前问题额度周期不存在。",
        404,
      );
    }
    const progressiveScope = isProgressiveLuxuryContract(contractPreview);
    const periodRows = await tx
      .select()
      .from(serviceQuotaPeriods)
      .where(
        and(
          eq(serviceQuotaPeriods.userId, input.userId),
          progressiveScope
            ? and(
                eq(serviceQuotaPeriods.contractId, candidate.contractId),
                gt(
                  serviceQuotaPeriods.ordinal,
                  SERVICE_QUESTION_QUOTA_ANCHOR_ORDINAL,
                ),
                lte(serviceQuotaPeriods.startsAt, now),
                gt(serviceQuotaPeriods.endsAt, now),
              )
            : eq(serviceQuotaPeriods.id, candidate.quotaPeriodId),
        ),
      )
      .orderBy(asc(serviceQuotaPeriods.ordinal))
      .limit(1)
      .for("update");
    const period = periodRows.find(isOperationalServiceQuotaPeriod);
    if (!period || period.contractId !== contractPreview.id) {
      throw new ServiceEntitlementError(
        "QUOTA_PERIOD_NOT_FOUND",
        "当前问题额度周期不存在。",
        404,
      );
    }
    const contractRows = await tx
      .select()
      .from(serviceContracts)
      .where(
        and(
          eq(serviceContracts.id, period.contractId),
          eq(serviceContracts.userId, input.userId),
        ),
      )
      .limit(1)
      .for("update");
    const contract = contractRows[0];
    if (!contract) {
      throw new ServiceEntitlementError(
        "QUOTA_PERIOD_NOT_FOUND",
        "当前问题额度周期不存在。",
        404,
      );
    }
    if (
      contract.id !== contractPreview.id ||
      contract.planVersion !== contractPreview.planVersion
    ) {
      throw new ServiceEntitlementError(
        "QUESTION_NOT_CURRENT",
        "当前服务合同已变化，请刷新后重试。",
      );
    }
    // Selection requests, trusted keyword confirmation and approval all lock
    // user -> quota period -> contract -> active questions in the same order.
    const quotaScope = resolveServiceQuestionQuotaScope(contract, period);
    const activeRows = await tx
      .select()
      .from(workspaceQuestions)
      .where(
        and(
          eq(workspaceQuestions.userId, input.userId),
          quotaScope.kind === "contract"
            ? eq(workspaceQuestions.contractId, quotaScope.contractId)
            : eq(workspaceQuestions.quotaPeriodId, quotaScope.periodId),
          inArray(workspaceQuestions.status, ["candidate", "selected"]),
        ),
      )
      .for("update");
    const question = activeRows.find(
      (row: WorkspaceQuestion) => row.id === input.questionId,
    );
    if (!question || question.contractId !== period.contractId) {
      throw new ServiceEntitlementError(
        "QUESTION_NOT_FOUND",
        "候选问题不存在或已被替换。",
        404,
      );
    }
    if (question.status === "selected") {
      await options?.afterWrite?.(tx, question);
      return toPublicWorkspaceQuestion(question);
    }
    if (question.selectionApprovalStatus !== "pending") {
      throw new ServiceEntitlementError(
        "QUESTION_SELECTION_CONFIRMATION_REQUIRED",
        "该问题尚未由用户提交专业审核。",
        409,
      );
    }
    if (question.revision !== input.expectedRevision) {
      throw new ServiceEntitlementError(
        "QUESTION_REVISION_CONFLICT",
        "候选问题已更新，请刷新后重试。",
      );
    }
    const parsedCategory = isUserQuestionPendingClassification(question)
      ? null
      : workspaceQuestionCategorySchema.safeParse(question.category);
    const category = resolveWorkspaceQuestionApprovalCategory({
      currentCategory:
        parsedCategory === null
          ? null
          : parsedCategory.success
            ? parsedCategory.data
            : null,
      requestedCategory: input.category,
    });
    const status = deriveEffectiveServiceStatus(
      contract as ServicePortalContractRecord,
      now,
    );
    if (status !== "active") {
      const codes: Partial<
        Record<EffectiveServiceStatus, ServiceEntitlementErrorCode>
      > = {
        unconfigured: "SERVICE_PLAN_UNCONFIGURED",
        pending_confirmation: "SERVICE_PLAN_PENDING_CONFIRMATION",
        scheduled: "SERVICE_PLAN_NOT_STARTED",
        suspended: "SERVICE_PLAN_SUSPENDED",
        expired: "SERVICE_PLAN_EXPIRED",
        cancelled: "SERVICE_PLAN_EXPIRED",
      };
      throw new ServiceEntitlementError(
        codes[status] ?? "SERVICE_PLAN_EXPIRED",
        capabilityReason(status, false) ?? "当前服务不可用。",
        403,
      );
    }
    if (
      period.startsAt.getTime() > now.getTime() ||
      period.endsAt.getTime() <= now.getTime()
    ) {
      throw new ServiceEntitlementError(
        "QUOTA_PERIOD_NOT_FOUND",
        "当前问题不在有效额度周期内。",
      );
    }
    const limits = resolveEffectiveServiceQuestionQuotaLimits({
      contract,
      period,
      now,
    });
    const usage = countReservedQuestionUsage(
      activeRows.filter(
        (activeQuestion: WorkspaceQuestion) =>
          activeQuestion.id !== question.id,
      ),
      quotaScope,
      {
        reserveUnclassifiedAcrossCategories:
          isProgressiveLuxuryContract(contract),
      },
    );
    assertQuestionSelectionWithinQuota({
      limits,
      usage,
      category,
    });
    const selectedAt = now;
    const revision = question.revision + 1;
    await tx
      .update(workspaceQuestions)
      .set({
        candidateKey: null,
        category,
        status: "selected",
        selectionApprovalStatus: "approved",
        selectionApprovedAt: selectedAt,
        selectionApprovedByUserId: input.actorUserId,
        locked: true,
        selectedAt,
        revision,
        updatedAt: selectedAt,
      })
      .where(
        and(
          eq(workspaceQuestions.id, question.id),
          eq(workspaceQuestions.revision, question.revision),
        ),
      );
    const updatedQuestion: WorkspaceQuestion = {
      ...question,
      candidateKey: null,
      category,
      status: "selected",
      selectionApprovalStatus: "approved",
      selectionApprovedAt: selectedAt,
      selectionApprovedByUserId: input.actorUserId,
      locked: true,
      selectedAt,
      revision,
      updatedAt: selectedAt,
    };
    await options?.afterWrite?.(tx, updatedQuestion);
    return toPublicWorkspaceQuestion(updatedQuestion);
  };
  if (options?.executor) return execute(options.executor);
  const db = await requireServiceDb();
  return db.transaction(execute);
}
