import { ArrowRight, FileCheck2, FileText, Plus, Upload } from "lucide-react";
import { useCallback } from "react";
import { Link } from "wouter";

import { usePublisherGateway, usePublisherQuery } from "../PublishingContext";
import {
  PublishingEmpty,
  PublishingError,
  PublishingLoading,
  PublishingPage,
} from "../components/PublishingUi";
import { publishingDateTime } from "../types";
import { usePublishingSummary } from "../PublishingFlowContext";

export default function PublishingArticlesPage() {
  const gateway = usePublisherGateway();
  const load = useCallback(
    (signal: AbortSignal) => gateway.listArticles(signal),
    [gateway],
  );
  const query = usePublisherQuery(load);
  usePublishingSummary({
    title: "项目稿件",
    items: [
      { label: "稿件数量", value: `${query.data?.length ?? 0} 篇` },
      {
        label: "已冻结版本",
        value: `${query.data?.filter((article) => article.currentVersionId).length ?? 0} 篇`,
      },
    ],
    note: "选择稿件后可继续编辑正文、管理图片并冻结发布版本。",
  });

  return (
    <PublishingPage
      title="稿件"
      description="编辑正文并冻结可追溯版本；历史发布不会因后续修改而变化。"
      busy={query.loading || query.refreshing}
      actions={
        <Link
          className="publishing-button publishing-button-primary"
          href="/publishing/articles/new/import"
        >
          <Upload size={17} />
          导入 DOCX
        </Link>
      }
    >
      {query.loading ? <PublishingLoading label="正在读取稿件…" /> : null}
      {query.error ? (
        <PublishingError error={query.error} onRetry={query.reload} />
      ) : null}
      {query.data ? (
        query.data.length ? (
          <section
            className="publishing-panel publishing-article-table"
            aria-label="稿件列表"
          >
            <div className="publishing-table-head publishing-article-row">
              <span>稿件</span>
              <span>当前版本</span>
              <span>内容</span>
              <span>最近更新</span>
              <span aria-hidden="true" />
            </div>
            {query.data.map((article) => (
              <Link
                key={article.id}
                className="publishing-article-row"
                href={`/publishing/articles/${article.id}/edit`}
              >
                <span className="publishing-article-name">
                  <span className="publishing-file-icon">
                    {article.status === "frozen" ? (
                      <FileCheck2 size={20} />
                    ) : (
                      <FileText size={20} />
                    )}
                  </span>
                  <span>
                    <strong>{article.title}</strong>
                    <small>ID: {article.id}</small>
                  </span>
                </span>
                <span>
                  <span
                    className={`publishing-status ${article.status === "frozen" ? "is-success" : "is-neutral"}`}
                  >
                    {article.status === "frozen"
                      ? `v${article.currentVersion} · 已冻结`
                      : "草稿"}
                  </span>
                </span>
                <span>
                  {article.wordCount.toLocaleString("zh-CN")} 字 ·{" "}
                  {article.imageCount} 张图片
                </span>
                <span>{publishingDateTime(article.updatedAt)}</span>
                <ArrowRight size={17} />
              </Link>
            ))}
          </section>
        ) : (
          <PublishingEmpty
            title="还没有稿件"
            description="导入 DOCX，系统会完成安全检查并建立可编辑稿件。"
            action={
              <Link
                className="publishing-button publishing-button-primary"
                href="/publishing/articles/new/import"
              >
                <Plus size={16} />
                导入第一篇稿件
              </Link>
            }
          />
        )
      ) : null}
    </PublishingPage>
  );
}
