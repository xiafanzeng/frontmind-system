import http, {
  type ClientRequest,
  type IncomingMessage,
  type RequestOptions,
} from "node:http";
import https from "node:https";

import {
  assertSafeExternalUrl,
  ExternalUrlRejectedError,
  safeExternalAgentForUrl,
} from "./_core/safe-external-url";
import {
  createIncrementalPresalesFileStage,
  PRESALES_FILE_STAGE_IO_TIMEOUT_MS,
  type StagedPresalesFile,
} from "./presales-file-store";

export type ManagedProviderAttempt = {
  status: number | null;
  errorCode: string | null;
  providerPutMs: number;
  bytesForwarded: number;
  requestBodyComplete: boolean;
  requestCreatedAtOffsetMs: number;
  providerStartedAtOffsetMs: number | null;
};

export const MANAGED_PROVIDER_CONNECT_TIMEOUT_MS = 10_000;
export const MANAGED_UPLOAD_SOURCE_IDLE_TIMEOUT_MS = 120_000;
export const MANAGED_UPLOAD_ABSOLUTE_TIMEOUT_MS = 20 * 60_000;
export const MANAGED_UPLOAD_POST_INGRESS_TIMEOUT_MS = 330_000;

export type ManagedProviderRequestFactory = (
  target: URL,
  options: RequestOptions,
  onResponse: (response: IncomingMessage) => void,
) => ClientRequest;

function defaultRequestFactory(
  target: URL,
  options: RequestOptions,
  onResponse: (response: IncomingMessage) => void,
) {
  return target.protocol === "https:"
    ? https.request(target, options, onResponse)
    : http.request(target, options, onResponse);
}

function cancellationError() {
  return Object.assign(new Error("Managed upload cancelled"), {
    code: "ERR_CANCELED",
  });
}

function deadlineError() {
  return Object.assign(new Error("Managed upload source deadline exceeded"), {
    code: "UPLOAD_SOURCE_DEADLINE_EXCEEDED",
  });
}

function abortReason(signal: AbortSignal) {
  const code = (signal.reason as { code?: unknown } | null)?.code;
  return code === "UPLOAD_SOURCE_DEADLINE_EXCEEDED" ||
    code === "UPLOAD_POST_INGRESS_DEADLINE_EXCEEDED"
    ? signal.reason
    : cancellationError();
}

function providerErrorCode(error: unknown) {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === "string" && /^[A-Z0-9_]{1,64}$/u.test(code)
    ? code
    : "PROVIDER_REQUEST_FAILED";
}

function finiteDeclaredBytes(value: number | undefined) {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
    ? value
    : undefined;
}

/**
 * Opens the provider request before consuming ingress, then durably stages and
 * forwards each chunk with backpressure. An early provider failure detaches
 * only that branch; the browser body is still staged once for reconciliation.
 */
export async function stageAndUploadManagedBody(input: {
  body: AsyncIterable<unknown>;
  fileId: string;
  target: string;
  mimeType: string;
  maxBytes: number;
  declaredBytes?: number;
  signal: AbortSignal;
  timeoutMs: number;
  requestStartedAt?: number;
  connectTimeoutMs?: number;
  sourceIdleTimeoutMs?: number;
  absoluteTimeoutMs?: number;
  assertProviderCanStart?: () => void | Promise<void>;
  onIngressComplete?: () => void;
  requestFactory?: ManagedProviderRequestFactory;
}): Promise<{
  staged: StagedPresalesFile;
  provider: ManagedProviderAttempt;
}> {
  const safeTarget = new URL(assertSafeExternalUrl(input.target));
  if (safeTarget.protocol !== "https:") {
    throw new ExternalUrlRejectedError(
      "Managed provider uploads require HTTPS",
    );
  }
  const requestStartedAt = input.requestStartedAt ?? Date.now();
  const absoluteDeadline =
    requestStartedAt +
    (input.absoluteTimeoutMs ?? MANAGED_UPLOAD_ABSOLUTE_TIMEOUT_MS);
  const sourceIdleTimeoutMs =
    input.sourceIdleTimeoutMs ?? MANAGED_UPLOAD_SOURCE_IDLE_TIMEOUT_MS;
  const deadlineController = new AbortController();
  const managedSignal = AbortSignal.any([
    input.signal,
    deadlineController.signal,
  ]);
  const deadlineTimer = setTimeout(
    () => deadlineController.abort(deadlineError()),
    Math.max(0, absoluteDeadline - Date.now()),
  );
  deadlineTimer.unref?.();
  let stage: Awaited<ReturnType<typeof createIncrementalPresalesFileStage>>;
  try {
    stage = await createIncrementalPresalesFileStage({
      fileId: input.fileId,
      maxBytes: input.maxBytes,
      ioTimeoutMs: Math.max(
        1,
        Math.min(
          PRESALES_FILE_STAGE_IO_TIMEOUT_MS,
          absoluteDeadline - Date.now(),
        ),
      ),
      signal: managedSignal,
    });
  } catch (error) {
    clearTimeout(deadlineTimer);
    throw error;
  }
  const startedAt = Date.now();
  const requestCreatedAtOffsetMs = Math.max(0, startedAt - requestStartedAt);
  const declaredBytes = finiteDeclaredBytes(input.declaredBytes);
  let providerRequest: ClientRequest | null = null;
  let providerDetached = false;
  let providerSettled = false;
  let providerEnded = false;
  let bytesForwarded = 0;
  let pendingWriteCallbacks = 0;
  let responseStatus: number | null | undefined;
  let connectTimer: NodeJS.Timeout | undefined;
  let providerStartedAtOffsetMs: number | null = null;
  let bodyIterator: AsyncIterator<unknown> | undefined;
  const detachWaiters = new Set<() => void>();
  let settleProvider!: (attempt: ManagedProviderAttempt) => void;
  const providerOutcome = new Promise<ManagedProviderAttempt>((resolve) => {
    settleProvider = resolve;
  });

  const settle = (
    attempt: Pick<ManagedProviderAttempt, "status" | "errorCode">,
  ) => {
    if (providerSettled) return;
    providerSettled = true;
    providerDetached = true;
    for (const waiter of detachWaiters) waiter();
    detachWaiters.clear();
    if (connectTimer) clearTimeout(connectTimer);
    settleProvider({
      ...attempt,
      providerPutMs: Date.now() - startedAt,
      bytesForwarded,
      requestBodyComplete:
        providerEnded && bytesForwarded === (declaredBytes ?? bytesForwarded),
      requestCreatedAtOffsetMs,
      providerStartedAtOffsetMs,
    });
  };
  const maybeSettleResponse = () => {
    if (responseStatus === undefined) return;
    if (!providerEnded || pendingWriteCallbacks === 0) {
      settle({ status: responseStatus, errorCode: null });
      if (providerRequest && !providerRequest.destroyed) {
        providerRequest.destroy();
      }
    }
  };
  const abortProvider = () => {
    const reason = abortReason(managedSignal);
    settle({ status: null, errorCode: providerErrorCode(reason) });
    providerRequest?.destroy(reason);
  };
  managedSignal.addEventListener("abort", abortProvider, { once: true });

  const waitForDrainOrDetach = async () => {
    if (providerDetached || !providerRequest) return;
    await new Promise<void>((resolve, reject) => {
      const request = providerRequest!;
      const cleanup = () => {
        request.off("drain", onDrain);
        managedSignal.removeEventListener("abort", onAbort);
        detachWaiters.delete(onDetach);
      };
      const onDrain = () => {
        cleanup();
        resolve();
      };
      const onDetach = () => {
        cleanup();
        resolve();
      };
      const onAbort = () => {
        cleanup();
        reject(abortReason(managedSignal));
      };
      request.once("drain", onDrain);
      managedSignal.addEventListener("abort", onAbort, { once: true });
      detachWaiters.add(onDetach);
      if (providerDetached) onDetach();
    });
  };

  try {
    if (managedSignal.aborted) throw abortReason(managedSignal);
    await input.assertProviderCanStart?.();
    if (managedSignal.aborted) throw abortReason(managedSignal);
    try {
      const requestFactory = input.requestFactory ?? defaultRequestFactory;
      providerRequest = requestFactory(
        safeTarget,
        {
          method: "PUT",
          agent: safeExternalAgentForUrl(safeTarget.toString()),
          headers: {
            "Content-Type": input.mimeType,
            ...(declaredBytes === undefined
              ? {}
              : { "Content-Length": String(declaredBytes) }),
          },
        },
        (response) => {
          responseStatus =
            typeof response.statusCode === "number"
              ? response.statusCode
              : null;
          response.destroy();
          maybeSettleResponse();
        },
      );
      connectTimer = setTimeout(() => {
        providerRequest?.destroy(
          Object.assign(new Error("Managed provider connect timed out"), {
            code: "ETIMEDOUT",
          }),
        );
      }, input.connectTimeoutMs ?? MANAGED_PROVIDER_CONNECT_TIMEOUT_MS);
      connectTimer.unref?.();
      providerRequest.once("socket", (socket) => {
        const connected = () => {
          providerStartedAtOffsetMs ??= Math.max(
            0,
            Date.now() - requestStartedAt,
          );
          if (connectTimer) clearTimeout(connectTimer);
          connectTimer = undefined;
        };
        if (!socket.connecting) {
          connected();
        } else if (safeTarget.protocol === "https:") {
          socket.once("secureConnect", connected);
        } else {
          socket.once("connect", connected);
        }
      });
      providerRequest.once("error", (error) => {
        settle({ status: null, errorCode: providerErrorCode(error) });
      });
      providerRequest.setTimeout(input.timeoutMs, () => {
        providerRequest?.destroy(
          Object.assign(new Error("Managed provider upload timed out"), {
            code: "ETIMEDOUT",
          }),
        );
      });
      // The signed capability starts being used before any potentially slow
      // disk ingress; no browser chunk is read before headers are flushed.
      providerRequest.flushHeaders();
    } catch (error) {
      settle({ status: null, errorCode: providerErrorCode(error) });
    }

    let sizeBytes = 0;
    bodyIterator = input.body[Symbol.asyncIterator]();
    while (true) {
      if (managedSignal.aborted) throw abortReason(managedSignal);
      const remainingAbsoluteMs = absoluteDeadline - Date.now();
      if (remainingAbsoluteMs <= 0) {
        throw Object.assign(
          new Error("Managed upload source deadline exceeded"),
          {
            code: "UPLOAD_SOURCE_DEADLINE_EXCEEDED",
          },
        );
      }
      const next = await new Promise<IteratorResult<unknown>>(
        (resolve, reject) => {
          const timeoutCode =
            remainingAbsoluteMs <= sourceIdleTimeoutMs
              ? "UPLOAD_SOURCE_DEADLINE_EXCEEDED"
              : "UPLOAD_SOURCE_IDLE_TIMEOUT";
          const sourceTimer = setTimeout(
            () => {
              cleanup();
              reject(
                Object.assign(new Error(timeoutCode), { code: timeoutCode }),
              );
            },
            Math.min(remainingAbsoluteMs, sourceIdleTimeoutMs),
          );
          sourceTimer.unref?.();
          const cleanup = () => {
            clearTimeout(sourceTimer);
            managedSignal.removeEventListener("abort", onAbort);
          };
          const onAbort = () => {
            cleanup();
            reject(abortReason(managedSignal));
          };
          managedSignal.addEventListener("abort", onAbort, { once: true });
          void bodyIterator!.next().then(
            (value) => {
              cleanup();
              resolve(value);
            },
            (error) => {
              cleanup();
              reject(error);
            },
          );
        },
      );
      if (next.done) break;
      const chunk = Buffer.isBuffer(next.value)
        ? next.value
        : Buffer.from(next.value as Uint8Array | string);
      sizeBytes += chunk.length;
      const localWrite = stage.append(chunk);
      let providerWrite = Promise.resolve();
      if (!providerDetached && providerRequest) {
        pendingWriteCallbacks += 1;
        let resolveWrite!: () => void;
        const writeCompleted = new Promise<void>((resolve) => {
          resolveWrite = resolve;
        });
        const writable = providerRequest.write(chunk, (error) => {
          pendingWriteCallbacks -= 1;
          if (error) {
            settle({ status: null, errorCode: providerErrorCode(error) });
          } else {
            bytesForwarded += chunk.length;
            maybeSettleResponse();
          }
          resolveWrite();
        });
        const waitForWriteOrDetach = new Promise<void>((resolve) => {
          if (providerDetached) {
            resolve();
            return;
          }
          const onDetach = () => {
            detachWaiters.delete(onDetach);
            resolve();
          };
          detachWaiters.add(onDetach);
          void writeCompleted.then(() => {
            detachWaiters.delete(onDetach);
            resolve();
          });
        });
        providerWrite = writable
          ? waitForWriteOrDetach
          : Promise.all([waitForWriteOrDetach, waitForDrainOrDetach()]).then(
              () => undefined,
            );
      }
      await Promise.all([localWrite, providerWrite]);
    }
    if (managedSignal.aborted) throw abortReason(managedSignal);
    if (declaredBytes !== undefined && sizeBytes !== declaredBytes) {
      throw Object.assign(new Error("Managed upload length mismatch"), {
        code: "UPLOAD_CONTENT_LENGTH_MISMATCH",
      });
    }
    input.onIngressComplete?.();
    if (managedSignal.aborted) throw abortReason(managedSignal);
    if (!providerDetached && providerRequest) {
      providerEnded = true;
      providerRequest.end();
      maybeSettleResponse();
    }
    const staged = await stage.finalize();
    const provider = await providerOutcome;
    return { staged, provider };
  } catch (error) {
    providerRequest?.destroy();
    if (connectTimer) clearTimeout(connectTimer);
    try {
      const returned = bodyIterator?.return?.();
      if (returned) {
        let cleanupTimer: NodeJS.Timeout | undefined;
        await Promise.race([
          returned,
          new Promise<void>((resolve) => {
            cleanupTimer = setTimeout(resolve, 1_000);
            cleanupTimer.unref?.();
          }),
        ]);
        if (cleanupTimer) clearTimeout(cleanupTimer);
      }
    } catch {
      // The HTTP response close path still tears down the source socket.
    }
    await stage.discard();
    // The absolute deadline tears down both the local stage stream and the
    // Provider request. Under scheduler pressure either stream can surface its
    // native ERR_STREAM_DESTROYED first; the public contract must still report
    // the authoritative abort reason instead of leaking that race.
    if (managedSignal.aborted) throw abortReason(managedSignal);
    throw error;
  } finally {
    managedSignal.removeEventListener("abort", abortProvider);
    clearTimeout(deadlineTimer);
  }
}
