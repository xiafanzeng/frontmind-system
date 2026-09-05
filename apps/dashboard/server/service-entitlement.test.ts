import { describe, expect, it } from "vitest";

import {
  SERVICE_PLAN_CATALOG,
  servicePortalSchema,
  toPublicServicePortal,
  type ServicePlanCode,
} from "../shared/service-portal";
import {
  ServiceEntitlementError,
  assertQuestionSelectionWithinQuota,
  assertServiceCapability,
  createServiceQuotaWindows,
  deriveEffectiveServiceStatus,
  deriveServicePortalState,
  everyActiveQuotaPeriodHasProgressReport,
  getServiceContractTermEnd,
  isMissingServicePortalTableError,
  isReplaceableModelCandidate,
  isWorkspaceQuestionIntentExplicitlyConfirmed,
  normalizeGeneratedQuestionCandidates,
  partitionSelectedQuestionsForPortal,
  resolveServiceEntitlementRolloutState,
  selectCurrentServiceContractIds,
  type PersistedServiceContractStatus,
  type ServiceEntitlementRepository,
  type ServicePortalContractRecord,
  type ServicePortalStateInput,
} from "./service-entitlement";

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
      contractTerm: { unit: "month", count: 3 },
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
      contentAssets: true,
    });
  });

  it("creates one full-term window except for Luxury's three monthly windows", () => {
    const start = new Date("2026-01-31T05:30:00.000Z");
    expect(getServiceContractTermEnd("basic", start).toISOString()).toBe(
      "2026-03-02T05:30:00.000Z",
    );
    expect(createServiceQuotaWindows("basic", start)).toHaveLength(1);
    expect(createServiceQuotaWindows("advanced", start)).toHaveLength(1);

    const luxury = createServiceQuotaWindows("luxury", start);
    expect(luxury.map((window) => window.startsAt.toISOString())).toEqual([
      "2026-01-31T05:30:00.000Z",
      "2026-02-28T05:30:00.000Z",
      "2026-03-31T05:30:00.000Z",
    ]);
    expect(luxury.map((window) => window.endsAt.toISOString())).toEqual([
      "2026-02-28T05:30:00.000Z",
      "2026-03-31T05:30:00.000Z",
      "2026-04-30T05:30:00.000Z",
    ]);
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
    expect(portal.historicalQuestions).toHaveLength(2);
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
    expect(expired.historical).toHaveLength(3);
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

  it("unlocks monitoring only after every current question has confirmed response logic", async () => {
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
      // Monitoring rows cannot bypass an unfinished response-logic gate.
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
          status: "locked",
          lockedReason: "请先在应答逻辑智能体逐题发布确认。",
        }),
      ]),
    );
    await expect(
      assertServiceCapability(7, "monitoring", {
        now: NOW,
        repository: repository(partiallyConfirmed),
      }),
    ).rejects.toMatchObject({
      code: "SERVICE_WORKFLOW_PREREQUISITE_REQUIRED",
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
