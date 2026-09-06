import { beforeEach, describe, expect, it, vi } from "vitest";

import type { TrpcContext } from "./_core/context";
import type { AuthenticatedUser } from "./auth-service";
import {
  servicePortalQuestionSchema,
  type ServicePortal,
} from "../shared/service-portal";

const mocks = vi.hoisted(() => ({
  getDashboardWorkspace: vi.fn(),
  getServicePortal: vi.fn(),
  listWorkspaceQuestions: vi.fn(),
  requestWorkspaceQuestionSelection: vi.fn(),
  confirmWorkspaceBrandKeywordSelection: vi.fn(),
  confirmWorkspaceQuestionIntent: vi.fn(),
  assertServiceCapability: vi.fn(),
}));

vi.mock("./dashboard-service", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./dashboard-service")>();
  return {
    ...actual,
    getDashboardWorkspace: mocks.getDashboardWorkspace,
  };
});

vi.mock("./service-entitlement", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./service-entitlement")>();
  return {
    ...actual,
    getServicePortal: mocks.getServicePortal,
    listWorkspaceQuestions: mocks.listWorkspaceQuestions,
    requestWorkspaceQuestionSelection: mocks.requestWorkspaceQuestionSelection,
    confirmWorkspaceBrandKeywordSelection:
      mocks.confirmWorkspaceBrandKeywordSelection,
    confirmWorkspaceQuestionIntent: mocks.confirmWorkspaceQuestionIntent,
    assertServiceCapability: mocks.assertServiceCapability,
  };
});

import { workspaceRouter } from "./workspace-router";

const question = servicePortalQuestionSchema.parse({
  id: "question-user-1",
  contractId: "contract-must-not-leak",
  quotaPeriodId: "period-current",
  externalQuestionId: null,
  sourceQuestionId: null,
  category: "product_scenario",
  question: "产品适合哪些使用场景？",
  intent: "确认场景边界",
  intentRevision: 2,
  intentConfirmedRevision: 2,
  intentConfirmedAt: Date.parse("2026-07-28T08:00:00.000Z"),
  intentConfirmed: true,
  rationale: "来自已核验产品资料",
  evidence: [],
  risks: [],
  source: "admin",
  status: "candidate",
  selectionApprovalStatus: "not_requested",
  selectionRequestedAt: null,
  selectionApprovedAt: null,
  locked: false,
  revision: 3,
});

const portal = {
  quotas: {
    periodId: "period-current",
  },
} as ServicePortal;

function userContext(): TrpcContext {
  const now = new Date("2026-07-28T08:00:00.000Z");
  const user: AuthenticatedUser = {
    id: 7,
    openId: null,
    username: "workspace.customer",
    displayName: "客户",
    name: "客户",
    email: null,
    loginMethod: "password",
    role: "user",
    adminAccessLevel: null,
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

describe("user workspace question DTO boundary", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getServicePortal.mockResolvedValue(portal);
    mocks.getDashboardWorkspace.mockResolvedValue({
      revision: 5,
      payload: {
        brandName: "测试品牌",
        headline: "测试品牌看板",
        summary: "",
        metrics: [],
        sections: [],
        keywordTables: [
          {
            id: "global-keywords",
            title: "品牌全域词库",
            columns: ["问题", "分类"],
            rows: [["测试品牌与竞品相比有什么优势？", "竞品对比词"]],
          },
        ],
        questions: [],
        monitoringAnswers: [],
        citations: [],
        contentAssets: [],
        optimizationReport: null,
        progressReports: [],
      },
    });
    mocks.listWorkspaceQuestions.mockResolvedValue([question]);
    mocks.requestWorkspaceQuestionSelection.mockResolvedValue(question);
    mocks.confirmWorkspaceBrandKeywordSelection.mockResolvedValue(question);
    mocks.confirmWorkspaceQuestionIntent.mockResolvedValue(question);
    mocks.assertServiceCapability.mockResolvedValue(undefined);
  });

  it("loads only the current quota period and strips its internal linkage", async () => {
    const caller = workspaceRouter.createCaller(userContext());
    const value = await caller.questionPortfolio();

    expect(mocks.listWorkspaceQuestions).toHaveBeenCalledWith({
      userId: 7,
      quotaPeriodId: "period-current",
    });
    expect(value).not.toHaveProperty("quotaPeriodId");
    expect(value.questions).toHaveLength(1);
    expect(value.questions[0]).not.toHaveProperty("contractId");
    expect(value.questions[0]).not.toHaveProperty("quotaPeriodId");
  });

  it("returns an empty portfolio when there is no active quota period", async () => {
    mocks.getServicePortal.mockResolvedValue({
      ...portal,
      quotas: null,
    });
    const caller = workspaceRouter.createCaller(userContext());

    await expect(caller.questionPortfolio()).resolves.toEqual({
      questions: [],
    });
    expect(mocks.listWorkspaceQuestions).not.toHaveBeenCalled();
  });

  it("strips internal linkage from every user question mutation", async () => {
    const caller = workspaceRouter.createCaller(userContext());
    const selected = await caller.selectQuestion({
      questionId: question.id,
      expectedRevision: question.revision,
    });
    const requested = await caller.requestQuestionSelection({
      mode: "direct",
      question: "如何选择适合企业的产品方案？",
      category: "product_scenario",
    });
    const confirmed = await caller.confirmQuestionIntent({
      questionId: question.id,
      expectedRevision: question.revision,
      expectedIntentRevision: question.intentRevision,
    });

    for (const value of [
      selected.question,
      requested.question,
      confirmed.question,
    ]) {
      expect(value).not.toHaveProperty("contractId");
      expect(value).not.toHaveProperty("quotaPeriodId");
    }
    expect(mocks.requestWorkspaceQuestionSelection).toHaveBeenCalledWith({
      userId: 7,
      actorUserId: 7,
      question: "如何选择适合企业的产品方案？",
      category: "product_scenario",
    });
  });

  it("resolves a brand keyword row on the server before confirming it", async () => {
    const selectedQuestion = {
      ...question,
      userId: 7,
      contractId: "contract-current",
      quotaPeriodId: "period-current",
      status: "selected",
      selectionApprovalStatus: "approved",
    };
    mocks.confirmWorkspaceBrandKeywordSelection.mockResolvedValueOnce(
      selectedQuestion,
    );
    const caller = workspaceRouter.createCaller(userContext());

    await caller.requestQuestionSelection({
      mode: "brand_keyword_library",
      dashboardRevision: 5,
      tableId: "global-keywords",
      rowIndex: 0,
    });

    expect(mocks.getDashboardWorkspace).toHaveBeenCalledWith(7);
    expect(mocks.confirmWorkspaceBrandKeywordSelection).toHaveBeenCalledWith({
      userId: 7,
      actorUserId: 7,
      dashboardRevision: 5,
      tableId: "global-keywords",
      rowIndex: 0,
      expectedQuestion: "测试品牌与竞品相比有什么优势？",
      expectedCategory: "competitor_comparison",
    });
  });

  it("accepts an explicit customer question category", async () => {
    const caller = workspaceRouter.createCaller(userContext());

    await caller.requestQuestionSelection({
      mode: "direct",
      question: "如何选择适合企业的产品方案？",
      category: "product_scenario",
    });

    expect(mocks.requestWorkspaceQuestionSelection).toHaveBeenCalledWith({
      userId: 7,
      actorUserId: 7,
      question: "如何选择适合企业的产品方案？",
      category: "product_scenario",
    });
  });

  it("routes direct questions immediately to the quota transaction", async () => {
    const caller = workspaceRouter.createCaller(userContext());

    await caller.requestQuestionSelection({
      mode: "direct",
      question: "如何选择适合企业的产品方案？",
      category: "product_scenario",
    });

    expect(mocks.assertServiceCapability).toHaveBeenCalledWith(
      7,
      "questionSelection",
    );
    expect(mocks.requestWorkspaceQuestionSelection).toHaveBeenCalledWith({
      userId: 7,
      actorUserId: 7,
      question: "如何选择适合企业的产品方案？",
      category: "product_scenario",
    });
  });

  it("requires an explicit category without accepting a customer user id", async () => {
    const caller = workspaceRouter.createCaller(userContext());
    await expect(
      caller.requestQuestionSelection({
        mode: "direct",
        question: "如何选择适合企业的产品方案？",
        classificationVersion: 2,
      } as never),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    await expect(
      caller.requestQuestionSelection({
        mode: "direct",
        question: "如何选择适合企业的产品方案？",
        category: "product_scenario",
        userId: 8,
      } as never),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    expect(mocks.requestWorkspaceQuestionSelection).not.toHaveBeenCalled();
  });
});
