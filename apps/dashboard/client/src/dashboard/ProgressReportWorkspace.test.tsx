import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { dashboardOptimizationReportSchema } from "@shared/dashboard";
import ProgressReportWorkspace from "./ProgressReportWorkspace";

const report = dashboardOptimizationReportSchema.parse({
  period: "2026 年 7 月",
  title: "企业 GEO 优化进度报告",
  subtitle: "同问题前后测进度",
  executiveSummary: ["整体报告结论"],
  questionBaselines: [
    {
      id: "question-1",
      questionId: "question-1",
      question: "企业如何建立权威知识库？",
      category: "行业排名词",
      title: "知识库问题优化前基准",
      totalScore: 61,
      grade: "C",
      summary: "权威事实存在，但没有稳定进入模型回答。",
      dimensions: [
        {
          id: "semantic_visibility",
          label: "语义可见度",
          score: 15,
          maxScore: 30,
          summary: "提及仍不稳定。",
        },
      ],
      priorityActions: [
        {
          priority: 1,
          dimension: "语义可见度",
          action: "建立行业问题的标准位置。",
          expectedImpact: "提升稳定提及概率。",
        },
      ],
      limitations: ["本结果只代表当前问题和当前前测时间窗口。"],
    },
    {
      id: "question-2",
      questionId: "question-2",
      question: "企业官网如何成为 AI 权威信源？",
      category: "产品场景词",
      title: "官网信源问题优化前基准",
      totalScore: null,
      summary: "当前没有可比较的综合分，只保留证据差距。",
    },
  ],
  questionReports: [
    {
      id: "question-1",
      category: "行业排名词",
      question: "企业如何建立权威知识库？",
      summary: "第一题独立结论",
      metrics: [
        {
          label: "事实准确率",
          before: "62%",
          after: "88%",
          change: "+26 个百分点",
        },
      ],
      before: {
        platform: "DeepSeek",
        capturedAt: "2026-06-01",
        content: "优化前答案一",
        screenshots: [
          {
            id: "before-shot-1",
            url: "/api/dashboard/report-assets/42/11111111-1111-4111-8111-111111111111.png",
            alt: "真实优化前回答截图一",
          },
          {
            id: "before-shot-2",
            url: "/api/dashboard/report-assets/42/22222222-2222-4222-8222-222222222222.png",
            alt: "真实优化前回答截图二",
          },
        ],
      },
      expectedLogic: "先核验企业事实，再说明证据边界。",
      gaps: ["缺少可追溯证据"],
      after: {
        platform: "DeepSeek",
        capturedAt: "2026-07-01",
        content: "优化后答案一",
        screenshots: [
          {
            id: "after-shot-1",
            url: "/api/dashboard/report-assets/42/33333333-3333-4333-8333-333333333333.png",
            alt: "真实优化后回答截图",
          },
        ],
      },
      improvements: ["补齐官方证据"],
      analysis: "第一题改善分析",
      evidence: [
        {
          label: "不应显示的核验依据",
          source: "官方来源",
          url: "https://example.com/evidence",
          capturedAt: "2026-07-02",
          isOfficial: true,
        },
      ],
      afterEffect: {
        released: true,
        totalScore: 86,
        grade: "A",
        summary: "语义资产已经进入稳定改善阶段。",
        dimensions: [
          {
            id: "semantic_visibility",
            label: "语义可见度",
            score: 25,
            maxScore: 30,
            summary: "品牌提及更加稳定。",
          },
        ],
        platforms: [
          {
            platform: "DeepSeek",
            responseCount: 10,
            mentionRate: "90%",
            averageRank: "2.4",
            factAccuracy: "96%",
            propositionHitRate: "88%",
            citationCount: 18,
            verdict: "事实与排名均改善。",
          },
        ],
        gapFillSummary: "已补齐核心企业事实与官方信源。",
        gapClosures: [
          {
            topic: "权威事实来源",
            beforeGap: "缺少官方事实引用。",
            result: "回答已稳定引用企业官网。",
            status: "filled",
          },
        ],
      },
    },
    {
      id: "question-2",
      category: "产品场景词",
      question: "企业官网如何成为 AI 权威信源？",
      summary: "第二题独立结论",
      metrics: [],
      before: {
        platform: "豆包",
        capturedAt: "2026-06-01",
        content: "优化前答案二",
      },
      gaps: ["官网正文不可抽取"],
      after: {
        platform: "豆包",
        capturedAt: "2026-07-01",
        content: "优化后答案二",
      },
      improvements: ["增加机器可读事实段"],
      analysis: "第二题改善分析",
      afterEffect: {
        released: false,
        totalScore: 72,
      },
    },
  ],
});

describe("ProgressReportWorkspace", () => {
  it("lists confirmed workflow questions while their progress records are still syncing", () => {
    render(
      <ProgressReportWorkspace
        report={null}
        questionGroups={[
          {
            id: "ranking",
            title: "行业排名词",
            subtitle: "行业入口与品牌优胜问题",
            tone: "amber",
            questions: [
              {
                id: "question-pending",
                question: "企业级 GEO 服务商如何选择？",
                intent: "说明选择标准",
                summary: "",
              },
            ],
          },
        ]}
      />,
    );

    expect(
      screen.getByRole("complementary", { name: "报告问题" }),
    ).toBeInTheDocument();
    expect(screen.getByText("企业级 GEO 服务商如何选择？")).toBeInTheDocument();
    expect(
      screen.getByRole("heading", { name: "尚未发布问题进度报告" }),
    ).toBeInTheDocument();
  });

  it("switches between the baseline and progress report without inventing shared question data", () => {
    render(<ProgressReportWorkspace report={report} />);

    expect(screen.getByRole("tab", { name: /优化前基准/ })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    expect(
      screen.getByRole("heading", { name: "知识库问题优化前基准" }),
    ).toBeInTheDocument();
    for (const category of [
      "行业排名词",
      "竞品对比词",
      "美誉舆情词",
      "产品场景词",
    ]) {
      expect(screen.getByRole("tab", { name: category })).toBeInTheDocument();
    }
    expect(screen.queryByRole("tab", { name: "行业词" })).toBeNull();
    expect(screen.getAllByText("优化前基准").length).toBeGreaterThan(0);
    expect(screen.queryByText("PRE-OPTIMIZATION BASELINE")).toBeNull();
    expect(screen.queryByText("SEMANTIC ASSET DIMENSIONS")).toBeNull();
    expect(screen.getByRole("tab", { name: "竞品对比词" })).toBeDisabled();
    expect(screen.queryByText("基准后的优先动作")).not.toBeInTheDocument();
    expect(
      screen.queryByText("建立行业问题的标准位置。"),
    ).not.toBeInTheDocument();
    expect(screen.queryByText("评估边界")).not.toBeInTheDocument();
    expect(
      screen.queryByText("本结果只代表当前问题和当前前测时间窗口。"),
    ).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("tab", { name: "产品场景词" }));
    expect(
      screen.getByRole("heading", { name: "官网信源问题优化前基准" }),
    ).toBeInTheDocument();
    expect(
      screen.getByText("当前没有可比较的综合分，只保留证据差距。"),
    ).toBeInTheDocument();

    fireEvent.click(screen.getByRole("tab", { name: /优化进度报告/ }));
    expect(screen.getByText("优化前答案一")).toBeInTheDocument();
    expect(screen.getByText("+26 个百分点")).toBeInTheDocument();
    expect(screen.queryByText("2026-06-01")).toBeNull();
    expect(screen.queryByText("2026-07-01")).toBeNull();
    expect(screen.queryByText("不应显示的核验依据")).toBeNull();
    expect(
      screen.getByRole("heading", { name: "标准应答逻辑" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("heading", { name: "与应答逻辑的差距" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("heading", { name: "本轮已填补" }),
    ).toBeInTheDocument();
  });

  it("switches individual questions by the same four categories without an overall subreport", () => {
    render(<ProgressReportWorkspace report={report} />);
    fireEvent.click(screen.getByRole("tab", { name: /优化进度报告/ }));

    expect(screen.queryByRole("tab", { name: "整体进展" })).toBeNull();
    expect(screen.queryByRole("tab", { name: "逐问题对比" })).toBeNull();
    fireEvent.click(screen.getByRole("tab", { name: "产品场景词" }));
    expect(screen.getByText("优化前答案二")).toBeInTheDocument();
    expect(screen.getByText("第二题改善分析")).toBeInTheDocument();
    expect(screen.queryByText("+26 个百分点")).toBeNull();
  });

  it("opens all uploaded answer screenshots without rendering platform or capture metadata", () => {
    render(<ProgressReportWorkspace report={report} />);
    fireEvent.click(screen.getByRole("tab", { name: /优化进度报告/ }));

    fireEvent.click(screen.getByRole("button", { name: "显示答案截图（2）" }));

    const dialog = screen.getByRole("dialog", {
      name: "优化前答案截图",
    });
    expect(dialog).toBeInTheDocument();
    expect(
      screen.getByRole("img", { name: "真实优化前回答截图一" }),
    ).toHaveAttribute(
      "src",
      "/api/dashboard/report-assets/42/11111111-1111-4111-8111-111111111111.png",
    );
    expect(
      screen.getByRole("img", { name: "真实优化前回答截图二" }),
    ).toHaveAttribute(
      "src",
      "/api/dashboard/report-assets/42/22222222-2222-4222-8222-222222222222.png",
    );

    fireEvent.click(screen.getByRole("button", { name: "关闭答案截图" }));
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("shows the optimization effect page only for questions released by an administrator", () => {
    render(<ProgressReportWorkspace report={report} />);

    fireEvent.click(screen.getByRole("tab", { name: /优化后效果/ }));

    expect(
      screen.getByLabelText("优化后语义资产评分 86 分"),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("heading", { name: "不同平台的优化后情况" }),
    ).toBeInTheDocument();
    expect(screen.getByText("事实与排名均改善。")).toBeInTheDocument();
    expect(
      screen.getByRole("heading", {
        name: "知识事实与模型回答差距的填补",
      }),
    ).toBeInTheDocument();
    expect(screen.getByText("回答已稳定引用企业官网。")).toBeInTheDocument();
    expect(screen.queryByText("企业官网如何成为 AI 权威信源？")).toBeNull();
  });

  it("does not expose the optimization effect page before it is released", () => {
    const unreleased = dashboardOptimizationReportSchema.parse({
      title: "未开放报告",
      questionReports: [
        {
          id: "question-1",
          question: "尚未开放的问题",
          afterEffect: {
            released: false,
            totalScore: 78,
          },
        },
      ],
    });

    render(<ProgressReportWorkspace report={unreleased} />);

    expect(screen.queryByRole("tab", { name: /优化后效果/ })).toBeNull();
    expect(screen.queryByText("78")).toBeNull();
  });

  it("rejects releasing an incomplete optimization effect payload", () => {
    const result = dashboardOptimizationReportSchema.safeParse({
      title: "不完整效果报告",
      questionReports: [
        {
          id: "question-1",
          question: "不完整效果问题",
          afterEffect: {
            released: true,
            summary: "只有一段说明，尚未完成真实复测。",
          },
        },
      ],
    });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.map((issue) => issue.message)).toEqual(
        expect.arrayContaining([
          "开放优化后效果前必须填写优化后语义资产评分",
          "开放优化后效果前必须填写至少一个平台的真实复测结果",
          "开放优化后效果前必须填写知识事实与模型回答差距的填补结果",
        ]),
      );
    }
  });

  it("renders a legacy aggregate report directly when no question report exists", () => {
    const legacyReport = dashboardOptimizationReportSchema.parse({
      period: "2026 年 6 月",
      title: "企业历史进度报告",
      executiveSummary: ["历史周期整体结论"],
    });

    render(<ProgressReportWorkspace report={legacyReport} />);

    expect(
      screen.getByRole("heading", { name: "企业历史进度报告" }),
    ).toBeInTheDocument();
    expect(screen.getByText("历史周期整体结论")).toBeInTheDocument();
    expect(screen.queryByRole("tab", { name: "整体进展" })).toBeNull();
  });

  it("keeps rendering legacy question reports when screenshots are absent", () => {
    const legacyQuestionReport = structuredClone(report) as typeof report & {
      questionReports: Array<{
        before: { screenshots?: unknown[] };
        after: { screenshots?: unknown[] };
      }>;
    };
    Reflect.deleteProperty(
      legacyQuestionReport.questionReports[0]!.before,
      "screenshots",
    );
    Reflect.deleteProperty(
      legacyQuestionReport.questionReports[0]!.after,
      "screenshots",
    );

    render(<ProgressReportWorkspace report={legacyQuestionReport} />);

    expect(
      screen.getByRole("heading", { name: "知识库问题优化前基准" }),
    ).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /显示答案截图/ })).toBeNull();
  });
});
