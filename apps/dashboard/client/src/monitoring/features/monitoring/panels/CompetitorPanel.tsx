import { Edit3, Medal } from "lucide-react";

import type { MonitorRun, RunAttempt } from "../../../domain";
import { buildCompetitorRows } from "../selectors";
import type { MonitoringAnalysisData } from "../useMonitoringDataSource";
import PanelFrame from "./PanelFrame";

const percent = (value?: number) =>
  typeof value === "number" ? `${value.toFixed(1)}%` : "—";

type CompetitorRow = ReturnType<typeof buildCompetitorRows>[number];

export function sortCompetitorRows(rows: CompetitorRow[]) {
  return rows
    .map((row, index) => ({ row, index }))
    .sort((left, right) => {
      const mentionDifference =
        (right.row.mentionRate ?? -1) - (left.row.mentionRate ?? -1);
      if (mentionDifference !== 0) return mentionDifference;
      const exposureDifference =
        (right.row.top3Rate ?? -1) - (left.row.top3Rate ?? -1);
      if (exposureDifference !== 0) return exposureDifference;
      const leftPosition = left.row.averagePosition ?? Number.POSITIVE_INFINITY;
      const rightPosition =
        right.row.averagePosition ?? Number.POSITIVE_INFINITY;
      if (leftPosition !== rightPosition) return leftPosition - rightPosition;
      return left.index - right.index;
    })
    .map(({ row }) => row);
}

export default function CompetitorPanel({
  run,
  attempts,
  onEdit,
  analysis,
  exportHref,
}: {
  run?: MonitorRun;
  attempts: RunAttempt[];
  onEdit: () => void;
  analysis?: MonitoringAnalysisData;
  exportHref?: string;
}) {
  const remote = analysis?.kind === "competitors" ? analysis.items : undefined;
  const rows = sortCompetitorRows(
    remote
      ? remote.map((item) => ({
          name: item.name,
          attempts: item.answerCount,
          mentions: item.appearances,
          mentionRate:
            item.mentionRate === null ? undefined : item.mentionRate * 100,
          averagePosition: item.averagePosition ?? undefined,
          top3Rate:
            item.highPositionExposure === null
              ? undefined
              : item.highPositionExposure * 100,
        }))
      : buildCompetitorRows(attempts, run?.config.competitors || []),
  );
  return (
    <PanelFrame
      id="monitor-competitors"
      labelledBy="monitor-tab-competitors"
      icon={<Medal size={17} />}
      title="竞品排名"
      meta="运行版本中的竞品配置"
      exportHref={exportHref}
      exportFileName="frontmind-monitoring-competitors.xlsx"
    >
      {rows.length ? (
        <div className="fm-ranking-list">
          {rows.map((row, index) => (
            <article key={row.name}>
              <span className="fm-rank">{index + 1}</span>
              <strong>{row.name}</strong>
              <div>
                <span>提及率 {percent(row.mentionRate)}</span>
                <span>平均排名 {row.averagePosition?.toFixed(1) || "—"}</span>
                <span>Top3 {percent(row.top3Rate)}</span>
                <span>
                  {row.mentions}/{row.attempts} 条有效回答提及
                </span>
              </div>
            </article>
          ))}
        </div>
      ) : (
        <div className="fm-empty">
          <Medal size={24} />
          <strong>当前版本没有竞品配置</strong>
          <span>竞品指标只从不可变运行配置和 API 排名事实计算。</span>
          <button
            type="button"
            className="fm-secondary-button"
            onClick={onEdit}
          >
            <Edit3 size={14} /> 编辑监控
          </button>
        </div>
      )}
    </PanelFrame>
  );
}
