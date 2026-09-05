import type { MonitorRun, ProjectSummary } from "../../domain";
import type { MonitoringSummaryData } from "./useMonitoringDataSource";
import {
  attemptModelKey,
  attemptModelLabel,
  clientTypeLabel,
  type DateRange,
  type MonitoringSubject,
} from "./types";

type MonitoringFilterBarProps = {
  project: ProjectSummary;
  run?: MonitorRun;
  summary?: MonitoringSummaryData;
  question?: string;
  model?: string;
  range: DateRange;
  from: string;
  to: string;
  subject: MonitoringSubject;
  onQuestionChange: (value?: string) => void;
  onModelChange: (value?: string) => void;
  onRangeChange: (value: DateRange) => void;
  onDateWindowChange: (from: string, to: string) => void;
  onSubjectChange: (value: MonitoringSubject) => void;
};

export default function MonitoringFilterBar({
  project,
  run,
  summary,
  question,
  model,
  range,
  from,
  to,
  subject,
  onQuestionChange,
  onModelChange,
  onRangeChange,
  onDateWindowChange,
  onSubjectChange,
}: MonitoringFilterBarProps) {
  const questions = summary
    ? summary.filters.questions.map((item) => [item.id, item.label] as const)
    : Array.from(
        new Map(
          run?.attempts.map((attempt) => [
            attempt.questionId,
            attempt.question,
          ]) || [],
        ),
      );
  const models = summary
    ? summary.filters.platforms.map((item) => ({
        key: item.id,
        label: `${item.displayName}（${clientTypeLabel(item.clientType)}）`,
      }))
    : Array.from(
        new Map(
          run?.attempts.map((attempt) => [attemptModelKey(attempt), attempt]) ||
            [],
        ),
      ).map(([key, attempt]) => ({ key, label: attemptModelLabel(attempt) }));
  const subjects = summary
    ? summary.filters.subjects.map((item) => ({
        value:
          item.kind === "self"
            ? ("self" as const)
            : (`competitor:${item.name}` as const),
        label: item.label,
      }))
    : [
        {
          value: "self" as const,
          label: `本品 · ${run?.config.brandName || project.brandName}`,
        },
        ...(run?.config.competitors || []).map((competitor) => ({
          value: `competitor:${competitor.name}` as const,
          label: `竞品 · ${competitor.name}`,
        })),
      ];

  return (
    <section className="fm-filter-bar" aria-label="监控数据筛选">
      <label>
        <span>品牌主体</span>
        <select
          aria-label="品牌主体"
          value={subject}
          onChange={(event) =>
            onSubjectChange(event.target.value as MonitoringSubject)
          }
        >
          {subjects.map((item) => (
            <option key={item.value} value={item.value}>
              {item.label}
            </option>
          ))}
        </select>
      </label>
      <label>
        <span>问题</span>
        <select
          aria-label="按问题筛选回答"
          value={question || ""}
          disabled={!questions.length}
          onChange={(event) =>
            onQuestionChange(event.target.value || undefined)
          }
        >
          <option value="">全部问题</option>
          {questions.map(([questionId, questionLabel]) => (
            <option key={questionId} value={questionId}>
              {questionLabel}
            </option>
          ))}
        </select>
      </label>
      <label>
        <span>模型</span>
        <select
          aria-label="按模型筛选回答"
          value={model || ""}
          disabled={!models.length}
          onChange={(event) => onModelChange(event.target.value || undefined)}
        >
          <option value="">全部模型</option>
          {models.map((item) => (
            <option key={item.key} value={item.key}>
              {item.label}
            </option>
          ))}
        </select>
      </label>
      <div className="fm-date-filter" role="group" aria-label="日期筛选">
        <span>日期</span>
        <select
          aria-label="选择日期范围"
          value={range}
          onChange={(event) => onRangeChange(event.target.value as DateRange)}
        >
          <option value="7d">近 7 天</option>
          <option value="30d">近 30 天</option>
          <option value="90d">近 90 天</option>
          <option value="custom">自定义</option>
        </select>
        {range === "custom" && (
          <div className="fm-custom-date-range">
            <input
              type="date"
              aria-label="开始日期"
              value={from}
              max={to}
              onChange={(event) => onDateWindowChange(event.target.value, to)}
            />
            <span>至</span>
            <input
              type="date"
              aria-label="结束日期（不含）"
              value={to}
              min={from}
              onChange={(event) => onDateWindowChange(from, event.target.value)}
            />
          </div>
        )}
      </div>
    </section>
  );
}
