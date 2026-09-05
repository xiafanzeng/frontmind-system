import { Globe2 } from "lucide-react";

import type { RunAttempt } from "../../../domain";
import { aggregateSources, visibleSourcesForAttempt } from "../selectors";
import type { SourceScope } from "../types";
import type { MonitoringAnalysisData } from "../useMonitoringDataSource";
import PanelFrame from "./PanelFrame";

const publicationLabels = {
  last_7_days: "近 7 天",
  last_30_days: "8–30 天",
  last_90_days: "31–90 天",
  older: "90 天以前",
  unknown: "发布时间未知",
} as const;

export function sourceCountForScope(
  item: { citedCount: number; discoveredCount: number },
  scope: SourceScope,
) {
  if (scope === "cited") return item.citedCount;
  if (scope === "discovered") {
    return Math.max(0, item.discoveredCount - item.citedCount);
  }
  return item.discoveredCount;
}

function localPublicationBuckets(attempts: RunAttempt[], scope: SourceScope) {
  const buckets = new Map<keyof typeof publicationLabels, number>();
  const now = Date.now();
  for (const source of attempts.flatMap((attempt) =>
    visibleSourcesForAttempt(attempt, scope),
  )) {
    if (!source.publishedAt) {
      buckets.set("unknown", (buckets.get("unknown") || 0) + 1);
      continue;
    }
    const age = Math.max(
      0,
      Math.floor((now - Date.parse(source.publishedAt)) / 86_400_000),
    );
    const bucket =
      age <= 7
        ? "last_7_days"
        : age <= 30
          ? "last_30_days"
          : age <= 90
            ? "last_90_days"
            : "older";
    buckets.set(bucket, (buckets.get(bucket) || 0) + 1);
  }
  return Object.keys(publicationLabels).map((bucket) => ({
    bucket: bucket as keyof typeof publicationLabels,
    count: buckets.get(bucket as keyof typeof publicationLabels) || 0,
  }));
}

export default function SourceDistributionPanel({
  attempts,
  scope,
  onScopeChange,
  analysis,
  exportHref,
}: {
  attempts: RunAttempt[];
  scope: SourceScope;
  onScopeChange: (scope: SourceScope) => void;
  analysis?: MonitoringAnalysisData;
  exportHref?: string;
}) {
  const remote = analysis?.kind === "sources" ? analysis : undefined;
  const localSources = aggregateSources(attempts, scope);
  const localDomains = Array.from(
    localSources.reduce((result, source) => {
      result.set(
        source.domain,
        (result.get(source.domain) || 0) + source.count,
      );
      return result;
    }, new Map<string, number>()),
  ).map(([domain, count]) => ({ domain, count }));
  const sources = remote
    ? remote.items.map((item) => ({
        domain: item.domain,
        count: sourceCountForScope(item, scope),
      }))
    : localDomains;
  const visibleSources = sources
    .filter((source) => source.count > 0)
    .sort(
      (left, right) =>
        right.count - left.count ||
        left.domain.localeCompare(right.domain, "zh-CN"),
    );
  const total = visibleSources.reduce((sum, source) => sum + source.count, 0);
  const publicationBuckets = remote
    ? remote.publicationTimeBuckets.map((bucket) => ({
        bucket: bucket.bucket,
        count: sourceCountForScope(bucket, scope),
      }))
    : localPublicationBuckets(attempts, scope);
  const publicationTotal = publicationBuckets.reduce(
    (sum, bucket) => sum + bucket.count,
    0,
  );

  return (
    <PanelFrame
      id="monitor-sources"
      labelledBy="monitor-tab-sources"
      icon={<Globe2 size={17} />}
      title="信源分布"
      meta={`${total} 次来源记录`}
      exportHref={exportHref}
      exportFileName="frontmind-monitoring-sources.xlsx"
    >
      <div className="fm-source-panel-controls">
        <p className="fm-honesty-note">
          全部返回信源包含供应商发现但正文未引用的结果；它不等同于实际引用。
        </p>
        <div className="fm-segmented" role="group" aria-label="信源统计范围">
          <button
            type="button"
            className={scope === "all" ? "active" : ""}
            aria-pressed={scope === "all"}
            onClick={() => onScopeChange("all")}
          >
            全部返回信源
          </button>
          <button
            type="button"
            className={scope === "cited" ? "active" : ""}
            aria-pressed={scope === "cited"}
            onClick={() => onScopeChange("cited")}
          >
            实际引用
          </button>
          <button
            type="button"
            className={scope === "discovered" ? "active" : ""}
            aria-pressed={scope === "discovered"}
            onClick={() => onScopeChange("discovered")}
          >
            仅发现未引用
          </button>
        </div>
      </div>
      {visibleSources.length ? (
        <div className="fm-source-analysis-grid">
          <section>
            <header>
              <h4>域名分布</h4>
              <span>不根据域名猜测业务类别</span>
            </header>
            <div className="fm-domain-grid">
              {visibleSources.map((source) => {
                const ratio = total
                  ? Math.round((source.count / total) * 100)
                  : 0;
                return (
                  <article key={source.domain}>
                    <header>
                      <strong>{source.domain}</strong>
                    </header>
                    <div>
                      <i style={{ width: `${ratio}%` }} />
                    </div>
                    <footer>
                      <span>{source.count} 次返回</span>
                      <b>{ratio}%</b>
                    </footer>
                  </article>
                );
              })}
            </div>
          </section>
          <section>
            <header>
              <h4>发布时间分布</h4>
              <span>仅使用 API 明确返回的日期</span>
            </header>
            <div className="fm-publication-buckets">
              {publicationBuckets.map((bucket) => {
                const ratio = publicationTotal
                  ? (bucket.count / publicationTotal) * 100
                  : 0;
                return (
                  <article key={bucket.bucket}>
                    <span>{publicationLabels[bucket.bucket]}</span>
                    <div>
                      <i style={{ width: `${ratio}%` }} />
                    </div>
                    <strong>{bucket.count}</strong>
                  </article>
                );
              })}
            </div>
          </section>
        </div>
      ) : (
        <div className="fm-empty">
          <Globe2 size={24} />
          <strong>当前筛选没有信源</strong>
          <span>平台返回发现信源后，将按域名与发布时间显示分布。</span>
        </div>
      )}
    </PanelFrame>
  );
}
