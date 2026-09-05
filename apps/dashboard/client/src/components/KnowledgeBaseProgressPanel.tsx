import {
  AlertTriangle,
  Archive,
  Check,
  ChevronRight,
  Circle,
  CircleDot,
  FastForward,
  Loader2,
  ShieldAlert,
  Waypoints,
} from "lucide-react";

import type {
  KnowledgeBaseLeafStatus,
  KnowledgeBaseProgressBranchDto,
  KnowledgeBaseProgressDto,
} from "@shared/knowledge-base-progress";

export type { KnowledgeBaseProgressDto };

export interface KnowledgeBaseProgressPanelProps {
  progress?: KnowledgeBaseProgressDto | null;
  loading?: boolean;
  className?: string;
  title?: string;
  emptyMessage?: string;
}

const MAX_PERCENT = 100;

const leafStatusLabels: Record<KnowledgeBaseLeafStatus, string> = {
  confirmed: "企业已确认",
  direct_prefilled: "直接预填",
  current: "等待确认",
  needs_verification: "待再次确认",
  pending: "待处理",
};

const leafStatusClassNames: Record<KnowledgeBaseLeafStatus, string> = {
  confirmed: "border-emerald-200 bg-emerald-50 text-emerald-800",
  direct_prefilled: "border-sky-200 bg-sky-50 text-sky-800",
  current:
    "border-violet-300 bg-violet-50 text-violet-900 shadow-[0_8px_24px_rgba(91,42,134,.10)]",
  needs_verification: "border-amber-300 bg-amber-50 text-amber-900",
  pending: "border-slate-200 bg-white text-slate-500",
};

function clampCount(value: number, total?: number) {
  if (!Number.isFinite(value)) return 0;
  const normalized = Math.max(0, Math.round(value));
  return typeof total === "number"
    ? Math.min(normalized, Math.max(0, Math.round(total)))
    : normalized;
}

function percentFromCounts(handled: number, total: number) {
  if (total <= 0) return 0;
  return Math.min(
    MAX_PERCENT,
    Math.max(0, Math.round((handled / total) * MAX_PERCENT)),
  );
}

function normalizedOverallPercent(progress: KnowledgeBaseProgressDto) {
  const provided = progress.summary.overallPercent;
  if (Number.isFinite(provided)) {
    return Math.min(MAX_PERCENT, Math.max(0, Math.round(provided)));
  }
  return percentFromCounts(progress.summary.handled, progress.summary.total);
}

function formatUpdatedAt(timestamp: number) {
  if (!Number.isFinite(timestamp) || timestamp <= 0) return "时间待同步";
  return new Date(timestamp).toLocaleString("zh-CN", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
}

function LeafStatusIcon({ status }: { status: KnowledgeBaseLeafStatus }) {
  if (status === "confirmed") {
    return <Check aria-hidden="true" className="h-3.5 w-3.5" />;
  }
  if (status === "direct_prefilled") {
    return <FastForward aria-hidden="true" className="h-3.5 w-3.5" />;
  }
  if (status === "current") {
    return <CircleDot aria-hidden="true" className="h-3.5 w-3.5" />;
  }
  if (status === "needs_verification") {
    return <ShieldAlert aria-hidden="true" className="h-3.5 w-3.5" />;
  }
  return <Circle aria-hidden="true" className="h-3.5 w-3.5" />;
}

export default function KnowledgeBaseProgressPanel({
  progress,
  loading = false,
  className = "",
  title = "知识库构建进度",
  emptyMessage = "完成首次资料分析后，这里会展示每个知识节点的处理进度。",
}: KnowledgeBaseProgressPanelProps) {
  if (loading) {
    return (
      <section
        aria-busy="true"
        className={`flex min-h-52 items-center justify-center rounded-[20px] border border-[#e8e1ee] bg-white p-8 text-[#716a80] shadow-[0_14px_38px_rgba(33,19,58,.06)] ${className}`}
      >
        <div className="text-center">
          <Loader2 className="mx-auto h-6 w-6 animate-spin text-[#5b2a86]" />
          <p className="mt-3 text-sm font-medium">正在同步构建进度…</p>
        </div>
      </section>
    );
  }

  if (!progress) {
    return (
      <section
        className={`flex min-h-52 items-center justify-center rounded-[20px] border border-dashed border-[#d8cde3] bg-white/80 p-8 text-center shadow-[0_14px_38px_rgba(33,19,58,.04)] ${className}`}
      >
        <div className="max-w-md">
          <Waypoints className="mx-auto h-7 w-7 text-[#7a4d9e]" />
          <h3 className="mt-3 text-base font-semibold text-[#221a33]">
            暂无可展示的构建进度
          </h3>
          <p className="mt-2 text-xs leading-6 text-[#716a80]">
            {emptyMessage}
          </p>
        </div>
      </section>
    );
  }

  const total = clampCount(progress.summary.total);
  const handled = clampCount(progress.summary.handled, total);
  const confirmed = clampCount(progress.summary.confirmed, total);
  const directPrefilled = clampCount(progress.summary.directPrefilled, total);
  const current = clampCount(progress.summary.current, total);
  const needsVerification = clampCount(
    progress.summary.needsVerification,
    total,
  );
  const pending = clampCount(progress.summary.pending, total);
  const overallPercent = normalizedOverallPercent(progress);
  const currentLeaf = progress.branches
    .flatMap((branch) => branch.leaves)
    .find((leaf) => leaf.id === progress.build.currentLeafId);

  return (
    <section
      className={`overflow-hidden rounded-[20px] border border-[#e8e1ee] bg-white shadow-[0_16px_42px_rgba(33,19,58,.065)] ${className}`}
    >
      <header className="border-b border-[#ece5f0] bg-[radial-gradient(circle_at_92%_0%,rgba(91,42,134,.10),transparent_36%)] px-5 py-5 sm:px-6">
        <div className="flex flex-col gap-4">
          <div className="min-w-0">
            <div className="flex items-center gap-2 text-xs font-bold tracking-[.08em] text-[#5b2a86]">
              <Waypoints className="h-4 w-4" />
              知识节点进度
            </div>
            <h3 className="mt-2 text-xl font-semibold tracking-[-.02em] text-[#171321]">
              {title}
            </h3>
            <p className="mt-1.5 truncate text-xs text-[#716a80]">
              {progress.build.companyName || "当前企业"} ·{" "}
              {formatUpdatedAt(progress.build.updatedAt)}
            </p>
          </div>
        </div>

        <div className="mt-5 space-y-3" data-testid="overall-progress-summary">
          <div>
            <div className="mb-2 flex items-center justify-between gap-4">
              <span className="whitespace-nowrap text-xs font-semibold text-[#3d3549]">
                总体已处理 {handled} / {total}
              </span>
              <strong className="shrink-0 whitespace-nowrap text-lg text-[#5b2a86]">
                {overallPercent}%
              </strong>
            </div>
            <div
              aria-label={`总体进度 ${overallPercent}%`}
              aria-valuemax={MAX_PERCENT}
              aria-valuemin={0}
              aria-valuenow={overallPercent}
              className="h-2.5 overflow-hidden rounded-full bg-[#eee8f1]"
              role="progressbar"
            >
              <div
                className="h-full rounded-full bg-[linear-gradient(90deg,#6b3494,#9b61bd)] transition-[width] duration-500"
                style={{ width: `${overallPercent}%` }}
              />
            </div>
          </div>
          <div
            className="grid grid-cols-3 gap-2 text-center"
            data-testid="progress-summary-metrics"
          >
            <SummaryMetric label="确认" value={confirmed} tone="emerald" />
            <SummaryMetric label="预填" value={directPrefilled} tone="sky" />
            <SummaryMetric label="等待确认" value={current} tone="violet" />
            <SummaryMetric
              label="待再次确认"
              value={needsVerification}
              tone="amber"
            />
            <SummaryMetric label="待处理" value={pending} tone="slate" />
            <SummaryMetric label="总节点" value={total} tone="ink" />
          </div>
        </div>
      </header>

      {progress.build.protocolError && (
        <div className="mx-5 mt-4 flex items-start gap-2 rounded-xl border border-red-200 bg-red-50 px-3.5 py-3 text-xs leading-5 text-red-800 sm:mx-6">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
          <div>
            <strong className="block">当前节点需要继续确认</strong>
            <span>{progress.build.protocolError}</span>
          </div>
        </div>
      )}

      {currentLeaf && (
        <div className="mx-5 mt-4 flex items-start gap-3 rounded-xl border border-violet-200 bg-violet-50/70 px-3.5 py-3 sm:mx-6">
          <CircleDot className="mt-0.5 h-4 w-4 shrink-0 text-[#6b3494]" />
          <div className="min-w-0">
            <span className="block text-xs font-bold tracking-[.08em] text-[#76508f]">
              当前唯一待确认节点
            </span>
            <strong className="mt-0.5 block text-xs leading-5 text-[#392347]">
              {currentLeaf.branchTitle} / {currentLeaf.title}
            </strong>
          </div>
        </div>
      )}

      <div className="grid gap-3 p-5 sm:p-6">
        {progress.branches.length > 0 ? (
          progress.branches.map((branch, index) => (
            <BranchProgress
              key={branch.id}
              branch={branch}
              branchNumber={index + 1}
            />
          ))
        ) : (
          <div className="rounded-xl border border-dashed border-[#d8cde3] px-4 py-8 text-center text-xs text-[#8c8596]">
            正在建立知识结构，请继续完成资料分析。
          </div>
        )}
      </div>

      <footer
        className={`flex items-start gap-2 border-t px-5 py-4 text-xs leading-5 sm:px-6 ${
          progress.packageAllowed
            ? "border-emerald-100 bg-emerald-50/60 text-emerald-800"
            : "border-[#ece5f0] bg-[#fbfafc] text-[#716a80]"
        }`}
      >
        <Archive className="mt-0.5 h-4 w-4 shrink-0" />
        <span>
          {progress.packageAllowed
            ? "所有知识节点均已逐项处理，已满足知识库更新条件。"
            : "知识库必须逐项走完；“企业已确认”和“直接预填”都会计入已处理，但只有企业明确确认的节点显示对号。"}
        </span>
      </footer>
    </section>
  );
}

function SummaryMetric({
  label,
  value,
  tone,
}: {
  label: string;
  value: number;
  tone: "emerald" | "sky" | "violet" | "amber" | "slate" | "ink";
}) {
  const toneClasses = {
    emerald: "border-emerald-100 bg-emerald-50 text-emerald-800",
    sky: "border-sky-100 bg-sky-50 text-sky-800",
    violet: "border-violet-100 bg-violet-50 text-violet-800",
    amber: "border-amber-100 bg-amber-50 text-amber-800",
    slate: "border-slate-200 bg-slate-50 text-slate-600",
    ink: "border-[#e6dee9] bg-[#f8f5f9] text-[#3d3549]",
  };
  return (
    <span
      className={`min-w-0 rounded-lg border px-2 py-1.5 ${toneClasses[tone]}`}
    >
      <strong className="block text-sm leading-none">{value}</strong>
      <small className="mt-1 block whitespace-nowrap text-xs font-semibold">
        {label}
      </small>
    </span>
  );
}

function BranchProgress({
  branch,
  branchNumber,
}: {
  branch: KnowledgeBaseProgressBranchDto;
  branchNumber: number;
}) {
  const total = clampCount(branch.total);
  const handled = clampCount(branch.handled, total);
  const branchPercent = percentFromCounts(handled, total);

  return (
    <details
      className="group overflow-hidden rounded-2xl border border-[#e8e1ee] bg-white"
      data-testid="knowledge-branch"
    >
      <summary className="flex cursor-pointer list-none items-center gap-3 px-4 py-3.5 marker:hidden sm:px-5">
        <span className="grid h-9 w-9 shrink-0 place-items-center rounded-xl bg-[#f3edf6] text-xs font-bold text-[#5b2a86]">
          {String(branchNumber).padStart(2, "0")}
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex items-center justify-between gap-3">
            <strong className="truncate text-sm text-[#261d32]">
              {branch.title}
            </strong>
            <span className="shrink-0 text-xs font-semibold text-[#716a80]">
              {handled} / {total} · {branchPercent}%
            </span>
          </div>
          <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-[#eee9f0]">
            <div
              className="h-full rounded-full bg-[#7b469f] transition-[width] duration-500"
              style={{ width: `${branchPercent}%` }}
            />
          </div>
        </div>
        <ChevronRight className="h-4 w-4 shrink-0 text-[#9a94a8] transition-transform group-open:rotate-90" />
      </summary>

      <div className="border-t border-[#eee8f1] bg-[#fcfbfd] px-3 py-3 sm:px-4">
        <div className="mb-3 flex flex-wrap gap-1.5 px-1 text-xs font-semibold">
          <span className="rounded-md bg-emerald-50 px-2 py-1 text-emerald-800">
            确认 {clampCount(branch.confirmed, total)}
          </span>
          <span className="rounded-md bg-sky-50 px-2 py-1 text-sky-800">
            预填 {clampCount(branch.directPrefilled, total)}
          </span>
          <span className="rounded-md bg-amber-50 px-2 py-1 text-amber-800">
            待再次确认 {clampCount(branch.needsVerification, total)}
          </span>
          <span className="rounded-md bg-slate-100 px-2 py-1 text-slate-600">
            待处理 {clampCount(branch.pending, total)}
          </span>
        </div>
        <ol className="grid gap-2">
          {[...branch.leaves]
            .sort((a, b) => a.ordinal - b.ordinal)
            .map((leaf) => (
              <li
                key={leaf.id}
                data-leaf-status={leaf.status}
                className={`flex items-center gap-3 rounded-xl border px-3 py-2.5 ${leafStatusClassNames[leaf.status]}`}
              >
                <span className="grid h-7 w-7 shrink-0 place-items-center rounded-lg bg-white/75">
                  <LeafStatusIcon status={leaf.status} />
                </span>
                <span className="min-w-0 flex-1 text-xs font-semibold leading-5">
                  {leaf.title}
                </span>
                <span className="shrink-0 text-xs font-bold">
                  {leafStatusLabels[leaf.status]}
                </span>
              </li>
            ))}
        </ol>
      </div>
    </details>
  );
}
