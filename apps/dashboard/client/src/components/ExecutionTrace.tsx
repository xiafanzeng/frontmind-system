import type { StepGroup } from "@/contexts/ConversationContext";
import "./ExecutionTrace.css";

const safeLabels: Record<string, string> = {
  web_search_call: "检索网页",
  web_search: "检索网页",
  browser: "浏览网页",
  computer_call: "浏览与操作",
  file_search_call: "检索资料",
  file_search: "检索资料",
  reasoning: "分析任务",
  thinking: "分析任务",
};
const allowedText = new Set([
  "读取知识库",
  "读取文档",
  "读取资料",
  "检索资料",
  "检索文本",
  "读取网页",
  "检索网页",
  "搜索网页",
  "生成内容",
  "检查结果",
  "写入文件",
  "编辑文件",
  "查看目录",
  "查找文件",
]);

/** Legacy provider steps have no public-summary designation. Project only
 * known operations, never descriptions/details containing code or arguments. */
export function publicExecutionSummaries(groups: StepGroup[]) {
  const operations = new Map<string, string>();
  for (const group of groups)
    for (const step of group.steps) {
      const command =
        [
          "code_interpreter_call",
          "code_execution",
          "bash",
          "python",
          "exec_command",
        ].includes(step.type) || step.label === "执行命令";
      operations.set(
        step.id,
        command
          ? "执行命令"
          : (safeLabels[step.type] ??
              (allowedText.has(step.label) ? step.label : "执行工具操作")),
      );
    }
  const counts = new Map<string, number>();
  for (const label of operations.values())
    counts.set(label, (counts.get(label) ?? 0) + 1);
  return [...counts].map(([label, count]) =>
    label === "执行命令" ? `执行了 ${count} 个命令` : label,
  );
}
export default function ExecutionTrace({
  stepGroups,
  isRunning,
}: {
  stepGroups: StepGroup[];
  isRunning?: boolean;
}) {
  const summaries = publicExecutionSummaries(stepGroups ?? []);
  if (!summaries.length) return null;
  return (
    <section
      className="execution-trace"
      aria-label="执行过程"
      style={{
        color: "#595959",
        fontSize: 13,
        lineHeight: "22px",
        paddingBlock: 8,
      }}
    >
      <p style={{ margin: 0 }}>
        {summaries.join(" · ")}
        {isRunning ? " · 进行中" : ""}
      </p>
    </section>
  );
}
