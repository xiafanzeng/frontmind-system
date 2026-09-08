import { afterEach, describe, expect, it, vi } from "vitest";
import { MySqlDialect } from "drizzle-orm/mysql-core";
import { aiUsageTaskEventsInput } from "../shared/ai-usage-report";
import { readAiUsageReport, readAiUsageTaskEvents } from "./ai-usage-report";
import * as databaseModule from "./db";

const base = {
  from: "2026-09-07",
  to: "2026-09-07",
  scope: "website_frontend" as const,
  taskId: "task-usage-events",
};
const dialect = new MySqlDialect();
type CompiledQuery = ReturnType<typeof dialect.sqlToQuery>;
const whereClause = (statement: CompiledQuery) =>
  statement.sql.match(/\bWHERE\s+([\s\S]*?)(?=\s+GROUP BY|\s+ORDER BY|$)/)![1]!
    .replace(/\s+/g, " ")
    .trim();

afterEach(() => vi.restoreAllMocks());

describe("AI task usage event pagination", () => {
  it("validates page and task boundaries while retaining report date validation", () => {
    expect(aiUsageTaskEventsInput.parse(base).eventPage).toBe(1);
    expect(aiUsageTaskEventsInput.parse({ ...base, eventPage: 100000 }).eventPage).toBe(100000);
    for (const eventPage of [0, -1, 1.5, 100001]) {
      expect(aiUsageTaskEventsInput.safeParse({ ...base, eventPage }).success).toBe(false);
    }
    for (const taskId of ["", "x".repeat(129)]) {
      expect(aiUsageTaskEventsInput.safeParse({ ...base, taskId }).success).toBe(false);
    }
    expect(aiUsageTaskEventsInput.safeParse({ ...base, from: "2026-02-30" }).success).toBe(false);
    expect(aiUsageTaskEventsInput.safeParse({ ...base, to: "2028-01-01" }).success).toBe(false);
  });

  it("pages beyond 20 native events and preserves unknown costs and exact counters", async () => {
    const calls: CompiledQuery[] = [];
    const rows = Array.from({ length: 23 }, (_, index) => ({
      id: `local-${index}`,
      eventId: `event-${index}`,
      sessionId: "session-1",
      occurredAt: new Date("2026-09-07T01:00:00Z"),
      recordedAt: new Date("2026-09-07T01:01:00Z"),
      model: "glm-5.3",
      effort: "high",
      inputTokens: "9007199254740993",
      outputTokens: "21",
      cacheReadInputTokens: "34",
      costNanos: index === 20 ? null : "136001",
      chargedUnits: "1",
      costState: index === 20 ? "unknown" : "calculated",
      isError: index === 20 ? 1 : "0",
      syncIssue: index === 20 ? "usage pending" : null,
      pricingVersion: index === 20 ? null : "glm-5.3-test",
    }));
    const db = {
      execute: vi.fn(async (statement) => {
        const compiled = dialect.sqlToQuery(statement);
        calls.push(compiled);
        if (compiled.sql.includes("COUNT(*)")) return [[{ totalEvents: 23 }]];
        const [limit, offset] = compiled.params.slice(-2).map(Number);
        return [rows.slice(offset, offset! + limit!)];
      }),
    };
    const first = await readAiUsageTaskEvents(aiUsageTaskEventsInput.parse(base), db);
    const second = await readAiUsageTaskEvents(aiUsageTaskEventsInput.parse({ ...base, eventPage: 2 }), db);
    expect(first.events).toHaveLength(20);
    expect(second).toMatchObject({ taskId: base.taskId, eventPage: 2, pageSize: 20, totalEvents: 23 });
    expect(second.events).toHaveLength(3);
    expect(second.events[0]).toEqual({
      id: "local-20", eventId: "event-20", sessionId: "session-1",
      occurredAt: Date.parse("2026-09-07T01:00:00Z"),
      recordedAt: Date.parse("2026-09-07T01:01:00Z"),
      model: "glm-5.3", effort: "high", inputTokens: "9007199254740993",
      outputTokens: "21", cacheReadInputTokens: "34", costCny: null,
      chargedCny: "0.000100", costState: "unknown", isError: true,
      syncIssue: "usage pending", pricingVersion: "",
    });
    expect(second.events[1]).toMatchObject({ costCny: "0.000136", isError: false, syncIssue: null });
    const paged = calls.filter((call) => call.sql.includes("LIMIT"));
    expect(paged.map((call) => call.params.slice(-2))).toEqual([[20, 0], [20, 20]]);
    for (const call of paged) {
      expect(call.sql).toContain("ORDER BY e.occurred_at ASC,e.id ASC");
      expect(call.sql).toContain("sync.last_error AS syncIssue");
      expect(call.sql).not.toContain("ai_usage_snapshots");
    }
  });

  it.each([
    { kind: "name" as const, value: "负责人 O'Neil" },
    { kind: "unassigned" as const },
  ])("uses the report WHERE plus a parameterized task ID for count and event rows: $kind", async (owner) => {
    const calls: CompiledQuery[] = [];
    const db = {
      execute: vi.fn(async (statement) => {
        calls.push(dialect.sqlToQuery(statement));
        return [[]];
      }),
    };
    const input = aiUsageTaskEventsInput.parse({
      ...base,
      taskId: "task-'quoted'",
      fingerprint: "fp_1234567890abcdef",
      model: "glm-5.3",
      owner,
      state: "failed",
      eventPage: 100000,
    });
    await readAiUsageReport(input, db);
    const reportSummary = calls.find((call) => call.sql.includes("COUNT(DISTINCT"))!;
    calls.length = 0;
    const result = await readAiUsageTaskEvents(input, db);
    expect(result.totalEvents).toBe(0);
    expect(result.events).toEqual([]);
    expect(calls).toHaveLength(2);
    expect(whereClause(calls[0]!)).toBe(`${whereClause(reportSummary)} AND e.local_task_id=?`);
    expect(whereClause(calls[1]!)).toBe(whereClause(calls[0]!));
    expect(calls[0]!.params).toEqual([...reportSummary.params, input.taskId]);
    expect(calls[1]!.params).toEqual([...reportSummary.params, input.taskId, 20, 1999980]);
    for (const call of calls) {
      expect(call.sql).not.toContain(input.taskId);
      expect(call.params.slice(0, 2)).toEqual([
        new Date("2026-09-06T16:00:00Z"),
        new Date("2026-09-07T16:00:00Z"),
      ]);
    }
  });

  it("reads count and rows using the same transaction when no test executor is supplied", async () => {
    const tx = { execute: vi.fn(async () => [[]]) };
    const db = {
      execute: vi.fn(),
      transaction: vi.fn(async (run: (executor: typeof tx) => Promise<unknown>) => run(tx)),
    };
    vi.spyOn(databaseModule, "getDb").mockResolvedValue(db as never);
    const result = await readAiUsageTaskEvents(aiUsageTaskEventsInput.parse(base));
    expect(result.totalEvents).toBe(0);
    expect(db.transaction).toHaveBeenCalledOnce();
    expect(db.execute).not.toHaveBeenCalled();
    expect(tx.execute).toHaveBeenCalledTimes(2);
  });
});
