import { describe, expect, it } from "vitest";
import { agentCostDisplay } from "./agent-cost";
describe("agent cost display", () => {
  it("distinguishes unobserved cost from zero and partial coverage", () => {
    expect(agentCostDisplay(undefined)).toBe("待核算");
    expect(agentCostDisplay({ costCny: "0.000000", costStatus: "complete" })).toBe("¥0.00");
    expect(agentCostDisplay({ costCny: "1.365596", costStatus: "partial" })).toBe("¥1.365596（部分）");
  });
  it("does not present malformed upstream amounts as money", () => {
    expect(agentCostDisplay({ costCny: "NaN" })).toBe("待核算");
  });
});
