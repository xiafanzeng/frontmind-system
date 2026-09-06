import { describe, expect, it } from "vitest";
import {
  projectManagedNativeUsage,
  readManagedNativeUsageByAccounts,
} from "./managed-agent-usage";

describe("managed native usage", () => {
  it("keeps token counters separate and ignores absent or invalid observations", () => {
    const result = projectManagedNativeUsage([
      null,
      {},
      { usage: { input_tokens: -1 } },
      {
        usage: {
          input_tokens: 120,
          output_tokens: 30,
          cache_read_input_tokens: 80,
        },
      },
      { usage: { input_tokens: 0, output_tokens: 7 } },
    ]);
    expect(result).toEqual({
      provider: "zhipu",
      unit: "tokens",
      inputTokens: 120,
      outputTokens: 37,
      cacheReadInputTokens: 80,
      observedTasks: 2,
    });
    expect(result).not.toHaveProperty("creditUsage");
  });
  it("attributes observed tasks to their own account without sharing token totals", async () => {
    const rows = [
      {
        accountUserId: 1,
        runtime: { usage: { input_tokens: 10, output_tokens: 2 } },
      },
      {
        accountUserId: 2,
        runtime: { usage: { input_tokens: 90, output_tokens: 8 } },
      },
    ];
    const query: any = {
      select: () => query,
      from: () => query,
      innerJoin: () => query,
      where: async () => rows,
    };
    const result = await readManagedNativeUsageByAccounts({
      executor: query,
      accountIds: [1, 2, 3],
      startAt: 0,
      endAt: 1,
    });
    expect(result.get(1)).toMatchObject({
      inputTokens: 10,
      outputTokens: 2,
      observedTasks: 1,
    });
    expect(result.get(2)).toMatchObject({
      inputTokens: 90,
      outputTokens: 8,
      observedTasks: 1,
    });
    expect(result.get(3)?.observedTasks).toBe(0);
  });
});
