import { afterEach, describe, expect, it, vi } from "vitest";
import { syncKnowledgeBaseArchiveFromOutput } from "./knowledge-snapshot";
import {
  activateWorkspaceRestScope,
  captureWorkspaceRestOperation,
} from "./workspace-rest-scope";

let dispose: (() => void) | undefined;
afterEach(async () => {
  dispose?.();
  dispose = undefined;
  await Promise.resolve();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("knowledge publication request lifetime", () => {
  it("submits the user-confirmed draft coordinates exactly once", async () => {
    dispose = activateWorkspaceRestScope("7:project-a", "project-a");
    const fetcher = vi.fn().mockResolvedValue(new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", fetcher);
    await syncKnowledgeBaseArchiveFromOutput({
      conversationId: "conversation-a", expectedBuildId: "build-a",
      expectedRevision: 12, expectedContentVersion: 3,
    });
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(JSON.parse(fetcher.mock.calls[0][1].body)).toEqual({
      conversationId: "conversation-a", expectedBuildId: "build-a",
      expectedRevision: 12, expectedContentVersion: 3, background: true,
    });
  });

  it("polls a background update with GET until the frozen draft is published", async () => {
    vi.useFakeTimers();
    dispose = activateWorkspaceRestScope("7:project-a", "project-a");
    const events = vi.spyOn(window, "dispatchEvent");
    const fetcher = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        expectedBuildId: "build-a",
        expectedRevision: 12,
        expectedContentVersion: 3,
      }), { status: 202, headers: { "Content-Type": "application/json" } }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ progress: {
        build: { id: "build-a", revision: 12, contentVersion: 3, status: "ready_to_publish" },
        packageState: "preparing",
      } }), { status: 200, headers: { "Content-Type": "application/json" } }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ progress: {
        build: { id: "build-a", revision: 12, contentVersion: 3, status: "published" },
      } }), { status: 200, headers: { "Content-Type": "application/json" } }));
    vi.stubGlobal("fetch", fetcher);
    const pending = syncKnowledgeBaseArchiveFromOutput({
      conversationId: "conversation-a",
      expectedBuildId: "build-a",
      expectedRevision: 12,
      expectedContentVersion: 3,
    });
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(1_000);
    await pending;
    expect(fetcher).toHaveBeenCalledTimes(3);
    expect(fetcher.mock.calls[0]![1]!.method).toBe("POST");
    expect(fetcher.mock.calls.slice(1).every((call) => call[1]?.method === undefined)).toBe(true);
    expect(events).toHaveBeenCalledWith(expect.objectContaining({ type: "frontmind:knowledge-base-updated" }));
  });

  it("stops polling on an update attention failure without repeating POST", async () => {
    vi.useFakeTimers();
    dispose = activateWorkspaceRestScope("7:project-a", "project-a");
    const fetcher = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        expectedBuildId: "build-a", expectedRevision: 12, expectedContentVersion: 3,
      }), { status: 202 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ progress: {
        build: { id: "build-a", revision: 12, contentVersion: 3, status: "ready_to_publish" },
        packageState: "attention_required",
      } }), { status: 200 }));
    vi.stubGlobal("fetch", fetcher);
    const pending = syncKnowledgeBaseArchiveFromOutput({
      conversationId: "conversation-a", expectedBuildId: "build-a", expectedRevision: 12, expectedContentVersion: 3,
    });
    await expect(pending).rejects.toThrow("当前正式版本未受影响");
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(fetcher.mock.calls[0]![1]!.method).toBe("POST");
  });

  it("rejects a changed draft revision from polling and never repeats the mutation", async () => {
    vi.useFakeTimers();
    dispose = activateWorkspaceRestScope("7:project-a", "project-a");
    const fetcher = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        expectedBuildId: "build-a", expectedRevision: 12, expectedContentVersion: 3,
      }), { status: 202 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ progress: {
        build: { id: "build-a", revision: 13, contentVersion: 3, status: "ready_to_publish" },
      } }), { status: 200 }));
    vi.stubGlobal("fetch", fetcher);
    const pending = syncKnowledgeBaseArchiveFromOutput({
      conversationId: "conversation-a", expectedBuildId: "build-a", expectedRevision: 12, expectedContentVersion: 3,
    });
    await expect(pending).rejects.toThrow("工作稿已变化");
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(fetcher.mock.calls[0]![1]!.method).toBe("POST");
  });
  it("times out a stalled request without retiring its scope or automatically replaying the mutation", async () => {
    vi.useFakeTimers();
    dispose = activateWorkspaceRestScope("7:project-a", "project-a");
    const operation = captureWorkspaceRestOperation();
    const events = vi.spyOn(window, "dispatchEvent");
    const fetcher = vi.fn(
      (_url: RequestInfo | URL, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init!.signal!.addEventListener(
            "abort",
            () => reject(init!.signal!.reason),
            { once: true },
          );
        }),
    );
    vi.stubGlobal("fetch", fetcher);
    const pending = syncKnowledgeBaseArchiveFromOutput({
      conversationId: "conversation-a",
      operation,
    });
    const rejected = expect(pending).rejects.toMatchObject({
      name: "TimeoutError",
    });
    await vi.advanceTimersByTimeAsync(30_000);
    await rejected;
    expect(operation.signal.aborted).toBe(false);
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(
      new Headers(fetcher.mock.calls[0]![1]!.headers).get(
        "x-enterprise-project-id",
      ),
    ).toBe("project-a");
    expect(events).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("ignores a late successful result from a departed enterprise project", async () => {
    vi.useFakeTimers();
    dispose = activateWorkspaceRestScope("7:project-a", "project-a");
    const events = vi.spyOn(window, "dispatchEvent");
    let finish!: (response: Response) => void;
    vi.stubGlobal(
      "fetch",
      vi.fn(
        () =>
          new Promise<Response>((resolve) => {
            finish = resolve;
          }),
      ),
    );
    const pending = syncKnowledgeBaseArchiveFromOutput({
      conversationId: "conversation-a",
    });
    const rejected = expect(pending).rejects.toMatchObject({
      name: "AbortError",
    });
    dispose = activateWorkspaceRestScope("7:project-b", "project-b");
    finish(new Response("{}", { status: 200 }));
    await rejected;
    expect(events).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });
});
