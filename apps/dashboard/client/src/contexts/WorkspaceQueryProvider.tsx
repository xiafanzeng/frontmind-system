import {
  QueryClient,
  QueryClientProvider,
  type QueryKey,
} from "@tanstack/react-query";
import { useLayoutEffect, useMemo, useRef, type ReactNode } from "react";
import { useLocation, useSearch } from "wouter";
import { trpc } from "@/lib/trpc";
import { createDashboardTransport } from "@/lib/dashboard-transport";
import { enterpriseWorkspaceScope } from "@/lib/enterprise-project";
import { activateWorkspaceRestScope } from "@/lib/workspace-rest-scope";

type DirectoryCache = {
  identity: string;
  ownerUserId: number;
  snapshot?: { queryKey: QueryKey; data: unknown; updatedAt: number };
};

/** Auth stays mounted above this boundary; project caches and in-flight requests never cross it. */
export function WorkspaceQueryProvider({
  userId,
  children,
}: {
  userId: number;
  children: ReactNode;
}) {
  const [pathname] = useLocation();
  const search = useSearch();
  const projectId = enterpriseWorkspaceScope(pathname, search);
  const owner = new URLSearchParams(search).get("operatorOwnerId") || "self";
  const scopeKey = `${userId}:${owner}:${projectId || "account"}`;
  const requestedOwner = Number(owner);
  const ownerUserId =
    Number.isSafeInteger(requestedOwner) && requestedOwner > 0
      ? requestedOwner
      : userId;
  const identity = `${userId}:${ownerUserId}`;
  const directory = useRef<DirectoryCache>({ identity, ownerUserId });
  // Only the account-owned directory may survive project changes. A different
  // viewer or owner receives a new object; old subscriptions cannot update it.
  if (directory.current.identity !== identity)
    directory.current = { identity, ownerUserId };
  return (
    <WorkspaceQueryScope
      key={scopeKey}
      scopeKey={scopeKey}
      projectId={projectId}
      directory={directory.current}
    >
      {children}
    </WorkspaceQueryScope>
  );
}

function WorkspaceQueryScope({
  scopeKey,
  projectId,
  children,
  directory,
}: {
  scopeKey: string;
  projectId?: string;
  children: ReactNode;
  directory: DirectoryCache;
}) {
  const state = useMemo(() => {
    const controller = new AbortController();
    const queryClient = new QueryClient({
      defaultOptions: {
        queries: { staleTime: 20_000 },
        mutations: { retry: false },
      },
    });
    if (directory.snapshot) {
      const { queryKey, data, updatedAt } = directory.snapshot;
      queryClient.setQueryData(queryKey, data, { updatedAt });
    }
    return {
      controller,
      queryClient,
      client: createDashboardTransport(
        projectId ? { "x-enterprise-project-id": projectId } : {},
        controller.signal,
      ),
    };
  }, [projectId, directory]);
  useLayoutEffect(
    () =>
      state.queryClient.getQueryCache().subscribe((event) => {
        if (event.type !== "updated") return;
        const query = event.query;
        const [path, options] = query.queryKey;
        if (
          !Array.isArray(path) ||
          path.join(".") !== "enterpriseProjects.list"
        )
          return;
        if (
          (options as { input?: { ownerUserId?: number } } | undefined)?.input
            ?.ownerUserId !== directory.ownerUserId
        )
          return;
        if (
          query.state.status === "success" &&
          query.state.data !== undefined
        ) {
          directory.snapshot = {
            queryKey: query.queryKey,
            data: query.state.data,
            updatedAt: query.state.dataUpdatedAt,
          };
        }
      }),
    [state, directory],
  );
  const generation = useRef(0);
  useLayoutEffect(
    () => activateWorkspaceRestScope(scopeKey, projectId),
    [scopeKey, projectId],
  );
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
  return (
    <trpc.Provider client={state.client} queryClient={state.queryClient}>
      <QueryClientProvider client={state.queryClient}>
        {children}
      </QueryClientProvider>
    </trpc.Provider>
  );
}
