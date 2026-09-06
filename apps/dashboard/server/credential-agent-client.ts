import type { DecryptedCredential } from "./auth-service";
import { createDashboardAgentClient } from "./providers/dashboard-agent-provider";
import { getUpstreamBaseUrl } from "./upstream-config";

/** Select the provider from the exact credential generation already authorized
 * by the repository. Never re-resolve the account's current key here. */
export function createCredentialAgentClient(
  credential: DecryptedCredential,
  options: {
    accountUserId?: number;
    intentId?: string;
    localTaskId?: string;
    operationId?: string;
    model?: string;
    effort?: "low" | "high" | "max";
    baseUrl?: string;
    rateLimitScope?: string;
  } = {},
) {
  return createDashboardAgentClient({
    provider: credential.provider ?? "manus",
    accountUserId: options.accountUserId ?? credential.userId,
    credentialId: credential.id,
    credentialOwnerUserId: credential.userId,
    credentialVersion: credential.version,
    apiKey: credential.apiKey,
    ...(credential.provider === "zhipu"
      ? {
          model: credential.upstreamModel,
          effort: credential.upstreamEffort ?? undefined,
        }
      : {}),
    baseUrl: getUpstreamBaseUrl(),
    rateLimitScope: `managed-user:${options.accountUserId ?? credential.userId}`,
    ...Object.fromEntries(
      Object.entries(options).filter(([, value]) => value !== undefined),
    ),
  });
}
