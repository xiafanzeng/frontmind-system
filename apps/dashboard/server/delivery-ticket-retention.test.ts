import { afterEach, describe, expect, it, vi } from "vitest";

import {
  DELIVERY_TICKET_RETENTION_LOCK_NAME,
  buildDeliveryTicketRetentionFacts,
  deliveryTicketRetentionAffectedRows,
  getDeliveryTicketRetentionCutoff,
  isDeliveryTicketRetentionEligible,
  runDeliveryTicketRetentionCleanup,
  startDeliveryTicketRetentionScheduler,
  type DeliveryTicketRetentionResult,
} from "./delivery-ticket-retention";

const DAY_MS = 24 * 60 * 60 * 1_000;

function retentionResult(): DeliveryTicketRetentionResult {
  return {
    cutoff: new Date("2026-07-03T08:30:00.000Z"),
    batches: 1,
    tickets: 2,
    milestones: 1,
    quotaFacts: 2,
    styleBatches: 0,
    redirectPreviews: 0,
    resetRequests: 0,
  };
}

describe("delivery ticket retention", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("calculates an exact 30-day cutoff and rejects invalid retention days", () => {
    const now = new Date("2026-08-02T08:30:00.000Z");

    const cutoff = getDeliveryTicketRetentionCutoff(30, now);

    expect(cutoff.toISOString()).toBe("2026-07-03T08:30:00.000Z");
    expect(now.getTime() - cutoff.getTime()).toBe(30 * DAY_MS);
    expect(() => getDeliveryTicketRetentionCutoff(0, now)).toThrow(
      "工单保留天数必须是大于 0 的整数",
    );
    expect(() => getDeliveryTicketRetentionCutoff(-1, now)).toThrow(
      "工单保留天数必须是大于 0 的整数",
    );
    expect(() => getDeliveryTicketRetentionCutoff(1.5, now)).toThrow(
      "工单保留天数必须是大于 0 的整数",
    );
    expect(() => getDeliveryTicketRetentionCutoff(Number.NaN, now)).toThrow(
      "工单保留天数必须是大于 0 的整数",
    );
  });

  it("only makes terminal tickets older than the cutoff eligible", () => {
    const cutoff = new Date("2026-07-03T08:30:00.000Z");

    expect(
      isDeliveryTicketRetentionEligible(
        { status: "completed", resolvedAt: new Date(cutoff.getTime() - 1) },
        cutoff,
      ),
    ).toBe(true);
    expect(
      isDeliveryTicketRetentionEligible(
        { status: "completed", resolvedAt: new Date(cutoff) },
        cutoff,
      ),
    ).toBe(false);
    expect(
      isDeliveryTicketRetentionEligible(
        { status: "in_progress", resolvedAt: new Date(cutoff.getTime() - 1) },
        cutoff,
      ),
    ).toBe(false);
    expect(
      isDeliveryTicketRetentionEligible(
        { status: "cancelled", resolvedAt: null },
        cutoff,
      ),
    ).toBe(false);
    expect(
      isDeliveryTicketRetentionEligible(
        {
          status: "rejected",
          resolvedAt: null,
          updatedAt: new Date(cutoff.getTime() - 1),
        },
        cutoff,
      ),
    ).toBe(true);
  });

  it("reads affected row counts from direct and mysql2 tuple results", () => {
    expect(deliveryTicketRetentionAffectedRows({ rowsAffected: 2 })).toBe(2);
    expect(deliveryTicketRetentionAffectedRows([{ affectedRows: 3 }, []])).toBe(
      3,
    );
  });

  it("aggregates used quota and merges completed workflow milestones", () => {
    const facts = buildDeliveryTicketRetentionFacts([
      {
        id: "ticket-1",
        userId: 7,
        quotaPeriodId: "period-b",
        quotaPool: "content_asset_publish",
        quotaState: "consumed",
        status: "completed",
        operation: "content_asset_publish",
        contentAssetIds: ["asset-a", " asset-b ", "asset-a", ""],
        resolvedAt: new Date("2026-06-01T00:00:00.000Z"),
      },
      {
        id: "ticket-2",
        userId: 7,
        quotaPeriodId: "period-b",
        quotaPool: "content_asset_publish",
        quotaState: "consumed",
        status: "completed",
        operation: "content_asset_publish",
        contentAssetIds: ["asset-b", "asset-c"],
        resolvedAt: new Date("2026-06-03T00:00:00.000Z"),
      },
      {
        id: "ticket-3",
        userId: 7,
        quotaPeriodId: "period-b",
        quotaPool: "website_content_publish",
        quotaState: "consumed",
        status: "rejected",
        operation: "website_content_publish",
        contentAssetIds: ["must-not-be-archived-as-a-milestone"],
        resolvedAt: new Date("2026-06-04T00:00:00.000Z"),
      },
      {
        id: "ticket-4",
        userId: 7,
        quotaPeriodId: "period-a",
        quotaPool: null,
        quotaState: "released",
        status: "completed",
        operation: "question_catalog",
        contentAssetIds: [],
        resolvedAt: new Date("2026-06-02T00:00:00.000Z"),
      },
      {
        id: "ticket-5",
        userId: 8,
        quotaPeriodId: "period-a",
        quotaPool: "website_content_publish",
        quotaState: "reserved",
        status: "completed",
        operation: null,
        contentAssetIds: [],
        resolvedAt: new Date("2026-06-02T00:00:00.000Z"),
      },
    ] as any);

    expect(facts.quotaDeltas).toEqual([
      {
        quotaPeriodId: "period-a",
        quotaPool: "website_content_publish",
        count: 1,
      },
      {
        quotaPeriodId: "period-b",
        quotaPool: "content_asset_publish",
        count: 2,
      },
      {
        quotaPeriodId: "period-b",
        quotaPool: "website_content_publish",
        count: 1,
      },
    ]);
    expect(facts.milestones).toEqual([
      {
        userId: 7,
        operation: "content_asset_publish",
        contentAssetIds: ["asset-a", "asset-b", "asset-c"],
        completedAt: new Date("2026-06-03T00:00:00.000Z"),
      },
      {
        userId: 7,
        operation: "question_catalog",
        contentAssetIds: [],
        completedAt: new Date("2026-06-02T00:00:00.000Z"),
      },
    ]);
  });

  it("skips cleanup and closes the connection when the MySQL lock is busy", async () => {
    const query = vi.fn().mockResolvedValue([[{ acquired: 0 }], {}]);
    const end = vi.fn().mockResolvedValue(undefined);
    const cleanup = vi.fn();

    await expect(
      runDeliveryTicketRetentionCleanup({
        databaseUrl: "mysql://retention.test/database",
        createConnection: async () => ({ query, end }) as any,
        cleanup,
      }),
    ).resolves.toEqual({ acquired: false, result: null });

    expect(query).toHaveBeenCalledTimes(1);
    expect(query).toHaveBeenCalledWith("SELECT GET_LOCK(?, 0) AS acquired", [
      DELIVERY_TICKET_RETENTION_LOCK_NAME,
    ]);
    expect(cleanup).not.toHaveBeenCalled();
    expect(end).toHaveBeenCalledTimes(1);
  });

  it("runs cleanup under the MySQL lock, releases it, and closes the connection", async () => {
    const query = vi
      .fn()
      .mockResolvedValueOnce([[{ acquired: 1 }], {}])
      .mockResolvedValueOnce([[{ released: 1 }], {}]);
    const end = vi.fn().mockResolvedValue(undefined);
    const result = retentionResult();
    const cleanup = vi.fn().mockResolvedValue(result);

    await expect(
      runDeliveryTicketRetentionCleanup({
        databaseUrl: "mysql://retention.test/database",
        createConnection: async () => ({ query, end }) as any,
        cleanup,
      }),
    ).resolves.toEqual({ acquired: true, result });

    expect(cleanup).toHaveBeenCalledTimes(1);
    expect(query).toHaveBeenNthCalledWith(
      2,
      "SELECT RELEASE_LOCK(?) AS released",
      [DELIVERY_TICKET_RETENTION_LOCK_NAME],
    );
    expect(end).toHaveBeenCalledTimes(1);
    expect(cleanup.mock.invocationCallOrder[0]).toBeLessThan(
      query.mock.invocationCallOrder[1],
    );
  });

  it("releases the MySQL lock and closes the connection when cleanup fails", async () => {
    const query = vi
      .fn()
      .mockResolvedValueOnce([[{ acquired: 1 }], {}])
      .mockResolvedValueOnce([[{ released: 1 }], {}]);
    const end = vi.fn().mockResolvedValue(undefined);
    const cleanupError = new Error("cleanup transaction failed");
    const cleanup = vi.fn().mockRejectedValue(cleanupError);

    await expect(
      runDeliveryTicketRetentionCleanup({
        databaseUrl: "mysql://retention.test/database",
        createConnection: async () => ({ query, end }) as any,
        cleanup,
      }),
    ).rejects.toBe(cleanupError);

    expect(query).toHaveBeenNthCalledWith(
      2,
      "SELECT RELEASE_LOCK(?) AS released",
      [DELIVERY_TICKET_RETENTION_LOCK_NAME],
    );
    expect(end).toHaveBeenCalledTimes(1);
  });

  it("prevents overlapping scheduler runs", async () => {
    vi.useFakeTimers();
    let finishFirstRun!: (value: { acquired: false; result: null }) => void;
    const firstRun = new Promise<{ acquired: false; result: null }>(
      (resolve) => {
        finishFirstRun = resolve;
      },
    );
    const run = vi
      .fn()
      .mockImplementationOnce(() => firstRun)
      .mockResolvedValue({ acquired: false, result: null });
    const stop = startDeliveryTicketRetentionScheduler({
      initialDelayMs: 10,
      intervalMs: 10,
      run,
    });

    await vi.advanceTimersByTimeAsync(10);
    expect(run).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(30);
    expect(run).toHaveBeenCalledTimes(1);

    finishFirstRun({ acquired: false, result: null });
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(10);
    expect(run).toHaveBeenCalledTimes(2);

    stop();
  });
});
