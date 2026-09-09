import { useBusinessWorkspace } from "@/dashboard/BusinessWorkspaceContext";
import {
  ChevronRight,
  Download,
  Table2,
  Edit3,
  Pause,
  Play,
  Plus,
  RadioTower,
  RefreshCw,
  Trash2,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import {
  formatDateTime,
  monitorStatusLabel,
  type MonitorRun,
  type MonitorSummary,
  type ProjectSummary,
  type RunAttempt,
} from "../../domain";
import MonitorListPanel from "./MonitorListPanel";
import MonitoringFilterBar from "./MonitoringFilterBar";
import MonitoringTabs from "./MonitoringTabs";
import AnswerDetailPanel from "./panels/AnswerDetailPanel";
import CitationAnalysisPanel from "./panels/CitationAnalysisPanel";
import CompetitorPanel from "./panels/CompetitorPanel";
import MetricDetailPanel from "./panels/MetricDetailPanel";
import OverviewPanel from "./panels/OverviewPanel";
import SourceDistributionPanel from "./panels/SourceDistributionPanel";
import TrendPanel from "./panels/TrendPanel";
import MediaStatisticsPanel from "./panels/MediaStatisticsPanel";
import {
  monitoringDateWindow,
  monitoringExportHref,
  monitoringQueryString,
  readMonitoringQuery,
  writeMonitoringQuery,
} from "./queryState";
import {
  filterAttempts,
  filterRunsByRange,
  projectAttemptsForRunSubject,
} from "./selectors";
import type {
  DateRange,
  MonitoringQueryContext,
  MonitoringQueryState,
} from "./types";
import { attemptModelKey } from "./types";
import { useMonitoringDataSource } from "./useMonitoringDataSource";
import "./monitoring.css";
import "./reference-ui.css";

type MonitoringWorkspaceProps = {
  analysisOnly?: boolean;
  initialTab?: "overview" | "trends";
  project: ProjectSummary;
  monitors: MonitorSummary[];
  deletedCount: number;
  latestRun?: MonitorRun;
  recentRuns: MonitorRun[];
  selectedRunId?: string;
  loading?: boolean;
  serverData?: boolean;
  canRefresh: boolean;
  onSelectedRunChange?: (runId: string) => void;
  onSelectedMonitorChange?: (monitor?: MonitorSummary) => void;
  onAdd: () => void;
  onOpenRecycle: () => void;
  onOpenDetails: (monitor: MonitorSummary) => void;
  onOpenRun: (monitor: MonitorSummary, runId: string) => void;
  onRun: (monitor: MonitorSummary) => void;
  onToggle: (monitor: MonitorSummary) => void;
  onDelete: (monitor: MonitorSummary) => void;
  onRefresh: () => Promise<void>;
  selectionRequest?: { monitorId: string; runId?: string; nonce: number };
};

type MonitoringDataSourceHook = typeof useMonitoringDataSource;

function usePreviewMonitoringDataSource(): ReturnType<MonitoringDataSourceHook> {
  return {
    summary: undefined,
    attempts: [],
    detailAttempt: undefined,
    analysis: undefined,
    summaryReady: true,
    answersReady: true,
    answerDetailLoading: false,
    answerDetailSettled: true,
    hasMoreAnswers: false,
    loadingMoreAnswers: false,
    loadMoreAnswers: async () => undefined,
    loading: false,
    error: undefined,
    refresh: async () => undefined,
  };
}

export function runCollection(
  runs: MonitorRun[],
  latestRun: MonitorRun | undefined,
) {
  const result = new Map(runs.map((run) => [run.id, run]));
  if (latestRun) result.set(latestRun.id, latestRun);
  return [...result.values()].sort((left, right) => {
    const leftTime = Date.parse(left.createdAt) || 0;
    const rightTime = Date.parse(right.createdAt) || 0;
    return rightTime - leftTime;
  });
}

function previewExportHref(attempts: RunAttempt[]) {
  if (!attempts.length) return;
  const escape = (value: unknown) =>
    `"${String(value ?? "").replaceAll('"', '""')}"`;
  const rows = [
    [
      "问题",
      "模型",
      "客户端",
      "重复次数",
      "状态",
      "提及",
      "位置",
      "引用数",
      "回答",
    ],
    ...attempts.map((attempt) => [
      attempt.question,
      attempt.platformName,
      attempt.clientType,
      attempt.repetition,
      attempt.status,
      attempt.brandMentioned === undefined
        ? ""
        : attempt.brandMentioned
          ? "是"
          : "否",
      attempt.mentionPosition ?? "",
      attempt.sources.length,
      attempt.answer || attempt.answerPreview || "",
    ]),
  ];
  const csv = rows.map((row) => row.map(escape).join(",")).join("\r\n");
  return `data:text/csv;charset=utf-8,${encodeURIComponent(`\uFEFF${csv}`)}`;
}

function MonitoringWorkspaceController({
  project,
  monitors,
  deletedCount,
  latestRun,
  recentRuns,
  selectedRunId,
  loading,
  serverData = false,
  canRefresh,
  onSelectedRunChange,
  onSelectedMonitorChange,
  onAdd,
  onOpenRecycle,
  onOpenDetails,
  onOpenRun,
  onRun,
  onToggle,
  onDelete,
  onRefresh,
  selectionRequest,
  useDataSource,
  analysisOnly = false,
  initialTab,
}: MonitoringWorkspaceProps & { useDataSource: MonitoringDataSourceHook }) {
  const { isWorkbench, task } = useBusinessWorkspace();
  const [monitorSearch, setMonitorSearch] = useState("");
  const [monitorPage, setMonitorPage] = useState(0);
  const allRuns = useMemo(
    () => runCollection(recentRuns, latestRun),
    [latestRun, recentRuns],
  );
  const baseContext = useMemo<MonitoringQueryContext>(
    () => ({
      project,
      monitors,
      runs: allRuns,
      currentRun: latestRun,
      allowUnresolved: serverData,
    }),
    [allRuns, latestRun, serverData, monitors, project],
  );
  const initialSearchRef = useRef(
    isWorkbench
      ? typeof task?.state?.values.monitoringQuery === "string"
        ? task.state.values.monitoringQuery
        : `?tab=${initialTab ?? "overview"}`
      : typeof window === "undefined"
        ? ""
        : window.location.search,
  );
  const hasHydratedDataRef = useRef(monitors.length > 0);
  const [query, setQuery] = useState<MonitoringQueryState>(() =>
    readMonitoringQuery(initialSearchRef.current, baseContext),
  );
  const queryRef = useRef(query);
  const live = useDataSource({
    enabled: serverData,
    query,
    timezone: project.timezone,
  });
  const context = useMemo<MonitoringQueryContext>(() => {
    const remoteSubjects = live.summary?.filters.subjects.map((item) =>
      item.kind === "self"
        ? ("self" as const)
        : (`competitor:${item.name}` as const),
    );
    return {
      ...baseContext,
      attempts: serverData ? live.attempts : undefined,
      runIds: serverData
        ? live.attempts.flatMap((attempt) =>
            attempt.runId ? [attempt.runId] : [],
          )
        : undefined,
      questionIds: serverData
        ? live.summary?.filters.questions.map((item) => item.id)
        : undefined,
      modelIds: serverData
        ? live.summary?.filters.platforms.map((item) => item.id)
        : undefined,
      subjects: remoteSubjects,
      allowUnresolved:
        serverData &&
        !(live.summaryReady && live.answersReady && live.answerDetailSettled),
    };
  }, [
    baseContext,
    live.answerDetailSettled,
    live.answersReady,
    live.attempts,
    live.summary,
    live.summaryReady,
    serverData,
  ]);
  const [visibleMonitorIds, setVisibleMonitorIds] = useState<string[]>(
    monitors.map((monitor) => monitor.id),
  );
  const [refreshing, setRefreshing] = useState(false);
  const [listCollapsed, setListCollapsed] = useState(false);
  const [refreshMessage, setRefreshMessage] = useState("");
  const [tableView, setTableView] = useState(false);
  const detailRef = useRef<HTMLElement>(null);

  const normalize = useCallback(
    (candidate: MonitoringQueryState) =>
      readMonitoringQuery(monitoringQueryString(candidate), context),
    [context],
  );

  useEffect(() => {
    queryRef.current = query;
  }, [query]);

  const updateQuery = useCallback(
    (
      patch:
        | Partial<MonitoringQueryState>
        | ((current: MonitoringQueryState) => Partial<MonitoringQueryState>),
      mode: "push" | "replace" = "push",
    ) => {
      const current = queryRef.current;
      const nextPatch = typeof patch === "function" ? patch(current) : patch;
      const next = normalize({ ...current, ...nextPatch });
      queryRef.current = next;
      setQuery(next);
      if (isWorkbench && task)
        void task
          .saveState({
            values: { monitoringQuery: monitoringQueryString(next) },
          })
          .catch(() => undefined);
      else writeMonitoringQuery(next, mode);
    },
    [normalize, isWorkbench, task],
  );

  useEffect(() => {
    if (!monitors.length || hasHydratedDataRef.current) return;
    hasHydratedDataRef.current = true;
    const next = readMonitoringQuery(initialSearchRef.current, context);
    queryRef.current = next;
    setQuery(next);
    if (!isWorkbench) writeMonitoringQuery(next, "replace");
  }, [context, monitors.length]);

  useEffect(() => {
    if (!hasHydratedDataRef.current) return;
    const current = queryRef.current;
    const next = normalize(current);
    if (monitoringQueryString(next) === monitoringQueryString(current)) return;
    queryRef.current = next;
    setQuery(next);
    if (!isWorkbench) writeMonitoringQuery(next, "replace");
  }, [normalize]);

  useEffect(() => {
    if (!selectionRequest) return;
    updateQuery({
      monitorId: selectionRequest.monitorId,
      runId: selectionRequest.runId,
      question: undefined,
      model: undefined,
      answerQuestion: undefined,
      answerId: undefined,
      fullscreen: false,
    });
  }, [selectionRequest?.nonce]);

  useEffect(() => {
    if (isWorkbench) return;
    const onPopState = () => {
      const next = readMonitoringQuery(window.location.search, context);
      queryRef.current = next;
      setQuery(next);
    };
    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  }, [context, isWorkbench]);

  const selectedMonitor = monitors.find(
    (monitor) => monitor.id === query.monitorId,
  );
  const visibleSelectedMonitor =
    selectedMonitor &&
    (isWorkbench || visibleMonitorIds.includes(selectedMonitor.id))
      ? selectedMonitor
      : undefined;
  const monitorRuns = allRuns.filter(
    (run) => run.monitorId === selectedMonitor?.id,
  );
  const rangedRuns = filterRunsByRange(
    monitorRuns,
    query.range,
    query.from,
    query.to,
    project.timezone,
  );
  const run =
    rangedRuns.find((item) => item.id === query.runId) || rangedRuns[0];
  const previewSubject = query.subject.startsWith("competitor:")
    ? run?.config.competitors.find(
        (competitor) =>
          competitor.name === query.subject.slice("competitor:".length),
      ) || "self"
    : "self";
  const filteredAttempts = serverData
    ? live.attempts.filter(
        (attempt) =>
          (!query.question || attempt.questionId === query.question) &&
          (!query.model || attemptModelKey(attempt) === query.model),
      )
    : rangedRuns.flatMap((item) =>
        filterAttempts(item, query.question, query.model),
      );
  const analyticsAttempts = serverData
    ? []
    : rangedRuns.flatMap((item) =>
        filterAttempts(item, query.question, query.model),
      );
  const visibleAnswerAttempts = serverData
    ? filteredAttempts
    : rangedRuns.flatMap((item) =>
        projectAttemptsForRunSubject(
          filterAttempts(item, query.question, query.model),
          previewSubject,
          item.config.competitors,
        ),
      );
  const visibleMetricAttempts = serverData
    ? analyticsAttempts
    : rangedRuns.flatMap((item) =>
        projectAttemptsForRunSubject(
          filterAttempts(item, query.question, query.model),
          previewSubject,
          item.config.competitors,
        ),
      );
  const selectedAttempt =
    (serverData &&
      live.detailAttempt?.id === query.answerId &&
      live.detailAttempt) ||
    visibleAnswerAttempts.find((attempt) => attempt.id === query.answerId) ||
    visibleAnswerAttempts.find(
      (attempt) =>
        attempt.questionId === query.answerQuestion &&
        attempt.status === "completed" &&
        attempt.answer?.trim(),
    ) ||
    visibleAnswerAttempts.find(
      (attempt) => attempt.questionId === query.answerQuestion,
    ) ||
    visibleAnswerAttempts[0];
  const exportHref = serverData
    ? live.summary?.metrics.attempts
      ? monitoringExportHref(query, project.timezone)
      : undefined
    : previewExportHref(
        query.tab === "answers" ? visibleAnswerAttempts : visibleMetricAttempts,
      );

  useEffect(() => {
    onSelectedMonitorChange?.(selectedMonitor);
  }, [onSelectedMonitorChange, selectedMonitor]);

  useEffect(() => {
    if (query.runId && query.runId !== selectedRunId) {
      onSelectedRunChange?.(query.runId);
    }
  }, [onSelectedRunChange, query.runId, selectedRunId]);

  const selectMonitor = (monitorId: string) => {
    updateQuery({
      monitorId,
      runId: undefined,
      question: undefined,
      model: undefined,
      answerQuestion: undefined,
      answerId: undefined,
      fullscreen: false,
    });
    if (!window.matchMedia?.("(max-width: 900px)").matches) return;
    window.requestAnimationFrame(() => {
      detailRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
      detailRef.current?.focus({ preventScroll: true });
    });
  };

  const changeRange = (range: DateRange) => {
    if (range === "custom") {
      updateQuery({ range });
      return;
    }
    updateQuery({ range, ...monitoringDateWindow(range, project.timezone) });
  };

  const refresh = async () => {
    if (refreshing || !canRefresh) return;
    setRefreshing(true);
    setRefreshMessage("");
    try {
      await onRefresh();
      if (serverData) await live.refresh();
      setRefreshMessage("已刷新");
    } finally {
      setRefreshing(false);
    }
  };

  return (
    <div
      className={`fm-monitoring-workspace ${isWorkbench ? "is-conversation-flow" : ""} ${listCollapsed ? "is-list-collapsed" : ""} ${monitors.length ? "" : "is-empty"} ${refreshing || loading || live.loading ? "is-refreshing" : ""}`}
      aria-busy={Boolean(refreshing || loading || live.loading)}
      data-refreshing={
        refreshing || loading || live.loading ? "true" : undefined
      }
    >
      {isWorkbench ? (
        <section
          className="monitoring-conversation-selector"
          aria-label="选择监控对象"
        >
          <div className="monitoring-conversation-selector__heading">
            <label>
              <input
                type="search"
                aria-label="搜索监控对象"
                placeholder="搜索监控对象"
                value={monitorSearch}
                onChange={(event) => {
                  setMonitorSearch(event.target.value);
                  setMonitorPage(0);
                }}
              />
            </label>
            <div>
              {!analysisOnly && (
                <button
                  type="button"
                  className="fm-primary-button"
                  onClick={onAdd}
                >
                  <Plus size={15} />
                  新建监控配置
                </button>
              )}
              {!analysisOnly && (
                <button
                  type="button"
                  className="fm-secondary-button"
                  onClick={onOpenRecycle}
                >
                  回收站{deletedCount ? `（${deletedCount}）` : ""}
                </button>
              )}
            </div>
          </div>
          <div className="monitoring-conversation-list">
            {monitors
              .filter((monitor) => monitor.name.includes(monitorSearch.trim()))
              .slice(monitorPage * 10, (monitorPage + 1) * 10)
              .map((monitor) => (
                <button
                  type="button"
                  key={monitor.id}
                  aria-pressed={query.monitorId === monitor.id}
                  onClick={() => selectMonitor(monitor.id)}
                >
                  <strong>{monitor.name}</strong>
                  <span>
                    {monitor.questionsCount} 个问题 · {monitor.platformsCount}{" "}
                    个平台 · {monitorStatusLabel(monitor.status)}
                  </span>
                </button>
              ))}
          </div>
          {monitors.filter((monitor) =>
            monitor.name.includes(monitorSearch.trim()),
          ).length > 10 && (
            <nav className="business-flow-pagination" aria-label="监控对象分页">
              <button
                disabled={monitorPage === 0}
                onClick={() => setMonitorPage((value) => value - 1)}
              >
                上一页
              </button>
              <span>第 {monitorPage + 1} 页</span>
              <button
                disabled={
                  (monitorPage + 1) * 10 >=
                  monitors.filter((monitor) =>
                    monitor.name.includes(monitorSearch.trim()),
                  ).length
                }
                onClick={() => setMonitorPage((value) => value + 1)}
              >
                下一页
              </button>
            </nav>
          )}
        </section>
      ) : (
        <MonitorListPanel
          monitors={monitors}
          selectedId={query.monitorId}
          deletedCount={deletedCount}
          collapsed={listCollapsed}
          onCollapsedChange={setListCollapsed}
          onSelect={selectMonitor}
          onAdd={onAdd}
          onOpenRecycle={onOpenRecycle}
          onOpenDetails={onOpenDetails}
          onRun={onRun}
          onToggle={onToggle}
          onDelete={onDelete}
          onFilteredIdsChange={setVisibleMonitorIds}
        />
      )}
      <section
        ref={detailRef}
        className="fm-monitor-detail"
        aria-label="所选监控工作台"
        tabIndex={-1}
      >
        {visibleSelectedMonitor ? (
          <>
            <header className="fm-monitor-hero">
              <div>
                <div className="fm-monitor-title-row">
                  <h2>{visibleSelectedMonitor.name}</h2>
                  <span
                    className={`fm-status-chip ${visibleSelectedMonitor.status}`}
                  >
                    {monitorStatusLabel(visibleSelectedMonitor.status)}
                  </span>
                </div>
                <p>
                  <span>{project.brandName}</span>
                  <i />
                  <span>{visibleSelectedMonitor.scheduleLabel}</span>
                  <i />
                  <span>每平台 {visibleSelectedMonitor.repetitions} 次</span>
                  <i />
                  <span>
                    更新于{" "}
                    {formatDateTime(
                      visibleSelectedMonitor.lastRun?.completedAt,
                    )}
                  </span>
                </p>
              </div>
              <div className="fm-monitor-actions" hidden={analysisOnly}>
                {exportHref ? (
                  <a
                    className="fm-primary-button fm-report-button"
                    href={exportHref}
                    download={
                      serverData
                        ? "monitoring-report.xlsx"
                        : "monitoring-demo.csv"
                    }
                  >
                    <Download size={14} /> 下载报告
                  </a>
                ) : (
                  <button
                    className="fm-primary-button fm-report-button"
                    disabled
                  >
                    <Download size={14} /> 下载报告
                  </button>
                )}
                <button
                  type="button"
                  className="fm-secondary-button"
                  aria-pressed={tableView}
                  onClick={() => {
                    setTableView((value) => !value);
                    updateQuery({ tab: tableView ? "overview" : "metrics" });
                  }}
                >
                  <Table2 size={14} /> {tableView ? "指标浏览" : "表格浏览"}
                </button>
                <span aria-live="polite">
                  {refreshing ? "正在刷新" : refreshMessage}
                </span>
                <button
                  type="button"
                  className="fm-icon-button"
                  disabled={!canRefresh || refreshing}
                  onClick={() => void refresh()}
                  aria-label={refreshing ? "正在刷新当前监控" : "刷新当前监控"}
                >
                  <RefreshCw
                    size={15}
                    className={refreshing ? "is-spinning" : ""}
                  />
                </button>
                {visibleSelectedMonitor.status !== "draft" && (
                  <button
                    type="button"
                    className="fm-secondary-button"
                    onClick={() => onToggle(visibleSelectedMonitor)}
                  >
                    {visibleSelectedMonitor.status === "paused" ? (
                      <Play size={14} />
                    ) : (
                      <Pause size={14} />
                    )}
                    {visibleSelectedMonitor.status === "paused"
                      ? "恢复计划"
                      : "暂停计划"}
                  </button>
                )}
                <button
                  type="button"
                  className="fm-icon-button"
                  onClick={() => onDelete(visibleSelectedMonitor)}
                  aria-label="删除当前监控"
                >
                  <Trash2 size={15} />
                </button>
                <button
                  type="button"
                  className="fm-secondary-button"
                  onClick={() => onOpenDetails(visibleSelectedMonitor)}
                >
                  <Edit3 size={14} /> 编辑监控
                </button>
                <button
                  type="button"
                  className="fm-primary-button"
                  onClick={() => onRun(visibleSelectedMonitor)}
                >
                  <Play size={15} /> 立即运行
                </button>
              </div>
            </header>
            <div className="fm-monitor-body">
              {serverData && live.error && (
                <div className="fm-data-notice" role="alert">
                  实时监控数据读取失败：{live.error}
                </div>
              )}
              <MonitoringFilterBar
                project={project}
                run={run}
                summary={serverData ? live.summary : undefined}
                question={query.question}
                model={query.model}
                range={query.range}
                from={query.from}
                to={query.to}
                subject={query.subject}
                onQuestionChange={(question) =>
                  updateQuery({
                    question,
                    answerQuestion: question,
                    answerId: undefined,
                  })
                }
                onModelChange={(model) =>
                  updateQuery({ model, answerId: undefined })
                }
                onRangeChange={changeRange}
                onDateWindowChange={(from, to) => {
                  if (from && to && from < to)
                    updateQuery({ range: "custom", from, to });
                }}
                onSubjectChange={(subject) => updateQuery({ subject })}
              />
              <MonitoringTabs
                active={query.tab}
                onChange={(tab) => updateQuery({ tab, fullscreen: false })}
              />
              <div className="fm-tab-content">
                {query.tab === "overview" && (
                  <OverviewPanel
                    monitor={visibleSelectedMonitor}
                    run={run}
                    attempts={visibleMetricAttempts}
                    subject={query.subject}
                    summary={serverData ? live.summary : undefined}
                    exportHref={exportHref}
                  />
                )}
                {query.tab === "answers" && (
                  <AnswerDetailPanel
                    attempts={visibleAnswerAttempts}
                    selected={selectedAttempt}
                    fullscreen={query.fullscreen}
                    onSelect={(attempt: RunAttempt) =>
                      updateQuery({
                        runId: attempt.runId || query.runId,
                        answerQuestion: attempt.questionId,
                        answerId: attempt.id,
                      })
                    }
                    onQuestionChange={(answerQuestion) =>
                      updateQuery({ answerQuestion, answerId: undefined })
                    }
                    onFullscreenChange={(fullscreen) =>
                      updateQuery({ fullscreen })
                    }
                    sourceScope={query.sourceScope}
                    onSourceScopeChange={(sourceScope) =>
                      updateQuery({ sourceScope })
                    }
                    detailLoading={serverData && live.answerDetailLoading}
                    hasMoreAnswers={serverData && live.hasMoreAnswers}
                    loadingMoreAnswers={live.loadingMoreAnswers}
                    onLoadMoreAnswers={live.loadMoreAnswers}
                    exportHref={exportHref}
                  />
                )}
                {query.tab === "metrics" && (
                  <MetricDetailPanel
                    attempts={visibleMetricAttempts}
                    showSentiment={query.subject === "self"}
                    analysis={serverData ? live.analysis : undefined}
                    exportHref={exportHref}
                  />
                )}
                {query.tab === "trends" && (
                  <TrendPanel
                    runs={rangedRuns}
                    current={run}
                    subject={previewSubject}
                    timezone={project.timezone}
                    showSentiment={query.subject === "self"}
                    analysis={serverData ? live.analysis : undefined}
                    exportHref={exportHref}
                  />
                )}
                {query.tab === "competitors" && (
                  <CompetitorPanel
                    run={run}
                    attempts={analyticsAttempts}
                    onEdit={() => onOpenDetails(visibleSelectedMonitor)}
                    analysis={serverData ? live.analysis : undefined}
                    exportHref={exportHref}
                  />
                )}
                {query.tab === "citations" && (
                  <CitationAnalysisPanel
                    attempts={analyticsAttempts}
                    analysis={serverData ? live.analysis : undefined}
                    exportHref={exportHref}
                  />
                )}
                {query.tab === "sources" && (
                  <SourceDistributionPanel
                    attempts={analyticsAttempts}
                    scope={query.sourceScope}
                    onScopeChange={(sourceScope) =>
                      updateQuery({ sourceScope })
                    }
                    analysis={serverData ? live.analysis : undefined}
                    exportHref={exportHref}
                  />
                )}
                {(query.tab === "goods" || query.tab === "videos") && (
                  <MediaStatisticsPanel kind={query.tab} />
                )}
              </div>
              {run?.id && (
                <button
                  type="button"
                  className="fm-run-link"
                  onClick={() => onOpenRun(visibleSelectedMonitor, run.id)}
                >
                  查看当前批次完整记录 <ChevronRight size={14} />
                </button>
              )}
            </div>
          </>
        ) : monitors.length ? (
          <div className="fm-detail-empty">
            <RadioTower size={30} />
            <h2>没有匹配的监控</h2>
            <p>请调整搜索词或重新选择监控。</p>
          </div>
        ) : (
          <div className="fm-detail-empty">
            <RadioTower size={30} />
            <h2>添加第一个问题监控</h2>
            <p>配置问题、模型与执行计划后，这里将展示运行工作台。</p>
            {!analysisOnly && (
              <button
                type="button"
                className="fm-primary-button"
                onClick={onAdd}
              >
                <Plus size={16} /> 批量添加问题
              </button>
            )}
          </div>
        )}
      </section>
    </div>
  );
}

export default function MonitoringWorkspace(props: MonitoringWorkspaceProps) {
  const serverData = Boolean(props.serverData);
  const useDataSource = serverData
    ? useMonitoringDataSource
    : usePreviewMonitoringDataSource;
  return (
    <MonitoringWorkspaceController
      key={serverData ? "server" : "preview"}
      {...props}
      useDataSource={useDataSource}
    />
  );
}
