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
  it("accepts recorded names and unassigned owners as distinct filters", () => {
    expect(
      aiUsageReportInput.parse({
        ...filter,
        owner: { kind: "unassigned" },
        state: "failed",
      }),
    ).toMatchObject({ owner: { kind: "unassigned" }, state: "failed" });
    expect(
      aiUsageReportInput.parse({
        ...filter,
        owner: { kind: "name", value: "  负责人甲  " },
      }).owner,
    ).toEqual({ kind: "name", value: "负责人甲" });
    expect(
      aiUsageReportInput.safeParse({
        ...filter,
        owner: { kind: "name", value: "   " },
      }).success,
    ).toBe(false);
    expect(aiUsageReportInput.safeParse({ ...filter, state: "" }).success).toBe(
      false,
    );
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
    expect(calls).toHaveLength(4);
    for (const call of calls) {
      expect(call.sql).toContain("e.occurred_at >=");
      expect(call.sql).not.toContain("o.created_at");
      expect(call.params).toContainEqual(new Date("2026-09-06T16:00:00Z"));
    }
  });
  it.each([
    { kind: "unassigned" as const },
    { kind: "name" as const, value: "负责人 O'Neil" },
  ])(
    "uses identical owner/state filters for summary, tasks and CSV: $kind",
    async (owner) => {
      const dialect = new MySqlDialect();
      const calls: ReturnType<typeof dialect.sqlToQuery>[] = [];
      const db = {
        execute: vi.fn(async (statement) => {
          calls.push(dialect.sqlToQuery(statement));
          return [[]];
        }),
      };
      const input = aiUsageReportInput.parse({
        ...filter,
        fingerprint: "fp_1234567890abcdef",
        model: "glm-5.3",
        owner,
        state: "failed",
        page: 3,
      });
      await readAiUsageReport(input, db);
      await exportAiUsageReport(input, db);

      const summary = calls.find((call) =>
        call.sql.includes("COUNT(DISTINCT"),
      )!;
      const tasks = calls.find((call) => call.sql.includes("GROUP BY"))!;
      const exported = calls.find((call) => call.sql.includes(" AS taskId"))!;
      const whereClause = (query: typeof summary) =>
        query.sql
          .match(/\bWHERE\s+([\s\S]*?)(?=\s+GROUP BY|\s+ORDER BY|$)/)![1]!
          .replace(/\s+/g, " ")
          .trim();
      expect(whereClause(tasks)).toBe(whereClause(summary));
      expect(whereClause(exported)).toBe(whereClause(summary));
      const recordedOwner =
        "COALESCE(NULLIF(TRIM(w.business_owner_name),''),NULLIF(TRIM(u.displayName),''),NULLIF(TRIM(u.username),''))";
      expect(whereClause(summary)).toContain(
        `${recordedOwner}${owner.kind === "unassigned" ? " IS NULL" : "=?"}`,
      );
      expect(whereClause(summary)).toContain("t.provider_state=?");
      const params = [
        new Date("2026-09-06T16:00:00Z"),
        new Date("2026-09-07T16:00:00Z"),
        "website_frontend",
        input.fingerprint,
        "glm-5.3",
        ...(owner.kind === "name" ? [owner.value] : []),
        "failed",
      ];
      expect(summary.params).toEqual(params);
      expect(tasks.params).toEqual([...params, 20, 40]);
      expect(exported.params).toEqual([...params, 50001]);
      if (owner.kind === "name") expect(summary.sql).not.toContain(owner.value);

      const options = calls.filter((call) =>
        call.sql.includes("SELECT DISTINCT"),
      );
      expect(options.length).toBeGreaterThanOrEqual(3);
      for (const option of options) {
        expect(option.params).toEqual(params.slice(0, 2));
        expect(whereClause(option)).not.toContain("t.provider_state");
        expect(whereClause(option)).not.toContain(recordedOwner);
      }
    },
  );
  it("keeps actual owner and provider-state choices available across a narrowed report", async () => {
    const dialect = new MySqlDialect();
    const db = {
      execute: vi.fn(async (statement) => {
        const query = dialect.sqlToQuery(statement);
        if (
          query.sql.includes("SELECT DISTINCT") &&
          query.sql.includes(" AS owner")
        ) {
          return [
            [
              { owner: "负责人甲", state: "succeeded" },
              { owner: "负责人甲", state: "running" },
              { owner: "负责人乙", state: "running" },
              { owner: null, state: "failed" },
            ],
          ];
        }
        return [[]];
      }),
    };
    const report = await readAiUsageReport(
      aiUsageReportInput.parse({
        ...filter,
        owner: { kind: "name", value: "负责人甲" },
        state: "succeeded",
      }),
      db,
    );
    expect(report.tasks).toEqual([]);
    expect(report.owners).toHaveLength(2);
    expect(report.owners).toEqual(
      expect.arrayContaining(["负责人甲", "负责人乙"]),
    );
    expect(report.states).toHaveLength(3);
    expect(report.states).toEqual(
      expect.arrayContaining(["succeeded", "running", "failed"]),
    );
  });
  it("exports identifiers and exact prices while preventing spreadsheet formulas", async () => {
    const db = {
      execute: vi.fn(async () => [
        [
          {
            occurredAt: new Date("2026-09-07T01:00:00Z"),
            owner: "=WEBSERVICE(1)",
            title: '报"告',
            state: "failed",
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
    const cells = (line: string) =>
      line
        .match(/"(?:[^"]|"")*"/g)!
        .map((cell) => cell.slice(1, -1).replace(/""/g, '"'));
    const [header, row] = result.csv.split("\r\n").map(cells);
    expect(row).toHaveLength(header!.length);
    expect(row![header!.indexOf("任务状态")]).toBe("failed");
    expect(row![header!.indexOf("任务ID")]).toBe("task_1");
    expect(row![header!.indexOf("Event ID")]).toBe("event_1");
    expect(aiUsageCsvCell(" @command")).toBe('"\' @command"');
    expect(providerKeyIdMask("abcd1234.secret-fixture")).toBe("abcd...1234");
    expect(providerKeyIdMask("opaque-secret-fixture")).toBeNull();
  });
});
