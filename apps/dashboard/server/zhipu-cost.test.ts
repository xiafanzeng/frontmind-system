import { describe, expect, it } from "vitest";
import {
  applyCostRemainder,
  formatCostCny,
  nativeTokens,
  zhipuCostNanos,
} from "./zhipu-cost";
import { extractModelUsageEvent } from "./ai-billing-service";
describe("official Managed Agents cost", () => {
  it("uses independent input/output/cache counters", () => {
    const cost = zhipuCostNanos(
      "glm-5.3",
      nativeTokens({
        input_tokens: 49010,
        output_tokens: 5173,
        cache_read_input_tokens: 414336,
      }),
    );
    expect(cost).toBe(1_365_596_000n);
    expect(formatCostCny(cost!)).toBe("1.365596");
  });
  it("carries fractions without rounding every request up", () => {
    let remainder = 0n,
      charged = 0n;
    for (let i = 0; i < 50; i++) {
      const next = applyCostRemainder(2000n, remainder);
      charged += next.charge;
      remainder = next.remainder;
    }
    expect(charged).toBe(1n);
    expect(remainder).toBe(0n);
  });
  it("does not invent zero costs for unknown models or missing usage", () => {
    expect(
      zhipuCostNanos(
        "other",
        nativeTokens({
          input_tokens: 1,
          output_tokens: 1,
          cache_read_input_tokens: 1,
        }),
      ),
    ).toBeNull();
    expect(nativeTokens({ input_tokens: 1, output_tokens: 1 })).toBeNull();
    expect(
      zhipuCostNanos(
        "glm-5.3",
        nativeTokens({
          input_tokens: 1,
          output_tokens: 1,
          cache_read_input_tokens: 1,
          cache_creation_input_tokens: 1,
        }),
      ),
    ).toBeNull();
  });
  it("projects official model end events without persisting private text", () => {
    const value = extractModelUsageEvent({
      id: "evt_1",
      type: "span.model_request_end",
      processed_at: "2026-09-07T10:00:00Z",
      model_usage: {
        input_tokens: 1,
        output_tokens: 2,
        cache_read_input_tokens: 3,
      },
      content: "private content",
      is_error: true,
    });
    expect(value).toMatchObject({
      id: "evt_1",
      isError: true,
      tokens: { inputTokens: 1n, outputTokens: 2n, cacheReadInputTokens: 3n },
    });
    expect(value).not.toHaveProperty("content");
  });
});
