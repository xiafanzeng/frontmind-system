import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const authMock = vi.hoisted(() => ({
  login: vi.fn(),
  loginPending: false,
}));

const toastMock = vi.hoisted(() => ({
  error: vi.fn(),
}));

vi.mock("@/_core/hooks/useAuth", () => ({
  useAuth: () => authMock,
}));

vi.mock("sonner", () => ({
  toast: toastMock,
}));

import Login from "./Login";

describe("Login", () => {
  beforeEach(() => {
    authMock.login.mockReset();
    authMock.login.mockResolvedValue({
      user: {
        id: 1,
        username: "demo",
        displayName: "演示账号",
        role: "user",
        isActive: true,
      },
    });
    toastMock.error.mockReset();
    window.history.replaceState({}, "", "/login");
  });

  it("shows the FrontMind positioning and the approved school laboratory brand", () => {
    render(<Login />);

    expect(screen.getByText("与 FrontMind 一起，")).toBeInTheDocument();
    expect(
      screen.getByText("构筑科研驱动的企业级 GEO 基建"),
    ).toBeInTheDocument();
    expect(
      screen.queryByText("体验论文级内容与科研级审美标准"),
    ).not.toBeInTheDocument();
    expect(screen.getByAltText("香港中文大学（深圳）校徽")).toHaveAttribute(
      "src",
      "/assets/cuhksz-emblem.png",
    );
    expect(
      screen.getByText("香港中文大学（深圳）AI智能决策实验室"),
    ).toBeInTheDocument();
    expect(screen.getByTestId("presales-login-hint")).toHaveTextContent(
      "请返回官网完成售前流程，使用售前分配的账号登录。",
    );
    expect(screen.getByRole("link", { name: "返回官网" })).toHaveAttribute(
      "href",
      "https://www.frontmind.net",
    );
  });

  it("submits the normalized username and password", async () => {
    render(<Login />);

    fireEvent.change(screen.getByLabelText("用户名"), {
      target: { value: "  demo  " },
    });
    fireEvent.change(screen.getByLabelText("密码"), {
      target: { value: "a-secure-password" },
    });
    fireEvent.click(screen.getByRole("button", { name: "登录" }));

    await waitFor(() =>
      expect(authMock.login).toHaveBeenCalledWith("demo", "a-secure-password"),
    );
    await waitFor(() => expect(window.location.pathname).toBe("/"));
  });

  it("does not submit incomplete credentials", () => {
    render(<Login />);

    fireEvent.click(screen.getByRole("button", { name: "登录" }));

    expect(authMock.login).not.toHaveBeenCalled();
    expect(toastMock.error).toHaveBeenCalledWith("请输入用户名和密码");
  });

  it("shows an English authentication failure in Chinese", async () => {
    authMock.login.mockRejectedValue(new Error("Invalid username or password"));
    render(<Login />);

    fireEvent.change(screen.getByLabelText("用户名"), {
      target: { value: "demo" },
    });
    fireEvent.change(screen.getByLabelText("密码"), {
      target: { value: "wrong-password" },
    });
    fireEvent.click(screen.getByRole("button", { name: "登录" }));

    await waitFor(() =>
      expect(toastMock.error).toHaveBeenCalledWith("无法登录", {
        description: "用户名或密码不正确",
      }),
    );
  });
});
