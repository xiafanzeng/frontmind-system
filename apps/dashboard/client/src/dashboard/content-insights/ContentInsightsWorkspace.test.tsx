import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import ContentInsightsWorkspace, {
  readContentInsightsRoute,
} from "./ContentInsightsWorkspace";

vi.mock("recharts", () => ({
  ResponsiveContainer: ({ children }: { children: React.ReactNode }) => (
    <div>{children}</div>
  ),
  AreaChart: () => <div />,
  Area: () => null,
  CartesianGrid: () => null,
  XAxis: () => null,
  YAxis: () => null,
  Tooltip: () => null,
}));

describe("content insights interface preview", () => {
  beforeEach(() =>
    window.history.replaceState(null, "", "/?view=content-insights"),
  );
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    window.history.replaceState(null, "", "/");
  });

  it("uses its own validated URL parameters without taking over other dashboard state", () => {
    expect(readContentInsightsRoute("?module=settings&tab=share")).toEqual({
      section: "analytics",
      module: "overview",
      tab: "basic",
    });
    expect(
      readContentInsightsRoute(
        "?view=content-insights&contentModule=settings&contentTab=share",
      ),
    ).toEqual({ section: "widget", module: "settings", tab: "basic" });
    expect(
      readContentInsightsRoute("?contentModule=unknown&contentTab=unknown"),
    ).toEqual({ section: "analytics", module: "overview", tab: "basic" });
  });

  it.each([true, false])(
    "retains the development path only when DEV is %s",
    (development) => {
      vi.stubEnv("DEV", development);
      window.history.replaceState(
        null,
        "",
        "/preview/user?view=content-insights",
      );
      render(<ContentInsightsWorkspace />);
      fireEvent.click(screen.getByRole("button", { name: "AI 部件" }));
      expect(window.location.pathname).toBe(
        development ? "/preview/user" : "/",
      );
      expect(window.location.search).toBe(
        "?view=content-insights&contentModule=settings&contentTab=basic",
      );
      expect(screen.getByLabelText("机器人名称")).toBeInTheDocument();
    },
  );

  it("retains local widget edits across module tabs without exposing install or share internals", () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    render(<ContentInsightsWorkspace />);
    expect(screen.getByText("界面预览")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "AI 部件" }));
    fireEvent.change(screen.getByLabelText("机器人名称"), {
      target: { value: "界面样式助手" },
    });
    fireEvent.click(screen.getByRole("button", { name: "保存" }));
    expect(screen.getByRole("status")).toHaveTextContent("已保留在本次预览");
    fireEvent.click(screen.getByRole("button", { name: "分析" }));
    fireEvent.click(screen.getByRole("button", { name: "AI 部件" }));
    expect(screen.getByLabelText("机器人名称")).toHaveValue("界面样式助手");
    expect(screen.queryByRole("tab", { name: "安装代码" })).not.toBeInTheDocument();
    expect(screen.queryByRole("tab", { name: "分享地址" })).not.toBeInTheDocument();
    expect(screen.queryByText(/FrontMindPreview\.switchState/)).not.toBeInTheDocument();
    expect(screen.queryByText("立即续费")).not.toBeInTheDocument();
    expect(screen.queryByText("推荐问题")).not.toBeInTheDocument();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("shows unconnected collection and lead screens without simulated business records or success", () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    render(<ContentInsightsWorkspace />);
    fireEvent.click(screen.getByRole("button", { name: "AI 部件" }));
    fireEvent.click(screen.getByRole("button", { name: "采集" }));
    expect(screen.getByRole("button", { name: "新建采集" })).toBeDisabled();
    expect(screen.getByText("暂无采集内容")).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("搜索采集内容"), {
      target: { value: "示例" },
    });
    fireEvent.click(screen.getByRole("button", { name: "重置" }));
    expect(screen.getByLabelText("搜索采集内容")).toHaveValue("");
    fireEvent.click(screen.getByRole("button", { name: "留资统计" }));
    expect(screen.getByText("暂无留资记录")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "导出" })).toBeDisabled();
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
