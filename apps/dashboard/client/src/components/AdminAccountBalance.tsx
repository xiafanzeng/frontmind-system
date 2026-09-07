import { trpc } from "@/lib/trpc";
import { formatCnyTenThousandths } from "@/monitoring/billingView";

const sources = [
  ["monitoring", "问题监控消耗"],
  ["media_publishing", "媒体投放消耗"],
  ["ai", "智能体消耗"],
] as const;

export default function AdminAccountBalance({ userId }: { userId: number }) {
  const query = trpc.admin.workspace.accountBalance.useQuery({ userId }, { retry: false, refetchInterval: 30_000 });
  const balance = query.data;
  return <section className="mt-5 border-t border-border pt-5" aria-label="客户余额与消费">
    <div className="flex items-center justify-between gap-3"><h3 className="font-semibold">账户余额</h3><span className="text-xs text-muted-foreground">客户账号 · 按量使用</span></div>
    {query.error ? <p role="alert" className="mt-3 text-sm text-destructive">{query.error.message}<button className="ml-3 underline" onClick={() => void query.refetch()}>重试</button></p> : <>
      <p className="mt-3 font-mono text-3xl font-semibold">{query.isLoading ? "读取中…" : formatCnyTenThousandths(balance?.availableTenThousandths)}</p>
      <div className="mt-4 grid gap-3 sm:grid-cols-3">{sources.map(([source, label]) => <div key={source} className="rounded-xl border border-border bg-muted/20 p-4"><p className="text-xs text-muted-foreground">{label}</p><p className="mt-2 font-mono text-lg font-semibold">{formatCnyTenThousandths(balance?.consumptionBySource?.[source]?.last30DaysTenThousandths)}</p><small className="text-muted-foreground">近30天 · 累计 {formatCnyTenThousandths(balance?.consumptionBySource?.[source]?.totalTenThousandths)}</small></div>)}</div>
      <p className="mt-3 text-xs text-muted-foreground">智能体消耗包含知识库、词库、应答逻辑、内容制作与其他 AI 流程。</p>
    </>}
  </section>;
}
