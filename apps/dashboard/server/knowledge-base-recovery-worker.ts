type ExpiredTurnRecoveryResult = {
  failed: number;
  claimedTurnIds?: readonly string[];
  [key: string]: unknown;
};

type ArtifactCleanupResult = {
  failed: number;
  [key: string]: unknown;
};

/**
 * Production recovery is reservation-scoped. Historical open builds,
 * migrations and task adoption are intentionally absent: those rows require
 * an approved reset followed by a fresh upload and fresh materialized-v5 task.
 *
 * Package generation remains a separate build-local sweep in _core/index.ts.
 */
export function createKnowledgeBaseRecoverySweep(input: {
  recoverExpiredTurns: () => Promise<ExpiredTurnRecoveryResult>;
  cleanupArtifactCandidates?: () => Promise<ArtifactCleanupResult>;
}) {
  return async () => {
    const turns = await input.recoverExpiredTurns();
    const artifacts = input.cleanupArtifactCandidates
      ? await input.cleanupArtifactCandidates()
      : null;
    return {
      failed: turns.failed + (artifacts?.failed ?? 0),
      turns,
      artifacts,
    };
  };
}
