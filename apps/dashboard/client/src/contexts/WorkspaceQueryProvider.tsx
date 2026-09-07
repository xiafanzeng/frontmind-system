import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useLayoutEffect, useMemo, useRef, type ReactNode } from "react";
import { useLocation, useSearch } from "wouter";
import { trpc } from "@/lib/trpc";
import { createDashboardTransport } from "@/lib/dashboard-transport";
import { enterpriseWorkspaceScope } from "@/lib/enterprise-project";
import { activateWorkspaceRestScope } from "@/lib/workspace-rest-scope";

/** Auth stays mounted above this boundary; project caches and in-flight requests never cross it. */
export function WorkspaceQueryProvider({ userId, children }: { userId: number; children: ReactNode }) {
  const [pathname] = useLocation();
  const search = useSearch();
  const projectId = enterpriseWorkspaceScope(pathname, search);
  const owner = new URLSearchParams(search).get("operatorOwnerId") || "self";
  const scopeKey = `${userId}:${owner}:${projectId || "account"}`;
  return <WorkspaceQueryScope key={scopeKey} scopeKey={scopeKey} projectId={projectId}>{children}</WorkspaceQueryScope>;
}

function WorkspaceQueryScope({ scopeKey, projectId, children }: { scopeKey: string; projectId?: string; children: ReactNode }) {
  const state = useMemo(() => {
    const controller = new AbortController();
    return {
      controller,
      queryClient: new QueryClient({ defaultOptions: { queries: { staleTime: 20_000 }, mutations: { retry: false } } }),
      client: createDashboardTransport(projectId ? { "x-enterprise-project-id": projectId } : {}, controller.signal),
    };
  }, [projectId]);
  const generation = useRef(0);
  useLayoutEffect(() => activateWorkspaceRestScope(scopeKey, projectId), [scopeKey, projectId]);
  useLayoutEffect(() => {
    const current = ++generation.current;
    return () => {
      // React StrictMode replays effects without retiring this mounted workspace.
      queueMicrotask(() => {
        if (generation.current !== current) return;
        state.controller.abort();
        void state.queryClient.cancelQueries();
        state.queryClient.clear();
      });
    };
  }, [state]);
  return <trpc.Provider client={state.client} queryClient={state.queryClient}>
    <QueryClientProvider client={state.queryClient}>{children}</QueryClientProvider>
  </trpc.Provider>;
}
