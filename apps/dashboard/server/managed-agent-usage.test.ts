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
        model: "glm-5.3",
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
      costCny: "0.001960",
      costStatus: "partial",
      pricingSourceUrl: "https://bigmodel.cn/pricing",
    });
    expect(result).not.toHaveProperty("creditUsage");
  });
  it("keeps costs unknown when an otherwise complete token snapshot has no frozen model", () => {
    expect(
      projectManagedNativeUsage([
        {
          usage: {
            input_tokens: 100,
            output_tokens: 50,
            cache_read_input_tokens: 10,
          },
        },
      ]),
    ).toMatchObject({ costCny: null, costStatus: "unknown", inputTokens: 100 });
  });
  it("attributes observed tasks to their own account without sharing token totals", async () => {
    const rows = [
      {
        accountUserId: 1,
        localTaskId: "task-a",
        inputTokens: 10n,
        outputTokens: 2n,
        cacheReadInputTokens: 0n,
        costNanos: 136000n,
      },
      {
        accountUserId: 2,
        localTaskId: "task-b",
        inputTokens: 90n,
        outputTokens: 8n,
        cacheReadInputTokens: 0n,
        costNanos: 944000n,
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
