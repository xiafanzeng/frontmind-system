import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ConversationSyncQueue, getErrorMessage } from "./conversation-sync";

type Snapshot = { id: string; value: number };

describe("ConversationSyncQueue", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("coalesces debounced snapshots and sends the latest state", async () => {
    const syncSnapshot = vi.fn().mockResolvedValue(undefined);
    const queue = new ConversationSyncQueue<Snapshot>({
      syncSnapshot,
      deleteConversation: vi.fn().mockResolvedValue(undefined),
      debounceMs: 50,
    });

    queue.enqueueSnapshot({ id: "one", value: 1 });
    queue.enqueueSnapshot({ id: "one", value: 2 });
    await vi.advanceTimersByTimeAsync(50);

    expect(syncSnapshot).toHaveBeenCalledTimes(1);
    expect(syncSnapshot).toHaveBeenCalledWith({ id: "one", value: 2 });
  });

  it("keeps creation immediate while coalescing a synchronous first update", async () => {
    const syncSnapshot = vi.fn().mockResolvedValue(undefined);
    const queue = new ConversationSyncQueue<Snapshot>({
      syncSnapshot,
      deleteConversation: vi.fn().mockResolvedValue(undefined),
      debounceMs: 50,
    });

    queue.enqueueSnapshot({ id: "one", value: 0 }, true);
    queue.enqueueSnapshot({ id: "one", value: 1 });
    await vi.advanceTimersByTimeAsync(0);

    expect(syncSnapshot).toHaveBeenCalledTimes(1);
    expect(syncSnapshot).toHaveBeenCalledWith({ id: "one", value: 1 });
  });

  it("serializes delete behind an in-flight snapshot", async () => {
    let finishSnapshot: (() => void) | undefined;
    const syncSnapshot = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          finishSnapshot = resolve;
        }),
    );
    const deleteConversation = vi.fn().mockResolvedValue(undefined);
    const queue = new ConversationSyncQueue<Snapshot>({
      syncSnapshot,
      deleteConversation,
    });

    queue.enqueueSnapshot({ id: "one", value: 1 }, true);
    await vi.advanceTimersByTimeAsync(0);
    queue.enqueueDelete("one");
    await vi.advanceTimersByTimeAsync(0);

    expect(syncSnapshot).toHaveBeenCalledTimes(1);
    expect(deleteConversation).not.toHaveBeenCalled();

    finishSnapshot?.();
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(0);

    expect(deleteConversation).toHaveBeenCalledWith("one");
  });

  it("retries a failed latest snapshot", async () => {
    const onError = vi.fn();
    const syncSnapshot = vi
      .fn()
      .mockRejectedValueOnce(new Error("offline"))
      .mockResolvedValue(undefined);
    const queue = new ConversationSyncQueue<Snapshot>({
      syncSnapshot,
      deleteConversation: vi.fn().mockResolvedValue(undefined),
      onError,
      debounceMs: 10,
    });

    queue.enqueueSnapshot({ id: "one", value: 1 });
    await vi.advanceTimersByTimeAsync(10);
    expect(onError).toHaveBeenCalledTimes(1);

    queue.enqueueSnapshot({ id: "one", value: 2 });
    await vi.advanceTimersByTimeAsync(10);

    expect(syncSnapshot).toHaveBeenLastCalledWith({ id: "one", value: 2 });
  });

  it("drops a permanent failure instead of retrying forever", async () => {
    const error = Object.assign(new Error("deleted elsewhere"), {
      data: { code: "NOT_FOUND" },
    });
    const syncSnapshot = vi.fn().mockRejectedValue(error);
    const onPermanentError = vi.fn();
    const queue = new ConversationSyncQueue<Snapshot>({
      syncSnapshot,
      deleteConversation: vi.fn().mockResolvedValue(undefined),
      shouldRetry: (candidate) =>
        (candidate as typeof error).data?.code !== "NOT_FOUND",
      onPermanentError,
    });

    queue.enqueueSnapshot({ id: "one", value: 1 }, true);
    await vi.advanceTimersByTimeAsync(60_000);

    expect(syncSnapshot).toHaveBeenCalledTimes(1);
    expect(onPermanentError).toHaveBeenCalledTimes(1);
  });
});

describe("getErrorMessage", () => {
  it("identifies a MySQL deadlock as an automatically retried initialization conflict", () => {
    expect(
      getErrorMessage(
        new Error(
          "Failed query: insert into `conversations` values (?) ER_LOCK_DEADLOCK",
        ),
      ),
    ).toBe("会话初始化遇到并发冲突，系统已自动重试；无需重复提交。");
  });

  it("does not expose SQL parameters or assistant content in the sync banner", () => {
    const message = getErrorMessage(
      new Error(
        "Failed query: insert into `messages` values (?) params: 企业内部正文",
      ),
    );

    expect(message).toBe(
      "云端会话写入暂时失败，系统会自动修复并重试；请勿重复提交。",
    );
    expect(message).not.toContain("企业内部正文");
  });
});
