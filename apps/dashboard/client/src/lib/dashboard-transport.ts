import { httpBatchLink, httpLink, splitLink } from "@trpc/client";
import superjson from "superjson";
import { trpc } from "./trpc";
import { shouldIsolateAuthOperation } from "./trpc-link-routing";

/** A transport belongs to one workspace for its whole lifetime, including queued batches. */
export function createDashboardTransport(headers: Record<string, string> = {}, signal?: AbortSignal) {
  const frozenHeaders = { ...headers };
  const credentialedFetch = (input: RequestInfo | URL, init?: RequestInit) =>
    globalThis.fetch(input, {
      ...init,
      credentials: "include",
      ...(signal ? { signal: init?.signal ? AbortSignal.any([signal, init.signal]) : signal } : {}),
    });
  return trpc.createClient({
    links: [splitLink({
      condition: operation => shouldIsolateAuthOperation(operation.path),
      true: httpLink({ url: "/api/trpc", transformer: superjson, fetch: credentialedFetch, headers: {} }),
      false: httpBatchLink({ url: "/api/trpc", transformer: superjson, fetch: credentialedFetch, headers: frozenHeaders }),
    })],
  });
}
