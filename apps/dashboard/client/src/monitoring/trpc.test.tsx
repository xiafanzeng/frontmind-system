import { afterEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { trpc as dashboardTrpc } from "@/lib/trpc";
import { createTrpcClient, trpc } from "./trpc";

afterEach(() => vi.unstubAllGlobals());

describe("unified module transport", () => {
  it("uses the Dashboard cookie against the same-origin monitoring endpoint", async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValue(
        new Response(
          JSON.stringify([{ result: { data: { tenant: "linked" } } }]),
          { headers: { "content-type": "application/json" } },
        ),
      );
    vi.stubGlobal("fetch", fetcher);
    const data = await createTrpcClient().auth.me.query();
    expect(data).toEqual({ tenant: "linked" });
    expect(String(fetcher.mock.calls[0][0])).toMatch(
      /^\/api\/monitoring\/trpc\/auth.me\?/,
    );
    expect(fetcher.mock.calls[0][1]).toMatchObject({
      credentials: "same-origin",
    });
  });

  it("retains distinct Dashboard and monitoring clients inside the module", () => {
    const dashboardClient = dashboardTrpc.createClient({ links: [] });
    const moduleClient = createTrpcClient();
    const dashboardQueries = new QueryClient();
    const moduleQueries = new QueryClient();
    const key = [["auth", "me"], { type: "query" }];
    dashboardQueries.setQueryData(key, { id: 11 });
    moduleQueries.setQueryData(key, { user: { id: "tenant-22" } });
    function Probe() {
      const dashboard = dashboardTrpc.useUtils();
      const module = trpc.useUtils();
      return (
        <div>
          {dashboard.auth.me.getData()?.id === 11 &&
          module.auth.me.getData()?.user.id === "tenant-22"
            ? "isolated"
            : "mixed"}
        </div>
      );
    }
    render(
      <QueryClientProvider client={dashboardQueries}>
        <dashboardTrpc.Provider
          client={dashboardClient}
          queryClient={dashboardQueries}
        >
          <QueryClientProvider client={moduleQueries}>
            <trpc.Provider client={moduleClient} queryClient={moduleQueries}>
              <Probe />
            </trpc.Provider>
          </QueryClientProvider>
        </dashboardTrpc.Provider>
      </QueryClientProvider>,
    );
    expect(screen.getByText("isolated")).toBeInTheDocument();
  });
});
