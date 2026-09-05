import { lazy, Suspense } from "react";
import { Redirect, Route, Switch } from "wouter";

import type { PublisherGateway } from "./gateway";
import { PublishingGatewayProvider } from "./PublishingContext";
import { PublishingLoading } from "./components/PublishingUi";
import "./publishing.tokens.css";
import "./publishing.core.css";
import "./publishing.workflow.css";
import "./publishing.media.css";
import "./publishing.records.css";
import "./publishing.admin.css";

const OverviewPage = lazy(() => import("./pages/OverviewPage"));
const ArticlesPage = lazy(() => import("./pages/ArticlesPage"));
const ImportPage = lazy(() => import("./pages/ImportPage"));
const ArticleEditorPage = lazy(() => import("./pages/ArticleEditorPage"));
const MediaLibraryPage = lazy(() => import("./pages/MediaLibraryPage"));
const TitlesPage = lazy(() => import("./pages/TitlesPage"));
const ReviewPage = lazy(() => import("./pages/ReviewPage"));
const PublicationsPage = lazy(() => import("./pages/PublicationsPage"));
const PublicationDetailPage = lazy(
  () => import("./pages/PublicationDetailPage"),
);

export type PublishingRoutesProps = {
  gateway: PublisherGateway;
};

export default function PublishingRoutes({ gateway }: PublishingRoutesProps) {
  return (
    <PublishingGatewayProvider gateway={gateway}>
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
            {(params) => <TitlesPage draftId={params.draftId} />}
          </Route>
          <Route path="/publishing/drafts/:draftId/review">
            {(params) => <ReviewPage draftId={params.draftId} />}
          </Route>
          <Route path="/publishing/publications/:batchId">
            {(params) => <PublicationDetailPage batchId={params.batchId} />}
          </Route>
          <Route path="/publishing/publications">
            <PublicationsPage />
          </Route>
          <Route path="/publishing">
            <OverviewPage />
          </Route>
          <Route>
            <Redirect to="/publishing" />
          </Route>
        </Switch>
      </Suspense>
    </PublishingGatewayProvider>
  );
}
