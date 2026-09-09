import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { MonitorRun } from "../domain";
import RunDetailPage from "./RunDetailPage";

const run: MonitorRun = {
  id: "run-local",
  monitorId: "monitor-local",
  monitorName: "本地运行分析",
  status: "running",
  trigger: "manual",
  version: 2,
  createdAt: "2026-09-09T10:00:00Z",
  metrics: {
    expected: 1,
    queued: 1,
    processing: 0,
    completed: 0,
    failed: 0,
    stopped: 0,
    citations: 0,
    uniqueDomains: 0,
    sentiment: { positive: 0, neutral: 0, negative: 0, unknown: 0 },
  },
  attempts: [],
  config: {
    brandName: "本地企业",
    brandAliases: [],
    competitors: [],
    questions: ["本地验收问题？"],
    platforms: [],
    repetitions: 1,
    screenshotPolicy: 0,
    regionLabel: "默认地区",
  },
};

afterEach(() => vi.restoreAllMocks());

it("tracks the visible report section after its inline directory scrolls out of view", async () => {
  const positions: Record<string, number> = {
    overview: -600,
    progress: -300,
    answers: 100,
    snapshot: 500,
    citations: 900,
    signals: 1200,
    trend: 1600,
  };
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(
    function (this: HTMLElement) {
      const top = this.classList.contains("agent-workbench-shell__main-content")
        ? 80
        : this.classList.contains("anchor-nav")
          ? -200
          : (positions[this.id] ?? 0);
      return new DOMRect(0, top, 600, 40);
    },
  );
  const view = render(
    <div
      className="agent-workbench-shell__main-content"
      style={{ overflowY: "auto" }}
    >
      <RunDetailPage run={run} embedded onCancel={vi.fn()} />
    </div>,
  );
  const viewport = view.container.firstElementChild as HTMLElement;
  Object.defineProperties(viewport, {
    clientHeight: { value: 600 },
    scrollHeight: { value: 2500 },
    scrollTop: { value: 850 },
  });
  fireEvent.scroll(viewport);
  await waitFor(() =>
    expect(screen.getByRole("button", { name: "问答明细" })).toHaveAttribute(
      "aria-current",
      "location",
    ),
  );
  expect(screen.getByRole("link", { name: "导出 XLSX" })).toHaveAttribute(
    "href",
    "/api/monitoring/downloads/runs/run-local.xlsx",
  );
});

it("retains the expanded run and permits retry when stopping a running report fails", async () => {
  vi.spyOn(window, "confirm").mockReturnValue(true);
  const cancel = vi
    .fn()
    .mockRejectedValueOnce(new Error("暂时无法停止"))
    .mockResolvedValueOnce(undefined);
  render(<RunDetailPage run={run} embedded onCancel={cancel} />);
  fireEvent.click(screen.getByRole("button", { name: "尝试停止" }));
  expect(await screen.findByRole("alert")).toHaveTextContent("暂时无法停止");
  expect(screen.getByRole("heading", { name: "本地运行分析" })).toBeVisible();
  fireEvent.click(screen.getByRole("button", { name: "尝试停止" }));
  await waitFor(() => expect(cancel).toHaveBeenCalledTimes(2));
  expect(screen.queryByRole("alert")).not.toBeInTheDocument();
});
