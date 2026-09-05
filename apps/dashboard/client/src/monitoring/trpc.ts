import type { AppRouter } from "@frontmind/monitoring-api";
import { httpBatchLink } from "@trpc/client";
import { createContext } from "react";
import { createTRPCReact } from "@trpc/react-query";

// Keep module procedures distinct from Dashboard procedures with the same names.
export const trpc = createTRPCReact<AppRouter>({
  context: createContext(null),
});

export function createTrpcClient() {
  return trpc.createClient({
    links: [
      httpBatchLink({
        url: "/api/monitoring/trpc",
        async fetch(url, options) {
          const response = await fetch(url, {
            ...options,
            credentials: "same-origin",
          });
          return response;
        },
      }),
    ],
  });
}
