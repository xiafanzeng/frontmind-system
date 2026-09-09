import { fireEvent, render, screen, within } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import { BusinessWorkspaceProvider } from "./BusinessWorkspaceContext";
import { EnterpriseProgressReport } from "./EnterpriseMonitoringWorkspace";
vi.mock("@/lib/trpc", () => ({
  trpc: {
    enterpriseProjects: {
      monitoringProgress: {
        useQuery: () => ({
          dataUpdatedAt: 1000,
          data: {
            summary: {
              projectCount: 1,
              runCount: 25,
              completedAttempts: 25,
              failedAttempts: 0,
            },
            projects: [{ id: "project-1", name: "企业监控" }],
            runs: Array.from({ length: 25 }, (_, index) => ({
              id: `run-${index}`,
              projectId: "project-1",
              status: "succeeded",
              createdAt: 1000 + index,
              expectedAttempts: 1,
              completedAttempts: 1,
              failedAttempts: 0,
            })),
          },
        }),
      },
    },
  },
}));
vi.mock("@/monitoring/Workspace", () => ({
  default: () => <p>监控</p>,
  MonitoringRunPanel: ({ runId }: { runId: string }) => (
    <p>读取真实运行 {runId}</p>
  ),
}));
it("pages live runs and expands the selected owned run in the main flow", async () => {
  const saveState = vi.fn(async (_patch: unknown) => undefined);
  render(
    <BusinessWorkspaceProvider
      value={{
        isWorkbench: true,
        agentId: "reports",
        taskId: "report-task",
        task: { saveState, state: null } as any,
        setSummary: () => undefined,
      }}
    >
      <EnterpriseProgressReport enterpriseProjectId="enterprise-project" />
    </BusinessWorkspaceProvider>,
  );
  expect(screen.getAllByRole("row")).toHaveLength(21);
  expect(saveState).not.toHaveBeenCalled();
  fireEvent.click(screen.getAllByRole("button", { name: "展开分析" })[0]);
  const expanded = screen.getByRole("region", { name: "选中运行的完整分析" });
  expect(
    await within(expanded).findByText("读取真实运行 run-0"),
  ).toBeInTheDocument();
  expect(saveState).toHaveBeenCalledWith({ values: { reportRunId: "run-0" } });
  fireEvent.click(screen.getByRole("button", { name: "下一页" }));
  expect(screen.getAllByRole("row")).toHaveLength(6);
});
