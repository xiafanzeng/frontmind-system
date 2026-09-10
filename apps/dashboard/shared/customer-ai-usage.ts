/** Customer billing projection: charges only; no provider costs or credentials. */
export type CustomerAiTaskUsage = {
  runId: string;
  buildId?: string;
  generation?: number;
  invocationState?: "not_sent" | "called" | "unknown";
  currentTurnInvocationState?: "not_sent" | "called" | "unknown";
  calls?: Array<{ taskId: string; turnId?: string; startedAt: number; inputTokens: string; outputTokens: string; cacheTokens: string; chargedTenThousandths: string; usageStatus: "none" | "syncing" | "synced" | "partial" }>;
  businessName: string;
  status: string;
  startedAt: number;
  lastActivityAt: number;
  phase: string;
  inputTokens: string;
  outputTokens: string;
  cacheTokens: string;
  chargedTenThousandths: string;
  usageStatus: "none" | "syncing" | "synced" | "partial";
};
