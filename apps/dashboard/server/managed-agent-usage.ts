import { readAiCostTotals } from "./ai-billing-service";
import {
  formatCostCny,
  nativeTokens,
  zhipuCostNanos,
  ZHIPU_PRICING_SOURCE,
} from "./zhipu-cost";

export type ManagedNativeUsage = {
  provider: "zhipu";
  unit: "tokens";
  inputTokens: number;
  outputTokens: number;
  cacheReadInputTokens: number;
  observedTasks: number;
  costCny: string | null;
  costStatus: "complete" | "partial" | "unknown";
  pricingSourceUrl: string;
};

/** Native provider observations stay separate from the historical credit ledger. */
export function projectManagedNativeUsage(
  runtimes: Array<Record<string, unknown> | null>,
): ManagedNativeUsage {
  const result: ManagedNativeUsage = {
    provider: "zhipu",
    unit: "tokens",
    inputTokens: 0,
    outputTokens: 0,
    cacheReadInputTokens: 0,
    observedTasks: 0,
    costCny: null,
    costStatus: "unknown",
    pricingSourceUrl: ZHIPU_PRICING_SOURCE,
  };
  let knownCost = 0n;
  let priced = 0;
  for (const runtime of runtimes) {
    const usage = runtime?.usage;
    if (!usage || typeof usage !== "object" || Array.isArray(usage)) continue;
    const managed = runtime?.dashboardManaged as
      | Record<string, unknown>
      | undefined;
    const cost = zhipuCostNanos(
      String(managed?.model ?? runtime?.model ?? ""),
      nativeTokens(usage),
    );
    if (cost !== null) {
      knownCost += cost;
      priced++;
    }
    let observed = false;
    for (const [field, target] of [
      ["input_tokens", "inputTokens"],
      ["output_tokens", "outputTokens"],
      ["cache_read_input_tokens", "cacheReadInputTokens"],
    ] as const) {
      const value = (usage as Record<string, unknown>)[field];
      if (
        typeof value !== "number" ||
        !Number.isSafeInteger(value) ||
        value < 0
      )
        continue;
      result[target] += value;
      observed = true;
    }
    if (observed) result.observedTasks += 1;
  }
  result.costCny = priced ? formatCostCny(knownCost) : null;
  // Session snapshots are historical projections; event timestamps produce complete period totals below.
  result.costStatus = priced ? "partial" : "unknown";
  return result;
}

export async function readManagedNativeUsageByAccounts(input: {
  executor: any;
  accountIds: number[];
  startAt: number;
  endAt: number;
}) {
  const accountIds = [...new Set(input.accountIds)];
  const result = new Map<number, ManagedNativeUsage>();
  if (!accountIds.length) return result;
  const costs = await readAiCostTotals({
    ...input,
    accountIds,
    scope: "managed_user",
  });
  for (const accountId of accountIds) {
    result.set(
      accountId,
      costs.get(accountId) ?? projectManagedNativeUsage([]),
    );
  }
  return result;
}
