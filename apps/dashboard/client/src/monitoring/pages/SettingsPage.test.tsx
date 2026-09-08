import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import SettingsPage, { type BillingLedgerEntryView } from "./SettingsPage";

const activity = Array.from(
  { length: 10 },
  (_, index): BillingLedgerEntryView => ({
    id: `entry-${index}`,
    source: "ai",
    type: "spend",
    balanceDeltaTenThousandths: "-80",
    description: "智能体用量结算",
    status: "completed",
    createdAt: "2026-09-08T00:00:00.000Z",
  }),
);

describe("account activity pagination", () => {
  it("shows ten rows and navigates through the full server-reported history", () => {
    const onPage = vi.fn();
    const { rerender } = render(
      <SettingsPage
        activity={activity}
        activityTotal={115}
        onActivityPageChange={onPage}
      />,
    );
    expect(
      within(screen.getByRole("table", { name: "资金明细" })).getAllByRole(
        "row",
      ),
    ).toHaveLength(11);
    expect(
      screen.getByText("共 115 条 · 第 1 / 12 页 · 每页 10 条"),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "上一页" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "下一页" }));
    expect(onPage).toHaveBeenLastCalledWith(2);

    rerender(
      <SettingsPage
        activity={activity.slice(0, 5)}
        activityTotal={115}
        activityPage={12}
        onActivityPageChange={onPage}
      />,
    );
    expect(
      within(screen.getByRole("table", { name: "资金明细" })).getAllByRole(
        "row",
      ),
    ).toHaveLength(6);
    expect(screen.getByRole("button", { name: "下一页" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "上一页" }));
    expect(onPage).toHaveBeenLastCalledWith(11);
  });

  it("requests source filtering and blocks page changes while a request is pending", () => {
    const onFilter = vi.fn();
    render(
      <SettingsPage
        activityLoading
        activityPage={2}
        activityTotal={115}
        onActivityFilterChange={onFilter}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "智能体消耗" }));
    expect(onFilter).toHaveBeenCalledWith("ai");
    expect(screen.getByRole("status")).toHaveTextContent("正在读取资金明细");
    expect(screen.getByRole("button", { name: "上一页" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "下一页" })).toBeDisabled();
  });

  it("uses FrontMind pricing presentation without publishing supplier or markup claims", () => {
    render(<SettingsPage />);
    expect(
      screen.getByRole("region", { name: "FrontMind 资费，可横向滚动" }),
    ).toBeInTheDocument();
    expect(
      screen.queryByText(/智谱|GLM|官方原价|无加价/),
    ).not.toBeInTheDocument();
    expect(
      screen.getByText("共 0 条 · 第 1 / 1 页 · 每页 10 条"),
    ).toBeInTheDocument();
  });
});
