import type { Server } from "node:http";

export const SERVER_HEADERS_TIMEOUT_MS = 60_000;
// A raw upload may make continuous progress for longer than any fixed request
// budget. `server.timeout` remains the socket-idle fence; disabling only the
// aggregate request deadline prevents Node from rejecting a healthy slow body.
export const SERVER_REQUEST_TIMEOUT_MS = 0;
export const SERVER_SOCKET_TIMEOUT_MS = 25 * 60_000;
export const SERVER_KEEP_ALIVE_TIMEOUT_MS = 5_000;

/** Explicit limits prevent Node's default total deadline cutting off ingress. */
export function configureServerTimeouts(
  server: Pick<
    Server,
    "headersTimeout" | "requestTimeout" | "timeout" | "keepAliveTimeout"
  >,
) {
  server.headersTimeout = SERVER_HEADERS_TIMEOUT_MS;
  server.requestTimeout = SERVER_REQUEST_TIMEOUT_MS;
  server.timeout = SERVER_SOCKET_TIMEOUT_MS;
  server.keepAliveTimeout = SERVER_KEEP_ALIVE_TIMEOUT_MS;
}
