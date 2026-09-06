import {
  AlertCircle,
  ArrowRight,
  BookOpenText,
  CheckCircle2,
  Clock3,
  Database,
  FileText,
  WalletCards,
} from "lucide-react";
import { useCallback } from "react";
import { Link } from "wouter";

import { usePublisherGateway, usePublisherQuery } from "../PublishingContext";
import {
  BatchStatusBadge,
  PublishingEmpty,
  PublishingError,
  PublishingLoading,
  PublishingPage,
} from "../components/PublishingUi";
import { formatPublishingMoney, publishingDateTime } from "../types";

export default function PublishingOverviewPage() {
  const gateway = usePublisherGateway();
  const load = useCallback(
    (signal: AbortSignal) => gateway.getDashboard(signal),
    [gateway],
  );
  const query = usePublisherQuery(load);

  return (
    <PublishingPage
      title="发布工作台"
      description="管理稿件、选择媒体并追踪每一笔发布结果。"
      busy={query.loading || query.refreshing}
      actions={
        <Link
          className="publishing-button publishing-button-primary"
          href="/publishing/articles/new/import"
        >
          <FileText size={17} />
          导入新稿件
        </Link>
      }
    >
      {query.loading ? <PublishingLoading /> : null}
      {query.error ? (
        <PublishingError error={query.error} onRetry={query.reload} />
      ) : null}
      {query.data ? (
        <>
          <section className="publishing-metric-grid" aria-label="媒体发布概览">
            <article className="publishing-metric publishing-metric-primary">
              <span className="publishing-metric-icon">
                <WalletCards size={21} />
              </span>
              <div>
                <p>媒体发布余额</p>
                <strong>
                  {formatPublishingMoney(
                    query.data.wallet.availableTenThousandths,
                  )}
                </strong>
                <span>
                  待对账冻结{" "}
                  {formatPublishingMoney(
                    query.data.wallet.frozenTenThousandths,
                  )}
                </span>
              </div>
              <Link href="/monitoring-system/settings?tab=funds&wallet=media_publishing">
                余额管理 <ArrowRight size={14} />
              </Link>
            </article>
            <article className="publishing-metric">
              <span className="publishing-metric-icon">
                <Database size={21} />
              </span>
              <div>
                <p>可选媒体</p>
                <strong>
                  {query.data.catalog.mediaCount.toLocaleString("zh-CN")}
                </strong>
                <span>
                  {query.data.catalog.newsCount !== undefined ||
                  query.data.catalog.selfMediaCount !== undefined
                    ? `软文 ${query.data.catalog.newsCount ?? "—"} · 自媒体 ${query.data.catalog.selfMediaCount ?? "—"}`
                    : query.data.catalog.stale
                      ? "目录已过期"
                      : `同步于 ${publishingDateTime(query.data.catalog.lastSyncedAt)}`}
                </span>
              </div>
              <Link href="/publishing/media">
                进入媒体库 <ArrowRight size={14} />
              </Link>
            </article>
            <article className="publishing-metric">
              <span className="publishing-metric-icon">
                <BookOpenText size={21} />
              </span>
              <div>
                <p>我的稿件</p>
                <strong>{query.data.articleCount}</strong>
                <span>草稿与已冻结版本</span>
              </div>
              <Link href="/publishing/articles">
                管理稿件 <ArrowRight size={14} />
              </Link>
            </article>
            <article
              className={
                query.data.actionableItemCount
                  ? "publishing-metric publishing-metric-warning"
                  : "publishing-metric"
              }
            >
              <span className="publishing-metric-icon">
                {query.data.actionableItemCount ? (
                  <AlertCircle size={21} />
                ) : (
                  <CheckCircle2 size={21} />
                )}
              </span>
              <div>
                <p>需要处理</p>
                <strong>{query.data.actionableItemCount}</strong>
                <span>
                  {query.data.actionableItemCount
                    ? "状态未知项目等待管理员对账"
                    : "当前没有异常项目"}
                </span>
              </div>
              <Link href="/publishing?tab=records">
                查看记录 <ArrowRight size={14} />
              </Link>
            </article>
          </section>

          <div className="publishing-overview-columns">
            <section className="publishing-panel" aria-label="可恢复投放草稿">
              <header className="publishing-panel-heading">
                <div>
                  <h2>投放草稿</h2>
                  <p>{query.data.resumableDraftCount} 个可继续的投放草稿</p>
                </div>
                <Link href="/publishing/articles">从稿件开始</Link>
              </header>
              {query.data.resumableDrafts.length ? (
                <div className="publishing-list">
                  {query.data.resumableDrafts.map((draft) => (
                    <Link
                      key={draft.id}
                      className="publishing-list-row"
                      href={`/publishing/drafts/${encodeURIComponent(draft.id)}/${draft.status === "ready" ? "review" : "media"}`}
                    >
                      <span className="publishing-file-icon">
                        <FileText size={20} />
                      </span>
                      <span className="publishing-list-copy">
                        <strong>{draft.articleTitle}</strong>
                        <span>
                          版本 v{draft.articleVersion} ·{" "}
                          {draft.status === "ready"
                            ? "已配置，可继续预检"
                            : "配置中"}
                        </span>
                      </span>
                      <span className="publishing-row-time">
                        {publishingDateTime(draft.updatedAt)}
                      </span>
                      <ArrowRight size={17} />
                    </Link>
                  ))}
                </div>
              ) : query.data.resumableDraftCount ? (
                <PublishingEmpty
                  title="草稿列表正在同步"
                  description={`检测到 ${query.data.resumableDraftCount} 个草稿，请稍后刷新。`}
                />
              ) : (
                <PublishingEmpty
                  title="没有待继续的投放草稿"
                  description="从已冻结稿件选择媒体后，草稿会保存在这里。"
                />
              )}
            </section>

            <section className="publishing-panel" aria-label="处理中发布">
              <header className="publishing-panel-heading">
                <div>
                  <h2>处理中发布</h2>
                  <p>{query.data.processingBatchCount} 个批次正在等待或发布</p>
                </div>
                <Link href="/publishing?tab=records">查看全部</Link>
              </header>
              {query.data.processingBatches.length ? (
                <div className="publishing-list">
                  {query.data.processingBatches.map((batch) => (
                    <Link
                      key={batch.id}
                      className="publishing-list-row"
                      href={`/publishing/publications/${encodeURIComponent(batch.id)}`}
                    >
                      <span className="publishing-file-icon">
                        <Clock3 size={20} />
                      </span>
                      <span className="publishing-list-copy">
                        <strong>{batch.articleTitle}</strong>
                        <span>
                          {batch.id} · {batch.itemCount} 家媒体
                        </span>
                      </span>
                      <BatchStatusBadge status={batch.status} />
                      <ArrowRight size={17} />
                    </Link>
                  ))}
                </div>
              ) : (
                <PublishingEmpty
                  title="当前没有处理中发布"
                  description="提交后的等待与发布中批次会出现在这里。"
                />
              )}
            </section>
          </div>

          <div className="publishing-overview-columns">
            <section className="publishing-panel">
              <header className="publishing-panel-heading">
                <div>
                  <h2>继续编辑</h2>
                  <p>最近更新的稿件</p>
                </div>
                <Link href="/publishing/articles">查看全部</Link>
              </header>
              {query.data.resumableArticles.length ? (
                <div className="publishing-list">
                  {query.data.resumableArticles.map((article) => (
                    <Link
                      key={article.id}
                      className="publishing-list-row"
                      href={`/publishing/articles/${article.id}/edit`}
                    >
                      <span className="publishing-file-icon">
                        <FileText size={20} />
                      </span>
                      <span className="publishing-list-copy">
                        <strong>{article.title}</strong>
                        <span>
                          {article.wordCount.toLocaleString("zh-CN")} 字 ·{" "}
                          {article.imageCount} 张图片 · v
                          {article.currentVersion}
                        </span>
                      </span>
                      <span className="publishing-row-time">
                        {publishingDateTime(article.updatedAt)}
                      </span>
                      <ArrowRight size={17} />
                    </Link>
                  ))}
                </div>
              ) : (
                <PublishingEmpty
                  title="还没有稿件"
                  description="导入 DOCX 后即可开始编辑。"
                />
              )}
            </section>

            <section className="publishing-panel">
              <header className="publishing-panel-heading">
                <div>
                  <h2>最近发布</h2>
                  <p>批次与逐项资金状态</p>
                </div>
                <Link href="/publishing?tab=records">查看全部</Link>
              </header>
              {query.data.recentBatches.length ? (
                <div className="publishing-list">
                  {query.data.recentBatches.map((batch) => (
                    <Link
                      key={batch.id}
                      className="publishing-list-row"
                      href={`/publishing/publications/${batch.id}`}
                    >
                      <span className="publishing-file-icon">
                        <Clock3 size={20} />
                      </span>
                      <span className="publishing-list-copy">
                        <strong>{batch.articleTitle}</strong>
                        <span>
                          {batch.id} · {batch.itemCount} 家媒体 ·{" "}
                          {formatPublishingMoney(batch.totalTenThousandths)}
                        </span>
                      </span>
                      <BatchStatusBadge status={batch.status} />
                      <ArrowRight size={17} />
                    </Link>
                  ))}
                </div>
              ) : (
                <PublishingEmpty
                  title="还没有发布记录"
                  description="完成预检后，发布进度会出现在这里。"
                />
              )}
            </section>
          </div>
        </>
      ) : null}
    </PublishingPage>
  );
}
