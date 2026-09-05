import { afterEach, describe, expect, it, vi } from "vitest";

import {
  SERVICE_PLAN_CATALOG,
  servicePortalSchema,
  toPublicServicePortal,
  type ServicePlanCode,
} from "../shared/service-portal";
import {
  deliveryTicketEvents,
  deliveryTickets,
  serviceContracts,
  users,
  workspaceQuestions,
} from "../drizzle/schema";
import {
  ServiceEntitlementError,
  assertServiceContractCancellationTiming,
  assertGeneratedQuestionQuotaContextCurrent,
  assertQuestionSelectionWithinQuota,
  assertServiceCapability,
  addServiceShanghaiCalendarMonths,
  createServiceQuotaWindows,
  countReservedQuestionUsage,
  deriveEffectiveServiceStatus,
  deriveServicePortalState,
  everyActiveQuotaPeriodHasProgressReport,
  getServiceContractTermEnd,
  isOperationalServiceQuotaPeriod,
  isServiceQuestionQuotaAnchor,
  isMissingServicePortalTableError,
  isBlockingQuestionWorkflowTicketStatus,
  isReplaceableModelCandidate,
  isSamePlanOverlappingServiceCorrection,
  isWorkspaceQuestionIntentExplicitlyConfirmed,
  normalizeGeneratedQuestionCandidates,
  partitionSelectedQuestionsForPortal,
  progressiveLuxuryCompatibilityAnchorValues,
  reconcileActivatedProgressiveLuxuryRenewal,
  reconcileProgressiveLuxuryCompatibilityAnchors,
  resolveEffectiveServiceQuestionQuotaLimits,
  resolveServiceQuestionQuotaCapacityState,
  resolveServiceQuestionQuotaScope,
  resolveServiceQuestionQuotaUnlockMetadata,
  resolveServiceEntitlementRolloutState,
  resolveTargetServicePlanVersion,
  selectDueProgressiveLuxuryRenewalCandidates,
  selectCurrentServiceContractIds,
  selectServiceQuotaWindowAt,
  selectServiceQuestionStoragePeriod,
  serviceQuotaWindowDeliveryLimits,
  shouldCarryServiceQuestionsByDefault,
  startServiceContractLifecycleReconciliationScheduler,
  terminateCancelledServiceContractQuestionWork,
  type PersistedServiceContractStatus,
  type ServiceEntitlementRepository,
  type ServicePortalContractRecord,
  type ServicePortalStateInput,
} from "./service-entitlement";
import { UNCLASSIFIED_QUESTION_CANDIDATE_KEY } from "./question-selection-policy";

const NOW = new Date("2026-07-26T08:00:00.000Z");

function contract(
  planCode: ServicePlanCode,
  overrides: Partial<ServicePortalContractRecord> = {},
): ServicePortalContractRecord {
  return {
    id: `contract-${planCode}`,
    userId: 7,
    planCode,
    planVersion: 1,
    status: "active",
    startsAt: new Date("2026-07-01T00:00:00.000Z"),
    endsAt: new Date("2026-10-01T00:00:00.000Z"),
    source: "admin",
    sourceReference: null,
    revision: 1,
    createdAt: new Date("2026-06-30T00:00:00.000Z"),
    ...overrides,
  };
}

function state(
  planCode: ServicePlanCode,
  overrides: Partial<ServicePortalStateInput> = {},
): ServicePortalStateInput {
  return {
    userId: 7,
    now: NOW,
    account: {
      userId: 7,
      username: "demo",
      displayName: "示例企业",
    },
    contract: contract(planCode),
    contracts: [contract(planCode)],
    selectedQuestions: [],
    knowledgeVersion: null,
    latestImportStatus: null,
    hasActiveKnowledgeBuild: false,
    ...overrides,
  };
}

function repository(
  value: ServicePortalStateInput,
): ServiceEntitlementRepository {
  return {
    async loadPortalState() {
      return value;
    },
  };
}

function renewalLifecycleExecutorFixture(input?: {
  targetStartsAt?: Date;
  sourceEndsAt?: Date;
  targetStatus?: "scheduled" | "active" | "cancelled";
}) {
  const target = {
    ...contract("luxury", {
      id: "luxury-v2-renewal",
      planVersion: 2,
      status: input?.targetStatus ?? "scheduled",
      startsAt: input?.targetStartsAt ?? new Date("2027-07-01T00:00:00.000Z"),
      endsAt: new Date("2028-07-01T00:00:00.000Z"),
      replacesContractIds: ["luxury-v2-source"],
      revision: 2,
    }),
  };
  const source = {
    ...contract("luxury", {
      id: "luxury-v2-source",
      planVersion: 2,
      startsAt: new Date("2026-07-01T00:00:00.000Z"),
      endsAt: input?.sourceEndsAt ?? new Date("2027-07-01T00:00:00.000Z"),
    }),
  };
  const tickets = [
    {
      id: "ticket-maintenance",
      status: "submitted",
      sourceQuestionId: "question-pending",
      operation: "question_maintenance",
    },
    {
      id: "ticket-catalog",
      status: "in_progress",
      sourceQuestionId: null,
      operation: "question_catalog",
    },
    {
      id: "ticket-monitoring",
      status: "scheduled",
      sourceQuestionId: null,
      operation: "initial_monitoring",
    },
    {
      id: "ticket-monitoring-import",
      status: "needs_information",
      sourceQuestionId: null,
      operation: "monitoring_import",
    },
    {
      id: "ticket-terminal",
      status: "cancelled",
      sourceQuestionId: "question-pending",
      operation: "question_maintenance",
    },
    {
      id: "ticket-content",
      status: "submitted",
      sourceQuestionId: null,
      operation: "content_asset_publish",
    },
  ];
  const questions = [
    {
      id: "question-pending",
      status: "candidate",
      selectionApprovalStatus: "pending",
      locked: false,
    },
  ];
  const events: Array<Record<string, unknown>> = [];
  const activeStatuses = new Set([
    "submitted",
    "needs_information",
    "scheduled",
    "in_progress",
  ]);
  const contractScopedOperations = new Set([
    "question_catalog",
    "initial_monitoring",
    "monitoring_import",
  ]);

  class SelectQuery implements PromiseLike<any[]> {
    private table: unknown;
    private limited = false;

    from(table: unknown) {
      this.table = table;
      return this;
    }

    where() {
      return this;
    }

    orderBy() {
      return this;
    }

    limit() {
      this.limited = true;
      return this;
    }

    private rows() {
      if (this.table === users) return [{ id: 7 }];
      if (this.table === serviceContracts) {
        return this.limited ? [target] : [source];
      }
      if (this.table === deliveryTickets) {
        return tickets.filter(
          (ticket) =>
            activeStatuses.has(ticket.status) &&
            (ticket.sourceQuestionId !== null ||
              contractScopedOperations.has(ticket.operation)),
        );
      }
      if (this.table === workspaceQuestions) {
        return questions
          .filter(
            (question) =>
              ["candidate", "selected"].includes(question.status) &&
              question.selectionApprovalStatus === "pending",
          )
          .map((question) => ({ id: question.id }));
      }
      return [];
    }

    for() {
      return Promise.resolve(this.rows());
    }

    then<TResult1 = any[], TResult2 = never>(
      onfulfilled?: ((value: any[]) => TResult1 | PromiseLike<TResult1>) | null,
      onrejected?:
        | ((reason: unknown) => TResult2 | PromiseLike<TResult2>)
        | null,
    ): PromiseLike<TResult1 | TResult2> {
      return Promise.resolve(this.rows()).then(onfulfilled, onrejected);
    }
  }

  const executor = {
    select() {
      return new SelectQuery();
    },
    update(table: unknown) {
      return {
        set(values: Record<string, unknown>) {
          return {
            async where() {
              if (table === deliveryTickets && values.status === "cancelled") {
                for (const ticket of tickets) {
                  if (
                    activeStatuses.has(ticket.status) &&
                    (ticket.sourceQuestionId !== null ||
                      contractScopedOperations.has(ticket.operation))
                  ) {
                    ticket.status = "cancelled";
                  }
                }
              }
              if (
                table === workspaceQuestions &&
                values.status === "archived"
              ) {
                for (const question of questions) {
                  if (question.selectionApprovalStatus === "pending") {
                    question.status = "archived";
                    question.selectionApprovalStatus = "not_requested";
                  }
                }
              }
              if (
                table === serviceContracts &&
                values.status === "superseded"
              ) {
                source.status = "superseded";
              }
              if (table === serviceContracts && values.status === "active") {
                target.status = "active";
              }
            },
          };
        },
      };
    },
    insert(table: unknown) {
      return {
        async values(values: Record<string, unknown>[]) {
          if (table === deliveryTicketEvents) events.push(...values);
        },
      };
    },
  };
  return { executor, target, source, tickets, questions, events };
}

describe("service plan catalogue", () => {
  it("keeps the fixed entitlement and quota matrix", () => {
    expect(SERVICE_PLAN_CATALOG.basic).toMatchObject({
      contractTerm: { unit: "day", count: 30 },
      quotaCadence: "contract",
      limits: {
        industryLimit: 0,
        competitorComparisonLimit: 1,
        reputationLimit: 1,
        productScenarioLimit: 1,
        totalQuestionLimit: 1,
      },
    });
    expect(SERVICE_PLAN_CATALOG.advanced).toMatchObject({
      contractTerm: { unit: "month", count: 3 },
      quotaCadence: "quarter",
      prepaidMonths: 3,
      limits: {
        industryLimit: 1,
        competitorComparisonLimit: 1,
        reputationLimit: 1,
        productScenarioLimit: 5,
        totalQuestionLimit: 8,
      },
    });
    expect(SERVICE_PLAN_CATALOG.luxury).toMatchObject({
      planVersion: 2,
      contractTerm: { unit: "month", count: 12 },
      quotaCadence: "month",
      prepaidMonths: 3,
      limits: {
        industryLimit: 4,
        competitorComparisonLimit: 4,
        reputationLimit: 4,
        productScenarioLimit: 20,
        totalQuestionLimit: 32,
      },
    });
  });

  it("opens the paid single-question delivery flow for Basic", () => {
    expect(SERVICE_PLAN_CATALOG.basic.includedCapabilities).toMatchObject({
      knowledgeBuild: false,
      knowledgeDisplay: true,
      globalKeywords: false,
      questionSelection: false,
      intentOptimization: true,
      responseLogic: true,
      monitoring: true,
      channelDistribution: true,
      progressReport: true,
      contentAssets: false,
      brandTracking: false,
    });
  });

  it("creates one annual compatibility anchor plus twelve progressive monthly Luxury v2 windows", () => {
    const start = new Date("2026-01-31T05:30:00.000Z");
    expect(getServiceContractTermEnd("basic", start).toISOString()).toBe(
      "2026-03-02T05:30:00.000Z",
    );
    expect(createServiceQuotaWindows("basic", start)).toHaveLength(1);
    expect(createServiceQuotaWindows("advanced", start)).toHaveLength(1);

    const luxury = createServiceQuotaWindows("luxury", start);
    expect(luxury).toHaveLength(13);
    expect(luxury.map((window) => window.ordinal)).toEqual([
      0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12,
    ]);
    const [anchor, ...operational] = luxury;
    expect(anchor).toMatchObject({
      ordinal: 0,
      limits: {
        industryLimit: 1,
        competitorComparisonLimit: 1,
        reputationLimit: 1,
        productScenarioLimit: 5,
        totalQuestionLimit: 8,
      },
    });
    expect(anchor?.startsAt).toEqual(start);
    expect(anchor?.endsAt.toISOString()).toBe("2027-01-31T05:30:00.000Z");
    expect(isServiceQuestionQuotaAnchor(anchor!)).toBe(true);
    expect(operational.every(isOperationalServiceQuotaPeriod)).toBe(true);
    expect(operational.map((window) => window.startsAt.toISOString())).toEqual([
      "2026-01-31T05:30:00.000Z",
      "2026-02-28T05:30:00.000Z",
      "2026-03-31T05:30:00.000Z",
      "2026-04-30T05:30:00.000Z",
      "2026-05-31T05:30:00.000Z",
      "2026-06-30T05:30:00.000Z",
      "2026-07-31T05:30:00.000Z",
      "2026-08-31T05:30:00.000Z",
      "2026-09-30T05:30:00.000Z",
      "2026-10-31T05:30:00.000Z",
      "2026-11-30T05:30:00.000Z",
      "2026-12-31T05:30:00.000Z",
    ]);
    expect(operational.map((window) => window.limits)).toEqual([
      ...Array(3).fill({
        industryLimit: 1,
        competitorComparisonLimit: 1,
        reputationLimit: 1,
        productScenarioLimit: 5,
        totalQuestionLimit: 8,
      }),
      ...Array(3).fill({
        industryLimit: 2,
        competitorComparisonLimit: 2,
        reputationLimit: 2,
        productScenarioLimit: 10,
        totalQuestionLimit: 16,
      }),
      ...Array(3).fill({
        industryLimit: 3,
        competitorComparisonLimit: 3,
        reputationLimit: 3,
        productScenarioLimit: 15,
        totalQuestionLimit: 24,
      }),
      ...Array(3).fill({
        industryLimit: 4,
        competitorComparisonLimit: 4,
        reputationLimit: 4,
        productScenarioLimit: 20,
        totalQuestionLimit: 32,
      }),
    ]);
    expect(operational.at(-1)?.endsAt.toISOString()).toBe(
      "2027-01-31T05:30:00.000Z",
    );
    expect(serviceQuotaWindowDeliveryLimits("luxury", anchor!)).toEqual({
      contentAssetPublishLimit: 0,
      websiteContentPublishLimit: 0,
    });
    expect(serviceQuotaWindowDeliveryLimits("luxury", operational[0]!)).toEqual(
      {
        contentAssetPublishLimit: 20,
        websiteContentPublishLimit: 100,
      },
    );

    const legacy = createServiceQuotaWindows("luxury", start, {
      planVersion: 1,
    });
    expect(legacy).toHaveLength(3);
    expect(
      legacy.every((window) => window.limits.totalQuestionLimit === 32),
    ).toBe(true);
    expect(legacy.at(-1)?.endsAt.toISOString()).toBe(
      "2026-04-30T05:30:00.000Z",
    );
  });

  it("uses Shanghai calendar boundaries only for progressive Luxury", () => {
    const shanghaiMonthEnd = new Date("2024-01-31T16:30:00.000Z");
    expect(
      addServiceShanghaiCalendarMonths(shanghaiMonthEnd, 1).toISOString(),
    ).toBe("2024-02-29T16:30:00.000Z");
    expect(
      getServiceContractTermEnd("luxury", shanghaiMonthEnd).toISOString(),
    ).toBe("2025-01-31T16:30:00.000Z");
    expect(
      getServiceContractTermEnd("luxury", shanghaiMonthEnd, {
        planVersion: 1,
      }).toISOString(),
    ).toBe("2024-04-30T16:30:00.000Z");
  });

  it("preserves overlapping Luxury v1 corrections but starts renewals on v2", () => {
    const source = contract("luxury", {
      planVersion: 1,
      endsAt: new Date("2026-10-01T00:00:00.000Z"),
    });
    expect(
      resolveTargetServicePlanVersion({
        targetPlanCode: "luxury",
        startsAt: new Date("2026-09-30T23:59:59.999Z"),
        sourceContracts: [source],
      }),
    ).toBe(1);
    expect(
      resolveTargetServicePlanVersion({
        targetPlanCode: "luxury",
        startsAt: new Date("2026-10-01T00:00:00.000Z"),
        sourceContracts: [source],
      }),
    ).toBe(2);
  });

  it("defaults only Luxury-to-Luxury v2 renewals to a fresh question cohort", () => {
    const luxurySource = contract("luxury", {
      endsAt: new Date("2027-01-01T00:00:00.000Z"),
    });
    expect(
      shouldCarryServiceQuestionsByDefault({
        targetPlanCode: "luxury",
        targetPlanVersion: 2,
        startsAt: new Date("2027-01-01T00:00:00.000Z"),
        sourceContracts: [luxurySource],
      }),
    ).toBe(false);
    expect(
      shouldCarryServiceQuestionsByDefault({
        targetPlanCode: "luxury",
        targetPlanVersion: 2,
        startsAt: new Date("2026-12-31T23:59:59.999Z"),
        sourceContracts: [luxurySource],
      }),
    ).toBe(true);
    expect(
      shouldCarryServiceQuestionsByDefault({
        targetPlanCode: "luxury",
        targetPlanVersion: 1,
        startsAt: new Date("2027-01-01T00:00:00.000Z"),
        sourceContracts: [luxurySource],
      }),
    ).toBe(true);
    expect(
      shouldCarryServiceQuestionsByDefault({
        targetPlanCode: "luxury",
        targetPlanVersion: 2,
        startsAt: new Date("2027-01-01T00:00:00.000Z"),
        sourceContracts: [
          contract("advanced", {
            endsAt: new Date("2027-01-01T00:00:00.000Z"),
          }),
        ],
      }),
    ).toBe(true);
  });

  it("uses the currently unlocked window for an overlapping Luxury correction", () => {
    const windows = createServiceQuotaWindows(
      "luxury",
      new Date("2026-01-01T00:00:00.000Z"),
    );
    expect(
      selectServiceQuotaWindowAt(windows, new Date("2026-08-15T00:00:00.000Z"))
        ?.limits,
    ).toMatchObject({
      industryLimit: 3,
      competitorComparisonLimit: 3,
      reputationLimit: 3,
      productScenarioLimit: 15,
      totalQuestionLimit: 24,
    });
    expect(
      selectServiceQuotaWindowAt(windows, new Date("2025-12-31T23:59:59.999Z")),
    ).toBe(windows[1]);
  });

  it("stores every Luxury v2 question on the annual anchor while operational selection skips it", () => {
    const contractV2 = contract("luxury", {
      id: "luxury-v2-anchor-contract",
      planVersion: 2,
      startsAt: new Date("2026-01-01T00:00:00.000Z"),
      endsAt: new Date("2027-01-01T00:00:00.000Z"),
    });
    const periods = createServiceQuotaWindows(
      "luxury",
      contractV2.startsAt,
    ).map((window) => ({
      ...window,
      id: `period-${window.ordinal}`,
      contractId: contractV2.id,
    }));
    const operational = selectServiceQuotaWindowAt(
      periods,
      new Date("2026-08-15T00:00:00.000Z"),
    )!;
    expect(operational.ordinal).toBe(8);
    for (const operationalPeriod of periods.slice(1)) {
      expect(
        selectServiceQuestionStoragePeriod({
          contract: contractV2,
          operationalPeriod,
          contractPeriods: periods,
        }),
      ).toBe(periods[0]);
    }
    expect(
      selectServiceQuestionStoragePeriod({
        contract: contractV2,
        operationalPeriod: periods[0]!,
        contractPeriods: periods,
      }),
    ).toBeNull();
  });

  it("keeps the previous image readable and fail-closed after later-quarter v2 writes", () => {
    const contractId = "luxury-v2-previous-reader";
    const now = new Date("2026-05-15T00:00:00.000Z");
    const periods = createServiceQuotaWindows(
      "luxury",
      new Date("2026-01-01T00:00:00.000Z"),
    ).map((window) => ({
      ...window,
      id: `period-${window.ordinal}`,
      contractId,
    }));
    // This is the exact selection strategy used by image 6dd200ca: query every
    // active row, then order by startsAt and ordinal and choose the first one.
    const previousActivePeriods = periods
      .filter((period) => period.startsAt <= now && now < period.endsAt)
      .sort(
        (left, right) =>
          left.startsAt.getTime() - right.startsAt.getTime() ||
          left.ordinal - right.ordinal,
      );
    const previousQuota = previousActivePeriods[0]!;
    const laterQuarterQuestions = Array.from({ length: 9 }, (_, index) => ({
      id: `question-${index}`,
      contractId,
      quotaPeriodId: periods[0]!.id,
      status: "selected" as const,
    }));
    const activeIds = new Set(previousActivePeriods.map((period) => period.id));
    const previousReadableQuestions = laterQuarterQuestions.filter((question) =>
      activeIds.has(question.quotaPeriodId),
    );

    expect(previousQuota.ordinal).toBe(0);
    expect(previousReadableQuestions).toHaveLength(9);
    expect(previousQuota.limits.totalQuestionLimit).toBe(8);
    expect(previousReadableQuestions.length).toBeGreaterThanOrEqual(
      previousQuota.limits.totalQuestionLimit,
    );
  });
});

describe("service contract in-flight lifecycle", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("guards same-plan overlap corrections but never traps an explicit cancellation", () => {
    const source = contract("luxury", {
      planVersion: 2,
      endsAt: new Date("2027-07-01T00:00:00.000Z"),
    });
    const base = {
      targetPlanCode: "luxury" as const,
      targetPlanVersion: 2,
      startsAt: new Date("2027-06-15T00:00:00.000Z"),
      sourceContracts: [source],
    };
    expect(
      isSamePlanOverlappingServiceCorrection({
        ...base,
        targetStatus: "active",
      }),
    ).toBe(true);
    expect(
      isSamePlanOverlappingServiceCorrection({
        ...base,
        targetStatus: "cancelled",
      }),
    ).toBe(false);
    expect(
      isSamePlanOverlappingServiceCorrection({
        ...base,
        startsAt: source.endsAt,
        targetStatus: "scheduled",
      }),
    ).toBe(false);
    expect(
      isSamePlanOverlappingServiceCorrection({
        ...base,
        targetPlanCode: "advanced",
        targetPlanVersion: 1,
        targetStatus: "active",
      }),
    ).toBe(false);
    for (const status of [
      "submitted",
      "needs_information",
      "scheduled",
      "in_progress",
    ]) {
      expect(isBlockingQuestionWorkflowTicketStatus(status)).toBe(true);
    }
    for (const status of ["completed", "rejected", "cancelled"]) {
      expect(isBlockingQuestionWorkflowTicketStatus(status)).toBe(false);
    }
    expect(() =>
      assertServiceContractCancellationTiming({
        status: "cancelled",
        startsAt: new Date("2027-06-15T00:00:00.000Z"),
        now: new Date("2027-06-15T00:00:00.000Z"),
      }),
    ).not.toThrow();
    expect(() =>
      assertServiceContractCancellationTiming({
        status: "cancelled",
        startsAt: new Date("2027-06-15T00:00:00.001Z"),
        now: new Date("2027-06-15T00:00:00.000Z"),
      }),
    ).toThrowError(
      expect.objectContaining({
        code: "UPGRADE_RECONCILIATION_REQUIRED",
        message: "服务取消必须立即生效，不能预约未来日期。",
      }),
    );
  });

  it("atomically terminates source question work for an immediate cancellation", async () => {
    const fixture = renewalLifecycleExecutorFixture();
    await expect(
      terminateCancelledServiceContractQuestionWork({
        executor: fixture.executor,
        userId: 7,
        contractIds: [fixture.source.id],
        now: new Date("2027-06-15T00:00:00.000Z"),
      }),
    ).resolves.toEqual({
      archivedPendingQuestionCount: 1,
      cancelledQuestionWorkflowTicketCount: 4,
    });
    expect(fixture.source.status).toBe("active");
    expect(fixture.questions[0]?.status).toBe("archived");
    expect(
      fixture.tickets.find((ticket) => ticket.id === "ticket-content")?.status,
    ).toBe("submitted");
    expect(fixture.events).toHaveLength(4);
    await expect(
      terminateCancelledServiceContractQuestionWork({
        executor: fixture.executor,
        userId: 7,
        contractIds: [fixture.source.id],
        now: new Date("2027-06-15T00:01:00.000Z"),
      }),
    ).resolves.toEqual({
      archivedPendingQuestionCount: 0,
      cancelledQuestionWorkflowTicketCount: 0,
    });
    expect(fixture.events).toHaveLength(4);
  });

  it("maps only database lock contention to a stable retry error", async () => {
    const rejectingExecutor = (error: unknown) => ({
      select() {
        const query = {
          from() {
            return query;
          },
          where() {
            return query;
          },
          for() {
            return Promise.reject(error);
          },
        };
        return query;
      },
    });
    await expect(
      terminateCancelledServiceContractQuestionWork({
        executor: rejectingExecutor({ code: "ER_LOCK_NOWAIT" }),
        userId: 7,
        contractIds: ["source"],
        now: NOW,
      }),
    ).rejects.toMatchObject({
      code: "UPGRADE_RECONCILIATION_REQUIRED",
      message: "问题工作流正在更新，请稍后重试服务合同操作。",
    });
    const databaseFailure = { code: "ER_ACCESS_DENIED_ERROR" };
    await expect(
      terminateCancelledServiceContractQuestionWork({
        executor: rejectingExecutor(databaseFailure),
        userId: 7,
        contractIds: ["source"],
        now: NOW,
      }),
    ).rejects.toBe(databaseFailure);
  });

  it("filters onboarding, overlap corrections and completed renewals before taking locks", () => {
    const sources = [
      {
        id: "source-active",
        userId: 7,
        planCode: "luxury" as const,
        status: "active" as const,
        endsAt: new Date("2027-07-01T00:00:00.000Z"),
      },
      {
        id: "source-complete",
        userId: 7,
        planCode: "luxury" as const,
        status: "superseded" as const,
        endsAt: new Date("2026-07-01T00:00:00.000Z"),
      },
    ];
    const candidates = [
      {
        id: "onboarding",
        userId: 7,
        startsAt: new Date("2027-07-01T00:00:00.000Z"),
        replacesContractIds: [],
      },
      {
        id: "overlap",
        userId: 7,
        startsAt: new Date("2027-06-30T23:59:59.999Z"),
        replacesContractIds: ["source-active"],
      },
      {
        id: "due",
        userId: 7,
        startsAt: new Date("2027-07-01T00:00:00.000Z"),
        replacesContractIds: ["source-active"],
      },
      {
        id: "already-complete",
        userId: 7,
        startsAt: new Date("2026-07-01T00:00:00.000Z"),
        replacesContractIds: ["source-complete"],
      },
    ];
    expect(
      selectDueProgressiveLuxuryRenewalCandidates({ candidates, sources }).map(
        (candidate) => candidate.id,
      ),
    ).toEqual(["due"]);
    expect(
      selectDueProgressiveLuxuryRenewalCandidates({
        candidates,
        sources,
        sourceContractIdsWithOutstandingQuestionWork: new Set([
          "source-complete",
        ]),
      }).map((candidate) => candidate.id),
    ).toEqual(["due", "already-complete"]);
  });

  it("reconciles a due annual renewal once and leaves terminal/unrelated work alone", async () => {
    const fixture = renewalLifecycleExecutorFixture();
    const first = await reconcileActivatedProgressiveLuxuryRenewal({
      executor: fixture.executor,
      userId: 7,
      targetContractId: fixture.target.id,
      now: new Date("2027-07-01T00:00:00.000Z"),
    });
    expect(first).toEqual({
      scannedContractCount: 1,
      reconciledContractCount: 1,
      supersededSourceContractCount: 1,
      archivedPendingQuestionCount: 1,
      cancelledQuestionWorkflowTicketCount: 4,
    });
    expect(fixture.source.status).toBe("superseded");
    expect(fixture.target.status).toBe("active");
    expect(fixture.questions[0]).toMatchObject({
      status: "archived",
      selectionApprovalStatus: "not_requested",
    });
    expect(
      fixture.tickets.find((ticket) => ticket.id === "ticket-terminal")?.status,
    ).toBe("cancelled");
    expect(
      fixture.tickets.find((ticket) => ticket.id === "ticket-content")?.status,
    ).toBe("submitted");
    expect(fixture.events).toHaveLength(4);

    const second = await reconcileActivatedProgressiveLuxuryRenewal({
      executor: fixture.executor,
      userId: 7,
      targetContractId: fixture.target.id,
      now: new Date("2027-07-01T00:05:00.000Z"),
    });
    expect(second).toEqual({
      scannedContractCount: 1,
      reconciledContractCount: 0,
      supersededSourceContractCount: 0,
      archivedPendingQuestionCount: 0,
      cancelledQuestionWorkflowTicketCount: 0,
    });
    expect(fixture.events).toHaveLength(4);
  });

  it("does not freeze a scheduled renewal early or reconcile an overlap correction", async () => {
    const future = renewalLifecycleExecutorFixture({
      targetStartsAt: new Date("2027-07-02T00:00:00.000Z"),
    });
    await expect(
      reconcileActivatedProgressiveLuxuryRenewal({
        executor: future.executor,
        userId: 7,
        targetContractId: future.target.id,
        now: new Date("2027-07-01T23:59:59.999Z"),
      }),
    ).resolves.toMatchObject({ reconciledContractCount: 0 });
    expect(future.source.status).toBe("active");
    expect(future.tickets[0]?.status).toBe("submitted");

    const overlap = renewalLifecycleExecutorFixture({
      targetStartsAt: new Date("2027-06-15T00:00:00.000Z"),
      sourceEndsAt: new Date("2027-07-01T00:00:00.000Z"),
    });
    await expect(
      reconcileActivatedProgressiveLuxuryRenewal({
        executor: overlap.executor,
        userId: 7,
        targetContractId: overlap.target.id,
        now: new Date("2027-06-15T00:00:00.000Z"),
      }),
    ).resolves.toMatchObject({ reconciledContractCount: 0 });
    expect(overlap.source.status).toBe("active");
    expect(overlap.tickets[0]?.status).toBe("submitted");
  });

  it("coalesces overlapping scheduler ticks", async () => {
    vi.useFakeTimers();
    let release!: () => void;
    const pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    const run = vi.fn(async () => {
      await pending;
      return {
        scannedContractCount: 0,
        reconciledContractCount: 0,
        supersededSourceContractCount: 0,
        archivedPendingQuestionCount: 0,
        cancelledQuestionWorkflowTicketCount: 0,
      };
    });
    const stop = startServiceContractLifecycleReconciliationScheduler({
      intervalMs: 60_000,
      run,
    });
    await vi.advanceTimersByTimeAsync(180_000);
    expect(run).toHaveBeenCalledTimes(1);
    release();
    await pending;
    await vi.advanceTimersByTimeAsync(60_000);
    expect(run).toHaveBeenCalledTimes(2);
    stop();
  });

  it("logs a stable scheduler event without raw failure text", async () => {
    vi.useFakeTimers();
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const stop = startServiceContractLifecycleReconciliationScheduler({
      run: async () => {
        throw new Error("database-secret-shaped-detail");
      },
    });
    await Promise.resolve();
    await Promise.resolve();
    expect(error).toHaveBeenCalledWith(
      "[ServiceContractLifecycle] reconciliation_failed",
    );
    expect(JSON.stringify(error.mock.calls)).not.toContain(
      "database-secret-shaped-detail",
    );
    stop();
  });
});

describe("progressive Luxury question quota", () => {
  const progressiveContract = contract("luxury", {
    id: "contract-luxury-v2",
    planVersion: 2,
    startsAt: new Date("2026-01-31T16:00:00.000Z"),
    endsAt: new Date("2027-01-31T16:00:00.000Z"),
  });
  const q2Period = {
    id: "period-luxury-month-4",
    contractId: progressiveContract.id,
    userId: 7,
    ordinal: 4,
    startsAt: new Date("2026-04-30T16:00:00.000Z"),
    endsAt: new Date("2026-05-31T16:00:00.000Z"),
    industryLimit: 2,
    competitorComparisonLimit: 2,
    reputationLimit: 2,
    productScenarioLimit: 10,
    totalQuestionLimit: 16,
    revision: 1,
  };

  it("switches stages exactly on Shanghai service-quarter boundaries", () => {
    const before = resolveServiceQuestionQuotaUnlockMetadata({
      contract: progressiveContract,
      period: q2Period,
      now: new Date("2026-04-30T15:59:59.999Z"),
    });
    expect(before).toMatchObject({
      unlockedLimits: { totalQuestionLimit: 8, productScenarioLimit: 5 },
      unlockStage: { current: 1, total: 4 },
      nextUnlockAt: new Date("2026-04-30T16:00:00.000Z").getTime(),
    });

    const atBoundary = resolveServiceQuestionQuotaUnlockMetadata({
      contract: progressiveContract,
      period: q2Period,
      now: new Date("2026-04-30T16:00:00.000Z"),
    });
    expect(atBoundary).toMatchObject({
      entitlementLimits: { totalQuestionLimit: 32 },
      unlockedLimits: { totalQuestionLimit: 16, productScenarioLimit: 10 },
      unlockStage: { current: 2, total: 4 },
      nextUnlockAt: new Date("2026-07-31T16:00:00.000Z").getTime(),
    });
  });

  it("repairs privileged rollback drift back to the conservative anchor values", async () => {
    let values: Record<string, unknown> | null = null;
    const where = vi.fn(async () => undefined);
    const update = vi.fn(() => ({
      set(next: Record<string, unknown>) {
        values = next;
        return { where };
      },
    }));

    expect(progressiveLuxuryCompatibilityAnchorValues()).toEqual({
      industryLimit: 1,
      competitorComparisonLimit: 1,
      reputationLimit: 1,
      productScenarioLimit: 5,
      totalQuestionLimit: 8,
      contentAssetPublishLimit: 0,
      websiteContentPublishLimit: 0,
    });
    await reconcileProgressiveLuxuryCompatibilityAnchors({
      executor: { update },
      contractIds: [progressiveContract.id, progressiveContract.id],
      now: new Date("2026-05-01T00:00:00.000Z"),
    });
    expect(update).toHaveBeenCalledTimes(1);
    expect(values).toMatchObject(progressiveLuxuryCompatibilityAnchorValues());
    expect(where).toHaveBeenCalledTimes(1);

    update.mockClear();
    await reconcileProgressiveLuxuryCompatibilityAnchors({
      executor: { update },
      contractIds: [],
    });
    expect(update).not.toHaveBeenCalled();
  });

  it("uses contract scope and never lets an adjusted period exceed its unlocked cap", () => {
    const scope = resolveServiceQuestionQuotaScope(
      progressiveContract,
      q2Period,
    );
    expect(scope).toEqual({
      kind: "contract",
      contractId: progressiveContract.id,
    });
    expect(
      countReservedQuestionUsage(
        [
          {
            contractId: progressiveContract.id,
            quotaPeriodId: "period-month-1",
            status: "selected",
            selectionApprovalStatus: "approved",
            candidateKey: null,
            category: "industry",
            source: "admin",
          },
          {
            contractId: progressiveContract.id,
            quotaPeriodId: "period-month-3",
            status: "candidate",
            selectionApprovalStatus: "pending",
            candidateKey: null,
            category: "industry",
            source: "user",
          },
        ],
        scope,
      ),
    ).toMatchObject({ industry: 2, total: 2 });
    expect(
      countReservedQuestionUsage(
        [
          {
            contractId: progressiveContract.id,
            quotaPeriodId: "period-month-4",
            status: "candidate",
            selectionApprovalStatus: "pending",
            candidateKey: UNCLASSIFIED_QUESTION_CANDIDATE_KEY,
            category: "product_scenario",
            source: "user",
          },
        ],
        scope,
        { reserveUnclassifiedAcrossCategories: true },
      ),
    ).toEqual({
      industry: 1,
      competitorComparison: 1,
      reputation: 1,
      productScenario: 1,
      total: 1,
    });
    expect(
      resolveEffectiveServiceQuestionQuotaLimits({
        contract: progressiveContract,
        period: {
          ...q2Period,
          industryLimit: 4,
          competitorComparisonLimit: 4,
          reputationLimit: 4,
          productScenarioLimit: 20,
          totalQuestionLimit: 32,
        },
        now: new Date("2026-04-30T16:00:00.000Z"),
      }),
    ).toEqual({
      industryLimit: 2,
      competitorComparisonLimit: 2,
      reputationLimit: 2,
      productScenarioLimit: 10,
      totalQuestionLimit: 16,
    });
  });

  it("keeps Luxury v1 period-scoped with its persisted full allowance", () => {
    const legacy = contract("luxury", { planVersion: 1 });
    expect(resolveServiceQuestionQuotaScope(legacy, q2Period)).toEqual({
      kind: "period",
      periodId: q2Period.id,
    });
    expect(
      resolveServiceQuestionQuotaUnlockMetadata({
        contract: legacy,
        period: { ...q2Period, totalQuestionLimit: 32 },
        now: new Date("2026-09-01T00:00:00.000Z"),
      }),
    ).toMatchObject({
      entitlementLimits: { totalQuestionLimit: 32 },
      unlockedLimits: { totalQuestionLimit: 32 },
      unlockStage: { current: 1, total: 1 },
      nextUnlockAt: null,
    });
  });

  it("distinguishes currently available, time-locked and finally exhausted capacity", () => {
    const emptyRemaining = {
      industry: 0,
      competitorComparison: 0,
      reputation: 0,
      productScenario: 0,
      total: 0,
    };
    expect(
      resolveServiceQuestionQuotaCapacityState({
        remaining: { ...emptyRemaining, total: 1 },
        nextUnlockAt: Date.now() + 1,
      }),
    ).toBe("available");
    expect(
      resolveServiceQuestionQuotaCapacityState({
        remaining: emptyRemaining,
        nextUnlockAt: Date.now() + 1,
      }),
    ).toBe("awaiting_unlock");
    expect(
      resolveServiceQuestionQuotaCapacityState({
        remaining: emptyRemaining,
        nextUnlockAt: null,
      }),
    ).toBe("exhausted");
  });
});

describe("service portal derivation", () => {
  it("does not expose internal onboarding or rollout references as order numbers", () => {
    for (const sourceReference of [
      "managed-user-onboarding:contract-1",
      "rollout:7:1:advanced",
    ]) {
      const portal = deriveServicePortalState(
        state("advanced", {
          contract: contract("advanced", { sourceReference }),
          contracts: [contract("advanced", { sourceReference })],
        }),
      );
      expect(portal.purchases[0]?.orderReference).toBeNull();
      expect(JSON.stringify(portal)).not.toContain(sourceReference);
    }
  });

  it("projects a user DTO without commercial, contract, or rollout metadata", () => {
    const internal = deriveServicePortalState(
      state("luxury", {
        contract: contract("luxury", {
          amountFen: 8_940_000,
          currency: "CNY",
          orderReference: "internal-order",
          externalContractReference: "internal-contract",
          signedAt: NOW,
          signatoryId: "internal-signatory",
          signingEvidence: { source: "internal" },
        }),
        contracts: [
          contract("luxury", {
            amountFen: 8_940_000,
            currency: "CNY",
            orderReference: "internal-order",
            externalContractReference: "internal-contract",
            signedAt: NOW,
            signatoryId: "internal-signatory",
            signingEvidence: { source: "internal" },
          }),
        ],
        selectedQuestions: [
          {
            id: "question-luxury",
            quotaPeriodId: "period-luxury",
            category: "industry",
            question: "行业代表企业有哪些？",
            source: "admin",
            status: "selected",
            locked: true,
            revision: 1,
          },
        ],
      }),
    );

    const userPortal = toPublicServicePortal(internal);
    expect(userPortal).not.toHaveProperty("entitlementRollout");
    expect(userPortal).not.toHaveProperty("quotaPeriods");
    expect(userPortal).not.toHaveProperty("purchases");
    expect(userPortal.service).not.toHaveProperty("contractId");
    expect(userPortal.service).not.toHaveProperty("source");
    if (userPortal.quotas) {
      expect(userPortal.quotas).not.toHaveProperty("contractId");
    }
    for (const question of [
      ...userPortal.purchasedQuestions,
      ...userPortal.historicalQuestions,
    ]) {
      expect(question).not.toHaveProperty("contractId");
      expect(question).not.toHaveProperty("quotaPeriodId");
    }
  });

  it("treats model intent as a suggestion until the same revision is explicitly confirmed", () => {
    expect(
      isWorkspaceQuestionIntentExplicitlyConfirmed({
        intent: "模型生成的建议稿",
        intentRevision: 3,
      }),
    ).toBe(false);
    expect(
      isWorkspaceQuestionIntentExplicitlyConfirmed({
        intent: "用户确认过的旧建议",
        intentRevision: 4,
        intentConfirmedRevision: 3,
        intentConfirmedAt: NOW,
        intentConfirmedByUserId: 7,
      }),
    ).toBe(false);
    expect(
      isWorkspaceQuestionIntentExplicitlyConfirmed({
        intent: "用户确认的当前建议",
        intentRevision: 4,
        intentConfirmedRevision: 4,
        intentConfirmedAt: NOW,
        intentConfirmedByUserId: 7,
      }),
    ).toBe(true);
  });

  it("keeps entitlement enforcement in compatibility mode until the migration queue is empty", () => {
    expect(
      resolveServiceEntitlementRolloutState({
        configuredMode: "auto",
        pendingUserCount: 3,
      }),
    ).toEqual({ mode: "compatibility", pendingUserCount: 3 });
    expect(
      resolveServiceEntitlementRolloutState({
        configuredMode: "auto",
        pendingUserCount: 0,
      }),
    ).toEqual({ mode: "enforced", pendingUserCount: 0 });
    expect(
      resolveServiceEntitlementRolloutState({
        configuredMode: "compatibility",
        pendingUserCount: 0,
      }).mode,
    ).toBe("compatibility");
    expect(
      resolveServiceEntitlementRolloutState({
        configuredMode: "enforced",
        pendingUserCount: 5,
      }).mode,
    ).toBe("enforced");
  });

  it("separates upgraded and expired questions into read-only history", () => {
    const questions: NonNullable<ServicePortalStateInput["selectedQuestions"]> =
      [
        {
          id: "question-basic-original",
          contractId: "contract-basic-old",
          quotaPeriodId: "period-basic-old",
          category: "reputation",
          question: "品牌是否值得信赖？",
          source: "website",
          status: "selected",
          locked: true,
          revision: 1,
        },
        {
          id: "question-advanced-carried",
          contractId: "contract-advanced-current",
          quotaPeriodId: "period-advanced-current",
          sourceQuestionId: "question-basic-original",
          category: "reputation",
          question: "品牌是否值得信赖？",
          source: "admin",
          status: "selected",
          locked: true,
          revision: 1,
        },
        {
          id: "question-luxury-last-month",
          contractId: "contract-advanced-current",
          quotaPeriodId: "period-advanced-old",
          category: "product_scenario",
          question: "上个周期的产品场景问题",
          source: "model",
          status: "selected",
          locked: true,
          revision: 1,
        },
        {
          id: "question-maintenance-archived",
          contractId: "contract-advanced-current",
          quotaPeriodId: "period-advanced-current",
          category: "industry",
          question: "由维护审批归档的原问题",
          source: "user",
          status: "archived",
          selectionApprovalStatus: "approved",
          locked: false,
          revision: 2,
        },
      ];

    const active = partitionSelectedQuestionsForPortal({
      questions,
      currentContractIds: ["contract-advanced-current"],
      activePeriodIds: ["period-advanced-current"],
      effectiveStatus: "active",
    });
    expect(active.current.map((question) => question.id)).toEqual([
      "question-advanced-carried",
    ]);
    expect(active.historical.map((question) => question.id)).toEqual([
      "question-basic-original",
      "question-luxury-last-month",
      "question-maintenance-archived",
    ]);

    const portal = deriveServicePortalState(
      state("advanced", {
        selectedQuestions: active.current,
        historicalQuestions: active.historical,
        quotaPeriod: {
          id: "period-advanced-current",
          contractId: "contract-advanced",
          userId: 7,
          ordinal: 1,
          startsAt: new Date("2026-07-01T00:00:00.000Z"),
          endsAt: new Date("2026-10-01T00:00:00.000Z"),
          industryLimit: 1,
          competitorComparisonLimit: 1,
          reputationLimit: 1,
          productScenarioLimit: 5,
          totalQuestionLimit: 8,
          revision: 1,
        },
      }),
    );
    expect(portal.purchasedQuestions).toHaveLength(1);
    expect(portal.historicalQuestions).toHaveLength(3);
    expect(portal.purchasedQuestions[0]).toMatchObject({
      id: "question-advanced-carried",
      sourceQuestionId: "question-basic-original",
    });
    expect(portal.quotas?.usage.total).toBe(1);
    expect(() => servicePortalSchema.parse(portal)).not.toThrow();

    const expired = partitionSelectedQuestionsForPortal({
      questions,
      currentContractIds: ["contract-advanced-current"],
      activePeriodIds: [],
      effectiveStatus: "expired",
    });
    expect(expired.current).toEqual([]);
    expect(expired.historical).toHaveLength(4);
  });

  it("keeps prior-month Luxury v2 questions current and counts usage by contract", () => {
    const luxury = contract("luxury", {
      id: "contract-luxury-v2",
      planVersion: 2,
      startsAt: new Date("2026-01-31T16:00:00.000Z"),
      endsAt: new Date("2027-01-31T16:00:00.000Z"),
    });
    const questions: NonNullable<ServicePortalStateInput["selectedQuestions"]> =
      [
        {
          id: "question-q1",
          contractId: luxury.id,
          quotaPeriodId: "period-month-1",
          category: "industry",
          question: "第一季度问题",
          source: "admin",
          status: "selected",
          locked: true,
          revision: 1,
        },
        {
          id: "question-q2",
          contractId: luxury.id,
          quotaPeriodId: "period-month-4",
          category: "industry",
          question: "第二季度问题",
          source: "admin",
          status: "selected",
          locked: true,
          revision: 1,
        },
      ];
    const partitioned = partitionSelectedQuestionsForPortal({
      questions,
      currentContractIds: [luxury.id],
      activePeriodIds: ["period-month-4"],
      effectiveStatus: "active",
      contract: luxury,
    });
    expect(partitioned.current.map((question) => question.id)).toEqual([
      "question-q1",
      "question-q2",
    ]);

    const portal = deriveServicePortalState(
      state("luxury", {
        now: new Date("2026-05-01T00:00:00.000Z"),
        contract: luxury,
        contracts: [luxury],
        quotaPeriod: {
          id: "period-month-4",
          contractId: luxury.id,
          userId: 7,
          ordinal: 4,
          startsAt: new Date("2026-04-30T16:00:00.000Z"),
          endsAt: new Date("2026-05-31T16:00:00.000Z"),
          industryLimit: 2,
          competitorComparisonLimit: 2,
          reputationLimit: 2,
          productScenarioLimit: 10,
          totalQuestionLimit: 16,
          revision: 1,
        },
        selectedQuestions: partitioned.current,
      }),
    );
    expect(portal.purchasedQuestions).toHaveLength(2);
    expect(portal.quotas).toMatchObject({
      limits: { industryLimit: 2, totalQuestionLimit: 16 },
      entitlementLimits: { industryLimit: 4, totalQuestionLimit: 32 },
      usage: { industry: 2, total: 2 },
      remaining: { industry: 0, total: 14 },
      unlockStage: { current: 2, total: 4 },
      capacityState: "available",
    });
  });

  it("switches a scheduled upgrade atomically and keeps only later supplemental Basic orders", () => {
    const original = contract("basic", {
      id: "basic-original",
      revision: 1,
      startsAt: new Date("2026-07-01T00:00:00.000Z"),
      endsAt: new Date("2026-08-30T00:00:00.000Z"),
    });
    const upgrade = contract("advanced", {
      id: "advanced-upgrade",
      revision: 2,
      status: "scheduled",
      startsAt: new Date("2026-08-01T00:00:00.000Z"),
      endsAt: new Date("2026-11-01T00:00:00.000Z"),
      replacesContractIds: [original.id],
    });
    const supplemental = contract("basic", {
      id: "basic-supplemental",
      revision: 3,
      startsAt: new Date("2026-08-03T00:00:00.000Z"),
      endsAt: new Date("2026-09-02T00:00:00.000Z"),
    });

    expect(
      selectCurrentServiceContractIds(
        [upgrade, original],
        new Date("2026-07-26T00:00:00.000Z"),
      ),
    ).toMatchObject({
      contract: { id: original.id },
      contractIds: [original.id],
    });
    expect(
      selectCurrentServiceContractIds(
        [supplemental, upgrade, original],
        new Date("2026-08-04T00:00:00.000Z"),
      ),
    ).toMatchObject({
      contract: { id: upgrade.id },
      contractIds: [upgrade.id, supplemental.id],
    });
    const portal = deriveServicePortalState({
      ...state("advanced"),
      now: new Date("2026-08-04T00:00:00.000Z"),
      contract: undefined,
      contracts: [supplemental, upgrade, original],
    });
    expect(
      portal.purchases.find((purchase) => purchase.id === original.id)?.status,
    ).toBe("superseded");
  });

  it("returns a safe unconfigured state for historical users", () => {
    const portal = deriveServicePortalState({
      userId: 7,
      now: NOW,
      account: {
        userId: 7,
        username: "legacy",
        displayName: "历史用户",
      },
    });

    expect(portal.revision).toBe(0);
    expect(portal.service).toMatchObject({
      planCode: null,
      planName: "待配置",
      status: "unconfigured",
    });
    expect(
      Object.values(portal.capabilities).every((value) => !value.allowed),
    ).toBe(true);
    expect(portal.nextAction.kind).toBe("await_service_configuration");
    expect(() => servicePortalSchema.parse(portal)).not.toThrow();
  });

  it.each([
    ["pending_confirmation", "pending_confirmation"],
    ["suspended", "suspended"],
    ["cancelled", "cancelled"],
  ] as Array<[PersistedServiceContractStatus, string]>)(
    "preserves %s as an effective business state",
    (stored, effective) => {
      expect(
        deriveEffectiveServiceStatus(
          contract("advanced", { status: stored }),
          NOW,
        ),
      ).toBe(effective);
    },
  );

  it("derives expiry from endsAt without mutating stored status", () => {
    const expired = contract("advanced", {
      status: "active",
      endsAt: new Date("2026-07-26T07:59:59.000Z"),
    });
    const portal = deriveServicePortalState(
      state("advanced", { contract: expired, contracts: [expired] }),
    );
    expect(portal.service.status).toBe("expired");
    expect(portal.purchases[0].status).toBe("expired");
    expect(portal.nextAction.kind).toBe("renew_service");
    expect(expired.status).toBe("active");
  });

  it("waits for Basic knowledge and its purchased question without inventing progress", () => {
    const waiting = deriveServicePortalState(state("basic"));
    expect(waiting.capabilities.knowledgeBuild.allowed).toBe(false);
    expect(waiting.capabilities.intentOptimization.allowed).toBe(true);
    expect(waiting.nextAction.kind).toBe("await_knowledge_import");
    expect(waiting.workflowSteps[0]).toMatchObject({
      id: "knowledge",
      status: "locked",
    });

    const ready = deriveServicePortalState(
      state("basic", { knowledgeVersion: 3 }),
    );
    expect(ready.knowledge).toMatchObject({
      version: 3,
      status: "display_ready",
    });
    expect(ready.nextAction.kind).toBe("await_question_import");
  });

  it("resumes an in-progress Advanced build before starting another", () => {
    expect(
      deriveServicePortalState(
        state("advanced", { hasActiveKnowledgeBuild: true }),
      ).nextAction.kind,
    ).toBe("resume_knowledge_build");
    expect(deriveServicePortalState(state("advanced")).nextAction.kind).toBe(
      "start_knowledge_build",
    );
  });

  it("advances one authoritative next action across real persisted outputs", () => {
    const selectedQuestion = {
      id: "question-basic",
      quotaPeriodId: "period-basic",
      category: "reputation" as const,
      question: "这家企业的品牌口碑如何？",
      intent: "模型建议：核验品牌口碑与事实证据",
      intentRevision: 1,
      source: "website" as const,
      status: "selected" as const,
      locked: true,
      revision: 1,
    };
    const withQuestion = {
      knowledgeVersion: 1,
      selectedQuestions: [selectedQuestion],
    };

    const responseLogic = deriveServicePortalState(
      state("basic", withQuestion),
    );
    expect(responseLogic.nextAction.kind).toBe("build_response_logic");
    expect(responseLogic.purchasedQuestions[0]).toMatchObject({
      intent: "模型建议：核验品牌口碑与事实证据",
      intentConfirmed: false,
    });
    expect(
      deriveServicePortalState(
        state("basic", {
          ...withQuestion,
          optimizedQuestionIds: [selectedQuestion.id],
        }),
      ).nextAction.kind,
    ).toBe("build_response_logic");
    expect(
      responseLogic.workflowSteps.some(
        (step) => step.id === "intent_optimization",
      ),
    ).toBe(false);
    expect(responseLogic.workflowSteps).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: "knowledge", status: "complete" }),
        expect.objectContaining({ id: "question", status: "complete" }),
        expect.objectContaining({
          id: "response_logic",
          status: "ready",
          nextAction: expect.objectContaining({
            kind: "build_response_logic",
          }),
        }),
        expect.objectContaining({
          id: "monitoring",
          status: "locked",
          nextAction: expect.objectContaining({
            kind: "build_response_logic",
          }),
        }),
      ]),
    );

    const commonOutputs = withQuestion;
    expect(
      deriveServicePortalState(state("basic", commonOutputs)).nextAction.kind,
    ).toBe("build_response_logic");
    expect(
      deriveServicePortalState(
        state("basic", {
          ...commonOutputs,
          confirmedResponseLogicQuestionIds: [selectedQuestion.id],
        }),
      ).nextAction.kind,
    ).toBe("await_monitoring_data");
    expect(
      deriveServicePortalState(
        state("basic", {
          ...commonOutputs,
          confirmedResponseLogicQuestionIds: [selectedQuestion.id],
          monitoringQuestionIds: [selectedQuestion.id],
        }),
      ).nextAction.kind,
    ).toBe("await_channel_distribution");
    expect(
      deriveServicePortalState(
        state("basic", {
          ...commonOutputs,
          confirmedResponseLogicQuestionIds: [selectedQuestion.id],
          monitoringQuestionIds: [selectedQuestion.id],
          channelDistributionQuestionIds: [selectedQuestion.id],
        }),
      ).nextAction.kind,
    ).toBe("await_progress_report");

    const complete = deriveServicePortalState(
      state("basic", {
        ...commonOutputs,
        confirmedResponseLogicQuestionIds: [selectedQuestion.id],
        monitoringQuestionIds: [selectedQuestion.id],
        channelDistributionQuestionIds: [selectedQuestion.id],
        hasProgressReport: true,
      }),
    );
    expect(complete.nextAction.kind).toBe("view_progress_report");
    expect(
      complete.workflowSteps.every((step) => step.status === "complete"),
    ).toBe(true);
    expect(() => servicePortalSchema.parse(complete)).not.toThrow();
  });

  it("unlocks monitoring after the first current question confirms response logic", async () => {
    const questions: NonNullable<ServicePortalStateInput["selectedQuestions"]> =
      [
        {
          id: "question-current-a",
          contractId: "contract-basic",
          quotaPeriodId: "period-basic-a",
          category: "reputation",
          question: "品牌是否值得信赖？",
          source: "website",
          status: "selected",
          locked: true,
          revision: 1,
        },
        {
          id: "question-current-b",
          contractId: "contract-basic",
          quotaPeriodId: "period-basic-b",
          category: "product_scenario",
          question: "产品适用于哪些业务场景？",
          source: "website",
          status: "selected",
          locked: true,
          revision: 1,
        },
      ];
    const partiallyConfirmed = state("basic", {
      knowledgeVersion: 1,
      selectedQuestions: questions,
      confirmedResponseLogicQuestionIds: [questions[0].id],
      monitoringQuestionIds: questions.map((question) => question.id),
    });
    const partialPortal = deriveServicePortalState(partiallyConfirmed);

    expect(partialPortal.nextAction.kind).toBe("build_response_logic");
    expect(partialPortal.workflowSteps).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "response_logic",
          status: "ready",
        }),
        expect.objectContaining({
          id: "monitoring",
          status: "ready",
          lockedReason: null,
        }),
      ]),
    );
    await expect(
      assertServiceCapability(7, "monitoring", {
        now: NOW,
        repository: repository(partiallyConfirmed),
      }),
    ).resolves.toMatchObject({
      workflowSteps: expect.arrayContaining([
        expect.objectContaining({ id: "monitoring", status: "ready" }),
      ]),
    });

    const fullyConfirmed = {
      ...partiallyConfirmed,
      confirmedResponseLogicQuestionIds: questions.map(
        (question) => question.id,
      ),
      monitoringQuestionIds: [],
    };
    const readyPortal = deriveServicePortalState(fullyConfirmed);
    expect(readyPortal.nextAction.kind).toBe("await_monitoring_data");
    expect(
      readyPortal.workflowSteps.find((step) => step.id === "monitoring"),
    ).toMatchObject({ status: "ready", lockedReason: null });
    await expect(
      assertServiceCapability(7, "monitoring", {
        now: NOW,
        repository: repository(fullyConfirmed),
      }),
    ).resolves.toMatchObject({
      nextAction: { kind: "await_monitoring_data" },
    });
  });

  it("does not inherit archived outputs when a replacement points to the old question", () => {
    const replacement = {
      id: "question-new",
      sourceQuestionId: "question-old",
      contractId: "contract-basic",
      quotaPeriodId: "period-basic",
      category: "reputation" as const,
      question: "修改后的品牌问题？",
      source: "user" as const,
      status: "selected" as const,
      selectionApprovalStatus: "approved" as const,
      locked: true,
      revision: 1,
    };
    const projected = deriveServicePortalState(
      state("basic", {
        knowledgeVersion: 1,
        selectedQuestions: [replacement],
        confirmedResponseLogicQuestionIds: ["question-old"],
        monitoringQuestionIds: ["question-old"],
        channelDistributionQuestionIds: ["question-old"],
      }),
    );

    expect(projected.purchasedQuestions[0]).toMatchObject({
      id: "question-new",
      sourceQuestionId: "question-old",
      responseLogicConfirmed: false,
    });
    expect(projected.workflowSteps).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: "response_logic", status: "ready" }),
        expect.objectContaining({ id: "monitoring", status: "locked" }),
      ]),
    );
    expect(projected.nextAction.kind).toBe("build_response_logic");
  });

  it("keeps a legacy one-shot snapshot as reference only until the higher-plan agent publishes", () => {
    const oneShotOnly = deriveServicePortalState(
      state("advanced", { knowledgeVersion: 1 }),
    );
    expect(oneShotOnly.knowledge).toMatchObject({
      version: 1,
      status: "display_ready",
      authenticatedVersion: null,
      authenticatedForCurrentService: false,
    });
    expect(oneShotOnly.workflowSteps[0]).toMatchObject({
      id: "knowledge",
      label: "知识库智能体",
      status: "ready",
    });
    expect(oneShotOnly.nextAction.kind).toBe("start_knowledge_build");
    expect(oneShotOnly.capabilities.contentAssets).toMatchObject({
      allowed: false,
      effectiveStatus: "workflow_prerequisite",
      reason: expect.stringContaining("当前服务的认证知识库"),
    });

    expect(
      deriveServicePortalState(
        state("advanced", {
          knowledgeVersion: 2,
          authenticatedKnowledgeVersion: 2,
        }),
      ).nextAction.kind,
    ).toBe("await_question_catalog");
    expect(
      deriveServicePortalState(
        state("advanced", {
          knowledgeVersion: 2,
          authenticatedKnowledgeVersion: 2,
        }),
      ).capabilities.contentAssets,
    ).toMatchObject({ allowed: true, effectiveStatus: "available" });
    expect(
      deriveServicePortalState(
        state("advanced", {
          knowledgeVersion: 2,
          authenticatedKnowledgeVersion: 2,
          currentPeriodCandidateCount: 24,
        }),
      ).nextAction.kind,
    ).toBe("select_service_questions");
  });

  it("waits for monitoring-engineer confirmation, then opens the first approved question without requiring a full quota", () => {
    const waiting = deriveServicePortalState(
      state("advanced", {
        knowledgeVersion: 2,
        authenticatedKnowledgeVersion: 2,
        currentPeriodCandidateCount: 4,
        currentPeriodPendingApprovalCount: 1,
      }),
    );
    expect(waiting.nextAction).toMatchObject({
      kind: "await_question_confirmation",
      label: "等待监控工程师确认启动问题",
    });
    expect(waiting.purchasedQuestions).toHaveLength(0);

    const approved = deriveServicePortalState(
      state("advanced", {
        knowledgeVersion: 2,
        authenticatedKnowledgeVersion: 2,
        currentPeriodCandidateCount: 3,
        selectedQuestions: [
          {
            id: "approved-first-question",
            contractId: "contract-advanced",
            quotaPeriodId: "period-advanced",
            category: "industry",
            question: "企业级 GEO 服务商如何选择？",
            source: "user",
            status: "selected",
            selectionApprovalStatus: "approved",
            selectionRequestedAt: NOW,
            selectionApprovedAt: NOW,
            locked: true,
            revision: 2,
          },
        ],
      }),
    );
    expect(approved.nextAction.kind).toBe("build_response_logic");
    expect(
      approved.workflowSteps.find((step) => step.id === "response_logic"),
    ).toMatchObject({ status: "ready", lockedReason: null });
  });

  it("does not disguise persisted selected-question approval or lock state", () => {
    const portal = deriveServicePortalState(
      state("advanced", {
        selectedQuestions: [
          {
            id: "inconsistent-selected-question",
            contractId: "contract-advanced",
            quotaPeriodId: "period-advanced",
            category: "industry",
            question: "企业级 GEO 服务商如何选择？",
            source: "user",
            status: "selected",
            selectionApprovalStatus: "pending",
            selectionRequestedAt: NOW,
            selectionApprovedAt: null,
            locked: false,
            revision: 2,
          },
        ],
      }),
    );

    expect(portal.purchasedQuestions[0]).toMatchObject({
      status: "selected",
      selectionApprovalStatus: "pending",
      locked: false,
    });
  });

  it("aggregates concurrent Basic purchases without losing either quota or question", () => {
    const first = contract("basic", {
      id: "basic-order-a",
      revision: 1,
      startsAt: new Date("2026-07-01T00:00:00.000Z"),
      endsAt: new Date("2026-07-31T00:00:00.000Z"),
    });
    const second = contract("basic", {
      id: "basic-order-b",
      revision: 2,
      startsAt: new Date("2026-07-20T00:00:00.000Z"),
      endsAt: new Date("2026-08-19T00:00:00.000Z"),
    });
    const limits = SERVICE_PLAN_CATALOG.basic.limits;
    const portal = deriveServicePortalState(
      state("basic", {
        contract: undefined,
        contracts: [second, first],
        quotaPeriod: undefined,
        quotaPeriods: [
          {
            id: "period-a",
            contractId: first.id,
            userId: 7,
            ordinal: 1,
            startsAt: first.startsAt,
            endsAt: first.endsAt,
            ...limits,
            revision: 1,
          },
          {
            id: "period-b",
            contractId: second.id,
            userId: 7,
            ordinal: 1,
            startsAt: second.startsAt,
            endsAt: second.endsAt,
            ...limits,
            revision: 1,
          },
        ],
        selectedQuestions: [
          {
            id: "question-a",
            quotaPeriodId: "period-a",
            category: "reputation",
            question: "问题 A",
            intent: "验证品牌口碑",
            rationale: "用户正在比较可信度",
            evidence: [
              {
                documentPath: "brand/awards.md",
                excerpt: "连续三年获得行业奖项",
                relevance: "支撑品牌可信度",
              },
            ],
            risks: ["奖项年份需要定期复核"],
            source: "website",
            status: "selected",
            locked: true,
            revision: 1,
          },
          {
            id: "question-b",
            quotaPeriodId: "period-b",
            category: "product_scenario",
            question: "问题 B",
            source: "website",
            status: "selected",
            locked: true,
            revision: 1,
          },
        ],
      }),
    );

    expect(portal.service).toMatchObject({
      planCode: "basic",
      status: "active",
      validUntil: second.endsAt.getTime(),
    });
    expect(portal.revision).toBe(2);
    expect(portal.quotas).toMatchObject({
      limits: { totalQuestionLimit: 2 },
      usage: { total: 2 },
    });
    expect(portal.quotaPeriods).toHaveLength(2);
    expect(portal.quotaPeriods.map((period) => period.usage.total)).toEqual([
      1, 1,
    ]);
    expect(portal.purchasedQuestions).toHaveLength(2);
    expect(portal.purchasedQuestions[0]).toMatchObject({
      intent: "验证品牌口碑",
      rationale: "用户正在比较可信度",
      evidence: [
        {
          documentPath: "brand/awards.md",
          excerpt: "连续三年获得行业奖项",
          relevance: "支撑品牌可信度",
        },
      ],
      risks: ["奖项年份需要定期复核"],
    });
    expect(portal.purchases).toHaveLength(2);
    expect(() => servicePortalSchema.parse(portal)).not.toThrow();
  });
});

describe("capability assertions", () => {
  it("does not 403 legacy unconfigured users before the rollout queue is cleared", async () => {
    await expect(
      assertServiceCapability(7, "knowledgeDisplay", {
        now: NOW,
        repository: repository({
          userId: 7,
          now: NOW,
          entitlementRollout: {
            mode: "compatibility",
            pendingUserCount: 2,
          },
        }),
      }),
    ).resolves.toMatchObject({
      service: { status: "unconfigured" },
      entitlementRollout: {
        mode: "compatibility",
        pendingUserCount: 2,
      },
    });
    await expect(
      assertServiceCapability(7, "contentAssets", {
        now: NOW,
        repository: repository({
          userId: 7,
          now: NOW,
          entitlementRollout: {
            mode: "compatibility",
            pendingUserCount: 2,
          },
        }),
      }),
    ).rejects.toMatchObject({ code: "KNOWLEDGE_SNAPSHOT_NOT_FOUND" });
  });

  it("uses stable error codes for unconfigured, expired and upgrade states", async () => {
    await expect(
      assertServiceCapability(7, "knowledgeDisplay", {
        now: NOW,
        repository: repository({ userId: 7, now: NOW }),
      }),
    ).rejects.toMatchObject({ code: "SERVICE_PLAN_UNCONFIGURED" });

    const expired = contract("advanced", {
      endsAt: new Date("2026-07-01T00:00:00.000Z"),
    });
    await expect(
      assertServiceCapability(7, "monitoring", {
        now: NOW,
        repository: repository(
          state("advanced", { contract: expired, contracts: [expired] }),
        ),
      }),
    ).rejects.toMatchObject({ code: "SERVICE_PLAN_EXPIRED" });

    await expect(
      assertServiceCapability(7, "knowledgeBuild", {
        now: NOW,
        repository: repository(state("basic")),
      }),
    ).rejects.toMatchObject({ code: "CAPABILITY_UPGRADE_REQUIRED" });
  });

  it("allows Basic's complete purchased-question workflow", async () => {
    const selectedQuestion = {
      id: "basic-purchased-question",
      contractId: "contract-basic",
      quotaPeriodId: "period-basic",
      category: "product_scenario" as const,
      question: "企业官网怎样成为 AI 可引用的权威信源？",
      source: "website" as const,
      status: "selected" as const,
      locked: true,
      revision: 1,
    };
    await expect(
      assertServiceCapability(7, "monitoring", {
        now: NOW,
        repository: repository(
          state("basic", {
            knowledgeVersion: 1,
            selectedQuestions: [
              {
                ...selectedQuestion,
                intent: "核验官网是否具备可引用的权威事实与证据",
                intentRevision: 1,
                intentConfirmedRevision: 1,
                intentConfirmedAt: NOW,
                intentConfirmedByUserId: 7,
              },
            ],
            confirmedResponseLogicQuestionIds: [selectedQuestion.id],
          }),
        ),
      }),
    ).resolves.toMatchObject({
      service: { planCode: "basic", status: "active" },
      capabilities: { monitoring: { allowed: true } },
    });
  });

  it("blocks higher-plan generation and selection when only a website prefill exists", async () => {
    const oneShotOnly = state("advanced", { knowledgeVersion: 1 });
    await expect(
      assertServiceCapability(7, "globalKeywords", {
        now: NOW,
        repository: repository(oneShotOnly),
      }),
    ).rejects.toMatchObject({ code: "KNOWLEDGE_SNAPSHOT_NOT_FOUND" });
    await expect(
      assertServiceCapability(7, "questionSelection", {
        now: NOW,
        repository: repository(oneShotOnly),
      }),
    ).rejects.toMatchObject({ code: "KNOWLEDGE_SNAPSHOT_NOT_FOUND" });
    await expect(
      assertServiceCapability(7, "globalKeywords", {
        now: NOW,
        repository: repository(
          state("advanced", {
            knowledgeVersion: 2,
            authenticatedKnowledgeVersion: 2,
          }),
        ),
      }),
    ).resolves.toMatchObject({
      knowledge: { authenticatedForCurrentService: true },
    });
  });

  it("blocks Basic content assets by plan and higher plans until knowledge publication", async () => {
    await expect(
      assertServiceCapability(7, "contentAssets", {
        now: NOW,
        repository: repository(state("basic")),
      }),
    ).rejects.toMatchObject({ code: "CAPABILITY_UPGRADE_REQUIRED" });
    await expect(
      assertServiceCapability(7, "contentAssets", {
        now: NOW,
        repository: repository(state("basic", { knowledgeVersion: 1 })),
      }),
    ).rejects.toMatchObject({ code: "CAPABILITY_UPGRADE_REQUIRED" });
    await expect(
      assertServiceCapability(7, "contentAssets", {
        now: NOW,
        repository: repository(
          state("advanced", {
            knowledgeVersion: 1,
            authenticatedKnowledgeVersion: null,
          }),
        ),
      }),
    ).rejects.toMatchObject({ code: "KNOWLEDGE_SNAPSHOT_NOT_FOUND" });
  });

  it("blocks brand tracking for Basic while keeping it in higher-plan service scope", async () => {
    await expect(
      assertServiceCapability(7, "brandTracking", {
        now: NOW,
        repository: repository(state("basic", { knowledgeVersion: 1 })),
      }),
    ).rejects.toMatchObject({ code: "CAPABILITY_UPGRADE_REQUIRED" });
    await expect(
      assertServiceCapability(7, "brandTracking", {
        now: NOW,
        repository: repository(state("advanced", { knowledgeVersion: 1 })),
      }),
    ).resolves.toMatchObject({
      service: { planCode: "advanced" },
      capabilities: { brandTracking: { allowed: true } },
    });
  });
});

describe("question lifecycle rules", () => {
  it("allows one Basic non-industry question and rejects industry/second questions", () => {
    const limits = SERVICE_PLAN_CATALOG.basic.limits;
    expect(() =>
      assertQuestionSelectionWithinQuota({
        limits,
        usage: {
          industry: 0,
          competitorComparison: 0,
          reputation: 0,
          productScenario: 0,
          total: 0,
        },
        category: "reputation",
      }),
    ).not.toThrow();
    expect(() =>
      assertQuestionSelectionWithinQuota({
        limits,
        usage: {
          industry: 0,
          competitorComparison: 0,
          reputation: 0,
          productScenario: 0,
          total: 0,
        },
        category: "industry",
      }),
    ).toThrowError(
      expect.objectContaining({ code: "QUESTION_CATEGORY_QUOTA_EXCEEDED" }),
    );
    expect(() =>
      assertQuestionSelectionWithinQuota({
        limits,
        usage: {
          industry: 0,
          competitorComparison: 1,
          reputation: 0,
          productScenario: 0,
          total: 1,
        },
        category: "reputation",
      }),
    ).toThrowError(
      expect.objectContaining({ code: "QUESTION_TOTAL_QUOTA_EXCEEDED" }),
    );
  });

  it("only treats unlocked, unselected model candidates as replaceable", () => {
    expect(
      isReplaceableModelCandidate({
        source: "model",
        status: "candidate",
        selectionApprovalStatus: "not_requested",
        locked: false,
      }),
    ).toBe(true);
    for (const value of [
      {
        source: "model",
        status: "candidate",
        selectionApprovalStatus: "pending",
        locked: false,
      },
      {
        source: "model",
        status: "selected",
        selectionApprovalStatus: "approved",
        locked: false,
      },
      {
        source: "model",
        status: "candidate",
        selectionApprovalStatus: "not_requested",
        locked: true,
      },
      {
        source: "admin",
        status: "candidate",
        selectionApprovalStatus: "not_requested",
        locked: false,
      },
      {
        source: "model",
        status: "archived",
        selectionApprovalStatus: "not_requested",
        locked: false,
      },
    ] as const) {
      expect(isReplaceableModelCandidate(value)).toBe(false);
    }
  });

  it("normalizes candidate intent, evidence and risks for durable rendering", () => {
    const [candidate] = normalizeGeneratedQuestionCandidates([
      {
        category: "product_scenario",
        question: "  哪种设备适合高温车间？ ",
        intent: "  场景适配判断 ",
        rationale: "  需要用产品边界解释 ",
        evidence: [
          {
            documentPath: " specs/temperature.md ",
            excerpt: " 额定工作温度为 80℃ ",
            relevance: " 直接回答环境限制 ",
          },
        ],
        risks: [" 不要把额定值描述为实测极限 "],
      },
    ]);

    expect(candidate).toMatchObject({
      category: "product_scenario",
      question: "哪种设备适合高温车间？",
      intent: "场景适配判断",
      rationale: "需要用产品边界解释",
      evidence: [
        {
          documentPath: "specs/temperature.md",
          excerpt: "额定工作温度为 80℃",
          relevance: "直接回答环境限制",
        },
      ],
      risks: ["不要把额定值描述为实测极限"],
    });
  });

  it("rejects candidate persistence after quota revision or remaining slots change", () => {
    const period = {
      revision: 4,
      industryLimit: 1,
      competitorComparisonLimit: 1,
      reputationLimit: 1,
      productScenarioLimit: 5,
      totalQuestionLimit: 8,
    };
    const selectedUsage = {
      industry: 0,
      competitorComparison: 0,
      reputation: 0,
      productScenario: 0,
      total: 0,
    };
    const expected = {
      revision: 4,
      remaining: {
        industry: 1,
        competitorComparison: 1,
        reputation: 1,
        productScenario: 5,
      },
    };

    expect(
      assertGeneratedQuestionQuotaContextCurrent({
        period,
        selectedUsage,
        expected,
      }),
    ).toMatchObject(expected.remaining);
    for (const stale of [
      { period: { ...period, revision: 5 }, selectedUsage },
      {
        period,
        selectedUsage: { ...selectedUsage, productScenario: 1, total: 1 },
      },
    ]) {
      expect(() =>
        assertGeneratedQuestionQuotaContextCurrent({
          ...stale,
          expected,
        }),
      ).toThrowError(
        expect.objectContaining({
          code: "QUESTION_GENERATION_CONTEXT_STALE",
        }),
      );
    }
  });

  it("recognizes legacy missing-table errors through wrapped causes", () => {
    expect(
      isMissingServicePortalTableError({
        cause: { code: "ER_NO_SUCH_TABLE", errno: 1146 },
      }),
    ).toBe(true);
    expect(
      isMissingServicePortalTableError(new Error("connection reset")),
    ).toBe(false);
  });

  it("does not let an old progress report complete a renewed quota period", () => {
    expect(
      everyActiveQuotaPeriodHasProgressReport(
        ["period-current"],
        ["period-previous"],
      ),
    ).toBe(false);
    expect(
      everyActiveQuotaPeriodHasProgressReport(
        ["period-basic-1", "period-basic-2"],
        ["period-basic-1"],
      ),
    ).toBe(false);
    expect(
      everyActiveQuotaPeriodHasProgressReport(
        ["period-basic-1", "period-basic-2"],
        ["period-basic-2", "period-basic-1"],
      ),
    ).toBe(true);
  });

  it("exposes entitlement failures as typed errors", () => {
    const error = new ServiceEntitlementError(
      "QUESTION_TOTAL_QUOTA_EXCEEDED",
      "额度不足",
    );
    expect(error).toBeInstanceOf(Error);
    expect(error.code).toBe("QUESTION_TOTAL_QUOTA_EXCEEDED");
  });
});
