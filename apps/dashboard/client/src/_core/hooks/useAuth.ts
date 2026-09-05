import { trpc } from "@/lib/trpc";
import { TRPCClientError } from "@trpc/client";
import { useQueryClient } from "@tanstack/react-query";
import { useCallback, useMemo } from "react";

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

export function useAuth() {
  const utils = trpc.useUtils();
  const queryClient = useQueryClient();

  const meQuery = trpc.auth.me.useQuery(undefined, {
    retry: false,
    staleTime: 0,
    refetchOnMount: "always",
    refetchOnReconnect: true,
    refetchOnWindowFocus: true,
  });

  const loginMutation = trpc.auth.login.useMutation({
    onSuccess: ({ user }) => {
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
      await logoutMutation.mutateAsync();
    } catch (error: unknown) {
      if (
        !(error instanceof TRPCClientError) ||
        error.data?.code !== "UNAUTHORIZED"
      ) {
        throw error;
      }
    } finally {
      // Conversations, credential metadata and admin data must not survive an
      // account switch in the shared React Query cache.
      utils.auth.me.setData(undefined, null);
      queryClient.clear();
      logoutMutation.reset();
    }
  }, [logoutMutation, queryClient, utils]);

  const state = useMemo(
    () => ({
      user: (meQuery.data ?? null) as AuthUser | null,
      loading: meQuery.isLoading || logoutMutation.isPending,
      error: meQuery.error ?? logoutMutation.error ?? null,
      isAuthenticated: Boolean(meQuery.data),
    }),
    [
      meQuery.data,
      meQuery.error,
      meQuery.isLoading,
      logoutMutation.error,
      logoutMutation.isPending,
    ],
  );

  return {
    ...state,
    login,
    loginPending: loginMutation.isPending,
    loginError: loginMutation.error,
    refresh: () => meQuery.refetch(),
    logout,
  };
}
