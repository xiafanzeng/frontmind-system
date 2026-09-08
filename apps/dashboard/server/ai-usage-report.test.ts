import { describe, expect, it, vi } from "vitest";
import { MySqlDialect } from "drizzle-orm/mysql-core";
import {
  aiUsageReportInput,
  aiUsageReportWindow,
} from "../shared/ai-usage-report";
import {
  aiUsageCsvCell,
  exportAiUsageReport,
  providerKeyIdMask,
  readAiUsageReport,
} from "./ai-usage-report";
import { projectAiCostTotals } from "./ai-billing-service";

const filter = aiUsageReportInput.parse({
  from: "2026-09-07",
  to: "2026-09-07",
  scope: "website_frontend",
});
describe("AI usage reconciliation", () => {
  it("uses exact Beijing day boundaries and rejects invalid or excessive date windows", () => {
    expect(aiUsageReportWindow(filter)).toEqual({
      startAt: Date.parse("2026-09-06T16:00:00Z"),
      endAt: Date.parse("2026-09-07T16:00:00Z"),
    });
    expect(
      aiUsageReportInput.safeParse({ ...filter, from: "2026-02-30" }).success,
    ).toBe(false);
    expect(
      aiUsageReportInput.safeParse({ ...filter, to: "2025-01-01" }).success,
    ).toBe(false);
    expect(
      aiUsageReportInput.safeParse({ ...filter, to: "2028-01-01" }).success,
    ).toBe(false);
  });
  it("keeps per-account tokens and money on the same events including failed and incomplete usage", () => {
    const result = projectAiCostTotals([
      {
        accountUserId: 1,
        localTaskId: "old-session-continued-today",
        costNanos: 1365596000n,
        inputTokens: 49010n,
        outputTokens: 5173n,
        cacheReadInputTokens: 414336n,
      },
      {
        accountUserId: 1,
        localTaskId: "unknown",
        costNanos: null,
        inputTokens: 20n,
      },
      {
        accountUserId: 2,
        localTaskId: "other-account",
        costNanos: 8000n,
        inputTokens: 1n,
      },
    ]);
    expect(result.get(1)).toMatchObject({
      inputTokens: 49030,
      outputTokens: 5173,
      cacheReadInputTokens: 414336,
      observedTasks: 2,
      unknownEvents: 1,
      costCny: "1.365596",
      costStatus: "partial",
    });
    expect(result.get(2)).toMatchObject({
      costCny: "0.000008",
      inputTokens: 1,
    });
  });
  it("queries event timestamps for summary, rows and key choices without task creation filtering", async () => {
    const dialect = new MySqlDialect();
    const calls: ReturnType<typeof dialect.sqlToQuery>[] = [];
    const db = {
      execute: vi.fn(async (statement) => {
        const query = dialect.sqlToQuery(statement);
        calls.push(query);
        if (query.sql.includes("COUNT(DISTINCT"))
          return [
            [
              {
                observedEvents: 1,
                observedTasks: 1,
                knownEvents: 1,
                unknownEvents: 0,
                inputTokens: "10",
                outputTokens: "2",
                cacheReadInputTokens: "0",
                costNanos: "136000",
                chargedUnits: "0",
              },
            ],
          ];
        if (query.sql.includes("SELECT DISTINCT")) return [[]];
        return [
          [
            {
              id: "website-task",
              sessionId: "sess_1",
              scope: "website_frontend",
              title: "报告",
              businessOwnerName: "负责人甲",
              state: "succeeded",
              knownEvents: 1,
              observedEvents: 1,
              unknownEvents: 0,
              costNanos: "136000",
              chargedUnits: "0",
              inputTokens: "10",
              outputTokens: "2",
              cacheReadInputTokens: "0",
              credentialVersion: 9,
              model: "glm-5.3",
              firstEventAt: new Date("2026-09-07T01:00:00Z"),
              lastEventAt: new Date("2026-09-07T01:00:00Z"),
            },
          ],
        ];
      }),
    };
    const report = await readAiUsageReport(filter, db);
    expect(report.summary.costCny).toBe("0.000136");
    expect(report.tasks[0]).toMatchObject({
      businessOwnerName: "负责人甲",
      chargedCny: "0.000000",
      inputTokens: "10",
      credentialVersion: 9,
    });
    expect(calls).toHaveLength(3);
    for (const call of calls) {
      expect(call.sql).toContain("e.occurred_at >=");
      expect(call.sql).not.toContain("o.created_at");
      expect(call.params).toContainEqual(new Date("2026-09-06T16:00:00Z"));
    }
  });
  it("exports identifiers and exact prices while preventing spreadsheet formulas", async () => {
    const db = {
      execute: vi.fn(async () => [
        [
          {
            occurredAt: new Date("2026-09-07T01:00:00Z"),
            owner: "=WEBSERVICE(1)",
            title: '报"告',
            taskId: "task_1",
            eventId: "event_1",
            inputTokens: "1",
            outputTokens: "0",
            cacheTokens: "0",
            costNanos: "8000",
            chargedUnits: "0",
          },
        ],
      ]),
    };
    const result = await exportAiUsageReport(filter, db);
    expect(result.csv).toContain("2026-09-07 09:00:00.000 +08:00");
    expect(result.csv).toContain("' =".replace(" ", "") + "WEBSERVICE(1)");
    expect(result.csv).toContain('"报""告"');
    expect(result.csv).toContain('"0.000008"');
    expect(aiUsageCsvCell(" @command")).toBe('"\' @command"');
    expect(providerKeyIdMask("abcd1234.secret-fixture")).toBe("abcd...1234");
    expect(providerKeyIdMask("opaque-secret-fixture")).toBeNull();
  });
});
