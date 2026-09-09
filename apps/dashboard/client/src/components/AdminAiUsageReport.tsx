import { Fragment, useState } from "react";
import { toast } from "sonner";
import { trpc } from "@/lib/trpc";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  AdminDisclosure,
  AdminRecordIdentity,
} from "@/components/AdminRecordPresentation";
import {
  aiUsageReportInput,
  chinaDate,
  type AiUsageReportInput,
} from "../../../shared/ai-usage-report";
import { agentCostDisplay } from "@/lib/agent-cost";
import { AdminAiTaskUsageEvents } from "./AdminAiTaskUsageEvents";

const tokenCount = (value: string) => BigInt(value).toLocaleString("zh-CN");
const dateTime = (value: number | null) =>
  value == null
    ? "—"
    : new Date(value).toLocaleString("zh-CN", {
        timeZone: "Asia/Shanghai",
        hour12: false,
      });
const selectClass =
  "h-10 rounded-md border border-input bg-background px-3 text-sm";

export function AdminAiUsageReport({
  initialScope = "all",
}: {
  initialScope?: AiUsageReportInput["scope"];
}) {
  const [filter, setFilter] = useState<AiUsageReportInput>(() => ({
    from: chinaDate(Date.now() - 29 * 86400000),
    to: chinaDate(Date.now()),
    scope: initialScope,
    page: 1,
  }));
  const [exporting, setExporting] = useState(false);
  const [expandedTask, setExpandedTask] = useState<string | null>(null);
  const utils = trpc.useUtils();
  const valid = aiUsageReportInput.safeParse(filter).success;
  const report = trpc.admin.aiUsage.report.useQuery(filter, {
    enabled: valid,
    retry: false,
    refetchOnWindowFocus: false,
    staleTime: 15000,
  });
  const update = (change: Partial<AiUsageReportInput>) =>
    setFilter((previous) => ({ ...previous, ...change, page: 1 }));
  const preset = (kind: "yesterday" | "month" | "30days") => {
    const today = chinaDate(Date.now());
    update(
      kind === "yesterday"
        ? {
            from: chinaDate(Date.now() - 86400000),
            to: chinaDate(Date.now() - 86400000),
          }
        : {
            from:
              kind === "month"
                ? `${today.slice(0, 7)}-01`
                : chinaDate(Date.now() - 29 * 86400000),
            to: today,
          },
    );
  };
  const exportCsv = async () => {
    setExporting(true);
    try {
      const result = await utils.admin.aiUsage.export.fetch(filter);
      const url = URL.createObjectURL(
        new Blob([result.csv], { type: "text/csv;charset=utf-8" }),
      );
      const link = document.createElement("a");
      link.href = url;
      link.download = result.filename;
      link.click();
      URL.revokeObjectURL(url);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "导出失败，请重试");
    } finally {
      setExporting(false);
    }
  };
  const data = report.data;
  return (
    <section
      aria-label="AI用量对账"
      className="space-y-4 rounded-xl border border-border/70 bg-card p-4 sm:p-5"
    >
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h3 className="font-semibold">AI 用量与任务明细</h3>
          <p className="mt-1 text-xs text-muted-foreground">
            北京时间 · 按模型事件实际发生时间统计
          </p>
        </div>
        <div className="flex gap-2">
          <Button
            variant="outline"
            size="sm"
            disabled={!valid || report.isFetching}
            onClick={() => void report.refetch()}
          >
            刷新记录
          </Button>
          <Button
            variant="outline"
            size="sm"
            disabled={!valid || exporting}
            onClick={() => void exportCsv()}
          >
            {exporting ? "导出中…" : "导出事件 CSV"}
          </Button>
        </div>
      </div>
      <div className="flex flex-wrap items-end gap-3">
        <label className="space-y-1 text-xs">
          开始日期
          <Input
            aria-label="用量开始日期"
            type="date"
            value={filter.from}
            onChange={(event) => update({ from: event.target.value })}
          />
        </label>
        <label className="space-y-1 text-xs">
          结束日期
          <Input
            aria-label="用量结束日期"
            type="date"
            value={filter.to}
            onChange={(event) => update({ to: event.target.value })}
          />
        </label>
        <label className="grid gap-1 text-xs">
          来源
          <select
            aria-label="用量来源"
            className={selectClass}
            value={filter.scope}
            onChange={(event) =>
              update({
                scope: event.target.value as AiUsageReportInput["scope"],
              })
            }
          >
            <option value="all">官网与后台</option>
            <option value="website_frontend">Website 官网</option>
            <option value="managed_user">Dashboard 后台</option>
          </select>
        </label>
        <label className="grid gap-1 text-xs">
          负责人
          <select
            aria-label="用量负责人"
            className={selectClass}
            value={
              filter.owner?.kind === "name"
                ? `name:${filter.owner.value}`
                : (filter.owner?.kind ?? "")
            }
            onChange={(event) =>
              update({
                owner:
                  event.target.value === "unassigned"
                    ? { kind: "unassigned" }
                    : event.target.value.startsWith("name:")
                      ? { kind: "name", value: event.target.value.slice(5) }
                      : undefined,
              })
            }
          >
            <option value="">全部负责人</option>
            <option value="unassigned">未归属</option>
            {data?.owners.map((owner) => (
              <option key={owner} value={`name:${owner}`}>
                {owner}
              </option>
            ))}
            {filter.owner?.kind === "name" &&
              !data?.owners.includes(filter.owner.value) && (
                <option value={`name:${filter.owner.value}`}>
                  {filter.owner.value}
                </option>
              )}
          </select>
        </label>
        <label className="grid gap-1 text-xs">
          任务状态
          <select
            aria-label="用量任务状态"
            className={selectClass}
            value={filter.state ?? ""}
            onChange={(event) =>
              update({ state: event.target.value || undefined })
            }
          >
            <option value="">全部状态</option>
            {data?.states.map((state) => (
              <option key={state} value={state}>
                {state}
              </option>
            ))}
            {filter.state && !data?.states.includes(filter.state) && (
              <option value={filter.state}>{filter.state}</option>
            )}
          </select>
        </label>
        <label className="grid gap-1 text-xs">
          Key
          <select
            aria-label="用量Key"
            className={selectClass}
            value={filter.fingerprint ?? ""}
            onChange={(event) =>
              update({ fingerprint: event.target.value || undefined })
            }
          >
            <option value="">全部 Key（含历史版本）</option>
            {data?.keys.map((key) => (
              <option key={key.fingerprint} value={key.fingerprint}>
                {key.providerKeyId ?? key.fingerprint} ·{" "}
                {key.versions.join(" / ")}
              </option>
            ))}
          </select>
        </label>
        <label className="grid gap-1 text-xs">
          模型
          <select
            aria-label="用量模型"
            className={selectClass}
            value={filter.model ?? ""}
            onChange={(event) =>
              update({ model: event.target.value || undefined })
            }
          >
            <option value="">全部模型</option>
            {(data?.models.length ? data.models : ["glm-5.3"]).map((model) => (
              <option key={model} value={model}>
                {model.toUpperCase()}
              </option>
            ))}
          </select>
        </label>
        <div className="flex gap-1">
          {(
            [
              ["yesterday", "昨天"],
              ["month", "本月"],
              ["30days", "近30天"],
            ] as const
          ).map(([kind, label]) => (
            <Button
              key={kind}
              size="sm"
              variant="ghost"
              onClick={() => preset(kind)}
            >
              {label}
            </Button>
          ))}
        </div>
      </div>
      {!valid ? (
        <p className="text-sm text-destructive">
          请选择有效日期范围，最长 366 天。
        </p>
      ) : report.isLoading ? (
        <p className="py-6 text-sm text-muted-foreground">
          正在读取已记录用量…
        </p>
      ) : report.error ? (
        <p role="alert" className="py-4 text-sm text-destructive">
          {report.error.message}。可点击“刷新记录”重试。
        </p>
      ) : (
        data && (
          <>
            <div className="grid gap-3 rounded-lg bg-muted/40 p-4 sm:grid-cols-3">
              <div>
                <p className="text-xs text-muted-foreground">已记录标准成本</p>
                <p className="mt-1 font-mono text-xl font-semibold">
                  {agentCostDisplay(data.summary)}
                </p>
              </div>
              <div>
                <p className="text-xs text-muted-foreground">
                  其中已扣操作员钱包
                </p>
                <p className="mt-1 font-mono text-xl">
                  ¥{data.summary.chargedCny}
                </p>
              </div>
              <div>
                <p className="text-xs text-muted-foreground">
                  已记录任务 / 模型请求
                </p>
                <p className="mt-1 text-xl">
                  {data.summary.observedTasks} / {data.summary.observedEvents}
                </p>
              </div>
              <p className="text-sm">
                输入 {tokenCount(data.summary.inputTokens)}
              </p>
              <p className="text-sm">
                输出 {tokenCount(data.summary.outputTokens)}
              </p>
              <p className="text-sm">
                缓存读取 {tokenCount(data.summary.cacheReadInputTokens)}
              </p>
            </div>
            <AdminDisclosure label="计费口径与同步说明">
              GLM-5.3 每百万 Token：输入 ¥8、输出 ¥28、缓存读取
              ¥2；三项独立相加，无档位倍率。官网成本由平台承担，历史观察不追扣。金额和
              Token 来自同一批事件；尚未与供应商完整账单自动核对。
              {data.summary.unknownEvents > 0 &&
                ` ${data.summary.unknownEvents} 条事件待核价。`}{" "}
              最新入账：{dateTime(data.summary.lastRecordedAt)}。
            </AdminDisclosure>
            <div className="overflow-x-auto rounded-lg border">
              <table className="w-full text-left text-sm">
                <thead className="bg-white text-sm text-black">
                  <tr>
                    <th className="p-3">任务 / 负责人</th>
                    <th className="p-3">最近消耗时间</th>
                    <th className="p-3">标准成本</th>
                    <th className="p-3">明细</th>
                  </tr>
                </thead>
                <tbody>
                  {data.tasks.map((task) => (
                    <Fragment key={`${task.id}:${task.model}`}>
                      <tr className="border-t align-top">
                        <td className="max-w-[260px] p-3">
                          <AdminRecordIdentity
                            name={<span title={task.title}>{task.title}</span>}
                          />
                          <p className="mt-1 text-xs text-muted-foreground">
                            负责人：{task.businessOwnerName ?? "未归属"} ·{" "}
                            {task.scope === "website_frontend"
                              ? "官网"
                              : "后台"}
                          </p>
                        </td>
                        <td className="whitespace-nowrap p-3 text-xs">
                          {dateTime(task.lastEventAt)}
                        </td>
                        <td className="whitespace-nowrap p-3 font-mono">
                          {agentCostDisplay(task)}
                        </td>
                        <td className="p-3">
                          <Button
                            variant="ghost"
                            size="sm"
                            aria-expanded={expandedTask === task.id}
                            aria-label={`查看 ${task.title} 用量明细`}
                            onClick={() =>
                              setExpandedTask((current) =>
                                current === task.id ? null : task.id,
                              )
                            }
                          >
                            {expandedTask === task.id
                              ? "收起明细"
                              : "查看各轮调用"}
                          </Button>
                        </td>
                      </tr>
                      {expandedTask === task.id && (
                        <tr className="border-t bg-muted/20">
                          <td colSpan={4} className="p-4">
                            <div className="mb-4 grid gap-2 break-all text-xs text-muted-foreground sm:grid-cols-2">
                              <p>
                                {task.model} · {task.effort ?? "档位未记录"} ·
                                状态：{task.state}
                              </p>
                              <p>
                                所选日期内：输入 {tokenCount(task.inputTokens)}{" "}
                                / 输出 {tokenCount(task.outputTokens)} / 缓存{" "}
                                {tokenCount(task.cacheReadInputTokens)}
                              </p>
                              <p>
                                模型请求 {task.observedEvents} 条 · 已扣钱包 ¥
                                {task.chargedCny}
                              </p>
                              <p>
                                Key{" "}
                                {data.keys.find(
                                  (key) => key.fingerprint === task.fingerprint,
                                )?.providerKeyId ??
                                  task.fingerprint ??
                                  "未识别"}{" "}
                                · v{task.credentialVersion}
                              </p>
                              <p>Session：{task.sessionId}</p>
                              <p>任务：{task.id}</p>
                              <p>价格：{task.pricingVersions || "待核价"}</p>
                              {task.syncIssue && (
                                <p className="text-amber-700">
                                  最近同步未完成：{task.syncIssue}
                                </p>
                              )}
                            </div>
                            <AdminAiTaskUsageEvents
                              key={JSON.stringify({
                                ...filter,
                                taskId: task.id,
                              })}
                              filter={filter}
                              taskId={task.id}
                            />
                          </td>
                        </tr>
                      )}
                    </Fragment>
                  ))}
                </tbody>
              </table>
              {data.tasks.length === 0 && (
                <p className="p-8 text-center text-sm text-muted-foreground">
                  所选范围暂无已记录消耗。未上报用量的任务不计为零成本。
                </p>
              )}
            </div>
            <div className="flex items-center justify-between text-xs text-muted-foreground">
              <span>
                第 {data.page} 页 · {data.summary.observedTasks} 个已记录任务
              </span>
              <div className="flex gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  disabled={filter.page <= 1 || report.isFetching}
                  onClick={() =>
                    setFilter((previous) => ({
                      ...previous,
                      page: previous.page - 1,
                    }))
                  }
                >
                  上一页
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  disabled={
                    filter.page * data.pageSize >= data.summary.observedTasks ||
                    report.isFetching
                  }
                  onClick={() =>
                    setFilter((previous) => ({
                      ...previous,
                      page: previous.page + 1,
                    }))
                  }
                >
                  下一页
                </Button>
              </div>
            </div>
          </>
        )
      )}
      <details className="text-xs text-muted-foreground">
        <summary className="cursor-pointer">如何与 BigModel 账单核对</summary>
        <p className="mt-2 leading-6">
          打开 BigModel“费用账单 →
          费用明细”，选择相同月份、Key、GLM-5.3，按天或按明细对比输入、输出、缓存三项用量与目录总价。官方按明细为分钟时间桶，Session
          / Event ID 用于 FrontMind
          内部追溯。其他产品调用、未归属请求、资源抵扣、减免和结算延迟会影响官方消费金额；差额不自动分配到账户。
        </p>
        <a
          className="mt-2 inline-block text-primary underline"
          href="https://bigmodel.cn/finance-center/bill/expensebill/list"
          target="_blank"
          rel="noreferrer"
        >
          打开 BigModel 费用账单
        </a>
        {" · "}
        <a
          className="text-primary underline"
          href="https://bigmodel.cn/pricing"
          target="_blank"
          rel="noreferrer"
        >
          官方价格
        </a>
      </details>
    </section>
  );
}
