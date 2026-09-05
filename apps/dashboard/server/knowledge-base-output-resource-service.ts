import { recordUpstreamResource } from "./auth-service";
import { logKnowledgeBaseRuntimeFailure } from "./knowledge-base-runtime-log";
import { collectUpstreamOutputFileIds } from "./upstream-output-resources";

export async function recordKnowledgeBaseOutputFiles(input: {
  userId: number;
  apiCredentialId: string;
  output: unknown;
}) {
  for (const fileId of collectUpstreamOutputFileIds(input.output, {
    ignoreInvalidImageResources: true,
  })) {
    const registration = {
      userId: input.userId,
      apiCredentialId: input.apiCredentialId,
      kind: "file" as const,
      upstreamId: fileId,
    };
    let lastError: unknown;
    let recorded = false;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        await recordUpstreamResource(registration);
        recorded = true;
        break;
      } catch (error) {
        lastError = error;
        if (attempt < 2) {
          await new Promise((resolve) =>
            setTimeout(resolve, 50 * 2 ** attempt),
          );
        }
      }
    }
    if (recorded) continue;

    // The upstream task has already been created. Do not turn a metadata
    // registration fault into a duplicate billable task on client retry.
    logKnowledgeBaseRuntimeFailure({
      level: "error",
      event: "[KnowledgeBaseOutputResource] registration_pending",
      userId: input.userId,
      error: lastError,
    });
    const retryTimer = setTimeout(() => {
      void recordUpstreamResource(registration).catch((error) => {
        logKnowledgeBaseRuntimeFailure({
          level: "error",
          event: "[KnowledgeBaseOutputResource] retry_failed",
          userId: input.userId,
          error,
        });
      });
    }, 1_000);
    retryTimer.unref?.();
  }
}
