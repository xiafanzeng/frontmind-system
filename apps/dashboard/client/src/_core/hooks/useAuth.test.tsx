import { act, render } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  authMeUseQuery: vi.fn(),
  authLoginUseMutation: vi.fn(),
  authLogoutUseMutation: vi.fn(),
  setAuthData: vi.fn(),
  loginMutateAsync: vi.fn(),
  logoutMutateAsync: vi.fn(),
  logoutReset: vi.fn(),
  refetch: vi.fn(),
}));

vi.mock("@/lib/trpc", () => ({
  trpc: {
    useUtils: () => ({
      auth: { me: { setData: mocks.setAuthData } },
    }),
    auth: {
      me: { useQuery: mocks.authMeUseQuery },
      login: { useMutation: mocks.authLoginUseMutation },
      logout: { useMutation: mocks.authLogoutUseMutation },
    },
  },
}));

import { AuthSessionProvider, useAuth, type AuthUser } from "./useAuth";

const user: AuthUser = {
  id: 42,
  username: "tester",
  displayName: "测试账号",
  role: "user",
  adminAccessLevel: null,
  engineerRoleType: null,
  marketEdition: "domestic",
  isActive: true,
};

function createHarness(queryClient: QueryClient, children: ReactNode) {
  return render(
    <QueryClientProvider client={queryClient}>
      <AuthSessionProvider>{children}</AuthSessionProvider>
    </QueryClientProvider>,
  );
}

describe("AuthSessionProvider", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.authMeUseQuery.mockReturnValue({
      data: user,
      isLoading: false,
      error: null,
      refetch: mocks.refetch,
    });
    mocks.authLoginUseMutation.mockImplementation(
      (options: { onSuccess: (value: { user: AuthUser }) => void }) => ({
        mutateAsync: async (input: { username: string; password: string }) => {
          const value = await mocks.loginMutateAsync(input);
          options.onSuccess(value);
          return value;
        },
        isPending: false,
        error: null,
      }),
    );
    mocks.authLogoutUseMutation.mockReturnValue({
      mutateAsync: mocks.logoutMutateAsync,
      reset: mocks.logoutReset,
      isPending: false,
      error: null,
    });
    mocks.loginMutateAsync.mockResolvedValue({ user });
    mocks.logoutMutateAsync.mockResolvedValue({ success: true });
  });

  it("mounts one auth.me observer for many session consumers", () => {
    function Consumer() {
      const { user: currentUser } = useAuth();
      return <span>{currentUser?.username}</span>;
    }

    createHarness(
      new QueryClient(),
      <>
        <Consumer />
        <Consumer />
        <Consumer />
      </>,
    );

    expect(mocks.authMeUseQuery).toHaveBeenCalledTimes(1);
    expect(mocks.authMeUseQuery).toHaveBeenCalledWith(
      undefined,
      expect.objectContaining({
        staleTime: 5 * 60 * 1000,
        refetchOnMount: false,
      }),
    );
  });

  it("uses the login response without another auth.me request", async () => {
    let login: ReturnType<typeof useAuth>["login"] | undefined;
    function Consumer() {
      login = useAuth().login;
      return null;
    }

    createHarness(new QueryClient(), <Consumer />);
    await act(async () => {
      await login?.("tester", "password");
    });

    expect(mocks.setAuthData).toHaveBeenCalledWith(undefined, user);
    expect(mocks.authMeUseQuery).toHaveBeenCalledTimes(1);
    expect(mocks.refetch).not.toHaveBeenCalled();
  });

  it("revokes first and removes account queries without clearing the cache", async () => {
    const queryClient = new QueryClient();
    const clearSpy = vi.spyOn(queryClient, "clear");
    queryClient.setQueryData([["auth", "me"]], user);
    queryClient.setQueryData([["conversation", "list"]], { secret: true });
    let logout: ReturnType<typeof useAuth>["logout"] | undefined;

    function Consumer() {
      logout = useAuth().logout;
      return null;
    }

    createHarness(queryClient, <Consumer />);
    await act(async () => {
      await logout?.();
    });

    expect(mocks.logoutMutateAsync).toHaveBeenCalledTimes(1);
    expect(mocks.setAuthData).toHaveBeenCalledWith(undefined, null);
    expect(
      queryClient.getQueryData([["conversation", "list"]]),
    ).toBeUndefined();
    expect(queryClient.getQueryData([["auth", "me"]])).toEqual(user);
    expect(clearSpy).not.toHaveBeenCalled();
  });
});
