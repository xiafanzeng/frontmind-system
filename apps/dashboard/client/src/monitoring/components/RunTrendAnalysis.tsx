import { BarChart3 } from "lucide-react";

import { formatDateTime, type MonitorRun } from "../domain";

type RunTrendAnalysisProps = {
  runs: MonitorRun[];
  version: number;
};

const MAX_VISIBLE_RUNS = 8;

function formatPercent(value: number | undefined) {
  return value === undefined ? "—" : `${value}%`;
}

function modelLabel(
  model: NonNullable<MonitorRun["metrics"]["modelPerformance"]>[number],
) {
  const client = model.clientType === "web" ? "网页版" : "手机版";
  const mode = model.mode === "reasoning_search" ? "深度思考" : "标准问答";
  return `${model.providerCode} · ${client} · ${mode}`;
}

export default function RunTrendAnalysis({
  runs,
  version,
}: RunTrendAnalysisProps) {
  const allComparable = runs
    .filter(
      (candidate) =>
        candidate.version === version && candidate.status === "completed",
    )
    .sort(
      (left, right) =>
        new Date(left.completedAt || left.startedAt || 0).getTime() -
        new Date(right.completedAt || right.startedAt || 0).getTime(),
    );

  if (allComparable.length < 2) {
    return (
      <div className="analysis-placeholder trend-empty">
        <BarChart3 size={26} />
        <strong>当前配置版本还没有足够的可比运行</strong>
        <span>
          至少两个同版本已完成运行后显示有效回答、品牌提及率、引用和模型表现趋势。
        </span>
      </div>
    );
  }

  const comparable = allComparable.slice(-MAX_VISIBLE_RUNS);
  const modelRows = comparable.flatMap((run) =>
    (run.metrics.modelPerformance || []).map((model) => ({ run, model })),
  );

  return (
    <div className="trend-analysis">
      {allComparable.length > MAX_VISIBLE_RUNS ? (
        <p className="trend-window-note">
          当前配置 V{version} 共 {allComparable.length} 次可比运行，展示最近{" "}
          {MAX_VISIBLE_RUNS}
          次。
        </p>
      ) : null}
      <div className="trend-run-list">
        {comparable.map((candidate) => (
          <article key={candidate.id}>
            <span>
              {formatDateTime(candidate.completedAt || candidate.startedAt)}
            </span>
            <strong>{formatPercent(candidate.metrics.mentionRate)}</strong>
            <small>
              品牌提及率 · {candidate.metrics.citations} 条引用 · 有效回答{" "}
              {candidate.metrics.effectiveAnswers ??
                candidate.metrics.completed}
              个
            </small>
            <small>
              成功槽位 {candidate.metrics.completed} · 失败{" "}
              {candidate.metrics.failed} · 已停止 {candidate.metrics.stopped}
            </small>
          </article>
        ))}
      </div>

      <section className="trend-dimension">
        <header>
          <div>
            <h3>模型表现趋势</h3>
            <p>按时间顺序展示模型的真实有效回答样本。</p>
          </div>
          <small>采集样本统计</small>
        </header>
        {modelRows.length ? (
          <div className="analysis-table model-trend-table">
            <div className="analysis-table-head">
              <span>运行时间</span>
              <span>模型</span>
              <span>有效样本</span>
              <span>提及率</span>
              <span>平均位置</span>
              <span>引用</span>
            </div>
            {modelRows.map(({ run, model }) => (
              <div
                className="analysis-table-row"
                key={`${run.id}:${model.platformId}:${model.clientType}:${model.mode}`}
              >
                <span>{formatDateTime(run.completedAt || run.startedAt)}</span>
                <strong title={modelLabel(model)}>{modelLabel(model)}</strong>
                <span>{model.effectiveAnswers}</span>
                <span>{formatPercent(model.mentionRate)}</span>
                <span>{model.averageMentionPosition ?? "—"}</span>
                <span>{model.citations}</span>
              </div>
            ))}
          </div>
        ) : (
          <div className="compact-empty trend-dimension-empty">
            这些可比运行尚无可聚合的模型样本。
          </div>
        )}
      </section>
    </div>
  );
}
