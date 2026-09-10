/** Customer billing projection: charges only; no provider costs or credentials. */
export type CustomerAiTaskUsage = {
  runId: string;
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
