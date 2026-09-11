import { Link, Redirect, useSearch } from "wouter";

import {
  readPublicationRouteState,
  writePublicationWorkbenchRouteState,
} from "../queryState";
import OverviewPage from "./OverviewPage";
import PublicationsPage from "./PublicationsPage";
import { useCallback, useRef, useState } from "react";
import {
  usePublishingFlow,
  usePublishingOperationScope,
} from "../PublishingFlowContext";
import { usePublisherGateway, usePublisherQuery } from "../PublishingContext";
import {
  PublishingQuestion,
  PublishingStep,
  usePublishingChoice,
} from "../components/PublishingConversation";
import {
  PublishingLoading,
  PublishingError,
  PublishingEmpty,
} from "../components/PublishingUi";
import { requestWorkspaceNavigation } from "@/lib/workspace-navigation-guard";
import DraftConversationPage from "./DraftConversationPage";

/** Old saved record-list links retain their filters inside the workbench. */
export function LegacyPublicationListRedirect() {
  const search = useSearch();
  return (
    <Redirect
      to={writePublicationWorkbenchRouteState(
        readPublicationRouteState(search),
      )}
      replace
    />
  );
}

export default function PublishingWorkbenchPage() {
  const flow = usePublishingFlow();
  const search = useSearch();
  const params = new URLSearchParams(search.replace(/^\?/u, ""));
  const records = params.get("tab") === "records";
  // The overview/records tabs are the browsing default; the guided placement
  // conversation opens only through an explicit 新建投放 entry.
  const flowEntryRequested = params.get("flow") === "1";
  if (flow && flowEntryRequested)
    return <PublishingConversation initialRecords={records} />;
  return (
    <>
      <nav className="publishing-workbench-tabs" aria-label="发布工作台视图">
        <Link href="/publishing" aria-current={!records ? "page" : undefined}>
          工作概览
        </Link>
        <Link
          href="/publishing?tab=records"
          aria-current={records ? "page" : undefined}
        >
          发布记录
        </Link>
      </nav>
      {records ? <PublicationsPage /> : <OverviewPage />}
    </>
  );
}

function PublishingConversation({
  initialRecords,
}: {
  initialRecords: boolean;
}) {
  const flow = usePublishingFlow()!;
  const gateway = usePublisherGateway();
  const operationScope = usePublishingOperationScope("publishing-entry");
  const [entry, setEntry] = usePublishingChoice(
    "publishingEntry",
    initialRecords ? "records" : "",
  );
  const [selectedDraft, setSelectedDraft] =
    usePublishingChoice("publishingDraft");
  const [articleVersion, setArticleVersion] = usePublishingChoice(
    "publishingArticleVersion",
  );
  const loadDrafts = useCallback(
    (signal: AbortSignal) => gateway.getDashboard(signal),
    [gateway],
  );
  const loadArticles = useCallback(
    (signal: AbortSignal) => gateway.listArticles(signal),
    [gateway],
  );
  const drafts = usePublisherQuery(loadDrafts, "overview");
  const articles = usePublisherQuery(loadArticles, "article-choices");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const lock = useRef(false);
  const run = async (action: (isCurrent: () => boolean) => Promise<void>) => {
    if (lock.current) return;
    lock.current = true;
    setBusy(true);
    setError("");
    const isCurrent = operationScope();
    try {
      await action(isCurrent);
    } catch (reason) {
      if (isCurrent())
        setError(
          reason instanceof Error ? reason.message : "操作未完成，请重试",
        );
    } finally {
      lock.current = false;
      if (isCurrent()) setBusy(false);
    }
  };
  const frozen =
    articles.data?.filter((article) => article.currentVersionId) ?? [];
  return (
    <div className="publishing-page publishing-flow-step">
      <PublishingQuestion
        title="接下来要处理哪次投放？"
        value={entry}
        description="继续已有草稿，或从确认过的稿件开始。提交与费用确认会在当前任务中完成。"
        choices={[
          {
            value: "drafts",
            label: "继续投放草稿",
            description: "恢复稿件、媒体与标题配置",
          },
          {
            value: "new",
            label: "从已冻结稿件开始",
            description: "确定稿件，再交给媒体助手",
          },
          {
            value: "records",
            label: "查看发布结果",
            description: "查看真实批次、费用与回链",
          },
        ]}
        onChoose={(value) =>
          requestWorkspaceNavigation(() => {
            setEntry(value);
            setSelectedDraft("");
            setError("");
          })
        }
      />
      {error && (
        <p className="publishing-form-error" role="alert">
          {error}
        </p>
      )}
      {selectedDraft && entry === "drafts" ? (
        <DraftConversationPage
          key={selectedDraft}
          draftId={selectedDraft}
          initialStage="titles"
        />
      ) : entry === "drafts" ? (
        <PublishingStep title="选择本次要继续的投放" id="publishing-drafts">
          {drafts.loading && <PublishingLoading />}
          {drafts.error && (
            <PublishingError error={drafts.error} onRetry={drafts.reload} />
          )}
          {drafts.data &&
            (drafts.data.resumableDrafts.length ? (
              <div className="publishing-list">
                {drafts.data.resumableDrafts.map((draft) => (
                  <button
                    type="button"
                    className="publishing-list-row"
                    key={draft.id}
                    disabled={busy}
                    onClick={() =>
                      void run(async (isCurrent) => {
                        const selected = await gateway.getDraft(draft.id);
                        if (!isCurrent()) return;
                        const resources = [
                          {
                            kind: "publication_draft" as const,
                            id: selected.id,
                          },
                          {
                            kind: "article_version" as const,
                            id: selected.articleVersionId,
                          },
                        ];
                        if (!selected.items.length)
                          await flow.handoff({
                            targetAgentId: "media",
                            title: `选择媒体 · ${selected.articleTitle}`,
                            resources,
                            idempotencyKey: `draft-media-${selected.id}`,
                            route: `/publishing/drafts/${selected.id}/media`,
                          });
                        else {
                          await flow.record({
                            id: `draft-selected:${selected.id}`,
                            label: "已选择投放草稿",
                            detail: selected.articleTitle,
                            resources,
                          });
                          if (isCurrent()) setSelectedDraft(selected.id);
                        }
                      })
                    }
                  >
                    <span className="publishing-list-copy">
                      <strong>{draft.articleTitle}</strong>
                      <span>冻结稿件 v{draft.articleVersion} · 继续配置</span>
                    </span>
                    <span>打开草稿</span>
                  </button>
                ))}
              </div>
            ) : (
              <PublishingEmpty
                title="没有待继续的草稿"
                description="选择已冻结稿件后，可开始准备新的投放。"
                action={
                  <button
                    type="button"
                    className="publishing-button publishing-button-primary"
                    onClick={() => setEntry("new")}
                  >
                    从稿件开始
                  </button>
                }
              />
            ))}
        </PublishingStep>
      ) : entry === "new" ? (
        <PublishingStep
          title="本次使用哪篇已确认的稿件？"
          id="publishing-article-choice"
        >
          {articles.loading && <PublishingLoading label="正在读取稿件…" />}
          {articles.error && (
            <PublishingError error={articles.error} onRetry={articles.reload} />
          )}
          {frozen.length ? (
            <>
              <div
                className="publishing-list"
                role="radiogroup"
                aria-label="本次投放稿件"
              >
                {frozen.map((article) => (
                  <label key={article.id} className="publishing-list-row">
                    <input
                      type="radio"
                      name="publishing-frozen-article"
                      checked={articleVersion === article.currentVersionId}
                      onChange={() =>
                        setArticleVersion(article.currentVersionId!)
                      }
                      disabled={busy}
                    />
                    <span className="publishing-list-copy">
                      <strong>{article.title}</strong>
                      <span>
                        v{article.currentVersion} · {article.wordCount ?? 0} 字
                      </span>
                    </span>
                  </label>
                ))}
              </div>
              <div className="publishing-inline-actions">
                <button
                  type="button"
                  className="publishing-button publishing-button-primary"
                  disabled={
                    busy ||
                    !frozen.some(
                      (article) => article.currentVersionId === articleVersion,
                    )
                  }
                  onClick={() =>
                    void run(async () => {
                      const article = frozen.find(
                        (item) => item.currentVersionId === articleVersion,
                      )!;
                      await flow.handoff({
                        targetAgentId: "media",
                        title: `选择媒体 · ${article.title}`,
                        resources: [
                          { kind: "article", id: article.id },
                          { kind: "article_version", id: articleVersion },
                        ],
                        idempotencyKey: `publishing-media-${articleVersion}`,
                        route: `/publishing/media?articleVersion=${encodeURIComponent(articleVersion)}`,
                      });
                    })
                  }
                >
                  确认稿件，交给媒体助手
                </button>
              </div>
            </>
          ) : !articles.loading && !articles.error ? (
            <PublishingEmpty
              title="还没有已冻结稿件"
              description="先在稿件 Agent 中导入、检查并冻结一个版本。"
              action={
                <Link
                  className="publishing-button publishing-button-primary"
                  href="/publishing/articles"
                >
                  打开稿件 Agent
                </Link>
              }
            />
          ) : null}
        </PublishingStep>
      ) : entry === "records" ? (
        <PublishingStep title="查看发布批次与回链" id="publishing-records">
          <PublicationsPage />
        </PublishingStep>
      ) : null}
    </div>
  );
}
