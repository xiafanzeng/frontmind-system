import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import MonitoringDemo from "./MonitoringDemo";

beforeEach(() => {
  window.history.replaceState({}, "", "/monitoring");
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => {
      throw new Error("Demo must not call an API");
    }),
  );
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: { writeText: vi.fn(async () => {}) },
  });
});
afterEach(() => vi.unstubAllGlobals());

describe("standalone monitoring demo", () => {
  it("uses synthetic data, supports section selection, and exposes media as explicitly synthetic", async () => {
    render(<MonitoringDemo />);
    expect(screen.getByText("本地演示")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("tab", { name: "商品统计" }));
    expect(screen.getByText(/以下为布局演示/)).toBeInTheDocument();
    expect(screen.getByText("轻木系列 · 小户型边柜")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("tab", { name: "视频统计" }));
    expect(screen.getByText("小空间的收纳与生活动线")).toBeInTheDocument();
    expect(fetch).not.toHaveBeenCalled();
  });
  it("locally corrects a result and tracks sources while preserving the original answer", async () => {
    render(<MonitoringDemo />);
    fireEvent.click(screen.getByRole("tab", { name: "问答明细" }));
    fireEvent.click(screen.getByRole("button", { name: "纠正" }));
    const dialog = screen.getByRole("dialog", { name: "纠正提及结果 · 演示" });
    fireEvent.change(within(dialog).getByLabelText("纠正后的提及位置"), {
      target: { value: "7" },
    });
    fireEvent.click(
      within(dialog).getByRole("button", { name: "保存演示纠正" }),
    );
    await waitFor(() =>
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument(),
    );
    expect(screen.getByText("提及位置：第 7 位")).toBeInTheDocument();
    fireEvent.click(
      screen.getAllByRole("button", { name: "追踪引用 · 演示" })[0],
    );
    fireEvent.click(screen.getByRole("button", { name: "已追踪 1" }));
    expect(
      screen.getByRole("button", { name: "已追踪 · 演示" }),
    ).toHaveAttribute("aria-pressed", "true");
    expect(
      screen.getByText("尺寸与功能", { exact: false }),
    ).toBeInTheDocument();
    expect(fetch).not.toHaveBeenCalled();
  });
  it("copies text and opens a local screenshot preview and accessible fullscreen", async () => {
    render(<MonitoringDemo />);
    fireEvent.click(screen.getByRole("tab", { name: "问答明细" }));
    fireEvent.click(screen.getByRole("button", { name: "复制" }));
    await waitFor(() =>
      expect(navigator.clipboard.writeText).toHaveBeenCalledWith(
        expect.stringContaining("合成演示内容"),
      ),
    );
    fireEvent.click(screen.getByRole("button", { name: "截图" }));
    expect(screen.getByText("回答快照 · 本地演示")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "关闭回答截图" }));
    fireEvent.click(screen.getByRole("button", { name: "全屏查看" }));
    expect(
      screen.getByRole("dialog", { name: "全屏问答明细" }),
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "退出全屏" }));
    await waitFor(() =>
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument(),
    );
    expect(fetch).not.toHaveBeenCalled();
  });
  it("saves a local monitor and requires the simulation confirmation before generating a run", async () => {
    render(<MonitoringDemo />);
    fireEvent.click(screen.getByRole("button", { name: "批量添加问题" }));
    const form = screen.getByRole("dialog", { name: "批量添加问题" });
    expect(
      within(form).getByRole("button", { name: "保存并立即执行" }),
    ).toBeDisabled();
    fireEvent.click(within(form).getByRole("button", { name: "保存监控" }));
    expect(within(form).getByText("请填写监控名称。")).toBeInTheDocument();
    fireEvent.change(
      within(form).getByPlaceholderText("例如：核心品牌问题监控"),
      { target: { value: "新的演示监控" } },
    );
    fireEvent.click(within(form).getByRole("button", { name: "保存监控" }));
    expect(
      within(form).getByText("请至少添加一个监控问题。"),
    ).toBeInTheDocument();
    fireEvent.change(within(form).getByLabelText("新增监控问题"), {
      target: { value: "哪些材料适合小户型家居？" },
    });
    fireEvent.click(within(form).getByRole("button", { name: "添加问题" }));
    await waitFor(() =>
      expect(
        within(form).getByRole("button", { name: "保存并立即执行" }),
      ).toBeEnabled(),
    );
    fireEvent.click(within(form).getByRole("button", { name: "保存监控" }));
    await waitFor(() =>
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument(),
    );
    expect(
      screen.getByRole("article", { name: "新的演示监控监控任务" }),
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "立即运行" }));
    const confirm = await screen.findByRole("dialog", { name: "确认立即执行" });
    expect(within(confirm).getByText(/本次只模拟运行/)).toBeInTheDocument();
    await waitFor(() =>
      expect(
        within(confirm).getByRole("button", { name: "确认执行" }),
      ).toBeEnabled(),
    );
    fireEvent.click(within(confirm).getByRole("button", { name: "确认执行" }));
    await waitFor(() =>
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument(),
    );
    expect(screen.getByText(/模拟运行完成：/)).toBeInTheDocument();
    expect(fetch).not.toHaveBeenCalled();
  });
  it("edits only local brand and keyword drafts without saving the monitoring form", async () => {
    render(<MonitoringDemo />);
    fireEvent.click(screen.getByRole("button", { name: "批量添加问题" }));
    const form = screen.getByRole("dialog", { name: "批量添加问题" });
    fireEvent.click(
      within(form).getByRole("button", { name: "选择演示监控品牌" }),
    );
    const brand = screen.getByRole("dialog", { name: "选择监控品牌 · 演示" });
    fireEvent.change(within(brand).getByLabelText("选择合成品牌"), {
      target: { value: "拾木家居" },
    });
    fireEvent.change(within(brand).getByLabelText("演示品牌别名"), {
      target: { value: "拾木生活" },
    });
    fireEvent.click(
      within(brand).getByRole("button", { name: "确定演示品牌" }),
    );
    await waitFor(() =>
      expect(
        screen.queryByRole("dialog", { name: "选择监控品牌 · 演示" }),
      ).not.toBeInTheDocument(),
    );
    expect(
      within(form).getByRole("button", { name: "选择演示监控品牌" }),
    ).toHaveTextContent("拾木家居");
    expect(
      within(form).queryByText("请填写监控名称。"),
    ).not.toBeInTheDocument();
    fireEvent.change(within(form).getByLabelText("演示核心词 1"), {
      target: { value: "实木家具" },
    });
    fireEvent.click(
      within(form).getByRole("button", { name: "添加演示核心词" }),
    );
    fireEvent.click(
      within(form).getByRole("switch", { name: "启用演示核心词 1" }),
    );
    expect(within(form).getByLabelText("演示核心词 1")).toBeDisabled();
    fireEvent.click(
      within(form).getByRole("switch", { name: "启用演示核心词 1" }),
    );
    expect(within(form).getByLabelText("演示核心词 1")).toBeEnabled();
    fireEvent.click(
      within(form).getByRole("button", { name: "删除演示核心词 2" }),
    );
    expect(
      within(form).queryByLabelText("演示核心词 2"),
    ).not.toBeInTheDocument();
    expect(fetch).not.toHaveBeenCalled();
  });
});
