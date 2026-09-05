import { createHash, randomUUID } from "node:crypto";

import { and, asc, desc, eq, gt, inArray, lte } from "drizzle-orm";

import {
  knowledgeBaseBuilds,
  knowledgeBaseSnapshots,
  knowledgeImportReceipts,
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
  type ServiceQuotaLimits,
  type ServiceQuotaUsage,
  type WorkspaceQuestionCategory,
} from "../shared/service-portal";
import { DELIVERY_TICKET_LIMITS } from "../shared/delivery-ticket";
import { dashboardPayloadSchema } from "../shared/dashboard";
import { getDb } from "./db";
import { getLatestAuthenticatedKnowledgeSnapshot } from "./authenticated-knowledge-service";

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

export function getServiceContractTermEnd(
  planCode: ServicePlanCode,
  startsAt: DateValue,
): Date {
  const plan = SERVICE_PLAN_CATALOG[planCode];
  const start = asDate(startsAt);
  return plan.contractTerm.unit === "day"
    ? new Date(start.getTime() + plan.contractTerm.count * DAY_MS)
    : addServiceCalendarMonths(start, plan.contractTerm.count);
}

export type ServiceQuotaWindow = {
  ordinal: number;
  startsAt: Date;
  endsAt: Date;
  limits: ServiceQuotaLimits;
};

export function createServiceQuotaWindows(
  planCode: ServicePlanCode,
  startsAt: DateValue,
): ServiceQuotaWindow[] {
  const plan = SERVICE_PLAN_CATALOG[planCode];
  const start = asDate(startsAt);
  const contractEnd = getServiceContractTermEnd(planCode, start);
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
  return Array.from({ length: plan.prepaidMonths ?? 1 }, (_, index) => ({
    ordinal: index + 1,
    startsAt: addServiceCalendarMonths(start, index),
    endsAt:
      index === (plan.prepaidMonths ?? 1) - 1
        ? contractEnd
        : addServiceCalendarMonths(start, index + 1),
    limits: { ...plan.limits },
  }));
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

function publicQuestion(
  row: NonNullable<ServicePortalStateInput["selectedQuestions"]>[number],
): ServicePortalQuestion {
  return {
    id: row.id,
    contractId: row.contractId ?? null,
    quotaPeriodId: row.quotaPeriodId,
    externalQuestionId: row.externalQuestionId ?? null,
    sourceQuestionId: row.sourceQuestionId ?? null,
    category: workspaceQuestionCategorySchema.parse(row.category),
    question: row.question,
    intent: row.intent ?? null,
    intentRevision: Math.max(1, row.intentRevision ?? 1),
    intentConfirmedRevision: row.intentConfirmedRevision ?? null,
    intentConfirmedAt: row.intentConfirmedAt
      ? epoch(row.intentConfirmedAt)
      : null,
    intentConfirmed: isWorkspaceQuestionIntentExplicitlyConfirmed(row),
    rationale: row.rationale ?? null,
    evidence: row.evidence ?? [],
    risks: row.risks ?? [],
    source: row.source,
    status: row.status,
    selectionApprovalStatus:
      row.status === "selected"
        ? "approved"
        : (row.selectionApprovalStatus ?? "not_requested"),
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
    if (question.status !== "selected") continue;
    const belongsToCurrentContract = Boolean(
      question.contractId && currentContractIds.has(question.contractId),
    );
    const belongsToCurrentPeriod =
      activePeriodIds.size === 0 || activePeriodIds.has(question.quotaPeriodId);
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
  questions: ServicePortalStateInput["selectedQuestions"] = [],
  quotaPeriodId?: string,
): ServiceQuotaUsage {
  const usage: ServiceQuotaUsage = { ...EMPTY_SERVICE_QUOTA_USAGE };
  for (const question of questions) {
    if (
      question.status !== "selected" ||
      (quotaPeriodId && question.quotaPeriodId !== quotaPeriodId)
    ) {
      continue;
    }
    if (question.category === "industry") usage.industry += 1;
    if (question.category === "competitor_comparison") {
      usage.competitorComparison += 1;
    }
    if (question.category === "reputation") usage.reputation += 1;
    if (question.category === "product_scenario") {
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
    (!input.responseLogicComplete
      ? "请先在应答逻辑智能体逐题发布确认。"
      : null);
  const distributionReason =
    monitoringReason ??
    (!input.monitoringComplete ? "请等待真实问题监控数据写入。" : null);
  const reportReason =
    distributionReason ??
    (!input.channelDistributionComplete
      ? "请等待可核验的渠道引用数据写入。"
      : null);
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

function questionIdentityKeys(question: ServicePortalQuestion): string[] {
  return [
    question.id,
    question.externalQuestionId,
    question.sourceQuestionId,
  ].filter((value): value is string => Boolean(value));
}

function everyQuestionHasOutput(
  questions: ServicePortalQuestion[],
  outputQuestionIds: string[] | undefined,
) {
  if (questions.length === 0) return false;
  const ids = new Set(outputQuestionIds ?? []);
  return questions.every((question) =>
    questionIdentityKeys(question).some((id) => ids.has(id)),
  );
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
  const selectedQuestions = (input.selectedQuestions ?? []).map(publicQuestion);
  const selectedQuestionIds = new Set(
    selectedQuestions.map((question) => question.id),
  );
  const historicalQuestions = (input.historicalQuestions ?? [])
    .map(publicQuestion)
    .filter((question) => !selectedQuestionIds.has(question.id));
  const periods =
    input.quotaPeriods ?? (input.quotaPeriod ? [input.quotaPeriod] : []);
  const period =
    input.quotaPeriod ??
    periods.find((value) => value.contractId === contract?.id) ??
    periods[0] ??
    null;
  const quotaDtos = periods.map((value) => {
    const limits: ServiceQuotaLimits = {
      industryLimit: value.industryLimit,
      competitorComparisonLimit: value.competitorComparisonLimit,
      reputationLimit: value.reputationLimit,
      productScenarioLimit: value.productScenarioLimit,
      totalQuestionLimit: value.totalQuestionLimit,
    };
    const usage = countSelectedQuestionUsage(input.selectedQuestions, value.id);
    return {
      periodId: value.id,
      contractId: value.contractId,
      validFrom: epoch(value.startsAt),
      validUntil: epoch(value.endsAt),
      revision: Math.max(1, value.revision),
      limits,
      usage,
      remaining: remainingQuota(limits, usage),
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
  }
  // Each approved question can enter optimization immediately. Filling every
  // purchased slot remains possible throughout the period, but it must not
  // block work already approved by an administrator.
  const questionSelectionComplete = selectedQuestions.length > 0;
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
    channelDistributionComplete && Boolean(input.hasProgressReport);
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

    const periodRows = await db
      .select()
      .from(serviceQuotaPeriods)
      .where(
        and(
          inArray(serviceQuotaPeriods.contractId, currentContractIds),
          lte(serviceQuotaPeriods.startsAt, now),
          gt(serviceQuotaPeriods.endsAt, now),
        ),
      )
      .orderBy(
        asc(serviceQuotaPeriods.startsAt),
        asc(serviceQuotaPeriods.ordinal),
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
            eq(workspaceQuestions.status, "selected"),
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
            ...(activePeriodIds.length
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

export async function getServicePortal(
  userId: number,
  options: {
    now?: Date;
    repository?: ServiceEntitlementRepository;
  } = {},
): Promise<ServicePortal> {
  const now = options.now ?? new Date();
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

export async function upsertServiceContract(
  input: UpsertServiceContractInput,
): Promise<ServicePortal> {
  const db = await requireServiceDb();
  const planCode = servicePlanCodeSchema.parse(input.planCode);
  const startsAt = input.startsAt ?? input.now ?? new Date();
  const endsAt = getServiceContractTermEnd(planCode, startsAt);
  const windows = createServiceQuotaWindows(planCode, startsAt);
  const newContractId = randomUUID();
  const quotaRows = windows.map((window) => ({
    id: randomUUID(),
    contractId: newContractId,
    userId: input.userId,
    ordinal: window.ordinal,
    startsAt: window.startsAt,
    endsAt: window.endsAt,
    ...window.limits,
    contentAssetPublishLimit:
      DELIVERY_TICKET_LIMITS[planCode].content_asset_publish,
    websiteContentPublishLimit:
      DELIVERY_TICKET_LIMITS[planCode].website_content_publish,
    revision: 1,
  }));
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
    const carryoverQuestions = explicitCarryIds
      ? sourceQuestions.filter((question) =>
          explicitCarryIds.includes(question.id),
        )
      : sourceQuestions;
    if (
      explicitCarryIds &&
      carryoverQuestions.length !== explicitCarryIds.length
    ) {
      throw new ServiceEntitlementError(
        "UPGRADE_RECONCILIATION_REQUIRED",
        "需保留的问题已变化，请刷新后重新选择。",
      );
    }
    const targetLimits = SERVICE_PLAN_CATALOG[planCode].limits;
    const carryUsage: ServiceQuotaUsage = { ...EMPTY_SERVICE_QUOTA_USAGE };
    try {
      for (const question of carryoverQuestions) {
        assertQuestionSelectionWithinQuota({
          limits: targetLimits,
          usage: carryUsage,
          category: question.category,
        });
        if (question.category === "industry") carryUsage.industry += 1;
        if (question.category === "competitor_comparison") {
          carryUsage.competitorComparison += 1;
        }
        if (question.category === "reputation") carryUsage.reputation += 1;
        if (question.category === "product_scenario") {
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
    const mutationTime = input.now ?? new Date();
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
      planVersion: SERVICE_PLAN_CATALOG[planCode].planVersion,
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
    const targetQuotaPeriod =
      quotaRows.find(
        (period) =>
          period.startsAt.getTime() <= mutationTime.getTime() &&
          period.endsAt.getTime() > mutationTime.getTime(),
      ) ??
      quotaRows.find(
        (period) => period.startsAt.getTime() >= mutationTime.getTime(),
      ) ??
      quotaRows.at(-1);
    if (targetQuotaPeriod && carryoverQuestions.length) {
      const carriedRows = carryoverQuestions.map((question, ordinal) => ({
        id: randomUUID(),
        userId: input.userId,
        contractId: newContractId,
        quotaPeriodId: targetQuotaPeriod.id,
        externalQuestionId: question.externalQuestionId,
        sourceQuestionId: question.sourceQuestionId ?? question.id,
        candidateKey: `carryover:${newContractId}:${question.id}`,
        category: question.category,
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
};

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
    const period = periodRows[0];
    if (!period) {
      throw new ServiceEntitlementError(
        "QUOTA_PERIOD_NOT_FOUND",
        "当前问题额度周期不存在。",
        404,
      );
    }
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
          eq(workspaceQuestions.quotaPeriodId, input.quotaPeriodId),
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
          eq(workspaceQuestions.quotaPeriodId, input.quotaPeriodId),
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
      quotaPeriodId: period.id,
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
    predicates.push(eq(workspaceQuestions.quotaPeriodId, input.quotaPeriodId));
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
      period.startsAt.getTime() > now.getTime() ||
      period.endsAt.getTime() <= now.getTime()
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
      now?: Date;
    }
  | {
      userId: number;
      actorUserId: number;
      question: string;
      category: WorkspaceQuestionCategory;
      questionId?: never;
      expectedRevision?: never;
      now?: Date;
    };

function comparableQuestionText(value: string) {
  return value.normalize("NFKC").trim().replace(/\s+/g, " ");
}

function countReservedQuestionUsage(
  questions: WorkspaceQuestion[],
  quotaPeriodId: string,
): ServiceQuotaUsage {
  const usage: ServiceQuotaUsage = { ...EMPTY_SERVICE_QUOTA_USAGE };
  for (const question of questions) {
    if (
      question.quotaPeriodId !== quotaPeriodId ||
      (question.status !== "selected" &&
        question.selectionApprovalStatus !== "pending")
    ) {
      continue;
    }
    usage.total += 1;
    if (question.category === "competitor_comparison") {
      usage.competitorComparison += 1;
    } else if (question.category === "product_scenario") {
      usage.productScenario += 1;
    } else {
      usage[question.category] += 1;
    }
  }
  return usage;
}

/**
 * Records a user's choice without consuming the authoritative service quota.
 * Pending requests are soft-reserved so concurrent submissions cannot exceed
 * the purchased limits. Only an assigned administrator's later approval moves
 * the row to selected+approved and makes it count in portal quota usage.
 */
export async function requestWorkspaceQuestionSelection(
  input: WorkspaceQuestionSelectionRequest,
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
    const period = periodRows[0];
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

    const activeRows = await tx
      .select()
      .from(workspaceQuestions)
      .where(
        and(
          eq(workspaceQuestions.userId, input.userId),
          eq(workspaceQuestions.quotaPeriodId, period.id),
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
        question.status === "archived"
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
      const duplicate = activeRows.find(
        (row) => comparableQuestionText(row.question) === comparable,
      );
      if (duplicate?.status === "selected") {
        return toPublicWorkspaceQuestion(duplicate);
      }
      if (duplicate?.selectionApprovalStatus === "pending") {
        return toPublicWorkspaceQuestion(duplicate);
      }
      if (duplicate) {
        question = duplicate;
      } else {
        const category = workspaceQuestionCategorySchema.parse(input.category);
        question = {
          id: randomUUID(),
          userId: input.userId,
          contractId: period.contractId,
          quotaPeriodId: period.id,
          externalQuestionId: null,
          sourceQuestionId: null,
          candidateKey: null,
          category,
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

    const limits: ServiceQuotaLimits = {
      industryLimit: period.industryLimit,
      competitorComparisonLimit: period.competitorComparisonLimit,
      reputationLimit: period.reputationLimit,
      productScenarioLimit: period.productScenarioLimit,
      totalQuestionLimit: period.totalQuestionLimit,
    };
    assertQuestionSelectionWithinQuota({
      limits,
      usage: countReservedQuestionUsage(activeRows, period.id),
      category: question.category,
    });

    if (activeRows.some((row) => row.id === question!.id)) {
      const revision = question.revision + 1;
      await tx
        .update(workspaceQuestions)
        .set({
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
      return toPublicWorkspaceQuestion({
        ...question,
        selectionApprovalStatus: "pending",
        selectionRequestedAt: now,
        selectionRequestedByUserId: input.actorUserId,
        revision,
        updatedAt: now,
      });
    }

    const pendingQuestion: WorkspaceQuestion = {
      ...question,
      selectionApprovalStatus: "pending",
      selectionRequestedAt: now,
      selectionRequestedByUserId: input.actorUserId,
    };
    await tx.insert(workspaceQuestions).values(pendingQuestion);
    return toPublicWorkspaceQuestion(pendingQuestion);
  });
}

export async function approveWorkspaceQuestionSelection(input: {
  userId: number;
  questionId: string;
  expectedRevision: number;
  actorUserId: number;
  now?: Date;
}): Promise<ServicePortalQuestion> {
  const db = await requireServiceDb();
  const now = input.now ?? new Date();
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
    if (candidate.status === "selected") {
      return toPublicWorkspaceQuestion(candidate);
    }
    if (candidate.selectionApprovalStatus !== "pending") {
      throw new ServiceEntitlementError(
        "QUESTION_SELECTION_CONFIRMATION_REQUIRED",
        "该问题尚未由用户提交专业审核。",
        409,
      );
    }
    const periodRows = await tx
      .select()
      .from(serviceQuotaPeriods)
      .where(
        and(
          eq(serviceQuotaPeriods.id, candidate.quotaPeriodId),
          eq(serviceQuotaPeriods.userId, input.userId),
        ),
      )
      .limit(1)
      .for("update");
    const period = periodRows[0];
    if (!period || period.contractId !== candidate.contractId) {
      throw new ServiceEntitlementError(
        "QUOTA_PERIOD_NOT_FOUND",
        "当前问题额度周期不存在。",
        404,
      );
    }
    // All candidate replacement and selection paths lock the quota period
    // before question rows, preventing the inverse-order deadlock.
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
    const question = rows[0];
    if (!question || question.status === "archived") {
      throw new ServiceEntitlementError(
        "QUESTION_NOT_FOUND",
        "候选问题不存在或已被替换。",
        404,
      );
    }
    if (question.status === "selected") {
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
    const selectedRows = await tx
      .select()
      .from(workspaceQuestions)
      .where(
        and(
          eq(workspaceQuestions.userId, input.userId),
          eq(workspaceQuestions.quotaPeriodId, question.quotaPeriodId),
          eq(workspaceQuestions.status, "selected"),
        ),
      )
      .for("update");
    const contract = contractRows[0];
    if (!contract) {
      throw new ServiceEntitlementError(
        "QUOTA_PERIOD_NOT_FOUND",
        "当前问题额度周期不存在。",
        404,
      );
    }
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
    const limits: ServiceQuotaLimits = {
      industryLimit: period.industryLimit,
      competitorComparisonLimit: period.competitorComparisonLimit,
      reputationLimit: period.reputationLimit,
      productScenarioLimit: period.productScenarioLimit,
      totalQuestionLimit: period.totalQuestionLimit,
    };
    const usage = countSelectedQuestionUsage(selectedRows, period.id);
    assertQuestionSelectionWithinQuota({
      limits,
      usage,
      category: question.category,
    });
    const selectedAt = now;
    const revision = question.revision + 1;
    await tx
      .update(workspaceQuestions)
      .set({
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
    return toPublicWorkspaceQuestion({
      ...question,
      status: "selected",
      selectionApprovalStatus: "approved",
      selectionApprovedAt: selectedAt,
      selectionApprovedByUserId: input.actorUserId,
      locked: true,
      selectedAt,
      revision,
      updatedAt: selectedAt,
    });
  });
}
