import { ArrowDown, FileText, FolderOpen, Globe2 } from "lucide-react";
import type { ReactNode } from "react";

import { trpc } from "@/lib/trpc";

import "./managed-citation-workbench.css";

type ChannelSummary = {
  name: string;
  domain: string;
  citationCount: number;
  share: number;
};

type ContentSummary = {
  title: string;
  url: string;
  channelName: string;
  domain: string;
  citationCount: number;
  share: number;
};

export type CitationSummaryPreviewData = {
  batchKey?: string | null;
  questionId?: string;
  scopeLabel?: string;
  totalCitations: number;
  channels: ChannelSummary[];
  contents: ContentSummary[];
};

const numberFormatter = new Intl.NumberFormat("zh-CN");
const percentFormatter = new Intl.NumberFormat("zh-CN", {
  style: "percent",
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

function displayText(value: string | null | undefined, fallback = "—") {
  const normalized = value?.trim();
  return normalized || fallback;
}

function safeHttpUrl(value: string) {
  if (!value) return "";
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:"
      ? url.toString()
      : "";
  } catch {
    return "";
  }
}

function domainUrl(domain: string) {
  const normalized = domain.trim();
  if (!normalized) return "";
  return safeHttpUrl(
    normalized.includes("://") ? normalized : `https://${normalized}`,
  );
}

export type ManagedCitationWorkbenchProps = {
  selectedQuestionId: string;
  batchKey?: string;
  model?: string;
  from?: string;
  to?: string;
  scopeLabel?: string;
};

export default function ManagedCitationWorkbench({
  batchKey,
  selectedQuestionId,
  model,
  from,
  to,
  scopeLabel,
}: ManagedCitationWorkbenchProps) {
  const summaryQuery = trpc.workspace.monitoring.citationSummary.useQuery(
    {
      batchKey: batchKey || undefined,
      questionId: selectedQuestionId,
      model: model || undefined,
      from: from || undefined,
      to: to || undefined,
    },
    {
      enabled: Boolean(selectedQuestionId),
      retry: false,
      refetchOnMount: "always",
      refetchOnWindowFocus: true,
      refetchInterval: 30_000,
      refetchIntervalInBackground: false,
    },
  );

  if (!selectedQuestionId) {
    return (
      <div className="managed-citation-state empty">
        <FileText aria-hidden="true" size={24} />
        <strong>请选择监控问题</strong>
        <p>选择问题后，可查看该问题全部答案样本的渠道与内容引用。</p>
      </div>
    );
  }

  if (summaryQuery.isLoading) {
    return (
      <div className="managed-citation-state" role="status">
        <span aria-hidden="true" />
        正在汇总引用分析…
      </div>
    );
  }

  if (summaryQuery.error) {
    return (
      <div className="managed-citation-state error" role="alert">
        引用分析暂时无法读取，请稍后重试。
      </div>
    );
  }

  return (
    <CitationSummaryWorkbench
      data={{
        batchKey: batchKey || null,
        questionId: selectedQuestionId,
        scopeLabel,
        totalCitations: summaryQuery.data?.totalCitations || 0,
        channels: (summaryQuery.data?.channels || []) as ChannelSummary[],
        contents: (summaryQuery.data?.contents || []) as ContentSummary[],
      }}
    />
  );
}

export function PreviewCitationWorkbench({
  data,
  loading = false,
  error = false,
}: {
  data?: CitationSummaryPreviewData;
  loading?: boolean;
  error?: boolean;
}) {
  if (loading) {
    return (
      <div className="managed-citation-state" role="status">
        <span aria-hidden="true" />
        正在汇总当前问题的引用分析…
      </div>
    );
  }
  if (error) {
    return (
      <div className="managed-citation-state error" role="alert">
        预览引用数据暂时无法读取，请稍后重试。
      </div>
    );
  }
  if (!data) {
    return (
      <div className="managed-citation-state empty">
        <FileText aria-hidden="true" size={24} />
        <strong>当前问题暂无引用分析</strong>
        <p>切换到有引用记录的问题后，可查看渠道与内容引用。</p>
      </div>
    );
  }
  return <CitationSummaryWorkbench data={data} />;
}

function CitationSummaryWorkbench({
  data,
}: {
  data: CitationSummaryPreviewData;
}) {
  const { channels, contents, scopeLabel } = data;

  return (
    <section
      className="managed-citation-workbench"
      aria-labelledby="citation-analysis-title"
    >
      <header className="managed-citation-header">
        <div>
          <h2 id="citation-analysis-title">引用分析</h2>
          <p>
            汇总所选平台与问题在日期区间内全部回答的渠道与内容引用；未带答案
            ID 的记录只进入本汇总，不会显示为某一条回答的精确信源。
          </p>
          {scopeLabel ? <span>{scopeLabel}</span> : null}
        </div>
      </header>

      <div className="managed-citation-summary-grid">
        <SummaryPanel
          title="渠道引用"
          icon={<Globe2 aria-hidden="true" size={18} />}
          emptyMessage="当前问题在所选监控日期中暂无渠道引用。"
          isEmpty={channels.length === 0}
        >
          <table>
            <caption className="sr-only">当前问题的渠道引用汇总</caption>
            <thead>
              <tr>
                <th>渠道名称</th>
                <th>渠道域名</th>
                <th className="numeric">
                  引用数 <ArrowDown aria-hidden="true" size={12} />
                </th>
                <th className="numeric">占比</th>
              </tr>
            </thead>
            <tbody>
              {channels.map((item) => {
                const href = domainUrl(item.domain);
                return (
                  <tr key={`${item.domain}-${item.name}`}>
                    <td>
                      <span className="managed-citation-channel-name">
                        <i aria-hidden="true" />
                        {displayText(item.name, "未标注渠道")}
                      </span>
                    </td>
                    <td>
                      {href ? (
                        <a href={href} target="_blank" rel="noreferrer">
                          {displayText(item.domain)}
                        </a>
                      ) : (
                        displayText(item.domain)
                      )}
                    </td>
                    <td className="numeric">
                      {numberFormatter.format(item.citationCount)}
                    </td>
                    <td className="numeric">
                      <strong className="managed-citation-share">
                        {percentFormatter.format(item.share)}
                      </strong>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </SummaryPanel>

        <SummaryPanel
          title="内容引用"
          icon={<FolderOpen aria-hidden="true" size={18} />}
          emptyMessage="当前问题在所选监控日期中暂无内容引用。"
          isEmpty={contents.length === 0}
        >
          <table>
            <caption className="sr-only">当前问题的内容引用汇总</caption>
            <thead>
              <tr>
                <th>内容名称</th>
                <th>渠道名称</th>
                <th className="numeric">
                  引用数 <ArrowDown aria-hidden="true" size={12} />
                </th>
                <th className="numeric">占比</th>
              </tr>
            </thead>
            <tbody>
              {contents.map((item, index) => {
                const href = safeHttpUrl(item.url);
                const title = displayText(
                  item.title || item.url,
                  `未标注内容 ${index + 1}`,
                );
                return (
                  <tr key={`${item.url || title}-${index}`}>
                    <td className="managed-citation-content-name">
                      {href ? (
                        <a href={href} target="_blank" rel="noreferrer">
                          {title}
                        </a>
                      ) : (
                        title
                      )}
                    </td>
                    <td>
                      <span className="managed-citation-channel-link">
                        {displayText(
                          item.channelName || item.domain,
                          "未标注渠道",
                        )}
                      </span>
                    </td>
                    <td className="numeric">
                      {numberFormatter.format(item.citationCount)}
                    </td>
                    <td className="numeric">
                      <strong className="managed-citation-share">
                        {percentFormatter.format(item.share)}
                      </strong>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </SummaryPanel>
      </div>
    </section>
  );
}

function SummaryPanel({
  title,
  icon,
  emptyMessage,
  isEmpty,
  children,
}: {
  title: string;
  icon: ReactNode;
  emptyMessage: string;
  isEmpty: boolean;
  children: ReactNode;
}) {
  return (
    <section className="managed-citation-summary-panel" aria-label={title}>
      <header>
        <span>{icon}</span>
        <h3>{title}</h3>
      </header>
      <div className="managed-citation-summary-table">
        {isEmpty ? (
          <div className="managed-citation-summary-empty">{emptyMessage}</div>
        ) : (
          children
        )}
      </div>
    </section>
  );
}
