import { BarChart3, Medal, RadioTower, Target } from "lucide-react";

import {
  runStatusLabel,
  type MonitorRun,
  type MonitorSummary,
  type RunAttempt,
} from "../../../domain";
import { calculateEvidenceMetrics } from "../selectors";
import type { MonitoringSubject } from "../types";
import type { MonitoringSummaryData } from "../useMonitoringDataSource";
import PanelFrame from "./PanelFrame";

function percentage(value?: number) {
  return typeof value === "number" ? `${value.toFixed(1)}%` : "—";
}

export default function OverviewPanel({
  monitor,
  run,
  attempts,
  subject,
  summary,
  exportHref,
}: {
  monitor: MonitorSummary;
  run?: MonitorRun;
  attempts: RunAttempt[];
  subject: MonitoringSubject;
  summary?: MonitoringSummaryData;
  exportHref?: string;
}) {
  const metrics = run?.metrics;
  const localEvidence = calculateEvidenceMetrics(attempts);
  const evidence = summary
    ? {
        total: summary.metrics.attempts,
        completed: summary.metrics.answers,
        effective: summary.metrics.answers,
        mentionRate:
          summary.metrics.mentionRate === null
            ? undefined
            : summary.metrics.mentionRate * 100,
        top1Rate:
          summary.metrics.top1Rate === null
            ? undefined
            : summary.metrics.top1Rate * 100,
        top3Rate:
          summary.metrics.top3Rate === null
            ? undefined
            : summary.metrics.top3Rate * 100,
        top10Rate:
          summary.metrics.top10Rate === null
            ? undefined
            : summary.metrics.top10Rate * 100,
        averagePosition: summary.metrics.averagePosition ?? undefined,
        citations: summary.metrics.citationCount,
      }
    : localEvidence;
  const effective = evidence.effective;
  const sentiment = summary?.metrics.sentiments || {
    positive: 0,
    neutral: 0,
    negative: 0,
    unknown: 0,
  };
  if (!summary && subject === "self") {
    for (const attempt of attempts.filter(
      (item) => item.status === "completed" && item.answer?.trim(),
    )) {
      sentiment[attempt.sentiment || "unknown"] += 1;
    }
  }
  const sentimentAvailable =
    subject === "self" && Boolean(summary?.metrics.sentiments || metrics);
  const progress = summary?.metrics.attempts
    ? Math.round((summary.metrics.answers / summary.metrics.attempts) * 100)
    : metrics?.expected
      ? Math.round((metrics.completed / metrics.expected) * 100)
      : monitor.lastRun?.expected
        ? Math.round(
            (monitor.lastRun.completed / monitor.lastRun.expected) * 100,
          )
        : 0;

  return (
    <PanelFrame
      id="monitor-overview"
      labelledBy="monitor-tab-overview"
      icon={<BarChart3 size={17} />}
      title="指标看板"
      meta={
        summary
          ? `${summary.metrics.runs} 个批次`
          : run
            ? `配置 V${run.version}`
            : "尚无运行"
      }
      exportHref={exportHref}
      exportFileName="frontmind-monitoring-overview.xlsx"
    >
      <div className="fm-metric-grid">
        <article className="violet">
          <RadioTower size={18} />
          <span>提问次数</span>
          <strong>{evidence.total}</strong>
          <small>日期范围内全部尝试</small>
        </article>
        <article className="blue">
          <Target size={18} />
          <span>提及率</span>
          <strong>{percentage(evidence.mentionRate)}</strong>
          <small>{effective} 条有效回答作分母</small>
        </article>
        <article className="cyan">
          <BarChart3 size={18} />
          <span>平均排名</span>
          <strong>{evidence.averagePosition?.toFixed(1) || "—"}</strong>
          <small>仅有效且提及的回答</small>
        </article>
        <article className="amber">
          <Medal size={18} />
          <span>Top1</span>
          <strong>{percentage(evidence.top1Rate)}</strong>
          <small>有效回答高位曝光</small>
        </article>
        <article className="green">
          <Medal size={18} />
          <span>Top3</span>
          <strong>{percentage(evidence.top3Rate)}</strong>
          <small>有效回答前三曝光</small>
        </article>
        <article className="rose">
          <Medal size={18} />
          <span>Top10</span>
          <strong>{percentage(evidence.top10Rate)}</strong>
          <small>有效回答前十曝光</small>
        </article>
      </div>
      <div className="fm-overview-grid">
        <section className="fm-card">
          <header className="fm-card-heading">
            <div>
              <RadioTower size={17} />
              <h3>{summary ? "范围采集概况" : "本轮采集概况"}</h3>
            </div>
            <span>
              {summary
                ? `${summary.metrics.runs} 个批次`
                : run
                  ? runStatusLabel(run.status)
                  : "尚无运行"}
            </span>
          </header>
          {summary ? (
            <div className="fm-progress-summary">
              <div
                className="fm-progress-ring"
                style={
                  {
                    "--progress": `${progress * 3.6}deg`,
                  } as React.CSSProperties
                }
              >
                <strong>{progress}%</strong>
                <span>有效回答率</span>
              </div>
              <dl>
                <div>
                  <dt>执行批次</dt>
                  <dd>{summary.metrics.runs}</dd>
                </div>
                <div>
                  <dt>全部尝试</dt>
                  <dd>{summary.metrics.attempts}</dd>
                </div>
                <div>
                  <dt>有效回答</dt>
                  <dd>{summary.metrics.answers}</dd>
                </div>
                <div>
                  <dt>实际引用</dt>
                  <dd>{summary.metrics.citationCount}</dd>
                </div>
              </dl>
            </div>
          ) : metrics ? (
            <div className="fm-progress-summary">
              <div
                className="fm-progress-ring"
                style={
                  {
                    "--progress": `${progress * 3.6}deg`,
                  } as React.CSSProperties
                }
              >
                <strong>{progress}%</strong>
                <span>完成进度</span>
              </div>
              <dl>
                <div>
                  <dt>计划尝试</dt>
                  <dd>{metrics.expected}</dd>
                </div>
                <div>
                  <dt>已完成</dt>
                  <dd>{metrics.completed}</dd>
                </div>
                <div>
                  <dt>处理中</dt>
                  <dd>{metrics.processing}</dd>
                </div>
                <div>
                  <dt>失败/停止</dt>
                  <dd>{metrics.failed + metrics.stopped}</dd>
                </div>
              </dl>
            </div>
          ) : (
            <div className="fm-empty">
              <strong>尚无运行数据</strong>
              <span>立即运行后，此处会显示真实采集进度。</span>
            </div>
          )}
        </section>
        <section className="fm-card">
          <header className="fm-card-heading">
            <div>
              <BarChart3 size={17} />
              <h3>回答倾向</h3>
            </div>
            <span>有效结果</span>
          </header>
          {sentimentAvailable ? (
            <div className="fm-sentiment-list">
              {(
                [
                  ["positive", "正向", sentiment.positive],
                  ["neutral", "中性", sentiment.neutral],
                  ["negative", "负向", sentiment.negative],
                  ["unknown", "未识别", sentiment.unknown],
                ] as const
              ).map(([tone, label, value]) => (
                <div key={tone}>
                  <span>
                    <i className={tone} />
                    {label}
                  </span>
                  <strong>{value}</strong>
                  <div>
                    <i
                      className={tone}
                      style={{
                        width: `${effective ? Math.min(100, (value / effective) * 100) : 0}%`,
                      }}
                    />
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <div className="fm-empty">
              <strong>
                {subject === "self" ? "尚无倾向数据" : "竞品主体不提供回答倾向"}
              </strong>
              <span>
                {subject === "self"
                  ? "供应商返回有效回答后再进行统计。"
                  : "情感事实描述整条回答，不会被推断为某个竞品的倾向。"}
              </span>
            </div>
          )}
        </section>
      </div>
    </PanelFrame>
  );
}
