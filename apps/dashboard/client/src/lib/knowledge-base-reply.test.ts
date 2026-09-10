import { afterEach, describe, expect, it, vi } from "vitest";
import { waitForKnowledgeBaseReply } from "./knowledge-base-reply";

describe("bounded knowledge request continuation", () => {
  afterEach(() => vi.useRealTimers());
  it("reconciles committed work after 30 seconds and ignores the late response", async () => {
    vi.useFakeTimers();
    let late!: (value: string) => void;
    let signal!: AbortSignal;
    const reconcile = vi.fn(async () => "persisted");
    const onComplete = vi.fn();
    const pending = waitForKnowledgeBaseReply({ signal: new AbortController().signal,
      request: received => { signal = received; return new Promise<string>(resolve => { late = resolve; }); }, reconcile,
    }).then(onComplete);
    await vi.advanceTimersByTimeAsync(30_000);
    await pending;
    expect(reconcile).toHaveBeenCalledOnce();
    expect(signal.aborted).toBe(true);
    expect(onComplete).toHaveBeenCalledOnce();
    expect(onComplete).toHaveBeenCalledWith("persisted");
    late("stale"); await Promise.resolve();
    expect(onComplete).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });
  it("bounds a hung state query to 10 seconds and a hung response to six minutes", async () => {
    vi.useFakeTimers();
    const reconcile = vi.fn(() => new Promise<string>(() => {}));
    const pending = waitForKnowledgeBaseReply({ signal: new AbortController().signal, request: () => new Promise<string>(() => {}), reconcile });
    const assertion = expect(pending).rejects.toMatchObject({ code: "KB_REPLY_PENDING" });
    await vi.advanceTimersByTimeAsync(370_000);
    await assertion;
    expect(reconcile).toHaveBeenCalledTimes(2);
    expect(vi.getTimerCount()).toBe(0);
  });
  it("releases the waiter immediately when its project is retired", async () => {
    const controller = new AbortController();
    const pending = waitForKnowledgeBaseReply({ signal: controller.signal, request: () => new Promise<string>(() => {}) });
    controller.abort(new DOMException("project changed", "AbortError"));
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
  });
});
