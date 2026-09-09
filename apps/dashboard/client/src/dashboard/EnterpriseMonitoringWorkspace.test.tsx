import { fireEvent, render, screen, within } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import { BusinessWorkspaceProvider } from "./BusinessWorkspaceContext";
import {
  EnterpriseMonitoringWorkspace,
  EnterpriseProgressReport,
} from "./EnterpriseMonitoringWorkspace";
const api = vi.hoisted(() => ({
  create: vi.fn(async () => ({ projectId: "created-project" })),
  refresh: vi.fn(),
}));
vi.mock("@/lib/trpc", () => ({
  trpc: {
    enterpriseProjects: {
      createMonitoringProject: {
        useMutation: () => ({ mutateAsync: api.create, isPending: false }),
      },
      monitoringProgress: {
        useQuery: () => ({
          dataUpdatedAt: 1000,
          refetch: api.refresh,
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
  default: ({ selectedProjectId, createMonitorRequest, analysisOnly }: any) => (
    <output aria-label="内联监控模块">
      {selectedProjectId}:
      {createMonitorRequest
        ? "新建配置"
        : analysisOnly
          ? "趋势分析"
          : "已有监控"}
    </output>
  ),
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
  expect(document.querySelector(".business-report-flow")).not.toHaveClass("page-shell");
  expect(screen.queryByRole("table")).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: /查看单次运行/ }));
  expect(screen.getAllByRole("row")).toHaveLength(21);
  fireEvent.click(screen.getAllByRole("button", { name: "展开分析" })[0]);
  const expanded = screen.getByRole("region", { name: "选中运行的完整分析" });
  expect(
    await within(expanded).findByText("读取真实运行 run-0"),
  ).toBeInTheDocument();
  expect(saveState).toHaveBeenCalledWith({ values: { reportRunId: "run-0" } });
  fireEvent.click(screen.getByRole("button", { name: "下一页" }));
  expect(screen.getAllByRole("row")).toHaveLength(6);
});

it("creates a project and expands its configuration without changing routes", async () => {
  const before = window.location.href;
  const saveState = vi.fn(async () => undefined);
  render(
    <BusinessWorkspaceProvider
      value={{
        isWorkbench: true,
        agentId: "monitoring",
        taskId: "monitor-task",
        task: {
          scopeKey: "scope:monitoring",
          ensureTask: async () => "monitor-task",
          saveState,
          state: null,
        } as any,
        setSummary: () => undefined,
      }}
    >
      <EnterpriseMonitoringWorkspace
        enterpriseProjectId="enterprise-project"
        questions={[{ id: "question-1", question: "品牌适合谁？" } as any]}
      />
    </BusinessWorkspaceProvider>,
  );
  fireEvent.click(screen.getByRole("button", { name: "从优化问题新建" }));
  fireEvent.change(screen.getByLabelText("监控项目名称"), {
    target: { value: "品牌问题监控" },
  });
  fireEvent.click(screen.getByRole("checkbox"));
  fireEvent.click(screen.getByRole("button", { name: "继续设置监控" }));
  expect(await screen.findByLabelText("内联监控模块")).toHaveTextContent(
    "created-project:新建配置",
  );
  expect(
    screen.queryByRole("heading", { name: "这次想监控什么？" }),
  ).not.toBeInTheDocument();
  expect(window.location.href).toBe(before);
  expect(api.create).toHaveBeenCalledWith(
    expect.objectContaining({
      enterpriseProjectId: "enterprise-project",
      questionIds: ["question-1"],
    }),
  );
  expect(saveState).toHaveBeenCalledWith(
    expect.objectContaining({
      step: "monitoring-configure",
      outputRefs: [
        {
          resource: { kind: "monitoring_project", id: "created-project" },
          sourceStepId: "monitoring-project-created",
        },
      ],
    }),
    { scopeKey: "scope:monitoring", conversationId: "monitor-task" },
  );
});
it("expands trend and imported report branches with their real data ranges", async () => {
  render(
    <EnterpriseProgressReport
      enterpriseProjectId="enterprise-project"
      historical={<p>导入的历史资料</p>}
    />,
  );
  fireEvent.click(screen.getByRole("button", { name: /分析监控趋势/ }));
  expect(
    screen.getByRole("region", { name: "监控趋势分析" }),
  ).toHaveTextContent("最近 100 次运行");
  fireEvent.click(
    screen.getByRole("button", { name: /企业监控.*展开趋势分析/ }),
  );
  expect(await screen.findByLabelText("内联监控模块")).toHaveTextContent(
    "project-1:趋势分析",
  );
  fireEvent.click(screen.getByRole("button", { name: "返回修改" }));
  fireEvent.click(screen.getByRole("button", { name: /查看导入报告/ }));
  expect(
    screen.getByRole("region", { name: "历史导入报告" }),
  ).toHaveTextContent("导入的历史资料");
});

it("retains a created monitor when its task receipt fails and retries only the association", async () => {
  api.create.mockClear();
  let failed = false;
  const saveState = vi.fn(async (patch: any) => {
    if (patch.step === "monitoring-configure" && !failed) {
      failed = true;
      throw new Error("metadata connection interrupted");
    }
  });
  render(
    <BusinessWorkspaceProvider
      value={{
        isWorkbench: true,
        agentId: "monitoring",
        taskId: "monitor-outcome",
        task: {
          taskId: "monitor-outcome",
          scopeKey: "scope:monitor-outcome",
          ensureTask: async () => "monitor-outcome",
          saveState,
          retry: vi.fn(async () => undefined),
          state: null,
        } as any,
        setSummary: () => undefined,
      }}
    >
      <EnterpriseMonitoringWorkspace
        enterpriseProjectId="enterprise-project"
        questions={[{ id: "question-1", question: "品牌适合谁？" } as any]}
      />
    </BusinessWorkspaceProvider>,
  );
  fireEvent.click(screen.getByRole("button", { name: "从优化问题新建" }));
  fireEvent.change(screen.getByLabelText("监控项目名称"), {
    target: { value: "已创建项目" },
  });
  fireEvent.click(screen.getByRole("checkbox"));
  fireEvent.click(screen.getByRole("button", { name: "继续设置监控" }));
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "业务已保存，任务记录待同步",
  );
  expect(await screen.findByLabelText("内联监控模块")).toHaveTextContent(
    "created-project",
  );
  fireEvent.click(screen.getByRole("button", { name: "重新同步成果" }));
  await screen.findByLabelText("内联监控模块");
  expect(api.create).toHaveBeenCalledTimes(1);
});

it("restores a selected report without repeating its opening question", async () => {
  render(
    <BusinessWorkspaceProvider
      value={{
        isWorkbench: true,
        agentId: "reports",
        taskId: "saved-report",
        task: {
          state: { values: { reportRunId: "run-0" }, resources: [] },
          saveState: vi.fn(),
        } as any,
        setSummary: () => undefined,
      }}
    >
      <EnterpriseProgressReport enterpriseProjectId="enterprise-project" />
    </BusinessWorkspaceProvider>,
  );
  expect(
    screen.queryByRole("heading", { name: "这次想了解哪一类监控结果？" }),
  ).not.toBeInTheDocument();
  expect(await screen.findByText("读取真实运行 run-0")).toBeInTheDocument();
});
