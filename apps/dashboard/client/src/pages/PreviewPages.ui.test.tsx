import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

vi.mock("@/components/PortalShell", () => ({
  default: ({
    children,
    toolbar,
    accountLabel,
    title,
    mode = "standard",
  }: {
    children: React.ReactNode;
    toolbar?: React.ReactNode;
    accountLabel?: string;
    title?: string;
    mode?: "standard" | "fullscreen";
  }) => (
    <div data-testid="portal-shell" data-mode={mode}>
      {accountLabel && <span>{accountLabel}</span>}
      {title && <h1>{title}</h1>}
      {toolbar}
      {children}
    </div>
  ),
  PortalCard: ({
    children,
    className,
  }: {
    children: React.ReactNode;
    className?: string;
  }) => <section className={className}>{children}</section>,
}));

vi.mock("@/components/AdminDeliveryTicketWorkspace", () => ({
  default: ({
    enterpriseName,
    canAdjustQuota,
    canExecuteDelivery,
  }: {
    enterpriseName?: string;
    canAdjustQuota?: boolean;
    canExecuteDelivery?: boolean;
  }) => (
    <section
      data-testid="admin-delivery-ticket-workspace"
      data-can-adjust-quota={String(Boolean(canAdjustQuota))}
      data-can-execute-delivery={String(Boolean(canExecuteDelivery))}
    >
      <h2>{enterpriseName}需求记录</h2>
    </section>
  ),
}));

vi.mock("@/components/CustomerDashboardMirror", () => ({
  default: ({
    layout,
    initialSection,
    heading,
    editActions,
  }: {
    layout?: string;
    initialSection?: string;
    heading?: string;
    editActions?: React.ReactNode;
  }) => (
    <section
      data-testid="customer-dashboard-mirror"
      data-layout={layout}
      data-initial-section={initialSection}
    >
      <h2>{heading}</h2>
      {editActions}
    </section>
  ),
}));

import {
  PreviewAdminAccounts,
  PreviewAdminDeliveryRoles,
  PreviewAdminDispatch,
  PreviewCreateAccountDialog,
  PreviewDeliveryControl,
  PreviewAdminUsers,
} from "./PreviewPages";

describe("role-scoped administrator previews", () => {
  it("shows only assigned project teams to a delivery administrator", () => {
    render(<PreviewAdminDeliveryRoles previewAccessLevel="delivery_admin" />);

    expect(screen.getByText("交付管理员验收账号")).toBeInTheDocument();
    expect(screen.getByText("验收企业")).toBeInTheDocument();
    expect(screen.getByText("验收企业 B")).toBeInTheDocument();
    expect(screen.queryByText("验收企业 C")).not.toBeInTheDocument();
  });

  it("uses only the two public management statuses in the ticket preview", () => {
    render(<PreviewAdminDispatch previewAccessLevel="delivery_admin" />);

    expect(screen.getAllByText("待处理").length).toBeGreaterThan(0);
    expect(screen.getAllByText("已完成").length).toBeGreaterThan(0);
    expect(screen.queryByText("处理中")).not.toBeInTheDocument();
    expect(screen.queryByText("待领取")).not.toBeInTheDocument();
    expect(screen.queryByText("等客户补充")).not.toBeInTheDocument();
  });

  it("keeps delivery administrator account management role-scoped", () => {
    render(<PreviewAdminAccounts previewAccessLevel="delivery_admin" />);

    expect(screen.getByText("交付管理员验收账号")).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "创建客户账号" }),
    ).toBeInTheDocument();
    expect(screen.queryByText("系统管理员")).not.toBeInTheDocument();
  });
});

describe("preview account creation form", () => {
  it("requires an initial password, plan and market edition for a customer account", () => {
    render(
      <PreviewCreateAccountDialog
        open
        onOpenChange={vi.fn()}
        onCreated={vi.fn()}
      />,
    );

    expect(screen.getByText("客户套餐")).toBeInTheDocument();
    expect(screen.getByRole("option", { name: "普通版" })).toBeInTheDocument();
    expect(screen.getByRole("option", { name: "进阶版" })).toBeInTheDocument();
    expect(screen.getByRole("option", { name: "豪华版" })).toBeInTheDocument();
    expect(screen.getByRole("option", { name: "国内版" })).toBeInTheDocument();
    expect(screen.getByRole("option", { name: "海外版" })).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "创建客户并开通套餐" }),
    ).toBeDisabled();

    fireEvent.change(screen.getByPlaceholderText("企业或管理员名称"), {
      target: { value: "新客户" },
    });
    fireEvent.change(screen.getByPlaceholderText("用于登录"), {
      target: { value: "new_customer" },
    });
    fireEvent.change(screen.getByLabelText("客户套餐"), {
      target: { value: "advanced" },
    });
    fireEvent.change(screen.getByLabelText("客户版本"), {
      target: { value: "overseas" },
    });
    fireEvent.change(screen.getByLabelText("初始密码"), {
      target: { value: "customer-password" },
    });
    fireEvent.change(screen.getByLabelText("确认初始密码"), {
      target: { value: "customer-password" },
    });

    expect(
      screen.getByRole("button", { name: "创建客户并开通套餐" }),
    ).toBeEnabled();
  });

  it("hides the plan selector for an administrator account", () => {
    render(
      <PreviewCreateAccountDialog
        open
        onOpenChange={vi.fn()}
        onCreated={vi.fn()}
      />,
    );

    fireEvent.change(screen.getByLabelText("账号角色"), {
      target: { value: "管理员" },
    });

    expect(screen.queryByText("客户套餐")).not.toBeInTheDocument();
    expect(screen.getByText("初始密码")).toBeInTheDocument();
    expect(screen.getByText("确认初始密码")).toBeInTheDocument();
    expect(screen.getByText("管理员权限")).toBeInTheDocument();
  });

  it("renders a download and upload action for all seven delivery modules", () => {
    const onOpenCustomerDashboard = vi.fn();
    render(
      <PreviewDeliveryControl
        userName="验收客户"
        onOpenCustomerDashboard={onOpenCustomerDashboard}
      />,
    );

    expect(
      screen.getAllByRole("button", { name: "下载当前内容模板" }),
    ).toHaveLength(7);
    expect(screen.getAllByRole("button", { name: "上传并校验" })).toHaveLength(
      7,
    );
    expect(screen.queryByTestId("customer-dashboard-mirror")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "预览" }));
    expect(onOpenCustomerDashboard).toHaveBeenLastCalledWith("keywords");

    fireEvent.click(
      screen.getAllByRole("button", { name: "预览用户所见" })[2]!,
    );
    expect(onOpenCustomerDashboard).toHaveBeenLastCalledWith("questions");
  });

  it("merges service, requirements and sample operations into one customer workspace", () => {
    render(<PreviewAdminUsers previewAccessLevel="delivery_admin" />);

    expect(
      screen.queryByRole("button", { name: "客户工作台" }),
    ).not.toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "进入客户看板" }),
    ).toBeInTheDocument();
    expect(screen.getByText("套餐与服务周期")).toBeInTheDocument();
    expect(screen.getByText("验收企业需求记录")).toBeInTheDocument();
    expect(screen.getAllByRole("button", { name: "上传并校验" })).toHaveLength(
      7,
    );
    expect(screen.queryByText("用户流程")).not.toBeInTheDocument();
    expect(screen.queryByTestId("customer-dashboard-mirror")).toBeNull();
  });

  it("opens the customer dashboard fullscreen beside the administrator navigation", () => {
    render(<PreviewAdminUsers previewAccessLevel="delivery_admin" />);

    fireEvent.click(screen.getByRole("button", { name: "进入客户看板" }));

    expect(screen.getByTestId("portal-shell")).toHaveAttribute(
      "data-mode",
      "fullscreen",
    );
    expect(screen.getByTestId("customer-dashboard-mirror")).toHaveAttribute(
      "data-layout",
      "workspace",
    );
    expect(screen.getByTestId("customer-dashboard-mirror")).toHaveAttribute(
      "data-initial-section",
      "keywords",
    );
    expect(screen.getByTestId("customer-dashboard-mirror")).toHaveTextContent(
      "验收企业 · 客户看板",
    );
    expect(screen.queryByText("套餐与服务周期")).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "返回工作台" }));
    expect(screen.getByTestId("portal-shell")).toHaveAttribute(
      "data-mode",
      "standard",
    );
    expect(screen.queryByTestId("customer-dashboard-mirror")).toBeNull();
    expect(screen.getByText("套餐与服务周期")).toBeInTheDocument();
  });

  it("keeps a delivery administrator read-only and inside assigned customers", () => {
    render(<PreviewAdminUsers previewAccessLevel="delivery_admin" />);

    expect(screen.getByText("交付管理员验收账号")).toBeInTheDocument();
    expect(screen.getAllByText("验收企业")).not.toHaveLength(0);
    expect(screen.getByText("验收企业 B")).toBeInTheDocument();
    expect(screen.queryByText("验收企业 C")).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "创建客户" }),
    ).not.toBeInTheDocument();
    expect(screen.queryByLabelText("套餐版本")).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "编辑分配" }),
    ).not.toBeInTheDocument();
    expect(
      screen.getByTestId("admin-delivery-ticket-workspace"),
    ).toHaveAttribute("data-can-adjust-quota", "false");
    expect(
      screen.getByTestId("admin-delivery-ticket-workspace"),
    ).toHaveAttribute("data-can-execute-delivery", "false");
  });

  it("keeps account creation out of the system customer workspace", () => {
    const { container } = render(
      <PreviewAdminUsers previewAccessLevel="system_admin" />,
    );

    expect(screen.getByText("系统管理员验收账号")).toBeInTheDocument();
    expect(screen.getByText("验收企业 C")).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "创建客户" }),
    ).not.toBeInTheDocument();
    expect(screen.getByLabelText("套餐版本")).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "编辑分配" }),
    ).toBeInTheDocument();
    expect(screen.queryByText("API Key 与积分")).not.toBeInTheDocument();
    expect(screen.queryByText(/API Key 已配置/)).not.toBeInTheDocument();
    expect(screen.queryByText(/API Key 待配置/)).not.toBeInTheDocument();
    expect(
      screen.getByTestId("admin-delivery-ticket-workspace"),
    ).toHaveAttribute("data-can-adjust-quota", "true");
    expect(
      screen.getByTestId("admin-delivery-ticket-workspace"),
    ).toHaveAttribute("data-can-execute-delivery", "true");
    expect(
      Array.from(
        container.querySelectorAll(
          '[data-testid="preview-service-plan-quota"] [data-category]',
        ),
      ).map((item) => item.getAttribute("data-category")),
    ).toEqual([
      "industry",
      "competitor_comparison",
      "reputation",
      "product_scenario",
    ]);
  });

  it("shows the luxury first-quarter cap beside its full-year entitlement", () => {
    render(<PreviewAdminUsers previewAccessLevel="system_admin" />);

    fireEvent.click(screen.getByText("验收企业 B").closest("button")!);

    expect(
      screen.getByText(/第 1\/4 服务季度 · 当前已解锁 8 \/ 全年 32 个问题/),
    ).toBeInTheDocument();
    expect(screen.getAllByText("全年 4 个词")).toHaveLength(3);
    expect(screen.getByText("全年 20 个词")).toBeInTheDocument();
    const quota = screen.getByTestId("preview-service-plan-quota");
    expect(
      Array.from(quota.querySelectorAll("[data-category] strong")).map(
        (item) => item.textContent,
      ),
    ).toEqual(["1 个词", "1 个词", "1 个词", "5 个词"]);
  });
});
