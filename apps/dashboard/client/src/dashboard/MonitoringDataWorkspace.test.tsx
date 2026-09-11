import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({
  samples: vi.fn(),
  citations: vi.fn(),
  exportSamples: vi.fn(),
  exportFilters: vi.fn(),
  exportCitations: vi.fn(),
  createUrl: vi.fn((_blob: Blob) => "blob:export"),
}));
vi.mock("@/lib/trpc", () => ({
  trpc: {
    useUtils: () => ({
      workspace: {
        monitoring: {
          filters: { fetch: mocks.exportFilters },
          samples: { fetch: mocks.exportSamples },
          citations: { fetch: mocks.exportCitations },
        },
      },
    }),
    workspace: {
      monitoring: {
        filters: {
          useQuery: () => ({
            data: {
              batches: [
                { batchKey: "batch", sourceName: "真实批次", revision: 2 },
              ],
              questions: [],
              models: ["豆包"],
            },
          }),
        },
        samples: { useQuery: mocks.samples },
        citations: { useQuery: mocks.citations },
      },
    },
  },
}));
vi.mock("@/components/MarkdownRenderer", () => ({
  default: ({ content }: { content: string }) => <p>{content}</p>,
}));
import MonitoringDataWorkspace from "./MonitoringDataWorkspace";
beforeEach(() => {
  vi.clearAllMocks();
  window.history.replaceState(
    {},
    "",
    "/monitoring-system?monitoringBatchKey=batch&monitoringBatchRevision=1",
  );
  mocks.samples.mockReturnValue({
    data: {
      items: [
        {
          id: "sample",
          sourceRecordId: "source",
          batchKey: "batch",
          questionId: "question",
          question: "测试问题",
          content: "完整回答内容",
          platform: "豆包",
          collectedDate: "2026-09-10",
          batchRevision: 2,
          citationCount: 5,
          monitorRank: null,
        },
      ],
      total: 101,
      totals: { rankedSampleCount: 60, top3SampleCount: 20, averageRank: 4.5 },
    },
  });
  mocks.citations.mockReturnValue({ data: { items: [], total: 0 } });
  mocks.exportSamples.mockImplementation(async ({ page }) => ({
    items: Array.from({ length: page === 1 ? 100 : 1 }, () => ({
      content: "回答",
    })),
    total: 101,
  }));
  mocks.exportFilters.mockResolvedValue({ batches: [{ batchKey: "batch", revision: 2 }] });
  mocks.exportCitations.mockResolvedValue({ items: [], total: 0 });
  vi.stubGlobal("URL", URL);
  URL.createObjectURL = mocks.createUrl;
  URL.revokeObjectURL = vi.fn();
  vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
});
describe("persisted monitoring results", () => {
  it("shows whole-scope totals, missing rank, and current revision without claiming old body history", () => {
    render(<MonitoringDataWorkspace enterpriseProjectId="project" />);
    const totals = screen.getByText("有效回答").closest("div")!;
    expect(totals).toHaveTextContent("101");
    expect(screen.getByText("平均排名").closest("div")).toHaveTextContent("4.5");
    expect(screen.getByText(/工作记录对应 R1，批次已更新/)).toBeInTheDocument();
    expect(screen.getByText(/排名：暂无数据/)).toBeInTheDocument();
    expect(screen.getByText("完整回答内容")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "查看详情" }));
    expect(mocks.citations).toHaveBeenLastCalledWith(
      expect.objectContaining({
        sampleId: "sample",
        batchKey: "batch",
        questionId: "question",
      }),
      { enabled: true },
    );
  });
  it("exports every page using the displayed batch filter", async () => {
    render(<MonitoringDataWorkspace enterpriseProjectId="project" />);
    fireEvent.click(
      screen.getByRole("button", { name: "导出当前范围全部结果" }),
    );
    await waitFor(() => expect(mocks.createUrl).toHaveBeenCalled());
    expect(mocks.exportSamples).toHaveBeenCalledTimes(2);
    expect(mocks.exportSamples).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ batchKey: "batch", page: 2, pageSize: 100 }),
    );
    const blob = mocks.createUrl.mock.calls[0]?.[0] as Blob;
    expect(blob.size).toBeGreaterThan(1000);
  });
  it("rejects an export if a batch revision changes between pages", async () => {
    mocks.exportFilters.mockResolvedValueOnce({ batches: [{ batchKey: "batch", revision: 2 }] }).mockResolvedValueOnce({ batches: [{ batchKey: "batch", revision: 3 }] });
    render(<MonitoringDataWorkspace enterpriseProjectId="project" />);
    fireEvent.click(screen.getByRole("button", { name: "导出当前范围全部结果" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("导出期间监控批次已变化");
    expect(mocks.createUrl).not.toHaveBeenCalled();
  });
});
