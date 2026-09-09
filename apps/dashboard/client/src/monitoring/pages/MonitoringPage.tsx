import { useBusinessWorkspace } from "@/dashboard/BusinessWorkspaceContext";
import { activeEnterpriseProjectId } from "@/lib/enterprise-project";
import { ArchiveRestore, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { Link, useLocation } from "wouter";

import Modal from "../components/Modal";
import MonitorForm from "../components/MonitorForm";
import ProjectForm from "../components/ProjectForm";
import RunConfirmationDialog from "../components/RunConfirmationDialog";
import { summarizeScreenshotPolicies } from "../runBilling";
import MonitoringWorkspace from "../features/monitoring/MonitoringWorkspace";
import {
  formatDateTime,
  type MonitorInput,
  type MonitorRun,
  type MonitorSummary,
  type ProjectSummary,
  type ProviderModel,
  type RegionOption,
} from "../domain";
import type {
  QuoteMonitorRunCost,
  QuoteRunCost,
  RunCostQuoteView,
} from "../runBilling";

export type MonitoringSaveResult = void | { monitorId: string; runId?: string };
export type MonitoringRunResult = void | { runId: string };

export type MonitoringPageProps = {
  project?: ProjectSummary;
  seedQuestions?: string[];
  monitors: MonitorSummary[];
  deletedMonitors?: Array<{
    id: string;
    name: string;
    deletedAt: Date | string | null;
    purgeAfter: Date | string | null;
  }>;
  models: ProviderModel[];
  availableBalanceTenThousandths: string;
  quoteRunCost: QuoteRunCost;
  quoteMonitorRunCost: QuoteMonitorRunCost;
  regions?: RegionOption[];
  loading?: boolean;
  /** Use the owner-checked monitoring read models instead of preview runs. */
  serverData?: boolean;
  /** Explicit synthetic demo, distinct from caller-provided preview data. */
  demoMode?: boolean;
  onCreateProject: (
    project: Omit<ProjectSummary, "id">,
  ) => void | Promise<void>;
  onUpdateProject?: (
    project: Omit<ProjectSummary, "id">,
  ) => void | Promise<void>;
  onSaveMonitor: (
    monitor: MonitorInput,
    runNow: boolean,
    idempotencyKey?: string,
  ) => MonitoringSaveResult | Promise<MonitoringSaveResult>;
  onLoadMonitor?: (id: string) => MonitorInput | Promise<MonitorInput>;
  onUpdateMonitor?: (
    id: string,
    monitor: MonitorInput,
    runNow: boolean,
    idempotencyKey?: string,
  ) => MonitoringSaveResult | Promise<MonitoringSaveResult>;
  onRunMonitor: (
    id: string,
  ) => MonitoringRunResult | Promise<MonitoringRunResult>;
  onToggleMonitor: (id: string, paused: boolean) => void | Promise<void>;
  onDeleteMonitor: (id: string) => void | Promise<void>;
  onRestoreMonitor?: (id: string) => void | Promise<void>;
  onRefresh?: () => void | Promise<void>;
  latestRun?: MonitorRun;
  recentRuns?: MonitorRun[];
  selectedRunId?: string;
  onSelectedRunChange?: (runId: string) => void;
  onSelectedMonitorChange?: (monitor?: MonitorSummary) => void;
};

type PendingRunConfirmation =
  | { kind: "existing"; monitor: MonitorSummary }
  | {
      kind: "save";
      monitorId?: string;
      value: MonitorInput;
      idempotencyKey?: string;
      quote?: RunCostQuoteView;
    };

type MonitorEditorState =
  | { kind: "create" }
  | {
      kind: "edit";
      monitorId: string;
      loading: boolean;
      initial?: MonitorInput;
    };

function monitorInputScheduleLabel(value: MonitorInput) {
  if (value.schedule.type === "none") return "仅本次手动执行";
  const cadence = value.schedule.type === "weekly" ? "每周执行" : "每日执行";
  return `${cadence} · ${value.schedule.localTime || "未设置时间"} · ${value.schedule.timezone}`;
}

export default function MonitoringPage({
  project,
  seedQuestions,
  monitors,
  deletedMonitors = [],
  models,
  availableBalanceTenThousandths,
  quoteRunCost,
  quoteMonitorRunCost,
  regions = [],
  loading,
  serverData = false,
  demoMode = false,
  onCreateProject,
  onUpdateProject,
  onSaveMonitor,
  onLoadMonitor,
  onUpdateMonitor,
  onRunMonitor,
  onToggleMonitor,
  onDeleteMonitor,
  onRestoreMonitor,
  onRefresh,
  latestRun,
  recentRuns = [],
  selectedRunId,
  onSelectedRunChange,
  onSelectedMonitorChange,
}: MonitoringPageProps) {
  const { isWorkbench, task } = useBusinessWorkspace();
  const [, navigate] = useLocation();
  const [monitorEditor, setMonitorEditor] = useState<MonitorEditorState>();
  const [projectModal, setProjectModal] = useState(false);
  const [recycleModal, setRecycleModal] = useState(false);
  const [pendingDelete, setPendingDelete] = useState<MonitorSummary>();
  const [deleting, setDeleting] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [confirmingRun, setConfirmingRun] = useState(false);
  const [pendingRun, setPendingRun] = useState<PendingRunConfirmation>();
  const [pendingRunQuote, setPendingRunQuote] = useState<RunCostQuoteView>();
  const [pendingRunQuoteLoading, setPendingRunQuoteLoading] = useState(false);
  const [pendingRunQuoteError, setPendingRunQuoteError] = useState("");
  const [submitError, setSubmitError] = useState("");
  const [actionError, setActionError] = useState("");
  const [success, setSuccess] = useState<{
    message: string;
    monitorId: string;
    runId?: string;
    nonce: number;
  }>();
  const quoteRequestId = useRef(0);
  const editorRequestId = useRef(0);
  const hasCompletedInitialLoadRef = useRef(!loading || monitors.length > 0);

  useEffect(() => {
    const url = new URL(window.location.href);
    if (
      !loading &&
      project &&
      seedQuestions &&
      url.searchParams.get("newMonitor") === "1"
    ) {
      setMonitorEditor({ kind: "create" });
      url.searchParams.delete("newMonitor");
      window.history.replaceState(
        window.history.state,
        "",
        `${url.pathname}${url.search}`,
      );
    }
  }, [loading, project?.id, seedQuestions]);

  const initialLoading = Boolean(
    loading && !hasCompletedInitialLoadRef.current && monitors.length === 0,
  );

  useEffect(() => {
    if (!loading && !project && !activeEnterpriseProjectId())
      setProjectModal(true);
  }, [loading, project]);

  useEffect(() => {
    if (!loading || monitors.length > 0) {
      hasCompletedInitialLoadRef.current = true;
    }
  }, [loading, monitors.length]);

  const runAction = async <T,>(operation: () => T | Promise<T>) => {
    setActionError("");
    try {
      return await operation();
    } catch (error) {
      setActionError(
        error instanceof Error ? error.message : "操作失败，请稍后重试。",
      );
      return undefined;
    }
  };

  const rememberMonitorResult = (monitorId: string, runId?: string) => {
    if (!isWorkbench || !task) return;
    void task
      .saveState({
        step: runId ? "monitoring-running" : "monitoring-saved",
        values: {
          selectedMonitorId: monitorId,
          ...(runId ? { selectedRunId: runId } : {}),
        },
        ...(runId
          ? {
              resources: [
                ...(task.state?.resources ?? []).filter(
                  (item) => item.kind !== "monitoring_run",
                ),
                { kind: "monitoring_run" as const, id: runId },
              ],
            }
          : {}),
        record: {
          id: `monitor-${runId ?? monitorId}`,
          label: runId ? "监控已提交执行" : "监控配置已保存",
          status: "completed",
        },
      })
      .catch(() =>
        setActionError(
          "监控操作已提交，任务记录同步失败；可在任务辅助区重试同步。",
        ),
      );
  };
  const persistMonitor = async (
    value: MonitorInput,
    runNow: boolean,
    idempotencyKey?: string,
    monitorId?: string,
  ) => {
    setSubmitting(true);
    setSubmitError("");
    try {
      if (isWorkbench && task)
        await task.saveState({
          step: runNow ? "monitoring-confirmed" : "monitoring-saving",
          values: { monitorForm: value },
          record: {
            id: "monitor-submit",
            label: runNow ? "已确认监控费用并提交" : "保存监控配置",
            status: "pending",
          },
        });
      const result = monitorId
        ? await onUpdateMonitor?.(monitorId, value, runNow, idempotencyKey)
        : await onSaveMonitor(value, runNow, idempotencyKey);
      setMonitorEditor(undefined);
      const resolvedResult = result || (monitorId ? { monitorId } : undefined);
      if (resolvedResult) {
        rememberMonitorResult(resolvedResult.monitorId, resolvedResult.runId);
        setSuccess({
          message: runNow
            ? monitorId
              ? "监控已更新并开始执行"
              : "监控已保存并开始执行"
            : monitorId
              ? "监控已更新"
              : "监控已保存",
          monitorId: resolvedResult.monitorId,
          runId: resolvedResult.runId,
          nonce: Date.now(),
        });
      }
      return { succeeded: true, result };
    } catch (error) {
      setSubmitError(
        error instanceof Error ? error.message : "保存监控失败，请稍后重试。",
      );
      return { succeeded: false, result: undefined };
    } finally {
      setSubmitting(false);
    }
  };

  const saveMonitor = async (
    value: MonitorInput,
    runNow: boolean,
    idempotencyKey?: string,
    quote?: RunCostQuoteView,
  ) => {
    const monitorId =
      monitorEditor?.kind === "edit" ? monitorEditor.monitorId : undefined;
    if (runNow) {
      quoteRequestId.current += 1;
      setPendingRun({ kind: "save", monitorId, value, idempotencyKey, quote });
      setPendingRunQuote(quote);
      setPendingRunQuoteLoading(false);
      setPendingRunQuoteError(quote ? "" : "费用估算暂不可用");
      return;
    }
    await persistMonitor(value, false, idempotencyKey, monitorId);
  };

  const closeMonitorEditor = () => {
    editorRequestId.current += 1;
    setMonitorEditor(undefined);
    setSubmitError("");
  };

  const openCreateMonitor = () => {
    editorRequestId.current += 1;
    setSubmitError("");
    setMonitorEditor({ kind: "create" });
  };

  const openEditMonitor = async (monitor: MonitorSummary) => {
    if (!onLoadMonitor || !onUpdateMonitor) {
      navigate(`/monitoring-system/${monitor.id}`);
      return;
    }
    const requestId = editorRequestId.current + 1;
    editorRequestId.current = requestId;
    setSubmitError("");
    setMonitorEditor({ kind: "edit", monitorId: monitor.id, loading: true });
    try {
      const initial = await onLoadMonitor(monitor.id);
      if (editorRequestId.current !== requestId) return;
      setMonitorEditor({
        kind: "edit",
        monitorId: monitor.id,
        loading: false,
        initial,
      });
    } catch (error) {
      if (editorRequestId.current !== requestId) return;
      setSubmitError(
        error instanceof Error
          ? error.message
          : "读取监控配置失败，请稍后重试。",
      );
      setMonitorEditor({ kind: "edit", monitorId: monitor.id, loading: false });
    }
  };

  const prepareExistingRun = (monitor: MonitorSummary) => {
    const requestId = quoteRequestId.current + 1;
    quoteRequestId.current = requestId;
    setPendingRun({ kind: "existing", monitor });
    setPendingRunQuote(undefined);
    setPendingRunQuoteError("");
    setPendingRunQuoteLoading(true);
    void Promise.resolve()
      .then(() => quoteMonitorRunCost(monitor.id))
      .then(
        (quote) => {
          if (quoteRequestId.current !== requestId) return;
          setPendingRunQuote(quote);
          setPendingRunQuoteLoading(false);
        },
        () => {
          if (quoteRequestId.current !== requestId) return;
          setPendingRunQuoteError("费用估算暂不可用");
          setPendingRunQuoteLoading(false);
        },
      );
  };

  const cancelPendingRun = () => {
    quoteRequestId.current += 1;
    setPendingRun(undefined);
    setPendingRunQuote(undefined);
    setPendingRunQuoteLoading(false);
    setPendingRunQuoteError("");
  };

  const confirmDelete = async () => {
    if (!pendingDelete || deleting) return;
    setDeleting(true);
    setActionError("");
    try {
      await onDeleteMonitor(pendingDelete.id);
      setPendingDelete(undefined);
    } catch (error) {
      setActionError(
        error instanceof Error ? error.message : "删除失败，请稍后重试。",
      );
    } finally {
      setDeleting(false);
    }
  };

  const confirmPendingRun = async () => {
    if (!pendingRun || confirmingRun) return;
    setConfirmingRun(true);
    if (pendingRun.kind === "existing") {
      setActionError("");
      try {
        if (isWorkbench && task)
          await task.saveState({
            step: "monitoring-confirmed",
            values: { selectedMonitorId: pendingRun.monitor.id },
            record: {
              id: "monitor-submit",
              label: "已确认监控费用并提交",
              status: "pending",
            },
          });
        const result = await onRunMonitor(pendingRun.monitor.id);
        rememberMonitorResult(pendingRun.monitor.id, result?.runId);
        setSuccess({
          message: "监控已开始执行",
          monitorId: pendingRun.monitor.id,
          runId: result?.runId,
          nonce: Date.now(),
        });
        cancelPendingRun();
      } catch (error) {
        setActionError(
          error instanceof Error ? error.message : "执行失败，请稍后重试。",
        );
      }
    } else {
      const saved = await persistMonitor(
        pendingRun.value,
        true,
        pendingRun.idempotencyKey,
        pendingRun.monitorId,
      );
      if (saved.succeeded) cancelPendingRun();
    }
    setConfirmingRun(false);
  };

  const createProject = async (value: Omit<ProjectSummary, "id">) => {
    setSubmitting(true);
    setSubmitError("");
    try {
      await (project ? onUpdateProject?.(value) : onCreateProject(value));
      setProjectModal(false);
    } catch (error) {
      setSubmitError(
        error instanceof Error ? error.message : "保存项目失败，请稍后重试。",
      );
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="page-content monitoring-reference-page">
      {actionError && (
        <p className="form-error page-error" role="alert">
          {actionError}
        </p>
      )}
      {success && (
        <div className="fm-workspace-toast" role="status">
          <span>{demoMode ? `演示：${success.message}` : success.message}</span>
          {success.runId && !demoMode && (
            <Link
              href={`/monitoring-system/${success.monitorId}/runs/${success.runId}`}
            >
              查看运行
            </Link>
          )}
          <button
            type="button"
            aria-label="关闭成功提示"
            onClick={() => setSuccess(undefined)}
          >
            <X size={14} />
          </button>
        </div>
      )}
      {initialLoading ? (
        <div
          className="monitoring-workbench fm-initial-loading"
          aria-busy="true"
        >
          <span>正在读取问题监控…</span>
        </div>
      ) : project ? (
        <MonitoringWorkspace
          project={project}
          monitors={monitors}
          deletedCount={deletedMonitors.length}
          latestRun={latestRun}
          recentRuns={recentRuns}
          selectedRunId={selectedRunId}
          loading={loading}
          serverData={serverData}
          canRefresh={Boolean(onRefresh)}
          onSelectedRunChange={onSelectedRunChange}
          onSelectedMonitorChange={onSelectedMonitorChange}
          onAdd={openCreateMonitor}
          onOpenRecycle={() => setRecycleModal(true)}
          onOpenDetails={(monitor) => void openEditMonitor(monitor)}
          onOpenRun={(monitor, runId) =>
            demoMode
              ? onSelectedRunChange?.(runId)
              : navigate(`/monitoring-system/${monitor.id}/runs/${runId}`)
          }
          onRun={prepareExistingRun}
          onToggle={(monitor) =>
            void runAction(() =>
              onToggleMonitor(monitor.id, monitor.status !== "paused"),
            )
          }
          onDelete={setPendingDelete}
          onRefresh={async () => {
            await runAction(() => onRefresh?.());
          }}
          selectionRequest={
            success
              ? {
                  monitorId: success.monitorId,
                  runId: success.runId,
                  nonce: success.nonce,
                }
              : undefined
          }
        />
      ) : (
        <section className="panel-state" aria-label="监控项目空态">
          <strong>尚未创建监控项目</strong>
          <span>创建项目后，可配置问题、模型与监控计划。</span>
          <button
            type="button"
            className="primary-button"
            onClick={() => setProjectModal(true)}
          >
            创建项目
          </button>
        </section>
      )}

      <Modal
        inline={isWorkbench}
        open={projectModal}
        onClose={() => !submitting && setProjectModal(false)}
        title={project ? "编辑项目" : "创建第一个项目"}
        description="一个项目对应一个主监控品牌，历史运行保留当时的品牌版本。"
        size="large"
      >
        {submitError && (
          <p className="form-error modal-error" role="alert">
            {submitError}
          </p>
        )}
        <ProjectForm
          initial={project}
          submitting={submitting}
          onCancel={() => !submitting && setProjectModal(false)}
          onSubmit={createProject}
        />
      </Modal>
      {project && monitorEditor && (
        <Modal
          inline={isWorkbench}
          open
          onClose={closeMonitorEditor}
          title={
            monitorEditor.kind === "edit" ? "编辑问题监控" : "批量添加问题"
          }
          description={
            monitorEditor.kind === "edit"
              ? "保存会创建新的不可变配置版本，历史运行保持原样。"
              : undefined
          }
          size="wide"
        >
          {submitError && (
            <p className="form-error modal-error" role="alert">
              {submitError}
            </p>
          )}
          {monitorEditor.kind === "edit" && !monitorEditor.initial ? (
            monitorEditor.loading ? (
              <div className="panel-state" aria-busy="true">
                <strong>正在读取监控配置…</strong>
              </div>
            ) : (
              <div className="panel-state">
                <strong>监控配置暂不可用</strong>
                <span>关闭后重试，或从旧详情页继续编辑。</span>
              </div>
            )
          ) : (
            <MonitorForm
              key={
                monitorEditor.kind === "edit"
                  ? monitorEditor.monitorId
                  : "create"
              }
              project={project}
              demoMode={demoMode}
              seedQuestions={seedQuestions}
              models={models}
              availableBalanceTenThousandths={availableBalanceTenThousandths}
              quoteRunCost={quoteRunCost}
              regions={regions}
              initial={
                monitorEditor.kind === "edit"
                  ? monitorEditor.initial
                  : undefined
              }
              submitting={submitting}
              onCancel={closeMonitorEditor}
              onSubmit={saveMonitor}
            />
          )}
        </Modal>
      )}
      {pendingRun && (
        <RunConfirmationDialog
          inline={isWorkbench}
          open
          monitorName={
            pendingRun.kind === "existing"
              ? pendingRun.monitor.name
              : pendingRun.value.name
          }
          questionCount={
            pendingRun.kind === "existing"
              ? pendingRun.monitor.questionsCount
              : pendingRun.value.questions.length
          }
          platformCount={
            pendingRun.kind === "existing"
              ? pendingRun.monitor.platformsCount
              : pendingRun.value.platforms.length
          }
          repetitions={
            pendingRun.kind === "existing"
              ? pendingRun.monitor.repetitions
              : pendingRun.value.repetitions
          }
          availableBalanceTenThousandths={availableBalanceTenThousandths}
          estimatedCostTenThousandths={
            pendingRunQuote?.totalAmountTenThousandths
          }
          quoteLoading={pendingRunQuoteLoading}
          quoteError={pendingRunQuoteError}
          scheduleSummary={
            pendingRun.kind === "existing"
              ? pendingRun.monitor.scheduleLabel
              : monitorInputScheduleLabel(pendingRun.value)
          }
          screenshotPolicy={
            pendingRun.kind === "save"
              ? summarizeScreenshotPolicies(pendingRun.value.platforms)
              : undefined
          }
          loading={confirmingRun}
          onCancel={cancelPendingRun}
          onConfirm={confirmPendingRun}
        />
      )}
      <Modal
        inline={isWorkbench}
        open={Boolean(pendingDelete)}
        onClose={() => {
          if (!deleting) setPendingDelete(undefined);
        }}
        title="删除问题监控"
        description="删除后保留 30 天，可从回收站恢复；恢复后自动计划保持暂停。"
      >
        <div className="fm-delete-confirmation" aria-busy={deleting}>
          <span>即将删除</span>
          <strong>{pendingDelete?.name}</strong>
          <p>历史运行与结果不会立即清除，恢复监控不会自动重新开启计划。</p>
        </div>
        <footer className="run-confirmation-footer">
          <button
            type="button"
            className="ghost-button"
            data-modal-initial-focus
            disabled={deleting}
            onClick={() => setPendingDelete(undefined)}
          >
            取消
          </button>
          <button
            type="button"
            className="danger-button"
            disabled={deleting}
            onClick={() => void confirmDelete()}
          >
            {deleting ? "正在删除…" : "移入回收站"}
          </button>
        </footer>
      </Modal>
      <Modal
        inline={isWorkbench}
        open={recycleModal}
        onClose={() => setRecycleModal(false)}
        title="问题监控回收站"
        description="删除后保留 30 天；恢复后的自动计划保持暂停。"
      >
        <div className="recycle-list">
          {deletedMonitors.length ? (
            deletedMonitors.map((item) => (
              <article key={item.id}>
                <div>
                  <strong>{item.name}</strong>
                  <small>
                    删除于{" "}
                    {formatDateTime(
                      item.deletedAt ? String(item.deletedAt) : undefined,
                    )}{" "}
                    · 清理时间{" "}
                    {formatDateTime(
                      item.purgeAfter ? String(item.purgeAfter) : undefined,
                    )}
                  </small>
                </div>
                <button
                  type="button"
                  className="secondary-button"
                  onClick={() =>
                    void runAction(async () => {
                      await onRestoreMonitor?.(item.id);
                      setRecycleModal(false);
                    })
                  }
                >
                  <ArchiveRestore size={14} /> 恢复并保持暂停
                </button>
              </article>
            ))
          ) : (
            <div className="panel-state">
              <strong>回收站为空</strong>
            </div>
          )}
        </div>
      </Modal>
    </div>
  );
}
