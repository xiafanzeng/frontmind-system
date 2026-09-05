import { describe, expect, it } from "vitest";

import {
  configureServerTimeouts,
  SERVER_HEADERS_TIMEOUT_MS,
  SERVER_KEEP_ALIVE_TIMEOUT_MS,
  SERVER_REQUEST_TIMEOUT_MS,
  SERVER_SOCKET_TIMEOUT_MS,
} from "./_core/server-timeouts";

describe("dashboard HTTP server timeouts", () => {
  it("removes the total request deadline while preserving header and socket-idle fences", () => {
    const server = {
      headersTimeout: 0,
      requestTimeout: 123,
      timeout: 0,
      keepAliveTimeout: 0,
    };

    configureServerTimeouts(server as never);

    expect(server).toEqual({
      headersTimeout: SERVER_HEADERS_TIMEOUT_MS,
      requestTimeout: SERVER_REQUEST_TIMEOUT_MS,
      timeout: SERVER_SOCKET_TIMEOUT_MS,
      keepAliveTimeout: SERVER_KEEP_ALIVE_TIMEOUT_MS,
    });
    expect(SERVER_HEADERS_TIMEOUT_MS).toBe(60_000);
    expect(SERVER_REQUEST_TIMEOUT_MS).toBe(0);
    expect(SERVER_SOCKET_TIMEOUT_MS).toBe(25 * 60_000);
    expect(SERVER_KEEP_ALIVE_TIMEOUT_MS).toBe(5_000);
  });
});
