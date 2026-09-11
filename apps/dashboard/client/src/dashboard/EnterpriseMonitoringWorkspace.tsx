import {
  useBusinessFlowState,
  readFlowString,
  readFlowStringArray,
  readFlowBoolean,
} from "./useBusinessFlowState";
import { lazy, Suspense, useEffect, useMemo, useRef, useState } from "react";
import { useSearch } from "wouter";
import { Search, X } from "lucide-react";
import { trpc } from "@/lib/trpc";
import {
  useBusinessWorkspace,
  useBusinessWorkspaceSummary,
} from "./BusinessWorkspaceContext";
import type { PurchasedServiceQuestion } from "./service-portal";
import {
  WorkflowCompleted,
  WorkflowPagination,
  WorkflowQuestion,
} from "./workflow/Workflow";
import { useOutcomeSync } from "./workflow/useOutcomeSync";
import "./business-module-flows.css";

const MonitoringModule = lazy(() => import("@/monitoring/Workspace"));
const MonitoringRunPanel = lazy(() =>
  import("@/monitoring/Workspace").then((module) => ({
    default: module.MonitoringRunPanel,
  })),
);

const MonitoringDataWorkspace = lazy(() => import("./MonitoringDataWorkspace"));
export function EnterpriseMonitoringWorkspace({ enterpriseProjectId, questions, onImportData }: { enterpriseProjectId: string; questions: PurchasedServiceQuestion[]; onImportData?: () => void }) {
  const search = useSearch();
  const [dataOpen, setDataOpen] = useState(() => new URLSearchParams(search).get("monitoringData") === "1");
  useEffect(() => setDataOpen(new URLSearchParams(search).get("monitoringData") === "1"), [search]);
  return <div className="enterprise-monitoring-workspace">
    {dataOpen ? <Suspense fallback={<p role="status">正在读取监控数据…</p>}><MonitoringDataWorkspace key={enterpriseProjectId} enterpriseProjectId={enterpriseProjectId} /></Suspense> : <AutomatedMonitoringWorkspace enterpriseProjectId={enterpriseProjectId} questions={questions} onImportData={onImportData} />}
  </div>;
}

function AutomatedMonitoringWorkspace({
  enterpriseProjectId,
  questions,
  onImportData,
}: {
  enterpriseProjectId: string;
  questions: PurchasedServiceQuestion[];
  onImportData?: () => void;
}) {
  const { isWorkbench, task } = useBusinessWorkspace();
  const outcome = useOutcomeSync();
  const progress = trpc.enterpriseProjects.monitoringProgress.useQuery({
    enterpriseProjectId,
  });
  const create = trpc.enterpriseProjects.createMonitoringProject.useMutation();
  const [storedOpen, setOpen] = useBusinessFlowState(
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
  const [storedProjectId, setSelectedProjectId] = useBusinessFlowState(
    "monitoringProjectId",
    new URLSearchParams(window.location.search).get("project") ??
      readFlowString(outcome.pending?.values?.monitoringProjectId) ??
      "",
    readFlowString,
  );
  const open =
    outcome.pending?.values?.monitorCreateOpen === false ? false : storedOpen;
  const selectedProjectId =
    readFlowString(outcome.pending?.values?.monitoringProjectId) ??
    storedProjectId;
  const deepLink = /^\/monitoring-system\/[^/]+(?:\/runs\/[^/]+)?$/.test(
    window.location.pathname,
  );
  const [showExisting, setShowExisting] = useBusinessFlowState(
    "monitorExistingOpen",
    false,
    readFlowBoolean,
  );
  const [createMonitorRequest, setCreateMonitorRequest] = useState<string>();
  const [projectSearch, setProjectSearch] = useState("");
  const [questionSearch, setQuestionSearch] = useState("");
  const [customQuestionsText, setCustomQuestionsText] = useState("");
  const [questionPage, setQuestionPage] = useState(0);
  const [projectPage, setProjectPage] = useState(0);
  const customQuestions = useMemo(
    () =>
      [
        ...new Set(
          customQuestionsText
            .split("\n")
            .map((line) => line.trim())
            .filter(Boolean),
        ),
      ].slice(0, 50),
    [customQuestionsText],
  );
  const [error, setError] = useState("");
  const intent = useRef<{ fingerprint: string; id: string } | undefined>(
    undefined,
  );
  useEffect(() => {
    setError("");
    intent.current = undefined;
  }, [enterpriseProjectId]);
  const selectedProject = progress.data?.projects.find(
    (project) => project.id === selectedProjectId,
  );
  useBusinessWorkspaceSummary({
    items: [
      {
        label: "当前步骤",
        value: open
          ? "选择问题与建立监控"
          : selectedProjectId
            ? "执行配置与运行"
            : "选择监控任务",
      },
      {
        label: "已保存来源问题",
        value: selectedProject
          ? `${selectedProject.sourceQuestions?.length ?? 0} 个`
          : selectedProjectId
            ? progress.error
              ? "读取失败"
              : progress.isLoading
                ? "正在读取已保存项目"
                : "等待同步已保存项目"
            : "尚未选择已保存项目",
      },
      {
        label: "监控项目",
        value: `${progress.data?.summary.projectCount ?? 0} 个`,
      },
    ],
    outputs: (progress.data?.projects ?? [])
      .filter(
        (project) =>
          project.id === selectedProjectId ||
          task?.state?.outputRefs?.some(
            (ref) =>
              ref.resource.kind === "monitoring_project" &&
              ref.resource.id === project.id,
          ),
      )
      .map((project) => ({
        id: project.id,
        title: project.name,
        type: "监控项目",
        status: "已保存",
        source: "当前企业项目",
        onOpen: () => {
          setSelectedProjectId(project.id);
          setOpen(false);
        },
      })),
  });
  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!name.trim() || (!selected.length && !customQuestions.length) || create.isPending) return;
    const fingerprint = JSON.stringify([
      enterpriseProjectId,
      name.trim(),
      [...selected].sort(),
      customQuestions,
    ]);
    if (intent.current?.fingerprint !== fingerprint)
      intent.current = { fingerprint, id: crypto.randomUUID() };
    const requestId = intent.current.id;
    setError("");
    try {
      const owner =
        isWorkbench && task
          ? { scopeKey: task.scopeKey, conversationId: await task.ensureTask() }
          : undefined;
      if (isWorkbench && task)
        await task.saveState(
          {
            step: "monitoring-project-creating",
            resources: selected.map((id) => ({ kind: "question" as const, id })),
            record: {
              id: requestId,
              label: "创建监控项目",
              status: "pending",
            },
          },
          owner,
        );
      const result = await create.mutateAsync({
        enterpriseProjectId,
        name: name.trim(),
        questionIds: selected,
        customQuestions,
        clientRequestId: requestId,
      });
      setSelectedProjectId(result.projectId);
      setCreateMonitorRequest(requestId);
      setOpen(false);
      void progress.refetch();
      if (isWorkbench && task)
        await outcome.sync(
          {
            step: "monitoring-configure",
            resources: [{ kind: "monitoring_project", id: result.projectId }],
            outputRefs: [
              {
                resource: { kind: "monitoring_project", id: result.projectId },
                sourceStepId: "monitoring-project-created",
              },
            ],
            values: {
              monitoringProjectId: result.projectId,
              monitorCreateOpen: false,
            },
            record: {
              id: requestId,
              label: "已创建监控项目",
              status: "completed",
            },
          },
          owner?.conversationId,
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
  const visibleQuestions = questions.filter((question) =>
    question.question.includes(questionSearch.trim()),
  );
  const visibleProjects = (progress.data?.projects ?? []).filter((project) =>
    project.name.includes(projectSearch.trim()),
  );
  const currentQuestionPage = Math.min(
    questionPage,
    Math.max(0, Math.ceil(visibleQuestions.length / 10) - 1),
  );
  const currentProjectPage = Math.min(
    projectPage,
    Math.max(0, Math.ceil(visibleProjects.length / 10) - 1),
  );
  return (
    <div className="business-monitoring-flow">
      {outcome.error && (
        <div className="workflow-feedback" role="alert">
          <p>{outcome.error}</p>
          <button type="button" onClick={() => void outcome.retry()}>
            重新同步成果
          </button>
        </div>
      )}
      {!selectedProjectId && !deepLink && !open && !showExisting ? (
        <WorkflowQuestion
          variant="entry" module="progress"
          question="这次想监控什么？"
          description="从优化问题建立监控，或查看已有监控的运行与结果。"
          choices={[
            { id: "create", label: "新建问题监控" },
            { id: "existing", label: "查看已有监控" },
          ]}
          onSelect={(choice) => {
            setError("");
            setOpen(choice === "create");
            setShowExisting(choice === "existing");
          }}
        />
      ) : (
        <WorkflowCompleted
          id="monitoring-current-step"
          summary={
            open
              ? "从优化问题建立监控"
              : showExisting
                ? "继续已有监控"
                : `当前监控 · ${progress.data?.projects.find((project) => project.id === selectedProjectId)?.name ?? "已恢复的监控任务"}`
          }
          onRevise={() => {
            if (selectedProjectId || deepLink)
              setShowExisting((value) => !value);
            else setShowExisting(false);
            setOpen(false);
          }}
        />
      )}
      {showExisting && (
        <section className="business-inline-step" aria-label="选择已有监控项目">
          <label className="business-flow-search">
            <Search size={16} />
            <input
              aria-label="搜索监控项目"
              value={projectSearch}
              onChange={(event) => {
                setProjectSearch(event.target.value);
                setProjectPage(0);
              }}
              placeholder="搜索监控项目"
            />
          </label>
          {progress.isLoading ? (
            <p role="status">正在读取已有监控…</p>
          ) : progress.error ? (
            <div role="alert">
              <p>{progress.error.message}</p>
              <button onClick={() => void progress.refetch()}>重新读取</button>
            </div>
          ) : (
            <div className="business-monitor-project-list">
              {visibleProjects
                .slice(currentProjectPage * 10, (currentProjectPage + 1) * 10)
                .map((project) => (
                  <button
                    key={project.id}
                    aria-pressed={selectedProjectId === project.id}
                    onClick={() => {
                      setSelectedProjectId(project.id);
                      setCreateMonitorRequest(undefined);
                      setShowExisting(false);
                    }}
                  >
                    <strong>{project.name}</strong>
                    <span>
                      {project.sourceQuestions?.length ?? 0} 个来源问题 ·
                      继续配置与查看运行
                    </span>
                  </button>
                ))}
              {!visibleProjects.length && (
                <p>
                  {projectSearch
                    ? "没有符合搜索条件的监控项目。"
                    : "尚无监控项目，可先从优化问题新建。"}
                </p>
              )}
              <WorkflowPagination
                page={currentProjectPage}
                total={visibleProjects.length}
                onChange={setProjectPage}
              />
              <button
                type="button"
                className="workflow-text-action"
                onClick={() => {
                  setShowExisting(false);
                  setOpen(true);
                }}
              >
                从优化问题新建
              </button>
              {onImportData && (
                <button
                  type="button"
                  className="workflow-text-action"
                  onClick={onImportData}
                >
                  上传监控数据
                </button>
              )}
            </div>
          )}
        </section>
      )}
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
            <label className="grid gap-2 text-sm">
              自定义监控问题
              <textarea
                className="min-h-24 rounded-lg border p-3 resize-y"
                value={customQuestionsText}
                maxLength={50 * 4000}
                placeholder={"可直接输入要监控的问题，每行一个，例如：\n台心医美在搜索引擎里的口碑怎么样"}
                onChange={(event) => setCustomQuestionsText(event.target.value)}
              />
              <span className="text-xs text-muted-foreground">
                {customQuestions.length
                  ? `将新增 ${customQuestions.length} 个自定义问题${customQuestions.length >= 50 ? "（已达上限 50 条）" : ""}`
                  : "可选。不选优化问题时，至少输入一行自定义问题。"}
              </span>
            </label>
            <label className="business-flow-search">
              <Search size={16} />
              <input
                type="search"
                aria-label="搜索优化问题"
                placeholder="搜索要监控的问题"
                value={questionSearch}
                onChange={(event) => {
                  setQuestionSearch(event.target.value);
                  setQuestionPage(0);
                }}
              />
            </label>
            <fieldset className="rounded-lg border p-3">
              <legend className="px-2 text-sm">
                优化问题 · 已选 {selected.length}
              </legend>
              {visibleQuestions.length ? (
                visibleQuestions
                  .slice(
                    currentQuestionPage * 10,
                    (currentQuestionPage + 1) * 10,
                  )
                  .map((question) => (
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
                  {questionSearch
                    ? "没有符合搜索条件的问题。"
                    : "可从上方直接输入要监控的问题，或先在“意图优化 → 优化问题”中保存问题后再勾选。"}
                </p>
              )}
            </fieldset>
            <WorkflowPagination
              page={currentQuestionPage}
              total={visibleQuestions.length}
              onChange={setQuestionPage}
            />
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
                (!selected.length && !customQuestions.length) ||
                selected.length + customQuestions.length > 500
              }
            >
              {create.isPending ? "正在创建…" : "继续设置监控"}
            </button>
          </form>
        </section>
      )}
      {(selectedProjectId || deepLink) && !open && (
        <Suspense
          fallback={
            <div role="status" className="p-8">
              正在读取监控工作台…
            </div>
          }
        >
          <MonitoringModule
            key={`${enterpriseProjectId}:${selectedProjectId}`}
            embedded
            selectedProjectId={selectedProjectId || undefined}
            createMonitorRequest={
              createMonitorRequest ??
              (task?.state?.step === "monitoring-configure"
                ? selectedProjectId
                : undefined)
            }
            questionSources={{
              ...sources,
              [selectedProjectId]:
                sources[selectedProjectId] ??
                questions
                  .filter((question) => selected.includes(question.id))
                  .map((question) => question.question),
            }}
          />
        </Suspense>
      )}
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
const runStatusTone: Record<string, string> = {
  queued: "is-muted",
  running: "is-blue",
  completed: "is-green",
  succeeded: "is-green",
  failed: "is-red",
  partial: "is-amber",
  cancelled: "is-muted",
  waiting_quota: "is-amber",
};
const REPORT_PAGE_SIZE = 20;
export function EnterpriseProgressReport({
  enterpriseProjectId,
  historical,
}: {
  enterpriseProjectId: string;
  historical?: React.ReactNode;
}) {
  const { task, isWorkbench } = useBusinessWorkspace();
  const [reportMode, setReportMode] = useBusinessFlowState(
    "reportMode",
    task?.state?.values.reportRunId ||
      task?.state?.resources?.some(
        (resource) => resource.kind === "monitoring_run",
      )
      ? "runs"
      : "",
    (value) =>
      ["", "runs", "trends", "imports", "data"].includes(String(value))
        ? String(value)
        : undefined,
  );
  const [trendProjectId, setTrendProjectId] = useBusinessFlowState(
    "reportTrendProjectId",
    "",
    readFlowString,
  );
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
      {
        label: "分析范围",
        value:
          reportMode === "data" ? "监控数据当前筛选范围" : reportMode === "trends"
            ? "所选监控最近 100 次运行；趋势按筛选时间范围查询"
            : reportMode === "imports"
              ? "历史导入报告"
              : reportMode === "runs"
                ? "当前项目最近 200 次运行"
                : "尚未选择分析方式",
      },
      ...(reportMode === "runs"
        ? [
            {
              label: "选中运行",
              value: selectedRun
                ? `${projectName(selectedRun.projectId)} · ${runStatus[selectedRun.status] || selectedRun.status}`
                : "尚未选择",
            },
          ]
        : reportMode === "trends"
          ? [
              {
                label: "趋势监控项目",
                value:
                  progress.data?.projects.find(
                    (project) => project.id === trendProjectId,
                  )?.name ?? "尚未选择",
              },
            ]
          : []),
      ...(["runs", "trends"].includes(reportMode)
        ? [
            {
              label: "监控数据更新时间",
              value: progress.dataUpdatedAt
                ? new Date(progress.dataUpdatedAt).toLocaleTimeString("zh-CN")
                : "等待读取",
            },
          ]
        : []),
    ],
    status:
      ["runs", "trends"].includes(reportMode) && progress.error
        ? "读取失败"
        : undefined,
    outputs:
      reportMode === "runs" && selectedRun
        ? [
            {
              id: selectedRun.id,
              title: `${projectName(selectedRun.projectId)} · 运行报告`,
              type: "监控报告",
              status: runStatus[selectedRun.status] || selectedRun.status,
              source: "真实监控运行",
              onOpen: () => setReportMode("runs"),
            },
          ]
        : undefined,
  });
  return (
    <section
      className={`${isWorkbench ? "" : "page-shell "}operator-progress-report business-report-flow`}
    >
      {!reportMode ? (
        <WorkflowQuestion
          variant="entry" module="progress"
          question="这次想了解哪一类监控结果？"
          choices={[
            { id: "data", label: "分析监控数据", description: "查看导入批次的回答、引用与可计算指标" },
            {
              id: "runs",
              label: "查看单次运行",
              description: "指标、回答与引用明细",
            },
            {
              id: "trends",
              label: "分析监控趋势",
              description: "按时间范围比较变化",
            },
            {
              id: "imports",
              label: "查看导入报告",
              description: "历史资料与导入来源",
            },
          ]}
          onSelect={setReportMode}
        />
      ) : (
        <WorkflowCompleted
          id="report-analysis-mode"
          summary={
            reportMode === "data" ? "分析监控数据" : reportMode === "runs"
              ? "查看单次运行"
              : reportMode === "trends"
                ? "分析监控趋势"
                : "查看导入报告"
          }
          onRevise={() => setReportMode("")}
        />
      )}
      {reportMode === "data" && <Suspense fallback={<p role="status">正在读取监控数据…</p>}><MonitoringDataWorkspace enterpriseProjectId={enterpriseProjectId} /></Suspense>}
      <div hidden={reportMode !== "runs"}>
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
            <div className="operator-progress-stats monitoring-metric-cards">
              {([
                ["监控项目", progress.data?.summary.projectCount, "is-purple"],
                ["运行次数", progress.data?.summary.runCount, "is-blue"],
                ["已完成尝试", progress.data?.summary.completedAttempts, "is-green"],
                ["失败尝试", progress.data?.summary.failedAttempts, "is-red"],
              ] as Array<[string, number | undefined, string]>).map(([label, value, tone]) => (
                <div key={label} className={`monitoring-metric-card ${tone}`}>
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
                            <td>
                              <span className={`monitoring-status-badge ${runStatusTone[run.status] ?? ""}`}>
                                {runStatus[run.status] || run.status}
                              </span>
                            </td>
                            <td>
                              <div className="monitoring-run-progress">
                                <span
                                  className="monitoring-run-progress__track"
                                  aria-hidden="true"
                                >
                                  <span
                                    className="monitoring-run-progress__fill"
                                    style={{
                                      width: `${run.expectedAttempts ? Math.min(100, Math.round((run.completedAttempts + run.failedAttempts) / run.expectedAttempts * 100)) : 0}%`,
                                    }}
                                  />
                                </span>
                                <span className="monitoring-run-progress__label">
                                  {run.completedAttempts + run.failedAttempts} /{" "}
                                  {run.expectedAttempts}
                                </span>
                              </div>
                            </td>
                            <td>
                              <button
                                type="button"
                                className="business-flow-text-action"
                                onClick={() => {
                                  setSelectedRunId(run.id);
                                  void task
                                    ?.saveState({
                                      step: "report-run-selected",
                                      outputRefs: [
                                        {
                                          resource: {
                                            kind: "monitoring_run",
                                            id: run.id,
                                          },
                                          sourceStepId: "report-run-selected",
                                        },
                                      ],
                                    })
                                    .catch(() => undefined);
                                }}
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
                    {visibleRuns.length} 次运行 · {currentPage + 1} /{" "}
                    {pageCount}
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
      </div>
      {reportMode === "trends" && (
        <section className="business-inline-step" aria-label="监控趋势分析">
          <p>
            先选择监控项目，再展开监控对象和时间范围。运行选择器最多读取当前监控最近
            100 次运行；趋势指标按所选时间范围向真实服务查询。
          </p>
          <div className="business-monitor-project-list">
            {(progress.data?.projects ?? []).map((project) => (
              <button
                key={project.id}
                aria-pressed={trendProjectId === project.id}
                onClick={() => setTrendProjectId(project.id)}
              >
                <strong>{project.name}</strong>
                <span>展开趋势分析</span>
              </button>
            ))}
          </div>
          {trendProjectId && (
            <Suspense fallback={<p role="status">正在读取趋势数据…</p>}>
              <MonitoringModule
                key={`trend:${trendProjectId}`}
                embedded
                selectedProjectId={trendProjectId}
                analysisOnly
                initialTab="trends"
              />
            </Suspense>
          )}
        </section>
      )}
      {reportMode === "imports" && (
        <section className="business-inline-step" aria-label="历史导入报告">
          {historical ?? <p>当前项目没有可展示的导入报告。</p>}
        </section>
      )}
    </section>
  );
}
