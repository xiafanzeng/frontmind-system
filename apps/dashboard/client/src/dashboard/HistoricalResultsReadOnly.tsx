import {
  ArrowLeft,
  BookOpenCheck,
  Clock3,
  ExternalLink,
  FileText,
  Loader2,
  MessageSquareQuote,
  ShieldCheck,
} from "lucide-react";

import MarkdownRenderer from "@/components/MarkdownRenderer";
import { Button } from "@/components/ui/button";
import { trpc } from "@/lib/trpc";
import type { HistoricalQuestionResults } from "@shared/historical-results";

import type { ServicePortalView } from "./service-portal";

type HistoricalResultsReadOnlyProps = {
  questionId: string;
  portal: ServicePortalView;
  onBack: () => void;
  resultOverride?: HistoricalQuestionResults | null;
  overrideError?: string;
};

const responseFields = [
  ["用户真正关心", "concern"],
  ["核心结论 / 执行口径", "conclusion"],
  ["企业材料 / 官方依据", "facts"],
  ["企业待确认", "pending"],
  ["表达边界", "boundaries"],
  ["参考资料", "references"],
] as const;

function displayDate(value: number) {
  return new Intl.DateTimeFormat("zh-CN", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(new Date(value));
}

export default function HistoricalResultsReadOnly(
  props: HistoricalResultsReadOnlyProps,
) {
  if (props.resultOverride !== undefined) {
    return (
      <HistoricalResultsContent
        result={props.resultOverride}
        loading={false}
        error={props.overrideError || ""}
        onBack={props.onBack}
      />
    );
  }
  return <PersistentHistoricalResults {...props} />;
}

function PersistentHistoricalResults({
  questionId,
  onBack,
}: HistoricalResultsReadOnlyProps) {
  const query = trpc.workspace.historicalQuestionResults.useQuery(
    { questionId },
    {
      retry: false,
      refetchOnMount: "always",
      refetchOnWindowFocus: true,
    },
  );
  return (
    <HistoricalResultsContent
      result={query.data ?? null}
      loading={query.isLoading}
      error={query.isError ? query.error.message : ""}
      onRetry={() => query.refetch()}
      onBack={onBack}
    />
  );
}

function HistoricalResultsContent({
  result,
  loading,
  error,
  onRetry,
  onBack,
}: {
  result: HistoricalQuestionResults | null;
  loading: boolean;
  error: string;
  onRetry?: () => void;
  onBack: () => void;
}) {
  if (loading) {
    return (
      <section className="page-shell">
        <div
          className="mx-auto mt-12 flex max-w-3xl items-center justify-center gap-3 rounded-2xl border border-[#e8e1ee] bg-white p-8 text-sm text-[#716a80]"
          role="status"
        >
          <Loader2 className="h-5 w-5 animate-spin" />
          正在载入历史成果…
        </div>
      </section>
    );
  }

  if (!result || error) {
    return (
      <section className="page-shell">
        <div className="mx-auto mt-12 max-w-3xl rounded-2xl border border-[#e8e1ee] bg-white p-8 text-center">
          <h2 className="m-0 text-xl font-semibold text-[#171321]">
            历史成果暂时无法载入
          </h2>
          <p className="mt-3 text-sm text-[#716a80]">
            {error || "该问题不在当前账号的只读历史中。"}
          </p>
          <div className="mt-5 flex justify-center gap-2">
            <Button variant="outline" onClick={onBack}>
              返回服务首页
            </Button>
            {onRetry && <Button onClick={onRetry}>重新载入</Button>}
          </div>
        </div>
      </section>
    );
  }

  return (
    <section className="page-shell">
      <header className="rounded-[24px] border border-[#e6deec] bg-[linear-gradient(135deg,#f8f3fb,#fffaf0)] p-6 md:p-8">
        <Button variant="ghost" className="-ml-3 mb-4" onClick={onBack}>
          <ArrowLeft className="h-4 w-4" />
          返回服务首页
        </Button>
        <div className="flex flex-wrap items-center gap-2">
          <span className="inline-flex items-center gap-1.5 rounded-full bg-[#5b2a86]/10 px-3 py-1 text-xs font-semibold text-[#5b2a86]">
            <ShieldCheck className="h-3.5 w-3.5" />
            只读历史成果
          </span>
          <span className="text-xs text-[#8d8498]">
            不占用当前额度 · 不会发起模型任务
          </span>
        </div>
        <h1 className="mt-4 max-w-4xl text-2xl font-semibold leading-tight text-[#171321] md:text-3xl">
          {result.question.question}
        </h1>
        <p className="mt-3 max-w-3xl text-sm leading-6 text-[#716a80]">
          这里仅展示该问题及其服务端谱系中已保存的应答逻辑和监控记录。页面没有对话、保存或更新入口。
        </p>
      </header>

      <div className="mt-5 grid gap-5">
        <section className="rounded-[22px] border border-[#e8e1ee] bg-white p-5 md:p-6">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <span className="fm-eyebrow flex items-center gap-2 text-[#8d8498]">
                <BookOpenCheck className="h-4 w-4" />
                应答逻辑
              </span>
              <h2 className="mt-2 text-xl font-semibold text-[#171321]">
                已有应答逻辑
              </h2>
            </div>
            <span className="rounded-full bg-[#f3edf8] px-3 py-1 text-xs font-semibold text-[#5b2a86]">
              {result.responseLogic.length} 个版本
            </span>
          </div>

          {result.responseLogic.length > 0 ? (
            <div className="mt-5 grid gap-4">
              {result.responseLogic.map((logic) => (
                <article
                  key={logic.recordId}
                  className="rounded-2xl border border-[#ece6f1] bg-[#fbf9fd] p-4 md:p-5"
                >
                  <div className="flex flex-wrap items-center justify-between gap-2 border-b border-[#ece6f1] pb-3">
                    <strong className="text-sm text-[#332a48]">
                      {logic.status === "confirmed"
                        ? `已确认 V${logic.version}`
                        : "未发布草稿"}
                    </strong>
                    <span className="text-xs text-[#8d8498]">
                      {displayDate(logic.updatedAt)}
                    </span>
                  </div>
                  <div className="mt-4 grid gap-4">
                    {responseFields.map(([label, key]) => {
                      const value = logic.content[key];
                      if (!value.trim()) return null;
                      return (
                        <div key={key}>
                          <h3 className="m-0 text-sm font-semibold text-[#51445f]">
                            {label}
                          </h3>
                          <div className="mt-2 text-sm leading-7 text-[#625a70]">
                            <MarkdownRenderer content={value} />
                          </div>
                        </div>
                      );
                    })}
                    {logic.content.attachments.length > 0 && (
                      <div>
                        <h3 className="m-0 text-sm font-semibold text-[#51445f]">
                          已核验资料
                        </h3>
                        <div className="mt-2 flex flex-wrap gap-2">
                          {logic.content.attachments.map((attachment) => (
                            <span
                              key={attachment.fileId}
                              className="inline-flex items-center gap-1.5 rounded-lg border border-[#e3dce9] bg-white px-2.5 py-1.5 text-xs text-[#625a70]"
                            >
                              <FileText className="h-3.5 w-3.5" />
                              {attachment.filename}
                            </span>
                          ))}
                        </div>
                      </div>
                    )}
                  </div>
                </article>
              ))}
            </div>
          ) : (
            <p className="mt-4 rounded-xl border border-dashed border-[#ddd5e5] p-4 text-sm text-[#716a80]">
              该问题尚未保存应答逻辑成果。
            </p>
          )}
        </section>

        <section className="rounded-[22px] border border-[#e8e1ee] bg-white p-5 md:p-6">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <span className="fm-eyebrow flex items-center gap-2 text-[#8d8498]">
                <MessageSquareQuote className="h-4 w-4" />
                问题监控
              </span>
              <h2 className="mt-2 text-xl font-semibold text-[#171321]">
                历史监控成果
              </h2>
            </div>
            <span className="rounded-full bg-emerald-50 px-3 py-1 text-xs font-semibold text-emerald-700">
              {result.monitoring.sampleTotal} 条回答 ·{" "}
              {result.monitoring.citationTotal} 条引用
            </span>
          </div>

          {result.monitoring.samples.length > 0 ? (
            <div className="mt-5 grid gap-3">
              {result.monitoring.samples.map((sample) => (
                <article
                  key={sample.id}
                  className="rounded-2xl border border-[#e6ece8] bg-[#f8fbf9] p-4"
                >
                  <div className="flex flex-wrap items-center gap-2 text-xs text-[#65746b]">
                    <strong className="text-emerald-800">
                      {sample.platform}
                    </strong>
                    <span>答案 #{sample.answerNo}</span>
                    <span className="inline-flex items-center gap-1">
                      <Clock3 className="h-3.5 w-3.5" />
                      {displayDate(sample.collectedAt)}
                    </span>
                    <span>{sample.citationCount} 条引用</span>
                  </div>
                  <div className="mt-3 text-sm leading-7 text-[#46524a]">
                    <MarkdownRenderer content={sample.content} />
                  </div>
                </article>
              ))}
            </div>
          ) : (
            <p className="mt-4 rounded-xl border border-dashed border-[#d7e3db] p-4 text-sm text-[#716a80]">
              该问题尚无已导入的监控回答。
            </p>
          )}

          {result.monitoring.citations.length > 0 && (
            <div className="mt-6">
              <h3 className="text-sm font-semibold text-[#51445f]">
                已记录引用来源
              </h3>
              <div className="mt-3 grid gap-2">
                {result.monitoring.citations.map((citation) => (
                  <a
                    key={citation.id}
                    href={citation.url || undefined}
                    target={citation.url ? "_blank" : undefined}
                    rel={citation.url ? "noreferrer" : undefined}
                    className="flex items-start justify-between gap-3 rounded-xl border border-[#ece6f1] px-3 py-3 text-sm text-[#51445f] no-underline"
                  >
                    <span>
                      <strong className="block font-semibold">
                        {citation.title || citation.domain || "未命名引用"}
                      </strong>
                      <small className="mt-1 block text-[#8d8498]">
                        {[citation.model, citation.media, citation.domain]
                          .filter(Boolean)
                          .join(" · ")}
                      </small>
                    </span>
                    {citation.url && (
                      <ExternalLink className="mt-0.5 h-4 w-4 shrink-0" />
                    )}
                  </a>
                ))}
              </div>
            </div>
          )}
        </section>
      </div>
    </section>
  );
}
