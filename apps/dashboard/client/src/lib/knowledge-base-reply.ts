import { captureWorkspaceRestOperation, forkWorkspaceRestOperation } from "./workspace-rest-scope";

/** Exactly one continuation wins, including when fetch/body parsing ignores abort. */
export function waitForKnowledgeBaseReply<T>(input: {
  signal: AbortSignal;
  request: (signal: AbortSignal) => Promise<T>;
  reconcile?: (signal: AbortSignal) => Promise<T | undefined>;
  timeoutMs?: number;
}): Promise<T> {
  const parent = captureWorkspaceRestOperation(input.signal);
  const controller = new AbortController();
  const operation = forkWorkspaceRestOperation(parent, controller.signal);
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    let checking: Promise<T | undefined> | undefined;
    let early: ReturnType<typeof setTimeout> | undefined;
    let deadline: ReturnType<typeof setTimeout> | undefined;
    const finish = (error: unknown, value?: T) => {
      if (settled) return;
      settled = true;
      clearTimeout(early); clearTimeout(deadline);
      parent.signal.removeEventListener("abort", abort);
      controller.abort();
      if (error) reject(error); else resolve(value as T);
    };
    const abort = () => finish(parent.signal.reason ?? new DOMException("请求已取消", "AbortError"));
    const check = async (final: boolean) => {
      if (settled) return;
      try {
        if (!checking && input.reconcile) {
          checking = waitForKnowledgeBaseReply({ signal: operation.signal, request: input.reconcile, timeoutMs: 10_000 })
            .finally(() => { checking = undefined; });
        }
        const value = await checking;
        if (value !== undefined) { finish(null, value); return; }
      } catch (error) {
        if (parent.signal.aborted) { finish(error); return; }
      }
      if (final) finish(Object.assign(new Error("等待响应超时，结果待确认，请检查并继续原批次"), { code: "KB_REPLY_PENDING", retryable: false }));
    };
    parent.signal.addEventListener("abort", abort, { once: true });
    if (parent.signal.aborted) { abort(); return; }
    if (input.reconcile) early = setTimeout(() => { void check(false); }, 30_000);
    deadline = setTimeout(() => { void check(true); }, input.timeoutMs ?? 6 * 60_000);
    try { Promise.resolve(input.request(operation.signal)).then(value => finish(null, value), error => {
      // A nested transport deadline does not bypass the owner's final reconciliation.
      if (input.reconcile && (error as { code?: string })?.code === "KB_REPLY_PENDING") void check(true);
      else finish(error);
    }); }
    catch (error) { finish(error); }
  });
}
