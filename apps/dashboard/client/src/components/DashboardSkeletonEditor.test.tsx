import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  createDefaultDashboardPayload,
  dashboardOptimizationReportSchema,
} from "@shared/dashboard";

const mocks = vi.hoisted(() => ({
  mutateAsync: vi.fn(),
  responseLogicRefetch: vi.fn(),
  toastSuccess: vi.fn(),
  toastError: vi.fn(),
  toastWarning: vi.fn(),
}));

vi.mock("@/lib/trpc", () => ({
  trpc: {
    admin: {
      workspace: {
        updateDashboard: {
          useMutation: () => ({
            mutateAsync: mocks.mutateAsync,
            isPending: false,
          }),
        },
        responseLogic: {
          useQuery: () => ({
            data: { records: [] },
            isLoading: false,
            error: null,
            refetch: mocks.responseLogicRefetch,
          }),
        },
      },
    },
  },
}));

vi.mock("sonner", () => ({
  toast: {
    success: mocks.toastSuccess,
    error: mocks.toastError,
    warning: mocks.toastWarning,
  },
}));

import DashboardSkeletonEditor, {
  currentModuleTemplate,
  dashboardEditorDisplayText,
  monitoringImportPublishedDescription,
} from "./DashboardSkeletonEditor";

describe("DashboardSkeletonEditor", () => {
  const payload = {
    ...createDefaultDashboardPayload("验收企业"),
    sections: [
      {
        id: "overview",
        title: "企业概览",
        subtitle: "",
        body: "",
        items: [],
        tables: [],
      },
    ],
  };
  const reportQuestion = {
    id: "question-1",
    groupId: "industry",
    groupTitle: "行业排名词",
    groupSubtitle: "",
    tone: "amber" as const,
    question: "验收企业如何建立权威知识库？",
    intent: "",
    summary: "",
  };

  it("maps legacy technical labels to customer-facing dashboard language", () => {
    expect(
      dashboardEditorDisplayText("企业数据骨架 / 看板指标 / 内容板块与卡片"),
    ).toBe("客户页面 / 数据卡片 / 页面内容");
  });

  it("describes answer-only and question-only monitoring publishes truthfully", () => {
    expect(
      monitoringImportPublishedDescription({
        mode: "answer-only",
        sampleCount: 50,
        citationCount: 0,
        exactLinked: 0,
      }),
    ).toBe("答案明细已发布；逐答案信源为空，可继续上传对应的信源表。");
    expect(
      monitoringImportPublishedDescription({
        mode: "question-only",
        sampleCount: 0,
        citationCount: 705,
        exactLinked: 0,
      }),
    ).toBe("问题级引用分析已更新，未生成逐答案关联。");
  });

  it("uses the customer dashboard itself as the admin editing surface", () => {
    render(
      <DashboardSkeletonEditor
        userId={42}
        workspace={{
          payload,
          revision: 3,
          enterpriseIdentityBoundAt: Date.parse("2026-07-01T00:00:00Z"),
        }}
      />,
    );

    expect(screen.getByRole("tab", { name: "服务首页" })).toBeInTheDocument();
    expect(
      screen.getByRole("tab", { name: "知识库智能体" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("tab", { name: "AI友好官网管理" }),
    ).toBeInTheDocument();
    expect(screen.queryByText("更新首页标题与简介")).toBeNull();
    expect(screen.queryByText("修改如何同步给客户")).toBeNull();
    expect(screen.queryByText("首页数据概览")).toBeNull();
    expect(screen.queryByText("交付内容区")).toBeNull();

    fireEvent.click(screen.getByRole("tab", { name: "品牌全域词库" }));
    expect(
      screen.getByRole("button", { name: "下载当前数据" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "上传修改" }),
    ).toBeInTheDocument();
  });

  it("uses the full right workspace and keeps an in-dashboard return action", () => {
    const onExitDashboard = vi.fn();
    const { container } = render(
      <DashboardSkeletonEditor
        userId={42}
        dashboardLayout="workspace"
        onExitDashboard={onExitDashboard}
        workspace={{
          payload,
          revision: 3,
          enterpriseIdentityBoundAt: Date.parse("2026-07-01T00:00:00Z"),
        }}
      />,
    );

    expect(
      container.querySelector(".customer-dashboard-mirror"),
    ).toHaveAttribute("data-layout", "workspace");
    fireEvent.click(screen.getByRole("button", { name: "返回工作台" }));
    expect(onExitDashboard).toHaveBeenCalledTimes(1);
  });

  it("can host overseas Jenova management inside the customer dashboard", () => {
    render(
      <DashboardSkeletonEditor
        userId={42}
        dashboardLayout="workspace"
        marketEdition="overseas"
        brandTrackingManagement={<div>Jenova 客户管理组件</div>}
        workspace={{
          payload,
          revision: 3,
          enterpriseIdentityBoundAt: Date.parse("2026-07-01T00:00:00Z"),
        }}
      />,
    );

    fireEvent.click(screen.getByRole("tab", { name: "舆情监控" }));
    expect(screen.getByText("Jenova 客户管理组件")).toBeInTheDocument();
  });

  const payloadWithReport = {
    ...payload,
    questions: [reportQuestion],
    optimizationReport: dashboardOptimizationReportSchema.parse({
      period: "2026 年 7 月",
      title: "验收企业 GEO 进度报告",
      questionReports: [
        {
          id: reportQuestion.id,
          category: reportQuestion.groupTitle,
          question: reportQuestion.question,
          before: { content: "原优化前答案" },
          after: { content: "原优化后答案" },
        },
      ],
    }),
  };

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.mutateAsync.mockImplementation(async ({ payload: nextPayload }) => ({
      payload: nextPayload,
      revision: 4,
      sourceName: "管理员结构化编辑",
      updatedAt: Date.now(),
      knowledgeUpdatedAt: null,
    }));
  });

  it("builds revision-bound current-content JSON templates for every module", () => {
    const responseLogicRecords = [
      {
        questionId: "question-1",
        question: reportQuestion.question,
        revision: 7,
        draft: {
          concern: "用户关心什么",
          conclusion: "当前结论",
          facts: "企业事实",
          pending: "",
          boundaries: "表达边界",
          references: "引用规则",
          images: [],
        },
        confirmed: null,
      },
    ];
    const authoritativeQuestions = [
      {
        id: "question-1",
        revision: 11,
        category: "industry" as const,
        question: reportQuestion.question,
        intent: "正式问题意图",
        rationale: "正式推荐理由",
      },
    ];
    const modules = [
      "profile",
      "metrics",
      "sections",
      "keywords",
      "questions",
      "monitoring",
      "response-logic",
      "content-assets",
      "optimization-report",
    ] as const;

    const templates = Object.fromEntries(
      modules.map((module) => [
        module,
        currentModuleTemplate({
          module,
          revision: 9,
          payload: payloadWithReport,
          responseLogicRecords,
          authoritativeQuestions,
        }) as Record<string, unknown>,
      ]),
    );

    for (const module of modules) {
      expect(templates[module]).toEqual(
        expect.objectContaining({
          format: "frontmind.dashboard-module-template.v1",
          module,
          templateRevision: 9,
          exportedAt: expect.any(String),
        }),
      );
    }
    expect(templates.profile.profile).toEqual({
      brandName: payloadWithReport.brandName,
      headline: payloadWithReport.headline,
      summary: payloadWithReport.summary,
    });
    expect(templates.metrics.metrics).toEqual(payloadWithReport.metrics);
    expect(templates.sections.sections).toEqual(payloadWithReport.sections);
    expect(templates.keywords.keywordTables).toEqual(
      payloadWithReport.keywordTables,
    );
    expect(templates.questions.questions).toEqual([
      {
        id: "question-1",
        revision: 11,
        category: "industry",
        question: reportQuestion.question,
        intent: "正式问题意图",
        rationale: "正式推荐理由",
      },
    ]);
    expect(templates.monitoring.monitoringAnswers).toEqual(
      payloadWithReport.monitoringAnswers,
    );
    expect(templates.monitoring.citations).toEqual(payloadWithReport.citations);
    expect(templates["content-assets"].contentAssets).toEqual(
      payloadWithReport.contentAssets,
    );
    expect(templates["optimization-report"].optimizationReport).toEqual(
      payloadWithReport.optimizationReport,
    );
    expect(templates["response-logic"].responseLogic).toEqual([
      expect.objectContaining({
        questionId: "question-1",
        version: 7,
        draft: responseLogicRecords[0]!.draft,
        publish: false,
      }),
    ]);

    const emptyResponseLogicTemplate = currentModuleTemplate({
      module: "response-logic",
      revision: 9,
      payload: payloadWithReport,
      responseLogicRecords: [],
      authoritativeQuestions,
    }) as Record<string, any>;
    expect(emptyResponseLogicTemplate.responseLogic).toEqual([
      expect.objectContaining({
        questionId: "question-1",
        version: 0,
        publish: false,
      }),
    ]);
  });

  it("downloads the monitoring current template from the authoritative server endpoint", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ module: "monitoring", batches: [] }), {
        status: 200,
        headers: {
          "Content-Type": "application/json",
          "Content-Disposition":
            'attachment; filename="frontmind-monitoring-current-42-R3.json"',
        },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const createObjectUrl = vi.fn(() => "blob:monitoring-current-template");
    const revokeObjectUrl = vi.fn();
    Object.defineProperty(URL, "createObjectURL", {
      configurable: true,
      value: createObjectUrl,
    });
    Object.defineProperty(URL, "revokeObjectURL", {
      configurable: true,
      value: revokeObjectUrl,
    });
    const anchorClick = vi
      .spyOn(HTMLAnchorElement.prototype, "click")
      .mockImplementation(() => undefined);

    render(
      <DashboardSkeletonEditor
        userId={42}
        workspace={{
          payload: payloadWithReport,
          revision: 3,
          enterpriseIdentityBoundAt: Date.parse("2026-07-01T00:00:00Z"),
        }}
      />,
    );
    fireEvent.click(screen.getByRole("tab", { name: "问题监控" }));
    const card = document.querySelector(".customer-dashboard-editor-actions");
    fireEvent.click(
      within(card as HTMLElement).getByRole("button", {
        name: "下载当前数据",
      }),
    );

    await waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/dashboard/monitoring-template/42",
      { credentials: "include" },
    );
    await waitFor(() => expect(anchorClick).toHaveBeenCalledOnce());
    expect(createObjectUrl).toHaveBeenCalledOnce();
    expect(revokeObjectUrl).toHaveBeenCalledWith(
      "blob:monitoring-current-template",
    );
  });

  it.skip("publishes direct skeleton edits with an optimistic revision", async () => {
    const onWorkspaceChanged = vi.fn();
    render(
      <DashboardSkeletonEditor
        userId={42}
        workspace={{ payload, revision: 3 }}
        onWorkspaceChanged={onWorkspaceChanged}
      />,
    );

    expect(screen.getByText("用户完整看板实时预览")).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("企业名称"), {
      target: { value: "验收企业有限公司" },
    });
    fireEvent.change(screen.getByLabelText("客户看到的主标题"), {
      target: { value: "数控机床企业知识中枢" },
    });
    fireEvent.click(screen.getByRole("button", { name: "发布修改" }));

    await waitFor(() =>
      expect(mocks.mutateAsync).toHaveBeenCalledWith(
        expect.objectContaining({
          userId: 42,
          expectedRevision: 3,
          payload: expect.objectContaining({
            brandName: "验收企业有限公司",
            headline: "数控机床企业知识中枢",
          }),
        }),
      ),
    );
    await waitFor(() => expect(onWorkspaceChanged).toHaveBeenCalledOnce());
    expect(mocks.toastSuccess).toHaveBeenCalledWith(
      "交付内容与进度已更新",
      expect.objectContaining({ description: "当前版本 R4" }),
    );
  });

  it.skip("locks the enterprise identity after the first publication", () => {
    render(
      <DashboardSkeletonEditor
        userId={42}
        workspace={{
          payload,
          revision: 3,
          enterpriseIdentityBoundAt: Date.parse("2026-07-01T00:00:00Z"),
        }}
      />,
    );

    expect(screen.getByLabelText("企业名称")).toBeDisabled();
    expect(screen.getByText(/更换企业请新建用户账号/)).toBeInTheDocument();
  });

  it.skip("requires enterprise confirmation before uploading non-profile modules", () => {
    render(
      <DashboardSkeletonEditor
        userId={42}
        workspace={{ payload, revision: 3 }}
      />,
    );

    expect(
      screen.getByText(/企业身份确认后才可上传其他数据/),
    ).toBeInTheDocument();
    const profileCard = screen.getByText("首页标题与简介").closest("article");
    const keywordCard = screen
      .getByText("品牌全域词库", { selector: "strong" })
      .closest("article");
    expect(profileCard).not.toBeNull();
    expect(keywordCard).not.toBeNull();
    expect(
      within(profileCard as HTMLElement).getByRole("button", {
        name: "上传并预览",
      }),
    ).not.toBeDisabled();
    expect(
      within(keywordCard as HTMLElement).getByRole("button", {
        name: "上传并预览",
      }),
    ).toBeDisabled();
  });

  it.skip("maintains every user-visible question report field without requiring JSON", async () => {
    render(
      <DashboardSkeletonEditor
        userId={42}
        workspace={{
          payload: payloadWithReport,
          revision: 3,
          enterpriseIdentityBoundAt: Date.parse("2026-07-01T00:00:00Z"),
        }}
      />,
    );

    fireEvent.change(screen.getByLabelText("优化前答案正文"), {
      target: { value: "管理员核验后的优化前真实答案" },
    });
    fireEvent.change(screen.getByLabelText("优化后答案正文"), {
      target: { value: "管理员核验后的优化后真实答案" },
    });
    fireEvent.change(screen.getByLabelText("标准应答逻辑"), {
      target: { value: "先核验事实，再给出边界明确的结论。" },
    });

    const gaps = screen.getByText("与应答逻辑的差距").closest("section");
    const filled = screen.getByText("本轮已填补").closest("section");
    expect(gaps).not.toBeNull();
    expect(filled).not.toBeNull();
    fireEvent.click(within(gaps!).getByRole("button", { name: "添加" }));
    fireEvent.change(screen.getByLabelText("应答差距 1"), {
      target: { value: "缺少权威信源。" },
    });
    fireEvent.click(within(filled!).getByRole("button", { name: "添加" }));
    fireEvent.change(screen.getByLabelText("已填补项 1"), {
      target: { value: "已补齐企业官网事实。" },
    });

    fireEvent.change(screen.getByLabelText("优化后语义资产总评分"), {
      target: { value: "88" },
    });
    fireEvent.change(screen.getByLabelText("差距填补总结"), {
      target: { value: "已填补核心知识事实和回答差距。" },
    });
    fireEvent.click(
      within(screen.getByText("平台优化后复测").closest("section")!).getByRole(
        "button",
        { name: "添加平台" },
      ),
    );
    fireEvent.change(screen.getByLabelText("平台复测 1 平台"), {
      target: { value: "DeepSeek" },
    });
    fireEvent.change(screen.getByLabelText("平台复测 1 有效回答"), {
      target: { value: "10" },
    });
    fireEvent.change(screen.getByLabelText("平台复测 1 答案引用"), {
      target: { value: "18" },
    });
    fireEvent.click(screen.getByLabelText("向用户开放优化后效果"));
    fireEvent.click(screen.getByRole("button", { name: "发布修改" }));

    await waitFor(() => expect(mocks.mutateAsync).toHaveBeenCalledOnce());
    const nextReport =
      mocks.mutateAsync.mock.calls[0]![0].payload.optimizationReport;
    const questionReport = nextReport.questionReports[0];
    expect(questionReport.before.content).toBe("管理员核验后的优化前真实答案");
    expect(questionReport.after.content).toBe("管理员核验后的优化后真实答案");
    expect(questionReport.expectedLogic).toBe(
      "先核验事实，再给出边界明确的结论。",
    );
    expect(questionReport.gaps).toEqual(["缺少权威信源。"]);
    expect(questionReport.improvements).toEqual(["已补齐企业官网事实。"]);
    expect(questionReport.afterEffect).toEqual(
      expect.objectContaining({
        released: true,
        totalScore: 88,
        gapFillSummary: "已填补核心知识事实和回答差距。",
        platforms: [
          expect.objectContaining({
            platform: "DeepSeek",
            responseCount: 10,
            citationCount: 18,
          }),
        ],
      }),
    );
  });

  it.skip("uploads multiple protected answer screenshots into the structured report", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          id: "44444444-4444-4444-8444-444444444444.png",
          url: "/api/dashboard/report-assets/42/44444444-4444-4444-8444-444444444444.png",
          filename: "before.png",
        }),
        {
          status: 200,
          headers: { "Content-Type": "application/json" },
        },
      ),
    );
    vi.stubGlobal("fetch", fetchMock);
    render(
      <DashboardSkeletonEditor
        userId={42}
        workspace={{
          payload: payloadWithReport,
          revision: 3,
          enterpriseIdentityBoundAt: Date.parse("2026-07-01T00:00:00Z"),
        }}
      />,
    );

    const image = new File(["image"], "before.png", {
      type: "image/png",
    });
    fireEvent.change(screen.getByLabelText("上传优化前答案截图"), {
      target: { files: [image] },
    });

    await waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/dashboard/report-assets/42",
      expect.objectContaining({
        method: "PUT",
        body: image,
        credentials: "include",
      }),
    );
    expect(await screen.findByLabelText("优化前截图 1 地址")).toHaveValue(
      "/api/dashboard/report-assets/42/44444444-4444-4444-8444-444444444444.png",
    );

    fireEvent.click(screen.getByRole("button", { name: "发布修改" }));
    await waitFor(() => expect(mocks.mutateAsync).toHaveBeenCalledOnce());
    expect(
      mocks.mutateAsync.mock.calls[0]![0].payload.optimizationReport
        .questionReports[0].before.screenshots,
    ).toEqual([
      {
        id: "44444444-4444-4444-8444-444444444444.png",
        url: "/api/dashboard/report-assets/42/44444444-4444-4444-8444-444444444444.png",
        alt: "优化前答案截图",
      },
    ]);
  });

  it("uploads a keyword workbook without using the full-dashboard import", async () => {
    const onWorkspaceChanged = vi.fn();
    const fileHash = "e".repeat(64);
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            kind: "dashboard-module-preview",
            preview: {
              mode: "dashboard-module",
              module: "keywords",
              sourceName: "关键词.xlsx",
              fileHash,
              templateRevision: 3,
              preflightToken: "signed-keywords-preflight-token",
              preflightExpiresAt: "2099-07-28T00:00:00.000Z",
              summary: [
                "词库表格：现有 0 条，导入后 1 条；新增 1、更新 0、删除 0、不变 0",
              ],
              recordStats: [
                {
                  label: "词库表格",
                  beforeCount: 0,
                  afterCount: 1,
                  added: 1,
                  updated: 0,
                  removed: 0,
                  unchanged: 0,
                },
              ],
              changedFields: [],
            },
          }),
          {
            status: 200,
            headers: { "Content-Type": "application/json" },
          },
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            kind: "dashboard",
            module: "keywords",
            dashboard: {
              payload: {
                ...payload,
                keywordTables: [
                  {
                    id: "keywords-1",
                    title: "问题优化",
                    columns: ["问题", "场景"],
                    rows: [["如何选择机床？", "产品场景"]],
                  },
                ],
              },
              revision: 4,
            },
          }),
          {
            status: 200,
            headers: { "Content-Type": "application/json" },
          },
        ),
      );
    vi.stubGlobal("fetch", fetchMock);

    render(
      <DashboardSkeletonEditor
        userId={42}
        workspace={{
          payload,
          revision: 3,
          enterpriseIdentityBoundAt: Date.parse("2026-07-01T00:00:00Z"),
        }}
        onWorkspaceChanged={onWorkspaceChanged}
      />,
    );

    fireEvent.click(screen.getByRole("tab", { name: "品牌全域词库" }));
    const card = document.querySelector(".customer-dashboard-editor-actions");
    expect(card).not.toBeNull();
    const fileInput =
      card!.querySelector<HTMLInputElement>('input[type="file"]');
    expect(fileInput).not.toBeNull();
    expect(fileInput).toHaveAttribute(
      "accept",
      expect.stringContaining(".xlsx"),
    );
    const file = new File(["workbook"], "关键词.xlsx", {
      type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    });
    fireEvent.change(fileInput!, { target: { files: [file] } });

    await waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());
    const [url, options] = fetchMock.mock.calls[0]!;
    const headers = options.headers as Record<string, string>;
    expect(url).toBe("/api/dashboard/import/42");
    expect(options.method).toBe("PUT");
    expect(headers["X-Dashboard-Module"]).toBe("keywords");
    expect(headers["X-Dashboard-Revision"]).toBe("3");
    expect(headers["X-Import-Mode"]).toBe("dashboard");
    expect(headers["X-Import-Preview"]).toBe("true");
    expect(options.body).toBe(file);
    expect(
      await screen.findByRole("heading", {
        name: "模块文件预检与差异确认",
      }),
    ).toBeInTheDocument();
    expect(screen.getByText(/现有 0 条 → 导入后 1 条/)).toBeInTheDocument();
    expect(onWorkspaceChanged).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "确认发布" }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    const publishHeaders = fetchMock.mock.calls[1]![1].headers as Record<
      string,
      string
    >;
    expect(publishHeaders["X-Import-Preview"]).toBeUndefined();
    expect(publishHeaders["X-Import-File-Hash"]).toBe(fileHash);
    expect(publishHeaders["X-Import-Preflight-Token"]).toBe(
      "signed-keywords-preflight-token",
    );
    await waitFor(() => expect(onWorkspaceChanged).toHaveBeenCalledOnce());
    expect(mocks.toastSuccess).toHaveBeenCalledWith(
      "板块内容已发布",
      expect.objectContaining({
        description: expect.stringContaining("品牌全域词库"),
      }),
    );
  });

  it.each([
    {
      module: "questions",
      title: "问题目录",
      recordLabel: "问题目录",
      section: "问题优化",
    },
    {
      module: "response-logic",
      title: "应答逻辑确认稿",
      recordLabel: "应答逻辑",
      section: "应答逻辑智能体",
    },
    {
      module: "content-assets",
      title: "AI 友好内容资产",
      recordLabel: "内容资产",
      section: "内容资产运营",
    },
  ] as const)(
    "preflights and publishes the $module current-content template through the shared module contract",
    async ({ module, title, recordLabel, section }) => {
      const fileHash = "a".repeat(64);
      const preflightToken = `signed-${module}-preflight-token`;
      const onWorkspaceChanged = vi.fn();
      const fetchMock = vi
        .fn()
        .mockResolvedValueOnce(
          new Response(
            JSON.stringify({
              kind: "dashboard-module-preview",
              preview: {
                mode: "dashboard-module",
                module,
                sourceName: `${module}.json`,
                fileHash,
                templateRevision: 3,
                preflightToken,
                preflightExpiresAt: "2099-07-28T00:00:00.000Z",
                summary: [`${recordLabel}将更新 1 条。`],
                recordStats: [
                  {
                    label: recordLabel,
                    beforeCount: 1,
                    afterCount: 1,
                    added: 0,
                    updated: 1,
                    removed: 0,
                    unchanged: 0,
                  },
                ],
                changedFields: [],
              },
            }),
            {
              status: 200,
              headers: { "Content-Type": "application/json" },
            },
          ),
        )
        .mockResolvedValueOnce(
          new Response(
            JSON.stringify(
              module === "response-logic"
                ? {
                    kind: "response-logic",
                    module,
                    records: [{ questionId: reportQuestion.id, revision: 8 }],
                  }
                : {
                    kind: "dashboard",
                    module,
                    dashboard: { payload: payloadWithReport, revision: 4 },
                  },
            ),
            {
              status: 200,
              headers: { "Content-Type": "application/json" },
            },
          ),
        );
      vi.stubGlobal("fetch", fetchMock);

      render(
        <DashboardSkeletonEditor
          userId={42}
          workspace={{
            payload: payloadWithReport,
            revision: 3,
            enterpriseIdentityBoundAt: Date.parse("2026-07-01T00:00:00Z"),
          }}
          onWorkspaceChanged={onWorkspaceChanged}
        />,
      );

      fireEvent.click(screen.getByRole("tab", { name: section }));
      const card = document.querySelector(".customer-dashboard-editor-actions");
      expect(card).not.toBeNull();
      expect(within(card as HTMLElement).getByText(title)).toBeInTheDocument();
      const file = new File(
        [JSON.stringify({ module, templateRevision: 3 })],
        `${module}.json`,
        { type: "application/json" },
      );
      fireEvent.change(
        card!.querySelector<HTMLInputElement>('input[type="file"]')!,
        { target: { files: [file] } },
      );

      expect(
        await screen.findByRole("heading", {
          name: "模块文件预检与差异确认",
        }),
      ).toBeInTheDocument();
      expect(
        screen.getByText(`${recordLabel}将更新 1 条。`),
      ).toBeInTheDocument();
      expect(onWorkspaceChanged).not.toHaveBeenCalled();

      const previewHeaders = fetchMock.mock.calls[0]![1].headers as Record<
        string,
        string
      >;
      expect(previewHeaders["X-Dashboard-Module"]).toBe(module);
      expect(previewHeaders["X-Dashboard-Revision"]).toBe("3");
      expect(previewHeaders["X-Import-Preview"]).toBe("true");
      expect(fetchMock.mock.calls[0]![1].body).toBe(file);

      fireEvent.click(screen.getByRole("button", { name: "确认发布" }));
      await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
      const publishHeaders = fetchMock.mock.calls[1]![1].headers as Record<
        string,
        string
      >;
      expect(publishHeaders["X-Import-Preview"]).toBeUndefined();
      expect(publishHeaders["X-Import-File-Hash"]).toBe(fileHash);
      expect(publishHeaders["X-Import-Preflight-Token"]).toBe(preflightToken);
      expect(fetchMock.mock.calls[1]![1].body).toBe(file);
      await waitFor(() => expect(onWorkspaceChanged).toHaveBeenCalledOnce());
      if (module === "response-logic") {
        expect(mocks.responseLogicRefetch).toHaveBeenCalledOnce();
      }
    },
  );

  it.skip("targets a table upload to one content section", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          kind: "dashboard-module-preview",
          preview: {
            mode: "dashboard-module",
            module: "section-table",
            sourceName: "企业概览.csv",
            fileHash: "f".repeat(64),
            templateRevision: 3,
            sectionId: "overview",
            summary: [
              "板块表格（企业概览）：现有 0 条，导入后 1 条；新增 1、更新 0、删除 0、不变 0",
            ],
            recordStats: [
              {
                label: "板块表格（企业概览）",
                beforeCount: 0,
                afterCount: 1,
                added: 1,
                updated: 0,
                removed: 0,
                unchanged: 0,
              },
            ],
            changedFields: [],
          },
        }),
        {
          status: 200,
          headers: { "Content-Type": "application/json" },
        },
      ),
    );
    vi.stubGlobal("fetch", fetchMock);
    render(
      <DashboardSkeletonEditor
        userId={42}
        workspace={{
          payload,
          revision: 3,
          enterpriseIdentityBoundAt: Date.parse("2026-07-01T00:00:00Z"),
        }}
      />,
    );

    const uploadButton = screen.getAllByRole("button", {
      name: "上传板块表格",
    })[0]!;
    const fileInput =
      uploadButton.parentElement?.querySelector<HTMLInputElement>(
        'input[type="file"]',
      );
    expect(fileInput).not.toBeNull();
    const file = new File(["列一,列二\n值一,值二"], "企业概览.csv", {
      type: "text/csv",
    });
    fireEvent.change(fileInput!, { target: { files: [file] } });

    await waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());
    const [, options] = fetchMock.mock.calls[0]!;
    const headers = options.headers as Record<string, string>;
    expect(headers["X-Dashboard-Module"]).toBe("section-table");
    expect(headers["X-Dashboard-Section-Id"]).toBe("overview");
    expect(headers["X-Dashboard-Revision"]).toBe("3");
    expect(headers["X-Import-Preview"]).toBe("true");
    expect(
      await screen.findByRole("heading", {
        name: "模块文件预检与差异确认",
      }),
    ).toBeInTheDocument();
  });

  it.skip("cancels a module after preflight without issuing a publication request", async () => {
    const onWorkspaceChanged = vi.fn();
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          kind: "dashboard-module-preview",
          preview: {
            mode: "dashboard-module",
            module: "metrics",
            sourceName: "指标.json",
            fileHash: "9".repeat(64),
            templateRevision: 3,
            summary: [
              "看板指标：现有 0 条，导入后 1 条；新增 1、更新 0、删除 0、不变 0",
            ],
            recordStats: [
              {
                label: "看板指标",
                beforeCount: 0,
                afterCount: 1,
                added: 1,
                updated: 0,
                removed: 0,
                unchanged: 0,
              },
            ],
            changedFields: [],
          },
        }),
        {
          status: 200,
          headers: { "Content-Type": "application/json" },
        },
      ),
    );
    vi.stubGlobal("fetch", fetchMock);
    render(
      <DashboardSkeletonEditor
        userId={42}
        workspace={{
          payload,
          revision: 3,
          enterpriseIdentityBoundAt: Date.parse("2026-07-01T00:00:00Z"),
        }}
        onWorkspaceChanged={onWorkspaceChanged}
      />,
    );

    const card = screen
      .getByText("首页数据概览", { selector: "strong" })
      .closest("article");
    const fileInput =
      card!.querySelector<HTMLInputElement>('input[type="file"]');
    fireEvent.change(fileInput!, {
      target: {
        files: [
          new File(["metrics"], "指标.json", {
            type: "application/json",
          }),
        ],
      },
    });

    await screen.findByRole("heading", {
      name: "模块文件预检与差异确认",
    });
    fireEvent.click(screen.getByRole("button", { name: "取消" }));
    await waitFor(() =>
      expect(
        screen.queryByRole("heading", {
          name: "模块文件预检与差异确认",
        }),
      ).not.toBeInTheDocument(),
    );
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(onWorkspaceChanged).not.toHaveBeenCalled();
  });

  it("previews the revision-bound optimization report diff before publishing", async () => {
    const onWorkspaceChanged = vi.fn();
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            kind: "optimization-report-preview",
            preview: {
              mode: "optimization-report",
              sourceName: "frontmind-optimization-report-template.json",
              fileHash: "d".repeat(64),
              templateRevision: 3,
              preflightToken: "signed-report-preflight-token",
              preflightExpiresAt: "2099-07-28T00:00:00.000Z",
              questionReports: {
                added: 1,
                updated: 1,
                removed: 0,
                unchanged: 0,
              },
              questionBaselines: {
                added: 0,
                updated: 1,
                removed: 0,
                unchanged: 0,
              },
              releasedAfterEffects: 1,
              questions: [
                {
                  id: "question-1",
                  question: reportQuestion.question,
                  afterEffectReleased: true,
                },
              ],
            },
          }),
          {
            status: 200,
            headers: { "Content-Type": "application/json" },
          },
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            kind: "dashboard",
            module: "optimization-report",
            dashboard: { payload: payloadWithReport, revision: 4 },
          }),
          {
            status: 200,
            headers: { "Content-Type": "application/json" },
          },
        ),
      );
    vi.stubGlobal("fetch", fetchMock);

    render(
      <DashboardSkeletonEditor
        userId={42}
        workspace={{
          payload: payloadWithReport,
          revision: 3,
          enterpriseIdentityBoundAt: Date.parse("2026-07-01T00:00:00Z"),
        }}
        onWorkspaceChanged={onWorkspaceChanged}
      />,
    );

    fireEvent.click(screen.getByRole("tab", { name: "进度报告" }));
    const card = document.querySelector(".customer-dashboard-editor-actions");
    expect(card).not.toBeNull();
    const fileInput =
      card!.querySelector<HTMLInputElement>('input[type="file"]');
    const file = new File(["revision-bound-report"], "进度报告.json", {
      type: "application/json",
    });
    fireEvent.change(fileInput!, { target: { files: [file] } });

    await screen.findByRole("heading", { name: "进度报告文件预检" });
    expect(screen.getByText("R3")).toBeInTheDocument();
    expect(screen.getByText("效果已开放")).toBeInTheDocument();
    expect(onWorkspaceChanged).not.toHaveBeenCalled();

    const previewHeaders = fetchMock.mock.calls[0]![1].headers as Record<
      string,
      string
    >;
    expect(previewHeaders["X-Import-Preview"]).toBe("true");
    expect(previewHeaders["X-Dashboard-Revision"]).toBe("3");

    fireEvent.click(screen.getByRole("button", { name: "确认发布" }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    const publishHeaders = fetchMock.mock.calls[1]![1].headers as Record<
      string,
      string
    >;
    expect(publishHeaders["X-Import-Preview"]).toBeUndefined();
    expect(publishHeaders["X-Import-File-Hash"]).toBe("d".repeat(64));
    expect(publishHeaders["X-Import-Preflight-Token"]).toBe(
      "signed-report-preflight-token",
    );
    await waitFor(() => expect(onWorkspaceChanged).toHaveBeenCalledOnce());
  });

  it("previews a complete monitoring workbook before publishing it", async () => {
    const onWorkspaceChanged = vi.fn();
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            kind: "monitoring-preview",
            preview: {
              mode: "answer-linked",
              fileHash: "a".repeat(64),
              preflightToken: "signed-monitoring-preflight-token",
              preflightExpiresAt: "2099-07-28T00:00:00.000Z",
              sampleCount: 25,
              citationCount: 705,
              exactLinked: 705,
              targetBatchRequired: false,
              questions: ["企业级知识库服务商推荐"],
              models: [
                { key: "doubao", label: "豆包" },
                { key: "deepseek", label: "DeepSeek" },
              ],
              dates: ["2026-07-24"],
              issues: [],
            },
          }),
          {
            status: 200,
            headers: { "Content-Type": "application/json" },
          },
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            kind: "monitoring",
            module: "monitoring",
            batch: { batchKey: "batch-2026-07-24" },
          }),
          {
            status: 200,
            headers: { "Content-Type": "application/json" },
          },
        ),
      );
    vi.stubGlobal("fetch", fetchMock);

    render(
      <DashboardSkeletonEditor
        userId={42}
        workspace={{
          payload,
          revision: 3,
          enterpriseIdentityBoundAt: Date.parse("2026-07-01T00:00:00Z"),
        }}
        onWorkspaceChanged={onWorkspaceChanged}
      />,
    );

    fireEvent.click(screen.getByRole("tab", { name: "问题监控" }));
    const card = document.querySelector(".customer-dashboard-editor-actions");
    const fileInput =
      card!.querySelector<HTMLInputElement>('input[type="file"]');
    const file = new File(["workbook"], "问题监控完整导入.xlsx", {
      type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    });
    fireEvent.change(fileInput!, { target: { files: [file] } });

    await screen.findByRole("heading", { name: "问题监控文件预检" });
    expect(screen.getByText("逐答案关联完备")).toBeInTheDocument();
    expect(screen.getByText("25")).toBeInTheDocument();
    expect(screen.getByText("705")).toBeInTheDocument();
    expect(onWorkspaceChanged).not.toHaveBeenCalled();

    const previewHeaders = fetchMock.mock.calls[0]![1].headers as Record<
      string,
      string
    >;
    expect(previewHeaders["X-Import-Preview"]).toBe("true");
    fireEvent.click(screen.getByRole("button", { name: "确认发布" }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    const publishHeaders = fetchMock.mock.calls[1]![1].headers as Record<
      string,
      string
    >;
    expect(publishHeaders["X-Import-Preview"]).toBeUndefined();
    expect(publishHeaders["X-Monitoring-File-Hash"]).toBe("a".repeat(64));
    expect(publishHeaders["X-Import-Preflight-Token"]).toBe(
      "signed-monitoring-preflight-token",
    );
    await waitFor(() => expect(onWorkspaceChanged).toHaveBeenCalledOnce());
    expect(mocks.toastSuccess).toHaveBeenCalledWith(
      "问题监控数据已发布",
      expect.objectContaining({
        description: "答案与引用来源已完成精确关联。",
      }),
    );
  });

  it("requires an existing answer batch for a legacy citation workbook", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          kind: "monitoring-preview",
          preview: {
            mode: "question-only",
            fileHash: "b".repeat(64),
            sampleCount: 0,
            citationCount: 705,
            exactLinked: 0,
            targetBatchRequired: true,
            questions: ["验收企业有哪些需要改进的方面？"],
            models: ["百度 AI", "豆包"],
            dates: ["2026-07-24"],
            availableBatches: [
              {
                batchKey: "batch-existing",
                sourceName: "2026-07-24 监控答案",
                collectedAt: "2026-07-24T02:00:00.000Z",
                sampleCount: 25,
              },
            ],
          },
        }),
        {
          status: 200,
          headers: { "Content-Type": "application/json" },
        },
      ),
    );
    vi.stubGlobal("fetch", fetchMock);

    render(
      <DashboardSkeletonEditor
        userId={42}
        workspace={{
          payload,
          revision: 3,
          enterpriseIdentityBoundAt: Date.parse("2026-07-01T00:00:00Z"),
        }}
      />,
    );

    fireEvent.click(screen.getByRole("tab", { name: "问题监控" }));
    const card = document.querySelector(".customer-dashboard-editor-actions");
    const fileInput =
      card!.querySelector<HTMLInputElement>('input[type="file"]');
    fireEvent.change(fileInput!, {
      target: {
        files: [
          new File(["legacy"], "引用分析数据导出.xlsx", {
            type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
          }),
        ],
      },
    });

    await screen.findByText("当前文件不包含逐答案关联键");
    expect(screen.getByLabelText("目标监控批次")).toHaveValue("batch-existing");
    expect(
      screen.getByText(/不会把引用模糊匹配到某次答案/),
    ).toBeInTheDocument();
  });

  it("re-preflights monitoring data when the selected target batch changes", async () => {
    const preview = (targetBatchKey: string, token: string) => ({
      kind: "monitoring-preview",
      preview: {
        module: "monitoring",
        mode: "question-only",
        sourceName: "引用分析.xlsx",
        fileHash: "7".repeat(64),
        templateRevision: 3,
        summary: ["引用记录 10 条。"],
        sampleCount: 0,
        citationCount: 10,
        exactLinked: 0,
        targetBatchRequired: true,
        suggestedBatchKey: "batch-a",
        preflightTargetBatchKey: targetBatchKey,
        preflightToken: token,
        preflightExpiresAt: "2099-07-28T00:00:00.000Z",
        questions: ["验收企业有哪些需要改进的方面？"],
        models: ["豆包"],
        dates: ["2026-07-24"],
        issues: [],
        availableBatches: [
          {
            batchKey: "batch-a",
            sourceName: "答案批次 A",
            sampleCount: 25,
          },
          {
            batchKey: "batch-b",
            sourceName: "答案批次 B",
            sampleCount: 25,
          },
        ],
      },
    });
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify(preview("batch-a", "token-a")), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify(preview("batch-b", "token-b")), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            kind: "monitoring",
            module: "monitoring",
            batch: { batchKey: "batch-b" },
          }),
          {
            status: 200,
            headers: { "Content-Type": "application/json" },
          },
        ),
      );
    vi.stubGlobal("fetch", fetchMock);

    render(
      <DashboardSkeletonEditor
        userId={42}
        workspace={{
          payload,
          revision: 3,
          enterpriseIdentityBoundAt: Date.parse("2026-07-01T00:00:00Z"),
        }}
      />,
    );
    fireEvent.click(screen.getByRole("tab", { name: "问题监控" }));
    const card = document.querySelector(".customer-dashboard-editor-actions");
    fireEvent.change(
      card!.querySelector<HTMLInputElement>('input[type="file"]')!,
      {
        target: {
          files: [
            new File(["legacy"], "引用分析.xlsx", {
              type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
            }),
          ],
        },
      },
    );

    const select = await screen.findByLabelText("目标监控批次");
    expect(select).toHaveValue("batch-a");
    fireEvent.change(select, { target: { value: "batch-b" } });
    fireEvent.click(screen.getByRole("button", { name: "确认发布" }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(3));
    const reboundHeaders = fetchMock.mock.calls[1]![1].headers as Record<
      string,
      string
    >;
    expect(reboundHeaders["X-Import-Preview"]).toBe("true");
    expect(reboundHeaders["X-Monitoring-Target-Batch-Key"]).toBe("batch-b");
    const publishHeaders = fetchMock.mock.calls[2]![1].headers as Record<
      string,
      string
    >;
    expect(publishHeaders["X-Monitoring-Target-Batch-Key"]).toBe("batch-b");
    expect(publishHeaders["X-Import-Preflight-Token"]).toBe("token-b");
  });

  it("blocks publishing when server preflight reports a row-level error", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          kind: "monitoring-preview",
          preview: {
            mode: "invalid",
            fileHash: "c".repeat(64),
            sampleCount: 0,
            citationCount: 0,
            exactLinked: 0,
            targetBatchRequired: false,
            questions: [],
            models: [],
            dates: [],
            issues: [
              {
                severity: "error",
                code: "MONITORING_IMPORT_INVALID",
                message: "问题引用分析 第 8 行的答案 ID 不存在",
              },
            ],
          },
        }),
        {
          status: 200,
          headers: { "Content-Type": "application/json" },
        },
      ),
    );
    vi.stubGlobal("fetch", fetchMock);

    render(
      <DashboardSkeletonEditor
        userId={42}
        workspace={{
          payload,
          revision: 3,
          enterpriseIdentityBoundAt: Date.parse("2026-07-01T00:00:00Z"),
        }}
      />,
    );

    fireEvent.click(screen.getByRole("tab", { name: "问题监控" }));
    const card = document.querySelector(".customer-dashboard-editor-actions");
    const fileInput =
      card!.querySelector<HTMLInputElement>('input[type="file"]');
    fireEvent.change(fileInput!, {
      target: {
        files: [
          new File(["invalid"], "问题监控错误数据.xlsx", {
            type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
          }),
        ],
      },
    });

    expect(
      await screen.findByText("问题引用分析 第 8 行的答案 ID 不存在"),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "确认发布" })).toBeDisabled();
    expect(fetchMock).toHaveBeenCalledOnce();
  });
});
