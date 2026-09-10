import { act, render, screen, cleanup } from "@testing-library/react";
import { useQueryClient, focusManager, type QueryClient } from "@tanstack/react-query";
import { StrictMode, useEffect } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Link, Router } from "wouter";
import { navigate } from "wouter/use-browser-location";
import { useWorkspaceLocation } from "@/hooks/useWorkspaceLocation";
import { projectWorkspaceUrl } from "@/lib/enterprise-project";

const transports = vi.hoisted(() => ({
  liveSignal: undefined as AbortSignal | undefined,
  create: vi.fn(),
  activate: vi.fn(() => vi.fn()),
}));
vi.mock("@/lib/dashboard-transport", () => ({
  createDashboardTransport: transports.create,
}));
vi.mock("@/lib/workspace-rest-scope", async (original) => ({
  ...await original<typeof import("@/lib/workspace-rest-scope")>(),
  activateWorkspaceRestScope: transports.activate,
}));
vi.mock("@/lib/trpc", () => ({
  trpc: {
    Provider: ({
      children,
      client,
    }: {
      children: React.ReactNode;
      client: { signal: AbortSignal };
    }) => {
      transports.liveSignal = client.signal;
      return children;
    },
  },
}));
import {
  WorkspaceQueryProvider,
  useProjectDirectory,
} from "./WorkspaceQueryProvider";

let currentClient: QueryClient;
let currentDirectory: ReturnType<typeof useProjectDirectory>["directory"];
let mounts = 0;
function Content() {
  currentClient = useQueryClient();
  currentDirectory = useProjectDirectory().directory;
  useEffect(() => {
    mounts++;
  }, []);
  return <Link href="/publishing/media">媒体资源</Link>;
}
function Workspace({ userId = 7 }: { userId?: number } = {}) {
  return (
    <Router
      hook={useWorkspaceLocation}
      hrefs={(href) => projectWorkspaceUrl(href)}
    >
      <WorkspaceQueryProvider userId={userId}>
        <Content />
      </WorkspaceQueryProvider>
    </Router>
  );
}
beforeEach(() => {
  mounts = 0;
  transports.create.mockReset().mockImplementation((_headers, signal) => ({
    signal,
    enterpriseProjects: {
      list: { query: vi.fn().mockResolvedValue({ projects: [] }) },
    },
  }));
  window.history.replaceState(
    null,
    "",
    "/?enterpriseProjectId=project-a&operatorOwnerId=7",
  );
});
afterEach(async () => {
  cleanup();
  await act(async () => {});
  window.history.replaceState(null, "", "/");
});

describe("workspace request lifetime", () => {
  const directoryKey = (ownerUserId = 7) =>
    [
      ["enterpriseProjects", "list"],
      { input: { ownerUserId }, type: "query" },
    ] as const;
  it("retains only the same viewer-owner project directory through account and project transitions", async () => {
    render(<Workspace />);
    await act(async () => {});
    const key = directoryKey();
    const projects = { projects: [{ id: "project-a", name: "企业甲" }] };
    act(() => {
      currentDirectory.queryClient.setQueryData(key, projects);
      currentClient.setQueryData(["private-content"], "A only");
    });
    await act(async () => navigate("/agent"));
    expect(currentDirectory.queryClient.getQueryData(key)).toEqual(projects);
    expect(currentClient.getQueryData(["private-content"])).toBeUndefined();
    await act(async () => navigate("/?enterpriseProjectId=project-a"));
    expect(currentDirectory.queryClient.getQueryData(key)).toEqual(projects);
    const sameScope = currentClient;
    await act(async () =>
      navigate("/publishing?enterpriseProjectId=project-a"),
    );
    expect(currentClient).toBe(sameScope);
    expect(currentDirectory.queryClient.getQueryData(key)).toEqual(projects);
    act(() => currentDirectory.queryClient.setQueryData(key, { projects: [] }));
    await act(async () => navigate("/account"));
    expect(currentDirectory.queryClient.getQueryData(key)).toEqual({
      projects: [],
    });
  });

  it("does not transfer the directory or late old-owner updates across owner and authenticated account boundaries", async () => {
    const view = render(<Workspace />);
    await act(async () => {});
    const oldClient = currentDirectory.queryClient;
    act(() =>
      currentDirectory.queryClient.setQueryData(directoryKey(), {
        projects: [{ id: "private-a" }],
      }),
    );
    await act(async () =>
      navigate("/?enterpriseProjectId=project-b&operatorOwnerId=8"),
    );
    expect(
      currentDirectory.queryClient.getQueryData(directoryKey()),
    ).toBeUndefined();
    act(() => {
      oldClient.setQueryData(directoryKey(), {
        projects: [{ id: "late-private-a" }],
      });
      currentDirectory.queryClient.setQueryData(directoryKey(8), {
        projects: [{ id: "private-b" }],
      });
    });
    await act(async () => navigate("/account?operatorOwnerId=8"));
    expect(
      currentDirectory.queryClient.getQueryData(directoryKey()),
    ).toBeUndefined();
    expect(currentDirectory.queryClient.getQueryData(directoryKey(8))).toEqual({
      projects: [{ id: "private-b" }],
    });
    view.rerender(<Workspace userId={9} />);
    expect(
      currentDirectory.queryClient.getQueryData(directoryKey(8)),
    ).toBeUndefined();
  });

  it("preserves the client and mounted shell within a project and scopes native links", async () => {
    render(<Workspace />);
    const original = currentClient;
    original.setQueryData(["private-result"], "A only");
    expect(screen.getByRole("link")).toHaveAttribute(
      "href",
      "/publishing/media?enterpriseProjectId=project-a&operatorOwnerId=7",
    );
    await act(async () =>
      navigate(
        "/publishing/media?enterpriseProjectId=project-a&operatorOwnerId=7",
      ),
    );
    expect(currentClient).toBe(original);
    expect(mounts).toBe(1);
    expect(original.getQueryData(["private-result"])).toBe("A only");
  });

  it("retires old requests and data when the enterprise or account changes", async () => {
    render(<Workspace />);
    const old = currentClient;
    const oldSignal = transports.create.mock.calls.at(-1)![1] as AbortSignal;
    old.setQueryData(["private-result"], "A only");
    await act(async () =>
      navigate("/?enterpriseProjectId=project-b&operatorOwnerId=7"),
    );
    expect(currentClient).not.toBe(old);
    expect(currentClient.getQueryData(["private-result"])).toBeUndefined();
    expect(old.getQueryData(["private-result"])).toBeUndefined();
    expect(oldSignal.aborted).toBe(true);
    expect(transports.create.mock.calls.at(-1)![0]).toEqual({
      "x-enterprise-project-id": "project-b",
    });
    await act(async () => navigate("/agent"));
    expect(transports.create.mock.calls.at(-1)![0]).toEqual({});
    expect(mounts).toBe(3);
  });

  it("keeps owner management alive and pending across a business project switch", async () => {
    let finish!: (value: unknown) => void;
    const deletion = vi.fn(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    transports.create.mockImplementation((_headers, signal) => ({
      signal,
      enterpriseProjects: {
        list: {
          query: vi.fn().mockResolvedValue({
            projects: [
              { id: "project-b", name: "乙", ownerUserId: 7, revision: 1 },
            ],
          }),
        },
        delete: { mutate: deletion },
      },
    }));
    render(<Workspace />);
    await act(async () => {});
    const owner = currentDirectory;
    let pending!: Promise<void>;
    await act(async () => {
      pending = owner.delete({ id: "project-a", revision: 1 });
    });
    await act(async () =>
      navigate("/?enterpriseProjectId=project-b&operatorOwnerId=7"),
    );
    expect(currentDirectory).toBe(owner);
    expect(owner.controller.signal.aborted).toBe(false);
    expect(owner.getPending()).toBe(true);
    await act(async () => {
      finish({});
      await pending;
    });
    expect(window.location.search).toBe(
      "?enterpriseProjectId=project-b&operatorOwnerId=7",
    );
    expect(
      currentDirectory.latest()?.projects.map((project) => project.id),
    ).toEqual(["project-b"]);
    expect(owner.getPending()).toBe(false);
    await act(async () => navigate("/?operatorOwnerId=8"));
    expect(owner.controller.signal.aborted).toBe(true);
    expect(currentDirectory).not.toBe(owner);
  });

  it("refreshes the owner directory when the browser regains focus", async () => {
    const list = vi.fn().mockResolvedValue({ projects: [] });
    transports.create.mockImplementation((_headers, signal) => ({
      signal,
      enterpriseProjects: { list: { query: list } },
    }));
    render(<Workspace />);
    await act(async () => {});
    const calls = list.mock.calls.length;
    await act(async () => {
      await currentDirectory.queryClient.invalidateQueries({
        queryKey: currentDirectory.queryKey,
        refetchType: "none",
      });
      focusManager.setFocused(false);
      focusManager.setFocused(true);
    });
    expect(list.mock.calls.length).toBe(calls + 1);
    focusManager.setFocused(undefined);
  });

  it("keeps the live transport usable after StrictMode effect replay", async () => {
    const view = render(
      <StrictMode>
        <Workspace />
      </StrictMode>,
    );
    const signal = transports.liveSignal!;
    const ownerSignal = currentDirectory.controller.signal;
    await act(async () => {});
    expect(signal.aborted).toBe(false);
    expect(ownerSignal.aborted).toBe(false);
    expect(currentDirectory.alive).toBe(true);
    view.unmount();
    await act(async () => {});
    expect(signal.aborted).toBe(true);
    expect(ownerSignal.aborted).toBe(true);
  });
});
