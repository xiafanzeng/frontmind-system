import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { embeddedKnowledgeBasePanel } = vi.hoisted(() => ({
  embeddedKnowledgeBasePanel: vi.fn(),
}));

vi.mock("@/components/EmbeddedKnowledgeBasePanel", () => ({
  default: (props: {
    page: "build" | "display";
    mode?: "standard" | "workspace";
  }) => {
    embeddedKnowledgeBasePanel(props);
    return (
      <div
        data-testid="embedded-knowledge-base-panel"
        data-layout-mode={props.mode}
      >
        知识库组件：{props.page}
      </div>
    );
  },
}));

vi.mock("@/components/QuestionMaintenanceRequestDialog", () => ({
  default: () => null,
}));

import {
  getRouteRequestHistoryConfig,
  PreviewUserBrandDashboard,
} from "./UserBrandDashboard";
import { userPreviewFixtures } from "@/lib/development-preview-fixtures";

const basicPreviewPortal = userPreviewFixtures.getServicePortal("basic");
const luxuryPreviewPortal = userPreviewFixtures.getServicePortal("luxury");
const basicPurchasedQuestion =
  basicPreviewPortal.purchasedQuestions[0]?.question ?? "";
const previewQuestionCategoryLabels = Array.from(
  new Set(
    luxuryPreviewPortal.purchasedQuestions.map((question) =>
      question.kind === "industry"
        ? "行业排名词"
        : question.kind === "competitor"
          ? "竞品对比词"
          : question.kind === "reputation"
            ? "美誉舆情词"
            : "产品场景词",
    ),
  ),
);
const previewReportCategoryLabels = previewQuestionCategoryLabels;
const previewScenarioBaseline =
  userPreviewFixtures.optimizationReport.questionBaselines.find(
    (baseline) => baseline.category === "产品场景词",
  )!;

function UserBrandDashboard({
  preview: _preview,
  ...props
}: {
  preview?: boolean;
  [key: string]: unknown;
}) {
  return (
    <PreviewUserBrandDashboard {...props} fixtures={userPreviewFixtures} />
  );
}

function setPreviewPlan(plan: "basic" | "advanced" | "luxury") {
  window.history.replaceState({}, "", `/preview/user?plan=${plan}`);
}

describe("UserBrandDashboard service experience", () => {
  beforeEach(() => {
    embeddedKnowledgeBasePanel.mockReset();
    setPreviewPlan("basic");
  });

  it("routes every production website workspace through OAuth-only SiteOps", () => {
    const source = readFileSync(
      resolve(
        process.cwd(),
        "client/src/dashboard/UserBrandDashboard.tsx",
      ),
      "utf8",
    );

    expect(source).toContain(
      "const useSiteOpsWebsiteFlow = !previewMode;",
    );
    expect(source).not.toContain("hasLegacyWebsiteDeliveryState");
    expect(source).not.toContain("siteOpsClientAvailable");
  });

  it.each([
    [
      "问题优化",
      "intent",
      "question-optimization",
      "knowledge_base",
      "question_management",
    ],
    [
      "应答逻辑",
      "response-logic",
      "agent",
      "knowledge_base",
      "response_logic_management",
    ],
    [
      "知识库构建",
      "knowledge-agent",
      "build",
      undefined,
      "knowledge_management",
    ],
    [
      "知识库展示",
      "knowledge-agent",
      "display",
      undefined,
      "knowledge_management",
    ],
    [
      "官网",
      "semantic",
      "website-management",
      "website_operation",
      "website_management",
    ],
    ["内容", "semantic", "content-assets", "content_asset", undefined],
  ])(
    "maps the %s request history to its exact server scope",
    (_label, section, sub, type, surface) => {
      const config = getRouteRequestHistoryConfig(section, sub);
      expect(config?.type).toBe(type);
      expect(config?.surface).toBe(surface);
    },
  );

  it("opens on a service home and exposes the merged navigation without invented metrics", () => {
    render(<UserBrandDashboard preview />);

    expect(screen.queryByText("欢迎回来，验收企业")).not.toBeInTheDocument();
    expect(
      screen.queryByText(
        "系统会根据真实完成状态，一次只引导您处理当前最重要的一步；未到达的页面会说明前置条件。",
      ),
    ).not.toBeInTheDocument();
    expect(screen.getByLabelText("当前服务版本：普通版")).toBeInTheDocument();
    expect(screen.getByText("已生效 · 30 天单题服务")).toBeInTheDocument();
    const packageScope = screen.getByTestId("service-plan-scope");
    expect(
      within(packageScope)
        .getAllByRole("listitem")
        .map((item) => item.textContent),
    ).toEqual([
      "知识库展示",
      "问题优化",
      "应答逻辑智能体",
      "问题监控",
      "进度报告",
      "AI 友好内容资产",
    ]);
    expect(
      within(packageScope).queryByText("知识库智能体"),
    ).not.toBeInTheDocument();
    expect(
      within(packageScope).queryByText("已购问题"),
    ).not.toBeInTheDocument();

    for (const item of [
      "服务首页",
      "知识库智能体",
      "知识库展示",
      "品牌全域词库",
      "问题优化",
      "应答逻辑智能体",
      "问题监控",
      "进度报告",
      "内容资产运营",
      "AI友好官网管理",
    ]) {
      expect(screen.getByRole("button", { name: item })).toBeInTheDocument();
    }
    for (const label of [
      "服务概览",
      "品牌建设",
      "意图优化",
      "进度监控",
      "AI 友好内容资产",
    ]) {
      expect(screen.getAllByText(label).length).toBeGreaterThan(0);
      expect(
        screen.queryByRole("button", { name: label }),
      ).not.toBeInTheDocument();
    }
    expect(
      screen.queryByRole("button", { name: "渠道分发" }),
    ).not.toBeInTheDocument();

    const intentNavigation = screen
      .getByText("意图优化")
      .closest(".nav-section-label")?.nextElementSibling;
    const progressNavigation = screen
      .getByText("进度监控")
      .closest(".nav-section-label")?.nextElementSibling;
    expect(intentNavigation).toBeInstanceOf(HTMLElement);
    expect(progressNavigation).toBeInstanceOf(HTMLElement);
    expect(
      within(intentNavigation as HTMLElement).queryByRole("button", {
        name: "问题监控",
      }),
    ).not.toBeInTheDocument();
    expect(
      within(progressNavigation as HTMLElement).getByRole("button", {
        name: "问题监控",
      }),
    ).toBeInTheDocument();
    expect(
      within(progressNavigation as HTMLElement).getByRole("button", {
        name: "进度报告",
      }),
    ).toBeInTheDocument();

    const knowledgeAgent = screen.getByRole("button", {
      name: "知识库智能体",
    });
    const knowledgeDisplay = screen.getByRole("button", {
      name: "知识库展示",
    });
    const globalKeywords = screen.getByRole("button", {
      name: "品牌全域词库",
    });
    const contentAssets = screen.getByRole("button", {
      name: "内容资产运营",
    });
    const websiteManagement = screen.getByRole("button", {
      name: "AI友好官网管理",
    });
    expect(knowledgeAgent.querySelector("svg")).toBeInTheDocument();
    expect(globalKeywords.querySelector("svg")).toBeInTheDocument();
    expect(knowledgeDisplay.querySelector("svg")).not.toBeInTheDocument();
    expect(contentAssets.querySelector("svg")).toBeInTheDocument();
    expect(websiteManagement.querySelector("svg")).toBeInTheDocument();
    expect(contentAssets).toBeDisabled();
    expect(websiteManagement).toBeDisabled();
    expect(
      knowledgeAgent.compareDocumentPosition(knowledgeDisplay) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(
      knowledgeDisplay.compareDocumentPosition(globalKeywords) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();

    expect(
      screen.queryByRole("button", { name: "内容制作体系" }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "企业资料看板" }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "优化报告" }),
    ).not.toBeInTheDocument();
    expect(screen.queryByText("知识文档")).not.toBeInTheDocument();
    expect(screen.queryByText("图片资产")).not.toBeInTheDocument();
    expect(screen.queryByText("32.8")).not.toBeInTheDocument();
    expect(screen.queryByText("当前看板")).not.toBeInTheDocument();
    expect(screen.queryByText("服务中")).not.toBeInTheDocument();
    expect(document.querySelector(".project-ribbon")).not.toHaveTextContent(
      "普通版",
    );
    expect(
      screen.getByRole("heading", { name: "智能服务路径" }),
    ).toBeInTheDocument();
    expect(screen.queryByText("当前步骤优先")).not.toBeInTheDocument();
    expect(screen.queryByText("建议下一步")).not.toBeInTheDocument();

    const homeQuotaOverview = screen.getByRole("region", {
      name: "套餐配额",
    });
    expect(within(homeQuotaOverview).getByText("已购问题")).toBeInTheDocument();
    expect(within(homeQuotaOverview).getByText("1 / 1")).toBeInTheDocument();
    expect(
      screen.queryByText("企业官网怎样成为 AI 可引用的权威信源？"),
    ).not.toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "查看已购问题" }),
    ).toBeInTheDocument();
  });

  it("opens monitoring from progress and embeds channel distribution below it", async () => {
    setPreviewPlan("luxury");
    render(<UserBrandDashboard preview />);

    fireEvent.click(screen.getByRole("button", { name: "问题监控" }));

    const monitoringHeading = await screen.findByRole("heading", {
      name: "问题监控",
    });
    const distribution = await screen.findByRole("region", {
      name: "渠道分发",
    });
    expect(
      monitoringHeading.compareDocumentPosition(distribution) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(
      screen.queryByText(
        "在问题监控结果下直接核验各模型引用的内容、媒体信源与分发记录。",
      ),
    ).not.toBeInTheDocument();
    expect(screen.queryByText("CHANNEL DISTRIBUTION")).not.toBeInTheDocument();
    expect(
      screen.queryByRole("heading", { name: "渠道分发" }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "渠道分发" }),
    ).not.toBeInTheDocument();
  });

  it("removes retired content types and renames the B-class case study", () => {
    setPreviewPlan("luxury");
    render(<UserBrandDashboard preview />);

    fireEvent.click(screen.getByRole("button", { name: "内容资产运营" }));

    for (const retiredName of [
      "How-to 教程",
      "数据报告",
      "用例分析",
      "媒体背书稿",
      "危机公关稿",
      "百科词条新建",
      "Case Study",
    ]) {
      expect(screen.queryByText(retiredName)).not.toBeInTheDocument();
    }
    expect(screen.getAllByText("用户案例与成功故事").length).toBeGreaterThan(0);
    expect(screen.getByText("方案选型与服务边界事实")).toBeInTheDocument();
    expect(
      screen.getByText("方案选型时应优先核验哪些事实"),
    ).toBeInTheDocument();
  });

  it("locks content assets and website management for the basic plan", () => {
    setPreviewPlan("basic");
    render(<UserBrandDashboard preview />);

    const contentAssets = screen.getByRole("button", {
      name: "内容资产运营",
    });
    const websiteManagement = screen.getByRole("button", {
      name: "AI友好官网管理",
    });
    expect(contentAssets).toBeDisabled();
    expect(websiteManagement).toBeDisabled();
    fireEvent.click(contentAssets);
    fireEvent.click(websiteManagement);
    expect(
      screen.queryByRole("heading", { name: "提交内容需求" }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("region", { name: "官网运营功能未开放" }),
    ).not.toBeInTheDocument();
  });

  it("opens the server-gated AI-friendly website workflow without technical check cards", () => {
    setPreviewPlan("luxury");
    render(<UserBrandDashboard preview />);

    fireEvent.click(screen.getByRole("button", { name: "AI友好官网管理" }));

    expect(
      screen.getByRole("heading", { name: "AI友好官网管理" }),
    ).toBeInTheDocument();
    expect(screen.getByText("官网开通进度")).toBeInTheDocument();
    expect(
      screen.getAllByText("阿里云域名注册与 ICP 备案").length,
    ).toBeGreaterThan(0);
    expect(screen.queryByText("购买域名并提交 AI 运维需求")).toBeNull();
    expect(screen.queryByText("领取服务码并完成 ICP 备案")).toBeNull();
    expect(screen.queryByText("ICP 备案与主体材料")).not.toBeInTheDocument();
    expect(
      screen.getAllByText("AI专用官网构建与内容运营").length,
    ).toBeGreaterThan(0);
    expect(
      screen.getByRole("heading", { name: "提交官网内容运营需求" }),
    ).toBeInTheDocument();
    expect(screen.getByText("企业资料与品牌事实")).toBeInTheDocument();
    expect(screen.queryByText("官网检查项")).not.toBeInTheDocument();
    expect(screen.queryByText("域名与抓取检查")).not.toBeInTheDocument();
    expect(screen.queryByText("检查与合规检查")).not.toBeInTheDocument();
  });

  it("keeps the basic knowledge builder locked and never mounts it", async () => {
    render(<UserBrandDashboard preview />);

    const knowledgeAgent = screen.getByRole("button", {
      name: "知识库智能体",
    });
    expect(knowledgeAgent).toBeDisabled();
    fireEvent.click(knowledgeAgent);
    expect(
      screen.queryByTestId("embedded-knowledge-base-panel"),
    ).not.toBeInTheDocument();
    expect(embeddedKnowledgeBasePanel).not.toHaveBeenCalled();

    expect(
      screen.queryByRole("button", { name: "需求记录" }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("dialog", { name: "知识库需求记录" }),
    ).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "知识库展示" }));
    expect(
      await screen.findByTestId("embedded-knowledge-base-panel"),
    ).toHaveTextContent("知识库组件：display");
    expect(embeddedKnowledgeBasePanel).toHaveBeenCalledWith(
      expect.objectContaining({ preview: true, page: "display" }),
    );
  });

  it("keeps response-logic request history available with no purchased questions", () => {
    setPreviewPlan("luxury");
    render(
      <PreviewUserBrandDashboard
        fixtures={{
          ...userPreviewFixtures,
          getServicePortal: () => ({
            ...luxuryPreviewPortal,
            purchasedQuestions: [],
          }),
        }}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "应答逻辑智能体" }));

    expect(screen.getByText("暂无已发布内容")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "需求记录" }));
    expect(
      screen.getByRole("dialog", { name: "应答逻辑需求记录" }),
    ).toBeInTheDocument();
  });

  it("removes an open request-history dialog when its route becomes locked", () => {
    setPreviewPlan("luxury");
    let portal = {
      ...luxuryPreviewPortal,
      purchasedQuestions: [],
    };
    const fixtures = {
      ...userPreviewFixtures,
      getServicePortal: () => portal,
    };
    const { rerender } = render(
      <PreviewUserBrandDashboard fixtures={fixtures} />,
    );

    fireEvent.click(screen.getByRole("button", { name: "应答逻辑智能体" }));
    fireEvent.click(screen.getByRole("button", { name: "需求记录" }));
    expect(
      screen.getByRole("dialog", { name: "应答逻辑需求记录" }),
    ).toBeInTheDocument();

    portal = {
      ...portal,
      capabilities: {
        ...portal.capabilities,
        responseLogic: {
          allowed: false,
          effectiveStatus: "pending",
          reason: "服务端正在准备应答逻辑。",
          nextAction: {
            kind: "view_progress_report",
            label: "查看服务进度",
            href: "/progress-report",
          },
        },
      },
    };
    rerender(<PreviewUserBrandDashboard fixtures={fixtures} />);

    expect(
      screen.queryByRole("dialog", { name: "应答逻辑需求记录" }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "需求记录" }),
    ).not.toBeInTheDocument();
    expect(screen.getByText("服务端正在准备应答逻辑。")).toBeInTheDocument();

    portal = {
      ...portal,
      capabilities: luxuryPreviewPortal.capabilities,
    };
    rerender(<PreviewUserBrandDashboard fixtures={fixtures} />);

    expect(
      screen.getByRole("button", { name: "需求记录" }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("dialog", { name: "应答逻辑需求记录" }),
    ).not.toBeInTheDocument();
  });

  it("keeps the user knowledge builder on one conversation without a switcher", () => {
    const source = readFileSync(
      resolve(
        process.cwd(),
        "client/src/components/EmbeddedKnowledgeBasePanel.tsx",
      ),
      "utf8",
    );

    expect(source).toContain("<Home");
    expect(source).toContain("hideSidebar");
    expect(source).not.toContain('from "@/components/Sidebar"');
    expect(source).not.toContain("新建会话");
  });

  it("shows only the purchased basic question and never presents an unconfirmed response as a confirmed result", async () => {
    render(<UserBrandDashboard preview />);

    fireEvent.click(screen.getByRole("button", { name: "问题优化" }));
    expect(
      await screen.findByRole("button", {
        name: basicPurchasedQuestion,
      }),
    ).toBeInTheDocument();
    expect(
      await screen.findByRole("heading", {
        name: "尚未形成已确认的应答逻辑",
      }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "进入应答逻辑智能体" }),
    ).toBeInTheDocument();
    for (const redundantCopy of [
      "建议的优化方向",
      "为什么这样优化",
      "优化方向已确认",
      "此问题优化方向已确认",
      `围绕“${basicPurchasedQuestion}”核验企业事实、服务能力与可追溯证据。`,
    ]) {
      expect(screen.queryByText(redundantCopy)).not.toBeInTheDocument();
    }
    expect(
      screen.queryByRole("heading", { name: "美誉舆情" }),
    ).not.toBeInTheDocument();

    const globalKeywords = screen.getByRole("button", {
      name: "品牌全域词库",
    });
    expect(globalKeywords).toBeDisabled();
    fireEvent.click(globalKeywords);
    expect(
      screen.getByRole("heading", { name: "尚未形成已确认的应答逻辑" }),
    ).toBeInTheDocument();
  });

  it("keeps the package quota visible while reviewing problem optimization", () => {
    render(<UserBrandDashboard preview />);

    fireEvent.click(screen.getByRole("button", { name: "问题优化" }));

    const problemQuotaOverview = screen.getByRole("region", {
      name: "套餐配额",
    });
    expect(
      within(problemQuotaOverview).getByText("已购问题"),
    ).toBeInTheDocument();
    expect(within(problemQuotaOverview).getByText("1 / 1")).toBeInTheDocument();
    expect(
      within(problemQuotaOverview).queryByText(/剩余/),
    ).not.toBeInTheDocument();
    expect(
      within(problemQuotaOverview).queryByRole("progressbar"),
    ).not.toBeInTheDocument();
  });

  it("renders the preview word bank without heat controls and keeps fixture order", () => {
    setPreviewPlan("luxury");
    render(<UserBrandDashboard preview />);

    fireEvent.click(screen.getByRole("button", { name: "品牌全域词库" }));

    expect(
      screen.getAllByText(
        "基于百度营销、小红书蒲公英、抖音巨量指数等平台数据综合整理 GEO 优化问题，支持按主分类与问题细分筛选。",
      ).length,
    ).toBeGreaterThan(0);
    const keywordTable = screen.getByRole("table");
    expect(
      within(keywordTable)
        .getAllByRole("columnheader")
        .map((header) => header.textContent),
    ).toEqual(["问题", "主分类", "问题细分", "问题优化"]);
    expect(
      within(keywordTable).queryByRole("columnheader", { name: /热度/ }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByText(/热度从高到低|热度从低到高/),
    ).not.toBeInTheDocument();

    const rows = within(keywordTable).getAllByRole("row");
    expect(
      within(rows[1]!).getByText("验收企业的方案适合哪些业务场景？"),
    ).toBeInTheDocument();
    expect(
      within(rows[2]!).getByText("如何核验验收企业的公开口碑？"),
    ).toBeInTheDocument();
  });

  it("locks a brand keyword, confirms it, and reflects preview quota usage", async () => {
    setPreviewPlan("luxury");
    const novelPreviewKeywordQuestion = "验收企业有哪些全新的落地场景？";
    render(
      <PreviewUserBrandDashboard
        fixtures={{
          ...userPreviewFixtures,
          globalKeywordBank: {
            ...userPreviewFixtures.globalKeywordBank,
            questions: [
              {
                ...userPreviewFixtures.globalKeywordBank.questions[0],
                问题: novelPreviewKeywordQuestion,
              },
              ...userPreviewFixtures.globalKeywordBank.questions.slice(1),
            ],
          },
          getServicePortal: () => ({
            ...luxuryPreviewPortal,
            quotas: luxuryPreviewPortal.quotas.map((quota) => ({
              ...quota,
              used: 0,
            })),
          }),
        }}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "品牌全域词库" }));
    const selectedQuestion = screen.getAllByRole("button", {
      name: "选择并进入问题优化",
    })[0];
    fireEvent.click(selectedQuestion);

    expect(
      screen.getByRole("heading", { name: "问题优化" }),
    ).toBeInTheDocument();
    const questionInput = screen.getByRole("textbox", {
      name: "目标问题",
    });
    expect(questionInput).toHaveValue(novelPreviewKeywordQuestion);
    expect(questionInput).toHaveAttribute("readonly");
    expect(screen.getByRole("textbox", { name: "问题来源" })).toHaveValue(
      "品牌全域词库",
    );

    fireEvent.click(screen.getByRole("button", { name: "确认优化问题" }));
    expect(screen.getByRole("alertdialog")).toHaveTextContent(
      "确认后开启进度将不可修改。",
    );
    fireEvent.click(screen.getByRole("button", { name: "返回检查" }));
    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
    expect(screen.queryByText("待监控工程师确认")).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "确认优化问题" }));
    fireEvent.click(screen.getByRole("button", { name: "确认并开启进度" }));

    await waitFor(() =>
      expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument(),
    );
    const quotaOverview = screen.getByRole("region", { name: "套餐配额" });
    const scenarioQuota = within(quotaOverview)
      .getByText("产品场景词")
      .closest("article");
    expect(scenarioQuota).not.toBeNull();
    expect(
      within(scenarioQuota!).getByText("已用 1 / 已解锁 5"),
    ).toBeInTheDocument();
    expect(
      within(scenarioQuota!).getByText("全年 20 个词"),
    ).toBeInTheDocument();
    const questionDirectory = screen.getByRole("complementary", {
      name: "问题目录",
    });
    fireEvent.click(
      within(questionDirectory).getByRole("button", { name: "产品场景词" }),
    );
    expect(
      within(questionDirectory).getByText(novelPreviewKeywordQuestion),
    ).toBeInTheDocument();
  });

  it("leaves direct-question classification to the service team and links back to the brand question library", () => {
    setPreviewPlan("luxury");
    render(<UserBrandDashboard preview />);

    fireEvent.click(screen.getByRole("button", { name: "问题优化" }));

    expect(
      screen.getByRole("heading", {
        name: "从品牌全域词库选择或自主填写需要优化的问题",
      }),
    ).toBeInTheDocument();
    const questionInput = screen.getByRole("textbox", {
      name: "目标问题",
    });
    expect(questionInput.tagName).toBe("INPUT");
    expect(questionInput).toHaveAttribute("type", "text");
    expect(questionInput).not.toHaveAttribute("readonly");
    expect(
      screen.queryByRole("combobox", { name: "问题类别" }),
    ).not.toBeInTheDocument();
    expect(
      screen.getByText(
        "品牌词库问题确认后会立即锁定并进入服务；自主填写的问题将提交专业审核，由后台分配问题类型。",
      ),
    ).toBeInTheDocument();
    const sourceInput = screen.getByRole("textbox", { name: "问题来源" });
    expect(sourceInput).toHaveValue("自主填写");
    expect(sourceInput).toHaveAttribute("readonly");

    fireEvent.click(screen.getByRole("button", { name: "前往品牌全域词库" }));
    expect(
      screen.getByRole("heading", { name: "品牌全域词库" }),
    ).toBeInTheDocument();
  });

  it("keeps a visible history entry for a self-entered review request", async () => {
    setPreviewPlan("luxury");
    render(
      <PreviewUserBrandDashboard
        fixtures={{
          ...userPreviewFixtures,
          getServicePortal: () => ({
            ...luxuryPreviewPortal,
            quotas: luxuryPreviewPortal.quotas.map((quota) => ({
              ...quota,
              used: 0,
            })),
          }),
        }}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "问题优化" }));
    fireEvent.change(screen.getByRole("textbox", { name: "目标问题" }), {
      target: { value: "验收企业如何证明复杂项目交付能力？" },
    });
    fireEvent.click(screen.getByRole("button", { name: "提交专业审核" }));
    await waitFor(() =>
      expect(screen.getByText("待监控工程师确认")).toBeInTheDocument(),
    );
    expect(screen.getAllByRole("button", { name: "需求记录" })).toHaveLength(1);
    fireEvent.click(screen.getByRole("button", { name: "需求记录" }));

    const historyDialog = screen.getByRole("dialog", {
      name: "问题需求记录",
    });
    expect(historyDialog).toHaveTextContent(
      "验收企业如何证明复杂项目交付能力？",
    );
    expect(historyDialog).toHaveTextContent("问题审核 · 自主填写");
    expect(historyDialog).toHaveTextContent("待处理");
  });

  it("keeps luxury questions split into their authoritative category blocks on both optimization pages", async () => {
    setPreviewPlan("luxury");
    render(<UserBrandDashboard preview />);

    fireEvent.click(screen.getByRole("button", { name: "问题优化" }));
    const optimizationNav = await screen.findByRole("complementary", {
      name: "问题目录",
    });
    for (const category of previewQuestionCategoryLabels) {
      expect(
        within(optimizationNav).getByRole("button", { name: category }),
      ).toBeInTheDocument();
    }
    expect(within(optimizationNav).queryByText("已购问题")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "应答逻辑智能体" }));
    const agentNav = await screen.findByRole("complementary", {
      name: "待优化问题",
    });
    for (const category of previewQuestionCategoryLabels) {
      expect(
        within(agentNav).getByRole("button", { name: category }),
      ).toBeInTheDocument();
    }
    expect(within(agentNav).queryByText("已购问题")).toBeNull();
  });

  it("uses the same authoritative question categories for baselines and progress reports", () => {
    setPreviewPlan("luxury");
    render(<UserBrandDashboard preview />);

    fireEvent.click(screen.getByRole("button", { name: "进度报告" }));

    const baselineNav = screen.getByRole("complementary", {
      name: "基准问题",
    });
    for (const category of previewReportCategoryLabels) {
      expect(
        within(baselineNav).getByRole("tab", { name: category }),
      ).toBeInTheDocument();
    }
    fireEvent.click(
      within(baselineNav).getByRole("tab", { name: "产品场景词" }),
    );
    expect(
      screen.getByRole("heading", {
        name: previewScenarioBaseline.title,
      }),
    ).toBeInTheDocument();
    expect(screen.queryByText("基准后的优先动作")).not.toBeInTheDocument();
    expect(screen.queryByText("评估边界")).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("tab", { name: /优化进度报告/ }));
    const progressNav = screen.getByRole("complementary", {
      name: "报告问题",
    });
    for (const category of previewReportCategoryLabels) {
      expect(
        within(progressNav).getByRole("tab", { name: category }),
      ).toBeInTheDocument();
    }
    expect(
      screen.queryByRole("tab", { name: "整体进展" }),
    ).not.toBeInTheDocument();
  });

  it("renders account, plan, validity and security without commercial or API key data", async () => {
    render(<UserBrandDashboard preview />);

    fireEvent.click(screen.getByRole("button", { name: "账号与服务" }));

    const accountDialog = await screen.findByRole("dialog");
    expect(accountDialog).toBeInTheDocument();
    expect(
      screen.getByRole("heading", { name: "账号与服务" }),
    ).toBeInTheDocument();
    expect(
      screen.getByText(basicPreviewPortal.account.username),
    ).toBeInTheDocument();
    expect(screen.getByText("企业名称")).toBeInTheDocument();
    expect(within(accountDialog).queryByText("用户")).not.toBeInTheDocument();
    expect(
      screen.getByText(
        `${basicPreviewPortal.plan.validFrom.replaceAll("-", "/")} 至 ${basicPreviewPortal.plan.validUntil.replaceAll("-", "/")}`,
      ),
    ).toBeInTheDocument();
    expect(
      within(accountDialog).getByRole("heading", { name: "普通版" }),
    ).toBeInTheDocument();
    expect(within(accountDialog).getByText("已生效")).toBeInTheDocument();
    expect(
      within(accountDialog).queryByText("购买记录"),
    ).not.toBeInTheDocument();
    expect(within(accountDialog).queryByText("订单")).not.toBeInTheDocument();
    expect(within(accountDialog).queryByText("合同")).not.toBeInTheDocument();
    expect(
      within(accountDialog).queryByText("签署主体"),
    ).not.toBeInTheDocument();
    expect(
      within(accountDialog).queryByRole("region", { name: "套餐配额" }),
    ).not.toBeInTheDocument();
    expect(
      within(accountDialog).queryByText("套餐配额"),
    ).not.toBeInTheDocument();
    expect(within(accountDialog).queryByText("1 / 1")).not.toBeInTheDocument();
    expect(within(accountDialog).queryByText("知识库")).not.toBeInTheDocument();
    expect(
      within(accountDialog).queryByText("知识库版本"),
    ).not.toBeInTheDocument();
    expect(
      within(accountDialog).queryByText("V1 · 可查看"),
    ).not.toBeInTheDocument();
    expect(screen.queryByText("普通版 · 账号与服务")).not.toBeInTheDocument();
    expect(
      screen.getByRole("link", { name: "继续购买普通版" }),
    ).toHaveAttribute("href", "https://www.frontmind.net");
    const upgradeAdvanced = screen.getByRole("button", {
      name: "升级进阶版",
    });
    expect(upgradeAdvanced).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "升级豪华版" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "修改密码" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "退出登录" }),
    ).toBeInTheDocument();
    fireEvent.click(upgradeAdvanced);
    expect(
      await screen.findByRole("heading", { name: "联系服务专员" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("img", {
        name: "FrontMind 服务专员企业微信二维码",
      }),
    ).toHaveAttribute("src", "/frontmind-sales-wechat.png?v=wecom-20260801");
    expect(screen.queryByText(/API Key/i)).not.toBeInTheDocument();
  });

  it("offers one luxury renewal action through WeChat without duplicate contact or basic purchase actions", async () => {
    setPreviewPlan("luxury");
    render(<UserBrandDashboard preview />);

    fireEvent.click(screen.getByRole("button", { name: "账号与服务" }));
    const accountDialog = await screen.findByRole("dialog");

    expect(
      within(accountDialog).queryByRole("link", {
        name: "继续购买普通版",
      }),
    ).not.toBeInTheDocument();
    const renewLuxury = within(accountDialog).getByRole("button", {
      name: "续费豪华版",
    });
    expect(renewLuxury).toBeInTheDocument();
    expect(
      within(accountDialog).queryByRole("button", {
        name: "联系服务专员",
      }),
    ).not.toBeInTheDocument();

    fireEvent.click(renewLuxury);
    const advisorHeading = await screen.findByRole("heading", {
      name: "联系服务专员",
    });
    const advisorDialog = advisorHeading.closest('[role="dialog"]');
    expect(advisorDialog).toHaveClass("z-[1210]", "bg-white", "shadow-2xl");
    expect(document.querySelector('[data-slot="dialog-overlay"]')).toHaveClass(
      "z-[1200]",
      "bg-black/35",
    );
    expect(
      screen.queryByRole("heading", { name: "账号与服务" }),
    ).not.toBeInTheDocument();
    expect(
      screen.getByRole("img", {
        name: "FrontMind 服务专员企业微信二维码",
      }),
    ).toHaveAttribute("src", "/frontmind-sales-wechat.png?v=wecom-20260801");
  });

  it("keeps prior-cycle questions out of the compact current-cycle summary", () => {
    setPreviewPlan("advanced");
    render(<UserBrandDashboard preview />);

    expect(screen.getByText("待确认问题清单")).toBeInTheDocument();
    expect(screen.getByText("知识库智能体待完成")).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "继续知识库智能体" }),
    ).toBeInTheDocument();
    expect(screen.queryByText("8 个已购问题")).not.toBeInTheDocument();
    expect(screen.queryByText("只读历史问题")).not.toBeInTheDocument();
    expect(
      screen.queryByText("验收企业的企业级知识服务是否值得信赖？"),
    ).not.toBeInTheDocument();
  });

  it("keeps Advanced semantic assets locked until the knowledge agent publishes", () => {
    setPreviewPlan("advanced");
    render(<UserBrandDashboard preview />);

    fireEvent.click(screen.getByRole("button", { name: "内容资产运营" }));

    expect(
      screen.getByText(
        "请先在知识库智能体中完成全部节点并发布当前服务的认证知识库；知识库展示完成后解锁 AI 友好内容资产。",
      ),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("heading", { name: "提交内容需求" }),
    ).not.toBeInTheDocument();
  });

  it("keeps knowledge versions and read-only history out of account settings", async () => {
    setPreviewPlan("advanced");
    render(<UserBrandDashboard preview />);

    fireEvent.click(screen.getByRole("button", { name: "账号与服务" }));
    const accountDialog = await screen.findByRole("dialog");

    expect(
      within(accountDialog).queryByText("知识库版本"),
    ).not.toBeInTheDocument();
    expect(
      within(accountDialog).queryByText("只读历史问题"),
    ).not.toBeInTheDocument();
    expect(
      within(accountDialog).queryByText(
        "验收企业的企业级知识服务是否值得信赖？",
      ),
    ).not.toBeInTheDocument();
  });

  it.each([
    ["advanced", "进阶版", "已生效 · 按季度", "待确认问题清单", ""],
    [
      "luxury",
      "豪华版",
      "已生效 · 年度服务 · 按季度解锁",
      `${luxuryPreviewPortal.purchasedQuestions.length} 个已购问题`,
      "",
    ],
  ] as const)(
    "unlocks the knowledge builder for the %s plan",
    async (
      plan,
      planName,
      serviceLine,
      purchasedQuestionCount,
      deliveryNote,
    ) => {
      setPreviewPlan(plan);
      render(<UserBrandDashboard preview />);

      const planCard = screen.getByLabelText(`当前服务版本：${planName}`);
      expect(planCard).toBeInTheDocument();
      expect(within(planCard).getByText(serviceLine)).toBeInTheDocument();
      expect(screen.queryByText(/¥|29,800|89,400/)).not.toBeInTheDocument();
      expect(screen.queryByText(/知识库版本\s+V\d+/)).not.toBeInTheDocument();
      if (deliveryNote) {
        expect(screen.getByText(deliveryNote)).toBeInTheDocument();
      }
      expect(screen.getByText(purchasedQuestionCount)).toBeInTheDocument();
      const packageScope = screen.getByTestId("service-plan-scope");
      expect(
        within(packageScope)
          .getAllByRole("listitem")
          .map((item) => item.textContent),
      ).toEqual([
        "知识库智能体",
        "品牌全域词库与选题",
        "问题优化",
        "应答逻辑智能体",
        "问题监控",
        "进度报告",
        "AI 友好内容资产",
      ]);
      expect(
        within(packageScope).queryByText("知识库展示"),
      ).not.toBeInTheDocument();
      expect(
        within(packageScope).queryByText("舆情监控·品牌追踪"),
      ).not.toBeInTheDocument();
      for (const item of [
        "知识库智能体",
        "知识库展示",
        "品牌全域词库",
        "问题优化",
        "应答逻辑智能体",
        "问题监控",
        "进度报告",
        "内容资产运营",
        "AI友好官网管理",
      ]) {
        const navigationItem = screen.getByRole("button", { name: item });
        expect(navigationItem).not.toBeDisabled();
        expect(navigationItem).not.toHaveAttribute("title");
        expect(navigationItem.querySelector("svg")).not.toBeInTheDocument();
      }
      expect(
        screen.queryByRole("button", { name: "渠道分发" }),
      ).not.toBeInTheDocument();

      fireEvent.click(screen.getByRole("button", { name: "知识库智能体" }));
      expect(
        await screen.findByTestId("embedded-knowledge-base-panel"),
      ).toHaveTextContent("知识库组件：build");
      await waitFor(() =>
        expect(embeddedKnowledgeBasePanel).toHaveBeenCalledWith(
          expect.objectContaining({ preview: true, page: "build" }),
        ),
      );
    },
  );
});
