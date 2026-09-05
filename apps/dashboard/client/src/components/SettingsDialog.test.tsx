import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  authUser: {
    id: 2,
    username: "regular-user",
    displayName: "普通用户",
    role: "user" as "user" | "admin" | "delivery_member",
    adminAccessLevel: null as "system_admin" | "delivery_admin" | null,
    isActive: true,
  },
  fetchCreditUsage: vi.fn(),
  subscribe: vi.fn(() => vi.fn()),
  refetchStatus: vi.fn(),
  invalidateStatus: vi.fn(),
  setCredential: vi.fn(),
  replaceCredential: vi.fn(),
  testCredential: vi.fn(),
  resetSet: vi.fn(),
  resetReplace: vi.fn(),
  resetTest: vi.fn(),
}));

vi.mock("@/_core/hooks/useAuth", () => ({
  useAuth: () => ({ user: mocks.authUser }),
}));

vi.mock("@/lib/frontmind-api", () => ({
  creditEventBus: { subscribe: mocks.subscribe },
  fetchCreditUsage: mocks.fetchCreditUsage,
}));

vi.mock("@/lib/trpc", () => ({
  trpc: {
    useUtils: () => ({
      credential: { status: { invalidate: mocks.invalidateStatus } },
    }),
    credential: {
      status: {
        useQuery: () => ({
          data: {
            configured: true,
            fingerprint: "key-abcd",
            status: "active",
            verifiedAt: "2026-07-14T06:00:00.000Z",
          },
          isLoading: false,
          isFetching: false,
          error: null,
          refetch: mocks.refetchStatus,
        }),
      },
      set: {
        useMutation: () => ({
          mutateAsync: mocks.setCredential,
          isPending: false,
          reset: mocks.resetSet,
        }),
      },
      replace: {
        useMutation: () => ({
          mutateAsync: mocks.replaceCredential,
          isPending: false,
          reset: mocks.resetReplace,
        }),
      },
      test: {
        useMutation: () => ({
          mutateAsync: mocks.testCredential,
          isPending: false,
          reset: mocks.resetTest,
        }),
      },
    },
  },
}));

import SettingsDialog from "./SettingsDialog";

describe("SettingsDialog", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.authUser = {
      id: 2,
      username: "regular-user",
      displayName: "普通用户",
      role: "user",
      adminAccessLevel: null,
      isActive: true,
    };
    mocks.fetchCreditUsage.mockResolvedValue({
      totalUsed: 128,
      recentTasks: [
        {
          id: "task-1",
          title: "GEO 品牌洞察",
          creditUsage: 128,
          createdAt: "2026/07/14",
        },
      ],
    });
  });

  it("hides usage records for a regular user", () => {
    render(<SettingsDialog open onOpenChange={vi.fn()} />);

    expect(screen.getByText("智能服务设置")).toBeInTheDocument();
    expect(
      screen.getByText(/API Key.*由系统管理员统一维护/),
    ).toBeInTheDocument();
    expect(screen.queryByText("API Key 使用教程")).not.toBeInTheDocument();
    expect(screen.queryByText("当前 Key 本月总积分")).not.toBeInTheDocument();
    expect(screen.queryByText("最近任务明细")).not.toBeInTheDocument();
    expect(mocks.fetchCreditUsage).not.toHaveBeenCalled();
    expect(
      screen.queryByRole("button", { name: "测试连接" }),
    ).not.toBeInTheDocument();
    expect(screen.queryByText(/积分/)).not.toBeInTheDocument();
    expect(screen.queryByText("云端凭据状态")).not.toBeInTheDocument();
    expect(screen.queryByText("Key 指纹")).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "删除 Key" }),
    ).not.toBeInTheDocument();
    expect(screen.queryByText("检测到旧版本地数据")).not.toBeInTheDocument();
    expect(screen.queryByText("迁移到当前账号")).not.toBeInTheDocument();
  });

  it("hides Key controls from an explicit delivery administrator", () => {
    mocks.authUser = {
      id: 3,
      username: "admin",
      displayName: "运营管理员",
      role: "admin",
      adminAccessLevel: "delivery_admin",
      isActive: true,
    };

    render(<SettingsDialog open onOpenChange={vi.fn()} />);

    expect(screen.getByText("智能服务设置")).toBeInTheDocument();
    expect(screen.getByText(/由系统管理员统一维护/)).toBeInTheDocument();
    expect(screen.queryByText("当前 Key 本月总积分")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("输入新的 API Key")).not.toBeInTheDocument();
    expect(mocks.fetchCreditUsage).not.toHaveBeenCalled();
  });

  it("hides Key controls from an engineer", () => {
    mocks.authUser = {
      id: 4,
      username: "engineer",
      displayName: "交付工程师",
      role: "delivery_member",
      adminAccessLevel: null,
      isActive: true,
    };

    render(<SettingsDialog open onOpenChange={vi.fn()} />);

    expect(screen.getByText("智能服务设置")).toBeInTheDocument();
    expect(screen.getByText(/由系统管理员统一维护/)).toBeInTheDocument();
    expect(screen.queryByLabelText(/API Key/)).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "测试连接" }),
    ).not.toBeInTheDocument();
    expect(mocks.fetchCreditUsage).not.toHaveBeenCalled();
  });

  it("routes a system administrator to the unified API and people console", () => {
    mocks.authUser = {
      id: 1,
      username: "security-owner",
      displayName: "系统管理员",
      role: "admin",
      adminAccessLevel: "system_admin",
      isActive: true,
    };

    render(<SettingsDialog open onOpenChange={vi.fn()} />);

    expect(screen.getByText(/API 与人员管理/)).toBeInTheDocument();
    expect(screen.queryByText(/本月总积分/)).not.toBeInTheDocument();
    expect(screen.queryByText("最近任务明细")).not.toBeInTheDocument();
    expect(screen.queryByLabelText(/API Key/)).not.toBeInTheDocument();
    expect(mocks.fetchCreditUsage).not.toHaveBeenCalled();
  });
});
