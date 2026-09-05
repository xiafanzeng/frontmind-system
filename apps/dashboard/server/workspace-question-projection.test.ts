import { beforeEach, describe, expect, it, vi } from "vitest";

import type { TrpcContext } from "./_core/context";
import type { AuthenticatedUser } from "./auth-service";
import {
  servicePortalQuestionSchema,
  type ServicePortal,
} from "../shared/service-portal";

const mocks = vi.hoisted(() => ({
  getServicePortal: vi.fn(),
  listWorkspaceQuestions: vi.fn(),
  requestWorkspaceQuestionSelection: vi.fn(),
  confirmWorkspaceQuestionIntent: vi.fn(),
  assertServiceCapability: vi.fn(),
}));

vi.mock("./service-entitlement", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./service-entitlement")>();
  return {
    ...actual,
    getServicePortal: mocks.getServicePortal,
    listWorkspaceQuestions: mocks.listWorkspaceQuestions,
    requestWorkspaceQuestionSelection: mocks.requestWorkspaceQuestionSelection,
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
    mocks.listWorkspaceQuestions.mockResolvedValue([question]);
    mocks.requestWorkspaceQuestionSelection.mockResolvedValue(question);
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
  });
});
