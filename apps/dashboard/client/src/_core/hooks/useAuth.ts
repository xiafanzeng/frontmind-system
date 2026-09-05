import { trpc } from "@/lib/trpc";
import { TRPCClientError } from "@trpc/client";
import { useQueryClient } from "@tanstack/react-query";
import {
  createContext,
  createElement,
  useCallback,
  useContext,
  useMemo,
  type ReactNode,
} from "react";

export type AuthUser = {
  id: number;
  username: string;
  displayName: string | null;
  role: "user" | "admin" | "delivery_member";
  adminAccessLevel: "system_admin" | "delivery_admin" | null;
  engineerRoleType:
    | "ai_operations_engineer"
    | "monitoring_optimization_engineer"
    | "content_distribution_engineer"
    | null;
  engineerApiKeyConfigured?: boolean;
  engineerApiKeyVersion?: number;
  engineerApiKeyManageable?: boolean;
  engineerApiKeyManageReason?: string | null;
  marketEdition: "domestic" | "overseas";
  isActive: boolean;
};

export type AuthSession = {
  user: AuthUser | null;
  loading: boolean;
  error: unknown;
  isAuthenticated: boolean;
  login: (username: string, password: string) => Promise<unknown>;
  loginPending: boolean;
  loginError: unknown;
  refresh: () => Promise<unknown>;
  logout: () => Promise<void>;
};

const AuthSessionContext = createContext<AuthSession | null>(null);

function isAuthSessionQuery(queryKey: readonly unknown[]) {
  const path = queryKey[0];
  return (
    Array.isArray(path) &&
    path.length === 2 &&
    path[0] === "auth" &&
    path[1] === "me"
  );
}

/**
 * Owns the application's only auth.me observer. Consumers read the same
 * session snapshot from context instead of mounting another zero-stale query.
 */
export function AuthSessionProvider({ children }: { children: ReactNode }) {
  const utils = trpc.useUtils();
  const queryClient = useQueryClient();

  const meQuery = trpc.auth.me.useQuery(undefined, {
    retry: false,
    staleTime: 5 * 60 * 1000,
    refetchOnMount: false,
    refetchOnReconnect: true,
    refetchOnWindowFocus: true,
  });

  const loginMutation = trpc.auth.login.useMutation({
    onSuccess: ({ user }) => {
      // The login response is already authoritative for this session. Using it
      // avoids an immediate follow-up auth.me request before the workspace can
      // render.
      utils.auth.me.setData(undefined, user);
    },
  });

  const logoutMutation = trpc.auth.logout.useMutation();

  const login = useCallback(
    (username: string, password: string) =>
      loginMutation.mutateAsync({ username, password }),
    [loginMutation],
  );

  const logout = useCallback(async () => {
    try {
      // Revoke the server-side session before dismantling the protected UI.
      await logoutMutation.mutateAsync();
    } catch (error: unknown) {
      if (
        !(error instanceof TRPCClientError) ||
        error.data?.code !== "UNAUTHORIZED"
      ) {
        throw error;
      }
    }

    // Updating this single observer first unmounts protected consumers. Then
    // cancel and remove account-scoped queries without queryClient.clear(),
    // which used to wake every observer and trigger a logout request storm.
    utils.auth.me.setData(undefined, null);
    await queryClient.cancelQueries({
      predicate: (query) => !isAuthSessionQuery(query.queryKey),
    });
    queryClient.removeQueries({
      predicate: (query) => !isAuthSessionQuery(query.queryKey),
    });
    logoutMutation.reset();
  }, [logoutMutation, queryClient, utils]);

  const state = useMemo<AuthSession>(
    () => ({
      user: (meQuery.data ?? null) as AuthUser | null,
      loading: meQuery.isLoading || logoutMutation.isPending,
      error: meQuery.error ?? logoutMutation.error ?? null,
      isAuthenticated: Boolean(meQuery.data),
      login,
      loginPending: loginMutation.isPending,
      loginError: loginMutation.error,
      refresh: () => meQuery.refetch(),
      logout,
    }),
    [
      login,
      loginMutation.error,
      loginMutation.isPending,
      logout,
      logoutMutation.error,
      logoutMutation.isPending,
      meQuery.data,
      meQuery.error,
      meQuery.isLoading,
      meQuery.refetch,
    ],
  );

  return createElement(AuthSessionContext.Provider, { value: state }, children);
}

export function useAuth() {
  const session = useContext(AuthSessionContext);
  if (!session) {
    throw new Error("useAuth must be used inside AuthSessionProvider");
  }
  return session;
}
