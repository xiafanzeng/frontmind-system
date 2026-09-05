import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { DeliveryTicketQuota } from "@shared/delivery-ticket";
import AiWebsiteManagementWorkspace from "./AiWebsiteManagementWorkspace";

const websiteContentCatalog = [
  { value: "company_facts" as const, label: "企业资料与品牌事实" },
  { value: "product_case_docs" as const, label: "产品案例与文档" },
  { value: "industry_news" as const, label: "行业新闻与观察" },
  { value: "company_news" as const, label: "企业新闻与动态" },
  { value: "faq_content" as const, label: "FAQ 与问答页面" },
];

function websiteQuota(
  input: Partial<DeliveryTicketQuota> = {},
): DeliveryTicketQuota {
  return {
    type: "website_content_publish",
    allowed: true,
    used: 0,
    reserved: 0,
    consumed: 0,
    limit: 20,
    remaining: 20,
    periodId: "period-1",
    validFrom: null,
    validUntil: null,
    reason: null,
    ...input,
  };
}

describe("AiWebsiteManagementWorkspace", () => {
  it("shows only customer-facing results in the engineer preview", () => {
    render(
      <AiWebsiteManagementWorkspace
        planCode="advanced"
        quota={websiteQuota()}
        websiteWorkflow={{
          domainStatus: "completed",
          icpStatus: "completed",
          canSubmitContent: true,
        }}
        contentCatalog={websiteContentCatalog}
        readOnlyPreview
      />,
    );

    expect(
      screen.getByRole("heading", { name: "客户官网结果预览" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("heading", { name: "客户当前可见状态" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("heading", { name: "客户收到的公开交付结果" }),
    ).toBeInTheDocument();
    expect(
      screen.queryByText("阿里云企业域名注册图文教程"),
    ).not.toBeInTheDocument();
    expect(screen.queryByText(/图文教程逐步完成/)).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "提交工单" })).toBeNull();
  });

  it("removes the old technical console and exposes the fixed two-step workflow", () => {
    render(
      <AiWebsiteManagementWorkspace
        planCode="advanced"
        quota={websiteQuota()}
        websiteWorkflow={{
          domainStatus: "completed",
          icpStatus: "completed",
          canSubmitIcp: false,
          canSubmitContent: true,
        }}
        onSubmit={vi.fn()}
      />,
    );

    expect(
      screen.getByRole("heading", { name: "官网开通进度" }),
    ).toBeInTheDocument();
    expect(screen.getByText("阿里云域名注册与 ICP 备案")).toBeInTheDocument();
    expect(screen.getByText("AI专用官网构建与内容运营")).toBeInTheDocument();
    expect(
      screen.queryByText("购买域名并提交 AI 运维工单"),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByText("领取服务码并完成 ICP 备案"),
    ).not.toBeInTheDocument();
    expect(screen.queryByText("域名申请")).not.toBeInTheDocument();
    expect(screen.queryByText("ICP 备案与主体材料")).not.toBeInTheDocument();
    for (const removedCopy of [
      "官网运营目录",
      "官网检查项",
      "处理方式",
      "官网资料",
      "当前官网",
      "查看发布页面",
    ]) {
      expect(screen.queryByText(removedCopy)).not.toBeInTheDocument();
    }
  });

  it("starts with domain registration and does not require a service code up front", () => {
    const onContactAdvisor = vi.fn();
    render(
      <AiWebsiteManagementWorkspace
        planCode="advanced"
        quota={websiteQuota({ limit: 20, remaining: 0 })}
        websiteWorkflow={{
          domainStatus: "not_started",
          icpStatus: "locked",
          canSubmitDomain: true,
          canSubmitIcp: false,
          canSubmitContent: false,
        }}
        onSubmit={vi.fn()}
        onContactAdvisor={onContactAdvisor}
      />,
    );

    expect(screen.queryByLabelText("需求类型")).not.toBeInTheDocument();
    expect(
      screen.queryByText("域名购买完成后，在这里提交"),
    ).not.toBeInTheDocument();
    expect(
      screen.getByText("企业首次备案：照着下面 7 个阶段一步一步做"),
    ).toBeInTheDocument();
    expect(
      screen.queryByText("备案服务码不用提前准备"),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByText("FrontMind 备案服务码", { selector: "li" }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByText(/当前官网内容发布额度已用完/),
    ).not.toBeInTheDocument();

    const stageOne = screen.getByRole("button", {
      name: /准备资料，创建企业域名信息模板并完成实名认证/,
    });
    const stageTwo = screen.getByRole("button", {
      name: /查询、购买域名，并确认域名状态正常/,
    });
    const stageThree = screen.getByRole("button", {
      name: /回到 FrontMind 提交已购买域名，等待备案服务码/,
    });
    const stageFour = screen.getByRole("button", {
      name: /进入 ICP 备案系统并完成基础信息校验/,
    });
    expect(stageOne).toHaveAttribute("aria-expanded", "true");
    expect(stageTwo).toHaveAttribute("aria-expanded", "false");
    expect(stageThree).toHaveAttribute("aria-expanded", "false");

    fireEvent.click(
      screen.getByRole("button", {
        name: "不确定场景，联系服务专员",
      }),
    );
    expect(onContactAdvisor).toHaveBeenCalledTimes(1);

    fireEvent.click(stageTwo);
    fireEvent.click(stageThree);
    fireEvent.click(stageFour);
    expect(
      screen.getByRole("link", { name: /去阿里云查询并注册域名/ }),
    ).toHaveAttribute("href", "https://wanwang.aliyun.com/");
    expect(
      screen.getByRole("link", { name: /去阿里云开始 ICP 备案/ }),
    ).toHaveAttribute("href", "https://beian.aliyun.com/");
    const purchasedDomain = screen.getByLabelText("已购买域名");
    expect(stageThree.closest("li")).toContainElement(purchasedDomain);
    expect(screen.getByText("域名购买完成后，在这里提交")).toBeInTheDocument();
    expect(screen.queryByLabelText("ICP 主体备案号")).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "提交工单" }),
    ).not.toBeInTheDocument();
    expect(
      screen.getByRole("button", {
        name: "提交域名，创建 AI 运维工单",
      }),
    ).toBeInTheDocument();
    expect(screen.queryByLabelText(/上传营业执照/)).not.toBeInTheDocument();
  });

  it("renders local lazy-loaded guide screenshots and opens an accessible viewer", () => {
    render(
      <AiWebsiteManagementWorkspace
        planCode="advanced"
        quota={websiteQuota()}
        websiteWorkflow={{
          domainStatus: "not_started",
          icpStatus: "locked",
          canSubmitIcp: false,
          canSubmitContent: false,
        }}
        onSubmit={vi.fn()}
      />,
    );

    const stageOne = screen.getByRole("button", {
      name: /准备资料，创建企业域名信息模板并完成实名认证/,
    });

    const screenshot = screen.getByRole("img", {
      name: /阿里云企业备案主办者基础信息表单示例/,
    });
    expect(screenshot).toHaveAttribute(
      "src",
      "/assets/aliyun-icp-guide/03-enterprise-sponsor.webp",
    );
    expect(screenshot).toHaveAttribute("loading", "lazy");
    expect(screenshot.closest("figure")).toHaveStyle({
      "--guide-image-width": "1269px",
    });

    const openButton = screen.getByRole("button", {
      name: /放大查看：阿里云企业备案主办者基础信息表单示例/,
    });
    fireEvent.click(openButton);
    expect(
      screen.getByRole("dialog", {
        name: /截图大图：阿里云企业备案主办者基础信息表单示例/,
      }),
    ).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "关闭截图大图" }));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("keeps the next stage locked while a domain ticket is pending", () => {
    render(
      <AiWebsiteManagementWorkspace
        planCode="advanced"
        quota={websiteQuota()}
        websiteWorkflow={{
          domainStatus: "pending",
          icpStatus: "locked",
          canSubmitIcp: false,
          canSubmitContent: false,
        }}
        tickets={[
          {
            id: "domain-pending",
            type: "website_operation",
            category: "domain_application",
            topic: "申请企业域名",
            status: "in_progress",
            publicStatus: "pending",
            revision: 1,
            submittedAt: "2026-07-27",
          },
        ]}
        onSubmit={vi.fn()}
      />,
    );

    expect(
      screen.getByText(
        "域名已提交，AI 运维工单正在处理。备案服务码会在工单完成后返回，请勿重复提交。",
      ),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "提交工单" }),
    ).not.toBeInTheDocument();
    expect(screen.getByText("申请企业域名")).toBeInTheDocument();
    expect(screen.getAllByText("处理中").length).toBeGreaterThan(0);
  });

  it("opens a nonterminal website ticket when the customer must supplement it", () => {
    const onOpenTicket = vi.fn();
    render(
      <AiWebsiteManagementWorkspace
        planCode="advanced"
        quota={websiteQuota()}
        websiteWorkflow={{
          domainStatus: "pending",
          icpStatus: "locked",
          canSubmitIcp: false,
          canSubmitContent: false,
        }}
        tickets={[
          {
            id: "domain-needs-information",
            type: "website_operation",
            category: "domain_application",
            topic: "example.cn",
            status: "needs_information",
            publicStatus: "pending",
            publicStage: "action_required",
            publicStageLabel: "待您补充",
            publicSummary: "请确认域名实名认证状态。",
            revision: 2,
          },
        ]}
        onSubmit={vi.fn()}
        onOpenTicket={onOpenTicket}
      />,
    );

    fireEvent.click(
      screen.getByRole("button", {
        name: /example\.cn.*待您补充/,
      }),
    );
    expect(onOpenTicket).toHaveBeenCalledWith("domain-needs-information");
  });

  it("submits the purchased domain as an AI operations work order", async () => {
    const onSubmit = vi.fn().mockResolvedValue(undefined);
    render(
      <AiWebsiteManagementWorkspace
        planCode="advanced"
        quota={websiteQuota()}
        websiteWorkflow={{
          domainStatus: "not_started",
          icpStatus: "locked",
          canSubmitDomain: true,
          canSubmitIcp: false,
          canSubmitContent: false,
        }}
        onSubmit={onSubmit}
      />,
    );

    fireEvent.click(
      screen.getByRole("button", {
        name: /回到 FrontMind 提交已购买域名，等待备案服务码/,
      }),
    );
    fireEvent.change(screen.getByLabelText("已购买域名"), {
      target: { value: "example.cn" },
    });
    fireEvent.click(
      screen.getByRole("button", {
        name: "提交域名，创建 AI 运维工单",
      }),
    );

    await waitFor(() =>
      expect(onSubmit).toHaveBeenCalledWith({
        category: "domain_application",
        topic: "example.cn",
        description: "备案场景：国内版 · 企业首次备案。",
        targetPage: "",
        materialUrls: [],
        attachmentFiles: [],
      }),
    );
    expect(
      screen.getByText(
        "域名已提交，AI 运维工单已创建。请等待工单返回备案服务码。",
      ),
    ).toBeInTheDocument();
  });

  it("shows only the two domestic tutorials for domestic accounts", () => {
    render(
      <AiWebsiteManagementWorkspace
        planCode="advanced"
        quota={websiteQuota()}
        websiteWorkflow={{
          domainStatus: "not_started",
          icpStatus: "locked",
          canSubmitDomain: true,
          canSubmitIcp: false,
          canSubmitContent: false,
        }}
        onSubmit={vi.fn()}
      />,
    );

    const firstTab = screen.getByRole("tab", {
      name: "国内版 · 企业首次备案",
    });
    const existingTab = screen.getByRole("tab", {
      name: "国内版 · 已有 ICP 备案",
    });
    expect(firstTab).toHaveAttribute("aria-selected", "true");
    expect(
      screen.queryByRole("tab", {
        name: "海外版 · 香港/海外节点",
      }),
    ).not.toBeInTheDocument();

    fireEvent.keyDown(firstTab, { key: "ArrowRight" });
    expect(existingTab).toHaveAttribute("aria-selected", "true");
    expect(
      screen.getByText("企业已有 ICP 备案：在现有主体下新增网站"),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", {
        name: /确认企业主体已有备案，本次域名尚未备案/,
      }),
    ).toHaveAttribute("aria-expanded", "true");
    expect(
      screen.getByRole("img", {
        name: /阿里云官方 ICP 备案完整流程图/,
      }),
    ).toHaveAttribute(
      "src",
      "/assets/aliyun-icp-guide/12-icp-filing-process.webp",
    );

    fireEvent.click(
      screen.getByRole("button", {
        name: /从现有备案主体下发起“新增互联网信息服务”/,
      }),
    );
    expect(
      screen.getByRole("img", {
        name: /订单类型显示有主体新增互联网信息服务/,
      }),
    ).toHaveAttribute(
      "src",
      "/assets/aliyun-icp-guide/13-existing-sponsor-prefilled.webp",
    );

    fireEvent.click(
      screen.getByRole("button", {
        name: /重新填写资料并完成人脸核验/,
      }),
    );
    expect(
      screen.getByRole("img", {
        name: /阿里云移动端已有备案主体信息页面/,
      }),
    ).toHaveAttribute(
      "src",
      "/assets/aliyun-icp-guide/14-existing-sponsor-mobile.webp",
    );
  });

  it("defaults overseas accounts to the overseas tutorial and submits that scene", async () => {
    const onSubmit = vi.fn().mockResolvedValue(undefined);
    render(
      <AiWebsiteManagementWorkspace
        planCode="advanced"
        marketEdition="overseas"
        quota={websiteQuota()}
        websiteWorkflow={{
          domainStatus: "not_started",
          icpStatus: "locked",
          canSubmitDomain: true,
          canSubmitIcp: false,
          canSubmitContent: false,
        }}
        onSubmit={onSubmit}
      />,
    );

    expect(
      screen.getByRole("tab", {
        name: "海外版 · 香港/海外节点",
      }),
    ).toHaveAttribute("aria-selected", "true");
    expect(
      screen.queryByRole("tab", {
        name: "国内版 · 企业首次备案",
      }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("tab", {
        name: "国内版 · 已有 ICP 备案",
      }),
    ).not.toBeInTheDocument();
    fireEvent.click(
      screen.getByRole("button", {
        name: /回到 FrontMind 按海外版提交域名/,
      }),
    );
    expect(
      screen.getByText("海外版域名购买完成后，在这里提交"),
    ).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText("已购买域名"), {
      target: { value: "example.com" },
    });
    fireEvent.click(
      screen.getByRole("button", {
        name: "提交域名，创建 AI 运维工单",
      }),
    );

    await waitFor(() =>
      expect(onSubmit).toHaveBeenCalledWith({
        category: "domain_application",
        topic: "example.com",
        description:
          "部署场景：海外版 · 中国香港或海外节点；无需工信部 ICP 备案。",
        targetPage: "",
        materialUrls: [],
        attachmentFiles: [],
      }),
    );
    expect(
      screen.getByText(
        "海外版域名已提交，AI 运维工单已创建。无需办理 ICP 备案。",
      ),
    ).toBeInTheDocument();
  });

  it("submits only the completed domain and ICP subject number", async () => {
    const onSubmit = vi.fn().mockResolvedValue(undefined);
    render(
      <AiWebsiteManagementWorkspace
        planCode="advanced"
        quota={websiteQuota()}
        websiteWorkflow={{
          domainStatus: "completed",
          icpStatus: "not_started",
          canSubmitIcp: true,
          canSubmitContent: false,
        }}
        onSubmit={onSubmit}
      />,
    );

    fireEvent.click(
      screen.getByRole("tab", { name: "国内版 · 已有 ICP 备案" }),
    );
    const lastTutorialStage = screen.getByRole("button", {
      name: /完成审核并回填备案结果/,
    });
    const filingTicket = screen.getByText("提交备案信息工单");
    const securityNotice = screen.getByText(/不会索要阿里云密码/);
    expect(
      lastTutorialStage.compareDocumentPosition(filingTicket) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(
      filingTicket.compareDocumentPosition(securityNotice) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();

    fireEvent.change(screen.getByLabelText("已备案域名"), {
      target: { value: "example.cn" },
    });
    fireEvent.click(screen.getByRole("button", { name: "提交备案结果" }));
    expect(
      screen.getByText("请填写阿里云备案通过后获得的 ICP 主体备案号。"),
    ).toBeInTheDocument();
    expect(onSubmit).not.toHaveBeenCalled();

    fireEvent.change(screen.getByLabelText("ICP 主体备案号"), {
      target: { value: "粤ICP备12345678号" },
    });
    fireEvent.click(screen.getByRole("button", { name: "提交备案结果" }));
    await waitFor(() =>
      expect(onSubmit).toHaveBeenCalledWith({
        category: "icp_filing",
        topic: "example.cn",
        description: "",
        targetPage: "",
        materialUrls: [],
        attachmentFiles: [],
        icpDeclarations: {
          icpNumber: "粤ICP备12345678号",
        },
      }),
    );
  });

  it("offers exactly five content categories after ICP is complete", () => {
    render(
      <AiWebsiteManagementWorkspace
        planCode="luxury"
        quota={websiteQuota()}
        websiteWorkflow={{
          domainStatus: "completed",
          icpStatus: "completed",
          canSubmitIcp: false,
          canSubmitContent: true,
        }}
        contentCatalog={websiteContentCatalog}
        onSubmit={vi.fn()}
      />,
    );

    const select = screen.getByLabelText("需求类型");
    expect(select).toContainHTML("企业资料与品牌事实");
    for (const label of [
      "企业资料与品牌事实",
      "产品案例与文档",
      "行业新闻与观察",
      "企业新闻与动态",
      "FAQ 与问答页面",
    ]) {
      expect(screen.getByRole("option", { name: label })).toBeInTheDocument();
    }
    expect(screen.getAllByRole("option")).toHaveLength(6);
    expect(
      screen.queryByRole("option", { name: "官网技术诊断" }),
    ).not.toBeInTheDocument();
    expect(screen.queryByLabelText("目标页面（选填）")).not.toBeInTheDocument();
  });

  it("requires the customer to select or reject one batch of exactly three style samples", async () => {
    const onSelectStyle = vi.fn().mockResolvedValue(undefined);
    const onRequestStyleRevision = vi.fn().mockResolvedValue(undefined);
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(true);
    render(
      <AiWebsiteManagementWorkspace
        planCode="advanced"
        quota={websiteQuota()}
        websiteWorkflow={{
          domainStatus: "completed",
          icpStatus: "completed",
          canSubmitIcp: false,
          canSubmitContent: false,
          styleState: "awaiting_selection",
          styleRevision: 4,
          styleConfirmed: false,
          canSelectStyle: true,
          canRequestStyleRevision: true,
          styleBatch: {
            id: "11111111-1111-4111-8111-111111111111",
            ordinal: 1,
            engineerNote: "分别覆盖克制、自然、专业三种方向。",
            samples: [1, 2, 3].map((number) => ({
              id: `sample-${number}`,
              label: `风格 ${number}`,
              filename: `style-${number}.webp`,
              imageUrl: `/style-${number}.webp`,
            })),
          },
        }}
        onSubmit={vi.fn()}
        onSelectStyle={onSelectStyle}
        onRequestStyleRevision={onRequestStyleRevision}
      />,
    );

    expect(screen.getAllByRole("img")).toHaveLength(3);
    expect(screen.queryByLabelText("需求类型")).not.toBeInTheDocument();
    fireEvent.click(screen.getAllByRole("button", { name: "选择此风格" })[1]!);
    await waitFor(() =>
      expect(onSelectStyle).toHaveBeenCalledWith({
        sampleId: "sample-2",
        expectedRevision: 4,
      }),
    );

    fireEvent.change(
      screen.getByLabelText("三张都不合适？请说明需要调整的方向"),
      { target: { value: "减少科技蓝，增加真实业务场景。" } },
    );
    fireEvent.click(screen.getByRole("button", { name: "退回工程师重做" }));
    await waitFor(() =>
      expect(onRequestStyleRevision).toHaveBeenCalledWith({
        reason: "减少科技蓝，增加真实业务场景。",
        expectedRevision: 4,
      }),
    );
    confirm.mockRestore();
  });

  it("submits content references and attachments without target-page fields", async () => {
    const onSubmit = vi.fn().mockResolvedValue(undefined);
    const sourceFile = new File(["brief"], "brief.pdf", {
      type: "application/pdf",
    });
    render(
      <AiWebsiteManagementWorkspace
        planCode="advanced"
        quota={websiteQuota()}
        websiteWorkflow={{
          domainStatus: "completed",
          icpStatus: "completed",
          canSubmitContent: true,
        }}
        contentCatalog={websiteContentCatalog}
        onSubmit={onSubmit}
      />,
    );

    fireEvent.change(screen.getByLabelText("需求类型"), {
      target: { value: "company_news" },
    });
    fireEvent.change(screen.getByLabelText("话题"), {
      target: { value: "发布企业合作动态" },
    });
    fireEvent.change(screen.getByLabelText("参考资料（选填）"), {
      target: { value: "https://example.com/source" },
    });
    fireEvent.change(screen.getByLabelText("上传官网工单附件"), {
      target: { files: [sourceFile] },
    });
    fireEvent.click(screen.getByRole("button", { name: "提交工单" }));

    await waitFor(() =>
      expect(onSubmit).toHaveBeenCalledWith({
        category: "company_news",
        topic: "发布企业合作动态",
        description: "",
        targetPage: "",
        materialUrls: ["https://example.com/source"],
        attachmentFiles: [sourceFile],
      }),
    );
  });

  it("unifies pending and completed records and reveals only public summaries", () => {
    render(
      <AiWebsiteManagementWorkspace
        planCode="advanced"
        quota={websiteQuota()}
        websiteWorkflow={{
          domainStatus: "completed",
          icpStatus: "completed",
          canSubmitContent: true,
        }}
        tickets={[
          {
            id: "pending",
            type: "website_operation",
            category: "company_facts",
            topic: "更新企业资料",
            status: "needs_information",
            publicStatus: "pending",
            revision: 1,
            submittedAt: "2026-07-26",
            latestPublicMessage: "这段过程回复不能在列表显示。",
          },
          {
            id: "completed",
            type: "website_operation",
            category: "company_news",
            topic: "发布企业动态",
            status: "completed",
            publicStatus: "completed",
            publicSummary: "已完成企业动态内容更新。",
            revision: 2,
            submittedAt: "2026-07-25",
            resolvedAt: "2026-07-27",
            attachmentCount: 2,
            deliveryLinks: [
              {
                label: "查看发布页面",
                url: "https://example.com/news",
              },
            ],
          },
        ]}
        onSubmit={vi.fn()}
      />,
    );

    expect(screen.getByText("更新企业资料")).toBeInTheDocument();
    expect(screen.getByText("发布企业动态")).toBeInTheDocument();
    expect(
      screen.queryByText("这段过程回复不能在列表显示。"),
    ).not.toBeInTheDocument();
    expect(screen.queryByText("查看发布页面")).not.toBeInTheDocument();
    expect(screen.queryByText(/2026/)).not.toBeInTheDocument();
    expect(screen.queryByText(/交付文件/)).not.toBeInTheDocument();

    fireEvent.click(screen.getByText("发布企业动态"));
    expect(screen.getByText("处理结果")).toBeInTheDocument();
    expect(screen.getByText("已完成企业动态内容更新。")).toBeInTheDocument();
  });

  it("does not invent a preview domain or technical check result", () => {
    render(
      <AiWebsiteManagementWorkspace
        planCode="advanced"
        quota={websiteQuota()}
        websiteWorkflow={{
          domainStatus: "not_started",
          icpStatus: "locked",
        }}
        onSubmit={vi.fn()}
      />,
    );

    expect(
      screen.queryByText("customer.example.invalid"),
    ).not.toBeInTheDocument();
    expect(screen.queryByText("已通过")).not.toBeInTheDocument();
    expect(screen.queryByText("核验依据")).not.toBeInTheDocument();
  });

  it("loads the next page of unified history on demand", () => {
    const onLoadMore = vi.fn();
    render(
      <AiWebsiteManagementWorkspace
        planCode="advanced"
        quota={websiteQuota()}
        websiteWorkflow={{ domainStatus: "not_started", icpStatus: "locked" }}
        tickets={[]}
        hasMore
        onLoadMore={onLoadMore}
        onSubmit={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "加载更多" }));
    expect(onLoadMore).toHaveBeenCalledTimes(1);
  });
});
