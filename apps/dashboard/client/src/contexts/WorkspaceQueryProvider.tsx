import {
  QueryClient,
  QueryClientProvider,
  useQuery,
} from "@tanstack/react-query";
import {
  createContext,
  useContext,
  useLayoutEffect,
  useMemo,
  useRef,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import { useLocation, useSearch } from "wouter";
import { trpc } from "@/lib/trpc";
import { createDashboardTransport } from "@/lib/dashboard-transport";
import { enterpriseWorkspaceScope } from "@/lib/enterprise-project";
import { ProjectDirectory } from "@/lib/project-directory";
import { activateWorkspaceRestScope } from "@/lib/workspace-rest-scope";

const DirectoryContext = createContext<ProjectDirectory | null>(null);
export function useProjectDirectory() {
  const directory = useContext(DirectoryContext);
  if (!directory) throw new Error("项目目录必须在客户工作区中读取。");
  const projectsQuery = useQuery(
    directory.queryOptions(),
    directory.queryClient,
  );
  const managing = useSyncExternalStore(
    directory.subscribe,
    directory.getPending,
    directory.getPending,
  );
  return { directory, projectsQuery, managing };
}

/** Auth stays above this boundary; only the directory survives same-owner project changes. */
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
  const requestedOwner = Number(
    new URLSearchParams(search).get("operatorOwnerId"),
  );
  const ownerUserId =
    Number.isSafeInteger(requestedOwner) && requestedOwner > 0
      ? requestedOwner
      : userId;
  const identity = `${userId}:${ownerUserId}`;
  return (
    <OwnerDirectoryScope
      key={identity}
      viewerUserId={userId}
      ownerUserId={ownerUserId}
    >
      <WorkspaceQueryScope
        key={projectId || "account"}
        scopeKey={`${identity}:${projectId || "account"}`}
        projectId={projectId}
      >
        {children}
      </WorkspaceQueryScope>
    </OwnerDirectoryScope>
  );
}

function OwnerDirectoryScope({
  viewerUserId,
  ownerUserId,
  children,
}: {
  viewerUserId: number;
  ownerUserId: number;
  children: ReactNode;
}) {
  const directory = useMemo(
    () => new ProjectDirectory(viewerUserId, ownerUserId),
    [viewerUserId, ownerUserId],
  );
  const generation = useRef(0);
  useLayoutEffect(() => {
    const current = ++generation.current;
    directory.activate();
    directory.queryClient.mount();
    return () => {
      directory.deactivate();
      directory.queryClient.unmount();
      queueMicrotask(() => {
        if (generation.current === current) directory.retire();
      });
    };
  }, [directory]);
  return (
    <DirectoryContext.Provider value={directory}>
      {children}
    </DirectoryContext.Provider>
  );
}

function WorkspaceQueryScope({
  scopeKey,
  projectId,
  children,
}: {
  scopeKey: string;
  projectId?: string;
  children: ReactNode;
}) {
  const state = useMemo(() => {
    const controller = new AbortController();
    const queryClient = new QueryClient({
      defaultOptions: {
        queries: { staleTime: 20_000 },
        mutations: { retry: false },
      },
    });
    return {
      controller,
      queryClient,
      client: createDashboardTransport(
        projectId ? { "x-enterprise-project-id": projectId } : {},
        controller.signal,
      ),
    };
  }, [projectId]);
  const generation = useRef(0);
  useLayoutEffect(
    () => activateWorkspaceRestScope(scopeKey, projectId),
    [scopeKey, projectId],
  );
  useLayoutEffect(() => {
    const current = ++generation.current;
    return () => {
      // StrictMode replays effects without retiring the mounted workspace.
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
