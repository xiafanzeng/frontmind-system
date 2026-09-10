import { describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ getDb: vi.fn() }));
vi.mock("./db", () => ({ getDb: mocks.getDb }));
import { persistKnowledgeBaseExecution, persistKnowledgeBaseStage } from "./knowledge-base-execution";
import { projectGeneralExecution } from "./frontmind-general-execution";
function database(rows: unknown[][]) {
  const writes: any[] = [];
  const db: any = { transaction: (action: any) => action(db), select: () => {
    const value = rows.shift() ?? [];
    const chain: any = { then: (resolve: any) => Promise.resolve(value).then(resolve) };
    for (const method of ["from", "where", "limit", "for", "innerJoin"]) chain[method] = () => chain;
    return chain;
  }, insert: () => ({ values: (value: any) => { writes.push(value); return { onDuplicateKeyUpdate: vi.fn().mockResolvedValue(undefined) }; } }) };
  return { db, writes };
}
const scope = { userId: 7, buildId: "build", generation: 2, turnId: "turn" };
describe("knowledge execution persistence", () => {
  it("ignores late events after reset or when the active generation/turn no longer matches", async () => {
    const { db, writes } = database([[]]); mocks.getDb.mockResolvedValue(db);
    await persistKnowledgeBaseExecution({ ...scope, events: [{ id: "old", type: "execution_activity", timestamp: 1, executionActivity: { kind: "status", status: "running" } }] });
    expect(writes).toEqual([]);
  });
  it("persists only public activity and gives tools and results the same turn-qualified identity", async () => {
    const { db, writes } = database([[{ id: "build", executionMode: "materialized_bundle_v1" }], [{ id: "turn", sequence: 2, messageId: "user" }]]); mocks.getDb.mockResolvedValue(db);
    await persistKnowledgeBaseExecution({ ...scope, events: [
      { id: "call", type: "execution_activity", timestamp: 1000, providerOriginalRank: 0, executionActivity: { kind: "tool_use", toolKind: "builtin", label: "搜索网页", input: "secret-input" } as any },
      { id: "result", type: "execution_activity", timestamp: 2000, providerOriginalRank: 1, executionActivity: { kind: "tool_result", callId: "call", isError: false, content: "private-payload" } as any },
      { id: "thought", type: "execution_activity", timestamp: 2000, providerOriginalRank: 2, executionActivity: { kind: "status", status: "thinking", thinkingText: "private-reasoning" } },
    ] });
    expect(JSON.stringify(writes)).not.toMatch(/secret-input|private-payload|private-reasoning/);
    const execution = projectGeneralExecution("build", writes);
    expect(execution.timeline[0]).toMatchObject({ kind: "tool", status: "completed" });
    expect(execution.timeline.every(event => event.turnId === "turn")).toBe(true);
  });
  it("does not record local stages for retired builds", async () => {
    const { db, writes } = database([[{ id: "build", mode: "reset_retired" }]]); mocks.getDb.mockResolvedValue(db);
    await persistKnowledgeBaseStage({ ...scope, phase: "researching", rank: 0 });
    expect(writes).toHaveLength(0);
  });
});
