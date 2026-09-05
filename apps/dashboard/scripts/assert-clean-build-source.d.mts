export function assertCleanProductionBuildSource(options?: {
  repositoryRoot?: string;
  env?: Readonly<Record<string, string | undefined>>;
  expectedBuildSha?: string;
}): string;

export function assertCleanProductionReleaseWorktree(options?: {
  repositoryRoot?: string;
  env?: Readonly<Record<string, string | undefined>>;
  expectedBuildSha?: string;
}): string;

export function changedSourcePaths(repositoryRoot: string): string[];
