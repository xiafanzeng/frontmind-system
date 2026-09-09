import { beforeEach, describe, expect, it, vi } from "vitest";
import type { TrpcContext } from "./_core/context";
import type { AuthenticatedUser } from "./auth-service";

const mocks = vi.hoisted(() => ({
  assertServiceCapability: vi.fn(),
  getDashboardQuestion: vi.fn(),
  saveResponseLogicEntry: vi.fn(),
}));

vi.mock("./service-entitlement", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./service-entitlement")>()),
  assertServiceCapability: mocks.assertServiceCapability,
}));
vi.mock("./dashboard-service", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./dashboard-service")>()),
  getDashboardQuestion: mocks.getDashboardQuestion,
}));
vi.mock("./response-logic-service", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./response-logic-service")>()),
  saveResponseLogicEntry: mocks.saveResponseLogicEntry,
}));

import { ServiceEntitlementError } from "./service-entitlement";
import { workspaceRouter } from "./workspace-router";

function userContext(): TrpcContext {
  const now = new Date("2026-09-09T00:00:00.000Z");
  const user: AuthenticatedUser = {
    id: 7,
    openId: null,
    username: "response.customer",
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

const input = {
  questionId: "project-question",
  groupId: "basic",
  groupTitle: "产品场景词",
  question: "产品适合哪些场景？",
  intent: "确定适用范围",
  summary: "",
  expectedRevision: 0,
  publish: false,
  draft: {
    concern: "",
    conclusion: "",
    facts: "",
    pending: "",
    boundaries: "",
    references: "",
    images: [],
    attachments: [],
  },
};

describe("response logic save prerequisite errors", () => {
  beforeEach(() => vi.clearAllMocks());

  it("preserves the unpublished knowledge prerequisite instead of returning a generic save failure", async () => {
    const prerequisite = new ServiceEntitlementError(
      "KNOWLEDGE_SNAPSHOT_NOT_FOUND",
      "请先完成并发布当前项目的知识库",
      409,
    );
    mocks.assertServiceCapability.mockRejectedValueOnce(prerequisite);

    await expect(
      workspaceRouter.createCaller(userContext()).saveResponseLogic(input),
    ).rejects.toMatchObject({
      code: "CONFLICT",
      message: "请先完成并发布当前项目的知识库",
      cause: prerequisite,
    });
    expect(mocks.assertServiceCapability).toHaveBeenCalledWith(
      7,
      "responseLogic",
    );
    expect(mocks.getDashboardQuestion).not.toHaveBeenCalled();
    expect(mocks.saveResponseLogicEntry).not.toHaveBeenCalled();
  });

  it("continues saving with authoritative question ownership after the prerequisite is met", async () => {
    mocks.assertServiceCapability.mockResolvedValueOnce(undefined);
    const question = {
      questionId: input.questionId,
      groupId: "basic",
      groupTitle: "服务器词组",
      question: "服务器问题正文",
      intent: "服务器意图",
      summary: "服务器摘要",
      writeScope: { revision: 3, contractId: null, quotaPeriodId: "" },
    };
    mocks.getDashboardQuestion.mockResolvedValueOnce(question);
    const record = {
      id: "first-record",
      questionId: input.questionId,
      revision: 1,
      version: 0,
    };
    mocks.saveResponseLogicEntry.mockResolvedValueOnce(record);

    await expect(
      workspaceRouter.createCaller(userContext()).saveResponseLogic(input),
    ).resolves.toEqual({ record });
    expect(mocks.saveResponseLogicEntry).toHaveBeenCalledWith({
      userId: 7,
      expectedQuestionScope: question.writeScope,
      value: { ...input, ...question },
    });
  });
});
