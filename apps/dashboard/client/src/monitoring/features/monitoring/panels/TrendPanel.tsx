import { TrendingUp } from "lucide-react";
import { useMemo, useState } from "react";

import type { MonitorRun } from "../../../domain";
import { monitoringLocalCalendarDate } from "../queryState";
import {
  calculateEvidenceMetrics,
  projectAttemptsForRunSubject,
  type MonitoringProjectionSubject,
} from "../selectors";
import type { MonitoringAnalysisData } from "../useMonitoringDataSource";
import PanelFrame from "./PanelFrame";

type TrendView =
  "mentionRate" | "averagePosition" | "positionDistribution" | "sentiment";

type TrendPoint = {
  date: string;
  mentionRate?: number;
  averagePosition?: number;
  top1Rate?: number;
  top3Rate?: number;
  top10Rate?: number;
  sentiment: {
    positive: number;
    neutral: number;
    negative: number;
    unknown: number;
  };
};

const views: Array<{ id: TrendView; label: string }> = [
  { id: "mentionRate", label: "提及率" },
  { id: "averagePosition", label: "平均排名" },
  { id: "positionDistribution", label: "位置分布" },
  { id: "sentiment", label: "情感倾向" },
];

function percent(value?: number) {
  return typeof value === "number" ? `${value.toFixed(1)}%` : "—";
}

export function previewPoints(
  runs: MonitorRun[],
  subject: MonitoringProjectionSubject = "self",
  timezone = "Asia/Shanghai",
): TrendPoint[] {
  const attemptsByDate = new Map<
    string,
    ReturnType<typeof projectAttemptsForRunSubject>
  >();
  for (const run of runs) {
    const date = monitoringLocalCalendarDate(new Date(run.createdAt), timezone);
    const projected = projectAttemptsForRunSubject(
      run.attempts,
      subject,
      run.config.competitors,
    );
    attemptsByDate.set(date, [
      ...(attemptsByDate.get(date) || []),
      ...projected,
    ]);
  }
  return [...attemptsByDate.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([date, attempts]) => {
      const metrics = calculateEvidenceMetrics(attempts);
      const sentiment = { positive: 0, neutral: 0, negative: 0, unknown: 0 };
      if (subject === "self") {
        for (const attempt of attempts.filter(
          (item) => item.status === "completed" && item.answer?.trim(),
        )) {
          sentiment[attempt.sentiment || "unknown"] += 1;
        }
      }
      return {
        date,
        mentionRate: metrics.mentionRate,
        averagePosition: metrics.averagePosition,
        top1Rate: metrics.top1Rate,
        top3Rate: metrics.top3Rate,
        top10Rate: metrics.top10Rate,
        sentiment,
      };
    });
}

export default function TrendPanel({
  runs,
  current,
  subject = "self",
  timezone,
  analysis,
  exportHref,
  showSentiment = true,
}: {
  runs: MonitorRun[];
  current?: MonitorRun;
  subject?: MonitoringProjectionSubject;
  timezone: string;
  analysis?: MonitoringAnalysisData;
  exportHref?: string;
  showSentiment?: boolean;
}) {
  const [view, setView] = useState<TrendView>("mentionRate");
  const points = useMemo<TrendPoint[]>(() => {
    if (analysis?.kind !== "trends") {
      return previewPoints(runs, subject, timezone);
    }
    return analysis.points.map((point) => ({
      date: point.date,
      mentionRate:
        point.metrics.mentionRate === null
          ? undefined
          : point.metrics.mentionRate * 100,
      averagePosition: point.metrics.averagePosition ?? undefined,
      top1Rate:
        point.metrics.top1Rate === null
          ? undefined
          : point.metrics.top1Rate * 100,
      top3Rate:
        point.metrics.top3Rate === null
          ? undefined
          : point.metrics.top3Rate * 100,
      top10Rate:
        point.metrics.top10Rate === null
          ? undefined
          : point.metrics.top10Rate * 100,
      sentiment: point.metrics.sentiments || {
        positive: 0,
        neutral: 0,
        negative: 0,
        unknown: 0,
      },
    }));
  }, [analysis, runs, subject, timezone]);
  const singleValues = points.map((point) =>
    view === "averagePosition" ? point.averagePosition : point.mentionRate,
  );
  const singleMaximum =
    view === "mentionRate"
      ? 100
      : Math.max(
          1,
          ...singleValues.filter(
            (value): value is number => typeof value === "number",
          ),
        );

  return (
    <PanelFrame
      id="monitor-trends"
      labelledBy="monitor-tab-trends"
      icon={<TrendingUp size={17} />}
      title="趋势分析"
      meta={
        analysis?.kind === "trends"
          ? "按项目时区日历分桶"
          : current
            ? `配置 V${current.version}`
            : "尚无运行"
      }
      exportHref={exportHref}
      exportFileName="frontmind-monitoring-trends.xlsx"
    >
      <div className="fm-trend-controls">
        <div className="fm-segmented" role="group" aria-label="趋势分析视图">
          {views.map((item) => (
            <button
              key={item.id}
              type="button"
              className={view === item.id ? "active" : ""}
              aria-pressed={view === item.id}
              onClick={() => setView(item.id)}
            >
              {item.label}
            </button>
          ))}
        </div>
        <span>缺失点显示为 “—”，不进行插值</span>
      </div>
      {view === "sentiment" && !showSentiment ? (
        <div className="fm-empty">
          <TrendingUp size={24} />
          <strong>竞品主体不提供情感倾向</strong>
          <span>情感事实描述整条回答，不会被推断为某个竞品的倾向。</span>
        </div>
      ) : points.length ? (
        <>
          <div className={`fm-trend-plot ${view}`} aria-hidden="true">
            {points.map((point) => {
              const singleValue =
                view === "averagePosition"
                  ? point.averagePosition
                  : point.mentionRate;
              const sentimentTotal = Object.values(point.sentiment).reduce(
                (sum, value) => sum + value,
                0,
              );
              return (
                <article key={`${view}-${point.date}`}>
                  {view === "mentionRate" || view === "averagePosition" ? (
                    <div className="fm-trend-single-bar">
                      <span>
                        {view === "mentionRate"
                          ? percent(singleValue)
                          : singleValue?.toFixed(1) || "—"}
                      </span>
                      <i
                        className={
                          singleValue === undefined ? "is-missing" : ""
                        }
                        style={{
                          height: `${singleValue === undefined ? 2 : Math.max(3, (singleValue / singleMaximum) * 100)}%`,
                        }}
                      />
                    </div>
                  ) : view === "positionDistribution" ? (
                    <div className="fm-trend-grouped-bars">
                      {[point.top1Rate, point.top3Rate, point.top10Rate].map(
                        (value, index) => (
                          <i
                            key={index}
                            className={`series-${index + 1} ${value === undefined ? "is-missing" : ""}`}
                            style={{
                              height: `${value === undefined ? 2 : Math.max(3, value)}%`,
                            }}
                          />
                        ),
                      )}
                    </div>
                  ) : (
                    <div className="fm-trend-stacked-bar">
                      {(
                        Object.entries(point.sentiment) as Array<
                          [keyof TrendPoint["sentiment"], number]
                        >
                      ).map(([tone, value]) => (
                        <i
                          key={tone}
                          className={tone}
                          style={{
                            height: `${sentimentTotal ? (value / sentimentTotal) * 100 : 0}%`,
                          }}
                        />
                      ))}
                    </div>
                  )}
                  <small>{point.date.slice(5)}</small>
                </article>
              );
            })}
          </div>
          <div className="fm-trend-legend" aria-hidden="true">
            {view === "positionDistribution" && (
              <>
                <span className="series-1">Top1</span>
                <span className="series-2">Top3</span>
                <span className="series-3">Top10</span>
              </>
            )}
            {view === "sentiment" && (
              <>
                <span className="positive">正向</span>
                <span className="neutral">中性</span>
                <span className="negative">负向</span>
                <span className="unknown">未知</span>
              </>
            )}
          </div>
          <div className="fm-table-scroll fm-trend-table">
            <table className="fm-data-table">
              <caption className="fm-visually-hidden">
                {views.find((item) => item.id === view)?.label}趋势数据
              </caption>
              <thead>
                <tr>
                  <th>日期</th>
                  {view === "mentionRate" && <th>提及率</th>}
                  {view === "averagePosition" && <th>平均排名</th>}
                  {view === "positionDistribution" && (
                    <>
                      <th>Top1</th>
                      <th>Top3</th>
                      <th>Top10</th>
                    </>
                  )}
                  {view === "sentiment" && (
                    <>
                      <th>正向</th>
                      <th>中性</th>
                      <th>负向</th>
                      <th>未知</th>
                    </>
                  )}
                </tr>
              </thead>
              <tbody>
                {points.map((point) => (
                  <tr key={`${view}-row-${point.date}`}>
                    <td>{point.date}</td>
                    {view === "mentionRate" && (
                      <td>{percent(point.mentionRate)}</td>
                    )}
                    {view === "averagePosition" && (
                      <td>{point.averagePosition?.toFixed(1) || "—"}</td>
                    )}
                    {view === "positionDistribution" && (
                      <>
                        <td>{percent(point.top1Rate)}</td>
                        <td>{percent(point.top3Rate)}</td>
                        <td>{percent(point.top10Rate)}</td>
                      </>
                    )}
                    {view === "sentiment" && (
                      <>
                        <td>{point.sentiment.positive}</td>
                        <td>{point.sentiment.neutral}</td>
                        <td>{point.sentiment.negative}</td>
                        <td>{point.sentiment.unknown}</td>
                      </>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      ) : (
        <div className="fm-empty">
          <TrendingUp size={24} />
          <strong>尚无趋势数据</strong>
          <span>完成至少一次运行后，可查看随时间变化的真实指标。</span>
        </div>
      )}
    </PanelFrame>
  );
}
