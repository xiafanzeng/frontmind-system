import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import AdminPage from "./AdminPage";

describe("shared administration run list", () => {
  it.each(["operations", "content-review"] as const)(
    "keeps %s filters, pagination and its own inspect callback",
    (section) => {
      const inspectContent = vi.fn();
      const inspectExecution = vi.fn();
      const filter = vi.fn();
      const loadMore = vi.fn();
      const filters = {
        userId: "customer",
        status: "",
        from: "2026-09-01",
        to: "2026-09-09",
      };
      render(
        <AdminPage
          section={section}
          users={[
            {
              id: "customer",
              username: "customer",
              role: "user",
              active: true,
              granted: 0,
              consumed: 0,
              reserved: 0,
            },
          ]}
          provider={{
            enabledModels: 0,
            discoveredModels: 0,
            activeRuns: 0,
            queueDepth: 0,
          }}
          runs={[
            {
              id: "run-1",
              username: "customer",
              monitorName: "品牌问题",
              status: "completed",
              expected: 4,
              completed: 4,
              failed: 0,
            },
          ]}
          runsHasMore
          runFilters={filters}
          onRunFiltersChange={filter}
          onInspectRun={inspectContent}
          onInspectExecution={inspectExecution}
          onLoadOlderRuns={loadMore}
        />,
      );
      expect(screen.getAllByRole("table")).toHaveLength(1);
      fireEvent.change(screen.getByLabelText("按状态筛选任务运行"), {
        target: { value: "failed" },
      });
      expect(filter).toHaveBeenCalledWith({ ...filters, status: "failed" });
      fireEvent.click(
        screen.getByRole("button", {
          name:
            section === "content-review"
              ? "查阅 @customer 的“品牌问题”运行内容"
              : "查看执行详情",
        }),
      );
      expect(
        section === "content-review" ? inspectContent : inspectExecution,
      ).toHaveBeenCalledWith("run-1");
      expect(
        section === "content-review" ? inspectExecution : inspectContent,
      ).not.toHaveBeenCalled();
      fireEvent.click(screen.getByRole("button", { name: "加载更多运行" }));
      expect(loadMore).toHaveBeenCalledOnce();
    },
  );
});
