import type { DecryptedCredential } from "./auth-service";
import { createDashboardAgentClient } from "./providers/dashboard-agent-provider";

/** Use the already authorized Zhipu credential for this account. */
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
    systemContext?: string;
    systemAttachments?: import("./manus-v2-client").ManusV2Attachment[];
    recoverableStatusArtifact?: (filename: string) => boolean;
  } = {},
) {
  return createDashboardAgentClient({
    provider: credential.provider ?? "zhipu",
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
    rateLimitScope: `managed-user:${options.accountUserId ?? credential.userId}`,
    ...Object.fromEntries(
      Object.entries(options).filter(([, value]) => value !== undefined),
    ),
  });
}
