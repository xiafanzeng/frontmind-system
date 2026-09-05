import type { SiteOperation } from "../../drizzle/schema";

export type SiteOpsProviderName =
  | "21st"
  | "manus"
  | "aliyun_esa"
  | "aliyun_alidns";

export type SiteOpsProviderResult =
  | {
      /**
       * The external task is durably identified but not terminal. The worker
       * keeps the same reservation and reclaims it only after nextPollMs;
       * this is not an unknown outcome and must not create a second task.
       */
      status: "pending";
      result?: Record<string, unknown>;
      providerOperationId?: string;
      providerTaskId?: string;
      nextPollMs?: number;
      projectStatus?:
        | "collecting_brief"
        | "visual_searching"
        | "awaiting_visual_selection"
        | "building"
        | "preview_ready"
        | "approved"
        | "live";
      buildStatus?:
        | "design_compiling"
        | "contract_ready"
        | "building"
        | "qa_running";
    }
  | {
      status: "succeeded";
      result?: Record<string, unknown>;
      providerOperationId?: string;
      providerTaskId?: string;
      projectStatus?:
        | "collecting_brief"
        | "awaiting_visual_selection"
        | "building"
        | "preview_ready"
        | "approved"
        | "live";
      buildStatus?:
        | "design_compiling"
        | "contract_ready"
        | "building"
        | "qa_running"
        | "preview_ready"
        | "approved";
      socialPackageStatus?: "building" | "ready";
      message?: string;
    }
  | {
      status: "failed" | "attention_required" | "outcome_unknown";
      code: string;
      message: string;
      result?: Record<string, unknown>;
      providerOperationId?: string;
      providerTaskId?: string;
    };

export type SiteOpsProviderHandler = (input: {
  operation: SiteOperation;
  signal: AbortSignal;
  /**
   * Read-only CAS guard supplied by the worker. Long-running local build/QA
   * implementations may call it before committing artifacts. Existing
   * providers can ignore it; finalize still performs the authoritative CAS.
   */
  assertLeaseActive?: () => Promise<void>;
}) => Promise<SiteOpsProviderResult>;

const handlers = new Map<SiteOpsProviderName, SiteOpsProviderHandler>();

/**
 * Registers one narrow adapter. Importing SiteOps never registers a fake
 * provider: an unavailable adapter therefore becomes attention_required.
 */
export function registerSiteOpsProviderHandler(
  provider: SiteOpsProviderName,
  handler: SiteOpsProviderHandler,
) {
  if (handlers.has(provider)) {
    throw new Error(`SITEOPS_PROVIDER_ALREADY_REGISTERED:${provider}`);
  }
  handlers.set(provider, handler);
  return () => {
    if (handlers.get(provider) === handler) handlers.delete(provider);
  };
}

export function siteOpsProviderConfigured(provider: SiteOpsProviderName) {
  return handlers.has(provider);
}

export function getSiteOpsProviderHandler(provider: string | null) {
  if (!provider) return null;
  return handlers.get(provider as SiteOpsProviderName) ?? null;
}
