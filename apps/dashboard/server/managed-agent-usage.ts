import { and, eq, gte, inArray, lt } from "drizzle-orm";
import { agentOperations, agentTasks } from "../drizzle/schema";

export type ManagedNativeUsage = {
  provider: "zhipu";
  unit: "tokens";
  inputTokens: number;
  outputTokens: number;
  cacheReadInputTokens: number;
  observedTasks: number;
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
  };
  for (const runtime of runtimes) {
    const usage = runtime?.usage;
    if (!usage || typeof usage !== "object" || Array.isArray(usage)) continue;
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
  return result;
}

export async function readManagedNativeUsageByAccounts(input: {
  executor: any;
  accountIds: number[];
  startAt: number;
  endAt: number;
}) {
  const result = new Map<number, ManagedNativeUsage>();
  const accountIds = [...new Set(input.accountIds)];
  if (!accountIds.length) return result;
  const rows: Array<{
    accountUserId: number;
    runtime: Record<string, unknown> | null;
  }> = await input.executor
    .select({
      accountUserId: agentOperations.accountUserId,
      runtime: agentTasks.providerRuntime,
    })
    .from(agentTasks)
    .innerJoin(agentOperations, eq(agentTasks.operationId, agentOperations.id))
    .where(
      and(
        eq(agentOperations.scope, "managed_user"),
        eq(agentOperations.provider, "zhipu"),
        inArray(agentOperations.accountUserId, accountIds),
        gte(agentOperations.createdAt, new Date(input.startAt)),
        lt(agentOperations.createdAt, new Date(input.endAt)),
      ),
    );
  for (const accountId of accountIds)
    result.set(
      accountId,
      projectManagedNativeUsage(
        rows
          .filter((row) => row.accountUserId === accountId)
          .map((row) => row.runtime),
      ),
    );
  return result;
}
