import { ArrowRight, FileClock, Plus, RefreshCw, Search } from "lucide-react";
import { useCallback, useEffect, useMemo } from "react";
import { Link, useLocation, useSearch } from "wouter";

import { usePublisherGateway, usePublisherQuery } from "../PublishingContext";
import {
  BatchStatusBadge,
  PublishingEmpty,
  PublishingError,
  PublishingLoading,
  PublishingPage,
  PublishingPagination,
} from "../components/PublishingUi";
import {
  readPublicationRouteState,
  writePublicationWorkbenchRouteState,
  type PublicationListFilters,
} from "../queryState";
import { formatPublishingMoney, publishingDateTime } from "../types";

export default function PublishingPublicationsPage() {
  const gateway = usePublisherGateway();
  const [, navigate] = useLocation();
  const search = useSearch();
  const filters = useMemo(() => readPublicationRouteState(search), [search]);
  useEffect(() => {
    const canonical = writePublicationWorkbenchRouteState(filters);
    const current = search
      ? `/publishing?${search.replace(/^\?/u, "")}`
      : "/publishing";
    if (canonical !== current) navigate(canonical, { replace: true });
  }, [filters, navigate, search]);
  const load = useCallback(
    (signal: AbortSignal) => gateway.listBatches(filters, signal),
    [filters, gateway],
  );
  const query = usePublisherQuery(load);
  const update = <K extends keyof PublicationListFilters>(
    key: K,
    value: PublicationListFilters[K],
  ) => {
    const next = {
      ...filters,
      [key]: value,
      page: key === "page" ? Number(value) : 1,
    };
    navigate(writePublicationWorkbenchRouteState(next));
  };
  const pageCount = query.data
    ? Math.max(1, Math.ceil(query.data.total / query.data.pageSize))
    : 1;

  return (
    <PublishingPage
      title="发布工作台"
      description="按 FrontMind 发布编号追踪软文与自媒体的结果、回链和资金状态。"
      busy={query.loading || query.refreshing}
      actions={
        <button
          className="publishing-button publishing-button-secondary"
          type="button"
          onClick={query.reload}
          disabled={query.refreshing}
        >
          <RefreshCw
            className={query.refreshing ? "publishing-spin" : undefined}
            size={16}
          />
          刷新
        </button>
      }
    >
      <section
        className="publishing-panel publishing-publication-filters"
        aria-label="筛选发布记录"
      >
        <label className="publishing-search-field">
          <Search size={17} />
          <span className="publishing-visually-hidden">搜索发布记录</span>
          <input
            value={filters.query}
            onChange={(event) => update("query", event.target.value)}
            placeholder="稿件标题、媒体名称或 FrontMind 发布编号"
          />
        </label>
        <label>
          媒体类型
          <select
            value={filters.kind}
            onChange={(event) =>
              update(
                "kind",
                event.target.value as PublicationListFilters["kind"],
              )
            }
          >
            <option value="">全部</option>
            <option value="news">软文媒体</option>
            <option value="self_media">自媒体</option>
          </select>
        </label>
        <label>
          发布状态
          <select
            value={filters.status}
            onChange={(event) =>
              update(
                "status",
                event.target.value as PublicationListFilters["status"],
              )
            }
          >
            <option value="">全部</option>
            <option value="queued">等待发布</option>
            <option value="processing">发布中</option>
            <option value="success">全部成功</option>
            <option value="partial_success">部分成功</option>
            <option value="failed">全部失败</option>
            <option value="action_required">需要处理</option>
          </select>
        </label>
        <label>
          开始日期
          <input
            type="date"
            value={filters.from}
            onChange={(event) => update("from", event.target.value)}
          />
        </label>
        <label>
          结束日期
          <input
            type="date"
            value={filters.to}
            onChange={(event) => update("to", event.target.value)}
          />
        </label>
      </section>
      {query.loading ? <PublishingLoading label="正在读取发布记录…" /> : null}
      {query.error ? (
        <PublishingError error={query.error} onRetry={query.reload} />
      ) : null}
      {query.data ? (
        query.data.items.length ? (
          <>
            <section
              className="publishing-panel publishing-batch-list"
              aria-label="发布批次"
            >
              <div className="publishing-batch-head publishing-batch-row">
                <span>发布编号 / 稿件</span>
                <span>媒体构成</span>
                <span>媒体结果</span>
                <span>客户费用</span>
                <span>提交时间</span>
                <span>状态</span>
                <span aria-hidden="true" />
              </div>
              {query.data.items.map((batch) => (
                <Link
                  key={batch.id}
                  className="publishing-batch-row"
                  href={`/publishing/publications/${batch.id}`}
                >
                  <span className="publishing-article-name">
                    <span className="publishing-file-icon">
                      <FileClock size={20} />
                    </span>
                    <span>
                      <strong>{batch.articleTitle}</strong>
                      <small>
                        {batch.id}
                        {batch.articleVersion > 0
                          ? ` · v${batch.articleVersion}`
                          : ""}{" "}
                        · {batch.titleMode === "single" ? "单标题" : "多标题"}
                      </small>
                    </span>
                  </span>
                  <span>
                    <strong>软文 {batch.newsCount ?? "—"}</strong>
                    <small>自媒体 {batch.selfMediaCount ?? "—"}</small>
                  </span>
                  <span className="publishing-batch-result">
                    <b className="is-success">{batch.successCount} 成功</b>
                    <b className="is-danger">{batch.failedCount} 失败</b>
                    {batch.unknownCount ? (
                      <b className="is-warning">{batch.unknownCount} 待对账</b>
                    ) : null}
                  </span>
                  <span>
                    <strong>
                      {formatPublishingMoney(batch.totalTenThousandths)}
                    </strong>
                    <small>
                      已扣 {formatPublishingMoney(batch.consumedTenThousandths)}
                    </small>
                  </span>
                  <span>{publishingDateTime(batch.createdAt)}</span>
                  <BatchStatusBadge status={batch.status} />
                  <ArrowRight size={17} />
                </Link>
              ))}
            </section>
            <footer className="publishing-media-footer">
              <span>共 {query.data.total} 个发布批次</span>
              <label>
                每页{" "}
                <select
                  value={filters.pageSize}
                  onChange={(event) =>
                    update("pageSize", Number(event.target.value))
                  }
                >
                  <option value={10}>10</option>
                  <option value={20}>20</option>
                  <option value={50}>50</option>
                </select>
              </label>
              <PublishingPagination
                page={filters.page}
                pageCount={pageCount}
                onChange={(page) => update("page", page)}
              />
            </footer>
          </>
        ) : (
          <PublishingEmpty
            title="没有匹配的发布记录"
            description="调整筛选条件，或从稿件开始创建一次发布。"
            action={
              <Link
                className="publishing-button publishing-button-primary"
                href="/publishing/articles"
              >
                <Plus size={16} />
                开始发布
              </Link>
            }
          />
        )
      ) : null}
    </PublishingPage>
  );
}
