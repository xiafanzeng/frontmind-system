import { afterEach, describe, expect, it, vi } from "vitest";
import { createDashboardTransport } from "./dashboard-transport";

afterEach(() => { vi.unstubAllGlobals(); window.history.replaceState(null, "", "/"); });

describe("frozen workspace transports", () => {
  it("keeps queued requests bound to their original project and isolates account calls", async () => {
    const requests: Array<{ url: string; headers: Headers }> = [];
    vi.stubGlobal("fetch", vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      requests.push({ url: String(url), headers: new Headers(init?.headers) });
      const result = { result: { data: { json: { marker: "fixture" } } } };
      return new Response(JSON.stringify(String(url).includes("batch=1") ? [result] : result), { headers: { "content-type": "application/json" } });
    }));
    const headers = { "x-enterprise-project-id": "project-a" };
    const project = createDashboardTransport(headers);
    const account = createDashboardTransport();
    headers["x-enterprise-project-id"] = "project-b";
    window.history.replaceState(null, "", "/agent");
    await project.workspace.dashboard.query();
    await account.workspace.dashboard.query();
    await project.auth.me.query();
    expect(requests.map(request => request.headers.get("x-enterprise-project-id"))).toEqual(["project-a", null, null]);
  });

  it("aborts pending requests when their scope is disposed", async () => {
    let requestSignal: AbortSignal | null | undefined;
    vi.stubGlobal("fetch", vi.fn((_url: RequestInfo | URL, init?: RequestInit) => {
      requestSignal = init?.signal;
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new DOMException("scope changed", "AbortError")), { once: true });
      });
    }));
    const controller = new AbortController();
    const client = createDashboardTransport({ "x-enterprise-project-id": "project-a" }, controller.signal);
    const result = client.workspace.dashboard.query().catch(error => error);
    await vi.waitFor(() => expect(requestSignal).toBeDefined());
    controller.abort();
    expect(requestSignal?.aborted).toBe(true);
    expect(await result).toBeInstanceOf(Error);
  });
});
