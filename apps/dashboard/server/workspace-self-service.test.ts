import { beforeEach, describe, expect, it, vi } from "vitest";
import type { TrpcContext } from "./_core/context";
const mocks = vi.hoisted(() => ({
  getDashboardWorkspace: vi.fn(),
  updateDashboardWorkspace: vi.fn(),
  assertServiceWriteAccess: vi.fn(),
  assertServiceCapability: vi.fn(),
  resetKnowledgeBase: vi.fn(),
}));
vi.mock("./dashboard-service", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./dashboard-service")>()),
  getDashboardWorkspace: mocks.getDashboardWorkspace,
  updateDashboardWorkspace: mocks.updateDashboardWorkspace,
}));
vi.mock("./service-entitlement", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./service-entitlement")>()),
  assertServiceWriteAccess: mocks.assertServiceWriteAccess,
  assertServiceCapability: mocks.assertServiceCapability,
}));
vi.mock("./knowledge-base-reset-service", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./knowledge-base-reset-service")>()),
  resetKnowledgeBase: mocks.resetKnowledgeBase,
}));
import {
  workspaceRouter,
  projectUserDashboardPayload,
} from "./workspace-router";
import { dashboardPayloadSchema } from "../shared/dashboard";
const payload = dashboardPayloadSchema.parse({
  brandName: "硅基流动",
  headline: "企业概况",
  summary: "公开资料",
});
function context(role = "user"): TrpcContext {
  return {
    user: { id: 7, role, username: "customer", isActive: true },
    req: {},
    res: {},
  } as TrpcContext;
}
beforeEach(() => {
  vi.clearAllMocks();
  mocks.getDashboardWorkspace.mockResolvedValue({
    payload,
    revision: 3,
    sourceName: null,
    enterpriseIdentityBoundAt: null,
  });
  mocks.updateDashboardWorkspace.mockImplementation(async (input) => ({
    revision: 4,
    payload: input.payload,
  }));
  mocks.assertServiceWriteAccess.mockResolvedValue({
    capabilities: { contentAssets: { allowed: true } },
    knowledge: {
      status: "display_ready",
      authenticatedForCurrentService: true,
    },
    service: { planCode: "luxury" },
    workflowSteps: [{ id: "knowledge", status: "complete" }],
  });
  mocks.assertServiceCapability.mockResolvedValue({});
  mocks.resetKnowledgeBase.mockResolvedValue({
    revision: 3,
    cleanup: { builds: 1 },
  });
});
describe("customer self service routes", () => {
  it("saves content under the authenticated customer with original revision and capability checks", async () => {
    const result = await workspaceRouter
      .createCaller(context())
      .saveDashboard({ payload, expectedRevision: 3 });
    expect(result).toMatchObject({ revision: 4 });
    expect(mocks.assertServiceWriteAccess).toHaveBeenCalledWith(7);
    expect(mocks.assertServiceCapability).not.toHaveBeenCalled();
    expect(mocks.updateDashboardWorkspace).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: 7,
        actorUserId: 7,
        expectedRevision: 3,
        bindEnterpriseIdentity: true,
        payload: expect.objectContaining({
          brandName: "硅基流动",
          monitoringAnswers: [],
          citations: [],
        }),
      }),
    );
  });
  it("preserves every module hidden before knowledge publication while allowing profile edits", async () => {
    const original = dashboardPayloadSchema.parse({
      ...payload,
      metrics: [{ label: "历史数量", value: 55 }],
      keywordTables: [
        {
          id: "keywords",
          title: "原词库",
          columns: ["问题"],
          rows: [["保留问题"]],
        },
      ],
      questions: [
        {
          id: "question-1",
          groupId: "basic",
          groupTitle: "产品场景",
          question: "原问题",
        },
      ],
      sections: [{ id: "section-1", title: "已有章节", body: "保留正文" }],
      contentAssets: [{ id: "asset-1", name: "已有素材" }],
      optimizationReport: { title: "原报告" },
      progressReports: [
        {
          id: "v1",
          revision: 1,
          publishedAt: 1,
          report: { title: "历史报告" },
        },
      ],
      monitoringAnswers: [
        {
          id: "answer-1",
          questionId: "question-1",
          platform: "DeepSeek",
          content: "原观测",
        },
      ],
      citations: [{ id: "citation-1", title: "原引用" }],
    });
    mocks.getDashboardWorkspace.mockResolvedValue({
      payload: original,
      revision: 3,
      sourceName: null,
      enterpriseIdentityBoundAt: null,
    });
    mocks.assertServiceWriteAccess.mockResolvedValue({
      capabilities: { contentAssets: { allowed: true } },
      knowledge: {
        status: "in_progress",
        authenticatedForCurrentService: false,
      },
      service: { planCode: "luxury" },
      workflowSteps: [],
    });
    const visible = projectUserDashboardPayload({
      payload: original,
      configured: true,
      contentAssetsAllowed: false,
    })!;
    expect(visible.keywordTables).toEqual([]);
    const result = await workspaceRouter.createCaller(context()).saveDashboard({
      expectedRevision: 3,
      payload: { ...visible, headline: "客户修改的概况" },
    });
    expect(result.payload).toEqual({ ...visible, headline: "客户修改的概况" });
    const saved = mocks.updateDashboardWorkspace.mock.calls[0][0].payload;
    expect(saved).toEqual({ ...original, headline: "客户修改的概况" });
    expect(mocks.assertServiceCapability).not.toHaveBeenCalled();
  });
  it("preserves unpublished report results and server observations when saving public edits", async () => {
    const report = {
      title: "进展报告",
      questionReports: [
        {
          id: "q-private",
          question: "公开问题",
          afterEffect: {
            released: false,
            totalScore: 91,
            summary: "尚未发布的结果",
          },
        },
      ],
    };
    const original = dashboardPayloadSchema.parse({
      ...payload,
      optimizationReport: report,
      progressReports: [{ id: "v1", revision: 1, publishedAt: 1, report }],
      monitoringAnswers: [
        {
          id: "a1",
          questionId: "q-private",
          platform: "DeepSeek",
          content: "服务端观测",
        },
      ],
      citations: [{ id: "c1", title: "服务端引用" }],
    });
    mocks.getDashboardWorkspace.mockResolvedValue({
      payload: original,
      revision: 3,
      sourceName: null,
      enterpriseIdentityBoundAt: null,
    });
    const visible = projectUserDashboardPayload({
      payload: original,
      configured: true,
      contentAssetsAllowed: true,
    })!;
    expect(visible.optimizationReport?.questionReports?.[0]).not.toHaveProperty(
      "afterEffect",
    );
    const submitted = structuredClone(visible);
    submitted.optimizationReport!.questionReports![0].summary =
      "客户编辑的公开摘要";
    submitted.progressReports[0].report.title = "客户编辑的报告标题";
    submitted.monitoringAnswers = [];
    submitted.citations = [];
    await workspaceRouter
      .createCaller(context())
      .saveDashboard({ expectedRevision: 3, payload: submitted });
    const saved = mocks.updateDashboardWorkspace.mock.calls[0][0].payload;
    expect(saved.optimizationReport.questionReports[0]).toMatchObject({
      summary: "客户编辑的公开摘要",
      afterEffect: original.optimizationReport!.questionReports![0].afterEffect,
    });
    expect(
      saved.progressReports[0].report.questionReports[0].afterEffect,
    ).toEqual(
      original.progressReports[0].report.questionReports![0].afterEffect,
    );
    expect(saved.progressReports[0].report.title).toBe("客户编辑的报告标题");
    expect(saved.monitoringAnswers).toEqual(original.monitoringAnswers);
    expect(saved.citations).toEqual(original.citations);
  });
  it("rejects a different explicit customer id before writing", async () => {
    await expect(
      workspaceRouter
        .createCaller(context())
        .saveDashboard({ payload, expectedRevision: 3, userId: 8 } as never),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    expect(mocks.updateDashboardWorkspace).not.toHaveBeenCalled();
  });
  it("rejects a noncustomer on the customer editing endpoint", async () => {
    await expect(
      workspaceRouter
        .createCaller(context("admin"))
        .saveDashboard({ payload, expectedRevision: 3 }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(mocks.updateDashboardWorkspace).not.toHaveBeenCalled();
  });
  it("passes the customer reset revision without a ticket or target user id", async () => {
    const ctx = context();
    await expect(
      workspaceRouter
        .createCaller(ctx)
        .knowledgeReset.reset({ expectedRevision: 2 }),
    ).resolves.toMatchObject({ revision: 3 });
    expect(mocks.resetKnowledgeBase).toHaveBeenCalledWith({
      actor: ctx.user,
      expectedRevision: 2,
    });
  });
});
