import { WorkflowPagination } from "@/dashboard/workflow/Workflow";
import { ArrowRight, FileCheck2, FileText, Plus, Upload } from "lucide-react";
import { useCallback, useState } from "react";
import { Link } from "wouter";

import { usePublisherGateway, usePublisherQuery } from "../PublishingContext";
import {
  PublishingEmpty,
  PublishingError,
  PublishingLoading,
  PublishingPage,
} from "../components/PublishingUi";
import { publishingDateTime } from "../types";
import {
  usePublishingFlow,
  usePublishingSummary,
  usePublishingOperationScope,
} from "../PublishingFlowContext";
import {
  PublishingQuestion,
  PublishingStep,
  usePublishingChoice,
} from "../components/PublishingConversation";
import { requestWorkspaceNavigation } from "@/lib/workspace-navigation-guard";
import PublishingImportPage from "./ImportPage";
import PublishingArticleEditorPage from "./ArticleEditorPage";
import type { ArticleSummary } from "../types";

export default function PublishingArticlesPage() {
  const gateway = usePublisherGateway();
  const flow = usePublishingFlow();
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

  if (flow)
    return (
      <ArticlesConversation
        articles={query.data ?? []}
        loading={query.loading}
        error={query.error}
        onRetry={query.reload}
      />
    );

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

function ArticlesConversation({
  articles,
  loading,
  error,
  onRetry,
}: {
  articles: ArticleSummary[];
  loading: boolean;
  error?: Error;
  onRetry: () => void;
}) {
  const flow = usePublishingFlow()!;
  const [entry, setEntry] = usePublishingChoice("articleEntry");
  const [articleId, setArticleId] = usePublishingChoice(
    "articleEditorId",
    flow.resources?.find((resource) => resource.kind === "article")?.id ?? "",
  );
  const operationScope = usePublishingOperationScope("article-choice");
  const [pageValue, setPageValue] = usePublishingChoice("articleListPage", "0");
  const [opening, setOpening] = useState(false);
  const [failure, setFailure] = useState("");
  const choose = (value: string) =>
    requestWorkspaceNavigation(() => {
      if (opening) return;
      setPageValue("0");
      setEntry(value);
      setArticleId("");
      setFailure("");
    });
  const openArticle = async (id: string) => {
    if (opening) return;
    const isCurrent = operationScope();
    setOpening(true);
    setFailure("");
    try {
      await flow.record({
        id: `article-open:${id}`,
        label: "已选择稿件",
        detail: articles.find((article) => article.id === id)?.title,
        resources: [{ kind: "article", id }],
      });
      if (isCurrent()) setArticleId(id);
    } catch (reason) {
      if (!isCurrent()) return;
      setFailure(
        reason instanceof Error ? reason.message : "稿件选择未能保存，请重试",
      );
    } finally {
      if (isCurrent()) setOpening(false);
    }
  };
  const visible =
    entry === "frozen"
      ? articles.filter((article) => article.currentVersionId)
      : articles;
  const page = Math.max(
    0,
    Math.min(Number(pageValue) || 0, Math.ceil(visible.length / 10) - 1),
  );
  return (
    <div className="publishing-page publishing-flow-step">
      <PublishingQuestion
        title="这次要从哪里开始准备稿件？"
        description="导入资料或继续已有稿件，确认后冻结一个可用于投放的版本。"
        value={entry}
        onChoose={choose}
        choices={[
          {
            value: "import",
            label: "导入 DOCX",
            description: "检查文件并打开正文编辑",
          },
          {
            value: "existing",
            label: "继续编辑已有稿件",
            description: "从当前项目稿件中选择",
          },
          {
            value: "frozen",
            label: "查看已冻结版本",
            description: "沿用确认过的稿件继续准备",
          },
        ]}
      />
      {failure && (
        <p className="publishing-form-error" role="alert">
          {failure}
        </p>
      )}
      {articleId ? (
        <PublishingStep title="检查正文，确认本次发布版本" id="article-editor">
          <PublishingArticleEditorPage key={articleId} articleId={articleId} />
        </PublishingStep>
      ) : entry === "import" ? (
        <PublishingStep title="请上传需要整理的稿件" id="article-import">
          <PublishingImportPage onImported={setArticleId} />
        </PublishingStep>
      ) : entry ? (
        <PublishingStep title="选择本次要处理的稿件" id="article-list">
          {loading && <PublishingLoading label="正在读取稿件…" />}
          {error && <PublishingError error={error} onRetry={onRetry} />}
          {!loading &&
            !error &&
            (visible.length ? (
              <div className="publishing-list">
                {visible.slice(page * 10, (page + 1) * 10).map((article) => (
                  <button
                    type="button"
                    key={article.id}
                    className="publishing-list-row"
                    disabled={opening}
                    onClick={() => void openArticle(article.id)}
                  >
                    <FileText size={19} />
                    <span className="publishing-list-copy">
                      <strong>{article.title}</strong>
                      <span>
                        {article.currentVersionId
                          ? `v${article.currentVersion} · 已冻结`
                          : "编辑草稿"}
                      </span>
                    </span>
                    <ArrowRight size={17} />
                  </button>
                ))}
                <WorkflowPagination
                  page={page}
                  total={visible.length}
                  onChange={(value) => setPageValue(String(value))}
                />
              </div>
            ) : (
              <PublishingEmpty
                title={entry === "frozen" ? "还没有已冻结的稿件" : "还没有稿件"}
                description="导入 DOCX 后可编辑正文并冻结发布版本。"
                action={
                  <button
                    type="button"
                    className="publishing-button publishing-button-primary"
                    onClick={() => choose("import")}
                  >
                    导入 DOCX
                  </button>
                }
              />
            ))}
        </PublishingStep>
      ) : null}
    </div>
  );
}
