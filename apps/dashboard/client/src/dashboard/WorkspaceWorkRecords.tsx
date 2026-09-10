import { useState } from "react";
import type { OperatorView } from "./operator-navigation";
import { trpc } from "@/lib/trpc";
import { projectWorkspaceUrl } from "@/lib/enterprise-project";

/** Public business results are separate from conversations and cannot be deleted as tasks. */
export function WorkspaceWorkRecords({
  projectId,
  module,
}: {
  projectId: string;
  module: Exclude<OperatorView, "knowledge-display">;
}) {
  const [cursor, setCursor] = useState<string | undefined>();
  const records = trpc.workspace.workRecords.list.useQuery(
    { enterpriseProjectId: projectId, module, limit: 20, cursor },
    {
      refetchOnWindowFocus: true,
      refetchOnMount: "always",
      refetchInterval: 30_000,
    },
  );
  return (
    <div className="workspace-work-records" aria-label="业务成果记录">
      {records.isLoading ? (
        <p role="status">正在读取工作记录…</p>
      ) : records.error ? (
        <div role="alert">
          <p>{records.error.message}</p>
          <button type="button" onClick={() => void records.refetch()}>
            重新读取记录
          </button>
        </div>
      ) : (
        <>
          {records.data?.records.map((record) => (
            <article key={record.id}>
              <strong>{record.title}</strong>
              <p>{record.summary}</p>
              <small>
                {new Date(record.createdAt).toLocaleString("zh-CN")} ·{" "}
                {String(record.status) === "submitted"
                  ? "已提交"
                  : record.status === "updated"
                    ? "已更新"
                    : "已完成"}
              </small>
              {record.resourceRef && (
                <a href={projectWorkspaceUrl(record.resourceRef, projectId)}>
                  打开结果
                </a>
              )}
            </article>
          ))}
          {!records.data?.records.length && <p>暂无业务成果记录。</p>}
          {cursor && (
            <button type="button" onClick={() => setCursor(undefined)}>
              最新记录
            </button>
          )}
          {records.data?.nextCursor && (
            <button
              type="button"
              onClick={() => setCursor(records.data!.nextCursor!)}
            >
              更早记录
            </button>
          )}
        </>
      )}
    </div>
  );
}
