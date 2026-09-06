import { Link, Redirect, useSearch } from "wouter";

import { readPublicationRouteState, writePublicationWorkbenchRouteState } from "../queryState";
import OverviewPage from "./OverviewPage";
import PublicationsPage from "./PublicationsPage";

/** Old saved record-list links retain their filters inside the workbench. */
export function LegacyPublicationListRedirect() {
  const search = useSearch();
  return <Redirect to={writePublicationWorkbenchRouteState(readPublicationRouteState(search))} replace />;
}

export default function PublishingWorkbenchPage() {
  const search = useSearch();
  const records = new URLSearchParams(search.replace(/^\?/u, "")).get("tab") === "records";
  return (
    <>
      <nav className="publishing-workbench-tabs" aria-label="发布工作台视图">
        <Link href="/publishing" aria-current={!records ? "page" : undefined}>工作概览</Link>
        <Link href="/publishing?tab=records" aria-current={records ? "page" : undefined}>发布记录</Link>
      </nav>
      {records ? <PublicationsPage /> : <OverviewPage />}
    </>
  );
}
