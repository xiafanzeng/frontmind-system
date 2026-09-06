import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import MonitoringPage from "./MonitoringPage";

describe("first monitoring project navigation", () => {
  it("can dismiss and reopen the first-project form without creating business data", async () => {
    const createProject = vi.fn();
    render(
      <MonitoringPage
        monitors={[]}
        models={[]}
        availableBalanceTenThousandths="0"
        quoteRunCost={vi.fn()}
        quoteMonitorRunCost={vi.fn()}
        onCreateProject={createProject}
        onSaveMonitor={vi.fn()}
        onRunMonitor={vi.fn()}
        onToggleMonitor={vi.fn()}
        onDeleteMonitor={vi.fn()}
      />,
    );
    expect(
      await screen.findByRole("dialog", { name: "创建第一个项目" }),
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "取消" }));
    await waitFor(() =>
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument(),
    );
    expect(screen.getByText("尚未创建监控项目")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "创建项目" }));
    expect(
      screen.getByRole("dialog", { name: "创建第一个项目" }),
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "关闭" }));
    await waitFor(() =>
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument(),
    );
    expect(createProject).not.toHaveBeenCalled();
  });
});
