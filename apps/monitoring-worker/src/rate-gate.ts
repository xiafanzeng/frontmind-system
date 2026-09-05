/** Process-local rate gate; the DB dispatch slot is the cross-process daily guard. */
export class RateGate {
  private nextAllowedAt = 0;
  private tail: Promise<void> = Promise.resolve();

  constructor(private readonly intervalMs: number) {}

  async wait(signal?: AbortSignal): Promise<void> {
    const run = this.tail.then(async () => {
      const delay = Math.max(0, this.nextAllowedAt - Date.now());
      if (delay > 0) {
        await new Promise<void>((resolve, reject) => {
          const timeout = setTimeout(resolve, delay);
          const abort = () => {
            clearTimeout(timeout);
            reject(signal?.reason ?? new Error("Rate gate aborted"));
          };
          signal?.addEventListener("abort", abort, { once: true });
          if (signal?.aborted) abort();
        });
      }
      this.nextAllowedAt = Date.now() + this.intervalMs;
    });
    this.tail = run.catch(() => undefined);
    await run;
  }
}
