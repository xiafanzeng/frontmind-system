import { act, render, screen, cleanup } from "@testing-library/react";
import { useQueryClient, type QueryClient } from "@tanstack/react-query";
import { StrictMode, useEffect } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Link, Router } from "wouter";
import { navigate } from "wouter/use-browser-location";
import { useWorkspaceLocation } from "@/hooks/useWorkspaceLocation";
import { projectWorkspaceUrl } from "@/lib/enterprise-project";

const transports = vi.hoisted(() => ({ liveSignal: undefined as AbortSignal | undefined, create: vi.fn(), activate: vi.fn(() => vi.fn()) }));
vi.mock("@/lib/dashboard-transport", () => ({ createDashboardTransport: transports.create }));
vi.mock("@/lib/workspace-rest-scope", () => ({ activateWorkspaceRestScope: transports.activate }));
vi.mock("@/lib/trpc", () => ({ trpc: { Provider: ({ children, client }: { children: React.ReactNode; client: { signal: AbortSignal } }) => { transports.liveSignal = client.signal; return children; } } }));
import { WorkspaceQueryProvider } from "./WorkspaceQueryProvider";

let currentClient: QueryClient;
let mounts = 0;
function Content() {
  currentClient = useQueryClient();
  useEffect(() => { mounts++; }, []);
  return <Link href="/publishing/media">媒体资源</Link>;
}
function Workspace({ userId = 7 }: { userId?: number } = {}) {
  return <Router hook={useWorkspaceLocation} hrefs={href => projectWorkspaceUrl(href)}>
    <WorkspaceQueryProvider userId={userId}><Content /></WorkspaceQueryProvider>
  </Router>;
}
beforeEach(() => {
  mounts = 0;
  transports.create.mockReset().mockImplementation((_headers, signal) => ({ signal }));
  window.history.replaceState(null, "", "/?enterpriseProjectId=project-a&operatorOwnerId=7");
});
afterEach(async () => { cleanup(); await act(async () => {}); window.history.replaceState(null, "", "/"); });

describe("workspace request lifetime", () => {
  const directoryKey = (ownerUserId = 7) => [["enterpriseProjects", "list"], { input: { ownerUserId }, type: "query" }] as const;
  it("retains only the same viewer-owner project directory through account and project transitions", async () => {
    render(<Workspace />);
    const key = directoryKey();
    const projects = { projects: [{ id: "project-a", name: "企业甲" }] };
    act(() => {
      currentClient.setQueryData(key, projects);
      currentClient.setQueryData(["private-content"], "A only");
    });
    await act(async () => navigate("/agent"));
    expect(currentClient.getQueryData(key)).toEqual(projects);
    expect(currentClient.getQueryData(["private-content"])).toBeUndefined();
    await act(async () => navigate("/?enterpriseProjectId=project-a"));
    expect(currentClient.getQueryData(key)).toEqual(projects);
    const sameScope = currentClient;
    await act(async () => navigate("/publishing?enterpriseProjectId=project-a"));
    expect(currentClient).toBe(sameScope);
    expect(currentClient.getQueryData(key)).toEqual(projects);
    act(() => currentClient.setQueryData(key, { projects: [] }));
    await act(async () => navigate("/account"));
    expect(currentClient.getQueryData(key)).toEqual({ projects: [] });
  });

  it("does not transfer the directory or late old-owner updates across owner and authenticated account boundaries", async () => {
    const view = render(<Workspace />);
    const oldClient = currentClient;
    act(() => currentClient.setQueryData(directoryKey(), { projects: [{ id: "private-a" }] }));
    await act(async () => navigate("/?enterpriseProjectId=project-b&operatorOwnerId=8"));
    expect(currentClient.getQueryData(directoryKey())).toBeUndefined();
    act(() => {
      oldClient.setQueryData(directoryKey(), { projects: [{ id: "late-private-a" }] });
      currentClient.setQueryData(directoryKey(8), { projects: [{ id: "private-b" }] });
    });
    await act(async () => navigate("/account?operatorOwnerId=8"));
    expect(currentClient.getQueryData(directoryKey())).toBeUndefined();
    expect(currentClient.getQueryData(directoryKey(8))).toEqual({ projects: [{ id: "private-b" }] });
    view.rerender(<Workspace userId={9} />);
    expect(currentClient.getQueryData(directoryKey(8))).toBeUndefined();
  });

  it("preserves the client and mounted shell within a project and scopes native links", async () => {
    render(<Workspace />);
    const original = currentClient;
    original.setQueryData(["private-result"], "A only");
    expect(screen.getByRole("link")).toHaveAttribute("href", "/publishing/media?enterpriseProjectId=project-a&operatorOwnerId=7");
    await act(async () => navigate("/publishing/media?enterpriseProjectId=project-a&operatorOwnerId=7"));
    expect(currentClient).toBe(original);
    expect(mounts).toBe(1);
    expect(original.getQueryData(["private-result"])).toBe("A only");
  });

  it("retires old requests and data when the enterprise or account changes", async () => {
    render(<Workspace />);
    const old = currentClient;
    const oldSignal = transports.create.mock.calls.at(-1)![1] as AbortSignal;
    old.setQueryData(["private-result"], "A only");
    await act(async () => navigate("/?enterpriseProjectId=project-b&operatorOwnerId=7"));
    expect(currentClient).not.toBe(old);
    expect(currentClient.getQueryData(["private-result"])).toBeUndefined();
    expect(old.getQueryData(["private-result"])).toBeUndefined();
    expect(oldSignal.aborted).toBe(true);
    expect(transports.create.mock.calls.at(-1)![0]).toEqual({ "x-enterprise-project-id": "project-b" });
    await act(async () => navigate("/agent"));
    expect(transports.create.mock.calls.at(-1)![0]).toEqual({});
    expect(mounts).toBe(3);
  });

  it("keeps the live transport usable after StrictMode effect replay", async () => {
    const view = render(<StrictMode><Workspace /></StrictMode>);
    const signal = transports.liveSignal!;
    await act(async () => {});
    expect(signal.aborted).toBe(false);
    view.unmount();
    await act(async () => {});
    expect(signal.aborted).toBe(true);
  });
});
