import { trpc } from "@/lib/trpc";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { httpBatchLink } from "@trpc/client";
import { createRoot } from "react-dom/client";
import superjson from "superjson";
import App from "./App";
import { checkFrontMindBuildVersion } from "@/lib/build-version";
import "./index.css";

const queryClient = new QueryClient();

function loadOptionalAnalytics() {
  const endpoint = import.meta.env.VITE_ANALYTICS_ENDPOINT;
  const websiteId = import.meta.env.VITE_ANALYTICS_WEBSITE_ID;
  if (!endpoint || !websiteId) return;

  try {
    const scriptUrl = new URL("umami", `${endpoint.replace(/\/$/, "")}/`);
    if (scriptUrl.protocol !== "https:" && scriptUrl.protocol !== "http:") return;
    const script = document.createElement("script");
    script.defer = true;
    script.src = scriptUrl.toString();
    script.dataset.websiteId = websiteId;
    document.head.appendChild(script);
  } catch {
    console.warn("[Analytics] Ignoring invalid VITE_ANALYTICS_ENDPOINT");
  }
}

loadOptionalAnalytics();

queryClient.getQueryCache().subscribe(event => {
  if (event.type === "updated" && event.action.type === "error") {
    const error = event.query.state.error;
    console.error("[API Query Error]", error);
  }
});

queryClient.getMutationCache().subscribe(event => {
  if (event.type === "updated" && event.action.type === "error") {
    const error = event.mutation.state.error;
    console.error("[API Mutation Error]", error);
  }
});

const trpcClient = trpc.createClient({
  links: [
    httpBatchLink({
      url: "/api/trpc",
      transformer: superjson,
      fetch(input, init) {
        return globalThis.fetch(input, {
          ...(init ?? {}),
          credentials: "include",
        });
      },
    }),
  ],
});

// ============================================================
// Version check on focus (Stale-While-Revalidate pattern)
//
// Instead of polling every N seconds, we only check for a new
// deployment when the user switches back to this tab. This is
// the same strategy used by Vercel / Next.js in production:
//   - Zero background requests while the user is active or away
//   - One lightweight check (~100 bytes) when the tab regains focus
//   - Automatic reload only when a genuinely new version is detected
// ============================================================
if (import.meta.env.PROD) {
  void checkFrontMindBuildVersion();

  // Re-check when the user switches back to this tab.
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") {
      void checkFrontMindBuildVersion();
    }
  });

  // Also check on window focus (covers some edge cases not caught by visibilitychange).
  window.addEventListener("focus", () => {
    void checkFrontMindBuildVersion();
  });

  window.setInterval(() => {
    if (document.visibilityState === "visible") {
      void checkFrontMindBuildVersion();
    }
  }, 5 * 60 * 1000);
}

createRoot(document.getElementById("root")!).render(
  <trpc.Provider client={trpcClient} queryClient={queryClient}>
    <QueryClientProvider client={queryClient}>
      <App />
    </QueryClientProvider>
  </trpc.Provider>
);
