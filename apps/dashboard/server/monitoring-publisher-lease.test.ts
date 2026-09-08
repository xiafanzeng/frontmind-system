// @vitest-environment node
import { MySqlDialect } from "drizzle-orm/mysql-core";
import { describe, expect, it } from "vitest";
import { PublisherWorkerRepository } from "../../../packages/monitoring-db/src/publisher-worker-repository";
import type { PublisherJobType } from "../../../apps/monitoring-worker/src/publishing/job-types";

const now = new Date("2026-09-08T08:00:00.000Z");
const allTypes: PublisherJobType[] = ["submit_publication_item", "poll_publication_item", "reconcile_publication_unknown", "sync_kol_catalog", "import_docx", "purge_publisher_assets", "archive_publisher_media_logo"];
type Row = ReturnType<typeof job>;
function job(id: string, type: PublisherJobType, age = 0, status = "ready") {
  return { id, type, status, payload: {}, attempts: 0, maxAttempts: 3,
    availableAt: new Date(now.valueOf() - age), createdAt: new Date(now.valueOf() - age),
    leaseExpiresAt: status === "leased" ? new Date(now.valueOf() - 1) : null,
    leaseOwner: null as string | null, locked: false };
}
function fixture(rows: Row[]) {
  const dialect = new MySqlDialect();
  const reads: Array<{ index: string; sql: string; params: unknown[]; order: string; limit: number; lock: unknown }> = [];
  const writes: Array<{ values: Record<string, unknown>; ids: unknown[] }> = [];
  const db: any = {
    transaction: async (run: (tx: any) => unknown) => run(db),
    select: () => {
      const read = { index: "", sql: "", params: [] as unknown[], order: "", limit: 0, lock: undefined as unknown };
      const q: any = {
        from: (_table: unknown, options: { forceIndex: string }) => { read.index = options.forceIndex; return q; },
        where: (where: any) => { Object.assign(read, dialect.sqlToQuery(where)); return q; },
        orderBy: (...order: any[]) => { read.order = order.map(x => dialect.sqlToQuery(x).sql).join(", "); return q; },
        limit: (limit: number) => { read.limit = limit; return q; },
        for: async (mode: string, lock: unknown) => {
          read.lock = { mode, ...lock as object }; reads.push(read);
          const types = allTypes.filter(t => read.params.includes(t));
          const statuses = ["ready", "retry_wait", "leased"].filter(t => read.params.includes(t));
          return rows.filter(r => types.includes(r.type) && statuses.includes(r.status) && !r.locked && r.attempts < r.maxAttempts
            && (r.status === "leased" ? Boolean(r.leaseExpiresAt && r.leaseExpiresAt <= now) : r.availableAt <= now))
            .sort((a, b) => a.availableAt.valueOf() - b.availableAt.valueOf() || a.createdAt.valueOf() - b.createdAt.valueOf())
            .slice(0, read.limit);
        },
      };
      return q;
    },
    update: () => ({ set: (values: Record<string, unknown>) => ({ where: async (where: any) => {
      const ids = dialect.sqlToQuery(where).params;
      writes.push({ values, ids });
      for (const r of rows) if (ids.includes(r.id)) Object.assign(r, values);
    } }) }),
  };
  return { reads, writes, lease: (options: { limit?: number; allowedTypes?: PublisherJobType[] } = {}) =>
    new PublisherWorkerRepository(db).leasePublisherJobs({ workerId: "claim-test", now, leaseMs: 60_000, limit: options.limit ?? 1, ...options }) };
}

describe("indexed publisher queue claims", () => {
  it("keeps orders ahead of an older sync/import/Logo backlog and skips locked orders", async () => {
    const locked = job("locked-order", "submit_publication_item", 80_000); locked.locked = true;
    const f = fixture([job("old-logo", "archive_publisher_media_logo", 900_000), job("sync", "sync_kol_catalog", 90_000),
      job("import", "import_docx", 100_000), job("poll", "poll_publication_item", 20_000), locked, job("submit", "submit_publication_item", 40_000)]);
    expect((await f.lease({ limit: 2 })).map(r => r.id)).toEqual(["submit", "poll"]);
    expect(f.reads).toHaveLength(1);
    expect(f.reads[0]).toMatchObject({ index: "pub_jobs_type_aggregate_idx", lock: { mode: "update", skipLocked: true } });
    expect(f.reads[0]!.order).toContain("created_at");
    expect(f.writes[0]).toMatchObject({ values: { status: "leased", leaseOwner: "claim-test", leaseExpiresAt: new Date(now.valueOf() + 60_000) } });
  });

  it("honors the scheduler's allowedTypes and only fills remaining capacity in later priority groups", async () => {
    const f = fixture([job("order", "submit_publication_item"), job("sync", "sync_kol_catalog"), job("logo", "archive_publisher_media_logo")]);
    const result = await f.lease({ limit: 2, allowedTypes: ["sync_kol_catalog", "archive_publisher_media_logo"] });
    expect(result.map(r => r.id)).toEqual(["sync", "logo"]);
    expect(f.reads.every(r => !r.params.includes("submit_publication_item"))).toBe(true);
    expect(f.reads.slice(1).every(r => r.limit === 1)).toBe(true);
  });

  it("merges due ready, retry and expired leases through narrow Logo index ranges", async () => {
    const future = job("future", "archive_publisher_media_logo", -1);
    const paused = job("superseded", "archive_publisher_media_logo", 900_000, "paused");
    const exhausted = job("exhausted", "archive_publisher_media_logo", 900_000); exhausted.attempts = 3;
    const leased = job("unexpired", "archive_publisher_media_logo", 900_000, "leased"); leased.leaseExpiresAt = new Date(now.valueOf() + 50_000);
    const f = fixture([job("ready", "archive_publisher_media_logo", 20_000), job("retry", "archive_publisher_media_logo", 40_000, "retry_wait"),
      job("expired", "archive_publisher_media_logo", 30_000, "leased"), future, paused, exhausted, leased]);
    expect((await f.lease({ limit: 2, allowedTypes: ["archive_publisher_media_logo"] })).map(r => r.id)).toEqual(["retry", "expired"]);
    expect(f.reads).toHaveLength(3);
    for (const read of f.reads) {
      expect(read).toMatchObject({ index: "pub_jobs_claim_idx", lock: { mode: "update", skipLocked: true } });
      expect(read.sql).not.toMatch(/\bor\b/iu);
      expect(read.sql).toMatch(/attempts.*<.*max_attempts/u);
      expect(read.order).toContain("available_at");
      expect(read.order).toContain("lease_expires_at");
      expect(read.order).not.toMatch(/case|created_at/iu);
    }
    expect(f.writes[0]!.ids).toEqual(["retry", "expired"]);
  });

  it("does not reclaim an active lease or write when no eligible type has work", async () => {
    const f = fixture([job("logo", "archive_publisher_media_logo")]);
    expect(await f.lease({ allowedTypes: [] })).toEqual([]);
    expect(f.reads).toHaveLength(0);
    expect((await f.lease({ allowedTypes: ["archive_publisher_media_logo"] })).map(r => r.id)).toEqual(["logo"]);
    expect(await f.lease({ allowedTypes: ["archive_publisher_media_logo"] })).toEqual([]);
    expect(f.writes).toHaveLength(1);
  });
});
