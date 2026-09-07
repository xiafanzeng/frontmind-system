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
