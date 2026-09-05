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
  it("opens the new SiteOps build flow before domain or ICP while legacy gates stay isolated", () => {
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
        siteOpsMode
        siteOpsPanel={<div>对话式建站面板已连接</div>}
      />,
    );

    expect(screen.getByText("对话式建站面板已连接")).toBeInTheDocument();
    expect(
      screen.getByRole("heading", { name: "AI友好官网管理" }),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/完成官网制作、预览、域名配置与发布/),
    ).toBeInTheDocument();
    expect(screen.queryByText("阿里云企业域名注册图文教程")).toBeNull();
    expect(screen.queryByText("官网开通进度")).toBeNull();
  });

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
    expect(screen.queryByRole("button", { name: "提交需求" })).toBeNull();
  });

  it("keeps the engineer preview aligned with the overseas two-stage flow", () => {
    render(
      <AiWebsiteManagementWorkspace
        planCode="advanced"
        marketEdition="overseas"
        quota={websiteQuota()}
        websiteWorkflow={{
          domainStatus: "completed",
          icpStatus: "not_required",
          styleState: "waiting_samples",
          websiteBuildStatus: "locked",
          canSubmitContent: false,
        }}
        contentCatalog={websiteContentCatalog}
        readOnlyPreview
      />,
    );

    expect(screen.getByText("企业域名注册与确认")).toBeInTheDocument();
    expect(
      screen.getByText("AI专用官网构建与内容运营").closest("li"),
    ).toHaveTextContent("待风格确认");
    expect(screen.queryByText(/ICP 备案 ·/)).not.toBeInTheDocument();
    expect(screen.getByText(/域名教程、客户提交表单/)).toBeInTheDocument();
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
      screen.getByText("AI专用官网构建与内容运营").closest("li"),
    ).toHaveTextContent("已开放");
    expect(
      screen.queryByText("购买域名并提交 AI 运维需求"),
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
      screen.getByText("AI专用官网构建与内容运营").closest("li"),
    ).toHaveTextContent("待域名与备案确认");
    expect(screen.getByText("域名购买完成后，在这里提交")).toBeInTheDocument();
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
    const filingStage = screen.getByRole("button", {
      name: /完成审核、短信核验并取得 ICP 主体备案号/,
    });
    expect(stageOne).toHaveAttribute("aria-expanded", "false");
    expect(stageTwo).toHaveAttribute("aria-expanded", "false");
    expect(stageThree).toHaveAttribute("aria-expanded", "true");
    expect(stageFour).toHaveAttribute("aria-expanded", "false");
    expect(filingStage).toHaveAttribute("aria-expanded", "true");
    expect(
      screen
        .getAllByRole("button")
        .filter((button) => button.id.includes("-stage-"))
        .filter((button) => button.getAttribute("aria-expanded") === "true"),
    ).toEqual([stageThree, filingStage]);
    expect(screen.getByText("备案信息回填处")).toBeInTheDocument();
    expect(
      screen.getByText("等待 AI 运维工程师在域名需求内提供备案服务码。"),
    ).toBeInTheDocument();
    const serviceCodeReceipt = screen
      .getByText("备案服务码接收处")
      .closest("section");
    expect(serviceCodeReceipt).toHaveTextContent(
      "等待 AI 运维工程师在域名需求内提供备案服务码。",
    );
    expect(serviceCodeReceipt).not.toHaveTextContent(/未提交|处理中|异常缺失/);
    expect(
      screen.getByText(/回填项已开放；域名需求完成后/),
    ).toBeInTheDocument();

    const purchasedDomain = screen.getByLabelText("已购买域名");
    const filedDomain = screen.getByLabelText("已备案域名");
    const icpNumber = screen.getByLabelText("ICP 主体备案号");
    expect(stageThree.closest("li")).toContainElement(purchasedDomain);
    expect(filingStage.closest("li")).toContainElement(filedDomain);
    expect(filingStage.closest("li")).toContainElement(icpNumber);
    expect(purchasedDomain.closest("form")).not.toBeNull();
    expect(filedDomain.closest("form")).not.toBeNull();
    expect(purchasedDomain.closest("form")).not.toBe(
      filedDomain.closest("form"),
    );
    expect(document.querySelector("form form")).toBeNull();
    expect(screen.getByRole("button", { name: "提交备案结果" })).toBeDisabled();

    fireEvent.click(
      screen.getByRole("button", {
        name: "不确定场景，联系服务专员",
      }),
    );
    expect(onContactAdvisor).toHaveBeenCalledTimes(1);

    fireEvent.click(stageTwo);
    fireEvent.click(stageFour);
    expect(
      screen.getByRole("link", { name: /去阿里云查询并注册域名/ }),
    ).toHaveAttribute("href", "https://wanwang.aliyun.com/");
    expect(
      screen.getByRole("link", { name: /去阿里云查询并注册域名/ }),
    ).not.toHaveAttribute("target");
    expect(
      screen.getByRole("link", { name: /去阿里云开始 ICP 备案/ }),
    ).toHaveAttribute("href", "https://beian.aliyun.com/");
    const smsVerificationLink = screen.getByRole("link", {
      name: /查看工信部短信核验说明/,
    });
    const filingProgressLink = screen.getByRole("link", {
      name: /查看备案进度与结果/,
    });
    for (const link of [smsVerificationLink, filingProgressLink]) {
      expect(link).toHaveAttribute("target", "_blank");
      expect(link).toHaveAttribute("rel", "noopener noreferrer");
    }
    expect(screen.getByText("域名购买完成后，在这里提交")).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "提交需求" }),
    ).not.toBeInTheDocument();
    expect(
      screen.getByRole("button", {
        name: "提交域名，创建 AI 运维需求",
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
    fireEvent.click(stageOne);

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

  it("keeps the guide and filing fields visible while a domain ticket is pending", () => {
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
        "备案服务码会在域名需求完成后显示在下方接收处，请勿重复提交。",
      ),
    ).toBeInTheDocument();
    const serviceCodeReceipt = screen
      .getByText("备案服务码接收处")
      .closest("section");
    expect(serviceCodeReceipt).toHaveTextContent(
      "等待 AI 运维工程师在域名需求内提供备案服务码。",
    );
    expect(
      screen.getByText("等待 AI 运维工程师在域名需求内提供备案服务码。"),
    ).toBeInTheDocument();
    expect(screen.getByLabelText("已备案域名")).toBeInTheDocument();
    expect(screen.getByLabelText("ICP 主体备案号")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "提交备案结果" })).toBeDisabled();
    expect(
      screen.queryByRole("button", { name: "提交需求" }),
    ).not.toBeInTheDocument();
    fireEvent.click(screen.getAllByRole("button", { name: "需求记录" })[0]!);
    expect(
      screen.getByRole("dialog", { name: "官网需求记录" }),
    ).toBeInTheDocument();
    expect(screen.getByText("申请企业域名")).toBeInTheDocument();
    expect(screen.getByText("域名确认中")).toBeInTheDocument();
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
            publicSummary: "请确认域名实名认证状态。",
            revision: 2,
          },
        ]}
        onSubmit={vi.fn()}
        onOpenTicket={onOpenTicket}
      />,
    );

    fireEvent.click(screen.getAllByRole("button", { name: "需求记录" })[0]!);
    fireEvent.click(screen.getByText("example.cn").closest("button")!);
    expect(onOpenTicket).toHaveBeenCalledWith("domain-needs-information");
  });

  it("shows the service code from the current delivered domain ticket", async () => {
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
        tickets={[
          {
            id: "domain-completed",
            type: "website_operation",
            category: "domain_application",
            topic: "example.cn",
            status: "completed",
            publicStatus: "completed",
            publicSummary: "备案服务码：ABC-123",
            revision: 2,
          },
        ]}
        onSubmit={vi.fn()}
      />,
    );

    expect(screen.getByText("备案服务码接收处")).toBeInTheDocument();
    expect(
      screen.getByText("ABC-123", { selector: "code" }),
    ).toBeInTheDocument();
    expect(
      screen.queryByText("等待 AI 运维工程师在域名需求内提供备案服务码。"),
    ).toBeNull();
    await waitFor(() =>
      expect(screen.getByLabelText("已备案域名")).toHaveValue("example.cn"),
    );
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

    fireEvent.change(screen.getByLabelText("已购买域名"), {
      target: { value: "example.cn" },
    });
    fireEvent.click(
      screen.getByRole("button", {
        name: "提交域名，创建 AI 运维需求",
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
        "域名已提交，AI 运维需求已创建。请等待需求返回备案服务码。",
      ),
    ).toBeInTheDocument();
    const submitButton = screen.getByRole("button", {
      name: "提交域名，创建 AI 运维需求",
    });
    expect(submitButton).toBeDisabled();
    fireEvent.click(submitButton);
    expect(onSubmit).toHaveBeenCalledTimes(1);
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
        name: /回到 FrontMind 提交本次域名，等待 AI 运维返回服务码/,
      }),
    ).toHaveAttribute("aria-expanded", "true");
    expect(
      screen.getByRole("button", {
        name: /完成审核并回填备案结果/,
      }),
    ).toHaveAttribute("aria-expanded", "true");
    const existingFilingProgressLink = screen.getByRole("link", {
      name: /查看备案进度与结果/,
    });
    expect(existingFilingProgressLink).toHaveAttribute("target", "_blank");
    expect(existingFilingProgressLink).toHaveAttribute(
      "rel",
      "noopener noreferrer",
    );
    fireEvent.click(
      screen.getByRole("button", {
        name: /确认企业主体已有备案，本次域名尚未备案/,
      }),
    );
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
    expect(
      screen.getByText("海外版域名购买完成后，在这里提交"),
    ).toBeInTheDocument();
    expect(screen.getByText("企业域名注册与确认")).toBeInTheDocument();
    expect(
      screen.queryByText("阿里云域名注册与 ICP 备案"),
    ).not.toBeInTheDocument();
    expect(
      screen.getByText("AI专用官网构建与内容运营").closest("li"),
    ).toHaveTextContent("待域名确认");

    fireEvent.change(screen.getByLabelText("已购买域名"), {
      target: { value: "example.com" },
    });
    fireEvent.click(
      screen.getByRole("button", {
        name: "提交域名，创建 AI 运维需求",
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
        "海外版域名已提交，AI 运维需求已创建。无需办理 ICP 备案。",
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
    const filingTicket = screen.getByText("备案信息回填处");
    expect(lastTutorialStage).toHaveAttribute("aria-expanded", "true");
    expect(lastTutorialStage.closest("li")).toContainElement(filingTicket);
    const securityNotice = screen.getByText(/不会索要阿里云密码/);
    expect(
      lastTutorialStage.compareDocumentPosition(filingTicket) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(
      filingTicket.compareDocumentPosition(securityNotice) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    fireEvent.click(lastTutorialStage);
    expect(screen.queryByText("备案信息回填处")).not.toBeInTheDocument();
    fireEvent.click(
      screen.getByRole("button", { name: "我已取得备案号，去填写结果" }),
    );
    expect(screen.getByText("备案信息回填处")).toBeInTheDocument();

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

  it("never exposes the domestic filing form to an overseas account", () => {
    render(
      <AiWebsiteManagementWorkspace
        planCode="advanced"
        marketEdition="overseas"
        quota={websiteQuota()}
        websiteWorkflow={{
          domainStatus: "completed",
          icpStatus: "not_started",
          canSubmitIcp: true,
          canSubmitContent: false,
        }}
        onSubmit={vi.fn()}
      />,
    );

    expect(screen.queryByLabelText("已备案域名")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("ICP 主体备案号")).not.toBeInTheDocument();
    expect(screen.queryByText("备案服务码接收处")).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "提交备案结果" }),
    ).not.toBeInTheDocument();
  });

  it("opens the overseas build stage after domain confirmation while waiting for style approval", () => {
    render(
      <AiWebsiteManagementWorkspace
        planCode="advanced"
        marketEdition="overseas"
        quota={websiteQuota()}
        websiteWorkflow={{
          domainCompleted: true,
          icpCompleted: true,
          canSubmitDomain: false,
          canSubmitIcp: false,
          canSubmitContent: false,
          styleState: "waiting_samples",
          styleConfirmed: false,
        }}
        onSubmit={vi.fn()}
      />,
    );

    const prerequisiteStep = screen
      .getByText("企业域名注册与确认")
      .closest("li");
    const contentStep = screen
      .getByText("AI专用官网构建与内容运营")
      .closest("li");
    expect(prerequisiteStep).toHaveTextContent("域名已确认");
    expect(contentStep).toHaveAttribute("data-state", "pending");
    expect(contentStep).toHaveTextContent("待风格确认");
    expect(
      screen.getByRole("heading", { name: "选择 AI 专用官网图片风格" }),
    ).toBeInTheDocument();
    expect(screen.queryByLabelText("ICP 主体备案号")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("需求类型")).not.toBeInTheDocument();
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
    expect(
      screen.getByText("AI专用官网构建与内容运营").closest("li"),
    ).toHaveTextContent("已开放");
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

  it("keeps content submission locked while the confirmed website is being built", () => {
    render(
      <AiWebsiteManagementWorkspace
        planCode="advanced"
        quota={websiteQuota()}
        websiteWorkflow={{
          domainCompleted: true,
          icpCompleted: true,
          styleState: "confirmed",
          styleConfirmed: true,
          websiteBuildStatus: "pending",
          canSubmitContent: false,
          contentLockReason:
            "官网风格已确认，正在等待 AI 运维工程师或系统管理员完成官网构建并登记公开链接。",
        }}
        contentCatalog={websiteContentCatalog}
        onSubmit={vi.fn()}
      />,
    );

    expect(
      screen.getByText("AI专用官网构建与内容运营").closest("li"),
    ).toHaveTextContent("官网构建中");
    expect(
      screen.getByText(
        "官网风格已确认，正在等待 AI 运维工程师或系统管理员完成官网构建并登记公开链接。",
      ),
    ).toBeInTheDocument();
    expect(screen.queryByLabelText("需求类型")).not.toBeInTheDocument();
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
    fireEvent.change(screen.getByLabelText("上传官网需求附件"), {
      target: { files: [sourceFile] },
    });
    fireEvent.click(screen.getByRole("button", { name: "提交需求" }));

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
          {
            id: "question-catalog",
            type: "website_operation",
            category: "question_catalog",
            topic: "配置品牌词库与问题目录",
            status: "submitted",
            publicStatus: "pending",
          },
          {
            id: "initial-monitoring",
            type: "website_operation",
            category: "initial_monitoring",
            topic: "执行首次问题监控",
            status: "submitted",
            publicStatus: "pending",
          },
          {
            id: "website-style",
            type: "website_operation",
            category: "website_style_samples",
            categoryLabel: "website_style_samples",
            topic: "确认官网图片风格",
            status: "completed",
            publicStatus: "completed",
          },
          {
            id: "website-build",
            type: "website_operation",
            category: "website_build",
            categoryLabel: "website_build",
            topic: "website_build",
            status: "completed",
            publicStatus: "completed",
          },
          {
            id: "site-check",
            type: "website_operation",
            category: "site_check",
            categoryLabel: "site_check",
            topic: "检查已发布官网页面",
            status: "completed",
            publicStatus: "completed",
          },
        ]}
        onSubmit={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "需求记录" }));
    expect(
      screen.getByRole("dialog", { name: "官网需求记录" }),
    ).toBeInTheDocument();
    expect(screen.getByText("更新企业资料")).toBeInTheDocument();
    expect(screen.getByText("发布企业动态")).toBeInTheDocument();
    expect(
      screen.queryByText("配置品牌词库与问题目录"),
    ).not.toBeInTheDocument();
    expect(screen.queryByText("执行首次问题监控")).not.toBeInTheDocument();
    expect(screen.getByText("确认官网图片风格")).toBeInTheDocument();
    expect(screen.getByText("检查已发布官网页面")).toBeInTheDocument();
    expect(screen.getByText("官网图片风格")).toBeInTheDocument();
    expect(screen.getByText("AI 专用官网构建")).toBeInTheDocument();
    expect(screen.getByText("站点检查")).toBeInTheDocument();
    expect(screen.getByText("企业资料与品牌事实")).toBeInTheDocument();
    expect(screen.getByText("企业新闻与动态")).toBeInTheDocument();
    expect(
      screen.queryByText(/website_style_samples|website_build|site_check/),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByText("这段过程回复不能在列表显示。"),
    ).not.toBeInTheDocument();
    expect(screen.queryByText("查看发布页面")).not.toBeInTheDocument();
    expect(screen.queryByText(/2026/)).not.toBeInTheDocument();
    expect(screen.queryByText(/交付文件/)).not.toBeInTheDocument();

    expect(screen.getByText(/已完成企业动态内容更新。/)).toBeInTheDocument();
  });

  it("opens a focused demand history from the current website step", async () => {
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
        tickets={[
          {
            id: "facts",
            type: "website_operation",
            category: "company_facts",
            topic: "企业事实历史",
            publicStatus: "pending",
          },
          {
            id: "news",
            type: "website_operation",
            category: "company_news",
            topic: "企业新闻历史",
            publicStatus: "completed",
          },
        ]}
        onSubmit={vi.fn()}
      />,
    );

    fireEvent.change(screen.getByLabelText("需求类型"), {
      target: { value: "company_news" },
    });
    fireEvent.click(screen.getByRole("button", { name: "需求记录" }));

    await waitFor(() =>
      expect(
        screen.getByRole("dialog", { name: "官网需求记录" }),
      ).toBeInTheDocument(),
    );
    expect(screen.getByText("企业新闻历史")).toBeInTheDocument();
    expect(screen.getByText("企业事实历史")).toBeInTheDocument();
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

    fireEvent.click(screen.getAllByRole("button", { name: "需求记录" })[0]!);
    fireEvent.click(screen.getByRole("button", { name: "加载更多" }));
    expect(onLoadMore).toHaveBeenCalledTimes(1);
  });
});
