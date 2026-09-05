import { beforeEach, describe, expect, it, vi } from "vitest";

import type { TrpcContext } from "./_core/context";
import type { AuthenticatedUser } from "./auth-service";
import {
  servicePortalSchema,
  servicePortalQuestionSchema,
} from "../shared/service-portal";

const mocks = vi.hoisted(() => ({
  getManagedCredentialStatus: vi.fn(),
  getServicePortal: vi.fn(),
  listWorkspaceQuestions: vi.fn(),
  updateWorkspaceQuestionBySystemAdmin: vi.fn(),
  approveWorkspaceQuestionSelection: vi.fn(),
  assertServiceCapability: vi.fn(),
  writeWorkspaceAuditEvent: vi.fn(),
  completeQuestionReviewRequest: vi.fn(),
  reconcileInitialMonitoringAfterQuestionSelection: vi.fn(),
}));

vi.mock("./dashboard-service", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./dashboard-service")>();
  return {
    ...actual,
    getManagedCredentialStatus: mocks.getManagedCredentialStatus,
  };
});

vi.mock("./service-entitlement", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./service-entitlement")>();
  return {
    ...actual,
    getServicePortal: mocks.getServicePortal,
    listWorkspaceQuestions: mocks.listWorkspaceQuestions,
    updateWorkspaceQuestionBySystemAdmin:
      mocks.updateWorkspaceQuestionBySystemAdmin,
    approveWorkspaceQuestionSelection: mocks.approveWorkspaceQuestionSelection,
    assertServiceCapability: mocks.assertServiceCapability,
  };
});

vi.mock("./admin-control-plane-service", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("./admin-control-plane-service")>();
  return {
    ...actual,
    writeWorkspaceAuditEvent: mocks.writeWorkspaceAuditEvent,
  };
});

vi.mock("./question-maintenance-service", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("./question-maintenance-service")>();
  return {
    ...actual,
    completeQuestionReviewRequest: mocks.completeQuestionReviewRequest,
  };
});

vi.mock("./delivery-role-service", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("./delivery-role-service")>();
  return {
    ...actual,
    reconcileInitialMonitoringAfterQuestionSelection:
      mocks.reconcileInitialMonitoringAfterQuestionSelection,
  };
});

import { adminRouter } from "./admin-router";

const question = servicePortalQuestionSchema.parse({
  id: "question-1",
  contractId: "contract-internal",
  quotaPeriodId: "period-internal",
  externalQuestionId: null,
  sourceQuestionId: null,
  category: "reputation",
  question: "企业是否值得长期合作？",
  intent: "核验可信度",
  intentRevision: 1,
  intentConfirmedRevision: null,
  intentConfirmedAt: null,
  intentConfirmed: false,
  rationale: null,
  evidence: [],
  risks: [],
  source: "admin",
  status: "candidate",
  selectionApprovalStatus: "pending",
  selectionRequestedAt: Date.parse("2026-07-28T08:00:00.000Z"),
  selectionApprovedAt: null,
  locked: false,
  revision: 2,
});

const capability = {
  allowed: true,
  effectiveStatus: "available" as const,
  reason: null,
};

const portal = servicePortalSchema.parse({
  schemaVersion: 1,
  revision: 3,
  entitlementRollout: {
    mode: "enforced",
    pendingUserCount: 0,
  },
  account: {
    userId: 7,
    username: "managed.customer",
    displayName: "接管客户",
  },
  service: {
    contractId: "contract-internal",
    planCode: "advanced",
    planName: "进阶版",
    status: "active",
    validFrom: Date.parse("2026-07-01T00:00:00.000Z"),
    validUntil: Date.parse("2026-10-01T00:00:00.000Z"),
    billingLabel: "季度服务",
    source: "admin",
  },
  quotas: {
    periodId: "period-internal",
    contractId: "contract-internal",
    validFrom: Date.parse("2026-07-01T00:00:00.000Z"),
    validUntil: Date.parse("2026-10-01T00:00:00.000Z"),
    revision: 1,
    limits: {
      industryLimit: 1,
      competitorComparisonLimit: 1,
      reputationLimit: 1,
      productScenarioLimit: 5,
      totalQuestionLimit: 8,
    },
    usage: {
      industry: 0,
      competitorComparison: 0,
      reputation: 0,
      productScenario: 0,
      total: 0,
    },
    remaining: {
      industry: 1,
      competitorComparison: 1,
      reputation: 1,
      productScenario: 5,
      total: 8,
    },
  },
  quotaPeriods: [
    {
      periodId: "period-internal",
      contractId: "contract-internal",
      validFrom: Date.parse("2026-07-01T00:00:00.000Z"),
      validUntil: Date.parse("2026-10-01T00:00:00.000Z"),
      revision: 1,
      limits: {
        industryLimit: 1,
        competitorComparisonLimit: 1,
        reputationLimit: 1,
        productScenarioLimit: 5,
        totalQuestionLimit: 8,
      },
      usage: {
        industry: 0,
        competitorComparison: 0,
        reputation: 0,
        productScenario: 0,
        total: 0,
      },
      remaining: {
        industry: 1,
        competitorComparison: 1,
        reputation: 1,
        productScenario: 5,
        total: 8,
      },
    },
  ],
  purchases: [
    {
      id: "purchase-internal",
      planCode: "advanced",
      planName: "进阶版",
      purchasedAt: Date.parse("2026-07-01T00:00:00.000Z"),
      validFrom: Date.parse("2026-07-01T00:00:00.000Z"),
      validUntil: Date.parse("2026-10-01T00:00:00.000Z"),
      status: "active",
      amountFen: 8_940_000,
      currency: "CNY",
      prepaidMonths: 3,
      orderReference: "order-internal",
      contractReference: "contract-reference-internal",
      signedAt: Date.parse("2026-06-30T00:00:00.000Z"),
      signatoryId: "signatory-internal",
      hasSigningEvidence: true,
      revision: 1,
    },
  ],
  knowledge: {
    version: 1,
    authenticatedVersion: 1,
    authenticatedForCurrentService: true,
    status: "display_ready",
    latestImportStatus: "completed",
  },
  purchasedQuestions: [question],
  historicalQuestions: [],
  capabilities: {
    knowledgeBuild: capability,
    knowledgeDisplay: capability,
    globalKeywords: capability,
    questionSelection: capability,
    intentOptimization: capability,
    responseLogic: capability,
    monitoring: capability,
    channelDistribution: capability,
    progressReport: capability,
    contentAssets: capability,
    brandTracking: capability,
  },
  workflowSteps: [],
  nextAction: {
    kind: "view_knowledge",
    label: "查看知识库",
    href: "/knowledge",
  },
});

function context(
  adminAccessLevel: "system_admin" | "delivery_admin",
): TrpcContext {
  const now = new Date("2026-07-28T08:00:00.000Z");
  const user: AuthenticatedUser = {
    id: adminAccessLevel === "system_admin" ? 1 : 42,
    openId: null,
    username:
      adminAccessLevel === "system_admin"
        ? "system.manager"
        : "delivery.manager",
    displayName: "管理员",
    name: "管理员",
    email: null,
    loginMethod: "password",
    role: "admin",
    adminAccessLevel,
    isActive: true,
    createdAt: now,
    updatedAt: now,
    lastSignedIn: now,
  };
  return {
    user,
    req: {} as TrpcContext["req"],
    res: {} as TrpcContext["res"],
  };
}

describe("administrator workspace DTO boundary", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getManagedCredentialStatus.mockResolvedValue({ configured: true });
    mocks.getServicePortal.mockResolvedValue(portal);
    mocks.listWorkspaceQuestions.mockResolvedValue([question]);
    mocks.updateWorkspaceQuestionBySystemAdmin.mockResolvedValue(question);
    mocks.approveWorkspaceQuestionSelection.mockImplementation(
      async (_input, options) => {
        const approvedQuestion = {
          ...question,
          status: "selected",
          selectionApprovalStatus: "approved",
        };
        await options?.afterWrite?.("transaction", approvedQuestion);
        return approvedQuestion;
      },
    );
    mocks.assertServiceCapability.mockResolvedValue(undefined);
    mocks.writeWorkspaceAuditEvent.mockResolvedValue(undefined);
    mocks.completeQuestionReviewRequest.mockResolvedValue(undefined);
    mocks.reconcileInitialMonitoringAfterQuestionSelection.mockResolvedValue({
      id: "initial-monitoring-ticket",
      created: true,
    });
  });

  it("returns a strict public service DTO to an assigned delivery administrator", async () => {
    const caller = adminRouter.createCaller(context("delivery_admin"));
    const value = await caller.workspace.service({ userId: 7 });

    expect(mocks.getManagedCredentialStatus).toHaveBeenCalledWith(
      context("delivery_admin").user,
      7,
    );
    expect(value).not.toHaveProperty("purchases");
    expect(value).not.toHaveProperty("quotaPeriods");
    expect(value.service).not.toHaveProperty("contractId");
    expect(value.service).not.toHaveProperty("source");
    expect(value.quotas).not.toHaveProperty("contractId");
    expect(JSON.stringify(value)).not.toContain("amountFen");
    expect(JSON.stringify(value)).not.toContain("order-internal");
    expect(JSON.stringify(value)).not.toContain("signatory-internal");
  });

  it("keeps the full internal service DTO for a system administrator", async () => {
    const caller = adminRouter.createCaller(context("system_admin"));
    const value = await caller.workspace.service({ userId: 7 });

    expect(value).toMatchObject({
      service: {
        contractId: "contract-internal",
        source: "admin",
      },
      purchases: [
        {
          amountFen: 8_940_000,
          orderReference: "order-internal",
          contractReference: "contract-reference-internal",
          signatoryId: "signatory-internal",
        },
      ],
    });
  });

  it("keeps delivery-admin question access read-only", async () => {
    const deliveryCaller = adminRouter.createCaller(context("delivery_admin"));
    const portfolio = await deliveryCaller.workspace.questionPortfolio({
      userId: 7,
    });
    await expect(
      deliveryCaller.workspace.updateQuestion({
        userId: 7,
        questionId: question.id,
        expectedRevision: question.revision,
        question: question.question,
      }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(
      deliveryCaller.workspace.confirmQuestionSelection({
        userId: 7,
        questionId: question.id,
        expectedRevision: question.revision,
      }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });

    const systemCaller = adminRouter.createCaller(context("system_admin"));
    const updated = await systemCaller.workspace.updateQuestion({
      userId: 7,
      questionId: question.id,
      expectedRevision: question.revision,
      question: question.question,
    });
    const confirmed = await systemCaller.workspace.confirmQuestionSelection({
      userId: 7,
      questionId: question.id,
      expectedRevision: question.revision,
    });

    expect(portfolio.questions[0]).not.toHaveProperty("contractId");
    expect(portfolio.questions[0]).not.toHaveProperty("quotaPeriodId");
    expect(updated.question).toHaveProperty("contractId");
    expect(confirmed.question).toHaveProperty("quotaPeriodId");
    expect(mocks.completeQuestionReviewRequest).toHaveBeenCalledWith(
      expect.objectContaining({
        executor: "transaction",
        userId: 7,
        questionId: question.id,
      }),
    );
    expect(
      mocks.reconcileInitialMonitoringAfterQuestionSelection,
    ).toHaveBeenCalledWith(
      expect.objectContaining({
        actorUserId: 1,
        question: expect.objectContaining({
          id: question.id,
          status: "selected",
          selectionApprovalStatus: "approved",
        }),
      }),
    );
  });

  it("keeps internal question linkage for system-admin operations", async () => {
    const caller = adminRouter.createCaller(context("system_admin"));
    const portfolio = await caller.workspace.questionPortfolio({ userId: 7 });
    const updated = await caller.workspace.updateQuestion({
      userId: 7,
      questionId: question.id,
      expectedRevision: question.revision,
      question: question.question,
    });

    expect(portfolio.questions[0]).toMatchObject({
      contractId: "contract-internal",
      quotaPeriodId: "period-internal",
    });
    expect(updated.question).toMatchObject({
      contractId: "contract-internal",
      quotaPeriodId: "period-internal",
    });
  });
});
