import { describe, expect, it } from "vitest";
import { projectBrandQuestionExecution } from "./brand-question-execution";
describe("question optimization execution", () => {
  it("keeps provider tools in their own rounds, deduplicates refreshes and omits raw prompts/results", () => {
    const one = { id: "call", type: "execution_activity", timestamp: 2000, providerOriginalRank: 1, executionActivity: { kind: "tool_use", label: "搜索网页", toolKind: "builtin", input: "private" } } as any;
    const result = projectBrandQuestionExecution({ taskId: "task", createdAt: 1000, updatedAt: 4000, status: "succeeded", events: [one, one,
      { id: "result", type: "execution_activity", timestamp: 3000, providerOriginalRank: 2, executionActivity: { kind: "tool_result", callId: "call", isError: true } },
    ] });
    expect(result.timeline.filter(event => event.kind === "tool")).toHaveLength(1);
    expect(result.timeline.find(event => event.kind === "tool")).toMatchObject({ status: "failed" });
    expect(result.timeline.at(-1)).toMatchObject({ phase: "generating_result", status: "ended" });
    expect(JSON.stringify(result)).not.toContain("private");
  });
});
