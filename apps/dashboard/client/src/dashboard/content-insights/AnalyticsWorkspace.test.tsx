import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("recharts", () => ({
  ResponsiveContainer: ({ children }: { children: React.ReactNode }) => (
    <div>{children}</div>
  ),
  AreaChart: () => <div data-testid="trend-chart" />,
  Area: () => null,
  CartesianGrid: () => null,
  XAxis: () => null,
  YAxis: () => null,
  Tooltip: () => null,
}));
vi.mock("./shared", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./shared")>();
  return { ...actual, downloadCsv: vi.fn() };
});

import AnalyticsWorkspace from "./AnalyticsWorkspace";
import { QA_RECORDS, articleRows, trafficRows } from "./analytics-data";
import { INITIAL_PERIOD, downloadCsv, type AnalyticsModule } from "./shared";

function mount(module: AnalyticsModule, onNavigate = vi.fn()) {
  return render(
    <div className="helplook-preview">
      <AnalyticsWorkspace module={module} onNavigate={onNavigate} />
    </div>,
  );
}

function bodyRows(table: HTMLElement) {
  return within(table).getAllByRole("row").slice(1);
}

describe("HelpLook analytics local interactions", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });
  afterEach(cleanup);

  it("paginates articles, searches on submit, and retains each module's state", () => {
    const view = mount("articles");
    const page = screen.getByRole("region", { name: "文章分析" });
    const table = within(page).getByRole("table", { name: "文章统计" });
    const articles = articleRows(INITIAL_PERIOD);
    expect(bodyRows(table)).toHaveLength(10);
    expect(bodyRows(table)[0]).toHaveTextContent(articles[0].title);
    fireEvent.click(within(page).getByRole("button", { name: "下一页" }));
    expect(bodyRows(table)[0]).toHaveTextContent(articles[10].title);

    const target = articles[20];
    fireEvent.change(within(page).getByLabelText("文章关键词"), {
      target: { value: target.title },
    });
    expect(bodyRows(table)).toHaveLength(10);
    fireEvent.click(within(page).getByRole("button", { name: "搜索" }));
    expect(bodyRows(table)).toHaveLength(1);
    expect(bodyRows(table)[0]).toHaveTextContent(target.title);
    expect(within(page).getByRole("button", { name: "上一页" })).toBeDisabled();

    view.rerender(
      <div className="helplook-preview">
        <AnalyticsWorkspace module="traffic-sources" onNavigate={vi.fn()} />
      </div>,
    );
    view.rerender(
      <div className="helplook-preview">
        <AnalyticsWorkspace module="articles" onNavigate={vi.fn()} />
      </div>,
    );
    expect(screen.getByLabelText("文章关键词")).toHaveValue(target.title);
    expect(
      bodyRows(screen.getByRole("table", { name: "文章统计" })),
    ).toHaveLength(1);
  });

  it("sorts article counts and exports the selected records rather than the full table", async () => {
    mount("articles");
    const page = screen.getByRole("region", { name: "文章分析" });
    const table = within(page).getByRole("table", { name: "文章统计" });
    const sorted = articleRows(INITIAL_PERIOD).sort((a, b) => b.pv - a.pv);
    fireEvent.click(
      within(page).getByRole("button", { name: "浏览数（PV）排序" }),
    );
    expect(bodyRows(table)[0]).toHaveTextContent(sorted[0].title);
    fireEvent.click(within(page).getByRole("button", { name: "导出" }));
    expect(screen.getByRole("button", { name: "导出选中数据" })).toBeDisabled();
    fireEvent.keyDown(screen.getByRole("button", { name: "导出全部" }), {
      key: "Escape",
    });
    await waitFor(() =>
      expect(
        screen.queryByRole("button", { name: "导出选中数据" }),
      ).not.toBeInTheDocument(),
    );
    fireEvent.click(
      within(page).getByRole("checkbox", {
        name: `选择文章 ${sorted[0].title}`,
      }),
    );
    expect(
      within(page).getByRole("checkbox", { name: "全选本页文章" }),
    ).toHaveAttribute("aria-checked", "mixed");
    fireEvent.click(within(page).getByRole("button", { name: "导出" }));
    fireEvent.click(screen.getByRole("button", { name: "导出选中数据" }));
    expect(downloadCsv).toHaveBeenCalledOnce();
    expect(vi.mocked(downloadCsv).mock.calls[0][2]).toHaveLength(1);
    expect(vi.mocked(downloadCsv).mock.calls[0][2][0][0]).toBe(sorted[0].title);
    fireEvent.click(
      within(page).getByRole("button", { name: "浏览数（PV）排序" }),
    );
    expect(bodyRows(table)[0]).toHaveTextContent(sorted.at(-1)!.title);
  });

  it("applies the date picker to the article records", async () => {
    mount("articles");
    const page = screen.getByRole("region", { name: "文章分析" });
    fireEvent.click(within(page).getByRole("button", { name: "日期范围" }));
    fireEvent.click(screen.getByRole("button", { name: "最近7天" }));
    const recent = articleRows({ ...INITIAL_PERIOD, from: "2026-08-31" });
    await waitFor(() =>
      expect(
        within(page).getByText(`共 ${recent.length} 条`),
      ).toBeInTheDocument(),
    );
    expect(
      within(page).getByRole("button", { name: "日期范围" }),
    ).toHaveTextContent(/2026[-—]08[-—]31/);
  });

  it("binds the QA filters, detail answer and citation to the same record and restores focus", async () => {
    mount("ai-qa");
    const page = screen.getByRole("region", { name: "AI问答分析" });
    const target = QA_RECORDS.find(
      (record) => record.answer && record.sources.length,
    )!;
    fireEvent.change(within(page).getByLabelText("提问者"), {
      target: { value: target.asker },
    });
    fireEvent.change(within(page).getByLabelText("会话ID"), {
      target: { value: target.sessionId },
    });
    fireEvent.change(within(page).getByLabelText("问题"), {
      target: { value: target.question },
    });
    fireEvent.click(within(page).getByRole("button", { name: "搜索" }));
    expect(
      bodyRows(within(page).getByRole("table", { name: "AI问答记录" })),
    ).toHaveLength(1);
    const trigger = within(page).getByRole("button", { name: "查看" });
    trigger.focus();
    fireEvent.click(trigger);
    const dialog = screen.getByRole("dialog", { name: "详情" });
    expect(dialog).toHaveTextContent(target.question);
    for (const paragraph of target.answer.split(/\n+/).filter(Boolean)) {
      expect(dialog).toHaveTextContent(paragraph);
    }
    for (const source of target.sources)
      expect(
        within(dialog).getByRole("complementary", { name: "当前回答来源" }),
      ).toHaveTextContent(source.title);
    fireEvent.click(within(dialog).getByRole("button", { name: "关闭" }));
    await waitFor(() =>
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument(),
    );
    await waitFor(() => expect(trigger).toHaveFocus());
    expect(within(page).getByLabelText("会话ID")).toHaveValue(target.sessionId);
  });

  it("rejects reversed QA dates and renders a real no-match result", () => {
    mount("ai-qa");
    const page = screen.getByRole("region", { name: "AI问答分析" });
    fireEvent.change(within(page).getByLabelText("问答开始时间"), {
      target: { value: "2026-09-06" },
    });
    fireEvent.change(within(page).getByLabelText("问答结束时间"), {
      target: { value: "2026-08-07" },
    });
    fireEvent.click(within(page).getByRole("button", { name: "搜索" }));
    expect(within(page).getByRole("alert")).toHaveTextContent(
      "开始时间不能晚于结束时间",
    );
    fireEvent.change(within(page).getByLabelText("问答开始时间"), {
      target: { value: "2025-01-01" },
    });
    fireEvent.change(within(page).getByLabelText("问答结束时间"), {
      target: { value: "2025-01-02" },
    });
    fireEvent.click(within(page).getByRole("button", { name: "搜索" }));
    expect(within(page).queryByRole("alert")).not.toBeInTheDocument();
    expect(
      within(page).getByRole("table", { name: "AI问答记录" }),
    ).toHaveTextContent("暂无数据");
    expect(within(page).getByText("共 0 条")).toBeInTheDocument();
  });

  it("filters traffic without renormalizing a single matching source to 100%", () => {
    mount("traffic-sources");
    const page = screen.getByRole("region", { name: "流量来源分析" });
    const sources = trafficRows(INITIAL_PERIOD);
    const target = sources.find(
      (source) => source.website === "https://docs.example.com/",
    )!;
    const ratio = (
      (target.clicks /
        sources.reduce((sum, source) => sum + source.clicks, 0)) *
      100
    ).toFixed(2);
    fireEvent.change(within(page).getByLabelText("网站关键词"), {
      target: { value: target.website },
    });
    fireEvent.click(within(page).getByRole("button", { name: "搜索" }));
    const rows = bodyRows(
      within(page).getByRole("table", { name: "流量来源统计" }),
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toHaveTextContent(`${ratio}%`);
    expect(rows[0]).not.toHaveTextContent("100.00%");
  });

  it("links overview summaries locally and changes the chart grouping", () => {
    const navigate = vi.fn();
    mount("overview", navigate);
    const page = screen.getByRole("region", { name: "概览分析" });
    fireEvent.click(within(page).getByRole("button", { name: "月" }));
    expect(
      within(page).getByLabelText("按月统计的访问趋势"),
    ).toBeInTheDocument();
    const links = within(page).getAllByRole("button", { name: "查看更多" });
    fireEvent.click(links[0]);
    expect(navigate).toHaveBeenCalledWith("articles");
    fireEvent.click(links[1]);
    expect(within(page).getByRole("status")).toHaveTextContent(
      "暂不提供独立的搜索明细页面",
    );
    fireEvent.click(links[2]);
    expect(navigate).toHaveBeenCalledWith("traffic-sources");
  });

  it("unmounts the chart when the analytics group is inactive while retaining its period", () => {
    const view = mount("overview");
    const page = screen.getByRole("region", { name: "概览分析" });
    fireEvent.click(within(page).getByRole("button", { name: "月" }));
    expect(screen.getByTestId("trend-chart")).toBeInTheDocument();
    view.rerender(
      <div className="helplook-preview">
        <AnalyticsWorkspace
          module="overview"
          active={false}
          onNavigate={vi.fn()}
        />
      </div>,
    );
    expect(screen.queryByTestId("trend-chart")).not.toBeInTheDocument();
    view.rerender(
      <div className="helplook-preview">
        <AnalyticsWorkspace module="overview" active onNavigate={vi.fn()} />
      </div>,
    );
    expect(screen.getByTestId("trend-chart")).toBeInTheDocument();
    expect(screen.getByLabelText("按月统计的访问趋势")).toBeInTheDocument();
  });

  it("dismisses calendar and export portals when navigating away without resetting filters", async () => {
    const view = mount("articles");
    const page = screen.getByRole("region", { name: "文章分析" });
    fireEvent.change(within(page).getByLabelText("文章关键词"), {
      target: { value: "权限" },
    });
    fireEvent.click(within(page).getByRole("button", { name: "日期范围" }));
    expect(screen.getByRole("button", { name: "最近7天" })).toBeInTheDocument();
    view.rerender(
      <div className="helplook-preview">
        <AnalyticsWorkspace module="ai-qa" onNavigate={vi.fn()} />
      </div>,
    );
    await waitFor(() =>
      expect(
        screen.queryByRole("button", { name: "最近7天" }),
      ).not.toBeInTheDocument(),
    );
    fireEvent.click(screen.getByRole("button", { name: "导出" }));
    expect(
      screen.getByRole("button", { name: "导出全部" }),
    ).toBeInTheDocument();
    view.rerender(
      <div className="helplook-preview">
        <AnalyticsWorkspace
          module="ai-qa"
          active={false}
          onNavigate={vi.fn()}
        />
      </div>,
    );
    await waitFor(() =>
      expect(
        screen.queryByRole("button", { name: "导出全部" }),
      ).not.toBeInTheDocument(),
    );
    view.rerender(
      <div className="helplook-preview">
        <AnalyticsWorkspace module="articles" active onNavigate={vi.fn()} />
      </div>,
    );
    expect(screen.getByLabelText("文章关键词")).toHaveValue("权限");
  });
});
