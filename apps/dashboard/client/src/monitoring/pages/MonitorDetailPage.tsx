import {
  ArrowLeft,
  CalendarClock,
  Edit3,
  Pause,
  Play,
  RadioTower,
  Trash2,
  TrendingUp,
} from "lucide-react";
import { useMemo, useRef, useState } from "react";
import { Link, useLocation } from "wouter";

import RunConfirmationDialog from "../components/RunConfirmationDialog";
import RunTrendAnalysis from "../components/RunTrendAnalysis";
import {
  formatDateTime,
  monitorStatusLabel,
  runStatusLabel,
  type RunStatus,
  type MonitorRun,
  type MonitorSummary,
} from "../domain";
import type { QuoteMonitorRunCost, RunCostQuoteView } from "../runBilling";

type MonitorDetailPageProps = {
  monitor?: MonitorSummary;
  runs: MonitorRun[];
  availableBalanceTenThousandths: string;
  quoteMonitorRunCost: QuoteMonitorRunCost;
  onRun: () => void | Promise<void>;
  onToggle: () => void | Promise<void>;
  onEdit: () => void;
  onDelete?: () => void | Promise<void>;
};

function dateKeyInShanghai(value?: string) {
  if (!value) return "";
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return value.slice(0, 10);
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(parsed);
  const part = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((item) => item.type === type)?.value || "";
  return `${part("year")}-${part("month")}-${part("day")}`;
}

export default function MonitorDetailPage({
  monitor,
  runs,
  availableBalanceTenThousandths,
  quoteMonitorRunCost,
  onRun,
  onToggle,
  onEdit,
  onDelete,
}: MonitorDetailPageProps) {
  const [, navigate] = useLocation();
  const [statusFilter, setStatusFilter] = useState("");
  const [dateFilter, setDateFilter] = useState("");
  const [actionError, setActionError] = useState("");
  const [confirmRun, setConfirmRun] = useState(false);
  const [runSubmitting, setRunSubmitting] = useState(false);
  const [runQuote, setRunQuote] = useState<RunCostQuoteView>();
  const [quoteLoading, setQuoteLoading] = useState(false);
  const [quoteError, setQuoteError] = useState("");
  const quoteRequestId = useRef(0);
  const filteredRuns = useMemo(
    () =>
      runs.filter(
        (run) =>
          (!statusFilter || run.status === statusFilter) &&
          (!dateFilter || dateKeyInShanghai(run.startedAt) === dateFilter),
      ),
    [dateFilter, runs, statusFilter],
  );
  if (!monitor)
    return (
      <div className="page-content">
        <div className="panel-state">
          <strong>未找到该监控</strong>
          <Link href="/monitoring-system">返回问题监控</Link>
        </div>
      </div>
    );
  const latest = runs[0];
  const runAction = async (operation: () => void | Promise<void>) => {
    setActionError("");
    try {
      await operation();
    } catch (error) {
      setActionError(
        error instanceof Error ? error.message : "操作失败，请稍后重试。",
      );
    }
  };
  const openRunConfirmation = () => {
    const requestId = quoteRequestId.current + 1;
    quoteRequestId.current = requestId;
    setConfirmRun(true);
    setRunQuote(undefined);
    setQuoteError("");
    setQuoteLoading(true);
    void Promise.resolve()
      .then(() => quoteMonitorRunCost(monitor.id))
      .then(
        (quote) => {
          if (quoteRequestId.current !== requestId) return;
          setRunQuote(quote);
          setQuoteLoading(false);
        },
        () => {
          if (quoteRequestId.current !== requestId) return;
          setQuoteError("费用估算暂不可用");
          setQuoteLoading(false);
        },
      );
  };
  return (
    <div className="page-content detail-page">
      <Link className="back-link" href="/monitoring-system">
        <ArrowLeft size={15} />
        返回全部监控
      </Link>
      <section className="detail-heading">
        <div>
          <span className={`status-chip ${monitor.status}`}>
            {monitorStatusLabel(monitor.status)}
          </span>
          <h1>{monitor.name}</h1>
          <p>
            {monitor.questionsCount} 个问题 · {monitor.platformsCount} 个平台 ·
            每平台 {monitor.repetitions} 次
          </p>
        </div>
        <div className="detail-actions">
          <button type="button" className="secondary-button" onClick={onEdit}>
            <Edit3 size={15} />
            编辑
          </button>
          {monitor.status !== "draft" && (
            <button
              type="button"
              className="secondary-button"
              onClick={() => void runAction(onToggle)}
            >
              {monitor.status === "paused" ? (
                <Play size={15} />
              ) : (
                <Pause size={15} />
              )}
              {monitor.status === "paused" ? "恢复计划" : "暂停计划"}
            </button>
          )}
          {onDelete && (
            <button
              type="button"
              className="danger-button"
              onClick={() => void runAction(onDelete)}
            >
              <Trash2 size={15} />
              删除
            </button>
          )}
          <button
            type="button"
            className="primary-button"
            onClick={openRunConfirmation}
          >
            <Play size={15} />
            立即运行
          </button>
        </div>
      </section>
      <RunConfirmationDialog
        open={confirmRun}
        monitorName={monitor.name}
        questionCount={monitor.questionsCount}
        platformCount={monitor.platformsCount}
        repetitions={monitor.repetitions}
        availableBalanceTenThousandths={availableBalanceTenThousandths}
        estimatedCostTenThousandths={runQuote?.totalAmountTenThousandths}
        quoteLoading={quoteLoading}
        quoteError={quoteError}
        scheduleSummary={monitor.scheduleLabel}
        loading={runSubmitting}
        onCancel={() => {
          quoteRequestId.current += 1;
          setConfirmRun(false);
        }}
        onConfirm={async () => {
          setRunSubmitting(true);
          setActionError("");
          try {
            await onRun();
            setConfirmRun(false);
          } catch (error) {
            setActionError(
              error instanceof Error ? error.message : "操作失败，请稍后重试。",
            );
          } finally {
            setRunSubmitting(false);
          }
        }}
      />
      {actionError && (
        <p className="form-error page-error" role="alert">
          {actionError}
        </p>
      )}
      <section className="detail-summary-grid">
        <article>
          <span>
            <CalendarClock size={16} />
            执行规则
          </span>
          <strong>{monitor.scheduleLabel}</strong>
          <small>
            下次：
            {monitor.status === "draft"
              ? "仅手动运行"
              : monitor.status === "paused"
                ? "已暂停"
                : formatDateTime(monitor.nextRunAt)}
            {monitor.waitingQuotaOccurrences
              ? ` · ${monitor.waitingQuotaOccurrences} 个历史执行点因余额不足待执行`
              : ""}
          </small>
        </article>
        <article>
          <span>
            <RadioTower size={16} />
            最近运行
          </span>
          <strong>{latest ? runStatusLabel(latest.status) : "尚未运行"}</strong>
          <small>
            {latest
              ? `${latest.metrics.completed}/${latest.metrics.expected} 次成功`
              : "创建运行后显示结果"}
          </small>
        </article>
        <article>
          <span>
            <TrendingUp size={16} />
            有效回答
          </span>
          <strong>{latest?.metrics.effectiveAnswers ?? 0}</strong>
          <small>仅统计成功且非空的模型回答</small>
        </article>
      </section>
      <section className="content-card">
        <div className="card-heading">
          <div>
            <h2>运行历史</h2>
            <p>
              每次运行保留独立的配置版本、回答和引用证据。
              {runs.length >= 100 ? "当前显示最近 100 条。" : ""}
            </p>
          </div>
          <div className="history-filters">
            <input
              type="date"
              aria-label="按日期筛选"
              value={dateFilter}
              onChange={(event) => setDateFilter(event.target.value)}
            />
            <select
              aria-label="按状态筛选"
              value={statusFilter}
              onChange={(event) => setStatusFilter(event.target.value)}
            >
              <option value="">全部状态</option>
              {(
                [
                  "queued",
                  "waiting_quota",
                  "running",
                  "completed",
                  "partial_completed",
                  "failed",
                  "review_required",
                  "cancelled",
                ] as RunStatus[]
              ).map((status) => (
                <option key={status} value={status}>
                  {runStatusLabel(status)}
                </option>
              ))}
            </select>
          </div>
        </div>
        <div className="run-table">
          <div className="run-table-head">
            <span>运行时间</span>
            <span>触发方式</span>
            <span>配置版本</span>
            <span>状态</span>
            <span>完成进度</span>
            <span />
          </div>
          {filteredRuns.length ? (
            filteredRuns.map((run, index) => (
              <button
                type="button"
                key={run.id}
                className="run-table-row"
                onClick={() =>
                  navigate(`/monitoring-system/${monitor.id}/runs/${run.id}`)
                }
              >
                <span>{formatDateTime(run.startedAt)}</span>
                <span>
                  {run.trigger === "manual"
                    ? "手动执行"
                    : run.trigger === "catch_up"
                      ? "停机补跑"
                      : "计划执行"}
                </span>
                <span>
                  V{run.version}
                  {filteredRuns[index + 1] &&
                  filteredRuns[index + 1]?.version !== run.version ? (
                    <small className="config-marker">配置变更</small>
                  ) : null}
                </span>
                <span>
                  <i className={`state-dot ${run.status}`} />
                  {runStatusLabel(run.status)}
                </span>
                <span>
                  {run.metrics.completed}/{run.metrics.expected}
                </span>
                <span>查看结果</span>
              </button>
            ))
          ) : (
            <div className="panel-state">
              <strong>{runs.length ? "没有匹配的运行" : "尚无运行历史"}</strong>
              <span>
                {runs.length
                  ? "请调整日期或状态筛选。"
                  : "点击“立即运行”或等待计划触发。"}
              </span>
            </div>
          )}
        </div>
      </section>
      <section className="content-card trend-card">
        <div className="card-heading">
          <div>
            <h2>当前配置趋势</h2>
            <p>只比较当前配置版本的已完成运行，避免不同问题和模型组合混淆。</p>
          </div>
        </div>
        <RunTrendAnalysis
          runs={runs}
          version={monitor.activeVersion || latest?.version || 1}
        />
      </section>
    </div>
  );
}
