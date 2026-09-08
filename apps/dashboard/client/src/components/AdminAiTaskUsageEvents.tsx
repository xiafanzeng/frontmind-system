import { useState } from "react";
import { trpc } from "@/lib/trpc";
import { Button } from "@/components/ui/button";
import type { AiUsageReportInput } from "../../../shared/ai-usage-report";

const tokenCount = (value: string) => BigInt(value).toLocaleString("zh-CN");
const dateTime = (value: number | null) =>
  value == null
    ? "—"
    : new Date(value).toLocaleString("zh-CN", {
        timeZone: "Asia/Shanghai",
        hour12: false,
      });

/** Mounted only after opening a task; never loads event histories for every summary row. */
export function AdminAiTaskUsageEvents({
  filter,
  taskId,
}: {
  filter: AiUsageReportInput;
  taskId: string;
}) {
  const [eventPage, setEventPage] = useState(1);
  const query = trpc.admin.aiUsage.taskEvents.useQuery(
    { ...filter, taskId, eventPage },
    {
      retry: false,
      refetchOnWindowFocus: false,
      staleTime: 15000,
    },
  );
  if (query.isLoading)
    return (
      <p className="py-4 text-sm text-muted-foreground">正在读取各轮调用…</p>
    );
  if (query.error)
    return (
      <div role="alert" className="space-y-2 text-sm text-destructive">
        <p>{query.error.message}</p>
        <Button
          variant="outline"
          size="sm"
          onClick={() => void query.refetch()}
        >
          重试事件明细
        </Button>
      </div>
    );
  const data = query.data;
  if (!data) return null;
  return (
    <section aria-label="任务各轮调用" className="min-w-0 space-y-3">
      <p className="text-xs leading-5 text-muted-foreground">
        以下为当前筛选范围内的逐次模型事件，每页 {data.pageSize}{" "}
        条。完整事件可用上方 CSV 导出，最多 50,000 条，超出时需缩小日期范围。
      </p>
      <div className="max-w-full overflow-x-auto rounded-md border bg-background">
        <table className="w-full min-w-[760px] text-left text-xs">
          <thead className="bg-muted/40 text-muted-foreground">
            <tr>
              <th className="p-2">发生时间 / Event</th>
              <th className="p-2">模型 / 档位</th>
              <th className="p-2">输入 / 输出 / 缓存 Token</th>
              <th className="p-2">标准成本 / 钱包扣减</th>
              <th className="p-2">费用同步状态</th>
            </tr>
          </thead>
          <tbody>
            {data.events.map((event) => (
              <tr key={event.id} className="border-t align-top">
                <td className="max-w-[260px] break-all p-2">
                  <p className="whitespace-nowrap">
                    {dateTime(event.occurredAt)}
                  </p>
                  <p className="mt-1 font-mono text-muted-foreground">
                    {event.eventId}
                  </p>
                </td>
                <td className="whitespace-nowrap p-2">
                  <p>{event.model}</p>
                  <p className="text-muted-foreground">
                    {event.effort ?? "档位未记录"}
                  </p>
                </td>
                <td className="whitespace-nowrap p-2 font-mono">
                  {tokenCount(event.inputTokens)} /{" "}
                  {tokenCount(event.outputTokens)} /{" "}
                  {tokenCount(event.cacheReadInputTokens)}
                </td>
                <td className="whitespace-nowrap p-2 font-mono">
                  <p>
                    {event.costCny == null ? "待核价" : `¥${event.costCny}`}
                  </p>
                  <p className="text-muted-foreground">
                    钱包 ¥{event.chargedCny}
                  </p>
                </td>
                <td className="max-w-[260px] break-words p-2">
                  <p>
                    {event.costCny == null ? "待核价" : "已记录"} ·{" "}
                    {event.costState}
                    {event.isError ? " · 失败请求" : ""}
                  </p>
                  <p className="mt-1 text-muted-foreground">
                    入账 {dateTime(event.recordedAt)}
                  </p>
                  {event.syncIssue && (
                    <p className="mt-1 text-amber-700">
                      最近同步未完成：{event.syncIssue}
                    </p>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {data.events.length === 0 && (
          <p className="p-4 text-sm text-muted-foreground">
            当前筛选范围暂无该任务事件。
          </p>
        )}
      </div>
      <div className="flex items-center justify-between gap-3 text-xs text-muted-foreground">
        <span>
          调用第 {data.eventPage} 页 · 共 {data.totalEvents} 条
        </span>
        <div className="flex gap-2">
          <Button
            variant="outline"
            size="sm"
            aria-label="上一页调用"
            disabled={eventPage <= 1 || query.isFetching}
            onClick={() => setEventPage((page) => page - 1)}
          >
            上一页
          </Button>
          <Button
            variant="outline"
            size="sm"
            aria-label="下一页调用"
            disabled={
              eventPage * data.pageSize >= data.totalEvents || query.isFetching
            }
            onClick={() => setEventPage((page) => page + 1)}
          >
            下一页
          </Button>
        </div>
      </div>
    </section>
  );
}
