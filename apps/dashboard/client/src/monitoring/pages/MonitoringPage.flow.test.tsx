import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { BusinessWorkspaceProvider } from "@/dashboard/BusinessWorkspaceContext";
vi.mock("../features/monitoring/MonitoringWorkspace", () => ({
  default: ({ monitors, onRun, onAdd }: any) => (
    <div>
      <button onClick={() => onRun(monitors[0])}>准备监控执行</button>
      <button onClick={onAdd}>新建监控配置</button>
    </div>
  ),
}));
vi.mock("../Workspace", () => ({
  MonitoringRunPanel: ({ runId }: any) => <p>真实运行 {runId}</p>,
}));
import MonitoringPage from "./MonitoringPage";
const project: any = {
  id: "project",
  name: "企业监控",
  brandName: "品牌",
  brandAliases: [],
  competitors: [],
  timezone: "Asia/Shanghai",
};
const monitor: any = {
  id: "monitor",
  name: "品牌问题",
  questionsCount: 2,
  platformsCount: 1,
  repetitions: 1,
  scheduleLabel: "手动执行",
  status: "active",
};
function fixture(quote: ReturnType<typeof vi.fn>) {
  const run = vi.fn(async () => ({ runId: "run-1" }));
  const saveState = vi.fn(async () => undefined);
  render(
    <BusinessWorkspaceProvider
      value={{
        isWorkbench: true,
        agentId: "monitoring",
        taskId: "task",
        task: {
          scopeKey: "scope:monitoring",
          ensureTask: async () => "task",
          saveState,
          state: null,
        } as any,
        setSummary: () => {},
      }}
    >
      <MonitoringPage
        project={project}
        monitors={[monitor]}
        models={[]}
        availableBalanceTenThousandths="100000"
        quoteRunCost={vi.fn()}
        quoteMonitorRunCost={quote}
        onCreateProject={vi.fn()}
        onSaveMonitor={vi.fn()}
        onRunMonitor={run}
        onToggleMonitor={vi.fn()}
        onDeleteMonitor={vi.fn()}
      />
    </BusinessWorkspaceProvider>,
  );
  return { run, saveState };
}
describe("inline monitoring cost confirmation", () => {
  it("waits for the real quote and explicit fee confirmation, then expands the actual run", async () => {
    const quote = vi.fn(async () => ({ totalAmountTenThousandths: "900" }));
    const { run, saveState } = fixture(quote);
    fireEvent.click(screen.getByRole("button", { name: "准备监控执行" }));
    const fees = await screen.findByRole("region", { name: "确认立即执行" });
    await waitFor(() =>
      expect(
        within(fees).getByRole("button", { name: "确认执行" }),
      ).toBeEnabled(),
    );
    expect(quote).toHaveBeenCalledWith("monitor");
    expect(run).not.toHaveBeenCalled();
    expect(screen.queryByRole("dialog")).toBeNull();
    fireEvent.click(within(fees).getByRole("button", { name: "确认执行" }));
    expect(await screen.findByText("真实运行 run-1")).toBeVisible();
    expect(run).toHaveBeenCalledTimes(1);
    expect(saveState).toHaveBeenCalledWith(
      expect.objectContaining({
        outputRefs: expect.arrayContaining([
          {
            resource: { kind: "monitoring_run", id: "run-1" },
            sourceStepId: "monitoring-running",
          },
        ]),
      }),
      { scopeKey: "scope:monitoring", conversationId: "task" },
    );
  });
  it("keeps quote failures in the same fee step and allows an explicit retry", async () => {
    const quote = vi
      .fn()
      .mockRejectedValueOnce(new Error("unavailable"))
      .mockResolvedValueOnce({ totalAmountTenThousandths: "900" });
    const { run } = fixture(quote);
    fireEvent.click(screen.getByRole("button", { name: "准备监控执行" }));
    const retry = await screen.findByRole("button", { name: "重新估算费用" });
    expect(screen.getByRole("button", { name: "确认执行" })).toBeDisabled();
    fireEvent.click(retry);
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "确认执行" })).toBeEnabled(),
    );
    expect(quote).toHaveBeenCalledTimes(2);
    expect(run).not.toHaveBeenCalled();
  });
});
