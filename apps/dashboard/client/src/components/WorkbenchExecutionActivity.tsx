import { BusinessExecutionActivity } from "./BusinessExecutionActivity";
import {
  projectBusinessExecution,
  type BusinessExecutionPhase,
} from "@shared/frontmind-general-execution";
import type { WorkbenchTaskState } from "@shared/workbench-task";
const labels: Record<string, BusinessExecutionPhase> = {
  已加入优化问题: "generating_result",
  已保存问题修改: "generating_result",
  已移除优化问题: "generating_result",
  生成品牌全域词库: "identifying_questions",
  已提交词库生成: "identifying_questions",
  从优化问题创建监控项目: "creating_monitor",
  已创建监控项目: "creating_monitor",
  保存监控配置: "creating_monitor",
  监控配置已保存: "creating_monitor",
  已确认监控费用并提交: "preparing_collection",
  监控已提交执行: "preparing_collection",
  稿件已导入并完成检查: "checking_assets",
  稿件版本已冻结: "checking_assets",
  已选择稿件: "preparing_assets",
  已选择投放草稿: "preparing_assets",
  发布标题已保存: "checking_assets",
  发布请求已受理: "submitting_publication",
};
export function workbenchPublicExecution(
  runId: string,
  records: WorkbenchTaskState["records"],
) {
  return projectBusinessExecution(
    runId,
    records.flatMap((record, rank) => {
      const phase =
        labels[record.label] ??
        (/^已选择 \d+ 家媒体并绑定稿件$/.test(record.label)
          ? "preparing_assets"
          : undefined);
      if (!phase) return [];
      return [
        {
          id: record.id,
          turnId: runId,
          rank,
          timestamp: record.timestamp,
          phase,
          status:
            record.status === "completed"
              ? ("ended" as const)
              : record.status === "failed"
                ? ("error" as const)
                : ("waiting" as const),
        },
      ];
    }),
  );
}
export function WorkbenchExecutionActivity({
  runId,
  records,
}: {
  runId: string;
  records: WorkbenchTaskState["records"];
}) {
  if (!records.length) return null;
  return (
    <BusinessExecutionActivity
      execution={workbenchPublicExecution(runId, records)}
    />
  );
}
