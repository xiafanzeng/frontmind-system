import { lazy, Suspense } from "react";
import { Redirect, Route, Switch } from "wouter";

import type { PublisherGateway } from "./gateway";
import { PublishingGatewayProvider } from "./PublishingContext";
import { PublishingFlowBridge } from "./PublishingFlowContext";
import { PublishingLoading } from "./components/PublishingUi";
import "./publishing.tokens.css";
import "./publishing.core.css";
import "./publishing.workflow.css";
import "./publishing.media.css";
import "./publishing.records.css";
import "./publishing.admin.css";
import "./publishing.conversation.css";

const WorkbenchPage = lazy(() => import("./pages/WorkbenchPage"));
const LegacyPublicationListRedirect = lazy(() =>
  import("./pages/WorkbenchPage").then((module) => ({
    default: module.LegacyPublicationListRedirect,
  })),
);
const ArticlesPage = lazy(() => import("./pages/ArticlesPage"));
const ImportPage = lazy(() => import("./pages/ImportPage"));
const ArticleEditorPage = lazy(() => import("./pages/ArticleEditorPage"));
const MediaLibraryPage = lazy(() => import("./pages/MediaLibraryPage"));
const DraftConversationPage = lazy(
  () => import("./pages/DraftConversationPage"),
);
const PublicationDetailPage = lazy(
  () => import("./pages/PublicationDetailPage"),
);

export type PublishingRoutesProps = {
  gateway: PublisherGateway;
};

export default function PublishingRoutes({ gateway }: PublishingRoutesProps) {
  return (
    <PublishingGatewayProvider gateway={gateway}>
      <PublishingFlowBridge>
        <Suspense
          fallback={
            <div className="publishing-page">
              <PublishingLoading label="正在准备媒体发布工作台…" />
            </div>
          }
        >
          <Switch>
            <Route path="/publishing/articles/new/import">
              <ImportPage />
            </Route>
            <Route path="/publishing/articles/:articleId/edit">
              {(params) => <ArticleEditorPage articleId={params.articleId} />}
            </Route>
            <Route path="/publishing/articles">
              <ArticlesPage />
            </Route>
            <Route path="/publishing/media">
              <MediaLibraryPage />
            </Route>
            <Route path="/publishing/drafts/:draftId/media">
              {(params) => <MediaLibraryPage draftId={params.draftId} />}
            </Route>
            <Route path="/publishing/drafts/:draftId/titles">
              {(params) => (
                <DraftConversationPage
                  draftId={params.draftId}
                  initialStage="titles"
                />
              )}
            </Route>
            <Route path="/publishing/drafts/:draftId/review">
              {(params) => (
                <DraftConversationPage
                  draftId={params.draftId}
                  initialStage="review"
                />
              )}
            </Route>
            <Route path="/publishing/publications/:batchId">
              {(params) => <PublicationDetailPage batchId={params.batchId} />}
            </Route>
            <Route path="/publishing/publications">
              <LegacyPublicationListRedirect />
            </Route>
            <Route path="/publishing">
              <WorkbenchPage />
            </Route>
            <Route>
              <Redirect to="/publishing" />
            </Route>
          </Switch>
        </Suspense>
      </PublishingFlowBridge>
    </PublishingGatewayProvider>
  );
}
