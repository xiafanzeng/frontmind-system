type ExpiredTurnRecoveryResult = {
  failed: number;
  claimedTurnIds?: readonly string[];
  [key: string]: unknown;
};

type OpenBuildRecoveryResult = {
  failed: number;
  hasMore: boolean;
  nextCursor: string | null;
  [key: string]: unknown;
};

type ArtifactCleanupResult = {
  failed: number;
  [key: string]: unknown;
};

/**
 * One production recovery sweep covers both durable reservations and legacy
 * open builds which no longer have an active turn. The cursor is retained
 * across bounded passes so a page of long-running rows cannot starve later
 * builds forever.
 */
export function createKnowledgeBaseRecoverySweep(input: {
  recoverExpiredTurns: () => Promise<ExpiredTurnRecoveryResult>;
  recoverOpenBuilds: (options: {
    limit: number;
    concurrency: number;
    afterBuildId?: string;
  }) => Promise<OpenBuildRecoveryResult>;
  cleanupArtifactCandidates?: () => Promise<ArtifactCleanupResult>;
  openBuildLimit?: number;
  openBuildConcurrency?: number;
}) {
  const limit = Math.min(
    500,
    Math.max(1, Math.trunc(input.openBuildLimit ?? 100)),
  );
  const concurrency = Math.min(
    8,
    Math.max(1, Math.trunc(input.openBuildConcurrency ?? 3)),
  );
  let afterBuildId: string | undefined;

  return async () => {
    const turns = await input.recoverExpiredTurns();
    const builds = await input.recoverOpenBuilds({
      limit,
      concurrency,
      ...(afterBuildId ? { afterBuildId } : {}),
    });
    afterBuildId =
      builds.hasMore && builds.nextCursor ? builds.nextCursor : undefined;
    const artifacts = input.cleanupArtifactCandidates
      ? await input.cleanupArtifactCandidates()
      : null;
    return {
      failed: turns.failed + builds.failed + (artifacts?.failed ?? 0),
      turns,
      builds,
      artifacts,
    };
  };
}
