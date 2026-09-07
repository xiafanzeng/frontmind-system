import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { OperatorSidebar, OperatorTabs } from "./OperatorNavigation";
import { operatorRouteForView, operatorViewFromRoute, operatorViewPath } from "./operator-navigation";

describe("operator workspace navigation", () => {
  it("offers six persistent modules and nested knowledge views", () => {
    const select = vi.fn();
    render(<OperatorTabs view="knowledge-display" projectName="企业甲" onSelect={select} />);
    expect(screen.getByRole("tablist", { name: "项目板块" }).querySelectorAll('[role="tab"]')).toHaveLength(6);
    expect(screen.getByRole("button", { name: "知识库展示" })).toHaveAttribute("aria-pressed", "true");
    fireEvent.click(screen.getByRole("tab", { name: /意图优化/ }));
    expect(select).toHaveBeenCalledWith("questions");
    expect(screen.queryByText("服务首页")).not.toBeInTheDocument();
  });
  it("creates projects explicitly and keeps account entries outside them", async () => {
    const create = vi.fn().mockResolvedValue(undefined);
    const navigate = vi.fn();
    render(<OperatorSidebar projects={[]} activeEntry="project" collapsed={false} onCollapse={vi.fn()} onNavigate={navigate} onSelectProject={vi.fn()} onCreateProject={create} onRenameProject={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "新建企业项目" }));
    fireEvent.change(screen.getByLabelText("项目名称"), { target: { value: " 企业乙 " } });
    fireEvent.click(screen.getByRole("button", { name: "创建项目" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(create).toHaveBeenCalledWith("企业乙");
    fireEvent.click(screen.getByRole("button", { name: "账号与余额" }));
    expect(navigate).toHaveBeenCalledWith("/account");
  });
  it("uses project views and preserves canonical monitoring deep links", () => {
    expect(operatorViewFromRoute(operatorRouteForView("questions"))).toBe("questions");
    expect(operatorRouteForView("historical-results", "archived-question")).toEqual({ section: "historical-results", sub: "archived-question" });
    expect(operatorViewFromRoute({ section: "historical-results", sub: "archived-question" })).toBe("questions");
    expect(operatorViewPath("monitoring")).toBe("/monitoring-system");
    expect(operatorViewFromRoute({ section: "publishing-module", sub: "/publishing/articles" })).toBe("articles");
  });
});
