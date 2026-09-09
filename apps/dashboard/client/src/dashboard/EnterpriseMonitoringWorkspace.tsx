import {
  useBusinessFlowState,
  readFlowString,
  readFlowStringArray,
  readFlowBoolean,
} from "./useBusinessFlowState";
import { lazy, Suspense, useEffect, useRef, useState } from "react";
import { Plus, Search, X } from "lucide-react";
import { navigate } from "wouter/use-browser-location";
import { trpc } from "@/lib/trpc";
import { projectWorkspaceUrl } from "@/lib/enterprise-project";
import {
  useBusinessWorkspace,
  useBusinessWorkspaceSummary,
} from "./BusinessWorkspaceContext";
import type { PurchasedServiceQuestion } from "./service-portal";
import "./business-module-flows.css";

const MonitoringModule = lazy(() => import("@/monitoring/Workspace"));
const MonitoringRunPanel = lazy(() =>
  import("@/monitoring/Workspace").then((module) => ({
    default: module.MonitoringRunPanel,
  })),
);

export function EnterpriseMonitoringWorkspace({
  enterpriseProjectId,
  questions,
}: {
  enterpriseProjectId: string;
  questions: PurchasedServiceQuestion[];
}) {
  const { isWorkbench, task } = useBusinessWorkspace();
  const progress = trpc.enterpriseProjects.monitoringProgress.useQuery({
    enterpriseProjectId,
  });
  const create = trpc.enterpriseProjects.createMonitoringProject.useMutation();
  const [open, setOpen] = useBusinessFlowState(
    "monitorCreateOpen",
    false,
    readFlowBoolean,
  );
  const [name, setName] = useBusinessFlowState(
    "monitorName",
    "",
    readFlowString,
  );
  const [selected, setSelected] = useBusinessFlowState(
    "monitorQuestions",
    [] as string[],
    readFlowStringArray,
  );
  const [error, setError] = useState("");
  const intent = useRef<{ fingerprint: string; id: string } | undefined>(
    undefined,
  );
  useEffect(() => {
    setError("");
    intent.current = undefined;
  }, [enterpriseProjectId]);
  useBusinessWorkspaceSummary({
    items: [
      {
        label: "当前步骤",
        value: open ? "选择问题与建立监控" : "监控任务与运行",
      },
      { label: "已选问题", value: `${selected.length} 个` },
      {
        label: "监控项目",
        value: `${progress.data?.summary.projectCount ?? 0} 个`,
      },
    ],
  });
  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!name.trim() || !selected.length || create.isPending) return;
    const fingerprint = JSON.stringify([
      enterpriseProjectId,
      name.trim(),
      [...selected].sort(),
    ]);
    if (intent.current?.fingerprint !== fingerprint)
      intent.current = { fingerprint, id: crypto.randomUUID() };
    setError("");
    try {
      const workbenchTaskId =
        isWorkbench && task ? await task.ensureTask() : null;
      if (isWorkbench && task)
        await task.saveState({
          step: "monitoring-project-creating",
          resources: selected.map((id) => ({ kind: "question", id })),
          record: {
            id: intent.current.id,
            label: "从优化问题创建监控项目",
            status: "pending",
          },
        });
      const result = await create.mutateAsync({
        enterpriseProjectId,
        name: name.trim(),
        questionIds: selected,
        clientRequestId: intent.current.id,
      });
      if (isWorkbench && task)
        await task.saveState({
          step: "monitoring-configure",
          values: { monitoringProjectId: result.projectId },
          record: {
            id: intent.current.id,
            label: "已创建监控项目",
            status: "completed",
          },
        });
      navigate(
        projectWorkspaceUrl(
          `/monitoring-system?project=${result.projectId}&newMonitor=1${workbenchTaskId ? `&workbenchTask=${encodeURIComponent(workbenchTaskId)}` : ""}`,
          enterpriseProjectId,
        ),
      );
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : "监控项目未能创建，请重试。",
      );
    }
  };
  const sources = Object.fromEntries(
    (progress.data?.projects || []).map((project) => [
      project.id,
      (project.sourceQuestions || []).map((item) => item.question),
    ]),
  );
  return (
    <div className="business-monitoring-flow">
      <div className="business-flow-intro">
        <p>选择已有监控继续查看，或从优化问题开始一次新的监控。</p>
        <button
          className="operator-primary-button"
          onClick={() => {
            setError("");
            setOpen((value) => !value);
          }}
          aria-expanded={open}
        >
          <Plus size={16} />
          从优化问题新建
        </button>
      </div>
      {open && (
        <section
          className="business-inline-step"
          aria-label="从优化问题创建监控项目"
        >
          <div className="business-inline-step-heading">
            <h3>选择本次要监控的问题</h3>
            <button
              aria-label="收起新建监控"
              onClick={() => setOpen(false)}
              disabled={create.isPending}
            >
              <X size={16} />
            </button>
          </div>
          <p>本次保存的问题版本将用于监控，后续修改不会改写历史运行。</p>
          <form onSubmit={submit} className="grid gap-4">
            <label className="grid gap-2 text-sm">
              监控项目名称
              <input
                className="rounded-lg border p-3"
                maxLength={120}
                value={name}
                onChange={(event) => setName(event.target.value)}
                required
              />
            </label>
            <fieldset className="max-h-80 overflow-auto rounded-lg border p-3">
              <legend className="px-2 text-sm">
                优化问题 · 已选 {selected.length}
              </legend>
              {questions.length ? (
                questions.map((question) => (
                  <label
                    key={question.id}
                    className="flex items-start gap-3 py-2 text-sm"
                  >
                    <input
                      type="checkbox"
                      checked={selected.includes(question.id)}
                      onChange={(event) =>
                        setSelected((value) =>
                          event.target.checked
                            ? [...value, question.id]
                            : value.filter((id) => id !== question.id),
                        )
                      }
                      className="mt-1"
                    />
                    <span>{question.question}</span>
                  </label>
                ))
              ) : (
                <p className="py-3 text-sm text-muted-foreground">
                  先在“意图优化 → 优化问题”中保存要监控的问题。
                </p>
              )}
            </fieldset>
            {error && (
              <p role="alert" className="text-sm text-red-700">
                {error}
              </p>
            )}
            <button
              className="operator-primary-button justify-self-start"
              disabled={
                create.isPending ||
                !name.trim() ||
                !selected.length ||
                selected.length > 500
              }
            >
              {create.isPending ? "正在创建…" : "继续设置监控"}
            </button>
          </form>
        </section>
      )}
      <Suspense
        fallback={
          <div role="status" className="p-8">
            正在读取监控工作台…
          </div>
        }
      >
        <MonitoringModule questionSources={sources} />
      </Suspense>
    </div>
  );
}

const runStatus: Record<string, string> = {
  queued: "等待执行",
  running: "执行中",
  completed: "已完成",
  succeeded: "已完成",
  failed: "失败",
  partial: "部分完成",
  cancelled: "已取消",
  waiting_quota: "等待充值",
};
const REPORT_PAGE_SIZE = 20;
export function EnterpriseProgressReport({
  enterpriseProjectId,
  historical,
}: {
  enterpriseProjectId: string;
  historical?: React.ReactNode;
}) {
  const progress = trpc.enterpriseProjects.monitoringProgress.useQuery(
    { enterpriseProjectId },
    { refetchInterval: 10_000 },
  );
  const [selectedRunId, setSelectedRunId] = useBusinessFlowState<string | null>(
    "reportRunId",
    null,
    (value) =>
      value === null || typeof value === "string" ? value : undefined,
  );
  const [search, setSearch] = useBusinessFlowState(
    "reportSearch",
    "",
    readFlowString,
  );
  const [page, setPage] = useState(0);
  useEffect(() => {
    setPage(0);
  }, [enterpriseProjectId]);
  const selectedRun = progress.data?.runs.find(
    (run) => run.id === selectedRunId,
  );
  const projectName = (projectId: string) =>
    progress.data?.projects.find((project) => project.id === projectId)?.name ||
    "监控项目";
  const visibleRuns = (progress.data?.runs ?? []).filter((run) =>
    `${projectName(run.projectId)} ${runStatus[run.status] || run.status}`.includes(
      search.trim(),
    ),
  );
  const pageCount = Math.max(
    1,
    Math.ceil(visibleRuns.length / REPORT_PAGE_SIZE),
  );
  const currentPage = Math.min(page, pageCount - 1);
  useBusinessWorkspaceSummary({
    items: [
      { label: "分析范围", value: "当前项目最近 200 次运行" },
      {
        label: "选中运行",
        value: selectedRun
          ? `${projectName(selectedRun.projectId)} · ${runStatus[selectedRun.status] || selectedRun.status}`
          : "尚未选择",
      },
      {
        label: "更新时间",
        value: progress.dataUpdatedAt
          ? new Date(progress.dataUpdatedAt).toLocaleTimeString("zh-CN")
          : "等待读取",
      },
    ],
    status: progress.error ? "读取失败" : undefined,
  });
  return (
    <section className="page-shell operator-progress-report business-report-flow">
      <p className="business-flow-description">
        当前企业项目最近 200
        次真实监控运行。选择记录后，在下方展开指标、回答、引用与品牌对比。
      </p>
      {progress.isLoading ? (
        <p role="status">正在读取运行结果…</p>
      ) : progress.error ? (
        <div role="alert">
          <p>{progress.error.message}</p>
          <button
            className="operator-primary-button"
            onClick={() => void progress.refetch()}
          >
            重新读取
          </button>
        </div>
      ) : (
        <>
          <div className="operator-progress-stats">
            {[
              ["监控项目", progress.data?.summary.projectCount],
              ["运行次数", progress.data?.summary.runCount],
              ["已完成尝试", progress.data?.summary.completedAttempts],
              ["失败尝试", progress.data?.summary.failedAttempts],
            ].map(([label, value]) => (
              <div key={label}>
                <span>{label}</span>
                <strong>{value ?? 0}</strong>
              </div>
            ))}
          </div>
          <label className="business-flow-search">
            <Search size={16} />
            <input
              type="search"
              aria-label="搜索监控运行"
              placeholder="搜索监控项目或运行状态"
              value={search}
              onChange={(event) => {
                setSearch(event.target.value);
                setPage(0);
              }}
            />
          </label>
          {visibleRuns.length ? (
            <>
              <div className="overflow-x-auto">
                <table className="operator-run-table">
                  <thead>
                    <tr>
                      <th>监控项目</th>
                      <th>发起时间</th>
                      <th>状态</th>
                      <th>执行进度</th>
                      <th>结果</th>
                    </tr>
                  </thead>
                  <tbody>
                    {visibleRuns
                      .slice(
                        currentPage * REPORT_PAGE_SIZE,
                        (currentPage + 1) * REPORT_PAGE_SIZE,
                      )
                      .map((run) => (
                        <tr
                          key={run.id}
                          aria-selected={selectedRunId === run.id}
                        >
                          <td>{projectName(run.projectId)}</td>
                          <td>
                            {new Date(run.createdAt).toLocaleString("zh-CN")}
                          </td>
                          <td>{runStatus[run.status] || run.status}</td>
                          <td>
                            {run.completedAttempts + run.failedAttempts} /{" "}
                            {run.expectedAttempts}
                          </td>
                          <td>
                            <button
                              type="button"
                              className="business-flow-text-action"
                              onClick={() => setSelectedRunId(run.id)}
                            >
                              {selectedRunId === run.id
                                ? "正在查看"
                                : "展开分析"}
                            </button>
                          </td>
                        </tr>
                      ))}
                  </tbody>
                </table>
              </div>
              <nav
                className="business-flow-pagination"
                aria-label="监控运行分页"
              >
                <span>
                  {visibleRuns.length} 次运行 · {currentPage + 1} / {pageCount}
                </span>
                <button
                  disabled={currentPage === 0}
                  onClick={() => setPage(currentPage - 1)}
                >
                  上一页
                </button>
                <button
                  disabled={currentPage + 1 >= pageCount}
                  onClick={() => setPage(currentPage + 1)}
                >
                  下一页
                </button>
              </nav>
            </>
          ) : (
            <p className="business-flow-empty">
              {search
                ? "没有符合搜索条件的运行，请调整关键词。"
                : "尚无监控运行记录。创建监控项目并执行后，报告会在这里更新。"}
            </p>
          )}
        </>
      )}
      {selectedRun && (
        <section
          className="business-inline-step"
          aria-label="选中运行的完整分析"
        >
          <div className="business-inline-step-heading">
            <h3>运行分析 · {projectName(selectedRun.projectId)}</h3>
            <button
              type="button"
              onClick={() => setSelectedRunId(null)}
              aria-label="收起运行分析"
            >
              <X size={16} />
            </button>
          </div>
          <Suspense fallback={<p role="status">正在展开完整分析…</p>}>
            <MonitoringRunPanel key={selectedRun.id} runId={selectedRun.id} />
          </Suspense>
        </section>
      )}
      {historical && (
        <details className="business-inline-step">
          <summary>历史导入报告 · 导入来源</summary>
          {historical}
        </details>
      )}
    </section>
  );
}
