import { useState } from "react";
import { trpc } from "@/lib/trpc";
import type { CustomerAiTaskUsage as TaskUsage } from "@shared/customer-ai-usage";
import { formatCnyTenThousandths } from "@/monitoring/billingView";
const syncLabels = {
  none: "暂无消耗",
  syncing: "用量同步中",
  synced: "已同步",
  partial: "用量同步中（部分已记录）",
};
export function CustomerAiTaskUsageList({ tasks }: { tasks: TaskUsage[] }) {
  if (!tasks.length) return <p>当前项目暂无智能体任务。</p>;
  return (
    <div>
      {tasks.map((task) => (
        <details key={task.runId} className="customer-ai-task-usage">
          <summary>
            {task.businessName} · {task.status} ·{" "}
            {formatCnyTenThousandths(task.chargedTenThousandths)}
          </summary>
          <dl className="grid grid-cols-2 gap-x-4 gap-y-2 py-3 text-sm">
            <dt>开始时间</dt>
            <dd>{new Date(task.startedAt).toLocaleString("zh-CN")}</dd>
            <dt>最近活动</dt>
            <dd>{new Date(task.lastActivityAt).toLocaleString("zh-CN")}</dd>
            <dt>当前阶段</dt>
            <dd>{task.phase}</dd>
            <dt>输入 Token</dt>
            <dd>{task.inputTokens}</dd>
            <dt>输出 Token</dt>
            <dd>{task.outputTokens}</dd>
            <dt>缓存 Token</dt>
            <dd>{task.cacheTokens}</dd>
            <dt>已产生费用</dt>
            <dd>{formatCnyTenThousandths(task.chargedTenThousandths)}</dd>
            <dt>用量同步状态</dt>
            <dd>{syncLabels[task.usageStatus]}</dd>
          </dl>
          {task.usageStatus === "none" ? (
            <p className="text-sm">
              当前仍在上传或准备资料，尚未产生模型调用和 Token 消耗。
            </p>
          ) : null}
        </details>
      ))}
    </div>
  );
}
export default function CustomerAiTaskUsage() {
  const [page, setPage] = useState(1);
  const [selectedProject, setSelectedProject] = useState("");
  const projects = trpc.enterpriseProjects.list.useQuery(undefined);
  const projectId = selectedProject || projects.data?.projects[0]?.id;
  const query = trpc.workspace.aiTaskUsage.useQuery(
    { page, enterpriseProjectId: projectId },
    { refetchInterval: 15000, enabled: Boolean(projectId) },
  );
  return (
    <section
      className="content-card account-settings-section"
      aria-label="智能体任务明细"
    >
      <h3>智能体任务明细</h3>
      <label>
        企业项目{" "}
        <select
          aria-label="任务消耗所属企业项目"
          value={projectId ?? ""}
          onChange={(event) => {
            setSelectedProject(event.target.value);
            setPage(1);
          }}
        >
          {projects.data?.projects.map((project) => (
            <option key={project.id} value={project.id}>
              {project.name}
            </option>
          ))}
        </select>
      </label>
      {projects.isLoading ? (
        <p role="status">正在读取企业项目…</p>
      ) : !projectId ? (
        <p>暂无可查看的企业项目。</p>
      ) : query.isLoading ? (
        <p role="status">正在读取任务消耗…</p>
      ) : query.isError ? (
        <p role="alert">任务用量暂不可用，请稍后重试。</p>
      ) : (
        <CustomerAiTaskUsageList tasks={query.data?.tasks ?? []} />
      )}
      {query.data && query.data.total > 20 ? (
        <nav className="source-pagination" aria-label="智能体任务分页">
          <span>
            共 {query.data.total} 个任务 · 第 {page} 页
          </span>
          <button
            type="button"
            disabled={page === 1}
            onClick={() => setPage(page - 1)}
          >
            上一页
          </button>
          <button
            type="button"
            disabled={page * 20 >= query.data.total}
            onClick={() => setPage(page + 1)}
          >
            下一页
          </button>
        </nav>
      ) : null}
    </section>
  );
}
