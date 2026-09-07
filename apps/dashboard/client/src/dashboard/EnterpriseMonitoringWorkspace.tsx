import { lazy, Suspense, useRef, useState } from "react";
import { Plus, ArrowUpRight } from "lucide-react";
import { navigate } from "wouter/use-browser-location";
import { trpc } from "@/lib/trpc";
import { projectWorkspaceUrl } from "@/lib/enterprise-project";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import type { PurchasedServiceQuestion } from "./service-portal";

const MonitoringModule = lazy(() => import("@/monitoring/Workspace"));
export function EnterpriseMonitoringWorkspace({ enterpriseProjectId, questions }: { enterpriseProjectId: string; questions: PurchasedServiceQuestion[] }) {
  const progress = trpc.enterpriseProjects.monitoringProgress.useQuery({ enterpriseProjectId });
  const create = trpc.enterpriseProjects.createMonitoringProject.useMutation();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [selected, setSelected] = useState<string[]>([]);
  const [error, setError] = useState("");
  const intent = useRef<{ fingerprint: string; id: string } | undefined>(undefined);
  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!name.trim() || !selected.length || create.isPending) return;
    const fingerprint = JSON.stringify([enterpriseProjectId, name.trim(), [...selected].sort()]);
    if (intent.current?.fingerprint !== fingerprint) intent.current = { fingerprint, id: crypto.randomUUID() };
    try {
      const result = await create.mutateAsync({ enterpriseProjectId, name: name.trim(), questionIds: selected, clientRequestId: intent.current.id });
      navigate(projectWorkspaceUrl(`/monitoring-system?project=${result.projectId}&newMonitor=1`, enterpriseProjectId));
    } catch (cause) { setError(cause instanceof Error ? cause.message : "监控项目未能创建，请重试。"); }
  };
  const sources = Object.fromEntries((progress.data?.projects || []).map(project => [project.id, (project.sourceQuestions || []).map(item => item.question)]));
  return <>
    <div className="operator-monitoring-toolbar"><div><strong>优化问题 → 监控项目</strong><p>选择已保存的问题，创建监控项目后设置平台、重复次数与执行计划。</p></div><button className="operator-primary-button" onClick={() => { setError(""); setOpen(true); }}><Plus size={16} />从优化问题新建监控项目</button></div>
    <Suspense fallback={<div role="status" className="p-8">正在读取监控工作台…</div>}><MonitoringModule questionSources={sources} /></Suspense>
    <Dialog open={open} onOpenChange={value => { if (!create.isPending) setOpen(value); }}><DialogContent className="max-w-xl"><DialogTitle>从优化问题创建监控项目</DialogTitle><DialogDescription>保存本次选择的问题版本。后续修改优化问题不会改写历史监控。</DialogDescription>
      <form onSubmit={submit} className="grid gap-4"><label className="grid gap-2 text-sm">监控项目名称<input className="rounded-lg border p-3" maxLength={120} value={name} onChange={event => setName(event.target.value)} required /></label>
        <fieldset className="max-h-72 overflow-auto rounded-lg border p-3"><legend className="px-2 text-sm">优化问题 · 已选 {selected.length}</legend>{questions.length ? questions.map(question => <label key={question.id} className="flex items-start gap-3 py-2 text-sm"><input type="checkbox" checked={selected.includes(question.id)} onChange={event => setSelected(value => event.target.checked ? [...value, question.id] : value.filter(id => id !== question.id))} className="mt-1" /><span>{question.question}</span></label>) : <p className="py-3 text-sm text-muted-foreground">先在“意图优化 → 优化问题”中保存要监控的问题。</p>}</fieldset>
        {error && <p role="alert" className="text-sm text-red-700">{error}</p>}<button className="operator-primary-button" disabled={create.isPending || !name.trim() || !selected.length || selected.length > 500}>{create.isPending ? "正在创建…" : "创建并设置监控"}</button>
      </form>
    </DialogContent></Dialog>
  </>;
}

const runStatus: Record<string, string> = { queued: "等待执行", running: "执行中", completed: "已完成", succeeded: "已完成", failed: "失败", partial: "部分完成", cancelled: "已取消", waiting_quota: "等待充值" };
export function EnterpriseProgressReport({ enterpriseProjectId, historical }: { enterpriseProjectId: string; historical?: React.ReactNode }) {
  const progress = trpc.enterpriseProjects.monitoringProgress.useQuery({ enterpriseProjectId }, { refetchInterval: 10_000 });
  return <section className="page-shell operator-progress-report"><h1>进度报告</h1><p>当前企业项目最近 200 次真实监控运行。打开运行记录查看回答、引用及品牌对比。</p>
    {progress.isLoading ? <p role="status">正在读取运行结果…</p> : progress.error ? <p role="alert">{progress.error.message}</p> : <>
      <div className="operator-progress-stats">{[["监控项目", progress.data?.summary.projectCount], ["运行次数", progress.data?.summary.runCount], ["已完成尝试", progress.data?.summary.completedAttempts], ["失败尝试", progress.data?.summary.failedAttempts]].map(([label, value]) => <div key={label}><span>{label}</span><strong>{value ?? 0}</strong></div>)}</div>
      {progress.data?.runs.length ? <div className="overflow-x-auto"><table className="operator-run-table"><thead><tr><th>监控项目</th><th>发起时间</th><th>状态</th><th>执行进度</th><th>结果</th></tr></thead><tbody>{progress.data.runs.map(run => <tr key={run.id}><td>{progress.data.projects.find(project => project.id === run.projectId)?.name || "监控项目"}</td><td>{new Date(run.createdAt).toLocaleString("zh-CN")}</td><td>{runStatus[run.status] || run.status}</td><td>{run.completedAttempts + run.failedAttempts} / {run.expectedAttempts}</td><td><a href={projectWorkspaceUrl(`/monitoring-system/runs/${run.id}?project=${run.projectId}`, enterpriseProjectId)}>查看结果 <ArrowUpRight size={13} className="inline" /></a></td></tr>)}</tbody></table></div> : <div className="rounded-xl border p-8 text-sm text-muted-foreground">尚无监控运行记录。创建监控项目并执行后，报告会在这里更新。</div>}
    </>}
    {historical && <details className="mt-8 rounded-xl border p-5"><summary>历史导入报告 · 导入来源</summary>{historical}</details>}
  </section>;
}
