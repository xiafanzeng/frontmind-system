import { afterEach, describe, expect, it, vi } from "vitest";
import { activateWorkspaceRestScope, activateWorkspaceUploadScope, captureWorkspaceRestOperation, retireWorkspaceRestScope } from "./workspace-rest-scope";
import { fetchCreditUsage, reserveKnowledgeBaseStart, uploadChatLocalAsset } from "./frontmind-api";

let dispose: (() => void) | undefined;
afterEach(() => { dispose?.(); dispose = undefined; vi.useRealTimers(); vi.unstubAllGlobals(); localStorage.clear(); sessionStorage.clear(); window.history.replaceState(null, "", "/"); });
const activate = (id?: string) => { dispose = activateWorkspaceRestScope(`1:${id || "account"}`, id); };
const startInput = { conversationId: "conversation-a", clientRequestId: "request-a", expectedResetRevision: 1, companyName: "企业甲", attachmentManifest: [] };

describe("business REST scope", () => {
  it("keeps upload requests scoped to their enterprise through general-agent navigation, then aborts on an actual project switch", async () => {
    activate("project-a");
    const releaseUpload = activateWorkspaceUploadScope("1:project-a");
    const operation = captureWorkspaceRestOperation(undefined, undefined, { detached: true });
    retireWorkspaceRestScope("1:project-a");
    activate();
    expect(operation.signal.aborted).toBe(false);
    expect(operation.headers()).toMatchObject({ "x-enterprise-project-id": "project-a" });
    const releaseNext = activateWorkspaceUploadScope("1:project-b");
    expect(operation.signal.aborted).toBe(true);
    releaseUpload(); releaseNext(); await Promise.resolve();
  });
  it("survives StrictMode setup replay and retires the final unmounted scope", async () => {
    const release = activateWorkspaceRestScope("1:strict-project", "strict-project");
    const operation = captureWorkspaceRestOperation();
    release();
    dispose = activateWorkspaceRestScope("1:strict-project", "strict-project");
    await Promise.resolve();
    expect(operation.signal.aborted).toBe(false);
    dispose();
    await Promise.resolve();
    expect(operation.signal.aborted).toBe(true);
  });
  it("freezes project identity before async work and prevents identity headers from being replaced", async () => {
    activate("project-a");
    const fetcher = vi.fn().mockResolvedValue(new Response("{}")); vi.stubGlobal("fetch", fetcher);
    const operation = captureWorkspaceRestOperation();
    window.history.replaceState(null, "", "/?enterpriseProjectId=project-b");
    await operation.fetch("/api/knowledge-base/turn", { headers: { "X-Enterprise-Project-Id": "project-b", "Content-Type": "application/json" } });
    expect(new Headers(fetcher.mock.calls[0][1].headers).get("x-enterprise-project-id")).toBe("project-a");
    expect(new Headers(fetcher.mock.calls[0][1].headers).get("content-type")).toBe("application/json");
    activate("project-b");
    expect(operation.signal.aborted).toBe(true);
    await expect(operation.fetch("/api/knowledge-base/turn")).rejects.toMatchObject({ name: "AbortError" });
    await expect(captureWorkspaceRestOperation(operation.signal).fetch("/api/knowledge-base/turn")).rejects.toMatchObject({ name: "AbortError" });
    expect(fetcher).toHaveBeenCalledTimes(1);
    await captureWorkspaceRestOperation().fetch("/api/knowledge-base/turn");
    expect(new Headers(fetcher.mock.calls[1][1].headers).get("x-enterprise-project-id")).toBe("project-b");
  });

  it("aborts a reserved knowledge-base retry when the project changes", async () => {
    vi.useFakeTimers(); activate("project-a");
    const fetcher = vi.fn().mockResolvedValue(new Response(JSON.stringify({ error: { message: "稍后重试" } }), { status: 503 }));
    vi.stubGlobal("fetch", fetcher);
    const pending = reserveKnowledgeBaseStart(startInput);
    const rejected = expect(pending).rejects.toMatchObject({ name: "AbortError" });
    await vi.advanceTimersByTimeAsync(0);
    activate("project-b");
    await rejected;
    await vi.advanceTimersByTimeAsync(20_000);
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(new Headers(fetcher.mock.calls[0][1].headers).get("x-enterprise-project-id")).toBe("project-a");
  });

  it("retries with the original headers while a URL change is awaiting the workspace commit", async () => {
    vi.useFakeTimers(); activate("project-a");
    const fetcher = vi.fn().mockResolvedValueOnce(new Response("{}", { status: 503 })).mockResolvedValueOnce(new Response(JSON.stringify({ reservation: { turnId: "turn-a", clientRequestId: "request-a" } })));
    vi.stubGlobal("fetch", fetcher);
    const pending = reserveKnowledgeBaseStart(startInput);
    await vi.advanceTimersByTimeAsync(0);
    window.history.replaceState(null, "", "/?enterpriseProjectId=project-b");
    await vi.advanceTimersByTimeAsync(1_000);
    await pending;
    expect(fetcher).toHaveBeenCalledTimes(2);
    for (const [,init] of fetcher.mock.calls) expect(new Headers(init.headers).get("x-enterprise-project-id")).toBe("project-a");
  });

  it("cancels browser asset transfers when their workspace leaves", async () => {
    activate("project-a");
    const instances: FakeXhr[] = [];
    class FakeXhr {
      upload = new EventTarget(); headers: Record<string,string> = {}; onabort?: () => void;
      constructor() { instances.push(this); }
      open() {} setRequestHeader(name: string,value: string) { this.headers[name] = value; }
      send() {} abort() { this.onabort?.(); }
    }
    vi.stubGlobal("XMLHttpRequest", FakeXhr);
    const pending = uploadChatLocalAsset(new File(["content"], "brand.txt", { type: "text/plain" }));
    const rejected = expect(pending).rejects.toMatchObject({ cancelled: true });
    expect(instances[0].headers["x-enterprise-project-id"]).toBe("project-a");
    activate("project-b");
    await rejected;
  });

  it("leaves account usage requests outside the project cancellation lifetime", async () => {
    activate("project-a");
    let resolve!: (response: Response) => void;
    const fetcher = vi.fn().mockImplementation(() => new Promise<Response>(done => { resolve = done; })); vi.stubGlobal("fetch", fetcher);
    const pending = fetchCreditUsage({ force: true, accountId: 1 });
    activate("project-b");
    expect(fetcher.mock.calls[0][1].signal).toBeUndefined();
    resolve(new Response(JSON.stringify({ totalUsed: 12, recentTasks: [] })));
    expect((await pending).totalUsed).toBe(12);
    activate();
    expect(captureWorkspaceRestOperation().headers()).not.toHaveProperty("x-enterprise-project-id");
  });

  it("keeps a detached upload alive when the page scope is disposed", async () => {
    activate("project-a");
    const pageOperation = captureWorkspaceRestOperation();
    const detached = captureWorkspaceRestOperation(undefined, undefined, { detached: true });
    pageOperation.assertActive();
    dispose?.();
    await Promise.resolve();
    expect(pageOperation.signal.aborted).toBe(true);
    expect(detached.signal.aborted).toBe(false);
    detached.assertActive();
  });
});
