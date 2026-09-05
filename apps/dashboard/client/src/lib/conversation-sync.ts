export type ConversationSyncOperation<T extends { id: string }> =
  | { kind: "snapshot"; conversation: T }
  | { kind: "delete"; id: string };

type QueueEntry<T extends { id: string }> = {
  pending: ConversationSyncOperation<T> | null;
  running: boolean;
  inFlight: Promise<void> | null;
  timer: ReturnType<typeof setTimeout> | null;
  timerIsImmediate: boolean;
  retryDelayMs: number;
  lastAttemptFailed: boolean;
};

export interface ConversationSyncQueueOptions<T extends { id: string }> {
  syncSnapshot: (conversation: T) => Promise<unknown>;
  deleteConversation: (id: string) => Promise<unknown>;
  onError?: (error: unknown) => void;
  onPermanentError?: (
    error: unknown,
    operation: ConversationSyncOperation<T>,
  ) => void;
  shouldRetry?: (
    error: unknown,
    operation: ConversationSyncOperation<T>,
  ) => boolean;
  onSuccess?: () => void;
  debounceMs?: number;
  maxRetryDelayMs?: number;
}

/**
 * Serializes writes per conversation and coalesces intermediate snapshots.
 *
 * A delete is queued through the same lane as snapshots, so an in-flight
 * snapshot can never recreate a conversation after the user deletes it.
 * Failed operations stay queued and retry with bounded exponential backoff;
 * a newer local snapshot replaces an older failed snapshot.
 */
export class ConversationSyncQueue<T extends { id: string }> {
  private readonly entries = new Map<string, QueueEntry<T>>();
  private generation = 0;

  constructor(private readonly options: ConversationSyncQueueOptions<T>) {}

  enqueueSnapshot(conversation: T, immediate = false) {
    const entry = this.getEntry(conversation.id);
    entry.pending = { kind: "snapshot", conversation };
    // Keep a create scheduled for this event-loop turn immediate when its
    // first message is added synchronously; the newer full snapshot wins.
    if (!immediate && entry.timer && entry.timerIsImmediate) return;
    this.schedule(
      conversation.id,
      entry,
      immediate ? 0 : (this.options.debounceMs ?? 250),
    );
  }

  enqueueDelete(id: string) {
    const entry = this.getEntry(id);
    entry.pending = { kind: "delete", id };
    this.schedule(id, entry, 0);
  }

  /** Flush all currently pending snapshots before a cloud refresh. */
  async flushAll() {
    const work = Array.from(this.entries.entries()).map(([id, entry]) =>
      this.flushEntry(id, entry),
    );
    const results = await Promise.all(work);
    return results.every(Boolean);
  }

  /** Drop queued writes when the authenticated account changes. */
  reset() {
    this.generation += 1;
    for (const entry of this.entries.values()) {
      if (entry.timer) clearTimeout(entry.timer);
    }
    this.entries.clear();
  }

  private getEntry(id: string): QueueEntry<T> {
    const existing = this.entries.get(id);
    if (existing) return existing;

    const entry: QueueEntry<T> = {
      pending: null,
      running: false,
      inFlight: null,
      timer: null,
      timerIsImmediate: false,
      retryDelayMs: 1_000,
      lastAttemptFailed: false,
    };
    this.entries.set(id, entry);
    return entry;
  }

  private schedule(id: string, entry: QueueEntry<T>, delayMs: number) {
    if (entry.timer) clearTimeout(entry.timer);
    entry.timerIsImmediate = delayMs === 0;
    entry.timer = setTimeout(() => {
      entry.timer = null;
      entry.timerIsImmediate = false;
      void this.drain(id, entry);
    }, delayMs);
  }

  private drain(id: string, entry: QueueEntry<T>): Promise<void> {
    if (entry.running) return entry.inFlight ?? Promise.resolve();
    if (!entry.pending || this.entries.get(id) !== entry) {
      return Promise.resolve();
    }

    const inFlight = this.runOperation(id, entry);
    entry.inFlight = inFlight;
    return inFlight;
  }

  private async flushEntry(id: string, entry: QueueEntry<T>): Promise<boolean> {
    // New state can arrive while an older request is in flight. Keep draining
    // successful work until this conversation's lane is truly idle.
    for (let pass = 0; pass < 100; pass++) {
      if (this.entries.get(id) !== entry) return true;
      if (entry.timer) {
        clearTimeout(entry.timer);
        entry.timer = null;
        entry.timerIsImmediate = false;
      }
      if (!entry.running && !entry.pending) return true;

      await this.drain(id, entry);
      if (entry.lastAttemptFailed) return false;
    }
    return false;
  }

  private async runOperation(id: string, entry: QueueEntry<T>): Promise<void> {
    const generation = this.generation;
    const operation = entry.pending!;
    entry.pending = null;
    entry.running = true;
    entry.lastAttemptFailed = false;

    try {
      if (operation.kind === "snapshot") {
        await this.options.syncSnapshot(operation.conversation);
      } else {
        await this.options.deleteConversation(operation.id);
      }

      if (generation !== this.generation || this.entries.get(id) !== entry)
        return;
      entry.retryDelayMs = 1_000;
      this.options.onSuccess?.();
    } catch (error: unknown) {
      if (generation !== this.generation || this.entries.get(id) !== entry)
        return;

      this.options.onError?.(error);
      if (this.options.shouldRetry?.(error, operation) === false) {
        entry.pending = null;
        entry.lastAttemptFailed = false;
        this.options.onPermanentError?.(error, operation);
        return;
      }

      // Preserve a newer operation if one arrived while this request was in flight.
      if (!entry.pending) entry.pending = operation;
      entry.lastAttemptFailed = true;
      const retryDelay = entry.retryDelayMs;
      entry.retryDelayMs = Math.min(
        retryDelay * 2,
        this.options.maxRetryDelayMs ?? 30_000,
      );
      this.schedule(id, entry, retryDelay);
    } finally {
      entry.running = false;
      entry.inFlight = null;
      if (generation !== this.generation || this.entries.get(id) !== entry)
        return;

      if (entry.pending && !entry.timer) {
        this.schedule(id, entry, 0);
      } else if (!entry.pending && !entry.timer) {
        this.entries.delete(id);
      }
    }
  }
}

export function getErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message) {
    if (
      /ER_LOCK_DEADLOCK|Deadlock found when trying to get lock|errno\s*[:=]?\s*1213/i.test(
        error.message,
      )
    ) {
      return "会话初始化遇到并发冲突，系统已自动重试；无需重复提交。";
    }
    if (
      /Failed query:|params:|insert into [`"]?messages|ER_DUP_ENTRY|Duplicate entry/i.test(
        error.message,
      )
    ) {
      return "云端会话写入暂时失败，系统会自动修复并重试；请勿重复提交。";
    }
    return error.message.length > 300
      ? `${error.message.slice(0, 300)}…`
      : error.message;
  }
  return "对话同步失败，请检查网络后重试";
}
