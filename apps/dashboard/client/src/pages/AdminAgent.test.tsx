import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

vi.mock("@/_core/hooks/useAuth", () => ({
  useAuth: () => ({
    user: null,
    logout: vi.fn(),
  }),
}));

import AdminAgent from "./AdminAgent";

describe("AdminAgent preview", () => {
  it("uses the shared administrator shell with an isolated read-only Agent adapter", () => {
    render(<AdminAgent preview />);

    expect(
      screen.queryByRole("heading", { name: "FrontMind Agent" }),
    ).toBeNull();
    const workspace = screen.getByRole("region", {
      name: "FrontMind Agent 工作区",
    });
    expect(workspace).toBeInTheDocument();
    expect(workspace).toHaveClass("h-full");
    expect(
      screen.getByText("只读预览不会创建任务或写入会话"),
    ).toBeInTheDocument();
    expect(screen.getByText("只读预览")).toBeInTheDocument();
    expect(screen.queryByText("READ-ONLY PREVIEW")).toBeNull();
    expect(screen.queryByText("选择智能体")).not.toBeInTheDocument();
    expect(screen.queryByText("知识库维护")).not.toBeInTheDocument();
    expect(within(workspace).queryByText("构建企业知识库")).toBeNull();
    expect(within(workspace).queryByText("修改密码")).toBeNull();
    expect(within(workspace).queryByText("账号管理")).toBeNull();
    expect(within(workspace).queryByText("退出登录")).toBeNull();
    expect(within(workspace).queryByText("设置与积分记录")).toBeNull();
    expect(within(workspace).queryByText(/API Key/)).toBeNull();
  });

  it("mounts the live Agent as a fullscreen workspace without inner account or knowledge-base launchers", () => {
    const source = readFileSync(
      resolve(process.cwd(), "client/src/pages/AdminAgent.tsx"),
      "utf8",
    );
    expect(source).toContain('mode="fullscreen"');
    expect(source).toContain("showKnowledgeBaseStarter={false}");
    expect(source).toContain("showAccountMenu={false}");
    expect(source).toContain("showSettings={false}");
    expect(source).toContain('standardWelcomeVariant="workflow"');
  });

  it("keeps the live Agent route available to delivery administrators", () => {
    const source = readFileSync(
      resolve(process.cwd(), "client/src/App.tsx"),
      "utf8",
    );
    expect(source).toContain(
      '<Route path={"/admin/agent"}>\n        <DeliveryAdminOnly>',
    );
    expect(source).not.toContain(
      '<Route path={"/admin/agent"}>\n        <AdminOnly>',
    );
  });
});
