import type { AppRouter } from "@frontmind/monitoring-api";
import { httpBatchLink } from "@trpc/client";
import { createContext } from "react";
import { createTRPCReact } from "@trpc/react-query";
import { enterpriseProjectHeaders } from "@/lib/enterprise-project";
import { captureWorkspaceRestOperation, type WorkspaceRestOperation } from "@/lib/workspace-rest-scope";

// Keep module procedures distinct from Dashboard procedures with the same names.
export const trpc = createTRPCReact<AppRouter>({
  context: createContext(null),
});

const clientRestScopes = new WeakMap<object, WorkspaceRestOperation>();

/** The first subscribed operation runs after the owning workspace layout effect. */
export function monitoringClientRestOperation(client: object): WorkspaceRestOperation {
  let operation = clientRestScopes.get(client);
  if (!operation) {
    operation = captureWorkspaceRestOperation();
    clientRestScopes.set(client, operation);
  }
  return operation;
}

export function createTrpcClient() {
  const client = trpc.createClient({
    links: [
      () => ({ op, next }) => {
        // Capture before httpBatchLink queues the request; a later flush cannot adopt another project.
        monitoringClientRestOperation(client);
        return next(op);
      },
      httpBatchLink({
        url: "/api/monitoring/trpc",
        headers: enterpriseProjectHeaders(),
        async fetch(url, options) {
          const response = await monitoringClientRestOperation(client).fetch(url, {
            ...options,
            credentials: "same-origin",
          });
          return response;
        },
      }),
    ],
  });
  return client;
}
