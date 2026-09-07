import { afterEach, describe, expect, it, vi } from "vitest";
import { activateWorkspaceRestScope } from "@/lib/workspace-rest-scope";
import { createTrpcClient } from "./trpc";
let dispose: (() => void) | undefined;
afterEach(() => { dispose?.(); dispose = undefined; vi.useRealTimers(); vi.unstubAllGlobals(); window.history.replaceState(null, "", "/"); });

describe("monitoring workspace transport", () => {
  it("cancels an old queued batch before it can adopt the new project", async () => {
    vi.useFakeTimers();
    window.history.replaceState(null, "", "/monitoring-system?enterpriseProjectId=project-a");
    dispose = activateWorkspaceRestScope("1:project-a", "project-a");
    const fetcher = vi.fn().mockResolvedValue(new Response(JSON.stringify([{ result: { data: null } }]))); vi.stubGlobal("fetch", fetcher);
    const client = createTrpcClient();
    const pending = client.auth.me.query();
    const rejected = expect(pending).rejects.toThrow();
    window.history.replaceState(null, "", "/monitoring-system?enterpriseProjectId=project-b");
    dispose = activateWorkspaceRestScope("1:project-b", "project-b");
    await vi.runAllTimersAsync(); await rejected;
    expect(fetcher).not.toHaveBeenCalled();
    const fresh = createTrpcClient().auth.me.query();
    await vi.runAllTimersAsync(); await fresh;
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(new Headers(fetcher.mock.calls[0][1].headers).get("x-enterprise-project-id")).toBe("project-b");
  });
});
