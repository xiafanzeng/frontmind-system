import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import type { IncomingMessage, RequestOptions } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { Readable, Writable } from "node:stream";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  MANAGED_UPLOAD_POST_INGRESS_TIMEOUT_MS,
  stageAndUploadManagedBody,
  type ManagedProviderRequestFactory,
} from "./managed-upload-provider";

class FakeProviderRequest extends Writable {
  readonly bytes: Buffer[] = [];
  readonly events: string[];
  private timeoutCallback: (() => void) | undefined;

  constructor(
    events: string[],
    private readonly onFinal: () => void,
    options: { delayedWrites?: boolean } = {},
  ) {
    super({ highWaterMark: options.delayedWrites ? 1 : 16 * 1024 });
    this.events = events;
    this.delayedWrites = Boolean(options.delayedWrites);
  }

  private readonly delayedWrites: boolean;

  flushHeaders() {
    this.events.push("flushHeaders");
  }

  setTimeout(_timeout: number, callback?: () => void) {
    this.timeoutCallback = callback;
    return this;
  }

  _write(
    chunk: Buffer,
    _encoding: BufferEncoding,
    callback: (error?: Error | null) => void,
  ) {
    this.events.push(`write:${chunk.toString("utf8")}`);
    this.bytes.push(Buffer.from(chunk));
    if (this.delayedWrites) setImmediate(callback);
    else callback();
  }

  _final(callback: (error?: Error | null) => void) {
    this.events.push("end");
    this.onFinal();
    callback();
  }

  triggerTimeout() {
    this.timeoutCallback?.();
  }
}

function providerResponse(statusCode: number) {
  const response = new EventEmitter() as IncomingMessage;
  response.statusCode = statusCode;
  response.destroy = () => response;
  return response;
}

let assetDirectory: string | undefined;
let previousAssetDirectory: string | undefined;

afterEach(async () => {
  vi.restoreAllMocks();
  if (previousAssetDirectory === undefined) {
    delete process.env.FRONTMIND_DASHBOARD_ASSET_DIR;
  } else {
    process.env.FRONTMIND_DASHBOARD_ASSET_DIR = previousAssetDirectory;
  }
  if (assetDirectory)
    await rm(assetDirectory, { recursive: true, force: true });
  assetDirectory = undefined;
  previousAssetDirectory = undefined;
});

async function prepareAssetDirectory() {
  previousAssetDirectory = process.env.FRONTMIND_DASHBOARD_ASSET_DIR;
  assetDirectory = await mkdtemp(
    path.join(tmpdir(), "managed-upload-provider-test-"),
  );
  process.env.FRONTMIND_DASHBOARD_ASSET_DIR = assetDirectory;
}

describe("stageAndUploadManagedBody", () => {
  it("keeps one shared post-ingress deadline inside the browser completion watchdog", () => {
    expect(MANAGED_UPLOAD_POST_INGRESS_TIMEOUT_MS).toBe(330_000);
    expect(MANAGED_UPLOAD_POST_INGRESS_TIMEOUT_MS).toBeLessThan(6 * 60_000);
  });

  it("signals ingress completion exactly once before waiting on a pending provider", async () => {
    await prepareAssetDirectory();
    const controller = new AbortController();
    let providerRequest: FakeProviderRequest;
    let ingressCompleteCalls = 0;
    const requestFactory: ManagedProviderRequestFactory = () => {
      providerRequest = new FakeProviderRequest([], () => undefined);
      return providerRequest as never;
    };

    await expect(
      stageAndUploadManagedBody({
        body: Readable.from([Buffer.from("post-ingress")]),
        fileId: "provider-post-ingress-deadline",
        target:
          "https://uploads.example.test/object?X-Amz-Date=20990101T000000Z&X-Amz-Expires=180",
        mimeType: "application/octet-stream",
        maxBytes: 1_024,
        declaredBytes: Buffer.byteLength("post-ingress"),
        signal: controller.signal,
        timeoutMs: 120_000,
        onIngressComplete: () => {
          ingressCompleteCalls += 1;
          controller.abort(
            Object.assign(new Error("post-ingress deadline"), {
              code: "UPLOAD_POST_INGRESS_DEADLINE_EXCEEDED",
            }),
          );
        },
        requestFactory,
      }),
    ).rejects.toMatchObject({
      code: "UPLOAD_POST_INGRESS_DEADLINE_EXCEEDED",
    });

    expect(ingressCompleteCalls).toBe(1);
    expect(providerRequest!.destroyed).toBe(true);
  });

  it("rechecks capability after disk preflight and creates no provider request once expired", async () => {
    await prepareAssetDirectory();
    const requestFactory = vi.fn<ManagedProviderRequestFactory>();
    const capabilityError = Object.assign(
      new Error("capability expired during disk preflight"),
      {
        code: "UPLOAD_CAPABILITY_EXPIRED_RECREATE_REQUIRED",
        recoveryAction: "discard_and_recreate",
      },
    );

    await expect(
      stageAndUploadManagedBody({
        body: Readable.from([Buffer.from("must not be pulled")]),
        fileId: "provider-expired-after-storage-preflight",
        target:
          "https://uploads.example.test/object?X-Amz-Date=20990101T000000Z&X-Amz-Expires=180",
        mimeType: "application/octet-stream",
        maxBytes: 1_024,
        declaredBytes: Buffer.byteLength("must not be pulled"),
        signal: new AbortController().signal,
        timeoutMs: 120_000,
        assertProviderCanStart: () => {
          throw capabilityError;
        },
        requestFactory,
      }),
    ).rejects.toBe(capabilityError);

    expect(requestFactory).not.toHaveBeenCalled();
    expect(await readdir(path.join(assetDirectory!, "presales-files"))).toEqual(
      [],
    );
  });

  it("starts the signed PUT before one-pass 43 MiB ingress and completes after the 180-second capability boundary", async () => {
    await prepareAssetDirectory();
    const signedAt = Date.UTC(2030, 0, 1, 0, 0, 0);
    let simulatedNow = signedAt;
    vi.spyOn(Date, "now").mockImplementation(() => simulatedNow);
    const events: string[] = [];
    const chunk = Buffer.alloc(64 * 1024, 0x5a);
    const chunkCount = 43 * 16;
    const declaredBytes = chunk.length * chunkCount;
    let sourcePulls = 0;
    let responseAt = 0;
    let onResponse: ((response: IncomingMessage) => void) | undefined;
    const providerHash = createHash("sha256");
    let providerBytes = 0;
    class CountingProviderRequest extends Writable {
      flushHeaders() {
        events.push("flushHeaders");
        this.emit("socket", { connecting: false });
      }

      setTimeout() {
        return this;
      }

      _write(
        value: Buffer,
        _encoding: BufferEncoding,
        callback: (error?: Error | null) => void,
      ) {
        providerBytes += value.length;
        providerHash.update(value);
        callback();
      }

      _final(callback: (error?: Error | null) => void) {
        responseAt = simulatedNow;
        onResponse?.(providerResponse(200));
        callback();
      }
    }
    const requestFactory: ManagedProviderRequestFactory = (
      _target,
      _options,
      callback,
    ) => {
      events.push("request");
      onResponse = callback;
      return new CountingProviderRequest() as never;
    };
    const source = new Readable({
      read() {
        if (sourcePulls >= chunkCount) {
          simulatedNow = signedAt + 181_000;
          this.push(null);
          return;
        }
        sourcePulls += 1;
        simulatedNow =
          signedAt + Math.floor((181_000 * sourcePulls) / chunkCount);
        events.push(`pull:${sourcePulls}`);
        this.push(chunk);
      },
    });
    const expectedHash = createHash("sha256");
    for (let index = 0; index < chunkCount; index += 1) {
      expectedHash.update(chunk);
    }
    const expectedSha256 = expectedHash.digest("hex");

    const result = await stageAndUploadManagedBody({
      body: source,
      fileId: "provider-43m-crosses-signature-expiry",
      target:
        "https://uploads.example.test/object?X-Amz-Date=20300101T000000Z&X-Amz-Expires=180",
      mimeType: "application/pdf",
      maxBytes: declaredBytes,
      declaredBytes,
      signal: new AbortController().signal,
      timeoutMs: 120_000,
      requestStartedAt: signedAt,
      requestFactory,
    });

    expect(events.slice(0, 3)).toEqual(["request", "flushHeaders", "pull:1"]);
    expect(result.provider).toMatchObject({
      status: 200,
      bytesForwarded: declaredBytes,
      requestBodyComplete: true,
      providerStartedAtOffsetMs: 0,
    });
    expect(sourcePulls).toBe(chunkCount);
    expect(providerBytes).toBe(declaredBytes);
    expect(providerHash.digest("hex")).toBe(expectedSha256);
    expect(result.staged).toMatchObject({
      sizeBytes: declaredBytes,
      sha256: expectedSha256,
    });
    expect(responseAt - signedAt).toBeGreaterThan(180_000);
    await result.staged.discard();
  });

  it("flushes the signed PUT before ingress and applies provider backpressure while staging exact bytes", async () => {
    await prepareAssetDirectory();
    const events: string[] = [];
    let requestOptions: RequestOptions | undefined;
    let onResponse: ((response: IncomingMessage) => void) | undefined;
    let providerRequest: FakeProviderRequest;
    const requestFactory: ManagedProviderRequestFactory = (
      _target,
      options,
      callback,
    ) => {
      requestOptions = options;
      onResponse = callback;
      providerRequest = new FakeProviderRequest(
        events,
        () => onResponse?.(providerResponse(200)),
        { delayedWrites: true },
      );
      return providerRequest as never;
    };
    async function* body() {
      events.push("pull:a");
      yield Buffer.from("a");
      events.push("pull:b");
      yield Buffer.from("b");
    }

    const result = await stageAndUploadManagedBody({
      body: body(),
      fileId: "provider-live-success",
      target:
        "https://uploads.example.test/object?X-Amz-Date=20990101T000000Z&X-Amz-Expires=180",
      mimeType: "application/pdf",
      maxBytes: 1024,
      declaredBytes: 2,
      signal: new AbortController().signal,
      timeoutMs: 120_000,
      requestFactory,
    });

    expect(events[0]).toBe("flushHeaders");
    expect(events.indexOf("write:a")).toBeLessThan(events.indexOf("pull:b"));
    expect(Buffer.concat(providerRequest!.bytes).toString("utf8")).toBe("ab");
    expect(requestOptions?.headers).toMatchObject({
      "Content-Type": "application/pdf",
      "Content-Length": "2",
    });
    expect(result.provider).toMatchObject({ status: 200, errorCode: null });
    expect(await result.staged.createReadStream().toArray()).toEqual([
      Buffer.from("ab"),
    ]);
    await result.staged.discard();
  });

  it("detaches an early provider failure but still stages the browser body once", async () => {
    await prepareAssetDirectory();
    const source = Buffer.from("browser bytes survive provider reset");
    let providerRequest: FakeProviderRequest;
    const requestFactory: ManagedProviderRequestFactory = (
      _target,
      _options,
      _onResponse,
    ) => {
      providerRequest = new FakeProviderRequest([], () => undefined);
      queueMicrotask(() =>
        providerRequest.emit(
          "error",
          Object.assign(new Error("reset"), { code: "ECONNRESET" }),
        ),
      );
      return providerRequest as never;
    };

    const result = await stageAndUploadManagedBody({
      body: (async function* () {
        yield source.subarray(0, 7);
        await new Promise((resolve) => setImmediate(resolve));
        yield source.subarray(7);
      })(),
      fileId: "provider-live-detach",
      target:
        "https://uploads.example.test/object?X-Amz-Date=20990101T000000Z&X-Amz-Expires=180",
      mimeType: "application/octet-stream",
      maxBytes: 1024,
      declaredBytes: source.length,
      signal: new AbortController().signal,
      timeoutMs: 120_000,
      requestFactory,
    });

    expect(result.provider).toMatchObject({
      status: null,
      errorCode: "ECONNRESET",
    });
    const chunks: Buffer[] = [];
    for await (const chunk of result.staged.createReadStream()) {
      chunks.push(Buffer.from(chunk));
    }
    expect(Buffer.concat(chunks)).toEqual(source);
    await result.staged.discard();
  });

  it("does not mark an early 2xx response as a complete request body", async () => {
    await prepareAssetDirectory();
    const source = Buffer.from("body after premature success");
    const requestFactory: ManagedProviderRequestFactory = (
      _target,
      _options,
      onResponse,
    ) => {
      const request = new FakeProviderRequest([], () => undefined);
      queueMicrotask(() => onResponse(providerResponse(200)));
      return request as never;
    };

    const result = await stageAndUploadManagedBody({
      body: (async function* () {
        await new Promise((resolve) => setImmediate(resolve));
        yield source;
      })(),
      fileId: "provider-early-2xx",
      target:
        "https://uploads.example.test/object?X-Amz-Date=20990101T000000Z&X-Amz-Expires=180",
      mimeType: "application/octet-stream",
      maxBytes: 1024,
      declaredBytes: source.length,
      signal: new AbortController().signal,
      timeoutMs: 120_000,
      requestFactory,
    });

    expect(result.provider).toMatchObject({
      status: 200,
      bytesForwarded: 0,
      requestBodyComplete: false,
    });
    await result.staged.discard();
  });

  it("cancels the native request and removes temporary staging on abort", async () => {
    await prepareAssetDirectory();
    const controller = new AbortController();
    let providerRequest: FakeProviderRequest;
    const requestFactory: ManagedProviderRequestFactory = () => {
      providerRequest = new FakeProviderRequest([], () => undefined);
      return providerRequest as never;
    };

    await expect(
      stageAndUploadManagedBody({
        body: (async function* () {
          yield Buffer.from("first");
          controller.abort();
          yield Buffer.from("second");
        })(),
        fileId: "provider-live-abort",
        target:
          "https://uploads.example.test/object?X-Amz-Date=20990101T000000Z&X-Amz-Expires=180",
        mimeType: "application/octet-stream",
        maxBytes: 1024,
        signal: controller.signal,
        timeoutMs: 120_000,
        requestFactory,
      }),
    ).rejects.toMatchObject({ code: "ERR_CANCELED" });
    expect(providerRequest!.destroyed).toBe(true);
  });

  it("enforces the absolute deadline while a sink is still pending", async () => {
    await prepareAssetDirectory();
    class HangingProviderRequest extends FakeProviderRequest {
      _write(
        _chunk: Buffer,
        _encoding: BufferEncoding,
        _callback: (error?: Error | null) => void,
      ) {
        // The absolute deadline, not source activity, must terminate this wait.
      }
    }
    const requestFactory: ManagedProviderRequestFactory = () =>
      new HangingProviderRequest([], () => undefined) as never;
    const startedAt = Date.now();

    await expect(
      stageAndUploadManagedBody({
        body: (async function* () {
          yield Buffer.from("near-deadline-sink");
        })(),
        fileId: "provider-absolute-deadline",
        target:
          "https://uploads.example.test/object?X-Amz-Date=20990101T000000Z&X-Amz-Expires=180",
        mimeType: "application/octet-stream",
        maxBytes: 1024,
        declaredBytes: Buffer.byteLength("near-deadline-sink"),
        signal: new AbortController().signal,
        timeoutMs: 120_000,
        absoluteTimeoutMs: 20,
        requestFactory,
      }),
    ).rejects.toMatchObject({ code: "UPLOAD_SOURCE_DEADLINE_EXCEEDED" });
    expect(Date.now() - startedAt).toBeLessThan(1_000);
  });
});
