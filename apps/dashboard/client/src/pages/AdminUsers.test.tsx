import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  createUser: vi.fn(),
  setEngineerApiKey: vi.fn(),
  revokeEngineerApiKey: vi.fn(),
  invalidateUsers: vi.fn(),
  invalidateWorkspace: vi.fn(),
}));

vi.mock("@/lib/trpc", () => ({
  trpc: {
    useUtils: () => ({
      admin: {
        users: { list: { invalidate: mocks.invalidateUsers } },
        workspace: { list: { invalidate: mocks.invalidateWorkspace } },
      },
    }),
    admin: {
      users: {
        create: {
          useMutation: () => ({
            mutateAsync: mocks.createUser,
            isPending: false,
            reset: vi.fn(),
          }),
        },
      },
    },
    delivery: {
      management: {
        setEngineerApiKey: {
          useMutation: () => ({
            mutateAsync: mocks.setEngineerApiKey,
            isPending: false,
            reset: vi.fn(),
          }),
        },
        revokeEngineerApiKey: {
          useMutation: () => ({
            mutateAsync: mocks.revokeEngineerApiKey,
            isPending: false,
            reset: vi.fn(),
          }),
        },
      },
    },
  },
}));

import { CreateUserDialog, EngineerApiKeyDialog, UserRow } from "./AdminUsers";

const deliveryAdmins = [
  {
    id: 42,
    username: "delivery.owner",
    displayName: "交付负责人",
  },
  {
    id: 1,
    username: "admin",
    displayName: "Admin",
  },
];

describe("CreateUserDialog", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("creates the customer first and routes Key configuration to the unified console", () => {
    render(
      <CreateUserDialog
        open
        userOnly
        deliveryAdmins={deliveryAdmins}
        onOpenChange={() => undefined}
      />,
    );

    expect(screen.getByText("客户套餐")).toBeInTheDocument();
    expect(screen.getByText(/设置客户初始密码/)).toBeInTheDocument();
    expect(screen.queryByText("账号角色")).toBeNull();
    expect(screen.getByText("初始密码")).toBeInTheDocument();
    expect(screen.getByText("确认初始密码")).toBeInTheDocument();
    expect(screen.queryByText(/设置密码链接/)).toBeNull();
    expect(screen.queryByLabelText("客户 API Key（可选）")).toBeNull();
    expect(screen.getByRole("button", { name: "创建客户账号" })).toBeDisabled();
    expect(screen.getByText(/创建账号弹窗不再接收 Key/)).toBeInTheDocument();
    const dialog = screen.getByRole("dialog");
    expect(dialog.className).toContain("100dvh");
    expect(dialog.querySelector(".overflow-y-auto")).not.toBeNull();
  });

  it("removes the retired knowledge plan and requires a market edition", () => {
    render(
      <CreateUserDialog
        open
        userOnly
        deliveryAdmins={deliveryAdmins}
        onOpenChange={() => undefined}
      />,
    );

    expect(
      screen.getByRole("combobox", { name: "客户主负责人" }),
    ).toBeEnabled();
    expect(screen.getByRole("combobox", { name: "客户版本" })).toBeEnabled();
    fireEvent.click(screen.getByRole("combobox", { name: "客户套餐" }));
    expect(screen.getByRole("option", { name: "普通版" })).toBeInTheDocument();
    expect(screen.queryByRole("option", { name: "知识库版" })).toBeNull();
    expect(screen.getByRole("option", { name: "进阶版" })).toBeInTheDocument();
    expect(screen.getByRole("option", { name: "豪华版" })).toBeInTheDocument();
    expect(screen.getAllByRole("option")).toHaveLength(3);

    fireEvent.click(screen.getByRole("option", { name: "普通版" }));
    fireEvent.click(screen.getByRole("combobox", { name: "客户版本" }));
    expect(screen.getByRole("option", { name: "海内版" })).toBeInTheDocument();
    expect(screen.getByRole("option", { name: "海外版" })).toBeInTheDocument();
  });

  it("offers both Admin and delivery administrators as customer owners", () => {
    render(
      <CreateUserDialog
        open
        userOnly
        deliveryAdmins={deliveryAdmins}
        onOpenChange={() => undefined}
      />,
    );

    fireEvent.click(screen.getByRole("combobox", { name: "客户主负责人" }));
    expect(
      screen.getByRole("option", { name: "交付负责人 · @delivery.owner" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("option", { name: "Admin · @admin" }),
    ).toBeInTheDocument();
  });

  it("keeps administrator creation available only in the system-admin variant", () => {
    render(<CreateUserDialog open onOpenChange={() => undefined} />);

    expect(screen.getByText("账号角色")).toBeInTheDocument();
    expect(screen.getByText("客户套餐")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("combobox", { name: "账号角色" }));
    expect(screen.getByRole("option", { name: "客户" })).toBeInTheDocument();
    expect(screen.getByRole("option", { name: "管理员" })).toBeInTheDocument();
    expect(screen.getByRole("option", { name: "工程师" })).toBeInTheDocument();
  });

  it("automatically fixes a delivery administrator as the new customer's owner", () => {
    render(
      <CreateUserDialog
        open
        userOnly
        fixedDeliveryAdmin={deliveryAdmins[0]}
        onOpenChange={() => undefined}
      />,
    );

    expect(screen.queryByRole("combobox", { name: "客户主负责人" })).toBeNull();
    expect(screen.getByText(/交付负责人/)).toBeInTheDocument();
    expect(screen.getByText(/自动归属当前账号/)).toBeInTheDocument();
    expect(screen.getByText(/自动归属当前交付管理员/)).toBeInTheDocument();
    expect(screen.queryByLabelText("客户 API Key（可选）")).toBeNull();
    expect(screen.getByText(/无需填写或接触 Key/)).toBeInTheDocument();
  });

  it("lets delivery administrators create customers or engineers, but not administrators", () => {
    render(
      <CreateUserDialog
        open
        userOnly
        allowEngineer
        fixedDeliveryAdmin={deliveryAdmins[0]}
        onOpenChange={() => undefined}
      />,
    );

    fireEvent.click(screen.getByRole("combobox", { name: "账号角色" }));
    expect(screen.getByRole("option", { name: "客户" })).toBeInTheDocument();
    expect(screen.getByRole("option", { name: "工程师" })).toBeInTheDocument();
    expect(screen.queryByRole("option", { name: "管理员" })).toBeNull();

    fireEvent.click(screen.getByRole("option", { name: "工程师" }));
    expect(screen.queryByLabelText("工程师 API Key（可选）")).toBeNull();
    expect(
      screen.getByText(/由系统管理员在 API 与人员管理统一配置工程师/),
    ).toBeInTheDocument();
  });

  it("requires one fixed engineer role and omits API Key from account creation", async () => {
    mocks.createUser.mockResolvedValue({ user: { id: 88 } });
    render(<CreateUserDialog open onOpenChange={() => undefined} />);

    fireEvent.click(screen.getByRole("combobox", { name: "账号角色" }));
    fireEvent.click(screen.getByRole("option", { name: "工程师" }));

    expect(screen.queryByText("工程师 API Key（可选）")).toBeNull();
    expect(screen.getByText(/创建账号弹窗不再接收 Key/)).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "创建工程师账号" }),
    ).toBeDisabled();

    fireEvent.click(screen.getByRole("combobox", { name: "工程师岗位" }));
    expect(
      screen.getByRole("option", { name: "AI 运维工程师" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("option", { name: "AI 监控与优化工程师" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("option", { name: "AI 内容分发工程师" }),
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole("option", { name: "AI 运维工程师" }));

    fireEvent.change(screen.getByLabelText("用户名"), {
      target: { value: "engineer.one" },
    });
    fireEvent.change(screen.getByLabelText("初始密码"), {
      target: { value: "secret1" },
    });
    fireEvent.change(screen.getByLabelText("确认初始密码"), {
      target: { value: "secret1" },
    });
    const submit = screen.getByRole("button", { name: "创建工程师账号" });
    expect(submit).toBeEnabled();
    fireEvent.click(submit);

    await waitFor(() =>
      expect(mocks.createUser).toHaveBeenCalledWith({
        username: "engineer.one",
        displayName: undefined,
        password: "secret1",
        role: "delivery_member",
        engineerRoleType: "ai_operations_engineer",
      }),
    );
  });
});

describe("engineer account management", () => {
  const engineer = {
    id: 88,
    username: "engineer.one",
    displayName: "工程师一号",
    role: "delivery_member" as const,
    adminAccessLevel: null,
    engineerRoleType: "ai_operations_engineer" as const,
    engineerApiKeyConfigured: false,
    marketEdition: "domestic" as const,
    isActive: true,
  };

  it("shows the fixed role and read-only Key status in the account list", () => {
    render(
      <UserRow
        account={engineer}
        isCurrent={false}
        pending={false}
        accessPending={false}
        onResetPassword={() => undefined}
        onChangeAccessLevel={() => undefined}
        onChangeStatus={() => undefined}
        onDelete={() => undefined}
      />,
    );

    expect(screen.getByText("工程师")).toBeInTheDocument();
    expect(screen.getByText("AI 运维工程师")).toBeInTheDocument();
    expect(screen.getByText("Key 未配置")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "管理 Key" })).toBeNull();
  });

  it("removes the account-page Key writer and routes engineers to unified management", () => {
    render(
      <EngineerApiKeyDialog user={engineer} onOpenChange={() => undefined} />,
    );

    expect(screen.getByText("工程师 API Key 已统一管理")).toBeInTheDocument();
    expect(screen.getByText(/API 与人员管理/)).toBeInTheDocument();
    expect(screen.queryByLabelText("API Key")).not.toBeInTheDocument();
    expect(mocks.setEngineerApiKey).not.toHaveBeenCalled();
  });
});
