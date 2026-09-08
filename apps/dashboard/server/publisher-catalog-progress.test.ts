// @vitest-environment node
import { getTableName, sql, type SQL } from "drizzle-orm";
import { MySqlDialect } from "drizzle-orm/mysql-core";
import { describe, expect, it } from "vitest";
import { PublishingRepository } from "../../../packages/monitoring-db/src/publisher-repository";

type ProgressRow = {
  runId: string;
  status: string;
  sourceKind: string | null;
  total: number;
  unverifiedTotal: number;
};

function fixture(runIds: string[], progress: ProgressRow[] = []) {
  const reads: Array<{ table: string; fields: Record<string, SQL>; groupSql?: string }> = [];
  const db = {
    select: (fields: Record<string, SQL> = {}) => ({
      from: (table: any) => {
        const read = { table: getTableName(table), fields } as typeof reads[number];
        reads.push(read);
        const query: any = {
          orderBy: () => query,
          limit: async () => runIds.map(id => ({ id })),
          where: () => query,
          groupBy: async (...columns: any[]) => {
            read.groupSql = new MySqlDialect().sqlToQuery(sql.join(columns, sql`, `)).sql;
            return progress;
          },
        };
        return query;
      },
    }),
  };
  return { repository: new PublishingRepository(db as never), reads };
}

describe("catalog Logo progress aggregation", () => {
  it("keeps mixed review and source counts correct without counting manually verified Logos twice", async () => {
    const rows: ProgressRow[] = [
      { runId: "run-a", status: "pending", sourceKind: "logo", total: 3, unverifiedTotal: 0 },
      // Different verification values and per-media audit URLs share one group.
      { runId: "run-a", status: "archived", sourceKind: "logo", total: 5, unverifiedTotal: 2 },
      { runId: "run-a", status: "archived", sourceKind: "icon", total: 4, unverifiedTotal: 1 },
      { runId: "run-a", status: "archived", sourceKind: "site_favicon", total: 2, unverifiedTotal: 0 },
      { runId: "run-a", status: "archived", sourceKind: "web_search_verified", total: 3, unverifiedTotal: 0 },
      { runId: "run-a", status: "archived", sourceKind: "manual_verified", total: 2, unverifiedTotal: 2 },
      { runId: "run-a", status: "archived", sourceKind: "generated_fallback", total: 6, unverifiedTotal: 1 },
      { runId: "run-a", status: "archived", sourceKind: null, total: 1, unverifiedTotal: 1 },
      { runId: "run-a", status: "pending_review", sourceKind: null, total: 2, unverifiedTotal: 2 },
      { runId: "run-a", status: "failed", sourceKind: null, total: 3, unverifiedTotal: 0 },
      { runId: "run-a", status: "missing", sourceKind: null, total: 4, unverifiedTotal: 0 },
      { runId: "run-b", status: "archived", sourceKind: "logo", total: 10, unverifiedTotal: 0 },
    ];
    const f = fixture(["run-a", "run-b", "empty-run"], rows);
    const result = await f.repository.listPublisherMediaSyncRuns();
    expect(result[0]).toMatchObject({
      id: "run-a", total: 35, logoPending: 3, logoArchived: 23, logoFailed: 3,
      logoProviderArchived: 5, logoIconArchived: 4, logoSiteFaviconArchived: 2,
      logoWebSearchVerifiedArchived: 3, logoManualVerifiedArchived: 2,
      logoPendingReview: 7, logoGeneratedFallback: 6, logoMissing: 4,
      logoRealMissing: 21, logoRealCoverageBasisPoints: 4_000,
    });
    expect(result[1]).toMatchObject({
      id: "run-b", total: 10, logoArchived: 10, logoPendingReview: 0,
      logoRealMissing: 0, logoRealCoverageBasisPoints: 10_000,
    });
    expect(result[2]).toMatchObject({
      id: "empty-run", total: 0, logoPendingReview: 0, logoRealCoverageBasisPoints: 0,
    });
  });

  it("groups only by the three indexed scalar dimensions and aggregates the needed JSON flag", async () => {
    const f = fixture(["run"]);
    await f.repository.listPublisherMediaSyncRuns();
    const read = f.reads.find(item => item.table === "publisher_media_logo_resolutions")!;
    expect(Object.keys(read.fields).sort()).toEqual(["runId", "sourceKind", "status", "total", "unverifiedTotal"]);
    expect(read.groupSql).toBe([
      "`publisher_media_logo_resolutions`.`sync_run_id`",
      "`publisher_media_logo_resolutions`.`status`",
      "`publisher_media_logo_resolutions`.`source_kind`",
    ].join(", "));
    const aggregate = new MySqlDialect().sqlToQuery(read.fields.unverifiedTotal!).sql;
    expect(aggregate).toContain("sum(case when JSON_UNQUOTE(JSON_EXTRACT(");
    expect(aggregate).toContain("'$.verification')) = 'unverified' then 1 else 0 end)");
  });

  it("does not scan Logo resolutions when there are no sync records", async () => {
    const f = fixture([]);
    expect(await f.repository.listPublisherMediaSyncRuns()).toEqual([]);
    expect(f.reads.map(read => read.table)).toEqual(["publisher_media_sync_runs"]);
  });
});
