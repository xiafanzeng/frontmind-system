// @vitest-environment node
import { getTableName } from "drizzle-orm";
import { MySqlDialect } from "drizzle-orm/mysql-core";
import { describe, expect, it, vi } from "vitest";
import { PublishingRepository } from "../../../packages/monitoring-db/src/publisher-repository";
import { PublisherWorkerRepository } from "../../../packages/monitoring-db/src/publisher-worker-repository";
import { KolClient } from "../../../packages/monitoring-provider-kol/src/client";
import { PublisherWorkerProcessor } from "../../../apps/monitoring-worker/src/publishing/processor";

const startedAt = new Date("2026-09-08T01:00:00.000Z");
const boundAt = new Date("2026-09-08T03:00:00.000Z");

function fixture(options: { submittedAt?: Date; missingAttempt?: boolean } = {}) {
  const item = {
    id: "unknown-item",
    ownerId: "owner",
    enterpriseProjectId: "project",
    batchId: "batch",
    status: options.submittedAt ? "action_required" : "submission_unknown",
    attemptCount: 2,
    externalOrderId: null,
    submittedAt: options.submittedAt ?? null,
    fundsStatus: "frozen",
  };
  const candidate = { id: "candidate", itemId: item.id, externalOrderId: "supplier-order" };
  const attempt = { itemId: item.id, ownerId: item.ownerId, attemptNumber: 2, startedAt };
  const writes: Array<{ table: string; values: Record<string, unknown> }> = [];
  const attemptReads: ReturnType<MySqlDialect["sqlToQuery"]>[] = [];
  const db: any = {
    transaction: async (operation: (tx: any) => Promise<unknown>) => operation(db),
    select: () => ({
      from: (table: any) => {
        const name = getTableName(table);
        const rows = name === "publisher_items"
          ? [item]
          : name === "publisher_reconciliation_candidates"
            ? [candidate]
            : name === "publisher_submission_attempts"
              ? options.missingAttempt ? [] : [attempt]
              : [];
        const query: any = {
          where: (clause: any) => {
            if (name === "publisher_submission_attempts")
              attemptReads.push(new MySqlDialect().sqlToQuery(clause));
            return query;
          },
          for: () => query,
          limit: async () => rows,
        };
        return query;
      },
    }),
    update: (table: any) => ({
      set: (values: Record<string, unknown>) => ({
        where: async () => {
          const name = getTableName(table);
          writes.push({ table: name, values });
          if (name === "publisher_items") Object.assign(item, values);
        },
      }),
    }),
    insert: (table: any) => ({
      values: async (values: Record<string, unknown>) => {
        writes.push({ table: getTableName(table), values });
      },
    }),
  };
  return {
    item,
    writes,
    attemptReads,
    repository: new PublishingRepository(db),
    worker: new PublisherWorkerRepository(db),
    bind: () => new PublishingRepository(db).bindPublisherReconciliationCandidate({
      itemId: item.id,
      candidateId: candidate.id,
      actorId: "admin",
      reason: "Verified this exact supplier order",
      boundAt,
    }),
  };
}

describe("UNKNOWN order binding resumes authoritative polling", () => {
  it("uses the recorded current attempt time and GETs the bound order without another POST", async () => {
    const f = fixture();
    expect(await f.worker.getPublisherItemForPolling(f.item.id)).toBeUndefined();
    await f.bind();
    expect(f.item).toMatchObject({
      status: "processing",
      externalOrderId: "supplier-order",
      submittedAt: startedAt,
      fundsStatus: "frozen",
    });
    expect(f.attemptReads[0]?.params).toEqual([f.item.id, f.item.ownerId, 2]);
    expect(f.attemptReads[0]?.sql).toMatch(/attempt_number/u);
    const pollJob = f.writes.find(write => write.table === "publisher_jobs")!.values;
    expect(pollJob).toMatchObject({
      type: "poll_publication_item",
      enterpriseProjectId: "project",
      availableAt: boundAt,
    });

    // Every HTTP request is intercepted; no credentials or live orders are used.
    const fetcher = vi.fn(async (url: RequestInfo | URL, request?: RequestInit) => {
      expect(request?.method).toBe("GET");
      expect(new URL(String(url)).searchParams.get("order_id")).toBe("supplier-order");
      return Response.json({ success: true, status: 200, data: [{
        id: 9, order_id: "supplier-order", resource_id: 42, status: 1,
        response_message: "https://media.invalid/article/9", title: "Test article",
      }] });
    });
    const provider = new KolClient({
      baseUrl: "https://supplier.invalid",
      accessToken: "test-only-token",
      mode: "live",
      realEnabled: true,
      publishEnabled: true,
      fetch: fetcher,
    });
    const createOrder = vi.spyOn(provider, "createOrder");
    const observe = vi.fn(async () => undefined);
    const processor = new PublisherWorkerProcessor({
      repository: {
        getPublisherItemForPolling: f.worker.getPublisherItemForPolling.bind(f.worker),
        applyPublisherOrderObservation: observe,
      } as never,
      provider,
      objectStore: {} as never,
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      now: () => boundAt,
    }, {} as never);
    await processor.handle({
      id: "poll-job",
      type: "poll_publication_item",
      payload: pollJob.payload as Record<string, unknown>,
      attemptCount: 0,
      maxAttempts: 8,
      leasedUntil: new Date(boundAt.valueOf() + 60_000),
    });
    expect(fetcher).toHaveBeenCalledOnce();
    expect(createOrder).not.toHaveBeenCalled();
    expect(observe).toHaveBeenCalledWith(expect.objectContaining({
      itemId: f.item.id,
      providerOrderId: "supplier-order",
      providerStatus: "success",
      publishedUrl: "https://media.invalid/article/9",
    }));
  });

  it("preserves an accepted order's existing timestamp when reconciling its status", async () => {
    const acceptedAt = new Date("2026-09-08T01:00:05.000Z");
    const f = fixture({ submittedAt: acceptedAt, missingAttempt: true });
    await f.bind();
    expect(f.item.submittedAt).toEqual(acceptedAt);
    expect(f.attemptReads).toHaveLength(0);
  });

  it("leaves the UNKNOWN item and funds untouched if submission time evidence is missing", async () => {
    const f = fixture({ missingAttempt: true });
    await expect(f.bind()).rejects.toMatchObject({ code: "CONFLICT" });
    expect(f.item).toMatchObject({ status: "submission_unknown", submittedAt: null, fundsStatus: "frozen" });
    expect(f.writes).toHaveLength(0);
  });
});
