import { ExternalLink, Link2 } from "lucide-react";

import type { RunAttempt } from "../../../domain";
import { aggregateSources, safeExternalUrl } from "../selectors";
import type { MonitoringAnalysisData } from "../useMonitoringDataSource";
import PanelFrame from "./PanelFrame";

export default function CitationAnalysisPanel({
  attempts,
  analysis,
  exportHref,
}: {
  attempts: RunAttempt[];
  analysis?: MonitoringAnalysisData;
  exportHref?: string;
}) {
  const remote = analysis?.kind === "citations" ? analysis : undefined;
  const localContents = aggregateSources(attempts, "cited");
  const localDomains = Array.from(
    localContents.reduce((result, source) => {
      result.set(
        source.domain,
        (result.get(source.domain) || 0) + source.count,
      );
      return result;
    }, new Map<string, number>()),
  )
    .map(([domain, count]) => ({ domain, count }))
    .sort(
      (left, right) =>
        right.count - left.count ||
        left.domain.localeCompare(right.domain, "zh-CN"),
    );
  const domains = remote?.items || localDomains;
  const contents = remote
    ? remote.contents.map((item) => ({ ...item, key: item.url }))
    : localContents;
  const total =
    remote?.total ||
    localContents.reduce((sum, source) => sum + source.count, 0);

  return (
    <PanelFrame
      id="monitor-citations"
      labelledBy="monitor-tab-citations"
      icon={<Link2 size={17} />}
      title="引用分析"
      meta={`${total} 次真实引用`}
      exportHref={exportHref}
      exportFileName="frontmind-monitoring-citations.xlsx"
    >
      {domains.length || contents.length ? (
        <div className="fm-citation-analysis-grid">
          <section aria-labelledby="citation-domain-heading">
            <header>
              <div>
                <h4 id="citation-domain-heading">域名 / 渠道</h4>
                <span>按真实引用次数聚合</span>
              </div>
            </header>
            <div className="fm-ranked-analysis-list">
              {domains.map((item, index) => {
                const ratio = total ? (item.count / total) * 100 : 0;
                return (
                  <article key={item.domain}>
                    <span>{index + 1}</span>
                    <div>
                      <strong>{item.domain}</strong>
                      <div>
                        <i style={{ width: `${ratio}%` }} />
                      </div>
                    </div>
                    <b>{item.count}</b>
                    <small>{ratio.toFixed(1)}%</small>
                  </article>
                );
              })}
            </div>
          </section>
          <section aria-labelledby="citation-content-heading">
            <header>
              <div>
                <h4 id="citation-content-heading">具体引用内容</h4>
                <span>仅 citationList 明确返回的内容</span>
              </div>
            </header>
            <div className="fm-ranked-analysis-list fm-citation-content-list">
              {contents.map((item, index) => {
                const safeUrl = safeExternalUrl(item.url);
                return (
                  <article key={`${item.url || item.key}-${index}`}>
                    <span>{index + 1}</span>
                    <div>
                      <strong>{item.title}</strong>
                      <small>{item.domain}</small>
                    </div>
                    <b>{item.count}</b>
                    {safeUrl && (
                      <a
                        href={safeUrl}
                        target="_blank"
                        rel="noopener noreferrer"
                        aria-label={`查看来源：${item.title}`}
                      >
                        <ExternalLink size={14} />
                      </a>
                    )}
                  </article>
                );
              })}
            </div>
          </section>
        </div>
      ) : (
        <div className="fm-empty">
          <Link2 size={24} />
          <strong>当前筛选没有引用来源</strong>
          <span>引用分析只统计供应商 citationList 中的实际引用。</span>
        </div>
      )}
    </PanelFrame>
  );
}
