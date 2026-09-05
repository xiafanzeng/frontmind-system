import { Table2 } from "lucide-react";
import { useState } from "react";

import type { RunAttempt } from "../../../domain";
import { buildMetricRows } from "../selectors";
import type { AttemptMetricRow } from "../types";
import type { MonitoringAnalysisData } from "../useMonitoringDataSource";
import PanelFrame from "./PanelFrame";

function number(value?: number, suffix = "") {
  return typeof value === "number" ? `${value.toFixed(1)}${suffix}` : "—";
}

type MetricRow = Omit<AttemptMetricRow, "sentiment"> & {
  sentiment?: AttemptMetricRow["sentiment"];
};

export function metricRowsFromAnalysis(
  analysis: Extract<MonitoringAnalysisData, { kind: "metrics" }>,
): MetricRow[] {
  return analysis.rows.map((item) => ({
    key: item.questionId,
    question: item.question,
    total: item.metrics.attempts,
    completed: item.metrics.answers,
    effective: item.metrics.answers,
    mentionRate:
      item.metrics.mentionRate === null
        ? undefined
        : item.metrics.mentionRate * 100,
    top1Rate:
      item.metrics.top1Rate === null ? undefined : item.metrics.top1Rate * 100,
    top3Rate:
      item.metrics.top3Rate === null ? undefined : item.metrics.top3Rate * 100,
    top10Rate:
      item.metrics.top10Rate === null
        ? undefined
        : item.metrics.top10Rate * 100,
    averagePosition: item.metrics.averagePosition ?? undefined,
    citations: item.metrics.citationCount,
    sentiment: item.metrics.sentiments ?? undefined,
  }));
}

export default function MetricDetailPanel({
  attempts,
  analysis,
  exportHref,
  showSentiment = true,
}: {
  attempts: RunAttempt[];
  analysis?: MonitoringAnalysisData;
  exportHref?: string;
  showSentiment?: boolean;
}) {
  const remote = analysis?.kind === "metrics" ? analysis : undefined;
  const sourceRows: MetricRow[] = remote
    ? metricRowsFromAnalysis(remote)
    : buildMetricRows(attempts);
  const rows = showSentiment
    ? sourceRows
    : sourceRows.map((row) => ({ ...row, sentiment: undefined }));
  type SortKey =
    | "question"
    | "total"
    | "mentionRate"
    | "top1Rate"
    | "top3Rate"
    | "top10Rate"
    | "averagePosition"
    | "positive"
    | "neutral"
    | "negative";
  const [sort, setSort] = useState<{
    key: SortKey;
    direction: "ascending" | "descending";
  }>({ key: "total", direction: "descending" });
  const valueFor = (row: (typeof rows)[number], key: SortKey) =>
    key === "positive" || key === "neutral" || key === "negative"
      ? (row.sentiment?.[key] ?? -1)
      : (row[key] ?? -1);
  const sortedRows = rows
    .map((row, index) => ({ row, index }))
    .sort((leftEntry, rightEntry) => {
      const left = leftEntry.row;
      const right = rightEntry.row;
      const leftValue = valueFor(left, sort.key);
      const rightValue = valueFor(right, sort.key);
      const compared =
        typeof leftValue === "string"
          ? leftValue.localeCompare(String(rightValue), "zh-CN")
          : Number(leftValue) - Number(rightValue);
      if (compared === 0) return leftEntry.index - rightEntry.index;
      return sort.direction === "ascending" ? compared : -compared;
    })
    .map(({ row }) => row);
  const heading = (key: SortKey, label: string) => (
    <th aria-sort={sort.key === key ? sort.direction : "none"}>
      <button
        type="button"
        onClick={() =>
          setSort((current) => ({
            key,
            direction:
              current.key === key && current.direction === "descending"
                ? "ascending"
                : "descending",
          }))
        }
      >
        {label}
        <span aria-hidden="true">↕</span>
      </button>
    </th>
  );
  return (
    <PanelFrame
      id="monitor-metrics"
      labelledBy="monitor-tab-metrics"
      icon={<Table2 size={17} />}
      title="指标明细"
      meta={
        remote
          ? `当前筛选 · ${rows.length} 组问题数据`
          : `${rows.length} 组问题数据`
      }
      exportHref={exportHref}
      exportFileName="frontmind-monitoring-metrics.xlsx"
    >
      {rows.length ? (
        <div className="fm-table-scroll">
          <table className="fm-data-table">
            <thead>
              <tr>
                {heading("question", "监控问题")}
                {heading("total", "提问次数")}
                {heading("mentionRate", "提及率")}
                {heading("averagePosition", "平均排名")}
                {heading("top1Rate", "Top1")}
                {heading("top3Rate", "Top3")}
                {heading("top10Rate", "Top10")}
                {heading("positive", "正面")}
                {heading("neutral", "中性")}
                {heading("negative", "负面")}
              </tr>
            </thead>
            <tbody>
              {sortedRows.map((row) => (
                <tr key={row.key}>
                  <td title={row.question}>{row.question}</td>
                  <td>{row.total}</td>
                  <td>{number(row.mentionRate, "%")}</td>
                  <td>{number(row.averagePosition)}</td>
                  <td>{number(row.top1Rate, "%")}</td>
                  <td>{number(row.top3Rate, "%")}</td>
                  <td>{number(row.top10Rate, "%")}</td>
                  <td>{row.sentiment?.positive ?? "—"}</td>
                  <td>{row.sentiment?.neutral ?? "—"}</td>
                  <td>{row.sentiment?.negative ?? "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <div className="fm-empty">
          <Table2 size={24} />
          <strong>没有指标明细</strong>
          <span>完成采集后按问题和模型生成真实聚合。</span>
        </div>
      )}
    </PanelFrame>
  );
}
